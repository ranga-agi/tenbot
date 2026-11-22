/**
 * Instance-Level Recurring Poll Overrides (Skip/Unskip, Slot Overrides, Court Skips)
 */

const pollTime = require('../pollTime');
const scvcc = require('../scvcc');
const {
  normalizeCourtList,
  getUpcomingInstanceDates,
  getNextInstanceDate
} = require('./dates');
const { extractSkipArgs } = require('./parsers');
const { findScheduleKey } = require('./schedules');

function matchesCourt(a, b) {
  if (!a || !b) return false;
  return a.toLowerCase() === b.toLowerCase() || a.replace(/\D/g, '') === b.replace(/\D/g, '');
}

/**
 * Resolves a schedule key either from explicit `scheduleId` or uniquely from the given chat.
 * Returns `{ targetKey, error }` cleanly for handlers where `scheduleId` is optional.
 */
function resolveTargetScheduleForAction({ recurringPolls, scheduleId, chatId, exampleCmd }) {
  const cleanId = String(scheduleId || '').replace(/^["'`]|[{\"'`]$/g, '').trim();
  const isAllChat = !chatId || !chatId.endsWith('@g.us');
  const chatSchedules = [...recurringPolls.entries()].filter(([, s]) => isAllChat || s.remoteJid === chatId);

  if (cleanId) {
    const found = findScheduleKey(recurringPolls, cleanId);
    if (!found) {
      return { error: `⚠️ Schedule ID "\`${cleanId}\`" was not found. Use "!recurringpolls" to view active schedule IDs.`, isAllChat };
    }
    return { targetKey: found, isAllChat };
  }

  if (chatSchedules.length === 1) {
    return { targetKey: chatSchedules[0][0], isAllChat };
  }
  if (chatSchedules.length === 0) {
    return { error: '📅 No scheduled recurring polls found for this chat. Use "!recurringpolls" to check schedules.', isAllChat };
  }
  const ids = chatSchedules.map(([id]) => `\`${id}\``).join(', ');
  return { error: `Please specify which schedule ID to set slots for (${ids}). Example: "${exampleCmd.replace('{id}', chatSchedules[0][0])}"`, isAllChat };
}

/**
 * Skips a single scheduled instance for a recurring poll (e.g. next instance or a specific date/day).
 * If the instance was already created as an active poll on WhatsApp, cancels and deletes it.
 * Subsequent future instances remain active and scheduled.
 */
async function skipRecurringPollInstance({
  recurringPolls,
  activePolls = null,
  persistPolls,
  cancelOrDeletePoll = null,
  sock = null,
  scheduleId,
  targetDayOrDate = null,
  count = 1,
  chatId = null,
  sender = 'User'
}) {
  const extracted = extractSkipArgs(scheduleId, targetDayOrDate);
  const cleanId = extracted.scheduleId || '';
  const effTarget = extracted.targetDayOrDate;
  const effCount = (count && parseInt(count, 10) > 1) ? parseInt(count, 10) : extracted.count;

  if (!cleanId) {
    return 'Please provide the schedule ID to skip an instance for, e.g. "!skipinstance rec_1" or "!skipinstance rec_1 3". Use "!recurringpolls" to view active IDs.';
  }

  const targetKey = findScheduleKey(recurringPolls, cleanId);
  if (!targetKey) {
    return `⚠️ Schedule ID "\`${cleanId}\`" was not found. Use "!recurringpolls" to view active schedule IDs.`;
  }

  const sched = recurringPolls.get(targetKey);
  const targetInstances = getUpcomingInstanceDates(sched, null, effCount, effTarget);
  if (!targetInstances || targetInstances.length === 0) {
    const filterDesc = effTarget ? ` matching "${effTarget}"` : '';
    return `⚠️ No upcoming match instance found${filterDesc} for schedule \`${targetKey}\` (${sched.matchDisplay} on ${sched.daysDisplay || 'scheduled days'}).`;
  }

  if (!Array.isArray(sched.skippedMatchDates)) {
    sched.skippedMatchDates = [];
  }
  if (!Array.isArray(sched.postedMatchDates)) {
    sched.postedMatchDates = [];
  }

  const deletedPollNotes = [];

  for (const targetInstance of targetInstances) {
    let activeInstancePollId = null;
    let activeInstancePollState = null;
    if (activePolls) {
      for (const [id, state] of activePolls.entries()) {
        if (state.status === 'cancelled' || state.status === 'expired') continue;
        const sId = state.scheduleId;
        if (sId && sId.toLowerCase() === targetKey.toLowerCase()) {
          if (state.playAt) {
            const playDate = new Date(state.playAt);
            if (!Number.isNaN(playDate.getTime())) {
              const sjParts = pollTime.getSanJoseParts(playDate);
              const pKey = `${sjParts.year}-${String(sjParts.month + 1).padStart(2, '0')}-${String(sjParts.day).padStart(2, '0')}`;
              if (pKey === targetInstance.dateKey) {
                activeInstancePollId = id;
                activeInstancePollState = state;
                break;
              }
            }
          }
        }
      }
    }

    if (activeInstancePollId && typeof cancelOrDeletePoll === 'function') {
      try {
        await cancelOrDeletePoll(sock, activeInstancePollState.remoteJid || chatId, activeInstancePollId);
        deletedPollNotes.push(`The active poll for ${targetInstance.display} was deleted from WhatsApp.`);
      } catch (err) {
        console.error(`[recurring-poll] Failed to delete active poll ${activeInstancePollId} when skipping instance:`, err.message);
      }
    }

    if (!sched.skippedMatchDates.includes(targetInstance.dateKey)) {
      sched.skippedMatchDates.push(targetInstance.dateKey);
    }
    if (!sched.postedMatchDates.includes(targetInstance.dateKey)) {
      sched.postedMatchDates.push(targetInstance.dateKey);
    }
  }

  persistPolls();
  console.log(`[recurring-poll] Skipped ${targetInstances.length} instance(s) for schedule ${targetKey} by ${sender}: [${targetInstances.map((ti) => ti.dateKey).join(', ')}]`);

  let instancesDesc = '';
  if (targetInstances.length === 1) {
    instancesDesc = `• *Skipped Match:* ${targetInstances[0].display}\n`;
  } else {
    instancesDesc = `• *Skipped ${targetInstances.length} Upcoming Instances:*\n` + targetInstances.map((ti) => `  - ${ti.display}`).join('\n') + '\n';
  }

  const deletedText = deletedPollNotes.length > 0 ? `• *Active WhatsApp Poll(s) Deleted:*\n${deletedPollNotes.map((n) => `  - ${n}`).join('\n')}\n` : '';

  return `⏭️ *Skipped ${targetInstances.length > 1 ? `${targetInstances.length} Poll Instances` : 'Poll Instance'} for Recurring Schedule \`${targetKey}\` (${sched.matchDisplay}):*\n` +
    instancesDesc +
    deletedText +
    `• *Schedule Status:* Remains active. Subsequent instances after these will post automatically as scheduled.\n` +
    `_(To undo, run "!unskipinstance ${targetKey} ${targetInstances.length > 1 ? targetInstances.length : targetInstances[0].dateKey}")_`;
}

/**
 * Restores a skipped instance for a recurring poll schedule.
 */
async function unskipRecurringPollInstance({
  recurringPolls,
  persistPolls,
  scheduleId,
  targetDayOrDate = null,
  sender = 'User'
}) {
  const cleanId = String(scheduleId || '').replace(/^["']|["']$/g, '').trim();
  if (!cleanId) {
    return 'Please provide the schedule ID to unskip, e.g. "!unskipinstance rec_1". Use "!recurringpolls" to view active IDs.';
  }

  const targetKey = findScheduleKey(recurringPolls, cleanId);
  if (!targetKey) {
    return `⚠️ Schedule ID "\`${cleanId}\`" was not found. Use "!recurringpolls" to view active schedule IDs.`;
  }

  const sched = recurringPolls.get(targetKey);
  if (!Array.isArray(sched.skippedMatchDates) || sched.skippedMatchDates.length === 0) {
    return `ℹ️ No skipped instances recorded for recurring schedule \`${targetKey}\`.`;
  }

  let datesToUnskip = [];
  const cleanTarget = targetDayOrDate ? String(targetDayOrDate).trim().toLowerCase() : '';

  if (cleanTarget === 'all') {
    datesToUnskip = [...sched.skippedMatchDates];
  } else if (/^\d+$/.test(cleanTarget)) {
    const unskipCount = Math.min(sched.skippedMatchDates.length, parseInt(cleanTarget, 10));
    datesToUnskip = sched.skippedMatchDates.slice(0, unskipCount);
  } else if (cleanTarget) {
    const matched = getNextInstanceDate(sched, null, cleanTarget);
    if (matched && sched.skippedMatchDates.includes(matched.dateKey)) {
      datesToUnskip = [matched.dateKey];
    } else {
      for (const d of sched.skippedMatchDates) {
        if (d.includes(cleanTarget) || cleanTarget.includes(d)) {
          datesToUnskip = [d];
          break;
        }
      }
    }
  }

  if (datesToUnskip.length === 0) {
    datesToUnskip = [sched.skippedMatchDates[0]];
  }

  sched.skippedMatchDates = sched.skippedMatchDates.filter((d) => !datesToUnskip.includes(d));
  if (Array.isArray(sched.postedMatchDates)) {
    sched.postedMatchDates = sched.postedMatchDates.filter((d) => !datesToUnskip.includes(d));
  }
  if (datesToUnskip.includes(sched.lastPostedMatchDate)) {
    sched.lastPostedMatchDate = sched.postedMatchDates[sched.postedMatchDates.length - 1] || null;
  }

  persistPolls();
  console.log(`[recurring-poll] Unskipped ${datesToUnskip.length} instance(s) for schedule ${targetKey}: [${datesToUnskip.join(', ')}] by ${sender}`);

  return `▶️ *Restored ${datesToUnskip.length > 1 ? `${datesToUnskip.length} Skipped Instances` : 'Skipped Instance'} for Recurring Schedule \`${targetKey}\`:*\n` +
    `• *Restored Match Date(s):* ${datesToUnskip.join(', ')}\n` +
    `• Polls for these matches will post automatically as scheduled.`;
}

/**
 * Overrides the number of slots for a future instance of a recurring poll schedule.
 */
async function overrideRecurringPollInstanceSlots({
  recurringPolls,
  activePolls = null,
  persistPolls,
  scheduleId,
  targetDayOrDate = null,
  slots = null,
  chatId = null,
  sender = 'User',
  customSanJoseParts = null
}) {
  if (!recurringPolls || recurringPolls.size === 0) {
    return '📅 No scheduled recurring polls found. Use "!recurringpolls" to view schedules.';
  }

  const { targetKey, error, isAllChat } = resolveTargetScheduleForAction({
    recurringPolls,
    scheduleId,
    chatId,
    exampleCmd: '!setslots {id} Friday 8'
  });
  if (error) return error;

  const sched = recurringPolls.get(targetKey);

  if (slots === null || slots === undefined) {
    return `Please specify the number of slots to set for the future instance, e.g. "!setslots ${targetKey} Friday 8" or "!setslots ${targetKey} Friday reset".`;
  }

  const isReset = typeof slots === 'string' && /^(?:reset|clear|none|remove|default|auto)$/i.test(slots.trim());
  const cleanTarget = targetDayOrDate ? String(targetDayOrDate).trim() : null;

  if (isReset) {
    if (cleanTarget && /^all$/i.test(cleanTarget)) {
      delete sched.instanceSlotOverrides;
      persistPolls();
      console.log(`[recurring-poll] Cleared all instance slot overrides for schedule ${targetKey} by ${sender}`);
      return `✅ *Cleared All Future Instance Slot Overrides for Recurring Schedule \`${targetKey}\`:*\n` +
        `• Future instances will use default schedule settings and calculations.`;
    }

    const upcoming = getUpcomingInstanceDates(sched, customSanJoseParts, 1, cleanTarget);
    if (!upcoming || upcoming.length === 0) {
      return `⚠️ No upcoming match date found for "${cleanTarget || 'next instance'}" on schedule \`${targetKey}\`.`;
    }
    const targetInstance = upcoming[0];
    if (sched.instanceSlotOverrides && typeof sched.instanceSlotOverrides === 'object') {
      delete sched.instanceSlotOverrides[targetInstance.dateKey];
      if (Object.keys(sched.instanceSlotOverrides).length === 0) {
        delete sched.instanceSlotOverrides;
      }
    }

    persistPolls();
    console.log(`[recurring-poll] Removed slot override for ${targetInstance.dateKey} on schedule ${targetKey} by ${sender}`);
    return `✅ *Removed Slot Override for Recurring Schedule \`${targetKey}\`:*\n` +
      `• *Match Instance:* ${targetInstance.display}\n` +
      `• This instance will now use normal schedule settings and calculations.`;
  }

  let slotCount = null;
  let optInCapNum = null;
  const optCapMatch = typeof slots === 'string' && slots.trim().match(/^(?:opt-?in|optin|yes\s*\/?\s*no|yesno)[:\s]+(\d+)$/i);
  if (optCapMatch) {
    const num = parseInt(optCapMatch[1], 10);
    if (!Number.isInteger(num) || num <= 0 || num > 40) {
      return `⚠️ Please provide a valid positive number of slots (1-40) or "opt-in" / "reset", e.g. \`!setslots ${targetKey} Friday opt-in 8\`.`;
    }
    slotCount = `opt-in:${num}`;
    optInCapNum = num;
  } else if (typeof slots === 'string' && /^(?:opt-?in|optin|yes\s*\/?\s*no|yesno)$/i.test(slots.trim())) {
    slotCount = 'opt-in';
  } else {
    const num = parseInt(slots, 10);
    if (!Number.isInteger(num) || num <= 0 || num > 40) {
      return `⚠️ Please provide a valid positive number of slots (1-40) or "opt-in" / "reset", e.g. \`!setslots ${targetKey} Friday 8\`.`;
    }
    slotCount = num;
  }

  const upcoming = getUpcomingInstanceDates(sched, customSanJoseParts, 1, cleanTarget);
  if (!upcoming || upcoming.length === 0) {
    return `⚠️ No upcoming match date found for "${cleanTarget || 'next instance'}" on schedule \`${targetKey}\`.`;
  }
  const targetInstance = upcoming[0];

  if (!sched.instanceSlotOverrides || typeof sched.instanceSlotOverrides !== 'object') {
    sched.instanceSlotOverrides = {};
  }
  sched.instanceSlotOverrides[targetInstance.dateKey] = slotCount;

  let activePollNote = '';
  if (activePolls) {
    for (const [pId, pState] of activePolls.entries()) {
      if ((pState.remoteJid === sched.remoteJid || isAllChat) && (pState.status === 'active' || pState.status === 'filled')) {
        const pDateMDY = scvcc.resolveDateToMDY(pState.when || pState.playAt);
        const targetMDY = scvcc.resolveDateToMDY(targetInstance.dateKey);
        if (pDateMDY && targetMDY && pDateMDY === targetMDY) {
          if (typeof slotCount === 'number') {
            pState.slotLimit = slotCount;
            pState.slotOverride = slotCount;
            pState.size = slotCount;
            activePollNote = `\n• *Active Poll Updated:* Applied slot limit of *${slotCount}* to currently active poll message (\`${pId}\`).`;
          } else if (optInCapNum !== null) {
            if (pState.originalSize === undefined) pState.originalSize = pState.size;
            pState.slotLimit = optInCapNum;
            pState.slotOverride = slotCount;
            pState.size = optInCapNum;
            activePollNote = `\n• *Active Poll Updated:* Applied opt-in limit of *${optInCapNum} spots* to currently active poll message (\`${pId}\`).`;
          } else if (slotCount === 'opt-in' && pState.type === 'opt_in') {
            pState.slotLimit = null;
            pState.slotOverride = 'opt-in';
            pState.size = null;
            activePollNote = `\n• *Active Poll Updated:* Removed spot limit on currently active opt-in poll (\`${pId}\`).`;
          }
          break;
        }
      }
    }
  }

  persistPolls();
  console.log(`[recurring-poll] Set slot override for ${targetInstance.dateKey} to ${slotCount} on schedule ${targetKey} by ${sender}`);

  const slotDesc = slotCount === 'opt-in'
    ? 'Opt-in (Yes/No)'
    : (optInCapNum !== null
      ? `Opt-in (Yes/No, ${optInCapNum} spots)`
      : `${slotCount} slots`);
  return `🎯 *Future Instance Slot Override Set for Schedule \`${targetKey}\`:*\n` +
    `• *Target Match Instance:* ${targetInstance.display}\n` +
    `• *Overridden Slots:* *${slotDesc}*\n` +
    `• *Behavior:* Overrides all other settings, auto-calculations, court availability, and maximum court limits when this instance is posted.${activePollNote}\n` +
    `_(To undo, run "!setslots ${targetKey} ${cleanTarget || targetInstance.dateKey} reset")_`;
}

/**
 * Sets or clears court skips for an upcoming match instance of a recurring poll schedule.
 */
async function overrideRecurringPollInstanceCourtSkip({
  recurringPolls,
  persistPolls,
  scheduleId,
  targetDayOrDate = null,
  courts = null,
  action = 'skip',
  customSanJoseParts = null,
  chatId = null,
  sender = 'User',
  activePolls = null
}) {
  if (!recurringPolls || !recurringPolls.has(scheduleId)) {
    return `⚠️ Recurring schedule \`${scheduleId}\` was not found.`;
  }
  const sched = recurringPolls.get(scheduleId);
  const cleanTarget = targetDayOrDate ? String(targetDayOrDate).trim() : null;

  const isReset = action === 'unskip' || action === 'reset' || action === 'clear' || action === 'remove';
  let courtList = normalizeCourtList(courts);
  if ((action === 'clear' || action === 'reset') && courtList.length === 0) {
    courtList = ['all'];
  }

  if (isReset) {
    if ((cleanTarget && /^all$/i.test(cleanTarget)) || courtList.includes('all')) {
      if (courtList.includes('all') && cleanTarget && !/^all$/i.test(cleanTarget)) {
        const upcoming = getUpcomingInstanceDates(sched, customSanJoseParts, 1, cleanTarget);
        if (!upcoming || upcoming.length === 0) {
          return `⚠️ No upcoming match date found for "${cleanTarget || 'next instance'}" on schedule \`${scheduleId}\`.`;
        }
        const targetInstance = upcoming[0];
        if (sched.instanceCourtSkips && typeof sched.instanceCourtSkips === 'object') {
          delete sched.instanceCourtSkips[targetInstance.dateKey];
          if (Object.keys(sched.instanceCourtSkips).length === 0) {
            delete sched.instanceCourtSkips;
          }
        }
        if (persistPolls) persistPolls(sched.remoteJid);
        return `✅ *Cleared Skipped Courts for Recurring Schedule \`${scheduleId}\`:*\n` +
          `• *Match Instance:* ${targetInstance.display}\n` +
          `• All courts can now be considered and booked for this match instance.`;
      }
      delete sched.instanceCourtSkips;
      if (persistPolls) persistPolls(sched.remoteJid);
      console.log(`[recurring-poll] Cleared all instance court skips for schedule ${scheduleId} by ${sender}`);
      return `✅ *Cleared All Future Instance Court Skips for Recurring Schedule \`${scheduleId}\`:*\n` +
        `• Future instances will use default court availability and settings.`;
    }

    const upcoming = getUpcomingInstanceDates(sched, customSanJoseParts, 1, cleanTarget);
    if (!upcoming || upcoming.length === 0) {
      return `⚠️ No upcoming match date found for "${cleanTarget || 'next instance'}" on schedule \`${scheduleId}\`.`;
    }
    const targetInstance = upcoming[0];
    if (sched.instanceCourtSkips && typeof sched.instanceCourtSkips === 'object' && sched.instanceCourtSkips[targetInstance.dateKey]) {
      if (courtList.length > 0 && !courtList.includes('all')) {
        sched.instanceCourtSkips[targetInstance.dateKey] = sched.instanceCourtSkips[targetInstance.dateKey].filter(
          (c) => !courtList.some((u) => matchesCourt(u, c))
        );
        if (sched.instanceCourtSkips[targetInstance.dateKey].length === 0) {
          delete sched.instanceCourtSkips[targetInstance.dateKey];
        }
      } else {
        delete sched.instanceCourtSkips[targetInstance.dateKey];
      }
      if (Object.keys(sched.instanceCourtSkips).length === 0) {
        delete sched.instanceCourtSkips;
      }
    }
    if (persistPolls) persistPolls(sched.remoteJid);
    return `✅ *Updated Court Skips for Recurring Schedule \`${scheduleId}\`:*\n` +
      `• *Match Instance:* ${targetInstance.display}\n` +
      `• *Remaining Skipped Courts:* ${sched.instanceCourtSkips?.[targetInstance.dateKey]?.join(', ') || 'None'}`;
  }

  if (courtList.length === 0) {
    return `⚠️ Please specify which court(s) to skip, e.g. \`!modifyinstance ${scheduleId} Friday --skip-court 3\` or \`--skip-court "Court 3, Court 5"\`.`;
  }

  const upcoming = getUpcomingInstanceDates(sched, customSanJoseParts, 1, cleanTarget);
  if (!upcoming || upcoming.length === 0) {
    return `⚠️ No upcoming match date found for "${cleanTarget || 'next instance'}" on schedule \`${scheduleId}\`.`;
  }
  const targetInstance = upcoming[0];

  if (!sched.instanceCourtSkips || typeof sched.instanceCourtSkips !== 'object') {
    sched.instanceCourtSkips = {};
  }
  const existing = Array.isArray(sched.instanceCourtSkips[targetInstance.dateKey]) ? sched.instanceCourtSkips[targetInstance.dateKey] : [];
  const merged = [...existing];
  for (const c of courtList) {
    if (!merged.some((m) => matchesCourt(m, c))) {
      merged.push(c);
    }
  }
  sched.instanceCourtSkips[targetInstance.dateKey] = merged;

  let advanceBookingNote = '';
  const advEntry = sched.advanceBookings?.[targetInstance.dateKey];
  const advCourts = advEntry?.autoBookedCourts || advEntry?.advanceBookedCourts || [];
  const existingAdvMatches = advCourts.filter((ab) => merged.some((m) => matchesCourt(m, ab.court)));
  if (existingAdvMatches.length > 0) {
    const details = existingAdvMatches.map((b) => `${b.court}${b.reservationId ? ` (ID: \`${b.reservationId}\`)` : ''}`).join(', ');
    advanceBookingNote = `\n• *Existing Booking Note:* ${details} was already booked in advance. The club reservation remains active. (To cancel with club: \`!cancelcourt <reservationId>\`).`;
  }

  let activePollNote = '';
  if (activePolls) {
    const isAllChat = !chatId || !chatId.endsWith('@g.us');
    for (const [pId, pState] of activePolls.entries()) {
      if ((pState.remoteJid === sched.remoteJid || isAllChat) && (pState.status === 'active' || pState.status === 'filled')) {
        const pDateMDY = scvcc.resolveDateToMDY(pState.when || pState.playAt);
        const targetMDY = scvcc.resolveDateToMDY(targetInstance.dateKey);
        if (pDateMDY && targetMDY && pDateMDY === targetMDY) {
          pState.skippedCourts = merged;
          if (Array.isArray(pState.unbookedCourts)) {
            pState.unbookedCourts = pState.unbookedCourts.filter((uc) => !merged.some((mc) => matchesCourt(mc, uc.court)));
          }
          if (Array.isArray(pState.tentativeCourts)) {
            pState.tentativeCourts = pState.tentativeCourts.filter((tc) => !merged.some((mc) => matchesCourt(mc, tc.court)));
          }
          activePollNote = `\n• *Active Poll Updated:* Excluded *${merged.join(', ')}* from active poll message (\`${pId}\`).`;
          break;
        }
      }
    }
  }

  if (persistPolls) persistPolls(sched.remoteJid);
  console.log(`[recurring-poll] Set court skip for ${targetInstance.dateKey} to [${merged.join(', ')}] on schedule ${scheduleId} by ${sender}`);

  return `✅ *Future Instance Court Skip Set for Recurring Schedule \`${scheduleId}\`:*\n` +
    `• *Target Match Instance:* ${targetInstance.display}\n` +
    `• *Skipped Court(s):* 🚫 ${merged.join(', ')}\n` +
    `• These courts will not be booked or considered available for this match instance.${advanceBookingNote}${activePollNote}\n` +
    `_(To undo, run "!modifyinstance ${scheduleId} ${cleanTarget || targetInstance.dateKey} --unskip-court ${merged[0]}")_`;
}

module.exports = {
  skipRecurringPollInstance,
  unskipRecurringPollInstance,
  overrideRecurringPollInstanceSlots,
  overrideRecurringPollInstanceCourtSkip
};
