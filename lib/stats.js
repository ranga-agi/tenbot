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

const TWO_WEEKS_MS = 14 * 24 * 60 * 60 * 1000;

let lastStatsContent = null;
let hasMigrated = false;

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

let groupsConfig = null;
try {
  groupsConfig = require('./groupsConfig');
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


function getFirstGroupId() {
  if (groupsConfig && typeof groupsConfig.loadRawConfig === "function") {
    try {
      const raw = groupsConfig.loadRawConfig();
      if (raw && raw.groups && typeof raw.groups === "object") {
        const keys = Object.keys(raw.groups);
        if (keys.length > 0) return keys[0];
      }
      if (Array.isArray(raw.allowedGroups) && raw.allowedGroups.length > 0) {
        const g = raw.allowedGroups.find(id => typeof id === "string" && id.includes("@"));
        if (g) return g;
      }
    } catch (_) {}
  }

  try {
    const configPath = path.join(__dirname, "..", "config", "groups.json");
    if (fs.existsSync(configPath)) {
      const raw = JSON.parse(fs.readFileSync(configPath, "utf-8"));
      if (raw && raw.groups && typeof raw.groups === "object") {
        const keys = Object.keys(raw.groups);
        if (keys.length > 0) return keys[0];
      }
    }
  } catch (_) {}

  try {
    if (fs.existsSync(SCORES_DIR)) {
      const files = fs.readdirSync(SCORES_DIR).filter(f => f.endsWith(".json") && f !== "default.json");
      if (files.length > 0) {
        return files[0].slice(0, -5);
      }
    }
  } catch (_) {}

  return null;
}

function migrateDefaultScoresToFirstGroup(targetGroupId = null) {
  ensureDirectories();
  const defaultPath = path.join(SCORES_DIR, "default.json");
  if (!fs.existsSync(defaultPath)) {
    return { migrated: 0, targetGroup: null };
  }

  const target = targetGroupId || getFirstGroupId();
  if (!target) {
    return { migrated: 0, targetGroup: null };
  }

  let defaultMatches = [];
  try {
    const raw = fs.readFileSync(defaultPath, "utf-8");
    const parsed = JSON.parse(raw);
    defaultMatches = Array.isArray(parsed) ? parsed : (parsed.matches || []);
  } catch (err) {
    console.error("⚠️ Failed to read scores/default.json:", err.message);
    return { migrated: 0, targetGroup: target };
  }

  if (defaultMatches.length === 0) {
    try { fs.unlinkSync(defaultPath); } catch (_) {}
    return { migrated: 0, targetGroup: target };
  }

  const targetSafe = sanitizeChatId(target);
  const targetPath = path.join(SCORES_DIR, `${targetSafe}.json`);
  let targetMatches = [];
  if (fs.existsSync(targetPath)) {
    try {
      const raw = fs.readFileSync(targetPath, "utf-8");
      const parsed = JSON.parse(raw);
      targetMatches = Array.isArray(parsed) ? parsed : (parsed.matches || []);
    } catch (_) {}
  }

  const existingIds = new Set(targetMatches.map(m => m && m.id).filter(Boolean));
  let migratedCount = 0;

  for (const m of defaultMatches) {
    if (!m) continue;
    const normalized = normalizeMatch(m);
    if (!normalized.chatId || normalized.chatId === "default") {
      normalized.chatId = target;
    }
    if (normalized.id && existingIds.has(normalized.id)) {
      const idx = targetMatches.findIndex(x => x && x.id === normalized.id);
      if (idx >= 0) {
        targetMatches[idx] = normalized;
      }
    } else {
      targetMatches.push(normalized);
      if (normalized.id) existingIds.add(normalized.id);
    }
    migratedCount++;
  }

  fs.writeFileSync(targetPath, JSON.stringify(targetMatches.map(normalizeMatch), null, 2));

  try {
    fs.unlinkSync(defaultPath);
  } catch (_) {}

  syncAggregateFiles();
  return { migrated: migratedCount, targetGroup: target };
}

function migrateDefaultAvailabilityToFirstGroup(targetGroupId = null) {
  ensureDirectories();
  const defaultPath = path.join(AVAILABILITY_DIR, "default.json");
  if (!fs.existsSync(defaultPath)) {
    return { migrated: 0, targetGroup: null };
  }

  const target = targetGroupId || getFirstGroupId();
  if (!target) {
    return { migrated: 0, targetGroup: null };
  }

  let defaultAvail = [];
  try {
    const raw = fs.readFileSync(defaultPath, "utf-8");
    const parsed = JSON.parse(raw);
    defaultAvail = Array.isArray(parsed) ? parsed : (parsed.availability || []);
  } catch (err) {
    console.error("⚠️ Failed to read availability/default.json:", err.message);
    return { migrated: 0, targetGroup: target };
  }

  if (defaultAvail.length === 0) {
    try { fs.unlinkSync(defaultPath); } catch (_) {}
    return { migrated: 0, targetGroup: target };
  }

  const targetSafe = sanitizeChatId(target);
  const targetPath = path.join(AVAILABILITY_DIR, `${targetSafe}.json`);
  let targetAvail = [];
  if (fs.existsSync(targetPath)) {
    try {
      const raw = fs.readFileSync(targetPath, "utf-8");
      const parsed = JSON.parse(raw);
      targetAvail = Array.isArray(parsed) ? parsed : (parsed.availability || []);
    } catch (_) {}
  }

  const existingPlayers = new Set(targetAvail.map(a => a && a.player).filter(Boolean));
  let migratedCount = 0;

  for (const a of defaultAvail) {
    if (!a) continue;
    const entry = { ...a };
    if (!entry.chatId || entry.chatId === "default") {
      entry.chatId = target;
    }
    if (entry.player && existingPlayers.has(entry.player)) {
      const idx = targetAvail.findIndex(x => x && x.player === entry.player);
      if (idx >= 0) {
        targetAvail[idx] = entry;
      }
    } else {
      targetAvail.push(entry);
      if (entry.player) existingPlayers.add(entry.player);
    }
    migratedCount++;
  }

  fs.writeFileSync(targetPath, JSON.stringify(targetAvail, null, 2));

  try {
    fs.unlinkSync(defaultPath);
  } catch (_) {}

  syncAggregateFiles();
  return { migrated: migratedCount, targetGroup: target };
}

function getAvailabilityFilePath(chatId) {
  const safe = sanitizeChatId(chatId);
  return path.join(AVAILABILITY_DIR, `${safe}.json`);
}

function getScoresFilePath(chatId) {
  const safe = sanitizeChatId(chatId);
  return path.join(SCORES_DIR, `${safe}.json`);
}


function normalizeRatingChanges(ratingChanges) {
  if (!Array.isArray(ratingChanges)) return ratingChanges;
  return ratingChanges.map((c) => {
    if (!c || typeof c !== "object") return c;
    if (typeof c.delta === "number") {
      return { name: c.name, delta: c.delta };
    }
    if (typeof c.from === "number" && typeof c.to === "number") {
      const delta = Number((c.to - c.from).toFixed(2));
      return { name: c.name, delta };
    }
    return c;
  });
}

function normalizeMatch(match) {
  if (!match || typeof match !== "object") return match;
  if (Array.isArray(match.ratingChanges)) {
    return {
      ...match,
      ratingChanges: normalizeRatingChanges(match.ratingChanges)
    };
  }
  return match;
}

function convertLegacyScoreFiles() {
  let changed = false;
  try {
    if (!fs.existsSync(SCORES_DIR)) return;
    const scoreFiles = fs.readdirSync(SCORES_DIR).filter(f => f.endsWith(".json"));
    for (const file of scoreFiles) {
      const filePath = path.join(SCORES_DIR, file);
      try {
        const raw = fs.readFileSync(filePath, "utf-8");
        const list = JSON.parse(raw);
        if (Array.isArray(list)) {
          let fileNeedsUpdate = false;
          for (const m of list) {
            if (m && Array.isArray(m.ratingChanges)) {
              if (m.ratingChanges.some(c => c && (typeof c.from === "number" || typeof c.to === "number"))) {
                fileNeedsUpdate = true;
                break;
              }
            }
          }
          if (fileNeedsUpdate) {
            const normalized = list.map(normalizeMatch);
            fs.writeFileSync(filePath, JSON.stringify(normalized, null, 2));
            changed = true;
          }
        }
      } catch (_) {}
    }
  } catch (_) {}

  if (changed) {
    syncAggregateFiles();
  }
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
        byGroup.get(gid).push(normalizeMatch(m));
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
      hasMigrated = true;
      try {
        if (Array.isArray(parsed.matches)) {
          fs.writeFileSync(SCORES_FILE, JSON.stringify(parsed.matches.map(normalizeMatch), null, 2));
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
        allMatches.push(...list.map(normalizeMatch));
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

function migrateLegacyIfNeeded() {
  ensureDirectories();
  checkStatsFileOverride();
  convertLegacyScoreFiles();
  migrateDefaultScoresToFirstGroup();
  migrateDefaultAvailabilityToFirstGroup();

  if (hasMigrated) return;
  hasMigrated = true;

  const scoreFiles = fs.readdirSync(SCORES_DIR).filter(f => f.endsWith('.json'));
  const availFiles = fs.readdirSync(AVAILABILITY_DIR).filter(f => f.endsWith('.json'));

  if (scoreFiles.length > 0 || availFiles.length > 0) {
    return;
  }

  // First-time migration from scores.json, availability.json, or stats.json
  let legacyMatches = [];
  let legacyAvail = [];

  if (fs.existsSync(SCORES_FILE)) {
    try {
      const raw = fs.readFileSync(SCORES_FILE, 'utf-8');
      const parsed = JSON.parse(raw);
      legacyMatches = Array.isArray(parsed) ? parsed : (parsed.matches || []);
    } catch (_) {}
  }

  if (fs.existsSync(AVAILABILITY_FILE)) {
    try {
      const raw = fs.readFileSync(AVAILABILITY_FILE, 'utf-8');
      const parsed = JSON.parse(raw);
      legacyAvail = Array.isArray(parsed) ? parsed : (parsed.availability || []);
    } catch (_) {}
  }

  if (legacyMatches.length === 0 && legacyAvail.length === 0 && fs.existsSync(STATS_FILE)) {
    try {
      const raw = fs.readFileSync(STATS_FILE, 'utf-8');
      const parsed = JSON.parse(raw);
      legacyMatches = Array.isArray(parsed.matches) ? parsed.matches : [];
      legacyAvail = Array.isArray(parsed.availability) ? parsed.availability : [];
    } catch (_) {}
  }

  if (legacyMatches.length > 0) {
    const byGroup = new Map();
    for (const m of legacyMatches) {
      const gid = sanitizeChatId(m.chatId);
      if (!byGroup.has(gid)) byGroup.set(gid, []);
      byGroup.get(gid).push(m);
    }
    for (const [gid, list] of byGroup.entries()) {
      fs.writeFileSync(path.join(SCORES_DIR, `${gid}.json`), JSON.stringify(list, null, 2));
    }
  }

  if (legacyAvail.length > 0) {
    const byGroup = new Map();
    for (const a of legacyAvail) {
      const gid = sanitizeChatId(a.chatId);
      if (!byGroup.has(gid)) byGroup.set(gid, []);
      byGroup.get(gid).push(a);
    }
    for (const [gid, list] of byGroup.entries()) {
      fs.writeFileSync(path.join(AVAILABILITY_DIR, `${gid}.json`), JSON.stringify(list, null, 2));
    }
  }

  syncAggregateFiles();
}

function loadGroupScores(chatId = null) {
  migrateLegacyIfNeeded();

  if (chatId) {
    const filePath = getScoresFilePath(chatId);
    if (fs.existsSync(filePath)) {
      try {
        const raw = fs.readFileSync(filePath, 'utf-8');
        const parsed = JSON.parse(raw);
        const list = Array.isArray(parsed) ? parsed : (parsed.matches || []);
        return list.map(normalizeMatch);
      } catch (err) {
        console.error(`⚠️ Failed to read ${filePath}:`, err.message);
      }
    }
    return [];
  }

  // If chatId is null, return all matches across all group score files
  const allMatches = [];
  try {
    const files = fs.readdirSync(SCORES_DIR).filter(f => f.endsWith('.json'));
    for (const file of files) {
      try {
        const raw = fs.readFileSync(path.join(SCORES_DIR, file), 'utf-8');
        const parsed = JSON.parse(raw);
        const list = Array.isArray(parsed) ? parsed : (parsed.matches || []);
        allMatches.push(...list);
      } catch (_) {}
    }
  } catch (_) {}

  return allMatches;
}

function saveGroupScores(chatId, matches) {
  ensureDirectories();
  const filePath = getScoresFilePath(chatId);
  const normalized = Array.isArray(matches) ? matches.map(normalizeMatch) : matches;
  fs.writeFileSync(filePath, JSON.stringify(normalized, null, 2));
  syncAggregateFiles();
}

function loadGroupAvailability(chatId = null) {
  migrateLegacyIfNeeded();

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
  const matches = (data.matches || []).map(normalizeMatch);

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
  migrateLegacyIfNeeded();
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
    ratingChanges: normalizeRatingChanges(extra.ratingChanges || []),
    date: extra.date || new Date().toISOString()
  };
  if (chatId) {
    entry.chatId = chatId;
  }

  matches.push(entry);
  saveGroupScores(chatId, matches);
  return matches;
}

/**
 * Calculates individual player rankings across recorded matches using the points system:
 * - 1 point per game won.
 * - 2 points bonus per set won.
 * - Points = gamesWon + (setsWon * 2).
 * - Tiebreaker 1: Fewer games lost (gamesLost ASC).
 * - Tiebreaker 2: More games won (gamesWon DESC).
 * - Tiebreaker 3: More sets won (setsWon DESC).
 * - By default, tallies matches within the current calendar month (in San Jose / Pacific time)
 *   so the leaderboard automatically resets on the 1st of each month.
 * - Set options.allTime = true to calculate all-time standings across all retained scores (last 2 weeks).
 * - Credits each individual player in singles and doubles with points, games, and sets.
 */
function getLeaderboard(chatId = null, options = {}) {
  const now = options.now || new Date();
  const nowMs = now instanceof Date ? now.getTime() : new Date(now).getTime();
  pruneExpiredMatches(TWO_WEEKS_MS, nowMs, chatId);

  const matches = loadGroupScores(chatId);
  const stats = new Map(); // nameKey -> { name, points, gamesWon, gamesLost, setsWon, setsLost, wins, losses, matches, winRate }
  const nowParts = getSjParts(now);
  const currentYear = nowParts.year;
  const currentMonth = nowParts.month; // 0-indexed

  const isAllTime = options.allTime === true || options.scope === 'all';

  const getStats = (name) => {
    const canonical = resolveCanonicalName(name);
    const key = canonical.toLowerCase();
    if (!stats.has(key)) {
      stats.set(key, {
        name: canonical,
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

    for (const [wGames, lGames] of parsedSets) {
      winnerGames += wGames;
      loserGames += lGames;
      if (wGames > lGames) {
        winnerSets += 1;
      } else if (lGames > wGames) {
        loserSets += 1;
      }
    }

    // Fallback if score had no parseable numeric games
    if (parsedSets.length === 0) {
      winnerSets = 1;
      loserSets = 0;
    }

    const winnerPoints = winnerGames + (winnerSets * 2);
    const loserPoints = loserGames + (loserSets * 2);

    for (const w of winners) {
      const s = getStats(w);
      s.wins += 1;
      s.matches += 1;
      s.points += winnerPoints;
      s.gamesWon += winnerGames;
      s.gamesLost += loserGames;
      s.setsWon += winnerSets;
      s.setsLost += loserSets;
    }
    for (const l of losers) {
      const s = getStats(l);
      s.losses += 1;
      s.matches += 1;
      s.points += loserPoints;
      s.gamesWon += loserGames;
      s.gamesLost += winnerGames;
      s.setsWon += loserSets;
      s.setsLost += winnerSets;
    }
  }

  for (const entry of stats.values()) {
    entry.winRate = entry.matches > 0 ? entry.wins / entry.matches : 0;
  }

  return [...stats.values()].sort((a, b) => {
    // 1. Total points (DESC)
    if (b.points !== a.points) return b.points - a.points;
    // 2. Fewer games lost (ASC) - player who lost fewer games is ranked higher
    if (a.gamesLost !== b.gamesLost) return a.gamesLost - b.gamesLost;
    // 3. More games won (DESC)
    if (b.gamesWon !== a.gamesWon) return b.gamesWon - a.gamesWon;
    // 4. Sets won (DESC)
    if (b.setsWon !== a.setsWon) return b.setsWon - a.setsWon;
    // 5. Match wins (DESC)
    if (b.wins !== a.wins) return b.wins - a.wins;
    // 6. Win rate (DESC)
    if (b.winRate !== a.winRate) return b.winRate - a.winRate;
    // 7. Alphabetical by player name
    return a.name.localeCompare(b.name);
  });
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

  // Recalculate rating adjustments if sets are available
  if (ratings && typeof ratings.applyResult === 'function' && Array.isArray(match.sets) && match.sets.length > 0) {
    const { changes } = ratings.applyResult(match.winners, match.losers, match.sets);
    match.ratingChanges = changes.map((c) => ({
      name: c.name,
      delta: typeof c.delta === "number" ? c.delta : Number((c.to - c.from).toFixed(2))
    }));
  } else if (Array.isArray(updates.ratingChanges)) {
    match.ratingChanges = normalizeRatingChanges(updates.ratingChanges);
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
    return `#${i + 1} [${dateStr}] *${m.winner}* def *${m.loser}*${scoreStr}${idStr}`;
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
  normalizeRatingChanges,
  normalizeMatch,
  convertLegacyScoreFiles,
  getFirstGroupId,
  migrateDefaultScoresToFirstGroup,
  migrateDefaultAvailabilityToFirstGroup,
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
