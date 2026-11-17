process.env.NODE_ENV = 'test';
const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const scvcc = require('../lib/scvcc');
const namesStore = require('../lib/names');
const pollCommands = require('../lib/commands/pollCommands');
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
  });
});
