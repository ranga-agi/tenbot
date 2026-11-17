const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const messageHistory = require('../lib/messageHistory');
const { sendMessageAndRecord } = require('../lib/botMessage');
const { extractQuotedContext, isAddressedToBot } = require('../lib/commands/index');
const pollCommands = require('../lib/commands/pollCommands');
const namesStore = require('../lib/names');

describe('Quoted Message Context & Bot Message Recording', () => {
  const testChatId = '120363000000000000@g.us';
  const botJids = ['16693124812@s.whatsapp.net', '24104010813588@lid'];

  beforeEach(() => {
    messageHistory.clear(testChatId);
    namesStore.setName('14081112222@s.whatsapp.net', 'Daven');
    namesStore.setName('14083334444@s.whatsapp.net', 'Conrad');
  });

  describe('extractQuotedContext', () => {
    it('should extract quoted text and identify Tenbot as sender when quoting bot message', () => {
      const msg = {
        key: { remoteJid: testChatId, id: 'msg_reply_1' },
        message: {
          extendedTextMessage: {
            text: '@tenbot - Why didn’t you mention my name?',
            contextInfo: {
              stanzaId: 'msg_reminder_1',
              participant: '16693124812@s.whatsapp.net',
              quotedMessage: {
                conversation: '🎾 12 Hours to Match Time! We still need 4 more players to complete the court for Monday 7pm (12 total spots).\nCurrent lineup: Conrad, Kejal, Shibir Desai, Vijay Parthasarathy, Chandra Cheruku, Shan, PI, Vishal\nWho\'s ready to hit some winners today? Claim your spot!'
              }
            }
          }
        }
      };

      const quoted = extractQuotedContext(msg, null, botJids);
      assert.ok(quoted);
      assert.equal(quoted.quotedSenderName, 'Tenbot');
      assert.match(quoted.quotedText, /12 Hours to Match Time/);
      assert.match(quoted.quotedText, /Current lineup: Conrad/);
      assert.equal(quoted.stanzaId, 'msg_reminder_1');
    });

    it('should extract quoted text and identify another player when quoting their message', () => {
      const msg = {
        key: { remoteJid: testChatId, id: 'msg_reply_2' },
        message: {
          extendedTextMessage: {
            text: '@tenbot is Conrad playing today?',
            contextInfo: {
              stanzaId: 'msg_conrad_1',
              participant: '14083334444@s.whatsapp.net',
              quotedMessage: {
                conversation: 'I can play at 7pm tonight'
              }
            }
          }
        }
      };

      const quoted = extractQuotedContext(msg, null, botJids);
      assert.ok(quoted);
      assert.equal(quoted.quotedSenderName, 'Conrad');
      assert.equal(quoted.quotedText, 'I can play at 7pm tonight');
      assert.equal(quoted.stanzaId, 'msg_conrad_1');
    });

    it('should extract poll title when quoting a poll creation message', () => {
      const msg = {
        key: { remoteJid: testChatId, id: 'msg_reply_3' },
        message: {
          extendedTextMessage: {
            text: '@tenbot cancel this',
            contextInfo: {
              stanzaId: 'poll_create_1',
              participant: '16693124812@s.whatsapp.net',
              quotedMessage: {
                pollCreationMessage: {
                  name: '🎾 Monday 7pm Match Poll'
                }
              }
            }
          }
        }
      };

      const quoted = extractQuotedContext(msg, null, botJids);
      assert.ok(quoted);
      assert.equal(quoted.quotedSenderName, 'Tenbot');
      assert.equal(quoted.quotedText, '[Poll: 🎾 Monday 7pm Match Poll]');
    });

    it('should fallback to messageStore when quotedMessage is missing in payload', () => {
      const messageStore = new Map([
        [`${testChatId}_stored_msg_1`, {
          message: {
            conversation: 'Stored message text from history'
          }
        }]
      ]);

      const msg = {
        key: { remoteJid: testChatId, id: 'msg_reply_4' },
        message: {
          extendedTextMessage: {
            text: '@tenbot what does this mean?',
            contextInfo: {
              stanzaId: 'stored_msg_1',
              participant: '14081112222@s.whatsapp.net'
            }
          }
        }
      };

      const quoted = extractQuotedContext(msg, messageStore, botJids);
      assert.ok(quoted);
      assert.equal(quoted.quotedSenderName, 'Daven');
      assert.equal(quoted.quotedText, 'Stored message text from history');
    });

    it('should fallback to messageHistory when quotedMessage is missing and in history', () => {
      messageHistory.recordMessage(testChatId, 'tenbot', 'Bot announcement in history', Date.now(), true, 'hist_msg_1');

      const msg = {
        key: { remoteJid: testChatId, id: 'msg_reply_5' },
        message: {
          extendedTextMessage: {
            text: '@tenbot check this',
            contextInfo: {
              stanzaId: 'hist_msg_1',
              participant: '16693124812@s.whatsapp.net'
            }
          }
        }
      };

      const quoted = extractQuotedContext(msg, null, botJids);
      assert.ok(quoted);
      assert.equal(quoted.quotedSenderName, 'Tenbot');
      assert.equal(quoted.quotedText, 'Bot announcement in history');
    });

    it('should return null when message has no quoted context', () => {
      const msg = {
        key: { remoteJid: testChatId, id: 'msg_plain' },
        message: {
          conversation: 'Hello everyone'
        }
      };

      const quoted = extractQuotedContext(msg, null, botJids);
      assert.equal(quoted, null);
    });
  });

  describe('isAddressedToBot with quoted messages', () => {
    it('should strip leading hyphen when user writes "@tenbot - Why didn\'t you mention my name?"', () => {
      const res = isAddressedToBot('@tenbot - Why didn’t you mention my name?', {}, botJids);
      assert.equal(res.addressed, true);
      assert.equal(res.promptText, 'Why didn’t you mention my name?');
    });

    it('should consider message addressed to bot when quoting bot message even without @tenbot trigger', () => {
      const msg = {
        message: {
          extendedTextMessage: {
            text: 'Why didn’t you mention my name?',
            contextInfo: {
              stanzaId: 'msg_1',
              participant: '16693124812@s.whatsapp.net'
            }
          }
        }
      };
      const res = isAddressedToBot('Why didn’t you mention my name?', msg, botJids);
      assert.equal(res.addressed, true);
      assert.equal(res.promptText, 'Why didn’t you mention my name?');
    });
  });

  describe('sendMessageAndRecord for outgoing bot messages', () => {
    it('should send via sock.sendMessage and automatically record text message to history', async () => {
      const rawSent = [];
      const fakeSock = {
        sendMessage: async (jid, content, options) => {
          rawSent.push({ jid, content, options });
          return { key: { id: 'sent_record_1', remoteJid: jid } };
        }
      };

      await sendMessageAndRecord(fakeSock, testChatId, { text: 'Hello group! Court 2 is booked.' });
      assert.equal(rawSent.length, 1);

      const history = messageHistory.getRecentMessages(testChatId);
      assert.equal(history.length, 1);
      assert.equal(history[0].sender, 'tenbot');
      assert.equal(history[0].text, 'Hello group! Court 2 is booked.');
      assert.equal(history[0].id, 'sent_record_1');
      assert.equal(history[0].fromMe, true);
    });

    it('should send via sock.sendMessage and automatically record media caption to history', async () => {
      const fakeSock = {
        sendMessage: async (jid, content, options) => ({ key: { id: 'media_1', remoteJid: jid } })
      };

      await sendMessageAndRecord(fakeSock, testChatId, {
        image: Buffer.from('fake'),
        caption: '📹 SCVCC Tennis Court Webcam snapshot'
      });
      const history = messageHistory.getRecentMessages(testChatId);
      assert.equal(history.length, 1);
      assert.equal(history[0].text, '📹 SCVCC Tennis Court Webcam snapshot');
      assert.equal(history[0].id, 'media_1');
      assert.equal(history[0].fromMe, true);
    });

    it('should record poll creation titles when sent via sendMessageAndRecord', async () => {
      const fakeSock = {
        sendMessage: async (jid, content, options) => ({ key: { id: 'poll_msg_1', remoteJid: jid } })
      };

      await sendMessageAndRecord(fakeSock, testChatId, {
        poll: {
          name: '🎾 Monday 7pm Match Poll',
          values: ['Player 1', 'Player 2']
        }
      });
      const history = messageHistory.getRecentMessages(testChatId);
      assert.equal(history.length, 1);
      assert.equal(history[0].text, '[Poll: 🎾 Monday 7pm Match Poll]');
      assert.equal(history[0].id, 'poll_msg_1');
      assert.equal(history[0].fromMe, true);
    });

    it('should record reminder message sent by sendPollReminder through sendMessageAndRecord', async () => {
      const rawSent = [];
      const fakeSock = {
        sendMessage: async (jid, content, options) => {
          rawSent.push({ jid, content, options });
          return { key: { id: 'reminder_key_1', remoteJid: jid } };
        }
      };

      const pollState = {
        remoteJid: testChatId,
        name: 'Monday 7pm',
        status: 'active',
        size: 12,
        options: ['Player 1', 'Player 2', 'Player 3', 'Player 4'],
        voteBuffer: new Map([['P1', 0], ['P2', 1]]),
        playAt: new Date(Date.now() + 12 * 3600 * 1000).toISOString(),
        reminderLeadHours: 12,
        reminderCount: 0
      };

      const pollContext = {
        activePolls: new Map([['poll_test_1', pollState]]),
        messageStore: new Map(),
        persistPolls: () => {}
      };

      // Calling sendPollReminder with an UNWRAPPED socket directly uses sendMessageAndRecord
      const sent = await pollCommands.sendPollReminder(fakeSock, 'poll_test_1', pollState, true, pollContext);
      assert.equal(sent, true);
      assert.equal(rawSent.length, 1);

      // Verify messageHistory recorded the reminder automatically
      const history = messageHistory.getRecentMessages(testChatId);
      assert.equal(history.length, 1);
      assert.equal(history[0].sender, 'tenbot');
      assert.equal(history[0].fromMe, true);
      assert.equal(history[0].id, 'reminder_key_1');
      assert.match(history[0].text, /12 Hours to Match Time/);
    });
  });
});
