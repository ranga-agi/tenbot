const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const pollStore = require('../lib/pollStore');
const { DATA_DIR } = require('../lib/paths');

describe('pollStore subfolder & multi-file architecture', () => {
  const testChatId = 'test_group_999@g.us';
  const testGroupDir = pollStore.getGroupDir(testChatId);

  afterEach(() => {
    // Cleanup test folder if created
    if (fs.existsSync(testGroupDir)) {
      fs.rmSync(testGroupDir, { recursive: true, force: true });
    }
  });

  it('should save state in subfolder with recurring.json, meta.json, individual polls/*.json, and messages.jsonl', () => {
    const pollId1 = 'poll_test_001';
    const pollId2 = 'poll_test_002';

    const pollState1 = {
      remoteJid: testChatId,
      name: 'Tennis Monday 7pm',
      options: ['Player 1', 'Player 2'],
      size: 4,
      status: 'active',
      voteBuffer: new Map([
        ['user1', { vote: { selectedOptions: [Buffer.from([1, 2, 3])] } }]
      ])
    };

    const pollState2 = {
      remoteJid: testChatId,
      name: 'Tennis Tuesday 6pm',
      options: ['Yes', 'No'],
      type: 'opt_in',
      status: 'active',
      voteBuffer: new Map()
    };

    const creationMsg1 = {
      pollCreationMessage: { name: 'Tennis Monday 7pm', options: [] }
    };

    const messageStore = new Map([
      [`${testChatId}:${pollId1}`, creationMsg1],
      [`${testChatId}:general_alert`, { text: 'Tennis alert' }]
    ]);

    const activePolls = new Map([
      [pollId1, pollState1],
      [pollId2, pollState2]
    ]);

    const latestPollIdByChat = new Map([[testChatId, pollId2]]);

    const recurringPolls = new Map([
      ['rec_test_1', { id: 'rec_test_1', remoteJid: testChatId, matchTime: '7pm', days: 'mon,wed' }]
    ]);

    pollStore.save({ messageStore, activePolls, latestPollIdByChat, recurringPolls }, testChatId);

    // Verify directory structure
    assert.ok(fs.existsSync(testGroupDir));
    assert.ok(fs.existsSync(path.join(testGroupDir, 'meta.json')));
    assert.ok(fs.existsSync(path.join(testGroupDir, 'recurring.json')));
    assert.ok(fs.existsSync(path.join(testGroupDir, 'polls')));
    assert.ok(fs.existsSync(path.join(testGroupDir, 'messages.jsonl'))); // has general_alert in JSONL format

    // Verify JSONL line contents
    const jsonlContent = fs.readFileSync(path.join(testGroupDir, 'messages.jsonl'), 'utf-8').trim();
    const lines = jsonlContent.split('\n');
    assert.equal(lines.length, 1);
    const parsedLine = JSON.parse(lines[0]);
    assert.equal(parsedLine.key, `${testChatId}:general_alert`);
    assert.ok(parsedLine.date);
    assert.ok(parsedLine.timestamp);
    assert.equal(parsedLine.message.text, 'Tennis alert');

    // Verify individual poll instance files
    const pollFile1 = path.join(testGroupDir, 'polls', `${pollId1}.json`);
    const pollFile2 = path.join(testGroupDir, 'polls', `${pollId2}.json`);
    assert.ok(fs.existsSync(pollFile1));
    assert.ok(fs.existsSync(pollFile2));

    const pollData1 = pollStore.readJsonSafe(pollFile1);
    assert.equal(pollData1.pollId, pollId1);
    assert.equal(pollData1.pollState.name, 'Tennis Monday 7pm');
    assert.ok(pollData1.creationMessage);
    assert.equal(pollData1.creationMessage.pollCreationMessage.name, 'Tennis Monday 7pm');

    // Verify recurring.json
    const recData = pollStore.readJsonSafe(path.join(testGroupDir, 'recurring.json'));
    assert.ok(recData.recurringPolls instanceof Map);
    assert.equal(recData.recurringPolls.size, 1);
    assert.equal(recData.recurringPolls.get('rec_test_1').matchTime, '7pm');

    // Verify meta.json
    const metaData = pollStore.readJsonSafe(path.join(testGroupDir, 'meta.json'));
    assert.equal(metaData.chatId, testChatId);
    assert.equal(metaData.latestPollId, pollId2);
  });

  it('should accurately reload group state from subfolder', () => {
    const pollId = 'poll_reload_1';
    const pollState = {
      remoteJid: testChatId,
      name: 'Sunday Hit',
      options: ['P1', 'P2'],
      size: 4,
      status: 'active',
      voteBuffer: new Map([
        ['user_abc', { vote: { selectedOptions: [Buffer.from([99, 100])] } }]
      ])
    };

    const messageStore = new Map([
      [`${testChatId}:${pollId}`, { pollCreationMessage: { name: 'Sunday Hit' } }]
    ]);
    const activePolls = new Map([[pollId, pollState]]);
    const latestPollIdByChat = new Map([[testChatId, pollId]]);
    const recurringPolls = new Map([
      ['rec_sun', { id: 'rec_sun', remoteJid: testChatId, matchTime: '9am' }]
    ]);

    pollStore.save({ messageStore, activePolls, latestPollIdByChat, recurringPolls }, testChatId);

    const reloaded = pollStore.loadGroup(testChatId);
    assert.equal(reloaded.chatId, testChatId);
    assert.equal(reloaded.activePolls.size, 1);
    assert.equal(reloaded.activePolls.get(pollId).name, 'Sunday Hit');

    // Verify Buffer deserialization in voteBuffer
    const voterEntry = reloaded.activePolls.get(pollId).voteBuffer.get('user_abc');
    assert.ok(voterEntry);
    assert.ok(Buffer.isBuffer(voterEntry.vote.selectedOptions[0]));
    assert.deepEqual([...voterEntry.vote.selectedOptions[0]], [99, 100]);

    // Verify creation message co-located in messageStore
    assert.equal(reloaded.messageStore.size, 1);
    assert.ok(reloaded.messageStore.has(`${testChatId}:${pollId}`));

    // Verify recurring schedule
    assert.equal(reloaded.recurringPolls.size, 1);
    assert.equal(reloaded.recurringPolls.get('rec_sun').matchTime, '9am');

    // Verify latest poll ID
    assert.equal(reloaded.latestPollIdByChat.get(testChatId), pollId);
  });

  it('should prune messages older than 14 days from messages.jsonl', () => {
    const now = Date.now();
    const sixteenDaysAgoSec = Math.floor((now - 16 * 24 * 60 * 60 * 1000) / 1000);
    const twoDaysAgoSec = Math.floor((now - 2 * 24 * 60 * 60 * 1000) / 1000);

    fs.mkdirSync(testGroupDir, { recursive: true });
    const messagesFile = path.join(testGroupDir, 'messages.jsonl');
    const items = [
      { key: `${testChatId}:msg_expired`, timestamp: sixteenDaysAgoSec * 1000, message: { text: 'Old alert' } },
      { key: `${testChatId}:msg_recent`, timestamp: twoDaysAgoSec * 1000, message: { text: 'Recent alert' } }
    ];
    fs.writeFileSync(messagesFile, items.map(x => JSON.stringify(x)).join('\n') + '\n', 'utf-8');

    const loaded = pollStore.loadGroup(testChatId);
    assert.equal(loaded.messageStore.has(`${testChatId}:msg_expired`), false);
    assert.equal(loaded.messageStore.has(`${testChatId}:msg_recent`), true);
  });

  it('should automatically delete individual poll file when poll is removed from activePolls', () => {
    const pollId1 = 'poll_keep';
    const pollId2 = 'poll_remove';

    const pState1 = { remoteJid: testChatId, name: 'Poll 1', status: 'active', voteBuffer: new Map() };
    const pState2 = { remoteJid: testChatId, name: 'Poll 2', status: 'active', voteBuffer: new Map() };

    const activePolls = new Map([[pollId1, pState1], [pollId2, pState2]]);
    pollStore.save({ messageStore: new Map(), activePolls, latestPollIdByChat: new Map(), recurringPolls: new Map() }, testChatId);

    const pollFile1 = path.join(testGroupDir, 'polls', `${pollId1}.json`);
    const pollFile2 = path.join(testGroupDir, 'polls', `${pollId2}.json`);
    assert.ok(fs.existsSync(pollFile1));
    assert.ok(fs.existsSync(pollFile2));

    // Remove pollId2 and save again
    activePolls.delete(pollId2);
    pollStore.save({ messageStore: new Map(), activePolls, latestPollIdByChat: new Map(), recurringPolls: new Map() }, testChatId);

    assert.ok(fs.existsSync(pollFile1));
    assert.equal(fs.existsSync(pollFile2), false); // file should be removed!
  });

});
