/**
 * Poll Creation, Multi-Poll Partitioning, Parsing, Sizing & Simulation
 */

const ratings = require('../../ratings');
const namesStore = require('../../names');
const { sendMessageAndRecord } = require('../../botMessage');
const recurringPollsModule = require('../../recurringPolls');
const scvcc = require('../../scvcc');
const groupsConfig = require('../../groupsConfig');
const courtsConfig = require('../../courtsConfig');
const pollTime = require('../../pollTime');
const { getTargetGroupJid, resolveTargetChat } = require('../groupCommands');

const {
  resolvePlayDateTime,
  getSanJoseNow,
  getSanJoseParts,
  WORD_TO_NUMBER,
  NUMBER_WORDS_PATTERN,
  parseLookAround,
  formatLookAround,
  getCandidateTimes,
  parseTimeString,
  parseMultiTimeSlots
} = pollTime;

const {
  TRIGGER_PREFIX,
  GENERIC_NAMES,
  POWERS_OF_2_REMINDER_HOURS,
  SIMULATION_PREFIX,
  TENTATIVE_SLOT_TAG,
  normalizePollTitle,
  formatPollTitle,
  storeKey,
  isCourtSkipped,
  nameFor,
  isValidPlayerCount,
  getNextValidPlayerCount,
  partitionMatchSlots,
  addNextCreatorPlayer,
  isUserInPoll,
  formatLineupGenDesc
} = require('./roster');
const {
  preBookCourtsForMatch,
  normalizeCourtPreference,
  sortCourtsByPreference,
  formatCourtLabel,
  formatCourtBookingTitleLine,
  formatCourtAvailableTitleLine,
  formatCourtTentativeTitleLine,
  detectPrebookedCourt
} = require('./courts');
const { cancelOrDeletePoll } = require('./lifecycle');
const { flushPendingPollVotes } = require('./voting');

const inFlightPollCreations = new Set();

function extractPollCreationPostTime(textCleanFlags, flags = {}) {
  let rem = textCleanFlags;
  let postTime = flags?.postTime || null;

  if (postTime) {
    return { postTime, remainingText: rem };
  }

  // 1. Explicit "post at <time>" or "posting at <time>" or "post <time>"
  const explicitPostRegex = /\b(?:post(?:ed)?|posting)\s+(?:at\s+)?((?:(?:\d+\s*days?\s*before(?:\s+at\s+(?:\d{1,2}(?::\d{2})?\s*(?:am|pm)?|\d{1,2}:\d{2}))?|\d+(?:\.\d+)?\s*(?:hours?|hrs?|h)\s*(?:before|prior|in\s+advance)?|(?:the\s+)?(?:day|evening|night)\s*before|previous\s*day|(?:sun[a-z]*|mon[a-z]*|tue[a-z]*|wed[a-z]*|thu[a-z]*|fri[a-z]*|sat[a-z]*)\s*(?:at\s+)?(?:\d{1,2}(?::\d{2})?\s*(?:am|pm)?|\d{1,2}:\d{2})|(?:\d{1,2}(?::\d{2})?\s*(?:am|pm)?|\d{1,2}:\d{2}))[\s,;&and]*)+)/i;
  const expMatch = rem.match(explicitPostRegex);
  if (expMatch) {
    postTime = expMatch[1].trim();
    rem = rem.replace(expMatch[0], ' ');
    return { postTime, remainingText: rem.replace(/\s+/g, ' ').trim() };
  }

  // 2. Relative offset or advance posting time (e.g. "at 1 day before at 6pm", "at 2h before", "at the day before at 6pm")
  const relativePostRegex = /\b(?:at\s+)?(\d+\s*days?\s*before(?:\s+at\s+(?:\d{1,2}(?::\d{2})?\s*(?:am|pm)?|\d{1,2}:\d{2}))?|\d+(?:\.\d+)?\s*(?:hours?|hrs?|h)\s*(?:before|prior|in\s+advance)|(?:the\s+)?(?:day|evening|night)\s*before(?:\s+at\s+(?:\d{1,2}(?::\d{2})?\s*(?:am|pm)?|\d{1,2}:\d{2}))?|previous\s*day(?:\s+at\s+(?:\d{1,2}(?::\d{2})?\s*(?:am|pm)?|\d{1,2}:\d{2}))?)\b/i;
  const relMatch = rem.match(relativePostRegex);
  if (relMatch) {
    postTime = relMatch[1].trim();
    rem = rem.replace(relMatch[0], ' ');
    return { postTime, remainingText: rem.replace(/\s+/g, ' ').trim() };
  }

  // 3. Check for "at <Day> <Time>" (e.g. "at Friday 6pm", "at Fri 6:30pm")
  const dayPostRegex = /\bat\s+((?:sun[a-z]*|mon[a-z]*|tue[a-z]*|wed[a-z]*|thu[a-z]*|fri[a-z]*|sat[a-z]*)\s+(?:at\s+)?(?:\d{1,2}(?::\d{2})?\s*(?:am|pm)?|\d{1,2}:\d{2}))\b/i;
  const dayPostMatch = rem.match(dayPostRegex);
  if (dayPostMatch) {
    postTime = dayPostMatch[1].trim();
    rem = rem.replace(dayPostMatch[0], ' ');
    return { postTime, remainingText: rem.replace(/\s+/g, ' ').trim() };
  }

  // 4. Check for multiple time tokens where one is preceded by "at <time>"
  // e.g. "!poll 4 tomorrow 7pm at 8am", "!poll 4 tomorrow at 7pm at 8am", "!poll Saturday 8am, 9:30am, 4pm at 8am"
  const timeRegex = /\b(\d{1,2}(?:[:.]\d{2})?\s*(?:am|pm)|\d{1,2}[:.]\d{2})\b/gi;
  const timeTokens = [];
  let tm;
  while ((tm = timeRegex.exec(rem)) !== null) {
    timeTokens.push({
      token: tm[1].trim(),
      index: tm.index,
      fullMatch: tm[0]
    });
  }

  if (timeTokens.length >= 2) {
    const lastToken = timeTokens[timeTokens.length - 1];
    const beforeLast = rem.slice(Math.max(0, lastToken.index - 10), lastToken.index);
    if (/\bat\s*$/i.test(beforeLast)) {
      postTime = lastToken.token;
      const atMatch = beforeLast.match(/\bat\s*$/i);
      const atIndex = lastToken.index - atMatch[0].length;
      rem = rem.slice(0, atIndex) + ' ' + rem.slice(lastToken.index + lastToken.fullMatch.length);
      return { postTime, remainingText: rem.replace(/\s+/g, ' ').trim() };
    }
  }

  return { postTime: null, remainingText: rem };
}

function isPostTimeInFuture(postTime, matchDayWord, matchTimeWord, customSanJoseParts = null) {
  if (!postTime) return { isFuture: false };

  const sj = customSanJoseParts || pollTime.getSanJoseParts();
  const todayKey = `${sj.year}-${String(sj.month + 1).padStart(2, '0')}-${String(sj.day).padStart(2, '0')}`;
  const nowMinutes = sj.hour * 60 + sj.minute;

  const baseNow = customSanJoseParts
    ? new Date(Date.UTC(sj.year, sj.month, sj.day, sj.hour, sj.minute))
    : new Date();
  const resolvedPlayDate = pollTime.resolvePlayDateTime(matchDayWord, matchTimeWord, baseNow);
  const playParts = pollTime.getSanJoseParts(resolvedPlayDate);
  const targetMatchDateKey = `${playParts.year}-${String(playParts.month + 1).padStart(2, '0')}-${String(playParts.day).padStart(2, '0')}`;
  const DAY_MAP = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
  const targetMatchDayIndex = DAY_MAP[playParts.weekday] !== undefined
    ? DAY_MAP[playParts.weekday]
    : (new Date(playParts.year, playParts.month, playParts.day).getDay());

  const parsedMatch = parseTimeString(matchTimeWord || '7pm') || {
    hour: 19,
    minute: 0,
    formatted: '7pm',
    display: '7:00 PM'
  };

  const postCfg = recurringPollsModule.parseSinglePostConfig(postTime, targetMatchDayIndex, parsedMatch);
  if (!postCfg) {
    return { isFuture: false };
  }

  const daysBefore = postCfg.daysBefore !== undefined ? postCfg.daysBefore : 0;
  const postHour = postCfg.postHour !== undefined ? postCfg.postHour : postCfg.hour;
  const postMinute = postCfg.postMinute !== undefined ? postCfg.postMinute : postCfg.minute;

  const postDateObj = new Date(Date.UTC(playParts.year, playParts.month, playParts.day - daysBefore));
  const postYear = postDateObj.getUTCFullYear();
  const postMonth = postDateObj.getUTCMonth();
  const postDay = postDateObj.getUTCDate();
  const postDateKey = `${postYear}-${String(postMonth + 1).padStart(2, '0')}-${String(postDay).padStart(2, '0')}`;
  const postMinutes = postHour * 60 + postMinute;

  let isFuture = false;
  if (postDateKey > todayKey) {
    isFuture = true;
  } else if (postDateKey === todayKey && postMinutes > nowMinutes) {
    isFuture = true;
  }

  return {
    isFuture,
    targetMatchDateKey,
    targetMatchDayIndex,
    postDateKey,
    postMinutes,
    postConfig: postCfg,
    parsedMatch
  };
}

function parsePollCreationText(text) {
  if (!text) return null;

  const isSimulationCommand = /^!(?:simulatepoll|simpoll|mockpoll|testpoll|dryrunpoll)\b/i.test(text);
  const isSimulationPhrase = /\b(?:simulate|mock|dry-?run|test)\s+(?:a\s+)?(?:match\s+)?(?:singles\s+|doubles\s+|yes\/no\s+|yesno\s+|opt-?in\s+)?poll\b/i.test(text);
  const isPollCreationCommand = isSimulationCommand || /^!(?:createpoll|poll|makepoll|newpoll|optinpoll|yesnopoll|createoptinpoll|createyesnopoll)\b/i.test(text);
  const isPollCreationPhrase = isSimulationPhrase || /\b(?:create|make|post|start|set\s*up|setup|open|put|put\s*up|add|send|run|do)\s+(?:a\s+)?(?:match\s+)?(?:singles\s+|doubles\s+|yes\/no\s+|yesno\s+|opt-?in\s+)?poll\b|\bnew\s+(?:match\s+)?(?:singles\s+|doubles\s+|yes\/no\s+|yesno\s+|opt-?in\s+)?poll\b|\b(?:opt-?in|yes\s*\/\s*no|yesno)\s+poll\b|\bpoll\s+for\b/i.test(text);

  if (!isPollCreationCommand && !isPollCreationPhrase) {
    return null;
  }

  const { flags, remainingText: textCleanFlags } = recurringPollsModule.extractCommonFlags(text);

  if (/\b(?:daily|recurring|repeating|every\s*day)\b/i.test(textCleanFlags)) {
    return null;
  }

  const { postTime, remainingText: textForMatchTimes } = extractPollCreationPostTime(textCleanFlags, flags);

  let timeWord = null;
  const timeMatch = textForMatchTimes.match(/\b(\d{1,2}(?:[:.]\d{2})?\s*(?:am|pm))\b/i) || textForMatchTimes.match(/\b(\d{1,2}[:.]\d{2})\b/i);
  if (timeMatch) {
    timeWord = timeMatch[1].trim();
  }

  let dayWord = null;
  const dayMatch = textForMatchTimes.match(/\b(today|tonight|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tue|wed|thu|fri|sat|sun)\b/i);
  if (dayMatch) {
    dayWord = dayMatch[1];
  }

  let when = null;
  if (dayWord && timeWord) {
    const capDay = dayWord.charAt(0).toUpperCase() + dayWord.slice(1).toLowerCase();
    when = `${capDay} ${timeWord}`;
  } else if (timeWord) {
    when = timeWord;
  } else if (dayWord) {
    when = dayWord.charAt(0).toUpperCase() + dayWord.slice(1).toLowerCase();
  }

  let court = null;
  const courtMatch = textForMatchTimes.match(/\b(?:on\s+|at\s+|for\s+)?(?:the\s+)?(court\s*#?\s*\d+|pickleball\s*#?\s*\d+|pb\s*#?\s*\d+)\b/i);
  if (courtMatch) {
    const rawCourt = courtMatch[1].replace(/#/g, '').replace(/\s+/g, ' ').trim();
    if (/^court\s*\d+$/i.test(rawCourt)) {
      const num = rawCourt.match(/\d+/)[0];
      court = `Court ${num}`;
    } else if (/^pickleball\s*\d+$/i.test(rawCourt)) {
      const num = rawCourt.match(/\d+/)[0];
      court = `Pickleball ${num}`;
    } else if (/^pb\s*\d+$/i.test(rawCourt)) {
      const num = rawCourt.match(/\d+/)[0];
      court = `PB ${num}`;
    } else {
      court = rawCourt;
    }
  }

  let textWithoutTime = textForMatchTimes
    .replace(/\b(?:\d{1,2}(?:[:.]\d{2})?\s*(?:am|pm)|\d{1,2}[:.]\d{2}\b)(?:\s*(?:\(\s*[^)]+?\s*\)|[:/](?:\d+|unlimited|open|none|auto)\b))?/ig, ' ');
  let textCleanedForSize = textWithoutTime.replace(/\b(?:on\s+|at\s+|for\s+)?(?:the\s+)?(?:courts?|pickleball|pb)\s*#?\s*\d+\b/gi, ' ');

  const isExplicitOptIn = /\b(?:opt-?in|yes\s*\/\s*no|yesno|open)\b/i.test(textCleanFlags) ||
    /^!(?:optinpoll|yesnopoll|createoptinpoll|createyesnopoll)\b/i.test(text);
  let size = null;
  if (!isExplicitOptIn) {
    if (/\bauto\b/i.test(textCleanedForSize) || /\bauto[-_\s]*(?:spots?|players?|courts?|size)\b/i.test(textCleanedForSize)) {
      size = 'auto';
    } else {
      const courtCountMatch = textCleanedForSize.match(new RegExp(`\\b(\\d+|${NUMBER_WORDS_PATTERN})\\s+courts?\\b`, 'i'));
      if (courtCountMatch) {
        const raw = courtCountMatch[1].toLowerCase();
        const count = WORD_TO_NUMBER[raw] || parseInt(raw, 10);
        if (count > 0 && count <= 4) size = count * 4;
      }

      if (!size) {
        const explicitMatch = textCleanedForSize.match(new RegExp(`\\b(?:for|size|spots?|players?)\\s*[:=]?\\s*(\\d+|${NUMBER_WORDS_PATTERN})\\b`, 'i')) ||
          textCleanedForSize.match(new RegExp(`\\b(\\d+|${NUMBER_WORDS_PATTERN})\\s*(?:spots?|players?|people)\\b`, 'i')) ||
          textCleanedForSize.match(new RegExp(`\\bpoll\\s+for\\s+(\\d+|${NUMBER_WORDS_PATTERN})\\b`, 'i')) ||
          textCleanedForSize.match(new RegExp(`^!(?:createpoll|poll|makepoll|newpoll)\\s+(\\d+|${NUMBER_WORDS_PATTERN})\\b`, 'i')) ||
          textCleanedForSize.match(new RegExp(`\\b(?:create|make|post|start|open|put)\\s+(?:a\\s+)?(?:match\\s+)?poll\\s+(\\d+|${NUMBER_WORDS_PATTERN})\\b`, 'i'));

        if (explicitMatch) {
          const raw = explicitMatch[1].toLowerCase();
          size = WORD_TO_NUMBER[raw] || parseInt(raw, 10);
        } else if (/\bsingles\b/i.test(textCleanedForSize)) {
          size = 2;
        } else if (/\bdoubles\b/i.test(textCleanedForSize)) {
          size = 4;
        } else {
          const fallbackMatch = textCleanedForSize.match(new RegExp(`\\b([248]|12|16|two|four|eight|twelve|sixteen)\\s*(?:players?|spots?)?\\b`, 'i'));
          if (fallbackMatch) {
            const raw = fallbackMatch[1].toLowerCase();
            size = WORD_TO_NUMBER[raw] || parseInt(raw, 10);
          }
        }
      }
    }
  }

  let includeCreator = flags.includeCreator !== undefined
    ? flags.includeCreator
    : !(/\b(?:not\s+playing|won't\s+play|wont\s+play|without\s+me|exclude\s+me|not\s+for\s+me|i'm\s+not\s+playing|im\s+not\s+playing)\b/i.test(textCleanFlags));

  let cancelExisting = false;
  if (/\b(?:replace|cancel\s+existing|cancel\s+previous|update\s+poll|change\s+poll|reschedule)\b/i.test(textCleanFlags)) {
    cancelExisting = true;
  }

  const isSimulation = Boolean(isSimulationCommand || isSimulationPhrase || flags.simulate || flags.isSimulation);
  const noMatchups = flags.noMatchups !== undefined ? flags.noMatchups : (flags.lineupGeneration === 'none');
  const checkCourts = flags.checkCourts !== undefined ? flags.checkCourts : (isSimulationCommand ? true : false);
  const includePrebookedSpots = flags.includePrebookedSpots !== undefined ? flags.includePrebookedSpots : false;
  const courtBookingType = flags.courtBookingType || null;
  const isPreBook = flags.courtsStrategy === 'book' || String(courtBookingType).toLowerCase() === 'pre-book' || String(courtBookingType).toLowerCase() === 'prebook';
  let preBookCourts = flags.preBookCourts || null;
  const maxCourts = flags.maxCourts || null;
  if (isPreBook && !preBookCourts && maxCourts) {
    preBookCourts = maxCourts;
  }
  const bookingPlayers = flags.bookingPlayers || null;
  const bookingStrategy = flags.bookingStrategy || null;
  const bookingSchedule = flags.bookingSchedule || null;
  const lookAround = flags.lookAround !== undefined ? flags.lookAround : null;
  const timeSlots = parseMultiTimeSlots(textForMatchTimes, dayWord, size);
  const multiVote = flags.multiVote !== undefined ? flags.multiVote : true;
  const multiSessionMode = (multiVote === false) ? 'single_session' : (flags.multiSessionMode || 'single_session');

  return {
    title: flags.title !== undefined ? flags.title : null,
    group: flags.group || null,
    targetGroup: flags.group || null,
    courtsStrategy: flags.courtsStrategy || null,
    courtBookingType,
    preBookCourts,
    bookingPlayers,
    bookingStrategy,
    bookingSchedule,
    lookAround,
    size,
    when,
    dayWord,
    timeWord,
    timeSlots,
    postTime,
    at: postTime,
    creationTime: postTime,
    multiVote,
    multiSessionMode,
    court,
    includeCreator,
    cancelExisting,
    noMatchups,
    checkCourts,
    includeCourts: checkCourts,
    includePrebookedSpots,
    '--pre-allocate-slots': includePrebookedSpots,
    'pre-allocate-slots': includePrebookedSpots,
    preAllocateSlots: includePrebookedSpots,
    'prebooked-spots': includePrebookedSpots,
    prebookedSpots: includePrebookedSpots,
    slotCheck: flags.slotCheck,
    lineupGeneration: flags.lineupGeneration,
    lineupLeadTime: flags.lineupLeadTime,
    reminders: flags.reminders !== undefined ? flags.reminders : true,
    maxCourts: flags.maxCourts || null,
    '--max-courts': flags.maxCourts || null,
    'max-courts': flags.maxCourts || null,
    bookingCourtPreference: flags.bookingCourtPreference || null,
    '--booking-court-preference': flags.bookingCourtPreference || null,
    'booking-court-preference': flags.bookingCourtPreference || null,
    '--court-preference': flags.bookingCourtPreference || null,
    'court-preference': flags.bookingCourtPreference || null,
    courtPreference: flags.bookingCourtPreference || null,
    simulate: isSimulation,
    isSimulation
  };
}

async function handleDirectPollCreation(sock, chatId, sender, msg, parsed, opts = {}, context) {
  const { size, when, dayWord, timeWord, court, includeCreator, cancelExisting, noMatchups, checkCourts } = parsed;
  const isSimulation = Boolean(opts.simulate || opts.isSimulation || parsed.simulate || parsed.isSimulation);
  const customTitle = normalizePollTitle(parsed.title !== undefined ? parsed.title : (opts.title !== undefined ? opts.title : null)) || null;
  const includePrebookedSpots = parsed?.['--pre-allocate-slots'] !== undefined
    ? parsed['--pre-allocate-slots']
    : (parsed?.['pre-allocate-slots'] !== undefined
      ? parsed['pre-allocate-slots']
      : (parsed?.preAllocateSlots !== undefined
        ? parsed.preAllocateSlots
        : (parsed?.['prebooked-spots'] !== undefined
          ? parsed['prebooked-spots']
          : (parsed?.prebookedSpots !== undefined ? parsed.prebookedSpots : parsed?.includePrebookedSpots))));
  const isCommand = opts.isCommand === true;
  const creatorName = sender !== 'Someone' ? sender : (msg?.key?.participant ? nameFor(msg.key.participant) : 'Player 1');
  const creatorJid = msg?.key?.participant || msg?.key?.remoteJid || null;
  const groupQuery = parsed.group || opts.group || null;
  const targetRes = await resolveTargetChat(sock, chatId, creatorJid, groupQuery, context, { requireAdmin: !isSimulation, actionDesc: 'create polls' });
  if (targetRes?.error) {
    return targetRes.error;
  }
  const targetGroupJid = targetRes.targetChatId;
  const targetChatId = isSimulation ? chatId : targetGroupJid;

  if (parsed.postTime && !isSimulation) {
    const effectiveMatchTime = parsed.timeWord || parsed.timeSlots?.[0]?.timeWord || '7pm';
    const effectiveDayWord = parsed.dayWord || parsed.timeSlots?.[0]?.dayWord || null;
    const futureCheck = isPostTimeInFuture(parsed.postTime, effectiveDayWord, effectiveMatchTime, context?.customSanJoseParts);
    if (futureCheck.isFuture) {
      const targetMatchDateKey = futureCheck.targetMatchDateKey;
      const targetMatchDayIndex = futureCheck.targetMatchDayIndex;
      const targetDayName = recurringPollsModule.DAY_NAMES[targetMatchDayIndex];

      const scheduleParams = {
        size: parsed.size,
        matchTime: effectiveMatchTime,
        postTime: parsed.postTime,
        days: targetDayName,
        daysList: [targetMatchDayIndex],
        oneTime: true,
        isOneTime: true,
        startDate: targetMatchDateKey,
        endDate: targetMatchDateKey,
        targetMatchDateKey,
        targetMatchDateDisplay: `${targetDayName.charAt(0).toUpperCase() + targetDayName.slice(1)} (${targetMatchDateKey})`,
        includeCreator: parsed.includeCreator,
        courtsStrategy: parsed.courtsStrategy || null,
        courtBookingType: parsed.courtBookingType || null,
        preBookCourts: parsed.preBookCourts || null,
        bookingPlayers: parsed.bookingPlayers || null,
        bookingStrategy: parsed.bookingStrategy || null,
        bookingSchedule: parsed.bookingSchedule || null,
        lookAround: parsed.lookAround || null,
        slotCheck: parsed.slotCheck,
        lineupGeneration: parsed.lineupGeneration,
        lineupLeadTime: parsed.lineupLeadTime,
        reminders: parsed.reminders !== undefined ? parsed.reminders : true,
        maxCourts: parsed.maxCourts || null,
        bookingCourtPreference: parsed.bookingCourtPreference || null,
        timeSlots: parsed.timeSlots || null,
        multiVote: parsed.multiVote,
        multiSessionMode: parsed.multiSessionMode || null,
        includePrebookedSpots: includePrebookedSpots,
        title: customTitle,
        group: parsed.group,
        targetGroup: parsed.group
      };

      const recurringPolls = context?.recurringPolls || new Map();
      const persistPolls = context?.persistPolls || (() => {});

      const schedRes = await recurringPollsModule.scheduleRecurringPoll({
        recurringPolls,
        persistPolls,
        targetChatId,
        sender: creatorName,
        senderJid: creatorJid,
        params: scheduleParams
      });

      return schedRes;
    }
  }

  const effectiveCheckCourts = checkCourts !== undefined
    ? Boolean(checkCourts)
    : Boolean(parsed.includeCourts);

  const courtBookingType = parsed.courtBookingType || null;
  const bookingPlayers = parsed.bookingPlayers || null;

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
    cancelExisting,
    isCommand,
    noMatchups || false,
    effectiveCheckCourts,
    includePrebookedSpots || false,
    false,
    null,
    court,
    courtBookingType,
    bookingPlayers,
    parsed.preBookCourts || null,
    null,
    null,
    context,
    { targetGroupJid, title: customTitle, courtsStrategy: parsed.courtsStrategy || null, lookAround: parsed.lookAround || null, slotCheck: parsed.slotCheck, lineupGeneration: parsed.lineupGeneration, lineupLeadTime: parsed.lineupLeadTime, reminders: parsed.reminders !== undefined ? parsed.reminders : true, maxCourts: parsed.maxCourts || parsed?.['max-courts'] || parsed?.['--max-courts'] || null, bookingCourtPreference: parsed.bookingCourtPreference || parsed.courtPreference || parsed?.['--booking-court-preference'] || parsed?.['booking-court-preference'] || parsed?.['court-preference'] || null, timeSlots: parsed.timeSlots || null, multiVote: parsed.multiVote, multiSessionMode: parsed.multiSessionMode || null, simulate: isSimulation, isSimulation }
  );

  if (res?.err) {
    if (res.noCourtsAvailable) {
      return isSimulation ? (res.message || res.err) : null;
    }
    return `Could not create poll: ${res.err}`;
  }

  if (isSimulation) {
    const displayWhen = res.when || when || `${dayWord || ''} ${timeWord || ''}`.trim() || 'today';
    return formatSimulationPollSummary(res, { displayWhen });
  }

  return null;
}

function formatSimulationPollSummary(res, { displayWhen } = {}) {
  const spotLabel = res.isMultiTime
    ? `Multi-time (${res.timeSlots?.length || res.votingSpotsCount} time options, ${res.multiVote !== false ? 'multiple votes allowed' : 'single vote only'}, ${res.multiSessionMode === 'single_session' ? '1 session per player' : 'independent sessions'})`
    : (res.size ? `${res.size} spots (${res.votingSpotsCount} voting slots)` : 'Opt-in (Yes/No)');
  const courtInfo = res.checkCourts
    ? `${res.totalCourtsCount} ${res.totalCourtsCount === 1 ? 'court' : 'courts'} available at SCVCC`
    : 'Court availability check not requested';

  const effLineupGen = res.lineupGeneration || 'filled';
  const effLeadTime = res.lineupLeadTime || 30;

  const lines = [
    `🎾 *Mock Poll Simulation (Throwaway - Not Tracked)*`,
    res.title ? `🏷️ *Title:* ${res.title}` : null,
    `📅 *Match Time:* ${displayWhen}`,
    `👥 *Spots:* ${spotLabel}`,
    `🏟️ *Courts:* ${courtInfo}`,
    `⚙️ *Lineup Generation:* ${formatLineupGenDesc(effLineupGen, effLeadTime)}`,
    res.slotCheck !== undefined ? `🎯 *Slot Check:* ${res.slotCheck ? 'Enabled' : 'Disabled'}` : null,
    `🔔 *Reminders:* ${res.reminders === false ? 'Off' : 'On'}`,
    res.lookAround ? `⏱️ *Look Around:* ${res.lookAroundDisplay || formatLookAround(res.lookAround)}` : null,
    res.maxCourts ? `🎾 *Max Courts:* ${res.maxCourts}` : null,
    (res.courtBookingType && res.courtBookingType !== 'none') ? `📝 *Court Booking Type:* ${res.courtBookingType === 'pre-book' ? 'Pre-book' : res.courtBookingType}` : null,
    `ℹ️ *Note:* Mock throwaway poll generated (not tracked or saved). No courts were booked.`
  ].filter(Boolean);

  return lines.join('\n');
}

/**
 * Creates a Multi-Time Poll where each option is a time slot (plus a final "No / Can't play" option).
 */
async function createMultiTimePoll({
  sock,
  remoteJid,
  effectiveConfigJid,
  groupCfg,
  size,
  isAuto,
  when,
  dayWord,
  timeSlotsInput,
  multiVote = true,
  multiSessionMode = "single_session",
  creatorName,
  creatorJid,
  replacePollId,
  cancelExisting,
  isCommand,
  effectiveLineupGen,
  effectiveLineupLeadTime,
  remindersOption,
  checkCourts,
  courtsStrategy = null,
  slotCheck = true,
  includePrebookedSpots,
  isRecurring,
  scheduleId,
  targetCourt,
  courtBookingType,
  bookingPlayers,
  preBookCourts,
  hasExplicitPreBookCourts = false,
  bookingStrategy,
  preExistingBookings,
  effectiveLookAround,
  explicitMaxCourts,
  configuredMaxCourts,
  isSimulation,
  targetDateMDYOverride,
  courtPreference = null,
  bookingCourtPreference = null,
  title = null,
  context
}) {
  const { activePolls, messageStore, latestPollIdByChat, persistPolls } = context || {};
  const customTitle = normalizePollTitle(title) || null;
  const sjNow = getSanJoseNow();
  const rawMultiPref = courtPreference || bookingCourtPreference;
  const effectiveCourtPreference = (rawMultiPref && (Array.isArray(rawMultiPref) ? rawMultiPref.length > 0 : Boolean(rawMultiPref)))
    ? normalizeCourtPreference(rawMultiPref)
    : (scheduleId && context?.recurringPolls?.has(scheduleId) && context.recurringPolls.get(scheduleId).bookingCourtPreference
      ? normalizeCourtPreference(context.recurringPolls.get(scheduleId).bookingCourtPreference)
      : groupsConfig.getBookingCourtPreference(effectiveConfigJid));
  const effectiveMultiSessionMode = (multiVote === false) ? "single_session" : (multiSessionMode || "single_session");

  // Check if any explicit court options were requested in poll creation
  const schedCourtsStrat = (scheduleId && context?.recurringPolls?.has(scheduleId)) ? context.recurringPolls.get(scheduleId).courtsStrategy : null;
  const rawMultiStrategy = courtsStrategy || schedCourtsStrat || groupCfg?.courtsStrategy || null;
  let effectiveCourtsStrategy = null;
  if (rawMultiStrategy && ['book', 'lookup', 'none'].includes(String(rawMultiStrategy).toLowerCase())) {
    effectiveCourtsStrategy = String(rawMultiStrategy).toLowerCase();
  } else {
    if (String(courtBookingType).toLowerCase() === "pre-book" || String(courtBookingType).toLowerCase() === "prebook") {
      effectiveCourtsStrategy = "book";
    } else if (checkCourts) {
      effectiveCourtsStrategy = "lookup";
    } else {
      effectiveCourtsStrategy = "none";
    }
  }
  const isPreBook = effectiveCourtsStrategy === "book";
  const effectiveCheckCourts = effectiveCourtsStrategy === "book" || effectiveCourtsStrategy === "lookup";
  const hasAnyAutoSlot = isAuto || timeSlotsInput.some((s) => s.size === "auto");
  const hasExplicitCourtOption = Boolean(
    effectiveCheckCourts ||
    isPreBook ||
    (preBookCourts !== null && preBookCourts !== undefined && parseInt(preBookCourts, 10) > 0) ||
    targetCourt ||
    hasAnyAutoSlot ||
    preExistingBookings
  );
  const courtBookingAllowed = hasExplicitCourtOption && (isSimulation || groupsConfig.isCourtBookingEnabled(effectiveConfigJid));

  // Resolve each time slot
  const resolvedSlots = [];
  const distinctDays = new Set();

  for (let i = 0; i < timeSlotsInput.length; i++) {
    const rawSlot = timeSlotsInput[i];
    const slotDayWord = rawSlot.dayWord || dayWord || null;
    const slotTimeWord = rawSlot.timeWord;
    const slotPlayAt = resolvePlayDateTime(slotDayWord, slotTimeWord);

    if (!isSimulation && !isRecurring && !targetDateMDYOverride && slotDayWord && slotTimeWord && slotPlayAt.getTime() <= sjNow.getTime()) {
      return {
        err: `The specified time (${slotDayWord} ${slotTimeWord}) has already passed. Please specify upcoming times to create the poll.`
      };
    }

    const playParts = getSanJoseParts(slotPlayAt);
    const slotDateMDY = targetDateMDYOverride || scvcc.resolveDateToMDY(slotDayWord || slotPlayAt);
    distinctDays.add(slotDateMDY);

    let dayDisplay = slotDayWord
      ? slotDayWord.charAt(0).toUpperCase() + slotDayWord.slice(1).toLowerCase()
      : playParts.weekday;

    const slotIsAuto = rawSlot.size === "auto" || (rawSlot.size === undefined && isAuto);
    let slotSize = null;
    if (!slotIsAuto) {
      if (typeof rawSlot.size === "number" && rawSlot.size > 0) {
        slotSize = rawSlot.size;
      } else if (rawSlot.size === null && rawSlot.explicitSize) {
        slotSize = null; // explicitly unlimited
      } else if (typeof size === "number" && size > 0) {
        slotSize = size;
      }
    }

    resolvedSlots.push({
      index: i,
      dayWord: slotDayWord,
      dayDisplay,
      timeWord: slotTimeWord,
      timeDisplay: rawSlot.timeDisplay || slotTimeWord,
      playAt: slotPlayAt.toISOString(),
      playAtMs: slotPlayAt.getTime(),
      targetDateMDY: slotDateMDY,
      queryTime: slotTimeWord,
      isAuto: slotIsAuto,
      size: slotSize,
      slotLimit: slotSize,
      status: "active",
      prebookedCourts: [],
      autoBookedCourts: [],
      manuallyBookedCourts: [],
      advanceBookedCourts: [],
      unbookedCourts: [],
      tentativeCourts: [],
      preseededPlayers: [],
      onDemandBookingInProgress: false,
      invalidSlotVotesNotified: [],
      lastExcessSignature: null,
      manualLineupPosted: false,
      lineupReminderSent: false,
      lastSchedule: null,
      lastPlayers: null
    });
  }

  const isMultiDay = distinctDays.size > 1;
  const allCourtsLines = [];
  const combinedPrebookedCourts = [];
  const combinedAutoBookedCourts = [];
  const combinedManualBookedCourts = [];
  const combinedUnbookedCourts = [];
  const combinedTentativeCourts = [];

  for (const slot of resolvedSlots) {
    let slotPrebooked = [];
    let slotFree = [];
    let slotTentative = [];
    let slotAdvance = [];

    const slotBookingKey = `${slot.targetDateMDY}|${slot.queryTime}`;
    const slotPreExisting = preExistingBookings?.bySlot?.[slotBookingKey] || preExistingBookings?.byTime?.[slot.queryTime] || null;

    if (slotPreExisting) {
      const preAuto = slotPreExisting.autoBookedCourts || slotPreExisting.advanceBookedCourts || [];
      slotAdvance.push(...preAuto);
      for (const abc of preAuto) {
        slotPrebooked.push({
          court: abc.court,
          player: abc.players?.[0] || "Member",
          fullName: (abc.players && abc.players.length > 0) ? abc.players.join(", ") : "Member",
          time: abc.time || slot.queryTime,
          bookingType: "auto"
        });
      }
      if (Array.isArray(slotPreExisting.prebookedCourts)) {
        for (const pb of slotPreExisting.prebookedCourts) {
          if (!slotPrebooked.some((x) => x.court && pb.court && x.court.toLowerCase() === pb.court.toLowerCase())) {
            slotPrebooked.push({ ...pb, bookingType: pb.bookingType || "manual" });
          }
        }
      }
    } else if (!isSimulation && isPreBook && courtBookingAllowed) {
      const effectiveStrategy = bookingStrategy || groupCfg?.bookingStrategy || "instant";
      if (effectiveStrategy !== "advanced") {
        const bookRes = await preBookCourtsForMatch({
          sock,
          remoteJid,
          targetDateMDY: slot.targetDateMDY,
          queryTime: slot.queryTime,
          court: targetCourt,
          targetCourt,
          size: slot.size,
          isAuto: slot.isAuto,
          preBookCourts,
          maxCourts: explicitMaxCourts !== undefined ? explicitMaxCourts : configuredMaxCourts,
          courtPreference: effectiveCourtPreference,
          bookingPlayers,
          creatorName,
          creatorJid,
          minAvailableMinutes: 90,
          lookAround: effectiveLookAround
        });
        if (bookRes.advanceBookedCourts?.length > 0) {
          slotAdvance.push(...bookRes.advanceBookedCourts);
        }
        if (bookRes.prebookedCourts?.length > 0) {
          for (const pb of bookRes.prebookedCourts) {
            const isA = slotAdvance.some((a) => a.court && pb.court && a.court.toLowerCase() === pb.court.toLowerCase());
            slotPrebooked.push({
              ...pb,
              bookingType: isA ? "auto" : (pb.bookingType || "manual")
            });
          }
        }
      }
    }

    if (courtBookingAllowed && (checkCourts || slot.isAuto || effectiveCheckCourts)) {
      const seenPrebooked = new Set(slotPrebooked.map((c) => c.court));
      const seenFree = new Set();
      const seenTentative = new Set();
      const candidateTimes = getCandidateTimes(slot.queryTime, effectiveLookAround);

      const slotClosedTimes = [];
      for (const t of candidateTimes) {
        try {
          const [avail, bookingsRes] = await Promise.all([
            scvcc.checkCourtAvailability({ when: slot.targetDateMDY, time: t, sport: "tennis", chatId: effectiveConfigJid }).catch(() => null),
            scvcc.getCourtBookings({ when: slot.targetDateMDY, time: t, sport: "tennis", chatId: effectiveConfigJid }).catch(() => null)
          ]);
          const closedCheck = typeof scvcc.detectClubClosed === "function"
            ? scvcc.detectClubClosed({ avail, bookingsRes, time: t, chatId: effectiveConfigJid })
            : { clubClosed: false, title: null };
          if (closedCheck.clubClosed) {
            slotClosedTimes.push({ time: t, title: closedCheck.title || null });
            continue;
          }
          const bookings = bookingsRes?.bookings || [];
          for (const b of bookings) {
            if (!b.court || courtsConfig.isIgnoredCourt(b.court, effectiveConfigJid)) continue;
            if (seenPrebooked.has(b.court)) continue;
            if (b.durationMins && b.durationMins < 90) continue;
            const pbMatch = scvcc.detectPrebookedCourt(b, effectiveConfigJid);
            if (pbMatch) {
              seenPrebooked.add(b.court);
              slotPrebooked.push({
                court: b.court,
                player: pbMatch.player || "Member",
                fullName: pbMatch.fullName || pbMatch.player || "Member",
                time: t,
                bookingType: "manual"
              });
            } else if (groupsConfig.isTentativeBookingTitle(b.title || b.rawText || "", effectiveConfigJid)) {
              if (!seenTentative.has(b.court)) {
                seenTentative.add(b.court);
                slotTentative.push({ court: b.court, time: t, title: b.title || "Tentative" });
              }
            }
          }

          if (avail?.slots && avail.slots.length > 0) {
            const availSlot = avail.slots[0];
            for (const c of availSlot.courts || []) {
              if (!c.court || courtsConfig.isIgnoredCourt(c.court, effectiveConfigJid)) continue;
              const dur = c.availableMinutes || c.durationMins || 90;
              if (dur < 90) continue;
              if (c.status === "prebooked" && !seenPrebooked.has(c.court)) {
                seenPrebooked.add(c.court);
                slotPrebooked.push({
                  court: c.court,
                  player: c.prebookedBy || "Member",
                  fullName: c.prebookedFullName || c.prebookedBy || "Member",
                  time: t,
                  bookingType: "manual"
                });
              } else if ((c.status === "available" || c.status === "override") && !seenPrebooked.has(c.court) && !seenFree.has(c.court)) {
                seenFree.add(c.court);
                slotFree.push({ court: c.court, time: t, isOverride: c.status === "override" });
              } else if (c.status === "tentative" && !seenPrebooked.has(c.court) && !seenFree.has(c.court) && !seenTentative.has(c.court)) {
                seenTentative.add(c.court);
                slotTentative.push({ court: c.court, time: t, title: c.tentativeTitle || "Tentative" });
              }
            }
          }
        } catch (err) {}
      }
      if (candidateTimes.length > 0 && slotClosedTimes.length >= candidateTimes.length && slotPrebooked.length === 0 && slotFree.length === 0 && slotTentative.length === 0) {
        slot.clubClosed = true;
        slot.clubClosedTitle = slotClosedTimes.find((ct) => ct.title)?.title || null;
      }
    }

    // Apply court limits for this time slot
    const maxSlotCourts = configuredMaxCourts !== null
      ? configuredMaxCourts
      : (slot.size && typeof slot.size === "number" ? Math.ceil(slot.size / 4) : Math.max(3, slotAdvance.length, preBookCourts ? parseInt(preBookCourts, 10) : 0));

    const sortedPrebooked = sortCourtsByPreference(slotPrebooked, effectiveCourtPreference);
    const sortedFree = sortCourtsByPreference(slotFree, effectiveCourtPreference);
    const sortedTentative = sortCourtsByPreference(slotTentative, effectiveCourtPreference);

    const selectedPrebooked = sortedPrebooked.slice(0, maxSlotCourts);
    const remFree = Math.min(sortedFree.length, Math.max(0, maxSlotCourts - selectedPrebooked.length));
    const selectedFree = sortedFree.slice(0, remFree);
    const remTent = Math.min(sortedTentative.length, Math.max(0, maxSlotCourts - selectedPrebooked.length - selectedFree.length));
    const selectedTentative = sortedTentative.slice(0, remTent);

    if (slot.clubClosed) {
      slot.size = 0;
      slot.slotLimit = 0;
    } else if (slot.isAuto) {
      const totalC = selectedPrebooked.length + selectedFree.length + selectedTentative.length;
      slot.size = totalC > 0 ? totalC * 4 : 4;
      slot.slotLimit = slot.size;
    } else if (courtBookingAllowed && (checkCourts || effectiveCheckCourts) && typeof slot.size === "number" && slot.size > 0) {
      const totalC = selectedPrebooked.length + selectedFree.length + selectedTentative.length;
      const courtsNeeded = Math.ceil(slot.size / 4);
      if (totalC < courtsNeeded) {
        const scaledCount = Math.max(4, totalC * 4);
        if (scaledCount < slot.size) {
          console.log(`[poll] Scaling down multi-time slot ${slot.timeDisplay} size from ${slot.size} to ${scaledCount} based on ${totalC} courts found`);
          slot.size = scaledCount;
          slot.slotLimit = scaledCount;
        }
      }
    }

    slot.prebookedCourts = selectedPrebooked;
    slot.advanceBookedCourts = slotAdvance;
    slot.autoBookedCourts = slotAdvance;
    slot.manuallyBookedCourts = selectedPrebooked.filter((p) => p.bookingType !== "auto");
    slot.unbookedCourts = selectedFree.map((fc) => ({ court: fc.court, time: fc.time || slot.queryTime, isOverride: Boolean(fc.isOverride) }));
    slot.tentativeCourts = selectedTentative.map((tc) => ({ court: tc.court, time: tc.time || slot.queryTime, title: tc.title || null }));

    // Pre-seed players if includePrebookedSpots is enabled
    if (includePrebookedSpots && selectedPrebooked.length > 0) {
      const seededNames = [];
      for (const pb of selectedPrebooked) {
        const match = namesStore.findIdByNameOrAlias(pb.player);
        const canonicalName = (match && match.entry?.name) ? match.entry.name : pb.player;
        const slotPlayerName = addNextCreatorPlayer(seededNames, canonicalName);
        slot.preseededPlayers.push({
          defaultPlayer: slotPlayerName,
          fullName: pb.player,
          court: pb.court
        });
      }
    }

    const slotTimePrefix = isMultiDay ? `${slot.dayDisplay} ${slot.timeDisplay}` : slot.timeDisplay;
    if (slot.clubClosed) {
      allCourtsLines.push(`${slotTimePrefix} - Club Closed${slot.clubClosedTitle ? ` (${slot.clubClosedTitle})` : ''}`);
    }
    for (const pb of selectedPrebooked) {
      allCourtsLines.push(`${formatCourtLabel(pb.court)} (${slotTimePrefix}) - Booked`);
      combinedPrebookedCourts.push(pb);
    }
    for (const fc of selectedFree) {
      allCourtsLines.push(`${formatCourtLabel(fc.court)} (${slotTimePrefix}) - Available`);
      combinedUnbookedCourts.push(fc);
    }
    for (const tc of selectedTentative) {
      allCourtsLines.push(`${formatCourtLabel(tc.court)} (${slotTimePrefix}) - Tentative`);
      combinedTentativeCourts.push(tc);
    }
    combinedAutoBookedCourts.push(...slotAdvance);
    combinedManualBookedCourts.push(...slot.manuallyBookedCourts);

    // Format option label
    const baseLabel = isMultiDay ? `${slot.dayDisplay} ${slot.timeDisplay}` : slot.timeDisplay;
    const capSuffix = (typeof slot.slotLimit === "number" && slot.slotLimit > 0) ? ` (${slot.slotLimit} spots)` : "";
    const preseedSuffix = slot.preseededPlayers.length > 0
      ? ` [incl. ${slot.preseededPlayers.map((p) => p.defaultPlayer).join(", ")}]`
      : "";
    slot.label = baseLabel;
    slot.optionLabel = slot.clubClosed
      ? `${baseLabel} (Club Closed)`
      : `${baseLabel}${capSuffix}${preseedSuffix}`;
  }

  if (resolvedSlots.length > 0 && resolvedSlots.every((s) => s.clubClosed)) {
    const closedTitle = resolvedSlots.find((s) => s.clubClosedTitle)?.clubClosedTitle || null;
    const titleSuffix = closedTitle ? ` (${closedTitle})` : '';
    const noCourtsMsg = `🚫 Cannot create poll: Club is closed${titleSuffix} for all requested times.`;
    if (sock && remoteJid && !isRecurring && !isSimulation) {
      try {
        await sendMessageAndRecord(sock, remoteJid, { text: noCourtsMsg });
      } catch (sendErr) {
        console.error('[poll] Error sending club closed multi-time poll message:', sendErr.message);
      }
    }
    return {
      err: noCourtsMsg,
      noCourtsAvailable: true,
      clubClosed: true,
      clubClosedTitle: closedTitle,
      message: noCourtsMsg,
      isSimulation: Boolean(isSimulation)
    };
  }

  // Delete or cancel old poll if requested
  let replacedOldPoll = false;
  if (!isSimulation) {
    if (replacePollId && activePolls && activePolls.has(replacePollId)) {
      await cancelOrDeletePoll(sock, remoteJid, replacePollId, context, { releaseCourts: false });
      replacedOldPoll = true;
    } else if (cancelExisting && activePolls) {
      for (const [pId, pState] of [...activePolls.entries()].reverse()) {
        if (pState.remoteJid === remoteJid && pState.status === "active" && !pState.isManual) {
          await cancelOrDeletePoll(sock, remoteJid, pId, context, { releaseCourts: false });
          replacedOldPoll = true;
          break;
        }
      }
    }
  }

  const values = [
    ...resolvedSlots.map((s) => s.optionLabel),
    "No / Can't play"
  ];

  // Build title
  const firstSlot = resolvedSlots[0];
  const headerDay = isMultiDay
    ? [...new Set(resolvedSlots.map((s) => s.dayDisplay))].join(" / ")
    : (firstSlot.dayDisplay || "Match");
  const voteModeHint = multiVote ? "Vote for time(s)" : "Vote for 1 time";
  const courtBlock = allCourtsLines.length > 0 ? `\n\n${allCourtsLines.join("\n")}\n` : "";
  const pollTitle = formatPollTitle({
    customTitle,
    isSimulation,
    timeLabel: headerDay,
    suffix: ` (${voteModeHint})`,
    courtLine: courtBlock
  });

  const selectableCount = multiVote ? 0 : 1;
  let pollId = `sim_multi_${Date.now()}`;
  let sent = null;

  if (!isSimulation && sock && typeof sock.sendMessage === "function") {
    try {
      sent = await sock.sendMessage(remoteJid, {
        poll: {
          name: pollTitle,
          values,
          selectableCount
        }
      });
      if (sent?.key?.id) {
        pollId = sent.key.id;
      }
    } catch (err) {
      console.error("[poll] Error sending multi-time poll message:", err.message);
    }
  } else if (isSimulation && sock && typeof sock.sendMessage === "function") {
    try {
      sent = await sock.sendMessage(remoteJid, {
        poll: {
          name: pollTitle,
          values,
          selectableCount
        }
      });
      if (sent?.key?.id) {
        pollId = sent.key.id;
      }
    } catch (err) {}
  }

  const earliestPlayAtMs = Math.min(...resolvedSlots.map((s) => s.playAtMs));
  const latestPlayAtMs = Math.max(...resolvedSlots.map((s) => s.playAtMs));
  const earliestPlayAtIso = new Date(earliestPlayAtMs).toISOString();
  const latestPlayAtIso = new Date(latestPlayAtMs).toISOString();
  const resolvedWhenSummary = resolvedSlots.map((s) => isMultiDay ? `${s.dayDisplay} ${s.timeDisplay}` : s.timeDisplay).join(", ");
  const fullWhenDisplay = isMultiDay ? resolvedWhenSummary : `${firstSlot.dayDisplay} ${resolvedWhenSummary}`;

  if (!isSimulation) {
    if (messageStore && sent?.key) messageStore.set(storeKey(sent.key.remoteJid, pollId), sent.message);
    const initialHours = (earliestPlayAtMs - Date.now()) / (60 * 60 * 1000);
    const sentReminders = POWERS_OF_2_REMINDER_HOURS.filter((h) => h > initialHours && h > 1);

    if (activePolls) {
      activePolls.set(pollId, {
        remoteJid,
        title: customTitle,
        name: pollTitle,
        options: values,
        selectableCount,
        multiVote: Boolean(multiVote),
        multiSessionMode: effectiveMultiSessionMode,
        size: size || null,
        type: "multi_time",
        when: fullWhenDisplay,
        playAt: earliestPlayAtIso,
        latestPlayAt: latestPlayAtIso,
        timeSlots: resolvedSlots,
        createdAt: new Date().toISOString(),
        status: "active",
        isManual: false,
        isCommand: Boolean(isCommand),
        slotCheck: (slotCheck !== undefined && slotCheck !== null) ? Boolean(slotCheck) : true,
        lineupGeneration: effectiveLineupGen,
        lineupLeadTime: effectiveLineupLeadTime,
        lineupLeadTimeDisplay: formatLookAround(effectiveLineupLeadTime),
        manualLineupPosted: false,
        lineupReminderSent: false,
        reminders: remindersOption !== null ? Boolean(remindersOption) : true,
        isAuto: Boolean(isAuto),
        maxCourts: configuredMaxCourts || null,
        isRecurring: Boolean(isRecurring),
        isAutoCreated: Boolean(isAuto || isRecurring),
        scheduleId: scheduleId || null,
        courtsStrategy: effectiveCourtsStrategy,
        court: targetCourt || null,
        preBookCourts: (preBookCourts !== undefined && preBookCourts !== null && parseInt(preBookCourts, 10) > 0) ? parseInt(preBookCourts, 10) : null,
        explicitPreBookCourts: Boolean(hasExplicitPreBookCourts),
        advanceBookedCourts: combinedAutoBookedCourts,
        autoBookedCourts: combinedAutoBookedCourts,
        manuallyBookedCourts: combinedManualBookedCourts,
        prebookedCourts: combinedPrebookedCourts,
        unbookedCourts: combinedUnbookedCourts.length > 0 ? combinedUnbookedCourts : null,
        tentativeCourts: combinedTentativeCourts.length > 0 ? combinedTentativeCourts : null,
        includePrebookedSpots: Boolean(includePrebookedSpots),
        creator: null,
        createdBy: (creatorName || creatorJid) ? { name: creatorName || "Player 1", jid: creatorJid || null } : null,
        voteBuffer: new Map(),
        sentReminders,
        lookAround: effectiveLookAround,
        lookAroundDisplay: formatLookAround(effectiveLookAround)
      });
    }

    if (latestPollIdByChat) latestPollIdByChat.set(remoteJid, pollId);
    if (persistPolls) persistPolls();
    await flushPendingPollVotes(pollId, sock, context);
  }

  console.log(`[poll] Created multi-time poll ${pollId} (${resolvedSlots.length} time slots: ${fullWhenDisplay}, multiVote: ${multiVote}, sessionMode: ${effectiveMultiSessionMode}) in ${remoteJid}`);

  return {
    pollId,
    title: customTitle,
    pollTitle,
    options: values,
    values,
    selectableCount,
    isMultiTime: true,
    multiVote: Boolean(multiVote),
    multiSessionMode: effectiveMultiSessionMode,
    timeSlots: resolvedSlots,
    when: fullWhenDisplay,
    err: null,
    isSimulation: Boolean(isSimulation),
    isOptIn: false,
    size: size || null,
    slotCheck: (slotCheck !== undefined && slotCheck !== null) ? Boolean(slotCheck) : true,
    reminders: remindersOption !== null ? Boolean(remindersOption) : true,
    lineupGeneration: effectiveLineupGen,
    lineupLeadTime: effectiveLineupLeadTime,
    lineupLeadTimeDisplay: formatLookAround(effectiveLineupLeadTime),
    votingSpotsCount: resolvedSlots.length,
    checkCourts: Boolean(courtBookingAllowed && checkCourts),
    totalCourtsCount: combinedPrebookedCourts.length + combinedUnbookedCourts.length + combinedTentativeCourts.length,
    prebookedCourts: combinedPrebookedCourts,
    autoBookedCourts: combinedAutoBookedCourts,
    manuallyBookedCourts: combinedManualBookedCourts,
    unbookedCourts: combinedUnbookedCourts,
    tentativeCourts: combinedTentativeCourts,
    replacedOldPoll,
    lookAround: effectiveLookAround,
    lookAroundDisplay: formatLookAround(effectiveLookAround),
    maxCourts: configuredMaxCourts || null,
    bookingCourtPreference: (effectiveCourtPreference && effectiveCourtPreference.length > 0) ? effectiveCourtPreference : null,
    courtsStrategy: effectiveCourtsStrategy,
    courtBookingType: courtBookingType || null
  };
}

async function createMatchPoll(
  sock,
  remoteJid,
  size = null,
  when = null,
  dayWord = null,
  timeWord = null,
  creatorName = null,
  creatorJid = null,
  includeCreator = true,
  replacePollId = null,
  cancelExisting = false,
  isCommand = false,
  noMatchups = false,
  checkCourts = false,
  includePrebookedSpots = false,
  isRecurring = false,
  scheduleId = null,
  targetCourt = null,
  courtBookingType = null,
  bookingPlayers = null,
  preBookCourts = null,
  bookingStrategy = null,
  preExistingBookings = null,
  arg24 = null,
  arg25 = null
) {
  let context = {};
  let lookAround = null;
  let slotCheckOption = null;
  let lineupGenOption = null;
  let lineupLeadTimeOption = null;
  let remindersOption = null;
  let maxCourtsOption = null;
  let bookingCourtPreferenceOption = null;
  let isSimulation = false;
  let targetDateMDYOverride = null;
  let targetGroupJidOverride = null;
  let timeSlotsOption = null;
  let multiVoteOption = null;
  let multiSessionModeOption = null;
  let slotOverrideOption = null;
  let titleOption = null;
  let hasExplicitTitleOption = false;
  let skippedCourtsOption = [];
  const isCourtSkipped = (courtName) => recurringPollsModule.isCourtSkipped(courtName, skippedCourtsOption);

  const extractExtraOpts = (obj) => {
    if (obj && typeof obj === "object") {
      if (obj.targetGroupJid !== undefined) targetGroupJidOverride = obj.targetGroupJid;
      if (obj.lookAround !== undefined) lookAround = obj.lookAround;
      if (obj.slotCheck !== undefined) slotCheckOption = obj.slotCheck;
      if (obj.lineupGeneration !== undefined) lineupGenOption = obj.lineupGeneration;
      if (obj.lineupLeadTime !== undefined) lineupLeadTimeOption = obj.lineupLeadTime;
      if (obj.reminders !== undefined) remindersOption = obj.reminders;
      else if (obj.remindersPaused !== undefined) remindersOption = !obj.remindersPaused;
      if (obj.maxCourts !== undefined) maxCourtsOption = obj.maxCourts;
      else if (obj['max-courts'] !== undefined) maxCourtsOption = obj['max-courts'];
      if (obj.bookingCourtPreference !== undefined) bookingCourtPreferenceOption = obj.bookingCourtPreference;
      else if (obj['booking-court-preference'] !== undefined) bookingCourtPreferenceOption = obj['booking-court-preference'];
      else if (obj.courtPreference !== undefined) bookingCourtPreferenceOption = obj.courtPreference;
      else if (obj['court-preference'] !== undefined) bookingCourtPreferenceOption = obj['court-preference'];
      else if (obj.courtPreferences !== undefined) bookingCourtPreferenceOption = obj.courtPreferences;
      else if (obj['courts-preference'] !== undefined) bookingCourtPreferenceOption = obj['courts-preference'];
      else if (obj.max_courts !== undefined) maxCourtsOption = obj.max_courts;
      if (obj.simulate !== undefined) isSimulation = Boolean(obj.simulate);
      if (obj.isSimulation !== undefined) isSimulation = Boolean(obj.isSimulation);
      if (obj.dryRun !== undefined) isSimulation = Boolean(obj.dryRun);
      if (obj.mock !== undefined) isSimulation = Boolean(obj.mock);
      if (obj.targetDateMDY !== undefined) targetDateMDYOverride = obj.targetDateMDY;
      if (obj.timeSlots !== undefined) timeSlotsOption = obj.timeSlots;
      if (obj.multiVote !== undefined) multiVoteOption = obj.multiVote;
      if (obj.multiSessionMode !== undefined) multiSessionModeOption = obj.multiSessionMode;
      if (obj.slotOverride !== undefined) slotOverrideOption = obj.slotOverride;
      const tKey = ['title', 'pollTitle', 'poll-title', 'poll_title', 'customTitle'].find((k) => obj[k] !== undefined);
      if (tKey !== undefined) {
        hasExplicitTitleOption = true;
        titleOption = normalizePollTitle(obj[tKey]) || null;
      }
      if (obj.skippedCourts !== undefined) skippedCourtsOption = Array.isArray(obj.skippedCourts) ? obj.skippedCourts : [obj.skippedCourts];
      else if (obj.excludeCourts !== undefined) skippedCourtsOption = Array.isArray(obj.excludeCourts) ? obj.excludeCourts : [obj.excludeCourts];
    }
  };

  if (preExistingBookings && (preExistingBookings.activePolls || preExistingBookings.messageStore || preExistingBookings.persistPolls)) {
    context = preExistingBookings;
    if (typeof arg24 === 'object' && arg24 !== null) {
      lookAround = arg24.lookAround !== undefined ? arg24.lookAround : arg24;
      extractExtraOpts(arg24);
    } else {
      lookAround = arg24;
    }
    if (typeof arg25 === 'object' && arg25 !== null) {
      extractExtraOpts(arg25);
    }
    preExistingBookings = null;
  } else if (arg24 && (arg24.activePolls || arg24.messageStore || arg24.persistPolls)) {
    context = arg24;
    if (typeof arg25 === 'object' && arg25 !== null) {
      extractExtraOpts(arg25);
    } else {
      lookAround = arg25;
    }
  } else if (arg25 && (arg25.activePolls || arg25.messageStore || arg25.persistPolls)) {
    context = arg25;
    if (typeof arg24 === 'object' && arg24 !== null) {
      extractExtraOpts(arg24);
    } else {
      lookAround = arg24;
    }
  } else {
    if (arg24 && typeof arg24 === 'object' && !arg24.activePolls) {
      extractExtraOpts(arg24);
    } else {
      lookAround = arg24;
    }
    if (arg25 && typeof arg25 === 'object') {
      if (arg25.activePolls || arg25.messageStore || arg25.persistPolls) {
        context = arg25;
      } else {
        extractExtraOpts(arg25);
      }
    }
  }

  if (!hasExplicitTitleOption && scheduleId && context?.recurringPolls?.has(scheduleId)) {
    titleOption = normalizePollTitle(context.recurringPolls.get(scheduleId).title) || null;
  }

  const { activePolls, messageStore, latestPollIdByChat, persistPolls } = context;
  const isGroup = remoteJid && remoteJid.endsWith('@g.us');
  let effectiveConfigJid = remoteJid;
  if (!isGroup) {
    effectiveConfigJid = targetGroupJidOverride ||
      context?.targetGroupJid ||
      (typeof getTargetGroupJid === 'function' ? await getTargetGroupJid(sock, creatorJid) : null) ||
      remoteJid;
  }
  const groupCfg = groupsConfig.getGroupConfig(effectiveConfigJid);
  const effectiveLookAround = parseLookAround(lookAround || groupCfg?.lookAround || null);
  let isAuto = size === 'auto' || String(size).toLowerCase() === 'auto';
  const explicitMaxCourts = (maxCourtsOption !== undefined && maxCourtsOption !== null && parseInt(maxCourtsOption, 10) > 0)
    ? parseInt(maxCourtsOption, 10)
    : null;
  const configuredMaxCourts = explicitMaxCourts !== null
    ? explicitMaxCourts
    : (groupCfg?.maxCourts !== undefined && groupCfg?.maxCourts !== null && parseInt(groupCfg.maxCourts, 10) > 0
      ? parseInt(groupCfg.maxCourts, 10)
      : null);

  const effectiveCourtPreference = (bookingCourtPreferenceOption !== null && bookingCourtPreferenceOption !== undefined)
    ? normalizeCourtPreference(bookingCourtPreferenceOption)
    : (scheduleId && context?.recurringPolls?.has(scheduleId) && context.recurringPolls.get(scheduleId).bookingCourtPreference
      ? normalizeCourtPreference(context.recurringPolls.get(scheduleId).bookingCourtPreference)
      : groupsConfig.getBookingCourtPreference(effectiveConfigJid));
  let isOptIn = !size && !isAuto;
  let courtsStrategyOption = null;
  if (typeof arg24 === 'object' && arg24 !== null) {
    courtsStrategyOption = arg24.courtsStrategy || arg24['courts-strategy'] || arg24.courtStrategy || arg24['court-strategy'] || null;
  }
  if (!courtsStrategyOption && typeof arg25 === 'object' && arg25 !== null) {
    courtsStrategyOption = arg25.courtsStrategy || arg25['courts-strategy'] || arg25.courtStrategy || arg25['court-strategy'] || null;
  }
  const schedBookingType = (scheduleId && context?.recurringPolls?.has(scheduleId)) ? context.recurringPolls.get(scheduleId).courtBookingType : null;
  const schedCourtsStrategy = (scheduleId && context?.recurringPolls?.has(scheduleId)) ? context.recurringPolls.get(scheduleId).courtsStrategy : null;
  const rawCourtsStrategy = courtsStrategyOption || schedCourtsStrategy || groupCfg?.courtsStrategy || null;
  let effectiveCourtsStrategy = null;
  if (rawCourtsStrategy && ['book', 'lookup', 'none'].includes(String(rawCourtsStrategy).toLowerCase())) {
    effectiveCourtsStrategy = String(rawCourtsStrategy).toLowerCase();
  } else {
    const effectiveCourtBookingType = courtBookingType || schedBookingType || groupCfg?.courtBookingType || null;
    if (String(effectiveCourtBookingType).toLowerCase() === "pre-book" || String(effectiveCourtBookingType).toLowerCase() === "prebook") {
      effectiveCourtsStrategy = 'book';
    } else if (checkCourts) {
      effectiveCourtsStrategy = 'lookup';
    } else {
      effectiveCourtsStrategy = 'none';
    }
  }
  const isPreBookOption = effectiveCourtsStrategy === 'book';
  const hasExplicitPreBookCourts = preBookCourts !== undefined && preBookCourts !== null && parseInt(preBookCourts, 10) > 0;
  if (!hasExplicitPreBookCourts && isPreBookOption && (explicitMaxCourts || configuredMaxCourts)) {
    preBookCourts = explicitMaxCourts || configuredMaxCourts;
  }

  let effectiveLineupGen;
  if (lineupGenOption !== undefined && lineupGenOption !== null) {
    effectiveLineupGen = lineupGenOption;
  } else if (scheduleId && context.recurringPolls?.has(scheduleId)) {
    const sched = context.recurringPolls.get(scheduleId);
    effectiveLineupGen = sched.lineupGeneration || (sched.noMatchups ? "none" : (sched.autoMatchups !== false ? "filled" : "none"));
  } else if (noMatchups) {
    effectiveLineupGen = "none";
  } else if (groupCfg?.lineupGeneration) {
    effectiveLineupGen = groupCfg.lineupGeneration;
  } else {
    effectiveLineupGen = "filled";
  }

  const effectiveLineupLeadTime = (lineupLeadTimeOption !== undefined && lineupLeadTimeOption !== null)
    ? lineupLeadTimeOption
    : (groupCfg?.lineupLeadTime || 30);

  let effectiveSlotCheck;
  if (slotCheckOption !== undefined && slotCheckOption !== null) {
    effectiveSlotCheck = Boolean(slotCheckOption);
  } else {
    effectiveSlotCheck = true;
  }

  let effectiveSlotOverride = null;
  if (slotOverrideOption !== undefined && slotOverrideOption !== null) {
    if (typeof slotOverrideOption === 'number') {
      effectiveSlotOverride = slotOverrideOption;
    } else if (/^\d+$/.test(slotOverrideOption)) {
      effectiveSlotOverride = parseInt(slotOverrideOption, 10);
    } else if (/^opt-?in$/i.test(slotOverrideOption) || /^yes\s*\/?\s*no$/i.test(slotOverrideOption)) {
      effectiveSlotOverride = 'opt-in';
    }
  }

  if (effectiveSlotOverride !== null) {
    if (effectiveSlotOverride === 'opt-in') {
      size = null;
      isOptIn = true;
      isAuto = false;
    } else {
      size = effectiveSlotOverride;
      isOptIn = false;
      isAuto = false;
    }
  }

  if (size !== null && size !== undefined && !isAuto) {
    const num = parseInt(size, 10);
    if (!Number.isInteger(num) || num <= 0) {
      return { err: `Give me a valid number of players (2, 4, 8, 12, 16) or 'auto', e.g. "${TRIGGER_PREFIX} create a poll for 4" or "${TRIGGER_PREFIX} create a poll for auto", or leave size empty for a Yes/No poll.` };
    }
    if (num > 40) {
      return { err: 'That\'s a lot of players for one poll -- try 40 or fewer.' };
    }
    size = num;
  }

  // Check if this is a Multi-Time Poll
  let resolvedTimeSlots = timeSlotsOption;
  if (!resolvedTimeSlots && when) {
    resolvedTimeSlots = parseMultiTimeSlots(when, dayWord, size);
  }
  if (!resolvedTimeSlots && timeWord && typeof timeWord === "string" && timeWord.includes(",")) {
    resolvedTimeSlots = parseMultiTimeSlots(timeWord, dayWord, size);
  }
  if (Array.isArray(resolvedTimeSlots) && resolvedTimeSlots.length >= 2) {
    return await createMultiTimePoll({
      sock,
      remoteJid,
      effectiveConfigJid,
      groupCfg,
      courtPreference: effectiveCourtPreference,
      size,
      isAuto,
      when,
      dayWord,
      timeSlotsInput: resolvedTimeSlots,
      multiVote: multiVoteOption !== null && multiVoteOption !== undefined ? Boolean(multiVoteOption) : (groupCfg?.multiVote !== undefined ? Boolean(groupCfg.multiVote) : true),
      multiSessionMode: (multiVoteOption === false) ? "single_session" : (multiSessionModeOption || groupCfg?.multiSessionMode || "single_session"),
      creatorName,
      creatorJid,
      replacePollId,
      cancelExisting,
      isCommand,
      effectiveLineupGen,
      effectiveLineupLeadTime,
      remindersOption,
      checkCourts,
      courtsStrategy: effectiveCourtsStrategy,
      slotCheck: effectiveSlotCheck,
      includePrebookedSpots,
      isRecurring,
      scheduleId,
      targetCourt,
      courtBookingType,
      bookingPlayers,
      preBookCourts,
      hasExplicitPreBookCourts,
      bookingStrategy,
      preExistingBookings,
      effectiveLookAround,
      explicitMaxCourts,
      configuredMaxCourts,
      isSimulation,
      targetDateMDYOverride,
      title: titleOption,
      context
    });
  }

  let effectiveDayWord = dayWord;
  let effectiveTimeWord = timeWord;
  if (!effectiveDayWord && when) {
    const dateMatch = when.match(/\b(\d{4}-\d{1,2}-\d{1,2})\b/) ||
      when.match(/\b(\d{1,2}\/\d{1,2}(?:\/\d{2,4})?)\b/);
    if (dateMatch) {
      effectiveDayWord = dateMatch[1];
    } else {
      const dayMatch = when.match(/\b(today|tonight|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tue|wed|thu|fri|sat|sun)\b/i);
      if (dayMatch) effectiveDayWord = dayMatch[1];
    }
  }
  if (!effectiveTimeWord && when) {
    const timeMatch = when.match(/\b(\d{1,2}(?:[:.]\d{2})?\s*(?:am|pm))\b/i) || when.match(/\b(\d{1,2}[:.]\d{2})\b/i);
    if (timeMatch) effectiveTimeWord = timeMatch[1];
  }

  const playAt = resolvePlayDateTime(effectiveDayWord, effectiveTimeWord);
  const sjNow = getSanJoseNow();

  if (!isSimulation && !isRecurring && !targetDateMDYOverride && effectiveDayWord && effectiveTimeWord && playAt.getTime() <= sjNow.getTime()) {
    const specifiedStr = when || `${effectiveDayWord} ${effectiveTimeWord}`;
    return {
      err: `The specified time (${specifiedStr}) has already passed. Please specify an upcoming day or time to create the poll.`
    };
  }

  const flightKey = isSimulation
    ? `${remoteJid}:sim:${Date.now()}:${Math.random().toString(36).slice(2, 7)}`
    : `${remoteJid}:${scheduleId || 'manual'}:${playAt.toISOString()}`;
  if (!isSimulation && inFlightPollCreations.has(flightKey)) {
    console.log(`[poll] Duplicate in-flight poll creation suppressed for ${flightKey}`);
    return { err: 'Poll creation already in progress' };
  }

  if (!isSimulation && scheduleId && !cancelExisting && !replacePollId && activePolls) {
    const playDateStr = playAt.toDateString();
    for (const [id, existingPoll] of activePolls.entries()) {
      if (id !== replacePollId && existingPoll.remoteJid === remoteJid && (existingPoll.status === 'active' || existingPoll.status === 'filled')) {
        if (existingPoll.scheduleId === scheduleId) {
          const exDate = existingPoll.playAt ? new Date(existingPoll.playAt).toDateString() : null;
          if (exDate && exDate === playDateStr) {
            console.log(`[poll] Active poll already exists for schedule ${scheduleId} on ${playDateStr}`);
            return { err: `Active poll already exists for schedule ${scheduleId} on ${playDateStr}` };
          }
        }
      }
    }
  }

  inFlightPollCreations.add(flightKey);
  try {
    const playParts = getSanJoseParts(playAt);
    const nowParts = getSanJoseParts(sjNow);
    const isTomorrow = playParts.day !== nowParts.day || playParts.month !== nowParts.month;
    let resolvedWhen = when;
    if (isTomorrow && !effectiveDayWord) {
      if (resolvedWhen) {
        if (!/\b(today|tomorrow|tonight|monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tue|wed|thu|fri|sat|sun)\b/i.test(resolvedWhen)) {
          resolvedWhen = `Tomorrow ${resolvedWhen}`;
        }
      } else if (effectiveTimeWord) {
        resolvedWhen = `Tomorrow ${effectiveTimeWord}`;
      } else {
        resolvedWhen = 'Tomorrow';
      }
    }

    let shouldIncludeCreator = isAuto ? false : includeCreator;
    let excludedReason = null;

    if (shouldIncludeCreator && (creatorJid || creatorName) && activePolls) {
      const CONFLICT_WINDOW_MS = 90 * 60 * 1000;
      const newPlayTime = playAt.getTime();

      for (const [existingPollId, existingPoll] of activePolls.entries()) {
        if (existingPoll.remoteJid !== remoteJid) continue;
        if (existingPoll.status === 'cancelled') continue;
        if (!existingPoll.playAt) continue;

        const existingPlayTime = new Date(existingPoll.playAt).getTime();
        if (Number.isNaN(existingPlayTime)) continue;

        if (Math.abs(newPlayTime - existingPlayTime) < CONFLICT_WINDOW_MS) {
          if (isUserInPoll(existingPoll, creatorJid, creatorName)) {
            shouldIncludeCreator = false;
            const existingWhen = existingPoll.when || new Date(existingPoll.playAt).toLocaleTimeString('en-US', { timeZone: 'America/Los_Angeles', hour: 'numeric', minute: '2-digit' });
            excludedReason = `a poll already exists for ${creatorName || 'you'} within 90 minutes of this start time (${existingWhen})`;
            console.log(`[poll] Not auto-adding ${creatorName || 'creator'} as Player 1 in new poll: already in poll ${existingPollId} within 90 minutes`);
            break;
          }
        }
      }
    }

    let values;
    let pollTitle;
    let validCount = isAuto ? null : size;
    let leadingVirtualCount = 0;
    let startIdx = 1;
    let courtLine = '';
    let unbookedCourtsForPoll = [];

    let prebookedCourtPlayers = [];
    let prebookedInfo = [];
    let queryTime = effectiveTimeWord;
    if (!queryTime && playAt) {
      const sjParts = getSanJoseParts(playAt);
      const h = sjParts.hour === 0 ? 12 : (sjParts.hour > 12 ? sjParts.hour - 12 : sjParts.hour);
      const m = String(sjParts.minute).padStart(2, '0');
      const ampm = sjParts.hour >= 12 ? 'pm' : 'am';
      queryTime = `${h}:${m}${ampm}`;
    }
    const targetDateMDY = targetDateMDYOverride || scvcc.resolveDateToMDY(effectiveDayWord || resolvedWhen || playAt);
    let selectedPrebooked = [];
    let selectedFree = [];
    let selectedTentative = [];

    let prebookedCourts = [];
    let freeCourts = [];
    let tentativeCourts = [];
    const advanceBookedCourts = [];

    const preExistingAuto = preExistingBookings && (preExistingBookings.autoBookedCourts || preExistingBookings.advanceBookedCourts);
    if (preExistingBookings && (
      (Array.isArray(preExistingAuto) && preExistingAuto.length > 0) ||
      (Array.isArray(preExistingBookings.prebookedCourts) && preExistingBookings.prebookedCourts.length > 0)
    )) {
      if (Array.isArray(preExistingAuto)) {
        for (const abc of preExistingAuto) {
          if (isCourtSkipped(abc.court)) continue;
          advanceBookedCourts.push(abc);
          if (!prebookedCourts.some((pb) => pb.court && abc.court && pb.court.toLowerCase().trim() === abc.court.toLowerCase().trim())) {
            prebookedCourts.push({
              court: abc.court,
              player: abc.players?.[0] || 'Member',
              fullName: (abc.players && abc.players.length > 0) ? abc.players.join(', ') : 'Member',
              time: abc.time,
              bookingType: 'auto'
            });
          }
        }
      }
      if (Array.isArray(preExistingBookings.prebookedCourts)) {
        for (const pb of preExistingBookings.prebookedCourts) {
          if (isCourtSkipped(pb.court)) continue;
          if (!prebookedCourts.some((existing) => existing.court && pb.court && existing.court.toLowerCase().trim() === pb.court.toLowerCase().trim())) {
            const isAuto = advanceBookedCourts.some((a) => a.court && pb.court && a.court.toLowerCase().trim() === pb.court.toLowerCase().trim());
            prebookedCourts.push({
              ...pb,
              bookingType: pb.bookingType || (isAuto ? 'auto' : 'manual')
            });
          }
        }
      }
      console.log(`[poll] Using pre-existing booked courts for ${remoteJid} on ${targetDateMDY}: advance=`, advanceBookedCourts, 'prebooked=', prebookedCourts);
    } else {
      const isPreBook = String(courtBookingType).toLowerCase() === 'pre-book' || String(courtBookingType).toLowerCase() === 'prebook';
      if (!isSimulation && isPreBook && groupsConfig.isCourtBookingEnabled(remoteJid)) {
        const groupCfg = groupsConfig.getGroupConfig(remoteJid);
        const effectiveStrategy = bookingStrategy || groupCfg?.bookingStrategy || 'instant';
        if (effectiveStrategy !== 'advanced') {
          const bookRes = await preBookCourtsForMatch({
            sock,
            remoteJid,
            targetDateMDY,
            queryTime,
            court: targetCourt,
            targetCourt,
            size,
            isAuto,
            preBookCourts,
            maxCourts: explicitMaxCourts,
            courtPreference: effectiveCourtPreference,
            bookingPlayers,
            creatorName,
            creatorJid,
            minAvailableMinutes: 90,
            lookAround: effectiveLookAround
          });
          if (bookRes.advanceBookedCourts?.length > 0) {
            advanceBookedCourts.push(...bookRes.advanceBookedCourts);
          }
          if (bookRes.prebookedCourts?.length > 0) {
            for (const pb of bookRes.prebookedCourts) {
              const isAuto = advanceBookedCourts.some((a) => a.court && pb.court && a.court.toLowerCase().trim() === pb.court.toLowerCase().trim());
              prebookedCourts.push({
                ...pb,
                bookingType: isAuto ? 'auto' : (pb.bookingType || 'manual')
              });
            }
          }
        } else {
          console.log(`[poll] bookingStrategy is 'advanced' for ${remoteJid}; court pre-booking is managed by bookingSchedule.`);
        }
      }
    }

    const effectiveCheckCourts = effectiveCourtsStrategy === 'book' || effectiveCourtsStrategy === 'lookup';
    const hasCourtChecks = isAuto || (effectiveCheckCourts && Boolean(queryTime));
    let courtCheckPerformed = false;

    if (hasCourtChecks) {
      const seenPrebooked = new Set(prebookedCourts.map((c) => c.court));
      const seenFree = new Set(freeCourts.map((c) => c.court));
      const seenTentative = new Set();
      const candidateTimes = getCandidateTimes(queryTime, effectiveLookAround);
      const closedTimes = [];

      for (const t of candidateTimes) {
        try {
          const [avail, bookingsRes] = await Promise.all([
            scvcc.checkCourtAvailability({ when: targetDateMDY, time: t, sport: 'tennis', chatId: effectiveConfigJid }).catch((err) => {
              console.warn(`[poll] Error checking court availability at ${t}:`, err.message);
              return null;
            }),
            scvcc.getCourtBookings({ when: targetDateMDY, time: t, sport: 'tennis', chatId: effectiveConfigJid }).catch((err) => {
              console.warn(`[poll] Error checking court bookings at ${t}:`, err.message);
              return null;
            })
          ]);

          if (avail || bookingsRes) {
            courtCheckPerformed = true;
          }

          const closedCheck = typeof scvcc.detectClubClosed === 'function'
            ? scvcc.detectClubClosed({ avail, bookingsRes, time: t, chatId: effectiveConfigJid })
            : { clubClosed: false, title: null };
          if (closedCheck.clubClosed) {
            closedTimes.push({ time: t, title: closedCheck.title || null });
            continue;
          }

          const bookings = bookingsRes?.bookings || [];
          for (const b of bookings) {
            if (courtsConfig.isIgnoredCourt(b.court) || isCourtSkipped(b.court)) continue;
            if (seenPrebooked.has(b.court)) continue;
            if (b.durationMins && b.durationMins < 90) continue;
            const prebookedMatch = (scvcc.detectPrebookedCourt || detectPrebookedCourt)(b, effectiveConfigJid);
            if (prebookedMatch) {
              const isAuto = advanceBookedCourts.some((a) => a.court && b.court && a.court.toLowerCase().trim() === b.court.toLowerCase().trim());
              prebookedCourts.push({
                court: b.court,
                player: prebookedMatch.player,
                fullName: prebookedMatch.fullName,
                time: t,
                bookingType: isAuto ? 'auto' : 'manual'
              });
              seenPrebooked.add(b.court);
              if (seenTentative.has(b.court)) {
                tentativeCourts = tentativeCourts.filter((tc) => tc.court.toLowerCase() !== b.court.toLowerCase());
                seenTentative.delete(b.court);
              }
            } else if (!seenFree.has(b.court) && !seenTentative.has(b.court)) {
              const titleToCheck = b.blockTitle || b.type;
              if (groupsConfig.isTentativeBookingTitle(titleToCheck, effectiveConfigJid) || groupsConfig.isTentativeBookingTitle(b.blockTitle, effectiveConfigJid) || groupsConfig.isTentativeBookingTitle(b.type, effectiveConfigJid)) {
                tentativeCourts.push({
                  court: b.court,
                  time: t,
                  title: titleToCheck,
                  durationMins: b.durationMins
                });
                seenTentative.add(b.court);
              }
            }
          }

          if (avail?.slots && avail.slots.length > 0) {
            const slot = avail.slots[0];
            for (const c of slot.courts) {
              if (courtsConfig.isIgnoredCourt(c.court) || isCourtSkipped(c.court)) continue;
              const durationMins = c.durationMins || c.totalDurationMins || c.availableMinutes || null;
              if (c.status === 'prebooked' && !seenPrebooked.has(c.court)) {
                if (durationMins && durationMins < 90) continue;
                const isAuto = advanceBookedCourts.some((a) => a.court && c.court && a.court.toLowerCase().trim() === c.court.toLowerCase().trim());
                prebookedCourts.push({
                  court: c.court,
                  player: c.prebookedBy || 'Member',
                  fullName: c.prebookedFullName || c.prebookedBy || 'Member',
                  time: t,
                  bookingType: isAuto ? 'auto' : 'manual'
                });
                seenPrebooked.add(c.court);
                if (seenTentative.has(c.court)) {
                  tentativeCourts = tentativeCourts.filter((tc) => tc.court.toLowerCase() !== c.court.toLowerCase());
                  seenTentative.delete(c.court);
                }
              } else if (
                c.status === 'available' &&
                (c.availableMinutes || 0) >= 90 &&
                !seenPrebooked.has(c.court) &&
                !seenFree.has(c.court)
              ) {
                freeCourts.push({ court: c.court, time: t });
                seenFree.add(c.court);
                if (seenTentative.has(c.court)) {
                  tentativeCourts = tentativeCourts.filter((tc) => tc.court.toLowerCase() !== c.court.toLowerCase());
                  seenTentative.delete(c.court);
                }
              } else if (
                (c.overrideAvailableMinutes || 0) >= 90 &&
                !c.blockTitle &&
                (!Array.isArray(c.prebookedPlayers) || c.prebookedPlayers.length === 0) &&
                !seenPrebooked.has(c.court) &&
                !seenFree.has(c.court)
              ) {
                freeCourts.push({ court: c.court, isOverride: true, time: t });
                seenFree.add(c.court);
                if (seenTentative.has(c.court)) {
                  tentativeCourts = tentativeCourts.filter((tc) => tc.court.toLowerCase() !== c.court.toLowerCase());
                  seenTentative.delete(c.court);
                }
              } else if (
                !seenPrebooked.has(c.court) &&
                !seenFree.has(c.court) &&
                !seenTentative.has(c.court)
              ) {
                const titleToCheck = c.blockTitle;
                if (groupsConfig.isTentativeBookingTitle(titleToCheck, effectiveConfigJid)) {
                  tentativeCourts.push({
                    court: c.court,
                    time: t,
                    title: titleToCheck,
                    durationMins
                  });
                  seenTentative.add(c.court);
                }
              }
            }
          }
        } catch (err) {
          console.warn(`[poll] Error checking court availability/bookings for poll at ${t}:`, err.message);
        }
      }

      if (targetCourt && !isCourtSkipped(targetCourt) && !seenPrebooked.has(targetCourt)) {
        prebookedCourts.push({
          court: targetCourt,
          player: creatorName || 'Member',
          fullName: creatorName || 'Member'
        });
        seenPrebooked.add(targetCourt);
        if (seenTentative.has(targetCourt)) {
          tentativeCourts = tentativeCourts.filter((tc) => tc.court.toLowerCase() !== targetCourt.toLowerCase());
          seenTentative.delete(targetCourt);
        }
      }

      const totalCourtsCount = prebookedCourts.length + freeCourts.length + tentativeCourts.length;
      if (!effectiveSlotOverride && courtCheckPerformed && totalCourtsCount === 0) {
        const displayDate = scvcc.formatDisplayDate(targetDateMDY);
        const timeLabel = resolvedWhen || `${displayDate} at ${queryTime}`;
        const allTimesClosed = candidateTimes.length > 0 && closedTimes.length >= candidateTimes.length;
        const closedTitle = allTimesClosed ? (closedTimes.find((ct) => ct.title)?.title || null) : null;
        const titleSuffix = closedTitle ? ` (${closedTitle})` : '';
        const noCourtsMsg = allTimesClosed
          ? `🚫 Cannot create poll for *${timeLabel}*: Club is closed${titleSuffix}.`
          : `⚠️ Cannot create poll for *${timeLabel}*: No live or prebooked courts are available at SCVCC (all courts are reserved or blocked).`;
        console.log(`[poll] Cancelling poll creation in ${remoteJid}: no live or prebooked courts for ${timeLabel}`);
        if (sock && remoteJid && !isRecurring && !isSimulation) {
          try {
            await sendMessageAndRecord(sock, remoteJid, { text: noCourtsMsg });
          } catch (sendErr) {
            console.error('[poll] Error sending no courts message:', sendErr.message);
          }
        }
        return {
          err: noCourtsMsg,
          noCourtsAvailable: true,
          ...(allTimesClosed ? { clubClosed: true, clubClosedTitle: closedTitle } : {}),
          message: noCourtsMsg,
          isSimulation: Boolean(isSimulation)
        };
      }
    } else if (targetCourt) {
      prebookedCourts.push({
        court: targetCourt,
        player: creatorName || 'Member',
        fullName: creatorName || 'Member'
      });
    }

    let replacedOldPoll = false;
    if (!isSimulation) {
      if (replacePollId && activePolls && activePolls.has(replacePollId)) {
        await cancelOrDeletePoll(sock, remoteJid, replacePollId, context, { releaseCourts: false });
        replacedOldPoll = true;
      } else if (cancelExisting && activePolls) {
        for (const [pollId, pollState] of [...activePolls.entries()].reverse()) {
          if (pollState.remoteJid === remoteJid && pollState.status === 'active' && !pollState.isManual) {
            await cancelOrDeletePoll(sock, remoteJid, pollId, context, { releaseCourts: false });
            replacedOldPoll = true;
            break;
          }
        }
      }
    }

    if (isAuto) {
      const maxAutoCourts = configuredMaxCourts !== null
        ? configuredMaxCourts
        : Math.max(3, advanceBookedCourts.length, (preBookCourts ? parseInt(preBookCourts, 10) : 0));
      const sortedPrebooked = sortCourtsByPreference(prebookedCourts, effectiveCourtPreference);
      const sortedFree = sortCourtsByPreference(freeCourts, effectiveCourtPreference);
      const sortedTentative = sortCourtsByPreference(tentativeCourts, effectiveCourtPreference);

      selectedPrebooked = sortedPrebooked.slice(0, maxAutoCourts);
      const remainingNeededForFree = Math.min(sortedFree.length, Math.max(0, maxAutoCourts - selectedPrebooked.length));
      selectedFree = sortedFree.slice(0, remainingNeededForFree);
      unbookedCourtsForPoll = selectedFree.map((fc) => ({ court: fc.court, time: fc.time || null, isOverride: Boolean(fc.isOverride) }));

      const remainingNeededForTentative = Math.min(sortedTentative.length, Math.max(0, maxAutoCourts - selectedPrebooked.length - selectedFree.length));
      selectedTentative = sortedTentative.slice(0, remainingNeededForTentative);

      const totalCourtsCount = selectedPrebooked.length + selectedFree.length + selectedTentative.length;
      validCount = totalCourtsCount > 0 ? totalCourtsCount * 4 : 4;

      const bookedSlotsLimit = selectedPrebooked.length * 4;
      const hasUnsecuredCourts = selectedFree.length > 0 || selectedTentative.length > 0;

      const courtLines = [];
      prebookedInfo = [];
      for (const pb of selectedPrebooked) {
        const match = namesStore.findIdByNameOrAlias(pb.player);
        const canonicalName = (match && match.entry?.name) ? match.entry.name : pb.player;
        courtLines.push(formatCourtBookingTitleLine(pb.court, pb.time, queryTime));
        if (includePrebookedSpots) {
          const slotPlayerName = addNextCreatorPlayer(prebookedCourtPlayers, canonicalName);
          const slotLabel = `${slotPlayerName}'s Spot`;
          prebookedInfo.push({
            slotName: slotLabel,
            defaultPlayer: slotPlayerName,
            fullName: pb.player,
            court: pb.court
          });
        }
      }
      for (const fc of selectedFree) {
        courtLines.push(formatCourtAvailableTitleLine(fc.court, fc.time, queryTime));
      }
      for (const tc of selectedTentative) {
        courtLines.push(formatCourtTentativeTitleLine(tc.court, tc.time, queryTime));
      }

      if (courtLines.length > 0) {
        courtLine = `\n\n${courtLines.join('\n')}\n`;
      }

      if (includePrebookedSpots && prebookedInfo.length > 0) {
        const prebookedCount = prebookedInfo.length;
        values = [];
        for (const pb of prebookedInfo) {
          values.push(pb.slotName);
        }
        for (let i = prebookedCount + 1; i <= validCount; i++) {
          const isUnsecuredSlot = hasUnsecuredCourts && i > bookedSlotsLimit;
          values.push(isUnsecuredSlot ? `Player ${i}${TENTATIVE_SLOT_TAG}` : `Player ${i}`);
        }
        startIdx = 1;
        leadingVirtualCount = 0;
      } else {
        startIdx = 1;
        leadingVirtualCount = 0;
        values = Array.from({ length: validCount }, (_, i) => {
          const slotNum = i + 1;
          const isUnsecuredSlot = hasUnsecuredCourts && slotNum > bookedSlotsLimit;
          return isUnsecuredSlot ? `Player ${slotNum}${TENTATIVE_SLOT_TAG}` : `Player ${slotNum}`;
        });
      }
    } else if (!isOptIn) {
      const givenCount = size;
      if (isValidPlayerCount(givenCount)) {
        validCount = givenCount;
        startIdx = shouldIncludeCreator ? 2 : 1;
        const count = shouldIncludeCreator ? givenCount - 1 : givenCount;
        leadingVirtualCount = shouldIncludeCreator ? 1 : 0;
        values = Array.from({ length: count }, (_, i) => `Player ${i + startIdx}`);
      } else {
        validCount = getNextValidPlayerCount(givenCount);
        leadingVirtualCount = validCount - givenCount;
        startIdx = validCount - givenCount + 1;
        const count = givenCount;
        values = Array.from({ length: count }, (_, i) => `Player ${i + startIdx}`);
      }

      const totalCourtsCount = prebookedCourts.length + freeCourts.length + tentativeCourts.length;
      if (targetCourt || (effectiveCheckCourts && totalCourtsCount > 0) || prebookedCourts.length > 0 || tentativeCourts.length > 0) {
        const courtsPerMatch = courtBookingType === 'singles' ? 2 : 4;
        const courtsNeeded = Math.ceil(validCount / courtsPerMatch);
        const sortedPrebooked = sortCourtsByPreference(prebookedCourts, effectiveCourtPreference);
        const sortedFree = sortCourtsByPreference(freeCourts, effectiveCourtPreference);
        const sortedTentative = sortCourtsByPreference(tentativeCourts, effectiveCourtPreference);

        selectedPrebooked = sortedPrebooked.slice(0, courtsNeeded);
        const neededFree = Math.min(sortedFree.length, Math.max(0, courtsNeeded - selectedPrebooked.length));
        selectedFree = sortedFree.slice(0, neededFree);
        if (selectedFree.length > 0) {
          unbookedCourtsForPoll = selectedFree.map((fc) => ({ court: fc.court, time: fc.time || null, isOverride: Boolean(fc.isOverride) }));
        }
        const neededTentative = Math.min(sortedTentative.length, Math.max(0, courtsNeeded - selectedPrebooked.length - selectedFree.length));
        selectedTentative = sortedTentative.slice(0, neededTentative);

        const totalCourtsFound = selectedPrebooked.length + selectedFree.length + selectedTentative.length;
        if (!effectiveSlotOverride && effectiveCheckCourts && courtCheckPerformed && totalCourtsFound < courtsNeeded) {
          const scaledCount = Math.max(courtsPerMatch, totalCourtsFound * courtsPerMatch);
          if (scaledCount < validCount) {
            console.log(`[poll] Scaling down poll size from ${validCount} to ${scaledCount} based on ${totalCourtsFound} courts found (booked: ${selectedPrebooked.length}, free: ${selectedFree.length}, tentative: ${selectedTentative.length})`);
            validCount = scaledCount;
            startIdx = shouldIncludeCreator ? 2 : 1;
            const count = shouldIncludeCreator ? validCount - 1 : validCount;
            leadingVirtualCount = shouldIncludeCreator ? 1 : 0;
            values = Array.from({ length: count }, (_, i) => `Player ${i + startIdx}`);
          }
        }

        const bookedCourtsCount = selectedPrebooked.length;
        const bookedSlotsLimit = bookedCourtsCount * courtsPerMatch;

        if (selectedFree.length > 0 || selectedTentative.length > 0) {
          values = values.map((val, idx) => {
            const slotNum = idx + startIdx;
            if (slotNum > bookedSlotsLimit) {
              return (val.endsWith(TENTATIVE_SLOT_TAG) || val.endsWith('*')) ? val : `${val}${TENTATIVE_SLOT_TAG}`;
            }
            return val;
          });
        }

        if ((selectedPrebooked.length > 0 || selectedFree.length > 0 || selectedTentative.length > 0) && !targetCourt) {
          const pbLines = selectedPrebooked.map((pb) => formatCourtBookingTitleLine(pb.court, pb.time, queryTime));
          for (const fc of selectedFree) {
            pbLines.push(formatCourtAvailableTitleLine(fc.court, fc.time, queryTime));
          }
          for (const tc of selectedTentative) {
            pbLines.push(formatCourtTentativeTitleLine(tc.court, tc.time, queryTime));
          }
          courtLine = `\n\n${pbLines.join('\n')}\n`;
        } else if (targetCourt) {
          const pbMatch = prebookedCourts.find((pb) => pb.court.toLowerCase() === targetCourt.toLowerCase());
          const tcMatch = tentativeCourts.find((tc) => tc.court.toLowerCase() === targetCourt.toLowerCase());
          if (pbMatch) {
            courtLine = `\n\n${formatCourtBookingTitleLine(targetCourt, pbMatch.time, queryTime)}\n`;
          } else if (tcMatch) {
            courtLine = `\n\n${formatCourtTentativeTitleLine(targetCourt, tcMatch.time, queryTime)}\n`;
          } else {
            const rawCourtText = `${targetCourt.toUpperCase()} AVAILABLE`;
            const largeCourtText = rawCourtText.replace(/[A-Z0-9]/g, (ch) => {
              const code = ch.charCodeAt(0);
              if (code >= 48 && code <= 57) return String.fromCodePoint(0x1D7EC + (code - 48));
              if (code >= 65 && code <= 90) return String.fromCodePoint(0x1D5D4 + (code - 65));
              return ch;
            });
            courtLine = `\n\n_${largeCourtText}_\n`;
          }
        } else if (effectiveCheckCourts && totalCourtsCount > 0) {
          const courtWord = totalCourtsCount === 1 ? 'COURT' : 'COURTS';
          const rawCourtText = `${totalCourtsCount} ${courtWord} AVAILABLE`;
          const largeCourtText = rawCourtText.replace(/[A-Z0-9]/g, (ch) => {
            const code = ch.charCodeAt(0);
            if (code >= 48 && code <= 57) return String.fromCodePoint(0x1D7EC + (code - 48));
            if (code >= 65 && code <= 90) return String.fromCodePoint(0x1D5D4 + (code - 65));
            return ch;
          });
          courtLine = `\n\n_${largeCourtText}_\n`;
        }
      }
    } else {
      values = ['Yes', 'No'];

      const totalCourtsCount = prebookedCourts.length + freeCourts.length + tentativeCourts.length;
      if (targetCourt || (effectiveCheckCourts && totalCourtsCount > 0) || prebookedCourts.length > 0 || tentativeCourts.length > 0) {
        if ((prebookedCourts.length > 0 || tentativeCourts.length > 0) && !targetCourt) {
          const pbLines = prebookedCourts.map((pb) => formatCourtBookingTitleLine(pb.court, pb.time, queryTime));
          for (const fc of freeCourts) {
            pbLines.push(formatCourtAvailableTitleLine(fc.court, fc.time, queryTime));
          }
          for (const tc of tentativeCourts) {
            pbLines.push(formatCourtTentativeTitleLine(tc.court, tc.time, queryTime));
          }
          courtLine = `\n\n${pbLines.join('\n')}\n`;
        } else if (targetCourt) {
          const pbMatch = prebookedCourts.find((pb) => pb.court.toLowerCase() === targetCourt.toLowerCase());
          const tcMatch = tentativeCourts.find((tc) => tc.court.toLowerCase() === targetCourt.toLowerCase());
          if (pbMatch) {
            courtLine = `\n\n${formatCourtBookingTitleLine(targetCourt, pbMatch.time, queryTime)}\n`;
          } else if (tcMatch) {
            courtLine = `\n\n${formatCourtTentativeTitleLine(targetCourt, tcMatch.time, queryTime)}\n`;
          } else {
            const rawCourtText = `${targetCourt.toUpperCase()} AVAILABLE`;
            const largeCourtText = rawCourtText.replace(/[A-Z0-9]/g, (ch) => {
              const code = ch.charCodeAt(0);
              if (code >= 48 && code <= 57) return String.fromCodePoint(0x1D7EC + (code - 48));
              if (code >= 65 && code <= 90) return String.fromCodePoint(0x1D5D4 + (code - 65));
              return ch;
            });
            courtLine = `\n\n_${largeCourtText}_\n`;
          }
        } else if (effectiveCheckCourts && totalCourtsCount > 0) {
          const courtWord = totalCourtsCount === 1 ? 'COURT' : 'COURTS';
          const rawCourtText = `${totalCourtsCount} ${courtWord} AVAILABLE`;
          const largeCourtText = rawCourtText.replace(/[A-Z0-9]/g, (ch) => {
            const code = ch.charCodeAt(0);
            if (code >= 48 && code <= 57) return String.fromCodePoint(0x1D7EC + (code - 48));
            if (code >= 65 && code <= 90) return String.fromCodePoint(0x1D5D4 + (code - 65));
            return ch;
          });
          courtLine = `\n\n_${largeCourtText}_\n`;
        }
      }
    }
    const isMultiPoll = !isOptIn && Array.isArray(values) && values.length > 12;
    const courtsPerMatch = courtBookingType === 'singles' ? 2 : 4;
    const batches = isMultiPoll ? partitionMatchSlots(validCount, courtsPerMatch) : [validCount];
    const maxInitialPolls = groupsConfig.getMaxInitialPolls(remoteJid);
    const initialPollCount = isMultiPoll ? Math.min(batches.length, maxInitialPolls) : 1;

    const timeLabel = resolvedWhen ? resolvedWhen : 'today';
    const hasPrebooked = !isOptIn && Array.isArray(prebookedCourtPlayers) && prebookedCourtPlayers.length > 0 && includePrebookedSpots;

    let sessionId = null;
    if (isMultiPoll) {
      sessionId = `session_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    }

    const createdPolls = [];
    const masterValues = [...values];

    for (let k = 0; k < initialPollCount; k++) {
      const batchSize = batches[k];
      const batchStartSlot = batches.slice(0, k).reduce((sum, b) => sum + b, 0) + 1;
      const batchEndSlot = batchStartSlot + batchSize - 1;

      let partValues;
      if (isMultiPoll) {
        const sliceStart = batchStartSlot < startIdx ? 0 : (batchStartSlot - startIdx);
        const sliceEnd = batchEndSlot - startIdx + 1;
        partValues = masterValues.slice(sliceStart, sliceEnd);
      } else {
        partValues = masterValues;
      }

      let pollTitle;
      if (isOptIn) {
        const creatorLabel = shouldIncludeCreator && creatorName ? `${creatorName}'s poll: ` : '';
        pollTitle = formatPollTitle({
          customTitle: titleOption,
          isSimulation,
          creatorLabel,
          timeLabel,
          suffix: ' (Vote Yes/No)',
          courtLine
        });
      } else if (isMultiPoll) {
        const creatorLabel = (k === 0 && !isAuto && !hasPrebooked && (shouldIncludeCreator || leadingVirtualCount > 0) && creatorName) ? `${creatorName}'s poll: ` : '';
        const courtPart = k === 0 ? courtLine : '';
        pollTitle = formatPollTitle({
          customTitle: titleOption,
          isSimulation,
          creatorLabel,
          timeLabel,
          suffix: ` (Part ${k + 1}/${batches.length}: Spots ${batchStartSlot}–${batchEndSlot})`,
          courtLine: courtPart
        });
      } else {
        const slotCount = partValues.length;
        const slotLabel = slotCount === 1 ? '1 slot' : `${slotCount} slots`;
        const creatorLabel = (!isAuto && !hasPrebooked && (shouldIncludeCreator || leadingVirtualCount > 0) && creatorName) ? `${creatorName}'s poll: ` : '';
        pollTitle = formatPollTitle({
          customTitle: titleOption,
          isSimulation,
          creatorLabel,
          timeLabel,
          suffix: ` (${slotLabel} / ${validCount})`,
          courtLine
        });
      }

      let pollId = `mock_poll_${Date.now()}_${Math.random().toString(36).slice(2, 7)}_${k}`;
      let sent = null;
      if (sock && typeof sock.sendMessage === 'function') {
        try {
          sent = await sock.sendMessage(remoteJid, {
            poll: {
              name: pollTitle,
              values: partValues,
              selectableCount: 1
            }
          });
          if (sent?.key?.id) {
            pollId = sent.key.id;
          }
        } catch (err) {
          console.error('[poll] Error sending poll message:', err.message);
        }
      }

      createdPolls.push({
        pollId,
        pollTitle,
        partValues,
        batchSize,
        batchStartSlot,
        batchEndSlot,
        partNumber: k + 1,
        sent
      });
    }

    const allCandidatePrebooked = (selectedPrebooked && selectedPrebooked.length > 0 ? selectedPrebooked : prebookedCourts);

    const finalAutoBookedCourts = advanceBookedCourts.map((b) => ({
      court: b.court,
      time: b.time || queryTime || null,
      reservationId: b.reservationId || null,
      players: b.players || [],
      duration: b.duration || '90 Minutes',
      partySize: b.partySize || 'Doubles',
      bookedAt: b.bookedAt || new Date().toISOString(),
      bookedSource: b.bookedSource || 'advance'
    }));

    const autoCourtNames = new Set(finalAutoBookedCourts.map((b) => formatCourtLabel(b.court).toLowerCase()));

    for (const pb of allCandidatePrebooked) {
      const cLabel = formatCourtLabel(pb.court).toLowerCase();
      if (pb.bookingType === 'auto' && !autoCourtNames.has(cLabel)) {
        finalAutoBookedCourts.push({
          court: pb.court,
          time: pb.time || queryTime || null,
          reservationId: pb.reservationId || null,
          players: pb.players || (pb.fullName ? pb.fullName.split(/[,;&+]|\band\b/i).map((s) => s.trim()).filter(Boolean) : (pb.player ? [pb.player] : [])),
          duration: pb.duration || '90 Minutes',
          partySize: pb.partySize || 'Doubles',
          bookedAt: pb.bookedAt || new Date().toISOString(),
          bookedSource: pb.bookedSource || 'advance'
        });
        autoCourtNames.add(cLabel);
      }
    }

    const finalManuallyBookedCourts = allCandidatePrebooked
      .filter((c) => !autoCourtNames.has(formatCourtLabel(c.court).toLowerCase()))
      .map((pb) => ({
        court: pb.court,
        time: pb.time || queryTime || null,
        players: pb.players || (pb.fullName ? pb.fullName.split(/[,;&+]|\band\b/i).map((s) => s.trim()).filter(Boolean) : (pb.player ? [pb.player] : []))
      }));

    const finalPrebookedCourts = [
      ...finalAutoBookedCourts.map((ab) => ({
        court: ab.court,
        player: ab.players?.[0] || 'Member',
        fullName: (ab.players && ab.players.length > 0) ? ab.players.join(', ') : 'Member',
        time: ab.time || null,
        bookingType: 'auto'
      })),
      ...finalManuallyBookedCourts.map((mb) => ({
        court: mb.court,
        player: mb.players?.[0] || 'Member',
        fullName: (mb.players && mb.players.length > 0) ? mb.players.join(', ') : 'Member',
        time: mb.time || null,
        bookingType: 'manual'
      }))
    ];
    if (finalPrebookedCourts.length === 0 && targetCourt) {
      finalPrebookedCourts.push({
        court: targetCourt,
        player: creatorName || 'Member',
        fullName: creatorName || 'Member',
        time: queryTime || null,
        bookingType: advanceBookedCourts.some((a) => a.court && targetCourt && a.court.toLowerCase().trim() === targetCourt.toLowerCase().trim()) ? 'auto' : 'manual'
      });
    }

    const allCreatedPollIds = createdPolls.map((p) => p.pollId);

    if (!isSimulation) {
      for (const cp of createdPolls) {
        if (messageStore && cp.sent?.key) messageStore.set(storeKey(cp.sent.key.remoteJid, cp.pollId), cp.sent.message);
        const initialHours = (playAt.getTime() - Date.now()) / (60 * 60 * 1000);
        const sentReminders = POWERS_OF_2_REMINDER_HOURS.filter((h) => h > initialHours && h > 1);

        if (activePolls) {
          activePolls.set(cp.pollId, {
            remoteJid,
            title: titleOption || null,
            name: cp.pollTitle,
            options: cp.partValues,
            size: isOptIn ? null : cp.batchSize,
            type: isOptIn ? 'opt_in' : 'fixed',
            when: resolvedWhen || null,
            playAt: playAt.toISOString(),
            createdAt: new Date().toISOString(),
            status: 'active',
            isManual: false,
            isCommand: Boolean(isCommand),
            slotCheck: effectiveSlotCheck,
            lineupGeneration: effectiveLineupGen,
            lineupLeadTime: effectiveLineupLeadTime,
            lineupLeadTimeDisplay: formatLookAround(effectiveLineupLeadTime),
            manualLineupPosted: false,
            lineupReminderSent: false,
            reminders: remindersOption !== null ? Boolean(remindersOption) : true,
            isAuto: Boolean(isAuto),
            maxCourts: configuredMaxCourts || null,
            bookingCourtPreference: (effectiveCourtPreference && effectiveCourtPreference.length > 0) ? effectiveCourtPreference : null,
            isRecurring: Boolean(isRecurring),
            isAutoCreated: Boolean(isAuto || isRecurring),
            slotOverride: effectiveSlotOverride || undefined,
            skippedCourts: skippedCourtsOption.length > 0 ? recurringPollsModule.normalizeCourtList(skippedCourtsOption) : undefined,
            scheduleId: scheduleId || null,
            courtsStrategy: effectiveCourtsStrategy,
            court: targetCourt || null,
            preBookCourts: (preBookCourts !== undefined && preBookCourts !== null && parseInt(preBookCourts, 10) > 0) ? parseInt(preBookCourts, 10) : null,
            explicitPreBookCourts: Boolean(hasExplicitPreBookCourts),
            advanceBookedCourts: finalAutoBookedCourts,
            tentativeCourts: ((selectedTentative && selectedTentative.length > 0) || tentativeCourts.length > 0)
              ? (selectedTentative && selectedTentative.length > 0 ? selectedTentative : tentativeCourts).map((tc) => ({ court: tc.court, time: tc.time || null, title: tc.title || null }))
              : null,
            autoBookedCourts: finalAutoBookedCourts,
            manuallyBookedCourts: finalManuallyBookedCourts,
            bookingPlayers: bookingPlayers || null,
            targetDateMDY: targetDateMDY || null,
            queryTime: queryTime || null,
            prebookedCourts: finalPrebookedCourts,
            prebookedPlayers: (!isOptIn && hasPrebooked && cp.partNumber === 1) ? prebookedInfo : null,
            unbookedCourts: unbookedCourtsForPoll.length > 0 ? unbookedCourtsForPoll : null,
            onDemandBookingInProgress: false,
            invalidSlotVotesNotified: [],
            courtReleaseWarningsSent: [],
            courtReleasesDone: [],
            releasedCourts: [],
            creator: (!isAuto && !hasPrebooked && cp.partNumber === 1 && (shouldIncludeCreator || leadingVirtualCount > 0)) ? { name: (creatorName || 'Player 1'), jid: creatorJid || null } : null,
            createdBy: (creatorName || creatorJid) ? { name: creatorName || 'Player 1', jid: creatorJid || null } : null,
            lastConflictSignature: null,
            voteBuffer: new Map(),
            lastPlayers: null,
            sentReminders,
            lookAround: effectiveLookAround,
            lookAroundDisplay: formatLookAround(effectiveLookAround),
            // Multi-poll session tracking:
            parentPollId: sessionId || null,
            partNumber: cp.partNumber,
            totalParts: batches.length,
            startSlot: cp.batchStartSlot,
            endSlot: cp.batchEndSlot,
            partSize: cp.batchSize,
            sessionTotalSize: validCount,
            siblingPollIds: allCreatedPollIds.filter((id) => id !== cp.pollId),
            plannedBatches: batches,
            allPollValues: masterValues,
            startIdx
          });
        }
      }

      if (latestPollIdByChat) latestPollIdByChat.set(remoteJid, createdPolls[0].pollId);
      if (persistPolls) persistPolls();
      for (const cp of createdPolls) {
        await flushPendingPollVotes(cp.pollId, sock, context);
      }

      if (hasPrebooked) {
        for (const pb of prebookedInfo) {
          if (pb.defaultPlayer && !ratings.isPlaceholder(pb.defaultPlayer)) {
            ratings.ensureRated([pb.defaultPlayer]).catch(() => {});
          }
        }
      } else if (!isAuto && creatorName && !ratings.isPlaceholder(creatorName) && !GENERIC_NAMES.has(ratings.keyFor(creatorName))) {
        const creatorLid = creatorJid ? namesStore.resolveCanonicalId(creatorJid) : null;
        ratings.ensureRated([{
          name: creatorName,
          jid: creatorJid,
          lid: creatorLid && creatorLid.endsWith('@lid') ? creatorLid : null
        }]).catch(() => {});
      }
    }

    const primaryPoll = createdPolls[0];
    const pollId = primaryPoll.pollId;
    pollTitle = primaryPoll.pollTitle;

    console.log(`[poll] Created ${isMultiPoll ? `multi-poll session ${sessionId} (${initialPollCount}/${batches.length} polls created upfront)` : `poll ${pollId}`} (${isOptIn ? 'Yes/No opt-in' : `${validCount} spots (given: ${size})`}, creator/virtual: ${leadingVirtualCount > 0 ? (creatorName || 'Player 1') : 'none'}) in ${remoteJid}${resolvedWhen ? ` (${resolvedWhen})` : ''}, play time ${playAt.toISOString()}`);

    return {
      pollId,
      title: titleOption || null,
      pollTitle,
      options: primaryPoll.partValues,
      values: primaryPoll.partValues,
      slotOverride: effectiveSlotOverride || undefined,
      err: null,
      isSimulation: Boolean(isSimulation),
      isOptIn,
      size: isOptIn ? null : validCount,
      slotCheck: effectiveSlotCheck,
      reminders: remindersOption !== null ? Boolean(remindersOption) : true,
      lineupGeneration: effectiveLineupGen,
      lineupLeadTime: effectiveLineupLeadTime,
      lineupLeadTimeDisplay: formatLookAround(effectiveLineupLeadTime),
      givenCount: size,
      votingSpotsCount: primaryPoll.partValues.length,
      startIdx: isOptIn ? 1 : startIdx,
      leadingVirtualCount: isOptIn ? 0 : leadingVirtualCount,
      when: resolvedWhen,
      includedCreator: shouldIncludeCreator,
      reason: excludedReason,
      replacedOldPoll,
      courtsStrategy: effectiveCourtsStrategy,
      checkCourts: Boolean(effectiveCheckCourts),
      courtBookingType: isPreBookOption ? 'pre-book' : 'none',
      preBookCourts: (preBookCourts !== undefined && preBookCourts !== null && parseInt(preBookCourts, 10) > 0) ? parseInt(preBookCourts, 10) : null,
      isMultiPoll,
      pollIds: allCreatedPollIds,
      totalParts: batches.length,
      batches,
      parentPollId: sessionId || null,
      advanceBookedCourts: finalAutoBookedCourts,
      autoBookedCourts: finalAutoBookedCourts,
      manuallyBookedCourts: finalManuallyBookedCourts,
      lookAround: effectiveLookAround,
      lookAroundDisplay: formatLookAround(effectiveLookAround),
      maxCourts: configuredMaxCourts || null,
      bookingCourtPreference: (effectiveCourtPreference && effectiveCourtPreference.length > 0) ? effectiveCourtPreference : null,
      prebookedCourts: finalPrebookedCourts,
      freeCourts: selectedFree || freeCourts,
      tentativeCourts: selectedTentative || tentativeCourts,
      totalCourtsCount: (selectedPrebooked?.length || 0) + (selectedFree?.length || 0) + (selectedTentative?.length || 0)
    };
  } finally {
    inFlightPollCreations.delete(flightKey);
  }
}

async function handleSimulatePoll(sock, chatId, sender, msg, parsed, opts = {}, context) {
  return await handleDirectPollCreation(sock, chatId, sender, msg, parsed, { ...opts, simulate: true, isSimulation: true }, context);
}

module.exports = {
  inFlightPollCreations,
  extractPollCreationPostTime,
  isPostTimeInFuture,
  parsePollCreationText,
  handleDirectPollCreation,
  formatSimulationPollSummary,
  createMultiTimePoll,
  createMatchPoll,
  handleSimulatePoll
};
