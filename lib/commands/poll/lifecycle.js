/**
 * Poll Lifecycle: Stop/Resume, Cancellation, Cleanup & Deletion
 */

const recurringPollsModule = require('../../recurringPolls');
const pollTime = require('../../pollTime');
const { isUserAdmin, isSameUser } = require('../groupCommands');

const {
  POLL_EXPIRY_GRACE_DAYS,
  deletePollFromWhatsApp
} = require('./roster');
const { releaseAllCourtsForPollState } = require('./courts');

function handlePollDeleted(remoteJid, pollId, context) {
  if (!pollId || !context) return;
  const { activePolls, messageStore, latestPollIdByChat, persistPolls } = context;
  let changed = false;

  let chatId = remoteJid;
  if (activePolls.has(pollId)) {
    const pollState = activePolls.get(pollId);
    if (!chatId) chatId = pollState.remoteJid;
    const pollName = pollState.name || 'Match Poll';
    console.log(`[poll] Tracked poll ${pollId} ("${pollName}") was deleted in WhatsApp chat ${chatId}. Removing from active polls.`);
    activePolls.delete(pollId);
    changed = true;
  }

  if (messageStore) {
    for (const key of messageStore.keys()) {
      if (key.endsWith(`:${pollId}`)) {
        messageStore.delete(key);
        changed = true;
      }
    }
  }

  if (chatId && latestPollIdByChat && latestPollIdByChat.get(chatId) === pollId) {
    latestPollIdByChat.delete(chatId);
    for (const [id, state] of [...activePolls.entries()].reverse()) {
      if (state.remoteJid === chatId && (state.status === 'active' || state.status === 'filled')) {
        latestPollIdByChat.set(chatId, id);
        break;
      }
    }
    changed = true;
  } else if (latestPollIdByChat) {
    for (const [cId, id] of latestPollIdByChat.entries()) {
      if (id === pollId) {
        latestPollIdByChat.delete(cId);
        for (const [otherId, state] of [...activePolls.entries()].reverse()) {
          if (state.remoteJid === cId && (state.status === 'active' || state.status === 'filled')) {
            latestPollIdByChat.set(cId, otherId);
            break;
          }
        }
        changed = true;
      }
    }
  }

  if (changed) {
    persistPolls();
  }
}

async function cancelOrDeletePoll(sock, remoteJid, pollId, context, options = {}) {
  if (!pollId) return { releasedCourts: [] };
  const pollState = context?.activePolls?.get(pollId);
  const siblingIds = (pollState && Array.isArray(pollState.siblingPollIds)) ? [...pollState.siblingPollIds] : [];

  let releasedCourts = [];
  if (options.releaseCourts !== false && pollState) {
    const released = await releaseAllCourtsForPollState(sock, pollState, remoteJid, context);
    if (released && released.length > 0) {
      releasedCourts.push(...released);
    }
  }

  handlePollDeleted(remoteJid, pollId, context);
  await deletePollFromWhatsApp(sock, remoteJid, pollId);

  if (siblingIds.length > 0) {
    for (const sibId of siblingIds) {
      if (sibId !== pollId && context?.activePolls?.has(sibId)) {
        const sibState = context.activePolls.get(sibId);
        if (options.releaseCourts !== false && sibState) {
          const sibReleased = await releaseAllCourtsForPollState(sock, sibState, remoteJid, context);
          if (sibReleased && sibReleased.length > 0) {
            releasedCourts.push(...sibReleased);
          }
        }
        handlePollDeleted(remoteJid, sibId, context);
        await deletePollFromWhatsApp(sock, remoteJid, sibId);
      }
    }
  }

  releasedCourts = [...new Set(releasedCourts)];
  return { releasedCourts };
}

async function handleDeleteAllPolls(sock, chatId, senderJid, context) {
  const { activePolls, latestPollIdByChat, persistPolls } = context;
  const isAdmin = await isUserAdmin(sock, chatId, senderJid);
  if (!isAdmin) {
    return '⚠️ Only group admins can delete all polls.';
  }

  const allPollEntries = [...activePolls.entries()];
  if (allPollEntries.length === 0) {
    return 'No polls on record to delete.';
  }

  let deletedCount = 0;
  let allReleasedCourts = [];
  for (const [pollId, pollState] of allPollEntries) {
    const targetChat = pollState.remoteJid || chatId;
    try {
      const res = await cancelOrDeletePoll(sock, targetChat, pollId, context);
      if (res?.releasedCourts?.length) {
        allReleasedCourts.push(...res.releasedCourts);
      }
      deletedCount++;
    } catch (err) {
      console.error(`[poll] Failed to cancel/delete poll ${pollId}:`, err.message);
    }
  }

  activePolls.clear();
  latestPollIdByChat.clear();
  persistPolls();

  console.log(`[poll] Admin deleted all ${deletedCount} poll(s) from storage and WhatsApp.`);
  let reply = `🗑️ Deleted ${deletedCount} poll(s) from storage and WhatsApp.`;
  if (allReleasedCourts.length > 0) {
    reply += `\n🎾 Released court reservation(s): ${[...new Set(allReleasedCourts)].join(", ")}.`;
  }
  return reply;
}

async function handleClearAllPolls(sock, chatId, senderJid, context) {
  const { activePolls, latestPollIdByChat, persistPolls } = context;
  const isAdmin = await isUserAdmin(sock, chatId, senderJid);
  if (!isAdmin) {
    return '⚠️ Only group admins can clear all polls.';
  }

  const count = activePolls.size;
  if (count === 0) {
    return 'No polls on record to clear.';
  }

  activePolls.clear();
  latestPollIdByChat.clear();
  persistPolls();

  console.log(`[poll] Admin cleared all ${count} poll(s) from state (kept on WhatsApp).`);
  return `🧹 Cleared ${count} poll(s) from bot state (polls remain on WhatsApp).`;
}

function cleanupExpiredPolls(context, nowMs = Date.now()) {
  const { activePolls, messageStore, latestPollIdByChat, persistPolls } = context;
  const now = nowMs;
  const graceMs = POLL_EXPIRY_GRACE_DAYS * 24 * 60 * 60 * 1000;
  const removed = [];
  let statusChanged = false;

  for (const [pollId, pollState] of activePolls.entries()) {
    if (pollState.type === "multi_time" && Array.isArray(pollState.timeSlots)) {
      for (const s of pollState.timeSlots) {
        if (s.playAt) {
          const spMs = new Date(s.playAt).getTime();
          if (!Number.isNaN(spMs) && now >= spMs && (s.status === "active" || s.status === "filled" || s.status === "stopped")) {
            s.status = "expired";
            statusChanged = true;
          }
        }
      }
    }
    const effectivePlayAtStr = pollState.latestPlayAt || pollState.playAt;
    const hasPlayAt = Boolean(effectivePlayAtStr && effectivePlayAtStr !== 'unknown');
    const playAtMs = hasPlayAt ? new Date(effectivePlayAtStr).getTime() : NaN;
    const isValidPlayAt = !Number.isNaN(playAtMs);

    if (isValidPlayAt) {
      if (now >= playAtMs && (pollState.status === 'active' || pollState.status === 'filled' || pollState.status === 'stopped')) {
        pollState.status = 'expired';
        statusChanged = true;
        console.log(`[poll] Match play time passed for poll ${pollId} ("${pollState.name || pollState.when}"): status automatically set to expired.`);
      }

      if (now > playAtMs + graceMs) {
        console.log(`[poll] Deleting old poll ${pollId} ("${pollState.name || pollState.when}"): playAt=${pollState.playAt}, now=${new Date(now).toISOString()} (exceeded 2-week retention)`);
        if (context?.recurringPolls && (pollState.scheduleId || pollState.recurringScheduleId)) {
          const schedId = pollState.scheduleId || pollState.recurringScheduleId;
          const sched = context.recurringPolls.get(schedId);
          const dateKey = pollState.targetDateKey || (pollState.playAt ? pollTime.getSanJoseDateKey(new Date(pollState.playAt)) : null);
          if (sched?.instanceSlotOverrides && dateKey && sched.instanceSlotOverrides[dateKey] !== undefined) {
            delete sched.instanceSlotOverrides[dateKey];
            if (Object.keys(sched.instanceSlotOverrides).length === 0) {
              delete sched.instanceSlotOverrides;
            }
            statusChanged = true;
            console.log(`[recurring-poll] Pruned instance slot override for ${dateKey} on schedule ${schedId} as poll ${pollId} exceeded 2-week retention.`);
          }
          if (sched?.instanceCourtSkips && dateKey && sched.instanceCourtSkips[dateKey] !== undefined) {
            delete sched.instanceCourtSkips[dateKey];
            if (Object.keys(sched.instanceCourtSkips).length === 0) {
              delete sched.instanceCourtSkips;
            }
            statusChanged = true;
            console.log(`[recurring-poll] Pruned instance court skips for ${dateKey} on schedule ${schedId} as poll ${pollId} exceeded 2-week retention.`);
          }
        }
        activePolls.delete(pollId);
        if (messageStore) {
          for (const key of messageStore.keys()) {
            if (key.endsWith(`:${pollId}`)) {
              messageStore.delete(key);
            }
          }
        }
        if (latestPollIdByChat) {
          for (const [chatId, latestId] of latestPollIdByChat.entries()) {
            if (latestId === pollId) latestPollIdByChat.delete(chatId);
          }
        }
        removed.push(pollId);
      }
    } else {
      // If playAt time is null or unspecified, use the created date for the 2-week check
      const createdDateVal = pollState.createdDate || pollState.createdAt || pollState.created;
      if (createdDateVal) {
        const createdMs = new Date(createdDateVal).getTime();
        if (!Number.isNaN(createdMs) && now > createdMs + graceMs) {
          console.log(`[poll] Deleting old untimed poll ${pollId} ("${pollState.name || pollState.when}"): playAt is null, createdDate=${createdDateVal}, now=${new Date(now).toISOString()} (exceeded 2-week retention)`);
          if (context?.recurringPolls && (pollState.scheduleId || pollState.recurringScheduleId)) {
            const schedId = pollState.scheduleId || pollState.recurringScheduleId;
            const sched = context.recurringPolls.get(schedId);
            const dateKey = pollState.targetDateKey || (createdDateVal ? pollTime.getSanJoseDateKey(new Date(createdDateVal)) : null);
            if (sched?.instanceSlotOverrides && dateKey && sched.instanceSlotOverrides[dateKey] !== undefined) {
              delete sched.instanceSlotOverrides[dateKey];
              if (Object.keys(sched.instanceSlotOverrides).length === 0) {
                delete sched.instanceSlotOverrides;
              }
              statusChanged = true;
            }
            if (sched?.instanceCourtSkips && dateKey && sched.instanceCourtSkips[dateKey] !== undefined) {
              delete sched.instanceCourtSkips[dateKey];
              if (Object.keys(sched.instanceCourtSkips).length === 0) {
                delete sched.instanceCourtSkips;
              }
              statusChanged = true;
            }
            if (sched?.instanceCourtSkips && sched.instanceCourtSkips[dateKey] !== undefined) {
              delete sched.instanceCourtSkips[dateKey];
              if (Object.keys(sched.instanceCourtSkips).length === 0) {
                delete sched.instanceCourtSkips;
              }
              statusChanged = true;
              console.log(`[recurring-poll] Pruned instance court skips for ${dateKey} on schedule ${schedId} as poll ${pollId} exceeded 2-week retention.`);
            }
          }
          activePolls.delete(pollId);
          if (messageStore) {
            for (const key of messageStore.keys()) {
              if (key.endsWith(`:${pollId}`)) {
                messageStore.delete(key);
              }
            }
          }
          if (latestPollIdByChat) {
            for (const [chatId, latestId] of latestPollIdByChat.entries()) {
              if (latestId === pollId) latestPollIdByChat.delete(chatId);
            }
          }
          removed.push(pollId);
        }
      }
    }
  }

  // Also prune extra/orphaned non-poll messages in messageStore older than 14 days
  if (messageStore) {
    const msgCutoff = now - 14 * 24 * 60 * 60 * 1000;
    for (const [key, msg] of messageStore.entries()) {
      const isPollMsg = [...activePolls.keys()].some((pId) => key.endsWith(`:${pId}`));
      if (!isPollMsg) {
        let ts = msg?.messageTimestamp ?? msg?.timestamp;
        if (typeof ts === 'object' && ts !== null && typeof ts.low === 'number') ts = ts.low;
        const n = Number(ts);
        const tsMs = (Number.isFinite(n) && n > 0) ? (n < 1e11 ? n * 1000 : n) : null;
        if (tsMs && tsMs < msgCutoff) {
          messageStore.delete(key);
          statusChanged = true;
        }
      }
    }
  }

  if (context?.recurringPolls && typeof recurringPollsModule?.pruneExpiredAdvanceBookings === 'function') {
    recurringPollsModule.pruneExpiredAdvanceBookings(context.recurringPolls, now, persistPolls);
  }

  if (removed.length > 0 || statusChanged) {
    if (persistPolls) persistPolls();
    if (removed.length > 0) {
      console.log(`[poll] Cleaned up ${removed.length} expired/completed poll(s) older than 2 weeks: ${removed.join(', ')}`);
    }
  }
  return removed;
}

async function handleStopPoll(sock, chatId, sender, senderJid, specificPollId = null, context) {
  const { activePolls, latestPollIdByChat, persistPolls } = context;
  let targetPollId = specificPollId || null;
  if (!targetPollId) {
    for (const [pollId, pollState] of [...activePolls.entries()].reverse()) {
      if (pollState.remoteJid === chatId && (pollState.status === 'active' || pollState.status === 'filled')) {
        targetPollId = pollId;
        break;
      }
    }
  }
  if (!targetPollId) {
    targetPollId = latestPollIdByChat.get(chatId);
  }
  if (!targetPollId || !activePolls.has(targetPollId)) {
    return 'No active poll to stop.';
  }

  const targetPollState = activePolls.get(targetPollId);
  if (targetPollState.status === 'stopped') {
    return `Poll "${targetPollState.name || targetPollState.when || targetPollId}" is already stopped.`;
  }
  if (targetPollState.status === 'cancelled') {
    return 'This poll was cancelled.';
  }

  const creatorObj = targetPollState.creator || targetPollState.createdBy;
  const isCreator = creatorObj ? isSameUser(creatorObj.jid, senderJid, creatorObj.name, sender) : false;
  const isAdmin = await isUserAdmin(sock, chatId, senderJid);

  if (!isCreator && !isAdmin) {
    return '⚠️ Only the poll creator or group admins can stop voting on this poll.';
  }

  targetPollState.status = 'stopped';
  persistPolls();

  const pollName = targetPollState.name || targetPollState.when || 'Match Poll';
  console.log(`[poll] Poll ${targetPollId} ("${pollName}") in ${chatId} status set to stopped by ${sender}`);
  return `🛑 Voting has been stopped for "${pollName}". Reminders are closed and status is set to stopped. You can generate matchups anytime with "!matchups".`;
}

async function handleResumePoll(sock, chatId, sender, senderJid, specificPollId = null, context) {
  const { activePolls, latestPollIdByChat, persistPolls } = context;
  let targetPollId = specificPollId || null;
  if (!targetPollId) {
    for (const [pollId, pollState] of [...activePolls.entries()].reverse()) {
      if (pollState.remoteJid === chatId && pollState.status === 'stopped') {
        targetPollId = pollId;
        break;
      }
    }
  }
  if (!targetPollId) {
    targetPollId = latestPollIdByChat.get(chatId);
  }
  if (!targetPollId || !activePolls.has(targetPollId)) {
    return 'No stopped poll to resume.';
  }

  const targetPollState = activePolls.get(targetPollId);
  if (targetPollState.status === 'active' || targetPollState.status === 'filled') {
    return `Poll "${targetPollState.name || targetPollState.when || targetPollId}" is already active.`;
  }
  if (targetPollState.status === 'resolved') {
    return `Poll "${targetPollState.name || targetPollState.when || targetPollId}" has already been resolved/drawn.`;
  }
  if (targetPollState.status === 'cancelled') {
    return 'This poll was cancelled and cannot be resumed.';
  }
  if (targetPollState.status === 'expired') {
    return `Poll "${targetPollState.name || targetPollState.when || targetPollId}" has expired (scheduled match play time has passed).`;
  }

  const creatorObj = targetPollState.creator || targetPollState.createdBy;
    const isCreator = creatorObj ? isSameUser(creatorObj.jid, senderJid, creatorObj.name, sender) : false;
  const isAdmin = await isUserAdmin(sock, chatId, senderJid);

  if (!isCreator && !isAdmin) {
    return '⚠️ Only the poll creator or group admins can resume voting on this poll.';
  }

  let newStatus = 'active';
  const isOptIn = targetPollState.type === 'opt_in' || targetPollState.options?.some((o) => /^yes$/i.test(o));

  if (!isOptIn) {
    if (targetPollState.isManual) {
      const totalOptionsCount = targetPollState.options ? targetPollState.options.length : 0;
      const filledCount = targetPollState.voteBuffer ? targetPollState.voteBuffer.size : 0;
      if (totalOptionsCount > 0 && filledCount >= totalOptionsCount) {
        newStatus = 'filled';
      }
    } else {
      const totalSpots = targetPollState.size || (targetPollState.options ? targetPollState.options.length : 4);
      const neededVotes = targetPollState.creator ? totalSpots - 1 : totalSpots;
      const filledVotes = targetPollState.voteBuffer ? targetPollState.voteBuffer.size : 0;
      if (neededVotes > 0 && filledVotes >= neededVotes) {
        newStatus = 'filled';
      }
    }
  }

  targetPollState.status = newStatus;
  latestPollIdByChat.set(chatId, targetPollId);
  persistPolls();

  const pollName = targetPollState.name || targetPollState.when || 'Match Poll';
  const reminderNote = newStatus === 'filled' ? 'all spots are currently filled (waiting for matchup request)' : 'reminders are active';
  console.log(`[poll] Poll ${targetPollId} ("${pollName}") in ${chatId} status resumed to ${newStatus} by ${sender}`);
  return `▶️ Voting has been resumed for "${pollName}". Status is now ${newStatus} and ${reminderNote}.`;
}

function findTargetPollToCancel(activePolls, targetChatId, senderJid, sender) {
  if (!activePolls || !targetChatId) return null;
  const chatPolls = [...activePolls.entries()]
    .filter(([_, pollState]) => pollState.remoteJid === targetChatId && (pollState.status === "active" || !pollState.status))
    .reverse();

  if (chatPolls.length === 0) return null;

  // 1. Look at active polls created by the user and pick the most recent one
  for (const [pollId, pollState] of chatPolls) {
    const creatorObj = pollState.creator || (!pollState.isAuto && !pollState.isRecurring && pollState.createdBy);
    if (creatorObj && isSameUser(creatorObj.jid, senderJid, creatorObj.name, sender)) {
      return pollId;
    }
  }

  // 2. If one is not available then look for the most recent active poll with no creator (such as a recurring poll instance)
  for (const [pollId, pollState] of chatPolls) {
    const hasNoCreator = !pollState.creator || pollState.isAuto || pollState.isRecurring || pollState.isAutoCreated;
    if (hasNoCreator) {
      return pollId;
    }
  }

  // 3. Fallback to the most recent active poll in the chat
  return chatPolls[0][0];
}

module.exports = {
  handlePollDeleted,
  cancelOrDeletePoll,
  handleDeleteAllPolls,
  handleClearAllPolls,
  cleanupExpiredPolls,
  handleStopPoll,
  handleResumePoll,
  findTargetPollToCancel
};
