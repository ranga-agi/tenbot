/**
 * Vote Ingestion, Decryption, Buffering & Slot Conflict Detection
 */

const {
  getAggregateVotesInPollMessage,
  decryptPollVote,
  jidNormalizedUser,
  normalizeMessageContent
} = require('@whiskeysockets/baileys');

const ratings = require('../../ratings');
const namesStore = require('../../names');
const { sendMessageAndRecord } = require('../../botMessage');
const pairHistory = require('../../pairHistory');
const playerActivity = require('../../playerActivity');
const {
  generateMatchups,
  formatMatchups,
  summarizeSchedule
} = require('../../matchups');
const { getGroupMetadata } = require('../groupCommands');

const {
  GENERIC_NAMES,
  SIMULATION_PREFIX,
  hasSimulationPrefix,
  formatPollTitle,
  storeKey,
  nameFor,
  isValidPlayerCount,
  resolveFixedPollRoster,
  resolveMultiTimePollRoster,
  normalizeVotePayload,
  shouldAutoGenerateLineupOnFill,
  formatMatchHeaderTime,
  getVoteTimestamp,
  getVoteArrivalIndex,
  getSlotNumberForOption,
  checkAndNotifyInvalidSlotVotes
} = require('./roster');
const {
  getPrebookedCourtsForPoll,
  checkCourtReleasesForPoll,
  handleOnDemandCourtBooking
} = require('./courts');

function getMessageSecret(creationMessage) {
  if (!creationMessage) return null;
  const rawMsg = creationMessage.message || creationMessage;
  const normalized = (typeof normalizeMessageContent === 'function' ? normalizeMessageContent(rawMsg) : null) || rawMsg;
  const secret = normalized?.messageContextInfo?.messageSecret ||
    rawMsg?.messageContextInfo?.messageSecret ||
    creationMessage?.messageContextInfo?.messageSecret ||
    normalized?.pollCreationMessage?.messageContextInfo?.messageSecret ||
    normalized?.pollCreationMessageV2?.messageContextInfo?.messageSecret ||
    normalized?.pollCreationMessageV3?.messageContextInfo?.messageSecret ||
    rawMsg?.pollCreationMessage?.messageContextInfo?.messageSecret ||
    rawMsg?.pollCreationMessageV2?.messageContextInfo?.messageSecret ||
    rawMsg?.pollCreationMessageV3?.messageContextInfo?.messageSecret ||
    creationMessage?.messageSecret;
  if (!secret) return null;
  if (Buffer.isBuffer(secret)) return secret;
  if (secret instanceof Uint8Array) return Buffer.from(secret);
  if (typeof secret === 'string') return Buffer.from(secret, 'base64');
  if (secret.type === 'Buffer' && Array.isArray(secret.data)) return Buffer.from(secret.data);
  return Buffer.from(secret);
}

function safeDecryptPollVote(votePayload, pollMsgId, pollEncKey, pollCreatorCandidates, voterCandidates) {
  const encPayload = Buffer.isBuffer(votePayload.encPayload)
    ? votePayload.encPayload
    : typeof votePayload.encPayload === 'string'
      ? Buffer.from(votePayload.encPayload, 'base64')
      : Buffer.from(votePayload.encPayload);
  const encIv = Buffer.isBuffer(votePayload.encIv)
    ? votePayload.encIv
    : typeof votePayload.encIv === 'string'
      ? Buffer.from(votePayload.encIv, 'base64')
      : Buffer.from(votePayload.encIv);

  let lastError = null;
  const uniqueCreators = [...new Set(pollCreatorCandidates.filter(Boolean))];
  const uniqueVoters = [...new Set(voterCandidates.filter(Boolean))];

  for (const creatorJid of uniqueCreators) {
    for (const voterJid of uniqueVoters) {
      try {
        const decrypted = decryptPollVote(
          { encPayload, encIv },
          {
            pollCreatorJid: creatorJid,
            pollMsgId,
            pollEncKey,
            voterJid
          }
        );
        if (decrypted) {
          return { decrypted, authenticatingVoterJid: voterJid, authenticatingCreatorJid: creatorJid };
        }
      } catch (err) {
        lastError = err;
      }
    }
  }

  throw lastError || new Error('Failed to decrypt poll vote: no matching JID combination authenticated');
}

async function checkAndNotifySlotConflicts(sock, pollId, pollState, aggregated, context) {
  if (!pollState || !aggregated || !Array.isArray(aggregated)) return false;

  const isOptIn = pollState.type === 'opt_in' || pollState.options?.some((o) => /^yes$/i.test(o.trim()));
  if (isOptIn) return false;
  if (pollState.onDemandBookingInProgress) return false;

  const slotCheckEnabled = pollState.slotCheck !== undefined
    ? Boolean(pollState.slotCheck)
    : (!pollState.isManual);
  if (!slotCheckEnabled) return false;

  const isNegativeOption = (name) => /^(no|out|can't play|cannot play)$/i.test(String(name).trim());

  // 1. Check for slot conflicts: multiple voters on the same slot
  const conflicts = aggregated.filter((o) => {
    if (isNegativeOption(o.name)) return false;
    return Array.isArray(o.voters) && o.voters.length > 1;
  });

  // 2. Check for multi-slot voters: same player voted on more than one playing slot
  const voterSlotsMap = new Map(); // canonicalKey -> { voterJid, slots: [] }
  for (const o of aggregated) {
    if (isNegativeOption(o.name)) continue;
    if (!Array.isArray(o.voters)) continue;
    for (const vJid of o.voters) {
      if (!vJid) continue;
      const norm = jidNormalizedUser(vJid);
      const canonicalKey = namesStore.resolveCanonicalId(norm) || norm;
      if (!voterSlotsMap.has(canonicalKey)) {
        voterSlotsMap.set(canonicalKey, { voterJid: vJid, slots: [] });
      }
      const entry = voterSlotsMap.get(canonicalKey);
      if (!entry.slots.includes(o.name.trim())) {
        entry.slots.push(o.name.trim());
      }
    }
  }

  const multiSlotVoters = [...voterSlotsMap.values()].filter((v) => v.slots.length > 1);

  if (conflicts.length === 0 && multiSlotVoters.length === 0) {
    if (pollState.lastConflictSignature !== null) {
      pollState.lastConflictSignature = null;
      if (context.persistPolls) context.persistPolls();
    }
    return false;
  }

  const conflictSig = conflicts
    .map((c) => `${c.name.trim()}:${[...c.voters].sort().join(',')}`)
    .sort()
    .join('|');
  const multiSig = multiSlotVoters
    .map((mv) => {
      const norm = jidNormalizedUser(mv.voterJid);
      const canonicalKey = namesStore.resolveCanonicalId(norm) || norm;
      return `${canonicalKey}:${[...mv.slots].sort().join(',')}`;
    })
    .sort()
    .join('|');
  const signature = `${conflictSig}#${multiSig}`;

  if (pollState.lastConflictSignature === signature) {
    return true;
  }
  pollState.lastConflictSignature = signature;
  if (context.persistPolls) context.persistPolls();

  const openSlotOptions = aggregated.filter((o) => {
    if (isNegativeOption(o.name)) return false;
    return !o.voters || o.voters.length === 0;
  });
  const openSlotNames = openSlotOptions.map((o) => o.name.trim());

  let openSlotsText = '';
  if (openSlotNames.length > 0) {
    openSlotsText = `👉 Available open slot(s): *${openSlotNames.join('*, *')}*`;
  } else {
    openSlotsText = 'ℹ️ All other slots are currently taken.';
  }

  const alertLines = [];
  const allMentions = [];

  for (const conf of conflicts) {
    const slotName = conf.name.trim();

    const sortedVoters = [...conf.voters].sort((a, b) => {
      const tA = getVoteTimestamp(pollState, a);
      const tB = getVoteTimestamp(pollState, b);
      if (tA && tB && tA !== tB) return tA - tB;
      const idxA = getVoteArrivalIndex(pollState, a);
      const idxB = getVoteArrivalIndex(pollState, b);
      return idxA - idxB;
    });

    const firstVoterJid = sortedVoters[0];
    const firstVoterName = nameFor(firstVoterJid);
    const subsequentVoters = sortedVoters.slice(1);

    for (const secondVoterJid of subsequentVoters) {
      const norm = jidNormalizedUser(secondVoterJid);
      const pn = namesStore.getPnByLid(norm) || (norm?.endsWith('@s.whatsapp.net') ? norm : null);
      const lid = namesStore.resolveCanonicalId(norm) || (norm?.endsWith('@lid') ? norm : null);
      const voterName = nameFor(secondVoterJid);

      const phoneDigits = (pn || norm || lid || secondVoterJid).split('@')[0].replace(/\D/g, '');
      const tagStr = phoneDigits ? `@${phoneDigits}` : `@${voterName}`;

      if (pn) allMentions.push(pn);
      if (lid) allMentions.push(lid);
      if (norm) allMentions.push(norm);

      alertLines.push(`⚠️ ${tagStr}, *${slotName}* is already taken by *${firstVoterName}*! Please switch your vote to an open slot.`);
    }
  }

  for (const mv of multiSlotVoters) {
    const norm = jidNormalizedUser(mv.voterJid);
    const pn = namesStore.getPnByLid(norm) || (norm?.endsWith('@s.whatsapp.net') ? norm : null);
    const lid = namesStore.resolveCanonicalId(norm) || (norm?.endsWith('@lid') ? norm : null);
    const voterName = nameFor(mv.voterJid);

    const phoneDigits = (pn || norm || lid || mv.voterJid).split('@')[0].replace(/\D/g, '');
    const tagStr = phoneDigits ? `@${phoneDigits}` : `@${voterName}`;

    if (pn) allMentions.push(pn);
    if (lid) allMentions.push(lid);
    if (norm) allMentions.push(norm);

    alertLines.push(`⚠️ ${tagStr}, you have voted for more than one slot (*${mv.slots.join('*, *')}*)! Please select only one slot.`);
  }

  if (openSlotsText) {
    alertLines.push('');
    alertLines.push(openSlotsText);
  }

  const fullAlertText = alertLines.join('\n');
  const uniqueMentions = [...new Set(allMentions)];

  let pollCreationMessage = context.messageStore ? context.messageStore.get(storeKey(pollState.remoteJid, pollId)) : null;
  if (!pollCreationMessage && context.messageStore) {
    for (const key of context.messageStore.keys()) {
      if (key.endsWith(`:${pollId}`)) {
        pollCreationMessage = context.messageStore.get(key);
        break;
      }
    }
  }

  const fromMe = !pollState.isManual;
  const participant = pollState.creator?.jid;

  const quotedMsg = {
    key: {
      remoteJid: pollState.remoteJid,
      id: pollId,
      fromMe: Boolean(fromMe),
      ...(participant ? { participant } : {})
    },
    ...(pollCreationMessage ? { message: pollCreationMessage } : {})
  };

  if (pollState.status === 'filled' || pollState.status === 'resolved') {
    console.log(`[poll] Poll ${pollId} is already filled (${pollState.status}); logging slot conflict without sending alert to group:\n${fullAlertText}`);
    return true;
  }

  console.log(`[poll] Sending slot conflict alert in ${pollState.remoteJid} for poll ${pollId} (tagging ${uniqueMentions.length} mention(s)): \n${fullAlertText}`);
  try {
    await sendMessageAndRecord(sock, pollState.remoteJid, {
      text: fullAlertText,
      mentions: uniqueMentions
    }, { quoted: quotedMsg });
  } catch (err) {
    console.error(`[poll] Failed to send slot conflict alert for poll ${pollId}:`, err.message);
  }

  return true;
}

const pendingPollVotes = new Map(); // pollId -> Array<{ pollKey, updateEntry }>

async function bufferPendingVote(pollId, pollKey, updateEntry, sock, context = {}) {
  if (!pollId) return;
  if (!pendingPollVotes.has(pollId)) {
    pendingPollVotes.set(pollId, []);
  }
  pendingPollVotes.get(pollId).push({ pollKey, updateEntry });

  const maxWaitMs = 8000;
  const intervalMs = (process.env.NODE_ENV === 'test' || typeof describe === 'function') ? 50 : 250;
  let elapsed = 0;

  while (elapsed < maxWaitMs) {
    await new Promise((r) => setTimeout(r, intervalMs));
    elapsed += intervalMs;
    if (context?.activePolls?.has(pollId)) {
      await flushPendingPollVotes(pollId, sock, context);
      return;
    }
  }

  if (pendingPollVotes.has(pollId)) {
    const count = pendingPollVotes.get(pollId)?.length || 0;
    console.log(`[poll] Discarding ${count} buffered vote(s) for untracked poll ${pollId}: poll was not registered in activePolls within ${maxWaitMs / 1000}s.`);
    pendingPollVotes.delete(pollId);
  }
}

async function flushPendingPollVotes(pollId, sock, context = {}) {
  const pending = pendingPollVotes.get(pollId);
  if (!pending || pending.length === 0) return;
  pendingPollVotes.delete(pollId);
  console.log(`[poll] Flushing ${pending.length} buffered vote(s) for newly registered poll ${pollId}`);
  for (const { pollKey, updateEntry } of pending) {
    try {
      await processPollVoteEvent(sock, pollKey, [updateEntry], context);
    } catch (err) {
      console.error(`[poll] Error processing buffered vote for poll ${pollId}:`, err.message);
    }
  }
}

async function handleMultiTimePollVote(sock, pollId, pollState, pollCreationMessage, merged, mePn, context) {
  const { persistPolls } = context;
  let aggregated;
  try {
    aggregated = getAggregateVotesInPollMessage(
      {
        message: pollCreationMessage,
        pollUpdates: merged
      },
      mePn
    );
  } catch (err) {
    console.error(`[poll] getAggregateVotesInPollMessage failed for multi-time poll ${pollId}:`, err.message);
    return;
  }

  const slotRosters = resolveMultiTimePollRoster(pollState, aggregated);
  const playersPerCourt = pollState.courtBookingType === "singles" ? 2 : 4;

  for (const sr of slotRosters) {
    const { slot, players, excessPlayers, excessVoterEntries, filledCount, slotLimit, isAllFilled } = sr;

    // 1. Excess votes notification for capped time slots
    if (slotLimit && excessPlayers.length > 0) {
      const excessSig = excessPlayers.join("|");
      if (slot.lastExcessSignature !== excessSig) {
        const prevExcess = (slot.lastExcessSignature || "").split("|").filter(Boolean);
        const newExcessEntries = excessVoterEntries.filter((ve) => !prevExcess.includes(ve.playerName));
        slot.lastExcessSignature = excessSig;
        if (persistPolls) persistPolls();

        if (newExcessEntries.length > 0 && sock && pollState.remoteJid) {
          const tags = [];
          const mentions = [];
          for (const ve of newExcessEntries) {
            const norm = jidNormalizedUser(ve.voterJid);
            const pn = namesStore.getPnByLid(norm) || (norm?.endsWith("@s.whatsapp.net") ? norm : null);
            const lid = namesStore.resolveCanonicalId(norm) || (norm?.endsWith("@lid") ? norm : null);
            const digits = (pn || norm || lid || ve.voterJid).split("@")[0].replace(/\D/g, "");
            tags.push(digits ? `@${digits}` : `*${ve.playerName}*`);
            if (pn) mentions.push(pn);
            if (lid) mentions.push(lid);
            if (norm) mentions.push(norm);
          }
          const uniqueMentions = [...new Set(mentions.filter(Boolean))];
          const warnText = `⚠️ ${tags.join(", ")}, the *${slot.label}* time slot is already full (*${slotLimit} spots*)! Your vote for *${slot.label}* is on the waitlist and will not be considered unless a spot opens.`;
          await sock.sendMessage(pollState.remoteJid, {
            text: warnText,
            ...(uniqueMentions.length > 0 ? { mentions: uniqueMentions } : {})
          });
        }
      }
    } else if (slot.lastExcessSignature) {
      slot.lastExcessSignature = null;
      if (persistPolls) persistPolls();
    }

    // 2. On-demand court booking for this time slot if court checking/booking is enabled
    const bookedCount = Array.isArray(slot.prebookedCourts) ? slot.prebookedCourts.length : 0;
    const bookedCap = bookedCount * playersPerCourt;
    const openings = Math.max(0, bookedCap - filledCount);
    const hasUnbooked = Array.isArray(slot.unbookedCourts) && slot.unbookedCourts.length > 0;
    const hasTentative = Array.isArray(slot.tentativeCourts) && slot.tentativeCourts.length > 0;

    if (!slot.onDemandBookingInProgress && (hasUnbooked || hasTentative) && (openings < 3 || filledCount > bookedCap)) {
      slot.onDemandBookingInProgress = true;
      // Create a proxy state scoped to this time slot for handleOnDemandCourtBooking
      const slotProxyState = {
        ...pollState,
        when: `${slot.dayDisplay || ""} ${slot.timeDisplay || slot.timeWord}`.trim(),
        playAt: slot.playAt,
        targetDateMDY: slot.targetDateMDY,
        queryTime: slot.queryTime,
        size: slot.size,
        slotLimit: slot.slotLimit,
        prebookedCourts: slot.prebookedCourts,
        autoBookedCourts: slot.autoBookedCourts,
        advanceBookedCourts: slot.advanceBookedCourts,
        unbookedCourts: slot.unbookedCourts,
        tentativeCourts: slot.tentativeCourts,
        onDemandBookingInProgress: false,
        status: "stopped" // prevent handleOnDemandCourtBooking from resolving whole poll directly
      };
      handleOnDemandCourtBooking(sock, pollId, slotProxyState, aggregated, context).then(() => {
        slot.prebookedCourts = slotProxyState.prebookedCourts;
        slot.autoBookedCourts = slotProxyState.autoBookedCourts;
        slot.advanceBookedCourts = slotProxyState.advanceBookedCourts;
        slot.unbookedCourts = slotProxyState.unbookedCourts;
        slot.tentativeCourts = slotProxyState.tentativeCourts;
        if (slotProxyState.slotLimit && (!slot.slotLimit || slotProxyState.slotLimit < slot.slotLimit)) {
          slot.slotLimit = slotProxyState.slotLimit;
          slot.size = slotProxyState.size;
        }
        slot.onDemandBookingInProgress = false;
        if (persistPolls) persistPolls();
      }).catch(() => {
        slot.onDemandBookingInProgress = false;
      });
    }

    // 3. Auto lineup generation when time slot fills (in "filled" mode)
    if (isAllFilled && isValidPlayerCount(players.length)) {
      const slotForFillCheck = {
        lineupGeneration: pollState.lineupGeneration,
        noMatchups: pollState.noMatchups,
        manualLineupPosted: slot.manualLineupPosted,
        playAt: slot.playAt,
        lineupLeadTime: pollState.lineupLeadTime
      };

      if (!shouldAutoGenerateLineupOnFill(slotForFillCheck)) {
        if (slot.status !== "filled" && slot.status !== "resolved") {
          slot.status = "filled";
          slot.lastPlayers = players;
          if (persistPolls) persistPolls();
        }
      } else if (slot.status !== "resolved") {
        slot.status = "resolved";
        slot.matchupsGenerated = true;
        slot.lastPlayers = players;
        if (persistPolls) persistPolls();

        console.log(`[poll] Multi-time poll ${pollId} slot "${slot.label}" filled -- auto-posting matchups for: ${players.join(", ")}`);
        await ratings.ensureRated(players);
        const slotPrebooked = slot.prebookedCourts || [];
        const schedule = generateMatchups(players, { prebookedCourts: slotPrebooked, chatId: pollState.remoteJid });
        const slotTitlePrefix = pollState.title ? `${pollState.title} — ` : '';
        const slotHeader = `📅 ${slotTitlePrefix}${slot.dayDisplay ? `${slot.dayDisplay} ${slot.timeDisplay}` : slot.label}\n\n`;
        if (sock && pollState.remoteJid) {
          await sendMessageAndRecord(sock, pollState.remoteJid, { text: slotHeader + formatMatchups(schedule) });
        }
        pairHistory.recordDraw(`${pollId}:${slot.label}`, schedule, Date.now(), pollState.remoteJid);
        const playAtMs = slot.playAt ? new Date(slot.playAt).getTime() : Date.now();
        playerActivity.recordPlayed(players, playAtMs, pollState.remoteJid);
        slot.lastSchedule = summarizeSchedule(schedule);
        if (persistPolls) persistPolls();
      }
    } else if (!isAllFilled && slot.status === "filled") {
      slot.status = "active";
      if (persistPolls) persistPolls();
    }
  }

  // Update overall poll status if all capped slots are resolved or filled
  const allCapped = slotRosters.length > 0 && slotRosters.every((sr) => sr.slotLimit !== null);
  if (allCapped) {
    if (slotRosters.every((sr) => sr.slot.status === "resolved")) {
      pollState.status = "resolved";
    } else if (slotRosters.every((sr) => sr.slot.status === "filled" || sr.slot.status === "resolved")) {
      pollState.status = "filled";
    } else if (pollState.status === "filled") {
      pollState.status = "active";
    }
    if (persistPolls) persistPolls();
  }
}

async function processPollVoteEvent(sock, pollMessageKey, rawPollUpdates, context) {
  const { activePolls, messageStore, persistPolls, latestPollIdByChat } = context;
  const pollId = pollMessageKey.id;
  const pollState = activePolls.get(pollId);
  if (!pollState) {
    const known = [...activePolls.keys()];
    console.log(
      `[poll] Got a vote for message ${pollId}, but no active poll is tracked for it. ` +
      `Tracked poll ids: ${known.length ? known.join(', ') : '(none)'}. ` +
      'If the bot restarted after creating the poll, its tracking was lost -- see README.'
    );
    return;
  }

  let pollCreationMessage = messageStore.get(storeKey(pollMessageKey.remoteJid, pollId));
  if (!pollCreationMessage && pollState.remoteJid) {
    pollCreationMessage = messageStore.get(storeKey(pollState.remoteJid, pollId));
  }
  if (!pollCreationMessage && messageStore) {
    for (const [k, v] of messageStore.entries()) {
      if (k.endsWith(`:${pollId}`)) {
        pollCreationMessage = v;
        break;
      }
    }
  }
  if (!pollCreationMessage) {
    console.log(`[poll] No stored creation message found for poll ${pollId} -- can't decode its votes.`);
    return;
  }

  const pollEncKey = getMessageSecret(pollCreationMessage);
  console.log(
    `[poll] Debug -- creation message keys: [${Object.keys(pollCreationMessage).join(', ')}], ` +
    `messageSecret present: ${!!pollEncKey}, is binary: ${Buffer.isBuffer(pollEncKey)}, length: ${pollEncKey?.length ?? 'n/a'}`
  );

  if (pollState.status === 'cancelled' || pollState.status === 'stopped') return;

  if (pollState.remoteJid && pollState.remoteJid.endsWith('@g.us')) {
    await getGroupMetadata(sock, pollState.remoteJid);
  }

  const meLid = jidNormalizedUser(sock.user?.lid || sock.authState?.creds?.me?.lid || '');
  const mePn = jidNormalizedUser(sock.user?.id || sock.authState?.creds?.me?.id || '');

  const creatorJid = pollState.creator?.jid ? jidNormalizedUser(pollState.creator.jid) : null;
  const creationMsgParticipant = pollCreationMessage?.key?.participant ? jidNormalizedUser(pollCreationMessage.key.participant) : null;

  const pollCreatorCandidates = [
    meLid,
    mePn,
    creatorJid,
    creatorJid && namesStore.resolveCanonicalId(creatorJid),
    creatorJid && namesStore.getPnByLid(creatorJid),
    creationMsgParticipant,
    creationMsgParticipant && namesStore.resolveCanonicalId(creationMsgParticipant),
    creationMsgParticipant && namesStore.getPnByLid(creationMsgParticipant),
    pollMessageKey.participant ? jidNormalizedUser(pollMessageKey.participant) : null,
    pollMessageKey.participant && namesStore.resolveCanonicalId(jidNormalizedUser(pollMessageKey.participant)),
    pollMessageKey.participant && namesStore.getPnByLid(jidNormalizedUser(pollMessageKey.participant)),
    pollCreationMessage?.key?.remoteJid ? jidNormalizedUser(pollCreationMessage.key.remoteJid) : null,
    pollMessageKey.remoteJid ? jidNormalizedUser(pollMessageKey.remoteJid) : null
  ];

  for (const u of rawPollUpdates) {
    const rawVoterJid = u.pollUpdateMessageKey?.participant || (u.pollUpdateMessageKey?.fromMe ? mePn : u.pollUpdateMessageKey?.remoteJid);
    const voterNormalized = jidNormalizedUser(rawVoterJid);
    if (!voterNormalized && !u.pollUpdateMessageKey?.fromMe) {
      console.log('[poll] Skipping a vote with no identifiable voter JID:', JSON.stringify(u));
      continue;
    }

    const rawParticipantPn = u.pollUpdateMessageKey?.participantPn ? jidNormalizedUser(u.pollUpdateMessageKey.participantPn) : null;
    if (voterNormalized && rawParticipantPn) {
      if (voterNormalized.endsWith('@lid') && rawParticipantPn.endsWith('@s.whatsapp.net')) {
        namesStore.setMapping(voterNormalized, rawParticipantPn);
      }
    }
    const voterLid = namesStore.resolveCanonicalId(voterNormalized) || (voterNormalized?.endsWith('@lid') ? voterNormalized : null);
    const voterPn = rawParticipantPn || namesStore.getPnByLid(voterNormalized) || (voterNormalized?.endsWith('@s.whatsapp.net') ? voterNormalized : null);

    const voterCandidates = [
      voterNormalized,
      voterLid,
      voterPn,
      u.pollUpdateMessageKey?.participantPn ? jidNormalizedUser(u.pollUpdateMessageKey.participantPn) : null,
      u.pollUpdateMessageKey?.participant ? jidNormalizedUser(u.pollUpdateMessageKey.participant) : null,
      u.pollUpdateMessageKey?.remoteJid ? jidNormalizedUser(u.pollUpdateMessageKey.remoteJid) : null,
      u.pollUpdateMessageKey?.fromMe ? meLid : null,
      u.pollUpdateMessageKey?.fromMe ? mePn : null
    ];

    let votePayload = u.vote;
    let authenticatingVoter = voterNormalized || mePn;
    const isEncrypted = votePayload && (votePayload.encPayload || votePayload.encIv) && !Array.isArray(votePayload.selectedOptions);
    if (isEncrypted) {
      if (!pollEncKey) {
        console.log(`[poll] Cannot decrypt vote from ${voterNormalized}: missing messageSecret on creation message`);
        continue;
      }
      try {
        const res = safeDecryptPollVote(
          votePayload,
          pollId,
          pollEncKey,
          pollCreatorCandidates,
          voterCandidates
        );
        votePayload = res.decrypted;
        authenticatingVoter = res.authenticatingVoterJid;
        console.log(`[poll] Successfully decrypted vote from ${authenticatingVoter} (creator: ${res.authenticatingCreatorJid}) for poll ${pollId}`);
      } catch (err) {
        console.error(`[poll] Failed to decrypt poll vote from ${voterNormalized || 'fromMe'}:`, err && err.message ? err.message : err);
        continue;
      }
    }

    votePayload = normalizeVotePayload(votePayload);
    const canonicalVoter = voterLid || authenticatingVoter;
    const hasSelectedOptions = Array.isArray(votePayload?.selectedOptions) && votePayload.selectedOptions.length > 0;

    if (!hasSelectedOptions) {
      pollState.voteBuffer.delete(canonicalVoter);
      if (voterNormalized) pollState.voteBuffer.delete(voterNormalized);
      if (voterPn) pollState.voteBuffer.delete(voterPn);
      if (voterLid) pollState.voteBuffer.delete(voterLid);
      console.log(`[poll] Voter ${nameFor(canonicalVoter)} (${canonicalVoter}) unvoted / removed selection from poll ${pollId}. Removed from voteBuffer.`);
    } else {
      pollState.voteBuffer.set(canonicalVoter, {
        ...u,
        pollUpdateMessageKey: {
          ...u.pollUpdateMessageKey,
          fromMe: false,
          participant: canonicalVoter
        },
        vote: votePayload
      });
      playerActivity.recordVoted(canonicalVoter, u.senderTimestampMs || Date.now(), pollState.remoteJid);

      const voterName = nameFor(canonicalVoter);
      if (voterName && !ratings.isPlaceholder(voterName) && !GENERIC_NAMES.has(ratings.keyFor(voterName))) {
        await ratings.ensureRated([{
          name: voterName,
          jid: canonicalVoter,
          lid: authenticatingVoter && authenticatingVoter.endsWith('@lid') ? authenticatingVoter : null
        }]);
      }
    }
  }

  // Cross-poll duplicate vote check for multi-poll sessions
  if (pollState.parentPollId) {
    const siblingPolls = [...activePolls.entries()]
      .filter(([id, s]) => id !== pollId && s.parentPollId === pollState.parentPollId && s.status !== 'cancelled' && s.status !== 'stopped');

    for (const [sibId, sibState] of siblingPolls) {
      if (sibState.voteBuffer) {
        for (const [voterKey] of pollState.voteBuffer.entries()) {
          const voterNorm = jidNormalizedUser(voterKey);
          const voterLid = namesStore.resolveCanonicalId(voterNorm) || voterNorm;
          const voterPn = namesStore.getPnByLid(voterNorm);
          const hasVotedInSib = sibState.voteBuffer.has(voterKey) ||
            sibState.voteBuffer.has(voterNorm) ||
            (voterLid && sibState.voteBuffer.has(voterLid)) ||
            (voterPn && sibState.voteBuffer.has(voterPn));

          if (hasVotedInSib) {
            const notifKey = `${voterKey}_${pollId}_${sibId}`;
            if (!Array.isArray(pollState.duplicateVotersNotified)) {
              pollState.duplicateVotersNotified = [];
            }
            if (!pollState.duplicateVotersNotified.includes(notifKey)) {
              pollState.duplicateVotersNotified.push(notifKey);
              if (Array.isArray(sibState.duplicateVotersNotified)) {
                sibState.duplicateVotersNotified.push(notifKey);
              } else {
                sibState.duplicateVotersNotified = [notifKey];
              }
              const voterName = nameFor(voterKey);
              const timeStr = pollState.when ? ` for ${pollState.when}` : '';
              const pA = Math.min(pollState.partNumber || 1, sibState.partNumber || 2);
              const pB = Math.max(pollState.partNumber || 1, sibState.partNumber || 2);
              const dupText = `⚠️ *Duplicate Vote Notice:* ${voterName} has voted in both Part ${pA} and Part ${pB}${timeStr}. Please pick only one spot across the match polls.`;
              console.log(`[poll] Duplicate vote detected for ${voterName} across Part ${pollState.partNumber} and Part ${sibState.partNumber}`);
              if (sock && typeof sock.sendMessage === 'function') {
                await sendMessageAndRecord(sock, pollState.remoteJid, { text: dupText, mentions: [voterKey] });
              }
            }
          }
        }
      }
    }
  }

  persistPolls();

  const merged = [...pollState.voteBuffer.values()].map((u) => ({
    ...u,
    vote: normalizeVotePayload(u.vote)
  }));

  if (pollState.isManual) {
    let yesCount = 0;
    let noCount = 0;
    let filledCount = 0;
    let totalOptionsCount = pollState.options ? pollState.options.length : 0;
    let aggregated = [];
    try {
      aggregated = getAggregateVotesInPollMessage(
        { message: pollCreationMessage, pollUpdates: merged },
        mePn
      );
      const yesOpt = aggregated.find((o) => /^yes$/i.test(o.name.trim()));
      const noOpt = aggregated.find((o) => /^no$/i.test(o.name.trim()));
      yesCount = yesOpt ? yesOpt.voters.length : 0;
      noCount = noOpt ? noOpt.voters.length : 0;

      const votingOptions = aggregated.filter((o) => !/^(no|out|can't play|cannot play)$/i.test(o.name.trim()));
      filledCount = votingOptions.filter((o) => o.voters.length > 0).length;
      totalOptionsCount = votingOptions.length > 0
        ? votingOptions.length
        : (pollState.options ? pollState.options.filter((o) => !/^(no|out|can't play|cannot play)$/i.test(o.trim())).length : 0);
    } catch (e) { }

    if (pollState.type !== 'opt_in' && !pollState.options?.some((o) => /^yes$/i.test(o.trim()))) {
      const hasConflict = await checkAndNotifySlotConflicts(sock, pollId, pollState, aggregated, context);
      const isFilled = (pollState.type !== 'opt_in' && totalOptionsCount > 0 && filledCount >= totalOptionsCount);
      if (hasConflict && !isFilled) {
        return;
      }
    }

    if (pollState.status !== 'resolved' && pollState.status !== 'cancelled' && pollState.status !== 'stopped') {
      const isFilled = (pollState.type !== 'opt_in' && totalOptionsCount > 0 && filledCount >= totalOptionsCount);
      const newStatus = isFilled ? 'filled' : 'active';
      if (pollState.status !== newStatus) {
        pollState.status = newStatus;
        persistPolls();
      }
    }

    console.log(`[poll] Manually-created poll ${pollId} vote updated (${pollState.voteBuffer.size} vote(s) buffered, status: ${pollState.status}, filled: ${filledCount}/${totalOptionsCount}, Yes: ${yesCount}, No: ${noCount}). Passively tracking -- waiting for explicit matchup request.`);
    return;
  }

  if (pollState.type === 'multi_time' && Array.isArray(pollState.timeSlots)) {
    await handleMultiTimePollVote(sock, pollId, pollState, pollCreationMessage, merged, mePn, context);
    return;
  }

  if (pollState.type === 'opt_in' || pollState.size === null) {
    let aggregated;
    try {
      aggregated = getAggregateVotesInPollMessage(
        {
          message: pollCreationMessage,
          pollUpdates: merged
        },
        mePn
      );
    } catch (err) {
      console.error(`[poll] getAggregateVotesInPollMessage failed for poll ${pollId}:`, err.message);
      return;
    }
    const yesOption = aggregated.find((o) => /^yes$/i.test(o.name.trim()));
    const noOption = aggregated.find((o) => /^no$/i.test(o.name.trim()));
    const yesCount = yesOption ? yesOption.voters.length : 0;
    const noCount = noOption ? noOption.voters.length : 0;

    if (pollState.slotLimit) {
      const yesVoters = yesOption ? yesOption.voters.map(nameFor) : [];
      if (yesVoters.length > pollState.slotLimit) {
        const excessVoters = yesVoters.slice(pollState.slotLimit);
        const excessSig = excessVoters.join('|');
        if (pollState.lastExcessSignature !== excessSig) {
          const prevExcess = (pollState.lastExcessSignature || '').split('|').filter(Boolean);
          const newExcess = excessVoters.filter((p) => !prevExcess.includes(p));
          pollState.lastExcessSignature = excessSig;
          persistPolls();
          if (newExcess.length > 0) {
            const warnText = `⚠️ *Notice:* The slot limit for this match poll has been set to ${pollState.slotLimit} players and the poll is already filled! The Yes vote(s) from *${newExcess.join(', ')}* cross this limit and will not be considered.`;
            console.log(`[poll] Sending excess opt-in votes warning in ${pollState.remoteJid}: ${newExcess.join(', ')}`);
            await sendMessageAndRecord(sock, pollState.remoteJid, { text: warnText });
          }
        }
      }
    }

    console.log(`[poll] Opt-in poll ${pollId}: ${yesCount} Yes vote(s), ${noCount} No vote(s) recorded.`);
    return;
  }

  let aggregated;
  try {
    aggregated = getAggregateVotesInPollMessage(
      {
        message: pollCreationMessage,
        pollUpdates: merged
      },
      mePn
    );
  } catch (err) {
    console.error(`[poll] getAggregateVotesInPollMessage failed for poll ${pollId}:`, err.message);
    return;
  }

  const hasConflict = await checkAndNotifySlotConflicts(sock, pollId, pollState, aggregated, context);
  const tempRoster = resolveFixedPollRoster(pollState, aggregated);
  if (hasConflict && !tempRoster.isAllFilled) {
    return;
  }

  // On-demand court booking:
  // 1. Opportunistic booking for original unbooked courts when openings fall below 3 (only before any court was released)
  // 2. Exact-need re-booking for released courts: only when there are no free player openings (e.g. 9th player votes for 8 spots)
  const bookedCourtsCount = Array.isArray(pollState.prebookedCourts) ? pollState.prebookedCourts.length : 0;
  const playersPerCourt = pollState.courtBookingType === 'singles' ? 2 : 4;
  const bookedCapacity = bookedCourtsCount * playersPerCourt;
  const playerOpenings = bookedCapacity - tempRoster.filledCount;
  const hasUnbookedCourts = Array.isArray(pollState.unbookedCourts) && pollState.unbookedCourts.length > 0;
  const hasTentativeCourts = Array.isArray(pollState.tentativeCourts) && pollState.tentativeCourts.length > 0;
  const hasReleasedCourts = Array.isArray(pollState.releasedCourts) && pollState.releasedCourts.length > 0;

  const hasVotedBeyondCapacity = Array.isArray(aggregated) && aggregated.some((opt, idx) => {
    if (!opt || !Array.isArray(opt.voters) || opt.voters.length === 0) return false;
    if (/^(no|out|can't play|cannot play)$/i.test(opt.name?.trim())) return false;
    const slotNum = getSlotNumberForOption(opt.name, idx, pollState);
    return slotNum > bookedCapacity;
  });

  if (
    pollState.type !== 'opt_in' &&
    (bookedCourtsCount > 0 || hasTentativeCourts) &&
    !pollState.onDemandBookingInProgress
  ) {
    if (hasReleasedCourts && tempRoster.allPlayers.length > bookedCapacity) {
      // Re-booking of released court initiated only when there are no free openings (e.g. 9th player arrives)
      const courtToRebook = pollState.releasedCourts[0];
      const triggeringEntry = tempRoster.voterEntries && tempRoster.voterEntries.length > 0
        ? tempRoster.voterEntries[tempRoster.voterEntries.length - 1]
        : null;
      const triggeringVoterJid = triggeringEntry?.voterJid || null;
      const triggeringVoteMsgKey = triggeringVoterJid
        ? (pollState.voteBuffer?.get(triggeringVoterJid)?.pollUpdateMessageKey || null)
        : null;

      pollState.onDemandBookingInProgress = true;
      handleOnDemandCourtBooking(sock, pollId, pollState, aggregated, context, {
        isRebooking: true,
        targetCourt: courtToRebook,
        triggeringVoterJid,
        triggeringVoteMsgKey
      }).catch((err) => {
        console.error(`[poll] Unhandled error in background re-booking for poll ${pollId}:`, err);
      });
    } else if (!hasReleasedCourts && (hasUnbookedCourts || hasTentativeCourts) && (playerOpenings < 3 || hasVotedBeyondCapacity)) {
      // Opportunistic booking when openings fall below 3, or when slots beyond booked capacity (tentative/unbooked) are voted on
      pollState.onDemandBookingInProgress = true;
      handleOnDemandCourtBooking(sock, pollId, pollState, aggregated, context).catch((err) => {
        console.error(`[poll] Unhandled error in background on-demand court booking for poll ${pollId}:`, err);
      });
    }
  }

  // Check and release unfilled courts at 70%, 80%, 90% milestones
  await checkCourtReleasesForPoll(sock, pollId, pollState, context);

  // Check and notify if any voters selected invalid slots (when slotLimit is set)
  await checkAndNotifyInvalidSlotVotes(sock, pollId, pollState, aggregated, context);

  const { players, excessPlayers, filledCount, totalSlotsCount, isAllFilled } = resolveFixedPollRoster(pollState, aggregated);

  if (pollState.slotLimit && excessPlayers && excessPlayers.length > 0) {
    const excessSig = excessPlayers.join('|');
    if (pollState.lastExcessSignature !== excessSig) {
      const prevExcess = (pollState.lastExcessSignature || '').split('|').filter(Boolean);
      const newExcess = excessPlayers.filter((p) => !prevExcess.includes(p));
      pollState.lastExcessSignature = excessSig;
      persistPolls();
      const alreadyNotifiedAny = Array.isArray(pollState.invalidSlotVotesNotified) && pollState.invalidSlotVotesNotified.length > 0;
      if (newExcess.length > 0 && !alreadyNotifiedAny) {
        const warnText = `⚠️ *Notice:* The slot limit for this match poll has been set to ${pollState.slotLimit} players and the poll is already filled! The vote(s) from *${newExcess.join(', ')}* cross this limit and will not be considered.`;
        console.log(`[poll] Sending excess votes warning in ${pollState.remoteJid}: ${newExcess.join(', ')}`);
        await sendMessageAndRecord(sock, pollState.remoteJid, { text: warnText });
      }
    }
  }

  console.log(
    `[poll] Poll ${pollId}: ${filledCount}/${totalSlotsCount} slot(s) filled (${pollState.size} players total), ` +
    `0 conflicting slot(s), ${pollState.voteBuffer.size} raw vote(s) buffered.`
  );

  if (pollState.status !== 'active' && pollState.status !== 'filled') return;

  if (isAllFilled) {
    if (pollState.status !== 'filled' && pollState.status !== 'resolved') {
      pollState.status = 'filled';
      pollState.lastPlayers = players;
      persistPolls();
    }

    if (pollState.parentPollId) {
      const sessionPollEntries = [...activePolls.entries()]
        .filter(([, s]) => s.parentPollId === pollState.parentPollId && s.status !== 'cancelled' && s.status !== 'stopped')
        .sort((a, b) => (a[1].partNumber || 1) - (b[1].partNumber || 1));

      const allCurrentlyActiveFilled = sessionPollEntries.every(([, s]) => s.status === 'filled' || s.status === 'resolved');
      const totalParts = pollState.totalParts || sessionPollEntries.length;

      if (allCurrentlyActiveFilled) {
        if (sessionPollEntries.length < totalParts) {
          // DEMAND-DRIVEN SPILLOVER: Next part opens automatically!
          const nextPartNumber = sessionPollEntries.length + 1;
          const plannedBatches = pollState.plannedBatches || [];
          const nextBatchSize = plannedBatches[nextPartNumber - 1] || 4;
          const nextStartSlot = plannedBatches.slice(0, nextPartNumber - 1).reduce((sum, b) => sum + b, 0) + 1;
          const nextEndSlot = nextStartSlot + nextBatchSize - 1;

          const nextPartValues = Array.from({ length: nextBatchSize }, (_, i) => `Player ${nextStartSlot + i}`);
          const timeLabel = pollState.when || 'today';
          const isSim = hasSimulationPrefix(pollState.name) || Boolean(pollState.name?.includes('SIMULATION'));
          const spilloverTitle = formatPollTitle({
            customTitle: pollState.title || null,
            isSimulation: isSim,
            timeLabel,
            suffix: ` (Part ${nextPartNumber}/${totalParts}: Spots ${nextStartSlot}–${nextEndSlot})`
          });

          const filledPartsStr = sessionPollEntries.map(([, s]) => `Part ${s.partNumber}`).join(' & ');
          const announceText = `🎾 *Match Update:* All spots across ${filledPartsStr} are filled! Opening Part ${nextPartNumber}/${totalParts} for ${nextBatchSize} more spots (Spots ${nextStartSlot}–${nextEndSlot})...`;
          console.log(`[poll] ${announceText}`);
          if (sock && typeof sock.sendMessage === 'function') {
            await sendMessageAndRecord(sock, pollState.remoteJid, { text: announceText });
          }

          let newPollId = `spillover_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
          let sent = null;
          if (sock && typeof sock.sendMessage === 'function') {
            try {
              sent = await sock.sendMessage(pollState.remoteJid, {
                poll: {
                  name: spilloverTitle,
                  values: nextPartValues,
                  selectableCount: 1
                }
              });
              if (sent?.key?.id) {
                newPollId = sent.key.id;
              }
            } catch (err) {
              console.error('[poll] Error sending spillover poll:', err.message);
            }
          }

          if (messageStore && sent?.key) {
            messageStore.set(storeKey(sent.key.remoteJid, newPollId), sent.message);
          }

          const allPollIds = [...sessionPollEntries.map(([id]) => id), newPollId];
          const newPollState = {
            ...pollState,
            title: pollState.title || null,
            name: spilloverTitle,
            options: nextPartValues,
            size: nextBatchSize,
            status: 'active',
            partNumber: nextPartNumber,
            totalParts,
            startSlot: nextStartSlot,
            endSlot: nextEndSlot,
            partSize: nextBatchSize,
            creator: null,
            prebookedPlayers: null,
            voteBuffer: new Map(),
            lastPlayers: null,
            sentReminders: Array.isArray(pollState.sentReminders) ? [...pollState.sentReminders] : [],
            siblingPollIds: allPollIds.filter((id) => id !== newPollId)
          };
          activePolls.set(newPollId, newPollState);

          for (const [, s] of sessionPollEntries) {
            s.siblingPollIds = allPollIds.filter((pId) => pId !== newPollId);
          }
          if (latestPollIdByChat) latestPollIdByChat.set(pollState.remoteJid, newPollId);
          persistPolls();
          return;
        } else {
          // All parts are filled! Auto-generate combined matchups across all courts
          const allSessionPlayers = [];
          for (const [, s] of sessionPollEntries) {
            const sPlayers = s.lastPlayers || [];
            for (const p of sPlayers) {
              if (!allSessionPlayers.some((existing) => ratings.keyFor(existing) === ratings.keyFor(p))) {
                allSessionPlayers.push(p);
              }
            }
          }

          if (hasConflict || !shouldAutoGenerateLineupOnFill(pollState)) {
            console.log(`[poll] Multi-poll session ${pollState.parentPollId} filled (${allSessionPlayers.length} players). Auto-matchup disabled or conflict present; status set to filled.`);
            return;
          }

          console.log(`[poll] Multi-poll session ${pollState.parentPollId} filled -- auto-posting combined matchups for ${allSessionPlayers.length} players: ${allSessionPlayers.join(', ')}`);
          await ratings.ensureRated(allSessionPlayers);
          const prebookedCourts = await getPrebookedCourtsForPoll(pollState, pollState.remoteJid);
          const schedule = generateMatchups(allSessionPlayers, { prebookedCourts, chatId: pollState.remoteJid });
          const whenHeader = formatMatchHeaderTime(pollState);
          const header = whenHeader ? `📅 ${whenHeader}\n\n` : '';
          if (sock && typeof sock.sendMessage === 'function') {
            await sendMessageAndRecord(sock, pollState.remoteJid, { text: header + formatMatchups(schedule) });
          }
          pairHistory.recordDraw(pollState.parentPollId, schedule, Date.now(), pollState.remoteJid);
          const playAtMs = pollState?.playAt ? new Date(pollState.playAt).getTime() : Date.now();
          playerActivity.recordPlayed(allSessionPlayers, playAtMs, pollState.remoteJid);

          for (const [, s] of sessionPollEntries) {
            s.status = 'resolved';
            s.lastPlayers = allSessionPlayers;
            s.lastSchedule = summarizeSchedule(schedule);
          }
          persistPolls();
          return;
        }
      }
      return;
    }

    if (hasConflict || !shouldAutoGenerateLineupOnFill(pollState)) {
      if (pollState.status !== 'filled') {
        pollState.status = 'filled';
        pollState.lastPlayers = players;
        persistPolls();
        console.log(`[poll] Poll ${pollId} filled (${players.length} players: ${players.join(', ')}). ${hasConflict ? 'Slot conflicts present' : 'Auto-matchup disabled'}; status set to filled; waiting for matchup request.`);
      }
      return;
    }

    pollState.status = 'resolved';
    pollState.lastPlayers = players;
    persistPolls();

    console.log(`[poll] Poll ${pollId} filled -- auto-posting matchups for: ${players.join(', ')}`);

    await ratings.ensureRated(players);
    const prebookedCourts = await getPrebookedCourtsForPoll(pollState, pollState.remoteJid);
    const schedule = generateMatchups(players, { prebookedCourts, chatId: pollState.remoteJid });
    const whenHeader = formatMatchHeaderTime(pollState);
    const header = whenHeader ? `📅 ${whenHeader}\n\n` : '';
    await sendMessageAndRecord(sock, pollState.remoteJid, { text: header + formatMatchups(schedule) });
    pairHistory.recordDraw(pollId, schedule, Date.now(), pollState.remoteJid);
    const playAtMs = pollState?.playAt ? new Date(pollState.playAt).getTime() : Date.now();
    playerActivity.recordPlayed(players, playAtMs, pollState.remoteJid);

    pollState.lastSchedule = summarizeSchedule(schedule);
    persistPolls();
  } else if (pollState.status === 'filled') {
    pollState.status = 'active';
    persistPolls();
  }
}

module.exports = {
  getMessageSecret,
  safeDecryptPollVote,
  checkAndNotifySlotConflicts,
  pendingPollVotes,
  bufferPendingVote,
  flushPendingPollVotes,
  handleMultiTimePollVote,
  processPollVoteEvent
};
