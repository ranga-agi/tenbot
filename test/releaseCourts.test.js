process.env.NODE_ENV = 'test';
const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const scvcc = require('../lib/scvcc');
const namesStore = require('../lib/names');
const pollCommands = require('../lib/commands/poll');
const {
  parseReleaseCourtsArgs,
  handleReleasePollCourts,
  handlePollCommand,
  executePollTool
} = pollCommands;

describe('Release Courts for Poll', () => {
  describe('parseReleaseCourtsArgs', () => {
    it('should parse "all"', () => {
      const res = parseReleaseCourtsArgs('all');
      assert.deepEqual(res, { target: null, countOrAll: 'all', specificCourt: null });
    });

    it('should parse count only: "1", "2"', () => {
      assert.deepEqual(parseReleaseCourtsArgs('1'), { target: null, countOrAll: 1, specificCourt: null });
      assert.deepEqual(parseReleaseCourtsArgs('2'), { target: null, countOrAll: 2, specificCourt: null });
    });

    it('should parse specific court only: "Court 3", "ct 3", "c3"', () => {
      assert.deepEqual(parseReleaseCourtsArgs('Court 3'), { target: null, countOrAll: 1, specificCourt: 'Court 3' });
      assert.deepEqual(parseReleaseCourtsArgs('ct 3'), { target: null, countOrAll: 1, specificCourt: 'Court 3' });
      assert.deepEqual(parseReleaseCourtsArgs('c2'), { target: null, countOrAll: 1, specificCourt: 'Court 2' });
    });

    it('should parse poll target with count: "7pm 1", "rec_1 2"', () => {
      assert.deepEqual(parseReleaseCourtsArgs('7pm 1'), { target: '7pm', countOrAll: 1, specificCourt: null });
      assert.deepEqual(parseReleaseCourtsArgs('rec_1 2'), { target: 'rec_1', countOrAll: 2, specificCourt: null });
      assert.deepEqual(parseReleaseCourtsArgs('Monday 7pm 1'), { target: 'Monday 7pm', countOrAll: 1, specificCourt: null });
    });

    it('should parse poll target with all: "7pm all", "all 7pm", "rec_1 all"', () => {
      assert.deepEqual(parseReleaseCourtsArgs('7pm all'), { target: '7pm', countOrAll: 'all', specificCourt: null });
      assert.deepEqual(parseReleaseCourtsArgs('all 7pm'), { target: '7pm', countOrAll: 'all', specificCourt: null });
      assert.deepEqual(parseReleaseCourtsArgs('rec_1 all'), { target: 'rec_1', countOrAll: 'all', specificCourt: null });
    });

    it('should parse poll target with specific court: "7pm Court 3", "rec_1 Court 2"', () => {
      assert.deepEqual(parseReleaseCourtsArgs('7pm Court 3'), { target: '7pm', countOrAll: 1, specificCourt: 'Court 3' });
      assert.deepEqual(parseReleaseCourtsArgs('rec_1 Court 2'), { target: 'rec_1', countOrAll: 1, specificCourt: 'Court 2' });
    });

    it('should return target only if count is omitted', () => {
      assert.deepEqual(parseReleaseCourtsArgs('7pm'), { target: '7pm', countOrAll: null, specificCourt: null });
      assert.deepEqual(parseReleaseCourtsArgs(''), { target: null, countOrAll: null, specificCourt: null });
    });

    it('should parse --keep-size and aliases without breaking other positions', () => {
      assert.deepEqual(parseReleaseCourtsArgs('1 --keep-size'), { target: null, countOrAll: 1, specificCourt: null, keepSize: true });
      assert.deepEqual(parseReleaseCourtsArgs('--no-resize all'), { target: null, countOrAll: 'all', specificCourt: null, keepSize: true });
      assert.deepEqual(parseReleaseCourtsArgs('rec_1 Court 2 --keep-size'), { target: 'rec_1', countOrAll: 1, specificCourt: 'Court 2', keepSize: true });
      assert.deepEqual(parseReleaseCourtsArgs('7pm 1 --preserve-size'), { target: '7pm', countOrAll: 1, specificCourt: null, keepSize: true });
      assert.deepEqual(parseReleaseCourtsArgs('Court 3 --keep-poll-size'), { target: null, countOrAll: 1, specificCourt: 'Court 3', keepSize: true });
      assert.deepEqual(parseReleaseCourtsArgs('--no-size-change 7pm all'), { target: '7pm', countOrAll: 'all', specificCourt: null, keepSize: true });
    });
  });

  describe('handleReleasePollCourts', () => {
    const testChatId = '120363403838804497@g.us';
    let cancelledReservations = [];
    let sentMessages = [];
    let deletedPolls = [];

    const mockSock = {
      user: { id: 'tenbot@s.whatsapp.net' },
      groupMetadata: async () => ({
        participants: [
          { id: 'admin@s.whatsapp.net', admin: 'admin' },
          { id: 'alice@s.whatsapp.net', admin: null }
        ]
      }),
      sendMessage: async (jid, payload) => {
        if (payload.delete) {
          deletedPolls.push(payload.delete.id);
        } else {
          sentMessages.push({ jid, payload });
        }
        return { key: { id: `msg_${sentMessages.length}`, remoteJid: jid } };
      }
    };

    beforeEach(() => {
      cancelledReservations = [];
      sentMessages = [];
      deletedPolls = [];
      scvcc.cancelCourtReservation = async (resId, chatId) => {
        cancelledReservations.push({ resId, chatId });
        return { success: true, message: `Reservation #${resId} cancelled.` };
      };
    });

    it('should release 1 court from a 3-court (12-spot) poll and reduce size to 8', async () => {
      const activePolls = new Map();
      const pollId = 'poll_rel_1';
      const pollState = {
        name: '🎾 Monday 7pm (12 spots) - Court 1, Court 2, Court 3 - Booked',
        when: 'Monday 7pm',
        size: 12,
        status: 'active',
        remoteJid: testChatId,
        creator: { name: 'Admin', jid: 'admin@s.whatsapp.net' },
        prebookedCourts: [
          { court: 'Court 1', reservationId: '101' },
          { court: 'Court 2', reservationId: '102' },
          { court: 'Court 3', reservationId: '103' }
        ],
        autoBookedCourts: [
          { court: 'Court 1', reservationId: '101' },
          { court: 'Court 2', reservationId: '102' },
          { court: 'Court 3', reservationId: '103' }
        ]
      };
      activePolls.set(pollId, pollState);

      let persisted = false;
      const context = {
        activePolls,
        recurringPolls: new Map(),
        latestPollIdByChat: new Map([[testChatId, pollId]]),
        persistPolls: () => { persisted = true; }
      };

      const res = await handleReleasePollCourts(
        mockSock,
        testChatId,
        'Admin',
        'admin@s.whatsapp.net',
        '!releasecourt 1',
        context
      );

      assert.match(res, /Released 1 court/);
      assert.match(res, /Court 3/);
      assert.match(res, /8 spots/);
      assert.equal(pollState.size, 8);
      assert.equal(pollState.slotLimit, 8);
      assert.equal(pollState.prebookedCourts.length, 2);
      assert.equal(cancelledReservations.length, 1);
      assert.equal(cancelledReservations[0].resId, '103');
      assert.ok(persisted);
    });

    it('should release all courts, stop poll, delete from WhatsApp, and notify group', async () => {
      const activePolls = new Map();
      const pollId = 'poll_rel_all';
      const pollState = {
        name: '🎾 Tuesday 8pm (8 spots)',
        when: 'Tuesday 8pm',
        size: 8,
        status: 'active',
        remoteJid: testChatId,
        creator: { name: 'Admin', jid: 'admin@s.whatsapp.net' },
        prebookedCourts: [
          { court: 'Court 1', reservationId: '201' },
          { court: 'Court 2', reservationId: '202' }
        ],
        autoBookedCourts: [
          { court: 'Court 1', reservationId: '201' },
          { court: 'Court 2', reservationId: '202' }
        ]
      };
      activePolls.set(pollId, pollState);

      const context = {
        activePolls,
        recurringPolls: new Map(),
        latestPollIdByChat: new Map([[testChatId, pollId]]),
        persistPolls: () => {}
      };

      const res = await handleReleasePollCourts(
        mockSock,
        testChatId,
        'Admin',
        'admin@s.whatsapp.net',
        '!releasecourt all',
        context
      );

      assert.match(res, /All courts released/i);
      assert.match(res, /Voting has been stopped and the poll has been closed/i);
      assert.equal(pollState.size, 0);
      assert.equal(pollState.status, 'stopped');
      assert.equal(pollState.prebookedCourts.length, 0);
      assert.equal(cancelledReservations.length, 2);
      assert.ok(deletedPolls.includes(pollId), 'Poll should be deleted from WhatsApp');
    });

    it('should release a specific court when court name is provided', async () => {
      const activePolls = new Map();
      const pollId = 'poll_rel_spec';
      const pollState = {
        name: '🎾 Wed 7pm (8 spots)',
        when: 'Wed 7pm',
        size: 8,
        status: 'active',
        remoteJid: testChatId,
        creator: { name: 'Admin', jid: 'admin@s.whatsapp.net' },
        prebookedCourts: [
          { court: 'Court 1', reservationId: '301' },
          { court: 'Court 2', reservationId: '302' }
        ]
      };
      activePolls.set(pollId, pollState);

      const context = {
        activePolls,
        recurringPolls: new Map(),
        latestPollIdByChat: new Map([[testChatId, pollId]]),
        persistPolls: () => {}
      };

      const res = await handleReleasePollCourts(
        mockSock,
        testChatId,
        'Admin',
        'admin@s.whatsapp.net',
        '!releasecourt Court 1',
        context
      );

      assert.match(res, /Released 1 court/);
      assert.match(res, /Court 1/);
      assert.equal(pollState.size, 4);
      assert.equal(pollState.prebookedCourts.length, 1);
      assert.equal(pollState.prebookedCourts[0].court, 'Court 2');
      assert.equal(cancelledReservations[0].resId, '301');
    });

    it('should reject non-admin and non-creator from releasing courts', async () => {
      const activePolls = new Map();
      const pollId = 'poll_rel_perm';
      const pollState = {
        name: '🎾 Thursday 7pm',
        when: 'Thursday 7pm',
        size: 8,
        status: 'active',
        remoteJid: testChatId,
        creator: { name: 'Admin', jid: 'admin@s.whatsapp.net' },
        prebookedCourts: [{ court: 'Court 1' }]
      };
      activePolls.set(pollId, pollState);

      const context = {
        activePolls,
        recurringPolls: new Map(),
        latestPollIdByChat: new Map([[testChatId, pollId]]),
        persistPolls: () => {}
      };

      const res = await handleReleasePollCourts(
        mockSock,
        testChatId,
        'Alice',
        'alice@s.whatsapp.net',
        '!releasecourt 1',
        context
      );

      assert.match(res, /Only the poll creator or group admins/i);
      assert.equal(pollState.size, 8);
    });

    it('should notify the group when executed from DM with --group', async () => {
      const activePolls = new Map();
      const pollId = 'poll_rel_dm';
      const pollState = {
        name: '🎾 Friday 7pm (8 spots)',
        when: 'Friday 7pm',
        size: 8,
        status: 'active',
        remoteJid: testChatId,
        creator: { name: 'Admin', jid: 'admin@s.whatsapp.net' },
        prebookedCourts: [{ court: 'Court 1' }, { court: 'Court 2' }]
      };
      activePolls.set(pollId, pollState);

      const dmChatId = 'admin@s.whatsapp.net';
      const context = {
        activePolls,
        recurringPolls: new Map(),
        latestPollIdByChat: new Map([[testChatId, pollId]]),
        persistPolls: () => {}
      };

      const res = await handleReleasePollCourts(
        mockSock,
        testChatId,
        'Admin',
        'admin@s.whatsapp.net',
        '!releasecourt all',
        context,
        testChatId,
        dmChatId
      );

      assert.match(res, /All courts released/i);
      // Group was notified
      const groupNotif = sentMessages.find(m => m.jid === testChatId);
      assert.ok(groupNotif, 'Group should receive notification message');
      assert.match(groupNotif.payload.text, /All courts released/i);
    });

    it('should execute through handlePollCommand with !releasecourts alias', async () => {
      const activePolls = new Map();
      const pollId = 'poll_rel_alias';
      const pollState = {
        name: '🎾 Sat 7pm (12 spots)',
        when: 'Sat 7pm',
        size: 12,
        status: 'active',
        remoteJid: testChatId,
        creator: { name: 'Admin', jid: 'admin@s.whatsapp.net' },
        prebookedCourts: [{ court: 'Court 1' }, { court: 'Court 2' }, { court: 'Court 3' }]
      };
      activePolls.set(pollId, pollState);

      const context = {
        activePolls,
        recurringPolls: new Map(),
        latestPollIdByChat: new Map([[testChatId, pollId]]),
        persistPolls: () => {}
      };

      const res = await handlePollCommand(
        mockSock,
        '!releasecourts 1',
        testChatId,
        'Admin',
        'admin@s.whatsapp.net',
        null,
        context
      );

      assert.match(res, /Released 1 court/);
      assert.equal(pollState.size, 8);
    });

    it('should execute through executePollTool with release_poll_courts', async () => {
      const activePolls = new Map();
      const pollId = 'poll_rel_tool';
      const pollState = {
        name: '🎾 Sun 7pm (8 spots)',
        when: 'Sun 7pm',
        size: 8,
        status: 'active',
        remoteJid: testChatId,
        creator: { name: 'Admin', jid: 'admin@s.whatsapp.net' },
        prebookedCourts: [{ court: 'Court 1' }, { court: 'Court 2' }]
      };
      activePolls.set(pollId, pollState);

      const context = {
        activePolls,
        recurringPolls: new Map(),
        latestPollIdByChat: new Map([[testChatId, pollId]]),
        persistPolls: () => {}
      };

      const res = await executePollTool(
        mockSock,
        'release_poll_courts',
        { all: true },
        'Admin',
        'admin@s.whatsapp.net',
        testChatId,
        null,
        context
      );

      assert.match(res, /All courts released/i);
      assert.equal(pollState.size, 0);
      assert.equal(pollState.status, 'stopped');
    });

    it('should accept parentPollId of a split poll for partial release and sync state across siblings', async () => {
      const activePolls = new Map();
      const sessionId = 'session_split_rel';
      const courts = [
        { court: 'Court 1', reservationId: '701' },
        { court: 'Court 2', reservationId: '702' },
        { court: 'Court 3', reservationId: '703' },
        { court: 'Court 4', reservationId: '704' }
      ];
      const part1 = {
        id: 'poll_split_rel_1',
        parentPollId: sessionId,
        partNumber: 1,
        sessionTotalSize: 16,
        size: 12,
        name: '🎾 Saturday 8am (16 spots) - Part 1 - Court 4 - Booked',
        when: 'Saturday 8am',
        status: 'active',
        remoteJid: testChatId,
        creator: { name: 'Admin', jid: 'admin@s.whatsapp.net' },
        prebookedCourts: courts.map((c) => ({ ...c })),
        autoBookedCourts: courts.map((c) => ({ ...c })),
        voteBuffer: new Map()
      };
      const part2 = {
        id: 'poll_split_rel_2',
        parentPollId: sessionId,
        partNumber: 2,
        sessionTotalSize: 16,
        size: 4,
        name: '🎾 Saturday 8am (16 spots) - Part 2 - Court 4 - Booked',
        when: 'Saturday 8am',
        status: 'filled',
        remoteJid: testChatId,
        creator: { name: 'Admin', jid: 'admin@s.whatsapp.net' },
        prebookedCourts: courts.map((c) => ({ ...c })),
        autoBookedCourts: courts.map((c) => ({ ...c })),
        voteBuffer: new Map()
      };
      activePolls.set('poll_split_rel_1', part1);
      activePolls.set('poll_split_rel_2', part2);

      const context = {
        activePolls,
        recurringPolls: new Map(),
        latestPollIdByChat: new Map([[testChatId, 'poll_split_rel_2']]),
        persistPolls: () => {}
      };

      const res = await handleReleasePollCourts(
        mockSock,
        testChatId,
        'Admin',
        'admin@s.whatsapp.net',
        `!releasecourt ${sessionId} 1`,
        context
      );

      assert.match(res, /Released 1 court/);
      assert.match(res, /Court 4/);
      assert.match(res, /12 spots/);
      assert.equal(cancelledReservations.length, 1);
      assert.equal(cancelledReservations[0].resId, '704');
      assert.equal(part1.prebookedCourts.length, 3);
      assert.equal(part2.prebookedCourts.length, 3);
      assert.equal(part1.sessionTotalSize, 12);
      assert.equal(part2.sessionTotalSize, 12);
      assert.equal(part1.releasedCourts[0].court, 'Court 4');
      assert.equal(part2.releasedCourts[0].court, 'Court 4');
      assert.match(part1.name, /Court 4 - Released/);
      assert.match(part2.name, /Court 4 - Released/);
    });

    it('should accept parentPollId for releasing all courts, stopping and deleting all sibling polls, and handle targetless release', async () => {
      const activePolls = new Map();
      const sessionId = 'session_split_all';
      const part1 = {
        id: 'poll_split_all_1',
        parentPollId: sessionId,
        partNumber: 1,
        sessionTotalSize: 16,
        size: 12,
        when: 'Sunday 8am',
        status: 'active',
        remoteJid: testChatId,
        creator: { name: 'Admin', jid: 'admin@s.whatsapp.net' },
        prebookedCourts: [{ court: 'Court 1', reservationId: '801' }, { court: 'Court 2', reservationId: '802' }],
        siblingPollIds: ['poll_split_all_1', 'poll_split_all_2']
      };
      const part2 = {
        id: 'poll_split_all_2',
        parentPollId: sessionId,
        partNumber: 2,
        sessionTotalSize: 16,
        size: 4,
        when: 'Sunday 8am',
        status: 'active',
        remoteJid: testChatId,
        creator: { name: 'Admin', jid: 'admin@s.whatsapp.net' },
        prebookedCourts: [{ court: 'Court 1', reservationId: '801' }, { court: 'Court 2', reservationId: '802' }],
        siblingPollIds: ['poll_split_all_1', 'poll_split_all_2']
      };
      activePolls.set('poll_split_all_1', part1);
      activePolls.set('poll_split_all_2', part2);

      const context = {
        activePolls,
        recurringPolls: new Map(),
        latestPollIdByChat: new Map([[testChatId, 'poll_split_all_2']]),
        persistPolls: () => {}
      };

      // Targetless release on single split session should not complain about duplicate polls
      const resOne = await handleReleasePollCourts(mockSock, testChatId, 'Admin', 'admin@s.whatsapp.net', '!releasecourt 1', context);
      assert.match(resOne, /Released 1 court/);
      assert.equal(part1.prebookedCourts.length, 1);
      assert.equal(part2.prebookedCourts.length, 1);

      // Release remaining with parentPollId + all
      const resAll = await handleReleasePollCourts(
        mockSock,
        testChatId,
        'Admin',
        'admin@s.whatsapp.net',
        `!releasecourt ${sessionId} all`,
        context
      );

      assert.match(resAll, /All courts released/i);
      assert.equal(part1.status, 'stopped');
      assert.equal(part2.status, 'stopped');
      assert.equal(part1.size, 0);
      assert.equal(part2.size, 0);
      assert.equal(part1.sessionTotalSize, 0);
      assert.equal(part2.sessionTotalSize, 0);
      assert.ok(deletedPolls.includes('poll_split_all_1'));
      assert.ok(deletedPolls.includes('poll_split_all_2'));
    });

    it('should release 1 court with --keep-size without changing poll size or name spots', async () => {
      const activePolls = new Map();
      const pollId = 'poll_rel_keep_partial';
      const pollState = {
        name: '🎾 Monday 7pm (12 spots) - Court 1, Court 2, Court 3 - Booked',
        when: 'Monday 7pm',
        size: 12,
        slotLimit: 12,
        status: 'active',
        remoteJid: testChatId,
        creator: { name: 'Admin', jid: 'admin@s.whatsapp.net' },
        prebookedCourts: [
          { court: 'Court 1', reservationId: '901' },
          { court: 'Court 2', reservationId: '902' },
          { court: 'Court 3', reservationId: '903' }
        ],
        autoBookedCourts: [
          { court: 'Court 1', reservationId: '901' },
          { court: 'Court 2', reservationId: '902' },
          { court: 'Court 3', reservationId: '903' }
        ]
      };
      activePolls.set(pollId, pollState);

      const context = {
        activePolls,
        recurringPolls: new Map(),
        latestPollIdByChat: new Map([[testChatId, pollId]]),
        persistPolls: () => {}
      };

      const res = await handleReleasePollCourts(
        mockSock,
        testChatId,
        'Admin',
        'admin@s.whatsapp.net',
        '!releasecourt 1 --keep-size',
        context
      );

      assert.match(res, /Released 1 court/i);
      assert.match(res, /Poll size preserved at \*12 spots\*/i);
      assert.equal(pollState.size, 12);
      assert.equal(pollState.slotLimit, 12);
      assert.equal(pollState.originalSize, undefined);
      assert.match(pollState.name, /\(12 spots\)/);
      assert.match(pollState.name, /Court 3 - Released/);
      assert.equal(pollState.prebookedCourts.length, 2);
      assert.equal(cancelledReservations.length, 1);
      assert.equal(cancelledReservations[0].resId, '903');
      assert.equal(deletedPolls.length, 0);
    });

    it('should release all courts with --keep-size, keep poll active and not delete WhatsApp poll, and reject repeat release', async () => {
      const activePolls = new Map();
      const pollId = 'poll_rel_keep_all';
      const pollState = {
        name: '🎾 Tuesday 8pm (8 spots)',
        when: 'Tuesday 8pm',
        size: 8,
        slotLimit: 8,
        status: 'active',
        remoteJid: testChatId,
        creator: { name: 'Admin', jid: 'admin@s.whatsapp.net' },
        prebookedCourts: [
          { court: 'Court 1', reservationId: '911' },
          { court: 'Court 2', reservationId: '912' }
        ]
      };
      activePolls.set(pollId, pollState);

      const context = {
        activePolls,
        recurringPolls: new Map(),
        latestPollIdByChat: new Map([[testChatId, pollId]]),
        persistPolls: () => {}
      };

      // Release 1st court with specific court + --no-resize
      const resFirst = await handleReleasePollCourts(
        mockSock,
        testChatId,
        'Admin',
        'admin@s.whatsapp.net',
        '!releasecourt Court 1 --no-resize',
        context
      );
      assert.match(resFirst, /Poll size preserved at \*8 spots\*/i);
      assert.equal(pollState.size, 8);
      assert.equal(pollState.status, 'active');
      assert.equal(pollState.prebookedCourts.length, 1);
      assert.equal(deletedPolls.length, 0);

      // Release last remaining court with --keep-size
      const resLast = await handleReleasePollCourts(
        mockSock,
        testChatId,
        'Admin',
        'admin@s.whatsapp.net',
        '!releasecourt 1 --keep-size',
        context
      );
      assert.match(resLast, /All courts released/i);
      assert.match(resLast, /Poll size remains \*8 spots\* and voting stays open/i);
      assert.equal(pollState.size, 8);
      assert.equal(pollState.slotLimit, 8);
      assert.equal(pollState.status, 'active');
      assert.equal(pollState.prebookedCourts.length, 0);
      assert.equal(cancelledReservations.length, 2);
      assert.equal(deletedPolls.length, 0, 'WhatsApp poll should NOT be deleted when --keep-size is used');

      // Subsequent release should report no booked courts remaining instead of estimating from size
      const resRepeat = await handleReleasePollCourts(
        mockSock,
        testChatId,
        'Admin',
        'admin@s.whatsapp.net',
        '!releasecourt 1 --keep-size',
        context
      );
      assert.match(resRepeat, /no booked courts remaining/i);
      assert.equal(cancelledReservations.length, 2);
    });

    it('should preserve split poll sessionTotalSize and sibling sizes with --keep-size', async () => {
      const activePolls = new Map();
      const sessionId = 'session_split_keep';
      const part1 = {
        id: 'poll_split_keep_1',
        parentPollId: sessionId,
        partNumber: 1,
        sessionTotalSize: 16,
        size: 12,
        name: '🎾 Saturday 8am (16 spots) - Part 1 - Court 4 - Booked',
        when: 'Saturday 8am',
        status: 'active',
        remoteJid: testChatId,
        creator: { name: 'Admin', jid: 'admin@s.whatsapp.net' },
        prebookedCourts: [
          { court: 'Court 1', reservationId: '921' },
          { court: 'Court 4', reservationId: '924' }
        ],
        siblingPollIds: ['poll_split_keep_1', 'poll_split_keep_2']
      };
      const part2 = {
        id: 'poll_split_keep_2',
        parentPollId: sessionId,
        partNumber: 2,
        sessionTotalSize: 16,
        size: 4,
        name: '🎾 Saturday 8am (16 spots) - Part 2 - Court 4 - Booked',
        when: 'Saturday 8am',
        status: 'active',
        remoteJid: testChatId,
        creator: { name: 'Admin', jid: 'admin@s.whatsapp.net' },
        prebookedCourts: [
          { court: 'Court 1', reservationId: '921' },
          { court: 'Court 4', reservationId: '924' }
        ],
        siblingPollIds: ['poll_split_keep_1', 'poll_split_keep_2']
      };
      activePolls.set('poll_split_keep_1', part1);
      activePolls.set('poll_split_keep_2', part2);

      const context = {
        activePolls,
        recurringPolls: new Map(),
        latestPollIdByChat: new Map([[testChatId, 'poll_split_keep_2']]),
        persistPolls: () => {}
      };

      const resPartial = await handleReleasePollCourts(
        mockSock,
        testChatId,
        'Admin',
        'admin@s.whatsapp.net',
        `!releasecourt ${sessionId} 1 --keep-size`,
        context
      );
      assert.match(resPartial, /Poll size preserved at \*16 spots\*/i);
      assert.equal(part1.sessionTotalSize, 16);
      assert.equal(part2.sessionTotalSize, 16);
      assert.equal(part1.size, 12);
      assert.equal(part2.size, 4);
      assert.match(part1.name, /\(16 spots\)/);
      assert.equal(part1.prebookedCourts.length, 1);

      const resAll = await handleReleasePollCourts(
        mockSock,
        testChatId,
        'Admin',
        'admin@s.whatsapp.net',
        `!releasecourt ${sessionId} all --keep-size`,
        context
      );
      assert.match(resAll, /All courts released/i);
      assert.equal(part1.sessionTotalSize, 16);
      assert.equal(part2.sessionTotalSize, 16);
      assert.equal(part1.status, 'active');
      assert.equal(part2.status, 'active');
      assert.equal(deletedPolls.length, 0);
    });

    it('should preserve multi-time poll slot capacities and status with --keep-size', async () => {
      const activePolls = new Map();
      const pollId = 'poll_mt_keep';
      const pollState = {
        id: pollId,
        type: 'multi_time',
        name: '🎾 Multi-time Poll',
        when: 'Sunday',
        size: 16,
        status: 'active',
        remoteJid: testChatId,
        creator: { name: 'Admin', jid: 'admin@s.whatsapp.net' },
        timeSlots: [
          {
            label: '9:00 AM',
            timeWord: '9am',
            timeDisplay: '9:00 AM',
            size: 8,
            slotLimit: 8,
            status: 'active',
            prebookedCourts: [
              { court: 'Court 1', reservationId: '941' },
              { court: 'Court 2', reservationId: '942' }
            ]
          }
        ]
      };
      activePolls.set(pollId, pollState);

      const context = {
        activePolls,
        recurringPolls: new Map(),
        latestPollIdByChat: new Map([[testChatId, pollId]]),
        persistPolls: () => {}
      };

      const res = await handleReleasePollCourts(
        mockSock,
        testChatId,
        'Admin',
        'admin@s.whatsapp.net',
        `!releasecourt ${pollId} all --keep-size`,
        context
      );

      assert.match(res, /poll size preserved/i);
      assert.equal(pollState.status, 'active');
      assert.equal(pollState.timeSlots[0].size, 8);
      assert.equal(pollState.timeSlots[0].slotLimit, 8);
      assert.equal(pollState.timeSlots[0].status, 'active');
      assert.equal(pollState.timeSlots[0].prebookedCourts.length, 0);
      assert.equal(cancelledReservations.length, 2);
      assert.equal(deletedPolls.length, 0);
    });

    it('should execute through executePollTool with release_poll_courts and keepSize: true', async () => {
      const activePolls = new Map();
      const pollId = 'poll_rel_tool_keep';
      const pollState = {
        name: '🎾 Sun 7pm (8 spots)',
        when: 'Sun 7pm',
        size: 8,
        slotLimit: 8,
        status: 'active',
        remoteJid: testChatId,
        creator: { name: 'Admin', jid: 'admin@s.whatsapp.net' },
        prebookedCourts: [
          { court: 'Court 1', reservationId: '931' },
          { court: 'Court 2', reservationId: '932' }
        ]
      };
      activePolls.set(pollId, pollState);

      const context = {
        activePolls,
        recurringPolls: new Map(),
        latestPollIdByChat: new Map([[testChatId, pollId]]),
        persistPolls: () => {}
      };

      const res = await executePollTool(
        mockSock,
        'release_poll_courts',
        { count: 1, keepSize: true },
        'Admin',
        'admin@s.whatsapp.net',
        testChatId,
        null,
        context
      );

      assert.match(res, /Poll size preserved at \*8 spots\*/i);
      assert.equal(pollState.size, 8);
      assert.equal(pollState.slotLimit, 8);
      assert.equal(pollState.prebookedCourts.length, 1);
      assert.equal(cancelledReservations[0].resId, '932');
    });
  });
});
