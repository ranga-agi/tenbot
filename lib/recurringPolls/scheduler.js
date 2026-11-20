/**
 * Recurring Poll Execution Sweeps, Advance Court Bookings, Pruning, and Simulation
 */

const pollTime = require('../pollTime');
const scvcc = require('../scvcc');
const groupsConfig = require('../groupsConfig');
const courtsConfig = require('../courtsConfig');
const { sendMessageAndRecord } = require('../botMessage');
const { formatLookAround, getCandidateTimes } = pollTime;
const {
  DAY_NAMES,
  DAY_LOOKUP,
  isCourtSkipped,
  parseDaysOfWeek,
  getPostTimeForSchedule,
  parseDateToDateKey,
  getNextInstanceDate
} = require('./dates');
const { findScheduleKey } = require('./schedules');
const facade = require('./facade');

let isPostingSweepRunning = false;
const inFlightTriggers = new Set();
const inFlightAdvanceTriggers = new Set();
let isAdvanceBookingSweepRunning = false;

/**
 * Shared schedule lifecycle handler (endDate expiration & pausedUntil auto-resume).
 * Returns true if the schedule is currently enabled for execution.
 */
function handleScheduleLifecycle(scheduleId, sched, todayKey, persistPolls) {
  if (sched.endDate && todayKey > sched.endDate) {
    if (sched.enabled) {
      console.log(`[recurring-poll] Recurring schedule ${scheduleId} reached end date ${sched.endDate}; disabling schedule.`);
      sched.enabled = false;
      sched.ended = true;
      persistPolls();
    }
    return false;
  }
  if (sched.pausedUntil && todayKey >= sched.pausedUntil) {
    console.log(`[recurring-poll] Auto-resuming recurring schedule ${scheduleId}: reached pause date ${sched.pausedUntil}`);
    sched.enabled = true;
    delete sched.pausedUntil;
    delete sched.pausedUntilDisplay;
    persistPolls();
  }
  return Boolean(sched.enabled);
}

/**
 * Resolves effective poll slot size considering any per-instance slot override.
 */
function resolveInstanceSlotSize(sched, targetDateKey) {
  const instanceSlotOverride = sched.instanceSlotOverrides?.[targetDateKey];
  const isExplicitOverride = instanceSlotOverride !== undefined && instanceSlotOverride !== null;
  let effectiveSize = sched.size;
  if (isExplicitOverride) {
    if (typeof instanceSlotOverride === 'number') {
      effectiveSize = instanceSlotOverride;
    } else if (/^\d+$/.test(instanceSlotOverride)) {
      effectiveSize = parseInt(instanceSlotOverride, 10);
    } else if (instanceSlotOverride === 'auto') {
      effectiveSize = 'auto';
    } else if (/^opt-?in$/i.test(instanceSlotOverride) || /^yes\s*\/?\s*no$/i.test(instanceSlotOverride)) {
      effectiveSize = null;
    }
  }
  const maxCourts = isExplicitOverride && typeof effectiveSize === 'number'
    ? Math.max(sched.maxCourts || 0, Math.ceil(effectiveSize / 4))
    : (sched.maxCourts || sched['max-courts'] || null);
  return { instanceSlotOverride, isExplicitOverride, effectiveSize, maxCourts };
}

/**
 * Normalizes booked court objects stored inside `sched.advanceBookings[dateKey]`.
 */
function buildAutoBookedEntries(courts, defaultMatchTime, fallbackBookedAt) {
  return courts.map((b) => ({
    court: b.court,
    time: b.time || defaultMatchTime,
    reservationId: b.reservationId || null,
    players: b.players || [],
    duration: b.duration || '90 Minutes',
    partySize: b.partySize || 'Doubles',
    bookedAt: b.bookedAt || fallbackBookedAt || new Date().toISOString(),
    bookedSource: b.bookedSource || 'advance'
  }));
}

/**
 * Checks if a match poll has already been created for a given recurring schedule and match date.
 */
function isPollCreatedForMatchDate(sched, targetMatchDateKey, activePolls = null) {
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
 * Queries SCVCC for any courts manually booked by players for a specific match date and time.
 * Only courts with at least 90 minutes availability / duration qualify.
 */
async function detectManualPlayerBookings({ remoteJid, targetDateMDY, queryTime, sport = 'tennis', lookAround = 0, skippedCourts = [] }) {
  const manualCourts = [];
  const seenCourts = new Set();
  const candidateTimes = getCandidateTimes(queryTime, lookAround);

  try {
    for (const t of candidateTimes) {
      const [avail, bookingsRes] = await Promise.all([
        scvcc.checkCourtAvailability({ when: targetDateMDY, time: t, sport, chatId: remoteJid }).catch((err) => {
          console.warn(`[advance-booking] Error checking court availability for manual bookings at ${t}:`, err.message);
          return null;
        }),
        scvcc.getCourtBookings({ when: targetDateMDY, time: t, sport, chatId: remoteJid }).catch((err) => {
          console.warn(`[advance-booking] Error checking court bookings for manual bookings at ${t}:`, err.message);
          return null;
        })
      ]);

      const bookings = bookingsRes?.bookings || [];
      for (const b of bookings) {
        if (!b.court || courtsConfig.isIgnoredCourt(b.court, remoteJid) || isCourtSkipped(b.court, skippedCourts)) continue;
        const courtKey = b.court.toLowerCase().trim();
        if (seenCourts.has(courtKey)) continue;
        if (b.durationMins && b.durationMins < 90) continue;

        const prebookedMatch = scvcc.detectPrebookedCourt(b, remoteJid);
        if (prebookedMatch) {
          seenCourts.add(courtKey);
          manualCourts.push({
            court: b.court,
            player: prebookedMatch.player || 'Member',
            fullName: prebookedMatch.fullName || prebookedMatch.player || 'Member',
            duration: b.durationMins ? `${b.durationMins} Minutes` : '90 Minutes',
            time: t
          });
        }
      }

      if (avail?.slots && avail.slots.length > 0) {
        const slot = avail.slots[0];
        for (const c of slot.courts || []) {
          if (!c.court || courtsConfig.isIgnoredCourt(c.court, remoteJid) || isCourtSkipped(c.court, skippedCourts)) continue;
          const courtKey = c.court.toLowerCase().trim();
          if (seenCourts.has(courtKey)) continue;
          const durationMins = c.durationMins || c.totalDurationMins || null;
          if (durationMins && durationMins < 90) continue;
          if (c.status === 'prebooked') {
            seenCourts.add(courtKey);
            manualCourts.push({
              court: c.court,
              player: c.prebookedBy || 'Member',
              fullName: c.prebookedFullName || c.prebookedBy || 'Member',
              duration: c.availableMinutes ? `${c.availableMinutes} Minutes` : '90 Minutes',
              time: t
            });
          }
        }
      }
    }
  } catch (err) {
    console.warn('[advance-booking] Error in detectManualPlayerBookings:', err.message);
  }
  return manualCourts;
}

/**
 * Prunes advanceBookings and expired instanceSlotOverrides from recurringPolls schedules
 * once their match play time (or 14-day retention window) has passed.
 */
function pruneExpiredAdvanceBookings(recurringPolls, nowMs = Date.now(), persistPolls = null, customSanJoseParts = null) {
  if (!(recurringPolls instanceof Map)) return 0;
  let effectiveNowMs = (typeof nowMs === 'number') ? nowMs : Date.now();
  if (customSanJoseParts) {
    const sj = customSanJoseParts;
    effectiveNowMs = pollTime.createSanJoseDate(sj.year, sj.month, sj.day, sj.hour || 0, sj.minute || 0).getTime();
  }
  let totalPruned = 0;

  for (const [scheduleId, sched] of recurringPolls.entries()) {
    if (!sched || typeof sched !== 'object' || (!sched.advanceBookings && !sched.instanceSlotOverrides && !sched.instanceCourtSkips)) continue;
    let schedPruned = 0;

    if (sched.advanceBookings && typeof sched.advanceBookings === 'object') {
      for (const [dateKey, entry] of Object.entries(sched.advanceBookings)) {
        const parts = dateKey.split('-').map(Number);
        if (parts.length !== 3) continue;

        const mTime = entry?.matchTime || sched.matchTime || '7:00 PM';
        const parsedTime = pollTime.parseTimeString(mTime) || { hour: 19, minute: 0 };
        let latestHour = parsedTime.hour;
        let latestMinute = parsedTime.minute;

        const courts = entry?.autoBookedCourts || entry?.advanceBookedCourts || [];
        if (Array.isArray(courts)) {
          for (const c of courts) {
            if (c.time) {
              const cp = pollTime.parseTimeString(c.time);
              if (cp && (cp.hour > latestHour || (cp.hour === latestHour && cp.minute > latestMinute))) {
                latestHour = cp.hour;
                latestMinute = cp.minute;
              }
            }
          }
        }

        const playAt = pollTime.createSanJoseDate(parts[0], parts[1] - 1, parts[2], latestHour, latestMinute);

        if (effectiveNowMs >= playAt.getTime()) {
          delete sched.advanceBookings[dateKey];
          schedPruned++;
          totalPruned++;
        }
      }
    }

    if (sched.instanceSlotOverrides && typeof sched.instanceSlotOverrides === 'object') {
      const graceMs = 14 * 24 * 60 * 60 * 1000;
      for (const [dateKey] of Object.entries(sched.instanceSlotOverrides)) {
        const parts = dateKey.split('-').map(Number);
        if (parts.length !== 3) continue;

        const mTime = sched.matchTime || '7:00 PM';
        const parsedTime = pollTime.parseTimeString(mTime) || { hour: 19, minute: 0 };
        const playAt = pollTime.createSanJoseDate(parts[0], parts[1] - 1, parts[2], parsedTime.hour, parsedTime.minute);

        if (effectiveNowMs >= playAt.getTime() + graceMs) {
          delete sched.instanceSlotOverrides[dateKey];
          schedPruned++;
          totalPruned++;
          console.log(`[recurring-poll] Pruned expired instance slot override for ${dateKey} on schedule ${scheduleId} (exceeded 14-day retention)`);
        }
      }

      if (Object.keys(sched.instanceSlotOverrides).length === 0) {
        delete sched.instanceSlotOverrides;
      }
    }

    if (schedPruned > 0 && typeof persistPolls === 'function') {
      persistPolls(sched.remoteJid);
    }
  }

  return totalPruned;
}

/**
 * Checks and automatically books courts in advance for recurring polls configured with
 * bookingStrategy = 'advanced' and bookingSchedule (e.g. '-7days 7:00AM').
 */
async function checkAndExecuteAdvanceBookings({
  sock,
  recurringPolls,
  persistPolls,
  preBookCourtsForMatch,
  activePolls = null,
  customSanJoseParts = null,
  sendBookingNotifications = null
}) {
  if (!sock || !recurringPolls || recurringPolls.size === 0 || !preBookCourtsForMatch) return;
  if (isAdvanceBookingSweepRunning) return;
  isAdvanceBookingSweepRunning = true;

  try {
    const sj = customSanJoseParts || pollTime.getSanJoseParts();
    const todayKey = `${sj.year}-${String(sj.month + 1).padStart(2, '0')}-${String(sj.day).padStart(2, '0')}`;
    const currentMinutes = sj.hour * 60 + sj.minute;
    const nowMs = Date.now();
    facade.call('pruneExpiredAdvanceBookings', pruneExpiredAdvanceBookings)(recurringPolls, nowMs, persistPolls, customSanJoseParts);
    const RETRY_INTERVAL_MS = 10 * 60 * 1000;
    const MAX_RETRY_WINDOW_MS = 60 * 60 * 1000;
    const CHECK_SLOT_1_MINUTES = 9 * 60 + 30;
    const CHECK_SLOT_2_MINUTES = 15 * 60 + 30;

    for (const [scheduleId, sched] of recurringPolls.entries()) {
      if (!handleScheduleLifecycle(scheduleId, sched, todayKey, persistPolls)) continue;

      const groupCfg = groupsConfig.getGroupConfig(sched.remoteJid);
      if (!groupsConfig.isCourtBookingEnabled(sched.remoteJid)) continue;

      const strategy = sched.bookingStrategy || groupCfg?.bookingStrategy || null;
      if (strategy !== 'advanced') continue;

      const rawSchedule = sched.bookingSchedule || groupCfg?.bookingSchedule || '-7days 7:00AM';
      const parsedSchedule = groupsConfig.parseBookingSchedule(rawSchedule);
      if (!parsedSchedule) continue;

      const bookingDaysBefore = parsedSchedule.daysBefore;
      const bookingTimeMinutes = parsedSchedule.hour * 60 + parsedSchedule.minute;

      const schedDays = (Array.isArray(sched.daysList) && sched.daysList.length > 0)
        ? [...new Set(sched.daysList)]
        : [...new Set(parseDaysOfWeek(sched.days).days)];

      const schedMatchMinutes = sched.matchHour * 60 + sched.matchMinute;

      let targetCourtsCount = 1;
      const isAuto = sched.size === 'auto' || !sched.size;
      const explicitCourts = (sched.explicitPreBookCourts && sched.preBookCourts !== undefined && sched.preBookCourts !== null && parseInt(sched.preBookCourts, 10) > 0)
        ? parseInt(sched.preBookCourts, 10)
        : null;
      const explicitMax = (sched.maxCourts !== undefined && sched.maxCourts !== null && parseInt(sched.maxCourts, 10) > 0)
        ? parseInt(sched.maxCourts, 10)
        : null;
      if (!isAuto && sched.size && parseInt(sched.size, 10) > 0) {
        targetCourtsCount = explicitCourts || explicitMax || Math.max(1, Math.ceil(parseInt(sched.size, 10) / 4));
        if (explicitMax) {
          targetCourtsCount = Math.min(targetCourtsCount, explicitMax);
        }
      } else {
        const cfgCourts = (groupCfg?.preBookCourts !== undefined && groupCfg?.preBookCourts !== null && parseInt(groupCfg.preBookCourts, 10) > 0)
          ? parseInt(groupCfg.preBookCourts, 10)
          : (groupCfg?.preBookCourtsCount !== undefined && groupCfg?.preBookCourtsCount !== null && parseInt(groupCfg.preBookCourtsCount, 10) > 0
            ? parseInt(groupCfg.preBookCourtsCount, 10)
            : null);
        targetCourtsCount = explicitCourts || explicitMax || cfgCourts || 0;
        if (explicitMax && targetCourtsCount > 0) {
          targetCourtsCount = Math.min(targetCourtsCount, explicitMax);
        }
      }

      if (targetCourtsCount <= 0) continue;

      const candidateMatchDates = new Map();
      for (let offset = bookingDaysBefore; offset >= 0; offset--) {
        const dObj = new Date(Date.UTC(sj.year, sj.month, sj.day + offset));
        const tYear = dObj.getUTCFullYear();
        const tMonth = dObj.getUTCMonth();
        const tDay = dObj.getUTCDate();
        const tKey = `${tYear}-${String(tMonth + 1).padStart(2, '0')}-${String(tDay).padStart(2, '0')}`;
        candidateMatchDates.set(tKey, { targetDateObj: dObj, daysOffset: offset, targetDayIndex: dObj.getUTCDay() });
      }

      if (sched.advanceBookings) {
        for (const tKey of Object.keys(sched.advanceBookings)) {
          if (tKey >= todayKey && !candidateMatchDates.has(tKey)) {
            const parts = tKey.split('-').map(Number);
            if (parts.length === 3) {
              const dObj = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2]));
              const diffDays = Math.round((dObj.getTime() - Date.UTC(sj.year, sj.month, sj.day)) / (24 * 3600 * 1000));
              candidateMatchDates.set(tKey, { targetDateObj: dObj, daysOffset: diffDays, targetDayIndex: dObj.getUTCDay() });
            }
          }
        }
      }

      for (const [targetMatchDateKey, { targetDateObj, daysOffset, targetDayIndex }] of candidateMatchDates.entries()) {
        if (!schedDays.includes(targetDayIndex)) continue;
        if (sched.startDate && targetMatchDateKey < sched.startDate) continue;
        if (sched.endDate && targetMatchDateKey > sched.endDate) continue;

        if (Array.isArray(sched.skippedMatchDates) && sched.skippedMatchDates.includes(targetMatchDateKey)) {
          continue;
        }

        if (facade.call('isPollCreatedForMatchDate', isPollCreatedForMatchDate)(sched, targetMatchDateKey, activePolls)) {
          continue;
        }

        const postConfig = getPostTimeForSchedule(sched, targetDayIndex);
        const postDaysBefore = postConfig.daysBefore !== undefined ? postConfig.daysBefore : 0;
        const postHour = postConfig.postHour !== undefined ? postConfig.postHour : (postConfig.hour || 8);
        const postMinute = postConfig.postMinute !== undefined ? postConfig.postMinute : (postConfig.minute || 0);
        const postMinutes = postHour * 60 + postMinute;

        if (daysOffset < postDaysBefore) continue;
        if (daysOffset === postDaysBefore && currentMinutes >= postMinutes) continue;

        if (targetMatchDateKey < todayKey) continue;
        if (targetMatchDateKey === todayKey && currentMinutes >= schedMatchMinutes) continue;

        if (daysOffset > bookingDaysBefore) continue;
        if (daysOffset === bookingDaysBefore && currentMinutes < bookingTimeMinutes) continue;

        if (!sched.advanceBookings) sched.advanceBookings = {};
        const existingEntry = sched.advanceBookings[targetMatchDateKey];
        const existingAdvanceCourts = Array.isArray(existingEntry?.autoBookedCourts) ? existingEntry.autoBookedCourts : (Array.isArray(existingEntry?.advanceBookedCourts) ? existingEntry.advanceBookedCourts : []);
        const existingPrebookedCourts = Array.isArray(existingEntry?.prebookedCourts) ? existingEntry.prebookedCourts : [];

        const currentSecuredCourtNames = new Set([
          ...existingAdvanceCourts.map((b) => b.court?.toLowerCase().trim()).filter(Boolean),
          ...existingPrebookedCourts.map((b) => b.court?.toLowerCase().trim()).filter(Boolean)
        ]);

        const instanceSlotOverride = sched.instanceSlotOverrides?.[targetMatchDateKey];
        let dateTargetCourtsCount = targetCourtsCount;
        if (instanceSlotOverride !== undefined && instanceSlotOverride !== null && typeof instanceSlotOverride === 'number') {
          const courtsPerMatch = sched.sport === 'pickleball' ? 2 : 4;
          dateTargetCourtsCount = Math.max(1, Math.ceil(instanceSlotOverride / courtsPerMatch));
        }

        if (existingEntry?.completed && currentSecuredCourtNames.size >= dateTargetCourtsCount) {
          continue;
        }

        const isInitialAttempt = !existingEntry || !existingEntry.firstAttemptAt;
        const isInitialRetry = Boolean(
          existingEntry?.firstAttemptAt &&
          (nowMs - existingEntry.firstAttemptAt < MAX_RETRY_WINDOW_MS) &&
          (nowMs - (existingEntry.lastAttemptAt || 0) >= RETRY_INTERVAL_MS)
        );

        let periodicSlotKey = null;
        if (currentMinutes >= CHECK_SLOT_2_MINUTES) {
          periodicSlotKey = `${todayKey}:15:30`;
        } else if (currentMinutes >= CHECK_SLOT_1_MINUTES) {
          periodicSlotKey = `${todayKey}:09:30`;
        }

        const executedSlots = Array.isArray(existingEntry?.periodicChecks) ? existingEntry.periodicChecks : [];
        const isPeriodicCheckDue = Boolean(
          periodicSlotKey &&
          !executedSlots.includes(periodicSlotKey) &&
          (existingEntry?.firstAttemptAt || daysOffset < bookingDaysBefore || (daysOffset === bookingDaysBefore && currentMinutes >= bookingTimeMinutes))
        );

        if (!isInitialAttempt && !isInitialRetry && !isPeriodicCheckDue) {
          continue;
        }

        const targetMonth = targetDateObj.getUTCMonth();
        const targetDay = targetDateObj.getUTCDate();
        const targetYear = targetDateObj.getUTCFullYear();
        const targetDateMDY = `${String(targetMonth + 1).padStart(2, '0')}/${String(targetDay).padStart(2, '0')}/${targetYear}`;

        const instanceCourtSkips = sched.instanceCourtSkips?.[targetMatchDateKey] || [];
        const manualPlayerBookings = await facade.call('detectManualPlayerBookings', detectManualPlayerBookings)({
          remoteJid: sched.remoteJid,
          targetDateMDY,
          queryTime: sched.matchTime,
          sport: sched.sport || 'tennis',
          lookAround: sched.lookAround || groupCfg?.lookAround || null,
          skippedCourts: instanceCourtSkips
        });

        const seenPrebookedCourtNames = new Set(existingPrebookedCourts.map((b) => b.court?.toLowerCase().trim()).filter(Boolean));
        for (const pb of manualPlayerBookings) {
          const cKey = pb.court?.toLowerCase().trim();
          if (cKey && !seenPrebookedCourtNames.has(cKey)) {
            seenPrebookedCourtNames.add(cKey);
            existingPrebookedCourts.push(pb);
          }
        }

        const updatedSecuredCourtNames = new Set([
          ...existingAdvanceCourts.map((b) => b.court?.toLowerCase().trim()).filter(Boolean),
          ...existingPrebookedCourts.map((b) => b.court?.toLowerCase().trim()).filter(Boolean)
        ]);

        const periodicChecksArr = Array.isArray(existingEntry?.periodicChecks) ? [...existingEntry.periodicChecks] : [];
        if (periodicSlotKey && !periodicChecksArr.includes(periodicSlotKey)) {
          periodicChecksArr.push(periodicSlotKey);
        }

        if (updatedSecuredCourtNames.size >= dateTargetCourtsCount) {
          console.log(`[advance-booking] Target courts count (${targetCourtsCount}) reached for schedule ${scheduleId} on ${targetDateMDY} with manual player bookings (${updatedSecuredCourtNames.size} secured).`);
          const autoBookings = buildAutoBookedEntries(existingAdvanceCourts, sched.matchTime, existingEntry?.bookedAt);

          sched.advanceBookings[targetMatchDateKey] = {
            autoBookedCourts: autoBookings,
            advanceBookedCourts: autoBookings,
            prebookedCourts: existingPrebookedCourts,
            targetDateMDY,
            matchTime: sched.matchTime,
            targetCourtsCount: dateTargetCourtsCount,
            firstAttemptAt: existingEntry?.firstAttemptAt || nowMs,
            lastAttemptAt: nowMs,
            retryCount: existingEntry?.retryCount || 0,
            completed: true,
            bookedAt: existingEntry?.bookedAt || new Date().toISOString(),
            periodicChecks: periodicChecksArr,
            summarySent: Boolean(existingEntry?.summarySent)
          };
          const shouldSendSummary = !isPeriodicCheckDue;
          if (shouldSendSummary && !sched.advanceBookings[targetMatchDateKey].summarySent && typeof sendBookingNotifications === 'function') {
            sched.advanceBookings[targetMatchDateKey].summarySent = true;
            const summaryMsg = scvcc.buildBookingSummaryMessage({
              targetDateMDY,
              queryTime: sched.matchTime,
              sport: sched.sport || 'tennis',
              targetCourtsCount,
              advanceBookedCourts: existingAdvanceCourts,
              prebookedCourts: existingPrebookedCourts,
              isExhausted: false
            });
            await sendBookingNotifications(sock, sched.remoteJid, summaryMsg);
          }
          persistPolls(sched.remoteJid);
          continue;
        }

        const triggerKey = `${scheduleId}:${targetMatchDateKey}`;
        if (inFlightAdvanceTriggers.has(triggerKey)) continue;
        inFlightAdvanceTriggers.add(triggerKey);

        const retryNum = (existingEntry?.retryCount || 0) + (existingEntry ? 1 : 0);
        const periodicLabel = isPeriodicCheckDue ? ` [periodic check ${periodicSlotKey}]` : (isInitialRetry ? ` (retry #${retryNum})` : ' (initial attempt)');
        console.log(`[advance-booking] Triggering advance court booking for schedule ${scheduleId} on ${targetDateMDY} (${DAY_NAMES[targetDayIndex]} ${sched.matchTime})${periodicLabel} in ${sched.remoteJid}`);

        try {
          const bookRes = await preBookCourtsForMatch({
            sock,
            remoteJid: sched.remoteJid,
            targetDateMDY,
            queryTime: sched.matchTime,
            court: sched.court || sched.targetCourt || null,
            targetCourt: sched.court || sched.targetCourt || null,
            size: sched.size,
            isAuto,
            preBookCourts: (instanceSlotOverride !== undefined && typeof instanceSlotOverride === 'number') ? dateTargetCourtsCount : sched.preBookCourts,
            maxCourts: sched.maxCourts || null,
            courtPreference: sched.bookingCourtPreference || null,
            bookingPlayers: sched.bookingPlayers,
            creatorName: sched.creator?.name || 'Daily Poll',
            creatorJid: sched.creator?.jid || null,
            existingAdvanceBookedCourts: existingAdvanceCourts,
            existingPrebookedCourts: existingPrebookedCourts,
            isAdvanceBooking: true,
            minAvailableMinutes: 90,
            lookAround: sched.lookAround || groupCfg?.lookAround || null,
            excludeCourts: instanceCourtSkips,
            skippedCourts: instanceCourtSkips
          });

          const prevAdvanceCount = existingAdvanceCourts.length;
          const allAdvanceBooked = (bookRes && Array.isArray(bookRes.advanceBookedCourts)) ? bookRes.advanceBookedCourts : existingAdvanceCourts;
          const allPrebooked = (bookRes && Array.isArray(bookRes.prebookedCourts)) ? bookRes.prebookedCourts : existingPrebookedCourts;
          const newCourtsBookedByBot = allAdvanceBooked.length - prevAdvanceCount;

          const totalSecuredCourts = new Set([
            ...allAdvanceBooked.map((b) => b.court?.toLowerCase().trim()).filter(Boolean),
            ...allPrebooked.map((b) => b.court?.toLowerCase().trim()).filter(Boolean)
          ]);
          const isComplete = totalSecuredCourts.size >= targetCourtsCount;

          const autoBookings = buildAutoBookedEntries(allAdvanceBooked, sched.matchTime, existingEntry?.bookedAt);

          const autoCourtNames = new Set(allAdvanceBooked.map((b) => b.court?.toLowerCase().trim()).filter(Boolean));
          const distinctManualCourts = allPrebooked.filter((pb) => !autoCourtNames.has(pb.court?.toLowerCase().trim())).map((pb) => ({
            court: pb.court,
            time: pb.time,
            players: pb.players || (pb.fullName ? pb.fullName.split(/[,;&+]|\band\b/i).map((s) => s.trim()).filter(Boolean) : (pb.player ? [pb.player] : []))
          }));

          const combinedPrebooked = [
            ...allAdvanceBooked.map((b) => ({
              court: b.court,
              player: b.players?.[0] || 'Member',
              fullName: (b.players && b.players.length > 0) ? b.players.join(', ') : 'Member',
              time: b.time,
              bookingType: 'auto'
            })),
            ...distinctManualCourts.map((m) => ({ ...m, player: m.players?.[0] || 'Member', fullName: m.players?.join(', ') || 'Member', bookingType: 'manual' }))
          ];

          sched.advanceBookings[targetMatchDateKey] = {
            autoBookedCourts: autoBookings,
            advanceBookedCourts: autoBookings,
            prebookedCourts: combinedPrebooked,
            targetDateMDY,
            matchTime: sched.matchTime,
            targetCourtsCount: dateTargetCourtsCount,
            firstAttemptAt: existingEntry?.firstAttemptAt || nowMs,
            lastAttemptAt: nowMs,
            retryCount: retryNum,
            completed: isComplete,
            bookedAt: existingEntry?.bookedAt || (allAdvanceBooked.length > 0 ? new Date().toISOString() : null),
            periodicChecks: periodicChecksArr,
            summarySent: Boolean(existingEntry?.summarySent)
          };
          persistPolls(sched.remoteJid);

          if (isComplete) {
            console.log(`[advance-booking] Successfully secured all ${totalSecuredCourts.size}/${targetCourtsCount} court(s) for schedule ${scheduleId} [Match: ${targetMatchDateKey}]:`, { advance: allAdvanceBooked, prebooked: allPrebooked });
            const shouldSendSummary = !isPeriodicCheckDue || newCourtsBookedByBot > 0;
            if (shouldSendSummary && !sched.advanceBookings[targetMatchDateKey].summarySent && typeof sendBookingNotifications === 'function') {
              sched.advanceBookings[targetMatchDateKey].summarySent = true;
              persistPolls(sched.remoteJid);
              const summaryMsg = scvcc.buildBookingSummaryMessage({
                targetDateMDY,
                queryTime: sched.matchTime,
                sport: sched.sport || 'tennis',
                targetCourtsCount,
                advanceBookedCourts: allAdvanceBooked,
                prebookedCourts: allPrebooked,
                isExhausted: false
              });
              await sendBookingNotifications(sock, sched.remoteJid, summaryMsg);
            }
          } else {
            console.warn(`[advance-booking] Schedule ${scheduleId} on ${targetMatchDateKey}: ${totalSecuredCourts.size}/${targetCourtsCount} court(s) secured so far. Will continue periodic checks (9:30am & 3:30pm) until poll is created.`);
          }

          if (activePolls && (allAdvanceBooked.length > 0 || allPrebooked.length > 0)) {
            for (const [pollId, pollState] of activePolls.entries()) {
              if (pollState.remoteJid === sched.remoteJid && (pollState.scheduleId === sched.id || pollState.when?.includes(DAY_NAMES[targetDayIndex]))) {
                pollState.autoBookedCourts = autoBookings;
                pollState.advanceBookedCourts = autoBookings;
                pollState.manuallyBookedCourts = distinctManualCourts;
                pollState.prebookedCourts = combinedPrebooked;
                persistPolls(sched.remoteJid);
                console.log(`[advance-booking] Updated existing active poll ${pollId} with booked courts.`);
                break;
              }
            }
          }
        } catch (err) {
          console.error(`[advance-booking] Error during advance booking execution for schedule ${scheduleId}:`, err.message);
          if (!sched.advanceBookings[targetMatchDateKey]) {
            const autoBookings = buildAutoBookedEntries(existingAdvanceCourts, sched.matchTime, existingEntry?.bookedAt);
            sched.advanceBookings[targetMatchDateKey] = {
              autoBookedCourts: autoBookings,
              advanceBookedCourts: autoBookings,
              targetDateMDY,
              matchTime: sched.matchTime,
              targetCourtsCount,
              firstAttemptAt: existingEntry?.firstAttemptAt || nowMs,
              lastAttemptAt: nowMs,
              retryCount: retryNum,
              completed: false,
              bookedAt: existingEntry?.bookedAt || null,
              periodicChecks: periodicChecksArr,
              summarySent: false
            };
          } else {
            sched.advanceBookings[targetMatchDateKey].lastAttemptAt = nowMs;
            sched.advanceBookings[targetMatchDateKey].retryCount = retryNum;
            sched.advanceBookings[targetMatchDateKey].periodicChecks = periodicChecksArr;
          }
          persistPolls(sched.remoteJid);
        } finally {
          inFlightAdvanceTriggers.delete(triggerKey);
        }
      }
    }
  } catch (err) {
    console.error('⚠️ [advance-booking] Error in checkAndExecuteAdvanceBookings:', err);
  } finally {
    isAdvanceBookingSweepRunning = false;
  }
}

/**
 * Sweeps all recurring poll schedules and automatically creates and posts polls whose post time has arrived on scheduled posting days.
 * Fully supports posting same day, 1 day before (e.g. Sunday 6pm for Monday 7pm), or more than 24 hours in advance (e.g. 2+ days before).
 */
async function checkAndPostRecurringPolls({ sock, recurringPolls, persistPolls, createMatchPoll, getTargetGroupJid, customSanJoseParts = null, preBookCourtsForMatch = null, activePolls = null, sendBookingNotifications = null }) {
  if (preBookCourtsForMatch) {
    await facade.call('checkAndExecuteAdvanceBookings', checkAndExecuteAdvanceBookings)({
      sock, recurringPolls, persistPolls, preBookCourtsForMatch, activePolls, customSanJoseParts, sendBookingNotifications
    });
  }
  if (!sock || recurringPolls.size === 0) return;
  if (isPostingSweepRunning) return;
  isPostingSweepRunning = true;

  try {
    const sj = customSanJoseParts || pollTime.getSanJoseParts();
    const todayKey = `${sj.year}-${String(sj.month + 1).padStart(2, '0')}-${String(sj.day).padStart(2, '0')}`;
    const currentMinutes = sj.hour * 60 + sj.minute;

    const DAY_MAP = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
    const currentDayIndex = DAY_MAP[sj.weekday] !== undefined ? DAY_MAP[sj.weekday] : (new Date(sj.year, sj.month, sj.day).getDay());

    for (const [scheduleId, sched] of recurringPolls.entries()) {
      if (!handleScheduleLifecycle(scheduleId, sched, todayKey, persistPolls)) continue;

      const schedDays = (Array.isArray(sched.daysList) && sched.daysList.length > 0)
        ? [...new Set(sched.daysList)]
        : [...new Set(parseDaysOfWeek(sched.days).days)];

      const schedMatchMinutes = sched.matchHour * 60 + sched.matchMinute;

      for (const targetMatchDayIndex of schedDays) {
        const postConfig = getPostTimeForSchedule(sched, targetMatchDayIndex);
        const postDayIndex = postConfig.postDayIndex;
        const postHour = postConfig.hour !== undefined ? postConfig.hour : (postConfig.postHour !== undefined ? postConfig.postHour : 8);
        const postMinute = postConfig.minute !== undefined ? postConfig.minute : (postConfig.postMinute !== undefined ? postConfig.postMinute : 0);
        const daysBefore = postConfig.daysBefore !== undefined ? postConfig.daysBefore : 0;
        const postDisplay = postConfig.display || '';

        if (postDayIndex !== currentDayIndex) continue;

        const postMinutes = postHour * 60 + postMinute;
        if (currentMinutes < postMinutes) continue;

        const targetDateObj = new Date(Date.UTC(sj.year, sj.month, sj.day + daysBefore));
        const targetYear = targetDateObj.getUTCFullYear();
        const targetMonth = targetDateObj.getUTCMonth();
        const targetDay = targetDateObj.getUTCDate();
        const targetMatchDateKey = `${targetYear}-${String(targetMonth + 1).padStart(2, '0')}-${String(targetDay).padStart(2, '0')}`;

        if (sched.startDate && targetMatchDateKey < sched.startDate) continue;
        if (sched.endDate && targetMatchDateKey > sched.endDate) continue;

        const triggerKey = `${scheduleId}:${targetMatchDateKey}`;
        if (inFlightTriggers.has(triggerKey)) continue;

        if (!Array.isArray(sched.postedMatchDates)) {
          sched.postedMatchDates = [];
        }

        if (Array.isArray(sched.skippedMatchDates) && sched.skippedMatchDates.includes(targetMatchDateKey)) {
          console.log(`[recurring-poll] Skipping instance for schedule ${scheduleId} on ${targetMatchDateKey} as requested.`);
          continue;
        }

        if (sched.postedMatchDates.includes(targetMatchDateKey) || sched.lastPostedMatchDate === targetMatchDateKey) {
          continue;
        }

        if (!sched.postAttempts) sched.postAttempts = {};
        const attemptEntry = sched.postAttempts[targetMatchDateKey] || { count: 0, lastAttemptAt: 0, notified: false };
        const nowMs = Date.now();
        const MAX_POST_RETRIES = 2;

        if (daysBefore === 0 && currentMinutes >= schedMatchMinutes) {
          sched.postedMatchDates.push(targetMatchDateKey);
          sched.lastPostedMatchDate = targetMatchDateKey;
          sched.lastPostedDate = todayKey;
          delete sched.postAttempts[targetMatchDateKey];
          if (sched.oneTime) {
            sched.enabled = false;
            sched.completed = true;
          }
          persistPolls();
          console.log(`[recurring-poll] Match time already passed today for schedule ${scheduleId} (${sched.matchTime}). Marking today as handled.`);
          continue;
        }

        inFlightTriggers.add(triggerKey);
        attemptEntry.count = (attemptEntry.count || 0) + 1;
        attemptEntry.lastAttemptAt = nowMs;
        sched.postAttempts[targetMatchDateKey] = attemptEntry;
        persistPolls();

        const targetChatId = sched.remoteJid.endsWith('@g.us') ? sched.remoteJid : (await getTargetGroupJid(sock) || sched.remoteJid);
        const creatorName = sched.creator?.name || 'Daily Poll';
        const creatorJid = sched.creator?.jid || null;
        const targetDayName = DAY_NAMES[targetMatchDayIndex];

        let whenStr;
        let dayWord;
        if (daysBefore === 0) {
          dayWord = 'today';
          whenStr = `Today ${sched.matchTime}`;
        } else {
          dayWord = targetDayName;
          whenStr = `${targetDayName} ${sched.matchTime}`;
        }

        const effectiveLineupGen = sched.lineupGeneration || 'filled';
        const isCommand = effectiveLineupGen !== 'filled';

        const { isExplicitOverride, effectiveSize, maxCourts } = resolveInstanceSlotSize(sched, targetMatchDateKey);

        const sizeDesc = isExplicitOverride ? `${effectiveSize || 'opt-in'} spots (overridden for this instance)` : `${sched.size || 'opt-in'} spots`;
        const retryLabel = attemptEntry.count > 1 ? ` (retry #${attemptEntry.count - 1}/${MAX_POST_RETRIES})` : '';
        console.log(`[recurring-poll] Triggering recurring match poll for schedule ${scheduleId}${retryLabel} (${whenStr} [Target: ${targetMatchDateKey}], ${sizeDesc}, postTime: ${postDisplay}, daysBefore: ${daysBefore}, lineupGeneration: ${effectiveLineupGen}) in ${targetChatId}`);

        try {
          const preExistingBookings = (sched.advanceBookings && sched.advanceBookings[targetMatchDateKey]) || null;
          const res = await createMatchPoll(
            sock,
            targetChatId,
            effectiveSize,
            whenStr,
            dayWord,
            sched.matchTime,
            creatorName,
            creatorJid,
            sched.includeCreator,
            null,
            false,
            isCommand,
            effectiveLineupGen === 'none',
            Boolean(sched.checkCourts),
            sched.includePrebookedSpots || sched['prebooked-spots'] || false,
            true,
            scheduleId,
            null,
            sched.courtBookingType || 'none',
            sched.bookingPlayers || null,
            sched.preBookCourts || null,
            sched.bookingStrategy || null,
            preExistingBookings,
            {
              lookAround: sched.lookAround || null,
              slotCheck: (sched.slotCheck !== undefined && sched.slotCheck !== null) ? sched.slotCheck : true,
              lineupGeneration: effectiveLineupGen,
              lineupLeadTime: sched.lineupLeadTime,
              reminders: sched.reminders !== false,
              maxCourts,
              bookingCourtPreference: sched.bookingCourtPreference || null,
              timeSlots: sched.timeSlots || null,
              multiVote: sched.multiVote !== undefined ? sched.multiVote : null,
              multiSessionMode: sched.multiSessionMode || null,
              slotOverride: isExplicitOverride ? effectiveSize : undefined,
              skippedCourts: sched.instanceCourtSkips?.[targetMatchDateKey] || []
            },
            ...(activePolls ? [{ activePolls, recurringPolls, persistPolls }] : [])
          );

          if (res?.err) {
            console.error(`[recurring-poll] Failed to create recurring poll ${scheduleId} (attempt ${attemptEntry.count}/${MAX_POST_RETRIES + 1}):`, res.err);
            if (attemptEntry.count > MAX_POST_RETRIES) {
              const failureMsg = res.message || res.err || `⚠️ Cannot create poll for *${whenStr}*: No live or prebooked courts are available at SCVCC (all courts are reserved or blocked).`;
              console.log(`[recurring-poll] Retries exhausted for schedule ${scheduleId} on ${targetMatchDateKey}. Sending one-time failure notification to ${targetChatId}`);
              if (sock && targetChatId && !attemptEntry.notified) {
                try {
                  await sendMessageAndRecord(sock, targetChatId, { text: failureMsg });
                } catch (sendErr) {
                  console.error('[recurring-poll] Error sending poll failure notification:', sendErr.message);
                }
                attemptEntry.notified = true;
              }
              sched.postedMatchDates.push(targetMatchDateKey);
              if (sched.postedMatchDates.length > 30) sched.postedMatchDates.shift();
              sched.lastPostedMatchDate = targetMatchDateKey;
              sched.lastPostedDate = todayKey;
              if (sched.oneTime) {
                sched.enabled = false;
                sched.completed = true;
              }
              persistPolls();
            } else {
              console.log(`[recurring-poll] Schedule ${scheduleId} on ${targetMatchDateKey} will retry on next sweep (attempt ${attemptEntry.count}/${MAX_POST_RETRIES + 1}).`);
              persistPolls();
            }
          } else {
            console.log(`[recurring-poll] Successfully posted recurring poll for schedule ${scheduleId} in ${targetChatId}`);
            delete sched.postAttempts[targetMatchDateKey];
            sched.postedMatchDates.push(targetMatchDateKey);
            if (sched.postedMatchDates.length > 30) sched.postedMatchDates.shift();
            sched.lastPostedMatchDate = targetMatchDateKey;
            sched.lastPostedDate = todayKey;
            if (sched.oneTime) {
              sched.enabled = false;
              sched.completed = true;
            }
            if (preExistingBookings) {
              preExistingBookings.completed = true;
              preExistingBookings.pollCreated = true;
            }
            persistPolls();
          }
        } catch (pollErr) {
          console.error(`[recurring-poll] Exception creating recurring poll ${scheduleId} (attempt ${attemptEntry.count}/${MAX_POST_RETRIES + 1}):`, pollErr.message);
          if (attemptEntry.count > MAX_POST_RETRIES) {
            sched.postedMatchDates.push(targetMatchDateKey);
            if (sched.postedMatchDates.length > 30) sched.postedMatchDates.shift();
            sched.lastPostedMatchDate = targetMatchDateKey;
            sched.lastPostedDate = todayKey;
            persistPolls();
          } else {
            persistPolls();
          }
        } finally {
          inFlightTriggers.delete(triggerKey);
        }
      }
    }
  } catch (err) {
    console.error(`⚠️ [${new Date().toISOString()}] Error in checkAndPostRecurringPolls:`, err);
  } finally {
    isPostingSweepRunning = false;
  }
}

function formatLineupGen(mode, leadTimeMins = 30) {
  if (mode === 'fallback') {
    const leadStr = formatLookAround(leadTimeMins) || `${leadTimeMins} mins`;
    return `Fallback if no manual lineups posted (${leadStr} before play time)`;
  }
  if (mode === 'none') {
    return 'None (manual only)';
  }
  return 'Filled';
}

/**
 * Simulates a mock throwaway recurring poll instance for a given future date.
 * Does not track or save the poll in activePolls or disk, and does not book courts.
 */
async function simulateRecurringPoll({
  sock = null,
  recurringPolls,
  scheduleId = null,
  targetDayOrDate = null,
  chatId = null,
  sender = 'User',
  senderJid = null,
  createMatchPoll = null,
  customSanJoseParts = null
}) {
  if (!recurringPolls || recurringPolls.size === 0) {
    return '📅 No scheduled recurring polls found. Use "!recurringpolls" to view schedules.';
  }

  const isAllChat = !chatId || !chatId.endsWith('@g.us');
  const chatSchedules = [...recurringPolls.entries()].filter(([, s]) => isAllChat || s.remoteJid === chatId);

  let cleanId = scheduleId ? String(scheduleId).replace(/^[`'"]|[`'"]$/g, '').trim() : '';
  let effTarget = targetDayOrDate ? String(targetDayOrDate).trim() : null;

  if (cleanId && chatSchedules.length === 1 && !recurringPolls.has(cleanId)) {
    const isDayOrDate = DAY_LOOKUP?.[cleanId.toLowerCase()] !== undefined ||
      /^(?:today|tomorrow|next|\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}(?:\/\d{2,4})?)$/i.test(cleanId) ||
      parseDateToDateKey(cleanId, customSanJoseParts) !== null;
    if (isDayOrDate) {
      effTarget = cleanId;
      cleanId = chatSchedules[0][0];
    }
  }

  let targetKey = null;
  if (cleanId) {
    targetKey = findScheduleKey(recurringPolls, cleanId);
    if (!targetKey) {
      return `⚠️ Schedule ID "\`${cleanId}\`" was not found. Use "!recurringpolls" to view active schedule IDs.`;
    }
  } else {
    if (chatSchedules.length === 1) {
      targetKey = chatSchedules[0][0];
    } else if (chatSchedules.length === 0) {
      return '📅 No scheduled recurring polls found for this chat. Use "!recurringpolls" to check schedules.';
    } else {
      const ids = chatSchedules.map(([id]) => `\`${id}\``).join(', ');
      return `Please specify which schedule ID to simulate (${ids}). Example: "!simulaterecurring ${chatSchedules[0][0]}"`;
    }
  }

  const sched = recurringPolls.get(targetKey);
  const targetChatId = chatId || sched.remoteJid;

  let targetDateKey = null;
  let targetDayName = null;
  let targetDisplay = null;
  let targetDateMDY = null;

  if (effTarget) {
    const parsedDate = parseDateToDateKey(effTarget, customSanJoseParts);
    if (parsedDate) {
      targetDateKey = parsedDate.dateKey;
      targetDisplay = parsedDate.display;
      const targetDateObj = new Date(Date.UTC(parsedDate.year, parsedDate.month, parsedDate.day));
      targetDayName = DAY_NAMES[targetDateObj.getUTCDay()];
      targetDateMDY = `${parsedDate.month + 1}/${parsedDate.day}/${parsedDate.year}`;
    } else {
      targetDateMDY = scvcc.resolveDateToMDY(effTarget);
      targetDisplay = scvcc.formatDisplayDate(targetDateMDY);
      const [m, d, y] = targetDateMDY.split('/').map(Number);
      const targetDateObj = new Date(Date.UTC(y, m - 1, d));
      targetDayName = DAY_NAMES[targetDateObj.getUTCDay()];
      targetDateKey = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    }
  } else {
    const nextInst = getNextInstanceDate(sched, customSanJoseParts);
    if (!nextInst) {
      return `⚠️ No upcoming instances found for schedule \`${sched.id || targetKey}\`.`;
    }
    targetDateKey = nextInst.dateKey;
    targetDayName = nextInst.dayName;
    targetDisplay = nextInst.display;
    const [y, m, d] = targetDateKey.split('-').map(Number);
    targetDateMDY = `${m}/${d}/${y}`;
  }

  const creatorName = sched.creator?.name || sender || 'Player 1';
  const creatorJid = sched.creator?.jid || senderJid || null;
  const effectiveLineupGen = sched.lineupGeneration || 'filled';
  const whenStr = `${targetDayName} ${sched.matchTime}`;
  const preExistingBookings = (sched.advanceBookings && sched.advanceBookings[targetDateKey]) || null;

  const { isExplicitOverride, effectiveSize, maxCourts } = resolveInstanceSlotSize(sched, targetDateKey);

  if (!createMatchPoll) {
    const pollCommands = require('../commands/poll');
    createMatchPoll = pollCommands.createMatchPoll;
  }

  const res = await createMatchPoll(
    sock,
    targetChatId,
    effectiveSize,
    whenStr,
    targetDayName,
    sched.matchTime,
    creatorName,
    creatorJid,
    sched.includeCreator,
    null,
    false,
    true, // isCommand
    effectiveLineupGen === 'none',
    Boolean(sched.checkCourts ?? true),
    sched.includePrebookedSpots || sched['prebooked-spots'] || false,
    true, // isRecurring
    sched.id || targetKey,
    null,
    'none', // do not pre-book
    sched.bookingPlayers || null,
    sched.preBookCourts || null,
    sched.bookingStrategy || null,
    preExistingBookings,
    {
      targetDateMDY,
      targetGroupJid: sched.remoteJid,
      lookAround: sched.lookAround || null,
      slotCheck: sched.slotCheck,
      lineupGeneration: effectiveLineupGen,
      lineupLeadTime: sched.lineupLeadTime,
      reminders: sched.reminders !== false,
      maxCourts,
      bookingCourtPreference: sched.bookingCourtPreference || null,
      timeSlots: sched.timeSlots || null,
      slotOverride: isExplicitOverride ? effectiveSize : undefined,
      multiVote: sched.multiVote !== undefined ? sched.multiVote : null,
      multiSessionMode: sched.multiSessionMode || null,
      simulate: true,
      isSimulation: true,
      skippedCourts: sched.instanceCourtSkips?.[targetDateKey] || []
    }
  );

  if (res?.err) {
    return res.message || res.err;
  }

  let spotCount = res.isMultiTime
    ? `Multi-time (${res.timeSlots?.length || res.votingSpotsCount} time options, ${res.multiVote !== false ? 'multiple votes allowed' : 'single vote only'}, ${res.multiSessionMode === 'single_session' ? '1 session per player' : 'independent sessions'})`
    : (res.size ? `${res.size} spots (${res.votingSpotsCount} voting slots)` : 'Opt-in (Yes/No)');
  if (isExplicitOverride) {
    spotCount += ' *(overridden for this instance)*';
  }
  const courtDetails = [];
  if (Array.isArray(res.prebookedCourts) && res.prebookedCourts.length > 0) {
    for (const pb of res.prebookedCourts) {
      courtDetails.push(`• ${pb.court} (${pb.player || 'Pre-booked'})`);
    }
  }
  if (Array.isArray(res.freeCourts) && res.freeCourts.length > 0) {
    for (const fc of res.freeCourts) {
      courtDetails.push(`• ${fc.court} (Available)`);
    }
  }
  if (Array.isArray(res.tentativeCourts) && res.tentativeCourts.length > 0) {
    for (const tc of res.tentativeCourts) {
      courtDetails.push(`• ${tc.court} (Tentative)`);
    }
  }
  const courtSection = courtDetails.length > 0
    ? `\n🏟️ *Courts (${res.totalCourtsCount || courtDetails.length}):*\n${courtDetails.join('\n')}`
    : (res.checkCourts ? '\n🏟️ *Courts:* None available' : '');

  const effLineupGen = res.lineupGeneration || sched.lineupGeneration || 'filled';
  const effLeadTime = res.lineupLeadTime || sched.lineupLeadTime || 30;
  const effReminders = res.reminders !== undefined ? res.reminders : (sched.reminders !== false);
  const effSlotCheck = res.slotCheck !== undefined ? res.slotCheck : sched.slotCheck;
  const effLookAround = res.lookAround || sched.lookAround;
  const effMaxCourts = res.maxCourts || sched.maxCourts || sched['max-courts'];
  const effBookingType = res.courtBookingType || sched.courtBookingType;

  const flagLines = [
    `⚙️ *Lineup Generation:* ${formatLineupGen(effLineupGen, effLeadTime)}`,
    `🎯 *Slot Check:* ${effSlotCheck === false ? 'Disabled' : 'Enabled'}`,
    `🔔 *Reminders:* ${effReminders === false ? 'Off' : 'On'}`,
    effLookAround ? `⏱️ *Look Around:* ${formatLookAround(effLookAround)}` : null,
    effMaxCourts ? `🎾 *Max Courts:* ${effMaxCourts}` : null,
    (effBookingType && effBookingType !== 'none') ? `📝 *Court Booking Type:* ${effBookingType === 'pre-book' ? 'Pre-book' : effBookingType}` : null
  ].filter(Boolean);

  const flagSection = flagLines.length > 0 ? `\n${flagLines.join('\n')}` : '';

  return `🎾 *Mock Poll Simulation (Throwaway - Not Tracked)*\n` +
    `📋 *Schedule:* \`${sched.id || targetKey}\` (${sched.matchTime} on ${sched.daysDisplay || sched.days})\n` +
    `📅 *Target Match Date:* ${targetDisplay} at ${sched.matchTime}\n` +
    `👥 *Poll Spots:* ${spotCount}${courtSection}${flagSection}\n\n` +
    `ℹ️ *Note:* Mock throwaway poll generated to preview how the poll will look on this date. It is not saved or tracked, and no courts were booked.`;
}

module.exports = {
  isPollCreatedForMatchDate,
  detectManualPlayerBookings,
  pruneExpiredAdvanceBookings,
  checkAndExecuteAdvanceBookings,
  checkAndPostRecurringPolls,
  simulateRecurringPoll
};
