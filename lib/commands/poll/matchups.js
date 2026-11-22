/**
 * Draw & Matchup Generation From Polls
 */

const { jidNormalizedUser } = require('@whiskeysockets/baileys');

const ratings = require('../../ratings');
const { sendMessageAndRecord } = require('../../botMessage');
const pollTime = require('../../pollTime');
const pairHistory = require('../../pairHistory');
const playerActivity = require('../../playerActivity');
const {
  generateMatchups,
  formatMatchups,
  summarizeSchedule
} = require('../../matchups');
const { getTargetGroupJid } = require('../groupCommands');

const { parseTimeString } = pollTime;

const {
  TRIGGER_PREFIX,
  resolveManualPollPlayers,
  resolveFixedPollRoster,
  resolveMultiTimePollRoster,
  getPollVoters,
  formatMatchHeaderTime,
  getPollPlayTime
} = require('./roster');
const { getPrebookedCourtsForPoll } = require('./courts');

function extractFixedPairsFromText(text) {
  if (!text) return [];
  const pairs = [];
  const patterns = [
    /\b(?:keeping|keep|put|with)\s+([a-z0-9\s._'-]+?)\s+(?:and|&)\s+([a-z0-9\s._'-]+?)\s+(?:in|on)\s+(?:the\s+)?(?:same\s+)?team\b/i,
    /\b(?:keeping|keep|put|with)\s+([a-z0-9\s._'-]+?)\s+(?:and|&)\s+([a-z0-9\s._'-]+?)\s+together\b/i,
    /\b([a-z0-9\s._'-]+?)\s+(?:and|&)\s+([a-z0-9\s._'-]+?)\s+(?:in|on)\s+(?:the\s+)?(?:same\s+)?team\b/i,
    /\b([a-z0-9\s._'-]+?)\s+(?:and|&)\s+([a-z0-9\s._'-]+?)\s+as\s+partners\b/i,
    /\b(?:partner|pair)\s+([a-z0-9\s._'-]+?)\s+(?:and|&|with)\s+([a-z0-9\s._'-]+?)\b/i
  ];

  for (const pat of patterns) {
    const match = text.match(pat);
    if (match) {
      const p1 = match[1].trim();
      const p2 = match[2].trim();
      if (p1 && p2 && p1.toLowerCase() !== p2.toLowerCase()) {
        pairs.push([p1, p2]);
        break;
      }
    }
  }
  return pairs;
}

async function generateMatchupsFromPoll(sock, chatId, specificPollId = null, specificPollName = null, options = {}, context) {
  const { activePolls, latestPollIdByChat, persistPolls, messageStore } = context;
  const lookupChatId = (chatId && chatId.endsWith('@g.us')) ? chatId : (await getTargetGroupJid(sock) || chatId);
  let targetPollId = null;
  let targetPollState = null;

  if (specificPollId && activePolls.has(specificPollId)) {
    const poll = activePolls.get(specificPollId);
    if (poll.remoteJid === lookupChatId && poll.status !== 'cancelled') {
      targetPollId = specificPollId;
      targetPollState = poll;
    }
  }

  const hasVotersOrPlayers = (p) => {
    if (Array.isArray(p.lastPlayers) && p.lastPlayers.length > 0) return true;
    if (p.voteBuffer && p.voteBuffer instanceof Map && p.voteBuffer.size > 0) return true;
    if (Array.isArray(p.prebookedPlayers) && p.prebookedPlayers.length > 0) return true;
    if (p.type === 'multi_time' && Array.isArray(p.timeSlots) && p.timeSlots.some((s) => (s.preseededPlayers && s.preseededPlayers.length > 0) || (s.lastPlayers && s.lastPlayers.length > 0))) return true;
    return false;
  };

  const allChatPolls = [...activePolls.entries()]
    .filter(([, p]) => p.remoteJid === lookupChatId && p.status !== 'cancelled');

  if (!targetPollState && specificPollName) {
    const q = String(specificPollName).toLowerCase().trim();
    const matching = allChatPolls
      .filter(([, p]) => {
        const pName = (p.name || '').toLowerCase();
        const pTitle = (p.title || '').toLowerCase();
        const pWhen = (p.when || '').toLowerCase();
        return (pTitle && (pTitle.includes(q) || q.includes(pTitle))) || pName.includes(q) || pWhen.includes(q) || (pName && q.includes(pName));
      })
      .sort((a, b) => getPollPlayTime(b[1]) - getPollPlayTime(a[1]));

    if (matching.length > 0) {
      targetPollId = matching[0][0];
      targetPollState = matching[0][1];
    }
  }

  if (!targetPollState) {
    const activeOptInOrManual = allChatPolls
      .filter(([, p]) => (p.status === 'active' || p.status === 'filled') && (p.type === 'opt_in' || p.size === null || p.isManual) && hasVotersOrPlayers(p))
      .sort((a, b) => getPollPlayTime(a[1]) - getPollPlayTime(b[1]));

    if (activeOptInOrManual.length > 0) {
      targetPollId = activeOptInOrManual[0][0];
      targetPollState = activeOptInOrManual[0][1];
    }
  }

  if (!targetPollState) {
    const activeWithVotes = allChatPolls
      .filter(([, p]) => (p.status === 'active' || p.status === 'filled') && hasVotersOrPlayers(p))
      .sort((a, b) => getPollPlayTime(a[1]) - getPollPlayTime(b[1]));

    if (activeWithVotes.length > 0) {
      targetPollId = activeWithVotes[0][0];
      targetPollState = activeWithVotes[0][1];
    }
  }

  if (!targetPollState) {
    const resolvedOrPast = allChatPolls
      .filter(([, p]) => hasVotersOrPlayers(p))
      .sort((a, b) => getPollPlayTime(b[1]) - getPollPlayTime(a[1]));

    if (resolvedOrPast.length > 0) {
      targetPollId = resolvedOrPast[0][0];
      targetPollState = resolvedOrPast[0][1];
    }
  }

  if (!targetPollState) {
    const pollId = latestPollIdByChat.get(lookupChatId);
    targetPollState = pollId && activePolls.get(pollId);
    targetPollId = pollId;
  }

  if (!targetPollState) {
    return `No tennis match poll found to generate matchups from -- create one with "${TRIGGER_PREFIX} create a poll" first.`;
  }

  const mePn = jidNormalizedUser(sock?.user?.id || sock?.authState?.creds?.me?.id || '');

  if (targetPollState.type === "multi_time" && Array.isArray(targetPollState.timeSlots)) {
    const { aggregated } = getPollVoters(targetPollId, targetPollState, mePn, messageStore);
    const slotRosters = resolveMultiTimePollRoster(targetPollState, aggregated);

    // Check if user requested a specific time slot (via specificPollName)
    let targetSlots = slotRosters;
    if (specificPollName) {
      const q = String(specificPollName).toLowerCase().trim();
      const parsedT = parseTimeString(q);
      const matched = slotRosters.filter((sr) => {
        const l = (sr.slot.label || "").toLowerCase();
        const optL = (sr.slot.optionLabel || "").toLowerCase();
        const tw = (sr.slot.timeWord || "").toLowerCase();
        if (l.includes(q) || optL.includes(q) || tw === q) return true;
        if (parsedT && sr.slot.timeWord) {
          const sp = parseTimeString(sr.slot.timeWord);
          if (sp && sp.hour === parsedT.hour && sp.minute === parsedT.minute) return true;
        }
        return false;
      });
      if (matched.length > 0) {
        targetSlots = matched;
      }
    }

    const generatedMessages = [];
    const insufficientNotes = [];

    for (const sr of targetSlots) {
      let slotPlayers = sr.players;
      // For unlimited or partially filled slots where players > 4 and not a multiple of 4, round down to full courts of 4
      if (slotPlayers.length > 4 && slotPlayers.length % 4 !== 0) {
        slotPlayers = slotPlayers.slice(0, Math.floor(slotPlayers.length / 4) * 4);
      }

      if (slotPlayers.length === 2 || (slotPlayers.length >= 4 && slotPlayers.length % 4 === 0)) {
        sr.slot.status = "resolved";
        sr.slot.matchupsGenerated = true;
        sr.slot.lastPlayers = slotPlayers;

        await ratings.ensureRated(slotPlayers);
        const slotPrebooked = (options && Array.isArray(options.prebookedCourts) && options.prebookedCourts.length > 0)
          ? options.prebookedCourts
          : (sr.slot.prebookedCourts || []);
        const schedule = generateMatchups(slotPlayers, { ...options, prebookedCourts: slotPrebooked, chatId });
        const slotTimeStr = sr.slot.dayDisplay ? `${sr.slot.dayDisplay} ${sr.slot.timeDisplay}` : sr.slot.label;
        const slotHeader = `📅 ${targetPollState.title ? `${targetPollState.title} — ${slotTimeStr}` : slotTimeStr}\n\n`;
        const msgText = slotHeader + formatMatchups(schedule);
        await sendMessageAndRecord(sock, chatId, { text: msgText });
        pairHistory.recordDraw(`${targetPollId}:${sr.slot.label}`, schedule, Date.now(), chatId);
        const playAtMs = sr.slot.playAt ? new Date(sr.slot.playAt).getTime() : Date.now();
        playerActivity.recordPlayed(slotPlayers, playAtMs, targetPollState?.remoteJid || chatId);
        sr.slot.lastSchedule = summarizeSchedule(schedule);
        generatedMessages.push(sr.slot.label);
      } else if (sr.players.length > 0) {
        insufficientNotes.push(`• *${sr.slot.label}*: ${sr.players.length} player(s) (${sr.players.join(", ")}) — need 2 or a multiple of 4`);
      }
    }

    if (generatedMessages.length > 0) {
      if (targetPollState.timeSlots.every((s) => s.status === "resolved")) {
        targetPollState.status = "resolved";
      }
      persistPolls();
      return null;
    }

    if (insufficientNotes.length > 0) {
      return `Cannot generate matchups yet:\n${insufficientNotes.join("\n")}`;
    }
    return "No votes have been recorded for any time slot yet.";
  }

  let players = [];
  const { interestedPlayers, yesOption } = getPollVoters(targetPollId, targetPollState, mePn, messageStore);
  const isOptIn = targetPollState.type === 'opt_in' || targetPollState.size === null || targetPollState.options?.some((o) => /^yes$/i.test(o.trim()));
  if (interestedPlayers && interestedPlayers.length > 0) {
    players = interestedPlayers;
    if (isOptIn) {
      const deduplicated = [];
      for (const p of players) {
        if (!deduplicated.some((existing) => ratings.keyFor(existing) === ratings.keyFor(p))) {
          deduplicated.push(p);
        }
      }
      const optInLimit = (typeof targetPollState.slotLimit === 'number' && targetPollState.slotLimit > 0)
        ? targetPollState.slotLimit
        : ((targetPollState.type === 'opt_in' && typeof targetPollState.size === 'number' && targetPollState.size > 0) ? targetPollState.size : null);
      players = optInLimit ? deduplicated.slice(0, optInLimit) : deduplicated;
    } else if (targetPollState.isManual) {
      const { players: adjustedPlayers, addedExtra } = resolveManualPollPlayers(targetPollState, players);
      if (addedExtra && addedExtra.length > 0) {
        console.log(`[poll] Adjusted manual poll players: added extra [${addedExtra.join(', ')}] -> total ${adjustedPlayers.length} player(s)`);
      }
      players = adjustedPlayers;
    } else {
      const { aggregated } = getPollVoters(targetPollId, targetPollState, mePn, messageStore);
      const { players: rosterPlayers } = resolveFixedPollRoster(targetPollState, aggregated);
      if (rosterPlayers.length > 0) {
        players = rosterPlayers;
      }
    }
  } else if (targetPollState.lastPlayers && targetPollState.lastPlayers.length > 0) {
    players = targetPollState.lastPlayers;
  }

  if (targetPollState.parentPollId) {
    const sessionPolls = [...activePolls.values()]
      .filter((s) => s.parentPollId === targetPollState.parentPollId && s.status !== 'cancelled' && s.status !== 'stopped')
      .sort((a, b) => (a.partNumber || 1) - (b.partNumber || 1));
    const combined = [];
    for (const sp of sessionPolls) {
      const spId = [...activePolls.entries()].find(([, val]) => val === sp)?.[0];
      const { aggregated: spAgg } = getPollVoters(spId, sp, mePn, messageStore);
      const { players: spRoster } = resolveFixedPollRoster(sp, spAgg);
      const sourcePlayers = (spRoster && spRoster.length > 0) ? spRoster : (sp.lastPlayers || []);
      for (const p of sourcePlayers) {
        if (!combined.some((ex) => ratings.keyFor(ex) === ratings.keyFor(p))) {
          combined.push(p);
        }
      }
    }
    if (combined.length > 0) {
      players = combined;
    }
  }

  if (players.length === 0) {
    return targetPollState.type === 'opt_in' || targetPollState.options?.some((o) => /^yes$/i.test(o))
      ? 'No one has voted "Yes" yet in the opt-in poll.'
      : 'No votes have been recorded yet for this poll.';
  }

  if (players.length === 1) {
    return `Only 1 player has voted so far (${players[0]}). Need at least 2 for singles or 4 for doubles.`;
  }

  if (players.length !== 2 && players.length % 4 !== 0) {
    return `Got ${players.length} players (${players.join(', ')}).\nNeed 2 players for singles or a multiple of 4 (4, 8, 12, etc.) for doubles to generate standard matchups.`;
  }

  targetPollState.status = 'resolved';
  targetPollState.lastPlayers = players;
  if (targetPollState.parentPollId) {
    for (const [, s] of activePolls.entries()) {
      if (s.parentPollId === targetPollState.parentPollId) {
        s.status = 'resolved';
        s.lastPlayers = players;
      }
    }
  }
  persistPolls();

  console.log(`[poll] Generating matchups for poll ${targetPollId} ("${targetPollState.name || targetPollState.type}") with ${players.length} player(s): ${players.join(', ')}`);

  await ratings.ensureRated(players);
  const prebookedCourts = (options && Array.isArray(options.prebookedCourts) && options.prebookedCourts.length > 0)
    ? options.prebookedCourts
    : await getPrebookedCourtsForPoll(targetPollState, chatId);
  const schedule = generateMatchups(players, { ...options, prebookedCourts, chatId });
  const whenHeader = formatMatchHeaderTime(targetPollState);
  const header = whenHeader ? `📅 ${whenHeader}\n\n` : '';
  await sendMessageAndRecord(sock, chatId, { text: header + formatMatchups(schedule) });
  pairHistory.recordDraw(targetPollId, schedule, Date.now(), chatId);
  const playAtMs = targetPollState?.playAt ? new Date(targetPollState.playAt).getTime() : Date.now();
  playerActivity.recordPlayed(players, playAtMs, targetPollState?.remoteJid || chatId);
  targetPollState.lastSchedule = summarizeSchedule(schedule);
  if (targetPollState.parentPollId) {
    for (const [, s] of activePolls.entries()) {
      if (s.parentPollId === targetPollState.parentPollId) {
        s.lastSchedule = summarizeSchedule(schedule);
      }
    }
  }
  persistPolls();
  return null;
}

module.exports = {
  extractFixedPairsFromText,
  generateMatchupsFromPoll
};
