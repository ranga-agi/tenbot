/**
 * SCVCC Court Sheet Scraping & Read Queries
 * Parses court availability grids, bookings tables, and upcoming member reservations.
 */

const { parseTimeString } = require('../pollTime');
const groupsConfig = require('../groupsConfig');
const { getScvccUrls, ALL_COURT_DEFINITIONS } = require('./config');
const { authFetch } = require('./auth');
const facade = require('./facade');
const {
  resolveDateToMDY,
  formatDisplayDate,
  normalizeGridTime,
  isIgnoredCourt,
  detectPrebookedCourt
} = require('./utils');

function findByNormalizedCourtName(map, courtName) {
  if (map.has(courtName)) {
    return { key: courtName, value: map.get(courtName) };
  }
  const normTarget = courtName.toLowerCase().replace(/\s+/g, '');
  for (const [k, v] of map.entries()) {
    if (k.toLowerCase().replace(/\s+/g, '') === normTarget) {
      return { key: k, value: v };
    }
  }
  return null;
}

/**
 * Extracts raw cell metadata from a single <td> in the SCVCC court grid table.
 */
function parseGridTdCell(td, chatId = null, { fallbackPlayerInnerText = false } = {}) {
  if (td.includes('tscell')) return null;
  const courtMatch = td.match(/<div class="ncCourtNum"[^>]*>([\s\S]*?)<\/div>/i);
  if (!courtMatch) return null;

  const courtName = courtMatch[1].replace(/<[^>]+>/g, '').trim();
  const isAvail = td.includes('rbm_TimeSlotPanelSlotAvailable');
  const rowspanMatch = td.match(/rowspan=["']?(\d+)["']?/i);
  const rowspan = rowspanMatch ? parseInt(rowspanMatch[1], 10) : 1;
  const durationMins = rowspan * 30;

  const imgTitleMatch = td.match(/<img[^>]*title=["']([^"']+)["']/i);
  const imgTitle = imgTitleMatch ? imgTitleMatch[1].trim() : null;
  const blockTitleMatch = td.match(/<div class=["']blockTitle["'][^>]*>([\s\S]*?)<\/div>/i);
  const rawBlockTitle = blockTitleMatch ? blockTitleMatch[1].replace(/<[^>]+>/g, '').trim() : null;

  let players = [];
  if (!isAvail) {
    const playerMatches = td.match(/<div class="playerName"[^>]*title=["']([^"']+)["'][^>]*>([\s\S]*?)<\/div>/gi) || [];
    for (const pm of playerMatches) {
      const titleMatch = pm.match(/title=["']([^"']+)["']/i);
      if (titleMatch) {
        players.push(titleMatch[1].trim());
      }
    }
    if (fallbackPlayerInnerText && players.length === 0) {
      const rawDivs = td.match(/<div class="playerName"[^>]*>([\s\S]*?)<\/div>/gi) || [];
      for (const rd of rawDivs) {
        const stripped = rd.replace(/<[^>]+>/g, '').trim();
        if (stripped) players.push(stripped);
      }
    }
  }

  const resIdMatch = td.match(/LaunchrbEditor\([^,]+,[^,]+,["']?(\d+)["']?\)/i) ||
                     td.match(/id=["']infoSection(\d+)["']/i);
  const resId = resIdMatch ? resIdMatch[1] : null;
  const isBlockedClass = td.includes('openResSectionBlocked') || td.includes('Blocked');

  const prebookedMatch = !isAvail
    ? (facade.call('detectPrebookedCourt', detectPrebookedCourt))({ court: courtName, players }, chatId)
    : null;

  return {
    courtName,
    isAvail,
    rowspan,
    durationMins,
    imgTitle,
    rawBlockTitle,
    players,
    resId,
    isBlockedClass,
    prebookedMatch
  };
}

/**
 * Parses SCVCC court sheet table HTML into a complete 30-minute schedule.
 */
function parseCourtGridHtml(html, chatId = null) {
  const trMatches = html.match(/<tr[^>]*>([\s\S]*?)<\/tr>/gi) || [];
  const results = [];
  const activeSpans = new Map(); // courtName -> { status, remaining }

  for (const tr of trMatches) {
    const timeMatch = tr.match(/<div class="tscell">([\s\S]*?)<\/div>/i);
    if (!timeMatch) continue;
    const time = timeMatch[1].trim();

    const tds = tr.match(/<td[^>]*>([\s\S]*?)<\/td>/gi) || [];
    const courtStatusMap = new Map();

    for (const td of tds) {
      const cell = parseGridTdCell(td, chatId, { fallbackPlayerInnerText: true });
      if (!cell) continue;

      let blockTitle = cell.rawBlockTitle;
      if (!blockTitle && cell.imgTitle && !/^(?:spacer|transparent|bullet|icon|singles|doubles)$/i.test(cell.imgTitle)) {
        blockTitle = cell.imgTitle;
      }

      let status = cell.isAvail ? 'available' : (blockTitle ? 'booked' : 'unavailable');
      let prebookedBy = null;
      let prebookedFullName = null;

      if (!cell.isAvail) {
        if (cell.prebookedMatch) {
          status = 'prebooked';
          prebookedBy = cell.prebookedMatch.player;
          prebookedFullName = cell.prebookedMatch.fullName;
        } else if (cell.players.length > 0 || (blockTitle && blockTitle.trim())) {
          status = 'booked';
        }
      }

      const courtInfo = {
        status,
        prebookedBy,
        prebookedFullName,
        prebookedPlayers: cell.players,
        durationMins: cell.durationMins,
        totalDurationMins: cell.durationMins,
        remainingMins: cell.durationMins,
        blockTitle
      };
      courtStatusMap.set(cell.courtName, courtInfo);

      if (cell.rowspan > 1) {
        activeSpans.set(cell.courtName, {
          ...courtInfo,
          remaining: cell.rowspan - 1
        });
      } else {
        activeSpans.delete(cell.courtName);
      }
    }

    // Fill in all defined courts for this time slot
    const slotCourts = [];
    for (const def of ALL_COURT_DEFINITIONS) {
      const infoEntry = findByNormalizedCourtName(courtStatusMap, def.name);
      const spanEntry = !infoEntry ? findByNormalizedCourtName(activeSpans, def.name) : null;
      const source = infoEntry?.value || spanEntry?.value || null;

      let status = 'unavailable';
      let prebookedBy = null;
      let prebookedFullName = null;
      let prebookedPlayers = [];
      let durationMins = null;
      let remainingMins = null;
      let totalDurationMins = null;
      let blockTitle = null;

      if (infoEntry) {
        status = source.status;
        prebookedBy = source.prebookedBy;
        prebookedFullName = source.prebookedFullName;
        prebookedPlayers = source.prebookedPlayers;
        durationMins = source.durationMins;
        remainingMins = source.remainingMins || source.durationMins;
        totalDurationMins = source.totalDurationMins || source.durationMins;
        blockTitle = source.blockTitle || null;
      } else if (spanEntry) {
        status = source.status;
        prebookedBy = source.prebookedBy;
        prebookedFullName = source.prebookedFullName;
        prebookedPlayers = source.prebookedPlayers;
        remainingMins = Math.max(1, source.remaining) * 30;
        durationMins = remainingMins;
        totalDurationMins = source.totalDurationMins || source.durationMins;
        blockTitle = source.blockTitle || null;
        source.remaining--;
        if (source.remaining <= 0) {
          activeSpans.delete(spanEntry.key);
        }
      }

      slotCourts.push({
        court: def.name,
        resourceId: def.id,
        resourceType: def.type,
        status,
        prebookedBy,
        prebookedFullName,
        prebookedPlayers,
        durationMins,
        remainingMins,
        totalDurationMins,
        blockTitle,
        time
      });
    }

    results.push({ time, courts: slotCourts });
  }

  return results;
}

/**
 * Calculates consecutive available duration in minutes for a given court starting from a specific slot index.
 */
function isSportRelevantCourtName(cName, normalizedSport) {
  if (!cName) return false;
  const cLower = cName.toLowerCase();
  if (normalizedSport === 'pickleball' || normalizedSport === 'pb') {
    return cLower.includes('pickleball') || cLower.includes('pb');
  }
  if (normalizedSport === 'tennis') {
    return !cLower.includes('pickleball');
  }
  return true;
}

function getSlotClubClosedInfo(slot, normalizedSport = 'tennis', chatId = null) {
  if (!slot || !Array.isArray(slot.courts)) return { clubClosed: false, clubClosedTitle: null };
  for (const c of slot.courts) {
    if (!c || !c.court) continue;
    if (isIgnoredCourt(c.court, chatId)) continue;
    if (!isSportRelevantCourtName(c.court, normalizedSport)) continue;
    const title = c.blockTitle || c.title || null;
    if (title && typeof groupsConfig.isClubClosedTitle === 'function' && groupsConfig.isClubClosedTitle(title, chatId)) {
      return { clubClosed: true, clubClosedTitle: title };
    }
  }
  return { clubClosed: false, clubClosedTitle: null };
}

function calculateAvailabilityDuration(fullGrid, startIdx, courtName, { allowOverride = false, closedSlotIndices = null } = {}) {
  let consecutiveSlots = 0;
  for (let j = startIdx; j < fullGrid.length; j++) {
    if (closedSlotIndices && closedSlotIndices.has(j)) break;
    if (fullGrid[j]?.clubClosed) break;
    const match = fullGrid[j]?.courts?.find((c) => c.court === courtName);
    if (!match || match.clubClosed) break;

    let isUsable = false;
    if (match.status === 'available') {
      isUsable = true;
    } else if (allowOverride) {
      const hasTitle = Boolean(match.blockTitle && match.blockTitle.trim());
      const hasPlayers = (Array.isArray(match.prebookedPlayers) && match.prebookedPlayers.length > 0) ||
                         (Array.isArray(match.players) && match.players.length > 0);
      const isPrebooked = match.status === 'prebooked';
      if (!hasTitle && !hasPlayers && !isPrebooked) {
        isUsable = true;
      }
    }

    if (isUsable) {
      consecutiveSlots++;
    } else {
      break;
    }
  }
  const totalMinutes = consecutiveSlots * 30;
  const durationLabel = totalMinutes > 90 ? '90 minutes +' : `${totalMinutes} minutes`;
  return { minutes: totalMinutes, durationLabel };
}

/**
 * Shared query parameter normalization for court sheet queries.
 */
function normalizeSheetQueryFilters({ when = 'today', time = null, court = null, sport = 'tennis', isAround = false, chatId = null } = {}) {
  let targetWhen = when || 'today';
  let targetTime = time;
  let targetIsAround = Boolean(isAround);

  if (!targetTime && targetWhen) {
    const timeMatch = targetWhen.match(/(?:\b(around|about|approx|approximately|at|near|~)\s+)?(\d{1,2}(?::\d{2})?\s*(?:am|pm)|morning|afternoon|evening|night)\b/i);
    if (timeMatch) {
      if (timeMatch[1] && !/^(?:at)$/i.test(timeMatch[1])) {
        targetIsAround = true;
      }
      targetTime = timeMatch[2];
      targetWhen = targetWhen.replace(timeMatch[0], '').replace(/\b(?:on|for|at|around|about|in)\b/gi, '').trim() || 'today';
    }
  }

  return {
    targetWhen,
    targetTime,
    targetIsAround,
    normalizedSport: (sport || 'tennis').toLowerCase(),
    targetColFilter: court ? court.trim().toLowerCase() : null,
    chatId
  };
}

function createCourtRelevanceFilter(targetColFilter, normalizedSport, chatId) {
  return (cName) => {
    if (isIgnoredCourt(cName, chatId)) return false;
    const cLower = cName.toLowerCase();
    if (targetColFilter) {
      return cLower === targetColFilter || cLower.includes(targetColFilter);
    }
    if (normalizedSport === 'pickleball' || normalizedSport === 'pb') {
      return cLower.includes('pickleball') || cLower.includes('pb');
    }
    if (normalizedSport === 'tennis') {
      return !cLower.includes('pickleball');
    }
    return true;
  };
}

function createTimeRelevanceFilter(targetTime, targetIsAround = false) {
  const targetTimeExact = targetTime ? normalizeGridTime(targetTime) : null;
  const targetTimeLower = targetTime ? targetTime.trim().toLowerCase() : null;
  let targetTimeMinutes = null;
  if (targetTime) {
    const parsedT = parseTimeString(targetTime);
    if (parsedT) targetTimeMinutes = parsedT.hour * 60 + parsedT.minute;
  }

  return {
    targetTimeExact,
    isRelevantTime: (tStr) => {
      if (targetTimeExact && !targetIsAround) {
        return tStr.toLowerCase().replace(/\s+/g, '') === targetTimeExact.toLowerCase().replace(/\s+/g, '');
      }
      if (targetTimeMinutes !== null && targetIsAround) {
        const slotT = parseTimeString(tStr);
        if (slotT) {
          const slotMins = slotT.hour * 60 + slotT.minute;
          return Math.abs(slotMins - targetTimeMinutes) <= 60;
        }
      }
      if (!targetTimeLower) return true;
      if (targetTimeLower.includes('morning') || targetTimeLower === 'am') {
        return tStr.includes('AM');
      }
      if (targetTimeLower.includes('afternoon')) {
        return /^(?:12|1|2|3|4):[0-5]\d PM/.test(tStr);
      }
      if (targetTimeLower.includes('evening') || targetTimeLower.includes('night') || targetTimeLower === 'pm') {
        return /^(?:5|6|7|8|9|10):[0-5]\d PM/.test(tStr);
      }
      const cleanT = tStr.toLowerCase().replace(/\s+/g, '');
      const cleanReq = targetTimeLower.replace(/\s+/g, '');
      return cleanT.includes(cleanReq);
    }
  };
}

function isUntitledBlockedCourt(c) {
  if (c.status === 'available' || c.status === 'prebooked') return false;
  const hasTitle = Boolean(c.blockTitle && c.blockTitle.trim());
  const hasPlayers = (Array.isArray(c.prebookedPlayers) && c.prebookedPlayers.length > 0) ||
                     (Array.isArray(c.players) && c.players.length > 0);
  return !hasTitle && !hasPlayers;
}

function partitionAndSortSlotCourts(courts, { slotClubClosed = false } = {}) {
  if (slotClubClosed) {
    return { availableCourts: [], prebookedCourtsList: [], blockedCourtsList: [] };
  }
  const availableCourts = courts
    .filter((c) => c.status === 'available' && !c.clubClosed)
    .sort((a, b) => b.availableMinutes - a.availableMinutes || a.court.localeCompare(b.court));
  const prebookedCourtsList = courts
    .filter((c) => c.status === 'prebooked' && !c.clubClosed)
    .sort((a, b) => a.court.localeCompare(b.court));
  const blockedCourtsList = courts
    .filter(isUntitledBlockedCourt)
    .sort((a, b) => (b.overrideAvailableMinutes || 0) - (a.overrideAvailableMinutes || 0) || a.court.localeCompare(b.court));
  return { availableCourts, prebookedCourtsList, blockedCourtsList };
}

function formatPrebookedCourtDetails(c) {
  const details = [];
  if (c.prebookedBy) details.push(c.prebookedBy);
  if (c.durationMins && c.durationMins > 0) details.push(`${c.durationMins}m`);
  return details.length > 0 ? `: ${details.join(', ')}` : '';
}

/**
 * Queries court status & availability at SCVCC for a given day and optional filters.
 */
async function checkCourtAvailability({ when, time = null, court = null, sport = 'tennis', isAround = false, prebookedCourts = [], chatId = null } = {}) {
  const filters = normalizeSheetQueryFilters({ when, time, court, sport, isAround, chatId });
  const targetWhen = filters.targetWhen.replace(/\b(?:on|for|at|around|about|in)\b/gi, '').trim() || 'today';
  const { targetTime, targetIsAround, normalizedSport, targetColFilter } = filters;

  const targetDateMDY = resolveDateToMDY(targetWhen);
  const displayDate = formatDisplayDate(targetDateMDY);

  if (chatId && !groupsConfig.isCourtBookingEnabled(chatId)) {
    return {
      success: false,
      date: targetDateMDY,
      displayDate,
      totalAvailable: 0,
      totalPrebooked: 0,
      slots: [],
      message: '⚠️ Court availability is not enabled for this group.'
    };
  }

  if (targetColFilter && isIgnoredCourt(targetColFilter, chatId)) {
    return {
      success: true,
      date: targetDateMDY,
      displayDate,
      totalAvailable: 0,
      totalPrebooked: 0,
      slots: [],
      message: `⚠️ *${court}* is being ignored for checking availability.`
    };
  }

  const isRelevantCourt = createCourtRelevanceFilter(targetColFilter, normalizedSport, chatId);
  const { targetTimeExact, isRelevantTime } = createTimeRelevanceFilter(targetTime, targetIsAround);

  // Single GET request to retrieve full day sheet
  const urls = getScvccUrls(chatId);
  const url = `${urls.bookingPageUrl}&date=${encodeURIComponent(targetDateMDY)}`;
  const res = await (facade.call('authFetch', authFetch))(url, {}, 1, chatId);
  if (!res.ok) {
    throw new Error(`Failed to fetch SCVCC court sheet: HTTP ${res.status}`);
  }

  const html = await res.text();
  const fullGrid = parseCourtGridHtml(html, chatId);

  if (!fullGrid || fullGrid.length === 0) {
    return {
      success: false,
      date: targetDateMDY,
      displayDate,
      message: `⚠️ Could not retrieve SCVCC court schedule for *${displayDate}*. The booking sheet may not be published yet.`
    };
  }

  const closedSlotInfoByIdx = new Map();
  const closedSlotIndices = new Set();
  for (let i = 0; i < fullGrid.length; i++) {
    const info = getSlotClubClosedInfo(fullGrid[i], normalizedSport, chatId);
    closedSlotInfoByIdx.set(i, info);
    if (info.clubClosed) {
      closedSlotIndices.add(i);
    }
  }

  const filteredSlots = [];
  const closedTimes = [];
  for (let i = 0; i < fullGrid.length; i++) {
    const slot = fullGrid[i];
    if (!isRelevantTime(slot.time)) continue;

    const matchedCourts = slot.courts.filter(c => isRelevantCourt(c.court));
    if (matchedCourts.length === 0) continue;

    const slotClosedInfo = closedSlotInfoByIdx.get(i) || { clubClosed: false, clubClosedTitle: null };

    // Attach consecutive available duration to each court
    const courtsWithDuration = matchedCourts.map(c => {
      if (slotClosedInfo.clubClosed) {
        return {
          ...c,
          availableMinutes: 0,
          durationLabel: null,
          overrideAvailableMinutes: 0,
          overrideDurationLabel: null,
          clubClosed: true,
          clubClosedTitle: slotClosedInfo.clubClosedTitle
        };
      }
      const normalDur = c.status === 'available'
        ? calculateAvailabilityDuration(fullGrid, i, c.court, { allowOverride: false, closedSlotIndices })
        : { minutes: 0, durationLabel: null };
      const overrideDur = calculateAvailabilityDuration(fullGrid, i, c.court, { allowOverride: true, closedSlotIndices });
      return {
        ...c,
        availableMinutes: normalDur.minutes,
        durationLabel: normalDur.durationLabel,
        overrideAvailableMinutes: overrideDur.minutes,
        overrideDurationLabel: overrideDur.durationLabel
      };
    });

    if (slotClosedInfo.clubClosed) {
      closedTimes.push({ time: slot.time, title: slotClosedInfo.clubClosedTitle });
    }

    filteredSlots.push({
      time: slot.time,
      clubClosed: slotClosedInfo.clubClosed,
      clubClosedTitle: slotClosedInfo.clubClosedTitle,
      courts: courtsWithDuration
    });
  }

  // Build user response
  const lines = [];
  const sportEmoji = normalizedSport === 'pickleball' ? '🏓' : '🎾';
  const sportLabel = normalizedSport === 'pickleball' ? 'Pickleball Courts' : (normalizedSport === 'all' ? 'All Courts' : 'Tennis Courts');

  lines.push(`${sportEmoji} *SCVCC ${sportLabel} — ${displayDate}*`);
  if (targetTime) lines.push(`🕒 Filter: *${targetIsAround ? 'around ' : ''}${targetTime}*`);
  if (court) lines.push(`🏟 Court: *${court}*`);
  lines.push('');

  // Cross-reference any explicitly passed prebookedCourts (e.g. from active poll state)
  if (Array.isArray(prebookedCourts) && prebookedCourts.length > 0) {
    for (const slot of filteredSlots) {
      if (slot.clubClosed) continue;
      for (const c of slot.courts) {
        if (c.status !== 'available' && c.status !== 'prebooked') {
          const matchPb = prebookedCourts.find((pb) => {
            const pbCourt = (pb.court || pb.name || '').toLowerCase().trim();
            const thisCourt = c.court.toLowerCase().trim();
            return pbCourt === thisCourt || thisCourt.includes(pbCourt) || pbCourt.includes(thisCourt);
          });
          if (matchPb) {
            c.status = 'prebooked';
            c.prebookedBy = matchPb.player || matchPb.name || null;
            c.prebookedFullName = matchPb.fullName || null;
          }
        }
      }
    }
  }

  let totalAvailableCount = 0;
  let totalPrebookedCount = 0;
  let totalBlockedCount = 0;

  const allFilteredClosed = filteredSlots.length > 0 && filteredSlots.every((s) => s.clubClosed);
  const firstClosedTitle = filteredSlots.find((s) => s.clubClosed)?.clubClosedTitle || null;

  // Specific time query: detailed descending list of available & prebooked courts
  if (targetTimeExact && !targetIsAround && filteredSlots.length > 0) {
    const slot = filteredSlots[0];
    const { availableCourts, prebookedCourtsList, blockedCourtsList } = partitionAndSortSlotCourts(slot.courts, { slotClubClosed: slot.clubClosed });

    totalAvailableCount = availableCourts.length;
    totalPrebookedCount = prebookedCourtsList.length;
    totalBlockedCount = blockedCourtsList.length;

    if (slot.clubClosed) {
      const titlePart = slot.clubClosedTitle ? `: ${slot.clubClosedTitle}` : '';
      lines.push(`• *${slot.time}*: 🚫 *Club Closed*${titlePart}`);
    } else if (availableCourts.length > 0 || prebookedCourtsList.length > 0 || blockedCourtsList.length > 0) {
      lines.push(`• *${slot.time}*:`);
      for (const ac of availableCourts) {
        lines.push(`  🟢 *${ac.court}* (${ac.durationLabel})`);
      }
      for (const pc of prebookedCourtsList) {
        lines.push(`  🔵 *${pc.court}* (Booked${formatPrebookedCourtDetails(pc)})`);
      }
      for (const bc of blockedCourtsList) {
        const durLabel = bc.overrideDurationLabel ? `: ${bc.overrideDurationLabel}` : '';
        lines.push(`  ⚪ *${bc.court}* (Blocked${durLabel})`);
      }
    } else {
      const blockedCourt = slot.courts.find(c => (targetColFilter && (c.court.toLowerCase() === targetColFilter || c.court.toLowerCase().includes(targetColFilter))));
      const reason = blockedCourt?.blockTitle
        ? `🔴 Booked: ${blockedCourt.blockTitle}`
        : (blockedCourt?.prebookedPlayers?.length > 0 ? `🔴 Booked (${blockedCourt.prebookedPlayers.join(', ')})` : '🔴 Unavailable / Reserved');
      lines.push(`• *${slot.time}*: ${reason}`);
    }
  } else {
    // General / Multi-slot query
    const availableSummary = [];
    for (const slot of filteredSlots) {
      const { availableCourts: openCourts, prebookedCourtsList, blockedCourtsList } = partitionAndSortSlotCourts(slot.courts, { slotClubClosed: slot.clubClosed });

      totalAvailableCount += openCourts.length;
      totalPrebookedCount += prebookedCourtsList.length;
      totalBlockedCount += blockedCourtsList.length;

      if (slot.clubClosed) {
        if (filteredSlots.length <= 8) {
          const titlePart = slot.clubClosedTitle ? ` (${slot.clubClosedTitle})` : '';
          availableSummary.push(`• *${slot.time}*: 🚫 *Club Closed*${titlePart}`);
        }
        continue;
      }

      const parts = [];
      if (openCourts.length > 0) {
        const courtListStr = openCourts.map((c) => `${c.court} (${c.availableMinutes > 90 ? '90m+' : `${c.availableMinutes}m`})`).join(', ');
        parts.push(`🟢 ${courtListStr}`);
      }
      if (prebookedCourtsList.length > 0) {
        const pbListStr = prebookedCourtsList.map((c) => `${c.court} (Booked${formatPrebookedCourtDetails(c)})`).join(', ');
        parts.push(`🔵 ${pbListStr}`);
      }
      if (blockedCourtsList.length > 0) {
        const blkListStr = blockedCourtsList.map((c) => {
          const mins = c.overrideAvailableMinutes || 0;
          const durStr = mins > 0 ? `: ${mins > 90 ? '90m+' : `${mins}m`}` : '';
          return `${c.court} (Blocked${durStr})`;
        }).join(', ');
        parts.push(`⚪ ${blkListStr}`);
      }

      if (parts.length > 0) {
        availableSummary.push(`• *${slot.time}*: ${parts.join(' | ')}`);
      } else if (filteredSlots.length <= 8) {
        availableSummary.push(`• *${slot.time}*: 🔴 Unavailable / Reserved`);
      }
    }

    if (availableSummary.length > 0) {
      lines.push(availableSummary.join('\n'));
    } else if (allFilteredClosed) {
      const titlePart = firstClosedTitle ? ` (${firstClosedTitle})` : '';
      lines.push(`🚫 *Club Closed*${titlePart} for *${displayDate}*.`);
    } else {
      lines.push('❌ No open or booked courts found matching your time / court criteria.');
    }
  }

  lines.push('');
  lines.push(`💡 Check other times with \`!courts ${targetWhen} morning\` or \`!courts ${targetWhen} evening\`.`);

  return {
    success: true,
    date: targetDateMDY,
    displayDate,
    totalAvailable: totalAvailableCount,
    totalPrebooked: totalPrebookedCount,
    totalBlocked: totalBlockedCount,
    clubClosed: allFilteredClosed,
    clubClosedTitle: allFilteredClosed ? firstClosedTitle : null,
    closedTimes,
    slots: filteredSlots,
    message: lines.join('\n')
  };
}

/**
 * Queries and lists booked courts / reservations at SCVCC for a given day and optional filters.
 */
async function getCourtBookings({ when = 'today', time = null, court = null, sport = 'tennis', player = null, chatId = null } = {}) {
  const {
    targetWhen,
    targetTime,
    normalizedSport,
    targetColFilter
  } = normalizeSheetQueryFilters({ when, time, court, sport, isAround: false, chatId });

  const targetDateMDY = resolveDateToMDY(targetWhen);
  const displayDate = formatDisplayDate(targetDateMDY);

  if (chatId && !groupsConfig.isCourtBookingEnabled(chatId)) {
    return {
      success: false,
      date: targetDateMDY,
      displayDate,
      bookings: [],
      message: '⚠️ Court functionality is not enabled for this group.'
    };
  }

  const targetPlayerFilter = player ? player.trim().toLowerCase() : null;

  if (targetColFilter && isIgnoredCourt(targetColFilter, chatId)) {
    return {
      success: true,
      date: targetDateMDY,
      displayDate,
      bookings: [],
      message: `⚠️ *${court}* is being ignored for checking availability.`
    };
  }

  const isRelevantCourt = createCourtRelevanceFilter(targetColFilter, normalizedSport, chatId);
  const { isRelevantTime } = createTimeRelevanceFilter(targetTime, false);

  const urls = getScvccUrls(chatId);
  const url = `${urls.bookingPageUrl}&date=${encodeURIComponent(targetDateMDY)}`;
  const res = await (facade.call('authFetch', authFetch))(url, {}, 1, chatId);
  if (!res.ok) {
    throw new Error(`Failed to fetch SCVCC court sheet: HTTP ${res.status}`);
  }

  const html = await res.text();
  const trMatches = html.match(/<tr[^>]*>([\s\S]*?)<\/tr>/gi) || [];
  const bookings = [];
  const closedSlotMap = new Map();
  const relevantSlotTimes = new Set();
  const activeSpans = new Map();

  for (const tr of trMatches) {
    const timeMatch = tr.match(/<div class="tscell">([\s\S]*?)<\/div>/i);
    if (!timeMatch) continue;
    const slotTime = timeMatch[1].trim();
    const currentSlotBookings = [];
    const courtsInRow = new Set();

    const tds = tr.match(/<td[^>]*>([\s\S]*?)<\/td>/gi) || [];
    for (const td of tds) {
      if (td.includes('rbm_TimeSlotPanelSlotAvailable')) continue;
      const cell = parseGridTdCell(td, chatId, { fallbackPlayerInnerText: false });
      if (!cell) continue;

      const courtKey = cell.courtName.toLowerCase();
      courtsInRow.add(courtKey);

      let type = 'Reserved';
      if (cell.imgTitle) {
        type = cell.imgTitle;
      } else if (cell.rawBlockTitle) {
        type = cell.rawBlockTitle;
      } else if (cell.isBlockedClass) {
        type = 'Blocked';
      }

      const closedCandTitle = [cell.rawBlockTitle, type].find(
        (cand) => cand && typeof groupsConfig.isClubClosedTitle === 'function' && groupsConfig.isClubClosedTitle(cand, chatId)
      ) || null;
      const isClosedBooking = Boolean(
        closedCandTitle && !isIgnoredCourt(cell.courtName, chatId) && isSportRelevantCourtName(cell.courtName, normalizedSport)
      );

      const bookingInfo = {
        time: slotTime,
        court: cell.courtName,
        durationMins: cell.durationMins,
        totalDurationMins: cell.durationMins,
        type,
        blockTitle: cell.rawBlockTitle,
        players: cell.players,
        resId: cell.resId,
        isPrebooked: Boolean(cell.prebookedMatch),
        prebookedBy: cell.prebookedMatch?.player || null,
        clubClosed: isClosedBooking,
        clubClosedTitle: isClosedBooking ? closedCandTitle : null
      };

      currentSlotBookings.push(bookingInfo);

      if (cell.rowspan > 1) {
        activeSpans.set(courtKey, {
          ...bookingInfo,
          remaining: cell.rowspan - 1
        });
      } else {
        activeSpans.delete(courtKey);
      }
    }

    for (const [courtKey, span] of activeSpans.entries()) {
      if (!courtsInRow.has(courtKey)) {
        currentSlotBookings.push({
          time: slotTime,
          court: span.court,
          durationMins: span.durationMins,
          totalDurationMins: span.totalDurationMins,
          type: span.type,
          blockTitle: span.blockTitle,
          players: span.players,
          resId: span.resId,
          isPrebooked: span.isPrebooked,
          prebookedBy: span.prebookedBy,
          clubClosed: span.clubClosed,
          clubClosedTitle: span.clubClosedTitle
        });
        span.remaining--;
        if (span.remaining <= 0) {
          activeSpans.delete(courtKey);
        }
      }
    }

    if (isRelevantTime(slotTime)) {
      relevantSlotTimes.add(slotTime);
      const closedInSlot = currentSlotBookings.find(
        (b) => b.clubClosed && !isIgnoredCourt(b.court, chatId) && isSportRelevantCourtName(b.court, normalizedSport)
      );
      if (closedInSlot && !closedSlotMap.has(slotTime)) {
        closedSlotMap.set(slotTime, closedInSlot.clubClosedTitle || closedInSlot.blockTitle || closedInSlot.type || 'Club Closed');
      }

      for (const b of currentSlotBookings) {
        if (!isRelevantCourt(b.court)) continue;
        if (targetPlayerFilter && b.players.length > 0) {
          const matchesPlayer = b.players.some((p) => p.toLowerCase().includes(targetPlayerFilter));
          if (!matchesPlayer) continue;
        }
        bookings.push(b);
      }
    }
  }

  const sportEmoji = normalizedSport === 'pickleball' ? '🏓' : '🎾';
  const sportLabel = normalizedSport === 'pickleball' ? 'Pickleball Court Bookings' : (normalizedSport === 'all' ? 'All Court Bookings' : 'Tennis Court Bookings');

  const lines = [`${sportEmoji} *SCVCC ${sportLabel} — ${displayDate}*`];
  if (targetTime) lines.push(`🕒 Filter: *${targetTime}*`);
  if (court) lines.push(`🏟 Court: *${court}*`);
  if (player) lines.push(`👤 Player: *${player}*`);
  lines.push('');

  if (bookings.length === 0) {
    lines.push('📋 No booked or reserved courts found matching your criteria.');
  } else {
    const byTime = new Map();
    for (const b of bookings) {
      if (!byTime.has(b.time)) byTime.set(b.time, []);
      byTime.get(b.time).push(b);
    }

    for (const [timeSlot, list] of byTime.entries()) {
      list.sort((a, b) => (a.court || '').localeCompare(b.court || '', undefined, { numeric: true }));
      lines.push(`• *${timeSlot}*:`);
      for (const b of list) {
        const playerStr = b.players.length > 0 ? b.players.join(', ') : b.type;
        const durStr = b.durationMins ? ` (${b.durationMins}m${b.type && b.type !== 'Reserved' && b.type !== 'Blocked' ? `, ${b.type}` : ''})` : '';
        const closedTag = b.clubClosed ? ' 🚫 *(Club Closed)*' : '';
        const tag = b.isPrebooked ? ` 🔵 *(Booked: ${b.prebookedBy})*` : closedTag;
        lines.push(`  🏟 *${b.court}*${durStr}: ${playerStr}${tag}`);
      }
    }
  }

  lines.push('');
  lines.push(`💡 Check open courts with !courts ${targetWhen}.`);

  const closedTimes = [...closedSlotMap.entries()].map(([t, title]) => ({ time: t, title }));
  const allRelevantClosed = relevantSlotTimes.size > 0 && [...relevantSlotTimes].every((t) => closedSlotMap.has(t));
  const firstClosedTitle = closedTimes.length > 0 ? closedTimes[0].title : null;

  return {
    success: true,
    date: targetDateMDY,
    displayDate,
    clubClosed: allRelevantClosed,
    clubClosedTitle: allRelevantClosed ? firstClosedTitle : null,
    closedTimes,
    bookings,
    message: lines.join('\n')
  };
}

/**
 * Retrieves the authenticated member's upcoming court reservations from SCVCC.
 */
async function getMyReservations(chatId = null) {
  const urls = getScvccUrls(chatId);
  const url = `${urls.bookingPageUrl}&tab=2`;
  const res = await (facade.call('authFetch', authFetch))(url, {}, 1, chatId);
  if (!res.ok) {
    throw new Error(`Failed to fetch SCVCC member reservations: HTTP ${res.status}`);
  }

  const html = await res.text();

  // Parse reservations from recent bookings panel
  const reservations = [];
  const resRegex = /<tr[^>]*class="[^"]*(?:rbm_GridRow|rbm_GridAltRow)[^"]*"[^>]*>([\s\S]*?)<\/tr>/gi;
  let rowMatch;

  while ((rowMatch = resRegex.exec(html)) !== null) {
    const rowHtml = rowMatch[1];
    const textCells = [];
    const tdRegex = /<td[^>]*>([\s\S]*?)<\/td>/gi;
    let tdMatch;
    while ((tdMatch = tdRegex.exec(rowHtml)) !== null) {
      textCells.push(tdMatch[1].replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').trim());
    }

    const idMatch = rowHtml.match(/LaunchrbEditor\([^,]+,[^,]+,'([^']+)'\)/i) ||
                    rowHtml.match(/bookingTimeid=([^&"']+)/i);

    if (textCells.length >= 3) {
      reservations.push({
        id: idMatch ? idMatch[1] : null,
        date: textCells[0],
        time: textCells[1],
        court: textCells[2],
        details: textCells.slice(3).join(' ')
      });
    }
  }

  if (reservations.length === 0) {
    return {
      success: true,
      reservations: [],
      message: '📋 You currently have no active upcoming court reservations at SCVCC.'
    };
  }

  const lines = ['🎾 *Your SCVCC Court Reservations:*', ''];
  for (const r of reservations) {
    lines.push(`• *${r.date}* at *${r.time}* — ${r.court}${r.id ? ` (ID: \`${r.id}\`)` : ''}`);
  }
  lines.push('');
  lines.push('💡 *To cancel:* `!cancelcourt <reservationId>`');

  return {
    success: true,
    reservations,
    message: lines.join('\n')
  };
}

module.exports = {
  parseCourtGridHtml,
  calculateAvailabilityDuration,
  checkCourtAvailability,
  getCourtBookings,
  getMyReservations
};
