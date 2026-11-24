/**
 * Match Scores, Freeform Score Parsing & Leaderboard Commands
 */

const stats = require('../../stats');
const ratings = require('../../ratings');
const namesStore = require('../../names');
const { parseScoreReport } = require('../../scoreReport');
const { findMatchupFor } = require('../../matchups');
const { isUserAdmin, extractGroupFlag } = require('../groupCommands');
const groupsConfig = require('../../groupsConfig');
const { nameFor, knownPlayers } = require('./profile');

const SELF_WORDS = new Set(['i', 'me', 'myself', 'we', 'us', 'my team', 'our team']);

const recentFreeformScores = new Map();
const FREEFORM_DUPLICATE_WINDOW_MS = 10 * 60 * 1000;

const SCORE_TAIL_PATTERN = '((?:[0-9]{1,2}\\s*[-–—:]\\s*[0-9]{1,2}(?:\\s*[\\(\\[]\\s*\\d{1,2}\\s*[\\)\\]])?[\\s,]*)+)$';
const WINNER_FIRST_MATCH_REGEX = new RegExp(`^(.+?)\\s+(?:def|beat|beats|defeated|defeats|d\\.)\\s+(.+?)\\s+${SCORE_TAIL_PATTERN}`, 'i');
const NEUTRAL_MATCH_REGEX = new RegExp(`^(.+?)\\s+(?:vs\\.?|versus|v\\.)\\s+(.+?)\\s+${SCORE_TAIL_PATTERN}`, 'i');

function parseSide(side) {
  return side
    .split(/\s*(?:&|\+|\band\b)\s*/i)
    .map((name) => name.trim())
    .filter(Boolean);
}

const formatSide = (names) => names.join(' & ');
const formatSets = (sets) => sets.map(([a, b]) => `${a}-${b}`).join(' ');

function resolveCanonicalPlayers(names, chatId) {
  return names.map((n) => {
    const match = namesStore.findIdByNameOrAlias(n, chatId);
    return (match && match.entry?.name) ? match.entry.name : n;
  });
}

function parseScoreSets(score) {
  return score
    .trim()
    .split(/[\s,]+/)
    .filter(Boolean)
    .map((set) => set.replace(/\s*[\(\[]\s*\d{1,2}\s*[\)\]]$/, '').split(/\s*[-–—:]\s*/).map(Number))
    .filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b));
}

/**
 * Parses "<winner> def <loser> <score>" or "<side1> vs <side2> <score>".
 * For neutral separators ("vs", "vs.", "versus", "v."), the match is recorded
 * directly as "vs" with sides and set scores in the order provided (points and
 * ratings are calculated per individual set, so 2-set splits like 6-4 4-6 work).
 * Matches entered with "def"/"beat" are also recorded as "vs".
 *
 * Returns null if `text` does not match either pattern,
 * `{ error }` if matched but invalid (uneven teams),
 * or `{ winners, losers, sets, format }` on success.
 */
function parseMatchResultExpression(text, chatId = null) {
  const match = text.match(WINNER_FIRST_MATCH_REGEX) || text.match(NEUTRAL_MATCH_REGEX);
  if (!match) return null;

  const [, rawSideA, rawSideB, rawScore] = match;
  const sideA = parseSide(rawSideA);
  const sideB = parseSide(rawSideB);
  const sets = parseScoreSets(rawScore);

  if (sideA.length !== sideB.length) {
    return { error: `Both sides need the same number of players -- got ${sideA.length} vs ${sideB.length}.` };
  }

  const winners = resolveCanonicalPlayers(sideA, chatId);
  const losers = resolveCanonicalPlayers(sideB, chatId);

  return { winners, losers, sets, format: 'vs' };
}

function formatLeaderboard(chatId = null, options = {}) {
  const board = stats.getLeaderboard(chatId, options);
  const now = options.now || new Date();
  const sj = stats.getSanJoseParts ? stats.getSanJoseParts(now) : null;
  const monthNames = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const curMonthIdx = sj ? sj.month : now.getMonth();
  const curYear = sj ? sj.year : now.getFullYear();
  const monthLabel = options.allTime ? 'All-Time (Last 2 Weeks)' : `${monthNames[curMonthIdx]} ${curYear}`;

  if (board.length === 0) {
    return `No matches recorded for ${monthLabel} yet. Use "!score <side1> vs <side2> <score>" or "!score <winner> def <loser> <score>" to log one.`;
  }

  let displayBoard = board;
  if (chatId && chatId.endsWith('@g.us')) {
    const groupMembers = namesStore.getGroupMembers(chatId);
    if (groupMembers && groupMembers.size > 0) {
      const filtered = board.filter((p) => {
        const match = namesStore.findIdByNameOrAlias(p.name, chatId);
        const idNorm = (match?.id || '').toLowerCase();
        const numOnly = idNorm.split('@')[0];
        const pnNorm = (match?.entry?.pn || '').toLowerCase();
        const pnNum = pnNorm.split('@')[0];
        const nameKey = ratings.keyFor(p.name);
        return (
          groupMembers.has(idNorm) ||
          (numOnly && groupMembers.has(numOnly)) ||
          (pnNorm && groupMembers.has(pnNorm)) ||
          (pnNum && groupMembers.has(pnNum)) ||
          groupMembers.has(nameKey)
        );
      });
      if (filtered.length > 0) {
        displayBoard = filtered;
      }
    }
  }

  const lines = displayBoard.map((p, i) => {
    return `${i + 1}. ${p.name} — ${p.points} pts (${p.gamesWon}-${p.gamesLost} games, ${p.setsWon}-${p.setsLost} sets, ${p.wins}W ${p.losses}L)`;
  });
  return `🏆 *Leaderboard (${monthLabel}):*\n${lines.join('\n')}\n\n_Scoring: 1 pt/game + 2 pts/set win • Tiebreaker: fewer games lost_`;
}

function handleListScores(chatId, queryText = null) {
  const parsed = stats.parseDateQuery(queryText);
  const filter = { chatId: chatId?.endsWith('@g.us') ? chatId : null };

  if (parsed.type === 'day' || parsed.type === 'range') {
    filter.startDate = parsed.startDate;
    filter.endDate = parsed.endDate;
  } else if (parsed.type === 'player') {
    filter.player = parsed.player;
  }

  const matches = stats.getScores(filter, { limit: parsed.limit || (parsed.type === 'recent' ? 6 : 50) });
  return stats.formatScoresList(matches, parsed.label);
}

async function canUserManageScore(sock, chatId, senderJid, sender, match) {
  if (!match) return false;
  if (groupsConfig.isSuperAdmin(senderJid)) return true;
  const admin = await isUserAdmin(sock, chatId, senderJid);
  if (admin) return true;

  const senderCanonical = nameFor(senderJid);
  const senderKey = ratings.keyFor(sender);
  const canonicalKey = senderCanonical ? ratings.keyFor(senderCanonical) : null;

  const matchPlayers = [
    ...(Array.isArray(match.winners) ? match.winners : stats.splitPlayers(match.winner)),
    ...(Array.isArray(match.losers) ? match.losers : stats.splitPlayers(match.loser))
  ].map((p) => ratings.keyFor(p));

  return matchPlayers.includes(senderKey) || (canonicalKey && matchPlayers.includes(canonicalKey));
}

async function handleDeleteScore(sock, chatId, senderJid, sender, rawTarget) {
  if (!rawTarget) {
    return 'Please specify the match score to delete by number or ID, e.g. "!deletescore #1" or "!deletescore m_...". Run "!scores" to view recent scores.';
  }

  const match = stats.findMatchByIdOrIndex(rawTarget);
  if (!match) {
    return `Match score "${rawTarget}" not found. Run "!scores" to see available match scores.`;
  }

  const canManage = await canUserManageScore(sock, chatId, senderJid, sender, match);
  if (!canManage) {
    return '⚠️ Only group admins or players involved in the match can delete this score.';
  }

  const deleted = stats.deleteMatch(match.id);
  if (!deleted) {
    return `Could not delete match score "${rawTarget}".`;
  }

  return `🗑️ *Deleted match score:*\n` +
    `• *Match:* ${deleted.winner} vs ${deleted.loser} (${deleted.score})\n` +
    `• *Date:* ${stats.formatMatchDate(deleted.date)}\n` +
    `• Player ratings and monthly leaderboard have been restored.`;
}

async function handleEditScore(sock, chatId, senderJid, sender, rawArgs) {
  if (!rawArgs) {
    return 'Usage: "!editscore <#|ID> <new score>", "!editscore <#|ID> <winner> def <loser> <new score>", or "!editscore <#|ID> <side1> vs <side2> <new score>"\ne.g. "!editscore #1 6-3 6-4" or "!editscore #1 Mike vs John 6-3 6-4"';
  }

  const firstSpaceIdx = rawArgs.search(/\s+/);
  if (firstSpaceIdx === -1) {
    return 'Please provide the new score or updated match result, e.g. "!editscore #1 6-3 6-4".';
  }

  const targetId = rawArgs.slice(0, firstSpaceIdx).trim();
  const restText = rawArgs.slice(firstSpaceIdx).trim();

  const match = stats.findMatchByIdOrIndex(targetId);
  if (!match) {
    return `Match score "${targetId}" not found. Run "!scores" to see available match scores.`;
  }

  const canManage = await canUserManageScore(sock, chatId, senderJid, sender, match);
  if (!canManage) {
    return '⚠️ Only group admins or players involved in the match can edit this score.';
  }

  // Case 1: Full phrase with def/beat/vs: e.g. "Mike & Sara def John & Alex 6-4 6-2" or "Mike vs John 4-6 2-6"
  const fullMatch = parseMatchResultExpression(restText, chatId);
  if (fullMatch) {
    if (fullMatch.error) return fullMatch.error;

    const { winners, losers, sets } = fullMatch;
    const oldWinner = match.winner;
    const oldLoser = match.loser;
    const oldScore = match.score;

    const winnerText = formatSide(winners);
    const loserText = formatSide(losers);
    const scoreText = formatSets(sets);

    stats.updateMatch(match.id, {
      winner: winnerText,
      loser: loserText,
      winners,
      losers,
      score: scoreText,
      sets,
      format: 'vs'
    });

    return `✏️ *Updated match score:*\n` +
      `• *Was:* ${oldWinner} vs ${oldLoser} (${oldScore})\n` +
      `• *Now:* ${winnerText} vs ${loserText} (${scoreText})\n` +
      `• Player ratings and monthly leaderboard have been recalculated.`;
  }

  // Case 2: Just new score, e.g. "6-3 6-4" or "6-4, 5-7, 10-8"
  const isScoreOnly = /^((?:[0-9]{1,2}\s*[-–—:]\s*[0-9]{1,2}(?:\s*[\(\[]\s*\d{1,2}\s*[\)\]])?[\s,]*)+)$/.test(restText);
  if (isScoreOnly) {
    const sets = parseScoreSets(restText);
    const scoreText = formatSets(sets);
    const oldScore = match.score;

    stats.updateMatch(match.id, {
      score: scoreText,
      sets,
      format: 'vs'
    });

    return `✏️ *Updated match score:*\n` +
      `• *Match:* ${match.winner} vs ${match.loser}\n` +
      `• *Was:* ${oldScore}\n` +
      `• *Now:* ${scoreText}\n` +
      `• Player ratings and monthly leaderboard have been recalculated.`;
  }

  return 'Could not parse new score. Use: "!editscore <#|ID> <score>" (e.g. "!editscore #1 6-3 6-4"), "!editscore <#|ID> <winner> def <loser> <score>", or "!editscore <#|ID> <side1> vs <side2> <score>".';
}

function applyScoreReport({ winners, losers, sets, format = 'vs', assumedScore = false, inferredOpponents = false, chatId = null }) {
  const winnerText = formatSide(winners);
  const loserText = formatSide(losers);
  const scoreText = formatSets(sets);

  const { sets: rated, changes } = ratings.applyResult(winners, losers, sets);
  const storedChanges = changes.map((c) => ({
    name: c.name,
    delta: typeof c.delta === 'number' ? c.delta : Number((c.to - c.from).toFixed(2))
  }));
  stats.recordMatch(winnerText, loserText, scoreText, { winners, losers, sets, format: 'vs', ratingChanges: storedChanges, chatId });

  const lines = [`Recorded: ${winnerText} vs ${loserText} (${scoreText}).`];

  const notes = [];
  if (assumedScore) notes.push(`no score given, so I assumed ${scoreText}`);
  if (inferredOpponents) notes.push("opponents from today's draw");
  if (notes.length > 0) lines.push(`(${notes.join('; ')})`);

  const upsets = rated.filter((s) => s.upset).length;
  if (upsets > 0) {
    lines.push(`${upsets === rated.length ? 'Upset' : `${upsets} upset set(s)`} -- the lower-rated pairing came through.`);
  }

  lines.push(...changes.map((c) => {
    const move = c.to === c.from ? 'no change' : `${c.to > c.from ? '▲' : '▼'} ${ratings.formatRating(Math.abs(c.to - c.from))}`;
    return `  ${c.name}: ${ratings.formatRating(c.from)} → ${ratings.formatRating(c.to)} (${move})`;
  }));
  lines.push('Check "!leaderboard" for standings, "!ratings" for ratings.');

  return lines.join('\n');
}

function handleScoreCommand(text, chatId = null) {
  let cleanText = text;
  if (typeof extractGroupFlag === 'function') {
    const extracted = extractGroupFlag(text);
    cleanText = extracted.cleanText;
  }

  const bodyMatch = cleanText.match(/^!score\s+(.+)$/i);
  const parsed = bodyMatch ? parseMatchResultExpression(bodyMatch[1], chatId) : null;
  if (!parsed) {
    return 'Couldn\'t parse that. Use: !score <side1> vs <side2> <score> or !score <winner> def <loser> <score>\ne.g. "!score Mike vs John 6-4 4-6" or "!score Mike & Sara vs John & Alex 6-4 6-2"';
  }
  if (parsed.error) {
    return parsed.error;
  }

  const { winners, losers, sets, format } = parsed;
  return applyScoreReport({ winners, losers, sets, format, chatId });
}

function handleFreeformScore(candidates, chatId, sender, activePolls = new Map(), lastSchedule = null) {
  const roster = knownPlayers(chatId, activePolls);
  const self = roster.get(ratings.keyFor(sender)) || null;

  const options = {
    resolveName: (raw) => {
      const key = ratings.keyFor(raw);
      if (SELF_WORDS.has(key)) return self;
      return roster.get(key) || null;
    },
    findMatchup: (names, versus) => findMatchupFor(lastSchedule, names, versus)
  };

  let report = null;
  for (const candidate of new Set(candidates.filter(Boolean))) {
    report = parseScoreReport(candidate, options);
    if (report) break;
  }

  if (!report) return null;

  const signature = [
    formatSide(report.winners),
    formatSide(report.losers),
    formatSets(report.sets)
  ].join('|').toLowerCase();

  const previous = recentFreeformScores.get(chatId);
  if (previous?.signature === signature && Date.now() - previous.at < FREEFORM_DUPLICATE_WINDOW_MS) {
    console.log(`[score] Ignoring repeat free-form result: ${signature}`);
    return null;
  }
  recentFreeformScores.set(chatId, { signature, at: Date.now() });

  console.log(
    `[score] Free-form result understood: ${formatSide(report.winners)} vs ` +
    `${formatSide(report.losers)} (${formatSets(report.sets)})` +
    `${report.assumedScore ? ' [assumed score]' : ''}${report.inferredOpponents ? ' [inferred opponents]' : ''}`
  );

  return applyScoreReport({ ...report, chatId });
}

module.exports = {
  formatLeaderboard,
  handleListScores,
  canUserManageScore,
  handleDeleteScore,
  handleEditScore,
  parseSide,
  parseMatchResultExpression,
  applyScoreReport,
  handleScoreCommand,
  handleFreeformScore
};
