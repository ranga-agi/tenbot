/**
 * SCVCC Natural-Language Command Parsers
 * Parses !courts, !courtbookings, !bookcourt, and !modifycourt command text.
 */

const namesStore = require('../names');
const { formatCourtLabel } = require('./utils');
const { normalizeCommandDashes } = require('../textNormalize');

const DATE_TOKEN_REGEX = /\b(today|tomorrow|tonight|monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tue|wed|thu|fri|sat|sun|\d{1,2}\/\d{1,2}(?:\/\d{2,4})?|\d{4}-\d{2}-\d{2})\b/i;
const EXPLICIT_DATE_REGEX = /\b(\d{1,2}\/\d{1,2}(?:\/\d{2,4})?|\d{4}-\d{2}-\d{2})\b/;

function extractSport(text, { allowAll = false } = {}) {
  let sport = 'tennis';
  if (/\b(?:pickleball|pickle|pb)\b/i.test(text)) {
    sport = 'pickleball';
    text = text.replace(/\b(?:pickleball|pickle|pb)\b/gi, '').trim();
  } else if (allowAll && /\ball\s*courts?\b/i.test(text)) {
    sport = 'all';
    text = text.replace(/\ball\s*courts?\b/gi, '').trim();
  }
  return { sport, text };
}

function extractCourt(text, { pattern = /\b(court\s*\d+|ct\s*\d+|pickleball\s*\d+|pb\s*\d+[ab]?)\b/i, normalize = false, replaceWith = '' } = {}) {
  let court = null;
  const match = text.match(pattern);
  if (match) {
    court = normalize ? formatCourtLabel(match[1]) : match[1];
    text = text.replace(match[0], replaceWith).trim();
  }
  return { court, text };
}

function extractTime(text, { allowPeriods = false, replaceWith = '' } = {}) {
  let isAround = false;
  let time = null;
  const regex = allowPeriods
    ? /(?:\b(around|about|approx|approximately|at|near|~)\s+)?(\d{1,2}(?::\d{2})?\s*(?:am|pm)|morning|afternoon|evening|night)\b/i
    : /(?:\b(around|about|approx|approximately|at|near|~)\s+)?(\d{1,2}(?::\d{2})?\s*(?:am|pm))\b/i;
  const match = text.match(regex);
  if (match) {
    if (match[1] && !/^(?:at)$/i.test(match[1])) {
      isAround = true;
    }
    time = match[2];
    text = text.replace(match[0], replaceWith).trim();
  }
  return { time, isAround, text };
}

function extractDuration(text) {
  let duration = null;
  const durMatch = text.match(/\b(30|60|90|120)\s*(?:min(?:utes?)?|hrs?|hours?|m)?\b/i);
  if (durMatch) {
    duration = `${durMatch[1]} Minutes`;
    text = text.replace(durMatch[0], '').trim();
  }
  return { duration, text };
}

function extractPartySize(text, defaultPartySize = null) {
  let partySize = defaultPartySize;
  if (/\bsingles\b/i.test(text)) {
    partySize = 'Singles';
    text = text.replace(/\bsingles\b/gi, '').trim();
  } else if (/\bdoubles\b/i.test(text)) {
    partySize = 'Doubles';
    text = text.replace(/\bdoubles\b/gi, '').trim();
  }
  return { partySize, text };
}

function extractPlayersClause(text) {
  let players = null;
  const withMatch = text.match(/\b(?:with|players?[:=]?)\s+([^\n\r]+)/i);
  if (withMatch) {
    players = withMatch[1].trim().split(/[,&+]|\band\b/i).map(p => p.trim()).filter(Boolean);
    text = text.replace(withMatch[0], '').trim();
  }
  return { players, text };
}

function extractForRequester(text) {
  let requester = null;
  const forMatch = text.match(/\bfor\s+([A-Za-z0-9_]+(?:\s+[A-Za-z0-9_]+)?)\b/i);
  if (forMatch && !/^(?:singles|doubles|tennis|pickleball|pb|today|tomorrow|tonight|\d+)\b/i.test(forMatch[1].trim())) {
    requester = forMatch[1].trim();
    text = text.replace(forMatch[0], '').trim();
  }
  return { requester, text };
}

function stripDatePrepositions(text, fallback = 'today') {
  return text.replace(/\b(?:on|for|at|around|about|in)\b/gi, '').trim() || fallback;
}

/**
 * Parses user command string for `!courts` or `!courtstatus`.
 * e.g. "!courts tomorrow evening Court 2 pb"
 */
function parseCourtsCommand(rawText) {
  let text = rawText.replace(/^!(?:courts?|courtstatus|courtavail(?:ability)?)\s*/i, '').trim();
  if (!text) {
    return { when: 'today', time: null, court: null, sport: 'tennis' };
  }

  let sport;
  ({ sport, text } = extractSport(text, { allowAll: true }));
  let court;
  ({ court, text } = extractCourt(text));
  let time, isAround;
  ({ time, isAround, text } = extractTime(text, { allowPeriods: true }));

  const when = stripDatePrepositions(text, 'today');
  return { when, time, court, sport, isAround };
}

/**
 * Parses user command string for `!bookcourt`.
 * e.g. "!bookcourt 6pm tomorrow Court 2 with Alice, Bob, Charlie"
 *      "!bookcourt 9am saturday Court 1 singles with John"
 *      "!bookcourt 6pm tomorrow Court 2 for Roger with Alice, Bob"
 */
function parseBookCourtCommand(rawText) {
  let text = rawText.replace(/^!(?:bookcourt|reservecourt|reserve\s*court|book\s*court|book|reserve)\s*/i, '').trim();
  if (!text) return null;

  let extractedPlayers;
  ({ players: extractedPlayers, text } = extractPlayersClause(text));
  let players = extractedPlayers || [];

  let requester;
  ({ requester, text } = extractForRequester(text));

  if (requester) {
    requester = namesStore.resolveFullName(requester);
  }
  if (players.length > 0) {
    players = players.map(p => namesStore.resolveFullName(p));
  }

  let sport;
  ({ sport, text } = extractSport(text));
  let partySize;
  ({ partySize, text } = extractPartySize(text, 'Doubles'));
  let duration;
  ({ duration, text } = extractDuration(text));
  let court;
  ({ court, text } = extractCourt(text));
  let time;
  ({ time, text } = extractTime(text));

  const when = stripDatePrepositions(text, 'today');
  return { when, time, court, duration, partySize, players, requester, sport };
}

/**
 * Parses user command to modify an existing court booking:
 * e.g. "!modifycourt 194617 Court 1"
 *      "!modifycourt 194617 7pm"
 *      "!modifycourt 194617 Court 1 7pm with Alice, Bob"
 *      "!modifycourt Court 2 to Court 1"
 *      "!modifycourt Court 2 tomorrow 6:30pm to Court 1 7pm"
 */
function parseModifyCourtCommand(rawText) {
  let text = normalizeCommandDashes(rawText || '').replace(/^!(?:modifycourtbooking|modifycourt|modifybooking|modifyreservation|updatecourtbooking|updatecourt|updatebooking|updatereservation)\s*/i, '').trim();
  if (!text) return null;

  // Extract group (e.g. --group="Bot-testing", -g "Bot-testing", for group "Bot-testing", in group "Bot-testing", group "Bot-testing")
  let group = null;
  const groupFlagMatch = text.match(
    /(?:--(?:group|group-name|target-group)(?:=|\s+)(?:"([^"]+)"|'([^']+)'|“([^”]+)”|([^\s]+))|-g(?:\s+|=)(?:"([^"]+)"|'([^']+)'|“([^”]+)”|([^\s]+))|\b(?:for|in)\s+group\s+(?:"([^"]+)"|'([^']+)'|“([^”]+)”|([^\s]+))|\bgroup\s*[:=]\s*(?:"([^"]+)"|'([^']+)'|“([^”]+)”|([^\s]+))|\bgroup\s+(?:"([^"]+)"|'([^']+)'|“([^”]+)”|([A-Za-z0-9_.-]+)))/i
  );
  if (groupFlagMatch) {
    const rawVal = groupFlagMatch.slice(1, 21).find(Boolean) || '';
    group = rawVal.trim().replace(/^["'“”‘’]|["'“”‘’]$/g, '').trim();
    text = text.replace(groupFlagMatch[0], ' ').trim();
  }

  let players;
  ({ players, text } = extractPlayersClause(text));
  let requester;
  ({ requester, text } = extractForRequester(text));
  let duration;
  ({ duration, text } = extractDuration(text));
  let partySize;
  ({ partySize, text } = extractPartySize(text, null));

  let reservationId = null;
  let court = null;
  let targetCourt = null;
  let time = null;
  let oldTime = null;
  let when = null;
  let date = null;
  let allCourtsForDay = false;

  const extractDateToken = (str) => {
    const m = str.match(DATE_TOKEN_REGEX);
    if (!m) return { day: null, text: str };
    return { day: m[1], text: str.replace(m[0], ' ').trim() };
  };

  const toSplitMatch = text.match(/\s+(?:to|->|=>)\s+(.*)$/i);
  if (toSplitMatch) {
    let beforeTo = text.slice(0, toSplitMatch.index).trim();
    let afterTo = toSplitMatch[1].trim();

    const afterCourtPattern = /\b(court\s*\d+|ct\s*\d+|pickleball\s*\d+|pb\s*#?\s*\d+|pb\s*\d+[ab]?)\b/i;
    const beforeCourtPattern = /\b(?:from\s+)?(court\s*\d+|ct\s*\d+|pickleball\s*\d+|pb\s*#?\s*\d+|pb\s*\d+[ab]?)\b/i;

    let newCourt;
    ({ court: newCourt, text: afterTo } = extractCourt(afterTo, { pattern: afterCourtPattern, normalize: true, replaceWith: ' ' }));
    let newTime;
    ({ time: newTime, text: afterTo } = extractTime(afterTo, { replaceWith: ' ' }));
    let newDate;
    ({ day: newDate, text: afterTo } = extractDateToken(afterTo));

    const idMatch = beforeTo.match(/^(?:id[:=]?\s*|res(?:ervation)?(?:id)?[:=]?\s*)?(\d{5,8})\b/i);
    if (idMatch) {
      reservationId = idMatch[1];
      beforeTo = beforeTo.slice(idMatch[0].length).trim();
    }

    let oldCourt;
    ({ court: oldCourt, text: beforeTo } = extractCourt(beforeTo, { pattern: beforeCourtPattern, normalize: true, replaceWith: ' ' }));
    ({ time: oldTime, text: beforeTo } = extractTime(beforeTo, { replaceWith: ' ' }));
    let oldDate;
    ({ day: oldDate, text: beforeTo } = extractDateToken(beforeTo));

    targetCourt = oldCourt || null;
    court = newCourt || oldCourt || null;
    time = newTime || null;
    when = newDate || oldDate || null;
    if (when) {
      const dMatch = when.match(EXPLICIT_DATE_REGEX);
      if (dMatch) date = dMatch[1];
    }

    if (!reservationId && !oldCourt && !newCourt && when) {
      allCourtsForDay = true;
    }
  } else {
    const idMatch = text.match(/^(?:id[:=]?\s*|res(?:ervation)?(?:id)?[:=]?\s*)?(\d{5,8})\b/i);
    if (idMatch) {
      reservationId = idMatch[1];
      text = text.slice(idMatch[0].length).trim();
    }

    const twoCourtsMatch = text.match(/\b(court\s*\d+|ct\s*\d+|pickleball\s*\d+|pb\s*\d+[ab]?)\b(?:\s+(?:to|->|=>)\s+|\s+)\b(court\s*\d+|ct\s*\d+|pickleball\s*\d+|pb\s*\d+[ab]?)\b/i);
    if (twoCourtsMatch) {
      targetCourt = formatCourtLabel(twoCourtsMatch[1]);
      court = formatCourtLabel(twoCourtsMatch[2]);
      text = text.replace(twoCourtsMatch[0], '').trim();
    } else {
      ({ court, text } = extractCourt(text, { normalize: true }));
    }

    ({ time, text } = extractTime(text));

    when = stripDatePrepositions(text, null);
    if (when) {
      const dMatch = when.match(EXPLICIT_DATE_REGEX);
      if (dMatch) date = dMatch[1];
    }
  }

  return { reservationId, court, targetCourt, time, oldTime, when, date, duration, partySize, players, requester, group, allCourtsForDay };
}

/**
 * Parses user command string for `!courtbookings` or `!bookings`.
 * e.g. "!courtbookings tomorrow evening"
 *      "!bookings tomorrow 6pm Court 2"
 *      "!bookings for Pramod tomorrow"
 */
function parseBookingsCommand(rawText) {
  let text = rawText.replace(/^!(?:courtbookings?|bookings?|courtreservations?|reservations?|courtsschedule|courtschedule)\s*/i, '').trim();
  if (!text) {
    return { when: 'today', time: null, court: null, sport: 'tennis', player: null };
  }

  let sport;
  ({ sport, text } = extractSport(text, { allowAll: true }));
  let court;
  ({ court, text } = extractCourt(text));
  let time, isAround;
  ({ time, isAround, text } = extractTime(text, { allowPeriods: true }));

  let player = null;
  const playerMatch = text.match(/\b(?:for|player|member|by)\s+([A-Za-z0-9_]+(?:\s+[A-Za-z0-9_]+)?)\b/i);
  if (playerMatch && !/^(?:today|tomorrow|tonight|morning|afternoon|evening|night|tennis|pickleball|pb|doubles|singles)$/i.test(playerMatch[1].trim())) {
    player = playerMatch[1].trim();
    text = text.replace(playerMatch[0], '').trim();
  }

  const when = stripDatePrepositions(text, 'today');
  return { when, time, court, sport, player, isAround };
}

module.exports = {
  parseCourtsCommand,
  parseBookCourtCommand,
  parseModifyCourtCommand,
  parseBookingsCommand
};
