/**
 * Player Ratings & TennisRecord Configuration Handlers
 */

const ratings = require('../../ratings');
const namesStore = require('../../names');
const tennisRecord = require('../../tennisRecord');
const { isUserAdmin } = require('../groupCommands');
const { nameFor, canUserManagePlayerAlias } = require('./profile');

const TRIGGER_PREFIX = '@tenbot';

async function resolveRatingTarget(sock, chatId, senderJid, senderName, playerName, actionVerb) {
  const targetPlayer = playerName || senderName || (senderJid ? nameFor(senderJid) : 'me');
  const canManage = await canUserManagePlayerAlias(sock, chatId, senderJid, senderName, targetPlayer);
  if (!canManage) {
    return {
      error: `⚠️ Only group admins can ${actionVerb} ratings for other players. You can ${actionVerb === 'update' ? 'set' : actionVerb} your own rating.`
    };
  }

  let targetJid = null;
  const tKey = ratings.keyFor(targetPlayer);
  const isSelf = ['me', 'myself', 'my', 'i'].includes(tKey) ||
    (senderName && ratings.keyFor(senderName) === tKey) ||
    (senderJid && ratings.keyFor(nameFor(senderJid)) === tKey);

  let resolvedPlayerName = targetPlayer;
  if (isSelf) {
    targetJid = senderJid || null;
    resolvedPlayerName = senderName !== 'Someone' ? senderName : (senderJid ? nameFor(senderJid) : 'Player');
  } else {
    const match = namesStore.findIdByNameOrAlias(targetPlayer, chatId);
    if (match) {
      targetJid = match.id || null;
      resolvedPlayerName = match.entry?.name || targetPlayer;
    }
  }

  return { targetJid, resolvedPlayerName };
}

async function handleSetRating(sock, chatId, senderJid, senderName, playerName, ratingVal) {
  if (typeof ratingVal !== 'number' || Number.isNaN(ratingVal) || ratingVal < ratings.MIN_RATING || ratingVal > ratings.MAX_RATING) {
    return `Please provide a valid rating between ${ratings.MIN_RATING} and ${ratings.MAX_RATING}, e.g. "!setrating 3.5" or "${TRIGGER_PREFIX} set my rating to 4.0".`;
  }

  const resolved = await resolveRatingTarget(sock, chatId, senderJid, senderName, playerName, 'update');
  if (resolved.error) return resolved.error;

  const updated = ratings.setRating(resolved.resolvedPlayerName, ratingVal, { jid: resolved.targetJid });
  return `Updated rating for ${resolved.resolvedPlayerName} to ${ratings.formatRating(updated)}.`;
}

async function handleResetRating(sock, chatId, senderJid, senderName, playerName) {
  const resolved = await resolveRatingTarget(sock, chatId, senderJid, senderName, playerName, 'reset');
  if (resolved.error) return resolved.error;

  const res = await ratings.resetRating(resolved.resolvedPlayerName, { jid: resolved.targetJid, sock });
  if (!res) {
    return `Could not reset rating for "${resolved.resolvedPlayerName}".`;
  }

  if (res.tennisRecord === false) {
    return `🔄 Reset rating for "${res.name}" to default ${ratings.formatRating(res.rating)} (TennisRecord profile not verified; automatic updates paused).`;
  }

  const locStr = res.tennisRecordLocation ? ` (${res.tennisRecordLocation})` : '';
  const urlStr = res.tennisRecordUrl ? ` -> ${res.tennisRecordUrl}` : '';
  return `🔄 Reset rating for "${res.name}" to baseline ${ratings.formatRating(res.rating)}${locStr}${urlStr}.`;
}

async function handleUnsetRating(sock, chatId, senderJid, senderName, targetPlayerName, explicitRating = null) {
  const resolved = await resolveRatingTarget(sock, chatId, senderJid, senderName, targetPlayerName, 'unset');
  if (resolved.error) return resolved.error;

  const res = ratings.unsetRating(resolved.resolvedPlayerName, explicitRating, { jid: resolved.targetJid });
  if (!res) {
    return `Could not unset rating for "${resolved.resolvedPlayerName}".`;
  }

  const ratingStr = ratings.formatRating(res.rating);
  return `ℹ️ Marked "${res.name}" as not having a TennisRecord profile (automatic updates paused). Rating set to ${ratingStr}.`;
}

function parseRatingNameAndNumber(raw, defaultSenderName = null) {
  const forMatch = raw.match(/^for\s+(.+?)\s*(?:=|\bto\b|:)?\s*(\d+(?:\.\d+)?)$/i) ||
                   raw.match(/^(.+?)\s+\bfor\b\s+(\d+(?:\.\d+)?)$/i);
  if (forMatch) {
    return { name: forMatch[1].trim(), rating: parseFloat(forMatch[2]) };
  }

  const delimMatch = raw.match(/^(.+?)\s*(?:=|:|->|\bto\b|\bas\b)\s*(\d+(?:\.\d+)?)$/i);
  if (delimMatch) {
    return { name: delimMatch[1].trim(), rating: parseFloat(delimMatch[2]) };
  }

  const spaceMatch = raw.match(/^(.+?)\s+(\d+(?:\.\d+)?)$/);
  if (spaceMatch && Number.isNaN(parseFloat(spaceMatch[1]))) {
    return { name: spaceMatch[1].trim(), rating: parseFloat(spaceMatch[2]) };
  }

  const num = parseFloat(raw);
  if (!Number.isNaN(num) && /^\d+(?:\.\d+)?$/.test(raw)) {
    return { name: defaultSenderName || 'me', rating: num };
  }

  return null;
}

function parseUnsetRatingCommand(text, defaultSenderName = null) {
  const raw = text.replace(/^!(?:unsetrating|notennisrecord|unrated|norating)\s*/i, '').trim();
  if (!raw) {
    return { name: defaultSenderName || 'me', rating: null };
  }

  const parsed = parseRatingNameAndNumber(raw, defaultSenderName);
  if (parsed) return parsed;

  const cleanName = raw.replace(/^for\s+/i, '').trim();
  return { name: cleanName, rating: null };
}

function parseSetRatingCommand(text, defaultSenderName = null) {
  const raw = text.replace(/^!(?:myrating|setrating)\s*/i, '').trim();
  if (!raw) return null;

  const parsed = parseRatingNameAndNumber(raw, defaultSenderName);
  if (parsed) return parsed;

  const num = parseFloat(raw);
  if (!Number.isNaN(num)) {
    return { name: defaultSenderName || 'me', rating: num };
  }

  return null;
}

function formatRatings(chatId = null) {
  const board = ratings.getAllRatings();
  if (board.length === 0) {
    return `Nobody's rated yet -- everyone starts from their TennisRecord rating (or ${ratings.formatRating(ratings.INITIAL_RATING)}) once they play a poll or set their rating.`;
  }
  const groupMembers = chatId ? namesStore.getGroupMembers(chatId) : null;
  const filteredBoard = groupMembers
    ? board.filter((p) => {
        const idNorm = (p.id || '').toLowerCase();
        const numOnly = idNorm.split('@')[0];
        const pnNorm = (p.pn || '').toLowerCase();
        const pnNum = pnNorm.split('@')[0];
        const nameKey = ratings.keyFor(p.name);
        return (
          groupMembers.has(idNorm) ||
          (numOnly && groupMembers.has(numOnly)) ||
          (pnNorm && groupMembers.has(pnNorm)) ||
          (pnNum && groupMembers.has(pnNum)) ||
          groupMembers.has(nameKey)
        );
      })
    : board;

  if (filteredBoard.length === 0) {
    return `Nobody in this group has a recorded rating yet -- players start from their TennisRecord rating (or ${ratings.formatRating(ratings.INITIAL_RATING)}) once they vote in a match poll or set their rating.`;
  }

  const lines = filteredBoard.map((p, i) => `${i + 1}. ${p.name} — ${ratings.formatRating(p.rating)}`);
  return `📊 Player ratings (${ratings.formatRating(ratings.MIN_RATING)}–${ratings.MAX_RATING}):\n${lines.join('\n')}`;
}

async function handleTennisRecordConfigCommand(sock, chatId, senderJid, text) {
  const rawArgs = text.replace(/^!(?:trconfig|tennisrecordconfig|tennisrecord)\s*/i, '').trim();
  if (!rawArgs || rawArgs.toLowerCase() === 'get' || rawArgs.toLowerCase() === 'status' || rawArgs.toLowerCase() === 'show') {
    return tennisRecord.formatConfig();
  }

  const isAdmin = await isUserAdmin(sock, chatId, senderJid);
  if (!isAdmin) {
    return '⚠️ Only group admins can update TennisRecord configuration.';
  }

  const cleanArgs = rawArgs.replace(/^set\s+/i, '').trim();
  const match = cleanArgs.match(/^([a-zA-Z0-9_-]+)\s*(?:=|\s+)\s*(.+)$/);
  if (!match) {
    return 'Usage: `!trconfig` to view settings, or `!trconfig set <key>=<value>` (e.g. `!trconfig set timeout=8000`, `!trconfig set certstatus=suspended`, `!trconfig set url=https://www.tennisrecord.com`)';
  }

  const key = match[1].toLowerCase().replace(/[-_]/g, '');
  const val = match[2].trim();

  const updateObj = {};
  if (key === 'url' || key === 'baseurl' || key === 'host') {
    updateObj.url = val;
  } else if (key === 'certstatus' || key === 'sslstatus' || key === 'certcheck') {
    updateObj.certStatus = val;
  } else if (key === 'timeout' || key === 'timeoutms') {
    updateObj.timeout = val;
  } else if (key === 'useragent') {
    updateObj.userAgent = val;
  } else if (key === 'preferredlocation' || key === 'location') {
    updateObj.preferredLocation = val;
  } else if (key === 'refreshintervaldays' || key === 'refreshdays' || key === 'refreshinterval') {
    updateObj.refreshIntervalDays = Number(val);
  } else if (key === 'enabled') {
    updateObj.enabled = val === 'true' || val === '1' || val === 'on';
  } else if (key === 'maxredirects') {
    updateObj.maxRedirects = Number(val);
  } else {
    return `⚠️ Unknown configuration setting "${match[1]}". Available settings: url, certstatus, timeout, userAgent, preferredLocation, refreshIntervalDays, enabled, maxRedirects.`;
  }

  tennisRecord.updateConfig(updateObj);
  return `✅ Updated TennisRecord configuration:\n\n${tennisRecord.formatConfig()}`;
}

module.exports = {
  TRIGGER_PREFIX,
  formatRatings,
  parseSetRatingCommand,
  handleSetRating,
  handleResetRating,
  handleUnsetRating,
  parseUnsetRatingCommand,
  handleTennisRecordConfigCommand
};
