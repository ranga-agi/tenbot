/**
 * Recurring Poll Schedule CRUD, Pause/Resume, and Formatting
 */

const pollTime = require('../pollTime');
const groupsConfig = require('../groupsConfig');
const { parseTimeString, parseLookAround, formatLookAround } = pollTime;
const facade = require('./facade');
const {
  DAY_NAMES,
  parseDaysOfWeek,
  parsePostTimes,
  getPostTimeForSchedule,
  parseDateToDateKey,
  normalizePollTitle
} = require('./dates');
const { extractPauseArgs } = require('./parsers');

function parseBoolOption(val) {
  const s = String(val).toLowerCase();
  return s === 'true' || val === true || s === 'yes' || s === 'on' || val === 1;
}

function applyPrebookedSpotFlags(target, enabled) {
  const boolVal = Boolean(enabled);
  target.includePrebookedSpots = boolVal;
  target['--pre-allocate-slots'] = boolVal;
  target['pre-allocate-slots'] = boolVal;
  target.preAllocateSlots = boolVal;
  target['prebooked-spots'] = boolVal;
  target.prebookedSpots = boolVal;
}

function applyPauseState(sched, enabled, parsedUntil = null) {
  sched.enabled = Boolean(enabled);
  if (!enabled && parsedUntil) {
    sched.pausedUntil = parsedUntil.dateKey;
    sched.pausedUntilDisplay = parsedUntil.display;
  } else {
    delete sched.pausedUntil;
    delete sched.pausedUntilDisplay;
  }
}

/**
 * Resolves the Map key for a recurring schedule ID using exact or case-insensitive lookup
 * across both Map keys and stored `id` / `scheduleId` fields.
 */
function findScheduleKey(recurringPolls, scheduleId) {
  if (!recurringPolls || !scheduleId) return null;
  const cleanId = String(scheduleId).trim();
  if (!cleanId) return null;
  if (recurringPolls.has(cleanId)) return cleanId;
  const lower = cleanId.toLowerCase();
  for (const [key, sched] of recurringPolls.entries()) {
    const sid = sched?.id || sched?.scheduleId || key;
    if (key.toLowerCase() === lower || String(sid).toLowerCase() === lower) {
      return key;
    }
  }
  return null;
}

function formatRecurringScheduleCard(s, idx = null, total = 1, customSanJoseParts = null) {
  const isMultiTime = Boolean(s.isMultiTime || (Array.isArray(s.timeSlots) && s.timeSlots.length >= 2));
  const spotDesc = isMultiTime
    ? `Multi-time (${s.timeSlots.length} time slots, ${s.multiVote !== false ? 'multiple votes' : 'single vote'}, ${s.multiSessionMode === 'single_session' ? '1 session/player' : 'independent sessions'})`
    : (s.size
      ? (s.size === 'auto' ? 'auto spots (Doubles)' : `${s.size} spots (${s.size === 2 ? 'Singles' : 'Doubles'})`)
      : 'Opt-in (Yes/No)');
  const creatorDesc = isMultiTime
    ? ''
    : (s.includeCreator
      ? ` (auto-including ${s.creator?.name || 'creator'} as Player 1)`
      : (s.size ? ' (all spots open)' : ''));
  const effectiveLineupGen = s.lineupGeneration || 'filled';
  const daysStr = s.daysDisplay || (parseDaysOfWeek(s.days || s.daysList).display);
  const effectiveParts = (customSanJoseParts && typeof customSanJoseParts === 'object')
    ? customSanJoseParts
    : ((total && typeof total === 'object') ? total : ((idx && typeof idx === 'object') ? idx : null));
  const sj = effectiveParts || pollTime.getSanJoseParts();
  const todayKey = `${sj.year}-${String(sj.month + 1).padStart(2, '0')}-${String(sj.day).padStart(2, '0')}`;

  const postTimeStr = (s.postDisplay || s.postTime || '8:00 AM').includes('in this group')
    ? (s.postDisplay || s.postTime || '8:00 AM')
    : `${s.postDisplay || s.postTime || '8:00 AM'} in this group`;

  let statusStr = s.enabled ? '✅ Active' : (s.pausedUntilDisplay ? `⏸️ Paused (until ${s.pausedUntilDisplay})` : (s.pausedUntil ? `⏸️ Paused (until ${s.pausedUntil})` : '⏸️ Paused'));
  if (s.oneTime && s.completed) {
    statusStr = `🏁 Completed (posted on ${s.lastPostedDate || s.lastPostedMatchDate || todayKey})`;
  } else if (s.oneTime && s.enabled) {
    statusStr = `⏳ Scheduled to post ${postTimeStr}`;
  } else if ((s.endDate && todayKey > s.endDate) || s.ended) {
    statusStr = `🏁 Ended (${s.endDateDisplay || s.endDate})`;
  } else if (s.startDate && todayKey < s.startDate && s.enabled) {
    statusStr = `⏳ Scheduled (starts ${s.startDateDisplay || s.startDate})`;
  }

  let dateRangeLines = '';
  if (!s.oneTime) {
    if (s.startDateDisplay || s.startDate) {
      dateRangeLines += `\n• *Start Date:* ${s.startDateDisplay || s.startDate}`;
    }
    if (s.endDateDisplay || s.endDate) {
      dateRangeLines += `\n• *End Date:* ${s.endDateDisplay || s.endDate}`;
    }
  }

  const titlePrefix = total > 1 && idx !== null ? `${idx + 1}. ` : '';

  const isPrebooked = Boolean(s.includePrebookedSpots || s['--pre-allocate-slots'] || s['pre-allocate-slots'] || s.preAllocateSlots || s['prebooked-spots'] || s.prebookedSpots);
  const prebookedDesc = isPrebooked ? 'Enabled' : 'Disabled';

  let skippedNote = '';
  if (Array.isArray(s.skippedMatchDates) && s.skippedMatchDates.length > 0) {
    const upcomingSkipped = s.skippedMatchDates.filter((d) => d >= todayKey);
    if (upcomingSkipped.length > 0) {
      skippedNote = `\n• *Skipped Instance(s):* ⏭️ ${upcomingSkipped.join(', ')}`;
    }
  }

  const effStrategy = s.bookingStrategy || null;
  const effCourtsStrategy = s.courtsStrategy || (s.courtBookingType === 'pre-book' || effStrategy === 'advanced' || Boolean(s.bookingSchedule) ? 'book' : (s.checkCourts ? 'lookup' : 'none'));
  const isPreBook = effCourtsStrategy === 'book';
  const courtsStrategyDesc = effCourtsStrategy === 'book' ? 'Book' : (effCourtsStrategy === 'lookup' ? 'Lookup' : 'None');
  const groupCfg = s.remoteJid ? groupsConfig.getGroupConfig(s.remoteJid) : null;
  const explicitMaxCourts = s.maxCourts || s['max-courts'] || s['--max-courts'] || null;
  const maxCourtsDesc = explicitMaxCourts
    ? String(explicitMaxCourts)
    : (s.size && typeof s.size === 'number' && effCourtsStrategy !== 'none'
      ? `${Math.ceil(s.size / 4)} (from size)`
      : (groupCfg?.maxCourts ? `${groupCfg.maxCourts} (group default)` : 'None'));

  const scheduleCourtPref = (s.bookingCourtPreference && s.bookingCourtPreference.length > 0) ? s.bookingCourtPreference : null;
  const groupCourtPref = (groupCfg?.bookingCourtPreference && groupCfg.bookingCourtPreference.length > 0) ? groupCfg.bookingCourtPreference : null;
  const courtPrefLine = scheduleCourtPref
    ? `\n• *Booking Court Preference:* [${scheduleCourtPref.join(', ')}]`
    : (groupCourtPref ? `\n• *Booking Court Preference:* [${groupCourtPref.join(', ')}] (group default)` : '');

  let slotOverridesNote = '';
  if (s.instanceSlotOverrides && typeof s.instanceSlotOverrides === 'object') {
    const upcomingOverrides = Object.entries(s.instanceSlotOverrides)
      .filter(([d]) => d >= todayKey)
      .map(([d, count]) => `${d} → ${count === null || count === 'opt-in' ? 'Opt-in' : `${count} slots`}`);
    if (upcomingOverrides.length > 0) {
      slotOverridesNote = `\n• *Slot Override(s):* 🎯 ${upcomingOverrides.join(', ')}`;
    }
  }

  let courtSkipsNote = '';
  if (s.instanceCourtSkips && typeof s.instanceCourtSkips === 'object') {
    const upcomingSkips = Object.entries(s.instanceCourtSkips)
      .filter(([d, courts]) => d >= todayKey && Array.isArray(courts) && courts.length > 0)
      .map(([d, courts]) => `${d} → Skip ${courts.join(', ')}`);
    if (upcomingSkips.length > 0) {
      courtSkipsNote = `\n• *Skipped Court(s):* 🚫 ${upcomingSkips.join(', ')}`;
    }
  }

  let courtBookingLine = '';
  if (effStrategy === 'advanced' || s.bookingSchedule) {
    const schedStr = s.bookingSchedule || (s.bookingScheduleParsed?.display ? `${s.bookingScheduleParsed.daysBefore} days before at ${s.bookingScheduleParsed.display}` : '-7days 7:00AM');
    courtBookingLine = `\n• *Court Booking:* Advanced (${schedStr})${s.preBookCourts ? ` (${s.preBookCourts} courts)` : ''}${s.bookingPlayers && s.bookingPlayers.length > 0 ? ` (${s.bookingPlayers.map((l, i) => `Court ${i + 1}: [${l.join(', ')}]`).join(', ')})` : ' (group default)'}`;
  } else if (isPreBook) {
    courtBookingLine = `\n• *Court Booking:* Pre-book in advance${s.preBookCourts ? ` (${s.preBookCourts} courts)` : ''}${s.bookingPlayers && s.bookingPlayers.length > 0 ? ` (${s.bookingPlayers.map((l, i) => `Court ${i + 1}: [${l.join(', ')}]`).join(', ')})` : ' (group default)'}`;
  }

  const cardTitle = s.oneTime
    ? `📅 *${titlePrefix}Scheduled Match Poll (ID: \`${s.id}\`):*`
    : `📅 *${titlePrefix}Scheduled Recurring Poll (ID: \`${s.id}\`):*`;
  const customTitleLine = s.title ? `\n• *Title:* ${s.title}` : '';
  const daysLine = s.oneTime
    ? `• *Match Date:* ${s.targetMatchDateDisplay || s.startDateDisplay || (s.startDate ? `${daysStr} (${s.startDate})` : daysStr)}`
    : `• *Days:* ${daysStr}`;

  return `${cardTitle}${customTitleLine}\n` +
    `• *Match Time:* ${s.matchDisplay}\n` +
    `${daysLine}` +
    dateRangeLines +
    `\n` +
    `• *Post Time:* ${postTimeStr}\n` +
    `• *Format:* ${spotDesc}${creatorDesc}\n` +
    `• *Lineup Generation:* ${effectiveLineupGen === 'fallback' ? `Fallback if no manual lineups posted (${formatLookAround(s.lineupLeadTime || 30) || '30 mins'} before)` : (effectiveLineupGen === 'none' ? 'None (manual only)' : 'Filled')}\n` +
    `• *Prebooked Spots:* ${prebookedDesc}\n` +
    `• *Courts Strategy:* ${courtsStrategyDesc}` +
    courtBookingLine +
    (s.lookAround ? `\n• *Look Around:* ${s.lookAroundDisplay || formatLookAround(s.lookAround)}` : '') +
    `\n• *Slot Check:* ${s.slotCheck === false ? 'Disabled' : 'Enabled'}` +
    `\n• *Max Courts:* ${maxCourtsDesc}` +
    courtPrefLine +
    `\n• *Reminders:* ${s.reminders === false ? 'Off' : 'On'}` +
    `\n• *Status:* ${statusStr}${skippedNote}${slotOverridesNote}${courtSkipsNote}`;
}

/**
 * Creates and registers a new recurring poll schedule.
 */
async function scheduleRecurringPoll({ recurringPolls, persistPolls, targetChatId, sender, senderJid, params }) {
  const { size, matchTime, postTime, postTimesByDay, days, includeCreator, autoMatchups, noMatchups, checkCourts, includeCourts, considerCourts, courtBookingType, bookingType, bookingPlayers, bookingNames, bookingStrategy, bookingSchedule, startDate, endDate, lookAround, courtsStrategy, courtStrategy } = params || {};

  let cleanStartDate = null;
  let cleanStartDateDisplay = null;
  if (startDate) {
    const parsedStart = parseDateToDateKey(startDate);
    if (!parsedStart) {
      return `Could not understand start date "${startDate}". Please specify a valid date (e.g. "10/15/2026", "2026-10-15", "Oct 15", "tomorrow").`;
    }
    cleanStartDate = parsedStart.dateKey;
    cleanStartDateDisplay = parsedStart.display;
  }

  let cleanEndDate = null;
  let cleanEndDateDisplay = null;
  if (endDate) {
    const parsedEnd = parseDateToDateKey(endDate);
    if (!parsedEnd) {
      return `Could not understand end date "${endDate}". Please specify a valid date (e.g. "11/15/2026", "2026-11-15", "Nov 15").`;
    }
    if (parsedEnd.isPast) {
      return `The specified end date (${parsedEnd.display}) has already passed in San Jose. Please specify an upcoming date.`;
    }
    cleanEndDate = parsedEnd.dateKey;
    cleanEndDateDisplay = parsedEnd.display;
  }

  if (cleanStartDate && cleanEndDate && cleanStartDate > cleanEndDate) {
    return `The start date (${cleanStartDateDisplay}) cannot be after the end date (${cleanEndDateDisplay}).`;
  }

  const groupCfg = groupsConfig.getGroupConfig(targetChatId);
  const rawCourtsStrategy = courtsStrategy || courtStrategy || params?.['courts-strategy'] || params?.['court-strategy'] || null;
  let cleanCourtsStrategy = null;
  if (rawCourtsStrategy) {
    const s = String(rawCourtsStrategy).trim().toLowerCase();
    if (['book', 'lookup', 'none'].includes(s)) {
      cleanCourtsStrategy = s;
    }
  }
  if (!cleanCourtsStrategy) {
    const rawBookingType = courtBookingType || bookingType || null;
    const normalizedBookingType = (rawBookingType && String(rawBookingType).trim().toLowerCase().replace(/_/g, '-')) || null;
    if (normalizedBookingType === 'pre-book' || normalizedBookingType === 'prebook') {
      cleanCourtsStrategy = 'book';
    } else if (Boolean(checkCourts ?? includeCourts ?? considerCourts)) {
      cleanCourtsStrategy = 'lookup';
    } else {
      cleanCourtsStrategy = groupCfg?.courtsStrategy || 'none';
    }
  }
  const cleanBookingType = cleanCourtsStrategy === 'book' ? 'pre-book' : 'none';
  const cleanBookingPlayers = groupsConfig.normalizeBookingPlayerLists(bookingPlayers || bookingNames);
  const rawMaxCourts = params?.maxCourts ?? params?.['max-courts'] ?? params?.['--max-courts'] ?? params?.max_courts;
  const cleanMaxCourts = (rawMaxCourts !== undefined && rawMaxCourts !== null && parseInt(rawMaxCourts, 10) > 0)
    ? parseInt(rawMaxCourts, 10)
    : null;
  const explicitPreBookCourts = (params?.preBookCourts !== undefined && params?.preBookCourts !== null && parseInt(params.preBookCourts, 10) > 0)
    ? parseInt(params.preBookCourts, 10)
    : (params?.preBookCourtsCount !== undefined && params?.preBookCourtsCount !== null && parseInt(params.preBookCourtsCount, 10) > 0
      ? parseInt(params.preBookCourtsCount, 10)
      : null);
  const sizeCourts = (size && typeof size === 'number' && size > 0)
    ? Math.ceil(size / 4)
    : (params?.size && typeof params.size === 'number' && params.size > 0
      ? Math.ceil(params.size / 4)
      : null);
  const cleanPreBookCourts = explicitPreBookCourts || cleanMaxCourts || sizeCourts || groupCfg?.preBookCourts || null;
  const rawBookingCourtPref = params?.bookingCourtPreference ?? params?.courtPreference ?? params?.['booking-court-preference'] ?? params?.['court-preference'];
  const cleanBookingCourtPref = rawBookingCourtPref !== undefined && rawBookingCourtPref !== null
    ? (Array.isArray(rawBookingCourtPref) ? rawBookingCourtPref.map(String) : String(rawBookingCourtPref).replace(/^\[|\]$/g, '').split(/[,;\s]+/).map((s) => s.trim()).filter(Boolean))
    : null;

  const effectiveStrategy = bookingStrategy || params?.bookingStrategy || groupCfg?.bookingStrategy || (cleanBookingType === 'pre-book' ? 'poll-creation' : null);
  const effectiveBookingSchedule = bookingSchedule || params?.bookingSchedule || groupCfg?.bookingSchedule || null;
  const parsedBookingSchedule = groupsConfig.parseBookingSchedule(effectiveBookingSchedule);
  const cleanLookAround = parseLookAround(lookAround || params?.lookAround || groupCfg?.lookAround || null);
  const effectiveReminders = params?.reminders !== undefined ? parseBoolOption(params.reminders) : true;
  const includePrebookedSpots = (params?.['--pre-allocate-slots'] !== undefined || params?.['pre-allocate-slots'] !== undefined)
    ? parseBoolOption(params['--pre-allocate-slots'] ?? params['pre-allocate-slots'])
    : (params?.preAllocateSlots !== undefined
      ? Boolean(params.preAllocateSlots)
      : (params?.['prebooked-spots'] !== undefined
        ? parseBoolOption(params['prebooked-spots'])
        : (params?.prebookedSpots !== undefined
          ? Boolean(params.prebookedSpots)
          : Boolean(params?.includePrebookedSpots))));

  let resolvedTimeSlots = Array.isArray(params?.timeSlots) && params.timeSlots.length >= 2
    ? params.timeSlots
    : (matchTime ? pollTime.parseMultiTimeSlots(matchTime, null, size) : null);

  const effectiveMatchTimeStr = (resolvedTimeSlots && resolvedTimeSlots.length >= 2)
    ? resolvedTimeSlots[0].timeWord
    : matchTime;

  if (!effectiveMatchTimeStr) {
    return 'Please provide a match time for the recurring poll (e.g. "!recurringpoll 4 7pm at 8am on weekdays" or "!recurringpoll 4 7pm monday at sunday 6pm").';
  }

  const parsedMatch = parseTimeString(effectiveMatchTimeStr);
  if (!parsedMatch) {
    return `Could not understand match time "${effectiveMatchTimeStr}". Please specify a time like "7pm", "9am", or "6:30pm".`;
  }

  const parsedDays = parseDaysOfWeek(days || params?.daysList || 'everyday');
  const parsedPostTimes = parsePostTimes(postTimesByDay || postTime, parsedMatch, parsedDays.days);
  if (!parsedPostTimes) {
    return `Could not understand post time "${postTime}". Please specify a time like "8am", "sunday 6pm", or "1 day before at 6pm".`;
  }

  let validSize = null;
  if (size === 'auto' || String(size).toLowerCase() === 'auto') {
    validSize = 'auto';
  } else if (size !== undefined && size !== null) {
    const num = parseInt(size, 10);
    if (Number.isFinite(num) && num > 0) {
      validSize = num;
    }
  }

  const finalLineupGen = params?.lineupGeneration || params?.['lineup-generation'] || (
    params?.noMatchups === true || params?.autoMatchups === false || noMatchups === true || autoMatchups === false
      ? 'none'
      : 'filled'
  );

  const scheduleId = `rec_${Date.now().toString(36)}`;
  const isMultiTimeSched = Array.isArray(resolvedTimeSlots) && resolvedTimeSlots.length >= 2;
  if (isMultiTimeSched) {
    resolvedTimeSlots = resolvedTimeSlots.map((s) => ({
      ...s,
      size: s.explicitSize ? s.size : (s.size !== undefined && s.size !== null ? s.size : validSize)
    }));
  }
  const multiMatchDisplay = isMultiTimeSched
    ? resolvedTimeSlots.map((s) => `${s.dayWord ? s.dayWord + ' ' : ''}${s.timeDisplay || s.timeWord}${s.size === 'auto' ? ' (auto)' : (typeof s.size === 'number' ? ` (${s.size})` : '')}`).join(', ')
    : parsedMatch.display;

  const rawTitle = params?.title ?? params?.pollTitle ?? params?.['poll-title'] ?? params?.poll_title ?? params?.customTitle;
  const cleanTitle = normalizePollTitle(rawTitle) || null;

  const scheduleObj = {
    id: scheduleId,
    remoteJid: targetChatId,
    title: cleanTitle,
    size: validSize,
    isMultiTime: isMultiTimeSched,
    timeSlots: isMultiTimeSched ? resolvedTimeSlots : null,
    multiVote: params?.multiVote !== undefined && params?.multiVote !== null ? Boolean(params.multiVote) : (groupCfg?.multiVote !== undefined ? Boolean(groupCfg.multiVote) : true),
    multiSessionMode: (params?.multiVote === false) ? 'single_session' : (params?.multiSessionMode || groupCfg?.multiSessionMode || 'single_session'),
    matchTime: parsedMatch.formatted,
    matchDisplay: multiMatchDisplay,
    matchHour: parsedMatch.hour,
    matchMinute: parsedMatch.minute,
    postTime: parsedPostTimes.defaultPost.formatted,
    postDisplay: parsedPostTimes.display,
    postHour: parsedPostTimes.defaultPost.hour,
    postMinute: parsedPostTimes.defaultPost.minute,
    postTimesByDay: parsedPostTimes.postTimesByDay,
    days: parsedDays.raw,
    daysList: parsedDays.days,
    daysDisplay: parsedDays.display,
    includeCreator: Boolean(includeCreator),
    courtsStrategy: cleanCourtsStrategy,
    preBookCourts: cleanPreBookCourts,
    explicitPreBookCourts: explicitPreBookCourts !== null,
    bookingPlayers: cleanBookingPlayers,
    bookingStrategy: effectiveStrategy ? String(effectiveStrategy).toLowerCase() : null,
    bookingSchedule: effectiveBookingSchedule,
    bookingScheduleParsed: parsedBookingSchedule,
    lookAround: cleanLookAround,
    lookAroundDisplay: formatLookAround(cleanLookAround),
    advanceBookings: {},
    slotCheck: (params?.slotCheck !== undefined && params?.slotCheck !== null) ? Boolean(params.slotCheck) : true,
    lineupGeneration: finalLineupGen,
    lineupLeadTime: params?.lineupLeadTime || 30,
    startDate: cleanStartDate,
    startDateDisplay: cleanStartDateDisplay,
    endDate: cleanEndDate,
    endDateDisplay: cleanEndDateDisplay,
    reminders: effectiveReminders,
    maxCourts: cleanMaxCourts,
    bookingCourtPreference: cleanBookingCourtPref,
    oneTime: Boolean(params?.oneTime || params?.isOneTime),
    targetMatchDateKey: params?.targetMatchDateKey || null,
    targetMatchDateDisplay: params?.targetMatchDateDisplay || null,
    enabled: true,
    createdAt: new Date().toISOString(),
    lastPostedDate: null,
    lastPostedMatchDate: null,
    postedMatchDates: [],
    creator: { name: sender !== 'Someone' ? sender : 'Player', jid: senderJid || null }
  };
  applyPrebookedSpotFlags(scheduleObj, includePrebookedSpots);

  recurringPolls.set(scheduleId, scheduleObj);
  persistPolls();

  const spotDesc = validSize ? `${validSize} spots (${validSize === 2 ? 'Singles' : 'Doubles'})` : 'Opt-in (Yes/No)';
  console.log(`[recurring-poll] Created recurring poll schedule ${scheduleId}: ${spotDesc} for ${parsedMatch.display} (${parsedDays.display}), posting at ${parsedPostTimes.display} in ${targetChatId}, lineupGeneration: ${finalLineupGen}`);

  const helpCmds = scheduleObj.oneTime
    ? `Use "!recurringpolls" to view scheduled polls, or "!cancelrecurringpoll ${scheduleId}" to cancel.`
    : `Use "!recurringpolls" to view all schedules, "!modifyrecurringpoll ${scheduleId} ..." to modify, or "!cancelrecurringpoll ${scheduleId}" to cancel.`;
  return `${formatRecurringScheduleCard(scheduleObj)}\n\n${helpCmds}`;
}

/**
 * Modifies an existing recurring poll schedule.
 */
async function modifyRecurringPoll({ recurringPolls, persistPolls, activePolls, sender, scheduleId, updates = {} }) {
  const cleanId = String(scheduleId || '').trim();
  if (!cleanId) {
    return 'Please provide the schedule ID to modify, e.g. "!modifyrecurringpoll rec_1 8 6pm at 7am mon-thu" (see "!recurringpolls" for active IDs).';
  }

  const targetKey = findScheduleKey(recurringPolls, cleanId);
  if (!targetKey) {
    return `Schedule ID "\`${cleanId}\`" was not found. Use "!recurringpolls" to view active schedules.`;
  }

  const sched = recurringPolls.get(targetKey);
  const changes = [];

  const rawTitleKey = ['title', 'pollTitle', 'poll-title', 'poll_title', 'customTitle'].find((k) => updates[k] !== undefined);
  if (rawTitleKey !== undefined) {
    const nextTitle = normalizePollTitle(updates[rawTitleKey]) || null;
    const prevTitle = sched.title || null;
    if (nextTitle !== prevTitle) {
      sched.title = nextTitle;
      changes.push(`Title: ${prevTitle || 'None'} → *${nextTitle || 'None (cleared)'}*`);
    }
  }

  if (Array.isArray(updates.timeSlots) && updates.timeSlots.length >= 2) {
    sched.isMultiTime = true;
    sched.timeSlots = updates.timeSlots;
    const firstParsed = parseTimeString(updates.timeSlots[0].timeWord);
    if (firstParsed) {
      sched.matchTime = firstParsed.formatted;
      sched.matchHour = firstParsed.hour;
      sched.matchMinute = firstParsed.minute;
    }
    const newDisplay = updates.timeSlots.map((s) => `${s.dayWord ? s.dayWord + ' ' : ''}${s.timeDisplay || s.timeWord}${s.size === 'auto' ? ' (auto)' : (typeof s.size === 'number' ? ` (${s.size})` : '')}`).join(', ');
    if (sched.matchDisplay !== newDisplay) {
      changes.push(`Match Time Slots: ${sched.matchDisplay} → *${newDisplay}*`);
      sched.matchDisplay = newDisplay;
    }
  } else if (updates.matchTime) {
    const parsedMatch = parseTimeString(updates.matchTime);
    if (!parsedMatch) {
      return `Could not understand match time "${updates.matchTime}". Please specify a time like "7pm", "9am", or "6:30pm".`;
    }
    const oldDisplay = sched.matchDisplay;
    sched.matchTime = parsedMatch.formatted;
    sched.matchDisplay = parsedMatch.display;
    sched.matchHour = parsedMatch.hour;
    sched.matchMinute = parsedMatch.minute;
    if (oldDisplay !== sched.matchDisplay) {
      changes.push(`Match Time: ${oldDisplay} → *${sched.matchDisplay}*`);
    }
  }

  // Update days if provided
  if (updates.days || updates.daysList) {
    const parsedDays = parseDaysOfWeek(updates.days || updates.daysList);
    const oldDisplay = sched.daysDisplay || sched.days;
    sched.days = parsedDays.raw;
    sched.daysList = parsedDays.days;
    sched.daysDisplay = parsedDays.display;
    if (oldDisplay !== sched.daysDisplay) {
      changes.push(`Days: ${oldDisplay} → *${sched.daysDisplay}*`);
    }
  }

  // Update post time if provided
  if (updates.postTime || updates.postTimesByDay) {
    const parsedPostTimes = parsePostTimes(updates.postTimesByDay || updates.postTime, sched, sched.daysList);
    if (!parsedPostTimes) {
      return `Could not understand post time "${updates.postTime}". Please specify a time like "8am", "sunday 6pm", or "1 day before at 6pm".`;
    }
    const oldDisplay = sched.postDisplay;
    sched.postTime = parsedPostTimes.defaultPost.formatted;
    sched.postDisplay = parsedPostTimes.display;
    sched.postHour = parsedPostTimes.defaultPost.hour;
    sched.postMinute = parsedPostTimes.defaultPost.minute;
    sched.postTimesByDay = parsedPostTimes.postTimesByDay;
    if (oldDisplay !== sched.postDisplay) {
      changes.push(`Post Time: ${oldDisplay} → *${sched.postDisplay}*`);
    }
  } else if ((updates.days || updates.daysList) && sched.postTimesByDay) {
    const refreshed = parsePostTimes(sched.postTimesByDay, sched, sched.daysList);
    if (refreshed && refreshed.display !== sched.postDisplay) {
      sched.postDisplay = refreshed.display;
    }
  }

  // Update size if provided
  if (updates.isExplicitOptIn || updates.type === 'opt_in') {
    const oldSizeDesc = sched.size ? `${sched.size} spots` : 'Opt-in';
    sched.size = null;
    if (oldSizeDesc !== 'Opt-in') {
      changes.push(`Format: ${oldSizeDesc} → *Opt-in (Yes/No)*`);
    }
  } else if (updates.size === 'auto' || String(updates.size).toLowerCase() === 'auto') {
    const oldSizeDesc = sched.size ? (sched.size === 'auto' ? 'Auto-calculated' : `${sched.size} spots`) : 'Opt-in';
    sched.size = 'auto';
    changes.push(`Format: ${oldSizeDesc} → *Auto-calculated spots (4, 8, or 12 based on prebooked/free courts)*`);
  } else if (updates.size !== undefined && updates.size !== null) {
    const num = parseInt(updates.size, 10);
    if (Number.isFinite(num) && num > 0) {
      const oldSizeDesc = sched.size ? (sched.size === 'auto' ? 'Auto-calculated' : `${sched.size} spots`) : 'Opt-in';
      sched.size = num;
      if (!sched.explicitPreBookCourts) {
        sched.preBookCourts = sched.maxCourts || Math.ceil(num / 4);
      }
      const newSizeDesc = `${num} spots (${num === 2 ? 'Singles' : 'Doubles'})`;
      if (oldSizeDesc !== newSizeDesc) {
        changes.push(`Format: ${oldSizeDesc} → *${newSizeDesc}*`);
      }
    }
  }

  // Update courtsStrategy if provided
  if (updates.courtsStrategy !== undefined || updates.courtStrategy !== undefined || updates['courts-strategy'] !== undefined || updates['court-strategy'] !== undefined) {
    const rawStrat = updates.courtsStrategy ?? updates.courtStrategy ?? updates['courts-strategy'] ?? updates['court-strategy'];
    if (rawStrat && ['book', 'lookup', 'none'].includes(String(rawStrat).toLowerCase().trim())) {
      const newStrat = String(rawStrat).toLowerCase().trim();
      if (sched.courtsStrategy !== newStrat) {
        sched.courtsStrategy = newStrat;
        sched.courtBookingType = newStrat === 'book' ? 'pre-book' : 'none';
        sched.checkCourts = newStrat === 'book' || newStrat === 'lookup';
        changes.push(`Courts Strategy: *${newStrat.charAt(0).toUpperCase() + newStrat.slice(1)}*`);
      }
    }
  } else if (updates.courtBookingType !== undefined || updates.bookingType !== undefined) {
    const rawBT = updates.courtBookingType !== undefined ? updates.courtBookingType : updates.bookingType;
    const normBT = (rawBT && String(rawBT).trim().toLowerCase().replace(/_/g, '-')) || 'none';
    const newStrat = (normBT === 'pre-book' || normBT === 'prebook') ? 'book' : 'none';
    sched.courtsStrategy = newStrat;
    sched.courtBookingType = (normBT === 'pre-book' || normBT === 'prebook') ? 'pre-book' : 'none';
    sched.checkCourts = newStrat === 'book';
    changes.push(`Courts Strategy: *${newStrat.charAt(0).toUpperCase() + newStrat.slice(1)}*`);
  }

  if (updates.bookingPlayers !== undefined || updates.bookingNames !== undefined) {
    sched.bookingPlayers = groupsConfig.normalizeBookingPlayerLists(updates.bookingPlayers !== undefined ? updates.bookingPlayers : updates.bookingNames);
    changes.push(`Booking Players: *${sched.bookingPlayers.map((l, i) => `Court ${i + 1}: [${l.join(', ')}]`).join(', ')}*`);
  }

  if (updates.preBookCourts !== undefined || updates.preBookCourtsCount !== undefined) {
    const rawVal = updates.preBookCourts !== undefined ? updates.preBookCourts : updates.preBookCourtsCount;
    const val = parseInt(rawVal, 10);
    if (Number.isInteger(val) && val > 0) {
      sched.preBookCourts = val;
      sched.explicitPreBookCourts = true;
      changes.push(`Pre-book Courts: *${val}*`);
    } else {
      delete sched.preBookCourts;
      delete sched.explicitPreBookCourts;
      if (sched.maxCourts) sched.preBookCourts = sched.maxCourts;
      else if (sched.size && typeof sched.size === 'number' && sched.size > 0) sched.preBookCourts = Math.ceil(sched.size / 4);
      changes.push(`Pre-book Courts: *default*`);
    }
  }

  if (updates.bookingStrategy !== undefined) {
    const rawVal = updates.bookingStrategy;
    const newStrategy = (rawVal && String(rawVal).trim().toLowerCase() !== 'none' && String(rawVal).trim().toLowerCase() !== 'null') ? String(rawVal).trim().toLowerCase() : null;
    if (sched.bookingStrategy !== newStrategy) {
      sched.bookingStrategy = newStrategy;
      changes.push(`Booking Strategy: *${newStrategy || 'default'}*`);
    }
  }

  if (updates.bookingSchedule !== undefined) {
    const rawVal = updates.bookingSchedule;
    if (rawVal && String(rawVal).trim() !== '' && String(rawVal).trim().toLowerCase() !== 'null') {
      sched.bookingSchedule = rawVal;
      sched.bookingScheduleParsed = groupsConfig.parseBookingSchedule(rawVal);
      changes.push(`Booking Schedule: *${rawVal}*`);
    } else {
      delete sched.bookingSchedule;
      delete sched.bookingScheduleParsed;
      changes.push(`Booking Schedule: *default*`);
    }
  }

  if (updates.maxCourts !== undefined) {
    const rawVal = updates.maxCourts;
    const val = parseInt(rawVal, 10);
    if (Number.isInteger(val) && val > 0) {
      sched.maxCourts = val;
      if (!sched.explicitPreBookCourts && updates.preBookCourts === undefined && updates.preBookCourtsCount === undefined) {
        sched.preBookCourts = val;
      }
      changes.push(`Max Courts: *${val}*`);
    } else {
      delete sched.maxCourts;
      if (!sched.explicitPreBookCourts && updates.preBookCourts === undefined && updates.preBookCourtsCount === undefined) {
        if (sched.size && typeof sched.size === 'number' && sched.size > 0) {
          sched.preBookCourts = Math.ceil(sched.size / 4);
        } else {
          const gCfg = groupsConfig.getGroupConfig(sched.remoteJid);
          sched.preBookCourts = gCfg?.preBookCourts || null;
        }
      }
      changes.push(`Max Courts: *None (default)*`);
    }
  }

  if (updates.lookAround !== undefined) {
    const rawVal = updates.lookAround;
    if (rawVal === null || /^(?:none|clear|remove|null|0|false)$/i.test(String(rawVal).trim())) {
      if (sched.lookAround) {
        delete sched.lookAround;
        delete sched.lookAroundDisplay;
        changes.push('Look Around: *Removed*');
      }
    } else {
      const parsedLA = parseLookAround(rawVal);
      if (parsedLA) {
        sched.lookAround = parsedLA;
        sched.lookAroundDisplay = formatLookAround(parsedLA);
        changes.push(`Look Around: *${sched.lookAroundDisplay}*`);
      }
    }
  }

  if (updates.slotCheck !== undefined) {
    const newSlotCheck = Boolean(updates.slotCheck);
    sched.slotCheck = newSlotCheck;
    changes.push('Slot check: *' + (newSlotCheck ? 'Enabled' : 'Disabled') + '*');
  }

  if (updates.lineupGeneration !== undefined) {
    const mode = updates.lineupGeneration;
    sched.lineupGeneration = mode;
    delete sched.noMatchups;
    delete sched.autoMatchups;
    const desc = (mode === 'fallback')
      ? `Fallback if no manual lineups posted (${formatLookAround(sched.lineupLeadTime || 30) || '30 mins'} before)`
      : (mode === 'none' ? 'None (manual only)' : 'Filled');
    changes.push(`Lineup generation: *${desc}*`);
  }
  if (updates.lineupLeadTime !== undefined) {
    sched.lineupLeadTime = updates.lineupLeadTime;
    changes.push(`Lineup lead time: *${formatLookAround(updates.lineupLeadTime) || updates.lineupLeadTime + ' mins'}*`);
  }

  if (updates.autoMatchups !== undefined || updates.noMatchups !== undefined) {
    const newAuto = updates.autoMatchups !== undefined ? Boolean(updates.autoMatchups) : !Boolean(updates.noMatchups);
    const mode = newAuto ? 'filled' : 'none';
    if (updates.lineupGeneration === undefined && sched.lineupGeneration !== mode) {
      sched.lineupGeneration = mode;
      const desc = mode === 'none' ? 'None (manual only)' : 'Filled';
      changes.push(`Lineup generation: *${desc}*`);
    }
    delete sched.noMatchups;
    delete sched.autoMatchups;
  }

  if (updates.includeCreator !== undefined) {
    const newInclude = Boolean(updates.includeCreator);
    if (sched.includeCreator !== newInclude) {
      sched.includeCreator = newInclude;
      changes.push(`Auto-include creator: *${newInclude ? 'Yes' : 'No'}*`);
    }
  }

  if (updates.checkCourts !== undefined || updates.includeCourts !== undefined || updates.considerCourts !== undefined) {
    const newCheckCourts = Boolean(updates.checkCourts ?? updates.includeCourts ?? updates.considerCourts);
    if (sched.checkCourts !== newCheckCourts) {
      sched.checkCourts = newCheckCourts;
      delete sched.noCourts;
      changes.push(`Court availability check: *${newCheckCourts ? 'Enabled' : 'Disabled'}*`);
    }
  }

  if (updates.startDate !== undefined) {
    const rawVal = updates.startDate;
    if (rawVal === null || /^(?:none|clear|remove|null)$/i.test(String(rawVal).trim())) {
      if (sched.startDate) {
        delete sched.startDate;
        delete sched.startDateDisplay;
        changes.push('Start Date: *Removed*');
      }
    } else {
      const parsedStart = parseDateToDateKey(rawVal);
      if (!parsedStart) {
        return `Could not understand start date "${rawVal}". Please specify a valid date (e.g. "10/15/2026", "2026-10-15", "Oct 15").`;
      }
      const effEndKey = (updates.endDate !== undefined && updates.endDate !== null && !/^(?:none|clear|remove|null)$/i.test(String(updates.endDate).trim()))
        ? (parseDateToDateKey(updates.endDate)?.dateKey || sched.endDate)
        : sched.endDate;

      if (effEndKey && parsedStart.dateKey > effEndKey) {
        return `The start date (${parsedStart.display}) cannot be after the end date (${sched.endDateDisplay || effEndKey}).`;
      }
      sched.startDate = parsedStart.dateKey;
      sched.startDateDisplay = parsedStart.display;
      changes.push(`Start Date: *${parsedStart.display}*`);
    }
  }

  if (updates.endDate !== undefined) {
    const rawVal = updates.endDate;
    if (rawVal === null || /^(?:none|clear|remove|null)$/i.test(String(rawVal).trim())) {
      if (sched.endDate) {
        delete sched.endDate;
        delete sched.endDateDisplay;
        changes.push('End Date: *Removed*');
      }
    } else {
      const parsedEnd = parseDateToDateKey(rawVal);
      if (!parsedEnd) {
        return `Could not understand end date "${rawVal}". Please specify a valid date (e.g. "11/15/2026", "2026-11-15", "Nov 15").`;
      }
      if (parsedEnd.isPast) {
        return `The specified end date (${parsedEnd.display}) has already passed in San Jose. Please specify an upcoming date.`;
      }
      const effStartKey = sched.startDate;
      if (effStartKey && effStartKey > parsedEnd.dateKey) {
        return `The end date (${parsedEnd.display}) cannot be before the start date (${sched.startDateDisplay || effStartKey}).`;
      }
      sched.endDate = parsedEnd.dateKey;
      sched.endDateDisplay = parsedEnd.display;
      changes.push(`End Date: *${parsedEnd.display}*`);
    }
  }

  const prebookedUpdate = updates?.['--pre-allocate-slots'] !== undefined
    ? updates['--pre-allocate-slots']
    : (updates?.['pre-allocate-slots'] !== undefined
      ? updates['pre-allocate-slots']
      : (updates?.preAllocateSlots !== undefined
        ? updates.preAllocateSlots
        : (updates?.['prebooked-spots'] !== undefined
          ? updates['prebooked-spots']
          : (updates?.prebookedSpots !== undefined
            ? updates.prebookedSpots
            : updates?.includePrebookedSpots))));

  if (prebookedUpdate !== undefined) {
    const newPrebooked = parseBoolOption(prebookedUpdate);
    if (sched.includePrebookedSpots !== newPrebooked || sched['pre-allocate-slots'] !== newPrebooked || sched['prebooked-spots'] !== newPrebooked) {
      applyPrebookedSpotFlags(sched, newPrebooked);
      changes.push(`Named pre-allocated slots in poll: *${newPrebooked ? 'Enabled' : 'Disabled'}*`);
    }
  }

  if (updates?.bookingCourtPreference !== undefined || updates?.courtPreference !== undefined || updates?.['booking-court-preference'] !== undefined || updates?.['court-preference'] !== undefined) {
    const rawPref = updates.bookingCourtPreference !== undefined ? updates.bookingCourtPreference : (updates.courtPreference !== undefined ? updates.courtPreference : (updates['booking-court-preference'] !== undefined ? updates['booking-court-preference'] : updates['court-preference']));
    if (rawPref === null || /^(?:none|clear|remove|default|null|0|false)$/i.test(String(rawPref).trim())) {
      if (sched.bookingCourtPreference) {
        delete sched.bookingCourtPreference;
        changes.push('Booking Court Preference: *Removed (using group default)*');
      }
    } else {
      const cleanPref = Array.isArray(rawPref) ? rawPref.map(String) : String(rawPref).replace(/^\[|\]$/g, '').split(/[,;\s]+/).map((s) => s.trim()).filter(Boolean);
      sched.bookingCourtPreference = cleanPref;
      changes.push(`Booking Court Preference: *[${cleanPref.join(', ')}]*`);
    }
  }

  if (updates?.reminders !== undefined) {
    const newReminders = parseBoolOption(updates.reminders);
    if (sched.reminders !== newReminders) {
      sched.reminders = newReminders;
      changes.push(`Reminders for poll instances: *${newReminders ? 'On' : 'Off'}*`);
    }
  }
  if (updates?.multiVote !== undefined && updates?.multiVote !== null) {
    const newMV = Boolean(updates.multiVote);
    if (sched.multiVote !== newMV) {
      sched.multiVote = newMV;
      changes.push(`Vote Mode: *${newMV ? 'Multiple time slots allowed' : 'Single time slot only'}*`);
    }
    if (!newMV && updates?.multiSessionMode === undefined && sched.multiSessionMode !== 'single_session') {
      sched.multiSessionMode = 'single_session';
      changes.push('Session Mode: *Single session per player*');
    }
  }
  if (updates?.multiSessionMode !== undefined && updates?.multiSessionMode !== null) {
    const newMSM = (sched.multiVote === false) ? 'single_session' : updates.multiSessionMode;
    if (sched.multiSessionMode !== newMSM) {
      sched.multiSessionMode = newMSM;
      changes.push(`Session Mode: *${newMSM === 'single_session' ? 'Single session per player' : 'Independent sessions'}*`);
    }
  }

  if (changes.length === 0) {
    return `ℹ️ Schedule \`${targetKey}\` is already configured with those settings (no changes needed):\n\n` +
      formatRecurringScheduleCard(sched);
  }

  sched.updatedAt = new Date().toISOString();

  if (activePolls instanceof Map) {
    let syncedPollCount = 0;
    for (const [, pollState] of activePolls.entries()) {
      if (pollState && (pollState.scheduleId === targetKey || pollState.scheduleId === sched.id) && (pollState.status === 'active' || pollState.status === 'filled')) {
        if (updates.lineupGeneration !== undefined || updates.autoMatchups !== undefined || updates.noMatchups !== undefined) {
          pollState.lineupGeneration = sched.lineupGeneration;
          delete pollState.noMatchups;
          delete pollState.autoMatchups;
        }
        if (updates.lineupLeadTime !== undefined) {
          pollState.lineupLeadTime = sched.lineupLeadTime;
          pollState.lineupLeadTimeDisplay = formatLookAround(sched.lineupLeadTime) || `${sched.lineupLeadTime} mins`;
        }
        if (updates.courtsStrategy !== undefined || updates.courtStrategy !== undefined || updates['courts-strategy'] !== undefined || updates['court-strategy'] !== undefined) {
          pollState.courtsStrategy = sched.courtsStrategy;
        }
        if (updates.slotCheck !== undefined) {
          pollState.slotCheck = sched.slotCheck;
        }
        if (updates.reminders !== undefined) {
          pollState.reminders = sched.reminders !== false;
        }
        if (updates.bookingCourtPreference !== undefined || updates.courtPreference !== undefined || updates?.['booking-court-preference'] !== undefined || updates?.['court-preference'] !== undefined) {
          pollState.bookingCourtPreference = sched.bookingCourtPreference || null;
        }
        if (updates.lookAround !== undefined) {
          pollState.lookAround = sched.lookAround || null;
          pollState.lookAroundDisplay = sched.lookAroundDisplay || null;
        }
        if (rawTitleKey !== undefined) {
          pollState.title = sched.title || null;
        }
        syncedPollCount++;
      }
    }
    if (syncedPollCount > 0) {
      console.log(`[recurring-poll] Synced configuration updates from schedule ${targetKey} to ${syncedPollCount} active poll instance(s)`);
    }
  }

  persistPolls();

  console.log(`[recurring-poll] Modified recurring poll schedule ${targetKey} by ${sender}: ${changes.join(', ')}`);

  return `✏️ *Updated Recurring Poll Schedule (ID: \`${targetKey}\`):*\n` +
    changes.map((c) => `• ${c}`).join('\n') +
    `\n\n` +
    formatRecurringScheduleCard(sched);
}

/**
 * Lists all recurring poll schedules for the given chat.
 */
function listRecurringPolls({ recurringPolls, chatId }) {
  const isAll = !chatId || !chatId.endsWith('@g.us');
  let list = [...recurringPolls.values()];
  if (!isAll) {
    list = list.filter((s) => s.remoteJid === chatId);
  }

  if (list.length === 0) {
    return '📅 No recurring match polls scheduled yet. Use "!recurringpoll [size] <matchTime> [at <postTime>] [days]" (e.g. "!recurringpoll 4 7pm at 8am on weekdays" or "!recurringpoll 4 7pm monday at sunday 6pm") to schedule one.';
  }

  const cards = list.map((s, i) => formatRecurringScheduleCard(s, i, list.length));

  return `${cards.join('\n\n')}\n\n_Manage with !modifyrecurringpoll <id> ..., !cancelrecurringpoll <id> (or !clearallrecurringpolls)_`;
}

/**
 * Gets and formats status information for a specific recurring poll schedule.
 * Returns only the schedule configuration card and not the instance.
 */
function getRecurringPollStatus({ recurringPolls, scheduleId, chatId }) {
  const cleanId = String(scheduleId || '').replace(/^["']|["']$/g, '').trim();
  if (!cleanId) {
    return listRecurringPolls({ recurringPolls, chatId });
  }

  const targetKey = findScheduleKey(recurringPolls, cleanId);
  if (!targetKey) {
    return `⚠️ Recurring schedule ID "\`${cleanId}\`" was not found. Use "!recurringpolls" to view all active schedule IDs.`;
  }

  const targetSched = recurringPolls.get(targetKey);
  const actionCmd = targetSched.enabled ? `!pauserecurringpoll ${targetSched.id || cleanId}` : `!resumerecurringpoll ${targetSched.id || cleanId}`;
  return `${formatRecurringScheduleCard(targetSched)}\n\n_Manage with ${actionCmd}, !modifyrecurringpoll ${targetSched.id || cleanId} ..., !cancelrecurringpoll ${targetSched.id || cleanId}_`;
}

function isAdvanceBookingEntryExpired(dateKey, entry, sched, nowMs) {
  const parts = String(dateKey || '').split('-').map(Number);
  if (parts.length !== 3 || parts.some((n) => Number.isNaN(n))) return false;

  const mTime = entry?.matchTime || sched.matchTime || '7:00 PM';
  const parsedTime = parseTimeString(mTime) || { hour: 19, minute: 0 };
  let latestHour = parsedTime.hour;
  let latestMinute = parsedTime.minute;

  const courts = entry?.autoBookedCourts || entry?.advanceBookedCourts || [];
  if (Array.isArray(courts)) {
    for (const c of courts) {
      if (c?.time) {
        const cp = parseTimeString(c.time);
        if (cp && (cp.hour > latestHour || (cp.hour === latestHour && cp.minute > latestMinute))) {
          latestHour = cp.hour;
          latestMinute = cp.minute;
        }
      }
    }
  }

  const playAt = pollTime.createSanJoseDate(parts[0], parts[1] - 1, parts[2], latestHour, latestMinute);
  return nowMs >= playAt.getTime();
}

function isPollCreatedForDateFallback(sched, targetMatchDateKey, activePolls = null) {
  if (!sched || !targetMatchDateKey) return false;
  if (Array.isArray(sched.postedMatchDates) && sched.postedMatchDates.includes(targetMatchDateKey)) {
    return true;
  }
  if (sched.lastPostedMatchDate === targetMatchDateKey) {
    return true;
  }
  if (sched.advanceBookings?.[targetMatchDateKey]?.pollCreated) {
    return true;
  }
  if (activePolls) {
    for (const [, state] of activePolls.entries()) {
      if (state.status === 'cancelled') continue;
      if (state.remoteJid === sched.remoteJid) {
        if (!state.scheduleId || state.scheduleId.toLowerCase() === sched.id?.toLowerCase()) {
          if (state.playAt) {
            const playDate = new Date(state.playAt);
            if (!Number.isNaN(playDate.getTime())) {
              const sjParts = pollTime.getSanJoseParts(playDate);
              const pKey = `${sjParts.year}-${String(sjParts.month + 1).padStart(2, '0')}-${String(sjParts.day).padStart(2, '0')}`;
              if (pKey === targetMatchDateKey) {
                return true;
              }
            }
          }
        }
      }
    }
  }
  return false;
}

/**
 * Formats upcoming advance court bookings tracked on recurring poll schedules.
 */
function listRecurringAdvanceBookings({ recurringPolls, activePolls = null, chatId = null, scheduleId = null, allowedScheduleIds = null, customSanJoseParts = null }) {
  const cleanIdRaw = scheduleId ? String(scheduleId).replace(/^["'`]|["'`]$/g, '').trim() : '';
  const cleanId = /^all$/i.test(cleanIdRaw) ? '' : cleanIdRaw;

  const sj = customSanJoseParts || pollTime.getSanJoseParts();
  const nowMs = pollTime.createSanJoseDate(sj.year, sj.month, sj.day, sj.hour || 0, sj.minute || 0).getTime();

  const entriesList = recurringPolls instanceof Map ? [...recurringPolls.entries()] : [];
  const allowedSet = allowedScheduleIds
    ? new Set((Array.isArray(allowedScheduleIds) ? allowedScheduleIds : [...allowedScheduleIds]).map((id) => String(id).toLowerCase()))
    : null;

  let selectedSchedules = [];
  if (cleanId) {
    const targetKey = findScheduleKey(recurringPolls, cleanId);
    if (!targetKey) {
      return `⚠️ Recurring schedule ID "\`${cleanId}\`" was not found. Use "!recurringpolls" to view all active schedule IDs.`;
    }
    const sched = recurringPolls.get(targetKey);
    if (allowedSet && !allowedSet.has(targetKey.toLowerCase()) && !(sched?.id && allowedSet.has(String(sched.id).toLowerCase()))) {
      return '⚠️ Only the creator of this recurring poll or group admins can view its advance bookings.';
    }
    selectedSchedules = [[targetKey, sched]];
  } else {
    const isAll = !chatId || !chatId.endsWith('@g.us');
    const chatSchedules = entriesList.filter(([k, s]) => {
      if (!s || (!isAll && s.remoteJid !== chatId)) return false;
      if (allowedSet && !allowedSet.has(String(k).toLowerCase()) && !(s.id && allowedSet.has(String(s.id).toLowerCase()))) {
        return false;
      }
      return true;
    });
    if (chatSchedules.length === 0) {
      return '📅 No recurring match polls scheduled yet. Use "!recurringpoll [size] <matchTime> [days] --booking-strategy=advanced --booking-schedule="-7days 7:00AM"" to schedule one with advance booking.';
    }
    selectedSchedules = chatSchedules.filter(([, s]) => {
      const hasAdvEntries = s.advanceBookings && Object.entries(s.advanceBookings).some(
        ([dKey, entry]) => entry && !isAdvanceBookingEntryExpired(dKey, entry, s, nowMs)
      );
      const isAdvConfigured = s.bookingStrategy === 'advanced' || Boolean(s.bookingSchedule);
      return hasAdvEntries || isAdvConfigured;
    });
    if (selectedSchedules.length === 0) {
      return '📅 No advance court bookings found for any recurring poll schedules in this chat.';
    }
  }

  const checkPollCreated = facade.call('isPollCreatedForMatchDate', isPollCreatedForDateFallback);
  const byDate = new Map();
  const waitingSchedules = [];
  const unconfiguredSchedules = [];

  for (const [key, s] of selectedSchedules) {
    const sid = s.id || key;
    const isAdvConfigured = s.bookingStrategy === 'advanced' || Boolean(s.bookingSchedule);
    const activeEntries = (s.advanceBookings && typeof s.advanceBookings === 'object')
      ? Object.entries(s.advanceBookings)
        .filter(([dateKey, entry]) => entry && !isAdvanceBookingEntryExpired(dateKey, entry, s, nowMs))
        .sort(([a], [b]) => a.localeCompare(b))
      : [];

    if (activeEntries.length === 0) {
      if (isAdvConfigured) {
        waitingSchedules.push({ key, sid, sched: s });
      } else {
        unconfiguredSchedules.push({ key, sid, sched: s });
      }
      continue;
    }

    for (const [dateKey, entry] of activeEntries) {
      if (!byDate.has(dateKey)) {
        byDate.set(dateKey, []);
      }
      byDate.get(dateKey).push({ key, sid, sched: s, entry });
    }
  }

  const sections = [];
  const sortedDateKeys = [...byDate.keys()].sort((a, b) => a.localeCompare(b));

  for (const dateKey of sortedDateKeys) {
    const items = byDate.get(dateKey);
    const parts = dateKey.split('-').map(Number);
    let dayIdx = null;
    let dateDisplay = items[0]?.entry?.targetDateMDY || dateKey;
    if (parts.length === 3 && !parts.some((n) => Number.isNaN(n))) {
      const utcDate = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2], 12, 0, 0));
      dayIdx = utcDate.getUTCDay();
      const mdyFallback = `${String(parts[1]).padStart(2, '0')}/${String(parts[2]).padStart(2, '0')}/${parts[0]}`;
      dateDisplay = `${DAY_NAMES[dayIdx]}, ${items[0]?.entry?.targetDateMDY || mdyFallback}`;
    }

    // Sort entries within the same day by match time, then schedule ID
    items.sort((a, b) => {
      const aTimeStr = a.entry.matchTime || a.sched.matchTime || '7:00 PM';
      const bTimeStr = b.entry.matchTime || b.sched.matchTime || '7:00 PM';
      const aParsed = parseTimeString(aTimeStr);
      const bParsed = parseTimeString(bTimeStr);
      const aMins = aParsed ? (aParsed.hour * 60 + aParsed.minute) : 9999;
      const bMins = bParsed ? (bParsed.hour * 60 + bParsed.minute) : 9999;
      if (aMins !== bMins) return aMins - bMins;
      return String(a.sid).localeCompare(String(b.sid));
    });

    const dayLines = [`📅 *${dateDisplay}*`];

    for (const { sid, sched: s, entry } of items) {
      const titlePart = s.title ? ` (${s.title})` : '';
      const pausedPart = s.enabled === false ? ' ⏸️ _(Paused)_' : '';

      const primaryAuto = Array.isArray(entry.autoBookedCourts)
        ? entry.autoBookedCourts
        : (Array.isArray(entry.advanceBookedCourts) ? entry.advanceBookedCourts : []);
      const autoCourtNames = new Set(primaryAuto.map((c) => c?.court?.toLowerCase().trim()).filter(Boolean));
      const extraAutoFromPrebooked = Array.isArray(entry.prebookedCourts)
        ? entry.prebookedCourts.filter((pb) => pb?.court && pb.bookingType === 'auto' && !autoCourtNames.has(pb.court.toLowerCase().trim()))
        : [];
      const autoList = [...primaryAuto, ...extraAutoFromPrebooked];
      for (const c of extraAutoFromPrebooked) {
        if (c?.court) autoCourtNames.add(c.court.toLowerCase().trim());
      }
      const manualList = Array.isArray(entry.prebookedCourts)
        ? entry.prebookedCourts.filter((pb) => pb?.court && pb.bookingType !== 'auto' && !autoCourtNames.has(pb.court.toLowerCase().trim()))
        : [];

      const securedSet = new Set([
        ...autoList.map((c) => c?.court?.toLowerCase().trim()).filter(Boolean),
        ...manualList.map((m) => m?.court?.toLowerCase().trim()).filter(Boolean)
      ]);
      const securedCount = securedSet.size;
      const targetCount = entry.targetCourtsCount || s.preBookCourts || s.maxCourts || (typeof s.size === 'number' ? Math.ceil(s.size / 4) : 1);
      const isComplete = Boolean(entry.completed) || (targetCount > 0 && securedCount >= targetCount);
      const courtWord = targetCount === 1 ? 'court' : 'courts';
      const statusBadge = isComplete
        ? `✅ ${securedCount}/${targetCount} ${courtWord}`
        : `⏳ ${securedCount}/${targetCount} ${courtWord} (retrying)`;

      const matchTimeStr = entry.matchTime || s.matchDisplay || s.matchTime || '';
      const timeLabel = matchTimeStr ? `*${matchTimeStr}* — ` : '';
      dayLines.push(`• ${timeLabel}\`${sid}\`${titlePart}${pausedPart} — ${statusBadge}`);

      for (const c of autoList) {
        const timePart = (c.time && c.time !== matchTimeStr) ? ` @ ${c.time}` : '';
        const details = [c.partySize || null, c.duration || null].filter(Boolean);
        const detailStr = details.length > 0 ? ` (${details.join(', ')})` : '';
        const playerFallback = c.fullName || c.player;
        const playersArr = Array.isArray(c.players) && c.players.length > 0 ? c.players : (playerFallback ? [playerFallback] : []);
        const playersStr = playersArr.length > 0 ? ` — Players: ${playersArr.join(', ')}` : '';
        const resStr = c.reservationId ? ` — ID: \`${c.reservationId}\`` : '';
        dayLines.push(`  ◦ *${c.court}*${timePart} [auto booked]${detailStr}${playersStr}${resStr}`);
      }

      for (const m of manualList) {
        const timePart = (m.time && m.time !== matchTimeStr) ? ` @ ${m.time}` : '';
        const byWho = m.fullName || m.player || (Array.isArray(m.players) && m.players.length > 0 ? m.players.join(', ') : null);
        const byStr = byWho ? `manual by ${byWho}` : 'manual';
        dayLines.push(`  ◦ *${m.court}*${timePart} [${byStr}]`);
      }

      if (autoList.length === 0 && manualList.length === 0) {
        dayLines.push('  ◦ _No courts secured yet_');
      }

      const pollPosted = checkPollCreated(s, dateKey, activePolls);
      if (pollPosted) {
        dayLines.push('  ◦ Poll: ✅ Already posted');
      } else {
        const postCfg = (dayIdx !== null && getPostTimeForSchedule) ? getPostTimeForSchedule(s, dayIdx) : null;
        let postWhenStr = '';
        if (postCfg?.display) {
          const hasBeforeInDisplay = /\bday(?:s)?\s+before\b/i.test(postCfg.display);
          const beforeStr = (!hasBeforeInDisplay && postCfg.daysBefore > 1)
            ? ` (${postCfg.daysBefore} days before)`
            : ((!hasBeforeInDisplay && postCfg.daysBefore === 1) ? ' (1 day before)' : '');
          postWhenStr = ` (posts at ${postCfg.display}${beforeStr})`;
        } else if (s.postDisplay) {
          postWhenStr = ` (posts at ${s.postDisplay})`;
        }
        dayLines.push(`  ◦ Poll: 🕒 Not yet posted${postWhenStr}`);
      }

      if (!isComplete && entry.retryCount > 0) {
        dayLines.push(`  ◦ Attempts: ${entry.retryCount} retr${entry.retryCount === 1 ? 'y' : 'ies'}`);
      }
    }

    sections.push(dayLines.join('\n'));
  }

  if (waitingSchedules.length > 0) {
    const waitLines = ['⏳ *Waiting for Booking Trigger:*'];
    for (const { sid, sched: s } of waitingSchedules) {
      const daysStr = s.daysDisplay || parseDaysOfWeek(s.days || s.daysList).display;
      const titlePart = s.title ? ` (${s.title})` : '';
      const pausedPart = s.enabled === false ? ' ⏸️ _(Paused)_' : '';
      const bSched = s.bookingSchedule || '-7days 7:00AM';
      const courtsCountPart = s.preBookCourts ? ` (${s.preBookCourts} court${s.preBookCourts === 1 ? '' : 's'})` : '';
      waitLines.push(`• \`${sid}\`${titlePart} — ${s.matchDisplay || s.matchTime} (${daysStr})${pausedPart} — Schedule: ${bSched}${courtsCountPart}`);
    }
    sections.push(waitLines.join('\n'));
  }

  for (const { sid, sched: s } of unconfiguredSchedules) {
    const daysStr = s.daysDisplay || parseDaysOfWeek(s.days || s.daysList).display;
    const titlePart = s.title ? ` (${s.title})` : '';
    const pausedPart = s.enabled === false ? ' ⏸️ _(Paused)_' : '';
    const stratLabel = s.courtsStrategy === 'book' ? 'Book' : (s.courtsStrategy === 'lookup' ? 'Lookup' : 'None');
    sections.push(
      `📅 *Schedule \`${sid}\`${titlePart}:* ${s.matchDisplay || s.matchTime} (${daysStr})${pausedPart}\n` +
      `• *Courts Strategy:* ${stratLabel}\n` +
      '• _No advance court bookings recorded (advance booking is not configured on this schedule)._'
    );
  }

  return `📋 *Recurring Advance Court Bookings*\n\n${sections.join('\n\n')}\n\n_Manage courts with !modifycourt <id> ..., !cancelcourt <id>, or !recurringpoll status <id>_`;
}

/**
 * Cancels and deletes a recurring poll schedule.
 */
async function cancelRecurringPoll({ recurringPolls, persistPolls, sender, scheduleId }) {
  const cleanId = String(scheduleId || '').trim();
  if (!cleanId) {
    return 'Please provide the schedule ID to cancel, e.g. "!cancelrecurringpoll rec_1" (see "!recurringpolls" for IDs) or "!clearallrecurringpolls" to clear all.';
  }

  const targetKey = findScheduleKey(recurringPolls, cleanId);
  if (!targetKey) {
    return `Schedule ID "\`${cleanId}\`" was not found. Use "!recurringpolls" to view all scheduled IDs.`;
  }

  const sched = recurringPolls.get(targetKey);
  recurringPolls.delete(targetKey);
  persistPolls();

  console.log(`[recurring-poll] Deleted recurring poll schedule ${targetKey} (${sched.matchDisplay}) by ${sender}`);
  return `🗑️ Cancelled and deleted recurring poll schedule \`${targetKey}\` (Match time: ${sched.matchDisplay} ${sched.daysDisplay || ''}).`;
}

/**
 * Clears and cancels all recurring poll schedules for the given chat.
 */
async function clearAllRecurringPolls({ recurringPolls, persistPolls, sender, chatId }) {
  const isAll = !chatId || !chatId.endsWith('@g.us');
  const toDelete = [];

  for (const [id, sched] of recurringPolls.entries()) {
    if (isAll || sched.remoteJid === chatId) {
      toDelete.push(id);
    }
  }

  if (toDelete.length === 0) {
    return '📅 No scheduled recurring polls found to clear.';
  }

  for (const id of toDelete) {
    recurringPolls.delete(id);
  }
  persistPolls();

  console.log(`[recurring-poll] Cleared all ${toDelete.length} recurring poll schedules by ${sender} in ${chatId}`);
  return `🗑️ Cleared and deleted all ${toDelete.length} recurring poll schedule(s).`;
}

/**
 * Pauses a recurring poll schedule (or all schedules).
 */
async function pauseRecurringPoll({ recurringPolls, persistPolls, scheduleId, chatId = null, untilDate = null }) {
  const extracted = extractPauseArgs(scheduleId);
  const cleanId = extracted.scheduleId ? String(extracted.scheduleId).replace(/^["']|["']$/g, '').trim() : '';
  const effUntilRaw = untilDate || extracted.untilDate || null;

  let parsedUntil = null;
  if (effUntilRaw) {
    parsedUntil = parseDateToDateKey(effUntilRaw);
    if (!parsedUntil) {
      return `⚠️ Could not parse the pause date "${effUntilRaw}". Please specify a valid date (e.g. "10/25/2026", "2026-10-25", "Oct 25", "Monday", "tomorrow").`;
    }
    if (parsedUntil.isPast) {
      return `⚠️ The pause date (${parsedUntil.display}) has already passed in San Jose. Please specify an upcoming date or day.`;
    }
  }

  const untilNote = parsedUntil ? ` until ${parsedUntil.display}` : '';
  const autoResumeNote = parsedUntil ? ` It will automatically resume on ${parsedUntil.display}.` : ' Use "!resumerecurringpolls all" to re-enable them.';

  if (cleanId === 'all') {
    const isAll = !chatId || !chatId.endsWith('@g.us');
    let count = 0;
    for (const [, sched] of recurringPolls.entries()) {
      if (isAll || sched.remoteJid === chatId) {
        applyPauseState(sched, false, parsedUntil);
        count++;
      }
    }
    if (count === 0) {
      return '📅 No scheduled recurring polls found to pause.';
    }
    persistPolls();
    return `⏸️ Paused all ${count} recurring match poll schedule(s)${untilNote}.${autoResumeNote}`;
  }

  if (!cleanId) {
    return 'Please provide the schedule ID to pause, e.g. "!pauserecurringpoll rec_1" or "!pauserecurringpoll all" (optionally with "until <date>"). Use "!recurringpolls" to view active IDs.';
  }

  const targetKey = findScheduleKey(recurringPolls, cleanId);
  if (!targetKey) {
    return `⚠️ Schedule ID "\`${cleanId}\`" was not found. Use "!recurringpolls" to view active IDs.`;
  }
  const sched = recurringPolls.get(targetKey);
  applyPauseState(sched, false, parsedUntil);
  persistPolls();

  const singleAutoResume = parsedUntil
    ? ` It will resume automatically on *${parsedUntil.display}*.`
    : ` It will not automatically post polls until resumed with "!resumerecurringpoll ${targetKey}".`;

  return `⏸️ Paused recurring poll schedule \`${targetKey}\` (${sched.matchDisplay})${untilNote}.${singleAutoResume}`;
}

/**
 * Resumes a recurring poll schedule (or all schedules).
 */
async function resumeRecurringPoll({ recurringPolls, persistPolls, scheduleId, chatId = null }) {
  const cleanId = String(scheduleId || '').replace(/^["']|["']$/g, '').trim();
  if (cleanId === 'all') {
    const isAll = !chatId || !chatId.endsWith('@g.us');
    let count = 0;
    for (const [, sched] of recurringPolls.entries()) {
      if (isAll || sched.remoteJid === chatId) {
        applyPauseState(sched, true);
        count++;
      }
    }
    if (count === 0) {
      return '📅 No scheduled recurring polls found to resume.';
    }
    persistPolls();
    return `▶️ Resumed all ${count} recurring match poll schedule(s).`;
  }

  if (!cleanId) {
    return 'Please provide the schedule ID to resume, e.g. "!resumerecurringpoll rec_1" or "!resumerecurringpoll all". Use "!recurringpolls" to view active IDs.';
  }

  const targetKey = findScheduleKey(recurringPolls, cleanId);
  if (!targetKey) {
    return `⚠️ Schedule ID "\`${cleanId}\`" was not found. Use "!recurringpolls" to view active IDs.`;
  }
  const sched = recurringPolls.get(targetKey);
  applyPauseState(sched, true);
  persistPolls();
  return `▶️ Resumed recurring poll schedule \`${targetKey}\` (${sched.matchDisplay}). It will post at ${sched.postDisplay} on ${sched.daysDisplay || 'scheduled days'}.`;
}

module.exports = {
  findScheduleKey,
  formatRecurringScheduleCard,
  scheduleRecurringPoll,
  modifyRecurringPoll,
  listRecurringPolls,
  getRecurringPollStatus,
  listRecurringAdvanceBookings,
  cancelRecurringPoll,
  clearAllRecurringPolls,
  pauseRecurringPoll,
  resumeRecurringPoll
};
