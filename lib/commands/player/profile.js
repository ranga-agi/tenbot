/**
 * Player Identity, Aliases, Full Names, Availability & Activity
 */

const { jidNormalizedUser } = require('@whiskeysockets/baileys');
const stats = require('../../stats');
const ratings = require('../../ratings');
const namesStore = require('../../names');
const { isUserAdmin } = require('../groupCommands');
const playerActivity = require('../../playerActivity');

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

function capitalize(str) {
  if (!str || typeof str !== 'string') return '';
  return str.charAt(0).toUpperCase() + str.slice(1).toLowerCase();
}

/**
 * Checks if a user has permission to set/add an alias (or profile field) for a given target player.
 */
async function canUserManagePlayerAlias(sock, chatId, senderJid, senderName, targetPlayer) {
  if (!targetPlayer) return false;
  const tKey = ratings.keyFor(targetPlayer);
  if (['me', 'myself', 'my', 'i'].includes(tKey)) return true;

  if (senderName && ratings.keyFor(senderName) === tKey) return true;

  if (senderJid) {
    const senderCanonical = nameFor(senderJid);
    if (senderCanonical && ratings.keyFor(senderCanonical) === tKey) return true;

    const match = namesStore.findIdByNameOrAlias(targetPlayer, chatId);
    if (match) {
      const normSender = jidNormalizedUser(senderJid);
      const pn = namesStore.getPnByLid(normSender) || (normSender?.endsWith('@s.whatsapp.net') ? normSender : null);
      const lid = namesStore.resolveCanonicalId(normSender) || (normSender?.endsWith('@lid') ? normSender : null);

      if (match.id === normSender || match.id === pn || match.id === lid) return true;
      if (match.entry?.name && ratings.keyFor(match.entry.name) === ratings.keyFor(senderName)) return true;
    }
  }

  return await isUserAdmin(sock, chatId, senderJid);
}

function knownPlayers(chatId, activePolls = new Map()) {
  const byKey = new Map();
  const add = (name, canonicalName = null) => {
    const key = ratings.keyFor(name);
    const resolved = canonicalName ? String(canonicalName).trim() : String(name).trim();
    if (key && !byKey.has(key)) byKey.set(key, resolved);
  };

  for (const entry of namesStore.getAllEntries()) {
    if (entry.name) add(entry.name, entry.name);
    if (entry.fullName) add(entry.fullName, entry.name);
    for (const alias of entry.aliases || []) {
      add(alias, entry.name);
    }
  }
  for (const p of ratings.getAllRatings()) add(p.name, p.name);
  for (const p of stats.getLeaderboard()) add(p.name, p.name);
  for (const a of stats.getAvailability(chatId)) add(a.player, a.player);

  for (const [, pollState] of activePolls.entries()) {
    if (pollState.remoteJid === chatId) {
      if (pollState.creator?.name) add(pollState.creator.name);
      for (const name of pollState.lastPlayers || []) add(name);
      if (pollState.voteBuffer && pollState.voteBuffer instanceof Map) {
        for (const voterJid of pollState.voteBuffer.keys()) add(nameFor(voterJid));
      }
    }
  }

  return byKey;
}

// --- Full Name Handlers ---

async function handleSetFullName(sock, chatId, senderJid, senderName, playerName, fullName) {
  const cleanFull = typeof fullName === 'string' ? fullName.trim() : '';
  if (!cleanFull) return 'Please provide a valid full name.';

  const targetPlayer = playerName || senderName || (senderJid ? nameFor(senderJid) : 'me');
  const canManage = await canUserManagePlayerAlias(sock, chatId, senderJid, senderName, targetPlayer);
  if (!canManage) {
    return '⚠️ Only group admins can update the full name for other players. You can set your own full name.';
  }

  let targetId = null;
  const match = namesStore.findIdByNameOrAlias(targetPlayer, chatId);
  if (match) {
    targetId = match.id;
  } else if (senderJid) {
    targetId = namesStore.resolveCanonicalId(jidNormalizedUser(senderJid));
  } else {
    targetId = targetPlayer;
  }

  const updatedEntry = namesStore.setFullName(targetId, cleanFull);
  const resolvedDisplayName = updatedEntry?.name || targetPlayer;

  const trResult = await ratings.updateRatingFromFullName(targetId, cleanFull, { jid: senderJid, sock });
  let ratingNote = '';
  if (trResult) {
    if (trResult.tennisRecord === false) {
      ratingNote = ` ⚠️ TennisRecord profile not found or ambiguous in San Jose/nearby area. Rating set to default ${ratings.formatRating(ratings.INITIAL_RATING)}. Superadmin alerted.`;
    } else {
      const locStr = trResult.tennisRecordLocation ? ` (${trResult.tennisRecordLocation})` : '';
      const urlStr = trResult.tennisRecordUrl ? ` -> ${trResult.tennisRecordUrl}` : '';
      ratingNote = ` Initial rating from TennisRecord set to ${ratings.formatRating(trResult.rating)}${locStr}${urlStr}.`;
    }
  }

  return `✅ Updated full name for "${resolvedDisplayName}" to "${cleanFull}".${ratingNote}`;
}

function parseFullNameCommand(text, defaultSenderName = null) {
  const raw = text.replace(/^!(?:setfullname|fullname)\s*/i, '').trim();
  if (!raw) return null;

  if (/\bfor\b/i.test(raw)) {
    const forMatch = raw.match(/^(.+?)\s+\bfor\b\s+(.+)$/i);
    if (forMatch) {
      return { name: forMatch[2].trim(), fullName: forMatch[1].trim() };
    }
  }

  const delimMatch = raw.match(/^(.+?)\s*(?:=|:|->|\bas\b|\bto\b)\s*(.+)$/i);
  if (delimMatch) {
    return { name: delimMatch[1].trim(), fullName: delimMatch[2].trim() };
  }

  return { name: defaultSenderName || 'me', fullName: raw };
}

// --- Alias Handlers ---

function parseAliasCommand(text, defaultSenderName = null) {
  const raw = text.replace(/^!(?:alias|addalias)\s*/i, '').trim();
  if (!raw) return null;

  if (/\bfor\b/i.test(raw)) {
    const forMatch = raw.match(/^(.+?)\s+\bfor\b\s+(.+)$/i);
    if (forMatch) {
      return { name: forMatch[2].trim(), alias: forMatch[1].trim() };
    }
  }

  const delimMatch = raw.match(/^(.+?)\s*(?:=|:|->|\bas\b|\bto\b)\s*(.+)$/i);
  if (delimMatch) {
    return { name: delimMatch[1].trim(), alias: delimMatch[2].trim() };
  }

  const singleQuoteMatch = raw.match(/^"([^"]+)"$/);
  if (singleQuoteMatch) {
    return { name: defaultSenderName || 'me', alias: singleQuoteMatch[1].trim() };
  }

  const quoteMatch = raw.match(/^"([^"]+)"\s+(.+)$/) || raw.match(/^(.+?)\s+"([^"]+)"$/);
  if (quoteMatch) {
    return { name: quoteMatch[1].trim(), alias: quoteMatch[2].trim() };
  }

  const spaceParts = raw.split(/\s+/);
  if (spaceParts.length >= 2) {
    const alias = spaceParts.pop();
    const name = spaceParts.join(' ');
    return { name, alias };
  }

  if (spaceParts.length === 1 && spaceParts[0]) {
    return { name: defaultSenderName || 'me', alias: spaceParts[0] };
  }

  return null;
}

function formatAliases() {
  const entries = namesStore.getAllEntries();
  if (entries.length === 0) {
    return 'No player aliases recorded yet. Use "!alias <name> = <alias>" to add one.';
  }
  const lines = entries.map((e) => {
    const aliasStr = e.aliases && e.aliases.length > 0 ? ` (aliases: ${e.aliases.join(', ')})` : ' (no aliases)';
    return `• ${e.name}${aliasStr}`;
  });
  return `📋 Player Names & Aliases:\n${lines.join('\n')}`;
}

async function handleAddAlias({ sock, chatId, senderJid, sender, playerName, aliasName, isTool = false }) {
  const canManage = await canUserManagePlayerAlias(sock, chatId, senderJid, sender, playerName);
  if (!canManage) {
    return isTool
      ? '⚠️ Only group admins can add aliases for other players. You can add aliases for yourself.'
      : '⚠️ Only group admins can add aliases for other players. You can add aliases for yourself (e.g. "!alias <your alias>").';
  }
  const res = namesStore.addAliasForPlayer(playerName, aliasName, isTool ? null : senderJid, chatId);
  if (res) {
    const prefix = isTool ? '' : '✅ ';
    return `${prefix}Added alias "${aliasName}" for player "${res.name}". Current aliases: [${res.aliases.join(', ')}].`;
  }
  return `Could not add alias for "${playerName}".`;
}

async function handleDeleteAlias({ sock, chatId, senderJid, sender, targetPlayer, targetAlias, isTool = false }) {
  let resolvedPlayer = targetPlayer;
  if (!resolvedPlayer) {
    const match = namesStore.findIdByNameOrAlias(targetAlias, chatId);
    if (match) resolvedPlayer = match.entry?.name;
  }

  const canManage = await canUserManagePlayerAlias(sock, chatId, senderJid, sender, resolvedPlayer || targetAlias);
  if (!canManage) {
    return isTool
      ? '⚠️ Only group admins can delete aliases for other players. You can delete aliases for yourself.'
      : '⚠️ Only group admins can delete aliases for other players. You can delete aliases for yourself (e.g. "!deletealias <your alias>").';
  }

  const res = namesStore.removeAliasForPlayer(targetPlayer, targetAlias, chatId);
  if (res) {
    const prefix = isTool ? '' : '✅ ';
    return `${prefix}Removed alias "${res.removed}" from player "${res.name}". Current aliases: [${res.aliases.join(', ')}].`;
  }
  return `Alias "${targetAlias}" was not found.`;
}

// --- Availability Handlers ---

function formatAvailability(chatId = null) {
  const list = stats.getAvailability(chatId);
  if (list.length === 0) {
    return 'No one has marked themselves free yet. Use "!free <when>" to add yourself.';
  }
  const lines = list.map((a) => `• ${a.player} – ${a.when}`);
  return `Who's free:\n${lines.join('\n')}`;
}

// --- Activity Handlers ---

async function handlePlayerActivity(sock, chatId, sender, targetPlayer = null) {
  if (targetPlayer) {
    const act = playerActivity.getPlayerActivity(targetPlayer, chatId);
    if (!act || (!act.played && !act.voted && !act.messaged && !act.created)) {
      return `⚠️ No activity on record for "${targetPlayer}".`;
    }
    const nowMs = Date.now();
    const playedMs = act.matchTimeMs || playerActivity.toMs(act.played);
    const hasMatchTime = playedMs > 0;
    const isFuture = hasMatchTime && playedMs > nowMs;
    const matchLabel = isFuture ? 'Next Match' : 'Last Played';
    const matchStr = hasMatchTime ? playerActivity.formatActivityDate(act.played) : (isFuture ? 'None' : 'Never');
    const latestStr = act.latestTime
      ? `${playerActivity.formatActivityDate(act.latestTime)} (${capitalize(act.latestType)})`
      : 'Never';

    const lines = [
      `📊 *Activity for ${act.name}:*`,
      `• *Status:* ${capitalize(act.status || 'active')}`,
      `• *Latest Activity:* ${latestStr}`,
      '',
      '• *Details:*',
      `  └ *${matchLabel}:* ${matchStr}`,
      `  └ *Last Voted:* ${act.voted ? playerActivity.formatActivityDate(act.voted) : 'Never'}`,
      `  └ *Last Messaged:* ${act.messaged ? playerActivity.formatActivityDate(act.messaged) : 'Never'}`
    ];
    if (act.weekly && Object.keys(act.weekly).length > 0) {
      const weeklyList = Object.entries(act.weekly)
        .sort((a, b) => b[0].localeCompare(a[0]))
        .slice(0, 8);
      lines.push('• *Weekly Activity:*');
      for (const [w, counts] of weeklyList) {
        lines.push(`  └ ${w}: ${counts.lineups || 0} lineups, ${counts.votes || 0} votes, ${counts.messages || 0} messages`);
      }
    }
    return lines.join('\n');
  }

  const all = playerActivity.getAllActivity(chatId);
  if (all.length === 0) {
    return '📊 No player activity recorded yet.';
  }

  const lines = ['📊 *Player Activity Log:*'];
  const nowMs = Date.now();
  for (const p of all) {
    const pPlayedMs = p.matchTimeMs || playerActivity.toMs(p.played);
    const pIsFuture = pPlayedMs > nowMs;
    const pMatchLabel = pIsFuture ? 'Next Match' : 'Played';
    const latestStr = p.latestTime
      ? `${playerActivity.formatActivityDate(p.latestTime)} (${capitalize(p.latestType)})`
      : 'Never';
    const playedStr = p.played ? playerActivity.formatActivityDate(p.played) : '-';
    const votedStr = p.voted ? playerActivity.formatActivityDate(p.voted) : '-';
    const msgStr = p.messaged ? playerActivity.formatActivityDate(p.messaged) : '-';

    lines.push(`• *${p.name}*: ${latestStr}\n  └ ${pMatchLabel}: ${playedStr} | Voted: ${votedStr} | Messaged: ${msgStr}`);
  }
  return lines.join('\n');
}

async function handleLatestActivity(sock, chatId, sender, targetPlayer = null) {
  if (targetPlayer) {
    const act = playerActivity.getLatestActivity(targetPlayer, chatId);
    if (!act || !act.latestTime) {
      return `⚠️ No activity on record for "${targetPlayer}".`;
    }
    return `⏱️ *Latest Activity for ${act.name}:* ${playerActivity.formatActivityDate(act.latestTime)} (${capitalize(act.latestType)})`;
  }

  const all = playerActivity.getAllActivity(chatId);
  if (all.length === 0) {
    return '⏱️ No player activity recorded yet.';
  }

  const lines = ['⏱️ *Latest Player Activity:*'];
  for (const p of all) {
    const latestStr = p.latestTime
      ? `${playerActivity.formatActivityDate(p.latestTime)} (${capitalize(p.latestType)})`
      : 'Never';
    lines.push(`• *${p.name}:* ${latestStr}`);
  }
  return lines.join('\n');
}

async function handleInactivePlayers(sock, chatId, sender, rawPeriod = null) {
  const res = playerActivity.getInactivePlayers({
    groupJid: chatId,
    period: rawPeriod || null
  });

  const periodLabel = res.periodWeeks ? `${res.periodWeeks} week(s)` : `${res.periodDays} days`;

  if (res.inactiveCount === 0) {
    return `✅ No inactive players found (all ${res.totalPlayersCount} player(s) active within the last ${periodLabel}).`;
  }

  const refDateStr = res.referenceTime ? playerActivity.formatActivityDate(res.referenceTime) : 'now';
  const lines = [
    `💤 *Inactive Players* (No activity for > ${periodLabel} from latest activity on ${refDateStr}):`
  ];
  for (const p of res.inactivePlayers) {
    if (p.neverActive) {
      lines.push(`• *${p.name}*: Never active`);
    } else {
      const lastStr = playerActivity.formatActivityDate(p.latestTime);
      const daysStr = p.inactiveDays !== null ? `${p.inactiveDays} day(s) inactive` : '';
      lines.push(`• *${p.name}*: Last active ${lastStr} (${capitalize(p.latestType)}) — ${daysStr}`);
    }
  }
  lines.push(`\nTotal: ${res.inactiveCount} inactive player(s) out of ${res.totalPlayersCount} member(s).`);
  return lines.join('\n');
}

module.exports = {
  nameFor,
  capitalize,
  canUserManagePlayerAlias,
  knownPlayers,
  handleSetFullName,
  parseFullNameCommand,
  parseAliasCommand,
  formatAliases,
  handleAddAlias,
  handleDeleteAlias,
  formatAvailability,
  handlePlayerActivity,
  handleLatestActivity,
  handleInactivePlayers
};
