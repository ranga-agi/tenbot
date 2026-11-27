/**
 * Poll Reminders, Lead-Time Auto-Lineups & Quiet Hours
 */

const { jidNormalizedUser } = require('@whiskeysockets/baileys');

const ratings = require('../../ratings');
const namesStore = require('../../names');
const { sendMessageAndRecord } = require('../../botMessage');
const groupsConfig = require('../../groupsConfig');
const pollTime = require('../../pollTime');
const pairHistory = require('../../pairHistory');
const playerActivity = require('../../playerActivity');
const {
  generateMatchups,
  formatScheduleSets,
  formatMatchups,
  summarizeSchedule
} = require('../../matchups');
const { isUserAdmin, getTargetGroupJid, resolveAllowedGroup, extractGroupFlag } = require('../groupCommands');

const { resolvePlayDateTime, getSanJoseParts, createSanJoseDate, formatLookAround } = pollTime;

const {
  POWERS_OF_2_REMINDER_HOURS,
  MAX_POLL_REMINDERS,
  storeKey,
  nameFor,
  hasTimeSpecifiedInTitle,
  isValidPlayerCount,
  getFirstSlotNumber,
  resolveManualPollPlayers,
  resolveFixedPollRoster,
  resolveMultiTimePollRoster,
  getPollVoters,
  getPollDayWord,
  getUntimedPollDayExpiryMs,
  pollTitleIndicatesGame,
  isAutoCreatedPoll,
  findSpecificPoll,
  formatMatchHeaderTime,
  getVoteTimestamp,
  getVoteArrivalIndex
} = require('./roster');
const { getPrebookedCourtsForPoll } = require('./courts');

function getSessionPollEntries(activePolls, pollId, pollState) {
  if (pollState?.parentPollId && activePolls && typeof activePolls.entries === 'function') {
    const sessionEntries = [...activePolls.entries()]
      .filter(([, s]) => s && s.parentPollId === pollState.parentPollId && s.status !== 'cancelled' && s.status !== 'stopped')
      .sort((a, b) => (a[1].partNumber || 1) - (b[1].partNumber || 1));
    if (sessionEntries.length > 0) {
      return sessionEntries;
    }
  }
  return [[pollId, pollState]];
}

function getCombinedFixedSessionRoster(sessionEntries, mePn, messageStore) {
  const nonVoterEntries = [];
  const votedEntries = [];
  const seenNonVoterKeys = new Set();
  const seenVoterKeys = new Set();
  let sumTotalSlots = 0;

  for (const [sId, sState] of sessionEntries) {
    const { aggregated } = getPollVoters(sId, sState, mePn, messageStore);
    const roster = resolveFixedPollRoster(sState, aggregated);
    sumTotalSlots += roster.totalSlotsCount;

    const partPlayers = roster.players || [];
    if (partPlayers.length > 0) {
      const activeKeySet = new Set(partPlayers.map((p) => ratings.keyFor(p)));
      const partVotersByKey = new Map();
      for (const v of (roster.voterEntries || [])) {
        const k = ratings.keyFor(v.playerName);
        if (activeKeySet.has(k) && !partVotersByKey.has(k)) {
          partVotersByKey.set(k, v);
        }
      }

      for (const p of partPlayers) {
        const k = ratings.keyFor(p);
        if (partVotersByKey.has(k)) {
          if (!seenVoterKeys.has(k)) {
            seenVoterKeys.add(k);
            const v = partVotersByKey.get(k);
            votedEntries.push({
              name: v.playerName,
              jid: v.voterJid || null,
              ts: v.ts || 0,
              arrIdx: typeof v.arrIdx === 'number' ? v.arrIdx : 999999,
              partNumber: sState.partNumber || 1
            });
          }
        } else if (!seenNonVoterKeys.has(k) && !seenVoterKeys.has(k)) {
          seenNonVoterKeys.add(k);
          const isCreator = sState.creator?.name && ratings.keyFor(sState.creator.name) === k && sState.creator?.jid;
          const jid = isCreator
            ? sState.creator.jid
            : (namesStore.findIdByNameOrAlias(p, sState.remoteJid)?.id || null);
          nonVoterEntries.push({ name: p, jid });
        }
      }
    } else if (
      Array.isArray(sState.lastPlayers) &&
      sState.lastPlayers.length > 0 &&
      (sState.status === 'filled' || sState.status === 'resolved')
    ) {
      for (const p of sState.lastPlayers) {
        const k = ratings.keyFor(p);
        if (!seenNonVoterKeys.has(k) && !seenVoterKeys.has(k)) {
          seenNonVoterKeys.add(k);
          const isCreator = sState.creator?.name && ratings.keyFor(sState.creator.name) === k && sState.creator?.jid;
          const jid = isCreator
            ? sState.creator.jid
            : (namesStore.findIdByNameOrAlias(p, sState.remoteJid)?.id || null);
          nonVoterEntries.push({ name: p, jid });
        }
      }
    }
  }

  votedEntries.sort(compareVoteChronology);
  const combinedEntries = [...nonVoterEntries, ...votedEntries];
  const combinedPlayers = combinedEntries.map((e) => e.name);

  const baseState = sessionEntries[0]?.[1];
  const totalSpots = (
    baseState &&
    !baseState.slotLimit &&
    typeof baseState.sessionTotalSize === 'number' &&
    baseState.sessionTotalSize > sumTotalSlots
  )
    ? baseState.sessionTotalSize
    : sumTotalSlots;

  const filledCount = Math.min(totalSpots, combinedPlayers.length);
  const openSpots = Math.max(0, totalSpots - filledCount);

  return {
    players: combinedPlayers,
    playerEntries: combinedEntries,
    filledCount,
    totalSpots,
    openSpots
  };
}

function compareVoteChronology(a, b) {
  if (a.ts && b.ts && a.ts !== b.ts) return a.ts - b.ts;
  if ((a.partNumber || 1) !== (b.partNumber || 1)) return (a.partNumber || 1) - (b.partNumber || 1);
  return (a.arrIdx || 0) - (b.arrIdx || 0);
}

function resolveMentionForPlayer(entry, remoteJid = null) {
  const playerName = typeof entry === 'string' ? entry : (entry?.name || 'Player');
  let rawJid = typeof entry === 'object' && entry ? entry.jid : null;
  if (!rawJid && playerName && remoteJid) {
    const match = namesStore.findIdByNameOrAlias(playerName, remoteJid);
    if (match?.id) rawJid = match.id;
  }
  if (!rawJid || !String(rawJid).includes('@')) {
    return { name: playerName, tag: `@${playerName}`, jids: [] };
  }
  const norm = jidNormalizedUser(rawJid);
  const pn = namesStore.getPnByLid(norm) || (norm?.endsWith('@s.whatsapp.net') ? norm : null);
  const lid = namesStore.resolveCanonicalId(norm) || (norm?.endsWith('@lid') ? norm : null);
  const rawUserPart = (pn || norm || lid || rawJid).split('@')[0];
  const phoneDigits = /^\d+$/.test(rawUserPart) ? rawUserPart : '';
  const tag = phoneDigits ? `@${phoneDigits}` : `@${playerName}`;
  const jids = [...new Set([pn, lid, norm, rawJid].filter((j) => j && String(j).includes('@')))];
  return { name: playerName, tag, jids };
}

function getCleanLogicalPollName(pollState, fallbackId = 'Match Poll') {
  if (!pollState) return fallbackId;
  if (pollState.title && pollState.when) return `${pollState.title} — ${pollState.when}`;
  if (pollState.title) return pollState.title;
  if (pollState.when) return pollState.when;
  if (pollState.name) {
    return pollState.parentPollId
      ? pollState.name.replace(/\s*\(Part\s+\d+\/\d+[^)]*\)/i, '').trim()
      : pollState.name;
  }
  return fallbackId;
}

function syncSentRemindersAcrossSession(sessionEntries, sentReminders) {
  for (const [, s] of sessionEntries) {
    s.sentReminders = [...sentReminders];
  }
}

function getDayBefore12pmReminderTime(pollState, now = new Date()) {
  const dayWord = getPollDayWord(pollState);
  if (!dayWord) return null;

  const baseDate = pollState.createdAt ? new Date(pollState.createdAt) : now;
  const targetDate = resolvePlayDateTime(dayWord, null, baseDate);
  if (!targetDate || Number.isNaN(targetDate.getTime())) return null;

  const targetParts = getSanJoseParts(targetDate);
  const dayBeforeUtc = new Date(Date.UTC(targetParts.year, targetParts.month, targetParts.day - 1));
  const dayBeforeYear = dayBeforeUtc.getUTCFullYear();
  const dayBeforeMonth = dayBeforeUtc.getUTCMonth();
  const dayBeforeDay = dayBeforeUtc.getUTCDate();

  const reminderDate = createSanJoseDate(dayBeforeYear, dayBeforeMonth, dayBeforeDay, 12, 0, 0);
  const matchDayStart = createSanJoseDate(targetParts.year, targetParts.month, targetParts.day, 0, 0, 0);

  return {
    reminderTimeMs: reminderDate.getTime(),
    matchDayStartMs: matchDayStart.getTime(),
    reminderDate,
    targetDate
  };
}
const getDayBefore6pmReminderTime = getDayBefore12pmReminderTime;

function buildLineupReminderText(pollState) {
  const leadTimeMins = typeof pollState.lineupLeadTime === "number" && pollState.lineupLeadTime > 0
    ? pollState.lineupLeadTime
    : 30;
  const leadStr = formatLookAround(leadTimeMins) || `${leadTimeMins} mins`;
  const whenHeader = formatMatchHeaderTime(pollState);
  const header = whenHeader ? `📅 ${whenHeader}\n\n` : "";

  const scheduleText = formatScheduleSets(pollState.lastSchedule);
  const body = scheduleText || (pollState.manualLineupText ? pollState.manualLineupText.trim() : "");

  return `⏰ *Match Reminder!* (${leadStr} to go)\n\n${header}Here is the lineup for today's match:\n\n${body}`.trim();
}

/**
 * Sweeps active polls at lead time before play time to:
 *   1. Fallback mode: auto-generate and post matchups if the poll filled up and no manual lineup was posted.
 *   2. Non-fallback mode (filled/none): send a reminder message to the group with the lineup if one is available.
 */
async function checkPendingLineupGenerations(sock, context, now = Date.now()) {
  if (!sock || !context?.activePolls) return [];
  const { activePolls, persistPolls, messageStore } = context;
  const generatedPollIds = [];
  const remindedPollIds = [];
  const processedSessions = new Set();

  for (const [pollId, pollState] of activePolls.entries()) {
    if (pollState.status === "cancelled" || pollState.status === "expired") continue;

    if (pollState.type === "multi_time" && Array.isArray(pollState.timeSlots)) {
      const leadTimeMins = typeof pollState.lineupLeadTime === "number" && pollState.lineupLeadTime > 0
        ? pollState.lineupLeadTime
        : 30;
      const mode = pollState.lineupGeneration || (pollState.noMatchups ? "none" : "filled");
      const mePn = jidNormalizedUser(sock?.user?.id || sock?.authState?.creds?.me?.id || "");
      const { aggregated } = getPollVoters(pollId, pollState, mePn, messageStore);

      for (const slot of pollState.timeSlots) {
        if (!slot.playAt) continue;
        const slotPlayAtMs = new Date(slot.playAt).getTime();
        if (Number.isNaN(slotPlayAtMs) || now >= slotPlayAtMs) continue;
        const slotDeadlineMs = slotPlayAtMs - (leadTimeMins * 60 * 1000);
        if (now < slotDeadlineMs) continue;

        const slotRosters = resolveMultiTimePollRoster(pollState, aggregated);
        const sr = slotRosters.find((r) => r.slot === slot);
        if (!sr) continue;

        const isUnlimitedSlot = sr.slotLimit === null;
        const shouldAutoGenAtDeadline =
          !slot.manualLineupPosted &&
          slot.status !== "resolved" &&
          !slot.matchupsGenerated &&
          ((mode === "fallback" && (slot.status === "filled" || sr.isAllFilled || isUnlimitedSlot)) ||
           (mode === "filled" && isUnlimitedSlot));

        if (shouldAutoGenAtDeadline) {
          let slotPlayers = sr.players;
          if (slotPlayers.length > 4 && slotPlayers.length % 4 !== 0) {
            slotPlayers = slotPlayers.slice(0, Math.floor(slotPlayers.length / 4) * 4);
          }
          if (isValidPlayerCount(slotPlayers.length)) {
            slot.status = "resolved";
            slot.matchupsGenerated = true;
            slot.lastPlayers = slotPlayers;
            if (persistPolls) persistPolls();

            try {
              await ratings.ensureRated(slotPlayers);
              const slotPrebooked = slot.prebookedCourts || [];
              const schedule = generateMatchups(slotPlayers, { prebookedCourts: slotPrebooked, chatId: pollState.remoteJid });
              const slotTimeStr = slot.dayDisplay ? `${slot.dayDisplay} ${slot.timeDisplay}` : slot.label;
              const slotHeader = `📅 ${pollState.title ? `${pollState.title} — ${slotTimeStr}` : slotTimeStr}\n\n`;
              await sendMessageAndRecord(sock, pollState.remoteJid, { text: slotHeader + formatMatchups(schedule) });
              pairHistory.recordDraw(`${pollId}:${slot.label}`, schedule, Date.now(), pollState.remoteJid);
              playerActivity.recordPlayed(slotPlayers, slotPlayAtMs, pollState.remoteJid);
              slot.lastSchedule = summarizeSchedule(schedule);
              slot.lineupReminderSent = true;
              if (persistPolls) persistPolls();
              if (!generatedPollIds.includes(pollId)) generatedPollIds.push(pollId);
            } catch (err) {
              console.error(`[poll] Error auto-generating lineups for multi-time poll ${pollId} slot ${slot.label}:`, err.message);
            }
          }
        } else if (mode !== "fallback" && !slot.lineupReminderSent && pollState.reminders !== false && slot.lastSchedule) {
          const slotReminderState = {
            ...pollState,
            when: slot.dayDisplay ? `${slot.dayDisplay} ${slot.timeDisplay}` : slot.label,
            playAt: slot.playAt,
            lastSchedule: slot.lastSchedule
          };
          const reminderText = buildLineupReminderText(slotReminderState);
          const quotedMsg = pollState.pollMsgKey ? { key: pollState.pollMsgKey } : undefined;
          try {
            await sendMessageAndRecord(sock, pollState.remoteJid, { text: reminderText }, { quoted: quotedMsg });
            slot.lineupReminderSent = true;
            if (persistPolls) persistPolls();
            if (!remindedPollIds.includes(pollId)) remindedPollIds.push(pollId);
          } catch (err) {
            console.error(`[poll] Error sending lineup reminder for multi-time poll ${pollId} slot ${slot.label}:`, err.message);
          }
        }
      }

      const allSlotsResolved = pollState.timeSlots.every((s) => s.status === "resolved");
      if (allSlotsResolved && pollState.status !== "resolved") {
        pollState.status = "resolved";
        if (persistPolls) persistPolls();
      }
      continue;
    }

    if (pollState.parentPollId) {
      if (processedSessions.has(pollState.parentPollId)) continue;
      processedSessions.add(pollState.parentPollId);
    }

    const sessionEntries = getSessionPollEntries(activePolls, pollId, pollState);
    const [repPollId, repPollState] = sessionEntries[0] || [pollId, pollState];

    if (!repPollState.playAt || repPollState.playAt === "unknown") continue;

    const playAtMs = new Date(repPollState.playAt).getTime();
    if (Number.isNaN(playAtMs)) continue;
    if (now >= playAtMs) continue;

    const leadTimeMins = typeof repPollState.lineupLeadTime === "number" && repPollState.lineupLeadTime > 0
      ? repPollState.lineupLeadTime
      : 30;
    const deadlineMs = playAtMs - (leadTimeMins * 60 * 1000);

    if (now < deadlineMs) continue;

    const mode = repPollState.lineupGeneration || (repPollState.noMatchups ? "none" : "filled");

    if (mode === "fallback") {
      // 1. Fallback mode: auto-generate matchups at lead time if poll is filled and no manual lineup was posted
      const totalExpectedParts = repPollState.totalParts || sessionEntries.length;
      const isSessionFilled = repPollState.parentPollId
        ? (sessionEntries.length >= totalExpectedParts && sessionEntries.every(([, s]) => s.status === "filled"))
        : (repPollState.status === "filled");
      const anyManualPosted = sessionEntries.some(([, s]) => s.manualLineupPosted);

      if (!isSessionFilled || anyManualPosted) continue;

      console.log(`[poll] Lineup generation deadline reached for filled poll ${repPollId} (${leadTimeMins}m before play time). No manual lineup posted. Generating lineups...`);

      const mePn = jidNormalizedUser(sock?.user?.id || sock?.authState?.creds?.me?.id || "");
      let players = [];

      if (repPollState.parentPollId) {
        players = getCombinedFixedSessionRoster(sessionEntries, mePn, messageStore).players;
      } else {
        const { aggregated, interestedPlayers } = getPollVoters(repPollId, repPollState, mePn, messageStore);

        if (repPollState.type === "opt_in" || repPollState.options?.some((o) => /^yes$/i.test(o))) {
          const yesOption = aggregated.find((o) => /^yes$/i.test(o.name.trim()));
          const rawYesPlayers = yesOption ? yesOption.voters.map(nameFor) : interestedPlayers;
          const optLimit = (typeof repPollState.slotLimit === 'number' && repPollState.slotLimit > 0)
            ? repPollState.slotLimit
            : ((repPollState.type === 'opt_in' && typeof repPollState.size === 'number' && repPollState.size > 0) ? repPollState.size : null);
          players = optLimit ? rawYesPlayers.slice(0, optLimit) : rawYesPlayers;
        } else if (repPollState.isManual) {
          players = resolveManualPollPlayers(repPollState, interestedPlayers).players;
        } else {
          players = resolveFixedPollRoster(repPollState, aggregated).players;
        }
      }

      if ((!isValidPlayerCount(players.length) || players.length === 0) && Array.isArray(repPollState.lastPlayers) && isValidPlayerCount(repPollState.lastPlayers.length)) {
        players = repPollState.lastPlayers;
      }

      if (isValidPlayerCount(players.length)) {
        for (const [, s] of sessionEntries) {
          s.status = "resolved";
          s.lastPlayers = players;
        }
        if (persistPolls) persistPolls();

        try {
          await ratings.ensureRated(players);
          const prebookedCourts = await getPrebookedCourtsForPoll(repPollState, repPollState.remoteJid);
          const schedule = generateMatchups(players, { prebookedCourts, chatId: repPollState.remoteJid });
          const whenHeader = formatMatchHeaderTime(repPollState);
          const header = whenHeader ? `📅 ${whenHeader}\n\n` : "";
          await sendMessageAndRecord(sock, repPollState.remoteJid, { text: header + formatMatchups(schedule) });
          pairHistory.recordDraw(repPollState.parentPollId || repPollId, schedule, Date.now(), repPollState.remoteJid);
          const resolvedPlayAtMs = repPollState?.playAt ? new Date(repPollState.playAt).getTime() : Date.now();
          playerActivity.recordPlayed(players, resolvedPlayAtMs, repPollState.remoteJid);
          const summary = summarizeSchedule(schedule);
          for (const [, s] of sessionEntries) {
            s.lastSchedule = summary;
            s.lineupReminderSent = true;
          }
          if (persistPolls) persistPolls();
          generatedPollIds.push(repPollId);
          console.log(`[poll] Successfully auto-generated and posted lineups for poll ${repPollId}`);
        } catch (err) {
          console.error(`[poll] Error auto-generating lineups for poll ${repPollId}:`, err.message);
        }
      } else {
        console.warn(`[poll] Poll ${repPollId} filled count (${players.length}) is not a valid player count for standard matchups`);
      }
    } else {
      // 2. Non-fallback mode (filled/none): send a reminder message to the group with the lineup at lead time
      if (sessionEntries.some(([, s]) => s.lineupReminderSent) || sessionEntries.some(([, s]) => s.reminders === false)) continue;

      const scheduleSource = sessionEntries.find(([, s]) => Boolean(s.lastSchedule))?.[1] || repPollState;
      const anyManualPosted = sessionEntries.some(([, s]) => s.manualLineupPosted);
      const isLineupAvailable =
        (mode === "filled" && Boolean(scheduleSource.lastSchedule)) ||
        (mode === "none" && Boolean(anyManualPosted && scheduleSource.lastSchedule));

      if (!isLineupAvailable) continue;

      console.log(`[poll] Sending lineup reminder for poll ${repPollId} (${leadTimeMins}m before play time) in ${repPollState.remoteJid}`);
      const reminderState = scheduleSource === repPollState
        ? repPollState
        : {
          ...scheduleSource,
          title: repPollState.title || scheduleSource.title || null,
          when: repPollState.when || scheduleSource.when,
          playAt: repPollState.playAt || scheduleSource.playAt,
          lineupLeadTime: repPollState.lineupLeadTime ?? scheduleSource.lineupLeadTime
        };
      const reminderText = buildLineupReminderText(reminderState);
      const quotedMsg = repPollState.pollMsgKey ? { key: repPollState.pollMsgKey } : undefined;

      try {
        await sendMessageAndRecord(sock, repPollState.remoteJid, { text: reminderText }, { quoted: quotedMsg });
        for (const [, s] of sessionEntries) {
          s.lineupReminderSent = true;
        }
        if (persistPolls) persistPolls();
        remindedPollIds.push(repPollId);
        console.log(`[poll] Successfully sent lineup reminder for poll ${repPollId}`);
      } catch (err) {
        console.error(`[poll] Error sending lineup reminder for poll ${repPollId}:`, err.message);
      }
    }
  }

  const result = [...generatedPollIds, ...remindedPollIds];
  result.generatedPollIds = generatedPollIds;
  result.remindedPollIds = remindedPollIds;
  return result;
}

function buildUntimedPollReminderText(pollState, openSpots, totalSpots, playerList, isOptIn = false, yesCount = 0) {
  const isNeutral = Boolean(pollState && pollState.isManual && !pollTitleIndicatesGame(pollState));
  const spotWord = openSpots === 1 ? "spot" : "spots";
  const titleTag = pollState?.title ? ` (*${pollState.title}*)` : "";
  const yesCountLabel = totalSpots > 0 ? `${yesCount}/${totalSpots}` : `${yesCount}`;

  if (isNeutral) {
    if (isOptIn) {
      return `⏰ *Poll Reminder for Tomorrow!*${titleTag} We currently have *${yesCountLabel} response(s) in* for tomorrow.\n` +
        `Current responses: ${playerList}\n` +
        `Vote Yes in the poll above if you are planning to join! ⚡`;
    }
    return `⏰ *Poll Reminder for Tomorrow!*${titleTag} The poll for tomorrow still has *${openSpots} open ${spotWord}* (${openSpots}/${totalSpots} needed).\n` +
      `Current responses: ${playerList}\n` +
      `Vote in the poll above to lock in your spot!`;
  }

  if (isOptIn) {
    return `🎾 *Match Alert for Tomorrow!*${titleTag} We currently have *${yesCountLabel} player(s) in* for tomorrow's match.\n` +
      `Current lineup: ${playerList}\n` +
      `Who else is ready to play? Vote Yes in the poll above! 🎾⚡`;
  }

  return `🎾 *Match Alert for Tomorrow!*${titleTag} The match poll for tomorrow still has *${openSpots} open ${spotWord}* (${openSpots}/${totalSpots} needed).\n` +
    `Current lineup: ${playerList}\n` +
    `Vote in the poll above to lock in your spot!`;
}

function formatReminderHours(hours, isUpper = false) {
  const rounded = Math.round(hours * 2) / 2;
  if (rounded % 1 === 0) {
    return String(rounded);
  }
  const whole = Math.floor(rounded);
  if (whole === 0) {
    return isUpper ? "HALF" : "half";
  }
  return isUpper ? `${whole} AND HALF` : `${whole} and half`;
}

function formatReminderOrdinal(n) {
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${n}th`;
  switch (n % 10) {
    case 1: return `${n}st`;
    case 2: return `${n}nd`;
    case 3: return `${n}rd`;
    default: return `${n}th`;
  }
}

function buildPollReminder(H, pollState, openSpots, totalSpots, playerList, isOptIn = false, yesCount = 0, hoursRemaining = null, details = null) {
  const isNeutral = Boolean(pollState && pollState.isManual && !pollTitleIndicatesGame(pollState));
  const baseWhenStr = pollState.when ? pollState.when : (pollState.name || 'today');
  const whenStr = pollState?.title ? `${pollState.title} — ${baseWhenStr}` : baseWhenStr;
  const spotWord = openSpots === 1 ? 'spot' : 'spots';
  const playerWord = openSpots === 1 ? 'player' : 'players';
  const yesCountLabel = totalSpots > 0 ? `${yesCount}/${totalSpots}` : `${yesCount}`;

  const effHours = typeof hoursRemaining === 'number' && hoursRemaining > 0 ? hoursRemaining : H;
  const roundedHours = Math.max(0.5, Math.round(effHours * 2) / 2);
  const currentH = formatReminderHours(roundedHours, false);
  const currentHUpper = formatReminderHours(roundedHours, true);
  const currentMins = Math.max(1, Math.round(effHours * 60));

  if (isNeutral) {
    if (isOptIn) {
      if (effHours >= 24) {
        const days = Math.round(effHours / 24);
        const dayStr = days === 1 ? '1 Day' : `${days} Days`;
        return {
          text: `⏰ *${currentH} Hours (${dayStr}) to Go!* We have *${yesCountLabel} response(s) in* so far for *${whenStr}*.\n` +
            `Responses so far: ${playerList}\n` +
            `Don't miss out — cast your vote above to join!`,
          mentions: []
        };
      }
      if (effHours >= 16) {
        return {
          text: `⏰ *${currentH} Hours to Go!* We have *${yesCountLabel} response(s) in* so far for *${whenStr}*.\n` +
            `Responses so far: ${playerList}\n` +
            `Don't miss out — cast your vote above to join!`,
          mentions: []
        };
      }
      if (effHours >= 8) {
        return {
          text: `⏰ *${currentH} Hours to Go!* We currently have *${yesCountLabel} response(s) in* for *${whenStr}*.\n` +
            `Current responses: ${playerList}\n` +
            `Who else is joining? Vote Yes in the poll above! ⚡`,
          mentions: []
        };
      }
      if (effHours >= 4) {
        return {
          text: `🔥 *${currentH} Hours to Go!* *${yesCountLabel} response(s)* in for *${whenStr}*!\n` +
            `Current responses: ${playerList}\n` +
            `Cast your vote above if you want to join!`,
          mentions: []
        };
      }
      if (effHours >= 2) {
        return {
          text: `⚡ *${currentHUpper} HOURS TO GO!* *${yesCountLabel} response(s)* confirmed for *${whenStr}*!\n` +
            `Confirmed: ${playerList}\n` +
            `Vote Yes now before spots are finalized! 🏃‍♂️💨`,
          mentions: []
        };
      }
      if (effHours >= 1) {
        const hourWord = roundedHours === 1 ? '1 HOUR LEFT' : (roundedHours === 0.5 ? 'HALF HOUR LEFT' : `${currentHUpper} HOURS LEFT`);
        return {
          text: `🚨 *FINAL CALL: ${hourWord}!* *${yesCountLabel} response(s) in* for *${whenStr}*!\n` +
            `Current responses: ${playerList}\n` +
            `Last chance to vote Yes! 🏆⚡`,
          mentions: []
        };
      }
      return {
        text: `⚡ *${currentMins} MINUTES REMAINING!* *${yesCountLabel} response(s) in* for *${whenStr}*!\n` +
          `Current responses: ${playerList}\n` +
          `Final countdown to vote Yes! ⚡`,
        mentions: []
      };
    }

    if (effHours >= 32) {
      return {
        text: `📋 *Poll Alert:* The poll for *${whenStr}* still has *${openSpots} open ${spotWord}* (${openSpots}/${totalSpots} needed).\n` +
          `Current responses: ${playerList}\n` +
          `Vote in the poll above to lock in your spot!`,
        mentions: []
      };
    }
    if (effHours >= 24) {
      const days = Math.round(effHours / 24);
      const dayStr = days === 1 ? '1 Day' : `${days} Days`;
      return {
        text: `⏰ *${currentH} Hours (${dayStr}) to Go!* We have *${openSpots} ${spotWord} remaining* for *${whenStr}* (${openSpots}/${totalSpots} needed).\n` +
          `Responses so far: ${playerList}\n` +
          `Don't miss out — cast your vote above to lock in your spot!`,
        mentions: []
      };
    }
    if (effHours >= 16) {
      return {
        text: `⏰ *${currentH} Hours to Go!* We have *${openSpots} ${spotWord} remaining* for *${whenStr}* (${openSpots}/${totalSpots} needed).\n` +
          `Responses so far: ${playerList}\n` +
          `Don't miss out — cast your vote above to lock in your spot!`,
        mentions: []
      };
    }
    if (effHours >= 8) {
      return {
        text: `⏰ *${currentH} Hours to Go!* We still need *${openSpots} more ${playerWord}* for *${whenStr}* (${totalSpots} total spots).\n` +
          `Current responses: ${playerList}\n` +
          `Who else is joining? Claim your spot!`,
        mentions: []
      };
    }
    if (effHours >= 4) {
      return {
        text: `🔥 *${currentH} Hours to Go!* Only *${openSpots} ${spotWord} left* for *${whenStr}*!\n` +
          `Confirmed: ${playerList}\n` +
          `Grab the open ${spotWord} before it fills up! ⚡`,
        mentions: []
      };
    }
    if (effHours >= 2) {
      return {
        text: `⚡ *${currentHUpper} HOURS TO GO!* We only need *${openSpots} more ${playerWord}* for *${whenStr}*!\n` +
          `Confirmed: ${playerList}\n` +
          `Step up and claim the final ${spotWord}! 🏃‍♂️💨`,
        mentions: []
      };
    }
    if (effHours >= 1) {
      const hourWord = roundedHours === 1 ? '1 HOUR LEFT' : (roundedHours === 0.5 ? 'HALF HOUR LEFT' : `${currentHUpper} HOURS LEFT`);
      return {
        text: `🚨 *FINAL CALL: ${hourWord}!* Just *${openSpots} ${spotWord} open* for *${whenStr}*!\n` +
          `Current responses: ${playerList}\n` +
          `Vote now to grab the remaining ${spotWord}! 🔥`,
        mentions: []
      };
    }
    return {
      text: `⚡ *${currentMins} MINUTES TO GO!* Still need *${openSpots} more ${playerWord}* for *${whenStr}*!\n` +
        `Current responses: ${playerList}\n` +
        `Last chance to grab the remaining ${spotWord}! ⚡`,
      mentions: []
    };
  }

  if (pollState?.type === 'multi_time') {
    if (effHours >= 24) {
      const days = Math.round(effHours / 24);
      const dayStr = days === 1 ? '1 Day' : `${days} Days`;
      return {
        text: `⏰ *${currentH} Hours (${dayStr}) to Playtime!* We have *${yesCountLabel} player(s) in* so far for *${whenStr}*.\n` +
          `Players in: ${playerList}\n` +
          `Don't miss out — cast your vote above to join the match!`,
        mentions: []
      };
    }
    if (effHours >= 16) {
      return {
        text: `⏰ *${currentH} Hours to Playtime!* We have *${yesCountLabel} player(s) in* so far for *${whenStr}*.\n` +
          `Players in: ${playerList}\n` +
          `Don't miss out — cast your vote above to join the match!`,
        mentions: []
      };
    }
    if (effHours >= 8) {
      return {
        text: `🎾 *${currentH} Hours to Match Time!* We currently have *${yesCountLabel} player(s) in* for *${whenStr}*.\n` +
          `Current lineup: ${playerList}\n` +
          `Who else is ready to play? Vote Yes in the poll above! 🎾⚡`,
        mentions: []
      };
    }
    if (effHours >= 4) {
      return {
        text: `🔥 *${currentH} Hours Until Court Time!* *${yesCountLabel} player(s)* lined up for *${whenStr}*!\n` +
          `Roster: ${playerList}\n` +
          `Cast your vote above if you want in on today's session!`,
        mentions: []
      };
    }
    if (effHours >= 2) {
      return {
        text: `⚡ *${currentHUpper} HOURS TO GO!* *${yesCountLabel} player(s)* confirmed for *${whenStr}*!\n` +
          `Ready on court: ${playerList}\n` +
          `Vote Yes now before teams and matchups are drawn! 🎾🏃‍♂️💨`,
        mentions: []
      };
    }
    if (effHours >= 1) {
      const hourWord = roundedHours === 1 ? '1 HOUR LEFT' : (roundedHours === 0.5 ? 'HALF HOUR LEFT' : `${currentHUpper} HOURS LEFT`);
      return {
        text: `🚨 *FINAL CALL: ${hourWord}!* *${yesCountLabel} player(s) in* for *${whenStr}*!\n` +
          `Current roster: ${playerList}\n` +
          `Last chance to vote Yes before match time! 🏆🎾🔥`,
        mentions: []
      };
    }
    return {
      text: `⚡ *${currentMins} MINUTES REMAINING!* *${yesCountLabel} player(s) in* for *${whenStr}*!\n` +
        `Current roster: ${playerList}\n` +
        `Final countdown to vote Yes before matchups are locked in! 🏆🎾⚡`,
      mentions: []
    };
  }

  const bookedCourtsCount = Math.max(0, Number(details?.bookedCourtsCount) || 0);
  const rawEntries = Array.isArray(details?.playerEntries)
    ? details.playerEntries
    : (
        !playerList || /^none yet$/i.test(String(playerList).trim())
          ? []
          : String(playerList).split(',').map((s) => s.trim()).filter(Boolean).map((name) => ({ name, jid: null }))
      );

  const isSingles = totalSpots === 2;
  const groupSize = isSingles ? 2 : 4;
  const N = rawEntries.length > 0
    ? rawEntries.length
    : (isOptIn ? Math.max(0, Number(yesCount) || 0) : (totalSpots > 0 ? Math.max(0, totalSpots - openSpots) : 0));

  const remainder = N > 0 ? (N % groupSize) : 0;
  const isIncomplete = N > 0 && remainder !== 0;
  const confirmedCount = Math.floor(N / groupSize) * groupSize;
  const confirmedPlayers = rawEntries.slice(0, confirmedCount);
  const bubblePlayers = rawEntries.slice(confirmedCount);

  let needed = 0;
  if (N === 0) {
    needed = (totalSpots > 0 && openSpots <= 0) ? 0 : (totalSpots > 0 ? Math.min(groupSize, openSpots) : groupSize);
  } else if (isIncomplete) {
    needed = groupSize - remainder;
  } else if (totalSpots <= 0 || openSpots > 0) {
    needed = totalSpots > 0 ? Math.min(groupSize, openSpots) : groupSize;
  }

  let icon;
  let title;
  if (effHours >= 32) {
    icon = '🎾';
    title = 'Match Alert:';
  } else if (effHours >= 24) {
    const days = Math.round(effHours / 24);
    const dayStr = days === 1 ? '1 Day' : `${days} Days`;
    icon = '⏰';
    title = `${currentH} Hours (${dayStr}) to Playtime!`;
  } else if (effHours >= 16) {
    icon = isIncomplete ? '🔥' : '⏰';
    title = `${currentH} Hours to Playtime!`;
  } else if (effHours >= 8) {
    icon = isIncomplete ? '🔥' : '🎾';
    title = `${currentH} Hours to Match Time!`;
  } else if (effHours >= 4) {
    icon = '🔥';
    title = `${currentH} Hours Until Court Time!`;
  } else if (effHours >= 2) {
    icon = '⚡';
    title = `${currentHUpper} HOURS TO GO!`;
  } else if (effHours >= 1) {
    const hourWord = roundedHours === 1 ? '1 HOUR LEFT' : (roundedHours === 0.5 ? 'HALF HOUR LEFT' : `${currentHUpper} HOURS LEFT`);
    icon = '🚨';
    title = `FINAL CALL: ${hourWord}!`;
  } else {
    icon = '⚡';
    title = isOptIn ? `${currentMins} MINUTES REMAINING!` : `${currentMins} MINUTES TO GO!`;
  }

  const metaParts = [];
  if (isOptIn) {
    metaParts.push(`${yesCountLabel} player(s) in`);
  }
  if (bookedCourtsCount > 0) {
    metaParts.push(`${bookedCourtsCount} ${bookedCourtsCount === 1 ? 'court' : 'courts'} booked`);
  } else if (openSpots > 0 && (totalSpots > 0 || !isOptIn)) {
    metaParts.push(`${openSpots} ${spotWord} left`);
  }
  const metaSuffix = metaParts.length > 0 ? ` *(${metaParts.join(', ')})*` : '';
  const headerLine = `${icon} *${title}* — ${whenStr}${metaSuffix}`;

  const sections = [headerLine];

  if (confirmedPlayers.length > 0) {
    sections.push(`✅ *Confirmed (${confirmedPlayers.length}):*\n${confirmedPlayers.map((e) => e.name).join(', ')}`);
  }

  const groupNumber = Math.floor(N / groupSize) + 1;
  const ord = formatReminderOrdinal(groupNumber);
  const isLastGroup = totalSpots > 0 && openSpots <= needed;
  const inCurrentGroup = N > 0 ? remainder : 0;

  const shouldMention = effHours <= 16 && isIncomplete && bubblePlayers.length > 0;
  const mentions = [];

  if (needed > 0) {
    const needWord = needed === 1 ? 'player' : 'players';
    const needIcon = (effHours <= 16 && bubblePlayers.length > 0 && (needed === 1 || needed === 2))
      ? '\u26A0\uFE0F'
      : '⏳';
    let groupContext = '';
    if (!isSingles) {
      if (totalSpots > 0 && totalSpots <= groupSize) {
        groupContext = 'for the foursome ';
      } else if (groupNumber === 1) {
        groupContext = 'for a 1st foursome ';
      } else if (isLastGroup) {
        groupContext = `for the ${ord} foursome `;
      } else {
        groupContext = `for a ${ord} foursome `;
      }
    }

    if (bubblePlayers.length > 0) {
      const bubbleNamesStr = bubblePlayers.map((e) => e.name).join(', ');
      sections.push(`${needIcon} *Need ${needed} ${needWord} ${groupContext}(${inCurrentGroup}/${groupSize}):*\n${bubbleNamesStr}`);
    } else {
      const openPrompt = isSingles
        ? `Open — vote${isOptIn ? ' Yes' : ''} in the poll above to join!`
        : (groupNumber === 1
            ? `Open — vote${isOptIn ? ' Yes' : ''} in the poll above to get a court going!`
            : `Open — vote${isOptIn ? ' Yes' : ''} in the poll above to start ${isLastGroup ? 'the' : 'a'} ${ord} court!`);
      sections.push(`${needIcon} *Need ${needed} ${needWord} ${groupContext}(0/${groupSize}):*\n${openPrompt}`);
    }
  } else if (bubblePlayers.length > 0) {
    sections.push(`⏳ *Waiting (${bubblePlayers.length}):*\n${bubblePlayers.map((e) => e.name).join(', ')}`);
  }

  if (needed > 0 && bubblePlayers.length > 0) {
    let cta;
    if (shouldMention) {
      const resolved = bubblePlayers.map((e) => resolveMentionForPlayer(e, pollState?.remoteJid || null));
      const mentionStr = resolved.map((r) => r.tag).join(' ');
      for (const r of resolved) {
        for (const j of r.jids) mentions.push(j);
      }

      const courtTarget = isSingles
        ? 'the match'
        : ((totalSpots > 0 && totalSpots <= groupSize)
            ? 'the court'
            : (groupNumber === 1 ? 'a court' : (isLastGroup ? `the ${ord} court` : `a ${ord} court`)));
      const nextOrd = formatReminderOrdinal(groupNumber + 1);
      const spotsAfter = (!isSingles && totalSpots > 0) ? Math.max(0, openSpots - needed) : 0;
      const afterNote = (effHours >= 8 && spotsAfter > 0)
        ? ` (${spotsAfter} ${spotsAfter === 1 ? 'spot' : 'spots'} still open after that for ${spotsAfter <= groupSize ? 'a' : 'another'} ${nextOrd} court.)`
        : '';

      if (needed === 1) {
        if (effHours >= 8) {
          cta = `One more player locks in ${courtTarget}! ${mentionStr} — ${bubblePlayers.length === 1 ? 'can you' : 'can any of you'} find 1 more?${afterNote}`;
        } else if (effHours >= 4) {
          cta = `Just 1 player short of ${courtTarget}! ${mentionStr} — ${bubblePlayers.length === 1 ? 'can you' : 'can anyone'} bring 1 more?${afterNote}`;
        } else if (effHours >= 2) {
          cta = `Still 1 short for ${courtTarget}! ${mentionStr} — ${bubblePlayers.length === 1 ? 'can you' : 'can anyone'} bring 1 more player?`;
        } else if (effHours >= 1) {
          cta = `Just 1 player needed to lock in ${courtTarget}! ${mentionStr} — ${bubblePlayers.length === 1 ? 'are you' : 'anyone'} able to grab 1 last-minute player?`;
        } else {
          cta = `Last chance to fill ${courtTarget}! ${mentionStr} — ${bubblePlayers.length === 1 ? 'can you' : 'can anyone'} pull in 1 more player before play time?`;
        }
      } else if (needed === 2) {
        if (effHours >= 8) {
          cta = `2 more players lock in ${courtTarget}! ${mentionStr} — ${bubblePlayers.length === 1 ? 'can you' : 'can either of you'} help find 2 more?${afterNote}`;
        } else if (effHours >= 4) {
          cta = `Almost full! ${mentionStr} — can you help find 2 more players to fill ${courtTarget}?`;
        } else if (effHours >= 2) {
          cta = `Only 2 more players needed for ${courtTarget}! ${mentionStr} — can you help find 2 more?`;
        } else if (effHours >= 1) {
          cta = `Final call — 2 players needed to lock in ${courtTarget}! ${mentionStr} — can anyone grab 2 last-minute players?`;
        } else {
          cta = `Last chance — 2 players needed for ${courtTarget}! ${mentionStr} — can anyone pull in 2 more before play time?`;
        }
      } else {
        const posNum = confirmedCount + 1;
        if (effHours >= 4) {
          cta = `${mentionStr} — you're #${posNum} right now, so we need ${needed} more players to form ${courtTarget}. Ask around or vote above if anyone else can join!`;
        } else if (effHours >= 1) {
          cta = `${mentionStr} — you're #${posNum} right now! Need ${needed} more players to lock in ${courtTarget} — anyone free to join last minute?`;
        } else {
          cta = `${mentionStr} — you're #${posNum} right now! Last chance to grab ${needed} more players for ${courtTarget} before play time!`;
        }
      }
    } else if (totalSpots > 0 && openSpots > 0) {
      cta = `${openSpots} ${spotWord} still open — vote${isOptIn ? ' Yes' : ''} in the poll above to join!`;
    } else {
      cta = `Vote${isOptIn ? ' Yes' : ''} in the poll above to join!`;
    }
    sections.push(cta);
  }

  return {
    text: sections.join('\n\n'),
    mentions: [...new Set(mentions)]
  };
}

function buildPollReminderText(H, pollState, openSpots, totalSpots, playerList, isOptIn = false, yesCount = 0, hoursRemaining = null, details = null) {
  return buildPollReminder(H, pollState, openSpots, totalSpots, playerList, isOptIn, yesCount, hoursRemaining, details).text;
}

async function sendPollReminder(sock, pollId, pollState, isManualTrigger = false, context, now = Date.now()) {
  if (!sock || !pollState) return false;
  const sessionEntries = getSessionPollEntries(context?.activePolls, pollId, pollState);
  const activeEntries = sessionEntries.filter(([, s]) => s && s.status === 'active');
  if (activeEntries.length === 0 && pollState.status !== 'active') return false;

  const baseState = sessionEntries[0]?.[1] || pollState;
  const [quotePollId, quotePollState] = activeEntries[0] || sessionEntries[0] || [pollId, pollState];

  const isUntimedManual = baseState.isManual && (!baseState.playAt || baseState.playAt === 'unknown' || !hasTimeSpecifiedInTitle(baseState));
  const dayWord = isUntimedManual ? getPollDayWord(baseState) : null;

  // Do not send reminders for manual polls with no time and no day specified
  if (isUntimedManual && !dayWord) {
    return false;
  }

  const currentNow = now || Date.now();
  const mePn = jidNormalizedUser(sock.user?.id || sock.authState?.creds?.me?.id || '');

  let hoursRemaining = 0;
  if (baseState.playAt) {
    const playAtMs = new Date(baseState.playAt).getTime();
    if (!Number.isNaN(playAtMs)) {
      hoursRemaining = Math.max(0, (playAtMs - currentNow) / (60 * 60 * 1000));
    }
  }

  const isOptIn = baseState.type === 'opt_in' || baseState.options?.some((o) => /^yes$/i.test(o));

  let totalSpots = 0;
  let openSpots = 0;
  let yesCount = 0;
  let players = [];
  let playerEntries = null;

  if (baseState.parentPollId && !baseState.isManual && !isOptIn && baseState.type !== "multi_time") {
    const combined = getCombinedFixedSessionRoster(sessionEntries, mePn, context?.messageStore);
    totalSpots = combined.totalSpots;
    openSpots = combined.openSpots;
    players = combined.players;
    playerEntries = combined.playerEntries;

    if (openSpots <= 0 && !isManualTrigger) return false;
  } else {
    const { interestedPlayers, aggregated } = getPollVoters(pollId, pollState, mePn, context?.messageStore);

    if (pollState.isManual) {
      const options = pollState.options || [];
      const firstSlotNum = getFirstSlotNumber(options);
      const leadingCreatorSpots = (firstSlotNum && firstSlotNum > 1) ? (firstSlotNum - 1) : 0;
      const neededVotes = options.length > 0 ? options.length : (pollState.size || 4);
      totalSpots = leadingCreatorSpots + neededVotes;

      const filledVotes = aggregated && aggregated.length > 0
        ? aggregated.filter((o) => o.voters.length > 0).length
        : (interestedPlayers ? interestedPlayers.length : (pollState.voteBuffer ? pollState.voteBuffer.size : 0));
      openSpots = Math.max(0, neededVotes - filledVotes);

      if (isOptIn) {
        const yesOption = (aggregated || []).find((o) => /^yes$/i.test((o.name || '').trim()));
        let yesEntries = [];
        if (yesOption && Array.isArray(yesOption.voters) && yesOption.voters.length > 0) {
          const seenYesKeys = new Set();
          for (const v of yesOption.voters) {
            const name = nameFor(v);
            const k = ratings.keyFor(name);
            if (!seenYesKeys.has(k)) {
              seenYesKeys.add(k);
              yesEntries.push({
                name,
                jid: v,
                ts: getVoteTimestamp(pollState, v),
                arrIdx: getVoteArrivalIndex(pollState, v),
                partNumber: 1
              });
            }
          }
          yesEntries.sort(compareVoteChronology);
        } else {
          yesEntries = interestedPlayers.map((name) => ({
            name,
            jid: namesStore.findIdByNameOrAlias(name, pollState.remoteJid)?.id || null
          }));
        }
        const optInLimit = (typeof pollState.slotLimit === 'number' && pollState.slotLimit > 0)
          ? pollState.slotLimit
          : ((pollState.type === 'opt_in' && typeof pollState.size === 'number' && pollState.size > 0) ? pollState.size : null);
        if (optInLimit) {
          totalSpots = optInLimit;
          openSpots = Math.max(0, optInLimit - yesEntries.length);
          if (openSpots <= 0 && !isManualTrigger) return false;
          yesCount = Math.min(yesEntries.length, optInLimit);
          playerEntries = yesEntries.slice(0, optInLimit);
          players = playerEntries.map((e) => e.name);
        } else {
          totalSpots = 0;
          openSpots = 0;
          yesCount = yesEntries.length;
          playerEntries = yesEntries;
          players = playerEntries.map((e) => e.name);
        }
      } else {
        if (openSpots <= 0 && !isManualTrigger) return false;
        const { players: resolvedPlayers } = resolveManualPollPlayers(pollState, interestedPlayers);
        const voterByKey = new Map();
        for (const opt of (aggregated || [])) {
          if (!opt || !Array.isArray(opt.voters)) continue;
          if (/^(no|out|can't play|cannot play)$/i.test((opt.name || '').trim())) continue;
          for (const voterJid of opt.voters) {
            const playerName = nameFor(voterJid);
            const k = ratings.keyFor(playerName);
            if (!voterByKey.has(k)) {
              voterByKey.set(k, {
                name: playerName,
                jid: voterJid,
                ts: getVoteTimestamp(pollState, voterJid),
                arrIdx: getVoteArrivalIndex(pollState, voterJid),
                partNumber: 1
              });
            }
          }
        }
        const nonVoterEntries = [];
        const votedEntries = [];
        for (const p of resolvedPlayers) {
          const k = ratings.keyFor(p);
          if (voterByKey.has(k)) {
            votedEntries.push(voterByKey.get(k));
          } else {
            const isCreator = pollState.creator?.name && ratings.keyFor(pollState.creator.name) === k && pollState.creator?.jid;
            const jid = isCreator
              ? pollState.creator.jid
              : (namesStore.findIdByNameOrAlias(p, pollState.remoteJid)?.id || null);
            nonVoterEntries.push({ name: p, jid });
          }
        }
        votedEntries.sort(compareVoteChronology);
        playerEntries = [...nonVoterEntries, ...votedEntries];
        players = playerEntries.map((e) => e.name);
      }
    } else if (pollState.type === "multi_time" && Array.isArray(pollState.timeSlots)) {
      const slotRosters = resolveMultiTimePollRoster(pollState, aggregated);
      const activeSlots = slotRosters.filter((sr) => sr.slot.status !== "resolved" && sr.slot.status !== "expired");
      if (activeSlots.length === 0 && !isManualTrigger) return false;
      const slotSummaries = slotRosters.map((sr) => {
        const capStr = sr.slotLimit ? `${sr.filledCount}/${sr.slotLimit}` : `${sr.filledCount}`;
        const pNames = sr.players.length > 0 ? sr.players.join(", ") : "none yet";
        return `${sr.slot.label} (${capStr}: ${pNames})`;
      });
      yesCount = interestedPlayers.length;
      players = slotSummaries;
    } else if (isOptIn) {
      const yesOption = (aggregated || []).find((o) => /^yes$/i.test((o.name || '').trim()));
      let yesEntries = [];
      if (yesOption && Array.isArray(yesOption.voters) && yesOption.voters.length > 0) {
        const seenYesKeys = new Set();
        for (const v of yesOption.voters) {
          const name = nameFor(v);
          const k = ratings.keyFor(name);
          if (!seenYesKeys.has(k)) {
            seenYesKeys.add(k);
            yesEntries.push({
              name,
              jid: v,
              ts: getVoteTimestamp(pollState, v),
              arrIdx: getVoteArrivalIndex(pollState, v),
              partNumber: 1
            });
          }
        }
        yesEntries.sort(compareVoteChronology);
      } else {
        yesEntries = interestedPlayers.map((name) => ({
          name,
          jid: namesStore.findIdByNameOrAlias(name, pollState.remoteJid)?.id || null
        }));
      }
      const optInLimit = (typeof pollState.slotLimit === 'number' && pollState.slotLimit > 0)
        ? pollState.slotLimit
        : ((pollState.type === 'opt_in' && typeof pollState.size === 'number' && pollState.size > 0) ? pollState.size : null);
      if (optInLimit) {
        totalSpots = optInLimit;
        openSpots = Math.max(0, optInLimit - yesEntries.length);
        if (openSpots <= 0 && !isManualTrigger) return false;
        yesCount = Math.min(yesEntries.length, optInLimit);
        playerEntries = yesEntries.slice(0, optInLimit);
        players = playerEntries.map((e) => e.name);
      } else {
        yesCount = yesEntries.length;
        playerEntries = yesEntries;
        players = playerEntries.map((e) => e.name);
      }
    } else {
      const { players: resolvedPlayers, filledCount, totalSlotsCount, voterEntries } = resolveFixedPollRoster(pollState, aggregated);
      totalSpots = totalSlotsCount;
      openSpots = Math.max(0, totalSlotsCount - filledCount);

      if (openSpots <= 0 && !isManualTrigger) return false;

      const activeKeySet = new Set(resolvedPlayers.map((p) => ratings.keyFor(p)));
      const voterByKey = new Map();
      for (const v of (voterEntries || [])) {
        const k = ratings.keyFor(v.playerName);
        if (activeKeySet.has(k) && !voterByKey.has(k)) {
          voterByKey.set(k, {
            name: v.playerName,
            jid: v.voterJid || null,
            ts: v.ts || 0,
            arrIdx: typeof v.arrIdx === 'number' ? v.arrIdx : 999999,
            partNumber: pollState.partNumber || 1
          });
        }
      }
      const nonVoterEntries = [];
      const votedEntries = [];
      for (const p of resolvedPlayers) {
        const k = ratings.keyFor(p);
        if (voterByKey.has(k)) {
          votedEntries.push(voterByKey.get(k));
        } else {
          const isCreator = pollState.creator?.name && ratings.keyFor(pollState.creator.name) === k && pollState.creator?.jid;
          const jid = isCreator
            ? pollState.creator.jid
            : (namesStore.findIdByNameOrAlias(p, pollState.remoteJid)?.id || null);
          nonVoterEntries.push({ name: p, jid });
        }
      }
      votedEntries.sort(compareVoteChronology);
      playerEntries = [...nonVoterEntries, ...votedEntries];
      players = playerEntries.map((e) => e.name);
    }
  }

  let bookedCourtsCount = 0;
  if (!baseState.isManual || pollTitleIndicatesGame(baseState)) {
    const courtSet = new Set();
    for (const [, s] of sessionEntries) {
      const prebooked = await getPrebookedCourtsForPoll(s, s.remoteJid || quotePollState.remoteJid);
      for (const c of prebooked) {
        const cName = (typeof c === 'string' ? c : c?.court || '').trim().toLowerCase();
        if (cName) courtSet.add(cName);
      }
    }
    bookedCourtsCount = courtSet.size;
  }

  const playerList = players.length > 0 ? players.join(', ') : 'None yet';
  const displayState = (baseState.parentPollId && !baseState.when && baseState.name)
    ? { ...baseState, name: getCleanLogicalPollName(baseState) }
    : baseState;

  let reminderText;
  let reminderMentions = [];
  if (isUntimedManual) {
    reminderText = buildUntimedPollReminderText(displayState, openSpots, totalSpots, playerList, isOptIn, yesCount);
  } else {
    const targetH = POWERS_OF_2_REMINDER_HOURS.find((h) => hoursRemaining <= h) || (hoursRemaining || 1);
    const built = buildPollReminder(
      targetH,
      displayState,
      openSpots,
      totalSpots,
      playerList,
      isOptIn || displayState.type === "multi_time",
      yesCount,
      hoursRemaining,
      { playerEntries, bookedCourtsCount }
    );
    reminderText = built.text;
    reminderMentions = built.mentions || [];
  }

  const storedMessage = context?.messageStore ? context.messageStore.get(storeKey(quotePollState.remoteJid, quotePollId)) : null;
  const fromMe = !quotePollState.isManual;
  const participant = quotePollState.creator?.jid;

  const quotedMsg = {
    key: {
      remoteJid: quotePollState.remoteJid,
      id: quotePollId,
      fromMe: Boolean(fromMe),
      ...(participant ? { participant } : {})
    },
    ...(storedMessage ? { message: storedMessage } : {})
  };

  console.log(`[poll] Sending reminder for poll ${quotePollId} ("${getCleanLogicalPollName(displayState)}") in ${quotePollState.remoteJid} (replying to poll message)`);
  await sendMessageAndRecord(
    sock,
    quotePollState.remoteJid,
    { text: reminderText, ...(reminderMentions.length > 0 ? { mentions: reminderMentions } : {}) },
    { quoted: quotedMsg }
  );

  const nextReminderCount = Math.max(0, ...sessionEntries.map(([, s]) => s.reminderCount || 0)) + 1;
  for (const [, s] of sessionEntries) {
    s.reminderCount = nextReminderCount;
  }
  if (context?.persistPolls) context.persistPolls();
  return true;
}

function parseTriggerReminderArgs(text) {
  const parts = String(text || '').trim().split(/\s+/);
  const cmd = parts[0].toLowerCase();

  let isForce = /^(?:!forceremind(?:er)?|!remindforce|!sendreminderforce)$/i.test(cmd);
  const remainingParts = [];

  for (let i = 1; i < parts.length; i++) {
    const p = parts[i];
    if (/^--?force$/i.test(p) || /^force$/i.test(p)) {
      isForce = true;
    } else {
      remainingParts.push(p);
    }
  }

  const specificPollId = remainingParts.length > 0 ? remainingParts.join(' ') : null;
  return { isForce, specificPollId };
}

async function handleTriggerReminder(sock, chatId, sender, specificPollId = null, context = {}, isForce = false, now = Date.now()) {
  const effectiveNow = context?.now || now || Date.now();
  const { activePolls, recurringPolls } = context;
  const isDM = Boolean(chatId && !chatId.endsWith('@g.us'));
  const effectiveChatId = isDM ? (context.targetGroupJid || (typeof getTargetGroupJid === 'function' ? await getTargetGroupJid(sock) : null) || null) : chatId;
  let targetPolls = [];

  if (specificPollId) {
    const found = findSpecificPoll(specificPollId, activePolls, recurringPolls, effectiveChatId);
    if (!found) {
      return `⚠️ No match poll found matching "${specificPollId}". Use "!activepolls" or "!pollstatus" to check active poll IDs.`;
    }
    const { pollId, pollState } = found;
    const sessionEntries = getSessionPollEntries(activePolls, pollId, pollState);
    const activeEntries = sessionEntries.filter(([, s]) => s && s.status === 'active');

    if (activeEntries.length > 0) {
      const [repId, repState] = activeEntries[0];
      const isUntimedManual = repState.isManual && (!repState.playAt || repState.playAt === 'unknown' || !hasTimeSpecifiedInTitle(repState));
      const dayWord = isUntimedManual ? getPollDayWord(repState) : null;
      if (isUntimedManual && !dayWord) {
        return `⚠️ Reminders cannot be sent for poll "${repState.name || specificPollId}": no match time or day was specified.`;
      }
      targetPolls.push([repId, repState]);
    } else {
      return `⚠️ Poll "${getCleanLogicalPollName(pollState, pollId)}" has status "${pollState.status}" (reminders can only be triggered for active polls).`;
    }
  } else {
    const seenSessions = new Set();
    for (const [id, state] of activePolls.entries()) {
      const matchesChat = effectiveChatId ? (state.remoteJid === effectiveChatId) : true;
      if (matchesChat && state.status === 'active') {
        if (state.parentPollId) {
          if (seenSessions.has(state.parentPollId)) continue;
          seenSessions.add(state.parentPollId);
        }
        const sessionEntries = getSessionPollEntries(activePolls, id, state);
        const [repId, repState] = sessionEntries.find(([, s]) => s && s.status === 'active') || [id, state];
        const isUntimedManual = repState.isManual && (!repState.playAt || repState.playAt === 'unknown' || !hasTimeSpecifiedInTitle(repState));
        const dayWord = isUntimedManual ? getPollDayWord(repState) : null;
        if (isUntimedManual && !dayWord) {
          continue;
        }
        targetPolls.push([repId, repState]);
      }
    }
  }

  if (targetPolls.length === 0) {
    return 'No active match polls found to send reminders for.';
  }

  // Quiet hours check: block normal reminders if quiet hours are active, unless forced
  if (!isForce) {
    const checkChatId = effectiveChatId || (targetPolls[0] ? targetPolls[0][1].remoteJid : null) || chatId;
    if (checkChatId && groupsConfig.isInQuietHours(effectiveNow, checkChatId)) {
      const qh = groupsConfig.getQuietHours(checkChatId);
      const qhDisplay = qh?.display ? `*${qh.display}* (${qh.raw})` : 'quiet hours';
      return `⏰ *Quiet Hours Active*: Reminders are currently paused for this group (${qhDisplay}).\n` +
        `Match reminder notifications are suppressed during this window to avoid disturbing players.\n\n` +
        `👉 To send the reminder anyway, use:\n` +
        `• \`!forceremind${specificPollId ? ` ${specificPollId}` : ''}\` (or \`!remind${specificPollId ? ` ${specificPollId}` : ''} --force\`)`;
    }
  }

  let sentCount = 0;
  for (const [id, state] of targetPolls) {
    try {
      const sent = await sendPollReminder(sock, id, state, true, context, effectiveNow);
      if (sent) sentCount++;
    } catch (err) {
      console.error(`[poll] Failed to send manual reminder for poll ${id}:`, err.message);
    }
  }

  console.log(`[reminders] Manual reminder triggered for ${sentCount}/${targetPolls.length} poll(s) in ${chatId} by ${sender}${isForce ? " (forced: quiet hours bypassed)" : ""}`);

  const names = targetPolls.map(([id, state]) => `"${state.parentPollId ? getCleanLogicalPollName(state, id) : getCleanLogicalPollName(state, 'Match Poll')}"`);
  if (isDM) {
    if (sentCount > 0) {
      return `🔔 Match reminder triggered and sent to group for ${names.join(', ')}.`;
    }
    return `⚠️ Failed to send reminder for ${names.join(', ')}.`;
  }

  return true;
}

async function handlePauseReminders(sock, chatId, sender, specificPollId = null, context) {
  const { activePolls, recurringPolls, persistPolls } = context;
  const isDM = Boolean(chatId && !chatId.endsWith('@g.us'));
  const effectiveChatId = isDM ? (context.targetGroupJid || (typeof getTargetGroupJid === 'function' ? await getTargetGroupJid(sock) : null) || null) : chatId;
  if (specificPollId) {
    const found = findSpecificPoll(specificPollId, activePolls, recurringPolls, effectiveChatId);
    if (!found) {
      return `⚠️ No match poll found matching "${specificPollId}". Use "!activepolls" or "!pollstatus" to check active poll IDs.`;
    }

    const { pollId, pollState } = found;
    const sessionEntries = getSessionPollEntries(activePolls, pollId, pollState);
    const eligibleEntries = pollState.parentPollId
      ? sessionEntries.filter(([, s]) => s.status === 'active' || s.status === 'filled')
      : [[pollId, pollState]];
    const pollName = pollState.parentPollId
      ? getCleanLogicalPollName(pollState, pollId)
      : getCleanLogicalPollName(pollState, pollId);

    if (pollState.parentPollId && eligibleEntries.length === 0) {
      if (sessionEntries.every(([, s]) => s.status === 'resolved')) {
        return `ℹ️ Poll "${pollName}" has already been resolved and drawn (reminders are not active).`;
      }
      if (sessionEntries.every(([, s]) => s.status === 'expired')) {
        return `ℹ️ Poll "${pollName}" has expired (scheduled match play time has passed).`;
      }
      return `ℹ️ Poll "${pollName}" was cancelled.`;
    }

    if (!pollState.parentPollId) {
      if (pollState.status === 'resolved') {
        return `ℹ️ Poll "${pollName}" has already been resolved and drawn (reminders are not active).`;
      }
      if (pollState.status === 'expired') {
        return `ℹ️ Poll "${pollName}" has expired (scheduled match play time has passed).`;
      }
      if (pollState.status === 'cancelled') {
        return `ℹ️ Poll "${pollName}" was cancelled.`;
      }
    }

    if (eligibleEntries.every(([, s]) => s.reminders === false)) {
      return `⏸️ Reminders for "${pollName}" are already paused. Use "!resumereminders" to resume them anytime.`;
    }

    for (const [, s] of eligibleEntries) {
      s.reminders = false;
    }
    persistPolls();
    console.log(`[reminders] Reminders paused for poll ${pollId} ("${pollName}") by ${sender}`);
    return `⏸️ Reminders have been paused for "${pollName}". Use "!resumereminders ${pollId}" to resume them anytime.`;
  }

  const targetPolls = [];

  for (const [id, state] of activePolls.entries()) {
    const matchesChat = effectiveChatId ? (state.remoteJid === effectiveChatId) : true;
    if (matchesChat && (state.status === 'active' || state.status === 'filled')) {
      targetPolls.push([id, state]);
    }
  }

  if (targetPolls.length === 0) {
    return 'No active match polls found to pause reminders for.';
  }

  const names = [];
  const seenSessions = new Set();
  for (const [id, state] of targetPolls) {
    state.reminders = false;
    if (state.parentPollId) {
      if (seenSessions.has(state.parentPollId)) continue;
      seenSessions.add(state.parentPollId);
      names.push(`"${getCleanLogicalPollName(state, id)}"`);
    } else {
      names.push(`"${getCleanLogicalPollName(state, id)}"`);
    }
  }
  persistPolls();

  console.log(`[reminders] Reminders paused for ${names.length} poll(s) in ${chatId} by ${sender}`);
  return `⏸️ Reminders have been paused for ${names.join(', ')}. Use "!resumereminders" to resume them anytime.`;
}

async function handleResumeReminders(sock, chatId, sender, specificPollId = null, context) {
  const { activePolls, recurringPolls, persistPolls } = context;
  const isDM = Boolean(chatId && !chatId.endsWith('@g.us'));
  const effectiveChatId = isDM ? (context.targetGroupJid || (typeof getTargetGroupJid === 'function' ? await getTargetGroupJid(sock) : null) || null) : chatId;
  if (specificPollId) {
    const found = findSpecificPoll(specificPollId, activePolls, recurringPolls, effectiveChatId);
    if (!found) {
      return `⚠️ No match poll found matching "${specificPollId}". Use "!activepolls" or "!pollstatus" to check active poll IDs.`;
    }

    const { pollId, pollState } = found;
    const sessionEntries = getSessionPollEntries(activePolls, pollId, pollState);
    const eligibleEntries = pollState.parentPollId
      ? sessionEntries.filter(([, s]) => s.status === 'active' || s.status === 'filled')
      : [[pollId, pollState]];
    const pollName = pollState.parentPollId
      ? getCleanLogicalPollName(pollState, pollId)
      : getCleanLogicalPollName(pollState, pollId);

    if (pollState.parentPollId && eligibleEntries.length === 0) {
      if (sessionEntries.every(([, s]) => s.status === 'resolved')) {
        return `ℹ️ Poll "${pollName}" has already been resolved and drawn.`;
      }
      if (sessionEntries.every(([, s]) => s.status === 'expired')) {
        return `ℹ️ Poll "${pollName}" has expired (scheduled match play time has passed).`;
      }
      return `ℹ️ Poll "${pollName}" was cancelled.`;
    }

    if (!pollState.parentPollId) {
      if (pollState.status === 'resolved') {
        return `ℹ️ Poll "${pollName}" has already been resolved and drawn.`;
      }
      if (pollState.status === 'expired') {
        return `ℹ️ Poll "${pollName}" has expired (scheduled match play time has passed).`;
      }
      if (pollState.status === 'cancelled') {
        return `ℹ️ Poll "${pollName}" was cancelled.`;
      }
    }

    if (eligibleEntries.every(([, s]) => s.reminders !== false)) {
      return `▶️ Reminders for "${pollName}" are already active.`;
    }

    for (const [, s] of eligibleEntries) {
      s.reminders = true;
    }
    persistPolls();
    console.log(`[reminders] Reminders resumed for poll ${pollId} ("${pollName}") by ${sender}`);
    return `▶️ Reminders have been resumed for "${pollName}".`;
  }

  const targetPolls = [];

  for (const [id, state] of activePolls.entries()) {
    const matchesChat = effectiveChatId ? (state.remoteJid === effectiveChatId) : true;
    if (matchesChat && (state.status === 'active' || state.status === 'filled')) {
      targetPolls.push([id, state]);
    }
  }

  if (targetPolls.length === 0) {
    return 'No active match polls found to resume reminders for.';
  }

  const names = [];
  const seenSessions = new Set();
  for (const [id, state] of targetPolls) {
    state.reminders = true;
    if (state.parentPollId) {
      if (seenSessions.has(state.parentPollId)) continue;
      seenSessions.add(state.parentPollId);
      names.push(`"${getCleanLogicalPollName(state, id)}"`);
    } else {
      names.push(`"${getCleanLogicalPollName(state, id)}"`);
    }
  }
  persistPolls();

  console.log(`[reminders] Reminders resumed for ${names.length} poll(s) in ${chatId} by ${sender}`);
  return `▶️ Reminders have been resumed for ${names.join(', ')}.`;
}

async function handleQuietHoursCommand(sock, chatId, sender, senderJid, text, context = {}) {
  let raw = text.replace(/^!(?:quiethours|quiettime|reminderquiethours|setquiethours|setquiettime)\s*/i, "").trim();

  // Check for --group="<name>" or --group=<name> flag
  const { groupQuery: groupFlag, remainingText: rawWithoutGroup } = extractGroupFlag(raw);
  raw = rawWithoutGroup.trim();

  // Determine target group and quiet hours setting
  let targetChatId = null;
  let timeStr = null;

  if (chatId && chatId.endsWith("@g.us") && groupFlag) {
    return "⚠️ The --group option can only be used when sending commands in a direct message (DM) to the bot.";
  }

  if (groupFlag) {
    const res = await resolveAllowedGroup(sock, groupFlag);
    if (res?.error) {
      return res.error;
    }
    if (!res?.id) {
      return `⚠️ Group "${groupFlag}" was not found or is not in the allowed list.`;
    }
    targetChatId = res.id;
    timeStr = raw || null;
  } else if (!raw) {
    // No args provided
    if (chatId && chatId.endsWith("@g.us")) {
      targetChatId = chatId;
    } else {
      // In DM without group
      targetChatId = context?.targetGroupJid || (typeof getTargetGroupJid === "function" && sock ? await getTargetGroupJid(sock, senderJid) : null);
      if (!targetChatId) {
        return "Usage: !quiethours [groupName/JID] [start-end | off]\nExample: !quiethours 10pm-7am\nExample: !quiethours Bot-testing 10pm to 7am\nExample: !quiethours off";
      }
    }
  } else {
    // Raw args provided. Does entire string parse as quiet hours?
    const directParsed = groupsConfig.parseQuietHours(raw);
    if (directParsed) {
      // It is a time range or "off"
      if (chatId && chatId.endsWith("@g.us")) {
        targetChatId = chatId;
        timeStr = raw;
      } else {
        targetChatId = context?.targetGroupJid || (typeof getTargetGroupJid === "function" && sock ? await getTargetGroupJid(sock, senderJid) : null);
        if (!targetChatId) {
          return "Please specify the target group name or JID when running in DM.\nExample: !quiethours Bot-testing 10pm-7am";
        }
        timeStr = raw;
      }
    } else {
      // Check if tail matches time range or off
      const tailMatch = raw.match(/\b(off|none|disable|disabled|\d{1,2}(?::\d{2})?\s*(?:am|pm)?\s*(?:-|–|—|\bto\b)\s*\d{1,2}(?::\d{2})?\s*(?:am|pm)?)$/i);
      if (tailMatch) {
        const candidateTime = tailMatch[1].trim();
        const candidateGroup = raw.slice(0, tailMatch.index).trim();
        const parsedCandidateTime = groupsConfig.parseQuietHours(candidateTime);
        if (parsedCandidateTime && candidateGroup) {
          const res = await resolveAllowedGroup(sock, candidateGroup);
          if (res?.id) {
            targetChatId = res.id;
            timeStr = candidateTime;
          }
        }
      }

      if (!targetChatId) {
        // Maybe the entire raw string is a group name we want to query?
        const res = await resolveAllowedGroup(sock, raw);
        if (res?.id) {
          targetChatId = res.id;
          timeStr = null; // Query mode
        } else {
          return "⚠️ Invalid quiet hours format. Examples:\n• `!quiethours 10pm-7am`\n• `!quiethours 10:30pm to 6:30am`\n• `!quiethours 22:00-07:00`\n• `!quiethours off` (to disable)\n• `!quiethours Bot-testing 11pm-6am`";
        }
      }
    }
  }

  const groupCfg = groupsConfig.getGroupConfig(targetChatId);
  const targetName = groupCfg?.name || targetChatId;

  // If timeStr is null, query mode: display current quiet hours
  if (!timeStr) {
    const qh = groupsConfig.getQuietHours(targetChatId);
    if (qh && qh.enabled) {
      return `⏰ Reminder quiet hours for *${targetName}*: *${qh.display}* (${qh.raw}). Match reminder notifications are paused during this window.`;
    } else {
      return `⏰ Reminder quiet hours for *${targetName}*: *Disabled (Off)*. Match reminder notifications will be sent at any hour.`;
    }
  }

  // Update mode: check admin permissions
  const isSuper = groupsConfig.isSuperAdmin(senderJid);
  const isAdmin = isSuper || (await isUserAdmin(sock, targetChatId, senderJid));
  if (!isAdmin) {
    return "⚠️ Only group admins or the bot superadmin can change reminder quiet hours for this group.";
  }

  const parsed = groupsConfig.parseQuietHours(timeStr);
  if (!parsed) {
    return "⚠️ Invalid quiet hours format. Examples:\n• `!quiethours 10pm-7am`\n• `!quiethours 10:30pm to 6:30am`\n• `!quiethours 22:00-07:00`\n• `!quiethours off` (to disable)";
  }

  groupsConfig.updateGroupConfig(targetChatId, { quietHours: parsed.raw });

  if (parsed.enabled) {
    return `✅ Reminder quiet hours for *${targetName}* updated to *${parsed.display}* (${parsed.raw}). Match reminder notifications will be paused during this window.`;
  } else {
    return `✅ Reminder quiet hours for *${targetName}* have been *disabled*. Match reminder notifications will be sent at any hour.`;
  }
}

async function checkAndSendPollReminders(sock, context, now = Date.now()) {
  if (!sock) return;
  const { activePolls, persistPolls } = context;
  const processedSessions = new Set();

  try {
    for (const [pollId, pollState] of activePolls.entries()) {
      if (pollState.parentPollId && processedSessions.has(pollState.parentPollId)) continue;

      const sessionEntries = getSessionPollEntries(activePolls, pollId, pollState);
      const activeEntries = sessionEntries.filter(([, s]) => s && s.status === 'active');
      if (activeEntries.length === 0) continue;

      if (pollState.parentPollId) {
        processedSessions.add(pollState.parentPollId);
      }

      const [repPollId, repPollState] = activeEntries[0];

      // Expire polls whose play time or target day has passed regardless of quiet hours or reminder state
      const repEffectivePlayAt = repPollState.latestPlayAt || repPollState.playAt;
      const repPlayAtMs = (repEffectivePlayAt && repEffectivePlayAt !== 'unknown') ? new Date(repEffectivePlayAt).getTime() : NaN;
      if (!Number.isNaN(repPlayAtMs) && now >= repPlayAtMs) {
        let anyExpired = false;
        for (const [, s] of sessionEntries) {
          if (s.status === 'active' || s.status === 'filled' || s.status === 'stopped') {
            s.status = 'expired';
            anyExpired = true;
          }
        }
        if (anyExpired) {
          persistPolls();
          console.log(`[poll] Match play time passed for poll ${repPollId}: status automatically set to expired.`);
        }
        continue;
      }
      const repDayExpiryMs = getUntimedPollDayExpiryMs(repPollState, repPollId, context?.messageStore);
      if (repDayExpiryMs !== null && now >= repDayExpiryMs) {
        let anyExpired = false;
        for (const [, s] of sessionEntries) {
          if (s.status === 'active' || s.status === 'filled' || s.status === 'stopped') {
            s.status = 'expired';
            anyExpired = true;
          }
        }
        if (anyExpired) {
          persistPolls();
          console.log(`[poll] Target day passed for untimed manual poll ${repPollId} ("${repPollState.name || repPollState.when}"): status automatically set to expired.`);
        }
        continue;
      }

      if (sessionEntries.some(([, s]) => s.reminders === false)) continue;

      const groupJid = repPollState.remoteJid;
      if (groupsConfig.isInQuietHours(now, groupJid)) continue;

      const maxReminderCount = Math.max(0, ...sessionEntries.map(([, s]) => s.reminderCount || 0));
      const isAnyAuto = sessionEntries.some(([, s]) => isAutoCreatedPoll(s));
      if (!isAnyAuto && maxReminderCount >= MAX_POLL_REMINDERS) continue;

      const sentReminders = [...new Set(sessionEntries.flatMap(([, s]) => Array.isArray(s.sentReminders) ? s.sentReminders : []))];

      // Handle manual polls with no time specified
      if (repPollState.isManual && (!repPollState.playAt || repPollState.playAt === 'unknown' || !hasTimeSpecifiedInTitle(repPollState))) {
        const reminderInfo = getDayBefore12pmReminderTime(repPollState, new Date(now));
        if (!reminderInfo) continue;

        if (sentReminders.includes('day_before_12pm') || sentReminders.includes('day_before_6pm')) {
          continue;
        }

        const { reminderTimeMs, matchDayStartMs } = reminderInfo;
        if (now < reminderTimeMs || now >= matchDayStartMs) {
          continue;
        }

        if (repPollState.createdAt) {
          const pollAgeMinutes = (now - new Date(repPollState.createdAt).getTime()) / (60 * 1000);
          if (pollAgeMinutes < 15) {
            continue;
          }
        }

        try {
          const sent = await sendPollReminder(sock, repPollId, repPollState, false, context, now);
          if (sent) {
            sentReminders.push('day_before_12pm');
            syncSentRemindersAcrossSession(sessionEntries, sentReminders);
            persistPolls();
          }
        } catch (sendErr) {
          console.error(`[poll] Failed to send day-before reminder for poll ${repPollId}:`, sendErr.message);
        }
        continue;
      }

      if (!repPollState.playAt || repPollState.playAt === 'unknown') continue;

      const playAtMs = new Date(repPollState.playAt).getTime();
      if (Number.isNaN(playAtMs)) continue;
      const diffMs = playAtMs - now;
      if (diffMs <= 0) continue;

      const hoursRemaining = diffMs / (60 * 60 * 1000);

      if (repPollState.createdAt) {
        const pollAgeHours = (now - new Date(repPollState.createdAt).getTime()) / (60 * 60 * 1000);
        if (pollAgeHours < 1.0) {
          continue;
        }
      }

      const targetH = POWERS_OF_2_REMINDER_HOURS.find((h) => hoursRemaining <= h);
      if (!targetH) continue;

      if (!repPollState.isManual && targetH < 2 && maxReminderCount >= 4) {
        continue;
      }

      if (sentReminders.includes(targetH)) continue;

      if (groupsConfig.isQuietHoursWakeUpWindow(now, groupJid)) {
        const hasScheduledWithin1Hour = POWERS_OF_2_REMINDER_HOURS.some((h) =>
          h < targetH && (hoursRemaining - 1.0) <= h && h <= hoursRemaining
        );
        if (hasScheduledWithin1Hour) {
          console.log(`[poll] Bypassing missed reminder (${targetH}h) for poll ${repPollId} after quiet hours because another reminder is scheduled within 1 hour.`);
          for (const h of POWERS_OF_2_REMINDER_HOURS) {
            if (h >= targetH && !sentReminders.includes(h)) {
              sentReminders.push(h);
            }
          }
          syncSentRemindersAcrossSession(sessionEntries, sentReminders);
          persistPolls();
          continue;
        }
      }

      try {
        const sent = await sendPollReminder(sock, repPollId, repPollState, false, context, now);
        if (sent) {
          for (const h of POWERS_OF_2_REMINDER_HOURS) {
            if (h >= targetH && !sentReminders.includes(h)) {
              sentReminders.push(h);
            }
          }

          const updatedCount = repPollState.reminderCount || 0;
          if (!repPollState.isManual && targetH <= 2 && updatedCount >= 4) {
            for (const h of POWERS_OF_2_REMINDER_HOURS) {
              if (h < 2 && !sentReminders.includes(h)) {
                sentReminders.push(h);
              }
            }
            console.log(`[poll] Stopped reminders for bot created poll ${repPollId} after 2h reminder (${updatedCount} reminders sent)`);
          }

          syncSentRemindersAcrossSession(sessionEntries, sentReminders);
          persistPolls();
        }
      } catch (sendErr) {
        console.error(`[poll] Failed to send reminder for poll ${repPollId}:`, sendErr.message);
      }
    }
  } catch (err) {
    console.error(`⚠️ [${new Date().toISOString()}] Error in checkAndSendPollReminders:`, err);
  }
}

module.exports = {
  getCleanLogicalPollName,
  getDayBefore12pmReminderTime,
  getDayBefore6pmReminderTime,
  buildLineupReminderText,
  checkPendingLineupGenerations,
  buildUntimedPollReminderText,
  formatReminderHours,
  buildPollReminder,
  buildPollReminderText,
  sendPollReminder,
  parseTriggerReminderArgs,
  handleTriggerReminder,
  handlePauseReminders,
  handleResumeReminders,
  handleQuietHoursCommand,
  checkAndSendPollReminders
};
