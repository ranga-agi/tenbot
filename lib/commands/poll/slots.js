/**
 * Poll Slot Limits, Overrides & Instance Modification
 */

const { jidNormalizedUser } = require('@whiskeysockets/baileys');

const ratings = require('../../ratings');
const { sendMessageAndRecord } = require('../../botMessage');
const recurringPollsModule = require('../../recurringPolls');
const scvcc = require('../../scvcc');
const pollTime = require('../../pollTime');
const groupsConfig = require('../../groupsConfig');
const pairHistory = require('../../pairHistory');
const playerActivity = require('../../playerActivity');
const {
  generateMatchups,
  formatMatchups,
  summarizeSchedule
} = require('../../matchups');
const { normalizeCommandDashes } = require('../../textNormalize');
const { isUserAdmin, isSameUser, getTargetGroupJid } = require('../groupCommands');

const {
  WORD_TO_NUMBER,
  NUMBER_WORDS_PATTERN,
  formatLookAround,
  parseTimeString,
  parseBookingDuration,
  normalizeBookingDuration,
  formatBookingDuration,
  formatScvccDuration,
  DEFAULT_MAX_OPTIONS_PER_POLL,
  parseMaxOptionsPerPoll,
  normalizeMaxOptionsPerPoll,
  formatInvalidMaxOptionsError
} = pollTime;

const {
  nameFor,
  capitalize,
  isValidPlayerCount,
  resolveFixedPollRoster,
  resolveMultiTimePollRoster,
  getPollVoters,
  formatLineupGenDesc,
  shouldAutoGenerateLineupOnFill,
  getPollScheduleId,
  isDayOrDateStr,
  formatMatchHeaderTime,
  normalizePollTitle
} = require('./roster');
const {
  getPrebookedCourtsForPoll,
  formatCourtLabel
} = require('./courts');
const { createMatchPoll } = require('./creation');

function parseModifyInstanceCommand(rawText) {
  const text = normalizeCommandDashes(rawText || '').trim();
  let m = text.match(/^!(?:modifyinstance|modifyrecurringinstance|modifypoll|editpoll|updatepoll|editinstance|updateinstance)\s*(.*)$/i);
  let rest = m ? m[1].trim() : null;

  if (!m) {
    const m2 = text.match(/^!(?:modifyrecurringpoll|editrecurringpoll|updaterecurringpoll|changerecurringpoll)\s*(.*)$/i);
    if (m2) {
      const r = m2[1].trim();
      if (/\b(?:--instance|-i|instance)\b/i.test(r)) {
        rest = r.replace(/\b(?:--instance|-i|instance)\b/ig, ' ').trim();
      } else {
        return null;
      }
    } else {
      return null;
    }
  }

  if (!rest) {
    return { targetId: null, updates: {} };
  }

  let targetId = null;
  let rem = '';
  const qMatch = rest.match(/^["']([^"']+)["']\s*(.*)$/);
  if (qMatch) {
    targetId = qMatch[1].trim();
    rem = qMatch[2].trim();
  } else {
    const parts = rest.split(/\s+/, 2);
    targetId = parts[0].trim();
    rem = rest.slice(parts[0].length).trim();
  }

  if (targetId && (
    targetId.startsWith('--') ||
    /^(?:slot-?check|check-?slots|no-?slot-?check|lineup-?generation|lineups?|skip-?courts?|unskip-?courts?|(?:poll-?)?title[:=])/i.test(targetId) ||
    (!qMatch && /^(?:(?:poll\s+)?title\s*[:=]|(?:titled|called|named|with\s+(?:the\s+)?title)\s+["'\u201c\u2018])/i.test(rest))
  )) {
    rem = rest;
    targetId = null;
  }

  const updates = {};
  const { flags, remainingText: remClean } = recurringPollsModule.extractCommonFlags(rem);
  if (flags.courtsStrategy !== undefined) updates.courtsStrategy = flags.courtsStrategy;
  if (flags.courtBookingType !== undefined) updates.courtBookingType = flags.courtBookingType;
  if (flags.preBookCourts !== undefined) updates.preBookCourts = flags.preBookCourts;
  if (flags.bookingPlayers !== undefined) updates.bookingPlayers = flags.bookingPlayers;
  if (flags.bookingStrategy !== undefined) updates.bookingStrategy = flags.bookingStrategy;
  if (flags.bookingSchedule !== undefined) updates.bookingSchedule = flags.bookingSchedule;
  if (flags.checkCourts !== undefined) updates.checkCourts = flags.checkCourts;
  if (flags.noMatchups !== undefined) updates.noMatchups = flags.noMatchups;
  if (flags.includePrebookedSpots !== undefined) updates.includePrebookedSpots = flags.includePrebookedSpots;
  if (flags['--pre-allocate-slots'] !== undefined) updates['--pre-allocate-slots'] = flags['--pre-allocate-slots'];
  if (flags['pre-allocate-slots'] !== undefined) updates['pre-allocate-slots'] = flags['pre-allocate-slots'];
  if (flags.preAllocateSlots !== undefined) updates.preAllocateSlots = flags.preAllocateSlots;
  if (flags['prebooked-spots'] !== undefined) updates['prebooked-spots'] = flags['prebooked-spots'];
  if (flags.prebookedSpots !== undefined) updates.prebookedSpots = flags.prebookedSpots;
  if (flags.lookAround !== undefined) updates.lookAround = flags.lookAround;
  if (flags.slotCheck !== undefined) updates.slotCheck = flags.slotCheck;
  if (flags.lineupGeneration !== undefined) updates.lineupGeneration = flags.lineupGeneration;
  if (flags.lineupLeadTime !== undefined) updates.lineupLeadTime = flags.lineupLeadTime;
  if (flags.reminders !== undefined) updates.reminders = flags.reminders;
  if (flags.maxCourts !== undefined) updates.maxCourts = flags.maxCourts;
  if (flags.skipCourt !== undefined) updates.skipCourt = flags.skipCourt;
  if (flags.unskipCourt !== undefined) updates.unskipCourt = flags.unskipCourt;
  if (flags.bookingCourtPreference !== undefined) updates.bookingCourtPreference = flags.bookingCourtPreference;
  if (flags.bookingDuration !== undefined) updates.bookingDuration = flags.bookingDuration;
  if (flags.maxOptionsPerPoll !== undefined) updates.maxOptionsPerPoll = flags.maxOptionsPerPoll;
  if (flags.maxOptionsPerPollInvalid !== undefined) updates.maxOptionsPerPollInvalid = flags.maxOptionsPerPollInvalid;
  if (flags.title !== undefined) updates.title = flags.title;

  let remForSize = remClean;
  const courtM = remClean.match(/\b(?:on\s+|at\s+|for\s+)?(?:the\s+)?(court\s*#?\s*\d+|pickleball\s*#?\s*\d+|pb\s*#?\s*\d+)\b/i);
  if (courtM) {
    remForSize = remForSize.replace(courtM[0], ' ');
    const rawCourt = courtM[1].replace(/#/g, '').replace(/\s+/g, ' ').trim();
    if (/^court\s*\d+$/i.test(rawCourt)) {
      updates.court = `Court ${rawCourt.match(/\d+/)[0]}`;
    } else {
      updates.court = rawCourt;
    }
  }
  remForSize = remForSize.replace(/\b(?:on\s+|at\s+|for\s+)?(?:the\s+)?(?:courts?|pickleball|pb)\s*#?\s*\d+\b/gi, ' ');

  const remForSizeNoDateTime = remForSize
    .replace(/\b\d{4}-\d{2}-\d{2}\b/g, ' ')
    .replace(/\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b/g, ' ')
    .replace(/\b(?:\d{1,2}(?:[:.]\d{2})?\s*(?:am|pm)|\d{1,2}[:.]\d{2})\b/gi, ' ');

  const slotsM = remClean.match(/--(?:slots?|spots?|size)=?(opt-?in:\d+|\d+|auto|opt-?in|reset)/i) ||
                 remClean.match(/\b(?:slots?|spots?|size)=?(opt-?in:\d+|\d+|auto|opt-?in|reset)\b/i);
  if (slotsM) {
    const sVal = slotsM[1].toLowerCase();
    const capMatch = sVal.match(/^opt-?in:(\d+)$/);
    if (capMatch) {
      updates.type = 'opt_in';
      updates.isExplicitOptIn = true;
      updates.size = parseInt(capMatch[1], 10);
    } else if (/^opt-?in$/.test(sVal)) {
      updates.type = 'opt_in';
      updates.isExplicitOptIn = true;
      updates.size = null;
    } else {
      updates.size = /^\d+$/.test(sVal) ? parseInt(sVal, 10) : sVal;
    }
  } else if (/\ball\s+(?:reset|clear|remove|default)\b/i.test(remClean) || /\b(?:reset|clear|remove|default)\s+all\b/i.test(remClean)) {
    updates.dayWord = 'all';
    updates.size = 'reset';
  } else if (/\b(?:reset|clear|remove|default)\b/i.test(remClean)) {
    updates.size = 'reset';
  } else if (/\b(?:opt-?in|yes\s*\/\s*no|yesno|open)\b/i.test(remClean)) {
    updates.type = 'opt_in';
    updates.isExplicitOptIn = true;
    const optSizeM = remForSizeNoDateTime.match(new RegExp(`\\b(?:opt-?in|yes\\s*\\/\\s*no|yesno|open)\\s+(?:for\\s+)?(\\d+|${NUMBER_WORDS_PATTERN})\\b`, 'i')) ||
                     remForSizeNoDateTime.match(new RegExp(`\\b(?:for|size|spots?|players?|cap|limit)\\s*[:=]?\\s*(\\d+|${NUMBER_WORDS_PATTERN})\\b`, 'i')) ||
                     remForSizeNoDateTime.match(new RegExp(`\\b(\\d+|${NUMBER_WORDS_PATTERN})\\s*(?:spots?|players?|people|opt-?in|yes\\s*\\/\\s*no|yesno)\\b`, 'i')) ||
                     remForSizeNoDateTime.match(/\b(\d{1,2})\b/);
    if (optSizeM) {
      const raw = optSizeM[1].toLowerCase();
      const parsedNum = WORD_TO_NUMBER[raw] || parseInt(raw, 10);
      updates.size = (Number.isInteger(parsedNum) && parsedNum > 0 && parsedNum <= 40) ? parsedNum : null;
    } else {
      updates.size = null;
    }
  } else if (/\bauto\b/i.test(remClean)) {
    updates.size = 'auto';
  } else {
    const sizeM = remForSize.match(new RegExp(`\\b(?:for|size|spots?|players?)\\s*[:=]?\\s*(\\d+|${NUMBER_WORDS_PATTERN})\\b`, 'i')) ||
                  remForSize.match(new RegExp(`\\b(\\d+|${NUMBER_WORDS_PATTERN})\\s*(?:spots?|players?|people)\\b`, 'i')) ||
                  remForSize.match(new RegExp(`\\b([248]|12|16|two|four|eight|twelve|sixteen)\\b`, 'i'));
    if (sizeM) {
      const raw = sizeM[1].toLowerCase();
      updates.size = WORD_TO_NUMBER[raw] || parseInt(raw, 10);
    } else if (/\bsingles\b/i.test(remForSize)) {
      updates.size = 2;
    } else if (/\bdoubles\b/i.test(remForSize)) {
      updates.size = 4;
    }
  }

  const timeM = remClean.match(/\b(\d{1,2}(?:[:.]\d{2})?\s*(?:am|pm))\b/i) || remClean.match(/\b(\d{1,2}[:.]\d{2})\b/i);
  if (timeM) {
    updates.timeWord = timeM[1].trim();
  }

  const dayM = remClean.match(/\b(today|tonight|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tue|wed|thu|fri|sat|sun)\b/i);
  if (dayM) {
    updates.dayWord = dayM[1].trim();
  }

  if (updates.dayWord && updates.timeWord) {
    const cap = updates.dayWord.charAt(0).toUpperCase() + updates.dayWord.slice(1).toLowerCase();
    updates.when = `${cap} ${updates.timeWord}`;
  } else if (updates.timeWord) {
    updates.when = updates.timeWord;
  } else if (updates.dayWord) {
    updates.when = updates.dayWord.charAt(0).toUpperCase() + updates.dayWord.slice(1).toLowerCase();
  }

  return { targetId, updates };
}

async function handleModifyPollInstance(sock, chatId, sender, senderJid, targetId, updates = {}, context) {
  const { activePolls, recurringPolls } = context;
  const isDM = Boolean(chatId && !chatId.endsWith('@g.us'));
  const effectiveChatId = isDM ? (context.targetGroupJid || await getTargetGroupJid(sock) || chatId) : chatId;

  let cleanTarget = String(targetId || updates.targetId || updates.pollId || updates.pollName || updates.id || '').replace(/^["']|["']$/g, '').trim();

  if (updates.lineupGeneration === undefined) {
    updates.lineupGeneration = updates['lineup-generation'] || updates.lineup_generation || updates.lineupGen;
  }
  if (updates.lineupLeadTime === undefined) {
    updates.lineupLeadTime = updates['lineup-lead-time'] || updates.lineup_lead_time || updates.leadTime || updates['lead-time'];
  }
  if (updates.slotCheck === undefined) {
    updates.slotCheck = updates['slot-check'] || updates.slot_check;
  }
  if (updates.reminders === undefined) {
    updates.reminders = updates.reminder;
  }
  const rawTitleKey = ['title', 'pollTitle', 'poll-title', 'poll_title', 'customTitle'].find((k) => updates[k] !== undefined);
  const hasTitleUpdate = rawTitleKey !== undefined;
  const rawDurationKey = ['bookingDuration', 'courtBookingDuration', 'courtDuration', 'booking_duration', 'booking-duration', 'court-duration', 'duration'].find((k) => updates[k] !== undefined);
  let hasDurationUpdate = false;
  let parsedDurationUpdate = null;
  if (rawDurationKey !== undefined) {
    const rawDurVal = updates[rawDurationKey];
    const parsedBD = parseBookingDuration(rawDurVal);
    if (parsedBD === undefined && rawDurVal !== null && String(rawDurVal).trim() !== '') {
      return `⚠️ Unsupported booking duration "${rawDurVal}". Supported values are 30, 60, 90, or 120 minutes (e.g. 60min, 90min, 1h, 1.5h, 2h, or "default").`;
    }
    parsedDurationUpdate = parsedBD ?? null;
    hasDurationUpdate = true;
  }
  if (updates.maxOptionsPerPollInvalid !== undefined) {
    return formatInvalidMaxOptionsError(updates.maxOptionsPerPollInvalid);
  }
  const rawMaxOptKey = [
    'maxOptionsPerPoll', 'maxPollOptions', 'optionsPerPoll', 'pollOptionLimit', 'maxOptions',
    'max-options-per-poll', 'max_options_per_poll', 'max-poll-options', 'options-per-poll', 'poll-option-limit', 'max-options'
  ].find((k) => updates[k] !== undefined);
  let hasMaxOptUpdate = false;
  let parsedMaxOptUpdate = null;
  if (rawMaxOptKey !== undefined) {
    const rawMO = updates[rawMaxOptKey];
    const parsedMO = parseMaxOptionsPerPoll(rawMO);
    if (parsedMO === undefined && rawMO !== null && String(rawMO).trim() !== '') {
      return formatInvalidMaxOptionsError(rawMO);
    }
    parsedMaxOptUpdate = parsedMO ?? null;
    hasMaxOptUpdate = true;
  }

  let matchedPollId = null;
  let matchedPollState = null;

  if (cleanTarget) {
    const cleanLower = cleanTarget.toLowerCase();

    for (const [id, state] of activePolls.entries()) {
      if ((state.remoteJid === effectiveChatId || isDM) && id.toLowerCase() === cleanLower) {
        matchedPollId = id;
        matchedPollState = state;
        break;
      }
    }

    if (!matchedPollState) {
      for (const [id, state] of activePolls.entries()) {
        if ((state.remoteJid === effectiveChatId || isDM) && (state.status === 'active' || state.status === 'filled' || state.status === 'stopped')) {
          const sid = getPollScheduleId(state, recurringPolls);
          if (sid && sid.toLowerCase() === cleanLower) {
            matchedPollId = id;
            matchedPollState = state;
            break;
          }
          if (state.scheduleId && state.scheduleId.toLowerCase() === cleanLower) {
            matchedPollId = id;
            matchedPollState = state;
            break;
          }
        }
      }
    }

    if (!matchedPollState) {
      for (const [id, state] of activePolls.entries()) {
        if ((state.remoteJid === effectiveChatId || isDM) && (state.status === 'active' || state.status === 'filled' || state.status === 'stopped')) {
          const pTitle = (state.title || '').toLowerCase();
          if (pTitle && pTitle === cleanLower) {
            matchedPollId = id;
            matchedPollState = state;
            break;
          }
        }
      }
    }
    if (!matchedPollState) {
      for (const [id, state] of activePolls.entries()) {
        if ((state.remoteJid === effectiveChatId || isDM) && (state.status === 'active' || state.status === 'filled' || state.status === 'stopped')) {
          const pName = (state.name || '').toLowerCase();
          const pTitle = (state.title || '').toLowerCase();
          const pWhen = (state.when || '').toLowerCase();
          if (pName.includes(cleanLower) || (pTitle && pTitle.includes(cleanLower)) || pWhen.includes(cleanLower) || (pWhen && cleanLower.includes(pWhen))) {
            matchedPollId = id;
            matchedPollState = state;
            break;
          }
        }
      }
    }
  } else {
    const chatPolls = [...activePolls.entries()].filter(([, state]) =>
      (state.remoteJid === effectiveChatId || isDM) && (state.status === 'active' || state.status === 'filled' || state.status === 'stopped')
    );
    if (chatPolls.length === 1) {
      matchedPollId = chatPolls[0][0];
      matchedPollState = chatPolls[0][1];
    } else if (chatPolls.length === 0) {
      const isAllChat = !chatId || !chatId.endsWith('@g.us');
      const chatSchedules = [...recurringPolls.entries()].filter(([, s]) => isAllChat || s.remoteJid === effectiveChatId);
      const hasOverrideSlotUpdate = updates.size !== undefined || updates.type === 'opt_in' || updates.isExplicitOptIn;
      if (chatSchedules.length === 1 && (hasOverrideSlotUpdate || updates.skipCourt !== undefined || updates.unskipCourt !== undefined)) {
        const overrideSlotVal = (updates.type === 'opt_in' || updates.isExplicitOptIn)
          ? ((typeof updates.size === 'number' && updates.size > 0) ? `opt-in:${updates.size}` : 'opt-in')
          : updates.size;
        const dayOrDate = updates.dayWord || updates.when || null;
        const recurringCommands = require('../recurringCommands');
        if (updates.skipCourt !== undefined || updates.unskipCourt !== undefined) {
          return await recurringCommands.handleSkipRecurringPollInstanceCourt(
            sock, effectiveChatId, sender, senderJid, chatSchedules[0][0], dayOrDate, updates.skipCourt || updates.unskipCourt, updates.unskipCourt !== undefined, context
          );
        }
        return await recurringCommands.handleOverrideRecurringPollInstanceSlots(
          sock, effectiveChatId, sender, senderJid, chatSchedules[0][0], dayOrDate, overrideSlotVal, context
        );
      }
      return '📅 No active match polls found to modify.';
    } else {
      const descriptions = chatPolls.map(([id, state]) => `\`${id}\` (${state.when || state.name || 'unnamed'})`).join(', ');
      return `Please specify which poll instance to modify: ${descriptions}. Example: "!modifyinstance ${chatPolls[0][0]} 12 7pm"`;
    }
  }

  if (!matchedPollState) {
    if (recurringPolls && recurringPolls.size > 0 && cleanTarget) {
      for (const [key, sched] of recurringPolls.entries()) {
        const sid = sched.id || sched.scheduleId || key;
        if (key.toLowerCase() === cleanTarget.toLowerCase() || sid.toLowerCase() === cleanTarget.toLowerCase()) {
          if (updates.skipCourt !== undefined || updates.unskipCourt !== undefined) {
            const dayOrDate = updates.dayWord || updates.when || null;
            const recurringCommands = require('../recurringCommands');
            return await recurringCommands.handleSkipRecurringPollInstanceCourt(
              sock, effectiveChatId, sender, senderJid, key, dayOrDate, updates.skipCourt || updates.unskipCourt, updates.unskipCourt !== undefined, context
            );
          }
          if (updates.size !== undefined || updates.type === 'opt_in' || updates.isExplicitOptIn) {
            const overrideSlotVal = (updates.type === 'opt_in' || updates.isExplicitOptIn)
              ? ((typeof updates.size === 'number' && updates.size > 0) ? `opt-in:${updates.size}` : 'opt-in')
              : updates.size;
            const dayOrDate = updates.dayWord || updates.when || null;
            const recurringCommands = require('../recurringCommands');
            return await recurringCommands.handleOverrideRecurringPollInstanceSlots(
              sock, effectiveChatId, sender, senderJid, key, dayOrDate, overrideSlotVal, context
            );
          }
        }
      }
      const isAllChat = !chatId || !chatId.endsWith('@g.us');
      const chatSchedules = [...recurringPolls.entries()].filter(([, s]) => isAllChat || s.remoteJid === effectiveChatId);
      if (chatSchedules.length === 1 && (updates.size !== undefined || updates.type === 'opt_in' || updates.isExplicitOptIn || updates.skipCourt !== undefined || updates.unskipCourt !== undefined)) {
        const overrideSlotVal = (updates.type === 'opt_in' || updates.isExplicitOptIn)
          ? ((typeof updates.size === 'number' && updates.size > 0) ? `opt-in:${updates.size}` : 'opt-in')
          : updates.size;
        const dayOrDate = updates.dayWord || updates.when || (isDayOrDateStr(cleanTarget) ? cleanTarget : null);
        const recurringCommands = require('../recurringCommands');
        if (updates.skipCourt !== undefined || updates.unskipCourt !== undefined) {
          return await recurringCommands.handleSkipRecurringPollInstanceCourt(
            sock, effectiveChatId, sender, senderJid, chatSchedules[0][0], dayOrDate, updates.skipCourt || updates.unskipCourt, updates.unskipCourt !== undefined, context
          );
        }
        return await recurringCommands.handleOverrideRecurringPollInstanceSlots(
          sock, effectiveChatId, sender, senderJid, chatSchedules[0][0], dayOrDate, overrideSlotVal, context
        );
      }
    }
    return `⚠️ No active match poll instance found matching "${cleanTarget}". Use "!activepolls" or "!pollstatus" to view active polls.`;
  }

  const schedId = getPollScheduleId(matchedPollState, recurringPolls);
  const sched = schedId ? recurringPolls.get(schedId) : null;
  const isSchedCreator = sched?.creator ? isSameUser(sched.creator.jid, senderJid, sched.creator.name, sender) : false;
  const isPollCreator = matchedPollState.creator ? isSameUser(matchedPollState.creator.jid, senderJid, matchedPollState.creator.name, sender) : false;
  const isAdmin = await isUserAdmin(sock, effectiveChatId, senderJid);

  if (matchedPollState && updates.dayWord) {
    const pWhen = (matchedPollState.when || matchedPollState.dayWord || '').toLowerCase();
    const targetDay = updates.dayWord.toLowerCase();
    if (!pWhen.includes(targetDay)) {
      const schedId = getPollScheduleId(matchedPollState, recurringPolls) || (cleanTarget && recurringPolls.has(cleanTarget) ? cleanTarget : null);
      if (schedId && (updates.skipCourt !== undefined || updates.unskipCourt !== undefined)) {
        const recurringCommands = require('../recurringCommands');
        return await recurringCommands.handleSkipRecurringPollInstanceCourt(
          sock, effectiveChatId, sender, senderJid, schedId, updates.dayWord, updates.skipCourt || updates.unskipCourt, updates.unskipCourt !== undefined, context
        );
      }
      if (schedId && (updates.size !== undefined || updates.type === 'opt_in' || updates.isExplicitOptIn)) {
        const overrideSlotVal = (updates.type === 'opt_in' || updates.isExplicitOptIn)
          ? ((typeof updates.size === 'number' && updates.size > 0) ? `opt-in:${updates.size}` : 'opt-in')
          : updates.size;
        const recurringCommands = require('../recurringCommands');
        return await recurringCommands.handleOverrideRecurringPollInstanceSlots(
          sock, effectiveChatId, sender, senderJid, schedId, updates.dayWord, overrideSlotVal, context
        );
      }
    }
  }

  if (!isSchedCreator && !isPollCreator && !isAdmin) {
    return '⚠️ Only the creator of this poll/schedule or group admins can modify this poll instance.';
  }

  const explicitOptInUpdate = updates.type === 'opt_in' || updates.type === 'opt-in' || updates.isExplicitOptIn === true || updates.isOptIn === true;
  const explicitSpotsUpdate = updates.type === 'spots' || updates.type === 'fixed' || updates.isOptIn === false;
  const isNextOptIn = explicitOptInUpdate
    ? true
    : (explicitSpotsUpdate || updates.size === 'auto' || (typeof updates.size === 'number' && updates.size > 0))
      ? false
      : (matchedPollState.type === 'opt_in');
  const isAuto = updates.size === 'auto' || (updates.size === undefined && matchedPollState.isAuto);
  let newSize = updates.size;
  if (newSize === undefined) {
    newSize = isAuto ? 'auto' : (matchedPollState.sessionTotalSize || matchedPollState.size);
  } else if (newSize === 'opt-in' || newSize === 'optin') {
    newSize = null;
  }

  let newWhen = updates.when || null;
  let newDayWord = updates.dayWord || null;
  let newTimeWord = updates.timeWord || null;

  if (newTimeWord && !newDayWord && matchedPollState.playAt) {
    const oldPlayAt = new Date(matchedPollState.playAt);
    if (!Number.isNaN(oldPlayAt.getTime())) {
      const weekday = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', weekday: 'long' }).format(oldPlayAt);
      newDayWord = weekday;
      newWhen = `${weekday} ${newTimeWord}`;
    }
  } else if (!newWhen && !newTimeWord && !newDayWord) {
    newWhen = matchedPollState.when;
  }

  const noMatchups = updates.noMatchups !== undefined ? updates.noMatchups : Boolean(matchedPollState.noMatchups);
  const checkCourts = updates.checkCourts !== undefined
    ? Boolean(updates.checkCourts)
    : (updates.includeCourts !== undefined
      ? Boolean(updates.includeCourts)
      : Boolean(matchedPollState.checkCourts));
  const includePrebookedSpots = updates.includePrebookedSpots !== undefined
    ? updates.includePrebookedSpots
    : Boolean(matchedPollState.prebookedPlayers && matchedPollState.prebookedPlayers.length > 0);

  const resolvedTitle = hasTitleUpdate ? (normalizePollTitle(updates[rawTitleKey]) || null) : (matchedPollState.title || null);
  const titleChanged = hasTitleUpdate && resolvedTitle !== (matchedPollState.title || null);
  const targetPollChatId = matchedPollState.remoteJid || effectiveChatId;
  const resolvedDefaultMaxOpts = normalizeMaxOptionsPerPoll(sched?.maxOptionsPerPoll) || groupsConfig.getMaxOptionsPerPoll(targetPollChatId) || DEFAULT_MAX_OPTIONS_PER_POLL;
  const prevEffMaxOpts = normalizeMaxOptionsPerPoll(matchedPollState.maxOptionsPerPoll, DEFAULT_MAX_OPTIONS_PER_POLL);
  const targetEffMaxOpts = hasMaxOptUpdate
    ? (parsedMaxOptUpdate || resolvedDefaultMaxOpts)
    : prevEffMaxOpts;
  const maxOptionsChanged = hasMaxOptUpdate && !matchedPollState.isManual && !isNextOptIn && matchedPollState.type !== 'multi_time' && targetEffMaxOpts !== prevEffMaxOpts;

  const hasStructuralChange = updates.size !== undefined ||
    updates.type !== undefined ||
    updates.isExplicitOptIn !== undefined ||
    updates.isOptIn !== undefined ||
    updates.when !== undefined ||
    updates.timeWord !== undefined ||
    updates.dayWord !== undefined ||
    updates.court !== undefined ||
    updates.courtBookingType !== undefined ||
    updates.preBookCourts !== undefined ||
    updates.bookingPlayers !== undefined ||
    updates.bookingCourtPreference !== undefined ||
    updates.maxCourts !== undefined ||
    maxOptionsChanged ||
    titleChanged;

  const inPlaceUpdates = [];
  const resolvedDefaultDuration = normalizeBookingDuration(sched?.bookingDuration) || groupsConfig.getBookingDuration(targetPollChatId) || 90;
  const targetEffDuration = hasDurationUpdate
    ? (parsedDurationUpdate || resolvedDefaultDuration)
    : (normalizeBookingDuration(matchedPollState.bookingDuration) || resolvedDefaultDuration);
  if (hasDurationUpdate) {
    const prevDur = normalizeBookingDuration(matchedPollState.bookingDuration) || null;
    if (parsedDurationUpdate) {
      matchedPollState.bookingDuration = parsedDurationUpdate;
      if (prevDur !== parsedDurationUpdate) {
        inPlaceUpdates.push(`Booking duration: *${formatBookingDuration(parsedDurationUpdate)}*`);
      }
    } else {
      delete matchedPollState.bookingDuration;
      if (prevDur !== null) {
        inPlaceUpdates.push(`Booking duration: *Default (${formatBookingDuration(targetEffDuration)})*`);
      }
    }
  }
  if (updates.bookingCourtPreference !== undefined) {
    if (updates.bookingCourtPreference === null) {
      delete matchedPollState.bookingCourtPreference;
      inPlaceUpdates.push("Court preference: *Reset to group default*");
    } else {
      matchedPollState.bookingCourtPreference = updates.bookingCourtPreference;
      inPlaceUpdates.push(`Court preference: *[${updates.bookingCourtPreference.join(", ")}]*`);
    }
  }
  if (updates.courtsStrategy !== undefined) {
    matchedPollState.courtsStrategy = updates.courtsStrategy;
    inPlaceUpdates.push(`Courts strategy: *${capitalize(updates.courtsStrategy)}*`);
  }
  if (updates.slotCheck !== undefined) {
    matchedPollState.slotCheck = Boolean(updates.slotCheck);
    if (matchedPollState.slotCheck === false) {
      matchedPollState.lastConflictSignature = null;
    }
    inPlaceUpdates.push(`Slot check: *${matchedPollState.slotCheck ? "Enabled" : "Disabled"}*`);
  }
  if (updates.lineupGeneration === undefined && (updates.noMatchups !== undefined || updates.autoMatchups !== undefined)) {
    const isNo = updates.noMatchups === true || updates.autoMatchups === false;
    updates.lineupGeneration = isNo ? "none" : "filled";
  }
  if (updates.lineupGeneration !== undefined) {
    const mode = updates.lineupGeneration;
    matchedPollState.lineupGeneration = mode;
    delete matchedPollState.noMatchups;
    delete matchedPollState.autoMatchups;
    inPlaceUpdates.push(`Lineup generation: *${formatLineupGenDesc(matchedPollState.lineupGeneration, matchedPollState.lineupLeadTime)}*`);
  }
  if (updates.lineupLeadTime !== undefined) {
    matchedPollState.lineupLeadTime = updates.lineupLeadTime;
    matchedPollState.lineupLeadTimeDisplay = formatLookAround(updates.lineupLeadTime);
    inPlaceUpdates.push(`Lineup lead time: *${formatLookAround(updates.lineupLeadTime) || updates.lineupLeadTime + " mins"}*`);
  }
  if (updates.reminders !== undefined) {
    const remindersOn = Boolean(updates.reminders);
    matchedPollState.reminders = remindersOn;
    inPlaceUpdates.push(`Reminders: *${remindersOn ? "On" : "Off"}*`);
  }
  if (updates.skipCourt !== undefined) {
    const courtsToSkip = recurringPollsModule.normalizeCourtList(updates.skipCourt);
    if (!Array.isArray(matchedPollState.skippedCourts)) {
      matchedPollState.skippedCourts = [];
    }
    for (const c of courtsToSkip) {
      if (!matchedPollState.skippedCourts.includes(c)) {
        matchedPollState.skippedCourts.push(c);
      }
    }
    if (Array.isArray(matchedPollState.unbookedCourts)) {
      matchedPollState.unbookedCourts = matchedPollState.unbookedCourts.filter(
        (uc) => !courtsToSkip.some((sc) => sc.toLowerCase() === uc.court?.toLowerCase() || sc.replace(/\D/g, '') === uc.court?.replace(/\D/g, ''))
      );
    }
    if (Array.isArray(matchedPollState.tentativeCourts)) {
      matchedPollState.tentativeCourts = matchedPollState.tentativeCourts.filter(
        (tc) => !courtsToSkip.some((sc) => sc.toLowerCase() === tc.court?.toLowerCase() || sc.replace(/\D/g, '') === tc.court?.replace(/\D/g, ''))
      );
    }
    if (sched && (matchedPollState.playAt || matchedPollState.targetDateKey)) {
      const dKey = matchedPollState.targetDateKey || pollTime.getSanJoseDateKey(new Date(matchedPollState.playAt));
      if (!sched.instanceCourtSkips) sched.instanceCourtSkips = {};
      sched.instanceCourtSkips[dKey] = matchedPollState.skippedCourts;
    }
    inPlaceUpdates.push(`Skipped Courts: *${matchedPollState.skippedCourts.join(', ')}*`);
  }
  if (updates.unskipCourt !== undefined) {
    const courtsToUnskip = recurringPollsModule.normalizeCourtList(updates.unskipCourt);
    if (courtsToUnskip.includes('all')) {
      delete matchedPollState.skippedCourts;
      if (sched && (matchedPollState.playAt || matchedPollState.targetDateKey)) {
        const dKey = matchedPollState.targetDateKey || pollTime.getSanJoseDateKey(new Date(matchedPollState.playAt));
        if (sched.instanceCourtSkips) {
          delete sched.instanceCourtSkips[dKey];
          if (Object.keys(sched.instanceCourtSkips).length === 0) delete sched.instanceCourtSkips;
        }
      }
      inPlaceUpdates.push(`Skipped Courts: *None (cleared)*`);
    } else if (Array.isArray(matchedPollState.skippedCourts)) {
      matchedPollState.skippedCourts = matchedPollState.skippedCourts.filter(
        (c) => !courtsToUnskip.some((uc) => uc.toLowerCase() === c.toLowerCase() || uc.replace(/\D/g, '') === c.replace(/\D/g, ''))
      );
      if (matchedPollState.skippedCourts.length === 0) {
        delete matchedPollState.skippedCourts;
        if (sched && (matchedPollState.playAt || matchedPollState.targetDateKey)) {
          const dKey = matchedPollState.targetDateKey || pollTime.getSanJoseDateKey(new Date(matchedPollState.playAt));
          if (sched.instanceCourtSkips) {
            delete sched.instanceCourtSkips[dKey];
            if (Object.keys(sched.instanceCourtSkips).length === 0) delete sched.instanceCourtSkips;
          }
        }
        inPlaceUpdates.push(`Skipped Courts: *None (cleared)*`);
      } else {
        if (sched && matchedPollState.playAt) {
          const dKey = pollTime.getSanJoseDateKey(new Date(matchedPollState.playAt));
          if (!sched.instanceCourtSkips) sched.instanceCourtSkips = {};
          sched.instanceCourtSkips[dKey] = matchedPollState.skippedCourts;
        }
        inPlaceUpdates.push(`Skipped Courts: *${matchedPollState.skippedCourts.join(', ')}*`);
      }
    }
  }

  if (matchedPollState.isManual) {
    // Manual polls were created directly in WhatsApp by users and are passively tracked.
    // The bot must NEVER recreate or post a new WhatsApp poll for a manual poll.
    if (updates.when !== undefined && updates.when && updates.when !== matchedPollState.when) {
      matchedPollState.when = updates.when;
      inPlaceUpdates.push(`Time/Day: *${updates.when}*`);
    }
    if (updates.size !== undefined || updates.type !== undefined || updates.isExplicitOptIn !== undefined || updates.isOptIn !== undefined) {
      const prevType = matchedPollState.type;
      const prevSize = matchedPollState.size;
      const targetType = isNextOptIn ? 'opt_in' : 'fixed';
      const targetSize = newSize ?? null;
      if (targetType !== prevType || targetSize !== prevSize) {
        matchedPollState.type = targetType;
        matchedPollState.size = targetSize;
        if (isNextOptIn && typeof targetSize === 'number' && targetSize > 0) {
          matchedPollState.slotLimit = targetSize;
        } else if (isNextOptIn) {
          delete matchedPollState.slotLimit;
        }
        inPlaceUpdates.push(`Format: *${isNextOptIn ? (targetSize ? `Opt-in (${targetSize} spots)` : 'Opt-in (Yes/No)') : `${targetSize} spots`}*`);
      }
    }
    if (updates.court !== undefined && updates.court !== matchedPollState.court) {
      matchedPollState.court = updates.court;
      inPlaceUpdates.push(`Court: *${updates.court || 'none'}*`);
    }
    if (titleChanged) {
      if (resolvedTitle) {
        matchedPollState.title = resolvedTitle;
        inPlaceUpdates.push(`Title: *${resolvedTitle}*`);
      } else {
        delete matchedPollState.title;
        inPlaceUpdates.push('Title: *None (cleared)*');
      }
    }

    if (inPlaceUpdates.length > 0) {
      delete matchedPollState.noMatchups;
      delete matchedPollState.autoMatchups;
      if (context.persistPolls) context.persistPolls();
      const pollTitle = matchedPollState.title || matchedPollState.when || matchedPollState.name || 'Match';
      const schedNote = schedId ? ` (Schedule: \`${schedId}\`)` : '';
      if (updates.slotCheck !== undefined && updates.lineupGeneration === undefined && updates.lineupLeadTime === undefined && updates.when === undefined && updates.size === undefined && updates.court === undefined && updates.reminders === undefined && !hasTitleUpdate && !hasDurationUpdate) {
        return `✅ Updated slot check for poll *${pollTitle}*${schedNote}: *${matchedPollState.slotCheck ? 'Enabled' : 'Disabled'}*.`;
      }
      return `✅ Updated configuration for manual poll *${pollTitle}*${schedNote}:\n• ${inPlaceUpdates.join('\n• ')}.\nWhatsApp poll message was kept intact.`;
    }
    return `ℹ️ No configuration changes were specified for manual poll *${matchedPollState.title || matchedPollState.when || matchedPollState.name || 'Match'}*. WhatsApp poll message was kept intact.`;
  }

  if (inPlaceUpdates.length > 0 && !hasStructuralChange) {
    if (hasDurationUpdate && Array.isArray(matchedPollState.advanceBookedCourts) && matchedPollState.advanceBookedCourts.length > 0) {
      const targetModDur = formatScvccDuration(targetEffDuration);
      for (const b of matchedPollState.advanceBookedCourts) {
        if (b.reservationId) {
          try {
            const modRes = await scvcc.modifyCourtBooking({
              reservationId: b.reservationId,
              duration: targetModDur,
              chatId: targetPollChatId
            });
            if (modRes && modRes.success) {
              b.duration = modRes.duration || targetModDur;
            }
          } catch (modErr) {
            console.error(`[poll] Failed to update SCVCC duration for reservation ${b.reservationId}:`, modErr.message);
          }
        } else {
          b.duration = targetModDur;
        }
      }
    }
    delete matchedPollState.noMatchups;
    delete matchedPollState.autoMatchups;
    if (context.persistPolls) context.persistPolls();
    const pollTitle = matchedPollState.title || matchedPollState.when || matchedPollState.name || "Match";
    const schedNote = schedId ? ` (Schedule: \`${schedId}\`)` : "";
    if (updates.slotCheck !== undefined && updates.lineupGeneration === undefined && updates.lineupLeadTime === undefined && !hasDurationUpdate && updates.reminders === undefined && updates.courtsStrategy === undefined && updates.bookingCourtPreference === undefined && updates.skipCourt === undefined && updates.unskipCourt === undefined) {
      return `✅ Updated slot check for poll *${pollTitle}*${schedNote}: *${matchedPollState.slotCheck ? "Enabled" : "Disabled"}*.`;
    }
    return `✅ Updated configuration for poll *${pollTitle}*${schedNote}:\n• ${inPlaceUpdates.join("\n• ")}.\nWhatsApp poll message was kept intact.`;
  }

  const creatorName = matchedPollState.creator?.name || sender;
  const creatorJid = matchedPollState.creator?.jid || senderJid;
  const includeCreator = Boolean(matchedPollState.creator);
  const isRecurring = Boolean(matchedPollState.isRecurring || schedId);

  const targetRemoteJid = matchedPollState.remoteJid || effectiveChatId;
  const newCourt = updates.court !== undefined ? updates.court : (matchedPollState.court || null);

  const courtBookingType = updates.courtBookingType !== undefined
    ? updates.courtBookingType
    : (matchedPollState.courtBookingType || null);
  const bookingPlayers = updates.bookingPlayers !== undefined
    ? updates.bookingPlayers
    : (matchedPollState.bookingPlayers || null);
  const explicitMaxCourtsUpdate = (updates.maxCourts !== undefined && updates.maxCourts !== null && parseInt(updates.maxCourts, 10) > 0)
    ? parseInt(updates.maxCourts, 10)
    : null;
  const preBookCourts = updates.preBookCourts !== undefined
    ? updates.preBookCourts
    : (updates.preBookCourtsCount !== undefined
      ? updates.preBookCourtsCount
      : (matchedPollState.explicitPreBookCourts ? matchedPollState.preBookCourts : (explicitMaxCourtsUpdate || matchedPollState.preBookCourts || null)));

  let preExistingBookings = null;
  if (Array.isArray(matchedPollState.advanceBookedCourts) && matchedPollState.advanceBookedCourts.length > 0) {
    if (updates.court || updates.timeWord || updates.dayWord || updates.when || hasDurationUpdate) {
      for (const b of matchedPollState.advanceBookedCourts) {
        if (b.reservationId) {
          try {
            const targetModCourt = updates.court ? formatCourtLabel(updates.court) : b.court;
            const targetModTime = updates.timeWord || b.time;
            const targetModDate = updates.dayWord || updates.when || b.date;
            const targetModDur = hasDurationUpdate ? formatScvccDuration(targetEffDuration) : undefined;
            const modRes = await scvcc.modifyCourtBooking({
              reservationId: b.reservationId,
              court: targetModCourt,
              time: targetModTime,
              date: targetModDate,
              ...(targetModDur ? { duration: targetModDur } : {}),
              chatId: targetRemoteJid
            });
            if (modRes && modRes.success) {
              b.court = modRes.court || targetModCourt;
              b.time = modRes.time || targetModTime;
              b.date = modRes.date || targetModDate;
              if (targetModDur || modRes.duration) b.duration = modRes.duration || targetModDur || b.duration;
              console.log(`[poll] Successfully modified SCVCC reservation ${b.reservationId} for poll instance:`, modRes.message);
            }
          } catch (modErr) {
            console.error(`[poll] Failed to modify SCVCC reservation ${b.reservationId} for poll instance:`, modErr.message);
          }
        }
      }
    }
    preExistingBookings = {
      advanceBookedCourts: matchedPollState.advanceBookedCourts,
      prebookedCourts: matchedPollState.prebookedCourts || []
    };
  } else if (Array.isArray(matchedPollState.prebookedCourts) && matchedPollState.prebookedCourts.length > 0) {
    preExistingBookings = {
      advanceBookedCourts: [],
      prebookedCourts: matchedPollState.prebookedCourts
    };
  }

  const preservedTimeSlots = updates.timeSlots ||
    ((matchedPollState.type === 'multi_time' && Array.isArray(matchedPollState.timeSlots) && updates.type !== 'opt_in' && !updates.when && !updates.timeWord && !updates.dayWord)
      ? matchedPollState.timeSlots.map((s) => ({
        dayWord: s.dayWord || null,
        timeWord: s.timeWord,
        timeDisplay: s.timeDisplay || s.timeWord,
        size: updates.size !== undefined ? newSize : s.size,
        explicitSize: updates.size !== undefined ? true : s.explicitSize
      }))
      : null);

  const res = await createMatchPoll(
    sock,
    targetRemoteJid,
    newSize,
    newWhen,
    newDayWord,
    newTimeWord,
    creatorName,
    creatorJid,
    includeCreator,
    matchedPollId,
    false,
    true,
    noMatchups,
    checkCourts,
    includePrebookedSpots,
    isRecurring,
    schedId,
    newCourt,
    courtBookingType,
    bookingPlayers,
    preBookCourts,
    null,
    preExistingBookings,
    context,
    {
      title: resolvedTitle,
      isOptIn: isNextOptIn,
      type: isNextOptIn ? 'opt_in' : 'spots',
      lookAround: updates.lookAround !== undefined ? updates.lookAround : (matchedPollState.lookAround || null),
      slotCheck: updates.slotCheck !== undefined ? updates.slotCheck : matchedPollState.slotCheck,
      lineupGeneration: updates.lineupGeneration !== undefined ? updates.lineupGeneration : matchedPollState.lineupGeneration,
      lineupLeadTime: updates.lineupLeadTime !== undefined ? updates.lineupLeadTime : matchedPollState.lineupLeadTime,
      maxCourts: updates.maxCourts !== undefined ? updates.maxCourts : (matchedPollState.maxCourts || null),
      bookingCourtPreference: updates.bookingCourtPreference !== undefined ? updates.bookingCourtPreference : (matchedPollState.bookingCourtPreference || null),
      courtsStrategy: updates.courtsStrategy !== undefined ? updates.courtsStrategy : (matchedPollState.courtsStrategy || null),
      timeSlots: preservedTimeSlots,
      multiVote: updates.multiVote !== undefined ? updates.multiVote : matchedPollState.multiVote,
      multiSessionMode: updates.multiSessionMode !== undefined ? updates.multiSessionMode : (matchedPollState.multiSessionMode || null),
      bookingDuration: hasDurationUpdate ? parsedDurationUpdate : (matchedPollState.bookingDuration ?? null)
      ,
      ...(hasMaxOptUpdate
        ? { maxOptionsPerPoll: parsedMaxOptUpdate }
        : (matchedPollState.maxOptionsPerPoll !== undefined ? { maxOptionsPerPoll: matchedPollState.maxOptionsPerPoll } : {}))
    }
  );

  if (res?.err) {
    if (res.noCourtsAvailable) {
      return null;
    }
    return `Could not modify poll instance: ${res.err}`;
  }

  const instanceTitle = res?.when || newWhen || matchedPollState.when || 'Match';
  const sizeDesc = res?.isOptIn ? (res?.size ? `Opt-in (Yes/No, ${res.size} spots max)` : 'Opt-in (Yes/No)') : `${res?.size || newSize} spots`;
  const schedNote = schedId ? ` (Schedule: \`${schedId}\`)` : '';
  const maxCourtsLine = (isAuto && res?.maxCourts) ? `\n• *Max Courts:* ${res.maxCourts}` : '';
  const titleLine = hasTitleUpdate ? `\n• *Title:* ${res?.title || 'None (cleared)'}` : (res?.title ? `\n• *Title:* ${res.title}` : '');

  const effLineupGen = res?.lineupGeneration || updates.lineupGeneration || matchedPollState.lineupGeneration || 'filled';
  const effLeadTime = res?.lineupLeadTime || updates.lineupLeadTime || matchedPollState.lineupLeadTime || 30;
  const effDur = res?.bookingDuration || targetEffDuration;
  const durationLine = (hasDurationUpdate || (effDur && effDur !== 90)) ? `\n• *Booking Duration:* ${formatBookingDuration(effDur)}` : '';
  const effMaxOpts = res?.maxOptionsPerPoll || targetEffMaxOpts;
  const maxOptionsLine = (hasMaxOptUpdate || (effMaxOpts && effMaxOpts < DEFAULT_MAX_OPTIONS_PER_POLL))
    ? `\n• *Max Options Per Poll:* ${effMaxOpts}${res?.isMultiPoll && Array.isArray(res?.batches) ? ` (batches: [${res.batches.join(', ')}])` : ''}`
    : '';

  return `✅ Modified recurring poll instance for *${instanceTitle}*${schedNote}:\n` +
    `${titleLine ? `${titleLine.slice(1)}\n` : ''}` +
    `• *Format:* ${sizeDesc}${maxCourtsLine}\n` +
    (durationLine ? `${durationLine.slice(1)}\n` : '') +
    (maxOptionsLine ? `${maxOptionsLine.slice(1)}\n` : '') +
    `• *Lineup Generation:* ${formatLineupGenDesc(effLineupGen, effLeadTime)}\n` +
    `Older poll was deleted from WhatsApp and replaced. (Note: Future recurring schedules remain unchanged).`;
}

async function handleSetPollSlots(sock, chatId, sender, senderJid, targetId, count, context, extraSlotTarget = null) {
  const { activePolls, recurringPolls, persistPolls } = context;
  const isDM = Boolean(chatId && !chatId.endsWith('@g.us'));
  const effectiveChatId = isDM ? (context.targetGroupJid || await getTargetGroupJid(sock) || chatId) : chatId;

  let cleanTarget = String(targetId || '').replace(/^["']|["']$/g, '').trim();
  let cleanCount = count;
  let slotFilterQuery = extraSlotTarget ? String(extraSlotTarget).trim() : null;

  if (!cleanCount && cleanTarget && (/^\d+$/.test(cleanTarget) || /^(?:reset|clear|none|unlimited|open)$/i.test(cleanTarget) || /^(?:opt-?in|optin|yes\/?no|yesno)(?::\d+)?$/i.test(cleanTarget))) {
    cleanCount = cleanTarget;
    cleanTarget = null;
  }

  const isDayOrDateStr = (str) => {
    if (!str) return false;
    const s = String(str).toLowerCase().trim();
    if (/^(?:today|tonight|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tue|wed|thu|fri|sat|sun|next|all)$/i.test(s)) return true;
    if (/^\d{1,2}\/\d{1,2}(?:\/\d{2,4})?$/.test(s)) return true;
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return true;
    return false;
  };

  if (recurringPolls && recurringPolls.size > 0 && cleanTarget) {
    for (const [k, s] of recurringPolls.entries()) {
      const sid = s.id || s.scheduleId || k;
      if (k.toLowerCase() === cleanTarget.toLowerCase() || sid.toLowerCase() === cleanTarget.toLowerCase()) {
        if (isDayOrDateStr(slotFilterQuery)) {
          const recurringCommands = require('../recurringCommands');
          return await recurringCommands.handleOverrideRecurringPollInstanceSlots(
            sock, chatId, sender, senderJid, k, slotFilterQuery, cleanCount, context
          );
        }
      }
    }
  }

  let matchedPollId = null;
  let matchedPollState = null;

  if (cleanTarget) {
    const cleanLower = cleanTarget.toLowerCase();

    for (const [id, state] of activePolls.entries()) {
      if ((state.remoteJid === effectiveChatId || isDM) && id.toLowerCase() === cleanLower) {
        matchedPollId = id;
        matchedPollState = state;
        break;
      }
    }

    if (!matchedPollState) {
      for (const [id, state] of activePolls.entries()) {
        if ((state.remoteJid === effectiveChatId || isDM) && (state.status === 'active' || state.status === 'filled' || state.status === 'stopped')) {
          const sid = getPollScheduleId(state, recurringPolls);
          if (sid && sid.toLowerCase() === cleanLower) {
            matchedPollId = id;
            matchedPollState = state;
            break;
          }
          if (state.scheduleId && state.scheduleId.toLowerCase() === cleanLower) {
            matchedPollId = id;
            matchedPollState = state;
            break;
          }
        }
      }
    }

    if (!matchedPollState) {
      for (const [id, state] of activePolls.entries()) {
        if ((state.remoteJid === effectiveChatId || isDM) && (state.status === 'active' || state.status === 'filled' || state.status === 'stopped')) {
          const pTitle = (state.title || '').toLowerCase();
          if (pTitle && pTitle === cleanLower) {
            matchedPollId = id;
            matchedPollState = state;
            break;
          }
        }
      }
    }
    if (!matchedPollState) {
      for (const [id, state] of activePolls.entries()) {
        if ((state.remoteJid === effectiveChatId || isDM) && (state.status === 'active' || state.status === 'filled' || state.status === 'stopped')) {
          const pName = (state.name || '').toLowerCase();
          const pTitle = (state.title || '').toLowerCase();
          const pWhen = (state.when || '').toLowerCase();
          if (pName.includes(cleanLower) || (pTitle && pTitle.includes(cleanLower)) || pWhen.includes(cleanLower) || (pWhen && cleanLower.includes(pWhen))) {
            matchedPollId = id;
            matchedPollState = state;
            break;
          }
        }
      }
    }
  } else {
    const chatPolls = [...activePolls.entries()].filter(([, state]) =>
      (state.remoteJid === effectiveChatId || isDM) && (state.status === 'active' || state.status === 'filled' || state.status === 'stopped')
    );
    if (chatPolls.length === 1) {
      matchedPollId = chatPolls[0][0];
      matchedPollState = chatPolls[0][1];
    } else if (chatPolls.length === 0) {
      const isAllChat = !chatId || !chatId.endsWith('@g.us');
      const chatSchedules = [...recurringPolls.entries()].filter(([, s]) => isAllChat || s.remoteJid === effectiveChatId);
      if (chatSchedules.length === 1 && cleanCount) {
        const recurringCommands = require('../recurringCommands');
        return await recurringCommands.handleOverrideRecurringPollInstanceSlots(
          sock, chatId, sender, senderJid, chatSchedules[0][0], null, cleanCount, context
        );
      }
      return '📅 No active match polls found on record.';
    } else {
      const descriptions = chatPolls.map(([id, state]) => `\`${id}\` (${state.when || state.name || 'unnamed'})`).join(', ');
      return `Please specify which poll instance to limit: ${descriptions}. Example: "!setslots ${chatPolls[0][0]} 8"`;
    }
  }

  if (!matchedPollState && cleanTarget) {
    const chatPolls = [...activePolls.entries()].filter(([, state]) =>
      (state.remoteJid === effectiveChatId || isDM) && (state.status === "active" || state.status === "filled" || state.status === "stopped")
    );
    const multiPolls = chatPolls.filter(([, state]) => state.type === "multi_time" && Array.isArray(state.timeSlots));
    if (multiPolls.length === 1) {
      matchedPollId = multiPolls[0][0];
      matchedPollState = multiPolls[0][1];
      slotFilterQuery = cleanTarget;
    }
  }

  if (matchedPollState && matchedPollState.type === "multi_time" && Array.isArray(matchedPollState.timeSlots) && cleanTarget && !slotFilterQuery) {
    const isIdMatch = matchedPollId && matchedPollId.toLowerCase() === cleanTarget.toLowerCase();
    const sId = getPollScheduleId(matchedPollState, recurringPolls);
    const isSchedMatch = (sId && sId.toLowerCase() === cleanTarget.toLowerCase()) ||
      (matchedPollState.scheduleId && matchedPollState.scheduleId.toLowerCase() === cleanTarget.toLowerCase());
    if (!isIdMatch && !isSchedMatch) {
      const q = cleanTarget.toLowerCase().trim();
      const parsedT = parseTimeString(q);
      const matchesSpecificSlot = matchedPollState.timeSlots.some((s) => {
        const l = (s.label || "").toLowerCase();
        const optL = (s.optionLabel || "").toLowerCase();
        const tw = (s.timeWord || "").toLowerCase();
        if (l === q || optL === q || tw === q || l.includes(q)) return true;
        if (parsedT && s.timeWord) {
          const sp = parseTimeString(s.timeWord);
          if (sp && sp.hour === parsedT.hour && sp.minute === parsedT.minute) return true;
        }
        return false;
      });
      if (matchesSpecificSlot) {
        slotFilterQuery = cleanTarget;
      }
    }
  }

  if (!matchedPollState) {
    if (recurringPolls && recurringPolls.size > 0) {
      let schedKey = null;
      let schedTarget = null;
      if (cleanTarget && recurringPolls.has(cleanTarget)) {
        schedKey = cleanTarget;
      } else {
        for (const [k, s] of recurringPolls.entries()) {
          const sid = s.id || s.scheduleId || k;
          if (cleanTarget && (k.toLowerCase() === cleanTarget.toLowerCase() || sid.toLowerCase() === cleanTarget.toLowerCase())) {
            schedKey = k;
            break;
          }
        }
        if (!schedKey) {
          const isAllChat = !chatId || !chatId.endsWith('@g.us');
          const chatSchedules = [...recurringPolls.entries()].filter(([, s]) => isAllChat || s.remoteJid === effectiveChatId);
          if (chatSchedules.length === 1) {
            schedKey = chatSchedules[0][0];
            schedTarget = cleanTarget;
          }
        }
      }
      if (schedKey) {
        const rawCombined = `${schedKey} ${schedTarget || ''} ${cleanCount || ''} ${slotFilterQuery || ''}`.trim();
        const extracted = recurringPollsModule.extractOverrideSlotsArgs(rawCombined);
        if (extracted.slots !== null) {
          const recurringCommands = require('../recurringCommands');
          return await recurringCommands.handleOverrideRecurringPollInstanceSlots(
            sock, chatId, sender, senderJid, extracted.scheduleId || schedKey, extracted.targetDayOrDate, extracted.slots, context
          );
        }
      }
    }
    return `⚠️ No active match poll instance found matching "${cleanTarget}". Use "!activepolls" or "!pollstatus" to view active polls.`;
  }

  const schedId = getPollScheduleId(matchedPollState, recurringPolls);
  const sched = schedId ? recurringPolls.get(schedId) : null;
  const isSchedCreator = sched?.creator ? isSameUser(sched.creator.jid, senderJid, sched.creator.name, sender) : false;
  const effectivePollCreator = matchedPollState.creator || matchedPollState.createdBy || null;
  const isPollCreator = effectivePollCreator ? isSameUser(effectivePollCreator.jid, senderJid, effectivePollCreator.name, sender) : false;
  const isAdmin = await isUserAdmin(sock, effectiveChatId, senderJid);

  if (!isSchedCreator && !isPollCreator && !isAdmin) {
    return '⚠️ Only the creator of this poll/schedule or group admins can set slot limits.';
  }

  if (matchedPollState.type === "multi_time" && Array.isArray(matchedPollState.timeSlots)) {
    const isReset = /^(?:reset|clear|none|unlimited|open|0)$/i.test(String(cleanCount || "").trim());
    const num = isReset ? null : parseInt(cleanCount, 10);
    if (!isReset && (!Number.isInteger(num) || num <= 0 || num > 40)) {
      return "Please provide a valid positive number of slots (1-40) or 'unlimited', e.g. \"!setslots 9:30am 8\" or \"!setslots 8\".";
    }

    let targetSlots = matchedPollState.timeSlots;
    if (slotFilterQuery) {
      const q = slotFilterQuery.toLowerCase().trim();
      const parsedT = parseTimeString(q);
      const matched = matchedPollState.timeSlots.filter((s) => {
        const l = (s.label || "").toLowerCase();
        const optL = (s.optionLabel || "").toLowerCase();
        const tw = (s.timeWord || "").toLowerCase();
        if (l.includes(q) || optL.includes(q) || tw === q) return true;
        if (parsedT && s.timeWord) {
          const sp = parseTimeString(s.timeWord);
          if (sp && sp.hour === parsedT.hour && sp.minute === parsedT.minute) return true;
        }
        return false;
      });
      if (matched.length === 0) {
        return `⚠️ No time slot matching "${slotFilterQuery}" found in poll "${matchedPollState.when || matchedPollId}".`;
      }
      targetSlots = matched;
    }

    for (const s of targetSlots) {
      if (s.originalSize === undefined) s.originalSize = s.size;
      s.slotLimit = num;
      s.size = num;
      if (isReset) s.lastExcessSignature = null;
    }

    const mePn = jidNormalizedUser(sock?.user?.id || sock?.authState?.creds?.me?.id || "");
    const { aggregated } = getPollVoters(matchedPollId, matchedPollState, mePn, context.messageStore);
    const slotRosters = resolveMultiTimePollRoster(matchedPollState, aggregated);
    const summaryLines = [];
    for (const sr of slotRosters) {
      if (!targetSlots.includes(sr.slot)) continue;
      if (sr.isAllFilled && sr.slot.status !== "resolved") {
        sr.slot.status = "filled";
        sr.slot.lastPlayers = sr.players;
      } else if (!sr.isAllFilled && sr.slot.status === "filled") {
        sr.slot.status = "active";
      }
      const capDesc = sr.slotLimit ? `${sr.filledCount}/${sr.slotLimit}` : `${sr.filledCount} (unlimited)`;
      const exNote = sr.excessPlayers.length > 0 ? ` [Waitlist: ${sr.excessPlayers.join(", ")}]` : "";
      summaryLines.push(`• *${sr.slot.label}*: ${capDesc} — ${sr.players.length ? sr.players.join(", ") : "None yet"}${exNote}`);
    }
    if (persistPolls) persistPolls();
    const limitDesc = isReset ? "unlimited" : `${num} spots`;
    return `🎯 Updated slot limit (${limitDesc}) for multi-time poll *${matchedPollState.when || matchedPollId}*:\n${summaryLines.join("\n")}`;
  }

  if (cleanCount === 'reset' || cleanCount === 'clear' || cleanCount === 'none' || cleanCount === 'unlimited' || cleanCount === 'open' || cleanCount === '0' || cleanCount === 0 || (typeof cleanCount === 'string' && /^(?:opt-?in|optin|yes\/?no|yesno)$/i.test(cleanCount.trim()))) {
    matchedPollState.slotLimit = null;
    if (matchedPollState.originalSize !== undefined) {
      matchedPollState.size = matchedPollState.originalSize;
    }
    if (typeof cleanCount === 'string' && /^(?:opt-?in|optin|yes\/?no|yesno|unlimited|open)$/i.test(cleanCount.trim()) && matchedPollState.type === 'opt_in') {
      matchedPollState.size = null;
    }
    matchedPollState.lastExcessSignature = null;
    persistPolls();
    return `🔄 Removed slot limit on poll "${matchedPollState.name || matchedPollState.when || matchedPollId}". Slots reverted to original size (${matchedPollState.size || 'default'}).`;
  }

  const optCapM = typeof cleanCount === 'string' ? cleanCount.trim().match(/^(?:opt-?in|optin|yes\/?no|yesno)[:\s]+(\d+)$/i) : null;
  const num = optCapM ? parseInt(optCapM[1], 10) : parseInt(cleanCount, 10);
  if (!Number.isInteger(num) || num <= 0) {
    return 'Please provide a valid positive number of slots, e.g. "!setslots rec_1 8" or "!setslots 8".';
  }

  if (num > 40) {
    return 'Slot limit cannot exceed 40 players.';
  }

  if (matchedPollState.originalSize === undefined) {
    matchedPollState.originalSize = matchedPollState.size;
  }
  matchedPollState.slotLimit = num;
  matchedPollState.size = num;

  const mePn = jidNormalizedUser(sock?.user?.id || sock?.authState?.creds?.me?.id || '');
  const { aggregated, interestedPlayers } = getPollVoters(matchedPollId, matchedPollState, mePn, context.messageStore);

  let players = [];
  let excessPlayers = [];
  let isAllFilled = false;
  let filledCount = 0;

  if (matchedPollState.type === 'opt_in' || matchedPollState.options?.some((o) => /^yes$/i.test(o))) {
    const yesOption = aggregated.find((o) => /^yes$/i.test(o.name.trim()));
    const yesVoters = yesOption ? yesOption.voters.map(nameFor) : interestedPlayers;
    players = yesVoters.slice(0, num);
    excessPlayers = yesVoters.slice(num);
    filledCount = players.length;
    isAllFilled = (yesVoters.length >= num);
  } else {
    const roster = resolveFixedPollRoster(matchedPollState, aggregated);
    players = roster.players;
    excessPlayers = roster.excessPlayers;
    filledCount = roster.filledCount;
    isAllFilled = roster.isAllFilled;
  }

  if (isAllFilled) {
    matchedPollState.status = 'filled';
    matchedPollState.lastPlayers = players;
  } else if (matchedPollState.status === 'filled') {
    matchedPollState.status = 'active';
  }

  let excessWarning = '';
  if (excessPlayers.length > 0) {
    matchedPollState.lastExcessSignature = excessPlayers.join('|');
    excessWarning = `\n⚠️ *Warning:* Votes from [${excessPlayers.join(', ')}] exceed the new ${num}-slot limit and will not be considered!`;
  }

  persistPolls();

  let autoMatchupNote = '';
  if (isAllFilled && !matchedPollState.isManual && isValidPlayerCount(players.length) && shouldAutoGenerateLineupOnFill(matchedPollState)) {
    matchedPollState.status = 'resolved';
    persistPolls();
    setTimeout(async () => {
      try {
        await ratings.ensureRated(players);
        const prebookedCourts = await getPrebookedCourtsForPoll(matchedPollState, matchedPollState.remoteJid);
        const schedule = generateMatchups(players, { prebookedCourts, chatId: matchedPollState.remoteJid });
        const whenHeader = formatMatchHeaderTime(matchedPollState);
        const header = whenHeader ? `📅 ${whenHeader}\n\n` : '';
        await sendMessageAndRecord(sock, matchedPollState.remoteJid, { text: header + formatMatchups(schedule) });
        pairHistory.recordDraw(matchedPollId, schedule, Date.now(), matchedPollState.remoteJid);
        const playAtMs = matchedPollState?.playAt ? new Date(matchedPollState.playAt).getTime() : Date.now();
        playerActivity.recordPlayed(players, playAtMs, matchedPollState.remoteJid);
        matchedPollState.lastSchedule = summarizeSchedule(schedule);
        persistPolls();
      } catch (err) {
        console.error('[poll] Auto matchups error after setslots:', err);
      }
    }, 500);
    autoMatchupNote = '\n🎉 Poll is now filled! Auto-generating matchups...';
  }

  const pollTitle = matchedPollState.when || matchedPollState.name || 'Match';
  const schedNote = schedId ? ` (Schedule: \`${schedId}\`)` : '';
  const statusNote = isAllFilled ? 'FILLED' : `${Math.max(0, num - filledCount)} spot(s) remaining`;

  return `🎯 Set slot limit for poll instance *${pollTitle}*${schedNote} to *${num} slots*:\n` +
    `• WhatsApp poll message was kept intact (not deleted).\n` +
    `• Slots filled: ${filledCount}/${num} (${statusNote}).\n` +
    `• Active roster (${players.length}): ${players.length ? players.join(', ') : 'None yet'}${excessWarning}${autoMatchupNote}`;
}

module.exports = {
  parseModifyInstanceCommand,
  handleModifyPollInstance,
  handleSetPollSlots
};
