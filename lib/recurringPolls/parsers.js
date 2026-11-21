/**
 * Command, Flag, and Natural-Language Parsers for Recurring Polls
 */

const pollTime = require('../pollTime');
const groupsConfig = require('../groupsConfig');
const { normalizeCommandDashes } = require('../textNormalize');
const { WORD_TO_NUMBER, NUMBER_WORDS_PATTERN, parseLookAround } = pollTime;
const {
  DAY_LOOKUP,
  cleanIncomingText,
  normalizePollTitle,
  normalizeCourtList,
  parseDaysOfWeek,
  extractDaysFromText,
  parseDateToDateKey
} = require('./dates');

/**
 * Extracts a JSON object or bracketed key-value map from user command text.
 * Returns the parsed map object and the text with the map removed.
 */
function extractJsonMap(text) {
  if (!text || typeof text !== 'string') return { map: null, remainingText: text };
  const match = text.match(/\{[\s\S]*?\}/);
  if (!match) return { map: null, remainingText: text };

  const rawJson = match[0];
  let parsedMap = null;
  try {
    parsedMap = JSON.parse(rawJson);
  } catch (err) {
    const inner = rawJson.slice(1, -1);
    const map = {};
    const kvRegex = /(?:["']?([a-zA-Z0-9_\-\s]+)["']?)\s*[:=]\s*(?:["']([^"']+)["']|([^,{}]+))/g;
    let m;
    while ((m = kvRegex.exec(inner)) !== null) {
      const key = m[1].trim();
      const val = (m[2] !== undefined ? m[2] : m[3]).trim();
      if (key && val) map[key] = val;
    }
    if (Object.keys(map).length > 0) {
      parsedMap = map;
    }
  }

  if (parsedMap && Object.keys(parsedMap).length > 0) {
    let remainingText = text.replace(rawJson, ' ');
    remainingText = remainingText.replace(/\b(?:post(?:ed)?|posting|at)\s*$/i, ' ');
    remainingText = remainingText.replace(/\s{2,}/g, ' ').trim();
    return { map: parsedMap, remainingText, rawJson };
  }
  return { map: null, remainingText: text };
}

/**
 * Extracts and strips command-line flags and key-value options from command text
 * so they don't interfere with positional size, matchTime, and day parsing.
 */
function extractCommonFlags(text, jsonMap = null) {
  let rem = text ? normalizeCommandDashes(String(text)) : '';
  const flags = {};

  // 0. group flag (--group="...", --group=..., -g ...)
  if (jsonMap) {
    const gVal = jsonMap['group'] ?? jsonMap['--group'] ?? jsonMap['targetGroup'] ?? jsonMap['groupName'];
    if (gVal !== undefined) flags.group = String(gVal).trim().replace(/^["']|["']$/g, '');
  }
  const groupFlagRegex = /(?:--(?:group|grp)\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s]+))|--(?:group|grp)\s+(?:"([^"]+)"|'([^']+)'|([^\s]+))|-(?:g)\s+(?:"([^"]+)"|'([^']+)'|([^\s]+)))/i;
  const groupFlagMatch = rem.match(groupFlagRegex);
  if (groupFlagMatch) {
    if (flags.group === undefined) {
      flags.group = (groupFlagMatch[1] || groupFlagMatch[2] || groupFlagMatch[3] || groupFlagMatch[4] || groupFlagMatch[5] || groupFlagMatch[6] || groupFlagMatch[7] || groupFlagMatch[8] || groupFlagMatch[9] || '').trim();
    }
    rem = rem.replace(groupFlagMatch[0], ' ');
  }

  // 0b. title flag (--title="...", title="...", titled "...", --no-title, --title=none)
  if (jsonMap) {
    const tKey = ['title', 'pollTitle', 'poll-title', 'poll_title', '--title', '--poll-title', 'customTitle'].find((k) => jsonMap[k] !== undefined);
    if (tKey !== undefined) {
      flags.title = normalizePollTitle(jsonMap[tKey]);
    }
  }
  const clearTitleRegex = /(?:^|\s)--(?:no-?title|clear-?title|remove-?title|reset-?title)(?![-\w])|(?:^|\s)--(?:poll-?)?title(?:\s*=\s*|\s+)(?:none|clear|remove|null|default)(?![-\w])|(?<![-\w])\b(?:poll\s+)?title\s*[:=]\s*(?:none|clear|remove|null|default)\b/i;
  if (clearTitleRegex.test(rem)) {
    if (flags.title === undefined) flags.title = null;
    rem = rem.replace(new RegExp(clearTitleRegex.source, 'gi'), ' ');
  }
  const titleFlagRegex = /(?:^|\s)--(?:poll-?)?title(?:\s*=\s*|\s+)(?:"([^"]*)"|\u201c([^\u201d]*)\u201d|'([^']*)'|\u2018([^\u2019]*)\u2019|([^\s]+))|(?<![-\w])\b(?:poll\s+)?title\s*[:=]\s*(?:"([^"]*)"|\u201c([^\u201d]*)\u201d|'([^']*)'|\u2018([^\u2019]*)\u2019|([^\s]+))|(?<![-\w])\b(?:with\s+(?:the\s+)?title|titled|called|named)\s+(?:"([^"]+)"|\u201c([^\u201d]+)\u201d|'([^']+)'|\u2018([^\u2019]+)\u2019)/i;
  const titleMatch = rem.match(titleFlagRegex);
  if (titleMatch) {
    if (flags.title === undefined) {
      const captured = titleMatch.slice(1).find((v) => v !== undefined);
      flags.title = normalizePollTitle(captured ?? '');
    }
    rem = rem.replace(titleMatch[0], ' ');
  }

  // 1. bookingStrategy
  if (jsonMap) {
    const val = jsonMap['booking-strategy'] ?? jsonMap['bookingStrategy'];
    if (val !== undefined) flags.bookingStrategy = String(val).toLowerCase().trim();
  }
  const bsRegex = /(?:^|\s)--(?:booking-?strategy)=([a-z-]+)|(?<![-\w])\b(?:booking\s*strategy)\s*[:=]\s*([a-z-]+)/i;
  const bsMatch = rem.match(bsRegex);
  if (bsMatch) {
    if (flags.bookingStrategy === undefined) flags.bookingStrategy = (bsMatch[1] || bsMatch[2]).toLowerCase().trim();
    rem = rem.replace(bsMatch[0], ' ');
  }

  // 2. bookingSchedule
  if (jsonMap) {
    const val = jsonMap['booking-schedule'] ?? jsonMap['bookingSchedule'] ?? jsonMap['schedule'];
    if (val !== undefined) flags.bookingSchedule = val;
  }
  const bSchedRegex = /(?:--(?:booking-?schedule|bookingSchedule)\s*=?\s*(?:"([^"]+)"|'([^']+)'|([^\s]+))|\bbooking\s*schedule\s*[:=]\s*(?:"([^"]+)"|'([^']+)'|(-?\d+\s*[a-z0-9:]+(?:\s*[a-z0-9:]+)?)))/i;
  const bSchedMatch = rem.match(bSchedRegex);
  if (bSchedMatch) {
    if (flags.bookingSchedule === undefined) flags.bookingSchedule = (bSchedMatch[1] || bSchedMatch[2] || bSchedMatch[3] || bSchedMatch[4] || bSchedMatch[5] || bSchedMatch[6]).trim();
    rem = rem.replace(bSchedMatch[0], ' ');
  }

  // 3. preBookCourts (parsed before courtBookingType so --pre-book-courts is not partially matched by --pre-book)
  const pbCourtsMatch = rem.match(/(?:--(?:pre-?book-?courts?|courts-?to-?book|prebook-?courts?)(?:=(\d+)|\s+(\d+))|(?<!-)\b(?:pre-?book|book)\s+(\d+)\s+courts?|(?<!-)\b(?:pre-?book-?courts?|preBookCourts)\s*[:=]\s*(\d+))/i);
  if (pbCourtsMatch) {
    const valStr = pbCourtsMatch[1] || pbCourtsMatch[2] || pbCourtsMatch[3] || pbCourtsMatch[4];
    if (valStr && parseInt(valStr, 10) > 0) {
      flags.preBookCourts = parseInt(valStr, 10);
    }
    rem = rem.replace(pbCourtsMatch[0], ' ');
  }

  // 4. courtsStrategy: book | lookup | none
  if (jsonMap) {
    const val = jsonMap['courts-strategy'] ?? jsonMap['courtsStrategy'] ?? jsonMap['court-strategy'] ?? jsonMap['courtStrategy'];
    if (val !== undefined && typeof val === 'string') {
      const v = val.toLowerCase().trim();
      if (['book', 'lookup', 'none'].includes(v)) {
        flags.courtsStrategy = v;
      }
    }
  }
  const courtsStrategyRegex = /(?:^|\s)--(?:courts|court)-strategy(?:=|\s+)(book|lookup|none)(?![-\w])/i;
  const courtsStrategyMatch = rem.match(courtsStrategyRegex);
  if (courtsStrategyMatch) {
    flags.courtsStrategy = courtsStrategyMatch[1].toLowerCase();
    rem = rem.replace(courtsStrategyMatch[0], ' ');
  } else if (!flags.courtsStrategy) {
    const naturalStrategyMatch = rem.match(/\b(?:courts?\s*strategy\s*[:=]\s*(book|lookup|none))\b/i);
    if (naturalStrategyMatch) {
      flags.courtsStrategy = naturalStrategyMatch[1].toLowerCase();
      rem = rem.replace(naturalStrategyMatch[0], ' ');
    }
  }

  if (flags.courtsStrategy === 'book') {
    flags.checkCourts = true;
    flags.courtBookingType = 'pre-book';
  } else if (flags.courtsStrategy === 'lookup') {
    flags.checkCourts = true;
    flags.courtBookingType = 'none';
  } else if (flags.courtsStrategy === 'none') {
    flags.checkCourts = false;
    flags.courtBookingType = 'none';
  }

  // 5. bookingPlayers
  const bpFlagMatch = rem.match(/(?:--(?:booking-?players?|booking-?names?|players?)\s*=?|(?:booking[-_\s]*players?|booking[-_\s]*names?|players?)\s*[:=]|\bwith\s+players?\s+)\s*(?:"([^"]+)"|'([^']+)'|(\[[^\]]+\](?:\s*,\s*\[[^\]]+\])*)|([^\n\r-]+?))(?=\s+--|$)/i);
  if (bpFlagMatch) {
    const rawVal = bpFlagMatch[1] || bpFlagMatch[2] || bpFlagMatch[3] || bpFlagMatch[4];
    if (rawVal && rawVal.trim()) {
      flags.bookingPlayers = groupsConfig.normalizeBookingPlayerLists(rawVal.trim());
    }
    rem = rem.replace(bpFlagMatch[0], ' ');
  } else {
    const bracketMatch = rem.match(/\b(?:with\s+players?|for\s+players?|using\s+players?|players?)\s*(\[[^\]]+\](?:\s*,\s*\[[^\]]+\])*)/i);
    if (bracketMatch && bracketMatch[1]) {
      flags.bookingPlayers = groupsConfig.normalizeBookingPlayerLists(bracketMatch[1].trim());
      rem = rem.replace(bracketMatch[0], ' ');
    }
  }

  // 6. (checkCourts / noCourts dropped in favor of --courts-strategy)

  // 7. matchups
  const noMatchRegex = /(?:^|\s)(?:--no-?matchups?|--no-?draw|--auto-?matchups?=(?:false|no|0|off|disabled)|--auto-?draw=(?:false|no|0|off|disabled)|--matchups?=(?:none|false|no|off|0|disabled|manual)|auto-?matchups?=(?:false|no|0|off|disabled)|matchups?=(?:none|false|no|off|0|disabled|manual))(?![-\w])|\b(?:matchups?|auto-?matchups?)\s*[:=]\s*(?:none|false|no|off|0|disabled|manual)\b|\b(?:no[-_\s]*matchups?|no[-_\s]*draw|without\s+(?:auto[-_\s]*|automatic\s+)?matchups?|without\s+(?:auto[-_\s]*|automatic\s+)?draw|(?:do\s*not|don'?t)\s+(?:create|make|generate|post|auto-?generate)\s+(?:matchups?|draw|the\s+draw|the\s+matchups?)|no[-_\s]*(?:auto\s+|automatic\s+)?matchups?|manual[-_\s]*matchups?)\b/i;
  const autoMatchRegex = /(?:^|\s)(?:--auto-?matchups?|--auto-?draw|--matchups?)(?:=(?:true|yes|1|on|enabled))?(?![-\w=])|\b(?:auto-?matchups?|auto-?draw|with\s+matchups?|enable\s+matchups?)\b/i;
  if (noMatchRegex.test(rem)) {
    flags.lineupGeneration = 'none';
    rem = rem.replace(noMatchRegex, ' ');
  } else if (autoMatchRegex.test(rem)) {
    flags.lineupGeneration = 'filled';
    rem = rem.replace(autoMatchRegex, ' ');
  }

  // 8. pre-allocate-slots / prebooked spots
  if (jsonMap) {
    const val = jsonMap['--pre-allocate-slots'] ?? jsonMap['pre-allocate-slots'] ?? jsonMap['preAllocateSlots'] ?? jsonMap['preallocate-slots'] ?? jsonMap['prebooked-spots'] ?? jsonMap['prebookedSpots'] ?? jsonMap['includePrebookedSpots'];
    if (val !== undefined) flags.includePrebookedSpots = String(val).toLowerCase() === 'true' || val === true || String(val).toLowerCase() === 'yes' || val === 1;
  }
  const noPrebookedRegex = /(?:^|\s)(?:--?(?:no-?)?pre-?allocate-?slots?=(?:false|no|0)|--?no-?pre-?allocate-?slots?|no-?pre-?allocate-?slots?|--?no-?prebooked[-_]?spots?|no-?prebooked[-_]?spots?|--?no-?named-?spots?|--?prebooked[-_]?spots?=(?:false|no|0)|prebooked[-_]?spots?=(?:false|no|0))(?![-\w])|\b(?:without|no)\s+(?:named\s+|the\s+)?(?:pre-?allocated?[-_]?(?:slots?|spots?)|prebooked[-_]?spots?)\b/i;
  const prebookedRegex = /(?:^|\s)(?:--pre-?allocate-?slots?|pre-?allocate-?slots?|--preallocate-?slots?)(?:=(?:true|yes|1))?(?![-\w])|(?:^|\s)(?:--?prebooked[-_]?spots?|prebooked[-_]?spots?)(?:=(?:true|yes|1))?(?![-\w])|(?:^|\s)(?:--with-?pre-?allocate-?slots?|--with-?prebooked-?spots?|--named-?prebooked-?slots?|--prebooked-?slots?)(?![-\w])|\b(?:with|include)\s+(?:named\s+|the\s+)?(?:pre-?allocated?[-_]?(?:slots?|spots?)|prebooked[-_]?(?:spots?|slots?))\b/i;
  if (flags.includePrebookedSpots === undefined) {
    if (noPrebookedRegex.test(rem)) {
      flags.includePrebookedSpots = false;
      rem = rem.replace(noPrebookedRegex, ' ');
    } else if (prebookedRegex.test(rem)) {
      flags.includePrebookedSpots = true;
      rem = rem.replace(prebookedRegex, ' ');
    }
  }
  if (flags.includePrebookedSpots !== undefined) {
    flags['--pre-allocate-slots'] = flags.includePrebookedSpots;
    flags['pre-allocate-slots'] = flags.includePrebookedSpots;
    flags.preAllocateSlots = flags.includePrebookedSpots;
    flags['prebooked-spots'] = flags.includePrebookedSpots;
    flags.prebookedSpots = flags.includePrebookedSpots;
  }

  // 9. creator
  const incCreatorRegex = /\b(?:include\s+me|with\s+me|count\s+me\s+in|i'm\s+playing|im\s+playing)\b/i;
  const excCreatorRegex = /\b(?:exclude\s+me|without\s+me|not\s+playing|won't\s+play|wont\s+play)\b/i;
  if (incCreatorRegex.test(rem)) {
    flags.includeCreator = true;
    rem = rem.replace(incCreatorRegex, ' ');
  } else if (excCreatorRegex.test(rem)) {
    flags.includeCreator = false;
    rem = rem.replace(excCreatorRegex, ' ');
  }

  // 10. startDate & endDate
  if (jsonMap) {
    const sVal = jsonMap['start-date'] ?? jsonMap['startDate'] ?? jsonMap['start'] ?? jsonMap['from'];
    if (sVal !== undefined) flags.startDate = String(sVal).trim();
    const eVal = jsonMap['end-date'] ?? jsonMap['endDate'] ?? jsonMap['end'] ?? jsonMap['until'] ?? jsonMap['to'];
    if (eVal !== undefined) flags.endDate = String(eVal).trim();
  }

  const startFlagM = rem.match(/(?:--(?:start-?date|start|from)=(?:["']([^"']+)["']|([^\s]+))|-(?:s)\s+(?:["']([^"']+)["']|([^\s]+)))/i);
  if (startFlagM) {
    if (flags.startDate === undefined) flags.startDate = (startFlagM[1] || startFlagM[2] || startFlagM[3] || startFlagM[4]).trim();
    rem = rem.replace(startFlagM[0], ' ');
  }

  const endFlagM = rem.match(/(?:--(?:end-?date|end|until)=(?:["']([^"']+)["']|([^\s]+))|-(?:e)\s+(?:["']([^"']+)["']|([^\s]+)))/i);
  if (endFlagM) {
    if (flags.endDate === undefined) flags.endDate = (endFlagM[1] || endFlagM[2] || endFlagM[3] || endFlagM[4]).trim();
    rem = rem.replace(endFlagM[0], ' ');
  }

  const fromToM = rem.match(/\bfrom\s+([a-z0-9/\-]+(?:\s+[a-z0-9/\-]+)?)\s+(?:to|until|through|thru)\s+([a-z0-9/\-]+(?:\s+[a-z0-9/\-]+)?)\b/i);
  if (fromToM) {
    const candStart = parseDateToDateKey(fromToM[1]);
    const candEnd = parseDateToDateKey(fromToM[2]);
    if (candStart && candEnd) {
      if (flags.startDate === undefined) flags.startDate = fromToM[1].trim();
      if (flags.endDate === undefined) flags.endDate = fromToM[2].trim();
      rem = rem.replace(fromToM[0], ' ');
    }
  }

  const CONNECTIVES = new Set(['until', 'till', 'to', 'through', 'thru', 'and', 'at', 'on', 'for', 'with', 'everyday', 'weekdays', 'weekends']);
  function extractDateCandidate(str, prefixRegex) {
    const m = str.match(prefixRegex);
    if (!m) return null;
    const after = m[1].trim();
    if (/^(?:none|clear|remove|null)\b/i.test(after)) {
      return { matchStr: m[0], raw: 'none' };
    }
    const words = after.split(/\s+/);
    if (words.length >= 1) {
      const one = words[0];
      if (/^(?:today|tomorrow|\d{4}-\d{1,2}-\d{1,2}|\d{1,2}\/\d{1,2}(?:\/\d{2,4})?)$/i.test(one)) {
        return { matchStr: str.slice(m.index, m.index + m[0].indexOf(m[1]) + one.length), raw: one };
      }
    }
    if (words.length >= 2 && !CONNECTIVES.has(words[1].toLowerCase())) {
      const two = `${words[0]} ${words[1]}`;
      const cand2 = parseDateToDateKey(two);
      if (cand2) {
        return { matchStr: str.slice(m.index, m.index + m[0].indexOf(m[1]) + two.length), raw: two };
      }
    }
    if (words.length >= 1) {
      const one = words[0];
      const cand1 = parseDateToDateKey(one);
      if (cand1) {
        return { matchStr: str.slice(m.index, m.index + m[0].indexOf(m[1]) + one.length), raw: one };
      }
    }
    return null;
  }

  if (flags.startDate === undefined) {
    const res = extractDateCandidate(rem, /\b(?:start(?:ing)?\s*(?:date)?|starts)\s*[:=]?\s*(.+)$/i);
    if (res) {
      flags.startDate = res.raw;
      rem = rem.replace(res.matchStr, ' ');
    }
  }

  if (flags.endDate === undefined) {
    const res = extractDateCandidate(rem, /\b(?:end(?:ing)?\s*(?:date)?|ends)\s*[:=]?\s*(.+)$/i);
    if (res) {
      flags.endDate = res.raw;
      rem = rem.replace(res.matchStr, ' ');
    }
  }

  if (flags.endDate === undefined) {
    const res = extractDateCandidate(rem, /\b(?:until|till|through|thru)\s+(.+)$/i);
    if (res) {
      flags.endDate = res.raw;
      rem = rem.replace(res.matchStr, ' ');
    }
  }

  // 11. lookAround
  if (jsonMap) {
    const val = jsonMap['look-around'] ?? jsonMap['lookAround'] ?? jsonMap['lookaround'] ?? jsonMap['look-around-window'] ?? jsonMap['window'];
    if (val !== undefined) {
      const parsed = parseLookAround(val);
      if (parsed) flags.lookAround = parsed;
    }
  }

  const lookAroundRegex = /(?:--(?:look-?around(?:-?period|-?window)?|lookaround)\s*=?\s*(?:"([^"]+)"|'([^']+)'|([^\s]+))|(?:with\s+)?\blook[-_\s]*around(?:\s*(?:period|window))?\s*[:=]\s*(?:"([^"]+)"|'([^']+)'|(\d+(?:\.\d+)?\s*(?:hours?|hrs?|h|minutes?|mins?|m)\b|\b(?:one|two|three|four|half)\s+(?:an?\s+)?hours?\b|[^\s]+))|(?:with\s+)?\blook[-_\s]*around(?:\s*(?:period|window))?\s+of\s+(?:"([^"]+)"|'([^']+)'|(\d+(?:\.\d+)?\s*(?:hours?|hrs?|h|minutes?|mins?|m)\b|\b(?:one|two|three|four|half)\s+(?:an?\s+)?hours?\b|[^\s]+))|(?:with\s+)?\blook[-_\s]*around(?:\s*(?:period|window))?\s+(?:(?:'([^"]+)"|'([^']+)')|(\d+(?:\.\d+)?\s*(?:hours?|hrs?|h|minutes?|mins?|m)\b|\b(?:one|two|three|four|half)\s+(?:an?\s+)?hours?\b)))/i;

  const laMatch = rem.match(lookAroundRegex);
  if (laMatch) {
    const rawVal = laMatch[1] || laMatch[2] || laMatch[3] || laMatch[4] || laMatch[5] || laMatch[6] || laMatch[7] || laMatch[8] || laMatch[9] || laMatch[10] || laMatch[11] || laMatch[12];
    if (rawVal) {
      const parsed = parseLookAround(rawVal);
      if (parsed) flags.lookAround = parsed;
    }
    rem = rem.replace(laMatch[0], ' ');
  }

  // 12. slotCheck
  if (jsonMap) {
    const val = jsonMap['slot-check'] ?? jsonMap['slotCheck'] ?? jsonMap['slotcheck'] ?? jsonMap['check-slots'] ?? jsonMap['checkSlots'];
    if (val !== undefined) {
      flags.slotCheck = String(val).toLowerCase() === 'true' || val === true || String(val).toLowerCase() === 'yes' || val === 1;
    }
  }
  const noSlotCheckRegex = /(?:^|\s)(?:--no-?slot[-_]?checks?|--slot[-_]?checks?=(?:false|no|0|off|disabled)|slot[-_]?checks?=(?:false|no|0|off|disabled))(?![-\w])|\b(?:without|no|disable)\s+slot[-_\s]*checks?\b|\bslot[-_\s]*checks?\s*[:=]?\s*(?:false|no|off|disabled)\b/i;
  const slotCheckRegex = /(?:^|\s)(?:--slot[-_]?checks?)(?:=(?:true|yes|1|on|enabled))?(?![-\w])|(?:^|\s)(?:--with-?slot[-_]?checks?)(?![-\w])|\b(?:with|enable)\s+slot[-_\s]*checks?\b|\bslot[-_\s]*checks?\s*[:=]?\s*(?:true|yes|1|on|enabled)\b/i;
  if (flags.slotCheck === undefined) {
    if (noSlotCheckRegex.test(rem)) {
      flags.slotCheck = false;
      rem = rem.replace(noSlotCheckRegex, ' ');
    } else if (slotCheckRegex.test(rem)) {
      flags.slotCheck = true;
      rem = rem.replace(slotCheckRegex, ' ');
    }
  }

  // 13. lineupGeneration & lineupLeadTime
  if (jsonMap) {
    const lgVal = jsonMap['lineup-generation'] ?? jsonMap['lineupGeneration'] ?? jsonMap['lineups'] ?? jsonMap['lineup'] ?? jsonMap['matchup-generation'] ?? jsonMap['matchupGeneration'];
    if (lgVal !== undefined) {
      const s = String(lgVal).toLowerCase().trim();
      if (/^(?:fallback|deadline|conditional|delay(?:ed)?)$/i.test(s)) {
        flags.lineupGeneration = 'fallback';
      } else if (/^(?:filled|on[-_\s]*fill|immediate|always|true|yes)$/i.test(s)) {
        flags.lineupGeneration = 'filled';
      } else if (/^(?:none|never|no|false|off|disabled|manual)$/i.test(s)) {
        flags.lineupGeneration = 'none';
      }
    }
    const lltVal = jsonMap['lineup-lead-time'] ?? jsonMap['lineupLeadTime'] ?? jsonMap['lineup-deadline'] ?? jsonMap['lineupDeadline'] ?? jsonMap['lead-time'] ?? jsonMap['leadTime'];
    if (lltVal !== undefined) {
      const parsedLT = parseLookAround(lltVal);
      if (parsedLT) flags.lineupLeadTime = parsedLT;
    }
  }

  const leadTimeRegex = /(?:--(?:lineup-?lead-?time|lineup-?deadline|lineup-?lead)\s*=?\s*(?:"([^"]+)"|'([^']+)'|([^\s]+))|\b(?:lineup(?:s)?\s*(?:lead\s*time|deadline)|lead\s*time)\s*[:=]\s*(?:"([^"]+)"|'([^']+)'|(\d+(?:\.\d+)?\s*(?:hours?|hrs?|h|minutes?|mins?|m)\b|\b(?:one|two|three|four|half)\s+(?:an?\s+)?hours?\b|[^\s]+)))/i;
  const ltMatch = rem.match(leadTimeRegex);
  if (ltMatch) {
    const rawVal = ltMatch[1] || ltMatch[2] || ltMatch[3] || ltMatch[4] || ltMatch[5] || ltMatch[6];
    if (rawVal) {
      const parsedLT = parseLookAround(rawVal);
      if (parsedLT) flags.lineupLeadTime = parsedLT;
    }
    rem = rem.replace(ltMatch[0], ' ');
  }

  const lgExplicitRegex = /(?:--(?:lineup-?generation|matchup-?generation|lineups?|matchups?)(?:=|:|\s+)(?:"([^"]+)"|'([^']+)'|([^\s]+))|\b(?:lineup(?:s)?(?:[-_\s]*generation)?|matchups?)\s*(?:[:=]|\s+to\s+|\s+)\s*(?:"([^"]+)"|'([^']+)'|([^\s]+)))/i;
  const lgMatch = rem.match(lgExplicitRegex);
  if (lgMatch) {
    const rawVal = (lgMatch[1] || lgMatch[2] || lgMatch[3] || lgMatch[4] || lgMatch[5] || lgMatch[6] || '').toLowerCase().trim();
    let recognized = true;
    if (/^(?:fallback|deadline|conditional|delay(?:ed)?)$/i.test(rawVal)) {
      flags.lineupGeneration = 'fallback';
    } else if (/^(?:filled|on[-_\s]*fill|immediate|always|true|yes)$/i.test(rawVal)) {
      flags.lineupGeneration = 'filled';
    } else if (/^(?:none|never|no|false|off|disabled|manual)$/i.test(rawVal)) {
      flags.lineupGeneration = 'none';
    } else {
      recognized = false;
    }
    if (recognized) {
      rem = rem.replace(lgMatch[0], ' ');
    }
  }

  if (flags.lineupGeneration === undefined) {
    if (/(?:^|\s)(?:--lineups?-?fallback|--fallback-?lineups?)(?![-\w])|\bfallback\s+lineups?\b/i.test(rem)) {
      flags.lineupGeneration = 'fallback';
      rem = rem.replace(/(?:^|\s)(?:--lineups?-?fallback|--fallback-?lineups?)(?![-\w])|\bfallback\s+lineups?\b/i, ' ');
    } else if (/(?:^|\s)(?:--lineups?-?filled|--lineups?-?on-?fill)(?![-\w])|\blineups?\s+filled\b/i.test(rem)) {
      flags.lineupGeneration = 'filled';
      rem = rem.replace(/(?:^|\s)(?:--lineups?-?filled|--lineups?-?on-?fill)(?![-\w])|\blineups?\s+filled\b/i, ' ');
    } else if (/(?:^|\s)(?:--no-?lineups?|--manual-?lineups?)(?![-\w])|\bno\s+lineup\s+generation\b|\bwithout\s+lineup\s+generation\b|\b(?:manual\s+lineups?|no\s+lineups?|without\s+lineups?)\b/i.test(rem)) {
      flags.lineupGeneration = 'none';
      rem = rem.replace(/(?:^|\s)(?:--no-?lineups?|--manual-?lineups?)(?![-\w])|\bno\s+lineup\s+generation\b|\bwithout\s+lineup\s+generation\b|\b(?:manual\s+lineups?|no\s+lineups?|without\s+lineups?)\b/i, ' ');
    }
  }

  // 14. reminders
  if (jsonMap) {
    const rVal = jsonMap['reminders'] ?? jsonMap['reminder'] ?? jsonMap['remind'];
    if (rVal !== undefined) {
      flags.reminders = String(rVal).toLowerCase() === 'true' || rVal === true || String(rVal).toLowerCase() === 'yes' || String(rVal).toLowerCase() === 'on' || rVal === 1;
    }
  }
  const noRemindersRegex = /(?:^|\s)(?:--no-?reminders?|--reminders?=(?:false|no|0|off|disabled)|reminders?=(?:false|no|0|off|disabled))(?![-\w])|\b(?:without|no|disable)\s+reminders?\b|\breminders?\s*[:=]?\s*(?:false|no|off|disabled)\b/i;
  const remindersRegex = /(?:^|\s)(?:--reminders?(?:=(?:true|yes|1|on|enabled))?(?![-\w=]))|(?:^|\s)(?:--with-?reminders?)(?![-\w])|\b(?:with|enable)\s+reminders?\b|\breminders?\s*[:=]?\s*(?:true|yes|1|on|enabled)\b/i;
  if (flags.reminders === undefined) {
    if (noRemindersRegex.test(rem)) {
      flags.reminders = false;
      rem = rem.replace(noRemindersRegex, ' ');
    } else if (remindersRegex.test(rem)) {
      flags.reminders = true;
      rem = rem.replace(remindersRegex, ' ');
    }
  }

  // 15. maxCourts
  if (jsonMap) {
    const mcVal = jsonMap['max-courts'] ?? jsonMap['maxCourts'] ?? jsonMap['max_courts'] ?? jsonMap['maxcourts'];
    if (mcVal !== undefined) {
      if (mcVal === null || /^(?:none|clear|remove|default|null|0|false)$/i.test(String(mcVal).trim())) {
        flags.maxCourts = null;
      } else if (parseInt(mcVal, 10) > 0) {
        flags.maxCourts = parseInt(mcVal, 10);
      }
    }
  }
  const maxCourtsNoneRegex = /(?:--(?:max[-_]?courts?|maximum[-_]?courts?)(?:=|\s+)(?:none|clear|remove|default|null|0)|--no-?max[-_]?courts?|\b(?:max(?:imum)?[-_\s]*courts?)\s*(?:[:=]\s*|\s+)(?:none|clear|remove|default|null|0))\b/i;
  const maxCourtsRegex = /(?:--(?:max[-_]?courts?|maximum[-_]?courts?)(?:=(\d+)|\s+(\d+))|\b(?:max(?:imum)?[-_\s]*courts?)\s*(?:[:=]\s*|\s+)(\d+)|\b(?:max(?:imum)?\s+(\d+)\s+courts?)\b)/i;
  if (maxCourtsNoneRegex.test(rem)) {
    flags.maxCourts = null;
    rem = rem.replace(maxCourtsNoneRegex, ' ');
  } else {
    const mcMatch = rem.match(maxCourtsRegex);
    if (mcMatch) {
      const rawVal = mcMatch[1] || mcMatch[2] || mcMatch[3] || mcMatch[4];
      if (rawVal && parseInt(rawVal, 10) > 0) {
        flags.maxCourts = parseInt(rawVal, 10);
      }
      rem = rem.replace(mcMatch[0], ' ');
    }
  }
  if (flags.maxCourts !== undefined) {
    flags['max-courts'] = flags.maxCourts;
    flags['maxCourts'] = flags.maxCourts;
  }

  // 16. multiVote & multiSessionMode (for multi-time polls)
  if (jsonMap) {
    const mvVal = jsonMap['multi-vote'] ?? jsonMap['multiVote'] ?? jsonMap['multiple-votes'] ?? jsonMap['multipleVotes'];
    if (mvVal !== undefined) {
      flags.multiVote = !(String(mvVal).toLowerCase() === 'false' || mvVal === false || String(mvVal).toLowerCase() === 'no' || mvVal === 0 || String(mvVal).toLowerCase() === 'single');
    }
    const svVal = jsonMap['single-vote'] ?? jsonMap['singleVote'] ?? jsonMap['single-slot'] ?? jsonMap['single-time'];
    if (svVal !== undefined) {
      const isSingle = String(svVal).toLowerCase() === 'true' || svVal === true || String(svVal).toLowerCase() === 'yes' || svVal === 1;
      flags.multiVote = !isSingle;
      if (isSingle) {
        flags.multiSessionMode = 'single_session';
      }
    }
    const msmVal = jsonMap['multi-session-mode'] ?? jsonMap['multiSessionMode'] ?? jsonMap['session-mode'] ?? jsonMap['sessionMode'];
    if (msmVal !== undefined) {
      const s = String(msmVal).toLowerCase().trim();
      flags.multiSessionMode = /^(?:single[-_\s]*session|one[-_\s]*session|dedup(?:licate)?|single|exclusive)$/i.test(s) ? 'single_session' : 'independent';
    }
  }
  const singleVoteRegex = /(?:^|\s)(?:--(?:single-?vote|single-?slot|single-?time|one-?vote|one-?time)|--multi-?votes?=(?:false|no|0))(?![-\w])|\b(?:single\s+vote\s+only|vote\s+for\s+(?:only\s+)?one\s+(?:time|slot)|only\s+one\s+time\s+vote)\b/i;
  const multiVoteRegex = /(?:^|\s)(?:--(?:multi-?votes?|multiple-?votes?|multi-?slots?|multi-?times?)(?:=(?:true|yes|1))?)(?![-\w=])|\b(?:allow\s+multiple\s+votes|vote\s+for\s+multiple\s+(?:times|slots))\b/i;
  if (singleVoteRegex.test(rem)) {
    flags.multiVote = false;
    flags.multiSessionMode = 'single_session';
    rem = rem.replace(singleVoteRegex, ' ');
  } else if (multiVoteRegex.test(rem)) {
    flags.multiVote = true;
    rem = rem.replace(multiVoteRegex, ' ');
  }

  const singleSessionRegex = /(?:^|\s)(?:--(?:single-?session|one-?session|dedup-?sessions?)|--(?:multi-?session-?mode|session-?mode)=(?:single(?:_session)?|one|dedup))(?![-\w])|\b(?:one\s+session\s+per\s+player|single\s+session\s+per\s+player)\b/i;
  const indepSessionRegex = /(?:^|\s)(?:--(?:independent-?sessions?|independent|multi-?sessions?)|--(?:multi-?session-?mode|session-?mode)=independent)(?![-\w])|\b(?:independent\s+sessions|multiple\s+sessions\s+per\s+player)\b/i;
  if (singleSessionRegex.test(rem)) {
    flags.multiSessionMode = 'single_session';
    rem = rem.replace(singleSessionRegex, ' ');
  } else if (indepSessionRegex.test(rem)) {
    flags.multiSessionMode = 'independent';
    rem = rem.replace(indepSessionRegex, ' ');
  }
  if (flags.multiVote === false) {
    flags.multiSessionMode = 'single_session';
  }

  // 17. skipCourt / unskipCourt
  if (jsonMap) {
    const sc = jsonMap['skip-court'] ?? jsonMap['skipCourt'] ?? jsonMap['skip-courts'] ?? jsonMap['skipCourts'] ?? jsonMap['exclude-court'] ?? jsonMap['excludeCourt'];
    if (sc !== undefined) flags.skipCourt = sc;
    const usc = jsonMap['unskip-court'] ?? jsonMap['unskipCourt'] ?? jsonMap['unskip-courts'] ?? jsonMap['unskipCourts'] ?? jsonMap['clear-skipped-courts'];
    if (usc !== undefined) flags.unskipCourt = usc;
  }

  const skipCourtFlagRegex = /(?:--(?:skip[-_]?courts?|exclude[-_]?courts?)(?:=|\s+)(?:"([^"]+)"|'([^']+)'|((?:court\s*)?\d+(?:\s*,\s*(?:court\s*)?\d+)*)|([^\s]+))|\b(?:skip|exclude)\s+courts?\s*[:=]\s*(?:"([^"]+)"|'([^']+)'|((?:court\s*)?\d+(?:\s*,\s*(?:court\s*)?\d+)*)|([^\s]+)))/i;
  const scMatch = rem.match(skipCourtFlagRegex);
  if (scMatch) {
    const rawVal = scMatch[1] || scMatch[2] || scMatch[3] || scMatch[4] || scMatch[5] || scMatch[6] || scMatch[7] || scMatch[8];
    if (rawVal) flags.skipCourt = normalizeCourtList(rawVal);
    rem = rem.replace(scMatch[0], ' ');
  }

  if (flags.skipCourt === undefined) {
    const nlSkipMatch = rem.match(/\b(?:skip|exclude)\s+courts?\s+((?:court\s*)?\d+(?:\s*,\s*(?:court\s*)?\d+)*)\b/i);
    if (nlSkipMatch) {
      flags.skipCourt = normalizeCourtList(nlSkipMatch[1]);
      rem = rem.replace(nlSkipMatch[0], ' ');
    }
  }

  const unskipCourtFlagRegex = /(?:--(?:unskip[-_]?courts?|include[-_]?courts?)(?:=|\s+)(?:"([^"]+)"|'([^']+)'|((?:court\s*)?\d+(?:\s*,\s*(?:court\s*)?\d+)*)|([^\s]+))|--(?:clear|reset)[-_]?skipped[-_]?courts?\b|\b(?:unskip|include)\s+courts?\s*[:=]\s*(?:"([^"]+)"|'([^']+)'|((?:court\s*)?\d+(?:\s*,\s*(?:court\s*)?\d+)*)|([^\s]+)))/i;
  const uscMatch = rem.match(unskipCourtFlagRegex);
  if (uscMatch) {
    const rawVal = uscMatch[1] || uscMatch[2] || uscMatch[3] || uscMatch[4] || uscMatch[5] || uscMatch[6] || uscMatch[7] || uscMatch[8] || 'all';
    flags.unskipCourt = rawVal === 'all' ? 'all' : normalizeCourtList(rawVal);
    rem = rem.replace(uscMatch[0], ' ');
  }

  if (flags.unskipCourt === undefined) {
    const nlUnskipAll = rem.match(/\bunskip\s+all(?:\s+courts?)?\b|\bclear\s+skipped\s+courts?\b/i);
    if (nlUnskipAll) {
      flags.unskipCourt = 'all';
      rem = rem.replace(nlUnskipAll[0], ' ');
    } else {
      const nlUnskipMatch = rem.match(/\b(?:unskip|include)\s+courts?\s+((?:court\s*)?\d+(?:\s*,\s*(?:court\s*)?\d+)*)\b/i);
      if (nlUnskipMatch) {
        flags.unskipCourt = normalizeCourtList(nlUnskipMatch[1]);
        rem = rem.replace(nlUnskipMatch[0], ' ');
      }
    }
  }

  // 18. bookingCourtPreference / courtPreference
  if (jsonMap) {
    const cpVal = jsonMap['booking-court-preference'] ?? jsonMap['bookingCourtPreference'] ?? jsonMap['court-preference'] ?? jsonMap['courtPreference'] ?? jsonMap['courts-preference'] ?? jsonMap['courtPreferences'] ?? jsonMap['court_preference'] ?? jsonMap['booking_court_preference'];
    if (cpVal !== undefined) {
      if (cpVal === null || /^(?:none|clear|remove|default|null|0|false)$/i.test(String(cpVal).trim())) {
        flags.bookingCourtPreference = null;
      } else {
        flags.bookingCourtPreference = Array.isArray(cpVal) ? cpVal.map(String) : String(cpVal).replace(/^\[|\]$/g, '').split(/[,;\s]+/).map(s => s.trim()).filter(Boolean);
      }
    }
  }
  const cpNoneRegex = /(?:--(?:booking-?court-?preferences?|court-?preferences?|courts-?preference)(?:=|\s+)(?:none|clear|remove|default|null|0)|--no-?court-?preferences?|\b(?:booking\s*court\s*preferences?|court\s*preferences?)\s*(?:[:=]\s*|\s+)(?:none|clear|remove|default|null|0))\b/i;
  const cpRegex = /(?:--(?:booking-?court-?preferences?|court-?preferences?|courts-?preference)(?:=|\s+)(?:"([^"]+)"|'([^']+)'|(\[[^\]]+\])|([^\s]+))|\b(?:booking\s*court\s*preferences?|court\s*preferences?)\s*[:=]\s*(?:"([^"]+)"|'([^']+)'|(\[[^\]]+\])|([^\n\r-]+?)))(?=\s+--|$)/i;
  if (cpNoneRegex.test(rem)) {
    flags.bookingCourtPreference = null;
    rem = rem.replace(cpNoneRegex, ' ');
  } else {
    const cpMatch = rem.match(cpRegex);
    if (cpMatch) {
      const rawVal = cpMatch[1] || cpMatch[2] || cpMatch[3] || cpMatch[4] || cpMatch[5] || cpMatch[6] || cpMatch[7] || cpMatch[8];
      if (rawVal) {
        const cleaned = rawVal.trim().replace(/^\[|\]$/g, '');
        flags.bookingCourtPreference = cleaned.split(/[,;\s]+/).map(s => s.trim()).filter(Boolean);
      }
      rem = rem.replace(cpMatch[0], ' ');
    }
  }
  if (flags.bookingCourtPreference !== undefined) {
    flags['booking-court-preference'] = flags.bookingCourtPreference;
    flags['court-preference'] = flags.bookingCourtPreference;
    flags['courtPreference'] = flags.bookingCourtPreference;
  }

  // 19. postTime / creationTime / at flag
  if (jsonMap) {
    const ptVal = jsonMap['post-time'] ?? jsonMap['postTime'] ?? jsonMap['post-at'] ?? jsonMap['postAt'] ?? jsonMap['creation-time'] ?? jsonMap['creationTime'] ?? jsonMap['at'];
    if (ptVal !== undefined && ptVal !== null) flags.postTime = String(ptVal).trim();
  }
  const postFlagRegex = /(?:--(?:post-?time|post-?at|creation-?time|poll-?creation-?time|at)\s*=?\s*(?:"([^"]+)"|'([^']+)'|([^\s]+)))/i;
  const pfMatch = rem.match(postFlagRegex);
  if (pfMatch) {
    if (flags.postTime === undefined) {
      flags.postTime = (pfMatch[1] || pfMatch[2] || pfMatch[3]).trim();
    }
    rem = rem.replace(pfMatch[0], ' ');
  }
  if (flags.postTime !== undefined) {
    flags['post-time'] = flags.postTime;
    flags['at'] = flags.postTime;
    flags.creationTime = flags.postTime;
  }

  // simulate / mock / dry-run
  if (jsonMap) {
    const val = jsonMap['simulate'] ?? jsonMap['mock'] ?? jsonMap['dry-run'] ?? jsonMap['dryRun'];
    if (val !== undefined) flags.simulate = Boolean(val);
  }
  const simRegex = /(?:^|\s)(?:--(?:simulate|mock|dry-?run|test)|-(?:s|d))(?![-\w])|\b(?:simulate|dry-?run)\b/i;
  if (simRegex.test(rem)) {
    flags.simulate = true;
    flags.isSimulation = true;
    rem = rem.replace(simRegex, ' ');
  }

  const isPreBookFlag = flags.courtsStrategy === 'book' || flags.courtBookingType === 'pre-book' || flags.courtBookingType === 'prebook';
  if (isPreBookFlag && !flags.preBookCourts && flags.maxCourts) {
    flags.preBookCourts = flags.maxCourts;
  }

  rem = rem.replace(/\s+/g, ' ').trim();
  return { flags, remainingText: rem };
}

/**
 * Extracts scheduleId and untilDate from command text for pause operations.
 */
function extractPauseArgs(rawInput) {
  let str = (rawInput || '').trim();
  let untilDate = null;

  const flagM = str.match(/(?:--(?:until|till|resume-date|resumedate)=|-(?:u)\s+)(["']?)([^"'\s]+)\1/i);
  if (flagM) {
    untilDate = flagM[2].trim();
    str = str.replace(flagM[0], ' ').trim();
  }

  if (!untilDate) {
    const untilM = str.match(/\b(?:until|till|through|thru)\s+([a-z0-9/\-,\s]+)$/i);
    if (untilM) {
      untilDate = untilM[1].trim();
      str = str.slice(0, untilM.index).trim();
    }
  }

  let scheduleId = str.trim() || null;

  if (scheduleId && !untilDate) {
    const parts = scheduleId.split(/\s+/);
    if (parts.length >= 2) {
      const candidateDate = parts.slice(1).join(' ').trim();
      if (/^\d{4}-\d{1,2}-\d{1,2}$/.test(candidateDate) ||
          /^\d{1,2}\/\d{1,2}(?:\/\d{2,4})?$/.test(candidateDate) ||
          /^(?:tomorrow|today|sun(?:day)?|mon(?:day)?|tue(?:sday)?|wed(?:nesday)?|thu(?:rsday)?|fri(?:day)?|sat(?:urday)?)/i.test(candidateDate) ||
          /^(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i.test(candidateDate)) {
        scheduleId = parts[0].trim();
        untilDate = candidateDate;
      }
    }
  }

  if (scheduleId && !untilDate) {
    const isDate = /^\d{4}-\d{1,2}-\d{1,2}$/.test(scheduleId) ||
      /^\d{1,2}\/\d{1,2}(?:\/\d{2,4})?$/.test(scheduleId) ||
      /^(?:today|tomorrow|sun(?:day)?|mon(?:day)?|tue(?:sday)?|wed(?:nesday)?|thu(?:rsday)?|fri(?:day)?|sat(?:urday)?)$/i.test(scheduleId);
    if (isDate) {
      untilDate = scheduleId;
      scheduleId = null;
    }
  }

  return { scheduleId, untilDate };
}

/**
 * Extracts scheduleId, targetDayOrDate, and count for skip operations.
 */
function extractSkipArgs(scheduleIdArg, targetDayOrDateArg) {
  let scheduleId = String(scheduleIdArg || '').replace(/^["']|["']$/g, '').trim() || null;
  let target = String(targetDayOrDateArg || '').replace(/^["']|["']$/g, '').trim() || null;
  let count = 1;

  if (scheduleId && !target) {
    const parts = scheduleId.split(/\s+/);
    if (parts.length >= 2) {
      scheduleId = parts[0].trim();
      target = parts.slice(1).join(' ').trim();
    }
  }

  const combined = `${scheduleId || ''} ${target || ''}`.trim();
  const countFlagM = combined.match(/(?:--(?:count|instances?|num)=|-(?:n|c)\s+)(\d+)/i);
  if (countFlagM) {
    count = parseInt(countFlagM[1], 10);
    if (scheduleId) scheduleId = scheduleId.replace(countFlagM[0], '').trim() || null;
    if (target) target = target.replace(countFlagM[0], '').trim() || null;
  }

  if (target) {
    const numM = target.match(/^(?:next\s+)?(\d+)(?:\s*instances?)?$/i);
    if (numM) {
      count = parseInt(numM[1], 10);
      target = null;
    }
  }

  if (scheduleId) {
    const numM = scheduleId.match(/^(?:next\s+)?(\d+)(?:\s*instances?)?$/i);
    if (numM) {
      count = parseInt(numM[1], 10);
      scheduleId = null;
    }
  }

  return { scheduleId, targetDayOrDate: target, count: Math.max(1, count) };
}

/**
 * Extracts scheduleId, targetDayOrDate, and slots for future instance slot overrides.
 */
function extractOverrideSlotsArgs(rawArgs) {
  let text = String(rawArgs || '').replace(/^["'`]|[{"'`]$/g, '').trim();
  let scheduleId = null;
  let targetDayOrDate = null;
  let slots = null;

  const slotFlagM = text.match(/(?:--(?:slots?|size|spots?)=|(?:slots?|size|spots?)=)\s*([^\s]+)/i);
  if (slotFlagM) {
    slots = slotFlagM[1].trim();
    text = text.replace(slotFlagM[0], ' ').trim();
  }

  const WORD_NUMBERS = {
    two: 2, four: 4, six: 6, eight: 8, ten: 10, twelve: 12, fourteen: 14, sixteen: 16
  };

  const isResetWord = (w) => /^(?:reset|clear|none|remove|default)$/i.test(w);
  const isOptInWord = (w) => /^(?:opt-?in|optin|yes\s*\/?\s*no|yesno)$/i.test(w);
  const isAutoWord = (w) => /^auto$/i.test(w);
  const isSlotsWord = (w) => /^\d+$/.test(w) || WORD_NUMBERS[w.toLowerCase()] !== undefined || isResetWord(w) || isOptInWord(w) || isAutoWord(w);
  const parseSlotVal = (w) => {
    if (isResetWord(w) || isAutoWord(w)) return 'reset';
    if (isOptInWord(w)) return 'opt-in';
    if (WORD_NUMBERS[w.toLowerCase()] !== undefined) return WORD_NUMBERS[w.toLowerCase()];
    if (/^\d+$/.test(w)) return parseInt(w, 10);
    return w;
  };

  if (slots !== null) {
    slots = parseSlotVal(slots);
  }

  const isDayOrDateWord = (w) => {
    const l = w.toLowerCase();
    if (DAY_LOOKUP[l] !== undefined) return true;
    if (/^(?:today|tomorrow|next|all)$/i.test(l)) return true;
    if (/^\d{4}-\d{2}-\d{2}$/.test(l)) return true;
    if (/^\d{1,2}\/\d{1,2}(?:\/\d{2,4})?$/.test(l)) return true;
    return false;
  };

  const tokens = text.split(/\s+/).filter(Boolean);

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (!scheduleId && /^rec_[a-z0-9]+/i.test(token)) {
      scheduleId = token;
      continue;
    }
    if (slots === null && isSlotsWord(token)) {
      slots = parseSlotVal(token);
      continue;
    }
    if (!targetDayOrDate && isDayOrDateWord(token)) {
      targetDayOrDate = token;
      continue;
    }
    if (!scheduleId && !isDayOrDateWord(token) && !isSlotsWord(token)) {
      scheduleId = token;
      continue;
    }
    if (!targetDayOrDate) {
      targetDayOrDate = token;
    }
  }

  return { scheduleId, targetDayOrDate, slots };
}

/**
 * Shared extraction for post phrase, match/post times, days, size, and common flags
 * used by both `modify` and `create` branches in parseRecurringPollText.
 */
function extractScheduleFields(sourceText, fullText, { isModify }) {
  const jsonExtraction = extractJsonMap(sourceText);
  const postTimesByDay = jsonExtraction.map || null;
  let postTime = null;

  const { flags, remainingText } = extractCommonFlags(jsonExtraction.remainingText, jsonExtraction.map);
  const isExplicitOptIn = /\b(?:opt-?in|yes\s*\/\s*no|yesno|open)\b/i.test(remainingText) ||
    (!isModify && /^!(?:recurringoptinpoll|dailyoptinpoll|recurringyesnopoll|dailyyesnopoll)\b/i.test(fullText));
  let textForTimes = remainingText;

  const daysString = isModify ? extractDaysFromText(textForTimes) : null;

  let postPhraseMatch = null;
  if (!postTimesByDay) {
    const postPhraseRegex = isModify
      ? /\b(?:post(?:ed)?|posting|at)\s+((?:(?:\d+\s*days?\s*before(?:\s+at\s+(?:\d{1,2}(?::\d{2})?\s*(?:am|pm)?|\d{1,2}:\d{2}))?|\d+(?:\.\d+)?\s*hours?\s*(?:before|prior|in\s+advance)?|(?:the\s+)?(?:day|evening|night)\s*before|previous\s*day|(?:sun[a-z]*|mon[a-z]*|tue[a-z]*|wed[a-z]*|thu[a-z]*|fri[a-z]*|sat[a-z]*|weekdays?|weekends?|everyday)\s*(?:at\s+)?(?:\d{1,2}(?::\d{2})?\s*(?:am|pm)?|\d{1,2}:\d{2})|(?:\d{1,2}(?::\d{2})?\s*(?:am|pm)?|\d{1,2}:\d{2})\s*(?:on|for)?\s*(?:sun[a-z]*|mon[a-z]*|tue[a-z]*|wed[a-z]*|thu[a-z]*|fri[a-z]*|sat[a-z]*|weekdays?|weekends?|everyday)|(?:\d{1,2}(?::\d{2})?\s*(?:am|pm)?|\d{1,2}:\d{2}))[\s,;&and]*)+)/i
      : /\b(?:post(?:ed)?|posting)\s+(?:at\s+)?((?:(?:\d+\s*days?\s*before(?:\s+at\s+(?:\d{1,2}(?::\d{2})?\s*(?:am|pm)?|\d{1,2}:\d{2}))?|\d+(?:\.\d+)?\s*hours?\s*(?:before|prior|in\s+advance)?|(?:the\s+)?(?:day|evening|night)\s*before|previous\s*day|(?:sun[a-z]*|mon[a-z]*|tue[a-z]*|wed[a-z]*|thu[a-z]*|fri[a-z]*|sat[a-z]*|weekdays?|weekends?|everyday)\s*(?:at\s+)?(?:\d{1,2}(?::\d{2})?\s*(?:am|pm)?|\d{1,2}:\d{2})|(?:\d{1,2}(?::\d{2})?\s*(?:am|pm)?|\d{1,2}:\d{2})\s*(?:on|for)?\s*(?:sun[a-z]*|mon[a-z]*|tue[a-z]*|wed[a-z]*|thu[a-z]*|fri[a-z]*|sat[a-z]*|weekdays?|weekends?|everyday)|(?:\d{1,2}(?::\d{2})?\s*(?:am|pm)?|\d{1,2}:\d{2}))[\s,;&and]*)+)/i;
    postPhraseMatch = textForTimes.match(postPhraseRegex);
    if (postPhraseMatch) {
      postTime = postPhraseMatch[1].trim();
      textForTimes = textForTimes.replace(postPhraseMatch[0], ' ');
    }
  }

  const resolvedDaysString = isModify
    ? daysString
    : (extractDaysFromText(textForTimes) || (postPhraseMatch ? extractDaysFromText(remainingText) : null) || 'everyday');

  const timeRegex = /\b(\d{1,2}(?::\d{2})?\s*(?:am|pm))\b|\b(\d{1,2}:\d{2})\b/gi;
  const timeTokens = [];
  let tm;
  while ((tm = timeRegex.exec(textForTimes)) !== null) {
    timeTokens.push({ token: (tm[1] || tm[2]).trim(), index: tm.index });
  }

  let matchTime = null;
  if (timeTokens.length === 1) {
    if (isModify && !postTime) {
      const before = textForTimes.slice(Math.max(0, timeTokens[0].index - 15), timeTokens[0].index);
      if (/\b(?:post(?:ed)?|posting|at)\s*$/i.test(before)) {
        postTime = timeTokens[0].token;
      } else {
        matchTime = timeTokens[0].token;
      }
    } else {
      matchTime = timeTokens[0].token;
    }
  } else if (timeTokens.length >= 2) {
    const postIdx = timeTokens.findIndex((t) => {
      const before = textForTimes.slice(Math.max(0, t.index - 15), t.index);
      return /\b(?:post(?:ed)?|posting)\s*(?:at)?\s*$/i.test(before);
    });
    if (postIdx !== -1) {
      if (!postTime) postTime = timeTokens[postIdx].token;
      matchTime = timeTokens[postIdx === 0 ? 1 : 0].token;
    } else {
      matchTime = timeTokens[0].token;
      if (!postTime) postTime = timeTokens[1].token;
    }
  }

  let textCleaned = textForTimes.replace(/\b(?:\d{1,2}(?:[:.]\d{2})?\s*(?:am|pm)|\d{1,2}[:.]\d{2}\b)(?:\s*(?:\(\s*[^)]+?\s*\)|[:/](?:\d+|unlimited|open|none|auto)\b))?/ig, ' ');
  textCleaned = textCleaned.replace(/\b(?:weekdays?|weekends?|everyday|every\s+day|daily|sundays?|sun|mondays?|mon|tuesdays?|tues|tue|wednesdays?|weds|wed|thursdays?|thurs|thur|thu|fridays?|fri|saturdays?|sat)\b/gi, ' ');
  textCleaned = textCleaned.replace(/\b(?:on\s+|at\s+|for\s+)?(?:the\s+)?(?:courts?|pickleball|pb)\s*#?\s*\d+\b/gi, ' ');

  let size = isModify ? undefined : null;
  if (isExplicitOptIn) {
    if (isModify) size = null;
  } else if (/\bauto\b/i.test(textCleaned) || /\bauto[-_\s]*(?:spots?|players?|courts?|size)\b/i.test(textCleaned)) {
    size = 'auto';
  } else {
    const sizeExplicit = isModify
      ? (textCleaned.match(new RegExp(`\\b(?:for|size|spots?|players?)\\s*[:=]?\\s*(\\d+|${NUMBER_WORDS_PATTERN})\\b`, 'i')) ||
         textCleaned.match(new RegExp(`\\b(\\d+|${NUMBER_WORDS_PATTERN})\\s*(?:spots?|players?|people)\\b`, 'i')) ||
         textCleaned.match(new RegExp(`\\b([1-9]|1[0-6]|two|four|eight|twelve|sixteen)\\b`, 'i')))
      : (textCleaned.match(new RegExp(`\\b(?:for|size|spots?|players?)\\s*[:=]?\\s*(\\d+|${NUMBER_WORDS_PATTERN})\\b`, 'i')) ||
         textCleaned.match(new RegExp(`^!(?:recurringpoll|dailypoll|schedulepoll)\\s+(\\d+|${NUMBER_WORDS_PATTERN})\\b`, 'i')) ||
         textCleaned.match(new RegExp(`\\b(\\d+|${NUMBER_WORDS_PATTERN})\\s*(?:spots?|players?|people)\\b`, 'i')) ||
         textCleaned.match(new RegExp(`\\bpoll\\s+for\\s+(\\d+|${NUMBER_WORDS_PATTERN})\\b`, 'i')) ||
         textCleaned.match(new RegExp(`\\b([1-9]|1[0-6]|two|four|eight|twelve|sixteen)\\b`, 'i')));
    if (sizeExplicit) {
      const raw = sizeExplicit[1].toLowerCase();
      size = WORD_TO_NUMBER[raw] || parseInt(raw, 10);
    } else if (/\bsingles\b/i.test(textCleaned)) {
      size = 2;
    } else if (/\bdoubles\b/i.test(textCleaned)) {
      size = 4;
    }
  }

  return {
    flags,
    size,
    matchTime,
    postTime,
    postTimesByDay,
    daysString: resolvedDaysString,
    isExplicitOptIn,
    timeSlots: pollTime.parseMultiTimeSlots(textForTimes, null, size)
  };
}

/**
 * Parses user input to detect recurring/daily poll commands or natural language phrases.
 */
function parseRecurringPollText(rawText) {
  if (!rawText || typeof rawText !== 'string') return null;
  const text = cleanIncomingText(rawText);

  // 1. Check sub-commands (cancel/clear all, simulate, status, list, cancel, overrides, skip/unskip, pause, resume, modify/edit)
  if (/^!(?:clearallrecurringpolls|clearrecurringpolls|cancelallrecurringpolls|deleteallrecurringpolls|removeallrecurringpolls|clearallrecurring|cancelallrecurring)\b/i.test(text) ||
      /^!(?:clearallrecurringpoll|cancelallrecurringpoll)\b/i.test(text) ||
      /^!(?:cancelrecurringpoll|deleterecurringpoll|removerecurringpoll|recurringpoll|dailypoll|schedulepoll|recurringpolls|dailypolls)\s+(?:all|clearall|cancelall|deleteall|clear|cancel\s+all|delete\s+all)\b/i.test(text) ||
      /\b(?:clear|cancel|delete|remove)\s+all\s+(?:daily|recurring|scheduled)\s+polls\b/i.test(text)) {
    return { action: 'clear_all' };
  }

  const simMatch = text.match(/^!(?:simulaterecurringpoll|simulaterecurring|simrecurringpoll|simrecurring)\s*(?:poll\s+)?(?:[`'"])?([^\s`'"]+)?(?:[`'"])?(?:\s+(.*))?$/i) ||
    text.match(/^!(?:recurringpoll|dailypoll|schedulepoll|recurringpolls)\s+(?:simulate|sim|mock|test)\s*(?:poll\s+)?(?:[`'"])?([^\s`'"]+)?(?:[`'"])?(?:\s+(.*))?$/i) ||
    text.match(/\b(?:simulate|mock|test)\s+(?:the\s+)?(?:daily|recurring|scheduled)\s+poll\s+(?:[`'"])?([^\s`'"]+)?(?:[`'"])?(?:\s+(.*))?\b/i);
  if (simMatch) {
    return {
      action: 'simulate',
      scheduleId: simMatch[1]?.trim() || null,
      targetDayOrDate: simMatch[2]?.trim() || null
    };
  }

  const advBookingsMatch = text.match(/^!(?:recurringpolls?|dailypolls?|scheduledpolls?|schedulepoll|dailypoll)\s+advanced?\s*bookings?(?:\s+(?:[`'"])?([^`'"\s]+)(?:[`'"])?)?\s*$/i) ||
    text.match(/^!(?:recurringpolls?|dailypolls?|scheduledpolls?|schedulepoll|dailypoll)\s+(?:[`'"])?(rec_[^`'"\s]+)(?:[`'"])?\s+advanced?\s*bookings?\s*$/i) ||
    text.match(/^!advanced?\s*bookings?(?:\s+(?:[`'"])?([^`'"\s]+)(?:[`'"])?)?\s*$/i) ||
    text.match(/\b(?:show|list|view|get|check)\s+(?:all\s+)?(?:the\s+)?(?:upcoming\s+)?recurring\s+advanced?\s*bookings?(?:\s+(?:for\s+)?(?:[`'"])?(rec_[^`'"\s]+)(?:[`'"])?)?\b/i);
  if (advBookingsMatch) {
    return { action: 'advance_bookings', scheduleId: advBookingsMatch[1]?.trim() || null };
  }

  const statusMatch = text.match(/^!(?:recurringpoll|dailypoll|schedulepoll|recurringpolls|scheduledpolls)\s+status\s*(?:poll\s+)?(?:[`'"])?([^`'"\s]+)?(?:[`'"])?\s*$/i) ||
    text.match(/^!(?:recurringpoll|dailypoll|schedulepoll)\s+(?:[`'"])(rec_[^`'"\s]+)(?:[`'"])?\s+status\s*$/i) ||
    text.match(/\b(?:status\s+of\s+(?:the\s+)?(?:daily|recurring|scheduled)\s+poll|recurring\s+poll\s+status)\s+(?:[`'"])?([^`'"\s]+)(?:[`'"])?\b/i);
  if (statusMatch && statusMatch[1]) {
    return { action: 'status', scheduleId: statusMatch[1].trim() };
  }

  if (/^!(?:recurringpolls|scheduledpolls|dailypolls)\b/i.test(text) ||
      /^!(?:recurringpoll|dailypoll|schedulepoll)\s+(?:list|status|show)\b/i.test(text) ||
      /\b(?:list|show|view|display)\s+(?:all\s+)?(?:daily|recurring|scheduled)\s+polls\b/i.test(text)) {
    return { action: 'list' };
  }

  const cancelMatch = text.match(/^!(?:cancelrecurringpoll|deleterecurringpoll|removerecurringpoll|rmrecurringpoll|clearrecurringpoll)\s*(?:poll\s+)?(?:[`'"])?([^\s`'"]+)?(?:[`'"])?\s*$/i) ||
    text.match(/^!(?:recurringpoll|dailypoll|schedulepoll)\s+(?:cancel|delete|remove|rm|clear)\s*(?:poll\s+)?(?:[`'"])?([^\s`'"]+)?(?:[`'"])?\s*$/i) ||
    text.match(/\b(?:cancel|delete|remove|clear)\s+(?:daily|recurring|scheduled)\s+poll\s+(?:[`'"])?([^\s`'"]+)(?:[`'"])?\b/i);
  if (cancelMatch) {
    const rawId = String(cancelMatch[1] || '').trim();
    if (/^all$/i.test(rawId)) {
      return { action: 'clear_all' };
    }
    return { action: 'cancel', scheduleId: rawId || null };
  }

  const overrideSlotsMatch = text.match(/^!(?:recurringpoll|dailypoll|schedulepoll)\s+(?:setslots|setinstanceslots|instanceslots)\s*(?:poll\s+)?(.*)$/i) ||
    text.match(/\b(?:override|set)\s+(?:the\s+)?(?:number\s+of\s+)?slots?\s+(?:for\s+)?(?:future\s+)?(?:instance|poll)\s+(?:of|for)?\s*(?:daily|recurring|scheduled)?\s*(?:poll)?\s*(.*)$/i);
  if (overrideSlotsMatch) {
    const rawRest = overrideSlotsMatch[1]?.trim() || '';
    const { scheduleId, targetDayOrDate, slots } = extractOverrideSlotsArgs(rawRest);
    return { action: 'override_slots', scheduleId, targetDayOrDate, slots };
  }

  const unskipMatch = text.match(/^!(?:unskipinstance|unskiprecurringinstance|unskiprecurringpoll|unskiprecurring|resumeskip)\s*(?:poll\s+)?(?:[`'"])?([^\s`'"]+)?(?:[`'"])?(?:\s+(.*))?$/i) ||
    text.match(/^!(?:recurringpoll|dailypoll|schedulepoll)\s+(?:unskip|resumeskip)\s*(?:poll\s+)?(?:[`'"])?([^\s`'"]+)?(?:[`'"])?(?:\s+(.*))?$/i) ||
    text.match(/\b(?:unskip|restore)\s+(?:the\s+)?(?:skipped\s+)?(?:instance|poll)\s+(?:of|for)?\s*(?:daily|recurring|scheduled)?\s*(?:poll)?\s+(?:[`'"])?([^\s`'"]+)(?:[`'"])?(?:\s+(.*))?\b/i);
  if (unskipMatch) {
    return {
      action: 'unskip_instance',
      scheduleId: unskipMatch[1]?.trim() || null,
      targetDayOrDate: unskipMatch[2]?.trim() || null
    };
  }

  const skipMatch = text.match(/^!(?:skipinstances|skipinstance|skiprecurringinstances|skiprecurringinstance|skiprecurringpoll|skiprecurring|skippoll)\s*(?:poll\s+)?(.*)$/i) ||
    text.match(/^!(?:recurringpoll|dailypoll|schedulepoll)\s+(?:skip|skipinstance|skipinstances)\s*(?:poll\s+)?(.*)$/i) ||
    text.match(/\b(?:skip)\s+(?:the\s+)?(?:next\s+)?(\d+\s+)?(?:instances?|polls?)\s+(?:of|for)?\s*(?:daily|recurring|scheduled)?\s*(?:poll)?\s*(.*)$/i);
  if (skipMatch) {
    const rawRest = (skipMatch[1] || '').trim() + ' ' + (skipMatch[2] || '').trim();
    const { scheduleId, targetDayOrDate, count } = extractSkipArgs(rawRest.trim());
    return { action: 'skip_instance', scheduleId, targetDayOrDate, count };
  }

  const pauseMatch = text.match(/^!(?:pauserecurringpoll|stoprecurringpoll|pauserecurringpolls|pauseallrecurring|stopallrecurring)\s*(?:poll\s+)?(.*)$/i) ||
    text.match(/^!(?:recurringpoll|dailypoll|schedulepoll|recurringpolls)\s+(?:pause|stop)\s*(?:poll\s+)?(.*)$/i) ||
    text.match(/\b(?:pause|stop)\s+(?:the\s+)?(?:daily|recurring|scheduled)\s+polls?\s+(.*)$/i);
  if (pauseMatch) {
    const rawRest = pauseMatch[1]?.trim() || '';
    const { scheduleId, untilDate } = extractPauseArgs(rawRest);
    return { action: 'pause', scheduleId, untilDate };
  }

  const resumeMatch = text.match(/^!(?:resumerecurringpoll|startrecurringpoll)\s*(?:poll\s+)?(?:[`'"])?([^\s`'"]+)?(?:[`'"])?\s*$/i) ||
    text.match(/^!(?:recurringpoll|dailypoll|schedulepoll)\s+(?:resume|start)\s*(?:poll\s+)?(?:[`'"])?([^\s`'"]+)?(?:[`'"])?\s*$/i) ||
    text.match(/\b(?:resume|start)\s+(?:daily|recurring|scheduled)\s+poll\s+(?:[`'"])?([^\s`'"]+)(?:[`'"])?\b/i);
  if (resumeMatch) {
    return { action: 'resume', scheduleId: resumeMatch[1]?.trim() || null };
  }

  const modifyMatch = text.match(/^!(?:modifyrecurringpoll|editrecurringpoll|updaterecurringpoll|changerecurringpoll|modifyrecurring|editrecurring|updaterecurring)\s+(?:poll\s+)?(?:[`'"])?([^\s`'"]+)?(?:[`'"])?\s*(.*)$/i) ||
    text.match(/^!(?:recurringpoll|dailypoll|schedulepoll)\s+(?:modify|edit|update|change)\s+(?:poll\s+)?(?:[`'"])?([^\s`'"]+)?(?:[`'"])?\s*(.*)$/i) ||
    text.match(/\b(?:modify|edit|update|change)\s+(?:daily|recurring|scheduled)\s+poll\s+(?:[`'"])?([^\s`'"]+)(?:[`'"])?\s*(.*)$/i);
  if (modifyMatch) {
    const scheduleId = modifyMatch[1]?.trim() || null;
    const rest = modifyMatch[2]?.trim() || '';
    const extracted = extractScheduleFields(rest, text, { isModify: true });
    const { flags } = extracted;

    return {
      action: 'modify',
      scheduleId,
      updates: {
        size: extracted.size,
        matchTime: extracted.matchTime,
        postTime: extracted.postTime,
        postTimesByDay: extracted.postTimesByDay,
        days: extracted.daysString,
        isExplicitOptIn: extracted.isExplicitOptIn,
        includeCreator: flags.includeCreator,
        courtsStrategy: flags.courtsStrategy,
        checkCourts: flags.checkCourts,
        includeCourts: flags.checkCourts,
        includePrebookedSpots: flags.includePrebookedSpots,
        '--pre-allocate-slots': flags.includePrebookedSpots,
        'pre-allocate-slots': flags.includePrebookedSpots,
        preAllocateSlots: flags.includePrebookedSpots,
        'prebooked-spots': flags.includePrebookedSpots,
        prebookedSpots: flags.includePrebookedSpots,
        courtBookingType: flags.courtBookingType,
        bookingPlayers: flags.bookingPlayers,
        preBookCourts: flags.preBookCourts,
        bookingStrategy: flags.bookingStrategy,
        bookingSchedule: flags.bookingSchedule,
        lookAround: flags.lookAround,
        startDate: flags.startDate,
        endDate: flags.endDate,
        slotCheck: flags.slotCheck,
        lineupGeneration: flags.lineupGeneration,
        lineupLeadTime: flags.lineupLeadTime,
        reminders: flags.reminders !== undefined ? flags.reminders : undefined,
        maxCourts: flags.maxCourts,
        '--max-courts': flags.maxCourts,
        'max-courts': flags.maxCourts,
        bookingCourtPreference: flags.bookingCourtPreference,
        timeSlots: extracted.timeSlots,
        multiVote: flags.multiVote !== undefined ? flags.multiVote : true,
        multiSessionMode: (flags.multiVote === false) ? 'single_session' : (flags.multiSessionMode || 'single_session'),
        ...(flags.title !== undefined ? { title: flags.title } : {}),
        group: flags.group || null
      }
    };
  }

  // 2. Check creation command or phrase
  const isCommand = /^!(?:recurringpoll|dailypoll|schedulepoll|everydaypoll|repeatingpoll|recurringoptinpoll|dailyoptinpoll|recurringyesnopoll|dailyyesnopoll)\b/i.test(text);
  const isPhrase = /\b(?:schedule|create|set\s*up|setup|start|post)\s+(?:a\s+)?(?:new\s+)?(?:daily\s+|recurring\s+|repeating\s+|every\s*day\s+)(?:match\s+)?(?:singles\s+|doubles\s+|yes\/no\s+|yesno\s+|opt-?in\s+)?poll\b|\b(?:daily|recurring|repeating)\s+(?:match\s+)?(?:yes\/no\s+|yesno\s+|opt-?in\s+)?poll\b|\bpoll\s+every\s*day\b|\b(?:schedule|create|set\s*up|setup|post)\s+(?:a\s+)?(?:match\s+)?poll\s+(?:every|on)\s+(?:weekdays?|weekends?|mondays?|tuesdays?|wednesdays?|thursdays?|fridays?|saturdays?|sundays?)\b/i.test(text);

  if (!isCommand && !isPhrase) {
    return null;
  }

  const extracted = extractScheduleFields(text, text, { isModify: false });
  const { flags } = extracted;
  const parsedDays = parseDaysOfWeek(extracted.daysString);

  const finalCheckCourts = flags.checkCourts !== undefined ? flags.checkCourts : false;
  const finalIncludePrebooked = flags.includePrebookedSpots !== undefined ? flags.includePrebookedSpots : false;
  const finalIncludeCreator = flags.includeCreator !== undefined ? flags.includeCreator : false;

  return {
    action: 'create',
    size: extracted.size,
    matchTime: extracted.matchTime,
    postTime: extracted.postTime,
    postTimesByDay: extracted.postTimesByDay,
    days: parsedDays.raw,
    daysList: parsedDays.days,
    daysDisplay: parsedDays.display,
    includeCreator: finalIncludeCreator,
    courtsStrategy: flags.courtsStrategy || null,
    checkCourts: finalCheckCourts,
    includeCourts: finalCheckCourts,
    includePrebookedSpots: finalIncludePrebooked,
    '--pre-allocate-slots': finalIncludePrebooked,
    'pre-allocate-slots': finalIncludePrebooked,
    preAllocateSlots: finalIncludePrebooked,
    'prebooked-spots': finalIncludePrebooked,
    prebookedSpots: finalIncludePrebooked,
    courtBookingType: flags.courtBookingType || null,
    bookingPlayers: flags.bookingPlayers || null,
    preBookCourts: flags.preBookCourts || null,
    bookingStrategy: flags.bookingStrategy || null,
    bookingSchedule: flags.bookingSchedule || null,
    lookAround: flags.lookAround || null,
    startDate: flags.startDate || null,
    endDate: flags.endDate || null,
    slotCheck: flags.slotCheck !== undefined ? flags.slotCheck : null,
    lineupGeneration: flags.lineupGeneration || null,
    lineupLeadTime: flags.lineupLeadTime || null,
    reminders: flags.reminders !== undefined ? flags.reminders : true,
    maxCourts: flags.maxCourts || null,
    '--max-courts': flags.maxCourts || null,
    'max-courts': flags.maxCourts || null,
    bookingCourtPreference: flags.bookingCourtPreference || null,
    timeSlots: extracted.timeSlots,
    multiVote: flags.multiVote !== undefined ? flags.multiVote : true,
    multiSessionMode: (flags.multiVote === false) ? 'single_session' : (flags.multiSessionMode || 'single_session'),
    title: flags.title !== undefined ? flags.title : null,
    group: flags.group || null
  };
}

module.exports = {
  extractJsonMap,
  extractCommonFlags,
  extractPauseArgs,
  extractSkipArgs,
  extractOverrideSlotsArgs,
  parseRecurringPollText
};
