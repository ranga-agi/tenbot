/**
 * Match Lineup Parsing & Attribution
 * Handles:
 *   - Deterministic and LLM-assisted lineup parsing
 *   - Attribution of published lineups to the best matching active poll
 *   - Recording manual lineups in pair history
 *   - Court cancellation detection via LLM
 */

const anthropic = require('../anthropic');
const namesStore = require('../names');
const ratings = require('../ratings');
const pollTime = require('../pollTime');
const pairHistory = require('../pairHistory');
const playerActivity = require('../playerActivity');
const groupsConfig = require('../groupsConfig');
const { getPollVoters, resolveManualPollPlayers, resolveFixedPollRoster, nameFor } = require('./pollCommands');
const { parseLineup } = require('../lineupParser');
const playerCommands = require('./playerCommands');

const GENERIC_NAMES = new Set(['someone', 'player', 'player 1', 'player 2', 'player 3', 'player 4', 'me', 'tenbot', '@tenbot', 'tbd', 'unknown']);
const GENERIC_WORDS = new Set(['someone', 'player', 'players', 'court', 'courts', 'team', 'teams', 'match', 'matches', 'test']);

const LINEUP_PARSER_TOOL = {
  name: 'parse_lineup',
  description: 'Records and parses the tennis match lineup, court assignments, teams, or rotations from the message. If the number of players listed in a match lineup is 1 less than a valid player configuration (e.g. 1 player for singles, 3 players for 1 doubles court, 7 players for 2 courts, 11 players for 3 courts, etc.), includes the message sender or poll creator as the missing player to complete the underfilled court.',
  input_schema: {
    type: 'object',
    properties: {
      isLineup: {
        type: 'boolean',
        description: 'True if the message is announcing or publishing tennis match lineups, player court assignments, teams, or rotations.'
      },
      type: {
        type: 'string',
        enum: ['singles', 'doubles'],
        description: 'Format of the match: "singles" or "doubles".'
      },
      time: {
        type: ['string', 'null'],
        description: 'Scheduled match time mentioned in the message (e.g. "7:00pm", "9am"), or null if unspecified.'
      },
      players: {
        type: 'array',
        items: { type: 'string' },
        description: 'List of all player names participating in the lineup.'
      },
      sets: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            set: { type: 'integer', description: 'Set number (e.g. 1, 2).' },
            courts: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  court: { type: 'integer', description: 'Court number (e.g. 1, 2, 6).' },
                  teamA: { type: 'array', items: { type: 'string' }, description: 'Players on Team A.' },
                  teamB: { type: 'array', items: { type: 'string' }, description: 'Players on Team B.' }
                },
                required: ['court', 'teamA', 'teamB']
              }
            }
          },
          required: ['set', 'courts']
        }
      }
    },
    required: ['isLineup']
  }
};

/**
 * Calculates standard Levenshtein edit distance between two strings.
 */
function levenshteinDistance(s1, s2) {
  const a = String(s1 || '').toLowerCase().trim();
  const b = String(s2 || '').toLowerCase().trim();
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;

  const row = [];
  for (let j = 0; j <= b.length; j++) row[j] = j;

  for (let i = 1; i <= a.length; i++) {
    let prev = i;
    for (let j = 1; j <= b.length; j++) {
      let val;
      if (a[i - 1] === b[j - 1]) {
        val = row[j - 1];
      } else {
        val = Math.min(row[j - 1] + 1, prev + 1, row[j] + 1);
      }
      row[j - 1] = prev;
      prev = val;
    }
    row[b.length] = prev;
  }
  return row[b.length];
}

/**
 * Computes a similarity score (0.0 to 1.0) between a query name and a candidate.
 * Recognizes exact matches, word matches (first/last name), prefix matches, and typo edit distances.
 */
function computeNameMatchScore(query, candidate) {
  if (!query || !candidate) return 0;
  const q = String(query).toLowerCase().trim();
  if (!q || GENERIC_WORDS.has(q)) return 0;

  const variants = [];
  if (typeof candidate === 'string') {
    variants.push(candidate);
  } else {
    if (candidate.canonicalName) variants.push(candidate.canonicalName);
    if (candidate.name && candidate.name !== candidate.canonicalName) variants.push(candidate.name);
    if (candidate.fullName && candidate.fullName !== candidate.canonicalName) variants.push(candidate.fullName);
    if (Array.isArray(candidate.aliases)) {
      for (const a of candidate.aliases) {
        if (a) variants.push(a);
      }
    }
  }

  let bestScore = 0;

  for (const rawVariant of variants) {
    const v = String(rawVariant).toLowerCase().trim();
    if (!v) continue;

    // 1. Exact full string match
    if (q === v) return 1.0;

    const words = v.split(/\s+/).filter((w) => w && !GENERIC_WORDS.has(w));

    // 2. Exact word match (e.g. query "Terence" matches first name of "Terence Park")
    for (const w of words) {
      if (q === w) return 0.98;
    }

    // 3. Word prefix match (e.g. query "Som" matches "Somnath", or "Vik" matches "Vikram")
    for (const w of words) {
      if (w.startsWith(q) && q.length >= 3 && q.length < w.length) {
        const score = 0.92 + (0.05 * (q.length / w.length));
        if (score > bestScore) bestScore = score;
      }
    }

    // 4. Fuzzy edit distance against full variant (if query has multiple words)
    // or against each individual word (if query is a single word)
    const targets = q.includes(' ') ? [v, ...words] : words;

    for (const target of targets) {
      const maxLen = Math.max(q.length, target.length);
      const dist = levenshteinDistance(q, target);

      if (dist === 0) return 1.0;

      if (dist === 1 && maxLen >= 4) {
        // e.g. "terrence" vs "terence" (maxLen 8, dist 1)
        const score = 0.88;
        if (score > bestScore) bestScore = score;
      } else if (dist === 2 && maxLen >= 6) {
        const sim = 1 - (dist / maxLen);
        if (sim >= 0.67) {
          const score = 0.70 + (0.10 * sim);
          if (score > bestScore) bestScore = score;
        }
      }
    }
  }

  return bestScore;
}

/**
 * Finds the closest candidate from a list of candidates.
 * Returns { candidate, score } if best score >= 0.75, else null.
 */
function findClosestCandidate(rawName, candidates) {
  if (!rawName || !Array.isArray(candidates) || candidates.length === 0) return null;
  let best = null;
  let bestScore = 0;

  for (const cand of candidates) {
    const score = computeNameMatchScore(rawName, cand);
    if (score > bestScore) {
      bestScore = score;
      best = cand;
    }
  }

  if (bestScore >= 0.75 && best) {
    return { candidate: best, score: bestScore };
  }
  return null;
}

/**
 * Checks if two player names refer to the same player.
 */
function isSamePlayerName(name1, name2) {
  if (!name1 || !name2) return false;
  if (ratings.isPlaceholder(name1) || ratings.isPlaceholder(name2)) return false;
  const k1 = ratings.keyFor(name1);
  const k2 = ratings.keyFor(name2);
  if (!k1 || !k2) return false;
  if (k1 === k2) return true;
  const m1 = namesStore.findIdByNameOrAlias(name1);
  const m2 = namesStore.findIdByNameOrAlias(name2);
  if (m1 && m2 && m1.id && m2.id && m1.id === m2.id) return true;
  if (k1.length >= 3 && k2.length >= 3) {
    if (k1.startsWith(k2 + ' ') || k2.startsWith(k1 + ' ')) return true;
  }
  // Check closest similarity
  const cand2 = {
    canonicalName: m2?.entry?.name || name2,
    name: m2?.entry?.name || name2,
    fullName: m2?.entry?.fullName || null,
    aliases: m2?.entry?.aliases || []
  };
  if (computeNameMatchScore(name1, cand2) >= 0.85) return true;
  const cand1 = {
    canonicalName: m1?.entry?.name || name1,
    name: m1?.entry?.name || name1,
    fullName: m1?.entry?.fullName || null,
    aliases: m1?.entry?.aliases || []
  };
  if (computeNameMatchScore(name2, cand1) >= 0.85) return true;
  return false;
}

function extractTimeFromLineupMessage(text, lineup = null) {
  if (lineup && lineup.time) {
    const parsed = pollTime.parseTimeString(lineup.time);
    if (parsed) return { hour: parsed.hour, minute: parsed.minute, display: parsed.display };
  }
  if (!text || typeof text !== 'string') return null;
  const m1 = text.match(/\b(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm)\b/i);
  if (m1) {
    const rawH = parseInt(m1[1], 10);
    const minute = m1[2] ? parseInt(m1[2], 10) : 0;
    const ampm = m1[3].toLowerCase();
    let hour = rawH % 12;
    if (ampm === 'pm') hour += 12;
    return { hour, minute, display: `${m1[1]}${m1[2] ? ':' + m1[2] : ''}${ampm}` };
  }
  const m2 = text.match(/\b([01]?\d|2[0-3])[:.](\d{2})\b/);
  if (m2) {
    let hour = parseInt(m2[1], 10);
    const minute = parseInt(m2[2], 10);
    if (hour >= 1 && hour <= 6) hour += 12;
    return { hour, minute, display: `${hour}:${String(minute).padStart(2, '0')}` };
  }
  return null;
}

function getPollMatchTime(pollState) {
  if (!pollState) return null;
  if (pollState.playAt) {
    const d = new Date(pollState.playAt);
    if (!Number.isNaN(d.getTime())) {
      const sj = pollTime.getSanJoseParts(d);
      return { hour: sj.hour, minute: sj.minute };
    }
  }
  if (pollState.when) {
    const m = pollState.when.match(/\b(\d{1,2}(?:[:.]\d{2})?\s*(?:am|pm))\b/i) || pollState.when.match(/\b(\d{1,2}[:.]\d{2})\b/);
    const pt = pollTime.parseTimeString(m ? m[1] : pollState.when);
    if (pt) return { hour: pt.hour, minute: pt.minute };
  }
  if (pollState.name) {
    const m = pollState.name.match(/\b(\d{1,2}(?:[:.]\d{2})?\s*(?:am|pm))\b/i) || pollState.name.match(/\b(\d{1,2}[:.]\d{2})\b/);
    const pt = pollTime.parseTimeString(m ? m[1] : pollState.name);
    if (pt) return { hour: pt.hour, minute: pt.minute };
  }
  return null;
}

function getPollPlayerNames(pollId, pollState, mePn, messageStore) {
  const { interestedPlayers, aggregated } = getPollVoters(pollId, pollState, mePn, messageStore);
  const players = [];
  const addPlayer = (name) => {
    if (!name || ratings.isPlaceholder(name)) return;
    if (!players.some((existing) => isSamePlayerName(existing, name))) {
      players.push(name);
    }
  };

  let rosterPlayers = [];
  let filledCount = 0;
  if (pollState.isManual) {
    const manualRoster = resolveManualPollPlayers(pollState, interestedPlayers);
    rosterPlayers = manualRoster.players || [];
    filledCount = interestedPlayers.length;
  } else {
    const roster = resolveFixedPollRoster(pollState, aggregated);
    rosterPlayers = roster.players || [];
    filledCount = roster.filledCount || 0;
  }

  if (Array.isArray(rosterPlayers)) {
    for (const p of rosterPlayers) addPlayer(p);
  }
  if (Array.isArray(interestedPlayers)) {
    for (const p of interestedPlayers) addPlayer(p);
  }
  if (Array.isArray(pollState.lastPlayers)) {
    for (const p of pollState.lastPlayers) addPlayer(p);
  }

  const cleanRosterCount = rosterPlayers.filter((p) => !ratings.isPlaceholder(p)).length;
  return {
    players,
    rosterCount: cleanRosterCount,
    filledCount,
    size: pollState.size || null
  };
}

function findBestMatchingPollForLineup({ activePolls, latestPollIdByChat, chatId, lineup, messageText, mePn, messageStore }) {
  let candidatePolls = [];
  for (const [pollId, pollState] of activePolls.entries()) {
    if (pollState.remoteJid === chatId && (pollState.status === 'active' || pollState.status === 'filled' || pollState.status === 'stopped' || pollState.status === 'resolved')) {
      candidatePolls.push({ pollId, pollState });
    }
  }

  if (candidatePolls.length === 0) {
    const latestId = latestPollIdByChat ? latestPollIdByChat.get(chatId) : null;
    const latestState = latestId ? activePolls.get(latestId) : null;
    if (latestState) {
      return { targetPollId: latestId, targetPollState: latestState, matchInfo: 'fallback_latest' };
    }
    return { targetPollId: null, targetPollState: null, matchInfo: 'none' };
  }

  const msgTime = extractTimeFromLineupMessage(messageText, lineup);
  const lineupPlayers = (lineup?.players || []).filter((p) => !ratings.isPlaceholder(p));

  const scored = candidatePolls.map(({ pollId, pollState }, index) => {
    const pollTimeObj = getPollMatchTime(pollState);
    const isExactTimeMatch = Boolean(
      msgTime && pollTimeObj &&
      msgTime.hour === pollTimeObj.hour &&
      msgTime.minute === pollTimeObj.minute
    );

    const pollPlayerInfo = getPollPlayerNames(pollId, pollState, mePn, messageStore);
    const pollPlayers = pollPlayerInfo.players;

    let matchCount = 0;
    const matchedPollIndices = new Set();
    const matchedNames = [];

    for (const lp of lineupPlayers) {
      for (let i = 0; i < pollPlayers.length; i++) {
        if (!matchedPollIndices.has(i) && isSamePlayerName(lp, pollPlayers[i])) {
          matchedPollIndices.add(i);
          matchedNames.push(pollPlayers[i]);
          matchCount++;
          break;
        }
      }
    }

    const isExactPlayerMatch = Boolean(
      lineupPlayers.length > 0 &&
      matchCount === lineupPlayers.length &&
      (
        pollPlayers.length === lineupPlayers.length ||
        (pollPlayerInfo.rosterCount > 0 && matchCount === pollPlayerInfo.rosterCount) ||
        (pollPlayerInfo.size && matchCount === pollPlayerInfo.size)
      )
    );

    const isExactBoth = Boolean(isExactPlayerMatch && isExactTimeMatch);

    const matchRatio = pollPlayers.length > 0
      ? matchCount / Math.max(lineupPlayers.length, pollPlayers.length)
      : 0;

    return {
      pollId,
      pollState,
      index,
      matchCount,
      matchedNames,
      matchRatio,
      pollPlayersCount: pollPlayers.length,
      isExactPlayerMatch,
      isExactTimeMatch,
      isExactBoth,
      statusWeight: pollState.status === 'filled' ? 3 : (pollState.status === 'active' ? 2 : (pollState.status === 'resolved' ? 1 : 0))
    };
  });

  const exactBothMatches = scored.filter((s) => s.isExactBoth);
  if (exactBothMatches.length > 0) {
    exactBothMatches.sort((a, b) => b.index - a.index);
    const best = exactBothMatches[0];
    return {
      targetPollId: best.pollId,
      targetPollState: best.pollState,
      matchInfo: `exact_players_and_time (${best.matchCount} players, time: ${msgTime?.display || ''})`
    };
  }

  const qualifyingMatches = scored.filter((s) => {
    const isTimeEligible = !msgTime || s.isExactTimeMatch;
    const isHalfLineupMatch = lineupPlayers.length > 0 && s.matchCount >= (lineupPlayers.length / 2);
    return Boolean(isTimeEligible && isHalfLineupMatch);
  });

  if (qualifyingMatches.length > 0) {
    qualifyingMatches.sort((a, b) => {
      if (b.isExactTimeMatch !== a.isExactTimeMatch) return (b.isExactTimeMatch ? 1 : 0) - (a.isExactTimeMatch ? 1 : 0);
      if (b.matchCount !== a.matchCount) return b.matchCount - a.matchCount;
      if (b.matchRatio !== a.matchRatio) return b.matchRatio - a.matchRatio;
      if (b.statusWeight !== a.statusWeight) return b.statusWeight - a.statusWeight;
      return b.index - a.index;
    });
    const best = qualifyingMatches[0];
    return {
      targetPollId: best.pollId,
      targetPollState: best.pollState,
      matchInfo: `qualifying_match (${best.matchCount}/${lineupPlayers.length} lineup players, time: ${msgTime ? (best.isExactTimeMatch ? 'exact' : 'mismatch') : 'unspecified'})`
    };
  }

  return {
    targetPollId: null,
    targetPollState: null,
    matchInfo: 'none'
  };
}

/**
 * Builds candidate pools for resolving names from manual lineups:
 * - Priority 1 (Voters): Those who voted in the target poll or active polls in this chat.
 * - Priority 2 (Group Members): Members in this WhatsApp group from namesStore.
 */
function buildCandidatePools({ targetPollId = null, targetPollState = null, activePolls = new Map(), chatId = null, mePn = null, messageStore = null } = {}) {
  const voterCandidates = [];
  const groupCandidates = [];
  const seenVoterKeys = new Set();
  const seenGroupKeys = new Set();

  const addVoter = (nameOrId) => {
    if (!nameOrId || ratings.isPlaceholder(nameOrId) || GENERIC_NAMES.has(String(nameOrId).toLowerCase().trim())) return;
    const clean = String(nameOrId).replace(/^@+/, '').trim();
    const key = clean.toLowerCase();
    if (!key || seenVoterKeys.has(key)) return;
    seenVoterKeys.add(key);

    const match = namesStore.findIdByNameOrAlias(clean, chatId);
    voterCandidates.push({
      canonicalName: clean,
      name: match?.entry?.name || clean,
      fullName: match?.entry?.fullName || null,
      aliases: match?.entry?.aliases || [],
      id: match?.id || null
    });
  };

  // 1. Voters from target poll (if matched)
  if (targetPollState) {
    const targetPollPlayers = getPollPlayerNames(targetPollId, targetPollState, mePn, messageStore).players;
    for (const p of targetPollPlayers) {
      addVoter(p);
    }
  }

  // 2. Voters from all other active polls in this chat
  if (activePolls) {
    for (const [id, state] of activePolls.entries()) {
      if (state.remoteJid === chatId && id !== targetPollId) {
        const otherPollPlayers = getPollPlayerNames(id, state, mePn, messageStore).players;
        for (const p of otherPollPlayers) {
          addVoter(p);
        }
      }
    }
  }

  // 3. Group members in chatId from namesStore
  const groupSet = chatId ? namesStore.getGroupMembers(chatId) : null;
  const hasGroupSet = Boolean(groupSet && groupSet.size > 0);
  const allEntries = namesStore.getAllEntries ? namesStore.getAllEntries() : [];

  for (const entry of allEntries) {
    const id = entry.id || entry.lid;
    if (hasGroupSet) {
      const isMember = namesStore.isMemberOfGroup(chatId, id) ||
        namesStore.isMemberOfGroup(chatId, entry.name) ||
        (entry.fullName && namesStore.isMemberOfGroup(chatId, entry.fullName));
      if (!isMember) continue;
    }
    const key = (entry.name || id || '').toLowerCase();
    if (!key || seenGroupKeys.has(key)) continue;
    seenGroupKeys.add(key);

    // Prefer fullName if defined, else display name
    const chosenCanonical = entry.fullName || entry.name;
    groupCandidates.push({
      canonicalName: chosenCanonical,
      name: entry.name,
      fullName: entry.fullName || null,
      aliases: entry.aliases || [],
      id
    });
  }

  // 4. Default booking players for this group if any
  if (chatId) {
    const defaultPlayers = groupsConfig.getDefaultBookingPlayers(chatId) || [];
    for (const dp of defaultPlayers) {
      const key = String(dp).toLowerCase().trim();
      if (!key || seenGroupKeys.has(key)) continue;
      seenGroupKeys.add(key);
      const match = namesStore.findIdByNameOrAlias(dp, chatId);
      const chosenCanonical = match?.entry?.fullName || match?.entry?.name || dp;
      groupCandidates.push({
        canonicalName: chosenCanonical,
        name: match?.entry?.name || dp,
        fullName: match?.entry?.fullName || null,
        aliases: match?.entry?.aliases || [],
        id: match?.id || null
      });
    }
  }

  return { voterCandidates, groupCandidates };
}

/**
 * Resolves a player name using the required candidate priority order:
 * 1. Closest match from those who voted.
 * 2. Closest match from members in the group.
 * 3. Fallback: rawName untouched (never discovers new players or adds to ratings).
 */
function resolvePlayerWithFallback(rawName, voterCandidates = [], groupCandidates = [], sender = null) {
  if (!rawName) return rawName;
  const rawStr = String(rawName).trim();
  if (!rawStr) return rawStr;

  // Don't match generic placeholders
  if (ratings.isPlaceholder(rawStr) || GENERIC_NAMES.has(rawStr.toLowerCase())) {
    return rawStr;
  }

  // Handle @mentions, digits, LIDs, PNs
  let clean = rawStr.replace(/^@+/, '').trim();
  if (/^\d+$/.test(clean) || clean.includes('@')) {
    const resolved = nameFor(clean);
    if (resolved && resolved !== 'Player') clean = resolved;
  }

  // If "me" or "i", resolve to sender if provided
  if (sender && (clean.toLowerCase() === 'me' || clean.toLowerCase() === 'i')) {
    const senderResolved = namesStore.resolveFullName(sender) || sender;
    if (senderResolved) return senderResolved;
  }

  // Priority 1: Check those who voted first
  const voterMatch = findClosestCandidate(clean, voterCandidates);
  if (voterMatch) {
    return voterMatch.candidate.canonicalName;
  }

  // Priority 2: Check members of the group next
  const groupMatch = findClosestCandidate(clean, groupCandidates);
  if (groupMatch) {
    return groupMatch.candidate.canonicalName;
  }

  // Priority 3: Leave as rawName without discovering or adding to ratings/names
  return clean;
}

async function parseLineupWithLLM(text, chatId, activePolls = new Map(), sender = null) {
  if (!anthropic.isAnthropicConfigured()) return null;
  console.log(`[lineup-llm] Invoking Claude to parse manual lineup in ${chatId}: "${text}"`);

  const playerEntries = namesStore.getAllEntries();
  const playerListDesc = playerEntries.map((e) => {
    const rawId = e.id ? e.id.split('@')[0] : '';
    const rawPn = e.pn ? e.pn.split('@')[0] : '';
    const aliasesStr = e.aliases && e.aliases.length > 0 ? `, aliases: [${e.aliases.join(', ')}]` : '';
    const ids = [rawId, rawPn].filter(Boolean).join(', ');
    return `- "${e.name}"${e.fullName ? ` (${e.fullName})` : ''} [IDs/Mentions: ${ids || 'none'}${aliasesStr}]`;
  }).join('\n');

  const activePollsDesc = [...activePolls.entries()]
    .filter(([, p]) => p.remoteJid === chatId && (p.status === 'active' || p.status === 'filled' || p.status === 'stopped' || p.status === 'resolved'))
    .map(([id, p]) => {
      const creatorStr = p.creator?.name ? `, creator: "${p.creator.name}" (Player 1)` : '';
      const lastPlayersStr = Array.isArray(p.lastPlayers) && p.lastPlayers.length > 0 ? `, previous players: [${p.lastPlayers.join(', ')}]` : '';
      return `- Poll "${p.name || p.when || id}" (size: ${p.size || 'opt-in'}, when: "${p.when || ''}", status: ${p.status}${creatorStr}${lastPlayersStr})`;
    })
    .join('\n');

  const senderStr = sender ? `Message posted by: "${sender}"\n` : '';
  const prompt = `You are an expert tennis assistant parsing a WhatsApp group chat message in San Jose, CA.
${senderStr}Message content:
"""
${text}
"""

Active tennis match polls in this chat:
${activePollsDesc || '(none)'}

Known registered players in this tennis group (with their WhatsApp mention IDs and aliases):
${playerListDesc}

Task:
Determine if this message is announcing or publishing match lineups, player court assignments, teams, or rotations (including initial or updated/changed matchups for an existing poll) (e.g. "@132388105547860 @278081952608440 @169384953794573 @78636841447513 - Court 6 7.00 pm", "Court 1: Alice & Bob vs Charlie & David", "Set 1: Court 2 Mike / Sara vs John / Alex", "Alice Bob vs Charlie Dave Court 3", etc.).

Rules:
1. Map any @<digits> or @<name> mentions to the correct player display name using the known registered players list. If a mention ID is not in the list, use the short name or phone number as the player name.
2. If 4 players are listed on a court without explicit "vs" (e.g. "@P1 @P2 @P3 @P4 - Court 6 7pm", "COURT 5 - Anupam - Som - Vik - VJ"), treat them as a doubles session on that court:
   - teamA: [Player 1, Player 2]
   - teamB: [Player 3, Player 4]
3. If 3 players are listed on a court without explicit "vs" (e.g. "COURT 5 - P1 - P2 - P3" or "P1 - P2 vs P3"), treat them as:
   - teamA: [Player 1, Player 2]
   - teamB: [Player 3]
4. If 2 players are listed on a court without "vs", treat them as singles: teamA: [Player 1], teamB: [Player 2].
5. If the number of players listed/mentioned for a match/poll is 1 less than a valid player configuration (e.g. 1 player instead of 2 for singles, 3 players instead of 4 for a 1-court doubles match, 7 players instead of 8 for a 2-court doubles match, 11 players instead of 12 for 3 courts, etc.) and the message sender or poll creator is not already mentioned, include the sender/creator as the additional player to complete the underfilled court (e.g. on a 3-player court: teamA: [Player 1, Player 2], teamB: [Player 3, Sender/Creator]). Group members frequently tag all other participating players without tagging themselves.
6. If this is just casual conversation, banter, a question, or a score report (e.g. "we won", "beat", "defeated", score like "6-4 6-2"), set "isLineup": false.

Respond ONLY with a JSON object in this exact format:
{
  "isLineup": boolean,
  "type": "singles" | "doubles",
  "time": string or null,
  "players": ["Player 1", "Player 2", ...],
  "sets": [
    {
      "set": 1,
      "courts": [
        {
          "court": 6,
          "teamA": ["Player 1", "Player 2"],
          "teamB": ["Player 3", "Player 4"]
        }
      ]
    }
  ]
}
If isLineup is false, return:
{
  "isLineup": false
}`;

  try {
    const parsed = await anthropic.callAnthropicJson({
      prompt,
      maxTokens: 600
    });

    if (!parsed || !parsed.isLineup || !Array.isArray(parsed.players) || parsed.players.length < 1 || !Array.isArray(parsed.sets) || parsed.sets.length === 0) {
      return null;
    }

    const resolvePlayer = (p) => {
      const clean = String(p).replace(/^@+/, '').trim();
      if (!clean) return clean;
      if (/^\d+$/.test(clean) || clean.includes('@')) {
        const resolved = nameFor(clean);
        if (resolved && resolved !== 'Player') return resolved;
      }
      const byName = namesStore.findIdByNameOrAlias(clean, chatId);
      if (byName && (byName.entry?.name || byName.name)) return byName.entry?.name || byName.name;
      return clean;
    };

    const resolvedPlayers = parsed.players.map(resolvePlayer);
    const resolvedSets = parsed.sets.map((s) => ({
      ...s,
      courts: (s.courts || []).map((c) => ({
        ...c,
        teamA: (c.teamA || []).map(resolvePlayer),
        teamB: (c.teamB || []).map(resolvePlayer)
      }))
    }));
    const allCourts = resolvedSets.flatMap((s) => s.courts || []);
    const isMultiPlayerTeam = allCourts.some((c) => (c.teamA?.length || 0) > 1 || (c.teamB?.length || 0) > 1);
    const resolvedType = isMultiPlayerTeam ? "doubles" : (parsed.type || (resolvedPlayers.length === 2 ? "singles" : "doubles"));

    console.log(`[lineup-llm] Decoded lineup (${resolvedType}${parsed.time ? ` at ${parsed.time}` : ""}): ${resolvedPlayers.length} player(s) [${resolvedPlayers.join(", ")}]`);
    return {
      type: resolvedType,
      time: parsed.time ? String(parsed.time).trim() : null,
      players: resolvedPlayers,
      sets: resolvedSets
    };
  } catch (err) {
    console.error('[lineup-llm] Failed to parse lineup with LLM:', err.message);
    return null;
  }
}

/**
 * Automatically reconciles missing player (e.g. poll creator or message sender)
 * whenever the number of players detected is off valid player configurations by 1.
 * Handles:
 * - Singles (1 player detected instead of 2)
 * - 1-court doubles (3 players detected instead of 4)
 * - Multi-court doubles (e.g. 7 players for 8 spots / 2 courts, 11 players for 12 spots / 3 courts, etc.)
 * - Any match matching an active poll where detected count is (expectedSpots - 1)
 */
function reconcileMissingPlayer(lineup, targetPollId, targetPollState, sender, mePn, messageStore) {
  if (!lineup || !Array.isArray(lineup.sets) || lineup.sets.length === 0 || !Array.isArray(lineup.players)) {
    return;
  }

  const detectedTotal = lineup.players.length;
  if (detectedTotal === 0) return;

  const pollSize = targetPollState?.size || (targetPollState?.courtBookingType === 'singles' ? 2 : null);
  const pollPlayerInfo = targetPollState ? getPollPlayerNames(targetPollId, targetPollState, mePn, messageStore) : null;
  const pollPlayers = pollPlayerInfo?.players || [];

  // Check if detected count is short by exactly 1:
  // a) Off poll size by 1 (e.g. 1 for singles size 2, 3 for doubles size 4, 7 for doubles size 8, etc.)
  const isOffPollSizeByOne = Boolean(pollSize && detectedTotal === pollSize - 1);

  // b) Off poll roster by 1 (e.g. 4 poll players and 3 detected)
  const isOffPollRosterByOne = Boolean(pollPlayers.length >= 2 && detectedTotal === pollPlayers.length - 1);

  // c) Off doubles configuration by 1: any multiple of 4 minus 1 (3, 7, 11, 15, ...)
  const isDoublesOffByOne = (detectedTotal % 4 === 3);

  // d) Off singles configuration by 1: 1 player detected when poll/lineup is singles
  const isSinglesOffByOne = (detectedTotal === 1) && Boolean(
    targetPollState?.courtBookingType === 'singles' ||
    pollSize === 2 ||
    lineup.type === 'singles' ||
    (lineup.sets.length === 1 && lineup.sets[0]?.courts?.length === 1 &&
      ((lineup.sets[0].courts[0]?.teamA?.length || 0) + (lineup.sets[0].courts[0]?.teamB?.length || 0) === 1))
  );

  const isOffValidConfigByOne = isOffPollSizeByOne || isOffPollRosterByOne || isDoublesOffByOne || isSinglesOffByOne;
  if (!isOffValidConfigByOne) {
    return;
  }

  // Identify the missing player
  let missingPlayer = null;
  const creatorName = targetPollState?.creator?.name || null;

  if (creatorName && !lineup.players.some((p) => isSamePlayerName(p, creatorName))) {
    missingPlayer = creatorName;
  }

  if (!missingPlayer && sender && !lineup.players.some((p) => isSamePlayerName(p, sender))) {
    const senderResolved = namesStore.resolveFullName(sender);
    if (senderResolved && !lineup.players.some((p) => isSamePlayerName(p, senderResolved))) {
      missingPlayer = senderResolved;
    }
  }

  if (!missingPlayer && pollPlayers.length > 0) {
    const missingFromPoll = pollPlayers.filter((pp) => !lineup.players.some((lp) => isSamePlayerName(lp, pp)));
    if (missingFromPoll.length === 1) {
      missingPlayer = missingFromPoll[0];
    }
  }

  if (!missingPlayer) {
    return;
  }

  // Insert missingPlayer into the underfilled court in each set
  let insertedAny = false;
  const expectedPerCourt = isSinglesOffByOne ? 2 : 4;

  for (const s of lineup.sets) {
    if (!Array.isArray(s.courts) || s.courts.length === 0) continue;

    let underfilledCourt = s.courts.find((c) => {
      const cnt = (c.teamA?.length || 0) + (c.teamB?.length || 0);
      return cnt === (expectedPerCourt - 1);
    });

    if (!underfilledCourt) {
      underfilledCourt = s.courts.find((c) => {
        const cnt = (c.teamA?.length || 0) + (c.teamB?.length || 0);
        return cnt < expectedPerCourt;
      });
    }

    if (underfilledCourt) {
      if ((underfilledCourt.teamA?.length || 0) <= (underfilledCourt.teamB?.length || 0)) {
        underfilledCourt.teamA.push(missingPlayer);
      } else {
        underfilledCourt.teamB.push(missingPlayer);
      }
      insertedAny = true;
    }
  }

  if (insertedAny) {
    if (!lineup.players.some((p) => isSamePlayerName(p, missingPlayer))) {
      lineup.players.push(missingPlayer);
    }

    const allCourts = lineup.sets.flatMap((s) => s.courts || []);
    const isMultiPlayerTeam = allCourts.some((c) => (c.teamA?.length || 0) > 1 || (c.teamB?.length || 0) > 1);
    lineup.type = isMultiPlayerTeam ? 'doubles' : (lineup.players.length === 2 ? 'singles' : 'doubles');

    console.log(`[lineup] Detected missing player (poll creator/sender: ${missingPlayer}). Completed lineup to ${lineup.players.length} players (${lineup.type}).`);
  }
}

async function handleManualLineup(sock, chatId, sender, lineup, msg, rawText = '', context) {
  const { activePolls, latestPollIdByChat, persistPolls, messageStore } = context || {};
  const messageText = rawText || msg?.message?.conversation || msg?.message?.extendedTextMessage?.text || '';
  const mePn = sock?.user?.id || sock?.authState?.creds?.me?.id || null;

  const matchResult = findBestMatchingPollForLineup({
    activePolls,
    latestPollIdByChat,
    chatId,
    lineup,
    messageText,
    mePn,
    messageStore
  });

  const targetPollId = matchResult?.targetPollId || null;
  const targetPollState = matchResult?.targetPollState || null;

  // Build candidate pools: (1) voters from target poll & other active polls, (2) group members
  const { voterCandidates, groupCandidates } = buildCandidatePools({
    targetPollId,
    targetPollState,
    activePolls,
    chatId,
    mePn,
    messageStore
  });

  // Resolve player names using priority: (1) voters, (2) group members, (3) fallback untouched.
  // Note: New players are NEVER discovered or added to ratings or names from manual lineups.
  const resolve = (p) => resolvePlayerWithFallback(p, voterCandidates, groupCandidates, sender);

  lineup.players = (lineup.players || []).map(resolve);
  if (Array.isArray(lineup.sets)) {
    for (const s of lineup.sets) {
      if (Array.isArray(s.courts)) {
        for (const c of s.courts) {
          if (Array.isArray(c.teamA)) c.teamA = c.teamA.map(resolve);
          if (Array.isArray(c.teamB)) c.teamB = c.teamB.map(resolve);
        }
      }
    }
  }

  // Reconcile missing player when number of players detected is off valid player configurations by 1
  reconcileMissingPlayer(lineup, targetPollId, targetPollState, sender, mePn, messageStore);

  // If reconcileMissingPlayer added a player, map players again to ensure consistent naming
  lineup.players = lineup.players.map(resolve);

  if (targetPollState) {
    targetPollState.status = 'resolved';
    targetPollState.lastPlayers = lineup.players;
    targetPollState.lastSchedule = lineup;
    targetPollState.manualLineupPosted = true;
    targetPollState.manualLineupText = messageText;
    pairHistory.recordDraw(targetPollId, lineup, Date.now(), chatId);
    const playAtMs = targetPollState?.playAt ? new Date(targetPollState.playAt).getTime() : Date.now();
    playerActivity.recordPlayed(lineup.players, playAtMs, chatId);
    // NOTE: ratings.ensureRated is deliberately omitted here!
    // Manual lineups must NOT discover new players or add entries to ratings.
    if (persistPolls) persistPolls();
    console.log(`[lineup] Attributed manual lineup to poll ${targetPollId} in ${chatId} [${matchResult.matchInfo}] (${lineup.players.length} players: ${lineup.players.join(', ')})`);
  } else {
    pairHistory.recordDraw(`manual_${Date.now()}`, lineup, Date.now(), chatId);
    playerActivity.recordPlayed(lineup.players, Date.now(), chatId);
    // NOTE: ratings.ensureRated is deliberately omitted here!
    // Manual lineups must NOT discover new players or add entries to ratings.
    console.log(`[lineup] Recorded standalone manual lineup in ${chatId} (${lineup.players.length} players: ${lineup.players.join(', ')})`);
  }

  if (msg?.key && sock) {
    try {
      await sock.sendMessage(chatId, {
        react: {
          text: '🤖',
          key: msg.key
        }
      });
      console.log(`[lineup] Added 🤖 reaction to lineup message in ${chatId}`);
    } catch (err) {
      console.error('[lineup] Failed to add 🤖 reaction:', err.message);
    }
  }

  return null;
}

/**
 * Executes the parse_lineup Claude tool.
 * Attributes and records manual match lineups/rotations.
 */
async function executeLineupTool(sock, name, input, sender, chatId, msg, context) {
  const { activePolls, latestPollIdByChat, messageStore } = context || {};
  const mePn = sock?.user?.id || sock?.authState?.creds?.me?.id || null;

  const rawText = input?.text || input?.message || input?.lineupText || '';
  let lineup = null;

  const resolvePlayer = (p) => {
    const clean = String(p).replace(/^@/, '').trim();
    if (!clean) return clean;
    if (/^\d+$/.test(clean) || clean.includes('@')) {
      const resolved = nameFor(clean);
      if (resolved && resolved !== 'Player') return resolved;
    }
    const byName = namesStore.findIdByNameOrAlias(clean, chatId);
    if (byName && (byName.entry?.name || byName.name)) return byName.entry?.name || byName.name;
    return clean;
  };

  if (input?.lineup && Array.isArray(input.lineup.players) && Array.isArray(input.lineup.sets) && input.lineup.players.length >= 1) {
    const resolvedSets = input.lineup.sets.map((s) => ({
      set: s.set || 1,
      courts: (s.courts || []).map((c) => ({
        court: c.court,
        teamA: (c.teamA || []).map(resolvePlayer),
        teamB: (c.teamB || []).map(resolvePlayer)
      }))
    }));
    const allCourts = resolvedSets.flatMap((s) => s.courts || []);
    const isMultiPlayerTeam = allCourts.some((c) => (c.teamA?.length || 0) > 1 || (c.teamB?.length || 0) > 1);
    const resolvedPlayers = input.lineup.players.map(resolvePlayer);
    const resolvedType = isMultiPlayerTeam ? "doubles" : (input.lineup.type || (resolvedPlayers.length === 2 ? "singles" : "doubles"));

    lineup = {
      type: resolvedType,
      time: input.lineup.time ? String(input.lineup.time).trim() : null,
      players: resolvedPlayers,
      sets: resolvedSets
    };
  }

  // 2. If no valid structured lineup provided, parse rawText
  if (!lineup && rawText) {
    const roster = playerCommands?.knownPlayers ? playerCommands.knownPlayers(chatId, activePolls) : [];
    lineup = parseLineup(rawText, roster);

    if (!lineup && anthropic.isAnthropicConfigured()) {
      lineup = await parseLineupWithLLM(rawText, chatId, activePolls, sender);
    }
  }

  if (!lineup || !Array.isArray(lineup.players) || lineup.players.length < 1) {
    return 'Could not parse a valid match lineup from the provided text. Please ensure player names and court assignments (e.g. "Court 1: Player A & Player B vs Player C & Player D") are included.';
  }

  // 3. Find matching poll
  let targetPollId = input?.pollId || null;
  let targetPollState = (targetPollId && activePolls) ? activePolls.get(targetPollId) : null;

  if (!targetPollState && input?.pollName && activePolls) {
    const kw = input.pollName.toLowerCase().trim();
    for (const [id, state] of activePolls.entries()) {
      if (state.remoteJid === chatId) {
        const nameMatch = state.name && state.name.toLowerCase().includes(kw);
        const whenMatch = state.when && state.when.toLowerCase().includes(kw);
        if (nameMatch || whenMatch) {
          targetPollId = id;
          targetPollState = state;
          break;
        }
      }
    }
  }

  if (!targetPollState && activePolls) {
    const matchResult = findBestMatchingPollForLineup({
      activePolls,
      latestPollIdByChat,
      chatId,
      lineup,
      messageText: rawText,
      mePn,
      messageStore
    });
    targetPollId = matchResult?.targetPollId || null;
    targetPollState = matchResult?.targetPollState || null;
  }

  // 4. Record and handle lineup
  await handleManualLineup(sock, chatId, sender, lineup, msg, rawText, context);

  const pollDesc = targetPollState ? ` for poll "${targetPollState.name || targetPollState.when || targetPollId}"` : '';
  const totalCourts = (lineup.sets || []).reduce((sum, s) => sum + (s.courts?.length || 0), 0);
  return `Successfully parsed and recorded lineup${pollDesc}: ${lineup.players.length} players (${lineup.players.join(', ')}) across ${totalCourts || 1} court(s). Pair history and player activity updated.`;
}

async function checkCourtCancellationWithLLM(text, sender, chatId, activePolls = new Map()) {
  if (!anthropic.isAnthropicConfigured()) return null;

  const chatPolls = [...activePolls.entries()].filter(([, state]) =>
    state.remoteJid === chatId && state.status === 'active'
  );
  if (chatPolls.length === 0) return null;

  const prompt = `You are an intelligent assistant for a tennis group chat in San Jose, CA.
A group member sent this message in the chat:
Sender: "${sender}"
Message: "${text}"

Active Match Polls in this chat:
${chatPolls.map(([id, p]) => `- Poll ID: "${id}", Title: "${p.name || p.when}", Scheduled: "${p.when || p.playAt}", Status: "${p.status}", Spots: ${p.size || 'Opt-in'}`).join('\n')}

Task:
Analyze if the sender is announcing or stating that a tennis court (or court session/reservation) is being cancelled or released (e.g. "Cancelled the court", "Cancelling 2nd court due to lack of players", "Cancelled the 8:30am court since we only have 2", "I am cancelling the court because we don't have 4", "Releasing court because poll didn't fill", etc.).
Note: If they are simply asking a question, talking about general court availability, cancelling their own individual participation (e.g. "I have to cancel today"), or chatting about unrelated topics, set isCourtCancelledDueToLackOfVotes to false.

Respond ONLY with a JSON object in this exact format:
{
  "isCourtCancelled": boolean,
  "pollId": string or null,
  "reason": string
}`;

  try {
    return await anthropic.callAnthropicJson({
      prompt,
      maxTokens: 250
    });
  } catch (err) {
    console.error('[court-cancel-llm] Failed to check court cancellation with LLM:', err.message);
    return null;
  }
}

module.exports = {
  isSamePlayerName,
  levenshteinDistance,
  computeNameMatchScore,
  findClosestCandidate,
  buildCandidatePools,
  resolvePlayerWithFallback,
  extractTimeFromLineupMessage,
  getPollMatchTime,
  getPollPlayerNames,
  findBestMatchingPollForLineup,
  reconcileMissingPlayer,
  parseLineupWithLLM,
  handleManualLineup,
  checkCourtCancellationWithLLM,
  executeLineupTool,
  LINEUP_PARSER_TOOL
};
