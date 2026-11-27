/**
 * Match Poll Commands & Lifecycle Management
 * Main dispatcher (handlePollCommand, executePollTool) & unified module exports.
 */

const { sendMessageAndRecord } = require('../../botMessage');
const groupsConfig = require('../../groupsConfig');
const { isUserAdmin, isSameUser, getTargetGroupJid, resolveTargetChat, extractGroupFlag } = require('../groupCommands');
const { migratePollMatchupOptions } = require('../../pollStore');
const { normalizeCommandDashes } = require('../../textNormalize');
const {
  parseBookingDuration,
  VALID_POLL_OPTION_LIMITS,
  DEFAULT_MAX_OPTIONS_PER_POLL,
  parseMaxOptionsPerPoll,
  normalizeMaxOptionsPerPoll,
  formatInvalidMaxOptionsError
} = require('../../pollTime');

const roster = require('./roster');
const creation = require('./creation');
const courts = require('./courts');
const voting = require('./voting');
const reminders = require('./reminders');
const lifecycle = require('./lifecycle');
const slots = require('./slots');
const status = require('./status');
const matchups = require('./matchups');

const {
  nameFor,
  hasSimulationPrefix,
  hasTimeSpecifiedInTitle,
  isMatchSchedulingPoll,
  interpretManualPollWithLLM,
  isValidPlayerCount,
  getNextValidPlayerCount,
  partitionMatchSlots,
  getFirstSlotNumber,
  addNextCreatorPlayer,
  extractNamedPlayersFromTitle,
  resolveManualPollPlayers,
  resolveFixedPollRoster,
  resolveMultiTimePollRoster,
  getPollVoters,
  isUserInPoll,
  normalizeVotePayload,
  deletePollFromWhatsApp,
  getPollDayWord,
  getUntimedPollDayExpiryMs,
  pollTitleIndicatesGame,
  formatLineupGenDesc,
  shouldAutoGenerateLineupOnFill,
  isAutoCreatedPoll,
  findSpecificPoll,
  getPollScheduleId,
  formatMatchHeaderTime,
  getVoteTimestamp,
  getVoteArrivalIndex,
  getSlotNumberForOption,
  checkAndNotifyInvalidSlotVotes,
  SIMULATION_PREFIX
} = roster;

const {
  extractPollCreationPostTime,
  isPostTimeInFuture,
  parsePollCreationText,
  handleDirectPollCreation,
  formatSimulationPollSummary,
  createMultiTimePoll,
  createMatchPoll,
  handleSimulatePoll
} = creation;

const {
  releaseAllCourtsForPollState,
  parseReleaseCourtsArgs,
  parseBookPollCourtsArgs,
  handleReleasePollCourts,
  handleBookPollCourts,
  getPrebookedCourtsForPoll,
  checkCourtReleasesForPoll,
  checkCourtReleases,
  preBookCourtsForMatch,
  normalizeCourtPreference,
  getCourtPreferenceRank,
  sortCourtsByPreference,
  formatCourtLabel,
  formatCourtBookingTitleLine,
  formatCourtAvailableTitleLine,
  formatCourtTentativeTitleLine,
  handleOnDemandCourtBooking
} = courts;

const {
  getMessageSecret,
  safeDecryptPollVote,
  checkAndNotifySlotConflicts,
  pendingPollVotes,
  bufferPendingVote,
  flushPendingPollVotes,
  processPollVoteEvent
} = voting;

const {
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
} = reminders;

const {
  handlePollDeleted,
  cancelOrDeletePoll,
  handleDeleteAllPolls,
  handleClearAllPolls,
  cleanupExpiredPolls,
  handleStopPoll,
  handleResumePoll,
  findTargetPollToCancel
} = lifecycle;

const {
  parseModifyInstanceCommand,
  handleModifyPollInstance,
  handleSetPollSlots
} = slots;

const { pollStatusText } = status;
const { extractFixedPairsFromText, generateMatchupsFromPoll } = matchups;

/**
 * Handles text commands for poll management:
 * !stoppoll, !resumepoll, !cancelpoll, !rematch, !matchups, !draw,
 * !pollstatus, !activepolls, !upcomingpolls, !allpolls, !cleanuppolls,
 * !clearallpolls, !pausereminder, !resumereminder, !sendreminder,
 * !setslots, !modifyinstance
 */
async function handlePollCommand(sock, rawText, chatId, sender, senderJid, msg, context) {
  const text = normalizeCommandDashes(rawText);
  const { groupQuery, remainingText: cleanText } = extractGroupFlag(text);
  const lower = cleanText.toLowerCase();
  const { activePolls, latestPollIdByChat, persistPolls, targetGroupJid } = context;

  let targetChatId = chatId;
  if (groupQuery) {
    const isReadOnly = lower === '!pollstatus' || lower.startsWith('!pollstatus ') || lower.startsWith('!pollstatus:') ||
      lower === '!activepolls' || lower === '!activepollstatus' || lower === '!active' ||
      lower === '!upcomingpolls' || lower === '!upcomingpollstatus' || lower === '!upcoming' ||
      lower === '!allpolls' || lower === '!allpollstatus' ||
      lower === '!matchups' || lower.startsWith('!matchups ') ||
      lower === '!draw' || lower.startsWith('!draw ') ||
      lower === '!rematch' || lower.startsWith('!rematch ');

    const targetRes = await resolveTargetChat(sock, chatId, senderJid, groupQuery, context, { requireAdmin: !isReadOnly, actionDesc: 'manage polls' });
    if (targetRes?.error) return targetRes.error;
    targetChatId = targetRes.targetChatId;
  }

  // Poll control (!stoppoll, !closepoll, !resumepoll, !reopenpoll)
  if (lower.startsWith('!stoppoll') || lower.startsWith('!closepoll') || lower === '!stop' || lower === '!close') {
    const parts = cleanText.split(/\s+/);
    const specificPollId = parts.length > 1 ? parts[1].trim() : null;
    return await handleStopPoll(sock, targetChatId, sender, senderJid, specificPollId, context);
  }

  if (lower.startsWith('!resumepoll') || lower.startsWith('!reopenpoll') || lower === '!resume' || lower === '!reopen') {
    const parts = cleanText.split(/\s+/);
    const specificPollId = parts.length > 1 ? parts[1].trim() : null;
    return await handleResumePoll(sock, targetChatId, sender, senderJid, specificPollId, context);
  }

  // Reminders control (!pausereminder, !resumereminder, !sendreminder)
  if (lower.startsWith('!pausereminder') || lower.startsWith('!pausereminders') || lower === '!silencereminders') {
    const parts = cleanText.split(/\s+/);
    const specificPollId = parts.length > 1 ? parts[1].trim() : null;
    return await handlePauseReminders(sock, targetChatId, sender, specificPollId, context);
  }

  if (lower.startsWith('!resumereminder') || lower.startsWith('!resumereminders') || lower.startsWith('!unpausereminder') || lower.startsWith('!unpausereminders')) {
    const parts = cleanText.split(/\s+/);
    const specificPollId = parts.length > 1 ? parts[1].trim() : null;
    return await handleResumeReminders(sock, targetChatId, sender, specificPollId, context);
  }

  if (
    lower === '!remind' || lower.startsWith('!remind ') ||
    lower.startsWith('!sendreminder') || lower.startsWith('!remindpoll') ||
    lower === '!sendreminders' || lower.startsWith('!sendreminders ') ||
    lower === '!triggerreminder' || lower.startsWith('!triggerreminder ') ||
    lower === '!forceremind' || lower.startsWith('!forceremind ') ||
    lower === '!forcereminder' || lower.startsWith('!forcereminder ') ||
    lower === '!remindforce' || lower.startsWith('!remindforce ') ||
    lower === '!sendreminderforce' || lower.startsWith('!sendreminderforce ')
  ) {
    const { isForce, specificPollId } = parseTriggerReminderArgs(cleanText);
    return await handleTriggerReminder(sock, chatId, sender, specificPollId, context, isForce, Date.now(), groupQuery ? targetChatId : null);
  }

  // Quiet hours (!quiethours, !quiettime, !reminderquiethours, !setquiethours, !setquiettime)
  if (
    lower === '!quiethours' || lower.startsWith('!quiethours ') ||
    lower === '!quiettime' || lower.startsWith('!quiettime ') ||
    lower === '!reminderquiethours' || lower.startsWith('!reminderquiethours ') ||
    lower === '!setquiethours' || lower.startsWith('!setquiethours ') ||
    lower === '!setquiettime' || lower.startsWith('!setquiettime ')
  ) {
    return await handleQuietHoursCommand(sock, chatId, sender, senderJid, text, context);
  }

  // Clear / delete polls (!clearallpolls, !cancelpoll, !deletepoll)
  if (lower === '!clearallpolls' || lower === '!clearpolls') {
    return await handleClearAllPolls(sock, targetChatId, senderJid, context);
  }

  if (lower === '!cancelpoll' || lower === '!deletepoll' || lower.startsWith('!cancelpoll ') || lower.startsWith('!deletepoll ')) {
    let targetPollId = null;
    const parts = cleanText.split(/\s+/);
    const specificPollId = parts.length > 1 && !parts[1].startsWith('@') && !parts[1].startsWith('-') ? parts[1].trim() : null;
    if (specificPollId && activePolls.has(specificPollId)) {
      targetPollId = specificPollId;
    } else {
      targetPollId = findTargetPollToCancel(activePolls, targetChatId, senderJid, sender);
      if (!targetPollId) {
        targetPollId = latestPollIdByChat.get(targetChatId);
      }
    }
    if (!targetPollId || !activePolls.has(targetPollId)) return 'No active poll to cancel.';

    const targetPollState = activePolls.get(targetPollId);
    const effectivePollChat = targetPollState.remoteJid || targetChatId;
    const creatorObj = targetPollState.creator || targetPollState.createdBy;
    const isCreator = creatorObj ? isSameUser(creatorObj.jid, senderJid, creatorObj.name, sender) : false;
    const isAdmin = await isUserAdmin(sock, effectivePollChat, senderJid);

    if (!isCreator && !isAdmin) {
      return '⚠️ Only the poll creator or group admins can cancel this poll.';
    }

    const { releasedCourts } = await cancelOrDeletePoll(sock, effectivePollChat, targetPollId, context);
    let replyMsg = 'Poll cancelled and deleted from WhatsApp -- I won\'t auto-generate matchups from it anymore.';
    if (releasedCourts && releasedCourts.length > 0) {
      replyMsg += `\n🎾 Released court reservation(s): ${releasedCourts.join(", ")}.`;
    }

    if (chatId !== effectivePollChat && sock) {
      const pollTitle = targetPollState.title || targetPollState.when || targetPollState.name || 'Match';
      let groupNotif = `🛑 Poll *${pollTitle}* has been cancelled.`;
      if (releasedCourts && releasedCourts.length > 0) {
        groupNotif += `\n🎾 Released court reservation(s): ${releasedCourts.join(", ")}.`;
      }
      await sendMessageAndRecord(sock, effectivePollChat, { text: groupNotif });
    }

    return replyMsg;
  }

  // Rematch / Draw / Matchups
  if (lower === '!rematch' || lower === '!matchups' || lower === '!draw' || lower.startsWith('!rematch ') || lower.startsWith('!matchups ') || lower.startsWith('!draw ')) {
    const textFixedPairs = extractFixedPairsFromText(cleanText);
    const cleanArg = cleanText.replace(/^!(?:rematch|matchups|draw)\b/i, '')
      .replace(/\b(?:keeping|keep|put|with)\s+[a-z0-9\s._'-]+?\s+(?:and|&)\s+[a-z0-9\s._'-]+?\s+(?:in|on)\s+(?:the\s+)?(?:same\s+)?team\b/ig, '')
      .replace(/\b(?:keeping|keep|put|with)\s+[a-z0-9\s._'-]+?\s+(?:and|&)\s+[a-z0-9\s._'-]+?\s+together\b/ig, '')
      .replace(/\b[a-z0-9\s._'-]+?\s+(?:and|&)\s+[a-z0-9\s._'-]+?\s+(?:in|on)\s+(?:the\s+)?(?:same\s+)?team\b/ig, '')
      .trim();
    return await generateMatchupsFromPoll(sock, targetChatId, null, cleanArg || null, { fixedPairs: textFixedPairs }, context);
  }

  // Cleanup old polls
  if (lower === '!cleanuppolls') {
    const isAdmin = await isUserAdmin(sock, targetChatId, senderJid);
    if (!isAdmin) {
      return '⚠️ Only group admins can use !cleanuppolls.';
    }
    const removed = cleanupExpiredPolls(context);
    return removed.length
      ? `Cleaned up ${removed.length} old poll(s).`
      : 'Nothing to clean up yet -- no polls have passed their play time + grace period.';
  }

  // Slot limit (!setslots, !limitslots)
  if (lower.startsWith('!setslots') || lower.startsWith('!limitslots') || lower.startsWith('!setpollslots') || lower.startsWith('!limitsize') || lower.startsWith('!setsize') || lower.startsWith('!pollslots')) {
    const parts = cleanText.trim().split(/\s+/);
    let target = null;
    let count = null;
    let extraSlotTarget = null;
    const isOptInTok = (s) => /^(?:opt-?in|optin|yes\/?no|yesno)$/i.test(String(s || ''));
    const isSlotArgTok = (s) => /^\d+$/.test(String(s || '')) || /^(?:reset|clear|none|unlimited|open)$/i.test(String(s || '')) || /^(?:opt-?in|optin|yes\/?no|yesno)(?::\d+)?$/i.test(String(s || ''));
    if (parts.length === 2) {
      if (isSlotArgTok(parts[1])) {
        count = parts[1];
      } else {
        target = parts[1];
      }
    } else if (parts.length === 3) {
      if (isOptInTok(parts[1]) && /^\d+$/.test(parts[2])) {
        count = `opt-in:${parts[2]}`;
      } else if (/^\d+$/.test(parts[1]) && isOptInTok(parts[2])) {
        count = `opt-in:${parts[1]}`;
      } else {
        target = parts[1];
        count = parts[2];
      }
    } else if (parts.length >= 4) {
      target = parts[1];
      if (isOptInTok(parts[parts.length - 2]) && /^\d+$/.test(parts[parts.length - 1])) {
        extraSlotTarget = parts.slice(2, -2).join(" ") || null;
        count = `opt-in:${parts[parts.length - 1]}`;
      } else if (/^\d+$/.test(parts[parts.length - 2]) && isOptInTok(parts[parts.length - 1])) {
        extraSlotTarget = parts.slice(2, -2).join(" ") || null;
        count = `opt-in:${parts[parts.length - 2]}`;
      } else {
        extraSlotTarget = parts.slice(2, -1).join(" ");
        count = parts[parts.length - 1];
      }
    }
    return await handleSetPollSlots(sock, targetChatId, sender, senderJid, target, count, context, extraSlotTarget);
  }

  // Release courts (!releasecourt, !releasecourts, !releasepollcourt, !releasepollcourts)
  if (
    lower.startsWith('!releasecourt') ||
    lower.startsWith('!releasecourts') ||
    lower.startsWith('!releasepollcourt') ||
    lower.startsWith('!releasepollcourts')
  ) {
    return await handleReleasePollCourts(sock, targetChatId, sender, senderJid, cleanText, context, groupQuery ? targetChatId : null, chatId);
  }

  // Modify instance (!modifyinstance)
  const modifyInstanceCmd = parseModifyInstanceCommand(text);
  if (modifyInstanceCmd) {
    if (!modifyInstanceCmd.targetId && Object.keys(modifyInstanceCmd.updates).length === 0) {
      return 'Please specify which poll instance to modify, e.g. "!modifyinstance rec_1 12 7pm" or "!modifyinstance <pollId> 8".';
    }
    if (groupQuery) modifyInstanceCmd.updates.group = groupQuery;
    return await handleModifyPollInstance(sock, targetChatId, sender, senderJid, modifyInstanceCmd.targetId, modifyInstanceCmd.updates, context);
  }

  // Status queries (!activepolls, !upcomingpolls, !allpolls, !pollstatus)
  if (lower === '!activepolls' || lower === '!activepollstatus' || lower === '!active' || lower === '!pollstatus active' || lower === '!pollstatus -act') {
    return pollStatusText(groupQuery ? targetChatId : null, { activeOnly: true, targetChatId: groupQuery ? targetChatId : null }, context);
  }

  if (lower === '!upcomingpolls' || lower === '!upcomingpollstatus' || lower === '!upcoming' || lower === '!pollstatus upcoming' || lower === '!pollstatus -u') {
    return pollStatusText(groupQuery ? targetChatId : null, { upcomingOnly: true, targetChatId: groupQuery ? targetChatId : null }, context);
  }

  if (lower === '!allpolls' || lower === '!allpollstatus' || lower === '!pollstatus all' || lower === '!pollstatusall' || lower === '!pollstatus -a') {
    const isAdmin = await isUserAdmin(sock, targetChatId, senderJid);
    if (!isAdmin) {
      return '⚠️ Only group admins can view status of all polls.';
    }
    return pollStatusText(groupQuery ? targetChatId : null, {}, context);
  }

  if (lower === '!pollstatus') {
    return pollStatusText(groupQuery ? targetChatId : (chatId.endsWith('@g.us') ? chatId : (targetGroupJid || null)), {}, context);
  }

  if (lower.startsWith('!pollstatus ') || lower.startsWith('!pollstatus:')) {
    const rawTarget = cleanText.trim().slice('!pollstatus'.length).replace(/^[:\s]+/, '').trim();
    const cleanTarget = rawTarget.replace(/^["']|["']$/g, '').replace(/^schedule\s+/i, '').trim();
    if (cleanTarget) {
      if (cleanTarget === 'recurring' || cleanTarget === '-r' || cleanTarget === 'scheduled' || cleanTarget === '-s') {
        return pollStatusText(groupQuery ? targetChatId : null, { recurringOnly: true }, context);
      }
      return pollStatusText(groupQuery ? targetChatId : null, { targetId: cleanTarget }, context);
    }
    return pollStatusText(groupQuery ? targetChatId : null, {}, context);
  }

  return null;
}

/**
 * Handles LLM tool calls for match polls.
 */
async function executePollTool(sock, name, input, sender, senderJid, chatId, msg, context) {
  const { activePolls, latestPollIdByChat } = context;

  if (name === 'get_poll_status' || name === 'poll_status' || name === 'get_active_polls' || name === 'active_polls') {
    const groupQuery = input?.group || input?.targetGroup || input?.groupName || null;
    let targetChatId = chatId;
    if (groupQuery || (chatId && !chatId.endsWith('@g.us'))) {
      const targetRes = await resolveTargetChat(sock, chatId, senderJid, groupQuery, context, { requireAdmin: false });
      if (targetRes && !targetRes.error && targetRes.targetChatId) {
        targetChatId = targetRes.targetChatId;
      } else if (groupQuery && targetRes?.error) {
        return targetRes.error;
      } else if (sock) {
        targetChatId = (await getTargetGroupJid(sock)) || chatId;
      }
    }
    const filter = String(input?.filter || '').toLowerCase().trim();
    const targetId = input?.targetId || input?.pollId || input?.scheduleId || input?.query || null;
    const opts = {
      activeOnly: filter === 'active',
      upcomingOnly: filter === 'upcoming',
      recurringOnly: filter === 'recurring',
      ...(targetId ? { targetId: String(targetId) } : {})
    };
    const effectiveContext = context?.botSock ? context : { ...context, botSock: sock };
    return pollStatusText(targetChatId, opts, effectiveContext);
  }

  if (name === 'simulate_poll') {
    if (input.scheduleId) {
      const recurringCommands = require('../recurringCommands');
      return await recurringCommands.handleSimulateRecurringPoll(sock, chatId, sender, senderJid, `${input.scheduleId} ${input.targetDayOrDate || input.when || ''}`.trim(), {
        ...context,
        createMatchPoll
      });
    }

    const size = input.size || null;
    const when = input.when || null;
    const dayWord = input.dayWord || null;
    const timeWord = input.timeWord || null;
    const court = input.court || null;
    const includeCreator = input.includeCreator !== false;
    const creatorName = sender !== 'Someone' ? sender : (msg?.key?.participant ? nameFor(msg.key.participant) : 'Player 1');
    const creatorJid = msg?.key?.participant || msg?.key?.remoteJid || null;
    const groupQuery = input.group || input.targetGroup || input.groupName || null;
    let targetGroupJid = chatId.endsWith('@g.us') ? chatId : (await getTargetGroupJid(sock) || chatId);
    if (groupQuery) {
      const targetRes = await resolveTargetChat(sock, chatId, creatorJid, groupQuery, context, { requireAdmin: false });
      if (targetRes?.error) return targetRes.error;
      targetGroupJid = targetRes.targetChatId;
    }
    const targetChatId = chatId;

    const effectiveLineupGen = input.lineupGeneration || (input.noMatchups === true || input.autoMatchups === false ? 'none' : 'filled');
    const noMatchups = effectiveLineupGen === 'none';
    const checkCourts = input.checkCourts !== undefined ? Boolean(input.checkCourts) : true;
    const includePrebookedSpots = input['--pre-allocate-slots'] === true || input['pre-allocate-slots'] === true || input.preAllocateSlots === true || input['prebooked-spots'] === true || input.prebookedSpots === true || input.includePrebookedSpots === true;
    const rawToolBD = input.bookingDuration ?? input['booking-duration'] ?? input.booking_duration ?? input.courtDuration ?? input.courtBookingDuration ?? input.duration;
    if (rawToolBD !== undefined && rawToolBD !== null && String(rawToolBD).trim() !== '' && parseBookingDuration(rawToolBD) === undefined) {
      return `⚠️ Unsupported booking duration "${rawToolBD}". Supported values are 30, 60, 90, or 120 minutes (e.g. 60min, 90min, 1h, 1.5h, 2h).`;
    }
    const toolBookingDuration = rawToolBD !== undefined ? parseBookingDuration(rawToolBD) : null;
    const rawSimMO = input.maxOptionsPerPoll ?? input.maxPollOptions ?? input.optionsPerPoll ?? input.pollOptionLimit ?? input.maxOptions ?? input['max-options-per-poll'] ?? input['max-poll-options'] ?? input['options-per-poll'] ?? input['poll-option-limit'] ?? input['max-options'];
    if (rawSimMO !== undefined && rawSimMO !== null && String(rawSimMO).trim() !== '' && parseMaxOptionsPerPoll(rawSimMO) === undefined) {
      return formatInvalidMaxOptionsError(rawSimMO);
    }
    const simMaxOptionsPerPoll = rawSimMO !== undefined ? parseMaxOptionsPerPoll(rawSimMO) : undefined;

    const res = await createMatchPoll(
      sock,
      targetChatId,
      size,
      when,
      dayWord,
      timeWord,
      creatorName,
      creatorJid,
      includeCreator,
      null,
      false,
      true,
      noMatchups,
      checkCourts,
      includePrebookedSpots,
      false,
      null,
      court,
      'none',
      null,
      null,
      null,
      null,
      context,
      {
        title: input.title ?? input.pollTitle ?? input['poll-title'] ?? input.poll_title ?? input.customTitle,
        type: input.type || input.pollType || null,
        isOptIn: input.isOptIn !== undefined ? input.isOptIn : ((input.type === 'opt_in' || input.pollType === 'opt_in') ? true : null),
        targetGroupJid,
        courtsStrategy: input.courtsStrategy || input['courts-strategy'] || input.courtStrategy || input['court-strategy'] || null,
        lookAround: input.lookAround || input['look-around'] || null,
        slotCheck: input.slotCheck !== undefined ? input.slotCheck : null,
        lineupGeneration: effectiveLineupGen,
        lineupLeadTime: input.lineupLeadTime || null,
        reminders: input.reminders !== undefined ? input.reminders : true,
        maxCourts: input.maxCourts || input['max-courts'] || input.max_courts || null, bookingCourtPreference: input.bookingCourtPreference || input['booking-court-preference'] || input.courtPreference || input['court-preference'] || null,
        bookingDuration: toolBookingDuration,
        ...(simMaxOptionsPerPoll !== undefined ? { maxOptionsPerPoll: simMaxOptionsPerPoll } : {}),
        timeSlots: input.timeSlots || null,
        multiVote: input.multiVote !== undefined ? input.multiVote : null,
        multiSessionMode: input.multiSessionMode || null,
        simulate: true,
        isSimulation: true
      }
    );

    if (res?.err) {
      return res.message || res.err;
    }

    const displayWhen = res.when || when || `${dayWord || ''} ${timeWord || ''}`.trim() || 'today';
    return formatSimulationPollSummary(res, { displayWhen });
  }

  if (name === 'create_poll') {
    const size = input.size || null;
    const when = input.when || null;
    const dayWord = input.dayWord || null;
    const timeWord = input.timeWord || null;
    const court = input.court || null;
    const includeCreator = input.includeCreator !== false;
    const cancelExisting = input.cancelExisting === true;
    const replacePollId = input.replacePollId || null;
    const creatorName = sender !== 'Someone' ? sender : (msg?.key?.participant ? nameFor(msg.key.participant) : 'Player 1');
    const creatorJid = msg?.key?.participant || msg?.key?.remoteJid || null;
    const groupQuery = input.group || input.targetGroup || input.groupName || null;
    let targetChatId = chatId.endsWith('@g.us') ? chatId : (await getTargetGroupJid(sock) || chatId);
    if (groupQuery || (chatId && !chatId.endsWith('@g.us'))) {
      const targetRes = await resolveTargetChat(sock, chatId, creatorJid, groupQuery, context, { requireAdmin: true, actionDesc: 'create polls' });
      if (targetRes?.error) return targetRes.error;
      targetChatId = targetRes.targetChatId;
    }

    const effectiveLineupGen = input.lineupGeneration || (input.noMatchups === true || input.autoMatchups === false ? 'none' : 'filled');
    const noMatchups = effectiveLineupGen === 'none';
    const checkCourts = input.checkCourts === true || input.includeCourts === true || input.considerCourts === true;
    const includePrebookedSpots = input['--pre-allocate-slots'] === true || input['pre-allocate-slots'] === true || input.preAllocateSlots === true || input['prebooked-spots'] === true || input.prebookedSpots === true || input.includePrebookedSpots === true;
    const toolCourtsStrat = input.courtsStrategy || input['courts-strategy'] || input.courtStrategy || input['court-strategy'] || null;
    const courtBookingType = input.courtBookingType || (toolCourtsStrat === 'book' ? 'pre-book' : null);
    const bookingPlayers = input.bookingPlayers ? groupsConfig.normalizeBookingPlayerLists(input.bookingPlayers) : null;
    let preBookCourts = (input.preBookCourts !== undefined && input.preBookCourts !== null && parseInt(input.preBookCourts, 10) > 0)
      ? parseInt(input.preBookCourts, 10)
      : (input.preBookCourtsCount !== undefined && input.preBookCourtsCount !== null && parseInt(input.preBookCourtsCount, 10) > 0
        ? parseInt(input.preBookCourtsCount, 10)
        : null);
    const maxCourtsTool = (input.maxCourts !== undefined && input.maxCourts !== null && parseInt(input.maxCourts, 10) > 0)
      ? parseInt(input.maxCourts, 10)
      : (input["max-courts"] !== undefined && input["max-courts"] !== null && parseInt(input["max-courts"], 10) > 0
        ? parseInt(input["max-courts"], 10)
        : (input.max_courts !== undefined && input.max_courts !== null && parseInt(input.max_courts, 10) > 0
          ? parseInt(input.max_courts, 10)
          : null));
    const isPreBookTool = toolCourtsStrat === 'book' || String(courtBookingType).toLowerCase() === "pre-book" || String(courtBookingType).toLowerCase() === "prebook";
    if (isPreBookTool && !preBookCourts && maxCourtsTool) {
      preBookCourts = maxCourtsTool;
    }
    const rawToolBD = input.bookingDuration ?? input['booking-duration'] ?? input.booking_duration ?? input.courtDuration ?? input.courtBookingDuration ?? input.duration;
    if (rawToolBD !== undefined && rawToolBD !== null && String(rawToolBD).trim() !== '' && parseBookingDuration(rawToolBD) === undefined) {
      return `⚠️ Unsupported booking duration "${rawToolBD}". Supported values are 30, 60, 90, or 120 minutes (e.g. 60min, 90min, 1h, 1.5h, 2h).`;
    }
    const toolBookingDuration = rawToolBD !== undefined ? parseBookingDuration(rawToolBD) : null;
    const rawCreateMO = input.maxOptionsPerPoll ?? input.maxPollOptions ?? input.optionsPerPoll ?? input.pollOptionLimit ?? input.maxOptions ?? input['max-options-per-poll'] ?? input['max-poll-options'] ?? input['options-per-poll'] ?? input['poll-option-limit'] ?? input['max-options'];
    if (rawCreateMO !== undefined && rawCreateMO !== null && String(rawCreateMO).trim() !== '' && parseMaxOptionsPerPoll(rawCreateMO) === undefined) {
      return formatInvalidMaxOptionsError(rawCreateMO);
    }
    const createMaxOptionsPerPoll = rawCreateMO !== undefined ? parseMaxOptionsPerPoll(rawCreateMO) : undefined;

    const res = await createMatchPoll(
      sock,
      targetChatId,
      size,
      when,
      dayWord,
      timeWord,
      creatorName,
      creatorJid,
      includeCreator,
      replacePollId,
      cancelExisting,
      false,
      noMatchups,
      checkCourts,
      includePrebookedSpots,
      false,
      null,
      court,
      courtBookingType,
      bookingPlayers,
      preBookCourts,
      null,
      null,
      context,
      { title: input.title ?? input.pollTitle ?? input['poll-title'] ?? input.poll_title ?? input.customTitle, type: input.type || input.pollType || null, isOptIn: input.isOptIn !== undefined ? input.isOptIn : ((input.type === 'opt_in' || input.pollType === 'opt_in') ? true : null), courtsStrategy: toolCourtsStrat, lookAround: input.lookAround || input['look-around'] || null, bookingDuration: toolBookingDuration, ...(createMaxOptionsPerPoll !== undefined ? { maxOptionsPerPoll: createMaxOptionsPerPoll } : {}), slotCheck: input.slotCheck !== undefined ? input.slotCheck : (input['slot-check'] !== undefined ? input['slot-check'] : null), lineupGeneration: input.lineupGeneration || input['lineup-generation'] || null, lineupLeadTime: input.lineupLeadTime || input['lineup-lead-time'] || null, reminders: input.reminders !== undefined ? input.reminders : true, maxCourts: input.maxCourts || input['max-courts'] || input.max_courts || null, bookingCourtPreference: input.bookingCourtPreference || input['booking-court-preference'] || input.courtPreference || input['court-preference'] || null, timeSlots: input.timeSlots || null, multiVote: input.multiVote !== undefined ? input.multiVote : null, multiSessionMode: input.multiSessionMode || null }
    );

    if (res?.err) {
      return `Could not create poll: ${res.err}`;
    }
    const resolvedWhen = res?.when ? ` for ${res.when}` : (when ? ` for ${when}` : '');
    const replacedNote = res?.replacedOldPoll ? ' (older poll deleted from WhatsApp)' : '';
    if (res?.isOptIn) {
      const capNote = res?.size ? ` (capped at ${res.size} spots max)` : '';
      return `Opt-in poll created with "Yes" and "No" options${capNote}${resolvedWhen}${replacedNote}. Players can vote "Yes" to opt in. When ready, ask me to generate the matchups!`;
    }
    return 'Poll created and sent to WhatsApp. The poll title itself contains time and slots, so do not output a separate confirmation message.';
  }

  if (name === 'generate_matchups' || name === 'rematch') {
    const groupQuery = input.group || input.targetGroup || input.groupName || null;
    let targetChatId = chatId;
    if (groupQuery) {
      const targetRes = await resolveTargetChat(sock, chatId, senderJid, groupQuery, context, { requireAdmin: false });
      if (targetRes?.error) return targetRes.error;
      targetChatId = targetRes.targetChatId;
    }
    const res = await generateMatchupsFromPoll(sock, targetChatId, input.pollId, input.pollName || input.when, {
      fixedPairs: input.fixedPairs || [],
      prebookedCourts: input.prebookedCourts || []
    }, context);
    return res || 'Matchups generated and posted.';
  }

  if (name === 'stop_poll') {
    return await handleStopPoll(sock, chatId, sender, senderJid, input.pollId || null, context);
  }

  if (name === 'resume_poll') {
    return await handleResumePoll(sock, chatId, sender, senderJid, input.pollId || null, context);
  }

  if (name === 'pause_reminders') {
    return await handlePauseReminders(sock, chatId, sender, input.pollId || null, context);
  }

  if (name === 'resume_reminders') {
    return await handleResumeReminders(sock, chatId, sender, input.pollId || null, context);
  }

  if (name === 'trigger_reminder' || name === 'send_reminder' || name === 'force_reminder') {
    const res = await handleTriggerReminder(sock, chatId, sender, input.pollId || null, context, Boolean(input.force));
    return (typeof res === 'string' && res) ? res : 'Reminder triggered and sent to group.';
  }

  if (name === 'limit_poll_slots' || name === 'set_poll_slots') {
    const slotTarget = input.targetDayOrDate || input.dateOrDay || null;
    const rawSlots = input.type === 'opt_in' && typeof input.slots === 'number'
      ? `opt-in:${input.slots}`
      : input.slots;
    return await handleSetPollSlots(sock, chatId, sender, senderJid, input.targetId || null, rawSlots, context, slotTarget);
  }

  if (name === 'release_poll_courts' || name === 'release_courts' || name === 'release_court' || name === 'cancel_poll_courts') {
    const target = input.pollId || input.pollName || input.when || input.target || input.targetId || null;
    const count = input.count !== undefined ? input.count : (input.all ? 'all' : null);
    const specificCourt = input.court || null;
    const groupQuery = input.group || input.targetGroup || input.groupName || null;
    let targetChatId = chatId;
    if (groupQuery) {
      const targetRes = await resolveTargetChat(sock, chatId, senderJid, groupQuery, context, { requireAdmin: true, actionDesc: 'release courts' });
      if (targetRes?.error) return targetRes.error;
      targetChatId = targetRes.targetChatId;
    }
    return await handleReleasePollCourts(sock, targetChatId, sender, senderJid, null, context, groupQuery ? targetChatId : null, chatId, {
      target,
      countOrAll: input.all ? 'all' : (count || specificCourt || 'all'),
      specificCourt,
      keepSize: Boolean(input.keepSize || input.keep_size || input.noResize || input.no_resize || input.preserveSize)
    });
  }

  if (name === 'modify_poll_instance') {
    return await handleModifyPollInstance(sock, chatId, sender, senderJid, input.targetId || input.pollId || input.pollName || input.id, input, context);
  }

  if (name === 'clear_all_polls') {
    return await handleClearAllPolls(sock, chatId, senderJid, context);
  }

  if (name === 'cancel_poll') {
    let targetPollId = input.pollId || null;
    if (!targetPollId) {
      targetPollId = findTargetPollToCancel(activePolls, chatId, senderJid, sender);
    }
    if (!targetPollId) {
      targetPollId = latestPollIdByChat.get(chatId);
    }
    if (!targetPollId || !activePolls.has(targetPollId)) return 'No active poll to cancel.';

    const targetPollState = activePolls.get(targetPollId);
    const targetChat = targetPollState.remoteJid || chatId;
    const creatorObj = targetPollState.creator || targetPollState.createdBy;
    const isCreator = creatorObj ? isSameUser(creatorObj.jid, senderJid, creatorObj.name, sender) : false;
    const isAdmin = await isUserAdmin(sock, targetChat, senderJid);

    if (!isCreator && !isAdmin) {
      return '⚠️ Only the poll creator or group admins can cancel this poll.';
    }

    const { releasedCourts } = await cancelOrDeletePoll(sock, targetChat, targetPollId, context);
    let toolResult = 'Poll cancelled and deleted from WhatsApp successfully.';
    if (releasedCourts && releasedCourts.length > 0) {
      toolResult += ` Released court reservation(s): ${releasedCourts.join(", ")}.`;
    }
    if (chatId !== targetChat && sock) {
      const pollTitle = targetPollState.title || targetPollState.when || targetPollState.name || 'Match';
      let groupNotif = `🛑 Poll *${pollTitle}* has been cancelled.`;
      if (releasedCourts && releasedCourts.length > 0) {
        groupNotif += `\n🎾 Released court reservation(s): ${releasedCourts.join(", ")}.`;
      }
      await sendMessageAndRecord(sock, targetChat, { text: groupNotif });
    }
    return toolResult;
  }

  return `Unknown poll tool ${name}`;
}

module.exports = {
  isMatchSchedulingPoll,
  handleSimulatePoll,
  interpretManualPollWithLLM,
  isValidPlayerCount,
  getNextValidPlayerCount,
  getFirstSlotNumber,
  addNextCreatorPlayer,
  extractNamedPlayersFromTitle,
  resolveManualPollPlayers,
  resolveFixedPollRoster,
  resolveMultiTimePollRoster,
  createMultiTimePoll,
  getPollVoters,
  parsePollCreationText,
  extractPollCreationPostTime,
  isPostTimeInFuture,
  handleDirectPollCreation,
  isUserInPoll,
  getMessageSecret,
  normalizeVotePayload,
  safeDecryptPollVote,
  deletePollFromWhatsApp,
  handlePollDeleted,
  cancelOrDeletePoll,
  findTargetPollToCancel,
  releaseAllCourtsForPollState,
  handleDeleteAllPolls,
  handleClearAllPolls,
  cleanupExpiredPolls,
  buildPollReminder,
  buildPollReminderText,
  formatReminderHours,
  formatLineupGenDesc,
  formatSimulationPollSummary,
  shouldAutoGenerateLineupOnFill,
  checkPendingLineupGenerations,
  buildLineupReminderText,
  buildUntimedPollReminderText,
  pollTitleIndicatesGame,
  getDayBefore12pmReminderTime,
  getDayBefore6pmReminderTime,
  getPollDayWord,
  getUntimedPollDayExpiryMs,
  sendPollReminder,
  hasTimeSpecifiedInTitle,
  isAutoCreatedPoll,
  checkAndSendPollReminders,
  findSpecificPoll,
  getPollScheduleId,
  handleTriggerReminder,
  parseTriggerReminderArgs,
  handlePauseReminders,
  handleResumeReminders,
  parseModifyInstanceCommand,
  handleModifyPollInstance,
  handleSetPollSlots,
  handleStopPoll,
  handleResumePoll,
  extractFixedPairsFromText,
  formatMatchHeaderTime,
  formatCourtLabel,
  formatCourtBookingTitleLine,
  formatCourtAvailableTitleLine,
  formatCourtTentativeTitleLine,
  getPrebookedCourtsForPoll,
  generateMatchupsFromPoll,
  pollStatusText,
  getVoteTimestamp,
  getVoteArrivalIndex,
  checkAndNotifySlotConflicts,
  getSlotNumberForOption,
  checkAndNotifyInvalidSlotVotes,
  handleOnDemandCourtBooking,
  checkCourtReleasesForPoll,
  checkCourtReleases,
  SIMULATION_PREFIX,
  hasSimulationPrefix,
  preBookCourtsForMatch,
  normalizeCourtPreference,
  getCourtPreferenceRank,
  sortCourtsByPreference,
  partitionMatchSlots,
  VALID_POLL_OPTION_LIMITS,
  DEFAULT_MAX_OPTIONS_PER_POLL,
  parseMaxOptionsPerPoll,
  normalizeMaxOptionsPerPoll,
  createMatchPoll,
  processPollVoteEvent,
  bufferPendingVote,
  flushPendingPollVotes,
  pendingPollVotes,
  handlePollCommand,
  handleQuietHoursCommand,
  executePollTool,
  parseReleaseCourtsArgs,
  parseBookPollCourtsArgs,
  handleReleasePollCourts,
  handleBookPollCourts,
  migratePollMatchupOptions,
  nameFor
};
