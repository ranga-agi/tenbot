/**
 * SCVCC Date/Time, Court Label, Player Matching & Message Formatting Helpers
 */

const { getSanJoseParts, parseTimeString, resolvePlayDateTime } = require('../pollTime');
const namesStore = require('../names');
const groupsConfig = require('../groupsConfig');
const courtsConfig = require('../courtsConfig');
const { resolveCourtConfigName } = require('./config');

/**
 * Resolves loosely given date strings (e.g. "today", "tomorrow", "Saturday", "9/26/2026", "9/26")
 * to a standardized M/D/YYYY string in San Jose (Pacific Time).
 */
function resolveDateToMDY(whenStr) {
  if (whenStr instanceof Date && !isNaN(whenStr.getTime())) {
    const parts = getSanJoseParts(whenStr);
    return `${parts.month + 1}/${parts.day}/${parts.year}`;
  }
  const now = new Date();
  const sjNow = getSanJoseParts(now);

  if (!whenStr || typeof whenStr !== 'string') {
    return `${sjNow.month + 1}/${sjNow.day}/${sjNow.year}`;
  }

  const clean = whenStr.trim().toLowerCase();
  if (clean === 'today' || clean === 'tonight') {
    return `${sjNow.month + 1}/${sjNow.day}/${sjNow.year}`;
  }
  if (/\btomorrow\b/i.test(clean)) {
    const tm = new Date(Date.UTC(sjNow.year, sjNow.month, sjNow.day + 1));
    return `${tm.getUTCMonth() + 1}/${tm.getUTCDate()}/${tm.getUTCFullYear()}`;
  }
  if (/\b(?:today|tonight)\b/i.test(clean)) {
    return `${sjNow.month + 1}/${sjNow.day}/${sjNow.year}`;
  }

  // Check explicit MM/DD/YYYY or M/D/YY or M/D
  const mdyMatch = clean.match(/^(\d{1,2})[\/\-](\d{1,2})(?:[\/\-](\d{2,4}))?$/);
  if (mdyMatch) {
    const m = parseInt(mdyMatch[1], 10);
    const d = parseInt(mdyMatch[2], 10);
    let y = mdyMatch[3] ? parseInt(mdyMatch[3], 10) : sjNow.year;
    if (y < 100) y += 2000;
    return `${m}/${d}/${y}`;
  }

  // Clean prepositions (e.g. "on tuesday", "for tuesday", "around tuesday")
  const cleanWhen = clean.replace(/\b(?:on|for|at|around|about|in)\b/gi, ' ').trim();

  // Fallback to resolvePlayDateTime
  const resolvedDate = resolvePlayDateTime(cleanWhen || whenStr, null, now);
  if (resolvedDate && resolvedDate instanceof Date && !isNaN(resolvedDate.getTime())) {
    const parts = getSanJoseParts(resolvedDate);
    return `${parts.month + 1}/${parts.day}/${parts.year}`;
  }

  return `${sjNow.month + 1}/${sjNow.day}/${sjNow.year}`;
}

/**
 * Formats M/D/YYYY into friendly display format, e.g. "Saturday, Sep 26, 2026".
 */
function formatDisplayDate(mdyStr) {
  const [m, d, y] = mdyStr.split('/').map((n) => parseInt(n, 10));
  const dt = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
  return dt.toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC'
  });
}

/**
 * Normalizes a time string to match the grid time format (e.g. "7pm" -> "7:00 PM", "9:30am" -> "9:30 AM").
 */
function normalizeGridTime(timeStr) {
  if (!timeStr) return null;
  const parsed = parseTimeString(timeStr);
  if (!parsed) return null;
  const m = String(parsed.minute).padStart(2, '0');
  const h = parsed.hour === 0 ? 12 : (parsed.hour > 12 ? parsed.hour - 12 : parsed.hour);
  const ampm = parsed.hour >= 12 ? 'PM' : 'AM';
  return `${h}:${m} ${ampm}`;
}

/**
 * Helper to normalize court labels (e.g. "2" -> "Court 2", "court 2" -> "Court 2").
 */
function formatCourtLabel(court) {
  if (!court) return 'Court';
  const str = String(court).trim();
  if (/^court\s*\d+/i.test(str)) {
    return str.replace(/^court\s*/i, 'Court ');
  }
  if (/^\d+$/.test(str)) {
    return `Court ${str}`;
  }
  return str;
}

/**
 * Retrieves the set of direct court booking accounts configured in groups.json.
 */
function getDirectCourtBookingAccounts(chatId = null) {
  return groupsConfig.getDirectCourtBookingAccounts(chatId);
}

/**
 * Checks if a court is configured to be ignored in config/courts.json (or .env fallback).
 */
function isIgnoredCourt(courtName, chatIdOrVenue = null) {
  const configName = resolveCourtConfigName(chatIdOrVenue);
  return courtsConfig.isIgnoredCourt(courtName, configName || 'SCVCC');
}

/**
 * Checks if a group member's LID (or phone number) matches any of the direct booking user LIDs.
 */
function isDirectBookingUser(member, chatId = null) {
  if (!member) return false;
  const directAccounts = getDirectCourtBookingAccounts(chatId);
  if (directAccounts.size === 0) return false;

  const id = (member.id || '').toLowerCase();
  const idNum = id.split('@')[0];
  const pn = (member.pn || '').toLowerCase();
  const pnNum = pn.split('@')[0];
  const full = (member.fullName || '').toLowerCase().trim();
  const disp = (member.name || '').toLowerCase().trim();

  return directAccounts.has(id) ||
    directAccounts.has(idNum) ||
    (pn && (directAccounts.has(pn) || directAccounts.has(pnNum))) ||
    (full && directAccounts.has(full)) ||
    (disp && directAccounts.has(disp));
}

/**
 * Formats a player name from "Lastname, Firstname" to "Firstname Lastname".
 */
function formatPlayerNameFirstLast(name) {
  if (!name || typeof name !== 'string') return name;
  const trimmed = name.trim();
  if (trimmed.includes(',')) {
    const parts = trimmed.split(',').map(s => s.trim()).filter(Boolean);
    if (parts.length >= 2) {
      const last = parts[0];
      const first = parts.slice(1).join(' ');
      return `${first} ${last}`;
    }
  }
  return trimmed;
}

/**
 * Checks if a player name is a placeholder (TBD, Blocked, Guest TBA, etc.).
 */
function isPlaceholderPlayer(name) {
  if (!name) return true;
  const c = name.trim().toLowerCase();
  return !c || c === 'tbd' || c === 'blocked' || c.includes('guest tba');
}

/**
 * Obtains a clean short display name for a member (e.g. "Conrad", "PI", "Vijay").
 */
function getPlayerShortName(entry) {
  if (!entry) return '';
  const name = entry.name || entry.fullName || '';
  const words = name.trim().split(/\s+/);
  return words.length > 1 ? words[0] : name.trim();
}

function isMemberMatch(name, mName) {
  if (!name || !mName) return false;
  const nParts = name.toLowerCase().replace(/[^a-z0-9]/g, ' ').split(/\s+/).filter(Boolean).sort().join(' ');
  const mParts = mName.toLowerCase().replace(/[^a-z0-9]/g, ' ').split(/\s+/).filter(Boolean).sort().join(' ');
  return nParts === mParts;
}

/**
 * Matches an SCVCC player name to a group member entry in namesStore.
 */
function matchScvccPlayerToGroupMember(scvccPlayerName, chatId = null) {
  if (!scvccPlayerName) return null;
  const clean = scvccPlayerName.trim().toLowerCase();
  if (!clean || isPlaceholderPlayer(clean)) return null;

  const allEntries = namesStore.getAllEntries(chatId);

  const findByFullOrDisplay = (target) => {
    for (const entry of allEntries) {
      const full = (entry.fullName || '').trim().toLowerCase();
      if (full && target === full) return entry;
      const disp = (entry.name || '').trim().toLowerCase();
      if (disp && target === disp) return entry;
    }
    return null;
  };

  // 1. Exact full name or display name match
  const exactMatch = findByFullOrDisplay(clean);
  if (exactMatch) return exactMatch;

  // 2. Handle "Last, First" format from SCVCC (e.g. "Cheruku, Chandra", "Rodricks, Conrad")
  if (clean.includes(',')) {
    const [last, first] = clean.split(',').map((s) => s.trim());
    if (first && last) {
      const reorderedMatch = findByFullOrDisplay(`${first} ${last}`.toLowerCase());
      if (reorderedMatch) return reorderedMatch;
    }
  }

  // 3. First and last name match
  const scvccWords = clean.replace(/,/g, ' ').split(/[^a-z0-9]+/i).filter(Boolean);
  if (scvccWords.length >= 2) {
    const scvccFirst = scvccWords[0];
    const scvccLast = scvccWords[scvccWords.length - 1];

    for (const entry of allEntries) {
      const full = (entry.fullName || '').trim().toLowerCase();
      if (full) {
        const fullWords = full.split(/[^a-z0-9]+/i).filter(Boolean);
        if (fullWords.length >= 2) {
          if ((scvccFirst === fullWords[0] && scvccLast === fullWords[fullWords.length - 1]) ||
              (scvccFirst === fullWords[fullWords.length - 1] && scvccLast === fullWords[0])) {
            return entry;
          }
        }
      }
    }
  }

  // 4. Fallback to findIdByNameOrAlias
  const byAlias = namesStore.findIdByNameOrAlias(scvccPlayerName, chatId);
  if (byAlias && byAlias.entry) {
    return byAlias.entry;
  }

  return null;
}

/**
 * Detects if an SCVCC court booking is a prebooked court for this group.
 */
function detectPrebookedCourt(booking, chatId = null) {
  if (!booking || !Array.isArray(booking.players)) return null;
  if (isIgnoredCourt(booking.court, chatId)) return null;

  // Filter out TBD or blocked placeholders to inspect real players
  const actualPlayers = booking.players.filter((p) => !isPlaceholderPlayer(p));
  if (actualPlayers.length === 0) return null;

  let directBookingMember = null;
  let allMembers = true;
  const matchedMembers = [];

  for (const p of actualPlayers) {
    const member = matchScvccPlayerToGroupMember(p, chatId);
    if (member) {
      matchedMembers.push(member);
      if (isDirectBookingUser(member, chatId) && !directBookingMember) {
        directBookingMember = member;
      }
    } else {
      allMembers = false;
    }
  }

  // 1. If any direct booking user appears in the booking, or 2. ALL players are members of this group
  const ownerMember = directBookingMember || (allMembers && matchedMembers.length > 0 ? matchedMembers[0] : null);
  if (!ownerMember) return null;

  return {
    isPrebooked: true,
    player: getPlayerShortName(ownerMember),
    fullName: ownerMember.fullName || ownerMember.name,
    member: ownerMember
  };
}

function getBookingTitleCandidates(entry) {
  if (!entry || typeof entry !== 'object') return [];
  return [entry.clubClosedTitle, entry.blockTitle, entry.title, entry.type, entry.rawText].filter(
    (v) => typeof v === 'string' && v.trim()
  );
}

function findMatchingClosedTitle(title, chatId = null) {
  if (!title) return null;
  const trimmed = String(title).trim();
  if (!trimmed) return null;
  if (typeof groupsConfig.isClubClosedTitle === 'function' && groupsConfig.isClubClosedTitle(trimmed, chatId)) {
    return trimmed;
  }
  return null;
}

/**
 * Detects if the club is closed at a given time based on availability/bookings responses
 * and group-configured `clubClosedTitles`.
 */
function detectClubClosed({ avail = null, bookingsRes = null, time = null, chatId = null } = {}) {
  const normTargetTime = time ? normalizeGridTime(time) : null;
  const matchesSlotTime = (candidateTime) => {
    if (!normTargetTime || !candidateTime) return true;
    const normCand = normalizeGridTime(candidateTime);
    if (normCand && normTargetTime) return normCand === normTargetTime;
    return String(candidateTime).trim().toLowerCase() === String(time).trim().toLowerCase();
  };

  if (avail) {
    let matchedSlots = [];
    if (Array.isArray(avail.slots)) {
      matchedSlots = avail.slots.filter((s) => s && matchesSlotTime(s.time));
      for (const slot of matchedSlots) {
        if (slot.clubClosed) {
          return { clubClosed: true, title: slot.clubClosedTitle || avail.clubClosedTitle || null };
        }
        if (Array.isArray(slot.courts)) {
          for (const c of slot.courts) {
            if (!c) continue;
            if (c.clubClosed) {
              return { clubClosed: true, title: c.clubClosedTitle || c.blockTitle || c.title || null };
            }
            for (const cand of getBookingTitleCandidates(c)) {
              const matched = findMatchingClosedTitle(cand, chatId);
              if (matched) {
                return { clubClosed: true, title: matched };
              }
            }
          }
        }
      }
    }
    if (avail.clubClosed && (matchedSlots.length === 0 || !matchedSlots.every((s) => s.clubClosed === false))) {
      return { clubClosed: true, title: avail.clubClosedTitle || null };
    }
  }

  if (bookingsRes) {
    let matchedBookings = [];
    if (Array.isArray(bookingsRes.bookings)) {
      matchedBookings = bookingsRes.bookings.filter((b) => b && matchesSlotTime(b.time));
      for (const b of matchedBookings) {
        if (b.clubClosed) {
          return { clubClosed: true, title: b.clubClosedTitle || b.blockTitle || b.title || b.type || null };
        }
        for (const cand of getBookingTitleCandidates(b)) {
          const matched = findMatchingClosedTitle(cand, chatId);
          if (matched) {
            return { clubClosed: true, title: matched };
          }
        }
      }
    }
    if (bookingsRes.clubClosed && (matchedBookings.length === 0 || !matchedBookings.every((b) => b.clubClosed === false))) {
      return { clubClosed: true, title: bookingsRes.clubClosedTitle || null };
    }
  }

  return { clubClosed: false, title: null };
}

/**
 * Builds a short booking summary message reporting the number of courts booked.
 */
function buildBookingSummaryMessage({
  targetDateMDY,
  queryTime,
  sport = 'tennis',
  targetCourtsCount = 1,
  advanceBookedCourts = [],
  prebookedCourts = [],
  isExhausted = false,
  clubClosed = false,
  clubClosedTitle = null
}) {
  const displayDate = formatDisplayDate(targetDateMDY);
  const botCourts = Array.isArray(advanceBookedCourts) ? advanceBookedCourts : [];
  const botCourtNames = new Set(botCourts.map((b) => b.court?.toLowerCase().trim()).filter(Boolean));

  const manualBookings = Array.isArray(prebookedCourts)
    ? prebookedCourts.filter((pb) => pb.court && !botCourtNames.has(pb.court.toLowerCase().trim()))
    : [];

  const bookedCount = botCourts.length + manualBookings.length;
  const isAllBooked = bookedCount >= targetCourtsCount && targetCourtsCount > 0;
  const isPickleball = (sport || '').toLowerCase() === 'pickleball';
  const sportEmoji = isPickleball ? '🏓' : '🎾';

  const courtWord = targetCourtsCount === 1 ? 'court' : 'courts';
  const retrySuffix = isExhausted ? ' (10-min retries exhausted)' : '';
  let statusLine;
  if (clubClosed && bookedCount === 0) {
    statusLine = `🚫 *Club Closed:* ${clubClosedTitle || 'Club is closed during this time'} (no courts booked)`;
  } else if (isAllBooked) {
    statusLine = `✅ *Courts Booked:* ${bookedCount} of ${targetCourtsCount} ${courtWord} successfully`;
  } else if (bookedCount > 0) {
    statusLine = `⚠️ *Courts Booked:* ${bookedCount} of ${targetCourtsCount} ${courtWord}${retrySuffix}`;
  } else {
    statusLine = `❌ *Courts Booked:* 0 of ${targetCourtsCount} ${courtWord}${retrySuffix}`;
  }

  const lines = [
    `📋 *Court Booking Summary*`,
    `📅 *Date:* ${displayDate} at ${queryTime}`,
    `${sportEmoji} *Sport:* ${isPickleball ? 'Pickleball' : 'Tennis'}`,
    statusLine
  ];

  if (botCourts.length > 0 || manualBookings.length > 0) {
    lines.push('');
    botCourts.forEach((b) => {
      const durStr = b.duration ? ` (${b.partySize || 'Doubles'}, ${b.duration})` : '';
      const resStr = b.reservationId ? ` — ID: \`${b.reservationId}\`` : '';
      lines.push(`• *${b.court}* (auto booked)${durStr}${resStr}`);
    });
    manualBookings.forEach((pb) => {
      const byStr = pb.player || pb.fullName ? ` (manually booked by ${pb.player || pb.fullName})` : ' (manually booked)';
      lines.push(`• *${pb.court}*${byStr}`);
    });
  }

  if (!isAllBooked && isExhausted && !clubClosed) {
    lines.push('');
    const remaining = Math.max(0, targetCourtsCount - bookedCount);
    lines.push(`⚠️ *Notice:* 1-hour retry window has expired. ${remaining} ${remaining === 1 ? 'court' : 'courts'} could not be secured.`);
  }

  return lines.join('\n');
}

module.exports = {
  resolveDateToMDY,
  formatDisplayDate,
  normalizeGridTime,
  formatCourtLabel,
  getDirectCourtBookingAccounts,
  isIgnoredCourt,
  isDirectBookingUser,
  formatPlayerNameFirstLast,
  isPlaceholderPlayer,
  getPlayerShortName,
  isMemberMatch,
  matchScvccPlayerToGroupMember,
  detectPrebookedCourt,
  detectClubClosed,
  buildBookingSummaryMessage
};
