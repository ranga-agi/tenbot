const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  parseDaysOfWeek,
  extractCommonFlags,
  extractSkipArgs,
  extractPauseArgs,
  parseRecurringPollText,
  isPollCreatedForMatchDate,
  detectManualPlayerBookings,
  checkAndExecuteAdvanceBookings,
  checkAndPostRecurringPolls
} = require('../lib/recurringPolls');
const scvcc = require('../lib/scvcc');
const pollTime = require('../lib/pollTime');
const pollCommands = require('../lib/commands/poll');
const recurringPollsModule = require('../lib/recurringPolls');

describe('recurringPolls', () => {
  describe('parseDaysOfWeek', () => {
    it('should parse "everyday"', () => {
      const res = parseDaysOfWeek('everyday');
      assert.ok(res);
      assert.deepEqual(res.days, [0, 1, 2, 3, 4, 5, 6]);
    });

    it('should parse "weekdays"', () => {
      const res = parseDaysOfWeek('weekdays');
      assert.ok(res);
      assert.deepEqual(res.days, [1, 2, 3, 4, 5]);
    });

    it('should parse "weekends"', () => {
      const res = parseDaysOfWeek('weekends');
      assert.ok(res);
      assert.deepEqual(res.days, [0, 6]);
    });

    it('should parse day range "mon-thu"', () => {
      const res = parseDaysOfWeek('mon-thu');
      assert.ok(res);
      assert.deepEqual(res.days, [1, 2, 3, 4]);
    });

    it('should parse comma-separated days "mon,wed,fri"', () => {
      const res = parseDaysOfWeek('mon,wed,fri');
      assert.ok(res);
      assert.deepEqual(res.days, [1, 3, 5]);
    });
  });

  describe('extractCommonFlags', () => {
    it('should extract --max-courts flag', () => {
      const res1 = extractCommonFlags('auto 7pm mon-thu --max-courts=3');
      assert.equal(res1.flags.maxCourts, 3);
      assert.match(res1.remainingText, /auto 7pm mon-thu/);

      const res2 = extractCommonFlags('auto 7pm mon-thu --max-courts 4');
      assert.equal(res2.flags.maxCourts, 4);

      const res3 = extractCommonFlags('auto 7pm mon-thu max-courts=2');
      assert.equal(res3.flags.maxCourts, 2);
    });

    it('should extract --courts-strategy=book and set booking & lookup flags', () => {
      const text = '8 Mon-Thu 7pm --no-matchups --courts-strategy=book --pre-book-courts=2';
      const { flags, remainingText } = extractCommonFlags(text);

      assert.equal(flags.lineupGeneration, 'none');
      assert.equal(flags.noMatchups, undefined);
      assert.equal(flags.courtsStrategy, 'book');
      assert.equal(flags.checkCourts, true);
      assert.equal(flags.courtBookingType, 'pre-book');
      assert.equal(flags.preBookCourts, 2);
      assert.match(remainingText, /8 Mon-Thu 7pm/);
    });

    it('should extract --courts-strategy=lookup and --courts-strategy=none and drop old flags', () => {
      const textLookup = '8 Mon-Thu 7pm --courts-strategy=lookup';
      const resLookup = extractCommonFlags(textLookup);
      assert.equal(resLookup.flags.courtsStrategy, 'lookup');
      assert.equal(resLookup.flags.checkCourts, true);
      assert.equal(resLookup.flags.courtBookingType, 'none');

      const textNone = '8 Mon-Thu 7pm --courts-strategy=none';
      const resNone = extractCommonFlags(textNone);
      assert.equal(resNone.flags.courtsStrategy, 'none');
      assert.equal(resNone.flags.checkCourts, false);
      assert.equal(resNone.flags.courtBookingType, 'none');

      // Old flags --courts, --court-booking-type should not be recognized
      const textOld = '8 Mon-Thu 7pm --courts --court-booking-type=pre-book';
      const resOld = extractCommonFlags(textOld);
      assert.equal(resOld.flags.courtsStrategy, undefined);
      assert.equal(resOld.flags.checkCourts, undefined);
      assert.equal(resOld.flags.courtBookingType, undefined);
    });

    it('should extract --pre-allocate-slots flag', () => {
      const text = 'auto 7pm mon-thu --pre-allocate-slots';
      const { flags, remainingText } = extractCommonFlags(text);
      assert.equal(flags.includePrebookedSpots, true);
      assert.equal(flags['--pre-allocate-slots'], true);
      assert.equal(flags['pre-allocate-slots'], true);
      assert.match(remainingText, /auto 7pm mon-thu/);
    });

    it('should extract --no-pre-allocate-slots flag', () => {
      const text = 'auto 7pm mon-thu --no-pre-allocate-slots';
      const { flags, remainingText } = extractCommonFlags(text);
      assert.equal(flags.includePrebookedSpots, false);
      assert.equal(flags['--pre-allocate-slots'], false);
      assert.equal(flags['pre-allocate-slots'], false);
    });

    it('should extract --reminders and --no-reminders flags', () => {
      const res1 = extractCommonFlags('auto 7pm mon-thu --reminders');
      assert.equal(res1.flags.reminders, true);
      assert.match(res1.remainingText, /auto 7pm mon-thu/);

      const res2 = extractCommonFlags('auto 7pm mon-thu --no-reminders');
      assert.equal(res2.flags.reminders, false);
      assert.match(res2.remainingText, /auto 7pm mon-thu/);

      const res3 = extractCommonFlags('auto 7pm mon-thu --reminders=off');
      assert.equal(res3.flags.reminders, false);

      const res4 = extractCommonFlags('auto 7pm mon-thu --reminders=on');
      assert.equal(res4.flags.reminders, true);
    });
  });

  describe('extractSkipArgs', () => {
    it('should extract schedule ID and target date from skip args', () => {
      const res = extractSkipArgs('rec_test 2026-10-05');
      assert.equal(res.scheduleId, 'rec_test');
      assert.equal(res.targetDayOrDate, '2026-10-05');
    });

    it('should extract count when number is passed', () => {
      const res = extractSkipArgs('rec_test 2');
      assert.equal(res.scheduleId, 'rec_test');
      assert.equal(res.count, 2);
    });
  });

  describe('extractPauseArgs', () => {
    it('should extract schedule ID and untilDate', () => {
      const res = extractPauseArgs('rec_test until 2026-10-25');
      assert.equal(res.scheduleId, 'rec_test');
      assert.equal(res.untilDate, '2026-10-25');
    });
  });

  describe('parseRecurringPollText', () => {
    it('should parse --max-courts in recurring poll creation and modification', () => {
      const parsedCreate = parseRecurringPollText('!recurringpoll auto 7pm mon-thu --max-courts=3');
      assert.ok(parsedCreate);
      assert.equal(parsedCreate.maxCourts, 3);

      const parsedMod = parseRecurringPollText('!modifyrecurringpoll rec_1 --max-courts=4');
      assert.ok(parsedMod);
      assert.equal(parsedMod.updates.maxCourts, 4);

      const parsedModNone = parseRecurringPollText('!modifyrecurringpoll rec_1 --max-courts=none');
      assert.ok(parsedModNone);
      assert.equal(parsedModNone.updates.maxCourts, null);

      const parsedModOther = parseRecurringPollText('!modifyrecurringpoll rec_1 7:30pm');
      assert.ok(parsedModOther);
      assert.equal(parsedModOther.updates.maxCourts, undefined);
    });

    it('should display Max Courts in recurring schedule card and preserve it when modifying other fields', async () => {
      const { scheduleRecurringPoll, modifyRecurringPoll, listRecurringPolls } = require('../lib/recurringPolls');
      const recurringPolls = new Map();
      const parsedCreate = parseRecurringPollText('!recurringpoll auto 7pm mon-thu --max-courts=3');
      const createMsg = await scheduleRecurringPoll({
        recurringPolls,
        persistPolls: () => {},
        targetChatId: 'group1@g.us',
        sender: 'Pramod',
        senderJid: 'pramod@lid',
        params: parsedCreate
      });
      assert.match(createMsg, /• \*Max Courts:\* 3/);

      const schedId = [...recurringPolls.keys()][0];
      const parsedMod = parseRecurringPollText(`!modifyrecurringpoll ${schedId} 7:30pm`);
      const modMsg = await modifyRecurringPoll({
        recurringPolls,
        persistPolls: () => {},
        sender: 'Pramod',
        scheduleId: schedId,
        updates: parsedMod.updates
      });
      assert.match(modMsg, /• \*Max Courts:\* 3/);

      const listMsg = listRecurringPolls({ recurringPolls, chatId: 'group1@g.us' });
      assert.match(listMsg, /• \*Max Courts:\* 3/);
    });

    it('should parse recurring poll creation command', () => {
      const parsed = parseRecurringPollText('!recurringpoll 8 Mon-Thu 7pm at 1:15pm');
      assert.ok(parsed);
      assert.equal(parsed.size, 8);
      assert.equal(parsed.matchTime, '7pm');
      assert.equal(parsed.days.toLowerCase(), 'mon-thu');
    });

    it('should parse --pre-allocate-slots in recurring poll command', () => {
      const parsed = parseRecurringPollText('!recurringpoll auto 7pm mon-thu --pre-allocate-slots');
      assert.ok(parsed);
      assert.equal(parsed.includePrebookedSpots, true);
      assert.equal(parsed['--pre-allocate-slots'], true);
      assert.equal(parsed['pre-allocate-slots'], true);
    });

    it('should default reminders to true in recurring poll command, or false if --no-reminders is passed', () => {
      const parsedDefault = parseRecurringPollText('!recurringpoll auto 7pm mon-thu');
      assert.ok(parsedDefault);
      assert.equal(parsedDefault.reminders, true);

      const parsedNoRemind = parseRecurringPollText('!recurringpoll auto 7pm mon-thu --no-reminders');
      assert.ok(parsedNoRemind);
      assert.equal(parsedNoRemind.reminders, false);
    });

    it('should parse modify recurring poll command', () => {
      const parsed = parseRecurringPollText('!modifyrecurringpoll rec_1 4 6pm');
      assert.ok(parsed);
      assert.equal(parsed.action, 'modify');
      assert.equal(parsed.scheduleId, 'rec_1');
      assert.equal(parsed.updates.size, 4);
      assert.equal(parsed.updates.matchTime, '6pm');
    });

    it('should parse recurring poll list/status commands', () => {
      const parsed1 = parseRecurringPollText('!recurringpolls');
      assert.ok(parsed1);
      assert.equal(parsed1.action, 'list');

      const parsed2 = parseRecurringPollText('!recurringpoll status rec_1');
      assert.ok(parsed2);
      assert.equal(parsed2.action, 'status');
      assert.equal(parsed2.scheduleId, 'rec_1');
    });
  });

  describe('checkAndExecuteAdvanceBookings periodic checks and manual bookings', () => {
    it('should run initial attempt at scheduled time and then periodic checks at 9:30am and 3:30pm daily until completed', async () => {
      const scheduleId = 'sched_adv_test';
      const targetMatchDate = '2026-10-26'; // Monday
      const recurringPolls = new Map();
      const sched = {
        id: scheduleId,
        remoteJid: '120363402559062529@g.us',
        matchTime: '6:30PM',
        matchHour: 18,
        matchMinute: 30,
        days: 'mon',
        daysList: [1],
        size: '8', // 2 courts (8 / 4 = 2)
        enabled: true,
        bookingStrategy: 'advanced',
        bookingSchedule: '-7days 7:00AM',
        postTime: '8:15PM',
        postDaysBefore: 1
      };
      recurringPolls.set(scheduleId, sched);

      const notificationsSent = [];
      const sendBookingNotifications = async (sock, remoteJid, msg) => {
        notificationsSent.push({ remoteJid, msg });
      };

      let bookedCourtsCount = 0;
      let preBookCalls = 0;
      const preBookCourtsForMatch = async (args) => {
        preBookCalls++;
        const advCourts = Array.isArray(args.existingAdvanceBookedCourts) ? [...args.existingAdvanceBookedCourts] : [];
        const preCourts = Array.isArray(args.existingPrebookedCourts) ? [...args.existingPrebookedCourts] : [];

        // First call at 7am: books 1 court
        if (preBookCalls === 1) {
          advCourts.push({ court: 'Court 1', players: ['Player 1', 'Player 2', 'Player 3', 'Player 4'], duration: '90 Minutes' });
          preCourts.push({ court: 'Court 1', player: 'Player 1' });
        } else if (preBookCalls === 4) {
          // On 4th call (Day 2 9:30am): court 2 becomes available and is booked!
          advCourts.push({ court: 'Court 2', players: ['Player 5', 'Player 6', 'Player 7', 'Player 8'], duration: '90 Minutes' });
          preCourts.push({ court: 'Court 2', player: 'Player 5' });
        }
        return { advanceBookedCourts: advCourts, prebookedCourts: preCourts };
      };

      const originalCheckAvail = scvcc.checkCourtAvailability;
      const originalGetBookings = scvcc.getCourtBookings;
      scvcc.checkCourtAvailability = async () => ({ slots: [] });
      scvcc.getCourtBookings = async () => ({ bookings: [] });

      try {
        // Step 1: Monday Oct 19 at 7:00 AM -> Initial booking attempt
        const monday7am = { year: 2026, month: 9, day: 19, weekday: 'mon', hour: 7, minute: 0 };
        await checkAndExecuteAdvanceBookings({
          sock: {},
          recurringPolls,
          persistPolls: () => {},
          preBookCourtsForMatch,
          customSanJoseParts: monday7am,
          sendBookingNotifications
        });

        assert.equal(preBookCalls, 1);
        const entry1 = sched.advanceBookings[targetMatchDate];
        assert.ok(entry1);
        assert.equal(entry1.advanceBookedCourts.length, 1);
        assert.equal(entry1.completed, false);
        assert.equal(entry1.targetCourtsCount, 2);

        // Step 2: Monday Oct 19 at 8:00 AM -> Outside initial window & before 9:30am, no check should run
        const monday8am = { year: 2026, month: 9, day: 19, weekday: 'mon', hour: 8, minute: 0 };
        await checkAndExecuteAdvanceBookings({
          sock: {},
          recurringPolls,
          persistPolls: () => {},
          preBookCourtsForMatch,
          customSanJoseParts: monday8am,
          sendBookingNotifications
        });
        assert.equal(preBookCalls, 1); // No new call

        // Step 3: Monday Oct 19 at 9:30 AM -> Periodic check slot 1 runs
        const monday930am = { year: 2026, month: 9, day: 19, weekday: 'mon', hour: 9, minute: 30 };
        await checkAndExecuteAdvanceBookings({
          sock: {},
          recurringPolls,
          persistPolls: () => {},
          preBookCourtsForMatch,
          customSanJoseParts: monday930am,
          sendBookingNotifications
        });
        assert.equal(preBookCalls, 2);
        const entry2 = sched.advanceBookings[targetMatchDate];
        assert.ok(entry2.periodicChecks.includes('2026-10-19:09:30'));
        assert.equal(entry2.completed, false);

        // Step 4: Monday Oct 19 at 9:31 AM -> Slot 9:30am already executed, should skip
        const monday931am = { year: 2026, month: 9, day: 19, weekday: 'mon', hour: 9, minute: 31 };
        await checkAndExecuteAdvanceBookings({
          sock: {},
          recurringPolls,
          persistPolls: () => {},
          preBookCourtsForMatch,
          customSanJoseParts: monday931am,
          sendBookingNotifications
        });
        assert.equal(preBookCalls, 2); // No new call

        // Step 5: Monday Oct 19 at 3:30 PM -> Periodic check slot 2 runs
        const monday330pm = { year: 2026, month: 9, day: 19, weekday: 'mon', hour: 15, minute: 30 };
        await checkAndExecuteAdvanceBookings({
          sock: {},
          recurringPolls,
          persistPolls: () => {},
          preBookCourtsForMatch,
          customSanJoseParts: monday330pm,
          sendBookingNotifications
        });
        assert.equal(preBookCalls, 3);
        const entry3 = sched.advanceBookings[targetMatchDate];
        assert.ok(entry3.periodicChecks.includes('2026-10-19:15:30'));
        assert.equal(entry3.completed, false);

        // Step 6: Tuesday Oct 20 at 9:30 AM -> Next day periodic check runs, court 2 becomes available
        const tuesday930am = { year: 2026, month: 9, day: 20, weekday: 'tue', hour: 9, minute: 30 };
        await checkAndExecuteAdvanceBookings({
          sock: {},
          recurringPolls,
          persistPolls: () => {},
          preBookCourtsForMatch,
          customSanJoseParts: tuesday930am,
          sendBookingNotifications
        });
        assert.equal(preBookCalls, 4);
        const entry4 = sched.advanceBookings[targetMatchDate];
        assert.ok(entry4.periodicChecks.includes('2026-10-20:09:30'));
        assert.equal(entry4.advanceBookedCourts.length, 2);
        assert.equal(entry4.completed, true);
        assert.equal(notificationsSent.length, 1);
        assert.ok(notificationsSent[0].msg.includes('2 of 2 courts'));

        // Step 7: Tuesday Oct 20 at 3:30 PM -> Completed, should skip
        const tuesday330pm = { year: 2026, month: 9, day: 20, weekday: 'tue', hour: 15, minute: 30 };
        await checkAndExecuteAdvanceBookings({
          sock: {},
          recurringPolls,
          persistPolls: () => {},
          preBookCourtsForMatch,
          customSanJoseParts: tuesday330pm,
          sendBookingNotifications
        });
        assert.equal(preBookCalls, 4); // Still 4, no new call
      } finally {
        scvcc.checkCourtAvailability = originalCheckAvail;
        scvcc.getCourtBookings = originalGetBookings;
      }
    });

    it('should account for manual player bookings and mark completed when target count is reached', async () => {
      const scheduleId = 'sched_manual_test';
      const targetMatchDate = '2026-10-26';
      const recurringPolls = new Map();
      const sched = {
        id: scheduleId,
        remoteJid: '120363402559062529@g.us',
        matchTime: '6:30PM',
        matchHour: 18,
        matchMinute: 30,
        days: 'mon',
        daysList: [1],
        size: '8', // 2 courts
        enabled: true,
        bookingStrategy: 'advanced',
        bookingSchedule: '-7days 7:00AM',
        postTime: '8:15PM',
        postDaysBefore: 1
      };
      recurringPolls.set(scheduleId, sched);

      const notificationsSent = [];
      const sendBookingNotifications = async (sock, remoteJid, msg) => {
        notificationsSent.push({ remoteJid, msg });
      };

      let preBookCalls = 0;
      const preBookCourtsForMatch = async (args) => {
        preBookCalls++;
        const advCourts = Array.isArray(args.existingAdvanceBookedCourts) ? [...args.existingAdvanceBookedCourts] : [];
        const preCourts = Array.isArray(args.existingPrebookedCourts) ? [...args.existingPrebookedCourts] : [];
        if (preBookCalls === 1) {
          advCourts.push({ court: 'Court 1', players: ['Player 1', 'Player 2'], duration: '90 Minutes' });
          preCourts.push({ court: 'Court 1', player: 'Player 1' });
        }
        return { advanceBookedCourts: advCourts, prebookedCourts: preCourts };
      };

      const originalCheckAvail = scvcc.checkCourtAvailability;
      const originalGetBookings = scvcc.getCourtBookings;
      const originalDetectPrebooked = scvcc.detectPrebookedCourt;

      try {
        // At 7am on Oct 19: bot books Court 1
        scvcc.checkCourtAvailability = async () => ({ slots: [] });
        scvcc.getCourtBookings = async () => ({ bookings: [] });

        const monday7am = { year: 2026, month: 9, day: 19, weekday: 'mon', hour: 7, minute: 0 };
        await checkAndExecuteAdvanceBookings({
          sock: {},
          recurringPolls,
          persistPolls: () => {},
          preBookCourtsForMatch,
          customSanJoseParts: monday7am,
          sendBookingNotifications
        });

        assert.equal(preBookCalls, 1);
        assert.equal(sched.advanceBookings[targetMatchDate].completed, false);

        // Before 9:30am: a player manually booked Court 2 on SCVCC
        scvcc.getCourtBookings = async () => ({
          bookings: [
            {
              court: 'Court 2',
              time: '6:30 PM',
              durationMins: 90,
              players: ['Vijay Parthasarathy', 'Vishal Singh']
            }
          ]
        });
        scvcc.detectPrebookedCourt = (booking) => {
          if (booking.court === 'Court 2') {
            return { isPrebooked: true, player: 'Vijay', fullName: 'Vijay Parthasarathy' };
          }
          return null;
        };

        // At 9:30am: periodic check detects player booking for Court 2
        const monday930am = { year: 2026, month: 9, day: 19, weekday: 'mon', hour: 9, minute: 30 };
        await checkAndExecuteAdvanceBookings({
          sock: {},
          recurringPolls,
          persistPolls: () => {},
          preBookCourtsForMatch,
          customSanJoseParts: monday930am,
          sendBookingNotifications
        });

        // preBookCourtsForMatch was NOT called because manual booking completed the count!
        assert.equal(preBookCalls, 1);
        const entry = sched.advanceBookings[targetMatchDate];
        assert.equal(entry.completed, true);
        assert.equal(entry.advanceBookedCourts.length, 1);
        assert.ok(entry.prebookedCourts.some(c => c.court === 'Court 2'));
        // No new court was booked by the bot during periodic checking, so NO summary notification is sent
        assert.equal(notificationsSent.length, 0);
      } finally {
        scvcc.checkCourtAvailability = originalCheckAvail;
        scvcc.getCourtBookings = originalGetBookings;
        scvcc.detectPrebookedCourt = originalDetectPrebooked;
      }
    });

    it('should not send summary booking notification during periodic checking if no new courts were booked by the bot', async () => {
      const scheduleId = 'sched_no_new_courts_test';
      const targetMatchDate = '2026-10-26';
      const recurringPolls = new Map();
      const sched = {
        id: scheduleId,
        remoteJid: '120363402559062529@g.us',
        matchTime: '6:30PM',
        matchHour: 18,
        matchMinute: 30,
        days: 'mon',
        daysList: [1],
        size: '8', // 2 courts
        enabled: true,
        bookingStrategy: 'advanced',
        bookingSchedule: '-7days 7:00AM',
        postTime: '8:15PM',
        postDaysBefore: 1,
        advanceBookings: {
          [targetMatchDate]: {
            advanceBookedCourts: [{ court: 'Court 1', players: ['P1', 'P2'] }],
            prebookedCourts: [{ court: 'Court 1', player: 'P1' }],
            firstAttemptAt: Date.now() - 3600000,
            lastAttemptAt: Date.now() - 3600000,
            completed: false,
            targetCourtsCount: 2,
            periodicChecks: []
          }
        }
      };
      recurringPolls.set(scheduleId, sched);

      const notificationsSent = [];
      const sendBookingNotifications = async (sock, remoteJid, msg) => {
        notificationsSent.push({ remoteJid, msg });
      };

      // preBookCourtsForMatch returns no new courts booked
      const preBookCourtsForMatch = async (args) => {
        return {
          advanceBookedCourts: args.existingAdvanceBookedCourts,
          prebookedCourts: args.existingPrebookedCourts
        };
      };

      const originalCheckAvail = scvcc.checkCourtAvailability;
      const originalGetBookings = scvcc.getCourtBookings;
      scvcc.checkCourtAvailability = async () => ({ slots: [] });
      scvcc.getCourtBookings = async () => ({ bookings: [] });

      try {
        const monday930am = { year: 2026, month: 9, day: 19, weekday: 'mon', hour: 9, minute: 30 };
        await checkAndExecuteAdvanceBookings({
          sock: {},
          recurringPolls,
          persistPolls: () => {},
          preBookCourtsForMatch,
          customSanJoseParts: monday930am,
          sendBookingNotifications
        });

        // Periodic check executed
        assert.ok(sched.advanceBookings[targetMatchDate].periodicChecks.includes('2026-10-19:09:30'));
        // No new court booked -> NO summary notification sent
        assert.equal(notificationsSent.length, 0);
      } finally {
        scvcc.checkCourtAvailability = originalCheckAvail;
        scvcc.getCourtBookings = originalGetBookings;
      }
    });

        it('should stop checking once the poll is created', async () => {
      const scheduleId = 'sched_poll_created_test';
      const targetMatchDate = '2026-10-26';
      const recurringPolls = new Map();
      const sched = {
        id: scheduleId,
        remoteJid: '120363402559062529@g.us',
        matchTime: '6:30PM',
        matchHour: 18,
        matchMinute: 30,
        days: 'mon',
        daysList: [1],
        size: '8', // 2 courts
        enabled: true,
        bookingStrategy: 'advanced',
        bookingSchedule: '-7days 7:00AM',
        postTime: '8:15PM',
        postDaysBefore: 1,
        postedMatchDates: [targetMatchDate] // Poll was already created!
      };
      recurringPolls.set(scheduleId, sched);

      let preBookCalls = 0;
      const preBookCourtsForMatch = async () => {
        preBookCalls++;
        return { advanceBookedCourts: [], prebookedCourts: [] };
      };

      assert.equal(isPollCreatedForMatchDate(sched, targetMatchDate), true);

      // Sweep at 9:30am on Monday Oct 19
      const monday930am = { year: 2026, month: 9, day: 19, weekday: 'mon', hour: 9, minute: 30 };
      await checkAndExecuteAdvanceBookings({
        sock: {},
        recurringPolls,
        persistPolls: () => {},
        preBookCourtsForMatch,
        customSanJoseParts: monday930am
      });

      assert.equal(preBookCalls, 0); // No check run because poll is already created
    });

    it('should ignore manual bookings with less than 90 minutes availability', async () => {
      const originalCheckAvail = scvcc.checkCourtAvailability;
      const originalGetBookings = scvcc.getCourtBookings;
      const originalDetectPrebooked = scvcc.detectPrebookedCourt;

      try {
        scvcc.checkCourtAvailability = async () => ({ slots: [] });
        scvcc.getCourtBookings = async () => ({
          bookings: [
            { court: 'Court 1', durationMins: 60, players: ['Player A'] },
            { court: 'Court 2', durationMins: 90, players: ['Player B'] }
          ]
        });
        scvcc.detectPrebookedCourt = (b) => ({
          isPrebooked: true,
          player: b.court === 'Court 1' ? 'A' : 'B'
        });

        const detected = await detectManualPlayerBookings({
          remoteJid: '120363402559062529@g.us',
          targetDateMDY: '10/26/2026',
          queryTime: '6:30PM'
        });

        assert.equal(detected.length, 1);
        assert.equal(detected[0].court, 'Court 2');
      } finally {
        scvcc.checkCourtAvailability = originalCheckAvail;
        scvcc.getCourtBookings = originalGetBookings;
        scvcc.detectPrebookedCourt = originalDetectPrebooked;
      }
    });
  });


  describe('pruneExpiredAdvanceBookings after match playtime passes', () => {
    it('should prune advanceBookings whose match playtime has passed and retain future ones', () => {
      const { pruneExpiredAdvanceBookings } = recurringPollsModule;
      const sched = {
        id: 'rec_prune_test',
        remoteJid: 'test@g.us',
        matchTime: '7:00 PM',
        advanceBookings: {
          '2026-11-04': {
            targetDateMDY: '11/4/2026',
            matchTime: '7:00 PM',
            autoBookedCourts: [{ court: 'Court 2', time: '7:00 PM' }]
          },
          '2026-11-06': {
            targetDateMDY: '11/6/2026',
            matchTime: '7:00 PM',
            autoBookedCourts: [{ court: 'Court 3', time: '7:00 PM' }]
          }
        }
      };

      const recurringPolls = new Map([['rec_prune_test', sched]]);
      let persistCalled = false;
      const persistPolls = () => { persistCalled = true; };

      // Current time: Nov 5th 2026 8:00 AM (Nov 4th match at 7pm has passed, Nov 6th is in future)
      const nov5Morning = { year: 2026, month: 10, day: 5, weekday: 'thu', hour: 8, minute: 0 };
      const prunedCount = pruneExpiredAdvanceBookings(recurringPolls, null, persistPolls, nov5Morning);

      assert.equal(prunedCount, 1);
      assert.equal(persistCalled, true);
      // 2026-11-04 is pruned
      assert.equal(sched.advanceBookings['2026-11-04'], undefined);
      // 2026-11-06 is kept
      assert.ok(sched.advanceBookings['2026-11-06']);
    });

    it('should prune expired advanceBookings when cleanupExpiredPolls is called', () => {
      const pollCommands = require('../lib/commands/poll');
      const sched = {
        id: 'rec_cleanup_test',
        remoteJid: 'test@g.us',
        matchTime: '6:30 PM',
        advanceBookings: {
          '2026-11-04': {
            targetDateMDY: '11/4/2026',
            matchTime: '6:30 PM'
          }
        }
      };

      const recurringPolls = new Map([['rec_cleanup_test', sched]]);
      let persistCalled = false;
      const context = {
        activePolls: new Map(),
        messageStore: new Map(),
        latestPollIdByChat: new Map(),
        recurringPolls,
        persistPolls: () => { persistCalled = true; }
      };

      // Run cleanup on Nov 5th (Nov 4th playtime has passed)
      const nov5Time = new Date('2026-11-05T12:00:00-08:00').getTime();
      pollCommands.cleanupExpiredPolls(context, nov5Time);

      assert.equal(sched.advanceBookings['2026-11-04'], undefined);
      assert.equal(persistCalled, true);
    });
  });

  describe('checkAndPostRecurringPolls retry and notification handling when no courts available', () => {
    it('should retry a couple of times before sending a single failure notification and marking handled', async () => {
      const scheduleId = 'sched_retry_test';
      const targetMatchDate = '2026-10-22';
      const recurringPolls = new Map();
      const sched = {
        id: scheduleId,
        remoteJid: '120363402559062529@g.us',
        matchTime: '7:00PM',
        matchHour: 19,
        matchMinute: 0,
        days: 'thu',
        daysList: [4],
        size: '8',
        enabled: true,
        postTime: '8:15PM',
        postHour: 20,
        postMinute: 15,
        postDaysBefore: 1
      };
      recurringPolls.set(scheduleId, sched);

      const messagesSent = [];
      const mockSock = {
        sendMessage: async (jid, content) => {
          messagesSent.push({ jid, text: content.text });
          return {};
        }
      };

      let createPollCalls = 0;
      const createMatchPoll = async () => {
        createPollCalls++;
        return {
          err: '⚠️ Cannot create poll for *Thursday 7pm*: No live or prebooked courts are available at SCVCC (all courts are reserved or blocked).',
          noCourtsAvailable: true
        };
      };

      const wednesday815pm = { year: 2026, month: 9, day: 21, weekday: 'wed', hour: 20, minute: 15 };

      // Sweep 1: Initial attempt at 8:15pm
      await checkAndPostRecurringPolls({
        sock: mockSock,
        recurringPolls,
        persistPolls: () => {},
        createMatchPoll,
        getTargetGroupJid: async () => '120363402559062529@g.us',
        customSanJoseParts: wednesday815pm
      });

      assert.equal(createPollCalls, 1);
      assert.equal(messagesSent.length, 0); // No message sent on attempt 1
      assert.equal(sched.postedMatchDates?.includes(targetMatchDate) || false, false);

      // Sweep 2: Next sweep tick (Retry 1)
      await checkAndPostRecurringPolls({
        sock: mockSock,
        recurringPolls,
        persistPolls: () => {},
        createMatchPoll,
        getTargetGroupJid: async () => '120363402559062529@g.us',
        customSanJoseParts: wednesday815pm
      });

      assert.equal(createPollCalls, 2);
      assert.equal(messagesSent.length, 0); // Still no message sent on retry 1
      assert.equal(sched.postedMatchDates?.includes(targetMatchDate) || false, false);

      // Sweep 3: Next sweep tick (Retry 2 - retries exhausted)
      await checkAndPostRecurringPolls({
        sock: mockSock,
        recurringPolls,
        persistPolls: () => {},
        createMatchPoll,
        getTargetGroupJid: async () => '120363402559062529@g.us',
        customSanJoseParts: wednesday815pm
      });

      assert.equal(createPollCalls, 3);
      assert.equal(messagesSent.length, 1); // Exactly ONE notification sent!
      assert.ok(messagesSent[0].text.includes('No live or prebooked courts are available'));
      assert.equal(sched.postedMatchDates.includes(targetMatchDate), true); // Marked posted so it stops retrying!

      // Sweep 4: Subsequent sweep tick
      await checkAndPostRecurringPolls({
        sock: mockSock,
        recurringPolls,
        persistPolls: () => {},
        createMatchPoll,
        getTargetGroupJid: async () => '120363402559062529@g.us',
        customSanJoseParts: wednesday815pm
      });

      assert.equal(createPollCalls, 3); // No new call!
      assert.equal(messagesSent.length, 1); // Still only 1 message sent!
    });
  });

  describe('look around period for court search and booking', () => {
    it('should generate candidate start times in 30-min intervals across the look around window', () => {
      assert.deepEqual(pollTime.getCandidateTimes('6:30pm', 60), ['6:30pm', '7pm', '7:30pm']);
      assert.deepEqual(pollTime.getCandidateTimes('6:30pm', '1 hour'), ['6:30pm', '7pm', '7:30pm']);
      assert.deepEqual(pollTime.getCandidateTimes('6:30pm', 30), ['6:30pm', '7pm']);
      assert.deepEqual(pollTime.getCandidateTimes('6:30pm', 0), ['6:30pm']);
      assert.deepEqual(pollTime.getCandidateTimes('7:00pm', 60), ['7pm', '7:30pm', '8pm']);
    });

    it('should extract lookAround flag from text in CLI and natural language formats', () => {
      const r1 = extractCommonFlags('4 6:30pm weekdays with look around of 1 hour');
      assert.equal(r1.flags.lookAround, 60);
      assert.equal(r1.remainingText, '4 6:30pm weekdays');

      const r2 = extractCommonFlags('4 6:30pm --look-around=1h');
      assert.equal(r2.flags.lookAround, 60);

      const r3 = extractCommonFlags('4 6:30pm look around: 30m');
      assert.equal(r3.flags.lookAround, 30);

      const r4 = extractCommonFlags('4 6:30pm', { 'look-around': '1 hour' });
      assert.equal(r4.flags.lookAround, 60);
    });

    it('should search 6:30pm, 7pm, and 7:30pm for prebooked courts when look around of 1 hour is specified', async () => {
      const originalCheckAvail = scvcc.checkCourtAvailability;
      const originalGetBookings = scvcc.getCourtBookings;
      const originalDetectPrebooked = scvcc.detectPrebookedCourt;
      const queriedTimes = [];

      try {
        scvcc.checkCourtAvailability = async ({ time }) => {
          queriedTimes.push(time);
          return { slots: [] };
        };
        scvcc.getCourtBookings = async ({ time }) => {
          if (time === '7pm') {
            return {
              bookings: [
                { court: 'Court 2', durationMins: 90, players: ['Player B'] }
              ]
            };
          }
          return { bookings: [] };
        };
        scvcc.detectPrebookedCourt = (b) => {
          if (b.court === 'Court 2') return { isPrebooked: true, player: 'B' };
          return null;
        };

        const detected = await detectManualPlayerBookings({
          remoteJid: '120363402559062529@g.us',
          targetDateMDY: '10/26/2026',
          queryTime: '6:30pm',
          lookAround: 60
        });

        assert.deepEqual(queriedTimes, ['6:30pm', '7pm', '7:30pm']);
        assert.equal(detected.length, 1);
        assert.equal(detected[0].court, 'Court 2');
        assert.equal(detected[0].time, '7pm');
      } finally {
        scvcc.checkCourtAvailability = originalCheckAvail;
        scvcc.getCourtBookings = originalGetBookings;
        scvcc.detectPrebookedCourt = originalDetectPrebooked;
      }
    });

    it('should try 7pm followed by 7:30pm when prebooking courts if required number is not reached at 6:30pm', async () => {
      const originalBookCourt = scvcc.bookCourt;
      const bookingAttempts = [];

      try {
        scvcc.bookCourt = async ({ time, court }) => {
          bookingAttempts.push({ time, court });
          // At 6:30pm, 1 court succeeds, but 2nd court fails
          if (time === '6:30pm') {
            if (bookingAttempts.filter(b => b.time === '6:30pm').length === 1) {
              return {
                success: true,
                court: 'Court 1',
                time: '6:30pm',
                duration: '90 Minutes',
                players: ['Player 1', 'Player 2', 'Player 3', 'Player 4']
              };
            }
            return { success: false, message: 'No courts available at 6:30pm' };
          }
          // At 7pm, 2nd court succeeds!
          if (time === '7pm') {
            return {
              success: true,
              court: 'Court 2',
              time: '7pm',
              duration: '90 Minutes',
              players: ['Player 5', 'Player 6', 'Player 7', 'Player 8']
            };
          }
          return { success: false, message: 'No courts available' };
        };

        const res = await pollCommands.preBookCourtsForMatch({
          sock: { sendMessage: async () => ({}) },
          remoteJid: '120363402559062529@g.us',
          targetDateMDY: '10/26/2026',
          queryTime: '6:30pm',
          size: 8, // 2 courts required
          isAuto: false,
          lookAround: 60,
          isAdvanceBooking: true,
          retryDelayMs: 1
        });

        // Verifies 2 courts secured: Court 1 at 6:30pm, Court 2 at 7pm
        assert.equal(res.advanceBookedCourts.length, 2);
        assert.equal(res.advanceBookedCourts[0].court, 'Court 1');
        assert.equal(res.advanceBookedCourts[0].time, '6:30pm');
        assert.equal(res.advanceBookedCourts[1].court, 'Court 2');
        assert.equal(res.advanceBookedCourts[1].time, '7pm');

        // Verifies attempts were made at 6:30pm, and then proceeded to 7pm, and did NOT need 7:30pm
        const bookedTimes = bookingAttempts.map(b => b.time);
        assert.ok(bookedTimes.includes('6:30pm'));
        assert.ok(bookedTimes.includes('7pm'));
        assert.ok(!bookedTimes.includes('7:30pm'));
      } finally {
        scvcc.bookCourt = originalBookCourt;
      }
    });

    it('should search prebooked courts across candidate times when creating a poll with checkCourts and lookAround', async () => {
      const originalCheckAvail = scvcc.checkCourtAvailability;
      const originalGetBookings = scvcc.getCourtBookings;
      const originalDetectPrebooked = scvcc.detectPrebookedCourt;
      const queriedTimes = [];

      try {
        scvcc.checkCourtAvailability = async ({ time }) => {
          queriedTimes.push(time);
          return { slots: [] };
        };
        scvcc.getCourtBookings = async ({ time }) => {
          if (time === '7pm') {
            return {
              bookings: [
                { court: 'Court 3', durationMins: 90, players: ['Player C'] }
              ]
            };
          }
          return { bookings: [] };
        };
        scvcc.detectPrebookedCourt = (b) => {
          if (b.court === 'Court 3') return { isPrebooked: true, player: 'Player C' };
          return null;
        };

        const activePolls = new Map();
        const res = await pollCommands.createMatchPoll(
          {
            sendMessage: async (jid, content) => ({
              key: { id: 'poll_lookaround_test', remoteJid: jid },
              message: content
            })
          },
          '120363402559062529@g.us',
          4,
          'Tomorrow 6:30pm',
          null,
          '6:30pm',
          'Creator',
          null,
          true,
          null,
          false,
          true,
          false,
          true, // checkCourts
          false,
          false,
          null,
          null,
          null,
          null,
          null,
          null,
          { activePolls, messageStore: new Map(), latestPollIdByChat: new Map(), persistPolls: () => {} },
          60 // lookAround: 1 hour
        );

        assert.equal(res.err, null);
        assert.deepEqual(queriedTimes, ['6:30pm', '7pm', '7:30pm']);
        const storedPoll = activePolls.get('poll_lookaround_test');
        assert.ok(storedPoll);
        assert.equal(storedPoll.lookAround, 60);
        assert.equal(storedPoll.lookAroundDisplay, '1 hour');
        assert.ok(storedPoll.prebookedCourts.some(c => c.court === 'Court 3'));
      } finally {
        scvcc.checkCourtAvailability = originalCheckAvail;
        scvcc.getCourtBookings = originalGetBookings;
        scvcc.detectPrebookedCourt = originalDetectPrebooked;
      }
    });

    it('should format poll title with time for courts booked at different times within look around window', async () => {
      const originalCheckAvail = scvcc.checkCourtAvailability;
      const originalGetBookings = scvcc.getCourtBookings;
      const originalDetectPrebooked = scvcc.detectPrebookedCourt;

      try {
        scvcc.checkCourtAvailability = async () => ({ slots: [] });
        scvcc.getCourtBookings = async ({ time }) => {
          if (time === '6:30pm') {
            return {
              bookings: [
                { court: 'Court 2', durationMins: 90, players: ['Player 2'] },
                { court: 'Court 3', durationMins: 90, players: ['Player 3'] }
              ]
            };
          }
          if (time === '7pm') {
            return {
              bookings: [
                { court: 'Court 6', durationMins: 90, players: ['Player 6'] }
              ]
            };
          }
          return { bookings: [] };
        };
        scvcc.detectPrebookedCourt = (b) => {
          if (b.court === 'Court 2') return { isPrebooked: true, player: 'Player 2' };
          if (b.court === 'Court 3') return { isPrebooked: true, player: 'Player 3' };
          if (b.court === 'Court 6') return { isPrebooked: true, player: 'Player 6' };
          return null;
        };

        const activePolls = new Map();
        const res = await pollCommands.createMatchPoll(
          {
            sendMessage: async (jid, content) => ({
              key: { id: 'poll_lookaround_title_test', remoteJid: jid },
              message: content
            })
          },
          '120363402559062529@g.us',
          12,
          'Tomorrow 6:30pm',
          null,
          '6:30pm',
          'Creator',
          null,
          false,
          null,
          false,
          true,
          false,
          true, // checkCourts
          false,
          false,
          null,
          null,
          null,
          null,
          null,
          null,
          { activePolls, messageStore: new Map(), latestPollIdByChat: new Map(), persistPolls: () => {} },
          30 // lookAround: 30 mins
        );

        assert.equal(res.err, null);
        const storedPoll = activePolls.get('poll_lookaround_title_test');
        assert.ok(storedPoll);

        const pollName = storedPoll.name;
        // Verify Court 2 and Court 3 are mentioned as earlier (without time)
        assert.ok(pollName.includes('Court 2 - Booked'), 'Expected "Court 2 - Booked" in poll title: ' + pollName);
        assert.ok(pollName.includes('Court 3 - Booked'), 'Expected "Court 3 - Booked" in poll title: ' + pollName);
        assert.ok(!pollName.includes('Court 2 (6:30pm)'), 'Court 2 should not have time: ' + pollName);
        assert.ok(!pollName.includes('Court 3 (6:30pm)'), 'Court 3 should not have time: ' + pollName);

        // Verify Court 6 mentions the time (7pm) since it differs from 6:30pm
        assert.ok(pollName.includes('Court 6 (7pm) - Booked'), 'Expected "Court 6 (7pm) - Booked" in poll title: ' + pollName);

        // Verify reading back prebooked courts from stored poll name works seamlessly
        const readBackCourts = await pollCommands.getPrebookedCourtsForPoll({ name: pollName });
        const courtNames = readBackCourts.map(c => c.court);
        assert.ok(courtNames.includes('Court 2'));
        assert.ok(courtNames.includes('Court 3'));
        assert.ok(courtNames.includes('Court 6'));

        // Also verify auto poll format
        const autoPolls = new Map();
        const autoRes = await pollCommands.createMatchPoll(
          {
            sendMessage: async (jid, content) => ({
              key: { id: 'poll_auto_lookaround_test', remoteJid: jid },
              message: content
            })
          },
          '120363402559062529@g.us',
          'auto',
          'Tomorrow 6:30pm',
          null,
          '6:30pm',
          'Creator',
          null,
          false,
          null,
          false,
          true,
          false,
          true, // checkCourts
          false,
          false,
          null,
          null,
          null,
          null,
          null,
          null,
          { activePolls: autoPolls, messageStore: new Map(), latestPollIdByChat: new Map(), persistPolls: () => {} },
          30 // lookAround: 30 mins
        );

        assert.equal(autoRes.err, null);
        const autoPoll = autoPolls.get('poll_auto_lookaround_test');
        assert.ok(autoPoll);
        assert.ok(autoPoll.name.includes('Court 2 - Booked'));
        assert.ok(autoPoll.name.includes('Court 3 - Booked'));
        assert.ok(autoPoll.name.includes('Court 6 (7pm) - Booked'));
      } finally {
        scvcc.checkCourtAvailability = originalCheckAvail;
        scvcc.getCourtBookings = originalGetBookings;
        scvcc.detectPrebookedCourt = originalDetectPrebooked;
      }
    });
  });

  describe('recurring poll reminders option', () => {
    it('should default reminders to true when scheduling recurring poll and reflect in card', async () => {
      const recurringPolls = new Map();
      const res = await recurringPollsModule.scheduleRecurringPoll({
        recurringPolls,
        persistPolls: () => {},
        targetChatId: '120363402559062529@g.us',
        sender: 'Alice',
        senderJid: 'alice@s.whatsapp.net',
        params: {
          size: 4,
          matchTime: '7pm',
          days: 'mon-thu'
        }
      });
      assert.ok(typeof res === 'string');
      const sched = [...recurringPolls.values()][0];
      assert.equal(sched.reminders, true);
      assert.ok(res.includes('Reminders:* On'));
    });

    it('should allow setting reminders to false and modify reminders on recurring schedule', async () => {
      const recurringPolls = new Map();
      await recurringPollsModule.scheduleRecurringPoll({
        recurringPolls,
        persistPolls: () => {},
        targetChatId: '120363402559062529@g.us',
        sender: 'Alice',
        senderJid: 'alice@s.whatsapp.net',
        params: {
          size: 4,
          matchTime: '7pm',
          days: 'mon-thu',
          reminders: false
        }
      });
      const sched = [...recurringPolls.values()][0];
      assert.equal(sched.reminders, false);
      const card = recurringPollsModule.formatRecurringScheduleCard(sched);
      assert.ok(card.includes('• *Reminders:* Off'));

      const modRes = await recurringPollsModule.modifyRecurringPoll({
        recurringPolls,
        persistPolls: () => {},
        sender: 'Alice',
        scheduleId: sched.id,
        updates: { reminders: true }
      });
      assert.equal(sched.reminders, true);
      assert.ok(modRes.includes('Reminders for poll instances: *On*'));
    });
  });

  describe("recurring poll slot check display", () => {
    it("should display Slot Check: Enabled by default in recurring schedule card", async () => {
      const recurringPolls = new Map();
      await recurringPollsModule.scheduleRecurringPoll({
        recurringPolls,
        persistPolls: () => {},
        targetChatId: "120363402559062529@g.us",
        sender: "Alice",
        senderJid: "alice@s.whatsapp.net",
        params: {
          size: 4,
          matchTime: "7pm",
          days: "mon-thu"
        }
      });
      const sched = [...recurringPolls.values()][0];
      const card = recurringPollsModule.formatRecurringScheduleCard(sched);
      assert.ok(card.includes("• *Slot Check:* Enabled"), "Card should show Slot Check: Enabled by default");

      const listOutput = recurringPollsModule.listRecurringPolls({ recurringPolls, chatId: "120363402559062529@g.us" });
      assert.ok(listOutput.includes("• *Slot Check:* Enabled"), "List output should show Slot Check: Enabled");
    });

    it("should display Slot Check: Disabled when slotCheck is set to false", async () => {
      const recurringPolls = new Map();
      await recurringPollsModule.scheduleRecurringPoll({
        recurringPolls,
        persistPolls: () => {},
        targetChatId: "120363402559062529@g.us",
        sender: "Alice",
        senderJid: "alice@s.whatsapp.net",
        params: {
          size: 4,
          matchTime: "7pm",
          days: "mon-thu",
          slotCheck: false
        }
      });
      const sched = [...recurringPolls.values()][0];
      const card = recurringPollsModule.formatRecurringScheduleCard(sched);
      assert.ok(card.includes("• *Slot Check:* Disabled"), "Card should show Slot Check: Disabled");
    });
  });

  describe('recurring poll lineup generation synchronization', () => {
    it('should correctly set lineupGeneration none and remove legacy flags when scheduling', async () => {
      const recurringPolls = new Map();
      const res = await recurringPollsModule.scheduleRecurringPoll({
        recurringPolls,
        persistPolls: () => {},
        targetChatId: '120363402559062529@g.us',
        sender: 'Alice',
        senderJid: 'alice@s.whatsapp.net',
        params: {
          size: 4,
          matchTime: '7pm',
          days: 'mon-thu',
          lineupGeneration: 'none'
        }
      });
      assert.ok(typeof res === 'string');
      const sched = [...recurringPolls.values()][0];
      assert.equal(sched.lineupGeneration, 'none');
      assert.equal(sched.autoMatchups, undefined);
      assert.equal(sched.noMatchups, undefined);
      const card = recurringPollsModule.formatRecurringScheduleCard(sched);
      assert.ok(card.includes('• *Lineup Generation:* None (manual only)'));
      assert.ok(!card.includes('• *Matchups:*'));
    });

    it('should parse various no-matchup / none lineup flags correctly', () => {
      const f1 = recurringPollsModule.extractCommonFlags('7pm mon --auto-matchups=false');
      assert.equal(f1.flags.lineupGeneration, 'none');
      assert.equal(f1.flags.autoMatchups, undefined);
      assert.equal(f1.flags.noMatchups, undefined);

      const f2 = recurringPollsModule.extractCommonFlags('7pm mon --matchups=none');
      assert.equal(f2.flags.lineupGeneration, 'none');
      assert.equal(f2.flags.autoMatchups, undefined);
      assert.equal(f2.flags.noMatchups, undefined);

      const f3 = recurringPollsModule.extractCommonFlags('7pm mon --lineups=none');
      assert.equal(f3.flags.lineupGeneration, 'none');
      assert.equal(f3.flags.autoMatchups, undefined);
      assert.equal(f3.flags.noMatchups, undefined);

      const f4 = recurringPollsModule.extractCommonFlags('7pm mon lineups=none');
      assert.equal(f4.flags.lineupGeneration, 'none');
      assert.equal(f4.flags.autoMatchups, undefined);
      assert.equal(f4.flags.noMatchups, undefined);

      const f5 = recurringPollsModule.extractCommonFlags('7pm mon manual lineups');
      assert.equal(f5.flags.lineupGeneration, 'none');
      assert.equal(f5.flags.autoMatchups, undefined);
      assert.equal(f5.flags.noMatchups, undefined);
    });

    it('should create poll instance with lineupGeneration none when recurring schedule has lineupGeneration none', async () => {
      const recurringPolls = new Map();
      const activePolls = new Map();
      const pollCommands = require('../lib/commands/poll');

      await recurringPollsModule.scheduleRecurringPoll({
        recurringPolls,
        persistPolls: () => {},
        targetChatId: '120363402559062529@g.us',
        sender: 'Alice',
        senderJid: 'alice@s.whatsapp.net',
        params: {
          size: 4,
          matchTime: '7pm',
          postTime: '8am',
          days: 'monday',
          lineupGeneration: 'none'
        }
      });

      const sched = [...recurringPolls.values()][0];
      assert.equal(sched.lineupGeneration, 'none');

      const mockSock = {
        user: { id: 'tenbot@s.whatsapp.net' },
        sendMessage: async (jid, content) => ({
          key: { id: 'poll_inst_lineup_none', remoteJid: jid },
          message: content
        })
      };

      const context = {
        activePolls,
        messageStore: new Map(),
        latestPollIdByChat: new Map(),
        persistPolls: () => {}
      };

      await recurringPollsModule.checkAndPostRecurringPolls({
        sock: mockSock,
        recurringPolls,
        persistPolls: () => {},
        createMatchPoll: (...args) => pollCommands.createMatchPoll(...args, context),
        getTargetGroupJid: async () => '120363402559062529@g.us',
        customSanJoseParts: { year: 2026, month: 10, day: 2, weekday: 'mon', hour: 8, minute: 0 }
      });

      const pollState = activePolls.get('poll_inst_lineup_none');
      assert.ok(pollState, 'Poll instance should be created');
      assert.equal(pollState.lineupGeneration, 'none', 'Poll instance lineupGeneration must be none');
      assert.equal(pollState.noMatchups, undefined, 'Poll instance noMatchups should be removed');
      assert.equal(pollState.autoMatchups, undefined, 'Poll instance autoMatchups should be removed');
    });

    it('should update active poll instance when modifying recurring poll lineupGeneration to none', async () => {
      const recurringPolls = new Map();
      const activePolls = new Map();

      const schedId = 'rec_mod_sync_test';
      const sched = {
        id: schedId,
        remoteJid: '120363402559062529@g.us',
        size: 4,
        matchTime: '7:00 PM',
        matchDisplay: '7:00 PM',
        matchHour: 19,
        matchMinute: 0,
        postTime: '8:00 AM',
        days: 'monday',
        daysList: ['mon'],
        autoMatchups: true,
        noMatchups: false,
        lineupGeneration: 'filled',
        lineupLeadTime: 30,
        enabled: true
      };
      recurringPolls.set(schedId, sched);

      const existingPollId = 'poll_existing_inst';
      const pollState = {
        remoteJid: '120363402559062529@g.us',
        name: '🎾 Today 7pm (4 slots / 4)',
        scheduleId: schedId,
        status: 'active',
        lineupGeneration: 'filled',
        noMatchups: false,
        autoMatchups: true,
        lineupLeadTime: 30
      };
      activePolls.set(existingPollId, pollState);

      const modRes = await recurringPollsModule.modifyRecurringPoll({
        recurringPolls,
        persistPolls: () => {},
        activePolls,
        sender: 'Alice',
        scheduleId: schedId,
        updates: { lineupGeneration: 'none' }
      });

      assert.ok(modRes.includes('Lineup generation: *None (manual only)*'));
      assert.equal(sched.lineupGeneration, 'none');
      assert.equal(sched.noMatchups, undefined);
      assert.equal(sched.autoMatchups, undefined);

      // Verify active poll instance was synchronized and legacy flags removed
      assert.equal(pollState.lineupGeneration, 'none');
      assert.equal(pollState.noMatchups, undefined);
      assert.equal(pollState.autoMatchups, undefined);
    });
  });

  describe("club closed detection and preventing advance rebooking", () => {
    it("preBookCourtsForMatch should stop immediately without retries on clubClosed and still check non-closed lookAround times", async () => {
      const pollCommands = require("../lib/commands/poll");
      const scvcc = require("../lib/scvcc");
      const origBookCourt = scvcc.bookCourt;
      const bookCalls = [];

      scvcc.bookCourt = async (params) => {
        bookCalls.push(params.time);
        if (params.time === "6:30pm" || params.time === "6:30 PM" || params.time === "7pm" || params.time === "7:00 PM") {
          return {
            success: false,
            clubClosed: true,
            clubClosedTitle: "Club Closed - Maintenance",
            time: params.time,
            message: "Club is closed"
          };
        }
        return {
          success: true,
          court: "Court 2",
          players: params.players,
          date: params.date,
          time: params.time,
          reservationId: "res_open_730",
          message: "Booked Court 2"
        };
      };

      try {
        // Only closed time -> 1 call (0 retries) and clubClosed: true
        const closedOnlyRes = await pollCommands.preBookCourtsForMatch({
          remoteJid: "120363402559062529@g.us",
          targetDateMDY: "11/26/2026",
          queryTime: "7:00 PM",
          size: 4,
          isAdvanceBooking: true,
          retryDelayMs: 0
        });
        assert.equal(bookCalls.length, 1, "Must not retry 3 times when clubClosed is true");
        assert.equal(closedOnlyRes.clubClosed, true);
        assert.equal(closedOnlyRes.clubClosedTitle, "Club Closed - Maintenance");
        assert.equal(closedOnlyRes.advanceBookedCourts.length, 0);

        // With lookAround (1 hour -> 6:30pm, 7pm, 7:30pm) and pre-detected closedTimes for 6:30pm
        bookCalls.length = 0;
        const lookAroundRes = await pollCommands.preBookCourtsForMatch({
          remoteJid: "120363402559062529@g.us",
          targetDateMDY: "11/26/2026",
          queryTime: "7:00 PM",
          lookAround: 60,
          size: 4,
          isAdvanceBooking: true,
          retryDelayMs: 0,
          closedTimes: [{ time: "6:30pm", title: "Club Closed - Maintenance" }]
        });
        assert.deepEqual(bookCalls, ["7pm", "7:30pm"], "Should skip pre-closed 6:30pm, try 7pm once (no retry on closed), then book 7:30pm");
        assert.equal(lookAroundRes.clubClosed, false);
        assert.equal(lookAroundRes.advanceBookedCourts.length, 1);
        assert.equal(lookAroundRes.advanceBookedCourts[0].court, "Court 2");
      } finally {
        scvcc.bookCourt = origBookCourt;
      }
    });

    it("checkAndExecuteAdvanceBookings should mark closed date complete and never attempt to rebook on retries or periodic checks", async () => {
      const scvcc = require("../lib/scvcc");
      const groupsConfig = require("../lib/groupsConfig");
      const origCheckAvail = scvcc.checkCourtAvailability;
      const origGetBookings = scvcc.getCourtBookings;
      const origGetGroupConfig = groupsConfig.getGroupConfig;
      const origRealNow = Date.now;

      groupsConfig.getGroupConfig = () => ({
        name: "Test",
        sport: "tennis",
        courtBookingEnabled: true,
        bookingStrategy: "advanced",
        bookingSchedule: "-7days 7:00AM",
        preBookCourts: 1,
        clubClosedTitles: ["Club Closed", "/Thanksgiving/i"]
      });

      scvcc.checkCourtAvailability = async () => ({
        success: true,
        slots: [{
          time: "7:00 PM",
          courts: [
            { court: "Court 1", status: "booked", blockTitle: "Thanksgiving - Club Closed", availableMinutes: 0 }
          ]
        }]
      });
      scvcc.getCourtBookings = async () => ({ bookings: [] });

      const recurringPolls = new Map([[
        "rec_closed_adv",
        {
          id: "rec_closed_adv",
          remoteJid: "120363403838804497@g.us",
          size: 4,
          matchTime: "7:00 PM",
          matchHour: 19,
          matchMinute: 0,
          days: "thu",
          daysList: [4],
          bookingStrategy: "advanced",
          bookingSchedule: "-7days 7:00AM",
          preBookCourts: 1,
          startDate: "2026-11-26",
          enabled: true,
          postTime: "0d 8:00 AM"
        }
      ]]);

      let preBookCalls = 0;
      const sentNotifications = [];
      const preBookCourtsForMatch = async () => {
        preBookCalls++;
        return { advanceBookedCourts: [], prebookedCourts: [] };
      };

      try {
        // 1. Trigger 7 days ahead (Nov 19 7:05 AM for Nov 26 Thu 7:00 PM)
        let simulatedNow = new Date(2026, 10, 19, 7, 5, 0).getTime();
        Date.now = () => simulatedNow;

        await recurringPollsModule.checkAndExecuteAdvanceBookings({
          sock: {},
          recurringPolls,
          persistPolls: () => {},
          preBookCourtsForMatch,
          customSanJoseParts: { year: 2026, month: 10, day: 19, hour: 7, minute: 5, weekday: "thu" },
          sendBookingNotifications: async (_sock, _jid, msg) => { sentNotifications.push(msg); }
        });

        const entry = recurringPolls.get("rec_closed_adv").advanceBookings["2026-11-26"];
        assert.ok(entry, "Advance booking entry should be recorded for the closed date");
        assert.equal(entry.clubClosed, true);
        assert.equal(entry.clubClosedTitle, "Thanksgiving - Club Closed");
        assert.equal(entry.completed, true);
        assert.equal(preBookCalls, 0, "Should not invoke preBookCourtsForMatch when time is already detected as closed");
        assert.equal(sentNotifications.length, 1, "Should send a single club-closed notification");
        assert.match(sentNotifications[0], /Club Closed/i);

        // 2. Advance 15 minutes (would normally retry every 10 min) -> must NOT rebook or re-notify
        simulatedNow += 15 * 60 * 1000;
        await recurringPollsModule.checkAndExecuteAdvanceBookings({
          sock: {},
          recurringPolls,
          persistPolls: () => {},
          preBookCourtsForMatch,
          customSanJoseParts: { year: 2026, month: 10, day: 19, hour: 7, minute: 20, weekday: "thu" },
          sendBookingNotifications: async (_sock, _jid, msg) => { sentNotifications.push(msg); }
        });

        // 3. Periodic check at 9:30 AM next day -> must NOT rebook or re-notify
        simulatedNow += 26 * 60 * 60 * 1000;
        await recurringPollsModule.checkAndExecuteAdvanceBookings({
          sock: {},
          recurringPolls,
          persistPolls: () => {},
          preBookCourtsForMatch,
          customSanJoseParts: { year: 2026, month: 10, day: 20, hour: 9, minute: 35, weekday: "fri" },
          sendBookingNotifications: async (_sock, _jid, msg) => { sentNotifications.push(msg); }
        });

        assert.equal(preBookCalls, 0, "Must never attempt to rebook a club-closed date");
        assert.equal(sentNotifications.length, 1, "Must not send duplicate notifications");
      } finally {
        Date.now = origRealNow;
        scvcc.checkCourtAvailability = origCheckAvail;
        scvcc.getCourtBookings = origGetBookings;
        groupsConfig.getGroupConfig = origGetGroupConfig;
      }
    });
  });

  describe("syncing advance court bookings when recurring poll time or duration changes", () => {
    const testSj = { year: 2026, month: 10, day: 21, hour: 10, minute: 0 };
    const testChatId = "120363402559062529@g.us";

    it("moves existing SCVCC advance booking in-place when same court is available at the new match time", async () => {
      const scvcc = require("../lib/scvcc");
      const origModify = scvcc.modifyCourtBooking;
      const modifyCalls = [];

      scvcc.modifyCourtBooking = async (opts) => {
        modifyCalls.push(opts);
        return {
          success: true,
          reservationId: opts.reservationId,
          court: opts.court || "Court 2",
          date: opts.date || "11/28/2026",
          time: opts.time || "6:00 PM",
          duration: opts.duration || "90 Minutes"
        };
      };

      try {
        const recurringPolls = new Map([["rec_move_same", {
          id: "rec_move_same",
          remoteJid: testChatId,
          size: 4,
          matchTime: "7pm",
          matchDisplay: "7:00 PM",
          matchHour: 19,
          matchMinute: 0,
          postTime: "8am",
          postDisplay: "8:00 AM",
          days: "sat",
          daysList: [6],
          bookingStrategy: "advanced",
          bookingDuration: 90,
          enabled: true,
          advanceBookings: {
            "2026-11-28": {
              targetDateMDY: "11/28/2026",
              matchTime: "7pm",
              targetCourtsCount: 1,
              completed: true,
              autoBookedCourts: [{
                court: "Court 2",
                time: "7:00 PM",
                reservationId: "99101",
                players: ["Pramod Immaneni"],
                duration: "90 Minutes"
              }],
              advanceBookedCourts: [{
                court: "Court 2",
                time: "7:00 PM",
                reservationId: "99101",
                players: ["Pramod Immaneni"],
                duration: "90 Minutes"
              }],
              prebookedCourts: [{
                court: "Court 2",
                player: "Pramod Immaneni",
                fullName: "Pramod Immaneni",
                time: "7:00 PM",
                bookingType: "auto"
              }]
            }
          }
        }]]);

        const res = await recurringPollsModule.modifyRecurringPoll({
          recurringPolls,
          persistPolls: () => {},
          sender: "Alice",
          scheduleId: "rec_move_same",
          updates: { matchTime: "6pm" },
          customSanJoseParts: testSj
        });

        assert.equal(modifyCalls.length, 1);
        assert.equal(modifyCalls[0].reservationId, "99101");
        assert.equal(modifyCalls[0].time, "6:00 PM");
        assert.equal(modifyCalls[0].date, "11/28/2026");

        const entry = recurringPolls.get("rec_move_same").advanceBookings["2026-11-28"];
        assert.equal(entry.matchTime, "6pm");
        assert.equal(entry.completed, true);
        assert.equal(entry.autoBookedCourts[0].time, "6:00 PM");
        assert.equal(entry.advanceBookedCourts[0].time, "6:00 PM");
        assert.equal(entry.prebookedCourts[0].time, "6:00 PM");
        assert.match(res, /Advance Court Bookings:/);
        assert.match(res, /Moved \*Court 2\* \(7:00 PM → \*6:00 PM\*/);
      } finally {
        scvcc.modifyCourtBooking = origModify;
      }
    });

    it("falls back to an alternative preferred available court when the original court cannot move to the new time", async () => {
      const scvcc = require("../lib/scvcc");
      const origModify = scvcc.modifyCourtBooking;
      const origCheckAvail = scvcc.checkCourtAvailability;
      const modifyCalls = [];

      scvcc.modifyCourtBooking = async (opts) => {
        modifyCalls.push(opts);
        if (!opts.court || opts.court === "Court 2") {
          return { success: false, message: "Court 2 is already booked at 6:00 PM" };
        }
        return {
          success: true,
          reservationId: opts.reservationId,
          court: opts.court,
          date: opts.date || "11/28/2026",
          time: opts.time,
          duration: "90 Minutes"
        };
      };

      scvcc.checkCourtAvailability = async () => ({
        slots: [{
          time: "6:00 PM",
          courts: [
            { court: "Court 1", status: "available", availableMinutes: 90 },
            { court: "Court 2", status: "booked", availableMinutes: 0 },
            { court: "Court 3", status: "available", availableMinutes: 90 }
          ]
        }]
      });

      try {
        const recurringPolls = new Map([["rec_move_alt", {
          id: "rec_move_alt",
          remoteJid: testChatId,
          size: 4,
          matchTime: "7pm",
          matchDisplay: "7:00 PM",
          matchHour: 19,
          matchMinute: 0,
          postTime: "8am",
          postDisplay: "8:00 AM",
          days: "sat",
          daysList: [6],
          bookingStrategy: "advanced",
          bookingCourtPreference: ["3", "1"],
          bookingDuration: 90,
          enabled: true,
          advanceBookings: {
            "2026-11-28": {
              targetDateMDY: "11/28/2026",
              matchTime: "7pm",
              targetCourtsCount: 1,
              completed: true,
              autoBookedCourts: [{
                court: "Court 2",
                time: "7:00 PM",
                reservationId: "99202",
                players: ["Pramod Immaneni"],
                duration: "90 Minutes"
              }],
              advanceBookedCourts: [{
                court: "Court 2",
                time: "7:00 PM",
                reservationId: "99202",
                players: ["Pramod Immaneni"],
                duration: "90 Minutes"
              }],
              prebookedCourts: [{
                court: "Court 2",
                player: "Pramod Immaneni",
                fullName: "Pramod Immaneni",
                time: "7:00 PM",
                bookingType: "auto"
              }]
            }
          }
        }]]);

        const res = await recurringPollsModule.modifyRecurringPoll({
          recurringPolls,
          persistPolls: () => {},
          sender: "Alice",
          scheduleId: "rec_move_alt",
          updates: { matchTime: "6pm" },
          customSanJoseParts: testSj
        });

        assert.equal(modifyCalls.length, 2);
        assert.equal(modifyCalls[1].court, "Court 3", "Should prefer Court 3 over Court 1 per bookingCourtPreference");

        const entry = recurringPolls.get("rec_move_alt").advanceBookings["2026-11-28"];
        assert.equal(entry.autoBookedCourts[0].court, "Court 3");
        assert.equal(entry.autoBookedCourts[0].time, "6:00 PM");
        assert.equal(entry.prebookedCourts[0].court, "Court 3");
        assert.match(res, /Moved \*Court 2\* \(7:00 PM\) → \*Court 3\* \(\*6:00 PM\*/);
      } finally {
        scvcc.modifyCourtBooking = origModify;
        scvcc.checkCourtAvailability = origCheckAvail;
      }
    });

    it("preserves SCVCC reservation, detaches incompatible bookings, warns, and resets entry for retry when no courts can move; keeps posted-poll bookings untouched", async () => {
      const scvcc = require("../lib/scvcc");
      const origModify = scvcc.modifyCourtBooking;
      const origCheckAvail = scvcc.checkCourtAvailability;
      const origCancel = scvcc.cancelCourtReservation;
      let cancelCalls = 0;

      scvcc.modifyCourtBooking = async () => ({ success: false, message: "No courts open at 6:00 PM" });
      scvcc.checkCourtAvailability = async () => ({ slots: [{ time: "6:00 PM", courts: [] }] });
      scvcc.cancelCourtReservation = async () => {
        cancelCalls++;
        return { success: true };
      };

      try {
        const recurringPolls = new Map([["rec_move_fail", {
          id: "rec_move_fail",
          remoteJid: testChatId,
          size: 4,
          matchTime: "7pm",
          matchDisplay: "7:00 PM",
          matchHour: 19,
          matchMinute: 0,
          postTime: "8am",
          postDisplay: "8:00 AM",
          days: "sat,sun",
          daysList: [0, 6],
          postedMatchDates: ["2026-11-22"],
          bookingStrategy: "advanced",
          bookingDuration: 90,
          enabled: true,
          advanceBookings: {
            "2026-11-22": {
              targetDateMDY: "11/22/2026",
              matchTime: "7pm",
              targetCourtsCount: 1,
              completed: true,
              pollCreated: true,
              autoBookedCourts: [{ court: "Court 1", time: "7:00 PM", reservationId: "88001", players: ["Pramod Immaneni"], duration: "90 Minutes" }],
              advanceBookedCourts: [{ court: "Court 1", time: "7:00 PM", reservationId: "88001", players: ["Pramod Immaneni"], duration: "90 Minutes" }],
              prebookedCourts: [{ court: "Court 1", player: "Pramod Immaneni", time: "7:00 PM", bookingType: "auto" }]
            },
            "2026-11-28": {
              targetDateMDY: "11/28/2026",
              matchTime: "7pm",
              targetCourtsCount: 2,
              completed: true,
              autoBookedCourts: [{ court: "Court 2", time: "7:00 PM", reservationId: "99303", players: ["Pramod Immaneni"], duration: "90 Minutes" }],
              advanceBookedCourts: [{ court: "Court 2", time: "7:00 PM", reservationId: "99303", players: ["Pramod Immaneni"], duration: "90 Minutes" }],
              prebookedCourts: [
                { court: "Court 2", player: "Pramod Immaneni", time: "7:00 PM", bookingType: "auto" },
                { court: "Court 4", player: "Vijay", fullName: "Vijay", time: "7:00 PM", bookingType: "manual" }
              ]
            },
            "2026-11-29": {
              targetDateMDY: "11/29/2026",
              matchTime: "7pm",
              targetCourtsCount: 1,
              completed: true,
              clubClosed: true,
              autoBookedCourts: [],
              advanceBookedCourts: [],
              prebookedCourts: []
            }
          }
        }]]);

        const res = await recurringPollsModule.modifyRecurringPoll({
          recurringPolls,
          persistPolls: () => {},
          sender: "Alice",
          scheduleId: "rec_move_fail",
          updates: { matchTime: "6pm" },
          customSanJoseParts: testSj
        });

        assert.equal(cancelCalls, 0, "Must not cancel existing SCVCC reservations when move fails");
        const sched = recurringPolls.get("rec_move_fail");
        assert.equal(sched.advanceBookings["2026-11-22"].autoBookedCourts[0].time, "7:00 PM", "Already-posted instance stays untouched");
        assert.equal(sched.advanceBookings["2026-11-28"], undefined, "Unposted entry with no remaining compatible bookings is cleared for fresh retry");
        assert.equal(sched.advanceBookings["2026-11-29"], undefined, "Old-time clubClosed attempt is cleared for fresh retry");
        assert.match(res, /Poll already posted — kept existing booking\(s\) as-is/);
        assert.match(res, /Could not move \*Court 2\* \(7:00 PM, ID: `99303`\) to \*6:00 PM\*/);
        assert.match(res, /!cancelcourt 99303/);
        assert.match(res, /Manual booking on \*Court 4\* at 7:00 PM \(by Vijay\) no longer matches \*6(?::00)? PM\*/);
        assert.match(res, /Cleared prior attempt state for 7pm/);
      } finally {
        scvcc.modifyCourtBooking = origModify;
        scvcc.checkCourtAvailability = origCheckAvail;
        scvcc.cancelCourtReservation = origCancel;
      }
    });

    it("updates duration on unposted advance bookings when bookingDuration changes and keeps bookings within lookAround when move fails", async () => {
      const scvcc = require("../lib/scvcc");
      const origModify = scvcc.modifyCourtBooking;
      const origCheckAvail = scvcc.checkCourtAvailability;
      const modifyCalls = [];

      scvcc.modifyCourtBooking = async (opts) => {
        modifyCalls.push(opts);
        if (opts.time === "6:30 PM") {
          return { success: false, message: "6:30 PM busy" };
        }
        return {
          success: true,
          reservationId: opts.reservationId,
          court: "Court 2",
          date: opts.date || "11/28/2026",
          time: "7:00 PM",
          duration: opts.duration
        };
      };
      scvcc.checkCourtAvailability = async () => ({ slots: [] });

      try {
        const recurringPolls = new Map([["rec_dur_la", {
          id: "rec_dur_la",
          remoteJid: testChatId,
          size: 4,
          matchTime: "7pm",
          matchDisplay: "7:00 PM",
          matchHour: 19,
          matchMinute: 0,
          postTime: "8am",
          postDisplay: "8:00 AM",
          days: "sat",
          daysList: [6],
          lookAround: 60,
          bookingStrategy: "advanced",
          bookingDuration: 90,
          enabled: true,
          advanceBookings: {
            "2026-11-28": {
              targetDateMDY: "11/28/2026",
              matchTime: "7pm",
              targetCourtsCount: 1,
              completed: true,
              autoBookedCourts: [{ court: "Court 2", time: "7:00 PM", reservationId: "99404", players: ["Pramod Immaneni"], duration: "90 Minutes" }],
              advanceBookedCourts: [{ court: "Court 2", time: "7:00 PM", reservationId: "99404", players: ["Pramod Immaneni"], duration: "90 Minutes" }],
              prebookedCourts: [{ court: "Court 2", player: "Pramod Immaneni", time: "7:00 PM", bookingType: "auto" }]
            }
          }
        }]]);

        const durRes = await recurringPollsModule.modifyRecurringPoll({
          recurringPolls,
          persistPolls: () => {},
          sender: "Alice",
          scheduleId: "rec_dur_la",
          updates: { bookingDuration: 60 },
          customSanJoseParts: testSj
        });
        assert.equal(modifyCalls.length, 1);
        assert.equal(modifyCalls[0].duration, "60 Minutes");
        assert.equal(recurringPolls.get("rec_dur_la").advanceBookings["2026-11-28"].autoBookedCourts[0].duration, "60 Minutes");
        assert.match(durRes, /Updated \*Court 2\* duration to \*60 Minutes\*/);

        const laRes = await recurringPollsModule.modifyRecurringPoll({
          recurringPolls,
          persistPolls: () => {},
          sender: "Alice",
          scheduleId: "rec_dur_la",
          updates: { matchTime: "6:30pm" },
          customSanJoseParts: testSj
        });
        const entryAfter = recurringPolls.get("rec_dur_la").advanceBookings["2026-11-28"];
        assert.equal(entryAfter.autoBookedCourts.length, 1, "7:00 PM booking should remain kept within 60m look-around of 6:30 PM");
        assert.equal(entryAfter.completed, true);
        assert.match(laRes, /Kept \*Court 2\* at 7:00 PM \(within look-around window/);
      } finally {
        scvcc.modifyCourtBooking = origModify;
        scvcc.checkCourtAvailability = origCheckAvail;
      }
    });
  });
});
