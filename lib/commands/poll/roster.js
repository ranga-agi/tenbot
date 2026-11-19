/**
 * Shared Poll Primitives, Constants, Slot Checks & Roster Resolution
 */

const {
  getAggregateVotesInPollMessage,
  jidNormalizedUser,
  normalizeMessageContent
} = require('@whiskeysockets/baileys');

const ratings = require('../../ratings');
const namesStore = require('../../names');
const { sendMessageAndRecord } = require('../../botMessage');
const recurringPollsModule = require('../../recurringPolls');
const scvcc = require('../../scvcc');
const anthropic = require('../../anthropic');
const pollTime = require('../../pollTime');
const { isSameUser } = require('../groupCommands');

const { resolvePlayDateTime, getSanJoseNow, getSanJoseParts, formatLookAround } = pollTime;

const TRIGGER_PREFIX = '@tenbot';
const GENERIC_NAMES = new Set(['someone', 'player', 'player 1', 'player 2', 'player 3', 'player 4', 'me']);
const POLL_EXPIRY_GRACE_DAYS = 14;
const POLL_REMINDER_HOURS = [1, 2, 4, 8, 16, 24, 32, 64];
const POWERS_OF_2_REMINDER_HOURS = POLL_REMINDER_HOURS;
const MAX_POLL_REMINDERS = 2;

const SIMULATION_PREFIX = "[Simulation]";
const TENTATIVE_SLOT_TAG = " ✱";

function hasSimulationPrefix(title = "") {
  if (!title || typeof title !== "string") return false;
  return /^(?:🎾\s*)?\[simulation\] /i.test(title.trim());
}

const storeKey = (remoteJid, id) => `${remoteJid}:${id}`;

function isCourtSkipped(courtName, skippedCourts) {
  return recurringPollsModule.isCourtSkipped(courtName, skippedCourts);
}

function nameFor(jid) {
  if (!jid || jid === 'me') return 'Me';
  const clean = String(jid).replace(/^@+/, '').trim();
  const norm = jidNormalizedUser(clean) || clean;
  const registeredName = namesStore.getName(norm) || namesStore.getName(clean) || namesStore.getName(jid);
  if (registeredName) return registeredName;
  const pn = namesStore.getPnByLid(norm) || namesStore.getPnByLid(clean);
  const digits = (pn || norm || clean).split('@')[0].replace(/\D/g, '');
  if (digits.length >= 4) return `Player (${digits.slice(-4)})`;
  return digits ? `Player (${digits})` : 'Player';
}

/**
 * Checks if a poll title or poll state specifies an explicit time of play.
 * Returns true if an explicit time or time of day is present in the title.
 */
function capitalize(s) {
  if (!s || typeof s !== 'string') return '';
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}

function hasTimeSpecifiedInTitle(titleOrPoll) {
  if (!titleOrPoll) return false;
  if (typeof titleOrPoll === "object") {
    if (titleOrPoll.playAt === null || titleOrPoll.playAt === 'unknown') {
      return false;
    }
    if (typeof titleOrPoll.hasTimeInTitle === "boolean") {
      return titleOrPoll.hasTimeInTitle;
    }
    if (titleOrPoll.timeWord) {
      return true;
    }
    titleOrPoll = titleOrPoll.name || titleOrPoll.when || "";
  }
  const clean = String(titleOrPoll).trim();
  if (!clean) return false;

  // 1. Explicit 12-hour time with AM/PM (e.g. "7pm", "7:30pm", "9 am", "11:30 AM")
  if (/\b\d{1,2}(?:[:.]\d{2})?\s*(?:am|pm)\b/i.test(clean)) {
    return true;
  }

  // 2. Colon or dot separated time (e.g. "7:30", "19:00", "08.30")
  if (/\b(?:[01]?\d|2[0-3])[:.][0-5]\d\b/.test(clean)) {
    return true;
  }

  // 3. "at <number>" or "@ <number>" (e.g. "at 7", "@ 9", "@ 6:30")
  if (/\b(?:at|@)\s*\d{1,2}(?::\d{2})?\s*(?:am|pm)?\b/i.test(clean)) {
    return true;
  }

  // 4. Named time of day (e.g. "morning", "afternoon", "evening", "night", "noon", "midday")
  if (/\b(morning|afternoon|evening|night|noon|midday)\b/i.test(clean)) {
    return true;
  }

  return false;
}

function isMatchSchedulingPoll(title = '', options = []) {
  if (hasSimulationPrefix(title)) return false;
  const text = `${title} ${options.join(' ')}`.toLowerCase();
  const matchKeywords = /\b(tennis|match|matches|court|courts|singles|doubles|play|playing|players|player|game|games|drill|drills|session|hit|hitting|schedule|scheduling|scvcc)\b/i;
  const timeKeywords = /\b(today|tomorrow|tonight|monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tue|wed|thu|fri|sat|sun|morning|evening|afternoon)\b|\b\d{1,2}(?:[:.]\d{2})?\s*(?:am|pm)\b|\b\d{1,2}[:.]\d{2}\b/i;
  const slotKeywords = /\b(?:player|spot|slot|court|p)\s*#?\s*\d+|\b\d+\b/i;
  const hasOptInOrSlot = options.some((opt) => /^(yes|no|in|out|playing|can't play)$/i.test(opt.trim()) || slotKeywords.test(opt.trim()));

  if (matchKeywords.test(text)) return true;
  if (timeKeywords.test(title) && hasOptInOrSlot) return true;
  return false;
}

async function interpretManualPollWithLLM(pollName, options, creatorName) {
  const fallback = () => {
    const isMatchScheduling = isMatchSchedulingPoll(pollName, options);
    const dayMatch = pollName.match(/\b(today|tonight|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tue|wed|thu|fri|sat|sun)\b/i);
    const timeMatch = pollName.match(/\b(\d{1,2}(?:[:.]\d{2})?\s*(?:am|pm))\b/i) || pollName.match(/\b(\d{1,2}[:.]\d{2})\b/i);
    const hasYesNo = options.some((opt) => /^yes$/i.test(opt.trim())) && options.some((opt) => /^no$/i.test(opt.trim()));
    const timeWord = timeMatch ? timeMatch[1] : null;
    const dayWord = dayMatch ? dayMatch[1] : null;
    let whenStr = pollName;
    if (timeWord && !dayWord) {
      const playAt = resolvePlayDateTime(null, timeWord);
      const playParts = getSanJoseParts(playAt);
      const nowParts = getSanJoseParts(getSanJoseNow());
      if (playParts.day !== nowParts.day || playParts.month !== nowParts.month) {
        whenStr = `Tomorrow ${timeWord}`;
      }
    }
    const isPlayerSlotOption = (opt) => {
      const clean = opt.trim();
      return /^(?:player|spot|slot|court|p|#)\s*#?\s*\d+\b/i.test(clean) ||
             /^\d+$/.test(clean);
    };
    const hasPlayerSlots = options.length > 0 && !hasYesNo && (
      options.some((opt) => /^(?:player|spot|slot|p)\s*#?\s*\d+/i.test(opt.trim())) ||
      (isMatchScheduling && options.length >= 2 && options.every((opt) => /^\d+$/.test(opt.trim())))
    );
    const slotCheck = Boolean(isMatchScheduling && hasPlayerSlots);

    const namedPlayers = extractNamedPlayersFromTitle(pollName, creatorName);
    return {
      isMatchScheduling,
      dayWord,
      timeWord,
      when: whenStr,
      type: hasYesNo ? 'opt_in' : 'manual',
      size: hasYesNo ? null : (options.length > 0 ? options.length : null),
      slotCheck,
      namedPlayers
    };
  };

  if (!anthropic.isAnthropicConfigured()) {
    return fallback();
  }

  const sjTimeStr = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles',
    weekday: 'long',
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true
  }).format(new Date());

  const prompt = `You are a specialized interpreter for a tennis group chat bot in San Jose, CA (Pacific Time).
Current local time in San Jose: ${sjTimeStr}.

A user has just created a WhatsApp poll in the tennis group.
Poll Details:
- Title: "${pollName}"
- Options: [${options.map((o) => `"${o}"`).join(', ')}]
- Creator: "${creatorName}"

Please analyze this poll:
1. Is this poll for scheduling/organizing a tennis match, practice session, hitting, drill, or court play? (isMatchScheduling: true/false).
   (Note: Social polls, food orders, equipment banter, or non-tennis topics should be isMatchScheduling: false).
2. What day is it scheduled for? (e.g. "today", "tomorrow", "saturday", "sunday", or null if not mentioned). If only a start time was mentioned (e.g. "Tennis 7pm", "6am") without an explicit day word and the start time is already in the past today in San Jose, leave dayWord as null.
3. What time is it scheduled for? (e.g. "9am", "6:30pm", "10am", or null if not mentioned).
4. Provide a clean human-readable when string (e.g. "Sunday 7:30am", "Saturday 6pm", "Tomorrow 7pm", "Today 8:30am"). If only a start time was mentioned without an explicit day and the start time is already in the past today in San Jose (e.g. it is 8pm now and poll title is "Tennis 7pm"), use "Tomorrow <time>" (e.g. "Tomorrow 7pm"). If a day of the week (e.g. Sunday) was mentioned or implied, ALWAYS use the named day (e.g. "Sunday 7:30am"). Only use "Tomorrow" if the user explicitly wrote "tomorrow" or if only a time was given that has already passed today.
5. Poll type: "opt_in" for Yes/No polls, or "manual" for fixed/numbered slots.
6. Poll size: number of player spots (or null if opt-in).
7. Slot check option: (slotCheck: true/false). Evaluate BOTH the poll title and the voting slot names (options). Are the voting slots designed for a separate vote per individual player (e.g. numbered player spots like "Player 1", "Player 2", "Spot 1", "Slot 1", "P1", "P2", "1", "2", "3", "4" where each option is meant for one distinct person to claim)?
   ONLY enable slotCheck (set slotCheck: true) if the voting slots are for a separate vote per player.
   If the poll is an opt-in poll (e.g. Yes/No), or if the voting options represent times, days, dates, locations, formats, or multiple people can choose the same slot, set slotCheck: false.
8. Named players: (namedPlayers: string[]). Check the poll title and options for any player names or aliases explicitly mentioned as already playing, participating, or included (e.g. "with VJ, Vik, Deepak", "Alice & Bob vs Charlie & David", "Tennis with Vik, Deepak", "doubles w/ Bob").
   Return an array of the exact player name/alias strings mentioned (e.g. ["VJ", "Vik", "Deepak"]). If no players are named, return [].

CRITICAL INSTRUCTION: You MUST return strictly valid JSON format only, starting with { and ending with }. Do NOT enclose in markdown code blocks and do not output any preamble, commentary, or extra text.
{
  "isMatchScheduling": boolean,
  "dayWord": string or null,
  "timeWord": string or null,
  "when": string or null,
  "type": "opt_in" | "manual",
  "size": number or null,
  "slotCheck": boolean,
  "namedPlayers": string[]
}`;

  try {
    const parsed = await anthropic.callAnthropicJson({
      prompt,
      maxTokens: 300
    });

    let resolvedWhenStr = parsed.when || pollName;
    if (parsed.dayWord && !/^(?:today|tomorrow|tonight)$/i.test(parsed.dayWord) && /^(?:tomorrow|today)\b/i.test(resolvedWhenStr)) {
      const capDay = parsed.dayWord.charAt(0).toUpperCase() + parsed.dayWord.slice(1).toLowerCase();
      resolvedWhenStr = parsed.timeWord ? `${capDay} ${parsed.timeWord}` : capDay;
    }

    let slotCheck = false;
    if (typeof parsed.slotCheck === 'boolean') {
      slotCheck = parsed.slotCheck;
    } else {
      const hasYesNo = options.some((opt) => /^yes$/i.test(opt.trim())) && options.some((opt) => /^no$/i.test(opt.trim()));
      const hasPlayerSlots = options.length > 0 && !hasYesNo && (
        options.some((opt) => /^(?:player|spot|slot|p)\s*#?\s*\d+/i.test(opt.trim())) ||
        (Boolean(parsed.isMatchScheduling) && options.length >= 2 && options.every((opt) => /^\d+$/.test(opt.trim())))
      );
      slotCheck = Boolean(parsed.isMatchScheduling && hasPlayerSlots);
    }

    let namedPlayers = [];
    if (Array.isArray(parsed.namedPlayers)) {
      namedPlayers = parsed.namedPlayers;
    } else {
      namedPlayers = extractNamedPlayersFromTitle(pollName, creatorName);
    }

    return {
      isMatchScheduling: Boolean(parsed.isMatchScheduling),
      dayWord: parsed.dayWord || null,
      timeWord: parsed.timeWord || null,
      when: resolvedWhenStr,
      type: parsed.type === 'opt_in' ? 'opt_in' : 'manual',
      size: typeof parsed.size === 'number' ? parsed.size : (parsed.type === 'opt_in' ? null : (options.length > 0 ? options.length : null)),
      slotCheck,
      namedPlayers
    };
  } catch (err) {
    console.error('[poll-llm] Failed to interpret poll with LLM, using fallback:', err.message);
    return fallback();
  }
}

function isValidPlayerCount(n) {
  return n === 2 || (n >= 4 && n % 4 === 0);
}

function getNextValidPlayerCount(n) {
  if (n <= 2) return 2;
  return Math.ceil(n / 4) * 4;
}

/**
 * Partitions total player slots across court-based multi-polls, always maxing out
 * slots for each poll (up to 12, the WhatsApp limit) before creating the next one.
 * - For 16 spots: [12, 4] (Part 1: Spots 1–12, Part 2: Spots 13–16)
 * - For 20 spots: [12, 8] (Part 1: Spots 1–12, Part 2: Spots 13–20)
 * - For 24 spots: [12, 12] (Part 1: Spots 1–12, Part 2: Spots 13–24)
 * - For > 24 spots (e.g. 28, 32): [12, 12, 4], [12, 12, 8], etc.
 */
function partitionMatchSlots(totalSpots, spotsPerCourt = 4) {
  if (totalSpots <= 12) return [totalSpots];
  const perCourt = spotsPerCourt > 0 ? spotsPerCourt : 4;
  const maxCourtsPerPoll = Math.floor(12 / perCourt) || 3;
  const maxSpotsPerPoll = maxCourtsPerPoll * perCourt;

  const batches = [];
  let remainingSpots = totalSpots;
  while (remainingSpots > 0) {
    const batchSpots = Math.min(remainingSpots, maxSpotsPerPoll);
    batches.push(batchSpots);
    remainingSpots -= batchSpots;
  }
  return batches;
}

function getFirstSlotNumber(options) {
  if (!options || options.length === 0) return null;
  const firstLabel = String(options[0]).trim();
  const match = firstLabel.match(/^(?:player|spot|slot|court|p|#|no\.?|num\.?)\s*#?\s*(\d+)\b/i) ||
    firstLabel.match(/\b(\d+)\b/);
  if (match) {
    const num = parseInt(match[1], 10);
    if (Number.isFinite(num) && num >= 1) return num;
  }
  return null;
}

function addNextCreatorPlayer(players, creatorName) {
  const creatorKey = ratings.keyFor(creatorName);
  const isCreatorInList = players.some((p) => ratings.keyFor(p) === creatorKey);
  if (!isCreatorInList && !GENERIC_NAMES.has(creatorKey)) {
    players.push(creatorName);
    return creatorName;
  }

  let suffix = 2;
  while (true) {
    const candidate = `${creatorName} ${suffix}`;
    const candidateKey = ratings.keyFor(candidate);
    if (!players.some((p) => ratings.keyFor(p) === candidateKey)) {
      players.push(candidate);
      return candidate;
    }
    suffix++;
  }
}

function extractNamedPlayersFromTitle(title, creatorName = null, chatId = null) {
  if (!title || typeof title !== 'string') return [];

  const withMatch = title.match(/\b(?:with|w\/|including|incl\.?)\s+([^:()]+?)(?:\s*(?:\(|$|\n|\t|[-–—:]\s*(?![a-z])))/i);
  const parenMatch = title.match(/\(([^()]+)\)/);
  const bracketMatch = title.match(/\[([^\[\]]+)\]/);
  const colonMatch = title.match(/[:–—\-]\s*([A-Za-z0-9_,\s&+/]+)$/);

  const candidateSegments = [];
  if (withMatch && withMatch[1]) candidateSegments.push({ text: withMatch[1], explicitWith: true });
  if (parenMatch && parenMatch[1]) candidateSegments.push({ text: parenMatch[1], explicitWith: false });
  if (bracketMatch && bracketMatch[1]) candidateSegments.push({ text: bracketMatch[1], explicitWith: false });
  if (colonMatch && colonMatch[1]) candidateSegments.push({ text: colonMatch[1], explicitWith: false });
  if (candidateSegments.length === 0) candidateSegments.push({ text: title, explicitWith: false });

  const foundPlayers = [];
  const seenKeys = new Set();

  function isDisallowedWord(w) {
    return /^(?:today|tomorrow|tonight|monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tue|wed|thu|fri|sat|sun|tennis|match|court|courts|spots?|slots?|open|free|need|looking|players?|pm|am|at|in|on|for|the|and|or|a|an|yes|no)$/i.test(w);
  }

  function tryMatch(rawToken, explicitWith) {
    let token = rawToken.replace(/^[#@]+/, '').trim();
    token = token.replace(/[:.,;!?-]+$/, '').trim();
    if (!token || token.length < 2) return null;
    if (isDisallowedWord(token)) return null;

    let match = namesStore.findIdByNameOrAlias(token, chatId);
    if (match) {
      return { id: match.id, name: match.entry.name || match.entry.fullName || token };
    }

    const words = token.split(/\s+/);
    while (words.length > 1) {
      words.pop();
      const sub = words.join(' ').replace(/[:.,;!?-]+$/, '').trim();
      if (sub && sub.length >= 2 && !isDisallowedWord(sub)) {
        match = namesStore.findIdByNameOrAlias(sub, chatId);
        if (match) return { id: match.id, name: match.entry.name || match.entry.fullName || sub };
      }
    }

    if (explicitWith && /^[A-Z][a-zA-Z0-9_\s.-]*$/.test(token) && !isDisallowedWord(token)) {
      return { id: token.toLowerCase(), name: token };
    }

    return null;
  }

  for (const { text, explicitWith } of candidateSegments) {
    const tokens = text
      .split(/\s*(?:,|&|\band\b|\+|\/)\s*/i)
      .map((t) => t.trim())
      .filter(Boolean);

    for (const token of tokens) {
      const match = tryMatch(token, explicitWith);
      if (match) {
        const key = match.id || match.name.toLowerCase();
        if (!seenKeys.has(key)) {
          seenKeys.add(key);
          foundPlayers.push(match.name);
        }
      }
    }
  }

  return foundPlayers;
}

function resolveManualPollPlayers(targetPollState, currentPlayers) {
  const creatorName = targetPollState.creator?.name || (targetPollState.creator?.jid ? nameFor(targetPollState.creator.jid) : 'Creator');
  const options = targetPollState.options || [];
  const firstSlotNum = getFirstSlotNumber(options);

  const isOptIn = targetPollState.type === 'opt_in' || targetPollState.size === null || options.some((o) => /^yes$/i.test(o.trim()));
  if (isOptIn) {
    const players = [];
    for (const p of currentPlayers) {
      if (!players.some((existing) => ratings.keyFor(existing) === ratings.keyFor(p))) {
        players.push(p);
      }
    }
    return { players, addedCreator: false, addedExtra: [], addedFromLabel: [], addedFromValidCount: [] };
  }

  // Pre-filled / named players from title or state
  let named = Array.isArray(targetPollState.namedPlayers) && targetPollState.namedPlayers.length > 0
    ? [...targetPollState.namedPlayers]
    : extractNamedPlayersFromTitle(targetPollState.name || targetPollState.title, creatorName, targetPollState.remoteJid);

  const creatorKey = ratings.keyFor(creatorName);
  const creatorLid = targetPollState.creator?.jid ? namesStore.resolveCanonicalId(targetPollState.creator.jid) : null;
  const isCreatorNamed = named.some((p) => {
    if (ratings.keyFor(p) === creatorKey) return true;
    if (creatorLid) {
      const match = namesStore.findIdByNameOrAlias(p, targetPollState.remoteJid);
      if (match && match.id === creatorLid) return true;
    }
    return false;
  });

  const prefilled = [...named];
  if (!isCreatorNamed && !GENERIC_NAMES.has(creatorKey) && named.length > 0) {
    prefilled.unshift(creatorName);
  }

  const players = [];
  const addedFromLabel = [];
  const addedFromValidCount = [];

  if (firstSlotNum && firstSlotNum > 1) {
    const leadingNeeded = firstSlotNum - 1;
    for (let i = 0; i < leadingNeeded; i++) {
      if (i < prefilled.length) {
        const pName = prefilled[i];
        if (!players.some((existing) => ratings.keyFor(existing) === ratings.keyFor(pName))) {
          players.push(pName);
          addedFromLabel.push(pName);
        }
      } else {
        const name = addNextCreatorPlayer(players, creatorName);
        addedFromLabel.push(name);
      }
    }
  } else if (prefilled.length > 0 && (options.length < 4 || firstSlotNum === null)) {
    for (const pName of prefilled) {
      if (!players.some((existing) => ratings.keyFor(existing) === ratings.keyFor(pName))) {
        players.push(pName);
        addedFromLabel.push(pName);
      }
    }
  }

  for (const p of currentPlayers) {
    if (!players.some((existing) => ratings.keyFor(existing) === ratings.keyFor(p))) {
      players.push(p);
    }
  }

  const isFirstVoteLabelSlot1 = firstSlotNum === 1;
  const allSlotsFilled = options.length > 0 && currentPlayers.length >= options.length;

  if (isFirstVoteLabelSlot1 && allSlotsFilled && !isValidPlayerCount(players.length)) {
    const targetCount = getNextValidPlayerCount(players.length);
    while (players.length < targetCount) {
      const name = addNextCreatorPlayer(players, creatorName);
      addedFromValidCount.push(name);
    }
  }

  const addedExtra = [...addedFromLabel, ...addedFromValidCount];
  const addedCreator = addedExtra.some((p) => ratings.keyFor(p) === creatorKey);
  return { players, addedCreator, addedExtra, addedFromLabel, addedFromValidCount };
}

function resolveFixedPollRoster(pollState, aggregated = [], bySlot = null) {
  const options = (pollState.options && pollState.options.length > 0)
    ? pollState.options
    : (Array.isArray(aggregated) ? aggregated.map((o) => o.name) : []);
  const slotMap = bySlot || new Map((aggregated || []).map((o) => [o.name, o.voters && o.voters.length > 0 ? o.voters[0] : null]));

  const prebookedSlotMap = new Map();
  if (Array.isArray(pollState.prebookedPlayers)) {
    for (const p of pollState.prebookedPlayers) {
      if (typeof p === 'string') {
        prebookedSlotMap.set(`${p}'s Spot`, p);
      } else if (p && typeof p === 'object') {
        const sName = p.slotName || p.slot || `${p.defaultPlayer || p.name}'s Spot`;
        const pName = p.defaultPlayer || p.name || p.canonicalName;
        if (sName && pName) prebookedSlotMap.set(sName, pName);
      }
    }
  }

  const hasPrebooked = prebookedSlotMap.size > 0;
  const isMultiPollSecondary = Boolean(pollState.parentPollId && pollState.partNumber && pollState.partNumber > 1);
  const firstSlotNum = hasPrebooked ? null : getFirstSlotNumber(options);
  const leadingSpots = (!hasPrebooked && !isMultiPollSecondary && firstSlotNum && firstSlotNum > 1)
    ? (firstSlotNum - 1)
    : (!hasPrebooked && !isMultiPollSecondary && pollState.creator ? 1 : 0);
  const creatorName = pollState.creator?.name || (pollState.creator?.jid ? nameFor(pollState.creator.jid) : 'Creator');

  const allPlayers = [];
  if (leadingSpots > 0) {
    const named = Array.isArray(pollState.namedPlayers) && pollState.namedPlayers.length > 0
      ? [...pollState.namedPlayers]
      : extractNamedPlayersFromTitle(pollState.name || pollState.title, creatorName, pollState.remoteJid);
    const creatorKey = ratings.keyFor(creatorName);
    const prefilled = [...named];
    if (!prefilled.some((p) => ratings.keyFor(p) === creatorKey) && !GENERIC_NAMES.has(creatorKey) && named.length > 0) {
      prefilled.unshift(creatorName);
    }
    for (let i = 0; i < leadingSpots; i++) {
      if (i < prefilled.length) {
        allPlayers.push(prefilled[i]);
      } else {
        addNextCreatorPlayer(allPlayers, creatorName);
      }
    }
  }

  let filledCount = leadingSpots;
  const totalSlotsCount = leadingSpots + options.length;

  const voterEntries = [];
  if (pollState.slotCheck === false && !bySlot) {
    for (const opt of options) {
      const aggOpt = (aggregated || []).find((o) => o.name === opt);
      const voters = aggOpt && Array.isArray(aggOpt.voters) ? aggOpt.voters : [];
      if (voters.length > 0) {
        for (const voterJid of voters) {
          const playerName = nameFor(voterJid);
          const ts = getVoteTimestamp(pollState, voterJid);
          const arrIdx = getVoteArrivalIndex(pollState, voterJid);
          voterEntries.push({ opt, voterJid, playerName, ts, arrIdx });
        }
      } else if (prebookedSlotMap.has(opt)) {
        const defaultPlayer = prebookedSlotMap.get(opt);
        allPlayers.push(defaultPlayer);
        filledCount++;
      }
    }
  } else {
    for (const opt of options) {
      const voterJid = slotMap.get(opt);
      if (voterJid) {
        const playerName = nameFor(voterJid);
        const ts = getVoteTimestamp(pollState, voterJid);
        const arrIdx = getVoteArrivalIndex(pollState, voterJid);
        voterEntries.push({ opt, voterJid, playerName, ts, arrIdx });
      } else if (prebookedSlotMap.has(opt)) {
        const defaultPlayer = prebookedSlotMap.get(opt);
        allPlayers.push(defaultPlayer);
        filledCount++;
      }
    }
  }

  if (typeof pollState.slotLimit === "number" && pollState.slotLimit > 0) {
    voterEntries.sort((a, b) => {
      if (a.ts && b.ts && a.ts !== b.ts) return a.ts - b.ts;
      return a.arrIdx - b.arrIdx;
    });
  }

  for (const v of voterEntries) {
    allPlayers.push(v.playerName);
    filledCount++;
  }

  const effectiveLimit = (typeof pollState.slotLimit === 'number' && pollState.slotLimit > 0)
    ? pollState.slotLimit
    : totalSlotsCount;

  const players = allPlayers.slice(0, effectiveLimit);
  const excessPlayers = allPlayers.slice(effectiveLimit);
  const effFilledCount = Math.min(filledCount, effectiveLimit);
  const effTotalSlotsCount = effectiveLimit;
  const isAllFilled = (filledCount >= effectiveLimit);

  return {
    players,
    allPlayers,
    excessPlayers,
    filledCount: effFilledCount,
    totalSlotsCount: effTotalSlotsCount,
    naturalTotalSlots: totalSlotsCount,
    isAllFilled,
    prebookedSlotMap,
    voterEntries
  };
}

/**
 * Resolves rosters for each time slot in a multi-time poll.
 */
function resolveMultiTimePollRoster(pollState, aggregated = []) {
  const timeSlots = Array.isArray(pollState?.timeSlots) ? pollState.timeSlots : [];
  const multiSessionMode = (pollState?.multiVote === false) ? "single_session" : (pollState?.multiSessionMode || "single_session");

  // Build map of option label -> list of voter JIDs
  const optVotersMap = new Map();
  for (const o of (aggregated || [])) {
    if (o && o.name) {
      optVotersMap.set(o.name.trim(), Array.isArray(o.voters) ? o.voters : []);
    }
  }

  // First pass: collect players placed in already-resolved sessions if single_session mode is enabled
  const lockedPlayerKeys = new Set();
  if (multiSessionMode === "single_session") {
    for (const slot of timeSlots) {
      if ((slot.status === "resolved" || slot.matchupsGenerated) && Array.isArray(slot.lastPlayers)) {
        for (const p of slot.lastPlayers) {
          lockedPlayerKeys.add(ratings.keyFor(p));
        }
      }
    }
  }

  const slotRosters = [];
  for (let idx = 0; idx < timeSlots.length; idx++) {
    const slot = timeSlots[idx];
    const optName = (slot.optionLabel || slot.label || "").trim();
    let rawVoters = optVotersMap.get(optName);
    if (!rawVoters) {
      // Fallback: match by prefix if label was updated
      for (const [k, v] of optVotersMap.entries()) {
        if (k === optName || (slot.label && k.startsWith(slot.label))) {
          rawVoters = v;
          break;
        }
      }
    }
    rawVoters = rawVoters || [];

    const allPlayers = [];
    const seenKeys = new Set();

    // 1. Pre-seeded players (when includePrebookedSpots is enabled for this time slot)
    const preseeded = Array.isArray(slot.preseededPlayers) ? slot.preseededPlayers : [];
    for (const ps of preseeded) {
      const pName = typeof ps === "string" ? ps : (ps.defaultPlayer || ps.name || ps.fullName);
      if (!pName) continue;
      const pKey = ratings.keyFor(pName);
      if (multiSessionMode === "single_session" && slot.status !== "resolved" && lockedPlayerKeys.has(pKey)) {
        continue;
      }
      if (!seenKeys.has(pKey)) {
        seenKeys.add(pKey);
        allPlayers.push(pName);
      }
    }

    // 2. Sort voters by vote timestamp & arrival index
    const voterEntries = [];
    for (const voterJid of rawVoters) {
      const playerName = nameFor(voterJid);
      const ts = getVoteTimestamp(pollState, voterJid);
      const arrIdx = getVoteArrivalIndex(pollState, voterJid);
      voterEntries.push({ voterJid, playerName, ts, arrIdx });
    }
    voterEntries.sort((a, b) => {
      if (a.ts && b.ts && a.ts !== b.ts) return a.ts - b.ts;
      return a.arrIdx - b.arrIdx;
    });

    const activeVoterEntries = [];
    const skippedForOtherSession = [];
    for (const ve of voterEntries) {
      const pKey = ratings.keyFor(ve.playerName);
      if (multiSessionMode === "single_session" && slot.status !== "resolved" && lockedPlayerKeys.has(pKey)) {
        if (!skippedForOtherSession.includes(ve.playerName)) {
          skippedForOtherSession.push(ve.playerName);
        }
        continue;
      }
      if (!seenKeys.has(pKey)) {
        seenKeys.add(pKey);
        allPlayers.push(ve.playerName);
        activeVoterEntries.push(ve);
      }
    }

    const slotLimit = (typeof slot.slotLimit === "number" && slot.slotLimit > 0)
      ? slot.slotLimit
      : ((typeof slot.size === "number" && slot.size > 0) ? slot.size : null);

    const players = slotLimit !== null ? allPlayers.slice(0, slotLimit) : [...allPlayers];
    const excessPlayers = slotLimit !== null ? allPlayers.slice(slotLimit) : [];
    const excessVoterEntries = slotLimit !== null
      ? activeVoterEntries.slice(Math.max(0, slotLimit - preseeded.length))
      : [];
    const filledCount = players.length;
    const isAllFilled = slotLimit !== null ? (filledCount >= slotLimit) : false;

    if (multiSessionMode === "single_session" && isAllFilled && slot.status !== "resolved") {
      for (const p of players) {
        lockedPlayerKeys.add(ratings.keyFor(p));
      }
    }

    slotRosters.push({
      slotIndex: idx,
      slot,
      players,
      allPlayers,
      preseededPlayers: preseeded.map((ps) => typeof ps === "string" ? ps : (ps.defaultPlayer || ps.name || ps.fullName)).filter(Boolean),
      skippedForOtherSession,
      excessPlayers,
      excessVoterEntries,
      filledCount,
      slotLimit,
      isAllFilled,
      voterEntries: activeVoterEntries
    });
  }

  return slotRosters;
}

function getPollVoters(pollId, pollState, mePn, messageStore) {
  let pollCreationMessage = messageStore ? messageStore.get(storeKey(pollState.remoteJid, pollId)) : null;
  if (!pollCreationMessage && messageStore) {
    for (const [k, v] of messageStore.entries()) {
      if (k.endsWith(`:${pollId}`)) {
        pollCreationMessage = v;
        break;
      }
    }
  }

  const merged = [...(pollState.voteBuffer ? pollState.voteBuffer.values() : [])].map((u) => ({
    ...u,
    vote: normalizeVotePayload(u.vote)
  }));

  let aggregated = [];
  if (pollCreationMessage) {
    try {
      const rawMsg = pollCreationMessage.message || pollCreationMessage;
      const normalizedMsg = (typeof normalizeMessageContent === 'function' ? normalizeMessageContent(rawMsg) : null) || rawMsg;
      aggregated = getAggregateVotesInPollMessage(
        {
          message: normalizedMsg,
          pollUpdates: merged
        },
        mePn
      );
    } catch (err) {
      console.error(`[poll] getAggregateVotesInPollMessage failed for ${pollId}:`, err.message);
    }
  }

  const yesOption = aggregated.find((o) => /^yes$/i.test(o.name.trim()));
  const noOption = aggregated.find((o) => /^no$/i.test(o.name.trim()));

  let interestedPlayers = [];
  if (pollState.type === 'opt_in' || yesOption) {
    const yesVoters = yesOption ? yesOption.voters : [];
    interestedPlayers = yesVoters.map((v) => nameFor(v));
  } else if (aggregated.length > 0) {
    for (const opt of aggregated) {
      if (/^(no|out|can't play|cannot play)$/i.test(opt.name.trim())) continue;
      for (const v of opt.voters) {
        const name = nameFor(v);
        if (!interestedPlayers.includes(name)) interestedPlayers.push(name);
      }
    }
  }

  if (interestedPlayers.length === 0 && pollState.voteBuffer && pollState.voteBuffer.size > 0 && !yesOption) {
    for (const voterJid of pollState.voteBuffer.keys()) {
      const name = nameFor(voterJid);
      if (!interestedPlayers.includes(name)) interestedPlayers.push(name);
    }
  }

  return { aggregated, interestedPlayers, yesOption, noOption };
}

function isUserInPoll(pollState, userJid, userName) {
  if (!pollState) return false;

  if (pollState.creator) {
    if (isSameUser(pollState.creator.jid, userJid, pollState.creator.name, userName)) {
      return true;
    }
  }

  if (pollState.voteBuffer && pollState.voteBuffer instanceof Map) {
    for (const voterJid of pollState.voteBuffer.keys()) {
      const voterName = nameFor(voterJid);
      if (isSameUser(voterJid, userJid, voterName, userName)) {
        return true;
      }
    }
  }

  if (Array.isArray(pollState.prebookedPlayers)) {
    const userKey = ratings.keyFor(userName);
    const resolvedName = userJid ? nameFor(userJid) : null;
    const resolvedKey = resolvedName ? ratings.keyFor(resolvedName) : null;

    for (const pb of pollState.prebookedPlayers) {
      const pbName = typeof pb === 'string' ? pb : (pb.defaultPlayer || pb.name || pb.canonicalName);
      const pbFullName = typeof pb === 'object' ? pb.fullName : null;
      const pbKey = ratings.keyFor(pbName);
      const pbFullKey = pbFullName ? ratings.keyFor(pbFullName) : null;

      if ((userKey && (userKey === pbKey || userKey === pbFullKey)) ||
          (resolvedKey && (resolvedKey === pbKey || resolvedKey === pbFullKey))) {
        return true;
      }
    }
  }

  if (Array.isArray(pollState.lastPlayers)) {
    const userKey = ratings.keyFor(userName);
    const resolvedName = userJid ? nameFor(userJid) : null;
    const resolvedKey = resolvedName ? ratings.keyFor(resolvedName) : null;

    for (const p of pollState.lastPlayers) {
      const pKey = ratings.keyFor(p);
      if (GENERIC_NAMES.has(pKey)) continue;
      if (userKey && !GENERIC_NAMES.has(userKey) && pKey === userKey) return true;
      if (resolvedKey && !GENERIC_NAMES.has(resolvedKey) && pKey === resolvedKey) return true;
    }
  }

  return false;
}

function normalizeVotePayload(vote) {
  if (!vote) return vote;
  if (Array.isArray(vote.selectedOptions)) {
    return {
      ...vote,
      selectedOptions: vote.selectedOptions.map((opt) => {
        if (Buffer.isBuffer(opt)) return opt;
        if (opt && opt.__type === 'Uint8Array' && opt.base64) return Buffer.from(opt.base64, 'base64');
        if (typeof opt === 'string') return Buffer.from(opt, 'base64');
        if (opt instanceof Uint8Array || Array.isArray(opt)) return Buffer.from(opt);
        if (opt && opt.type === 'Buffer' && Array.isArray(opt.data)) return Buffer.from(opt.data);
        return Buffer.from(opt);
      })
    };
  }
  return vote;
}

async function deletePollFromWhatsApp(sock, remoteJid, pollId) {
  if (!sock || !remoteJid || !pollId) return;
  try {
    const key = {
      remoteJid,
      fromMe: true,
      id: pollId
    };
    await sock.sendMessage(remoteJid, { delete: key });
    console.log(`[poll] Deleted poll message ${pollId} from WhatsApp chat ${remoteJid}`);
  } catch (err) {
    console.error(`[poll] Failed to delete poll message ${pollId} from WhatsApp:`, err.message);
  }
}

function getPollDayWord(pollState) {
  if (!pollState) return null;
  if (pollState.dayWord && typeof pollState.dayWord === 'string') {
    return pollState.dayWord;
  }
  const sources = [pollState.when, pollState.name];
  for (const src of sources) {
    if (!src || typeof src !== 'string') continue;
    const m = src.match(/\b(today|tonight|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tue|wed|thu|fri|sat|sun)\b/i);
    if (m) return m[1];
  }
  return null;
}

function pollTitleIndicatesGame(titleOrPoll) {
  let title = "";
  if (!titleOrPoll) return false;
  if (typeof titleOrPoll === "object") {
    title = titleOrPoll.name || titleOrPoll.title || "";
  } else {
    title = String(titleOrPoll);
  }
  const clean = title.trim();
  if (!clean) return false;
  if (/[\u{1F3BE}\u{1F3D3}]/u.test(clean) || clean.includes("🎾") || clean.includes("🏓")) {
    return true;
  }
  return /\b(tennis|match|matches|court|courts|singles|doubles|play|playing|players|player|game|games|drill|drills|session|hit|hitting|scvcc|pickleball|pb|racquet|racket|tournament|ball)\b/i.test(clean);
}

function formatLineupGenDesc(mode, leadTimeMins = 30) {
  if (mode === "fallback") {
    const leadStr = formatLookAround(leadTimeMins) || `${leadTimeMins} mins`;
    return `Fallback if no manual lineups posted (${leadStr} before play time)`;
  }
  if (mode === "none") {
    return "None (manual only)";
  }
  return "Filled";
}

function shouldAutoGenerateLineupOnFill(pollState, now = Date.now()) {
  if (!pollState) return false;
  const mode = pollState.lineupGeneration || (pollState.noMatchups ? "none" : "filled");
  if (mode === "none") return false;
  if (mode === "fallback") {
    if (pollState.manualLineupPosted) return false;
    if (!pollState.playAt || pollState.playAt === "unknown") return false;
    const playAtMs = new Date(pollState.playAt).getTime();
    if (Number.isNaN(playAtMs)) return false;
    const leadTimeMins = typeof pollState.lineupLeadTime === "number" && pollState.lineupLeadTime > 0
      ? pollState.lineupLeadTime
      : 30;
    const deadlineMs = playAtMs - (leadTimeMins * 60 * 1000);
    return now >= deadlineMs && now < playAtMs;
  }
  return true; // "filled"
}

function isAutoCreatedPoll(pollState) {
  if (!pollState) return false;
  if (pollState.isAuto || pollState.isRecurring || pollState.isAutoCreated || pollState.autoCreated) return true;
  if (Array.isArray(pollState.prebookedCourts) && pollState.prebookedCourts.length > 0) return true;
  if (Array.isArray(pollState.prebookedPlayers) && pollState.prebookedPlayers.length > 0) return true;
  if (pollState.scheduleId || pollState.recurringScheduleId) return true;
  return false;
}

function findSpecificPoll(target, activePolls, recurringPolls) {
  if (!target) return null;
  const clean = String(target).replace(/^["']|["']$/g, '').trim().toLowerCase();

  for (const [id, state] of activePolls.entries()) {
    if (id.toLowerCase() === clean) return { pollId: id, pollState: state };
  }

  for (const [id, state] of activePolls.entries()) {
    const sid = getPollScheduleId(state, recurringPolls);
    if ((sid && sid.toLowerCase() === clean) || (state.scheduleId && state.scheduleId.toLowerCase() === clean)) {
      return { pollId: id, pollState: state };
    }
  }

  for (const [id, state] of activePolls.entries()) {
    const pName = (state.name || '').toLowerCase();
    const pWhen = (state.when || '').toLowerCase();
    if (pName.includes(clean) || pWhen.includes(clean) || clean.includes(pWhen)) {
      return { pollId: id, pollState: state };
    }
  }

  return null;
}

function getPollScheduleId(pollState, recurringPolls) {
  if (!pollState) return null;
  if (pollState.scheduleId) return pollState.scheduleId;
  if (!pollState.isRecurring) return null;
  if (recurringPolls) {
    for (const [key, sched] of recurringPolls.entries()) {
      if (sched.remoteJid && pollState.remoteJid && sched.remoteJid === pollState.remoteJid) {
        return sched.id || sched.scheduleId || key;
      }
    }
    if (recurringPolls.size === 1) {
      const s = [...recurringPolls.values()][0];
      return s.id || s.scheduleId || [...recurringPolls.keys()][0];
    }
  }
  return null;
}

function isDayOrDateStr(str) {
  if (!str) return false;
  const s = String(str).toLowerCase().trim();
  if (/^(?:today|tonight|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tue|wed|thu|fri|sat|sun|next|all)$/i.test(s)) return true;
  if (/^\d{1,2}\/\d{1,2}(?:\/\d{2,4})?$/.test(s)) return true;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return true;
  return false;
}

function formatMatchHeaderTime(pollState) {
  if (!pollState) return '';
  if (!pollState.playAt) return pollState.when || '';

  const playAt = new Date(pollState.playAt);
  if (Number.isNaN(playAt.getTime())) return pollState.when || '';

  const playParts = getSanJoseParts(playAt);
  const nowParts = getSanJoseParts(getSanJoseNow());

  const timeFormatted = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true
  }).format(playAt).replace(/\s+/g, '').toLowerCase();

  const weekdayName = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles',
    weekday: 'long'
  }).format(playAt);

  if (playParts.year === nowParts.year && playParts.month === nowParts.month && playParts.day === nowParts.day) {
    if (pollState.when && !/^(?:tomorrow|tonight)\b/i.test(pollState.when.trim())) {
      return pollState.when;
    }
    return `${weekdayName} ${timeFormatted}`;
  }

  const tomorrowTemp = new Date(Date.UTC(nowParts.year, nowParts.month, nowParts.day + 1));
  if (playParts.year === tomorrowTemp.getUTCFullYear() && playParts.month === tomorrowTemp.getUTCMonth() && playParts.day === tomorrowTemp.getUTCDate()) {
    if (pollState.when && !/^(?:today|tonight)\b/i.test(pollState.when.trim())) {
      return pollState.when;
    }
    return `Tomorrow ${timeFormatted} (${weekdayName})`;
  }

  if (pollState.when && !/^(?:today|tomorrow|tonight)\b/i.test(pollState.when.trim())) {
    return pollState.when;
  }
  return `${weekdayName} ${timeFormatted}`;
}

function getPollPlayTime(pollState) {
  if (pollState?.playAt) {
    const t = new Date(pollState.playAt).getTime();
    if (!Number.isNaN(t)) return t;
  }
  if (pollState?.createdAt) {
    const t = new Date(pollState.createdAt).getTime();
    if (!Number.isNaN(t)) return t;
  }
  return 0;
}

function getVoteTimestamp(pollState, voterJid) {
  if (!pollState?.voteBuffer) return 0;
  const norm = jidNormalizedUser(voterJid);
  const canonicalId = namesStore.resolveCanonicalId(norm);
  const entry = (norm && pollState.voteBuffer.get(norm)) ||
                (canonicalId && pollState.voteBuffer.get(canonicalId)) ||
                pollState.voteBuffer.get(voterJid);
  if (!entry) return 0;
  const rawTs = entry.senderTimestampMs || entry.timestamp || entry.pollUpdateMessageKey?.timestamp;
  if (!rawTs) return 0;
  if (typeof rawTs === 'number') return rawTs;
  if (typeof rawTs === 'string') return parseInt(rawTs, 10) || 0;
  if (typeof rawTs?.toNumber === 'function') return rawTs.toNumber();
  if (typeof rawTs === 'bigint') return Number(rawTs);
  return Number(rawTs) || 0;
}

function getVoteArrivalIndex(pollState, voterJid) {
  if (!pollState?.voteBuffer) return 0;
  const norm = jidNormalizedUser(voterJid);
  const canonicalId = namesStore.resolveCanonicalId(norm);
  let idx = 0;
  for (const k of pollState.voteBuffer.keys()) {
    if (k === norm || k === canonicalId || k === voterJid) return idx;
    idx++;
  }
  return 999999;
}

/**
 * Helper to determine the slot number for an option label (e.g. "Player 9" -> 9).
 */
function getSlotNumberForOption(optName, index, pollState = {}) {
  if (optName) {
    const match = String(optName).match(/\b(\d+)\b/);
    if (match) {
      return parseInt(match[1], 10);
    }
  }
  const leadingSpots = (!pollState?.prebookedPlayers?.length && pollState?.creator) ? 1 : 0;
  return (typeof index === 'number' ? index : 0) + 1 + leadingSpots;
}

/**
 * Checks for votes on invalid slots (beyond pollState.slotLimit) and notifies the group
 * tagging the voter and quoting the original poll.
 */
async function checkAndNotifyInvalidSlotVotes(sock, pollId, pollState, aggregated, context = {}) {
  if (!pollState || !pollState.slotLimit || typeof pollState.slotLimit !== 'number') {
    return false;
  }
  if (!Array.isArray(aggregated)) {
    return false;
  }

  const isOptIn = pollState.type === 'opt_in' || pollState.options?.some((o) => /^yes$/i.test(o.trim()));
  if (isOptIn) return false;

  const validLimit = pollState.slotLimit;
  if (!Array.isArray(pollState.invalidSlotVotesNotified)) {
    pollState.invalidSlotVotesNotified = [];
  }

  // Collect all active voters who voted on any slot in aggregated
  const voterEntries = [];
  for (let idx = 0; idx < aggregated.length; idx++) {
    const opt = aggregated[idx];
    if (!opt || !Array.isArray(opt.voters) || opt.voters.length === 0) continue;
    if (/^(no|out|can't play|cannot play)$/i.test(opt.name.trim())) continue;

    for (const voterJid of opt.voters) {
      const ts = getVoteTimestamp(pollState, voterJid);
      const arrIdx = getVoteArrivalIndex(pollState, voterJid);
      const voterName = nameFor(voterJid);
      voterEntries.push({ opt: opt.name.trim(), voterJid, voterName, ts, arrIdx });
    }
  }

  // Sort voters by arrival time (first-come, first-served)
  voterEntries.sort((a, b) => {
    if (a.ts && b.ts && a.ts !== b.ts) return a.ts - b.ts;
    return a.arrIdx - b.arrIdx;
  });

  // Calculate occupied spots from creator / prebooked players
  const options = (pollState.options && pollState.options.length > 0)
    ? pollState.options
    : aggregated.map((o) => o.name);
  const firstSlotNum = getFirstSlotNumber(options);
  const leadingSpots = (!pollState.prebookedPlayers?.length && firstSlotNum && firstSlotNum > 1)
    ? (firstSlotNum - 1)
    : (!pollState.prebookedPlayers?.length && pollState.creator ? 1 : 0);
  const prebookedCount = Array.isArray(pollState.prebookedPlayers) ? pollState.prebookedPlayers.length : 0;
  const nonVoterOccupied = leadingSpots + prebookedCount;

  const availableVoterSpots = Math.max(0, validLimit - nonVoterOccupied);

  // If total voters do not exceed available voter openings, NO ONE is warned!
  if (voterEntries.length <= availableVoterSpots) {
    return false;
  }

  // Voters beyond availableVoterSpots exceed available openings
  const excessVoters = voterEntries.slice(availableVoterSpots);
  if (excessVoters.length === 0) {
    return false;
  }

  let pollCreationMessage = context.messageStore ? context.messageStore.get(storeKey(pollState.remoteJid, pollId)) : null;
  if (!pollCreationMessage && context.messageStore) {
    for (const key of context.messageStore.keys()) {
      if (key.endsWith(':' + pollId)) {
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

  let newlyNotified = false;

  for (const v of excessVoters) {
    const notifyKey = `${v.voterJid}:${validLimit}`;
    if (pollState.invalidSlotVotesNotified.includes(notifyKey)) {
      continue;
    }

    const norm = jidNormalizedUser(v.voterJid);
    const pn = namesStore.getPnByLid(norm) || (norm?.endsWith('@s.whatsapp.net') ? norm : null);
    const lid = namesStore.resolveCanonicalId(norm) || (norm?.endsWith('@lid') ? norm : null);
    const voterName = v.voterName || nameFor(v.voterJid);

    const phoneDigits = (pn || norm || lid || v.voterJid).split('@')[0].replace(/\D/g, '');
    const tagStr = phoneDigits ? `@${phoneDigits}` : `@${voterName}`;

    const voterMentions = [];
    if (pn) voterMentions.push(pn);
    if (lid) voterMentions.push(lid);
    if (norm) voterMentions.push(norm);
    voterMentions.push(v.voterJid);
    const uniqueMentions = [...new Set(voterMentions.filter(Boolean))];

    const warnText = `⚠️ ${tagStr}, all *${validLimit} voting slots* are already filled for this match poll. Your vote exceeds the available openings and will not be considered.`;

    console.log(`[poll] Sending excess vote notification in ${pollState.remoteJid} for poll ${pollId} to ${voterName} (${tagStr})`);
    if (sock && pollState.remoteJid) {
      try {
        await sendMessageAndRecord(sock, pollState.remoteJid, {
          text: warnText,
          mentions: uniqueMentions
        }, { quoted: quotedMsg });
      } catch (sendErr) {
        console.error(`[poll] Failed to send excess vote notification for poll ${pollId}:`, sendErr.message);
      }
    }

    pollState.invalidSlotVotesNotified.push(notifyKey);
    newlyNotified = true;
  }

  if (newlyNotified && context.persistPolls) {
    context.persistPolls();
  }

  return newlyNotified;
}

module.exports = {
  TRIGGER_PREFIX,
  GENERIC_NAMES,
  POLL_EXPIRY_GRACE_DAYS,
  POLL_REMINDER_HOURS,
  POWERS_OF_2_REMINDER_HOURS,
  MAX_POLL_REMINDERS,
  SIMULATION_PREFIX,
  TENTATIVE_SLOT_TAG,
  hasSimulationPrefix,
  storeKey,
  isCourtSkipped,
  nameFor,
  capitalize,
  hasTimeSpecifiedInTitle,
  isMatchSchedulingPoll,
  interpretManualPollWithLLM,
  isValidPlayerCount,
  getNextValidPlayerCount,
  partitionMatchSlots,
  getFirstSlotNumber,
  addNextCreatorPlayer,
  extractNamedPlayersFromTitle,
  resolveManualPollPlayers,
  resolveFixedPollRoster,
  resolveMultiTimePollRoster,
  getPollVoters,
  isUserInPoll,
  normalizeVotePayload,
  deletePollFromWhatsApp,
  getPollDayWord,
  pollTitleIndicatesGame,
  formatLineupGenDesc,
  shouldAutoGenerateLineupOnFill,
  isAutoCreatedPoll,
  findSpecificPoll,
  getPollScheduleId,
  isDayOrDateStr,
  formatMatchHeaderTime,
  getPollPlayTime,
  getVoteTimestamp,
  getVoteArrivalIndex,
  getSlotNumberForOption,
  checkAndNotifyInvalidSlotVotes
};
