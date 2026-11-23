/**
 * SCVCC Court Booking & Status Commands
 * Handles !courtbookings, !courts, !bookcourt, !modifycourt, !cancelcourt,
 * !mybookings, !webcam, !pausecourtbookings, !resumecourtbookings,
 * court booking notifications, and poll-booking state synchronization.
 */

const { jidNormalizedUser } = require('@whiskeysockets/baileys');
const scvcc = require('../scvcc');
const { parseTimeString } = require('../pollTime');
const { formatCourtLabel } = scvcc;
const groupsConfig = require('../groupsConfig');
const namesStore = require('../names');
const { sendMessageAndRecord } = require('../botMessage');
const { isUserAdmin, resolveTargetChat, extractGroupFlag } = require('./groupCommands');
const { normalizeCommandDashes } = require('../textNormalize');

/**
 * Sends court booking confirmations, cancellation messages, and alerts to LIDs specified
 * in notifications configuration for the group.
 */
async function sendBookingNotifications(sock, chatId, message, excludeJids = []) {
  if (!sock || !chatId || !message) return;
  try {
    const recipients = (groupsConfig.getNotifications || groupsConfig.getBookingNotifications)(chatId);
    if (!recipients || recipients.length === 0) return;

    const excluded = (Array.isArray(excludeJids) ? excludeJids : [excludeJids])
      .filter(Boolean)
      .flatMap(j => {
        const norm = jidNormalizedUser(j);
        const canon = namesStore.resolveCanonicalId(norm || j);
        const pn = namesStore.getPnByLid(norm || j);
        return [j, norm, canon, pn].filter(Boolean).map(x => String(x).toLowerCase());
      });
    const excludedSet = new Set(excluded);

    // Do not include information about admin override in notification messages
    const cleanMessage = message
      .replace(/\s*\*\((?:Admin\s+)?Override\)\*/gi, '')
      .replace(/\s*\((?:Admin\s+)?Override\)/gi, '');

    for (const recipient of recipients) {
      if (chatId.toLowerCase() === recipient.toLowerCase()) continue;
      const recNorm = jidNormalizedUser(recipient) || recipient;
      const recCanon = namesStore.resolveCanonicalId(recNorm);
      if (
        excludedSet.has(recipient.toLowerCase()) ||
        excludedSet.has(recNorm.toLowerCase()) ||
        (recCanon && excludedSet.has(recCanon.toLowerCase()))
      ) {
        continue;
      }

      try {
        await sendMessageAndRecord(sock, recipient, { text: cleanMessage });
        console.log(`[notifications] Sent booking notification to ${recipient} for group ${chatId}`);
      } catch (err) {
        console.error(`[notifications] Failed to send booking notification to ${recipient}:`, err.message);
      }
    }
  } catch (err) {
    console.error('[notifications] Error in sendBookingNotifications:', err.message);
  }
}

const notify = (...args) => module.exports.sendBookingNotifications(...args);

/**
 * Resolves the target WhatsApp group JID and verifies admin authorization.
 * If groupQuery is provided (or if targeting a different group), checks if sender is an admin or superadmin.
 */
async function resolveTargetChatId(sock, chatId, senderJid, groupQuery = null, context = {}) {
  return await resolveTargetChat(sock, chatId, senderJid, groupQuery, context, {
    actionDesc: 'modify court bookings for this group'
  });
}

function formatCourtBookingTitleLine(court, courtTime, baseTime) {
  const label = formatCourtLabel(court);
  const qParsed = baseTime ? parseTimeString(baseTime) : null;
  const cParsed = courtTime ? parseTimeString(courtTime) : null;
  const isDiff = Boolean(
    cParsed && qParsed && (cParsed.hour !== qParsed.hour || cParsed.minute !== qParsed.minute)
  );
  const timeSuffix = isDiff ? ` (${cParsed.formatted})` : '';
  return `${label}${timeSuffix} - Booked`;
}

function findAdvanceBookingInPolls(context, { court = null, date = null, time = null, chatId = null } = {}) {
  if (!context) return null;
  const { activePolls, recurringPolls } = context;
  const courtLabel = court ? formatCourtLabel(court).toLowerCase() : null;
  const dateMDY = date ? scvcc.resolveDateToMDY(date) : null;
  const parsedTime = time ? parseTimeString(time) : null;

  if (activePolls instanceof Map) {
    for (const [, pollState] of activePolls.entries()) {
      if (chatId && pollState.remoteJid && pollState.remoteJid !== chatId) continue;
      const pollBookings = pollState.advanceBookedCourts || pollState.autoBookedCourts;
      if (Array.isArray(pollBookings)) {
        for (const b of pollBookings) {
          if (!b.reservationId) continue;
          const matchCourt = !courtLabel || formatCourtLabel(b.court).toLowerCase() === courtLabel;
          const pollMDY = pollState.playAt ? scvcc.resolveDateToMDY(new Date(pollState.playAt)) : (pollState.when ? scvcc.resolveDateToMDY(pollState.when) : null);
          const bDateMDY = b.date ? (scvcc.resolveDateToMDY(b.date) || b.date) : null;
          const matchDate = !dateMDY || bDateMDY === dateMDY || b.date === dateMDY || pollMDY === dateMDY;
          const bTimeParsed = b.time ? parseTimeString(b.time) : null;
          const matchTime = !parsedTime || !bTimeParsed || (parsedTime.hour === bTimeParsed.hour && parsedTime.minute === bTimeParsed.minute);
          if (matchCourt && matchDate && matchTime) {
            return b;
          }
        }
      }
    }
  }

  if (recurringPolls instanceof Map) {
    for (const [, sched] of recurringPolls.entries()) {
      if (chatId && sched.remoteJid && sched.remoteJid !== chatId) continue;
      if (sched.advanceBookings) {
        for (const [schedDateKey, entry] of Object.entries(sched.advanceBookings)) {
          const entryBookings = entry && (entry.advanceBookedCourts || entry.autoBookedCourts);
          if (Array.isArray(entryBookings)) {
            const entryMDY = entry.targetDateMDY || (schedDateKey ? scvcc.resolveDateToMDY(schedDateKey) : null);
            for (const b of entryBookings) {
              if (!b.reservationId) continue;
              const matchCourt = !courtLabel || formatCourtLabel(b.court).toLowerCase() === courtLabel;
              const bDateMDY = b.date ? (scvcc.resolveDateToMDY(b.date) || b.date) : entryMDY;
              const matchDate = !dateMDY || bDateMDY === dateMDY || b.date === dateMDY || entryMDY === dateMDY;
              const bTimeParsed = b.time ? parseTimeString(b.time) : null;
              const matchTime = !parsedTime || !bTimeParsed || (parsedTime.hour === bTimeParsed.hour && parsedTime.minute === bTimeParsed.minute);
              if (matchCourt && matchDate && matchTime) {
                return b;
              }
            }
          }
        }
      }
    }
  }

  if (parsedTime) {
    return findAdvanceBookingInPolls(context, { court, date, time: null, chatId });
  }

  return null;
}

function findAllAdvanceBookingsInPolls(context, { date = null, when = null, time = null, chatId = null } = {}) {
  if (!context) return [];
  const { activePolls, recurringPolls } = context;
  const targetDateStr = date || when;
  const dateMDY = targetDateStr ? scvcc.resolveDateToMDY(targetDateStr) : null;
  const parsedTime = time ? parseTimeString(time) : null;
  const bookings = [];
  const seenResIds = new Set();

  if (activePolls instanceof Map) {
    for (const [, pollState] of activePolls.entries()) {
      if (!pollState || typeof pollState !== "object") continue;
      if (chatId && pollState.remoteJid && pollState.remoteJid !== chatId) continue;
      if (pollState.status === "cancelled") continue;

      const pollMDY = pollState.playAt ? scvcc.resolveDateToMDY(new Date(pollState.playAt)) : (pollState.when ? scvcc.resolveDateToMDY(pollState.when) : null);
      const matchDate = !dateMDY || pollMDY === dateMDY;

      const pollBookings = pollState.advanceBookedCourts || pollState.autoBookedCourts;
      if (Array.isArray(pollBookings)) {
        for (const b of pollBookings) {
          if (!b.reservationId || seenResIds.has(String(b.reservationId))) continue;
          const bDateMDY = b.date ? (scvcc.resolveDateToMDY(b.date) || b.date) : null;
          const bMatchDate = !dateMDY || bDateMDY === dateMDY || b.date === dateMDY || matchDate;
          if (!bMatchDate) continue;
          const bTimeParsed = b.time ? parseTimeString(b.time) : null;
          const matchTime = !parsedTime || !bTimeParsed || (parsedTime.hour === bTimeParsed.hour && parsedTime.minute === bTimeParsed.minute);
          if (matchTime) {
            seenResIds.add(String(b.reservationId));
            bookings.push(b);
          }
        }
      }
    }
  }

  if (recurringPolls instanceof Map) {
    for (const [, sched] of recurringPolls.entries()) {
      if (!sched || typeof sched !== "object" || !sched.advanceBookings) continue;
      if (chatId && sched.remoteJid && sched.remoteJid !== chatId) continue;
      for (const [schedDateKey, entry] of Object.entries(sched.advanceBookings)) {
        const entryBookings = entry && (entry.advanceBookedCourts || entry.autoBookedCourts);
        if (!entry || !Array.isArray(entryBookings)) continue;
        const entryMDY = entry.targetDateMDY || (schedDateKey ? scvcc.resolveDateToMDY(schedDateKey) : null);
        for (const b of entryBookings) {
          if (!b.reservationId || seenResIds.has(String(b.reservationId))) continue;
          const bDateMDY = b.date ? (scvcc.resolveDateToMDY(b.date) || b.date) : entryMDY;
          const matchDate = !dateMDY || bDateMDY === dateMDY || b.date === dateMDY || entryMDY === dateMDY;
          if (!matchDate) continue;
          const bTimeParsed = b.time ? parseTimeString(b.time) : null;
          const matchTime = !parsedTime || !bTimeParsed || (parsedTime.hour === bTimeParsed.hour && parsedTime.minute === bTimeParsed.minute);
          if (matchTime) {
            seenResIds.add(String(b.reservationId));
            bookings.push(b);
          }
        }
      }
    }
  }

  return bookings;
}

function updatePollStateForModifiedBooking(context, {
  reservationId,
  oldCourt = null,
  newCourt = null,
  oldTime = null,
  newTime = null,
  oldDate = null,
  newDate = null,
  newPlayers = null,
  newDuration = null,
  newPartySize = null,
  chatId = null
} = {}) {
  if (!context) return { updated: false };
  const { activePolls, recurringPolls, persistPolls } = context;
  let updatedAny = false;

  const targetOldCourt = oldCourt ? formatCourtLabel(oldCourt) : null;
  const targetNewCourt = newCourt ? formatCourtLabel(newCourt) : null;

  if (activePolls instanceof Map) {
    for (const [, pollState] of activePolls.entries()) {
      if (!pollState || typeof pollState !== 'object') continue;
      if (chatId && pollState.remoteJid && pollState.remoteJid !== chatId) continue;
      let pollModified = false;

      const pollBookings = pollState.advanceBookedCourts || pollState.autoBookedCourts;
      if (Array.isArray(pollBookings)) {
        for (const b of pollBookings) {
          const matchResId = reservationId && String(b.reservationId) === String(reservationId);
          const matchCourt = targetOldCourt && formatCourtLabel(b.court).toLowerCase() === targetOldCourt.toLowerCase();
          const matchDate = !oldDate || b.date === oldDate;

          if (matchResId || (matchCourt && matchDate)) {
            const actualOldCourt = b.court;
            const actualOldTime = b.time;

            if (targetNewCourt) b.court = targetNewCourt;
            if (newTime) b.time = newTime;
            if (newDate) b.date = newDate;
            if (Array.isArray(newPlayers) && newPlayers.length > 0) b.players = [...newPlayers];
            if (newDuration) b.duration = newDuration;
            if (newPartySize) b.partySize = newPartySize;
            pollModified = true;

            if (Array.isArray(pollState.prebookedCourts)) {
              for (const pb of pollState.prebookedCourts) {
                if (formatCourtLabel(pb.court).toLowerCase() === formatCourtLabel(actualOldCourt).toLowerCase()) {
                  if (targetNewCourt) pb.court = targetNewCourt;
                  if (newTime) pb.time = newTime;
                  if (newDate) pb.date = newDate;
                  if (Array.isArray(newPlayers) && newPlayers.length > 0) {
                    pb.player = newPlayers[0];
                    pb.fullName = newPlayers.join(', ');
                  }
                }
              }
            }

            if (Array.isArray(pollState.autoBookedCourts)) {
              for (const ab of pollState.autoBookedCourts) {
                if (formatCourtLabel(ab.court).toLowerCase() === formatCourtLabel(actualOldCourt).toLowerCase()) {
                  if (targetNewCourt) ab.court = targetNewCourt;
                  if (newTime) ab.time = newTime;
                  if (newDate) ab.date = newDate;
                  if (Array.isArray(newPlayers) && newPlayers.length > 0) ab.players = [...newPlayers];
                }
              }
            }

            if (Array.isArray(pollState.manuallyBookedCourts)) {
              for (const mb of pollState.manuallyBookedCourts) {
                if (formatCourtLabel(mb.court).toLowerCase() === formatCourtLabel(actualOldCourt).toLowerCase()) {
                  if (targetNewCourt) mb.court = targetNewCourt;
                  if (newTime) mb.time = newTime;
                  if (newDate) mb.date = newDate;
                }
              }
            }

            if (pollState.name && typeof pollState.name === 'string') {
              const oldLabel = formatCourtLabel(actualOldCourt);
              const newLabel = targetNewCourt || oldLabel;
              const escapedOld = oldLabel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
              const bookingRegex = new RegExp("(?:" + escapedOld + ")(?:\\s*\\([^)]+\\))?\\s*-\\s*Booked", "gi");
              const newLine = formatCourtBookingTitleLine(newLabel, newTime || actualOldTime, pollState.queryTime);
              if (bookingRegex.test(pollState.name)) {
                pollState.name = pollState.name.replace(bookingRegex, newLine);
              } else if (targetNewCourt && targetNewCourt !== oldLabel) {
                pollState.name = pollState.name.replace(new RegExp("\\b" + escapedOld + "\\b", "gi"), targetNewCourt);
              }
            }

            if (pollState.court && formatCourtLabel(pollState.court).toLowerCase() === formatCourtLabel(actualOldCourt).toLowerCase()) {
              pollState.court = targetNewCourt || actualOldCourt;
            }

            if (Array.isArray(pollState.prebookedPlayers)) {
              for (const p of pollState.prebookedPlayers) {
                if (p.court && formatCourtLabel(p.court).toLowerCase() === formatCourtLabel(actualOldCourt).toLowerCase()) {
                  if (targetNewCourt) p.court = targetNewCourt;
                }
              }
            }
          }
        }
      }

      if (pollModified) {
        updatedAny = true;
      }
    }
  }

  if (recurringPolls instanceof Map) {
    for (const [, sched] of recurringPolls.entries()) {
      if (!sched || typeof sched !== 'object' || !sched.advanceBookings) continue;
      if (chatId && sched.remoteJid && sched.remoteJid !== chatId) continue;
      for (const [, entry] of Object.entries(sched.advanceBookings)) {
        if (!entry || typeof entry !== 'object') continue;
        const entryBookings = entry.advanceBookedCourts || entry.autoBookedCourts;
        if (Array.isArray(entryBookings)) {
          for (const b of entryBookings) {
            const matchResId = reservationId && String(b.reservationId) === String(reservationId);
            const matchCourt = targetOldCourt && formatCourtLabel(b.court).toLowerCase() === targetOldCourt.toLowerCase();
            const matchDate = !oldDate || b.date === oldDate;

            if (matchResId || (matchCourt && matchDate)) {
              const actualOldCourt = b.court;
              if (targetNewCourt) b.court = targetNewCourt;
              if (newTime) b.time = newTime;
              if (newDate) b.date = newDate;
              if (Array.isArray(newPlayers) && newPlayers.length > 0) b.players = [...newPlayers];
              if (newDuration) b.duration = newDuration;
              if (newPartySize) b.partySize = newPartySize;
              updatedAny = true;

              if (Array.isArray(entry.prebookedCourts)) {
                for (const pb of entry.prebookedCourts) {
                  if (formatCourtLabel(pb.court).toLowerCase() === formatCourtLabel(actualOldCourt).toLowerCase()) {
                    if (targetNewCourt) pb.court = targetNewCourt;
                    if (newTime) pb.time = newTime;
                    if (newDate) pb.date = newDate;
                    if (Array.isArray(newPlayers) && newPlayers.length > 0) {
                      pb.player = newPlayers[0];
                      pb.fullName = newPlayers.join(', ');
                    }
                  }
                }
              }

              if (Array.isArray(entry.autoBookedCourts)) {
                for (const ab of entry.autoBookedCourts) {
                  if (formatCourtLabel(ab.court).toLowerCase() === formatCourtLabel(actualOldCourt).toLowerCase()) {
                    if (targetNewCourt) ab.court = targetNewCourt;
                    if (newTime) ab.time = newTime;
                    if (newDate) ab.date = newDate;
                    if (Array.isArray(newPlayers) && newPlayers.length > 0) ab.players = [...newPlayers];
                  }
                }
              }
            }
          }
        }
      }
    }
  }

  if (updatedAny && typeof persistPolls === 'function') {
    persistPolls(chatId);
  }

  return { updated: updatedAny };
}

function removePollStateForCancelledBooking(context, {
  reservationId,
  court = null,
  date = null,
  time = null,
  chatId = null
} = {}) {
  if (!context) return { removed: false };
  const { activePolls, recurringPolls, persistPolls } = context;
  let removedAny = false;

  const targetCourtLabel = court ? formatCourtLabel(court) : null;

  if (activePolls instanceof Map) {
    for (const [, pollState] of activePolls.entries()) {
      if (!pollState || typeof pollState !== 'object') continue;
      let pollModified = false;

      const pollBookings = pollState.advanceBookedCourts || pollState.autoBookedCourts;
      if (Array.isArray(pollBookings)) {
        const matched = pollBookings.filter(b => {
          const matchResId = reservationId && String(b.reservationId) === String(reservationId);
          const matchCourt = targetCourtLabel && formatCourtLabel(b.court).toLowerCase() === targetCourtLabel.toLowerCase();
          const matchDate = !date || b.date === date;
          return matchResId || (matchCourt && matchDate);
        });

        if (matched.length > 0) {
          for (const m of matched) {
            const mCourtLabel = formatCourtLabel(m.court);
            if (!Array.isArray(pollState.releasedCourts)) pollState.releasedCourts = [];
            if (!pollState.releasedCourts.some(rc => formatCourtLabel(rc.court).toLowerCase() === mCourtLabel.toLowerCase())) {
              pollState.releasedCourts.push({ court: mCourtLabel, time: m.time || null });
            }

            if (Array.isArray(pollState.prebookedCourts)) {
              pollState.prebookedCourts = pollState.prebookedCourts.filter(
                pb => formatCourtLabel(pb.court).toLowerCase() !== mCourtLabel.toLowerCase()
              );
            }
            if (Array.isArray(pollState.autoBookedCourts)) {
              pollState.autoBookedCourts = pollState.autoBookedCourts.filter(
                ab => formatCourtLabel(ab.court).toLowerCase() !== mCourtLabel.toLowerCase()
              );
            }
            if (Array.isArray(pollState.manuallyBookedCourts)) {
              pollState.manuallyBookedCourts = pollState.manuallyBookedCourts.filter(
                mb => formatCourtLabel(mb.court).toLowerCase() !== mCourtLabel.toLowerCase()
              );
            }
            if (pollState.name && typeof pollState.name === 'string') {
              const escapedM = mCourtLabel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
              const bookingRegex = new RegExp("(?:" + escapedM + ")(?:\\s*\\([^)]+\\))?\\s*-\\s*Booked", "gi");
              pollState.name = pollState.name.replace(bookingRegex, mCourtLabel + " - Cancelled");
            }
          }

          if (Array.isArray(pollState.advanceBookedCourts)) {
            pollState.advanceBookedCourts = pollState.advanceBookedCourts.filter(b => !matched.includes(b));
          }
          pollModified = true;
        }
      }

      if (pollModified) removedAny = true;
    }
  }

  if (recurringPolls instanceof Map) {
    for (const [, sched] of recurringPolls.entries()) {
      if (!sched || typeof sched !== 'object' || !sched.advanceBookings) continue;
      for (const [, entry] of Object.entries(sched.advanceBookings)) {
        if (!entry || typeof entry !== 'object') continue;
        const entryBookings = entry.advanceBookedCourts || entry.autoBookedCourts;
        if (Array.isArray(entryBookings)) {
          const matched = entryBookings.filter(b => {
            const matchResId = reservationId && String(b.reservationId) === String(reservationId);
            const matchCourt = targetCourtLabel && formatCourtLabel(b.court).toLowerCase() === targetCourtLabel.toLowerCase();
            const matchDate = !date || b.date === date;
            return matchResId || (matchCourt && matchDate);
          });
          if (matched.length > 0) {
            for (const m of matched) {
              const mCourtLabel = formatCourtLabel(m.court);
              if (Array.isArray(entry.prebookedCourts)) {
                entry.prebookedCourts = entry.prebookedCourts.filter(
                  pb => formatCourtLabel(pb.court).toLowerCase() !== mCourtLabel.toLowerCase()
                );
              }
              if (Array.isArray(entry.autoBookedCourts)) {
                entry.autoBookedCourts = entry.autoBookedCourts.filter(
                  ab => formatCourtLabel(ab.court).toLowerCase() !== mCourtLabel.toLowerCase()
                );
              }
            }
            if (Array.isArray(entry.advanceBookedCourts)) {
              entry.advanceBookedCourts = entry.advanceBookedCourts.filter(b => !matched.includes(b));
            }
            removedAny = true;
          }
        }
      }
    }
  }

  if (removedAny && typeof persistPolls === 'function') {
    persistPolls(chatId);
  }

  return { removed: removedAny };
}

/**
 * Shared execution handlers used by both text commands and LLM tools.
 */

async function handleGetCourtBookings(params, chatId) {
  const res = await scvcc.getCourtBookings({ ...params, chatId });
  return res?.message || 'Could not retrieve court bookings.';
}

async function handleCheckCourtAvailability(params, chatId) {
  const res = await scvcc.checkCourtAvailability({ ...params, chatId });
  return res?.message || 'Could not retrieve court status.';
}

async function handleBookCourt({ sock, params, sender, senderJid = null, chatId, context = {}, excludeJids = [], notifyFn }) {
  const pollIdParam = params?.pollId || params?.poll_id || null;
  if (pollIdParam) {
    const targetGroup = params.group || params.targetGroup || params.groupName || params.jid || null;
    let effectiveChatId = chatId;
    let groupQueryChatId = null;
    if (targetGroup) {
      const { targetChatId, error: groupError } = await resolveTargetChat(sock, chatId, senderJid, targetGroup, context, {
        requireAdmin: false,
        actionDesc: 'book courts for this group'
      });
      if (groupError) return groupError;
      effectiveChatId = targetChatId;
      groupQueryChatId = targetChatId;
    }
    const { handleBookPollCourts } = require('./poll/courts');
    return await handleBookPollCourts(sock, effectiveChatId, sender, senderJid, null, context, groupQueryChatId, chatId, {
      pollId: pollIdParam,
      all: params.all,
      count: params.count,
      mode: params.mode,
      court: params.court || params.specificCourt || null,
      bookingDuration: params.bookingDuration || params.duration || params.booking_duration || null
    });
  }

  const isSingles = params.partySize === 'Singles';
  const maxNeeded = isSingles ? 2 : 4;
  // If full roster of players is already specified (4 for doubles, 2 for singles),
  // let Player 1 come from the list rather than inserting the sender.
  const defaultRequester = (params.players && params.players.length >= maxNeeded) ? null : sender;

  const res = await scvcc.bookCourt({
    ...params,
    requester: params.requester || defaultRequester,
    requestedBy: sender,
    chatId
  });
  if (res && res.success && res.message && typeof notifyFn === 'function') {
    await notifyFn(sock, chatId, res.message, excludeJids);
  }
  return res?.message || 'Could not complete court booking.';
}

async function handleModifyCourt({ sock, params, chatId, sender, senderJid = null, context = {}, notifyFn }) {
  const targetGroup = params.group || params.targetGroup || params.groupName || params.jid || null;
  const { targetChatId, error: groupError } = await resolveTargetChatId(sock, chatId, senderJid, targetGroup, context);
  if (groupError) {
    return groupError;
  }

  // Shortcut: modify all courts for a given day (e.g. "!modifycourt Thursday to 7pm")
  if (params.allCourtsForDay) {
    let bookings = findAllAdvanceBookingsInPolls(context, {
      date: params.date || params.when,
      when: params.when,
      time: params.oldTime,
      chatId: targetChatId
    });

    if (!bookings || bookings.length === 0) {
      try {
        const myRes = await scvcc.getMyReservations(targetChatId);
        if (myRes?.success && Array.isArray(myRes.reservations) && myRes.reservations.length > 0) {
          const targetDateMDY = (params.date || params.when) ? scvcc.resolveDateToMDY(params.date || params.when) : null;
          const parsedOldTime = params.oldTime ? parseTimeString(params.oldTime) : null;
          bookings = myRes.reservations.filter(r => {
            if (!r.id) return false;
            const rDateMDY = r.date ? (scvcc.resolveDateToMDY(r.date) || r.date) : null;
            if (targetDateMDY && rDateMDY && rDateMDY !== targetDateMDY) return false;
            if (parsedOldTime) {
              const rTimeParsed = r.time ? parseTimeString(r.time) : null;
              if (rTimeParsed && (rTimeParsed.hour !== parsedOldTime.hour || rTimeParsed.minute !== parsedOldTime.minute)) return false;
            }
            return true;
          }).map(r => ({
            reservationId: r.id,
            court: r.court,
            date: r.date,
            time: r.time
          }));
        }
      } catch (e) {
        console.warn('[court] Error checking getMyReservations fallback for allCourtsForDay:', e.message);
      }
    }

    if (!bookings || bookings.length === 0) {
      return `⚠️ No advance court bookings found on record or at SCVCC for ${params.when || 'that day'}.`;
    }

    const results = [];
    for (const b of bookings) {
      const res = await scvcc.modifyCourtBooking({
        reservationId: b.reservationId,
        court: b.court,
        time: params.time,
        date: params.date || params.when,
        requestedBy: sender,
        chatId: targetChatId
      });

      if (res && res.success) {
        if (context) {
          updatePollStateForModifiedBooking(context, {
            reservationId: b.reservationId,
            oldCourt: b.court,
            newCourt: res.court || b.court,
            newTime: res.time || params.time,
            newDate: res.date,
            newPlayers: res.players,
            newDuration: res.duration,
            newPartySize: res.partySize,
            chatId: targetChatId
          });
        }
        results.push(res);
      } else {
        results.push({ error: true, court: b.court, message: res?.message });
      }
    }

    const successes = results.filter(r => r && r.success);
    const failures = results.filter(r => r && r.error);

    if (successes.length > 0) {
      const summaryMsg = `✅ Successfully moved ${successes.length} court reservation(s) for ${params.when || 'the day'} to ${params.time}:\n` +
        successes.map(s => `• *${s.court}:* ${s.time} (Reservation \`${s.reservationId}\`)`).join('\n') +
        (failures.length > 0 ? `\n⚠️ Could not move: ${failures.map(f => `${f.court} (${f.message})`).join(', ')}` : '');

      if (typeof notifyFn === 'function') {
        await notifyFn(sock, targetChatId, summaryMsg, [senderJid, chatId]);
      }
      return summaryMsg;
    }

    return `⚠️ Could not move court bookings for ${params.when}: ${failures.map(f => f.message).join('; ')}`;
  }

  let resId = params.reservationId || params.resId || params.id;
  let oldCourt = params.targetCourt || params.oldCourt;
  const lookupTime = params.oldTime || null;

  if (!resId && (oldCourt || params.court)) {
    const found = findAdvanceBookingInPolls(context, {
      court: oldCourt || params.court,
      date: params.date || params.when,
      time: lookupTime,
      chatId: targetChatId
    });
    if (found) {
      resId = found.reservationId;
      oldCourt = oldCourt || found.court;
    }
  }

  // Fallback: If not found in poll memory, check live member reservations from SCVCC
  if (!resId && (oldCourt || params.court)) {
    try {
      const myRes = await scvcc.getMyReservations(targetChatId);
      if (myRes?.success && Array.isArray(myRes.reservations) && myRes.reservations.length > 0) {
        const targetCourtLabel = formatCourtLabel(oldCourt || params.court).toLowerCase();
        const targetDateMDY = (params.date || params.when) ? scvcc.resolveDateToMDY(params.date || params.when) : null;
        const parsedOldTime = lookupTime ? parseTimeString(lookupTime) : null;

        const matched = myRes.reservations.find(r => {
          if (!r.id) return false;
          const rCourt = r.court ? formatCourtLabel(r.court).toLowerCase() : '';
          if (rCourt !== targetCourtLabel && !rCourt.includes(targetCourtLabel)) return false;
          const rDateMDY = r.date ? (scvcc.resolveDateToMDY(r.date) || r.date) : null;
          if (targetDateMDY && rDateMDY && rDateMDY !== targetDateMDY) return false;
          if (parsedOldTime) {
            const rTimeParsed = r.time ? parseTimeString(r.time) : null;
            if (rTimeParsed && (rTimeParsed.hour !== parsedOldTime.hour || rTimeParsed.minute !== parsedOldTime.minute)) return false;
          }
          return true;
        });

        if (matched && matched.id) {
          resId = matched.id;
          oldCourt = oldCourt || matched.court;
          if (!params.when && matched.date) params.date = matched.date;
        }
      }
    } catch (e) {
      console.warn('[court] Error checking getMyReservations fallback for modifycourt:', e.message);
    }

    if (!resId) {
      try {
        const bookingsRes = await scvcc.getCourtBookings({
          when: params.date || params.when,
          court: oldCourt || params.court,
          sport: 'tennis',
          chatId: targetChatId
        });
        if (bookingsRes?.slots) {
          const targetCourtLabel = formatCourtLabel(oldCourt || params.court).toLowerCase();
          for (const slot of bookingsRes.slots) {
            const c = slot.courts?.find(c => formatCourtLabel(c.court).toLowerCase() === targetCourtLabel);
            if (c && c.resId) {
              resId = c.resId;
              oldCourt = oldCourt || c.court;
              break;
            }
          }
        }
      } catch (e) {
        console.warn('[court] Error checking getCourtBookings grid fallback for modifycourt:', e.message);
      }
    }
  }

  if (!resId) {
    const whenStr = params.when ? ` on ${params.when}` : '';
    const courtStr = (oldCourt || params.court) ? ` for ${oldCourt || params.court}${whenStr}` : '';
    return `⚠️ Reservation ID not found${courtStr}. Please check upcoming bookings with \`!mybookings\` or provide the reservation ID (e.g. \`!modifycourt 194617 Court 1\`).`;
  }

  const res = await scvcc.modifyCourtBooking({
    ...params,
    reservationId: resId,
    court: params.court || oldCourt,
    requestedBy: sender,
    chatId: targetChatId
  });

  if (res && res.success) {
    if (context) {
      updatePollStateForModifiedBooking(context, {
        reservationId: resId,
        oldCourt: oldCourt || res.oldCourt,
        newCourt: res.court,
        newTime: res.time,
        newDate: res.date,
        newPlayers: res.players,
        newDuration: res.duration,
        newPartySize: res.partySize,
        chatId: targetChatId
      });
    }
    if (res.message && typeof notifyFn === 'function') {
      await notifyFn(sock, targetChatId, res.message, [senderJid, chatId]);
    }
  }
  return res?.message || 'Could not update court reservation.';
}

async function handleCancelCourt({ sock, reservationId, chatId, context = {}, notifyFn }) {
  const res = await scvcc.cancelCourtReservation(reservationId, chatId);
  if (res && res.success) {
    if (context) {
      removePollStateForCancelledBooking(context, { reservationId, chatId });
    }
    if (res.message && typeof notifyFn === 'function') {
      await notifyFn(sock, chatId, res.message);
    }
  }
  return res?.message || 'Could not cancel reservation.';
}

async function handleGetMyBookings(chatId) {
  const res = await scvcc.getMyReservations(chatId);
  return res?.message || 'Could not retrieve member reservations.';
}

async function handlePauseResumeBookings({
  sock,
  action, // 'pause' | 'resume'
  target = '',
  isAll = false,
  chatId,
  senderJid,
  isTool = false
}) {
  const isPause = action === 'pause';
  const verbPast = isPause ? 'paused' : 'resumed';
  const stateDesc = isPause ? 'suspended' : 'active';
  const emoji = isPause ? '⏸️' : '▶️';
  const toggleFn = isPause ? groupsConfig.pauseCourtBookings : groupsConfig.resumeCourtBookings;
  const isSuper = groupsConfig.isSuperAdmin(senderJid);

  if (isAll) {
    if (!isSuper) {
      return `⚠️ Only the bot superadmin can ${action} court bookings for all groups.`;
    }
    const res = toggleFn('all');
    if (isTool) {
      return `${emoji} Court bookings ${verbPast} for all groups (${res.affected.length} groups).`;
    }
    const list = res.affected.length > 0
      ? res.affected.map((g) => `• *${g.name}* (\`${g.jid}\`)`).join('\n')
      : '• _No configured groups found in groups.json_';
    return `${emoji} *Court bookings ${verbPast} for all groups* (${res.affected.length}):\n${list}\n\nAutomatic court pre-bookings and direct court bookings are now ${stateDesc}.`;
  }

  let targetGroup = (target || '').trim();
  if (!targetGroup) {
    if (chatId && chatId.endsWith('@g.us')) {
      targetGroup = chatId;
    } else if (isTool) {
      targetGroup = 'all';
    } else {
      if (isSuper) {
        return `Usage: \`!${action}courtbookings <groupName/JID | all>\`\nExample: \`!${action}courtbookings Bot-testing\`\nExample: \`!${action}courtbookings all\``;
      }
      return `⚠️ Only group admins or the bot superadmin can ${action} court bookings.`;
    }
  }

  if (targetGroup.toLowerCase() === 'all') {
    return handlePauseResumeBookings({ sock, action, isAll: true, chatId, senderJid, isTool });
  }

  const groupJid = groupsConfig.getGroupJid(targetGroup) || (targetGroup.endsWith('@g.us') ? targetGroup : null);
  const targetCheckJid = groupJid || targetGroup;

  if (!isSuper) {
    const isAdmin = await isUserAdmin(sock, targetCheckJid, senderJid);
    if (!isAdmin) {
      return `⚠️ Only group admins or the bot superadmin can ${action} court bookings for this group.`;
    }
  }

  const res = toggleFn(targetGroup);
  if (!res) {
    return `⚠️ Group "${targetGroup}" was not found in groups.json.`;
  }
  if (isTool) {
    return `${emoji} Court bookings ${verbPast} for "${res.name}" (${res.jid}).`;
  }
  return `${emoji} *Court bookings ${verbPast} for "${res.name}"* (\`${res.jid}\`).\nAutomatic court pre-bookings and direct court bookings are now ${stateDesc} for this group.`;
}

async function handleWebcamCommand({ sock, chatId, wantVideo = false, isTool = false }) {
  if (!groupsConfig.isCourtBookingEnabled(chatId)) {
    return isTool
      ? 'Court webcam functionality is not enabled for this group.'
      : '⚠️ Court webcam and booking functionality is not enabled for this group.';
  }

  if (wantVideo) {
    const clip = await scvcc.getCourtWebcamClip(10, chatId);
    if (clip.success && clip.videoBuffer) {
      const payload = {
        video: clip.videoBuffer,
        caption: '📹 *SCVCC Tennis Court Webcam (10s clip)*',
        mimetype: 'video/mp4'
      };
      if (!isTool) return payload;
      if (sock) {
        try {
          await sendMessageAndRecord(sock, chatId, payload);
          return 'Live 10-second court webcam video clip has been sent to the chat.';
        } catch (err) {
          console.error('[webcam] Failed to send video clip via tool:', err.message);
          return 'Failed to send court video clip to WhatsApp.';
        }
      }
    } else if (isTool && !clip.success) {
      return `Failed to capture court video clip: ${clip.error || 'stream unavailable'}`;
    }
  }

  const snapshot = await scvcc.getCourtWebcamSnapshot(chatId);
  if (snapshot.success && snapshot.imageBuffer) {
    const payload = {
      image: snapshot.imageBuffer,
      caption: '📹 *SCVCC Tennis Court Webcam*'
    };
    if (!isTool) return payload;
    if (sock) {
      try {
        await sendMessageAndRecord(sock, chatId, payload);
        return 'Live court webcam photo snapshot has been sent to the chat.';
      } catch (err) {
        console.error('[webcam] Failed to send snapshot via tool:', err.message);
        return 'Failed to send court snapshot to WhatsApp.';
      }
    }
  } else if (isTool && !snapshot.success) {
    return `Failed to capture court snapshot: ${snapshot.error || 'camera unavailable'}`;
  }

  if (isTool) {
    return 'Live court webcam feed is currently unavailable.';
  }
  if (wantVideo) {
    return '📹 *SCVCC Tennis Court Webcam*\n⚠️ _(Unable to capture court video clip or snapshot right now.)_';
  }
  return '📹 *SCVCC Tennis Court Webcam*\n⚠️ _(Unable to capture court snapshot right now.)_';
}

/**
 * Handles SCVCC court status and booking commands:
 * !courtbookings, !courts, !bookcourt, !modifycourt, !cancelcourt, !mybookings,
 * !webcam, !pausecourtbookings, !resumecourtbookings
 */
async function handleCourtCommand(sock, rawText, chatId, sender, senderJid = null, msg = null, context = {}) {
  const text = normalizeCommandDashes(rawText);
  const lower = text.toLowerCase();

  // !courtbookings, !courtbooking, !bookings, !booking, !courtreservations, !reservations, !courtschedule
  if (
    /^!(?:courtbookings?|bookings?|courtreservations?|reservations?|courtsschedule|courtschedule)\b/i.test(text)
  ) {
    const parsed = scvcc.parseBookingsCommand(text);
    return await handleGetCourtBookings(parsed, chatId);
  }

  // !courts, !courtstatus, !courtavailability
  if (
    /^!(?:courts?|courtstatus|courtavailability|courtavail)\b/i.test(text)
  ) {
    const parsed = scvcc.parseCourtsCommand(text);
    return await handleCheckCourtAvailability(parsed, chatId);
  }

  // !bookcourt, !reservecourt, !book, !reserve
  if (/^!(?:bookcourt|reservecourt|book\s*court|reserve\s*court|book|reserve)\b/i.test(text)) {
    const rawCmdBody = text.replace(/^!(?:bookcourt|reservecourt|book\s*court|reserve\s*court|book|reserve)\b\s*/i, '').trim();
    const { groupQuery, remainingText } = extractGroupFlag(rawCmdBody);

    if (!remainingText) {
      return '⚠️ Please provide booking details (date/time, e.g. `!bookcourt Court 2 9am tomorrow`) or a poll ID (e.g. `!bookcourt <pollId>`, `!bookcourt <pollId> all`, `!bookcourt <pollId> 2`, or `!bookcourt <pollId> Court 3`).';
    }

    const { parseBookPollCourtsArgs, handleBookPollCourts } = require('./poll/courts');
    const pollArgs = parseBookPollCourtsArgs(remainingText, context);
    if (pollArgs) {
      let effectiveChatId = chatId;
      let groupQueryChatId = null;
      if (groupQuery) {
        const { targetChatId, error: groupError } = await resolveTargetChat(sock, chatId, senderJid, groupQuery, context, {
          requireAdmin: false,
          actionDesc: 'book courts for this group'
        });
        if (groupError) return groupError;
        effectiveChatId = targetChatId;
        groupQueryChatId = targetChatId;
      }
      return await handleBookPollCourts(sock, effectiveChatId, sender, senderJid, remainingText, context, groupQueryChatId, chatId, pollArgs);
    }

    let bookingChatId = chatId;
    if (groupQuery) {
      const { targetChatId, error: groupError } = await resolveTargetChatId(sock, chatId, senderJid, groupQuery, context);
      if (groupError) return groupError;
      bookingChatId = targetChatId;
    }

    const parsed = scvcc.parseBookCourtCommand(groupQuery ? `!bookcourt ${remainingText}` : text);
    if (!parsed) {
      return '⚠️ Please provide booking details (date/time, e.g. `!bookcourt Court 2 9am tomorrow`) or a poll ID (e.g. `!bookcourt <pollId>`, `!bookcourt <pollId> all`, `!bookcourt <pollId> 2`, or `!bookcourt <pollId> Court 3`).';
    }
    return await handleBookCourt({
      sock,
      params: parsed,
      sender,
      senderJid,
      chatId: bookingChatId,
      context,
      excludeJids: [senderJid, chatId],
      notifyFn: notify
    });
  }

  // !modifycourt, !modifycourtbooking, !modifybooking, !modifyreservation, !updatecourt, !updatebooking, !updatereservation
  if (
    lower.startsWith('!modifycourt') || lower.startsWith('!modifycourtbooking') ||
    lower.startsWith('!modifybooking') || lower.startsWith('!modifyreservation') ||
    lower.startsWith('!updatecourt') || lower.startsWith('!updatecourtbooking') ||
    lower.startsWith('!updatebooking') || lower.startsWith('!updatereservation')
  ) {
    const parsed = scvcc.parseModifyCourtCommand(text);
    if (!parsed) {
      return '⚠️ Please provide reservation ID and updates, e.g. `!modifycourt 194617 Court 1` or `!modifycourt Court 2 to Court 1`.';
    }
    return await handleModifyCourt({ sock, params: parsed, chatId, sender, senderJid, context, notifyFn: notify });
  }

  // !cancelcourt, !cancelreservation
  const cancelCourtMatch = text.match(/(?:!(?:cancelcourt|cancelreservation)|\b(?:cancel|delete)\s+(?:court\s+)?(?:reservation|booking)\b)\s+([A-Za-z0-9_]+)/i);
  if (cancelCourtMatch) {
    return await handleCancelCourt({
      sock,
      reservationId: cancelCourtMatch[1],
      chatId,
      context,
      notifyFn: notify
    });
  }

  // !mybookings, !myreservations, !mycourts
  if (lower === '!mybookings' || lower === '!myreservations' || lower === '!mycourts') {
    return await handleGetMyBookings(chatId);
  }

  // !webcam, !camera, !courtcam, !cam, !courtwebcam, !courtswebcam
  if (/^!(?:webcam|camera|courtcam|cam|courts?webcam)\b/i.test(text)) {
    const isVideoRequested = /\b(?:video|clip|recording|mp4)\b/i.test(lower);
    return await handleWebcamCommand({ sock, chatId, wantVideo: isVideoRequested, isTool: false });
  }

  // !pausecourtbookings, !pausecourtbooking, !pausecourts, !pausecourt, !pauseallcourtbookings
  const pauseMatch = text.match(/^!(?:pause(?:all)?courtbookings?|pausecourts?|pause\s+court\s*bookings?|pause\s+courts?)\b(?:\s+(.*))?$/i);
  if (pauseMatch) {
    const isAllCmd = /^!(?:pauseallcourtbookings?|pause\s+all\s+court\s*bookings?)\b/i.test(text);
    const rawArg = (pauseMatch[1] || '').trim();
    return await handlePauseResumeBookings({
      sock,
      action: 'pause',
      target: rawArg,
      isAll: isAllCmd || rawArg.toLowerCase() === 'all',
      chatId,
      senderJid,
      isTool: false
    });
  }

  // !resumecourtbookings, !resumecourtbooking, !resumecourts, !resumecourt, !resumeallcourtbookings
  const resumeMatch = text.match(/^!(?:resume(?:all)?courtbookings?|resumecourts?|resume\s+court\s*bookings?|resume\s+courts?)\b(?:\s+(.*))?$/i);
  if (resumeMatch) {
    const isAllCmd = /^!(?:resumeallcourtbookings?|resume\s+all\s+court\s*bookings?)\b/i.test(text);
    const rawArg = (resumeMatch[1] || '').trim();
    return await handlePauseResumeBookings({
      sock,
      action: 'resume',
      target: rawArg,
      isAll: isAllCmd || rawArg.toLowerCase() === 'all',
      chatId,
      senderJid,
      isTool: false
    });
  }

  return null;
}

/**
 * Handles LLM tool calls for court bookings and availability:
 * get_court_bookings, check_court_availability, book_court, modify_court_reservation,
 * cancel_court_reservation, get_my_court_bookings, get_court_webcam,
 * pause_court_bookings, resume_court_bookings
 */
async function executeCourtTool(sock, name, input, sender, chatId, senderJid = null, context = {}) {
  if (name === 'get_court_bookings' || name === 'get_court_reservations') {
    return await handleGetCourtBookings(input, chatId);
  }
  if (name === 'check_court_availability') {
    return await handleCheckCourtAvailability(input, chatId);
  }
  if (name === 'book_court') {
    return await handleBookCourt({
      sock,
      params: input,
      sender,
      senderJid,
      chatId,
      context,
      excludeJids: [],
      notifyFn: notify
    });
  }
  if (
    name === 'modify_court_reservation' ||
    name === 'modify_court_booking' ||
    name === 'modify_court' ||
    name === 'update_court_booking' ||
    name === 'update_court_reservation'
  ) {
    return await handleModifyCourt({ sock, params: input, chatId, sender, senderJid, context, notifyFn: notify });
  }
  if (name === 'cancel_court' || name === 'cancel_court_reservation' || name === 'cancel_court_booking') {
    const resId = input.reservationId || input.resId || input.id;
    return await handleCancelCourt({
      sock,
      reservationId: resId,
      chatId,
      context,
      notifyFn: notify
    });
  }
  if (name === 'get_my_court_bookings') {
    return await handleGetMyBookings(chatId);
  }
  if (name === 'get_court_webcam' || name === 'get_court_camera' || name === 'court_webcam') {
    const wantVideo = input?.format === 'video' || input?.format === 'clip';
    return await handleWebcamCommand({ sock, chatId, wantVideo, isTool: true });
  }
  if (name === 'pause_court_bookings' || name === 'pause_court_booking') {
    return await handlePauseResumeBookings({
      sock,
      action: 'pause',
      target: input?.group || input?.target || '',
      isAll: Boolean(input?.all),
      chatId,
      senderJid,
      isTool: true
    });
  }
  if (name === 'resume_court_bookings' || name === 'resume_court_booking') {
    return await handlePauseResumeBookings({
      sock,
      action: 'resume',
      target: input?.group || input?.target || '',
      isAll: Boolean(input?.all),
      chatId,
      senderJid,
      isTool: true
    });
  }
  return `Unknown court tool ${name}`;
}

module.exports = {
  sendBookingNotifications,
  handleCourtCommand,
  executeCourtTool,
  updatePollStateForModifiedBooking,
  removePollStateForCancelledBooking,
  findAdvanceBookingInPolls,
  findAllAdvanceBookingsInPolls,
  resolveTargetChatId,
  formatCourtBookingTitleLine
};
