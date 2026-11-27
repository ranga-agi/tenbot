process.env.NODE_ENV = 'test';
const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const pollTime = require('../lib/pollTime');
const groupsConfig = require('../lib/groupsConfig');
const groupCommands = require('../lib/commands/groupCommands');
const recurringPollsModule = require('../lib/recurringPolls');
const recurringCommands = require('../lib/commands/recurringCommands');
const pollCommands = require('../lib/commands/poll');
const scvcc = require('../lib/scvcc');
const { CLAUDE_TOOLS } = require('../lib/claudeTools');

function createMockSock() {
  const sent = [];
  let counter = 0;
  return {
    sent,
    user: { id: 'bot@s.whatsapp.net', lid: 'bot@lid' },
    async sendMessage(jid, content) {
      counter += 1;
      const msg = {
        key: { remoteJid: jid, id: content.poll ? `msg_${counter}` : `txt_${counter}`, fromMe: true },
        message: content.poll ? {
          pollCreationMessage: {
            name: content.poll.name,
            options: content.poll.values.map((v) => ({ optionName: v }))
          }
        } : content
      };
      sent.push({ jid, content, msg });
      return msg;
    },
    async groupMetadata(jid) {
      return {
        id: jid,
        subject: 'Bot-testing',
        participants: [
          { id: 'admin@s.whatsapp.net', lid: 'admin@lid', admin: 'admin' }
        ]
      };
    }
  };
}

function createContext() {
  return {
    activePolls: new Map(),
    recurringPolls: new Map(),
    messageStore: new Map(),
    latestPollIdByChat: new Map(),
    persistPolls: () => {}
  };
}

describe('Per-Poll Option Limit (maxOptionsPerPoll) Support', () => {
  describe('pollTime option limit helpers', () => {
    it('accepts valid player-count limits (2, 4, 8, 12) up to WhatsApp max', () => {
      assert.deepEqual(pollTime.VALID_POLL_OPTION_LIMITS, [2, 4, 8, 12]);
      assert.equal(pollTime.DEFAULT_MAX_OPTIONS_PER_POLL, 12);

      assert.equal(pollTime.parseMaxOptionsPerPoll(2), 2);
      assert.equal(pollTime.parseMaxOptionsPerPoll(4), 4);
      assert.equal(pollTime.parseMaxOptionsPerPoll(8), 8);
      assert.equal(pollTime.parseMaxOptionsPerPoll(12), 12);

      assert.equal(pollTime.parseMaxOptionsPerPoll('2'), 2);
      assert.equal(pollTime.parseMaxOptionsPerPoll('4 options'), 4);
      assert.equal(pollTime.parseMaxOptionsPerPoll('8 options per poll'), 8);
      assert.equal(pollTime.parseMaxOptionsPerPoll('twelve'), 12);
      assert.equal(pollTime.parseMaxOptionsPerPoll('four options'), 4);
    });

    it('returns null for reset/clear keywords and undefined for invalid or > 12 values', () => {
      assert.equal(pollTime.parseMaxOptionsPerPoll(null), null);
      assert.equal(pollTime.parseMaxOptionsPerPoll('default'), null);
      assert.equal(pollTime.parseMaxOptionsPerPoll('none'), null);
      assert.equal(pollTime.parseMaxOptionsPerPoll('clear'), null);
      assert.equal(pollTime.parseMaxOptionsPerPoll('reset'), null);

      assert.equal(pollTime.parseMaxOptionsPerPoll(undefined), undefined);
      assert.equal(pollTime.parseMaxOptionsPerPoll(''), undefined);
      assert.equal(pollTime.parseMaxOptionsPerPoll(0), undefined);
      assert.equal(pollTime.parseMaxOptionsPerPoll(-2), undefined);
      assert.equal(pollTime.parseMaxOptionsPerPoll(1), undefined);
      assert.equal(pollTime.parseMaxOptionsPerPoll(3), undefined);
      assert.equal(pollTime.parseMaxOptionsPerPoll(5), undefined);
      assert.equal(pollTime.parseMaxOptionsPerPoll(6), undefined);
      assert.equal(pollTime.parseMaxOptionsPerPoll(7), undefined);
      assert.equal(pollTime.parseMaxOptionsPerPoll(9), undefined);
      assert.equal(pollTime.parseMaxOptionsPerPoll(10), undefined);
      assert.equal(pollTime.parseMaxOptionsPerPoll(11), undefined);
      assert.equal(pollTime.parseMaxOptionsPerPoll(13), undefined);
      assert.equal(pollTime.parseMaxOptionsPerPoll(16), undefined);
      assert.equal(pollTime.parseMaxOptionsPerPoll(4.5), undefined);
      assert.equal(pollTime.parseMaxOptionsPerPoll('abc'), undefined);
      assert.equal(pollTime.parseMaxOptionsPerPoll(true), undefined);
    });

    it('normalizes limits with fallback', () => {
      assert.equal(pollTime.normalizeMaxOptionsPerPoll(4, 12), 4);
      assert.equal(pollTime.normalizeMaxOptionsPerPoll('8', 12), 8);
      assert.equal(pollTime.normalizeMaxOptionsPerPoll(6, 12), 12);
      assert.equal(pollTime.normalizeMaxOptionsPerPoll(null, null), null);
    });
  });

  describe('partitionMatchSlots with maxOptionsPerPoll', () => {
    it('partitions slots respecting limits 2, 4, 8, 12 for doubles and singles', () => {
      // Default limit 12
      assert.deepEqual(pollCommands.partitionMatchSlots(12, 4), [12]);
      assert.deepEqual(pollCommands.partitionMatchSlots(16, 4), [12, 4]);
      assert.deepEqual(pollCommands.partitionMatchSlots(20, 4, 12), [12, 8]);

      // Limit 8
      assert.deepEqual(pollCommands.partitionMatchSlots(8, 4, 8), [8]);
      assert.deepEqual(pollCommands.partitionMatchSlots(12, 4, 8), [8, 4]);
      assert.deepEqual(pollCommands.partitionMatchSlots(16, 4, 8), [8, 8]);

      // Limit 4
      assert.deepEqual(pollCommands.partitionMatchSlots(4, 4, 4), [4]);
      assert.deepEqual(pollCommands.partitionMatchSlots(8, 4, 4), [4, 4]);
      assert.deepEqual(pollCommands.partitionMatchSlots(12, 4, 4), [4, 4, 4]);

      // Limit 2 (must work for both doubles spotsPerCourt=4 and singles spotsPerCourt=2)
      assert.deepEqual(pollCommands.partitionMatchSlots(2, 2, 2), [2]);
      assert.deepEqual(pollCommands.partitionMatchSlots(4, 2, 2), [2, 2]);
      assert.deepEqual(pollCommands.partitionMatchSlots(4, 4, 2), [2, 2]);
      assert.deepEqual(pollCommands.partitionMatchSlots(8, 4, 2), [2, 2, 2, 2]);
    });
  });

  describe('groupsConfig & groupCommands support', () => {
    let origConfig;
    beforeEach(() => {
      origConfig = JSON.parse(JSON.stringify(groupsConfig.loadRawConfig() || {}));
    });
    afterEach(() => {
      groupsConfig.saveRawConfig(origConfig);
    });

    it('reads default 12, sets per-group limit, formats it, rejects invalid, and resets', async () => {
      const testGroupJid = groupsConfig.getGroupJid('Bot-testing');
      assert.ok(testGroupJid);
      assert.equal(groupsConfig.getMaxOptionsPerPoll(testGroupJid), 12);

      const updated = groupsConfig.updateGroupConfig('Bot-testing', { maxOptionsPerPoll: 4 });
      assert.equal(updated.maxOptionsPerPoll, 4);
      assert.equal(groupsConfig.getMaxOptionsPerPoll(testGroupJid), 4);
      assert.equal(groupsConfig.getGroupConfig(testGroupJid).maxOptionsPerPoll, 4);

      const formatted = groupsConfig.formatGroupConfig('Bot-testing');
      assert.match(formatted, /Max Options Per Poll:\*\s*4/);

      assert.throws(() => groupsConfig.updateGroupConfig('Bot-testing', { maxOptionsPerPoll: 6 }), /2, 4, 8, or 12/);
      assert.throws(() => groupsConfig.updateGroupConfig('Bot-testing', { maxOptionsPerPoll: 16 }), /not exceed 12/);

      const sock = createMockSock();
      const superAdmins = groupsConfig.getSuperAdminLids();
      const superJid = superAdmins[0] || 'super@lid';

      const cmdRes = await groupCommands.handleGroupCommand(sock, '!setgroupconfig Bot-testing max-options-per-poll=8', 'dm@s.whatsapp.net', superJid);
      if (!cmdRes.includes('Only the bot superadmin')) {
        assert.match(cmdRes, /Max Options Per Poll:\*\s*8/);
        assert.equal(groupsConfig.getMaxOptionsPerPoll(testGroupJid), 8);

        const badCmdRes = await groupCommands.handleGroupCommand(sock, '!setgroupconfig Bot-testing maxOptionsPerPoll=5', 'dm@s.whatsapp.net', superJid);
        assert.match(badCmdRes, /2, 4, 8, or 12/);
      }

      const cleared = groupsConfig.updateGroupConfig('Bot-testing', { maxOptionsPerPoll: 'default' });
      assert.equal(cleared.maxOptionsPerPoll, undefined);
      assert.equal(groupsConfig.getMaxOptionsPerPoll(testGroupJid), 12);
    });
  });

  describe('Command & flag parsing', () => {
    it('extracts explicit flags, JSON keys, clear flags, and natural phrases without colliding with poll size', () => {
      const f1 = recurringPollsModule.extractCommonFlags('!poll 8 tomorrow 7pm --max-options-per-poll=4');
      assert.equal(f1.flags.maxOptionsPerPoll, 4);
      assert.equal(f1.remainingText, '!poll 8 tomorrow 7pm');

      const p1 = pollCommands.parsePollCreationText('!poll 12 tomorrow 7pm --max-options 8');
      assert.equal(p1.size, 12);
      assert.equal(p1.maxOptionsPerPoll, 8);

      const p2 = pollCommands.parsePollCreationText('!poll 8 tomorrow 7pm with 4 options per poll');
      assert.equal(p2.size, 8);
      assert.equal(p2.maxOptionsPerPoll, 4);

      const p3 = pollCommands.parsePollCreationText('!poll 8 tomorrow 7pm limit 4 options');
      assert.equal(p3.size, 8);
      assert.equal(p3.maxOptionsPerPoll, 4);

      const r1 = recurringPollsModule.parseRecurringPollText('!recurringpoll 12 7pm on weekdays --options-per-poll=4');
      assert.equal(r1.size, 12);
      assert.equal(r1.maxOptionsPerPoll, 4);

      const r2 = recurringPollsModule.parseRecurringPollText('!modifyrecurringpoll rec_1 --max-options-per-poll=default');
      assert.equal(r2.action, 'modify');
      assert.equal(r2.updates.maxOptionsPerPoll, null);

      const m1 = pollCommands.parseModifyInstanceCommand('!modifypoll p1 --max-poll-options=4');
      assert.equal(m1.targetId, 'p1');
      assert.equal(m1.updates.maxOptionsPerPoll, 4);

      // Invalid limits are flagged and stripped so they do not become poll size
      const bad = pollCommands.parsePollCreationText('!poll 8 tomorrow 7pm --max-options=6');
      assert.equal(bad.size, 8);
      assert.equal(bad.maxOptionsPerPollInvalid, '6');

      const badNat = pollCommands.parsePollCreationText('!poll 8 tomorrow 7pm max 16 options per poll');
      assert.equal(badNat.size, 8);
      assert.equal(badNat.maxOptionsPerPollInvalid, '16');
    });
  });

  describe('createMatchPoll, splitting, spillover, simulation, and status', () => {
    let origConfig;
    beforeEach(() => {
      origConfig = JSON.parse(JSON.stringify(groupsConfig.loadRawConfig() || {}));
    });
    afterEach(() => {
      groupsConfig.saveRawConfig(origConfig);
    });

    it('splits 8 spots into [4, 4] when maxOptionsPerPoll=4 and preserves creator exclusion/inclusion', async () => {
      const sock = createMockSock();
      const ctx = createContext();
      const groupJid = groupsConfig.getGroupJid('Bot-testing');

      // Creator excluded -> 8 options total, limit 4 -> 2 polls of 4 options each
      const res = await pollCommands.createMatchPoll(
        sock, groupJid, 8, 'tomorrow 7pm', 'tomorrow', '7pm',
        'Alice', 'alice@lid', false,
        null, false, true, false, false, false, false, null, null, null, null, null, null, null,
        ctx, { maxOptionsPerPoll: 4 }
      );
      assert.equal(res.err, null);
      assert.equal(res.isMultiPoll, true);
      assert.deepEqual(res.batches, [4, 4]);
      assert.equal(res.maxOptionsPerPoll, 4);
      assert.equal(res.pollIds.length, 2);
      assert.equal(sock.sent.length, 2);
      assert.deepEqual(sock.sent[0].content.poll.values, ['Player 1', 'Player 2', 'Player 3', 'Player 4']);
      assert.deepEqual(sock.sent[1].content.poll.values, ['Player 5', 'Player 6', 'Player 7', 'Player 8']);
      assert.match(sock.sent[0].content.poll.name, /Part 1\/2: Spots 1–4/);
      assert.match(sock.sent[1].content.poll.name, /Part 2\/2: Spots 5–8/);

      const statusOut = pollCommands.pollStatusText(groupJid, 'Alice', ctx, 'bot@s.whatsapp.net');
      assert.match(statusOut, /Max Options Per Poll: 4/);
    });

    it('splits 8 spots with creator included into Part 1 (3 voting options) and Part 2 (4 voting options)', async () => {
      const sock = createMockSock();
      const ctx = createContext();
      const groupJid = groupsConfig.getGroupJid('Bot-testing');

      const res = await pollCommands.createMatchPoll(
        sock, groupJid, 8, 'tomorrow 7pm', 'tomorrow', '7pm',
        'Alice', 'alice@lid', true,
        null, false, true, false, false, false, false, null, null, null, null, null, null, null,
        ctx, { maxOptionsPerPoll: 4 }
      );
      assert.equal(res.err, null);
      assert.equal(res.isMultiPoll, true);
      assert.deepEqual(res.batches, [4, 4]);
      assert.deepEqual(sock.sent[0].content.poll.values, ['Player 2', 'Player 3', 'Player 4']);
      assert.deepEqual(sock.sent[1].content.poll.values, ['Player 5', 'Player 6', 'Player 7', 'Player 8']);
      assert.equal(sock.sent[0].content.poll.values.length <= 4, true);
      assert.equal(sock.sent[1].content.poll.values.length <= 4, true);
    });

    it('opens initial polls up to maxInitialPolls and spills over remaining parts on demand (12 spots, limit 4)', async () => {
      const sock = createMockSock();
      const ctx = createContext();
      const groupJid = groupsConfig.getGroupJid('Bot-testing');

      const res = await pollCommands.createMatchPoll(
        sock, groupJid, 12, 'tomorrow 7pm', 'tomorrow', '7pm',
        'Alice', 'alice@lid', false,
        null, false, true, true, false, false, false, null, null, null, null, null, null, null,
        ctx, { maxOptionsPerPoll: 4 }
      );
      assert.equal(res.err, null);
      assert.equal(res.isMultiPoll, true);
      assert.deepEqual(res.batches, [4, 4, 4]);
      assert.equal(res.totalParts, 3);
      // maxInitialPolls defaults to 2 -> Part 1 and Part 2 created upfront
      assert.equal(res.pollIds.length, 2);
      assert.equal(sock.sent.filter((s) => s.content.poll).length, 2);

      const p1Id = res.pollIds[0];
      const p2Id = res.pollIds[1];
      const p1State = ctx.activePolls.get(p1Id);
      const p2State = ctx.activePolls.get(p2Id);
      assert.equal(p1State.maxOptionsPerPoll, 4);
      assert.deepEqual(p1State.plannedBatches, [4, 4, 4]);

      const makeOptHash = (opt) => crypto.createHash('sha256').update(opt).digest();

      // Store pollCreationMessage structures so processPollVoteEvent can decode votes
      for (const sItem of sock.sent) {
        if (sItem.content.poll) {
          ctx.messageStore.set(`${groupJid}:${sItem.msg.key.id}`, {
            pollCreationMessage: sItem.msg.message.pollCreationMessage
          });
        }
      }

      // Fill Part 1
      for (let i = 0; i < 4; i++) {
        const voter = `1408555010${i}@s.whatsapp.net`;
        p1State.voteBuffer.set(voter, {
          pollUpdateMessageKey: { participant: voter },
          vote: { selectedOptions: [makeOptHash(p1State.options[i])] }
        });
      }
      p1State.status = 'filled';
      p1State.lastPlayers = ['P1', 'P2', 'P3', 'P4'];

      // Buffer votes 5..7 on Part 2 and deliver vote 8 via processPollVoteEvent -> triggers Part 3 spillover!
      for (let i = 0; i < 3; i++) {
        const voter = `1408555020${i}@s.whatsapp.net`;
        p2State.voteBuffer.set(voter, {
          pollUpdateMessageKey: { participant: voter },
          vote: { selectedOptions: [makeOptHash(p2State.options[i])] }
        });
      }
      const p2FinalVoter = '14085550203@s.whatsapp.net';
      await pollCommands.processPollVoteEvent(
        sock,
        { id: p2Id, remoteJid: groupJid },
        [{ pollUpdateMessageKey: { participant: p2FinalVoter }, vote: { selectedOptions: [makeOptHash(p2State.options[3])] } }],
        ctx
      );

      // Part 3 should now be created with 4 options (Player 9 .. Player 12) and maxOptionsPerPoll=4
      const createdPolls = sock.sent.filter((s) => s.content.poll);
      assert.equal(createdPolls.length, 3);
      assert.deepEqual(createdPolls[2].content.poll.values, ['Player 9', 'Player 10', 'Player 11', 'Player 12']);
      assert.match(createdPolls[2].content.poll.name, /Part 3\/3: Spots 9–12/);
      assert.equal(ctx.activePolls.size, 3);
      const p3State = [...ctx.activePolls.values()].find((p) => p.partNumber === 3);
      assert.ok(p3State);
      assert.equal(p3State.maxOptionsPerPoll, 4);
      assert.equal(p3State.size, 4);
    });

    it('applies precedence: explicit > recurring schedule > group config > 12', async () => {
      const sock = createMockSock();
      const ctx = createContext();
      const groupJid = groupsConfig.getGroupJid('Bot-testing');

      // Set group default to 8
      groupsConfig.updateGroupConfig('Bot-testing', { maxOptionsPerPoll: 8 });
      const resGroup = await pollCommands.createMatchPoll(
        sock, groupJid, 12, 'tomorrow 7pm', 'tomorrow', '7pm',
        'Alice', 'alice@lid', false,
        null, false, true, false, false, false, false, null, null, null, null, null, null, null,
        ctx, { simulate: true }
      );
      assert.equal(resGroup.maxOptionsPerPoll, 8);
      assert.deepEqual(resGroup.batches, [8, 4]);

      // Schedule overrides group default with 4
      ctx.recurringPolls.set('rec_test', { id: 'rec_test', remoteJid: groupJid, maxOptionsPerPoll: 4 });
      const resSched = await pollCommands.createMatchPoll(
        sock, groupJid, 12, 'tomorrow 7pm', 'tomorrow', '7pm',
        'Alice', 'alice@lid', false,
        null, false, true, false, false, false, true, 'rec_test', null, null, null, null, null, null,
        ctx, { simulate: true }
      );
      assert.equal(resSched.maxOptionsPerPoll, 4);
      assert.deepEqual(resSched.batches, [4, 4, 4]);

      // Explicit overrides schedule with 2
      const resExp = await pollCommands.createMatchPoll(
        sock, groupJid, 4, 'tomorrow 7pm', 'tomorrow', '7pm',
        'Alice', 'alice@lid', false,
        null, false, true, false, false, false, true, 'rec_test', null, null, null, null, null, null,
        ctx, { simulate: true, maxOptionsPerPoll: 2 }
      );
      assert.equal(resExp.maxOptionsPerPoll, 2);
      assert.deepEqual(resExp.batches, [2, 2]);
    });

    it('rejects invalid maxOptionsPerPoll in handleDirectPollCreation and createMatchPoll', async () => {
      const sock = createMockSock();
      const ctx = createContext();
      const groupJid = groupsConfig.getGroupJid('Bot-testing');

      const parsedBad = pollCommands.parsePollCreationText('!poll 8 tomorrow 7pm --max-options-per-poll=6');
      const directRes = await pollCommands.handleDirectPollCreation(sock, groupJid, 'Alice', { key: { participant: 'alice@lid', remoteJid: groupJid } }, parsedBad, { isCommand: true }, ctx);
      assert.match(directRes, /Invalid poll option limit "6"/);
      assert.equal(sock.sent.length, 0);

      const badCreate = await pollCommands.createMatchPoll(
        sock, groupJid, 8, 'tomorrow 7pm', 'tomorrow', '7pm',
        'Alice', 'alice@lid', false,
        null, false, true, false, false, false, false, null, null, null, null, null, null, null,
        ctx, { maxOptionsPerPoll: 16 }
      );
      assert.match(badCreate.err, /Must not exceed 12/);
    });

    it('includes maxOptionsPerPoll and split breakdown in handleSimulatePoll summary', async () => {
      const sock = createMockSock();
      const ctx = createContext();
      const groupJid = groupsConfig.getGroupJid('Bot-testing');

      const parsed = pollCommands.parsePollCreationText('!simulatepoll 8 tomorrow 7pm --max-options-per-poll=4 --courts-strategy=none');
      const simSummary = await pollCommands.handleSimulatePoll(sock, groupJid, 'Alice', { key: { participant: 'alice@lid', remoteJid: groupJid } }, parsed, { isCommand: true }, ctx);
      assert.match(simSummary, /Max Options Per Poll:\*\s*4 \(splits into 2 polls: \[4, 4\]\)/);
    });
  });

  describe('modify_poll_instance support', () => {
    let origConfig;
    beforeEach(() => {
      origConfig = JSON.parse(JSON.stringify(groupsConfig.loadRawConfig() || {}));
    });
    afterEach(() => {
      groupsConfig.saveRawConfig(origConfig);
    });

    it('splits an 8-spot poll when maxOptionsPerPoll is changed from 12 to 4, and preserves sessionTotalSize when changed back to 8', async () => {
      const sock = createMockSock();
      const ctx = createContext();
      const groupJid = groupsConfig.getGroupJid('Bot-testing');

      const res = await pollCommands.createMatchPoll(
        sock, groupJid, 8, 'tomorrow 7pm', 'tomorrow', '7pm',
        'Admin', 'admin@s.whatsapp.net', false,
        null, false, true, false, false, false, false, null, null, null, null, null, null, null,
        ctx, {}
      );
      const origPollId = res.pollId;
      assert.equal(ctx.activePolls.size, 1);

      const modTo4 = await pollCommands.handleModifyPollInstance(
        sock, groupJid, 'Admin', 'admin@s.whatsapp.net', origPollId, { maxOptionsPerPoll: 4 }, ctx
      );
      assert.match(modTo4, /Max Options Per Poll:\*\s*4 \(batches: \[4, 4\]\)/);
      assert.equal(ctx.activePolls.size, 2);

      const firstNewId = [...ctx.activePolls.keys()][0];
      assert.equal(ctx.activePolls.get(firstNewId).sessionTotalSize, 8);
      assert.equal(ctx.activePolls.get(firstNewId).maxOptionsPerPoll, 4);

      const modTo8 = await pollCommands.handleModifyPollInstance(
        sock, groupJid, 'Admin', 'admin@s.whatsapp.net', firstNewId, { maxOptionsPerPoll: 8 }, ctx
      );
      assert.match(modTo8, /8 spots/);
      assert.match(modTo8, /Max Options Per Poll:\*\s*8/);
      assert.equal(ctx.activePolls.size, 1);

      const badMod = await pollCommands.handleModifyPollInstance(
        sock, groupJid, 'Admin', 'admin@s.whatsapp.net', [...ctx.activePolls.keys()][0], { maxOptionsPerPoll: 5 }, ctx
      );
      assert.match(badMod, /2, 4, 8, or 12/);
    });
  });

  describe('Recurring schedules, simulation & scheduler support', () => {
    let origConfig;
    let origCheckAvail;
    let origGetBookings;
    beforeEach(() => {
      origConfig = JSON.parse(JSON.stringify(groupsConfig.loadRawConfig() || {}));
      origCheckAvail = scvcc.checkCourtAvailability;
      origGetBookings = scvcc.getCourtBookings;
      scvcc.checkCourtAvailability = async () => ({
        slots: [{
          time: '7:00 PM',
          courts: [
            { court: 'Court 1', status: 'available', availableMinutes: 90 },
            { court: 'Court 2', status: 'available', availableMinutes: 90 },
            { court: 'Court 3', status: 'available', availableMinutes: 90 }
          ]
        }]
      });
      scvcc.getCourtBookings = async () => ({ bookings: [] });
    });
    afterEach(() => {
      groupsConfig.saveRawConfig(origConfig);
      scvcc.checkCourtAvailability = origCheckAvail;
      scvcc.getCourtBookings = origGetBookings;
    });

    it('creates, displays, simulates, modifies, and posts recurring schedules with maxOptionsPerPoll', async () => {
      const sock = createMockSock();
      const ctx = createContext();
      const groupJid = groupsConfig.getGroupJid('Bot-testing');

      const badSched = await recurringPollsModule.scheduleRecurringPoll({
        recurringPolls: ctx.recurringPolls,
        persistPolls: ctx.persistPolls,
        targetChatId: groupJid,
        sender: 'Alice',
        senderJid: 'alice@lid',
        params: { size: 8, matchTime: '7pm', postTime: '8am', days: 'weekdays', maxOptionsPerPoll: 6, courtsStrategy: 'none' }
      });
      assert.match(badSched, /2, 4, 8, or 12/);
      assert.equal(ctx.recurringPolls.size, 0);

      const okSched = await recurringPollsModule.scheduleRecurringPoll({
        recurringPolls: ctx.recurringPolls,
        persistPolls: ctx.persistPolls,
        targetChatId: groupJid,
        sender: 'Alice',
        senderJid: 'alice@lid',
        params: { size: 12, matchTime: '7pm', postTime: '8am', days: 'friday', maxOptionsPerPoll: 4, includeCreator: false, courtsStrategy: 'lookup' }
      });
      assert.match(okSched, /Max Options Per Poll:\*\s*4/);
      const [schedId, sched] = [...ctx.recurringPolls.entries()][0];
      assert.equal(sched.maxOptionsPerPoll, 4);

      const simOut = await recurringPollsModule.simulateRecurringPoll({
        sock,
        recurringPolls: ctx.recurringPolls,
        scheduleId: schedId,
        targetDayOrDate: '2026-11-20',
        chatId: groupJid,
        sender: 'Alice',
        senderJid: 'alice@lid',
        createMatchPoll: pollCommands.createMatchPoll
      });
      assert.match(simOut, /Max Options Per Poll:\*\s*4 \(splits into 3 polls: \[4, 4, 4\]\)/);

      // Scheduled posting via checkAndPostRecurringPolls honors sched.maxOptionsPerPoll
      await recurringPollsModule.checkAndPostRecurringPolls({
        sock,
        recurringPolls: ctx.recurringPolls,
        activePolls: ctx.activePolls,
        persistPolls: ctx.persistPolls,
        createMatchPoll: pollCommands.createMatchPoll,
        context: ctx,
        customSanJoseParts: { year: 2026, month: 10, day: 20, dayOfWeek: 5, hour: 8, minute: 5 }
      });
      assert.equal(ctx.activePolls.size, 2); // 12 spots / 4 = 3 parts, maxInitialPolls=2 upfront
      for (const p of ctx.activePolls.values()) {
        assert.equal(p.maxOptionsPerPoll, 4);
        assert.equal(p.size, 4);
      }

      const badMod = await recurringPollsModule.modifyRecurringPoll({
        recurringPolls: ctx.recurringPolls,
        persistPolls: ctx.persistPolls,
        activePolls: ctx.activePolls,
        sender: 'Alice',
        scheduleId: schedId,
        updates: { maxOptionsPerPoll: 10 }
      });
      assert.match(badMod, /2, 4, 8, or 12/);

      const mod8 = await recurringPollsModule.modifyRecurringPoll({
        recurringPolls: ctx.recurringPolls,
        persistPolls: ctx.persistPolls,
        activePolls: ctx.activePolls,
        sender: 'Alice',
        scheduleId: schedId,
        updates: { maxOptionsPerPoll: 8 }
      });
      assert.match(mod8, /Max Options Per Poll: \*8\*/);
      assert.equal(sched.maxOptionsPerPoll, 8);

      const modReset = await recurringPollsModule.modifyRecurringPoll({
        recurringPolls: ctx.recurringPolls,
        persistPolls: ctx.persistPolls,
        activePolls: ctx.activePolls,
        sender: 'Alice',
        scheduleId: schedId,
        updates: { maxOptionsPerPoll: 'default' }
      });
      assert.match(modReset, /Default/);
      assert.equal(sched.maxOptionsPerPoll, undefined);
    });
  });

  describe('Claude AI tool schemas and execution', () => {
    it('defines maxOptionsPerPoll in all relevant CLAUDE_TOOLS schemas', () => {
      const toolNames = [
        'simulate_poll',
        'create_poll',
        'schedule_recurring_poll',
        'modify_recurring_poll',
        'modify_poll_instance',
        'add_group',
        'update_group_config'
      ];
      for (const name of toolNames) {
        const tool = CLAUDE_TOOLS.find((t) => t.name === name);
        assert.ok(tool, `Expected tool ${name} to exist`);
        assert.ok(tool.input_schema.properties.maxOptionsPerPoll, `Expected maxOptionsPerPoll property on ${name}`);
        assert.match(tool.input_schema.properties.maxOptionsPerPoll.description, /2, 4, 8, or 12/);
      }
    });

    it('forwards and validates maxOptionsPerPoll in executePollTool and executeRecurringTool', async () => {
      const sock = createMockSock();
      const ctx = createContext();
      const groupJid = groupsConfig.getGroupJid('Bot-testing');
      const fakeMsg = { key: { participant: 'alice@lid', remoteJid: groupJid } };

      const simBad = await pollCommands.executePollTool(sock, 'simulate_poll', {
        size: 8, when: 'tomorrow 7pm', maxOptionsPerPoll: 6, checkCourts: false
      }, 'Alice', 'alice@lid', groupJid, fakeMsg, ctx);
      assert.match(simBad, /2, 4, 8, or 12/);

      const simOk = await pollCommands.executePollTool(sock, 'simulate_poll', {
        size: 8, when: 'tomorrow 7pm', maxOptionsPerPoll: 4, checkCourts: false, includeCreator: false
      }, 'Alice', 'alice@lid', groupJid, fakeMsg, ctx);
      assert.match(simOk, /Max Options Per Poll:\*\s*4 \(splits into 2 polls: \[4, 4\]\)/);

      const recOk = await recurringCommands.executeRecurringTool(sock, 'schedule_recurring_poll', {
        size: 8, matchTime: '7pm', postTime: '8am', days: 'weekdays', maxOptionsPerPoll: 4
      }, 'Alice', 'admin@s.whatsapp.net', groupJid, ctx);
      assert.match(recOk, /Max Options Per Poll:\*\s*4/);
    });
  });
});
