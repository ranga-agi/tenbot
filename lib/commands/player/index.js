/**
 * Player, Rating, Alias, Availability, and Score Commands
 * Main dispatcher (handlePlayerCommand, executePlayerTool) & unified exports.
 */

const stats = require('../../stats');
const ratings = require('../../ratings');
const tennisRecord = require('../../tennisRecord');
const { isUserAdmin, extractGroupFlag, resolveTargetChat } = require('../groupCommands');
const playerActivity = require('../../playerActivity');
const { normalizeCommandDashes } = require('../../textNormalize');

const profile = require('./profile');
const ratingsCmd = require('./ratings');
const scores = require('./scores');

const {
  nameFor,
  canUserManagePlayerAlias,
  knownPlayers,
  handleSetFullName,
  parseFullNameCommand,
  parseAliasCommand,
  formatAliases,
  handleAliasQuery,
  handleGetAliases,
  handleAddAlias,
  handleDeleteAlias,
  formatAvailability,
  handlePlayerActivity,
  handleLatestActivity,
  handleInactivePlayers
} = profile;

const {
  TRIGGER_PREFIX,
  formatRatings,
  handleGetRatings,
  parseSetRatingCommand,
  handleSetRating,
  handleResetRating,
  handleUnsetRating,
  parseUnsetRatingCommand,
  handleTennisRecordConfigCommand
} = ratingsCmd;

const {
  formatLeaderboard,
  publishMonthlyLeaderboards,
  handleListScores,
  canUserManageScore,
  handleDeleteScore,
  handleEditScore,
  parseSide,
  parseMatchResultExpression,
  applyScoreReport,
  applyMultipleScoreReports,
  splitScoreCommandEntries,
  handleScoreCommand,
  handleReportScore,
  handleFreeformScore
} = scores;

/**
 * Handles text commands for player ratings, aliases, full names, availability, and score reports.
 */
async function handlePlayerCommand(sock, rawText, chatId, sender, senderJid, msg, activePolls = new Map(), context = {}) {
  const text = normalizeCommandDashes(rawText);
  const lower = text.toLowerCase();

  // Extract --group flag if present and resolve target group for DMs or explicit queries
  const { groupQuery, cleanText: commandText } = (typeof extractGroupFlag === 'function')
    ? extractGroupFlag(text)
    : { groupQuery: null, cleanText: text };
  let effectiveChatId = chatId;

  if (groupQuery || (chatId && !chatId.endsWith('@g.us'))) {
    try {
      if (typeof resolveTargetChat === 'function') {
        const targetRes = await resolveTargetChat(sock, chatId, senderJid, groupQuery, { ...context, activePolls }, { requireAdmin: false });
        if (targetRes && !targetRes.error && targetRes.targetChatId) {
          effectiveChatId = targetRes.targetChatId;
        } else if (groupQuery && targetRes?.error) {
          return targetRes.error;
        }
      }
    } catch (_) {}
  }

  // Availability
  if (lower.startsWith('!free')) {
    const when = commandText.slice('!free'.length).trim();
    if (!when) return formatAvailability(effectiveChatId);
    stats.setAvailable(sender, when, effectiveChatId);
    return `Got it, ${sender} is free ${when}. Send "!free" to see the full list.`;
  }

  if (lower === '!notfree') {
    stats.removeAvailable(sender, effectiveChatId);
    return `Removed ${sender} from the availability list.`;
  }

  if (lower === '!clearfree') {
    const isAdmin = await isUserAdmin(sock, effectiveChatId, senderJid);
    if (!isAdmin) {
      return '⚠️ Only group admins can use !clearfree.';
    }
    stats.clearAvailability(effectiveChatId);
    return 'Availability list cleared for everyone.';
  }

  // Aliases
  const commandLower = commandText.toLowerCase();
  if (commandLower === '!aliases' || commandLower === '!alias list') {
    return formatAliases();
  }

  const aliasesPlayerMatch = commandText.match(/^!aliases\s+([\s\S]+)$/i);
  if (aliasesPlayerMatch) {
    return handleAliasQuery({
      query: aliasesPlayerMatch[1],
      sender,
      senderJid,
      chatId: effectiveChatId
    });
  }

  const aliasLookupMatch = commandText.match(/^!alias(?:\s+([\s\S]*))?$/i);
  if (aliasLookupMatch) {
    return handleAliasQuery({
      query: aliasLookupMatch[1] || '',
      sender,
      senderJid,
      chatId: effectiveChatId
    });
  }

  if (/^!(?:setalias|addalias)\b/i.test(commandLower)) {
    const senderDisplayName = sender !== 'Someone' ? sender : (senderJid ? nameFor(senderJid) : 'me');
    const parsed = parseAliasCommand(commandText, senderDisplayName);
    if (!parsed || !parsed.name || !parsed.alias) {
      return 'Couldn\'t parse that. Use: "!setalias <alias>" (for yourself) or "!setalias <player name> = <alias>"\ne.g. "!setalias PK" or "!setalias Jonathan Doe = JD"';
    }
    return await handleAddAlias({
      sock,
      chatId: effectiveChatId,
      senderJid,
      sender,
      playerName: parsed.name,
      aliasName: parsed.alias,
      isTool: false
    });
  }

  if (/^!(?:deletealias|delalias|removealias|rmalias)\b/i.test(commandLower)) {
    const parsed = parseAliasCommand(commandText) || { name: null, alias: commandText.replace(/^!(?:deletealias|delalias|removealias|rmalias)\s*/i, '').trim() };
    if (!parsed || (!parsed.name && !parsed.alias)) {
      return 'Use: !deletealias <player name> = <alias> or !deletealias <alias>\ne.g. "!deletealias Jonathan Doe = JD" or "!deletealias JD"';
    }
    const targetAlias = parsed.alias || parsed.name;
    const targetPlayer = parsed.alias ? parsed.name : null;
    return await handleDeleteAlias({
      sock,
      chatId: effectiveChatId,
      senderJid,
      sender,
      targetPlayer,
      targetAlias,
      isTool: false
    });
  }

  // Full Name
  if (lower.startsWith('!setfullname') || lower.startsWith('!fullname')) {
    const senderDisplayName = sender !== 'Someone' ? sender : (senderJid ? nameFor(senderJid) : 'me');
    const parsed = parseFullNameCommand(text, senderDisplayName);
    if (!parsed || !parsed.fullName) {
      return 'Please provide a full name. Use: "!fullname <full name>" or "!setfullname <player name> = <full name>"\ne.g. "!fullname Roger Federer" or "!setfullname John = Johnathan Smith"';
    }
    return await handleSetFullName(sock, chatId, senderJid, sender, parsed.name, parsed.fullName);
  }

  // Player Activity & Inactive Players
  if (lower === '!activity' || lower.startsWith('!activity ') ||
      lower === '!playeractivity' || lower.startsWith('!playeractivity ') ||
      lower === '!lastactivity' || lower.startsWith('!lastactivity ')) {
    const rawArg = text.replace(/^!(?:activity|playeractivity|lastactivity)\s*/i, '').trim();
    return await handlePlayerActivity(sock, chatId, sender, rawArg || null);
  }

  if (lower === '!latestactivity' || lower.startsWith('!latestactivity ') ||
      lower === '!singleactivity' || lower.startsWith('!singleactivity ')) {
    const rawArg = text.replace(/^!(?:latestactivity|singleactivity)\s*/i, '').trim();
    return await handleLatestActivity(sock, chatId, sender, rawArg || null);
  }

  if (lower === '!inactiveplayers' || lower.startsWith('!inactiveplayers ') ||
      lower === '!inactive' || lower.startsWith('!inactive ') ||
      lower === '!inactiveplayer' || lower.startsWith('!inactiveplayer ')) {
    const rawArg = text.replace(/^!(?:inactiveplayers|inactiveplayer|inactive)\s*/i, '').trim();
    return await handleInactivePlayers(sock, chatId, sender, rawArg || null);
  }

  if (lower === '!checkinactivity' || lower === '!inactivitycheck') {
    const res = await playerActivity.checkInactivityMilestones(sock, chatId, { activePolls });
    return `🔍 *Inactivity Check:* Evaluated ${res.checked} player(s).\n` +
      `• 50% Encouragements sent: ${res.halfway.length ? res.halfway.join(', ') : 'None'}\n` +
      `• 75% Participation checks sent: ${res.threeQuarter.length ? res.threeQuarter.join(', ') : 'None'}\n` +
      `• 100% Inactive marked (DMs sent): ${res.inactive.length ? res.inactive.join(', ') : 'None'}`;
  }

  // Scores & Leaderboard
  if (lower === '!scores' || lower.startsWith('!scores ') || lower === '!results' || lower.startsWith('!results ')) {
    const rawArg = commandText.replace(/^!(?:scores|results)\s*/i, '').trim();
    return handleListScores(effectiveChatId, rawArg || null);
  }

  if (/^!(?:deletescore|removescore|delscore|cancelscore)\b/i.test(lower)) {
    const target = commandText.replace(/^!(?:deletescore|removescore|delscore|cancelscore)\s*/i, '').trim();
    return await handleDeleteScore(sock, effectiveChatId, senderJid, sender, target);
  }

  if (/^!(?:editscore|updatescore|modifyscore)\b/i.test(lower)) {
    const rawArgs = commandText.replace(/^!(?:editscore|updatescore|modifyscore)\s*/i, '').trim();
    return await handleEditScore(sock, effectiveChatId, senderJid, sender, rawArgs);
  }

  if (lower.startsWith('!score')) {
    return handleScoreCommand(commandText, effectiveChatId);
  }

  if (/^!(?:leaderboard|standings)\b/i.test(lower)) {
    const rawArgs = commandText.replace(/^!(?:leaderboard|standings)\s*/i, '').trim().toLowerCase();
    const isAll = ['--all', '-a', 'all', 'alltime', 'all-time'].includes(rawArgs);
    return formatLeaderboard(isAll ? null : effectiveChatId, { allTime: isAll });
  }

  // Ratings
  if (lower.startsWith('!myrating') || lower.startsWith('!setrating')) {
    const parsed = parseSetRatingCommand(text, sender);
    if (!parsed) {
      return `Please provide a valid rating between ${ratings.MIN_RATING} and ${ratings.MAX_RATING}, e.g. "!setrating 3.5" or "${TRIGGER_PREFIX} set my rating to 4.0".`;
    }
    return await handleSetRating(sock, chatId, senderJid, sender, parsed.name, parsed.rating);
  }

  if (lower.startsWith('!resetrating') || lower.startsWith('!ratingreset')) {
    const raw = text.replace(/^!(?:resetrating|ratingreset)\s*/i, '').trim();
    return await handleResetRating(sock, chatId, senderJid, sender, raw || null);
  }

  if (lower.startsWith('!unsetrating') || lower.startsWith('!notennisrecord') || lower.startsWith('!unrated') || lower.startsWith('!norating')) {
    const parsed = parseUnsetRatingCommand(text, sender);
    return await handleUnsetRating(sock, chatId, senderJid, sender, parsed.name, parsed.rating);
  }

  if (lower === '!ratings') {
    return formatRatings(effectiveChatId);
  }

  // TennisRecord Certificate Check Management
  if (lower === '!suspendcert' || lower === '!suspendcertcheck' || lower === '!certcheck suspend' || lower === '!certcheck off') {
    const isAdmin = await isUserAdmin(sock, chatId, senderJid);
    if (!isAdmin) {
      return '⚠️ Only group admins can change SSL certificate verification settings.';
    }
    tennisRecord.suspendCertCheck();
    return '🔓 TennisRecord SSL certificate validation suspended. Lookups will proceed even if certificates are expired or invalid.';
  }

  if (lower === '!resumecert' || lower === '!resumecertcheck' || lower === '!certcheck resume' || lower === '!certcheck on') {
    const isAdmin = await isUserAdmin(sock, chatId, senderJid);
    if (!isAdmin) {
      return '⚠️ Only group admins can change SSL certificate verification settings.';
    }
    tennisRecord.resumeCertCheck();
    return '🔒 TennisRecord SSL certificate validation resumed (strict verification enabled).';
  }

  if (lower === '!certstatus' || lower === '!certcheck' || lower === '!sslstatus') {
    const isSuspended = tennisRecord.getCertCheckSuspended();
    return `🔒 TennisRecord SSL certificate check status: ${isSuspended ? 'SUSPENDED (insecure / expired certs allowed)' : 'ACTIVE (strict verification enabled)'}.`;
  }

  if (lower === '!trconfig' || lower === '!tennisrecord' || lower === '!tennisrecordconfig' || lower.startsWith('!trconfig ') || lower.startsWith('!tennisrecord ') || lower.startsWith('!tennisrecordconfig ')) {
    return await handleTennisRecordConfigCommand(sock, chatId, senderJid, text);
  }

  if (lower === '!refreshratings' || lower === '!refreshratings all' || lower === '!refreshratings --all') {
    const isAdmin = await isUserAdmin(sock, chatId, senderJid);
    if (!isAdmin) {
      return '⚠️ Only group admins can use !refreshratings.';
    }
    const includePaused = lower.includes('all');
    console.log(`[commands] Admin ${sender} (${senderJid}) triggered !refreshratings in ${chatId} (includePaused: ${includePaused})`);
    const { checkedCount, updatedCount } = await ratings.refreshPeriodicRatings({ force: true, includePaused });
    return `Checked ${checkedCount} player(s) on TennisRecord.com: updated ${updatedCount} rating(s).`;
  }

  return null;
}

/**
 * Handles LLM tool calls for player profile and rating management.
 */
async function executePlayerTool(sock, name, input, sender, senderJid, chatId, context = {}) {
  let effectiveChatId = chatId;
  const usesGroupTarget = [
    'get_scores', 'report_score', 'record_score', 'add_score', 'log_score',
    'delete_score', 'cancel_score', 'edit_score', 'update_score',
    'get_leaderboard', 'get_standings',
    'get_availability', 'who_is_free'
  ].includes(name);
  if (usesGroupTarget && (input?.group || (chatId && !chatId.endsWith('@g.us')))) {
    try {
      if (typeof resolveTargetChat === 'function') {
        const targetRes = await resolveTargetChat(sock, chatId, senderJid, input?.group || null, context, { requireAdmin: false });
        if (targetRes && !targetRes.error && targetRes.targetChatId) {
          effectiveChatId = targetRes.targetChatId;
        } else if (input?.group && targetRes?.error) {
          return targetRes.error;
        }
      }
    } catch (_) {}
  }

  if (name === 'add_alias') {
    const { player, alias } = input;
    if (!player || !alias) return 'Please provide both player name and alias.';
    return await handleAddAlias({
      sock,
      chatId,
      senderJid,
      sender,
      playerName: player,
      aliasName: alias,
      isTool: true
    });
  }

  if (name === 'remove_alias') {
    const { player, alias } = input;
    const targetAlias = alias || player;
    const targetPlayer = alias ? player : null;
    if (!targetAlias) return 'Please provide the alias to remove.';
    return await handleDeleteAlias({
      sock,
      chatId,
      senderJid,
      sender,
      targetPlayer,
      targetAlias,
      isTool: true
    });
  }

  if (name === 'get_aliases') {
    return handleGetAliases({
      player: input?.player || null,
      alias: input?.alias || null,
      chatId
    });
  }

  if (name === 'set_full_name') {
    const { fullName, player } = input;
    return await handleSetFullName(sock, chatId, senderJid, sender, player, fullName);
  }

  if (name === 'get_ratings') {
    return handleGetRatings({
      player: input?.player || null,
      sender,
      senderJid,
      chatId
    });
  }

  if (name === 'set_rating') {
    const newRating = input.rating;
    return await handleSetRating(sock, chatId, senderJid, sender, input.player || null, newRating);
  }

  if (name === 'reset_rating') {
    return await handleResetRating(sock, chatId, senderJid, sender, input.player || null);
  }

  if (name === 'unset_rating') {
    return await handleUnsetRating(sock, chatId, senderJid, sender, input?.player || null, input?.rating || null);
  }

  if (name === 'get_player_activity') {
    return await handlePlayerActivity(sock, chatId, sender, input?.player || null);
  }

  if (name === 'get_latest_activity') {
    return await handleLatestActivity(sock, chatId, sender, input?.player || null);
  }

  if (name === 'get_inactive_players') {
    return await handleInactivePlayers(sock, chatId, sender, input?.period || null);
  }

  if (name === 'get_scores') {
    return handleListScores(effectiveChatId, input?.query || null, {
      player: input?.player || null,
      limit: input?.limit ?? null,
      sender
    });
  }

  if (name === 'report_score' || name === 'record_score' || name === 'add_score' || name === 'log_score') {
    return handleReportScore({
      chatId: effectiveChatId,
      sender,
      senderJid,
      side1: input?.side1 ?? input?.winners ?? null,
      side2: input?.side2 ?? input?.losers ?? null,
      score: input?.score || null,
      text: input?.text || null
    });
  }

  if (name === 'delete_score' || name === 'cancel_score') {
    return await handleDeleteScore(sock, effectiveChatId, senderJid, sender, input?.scoreId || input?.matchId || input?.id);
  }

  if (name === 'edit_score' || name === 'update_score') {
    const scoreId = input?.scoreId || input?.matchId || input?.id || '';
    if (!scoreId) {
      return await handleEditScore(sock, effectiveChatId, senderJid, sender, '');
    }
    const scorePart = input?.score || input?.text || '';
    let rawRest = scorePart;
    if (input?.side1 && input?.side2) {
      const s1 = Array.isArray(input.side1) ? input.side1.join(' & ') : String(input.side1);
      const s2 = Array.isArray(input.side2) ? input.side2.join(' & ') : String(input.side2);
      rawRest = `${s1} vs ${s2} ${scorePart}`.trim();
    }
    const raw = `${scoreId} ${rawRest}`.trim();
    return await handleEditScore(sock, effectiveChatId, senderJid, sender, raw);
  }

  if (name === 'get_leaderboard' || name === 'get_standings') {
    const isAll = Boolean(input?.allTime);
    const boardChatId = isAll ? null : (effectiveChatId?.endsWith('@g.us') ? effectiveChatId : null);
    return formatLeaderboard(boardChatId, { allTime: isAll });
  }

  if (name === 'get_availability' || name === 'who_is_free') {
    const availChatId = effectiveChatId?.endsWith('@g.us') ? effectiveChatId : null;
    return formatAvailability(availChatId);
  }

  return `Unknown player tool ${name}`;
}

module.exports = {
  formatAvailability,
  formatAliases,
  handleAliasQuery,
  handleGetAliases,
  parseAliasCommand,
  canUserManagePlayerAlias,
  parseFullNameCommand,
  handleSetFullName,
  formatRatings,
  handleGetRatings,
  parseSetRatingCommand,
  handleSetRating,
  handleResetRating,
  handleUnsetRating,
  parseUnsetRatingCommand,
  formatLeaderboard,
  publishMonthlyLeaderboards,
  parseSide,
  splitScoreCommandEntries,
  parseMatchResultExpression,
  applyScoreReport,
  applyMultipleScoreReports,
  handleScoreCommand,
  handleReportScore,
  knownPlayers,
  handleFreeformScore,
  handlePlayerCommand,
  handlePlayerActivity,
  handleLatestActivity,
  handleInactivePlayers,
  handleListScores,
  handleDeleteScore,
  handleEditScore,
  canUserManageScore,
  executePlayerTool,
  nameFor
};
