/**
 * Outgoing bot message sender and recorder.
 * Handles dispatching messages via Baileys sock.sendMessage
 * and recording them into persistent messageHistory.
 */
const messageHistory = require('./messageHistory');

/**
 * Sends a message via sock.sendMessage and records it into messageHistory.
 * Does not mutate or wrap the socket.
 */
async function sendMessageAndRecord(sock, jid, content, options) {
  if (!sock || typeof sock.sendMessage !== 'function') return null;
  const result = await sock.sendMessage(jid, content, options);
  try {
    if (jid && content) {
      let textToSend = null;
      if (typeof content === 'string') {
        textToSend = content;
      } else if (content.text && typeof content.text === 'string') {
        textToSend = content.text;
      } else if (content.caption && typeof content.caption === 'string') {
        textToSend = content.caption;
      } else if (content.poll?.name) {
        textToSend = `[Poll: ${content.poll.name}]`;
      }
      if (textToSend && textToSend.trim()) {
        const sentId = result?.key?.id || null;
        messageHistory.recordMessage(jid, 'tenbot', textToSend.trim(), Date.now(), true, sentId);
      }
    }
  } catch (recordErr) {
    console.warn('⚠️ [sendMessageAndRecord] Failed to record outgoing message to messageHistory:', recordErr.message);
  }
  return result;
}

const sendAndRecordMessage = sendMessageAndRecord;

module.exports = {
  sendMessageAndRecord,
  sendAndRecordMessage
};
