/**
 * Date, Day-of-Week, Post-Time, and Court-List Utilities for Recurring Polls
 */

const pollTime = require('../pollTime');
const { parseTimeString } = pollTime;

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const DAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const DAY_LOOKUP = {
  sun: 0, sunday: 0, sundays: 0,
  mon: 1, monday: 1, mondays: 1,
  tue: 2, tues: 2, tuesday: 2, tuesdays: 2,
  wed: 3, weds: 3, wednesday: 3, wednesdays: 3,
  thu: 4, thur: 4, thurs: 4, thursday: 4, thursdays: 4,
  fri: 5, friday: 5, fridays: 5,
  sat: 6, saturday: 6, saturdays: 6
};

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const MONTH_MAP = {
  jan: 0, january: 0,
  feb: 1, february: 1,
  mar: 2, march: 2,
  apr: 3, april: 3,
  may: 4,
  jun: 5, june: 5,
  jul: 6, july: 6,
  aug: 7, august: 7,
  sep: 8, sept: 8, september: 8,
  oct: 9, october: 9,
  nov: 10, november: 10,
  dec: 11, december: 11
};

/**
 * Sanitizes input text by removing zero-width characters and normalizing Unicode whitespace.
 */
function cleanIncomingText(text) {
  if (!text || typeof text !== 'string') return '';
  return text
    .replace(/[\u200b-\u200d\u2060\ufeff]/g, '')
    .replace(/[\u00a0\u202f\u2000-\u200a]/g, ' ')
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/[\u2018\u2019]/g, "'")
    .trim();
}

/**
 * Normalizes user input for court names (e.g. "3", "Court 3", "3, 5", "court 3, court 5").
 * Returns an array of formatted court strings (e.g. ['Court 3', 'Court 5']).
 */
function normalizeCourtList(input) {
  if (!input) return [];
  if (Array.isArray(input)) {
    return [...new Set(input.flatMap(normalizeCourtList))];
  }
  const str = String(input).trim();
  if (/^(?:all|reset|clear|none)$/i.test(str)) {
    return ['all'];
  }
  const rawTokens = str.split(/[,;]+/).map((s) => s.trim()).filter(Boolean);
  const results = [];
  for (const token of rawTokens) {
    const numMatch = token.match(/^(?:court\s*#?\s*)?(\d+)$/i);
    if (numMatch) {
      results.push(`Court ${numMatch[1]}`);
    } else if (/^court\b/i.test(token)) {
      results.push(token);
    } else {
      results.push(token);
    }
  }
  return [...new Set(results)];
}

/**
 * Checks whether a court name matches any skipped court in a given list.
 */
function isCourtSkipped(courtName, skippedCourts) {
  if (!courtName || !skippedCourts) return false;
  const list = Array.isArray(skippedCourts) ? skippedCourts : [skippedCourts];
  if (list.length === 0) return false;
  const clean = String(courtName).trim().toLowerCase();
  const cNumMatch = clean.match(/\b\d+\b/);
  return list.some((s) => {
    if (!s) return false;
    const sClean = String(s).trim().toLowerCase();
    if (clean === sClean || clean.includes(sClean) || sClean.includes(clean)) return true;
    const sNumMatch = sClean.match(/\b\d+\b/);
    if (cNumMatch && sNumMatch && cNumMatch[0] === sNumMatch[0]) return true;
    return false;
  });
}

function formatDaysResult(sortedDays, explicitDisplay = null) {
  if (sortedDays.length === 7) {
    return { days: sortedDays, display: 'Every day', raw: 'everyday' };
  }
  if (sortedDays.length === 5 && [1, 2, 3, 4, 5].every((d) => sortedDays.includes(d))) {
    return { days: sortedDays, display: 'Weekdays (Mon–Fri)', raw: 'weekdays' };
  }
  if (sortedDays.length === 4 && [1, 2, 3, 4].every((d) => sortedDays.includes(d))) {
    return { days: sortedDays, display: 'Mon–Thu (Mon, Tue, Wed, Thu)', raw: 'mon-thu' };
  }
  if (sortedDays.length === 2 && [0, 6].every((d) => sortedDays.includes(d))) {
    return { days: sortedDays, display: 'Weekends (Sat, Sun)', raw: 'weekends' };
  }

  // If consecutive range of 3 or more days, show range label with expanded days
  const isConsecutive = sortedDays.length >= 3 && sortedDays.every((val, idx) => idx === 0 || val === sortedDays[idx - 1] + 1);
  let defaultDisplay = sortedDays.map((d) => DAY_SHORT[d]).join(', ');
  if (isConsecutive && sortedDays.length < 5) {
    defaultDisplay = `${DAY_SHORT[sortedDays[0]]}–${DAY_SHORT[sortedDays[sortedDays.length - 1]]} (${defaultDisplay})`;
  }

  const display = explicitDisplay || defaultDisplay;
  const raw = sortedDays.map((d) => DAY_SHORT[d].toLowerCase()).join(',');
  return { days: sortedDays, display, raw };
}

/**
 * Parses days of the week from a string (e.g. "weekdays", "mon,wed,fri", "tuesdays and thursdays", "sat-sun", "everyday")
 * or array of numbers/strings into a normalized list of day indices (0=Sun .. 6=Sat) and human display text.
 */
function parseDaysOfWeek(input) {
  if (!input) return { days: [0, 1, 2, 3, 4, 5, 6], display: 'Every day', raw: 'everyday' };

  if (Array.isArray(input)) {
    const dayIndices = new Set();
    for (const item of input) {
      if (typeof item === 'number' && item >= 0 && item <= 6) {
        dayIndices.add(item);
      } else if (typeof item === 'string') {
        const sub = parseDaysOfWeek(item);
        for (const d of sub.days) dayIndices.add(d);
      }
    }
    if (dayIndices.size === 0) return { days: [0, 1, 2, 3, 4, 5, 6], display: 'Every day', raw: 'everyday' };
    const sorted = [...dayIndices].sort((a, b) => a - b);
    return formatDaysResult(sorted);
  }

  const str = String(input).toLowerCase().trim();
  if (!str || /^(?:everyday|every\s*day|daily|all|any)$/i.test(str)) {
    return { days: [0, 1, 2, 3, 4, 5, 6], display: 'Every day', raw: 'everyday' };
  }

  if (/\b(?:weekdays?|mon(?:day)?\s*(?:-|to|through)\s*fri(?:day)?)\b/i.test(str)) {
    return formatDaysResult([1, 2, 3, 4, 5], 'Weekdays (Mon–Fri)');
  }

  if (/\b(?:weekends?|sat(?:urday)?\s*(?:&|and)?\s*sun(?:day)?)\b/i.test(str)) {
    return formatDaysResult([0, 6], 'Weekends (Sat, Sun)');
  }

  const dayIndices = new Set();

  // Check for day ranges (e.g. mon-thu, monday-thursday, mon to thu, mon through thu, mon thru thu, fri-sun)
  const rangeRegex = /(?:\bfrom\s+)?\b(sun(?:day|days)?|mon(?:day|days)?|tue(?:s|sday|sdays)?|wed(?:nesday|nesdays)?|thu(?:r|rs|rsday|rsdays)?|fri(?:day|days)?|sat(?:urday|urdays)?)\s*(?:-|to|through|thru|until|till)\s*(sun(?:day|days)?|mon(?:day|days)?|tue(?:s|sday|sdays)?|wed(?:nesday|nesdays)?|thu(?:r|rs|rsday|rsdays)?|fri(?:day|days)?|sat(?:urday|urdays)?)\b/gi;
  let rMatch;
  while ((rMatch = rangeRegex.exec(str)) !== null) {
    const startIdx = DAY_LOOKUP[rMatch[1].toLowerCase()];
    const endIdx = DAY_LOOKUP[rMatch[2].toLowerCase()];
    if (startIdx !== undefined && endIdx !== undefined) {
      if (startIdx <= endIdx) {
        for (let i = startIdx; i <= endIdx; i++) dayIndices.add(i);
      } else {
        for (let i = startIdx; i <= 6; i++) dayIndices.add(i);
        for (let i = 0; i <= endIdx; i++) dayIndices.add(i);
      }
    }
  }

  // Check individual day words
  const singleRegex = /\b(sundays?|sun|mondays?|mon|tuesdays?|tues|tue|wednesdays?|weds|wed|thursdays?|thurs|thur|thu|fridays?|fri|saturdays?|sat)\b/gi;
  let sMatch;
  while ((sMatch = singleRegex.exec(str)) !== null) {
    const dIdx = DAY_LOOKUP[sMatch[1].toLowerCase()];
    if (dIdx !== undefined) dayIndices.add(dIdx);
  }

  if (dayIndices.size === 0) {
    return { days: [0, 1, 2, 3, 4, 5, 6], display: 'Every day', raw: 'everyday' };
  }

  const sorted = [...dayIndices].sort((a, b) => a - b);
  return formatDaysResult(sorted);
}

/**
 * Extracts days of the week phrases from user text.
 */
function extractDaysFromText(text) {
  if (!text) return null;
  const lower = cleanIncomingText(text).toLowerCase();

  if (/\b(?:weekdays?|mon(?:day)?\s*(?:-|to|through)\s*fri(?:day)?)\b/i.test(lower)) {
    return 'weekdays';
  }
  if (/\b(?:weekends?|sat(?:urday)?\s*(?:&|and)?\s*sun(?:day)?)\b/i.test(lower)) {
    return 'weekends';
  }
  if (/\b(?:everyday|every\s+day|daily)\b/i.test(lower)) {
    return 'everyday';
  }

  const dayTokens = [];
  let textForExtract = lower;
  const rangeRegex = /(?:\b(?:on|every|from)\s+)?\b(sun(?:days?)?|mon(?:days?)?|tue(?:s(?:days?)?)?|wed(?:nesdays?)?|thu(?:r(?:s(?:days?)?)?)?|fri(?:days?)?|sat(?:urdays?)?)\s*(?:-|to|through|thru|until|till)\s*(sun(?:days?)?|mon(?:days?)?|tue(?:s(?:days?)?)?|wed(?:nesdays?)?|thu(?:r(?:s(?:days?)?)?)?|fri(?:days?)?|sat(?:urdays?)?)\b/gi;
  let rMatch;
  while ((rMatch = rangeRegex.exec(textForExtract)) !== null) {
    dayTokens.push(`${rMatch[1]}-${rMatch[2]}`);
  }
  textForExtract = textForExtract.replace(rangeRegex, ' ');

  const singleRegex = /\b(?:on\s+|every\s+)?(sundays?|sun|mondays?|mon|tuesdays?|tues|tue|wednesdays?|weds|wed|thursdays?|thurs|thur|thu|fridays?|fri|saturdays?|sat)\b/gi;
  let sMatch;
  while ((sMatch = singleRegex.exec(textForExtract)) !== null) {
    dayTokens.push(sMatch[1]);
  }

  if (dayTokens.length > 0) {
    return dayTokens.join(',');
  }

  return null;
}

/**
 * Parses a single post time configuration string (e.g. "Sunday 6pm", "1 day before at 6pm", "8am", "25 hours before")
 * for a specific match day of week (0..6) and match time.
 */
function parseSinglePostConfig(str, matchDayIndex, matchTimeObj) {
  if (!str) return null;
  const s = String(str).trim();
  const matchMinutes = matchTimeObj ? (matchTimeObj.hour * 60 + matchTimeObj.minute) : (8 * 60);

  // Check for relative "X days before" or "day before" or "previous day"
  const daysBeforeMatch = s.match(/\b(\d+)\s*days?\s*before\b/i) ||
    (s.match(/\b(?:the\s+)?(?:day|evening|night)\s*before\b/i) ? [null, '1'] : null) ||
    (s.match(/\bprevious\s*day\b/i) ? [null, '1'] : null);

  // Check for "X hours before"
  const hoursBeforeMatch = s.match(/\b(\d+(?:\.\d+)?)\s*(?:hours?|hrs?|h)\s*(?:before|prior|in\s+advance)\b/i);

  // Extract time of day
  const timeMatch = s.match(/\b(\d{1,2}(?::\d{2})?\s*(?:am|pm))\b|\b(\d{1,2}:\d{2})\b/i);
  let parsedTime = null;
  if (timeMatch) {
    parsedTime = parseTimeString(timeMatch[1] || timeMatch[2]);
  }

  let explicitPostDay = null;
  const forMatch = s.match(/\b(sun[a-z]*|mon[a-z]*|tue[a-z]*|wed[a-z]*|thu[a-z]*|fri[a-z]*|sat[a-z]*)\s+(?:at\s+)?(\d{1,2}(?::\d{2})?\s*(?:am|pm)?|\d{1,2}:\d{2})\s+for\s+(sun[a-z]*|mon[a-z]*|tue[a-z]*|wed[a-z]*|thu[a-z]*|fri[a-z]*|sat[a-z]*)\b/i) ||
    s.match(/(?:at\s+)?(\d{1,2}(?::\d{2})?\s*(?:am|pm)?|\d{1,2}:\d{2})\s+(sun[a-z]*|mon[a-z]*|tue[a-z]*|wed[a-z]*|thu[a-z]*|fri[a-z]*|sat[a-z]*)\s+for\s+(sun[a-z]*|mon[a-z]*|tue[a-z]*|wed[a-z]*|thu[a-z]*|fri[a-z]*|sat[a-z]*)\b/i);

  if (forMatch) {
    const postDayWord = forMatch[1].match(/^[a-z]+$/i) ? forMatch[1] : forMatch[2];
    explicitPostDay = DAY_LOOKUP[postDayWord.toLowerCase()];
  } else {
    const dayMatches = [...s.matchAll(/\b(sun(?:day|days)?|mon(?:day|days)?|tue(?:s|sday|sdays)?|wed(?:nesday|nesdays)?|thu(?:r|rs|rsday|rsdays)?|fri(?:day|days)?|sat(?:urday|urdays)?)\b/gi)];
    if (dayMatches.length > 0) {
      for (const dm of dayMatches) {
        const d = DAY_LOOKUP[dm[1].toLowerCase()];
        if (d !== undefined) {
          explicitPostDay = d;
          break;
        }
      }
    }
  }

  if (hoursBeforeMatch) {
    const hours = parseFloat(hoursBeforeMatch[1]);
    const totalMinutesBefore = Math.round(hours * 60);
    const matchMins = matchTimeObj ? (matchTimeObj.hour * 60 + matchTimeObj.minute) : (19 * 60);
    let postMinsTotal = matchMins - totalMinutesBefore;
    let daysBefore = 0;
    while (postMinsTotal < 0) {
      postMinsTotal += 24 * 60;
      daysBefore++;
    }
    const pHour = Math.floor(postMinsTotal / 60) % 24;
    const pMinute = postMinsTotal % 60;
    const period = pHour >= 12 ? 'PM' : 'AM';
    const dHour = pHour % 12 === 0 ? 12 : pHour % 12;
    const dMinute = pMinute > 0 ? `:${String(pMinute).padStart(2, '0')}` : '';
    parsedTime = {
      hour: pHour,
      minute: pMinute,
      formatted: `${dHour}${dMinute}${period.toLowerCase()}`,
      display: `${dHour}${dMinute} ${period}`
    };
    const postDayIndex = matchDayIndex !== null && matchDayIndex !== undefined ? ((matchDayIndex - daysBefore + 7) % 7) : 0;
    return {
      hour: parsedTime.hour,
      minute: parsedTime.minute,
      postHour: parsedTime.hour,
      postMinute: parsedTime.minute,
      formatted: parsedTime.formatted,
      display: parsedTime.display,
      daysBefore,
      postDayIndex,
      postDayName: DAY_SHORT[postDayIndex]
    };
  }

  if (!parsedTime) {
    parsedTime = parseTimeString('8am');
  }

  const postMinutes = parsedTime.hour * 60 + parsedTime.minute;
  let daysBefore = 0;

  if (daysBeforeMatch) {
    daysBefore = parseInt(daysBeforeMatch[1], 10);
  } else if (explicitPostDay !== null && explicitPostDay !== undefined && matchDayIndex !== null && matchDayIndex !== undefined) {
    daysBefore = (matchDayIndex - explicitPostDay + 7) % 7;
  } else {
    daysBefore = postMinutes >= matchMinutes ? 1 : 0;
  }

  const postDayIndex = matchDayIndex !== null && matchDayIndex !== undefined ? ((matchDayIndex - daysBefore + 7) % 7) : 0;

  return {
    hour: parsedTime.hour,
    minute: parsedTime.minute,
    postHour: parsedTime.hour,
    postMinute: parsedTime.minute,
    formatted: parsedTime.formatted,
    display: parsedTime.display,
    daysBefore,
    postDayIndex,
    postDayName: DAY_SHORT[postDayIndex]
  };
}

/**
 * Parses post time input (string, day-of-week mapped string, advance posting string, or object).
 */
function parsePostTimes(input, defaultMatchTime = null, scheduledDays = null) {
  const matchTimeObj = typeof defaultMatchTime === 'object' ? defaultMatchTime : parseTimeString(defaultMatchTime);
  const effectiveDays = Array.isArray(scheduledDays) && scheduledDays.length > 0 ? scheduledDays : [0, 1, 2, 3, 4, 5, 6];

  const postTimesByDay = {};
  let defaultPost = null;

  if (!input) {
    const fallback = matchTimeObj && matchTimeObj.hour < 8 ? '7pm' : '8am';
    defaultPost = parseSinglePostConfig(fallback, effectiveDays[0], matchTimeObj);
    for (const d of effectiveDays) {
      postTimesByDay[d] = parseSinglePostConfig(fallback, d, matchTimeObj);
    }
  } else if (typeof input === 'object' && !Array.isArray(input)) {
    for (const [key, val] of Object.entries(input)) {
      if (!val) continue;
      const targetMatchDays = parseDaysOfWeek(key).days;
      for (const matchDay of targetMatchDays) {
        const postCfg = typeof val === 'object'
          ? parseSinglePostConfig(val.postTime || val.time || `${val.postDay || ''} ${val.time || ''}` || `${val.daysBefore || ''} days before at ${val.time || '8am'}`, matchDay, matchTimeObj)
          : parseSinglePostConfig(String(val), matchDay, matchTimeObj);
        if (postCfg) {
          postTimesByDay[matchDay] = postCfg;
          if (!defaultPost) defaultPost = postCfg;
        }
      }
    }
  } else if (typeof input === 'string') {
    const raw = input.trim();
    const clauses = raw.split(/[,;]|\band\b/i);
    let parsedAnyClause = false;

    if (clauses.length > 1) {
      for (const clause of clauses) {
        const c = clause.trim();
        if (!c) continue;
        const targetDays = parseDaysOfWeek(c).days;
        const daysToApply = (targetDays.length > 0 && parseDaysOfWeek(c).raw !== 'everyday') ? targetDays : effectiveDays;
        for (const d of daysToApply) {
          const cfg = parseSinglePostConfig(c, d, matchTimeObj);
          if (cfg) {
            postTimesByDay[d] = cfg;
            if (!defaultPost) defaultPost = cfg;
            parsedAnyClause = true;
          }
        }
      }
    }

    if (!parsedAnyClause) {
      for (const d of effectiveDays) {
        const cfg = parseSinglePostConfig(raw, d, matchTimeObj);
        if (cfg) {
          postTimesByDay[d] = cfg;
          if (!defaultPost) defaultPost = cfg;
        }
      }
    }
  }

  if (!defaultPost) {
    defaultPost = parseSinglePostConfig('8am', effectiveDays[0], matchTimeObj);
  }
  for (const d of effectiveDays) {
    if (!postTimesByDay[d]) {
      postTimesByDay[d] = parseSinglePostConfig(defaultPost.formatted, d, matchTimeObj);
    }
  }

  const groups = {};
  for (const d of effectiveDays) {
    const cfg = postTimesByDay[d];
    const key = `${cfg.formatted}|${cfg.daysBefore}`;
    if (!groups[key]) groups[key] = { cfg, matchDays: [] };
    groups[key].matchDays.push(d);
  }

  const groupKeys = Object.keys(groups);
  let display = '';
  if (groupKeys.length === 1) {
    const g = groups[groupKeys[0]];
    const beforeStr = g.cfg.daysBefore > 1
      ? ` (${g.cfg.daysBefore} days before)`
      : (g.cfg.daysBefore === 1 ? ' (1 day before)' : '');
    if (effectiveDays.length === 1) {
      display = `${g.cfg.postDayName} ${g.cfg.display}${beforeStr}`;
    } else {
      display = `${g.cfg.display}${beforeStr}`;
    }
  } else {
    const parts = groupKeys.map((k) => {
      const g = groups[k];
      const matchDaysLabel = parseDaysOfWeek(g.matchDays).display;
      const beforeStr = g.cfg.daysBefore > 1
        ? ` (${g.cfg.daysBefore} days before)`
        : (g.cfg.daysBefore === 1 ? ' (1 day before)' : '');
      const dayPrefix = g.matchDays.length === 1 && g.cfg.postDayName ? `${g.cfg.postDayName} ` : '';
      return `${dayPrefix}${g.cfg.display}${beforeStr} for ${matchDaysLabel}`;
    });
    display = parts.join(', ');
  }

  return { defaultPost, postTimesByDay, display };
}

function getPostTimeForSchedule(sched, matchDayIndex) {
  if (sched.postTimesByDay) {
    if (sched.postTimesByDay[matchDayIndex]) return sched.postTimesByDay[matchDayIndex];
    if (sched.postTimesByDay[String(matchDayIndex)]) return sched.postTimesByDay[String(matchDayIndex)];
  }
  let postHour = sched.postHour;
  let postMinute = sched.postMinute;
  if (postHour === undefined && sched.postTime) {
    const pt = parseTimeString(sched.postTime);
    if (pt) {
      postHour = pt.hour;
      postMinute = pt.minute;
    }
  }
  postHour = postHour !== undefined ? postHour : 8;
  postMinute = postMinute !== undefined ? postMinute : 0;
  const matchMinutes = (sched.matchHour || 19) * 60 + (sched.matchMinute || 0);
  const postMinutes = postHour * 60 + postMinute;
  const daysBefore = sched.postDaysBefore !== undefined ? sched.postDaysBefore : (postMinutes >= matchMinutes ? 1 : 0);
  const postDayIndex = (matchDayIndex - daysBefore + 7) % 7;
  return {
    formatted: sched.postTime || '8am',
    display: sched.postDisplay || sched.postTime || '8 AM',
    hour: postHour,
    minute: postMinute,
    postHour,
    postMinute,
    daysBefore,
    postDayIndex,
    postDayName: DAY_SHORT[postDayIndex]
  };
}

/**
 * Parses a date or day string into a normalized dateKey ("YYYY-MM-DD") and display string in San Jose timezone.
 * Supports: YYYY-MM-DD, MM/DD/YYYY, MM/DD, "Oct 25", "October 25th", "25th Oct", "tomorrow", "today", weekdays ("Monday", "next Wednesday").
 */
function parseDateToDateKey(rawStr, customSanJoseParts = null) {
  if (!rawStr || typeof rawStr !== 'string') return null;
  const str = rawStr.toLowerCase()
    .replace(/^!(?:pauserecurringpoll|pauserecurring|pausepoll|pause)\s*/i, '')
    .replace(/\b(?:until|till|through|thru|to|after)\b/gi, '')
    .replace(/(\d+)(?:st|nd|rd|th)\b/gi, '$1')
    .replace(/\s+/g, ' ')
    .trim();
  if (!str) return null;

  const sj = customSanJoseParts || pollTime.getSanJoseParts();
  let year = sj.year;
  let month = null;
  let day = null;

  // 1. YYYY-MM-DD
  const mIso = str.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (mIso) {
    year = parseInt(mIso[1], 10);
    month = parseInt(mIso[2], 10) - 1;
    day = parseInt(mIso[3], 10);
  }

  // 2. MM/DD/YYYY or MM/DD
  if (month === null) {
    const mSlash = str.match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?$/);
    if (mSlash) {
      month = parseInt(mSlash[1], 10) - 1;
      day = parseInt(mSlash[2], 10);
      if (mSlash[3]) {
        year = parseInt(mSlash[3], 10);
        if (year < 100) year += 2000;
      } else {
        year = sj.year;
        if (month < sj.month || (month === sj.month && day < sj.day)) {
          year += 1;
        }
      }
    }
  }

  // 3. Month Day (e.g. "oct 25", "october 25 2026")
  if (month === null) {
    const mMonthDay = str.match(/^([a-z]+)\s+(\d{1,2})(?:[,\s]+(\d{4}))?$/);
    if (mMonthDay && MONTH_MAP[mMonthDay[1]] !== undefined) {
      month = MONTH_MAP[mMonthDay[1]];
      day = parseInt(mMonthDay[2], 10);
      year = mMonthDay[3] ? parseInt(mMonthDay[3], 10) : sj.year;
      if (!mMonthDay[3] && (month < sj.month || (month === sj.month && day < sj.day))) {
        year += 1;
      }
    }
  }

  // 4. Day Month (e.g. "25 oct", "25 october 2026")
  if (month === null) {
    const mDayMonth = str.match(/^(\d{1,2})\s+([a-z]+)(?:[,\s]+(\d{4}))?$/);
    if (mDayMonth && MONTH_MAP[mDayMonth[2]] !== undefined) {
      day = parseInt(mDayMonth[1], 10);
      month = MONTH_MAP[mDayMonth[2]];
      year = mDayMonth[3] ? parseInt(mDayMonth[3], 10) : sj.year;
      if (!mDayMonth[3] && (month < sj.month || (month === sj.month && day < sj.day))) {
        year += 1;
      }
    }
  }

  // 5. tomorrow
  if (month === null && str === 'tomorrow') {
    const d = new Date(Date.UTC(sj.year, sj.month, sj.day + 1));
    year = d.getUTCFullYear();
    month = d.getUTCMonth();
    day = d.getUTCDate();
  }

  // 6. today
  if (month === null && str === 'today') {
    year = sj.year;
    month = sj.month;
    day = sj.day;
  }

  // 7. Weekdays (e.g. "monday", "next wednesday")
  if (month === null) {
    const mDay = str.match(/^(?:next\s+)?(sun(?:day)?|mon(?:day)?|tue(?:sday)?|wed(?:nesday)?|thu(?:rsday)?|fri(?:day)?|sat(?:urday)?)$/);
    if (mDay) {
      const targetDow = DAY_LOOKUP[mDay[1].slice(0, 3)];
      const currentDow = new Date(Date.UTC(sj.year, sj.month, sj.day)).getUTCDay();
      let diff = targetDow - currentDow;
      if (diff <= 0) diff += 7;
      if (/^next\s+/.test(str) && diff < 7) diff += 7;
      const d = new Date(Date.UTC(sj.year, sj.month, sj.day + diff));
      year = d.getUTCFullYear();
      month = d.getUTCMonth();
      day = d.getUTCDate();
    }
  }

  if (month === null || day === null) return null;

  const dateObj = new Date(Date.UTC(year, month, day));
  const finalYear = dateObj.getUTCFullYear();
  const finalMonth = dateObj.getUTCMonth();
  const finalDay = dateObj.getUTCDate();
  const dateKey = `${finalYear}-${String(finalMonth + 1).padStart(2, '0')}-${String(finalDay).padStart(2, '0')}`;
  const dayName = DAY_NAMES[dateObj.getUTCDay()];
  const monthName = MONTH_NAMES[finalMonth];
  const display = `${dayName}, ${monthName} ${finalDay}, ${finalYear}`;
  const todayKey = `${sj.year}-${String(sj.month + 1).padStart(2, '0')}-${String(sj.day).padStart(2, '0')}`;
  const isPast = dateKey < todayKey;

  return { dateKey, display, dateObj, year: finalYear, month: finalMonth, day: finalDay, isPast };
}

/**
 * Returns an array of the next upcoming instance dates for a recurring schedule.
 * Scans up to 90 days ahead and skips dates already in sched.skippedMatchDates.
 */
function getUpcomingInstanceDates(sched, customSanJoseParts = null, count = 1, filterTarget = null) {
  const sj = customSanJoseParts || pollTime.getSanJoseParts();
  const currentMinutes = sj.hour * 60 + sj.minute;
  const schedMatchMinutes = (sched.matchHour !== undefined ? sched.matchHour : 19) * 60 + (sched.matchMinute || 0);

  const schedDays = (Array.isArray(sched.daysList) && sched.daysList.length > 0)
    ? [...new Set(sched.daysList)]
    : [...new Set(parseDaysOfWeek(sched.days).days)];

  let filterDayIndex = null;
  let filterDateKey = null;

  if (filterTarget && typeof filterTarget === 'string') {
    const clean = filterTarget.trim().toLowerCase();
    if (DAY_LOOKUP[clean] !== undefined) {
      filterDayIndex = DAY_LOOKUP[clean];
    } else if (/^\d{4}-\d{2}-\d{2}$/.test(clean)) {
      filterDateKey = clean;
    } else if (clean === 'today') {
      const todayObj = new Date(Date.UTC(sj.year, sj.month, sj.day));
      filterDateKey = `${todayObj.getUTCFullYear()}-${String(todayObj.getUTCMonth() + 1).padStart(2, '0')}-${String(todayObj.getUTCDate()).padStart(2, '0')}`;
    } else if (clean === 'tomorrow') {
      const tomObj = new Date(Date.UTC(sj.year, sj.month, sj.day + 1));
      filterDateKey = `${tomObj.getUTCFullYear()}-${String(tomObj.getUTCMonth() + 1).padStart(2, '0')}-${String(tomObj.getUTCDate()).padStart(2, '0')}`;
    } else {
      const slashM = clean.match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?$/);
      if (slashM) {
        const m = parseInt(slashM[1], 10);
        const d = parseInt(slashM[2], 10);
        let y = slashM[3] ? parseInt(slashM[3], 10) : sj.year;
        if (y < 100) y += 2000;
        filterDateKey = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
      }
    }
  }

  const skippedList = Array.isArray(sched.skippedMatchDates) ? sched.skippedMatchDates : [];
  const results = [];
  const targetCount = Math.max(1, count || 1);

  for (let offset = 0; offset <= 90; offset++) {
    const candidateDate = new Date(Date.UTC(sj.year, sj.month, sj.day + offset));
    const dayIndex = candidateDate.getUTCDay();
    const year = candidateDate.getUTCFullYear();
    const month = candidateDate.getUTCMonth();
    const day = candidateDate.getUTCDate();
    const dateKey = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;

    if (!schedDays.includes(dayIndex)) continue;
    if (offset === 0 && currentMinutes >= schedMatchMinutes) continue;

    if (filterDayIndex !== null && dayIndex !== filterDayIndex) continue;
    if (filterDateKey !== null && dateKey !== filterDateKey) continue;

    if (sched.startDate && dateKey < sched.startDate) continue;
    if (sched.endDate && dateKey > sched.endDate) break;

    if (filterDayIndex === null && filterDateKey === null && skippedList.includes(dateKey)) {
      continue;
    }

    const dayName = DAY_NAMES[dayIndex];
    const monthName = MONTH_NAMES[month];
    const display = `${dayName}, ${monthName} ${day} (${dateKey}) at ${sched.matchDisplay || sched.matchTime}`;

    results.push({ dateKey, dayIndex, dayName, display, dateObj: candidateDate, offset });

    if (results.length >= targetCount) {
      break;
    }
  }

  return results;
}

/**
 * Resolves the upcoming match date and display info for an instance of a recurring schedule.
 */
function getNextInstanceDate(sched, customSanJoseParts = null, targetDayOrDate = null) {
  const list = getUpcomingInstanceDates(sched, customSanJoseParts, 1, targetDayOrDate);
  return list.length > 0 ? list[0] : null;
}

module.exports = {
  DAY_NAMES,
  DAY_SHORT,
  DAY_LOOKUP,
  MONTH_NAMES,
  MONTH_MAP,
  cleanIncomingText,
  normalizeCourtList,
  isCourtSkipped,
  formatDaysResult,
  parseDaysOfWeek,
  extractDaysFromText,
  parseSinglePostConfig,
  parsePostTimes,
  getPostTimeForSchedule,
  parseDateToDateKey,
  getUpcomingInstanceDates,
  getNextInstanceDate
};
