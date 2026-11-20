process.env.NODE_ENV = 'test';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const pollCommands = require('../lib/commands/poll');
const { formatPollTitle } = require('../lib/commands/poll/roster');
const { getCleanLogicalPollName } = require('../lib/commands/poll/reminders');
const recurringPollsModule = require('../lib/recurringPolls');
const { routeCommand, executeTool } = require('../lib/commands/index');
const { CLAUDE_TOOLS } = require('../lib/claudeTools');
const scvcc = require('../lib/scvcc');
const ratings = require('../lib/ratings');

function createMockSock(prefix = 'poll_msg') {
  const sentMessages = [];
  let seq = 0;
  return {
    user: { id: 'bot@s.whatsapp.net' },
    groupMetadata: async (jid) => ({
      id: jid,
      subject: 'Test Tennis Group',
      participants: [
        { id: 'alice@s.whatsapp.net', admin: 'admin' },
        { id: 'bob@s.whatsapp.net', admin: null }
      ]
    }),
    sentMessages,
    sendMessage: async (jid, msg, opts) => {
      seq += 1;
      const id = `${prefix}_${seq}_${Math.random().toString(36).slice(2, 6)}`;
      const message = msg?.poll
        ? {
            pollCreationMessage: {
              name: msg.poll.name,
              options: (msg.poll.values || []).map((v) => ({ optionName: v })),
              selectableOptionsCount: msg.poll.selectableCount
            }
          }
        : msg;
      const sent = { key: { id, remoteJid: jid, fromMe: true }, message };
      sentMessages.push({ jid, msg, sent, opts });
      return sent;
    }
  };
}

function hashOptionName(optName) {
  return crypto.createHash('sha256').update(Buffer.from(optName, 'utf8')).digest();
}

describe('Custom Poll Title Support', () => {
  describe('normalizePollTitle and flag/text parsing', () => {
    it('normalizes titles and clear keywords cleanly', () => {
      assert.equal(recurringPollsModule.normalizePollTitle(undefined), undefined);
      assert.equal(recurringPollsModule.normalizePollTitle(null), null);
      assert.equal(recurringPollsModule.normalizePollTitle(''), null);
      assert.equal(recurringPollsModule.normalizePollTitle('  ""  '), null);
      assert.equal(recurringPollsModule.normalizePollTitle('none'), null);
      assert.equal(recurringPollsModule.normalizePollTitle('CLEAR'), null);
      assert.equal(recurringPollsModule.normalizePollTitle('remove'), null);
      assert.equal(recurringPollsModule.normalizePollTitle('default'), null);
      assert.equal(recurringPollsModule.normalizePollTitle('  \u201cFriday Night Slam\u201d  '), 'Friday Night Slam');
      assert.equal(recurringPollsModule.normalizePollTitle("  'Morning Hit'  "), 'Morning Hit');
    });

    it('extracts title from CLI flags, key=value, smart quotes, natural language, and JSON maps', () => {
      const f1 = recurringPollsModule.extractCommonFlags('4 tomorrow 7pm --title="Friday Night Slam"');
      assert.equal(f1.flags.title, 'Friday Night Slam');
      assert.equal(f1.remainingText.replace(/\s+/g, ' ').trim(), '4 tomorrow 7pm');

      const f2 = recurringPollsModule.extractCommonFlags('4 tomorrow 7pm --poll-title \u201cSmart Quoted Cup\u201d');
      assert.equal(f2.flags.title, 'Smart Quoted Cup');

      const f3 = recurringPollsModule.extractCommonFlags('4 tomorrow 7pm title=SingleWord');
      assert.equal(f3.flags.title, 'SingleWord');

      const f4 = recurringPollsModule.extractCommonFlags('4 tomorrow 7pm titled "Weekend Ladder"');
      assert.equal(f4.flags.title, 'Weekend Ladder');

      const f5 = recurringPollsModule.extractCommonFlags('4 tomorrow 7pm called \'Twilight Doubles\'');
      assert.equal(f5.flags.title, 'Twilight Doubles');

      const f6 = recurringPollsModule.extractCommonFlags('4 tomorrow 7pm with the title "Coach Session"');
      assert.equal(f6.flags.title, 'Coach Session');

      const f7 = recurringPollsModule.extractCommonFlags('4 tomorrow 7pm named "Club Championship"');
      assert.equal(f7.flags.title, 'Club Championship');

      const fJson = recurringPollsModule.extractCommonFlags('4 tomorrow 7pm', { pollTitle: 'JSON Ladder' });
      assert.equal(fJson.flags.title, 'JSON Ladder');
    });

    it('supports clearing title via --no-title, --clear-title, --title=none, and title:clear', () => {
      assert.equal(recurringPollsModule.extractCommonFlags('rec_1 --no-title').flags.title, null);
      assert.equal(recurringPollsModule.extractCommonFlags('rec_1 --clear-title').flags.title, null);
      assert.equal(recurringPollsModule.extractCommonFlags('rec_1 --title=none').flags.title, null);
      assert.equal(recurringPollsModule.extractCommonFlags('rec_1 title:clear').flags.title, null);
      assert.equal(recurringPollsModule.extractCommonFlags('rec_1', { title: 'none' }).flags.title, null);
    });

    it('isolates words inside custom titles from polluting poll size, day, opt-in, daily, or includeCreator checks', () => {
      const parsed = pollCommands.parsePollCreationText(
        '!poll 4 tomorrow 7pm --title="Friday Open Play Daily Match not playing 16"'
      );
      assert.ok(parsed);
      assert.equal(parsed.title, 'Friday Open Play Daily Match not playing 16');
      assert.equal(parsed.size, 4);
      assert.equal(parsed.dayWord, 'tomorrow');
      assert.equal(parsed.timeWord, '7pm');
      assert.equal(parsed.includeCreator, true);
    });

    it('parses title in recurring poll create and modify commands', () => {
      const created = recurringPollsModule.parseRecurringPollText(
        '!recurringpoll 8 7pm mon-wed at 8am --title="Weeknight Ladder"'
      );
      assert.equal(created.action, 'create');
      assert.equal(created.title, 'Weeknight Ladder');
      assert.equal(created.size, 8);

      const modified = recurringPollsModule.parseRecurringPollText(
        '!modifyrecurringpoll rec_abc --title="Updated Ladder"'
      );
      assert.equal(modified.action, 'modify');
      assert.equal(modified.scheduleId, 'rec_abc');
      assert.equal(modified.updates.title, 'Updated Ladder');

      const cleared = recurringPollsModule.parseRecurringPollText(
        '!modifyrecurringpoll rec_abc --no-title'
      );
      assert.equal(cleared.action, 'modify');
      assert.equal(cleared.updates.title, null);
    });

    it('parses title in !modifyinstance both with and without explicit targetId', () => {
      const withId = pollCommands.parseModifyInstanceCommand('!modifyinstance rec_1 --title="Cup Finals" 8');
      assert.equal(withId.targetId, 'rec_1');
      assert.equal(withId.updates.title, 'Cup Finals');
      assert.equal(withId.updates.size, 8);

      const withoutIdFlag = pollCommands.parseModifyInstanceCommand('!modifyinstance --title="Solo Title"');
      assert.equal(withoutIdFlag.targetId, null);
      assert.equal(withoutIdFlag.updates.title, 'Solo Title');

      const withoutIdKv = pollCommands.parseModifyInstanceCommand('!modifyinstance title="Solo KV Title"');
      assert.equal(withoutIdKv.targetId, null);
      assert.equal(withoutIdKv.updates.title, 'Solo KV Title');

      const withoutIdNl = pollCommands.parseModifyInstanceCommand('!modifyinstance titled "Solo NL Title"');
      assert.equal(withoutIdNl.targetId, null);
      assert.equal(withoutIdNl.updates.title, 'Solo NL Title');

      const clearCmd = pollCommands.parseModifyInstanceCommand('!modifyinstance rec_1 --no-title');
      assert.equal(clearCmd.targetId, 'rec_1');
      assert.equal(clearCmd.updates.title, null);
    });
  });

  describe('Direct poll creation, simulation, split polls, multi-time, and future scheduling', () => {
    it('formats poll titles consistently via formatPollTitle', () => {
      assert.equal(
        formatPollTitle({
          customTitle: 'Club Night',
          isSimulation: false,
          creatorLabel: "Alice's poll: ",
          timeLabel: 'Tomorrow 7pm',
          suffix: ' (3 slots / 4)',
          courtLine: '\n\nCourt 2 - Booked\nCourt 4 - Available\n'
        }),
        '🎾 Club Night\n\nCourt 2 - Booked\nCourt 4 - Available\n'
      );
      assert.equal(
        formatPollTitle({
          customTitle: 'Sim Club Night',
          isSimulation: true,
          creatorLabel: "Alice's poll: ",
          timeLabel: 'Tomorrow 7pm',
          suffix: ' (3 slots / 4)',
          courtLine: '\n\nCourt 1 - Available\n'
        }),
        '🎾 [Simulation] Sim Club Night\n\nCourt 1 - Available\n'
      );
      assert.equal(
        formatPollTitle({
          customTitle: null,
          isSimulation: true,
          creatorLabel: '',
          timeLabel: 'Tomorrow 7pm',
          suffix: ' (Vote Yes/No)'
        }),
        '🎾 [Simulation] Tomorrow 7pm (Vote Yes/No)'
      );
    });

    it('creates fixed-slot and opt-in polls with custom title on WhatsApp poll name and pollState', async () => {
      const sock = createMockSock('direct');
      const activePolls = new Map();
      const messageStore = new Map();
      const latestPollIdByChat = new Map();
      const context = { activePolls, recurringPolls: new Map(), messageStore, latestPollIdByChat, persistPolls: () => {} };

      await routeCommand(
        sock,
        '!poll 4 tomorrow 7pm --title="Twilight Doubles"',
        '120363402559062529@g.us',
        'Alice',
        { key: { participant: 'alice@s.whatsapp.net', remoteJid: '120363402559062529@g.us' } },
        context
      );
      assert.equal(sock.sentMessages.length, 1);
      assert.equal(sock.sentMessages[0].msg.poll.name, '🎾 Twilight Doubles');
      const firstId = sock.sentMessages[0].sent.key.id;
      assert.equal(activePolls.get(firstId).title, 'Twilight Doubles');

      await routeCommand(
        sock,
        '!poll opt-in tomorrow 8pm titled "Open Hit"',
        '120363402559062529@g.us',
        'Alice',
        { key: { participant: 'alice@s.whatsapp.net', remoteJid: '120363402559062529@g.us' } },
        context
      );
      assert.equal(sock.sentMessages.length, 2);
      assert.equal(sock.sentMessages[1].msg.poll.name, '🎾 Open Hit');
      assert.deepEqual(sock.sentMessages[1].msg.poll.values, ['Yes', 'No']);
      const secondId = sock.sentMessages[1].sent.key.id;
      assert.equal(activePolls.get(secondId).title, 'Open Hit');

      // Fixed-slot poll with court lookup and booked+available courts keeps court lines below overridden first line
      const origCheck = scvcc.checkCourtAvailability;
      const origBookings = scvcc.getCourtBookings;
      scvcc.checkCourtAvailability = async () => ({
        slots: [{
          courts: [
            { court: 'Court 2', status: 'prebooked', prebookedBy: 'Alice', availableMinutes: 90 },
            { court: 'Court 1', status: 'available', availableMinutes: 90 }
          ]
        }]
      });
      scvcc.getCourtBookings = async () => ({ bookings: [] });
      try {
        await routeCommand(
          sock,
          '!poll 8 tomorrow 7pm --title="Friday Night Ladder" --courts-strategy=lookup',
          '120363402559062529@g.us',
          'Alice',
          { key: { participant: 'alice@s.whatsapp.net', remoteJid: '120363402559062529@g.us' } },
          context
        );
        const courtPollName = sock.sentMessages[2].msg.poll.name;
        assert.match(courtPollName, /^🎾 Friday Night Ladder\n\n/);
        assert.doesNotMatch(courtPollName, /Alice's poll|Tomorrow 7pm|slots \/ 4/);
        assert.match(courtPollName, /Court 2.*Booked/);
        assert.match(courtPollName, /Court 1.*Available/);
      } finally {
        scvcc.checkCourtAvailability = origCheck;
        scvcc.getCourtBookings = origBookings;
      }
    });

    it('propagates custom title across >12-slot split polls and demand-driven spillover parts', async () => {
      const sock = createMockSock('split');
      const activePolls = new Map();
      const messageStore = new Map();
      const latestPollIdByChat = new Map();
      const context = { activePolls, recurringPolls: new Map(), messageStore, latestPollIdByChat, persistPolls: () => {} };

      // 28 spots -> 2 upfront parts (12 + 12), Part 3 (4 spots, 25–28) triggered on fill
      const res = await pollCommands.createMatchPoll(
        sock,
        '120363402559062529@g.us',
        28,
        'Tomorrow 7pm',
        'tomorrow',
        '7pm',
        'Alice',
        'alice@s.whatsapp.net',
        false,
        null,
        false,
        true,
        true, // noMatchups so vote fill doesn't require ratings
        false,
        false,
        false,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        context,
        { title: 'Mega Ladder' }
      );

      assert.equal(res.err, null);
      assert.equal(res.pollIds.length, 2);
      assert.equal(sock.sentMessages[0].msg.poll.name, '🎾 Mega Ladder');
      assert.equal(sock.sentMessages[1].msg.poll.name, '🎾 Mega Ladder');
      assert.equal(activePolls.get(res.pollIds[0]).title, 'Mega Ladder');
      assert.equal(activePolls.get(res.pollIds[1]).title, 'Mega Ladder');

      // Fill Part 1 (12 spots) and Part 2 (12 spots) to trigger spillover Part 3 (Spots 25-28)
      const p1State = activePolls.get(res.pollIds[0]);
      const p2State = activePolls.get(res.pollIds[1]);
      for (let i = 0; i < 12; i++) {
        const jid = `140855501${String(i).padStart(2, '0')}@s.whatsapp.net`;
        p1State.voteBuffer.set(jid, {
          pollUpdateMessageKey: { participant: jid },
          vote: { selectedOptions: [hashOptionName(`Player ${i + 1}`)] },
          senderTimestampMs: 1000 + i
        });
      }
      for (let i = 0; i < 12; i++) {
        const jid = `140855502${String(i).padStart(2, '0')}@s.whatsapp.net`;
        p2State.voteBuffer.set(jid, {
          pollUpdateMessageKey: { participant: jid },
          vote: { selectedOptions: [hashOptionName(`Player ${13 + i}`)] },
          senderTimestampMs: 2000 + i
        });
      }

      p1State.status = 'filled';
      p1State.lastPlayers = Array.from({ length: 12 }, (_, i) => `P${i + 1}`);
      await pollCommands.processPollVoteEvent(
        sock,
        { remoteJid: '120363402559062529@g.us', id: res.pollIds[1], fromMe: true },
        [],
        context
      );

      const spilloverSent = sock.sentMessages.find((m) => m.msg?.poll?.values?.includes('Player 25'));
      assert.ok(spilloverSent, 'Expected spillover Part 3 poll to be sent');
      assert.equal(spilloverSent.msg.poll.name, '🎾 Mega Ladder');
      const p3State = activePolls.get(spilloverSent.sent.key.id);
      assert.equal(p3State.title, 'Mega Ladder');
    });

    it('creates multi-time poll with custom title and includes title in simulation summary', async () => {
      const sock = createMockSock('multi');
      const activePolls = new Map();
      const context = { activePolls, recurringPolls: new Map(), messageStore: new Map(), latestPollIdByChat: new Map(), persistPolls: () => {} };

      const origCheck = scvcc.checkCourtAvailability;
      const origBookings = scvcc.getCourtBookings;
      scvcc.checkCourtAvailability = async () => ({
        slots: [{
          courts: [{ court: 'Court 1', status: 'available', availableMinutes: 90 }]
        }]
      });
      scvcc.getCourtBookings = async () => ({ bookings: [] });

      try {
        const simOut = await routeCommand(
          sock,
          '!simulatepoll 4 tomorrow 7pm --title="Sim Cup" --courts-strategy=lookup',
          '120363402559062529@g.us',
          'Alice',
          { key: { participant: 'alice@s.whatsapp.net', remoteJid: '120363402559062529@g.us' } },
          context
        );
        assert.match(simOut, /🏷️ \*Title:\* Sim Cup/);
        assert.match(sock.sentMessages[0].msg.poll.name, /^🎾 \[Simulation\] Sim Cup\n\n/);
        assert.doesNotMatch(sock.sentMessages[0].msg.poll.name, /Tomorrow 7pm|Alice's poll/);
        assert.equal(activePolls.size, 0);

        await routeCommand(
          sock,
          '!poll Saturday 8am(4), 9:30am(8) --title="Weekend Mixer" --courts-strategy=lookup',
          '120363402559062529@g.us',
          'Alice',
          { key: { participant: 'alice@s.whatsapp.net', remoteJid: '120363402559062529@g.us' } },
          context
        );
        const multiMsg = sock.sentMessages[1].msg.poll;
        assert.match(multiMsg.name, /^🎾 Weekend Mixer\n\n/);
        assert.doesNotMatch(multiMsg.name, /Saturday \(Vote for/);
        assert.match(multiMsg.name, /Court 1/);
        const multiState = activePolls.get(sock.sentMessages[1].sent.key.id);
        assert.equal(multiState.title, 'Weekend Mixer');
      } finally {
        scvcc.checkCourtAvailability = origCheck;
        scvcc.getCourtBookings = origBookings;
      }
    });

    it('stores custom title when scheduling a future one-time !poll ... at <postTime>', async () => {
      const sock = createMockSock('future');
      const recurringPolls = new Map();
      const context = {
        activePolls: new Map(),
        recurringPolls,
        messageStore: new Map(),
        latestPollIdByChat: new Map(),
        persistPolls: () => {},
        customSanJoseParts: { year: 2026, month: 10, day: 20, hour: 6, minute: 0, second: 0 }
      };

      const res = await routeCommand(
        sock,
        '!poll 4 tomorrow 7pm at 10am --title="Scheduled Cup"',
        '120363402559062529@g.us',
        'Alice',
        { key: { participant: 'alice@s.whatsapp.net', remoteJid: '120363402559062529@g.us' } },
        context
      );

      assert.equal(recurringPolls.size, 1);
      const sched = [...recurringPolls.values()][0];
      assert.equal(sched.oneTime, true);
      assert.equal(sched.title, 'Scheduled Cup');
      assert.match(res, /• \*Title:\* Scheduled Cup/);
    });
  });

  describe('Claude tool schemas and executeTool execution', () => {
    it('defines title schema on all 5 poll/schedule tools and forwards title on execution', async () => {
      for (const toolName of ['simulate_poll', 'create_poll', 'schedule_recurring_poll', 'modify_recurring_poll', 'modify_poll_instance']) {
        const tool = CLAUDE_TOOLS.find((t) => t.name === toolName);
        assert.ok(tool, `Expected tool ${toolName}`);
        assert.ok(tool.input_schema.properties.title, `Expected title property on ${toolName}`);
        assert.equal(tool.input_schema.properties.title.type, 'string');
      }

      const sock = createMockSock('tool');
      const activePolls = new Map();
      const recurringPolls = new Map();
      const context = {
        activePolls,
        recurringPolls,
        messageStore: new Map(),
        latestPollIdByChat: new Map(),
        persistPolls: () => {},
        handleModifyPollInstance: (...args) => pollCommands.handleModifyPollInstance(...args)
      };
      const senderMsg = { key: { participant: 'alice@s.whatsapp.net', remoteJid: '120363402559062529@g.us' } };
      const groupId = '120363402559062529@g.us';

      const origCheck = scvcc.checkCourtAvailability;
      const origBookings = scvcc.getCourtBookings;
      scvcc.checkCourtAvailability = async () => ({
        slots: [{
          courts: [{ court: 'Court 1', status: 'available', availableMinutes: 90 }]
        }]
      });
      scvcc.getCourtBookings = async () => ({ bookings: [] });
      try {
        const simRes = await executeTool(sock, groupId, 'Alice', {
          name: 'simulate_poll',
          input: { size: 4, when: 'Tomorrow 7pm', title: 'Tool Sim Cup' }
        }, senderMsg, context);
        assert.match(simRes, /🏷️ \*Title:\* Tool Sim Cup/);

        await executeTool(sock, groupId, 'Alice', {
          name: 'create_poll',
          input: { size: 4, when: 'Tomorrow 7pm', title: 'Tool Created Cup', checkCourts: false }
        }, senderMsg, context);
        const createdId = sock.sentMessages[1].sent.key.id;
        assert.equal(activePolls.get(createdId).title, 'Tool Created Cup');

        const modInstRes = await executeTool(sock, groupId, 'Alice', {
          name: 'modify_poll_instance',
          input: { targetId: createdId, title: 'Tool Modified Cup' }
        }, senderMsg, context);
        assert.match(modInstRes, /• \*Title:\* Tool Modified Cup/);
        const replacedPollMsg = sock.sentMessages.filter((m) => m.msg?.poll).slice(-1)[0];
        assert.equal(activePolls.get(replacedPollMsg.sent.key.id).title, 'Tool Modified Cup');

        const schedRes = await executeTool(sock, groupId, 'Alice', {
          name: 'schedule_recurring_poll',
          input: {
            size: 4,
            matchTime: '7pm',
            postTime: '8am',
            days: 'friday',
            title: 'Tool Recurring Cup',
            checkCourts: false
          }
        }, senderMsg, context);
        assert.match(schedRes, /• \*Title:\* Tool Recurring Cup/);
        const schedId = [...recurringPolls.keys()][0];
        assert.equal(recurringPolls.get(schedId).title, 'Tool Recurring Cup');

        const modSchedRes = await executeTool(sock, groupId, 'Alice', {
          name: 'modify_recurring_poll',
          input: { scheduleId: schedId, title: 'Tool Updated Recurring' }
        }, senderMsg, context);
        assert.match(modSchedRes, /Title: Tool Recurring Cup → \*Tool Updated Recurring\*/);
        assert.equal(recurringPolls.get(schedId).title, 'Tool Updated Recurring');
      } finally {
        scvcc.checkCourtAvailability = origCheck;
        scvcc.getCourtBookings = origBookings;
      }
    });
  });

  describe('Recurring poll schedules, posting, simulation, and sync', () => {
    it('schedules, formats card, posts, simulates, updates, syncs, and clears title on recurring schedules', async () => {
      const sock = createMockSock('rec');
      const recurringPolls = new Map();
      const activePolls = new Map();
      const context = {
        activePolls,
        recurringPolls,
        messageStore: new Map(),
        latestPollIdByChat: new Map(),
        persistPolls: () => {}
      };

      const origCheck = scvcc.checkCourtAvailability;
      const origBookings = scvcc.getCourtBookings;
      scvcc.checkCourtAvailability = async () => ({
        slots: [{
          courts: [{ court: 'Court 1', status: 'available', availableMinutes: 90 }]
        }]
      });
      scvcc.getCourtBookings = async () => ({ bookings: [] });

      try {
        const schedMsg = await recurringPollsModule.scheduleRecurringPoll({
          recurringPolls,
          persistPolls: context.persistPolls,
          targetChatId: '120363402559062529@g.us',
          sender: 'Alice',
          senderJid: 'alice@s.whatsapp.net',
          params: {
            size: 4,
            matchTime: '7pm',
            postTime: '8am',
            days: 'friday',
            title: 'Friday Night Lights',
            checkCourts: false
          }
        });
        assert.match(schedMsg, /• \*Title:\* Friday Night Lights/);
        const schedId = [...recurringPolls.keys()][0];
        const sched = recurringPolls.get(schedId);
        assert.equal(sched.title, 'Friday Night Lights');

        // Simulate recurring poll
        const simMsg = await recurringPollsModule.simulateRecurringPoll({
          sock,
          recurringPolls,
          scheduleId: schedId,
          chatId: '120363402559062529@g.us',
          sender: 'Alice',
          senderJid: 'alice@s.whatsapp.net',
          context,
          createMatchPoll: pollCommands.createMatchPoll
        });
        assert.match(simMsg, /🏷️ \*Title:\* Friday Night Lights/);
        assert.match(sock.sentMessages[0].msg.poll.name, /^🎾 \[Simulation\] Friday Night Lights\n\n/);
        assert.doesNotMatch(sock.sentMessages[0].msg.poll.name, /Today 7pm|Friday 7pm|Alice's poll/);
        assert.match(sock.sentMessages[0].msg.poll.name, /Court 1 - Available/);

        // Scheduled posting on Friday 2026-11-20 at 08:00 AM San Jose time
        await recurringPollsModule.checkAndPostRecurringPolls({
          sock,
          recurringPolls,
          activePolls,
          persistPolls: context.persistPolls,
          createMatchPoll: pollCommands.createMatchPoll,
          context,
          customSanJoseParts: { year: 2026, month: 10, day: 20, hour: 8, minute: 0, dayOfWeek: 5 }
        });
        assert.equal(activePolls.size, 1);
        const [postedPollId, postedState] = [...activePolls.entries()][0];
        assert.equal(postedState.title, 'Friday Night Lights');
        assert.equal(postedState.name, '🎾 Friday Night Lights');

        // Modify schedule title and verify sync to active poll instance
        const modMsg = await recurringPollsModule.modifyRecurringPoll({
          recurringPolls,
          persistPolls: context.persistPolls,
          activePolls,
          sender: 'Alice',
          scheduleId: schedId,
          updates: { title: 'Friday Championship' }
        });
        assert.match(modMsg, /Title: Friday Night Lights → \*Friday Championship\*/);
        assert.match(modMsg, /• \*Title:\* Friday Championship/);
        assert.equal(sched.title, 'Friday Championship');
        assert.equal(activePolls.get(postedPollId).title, 'Friday Championship');

        // Clear schedule title and verify sync clears active poll instance title
        const clearMsg = await recurringPollsModule.modifyRecurringPoll({
          recurringPolls,
          persistPolls: context.persistPolls,
          activePolls,
          sender: 'Alice',
          scheduleId: schedId,
          updates: { title: null }
        });
        assert.match(clearMsg, /Title: Friday Championship → \*None \(cleared\)\*/);
        assert.equal(sched.title, null);
        assert.equal(activePolls.get(postedPollId).title, null);
      } finally {
        scvcc.checkCourtAvailability = origCheck;
        scvcc.getCourtBookings = origBookings;
      }
    });
  });

  describe('Instance modification for bot and manual polls', () => {
    it('updates and clears title on a multi-time bot poll while preserving timeSlots and multiVote', async () => {
      const sock = createMockSock('modbot');
      const activePolls = new Map();
      const context = { activePolls, recurringPolls: new Map(), messageStore: new Map(), latestPollIdByChat: new Map(), persistPolls: () => {} };

      await pollCommands.createMatchPoll(
        sock,
        '120363402559062529@g.us',
        null,
        'Saturday 8am(4), 9:30am(8)',
        'Saturday',
        null,
        'Alice',
        'alice@s.whatsapp.net',
        false,
        null,
        false,
        true,
        false,
        false,
        false,
        false,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        context,
        { title: 'Initial Multi Cup', multiVote: false, multiSessionMode: 'single_session' }
      );
      const oldPollId = sock.sentMessages.filter((m) => m.msg?.poll).slice(-1)[0].sent.key.id;

      // Update title by matching poll title name via !modifyinstance
      const updateReply = await pollCommands.handleModifyPollInstance(
        sock,
        '120363402559062529@g.us',
        'Alice',
        'alice@s.whatsapp.net',
        'Initial Multi Cup',
        { title: 'Renamed Multi Cup' },
        context
      );
      assert.match(updateReply, /• \*Title:\* Renamed Multi Cup/);
      const newPollId = sock.sentMessages.filter((m) => m.msg?.poll).slice(-1)[0].sent.key.id;
      const newState = activePolls.get(newPollId);
      assert.ok(newState);
      assert.equal(newState.title, 'Renamed Multi Cup');
      assert.equal(newState.type, 'multi_time');
      assert.equal(newState.multiVote, false);
      assert.equal(newState.timeSlots.length, 2);
      assert.equal(newState.name, '🎾 Renamed Multi Cup');
      assert.equal(activePolls.has(oldPollId), false);

      // Clear title
      const clearReply = await pollCommands.handleModifyPollInstance(
        sock,
        '120363402559062529@g.us',
        'Alice',
        'alice@s.whatsapp.net',
        newPollId,
        { title: null },
        context
      );
      assert.match(clearReply, /• \*Title:\* None \(cleared\)/);
      const thirdPollId = sock.sentMessages.filter((m) => m.msg?.poll).slice(-1)[0].sent.key.id;
      assert.equal(activePolls.get(thirdPollId).title, null);
      assert.doesNotMatch(activePolls.get(thirdPollId).name, /Renamed Multi Cup/);
      assert.match(activePolls.get(thirdPollId).name, /^🎾 Saturday \(Vote for 1 time\)$/);
    });

    it('updates and clears title in-place on a manual tracked poll without reposting', async () => {
      const sock = createMockSock('manual');
      const activePolls = new Map();
      activePolls.set('manual_poll_1', {
        remoteJid: '120363402559062529@g.us',
        name: 'Tennis tomorrow 6pm?',
        when: 'Tomorrow 6pm',
        options: ['Yes', 'No'],
        status: 'active',
        isManual: true,
        creator: { name: 'Alice', jid: 'alice@s.whatsapp.net' }
      });
      const context = { activePolls, recurringPolls: new Map(), messageStore: new Map(), latestPollIdByChat: new Map(), persistPolls: () => {} };

      const setRes = await pollCommands.handleModifyPollInstance(
        sock,
        '120363402559062529@g.us',
        'Alice',
        'alice@s.whatsapp.net',
        'manual_poll_1',
        { title: 'Manual Club Hit' },
        context
      );
      assert.match(setRes, /Title: \*Manual Club Hit\*/);
      assert.match(setRes, /WhatsApp poll message was kept intact/);
      assert.equal(activePolls.get('manual_poll_1').title, 'Manual Club Hit');
      assert.equal(sock.sentMessages.length, 0);

      const clearRes = await pollCommands.handleModifyPollInstance(
        sock,
        '120363402559062529@g.us',
        'Alice',
        'alice@s.whatsapp.net',
        'Manual Club Hit',
        { title: null },
        context
      );
      assert.match(clearRes, /Title: \*None \(cleared\)\*/);
      assert.equal(activePolls.get('manual_poll_1').title, undefined);
      assert.equal(sock.sentMessages.length, 0);
    });
  });

  describe('Status lookups, reminders, headers, and matchup generation', () => {
    it('finds polls by title in findSpecificPoll and displays titles in pollStatusText', () => {
      const activePolls = new Map();
      const recurringPolls = new Map();
      recurringPolls.set('rec_1', {
        id: 'rec_1',
        remoteJid: '120363402559062529@g.us',
        daysDisplay: 'Fri',
        matchDisplay: '7 PM',
        postDisplay: '8 AM',
        title: 'Friday Mixer',
        enabled: true
      });
      recurringPolls.set('rec_2', {
        id: 'rec_2',
        remoteJid: '120363402559062529@g.us',
        daysDisplay: 'Sun',
        matchDisplay: '9 AM',
        postDisplay: '8 AM',
        title: 'Sunday Social',
        enabled: true
      });
      activePolls.set('poll_t1', {
        remoteJid: '120363402559062529@g.us',
        name: '🎾 Twilight Cup — Tomorrow 7pm (4 slots / 4)',
        title: 'Twilight Cup',
        when: 'Tomorrow 7pm',
        options: ['Player 1', 'Player 2', 'Player 3', 'Player 4'],
        status: 'active',
        voteBuffer: new Map()
      });
      activePolls.set('poll_rec_inst', {
        remoteJid: '120363402559062529@g.us',
        scheduleId: 'rec_1',
        name: '🎾 Friday Mixer',
        title: 'Friday Mixer Special',
        when: 'Fri 7pm',
        size: 4,
        options: ['Player 1', 'Player 2', 'Player 3', 'Player 4'],
        status: 'active',
        voteBuffer: new Map()
      });

      const found = pollCommands.findSpecificPoll('Twilight Cup', activePolls, recurringPolls);
      assert.ok(found);
      assert.equal(found.pollId, 'poll_t1');

      const statusAll = pollCommands.pollStatusText('120363402559062529@g.us', {}, {
        activePolls,
        recurringPolls,
        messageStore: new Map()
      });
      assert.match(statusAll, /Title: Twilight Cup/);
      assert.match(statusAll, /`rec_1` \[Friday Mixer\]/);
      assert.match(statusAll, /Poll `poll_rec_inst` "Friday Mixer Special" \(Fri 7pm\) — Status: active/);

      const statusActive = pollCommands.pollStatusText('120363402559062529@g.us', { activeOnly: true }, {
        activePolls,
        recurringPolls,
        messageStore: new Map()
      });
      assert.match(statusActive, /Title: Twilight Cup/);
      assert.match(statusActive, /Title: Friday Mixer Special/);

      const statusSched = pollCommands.pollStatusText('120363402559062529@g.us', { targetId: 'rec_1' }, {
        activePolls,
        recurringPolls,
        messageStore: new Map()
      });
      assert.match(statusSched, /Title: Friday Mixer Special/);

      const statusSchedNoInst = pollCommands.pollStatusText('120363402559062529@g.us', { targetId: 'rec_2' }, {
        activePolls,
        recurringPolls,
        messageStore: new Map()
      });
      assert.match(statusSchedNoInst, /Recurring schedule `rec_2` "Sunday Social"/);
    });

    it('includes custom title in formatMatchHeaderTime, getCleanLogicalPollName, reminders, and multi-time matchup headers', async () => {
      const activePolls = new Map();
      const pollState = {
        remoteJid: '120363402559062529@g.us',
        title: 'Autumn Classic',
        name: '🎾 Autumn Classic — Tomorrow 7pm (Part 1/2: Spots 1–12)',
        when: 'Tomorrow 7pm',
        parentPollId: 'parent_1',
        partNumber: 1,
        totalParts: 2,
        options: Array.from({ length: 12 }, (_, i) => `Player ${i + 1}`),
        size: 16,
        status: 'active',
        voteBuffer: new Map()
      };
      activePolls.set('p_part1', pollState);
      activePolls.set('p_part2', {
        ...pollState,
        name: '🎾 Autumn Classic — Tomorrow 7pm (Part 2/2: Spots 13–16)',
        partNumber: 2,
        options: ['Player 13', 'Player 14', 'Player 15', 'Player 16'],
        size: 4,
        voteBuffer: new Map()
      });

      assert.equal(pollCommands.formatMatchHeaderTime(pollState), 'Autumn Classic — Tomorrow 7pm');
      assert.equal(getCleanLogicalPollName(pollState), 'Autumn Classic — Tomorrow 7pm');

      const reminderText = pollCommands.buildPollReminderText(4, pollState, 6, 16, 'Alice, Bob', false, 0);
      assert.match(reminderText, /Autumn Classic — Tomorrow 7pm/);
      assert.match(reminderText, /6 spots left/);

      const untimedText = pollCommands.buildUntimedPollReminderText({
        remoteJid: '120363402559062529@g.us',
        isManual: true,
        title: 'Sunday Ladder',
        when: 'Sunday'
      }, 2, 4, 'Alice, Bob', false, 0);
      assert.match(untimedText, /\(\*Sunday Ladder\*\)/);

      // Multi-time matchup generation header
      const sock = createMockSock('matchup');
      const mtId = 'mt_poll_1';
      const mtState = {
        remoteJid: '120363402559062529@g.us',
        type: 'multi_time',
        title: 'Saturday Showdown',
        when: 'Saturday 8am, 9:30am',
        status: 'active',
        voteBuffer: new Map(),
        timeSlots: [
          {
            label: '8 AM',
            optionLabel: '8 AM (4 spots)',
            dayDisplay: 'Saturday',
            timeDisplay: '8 AM',
            timeWord: '8am',
            slotLimit: 4,
            preseededPlayers: ['Player Alpha', 'Player Beta', 'Player Gamma', 'Player Delta'],
            playAt: new Date(Date.now() + 86400000).toISOString(),
            status: 'active'
          }
        ]
      };
      activePolls.set(mtId, mtState);

      const origEnsureRated = ratings.ensureRated;
      ratings.ensureRated = async () => {};
      try {
        await pollCommands.generateMatchupsFromPoll(
          sock,
          '120363402559062529@g.us',
          mtId,
          null,
          {},
          {
            activePolls,
            latestPollIdByChat: new Map([[ '120363402559062529@g.us', mtId ]]),
            persistPolls: () => {},
            messageStore: new Map()
          }
        );
        const sentText = sock.sentMessages.find((m) => m.msg?.text?.includes('Saturday Showdown'))?.msg?.text;
        assert.ok(sentText, 'Expected multi-time matchup message to include custom title');
        assert.match(sentText, /^📅 Saturday Showdown — Saturday 8 AM/);
      } finally {
        ratings.ensureRated = origEnsureRated;
      }
    });
  });
});
