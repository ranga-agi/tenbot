/**
 * Persistence for the tennis group's availability and scores.
 *
 * Folder structure:
 *   - data/availability/<groupId>.json: Group-scoped availability (!free, !notfree, !clearfree).
 *   - data/scores/<groupId>.json: Group-scoped match scores and points (!score, !scores).
 *   - data/stats.json, data/scores.json, data/availability.json: Aggregates kept in sync for backward compatibility.
 *
 * Leaderboard rules:
 *   - Points system: 1 point per game won + 2 points per set won.
 *   - Tiebreaker: player with fewer games lost is ranked higher.
 *   - Scores are kept for a rolling 2-week window (14 days); older matches are automatically pruned.
 *   - Leaderboard standings automatically reset at the beginning of each calendar month (in San Jose / Pacific time).
 *   - Matches can be queried by recent count, specific day, date range, or group.
 *   - Scores can be modified or deleted, cleanly reverting player rating impacts.
 */

const fs = require('fs');
const path = require('path');

const { DATA_DIR } = require('./paths');
const AVAILABILITY_DIR = path.join(DATA_DIR, 'availability');
const SCORES_DIR = path.join(DATA_DIR, 'scores');
const AVAILABILITY_FILE = path.join(DATA_DIR, 'availability.json');
const SCORES_FILE = path.join(DATA_DIR, 'scores.json');
const STATS_FILE = path.join(DATA_DIR, 'stats.json');
const LEADERBOARD_NOTIFICATIONS_FILE = path.join(DATA_DIR, 'leaderboard-notifications.json');

const TWO_WEEKS_MS = 14 * 24 * 60 * 60 * 1000;

let lastStatsContent = null;

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

function ensureDirectories() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  if (!fs.existsSync(AVAILABILITY_DIR)) {
    fs.mkdirSync(AVAILABILITY_DIR, { recursive: true });
  }
  if (!fs.existsSync(SCORES_DIR)) {
    fs.mkdirSync(SCORES_DIR, { recursive: true });
  }
}

function sanitizeChatId(chatId) {
  if (!chatId || typeof chatId !== 'string') return 'default';
  return chatId.replace(/[/\\:*?"<>|]/g, '_').trim();
}

function getAvailabilityFilePath(chatId) {
  const safe = sanitizeChatId(chatId);
  return path.join(AVAILABILITY_DIR, `${safe}.json`);
}

function getScoresFilePath(chatId) {
  const safe = sanitizeChatId(chatId);
  return path.join(SCORES_DIR, `${safe}.json`);
}

function checkStatsFileOverride() {
  ensureDirectories();
  if (!fs.existsSync(STATS_FILE)) return;

  try {
    const raw = fs.readFileSync(STATS_FILE, 'utf-8');
    if (raw === lastStatsContent) return;

    const parsed = JSON.parse(raw);
    lastStatsContent = raw;

    // If stats.json was explicitly rewritten (e.g. in test suites with empty arrays or new matches)
    if (Array.isArray(parsed.matches)) {
      const existing = fs.readdirSync(SCORES_DIR).filter(f => f.endsWith('.json'));
      for (const f of existing) {
        try { fs.unlinkSync(path.join(SCORES_DIR, f)); } catch (_) {}
      }
      const byGroup = new Map();
      for (const m of parsed.matches) {
        const gid = sanitizeChatId(m.chatId);
        if (!byGroup.has(gid)) byGroup.set(gid, []);
        byGroup.get(gid).push(m);
      }
      for (const [gid, list] of byGroup.entries()) {
        fs.writeFileSync(path.join(SCORES_DIR, `${gid}.json`), JSON.stringify(list, null, 2));
      }
    }

    if (Array.isArray(parsed.availability)) {
      const existing = fs.readdirSync(AVAILABILITY_DIR).filter(f => f.endsWith('.json'));
      for (const f of existing) {
        try { fs.unlinkSync(path.join(AVAILABILITY_DIR, f)); } catch (_) {}
      }
      const byGroup = new Map();
      for (const a of parsed.availability) {
        const gid = sanitizeChatId(a.chatId);
        if (!byGroup.has(gid)) byGroup.set(gid, []);
        byGroup.get(gid).push(a);
      }
      for (const [gid, list] of byGroup.entries()) {
        fs.writeFileSync(path.join(AVAILABILITY_DIR, `${gid}.json`), JSON.stringify(list, null, 2));
      }
    }

    if (Array.isArray(parsed.matches) || Array.isArray(parsed.availability)) {
      try {
        if (Array.isArray(parsed.matches)) {
          fs.writeFileSync(SCORES_FILE, JSON.stringify(parsed.matches, null, 2));
        }
        if (Array.isArray(parsed.availability)) {
          fs.writeFileSync(AVAILABILITY_FILE, JSON.stringify(parsed.availability, null, 2));
        }
      } catch (_) {}
    }
  } catch (err) {
    console.error('⚠️ Failed to check stats.json override:', err.message);
  }
}

function syncAggregateFiles() {
  ensureDirectories();
  try {
    const allMatches = [];
    const scoreFiles = fs.readdirSync(SCORES_DIR).filter(f => f.endsWith('.json'));
    for (const file of scoreFiles) {
      try {
        const raw = fs.readFileSync(path.join(SCORES_DIR, file), 'utf-8');
        const parsed = JSON.parse(raw);
        const list = Array.isArray(parsed) ? parsed : (parsed.matches || []);
        allMatches.push(...list);
      } catch (_) {}
    }

    const allAvail = [];
    const availFiles = fs.readdirSync(AVAILABILITY_DIR).filter(f => f.endsWith('.json'));
    for (const file of availFiles) {
      try {
        const raw = fs.readFileSync(path.join(AVAILABILITY_DIR, file), 'utf-8');
        const parsed = JSON.parse(raw);
        const list = Array.isArray(parsed) ? parsed : (parsed.availability || []);
        allAvail.push(...list);
      } catch (_) {}
    }

    fs.writeFileSync(SCORES_FILE, JSON.stringify(allMatches, null, 2));
    fs.writeFileSync(AVAILABILITY_FILE, JSON.stringify(allAvail, null, 2));
    const statsStr = JSON.stringify({ availability: allAvail, matches: allMatches }, null, 2);
    fs.writeFileSync(STATS_FILE, statsStr);
    lastStatsContent = statsStr;
  } catch (err) {
    console.error('⚠️ Failed to sync aggregate files:', err.message);
  }
}

function normalizeAndConvertFile(filePath) {
  if (!fs.existsSync(filePath)) return { list: [], converted: 0 };
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(raw);
    const list = Array.isArray(parsed) ? parsed : (parsed.matches || []);
    let converted = 0;
    for (const m of list) {
      if (m && typeof m === 'object' && m.format !== 'vs') {
        m.format = 'vs';
        converted++;
      }
    }
    if (converted > 0) {
      fs.writeFileSync(filePath, JSON.stringify(list, null, 2));
    }
    return { list, converted };
  } catch (err) {
    console.error(`⚠️ Failed to read ${filePath}:`, err.message);
    return { list: [], converted: 0 };
  }
}

function migrateDefMatchesToVs(chatId = null) {
  ensureDirectories();
  checkStatsFileOverride();
  let totalConverted = 0;

  if (chatId) {
    totalConverted += normalizeAndConvertFile(getScoresFilePath(chatId)).converted;
  } else {
    try {
      const files = fs.readdirSync(SCORES_DIR).filter(f => f.endsWith('.json'));
      for (const file of files) {
        totalConverted += normalizeAndConvertFile(path.join(SCORES_DIR, file)).converted;
      }
    } catch (_) {}
  }

  if (totalConverted > 0) {
    syncAggregateFiles();
    console.log(`[stats] Converted ${totalConverted} def match(es) to vs format.`);
  }
  return totalConverted;
}

function loadGroupScores(chatId = null) {
  ensureDirectories();
  checkStatsFileOverride();

  if (chatId) {
    const filePath = getScoresFilePath(chatId);
    const { list, converted } = normalizeAndConvertFile(filePath);
    if (converted > 0) syncAggregateFiles();
    return list;
  }

  // If chatId is null, return all matches across all group score files
  const allMatches = [];
  let totalConverted = 0;
  try {
    const files = fs.readdirSync(SCORES_DIR).filter(f => f.endsWith('.json'));
    for (const file of files) {
      const { list, converted } = normalizeAndConvertFile(path.join(SCORES_DIR, file));
      totalConverted += converted;
      allMatches.push(...list);
    }
  } catch (_) {}

  if (totalConverted > 0) syncAggregateFiles();
  return allMatches;
}

function saveGroupScores(chatId, matches) {
  ensureDirectories();
  const filePath = getScoresFilePath(chatId);
  fs.writeFileSync(filePath, JSON.stringify(matches, null, 2));
  syncAggregateFiles();
}

function loadGroupAvailability(chatId = null) {
  ensureDirectories();
  checkStatsFileOverride();

  if (chatId) {
    const filePath = getAvailabilityFilePath(chatId);
    if (fs.existsSync(filePath)) {
      try {
        const raw = fs.readFileSync(filePath, 'utf-8');
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : (parsed.availability || []);
      } catch (err) {
        console.error(`⚠️ Failed to read ${filePath}:`, err.message);
      }
    }
    return [];
  }

  const allAvail = [];
  try {
    const files = fs.readdirSync(AVAILABILITY_DIR).filter(f => f.endsWith('.json'));
    for (const file of files) {
      try {
        const raw = fs.readFileSync(path.join(AVAILABILITY_DIR, file), 'utf-8');
        const parsed = JSON.parse(raw);
        const list = Array.isArray(parsed) ? parsed : (parsed.availability || []);
        allAvail.push(...list);
      } catch (_) {}
    }
  } catch (_) {}

  return allAvail;
}

function saveGroupAvailability(chatId, availability) {
  ensureDirectories();
  const filePath = getAvailabilityFilePath(chatId);
  fs.writeFileSync(filePath, JSON.stringify(availability, null, 2));
  syncAggregateFiles();
}

function loadData() {
  return {
    availability: loadGroupAvailability(),
    matches: loadGroupScores()
  };
}

function saveData(data) {
  ensureDirectories();
  const availability = data.availability || [];
  const matches = data.matches || [];

  const byGroupScores = new Map();
  for (const m of matches) {
    const gid = sanitizeChatId(m.chatId);
    if (!byGroupScores.has(gid)) byGroupScores.set(gid, []);
    byGroupScores.get(gid).push(m);
  }
  const existingScores = fs.readdirSync(SCORES_DIR).filter(f => f.endsWith('.json'));
  for (const f of existingScores) {
    try { fs.unlinkSync(path.join(SCORES_DIR, f)); } catch (_) {}
  }
  for (const [gid, list] of byGroupScores.entries()) {
    fs.writeFileSync(path.join(SCORES_DIR, `${gid}.json`), JSON.stringify(list, null, 2));
  }

  const byGroupAvail = new Map();
  for (const a of availability) {
    const gid = sanitizeChatId(a.chatId);
    if (!byGroupAvail.has(gid)) byGroupAvail.set(gid, []);
    byGroupAvail.get(gid).push(a);
  }
  const existingAvail = fs.readdirSync(AVAILABILITY_DIR).filter(f => f.endsWith('.json'));
  for (const f of existingAvail) {
    try { fs.unlinkSync(path.join(AVAILABILITY_DIR, f)); } catch (_) {}
  }
  for (const [gid, list] of byGroupAvail.entries()) {
    fs.writeFileSync(path.join(AVAILABILITY_DIR, `${gid}.json`), JSON.stringify(list, null, 2));
  }

  syncAggregateFiles();
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
function pruneExpiredMatches(maxAgeMs = TWO_WEEKS_MS, now = Date.now(), chatId = null) {
  ensureDirectories();
  checkStatsFileOverride();
  const cutoff = now - maxAgeMs;
  let totalPruned = 0;

  if (chatId) {
    const matches = loadGroupScores(chatId);
    const initialCount = matches.length;
    const remaining = matches.filter((m) => {
      const ts = m.date ? new Date(m.date).getTime() : 0;
      return Number.isFinite(ts) && ts >= cutoff;
    });
    if (remaining.length !== initialCount) {
      saveGroupScores(chatId, remaining);
      totalPruned += (initialCount - remaining.length);
    }
  } else {
    try {
      const files = fs.readdirSync(SCORES_DIR).filter(f => f.endsWith('.json'));
      for (const file of files) {
        const gid = file.slice(0, -5);
        const matches = loadGroupScores(gid);
        const initialCount = matches.length;
        const remaining = matches.filter((m) => {
          const ts = m.date ? new Date(m.date).getTime() : 0;
          return Number.isFinite(ts) && ts >= cutoff;
        });
        if (remaining.length !== initialCount) {
          saveGroupScores(gid, remaining);
          totalPruned += (initialCount - remaining.length);
        }
      }
    } catch (_) {}
  }

  if (totalPruned > 0) {
    console.log(`[stats] Pruned ${totalPruned} expired match(es) older than 14 days.`);
  }
  return totalPruned;
}

// ---- Availability ----

/** Add or update a player's availability entry (one active entry per player per group). */
function setAvailable(player, when, chatId = null) {
  ensureDirectories();
  const list = loadGroupAvailability(chatId);
  const existingIndex = list.findIndex(
    (a) => a.player.toLowerCase() === player.toLowerCase()
  );
  const entry = { player, when, addedAt: new Date().toISOString() };
  if (chatId) entry.chatId = chatId;
  if (existingIndex >= 0) {
    list[existingIndex] = entry;
  } else {
    list.push(entry);
  }
  saveGroupAvailability(chatId, list);
  return list;
}

function removeAvailable(player, chatId = null) {
  ensureDirectories();
  if (chatId) {
    const list = loadGroupAvailability(chatId).filter(
      (a) => a.player.toLowerCase() !== player.toLowerCase()
    );
    saveGroupAvailability(chatId, list);
    return list;
  }
  const files = fs.readdirSync(AVAILABILITY_DIR).filter(f => f.endsWith('.json'));
  for (const f of files) {
    const gid = f.slice(0, -5);
    const list = loadGroupAvailability(gid).filter(
      (a) => a.player.toLowerCase() !== player.toLowerCase()
    );
    saveGroupAvailability(gid, list);
  }
  return [];
}

function clearAvailability(chatId = null) {
  ensureDirectories();
  if (chatId) {
    saveGroupAvailability(chatId, []);
    return;
  }
  const files = fs.readdirSync(AVAILABILITY_DIR).filter(f => f.endsWith('.json'));
  for (const f of files) {
    const gid = f.slice(0, -5);
    saveGroupAvailability(gid, []);
  }
  syncAggregateFiles();
}

function getAvailability(chatId = null) {
  return loadGroupAvailability(chatId);
}

// ---- Match results / leaderboard ----

function recordMatch(winner, loser, score, extra = {}) {
  const chatId = extra.chatId || null;
  pruneExpiredMatches(TWO_WEEKS_MS, Date.now(), chatId);

  const matches = loadGroupScores(chatId);
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
    format: 'vs',
    ratingChanges: extra.ratingChanges || [],
    date: extra.date || new Date().toISOString()
  };
  if (chatId) {
    entry.chatId = chatId;
  }

  matches.push(entry);
  saveGroupScores(chatId, matches);
  return matches;
}

const LEADERBOARD_PRIOR_SETS = 4;
const LEADERBOARD_PRIOR_POINTS_PER_SET = 4;

/**
 * Determines the winner of a single set [aGames, bGames].
 * If a set isn't completed, the team with more game wins wins the set as long as
 * they have at least 4 games won. Tied sets or sets under 4 games return null.
 */
function evaluateSetWinner(aGames, bGames) {
  if (!Number.isFinite(aGames) || !Number.isFinite(bGames)) return null;
  if (aGames === bGames) return null;
  if (Math.max(aGames, bGames) < 4) return null;
  return aGames > bGames ? 'A' : 'B';
}

/**
 * Scores a single set [aGames, bGames] on a symmetric 0–16 margin scale.
 * Decided sets: winner = 10 + min(6, margin), loser = max(0, 6 - min(6, margin)).
 * Undecided sets (< 4 games or tied) yield 0 points for each side.
 */
function scoreSetPoints(aGames, bGames) {
  const winner = evaluateSetWinner(aGames, bGames);
  if (!winner) return { a: 0, b: 0, decided: false };
  const margin = Math.min(6, Math.abs(aGames - bGames));
  const winPts = 10 + margin;
  const losePts = Math.max(0, 6 - margin);
  return winner === 'A'
    ? { a: winPts, b: losePts, decided: true }
    : { a: losePts, b: winPts, decided: true };
}

/**
 * Calculates individual player rankings across recorded matches using the points system:
 * - Symmetric per-set points: Win = 10 + min(6, margin), Loss = max(0, 6 - min(6, margin)).
 * - Conservative smoothed average per set: (points + 16) / (decidedSets + 4),
 *   starting players with 4 ghost sets at 4.0 pts/set so small sample sizes don't jump ahead.
 * - Tiebreaker 1: Higher total points (points DESC).
 * - Tiebreaker 2: Higher game differential (gamesWon - gamesLost DESC).
 * - Tiebreaker 3: Fewer games lost (gamesLost ASC).
 * - By default, tallies matches within the current calendar month (in San Jose / Pacific time)
 *   so the leaderboard automatically resets on the 1st of each month.
 * - Set options.allTime = true to calculate all-time standings across all retained scores (last 2 weeks).
 * - Credits each individual player in singles and doubles with points, games, and sets.
 */
function getLeaderboard(chatId = null, options = {}) {
  const now = options.now || new Date();
  const nowMs = now instanceof Date ? now.getTime() : new Date(now).getTime();
  if (!options.skipPrune) {
    pruneExpiredMatches(TWO_WEEKS_MS, nowMs, chatId);
  }

  const matches = loadGroupScores(chatId);
  const stats = new Map(); // nameKey -> { name, points, gamesWon, gamesLost, setsWon, setsLost, wins, losses, matches, winRate }
  const nowParts = getSjParts(now);
  const currentYear = Number.isInteger(options.year) ? options.year : nowParts.year;
  const currentMonth = Number.isInteger(options.month) ? options.month : nowParts.month; // 0-indexed

  const isAllTime = options.allTime === true || options.scope === 'all';

  const getStats = (name) => {
    const canonical = resolveCanonicalName(name);
    const key = canonical.toLowerCase();
    if (!stats.has(key)) {
      stats.set(key, {
        name: canonical,
        score: LEADERBOARD_PRIOR_POINTS_PER_SET,
        points: 0,
        gamesWon: 0,
        gamesLost: 0,
        setsWon: 0,
        setsLost: 0,
        wins: 0,
        losses: 0,
        matches: 0,
        winRate: 0
      });
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

    // Parse sets: e.g. [[6, 4], [6, 2]]
    let parsedSets = [];
    if (Array.isArray(m.sets) && m.sets.length > 0) {
      parsedSets = m.sets.filter(([w, l]) => Number.isFinite(w) && Number.isFinite(l));
    }
    if (parsedSets.length === 0 && typeof m.score === 'string') {
      parsedSets = m.score
        .trim()
        .split(/[\s,]+/)
        .filter(Boolean)
        .map((s) => s.replace(/\s*[\(\[]\s*\d{1,2}\s*[\)\]]$/, '').split(/\s*[-–—:]\s*/).map(Number))
        .filter(([w, l]) => Number.isFinite(w) && Number.isFinite(l));
    }

    let winnerGames = 0;
    let loserGames = 0;
    let winnerSets = 0;
    let loserSets = 0;
    let winnerPoints = 0;
    let loserPoints = 0;

    for (const [wGames, lGames] of parsedSets) {
      winnerGames += wGames;
      loserGames += lGames;
      const setPts = scoreSetPoints(wGames, lGames);
      if (setPts.decided) {
        winnerPoints += setPts.a;
        loserPoints += setPts.b;
        if (setPts.a > setPts.b) {
          winnerSets += 1;
        } else {
          loserSets += 1;
        }
      }
    }

    // Fallback if score had no parseable numeric games
    if (parsedSets.length === 0) {
      winnerSets = 1;
      loserSets = 0;
      winnerPoints = 13;
      loserPoints = 3;
    }

    for (const w of winners) {
      const s = getStats(w);
      s.wins += winnerSets;
      s.losses += loserSets;
      s.matches += 1;
      s.points += winnerPoints;
      s.gamesWon += winnerGames;
      s.gamesLost += loserGames;
      s.setsWon += winnerSets;
      s.setsLost += loserSets;
    }
    for (const l of losers) {
      const s = getStats(l);
      s.wins += loserSets;
      s.losses += winnerSets;
      s.matches += 1;
      s.points += loserPoints;
      s.gamesWon += loserGames;
      s.gamesLost += winnerGames;
      s.setsWon += loserSets;
      s.setsLost += winnerSets;
    }
  }

  for (const entry of stats.values()) {
    const decidedSets = entry.wins + entry.losses;
    entry.winRate = decidedSets > 0 ? entry.wins / decidedSets : 0;
    entry._rawScore = (entry.points + (LEADERBOARD_PRIOR_SETS * LEADERBOARD_PRIOR_POINTS_PER_SET)) / (decidedSets + LEADERBOARD_PRIOR_SETS);
    entry.score = Number(entry._rawScore.toFixed(2));
  }

  return [...stats.values()].sort((a, b) => {
    // 1. Conservative smoothed average score per set (DESC)
    if (Math.abs(b._rawScore - a._rawScore) > 1e-9) return b._rawScore - a._rawScore;
    // 2. Total points (DESC)
    if (b.points !== a.points) return b.points - a.points;
    // 3. Game differential (DESC)
    const diffA = a.gamesWon - a.gamesLost;
    const diffB = b.gamesWon - b.gamesLost;
    if (diffB !== diffA) return diffB - diffA;
    // 4. Fewer games lost (ASC)
    if (a.gamesLost !== b.gamesLost) return a.gamesLost - b.gamesLost;
    // 5. More games won (DESC)
    if (b.gamesWon !== a.gamesWon) return b.gamesWon - a.gamesWon;
    // 6. Sets won (DESC)
    if (b.setsWon !== a.setsWon) return b.setsWon - a.setsWon;
    // 7. Match wins (DESC)
    if (b.wins !== a.wins) return b.wins - a.wins;
    // 8. Win rate (DESC)
    if (b.winRate !== a.winRate) return b.winRate - a.winRate;
    // 9. Alphabetical by player name
    return a.name.localeCompare(b.name);
  });
}

function getPreviousMonthInfo(now = new Date()) {
  const sj = getSjParts(now);
  const currentYear = sj.year;
  const currentMonth = sj.month; // 0-indexed
  const year = currentMonth === 0 ? currentYear - 1 : currentYear;
  const month = currentMonth === 0 ? 11 : currentMonth - 1;
  const monthKey = `${year}-${String(month + 1).padStart(2, '0')}`;
  return { year, month, monthKey, currentYear, currentMonth };
}

function loadLeaderboardNotificationsState() {
  ensureDirectories();
  try {
    if (!fs.existsSync(LEADERBOARD_NOTIFICATIONS_FILE)) return {};
    const raw = fs.readFileSync(LEADERBOARD_NOTIFICATIONS_FILE, 'utf-8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (err) {
    console.error('⚠️ Failed to read leaderboard-notifications.json:', err.message);
    return {};
  }
}

function getLastPublishedLeaderboardMonth(chatId) {
  if (!chatId) return null;
  const state = loadLeaderboardNotificationsState();
  return state[chatId] || null;
}

function markLeaderboardMonthPublished(chatId, monthKey) {
  if (!chatId || !monthKey) return;
  ensureDirectories();
  const state = loadLeaderboardNotificationsState();
  state[chatId] = monthKey;
  fs.writeFileSync(LEADERBOARD_NOTIFICATIONS_FILE, JSON.stringify(state, null, 2));
}

function getRecentMatches(limit = 5, chatId = null) {
  pruneExpiredMatches(TWO_WEEKS_MS, Date.now(), chatId);
  const matches = loadGroupScores(chatId);
  return matches.slice(-limit).reverse();
}

/**
 * Searches and filters match scores by date range, day, or player.
 * Matches are returned sorted newest to oldest.
 */
function getScores(filter = {}, options = {}) {
  const chatId = filter.chatId || null;
  pruneExpiredMatches(TWO_WEEKS_MS, Date.now(), chatId);
  let list = loadGroupScores(chatId);

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
function findMatchByIdOrIndex(identifier, matchesList = null, chatId = null) {
  if (!identifier) return null;
  const str = String(identifier).trim();
  const list = matchesList || loadGroupScores(chatId);

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
function deleteMatch(idOrIndex, chatId = null) {
  const match = findMatchByIdOrIndex(idOrIndex, null, chatId);
  if (!match) return null;

  // Revert rating changes if present
  if (ratings && typeof ratings.revertResult === 'function' && Array.isArray(match.ratingChanges) && match.ratingChanges.length > 0) {
    ratings.revertResult(match.ratingChanges);
  }

  const matchChatId = match.chatId || chatId || null;
  const matches = loadGroupScores(matchChatId);
  const updated = matches.filter((m) => m.id !== match.id);
  saveGroupScores(matchChatId, updated);
  return match;
}

/**
 * Modifies an existing recorded match score.
 * Reverts previous rating adjustments, updates data, and applies new rating adjustments if sets/scores changed.
 */
function updateMatch(idOrIndex, updates = {}, chatId = null) {
  const match = findMatchByIdOrIndex(idOrIndex, null, chatId);
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
  match.format = 'vs';

  // Recalculate rating adjustments if sets are available
  if (ratings && typeof ratings.applyResult === 'function' && Array.isArray(match.sets) && match.sets.length > 0) {
    const { changes } = ratings.applyResult(match.winners, match.losers, match.sets);
    match.ratingChanges = changes.map((c) => ({
      name: c.name,
      delta: typeof c.delta === "number" ? c.delta : Number((c.to - c.from).toFixed(2))
    }));
  } else if (Array.isArray(updates.ratingChanges)) {
    match.ratingChanges = updates.ratingChanges;
  }

  const matchChatId = match.chatId || chatId || null;
  const matches = loadGroupScores(matchChatId);
  const idx = matches.findIndex((m) => m.id === match.id);
  if (idx >= 0) {
    matches[idx] = match;
  }
  saveGroupScores(matchChatId, matches);
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
    return { type: 'recent', limit: 6, label: 'Recent' };
  }

  const raw = queryText.trim().toLowerCase();
  if (!raw || raw === 'recent') {
    return { type: 'recent', limit: 6, label: 'Recent' };
  }

  // Simple number limit: e.g. "5", "recent 5", "limit 15"
  const limitMatch = raw.match(/^(?:recent\s+|limit\s+)?(\d+)$/);
  if (limitMatch) {
    const limit = Math.max(1, Math.min(50, parseInt(limitMatch[1], 10)));
    return { type: 'recent', limit, label: `Last ${limit}` };
  }

  const nowMs = now.getTime();
  const sj = getSjParts(now);

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
    return `#${i + 1} [${dateStr}] *${m.winner}* vs *${m.loser}*${scoreStr}${idStr}`;
  });

  const header = headerTitle
    ? `🎾 *Match Scores — ${headerTitle} (${matches.length}):*\n\n`
    : `🎾 *Recent Match Scores (${matches.length}):*\n\n`;

  const footer = `\n\n_Tip: Use \`!editscore <#|ID> <score>\` or \`!deletescore <#|ID>\` to update or remove a score._`;

  return `${header}${lines.join('\n\n')}${footer}`;
}

module.exports = {
  setAvailable,
  removeAvailable,
  clearAvailability,
  getAvailability,
  recordMatch,
  getLeaderboard,
  evaluateSetWinner,
  scoreSetPoints,
  LEADERBOARD_PRIOR_SETS,
  LEADERBOARD_PRIOR_POINTS_PER_SET,
  LEADERBOARD_NOTIFICATIONS_FILE,
  getSanJoseParts: getSjParts,
  getPreviousMonthInfo,
  getLastPublishedLeaderboardMonth,
  markLeaderboardMonthPublished,
  migrateDefMatchesToVs,
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
  sanitizeChatId,
  getScoresFilePath,
  getAvailabilityFilePath,
  loadGroupScores,
  saveGroupScores,
  loadGroupAvailability,
  saveGroupAvailability,
  TWO_WEEKS_MS,
  DATA_DIR,
  AVAILABILITY_DIR,
  SCORES_DIR,
  STATS_FILE,
  SCORES_FILE,
  AVAILABILITY_FILE
};
