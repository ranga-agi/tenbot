const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { extractCommonFlags, scheduleRecurringPoll } = require('../lib/recurringPolls');
const { migrateCourtsStrategyOptions } = require('../lib/pollStore');
const { parsePollCreationText, pollStatusText, createMatchPoll } = require('../lib/commands/pollCommands');

describe('courtsStrategy option and startup migration', () => {
  describe('extractCommonFlags --courts-strategy parsing', () => {
    it('should parse --courts-strategy=book and set checkCourts=true and courtBookingType=pre-book', () => {
      const { flags, remainingText } = extractCommonFlags('4 tomorrow 9am --courts-strategy=book');
      assert.equal(flags.courtsStrategy, 'book');
      assert.equal(flags.checkCourts, true);
      assert.equal(flags.courtBookingType, 'pre-book');
      assert.match(remainingText, /4 tomorrow 9am/);
    });

    it('should parse --courts-strategy=lookup and set checkCourts=true and courtBookingType=none', () => {
      const { flags } = extractCommonFlags('4 tomorrow 9am --courts-strategy=lookup');
      assert.equal(flags.courtsStrategy, 'lookup');
      assert.equal(flags.checkCourts, true);
      assert.equal(flags.courtBookingType, 'none');
    });

    it('should parse --courts-strategy=none and set checkCourts=false and courtBookingType=none', () => {
      const { flags } = extractCommonFlags('4 tomorrow 9am --courts-strategy=none');
      assert.equal(flags.courtsStrategy, 'none');
      assert.equal(flags.checkCourts, false);
      assert.equal(flags.courtBookingType, 'none');
    });

    it('should support alias --court-strategy and natural language syntax', () => {
      const res1 = extractCommonFlags('auto 7pm --court-strategy=book');
      assert.equal(res1.flags.courtsStrategy, 'book');

      const res2 = extractCommonFlags('auto 7pm courts strategy: lookup');
      assert.equal(res2.flags.courtsStrategy, 'lookup');
    });

    it('should NOT recognize old dropped flags (--courts, --no-courts, --court-booking-type)', () => {
      const { flags } = extractCommonFlags('4 tomorrow 9am --courts --no-courts --court-booking-type=pre-book');
      assert.equal(flags.courtsStrategy, undefined);
      assert.equal(flags.checkCourts, undefined);
      assert.equal(flags.courtBookingType, undefined);
    });

    it('should NOT recognize plain --strategy alias for bookingStrategy', () => {
      const resOld = extractCommonFlags('4 tomorrow 9am --strategy=advanced');
      assert.equal(resOld.flags.bookingStrategy, undefined);

      const resValid = extractCommonFlags('4 tomorrow 9am --booking-strategy=advanced');
      assert.equal(resValid.flags.bookingStrategy, 'advanced');
    });
  });

  describe('parsePollCreationText with --courts-strategy', () => {
    it('should return courtsStrategy from input text', () => {
      const parsedBook = parsePollCreationText('!poll 4 tomorrow 9am --courts-strategy=book');
      assert.equal(parsedBook.courtsStrategy, 'book');
      assert.equal(parsedBook.checkCourts, true);

      const parsedLookup = parsePollCreationText('!poll 4 tomorrow 9am --courts-strategy=lookup');
      assert.equal(parsedLookup.courtsStrategy, 'lookup');
      assert.equal(parsedLookup.checkCourts, true);

      const parsedNone = parsePollCreationText('!poll 4 tomorrow 9am --courts-strategy=none');
      assert.equal(parsedNone.courtsStrategy, 'none');
      assert.equal(parsedNone.checkCourts, false);
    });
  });

  describe('migrateCourtsStrategyOptions on startup', () => {
    it('should migrate active polls with legacy courtBookingType=pre-book to courtsStrategy=book', () => {
      const activePolls = new Map([
        ['poll_1', {
          id: 'poll_1',
          size: 4,
          courtBookingType: 'pre-book',
          checkCourts: true,
          includeCourts: true
        }],
        ['poll_2', {
          id: 'poll_2',
          size: 4,
          preBookCourts: 2
        }]
      ]);

      const count = migrateCourtsStrategyOptions({ activePolls });
      assert.equal(count, 2);

      const p1 = activePolls.get('poll_1');
      assert.equal(p1.courtsStrategy, 'book');
      assert.equal(p1.courtBookingType, undefined);
      assert.equal(p1.checkCourts, undefined);
      assert.equal(p1.includeCourts, undefined);

      const p2 = activePolls.get('poll_2');
      assert.equal(p2.courtsStrategy, 'book');
    });

    it('should migrate active polls with legacy checkCourts=true to courtsStrategy=lookup', () => {
      const activePolls = new Map([
        ['poll_3', {
          id: 'poll_3',
          size: 4,
          checkCourts: true
        }],
        ['poll_4', {
          id: 'poll_4',
          size: 4,
          includeCourts: true
        }]
      ]);

      const count = migrateCourtsStrategyOptions({ activePolls });
      assert.equal(count, 2);

      assert.equal(activePolls.get('poll_3').courtsStrategy, 'lookup');
      assert.equal(activePolls.get('poll_3').checkCourts, undefined);

      assert.equal(activePolls.get('poll_4').courtsStrategy, 'lookup');
      assert.equal(activePolls.get('poll_4').includeCourts, undefined);
    });

    it('should migrate active polls without court options to courtsStrategy=none', () => {
      const activePolls = new Map([
        ['poll_5', {
          id: 'poll_5',
          size: 4
        }]
      ]);

      const count = migrateCourtsStrategyOptions({ activePolls });
      assert.equal(count, 1);
      assert.equal(activePolls.get('poll_5').courtsStrategy, 'none');
    });

    it('should migrate recurring poll schedules to courtsStrategy and prune legacy fields', () => {
      const recurringPolls = new Map([
        ['rec_book', {
          id: 'rec_book',
          courtBookingType: 'pre-book',
          checkCourts: true,
          includeCourts: true
        }],
        ['rec_lookup', {
          id: 'rec_lookup',
          checkCourts: true
        }],
        ['rec_none', {
          id: 'rec_none'
        }]
      ]);

      const count = migrateCourtsStrategyOptions({ recurringPolls });
      assert.equal(count, 3);

      const rBook = recurringPolls.get('rec_book');
      assert.equal(rBook.courtsStrategy, 'book');
      assert.equal(rBook.courtBookingType, undefined);
      assert.equal(rBook.checkCourts, undefined);
      assert.equal(rBook.includeCourts, undefined);

      const rLookup = recurringPolls.get('rec_lookup');
      assert.equal(rLookup.courtsStrategy, 'lookup');
      assert.equal(rLookup.checkCourts, undefined);

      const rNone = recurringPolls.get('rec_none');
      assert.equal(rNone.courtsStrategy, 'none');
    });

    it('should not re-migrate already migrated polls and schedules', () => {
      const activePolls = new Map([
        ['poll_done', {
          id: 'poll_done',
          courtsStrategy: 'book'
        }]
      ]);
      const recurringPolls = new Map([
        ['rec_done', {
          id: 'rec_done',
          courtsStrategy: 'lookup'
        }]
      ]);

      const count = migrateCourtsStrategyOptions({ activePolls, recurringPolls });
      assert.equal(count, 0);
    });
  });

  describe('pollStatusText display', () => {
    it('should display Courts Strategy in pollStatusText', () => {
      const activePolls = new Map([
        ['p1', {
          id: 'p1',
          remoteJid: 'grp1@g.us',
          size: 4,
          when: 'Tomorrow 9am',
          status: 'active',
          courtsStrategy: 'book',
          voteBuffer: new Map(),
          options: ['Player 1', 'Player 2', 'Player 3', 'Player 4']
        }],
        ['p2', {
          id: 'p2',
          remoteJid: 'grp1@g.us',
          size: 4,
          when: 'Tomorrow 9am',
          status: 'active',
          courtsStrategy: 'lookup',
          voteBuffer: new Map(),
          options: ['Player 1', 'Player 2', 'Player 3', 'Player 4']
        }],
        ['p3', {
          id: 'p3',
          remoteJid: 'grp1@g.us',
          size: 4,
          when: 'Tomorrow 9am',
          status: 'active',
          courtsStrategy: 'none',
          voteBuffer: new Map(),
          options: ['Player 1', 'Player 2', 'Player 3', 'Player 4']
        }]
      ]);

      const text1 = pollStatusText('grp1@g.us', { targetId: 'p1' }, { activePolls });
      assert.match(text1, /Courts Strategy: Book/);

      const text2 = pollStatusText('grp1@g.us', { targetId: 'p2' }, { activePolls });
      assert.match(text2, /Courts Strategy: Lookup/);

      const text3 = pollStatusText('grp1@g.us', { targetId: 'p3' }, { activePolls });
      assert.match(text3, /Courts Strategy: None/);
    });
  });
});
