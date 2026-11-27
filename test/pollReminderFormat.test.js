const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const {
  buildPollReminder,
  buildPollReminderText,
  sendPollReminder,
  handlePollCommand,
  executePollTool,
  parseTriggerReminderArgs
} = require('../lib/commands/poll');

const namesStore = require('../lib/names');

function hashOpt(name) {
  return crypto.createHash('sha256').update(name).digest();
}

describe('Poll Reminder Format & @Mentions', () => {
  const TWELVE_PLAYERS = ['Alice', 'Ben', 'Chris', 'Dan', 'Eli', 'Frank', 'Gabe', 'Hank', 'Ivan', 'Jay', 'Ken', 'Leo'];

  describe('Doubles 12-spot scenarios (Option A, separate lines, no rotation)', () => {
    const basePoll = { when: 'Tomorrow 7pm', name: 'Tennis 7pm', remoteJid: '120363000000000000@g.us' };

    it('formats 5/12 with 3 booked courts at 8h (Need 3 players, ⏳, @1 bubble)', () => {
      const players = TWELVE_PLAYERS.slice(0, 5);
      const res = buildPollReminder(8, basePoll, 7, 12, players.join(', '), false, 0, 8, { bookedCourtsCount: 3 });
      assert.equal(
        res.text,
        '🔥 *8 Hours to Match Time!* — Tomorrow 7pm *(3 courts booked)*\n\n' +
        '✅ *Confirmed (4):*\nAlice, Ben, Chris, Dan\n\n' +
        '⏳ *Need 3 players for a 2nd foursome (1/4):*\nEli\n\n' +
        '@Eli — you\'re #5 right now, so we need 3 more players to form a 2nd court. Ask around or vote above if anyone else can join!'
      );
      assert.doesNotMatch(res.text, /Court 1|Court 2|rotat/i);
    });

    it('formats 6/12 with 3 booked courts at 8h (Need 2 players, ⚠️, @2 bubble)', () => {
      const players = TWELVE_PLAYERS.slice(0, 6);
      const res = buildPollReminder(8, basePoll, 6, 12, players.join(', '), false, 0, 8, { bookedCourtsCount: 3 });
      assert.equal(
        res.text,
        '🔥 *8 Hours to Match Time!* — Tomorrow 7pm *(3 courts booked)*\n\n' +
        '✅ *Confirmed (4):*\nAlice, Ben, Chris, Dan\n\n' +
        '⚠️ *Need 2 players for a 2nd foursome (2/4):*\nEli, Frank\n\n' +
        '2 more players lock in a 2nd court! @Eli @Frank — can either of you help find 2 more? (4 spots still open after that for a 3rd court.)'
      );
    });

    it('formats 7/12 with 3 booked courts at 8h (Need 1 player, ⚠️, @3 bubble)', () => {
      const players = TWELVE_PLAYERS.slice(0, 7);
      const res = buildPollReminder(8, basePoll, 5, 12, players.join(', '), false, 0, 8, { bookedCourtsCount: 3 });
      assert.equal(
        res.text,
        '🔥 *8 Hours to Match Time!* — Tomorrow 7pm *(3 courts booked)*\n\n' +
        '✅ *Confirmed (4):*\nAlice, Ben, Chris, Dan\n\n' +
        '⚠️ *Need 1 player for a 2nd foursome (3/4):*\nEli, Frank, Gabe\n\n' +
        'One more player locks in a 2nd court! @Eli @Frank @Gabe — can any of you find 1 more? (4 spots still open after that for a 3rd court.)'
      );
    });

    it('formats 8/12 with 3 booked courts at 8h (valid count -> calm header 🎾, Need 4 players ⏳, no mentions)', () => {
      const players = TWELVE_PLAYERS.slice(0, 8);
      const res = buildPollReminder(8, basePoll, 4, 12, players.join(', '), false, 0, 8, { bookedCourtsCount: 3 });
      assert.equal(
        res.text,
        '🎾 *8 Hours to Match Time!* — Tomorrow 7pm *(3 courts booked)*\n\n' +
        '✅ *Confirmed (8):*\nAlice, Ben, Chris, Dan, Eli, Frank, Gabe, Hank\n\n' +
        '⏳ *Need 4 players for the 3rd foursome (0/4):*\nOpen — vote in the poll above to start the 3rd court!'
      );
      assert.deepEqual(res.mentions, []);
    });

    it('formats 10/12 with 3 booked courts at 8h (Confirmed 8, Need 2 players ⚠️, @2 bubble)', () => {
      const players = TWELVE_PLAYERS.slice(0, 10);
      const res = buildPollReminder(8, basePoll, 2, 12, players.join(', '), false, 0, 8, { bookedCourtsCount: 3 });
      assert.equal(
        res.text,
        '🔥 *8 Hours to Match Time!* — Tomorrow 7pm *(3 courts booked)*\n\n' +
        '✅ *Confirmed (8):*\nAlice, Ben, Chris, Dan, Eli, Frank, Gabe, Hank\n\n' +
        '⚠️ *Need 2 players for the 3rd foursome (2/4):*\nIvan, Jay\n\n' +
        '2 more players lock in the 3rd court! @Ivan @Jay — can either of you help find 2 more?'
      );
    });

    it('formats 11/12 with 3 booked courts at 8h (Confirmed 8, Need 1 player ⚠️, @3 bubble)', () => {
      const players = TWELVE_PLAYERS.slice(0, 11);
      const res = buildPollReminder(8, basePoll, 1, 12, players.join(', '), false, 0, 8, { bookedCourtsCount: 3 });
      assert.equal(
        res.text,
        '🔥 *8 Hours to Match Time!* — Tomorrow 7pm *(3 courts booked)*\n\n' +
        '✅ *Confirmed (8):*\nAlice, Ben, Chris, Dan, Eli, Frank, Gabe, Hank\n\n' +
        '⚠️ *Need 1 player for the 3rd foursome (3/4):*\nIvan, Jay, Ken\n\n' +
        'One more player locks in the 3rd court! @Ivan @Jay @Ken — can any of you find 1 more?'
      );
    });
  });

  describe('Small polls, empty polls, full polls, and singles', () => {
    const basePoll = { when: 'Tomorrow 9am', name: 'Tennis 9am', remoteJid: '120363000000000000@g.us' };

    it('formats 0/4 open poll without Confirmed section and uses ⏳', () => {
      const res = buildPollReminder(8, basePoll, 4, 4, 'None yet', false, 0, 8, { bookedCourtsCount: 1 });
      assert.equal(
        res.text,
        '🎾 *8 Hours to Match Time!* — Tomorrow 9am *(1 court booked)*\n\n' +
        '⏳ *Need 4 players for the foursome (0/4):*\nOpen — vote in the poll above to get a court going!'
      );
    });

    it('formats 1/4, 2/4, 3/4 with separate lines and appropriate ⏳/⚠️ icon', () => {
      const p1 = buildPollReminderText(8, basePoll, 3, 4, 'Alice', false, 0, 8);
      assert.match(p1, /^🔥 \*8 Hours to Match Time!\*/);
      assert.doesNotMatch(p1, /Confirmed/);
      assert.match(p1, /⏳ \*Need 3 players for the foursome \(1\/4\):\*\nAlice/);
      assert.match(p1, /@Alice — you're #1 right now/);

      const p2 = buildPollReminderText(8, basePoll, 2, 4, 'Alice, Ben', false, 0, 8);
      assert.match(p2, /⚠️ \*Need 2 players for the foursome \(2\/4\):\*\nAlice, Ben/);
      assert.match(p2, /@Alice @Ben/);

      const p3 = buildPollReminderText(8, basePoll, 1, 4, 'Alice, Ben, Chris', false, 0, 8);
      assert.match(p3, /⚠️ \*Need 1 player for the foursome \(3\/4\):\*\nAlice, Ben, Chris/);
      assert.match(p3, /@Alice @Ben @Chris/);
    });

    it('formats full 12/12 (forced) with no Need line and no CTA', () => {
      const res = buildPollReminder(8, basePoll, 0, 12, TWELVE_PLAYERS.join(', '), false, 0, 8, { bookedCourtsCount: 3 });
      assert.equal(
        res.text,
        '🎾 *8 Hours to Match Time!* — Tomorrow 9am *(3 courts booked)*\n\n' +
        '✅ *Confirmed (12):*\nAlice, Ben, Chris, Dan, Eli, Frank, Gabe, Hank, Ivan, Jay, Ken, Leo'
      );
      assert.deepEqual(res.mentions, []);
    });

    it('handles singles (totalSpots === 2) for 0/2, 1/2, and 2/2', () => {
      const s0 = buildPollReminderText(8, basePoll, 2, 2, 'None yet', false, 0, 8);
      assert.match(s0, /^🎾 \*8 Hours to Match Time!\*/);
      assert.match(s0, /⏳ \*Need 2 players \(0\/2\):\*/);

      const s1 = buildPollReminderText(8, basePoll, 1, 2, 'Alice', false, 0, 8);
      assert.match(s1, /^🔥 \*8 Hours to Match Time!\*/);
      assert.match(s1, /⚠️ \*Need 1 player \(1\/2\):\*\nAlice/);
      assert.match(s1, /@Alice — can you find 1 more\?/);

      const s2 = buildPollReminderText(8, basePoll, 0, 2, 'Alice, Ben', false, 0, 8);
      assert.match(s2, /^🎾 \*8 Hours to Match Time!\*/);
      assert.match(s2, /✅ \*Confirmed \(2\):\*\nAlice, Ben/);
      assert.doesNotMatch(s2, /Need/);
    });
  });

  describe('Urgency icons & @mentions across time thresholds', () => {
    const basePoll = { when: 'Tomorrow 7pm', name: 'Tennis 7pm', remoteJid: '120363000000000000@g.us' };
    const sevenNames = TWELVE_PLAYERS.slice(0, 7).join(', ');

    it('uses calm icons and no @mentions for hoursRemaining > 16 (32h, 24h, 16.5h)', () => {
      const t32 = buildPollReminderText(32, basePoll, 5, 12, sevenNames, false, 0, 32);
      assert.match(t32, /^🎾 \*Match Alert:\*/);
      assert.match(t32, /⏳ \*Need 1 player for a 2nd foursome \(3\/4\):\*\nEli, Frank, Gabe/);
      assert.doesNotMatch(t32, /@/);

      const t24 = buildPollReminderText(24, basePoll, 5, 12, sevenNames, false, 0, 24);
      assert.match(t24, /^⏰ \*24 Hours \(1 Day\) to Playtime!\*/);
      assert.match(t24, /⏳ \*Need 1 player for a 2nd foursome \(3\/4\):\*\nEli, Frank, Gabe/);
      assert.match(t24, /5 spots still open — vote in the poll above to join!/);
      assert.doesNotMatch(t24, /@/);
    });

    it('uses 🔥 + ⚠️ + @mentions at 16h when incomplete, but ⏰ and no @mentions when complete', () => {
      const inc16 = buildPollReminderText(16, basePoll, 5, 12, sevenNames, false, 0, 16);
      assert.match(inc16, /^🔥 \*16 Hours to Playtime!\*/);
      assert.match(inc16, /⚠️ \*Need 1 player for a 2nd foursome \(3\/4\):\*\nEli, Frank, Gabe/);
      assert.match(inc16, /@Eli @Frank @Gabe/);

      const ok16 = buildPollReminderText(16, basePoll, 4, 12, TWELVE_PLAYERS.slice(0, 8).join(', '), false, 0, 16);
      assert.match(ok16, /^⏰ \*16 Hours to Playtime!\*/);
      assert.match(ok16, /⏳ \*Need 4 players for the 3rd foursome \(0\/4\):\*/);
      assert.doesNotMatch(ok16, /@/);
    });

    it('progresses through 🔥 (4h), ⚡ (2h), 🚨 (1h), ⚡ (<1h)', () => {
      const t4 = buildPollReminderText(4, basePoll, 5, 12, sevenNames, false, 0, 4);
      assert.match(t4, /^🔥 \*4 Hours Until Court Time!\*/);
      assert.match(t4, /⚠️ \*Need 1 player for a 2nd foursome \(3\/4\):\*\nEli, Frank, Gabe/);
      assert.match(t4, /@Eli @Frank @Gabe/);

      const t2 = buildPollReminderText(2, basePoll, 5, 12, sevenNames, false, 0, 2);
      assert.match(t2, /^⚡ \*2 HOURS TO GO!\*/);
      assert.match(t2, /⚠️ \*Need 1 player for a 2nd foursome \(3\/4\):\*\nEli, Frank, Gabe/);
      assert.match(t2, /Still 1 short for a 2nd court! @Eli @Frank @Gabe/);

      const t1 = buildPollReminderText(1, basePoll, 5, 12, sevenNames, false, 0, 1);
      assert.match(t1, /^🚨 \*FINAL CALL: 1 HOUR LEFT!\*/);
      assert.match(t1, /⚠️ \*Need 1 player for a 2nd foursome \(3\/4\):\*\nEli, Frank, Gabe/);
      assert.match(t1, /Just 1 player needed to lock in a 2nd court! @Eli @Frank @Gabe/);

      const t30m = buildPollReminderText(1, basePoll, 5, 12, sevenNames, false, 0, 0.5);
      assert.match(t30m, /^⚡ \*30 MINUTES TO GO!\*/);
      assert.match(t30m, /⚠️ \*Need 1 player for a 2nd foursome \(3\/4\):\*\nEli, Frank, Gabe/);
      assert.match(t30m, /Last chance to fill a 2nd court! @Eli @Frank @Gabe/);
    });
  });

  describe('sendPollReminder chronological bubble selection & JID @mentions', () => {
    it('selects N % 4 most recently voted players chronologically regardless of slot number and attaches WhatsApp mentions', async () => {
      const chatId = '120363999888777666@g.us';
      const pollId = 'poll_chrono_12';
      const options = Array.from({ length: 11 }, (_, i) => `Player ${i + 2}`);

      // Register temporary mock users in namesStore
      const testUsers = [
        { lid: '90010000001@lid', pn: '14080000001@s.whatsapp.net', name: 'TestAlice' },
        { lid: '90010000002@lid', pn: '14080000002@s.whatsapp.net', name: 'TestBen' },
        { lid: '90010000003@lid', pn: '14080000003@s.whatsapp.net', name: 'TestChris' },
        { lid: '90010000004@lid', pn: '14080000004@s.whatsapp.net', name: 'TestGabe' },
        { lid: '90010000005@lid', pn: '14080000005@s.whatsapp.net', name: 'TestDan' },
        { lid: '90010000006@lid', pn: '14080000006@s.whatsapp.net', name: 'TestEli' },
        { lid: '90010000007@lid', pn: '14080000007@s.whatsapp.net', name: 'TestFrank' }
      ];
      const store = namesStore.load();
      for (const u of testUsers) {
        store[u.lid] = { name: u.name, fullName: u.name, pn: u.pn, aliases: [] };
      }

      try {
        const pollCreationMessage = {
          pollCreationMessage: {
            name: '🎾 Tomorrow 7pm (12 spots)',
            options: options.map((optionName) => ({ optionName })),
            selectableOptionsCount: 1
          }
        };

        const messageStore = new Map([[`${chatId}:${pollId}`, pollCreationMessage]]);

        // Votes arrive chronologically:
        // TestAlice is creator (leading slot 1, non-voter)
        // TestBen votes Player 2 at ts=1000
        // TestChris votes Player 3 at ts=2000
        // TestGabe votes Player 9 at ts=3000 (out-of-slot-order early vote -> CONFIRMED!)
        // TestDan votes Player 4 at ts=4000 (late vote -> BUBBLE!)
        // TestEli votes Player 5 at ts=5000 (late vote -> BUBBLE!)
        // TestFrank votes Player 6 at ts=6000 (late vote -> BUBBLE!)
        const voteBuffer = new Map([
          ['90010000002@lid', { pollUpdateMessageKey: { remoteJid: chatId, participant: '90010000002@lid' }, senderTimestampMs: 1000, vote: { selectedOptions: [hashOpt('Player 2')] } }],
          ['90010000003@lid', { pollUpdateMessageKey: { remoteJid: chatId, participant: '90010000003@lid' }, senderTimestampMs: 2000, vote: { selectedOptions: [hashOpt('Player 3')] } }],
          ['90010000004@lid', { pollUpdateMessageKey: { remoteJid: chatId, participant: '90010000004@lid' }, senderTimestampMs: 3000, vote: { selectedOptions: [hashOpt('Player 9')] } }],
          ['90010000005@lid', { pollUpdateMessageKey: { remoteJid: chatId, participant: '90010000005@lid' }, senderTimestampMs: 4000, vote: { selectedOptions: [hashOpt('Player 4')] } }],
          ['90010000006@lid', { pollUpdateMessageKey: { remoteJid: chatId, participant: '90010000006@lid' }, senderTimestampMs: 5000, vote: { selectedOptions: [hashOpt('Player 5')] } }],
          ['90010000007@lid', { pollUpdateMessageKey: { remoteJid: chatId, participant: '90010000007@lid' }, senderTimestampMs: 6000, vote: { selectedOptions: [hashOpt('Player 6')] } }]
        ]);

        const now = Date.now();
        const pollState = {
          remoteJid: chatId,
          name: '🎾 Tomorrow 7pm (12 spots)',
          when: 'Tomorrow 7pm',
          options,
          size: 12,
          playAt: new Date(now + 8 * 3600 * 1000).toISOString(),
          status: 'active',
          isManual: false,
          creator: { name: 'TestAlice', jid: '90010000001@lid' },
          prebookedCourts: ['Court 1', 'Court 2', 'Court 3'],
          voteBuffer
        };

        let sentMsg = null;
        const mockSock = {
          sendMessage: async (_jid, content) => {
            sentMsg = content;
            return { key: { id: 'rem_chrono_1' } };
          }
        };

        const ok = await sendPollReminder(
          mockSock,
          pollId,
          pollState,
          false,
          { activePolls: new Map([[pollId, pollState]]), messageStore, persistPolls: () => {} },
          now
        );

        assert.equal(ok, true);
        assert.ok(sentMsg);
        assert.match(sentMsg.text, /🔥 \*8 Hours to Match Time!\* — Tomorrow 7pm \*\(3 courts booked\)\*/);
        assert.match(sentMsg.text, /✅ \*Confirmed \(4\):\*\nTestAlice, TestBen, TestChris, TestGabe/);
        assert.match(sentMsg.text, /⚠️ \*Need 1 player for a 2nd foursome \(3\/4\):\*\nTestDan, TestEli, TestFrank/);
        assert.match(sentMsg.text, /@14080000005 @14080000006 @14080000007/);

        assert.ok(Array.isArray(sentMsg.mentions));
        assert.ok(sentMsg.mentions.includes('14080000005@s.whatsapp.net'));
        assert.ok(sentMsg.mentions.includes('14080000006@s.whatsapp.net'));
        assert.ok(sentMsg.mentions.includes('14080000007@s.whatsapp.net'));
        assert.equal(sentMsg.mentions.includes('14080000002@s.whatsapp.net'), false);
        assert.equal(sentMsg.mentions.includes('14080000003@s.whatsapp.net'), false);
        assert.equal(sentMsg.mentions.includes('14080000004@s.whatsapp.net'), false);
      } finally {
        for (const u of testUsers) {
          delete store[u.lid];
        }
      }
    });

    it('suppresses @mentions for hoursRemaining > 16 in sendPollReminder', async () => {
      const chatId = '120363999888777667@g.us';
      const pollId = 'poll_chrono_24h';
      const options = ['Yes', 'No'];

      const testUsers = [
        { lid: '90020000001@lid', pn: '14081110001@s.whatsapp.net', name: 'TestEarly1' },
        { lid: '90020000002@lid', pn: '14081110002@s.whatsapp.net', name: 'TestEarly2' }
      ];
      const store = namesStore.load();
      for (const u of testUsers) {
        store[u.lid] = { name: u.name, fullName: u.name, pn: u.pn, aliases: [] };
      }

      try {
        const pollCreationMessage = {
          pollCreationMessage: {
            name: '🎾 Tomorrow 7pm (Vote Yes/No)',
            options: options.map((optionName) => ({ optionName })),
            selectableOptionsCount: 1
          }
        };
        const messageStore = new Map([[`${chatId}:${pollId}`, pollCreationMessage]]);
        const voteBuffer = new Map([
          ['90020000001@lid', { pollUpdateMessageKey: { remoteJid: chatId, participant: '90020000001@lid' }, senderTimestampMs: 1000, vote: { selectedOptions: [hashOpt('Yes')] } }],
          ['90020000002@lid', { pollUpdateMessageKey: { remoteJid: chatId, participant: '90020000002@lid' }, senderTimestampMs: 2000, vote: { selectedOptions: [hashOpt('Yes')] } }]
        ]);

        const now = Date.now();
        const pollState = {
          remoteJid: chatId,
          name: '🎾 Tomorrow 7pm (Vote Yes/No)',
          when: 'Tomorrow 7pm',
          type: 'opt_in',
          size: null,
          options,
          playAt: new Date(now + 24 * 3600 * 1000).toISOString(),
          status: 'active',
          voteBuffer
        };

        let sentMsg = null;
        const mockSock = {
          sendMessage: async (_jid, content) => {
            sentMsg = content;
            return { key: { id: 'rem_24h' } };
          }
        };

        await sendPollReminder(
          mockSock,
          pollId,
          pollState,
          false,
          { activePolls: new Map([[pollId, pollState]]), messageStore, persistPolls: () => {} },
          now
        );

        assert.ok(sentMsg);
        assert.match(sentMsg.text, /^⏰ \*24 Hours \(1 Day\) to Playtime!\*/);
        assert.match(sentMsg.text, /⏳ \*Need 2 players for a 1st foursome \(2\/4\):\*\nTestEarly1, TestEarly2/);
        assert.equal(sentMsg.mentions, undefined);
      } finally {
        for (const u of testUsers) {
          delete store[u.lid];
        }
      }
    });

    it('handles multi-part split sessions chronologically with booked court count', async () => {
      const chatId = '120363999888777668@g.us';
      const parentPollId = 'parent_split_1';
      const part1Id = 'part1_poll';
      const part2Id = 'part2_poll';

      const testUsers = [
        { lid: '90030000001@lid', pn: '14082220001@s.whatsapp.net', name: 'SplitAlice' },
        { lid: '90030000002@lid', pn: '14082220002@s.whatsapp.net', name: 'SplitBen' },
        { lid: '90030000003@lid', pn: '14082220003@s.whatsapp.net', name: 'SplitChris' },
        { lid: '90030000004@lid', pn: '14082220004@s.whatsapp.net', name: 'SplitDan' },
        { lid: '90030000005@lid', pn: '14082220005@s.whatsapp.net', name: 'SplitEli' }
      ];
      const store = namesStore.load();
      for (const u of testUsers) {
        store[u.lid] = { name: u.name, fullName: u.name, pn: u.pn, aliases: [] };
      }

      try {
        const p1Opts = ['Player 2', 'Player 3', 'Player 4'];
        const p2Opts = ['Player 5', 'Player 6', 'Player 7', 'Player 8'];
        const messageStore = new Map([
          [`${chatId}:${part1Id}`, { pollCreationMessage: { name: 'P1', options: p1Opts.map((optionName) => ({ optionName })), selectableOptionsCount: 1 } }],
          [`${chatId}:${part2Id}`, { pollCreationMessage: { name: 'P2', options: p2Opts.map((optionName) => ({ optionName })), selectableOptionsCount: 1 } }]
        ]);

        const now = Date.now();
        const playAt = new Date(now + 12 * 3600 * 1000).toISOString();
        const part1State = {
          remoteJid: chatId,
          parentPollId,
          partNumber: 1,
          totalParts: 2,
          sessionTotalSize: 8,
          when: 'Tomorrow 7pm',
          name: 'Tomorrow 7pm (Part 1/2)',
          options: p1Opts,
          playAt,
          status: 'active',
          creator: { name: 'SplitAlice', jid: '90030000001@lid' },
          prebookedCourts: ['Court 1', 'Court 2'],
          voteBuffer: new Map([
            ['90030000002@lid', { pollUpdateMessageKey: { remoteJid: chatId, participant: '90030000002@lid' }, senderTimestampMs: 1000, vote: { selectedOptions: [hashOpt('Player 2')] } }],
            ['90030000003@lid', { pollUpdateMessageKey: { remoteJid: chatId, participant: '90030000003@lid' }, senderTimestampMs: 2000, vote: { selectedOptions: [hashOpt('Player 3')] } }],
            ['90030000004@lid', { pollUpdateMessageKey: { remoteJid: chatId, participant: '90030000004@lid' }, senderTimestampMs: 3000, vote: { selectedOptions: [hashOpt('Player 4')] } }]
          ])
        };
        const part2State = {
          remoteJid: chatId,
          parentPollId,
          partNumber: 2,
          totalParts: 2,
          sessionTotalSize: 8,
          when: 'Tomorrow 7pm',
          name: 'Tomorrow 7pm (Part 2/2)',
          options: p2Opts,
          playAt,
          status: 'active',
          voteBuffer: new Map([
            ['90030000005@lid', { pollUpdateMessageKey: { remoteJid: chatId, participant: '90030000005@lid' }, senderTimestampMs: 4000, vote: { selectedOptions: [hashOpt('Player 5')] } }]
          ])
        };

        let sentMsg = null;
        const mockSock = {
          sendMessage: async (_jid, content) => {
            sentMsg = content;
            return { key: { id: 'rem_split_1' } };
          }
        };

        const activePolls = new Map([
          [part1Id, part1State],
          [part2Id, part2State]
        ]);
        const ok = await sendPollReminder(mockSock, part1Id, part1State, false, { activePolls, messageStore, persistPolls: () => {} }, now);

        assert.equal(ok, true);
        assert.ok(sentMsg);
        assert.match(sentMsg.text, /🔥 \*12 Hours to Match Time!\* — Tomorrow 7pm \*\(2 courts booked\)\*/);
        assert.match(sentMsg.text, /✅ \*Confirmed \(4\):\*\nSplitAlice, SplitBen, SplitChris, SplitDan/);
        assert.match(sentMsg.text, /⏳ \*Need 3 players for the 2nd foursome \(1\/4\):\*\nSplitEli/);
        assert.match(sentMsg.text, /@14082220005 — you're #5 right now/);
        assert.deepEqual(sentMsg.mentions?.includes('14082220005@s.whatsapp.net'), true);
        assert.deepEqual(sentMsg.mentions?.includes('14082220002@s.whatsapp.net'), false);
      } finally {
        for (const u of testUsers) {
          delete store[u.lid];
        }
      }
    });
  });

  describe('Manual trigger reminder commands (!remind, !reminder, --poll, quoted poll, --group)', () => {
    it('parses aliases, -f/--force, --poll, and quoted poll names', () => {
      assert.deepEqual(parseTriggerReminderArgs('!reminder'), { isForce: false, specificPollId: null });
      assert.deepEqual(parseTriggerReminderArgs('!reminders 7pm'), { isForce: false, specificPollId: '7pm' });
      assert.deepEqual(parseTriggerReminderArgs('!remind -f "Tomorrow 7pm"'), { isForce: true, specificPollId: 'Tomorrow 7pm' });
      assert.deepEqual(parseTriggerReminderArgs('!remind --poll=Friday 8am'), { isForce: false, specificPollId: 'Friday 8am' });
      assert.deepEqual(parseTriggerReminderArgs('!forcereminders --poll "Sat 9am"'), { isForce: true, specificPollId: 'Sat 9am' });
    });

    it('routes !reminder, !pollremind, and quoted poll replies to only the matching poll in the current chat', async () => {
      const chatA = '120363000000000001@g.us';
      const chatB = '120363000000000002@g.us';
      const now = new Date('2026-11-27T12:00:00-08:00').getTime();
      const playAt7 = new Date(now + 7 * 3600 * 1000).toISOString();
      const playAt9 = new Date(now + 9 * 3600 * 1000).toISOString();

      const activePolls = new Map([
        ['poll_a_7pm', { remoteJid: chatA, name: '🎾 Group A 7pm', when: 'Today 7pm', size: 4, options: ['Player 1', 'Player 2', 'Player 3', 'Player 4'], playAt: playAt7, status: 'active', voteBuffer: new Map() }],
        ['poll_b_7pm', { remoteJid: chatB, name: '🎾 Group B 7pm', when: 'Today 7pm', size: 4, options: ['Player 1', 'Player 2', 'Player 3', 'Player 4'], playAt: playAt7, status: 'active', voteBuffer: new Map() }],
        ['poll_b_9pm', { remoteJid: chatB, name: '🎾 Group B 9pm', when: 'Today 9pm', size: 4, options: ['Player 1', 'Player 2', 'Player 3', 'Player 4'], playAt: playAt9, status: 'active', voteBuffer: new Map() }]
      ]);

      const sentMessages = [];
      const mockSock = {
        user: { id: 'tenbot@s.whatsapp.net' },
        sendMessage: async (jid, content, opts) => {
          sentMessages.push({ jid, content, opts });
          return { key: { id: `sent_${sentMessages.length}` } };
        }
      };
      const context = {
        activePolls,
        recurringPolls: new Map(),
        messageStore: new Map(),
        persistPolls: () => {},
        now
      };

      // 1. Scoped by current chat: !reminder 7pm in chatB triggers ONLY poll_b_7pm (never poll_a_7pm)
      const r1 = await handlePollCommand(mockSock, '!reminder 7pm', chatB, 'Alice', 'alice@lid', null, context);
      assert.equal(r1, true);
      assert.equal(sentMessages.length, 1);
      assert.equal(sentMessages[0].jid, chatB);
      assert.equal(sentMessages[0].opts.quoted.key.id, 'poll_b_7pm');

      // 2. Replying/quoting a specific poll with !pollremind triggers ONLY that quoted poll
      sentMessages.length = 0;
      const quoteMsg = { message: { extendedTextMessage: { contextInfo: { stanzaId: 'poll_b_9pm' } } } };
      const r2 = await handlePollCommand(mockSock, '!pollremind', chatB, 'Alice', 'alice@lid', quoteMsg, context);
      assert.equal(r2, true);
      assert.equal(sentMessages.length, 1);
      assert.equal(sentMessages[0].opts.quoted.key.id, 'poll_b_9pm');

      // 3. Claude tool trigger_reminder matches by pollName and forwards force flag
      sentMessages.length = 0;
      const nightNow = new Date('2026-11-27T23:00:00-08:00').getTime();
      const nightContext = { ...context, now: nightNow };
      const r3 = await executePollTool(
        mockSock,
        'trigger_reminder',
        { pollName: '9pm', force: true },
        'Alice',
        'alice@lid',
        chatB,
        null,
        nightContext
      );
      assert.match(r3, /Reminder triggered/i);
      assert.equal(sentMessages.length, 1);
      assert.equal(sentMessages[0].opts.quoted.key.id, 'poll_b_9pm');
    });
  });
});
