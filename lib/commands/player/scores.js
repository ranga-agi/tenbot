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

function formatLeaderboard(chatId = null, options = {}) {
  const board = stats.getLeaderboard(chatId, options);
  const now = options.now || new Date();
  const sj = stats.getSanJoseParts ? stats.getSanJoseParts(now) : null;
  const monthNames = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const curMonthIdx = sj ? sj.month : now.getMonth();
  const curYear = sj ? sj.year : now.getFullYear();
  const monthLabel = options.allTime ? 'All-Time (Last 2 Weeks)' : `${monthNames[curMonthIdx]} ${curYear}`;

  if (board.length === 0) {
    return `No matches recorded for ${monthLabel} yet. Use "!score <winner> def <loser> <score>" to log one.`;
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
    `• *Match:* ${deleted.winner} def ${deleted.loser} (${deleted.score})\n` +
    `• *Date:* ${stats.formatMatchDate(deleted.date)}\n` +
    `• Player ratings and monthly leaderboard have been restored.`;
}

async function handleEditScore(sock, chatId, senderJid, sender, rawArgs) {
  if (!rawArgs) {
    return 'Usage: "!editscore <#|ID> <new score>" or "!editscore <#|ID> <winner> def <loser> <new score>"\ne.g. "!editscore #1 6-3 6-4" or "!editscore #1 Mike def John 6-3 6-4"';
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

  // Case 1: Full def phrase: e.g. "Mike & Sara def John & Alex 6-4 6-2"
  const defMatch = restText.match(/^(.+?)\s+(?:def|beat|beats|defeated|defeats|d\.)\s+(.+?)\s+((?:[0-9]{1,2}\s*[-–—:]\s*[0-9]{1,2}(?:\s*[\(\[]\s*\d{1,2}\s*[\)\]])?[\s,]*)+)$/i);
  if (defMatch) {
    const [, winner, loser, score] = defMatch;
    let winners = parseSide(winner);
    let losers = parseSide(loser);
    const sets = parseScoreSets(score);

    if (winners.length !== losers.length) {
      return `Both sides need the same number of players -- got ${winners.length} vs ${losers.length}.`;
    }

    winners = resolveCanonicalPlayers(winners, chatId);
    losers = resolveCanonicalPlayers(losers, chatId);

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
      sets
    });

    return `✏️ *Updated match score:*\n` +
      `• *Was:* ${oldWinner} def ${oldLoser} (${oldScore})\n` +
      `• *Now:* ${winnerText} def ${loserText} (${scoreText})\n` +
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
      sets
    });

    return `✏️ *Updated match score:*\n` +
      `• *Match:* ${match.winner} def ${match.loser}\n` +
      `• *Was:* ${oldScore}\n` +
      `• *Now:* ${scoreText}\n` +
      `• Player ratings and monthly leaderboard have been recalculated.`;
  }

  return 'Could not parse new score. Use: "!editscore <#|ID> <score>" (e.g. "!editscore #1 6-3 6-4") or "!editscore <#|ID> <winner> def <loser> <score>".';
}

function applyScoreReport({ winners, losers, sets, assumedScore = false, inferredOpponents = false, chatId = null }) {
  const winnerText = formatSide(winners);
  const loserText = formatSide(losers);
  const scoreText = formatSets(sets);

  const { sets: rated, changes } = ratings.applyResult(winners, losers, sets);
  const storedChanges = changes.map((c) => ({
    name: c.name,
    delta: typeof c.delta === 'number' ? c.delta : Number((c.to - c.from).toFixed(2))
  }));
  stats.recordMatch(winnerText, loserText, scoreText, { winners, losers, sets, ratingChanges: storedChanges, chatId });

  const lines = [`Recorded: ${winnerText} def ${loserText} (${scoreText}).`];

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
  const match = cleanText.match(/^!score\s+(.+?)\s+(?:def|beat|beats|defeated|defeats|d\.)\s+(.+?)\s+((?:[0-9]{1,2}\s*[-–—:]\s*[0-9]{1,2}(?:\s*[\(\[]\s*\d{1,2}\s*[\)\]])?[\s,]*)+)$/i);
  if (!match) {
    return 'Couldn\'t parse that. Use: !score <winner> def <loser> <score>\ne.g. "!score Mike def John 6-4 6-2" or "!score Mike & Sara def John & Alex 6-4 6-2"';
  }

  const [, winner, loser, score] = match;
  let winners = parseSide(winner);
  let losers = parseSide(loser);
  const sets = parseScoreSets(score);

  if (winners.length !== losers.length) {
    return `Both sides need the same number of players -- got ${winners.length} vs ${losers.length}.`;
  }

  winners = resolveCanonicalPlayers(winners, chatId);
  losers = resolveCanonicalPlayers(losers, chatId);

  return applyScoreReport({ winners, losers, sets, chatId });
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
    `[score] Free-form result understood: ${formatSide(report.winners)} def ` +
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
  applyScoreReport,
  handleScoreCommand,
  handleFreeformScore
};
