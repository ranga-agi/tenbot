/**
 * Court Pre-Booking, On-Demand Booking, Release & Cancellation
 */

const { jidNormalizedUser } = require('@whiskeysockets/baileys');

const ratings = require('../../ratings');
const namesStore = require('../../names');
const { sendMessageAndRecord } = require('../../botMessage');
const scvcc = require('../../scvcc');
const groupsConfig = require('../../groupsConfig');
const courtsConfig = require('../../courtsConfig');
const pollTime = require('../../pollTime');
const pairHistory = require('../../pairHistory');
const playerActivity = require('../../playerActivity');
const {
  generateMatchups,
  formatMatchups,
  summarizeSchedule
} = require('../../matchups');
const { isUserAdmin, isSameUser, extractGroupFlag } = require('../groupCommands');
const courtCommands = require('../courtCommands');
const { sendBookingNotifications, formatCourtBookingTitleLine } = courtCommands;

const { getSanJoseParts, parseLookAround, getCandidateTimes, parseTimeString } = pollTime;

const {
  storeKey,
  isCourtSkipped,
  nameFor,
  isValidPlayerCount,
  resolveManualPollPlayers,
  resolveFixedPollRoster,
  getPollVoters,
  deletePollFromWhatsApp,
  shouldAutoGenerateLineupOnFill,
  findSpecificPoll,
  getPollScheduleId,
  formatMatchHeaderTime,
  checkAndNotifyInvalidSlotVotes
} = require('./roster');

async function releaseAllCourtsForPollState(sock, pollState, remoteJid, context) {
  if (!pollState) return [];
  const pollChatId = pollState.remoteJid || remoteJid;
  const releasedCourts = [];
  const cancelledReservationIds = new Set();

  const cancelReservation = async (resId, label) => {
    if (!resId || cancelledReservationIds.has(resId)) return;
    cancelledReservationIds.add(resId);
    try {
      console.log(`[poll] Cancelling SCVCC court reservation ${resId} for ${label} on poll ${pollState.id || ""}`);
      const cancelRes = await scvcc.cancelCourtReservation(resId, pollChatId);
      if (cancelRes && cancelRes.success && cancelRes.message && sock) {
        await (courtCommands.sendBookingNotifications || sendBookingNotifications)(sock, pollChatId, cancelRes.message);
      }
    } catch (err) {
      console.error(`[poll] Failed to cancel SCVCC reservation ${resId} for ${label}:`, err.message);
    }
  };

  // 1. Multi-time slots
  if (Array.isArray(pollState.timeSlots)) {
    for (const slot of pollState.timeSlots) {
      const slotCourts = Array.isArray(slot.prebookedCourts) ? [...slot.prebookedCourts] : [];
      const additional = [
        ...(Array.isArray(slot.autoBookedCourts) ? slot.autoBookedCourts : []),
        ...(Array.isArray(slot.advanceBookedCourts) ? slot.advanceBookedCourts : []),
        ...(Array.isArray(slot.manuallyBookedCourts) ? slot.manuallyBookedCourts : [])
      ];
      for (const addCourt of additional) {
        const addLabel = formatCourtLabel(typeof addCourt === "string" ? addCourt : addCourt?.court).toLowerCase();
        if (!slotCourts.some(sc => formatCourtLabel(typeof sc === "string" ? sc : sc?.court).toLowerCase() === addLabel)) {
          slotCourts.push(addCourt);
        }
      }

      for (const sc of slotCourts) {
        const rawC = typeof sc === "string" ? sc : sc?.court;
        const cLabel = rawC ? formatCourtLabel(rawC) : "Court";
        const displayLabel = `${cLabel} (${slot.timeDisplay || slot.label || "slot"})`;
        releasedCourts.push(displayLabel);

        let resId = sc?.reservationId || null;
        if (!resId && Array.isArray(slot.advanceBookedCourts)) {
          const adv = slot.advanceBookedCourts.find(b => b && formatCourtLabel(typeof b === "string" ? b : b.court).toLowerCase() === cLabel.toLowerCase());
          if (adv?.reservationId) resId = adv.reservationId;
        }
        if (!resId && Array.isArray(slot.autoBookedCourts)) {
          const ab = slot.autoBookedCourts.find(b => b && formatCourtLabel(typeof b === "string" ? b : b.court).toLowerCase() === cLabel.toLowerCase());
          if (ab?.reservationId) resId = ab.reservationId;
        }
        await cancelReservation(resId, displayLabel);
      }

      slot.prebookedCourts = [];
      slot.autoBookedCourts = [];
      slot.advanceBookedCourts = [];
      slot.manuallyBookedCourts = [];
      slot.size = 0;
      slot.slotLimit = 0;
      slot.status = "stopped";
    }
  }

  // 2. Single-time / top-level courts
  const prebooked = Array.isArray(pollState.prebookedCourts) ? [...pollState.prebookedCourts] : [];
  const autoBooked = Array.isArray(pollState.autoBookedCourts) ? [...pollState.autoBookedCourts] : [];
  const advanceBooked = Array.isArray(pollState.advanceBookedCourts) ? [...pollState.advanceBookedCourts] : [];
  const manuallyBooked = Array.isArray(pollState.manuallyBookedCourts) ? [...pollState.manuallyBookedCourts] : [];

  const allTopCourts = [...prebooked];
  for (const c of [...autoBooked, ...advanceBooked, ...manuallyBooked]) {
    const cLabel = formatCourtLabel(typeof c === "string" ? c : c?.court).toLowerCase();
    if (!allTopCourts.some(tc => formatCourtLabel(typeof tc === "string" ? tc : tc?.court).toLowerCase() === cLabel)) {
      allTopCourts.push(c);
    }
  }
  if (pollState.court) {
    const cLabel = formatCourtLabel(pollState.court).toLowerCase();
    if (!allTopCourts.some(tc => formatCourtLabel(typeof tc === "string" ? tc : tc?.court).toLowerCase() === cLabel)) {
      allTopCourts.push(pollState.court);
    }
  }

  for (const c of allTopCourts) {
    const rawCourt = typeof c === "string" ? c : c?.court;
    const courtLabel = rawCourt ? formatCourtLabel(rawCourt) : "Court";
    releasedCourts.push(courtLabel);

    let reservationId = c?.reservationId || null;
    if (!reservationId) {
      const adv = [...autoBooked, ...advanceBooked, ...manuallyBooked].find(
        (b) => b && formatCourtLabel(typeof b === "string" ? b : b.court).toLowerCase() === courtLabel.toLowerCase()
      );
      if (adv?.reservationId) reservationId = adv.reservationId;
    }
    await cancelReservation(reservationId, courtLabel);
  }

  pollState.size = 0;
  pollState.slotLimit = 0;
  pollState.status = "stopped";
  pollState.prebookedCourts = [];
  pollState.autoBookedCourts = [];
  pollState.advanceBookedCourts = [];
  pollState.manuallyBookedCourts = [];
  pollState.court = null;

  return [...new Set(releasedCourts)];
}

function parseReleaseCourtsArgs(raw) {
  if (!raw || !raw.trim()) {
    return { target: null, countOrAll: null, specificCourt: null };
  }
  const trimmed = raw.trim();

  // Check if whole string is "all"
  if (/^all$/i.test(trimmed)) {
    return { target: null, countOrAll: 'all', specificCourt: null };
  }

  // Check if whole string is just a number (e.g. "1", "2")
  if (/^\d+$/.test(trimmed)) {
    return { target: null, countOrAll: parseInt(trimmed, 10), specificCourt: null };
  }

  // Check if whole string is a court name (e.g. "Court 3", "ct 3", "c3")
  if (/^(?:court\s*\d+|ct\s*\d+|c\d+)$/i.test(trimmed)) {
    return { target: null, countOrAll: 1, specificCourt: formatCourtLabel(trimmed) };
  }

  // Split by whitespace
  const parts = trimmed.split(/\s+/);

  // Check if last part is "all"
  if (/^all$/i.test(parts[parts.length - 1])) {
    const target = parts.slice(0, -1).join(' ').trim();
    return { target: target || null, countOrAll: 'all', specificCourt: null };
  }

  // Check if first part is "all" (e.g. "all 7pm")
  if (/^all$/i.test(parts[0])) {
    const target = parts.slice(1).join(' ').trim();
    return { target: target || null, countOrAll: 'all', specificCourt: null };
  }

  // Check if last parts are a court name (e.g. "7pm Court 3" or "rec_1 Court 2")
  if (parts.length >= 2) {
    const lastTwo = parts.slice(-2).join(' ');
    if (/^(?:court\s*\d+|ct\s*\d+|c\d+)$/i.test(lastTwo)) {
      const target = parts.slice(0, -2).join(' ').trim();
      return { target: target || null, countOrAll: 1, specificCourt: formatCourtLabel(lastTwo) };
    }
    const lastOne = parts[parts.length - 1];
    if (/^(?:court\s*\d+|ct\s*\d+|c\d+)$/i.test(lastOne)) {
      const target = parts.slice(0, -1).join(' ').trim();
      return { target: target || null, countOrAll: 1, specificCourt: formatCourtLabel(lastOne) };
    }
  }

  // Check if last part is a number (e.g. "7pm 1", "rec_1 2")
  if (/^\d+$/.test(parts[parts.length - 1])) {
    const count = parseInt(parts[parts.length - 1], 10);
    const target = parts.slice(0, -1).join(' ').trim();
    return { target: target || null, countOrAll: count, specificCourt: null };
  }

  // Check if first part is a number (e.g. "1 7pm")
  if (/^\d+$/.test(parts[0])) {
    const count = parseInt(parts[0], 10);
    const target = parts.slice(1).join(' ').trim();
    return { target: target || null, countOrAll: count, specificCourt: null };
  }

  // Otherwise, treat whole string as target poll
  return { target: trimmed, countOrAll: null, specificCourt: null };
}

async function handleReleasePollCourts(
  sock,
  targetChatId,
  sender,
  senderJid,
  text,
  context,
  groupQueryChatId = null,
  originChatId = null,
  overrideOptions = null
) {
  const { activePolls, recurringPolls, latestPollIdByChat, persistPolls } = context || {};
  let target = null;
  let countOrAll = null;
  let specificCourt = null;

  if (overrideOptions && typeof overrideOptions === 'object') {
    target = overrideOptions.target || null;
    countOrAll = overrideOptions.countOrAll !== undefined ? overrideOptions.countOrAll : null;
    specificCourt = overrideOptions.specificCourt || null;
  } else if (text) {
    const cleanCmd = text.replace(/^!(?:releasecourts?|releasepollcourts?)\s*/i, '').trim();
    const { remainingText } = extractGroupFlag(cleanCmd);
    const parsed = parseReleaseCourtsArgs(remainingText);
    target = parsed.target;
    countOrAll = parsed.countOrAll;
    specificCourt = parsed.specificCourt;
  }

  const effectiveChatId = groupQueryChatId || targetChatId;

  // If no count/all and no specific court was provided, show usage help
  if (countOrAll === null && !specificCourt) {
    return 'Please specify how many courts to release or "all":\n' +
      '• Usage: !releasecourt [pollId/time] <count/all>\n' +
      '• Examples: "!releasecourt 1", "!releasecourt all", "!releasecourt 7pm 1", "!releasecourt Court 3"';
  }

  let matchedPollId = null;
  let matchedPollState = null;

  if (target) {
    const found = findSpecificPoll(target, activePolls, recurringPolls, effectiveChatId);
    if (found) {
      matchedPollId = found.pollId;
      matchedPollState = found.pollState;
    } else if (activePolls) {
      const tLower = target.toLowerCase().trim();
      for (const [id, state] of activePolls.entries()) {
        const matchesChat = effectiveChatId ? (state.remoteJid === effectiveChatId) : true;
        if (!matchesChat) continue;
        if (id.toLowerCase() === tLower) {
          matchedPollId = id;
          matchedPollState = state;
          break;
        }
        const pName = (state.name || '').toLowerCase();
        const pWhen = (state.when || '').toLowerCase();
        if (pName.includes(tLower) || pWhen.includes(tLower) || tLower.includes(pWhen)) {
          matchedPollId = id;
          matchedPollState = state;
          break;
        }
      }
    }

    if (!matchedPollState) {
      return `⚠️ No active match poll found matching "${target}". Use "!activepolls" or "!pollstatus" to check active polls.`;
    }
  } else if (activePolls) {
    const chatPolls = [];
    for (const [id, state] of activePolls.entries()) {
      const matchesChat = effectiveChatId ? (state.remoteJid === effectiveChatId) : true;
      if (matchesChat && (state.status === 'active' || state.status === 'filled')) {
        chatPolls.push([id, state]);
      }
    }
    if (chatPolls.length === 1) {
      matchedPollId = chatPolls[0][0];
      matchedPollState = chatPolls[0][1];
    } else if (chatPolls.length > 1) {
      const descriptions = chatPolls
        .map(([id, state]) => `"${state.when || state.name || id}"`)
        .join(', ');
      const countExample = countOrAll || '1';
      return `Please specify which poll to release courts from: ${descriptions}. Example: "!releasecourt ${chatPolls[0][1].when || chatPolls[0][0]} ${countExample}"`;
    } else {
      const latestId = latestPollIdByChat?.get(effectiveChatId);
      if (latestId && activePolls.has(latestId)) {
        matchedPollId = latestId;
        matchedPollState = activePolls.get(latestId);
      }
    }
  }

  if (!matchedPollState) {
    return '⚠️ No active match poll found in this chat.';
  }

  // Permission check
  const schedId = getPollScheduleId(matchedPollState, recurringPolls);
  const sched = schedId && recurringPolls ? recurringPolls.get(schedId) : null;
  const isSchedCreator = sched?.creator ? isSameUser(sched.creator.jid, senderJid, sched.creator.name, sender) : false;
  const effectivePollCreator = matchedPollState.creator || matchedPollState.createdBy || null;
  const isPollCreator = effectivePollCreator ? isSameUser(effectivePollCreator.jid, senderJid, effectivePollCreator.name, sender) : false;
  const isAdmin = await isUserAdmin(sock, effectiveChatId, senderJid);

  if (!isSchedCreator && !isPollCreator && !isAdmin) {
    return '⚠️ Only the poll creator or group admins can release courts for this poll.';
  }

  if (matchedPollState.status === 'cancelled') {
    return '⚠️ This poll has already been cancelled.';
  }
  if (matchedPollState.status === 'resolved') {
    return '⚠️ Matchups have already been generated and recorded for this poll.';
  }

  const pollChatId = matchedPollState.remoteJid || effectiveChatId;
  const playersPerCourt = (matchedPollState.courtBookingType === 'singles' || matchedPollState.size === 2) ? 2 : 4;
  const pollTitle = matchedPollState.when || matchedPollState.name || 'Match Poll';

  // Multi-time poll handling
  if (matchedPollState.type === 'multi_time' && Array.isArray(matchedPollState.timeSlots)) {
    let targetSlots = matchedPollState.timeSlots;
    if (target) {
      const q = target.toLowerCase().trim();
      const parsedT = parseTimeString(q);
      const matchedSlots = matchedPollState.timeSlots.filter((s) => {
        const l = (s.label || '').toLowerCase();
        const optL = (s.optionLabel || '').toLowerCase();
        const tw = (s.timeWord || '').toLowerCase();
        if (l.includes(q) || optL.includes(q) || tw === q) return true;
        if (parsedT && s.timeWord) {
          const sp = parseTimeString(s.timeWord);
          if (sp && sp.hour === parsedT.hour && sp.minute === parsedT.minute) return true;
        }
        return false;
      });
      if (matchedSlots.length > 0) {
        targetSlots = matchedSlots;
      }
    }

    const cancelledSlotCourts = [];
    const isAllMulti = (countOrAll === 'all');
    const numReleaseMulti = isAllMulti ? 999 : (parseInt(countOrAll, 10) || 1);

    for (const slot of targetSlots) {
      const slotCourts = Array.isArray(slot.prebookedCourts) ? slot.prebookedCourts : [];
      let slotNumToRelease = isAllMulti ? (slotCourts.length || Math.ceil((slot.size || 4) / playersPerCourt)) : numReleaseMulti;
      if (slotCourts.length > 0 && slotNumToRelease > slotCourts.length) {
        slotNumToRelease = slotCourts.length;
      }

      const toRelease = slotCourts.slice(-slotNumToRelease);
      for (const sc of toRelease) {
        const rawC = typeof sc === 'string' ? sc : sc?.court;
        const cLabel = rawC ? formatCourtLabel(rawC) : 'Court';
        cancelledSlotCourts.push(`${cLabel} (${slot.timeDisplay || slot.label})`);

        let resId = sc?.reservationId || null;
        if (!resId && Array.isArray(slot.advanceBookedCourts)) {
          const adv = slot.advanceBookedCourts.find(b => b && formatCourtLabel(b.court).toLowerCase() === cLabel.toLowerCase());
          if (adv?.reservationId) resId = adv.reservationId;
        }
        if (resId) {
          try {
            const cancelRes = await scvcc.cancelCourtReservation(resId, pollChatId);
            if (cancelRes && cancelRes.success && cancelRes.message && sock) {
              await sendBookingNotifications(sock, pollChatId, cancelRes.message);
            }
          } catch (err) {
            console.error(`[poll] Failed to cancel SCVCC reservation ${resId}:`, err.message);
          }
        }

        if (Array.isArray(slot.prebookedCourts)) {
          slot.prebookedCourts = slot.prebookedCourts.filter(pb => formatCourtLabel(typeof pb === 'string' ? pb : pb.court).toLowerCase() !== cLabel.toLowerCase());
        }
        if (Array.isArray(matchedPollState.prebookedCourts)) {
          matchedPollState.prebookedCourts = matchedPollState.prebookedCourts.filter(pb => formatCourtLabel(typeof pb === 'string' ? pb : pb.court).toLowerCase() !== cLabel.toLowerCase());
        }
      }

      const newSlotSize = Math.max(0, (slot.size || 0) - slotNumToRelease * playersPerCourt);
      slot.size = newSlotSize;
      slot.slotLimit = newSlotSize;
      if (newSlotSize === 0) {
        slot.status = 'stopped';
      }
    }

    const allSlotsStopped = matchedPollState.timeSlots.every(s => (s.size === 0 || s.status === 'stopped'));
    if (allSlotsStopped || isAllMulti) {
      matchedPollState.size = 0;
      matchedPollState.slotLimit = 0;
      matchedPollState.status = 'stopped';
      await deletePollFromWhatsApp(sock, pollChatId, matchedPollId);
      if (persistPolls) persistPolls();

      const notifMsg = `🛑 *All courts released* for multi-time poll *${pollTitle}*.\n• Voting has been stopped and the poll has been closed.`;
      if (originChatId && originChatId !== pollChatId) {
        await sendMessageAndRecord(sock, pollChatId, { text: notifMsg });
      }
      return notifMsg;
    }

    if (persistPolls) persistPolls();
    const summaryLines = targetSlots.map(s => `• *${s.label}*: ${s.size} spots (${s.size === 0 ? 'Stopped' : 'Active'})`);
    const resultMsg = `🎾 *Released courts for multi-time poll *${pollTitle}*:\n` +
      (cancelledSlotCourts.length ? `• Released: ${cancelledSlotCourts.join(', ')}\n` : '') +
      `• Updated slot capacities:\n${summaryLines.join('\n')}`;

    if (originChatId && originChatId !== pollChatId) {
      await sendMessageAndRecord(sock, pollChatId, { text: resultMsg });
    }
    return resultMsg;
  }

  // Standard (single-time or opt-in) poll handling
  const prebooked = Array.isArray(matchedPollState.prebookedCourts) ? [...matchedPollState.prebookedCourts] : [];
  const autoBooked = Array.isArray(matchedPollState.autoBookedCourts) ? [...matchedPollState.autoBookedCourts] : [];
  const advanceBooked = Array.isArray(matchedPollState.advanceBookedCourts) ? [...matchedPollState.advanceBookedCourts] : [];

  let currentCourtsCount = prebooked.length;
  if (currentCourtsCount === 0) {
    if (autoBooked.length > 0) currentCourtsCount = autoBooked.length;
    else if (advanceBooked.length > 0) currentCourtsCount = advanceBooked.length;
    else if (matchedPollState.court) currentCourtsCount = 1;
    else if (matchedPollState.size) currentCourtsCount = Math.max(1, Math.ceil(matchedPollState.size / playersPerCourt));
    else currentCourtsCount = 1;
  }

  if (currentCourtsCount === 0 || matchedPollState.size === 0) {
    return `ℹ️ Poll "${matchedPollState.when || matchedPollState.name || matchedPollId}" has no booked courts or spots remaining.`;
  }

  let isAll = false;
  let numToRelease = 1;
  let courtsToRelease = [];

  if (specificCourt) {
    const targetLabel = formatCourtLabel(specificCourt).toLowerCase();
    const pool = prebooked.length > 0 ? prebooked : (autoBooked.length > 0 ? autoBooked : advanceBooked);
    const match = pool.find((c) => formatCourtLabel(typeof c === 'string' ? c : c?.court).toLowerCase() === targetLabel);
    if (!match && matchedPollState.court && formatCourtLabel(matchedPollState.court).toLowerCase() === targetLabel) {
      courtsToRelease = [{ court: matchedPollState.court }];
    } else if (match) {
      courtsToRelease = [match];
    } else {
      courtsToRelease = [{ court: specificCourt }];
    }
    numToRelease = 1;
    if (currentCourtsCount <= 1) isAll = true;
  } else if (countOrAll === 'all') {
    isAll = true;
    numToRelease = currentCourtsCount;
    courtsToRelease = prebooked.length > 0 ? prebooked : (autoBooked.length > 0 ? autoBooked : advanceBooked);
  } else {
    const parsedCount = parseInt(countOrAll, 10);
    if (isNaN(parsedCount) || parsedCount <= 0) {
      return 'Please specify a valid number of courts to release or "all", e.g. "!releasecourt 1" or "!releasecourt all".';
    }
    numToRelease = parsedCount;
    if (numToRelease >= currentCourtsCount) {
      isAll = true;
      numToRelease = currentCourtsCount;
      courtsToRelease = prebooked.length > 0 ? prebooked : (autoBooked.length > 0 ? autoBooked : advanceBooked);
    } else {
      const pool = prebooked.length > 0 ? prebooked : (autoBooked.length > 0 ? autoBooked : advanceBooked);
      courtsToRelease = pool.slice(-numToRelease);
    }
  }

  const cancelledCourtLabels = [];
  for (const c of courtsToRelease) {
    const rawCourt = typeof c === 'string' ? c : c?.court;
    const courtLabel = rawCourt ? formatCourtLabel(rawCourt) : 'Court';
    cancelledCourtLabels.push(courtLabel);

    let reservationId = c?.reservationId || null;
    if (!reservationId) {
      const adv = [...autoBooked, ...advanceBooked].find(
        (b) => b && formatCourtLabel(b.court).toLowerCase() === courtLabel.toLowerCase()
      );
      if (adv?.reservationId) reservationId = adv.reservationId;
    }

    if (reservationId) {
      try {
        console.log(`[poll] Cancelling SCVCC court reservation ${reservationId} for ${courtLabel} on poll ${matchedPollId}`);
        const cancelRes = await scvcc.cancelCourtReservation(reservationId, pollChatId);
        if (cancelRes && cancelRes.success && cancelRes.message && sock) {
          await sendBookingNotifications(sock, pollChatId, cancelRes.message);
        }
      } catch (cancelErr) {
        console.error(`[poll] Failed to cancel SCVCC reservation ${reservationId}:`, cancelErr.message);
      }
    }

    if (Array.isArray(matchedPollState.prebookedCourts)) {
      matchedPollState.prebookedCourts = matchedPollState.prebookedCourts.filter(
        (pb) => formatCourtLabel(typeof pb === 'string' ? pb : pb.court).toLowerCase() !== courtLabel.toLowerCase()
      );
    }
    if (Array.isArray(matchedPollState.autoBookedCourts)) {
      matchedPollState.autoBookedCourts = matchedPollState.autoBookedCourts.filter(
        (b) => formatCourtLabel(b.court).toLowerCase() !== courtLabel.toLowerCase()
      );
      matchedPollState.advanceBookedCourts = matchedPollState.autoBookedCourts;
    }
    if (Array.isArray(matchedPollState.manuallyBookedCourts)) {
      matchedPollState.manuallyBookedCourts = matchedPollState.manuallyBookedCourts.filter(
        (b) => formatCourtLabel(b.court).toLowerCase() !== courtLabel.toLowerCase()
      );
    }
    if (Array.isArray(matchedPollState.prebookedPlayers)) {
      matchedPollState.prebookedPlayers = matchedPollState.prebookedPlayers.filter(
        (pb) => formatCourtLabel(pb.court || '').toLowerCase() !== courtLabel.toLowerCase()
      );
    }
    if (matchedPollState.court && formatCourtLabel(matchedPollState.court).toLowerCase() === courtLabel.toLowerCase()) {
      matchedPollState.court = null;
    }

    if (!Array.isArray(matchedPollState.releasedCourts)) matchedPollState.releasedCourts = [];
    if (!matchedPollState.releasedCourts.some((rc) => formatCourtLabel(rc.court).toLowerCase() === courtLabel.toLowerCase())) {
      matchedPollState.releasedCourts.push({
        court: courtLabel,
        time: c?.time || matchedPollState.time || null,
        releasedAt: Date.now()
      });
    }

    if (matchedPollState.name && typeof matchedPollState.name === 'string') {
      const escaped = courtLabel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const bookingRegex = new RegExp('(?:' + escaped + ')(?:\\s*\\([^)]+\\))?\\s*-\\s*Booked', 'gi');
      matchedPollState.name = matchedPollState.name.replace(bookingRegex, `${courtLabel} - Released`);
    }
  }

  const remainingCourtsCount = Math.max(0, currentCourtsCount - numToRelease);
  const newSize = remainingCourtsCount * playersPerCourt;

  if (!matchedPollState.originalSize) {
    matchedPollState.originalSize = matchedPollState.size;
  }

  const courtNamesStr = cancelledCourtLabels.length > 0 ? ` (*${cancelledCourtLabels.join(', ')}*)` : '';

  if (isAll || remainingCourtsCount === 0) {
    matchedPollState.size = 0;
    matchedPollState.slotLimit = 0;
    matchedPollState.status = 'stopped';
    matchedPollState.prebookedCourts = [];
    matchedPollState.autoBookedCourts = [];
    matchedPollState.advanceBookedCourts = [];
    matchedPollState.manuallyBookedCourts = [];
    matchedPollState.court = null;

    // Delete poll message from WhatsApp if bot created it
    await deletePollFromWhatsApp(sock, pollChatId, matchedPollId);
    if (Array.isArray(matchedPollState.siblingPollIds)) {
      for (const sibId of matchedPollState.siblingPollIds) {
        if (sibId !== matchedPollId) {
          await deletePollFromWhatsApp(sock, pollChatId, sibId);
        }
      }
    }

    if (persistPolls) persistPolls();

    const groupMsg = `🛑 *All courts released*${courtNamesStr} for poll *${pollTitle}*.\n• Voting has been stopped and the poll has been closed.`;

    if (originChatId && originChatId !== pollChatId) {
      await sendMessageAndRecord(sock, pollChatId, { text: groupMsg });
    }

    return groupMsg;
  }

  matchedPollState.size = newSize;
  matchedPollState.slotLimit = newSize;
  if (matchedPollState.name) {
    matchedPollState.name = matchedPollState.name.replace(/\(\d+\s*spots\)/i, `(${newSize} spots)`);
  }

  const mePn = jidNormalizedUser(sock?.user?.id || sock?.authState?.creds?.me?.id || '');
  const { aggregated, interestedPlayers } = getPollVoters(matchedPollId, matchedPollState, mePn, context?.messageStore);

  let players = [];
  let excessPlayers = [];
  let isAllFilled = false;
  let filledCount = 0;

  if (matchedPollState.type === 'opt_in' || matchedPollState.options?.some((o) => /^yes$/i.test(o))) {
    const yesOption = aggregated.find((o) => /^yes$/i.test(o.name.trim()));
    const yesVoters = yesOption ? yesOption.voters.map(nameFor) : interestedPlayers;
    players = yesVoters.slice(0, newSize);
    excessPlayers = yesVoters.slice(newSize);
    filledCount = players.length;
    isAllFilled = (yesVoters.length >= newSize);
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
    excessWarning = `\n⚠️ *Waitlist/Excess:* Votes from [${excessPlayers.join(', ')}] now exceed the new ${newSize}-spot limit and will not be considered.`;
  }

  let autoMatchupNote = '';
  if (isAllFilled && !matchedPollState.isManual && isValidPlayerCount(players.length) && shouldAutoGenerateLineupOnFill(matchedPollState)) {
    matchedPollState.status = 'resolved';
    if (persistPolls) persistPolls();
    setTimeout(async () => {
      try {
        await ratings.ensureRated(players);
        const prebookedCourts = await getPrebookedCourtsForPoll(matchedPollState, pollChatId);
        const schedule = generateMatchups(players, { prebookedCourts, chatId: pollChatId });
        const whenHeader = formatMatchHeaderTime(matchedPollState);
        const header = whenHeader ? `📅 ${whenHeader}\n\n` : '';
        await sendMessageAndRecord(sock, pollChatId, { text: header + formatMatchups(schedule) });
        pairHistory.recordDraw(matchedPollId, schedule, Date.now(), pollChatId);
        const playAtMs = matchedPollState?.playAt ? new Date(matchedPollState.playAt).getTime() : Date.now();
        playerActivity.recordPlayed(players, playAtMs, pollChatId);
        matchedPollState.lastSchedule = summarizeSchedule(schedule);
        if (persistPolls) persistPolls();
      } catch (err) {
        console.error('[poll] Auto matchups error after releasing court:', err);
      }
    }, 500);
    autoMatchupNote = '\n🎉 Poll is now filled! Auto-generating matchups...';
  }

  if (persistPolls) persistPolls();

  const statusNote = isAllFilled ? '*FILLED*' : `${Math.max(0, newSize - filledCount)} spot(s) remaining`;
  const resultMsg = `🎾 *Released ${numToRelease} court(s)*${courtNamesStr} for poll *${pollTitle}*:\n` +
    `• Poll size updated to *${newSize} spots* (${remainingCourtsCount} court(s)).\n` +
    `• Current status: ${statusNote}.${excessWarning}${autoMatchupNote}`;

  if (originChatId && originChatId !== pollChatId) {
    await sendMessageAndRecord(sock, pollChatId, { text: resultMsg });
  }

  return resultMsg;
}

async function getPrebookedCourtsForPoll(pollState, chatId = null) {
  if (!pollState) return [];
  const courts = [];

  if (Array.isArray(pollState.prebookedCourts)) {
    for (const c of pollState.prebookedCourts) {
      const courtName = typeof c === 'string' ? c : c?.court;
      if (courtName && !courtsConfig.isIgnoredCourt(courtName)) {
        courts.push(typeof c === 'string' ? { court: c } : c);
      }
    }
  }

  if (pollState.court && !courtsConfig.isIgnoredCourt(pollState.court)) {
    if (!courts.some((c) => (c.court || c).toLowerCase() === pollState.court.toLowerCase())) {
      courts.push({ court: pollState.court, player: pollState.createdBy || pollState.creator?.name || 'Member' });
    }
  }

  if (Array.isArray(pollState.prebookedPlayers)) {
    for (const pb of pollState.prebookedPlayers) {
      if (pb && pb.court && !courtsConfig.isIgnoredCourt(pb.court)) {
        courts.push({
          court: pb.court,
          player: pb.defaultPlayer || pb.name || pb.fullName
        });
      }
    }
  }

  if (pollState.name) {
    const bookingRegex = /(?:^|\n)\s*(Court\s*\d+|PB\s*\d+|Pickleball\s*\d+)(?:\s*\(([^)\n]+)\))?\s*-\s*(?:([^'\n]+?)(?:\'s)?\s*Booking|Booked)(?:\s*\(([^)\n]+)\))?/gi;
    let m;
    while ((m = bookingRegex.exec(pollState.name)) !== null) {
      if (courtsConfig.isIgnoredCourt(m[1])) continue;
      const courtName = m[1];
      const courtTime = m[2] || m[4] || null;
      courts.push({ court: courtName, player: m[3]?.trim() || 'Member', time: courtTime });
    }
  }

  const unique = [];
  const seenCourts = new Set();
  for (const c of courts) {
    if (courtsConfig.isIgnoredCourt(c.court) || isCourtSkipped(c.court, pollState?.skippedCourts)) continue;
    const key = (c.court || '').trim().toLowerCase();
    if (key && !seenCourts.has(key)) {
      seenCourts.add(key);
      unique.push(c);
    }
  }
  return unique;
}

/**
 * Checks and releases booked courts if 70%, 80%, or 90% of time has elapsed
 * between poll creation and play time and there are not enough players to fill the courts.
 * Sends a 5-minute warning before each checkpoint cancellation and sends a message once cancelled.
 * At 90%, cancels all remaining extra courts.
 */
async function checkCourtReleasesForPoll(sock, pollId, pollState, context, now = Date.now()) {
  if (!pollState) return false;
  if (pollState.status === 'cancelled' || pollState.status === 'expired') return false;
  if (pollState.onDemandBookingInProgress) return false;

  const bookedCourts = Array.isArray(pollState.prebookedCourts) ? pollState.prebookedCourts : [];
  if (bookedCourts.length === 0) return false;

  if (!pollState.createdAt || !pollState.playAt) return false;
  const createdAtMs = new Date(pollState.createdAt).getTime();
  const playAtMs = new Date(pollState.playAt).getTime();
  if (Number.isNaN(createdAtMs) || Number.isNaN(playAtMs)) return false;

  const totalDurationMs = playAtMs - createdAtMs;
  if (totalDurationMs <= 0 || now >= playAtMs) return false;

  if (!Array.isArray(pollState.courtReleaseWarningsSent)) pollState.courtReleaseWarningsSent = [];
  if (!Array.isArray(pollState.courtReleasesDone)) pollState.courtReleasesDone = [];

  const playersPerCourt = pollState.courtBookingType === 'singles' ? 2 : 4;
  const mePn = jidNormalizedUser(sock?.user?.id || sock?.authState?.creds?.me?.id || '');
  const { interestedPlayers, aggregated } = getPollVoters(pollId, pollState, mePn, context?.messageStore);

  const isOptIn = pollState.type === 'opt_in' || pollState.options?.some((o) => /^yes$/i.test(o.trim()));
  let currentVotesCount = 0;
  if (isOptIn) {
    currentVotesCount = interestedPlayers ? interestedPlayers.length : 0;
  } else if (pollState.isManual) {
    const manualRoster = resolveManualPollPlayers(pollState, interestedPlayers);
    currentVotesCount = manualRoster.players.length;
  } else {
    const roster = resolveFixedPollRoster(pollState, aggregated);
    currentVotesCount = Math.max(
      roster.filledCount,
      interestedPlayers ? interestedPlayers.length : 0,
      pollState.voteBuffer ? pollState.voteBuffer.size : 0
    );
  }

  const milestones = [70, 80, 90];
  let stateChanged = false;

  for (const m of milestones) {
    const checkpointTime = createdAtMs + (m / 100) * totalDurationMs;
    const warningTime = Math.max(createdAtMs, checkpointTime - 5 * 60 * 1000);

    const currentBookedCourts = Array.isArray(pollState.prebookedCourts) ? pollState.prebookedCourts : [];
    const currentBookedCount = currentBookedCourts.length;
    if (currentBookedCount === 0) break;

    const currentCourtsNeeded = currentVotesCount > 0 ? Math.ceil(currentVotesCount / playersPerCourt) : 0;
    const extraCourts = Math.max(0, currentBookedCount - currentCourtsNeeded);

    // 1. 5-minute warning check
    if (now >= warningTime && now < checkpointTime) {
      if (!pollState.courtReleaseWarningsSent.includes(m) && extraCourts > 0) {
        const countToWarn = (m === 90) ? extraCourts : 1;
        const courtsToWarn = currentBookedCourts.slice(-countToWarn);
        const courtLabels = courtsToWarn.map((c) => formatCourtLabel(typeof c === 'string' ? c : c.court)).join(' and ');
        const courtWord = countToWarn === 1 ? 'booking' : 'bookings';
        const warnMsg = `⚠️ *Warning:* *${courtLabels}* ${courtWord} will be cancelled in 5 mins due to insufficient players. Vote now to keep the court!`;

        if (sock && pollState.remoteJid) {
          try {
            const storedMessage = context?.messageStore ? context.messageStore.get(storeKey(pollState.remoteJid, pollId)) : null;
            const quotedMsg = {
              key: {
                remoteJid: pollState.remoteJid,
                id: pollId,
                fromMe: !pollState.isManual,
                ...(pollState.creator?.jid ? { participant: pollState.creator.jid } : {})
              },
              ...(storedMessage ? { message: storedMessage } : {})
            };
            await sendMessageAndRecord(sock, pollState.remoteJid, { text: warnMsg }, { quoted: quotedMsg });
            console.log(`[poll] Sent 5-min cancellation warning for ${m}% milestone in ${pollState.remoteJid} for ${courtLabels}`);
          } catch (sendErr) {
            console.error('[poll] Error sending 5-min cancellation warning:', sendErr.message);
          }
        }

        pollState.courtReleaseWarningsSent.push(m);
        stateChanged = true;
      }
    }

    // 2. Checkpoint cancellation check
    if (now >= checkpointTime && !pollState.courtReleasesDone.includes(m)) {
      pollState.courtReleasesDone.push(m);
      if (!pollState.courtReleaseWarningsSent.includes(m)) {
        pollState.courtReleaseWarningsSent.push(m);
      }
      stateChanged = true;

      if (extraCourts > 0) {
        const countToCancel = (m === 90) ? extraCourts : 1;
        const cancelledCourts = [];

        for (let i = 0; i < countToCancel; i++) {
          if (!Array.isArray(pollState.prebookedCourts) || pollState.prebookedCourts.length === 0) break;
          const courtToCancel = pollState.prebookedCourts[pollState.prebookedCourts.length - 1];
          const courtLabel = formatCourtLabel(typeof courtToCancel === 'string' ? courtToCancel : courtToCancel.court);

          let reservationId = null;
          if (Array.isArray(pollState.advanceBookedCourts)) {
            const advIdx = pollState.advanceBookedCourts.findIndex(
              (b) => formatCourtLabel(b.court).toLowerCase() === courtLabel.toLowerCase()
            );
            if (advIdx !== -1) {
              reservationId = pollState.advanceBookedCourts[advIdx].reservationId;
              pollState.advanceBookedCourts.splice(advIdx, 1);
            }
          }

          pollState.prebookedCourts.pop();
          if (Array.isArray(pollState.autoBookedCourts)) {
            pollState.autoBookedCourts = pollState.autoBookedCourts.filter(
              (b) => formatCourtLabel(b.court).toLowerCase() !== courtLabel.toLowerCase()
            );
            pollState.advanceBookedCourts = pollState.autoBookedCourts;
          }
          if (Array.isArray(pollState.manuallyBookedCourts)) {
            pollState.manuallyBookedCourts = pollState.manuallyBookedCourts.filter(
              (b) => formatCourtLabel(b.court).toLowerCase() !== courtLabel.toLowerCase()
            );
          }
          cancelledCourts.push(courtLabel);

          if (!Array.isArray(pollState.releasedCourts)) pollState.releasedCourts = [];
          if (!pollState.releasedCourts.some(rc => formatCourtLabel(rc.court).toLowerCase() === courtLabel.toLowerCase())) {
            pollState.releasedCourts.push({ court: courtLabel, time: courtToCancel.time || null });
          }

          if (Array.isArray(pollState.prebookedPlayers)) {
            pollState.prebookedPlayers = pollState.prebookedPlayers.filter(
              (pb) => formatCourtLabel(pb.court || '').toLowerCase() !== courtLabel.toLowerCase()
            );
          }

          if (reservationId) {
            try {
              console.log(`[poll] Cancelling SCVCC reservation ${reservationId} for ${courtLabel} at ${m}% mark`);
              const cancelRes = await scvcc.cancelCourtReservation(reservationId, pollState.remoteJid);
              if (cancelRes && cancelRes.success && cancelRes.message && sock && pollState.remoteJid) {
                await sendBookingNotifications(sock, pollState.remoteJid, cancelRes.message);
              }
            } catch (cancelErr) {
              console.error(`[poll] Failed to cancel SCVCC reservation ${reservationId}:`, cancelErr.message);
            }
          }
        }

        const remainingBookedCount = Array.isArray(pollState.prebookedCourts) ? pollState.prebookedCourts.length : 0;
        const validSlotsCount = remainingBookedCount * playersPerCourt;
        if (validSlotsCount === 0) {
          pollState.status = 'stopped';
        } else if (pollState.status === 'filled' && currentVotesCount < validSlotsCount) {
          pollState.status = 'active';
        }

        const courtNames = cancelledCourts.join(' and ');
        const courtWord = cancelledCourts.length === 1 ? 'booking' : 'bookings';
        const cancelMsg = `⚠️ *${courtNames}* ${courtWord} has been cancelled due to insufficient players.`;

        if (sock && pollState.remoteJid) {
          try {
            const storedMessage = context?.messageStore ? context.messageStore.get(storeKey(pollState.remoteJid, pollId)) : null;
            const quotedMsg = {
              key: {
                remoteJid: pollState.remoteJid,
                id: pollId,
                fromMe: !pollState.isManual,
                ...(pollState.creator?.jid ? { participant: pollState.creator.jid } : {})
              },
              ...(storedMessage ? { message: storedMessage } : {})
            };
            await sendMessageAndRecord(sock, pollState.remoteJid, { text: cancelMsg }, { quoted: quotedMsg });
            console.log(`[poll] Sent court cancellation notice at ${m}% mark for ${courtNames} in ${pollState.remoteJid}`);
          } catch (sendErr) {
            console.error('[poll] Error sending court cancellation notice:', sendErr.message);
          }
        }
      } else {
        console.log(`[poll] At ${m}% mark for poll ${pollId}: enough players to fill booked courts (${currentVotesCount} for ${currentBookedCount} courts). Court cancellation averted.`);
      }
    }
  }

  if (stateChanged && context?.persistPolls) {
    context.persistPolls();
  }

  return stateChanged;
}

async function checkCourtReleases(sock, context, now = Date.now()) {
  if (!context?.activePolls) return;
  for (const [pollId, pollState] of context.activePolls.entries()) {
    try {
      await checkCourtReleasesForPoll(sock, pollId, pollState, context, now);
    } catch (err) {
      console.error(`[poll] Error checking court releases for poll ${pollId}:`, err.message);
    }
  }
}

function shuffleArray(arr) {
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

async function preBookCourtsForMatch({
  sock,
  remoteJid,
  targetDateMDY,
  queryTime,
  court = null,
  targetCourt = null,
  size = null,
  isAuto = false,
  preBookCourts = null,
  bookingPlayers = null,
  creatorName = 'Member',
  creatorJid = null,
  existingAdvanceBookedCourts = null,
  existingPrebookedCourts = null,
  isAdvanceBooking = false,
  minAvailableMinutes = 90,
  lookAround = null,
  retryDelayMs = null,
  maxCourts = null,
  excludeCourts = null,
  skippedCourts = null,
  courtPreference = null,
  bookingCourtPreference = null,
  closedTimes = null
}) {
  const advanceBookedCourts = Array.isArray(existingAdvanceBookedCourts) ? [...existingAdvanceBookedCourts] : [];
  const prebookedCourts = Array.isArray(existingPrebookedCourts) ? [...existingPrebookedCourts] : [];
  const normalizeTimeKey = (t) => (typeof scvcc.normalizeGridTime === 'function' ? scvcc.normalizeGridTime(t) : null) || String(t || '').trim().toLowerCase();
  const closedTimesMap = new Map();
  if (Array.isArray(closedTimes)) {
    for (const ct of closedTimes) {
      const rawT = typeof ct === 'string' ? ct : ct?.time;
      if (!rawT) continue;
      const k = normalizeTimeKey(rawT);
      if (k && !closedTimesMap.has(k)) {
        closedTimesMap.set(k, {
          time: rawT,
          title: (typeof ct === 'object' ? ct?.title : null) || null
        });
      }
    }
  }

  if (!groupsConfig.isCourtBookingEnabled(remoteJid)) {
    return { advanceBookedCourts, prebookedCourts, closedTimes: [...closedTimesMap.values()], clubClosed: false, clubClosedTitle: null };
  }

  const rawPreBookCourtPref = courtPreference || bookingCourtPreference;
  const effectiveCourtPreference = (rawPreBookCourtPref && (Array.isArray(rawPreBookCourtPref) ? rawPreBookCourtPref.length > 0 : Boolean(rawPreBookCourtPref)))
    ? normalizeCourtPreference(rawPreBookCourtPref)
    : groupsConfig.getBookingCourtPreference(remoteJid);

  const groupCfg = groupsConfig.getGroupConfig(remoteJid);
  const sport = groupCfg?.sport || 'tennis';

  let targetCourtsCount = 1;
  const explicitCourts = (preBookCourts !== undefined && preBookCourts !== null && parseInt(preBookCourts, 10) > 0)
    ? parseInt(preBookCourts, 10)
    : null;
  const explicitMax = (maxCourts !== undefined && maxCourts !== null && parseInt(maxCourts, 10) > 0)
    ? parseInt(maxCourts, 10)
    : null;
  const capMaxCourts = explicitMax || ((groupCfg?.maxCourts !== undefined && groupCfg?.maxCourts !== null && parseInt(groupCfg.maxCourts, 10) > 0)
    ? parseInt(groupCfg.maxCourts, 10)
    : null);

  const isNumericSize = size && parseInt(size, 10) > 0 && String(size).toLowerCase() !== "auto";
  if (isNumericSize) {
    const numPlayers = parseInt(size, 10);
    targetCourtsCount = explicitCourts || explicitMax || Math.max(1, Math.ceil(numPlayers / 4));
    if (capMaxCourts) {
      targetCourtsCount = Math.min(targetCourtsCount, capMaxCourts);
    }
  } else {
    const cfgCourts = (groupCfg?.preBookCourts !== undefined && groupCfg?.preBookCourts !== null && parseInt(groupCfg.preBookCourts, 10) > 0)
      ? parseInt(groupCfg.preBookCourts, 10)
      : (groupCfg?.preBookCourtsCount !== undefined && groupCfg?.preBookCourtsCount !== null && parseInt(groupCfg.preBookCourtsCount, 10) > 0
        ? parseInt(groupCfg.preBookCourtsCount, 10)
        : null);

    targetCourtsCount = explicitCourts || explicitMax || cfgCourts || 0;
    if (capMaxCourts && targetCourtsCount > 0) {
      targetCourtsCount = Math.min(targetCourtsCount, capMaxCourts);
    }
  }

  if (targetCourtsCount <= 0) {
    console.log(`[poll] Pre-book court calculation for ${remoteJid}: targetCourtsCount is 0 (opt-in poll without explicit preBookCourts). Skipping booking.`);
    return { advanceBookedCourts, prebookedCourts };
  }

  console.log(`[poll] Pre-book court calculation for ${remoteJid}: size=${size}, isAuto=${isAuto}, targetCourtsCount=${targetCourtsCount}`);

  const shuffleArray = (arr) => {
    const copy = [...arr];
    for (let i = copy.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [copy[i], copy[j]] = [copy[j], copy[i]];
    }
    return copy;
  };

  const directNames = groupCfg?.directCourtBookingAccounts || [];
  const directBookingPlayers = [];
  const directKeysSet = new Set();
  for (const name of directNames) {
    const resolved = namesStore.resolveFullName(name);
    const key = resolved.toLowerCase().trim();
    if (!directBookingPlayers.some((dp) => dp.toLowerCase().trim() === key)) {
      directBookingPlayers.push(resolved);
    }
    directKeysSet.add(key);
  }

  let rawPool = [];
  if (bookingPlayers) {
    rawPool = Array.isArray(bookingPlayers) ? bookingPlayers : (typeof bookingPlayers === 'string' ? bookingPlayers.split(/[,;]+/).map((s) => s.trim()).filter(Boolean) : []);
  }
  if (!rawPool || rawPool.length === 0) {
    rawPool = groupsConfig.getDefaultBookingPlayers(remoteJid);
  }
  if (!rawPool || rawPool.length === 0) {
    rawPool = [creatorName || 'Member'];
  }

  const seenTeammateNames = new Set();
  const defaultBookingPool = [];
  for (const p of rawPool) {
    if (!p) continue;
    const names = Array.isArray(p) ? p : [p];
    for (const nameItem of names) {
      if (!nameItem || typeof nameItem !== "string") continue;
      const resolved = namesStore.resolveFullName(nameItem) || nameItem;
      const key = resolved.toLowerCase().trim();
      if (!directKeysSet.has(key) && !seenTeammateNames.has(key)) {
        seenTeammateNames.add(key);
        defaultBookingPool.push(resolved);
      }
    }
  }

  const playersPerCourt = (!isAuto && size && parseInt(size, 10) === 2) ? 2 : 4;
  const bookedPlayerKeys = new Set();
  for (const b of advanceBookedCourts) {
    if (Array.isArray(b.players)) {
      for (const p of b.players) {
        if (p) bookedPlayerKeys.add(p.toLowerCase().trim());
      }
    }
  }
  for (const pb of prebookedCourts) {
    if (Array.isArray(pb.players)) {
      for (const p of pb.players) {
        if (p) bookedPlayerKeys.add(p.toLowerCase().trim());
      }
    }
    if (pb.player) {
      bookedPlayerKeys.add(pb.player.toLowerCase().trim());
    }
    if (pb.fullName) {
      const splitNames = pb.fullName.split(/[,;&+]|\band\b/i).map((s) => s.trim()).filter(Boolean);
      for (const name of splitNames) {
        bookedPlayerKeys.add(name.toLowerCase().trim());
      }
    }
  }
  let availableDirectAccounts = shuffleArray(directBookingPlayers).filter((p) => !bookedPlayerKeys.has(p.toLowerCase().trim()));

  const uniqueSecuredCourts = new Set([
    ...advanceBookedCourts.map((b) => b.court?.toLowerCase().trim()).filter(Boolean),
    ...prebookedCourts.map((b) => b.court?.toLowerCase().trim()).filter(Boolean)
  ]);
  const alreadyBookedCount = uniqueSecuredCourts.size;
  if (alreadyBookedCount >= targetCourtsCount) {
    console.log(`[poll] Target courts count (${targetCourtsCount}) already reached for ${remoteJid} on ${targetDateMDY} (${alreadyBookedCount} secured: ${[...uniqueSecuredCourts].join(', ')}).`);
    return { advanceBookedCourts, prebookedCourts, closedTimes: [...closedTimesMap.values()], clubClosed: false, clubClosedTitle: null };
  }

  const candidateTimes = getCandidateTimes(queryTime, lookAround);
  console.log(`[poll] Pre-book candidate times with look around (${lookAround || 0}m):`, candidateTimes);

  for (const currentTime of candidateTimes) {
    const timeKey = normalizeTimeKey(currentTime);
    if (closedTimesMap.has(timeKey)) {
      const knownClosed = closedTimesMap.get(timeKey);
      console.log(`[poll] Skipping pre-booking for ${remoteJid} on ${targetDateMDY} at ${currentTime}: club is closed${knownClosed?.title ? ` (${knownClosed.title})` : ''}.`);
      continue;
    }

    const currentUniqueSecured = new Set([
      ...advanceBookedCourts.map((b) => b.court?.toLowerCase().trim()).filter(Boolean),
      ...prebookedCourts.map((b) => b.court?.toLowerCase().trim()).filter(Boolean)
    ]);
    const currentBookedCount = currentUniqueSecured.size;
    if (currentBookedCount >= targetCourtsCount) {
      console.log(`[poll] Target courts count (${targetCourtsCount}) already reached for ${remoteJid} on ${targetDateMDY} (${currentBookedCount} secured: ${[...currentUniqueSecured].join(', ')}).`);
      break;
    }

    const neededCourts = targetCourtsCount - currentBookedCount;
    for (let c = 0; c < neededCourts; c++) {
      const courtIdx = currentBookedCount + c;
      let courtBooked = false;
      let hitClubClosed = false;
      const MAX_RETRIES = 3;
      const RETRY_DELAY_MS = retryDelayMs !== null ? retryDelayMs : ((process.env.NODE_ENV === 'test' || process.env.npm_lifecycle_event === 'test' || process.execArgv.includes('--test')) ? 10 : 45 * 1000);
      const MAX_ATTEMPTS = 1 + MAX_RETRIES;
      const triedSetsForCourt = new Set();

      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        const unbookedDirect = availableDirectAccounts.filter((p) => !bookedPlayerKeys.has(p.toLowerCase().trim()));
        let unbookedTeammates = defaultBookingPool.filter((p) => !bookedPlayerKeys.has(p.toLowerCase().trim()));

        let p1 = null;
        if (unbookedDirect.length > 0) {
          const shuffledDirect = shuffleArray(unbookedDirect);
          p1 = shuffledDirect[0];
        } else {
          const shuffledTeammates = shuffleArray(unbookedTeammates);
          p1 = shuffledTeammates[0] || (creatorName || 'Member');
        }

        const availableTeammates = unbookedTeammates.filter((p) => p.toLowerCase().trim() !== p1.toLowerCase().trim());
        const neededTeammates = Math.max(0, playersPerCourt - 1);
        let selectedTeammates = [];

        if (availableTeammates.length > 0 && neededTeammates > 0) {
          let foundNewCombo = false;
          for (let sampleTry = 0; sampleTry < 15; sampleTry++) {
            const shuffledTeammates = shuffleArray(availableTeammates);
            const candidateTeammates = shuffledTeammates.slice(0, neededTeammates);
            const setSig = [p1, ...candidateTeammates].map((x) => x.toLowerCase().trim()).sort().join('|');
            if (!triedSetsForCourt.has(setSig)) {
              selectedTeammates = candidateTeammates;
              triedSetsForCourt.add(setSig);
              foundNewCombo = true;
              break;
            }
          }
          if (!foundNewCombo) {
            selectedTeammates = shuffleArray(availableTeammates).slice(0, neededTeammates);
            const setSig = [p1, ...selectedTeammates].map((x) => x.toLowerCase().trim()).sort().join('|');
            triedSetsForCourt.add(setSig);
          }
        } else {
          const setSig = [p1].map((x) => x.toLowerCase().trim()).join('|');
          triedSetsForCourt.add(setSig);
        }

        const currentCourtPlayers = [p1, ...selectedTeammates];
        const retryLabel = attempt > 1 ? ` (retry ${attempt - 1}/${MAX_RETRIES})` : '';
        console.log(`[poll] Pre-booking court ${courtIdx + 1}/${targetCourtsCount}${retryLabel} for ${remoteJid} on ${targetDateMDY} at ${currentTime} with players:`, currentCourtPlayers);

        try {
          const rawExcluded = [
            ...(Array.isArray(excludeCourts) ? excludeCourts : (excludeCourts ? [excludeCourts] : [])),
            ...(Array.isArray(skippedCourts) ? skippedCourts : (skippedCourts ? [skippedCourts] : []))
          ];
          const alreadyBookedCourtNames = [
            ...advanceBookedCourts.map((b) => b.court).filter(Boolean),
            ...prebookedCourts.map((b) => b.court).filter(Boolean),
            ...rawExcluded
          ];
          const specificCourt = (courtIdx === 0) ? (court || targetCourt) : null;
          const bookRes = await scvcc.bookCourt({
            when: targetDateMDY,
            date: targetDateMDY,
            time: currentTime,
            court: specificCourt,
            minAvailableMinutes,
            players: currentCourtPlayers,
            requester: currentCourtPlayers[0] || creatorName || 'Member',
            requestedBy: creatorName || 'Member',
            sport,
            chatId: remoteJid,
            courtPreference: effectiveCourtPreference,
            excludeCourts: alreadyBookedCourtNames
          });

          if (bookRes && bookRes.success) {
            advanceBookedCourts.push({
              court: bookRes.court,
              players: bookRes.players || currentCourtPlayers,
              date: bookRes.date,
              time: bookRes.time || currentTime,
              reservationId: bookRes.reservationId || null,
              duration: bookRes.duration || '90 Minutes',
              partySize: bookRes.partySize || (playersPerCourt === 2 ? 'Singles' : 'Doubles')
            });
            prebookedCourts.push({
              court: bookRes.court,
              player: currentCourtPlayers[0] || creatorName || 'Member',
              fullName: (currentCourtPlayers && currentCourtPlayers.length > 0) ? currentCourtPlayers.join(', ') : (creatorName || 'Member'),
              time: bookRes.time || currentTime
            });

            currentCourtPlayers.forEach((p) => bookedPlayerKeys.add(p.toLowerCase().trim()));
            availableDirectAccounts = availableDirectAccounts.filter((p) => p.toLowerCase().trim() !== p1.toLowerCase().trim());

            if (sock && remoteJid && bookRes.message) {
              await sendBookingNotifications(sock, remoteJid, bookRes.message);
            }

            courtBooked = true;
            break;
          } else {
            if (bookRes && bookRes.clubClosed) {
              hitClubClosed = true;
              closedTimesMap.set(timeKey, {
                time: bookRes.time || currentTime,
                title: bookRes.clubClosedTitle || null
              });
              console.warn(`[poll] Club is closed at ${currentTime}${bookRes.clubClosedTitle ? ` (${bookRes.clubClosedTitle})` : ''}; stopping pre-booking attempts for this time.`);
              break;
            }
            console.warn(`[poll] Advance court booking failed for court ${courtIdx + 1}/${targetCourtsCount} at ${currentTime}${retryLabel}:`, bookRes?.message);
          }
        } catch (bookErr) {
          console.error(`[poll] Error during advance court booking for court ${courtIdx + 1}/${targetCourtsCount} at ${currentTime}${retryLabel}:`, bookErr.message);
        }

        if (!courtBooked && !hitClubClosed && attempt <= MAX_RETRIES) {
          console.log(`[poll] Waiting 45s before retrying court ${courtIdx + 1}/${targetCourtsCount} with another set of random players...`);
          await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
        }
      }

      if (!courtBooked) {
        if (hitClubClosed) {
          console.warn(`[poll] Skipping remaining court attempts at ${currentTime} because club is closed.`);
        } else {
          console.warn(`[poll] Advance court booking failed for court ${courtIdx + 1}/${targetCourtsCount} at ${currentTime} after all ${MAX_ATTEMPTS} attempts. Will try next candidate time if available.`);
        }
        break; // break to try next currentTime in candidateTimes
      }
    }
  }

  const finalClosedTimes = [...closedTimesMap.values()];
  const allTimesClosed = candidateTimes.length > 0 && candidateTimes.every((t) => closedTimesMap.has(normalizeTimeKey(t)));
  const firstClosedTitle = finalClosedTimes.find((ct) => ct.title)?.title || null;

  if (!isAdvanceBooking && sock && remoteJid) {
    const currentSecuredCount = new Set([
      ...advanceBookedCourts.map((b) => b.court?.toLowerCase().trim()).filter(Boolean),
      ...prebookedCourts.map((b) => b.court?.toLowerCase().trim()).filter(Boolean)
    ]).size;
    const isAllBooked = currentSecuredCount >= targetCourtsCount && targetCourtsCount > 0;
    const summaryMsg = scvcc.buildBookingSummaryMessage({
      targetDateMDY,
      queryTime,
      sport,
      targetCourtsCount,
      advanceBookedCourts,
      prebookedCourts,
      isExhausted: !isAllBooked && !allTimesClosed,
      clubClosed: allTimesClosed && currentSecuredCount === 0,
      clubClosedTitle: firstClosedTitle
    });
    console.log(`[poll] Sending booking summary notification for ${remoteJid}:\n${summaryMsg}`);
    await sendBookingNotifications(sock, remoteJid, summaryMsg);
  }

  return {
    advanceBookedCourts,
    prebookedCourts,
    closedTimes: finalClosedTimes,
    clubClosed: allTimesClosed,
    clubClosedTitle: firstClosedTitle
  };
}

function normalizeCourtPreference(pref) {
  if (!pref) return [];
  if (Array.isArray(pref)) {
    return pref.map((p) => String(p).trim()).filter(Boolean);
  }
  if (typeof pref === "string") {
    return pref
      .replace(/^\[|\]$/g, "")
      .split(/[,;\s]+/)
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return [String(pref).trim()];
}

function getCourtPreferenceRank(courtIdentifierOrObj, preferences) {
  if (!preferences || !Array.isArray(preferences) || preferences.length === 0) return 999999;
  const courtStr = typeof courtIdentifierOrObj === "string"
    ? courtIdentifierOrObj
    : (courtIdentifierOrObj?.court || courtIdentifierOrObj?.courtName || courtIdentifierOrObj?.name || "");
  const cName = courtStr.toLowerCase().trim();
  const cNum = courtStr.match(/\d+/)?.[0];
  const rId = String(courtIdentifierOrObj?.resourceId || "");

  for (let i = 0; i < preferences.length; i++) {
    const pref = String(preferences[i]).toLowerCase().trim();
    const prefNum = pref.match(/\d+/)?.[0];
    if (pref === cName || pref.replace(/\s+/g, "") === cName.replace(/\s+/g, "")) return i;
    if (rId && pref === rId) return i;
    if (cNum && (pref === cNum || prefNum === cNum)) return i;
  }
  return 999999;
}

function sortCourtsByPreference(courtsList, preferences) {
  if (!Array.isArray(courtsList) || courtsList.length <= 1) return courtsList;
  if (!preferences || !Array.isArray(preferences) || preferences.length === 0) return courtsList;
  return [...courtsList].sort((a, b) => {
    const rankA = getCourtPreferenceRank(a, preferences);
    const rankB = getCourtPreferenceRank(b, preferences);
    return rankA - rankB;
  });
}

function formatCourtLabel(court) {
  if (!court) return 'Court';
  const str = String(court).trim();
  const m = str.match(/^(?:court|ct)\s*(\d+)/i) || str.match(/^c(\d+)$/i);
  if (m) {
    return `Court ${m[1]}`;
  }
  if (/^\d+$/.test(str)) {
    return `Court ${str}`;
  }
  return str;
}


function formatCourtAvailableTitleLine(court, courtTime, baseTime) {
  const label = formatCourtLabel(court);
  const qParsed = baseTime ? parseTimeString(baseTime) : null;
  const cParsed = courtTime ? parseTimeString(courtTime) : null;
  const isDiff = Boolean(
    cParsed && qParsed && (cParsed.hour !== qParsed.hour || cParsed.minute !== qParsed.minute)
  );
  const timeSuffix = isDiff ? ` (${cParsed.formatted})` : '';
  return `${label}${timeSuffix} - Available`;
}

function formatCourtTentativeTitleLine(court, courtTime, baseTime) {
  const label = formatCourtLabel(court);
  const qParsed = baseTime ? parseTimeString(baseTime) : null;
  const cParsed = courtTime ? parseTimeString(courtTime) : null;
  const isDiff = Boolean(
    cParsed && qParsed && (cParsed.hour !== qParsed.hour || cParsed.minute !== qParsed.minute)
  );
  const timeSuffix = isDiff ? ` (${cParsed.formatted})` : '';
  return `${label}${timeSuffix} - Tentative`;
}

/**
 * Books an available court on demand when player openings fall below 3.
 * If booking fails, posts a message to the group that the court is no longer available,
 * sets pollState.slotLimit to the valid number of slots, and notifies voters on invalid slots.
 */
async function handleOnDemandCourtBooking(sock, pollId, pollState, aggregated, context = {}, options = {}) {
  if (pollState.onDemandBookingInProgress && pollState._bookingActive) return;

  const isRebooking = Boolean(options.isRebooking);
  const targetCourtParam = options.targetCourt || null;
  const hasUnbooked = Array.isArray(pollState.unbookedCourts) && pollState.unbookedCourts.length > 0;
  const hasTentative = Array.isArray(pollState.tentativeCourts) && pollState.tentativeCourts.length > 0;

  if (isRebooking && !targetCourtParam) return;
  if (!isRebooking && !hasUnbooked && !hasTentative) return;

  pollState.onDemandBookingInProgress = true;
  pollState._bookingActive = true;
  const remoteJid = pollState.remoteJid;
  const effectiveCourtPreference = (pollState.bookingCourtPreference && pollState.bookingCourtPreference.length > 0)
    ? pollState.bookingCourtPreference
    : groupsConfig.getBookingCourtPreference(remoteJid);
  if (Array.isArray(pollState.unbookedCourts) && pollState.unbookedCourts.length > 1) {
    pollState.unbookedCourts = sortCourtsByPreference(pollState.unbookedCourts, effectiveCourtPreference);
  }
  if (Array.isArray(pollState.tentativeCourts) && pollState.tentativeCourts.length > 1) {
    pollState.tentativeCourts = sortCourtsByPreference(pollState.tentativeCourts, effectiveCourtPreference);
  }
  const playersPerCourt = pollState.courtBookingType === 'singles' ? 2 : 4;
  const sport = 'tennis';

  try {
    const targetDateMDY = pollState.targetDateMDY || scvcc.resolveDateToMDY(pollState.playAt || pollState.when || 'today');
    let queryTime = pollState.queryTime;
    if (!queryTime && pollState.playAt) {
      const sjParts = getSanJoseParts(new Date(pollState.playAt));
      const h = sjParts.hour === 0 ? 12 : (sjParts.hour > 12 ? sjParts.hour - 12 : sjParts.hour);
      const m = String(sjParts.minute).padStart(2, '0');
      const ampm = sjParts.hour >= 12 ? 'pm' : 'am';
      queryTime = `${h}:${m}${ampm}`;
    }

    const groupCfg = groupsConfig.getGroupConfig(remoteJid);
    const lookAroundMins = parseLookAround(pollState.lookAround || groupCfg?.lookAround || null);
    const baseCandidateTimes = getCandidateTimes(queryTime, lookAroundMins);
    const normalizeTimeKey = (t) => (typeof scvcc.normalizeGridTime === 'function' ? scvcc.normalizeGridTime(t) : null) || String(t || '').trim().toLowerCase();
    const detectClosedSafe = typeof scvcc.detectClubClosed === 'function' ? scvcc.detectClubClosed : () => ({ clubClosed: false, title: null });
    const closedTimeKeys = new Set();
    if (Array.isArray(pollState.closedTimes)) {
      for (const ct of pollState.closedTimes) {
        const rawT = typeof ct === 'string' ? ct : ct?.time;
        if (rawT) closedTimeKeys.add(normalizeTimeKey(rawT));
      }
    }
    const recordClosedTime = (timeStr, title = null) => {
      const k = normalizeTimeKey(timeStr);
      if (!k || closedTimeKeys.has(k)) return;
      closedTimeKeys.add(k);
      if (!Array.isArray(pollState.closedTimes)) pollState.closedTimes = [];
      pollState.closedTimes.push({ time: timeStr, title: title || null });
    };

    // Cache availability calls by time to avoid duplicate requests during this booking pass
    const availCache = new Map();
    const getAvailForTime = async (t) => {
      if (!t) return null;
      if (availCache.has(t)) return availCache.get(t);
      const res = await scvcc.checkCourtAvailability({ when: targetDateMDY, time: t, sport, chatId: remoteJid }).catch(() => null);
      availCache.set(t, res);
      return res;
    };

    // Helper: determine candidate times to try for a specific court object
    const getCandidateTimesForCourt = (courtObj) => {
      let knownTime = courtObj?.time || null;
      if (!knownTime && courtObj?.court && pollState.name) {
        const courtLabel = formatCourtLabel(courtObj.court);
        const escaped = courtLabel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const m = pollState.name.match(new RegExp(`${escaped}\\s*\\(([^)]+)\\)`, 'i'));
        if (m && parseTimeString(m[1].trim())) {
          knownTime = m[1].trim();
        }
      }

      if (knownTime) {
        const normKnown = parseTimeString(knownTime)?.formatted || knownTime;
        const others = baseCandidateTimes.filter((t) => {
          const normT = parseTimeString(t)?.formatted || t;
          return normT.toLowerCase() !== normKnown.toLowerCase();
        });
        return [knownTime, ...others];
      }

      return baseCandidateTimes.length > 0 ? baseCandidateTimes : [queryTime];
    };

    // 1. Identify players already on prebooked courts bookings to exclude them
    const bookedPlayerKeys = new Set();
    if (Array.isArray(pollState.advanceBookedCourts)) {
      for (const b of pollState.advanceBookedCourts) {
        if (Array.isArray(b.players)) {
          for (const p of b.players) {
            if (p) {
              bookedPlayerKeys.add(p.toLowerCase().trim());
              const resolved = namesStore.resolveFullName(p);
              if (resolved) bookedPlayerKeys.add(resolved.toLowerCase().trim());
            }
          }
        }
        if (b.requester) {
          bookedPlayerKeys.add(b.requester.toLowerCase().trim());
          const resolved = namesStore.resolveFullName(b.requester);
          if (resolved) bookedPlayerKeys.add(resolved.toLowerCase().trim());
        }
      }
    }
    if (Array.isArray(pollState.prebookedCourts)) {
      for (const pb of pollState.prebookedCourts) {
        if (pb.player) {
          bookedPlayerKeys.add(pb.player.toLowerCase().trim());
          const resolved = namesStore.resolveFullName(pb.player);
          if (resolved) bookedPlayerKeys.add(resolved.toLowerCase().trim());
        }
        if (pb.fullName) {
          const names = String(pb.fullName).split(/[,;]+/).map((s) => s.trim()).filter(Boolean);
          for (const n of names) {
            bookedPlayerKeys.add(n.toLowerCase().trim());
            const resolved = namesStore.resolveFullName(n);
            if (resolved) bookedPlayerKeys.add(resolved.toLowerCase().trim());
          }
        }
      }
    }

    // 2. Collect players that have voted so far
    const votedPlayers = [];
    if (Array.isArray(aggregated)) {
      for (const opt of aggregated) {
        if (!opt || !Array.isArray(opt.voters)) continue;
        if (/^(no|out|can't play|cannot play)$/i.test(opt.name.trim())) continue;
        for (const vJid of opt.voters) {
          const pName = nameFor(vJid);
          if (pName && !ratings.isPlaceholder(pName)) {
            votedPlayers.push(pName);
          }
        }
      }
    }
    const tempRoster = resolveFixedPollRoster(pollState, aggregated);
    if (Array.isArray(tempRoster?.allPlayers)) {
      for (const p of tempRoster.allPlayers) {
        if (p && !ratings.isPlaceholder(p) && !votedPlayers.includes(p)) {
          votedPlayers.push(p);
        }
      }
    }

    // 3. Collect default booking players
    let rawDefaultPool = [];
    if (pollState.bookingPlayers) {
      rawDefaultPool = Array.isArray(pollState.bookingPlayers)
        ? pollState.bookingPlayers
        : (typeof pollState.bookingPlayers === 'string' ? pollState.bookingPlayers.split(/[,;]+/).map((s) => s.trim()).filter(Boolean) : []);
    }
    if (!rawDefaultPool || rawDefaultPool.length === 0) {
      rawDefaultPool = groupsConfig.getDefaultBookingPlayers(remoteJid) || [];
    }

    // 4. Build candidate booking pool (voted players + default booking players, excluding prebooked courts players)
    const candidateBookingPool = [];
    const seenCandidateKeys = new Set();

    const addCandidate = (name) => {
      if (!name) return;
      const resolved = namesStore.resolveFullName(name);
      const key = resolved.toLowerCase().trim();
      if (bookedPlayerKeys.has(key)) return; // Exclude players on prebooked courts
      if (seenCandidateKeys.has(key)) return;
      seenCandidateKeys.add(key);
      candidateBookingPool.push(resolved);
    };

    for (const p of votedPlayers) {
      addCandidate(p);
    }
    for (const p of rawDefaultPool) {
      addCandidate(p);
    }

    // 5. Direct booking accounts
    const directNames = groupCfg?.directCourtBookingAccounts || [];
    const directBookingPlayers = [];
    for (const name of directNames) {
      const resolved = namesStore.resolveFullName(name);
      const key = resolved.toLowerCase().trim();
      if (!bookedPlayerKeys.has(key) && !directBookingPlayers.some((dp) => dp.toLowerCase().trim() === key)) {
        directBookingPlayers.push(resolved);
      }
    }

    // Exclude other courts from SCVCC so only target court can be booked
    const alreadyBookedCourtNames = (pollState.advanceBookedCourts || []).map((b) => b.court);
    if (Array.isArray(pollState.prebookedCourts)) {
      alreadyBookedCourtNames.push(...pollState.prebookedCourts.map((pb) => pb.court));
    }

    const MAX_RETRIES = 2;
    const MAX_ATTEMPTS = 1 + MAX_RETRIES;
    const RETRY_DELAY_MS = (process.env.NODE_ENV === 'test' || typeof describe === 'function') ? 10 : 2000;

    // Helper: is a court free on SCVCC
    const isCourtFree = (courtName, slotCourts) => {
      if (!courtName || !Array.isArray(slotCourts)) return false;
      const targetLabel = formatCourtLabel(courtName).toLowerCase();
      const c = slotCourts.find((sc) => sc.court && formatCourtLabel(sc.court).toLowerCase() === targetLabel);
      if (!c) return false;
      const effectiveMins = Math.max(c.availableMinutes || 0, c.overrideAvailableMinutes || 0);
      if (c.status === 'available') {
        return c.availableMinutes == null || effectiveMins >= 90;
      }
      if (!c.blockTitle && (!Array.isArray(c.prebookedPlayers) || c.prebookedPlayers.length === 0) && (c.overrideAvailableMinutes || 0) >= 90) {
        return true;
      }
      return false;
    };

    // Helper: attempts to book a given court with retries
    const attemptBookCourt = async (courtObj, slotContext) => {
      const courtTime = courtObj.time || queryTime;
      const otherCourts = slotContext?.courts
        ? slotContext.courts.filter((c) => formatCourtLabel(c.court).toLowerCase() !== formatCourtLabel(courtObj.court).toLowerCase()).map((c) => c.court)
        : [];
      const excludeCourts = [...new Set([...alreadyBookedCourtNames, ...otherCourts])];

      const triedSetsForCourt = new Set();
      let isSuccess = false;
      let isClubClosed = false;
      let lastBookRes = null;
      let lastCourtPlayers = null;

      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        const unbookedDirect = directBookingPlayers.filter((p) => !bookedPlayerKeys.has(p.toLowerCase().trim()));
        let p1 = null;
        if (unbookedDirect.length > 0) {
          p1 = shuffleArray(unbookedDirect)[0];
        } else if (candidateBookingPool.length > 0) {
          p1 = candidateBookingPool[0];
        } else {
          p1 = pollState.creator?.name || 'Member';
        }

        const availableTeammates = candidateBookingPool.filter((p) => p.toLowerCase().trim() !== p1.toLowerCase().trim());
        const neededTeammates = Math.max(0, playersPerCourt - 1);
        let selectedTeammates = [];

        if (availableTeammates.length > 0 && neededTeammates > 0) {
          let foundNewCombo = false;
          for (let sampleTry = 0; sampleTry < 15; sampleTry++) {
            const shuffledTeammates = shuffleArray(availableTeammates);
            const candidateTeammates = shuffledTeammates.slice(0, neededTeammates);
            const setSig = [p1, ...candidateTeammates].map((x) => x.toLowerCase().trim()).sort().join('|');
            if (!triedSetsForCourt.has(setSig)) {
              selectedTeammates = candidateTeammates;
              triedSetsForCourt.add(setSig);
              foundNewCombo = true;
              break;
            }
          }
          if (!foundNewCombo) {
            selectedTeammates = shuffleArray(availableTeammates).slice(0, neededTeammates);
            const setSig = [p1, ...selectedTeammates].map((x) => x.toLowerCase().trim()).sort().join('|');
            triedSetsForCourt.add(setSig);
          }
        } else {
          const setSig = [p1].map((x) => x.toLowerCase().trim()).join('|');
          triedSetsForCourt.add(setSig);
        }

        const currentCourtPlayers = [p1, ...selectedTeammates];
        lastCourtPlayers = currentCourtPlayers;

        const retryLabel = attempt > 1 ? ` (retry ${attempt - 1}/${MAX_RETRIES})` : '';
        console.log(`[poll] On-demand booking attempting court ${courtObj.court}${retryLabel} for ${remoteJid} on ${targetDateMDY} at ${courtTime} with players:`, currentCourtPlayers);

        const bookRes = await scvcc.bookCourt({
          when: targetDateMDY,
          date: targetDateMDY,
          time: courtTime,
          court: courtObj.court,
          minAvailableMinutes: 90,
          players: currentCourtPlayers,
          requester: currentCourtPlayers[0] || 'Member',
          requestedBy: currentCourtPlayers[0] || 'Member',
          sport,
          chatId: remoteJid,
          courtPreference: effectiveCourtPreference,
          excludeCourts
        }).catch((err) => {
          console.error(`[poll] Error during on-demand booking for court ${courtObj.court}${retryLabel}:`, err.message);
          return { success: false, message: err.message };
        });

        lastBookRes = bookRes;

        if (bookRes && bookRes.success && (!bookRes.court || formatCourtLabel(bookRes.court).toLowerCase() === formatCourtLabel(courtObj.court).toLowerCase())) {
          isSuccess = true;
          break;
        }
        if (bookRes && bookRes.clubClosed) {
          isClubClosed = true;
          recordClosedTime(courtTime, bookRes.clubClosedTitle || null);
          break;
        }

        if (attempt < MAX_ATTEMPTS) {
          console.log(`[poll] On-demand booking failed for court ${courtObj.court}${retryLabel}. Waiting ${RETRY_DELAY_MS}ms before retry...`);
          await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
        }
      }

      return { isSuccess, isClubClosed, lastBookRes, lastCourtPlayers };
    };

    if (isRebooking) {
      const courtToBook = targetCourtParam;
      const rebookCandidateTimes = getCandidateTimesForCourt(courtToBook);
      let isSuccess = false;
      let lastBookRes = null;
      let lastCourtPlayers = null;
      let rebookedTime = queryTime;

      for (let i = 0; i < rebookCandidateTimes.length; i++) {
        const t = rebookCandidateTimes[i];
        if (closedTimeKeys.has(normalizeTimeKey(t))) continue;
        const availAtTime = await getAvailForTime(t);
        const closedCheck = detectClosedSafe({ avail: availAtTime, time: t, chatId: remoteJid });
        if (closedCheck.clubClosed) {
          recordClosedTime(t, closedCheck.title);
          continue;
        }
        const slotAtTime = availAtTime?.slots?.find((s) => s.time === t) || availAtTime?.slots?.[0];
        if (i === 0 || isCourtFree(courtToBook.court, slotAtTime?.courts)) {
          const res = await attemptBookCourt({ ...courtToBook, time: t }, slotAtTime);
          lastBookRes = res.lastBookRes;
          lastCourtPlayers = res.lastCourtPlayers;
          if (res.isClubClosed || res.lastBookRes?.clubClosed) {
            recordClosedTime(t, res.lastBookRes?.clubClosedTitle || null);
          }
          if (res.isSuccess) {
            isSuccess = true;
            rebookedTime = t;
            break;
          }
        }
      }

      if (isSuccess) {
        console.log(`[poll] Re-booking succeeded for ${courtToBook.court} on ${targetDateMDY} at ${rebookedTime}`);
        if (!Array.isArray(pollState.prebookedCourts)) pollState.prebookedCourts = [];
        pollState.prebookedCourts.push({
          court: lastBookRes.court || courtToBook.court,
          player: lastCourtPlayers[0] || 'Member',
          fullName: lastCourtPlayers.join(', '),
          time: rebookedTime,
          bookingType: 'auto'
        });

        if (!Array.isArray(pollState.autoBookedCourts)) pollState.autoBookedCourts = [];
        const autoBookingEntry = {
          court: lastBookRes.court || courtToBook.court,
          players: lastBookRes.players || lastCourtPlayers,
          time: rebookedTime,
          reservationId: lastBookRes.reservationId || null,
          duration: lastBookRes.duration || '90 Minutes',
          partySize: lastBookRes.partySize || (playersPerCourt === 2 ? 'Singles' : 'Doubles'),
          bookedAt: new Date().toISOString(),
          bookedSource: 'on-demand'
        };
        pollState.autoBookedCourts.push(autoBookingEntry);
        if (!Array.isArray(pollState.advanceBookedCourts)) pollState.advanceBookedCourts = [];
        if (pollState.advanceBookedCourts !== pollState.autoBookedCourts) {
          pollState.advanceBookedCourts.push(autoBookingEntry);
        }

        if (Array.isArray(pollState.releasedCourts)) {
          pollState.releasedCourts = pollState.releasedCourts.filter(
            (c) => formatCourtLabel(c.court).toLowerCase() !== formatCourtLabel(courtToBook.court).toLowerCase()
          );
        }
        const newTotalCapacity = (Array.isArray(pollState.prebookedCourts) ? pollState.prebookedCourts.length : 0) * playersPerCourt;
        delete pollState.slotLimit;
        if ((pollState.size || 0) < newTotalCapacity) {
          pollState.size = newTotalCapacity;
        }
        pollState.invalidSlotVotesNotified = [];

        // On successful booking: do NOT send booking notifications to the group chat,
        // only send DMs to those listed in notifications.
        if (sock && remoteJid && lastBookRes.message) {
          await sendBookingNotifications(sock, remoteJid, lastBookRes.message);
        }

        // Send a simple one liner message to the group that court x is booked and how many players can now play
        const totalPlayersCanPlay = (Array.isArray(pollState.prebookedCourts) ? pollState.prebookedCourts.length : 0) * playersPerCourt;
        const playerWord = totalPlayersCanPlay === 1 ? 'player' : 'players';
        const courtLabel = formatCourtLabel(lastBookRes.court || courtToBook.court);

        const qParsed = queryTime ? parseTimeString(queryTime) : null;
        const cParsed = rebookedTime ? parseTimeString(rebookedTime) : null;
        const isDiff = Boolean(cParsed && qParsed && (cParsed.hour !== qParsed.hour || cParsed.minute !== qParsed.minute));
        const timeSuffix = isDiff ? ` (${cParsed.formatted})` : '';

        const bookedGroupMsg = `🎾 *${courtLabel}${timeSuffix}* is booked! *${totalPlayersCanPlay} ${playerWord}* can now play.`;

        if (sock && remoteJid) {
          try {
            await sendMessageAndRecord(sock, remoteJid, { text: bookedGroupMsg });
            console.log(`[poll] Sent re-booking notification to group ${remoteJid}: "${bookedGroupMsg}"`);
          } catch (sendErr) {
            console.error('[poll] Error sending re-booking court booked notification to group:', sendErr.message);
          }
        }

        if (context.persistPolls) context.persistPolls();

        // Check if poll is now filled with the new court
        const currentRoster = resolveFixedPollRoster(pollState, aggregated);
        if (currentRoster.isAllFilled && pollState.status !== 'resolved' && pollState.status !== 'cancelled' && pollState.status !== 'stopped') {
          if (!shouldAutoGenerateLineupOnFill(pollState)) {
            if (pollState.status !== 'filled') {
              pollState.status = 'filled';
              pollState.lastPlayers = currentRoster.players;
              if (context.persistPolls) context.persistPolls();
            }
          } else {
            pollState.status = 'resolved';
            pollState.lastPlayers = currentRoster.players;
            if (context.persistPolls) context.persistPolls();
            await ratings.ensureRated(currentRoster.players);
            const prebookedCourts = await getPrebookedCourtsForPoll(pollState, pollState.remoteJid);
            const schedule = generateMatchups(currentRoster.players, { prebookedCourts, chatId: pollState.remoteJid });
            const whenHeader = formatMatchHeaderTime(pollState);
            const header = whenHeader ? `📅 ${whenHeader}

` : '';
            await sendMessageAndRecord(sock, pollState.remoteJid, { text: header + formatMatchups(schedule) });
            pairHistory.recordDraw(pollId, schedule, Date.now(), pollState.remoteJid);
            const playAtMs = pollState?.playAt ? new Date(pollState.playAt).getTime() : Date.now();
            playerActivity.recordPlayed(currentRoster.players, playAtMs, pollState.remoteJid);
            pollState.lastSchedule = summarizeSchedule(schedule);
            if (context.persistPolls) context.persistPolls();
          }
        }
      } else {
        console.warn(`[poll] Re-booking failed for ${courtToBook.court} after ${MAX_ATTEMPTS} attempts: ${lastBookRes?.message || 'Court not available'}`);

        if (Array.isArray(pollState.releasedCourts)) {
          pollState.releasedCourts = pollState.releasedCourts.filter(
            (c) => formatCourtLabel(c.court).toLowerCase() !== formatCourtLabel(courtToBook.court).toLowerCase()
          );
        }
        const validSlotsCount = (Array.isArray(pollState.prebookedCourts) ? pollState.prebookedCourts.length : 0) * playersPerCourt;
        pollState.slotLimit = validSlotsCount;
        pollState.size = validSlotsCount;

        // Quote the user who triggered rebooking that slots are filled and their vote will not be considered
        const triggeringVoterJid = options.triggeringVoterJid;
        const triggeringVoteMsgKey = options.triggeringVoteMsgKey;

        if (triggeringVoterJid) {
          const norm = jidNormalizedUser(triggeringVoterJid);
          const pn = namesStore.getPnByLid(norm) || (norm?.endsWith('@s.whatsapp.net') ? norm : null);
          const lid = namesStore.resolveCanonicalId(norm) || (norm?.endsWith('@lid') ? norm : null);
          const voterName = nameFor(triggeringVoterJid);
          const phoneDigits = (pn || norm || lid || triggeringVoterJid).split('@')[0].replace(/\D/g, '');
          const tagStr = phoneDigits ? `@${phoneDigits}` : `@${voterName}`;
          const uniqueMentions = [...new Set([pn, lid, norm, triggeringVoterJid].filter(Boolean))];

          const failUserMsg = `⚠️ ${tagStr}, all *${validSlotsCount} voting slots* are filled and no additional courts could be booked. Your vote will not be considered.`;

          let quotedMsg = null;
          if (triggeringVoteMsgKey && triggeringVoteMsgKey.id) {
            quotedMsg = { key: triggeringVoteMsgKey };
          } else {
            let pollCreationMessage = context.messageStore ? context.messageStore.get(storeKey(pollState.remoteJid, pollId)) : null;
            if (!pollCreationMessage && context.messageStore) {
              for (const key of context.messageStore.keys()) {
                if (key.endsWith(':' + pollId)) {
                  pollCreationMessage = context.messageStore.get(key);
                  break;
                }
              }
            }
            quotedMsg = {
              key: {
                remoteJid: pollState.remoteJid,
                id: pollId,
                fromMe: !pollState.isManual,
                ...(pollState.creator?.jid ? { participant: pollState.creator.jid } : {})
              },
              ...(pollCreationMessage ? { message: pollCreationMessage } : {})
            };
          }

          if (sock && remoteJid) {
            try {
              await sock.sendMessage(remoteJid, {
                text: failUserMsg,
                mentions: uniqueMentions
              }, { quoted: quotedMsg });
              console.log(`[poll] Sent rebooking failure notice quoting ${tagStr} in ${remoteJid}`);
            } catch (sendErr) {
              console.error('[poll] Error sending rebooking failure message:', sendErr.message);
            }
          }

          if (!Array.isArray(pollState.invalidSlotVotesNotified)) pollState.invalidSlotVotesNotified = [];
          pollState.invalidSlotVotesNotified.push(`${triggeringVoterJid}:${validSlotsCount}`);
        }

        if (context.persistPolls) context.persistPolls();

        await checkAndNotifyInvalidSlotVotes(sock, pollId, pollState, aggregated, context);

        // Check if poll is filled after setting slotLimit
        const currentRoster = resolveFixedPollRoster(pollState, aggregated);
        if (currentRoster.isAllFilled && pollState.status !== 'resolved' && pollState.status !== 'cancelled' && pollState.status !== 'stopped') {
          if (!shouldAutoGenerateLineupOnFill(pollState)) {
            if (pollState.status !== 'filled') {
              pollState.status = 'filled';
              pollState.lastPlayers = currentRoster.players;
              if (context.persistPolls) context.persistPolls();
            }
          } else {
            pollState.status = 'resolved';
            pollState.lastPlayers = currentRoster.players;
            if (context.persistPolls) context.persistPolls();
            await ratings.ensureRated(currentRoster.players);
            const prebookedCourts = await getPrebookedCourtsForPoll(pollState, pollState.remoteJid);
            const schedule = generateMatchups(currentRoster.players, { prebookedCourts, chatId: pollState.remoteJid });
            const whenHeader = formatMatchHeaderTime(pollState);
            const header = whenHeader ? `📅 ${whenHeader}\n\n` : '';
            await sendMessageAndRecord(sock, pollState.remoteJid, { text: header + formatMatchups(schedule) });
            pairHistory.recordDraw(pollId, schedule, Date.now(), pollState.remoteJid);
            const playAtMs = pollState?.playAt ? new Date(pollState.playAt).getTime() : Date.now();
            playerActivity.recordPlayed(currentRoster.players, playAtMs, pollState.remoteJid);
            pollState.lastSchedule = summarizeSchedule(schedule);
            if (context.persistPolls) context.persistPolls();
          }
        }
      }
      return;
    }

    // On-demand booking: Available courts first, then tentative courts
    let bookedCourt = null;
    let bookingResult = null;
    let bookedTime = null;
    let isTentativeBooking = false;

    const hasUnbooked = Array.isArray(pollState.unbookedCourts) && pollState.unbookedCourts.length > 0;

    // Phase 1: Check available courts first
    if (hasUnbooked) {
      const courtToBook = pollState.unbookedCourts[0];
      const candidateTimes = getCandidateTimesForCourt(courtToBook);

      for (let i = 0; i < candidateTimes.length; i++) {
        const t = candidateTimes[i];
        if (closedTimeKeys.has(normalizeTimeKey(t))) continue;
        const availAtTime = await getAvailForTime(t);
        const closedCheck = detectClosedSafe({ avail: availAtTime, time: t, chatId: remoteJid });
        if (closedCheck.clubClosed) {
          recordClosedTime(t, closedCheck.title);
          continue;
        }
        const slotAtTime = availAtTime?.slots?.find((s) => s.time === t) || availAtTime?.slots?.[0];

        if (i === 0 || isCourtFree(courtToBook.court, slotAtTime?.courts)) {
          const courtWithTime = { ...courtToBook, time: t };
          const res = await attemptBookCourt(courtWithTime, slotAtTime);
          if (res.isClubClosed || res.lastBookRes?.clubClosed) {
            recordClosedTime(t, res.lastBookRes?.clubClosedTitle || null);
          }
          if (res.isSuccess) {
            bookedCourt = courtWithTime;
            bookingResult = res;
            bookedTime = t;
            isTentativeBooking = false;
            break;
          }
        }
      }

      if (!bookedCourt) {
        console.warn(`[poll] On-demand booking failed for available court ${courtToBook.court} across candidate times (${candidateTimes.join(', ')}): not available`);
        pollState.unbookedCourts = pollState.unbookedCourts.filter(
          (c) => formatCourtLabel(c.court).toLowerCase() !== formatCourtLabel(courtToBook.court).toLowerCase()
        );

        const remainingTentativeCount = Array.isArray(pollState.tentativeCourts) ? pollState.tentativeCourts.length : 0;
        const validSlotsCount = (Array.isArray(pollState.prebookedCourts) ? pollState.prebookedCourts.length : 0) * playersPerCourt;
        const courtLabel = formatCourtLabel(courtToBook.court);
        const failMsg = remainingTentativeCount === 0
          ? `⚠️ *${courtLabel}* is no longer available. Only *${validSlotsCount} voting slots* are valid for this match poll.`
          : `⚠️ *${courtLabel}* is no longer available.`;

        if (sock && remoteJid) {
          try {
            await sendMessageAndRecord(sock, remoteJid, { text: failMsg });
            console.log(`[poll] Sent court unavailable notification to group ${remoteJid}: "${failMsg}"`);
          } catch (sendErr) {
            console.error('[poll] Error sending court unavailable notification to group:', sendErr.message);
          }
          try {
            await sendBookingNotifications(sock, remoteJid, failMsg);
          } catch (sendErr) {
            console.error('[poll] Error sending court unavailable notification to notifications:', sendErr.message);
          }
        }
      }
    }

    // Phase 2: If available court was not booked, check if any tentative court has become free
    if (!bookedCourt && Array.isArray(pollState.tentativeCourts) && pollState.tentativeCourts.length > 0) {
      if (hasUnbooked) {
        availCache.clear(); // Clear cache so tentative check gets fresh availability
      }

      let freeTentative = null;
      let freeTentativeSlot = null;
      let freeTentativeTime = null;

      for (const tc of pollState.tentativeCourts) {
        const tcCandidateTimes = getCandidateTimesForCourt(tc);
        for (const t of tcCandidateTimes) {
          if (closedTimeKeys.has(normalizeTimeKey(t))) continue;
          const availAtTime = await getAvailForTime(t);
          const closedCheck = detectClosedSafe({ avail: availAtTime, time: t, chatId: remoteJid });
          if (closedCheck.clubClosed) {
            recordClosedTime(t, closedCheck.title);
            continue;
          }
          const slotAtTime = availAtTime?.slots?.find((s) => s.time === t) || availAtTime?.slots?.[0];
          if (isCourtFree(tc.court, slotAtTime?.courts)) {
            freeTentative = tc;
            freeTentativeSlot = slotAtTime;
            freeTentativeTime = t;
            break;
          }
        }
        if (freeTentative) break;
      }

      if (freeTentative) {
        console.log(`[poll] Tentative court ${freeTentative.court} is free on SCVCC at ${freeTentativeTime}. Attempting on-demand booking...`);
        const courtWithTime = { ...freeTentative, time: freeTentativeTime };
        const res = await attemptBookCourt(courtWithTime, freeTentativeSlot);
        if (res.isClubClosed || res.lastBookRes?.clubClosed) {
          recordClosedTime(freeTentativeTime, res.lastBookRes?.clubClosedTitle || null);
        }
        if (res.isSuccess) {
          bookedCourt = courtWithTime;
          bookingResult = res;
          bookedTime = freeTentativeTime;
          isTentativeBooking = true;
        } else if (!res.isClubClosed) {
          console.warn(`[poll] On-demand booking failed for free tentative court ${freeTentative.court} at ${freeTentativeTime} after ${MAX_ATTEMPTS} attempts: ${res.lastBookRes?.message || 'Court not available'}`);
          // Do not filter out tentative court, do not limit slots, and do not send failure message to the group.
          // The tentative court remains pending so booking can be retried on subsequent votes.
          if (sock && remoteJid) {
            try {
              const courtLabel = formatCourtLabel(freeTentative.court);
              const failMsg = `⚠️ Tentative *${courtLabel}* became available but could not be booked.`;
              await sendBookingNotifications(sock, remoteJid, failMsg);
            } catch (sendErr) {
              console.error('[poll] Error sending tentative court unavailable notification to notifications:', sendErr.message);
            }
          }
        }
      } else {
        console.log(`[poll] Tentative courts checked, but none are free yet on SCVCC (${pollState.tentativeCourts.map((c) => c.court).join(', ')})`);
      }
    }

    if (bookedCourt) {
      const finalBookedTime = bookingResult.lastBookRes?.time || bookedCourt.time || bookedTime || queryTime;
      console.log(`[poll] On-demand booking succeeded for ${bookedCourt.court} on ${targetDateMDY} at ${finalBookedTime}`);

      if (!Array.isArray(pollState.prebookedCourts)) pollState.prebookedCourts = [];
      pollState.prebookedCourts.push({
        court: bookingResult.lastBookRes?.court || bookedCourt.court,
        player: bookingResult.lastCourtPlayers[0] || 'Member',
        fullName: bookingResult.lastCourtPlayers.join(', '),
        time: finalBookedTime,
        bookingType: 'auto'
      });

      if (!Array.isArray(pollState.autoBookedCourts)) pollState.autoBookedCourts = [];
      const autoBookingEntry = {
        court: bookingResult.lastBookRes?.court || bookedCourt.court,
        players: bookingResult.lastBookRes?.players || bookingResult.lastCourtPlayers,
        time: finalBookedTime,
        reservationId: bookingResult.lastBookRes?.reservationId || null,
        duration: bookingResult.lastBookRes?.duration || '90 Minutes',
        partySize: bookingResult.lastBookRes?.partySize || (playersPerCourt === 2 ? 'Singles' : 'Doubles'),
        bookedAt: new Date().toISOString(),
        bookedSource: 'on-demand'
      };
      pollState.autoBookedCourts.push(autoBookingEntry);
      if (!Array.isArray(pollState.advanceBookedCourts)) pollState.advanceBookedCourts = [];
      if (pollState.advanceBookedCourts !== pollState.autoBookedCourts) {
        pollState.advanceBookedCourts.push(autoBookingEntry);
      }

      if (isTentativeBooking) {
        pollState.tentativeCourts = pollState.tentativeCourts.filter(
          (c) => formatCourtLabel(c.court).toLowerCase() !== formatCourtLabel(bookedCourt.court).toLowerCase()
        );
      } else {
        pollState.unbookedCourts = pollState.unbookedCourts.filter(
          (c) => formatCourtLabel(c.court).toLowerCase() !== formatCourtLabel(bookedCourt.court).toLowerCase()
        );
      }

      // On successful booking: do NOT send booking notifications to the group chat,
      // only send DMs to those listed in notifications.
      if (sock && remoteJid && bookingResult.lastBookRes?.message) {
        await sendBookingNotifications(sock, remoteJid, bookingResult.lastBookRes.message);
      }

      // Send a simple one liner message to the group that court x is booked and how many players can now play
      const totalPlayersCanPlay = (Array.isArray(pollState.prebookedCourts) ? pollState.prebookedCourts.length : 0) * playersPerCourt;
      const playerWord = totalPlayersCanPlay === 1 ? 'player' : 'players';
      const courtLabel = formatCourtLabel(bookingResult.lastBookRes?.court || bookedCourt.court);

      const qParsed = queryTime ? parseTimeString(queryTime) : null;
      const cParsed = finalBookedTime ? parseTimeString(finalBookedTime) : null;
      const isDiff = Boolean(cParsed && qParsed && (cParsed.hour !== qParsed.hour || cParsed.minute !== qParsed.minute));
      const timeSuffix = isDiff ? ` (${cParsed.formatted})` : '';

      const bookedGroupMsg = `🎾 *${courtLabel}${timeSuffix}* is booked! *${totalPlayersCanPlay} ${playerWord}* can now play.`;

      if (sock && remoteJid) {
        try {
          await sendMessageAndRecord(sock, remoteJid, { text: bookedGroupMsg });
          console.log(`[poll] Sent on-demand booking notification to group ${remoteJid}: "${bookedGroupMsg}"`);
        } catch (sendErr) {
          console.error('[poll] Error sending on-demand court booked notification to group:', sendErr.message);
        }
      }

      if (context.persistPolls) context.persistPolls();

      // Check if poll is now filled with the new court
      const currentRoster = resolveFixedPollRoster(pollState, aggregated);
      if (currentRoster.isAllFilled && pollState.status !== 'resolved' && pollState.status !== 'cancelled' && pollState.status !== 'stopped') {
        if (!shouldAutoGenerateLineupOnFill(pollState)) {
          if (pollState.status !== 'filled') {
            pollState.status = 'filled';
            pollState.lastPlayers = currentRoster.players;
            if (context.persistPolls) context.persistPolls();
          }
        } else {
          pollState.status = 'resolved';
          pollState.lastPlayers = currentRoster.players;
          if (context.persistPolls) context.persistPolls();
          await ratings.ensureRated(currentRoster.players);
          const prebookedCourts = await getPrebookedCourtsForPoll(pollState, pollState.remoteJid);
          const schedule = generateMatchups(currentRoster.players, { prebookedCourts, chatId: pollState.remoteJid });
          const whenHeader = formatMatchHeaderTime(pollState);
          const header = whenHeader ? `📅 ${whenHeader}

` : '';
          await sendMessageAndRecord(sock, pollState.remoteJid, { text: header + formatMatchups(schedule) });
          pairHistory.recordDraw(pollId, schedule, Date.now(), pollState.remoteJid);
          const playAtMs = pollState?.playAt ? new Date(pollState.playAt).getTime() : Date.now();
          playerActivity.recordPlayed(currentRoster.players, playAtMs, pollState.remoteJid);
          pollState.lastSchedule = summarizeSchedule(schedule);
          if (context.persistPolls) context.persistPolls();
        }
      }
    } else {
      const remainingUnbooked = Array.isArray(pollState.unbookedCourts) ? pollState.unbookedCourts.length : 0;
      const remainingTentative = Array.isArray(pollState.tentativeCourts) ? pollState.tentativeCourts.length : 0;

      if (remainingUnbooked === 0 && remainingTentative === 0) {
        const validSlotsCount = (Array.isArray(pollState.prebookedCourts) ? pollState.prebookedCourts.length : 0) * playersPerCourt;
        pollState.slotLimit = validSlotsCount;
        pollState.size = validSlotsCount;

        if (context.persistPolls) context.persistPolls();

        await checkAndNotifyInvalidSlotVotes(sock, pollId, pollState, aggregated, context);

        // Check if poll is filled after setting slotLimit
        const currentRoster = resolveFixedPollRoster(pollState, aggregated);
        if (currentRoster.isAllFilled && pollState.status !== 'resolved' && pollState.status !== 'cancelled' && pollState.status !== 'stopped') {
          if (!shouldAutoGenerateLineupOnFill(pollState)) {
            if (pollState.status !== 'filled') {
              pollState.status = 'filled';
              pollState.lastPlayers = currentRoster.players;
              if (context.persistPolls) context.persistPolls();
            }
          } else {
            pollState.status = 'resolved';
            pollState.lastPlayers = currentRoster.players;
            if (context.persistPolls) context.persistPolls();
            await ratings.ensureRated(currentRoster.players);
            const prebookedCourts = await getPrebookedCourtsForPoll(pollState, pollState.remoteJid);
            const schedule = generateMatchups(currentRoster.players, { prebookedCourts, chatId: pollState.remoteJid });
            const whenHeader = formatMatchHeaderTime(pollState);
            const header = whenHeader ? `📅 ${whenHeader}

` : '';
            await sendMessageAndRecord(sock, pollState.remoteJid, { text: header + formatMatchups(schedule) });
            pairHistory.recordDraw(pollId, schedule, Date.now(), pollState.remoteJid);
            const playAtMs = pollState?.playAt ? new Date(pollState.playAt).getTime() : Date.now();
            playerActivity.recordPlayed(currentRoster.players, playAtMs, pollState.remoteJid);
            pollState.lastSchedule = summarizeSchedule(schedule);
            if (context.persistPolls) context.persistPolls();
          }
        }
      } else {
        console.log(`[poll] On-demand booking did not book a court; unbooked remaining: ${remainingUnbooked}, tentative remaining: ${remainingTentative}`);
      }
    }
  } catch (err) {
    console.error('[poll] Unexpected error in handleOnDemandCourtBooking:', err.message);
  } finally {
    pollState.onDemandBookingInProgress = false;
    pollState._bookingActive = false;
  }
}

function isDirectBookingUser(member, chatId = null) {
  if (!member) return false;
  const directAccounts = groupsConfig.getDirectCourtBookingAccounts(chatId);
  if (directAccounts.size === 0) return false;

  const id = (member.id || '').toLowerCase();
  const idNum = id.split('@')[0];
  const pn = (member.pn || '').toLowerCase();
  const pnNum = pn.split('@')[0];
  const full = (member.fullName || '').toLowerCase().trim();
  const disp = (member.name || '').toLowerCase().trim();

  return directAccounts.has(id) || directAccounts.has(idNum) || (pn && (directAccounts.has(pn) || directAccounts.has(pnNum))) || (full && directAccounts.has(full)) || (disp && directAccounts.has(disp));
}

function isPlaceholderPlayer(name) {
  if (!name) return true;
  const c = name.trim().toLowerCase();
  return !c || c === 'tbd' || c === 'blocked';
}

function getPlayerShortName(entry) {
  if (!entry) return '';
  const name = entry.name || entry.fullName || '';
  const words = name.trim().split(/\s+/);
  return words.length > 1 ? words[0] : name.trim();
}

function matchScvccPlayerToGroupMember(scvccPlayerName) {
  if (!scvccPlayerName) return null;
  const clean = scvccPlayerName.trim().toLowerCase();
  if (!clean || clean === 'tbd' || clean === 'blocked') return null;

  const scvccWords = clean.split(/[^a-z0-9]+/i).filter(Boolean);
  if (scvccWords.length === 0) return null;

  const allEntries = namesStore.getAllEntries();

  for (const entry of allEntries) {
    const full = (entry.fullName || '').trim().toLowerCase();
    const disp = (entry.name || '').trim().toLowerCase();
    if (full && clean === full) return entry;
    if (disp && clean === disp) return entry;
  }

  if (clean.includes(',')) {
    const [last, first] = clean.split(',').map((s) => s.trim());
    if (first && last) {
      const reordered = `${first} ${last}`.toLowerCase();
      for (const entry of allEntries) {
        const full = (entry.fullName || '').trim().toLowerCase();
        if (full && reordered === full) return entry;
        const disp = (entry.name || '').trim().toLowerCase();
        if (disp && reordered === disp) return entry;
      }
    }
  }

  if (scvccWords.length >= 2) {
    const scvccFirst = scvccWords[0];
    const scvccLast = scvccWords[scvccWords.length - 1];

    for (const entry of allEntries) {
      const full = (entry.fullName || '').trim().toLowerCase();
      if (full) {
        const fullWords = full.split(/[^a-z0-9]+/i).filter(Boolean);
        if (fullWords.length >= 2) {
          if (scvccFirst === fullWords[0] && scvccLast === fullWords[fullWords.length - 1]) {
            return entry;
          }
        }
      }
    }
  }

  const byAlias = namesStore.findIdByNameOrAlias(scvccPlayerName);
  if (byAlias && byAlias.entry) {
    return byAlias.entry;
  }

  return null;
}

function detectPrebookedCourt(booking, chatId = null) {
  if (!booking || !Array.isArray(booking.players)) return null;
  if (courtsConfig.isIgnoredCourt(booking.court)) return null;

  const actualPlayers = booking.players.filter((p) => !isPlaceholderPlayer(p));
  if (actualPlayers.length === 0) return null;

  let directBookingMember = null;
  let allMembers = true;
  const matchedMembers = [];

  for (const p of actualPlayers) {
    const member = matchScvccPlayerToGroupMember(p);
    if (member) {
      matchedMembers.push(member);
      if (isDirectBookingUser(member, chatId)) {
        if (!directBookingMember) directBookingMember = member;
      }
    } else {
      allMembers = false;
    }
  }

  if (directBookingMember) {
    const playerName = getPlayerShortName(directBookingMember);
    return {
      isPrebooked: true,
      player: playerName,
      fullName: directBookingMember.fullName || directBookingMember.name,
      member: directBookingMember
    };
  }

  if (allMembers && matchedMembers.length > 0) {
    const ownerMember = matchedMembers[0];
    const playerName = getPlayerShortName(ownerMember);
    return {
      isPrebooked: true,
      player: playerName,
      fullName: ownerMember.fullName || ownerMember.name,
      member: ownerMember
    };
  }

  return null;
}

module.exports = {
  releaseAllCourtsForPollState,
  parseReleaseCourtsArgs,
  handleReleasePollCourts,
  getPrebookedCourtsForPoll,
  checkCourtReleasesForPoll,
  checkCourtReleases,
  shuffleArray,
  preBookCourtsForMatch,
  normalizeCourtPreference,
  getCourtPreferenceRank,
  sortCourtsByPreference,
  formatCourtLabel,
  formatCourtBookingTitleLine,
  formatCourtAvailableTitleLine,
  formatCourtTentativeTitleLine,
  handleOnDemandCourtBooking,
  isDirectBookingUser,
  isPlaceholderPlayer,
  getPlayerShortName,
  matchScvccPlayerToGroupMember,
  detectPrebookedCourt
};
