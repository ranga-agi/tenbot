/**
 * Poll Status Formatting, Queries & Inspection
 */

const {
  getAggregateVotesInPollMessage,
  jidNormalizedUser
} = require('@whiskeysockets/baileys');

const { formatScheduleSets } = require('../../matchups');
const pollTime = require('../../pollTime');
const { formatLookAround } = pollTime;

const {
  TRIGGER_PREFIX,
  MAX_POLL_REMINDERS,
  storeKey,
  nameFor,
  capitalize,
  hasTimeSpecifiedInTitle,
  getFirstSlotNumber,
  resolveManualPollPlayers,
  resolveFixedPollRoster,
  resolveMultiTimePollRoster,
  getPollVoters,
  normalizeVotePayload,
  getPollDayWord,
  formatLineupGenDesc,
  isAutoCreatedPoll,
  getPollScheduleId
} = require('./roster');
const { formatCourtLabel } = require('./courts');

function pollStatusText(chatId = null, opts = {}, context) {
  const { activePolls, recurringPolls, messageStore, targetGroupJid } = context;
  const targetId = opts.targetId ? opts.targetId.trim() : null;
  const isDM = Boolean(chatId && !chatId.endsWith('@g.us'));
  let effectiveChatId = isDM ? (targetGroupJid || null) : chatId;
  let isAll = (!effectiveChatId && !targetId) || (!chatId && !targetId);
  const upcomingOnly = opts.upcomingOnly === true;
  const activeOnly = opts.activeOnly === true;
  const recurringOnly = opts.recurringOnly === true;
  const now = Date.now();

  let chatPolls = [...activePolls.entries()];

  let chatRecurring = [];
  if (recurringPolls) {
    if (effectiveChatId) {
      chatRecurring = [...recurringPolls.values()].filter((s) => s.remoteJid === effectiveChatId);
    }
    if (chatRecurring.length === 0 && (isDM || !chatId)) {
      chatRecurring = [...recurringPolls.values()];
    }
  }

  if (targetId) {
    const targetLower = targetId.toLowerCase();
    const isTargetManual = targetLower === 'manual' || targetLower === 'adhoc';
    const isTargetRecurring = targetLower === 'recurring' || targetLower === 'scheduled';

    const matchesPoll = (pollId, state) => {
      if (pollId.toLowerCase() === targetLower) return true;
      const sId = getPollScheduleId(state, recurringPolls);
      if (sId && sId.toLowerCase() === targetLower) return true;
      if (isTargetManual && state.isManual) return true;
      if (isTargetRecurring && (state.isRecurring || Boolean(state.scheduleId))) return true;
      const pName = (state.name || '').toLowerCase();
      const pWhen = (state.when || '').toLowerCase();
      if (pName.includes(targetLower) || pWhen.includes(targetLower)) return true;
      if (state.creator?.name && state.creator.name.toLowerCase().includes(targetLower)) return true;
      return false;
    };

    const matched = chatPolls.filter(([pollId, state]) => {
      if (chatId && chatId.endsWith('@g.us') && state.remoteJid !== chatId) return false;
      return matchesPoll(pollId, state);
    });

    if (matched.length > 0) {
      chatPolls = matched;
    } else {
      const globalMatched = [...activePolls.entries()].filter(([pollId, state]) => matchesPoll(pollId, state));
      if (globalMatched.length > 0) {
        chatPolls = globalMatched;
      } else {
        let targetSched = null;
        if (recurringPolls) {
          for (const [key, sched] of recurringPolls.entries()) {
            const sid = sched.id || sched.scheduleId || key;
            if (key.toLowerCase() === targetLower || sid.toLowerCase() === targetLower) {
              targetSched = sched;
              break;
            }
          }
        }
        if (targetSched) {
          const sid = targetSched.id || targetSched.scheduleId || targetId;
          const daysStr = targetSched.daysDisplay || targetSched.days || 'unspecified days';
          const matchStr = targetSched.matchDisplay || targetSched.matchTime || 'unspecified time';
          const postStr = targetSched.postDisplay || targetSched.postTime || 'unspecified post time';
          const statusStr = targetSched.enabled === false ? 'PAUSED' : (targetSched.status ? targetSched.status.toUpperCase() : 'ACTIVE');
          const isPreBook = targetSched.courtBookingType === 'pre-book' || targetSched.bookingStrategy === 'advanced' || Boolean(targetSched.bookingSchedule);
          const bookingTypeDesc = isPreBook ? 'Pre-book' : 'None';
          return `ℹ️ Recurring schedule \`${sid}\` (${statusStr}) is configured for ${daysStr} at ${matchStr} (posts at ${postStr}, court booking type: ${bookingTypeDesc}), but there is no active poll instance currently on record in active polls.\nUse "!recurringpolls" to inspect all schedules or wait for the next scheduled trigger.`;
        }
        return `⚠️ No active poll instance or recurring schedule found matching "${targetId}". Use "!pollstatus" to view current polls or "!recurringpolls" for schedule IDs.`;
      }
    }
  } else if (!isAll) {
    if (effectiveChatId) {
      const filtered = chatPolls.filter(([, state]) => state.remoteJid === effectiveChatId);
      if (filtered.length > 0) {
        chatPolls = filtered;
      } else if (isDM) {
        isAll = true;
      } else {
        chatPolls = [];
      }
    }
  }

  if (recurringOnly) {
    chatPolls = chatPolls.filter(([, state]) => Boolean(state.scheduleId || state.isRecurring));
  } else if (activeOnly) {
    chatPolls = chatPolls.filter(([, state]) => state.status === 'active' || state.status === 'filled' || state.status === 'stopped');
  } else if (upcomingOnly) {
    chatPolls = chatPolls.filter(([, state]) => {
      if (state.status === 'cancelled') return false;
      if (!state.playAt) return true;
      const playAtMs = new Date(state.playAt).getTime();
      return Number.isNaN(playAtMs) || playAtMs > now;
    });
  }

  let recurringSummary = '';
  if (chatRecurring.length > 0 && !targetId && !activeOnly && !upcomingOnly) {
    const schedLines = chatRecurring.map((s) => {
      const sid = s.id || s.scheduleId;
      const daysStr = s.daysDisplay || s.days || 'everyday';
      const matchStr = s.matchDisplay || s.matchTime || 'unspecified time';
      const postStr = s.postDisplay || s.postTime || 'unspecified post time';
      const statusStr = s.enabled === false ? 'PAUSED' : 'ACTIVE';
      const linkedPolls = [...activePolls.entries()].filter(([, p]) => (p.scheduleId === sid || getPollScheduleId(p, recurringPolls) === sid));
      let instanceDesc = 'no active poll instance right now';
      if (linkedPolls.length > 0) {
        instanceDesc = linkedPolls.map(([id, p]) => `Poll \`${id}\` (${p.when || p.status}) — Status: ${p.status}`).join(', ');
      }
      const isPreBook = s.courtBookingType === 'pre-book' || s.bookingStrategy === 'advanced' || Boolean(s.bookingSchedule);
      const bookingTypeStr = isPreBook ? ', court booking: Pre-book' : '';
      const schedMaxCourts = s.maxCourts || s['max-courts'] || null;
      const maxCourtsStr = schedMaxCourts ? `, max courts: ${schedMaxCourts}` : '';
      return `• \`${sid}\` (${statusStr}): ${daysStr} at ${matchStr} (posts at ${postStr}${bookingTypeStr}${maxCourtsStr})\n  └ Current Instance: ${instanceDesc}`;
    });
    recurringSummary = `\n\n━━━━━━━━━━━━━━━━━━━━━\n🔁 *Recurring Poll Schedules & Created Instances:*\n${schedLines.join('\n')}`;
  }

  if (chatPolls.length === 0) {
    if (activeOnly) {
      return '🎾 No active, filled, or stopped match polls on record.';
    }
    if (upcomingOnly) {
      return '📅 No upcoming match polls on record whose play time has not passed yet.';
    }
    if (recurringOnly) {
      if (chatRecurring.length > 0) {
        return `🔁 No poll instances created from recurring schedules found on record.${recurringSummary}`;
      }
      return '🔁 No recurring poll schedules or instances on record.';
    }
    if (chatRecurring.length > 0) {
      return `No active ad-hoc match polls on record for this chat.${recurringSummary}`;
    }
    return isAll
      ? 'No polls on record in bot storage.'
      : 'No poll on record for this chat -- create one with "' + TRIGGER_PREFIX + ' create a poll".';
  }

  const mePn = jidNormalizedUser(context.botSock?.user?.id || context.botSock?.authState?.creds?.me?.id || '');

  const sections = chatPolls.map(([pollId, pollState]) => {
    const bookedCourts = Array.isArray(pollState.prebookedCourts) ? pollState.prebookedCourts : [];
    const tentativeCourts = Array.isArray(pollState.tentativeCourts) ? pollState.tentativeCourts : [];
    let courtsLine = null;
    if (bookedCourts.length > 0 || tentativeCourts.length > 0) {
      const botCourtNames = new Set([
        ...(pollState.autoBookedCourts || []).map((b) => (b.court || "").toLowerCase().trim()),
        ...(pollState.advanceBookedCourts || []).map((b) => (b.court || "").toLowerCase().trim())
      ]);
      const courtDescs = bookedCourts.map((c) => {
        const cName = formatCourtLabel(typeof c === "string" ? c : c.court || "Court");
        const rawName = typeof c === "string" ? c : c.court || "";
        const isAuto = (c && c.bookingType === "auto") || botCourtNames.has(rawName.toLowerCase().trim());
        if (isAuto) {
          return `${cName} (auto booked)`;
        } else {
          const who = (c && (c.player || c.fullName)) || null;
          return who ? `${cName} (manually booked by ${who})` : `${cName} (manually booked)`;
        }
      });
      for (const tc of tentativeCourts) {
        const cName = formatCourtLabel(typeof tc === "string" ? tc : tc.court || "Court");
        courtDescs.push(`${cName} (tentative)`);
      }
      courtsLine = `Courts: ${courtDescs.join(", ")}`;
    }
    let timeRemainingNote = '';
    if (pollState.playAt) {
      const playAtMs = new Date(pollState.playAt).getTime();
      if (!Number.isNaN(playAtMs)) {
        const diffMs = playAtMs - now;
        if (diffMs > 0) {
          const totalMins = Math.round(diffMs / (60 * 1000));
          const hrs = Math.floor(totalMins / 60);
          const mins = totalMins % 60;
          timeRemainingNote = ` (in ${hrs > 0 ? `${hrs}h ` : ''}${mins}m)`;
        } else {
          timeRemainingNote = ' (play time passed)';
        }
      }
    }
    let playAtLocal = 'unknown';
    if (pollState.playAt && pollState.playAt !== 'unknown') {
      const playDate = new Date(pollState.playAt);
      if (!Number.isNaN(playDate.getTime())) {
        const sjFormatted = new Intl.DateTimeFormat('en-US', {
          timeZone: 'America/Los_Angeles',
          year: 'numeric',
          month: 'numeric',
          day: 'numeric',
          hour: 'numeric',
          minute: '2-digit',
          second: '2-digit',
          timeZoneName: 'short'
        }).format(playDate);
        playAtLocal = `${sjFormatted}${timeRemainingNote}`;
      }
    }

    const groupName = isAll
      ? (context.groupMetadataCache?.get(pollState.remoteJid)?.subject || pollState.remoteJid)
      : null;
    const groupHeader = isAll ? `Chat/Group: ${groupName}\n` : '';
    const remindersStr = Array.isArray(pollState.sentReminders) && pollState.sentReminders.length > 0
      ? pollState.sentReminders.map((h) => h < 1 ? `${Math.round(h * 60)}m` : `${h}h`).join(', ')
      : '(none yet)';
    const isAutoPoll = isAutoCreatedPoll(pollState);
    const stoppedAfter2h = !pollState.isManual && (pollState.reminderCount || 0) >= 4 && (pollState.sentReminders || []).includes(2);
    const countStr = isAutoPoll
      ? `(${pollState.reminderCount || 0} sent${stoppedAfter2h ? ' - stopped after 2h' : ''})`
      : `(${pollState.reminderCount || 0}/${MAX_POLL_REMINDERS} sent)`;
    const isUntimedManual = pollState.isManual && (!pollState.playAt || pollState.playAt === 'unknown' || !hasTimeSpecifiedInTitle(pollState));
    const dayWord = isUntimedManual ? getPollDayWord(pollState) : null;
    let remindersLine;
    if (isUntimedManual) {
      if (!dayWord) {
        remindersLine = "Reminders: Disabled (no match time or day specified)";
      } else if (pollState.reminders === false) {
        remindersLine = "Reminders: PAUSED (scheduled for day before match at 12:00 PM)";
      } else if (Array.isArray(pollState.sentReminders) && (pollState.sentReminders.includes('day_before_12pm') || pollState.sentReminders.includes('day_before_6pm'))) {
        remindersLine = "Reminders: Sent day before match at 12:00 PM";
      } else {
        remindersLine = "Reminders: Scheduled for day before match at 12:00 PM";
      }
    } else {
      remindersLine = pollState.reminders === false
        ? `Reminders: PAUSED (sent so far: [${remindersStr}] ${countStr})`
        : `Sent reminders: [${remindersStr}] ${countStr}`;
    }

    const lineupText = formatScheduleSets(pollState.lastSchedule) || (pollState.manualLineupText ? pollState.manualLineupText.trim() : null);
    const lineupHeader = pollState.manualLineupPosted ? 'Lineup (manual):' : 'Lineup:';
    const lineupLine = lineupText
      ? `${lineupHeader}\n${lineupText.split('\n').map((l) => (l.trim() ? `  ${l}` : '')).join('\n')}`
      : null;

    if (pollState.type === "multi_time" && Array.isArray(pollState.timeSlots)) {
      const { aggregated } = getPollVoters(pollId, pollState, mePn, messageStore);
      const slotRosters = resolveMultiTimePollRoster(pollState, aggregated);
      const noOpt = aggregated.find((o) => /^(no|out|can't play|cannot play|no\s*\/\s*can't play)$/i.test(o.name.trim()));
      const noVoters = noOpt ? noOpt.voters.map((v) => nameFor(v)) : [];

      const slotLines = slotRosters.map((sr) => {
        const capStr = sr.slotLimit ? `${sr.filledCount}/${sr.slotLimit}` : `${sr.filledCount} (unlimited)`;
        const pList = sr.players.length ? sr.players.join(", ") : "(none yet)";
        const preseedNote = sr.preseededPlayers && sr.preseededPlayers.length > 0 ? ` [pre-allocated: ${sr.preseededPlayers.join(", ")}]` : "";
        const waitNote = sr.excessPlayers.length > 0 ? `\n    ⚠️ Waitlist/Excess (${sr.excessPlayers.length}): ${sr.excessPlayers.join(", ")}` : "";
        const skipNote = sr.skippedForOtherSession && sr.skippedForOtherSession.length > 0 ? `\n    ℹ️ Assigned to earlier session: ${sr.skippedForOtherSession.join(", ")}` : "";
        const sLineup = formatScheduleSets(sr.slot.lastSchedule);
        const sLineupNote = sLineup ? `\n    Lineup:\n${sLineup.split("\n").map((l) => (l.trim() ? `      ${l}` : "")).join("\n")}` : "";
        return `  • *${sr.slot.label}* [${sr.slot.status || "active"}] (${capStr}${preseedNote}): ${pList}${waitNote}${skipNote}${sLineupNote}`;
      });

      const voteModeDesc = pollState.multiVote !== false ? "Multiple time slots allowed" : "Single time slot only";
      const sessionModeDesc = pollState.multiSessionMode === "single_session" ? "Single session per player" : "Independent sessions";

      const lines = [
        `${groupHeader}Poll ${pollId}${pollState.when ? ` (${pollState.when})` : ""}: Multi-Time Poll (${pollState.timeSlots.length} time slots).`,
        getPollScheduleId(pollState, recurringPolls) ? `🔁 Recurring Schedule: \`${getPollScheduleId(pollState, recurringPolls)}\` (created as per schedule)` : (pollState.isRecurring ? "🔁 Recurring Schedule: (created as per schedule)" : null),
        `Vote Mode: ${voteModeDesc} | Session Mode: ${sessionModeDesc}`,
        pollState.courtsStrategy ? `Courts Strategy: ${capitalize(pollState.courtsStrategy)}` : (pollState.courtBookingType ? `Court Booking Type: ${pollState.courtBookingType === "pre-book" ? "Pre-book" : pollState.courtBookingType}` : null),
        pollState.maxCourts ? `Max Courts: ${pollState.maxCourts}` : null,
        pollState.bookingCourtPreference ? `Court Preference: [${pollState.bookingCourtPreference.join(", ")}]` : null,
        pollState.lookAround ? `Look Around: ${pollState.lookAroundDisplay || formatLookAround(pollState.lookAround)}` : null,
        pollState.lineupGeneration ? `Lineup Generation: ${formatLineupGenDesc(pollState.lineupGeneration, pollState.lineupLeadTime)}` : null,
        courtsLine,
        `Status: ${pollState.status}`,
        `Play time (earliest): ${playAtLocal}`,
        remindersLine,
        `Time Slots:\n${slotLines.join("\n")}`,
        `No / Can't play (${noVoters.length}): ${noVoters.length ? noVoters.join(", ") : "(none yet)"}`
      ];
      return lines.filter(Boolean).join("\n");
    }

    const isOptIn = pollState.type === 'opt_in' || pollState.size === null || pollState.options?.some((o) => /^yes$/i.test(o.trim()));

    if (isOptIn) {
      let yesVoters = [];
      let noVoters = [];
      try {
        const pollCreationMessage = messageStore.get(storeKey(pollState.remoteJid, pollId));
        if (pollCreationMessage) {
          const merged = [...pollState.voteBuffer.values()].map((u) => ({
            ...u,
            vote: normalizeVotePayload(u.vote)
          }));
          const aggregated = getAggregateVotesInPollMessage({ message: pollCreationMessage, pollUpdates: merged }, mePn);
          const yesOpt = aggregated.find((o) => /^yes$/i.test(o.name.trim()));
          const noOpt = aggregated.find((o) => /^no$/i.test(o.name.trim()));
          yesVoters = yesOpt ? yesOpt.voters.map((v) => nameFor(v)) : [];
          noVoters = noOpt ? noOpt.voters.map((v) => nameFor(v)) : [];
        }
      } catch (e) { }

      const manualDesc = pollState.isManual ? ' (Passively tracked)' : '';
      const lines = [
        `${groupHeader}Poll ${pollId}${pollState.when ? ` (${pollState.when})` : ''}: Opt-in (Yes/No).`,
        getPollScheduleId(pollState, recurringPolls) ? `🔄 Recurring Schedule: \`${getPollScheduleId(pollState, recurringPolls)}\` (created as per schedule)` : (pollState.isRecurring ? '🔄 Recurring Schedule: (created as per schedule)' : null),
        pollState.courtsStrategy ? `Courts Strategy: ${capitalize(pollState.courtsStrategy)}` : (pollState.courtBookingType ? `Court Booking Type: ${pollState.courtBookingType === 'pre-book' ? 'Pre-book' : pollState.courtBookingType}` : null),
        pollState.maxCourts ? `Max Courts: ${pollState.maxCourts}` : null,
        pollState.bookingCourtPreference ? `Court Preference: [${pollState.bookingCourtPreference.join(", ")}]` : null,
        pollState.creator?.name ? `Creator: ${pollState.creator.name}` : null,
        pollState.lookAround ? `Look Around: ${pollState.lookAroundDisplay || formatLookAround(pollState.lookAround)}` : null,
        pollState.slotCheck !== undefined ? `Slot check: ${pollState.slotCheck ? 'Enabled' : 'Disabled'}` : null,
        pollState.lineupGeneration ? `Lineup Generation: ${formatLineupGenDesc(pollState.lineupGeneration, pollState.lineupLeadTime)}` : null,
        courtsLine,
        `Status: ${pollState.status}${manualDesc}`,
        `Play time: ${playAtLocal} ${(!pollState.playAt || pollState.playAt === 'unknown') ? '(kept for 2 weeks after created date)' : '(kept for 2 weeks after scheduled play time)'}`,
        remindersLine,
        `Yes votes (${yesVoters.length}): ${yesVoters.length ? yesVoters.join(', ') : '(none yet)'}`,
        `No votes (${noVoters.length}): ${noVoters.length ? noVoters.join(', ') : '(none yet)'}`,
        lineupLine || 'Matchups: Waiting for user prompt (!matchups or "@tenbot generate matchups")'
      ];
      return lines.filter(Boolean).join('\n');
    }

    if (pollState.isManual) {
      const { aggregated, interestedPlayers } = getPollVoters(pollId, pollState, mePn, messageStore);
      const optionSummaries = aggregated.map((opt) => `${opt.name} (${opt.voters.length}): ${opt.voters.map(nameFor).join(', ') || '(none)'}`);
      const { players: playingPlayers, addedFromLabel, addedFromValidCount } = resolveManualPollPlayers(pollState, interestedPlayers);
      const creatorName = pollState.creator?.name || 'Someone';

      let additionNotes = [];
      if (addedFromLabel.length > 0) additionNotes.push(`${addedFromLabel.join(', ')} from poll slot labels / title`);
      if (addedFromValidCount.length > 0) additionNotes.push(`${addedFromValidCount.join(', ')} to reach valid player count`);
      const additionStr = additionNotes.length > 0 ? ` (includes ${additionNotes.join(' and ')})` : '';

      const lines = [
        `${groupHeader}Poll ${pollId}: User-Created Manual Match Poll "${pollState.name || 'Match Poll'}".`,
        getPollScheduleId(pollState, recurringPolls) ? `🔄 Recurring Schedule: \`${getPollScheduleId(pollState, recurringPolls)}\` (created as per schedule)` : (pollState.isRecurring ? '🔄 Recurring Schedule: (created as per schedule)' : null),
        `Creator: ${creatorName}`,
        pollState.slotCheck !== undefined ? `Slot check: ${pollState.slotCheck ? 'Enabled' : 'Disabled'}` : null,
        pollState.lineupGeneration ? `Lineup Generation: ${formatLineupGenDesc(pollState.lineupGeneration, pollState.lineupLeadTime)}` : null,
        courtsLine,
        `Status: ${pollState.status} (Passively tracked)`,
        `Play time: ${playAtLocal} (when: "${pollState.when || 'unspecified'}")`,
        remindersLine,
        `Total votes buffered: ${pollState.voteBuffer.size}`,
        `Options & Votes:\n  ${optionSummaries.length ? optionSummaries.join('\n  ') : '(none)'}`,
        `Voted so far (${interestedPlayers.length}): ${interestedPlayers.length ? interestedPlayers.join(', ') : '(none yet)'}`,
        `Currently playing (${playingPlayers.length}): ${playingPlayers.join(', ')}${additionStr}`,
        lineupLine || 'Matchups: Passively tracked -- will generate matchups only upon explicit user request (!matchups or "@tenbot generate matchups")'
      ];
      return lines.filter(Boolean).join('\n');
    }

    const { aggregated } = getPollVoters(pollId, pollState, mePn, messageStore);
    const { players: currentPlayers, excessPlayers, filledCount, totalSlotsCount, naturalTotalSlots } = resolveFixedPollRoster(pollState, aggregated);
    const options = pollState.options || [];
    const firstSlotNum = getFirstSlotNumber(options);
    const hasPrebooked = Array.isArray(pollState.prebookedPlayers) && pollState.prebookedPlayers.length > 0;
    const leadingSpots = (firstSlotNum && firstSlotNum > 1) ? (firstSlotNum - 1) : (pollState.creator && !hasPrebooked ? 1 : 0);
    const creatorDesc = leadingSpots > 1
      ? `Creator: ${pollState.creator?.name || 'Creator'} (holding spots 1..${leadingSpots})`
      : (pollState.creator && !hasPrebooked ? `Creator (Player 1): ${pollState.creator.name || 'Player 1'}` : 'Creator: None (all spots open)');

    const prebookedNote = hasPrebooked
      ? ` (pre-booked: ${pollState.prebookedPlayers.map((p) => typeof p === 'string' ? `${p}'s Spot` : p.slotName).join(', ')})`
      : '';

    const limitNote = pollState.slotLimit ? ` (limit: ${pollState.slotLimit} spots, original: ${pollState.originalSize || naturalTotalSlots})` : '';
    const excessLine = (excessPlayers && excessPlayers.length > 0) ? `⚠️ Excess votes not considered (${excessPlayers.length}): ${excessPlayers.join(', ')}` : null;

    const lookAroundNote = pollState.lookAround ? ` (look-around: ${pollState.lookAroundDisplay || formatLookAround(pollState.lookAround)})` : '';
    const lines = [
      `${groupHeader}Poll ${pollId}${pollState.when ? ` (${pollState.when})` : ''}: ${pollState.size} spots (${pollState.size === 2 ? 'Singles' : 'Doubles'})${limitNote}${lookAroundNote}.`,
      getPollScheduleId(pollState, recurringPolls) ? `🔁 Recurring Schedule: \`${getPollScheduleId(pollState, recurringPolls)}\` (created as per schedule)` : (pollState.isRecurring ? '🔁 Recurring Schedule: (created as per schedule)' : null),
      pollState.courtsStrategy ? `Courts Strategy: ${capitalize(pollState.courtsStrategy)}` : (pollState.courtBookingType ? `Court Booking Type: ${pollState.courtBookingType === 'pre-book' ? 'Pre-book' : pollState.courtBookingType}` : null),
      pollState.slotOverride ? `Slot Override: ${pollState.slotOverride === 'opt-in' ? 'Opt-in (Yes/No)' : `${pollState.slotOverride} slots`}` : null,
      pollState.maxCourts ? `Max Courts: ${pollState.maxCourts}` : null,
      pollState.bookingCourtPreference ? `Court Preference: [${pollState.bookingCourtPreference.join(", ")}]` : null,
      creatorDesc,
      pollState.slotCheck !== undefined ? `Slot check: ${pollState.slotCheck ? 'Enabled' : 'Disabled'}` : null,
        pollState.lineupGeneration ? `Lineup Generation: ${formatLineupGenDesc(pollState.lineupGeneration, pollState.lineupLeadTime)}` : null,
      courtsLine,
      `Status: ${pollState.status}`,
      `Play time: ${playAtLocal} ${(!pollState.playAt || pollState.playAt === 'unknown') ? '(kept for 2 weeks after created date)' : '(kept for 2 weeks after scheduled play time)'}`,
      remindersLine,
      `Slots filled: ${filledCount}/${totalSlotsCount}${prebookedNote}`,
      `Currently playing (${currentPlayers.length}): ${currentPlayers.join(', ')}`,
      excessLine,
      lineupLine
    ];
    return lines.filter(Boolean).join('\n');
  });

  return sections.join('\n\n---\n\n') + recurringSummary;
}

module.exports = {
  pollStatusText
};
