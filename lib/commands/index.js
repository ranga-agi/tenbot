/**
 * Central Command Dispatcher & Tool Execution Router
 * Coordinates:
 *   - groupCommands
 *   - courtCommands
 *   - playerCommands
 *   - recurringCommands
 *   - pollCommands
 *   - lineupCommands
 */

const { jidNormalizedUser, normalizeMessageContent } = require('@whiskeysockets/baileys');
const weather = require('../weather');
const { helpText } = require('../help');
const messageHistory = require('../messageHistory');
const groupsConfig = require('../groupsConfig');
const { normalizeCommandDashes } = require('../textNormalize');

const groupCommands = require('./groupCommands');
const courtCommands = require('./courtCommands');
const playerCommands = require('./player');
const recurringCommands = require('./recurringCommands');
const pollCommands = require('./poll');
const lineupCommands = require('./lineupCommands');

const DEFAULT_LOCATION = 'San Jose, CA';

const TRIGGER_PREFIX = '@tenbot';

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function stripLeadingTrigger(text, triggerPrefix = TRIGGER_PREFIX) {
  if (!triggerPrefix) return text;
  const baseName = escapeRegex(triggerPrefix.replace(/^[@!~]/, ''));
  return text.replace(new RegExp(`^\\s*[@!~]${baseName}(?:[:,]|\\b)\\s*`, 'i'), '').replace(/^[\s,:–—-]+/, '').trim();
}

function extractMessageText(message) {
  if (!message) return null;
  const msg = (normalizeMessageContent ? normalizeMessageContent(message) : message) || message;
  const protoEdit = msg.protocolMessage?.editedMessage;
  const finalMsg = protoEdit ? ((normalizeMessageContent ? normalizeMessageContent(protoEdit) : protoEdit) || protoEdit) : msg;

  return (
    finalMsg.conversation ||
    finalMsg.extendedTextMessage?.text ||
    finalMsg.imageMessage?.caption ||
    finalMsg.videoMessage?.caption ||
    finalMsg.documentMessage?.caption ||
    finalMsg.buttonsResponseMessage?.selectedButtonId ||
    finalMsg.listResponseMessage?.singleSelectReply?.selectedRowId ||
    finalMsg.templateButtonReplyMessage?.selectedId ||
    null
  );
}

function extractMessageContextInfo(msg) {
  if (!msg) return null;
  const rawMessage = msg.message || msg;
  if (!rawMessage) return null;
  const actualMsg = (normalizeMessageContent ? normalizeMessageContent(rawMessage) : rawMessage) || rawMessage;
  const protoEdit = actualMsg.protocolMessage?.editedMessage;
  const finalMsg = protoEdit ? ((normalizeMessageContent ? normalizeMessageContent(protoEdit) : protoEdit) || protoEdit) : actualMsg;

  return (
    finalMsg.extendedTextMessage?.contextInfo ||
    finalMsg.imageMessage?.contextInfo ||
    finalMsg.videoMessage?.contextInfo ||
    finalMsg.documentMessage?.contextInfo ||
    finalMsg.buttonsResponseMessage?.contextInfo ||
    finalMsg.listResponseMessage?.contextInfo ||
    finalMsg.templateButtonReplyMessage?.contextInfo ||
    finalMsg.contextInfo ||
    null
  );
}

function extractQuotedContext(msg, messageStore = null, botJids = [], activePolls = null) {
  const contextInfo = extractMessageContextInfo(msg);
  if (!contextInfo) return null;

  let quotedMsg = contextInfo.quotedMessage;
  const stanzaId = contextInfo.stanzaId;
  const remoteJid = msg.key?.remoteJid;

  let quotedText = quotedMsg ? extractMessageText(quotedMsg) : null;
  if (!quotedText && quotedMsg) {
    const normQuoted = (normalizeMessageContent ? normalizeMessageContent(quotedMsg) : quotedMsg) || quotedMsg;
    const poll = normQuoted?.pollCreationMessage || normQuoted?.pollCreationMessageV2 || normQuoted?.pollCreationMessageV3;
    if (poll?.name) {
      quotedText = `[Poll: ${poll.name}]`;
    }
  }

  // Fallback to messageStore if quotedText not available
  if (!quotedText && stanzaId && messageStore && remoteJid) {
    const stored = messageStore.get(`${remoteJid}:${stanzaId}`) || messageStore.get(`${remoteJid}_${stanzaId}`);
    if (stored) {
      const storedContent = stored.message || stored;
      quotedText = extractMessageText(storedContent);
      if (!quotedText) {
        const normStored = (normalizeMessageContent ? normalizeMessageContent(storedContent) : storedContent) || storedContent;
        const poll = normStored?.pollCreationMessage || normStored?.pollCreationMessageV2 || normStored?.pollCreationMessageV3;
        if (poll?.name) {
          quotedText = `[Poll: ${poll.name}]`;
        }
      }
    }
  }

  // Fallback to messageHistory if stanzaId is known
  if (!quotedText && stanzaId && remoteJid) {
    try {
      const recent = messageHistory.getRecentMessages(remoteJid);
      const match = recent.find((m) => m.id === stanzaId);
      if (match && match.text) {
        quotedText = match.text;
      }
    } catch (_) {}
  }

  const quotedPollState = (stanzaId && activePolls && typeof activePolls.get === 'function')
    ? activePolls.get(stanzaId)
    : null;
  if (!quotedText && quotedPollState && (!remoteJid || quotedPollState.remoteJid === remoteJid)) {
    quotedText = `[Poll: ${quotedPollState.name || quotedPollState.when || 'Match Poll'}]`;
  }

  if (!quotedText || typeof quotedText !== 'string' || !quotedText.trim()) {
    return null;
  }

  const participant = contextInfo.participant;
  const normalizedBotJids = (botJids || []).map(jidNormalizedUser).filter(Boolean);
  const isBot =
    (participant && normalizedBotJids.includes(jidNormalizedUser(participant))) ||
    contextInfo.fromMe ||
    Boolean(quotedPollState && !quotedPollState.isManual && (!remoteJid || quotedPollState.remoteJid === remoteJid)) ||
    (participant && (participant.toLowerCase().includes('tenbot') || participant === '24104010813588@lid' || participant === '16693124812@s.whatsapp.net'));

  let quotedSenderName = 'Someone';
  if (isBot) {
    quotedSenderName = 'Tenbot';
  } else if (participant) {
    quotedSenderName = playerCommands.nameFor(participant) || participant.split('@')[0];
  } else if (contextInfo.fromMe) {
    quotedSenderName = 'Tenbot';
  }

  return {
    quotedText: quotedText.trim(),
    quotedSenderName,
    participant: participant || null,
    stanzaId: stanzaId || null
  };
}

function isQuotingBotMessageOrPoll(msg, botJids, context = null) {
  const contextInfo = extractMessageContextInfo(msg);
  if (!contextInfo) return false;

  const normalizedBotJids = (botJids || []).map(jidNormalizedUser).filter(Boolean);
  const quotedParticipant = contextInfo.participant;
  if (quotedParticipant && normalizedBotJids.includes(jidNormalizedUser(quotedParticipant))) {
    return true;
  }
  if (contextInfo.fromMe === true) {
    return true;
  }

  const stanzaId = contextInfo.stanzaId;
  const remoteJid = msg?.key?.remoteJid || null;
  if (!stanzaId) return false;

  const activePolls = context?.activePolls;
  if (activePolls && typeof activePolls.get === 'function') {
    const pollState = activePolls.get(stanzaId);
    if (pollState && !pollState.isManual && (!remoteJid || pollState.remoteJid === remoteJid)) {
      return true;
    }
  }

  const messageStore = context?.messageStore;
  if (messageStore && typeof messageStore.get === 'function' && remoteJid) {
    const stored = messageStore.get(`${remoteJid}:${stanzaId}`) || messageStore.get(`${remoteJid}_${stanzaId}`);
    if (stored) {
      if (stored.key?.fromMe === true) return true;
      if (stored.key?.participant && normalizedBotJids.includes(jidNormalizedUser(stored.key.participant))) {
        return true;
      }
    }
  }

  if (remoteJid) {
    try {
      const recent = messageHistory.getRecentMessages(remoteJid);
      if (recent.some((m) => m.id === stanzaId && (m.fromMe === true || (m.sender && m.sender.toLowerCase() === 'tenbot')))) {
        return true;
      }
    } catch (_) {}
  }

  return false;
}

function isLikelyQuestion(text) {
  if (!text || typeof text !== 'string') return false;
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (trimmed.includes('?')) return true;
  if (/\b(?:who|what|when|where|why|how|which|whose|whom)\b/i.test(trimmed)) return true;
  if (/(?:^|[.!?\n,;:]\s*)(?:is|are|was|were|am|do|does|did|can|could|will|would|should|has|have|had|any|anyone|anybody)\b/i.test(trimmed)) {
    return true;
  }
  if (/\b(?:wondering|curious|know if|check if|tell me)\b/i.test(trimmed)) return true;
  return false;
}

function isAddressedToBot(text, msg, botJids, triggerPrefix = TRIGGER_PREFIX, context = null) {
  if (!triggerPrefix) return { addressed: true, explicitlyAddressed: true, isQuotingBot: false, promptText: text };

  const cleanText = (text || '').replace(/[\u200B-\u200D\u2060\uFEFF]/g, '').trim();
  const contextInfo = extractMessageContextInfo(msg);
  const mentionedJids = (contextInfo?.mentionedJid || []).map(jidNormalizedUser);
  const normalizedBotJids = (botJids || []).map(jidNormalizedUser).filter(Boolean);
  const isDirectlyMentioned = mentionedJids.some((jid) => normalizedBotJids.includes(jid));
  const isQuotingBot = isQuotingBotMessageOrPoll(msg, botJids, context);

  const baseName = escapeRegex(triggerPrefix.replace(/^[@!~]/, ''));
  const prefixRegex = new RegExp(`^\\s*[@!~]${baseName}(?:[:,]|\\b)\\s*`, 'i');
  const anywhereRegex = new RegExp(`@${baseName}[:,]?\\b`, 'ig');

  if (prefixRegex.test(cleanText)) {
    let promptText = cleanText.replace(prefixRegex, '').trim();
    promptText = promptText.replace(/^[\s,:–—-]+/, '').trim();
    return { addressed: true, explicitlyAddressed: true, isQuotingBot, promptText };
  }

  // Check if text starts with @<bot-number> or @<bot-lid> (e.g. @24104010813588)
  for (const jid of normalizedBotJids) {
    const num = jid.split('@')[0].split(':')[0];
    if (num) {
      const numPrefixRegex = new RegExp(`^@${escapeRegex(num)}[:,]?\\s*`, 'i');
      if (numPrefixRegex.test(cleanText)) {
        const promptText = cleanText.replace(numPrefixRegex, '').trim();
        return { addressed: true, explicitlyAddressed: true, isQuotingBot, promptText };
      }
    }
  }

  const hasBotNumAnywhere = normalizedBotJids.some((jid) => {
    const num = jid.split('@')[0].split(':')[0];
    return num && new RegExp(`@${escapeRegex(num)}[:,]?\\b`, 'i').test(cleanText);
  });

  if (isDirectlyMentioned || anywhereRegex.test(cleanText) || hasBotNumAnywhere) {
    let promptText = cleanText.replace(anywhereRegex, '').trim();
    for (const jid of normalizedBotJids) {
      const num = jid.split('@')[0].split(':')[0];
      if (num) {
        promptText = promptText.replace(new RegExp(`@${escapeRegex(num)}[:,]?\\s*`, 'g'), '').trim();
      }
    }
    promptText = promptText.replace(/^[\s,:]+/, '').replace(/\s{2,}/g, ' ').trim();
    return { addressed: true, explicitlyAddressed: true, isQuotingBot, promptText };
  }

  if (isQuotingBot) {
    let promptText = cleanText.replace(prefixRegex, '').trim();
    for (const jid of normalizedBotJids) {
      const num = jid.split('@')[0].split(':')[0];
      if (num) {
        promptText = promptText.replace(new RegExp(`@${escapeRegex(num)}[:,]?\\s*`, 'g'), '').trim();
      }
    }
    promptText = promptText.replace(/^[\s,:–—-]+/, '').trim();
    return { addressed: true, explicitlyAddressed: false, isQuotingBot: true, promptText };
  }

  return { addressed: false, explicitlyAddressed: false, isQuotingBot: false, promptText: cleanText };
}


/**
 * Executes a tool called by Claude and returns the result string.
 */
async function executeTool(sock, chatId, sender, toolUse, msg, context) {
  const { name, input } = toolUse;

  // Poll tools
  if ([
    'get_poll_status',
    'poll_status',
    'get_active_polls',
    'active_polls',
    'simulate_poll',
    'create_poll',
    'generate_matchups',
    'rematch',
    'stop_poll',
    'resume_poll',
    'pause_reminders',
    'resume_reminders',
    'trigger_reminder',
    'send_reminder',
    'limit_poll_slots',
    'set_poll_slots',
    'modify_poll_instance',
    'clear_all_polls',
    'cancel_poll',
    'release_poll_courts',
    'release_courts',
    'release_court',
    'cancel_poll_courts'
  ].includes(name)) {
    const senderJid = msg?.key?.participant || msg?.key?.remoteJid;
    return await pollCommands.executePollTool(sock, name, input, sender, senderJid, chatId, msg, context);
  }

  // Player & Rating tools
  if (['add_alias', 'remove_alias', 'get_aliases', 'set_full_name', 'get_ratings', 'set_rating', 'reset_rating', 'get_player_activity', 'get_latest_activity', 'get_inactive_players', 'get_scores', 'report_score', 'record_score', 'add_score', 'log_score', 'delete_score', 'cancel_score', 'edit_score', 'update_score', 'get_leaderboard', 'get_standings', 'get_availability', 'who_is_free'].includes(name)) {
    const senderJid = msg?.key?.participant || msg?.key?.remoteJid;
    return await playerCommands.executePlayerTool(sock, name, input, sender, senderJid, chatId, context);
  }

  // Court tools
  if ([
    'get_court_bookings',
    'get_court_reservations',
    'check_court_availability',
    'book_court',
    'modify_court_booking',
    'modify_court_reservation',
    'modify_court',
    'update_court_booking',
    'update_court_reservation',
    'cancel_court',
    'cancel_court_reservation',
    'cancel_court_booking',
    'get_my_court_bookings',
    'pause_court_bookings',
    'resume_court_bookings',
    'get_court_webcam',
    'get_court_camera',
    'court_webcam'
  ].includes(name)) {
    const senderJid = msg?.key?.participant || msg?.key?.remoteJid;
    return await courtCommands.executeCourtTool(sock, name, input, sender, chatId, senderJid, context);
  }

  // Recurring poll tools
  if ([
    'simulate_recurring_poll',
    'schedule_recurring_poll',
    'list_recurring_polls',
    'get_recurring_advance_bookings',
    'pause_recurring_poll',
    'resume_recurring_poll',
    'modify_recurring_poll',
    'skip_recurring_poll_instance',
    'skip_poll_instance',
    'unskip_recurring_poll_instance',
    'unskip_poll_instance',
    'cancel_recurring_poll',
    'clear_all_recurring_polls',
    'cancel_all_recurring_polls'
  ].includes(name)) {
    const senderJid = msg?.key?.participant || msg?.key?.remoteJid;
    return await recurringCommands.executeRecurringTool(sock, name, input, sender, senderJid, chatId, {
      ...context,
      createMatchPoll: (...args) => pollCommands.createMatchPoll(...args, context),
      handleModifyPollInstance: (s, cId, snd, sndJid, tId, upd) =>
        pollCommands.handleModifyPollInstance(s, cId, snd, sndJid, tId, upd, context)
    });
  }

  // Group config tools
  if ([
    'list_groups',
    'get_groups',
    'add_group',
    'remove_group',
    'update_group_config',
    'set_group_config',
    'get_group_config'
  ].includes(name)) {
    const senderJid = msg?.key?.participant || msg?.key?.remoteJid;
    return await groupCommands.executeGroupTool(sock, name, input, senderJid, chatId);
  }

  // Lineup / Matchup tools
  if ([
    "parse_lineup",
    "parse_matchup",
    "parse_matchups",
    "record_lineup",
    "record_matchup",
    "record_matchups"
  ].includes(name)) {
    return await lineupCommands.executeLineupTool(sock, name, input, sender, chatId, msg, context);
  }

  // Weather tool
  if (name === 'get_weather') {
    const location = input?.location || DEFAULT_LOCATION;
    try {
      const forecast = await weather.getForecast(location);
      return weather.formatForecast(forecast);
    } catch (err) {
      return `Failed to get weather for ${location}: ${err.message}`;
    }
  }

  return `Unknown tool ${name}`;
}

/**
 * Routes and handles incoming command messages.
 * Returns response text if a command was handled, or null if unhandled.
 */
async function routeCommand(sock, rawText, chatId, sender, msg, context, opts = {}) {
  const text = normalizeCommandDashes(
    (rawText || '')
      .replace(/[\u200B-\u200D\u2060\uFEFF]/g, '')
      .replace(/[\u00A0\u202F\u2000-\u200A]/g, ' ')
      .trim()
  );
  const lower = text.toLowerCase();
  const senderJid = msg?.key?.participant || msg?.key?.remoteJid;

  // 1. Basic commands
  if (lower === '!ping') return 'pong 🏓';

  if (lower === '!help' || lower.startsWith('!help ')) {
    const specificCmd = text.slice('!help'.length).trim().replace(/^!/, '').toLowerCase();
    const isSuper = groupsConfig.isSuperAdmin(senderJid);
    return helpText(specificCmd || null, isSuper);
  }

  // 2. Group management commands
  const groupRes = await groupCommands.handleGroupCommand(sock, text, chatId, senderJid);
  if (groupRes !== null) return groupRes;

  // 3. Reset conversation history
  if (lower === '!reset') {
    const isAdmin = await groupCommands.isUserAdmin(sock, chatId, senderJid);
    if (!isAdmin) {
      return '⚠️ Only group admins can use !reset.';
    }
    if (context.chatHistories) context.chatHistories.delete(chatId);
    messageHistory.clear(chatId);
    return 'Conversation history and recent 2-week group message logs cleared.';
  }

  // 4. SCVCC Court commands
  const courtRes = await courtCommands.handleCourtCommand(sock, text, chatId, sender, senderJid, msg, context);
  if (courtRes !== null) return courtRes;

  // 5. Player, rating, alias, full name, score, and leaderboard commands
  const playerRes = await playerCommands.handlePlayerCommand(sock, text, chatId, sender, senderJid, msg, context.activePolls, context);
  if (playerRes !== null) return playerRes;

  // 6. Weather
  if (lower.startsWith('!weather')) {
    const location = text.slice('!weather'.length).trim() || DEFAULT_LOCATION;
    try {
      const forecast = await weather.getForecast(location);
      return weather.formatForecast(forecast);
    } catch (err) {
      console.error('Weather lookup failed:', err.message);
      return `Couldn't get the weather for "${location}": ${err.message}`;
    }
  }

  // 7. Direct poll creation or simulation command (!createpoll, !poll, !simulatepoll, !simpoll, etc.)
  if (/^!(?:createpoll|poll|makepoll|newpoll|optinpoll|yesnopoll|createoptinpoll|createyesnopoll|simulatepoll|simpoll|mockpoll|testpoll|dryrunpoll)\b/i.test(text)) {
    const isSimCmd = /^!(?:simulatepoll|simpoll|mockpoll|testpoll|dryrunpoll)\b/i.test(text);
    if (isSimCmd) {
      const afterCmd = text.replace(/^!(?:simulatepoll|simpoll|mockpoll|testpoll|dryrunpoll)\s*/i, '').trim();
      const firstWord = afterCmd.split(/\s+/)[0];
      const isRecurringSched = firstWord && (
        /^rec_/i.test(firstWord) ||
        (context.recurringPolls && context.recurringPolls.has(firstWord))
      );
      if (isRecurringSched || /^recurring\b/i.test(afterCmd)) {
        const schedArgs = /^recurring\b/i.test(afterCmd) ? afterCmd.replace(/^recurring\s*/i, '').trim() : afterCmd;
        return await recurringCommands.handleSimulateRecurringPoll(sock, chatId, sender, senderJid, schedArgs, {
          ...context,
          createMatchPoll: (...args) => pollCommands.createMatchPoll(...args, context)
        });
      }
    }

    const parsed = pollCommands.parsePollCreationText(text);
    if (parsed) {
      const isSim = isSimCmd || parsed.simulate === true;
      return await pollCommands.handleDirectPollCreation(sock, chatId, sender, msg, { ...parsed, simulate: isSim }, { isCommand: true, simulate: isSim }, context);
    }
  }

  // 8. Recurring poll commands
  const recurringRes = await recurringCommands.handleRecurringCommand(sock, text, chatId, sender, senderJid, {
    ...context,
    cancelOrDeletePoll: (s, rJid, pId, opts) => pollCommands.cancelOrDeletePoll(s, rJid, pId, context, opts),
    createMatchPoll: (...args) => pollCommands.createMatchPoll(...args, context)
  });
  if (recurringRes !== null) return recurringRes;

  // 9. Poll management commands (!stoppoll, !pollstatus, !setslots, etc.)
  const pollRes = await pollCommands.handlePollCommand(sock, text, chatId, sender, senderJid, msg, context);
  if (pollRes !== null) return pollRes;

  // 10. Court cancellation due to lack of votes check
  const hasCancelWord = /\bcancel(?:l?ed|l?ing|s)?\b/i.test(text);
  const hasCourtWord = /\bcourts?\b/i.test(text);
  if (hasCancelWord && hasCourtWord) {
    const cancelAnalysis = await lineupCommands.checkCourtCancellationWithLLM(text, sender, chatId, context.activePolls);
    if (cancelAnalysis && cancelAnalysis.isCourtCancelled) {
      let targetPollId = cancelAnalysis.pollId;
      if (!targetPollId || !context.activePolls.has(targetPollId)) {
        for (const [pollId, pollState] of [...context.activePolls.entries()].reverse()) {
          if (pollState.remoteJid === chatId && (pollState.status === 'active' || pollState.status === 'filled')) {
            targetPollId = pollId;
            break;
          }
        }
      }
      if (!targetPollId && context.latestPollIdByChat) targetPollId = context.latestPollIdByChat.get(chatId);

      if (targetPollId && context.activePolls.has(targetPollId)) {
        const targetPollState = context.activePolls.get(targetPollId);
        targetPollState.status = 'stopped';
        if (context.persistPolls) context.persistPolls();
        const pollName = targetPollState.name || targetPollState.when || 'Match Poll';
        console.log(`[poll] LLM detected court cancellation due to: "${cancelAnalysis.reason}". Poll ${targetPollId} ("${pollName}") status set to stopped.`);

        if (msg?.key && sock) {
          try {
            await sock.sendMessage(chatId, {
              react: {
                text: '🤖',
                key: msg.key
              }
            });
            console.log(`[poll] Added 🤖 reaction to court cancellation message in ${chatId}`);
          } catch (err) {
            console.error('[poll] Failed to add 🤖 reaction:', err.message);
          }
        }
        return null;
      }
    }
  }

  return null;
}

module.exports = {
  executeTool,
  routeCommand,
  groupCommands,
  courtCommands,
  playerCommands,
  recurringCommands,
  pollCommands,
  lineupCommands,
  isAddressedToBot,
  isQuotingBotMessageOrPoll,
  isLikelyQuestion,
  stripLeadingTrigger,
  extractQuotedContext
};
