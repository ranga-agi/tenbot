process.env.NODE_ENV = 'test';
const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const pollTime = require('../lib/pollTime');
const groupsConfig = require('../lib/groupsConfig');
const scvcc = require('../lib/scvcc');
const recurringPollsModule = require('../lib/recurringPolls');
const recurringCommands = require('../lib/commands/recurringCommands');
const pollCommands = require('../lib/commands/poll');
const { parseBookPollCourtsArgs, handleBookPollCourts, preBookCourtsForMatch, handleOnDemandCourtBooking } = require('../lib/commands/poll/courts');

describe('Poll & Recurring Booking Duration Support', () => {
  describe('pollTime booking duration helpers', () => {
    it('parses valid numeric and string durations (30, 60, 90, 120)', () => {
      assert.equal(pollTime.parseBookingDuration(30), 30);
      assert.equal(pollTime.parseBookingDuration(60), 60);
      assert.equal(pollTime.parseBookingDuration(90), 90);
      assert.equal(pollTime.parseBookingDuration(120), 120);

      assert.equal(pollTime.parseBookingDuration('30m'), 30);
      assert.equal(pollTime.parseBookingDuration('half an hour'), 30);
      assert.equal(pollTime.parseBookingDuration('0.5h'), 30);
      assert.equal(pollTime.parseBookingDuration('60min'), 60);
      assert.equal(pollTime.parseBookingDuration('60 mins'), 60);
      assert.equal(pollTime.parseBookingDuration('1h'), 60);
      assert.equal(pollTime.parseBookingDuration('one hour'), 60);
      assert.equal(pollTime.parseBookingDuration('90 Minutes'), 90);
      assert.equal(pollTime.parseBookingDuration('1.5 hours'), 90);
      assert.equal(pollTime.parseBookingDuration('1h 30m'), 90);
      assert.equal(pollTime.parseBookingDuration('2h'), 120);
      assert.equal(pollTime.parseBookingDuration('two hours'), 120);
    });

    it('returns null for reset/clear words and undefined for invalid values', () => {
      assert.equal(pollTime.parseBookingDuration(null), null);
      assert.equal(pollTime.parseBookingDuration('default'), null);
      assert.equal(pollTime.parseBookingDuration('none'), null);
      assert.equal(pollTime.parseBookingDuration('clear'), null);
      assert.equal(pollTime.parseBookingDuration('reset'), null);

      assert.equal(pollTime.parseBookingDuration(undefined), undefined);
      assert.equal(pollTime.parseBookingDuration(''), undefined);
      assert.equal(pollTime.parseBookingDuration(45), undefined);
      assert.equal(pollTime.parseBookingDuration('45m'), undefined);
      assert.equal(pollTime.parseBookingDuration('3h'), undefined);
      assert.equal(pollTime.parseBookingDuration('abc'), undefined);
    });

    it('formats human-readable and SCVCC duration strings', () => {
      assert.equal(pollTime.formatBookingDuration(60), '60 mins');
      assert.equal(pollTime.formatBookingDuration(null), '90 mins');
      assert.equal(pollTime.formatScvccDuration(60), '60 Minutes');
      assert.equal(pollTime.formatScvccDuration(120), '120 Minutes');
      assert.equal(pollTime.formatScvccDuration(undefined), '90 Minutes');
    });
  });

  describe('groupsConfig bookingDuration support', () => {
    let origConfig;
    beforeEach(() => {
      origConfig = JSON.parse(JSON.stringify(groupsConfig.loadRawConfig() || {}));
    });
    afterEach(() => {
      groupsConfig.saveRawConfig(origConfig);
    });

    it('reads default, sets per-group bookingDuration, formats it, and resets to default', () => {
      const testGroupJid = groupsConfig.getGroupJid('Bot-testing');
      assert.ok(testGroupJid);

      const updateRes = groupsConfig.updateGroupConfig('Bot-testing', { bookingDuration: '60m' });
      assert.ok(updateRes);
      assert.equal(updateRes.bookingDuration, 60);
      assert.equal(groupsConfig.getBookingDuration(testGroupJid), 60);
      assert.equal(groupsConfig.getGroupConfig(testGroupJid).bookingDuration, 60);

      const formatted = groupsConfig.formatGroupConfig('Bot-testing');
      assert.match(formatted, /Booking Duration:\*\s*60 mins/);

      const clearRes = groupsConfig.updateGroupConfig('Bot-testing', { bookingDuration: 'default' });
      assert.ok(clearRes);
      assert.equal(clearRes.bookingDuration, undefined);
      assert.equal(groupsConfig.loadRawConfig().groups[testGroupJid].bookingDuration, undefined);
    });
  });

  describe('Command & flag parsing without collisions', () => {
    it('extracts explicit and natural bookingDuration without colliding with lookAround, leadTime, or postTime', () => {
      const r1 = recurringPollsModule.extractCommonFlags('4 tomorrow 7pm --booking-duration=60m --look-around=1h --lineup-lead-time=1h --post-time="2h before"');
      assert.equal(r1.flags.bookingDuration, 60);
      assert.equal(r1.flags.lookAround, 60);
      assert.equal(r1.flags.lineupLeadTime, 60);
      assert.equal(r1.flags.postTime, '2h before');

      const p1 = pollCommands.parsePollCreationText('!poll 4 tomorrow 7pm --booking-duration=60m --look-around=1h --lineup-lead-time=1h at 2h before');
      assert.equal(p1.bookingDuration, 60);
      assert.equal(p1.lookAround, 60);
      assert.equal(p1.lineupLeadTime, 60);
      assert.equal(p1.postTime, '2h before');

      const r2 = recurringPollsModule.extractCommonFlags('4 tomorrow 9am 1h --courts-strategy=book');
      assert.equal(r2.flags.bookingDuration, 60);
      assert.equal(r2.flags.courtsStrategy, 'book');

      // Guard: "at 2h before" postTime without explicit booking duration must NOT become bookingDuration=120
      const r3 = recurringPollsModule.extractCommonFlags('4 tomorrow 7pm --look-around=1h at 2h before');
      assert.equal(r3.flags.bookingDuration, undefined);
      assert.equal(r3.flags.lookAround, 60);
    });

    it('parses bookingDuration in parsePollCreationText and parseRecurringPollText', () => {
      const pollParsed = pollCommands.parsePollCreationText('!poll 4 tomorrow 9am 60min --courts-strategy=book');
      assert.equal(pollParsed.bookingDuration, 60);
      assert.equal(pollParsed.courtsStrategy, 'book');

      const recParsed = recurringPollsModule.parseRecurringPollText('!recurringpoll 4 7pm on weekdays 1.5h --courts-strategy=book');
      assert.equal(recParsed.bookingDuration, 90);

      const recModParsed = recurringPollsModule.parseRecurringPollText('!modifyrecurringpoll rec_1 --booking-duration=default');
      assert.equal(recModParsed.action, 'modify');
      assert.equal(recModParsed.updates.bookingDuration, null);
    });

    it('parses !bookcourt poll args with duration while ignoring direct !bookcourt time commands', () => {
      const direct = parseBookPollCourtsArgs('!bookcourt 9am tomorrow 60min');
      assert.equal(direct, null);

      const pollArg1 = parseBookPollCourtsArgs('!bookcourt poll_123 60min');
      assert.equal(pollArg1.target, 'poll_123');
      assert.equal(pollArg1.bookingDuration, 60);

      const pollArg2 = parseBookPollCourtsArgs('!bookcourt --poll rec_1 Court 3 --duration=1h');
      assert.equal(pollArg2.target, 'rec_1');
      assert.equal(pollArg2.specificCourt, 'Court 3');
      assert.equal(pollArg2.bookingDuration, 60);
    });
  });

  describe('Court availability checks, booking, poll creation, and precedence', () => {
    const testChatId = '120363403838804497@g.us';
    let origCheckAvail;
    let origGetBookings;
    let origBookCourt;
    let origModifyCourt;
    let origConfig;
    let bookCalls;
    let modifyCalls;

    function createMockSock() {
      const sent = [];
      return {
        sent,
        user: { id: 'tenbot@s.whatsapp.net' },
        groupMetadata: async () => ({
          participants: [{ id: 'admin@s.whatsapp.net', admin: 'admin' }]
        }),
        sendMessage: async (jid, payload) => {
          const id = `poll_${sent.length + 1}`;
          const msg = { key: { id, remoteJid: jid }, message: payload };
          sent.push({ jid, payload, msg });
          return msg;
        }
      };
    }

    beforeEach(() => {
      origCheckAvail = scvcc.checkCourtAvailability;
      origGetBookings = scvcc.getCourtBookings;
      origBookCourt = scvcc.bookCourt;
      origModifyCourt = scvcc.modifyCourtBooking;
      origConfig = JSON.parse(JSON.stringify(groupsConfig.loadRawConfig() || {}));
      bookCalls = [];
      modifyCalls = [];

      // Default SCVCC mock: Court 1 only has 60 minutes open!
      scvcc.checkCourtAvailability = async () => ({
        slots: [{
          courts: [{ court: 'Court 1', status: 'available', availableMinutes: 60 }]
        }]
      });
      scvcc.getCourtBookings = async () => ({ bookings: [] });
      scvcc.bookCourt = async (opts) => {
        if ((opts.minAvailableMinutes || 90) > 60) {
          return {
            success: false,
            message: `No court available with at least ${opts.minAvailableMinutes} minutes open.`
          };
        }
        bookCalls.push(opts);
        return {
          success: true,
          reservationId: `res_${bookCalls.length}`,
          court: opts.court || 'Court 1',
          time: opts.time,
          duration: opts.duration || '90 Minutes',
          players: opts.players || ['Pramod Immaneni', 'Kejal Patel']
        };
      };
      scvcc.modifyCourtBooking = async (opts) => {
        modifyCalls.push(opts);
        return {
          success: true,
          court: opts.court || 'Court 1',
          time: opts.time || '9:00 AM',
          date: opts.date || '11/10/2026',
          duration: opts.duration || '60 Minutes',
          message: 'Modified'
        };
      };
    });

    afterEach(() => {
      scvcc.checkCourtAvailability = origCheckAvail;
      scvcc.getCourtBookings = origGetBookings;
      scvcc.bookCourt = origBookCourt;
      scvcc.modifyCourtBooking = origModifyCourt;
      groupsConfig.saveRawConfig(origConfig);
    });

    it('accepts a 60-minute court in createMatchPoll when bookingDuration=60 and rejects it under default 90', async () => {
      const sock = createMockSock();
      const context90 = {
        activePolls: new Map(),
        messageStore: new Map(),
        latestPollIdByChat: new Map(),
        persistPolls: () => {}
      };
      const res90 = await pollCommands.createMatchPoll(
        sock, testChatId, 4, 'Tomorrow 9am', 'tomorrow', '9am',
        'Admin', 'admin@s.whatsapp.net', true, null, false, true, false,
        true, false, false, null, null, 'none', null, null, null, null,
        context90, { courtsStrategy: 'lookup' }
      );
      assert.ok(res90.err);
      assert.equal(res90.noCourtsAvailable, true);

      const context60 = {
        activePolls: new Map(),
        messageStore: new Map(),
        latestPollIdByChat: new Map(),
        persistPolls: () => {}
      };
      const res60 = await pollCommands.createMatchPoll(
        sock, testChatId, 4, 'Tomorrow 9am', 'tomorrow', '9am',
        'Admin', 'admin@s.whatsapp.net', true, null, false, true, false,
        true, false, false, null, null, 'pre-book', null, 1, null, null,
        context60, { courtsStrategy: 'book', bookingDuration: 60 }
      );
      assert.equal(res60.err, null);
      assert.equal(res60.bookingDuration, 60);
      assert.equal(bookCalls.length, 1);
      assert.equal(bookCalls[0].duration, '60 Minutes');
      assert.equal(bookCalls[0].minAvailableMinutes, 60);

      const savedState = [...context60.activePolls.values()][0];
      assert.equal(savedState.bookingDuration, 60);
    });

    it('follows precedence: poll override > schedule > group default > 90', async () => {
      const sock = createMockSock();
      groupsConfig.updateGroupConfig('Bot-testing', { bookingDuration: 120 });

      const recurringPolls = new Map([
        ['rec_prec', { id: 'rec_prec', remoteJid: testChatId, bookingDuration: 60 }]
      ]);

      // Group default = 120, schedule = 60 -> 60 wins (passes check for 60m court)
      const ctxSched = {
        activePolls: new Map(),
        messageStore: new Map(),
        latestPollIdByChat: new Map(),
        recurringPolls,
        persistPolls: () => {}
      };
      const resSched = await pollCommands.createMatchPoll(
        sock, testChatId, 4, 'Tomorrow 9am', 'tomorrow', '9am',
        'Admin', 'admin@s.whatsapp.net', true, null, false, true, false,
        true, false, true, 'rec_prec', null, 'none', null, null, null, null,
        ctxSched, { courtsStrategy: 'lookup' }
      );
      assert.equal(resSched.err, null);
      assert.equal(resSched.bookingDuration, 60);

      // Explicit poll override 90 overrides schedule=60 -> fails against 60m court
      const ctxExplicit = {
        activePolls: new Map(),
        messageStore: new Map(),
        latestPollIdByChat: new Map(),
        recurringPolls,
        persistPolls: () => {}
      };
      const resExplicit = await pollCommands.createMatchPoll(
        sock, testChatId, 4, 'Tomorrow 9am', 'tomorrow', '9am',
        'Admin', 'admin@s.whatsapp.net', true, null, false, true, false,
        true, false, true, 'rec_prec', null, 'none', null, null, null, null,
        ctxExplicit, { courtsStrategy: 'lookup', bookingDuration: 90 }
      );
      assert.ok(resExplicit.err);
      assert.equal(resExplicit.noCourtsAvailable, true);
    });

    it('passes bookingDuration in createMultiTimePoll', async () => {
      const sock = createMockSock();
      const context = {
        activePolls: new Map(),
        messageStore: new Map(),
        latestPollIdByChat: new Map(),
        persistPolls: () => {}
      };
      const res = await pollCommands.createMatchPoll(
        sock, testChatId, null, 'Tomorrow 8am, 9:30am', 'tomorrow', null,
        'Admin', 'admin@s.whatsapp.net', true, null, false, true, false,
        true, false, false, null, null, 'none', null, null, null, null,
        context, {
          courtsStrategy: 'lookup',
          bookingDuration: 60,
          timeSlots: [
            { dayWord: 'tomorrow', timeWord: '8am', timeDisplay: '8:00 AM', hour: 8, minute: 0, size: 4 },
            { dayWord: 'tomorrow', timeWord: '9:30am', timeDisplay: '9:30 AM', hour: 9, minute: 30, size: 4 }
          ]
        }
      );
      assert.equal(res.err, null);
      assert.equal(res.isMultiTime, true);
      assert.equal(res.bookingDuration, 60);
      const savedState = [...context.activePolls.values()][0];
      assert.equal(savedState.bookingDuration, 60);
    });

    it('uses bookingDuration in handleBookPollCourts and handleOnDemandCourtBooking', async () => {
      const sock = createMockSock();
      const activePolls = new Map([
        ['poll_bk_1', {
          id: 'poll_bk_1',
          remoteJid: testChatId,
          when: 'Tomorrow 9am',
          queryTime: '9am',
          targetDateMDY: '11/10/2026',
          size: 8,
          status: 'active',
          bookingDuration: 60,
          creator: { name: 'Admin', jid: 'admin@s.whatsapp.net' },
          prebookedCourts: [{ court: 'Court 2', time: '9:00 AM', bookingType: 'auto' }],
          autoBookedCourts: [{ court: 'Court 2', reservationId: '100', time: '9:00 AM', duration: '60 Minutes' }],
          advanceBookedCourts: [{ court: 'Court 2', reservationId: '100', time: '9:00 AM', duration: '60 Minutes' }],
          unbookedCourts: [{ court: 'Court 1', time: '9am' }]
        }]
      ]);
      const context = {
        activePolls,
        messageStore: new Map(),
        persistPolls: () => {}
      };

      const msg = await handleBookPollCourts(sock, testChatId, 'Admin', 'admin@s.whatsapp.net', 'poll_bk_1 1', context);
      assert.match(msg, /Booked 1 additional court/);
      assert.equal(bookCalls.length, 1);
      assert.equal(bookCalls[0].duration, '60 Minutes');
      assert.equal(bookCalls[0].minAvailableMinutes, 60);

      // Now test explicit override to 120 fails cleanly if only 60 mins open
      const msg120 = await handleBookPollCourts(sock, testChatId, 'Admin', 'admin@s.whatsapp.net', 'poll_bk_1 1 2h', context);
      assert.match(msg120, /at least 120 minutes open/);

      // Test on-demand booking honors pollState.bookingDuration=60
      bookCalls.length = 0;
      const onDemandState = {
        id: 'poll_od_1',
        remoteJid: testChatId,
        when: 'Tomorrow 9am',
        queryTime: '9am',
        targetDateMDY: '11/10/2026',
        size: 4,
        status: 'active',
        bookingDuration: 60,
        prebookedCourts: [],
        advanceBookedCourts: [],
        unbookedCourts: [{ court: 'Court 1', time: '9am' }],
        tentativeCourts: []
      };
      await handleOnDemandCourtBooking(sock, 'poll_od_1', onDemandState, [], () => {});
      assert.equal(bookCalls.length, 1);
      assert.equal(bookCalls[0].duration, '60 Minutes');
      assert.equal(bookCalls[0].minAvailableMinutes, 60);
    });

    it('updates bookingDuration and SCVCC reservations in handleModifyPollInstance', async () => {
      const sock = createMockSock();
      const pollState = {
        id: 'poll_mod_1',
        remoteJid: testChatId,
        when: 'Tomorrow 9am',
        size: 4,
        status: 'active',
        bookingDuration: 90,
        creator: { name: 'Admin', jid: 'admin@s.whatsapp.net' },
        advanceBookedCourts: [
          { court: 'Court 1', reservationId: 'res_mod_1', time: '9:00 AM', duration: '90 Minutes' }
        ]
      };
      const context = {
        activePolls: new Map([['poll_mod_1', pollState]]),
        recurringPolls: new Map(),
        messageStore: new Map(),
        persistPolls: () => {}
      };

      const parsedMod = pollCommands.parseModifyInstanceCommand('!modifyinstance poll_mod_1 --booking-duration=60m');
      assert.equal(parsedMod.targetId, 'poll_mod_1');
      assert.equal(parsedMod.updates.bookingDuration, 60);

      const resMsg = await pollCommands.handleModifyPollInstance(
        sock, testChatId, 'Admin', 'admin@s.whatsapp.net',
        parsedMod.targetId, parsedMod.updates, context
      );
      assert.match(resMsg, /Booking duration:\s*\*60 mins\*/);
      assert.equal(pollState.bookingDuration, 60);
      assert.equal(modifyCalls.length, 1);
      assert.equal(modifyCalls[0].reservationId, 'res_mod_1');
      assert.equal(modifyCalls[0].duration, '60 Minutes');
      assert.equal(pollState.advanceBookedCourts[0].duration, '60 Minutes');

      const invalidRes = await pollCommands.handleModifyPollInstance(
        sock, testChatId, 'Admin', 'admin@s.whatsapp.net',
        'poll_mod_1', { bookingDuration: '45m' }, context
      );
      assert.match(invalidRes, /Unsupported booking duration/);
    });
  });

  describe('Recurring schedule CRUD, manual detection, and advance booking', () => {
    const testChatId = '120363403838804497@g.us';
    let origCheckAvail;
    let origGetBookings;

    beforeEach(() => {
      origCheckAvail = scvcc.checkCourtAvailability;
      origGetBookings = scvcc.getCourtBookings;
    });
    afterEach(() => {
      scvcc.checkCourtAvailability = origCheckAvail;
      scvcc.getCourtBookings = origGetBookings;
    });

    it('creates, formats, modifies, and clears bookingDuration on recurring schedules and syncs active polls', async () => {
      const recurringPolls = new Map();
      const activePolls = new Map();
      let persisted = 0;
      const persistPolls = () => { persisted++; };

      const invalidCreate = await recurringPollsModule.scheduleRecurringPoll({
        recurringPolls, persistPolls, targetChatId: testChatId,
        sender: 'Admin', senderJid: 'admin@s.whatsapp.net',
        params: { matchTime: '7pm', size: 4, bookingDuration: '45m' }
      });
      assert.match(invalidCreate, /Unsupported booking duration/);
      assert.equal(recurringPolls.size, 0);

      const createdText = await recurringPollsModule.scheduleRecurringPoll({
        recurringPolls, persistPolls, targetChatId: testChatId,
        sender: 'Admin', senderJid: 'admin@s.whatsapp.net',
        params: { matchTime: '7pm', size: 4, bookingDuration: '60m' }
      });
      assert.match(createdText, /Booking Duration:\*\s*60 mins/);
      assert.equal(recurringPolls.size, 1);
      const [schedId, sched] = [...recurringPolls.entries()][0];
      assert.equal(sched.bookingDuration, 60);

      activePolls.set('poll_rec_sync', {
        id: 'poll_rec_sync',
        remoteJid: testChatId,
        scheduleId: schedId,
        status: 'active',
        bookingDuration: 60
      });

      const modText = await recurringPollsModule.modifyRecurringPoll({
        recurringPolls, persistPolls, activePolls,
        sender: 'Admin', scheduleId: schedId,
        updates: { bookingDuration: '2h' }
      });
      assert.match(modText, /Booking Duration:\s*\*120 mins\*/);
      assert.equal(sched.bookingDuration, 120);
      assert.equal(activePolls.get('poll_rec_sync').bookingDuration, 120);

      const resetText = await recurringPollsModule.modifyRecurringPoll({
        recurringPolls, persistPolls, activePolls,
        sender: 'Admin', scheduleId: schedId,
        updates: { bookingDuration: 'default' }
      });
      assert.match(resetText, /Default/);
      assert.equal(sched.bookingDuration, undefined);
      assert.equal(activePolls.get('poll_rec_sync').bookingDuration, undefined);
      assert.ok(persisted >= 3);
    });

    it('detectManualPlayerBookings honors minDurationMins and checkAndExecuteAdvanceBookings forwards bookingDuration', async () => {
      scvcc.checkCourtAvailability = async () => ({
        slots: [{
          courts: [{ court: 'Court 1', status: 'prebooked', durationMins: 60, availableMinutes: 60, prebookedBy: 'Alice' }]
        }]
      });
      scvcc.getCourtBookings = async () => ({
        bookings: [{ court: 'Court 2', durationMins: 60, status: 'Booked', players: ['Bob'], rawText: 'Bob' }]
      });

      const ignoredUnder90 = await recurringPollsModule.detectManualPlayerBookings({
        remoteJid: testChatId, targetDateMDY: '11/10/2026', queryTime: '9am', minDurationMins: 90
      });
      assert.equal(ignoredUnder90.length, 0);

      const foundUnder60 = await recurringPollsModule.detectManualPlayerBookings({
        remoteJid: testChatId, targetDateMDY: '11/10/2026', queryTime: '9am', minDurationMins: 60
      });
      assert.equal(foundUnder60.length, 1);
      assert.equal(foundUnder60[0].court, 'Court 1');

      // Clear manual bookings so advance booking calls preBookCourtsForMatch
      scvcc.checkCourtAvailability = async () => ({ slots: [{ courts: [] }] });
      scvcc.getCourtBookings = async () => ({ bookings: [] });

      const preBookCalls = [];
      const recurringPolls = new Map([
        ['rec_adv_60', {
          id: 'rec_adv_60',
          remoteJid: testChatId,
          enabled: true,
          size: 4,
          matchTime: '7pm',
          matchHour: 19,
          matchMinute: 0,
          postTime: '8am',
          postHour: 8,
          postMinute: 0,
          days: 'everyday',
          daysList: [0, 1, 2, 3, 4, 5, 6],
          bookingStrategy: 'advanced',
          bookingSchedule: '-7days 7:00AM',
          courtsStrategy: 'book',
          bookingDuration: 60,
          advanceBookings: {}
        }]
      ]);

      await recurringPollsModule.checkAndExecuteAdvanceBookings({
        sock: { sendMessage: async () => ({}) },
        recurringPolls,
        persistPolls: () => {},
        customSanJoseParts: { year: 2026, month: 10, day: 10, weekday: 'tue', hour: 9, minute: 0 },
        preBookCourtsForMatch: async (opts) => {
          preBookCalls.push(opts);
          return {
            advanceBookedCourts: [{ court: 'Court 3', reservationId: 'r1', time: '7:00 PM', duration: '60 Minutes' }],
            prebookedCourts: [{ court: 'Court 3', time: '7:00 PM' }]
          };
        }
      });

      assert.ok(preBookCalls.length > 0);
      assert.equal(preBookCalls[0].bookingDuration, 60);
      assert.equal(preBookCalls[0].minAvailableMinutes, 60);
    });

    it('forwards bookingDuration via AI tools executePollTool & executeRecurringTool', async () => {
      const recurringPolls = new Map();
      const context = {
        activePolls: new Map(),
        recurringPolls,
        messageStore: new Map(),
        latestPollIdByChat: new Map(),
        persistPolls: () => {}
      };
      const mockSock = {
        user: { id: 'tenbot@s.whatsapp.net' },
        groupMetadata: async () => ({ participants: [{ id: 'admin@s.whatsapp.net', admin: 'admin' }] }),
        sendMessage: async () => ({ key: { id: 'm1', remoteJid: testChatId } })
      };

      const badToolRes = await pollCommands.executePollTool(
        mockSock, 'simulate_poll',
        { when: 'tomorrow 9am', size: 4, bookingDuration: '45m' },
        'Admin', 'admin@s.whatsapp.net', testChatId, null, context
      );
      assert.match(badToolRes, /Unsupported booking duration/);

      const recRes = await recurringCommands.executeRecurringTool(
        mockSock, 'schedule_recurring_poll',
        { matchTime: '7pm', size: 4, bookingDuration: '60m', group: testChatId },
        'Admin', 'admin@s.whatsapp.net', 'admin@s.whatsapp.net', context
      );
      assert.match(recRes, /Booking Duration:\*\s*60 mins/);
    });
  });
});
