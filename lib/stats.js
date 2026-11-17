/**
 * Simple JSON-file persistence for the tennis group's stats (availability, leaderboards, match results).
 * Good enough for a single-process bot with light traffic -- not built for
 * concurrent writers, but that's not a concern here.
 *
 * Leaderboard rules:
 *   - Scores are kept for a rolling 2-week window (14 days); older matches are automatically pruned.
 *   - Leaderboard standings automatically reset at the beginning of each calendar month (in San Jose / Pacific time).
 *   - Matches can be queried by recent count, specific day, or date range.
 *   - Scores can be modified or deleted, cleanly reverting player rating impacts.
 */

const fs = require('fs');
const path = require('path');

const { DATA_DIR } = require('./paths');
const STATS_FILE = path.join(DATA_DIR, 'stats.json');

const TWO_WEEKS_MS = 14 * 24 * 60 * 60 * 1000;

let namesStore = null;
try {
  namesStore = require('./names');
} catch (_) {}

let ratings = null;
try {
  ratings = require('./ratings');
} catch (_) {}

let pollTime = null;
try {
  pollTime = require('./pollTime');
} catch (_) {}

function loadData() {
  if (!fs.existsSync(STATS_FILE)) {
    return { availability: [], matches: [] };
  }
  try {
    const raw = fs.readFileSync(STATS_FILE, 'utf-8');
    const parsed = JSON.parse(raw);
    return {
      availability: parsed.availability || [],
      matches: parsed.matches || []
    };
  } catch (err) {
    console.error('⚠️  Failed to read stats.json, starting fresh:', err.message);
    return { availability: [], matches: [] };
  }
}

function saveData(data) {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  fs.writeFileSync(STATS_FILE, JSON.stringify(data, null, 2));
}

function cleanPlayerName(name) {
  if (!name || typeof name !== 'string') return '';
  return name.trim();
}

function splitPlayers(side) {
  if (!side) return [];
  if (Array.isArray(side)) {
    return side.map(cleanPlayerName).filter(Boolean);
  }
  if (typeof side !== 'string') return [];
  return side
    .split(/\s*(?:&|\+|,|\band\b)\s*/i)
    .map(cleanPlayerName)
    .filter(Boolean);
}

function resolveCanonicalName(rawName) {
  if (!rawName) return '';
  const trimmed = cleanPlayerName(rawName);
  if (!trimmed) return '';
  if (namesStore && typeof namesStore.findIdByNameOrAlias === 'function') {
    const match = namesStore.findIdByNameOrAlias(trimmed);
    if (match && match.entry?.name) {
      return match.entry.name;
    }
  }
  return trimmed;
}

function generateMatchId() {
  return `m_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * Returns San Jose wall-clock parts for a given Date/timestamp.
 */
function getSjParts(date = new Date()) {
  if (pollTime && typeof pollTime.getSanJoseParts === 'function') {
    return pollTime.getSanJoseParts(date);
  }
  const d = date instanceof Date ? date : new Date(date);
  return {
    year: d.getFullYear(),
    month: d.getMonth(),
    day: d.getDate(),
    hour: d.getHours(),
    minute: d.getMinutes(),
    second: d.getSeconds()
  };
}

/**
 * Prunes expired matches older than 14 days (2 weeks).
 */
function pruneExpiredMatches(maxAgeMs = TWO_WEEKS_MS, now = Date.now()) {
  const data = loadData();
  const cutoff = now - maxAgeMs;
  const initialCount = data.matches.length;
  data.matches = data.matches.filter((m) => {
    const ts = m.date ? new Date(m.date).getTime() : 0;
    return Number.isFinite(ts) && ts >= cutoff;
  });
  if (data.matches.length !== initialCount) {
    saveData(data);
    console.log(`[stats] Pruned ${initialCount - data.matches.length} expired match(es) older than 14 days.`);
  }
  return initialCount - data.matches.length;
}

// ---- Availability ----

/** Add or update a player's availability entry (one active entry per player). */
function setAvailable(player, when) {
  const data = loadData();
  const existingIndex = data.availability.findIndex(
    (a) => a.player.toLowerCase() === player.toLowerCase()
  );
  const entry = { player, when, addedAt: new Date().toISOString() };
  if (existingIndex >= 0) {
    data.availability[existingIndex] = entry;
  } else {
    data.availability.push(entry);
  }
  saveData(data);
  return data.availability;
}

function removeAvailable(player) {
  const data = loadData();
  data.availability = data.availability.filter(
    (a) => a.player.toLowerCase() !== player.toLowerCase()
  );
  saveData(data);
  return data.availability;
}

function clearAvailability() {
  const data = loadData();
  data.availability = [];
  saveData(data);
}

function getAvailability() {
  return loadData().availability;
}

// ---- Match results / leaderboard ----

function recordMatch(winner, loser, score, extra = {}) {
  pruneExpiredMatches();

  const data = loadData();
  const winnersList = Array.isArray(extra.winners)
    ? extra.winners.map(cleanPlayerName).filter(Boolean)
    : (Array.isArray(winner) ? winner.map(cleanPlayerName).filter(Boolean) : splitPlayers(winner));
  const losersList = Array.isArray(extra.losers)
    ? extra.losers.map(cleanPlayerName).filter(Boolean)
    : (Array.isArray(loser) ? loser.map(cleanPlayerName).filter(Boolean) : splitPlayers(loser));

  const winnerStr = Array.isArray(winner) ? winner.join(' & ') : String(winner);
  const loserStr = Array.isArray(loser) ? loser.join(' & ') : String(loser);

  const entry = {
    id: extra.id || generateMatchId(),
    winner: winnerStr,
    loser: loserStr,
    winners: winnersList,
    losers: losersList,
    score,
    sets: extra.sets || [],
    ratingChanges: extra.ratingChanges || [],
    date: extra.date || new Date().toISOString()
  };
  if (extra.chatId) {
    entry.chatId = extra.chatId;
  }

  data.matches.push(entry);
  saveData(data);
  return data.matches;
}

/**
 * Calculates individual player rankings across recorded matches.
 * - By default, tallies matches within the current calendar month (in San Jose / Pacific time)
 *   so the leaderboard automatically resets on the 1st of each month.
 * - Set options.allTime = true to calculate all-time standings across all retained scores (last 2 weeks).
 * - Credits each individual player in singles and doubles with wins and losses.
 * - Sorted by: wins (DESC), win rate (DESC), losses (ASC), player name (ASC).
 */
function getLeaderboard(chatId = null, options = {}) {
  const now = options.now || new Date();
  const nowMs = now instanceof Date ? now.getTime() : new Date(now).getTime();
  pruneExpiredMatches(TWO_WEEKS_MS, nowMs);

  const { matches } = loadData();
  const stats = new Map(); // nameKey -> { name, wins, losses, matches, winRate }
  const nowParts = getSjParts(now);
  const currentYear = nowParts.year;
  const currentMonth = nowParts.month; // 0-indexed

  const isAllTime = options.allTime === true || options.scope === 'all';

  const getStats = (name) => {
    const canonical = resolveCanonicalName(name);
    const key = canonical.toLowerCase();
    if (!stats.has(key)) {
      stats.set(key, { name: canonical, wins: 0, losses: 0, matches: 0, winRate: 0 });
    }
    return stats.get(key);
  };

  for (const m of matches) {
    if (chatId && m.chatId && m.chatId !== chatId) {
      continue;
    }

    // Monthly calendar reset: only include matches within current calendar month
    if (!isAllTime) {
      const matchDate = m.date ? new Date(m.date) : null;
      if (matchDate && !Number.isNaN(matchDate.getTime())) {
        const mParts = getSjParts(matchDate);
        if (mParts.year !== currentYear || mParts.month !== currentMonth) {
          continue; // Prior calendar month
        }
      }
    }

    const winners = Array.isArray(m.winners) && m.winners.length > 0
      ? m.winners.map(cleanPlayerName).filter(Boolean)
      : splitPlayers(m.winner);
    const losers = Array.isArray(m.losers) && m.losers.length > 0
      ? m.losers
      : splitPlayers(m.loser);

    for (const w of winners) {
      const s = getStats(w);
      s.wins += 1;
      s.matches += 1;
    }
    for (const l of losers) {
      const s = getStats(l);
      s.losses += 1;
      s.matches += 1;
    }
  }

  for (const entry of stats.values()) {
    entry.winRate = entry.matches > 0 ? entry.wins / entry.matches : 0;
  }

  return [...stats.values()].sort((a, b) => {
    if (b.wins !== a.wins) return b.wins - a.wins;
    if (b.winRate !== a.winRate) return b.winRate - a.winRate;
    if (a.losses !== b.losses) return a.losses - b.losses;
    return a.name.localeCompare(b.name);
  });
}

function getRecentMatches(limit = 5) {
  pruneExpiredMatches();
  const { matches } = loadData();
  return matches.slice(-limit).reverse();
}

/**
 * Searches and filters match scores by date range, day, or player.
 * Matches are returned sorted newest to oldest.
 */
function getScores(filter = {}, options = {}) {
  pruneExpiredMatches();
  const { matches } = loadData();
  let list = [...matches];

  if (filter.chatId) {
    list = list.filter((m) => !m.chatId || m.chatId === filter.chatId);
  }

  if (filter.startDate) {
    const startMs = typeof filter.startDate === 'number'
      ? filter.startDate
      : new Date(filter.startDate).getTime();
    if (Number.isFinite(startMs)) {
      list = list.filter((m) => new Date(m.date).getTime() >= startMs);
    }
  }

  if (filter.endDate) {
    const endMs = typeof filter.endDate === 'number'
      ? filter.endDate
      : new Date(filter.endDate).getTime();
    if (Number.isFinite(endMs)) {
      list = list.filter((m) => new Date(m.date).getTime() <= endMs);
    }
  }

  if (filter.player) {
    const pKey = filter.player.toLowerCase().trim();
    list = list.filter((m) => {
      const allPlayers = [
        ...(Array.isArray(m.winners) ? m.winners : splitPlayers(m.winner)),
        ...(Array.isArray(m.losers) ? m.losers : splitPlayers(m.loser))
      ].map((p) => p.toLowerCase());
      return allPlayers.some((p) => p === pKey || p.includes(pKey));
    });
  }

  // Sort descending by date (most recent first)
  list.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

  if (typeof options.limit === 'number' && options.limit > 0) {
    list = list.slice(0, options.limit);
  }

  return list;
}

/**
 * Resolves a match by its unique ID (e.g. m_...) or by its 1-based index (#1, 1).
 * When using index, resolves against the list of matches sorted newest to oldest.
 */
function findMatchByIdOrIndex(identifier, matchesList = null) {
  if (!identifier) return null;
  const str = String(identifier).trim();
  const list = matchesList || loadData().matches;

  // Check if it's #N or N
  const idxMatch = str.match(/^#?(\d+)$/);
  if (idxMatch) {
    const idx = parseInt(idxMatch[1], 10);
    // Sort newest to oldest so #1 is the newest match
    const sorted = [...list].sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
    if (idx >= 1 && idx <= sorted.length) {
      return sorted[idx - 1];
    }
  }

  // Check exact ID match or end of ID match
  const cleanId = str.toLowerCase();
  return list.find((m) => {
    if (!m.id) return false;
    const mid = m.id.toLowerCase();
    return mid === cleanId || mid.endsWith(`_${cleanId}`) || mid.endsWith(cleanId);
  }) || null;
}

/**
 * Deletes a recorded match score and reverts its rating adjustments.
 */
function deleteMatch(idOrIndex) {
  const data = loadData();
  const match = findMatchByIdOrIndex(idOrIndex, data.matches);
  if (!match) return null;

  // Revert rating changes if present
  if (ratings && typeof ratings.revertResult === 'function' && Array.isArray(match.ratingChanges) && match.ratingChanges.length > 0) {
    ratings.revertResult(match.ratingChanges);
  }

  data.matches = data.matches.filter((m) => m !== match && m.id !== match.id);
  saveData(data);
  return match;
}

/**
 * Modifies an existing recorded match score.
 * Reverts previous rating changes, updates data, and applies new rating adjustments if sets/scores changed.
 */
function updateMatch(idOrIndex, updates = {}) {
  const data = loadData();
  const match = findMatchByIdOrIndex(idOrIndex, data.matches);
  if (!match) return null;

  // Revert previous rating adjustments
  if (ratings && typeof ratings.revertResult === 'function' && Array.isArray(match.ratingChanges) && match.ratingChanges.length > 0) {
    ratings.revertResult(match.ratingChanges);
  }

  if (updates.winner) match.winner = updates.winner;
  if (updates.loser) match.loser = updates.loser;
  if (Array.isArray(updates.winners)) match.winners = updates.winners;
  if (Array.isArray(updates.losers)) match.losers = updates.losers;
  if (updates.score) match.score = updates.score;
  if (Array.isArray(updates.sets)) match.sets = updates.sets;

  // Recalculate rating adjustments if sets are available
  if (ratings && typeof ratings.applyResult === 'function' && Array.isArray(match.sets) && match.sets.length > 0) {
    const { changes } = ratings.applyResult(match.winners, match.losers, match.sets);
    match.ratingChanges = changes;
  } else if (Array.isArray(updates.ratingChanges)) {
    match.ratingChanges = updates.ratingChanges;
  }

  saveData(data);
  return match;
}

/**
 * Parses user input into date filters for score lookups.
 * Supports:
 *   - "today", "yesterday"
 *   - Days of the week ("mon", "monday", "tue", etc.)
 *   - Specific date ("2026-11-15", "11/15", "Nov 15")
 *   - Date range ("11/10 to 11/15", "11/10 - 11/15", "from 11/10 to 11/15")
 *   - Periods ("last 7 days", "7d", "week", "this month", "month")
 *   - Limits ("5", "recent 10")
 */
function parseDateQuery(queryText, now = new Date()) {
  if (!queryText || typeof queryText !== 'string') {
    return { type: 'recent', limit: 10, label: 'Recent' };
  }

  const raw = queryText.trim().toLowerCase();
  if (!raw || raw === 'recent') {
    return { type: 'recent', limit: 10, label: 'Recent' };
  }

  // Simple number limit: e.g. "5", "recent 5", "limit 15"
  const limitMatch = raw.match(/^(?:recent\s+|limit\s+)?(\d+)$/);
  if (limitMatch) {
    const limit = Math.max(1, Math.min(50, parseInt(limitMatch[1], 10)));
    return { type: 'recent', limit, label: `Last ${limit}` };
  }

  const nowMs = now.getTime();
  const sj = getSjParts(now);

  const startOfDayMs = (year, month, day) => {
    const d = new Date(Date.UTC(year, month, day, 8, 0, 0, 0)); // Approx 00:00 PST (UTC-8)
    // Adjust to exact San Jose midnight
    const offsetMin = new Date(d.toLocaleString('en-US', { timeZone: 'America/Los_Angeles' })).getTimezoneOffset();
    return new Date(year, month, day, 0, 0, 0, 0).getTime();
  };

  const endOfDayMs = (year, month, day) => {
    return new Date(year, month, day, 23, 59, 59, 999).getTime();
  };

  if (raw === 'today') {
    const start = new Date(sj.year, sj.month, sj.day, 0, 0, 0, 0).getTime();
    const end = new Date(sj.year, sj.month, sj.day, 23, 59, 59, 999).getTime();
    return { type: 'day', startDate: start, endDate: end, label: 'Today' };
  }

  if (raw === 'yesterday') {
    const prevDate = new Date(sj.year, sj.month, sj.day - 1);
    const pSj = getSjParts(prevDate);
    const start = new Date(pSj.year, pSj.month, pSj.day, 0, 0, 0, 0).getTime();
    const end = new Date(pSj.year, pSj.month, pSj.day, 23, 59, 59, 999).getTime();
    return { type: 'day', startDate: start, endDate: end, label: 'Yesterday' };
  }

  if (['week', 'last 7 days', '7 days', '7d', 'past week'].includes(raw)) {
    const start = nowMs - 7 * 24 * 60 * 60 * 1000;
    return { type: 'range', startDate: start, endDate: nowMs, label: 'Last 7 Days' };
  }

  if (['this month', 'month', 'current month'].includes(raw)) {
    const start = new Date(sj.year, sj.month, 1, 0, 0, 0, 0).getTime();
    return { type: 'range', startDate: start, endDate: nowMs, label: 'This Month' };
  }

  if (['all', 'alltime', 'all time', 'everything'].includes(raw)) {
    return { type: 'all', startDate: null, endDate: null, label: 'All Retained Scores' };
  }

  // Day of week (e.g. monday, tuesday, etc.)
  const dayNames = { sun: 0, sunday: 0, mon: 1, monday: 1, tue: 2, tuesday: 2, wed: 3, wednesday: 3, thu: 4, thursday: 4, fri: 5, friday: 5, sat: 6, saturday: 6 };
  if (dayNames[raw] !== undefined) {
    const targetDay = dayNames[raw];
    const currentDay = now.getDay();
    let diffDays = (currentDay - targetDay + 7) % 7;
    if (diffDays === 0) diffDays = 0; // Today if matches, or 7 days ago
    const targetDate = new Date(sj.year, sj.month, sj.day - diffDays);
    const tSj = getSjParts(targetDate);
    const start = new Date(tSj.year, tSj.month, tSj.day, 0, 0, 0, 0).getTime();
    const end = new Date(tSj.year, tSj.month, tSj.day, 23, 59, 59, 999).getTime();
    const capDay = raw.charAt(0).toUpperCase() + raw.slice(1);
    return { type: 'day', startDate: start, endDate: end, label: capDay };
  }

  // Date range: e.g. "11/10 to 11/15", "11/10 - 11/15", "from 11/10 to 11/15"
  const rangeMatch = raw.match(/^(?:from\s+)?(.+?)\s*(?:to|–|—|-)\s*(.+)$/i);
  if (rangeMatch) {
    const d1 = parseSingleDate(rangeMatch[1], sj.year);
    const d2 = parseSingleDate(rangeMatch[2], sj.year);
    if (d1 && d2) {
      const start = new Date(d1.year, d1.month, d1.day, 0, 0, 0, 0).getTime();
      const end = new Date(d2.year, d2.month, d2.day, 23, 59, 59, 999).getTime();
      return { type: 'range', startDate: Math.min(start, end), endDate: Math.max(start, end), label: `${d1.formatted} – ${d2.formatted}` };
    }
  }

  // Single date: "2026-11-15", "11/15", "Nov 15"
  const single = parseSingleDate(raw, sj.year);
  if (single) {
    const start = new Date(single.year, single.month, single.day, 0, 0, 0, 0).getTime();
    const end = new Date(single.year, single.month, single.day, 23, 59, 59, 999).getTime();
    return { type: 'day', startDate: start, endDate: end, label: single.formatted };
  }

  // Fallback: check if it matches a player name query (e.g. "Alice")
  return { type: 'player', player: queryText.trim(), label: `Player: ${queryText.trim()}` };
}

function parseSingleDate(str, defaultYear) {
  if (!str) return null;
  const s = str.trim();

  // YYYY-MM-DD
  const isoMatch = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (isoMatch) {
    const y = parseInt(isoMatch[1], 10);
    const m = parseInt(isoMatch[2], 10) - 1;
    const d = parseInt(isoMatch[3], 10);
    return { year: y, month: m, day: d, formatted: `${m + 1}/${d}` };
  }

  // MM/DD or MM/DD/YYYY
  const slashMatch = s.match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?$/);
  if (slashMatch) {
    let y = defaultYear;
    if (slashMatch[3]) {
      const parsedY = parseInt(slashMatch[3], 10);
      y = parsedY < 100 ? 2000 + parsedY : parsedY;
    }
    const m = parseInt(slashMatch[1], 10) - 1;
    const d = parseInt(slashMatch[2], 10);
    return { year: y, month: m, day: d, formatted: `${m + 1}/${d}` };
  }

  // Month Day: e.g. "Nov 15", "November 15"
  const monthNames = {
    jan: 0, january: 0, feb: 1, february: 1, mar: 2, march: 2, apr: 3, april: 3,
    may: 4, jun: 5, june: 5, jul: 6, july: 6, aug: 7, august: 7, sep: 8, september: 8,
    oct: 9, october: 9, nov: 10, november: 10, dec: 11, december: 11
  };
  const wordMatch = s.match(/^([a-z]+)\s*(\d{1,2})(?:st|nd|rd|th)?(?:\s*,?\s*(\d{4}))?$/i);
  if (wordMatch && monthNames[wordMatch[1].toLowerCase()] !== undefined) {
    const m = monthNames[wordMatch[1].toLowerCase()];
    const d = parseInt(wordMatch[2], 10);
    const y = wordMatch[3] ? parseInt(wordMatch[3], 10) : defaultYear;
    return { year: y, month: m, day: d, formatted: `${m + 1}/${d}` };
  }

  return null;
}

function formatMatchDate(isoDate) {
  if (!isoDate) return '-';
  const d = new Date(isoDate);
  if (Number.isNaN(d.getTime())) return '-';
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles',
    weekday: 'short',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true
  }).format(d);
}

function formatScoresList(matches, headerTitle = null) {
  if (!matches || matches.length === 0) {
    return '📋 No match scores found for that period (scores are kept for 2 weeks).';
  }

  const lines = matches.map((m, i) => {
    const dateStr = formatMatchDate(m.date);
    const scoreStr = m.score ? ` (${m.score})` : '';
    const idStr = m.id ? ` \`${m.id}\`` : '';
    return `#${i + 1} [${dateStr}] *${m.winner}* def *${m.loser}*${scoreStr}${idStr}`;
  });

  const header = headerTitle
    ? `🎾 *Match Scores — ${headerTitle} (${matches.length}):*\n`
    : `🎾 *Recent Match Scores (${matches.length}):*\n`;

  const footer = `\n_Tip: Use \`!editscore <#|ID> <score>\` or \`!deletescore <#|ID>\` to update or remove a score._`;

  return `${header}${lines.join('\n')}${footer}`;
}

module.exports = {
  setAvailable,
  removeAvailable,
  clearAvailability,
  getAvailability,
  recordMatch,
  getLeaderboard,
  getRecentMatches,
  getScores,
  findMatchByIdOrIndex,
  deleteMatch,
  updateMatch,
  pruneExpiredMatches,
  parseDateQuery,
  formatMatchDate,
  formatScoresList,
  splitPlayers,
  resolveCanonicalName,
  TWO_WEEKS_MS,
  DATA_DIR,
  STATS_FILE
};
