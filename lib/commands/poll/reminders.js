/**
 * Poll Reminders, Lead-Time Auto-Lineups & Quiet Hours
 */

const { jidNormalizedUser } = require('@whiskeysockets/baileys');

const ratings = require('../../ratings');
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
  formatMatchHeaderTime
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
  const combinedPlayers = [];
  let sumTotalSlots = 0;

  for (const [sId, sState] of sessionEntries) {
    const { aggregated } = getPollVoters(sId, sState, mePn, messageStore);
    const roster = resolveFixedPollRoster(sState, aggregated);
    sumTotalSlots += roster.totalSlotsCount;

    let partPlayers = roster.players || [];
    if (
      partPlayers.length === 0 &&
      Array.isArray(sState.lastPlayers) &&
      sState.lastPlayers.length > 0 &&
      (sState.status === 'filled' || sState.status === 'resolved')
    ) {
      partPlayers = sState.lastPlayers;
    }

    for (const p of partPlayers) {
      if (!combinedPlayers.some((existing) => ratings.keyFor(existing) === ratings.keyFor(p))) {
        combinedPlayers.push(p);
      }
    }
  }

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
    filledCount,
    totalSpots,
    openSpots
  };
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

function buildPollReminderText(H, pollState, openSpots, totalSpots, playerList, isOptIn = false, yesCount = 0, hoursRemaining = null) {
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
        return `⏰ *${currentH} Hours (${dayStr}) to Go!* We have *${yesCountLabel} response(s) in* so far for *${whenStr}*.\n` +
          `Responses so far: ${playerList}\n` +
          `Don't miss out — cast your vote above to join!`;
      }
      if (effHours >= 16) {
        return `⏰ *${currentH} Hours to Go!* We have *${yesCountLabel} response(s) in* so far for *${whenStr}*.\n` +
          `Responses so far: ${playerList}\n` +
          `Don't miss out — cast your vote above to join!`;
      }
      if (effHours >= 8) {
        return `⏰ *${currentH} Hours to Go!* We currently have *${yesCountLabel} response(s) in* for *${whenStr}*.\n` +
          `Current responses: ${playerList}\n` +
          `Who else is joining? Vote Yes in the poll above! ⚡`;
      }
      if (effHours >= 4) {
        return `🔥 *${currentH} Hours to Go!* *${yesCountLabel} response(s)* in for *${whenStr}*!\n` +
          `Current responses: ${playerList}\n` +
          `Cast your vote above if you want to join!`;
      }
      if (effHours >= 2) {
        return `⚡ *${currentHUpper} HOURS TO GO!* *${yesCountLabel} response(s)* confirmed for *${whenStr}*!\n` +
          `Confirmed: ${playerList}\n` +
          `Vote Yes now before spots are finalized! 🏃‍♂️💨`;
      }
      if (effHours >= 1) {
        const hourWord = roundedHours === 1 ? '1 HOUR LEFT' : (roundedHours === 0.5 ? 'HALF HOUR LEFT' : `${currentHUpper} HOURS LEFT`);
        return `🚨 *FINAL CALL: ${hourWord}!* *${yesCountLabel} response(s) in* for *${whenStr}*!\n` +
          `Current responses: ${playerList}\n` +
          `Last chance to vote Yes! 🏆⚡`;
      }
      return `⚡ *${currentMins} MINUTES REMAINING!* *${yesCountLabel} response(s) in* for *${whenStr}*!\n` +
        `Current responses: ${playerList}\n` +
        `Final countdown to vote Yes! ⚡`;
    }

    if (effHours >= 32) {
      return `📋 *Poll Alert:* The poll for *${whenStr}* still has *${openSpots} open ${spotWord}* (${openSpots}/${totalSpots} needed).\n` +
        `Current responses: ${playerList}\n` +
        `Vote in the poll above to lock in your spot!`;
    }
    if (effHours >= 24) {
      const days = Math.round(effHours / 24);
      const dayStr = days === 1 ? '1 Day' : `${days} Days`;
      return `⏰ *${currentH} Hours (${dayStr}) to Go!* We have *${openSpots} ${spotWord} remaining* for *${whenStr}* (${openSpots}/${totalSpots} needed).\n` +
        `Responses so far: ${playerList}\n` +
        `Don't miss out — cast your vote above to lock in your spot!`;
    }
    if (effHours >= 16) {
      return `⏰ *${currentH} Hours to Go!* We have *${openSpots} ${spotWord} remaining* for *${whenStr}* (${openSpots}/${totalSpots} needed).\n` +
        `Responses so far: ${playerList}\n` +
        `Don't miss out — cast your vote above to lock in your spot!`;
    }
    if (effHours >= 8) {
      return `⏰ *${currentH} Hours to Go!* We still need *${openSpots} more ${playerWord}* for *${whenStr}* (${totalSpots} total spots).\n` +
        `Current responses: ${playerList}\n` +
        `Who else is joining? Claim your spot!`;
    }
    if (effHours >= 4) {
      return `🔥 *${currentH} Hours to Go!* Only *${openSpots} ${spotWord} left* for *${whenStr}*!\n` +
        `Confirmed: ${playerList}\n` +
        `Grab the open ${spotWord} before it fills up! ⚡`;
    }
    if (effHours >= 2) {
      return `⚡ *${currentHUpper} HOURS TO GO!* We only need *${openSpots} more ${playerWord}* for *${whenStr}*!\n` +
        `Confirmed: ${playerList}\n` +
        `Step up and claim the final ${spotWord}! 🏃‍♂️💨`;
    }
    if (effHours >= 1) {
      const hourWord = roundedHours === 1 ? '1 HOUR LEFT' : (roundedHours === 0.5 ? 'HALF HOUR LEFT' : `${currentHUpper} HOURS LEFT`);
      return `🚨 *FINAL CALL: ${hourWord}!* Just *${openSpots} ${spotWord} open* for *${whenStr}*!\n` +
        `Current responses: ${playerList}\n` +
        `Vote now to grab the remaining ${spotWord}! 🔥`;
    }
    return `⚡ *${currentMins} MINUTES TO GO!* Still need *${openSpots} more ${playerWord}* for *${whenStr}*!\n` +
      `Current responses: ${playerList}\n` +
      `Last chance to grab the remaining ${spotWord}! ⚡`;
  }

  if (isOptIn) {
    if (effHours >= 24) {
      const days = Math.round(effHours / 24);
      const dayStr = days === 1 ? '1 Day' : `${days} Days`;
      return `⏰ *${currentH} Hours (${dayStr}) to Playtime!* We have *${yesCountLabel} player(s) in* so far for *${whenStr}*.\n` +
        `Players in: ${playerList}\n` +
        `Don't miss out — cast your vote above to join the match!`;
    }
    if (effHours >= 16) {
      return `⏰ *${currentH} Hours to Playtime!* We have *${yesCountLabel} player(s) in* so far for *${whenStr}*.\n` +
        `Players in: ${playerList}\n` +
        `Don't miss out — cast your vote above to join the match!`;
    }
    if (effHours >= 8) {
      return `🎾 *${currentH} Hours to Match Time!* We currently have *${yesCountLabel} player(s) in* for *${whenStr}*.\n` +
        `Current lineup: ${playerList}\n` +
        `Who else is ready to play? Vote Yes in the poll above! 🎾⚡`;
    }
    if (effHours >= 4) {
      return `🔥 *${currentH} Hours Until Court Time!* *${yesCountLabel} player(s)* lined up for *${whenStr}*!\n` +
        `Roster: ${playerList}\n` +
        `Cast your vote above if you want in on today's session!`;
    }
    if (effHours >= 2) {
      return `⚡ *${currentHUpper} HOURS TO GO!* *${yesCountLabel} player(s)* confirmed for *${whenStr}*!\n` +
        `Ready on court: ${playerList}\n` +
        `Vote Yes now before teams and matchups are drawn! 🎾🏃‍♂️💨`;
    }
    if (effHours >= 1) {
      const hourWord = roundedHours === 1 ? '1 HOUR LEFT' : (roundedHours === 0.5 ? 'HALF HOUR LEFT' : `${currentHUpper} HOURS LEFT`);
      return `🚨 *FINAL CALL: ${hourWord}!* *${yesCountLabel} player(s) in* for *${whenStr}*!\n` +
        `Current roster: ${playerList}\n` +
        `Last chance to vote Yes before match time! 🏆🎾🔥`;
    }
    return `⚡ *${currentMins} MINUTES REMAINING!* *${yesCountLabel} player(s) in* for *${whenStr}*!\n` +
      `Current roster: ${playerList}\n` +
      `Final countdown to vote Yes before matchups are locked in! 🏆🎾⚡`;
  }

  if (effHours >= 32) {
    return `🎾 *Match Alert:* The match poll for *${whenStr}* still has *${openSpots} open ${spotWord}* (${openSpots}/${totalSpots} needed).\n` +
      `Current players: ${playerList}\n` +
      `Vote in the poll above to lock in your spot!`;
  }
  if (effHours >= 24) {
    const days = Math.round(effHours / 24);
    const dayStr = days === 1 ? '1 Day' : `${days} Days`;
    return `⏰ *${currentH} Hours (${dayStr}) to Playtime!* We have *${openSpots} ${spotWord} remaining* for *${whenStr}* (${openSpots}/${totalSpots} needed).\n` +
      `Roster so far: ${playerList}\n` +
      `Don't miss out — cast your vote above to join the court!`;
  }
  if (effHours >= 16) {
    return `⏰ *${currentH} Hours to Playtime!* We have *${openSpots} ${spotWord} remaining* for *${whenStr}* (${openSpots}/${totalSpots} needed).\n` +
      `Roster so far: ${playerList}\n` +
      `Don't miss out — cast your vote above to join the court!`;
  }
  if (effHours >= 8) {
    return `🎾 *${currentH} Hours to Match Time!* We still need *${openSpots} more ${playerWord}* to complete the court for *${whenStr}* (${totalSpots} total spots).\n` +
      `Current lineup: ${playerList}\n` +
      `Who's ready to hit some winners today? Claim your spot!`;
  }
  if (effHours >= 4) {
    return `🔥 *${currentH} Hours Until Court Time!* Only *${openSpots} ${spotWord} left* for *${whenStr}*!\n` +
      `Lined up to play: ${playerList}\n` +
      `Racquets ready? Grab the open ${spotWord} before it fills up! 🎾⚡`;
  }
  if (effHours >= 2) {
    return `⚡ *${currentHUpper} HOURS TO GO!* We only need *${openSpots} more ${playerWord}* to make the match happen at *${whenStr}*!\n` +
      `Ready on court: ${playerList}\n` +
      `Don't leave the squad hanging — step up and claim the final ${spotWord}! 🎾🏃‍♂️💨`;
  }
  if (effHours >= 1) {
    const hourWord = roundedHours === 1 ? '1 HOUR LEFT' : (roundedHours === 0.5 ? 'HALF HOUR LEFT' : `${currentHUpper} HOURS LEFT`);
    return `🚨 *FINAL CALL: ${hourWord}!* Just *${openSpots} ${spotWord} open* for *${whenStr}*!\n` +
      `Current roster: ${playerList}\n` +
      `Who's coming through in the clutch? Vote now and let's play! 🏆🎾🔥`;
  }
  return `⚡ *${currentMins} MINUTES TO GO!* Still need *${openSpots} more ${playerWord}* for *${whenStr}*!\n` +
    `Current lineup: ${playerList}\n` +
    `Last chance to grab the remaining ${spotWord} before match time! 🏆🎾⚡`;
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

  if (baseState.parentPollId && !baseState.isManual && !isOptIn && baseState.type !== "multi_time") {
    const combined = getCombinedFixedSessionRoster(sessionEntries, mePn, context?.messageStore);
    totalSpots = combined.totalSpots;
    openSpots = combined.openSpots;
    players = combined.players;

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
        const optInLimit = (typeof pollState.slotLimit === 'number' && pollState.slotLimit > 0)
          ? pollState.slotLimit
          : ((pollState.type === 'opt_in' && typeof pollState.size === 'number' && pollState.size > 0) ? pollState.size : null);
        if (optInLimit) {
          totalSpots = optInLimit;
          openSpots = Math.max(0, optInLimit - interestedPlayers.length);
          if (openSpots <= 0 && !isManualTrigger) return false;
          yesCount = Math.min(interestedPlayers.length, optInLimit);
          players = interestedPlayers.slice(0, optInLimit);
        } else {
          totalSpots = 0;
          openSpots = 0;
          yesCount = interestedPlayers.length;
          players = [...interestedPlayers];
        }
      } else {
        if (openSpots <= 0 && !isManualTrigger) return false;
        const { players: resolvedPlayers } = resolveManualPollPlayers(pollState, interestedPlayers);
        players = resolvedPlayers;
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
      const optInLimit = (typeof pollState.slotLimit === 'number' && pollState.slotLimit > 0)
        ? pollState.slotLimit
        : ((pollState.type === 'opt_in' && typeof pollState.size === 'number' && pollState.size > 0) ? pollState.size : null);
      if (optInLimit) {
        totalSpots = optInLimit;
        openSpots = Math.max(0, optInLimit - interestedPlayers.length);
        if (openSpots <= 0 && !isManualTrigger) return false;
        yesCount = Math.min(interestedPlayers.length, optInLimit);
        players = interestedPlayers.slice(0, optInLimit);
      } else {
        yesCount = interestedPlayers.length;
        players = [...interestedPlayers];
      }
    } else {
      const { players: resolvedPlayers, filledCount, totalSlotsCount } = resolveFixedPollRoster(pollState, aggregated);
      totalSpots = totalSlotsCount;
      openSpots = Math.max(0, totalSlotsCount - filledCount);

      if (openSpots <= 0 && !isManualTrigger) return false;

      players = resolvedPlayers;
    }
  }

  const playerList = players.length > 0 ? players.join(', ') : 'None yet';
  const displayState = (baseState.parentPollId && !baseState.when && baseState.name)
    ? { ...baseState, name: getCleanLogicalPollName(baseState) }
    : baseState;

  let reminderText;
  if (isUntimedManual) {
    reminderText = buildUntimedPollReminderText(displayState, openSpots, totalSpots, playerList, isOptIn, yesCount);
  } else {
    const targetH = POWERS_OF_2_REMINDER_HOURS.find((h) => hoursRemaining <= h) || (hoursRemaining || 1);
    reminderText = buildPollReminderText(targetH, displayState, openSpots, totalSpots, playerList, isOptIn || displayState.type === "multi_time", yesCount, hoursRemaining);
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
  await sendMessageAndRecord(sock, quotePollState.remoteJid, { text: reminderText }, { quoted: quotedMsg });

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
  buildPollReminderText,
  sendPollReminder,
  parseTriggerReminderArgs,
  handleTriggerReminder,
  handlePauseReminders,
  handleResumeReminders,
  handleQuietHoursCommand,
  checkAndSendPollReminders
};
