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
  pollTitleIndicatesGame,
  isAutoCreatedPoll,
  findSpecificPoll,
  formatMatchHeaderTime
} = require('./roster');
const { getPrebookedCourtsForPoll } = require('./courts');

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
              const slotHeader = `📅 ${slot.dayDisplay ? `${slot.dayDisplay} ${slot.timeDisplay}` : slot.label}\n\n`;
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

    if (!pollState.playAt || pollState.playAt === "unknown") continue;

    const playAtMs = new Date(pollState.playAt).getTime();
    if (Number.isNaN(playAtMs)) continue;
    if (now >= playAtMs) continue;

    const leadTimeMins = typeof pollState.lineupLeadTime === "number" && pollState.lineupLeadTime > 0
      ? pollState.lineupLeadTime
      : 30;
    const deadlineMs = playAtMs - (leadTimeMins * 60 * 1000);

    if (now < deadlineMs) continue;

    const mode = pollState.lineupGeneration || (pollState.noMatchups ? "none" : "filled");

    if (mode === "fallback") {
      // 1. Fallback mode: auto-generate matchups at lead time if poll is filled and no manual lineup was posted
      if (pollState.status !== "filled" || pollState.manualLineupPosted) continue;

      console.log(`[poll] Lineup generation deadline reached for filled poll ${pollId} (${leadTimeMins}m before play time). No manual lineup posted. Generating lineups...`);

      const mePn = jidNormalizedUser(sock?.user?.id || sock?.authState?.creds?.me?.id || "");
      const { aggregated, interestedPlayers } = getPollVoters(pollId, pollState, mePn, messageStore);

      let players = [];
      if (pollState.type === "opt_in" || pollState.options?.some((o) => /^yes$/i.test(o))) {
        const yesOption = aggregated.find((o) => /^yes$/i.test(o.name.trim()));
        players = yesOption ? yesOption.voters.map(nameFor) : interestedPlayers;
      } else if (pollState.isManual) {
        players = resolveManualPollPlayers(pollState, interestedPlayers).players;
      } else {
        players = resolveFixedPollRoster(pollState, aggregated).players;
      }

      if ((!isValidPlayerCount(players.length) || players.length === 0) && Array.isArray(pollState.lastPlayers) && isValidPlayerCount(pollState.lastPlayers.length)) {
        players = pollState.lastPlayers;
      }

      if (isValidPlayerCount(players.length)) {
        pollState.status = "resolved";
        pollState.lastPlayers = players;
        if (persistPolls) persistPolls();

        try {
          await ratings.ensureRated(players);
          const prebookedCourts = await getPrebookedCourtsForPoll(pollState, pollState.remoteJid);
          const schedule = generateMatchups(players, { prebookedCourts, chatId: pollState.remoteJid });
          const whenHeader = formatMatchHeaderTime(pollState);
          const header = whenHeader ? `📅 ${whenHeader}\n\n` : "";
          await sendMessageAndRecord(sock, pollState.remoteJid, { text: header + formatMatchups(schedule) });
          pairHistory.recordDraw(pollId, schedule, Date.now(), pollState.remoteJid);
          const playAtMs = pollState?.playAt ? new Date(pollState.playAt).getTime() : Date.now();
          playerActivity.recordPlayed(players, playAtMs, pollState.remoteJid);
          pollState.lastSchedule = summarizeSchedule(schedule);
          pollState.lineupReminderSent = true;
          if (persistPolls) persistPolls();
          generatedPollIds.push(pollId);
          console.log(`[poll] Successfully auto-generated and posted lineups for poll ${pollId}`);
        } catch (err) {
          console.error(`[poll] Error auto-generating lineups for poll ${pollId}:`, err.message);
        }
      } else {
        console.warn(`[poll] Poll ${pollId} filled count (${players.length}) is not a valid player count for standard matchups`);
      }
    } else {
      // 2. Non-fallback mode (filled/none): send a reminder message to the group with the lineup at lead time
      if (pollState.lineupReminderSent || pollState.reminders === false) continue;

      const isLineupAvailable =
        (mode === "filled" && Boolean(pollState.lastSchedule)) ||
        (mode === "none" && Boolean(pollState.manualLineupPosted && pollState.lastSchedule));

      if (!isLineupAvailable) continue;

      console.log(`[poll] Sending lineup reminder for poll ${pollId} (${leadTimeMins}m before play time) in ${pollState.remoteJid}`);
      const reminderText = buildLineupReminderText(pollState);
      const quotedMsg = pollState.pollMsgKey ? { key: pollState.pollMsgKey } : undefined;

      try {
        await sendMessageAndRecord(sock, pollState.remoteJid, { text: reminderText }, { quoted: quotedMsg });
        pollState.lineupReminderSent = true;
        if (persistPolls) persistPolls();
        remindedPollIds.push(pollId);
        console.log(`[poll] Successfully sent lineup reminder for poll ${pollId}`);
      } catch (err) {
        console.error(`[poll] Error sending lineup reminder for poll ${pollId}:`, err.message);
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

  if (isNeutral) {
    if (isOptIn) {
      return `⏰ *Poll Reminder for Tomorrow!* We currently have *${yesCount} response(s) in* for tomorrow.\n` +
        `Current responses: ${playerList}\n` +
        `Vote Yes in the poll above if you are planning to join! ⚡`;
    }
    return `⏰ *Poll Reminder for Tomorrow!* The poll for tomorrow still has *${openSpots} open ${spotWord}* (${openSpots}/${totalSpots} needed).\n` +
      `Current responses: ${playerList}\n` +
      `Vote in the poll above to lock in your spot!`;
  }

  if (isOptIn) {
    return `🎾 *Match Alert for Tomorrow!* We currently have *${yesCount} player(s) in* for tomorrow's match.\n` +
      `Current lineup: ${playerList}\n` +
      `Who else is ready to play? Vote Yes in the poll above! 🎾⚡`;
  }

  return `🎾 *Match Alert for Tomorrow!* The match poll for tomorrow still has *${openSpots} open ${spotWord}* (${openSpots}/${totalSpots} needed).\n` +
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
  const whenStr = pollState.when ? pollState.when : (pollState.name || 'today');
  const spotWord = openSpots === 1 ? 'spot' : 'spots';
  const playerWord = openSpots === 1 ? 'player' : 'players';

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
        return `⏰ *${currentH} Hours (${dayStr}) to Go!* We have *${yesCount} response(s) in* so far for *${whenStr}*.\n` +
          `Responses so far: ${playerList}\n` +
          `Don't miss out — cast your vote above to join!`;
      }
      if (effHours >= 16) {
        return `⏰ *${currentH} Hours to Go!* We have *${yesCount} response(s) in* so far for *${whenStr}*.\n` +
          `Responses so far: ${playerList}\n` +
          `Don't miss out — cast your vote above to join!`;
      }
      if (effHours >= 8) {
        return `⏰ *${currentH} Hours to Go!* We currently have *${yesCount} response(s) in* for *${whenStr}*.\n` +
          `Current responses: ${playerList}\n` +
          `Who else is joining? Vote Yes in the poll above! ⚡`;
      }
      if (effHours >= 4) {
        return `🔥 *${currentH} Hours to Go!* *${yesCount} response(s)* in for *${whenStr}*!\n` +
          `Current responses: ${playerList}\n` +
          `Cast your vote above if you want to join!`;
      }
      if (effHours >= 2) {
        return `⚡ *${currentHUpper} HOURS TO GO!* *${yesCount} response(s)* confirmed for *${whenStr}*!\n` +
          `Confirmed: ${playerList}\n` +
          `Vote Yes now before spots are finalized! 🏃‍♂️💨`;
      }
      if (effHours >= 1) {
        const hourWord = roundedHours === 1 ? '1 HOUR LEFT' : (roundedHours === 0.5 ? 'HALF HOUR LEFT' : `${currentHUpper} HOURS LEFT`);
        return `🚨 *FINAL CALL: ${hourWord}!* *${yesCount} response(s) in* for *${whenStr}*!\n` +
          `Current responses: ${playerList}\n` +
          `Last chance to vote Yes! 🏆⚡`;
      }
      return `⚡ *${currentMins} MINUTES REMAINING!* *${yesCount} response(s) in* for *${whenStr}*!\n` +
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
      return `⏰ *${currentH} Hours (${dayStr}) to Playtime!* We have *${yesCount} player(s) in* so far for *${whenStr}*.\n` +
        `Players in: ${playerList}\n` +
        `Don't miss out — cast your vote above to join the match!`;
    }
    if (effHours >= 16) {
      return `⏰ *${currentH} Hours to Playtime!* We have *${yesCount} player(s) in* so far for *${whenStr}*.\n` +
        `Players in: ${playerList}\n` +
        `Don't miss out — cast your vote above to join the match!`;
    }
    if (effHours >= 8) {
      return `🎾 *${currentH} Hours to Match Time!* We currently have *${yesCount} player(s) in* for *${whenStr}*.\n` +
        `Current lineup: ${playerList}\n` +
        `Who else is ready to play? Vote Yes in the poll above! 🎾⚡`;
    }
    if (effHours >= 4) {
      return `🔥 *${currentH} Hours Until Court Time!* *${yesCount} player(s)* lined up for *${whenStr}*!\n` +
        `Roster: ${playerList}\n` +
        `Cast your vote above if you want in on today's session!`;
    }
    if (effHours >= 2) {
      return `⚡ *${currentHUpper} HOURS TO GO!* *${yesCount} player(s)* confirmed for *${whenStr}*!\n` +
        `Ready on court: ${playerList}\n` +
        `Vote Yes now before teams and matchups are drawn! 🎾🏃‍♂️💨`;
    }
    if (effHours >= 1) {
      const hourWord = roundedHours === 1 ? '1 HOUR LEFT' : (roundedHours === 0.5 ? 'HALF HOUR LEFT' : `${currentHUpper} HOURS LEFT`);
      return `🚨 *FINAL CALL: ${hourWord}!* *${yesCount} player(s) in* for *${whenStr}*!\n` +
        `Current roster: ${playerList}\n` +
        `Last chance to vote Yes before match time! 🏆🎾🔥`;
    }
    return `⚡ *${currentMins} MINUTES REMAINING!* *${yesCount} player(s) in* for *${whenStr}*!\n` +
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
  if (!sock || !pollState || pollState.status !== 'active') return false;
  const isUntimedManual = pollState.isManual && (!pollState.playAt || pollState.playAt === 'unknown' || !hasTimeSpecifiedInTitle(pollState));
  const dayWord = isUntimedManual ? getPollDayWord(pollState) : null;

  // Do not send reminders for manual polls with no time and no day specified
  if (isUntimedManual && !dayWord) {
    return false;
  }

  const currentNow = now || Date.now();
  const mePn = jidNormalizedUser(sock.user?.id || sock.authState?.creds?.me?.id || '');

  let hoursRemaining = 0;
  if (pollState.playAt) {
    const playAtMs = new Date(pollState.playAt).getTime();
    if (!Number.isNaN(playAtMs)) {
      hoursRemaining = Math.max(0, (playAtMs - currentNow) / (60 * 60 * 1000));
    }
  }

  const isOptIn = pollState.type === 'opt_in' || pollState.options?.some((o) => /^yes$/i.test(o));

  let totalSpots = 0;
  let neededVotes = 0;
  let openSpots = 0;
  let yesCount = 0;

  const { interestedPlayers, aggregated } = getPollVoters(pollId, pollState, mePn, context.messageStore);
  let players = [];

  if (pollState.isManual) {
    const options = pollState.options || [];
    const firstSlotNum = getFirstSlotNumber(options);
    const leadingCreatorSpots = (firstSlotNum && firstSlotNum > 1) ? (firstSlotNum - 1) : 0;
    neededVotes = options.length > 0 ? options.length : (pollState.size || 4);
    totalSpots = leadingCreatorSpots + neededVotes;

    const filledVotes = aggregated && aggregated.length > 0
      ? aggregated.filter((o) => o.voters.length > 0).length
      : (interestedPlayers ? interestedPlayers.length : (pollState.voteBuffer ? pollState.voteBuffer.size : 0));
    openSpots = Math.max(0, neededVotes - filledVotes);

    if (isOptIn) {
      yesCount = interestedPlayers.length;
      players = [...interestedPlayers];
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
    yesCount = interestedPlayers.length;
    players = [...interestedPlayers];
  } else {
    const { players: resolvedPlayers, filledCount, totalSlotsCount } = resolveFixedPollRoster(pollState, aggregated);
    totalSpots = totalSlotsCount;
    openSpots = Math.max(0, totalSlotsCount - filledCount);
    neededVotes = totalSlotsCount;

    if (openSpots <= 0 && !isManualTrigger) return false;

    players = resolvedPlayers;
  }

  const playerList = players.length > 0 ? players.join(', ') : 'None yet';

  let reminderText;
  if (isUntimedManual) {
    reminderText = buildUntimedPollReminderText(pollState, openSpots, totalSpots, playerList, isOptIn, yesCount);
  } else {
    const targetH = POWERS_OF_2_REMINDER_HOURS.find((h) => hoursRemaining <= h) || (hoursRemaining || 1);
    reminderText = buildPollReminderText(targetH, pollState, openSpots, totalSpots, playerList, isOptIn || pollState.type === "multi_time", yesCount, hoursRemaining);
  }

  const storedMessage = context.messageStore ? context.messageStore.get(storeKey(pollState.remoteJid, pollId)) : null;
  const fromMe = !pollState.isManual;
  const participant = pollState.creator?.jid;

  const quotedMsg = {
    key: {
      remoteJid: pollState.remoteJid,
      id: pollId,
      fromMe: Boolean(fromMe),
      ...(participant ? { participant } : {})
    },
    ...(storedMessage ? { message: storedMessage } : {})
  };

  console.log(`[poll] Sending reminder for poll ${pollId} ("${pollState.name || pollState.when}") in ${pollState.remoteJid} (replying to poll message)`);
  await sendMessageAndRecord(sock, pollState.remoteJid, { text: reminderText }, { quoted: quotedMsg });

  pollState.reminderCount = (pollState.reminderCount || 0) + 1;
  if (context.persistPolls) context.persistPolls();
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
    if (pollState.status === 'active') {
      const isUntimedManual = pollState.isManual && (!pollState.playAt || pollState.playAt === 'unknown' || !hasTimeSpecifiedInTitle(pollState));
      const dayWord = isUntimedManual ? getPollDayWord(pollState) : null;
      if (isUntimedManual && !dayWord) {
        return `⚠️ Reminders cannot be sent for poll "${pollState.name || specificPollId}": no match time or day was specified.`;
      }
      targetPolls.push([pollId, pollState]);
    } else {
      return `⚠️ Poll "${pollState.name || pollState.when || pollId}" has status "${pollState.status}" (reminders can only be triggered for active polls).`;
    }
  } else {
    for (const [id, state] of activePolls.entries()) {
      const matchesChat = effectiveChatId ? (state.remoteJid === effectiveChatId) : true;
      if (matchesChat && state.status === 'active') {
        const isUntimedManual = state.isManual && (!state.playAt || state.playAt === 'unknown' || !hasTimeSpecifiedInTitle(state));
        const dayWord = isUntimedManual ? getPollDayWord(state) : null;
        if (isUntimedManual && !dayWord) {
          continue;
        }
        targetPolls.push([id, state]);
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
      const sent = await sendPollReminder(sock, id, state, true, context);
      if (sent) sentCount++;
    } catch (err) {
      console.error(`[poll] Failed to send manual reminder for poll ${id}:`, err.message);
    }
  }

  console.log(`[reminders] Manual reminder triggered for ${sentCount}/${targetPolls.length} poll(s) in ${chatId} by ${sender}${isForce ? " (forced: quiet hours bypassed)" : ""}`);

  const names = targetPolls.map(([, state]) => `"${state.name || state.when || 'Match Poll'}"`);
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
    const pollName = pollState.name || pollState.when || pollId;

    if (pollState.status === 'resolved') {
      return `ℹ️ Poll "${pollName}" has already been resolved and drawn (reminders are not active).`;
    }
    if (pollState.status === 'expired') {
      return `ℹ️ Poll "${pollName}" has expired (scheduled match play time has passed).`;
    }
    if (pollState.status === 'cancelled') {
      return `ℹ️ Poll "${pollName}" was cancelled.`;
    }
    if (pollState.reminders === false) {
      return `⏸️ Reminders for "${pollName}" are already paused. Use "!resumereminders" to resume them anytime.`;
    }

    pollState.reminders = false;
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
  for (const [id, state] of targetPolls) {
    state.reminders = false;
    names.push(`"${state.name || state.when || id}"`);
  }
  persistPolls();

  console.log(`[reminders] Reminders paused for ${targetPolls.length} poll(s) in ${chatId} by ${sender}`);
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
    const pollName = pollState.name || pollState.when || pollId;

    if (pollState.status === 'resolved') {
      return `ℹ️ Poll "${pollName}" has already been resolved and drawn.`;
    }
    if (pollState.status === 'expired') {
      return `ℹ️ Poll "${pollName}" has expired (scheduled match play time has passed).`;
    }
    if (pollState.status === 'cancelled') {
      return `ℹ️ Poll "${pollName}" was cancelled.`;
    }
    if (pollState.reminders !== false) {
      return `▶️ Reminders for "${pollName}" are already active.`;
    }

    pollState.reminders = true;
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
  for (const [id, state] of targetPolls) {
    state.reminders = true;
    names.push(`"${state.name || state.when || id}"`);
  }
  persistPolls();

  console.log(`[reminders] Reminders resumed for ${targetPolls.length} poll(s) in ${chatId} by ${sender}`);
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
  try {
    for (const [pollId, pollState] of activePolls.entries()) {
      if (pollState.status !== 'active') continue;
      if (pollState.reminders === false) continue;
      const groupJid = pollState.remoteJid;
      if (groupsConfig.isInQuietHours(now, groupJid)) continue;
      if (!isAutoCreatedPoll(pollState) && (pollState.reminderCount || 0) >= MAX_POLL_REMINDERS) continue;
      // Handle manual polls with no time specified
      if (pollState.isManual && (!pollState.playAt || pollState.playAt === 'unknown' || !hasTimeSpecifiedInTitle(pollState))) {
        const reminderInfo = getDayBefore12pmReminderTime(pollState, new Date(now));
        if (!reminderInfo) continue;

        if (Array.isArray(pollState.sentReminders) && (pollState.sentReminders.includes('day_before_12pm') || pollState.sentReminders.includes('day_before_6pm'))) {
          continue;
        }

        const { reminderTimeMs, matchDayStartMs } = reminderInfo;
        if (now < reminderTimeMs || now >= matchDayStartMs) {
          continue;
        }

        if (pollState.createdAt) {
          const pollAgeMinutes = (now - new Date(pollState.createdAt).getTime()) / (60 * 1000);
          if (pollAgeMinutes < 15) {
            continue;
          }
        }

        try {
          const sent = await sendPollReminder(sock, pollId, pollState, false, context, now);
          if (sent) {
            if (!Array.isArray(pollState.sentReminders)) pollState.sentReminders = [];
            pollState.sentReminders.push('day_before_12pm');
            persistPolls();
          }
        } catch (sendErr) {
          console.error(`[poll] Failed to send day-before reminder for poll ${pollId}:`, sendErr.message);
        }
        continue;
      }

      if (!pollState.playAt || pollState.playAt === 'unknown') continue;

      const playAtMs = new Date(pollState.playAt).getTime();
      if (Number.isNaN(playAtMs)) continue;
      const diffMs = playAtMs - now;
      if (diffMs <= 0) {
        if (pollState.status === 'active' || pollState.status === 'filled' || pollState.status === 'stopped') {
          pollState.status = 'expired';
          persistPolls();
          console.log(`[poll] Match play time passed for poll ${pollId}: status automatically set to expired.`);
        }
        continue;
      }

      const hoursRemaining = diffMs / (60 * 60 * 1000);

      if (pollState.createdAt) {
        const pollAgeHours = (now - new Date(pollState.createdAt).getTime()) / (60 * 60 * 1000);
        if (pollAgeHours < 1.0) {
          continue;
        }
      }

      const targetH = POWERS_OF_2_REMINDER_HOURS.find((h) => hoursRemaining <= h);
      if (!targetH) continue;

      if (!pollState.isManual && targetH < 2 && (pollState.reminderCount || 0) >= 4) {
        continue;
      }

      if (!Array.isArray(pollState.sentReminders)) {
        pollState.sentReminders = [];
      }

      if (pollState.sentReminders.includes(targetH)) continue;

      if (groupsConfig.isQuietHoursWakeUpWindow(now, groupJid)) {
        const hasScheduledWithin1Hour = POWERS_OF_2_REMINDER_HOURS.some((h) =>
          h < targetH && (hoursRemaining - 1.0) <= h && h <= hoursRemaining
        );
        if (hasScheduledWithin1Hour) {
          console.log(`[poll] Bypassing missed reminder (${targetH}h) for poll ${pollId} after quiet hours because another reminder is scheduled within 1 hour.`);
          for (const h of POWERS_OF_2_REMINDER_HOURS) {
            if (h >= targetH && !pollState.sentReminders.includes(h)) {
              pollState.sentReminders.push(h);
            }
          }
          persistPolls();
          continue;
        }
      }

      try {
        const sent = await sendPollReminder(sock, pollId, pollState, false, context, now);
        if (sent) {
          for (const h of POWERS_OF_2_REMINDER_HOURS) {
            if (h >= targetH && !pollState.sentReminders.includes(h)) {
              pollState.sentReminders.push(h);
            }
          }

          if (!pollState.isManual && targetH <= 2 && (pollState.reminderCount || 0) >= 4) {
            for (const h of POWERS_OF_2_REMINDER_HOURS) {
              if (h < 2 && !pollState.sentReminders.includes(h)) {
                pollState.sentReminders.push(h);
              }
            }
            console.log(`[poll] Stopped reminders for bot created poll ${pollId} after 2h reminder (${pollState.reminderCount} reminders sent)`);
          }

          persistPolls();
        }
      } catch (sendErr) {
        console.error(`[poll] Failed to send reminder for poll ${pollId}:`, sendErr.message);
      }
    }
  } catch (err) {
    console.error(`⚠️ [${new Date().toISOString()}] Error in checkAndSendPollReminders:`, err);
  }
}

module.exports = {
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
