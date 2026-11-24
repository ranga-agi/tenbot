/**
 * Match Scores, Freeform Score Parsing & Leaderboard Commands
 */

const stats = require('../../stats');
const ratings = require('../../ratings');
const namesStore = require('../../names');
const { parseScoreReports } = require('../../scoreReport');
const { findMatchupFor } = require('../../matchups');
const { isUserAdmin, extractGroupFlag } = require('../groupCommands');
const groupsConfig = require('../../groupsConfig');
const { nameFor, knownPlayers } = require('./profile');
const { sendMessageAndRecord } = require('../../botMessage');

const SELF_WORDS = new Set(['i', 'me', 'myself', 'we', 'us', 'my team', 'our team']);

const recentFreeformScores = new Map();
const FREEFORM_DUPLICATE_WINDOW_MS = 10 * 60 * 1000;

const SCORE_TAIL_PATTERN = '((?:[0-9]{1,2}\\s*[-–—:]\\s*[0-9]{1,2}(?:\\s*[\\(\\[]\\s*\\d{1,2}\\s*[\\)\\]])?[\\s,]*)+)$';
const WINNER_FIRST_MATCH_REGEX = new RegExp(`^(.+?)\\s+(?:def|beat|beats|defeated|defeats|d\\.)\\s+(.+?)\\s+${SCORE_TAIL_PATTERN}`, 'i');
const NEUTRAL_MATCH_REGEX = new RegExp(`^(.+?)\\s+(?:vs\\.?|versus|v\\.)\\s+(.+?)\\s+${SCORE_TAIL_PATTERN}`, 'i');
const SECTION_HEADER_REGEX = /^(?:set|round|rotation)\s*(?:#|no\.?)?\s*(?:\d+|first|second|third|fourth|fifth|one|two|three|four|five)\s*[:\-–—]*$/i;

function parseSide(side) {
  return side
    .split(/\s*(?:&|\+|\band\b)\s*/i)
    .map((name) => name.trim())
    .filter(Boolean);
}

const formatSide = (names) => names.join(' & ');
const formatSets = (sets) => sets.map(([a, b]) => `${a}-${b}`).join(' ');

function resolveCanonicalPlayers(names, chatId) {
  return names.map((n) => {
    const match = namesStore.findIdByNameOrAlias(n, chatId);
    return (match && match.entry?.name) ? match.entry.name : n;
  });
}

function parseScoreSets(score) {
  return score
    .trim()
    .split(/[\s,]+/)
    .filter(Boolean)
    .map((set) => set.replace(/\s*[\(\[]\s*\d{1,2}\s*[\)\]]$/, '').split(/\s*[-–—:]\s*/).map(Number))
    .filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b));
}

function stripScoreLinePrefix(line) {
  return String(line || '')
    .trim()
    .replace(/^(?:[-•*]|\d+[.)])\s+/, '')
    .replace(/^(?:(?:court|ct|match)\s*\d+|c\d+|m\d+)\s*[:\-–—]\s*/i, '')
    .trim();
}

function splitScoreCommandEntries(rawBody) {
  const segments = String(rawBody || '')
    .split(/\r?\n|;/)
    .map((line) => stripScoreLinePrefix(line))
    .filter(Boolean);

  if (segments.length > 1) {
    const nonHeaders = segments.filter((seg) => !SECTION_HEADER_REGEX.test(seg));
    if (nonHeaders.length > 0) return nonHeaders;
  }

  return segments;
}

/**
 * Parses "<winner> def <loser> <score>" or "<side1> vs <side2> <score>".
 * For neutral separators ("vs", "vs.", "versus", "v."), the match is recorded
 * directly as "vs" with sides and set scores in the order provided (points and
 * ratings are calculated per individual set, so 2-set splits like 6-4 4-6 work).
 * Matches entered with "def"/"beat" are also recorded as "vs".
 *
 * Returns null if `text` does not match either pattern,
 * `{ error }` if matched but invalid (uneven teams),
 * or `{ winners, losers, sets, format }` on success.
 */
function parseMatchResultExpression(text, chatId = null) {
  const match = text.match(WINNER_FIRST_MATCH_REGEX) || text.match(NEUTRAL_MATCH_REGEX);
  if (!match) return null;

  const [, rawSideA, rawSideB, rawScore] = match;
  const sideA = parseSide(rawSideA);
  const sideB = parseSide(rawSideB);
  const sets = parseScoreSets(rawScore);

  if (sideA.length !== sideB.length) {
    return { error: `Both sides need the same number of players -- got ${sideA.length} vs ${sideB.length}.` };
  }

  const winners = resolveCanonicalPlayers(sideA, chatId);
  const losers = resolveCanonicalPlayers(sideB, chatId);

  return { winners, losers, sets, format: 'vs' };
}

function formatLeaderboard(chatId = null, options = {}) {
  const board = stats.getLeaderboard(chatId, options);
  const now = options.now || new Date();
  const sj = stats.getSanJoseParts ? stats.getSanJoseParts(now) : null;
  const monthNames = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const curMonthIdx = Number.isInteger(options.month) ? options.month : (sj ? sj.month : now.getMonth());
  const curYear = Number.isInteger(options.year) ? options.year : (sj ? sj.year : now.getFullYear());
  const monthLabel = options.allTime ? 'All-Time (Last 2 Weeks)' : `${monthNames[curMonthIdx]} ${curYear}`;

  if (board.length === 0) {
    return `No matches recorded for ${monthLabel} yet. Use "!score <winner> def <loser> <score>" or "!score <side1> vs <side2> <score>" to log one.`;
  }

  let displayBoard = board;
  if (chatId && chatId.endsWith('@g.us')) {
    const groupMembers = namesStore.getGroupMembers(chatId);
    if (groupMembers && groupMembers.size > 0) {
      const filtered = board.filter((p) => {
        const match = namesStore.findIdByNameOrAlias(p.name, chatId);
        const idNorm = (match?.id || '').toLowerCase();
        const numOnly = idNorm.split('@')[0];
        const pnNorm = (match?.entry?.pn || '').toLowerCase();
        const pnNum = pnNorm.split('@')[0];
        const nameKey = ratings.keyFor(p.name);
        return (
          groupMembers.has(idNorm) ||
          (numOnly && groupMembers.has(numOnly)) ||
          (pnNorm && groupMembers.has(pnNorm)) ||
          (pnNum && groupMembers.has(pnNum)) ||
          groupMembers.has(nameKey)
        );
      });
      if (filtered.length > 0) {
        displayBoard = filtered;
      }
    }
  }

  const lines = displayBoard.map((p, i) => {
    const scoreStr = typeof p.score === 'number' ? p.score.toFixed(2) : String(p.points);
    return `${i + 1}. ${p.name} — ${scoreStr} avg (${p.points} pts, ${p.gamesWon}-${p.gamesLost} games, ${p.wins}W ${p.losses}L sets)`;
  });
  return `🏆 *Leaderboard (${monthLabel}):*\n${lines.join('\n')}\n\n_Scoring: smoothed pts/set (Win: 10+margin, Loss: 6-margin; +16 pts / +4 sets baseline) • Tiebreaker: total pts, game diff_`;
}

/**
 * Before resetting the leaderboard at the start of a calendar month,
 * publishes the previous month's final leaderboard via DM to recipients
 * configured in the group's `notifications` list (once per group per month).
 */
async function publishMonthlyLeaderboards(sock, options = {}) {
  if (!sock) return [];
  const now = options.now || new Date();
  const nowMs = now instanceof Date ? now.getTime() : new Date(now).getTime();
  const { year: prevYear, month: prevMonth, monthKey: prevMonthKey, currentYear, currentMonth } = stats.getPreviousMonthInfo(now);

  const cfg = groupsConfig.loadRawConfig();
  const configuredGroups = Object.keys(cfg?.groups || {}).filter((jid) => jid && jid.endsWith('@g.us'));
  const results = [];

  const monthNames = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const prevMonthLabel = `${monthNames[prevMonth]} ${prevYear}`;
  const curMonthLabel = `${monthNames[currentMonth]} ${currentYear}`;

  for (const chatId of configuredGroups) {
    try {
      const recipients = groupsConfig.getNotifications(chatId);
      if (!recipients || recipients.length === 0) continue;

      const lastPublished = stats.getLastPublishedLeaderboardMonth(chatId);
      if (lastPublished === prevMonthKey) continue;

      if (!options.ignoreQuietHours && groupsConfig.isInQuietHours(nowMs, chatId)) {
        continue;
      }

      const board = stats.getLeaderboard(chatId, { year: prevYear, month: prevMonth, skipPrune: true });
      if (!board || board.length === 0) {
        continue;
      }

      const groupCfg = groupsConfig.getGroupConfig(chatId);
      const groupName = groupCfg?.name || chatId;
      const leaderboardText = formatLeaderboard(chatId, { year: prevYear, month: prevMonth, skipPrune: true, now });
      const message =
        `📅 *Monthly Leaderboard Final Standings — ${groupName}*\n` +
        `Standings are resetting for *${curMonthLabel}*. Here is the final leaderboard for *${prevMonthLabel}*:\n\n` +
        leaderboardText;

      let sentCount = 0;
      for (const recipient of recipients) {
        if (!recipient || recipient.toLowerCase() === chatId.toLowerCase()) continue;
        try {
          await sendMessageAndRecord(sock, recipient, { text: message });
          sentCount++;
          console.log(`[leaderboard] Published ${prevMonthLabel} leaderboard for ${groupName} (${chatId}) to ${recipient}`);
        } catch (err) {
          console.error(`[leaderboard] Failed to send monthly leaderboard for ${chatId} to ${recipient}:`, err.message);
        }
      }

      if (sentCount > 0) {
        stats.markLeaderboardMonthPublished(chatId, prevMonthKey);
        results.push({ chatId, groupName, monthKey: prevMonthKey, sentCount });
      }
    } catch (err) {
      console.error(`[leaderboard] Error publishing monthly leaderboard for ${chatId}:`, err.message);
    }
  }

  return results;
}

function handleListScores(chatId, queryText = null) {
  const parsed = stats.parseDateQuery(queryText);
  const filter = { chatId: chatId?.endsWith('@g.us') ? chatId : null };

  if (parsed.type === 'day' || parsed.type === 'range') {
    filter.startDate = parsed.startDate;
    filter.endDate = parsed.endDate;
  } else if (parsed.type === 'player') {
    filter.player = parsed.player;
  }

  const matches = stats.getScores(filter, { limit: parsed.limit || (parsed.type === 'recent' ? 6 : 50) });
  return stats.formatScoresList(matches, parsed.label);
}

async function canUserManageScore(sock, chatId, senderJid, sender, match) {
  if (!match) return false;
  if (groupsConfig.isSuperAdmin(senderJid)) return true;
  const admin = await isUserAdmin(sock, chatId, senderJid);
  if (admin) return true;

  const senderCanonical = nameFor(senderJid);
  const senderKey = ratings.keyFor(sender);
  const canonicalKey = senderCanonical ? ratings.keyFor(senderCanonical) : null;

  const matchPlayers = [
    ...(Array.isArray(match.winners) ? match.winners : stats.splitPlayers(match.winner)),
    ...(Array.isArray(match.losers) ? match.losers : stats.splitPlayers(match.loser))
  ].map((p) => ratings.keyFor(p));

  return matchPlayers.includes(senderKey) || (canonicalKey && matchPlayers.includes(canonicalKey));
}

async function handleDeleteScore(sock, chatId, senderJid, sender, rawTarget) {
  if (!rawTarget) {
    return 'Please specify the match score to delete by number or ID, e.g. "!deletescore #1" or "!deletescore m_...". Run "!scores" to view recent scores.';
  }

  const match = stats.findMatchByIdOrIndex(rawTarget);
  if (!match) {
    return `Match score "${rawTarget}" not found. Run "!scores" to see available match scores.`;
  }

  const canManage = await canUserManageScore(sock, chatId, senderJid, sender, match);
  if (!canManage) {
    return '⚠️ Only group admins or players involved in the match can delete this score.';
  }

  const deleted = stats.deleteMatch(match.id);
  if (!deleted) {
    return `Could not delete match score "${rawTarget}".`;
  }

  return `🗑️ *Deleted match score:*\n` +
    `• *Match:* ${deleted.winner} vs ${deleted.loser} (${deleted.score})\n` +
    `• *Date:* ${stats.formatMatchDate(deleted.date)}\n` +
    `• Player ratings and monthly leaderboard have been restored.`;
}

async function handleEditScore(sock, chatId, senderJid, sender, rawArgs) {
  if (!rawArgs) {
    return 'Usage: "!editscore <#|ID> <new score>", "!editscore <#|ID> <winner> def <loser> <new score>", or "!editscore <#|ID> <side1> vs <side2> <new score>"\ne.g. "!editscore #1 6-3 6-4" or "!editscore #1 Mike vs John 6-3 6-4"';
  }

  const firstSpaceIdx = rawArgs.search(/\s+/);
  if (firstSpaceIdx === -1) {
    return 'Please provide the new score or updated match result, e.g. "!editscore #1 6-3 6-4".';
  }

  const targetId = rawArgs.slice(0, firstSpaceIdx).trim();
  const restText = rawArgs.slice(firstSpaceIdx).trim();

  const match = stats.findMatchByIdOrIndex(targetId);
  if (!match) {
    return `Match score "${targetId}" not found. Run "!scores" to see available match scores.`;
  }

  const canManage = await canUserManageScore(sock, chatId, senderJid, sender, match);
  if (!canManage) {
    return '⚠️ Only group admins or players involved in the match can edit this score.';
  }

  // Case 1: Full phrase with def/beat/vs: e.g. "Mike & Sara def John & Alex 6-4 6-2" or "Mike vs John 4-6 2-6"
  const fullMatch = parseMatchResultExpression(restText, chatId);
  if (fullMatch) {
    if (fullMatch.error) return fullMatch.error;

    const { winners, losers, sets } = fullMatch;
    const oldWinner = match.winner;
    const oldLoser = match.loser;
    const oldScore = match.score;

    const winnerText = formatSide(winners);
    const loserText = formatSide(losers);
    const scoreText = formatSets(sets);

    stats.updateMatch(match.id, {
      winner: winnerText,
      loser: loserText,
      winners,
      losers,
      score: scoreText,
      sets,
      format: 'vs'
    });

    return `✏️ *Updated match score:*\n` +
      `• *Was:* ${oldWinner} vs ${oldLoser} (${oldScore})\n` +
      `• *Now:* ${winnerText} vs ${loserText} (${scoreText})\n` +
      `• Player ratings and monthly leaderboard have been recalculated.`;
  }

  // Case 2: Just new score, e.g. "6-3 6-4" or "6-4, 5-7, 10-8"
  const isScoreOnly = /^((?:[0-9]{1,2}\s*[-–—:]\s*[0-9]{1,2}(?:\s*[\(\[]\s*\d{1,2}\s*[\)\]])?[\s,]*)+)$/.test(restText);
  if (isScoreOnly) {
    const sets = parseScoreSets(restText);
    const scoreText = formatSets(sets);
    const oldScore = match.score;

    stats.updateMatch(match.id, {
      score: scoreText,
      sets,
      format: 'vs'
    });

    return `✏️ *Updated match score:*\n` +
      `• *Match:* ${match.winner} vs ${match.loser}\n` +
      `• *Was:* ${oldScore}\n` +
      `• *Now:* ${scoreText}\n` +
      `• Player ratings and monthly leaderboard have been recalculated.`;
  }

  return 'Could not parse new score. Use: "!editscore <#|ID> <score>" (e.g. "!editscore #1 6-3 6-4"), "!editscore <#|ID> <winner> def <loser> <score>", or "!editscore <#|ID> <side1> vs <side2> <score>".';
}

function applyScoreReport({ winners, losers, sets, format = 'vs', assumedScore = false, inferredOpponents = false, chatId = null, date = null }) {
  const winnerText = formatSide(winners);
  const loserText = formatSide(losers);
  const scoreText = formatSets(sets);

  const { sets: rated, changes } = ratings.applyResult(winners, losers, sets);
  const storedChanges = changes.map((c) => ({
    name: c.name,
    delta: typeof c.delta === 'number' ? c.delta : Number((c.to - c.from).toFixed(2))
  }));
  const recordOpts = { winners, losers, sets, format: 'vs', ratingChanges: storedChanges, chatId };
  if (date) recordOpts.date = date;
  stats.recordMatch(winnerText, loserText, scoreText, recordOpts);

  const lines = [`Recorded: ${winnerText} vs ${loserText} (${scoreText}).`];

  const notes = [];
  if (assumedScore) notes.push(`no score given, so I assumed ${scoreText}`);
  if (inferredOpponents) notes.push("opponents from today's draw");
  if (notes.length > 0) lines.push(`(${notes.join('; ')})`);

  const upsets = rated.filter((s) => s.upset).length;
  if (upsets > 0) {
    lines.push(`${upsets === rated.length ? 'Upset' : `${upsets} upset set(s)`} -- the lower-rated pairing came through.`);
  }

  lines.push(...changes.map((c) => {
    const move = c.to === c.from ? 'no change' : `${c.to > c.from ? '▲' : '▼'} ${ratings.formatRating(Math.abs(c.to - c.from))}`;
    return `  ${c.name}: ${ratings.formatRating(c.from)} → ${ratings.formatRating(c.to)} (${move})`;
  }));
  lines.push('Check "!leaderboard" for standings, "!ratings" for ratings.');

  return lines.join('\n');
}

function applyMultipleScoreReports(reports, { chatId = null } = {}) {
  if (!Array.isArray(reports) || reports.length === 0) return '';
  if (reports.length === 1) {
    return applyScoreReport({ ...reports[0], chatId });
  }

  const baseNow = Date.now();
  const recordedLines = [];
  const netChanges = new Map();
  let totalUpsets = 0;
  let totalRatedSets = 0;
  let hasAssumedScore = false;
  let hasInferredOpponents = false;

  for (let i = 0; i < reports.length; i++) {
    const report = reports[i];
    const winnerText = formatSide(report.winners);
    const loserText = formatSide(report.losers);
    const scoreText = formatSets(report.sets);

    if (report.assumedScore) hasAssumedScore = true;
    if (report.inferredOpponents) hasInferredOpponents = true;

    const { sets: rated, changes } = ratings.applyResult(report.winners, report.losers, report.sets);
    totalRatedSets += rated.length;
    totalUpsets += rated.filter((s) => s.upset).length;

    const storedChanges = changes.map((c) => ({
      name: c.name,
      delta: typeof c.delta === 'number' ? c.delta : Number((c.to - c.from).toFixed(2))
    }));

    for (const c of changes) {
      const existing = netChanges.get(c.name);
      if (existing) {
        existing.to = c.to;
      } else {
        netChanges.set(c.name, { name: c.name, from: c.from, to: c.to });
      }
    }

    const matches = stats.recordMatch(winnerText, loserText, scoreText, {
      winners: report.winners,
      losers: report.losers,
      sets: report.sets,
      format: 'vs',
      ratingChanges: storedChanges,
      chatId,
      date: new Date(baseNow + i).toISOString()
    });
    const entry = matches[matches.length - 1];
    const idStr = entry?.id ? ` \`${entry.id}\`` : '';
    recordedLines.push(`${i + 1}. ${winnerText} vs ${loserText} (${scoreText})${idStr}`);
  }

  const lines = [
    `Recorded ${reports.length} match scores:`,
    ...recordedLines
  ];

  const notes = [];
  if (hasAssumedScore) notes.push('missing score(s) assumed 6-3');
  if (hasInferredOpponents) notes.push("some opponents inferred from today's draw");
  if (notes.length > 0) lines.push(`(${notes.join('; ')})`);

  if (totalUpsets > 0) {
    lines.push(`${totalUpsets === totalRatedSets ? 'Upset' : `${totalUpsets} upset set(s)`} -- the lower-rated pairing came through.`);
  }

  lines.push('Rating updates:');
  for (const c of netChanges.values()) {
    const move = c.to === c.from ? 'no change' : `${c.to > c.from ? '▲' : '▼'} ${ratings.formatRating(Math.abs(c.to - c.from))}`;
    lines.push(`  ${c.name}: ${ratings.formatRating(c.from)} → ${ratings.formatRating(c.to)} (${move})`);
  }
  lines.push('Check "!leaderboard" for standings, "!ratings" for ratings.');

  return lines.join('\n');
}

function handleScoreCommand(text, chatId = null) {
  let cleanText = text;
  if (typeof extractGroupFlag === 'function') {
    const extracted = extractGroupFlag(text);
    cleanText = extracted.cleanText;
  }

  const bodyMatch = cleanText.match(/^!score\s+([\s\S]+)$/i);
  const entries = bodyMatch ? splitScoreCommandEntries(bodyMatch[1]) : [];
  if (entries.length === 0) {
    return 'Couldn\'t parse that. Use: !score <side1> vs <side2> <score> (or separate multiple matches with newlines or ";")\ne.g. "!score Mike vs John 6-4 4-6" or "!score Mike & Sara vs John & Alex 6-4 6-2"';
  }

  if (entries.length === 1) {
    const parsed = parseMatchResultExpression(entries[0], chatId);
    if (!parsed) {
      return 'Couldn\'t parse that. Use: !score <side1> vs <side2> <score> (or separate multiple matches with newlines or ";")\ne.g. "!score Mike vs John 6-4 4-6" or "!score Mike & Sara vs John & Alex 6-4 6-2"';
    }
    if (parsed.error) {
      return parsed.error;
    }
    return applyScoreReport({ ...parsed, chatId });
  }

  const parsedReports = [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const parsed = parseMatchResultExpression(entry, chatId);
    if (!parsed) {
      return `Couldn't parse entry #${i + 1} ("${entry}"). No scores were recorded.\nUse: <side1> vs <side2> <score> (e.g. "Mike & Sara vs John & Alex 6-4 4-6").`;
    }
    if (parsed.error) {
      return `Error on entry #${i + 1} ("${entry}"): ${parsed.error} No scores were recorded.`;
    }
    parsedReports.push(parsed);
  }

  return applyMultipleScoreReports(parsedReports, { chatId });
}

function isDuplicateFreeform(chatId, signature, now = Date.now()) {
  const seen = recentFreeformScores.get(chatId);
  if (!seen) return false;
  for (const [sig, at] of seen.entries()) {
    if (now - at >= FREEFORM_DUPLICATE_WINDOW_MS) seen.delete(sig);
  }
  const at = seen.get(signature);
  return typeof at === 'number' && (now - at) < FREEFORM_DUPLICATE_WINDOW_MS;
}

function markFreeformSeen(chatId, signature, now = Date.now()) {
  let seen = recentFreeformScores.get(chatId);
  if (!seen) {
    seen = new Map();
    recentFreeformScores.set(chatId, seen);
  }
  seen.set(signature, now);
}

function handleFreeformScore(candidates, chatId, sender, activePolls = new Map(), lastSchedule = null) {
  const roster = knownPlayers(chatId, activePolls);
  const self = roster.get(ratings.keyFor(sender)) || null;

  const options = {
    resolveName: (raw) => {
      const key = ratings.keyFor(raw);
      if (SELF_WORDS.has(key)) return self;
      return roster.get(key) || null;
    },
    findMatchup: (names, versus) => findMatchupFor(lastSchedule, names, versus)
  };

  let bestReports = [];
  for (const candidate of new Set(candidates.filter(Boolean))) {
    const parsed = parseScoreReports(candidate, options);
    if (parsed.length > bestReports.length) {
      bestReports = parsed;
    }
  }

  if (bestReports.length === 0) return null;

  const now = Date.now();
  const freshReports = [];
  for (const report of bestReports) {
    const signature = [
      formatSide(report.winners),
      formatSide(report.losers),
      formatSets(report.sets)
    ].join('|').toLowerCase();

    if (isDuplicateFreeform(chatId, signature, now)) {
      console.log(`[score] Ignoring repeat free-form result: ${signature}`);
      continue;
    }
    markFreeformSeen(chatId, signature, now);
    freshReports.push(report);

    console.log(
      `[score] Free-form result understood: ${formatSide(report.winners)} vs ` +
      `${formatSide(report.losers)} (${formatSets(report.sets)})` +
      `${report.assumedScore ? ' [assumed score]' : ''}${report.inferredOpponents ? ' [inferred opponents]' : ''}`
    );
  }

  if (freshReports.length === 0) return null;
  if (freshReports.length === 1) {
    return applyScoreReport({ ...freshReports[0], chatId });
  }
  return applyMultipleScoreReports(freshReports, { chatId });
}

module.exports = {
  formatLeaderboard,
  publishMonthlyLeaderboards,
  handleListScores,
  canUserManageScore,
  handleDeleteScore,
  handleEditScore,
  parseSide,
  splitScoreCommandEntries,
  parseMatchResultExpression,
  applyScoreReport,
  applyMultipleScoreReports,
  handleScoreCommand,
  handleFreeformScore
};
