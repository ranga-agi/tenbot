const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const {
  extractText,
  getEditedMessageDetails,
  handleEditedMessage,
  decryptMessageEdit
} = require('../index');
const messageHistory = require('../lib/messageHistory');
const scvcc = require('../lib/scvcc');
const groupsConfig = require('../lib/groupsConfig');
const { proto } = require('@whiskeysockets/baileys');
const { aesEncryptGCM, hmacSign } = require('@whiskeysockets/baileys/lib/Utils/crypto');

function buildEncryptedEditPayload({ originalMsgId, origSender, editor, editedConversation, messageSecret, timestampMs = 1700000000000 }) {
  const plaintextMsg = {
    protocolMessage: {
      key: { id: originalMsgId, fromMe: false, remoteJid: 'test_chat_edited@g.us' },
      type: 14,
      editedMessage: { conversation: editedConversation },
      timestampMs
    }
  };
  const plaintext = proto.Message.encode(proto.Message.fromObject(plaintextMsg)).finish();
  const iv = Buffer.alloc(12, 0x12);
  const sign = Buffer.concat([
    Buffer.from(originalMsgId),
    Buffer.from(origSender),
    Buffer.from(editor),
    Buffer.from('Message Edit'),
    new Uint8Array([1])
  ]);
  const key0 = hmacSign(messageSecret, new Uint8Array(32), 'sha256');
  const encKey = hmacSign(sign, key0, 'sha256');
  const encPayload = aesEncryptGCM(plaintext, encKey, iv, Buffer.alloc(0));
  return { encPayload, encIv: iv };
}

describe('editedMessages', () => {
  const testChatId = 'test_chat_edited@g.us';

  beforeEach(() => {
    messageHistory.clear(testChatId);
  });

  describe('extractText', () => {
    it('should extract text from standard message structures', () => {
      assert.equal(extractText({ conversation: 'standard text' }), 'standard text');
      assert.equal(extractText({ extendedTextMessage: { text: 'extended text' } }), 'extended text');
      assert.equal(extractText({ imageMessage: { caption: 'photo caption' } }), 'photo caption');
    });

    it('should extract text from protocolMessage editedMessage (MESSAGE_EDIT)', () => {
      const editMsg = {
        protocolMessage: {
          key: { id: 'msg_123', remoteJid: testChatId },
          type: 14,
          editedMessage: {
            conversation: 'this is edited text'
          }
        }
      };
      assert.equal(extractText(editMsg), 'this is edited text');
    });

    it('should extract text from nested future proof editedMessage', () => {
      const nestedEdit = {
        editedMessage: {
          message: {
            protocolMessage: {
              key: { id: 'msg_456', remoteJid: testChatId },
              type: 14,
              editedMessage: {
                extendedTextMessage: {
                  text: 'nested edited text'
                }
              }
            }
          }
        }
      };
      assert.equal(extractText(nestedEdit), 'nested edited text');
    });

    it('should return null when message has no text or is empty', () => {
      assert.equal(extractText(null), null);
      assert.equal(extractText({}), null);
    });
  });

  describe('getEditedMessageDetails', () => {
    it('should return null for normal non-edit messages', () => {
      const normal = {
        key: { id: 'normal_1', remoteJid: testChatId },
        message: { conversation: 'hello' }
      };
      assert.equal(getEditedMessageDetails(normal), null);
    });

    it('should identify protocolMessage edit and return originalKey, editedMessage, and text', () => {
      const editMsg = {
        key: { id: 'protocol_msg_id', remoteJid: testChatId },
        message: {
          protocolMessage: {
            key: { id: 'orig_msg_1', remoteJid: testChatId, participant: 'alice@s.whatsapp.net' },
            type: 14,
            editedMessage: {
              conversation: 'updated content'
            },
            timestampMs: 1600000000000
          }
        }
      };
      const details = getEditedMessageDetails(editMsg);
      assert.ok(details);
      assert.equal(details.isEdit, true);
      assert.equal(details.originalKey.id, 'orig_msg_1');
      assert.equal(details.originalKey.participant, 'alice@s.whatsapp.net');
      assert.equal(details.text, 'updated content');
      assert.equal(details.timestamp, 1600000000000);
    });

    it('should identify messages.update structure with update.message', () => {
      const updateMsg = {
        key: { id: 'orig_msg_2', remoteJid: testChatId },
        update: {
          message: {
            conversation: 'content from update event'
          }
        },
        messageTimestamp: 1600000005
      };
      const details = getEditedMessageDetails(updateMsg);
      assert.ok(details);
      assert.equal(details.isEdit, true);
      assert.equal(details.originalKey.id, 'orig_msg_2');
      assert.equal(details.text, 'content from update event');
    });

    it('should decrypt secretEncryptedMessage using stored messageSecret and extract text', () => {
      const originalMsgId = 'orig_encrypted_1';
      const origSender = '16028031085@s.whatsapp.net';
      const editor = '16028031085@s.whatsapp.net';
      const messageSecret = Buffer.alloc(32, 0x42);

      // Create mock messageStore containing the original message
      const mockStore = new Map();
      mockStore.set(`${testChatId}:${originalMsgId}`, {
        key: { id: originalMsgId, remoteJid: testChatId, participant: origSender },
        messageSecret,
        message: { conversation: 'Original plain text' }
      });

      // Construct encrypted edit payload matching WhatsApp's wire format
      const plaintextMsg = {
        protocolMessage: {
          key: { id: originalMsgId, fromMe: false, remoteJid: testChatId },
          type: 14,
          editedMessage: { conversation: 'Decrypted edited text from PI' },
          timestampMs: 1700000000000
        }
      };
      const plaintext = proto.Message.encode(proto.Message.fromObject(plaintextMsg)).finish();
      const iv = Buffer.alloc(12, 0x12);

      const sign = Buffer.concat([
        Buffer.from(originalMsgId),
        Buffer.from(origSender),
        Buffer.from(editor),
        Buffer.from('Message Edit'),
        new Uint8Array([1])
      ]);
      const key0 = hmacSign(messageSecret, new Uint8Array(32), 'sha256');
      const encKey = hmacSign(sign, key0, 'sha256');
      const encPayload = aesEncryptGCM(plaintext, encKey, iv, Buffer.alloc(0));

      const secretEncMsg = {
        key: { id: 'secret_enc_edit_id', remoteJid: testChatId, participant: editor },
        message: {
          secretEncryptedMessage: {
            targetMessageKey: { id: originalMsgId, remoteJid: testChatId, participant: origSender },
            encPayload,
            encIv: iv,
            secretEncType: 2
          }
        }
      };

      const details = getEditedMessageDetails(secretEncMsg, mockStore);
      assert.ok(details, 'Should return edited message details');
      assert.equal(details.isEdit, true);
      assert.equal(details.originalKey.id, originalMsgId);
      assert.equal(details.text, 'Decrypted edited text from PI');
    });

    it('should decrypt secretEncryptedMessage when original message is wrapped in ephemeralMessage and keys have device suffixes or participantPn', () => {
      const originalMsgId = 'orig_ephemeral_1';
      const normPn = '16028031085@s.whatsapp.net';
      const messageSecret = Buffer.alloc(32, 0x55);

      const mockStore = new Map();
      mockStore.set(`${testChatId}:${originalMsgId}`, {
        key: { id: originalMsgId, remoteJid: testChatId, participant: '999988887777@lid', participantPn: normPn },
        message: {
          ephemeralMessage: {
            message: {
              conversation: '!webacm',
              messageContextInfo: { messageSecret }
            }
          }
        }
      });

      const { encPayload, encIv } = buildEncryptedEditPayload({
        originalMsgId,
        origSender: normPn,
        editor: normPn,
        editedConversation: '!webcam',
        messageSecret
      });

      // Case 1: device-suffixed participant and omitted targetMessageKey.participant
      const secretEncMsg = {
        key: { id: 'secret_enc_ephemeral', remoteJid: testChatId, participant: '999988887777:4@lid', participantPn: '16028031085:4@s.whatsapp.net' },
        message: {
          ephemeralMessage: {
            message: {
              secretEncryptedMessage: {
                targetMessageKey: { id: originalMsgId, remoteJid: testChatId },
                encPayload,
                encIv,
                secretEncType: 2
              }
            }
          }
        }
      };

      const details = getEditedMessageDetails(secretEncMsg, mockStore);
      assert.ok(details, 'Should decrypt ephemeral secretEncryptedMessage with normalized participantPn');
      assert.equal(details.text, '!webcam');
      assert.equal(details.originalKey.participant, '999988887777@lid');

      // Case 2: Delivered via messages.update event wrapper
      const updateDetails = getEditedMessageDetails({
        key: { id: 'secret_enc_ephemeral', remoteJid: testChatId, participant: '999988887777:4@lid', participantPn: normPn },
        update: {
          message: {
            secretEncryptedMessage: {
              targetMessageKey: { id: originalMsgId, remoteJid: testChatId },
              encPayload,
              encIv,
              secretEncType: 2
            }
          }
        }
      }, mockStore);
      assert.ok(updateDetails, 'Should decrypt secretEncryptedMessage delivered via messages.update');
      assert.equal(updateDetails.text, '!webcam');
    });
  });

  describe('messageHistory.recordEditedMessage', () => {
    it('should update an existing message by id in chat-history', () => {
      const uniqueChat = 'test_chat_record_1@g.us';
      messageHistory.clear(uniqueChat);
      const now = Date.now();
      messageHistory.recordMessage(uniqueChat, 'Alice', 'Original message text', now - 5000, false, 'msg_edit_1');
      let history = messageHistory.getRecentMessages(uniqueChat);
      assert.equal(history.length, 1);
      assert.equal(history[0].text, 'Original message text');

      messageHistory.recordEditedMessage(uniqueChat, 'msg_edit_1', 'Alice', 'Edited message text', now, false);
      history = messageHistory.getRecentMessages(uniqueChat);
      assert.equal(history.length, 1);
      assert.equal(history[0].text, 'Edited message text');
      assert.equal(history[0].edited, true);
    });

    it('should fallback to updating latest recent message from sender if id not found', () => {
      const uniqueChat = 'test_chat_record_2@g.us';
      messageHistory.clear(uniqueChat);
      const now = Date.now();
      messageHistory.recordMessage(uniqueChat, 'Bob', 'First message', now - 5000, false);
      let history = messageHistory.getRecentMessages(uniqueChat);
      assert.equal(history.length, 1);
      assert.equal(history[0].text, 'First message');

      messageHistory.recordEditedMessage(uniqueChat, 'unknown_id', 'Bob', 'Edited second message', now, false);
      history = messageHistory.getRecentMessages(uniqueChat);
      assert.equal(history.length, 1);
      assert.equal(history[0].text, 'Edited second message');
      assert.equal(history[0].edited, true);
    });
  });

  describe('handleEditedMessage execution', () => {
    it('should interpret edited message and execute commands like !ping', async () => {
      const sentReplies = [];
      const mockSock = {
        sendMessage: async (jid, content) => {
          sentReplies.push({ jid, content });
          return { key: { id: 'reply_1' } };
        }
      };

      const editMsg = {
        key: { id: 'edit_protocol_key', remoteJid: testChatId },
        pushName: 'Alice',
        message: {
          protocolMessage: {
            key: { id: 'orig_cmd_1', remoteJid: testChatId },
            type: 14,
            editedMessage: {
              conversation: '!ping'
            }
          }
        }
      };

      const details = getEditedMessageDetails(editMsg);
      await handleEditedMessage(mockSock, editMsg, details, 'Test Group');

      assert.equal(sentReplies.length, 1);
      assert.equal(sentReplies[0].content.text, 'pong 🏓');

      // Verify chat history updated
      const history = messageHistory.getRecentMessages(testChatId);
      assert.equal(history.some((m) => m.text === '!ping'), true);
    });

    it('should respond when an unaddressed message is edited to add @tenbot or mention bot JID', async () => {
      const sentReplies = [];
      const mockSock = {
        user: { id: '14084099336:3@s.whatsapp.net', lid: '115694289027280:3@lid' },
        sendMessage: async (jid, content) => {
          sentReplies.push({ jid, content });
          return { key: { id: 'reply_mention' } };
        }
      };

      // 1. Initial message was unaddressed: "good morning everyone" (bot would ignore)
      // 2. User edits the message in WhatsApp to add "@tenbot ping"
      const editMsgText = {
        key: { id: 'edit_key_trigger', remoteJid: testChatId },
        pushName: 'Alice',
        message: {
          protocolMessage: {
            key: { id: 'orig_unaddressed_1', remoteJid: testChatId },
            type: 14,
            editedMessage: {
              conversation: '@tenbot !ping'
            }
          }
        }
      };

      const detailsText = getEditedMessageDetails(editMsgText);
      await handleEditedMessage(mockSock, editMsgText, detailsText, 'Test Group');

      assert.equal(sentReplies.length, 1);
      assert.ok(/pong/i.test(sentReplies[0].content.text));

      // 2b. Edit adding !tenbot or ~tenbot prefix
      const editBang = {
        key: { id: 'edit_key_bang', remoteJid: testChatId },
        pushName: 'Alice',
        message: { protocolMessage: { key: { id: 'orig_unaddressed_bang', remoteJid: testChatId }, type: 14, editedMessage: { conversation: '!tenbot !ping' } } }
      };
      await handleEditedMessage(mockSock, editBang, getEditedMessageDetails(editBang), 'Test Group');
      assert.equal(sentReplies.length, 2);
      assert.ok(/pong/i.test(sentReplies[1].content.text));

      const editTilde = {
        key: { id: 'edit_key_tilde', remoteJid: testChatId },
        pushName: 'Alice',
        message: { protocolMessage: { key: { id: 'orig_unaddressed_tilde', remoteJid: testChatId }, type: 14, editedMessage: { conversation: '~tenbot !ping' } } }
      };
      await handleEditedMessage(mockSock, editTilde, getEditedMessageDetails(editTilde), 'Test Group');
      assert.equal(sentReplies.length, 3);
      assert.ok(/pong/i.test(sentReplies[2].content.text));

      // 3. User edits another message using WhatsApp mention (@Tenbot) with contextInfo.mentionedJid
      const editMsgMention = {
        key: { id: 'edit_key_mention', remoteJid: testChatId },
        pushName: 'Alice',
        message: {
          protocolMessage: {
            key: { id: 'orig_unaddressed_2', remoteJid: testChatId },
            type: 14,
            editedMessage: {
              extendedTextMessage: {
                text: '@Tenbot !ping',
                contextInfo: {
                  mentionedJid: ['14084099336@s.whatsapp.net']
                }
              }
            }
          }
        }
      };

      const detailsMention = getEditedMessageDetails(editMsgMention);
      await handleEditedMessage(mockSock, editMsgMention, detailsMention, 'Test Group');

      assert.equal(sentReplies.length, 4);
      assert.ok(/pong/i.test(sentReplies[3].content.text));
    });

            it("should deduplicate identical edit events to avoid running twice", async () => {
      const sentReplies = [];
      const mockSock = {
        sendMessage: async (jid, content) => {
          sentReplies.push({ jid, content });
          return { key: { id: 'reply_2' } };
        }
      };

      const editMsg = {
        key: { id: 'edit_protocol_key_2', remoteJid: testChatId },
        pushName: 'Alice',
        message: {
          protocolMessage: {
            key: { id: 'orig_cmd_2', remoteJid: testChatId },
            type: 14,
            editedMessage: {
              conversation: '!ping'
            }
          }
        }
      };

      const details = getEditedMessageDetails(editMsg);
      await handleEditedMessage(mockSock, editMsg, details, 'Test Group');
      assert.equal(sentReplies.length, 1);

      // Re-triggering the same edit immediately should be dropped by deduplication
      await handleEditedMessage(mockSock, editMsg, details, 'Test Group');
      assert.equal(sentReplies.length, 1);
    });

    it('should execute !webcam when a typoed webcam command is edited multiple times via secretEncryptedMessage', async () => {
      const origGetWebcam = scvcc.getCourtWebcamSnapshot;
      const origIsCourtBookingEnabled = groupsConfig.isCourtBookingEnabled;
      const mockImageBuf = Buffer.from('fake-webcam-jpeg');
      scvcc.getCourtWebcamSnapshot = async () => ({ success: true, imageBuffer: mockImageBuf });
      groupsConfig.isCourtBookingEnabled = () => true;

      try {
        const sentReplies = [];
        const mockSock = {
          user: { id: '14084099336:3@s.whatsapp.net', lid: '115694289027280:3@lid' },
          sendMessage: async (jid, content) => {
            sentReplies.push({ jid, content });
            return { key: { id: `reply_webcam_${sentReplies.length}` } };
          }
        };

        const originalMsgId = 'orig_webcam_typo_1';
        const senderLid = '777666555444@lid';
        const messageSecret = Buffer.alloc(32, 0x77);
        const mockStore = new Map();
        mockStore.set(`${testChatId}:${originalMsgId}`, {
          key: { id: originalMsgId, remoteJid: testChatId, participant: senderLid },
          message: {
            ephemeralMessage: {
              message: {
                conversation: '!webacm',
                messageContextInfo: { messageSecret }
              }
            }
          }
        });

        // Edit 1: typo still not right ('!webcm')
        const enc1 = buildEncryptedEditPayload({
          originalMsgId,
          origSender: senderLid,
          editor: senderLid,
          editedConversation: '!webcm',
          messageSecret,
          timestampMs: 1700000001000
        });
        const editMsg1 = {
          key: { id: 'edit_webcam_1', remoteJid: testChatId, participant: `${senderLid.split('@')[0]}:2@lid` },
          pushName: 'Alice',
          message: {
            secretEncryptedMessage: {
              targetMessageKey: { id: originalMsgId, remoteJid: testChatId },
              ...enc1,
              secretEncType: 2
            }
          }
        };
        const details1 = getEditedMessageDetails(editMsg1, mockStore);
        assert.ok(details1);
        assert.equal(details1.text, '!webcm');
        await handleEditedMessage(mockSock, editMsg1, details1, 'Test Group', mockStore);
        assert.equal(sentReplies.length, 0);

        // Edit 2: fixed typo ('!webcam!') — must still find messageSecret preserved in mockStore
        const enc2 = buildEncryptedEditPayload({
          originalMsgId,
          origSender: senderLid,
          editor: senderLid,
          editedConversation: '!webcam!',
          messageSecret,
          timestampMs: 1700000002000
        });
        const editMsg2 = {
          key: { id: 'edit_webcam_2', remoteJid: testChatId, participant: `${senderLid.split('@')[0]}:2@lid` },
          pushName: 'Alice',
          message: {
            secretEncryptedMessage: {
              targetMessageKey: { id: originalMsgId, remoteJid: testChatId },
              ...enc2,
              secretEncType: 2
            }
          }
        };
        const details2 = getEditedMessageDetails(editMsg2, mockStore);
        assert.ok(details2, 'Second secretEncryptedMessage edit must still decrypt using preserved messageSecret');
        assert.equal(details2.text, '!webcam!');
        await handleEditedMessage(mockSock, editMsg2, details2, 'Test Group', mockStore);

        assert.equal(sentReplies.length, 1);
        assert.equal(sentReplies[0].jid, testChatId);
        assert.equal(sentReplies[0].content.image, mockImageBuf);
        assert.match(sentReplies[0].content.caption, /SCVCC Tennis Court Webcam/);
      } finally {
        scvcc.getCourtWebcamSnapshot = origGetWebcam;
        groupsConfig.isCourtBookingEnabled = origIsCourtBookingEnabled;
      }
    });
  });
});
