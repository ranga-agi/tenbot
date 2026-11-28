const recurringPollsModule = require('../lib/recurringPolls');
process.env.NODE_ENV = 'test';
const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const scvcc = require('../lib/scvcc');
const groupsConfig = require('../lib/groupsConfig');
const namesStore = require('../lib/names');
namesStore.setName('278081952608440@lid', 'Vijay Parthasarathy', ['VJ']);
namesStore.setName('vik@lid', 'Vik', ['Vik']);
namesStore.setName('deepak@lid', 'DD', ['Deepak']);
namesStore.setName('165777365799110@lid', 'Conrad', [], '14085559110@s.whatsapp.net', 'Conrad Rodricks');
const {
  isValidPlayerCount,
  getNextValidPlayerCount,
  partitionMatchSlots,
  getFirstSlotNumber,
  extractFixedPairsFromText,
  parsePollCreationText,
  extractPollCreationPostTime,
  isPostTimeInFuture,
  handleDirectPollCreation,
  extractNamedPlayersFromTitle,
  resolveManualPollPlayers,
  buildPollReminderText,
  formatReminderHours,
  getSlotNumberForOption,
  checkAndNotifyInvalidSlotVotes,
  handleOnDemandCourtBooking,
  preBookCourtsForMatch,
  checkCourtReleasesForPoll,
  computeCourtReleaseSchedule,
  checkCourtReleases,
  getPollVoters,
  sendPollReminder,
  hasTimeSpecifiedInTitle,
  buildUntimedPollReminderText,
  pollTitleIndicatesGame,
  getDayBefore12pmReminderTime,
  getDayBefore6pmReminderTime,
  getPollDayWord,
  checkAndSendPollReminders,
  handleTriggerReminder,
  handlePollCommand,
  parseTriggerReminderArgs,
  handleQuietHoursCommand,
  pollStatusText,
  createMatchPoll,
  checkAndNotifySlotConflicts,
  interpretManualPollWithLLM,
  parseModifyInstanceCommand,
  handleModifyPollInstance,
  formatLineupGenDesc,
  shouldAutoGenerateLineupOnFill,
  checkPendingLineupGenerations,
  buildLineupReminderText,
  migratePollMatchupOptions,
  handlePauseReminders,
  handleResumeReminders,
  formatCourtTentativeTitleLine,
  cleanupExpiredPolls,
  bufferPendingVote,
  flushPendingPollVotes,
  pendingPollVotes,
  getMessageSecret,
  processPollVoteEvent,
  cancelOrDeletePoll,
  normalizeCourtPreference,
  getCourtPreferenceRank,
  sortCourtsByPreference,
  handleStopPoll,
  handleResumePoll
} = require('../lib/commands/poll');
const { sanitizeActivePolls } = require('../lib/pollStore');
const { extractCommonFlags } = require('../lib/recurringPolls');

describe('pollCommands', () => {
  describe('isValidPlayerCount', () => {
    it('should return true for singles (2) and multiples of 4 (4, 8, 12, 16)', () => {
      assert.equal(isValidPlayerCount(2), true);
      assert.equal(isValidPlayerCount(4), true);
      assert.equal(isValidPlayerCount(8), true);
      assert.equal(isValidPlayerCount(12), true);
      assert.equal(isValidPlayerCount(16), true);
    });

    it('should return false for non-conforming counts', () => {
      assert.equal(isValidPlayerCount(1), false);
      assert.equal(isValidPlayerCount(3), false);
      assert.equal(isValidPlayerCount(5), false);
      assert.equal(isValidPlayerCount(6), false);
      assert.equal(isValidPlayerCount(7), false);
      assert.equal(isValidPlayerCount(9), false);
      assert.equal(isValidPlayerCount(10), false);
    });
  });

  describe('getNextValidPlayerCount', () => {
    it('should map counts <= 2 to 2', () => {
      assert.equal(getNextValidPlayerCount(1), 2);
      assert.equal(getNextValidPlayerCount(2), 2);
    });

    it('should round up to next multiple of 4 for counts > 2', () => {
      assert.equal(getNextValidPlayerCount(3), 4);
      assert.equal(getNextValidPlayerCount(4), 4);
      assert.equal(getNextValidPlayerCount(5), 8);
      assert.equal(getNextValidPlayerCount(7), 8);
      assert.equal(getNextValidPlayerCount(8), 8);
      assert.equal(getNextValidPlayerCount(9), 12);
    });
  });

  describe('getFirstSlotNumber', () => {
    it('should extract slot number from option labels', () => {
      assert.equal(getFirstSlotNumber(['Player 3', 'Player 4']), 3);
      assert.equal(getFirstSlotNumber(['Spot 1', 'Spot 2']), 1);
      assert.equal(getFirstSlotNumber(['4', '5']), 4);
      assert.equal(getFirstSlotNumber(['Court 2']), 2);
    });

    it('should return null for non-numbered options like Yes/No', () => {
      assert.equal(getFirstSlotNumber(['Yes', 'No']), null);
      assert.equal(getFirstSlotNumber([]), null);
      assert.equal(getFirstSlotNumber(null), null);
    });
  });

  describe('extractFixedPairsFromText', () => {
    it('should extract "keeping X and Y in same team"', () => {
      const pairs = extractFixedPairsFromText('Can you generate matchups keeping Alice and Bob in same team?');
      assert.deepEqual(pairs, [['Alice', 'Bob']]);
    });

    it('should extract "with X & Y together"', () => {
      const pairs = extractFixedPairsFromText('!matchups with Mike & Sara together');
      assert.deepEqual(pairs, [['Mike', 'Sara']]);
    });

    it('should extract "partner X with Y"', () => {
      const pairs = extractFixedPairsFromText('draw teams partner John with Alex');
      assert.deepEqual(pairs, [['John', 'Alex']]);
    });

    it('should return empty array when no pairing instructions exist', () => {
      const pairs = extractFixedPairsFromText('!matchups');
      assert.deepEqual(pairs, []);
    });
  });

  describe('parsePollCreationText', () => {
    it('should parse command with size, day, and time', () => {
      const parsed = parsePollCreationText('!createpoll 4 today 6pm');
      assert.ok(parsed);
      assert.equal(parsed.size, 4);
      assert.equal(parsed.dayWord, 'today');
      assert.equal(parsed.timeWord, '6pm');
      assert.equal(parsed.when, 'Today 6pm');
    });

    it('should parse natural language poll creation for singles', () => {
      const parsed = parsePollCreationText('create a poll for 2 tomorrow 9am');
      assert.ok(parsed);
      assert.equal(parsed.size, 2);
      assert.equal(parsed.dayWord, 'tomorrow');
      assert.equal(parsed.timeWord, '9am');
    });

    it('should parse natural language poll creation with word numbers', () => {
      const parsed = parsePollCreationText('create a poll for eight on Saturday 10am');
      assert.ok(parsed);
      assert.equal(parsed.size, 8);
      assert.equal(parsed.dayWord.toLowerCase(), 'saturday');
      assert.equal(parsed.timeWord, '10am');
    });

    it('should parse auto size', () => {
      const parsed = parsePollCreationText('!createpoll auto tomorrow 8am');
      assert.ok(parsed);
      assert.equal(parsed.size, 'auto');
    });

    it('should parse opt-in Yes/No poll when no size is given', () => {
      const parsed = parsePollCreationText('create a poll for tomorrow 9am');
      assert.ok(parsed);
      assert.equal(parsed.size, null);
    });

    it('should parse flags like --no-matchups and --courts-strategy', () => {
      const parsed = parsePollCreationText('!createpoll 4 today 6pm --no-matchups --courts-strategy=lookup');
      assert.ok(parsed);
      assert.equal(parsed.noMatchups, true);
      assert.equal(parsed.courtsStrategy, 'lookup');
      assert.equal(parsed.checkCourts, true);
    });

    it('should parse --pre-allocate-slots flag', () => {
      const parsed = parsePollCreationText('!createpoll auto tomorrow 7pm --pre-allocate-slots');
      assert.ok(parsed);
      assert.equal(parsed.includePrebookedSpots, true);
      assert.equal(parsed['--pre-allocate-slots'], true);
      assert.equal(parsed['pre-allocate-slots'], true);
    });

    it('should parse reminders flags and default to true', () => {
      const parsed1 = parsePollCreationText('!createpoll 4 today 6pm');
      assert.ok(parsed1);
      assert.equal(parsed1.reminders, true);

      const parsed2 = parsePollCreationText('!createpoll 4 today 6pm --no-reminders');
      assert.ok(parsed2);
      assert.equal(parsed2.reminders, false);

      const parsed3 = parsePollCreationText('!createpoll 4 today 6pm --reminders=off');
      assert.ok(parsed3);
      assert.equal(parsed3.reminders, false);
    });

    it('should parse --max-courts option', () => {
      const parsed1 = parsePollCreationText('!createpoll auto tomorrow 7pm --max-courts=3');
      assert.ok(parsed1);
      assert.equal(parsed1.maxCourts, 3);

      const parsed2 = parsePollCreationText('!createpoll auto tomorrow 7pm --max-courts 4');
      assert.ok(parsed2);
      assert.equal(parsed2.maxCourts, 4);

      const parsed3 = parsePollCreationText('!createpoll auto tomorrow 7pm max-courts=2');
      assert.ok(parsed3);
      assert.equal(parsed3.maxCourts, 2);
    });

    it('should return null for non-poll messages', () => {
      assert.equal(parsePollCreationText('who wants to play tennis?'), null);
      assert.equal(parsePollCreationText('!score Mike def John 6-4'), null);
    });
  });

  describe('resolveManualPollPlayers', () => {
    it('should extract named players from title (VJ, Vik, Deepak) and record Vijay Parthasarathy, Vik and DD', () => {
      const pollState = {
        name: 'Tennis at 5 PM Tuesday with VJ, Vik, Deepak',
        type: 'manual',
        size: 4,
        options: ['Player 4'],
        creator: { name: 'Vijay Parthasarathy', jid: '278081952608440@lid' }
      };

      // Before anyone votes on the free slot
      const resultNoVotes = resolveManualPollPlayers(pollState, []);
      assert.deepEqual(resultNoVotes.players, ['Vijay Parthasarathy', 'Vik', 'DD']);
      assert.deepEqual(resultNoVotes.addedFromLabel, ['Vijay Parthasarathy', 'Vik', 'DD']);

      // When a 4th player votes on the open slot
      const resultWithVote = resolveManualPollPlayers(pollState, ['Shan']);
      assert.deepEqual(resultWithVote.players, ['Vijay Parthasarathy', 'Vik', 'DD', 'Shan']);
    });

    it('should handle 1 free voting slot when slot is not numbered', () => {
      const pollState = {
        name: 'Tennis at 5 PM Tuesday with VJ, Vik, Deepak',
        type: 'manual',
        size: 4,
        options: ['1 free slot'],
        creator: { name: 'Vijay Parthasarathy', jid: '278081952608440@lid' }
      };

      const result = resolveManualPollPlayers(pollState, []);
      assert.deepEqual(result.players, ['Vijay Parthasarathy', 'Vik', 'DD']);
    });

    it('should prepend creator if creator not explicitly named in with clause', () => {
      const pollState = {
        name: 'Tennis Tuesday 5pm with Vik, Deepak',
        type: 'manual',
        size: 4,
        options: ['Player 4'],
        creator: { name: 'Vijay Parthasarathy', jid: '278081952608440@lid' }
      };

      const result = resolveManualPollPlayers(pollState, []);
      assert.deepEqual(result.players, ['Vijay Parthasarathy', 'Vik', 'DD']);
    });

    it('should prepend leading creator players if first slot > 1 and no names in title', () => {
      const pollState = {
        name: 'Tennis 7pm',
        type: 'manual',
        size: 4,
        options: ['Player 3', 'Player 4'],
        creator: { name: 'Alice', jid: '123@s.whatsapp.net' }
      };
      const currentPlayers = ['Bob', 'Charlie'];
      const result = resolveManualPollPlayers(pollState, currentPlayers);

      // Slot starts at 3 -> needs 2 leading players: Alice, Alice 2
      assert.equal(result.addedFromLabel.length, 2);
      assert.deepEqual(result.addedFromLabel, ['Alice', 'Alice 2']);
      assert.deepEqual(result.players, ['Alice', 'Alice 2', 'Bob', 'Charlie']);
    });

    it('should not add creator extra players for Yes/No opt-in polls', () => {
      const pollState = {
        type: 'opt_in',
        size: null,
        options: ['Yes', 'No'],
        creator: { name: 'Alice', jid: '123@s.whatsapp.net' }
      };
      const currentPlayers = ['Bob', 'Charlie', 'David'];
      const result = resolveManualPollPlayers(pollState, currentPlayers);

      assert.deepEqual(result.players, ['Bob', 'Charlie', 'David']);
      assert.equal(result.addedCreator, false);
      assert.equal(result.addedExtra.length, 0);
    });
  });

  describe('buildPollReminderText', () => {
    it('should build fixed-slot reminder text', () => {
      const pollState = { when: 'Tomorrow 9am', name: 'Tennis 9am' };
      const text = buildPollReminderText(4, pollState, 2, 4, 'Alice, Bob', false, 0, 4);
      assert.match(text, /Tomorrow 9am/);
      assert.match(text, /2 spots left/i);
    });

    it('should build opt-in reminder text', () => {
      const pollState = { when: 'Tomorrow 9am', name: 'Tennis 9am' };
      const text = buildPollReminderText(4, pollState, 0, 0, 'Alice, Bob', true, 2, 4);
      assert.match(text, /Tomorrow 9am/);
      assert.match(text, /2 player\(s\)/i);
    });

    it('should round to nearest half hour e.g. 10 and half hours to go for 8am reminder for 6:30pm game', () => {
      const pollState = { when: 'Today 6:30pm', name: 'Tennis 6:30pm' };
      // 8am to 6:30pm is 10.5 hours remaining
      const text = buildPollReminderText(16, pollState, 1, 4, 'Alice, Bob, Charlie', false, 0, 10.5);
      assert.match(text, /10 and half Hours to Match Time!/i);

      // Neutral poll
      const neutralPoll = { when: 'Today 6:30pm', name: '6:30pm', isManual: true };
      const neutralText = buildPollReminderText(16, neutralPoll, 1, 4, 'Alice, Bob, Charlie', false, 0, 10.5);
      assert.match(neutralText, /10 and half Hours to Go!/i);
    });

    it('should round to nearest whole hour e.g. 8 hours to go for 10:30am reminder for 6:30pm game', () => {
      const pollState = { when: 'Today 6:30pm', name: 'Tennis 6:30pm' };
      // 10:30am to 6:30pm is 8.0 hours remaining
      const text = buildPollReminderText(8, pollState, 1, 4, 'Alice, Bob, Charlie', false, 0, 8.0);
      assert.match(text, /8 Hours to Match Time!/i);

      // Neutral poll
      const neutralPoll = { when: 'Today 6:30pm', name: '6:30pm', isManual: true };
      const neutralText = buildPollReminderText(8, neutralPoll, 1, 4, 'Alice, Bob, Charlie', false, 0, 8.0);
      assert.match(neutralText, /8 Hours to Go!/i);
    });

    it('should format formatReminderHours correctly for whole and half hours', () => {
      assert.equal(formatReminderHours(10.5), '10 and half');
      assert.equal(formatReminderHours(10.5, true), '10 AND HALF');
      assert.equal(formatReminderHours(8.0), '8');
      assert.equal(formatReminderHours(8.0, true), '8');
      assert.equal(formatReminderHours(2.5), '2 and half');
      assert.equal(formatReminderHours(2.5, true), '2 AND HALF');
      assert.equal(formatReminderHours(10.45), '10 and half');
      assert.equal(formatReminderHours(7.98), '8');
    });
  });

  describe('getSlotNumberForOption', () => {
    it('should extract numeric slot numbers from player option strings', () => {
      assert.equal(getSlotNumberForOption('Player 1', 0), 1);
      assert.equal(getSlotNumberForOption('Player 9', 8), 9);
      assert.equal(getSlotNumberForOption('Player 12', 11), 12);
      assert.equal(getSlotNumberForOption('Slot 8', 7), 8);
    });

    it('should fallback to option index for non-numbered options like spots', () => {
      const pollState = { prebookedPlayers: [{ name: 'Alice' }] };
      assert.equal(getSlotNumberForOption("Bob's Spot", 0, pollState), 1);
      assert.equal(getSlotNumberForOption("Alice's Spot", 1, pollState), 2);
    });

    it('should account for creator leading spot when creator is first slot', () => {
      const pollState = { creator: { name: 'Pramod' } };
      assert.equal(getSlotNumberForOption('Next Player', 0, pollState), 2);
    });
  });

  describe('checkAndNotifyInvalidSlotVotes', () => {
    it('should do nothing when pollState has no slotLimit', async () => {
      const messagesSent = [];
      const mockSock = {
        sendMessage: async (jid, msg) => { messagesSent.push({ jid, msg }); }
      };
      const pollState = { slotLimit: null };
      const aggregated = [{ name: 'Player 9', voters: ['123@s.whatsapp.net'] }];

      const notified = await checkAndNotifyInvalidSlotVotes(mockSock, 'poll1', pollState, aggregated, {});
      assert.equal(notified, false);
      assert.equal(messagesSent.length, 0);
    });

    it('should NOT warn voters if total vote count does not exceed slotLimit even if slot numbers are high', async () => {
      const messagesSent = [];
      const mockSock = {
        sendMessage: async (jid, msg) => { messagesSent.push({ jid, msg }); }
      };
      const pollState = {
        remoteJid: 'group1@g.us',
        slotLimit: 8,
        invalidSlotVotesNotified: []
      };
      // 4 votes total on slots 1, 8, 9, 10 -> total votes (4) <= 8 openings, so no warning!
      const aggregated = [
        { name: 'Player 1', voters: ['voter1@s.whatsapp.net'] },
        { name: 'Player 8', voters: ['voter8@s.whatsapp.net'] },
        { name: 'Player 9', voters: ['1234567890@s.whatsapp.net'] },
        { name: 'Player 10', voters: ['9876543210@s.whatsapp.net'] }
      ];

      const notified = await checkAndNotifyInvalidSlotVotes(mockSock, 'poll123', pollState, aggregated, {});
      assert.equal(notified, false);
      assert.equal(messagesSent.length, 0);
    });

    it('should notify and tag voters only when total vote count exceeds slotLimit with quoted poll', async () => {
      const messagesSent = [];
      const mockSock = {
        sendMessage: async (jid, msg, opts) => {
          messagesSent.push({ jid, msg, opts });
          return { key: { id: 'sent1' } };
        }
      };
      const pollState = {
        remoteJid: 'group1@g.us',
        slotLimit: 8,
        invalidSlotVotesNotified: []
      };
      // 10 votes total for 8 slots -> 9th and 10th exceed available openings
      const aggregated = [
        { name: 'Player 1', voters: ['voter1@s.whatsapp.net'] },
        { name: 'Player 2', voters: ['voter2@s.whatsapp.net'] },
        { name: 'Player 3', voters: ['voter3@s.whatsapp.net'] },
        { name: 'Player 4', voters: ['voter4@s.whatsapp.net'] },
        { name: 'Player 5', voters: ['voter5@s.whatsapp.net'] },
        { name: 'Player 6', voters: ['voter6@s.whatsapp.net'] },
        { name: 'Player 7', voters: ['voter7@s.whatsapp.net'] },
        { name: 'Player 8', voters: ['voter8@s.whatsapp.net'] },
        { name: 'Player 9', voters: ['1234567890@s.whatsapp.net'] },
        { name: 'Player 10', voters: ['9876543210@s.whatsapp.net'] }
      ];

      const notified = await checkAndNotifyInvalidSlotVotes(mockSock, 'poll123', pollState, aggregated, {
        messageStore: new Map([['group1@g.us:poll123', { pollCreation: true }]])
      });

      assert.equal(notified, true);
      assert.equal(messagesSent.length, 2);

      // Verify 9th voter notification
      const msg9 = messagesSent[0];
      assert.equal(msg9.jid, 'group1@g.us');
      assert.match(msg9.msg.text, /@1234567890/);
      assert.match(msg9.msg.text, /all \*8 voting slots\* are already filled/);
      assert.ok(msg9.opts?.quoted?.key?.id === 'poll123');

      // Verify 10th voter notification
      const msg10 = messagesSent[1];
      assert.match(msg10.msg.text, /@9876543210/);
      assert.match(msg10.msg.text, /all \*8 voting slots\* are already filled/);

      // Verify tracking
      assert.deepEqual(pollState.invalidSlotVotesNotified, [
        '1234567890@s.whatsapp.net:8',
        '9876543210@s.whatsapp.net:8'
      ]);

      // Running a second time should not duplicate notifications
      messagesSent.length = 0;
      const reNotified = await checkAndNotifyInvalidSlotVotes(mockSock, 'poll123', pollState, aggregated, {});
      assert.equal(reNotified, false);
      assert.equal(messagesSent.length, 0);
    });
  });

  describe('handleOnDemandCourtBooking', () => {
    it('should successfully book an on-demand court, sending a simple one liner to group and DMs to notifications', async () => {
      const originalBookCourt = scvcc.bookCourt;
      const originalCheckAvail = scvcc.checkCourtAvailability;

      let bookCalledWith = null;
      scvcc.checkCourtAvailability = async () => ({
        slots: [{ time: '10:30am', courts: [{ court: 'Court 1', status: 'available' }] }]
      });
      scvcc.bookCourt = async (params) => {
        bookCalledWith = params;
        return {
          success: true,
          court: 'Court 1',
          date: '10/19/2026',
          time: '10:30am',
          reservationId: 'res-101',
          message: 'Court 1 booked successfully'
        };
      };

      const messagesSent = [];
      const mockSock = {
        sendMessage: async (jid, msg) => { messagesSent.push({ jid, msg }); }
      };

      const pollState = {
        remoteJid: '120363403838804497@g.us',
        targetDateMDY: '10/19/2026',
        queryTime: '10:30am',
        prebookedCourts: [
          { court: 'Court 2', player: 'Player A' },
          { court: 'Court 3', player: 'Player B' }
        ],
        advanceBookedCourts: [
          { court: 'Court 2' },
          { court: 'Court 3' }
        ],
        unbookedCourts: [{ court: 'Court 1' }],
        onDemandBookingInProgress: false
      };

      try {
        await handleOnDemandCourtBooking(mockSock, 'poll101', pollState, [], {});

        assert.ok(bookCalledWith);
        assert.equal(bookCalledWith.court, 'Court 1');
        assert.equal(pollState.prebookedCourts.length, 3);
        assert.equal(pollState.prebookedCourts[2].court, 'Court 1');
        assert.equal(pollState.advanceBookedCourts.length, 3);
        assert.equal(pollState.advanceBookedCourts[2].court, 'Court 1');
        assert.equal(pollState.unbookedCourts.length, 0);
        assert.equal(pollState.onDemandBookingInProgress, false);

        // Verify simple one liner message sent to group chat
        const groupMsg = messagesSent.find((m) => m.jid === '120363403838804497@g.us');
        assert.ok(groupMsg, 'Should send simple one liner message to group chat');
        assert.equal(groupMsg.msg.text, '🎾 *Court 1* is booked! *12 players* can now play.');

        // Verify detailed booking notification (with reservation details) was NOT sent to group chat
        assert.equal(messagesSent.some((m) => m.jid === '120363403838804497@g.us' && m.msg?.text?.includes('booked successfully')), false);

        // Verify DMs were sent only to those in notifications
        const dmMessages = messagesSent.filter((m) => m.jid.endsWith('@lid'));
        assert.ok(dmMessages.length > 0, 'Booking notifications must be sent as DMs to configured notification LIDs');
        for (const dm of dmMessages) {
          assert.notEqual(dm.jid, '120363403838804497@g.us');
          assert.match(dm.msg.text, /Court 1 booked successfully/);
        }
      } finally {
        scvcc.bookCourt = originalBookCourt;
        scvcc.checkCourtAvailability = originalCheckAvail;
      }
    });

    it('should use players who voted so far and default booking players, strictly excluding prebooked court players', async () => {
      const originalBookCourt = scvcc.bookCourt;
      const originalCheckAvail = scvcc.checkCourtAvailability;

      let bookCalledWith = null;
      scvcc.checkCourtAvailability = async () => ({
        slots: [{ time: '10:30am', courts: [{ court: 'Court 1', status: 'available' }] }]
      });
      scvcc.bookCourt = async (params) => {
        bookCalledWith = params;
        return { success: true, court: 'Court 1', date: '10/19/2026', time: '10:30am', message: 'Booked' };
      };

      const mockSock = { sendMessage: async () => {} };
      const pollState = {
        remoteJid: '120363403838804497@g.us',
        targetDateMDY: '10/19/2026',
        queryTime: '10:30am',
        prebookedCourts: [
          { court: 'Court 2', player: 'Kejal Patel' },
          { court: 'Court 3', player: 'Vijay Parthasarathy' }
        ],
        advanceBookedCourts: [
          { court: 'Court 2', players: ['Pramod Immaneni', 'Kejal Patel', 'Conrad Rodricks', 'Somnath Mani'] },
          { court: 'Court 3', players: ['Vijay Parthasarathy', 'Ghufran Ahmed', 'Mausam Bhatt', 'Amit Bhati'] }
        ],
        unbookedCourts: [{ court: 'Court 1' }],
        bookingPlayers: ['Vishal Singh', 'Gaurav Puri', 'Chandra Sekhar Cheruku'],
        onDemandBookingInProgress: false
      };

      // Votes so far from Vishal Singh (voter) and Mehul Kochar (voter)
      const aggregated = [
        { name: 'Player 1', voters: ['voter1@s.whatsapp.net'] },
        { name: 'Player 2', voters: ['voter2@s.whatsapp.net'] }
      ];

      try {
        await handleOnDemandCourtBooking(mockSock, 'poll_players_test', pollState, aggregated, {});

        assert.ok(bookCalledWith);
        const usedPlayers = bookCalledWith.players.map((p) => p.toLowerCase());

        // Must NOT include players already on prebooked courts (Pramod, Kejal, Conrad, Somnath, Vijay, Ghufran, Mausam, Amit)
        assert.equal(usedPlayers.includes('kejal patel'), false, 'Must exclude Kejal Patel');
        assert.equal(usedPlayers.includes('vijay parthasarathy'), false, 'Must exclude Vijay Parthasarathy');
        assert.equal(usedPlayers.includes('somnath mani'), false, 'Must exclude Somnath Mani');
        assert.equal(usedPlayers.includes('ghufran ahmed'), false, 'Must exclude Ghufran Ahmed');

        // Should use available unbooked players (Vishal Singh, Gaurav Puri, Chandra Sekhar Cheruku)
        assert.ok(usedPlayers.some((p) => p.includes('vishal') || p.includes('gaurav') || p.includes('chandra')));
      } finally {
        scvcc.bookCourt = originalBookCourt;
        scvcc.checkCourtAvailability = originalCheckAvail;
      }
    });

    it('should retry booking 2 times (3 attempts total) if initial attempt fails', async () => {
      const originalBookCourt = scvcc.bookCourt;
      const originalCheckAvail = scvcc.checkCourtAvailability;

      let attempts = 0;
      scvcc.checkCourtAvailability = async () => ({
        slots: [{ time: '10:30am', courts: [{ court: 'Court 1', status: 'available' }] }]
      });
      scvcc.bookCourt = async () => {
        attempts++;
        if (attempts < 3) {
          return { success: false, message: 'Temporary reservation failure' };
        }
        return { success: true, court: 'Court 1', date: '10/19/2026', time: '10:30am', message: 'Booked on retry 2' };
      };

      const mockSock = { sendMessage: async () => {} };
      const pollState = {
        remoteJid: 'group1@g.us',
        targetDateMDY: '10/19/2026',
        queryTime: '10:30am',
        prebookedCourts: [{ court: 'Court 2', player: 'Player A' }],
        advanceBookedCourts: [{ court: 'Court 2' }],
        unbookedCourts: [{ court: 'Court 1' }],
        onDemandBookingInProgress: false
      };

      try {
        await handleOnDemandCourtBooking(mockSock, 'poll_retry_test', pollState, [], {});

        assert.equal(attempts, 3, 'Should attempt 3 times (initial + 2 retries)');
        assert.equal(pollState.prebookedCourts.length, 2);
        assert.equal(pollState.prebookedCourts[1].court, 'Court 1');
        assert.equal(pollState.unbookedCourts.length, 0);
      } finally {
        scvcc.bookCourt = originalBookCourt;
        scvcc.checkCourtAvailability = originalCheckAvail;
      }
    });

    it('should handle on-demand booking failure after exhausting all 2 retries', async () => {
      const originalBookCourt = scvcc.bookCourt;
      const originalCheckAvail = scvcc.checkCourtAvailability;

      let attempts = 0;
      scvcc.checkCourtAvailability = async () => ({
        slots: [{ time: '10:30am', courts: [{ court: 'Court 1', status: 'unavailable' }] }]
      });
      scvcc.bookCourt = async () => {
        attempts++;
        return {
          success: false,
          message: 'No courts available at SCVCC'
        };
      };

      const messagesSent = [];
      const mockSock = {
        sendMessage: async (jid, msg, opts) => {
          messagesSent.push({ jid, msg, opts });
          return { key: { id: 'sent-fail' } };
        }
      };

      const pollState = {
        remoteJid: 'group1@g.us',
        targetDateMDY: '10/19/2026',
        queryTime: '10:30am',
        size: 12,
        prebookedCourts: [
          { court: 'Court 2', player: 'Player A' },
          { court: 'Court 3', player: 'Player B' }
        ],
        advanceBookedCourts: [
          { court: 'Court 2' },
          { court: 'Court 3' }
        ],
        unbookedCourts: [{ court: 'Court 1' }],
        invalidSlotVotesNotified: [],
        onDemandBookingInProgress: false
      };

      const aggregated = [
        { name: 'Player 1', voters: ['v1@s.whatsapp.net'] },
        { name: 'Player 2', voters: ['v2@s.whatsapp.net'] },
        { name: 'Player 3', voters: ['v3@s.whatsapp.net'] },
        { name: 'Player 4', voters: ['v4@s.whatsapp.net'] },
        { name: 'Player 5', voters: ['v5@s.whatsapp.net'] },
        { name: 'Player 6', voters: ['v6@s.whatsapp.net'] },
        { name: 'Player 7', voters: ['v7@s.whatsapp.net'] },
        { name: 'Player 8', voters: ['v8@s.whatsapp.net'] },
        { name: 'Player 9', voters: ['1234567890@s.whatsapp.net'] }
      ];

      const origGetNotifs = groupsConfig.getNotifications;
      const origGetBookingNotifs = groupsConfig.getBookingNotifications;
      groupsConfig.getNotifications = () => ['admin1@s.whatsapp.net'];
      groupsConfig.getBookingNotifications = () => ['admin1@s.whatsapp.net'];

      try {
        await handleOnDemandCourtBooking(mockSock, 'poll102', pollState, aggregated, {});

        assert.equal(attempts, 3, 'Should have retried 2 times (3 attempts total)');
        // Court 1 removed from unbooked
        assert.equal(pollState.unbookedCourts.length, 0);
        // Valid slots count = 2 courts * 4 = 8
        assert.equal(pollState.slotLimit, 8);
        assert.equal(pollState.size, 8);
        assert.equal(pollState.onDemandBookingInProgress, false);

        // Message must be posted to the group chat (exactly once, not multiple for retries)
        const courtFailMsgsInGroup = messagesSent.filter(m => m.jid === 'group1@g.us' && m.msg?.text?.includes('Court 1') && m.msg?.text?.includes('8 voting slots'));
        assert.equal(courtFailMsgsInGroup.length, 1, 'Court unavailable message must be sent to the group chat exactly once after all retries');
        assert.equal(courtFailMsgsInGroup[0].msg.text, '⚠️ *Court 1* is no longer available. Only *8 voting slots* are valid for this match poll.');

        // Message MUST be sent to notifications list
        const notifMsg = messagesSent.find(m => m.jid === 'admin1@s.whatsapp.net' && m.msg?.text?.includes('Court 1') && m.msg?.text?.includes('8 voting slots'));
        assert.ok(notifMsg, 'Recipient in notifications list was notified');
        assert.equal(notifMsg.msg.text, '⚠️ *Court 1* is no longer available. Only *8 voting slots* are valid for this match poll.');

        // Voter on Player 9 was tagged that slot is no longer valid
        const invalidSlotMsg = messagesSent.find(m => m.msg?.text?.includes('1234567890'));
        assert.ok(invalidSlotMsg, 'Voter on invalid slot 9 was notified');
        assert.match(invalidSlotMsg.msg.text, /@1234567890.*all \*8 voting slots\* are already filled/);
      } finally {
        scvcc.bookCourt = originalBookCourt;
        scvcc.checkCourtAvailability = originalCheckAvail;
        groupsConfig.getNotifications = origGetNotifs;
        groupsConfig.getBookingNotifications = origGetBookingNotifs;
      }
    });
    it('should book available court first when both unbooked and tentative courts are present', async () => {
      const originalBookCourt = scvcc.bookCourt;
      const originalCheckAvail = scvcc.checkCourtAvailability;

      let bookCalledWith = null;
      scvcc.checkCourtAvailability = async () => ({
        slots: [{
          time: '10:30am',
          courts: [
            { court: 'Court 1', status: 'available', availableMinutes: 90 },
            { court: 'Court 5', status: 'available', availableMinutes: 90 }
          ]
        }]
      });
      scvcc.bookCourt = async (params) => {
        bookCalledWith = params;
        return {
          success: true,
          court: params.court,
          date: '10/19/2026',
          time: '10:30am',
          reservationId: 'res-avail-first',
          message: `${params.court} booked successfully`
        };
      };

      const messagesSent = [];
      const mockSock = {
        sendMessage: async (jid, msg) => { messagesSent.push({ jid, msg }); }
      };

      const pollState = {
        remoteJid: '120363403838804497@g.us',
        targetDateMDY: '10/19/2026',
        queryTime: '10:30am',
        prebookedCourts: [
          { court: 'Court 2', player: 'Player A' }
        ],
        advanceBookedCourts: [
          { court: 'Court 2' }
        ],
        unbookedCourts: [{ court: 'Court 1' }],
        tentativeCourts: [{ court: 'Court 4', title: 'Clinic' }],
        onDemandBookingInProgress: false
      };

      try {
        await handleOnDemandCourtBooking(mockSock, 'poll_avail_first', pollState, [], {});

        assert.ok(bookCalledWith);
        // Must prioritize available court (Court 1) over tentative court (Court 4)
        assert.equal(bookCalledWith.court, 'Court 1');
        assert.equal(pollState.prebookedCourts.length, 2);
        assert.equal(pollState.prebookedCourts[1].court, 'Court 1');
        assert.equal(pollState.prebookedCourts[1].bookingType, 'auto');
        assert.equal(pollState.unbookedCourts.length, 0);
        // Tentative court remains untouched
        assert.equal(pollState.tentativeCourts.length, 1);
        assert.equal(pollState.tentativeCourts[0].court, 'Court 4');

        const groupMsg = messagesSent.find((m) => m.jid === '120363403838804497@g.us');
        assert.ok(groupMsg);
        assert.match(groupMsg.msg.text, /🎾 \*Court 1\* is booked!/);
      } finally {
        scvcc.bookCourt = originalBookCourt;
        scvcc.checkCourtAvailability = originalCheckAvail;
      }
    });

    it('should check and book tentative court when available court booking fails and tentative court is free', async () => {
      const originalBookCourt = scvcc.bookCourt;
      const originalCheckAvail = scvcc.checkCourtAvailability;

      const bookedCourts = [];
      scvcc.checkCourtAvailability = async () => ({
        slots: [{
          time: '10:30am',
          courts: [
            { court: 'Court 1', status: 'prebooked' },
            { court: 'Court 4', status: 'available', availableMinutes: 90 }
          ]
        }]
      });
      scvcc.bookCourt = async (params) => {
        bookedCourts.push(params.court);
        if (params.court === 'Court 1') {
          return { success: false, message: 'Court 1 was taken' };
        }
        return {
          success: true,
          court: params.court,
          date: '10/19/2026',
          time: '10:30am',
          reservationId: 'res-tentative-free',
          message: `${params.court} booked successfully`
        };
      };

      const messagesSent = [];
      const mockSock = {
        sendMessage: async (jid, msg) => { messagesSent.push({ jid, msg }); }
      };

      const pollState = {
        remoteJid: '120363403838804497@g.us',
        targetDateMDY: '10/19/2026',
        queryTime: '10:30am',
        prebookedCourts: [
          { court: 'Court 2', player: 'Player A' }
        ],
        advanceBookedCourts: [
          { court: 'Court 2' }
        ],
        unbookedCourts: [{ court: 'Court 1' }],
        tentativeCourts: [{ court: 'Court 4', title: 'Clinic' }],
        onDemandBookingInProgress: false
      };

      try {
        await handleOnDemandCourtBooking(mockSock, 'poll_tentative_after_fail', pollState, [], {});

        // Tried Court 1 (and retried), then tried Court 4
        assert.ok(bookedCourts.includes('Court 1'));
        assert.ok(bookedCourts.includes('Court 4'));
        // Court 1 removed from unbookedCourts
        assert.equal(pollState.unbookedCourts.length, 0);
        // Court 4 successfully booked and moved to prebookedCourts
        assert.equal(pollState.prebookedCourts.length, 2);
        assert.equal(pollState.prebookedCourts[1].court, 'Court 4');
        assert.equal(pollState.prebookedCourts[1].bookingType, 'auto');
        assert.equal(pollState.tentativeCourts.length, 0);

        const court1FailMsg = messagesSent.find((m) => m.jid === '120363403838804497@g.us' && m.msg?.text?.includes('Court 1'));
        assert.ok(court1FailMsg, 'Court 1 failure message sent to group');
        assert.equal(court1FailMsg.msg.text, '⚠️ *Court 1* is no longer available.');

        const groupMsg = messagesSent.find((m) => m.jid === '120363403838804497@g.us' && m.msg?.text?.includes('Court 4'));
        assert.ok(groupMsg);
        assert.match(groupMsg.msg.text, /🎾 \*Court 4\* is booked!/);
      } finally {
        scvcc.bookCourt = originalBookCourt;
        scvcc.checkCourtAvailability = originalCheckAvail;
      }
    });

    it('should check and book tentative court when poll has only tentative courts and court becomes free', async () => {
      const originalBookCourt = scvcc.bookCourt;
      const originalCheckAvail = scvcc.checkCourtAvailability;

      let bookCalledWith = null;
      scvcc.checkCourtAvailability = async () => ({
        slots: [{
          time: '10:30am',
          courts: [
            { court: 'Court 3', status: 'available', availableMinutes: 90 }
          ]
        }]
      });
      scvcc.bookCourt = async (params) => {
        bookCalledWith = params;
        return {
          success: true,
          court: params.court,
          date: '10/19/2026',
          time: '10:30am',
          reservationId: 'res-tentative-only',
          message: `${params.court} booked successfully`
        };
      };

      const messagesSent = [];
      const mockSock = {
        sendMessage: async (jid, msg) => { messagesSent.push({ jid, msg }); }
      };

      const pollState = {
        remoteJid: '120363403838804497@g.us',
        targetDateMDY: '10/19/2026',
        queryTime: '10:30am',
        prebookedCourts: [
          { court: 'Court 2', player: 'Player A' }
        ],
        advanceBookedCourts: [
          { court: 'Court 2' }
        ],
        unbookedCourts: [],
        tentativeCourts: [{ court: 'Court 3', title: 'Clinic' }],
        onDemandBookingInProgress: false
      };

      try {
        await handleOnDemandCourtBooking(mockSock, 'poll_tentative_only', pollState, [], {});

        assert.ok(bookCalledWith);
        assert.equal(bookCalledWith.court, 'Court 3');
        assert.equal(pollState.prebookedCourts.length, 2);
        assert.equal(pollState.prebookedCourts[1].court, 'Court 3');
        assert.equal(pollState.prebookedCourts[1].bookingType, 'auto');
        assert.equal(pollState.tentativeCourts.length, 0);

        const groupMsg = messagesSent.find((m) => m.jid === '120363403838804497@g.us');
        assert.ok(groupMsg);
        assert.match(groupMsg.msg.text, /🎾 \*Court 3\* is booked!/);
      } finally {
        scvcc.bookCourt = originalBookCourt;
        scvcc.checkCourtAvailability = originalCheckAvail;
      }
    });

    it('should not clamp slotLimit when tentative courts are not free yet', async () => {
      const originalBookCourt = scvcc.bookCourt;
      const originalCheckAvail = scvcc.checkCourtAvailability;

      let bookCalled = false;
      scvcc.checkCourtAvailability = async () => ({
        slots: [{
          time: '10:30am',
          courts: [
            { court: 'Court 3', status: 'prebooked', blockTitle: 'Clinic' }
          ]
        }]
      });
      scvcc.bookCourt = async () => {
        bookCalled = true;
        return { success: false, message: 'Should not be called' };
      };

      const messagesSent = [];
      const mockSock = {
        sendMessage: async (jid, msg) => { messagesSent.push({ jid, msg }); }
      };

      const pollState = {
        remoteJid: '120363403838804497@g.us',
        targetDateMDY: '10/19/2026',
        queryTime: '10:30am',
        size: 8,
        prebookedCourts: [
          { court: 'Court 2', player: 'Player A' }
        ],
        advanceBookedCourts: [
          { court: 'Court 2' }
        ],
        unbookedCourts: [],
        tentativeCourts: [{ court: 'Court 3', title: 'Clinic' }],
        onDemandBookingInProgress: false
      };

      try {
        await handleOnDemandCourtBooking(mockSock, 'poll_tentative_not_free', pollState, [], {});

        assert.equal(bookCalled, false, 'Should not attempt booking when court is not free');
        // Tentative court remains pending
        assert.equal(pollState.tentativeCourts.length, 1);
        assert.equal(pollState.tentativeCourts[0].court, 'Court 3');
        // slotLimit is NOT clamped because tentative court is still waiting
        assert.equal(pollState.slotLimit, undefined);
        assert.equal(pollState.size, 8);
        assert.equal(pollState.onDemandBookingInProgress, false);
      } finally {
        scvcc.bookCourt = originalBookCourt;
        scvcc.checkCourtAvailability = originalCheckAvail;
      }
    });

    it('should not send failure message to group nor limit slots when tentative court booking fails', async () => {
      const originalBookCourt = scvcc.bookCourt;
      const originalCheckAvail = scvcc.checkCourtAvailability;

      let bookAttemptCount = 0;
      scvcc.checkCourtAvailability = async () => ({
        slots: [{
          time: '10:30am',
          courts: [
            { court: 'Court 3', status: 'available', availableMinutes: 90 }
          ]
        }]
      });
      scvcc.bookCourt = async () => {
        bookAttemptCount++;
        return { success: false, message: 'Court taken by another player' };
      };

      const messagesSent = [];
      const mockSock = {
        sendMessage: async (jid, msg) => { messagesSent.push({ jid, msg }); }
      };

      const pollState = {
        remoteJid: '120363403838804497@g.us',
        targetDateMDY: '10/19/2026',
        queryTime: '10:30am',
        size: 8,
        prebookedCourts: [
          { court: 'Court 2', player: 'Player A' }
        ],
        advanceBookedCourts: [
          { court: 'Court 2' }
        ],
        unbookedCourts: [],
        tentativeCourts: [{ court: 'Court 3', title: 'Clinic' }],
        onDemandBookingInProgress: false
      };

      try {
        await handleOnDemandCourtBooking(mockSock, 'poll_tentative_fail_test', pollState, [], {});

        assert.ok(bookAttemptCount > 0, 'Booking should have been attempted');
        // Tentative court is NOT removed from tentativeCourts
        assert.equal(pollState.tentativeCourts.length, 1);
        assert.equal(pollState.tentativeCourts[0].court, 'Court 3');
        // slotLimit is NOT clamped and size remains unchanged
        assert.equal(pollState.slotLimit, undefined);
        assert.equal(pollState.size, 8);
        assert.equal(pollState.onDemandBookingInProgress, false);

        // No failure message sent to group
        const groupMsg = messagesSent.find((m) => m.jid === '120363403838804497@g.us');
        assert.equal(groupMsg, undefined, 'No failure message should be sent to the group chat');
      } finally {
        scvcc.bookCourt = originalBookCourt;
        scvcc.checkCourtAvailability = originalCheckAvail;
      }
    });

    it('should trigger on-demand booking again when the first voting slot corresponding to tentative court is voted on', async () => {
      const crypto = require("crypto");
      const makeOptHash = (name) => crypto.createHash("sha256").update(name).digest();
      const originalBookCourt = scvcc.bookCourt;
      const originalCheckAvail = scvcc.checkCourtAvailability;

      let bookAttemptCount = 0;
      scvcc.checkCourtAvailability = async () => ({
        slots: [{
          time: '10:30am',
          courts: [
            { court: 'Court 3', status: 'available', availableMinutes: 90 }
          ]
        }]
      });
      scvcc.bookCourt = async (params) => {
        bookAttemptCount++;
        return {
          success: true,
          court: 'Court 3',
          date: '10/19/2026',
          time: '10:30am',
          reservationId: 'res-tentative-slot5',
          players: params.players,
          message: 'Court 3 booked successfully'
        };
      };

      const messagesSent = [];
      const mockSock = {
        sendMessage: async (jid, msg) => { messagesSent.push({ jid, msg }); }
      };

      // 1 booked court (Court 2, 4 spots: 1..4), 1 tentative court (Court 3, spots: 5..8)
      // Slots 1-4 already filled, now 5th player votes on Player 5 (first slot of tentative court)
      const options = [
        "Player 1", "Player 2", "Player 3", "Player 4",
        "Player 5 ✱", "Player 6 ✱", "Player 7 ✱", "Player 8 ✱"
      ];
      const pollState = {
        remoteJid: '120363403838804497@g.us',
        targetDateMDY: '10/19/2026',
        queryTime: '10:30am',
        size: 8,
        options,
        prebookedCourts: [
          { court: 'Court 2', player: 'Player A' }
        ],
        advanceBookedCourts: [
          { court: 'Court 2' }
        ],
        unbookedCourts: [],
        tentativeCourts: [{ court: 'Court 3', title: 'Clinic' }],
        onDemandBookingInProgress: false,
        voteBuffer: new Map()
      };

      // 5 voters: voter1..voter4 on slots 1..4, voter5 on slot 5 (tentative court)
      const aggregated = [];
      for (let i = 1; i <= 5; i++) {
        const optName = options[i - 1];
        aggregated.push({ name: optName, voters: [`voter${i}@s.whatsapp.net`] });
        pollState.voteBuffer.set(`voter${i}@s.whatsapp.net`, {
          pollUpdateMessageKey: { remoteJid: '120363403838804497@g.us', participant: `voter${i}@s.whatsapp.net` },
          vote: { selectedOptions: [makeOptHash(optName)] },
          senderTimestampMs: 1000 + i
        });
      }

      const messageStore = new Map([['120363403838804497@g.us:poll_slot5_test', {
        messageContextInfo: { messageSecret: Buffer.from('secret') },
        pollCreationMessage: { options: options.map(o => ({ optionName: o })) }
      }]]);

      try {
        const { processPollVoteEvent } = require('../lib/commands/poll');
        await processPollVoteEvent(mockSock, { id: 'poll_slot5_test', remoteJid: '120363403838804497@g.us' }, [], {
          activePolls: new Map([['poll_slot5_test', pollState]]),
          messageStore,
          persistPolls: () => {}
        });

        // Wait a tick for async background on-demand booking to complete
        await new Promise(r => setTimeout(r, 50));

        assert.ok(bookAttemptCount > 0, 'Booking should have been triggered when slot 5 was voted on');
        // Court 3 booked and moved to prebookedCourts
        assert.equal(pollState.prebookedCourts.length, 2);
        assert.equal(pollState.prebookedCourts[1].court, 'Court 3');
        assert.equal(pollState.tentativeCourts.length, 0);

        const groupMsg = messagesSent.find((m) => m.jid === '120363403838804497@g.us' && m.msg?.text?.includes('Court 3'));
        assert.ok(groupMsg, 'Group should receive announcement that Court 3 is booked');
        assert.match(groupMsg.msg.text, /Court 3.*is booked/);
      } finally {
        scvcc.bookCourt = originalBookCourt;
        scvcc.checkCourtAvailability = originalCheckAvail;
      }
    });

    it('should book available court at candidate look around time specified in courtObj.time and announce with time suffix', async () => {
      const originalBookCourt = scvcc.bookCourt;
      const originalCheckAvail = scvcc.checkCourtAvailability;

      let bookCalledWith = null;
      scvcc.checkCourtAvailability = async ({ time }) => ({
        slots: [{
          time,
          courts: [{ court: 'Court 1', status: 'available', availableMinutes: 90 }]
        }]
      });
      scvcc.bookCourt = async (params) => {
        bookCalledWith = params;
        return {
          success: true,
          court: params.court,
          date: '10/19/2026',
          time: params.time,
          reservationId: 'res-lookaround-ondemand',
          message: `${params.court} booked successfully at ${params.time}`
        };
      };

      const messagesSent = [];
      const mockSock = {
        sendMessage: async (jid, msg) => { messagesSent.push({ jid, msg }); }
      };

      const pollState = {
        remoteJid: '120363403838804497@g.us',
        targetDateMDY: '10/19/2026',
        queryTime: '6:30pm',
        lookAround: '1h',
        prebookedCourts: [
          { court: 'Court 2', player: 'Player A' }
        ],
        advanceBookedCourts: [
          { court: 'Court 2' }
        ],
        unbookedCourts: [{ court: 'Court 1', time: '7:00pm' }],
        onDemandBookingInProgress: false
      };

      try {
        await handleOnDemandCourtBooking(mockSock, 'poll_lookaround_court_time', pollState, [], {});

        assert.ok(bookCalledWith, 'scvcc.bookCourt should have been called');
        assert.equal(bookCalledWith.court, 'Court 1');
        assert.equal(bookCalledWith.time, '7:00pm', 'Should book Court 1 at 7:00pm as specified in unbookedCourts');

        assert.equal(pollState.prebookedCourts.length, 2);
        assert.equal(pollState.prebookedCourts[1].court, 'Court 1');
        assert.equal(pollState.prebookedCourts[1].time, '7:00pm');
        assert.equal(pollState.autoBookedCourts[0].time, '7:00pm');
        assert.equal(pollState.unbookedCourts.length, 0);

        const groupMsg = messagesSent.find((m) => m.jid === '120363403838804497@g.us');
        assert.ok(groupMsg);
        assert.match(groupMsg.msg.text, /🎾 \*Court 1 \(7(:00)?pm\)\* is booked!/);
      } finally {
        scvcc.bookCourt = originalBookCourt;
        scvcc.checkCourtAvailability = originalCheckAvail;
      }
    });

    it('should extract court time from pollState.name if courtObj.time is missing and book at candidate time', async () => {
      const originalBookCourt = scvcc.bookCourt;
      const originalCheckAvail = scvcc.checkCourtAvailability;

      let bookCalledWith = null;
      scvcc.checkCourtAvailability = async ({ time }) => ({
        slots: [{
          time,
          courts: [{ court: 'Court 1', status: 'available', availableMinutes: 90 }]
        }]
      });
      scvcc.bookCourt = async (params) => {
        bookCalledWith = params;
        return {
          success: true,
          court: params.court,
          date: '10/19/2026',
          time: params.time,
          reservationId: 'res-name-time-ondemand',
          message: `${params.court} booked successfully at ${params.time}`
        };
      };

      const messagesSent = [];
      const mockSock = {
        sendMessage: async (jid, msg) => { messagesSent.push({ jid, msg }); }
      };

      const pollState = {
        remoteJid: '120363403838804497@g.us',
        targetDateMDY: '10/19/2026',
        queryTime: '6:30pm',
        lookAround: '1h',
        name: '🎾 Tennis Match (Doubles) - Tomorrow 6:30pm [Court 2 - Booked, Court 1 (7:00pm) - Available]',
        prebookedCourts: [
          { court: 'Court 2', player: 'Player A' }
        ],
        advanceBookedCourts: [
          { court: 'Court 2' }
        ],
        unbookedCourts: [{ court: 'Court 1' }],
        onDemandBookingInProgress: false
      };

      try {
        await handleOnDemandCourtBooking(mockSock, 'poll_lookaround_from_name', pollState, [], {});

        assert.ok(bookCalledWith, 'scvcc.bookCourt should have been called');
        assert.equal(bookCalledWith.court, 'Court 1');
        assert.equal(bookCalledWith.time, '7:00pm', 'Should infer 7:00pm from poll title');

        assert.equal(pollState.prebookedCourts[1].time, '7:00pm');
        const groupMsg = messagesSent.find((m) => m.jid === '120363403838804497@g.us');
        assert.ok(groupMsg);
        assert.match(groupMsg.msg.text, /🎾 \*Court 1 \(7(:00)?pm\)\* is booked!/);
      } finally {
        scvcc.bookCourt = originalBookCourt;
        scvcc.checkCourtAvailability = originalCheckAvail;
      }
    });

    it('should try candidate times in look around window if courtObj.time is not specified and base time fails', async () => {
      const originalBookCourt = scvcc.bookCourt;
      const originalCheckAvail = scvcc.checkCourtAvailability;

      const attemptedTimes = [];
      scvcc.checkCourtAvailability = async ({ time }) => {
        if (time === '6:30pm') {
          return {
            slots: [{ time: '6:30pm', courts: [{ court: 'Court 1', status: 'unavailable' }] }]
          };
        }
        if (time === '7pm') {
          return {
            slots: [{ time: '7pm', courts: [{ court: 'Court 1', status: 'available', availableMinutes: 90 }] }]
          };
        }
        return { slots: [] };
      };
      scvcc.bookCourt = async (params) => {
        attemptedTimes.push(params.time);
        if (params.time === '6:30pm') {
          return { success: false, message: 'Court 1 not available at 6:30pm' };
        }
        return {
          success: true,
          court: params.court,
          date: '10/19/2026',
          time: '7pm',
          reservationId: 'res-candidate-lookaround',
          message: 'Court 1 booked at 7pm'
        };
      };

      const messagesSent = [];
      const mockSock = {
        sendMessage: async (jid, msg) => { messagesSent.push({ jid, msg }); }
      };

      const pollState = {
        remoteJid: '120363403838804497@g.us',
        targetDateMDY: '10/19/2026',
        queryTime: '6:30pm',
        lookAround: '1h',
        prebookedCourts: [{ court: 'Court 2', player: 'Player A' }],
        advanceBookedCourts: [{ court: 'Court 2' }],
        unbookedCourts: [{ court: 'Court 1' }],
        onDemandBookingInProgress: false
      };

      try {
        await handleOnDemandCourtBooking(mockSock, 'poll_lookaround_fallback_time', pollState, [], {});

        assert.ok(attemptedTimes.includes('6:30pm'), 'Should have tried base time 6:30pm');
        assert.ok(attemptedTimes.includes('7pm'), 'Should have proceeded to 7pm in look around window');
        assert.equal(pollState.prebookedCourts.length, 2);
        assert.equal(pollState.prebookedCourts[1].court, 'Court 1');
        assert.equal(pollState.prebookedCourts[1].time, '7pm');

        const groupMsg = messagesSent.find((m) => m.jid === '120363403838804497@g.us');
        assert.ok(groupMsg);
        assert.match(groupMsg.msg.text, /🎾 \*Court 1 \(7(:00)?pm\)\* is booked!/);
      } finally {
        scvcc.bookCourt = originalBookCourt;
        scvcc.checkCourtAvailability = originalCheckAvail;
      }
    });

    it('createMatchPoll should preserve time property on unbookedCourts when court is available at look around time', async () => {
      const originalCheckAvail = scvcc.checkCourtAvailability;
      const originalGetBookings = scvcc.getCourtBookings;

      try {
        scvcc.getCourtBookings = async () => ({ bookings: [] });
        scvcc.checkCourtAvailability = async ({ time }) => {
          if (time === '6:30pm') {
            return {
              slots: [{
                time: '6:30pm',
                courts: [{ court: 'Court 1', status: 'unavailable', availableMinutes: 0 }]
              }]
            };
          }
          if (time === '7pm') {
            return {
              slots: [{
                time: '7pm',
                courts: [{ court: 'Court 1', status: 'available', availableMinutes: 90 }]
              }]
            };
          }
          return { slots: [] };
        };

        const activePolls = new Map();
        const res = await createMatchPoll(
          {
            sendMessage: async (jid, content) => ({
              key: { id: 'poll_unbooked_time_preservation', remoteJid: jid },
              message: content
            })
          },
          '120363402559062529@g.us',
          8,
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
          true,
          false,
          false,
          null,
          null,
          null,
          null,
          null,
          null,
          { activePolls, messageStore: new Map(), latestPollIdByChat: new Map(), persistPolls: () => {} },
          60
        );

        assert.equal(res.err, null);
        const storedPoll = activePolls.get('poll_unbooked_time_preservation');
        assert.ok(storedPoll);
        assert.ok(Array.isArray(storedPoll.unbookedCourts));
        assert.equal(storedPoll.unbookedCourts.length, 1);
        assert.equal(storedPoll.unbookedCourts[0].court, 'Court 1');
        assert.equal(storedPoll.unbookedCourts[0].time, '7pm');
      } finally {
        scvcc.checkCourtAvailability = originalCheckAvail;
        scvcc.getCourtBookings = originalGetBookings;
      }
    });

    it('should correctly calculate player openings when 2 courts are prebooked', () => {
      const bookedCourtsCount = 2;
      const playersPerCourt = 4;
      const bookedCapacity = bookedCourtsCount * playersPerCourt; // 8

      // With 5 votes
      let filledCount = 5;
      let playerOpenings = bookedCapacity - filledCount; // 3
      assert.equal(playerOpenings, 3);
      assert.equal(playerOpenings < 3, false); // does not trigger

      // With 6 votes
      filledCount = 6;
      playerOpenings = bookedCapacity - filledCount; // 2
      assert.equal(playerOpenings, 2);
      assert.equal(playerOpenings < 3, true); // triggers on-demand court booking!
    });
  });

  describe('preBookCourtsForMatch', () => {
    it('should pass minAvailableMinutes: 90 to scvcc.bookCourt when pre-booking courts', async () => {
      const originalBookCourt = scvcc.bookCourt;
      let bookCalledParams = null;

      scvcc.bookCourt = async (params) => {
        bookCalledParams = params;
        return {
          success: true,
          court: 'Court 1',
          players: params.players,
          date: params.date,
          time: params.time,
          reservationId: 'res-prebook-1',
          message: 'Court 1 booked'
        };
      };

      try {
        const res = await preBookCourtsForMatch({
          remoteJid: '120363403838804497@g.us',
          targetDateMDY: '10/22/2026',
          queryTime: '9:00 AM',
          size: 4
        });

        assert.ok(bookCalledParams);
        assert.equal(bookCalledParams.minAvailableMinutes, 90);
        assert.equal(res.advanceBookedCourts.length, 1);
        assert.equal(res.advanceBookedCourts[0].court, 'Court 1');
      } finally {
        scvcc.bookCourt = originalBookCourt;
      }
    });

    it('should pass specific court and minAvailableMinutes: 90 when targetCourt is provided', async () => {
      const originalBookCourt = scvcc.bookCourt;
      let bookCalledParams = null;

      scvcc.bookCourt = async (params) => {
        bookCalledParams = params;
        return {
          success: true,
          court: 'Court 3',
          players: params.players,
          date: params.date,
          time: params.time,
          reservationId: 'res-prebook-2',
          message: 'Court 3 booked'
        };
      };

      try {
        const res = await preBookCourtsForMatch({
          remoteJid: '120363403838804497@g.us',
          targetDateMDY: '10/22/2026',
          queryTime: '9:00 AM',
          court: 'Court 3',
          size: 4
        });

        assert.ok(bookCalledParams);
        assert.equal(bookCalledParams.court, 'Court 3');
        assert.equal(bookCalledParams.minAvailableMinutes, 90);
        assert.equal(res.advanceBookedCourts.length, 1);
        assert.equal(res.advanceBookedCourts[0].court, 'Court 3');
      } finally {
        scvcc.bookCourt = originalBookCourt;
      }
    });

    it('should default pre-book courts to maxCourts when preBookCourts is not specified on an auto poll', async () => {
      const originalBookCourt = scvcc.bookCourt;
      let bookCallCount = 0;

      scvcc.bookCourt = async (params) => {
        bookCallCount++;
        return {
          success: true,
          court: `Court ${bookCallCount}`,
          players: params.players,
          date: params.date,
          time: params.time,
          reservationId: `res-maxfallback-${bookCallCount}`,
          message: `Court ${bookCallCount} booked`
        };
      };

      try {
        const res = await preBookCourtsForMatch({
          remoteJid: '120363403838804497@g.us',
          targetDateMDY: '10/22/2026',
          queryTime: '9:00 AM',
          size: 'auto',
          isAuto: true,
          maxCourts: 2
        });

        assert.equal(bookCallCount, 2, 'Should pre-book 2 courts when maxCourts=2 and preBookCourts is omitted');
        assert.equal(res.advanceBookedCourts.length, 2);
      } finally {
        scvcc.bookCourt = originalBookCourt;
      }
    });

    it('should default pre-book courts to maxCourts when preBookCourts is not specified on a fixed-size poll', async () => {
      const originalBookCourt = scvcc.bookCourt;
      let bookCallCount = 0;

      scvcc.bookCourt = async (params) => {
        bookCallCount++;
        return {
          success: true,
          court: `Court ${bookCallCount}`,
          players: params.players,
          date: params.date,
          time: params.time,
          reservationId: `res-fixedmax-${bookCallCount}`,
          message: `Court ${bookCallCount} booked`
        };
      };

      try {
        const res = await preBookCourtsForMatch({
          remoteJid: '120363403838804497@g.us',
          targetDateMDY: '10/22/2026',
          queryTime: '9:00 AM',
          size: 4,
          isAuto: false,
          maxCourts: 2
        });

        assert.equal(bookCallCount, 2, 'Should pre-book 2 courts when maxCourts=2 and preBookCourts is omitted on a fixed-size poll');
        assert.equal(res.advanceBookedCourts.length, 2);
      } finally {
        scvcc.bookCourt = originalBookCourt;
      }
    });

    it('should keep explicit preBookCourts when specified even if maxCourts is also specified', async () => {
      const originalBookCourt = scvcc.bookCourt;
      let bookCallCount = 0;

      scvcc.bookCourt = async (params) => {
        bookCallCount++;
        return {
          success: true,
          court: `Court ${bookCallCount}`,
          players: params.players,
          date: params.date,
          time: params.time,
          reservationId: `res-explicit-${bookCallCount}`,
          message: `Court ${bookCallCount} booked`
        };
      };

      try {
        const res = await preBookCourtsForMatch({
          remoteJid: '120363403838804497@g.us',
          targetDateMDY: '10/22/2026',
          queryTime: '9:00 AM',
          size: 4,
          isAuto: false,
          preBookCourts: 1,
          maxCourts: 3
        });

        assert.equal(bookCallCount, 1, 'Should preserve explicit preBookCourts=1 despite maxCourts=3');
        assert.equal(res.advanceBookedCourts.length, 1);
      } finally {
        scvcc.bookCourt = originalBookCourt;
      }
    });
  });
  describe('Yes/No opt-in poll reminder with creator Yes vote', () => {
    const crypto = require('crypto');
    const pollStore = require('../lib/pollStore');

    const yesHash = crypto.createHash('sha256').update('Yes').digest();
    const noHash = crypto.createHash('sha256').update('No').digest();

    it('should accurately report 1 player in for creator Yes vote with pollCreationMessage present', async () => {
      const pollId = 'poll_yesno_creator_1';
      const remoteJid = '120363403838804497@g.us';
      const creatorJid = '165777365799110@lid';
      const creatorName = 'Conrad';

      const pollCreationMessage = {
        pollCreationMessage: {
          name: '🎾 Conrad\'s poll: Tomorrow 9am (Vote Yes/No)',
          options: [{ optionName: 'Yes' }, { optionName: 'No' }],
          selectableOptionsCount: 1
        }
      };

      const messageStore = new Map();
      messageStore.set(`${remoteJid}:${pollId}`, pollCreationMessage);

      const voteBuffer = new Map();
      voteBuffer.set(creatorJid, {
        pollUpdateMessageKey: { remoteJid, participant: creatorJid },
        vote: { selectedOptions: [yesHash] }
      });

      const pollState = {
        remoteJid,
        name: '🎾 Conrad\'s poll: Tomorrow 9am (Vote Yes/No)',
        options: ['Yes', 'No'],
        type: 'opt_in',
        size: null,
        when: 'Tomorrow 9am',
        playAt: new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString(),
        status: 'active',
        isManual: false,
        creator: { name: creatorName, jid: creatorJid },
        voteBuffer
      };

      const { interestedPlayers, yesOption } = getPollVoters(pollId, pollState, 'bot@s.whatsapp.net', messageStore);
      assert.equal(interestedPlayers.length, 1);
      assert.equal(interestedPlayers[0], creatorName);
      assert.equal(yesOption.voters.length, 1);

      // Verify reminder message
      let sentMsg = null;
      const mockSock = {
        sendMessage: async (jid, content) => {
          sentMsg = content;
          return { key: { id: 'reminder_1' } };
        }
      };

      const success = await sendPollReminder(mockSock, pollId, pollState, true, { messageStore });
      assert.equal(success, true);
      assert.ok(sentMsg);
      assert.match(sentMsg.text, /1 player\(s\) in/i);
      assert.match(sentMsg.text, /@14085559110/);
      assert.ok(Array.isArray(sentMsg.mentions) && sentMsg.mentions.includes('165777365799110@lid'));
      assert.doesNotMatch(sentMsg.text, /\*0 player\(s\) in\*/i);
    });

    it('should correctly deserialize Uint8Array/Buffer in pollStore and not drop to 0 players', async () => {
      const pollId = 'poll_yesno_creator_revive';
      const remoteJid = '120363403838804497@g.us';
      const creatorJid = '165777365799110@lid';
      const creatorName = 'Conrad';

      const pollCreationMessage = {
        pollCreationMessage: {
          name: '🎾 Tomorrow 10am (Vote Yes/No)',
          options: [{ optionName: 'Yes' }, { optionName: 'No' }],
          selectableOptionsCount: 1
        }
      };

      const messageStore = new Map();
      messageStore.set(`${remoteJid}:${pollId}`, pollCreationMessage);

      const voteBuffer = new Map();
      voteBuffer.set(creatorJid, {
        pollUpdateMessageKey: { remoteJid, participant: creatorJid },
        vote: { selectedOptions: [yesHash] }
      });

      const pollState = {
        remoteJid,
        name: '🎾 Tomorrow 10am (Vote Yes/No)',
        options: ['Yes', 'No'],
        type: 'opt_in',
        size: null,
        when: 'Tomorrow 10am',
        playAt: new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString(),
        status: 'active',
        isManual: true,
        creator: { name: creatorName, jid: creatorJid },
        voteBuffer
      };

      const activePolls = new Map([[pollId, pollState]]);
      const latestPollIdByChat = new Map([[remoteJid, pollId]]);
      const recurringPolls = new Map();

      // Test serialize & deserialize through pollStore save & load
      pollStore.save({ messageStore, activePolls, latestPollIdByChat, recurringPolls }, remoteJid);
      const reloaded = pollStore.loadGroup(remoteJid);
      const reloadedPoll = reloaded.activePolls.get(pollId);

      const { interestedPlayers, yesOption } = getPollVoters(pollId, reloadedPoll, 'bot@s.whatsapp.net', reloaded.messageStore);
      assert.equal(interestedPlayers.length, 1);
      assert.equal(interestedPlayers[0], creatorName);
      assert.equal(yesOption.voters.length, 1);

      let sentMsg = null;
      const mockSock = {
        sendMessage: async (jid, content) => {
          sentMsg = content;
          return { key: { id: 'reminder_revive' } };
        }
      };

      await sendPollReminder(mockSock, pollId, reloadedPoll, true, { messageStore: reloaded.messageStore });
      assert.ok(sentMsg);
      assert.match(sentMsg.text, /1 player\(s\) in/i);
      assert.match(sentMsg.text, /@14085559110/);
      assert.ok(Array.isArray(sentMsg.mentions) && sentMsg.mentions.includes('165777365799110@lid'));
      assert.doesNotMatch(sentMsg.text, /\*0 player\(s\)\*/i);
    });

    it('should find pollCreationMessage via fallback key ending with :pollId', async () => {
      const pollId = 'poll_yesno_fallback_key';
      const creatorJid = '165777365799110@lid';
      const creatorName = 'Conrad';

      const pollCreationMessage = {
        pollCreationMessage: {
          name: 'Tomorrow 9am',
          options: [{ optionName: 'Yes' }, { optionName: 'No' }],
          selectableOptionsCount: 1
        }
      };

      // Stored with different remoteJid prefix
      const messageStore = new Map();
      messageStore.set(`diffGroup@g.us:${pollId}`, pollCreationMessage);

      const voteBuffer = new Map();
      voteBuffer.set(creatorJid, {
        pollUpdateMessageKey: { remoteJid: 'group1@g.us', participant: creatorJid },
        vote: { selectedOptions: [yesHash] }
      });

      const pollState = {
        remoteJid: 'group1@g.us',
        options: ['Yes', 'No'],
        type: 'opt_in',
        size: null,
        when: 'Tomorrow 9am',
        playAt: new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString(),
        status: 'active',
        isManual: false,
        creator: { name: creatorName, jid: creatorJid },
        voteBuffer
      };

      const { interestedPlayers } = getPollVoters(pollId, pollState, 'bot@s.whatsapp.net', messageStore);
      assert.equal(interestedPlayers.length, 1);
      assert.equal(interestedPlayers[0], creatorName);
    });

  });

  describe('checkCourtReleasesForPoll', () => {
    const crypto = require('crypto');
    function makeOptHash(name) {
      return crypto.createHash('sha256').update(name).digest();
    }
    // Mon Oct 19 2026 01:40 PDT -> Tue Oct 20 2026 21:00 PDT (2600 mins; 4h15m cutoff = Tue 16:45 PDT)
    const t0 = new Date('2026-10-19T08:40:00.000Z').getTime();
    const playAt = new Date('2026-10-21T04:00:00.000Z').getTime();
    // 70% = t0 + 1820 mins (Tue 08:00 PDT) | warn = t0 + 1815 mins (Tue 07:55 PDT)
    // 80% = t0 + 2080 mins (Tue 12:20 PDT) | warn = t0 + 2075 mins (Tue 12:15 PDT)
    // 90% = t0 + 2340 mins (Tue 16:40 PDT) | warn = t0 + 2335 mins (Tue 16:35 PDT)

    it('should send 5-min warning and cancel most recent court at 70% mark if 7 players for 3 courts (Example 1)', async () => {
      const messagesSent = [];
      const mockSock = {
        sendMessage: async (jid, msg) => { messagesSent.push({ jid, msg }); }
      };

      const pollState = {
        remoteJid: 'group1@g.us',
        createdAt: new Date(t0).toISOString(),
        playAt: new Date(playAt).toISOString(),
        options: Array.from({ length: 12 }, (_, i) => `Player ${i + 1}`),
        size: 12,
        type: 'fixed',
        status: 'active',
        prebookedCourts: [
          { court: 'Court 1', player: 'P1' },
          { court: 'Court 2', player: 'P2' },
          { court: 'Court 3', player: 'P3' }
        ],
        advanceBookedCourts: [
          { court: 'Court 1', reservationId: 'res-1' },
          { court: 'Court 2', reservationId: 'res-2' },
          { court: 'Court 3', reservationId: 'res-3' }
        ],
        courtReleaseWarningsSent: [],
        courtReleasesDone: [],
        invalidSlotVotesNotified: []
      };

      // 7 votes
      const voteBuffer = new Map();
      for (let i = 1; i <= 7; i++) {
        voteBuffer.set(`voter${i}@s.whatsapp.net`, {
          pollUpdateMessageKey: { remoteJid: 'group1@g.us' },
          pollUpdateMessageKey: { remoteJid: 'group1@g.us', participant: `voter${i}@s.whatsapp.net` },
          vote: { selectedOptions: [makeOptHash(`Player ${i}`)] }
        });
      }
      pollState.voteBuffer = voteBuffer;

      const messageStore = new Map();
      messageStore.set('group1@g.us:poll_ex1', {
        pollCreationMessage: {
          options: pollState.options.map((o) => ({ optionName: o }))
        }
      });

      const context = { messageStore, persistPolls: () => {} };

      // 1. At 5 mins before 70% (T0 + 1815 mins)
      const tWarn70 = t0 + 1815 * 60 * 1000;
      await checkCourtReleasesForPoll(mockSock, 'poll_ex1', pollState, context, tWarn70);

      assert.equal(pollState.courtReleaseWarningsSent.includes(70), true);
      assert.equal(pollState.prebookedCourts.length, 3, 'Court should not be cancelled at warning time');
      const warnMsg = messagesSent.find((m) => m.msg.text.includes('Court 3') && m.msg.text.includes('5 mins'));
      assert.ok(warnMsg, '5-min warning message should be sent for Court 3');

      // 2. At 70% checkpoint (T0 + 1820 mins)
      const tCheck70 = t0 + 1820 * 60 * 1000;
      await checkCourtReleasesForPoll(mockSock, 'poll_ex1', pollState, context, tCheck70);

      assert.equal(pollState.courtReleasesDone.includes(70), true);
      assert.equal(pollState.prebookedCourts.length, 2, 'Court 3 should be cancelled');
      assert.equal(pollState.prebookedCourts.map(c => c.court).includes('Court 3'), false);
      assert.equal(pollState.slotLimit, undefined);
      assert.equal(pollState.size, 12);

      const cancelMsg = messagesSent.find((m) => m.msg.text.includes('Court 3') && m.msg.text.includes('has been cancelled'));
      assert.ok(cancelMsg, 'Cancellation message should be sent for Court 3');
      assert.equal(cancelMsg.msg.text.includes('voting slots'), false);
    });

    it('should not cancel court at 70% mark if players heed warning and fill slots before checkpoint', async () => {
      const messagesSent = [];
      const mockSock = {
        sendMessage: async (jid, msg) => { messagesSent.push({ jid, msg }); }
      };

      const pollState = {
        remoteJid: 'group1@g.us',
        createdAt: new Date(t0).toISOString(),
        playAt: new Date(playAt).toISOString(),
        options: Array.from({ length: 12 }, (_, i) => `Player ${i + 1}`),
        size: 12,
        type: 'fixed',
        status: 'active',
        prebookedCourts: [
          { court: 'Court 1', player: 'P1' },
          { court: 'Court 2', player: 'P2' },
          { court: 'Court 3', player: 'P3' }
        ],
        advanceBookedCourts: [
          { court: 'Court 1', reservationId: 'res-1' },
          { court: 'Court 2', reservationId: 'res-2' },
          { court: 'Court 3', reservationId: 'res-3' }
        ],
        courtReleaseWarningsSent: [],
        courtReleasesDone: [],
        invalidSlotVotesNotified: []
      };

      // Initially 7 votes at warning time
      const voteBuffer = new Map();
      for (let i = 1; i <= 7; i++) {
        voteBuffer.set(`voter${i}@s.whatsapp.net`, {
          pollUpdateMessageKey: { remoteJid: 'group1@g.us' },
          pollUpdateMessageKey: { remoteJid: 'group1@g.us', participant: `voter${i}@s.whatsapp.net` },
          vote: { selectedOptions: [makeOptHash(`Player ${i}`)] }
        });
      }
      pollState.voteBuffer = voteBuffer;

      const messageStore = new Map();
      messageStore.set('group1@g.us:poll_heed', {
        pollCreationMessage: {
          options: pollState.options.map((o) => ({ optionName: o }))
        }
      });
      const context = { messageStore, persistPolls: () => {} };

      // At warning time (T0 + 1815 mins) -> sends warning
      await checkCourtReleasesForPoll(mockSock, 'poll_heed', pollState, context, t0 + 1815 * 60 * 1000);
      assert.equal(pollState.courtReleaseWarningsSent.includes(70), true);

      // Players heed warning! 2 more players vote -> 9 players now (needs 3 courts)
      for (let i = 8; i <= 9; i++) {
        voteBuffer.set(`voter${i}@s.whatsapp.net`, {
          pollUpdateMessageKey: { remoteJid: 'group1@g.us' },
          pollUpdateMessageKey: { remoteJid: 'group1@g.us', participant: `voter${i}@s.whatsapp.net` },
          vote: { selectedOptions: [makeOptHash(`Player ${i}`)] }
        });
      }

      // At checkpoint time (T0 + 1820 mins)
      messagesSent.length = 0;
      await checkCourtReleasesForPoll(mockSock, 'poll_heed', pollState, context, t0 + 1820 * 60 * 1000);

      assert.equal(pollState.courtReleasesDone.includes(70), true);
      assert.equal(pollState.prebookedCourts.length, 3, 'Court 3 should NOT be cancelled because 9 players need 3 courts');
      const cancelMsg = messagesSent.find((m) => m.msg.text.includes('cancelled'));
      assert.equal(cancelMsg, undefined, 'No cancellation message should be sent');
    });

    it('should release one court at 70% and another at 80% if 3 courts booked and 3 votes (Example 2)', async () => {
      const messagesSent = [];
      const mockSock = {
        sendMessage: async (jid, msg) => { messagesSent.push({ jid, msg }); }
      };

      const pollState = {
        remoteJid: 'group1@g.us',
        createdAt: new Date(t0).toISOString(),
        playAt: new Date(playAt).toISOString(),
        options: Array.from({ length: 12 }, (_, i) => `Player ${i + 1}`),
        size: 12,
        type: 'fixed',
        status: 'active',
        prebookedCourts: [
          { court: 'Court 1', player: 'P1' },
          { court: 'Court 2', player: 'P2' },
          { court: 'Court 3', player: 'P3' }
        ],
        advanceBookedCourts: [
          { court: 'Court 1', reservationId: 'res-1' },
          { court: 'Court 2', reservationId: 'res-2' },
          { court: 'Court 3', reservationId: 'res-3' }
        ],
        courtReleaseWarningsSent: [],
        courtReleasesDone: [],
        invalidSlotVotesNotified: []
      };

      // 3 votes
      const voteBuffer = new Map();
      for (let i = 1; i <= 3; i++) {
        voteBuffer.set(`voter${i}@s.whatsapp.net`, {
          pollUpdateMessageKey: { remoteJid: 'group1@g.us' },
          pollUpdateMessageKey: { remoteJid: 'group1@g.us', participant: `voter${i}@s.whatsapp.net` },
          vote: { selectedOptions: [makeOptHash(`Player ${i}`)] }
        });
      }
      pollState.voteBuffer = voteBuffer;

      const messageStore = new Map();
      messageStore.set('group1@g.us:poll_ex2', {
        pollCreationMessage: {
          options: pollState.options.map((o) => ({ optionName: o }))
        }
      });
      const context = { messageStore, persistPolls: () => {} };

      // At 70% checkpoint (T0 + 1820 mins) -> cancels 1 court (Court 3)
      await checkCourtReleasesForPoll(mockSock, 'poll_ex2', pollState, context, t0 + 1820 * 60 * 1000);
      assert.equal(pollState.prebookedCourts.length, 2);
      assert.deepEqual(pollState.prebookedCourts.map(c => c.court), ['Court 1', 'Court 2']);
      assert.equal(pollState.slotLimit, undefined);

      // At 80% warning (T0 + 2075 mins) -> sends warning for Court 2
      await checkCourtReleasesForPoll(mockSock, 'poll_ex2', pollState, context, t0 + 2075 * 60 * 1000);
      assert.equal(pollState.courtReleaseWarningsSent.includes(80), true);
      const warn80 = messagesSent.find((m) => m.msg.text.includes('Court 2') && m.msg.text.includes('5 mins'));
      assert.ok(warn80, 'Warning sent for Court 2 before 80% mark');

      // At 80% checkpoint (T0 + 2080 mins) -> cancels Court 2
      await checkCourtReleasesForPoll(mockSock, 'poll_ex2', pollState, context, t0 + 2080 * 60 * 1000);
      assert.equal(pollState.prebookedCourts.length, 1);
      assert.deepEqual(pollState.prebookedCourts.map(c => c.court), ['Court 1']);
      assert.equal(pollState.slotLimit, undefined);

      // At 90% checkpoint (T0 + 2340 mins) -> 3 players need 1 court, Court 1 stays!
      await checkCourtReleasesForPoll(mockSock, 'poll_ex2', pollState, context, t0 + 2340 * 60 * 1000);
      assert.equal(pollState.prebookedCourts.length, 1);
      assert.equal(pollState.prebookedCourts[0].court, 'Court 1');
    });

    it('should cancel court at 80% if 10 players at 70% dropped to 7 after that (Example 3)', async () => {
      const messagesSent = [];
      const mockSock = {
        sendMessage: async (jid, msg) => { messagesSent.push({ jid, msg }); }
      };

      const pollState = {
        remoteJid: 'group1@g.us',
        createdAt: new Date(t0).toISOString(),
        playAt: new Date(playAt).toISOString(),
        options: Array.from({ length: 12 }, (_, i) => `Player ${i + 1}`),
        size: 12,
        type: 'fixed',
        status: 'active',
        prebookedCourts: [
          { court: 'Court 1', player: 'P1' },
          { court: 'Court 2', player: 'P2' },
          { court: 'Court 3', player: 'P3' }
        ],
        advanceBookedCourts: [
          { court: 'Court 1', reservationId: 'res-1' },
          { court: 'Court 2', reservationId: 'res-2' },
          { court: 'Court 3', reservationId: 'res-3' }
        ],
        courtReleaseWarningsSent: [],
        courtReleasesDone: [],
        invalidSlotVotesNotified: []
      };

      // 10 votes initially
      const voteBuffer = new Map();
      for (let i = 1; i <= 10; i++) {
        voteBuffer.set(`voter${i}@s.whatsapp.net`, {
          pollUpdateMessageKey: { remoteJid: 'group1@g.us' },
          pollUpdateMessageKey: { remoteJid: 'group1@g.us', participant: `voter${i}@s.whatsapp.net` },
          vote: { selectedOptions: [makeOptHash(`Player ${i}`)] }
        });
      }
      pollState.voteBuffer = voteBuffer;

      const messageStore = new Map();
      messageStore.set('group1@g.us:poll_ex3', {
        pollCreationMessage: {
          options: pollState.options.map((o) => ({ optionName: o }))
        }
      });
      const context = { messageStore, persistPolls: () => {} };

      // At 70% mark (T0 + 1820 mins) with 10 players -> no court cancelled
      await checkCourtReleasesForPoll(mockSock, 'poll_ex3', pollState, context, t0 + 1820 * 60 * 1000);
      assert.equal(pollState.prebookedCourts.length, 3);
      assert.equal(pollState.courtReleasesDone.includes(70), true);

      // 3 players unvote -> now 7 players
      voteBuffer.delete('voter8@s.whatsapp.net');
      voteBuffer.delete('voter9@s.whatsapp.net');
      voteBuffer.delete('voter10@s.whatsapp.net');

      // At 80% warning (T0 + 2075 mins) -> sends warning for Court 3
      await checkCourtReleasesForPoll(mockSock, 'poll_ex3', pollState, context, t0 + 2075 * 60 * 1000);
      assert.equal(pollState.courtReleaseWarningsSent.includes(80), true);

      // At 80% checkpoint (T0 + 2080 mins) -> cancels Court 3
      await checkCourtReleasesForPoll(mockSock, 'poll_ex3', pollState, context, t0 + 2080 * 60 * 1000);
      assert.equal(pollState.prebookedCourts.length, 2);
      assert.equal(pollState.courtReleasesDone.includes(80), true);
      assert.deepEqual(pollState.prebookedCourts.map(c => c.court), ['Court 1', 'Court 2']);
      assert.equal(pollState.slotLimit, undefined);
    });

    it('should cancel one court each at 70%, 80%, and 90% if 3 courts booked and 0 votes (Example 4)', async () => {
      const messagesSent = [];
      const mockSock = {
        sendMessage: async (jid, msg) => { messagesSent.push({ jid, msg }); }
      };

      const pollState = {
        remoteJid: 'group1@g.us',
        createdAt: new Date(t0).toISOString(),
        playAt: new Date(playAt).toISOString(),
        options: Array.from({ length: 12 }, (_, i) => `Player ${i + 1}`),
        size: 12,
        type: 'fixed',
        status: 'active',
        prebookedCourts: [
          { court: 'Court 1', player: 'P1' },
          { court: 'Court 2', player: 'P2' },
          { court: 'Court 3', player: 'P3' }
        ],
        advanceBookedCourts: [
          { court: 'Court 1', reservationId: 'res-1' },
          { court: 'Court 2', reservationId: 'res-2' },
          { court: 'Court 3', reservationId: 'res-3' }
        ],
        courtReleaseWarningsSent: [],
        courtReleasesDone: [],
        invalidSlotVotesNotified: [],
        voteBuffer: new Map()
      };

      const messageStore = new Map();
      messageStore.set('group1@g.us:poll_ex4', {
        pollCreationMessage: {
          options: pollState.options.map((o) => ({ optionName: o }))
        }
      });
      const context = { messageStore, persistPolls: () => {} };

      // At 70% checkpoint -> cancels Court 3
      await checkCourtReleasesForPoll(mockSock, 'poll_ex4', pollState, context, t0 + 1820 * 60 * 1000);
      assert.equal(pollState.prebookedCourts.length, 2);
      assert.equal(pollState.prebookedCourts.map(c => c.court).includes('Court 3'), false);

      // At 80% checkpoint -> cancels Court 2
      await checkCourtReleasesForPoll(mockSock, 'poll_ex4', pollState, context, t0 + 2080 * 60 * 1000);
      assert.equal(pollState.prebookedCourts.length, 1);
      assert.equal(pollState.prebookedCourts.map(c => c.court).includes('Court 2'), false);

      // At 90% checkpoint -> cancels Court 1
      await checkCourtReleasesForPoll(mockSock, 'poll_ex4', pollState, context, t0 + 2340 * 60 * 1000);
      assert.equal(pollState.prebookedCourts.length, 0);
      assert.equal(pollState.status, 'stopped');
      assert.equal(pollState.slotLimit, undefined);
    });

    it('should ensure no extra courts remaining at 90% by cancelling multiple courts at once (Example 5)', async () => {
      const messagesSent = [];
      const mockSock = {
        sendMessage: async (jid, msg) => { messagesSent.push({ jid, msg }); }
      };

      const pollState = {
        remoteJid: 'group1@g.us',
        createdAt: new Date(t0).toISOString(),
        playAt: new Date(playAt).toISOString(),
        options: Array.from({ length: 12 }, (_, i) => `Player ${i + 1}`),
        size: 12,
        type: 'fixed',
        status: 'active',
        prebookedCourts: [
          { court: 'Court 1', player: 'P1' },
          { court: 'Court 2', player: 'P2' },
          { court: 'Court 3', player: 'P3' }
        ],
        advanceBookedCourts: [
          { court: 'Court 1', reservationId: 'res-1' },
          { court: 'Court 2', reservationId: 'res-2' },
          { court: 'Court 3', reservationId: 'res-3' }
        ],
        courtReleaseWarningsSent: [70, 80],
        courtReleasesDone: [70, 80],
        invalidSlotVotesNotified: []
      };

      // Only 2 players voted (needs 1 court). 3 courts booked -> 2 extra courts!
      const voteBuffer = new Map();
      for (let i = 1; i <= 2; i++) {
        voteBuffer.set(`voter${i}@s.whatsapp.net`, {
          pollUpdateMessageKey: { remoteJid: 'group1@g.us' },
          pollUpdateMessageKey: { remoteJid: 'group1@g.us', participant: `voter${i}@s.whatsapp.net` },
          vote: { selectedOptions: [makeOptHash(`Player ${i}`)] }
        });
      }
      pollState.voteBuffer = voteBuffer;

      const messageStore = new Map();
      messageStore.set('group1@g.us:poll_multi', {
        pollCreationMessage: {
          options: pollState.options.map((o) => ({ optionName: o }))
        }
      });
      const context = { messageStore, persistPolls: () => {} };

      // At 90% checkpoint (T0 + 2340 mins) -> cancels both Court 3 and Court 2 at once!
      await checkCourtReleasesForPoll(mockSock, 'poll_multi', pollState, context, t0 + 2340 * 60 * 1000);
      assert.equal(pollState.prebookedCourts.length, 1);
      assert.deepEqual(pollState.prebookedCourts.map(c => c.court), ['Court 1']);
      assert.equal(pollState.slotLimit, undefined);

      const cancelMsg = messagesSent.find((m) => m.msg.text.includes('Court 3 and Court 2') || (m.msg.text.includes('Court 3') && m.msg.text.includes('Court 2')));
      assert.ok(cancelMsg, 'Cancellation message mentions multiple courts');
    });

    it('should combine votes across split sibling polls (12 + 4 slots, 9 + 4 = 13 votes) so all 4 courts are kept', async () => {
      const messagesSent = [];
      const cancelledResIds = [];
      const origCancel = scvcc.cancelCourtReservation;
      scvcc.cancelCourtReservation = async (resId) => {
        cancelledResIds.push(resId);
        return { success: true };
      };

      const mockSock = {
        sendMessage: async (jid, msg) => { messagesSent.push({ jid, msg }); }
      };

      const courts = [
        { court: 'Court 1', player: 'P1' },
        { court: 'Court 2', player: 'P2' },
        { court: 'Court 3', player: 'P3' },
        { court: 'Court 4', player: 'P4' }
      ];
      const advCourts = [
        { court: 'Court 1', reservationId: 'res-1' },
        { court: 'Court 2', reservationId: 'res-2' },
        { court: 'Court 3', reservationId: 'res-3' },
        { court: 'Court 4', reservationId: 'res-4' }
      ];

      const part1 = {
        remoteJid: 'group1@g.us',
        createdAt: new Date(t0).toISOString(),
        playAt: new Date(playAt).toISOString(),
        options: Array.from({ length: 12 }, (_, i) => `Player ${i + 1}`),
        size: 12,
        type: 'fixed',
        status: 'active',
        parentPollId: 'session_16_split',
        partNumber: 1,
        totalParts: 2,
        prebookedCourts: courts.map((c) => ({ ...c })),
        advanceBookedCourts: advCourts.map((c) => ({ ...c })),
        courtReleaseWarningsSent: [],
        courtReleasesDone: [],
        invalidSlotVotesNotified: [],
        voteBuffer: new Map()
      };
      for (let i = 1; i <= 9; i++) {
        part1.voteBuffer.set(`voter${i}@s.whatsapp.net`, {
          pollUpdateMessageKey: { remoteJid: 'group1@g.us', participant: `voter${i}@s.whatsapp.net` },
          vote: { selectedOptions: [makeOptHash(`Player ${i}`)] }
        });
      }

      const part2 = {
        remoteJid: 'group1@g.us',
        createdAt: new Date(t0).toISOString(),
        playAt: new Date(playAt).toISOString(),
        options: Array.from({ length: 4 }, (_, i) => `Player ${13 + i}`),
        size: 4,
        type: 'fixed',
        status: 'filled',
        parentPollId: 'session_16_split',
        partNumber: 2,
        totalParts: 2,
        prebookedCourts: courts.map((c) => ({ ...c })),
        advanceBookedCourts: advCourts.map((c) => ({ ...c })),
        courtReleaseWarningsSent: [],
        courtReleasesDone: [],
        invalidSlotVotesNotified: [],
        voteBuffer: new Map()
      };
      for (let i = 10; i <= 13; i++) {
        part2.voteBuffer.set(`voter${i}@s.whatsapp.net`, {
          pollUpdateMessageKey: { remoteJid: 'group1@g.us', participant: `voter${i}@s.whatsapp.net` },
          vote: { selectedOptions: [makeOptHash(`Player ${i + 3}`)] }
        });
      }

      const messageStore = new Map([
        ['group1@g.us:poll_split_1', { pollCreationMessage: { options: part1.options.map((o) => ({ optionName: o })) } }],
        ['group1@g.us:poll_split_2', { pollCreationMessage: { options: part2.options.map((o) => ({ optionName: o })) } }]
      ]);
      const activePolls = new Map([
        ['poll_split_1', part1],
        ['poll_split_2', part2]
      ]);
      const context = { activePolls, messageStore, persistPolls: () => {} };

      try {
        await checkCourtReleases(mockSock, context, t0 + 1815 * 60 * 1000); // 70% warn
        await checkCourtReleases(mockSock, context, t0 + 1820 * 60 * 1000); // 70%
        await checkCourtReleases(mockSock, context, t0 + 2075 * 60 * 1000); // 80% warn
        await checkCourtReleases(mockSock, context, t0 + 2080 * 60 * 1000); // 80%
        await checkCourtReleases(mockSock, context, t0 + 2340 * 60 * 1000); // 90%

        assert.deepEqual(cancelledResIds, [], 'Must NOT cancel any court when 13 total voters need 4 courts');
        assert.equal(part1.prebookedCourts.length, 4);
        assert.equal(part2.prebookedCourts.length, 4);
        assert.equal(messagesSent.length, 0, 'Must NOT send insufficient-player warnings or cancellation notices');
      } finally {
        scvcc.cancelCourtReservation = origCancel;
      }
    });

    it('should sync released courts and milestones across split siblings and avoid duplicate cancellations', async () => {
      const messagesSent = [];
      const cancelledResIds = [];
      const origCancel = scvcc.cancelCourtReservation;
      scvcc.cancelCourtReservation = async (resId) => {
        cancelledResIds.push(resId);
        return { success: true };
      };

      const mockSock = {
        sendMessage: async (jid, msg) => { messagesSent.push({ jid, msg }); }
      };

      const makePart = (partNumber, optNames) => ({
        remoteJid: 'group1@g.us',
        createdAt: new Date(t0).toISOString(),
        playAt: new Date(playAt).toISOString(),
        options: optNames,
        size: optNames.length,
        type: 'fixed',
        status: 'active',
        parentPollId: 'session_split_underfill',
        partNumber,
        totalParts: 2,
        prebookedCourts: [
          { court: 'Court 1', player: 'P1' },
          { court: 'Court 2', player: 'P2' },
          { court: 'Court 3', player: 'P3' },
          { court: 'Court 4', player: 'P4' }
        ],
        advanceBookedCourts: [
          { court: 'Court 1', reservationId: 'res-1' },
          { court: 'Court 2', reservationId: 'res-2' },
          { court: 'Court 3', reservationId: 'res-3' },
          { court: 'Court 4', reservationId: 'res-4' }
        ],
        courtReleaseWarningsSent: [],
        courtReleasesDone: [],
        invalidSlotVotesNotified: [],
        voteBuffer: new Map()
      });

      const part1 = makePart(1, Array.from({ length: 12 }, (_, i) => `Player ${i + 1}`));
      const part2 = makePart(2, Array.from({ length: 4 }, (_, i) => `Player ${13 + i}`));

      // 5 voters in part 1 + 2 unique voters in part 2 + 1 duplicate voter (voter5) in part 2 = 7 unique voters -> needs 2 courts
      for (let i = 1; i <= 5; i++) {
        part1.voteBuffer.set(`voter${i}@s.whatsapp.net`, {
          pollUpdateMessageKey: { remoteJid: 'group1@g.us', participant: `voter${i}@s.whatsapp.net` },
          vote: { selectedOptions: [makeOptHash(`Player ${i}`)] }
        });
      }
      part2.voteBuffer.set('voter5@s.whatsapp.net', {
        pollUpdateMessageKey: { remoteJid: 'group1@g.us', participant: 'voter5@s.whatsapp.net' },
        vote: { selectedOptions: [makeOptHash('Player 13')] }
      });
      part2.voteBuffer.set('voter6@s.whatsapp.net', {
        pollUpdateMessageKey: { remoteJid: 'group1@g.us', participant: 'voter6@s.whatsapp.net' },
        vote: { selectedOptions: [makeOptHash('Player 14')] }
      });
      part2.voteBuffer.set('voter7@s.whatsapp.net', {
        pollUpdateMessageKey: { remoteJid: 'group1@g.us', participant: 'voter7@s.whatsapp.net' },
        vote: { selectedOptions: [makeOptHash('Player 15')] }
      });

      const messageStore = new Map([
        ['group1@g.us:poll_u1', { pollCreationMessage: { options: part1.options.map((o) => ({ optionName: o })) } }],
        ['group1@g.us:poll_u2', { pollCreationMessage: { options: part2.options.map((o) => ({ optionName: o })) } }]
      ]);
      const activePolls = new Map([
        ['poll_u1', part1],
        ['poll_u2', part2]
      ]);
      const context = { activePolls, messageStore, persistPolls: () => {} };

      try {
        // 70% checkpoint via checkCourtReleases -> cancels Court 4 once and syncs to part2
        await checkCourtReleases(mockSock, context, t0 + 1820 * 60 * 1000);
        assert.deepEqual(cancelledResIds, ['res-4']);
        assert.deepEqual(part1.prebookedCourts.map((c) => c.court), ['Court 1', 'Court 2', 'Court 3']);
        assert.deepEqual(part2.prebookedCourts.map((c) => c.court), ['Court 1', 'Court 2', 'Court 3']);

        // Direct check on part2 at 80% -> cancels Court 3 once (7 unique voters need 2 courts, NOT 1)
        await checkCourtReleasesForPoll(mockSock, 'poll_u2', part2, context, t0 + 2080 * 60 * 1000);
        assert.deepEqual(cancelledResIds, ['res-4', 'res-3']);
        assert.deepEqual(part1.prebookedCourts.map((c) => c.court), ['Court 1', 'Court 2']);
        assert.deepEqual(part2.prebookedCourts.map((c) => c.court), ['Court 1', 'Court 2']);

        // 90% checkpoint -> 7 unique voters need 2 courts, so Court 1 and Court 2 remain!
        await checkCourtReleases(mockSock, context, t0 + 2340 * 60 * 1000);
        assert.deepEqual(cancelledResIds, ['res-4', 'res-3']);
        assert.equal(part1.prebookedCourts.length, 2);
        assert.equal(part2.prebookedCourts.length, 2);
        assert.equal(messagesSent.filter((m) => m.msg.text.includes('has been cancelled')).length, 2);
      } finally {
        scvcc.cancelCourtReservation = origCancel;
      }
    });

    it('should halt automatic court releases when stopped via !stoppoll and resume them via !resumepoll', async () => {
      const messagesSent = [];
      const cancelledResIds = [];
      const origCancel = scvcc.cancelCourtReservation;
      scvcc.cancelCourtReservation = async (resId) => {
        cancelledResIds.push(resId);
        return { success: true };
      };

      const mockSock = {
        sendMessage: async (jid, msg) => { messagesSent.push({ jid, msg }); },
        groupMetadata: async () => ({ participants: [{ id: 'alice@s.whatsapp.net', admin: 'admin' }] })
      };

      const pollState = {
        remoteJid: 'group1@g.us',
        name: 'Stopped Poll Match',
        createdAt: new Date(t0).toISOString(),
        playAt: new Date(playAt).toISOString(),
        options: Array.from({ length: 8 }, (_, i) => `Player ${i + 1}`),
        size: 8,
        type: 'fixed',
        status: 'active',
        creator: { name: 'Alice', jid: 'alice@s.whatsapp.net' },
        prebookedCourts: [
          { court: 'Court 1', player: 'P1' },
          { court: 'Court 2', player: 'P2' }
        ],
        advanceBookedCourts: [
          { court: 'Court 1', reservationId: 'res-1' },
          { court: 'Court 2', reservationId: 'res-2' }
        ],
        courtReleaseWarningsSent: [],
        courtReleasesDone: [],
        invalidSlotVotesNotified: [],
        voteBuffer: new Map([
          ['voter1@s.whatsapp.net', { pollUpdateMessageKey: { remoteJid: 'group1@g.us', participant: 'voter1@s.whatsapp.net' }, vote: { selectedOptions: [makeOptHash('Player 1')] } }]
        ])
      };

      const messageStore = new Map([
        ['group1@g.us:poll_stop_test', { pollCreationMessage: { options: pollState.options.map((o) => ({ optionName: o })) } }]
      ]);
      const activePolls = new Map([['poll_stop_test', pollState]]);
      const latestPollIdByChat = new Map([['group1@g.us', 'poll_stop_test']]);
      const context = { activePolls, latestPollIdByChat, messageStore, persistPolls: () => {} };

      try {
        const stopReply = await handlePollCommand(mockSock, '!stoppoll', 'group1@g.us', 'Alice', 'alice@s.whatsapp.net', { key: { participant: 'alice@s.whatsapp.net' } }, context);
        assert.match(stopReply, /automatic court releases are halted/i);
        assert.equal(pollState.status, 'stopped');

        // While stopped, neither warnings nor cancellations occur across 70%, 80%, 90%
        await checkCourtReleases(mockSock, context, t0 + 1815 * 60 * 1000);
        await checkCourtReleases(mockSock, context, t0 + 1820 * 60 * 1000);
        await checkCourtReleases(mockSock, context, t0 + 2080 * 60 * 1000);
        await checkCourtReleasesForPoll(mockSock, 'poll_stop_test', pollState, context, t0 + 2340 * 60 * 1000);

        assert.deepEqual(cancelledResIds, []);
        assert.equal(pollState.prebookedCourts.length, 2);
        assert.equal(messagesSent.length, 0);
        assert.deepEqual(pollState.courtReleasesDone, []);

        // After !resumepoll, automatic court releases resume and release extra court
        const resumeReply = await handleResumePoll(mockSock, 'group1@g.us', 'Alice', 'alice@s.whatsapp.net', null, context);
        assert.match(resumeReply, /automatic court releases are active/i);
        assert.equal(pollState.status, 'active');

        await checkCourtReleasesForPoll(mockSock, 'poll_stop_test', pollState, context, t0 + 2340 * 60 * 1000);
        assert.deepEqual(cancelledResIds, ['res-2']);
        assert.equal(pollState.prebookedCourts.length, 1);
      } finally {
        scvcc.cancelCourtReservation = origCancel;
      }
    });

    it('should stop and resume all split sibling polls on !stoppoll / !resumepoll and halt court releases', async () => {
      const cancelledResIds = [];
      const origCancel = scvcc.cancelCourtReservation;
      scvcc.cancelCourtReservation = async (resId) => {
        cancelledResIds.push(resId);
        return { success: true };
      };

      const mockSock = {
        sendMessage: async () => {},
        groupMetadata: async () => ({ participants: [{ id: 'alice@s.whatsapp.net', admin: 'admin' }] })
      };

      const makeSplit = (partNumber, size, status) => ({
        remoteJid: 'group1@g.us',
        name: `Split Stop Part ${partNumber}`,
        createdAt: new Date(t0).toISOString(),
        playAt: new Date(playAt).toISOString(),
        options: Array.from({ length: size }, (_, i) => `Player ${i + 1}`),
        size,
        type: 'fixed',
        status,
        parentPollId: 'session_stop_split',
        partNumber,
        totalParts: 2,
        creator: { name: 'Alice', jid: 'alice@s.whatsapp.net' },
        prebookedCourts: [{ court: 'Court 1', player: 'P1' }, { court: 'Court 2', player: 'P2' }, { court: 'Court 3', player: 'P3' }, { court: 'Court 4', player: 'P4' }],
        advanceBookedCourts: [{ court: 'Court 1', reservationId: 'res-1' }, { court: 'Court 2', reservationId: 'res-2' }, { court: 'Court 3', reservationId: 'res-3' }, { court: 'Court 4', reservationId: 'res-4' }],
        courtReleaseWarningsSent: [],
        courtReleasesDone: [],
        voteBuffer: new Map()
      });

      const part1 = makeSplit(1, 12, 'filled');
      for (let i = 1; i <= 11; i++) {
        part1.voteBuffer.set(`v${i}@s.whatsapp.net`, { pollUpdateMessageKey: { remoteJid: 'group1@g.us', participant: `v${i}@s.whatsapp.net` }, vote: { selectedOptions: [makeOptHash(`Player ${i}`)] } });
      }
      const part2 = makeSplit(2, 4, 'active');

      const activePolls = new Map([['poll_ss_1', part1], ['poll_ss_2', part2]]);
      const latestPollIdByChat = new Map([['group1@g.us', 'poll_ss_1']]);
      const context = { activePolls, latestPollIdByChat, messageStore: new Map(), persistPolls: () => {} };

      try {
        await handleStopPoll(mockSock, 'group1@g.us', 'Alice', 'alice@s.whatsapp.net', null, context);
        assert.equal(part1.status, 'stopped');
        assert.equal(part2.status, 'stopped');

        await checkCourtReleases(mockSock, context, t0 + 2340 * 60 * 1000);
        assert.deepEqual(cancelledResIds, []);
        assert.equal(part1.prebookedCourts.length, 4);
        assert.equal(part2.prebookedCourts.length, 4);

        await handleResumePoll(mockSock, 'group1@g.us', 'Alice', 'alice@s.whatsapp.net', null, context);
        assert.equal(part1.status, 'filled');
        assert.equal(part2.status, 'active');
      } finally {
        scvcc.cancelCourtReservation = origCancel;
      }
    });

    describe('cutoff & quiet-hours aware release scheduling', () => {
      const courtCommands = require('../lib/commands/courtCommands');
      const quietDefault = groupsConfig.parseQuietHours('22:00-07:00');
      const quietOff = groupsConfig.parseQuietHours('off');

      it('collapses 70% and 80% when both land in the same quiet-hours window to 07:05 AM while preserving 90%', () => {
        // Wed 2026-10-21 10:00 PDT -> Fri 2026-10-23 18:00 PDT (56h)
        // Raw 70% = Fri 01:12 PDT, Raw 80% = Fri 06:48 PDT (both in 22:00-07:00 quiet window -> shift to Fri 07:05 PDT)
        // Raw 90% = Fri 12:24 PDT (outside quiet hours, <= Fri 13:45 PDT cutoff)
        const createdAtMs = new Date('2026-10-21T17:00:00.000Z').getTime();
        const playAtMs = new Date('2026-10-24T01:00:00.000Z').getTime();
        const sched = computeCourtReleaseSchedule(
          { createdAt: new Date(createdAtMs).toISOString(), playAt: new Date(playAtMs).toISOString(), remoteJid: 'group1@g.us' },
          { quietHours: quietDefault, cutoffMinutes: 240, safetyBufferMinutes: 15 }
        );

        assert.equal(sched.withinCutoffAtCreation, false);
        assert.equal(sched.optionBApplied, false);
        assert.deepEqual(sched.checkpoints.map((c) => c.milestone), [80, 90]);
        assert.equal(sched.checkpoints[0].checkpointTime, new Date('2026-10-23T14:05:00.000Z').getTime());
        assert.equal(sched.checkpoints[0].warningTime, new Date('2026-10-23T14:00:00.000Z').getTime());
        assert.equal(sched.checkpoints[1].checkpointTime, new Date('2026-10-23T19:24:00.000Z').getTime());
      });

      it('keeps all three milestones 70/80/90 exact when all fall in waking hours before cutoff', () => {
        // Mon 01:40 PDT -> Tue 21:00 PDT (2600m)
        const sched = computeCourtReleaseSchedule(
          { createdAt: new Date(t0).toISOString(), playAt: new Date(playAt).toISOString(), remoteJid: 'group1@g.us' },
          { quietHours: quietDefault, cutoffMinutes: 240, safetyBufferMinutes: 15 }
        );
        assert.deepEqual(sched.checkpoints.map((c) => c.milestone), [70, 80, 90]);
        assert.equal(sched.checkpoints[0].checkpointTime, t0 + 1820 * 60 * 1000);
        assert.equal(sched.checkpoints[1].checkpointTime, t0 + 2080 * 60 * 1000);
        assert.equal(sched.checkpoints[2].checkpointTime, t0 + 2340 * 60 * 1000);
      });

      it('caps medium-lead poll 90% checkpoint at T-4h15m while keeping earlier milestones intact', () => {
        // Created Wed 2026-10-21 08:00 PDT -> Thu 2026-10-22 19:00 PDT (35h; raw 90% = 15:30 PDT, latestSafe = 14:45 PDT)
        const cMs = new Date('2026-10-21T15:00:00.000Z').getTime();
        const pMs = new Date('2026-10-23T02:00:00.000Z').getTime();
        const sched = computeCourtReleaseSchedule(
          { createdAt: new Date(cMs).toISOString(), playAt: new Date(pMs).toISOString(), remoteJid: 'group1@g.us' },
          { quietHours: quietDefault, cutoffMinutes: 240, safetyBufferMinutes: 15 }
        );
        assert.equal(sched.withinCutoffAtCreation, false);
        assert.deepEqual(sched.checkpoints.map((c) => c.milestone), [70, 80, 90]);
        // 70% = Thu 08:30 PDT, 80% = Thu 12:00 PDT, 90% capped to Thu 14:45 PDT (warn 14:40 PDT)
        assert.equal(sched.checkpoints[0].checkpointTime, new Date('2026-10-22T15:30:00.000Z').getTime());
        assert.equal(sched.checkpoints[1].checkpointTime, new Date('2026-10-22T19:00:00.000Z').getTime());
        assert.equal(sched.checkpoints[2].checkpointTime, new Date('2026-10-22T21:45:00.000Z').getTime());
        assert.equal(sched.checkpoints[2].warningTime, new Date('2026-10-22T21:40:00.000Z').getTime());
      });

      it('collapses short-order poll (6h before evening play) into a single 90% release at T-4h15m', async () => {
        // Created Thu 2026-10-22 14:00 PDT -> Thu 2026-10-22 20:00 PDT (6h; deadline = 15:45 PDT, warn = 15:40 PDT)
        const cMs = new Date('2026-10-22T21:00:00.000Z').getTime();
        const pMs = new Date('2026-10-23T03:00:00.000Z').getTime();
        const sched = computeCourtReleaseSchedule(
          { createdAt: new Date(cMs).toISOString(), playAt: new Date(pMs).toISOString(), remoteJid: 'group1@g.us' },
          { quietHours: quietDefault, cutoffMinutes: 240, safetyBufferMinutes: 15 }
        );

        assert.equal(sched.checkpoints.length, 1);
        assert.equal(sched.checkpoints[0].milestone, 90);
        assert.equal(sched.checkpoints[0].warningTime, new Date('2026-10-22T22:40:00.000Z').getTime());
        assert.equal(sched.checkpoints[0].checkpointTime, new Date('2026-10-22T22:45:00.000Z').getTime());

        const messagesSent = [];
        const cancelledResIds = [];
        const origCancel = scvcc.cancelCourtReservation;
        scvcc.cancelCourtReservation = async (resId) => {
          cancelledResIds.push(resId);
          return { success: true };
        };
        const mockSock = { sendMessage: async (jid, msg) => messagesSent.push({ jid, msg }) };
        const pollState = {
          remoteJid: 'group1@g.us',
          createdAt: new Date(cMs).toISOString(),
          playAt: new Date(pMs).toISOString(),
          options: Array.from({ length: 8 }, (_, i) => `Player ${i + 1}`),
          size: 8,
          type: 'fixed',
          status: 'active',
          prebookedCourts: [{ court: 'Court 1', player: 'P1' }, { court: 'Court 2', player: 'P2' }],
          advanceBookedCourts: [{ court: 'Court 1', reservationId: 's-1' }, { court: 'Court 2', reservationId: 's-2' }],
          courtReleaseWarningsSent: [],
          courtReleasesDone: [],
          voteBuffer: new Map()
        };
        const context = { messageStore: new Map(), persistPolls: () => {} };
        try {
          await checkCourtReleasesForPoll(mockSock, 'poll_short_6h', pollState, context, sched.checkpoints[0].warningTime);
          assert.equal(messagesSent.length, 1);
          assert.match(messagesSent[0].msg.text, /Court 1 and Court 2.*5 mins/);
          assert.equal(pollState.prebookedCourts.length, 2);

          await checkCourtReleasesForPoll(mockSock, 'poll_short_6h', pollState, context, sched.checkpoints[0].checkpointTime);
          assert.deepEqual(cancelledResIds, ['s-2', 's-1']);
          assert.equal(pollState.prebookedCourts.length, 0);
          assert.equal(pollState.status, 'stopped');
        } finally {
          scvcc.cancelCourtReservation = origCancel;
        }
      });

      it('skips online auto-cancel for ultra-short polls created inside the 4h SCVCC cutoff and alerts once', async () => {
        // Created 2h before play (17:00 PDT for 19:00 PDT play)
        const cMs = new Date('2026-10-23T00:00:00.000Z').getTime();
        const pMs = new Date('2026-10-23T02:00:00.000Z').getTime();
        const sched = computeCourtReleaseSchedule(
          { createdAt: new Date(cMs).toISOString(), playAt: new Date(pMs).toISOString(), remoteJid: 'group1@g.us' },
          { quietHours: quietDefault, cutoffMinutes: 240, safetyBufferMinutes: 15 }
        );
        assert.equal(sched.withinCutoffAtCreation, true);
        assert.equal(sched.reason, 'within_cutoff');
        assert.equal(sched.checkpoints.length, 0);

        const messagesSent = [];
        const notifications = [];
        let cancelCalled = false;
        const origCancel = scvcc.cancelCourtReservation;
        const origNotify = courtCommands.sendBookingNotifications;
        scvcc.cancelCourtReservation = async () => { cancelCalled = true; return { success: true }; };
        courtCommands.sendBookingNotifications = async (sock, chatId, msg) => { notifications.push({ chatId, msg }); };
        const mockSock = { sendMessage: async (jid, msg) => messagesSent.push({ jid, msg }) };
        const pollState = {
          remoteJid: 'group1@g.us',
          createdAt: new Date(cMs).toISOString(),
          playAt: new Date(pMs).toISOString(),
          options: Array.from({ length: 4 }, (_, i) => `Player ${i + 1}`),
          size: 4,
          type: 'fixed',
          status: 'active',
          prebookedCourts: [{ court: 'Court 1', player: 'P1' }],
          advanceBookedCourts: [{ court: 'Court 1', reservationId: 'ultra-1' }],
          courtReleaseWarningsSent: [],
          courtReleasesDone: [],
          voteBuffer: new Map()
        };
        const context = { messageStore: new Map(), persistPolls: () => {} };
        try {
          await checkCourtReleasesForPoll(mockSock, 'poll_ultra', pollState, context, cMs + 40 * 60 * 1000);
          await checkCourtReleasesForPoll(mockSock, 'poll_ultra', pollState, context, cMs + 100 * 60 * 1000);
          assert.equal(cancelCalled, false, 'Must NOT call SCVCC cancel inside 4h cutoff');
          assert.equal(pollState.prebookedCourts.length, 1, 'Must NOT strip court when SCVCC cannot auto-cancel');
          assert.equal(messagesSent.length, 0, 'Must NOT falsely announce court cancelled to group');
          assert.equal(notifications.length, 1, 'Should alert notification list once for manual management');
          assert.match(notifications[0].msg, /Auto-Cancellation Skipped/i);
        } finally {
          scvcc.cancelCourtReservation = origCancel;
          courtCommands.sendBookingNotifications = origNotify;
        }
      });

      it('Case 1 (afternoon match): defers 70% milestone in quiet hours to quietEnd+5m (07:05 AM) with warning at 07:00 AM', () => {
        // Created Wed 2026-10-21 11:00 PDT -> Thu 2026-10-22 15:00 PDT (28h)
        // Raw 70% = Thu 06:36 PDT (quiet hours) -> Case 1 defers warn=07:00 PDT, release=07:05 PDT
        // Raw 80% = Thu 09:24 PDT | 90% capped = Thu 10:45 PDT
        const cMs = new Date('2026-10-21T18:00:00.000Z').getTime();
        const pMs = new Date('2026-10-22T22:00:00.000Z').getTime();
        const sched = computeCourtReleaseSchedule(
          { createdAt: new Date(cMs).toISOString(), playAt: new Date(pMs).toISOString(), remoteJid: 'group1@g.us' },
          { quietHours: quietDefault, cutoffMinutes: 240, safetyBufferMinutes: 15 }
        );
        assert.equal(sched.optionBApplied, false);
        assert.deepEqual(sched.checkpoints.map((c) => c.milestone), [70, 80, 90]);
        assert.equal(sched.checkpoints[0].warningTime, new Date('2026-10-22T14:00:00.000Z').getTime()); // 07:00 PDT
        assert.equal(sched.checkpoints[0].checkpointTime, new Date('2026-10-22T14:05:00.000Z').getTime()); // 07:05 PDT
        assert.equal(sched.checkpoints[1].checkpointTime, new Date('2026-10-22T16:24:00.000Z').getTime()); // 09:24 PDT
        assert.equal(sched.checkpoints[2].checkpointTime, new Date('2026-10-22T17:45:00.000Z').getTime()); // 10:45 PDT
      });

      it('Case 2 Option B (morning 7:30 AM match): pulls deadline to quietStart-5m (9:55 PM night before, warn 9:50 PM)', async () => {
        // Poll 1: 3-day advance (Wed 10:00 PDT -> Sat 07:30 PDT): 70% Fri 10:39 PDT, 80% Fri 17:36 PDT, 90% pulled to Fri 21:55 PDT
        const cLong = new Date('2026-10-21T17:00:00.000Z').getTime();
        const pSatMorning = new Date('2026-10-24T14:30:00.000Z').getTime(); // Sat Oct 24 07:30 PDT
        const schedLong = computeCourtReleaseSchedule(
          { createdAt: new Date(cLong).toISOString(), playAt: new Date(pSatMorning).toISOString(), remoteJid: 'group1@g.us' },
          { quietHours: quietDefault, cutoffMinutes: 240, safetyBufferMinutes: 15 }
        );
        assert.equal(schedLong.optionBApplied, true);
        assert.deepEqual(schedLong.checkpoints.map((c) => c.milestone), [70, 80, 90]);
        assert.equal(schedLong.checkpoints[2].warningTime, new Date('2026-10-24T04:50:00.000Z').getTime()); // Fri 21:50 PDT
        assert.equal(schedLong.checkpoints[2].checkpointTime, new Date('2026-10-24T04:55:00.000Z').getTime()); // Fri 21:55 PDT

        // Poll 2: Medium/short order created Fri 10:00 PDT -> Sat 07:30 PDT: collapses to single Fri 21:55 PDT release
        const cFri = new Date('2026-10-23T17:00:00.000Z').getTime();
        const schedShort = computeCourtReleaseSchedule(
          { createdAt: new Date(cFri).toISOString(), playAt: new Date(pSatMorning).toISOString(), remoteJid: 'group1@g.us' },
          { quietHours: quietDefault, cutoffMinutes: 240, safetyBufferMinutes: 15 }
        );
        assert.equal(schedShort.optionBApplied, true);
        assert.equal(schedShort.checkpoints.length, 1);
        assert.equal(schedShort.checkpoints[0].milestone, 90);
        assert.equal(schedShort.checkpoints[0].warningTime, new Date('2026-10-24T04:50:00.000Z').getTime());
        assert.equal(schedShort.checkpoints[0].checkpointTime, new Date('2026-10-24T04:55:00.000Z').getTime());

        // Verify end-to-end execution fires warning at 21:50 PDT and cancels at 21:55 PDT
        const origGetQh = groupsConfig.getQuietHours;
        const origCancel = scvcc.cancelCourtReservation;
        groupsConfig.getQuietHours = () => quietDefault;
        const cancelledIds = [];
        scvcc.cancelCourtReservation = async (id) => { cancelledIds.push(id); return { success: true }; };
        const sent = [];
        const mockSock = { sendMessage: async (jid, msg) => sent.push({ jid, msg }) };
        const pollState = {
          remoteJid: 'group_morning@g.us',
          createdAt: new Date(cFri).toISOString(),
          playAt: new Date(pSatMorning).toISOString(),
          options: ['P1', 'P2', 'P3', 'P4'],
          size: 4,
          type: 'fixed',
          status: 'active',
          prebookedCourts: [{ court: 'Court 1', player: 'P1' }],
          advanceBookedCourts: [{ court: 'Court 1', reservationId: '195152' }],
          courtReleaseWarningsSent: [],
          courtReleasesDone: [],
          voteBuffer: new Map()
        };
        const ctx = { messageStore: new Map(), persistPolls: () => {} };
        try {
          await checkCourtReleasesForPoll(mockSock, 'poll_optB', pollState, ctx, new Date('2026-10-24T04:50:00.000Z').getTime());
          assert.equal(sent.length, 1);
          assert.match(sent[0].msg.text, /5 mins/);
          assert.equal(cancelledIds.length, 0);

          await checkCourtReleasesForPoll(mockSock, 'poll_optB', pollState, ctx, new Date('2026-10-24T04:55:00.000Z').getTime());
          assert.deepEqual(cancelledIds, ['195152']);
          assert.equal(pollState.prebookedCourts.length, 0);
        } finally {
          groupsConfig.getQuietHours = origGetQh;
          scvcc.cancelCourtReservation = origCancel;
        }
      });

      it('handles 11:15 AM wake-up boundary, quiet-hours-created fallback, and disabled quiet hours cleanly', () => {
        // 1) 11:15 AM PDT match: latestSafe = 07:00 PDT (warn 06:55 PDT), hardCutoff = 07:15 PDT.
        // Deferring to 07:05 PDT (warn 07:00 PDT) still preserves 10m margin before 07:15 PDT hard cutoff.
        const c1115 = new Date('2026-10-23T17:00:00.000Z').getTime();
        const p1115 = new Date('2026-10-24T18:15:00.000Z').getTime(); // Sat 11:15 PDT
        const sched1115 = computeCourtReleaseSchedule(
          { createdAt: new Date(c1115).toISOString(), playAt: new Date(p1115).toISOString(), remoteJid: 'group1@g.us' },
          { quietHours: quietDefault, cutoffMinutes: 240, safetyBufferMinutes: 15 }
        );
        assert.equal(sched1115.optionBApplied, false);
        const lastCp = sched1115.checkpoints[sched1115.checkpoints.length - 1];
        assert.equal(lastCp.warningTime, new Date('2026-10-24T14:00:00.000Z').getTime()); // 07:00 PDT
        assert.equal(lastCp.checkpointTime, new Date('2026-10-24T14:05:00.000Z').getTime()); // 07:05 PDT

        // 2) Poll created during quiet hours (Fri 22:30 PDT -> Sat 07:30 PDT): falls back to 03:15 PDT before SCVCC lock
        const cLate = new Date('2026-10-24T05:30:00.000Z').getTime(); // Fri 22:30 PDT
        const pMorning = new Date('2026-10-24T14:30:00.000Z').getTime(); // Sat 07:30 PDT
        const schedLate = computeCourtReleaseSchedule(
          { createdAt: new Date(cLate).toISOString(), playAt: new Date(pMorning).toISOString(), remoteJid: 'group1@g.us' },
          { quietHours: quietDefault, cutoffMinutes: 240, safetyBufferMinutes: 15 }
        );
        assert.equal(schedLate.optionBApplied, false);
        assert.equal(schedLate.checkpoints.length, 1);
        assert.equal(schedLate.checkpoints[0].checkpointTime, new Date('2026-10-24T10:15:00.000Z').getTime()); // Sat 03:15 PDT

        // 3) Quiet hours disabled: Sat 07:30 PDT match created Fri 10:00 PDT uses Sat 03:15 PDT (no Option B pull-back)
        const cFri = new Date('2026-10-23T17:00:00.000Z').getTime();
        const schedNoQuiet = computeCourtReleaseSchedule(
          { createdAt: new Date(cFri).toISOString(), playAt: new Date(pMorning).toISOString(), remoteJid: 'group_off@g.us' },
          { quietHours: quietOff, cutoffMinutes: 240, safetyBufferMinutes: 15 }
        );
        assert.equal(schedNoQuiet.optionBApplied, false);
        assert.equal(schedNoQuiet.checkpoints[schedNoQuiet.checkpoints.length - 1].checkpointTime, new Date('2026-10-24T10:15:00.000Z').getTime());
      });
    });
  });

  describe('Re-booking of released courts on-demand', () => {
    const crypto = require('crypto');
    function makeOptHash(name) {
      return crypto.createHash('sha256').update(name).digest();
    }

    it('should NOT initiate re-booking when openings fall below 3 if player openings still exist (e.g. 7 votes for 8 spots)', async () => {
      let bookCourtCalled = false;
      const originalBookCourt = scvcc.bookCourt;
      scvcc.bookCourt = async () => { bookCourtCalled = true; return { success: true }; };

      const pollState = {
        remoteJid: 'group1@g.us',
        size: 8,
        slotLimit: 8,
        prebookedCourts: [{ court: 'Court 1' }, { court: 'Court 2' }],
        releasedCourts: [{ court: 'Court 3' }],
        onDemandBookingInProgress: false,
        invalidSlotVotesNotified: [],
        voteBuffer: new Map()
      };

      // 7 votes for 8 spots -> player openings = 1 (< 3), but openings still exist, so NO re-booking!
      const aggregated = [];
      for (let i = 1; i <= 7; i++) {
        aggregated.push({ name: `Player ${i}`, voters: [`voter${i}@s.whatsapp.net`] });
        pollState.voteBuffer.set(`voter${i}@s.whatsapp.net`, {
          pollUpdateMessageKey: { remoteJid: 'group1@g.us', participant: `voter${i}@s.whatsapp.net` },
          vote: { selectedOptions: [makeOptHash(`Player ${i}`)] }
        });
      }

      const mockSock = { sendMessage: async () => {} };
      try {
        const { processPollVoteEvent } = require('../lib/commands/poll');
        const messageStore = new Map([['group1@g.us:poll_rebook_no', {
          messageContextInfo: { messageSecret: Buffer.from('secret') },
          pollCreationMessage: { options: Array.from({ length: 12 }, (_, i) => ({ optionName: `Player ${i+1}` })) }
        }]]);
        await processPollVoteEvent(mockSock, { id: 'poll_rebook_no', remoteJid: 'group1@g.us' }, [], {
          activePolls: new Map([['poll_rebook_no', pollState]]),
          messageStore,
          persistPolls: () => {}
        });

        assert.equal(bookCourtCalled, false, 'Re-booking must NOT be initiated when free openings remain');
      } finally {
        scvcc.bookCourt = originalBookCourt;
      }
    });

    it('should initiate rebooking when 9th voter arrives (no free openings) and succeed, updating capacity to 12', async () => {
      let bookCourtCalled = false;
      const originalBookCourt = scvcc.bookCourt;
      const originalCheckAvail = scvcc.checkCourtAvailability;

      scvcc.checkCourtAvailability = async () => ({
        slots: [{ time: '10:00am', courts: [{ court: 'Court 3', status: 'available' }] }]
      });
      scvcc.bookCourt = async (params) => {
        bookCourtCalled = true;
        return {
          success: true,
          court: 'Court 3',
          date: '10/20/2026',
          time: '10:00am',
          reservationId: 'res-rebook-3',
          players: params.players
        };
      };

      const messagesSent = [];
      const mockSock = {
        sendMessage: async (jid, msg, opts) => { messagesSent.push({ jid, msg, opts }); }
      };

      const pollState = {
        remoteJid: 'group1@g.us',
        size: 8,
        slotLimit: 8,
        prebookedCourts: [{ court: 'Court 1' }, { court: 'Court 2' }],
        releasedCourts: [{ court: 'Court 3' }],
        onDemandBookingInProgress: false,
        invalidSlotVotesNotified: [],
        voteBuffer: new Map()
      };

      // 9 votes (for 8 spots)
      const aggregated = [];
      for (let i = 1; i <= 9; i++) {
        aggregated.push({ name: `Player ${i}`, voters: [`voter${i}@s.whatsapp.net`] });
        pollState.voteBuffer.set(`voter${i}@s.whatsapp.net`, {
          pollUpdateMessageKey: { remoteJid: 'group1@g.us', participant: `voter${i}@s.whatsapp.net` },
          vote: { selectedOptions: [makeOptHash(`Player ${i}`)] },
          senderTimestampMs: 1000 + i
        });
      }

      try {
        await handleOnDemandCourtBooking(mockSock, 'poll_rebook_yes', pollState, aggregated, {}, {
          isRebooking: true,
          targetCourt: pollState.releasedCourts[0],
          triggeringVoterJid: 'voter9@s.whatsapp.net'
        });

        assert.equal(bookCourtCalled, true);
        assert.equal(pollState.prebookedCourts.length, 3);
        assert.equal(pollState.slotLimit, undefined);
        assert.equal(pollState.size, 12);
        assert.equal(pollState.releasedCourts.length, 0);

        const confirmMsg = messagesSent.find(m => m.msg.text && m.msg.text.includes('Court 3') && m.msg.text.includes('booked'));
        assert.ok(confirmMsg, 'Confirmation message sent to group for Court 3');
        assert.match(confirmMsg.msg.text, /\*12 players\* can now play/);
      } finally {
        scvcc.bookCourt = originalBookCourt;
        scvcc.checkCourtAvailability = originalCheckAvail;
      }
    });

    it('should quote the user with rejection message when re-booking fails on 9th voter', async () => {
      const originalBookCourt = scvcc.bookCourt;
      const originalCheckAvail = scvcc.checkCourtAvailability;

      scvcc.checkCourtAvailability = async () => ({
        slots: [{ time: '10:00am', courts: [{ court: 'Court 3', status: 'unavailable' }] }]
      });
      scvcc.bookCourt = async () => ({ success: false, message: 'Court unavailable' });

      const messagesSent = [];
      const mockSock = {
        sendMessage: async (jid, msg, opts) => { messagesSent.push({ jid, msg, opts }); }
      };

      const pollState = {
        remoteJid: 'group1@g.us',
        size: 8,
        slotLimit: 8,
        prebookedCourts: [{ court: 'Court 1' }, { court: 'Court 2' }],
        releasedCourts: [{ court: 'Court 3' }],
        onDemandBookingInProgress: false,
        invalidSlotVotesNotified: [],
        voteBuffer: new Map()
      };

      const aggregated = [];
      for (let i = 1; i <= 9; i++) {
        aggregated.push({ name: `Player ${i}`, voters: [`voter${i}@s.whatsapp.net`] });
        pollState.voteBuffer.set(`voter${i}@s.whatsapp.net`, {
          pollUpdateMessageKey: { remoteJid: 'group1@g.us', participant: `voter${i}@s.whatsapp.net`, id: `voteMsg${i}` },
          vote: { selectedOptions: [makeOptHash(`Player ${i}`)] },
          senderTimestampMs: 1000 + i
        });
      }

      try {
        await handleOnDemandCourtBooking(mockSock, 'poll_rebook_fail', pollState, aggregated, {}, {
          isRebooking: true,
          targetCourt: pollState.releasedCourts[0],
          triggeringVoterJid: 'voter9@s.whatsapp.net',
          triggeringVoteMsgKey: { remoteJid: 'group1@g.us', id: 'voteMsg9' }
        });

        assert.equal(pollState.prebookedCourts.length, 2);
        assert.equal(pollState.slotLimit, 8);
        assert.equal(pollState.releasedCourts.length, 0);

        const failQuoteMsg = messagesSent.find(m => m.msg.text && m.msg.text.includes('voter9') || (m.opts?.quoted?.key?.id === 'voteMsg9'));
        assert.ok(failQuoteMsg, 'Failure message quoting voter 9 sent to group');
        assert.match(failQuoteMsg.msg.text, /all \*8 voting slots\* are filled/);
        assert.match(failQuoteMsg.msg.text, /Your vote will not be considered/);
        assert.equal(failQuoteMsg.opts?.quoted?.key?.id, 'voteMsg9');
      } finally {
        scvcc.bookCourt = originalBookCourt;
        scvcc.checkCourtAvailability = originalCheckAvail;
      }
    });

    it('should not limit slots on auto-cancellation, and only limit slots and warn voter if rebooking fails upon voting', async () => {
      const originalBookCourt = scvcc.bookCourt;
      const originalCheckAvail = scvcc.checkCourtAvailability;

      // Mock SCVCC re-booking to fail
      scvcc.checkCourtAvailability = async () => ({
        slots: [{ time: '10:00am', courts: [{ court: 'Court 3', status: 'unavailable' }] }]
      });
      scvcc.bookCourt = async () => ({ success: false, message: 'Court unavailable' });

      const messagesSent = [];
      const mockSock = {
        sendMessage: async (jid, msg, opts) => { messagesSent.push({ jid, msg, opts }); }
      };

      const t0 = new Date('2026-10-19T08:40:00.000Z').getTime();
      const playAt = new Date('2026-10-21T04:00:00.000Z').getTime();
      const pollState = {
        remoteJid: 'group1@g.us',
        createdAt: new Date(t0).toISOString(),
        playAt: new Date(playAt).toISOString(),
        options: Array.from({ length: 12 }, (_, i) => `Player ${i + 1}`),
        size: 12,
        type: 'fixed',
        status: 'active',
        prebookedCourts: [
          { court: 'Court 1', player: 'P1' },
          { court: 'Court 2', player: 'P2' },
          { court: 'Court 3', player: 'P3' }
        ],
        advanceBookedCourts: [
          { court: 'Court 1', reservationId: 'res-1' },
          { court: 'Court 2', reservationId: 'res-2' },
          { court: 'Court 3', reservationId: 'res-3' }
        ],
        courtReleaseWarningsSent: [],
        courtReleasesDone: [],
        releasedCourts: [],
        invalidSlotVotesNotified: [],
        voteBuffer: new Map()
      };

      // 4 voters vote for Court 1
      for (let i = 1; i <= 4; i++) {
        pollState.voteBuffer.set(`voter${i}@s.whatsapp.net`, {
          pollUpdateMessageKey: { remoteJid: 'group1@g.us', participant: `voter${i}@s.whatsapp.net` },
          vote: { selectedOptions: [makeOptHash(`Player ${i}`)] }
        });
      }

      const messageStore = new Map();
      messageStore.set('group1@g.us:poll_e2e_rebook', {
        pollCreationMessage: {
          options: pollState.options.map((o) => ({ optionName: o }))
        }
      });
      const context = {
        messageStore,
        activePolls: new Map([['poll_e2e_rebook', pollState]]),
        persistPolls: () => {}
      };

      try {
        // Step 1: Auto cancel Court 3 at 70% checkpoint
        await checkCourtReleasesForPoll(mockSock, 'poll_e2e_rebook', pollState, context, t0 + 1820 * 60 * 1000);

        // Court 3 is cancelled and recorded in releasedCourts
        assert.equal(pollState.prebookedCourts.length, 2);
        assert.equal(pollState.releasedCourts.length, 1);
        assert.equal(pollState.releasedCourts[0].court, 'Court 3');
        // Voting slots must NOT be limited!
        assert.equal(pollState.slotLimit, undefined, 'slotLimit should not be set on auto cancellation');
        assert.equal(pollState.size, 12, 'size should not be shrunk on auto cancellation');

        // Cancellation message does not mention slot limits
        const cancelMsg = messagesSent.find(m => m.msg.text && m.msg.text.includes('Court 3') && m.msg.text.includes('has been cancelled'));
        assert.ok(cancelMsg);
        assert.equal(cancelMsg.msg.text.includes('voting slots'), false);

        // Step 2: Now voters 5, 6, 7, 8 vote (filling Court 2). No invalid slot warnings!
        for (let i = 5; i <= 8; i++) {
          pollState.voteBuffer.set(`voter${i}@s.whatsapp.net`, {
            pollUpdateMessageKey: { remoteJid: 'group1@g.us', participant: `voter${i}@s.whatsapp.net` },
            vote: { selectedOptions: [makeOptHash(`Player ${i}`)] }
          });
        }
        assert.equal(pollState.slotLimit, undefined);

        // Step 3: Voter 9 votes! Triggers rebooking which fails.
        const aggregated = [];
        for (let i = 1; i <= 9; i++) {
          aggregated.push({ name: `Player ${i}`, voters: [`voter${i}@s.whatsapp.net`] });
          if (!pollState.voteBuffer.has(`voter${i}@s.whatsapp.net`)) {
            pollState.voteBuffer.set(`voter${i}@s.whatsapp.net`, {
              pollUpdateMessageKey: { remoteJid: 'group1@g.us', participant: `voter${i}@s.whatsapp.net`, id: `voteMsg${i}` },
              vote: { selectedOptions: [makeOptHash(`Player ${i}`)] },
              senderTimestampMs: 1000 + i
            });
          }
        }

        await handleOnDemandCourtBooking(mockSock, 'poll_e2e_rebook', pollState, aggregated, context, {
          isRebooking: true,
          targetCourt: pollState.releasedCourts[0],
          triggeringVoterJid: 'voter9@s.whatsapp.net',
          triggeringVoteMsgKey: { remoteJid: 'group1@g.us', id: 'voteMsg9' }
        });

        // ONLY NOW should slotLimit and size be set to 8
        assert.equal(pollState.slotLimit, 8, 'slotLimit should only be limited after rebooking fails');
        assert.equal(pollState.size, 8, 'size should be reduced after rebooking fails');

        // And voter 9 receives warning message quoting their vote
        const failMsg = messagesSent.find(m => m.msg.text && m.msg.text.includes('Your vote will not be considered') && (m.msg.text.includes('@9') || m.opts?.quoted?.key?.id === 'voteMsg9'));
        assert.ok(failMsg, 'Voter 9 should receive rejection message');
        assert.match(failMsg.msg.text, /all \*8 voting slots\* are filled and no additional courts could be booked/);
      } finally {
        scvcc.bookCourt = originalBookCourt;
        scvcc.checkCourtAvailability = originalCheckAvail;
      }
    });
  });
  describe("manual poll with no time specified", () => {
    describe("hasTimeSpecifiedInTitle", () => {
      it("should return true when time is specified in the title or poll object", () => {
        assert.equal(hasTimeSpecifiedInTitle("Tennis 7pm"), true);
        assert.equal(hasTimeSpecifiedInTitle("Tennis tomorrow 9:30am"), true);
        assert.equal(hasTimeSpecifiedInTitle("Sunday 6:00"), true);
        assert.equal(hasTimeSpecifiedInTitle("Saturday morning tennis"), true);
        assert.equal(hasTimeSpecifiedInTitle("Tennis @ 8am"), true);
        assert.equal(hasTimeSpecifiedInTitle("Tennis at 7"), true);
        assert.equal(hasTimeSpecifiedInTitle("Tennis 6 PM"), true);
        assert.equal(hasTimeSpecifiedInTitle("Tennis 19:00"), true);
        assert.equal(hasTimeSpecifiedInTitle({ name: "Match 8:30am" }), true);
        assert.equal(hasTimeSpecifiedInTitle({ hasTimeInTitle: true }), true);
      });

      it("should return false when no time is specified in the title or poll object", () => {
        assert.equal(hasTimeSpecifiedInTitle("Tennis Saturday"), false);
        assert.equal(hasTimeSpecifiedInTitle("Tennis Sunday"), false);
        assert.equal(hasTimeSpecifiedInTitle("Tennis Tomorrow"), false);
        assert.equal(hasTimeSpecifiedInTitle("Tennis Today"), false);
        assert.equal(hasTimeSpecifiedInTitle("Tennis"), false);
        assert.equal(hasTimeSpecifiedInTitle("Match Poll"), false);
        assert.equal(hasTimeSpecifiedInTitle("Tennis @ SCVCC"), false);
        assert.equal(hasTimeSpecifiedInTitle("Sunday tennis at SCVCC"), false);
        assert.equal(hasTimeSpecifiedInTitle("Tennis 4 spots"), false);
        assert.equal(hasTimeSpecifiedInTitle("Court 2 Tennis"), false);
        assert.equal(hasTimeSpecifiedInTitle("Tennis 10/24"), false);
        assert.equal(hasTimeSpecifiedInTitle("Singles this weekend"), false);
        assert.equal(hasTimeSpecifiedInTitle({ name: "Tennis Sunday", playAt: null }), false);
        assert.equal(hasTimeSpecifiedInTitle({ hasTimeInTitle: false }), false);
        assert.equal(hasTimeSpecifiedInTitle({ playAt: null }), false);
        assert.equal(hasTimeSpecifiedInTitle({ playAt: "unknown" }), false);
      });
    });

    describe("reminders for manual polls without time", () => {
      it("should return false and send no reminder if no day and no time are specified", async () => {
        const messagesSent = [];
        const mockSock = {
          user: { id: "1234567890@s.whatsapp.net" },
          sendMessage: async (jid, msg) => { messagesSent.push({ jid, msg }); }
        };

        const manualPollNoDayNoTime = {
          name: "Tennis 4 spots",
          isManual: true,
          status: "active",
          remoteJid: "group1@g.us",
          when: null,
          playAt: null,
          options: ["Player 1", "Player 2", "Player 3", "Player 4"],
          type: "manual",
          voteBuffer: new Map()
        };

        const sent = await sendPollReminder(mockSock, "poll_noday", manualPollNoDayNoTime, false, {
          messageStore: new Map()
        });
        assert.equal(sent, false);
        assert.equal(messagesSent.length, 0);
      });

      it("should use neutral terms and avoid tennis/match wording when manual poll title does not indicate a game", () => {
        assert.equal(pollTitleIndicatesGame("Tennis Sunday"), true);
        assert.equal(pollTitleIndicatesGame("Sunday Match"), true);
        assert.equal(pollTitleIndicatesGame("Game tomorrow"), true);
        assert.equal(pollTitleIndicatesGame("Doubles Saturday"), true);
        assert.equal(pollTitleIndicatesGame("Court 2"), true);
        assert.equal(pollTitleIndicatesGame("🎾 Sunday"), true);
        assert.equal(pollTitleIndicatesGame("Sunday"), false);
        assert.equal(pollTitleIndicatesGame("Sunday 6pm"), false);
        assert.equal(pollTitleIndicatesGame("Tomorrow"), false);
        assert.equal(pollTitleIndicatesGame("Tomorrow 7pm"), false);
        assert.equal(pollTitleIndicatesGame("Weekend"), false);

        // Untimed neutral reminder (Opt-in)
        const neutralOptIn = { name: "Sunday", isManual: true, when: "Sunday", playAt: null };
        const neutralOptInText = buildUntimedPollReminderText(neutralOptIn, 0, 0, "Alice, Bob", true, 2);
        assert.match(neutralOptInText, /Poll Reminder for Tomorrow!/);
        assert.match(neutralOptInText, /for tomorrow/);
        assert.equal(/tennis/i.test(neutralOptInText), false, "Must not contain tennis");
        assert.equal(/match/i.test(neutralOptInText), false, "Must not contain match");
        assert.equal(/court/i.test(neutralOptInText), false, "Must not contain court");
        assert.equal(neutralOptInText.includes("🎾"), false, "Must not contain tennis emoji");

        // Untimed neutral reminder (Fixed spots)
        const neutralFixed = { name: "Sunday", isManual: true, when: "Sunday", playAt: null };
        const neutralFixedText = buildUntimedPollReminderText(neutralFixed, 2, 4, "Alice, Bob", false, 0);
        assert.match(neutralFixedText, /Poll Reminder for Tomorrow!/);
        assert.match(neutralFixedText, /The poll for tomorrow still has/);
        assert.equal(/tennis/i.test(neutralFixedText), false, "Must not contain tennis");
        assert.equal(/match/i.test(neutralFixedText), false, "Must not contain match");
        assert.equal(/court/i.test(neutralFixedText), false, "Must not contain court");
        assert.equal(neutralFixedText.includes("🎾"), false, "Must not contain tennis emoji");

        // Timed neutral reminder (Fixed spots)
        const neutralTimed = { name: "Sunday 6pm", isManual: true, when: "Sunday 6pm", playAt: "2026-10-25T01:00:00.000Z" };
        const neutralTimedText = buildPollReminderText(8, neutralTimed, 2, 4, "Alice, Bob", false, 0, 8);
        assert.match(neutralTimedText, /Hours to Go!/);
        assert.equal(/tennis/i.test(neutralTimedText), false, "Must not contain tennis");
        assert.equal(/match/i.test(neutralTimedText), false, "Must not contain match");
        assert.equal(/court/i.test(neutralTimedText), false, "Must not contain court");
        assert.equal(neutralTimedText.includes("🎾"), false, "Must not contain tennis emoji");

        // Timed neutral reminder (Opt-in)
        const neutralTimedOptIn = { name: "Sunday 6pm", isManual: true, when: "Sunday 6pm", playAt: "2026-10-25T01:00:00.000Z" };
        const neutralTimedOptInText = buildPollReminderText(8, neutralTimedOptIn, 0, 0, "Alice, Bob", true, 2, 8);
        assert.match(neutralTimedOptInText, /Hours to Go!/);
        assert.equal(/tennis/i.test(neutralTimedOptInText), false, "Must not contain tennis");
        assert.equal(/match/i.test(neutralTimedOptInText), false, "Must not contain match");
        assert.equal(/court/i.test(neutralTimedOptInText), false, "Must not contain court");
        assert.equal(neutralTimedOptInText.includes("🎾"), false, "Must not contain tennis emoji");
      });

      it("should format untimed reminder text mentioning tomorrow and not mentioning hours to event", () => {
        const optInPoll = { name: "Tennis Sunday", isManual: true, when: "Sunday", playAt: null };
        const optInText = buildUntimedPollReminderText(optInPoll, 0, 0, "Alice, Bob", true, 2);
        assert.match(optInText, /Match Alert for Tomorrow!/);
        assert.match(optInText, /tomorrow's match/);
        assert.equal(/\b\d+\s*(?:hours|hrs|minutes|mins)\b/i.test(optInText), false, "Must not mention hours or minutes to event");

        const fixedPoll = { name: "Tennis Sunday", isManual: true, when: "Sunday", playAt: null };
        const fixedText = buildUntimedPollReminderText(fixedPoll, 2, 4, "Alice, Bob", false, 0);
        assert.match(fixedText, /Match Alert for Tomorrow!/);
        assert.match(fixedText, /The match poll for tomorrow still has/);
        assert.match(fixedText, /\*2 open spots\* \(2\/4 needed\)/);
        assert.equal(/\b\d+\s*(?:hours|hrs|minutes|mins)\b/i.test(fixedText), false, "Must not mention hours or minutes to event");
      });

      it("should calculate reminder time at 12:00 PM afternoon on the day before the match", () => {
        // Base: Saturday 2026-10-24 9:00 AM (Pacific)
        const saturdayMorning = new Date("2026-10-24T16:00:00.000Z"); // 9:00 AM PDT
        const pollState = {
          name: "Tennis Sunday",
          dayWord: "Sunday",
          when: "Sunday",
          createdAt: saturdayMorning.toISOString(),
          isManual: true,
          playAt: null
        };

        const info = getDayBefore12pmReminderTime(pollState, saturdayMorning);
        assert.ok(info);
        // Reminder should be Saturday 2026-10-24 at 12:00 PM San Jose time (PDT = UTC-7 -> 2026-10-24T19:00:00Z)
        assert.equal(info.reminderDate.toISOString(), "2026-10-24T19:00:00.000Z");
      });

      it("should send day-before 12pm reminder when day is provided and now is 12pm on the day before", async () => {
        const messagesSent = [];
        const mockSock = {
          user: { id: "1234567890@s.whatsapp.net" },
          sendMessage: async (jid, msg, opts) => { messagesSent.push({ jid, msg, opts }); }
        };

        // Poll created at 9am on Saturday Oct 24 for Sunday
        const createdTime = new Date("2026-10-24T16:00:00.000Z").toISOString();
        const activePolls = new Map();
        activePolls.set("poll_sun", {
          name: "Tennis Sunday",
          isManual: true,
          status: "active",
          remoteJid: "group1@g.us",
          dayWord: "Sunday",
          when: "Sunday",
          playAt: null,
          createdAt: createdTime,
          options: ["Player 1", "Player 2", "Player 3", "Player 4"],
          size: 4,
          type: "manual",
          sentReminders: [],
          voteBuffer: new Map()
        });

        const messageStore = new Map();
        messageStore.set("group1@g.us:poll_sun", {
          pollCreationMessage: { name: "Tennis Sunday", options: [{ optionName: "Player 1" }] }
        });

        // Saturday Oct 24, 12:05 PM PDT (19:05Z on Oct 24)
        const sat1205pm = new Date("2026-10-24T19:05:00.000Z").getTime();

        await checkAndSendPollReminders(mockSock, {
          activePolls,
          persistPolls: () => {},
          messageStore
        }, sat1205pm);

        assert.equal(messagesSent.length, 1);
        assert.match(messagesSent[0].msg.text, /Match Alert for Tomorrow!/);
        assert.match(messagesSent[0].msg.text, /The match poll for tomorrow still has/);
        assert.equal(/\b\d+\s*(?:hours|hrs)\b/i.test(messagesSent[0].msg.text), false);
        assert.ok(activePolls.get("poll_sun").sentReminders.includes("day_before_12pm"));

        // Sweeping again should not send duplicates
        messagesSent.length = 0;
        await checkAndSendPollReminders(mockSock, {
          activePolls,
          persistPolls: () => {},
          messageStore
        }, sat1205pm);
        assert.equal(messagesSent.length, 0);
      });

      it("should not send day-before reminder if now is before 12pm on the day before", async () => {
        const messagesSent = [];
        const mockSock = {
          user: { id: "1234567890@s.whatsapp.net" },
          sendMessage: async (jid, msg) => { messagesSent.push({ jid, msg }); }
        };

        const activePolls = new Map();
        activePolls.set("poll_sun", {
          name: "Tennis Sunday",
          isManual: true,
          status: "active",
          remoteJid: "group1@g.us",
          dayWord: "Sunday",
          when: "Sunday",
          playAt: null,
          createdAt: new Date("2026-10-24T16:00:00.000Z").toISOString(), // 9am Sat
          options: ["Player 1", "Player 2", "Player 3", "Player 4"],
          size: 4,
          type: "manual",
          sentReminders: [],
          voteBuffer: new Map()
        });

        // Time: Saturday Oct 24, 10:00 AM PDT (before 12pm)
        const sat10am = new Date("2026-10-24T17:00:00.000Z").getTime();

        await checkAndSendPollReminders(mockSock, {
          activePolls,
          persistPolls: () => {},
          messageStore: new Map()
        }, sat10am);

        assert.equal(messagesSent.length, 0, "Should not send reminder before 12pm on day before");
      });

      it("should suppress reminders during quiet hours before 7:00 AM and send them at or after 7:00 AM", async () => {
        const messagesSent = [];
        const mockSock = {
          user: { id: "1234567890@s.whatsapp.net" },
          sendMessage: async (jid, msg) => { messagesSent.push({ jid, msg }); }
        };

        // Match play time at 11:00 AM PDT on Saturday Oct 24
        // 4 hours before is 7:00 AM PDT (14:00Z)
        const playAt = new Date("2026-10-24T18:00:00.000Z").toISOString(); // 11:00 AM PDT
        const createdAt = new Date("2026-10-23T18:00:00.000Z").toISOString(); // day before

        const activePolls = new Map();
        activePolls.set("poll_quiet", {
          name: "Tennis Saturday 11am",
          isManual: false,
          status: "active",
          remoteJid: "group1@g.us",
          when: "Saturday 11am",
          playAt,
          createdAt,
          options: ["Player 1", "Player 2", "Player 3", "Player 4"],
          size: 4,
          type: "fixed",
          sentReminders: [16, 8],
          voteBuffer: new Map()
        });

        const messageStore = new Map();
        messageStore.set("group1@g.us:poll_quiet", {
          pollCreationMessage: { name: "Tennis Saturday 11am", options: [{ optionName: "Player 1" }] }
        });

        // 1. Check at 6:45 AM PDT (13:45Z) -> within quiet hours (< 7am), should NOT send
        const time645am = new Date("2026-10-24T13:45:00.000Z").getTime();
        await checkAndSendPollReminders(mockSock, {
          activePolls,
          persistPolls: () => {},
          messageStore
        }, time645am);

        assert.equal(messagesSent.length, 0, "Should suppress reminders before 7:00 AM");

        // 2. Check at 7:05 AM PDT (14:05Z) -> quiet hours ended at 7:00 AM, SHOULD send 4h reminder
        const time705am = new Date("2026-10-24T14:05:00.000Z").getTime();
        await checkAndSendPollReminders(mockSock, {
          activePolls,
          persistPolls: () => {},
          messageStore
        }, time705am);

        assert.equal(messagesSent.length, 1, "Should send reminder at or after 7:00 AM");
        assert.ok(activePolls.get("poll_quiet").sentReminders.includes(4));

        // 3. Check at 10:15 PM PDT (Sunday 05:15Z) -> quiet hours (>= 10pm / 22:00), should NOT send
        messagesSent.length = 0;
        activePolls.set("poll_night", {
          name: "Tennis Sunday 8am",
          isManual: false,
          status: "active",
          remoteJid: "group1@g.us",
          when: "Sunday 8am",
          playAt: new Date("2026-10-25T15:00:00.000Z").toISOString(),
          createdAt,
          options: ["Player 1", "Player 2"],
          size: 2,
          type: "fixed",
          sentReminders: [],
          voteBuffer: new Map()
        });
        const time1015pm = new Date("2026-10-25T05:15:00.000Z").getTime();
        await checkAndSendPollReminders(mockSock, {
          activePolls,
          persistPolls: () => {},
          messageStore
        }, time1015pm);
        assert.equal(messagesSent.length, 0, "Should suppress reminders at or after 10:00 PM");
      });

      it("should return explanation when user explicitly triggers reminder for manual poll with no day and no time", async () => {
        const activePolls = new Map();
        activePolls.set("poll_noday", {
          name: "Tennis 4 spots",
          isManual: true,
          status: "active",
          remoteJid: "group1@g.us",
          when: null,
          playAt: null,
          options: ["Player 1", "Player 2"],
          type: "manual",
          voteBuffer: new Map()
        });

        const res = await handleTriggerReminder(null, "group1@g.us", "Alice", "poll_noday", {
          activePolls,
          recurringPolls: new Map(),
          persistPolls: () => {}
        });

        assert.match(res, /no match time or day was specified/i);
      });

      it('should parse trigger reminder arguments with parseTriggerReminderArgs', () => {
        assert.deepEqual(parseTriggerReminderArgs('!remind'), { isForce: false, specificPollId: null });
        assert.deepEqual(parseTriggerReminderArgs('!sendreminder poll_123'), { isForce: false, specificPollId: 'poll_123' });
        assert.deepEqual(parseTriggerReminderArgs('!remind --force'), { isForce: true, specificPollId: null });
        assert.deepEqual(parseTriggerReminderArgs('!remind force'), { isForce: true, specificPollId: null });
        assert.deepEqual(parseTriggerReminderArgs('!remind poll_123 --force'), { isForce: true, specificPollId: 'poll_123' });
        assert.deepEqual(parseTriggerReminderArgs('!remind --force poll_123'), { isForce: true, specificPollId: 'poll_123' });
        assert.deepEqual(parseTriggerReminderArgs('!forceremind'), { isForce: true, specificPollId: null });
        assert.deepEqual(parseTriggerReminderArgs('!forceremind poll_123'), { isForce: true, specificPollId: 'poll_123' });
        assert.deepEqual(parseTriggerReminderArgs('!remindforce poll_123'), { isForce: true, specificPollId: 'poll_123' });
        assert.deepEqual(parseTriggerReminderArgs('!forcereminder'), { isForce: true, specificPollId: null });
      });

      it('should block normal !remind during quiet hours and suggest !forceremind', async () => {
        const pollState = {
          name: 'Tennis Friday',
          status: 'active',
          remoteJid: '120363403838804497@g.us',
          playAt: new Date(Date.now() + 2 * 3600 * 1000).toISOString(),
          options: ['Yes', 'No'],
          type: 'opt_in',
          voteBuffer: new Map()
        };
        const activePolls = new Map([['p_qh_test', pollState]]);

        // Mock 11:30 PM (inside quiet hours 22:00-07:00)
        const t1130pm = new Date('2026-11-10T23:30:00-08:00').getTime();

        const res = await handleTriggerReminder(null, '120363403838804497@g.us', 'Alice', 'p_qh_test', {
          activePolls,
          recurringPolls: new Map(),
          persistPolls: () => {}
        }, false, t1130pm);

        assert.ok(res);
        assert.match(res, /Quiet Hours Active/i);
        assert.match(res, /!forceremind/i);
      });

      it('should allow forced reminder (!forceremind / isForce: true) during quiet hours', async () => {
        const sentMessages = [];
        const mockSock = {
          sendMessage: async (jid, content, opts) => {
            sentMessages.push({ jid, content, opts });
            return { key: { id: 'msg_remind_1' } };
          }
        };

        const pollState = {
          name: 'Tennis Friday',
          status: 'active',
          remoteJid: '120363403838804497@g.us',
          playAt: new Date(Date.now() + 2 * 3600 * 1000).toISOString(),
          options: ['Yes', 'No'],
          type: 'opt_in',
          voteBuffer: new Map()
        };
        const activePolls = new Map([['p_qh_force', pollState]]);
        const t1130pm = new Date('2026-11-10T23:30:00-08:00').getTime();

        const res = await handleTriggerReminder(mockSock, '120363403838804497@g.us', 'Alice', 'p_qh_force', {
          activePolls,
          recurringPolls: new Map(),
          persistPolls: () => {}
        }, true, t1130pm);

        assert.equal(res, true);
        assert.equal(sentMessages.length, 1);
        assert.match(sentMessages[0].content.text, /Tennis Friday/i);
      });

      it('should send single reminder to target group and return confirmation message when triggered from DM', async () => {
        const sentMessages = [];
        const mockSock = {
          sendMessage: async (jid, content, opts) => {
            sentMessages.push({ jid, content, opts });
            return { key: { id: 'msg_dm_remind_1' } };
          }
        };

        const pollState = {
          name: 'Saturday Doubles 10am',
          status: 'active',
          remoteJid: '120363403838804497@g.us',
          playAt: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
          options: ['Yes', 'No'],
          type: 'opt_in',
          voteBuffer: new Map()
        };
        const activePolls = new Map([['p_sat_doubles', pollState]]);

        const dmChatId = '14081234567@s.whatsapp.net';
        const noonTime = new Date('2026-11-10T14:00:00-08:00').getTime();
        const res = await handleTriggerReminder(mockSock, dmChatId, 'Alice', null, {
          activePolls,
          recurringPolls: new Map(),
          targetGroupJid: '120363403838804497@g.us',
          now: noonTime,
          persistPolls: () => {}
        }, false, noonTime);

        assert.equal(sentMessages.length, 1);
        assert.equal(sentMessages[0].jid, '120363403838804497@g.us');
        assert.match(sentMessages[0].content.text, /Saturday Doubles 10am/i);
        assert.equal(typeof res, 'string');
        assert.match(res, /reminder triggered and sent to group/i);
        assert.match(res, /Saturday Doubles 10am/i);
      });

      it('should filter polls to targetGroupJid when triggered from DM', async () => {
        const sentMessages = [];
        const mockSock = {
          sendMessage: async (jid, content, opts) => {
            sentMessages.push({ jid, content, opts });
            return { key: { id: 'msg_filter_1' } };
          }
        };

        const group1Poll = {
          name: 'Group 1 Match',
          status: 'active',
          remoteJid: 'group1@g.us',
          playAt: new Date(Date.now() + 10 * 3600 * 1000).toISOString(),
          options: ['Yes', 'No'],
          type: 'opt_in',
          voteBuffer: new Map()
        };
        const group2Poll = {
          name: 'Group 2 Match',
          status: 'active',
          remoteJid: 'group2@g.us',
          playAt: new Date(Date.now() + 10 * 3600 * 1000).toISOString(),
          options: ['Yes', 'No'],
          type: 'opt_in',
          voteBuffer: new Map()
        };
        const activePolls = new Map([
          ['p_grp1', group1Poll],
          ['p_grp2', group2Poll]
        ]);

        const dmChatId = '14081234567@s.whatsapp.net';
        const noonTime = new Date('2026-11-10T14:00:00-08:00').getTime();
        const res = await handleTriggerReminder(mockSock, dmChatId, 'Alice', null, {
          activePolls,
          recurringPolls: new Map(),
          targetGroupJid: 'group1@g.us',
          now: noonTime,
          persistPolls: () => {}
        }, false, noonTime);

        assert.equal(sentMessages.length, 1);
        assert.equal(sentMessages[0].jid, 'group1@g.us');
        assert.match(sentMessages[0].content.text, /Group 1 Match/i);
        assert.match(res, /Group 1 Match/i);
      });

      it('should return non-null response string via handlePollCommand in DM to prevent fallthrough', async () => {
        const sentMessages = [];
        const mockSock = {
          sendMessage: async (jid, content, opts) => {
            sentMessages.push({ jid, content, opts });
            return { key: { id: 'msg_cmd_1' } };
          }
        };

        const pollState = {
          name: 'Sunday 9am Match',
          status: 'active',
          remoteJid: '120363403838804497@g.us',
          playAt: new Date(Date.now() + 48 * 3600 * 1000).toISOString(),
          options: ['Yes', 'No'],
          type: 'opt_in',
          voteBuffer: new Map()
        };
        const activePolls = new Map([['p_sun_9am', pollState]]);
        const dmChatId = '14081234567@s.whatsapp.net';

        const noonTime = new Date('2026-11-10T14:00:00-08:00').getTime();
        const cmdRes = await handlePollCommand(mockSock, '!remind', dmChatId, 'Alice', dmChatId, null, {
          activePolls,
          recurringPolls: new Map(),
          targetGroupJid: '120363403838804497@g.us',
          now: noonTime,
          persistPolls: () => {}
        });

        assert.ok(cmdRes, 'handlePollCommand should return a non-null result for !remind in DM');
        assert.equal(typeof cmdRes, 'string');
        assert.match(cmdRes, /reminder triggered and sent to group/i);
        assert.match(cmdRes, /Sunday 9am Match/i);
        assert.equal(sentMessages.length, 1, 'Only 1 reminder message sent to the group');
      });

      it("should show Scheduled for day before match at 6:00 PM in pollStatusText for manual poll with day", () => {
        const pollState = {
          name: "Tennis Sunday",
          isManual: true,
          status: "active",
          remoteJid: "group1@g.us",
          when: "Sunday",
          dayWord: "Sunday",
          playAt: null,
          options: ["Yes", "No"],
          type: "opt_in",
          voteBuffer: new Map()
        };

        const activePolls = new Map([["p_status_test", pollState]]);
        const status = pollStatusText("group1@g.us", { targetId: "p_status_test" }, { activePolls, recurringPolls: new Map(), messageStore: new Map() });
        assert.match(status, /Play time: unknown/i);
        assert.match(status, /Reminders: Scheduled for day before match at 12:00 PM/i);
      });
    });
  });

  describe('createMatchPoll court availability filtering with 90m requirement', () => {
    it('should NOT list court as available or create voting slots for it if subsequent slot has clinic (< 90m available)', async () => {
      const origCheck = scvcc.checkCourtAvailability;
      const origBookings = scvcc.getCourtBookings;

      // Mock 6:30 PM availability: Court 2 & 3 prebooked, Court 5 has only 30m before clinic
      scvcc.checkCourtAvailability = async () => ({
        success: true,
        slots: [{
          time: '6:30 PM',
          courts: [
            { court: 'Court 2', status: 'prebooked', prebookedBy: 'Pramod Immaneni', prebookedFullName: 'Pramod Immaneni', durationMins: 90 },
            { court: 'Court 3', status: 'prebooked', prebookedBy: 'Conrad Rodricks', prebookedFullName: 'Conrad Rodricks', durationMins: 90 },
            {
              court: 'Court 5',
              status: 'unavailable',
              availableMinutes: 0,
              overrideAvailableMinutes: 30, // only 30m before clinic at 7pm!
              blockTitle: null,
              prebookedPlayers: []
            }
          ]
        }]
      });

      scvcc.getCourtBookings = async () => ({
        success: true,
        bookings: [
          { court: 'Court 2', time: '6:30 PM', durationMins: 90, isPrebooked: true, prebookedBy: 'Pramod Immaneni' },
          { court: 'Court 3', time: '6:30 PM', durationMins: 90, isPrebooked: true, prebookedBy: 'Conrad Rodricks' },
          { court: 'Court 5', time: '7:00 PM', durationMins: 60, type: '3.0+ Live Ball Clinic', blockTitle: '3.0+ Live Ball Clinic' }
        ]
      });

      let sentPoll = null;
      const mockSock = {
        sendMessage: async (jid, content) => {
          sentPoll = content;
          return { key: { id: 'poll_clinic_test', remoteJid: jid }, message: content };
        }
      };

      const activePolls = new Map();
      try {
        const res = await createMatchPoll(
          mockSock,
          '120363403838804497@g.us',
          'auto',
          'Tomorrow 6:30pm',
          null,
          '6:30pm',
          null, // creatorName
          null,
          false,
          null,
          false,
          false, // isCommand
          false,
          true,  // checkCourts
          false,
          false,
          null,
          null,
          null,
          null,
          null,
          null,
          { activePolls, messageStore: new Map(), latestPollIdByChat: new Map(), persistPolls: () => {} }
        );

        assert.equal(res.err, null);
        const storedPoll = activePolls.get('poll_clinic_test');
        assert.ok(storedPoll);
        // Only Courts 2 & 3 (8 capacity), Court 5 must NOT be included because it only has 30m available!
        assert.equal(storedPoll.size, 8, 'Poll size must be 8 slots, Court 5 with 30m must NOT expand to 12 slots');
        assert.equal(storedPoll.options.length, 8, 'Options count must be 8');
        assert.equal(sentPoll.poll.name.includes('Court 5 - Available'), false, 'Poll title must NOT say Court 5 is available');
        assert.ok(!storedPoll.unbookedCourts || storedPoll.unbookedCourts.length === 0, 'unbookedCourts must NOT include Court 5');
      } finally {
        scvcc.checkCourtAvailability = origCheck;
        scvcc.getCourtBookings = origBookings;
      }
    });

    it('should list court as available and create voting slots if court has full 90m unblocked (override eligible)', async () => {
      const origCheck = scvcc.checkCourtAvailability;
      const origBookings = scvcc.getCourtBookings;

      scvcc.checkCourtAvailability = async () => ({
        success: true,
        slots: [{
          time: '6:30 PM',
          courts: [
            { court: 'Court 2', status: 'prebooked', prebookedBy: 'Pramod Immaneni', prebookedFullName: 'Pramod Immaneni', durationMins: 90 },
            { court: 'Court 3', status: 'prebooked', prebookedBy: 'Conrad Rodricks', prebookedFullName: 'Conrad Rodricks', durationMins: 90 },
            {
              court: 'Court 5',
              status: 'unavailable',
              availableMinutes: 0,
              overrideAvailableMinutes: 90, // full 90m unblocked
              blockTitle: null,
              prebookedPlayers: []
            }
          ]
        }]
      });

      scvcc.getCourtBookings = async () => ({
        success: true,
        bookings: [
          { court: 'Court 2', time: '6:30 PM', durationMins: 90, isPrebooked: true, prebookedBy: 'Pramod Immaneni' },
          { court: 'Court 3', time: '6:30 PM', durationMins: 90, isPrebooked: true, prebookedBy: 'Conrad Rodricks' }
        ]
      });

      let sentPoll = null;
      const mockSock = {
        sendMessage: async (jid, content) => {
          sentPoll = content;
          return { key: { id: 'poll_override_test', remoteJid: jid }, message: content };
        }
      };

      const activePolls = new Map();
      try {
        const res = await createMatchPoll(
          mockSock,
          '120363403838804497@g.us',
          'auto',
          'Tomorrow 6:30pm',
          null,
          '6:30pm',
          null,
          null,
          false,
          null,
          false,
          false,
          false,
          true,  // checkCourts
          false,
          false,
          null,
          null,
          null,
          null,
          null,
          null,
          { activePolls, messageStore: new Map(), latestPollIdByChat: new Map(), persistPolls: () => {} }
        );

        assert.equal(res.err, null);
        const storedPoll = activePolls.get('poll_override_test');
        assert.ok(storedPoll);
        assert.equal(storedPoll.size, 12, 'Poll size must be 12 slots when Court 5 has 90m unblocked');
        assert.equal(sentPoll.poll.name.includes('Court 5 - Available'), true, 'Poll title should say Court 5 is available');
        assert.equal(storedPoll.unbookedCourts.length, 1);
        assert.equal(storedPoll.unbookedCourts[0].court, 'Court 5');
      } finally {
        scvcc.checkCourtAvailability = origCheck;
        scvcc.getCourtBookings = origBookings;
      }
    });
  });

  describe("slotCheck configuration option for polls", () => {
    it("should default slotCheck to true for automatic polls with separate vote per player", async () => {
      let sentContent = null;
      const mockSock = {
        sendMessage: async (jid, content) => {
          sentContent = content;
          return { key: { id: "poll_slotcheck_auto", remoteJid: jid }, message: content };
        }
      };
      const activePolls = new Map();
      const res = await createMatchPoll(
        mockSock,
        "group1@g.us",
        4,
        "Tomorrow 7pm",
        null,
        "7pm",
        "Alice",
        "alice@s.whatsapp.net",
        true,
        null,
        false,
        false,
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
        { activePolls, messageStore: new Map(), latestPollIdByChat: new Map(), persistPolls: () => {} }
      );
      assert.equal(res.slotCheck, true);
      const stored = activePolls.get("poll_slotcheck_auto");
      assert.equal(stored.slotCheck, true);
    });

    it("should default slotCheck to true when not specified (even for opt-in polls)", async () => {
      const mockSock = {
        sendMessage: async (jid, content) => ({ key: { id: "poll_slotcheck_optin", remoteJid: jid }, message: content })
      };
      const activePolls = new Map();
      const res = await createMatchPoll(
        mockSock,
        "group1@g.us",
        null, // opt-in
        "Tomorrow 7pm",
        null,
        "7pm",
        "Alice",
        "alice@s.whatsapp.net",
        false,
        null,
        false,
        false,
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
        { activePolls, messageStore: new Map(), latestPollIdByChat: new Map(), persistPolls: () => {} }
      );
      assert.equal(res.slotCheck, true);
      const stored = activePolls.get("poll_slotcheck_optin");
      assert.equal(stored.slotCheck, true);
    });

    it("should respect explicit slotCheck=false when specified on a poll", async () => {
      const mockSock = {
        sendMessage: async (jid, content) => ({ key: { id: "poll_slotcheck_false", remoteJid: jid }, message: content })
      };
      const activePolls = new Map();
      const res = await createMatchPoll(
        mockSock,
        "group1@g.us",
        4,
        "Tomorrow 7pm",
        null,
        "7pm",
        "Alice",
        "alice@s.whatsapp.net",
        false,
        null,
        false,
        false,
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
        { activePolls, messageStore: new Map(), latestPollIdByChat: new Map(), persistPolls: () => {} },
        { slotCheck: false }
      );
      assert.equal(res.slotCheck, false);
      const stored = activePolls.get("poll_slotcheck_false");
      assert.equal(stored.slotCheck, false);
    });

    it("should default slotCheck to false for manually created polls when slotCheck is unspecified", async () => {
      const pollState = {
        name: "User Created Poll",
        isManual: true,
        // slotCheck is undefined!
        type: "manual",
        options: ["Option A", "Option B"],
        remoteJid: "group1@g.us",
        voteBuffer: new Map()
      };
      const aggregated = [
        { name: "Option A", voters: ["user1@s.whatsapp.net", "user2@s.whatsapp.net"] }
      ];
      let warningSent = false;
      const mockSock = {
        sendMessage: async () => { warningSent = true; }
      };
      const res = await checkAndNotifySlotConflicts(mockSock, "p_manual", pollState, aggregated, {});
      assert.equal(res, false);
      assert.equal(warningSent, false, "Must not complain when slotCheck is unspecified on manual poll");
    });

    it("should not complain about multiple votes on the same slot when slotCheck is false", async () => {
      const pollState = {
        name: "Test Poll",
        slotCheck: false,
        type: "fixed",
        options: ["Player 1", "Player 2", "Player 3", "Player 4"],
        remoteJid: "group1@g.us",
        voteBuffer: new Map()
      };
      const aggregated = [
        { name: "Player 2", voters: ["user1@s.whatsapp.net", "user2@s.whatsapp.net"] }
      ];
      let warningSent = false;
      const mockSock = {
        sendMessage: async () => { warningSent = true; }
      };
      const res = await checkAndNotifySlotConflicts(mockSock, "p1", pollState, aggregated, {});
      assert.equal(res, false);
      assert.equal(warningSent, false, "Must not complain when slotCheck is disabled");
    });

    it("should warn about multiple votes on the same slot when slotCheck is true", async () => {
      const pollState = {
        name: "Test Poll",
        slotCheck: true,
        type: "fixed",
        options: ["Player 1", "Player 2", "Player 3", "Player 4"],
        remoteJid: "group1@g.us",
        voteBuffer: new Map([
          ["user1@s.whatsapp.net", { senderTimestampMs: 1000 }],
          ["user2@s.whatsapp.net", { senderTimestampMs: 2000 }]
        ])
      };
      const aggregated = [
        { name: "Player 2", voters: ["user1@s.whatsapp.net", "user2@s.whatsapp.net"] },
        { name: "Player 3", voters: [] }
      ];
      let sentMessage = null;
      const mockSock = {
        sendMessage: async (jid, content) => { sentMessage = content; }
      };
      const res = await checkAndNotifySlotConflicts(mockSock, "p1", pollState, aggregated, { messageStore: new Map() });
      assert.equal(res, true);
      assert.ok(sentMessage);
      assert.match(sentMessage.text, /Player 2.*already taken/i);
    });

    it("should warn a player if they voted on more than one slot when slotCheck is true", async () => {
      const pollState = {
        name: "Test Poll",
        slotCheck: true,
        type: "manual",
        options: ["Player 2", "Player 3", "Player 4"],
        remoteJid: "group1@g.us",
        voteBuffer: new Map([
          ["user1@s.whatsapp.net", { senderTimestampMs: 1000 }]
        ])
      };
      const aggregated = [
        { name: "Player 2", voters: ["user1@s.whatsapp.net"] },
        { name: "Player 3", voters: ["user1@s.whatsapp.net"] },
        { name: "Player 4", voters: [] }
      ];
      let sentMessage = null;
      const mockSock = {
        sendMessage: async (jid, content) => { sentMessage = content; }
      };
      const res = await checkAndNotifySlotConflicts(mockSock, "p1", pollState, aggregated, { messageStore: new Map() });
      assert.equal(res, true);
      assert.ok(sentMessage);
      assert.match(sentMessage.text, /you have voted for more than one slot/i);
      assert.match(sentMessage.text, /Player 2.*Player 3/);
    });

    it("should not warn a player for voting on multiple options if option is No or Out", async () => {
      const pollState = {
        name: "Test Poll",
        slotCheck: true,
        type: "manual",
        options: ["Player 2", "No"],
        remoteJid: "group1@g.us",
        voteBuffer: new Map([
          ["user1@s.whatsapp.net", { senderTimestampMs: 1000 }]
        ])
      };
      const aggregated = [
        { name: "Player 2", voters: ["user1@s.whatsapp.net"] },
        { name: "No", voters: ["user1@s.whatsapp.net"] }
      ];
      let sentMessage = null;
      const mockSock = {
        sendMessage: async (jid, content) => { sentMessage = content; }
      };
      const res = await checkAndNotifySlotConflicts(mockSock, "p1", pollState, aggregated, { messageStore: new Map() });
      assert.equal(res, false);
      assert.equal(sentMessage, null);
    });

    it("should enable slotCheck in LLM interpretation for manual poll with separate vote per player slots", async () => {
      const interp = await interpretManualPollWithLLM("Tennis Tomorrow 7pm", ["Player 1", "Player 2", "Player 3", "Player 4"], "Alice");
      assert.equal(interp.slotCheck, true);
    });

    it("should disable slotCheck in LLM interpretation for manual poll with Yes/No or non-player slots", async () => {
      const interpYesNo = await interpretManualPollWithLLM("Tennis Tomorrow 7pm", ["Yes", "No"], "Alice");
      assert.equal(interpYesNo.slotCheck, false);

      const interpTopics = await interpretManualPollWithLLM("Tennis Tomorrow 7pm", ["Morning 9am", "Evening 6pm"], "Alice");
      assert.equal(interpTopics.slotCheck, false);
    });

    it("should allow modifying slotCheck with !modifyinstance / !modifypoll command", async () => {
      const pollState = {
        name: "Match Tomorrow 7pm",
        when: "Tomorrow 7pm",
        size: 4,
        type: "fixed",
        status: "active",
        isManual: true,
        slotCheck: true,
        remoteJid: "group1@g.us",
        creator: { name: "Bob", jid: "bob@s.whatsapp.net" },
        voteBuffer: new Map()
      };
      const activePolls = new Map([["p_mod_test", pollState]]);
      const context = { activePolls, recurringPolls: new Map(), persistPolls: () => {} };

      // Disable slotCheck on the poll
      const cmd1 = parseModifyInstanceCommand("!modifypoll p_mod_test --no-slotcheck");
      assert.equal(cmd1.updates.slotCheck, false);

      const res1 = await handleModifyPollInstance(null, "group1@g.us", "Bob", "bob@s.whatsapp.net", cmd1.targetId, cmd1.updates, context);
      assert.match(res1, /Updated slot check for poll.*Disabled/i);
      assert.equal(pollState.slotCheck, false);

      // Re-enable slotCheck on the poll
      const cmd2 = parseModifyInstanceCommand("!modifyinstance p_mod_test --slotcheck");
      assert.equal(cmd2.updates.slotCheck, true);

      const res2 = await handleModifyPollInstance(null, "group1@g.us", "Bob", "bob@s.whatsapp.net", cmd2.targetId, cmd2.updates, context);
      assert.match(res2, /Updated slot check for poll.*Enabled/i);
      assert.equal(pollState.slotCheck, true);
    });

    it("should display slot check status in pollStatusText", () => {
      const pollState = {
        name: "Tennis Match",
        isManual: false,
        status: "active",
        remoteJid: "group1@g.us",
        when: "Tomorrow 7pm",
        playAt: new Date(Date.now() + 3600000).toISOString(),
        options: ["Player 2", "Player 3", "Player 4"],
        size: 4,
        type: "fixed",
        slotCheck: true,
        voteBuffer: new Map()
      };
      const activePolls = new Map([["p_status_slotcheck", pollState]]);
      const status1 = pollStatusText("group1@g.us", { targetId: "p_status_slotcheck" }, { activePolls, recurringPolls: new Map(), messageStore: new Map() });
      assert.match(status1, /Slot check: Enabled/i);

      pollState.slotCheck = false;
      const status2 = pollStatusText("group1@g.us", { targetId: "p_status_slotcheck" }, { activePolls, recurringPolls: new Map(), messageStore: new Map() });
      assert.match(status2, /Slot check: Disabled/i);
    });

    it("should consider manual poll filled when every slot has a vote even with duplicate votes, and send slot check warnings", async () => {
      const crypto = require('crypto');
      const makeOptHash = (name) => crypto.createHash('sha256').update(name).digest();
      const messagesSent = [];
      const mockSock = {
        sendMessage: async (jid, content) => {
          messagesSent.push({ jid, content });
          return { key: { id: 'msg_' + Date.now(), remoteJid: jid } };
        }
      };

      const pollState = {
        name: "Weekend Tennis",
        isManual: true,
        status: "active",
        remoteJid: "group1@g.us",
        options: ["Player 2", "Player 3", "Player 4"],
        size: 4,
        type: "fixed",
        slotCheck: true,
        voteBuffer: new Map()
      };

      const rawPollMsg = {
        messageContextInfo: { messageSecret: Buffer.from('secret') },
        pollCreationMessage: {
          name: "Weekend Tennis",
          options: [{ optionName: "Player 2" }, { optionName: "Player 3" }, { optionName: "Player 4" }]
        }
      };

      const messageStore = new Map([["group1@g.us:poll_filled_test", rawPollMsg]]);
      const activePolls = new Map([["poll_filled_test", pollState]]);
      const context = {
        activePolls,
        messageStore,
        persistPolls: () => {}
      };

      // Alice votes for Player 2 and Player 3; Bob votes for Player 4
      const updates = [
        {
          pollUpdateMessageKey: { participant: "111@s.whatsapp.net" },
          senderTimestampMs: 1000,
          vote: { selectedOptions: [makeOptHash("Player 2"), makeOptHash("Player 3")] }
        },
        {
          pollUpdateMessageKey: { participant: "222@s.whatsapp.net" },
          senderTimestampMs: 2000,
          vote: { selectedOptions: [makeOptHash("Player 4")] }
        }
      ];

      const { processPollVoteEvent } = require('../lib/commands/poll');
      await processPollVoteEvent(mockSock, { id: "poll_filled_test", remoteJid: "group1@g.us" }, updates, context);

      // Poll must be marked as filled
      assert.equal(pollState.status, "filled");

      // Slot check warning must have been sent for Alice voting on multiple slots
      const warning = messagesSent.find(m => m.content.text && m.content.text.includes('voted for more than one slot'));
      assert.ok(warning, 'Slot check warning must be sent when poll is filled with duplicate votes');
      assert.match(warning.content.text, /Player 2.*Player 3/);
      assert.match(warning.content.text, /All other slots are currently taken/);

      // Now a subsequent vote arrives after poll is filled (Charlie also votes for Player 4)
      const subsequentUpdate = [
        {
          pollUpdateMessageKey: { participant: "333@s.whatsapp.net" },
          senderTimestampMs: 3000,
          vote: { selectedOptions: [makeOptHash("Player 4")] }
        }
      ];
      messagesSent.length = 0;
      await processPollVoteEvent(mockSock, { id: "poll_filled_test", remoteJid: "group1@g.us" }, subsequentUpdate, context);

      // Warning should NOT be sent to group after poll is already filled; only logged
      const afterFillWarning = messagesSent.find(m => m.content.text && m.content.text.includes('already taken by'));
      assert.equal(afterFillWarning, undefined, 'Slot check warning must NOT be sent to group after poll is filled');
      assert.equal(messagesSent.length, 0, 'No warning message sent to group');
      assert.equal(pollState.status, "filled");
    });

    it("should consider automatic poll filled when every slot has a vote even with duplicate votes, and send warnings", async () => {
      const crypto = require('crypto');
      const makeOptHash = (name) => crypto.createHash('sha256').update(name).digest();
      const messagesSent = [];
      const mockSock = {
        sendMessage: async (jid, content) => {
          messagesSent.push({ jid, content });
          return { key: { id: 'msg_' + Date.now(), remoteJid: jid } };
        }
      };

      const pollState = {
        name: "Automated Tennis",
        isManual: false,
        status: "active",
        remoteJid: "group1@g.us",
        creator: { name: "Organizer", jid: "creator@s.whatsapp.net" },
        options: ["Player 2", "Player 3", "Player 4"],
        size: 4,
        type: "fixed",
        slotCheck: true,
        voteBuffer: new Map()
      };

      const rawPollMsg = {
        messageContextInfo: { messageSecret: Buffer.from('secret') },
        pollCreationMessage: {
          name: "Automated Tennis",
          options: [{ optionName: "Player 2" }, { optionName: "Player 3" }, { optionName: "Player 4" }]
        }
      };

      const messageStore = new Map([["group1@g.us:poll_auto_filled_test", rawPollMsg]]);
      const activePolls = new Map([["poll_auto_filled_test", pollState]]);
      const context = {
        activePolls,
        messageStore,
        persistPolls: () => {}
      };

      // Alice votes for Player 2 and Player 3; Bob votes for Player 4
      const updates = [
        {
          pollUpdateMessageKey: { participant: "111@s.whatsapp.net" },
          senderTimestampMs: 1000,
          vote: { selectedOptions: [makeOptHash("Player 2"), makeOptHash("Player 3")] }
        },
        {
          pollUpdateMessageKey: { participant: "222@s.whatsapp.net" },
          senderTimestampMs: 2000,
          vote: { selectedOptions: [makeOptHash("Player 4")] }
        }
      ];

      const { processPollVoteEvent } = require('../lib/commands/poll');
      await processPollVoteEvent(mockSock, { id: "poll_auto_filled_test", remoteJid: "group1@g.us" }, updates, context);

      // Poll must be marked as filled
      assert.equal(pollState.status, "filled");

      // Slot check warning was sent
      const warning = messagesSent.find(m => m.content.text && m.content.text.includes('voted for more than one slot'));
      assert.ok(warning, 'Slot check warning must be sent on automatic poll');

      // Subsequent vote from Charlie after fill
      const subsequentUpdate = [
        {
          pollUpdateMessageKey: { participant: "333@s.whatsapp.net" },
          senderTimestampMs: 3000,
          vote: { selectedOptions: [makeOptHash("Player 3")] }
        }
      ];
      messagesSent.length = 0;
      await processPollVoteEvent(mockSock, { id: "poll_auto_filled_test", remoteJid: "group1@g.us" }, subsequentUpdate, context);

      const afterFillWarning = messagesSent.find(m => m.content.text && m.content.text.includes('already taken by'));
      assert.equal(afterFillWarning, undefined, 'Slot check warning must NOT be sent to group after auto poll is filled');
      assert.equal(messagesSent.length, 0, 'No warning message sent to group');
      assert.equal(pollState.status, "filled");
    });
  });

  describe("lineupGeneration configuration option for polls", () => {
    it("should default lineupGeneration to 'filled' and lineupLeadTime to 30 on automatic match polls", async () => {
      const activePolls = new Map();
      const mockSock = {
        sendMessage: async () => ({ key: { id: "msg_lineup_test" } })
      };
      const context = {
        activePolls,
        recurringPolls: new Map(),
        persistPolls: () => {},
        latestPollIdByChat: new Map()
      };
      const res = await createMatchPoll(
        mockSock,
        "group1@g.us",
        4,
        "Tomorrow 7pm",
        "tomorrow",
        "7pm",
        "Alice",
        "alice@s.whatsapp.net",
        true,
        null,
        false,
        false,
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
        context
      );
      assert.equal(res.lineupGeneration, "filled");
      assert.equal(res.lineupLeadTime, 30);

      const stored = activePolls.get(res.pollId);
      assert.equal(stored.lineupGeneration, "filled");
      assert.equal(stored.lineupLeadTime, 30);
      assert.equal(stored.manualLineupPosted, false);
    });

    it("should set lineupGeneration to 'none' when noMatchups is true", async () => {
      const activePolls = new Map();
      const mockSock = {
        sendMessage: async () => ({ key: { id: "msg_lineup_none" } })
      };
      const context = {
        activePolls,
        recurringPolls: new Map(),
        persistPolls: () => {},
        latestPollIdByChat: new Map()
      };
      const res = await createMatchPoll(
        mockSock,
        "group1@g.us",
        4,
        "Tomorrow 7pm",
        "tomorrow",
        "7pm",
        "Alice",
        "alice@s.whatsapp.net",
        true,
        null,
        false,
        false,
        true, // noMatchups
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
        context
      );
      assert.equal(res.lineupGeneration, "none");
      const stored = activePolls.get(res.pollId);
      assert.equal(stored.lineupGeneration, "none");
    });

    it("should support explicit lineupGeneration: 'fallback' and custom lineupLeadTime", async () => {
      const activePolls = new Map();
      const mockSock = {
        sendMessage: async () => ({ key: { id: "msg_lineup_bpt" } })
      };
      const context = {
        activePolls,
        recurringPolls: new Map(),
        persistPolls: () => {},
        latestPollIdByChat: new Map()
      };
      const res = await createMatchPoll(
        mockSock,
        "group1@g.us",
        4,
        "Tomorrow 7pm",
        "tomorrow",
        "7pm",
        "Alice",
        "alice@s.whatsapp.net",
        true,
        null,
        false,
        false,
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
        { lineupGeneration: "fallback", lineupLeadTime: 90 }
      );
      assert.equal(res.lineupGeneration, "fallback");
      assert.equal(res.lineupLeadTime, 90);
      const stored = activePolls.get(res.pollId);
      assert.equal(stored.lineupGeneration, "fallback");
      assert.equal(stored.lineupLeadTime, 90);
    });

    it("should correctly evaluate shouldAutoGenerateLineupOnFill across the three modes", () => {
      const playAt = new Date("2026-10-28T19:00:00Z");
      const basePoll = {
        playAt: playAt.toISOString(),
        manualLineupPosted: false
      };

      // 1. filled always returns true
      assert.equal(shouldAutoGenerateLineupOnFill({ ...basePoll, lineupGeneration: "filled" }), true);

      // 2. none always returns false
      assert.equal(shouldAutoGenerateLineupOnFill({ ...basePoll, lineupGeneration: "none" }), false);

      // 3. fallback with 30 mins lead time
      const bptPoll = { ...basePoll, lineupGeneration: "fallback", lineupLeadTime: 30 };

      // 45 mins before play time: should NOT auto-generate yet
      const fortyFiveMinsBefore = new Date(playAt.getTime() - 45 * 60000).getTime();
      assert.equal(shouldAutoGenerateLineupOnFill(bptPoll, fortyFiveMinsBefore), false);

      // 15 mins before play time (within lead time): SHOULD auto-generate if no manual lineup
      const fifteenMinsBefore = new Date(playAt.getTime() - 15 * 60000).getTime();
      assert.equal(shouldAutoGenerateLineupOnFill(bptPoll, fifteenMinsBefore), true);

      // 15 mins before play time, but manual lineup was posted: should NOT auto-generate
      assert.equal(shouldAutoGenerateLineupOnFill({ ...bptPoll, manualLineupPosted: true }, fifteenMinsBefore), false);
    });

    it("checkPendingLineupGenerations should trigger matchups when deadline reached and no manual lineup posted", async () => {
      const playAt = new Date(Date.now() + 15 * 60 * 1000); // 15 mins from now
      let messageSent = null;
      const mockSock = {
        sendMessage: async (jid, content) => {
          messageSent = { jid, content };
          return { key: { id: "lineup_msg" } };
        }
      };

      const pollState = {
        status: "filled",
        remoteJid: "group1@g.us",
        when: "Today 6pm",
        playAt: playAt.toISOString(),
        lineupGeneration: "fallback",
        lineupLeadTime: 30, // 30 mins before play time (now is 15 mins before, so deadline passed)
        manualLineupPosted: false,
        size: 4,
        type: "fixed",
        options: ["Player 2", "Player 3", "Player 4"],
        creator: { name: "Alice", jid: "alice@s.whatsapp.net" },
        lastPlayers: ["Alice", "Bob", "Charlie", "David"],
        voteBuffer: new Map()
      };

      const activePolls = new Map([["p_pending_bpt", pollState]]);
      const context = {
        activePolls,
        recurringPolls: new Map(),
        persistPolls: () => {},
        latestPollIdByChat: new Map([["group1@g.us", "p_pending_bpt"]])
      };

      await checkPendingLineupGenerations(mockSock, context, Date.now());

      assert.equal(pollState.status, "resolved");
      assert.ok(messageSent, "Matchups message should be sent to WhatsApp group");
      assert.match(messageSent.content.text, /Matchups|Court|Doubles|Teams/i);
    });

    describe("lineup reminders at lead time", () => {
      it("should send a lineup reminder at lead time if mode is filled and lineup is available", async () => {
        const playAt = new Date(Date.now() + 20 * 60 * 1000); // 20 mins from now
        let messageSent = null;
        const mockSock = {
          sendMessage: async (jid, content, opts) => {
            messageSent = { jid, content, opts };
            return { key: { id: "rem_lineup_msg" } };
          }
        };

        const pollState = {
          status: "resolved",
          remoteJid: "group1@g.us",
          when: "Today 6pm",
          playAt: playAt.toISOString(),
          lineupGeneration: "filled",
          lineupLeadTime: 30, // 30 mins lead time
          lineupReminderSent: false,
          lastSchedule: {
            type: "doubles",
            sets: [{
              set: 1,
              courts: [
                { court: 1, teamA: ["Alice", "Bob"], teamB: ["Charlie", "David"] },
                { court: 2, teamA: ["Eve", "Frank"], teamB: ["Grace", "Heidi"] }
              ]
            }]
          }
        };

        const activePolls = new Map([["p_filled_rem", pollState]]);
        const context = {
          activePolls,
          persistPolls: () => {}
        };

        // 1. If now is 40 mins before play time (before deadline of 30 mins): should NOT send reminder
        const fortyMinsBefore = new Date(playAt.getTime() - 40 * 60 * 1000).getTime();
        await checkPendingLineupGenerations(mockSock, context, fortyMinsBefore);
        assert.equal(messageSent, null, "Should not send reminder before lead time");
        assert.equal(pollState.lineupReminderSent, false);

        // 2. If now is 20 mins before play time (within lead time): SHOULD send reminder
        const twentyMinsBefore = new Date(playAt.getTime() - 20 * 60 * 1000).getTime();
        await checkPendingLineupGenerations(mockSock, context, twentyMinsBefore);
        assert.ok(messageSent, "Should send lineup reminder at lead time");
        assert.match(messageSent.content.text, /Match Reminder/i);
        assert.match(messageSent.content.text, /Alice & Bob vs Charlie & David/i);
        assert.equal(pollState.lineupReminderSent, true);

        // 3. Subsequent sweep should not send duplicate
        messageSent = null;
        await checkPendingLineupGenerations(mockSock, context, twentyMinsBefore + 5000);
        assert.equal(messageSent, null, "Should not send duplicate reminder");
      });

      it("should send a lineup reminder for mode none if a manual lineup was published", async () => {
        const playAt = new Date(Date.now() + 15 * 60 * 1000); // 15 mins from now
        let messageSent = null;
        const mockSock = {
          sendMessage: async (jid, content) => {
            messageSent = { jid, content };
            return { key: { id: "rem_manual_lineup" } };
          }
        };

        // Poll without manual lineup: should NOT send reminder
        const pollNoManual = {
          status: "filled",
          remoteJid: "group1@g.us",
          when: "Today 7pm",
          playAt: playAt.toISOString(),
          lineupGeneration: "none",
          lineupLeadTime: 30,
          manualLineupPosted: false
        };

        // Poll with manual lineup: SHOULD send reminder
        const pollWithManual = {
          status: "resolved",
          remoteJid: "group1@g.us",
          when: "Today 7pm",
          playAt: playAt.toISOString(),
          lineupGeneration: "none",
          lineupLeadTime: 30,
          manualLineupPosted: true,
          lineupReminderSent: false,
          lastSchedule: {
            type: "singles",
            sets: [{
              set: 1,
              courts: [{ court: 1, teamA: ["Alice"], teamB: ["Bob"] }]
            }]
          }
        };

        const activePolls = new Map([
          ["p_no_manual", pollNoManual],
          ["p_with_manual", pollWithManual]
        ]);
        const context = {
          activePolls,
          persistPolls: () => {}
        };

        await checkPendingLineupGenerations(mockSock, context, Date.now());
        assert.ok(messageSent, "Should send reminder for poll with manual lineup");
        assert.match(messageSent.content.text, /Alice vs Bob/i);
        assert.equal(pollWithManual.lineupReminderSent, true);
        assert.equal(pollNoManual.lineupReminderSent, undefined);
      });

      it("should NOT send lineup reminder if mode is fallback", async () => {
        const playAt = new Date(Date.now() + 15 * 60 * 1000);
        let messageSent = null;
        const mockSock = {
          sendMessage: async (jid, content) => {
            messageSent = { jid, content };
            return { key: { id: "msg" } };
          }
        };

        const pollFallback = {
          status: "resolved",
          remoteJid: "group1@g.us",
          when: "Today 8pm",
          playAt: playAt.toISOString(),
          lineupGeneration: "fallback",
          lineupLeadTime: 30,
          manualLineupPosted: true,
          lastSchedule: {
            type: "singles",
            sets: [{
              set: 1,
              courts: [{ court: 1, teamA: ["Alice"], teamB: ["Bob"] }]
            }]
          }
        };

        const activePolls = new Map([["p_fallback", pollFallback]]);
        const context = { activePolls, persistPolls: () => {} };

        await checkPendingLineupGenerations(mockSock, context, Date.now());
        assert.equal(messageSent, null, "Fallback mode should not send lineup reminder via checkPendingLineupGenerations");
      });
    });

    it("checkPendingLineupGenerations should NOT trigger matchups if manual lineup was posted", async () => {
      const playAt = new Date(Date.now() + 15 * 60 * 1000);
      let messageSent = null;
      const mockSock = {
        sendMessage: async (jid, content) => {
          messageSent = { jid, content };
          return { key: { id: "lineup_msg" } };
        }
      };

      const pollState = {
        status: "resolved", // Already resolved by manual lineup
        remoteJid: "group1@g.us",
        when: "Today 6pm",
        playAt: playAt.toISOString(),
        lineupGeneration: "fallback",
        lineupLeadTime: 30,
        manualLineupPosted: true, // Manual lineup was posted
        size: 4,
        type: "fixed",
        lastPlayers: ["Alice", "Bob", "Charlie", "David"]
      };

      const activePolls = new Map([["p_manual_posted", pollState]]);
      const context = {
        activePolls,
        recurringPolls: new Map(),
        persistPolls: () => {},
        latestPollIdByChat: new Map([["group1@g.us", "p_manual_posted"]])
      };

      await checkPendingLineupGenerations(mockSock, context, Date.now());
      assert.equal(messageSent, null, "Should not generate automatic matchups if manual lineup was posted");
    });

    it("should allow modifying lineupGeneration and lineupLeadTime with !modifyinstance / !modifypoll command", async () => {
      const pollState = {
        name: "Match Tomorrow 7pm",
        when: "Tomorrow 7pm",
        size: 4,
        type: "fixed",
        status: "active",
        isManual: true,
        lineupGeneration: "filled",
        lineupLeadTime: 30,
        remoteJid: "group1@g.us",
        creator: { name: "Bob", jid: "bob@s.whatsapp.net" },
        voteBuffer: new Map()
      };
      const activePolls = new Map([["p_mod_lineup", pollState]]);
      const context = { activePolls, recurringPolls: new Map(), persistPolls: () => {} };

      // Change to fallback with 90m lead time
      const cmd1 = parseModifyInstanceCommand("!modifypoll p_mod_lineup --lineup-generation=fallback --lineup-lead-time=90m");
      assert.equal(cmd1.updates.lineupGeneration, "fallback");
      assert.equal(cmd1.updates.lineupLeadTime, 90);

      const res1 = await handleModifyPollInstance(null, "group1@g.us", "Bob", "bob@s.whatsapp.net", cmd1.targetId, cmd1.updates, context);
      assert.match(res1, /Lineup generation:.*Before play time/i);
      assert.equal(pollState.lineupGeneration, "fallback");
      assert.equal(pollState.lineupLeadTime, 90);

      // Change to none
      const cmd2 = parseModifyInstanceCommand("!modifyinstance p_mod_lineup --no-lineups");
      assert.equal(cmd2.updates.lineupGeneration, "none");

      const res2 = await handleModifyPollInstance(null, "group1@g.us", "Bob", "bob@s.whatsapp.net", cmd2.targetId, cmd2.updates, context);
      assert.match(res2, /Lineup generation:.*None/i);
      assert.equal(pollState.lineupGeneration, "none");
    });

    it("should update lineup generation in-place for manual tracked polls without creating a new poll", async () => {
      let createPollCalled = false;
      const mockSock = {
        sendMessage: async () => {
          createPollCalled = true;
          return { key: { id: "new_poll" } };
        }
      };

      const manualPollState = {
        name: "Sunday Tennis 9am",
        isManual: true,
        status: "active",
        when: "Sunday 9am",
        lineupGeneration: "none",
        lineupLeadTime: 30,
        remoteJid: "group1@g.us",
        creator: { name: "Alice", jid: "alice@s.whatsapp.net" },
        voteBuffer: new Map()
      };
      const activePolls = new Map([["manual_poll_1", manualPollState]]);
      let persisted = false;
      const context = {
        activePolls,
        recurringPolls: new Map(),
        latestPollIdByChat: new Map([["group1@g.us", "manual_poll_1"]]),
        persistPolls: () => { persisted = true; }
      };

      // 1. Update lineup generation to filled on manual poll
      const cmd1 = parseModifyInstanceCommand('!modifypoll manual_poll_1 lineupGeneration=filled');
      assert.equal(cmd1.updates.lineupGeneration, "filled");

      const res1 = await handleModifyPollInstance(mockSock, "group1@g.us", "Alice", "alice@s.whatsapp.net", cmd1.targetId, cmd1.updates, context);
      assert.match(res1, /Updated configuration for manual poll/i);
      assert.match(res1, /Lineup generation:.*Filled/i);
      assert.match(res1, /WhatsApp poll message was kept intact/i);
      assert.equal(manualPollState.lineupGeneration, "filled");
      assert.equal(createPollCalled, false, "createMatchPoll should not be called for manual polls");
      assert.equal(persisted, true);

      // 2. Update lineup generation with natural language syntax "lineup generation to fallback"
      const cmd2 = parseModifyInstanceCommand('!modifypoll manual_poll_1 lineup generation to fallback');
      assert.equal(cmd2.updates.lineupGeneration, "fallback");

      const res2 = await handleModifyPollInstance(mockSock, "group1@g.us", "Alice", "alice@s.whatsapp.net", cmd2.targetId, cmd2.updates, context);
      assert.match(res2, /Updated configuration for manual poll/i);
      assert.match(res2, /Lineup generation:.*Fallback/i);
      assert.equal(manualPollState.lineupGeneration, "fallback");
      assert.equal(createPollCalled, false);

      // 3. Omitting targetId when only 1 active poll exists
      const cmd3 = parseModifyInstanceCommand('!modifypoll lineup generation none');
      assert.equal(cmd3.targetId, null);
      assert.equal(cmd3.updates.lineupGeneration, "none");

      const res3 = await handleModifyPollInstance(mockSock, "group1@g.us", "Alice", "alice@s.whatsapp.net", cmd3.targetId, cmd3.updates, context);
      assert.match(res3, /Updated configuration for manual poll/i);
      assert.match(res3, /Lineup generation:.*None/i);
      assert.equal(manualPollState.lineupGeneration, "none");
      assert.equal(createPollCalled, false);
    });

    it("should display lineup generation status in pollStatusText", () => {
      const pollState = {
        name: "Tennis Match",
        isManual: false,
        status: "active",
        remoteJid: "group1@g.us",
        when: "Tomorrow 7pm",
        playAt: new Date(Date.now() + 3600000).toISOString(),
        options: ["Player 2", "Player 3", "Player 4"],
        size: 4,
        type: "fixed",
        lineupGeneration: "fallback",
        lineupLeadTime: 30,
        voteBuffer: new Map()
      };
      const activePolls = new Map([["p_status_lineup", pollState]]);
      const status1 = pollStatusText("group1@g.us", { targetId: "p_status_lineup" }, { activePolls, recurringPolls: new Map(), messageStore: new Map() });
      assert.match(status1, /Lineup Generation: Fallback if no manual lineups posted/i);

      pollState.lineupGeneration = "filled";
      const status2 = pollStatusText("group1@g.us", { targetId: "p_status_lineup" }, { activePolls, recurringPolls: new Map(), messageStore: new Map() });
      assert.match(status2, /Lineup Generation: Filled/i);

      pollState.lineupGeneration = "none";
      const status3 = pollStatusText("group1@g.us", { targetId: "p_status_lineup" }, { activePolls, recurringPolls: new Map(), messageStore: new Map() });
      assert.match(status3, /Lineup Generation: None/i);
    });

    it("should include generated lineup or manual lineup in pollStatusText output", () => {
      const generatedSchedule = {
        type: "doubles",
        sets: [
          {
            set: 1,
            courts: [
              { court: "Court 1", teamA: ["Alice", "Bob"], teamB: ["Charlie", "Dave"] }
            ]
          },
          {
            set: 2,
            courts: [
              { court: "Court 1", teamA: ["Alice", "Charlie"], teamB: ["Bob", "Dave"] }
            ]
          }
        ]
      };

      const pollStateGenerated = {
        name: "Tennis Match",
        isManual: false,
        status: "resolved",
        remoteJid: "group1@g.us",
        when: "Tomorrow 7pm",
        size: 4,
        type: "fixed",
        voteBuffer: new Map(),
        lastSchedule: generatedSchedule,
        manualLineupPosted: false
      };

      const activePolls = new Map([["p_gen", pollStateGenerated]]);
      const statusGenerated = pollStatusText("group1@g.us", { targetId: "p_gen" }, { activePolls, recurringPolls: new Map(), messageStore: new Map() });
      assert.match(statusGenerated, /Lineup:[\s\S]*Set 1:[\s\S]*Alice & Bob vs Charlie & Dave/);
      assert.match(statusGenerated, /Set 2:[\s\S]*Alice & Charlie vs Bob & Dave/);

      const manualSchedule = {
        type: "singles",
        sets: [
          {
            set: 1,
            courts: [
              { court: "Court 2", teamA: ["Eve"], teamB: ["Frank"] }
            ]
          }
        ]
      };

      const pollStateManual = {
        name: "Tennis Singles",
        isManual: false,
        status: "resolved",
        remoteJid: "group1@g.us",
        when: "Tomorrow 8pm",
        size: 2,
        type: "fixed",
        voteBuffer: new Map(),
        lastSchedule: manualSchedule,
        manualLineupPosted: true,
        manualLineupText: "Court 2 (Singles): Eve vs Frank"
      };

      activePolls.set("p_manual", pollStateManual);
      const statusManual = pollStatusText("group1@g.us", { targetId: "p_manual" }, { activePolls, recurringPolls: new Map(), messageStore: new Map() });
      assert.match(statusManual, /Lineup \(manual\):[\s\S]*Court 2 \(Singles\):[\s\S]*Eve vs Frank/);
    });

    it("should parse lineup generation flags in recurring schedule and format correctly", async () => {
      const flags1 = extractCommonFlags("7pm everyday --lineups-fallback --lineup-lead-time=90m");
      assert.equal(flags1.flags.lineupGeneration, "fallback");
      assert.equal(flags1.flags.lineupLeadTime, 90);

      const flags2 = extractCommonFlags("7pm everyday --no-lineups");
      assert.equal(flags2.flags.lineupGeneration, "none");

      const flags3 = extractCommonFlags("7pm everyday --lineups-filled");
      assert.equal(flags3.flags.lineupGeneration, "filled");
    });

    describe("startup migration of older matchup flags", () => {
      it("should migrate active polls and recurring polls with older matchups flags to newer options", () => {
        const legacyActivePoll1 = {
          id: "p_legacy_nomatch",
          when: "Tomorrow 7pm",
          noMatchups: true
        };
        const legacyActivePoll2 = {
          id: "p_legacy_automatch",
          when: "Tomorrow 8pm",
          autoMatchups: true,
          noMatchups: false
        };
        const modernActivePoll = {
          id: "p_modern",
          when: "Tomorrow 9pm",
          lineupGeneration: "fallback",
          lineupLeadTime: 90,
          lineupLeadTimeDisplay: "90 mins",
          manualLineupPosted: false,
          lineupReminderSent: false
        };

        const legacySched1 = {
          id: "rec_legacy_nomatch",
          matchTime: "7pm",
          noMatchups: true
        };
        const legacySched2 = {
          id: "rec_legacy_automatch",
          matchTime: "8pm",
          autoMatchups: true
        };
        const modernSched = {
          id: "rec_modern",
          matchTime: "9pm",
          lineupGeneration: "fallback",
          lineupLeadTime: 60
        };

        const activePolls = new Map([
          ["p_legacy_nomatch", legacyActivePoll1],
          ["p_legacy_automatch", legacyActivePoll2],
          ["p_modern", modernActivePoll]
        ]);
        const recurringPolls = new Map([
          ["rec_legacy_nomatch", legacySched1],
          ["rec_legacy_automatch", legacySched2],
          ["rec_modern", modernSched]
        ]);

        const count1 = migratePollMatchupOptions({ activePolls, recurringPolls });
        assert.equal(count1, 4, "Should migrate 2 active polls and 2 recurring schedules");

        // Verify legacyActivePoll1
        assert.equal(legacyActivePoll1.lineupGeneration, "none");
        assert.equal(legacyActivePoll1.lineupLeadTime, 30);
        assert.equal(legacyActivePoll1.lineupLeadTimeDisplay, "30 mins");
        assert.equal(legacyActivePoll1.manualLineupPosted, false);
        assert.equal(legacyActivePoll1.noMatchups, undefined);
        assert.equal(legacyActivePoll1.autoMatchups, undefined);

        // Verify legacyActivePoll2
        assert.equal(legacyActivePoll2.lineupGeneration, "filled");
        assert.equal(legacyActivePoll2.lineupLeadTime, 30);
        assert.equal(legacyActivePoll2.lineupLeadTimeDisplay, "30 mins");
        assert.equal(legacyActivePoll2.manualLineupPosted, false);
        assert.equal(legacyActivePoll2.noMatchups, undefined);
        assert.equal(legacyActivePoll2.autoMatchups, undefined);

        // Verify legacySched1
        assert.equal(legacySched1.lineupGeneration, "none");
        assert.equal(legacySched1.lineupLeadTime, 30);
        assert.equal(legacySched1.noMatchups, undefined);
        assert.equal(legacySched1.autoMatchups, undefined);

        // Verify legacySched2
        assert.equal(legacySched2.lineupGeneration, "filled");
        assert.equal(legacySched2.lineupLeadTime, 30);
        assert.equal(legacySched2.noMatchups, undefined);
        assert.equal(legacySched2.autoMatchups, undefined);

        // Verify modern items were preserved without changes
        assert.equal(modernActivePoll.lineupGeneration, "fallback");
        assert.equal(modernActivePoll.lineupLeadTime, 90);
        assert.equal(modernSched.lineupGeneration, "fallback");
        assert.equal(modernSched.lineupLeadTime, 60);

        // Verify idempotency
        const count2 = migratePollMatchupOptions({ activePolls, recurringPolls });
        assert.equal(count2, 0, "Second migration pass should perform 0 changes");
      });
    });
  });

  describe("reminders option and consolidation", () => {
    it("should pause and resume reminders using reminders boolean", async () => {
      const pollState = {
        id: "p_rem_test",
        name: "Tennis Match",
        status: "active",
        reminders: true,
        remoteJid: "group1@g.us"
      };
      const activePolls = new Map([["p_rem_test", pollState]]);
      let persisted = false;
      const context = {
        activePolls,
        recurringPolls: new Map(),
        persistPolls: () => { persisted = true; }
      };

      // 1. Pause reminders
      const pauseRes = await handlePauseReminders(null, "group1@g.us", "Alice", "p_rem_test", context);
      assert.match(pauseRes, /Reminders have been paused/);
      assert.equal(pollState.reminders, false);
      assert.equal(pollState.remindersPaused, undefined);
      assert.equal(persisted, true);

      // Attempting to pause again
      const pauseAgain = await handlePauseReminders(null, "group1@g.us", "Alice", "p_rem_test", context);
      assert.match(pauseAgain, /already paused/);

      // 2. Resume reminders
      persisted = false;
      const resumeRes = await handleResumeReminders(null, "group1@g.us", "Alice", "p_rem_test", context);
      assert.match(resumeRes, /Reminders have been resumed/);
      assert.equal(pollState.reminders, true);
      assert.equal(pollState.remindersPaused, undefined);
      assert.equal(persisted, true);

      // Attempting to resume again
      const resumeAgain = await handleResumeReminders(null, "group1@g.us", "Alice", "p_rem_test", context);
      assert.match(resumeAgain, /already active/);
    });

    it("should sanitize and migrate legacy remindersPaused to reminders", () => {
      const legacyPollPaused = {
        remindersPaused: true
      };
      const legacyPollActive = {
        remindersPaused: false
      };
      const newPoll = {
        reminders: false
      };
      const activePolls = new Map([
        ["p1", legacyPollPaused],
        ["p2", legacyPollActive],
        ["p3", newPoll]
      ]);

      sanitizeActivePolls(activePolls);

      assert.equal(legacyPollPaused.reminders, false);
      assert.equal(legacyPollPaused.remindersPaused, undefined);

      assert.equal(legacyPollActive.reminders, true);
      assert.equal(legacyPollActive.remindersPaused, undefined);

      assert.equal(newPoll.reminders, false);
      assert.equal(newPoll.remindersPaused, undefined);
    });
  });

  describe("auto booked vs manually booked courts distinction", () => {
    it("should distinguish auto booked and manually booked courts in poll status output", () => {
      const pollState = {
        id: "p_court_status",
        remoteJid: "group1@g.us",
        when: "Tomorrow 7pm",
        size: 8,
        status: "active",
        playAt: new Date(Date.now() + 86400000).toISOString(),
        prebookedCourts: [
          { court: "Court 2", player: "Pramod", bookingType: "auto" },
          { court: "Court 3", player: "Kejal", bookingType: "manual" }
        ],
        autoBookedCourts: [
          { court: "Court 2", player: "Pramod", bookingType: "auto" }
        ],
        manuallyBookedCourts: [
          { court: "Court 3", player: "Kejal", bookingType: "manual" }
        ],
        voteBuffer: new Map()
      };
      const activePolls = new Map([["p_court_status", pollState]]);
      const text = pollStatusText("group1@g.us", {}, { activePolls, messageStore: new Map(), recurringPolls: new Map() });
      assert.match(text, /Courts: Court 2 \(auto booked\), Court 3 \(manually booked by Kejal\)/);
    });

    it("should format booking summary message distinguishing auto booked and manually booked", () => {
      const msg = scvcc.buildBookingSummaryMessage({
        targetDateMDY: "10/30/2026",
        queryTime: "7:00PM",
        sport: "tennis",
        targetCourtsCount: 2,
        advanceBookedCourts: [{ court: "Court 2", duration: "90 Minutes", reservationId: "12345" }],
        prebookedCourts: [{ court: "Court 3", player: "Kejal" }]
      });
      assert.match(msg, /• \*Court 2\* \(auto booked\) \(Doubles, 90 Minutes\) — ID: `12345`/);
      assert.match(msg, /• \*Court 3\* \(manually booked by Kejal\)/);
    });

    it("should properly structure autoBookedCourts and manuallyBookedCourts in createMatchPoll", async () => {
      const activePolls = new Map();
      const mockSock = { sendMessage: async () => ({ key: { id: "p_struct_test", remoteJid: "test@g.us" } }) };

      const res = await createMatchPoll(
        mockSock,
        "test@g.us",
        8,
        "tomorrow 7pm",
        "tomorrow",
        "7:00 PM",
        "Alice",
        "alice@lid",
        false,
        null,
        false,
        false,
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
        {
          advanceBookedCourts: [
            { court: "Court 2", reservationId: "194617", players: ["Alice", "Bob"], duration: "90 Minutes", partySize: "Doubles" }
          ],
          prebookedCourts: [
            { court: "Court 3", player: "Charlie", fullName: "Charlie, Dave", time: "7:00 PM", bookingType: "manual" }
          ]
        },
        { activePolls, messageStore: new Map() }
      );

      const pollState = activePolls.get("p_struct_test");
      assert.ok(pollState);

      // 1. autoBookedCourts has reservation details, bookedAt, bookedSource, no date, no bookingType
      assert.equal(pollState.autoBookedCourts.length, 1);
      assert.equal(pollState.autoBookedCourts[0].court, "Court 2");
      assert.equal(pollState.autoBookedCourts[0].reservationId, "194617");
      assert.equal(pollState.autoBookedCourts[0].bookedSource, "advance");
      assert.ok(pollState.autoBookedCourts[0].bookedAt);
      assert.equal(pollState.autoBookedCourts[0].date, undefined);
      assert.equal(pollState.autoBookedCourts[0].bookingType, undefined);

      // 2. advanceBookedCourts aliases autoBookedCourts
      assert.equal(pollState.advanceBookedCourts, pollState.autoBookedCourts);

      // 3. manuallyBookedCourts has court, time, players and no bookingType, date, reservationId, bookedAt, bookedSource
      assert.equal(pollState.manuallyBookedCourts.length, 1);
      assert.equal(pollState.manuallyBookedCourts[0].court, "Court 3");
      assert.equal(pollState.manuallyBookedCourts[0].bookingType, undefined);
      assert.equal(pollState.manuallyBookedCourts[0].date, undefined);
      assert.equal(pollState.manuallyBookedCourts[0].reservationId, undefined);
      assert.equal(pollState.manuallyBookedCourts[0].bookedAt, undefined);
      assert.equal(pollState.manuallyBookedCourts[0].bookedSource, undefined);
      assert.deepEqual(pollState.manuallyBookedCourts[0].players, ["Charlie", "Dave"]);

      // 4. prebookedCourts has both auto and manual combined
      assert.equal(pollState.prebookedCourts.length, 2);
      assert.equal(pollState.prebookedCourts[0].court, "Court 2");
      assert.equal(pollState.prebookedCourts[0].bookingType, "auto");
      assert.equal(pollState.prebookedCourts[1].court, "Court 3");
      assert.equal(pollState.prebookedCourts[1].bookingType, "manual");
    });
  });
  describe("tentative courts support", () => {
    it("should format tentative court title line correctly", () => {
      assert.equal(formatCourtTentativeTitleLine("Court 3", null, null), "Court 3 - Tentative");
      assert.equal(formatCourtTentativeTitleLine("3", null, null), "Court 3 - Tentative");
      assert.equal(formatCourtTentativeTitleLine("Court 3", "7:00pm", "6:30pm"), "Court 3 (7pm) - Tentative");
      assert.equal(formatCourtTentativeTitleLine("Court 3", "6:30pm", "6:30pm"), "Court 3 - Tentative");
    });

    it("should parse slot numbers ending with *", () => {
      assert.equal(getSlotNumberForOption("Player 9*"), 9);
      assert.equal(getSlotNumberForOption("Player 9 ✱"), 9);
      assert.equal(getSlotNumberForOption("Player 12*"), 12);
      assert.equal(getSlotNumberForOption("Player 12 ✱"), 12);
      assert.equal(getSlotNumberForOption("Player 1*"), 1);
      assert.equal(getSlotNumberForOption("Player 1 ✱"), 1);
    });

    it("should check tentative booking titles from groupsConfig", () => {
      const origGetConfig = groupsConfig.getGroupConfig;
      try {
        groupsConfig.getGroupConfig = () => ({
          tentativeBookingTitles: ["Clinic", "Club Event", "Team Practice"]
        });
        assert.equal(groupsConfig.isTentativeBookingTitle("Adult Tennis Clinic"), true);
        assert.equal(groupsConfig.isTentativeBookingTitle("Junior Clinic"), true);
        assert.equal(groupsConfig.isTentativeBookingTitle("Club Event"), true);
        assert.equal(groupsConfig.isTentativeBookingTitle("Private Lesson"), false);
        assert.equal(groupsConfig.isTentativeBookingTitle(null), false);
      } finally {
        groupsConfig.getGroupConfig = origGetConfig;
      }
    });

    it("should support regex match for tentative booking titles in groupsConfig", () => {
      const origGetConfig = groupsConfig.getGroupConfig;
      try {
        groupsConfig.getGroupConfig = () => ({
          tentativeBookingTitles: [
            "/^Team Practice/i",
            "/Junior.*Clinic/i",
            "/^Club Event$/i",
            "Clinic"
          ]
        });
        assert.equal(groupsConfig.isTentativeBookingTitle("Team Practice - Court 1"), true);
        assert.equal(groupsConfig.isTentativeBookingTitle("team practice"), true);
        assert.equal(groupsConfig.isTentativeBookingTitle("Morning Team Practice"), false);
        assert.equal(groupsConfig.isTentativeBookingTitle("Junior Tennis Clinic"), true);
        assert.equal(groupsConfig.isTentativeBookingTitle("Adult Clinic"), true);
        assert.equal(groupsConfig.isTentativeBookingTitle("Club Event"), true);
        assert.equal(groupsConfig.isTentativeBookingTitle("Club Event Party"), false);
        assert.equal(groupsConfig.isTentativeBookingTitle("Private Lesson"), false);
        assert.equal(groupsConfig.isTentativeBookingTitle(null), false);
      } finally {
        groupsConfig.getGroupConfig = origGetConfig;
      }
    });

    it("should detect tentative courts, place them after booked and available courts, and append * to slots", async () => {
      const origCheck = scvcc.checkCourtAvailability;
      const origBookings = scvcc.getCourtBookings;
      const origGetConfig = groupsConfig.getGroupConfig;

      try {
        groupsConfig.getGroupConfig = () => ({
          name: "Test Group",
          sport: "tennis",
          courtBookingEnabled: true,
          tentativeBookingTitles: ["Clinic", "Team Practice"]
        });

        // Setup mock availability & bookings:
        // Court 2 is booked (prebooked)
        // Court 1 is available (free)
        // Court 3 is booked with blockTitle "Tennis Clinic" (matches tentative)
        scvcc.checkCourtAvailability = async () => ({
          slots: [{
            time: "7:00 PM",
            courts: [
              { court: "Court 1", status: "available", availableMinutes: 90 },
              { court: "Court 2", status: "booked", blockTitle: "Member Match" },
              { court: "Court 3", status: "booked", blockTitle: "Tennis Clinic" }
            ]
          }]
        });

        scvcc.getCourtBookings = async () => ({
          bookings: [
            { court: "Court 2", blockTitle: "Pramod Immaneni", players: ["Pramod Immaneni"], durationMins: 90 },
            { court: "Court 3", blockTitle: "Tennis Clinic", type: "Clinic", durationMins: 90 }
          ]
        });

        let sentPoll = null;
        const mockSock = {
          sendMessage: async (jid, content) => {
            if (content.poll) sentPoll = content.poll;
            return { key: { id: "poll_tentative_test", remoteJid: jid }, message: content };
          }
        };
        const activePolls = new Map();
        const context = { activePolls, persistPolls: () => {} };

        // Test Auto Poll
        await createMatchPoll(
          mockSock,
          "group1@g.us",
          "auto",
          "Tomorrow 7pm",
          null,
          null,
          "Alice",
          "alice@s.whatsapp.net",
          false,
          null,
          false,
          false,
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
          null,
          context
        );

        assert.ok(sentPoll, "Poll should be sent");
        // Title should have Booked > Available > Tentative order
        assert.match(sentPoll.name, /Court 2 - Booked/);
        assert.match(sentPoll.name, /Court 1 - Available/);
        assert.match(sentPoll.name, /Court 3 - Tentative/);

        // Verify order in title: Court 2 (Booked) before Court 1 (Available) before Court 3 (Tentative)
        const idxBooked = sentPoll.name.indexOf("Court 2 - Booked");
        const idxAvail = sentPoll.name.indexOf("Court 1 - Available");
        const idxTentative = sentPoll.name.indexOf("Court 3 - Tentative");
        assert.ok(idxBooked < idxAvail, "Booked courts should come before Available courts in title");
        assert.ok(idxAvail < idxTentative, "Available courts should come before Tentative courts in title");

        // Verify voting slots:
        // Court 2 (slots 1..4 - booked): Player 1..Player 4 (no *)
        // Court 1 (slots 5..8 - available): Player 5*..Player 8* (has *)
        // Court 3 (slots 9..12 - tentative): Player 9*..Player 12* (has *)
        assert.equal(sentPoll.values[0], "Player 1");
        assert.equal(sentPoll.values[3], "Player 4");
        assert.equal(sentPoll.values[4], "Player 5 ✱");
        assert.equal(sentPoll.values[7], "Player 8 ✱");
        assert.equal(sentPoll.values[8], "Player 9 ✱");
        assert.equal(sentPoll.values[9], "Player 10 ✱");
        assert.equal(sentPoll.values[10], "Player 11 ✱");
        assert.equal(sentPoll.values[11], "Player 12 ✱");

        // Verify activePolls state has tentativeCourts
        const savedState = activePolls.get("poll_tentative_test");
        assert.ok(savedState);
        assert.ok(Array.isArray(savedState.tentativeCourts));
        assert.equal(savedState.tentativeCourts.length, 1);
        assert.equal(savedState.tentativeCourts[0].court, "Court 3");

        // Verify pollStatusText displays tentative courts
        const statusText = pollStatusText("group1@g.us", { targetId: "poll_tentative_test" }, { activePolls, messageStore: new Map(), recurringPolls: new Map() });
        assert.match(statusText, /Courts: Court 2 \(manually booked by [^)]+\), Court 3 \(tentative\)/);
      } finally {
        scvcc.checkCourtAvailability = origCheck;
        scvcc.getCourtBookings = origBookings;
        groupsConfig.getGroupConfig = origGetConfig;
      }
    });

    it("should allow poll creation when only tentative courts are found", async () => {
      const origCheck = scvcc.checkCourtAvailability;
      const origBookings = scvcc.getCourtBookings;
      const origGetConfig = groupsConfig.getGroupConfig;

      try {
        groupsConfig.getGroupConfig = () => ({
          name: "Test Group",
          sport: "tennis",
          courtBookingEnabled: true,
          tentativeBookingTitles: ["Clinic"]
        });

        // All courts booked, but Court 3 has Clinic (tentative)
        scvcc.checkCourtAvailability = async () => ({
          slots: [{
            time: "7:00 PM",
            courts: [
              { court: "Court 1", status: "booked", blockTitle: "Reserved" },
              { court: "Court 2", status: "booked", blockTitle: "Reserved" },
              { court: "Court 3", status: "booked", blockTitle: "Clinic" }
            ]
          }]
        });

        scvcc.getCourtBookings = async () => ({
          bookings: [
            { court: "Court 1", blockTitle: "Reserved", durationMins: 90 },
            { court: "Court 2", blockTitle: "Reserved", durationMins: 90 },
            { court: "Court 3", blockTitle: "Clinic", durationMins: 90 }
          ]
        });

        let sentPoll = null;
        const mockSock = {
          sendMessage: async (jid, content) => {
            if (content.poll) sentPoll = content.poll;
            return { key: { id: "poll_only_tentative", remoteJid: jid }, message: content };
          }
        };
        const activePolls = new Map();
        const context = { activePolls, persistPolls: () => {} };

        // Fixed poll of 4 spots
        const res = await createMatchPoll(
          mockSock,
          "group1@g.us",
          4,
          "Tomorrow 7pm",
          null,
          null,
          "Alice",
          "alice@s.whatsapp.net",
          false,
          null,
          false,
          false,
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
          null,
          context
        );

        assert.ok(sentPoll, "Poll should be created even though no free or prebooked courts exist");
        assert.match(sentPoll.name, /Court 3 - Tentative/);
        // All slots for tentative court get *
        assert.deepEqual(sentPoll.values, ["Player 1 ✱", "Player 2 ✱", "Player 3 ✱", "Player 4 ✱"]);
      } finally {
        scvcc.checkCourtAvailability = origCheck;
        scvcc.getCourtBookings = origBookings;
        groupsConfig.getGroupConfig = origGetConfig;
      }
    });
  });

  describe("cleanupExpiredPolls with 2-week check", () => {
    it("should purge untimed poll (playAt is null) if createdAt is older than 2 weeks", () => {
      const now = new Date("2026-10-29T12:00:00Z").getTime();
      const fifteenDaysAgo = new Date(now - 15 * 24 * 60 * 60 * 1000).toISOString();
      const tenDaysAgo = new Date(now - 10 * 24 * 60 * 60 * 1000).toISOString();

      const oldUntimedPoll = {
        name: "Tennis Sunday Old",
        status: "active",
        remoteJid: "group1@g.us",
        playAt: null,
        createdAt: fifteenDaysAgo
      };

      const recentUntimedPoll = {
        name: "Tennis Sunday Recent",
        status: "active",
        remoteJid: "group1@g.us",
        playAt: null,
        createdAt: tenDaysAgo
      };

      const activePolls = new Map([
        ["poll_old_untimed", oldUntimedPoll],
        ["poll_recent_untimed", recentUntimedPoll]
      ]);
      const messageStore = new Map([
        ["group1@g.us:poll_old_untimed", { msg: 1 }],
        ["group1@g.us:poll_recent_untimed", { msg: 2 }]
      ]);
      const latestPollIdByChat = new Map([["group1@g.us", "poll_recent_untimed"]]);
      let persisted = false;
      const context = {
        activePolls,
        messageStore,
        latestPollIdByChat,
        persistPolls: () => { persisted = true; }
      };

      const removed = cleanupExpiredPolls(context, now);

      assert.deepEqual(removed, ["poll_old_untimed"]);
      assert.equal(activePolls.has("poll_old_untimed"), false, "15-day-old untimed poll should be purged");
      assert.equal(activePolls.has("poll_recent_untimed"), true, "10-day-old untimed poll should be retained");
      assert.equal(messageStore.has("group1@g.us:poll_old_untimed"), false);
      assert.equal(messageStore.has("group1@g.us:poll_recent_untimed"), true);
      assert.equal(persisted, true);
    });

    it("should purge untimed poll using createdDate property if createdAt is not present", () => {
      const now = new Date("2026-10-29T12:00:00Z").getTime();
      const sixteenDaysAgo = new Date(now - 16 * 24 * 60 * 60 * 1000).toISOString();

      const pollState = {
        name: "Untimed Poll",
        status: "filled",
        remoteJid: "group1@g.us",
        playAt: null,
        createdDate: sixteenDaysAgo
      };

      const activePolls = new Map([["poll_created_date", pollState]]);
      const context = {
        activePolls,
        messageStore: new Map(),
        latestPollIdByChat: new Map([["group1@g.us", "poll_created_date"]]),
        persistPolls: () => {}
      };

      const removed = cleanupExpiredPolls(context, now);
      assert.deepEqual(removed, ["poll_created_date"]);
      assert.equal(activePolls.size, 0);
      assert.equal(context.latestPollIdByChat.has("group1@g.us"), false);
    });

    it("should purge timed poll using playAt for the 2-week check", () => {
      const now = new Date("2026-10-29T12:00:00Z").getTime();
      const fifteenDaysAgo = new Date(now - 15 * 24 * 60 * 60 * 1000).toISOString();
      const tenDaysAgo = new Date(now - 10 * 24 * 60 * 60 * 1000).toISOString();

      const oldTimedPoll = {
        name: "Timed Poll 15d",
        status: "resolved",
        remoteJid: "group1@g.us",
        playAt: fifteenDaysAgo,
        createdAt: new Date(now - 17 * 24 * 60 * 60 * 1000).toISOString()
      };

      const recentTimedPoll = {
        name: "Timed Poll 10d",
        status: "active",
        remoteJid: "group1@g.us",
        playAt: tenDaysAgo,
        createdAt: new Date(now - 12 * 24 * 60 * 60 * 1000).toISOString()
      };

      const activePolls = new Map([
        ["poll_old_timed", oldTimedPoll],
        ["poll_recent_timed", recentTimedPoll]
      ]);
      const context = {
        activePolls,
        messageStore: new Map(),
        latestPollIdByChat: new Map(),
        persistPolls: () => {}
      };

      const removed = cleanupExpiredPolls(context, now);
      assert.deepEqual(removed, ["poll_old_timed"]);
      assert.equal(activePolls.has("poll_old_timed"), false);
      assert.equal(activePolls.has("poll_recent_timed"), true);
      // recentTimedPoll passed playAt, so status should become 'expired'
      assert.equal(recentTimedPoll.status, "expired");
    });

    it("should expire untimed manual polls with today/tomorrow/weekday/date in title once the day passes", async () => {
      // Created Monday Nov 23, 2026 at 10:00 AM PST (18:00:00Z)
      const createdAt = "2026-11-23T18:00:00.000Z";

      const todayPoll = {
        name: "Tennis today",
        isManual: true,
        status: "active",
        remoteJid: "group1@g.us",
        when: "Tennis today",
        dayWord: null,
        playAt: null,
        createdAt,
        voteBuffer: new Map()
      };
      const tomorrowPoll = {
        name: "Tennis tomorrow",
        isManual: true,
        status: "active",
        remoteJid: "group1@g.us",
        when: "Tennis tomorrow",
        dayWord: "tomorrow",
        playAt: null,
        createdAt,
        voteBuffer: new Map()
      };
      const fridayPoll = {
        name: "Friday doubles",
        isManual: true,
        status: "active",
        remoteJid: "group1@g.us",
        when: "Friday",
        dayWord: "Friday",
        playAt: null,
        createdAt,
        voteBuffer: new Map()
      };
      const datePoll = {
        name: "Tennis 11/25",
        isManual: true,
        status: "active",
        remoteJid: "group1@g.us",
        when: "Tennis 11/25",
        dayWord: null,
        playAt: null,
        createdAt,
        voteBuffer: new Map()
      };
      const undatedPoll = {
        name: "Tennis 4 spots",
        isManual: true,
        status: "active",
        remoteJid: "group1@g.us",
        when: "Tennis 4 spots",
        dayWord: null,
        playAt: null,
        createdAt,
        voteBuffer: new Map()
      };

      const activePolls = new Map([
        ["p_today", todayPoll],
        ["p_tomorrow", tomorrowPoll],
        ["p_friday", fridayPoll],
        ["p_date", datePoll],
        ["p_undated", undatedPoll]
      ]);
      const context = { activePolls, messageStore: new Map(), latestPollIdByChat: new Map(), persistPolls: () => {} };

      // Still Monday Nov 23, 11:55 PM PST (2026-11-24T07:55:00Z): nothing expired yet
      const monLate = new Date("2026-11-24T07:55:00.000Z").getTime();
      cleanupExpiredPolls(context, monLate);
      assert.equal(todayPoll.status, "active");
      assert.equal(tomorrowPoll.status, "active");
      assert.equal(fridayPoll.status, "active");
      assert.equal(datePoll.status, "active");
      assert.equal(undatedPoll.status, "active");

      // Tuesday Nov 24, 12:05 AM PST (2026-11-24T08:05:00Z): "today" poll has expired, "tomorrow" is still active
      const tueEarly = new Date("2026-11-24T08:05:00.000Z").getTime();
      cleanupExpiredPolls(context, tueEarly);
      assert.equal(todayPoll.status, "expired");
      assert.equal(tomorrowPoll.status, "active");
      assert.equal(fridayPoll.status, "active");
      assert.equal(datePoll.status, "active");
      assert.equal(undatedPoll.status, "active");

      // Wednesday Nov 25, 12:05 AM PST (2026-11-25T08:05:00Z): "tomorrow" poll expires too (via checkAndSendPollReminders as well)
      const wedEarly = new Date("2026-11-25T08:05:00.000Z").getTime();
      await checkAndSendPollReminders({ user: { id: "bot@s.whatsapp.net" }, sendMessage: async () => {} }, context, wedEarly);
      assert.equal(tomorrowPoll.status, "expired");
      assert.equal(datePoll.status, "active"); // Nov 25 hasn't ended yet
      assert.equal(fridayPoll.status, "active");
      assert.equal(undatedPoll.status, "active");

      // Thursday Nov 26, 12:05 AM PST (2026-11-26T08:05:00Z): "11/25" poll expires
      const thuEarly = new Date("2026-11-26T08:05:00.000Z").getTime();
      cleanupExpiredPolls(context, thuEarly);
      assert.equal(datePoll.status, "expired");
      assert.equal(fridayPoll.status, "active");
      assert.equal(undatedPoll.status, "active");

      // !upcomingpolls hides polls whose day has passed even before cleanup runs, while retaining Friday and undated polls
      const yesterdayIso = new Date(Date.now() - 26 * 3600 * 1000).toISOString();
      const statusCheckPoll = {
        name: "Tennis today",
        isManual: true,
        status: "active",
        remoteJid: "group1@g.us",
        when: "Tennis today",
        playAt: null,
        createdAt: yesterdayIso,
        voteBuffer: new Map()
      };
      const upcomingOut = pollStatusText("group1@g.us", { upcomingOnly: true }, {
        activePolls: new Map([["p_today_uncleaned", statusCheckPoll], ["p_undated", undatedPoll]]),
        recurringPolls: new Map(),
        messageStore: new Map()
      });
      assert.doesNotMatch(upcomingOut, /p_today_uncleaned/);
      assert.match(upcomingOut, /p_undated/);
    });
  });
  describe('max-courts option for auto polls', () => {
    it('Example 1: max-courts=3 with courts 2 & 3 prebooked and court 1 available -> 3 courts, 12 slots', async () => {
      const origCheck = scvcc.checkCourtAvailability;
      const origBookings = scvcc.getCourtBookings;
      const origGetConfig = groupsConfig.getGroupConfig;

      try {
        groupsConfig.getGroupConfig = () => ({
          name: 'Test Group',
          sport: 'tennis',
          courtBookingEnabled: true,
          defaultBookingPlayers: ['Pramod Immaneni', 'Conrad Rodricks']
        });

        // Court 2 and Court 3 booked, Court 1 available
        scvcc.checkCourtAvailability = async () => ({
          slots: [{
            time: '7:00 PM',
            courts: [
              { court: 'Court 1', status: 'available', availableMinutes: 90 },
              { court: 'Court 2', status: 'booked', blockTitle: 'Member Match' },
              { court: 'Court 3', status: 'booked', blockTitle: 'Member Match' }
            ]
          }]
        });

        scvcc.getCourtBookings = async () => ({
          bookings: [
            { court: 'Court 2', blockTitle: 'Member Match', players: ['Pramod Immaneni'], durationMins: 90 },
            { court: 'Court 3', blockTitle: 'Member Match', players: ['Conrad Rodricks'], durationMins: 90 }
          ]
        });

        let sentPoll = null;
        const mockSock = {
          sendMessage: async (jid, content) => {
            if (content.poll) sentPoll = content.poll;
            return { key: { id: 'poll_maxcourts_ex1', remoteJid: jid }, message: content };
          }
        };
        const activePolls = new Map();
        const context = { activePolls, recurringPolls: new Map(), messageStore: new Map(), latestPollIdByChat: new Map(), persistPolls: () => {} };

        const res = await createMatchPoll(
          mockSock,
          'group1@g.us',
          'auto',
          'Tomorrow 7pm',
          null,
          null,
          'Alice',
          'alice@s.whatsapp.net',
          false,
          null,
          false,
          false,
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
          null,
          context,
          { maxCourts: 3 }
        );

        assert.ok(sentPoll, 'Poll should be sent');
        assert.equal(sentPoll.values.length, 12, 'Voting slots should be 12 (4 * 3 courts)');
        assert.equal(res.size, 12, 'Size should be 12');
        assert.equal(res.votingSpotsCount, 12, 'Voting spots count should be 12');
        assert.equal(res.maxCourts, 3, 'Max courts should be 3');
        const pollState = activePolls.get(res.pollId);
        assert.equal(pollState.maxCourts, 3, 'Max courts in pollState should be 3');
        const courtsCount = (pollState.prebookedCourts?.length || 0) + (pollState.unbookedCourts?.length || 0) + (pollState.tentativeCourts?.length || 0);
        assert.equal(courtsCount, 3, 'Total courts count should be 3');
        assert.match(sentPoll.name, /Court 2 - Booked/);
        assert.match(sentPoll.name, /Court 3 - Booked/);
        assert.match(sentPoll.name, /Court 1 - Available/);
      } finally {
        scvcc.checkCourtAvailability = origCheck;
        scvcc.getCourtBookings = origBookings;
        groupsConfig.getGroupConfig = origGetConfig;
      }
    });

    it('Example 2: max-courts=3 with court 2 prebooked, court 5 tentative, and no other court available -> 2 courts, 8 slots', async () => {
      const origCheck = scvcc.checkCourtAvailability;
      const origBookings = scvcc.getCourtBookings;
      const origGetConfig = groupsConfig.getGroupConfig;

      try {
        groupsConfig.getGroupConfig = () => ({
          name: 'Test Group',
          sport: 'tennis',
          courtBookingEnabled: true,
          tentativeBookingTitles: ['Clinic']
        });

        // Court 2 booked (regular), Court 5 booked with Clinic (tentative), no other available
        scvcc.checkCourtAvailability = async () => ({
          slots: [{
            time: '7:00 PM',
            courts: [
              { court: 'Court 2', status: 'booked', blockTitle: 'Member Match' },
              { court: 'Court 5', status: 'booked', blockTitle: 'Tennis Clinic' }
            ]
          }]
        });

        scvcc.getCourtBookings = async () => ({
          bookings: [
            { court: 'Court 2', blockTitle: 'Member Match', players: ['Pramod Immaneni'], durationMins: 90 },
            { court: 'Court 5', blockTitle: 'Tennis Clinic', type: 'Clinic', durationMins: 90 }
          ]
        });

        let sentPoll = null;
        const mockSock = {
          sendMessage: async (jid, content) => {
            if (content.poll) sentPoll = content.poll;
            return { key: { id: 'poll_maxcourts_ex2', remoteJid: jid }, message: content };
          }
        };
        const activePolls = new Map();
        const context = { activePolls, recurringPolls: new Map(), messageStore: new Map(), latestPollIdByChat: new Map(), persistPolls: () => {} };

        const res = await createMatchPoll(
          mockSock,
          'group1@g.us',
          'auto',
          'Tomorrow 7pm',
          null,
          null,
          'Alice',
          'alice@s.whatsapp.net',
          false,
          null,
          false,
          false,
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
          null,
          context,
          { maxCourts: 3 }
        );

        assert.ok(sentPoll, 'Poll should be sent');
        assert.equal(sentPoll.values.length, 8, 'Voting slots should be 8 (4 * 2 courts)');
        assert.equal(res.size, 8, 'Size should be 8');
        assert.equal(res.votingSpotsCount, 8, 'Voting spots count should be 8');
        assert.equal(res.maxCourts, 3, 'Max courts should be 3');
        const pollState = activePolls.get(res.pollId);
        assert.equal(pollState.maxCourts, 3, 'Max courts in pollState should be 3');
        const courtsCount = (pollState.prebookedCourts?.length || 0) + (pollState.unbookedCourts?.length || 0) + (pollState.tentativeCourts?.length || 0);
        assert.equal(courtsCount, 2, 'Total courts count should be 2');
        assert.match(sentPoll.name, /Court 2 - Booked/);
        assert.match(sentPoll.name, /Court 5 - Tentative/);
      } finally {
        scvcc.checkCourtAvailability = origCheck;
        scvcc.getCourtBookings = origBookings;
        groupsConfig.getGroupConfig = origGetConfig;
      }
    });

    it('Example 3: max-courts=3 with courts 2, 3, 1, 5, 6 free -> 3 courts, 12 slots', async () => {
      const origCheck = scvcc.checkCourtAvailability;
      const origBookings = scvcc.getCourtBookings;
      const origGetConfig = groupsConfig.getGroupConfig;

      try {
        groupsConfig.getGroupConfig = () => ({
          name: 'Test Group',
          sport: 'tennis',
          courtBookingEnabled: true,
          bookingCourtPreference: '2, 3, 1, 5, 6'
        });

        // Courts 2, 3, 1, 5, 6 available
        scvcc.checkCourtAvailability = async () => ({
          slots: [{
            time: '7:00 PM',
            courts: [
              { court: 'Court 1', status: 'available', availableMinutes: 90 },
              { court: 'Court 2', status: 'available', availableMinutes: 90 },
              { court: 'Court 3', status: 'available', availableMinutes: 90 },
              { court: 'Court 5', status: 'available', availableMinutes: 90 },
              { court: 'Court 6', status: 'available', availableMinutes: 90 }
            ]
          }]
        });

        scvcc.getCourtBookings = async () => ({ bookings: [] });

        let sentPoll = null;
        const mockSock = {
          sendMessage: async (jid, content) => {
            if (content.poll) sentPoll = content.poll;
            return { key: { id: 'poll_maxcourts_ex3', remoteJid: jid }, message: content };
          }
        };
        const activePolls = new Map();
        const context = { activePolls, recurringPolls: new Map(), messageStore: new Map(), latestPollIdByChat: new Map(), persistPolls: () => {} };

        const res = await createMatchPoll(
          mockSock,
          'group1@g.us',
          'auto',
          'Tomorrow 7pm',
          null,
          null,
          'Alice',
          'alice@s.whatsapp.net',
          false,
          null,
          false,
          false,
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
          null,
          context,
          { maxCourts: 3 }
        );

        assert.ok(sentPoll, 'Poll should be sent');
        assert.equal(sentPoll.values.length, 12, 'Voting slots should be 12 (4 * 3 courts)');
        assert.equal(res.size, 12, 'Size should be 12');
        assert.equal(res.votingSpotsCount, 12, 'Voting spots count should be 12');
        assert.equal(res.maxCourts, 3, 'Max courts should be 3');
        const pollState = activePolls.get(res.pollId);
        assert.equal(pollState.maxCourts, 3, 'Max courts in pollState should be 3');
        const courtsCount = (pollState.prebookedCourts?.length || 0) + (pollState.unbookedCourts?.length || 0) + (pollState.tentativeCourts?.length || 0);
        assert.equal(courtsCount, 3, 'Total courts count should be 3');
        // Preferred courts: Court 2, 3, 1
        assert.match(sentPoll.name, /Court 2 - Available/);
        assert.match(sentPoll.name, /Court 3 - Available/);
        assert.match(sentPoll.name, /Court 1 - Available/);
        assert.doesNotMatch(sentPoll.name, /Court 5/);
        assert.doesNotMatch(sentPoll.name, /Court 6/);
      } finally {
        scvcc.checkCourtAvailability = origCheck;
        scvcc.getCourtBookings = origBookings;
        groupsConfig.getGroupConfig = origGetConfig;
      }
    });

    it('should display Max Courts in pollStatusText for auto poll', () => {
      const pollState = {
        name: 'Tennis Match (Auto: Court 2 - Booked, Court 1 - Available)',
        size: 'auto',
        isAuto: true,
        maxCourts: 3,
        status: 'active',
        creator: { name: 'Alice' },
        remoteJid: 'group1@g.us',
        playAt: new Date(Date.now() + 3600000).toISOString(),
        options: ['Player 1', 'Player 2', 'Player 3', 'Player 4', 'Player 5*', 'Player 6*', 'Player 7*', 'Player 8*'],
        votes: {},
        voteBuffer: new Map()
      };
      const activePolls = new Map([['p_status_maxcourts', pollState]]);
      const status = pollStatusText('group1@g.us', { targetId: 'p_status_maxcourts' }, { activePolls, recurringPolls: new Map(), messageStore: new Map() });
      assert.match(status, /Max Courts:\s*3/);
    });

    it('should support modifying maxCourts via !modifyinstance / !modifypoll', async () => {
      const origCheck = scvcc.checkCourtAvailability;
      const origBookings = scvcc.getCourtBookings;
      const origGetConfig = groupsConfig.getGroupConfig;

      try {
        groupsConfig.getGroupConfig = () => ({
          name: 'Test Group',
          sport: 'tennis',
          courtBookingEnabled: true
        });

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

        let sentPoll = null;
        const mockSock = {
          sendMessage: async (jid, content) => {
            if (content.poll) sentPoll = content.poll;
            return { key: { id: 'p_mod_new', remoteJid: jid }, message: content };
          }
        };

        const pollState = {
          id: 'p_mod_maxcourts',
          name: 'Tennis Match (Tomorrow 7pm)',
          size: 'auto',
          isAuto: true,
          maxCourts: 2,
          checkCourts: true,
          status: 'active',
          creator: { name: 'Alice', jid: 'alice@s.whatsapp.net' },
          remoteJid: 'group1@g.us',
          playAt: new Date(Date.now() + 3600000).toISOString(),
          options: ['Player 1', 'Player 2', 'Player 3', 'Player 4', 'Player 5*', 'Player 6*', 'Player 7*', 'Player 8*'],
          votes: {},
          voteBuffer: new Map()
        };
        const activePolls = new Map([['p_mod_maxcourts', pollState]]);
        const context = { activePolls, recurringPolls: new Map(), messageStore: new Map(), latestPollIdByChat: new Map(), persistPolls: () => {} };

        const cmd1 = parseModifyInstanceCommand('!modifyinstance p_mod_maxcourts --max-courts=3');
        assert.equal(cmd1.updates.maxCourts, 3);

        const res1 = await handleModifyPollInstance(mockSock, 'group1@g.us', 'Alice', 'alice@s.whatsapp.net', cmd1.targetId, cmd1.updates, context);
        assert.match(res1, /Modified recurring poll instance/i);
        assert.match(res1, /\*Max Courts:\*\s*3/i);

        const newPoll = activePolls.get('p_mod_new');
        assert.ok(newPoll, 'New poll should exist in activePolls');
        assert.equal(newPoll.maxCourts, 3);
        assert.equal(newPoll.options.length, 12);
      } finally {
        scvcc.checkCourtAvailability = origCheck;
        scvcc.getCourtBookings = origBookings;
        groupsConfig.getGroupConfig = origGetConfig;
      }
    });
    it('should split poll with > 12 slots (e.g. 16 spots) into court-based multi-polls', async () => {
      let sentPolls = [];
      const mockSock = {
        user: { id: 'tenbot@s.whatsapp.net' },
        sendMessage: async (jid, payload) => {
          sentPolls.push(payload);
          return { key: { id: `poll_16_slots_${sentPolls.length}`, remoteJid: jid } };
        }
      };

      const activePolls = new Map();
      const messageStore = new Map();
      const context = {
        activePolls,
        messageStore,
        latestPollIdByChat: new Map(),
        persistPolls: () => {}
      };

      // Creating a poll for 16 spots (with creator included -> 1 creator + 15 slots)
      const res = await createMatchPoll(
        mockSock,
        'group1@g.us',
        16,
        'tomorrow 7pm',
        'tomorrow',
        '7pm',
        'Alice',
        'alice@s.whatsapp.net',
        true,
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
        context
      );

      assert.ok(res, 'Poll result should exist');
      assert.equal(res.isOptIn, false, 'Should remain a fixed multi-poll, not opt-in');
      assert.equal(res.isMultiPoll, true, 'Should be marked as multi-poll');
      assert.equal(res.totalParts, 2, 'Should have 2 parts');
      assert.deepEqual(res.batches, [12, 4]);
      assert.equal(res.pollIds.length, 2, 'Should create 2 polls');
      assert.match(res.pollTitle, /Part 1\/2/);

      assert.equal(sentPolls.length, 2, '2 poll messages should have been sent to WhatsApp');
      // Part 1 has Alice as creator + Player 2 to Player 12 (11 slots)
      assert.equal(sentPolls[0].poll.values.length, 11);
      assert.match(sentPolls[0].poll.name, /Part 1\/2: Spots 1–12/);
      assert.deepEqual(sentPolls[0].poll.values, ['Player 2', 'Player 3', 'Player 4', 'Player 5', 'Player 6', 'Player 7', 'Player 8', 'Player 9', 'Player 10', 'Player 11', 'Player 12']);

      // Part 2 has Player 13 to Player 16 (4 slots)
      assert.equal(sentPolls[1].poll.values.length, 4);
      assert.match(sentPolls[1].poll.name, /Part 2\/2: Spots 13–16/);
      assert.deepEqual(sentPolls[1].poll.values, ['Player 13', 'Player 14', 'Player 15', 'Player 16']);

      const pollState1 = activePolls.get('poll_16_slots_1');
      const pollState2 = activePolls.get('poll_16_slots_2');
      assert.ok(pollState1 && pollState2, 'Both poll states should be stored');
      assert.equal(pollState1.parentPollId, pollState2.parentPollId);
      assert.deepEqual(pollState1.siblingPollIds, ['poll_16_slots_2']);
      assert.deepEqual(pollState2.siblingPollIds, ['poll_16_slots_1']);
    });

    it('should split auto poll with 4 courts (16 slots) into multi-polls', async () => {
      let sentPolls = [];
      const mockSock = {
        user: { id: 'tenbot@s.whatsapp.net' },
        sendMessage: async (jid, payload) => {
          sentPolls.push(payload);
          return { key: { id: `poll_auto_4courts_${sentPolls.length}`, remoteJid: jid } };
        }
      };

      const activePolls = new Map();
      const messageStore = new Map();
      const context = {
        activePolls,
        messageStore,
        latestPollIdByChat: new Map(),
        persistPolls: () => {}
      };

      const preExistingBookings = {
        advanceBookedCourts: [
          { court: 'Court 1', player: 'Alice', time: '7pm' },
          { court: 'Court 2', player: 'Bob', time: '7pm' },
          { court: 'Court 3', player: 'Charlie', time: '7pm' },
          { court: 'Court 4', player: 'Dave', time: '7pm' }
        ]
      };

      const res = await createMatchPoll(
        mockSock,
        'group1@g.us',
        'auto',
        'tomorrow 7pm',
        'tomorrow',
        '7pm',
        'Alice',
        'alice@s.whatsapp.net',
        false,
        null,
        false,
        true,
        false,
        true,
        false,
        false,
        null,
        null,
        null,
        null,
        null,
        null,
        preExistingBookings,
        context
      );

      assert.ok(res, 'Poll result should exist');
      assert.equal(res.isOptIn, false);
      assert.equal(res.isMultiPoll, true);
      assert.equal(res.totalParts, 2);
      assert.deepEqual(res.batches, [12, 4]);
      assert.equal(sentPolls.length, 2);
      assert.equal(sentPolls[0].poll.values.length, 12);
      assert.equal(sentPolls[1].poll.values.length, 4);
    });

    it('dynamically creates an enumerated poll when 3 courts are available and converts to Yes/No poll when 4 courts are available (maxCourts: 4)', async () => {
      const origCheck = scvcc.checkCourtAvailability;
      const origBookings = scvcc.getCourtBookings;
      const origGetConfig = groupsConfig.getGroupConfig;

      try {
        groupsConfig.getGroupConfig = () => ({ sport: 'tennis', courtConfig: 'SCVCC', maxCourts: 4 });
        scvcc.getCourtBookings = async () => ({ bookings: [] });

        let sentPolls = [];
        const mockSock = {
          user: { id: 'tenbot@s.whatsapp.net' },
          sendMessage: async (jid, payload) => {
            sentPolls.push(payload);
            return { key: { id: `poll_${sentPolls.length}`, remoteJid: jid } };
          }
        };

        const activePolls = new Map();
        const messageStore = new Map();
        const context = { activePolls, messageStore, latestPollIdByChat: new Map(), persistPolls: () => {} };

        // Day A: Only 3 courts available
        scvcc.checkCourtAvailability = async () => ({
          slots: [{
            time: '7pm',
            courts: [
              { court: 'Court 1', status: 'available', availableMinutes: 90 },
              { court: 'Court 2', status: 'available', availableMinutes: 90 },
              { court: 'Court 3', status: 'available', availableMinutes: 90 }
            ]
          }]
        });

        const res3 = await createMatchPoll(
          mockSock,
          'group1@g.us',
          'auto',
          'tomorrow 7pm',
          'tomorrow',
          '7pm',
          'Alice',
          'alice@s.whatsapp.net',
          false,
          null,
          false,
          true,
          false,
          true,
          false,
          true,
          'rec_schedule_1',
          null,
          null,
          null,
          null,
          null,
          null,
          { maxCourts: 4 },
          context
        );

        assert.equal(res3.isOptIn, false, '3 courts (12 slots) should remain a regular enumerated poll');
        assert.equal(res3.options.length, 12, 'Should have 12 player slots');
        assert.match(res3.pollTitle, /\(12 slots \/ 12\)/);
        assert.equal(sentPolls[0].poll.values.length, 12);

        // Day B: 4 courts available
        scvcc.checkCourtAvailability = async () => ({
          slots: [{
            time: '7pm',
            courts: [
              { court: 'Court 1', status: 'available', availableMinutes: 90 },
              { court: 'Court 2', status: 'available', availableMinutes: 90 },
              { court: 'Court 3', status: 'available', availableMinutes: 90 },
              { court: 'Court 5', status: 'available', availableMinutes: 90 }
            ]
          }]
        });

        const res4 = await createMatchPoll(
          mockSock,
          'group1@g.us',
          'auto',
          'tomorrow 7pm',
          'tomorrow',
          '7pm',
          'Alice',
          'alice@s.whatsapp.net',
          false,
          null,
          false,
          true,
          false,
          true,
          false,
          true,
          'rec_schedule_2',
          null,
          null,
          null,
          null,
          null,
          null,
          { maxCourts: 4 },
          context
        );

        assert.equal(res4.isOptIn, false, '4 courts (16 slots) should split into multi-polls');
        assert.equal(res4.isMultiPoll, true);
        assert.equal(res4.totalParts, 2);
        assert.deepEqual(sentPolls[1].poll.values.length, 12);
        assert.deepEqual(sentPolls[2].poll.values.length, 4);
      } finally {
        scvcc.checkCourtAvailability = origCheck;
        scvcc.getCourtBookings = origBookings;
        groupsConfig.getGroupConfig = origGetConfig;
      }
    });
  });

  describe("Pending poll vote buffering and robust secret extraction", () => {
    it("should buffer a vote when poll is not yet in activePolls and process it as soon as poll is registered", async () => {
      const crypto = require("crypto");
      function makeOptHash(name) {
        return crypto.createHash("sha256").update(name).digest();
      }

      const activePolls = new Map();
      const messageStore = new Map();
      const mockSock = { sendMessage: async () => {} };
      const context = { activePolls, messageStore, persistPolls: () => {} };

      const pollId = "poll_early_vote_test";
      const pollKey = { id: pollId, remoteJid: "group1@g.us" };
      const updateEntry = {
        pollUpdateMessageKey: { participant: "voter1@s.whatsapp.net", id: "vote_early_1" },
        vote: { selectedOptions: [makeOptHash("Player 1")] },
        senderTimestampMs: Date.now()
      };

      // Vote arrives BEFORE poll is in activePolls
      assert.equal(activePolls.has(pollId), false);
      const bufferPromise = bufferPendingVote(pollId, pollKey, updateEntry, mockSock, context);

      assert.equal(pendingPollVotes.has(pollId), true);
      assert.equal(pendingPollVotes.get(pollId).length, 1);

      // Simulate poll creation completing 100ms later (e.g. LLM verification finished)
      await new Promise((r) => setTimeout(r, 100));

      const pollState = {
        remoteJid: "group1@g.us",
        name: "Tennis Today 7pm",
        options: ["Player 1", "Player 2", "Player 3", "Player 4"],
        size: 4,
        type: "fixed",
        status: "active",
        isManual: true,
        voteBuffer: new Map()
      };
      activePolls.set(pollId, pollState);
      messageStore.set("group1@g.us:" + pollId, {
        pollCreationMessage: {
          options: pollState.options.map((o) => ({ optionName: o }))
        }
      });

      // Flush pending votes
      await flushPendingPollVotes(pollId, mockSock, context);
      await bufferPromise;

      // The early vote must be recorded in voteBuffer!
      assert.equal(pollState.voteBuffer.size, 1);
      assert.equal(pendingPollVotes.has(pollId), false);
    });

    it("should extract messageSecret from WebMessageInfo, inner message, and ephemeralMessage wrappers", () => {
      const secretBytes = Buffer.from("01234567890123456789012345678901");

      // Case A: Flat message object
      const flatMsg = {
        messageContextInfo: { messageSecret: secretBytes }
      };
      assert.deepEqual(getMessageSecret(flatMsg), secretBytes);

      // Case B: WebMessageInfo structure (msg.message.messageContextInfo)
      const webMsg = {
        key: { id: "123", remoteJid: "group@g.us" },
        message: {
          messageContextInfo: { messageSecret: secretBytes }
        }
      };
      assert.deepEqual(getMessageSecret(webMsg), secretBytes);

      // Case C: Disappearing / Ephemeral message structure
      const ephemeralMsg = {
        key: { id: "123", remoteJid: "group@g.us" },
        message: {
          ephemeralMessage: {
            message: {
              messageContextInfo: { messageSecret: secretBytes }
            }
          }
        }
      };
      assert.deepEqual(getMessageSecret(ephemeralMsg), secretBytes);

      // Case D: Null / missing secret returns null
      assert.equal(getMessageSecret(null), null);
      assert.equal(getMessageSecret({ message: {} }), null);
    });

    it("getPollVoters should aggregate votes when creationMessage in messageStore is WebMessageInfo", () => {
      const crypto = require("crypto");
      function makeOptHash(name) {
        return crypto.createHash("sha256").update(name).digest();
      }

      const pollId = "poll_webmsg_agg_test";
      const pollState = {
        remoteJid: "group1@g.us",
        options: ["Player 1", "Player 2"],
        type: "fixed",
        voteBuffer: new Map([
          ["111@s.whatsapp.net", {
            pollUpdateMessageKey: { participant: "111@s.whatsapp.net" },
            vote: { selectedOptions: [makeOptHash("Player 1")] }
          }]
        ])
      };

      const messageStore = new Map([
        ["group1@g.us:" + pollId, {
          key: { id: pollId, remoteJid: "group1@g.us" },
          message: {
            pollCreationMessage: {
              name: "Match",
              options: [{ optionName: "Player 1" }, { optionName: "Player 2" }]
            }
          }
        }]
      ]);

      const { aggregated, interestedPlayers } = getPollVoters(pollId, pollState, "bot@s.whatsapp.net", messageStore);
      assert.equal(aggregated.length, 2);
      assert.equal(interestedPlayers.length, 1);
    });
  });

  describe("configurable quiet hours for reminders", () => {
    describe("parseQuietHours", () => {
      it("should parse 12-hour format strings (10pm-7am, 10pm to 7am)", () => {
        const qh1 = groupsConfig.parseQuietHours("10pm-7am");
        assert.ok(qh1);
        assert.equal(qh1.enabled, true);
        assert.equal(qh1.start, "22:00");
        assert.equal(qh1.end, "07:00");
        assert.equal(qh1.startHour, 22);
        assert.equal(qh1.startMinute, 0);
        assert.equal(qh1.endHour, 7);
        assert.equal(qh1.endMinute, 0);
        assert.equal(qh1.raw, "22:00-07:00");
        assert.equal(qh1.display, "10:00 PM – 7:00 AM");

        const qh2 = groupsConfig.parseQuietHours("10pm to 7am");
        assert.ok(qh2);
        assert.equal(qh2.raw, "22:00-07:00");
      });

      it("should parse times with minutes (10:30pm to 6:30am)", () => {
        const qh = groupsConfig.parseQuietHours("10:30pm to 6:30am");
        assert.ok(qh);
        assert.equal(qh.enabled, true);
        assert.equal(qh.start, "22:30");
        assert.equal(qh.end, "06:30");
        assert.equal(qh.startHour, 22);
        assert.equal(qh.startMinute, 30);
        assert.equal(qh.endHour, 6);
        assert.equal(qh.endMinute, 30);
        assert.equal(qh.raw, "22:30-06:30");
        assert.equal(qh.display, "10:30 PM – 6:30 AM");
      });

      it("should parse 24-hour format strings (22:00-07:00)", () => {
        const qh = groupsConfig.parseQuietHours("22:00-07:00");
        assert.ok(qh);
        assert.equal(qh.enabled, true);
        assert.equal(qh.start, "22:00");
        assert.equal(qh.end, "07:00");
        assert.equal(qh.raw, "22:00-07:00");
        assert.equal(qh.display, "10:00 PM – 7:00 AM");
      });

      it("should parse off / none / disable / disabled as disabled", () => {
        const qhOff = groupsConfig.parseQuietHours("off");
        assert.ok(qhOff);
        assert.equal(qhOff.enabled, false);
        assert.equal(qhOff.raw, "off");
        assert.equal(qhOff.display, "Disabled (Off)");

        const qhNone = groupsConfig.parseQuietHours("none");
        assert.equal(qhNone.enabled, false);

        const qhDisable = groupsConfig.parseQuietHours("disable");
        assert.equal(qhDisable.enabled, false);

        const qhFalse = groupsConfig.parseQuietHours(false);
        assert.equal(qhFalse.enabled, false);
      });

      it("should return default 22:00-07:00 for undefined or null", () => {
        const def = groupsConfig.parseQuietHours(null);
        assert.ok(def);
        assert.equal(def.enabled, true);
        assert.equal(def.raw, "22:00-07:00");
        assert.equal(def.display, "10:00 PM – 7:00 AM");
      });

      it("should return null for invalid formats", () => {
        assert.equal(groupsConfig.parseQuietHours("invalid"), null);
        assert.equal(groupsConfig.parseQuietHours("hello-world"), null);
        assert.equal(groupsConfig.parseQuietHours(""), null);
      });
    });

    describe("isInQuietHours & isQuietHoursWakeUpWindow", () => {
      it("should check isInQuietHours for default 10:00 PM - 7:00 AM window", () => {
        // Saturday Oct 24, 2026: San Jose is in PDT (UTC-7)
        // 21:59 PDT = 04:59 UTC
        const t959pm = new Date("2026-10-25T04:59:00Z").getTime();
        assert.equal(groupsConfig.isInQuietHours(t959pm, "group_default@g.us"), false);

        // 22:00 PDT = 05:00 UTC
        const t1000pm = new Date("2026-10-25T05:00:00Z").getTime();
        assert.equal(groupsConfig.isInQuietHours(t1000pm, "group_default@g.us"), true);

        // 23:30 PDT = 06:30 UTC
        const t1130pm = new Date("2026-10-25T06:30:00Z").getTime();
        assert.equal(groupsConfig.isInQuietHours(t1130pm, "group_default@g.us"), true);

        // 06:59 PDT = 13:59 UTC
        const t659am = new Date("2026-10-25T13:59:00Z").getTime();
        assert.equal(groupsConfig.isInQuietHours(t659am, "group_default@g.us"), true);

        // 07:00 PDT = 14:00 UTC
        const t700am = new Date("2026-10-25T14:00:00Z").getTime();
        assert.equal(groupsConfig.isInQuietHours(t700am, "group_default@g.us"), false);

        // 12:00 PM PDT
        const t1200pm = new Date("2026-10-25T19:00:00Z").getTime();
        assert.equal(groupsConfig.isInQuietHours(t1200pm, "group_default@g.us"), false);
      });

      it("should check isQuietHoursWakeUpWindow for 7:00 AM end time", () => {
        // 06:59 PDT (before end)
        const t659am = new Date("2026-10-25T13:59:00Z").getTime();
        assert.equal(groupsConfig.isQuietHoursWakeUpWindow(t659am, "group_default@g.us"), false);

        // 07:00 PDT (exact end time -> wake up window starts)
        const t700am = new Date("2026-10-25T14:00:00Z").getTime();
        assert.equal(groupsConfig.isQuietHoursWakeUpWindow(t700am, "group_default@g.us"), true);

        // 07:45 PDT (within 60m window)
        const t745am = new Date("2026-10-25T14:45:00Z").getTime();
        assert.equal(groupsConfig.isQuietHoursWakeUpWindow(t745am, "group_default@g.us"), true);

        // 08:00 PDT (60m window ended)
        const t800am = new Date("2026-10-25T15:00:00Z").getTime();
        assert.equal(groupsConfig.isQuietHoursWakeUpWindow(t800am, "group_default@g.us"), false);
      });

      it("should evaluate custom quiet hours per group", () => {
        const origGetConfig = groupsConfig.getGroupConfig;
        try {
          groupsConfig.getGroupConfig = (jid) => {
            if (jid === "group_custom@g.us") {
              return { name: "Custom Group", quietHours: "23:00-06:00" };
            }
            if (jid === "group_off@g.us") {
              return { name: "No Quiet Group", quietHours: "off" };
            }
            return { name: "Default Group", quietHours: "22:00-07:00" };
          };

          // At 22:15 PDT:
          // Default group is in quiet hours (>= 22:00)
          // Custom group is NOT in quiet hours (< 23:00)
          // Off group is NOT in quiet hours
          const t1015pm = new Date("2026-10-25T05:15:00Z").getTime();
          assert.equal(groupsConfig.isInQuietHours(t1015pm, "group_default@g.us"), true);
          assert.equal(groupsConfig.isInQuietHours(t1015pm, "group_custom@g.us"), false);
          assert.equal(groupsConfig.isInQuietHours(t1015pm, "group_off@g.us"), false);

          // At 06:15 PDT:
          // Default group is in quiet hours (< 07:00)
          // Custom group is NOT in quiet hours (>= 06:00)
          const t615am = new Date("2026-10-25T13:15:00Z").getTime();
          assert.equal(groupsConfig.isInQuietHours(t615am, "group_default@g.us"), true);
          assert.equal(groupsConfig.isInQuietHours(t615am, "group_custom@g.us"), false);
          // Custom group wake-up window is 06:00 - 06:59
          assert.equal(groupsConfig.isQuietHoursWakeUpWindow(t615am, "group_custom@g.us"), true);
          assert.equal(groupsConfig.isQuietHoursWakeUpWindow(t615am, "group_default@g.us"), false);
        } finally {
          groupsConfig.getGroupConfig = origGetConfig;
        }
      });
    });

    describe("handleQuietHoursCommand", () => {
      const { getGroupMetadataCache } = require("../lib/commands/groupCommands");

      it("should display current quiet hours when called with no arguments in group chat", async () => {
        getGroupMetadataCache().clear();
        const mockSock = {
          user: { id: "bot@s.whatsapp.net" }
        };
        const res = await handleQuietHoursCommand(mockSock, "120363403838804497@g.us", "Alice", "alice@s.whatsapp.net", "!quiethours", {});
        assert.match(res, /Reminder quiet hours for \*Bot-testing\*:/i);
        assert.match(res, /10:00 PM – 7:00 AM/i);
        assert.match(res, /Match reminder notifications are paused during this window/i);
      });

      it("should reject non-admin attempt to update quiet hours", async () => {
        getGroupMetadataCache().clear();
        const mockSock = {
          user: { id: "bot@s.whatsapp.net" },
          groupMetadata: async () => ({
            participants: [{ id: "bob@s.whatsapp.net", admin: null }]
          })
        };
        const res = await handleQuietHoursCommand(mockSock, "120363403838804497@g.us", "Bob", "bob@s.whatsapp.net", "!quiethours 11pm-6am", {});
        assert.match(res, /⚠️ Only group admins or the bot superadmin can change reminder quiet hours/i);
      });

      it("should allow group admin to update quiet hours", async () => {
        getGroupMetadataCache().clear();
        const mockSock = {
          user: { id: "bot@s.whatsapp.net" },
          groupMetadata: async () => ({
            participants: [{ id: "admin@s.whatsapp.net", admin: "admin" }]
          })
        };
        const res = await handleQuietHoursCommand(mockSock, "120363403838804497@g.us", "Admin", "admin@s.whatsapp.net", "!quiethours 11pm-6am", {});
        assert.match(res, /✅ Reminder quiet hours for \*Bot-testing\* updated to \*11:00 PM – 6:00 AM\*/i);
        assert.match(res, /23:00-06:00/);

        // Verify updated in groupsConfig
        const qh = groupsConfig.getQuietHours("120363403838804497@g.us");
        assert.equal(qh.raw, "23:00-06:00");
        assert.equal(qh.display, "11:00 PM – 6:00 AM");

        // Restore back to default 22:00-07:00
        getGroupMetadataCache().clear();
        await handleQuietHoursCommand(mockSock, "120363403838804497@g.us", "Admin", "admin@s.whatsapp.net", "!quiethours 10pm-7am", {});
        const qhRestored = groupsConfig.getQuietHours("120363403838804497@g.us");
        assert.equal(qhRestored.raw, "22:00-07:00");
      });

      it("should allow disabling quiet hours with !quiethours off", async () => {
        getGroupMetadataCache().clear();
        const mockSock = {
          user: { id: "bot@s.whatsapp.net" },
          groupMetadata: async () => ({
            participants: [{ id: "admin@s.whatsapp.net", admin: "admin" }]
          })
        };
        const res = await handleQuietHoursCommand(mockSock, "120363403838804497@g.us", "Admin", "admin@s.whatsapp.net", "!quiethours off", {});
        assert.match(res, /have been \*disabled\*/i);
        assert.match(res, /sent at any hour/i);

        const qh = groupsConfig.getQuietHours("120363403838804497@g.us");
        assert.equal(qh.enabled, false);

        // Restore
        getGroupMetadataCache().clear();
        await handleQuietHoursCommand(mockSock, "120363403838804497@g.us", "Admin", "admin@s.whatsapp.net", "!quiethours 22:00-07:00", {});
      });

      it("should return helpful format error on invalid time range", async () => {
        getGroupMetadataCache().clear();
        const mockSock = {
          user: { id: "bot@s.whatsapp.net" },
          groupMetadata: async () => ({
            participants: [{ id: "admin@s.whatsapp.net", admin: "admin" }]
          })
        };
        const res = await handleQuietHoursCommand(mockSock, "120363403838804497@g.us", "Admin", "admin@s.whatsapp.net", "!quiethours invalid-time", {});
        assert.match(res, /⚠️ Invalid quiet hours format/i);
        assert.match(res, /!quiethours 10pm-7am/i);
      });
    });

    describe("checkAndSendPollReminders with per-group quiet hours", () => {
      it("should suppress reminder for group in quiet hours while sending for group outside quiet hours", async () => {
        const messagesSent = [];
        const mockSock = {
          user: { id: "bot@s.whatsapp.net" },
          sendMessage: async (jid, msg) => { messagesSent.push({ jid, msg }); }
        };

        const origGetConfig = groupsConfig.getGroupConfig;
        try {
          groupsConfig.getGroupConfig = (jid) => {
            if (jid === "group_custom@g.us") {
              return { name: "Custom Group", quietHours: "23:00-06:00" };
            }
            return { name: "Default Group", quietHours: "22:00-07:00" };
          };

          const playAt = new Date("2026-10-25T15:00:00Z").toISOString();
          const createdAt = new Date("2026-10-24T18:00:00Z").toISOString();

          const activePolls = new Map();
          // Poll in Default group (quiet hours 22:00 - 07:00)
          activePolls.set("poll_def", {
            name: "Tennis Default Group",
            status: "active",
            remoteJid: "group_default@g.us",
            when: "Sunday 8am",
            playAt,
            createdAt,
            options: ["Player 1", "Player 2"],
            size: 2,
            type: "fixed",
            sentReminders: [],
            voteBuffer: new Map()
          });

          // Poll in Custom group (quiet hours 23:00 - 06:00)
          activePolls.set("poll_cust", {
            name: "Tennis Custom Group",
            status: "active",
            remoteJid: "group_custom@g.us",
            when: "Sunday 8am",
            playAt,
            createdAt,
            options: ["Player 1", "Player 2"],
            size: 2,
            type: "fixed",
            sentReminders: [],
            voteBuffer: new Map()
          });

          const messageStore = new Map([
            ["group_default@g.us:poll_def", { pollCreationMessage: { name: "Poll Def", options: [{ optionName: "Player 1" }] } }],
            ["group_custom@g.us:poll_cust", { pollCreationMessage: { name: "Poll Cust", options: [{ optionName: "Player 1" }] } }]
          ]);

          // Time: 10:15 PM PDT (05:15Z on Oct 25)
          // Default group is in quiet hours (>= 22:00) -> suppressed!
          // Custom group is NOT in quiet hours (< 23:00) -> sent!
          const time1015pm = new Date("2026-10-25T05:15:00Z").getTime();

          await checkAndSendPollReminders(mockSock, {
            activePolls,
            persistPolls: () => {},
            messageStore
          }, time1015pm);

          assert.equal(messagesSent.length, 1);
          assert.equal(messagesSent[0].jid, "group_custom@g.us");
          assert.ok(activePolls.get("poll_cust").sentReminders.includes(16));
          assert.equal(activePolls.get("poll_def").sentReminders.length, 0);
        } finally {
          groupsConfig.getGroupConfig = origGetConfig;
        }
      });
    });
  });

  describe('court preference override for match polls', () => {
    it('normalizeCourtPreference parses array, string, and bracket formats', () => {
      assert.deepEqual(normalizeCourtPreference([2, 3, 1]), ['2', '3', '1']);
      assert.deepEqual(normalizeCourtPreference('2, 3, 1'), ['2', '3', '1']);
      assert.deepEqual(normalizeCourtPreference('[2, 3, 1]'), ['2', '3', '1']);
      assert.deepEqual(normalizeCourtPreference('Court 2, Court 3, Court 1'), ['Court', '2', 'Court', '3', 'Court', '1']);
      assert.deepEqual(normalizeCourtPreference(null), []);
    });

    it('sortCourtsByPreference correctly orders court strings and court objects', () => {
      const courts = ['Court 1', 'Court 3', 'Court 2', 'Court 4'];
      const pref = [2, 3, 1];
      const sorted = sortCourtsByPreference(courts, pref);
      assert.deepEqual(sorted, ['Court 2', 'Court 3', 'Court 1', 'Court 4']);

      const courtObjs = [
        { court: 'Court 1', time: '7pm' },
        { court: 'Court 3', time: '7pm' },
        { court: 'Court 2', time: '7pm' }
      ];
      const sortedObjs = sortCourtsByPreference(courtObjs, ['3', '1', '2']);
      assert.deepEqual(sortedObjs.map(c => c.court), ['Court 3', 'Court 1', 'Court 2']);
    });

    it('parsePollCreationText parses --court-preference and --booking-court-preference', () => {
      const p1 = parsePollCreationText('!poll 8 tomorrow 7pm --court-preference="2, 3, 1"');
      assert.ok(p1);
      assert.deepEqual(p1.bookingCourtPreference, ['2', '3', '1']);

      const p2 = parsePollCreationText('!poll 8 tomorrow 7pm --booking-court-preference="3, 1"' );
      assert.ok(p2);
      assert.deepEqual(p2.bookingCourtPreference, ['3', '1']);
    });

    it('preBookCourtsForMatch forwards poll courtPreference to scvcc.bookCourt and overrides group default', async () => {
      const origBook = scvcc.bookCourt;
      let capturedBookArgs = null;
      scvcc.bookCourt = async (args) => {
        capturedBookArgs = args;
        return {
          success: true,
          court: 'Court 3',
          players: args.players,
          date: args.date,
          time: args.time
        };
      };

      try {
        const res = await preBookCourtsForMatch({
          sock: null,
          remoteJid: 'group_pref@g.us',
          targetDateMDY: '11/20/2026',
          queryTime: '7:00 PM',
          size: 4,
          isAuto: false,
          preBookCourts: 1,
          courtPreference: ['3', '1', '2'],
          bookingPlayers: [['Player A', 'Player B', 'Player C', 'Player D']]
        });

        assert.ok(capturedBookArgs, 'scvcc.bookCourt should have been called');
        assert.deepEqual(capturedBookArgs.courtPreference, ['3', '1', '2'], 'Should forward poll courtPreference to scvcc.bookCourt');
        assert.equal(res.prebookedCourts.length, 1);
        assert.equal(res.prebookedCourts[0].court, 'Court 3');
      } finally {
        scvcc.bookCourt = origBook;
      }
    });

    it('createMatchPoll selects candidate courts in order of poll courtPreference override', async () => {
      const origCheck = scvcc.checkCourtAvailability;
      const origBookings = scvcc.getCourtBookings;
      const origGetConfig = groupsConfig.getGroupConfig;

      try {
        // Group default preference is [1, 2, 3]
        groupsConfig.getGroupConfig = () => ({
          name: 'Test Group',
          sport: 'tennis',
          courtBookingEnabled: true,
          bookingCourtPreference: [1, 2, 3]
        });

        // Courts 1, 2, 3 are all available
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

        let sentPoll = null;
        const mockSock = {
          sendMessage: async (jid, content) => {
            if (content.poll) sentPoll = content.poll;
            return { key: { id: 'poll_pref_test', remoteJid: jid }, message: content };
          }
        };

        const activePolls = new Map();
        const context = { activePolls, recurringPolls: new Map(), messageStore: new Map(), latestPollIdByChat: new Map(), persistPolls: () => {} };

        // Poll overrides court preference to [3, 2, 1] with maxCourts: 1
        const res = await createMatchPoll(
          mockSock,
          'group_pref_override@g.us',
          'auto',
          'Tomorrow 7pm',
          null,
          null,
          'Alice',
          'alice@s.whatsapp.net',
          false,
          null,
          false,
          false,
          false,
          true, // checkCourts
          false,
          false,
          null,
          null,
          'none',
          null,
          null,
          null,
          null,
          context,
          {
            maxCourts: 1,
            bookingCourtPreference: ['3', '2', '1']
          }
        );

        assert.ok(res, 'Poll should be created');
        assert.deepEqual(res.bookingCourtPreference, ['3', '2', '1'], 'res should include poll courtPreference');
        const pollState = activePolls.get(res.pollId);
        assert.ok(pollState);
        assert.deepEqual(pollState.bookingCourtPreference, ['3', '2', '1'], 'pollState should store poll courtPreference');
        // Because maxCourts is 1 and preference is [3, 2, 1], Court 3 should be selected as the unbooked court!
        assert.equal(pollState.unbookedCourts.length, 1);
        assert.equal(pollState.unbookedCourts[0].court, 'Court 3', 'Court 3 should be chosen based on preference override');
      } finally {
        scvcc.checkCourtAvailability = origCheck;
        scvcc.getCourtBookings = origBookings;
        groupsConfig.getGroupConfig = origGetConfig;
      }
    });

    it('handleDirectPollCreation forwards --booking-court-preference to createMatchPoll overriding group default', async () => {
      const origCheck = scvcc.checkCourtAvailability;
      const origBookings = scvcc.getCourtBookings;
      const origGetConfig = groupsConfig.getGroupConfig;

      try {
        groupsConfig.getGroupConfig = () => ({
          courtBookingEnabled: true,
          bookingCourtPreference: ['2', '3', '1', '5']
        });

        scvcc.checkCourtAvailability = async () => ({
          slots: [{
            time: '7:00 PM',
            courts: [
              { court: 'Court 1', status: 'available', availableMinutes: 90 },
              { court: 'Court 2', status: 'available', availableMinutes: 90 },
              { court: 'Court 3', status: 'available', availableMinutes: 90 },
              { court: 'Court 5', status: 'available', availableMinutes: 90 },
              { court: 'Court 6', status: 'available', availableMinutes: 90 }
            ]
          }]
        });
        scvcc.getCourtBookings = async () => ({ bookings: [] });

        const activePolls = new Map();
        const context = { activePolls, messageStore: new Map(), persistPolls: () => {}, latestPollIdByChat: new Map() };

        let sentPollTitle = '';
        const mockSock = {
          sendMessage: async (chatId, content) => {
            if (content?.poll?.name) sentPollTitle = content.poll.name;
            return { key: { id: 'poll_pref_test' } };
          }
        };

        const parsed = parsePollCreationText('!poll auto tomorrow 7pm --courts-strategy=lookup --booking-court-preference="5,6,1,3"');
        await handleDirectPollCreation(
          mockSock,
          '120363403838804497@g.us',
          'Alice',
          null,
          parsed,
          { isCommand: true },
          context
        );

        const pollState = activePolls.get('poll_pref_test');
        assert.ok(pollState, 'Poll should be tracked');
        assert.deepEqual(pollState.bookingCourtPreference, ['5', '6', '1', '3']);
        assert.match(sentPollTitle, /Court 5 - Available/);
        assert.match(sentPollTitle, /Court 6 - Available/);
        assert.match(sentPollTitle, /Court 1 - Available/);
      } finally {
        scvcc.checkCourtAvailability = origCheck;
        scvcc.getCourtBookings = origBookings;
        groupsConfig.getGroupConfig = origGetConfig;
      }
    });

    it('handleOnDemandCourtBooking sorts unbooked courts by poll bookingCourtPreference before booking', async () => {
      const origBook = scvcc.bookCourt;
      let attemptedCourt = null;
      let passedPreference = null;

      scvcc.bookCourt = async (args) => {
        attemptedCourt = args.court;
        passedPreference = args.courtPreference;
        return {
          success: true,
          court: args.court,
          players: args.players,
          date: args.date,
          time: args.time
        };
      };

      try {
        const mockSock = {
          sendMessage: async () => ({ key: { id: 'msg_1' } })
        };
        const pollState = {
          remoteJid: 'group_ondemand_pref@g.us',
          name: 'Match Poll',
          when: 'tomorrow 7pm',
          targetDateMDY: '11/20/2026',
          queryTime: '7:00 PM',
          courtBookingType: 'doubles',
          size: 8,
          slotLimit: 8,
          bookingCourtPreference: ['2', '1'],
          unbookedCourts: [
            { court: 'Court 1', time: '7:00 PM' },
            { court: 'Court 2', time: '7:00 PM' }
          ],
          prebookedCourts: [],
          advanceBookedCourts: [],
          onDemandBookingInProgress: false,
          _bookingActive: false,
          creator: { name: 'Alice', jid: 'alice@s.whatsapp.net' }
        };

        const aggregated = [
          { name: 'Player 1', voters: ['p1@s.whatsapp.net'] },
          { name: 'Player 2', voters: ['p2@s.whatsapp.net'] },
          { name: 'Player 3', voters: ['p3@s.whatsapp.net'] },
          { name: 'Player 4', voters: ['p4@s.whatsapp.net'] },
          { name: 'Player 5', voters: ['p5@s.whatsapp.net'] },
          { name: 'Player 6', voters: ['p6@s.whatsapp.net'] }
        ];

        await handleOnDemandCourtBooking(mockSock, 'poll_pref_ondemand', pollState, aggregated, {});

        assert.equal(attemptedCourt, 'Court 2', 'Should attempt preferred Court 2 before Court 1');
        assert.deepEqual(passedPreference, ['2', '1']);
      } finally {
        scvcc.bookCourt = origBook;
      }
    });
  });

});

  describe('multi-poll support for > 12 player slots', () => {
    it('partitionMatchSlots correctly partitions doubles and singles into whole-court batches <= 12', () => {
      // Doubles (4 spots/court)
      assert.deepEqual(partitionMatchSlots(4, 4), [4]);
      assert.deepEqual(partitionMatchSlots(8, 4), [8]);
      assert.deepEqual(partitionMatchSlots(12, 4), [12]);
      assert.deepEqual(partitionMatchSlots(16, 4), [12, 4]);
      assert.deepEqual(partitionMatchSlots(20, 4), [12, 8]);
      assert.deepEqual(partitionMatchSlots(24, 4), [12, 12]);
      assert.deepEqual(partitionMatchSlots(28, 4), [12, 12, 4]);
      assert.deepEqual(partitionMatchSlots(32, 4), [12, 12, 8]);
      assert.deepEqual(partitionMatchSlots(36, 4), [12, 12, 12]);

      // Singles (2 spots/court)
      assert.deepEqual(partitionMatchSlots(4, 2), [4]);
      assert.deepEqual(partitionMatchSlots(8, 2), [8]);
      assert.deepEqual(partitionMatchSlots(12, 2), [12]);
      assert.deepEqual(partitionMatchSlots(16, 2), [12, 4]);
      assert.deepEqual(partitionMatchSlots(20, 2), [12, 8]);
      assert.deepEqual(partitionMatchSlots(24, 2), [12, 12]);
      assert.deepEqual(partitionMatchSlots(28, 2), [12, 12, 4]);
    });

    it('creates 2 linked polls upfront for 24 spots (6 courts: 12 + 12)', async () => {
      let sentPolls = [];
      const mockSock = {
        user: { id: 'tenbot@s.whatsapp.net' },
        sendMessage: async (jid, payload) => {
          sentPolls.push(payload);
          return { key: { id: `poll_24_${sentPolls.length}`, remoteJid: jid } };
        }
      };

      const activePolls = new Map();
      const messageStore = new Map();
      const context = {
        activePolls,
        messageStore,
        latestPollIdByChat: new Map(),
        persistPolls: () => {}
      };

      const res = await createMatchPoll(
        mockSock,
        'group24@g.us',
        24,
        'tomorrow 9am',
        'tomorrow',
        '9am',
        'Organizer',
        'org@s.whatsapp.net',
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
        context
      );

      assert.ok(res);
      assert.equal(res.isMultiPoll, true);
      assert.equal(res.totalParts, 2);
      assert.deepEqual(res.batches, [12, 12]);
      assert.equal(sentPolls.length, 2);
      assert.equal(sentPolls[0].poll.values.length, 12);
      assert.equal(sentPolls[1].poll.values.length, 12);
      assert.match(sentPolls[0].poll.name, /Part 1\/2: Spots 1–12/);
      assert.match(sentPolls[1].poll.name, /Part 2\/2: Spots 13–24/);
    });

    it('handles demand-driven spillover: 28 spots creates 2 upfront, opens Part 3 when filled, and auto-generates combined matchups', async () => {
      let sentMessages = [];
      const mockSock = {
        user: { id: 'tenbot@s.whatsapp.net' },
        sendMessage: async (jid, payload) => {
          sentMessages.push(payload);
          return {
            key: { id: payload.poll ? `poll_part_${sentMessages.length}` : `msg_${sentMessages.length}`, remoteJid: jid },
            message: payload.poll ? { pollCreationMessage: { name: payload.poll.name, options: payload.poll.values.map((v) => ({ optionName: v })) } } : {}
          };
        }
      };

      const activePolls = new Map();
      const messageStore = new Map();
      const context = {
        activePolls,
        messageStore,
        latestPollIdByChat: new Map(),
        persistPolls: () => {}
      };

      // 28 spots = [12, 12, 4]. Default maxInitialPolls is 2, so Part 1 and Part 2 are created upfront.
      const res = await createMatchPoll(
        mockSock,
        'group28@g.us',
        28,
        'tomorrow 8am',
        'tomorrow',
        '8am',
        'Organizer',
        'org@s.whatsapp.net',
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
        context
      );

      assert.equal(res.totalParts, 3);
      assert.deepEqual(res.batches, [12, 12, 4]);
      // Initially, exactly 2 polls are created upfront
      const initialPolls = sentMessages.filter((m) => m.poll);
      assert.equal(initialPolls.length, 2);
      assert.equal(initialPolls[0].poll.values.length, 12);
      assert.equal(initialPolls[1].poll.values.length, 12);

      const poll1Id = res.pollIds[0];
      const poll2Id = res.pollIds[1];
      const p1 = activePolls.get(poll1Id);
      const p2 = activePolls.get(poll2Id);
      assert.ok(p1 && p2);
      assert.equal(p1.parentPollId, p2.parentPollId);

      const crypto = require('crypto');
      const makeOptHash = (n) => crypto.createHash('sha256').update(n).digest();

      // Simulate duplicate vote across Part 1 and Part 2
      const voter1 = '14085550001@s.whatsapp.net';
      p1.voteBuffer.set(voter1, { pollUpdateMessageKey: { participant: voter1 }, vote: { selectedOptions: [makeOptHash('Player 1')] } });
      const dupUpdates = [{ pollUpdateMessageKey: { participant: voter1 }, vote: { selectedOptions: [makeOptHash('Player 13')] } }];
      messageStore.set(`group28@g.us:${poll2Id}`, { pollCreationMessage: { name: p2.name, options: p2.options.map((o) => ({ optionName: o })) } });
      await processPollVoteEvent(mockSock, { id: poll2Id, remoteJid: 'group28@g.us' }, dupUpdates, context);

      const dupWarning = sentMessages.find((m) => m.text && m.text.includes('Duplicate Vote Notice'));
      assert.ok(dupWarning, 'Should have notified about duplicate vote');
      assert.match(dupWarning.text, /voted in both Part 1 and Part 2/);

      // Fill Part 1 (12 voters)
      p1.voteBuffer.clear();
      for (let i = 1; i <= 12; i++) {
        const jid = `140855500${String(i).padStart(2, '0')}@s.whatsapp.net`;
        p1.voteBuffer.set(jid, { pollUpdateMessageKey: { participant: jid }, vote: { selectedOptions: [makeOptHash(`Player ${i}`)] } });
      }
      p1.status = 'filled';
      p1.lastPlayers = Array.from({ length: 12 }, (_, i) => `Player ${i + 1}`);

      // Fill Part 2 (12 voters)
      p2.voteBuffer.clear();
      for (let i = 13; i <= 24; i++) {
        const jid = `140855500${String(i).padStart(2, '0')}@s.whatsapp.net`;
        p2.voteBuffer.set(jid, { pollUpdateMessageKey: { participant: jid }, vote: { selectedOptions: [makeOptHash(`Player ${i}`)] } });
      }

      // Trigger vote event on Part 2 with 12th voter -> fills Part 2 and triggers spillover!
      messageStore.set(`group28@g.us:${poll2Id}`, { pollCreationMessage: { name: p2.name, options: p2.options.map((o) => ({ optionName: o })) } });
      await processPollVoteEvent(mockSock, { id: poll2Id, remoteJid: 'group28@g.us' }, [], context);

      // Verify spillover poll (Part 3) was created!
      const pollsNow = sentMessages.filter((m) => m.poll);
      assert.equal(pollsNow.length, 3, 'Spillover should have created Part 3 poll');
      assert.match(pollsNow[2].poll.name, /Part 3\/3: Spots 25–28/);
      assert.deepEqual(pollsNow[2].poll.values, ['Player 25', 'Player 26', 'Player 27', 'Player 28']);

      const spilloverAnnouncement = sentMessages.find((m) => m.text && m.text.includes('All spots across Part 1 & Part 2 are filled'));
      assert.ok(spilloverAnnouncement, 'Should announce spillover opening');

      // Now fill Part 3
      const poll3Id = [...activePolls.keys()].find((id) => id !== poll1Id && id !== poll2Id);
      const p3 = activePolls.get(poll3Id);
      assert.ok(p3);
      for (let i = 25; i <= 28; i++) {
        const jid = `140855500${String(i).padStart(2, '0')}@s.whatsapp.net`;
        p3.voteBuffer.set(jid, { pollUpdateMessageKey: { participant: jid }, vote: { selectedOptions: [makeOptHash(`Player ${i}`)] } });
      }

      // Process vote event on Part 3 -> triggers combined matchups across all 7 courts!
      messageStore.set(`group28@g.us:${poll3Id}`, { pollCreationMessage: { name: p3.name, options: p3.options.map((o) => ({ optionName: o })) } });
      await processPollVoteEvent(mockSock, { id: poll3Id, remoteJid: 'group28@g.us' }, [], context);

      // Verify all 3 polls are marked resolved
      assert.equal(p1.status, 'resolved');
      assert.equal(p2.status, 'resolved');
      assert.equal(p3.status, 'resolved');

      // Verify combined matchups message was sent
      const matchupsMsg = sentMessages.find((m) => m.text && (m.text.includes('Court 1') || m.text.includes('vs')));
      assert.ok(matchupsMsg, 'Combined matchups should have been posted');
    });

    it('cancelling one poll in a multi-poll session deletes all sibling polls', async () => {
      let deletedIds = [];
      const mockSock = {
        user: { id: 'tenbot@s.whatsapp.net' },
        sendMessage: async (jid, payload) => {
          if (payload.delete) {
            deletedIds.push(payload.delete.id);
          }
          return { key: { id: payload.poll ? `poll_del_${deletedIds.length}` : 'msg_del', remoteJid: jid } };
        }
      };

      const activePolls = new Map();
      const messageStore = new Map();
      const context = {
        activePolls,
        messageStore,
        latestPollIdByChat: new Map(),
        persistPolls: () => {}
      };

      const res = await createMatchPoll(
        mockSock,
        'group_cancel@g.us',
        16,
        'Friday 6pm',
        'Friday',
        '6pm',
        'Creator',
        'creator@s.whatsapp.net',
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
        context
      );

      const [p1Id, p2Id] = res.pollIds;
      assert.equal(activePolls.has(p1Id), true);
      assert.equal(activePolls.has(p2Id), true);

      // Cancel Part 1
      await cancelOrDeletePoll(mockSock, 'group_cancel@g.us', p1Id, context);

      // Both Part 1 and Part 2 should be deleted from activePolls and deleted from WhatsApp
      assert.equal(activePolls.has(p1Id), false);
      assert.equal(activePolls.has(p2Id), false);
      assert.ok(deletedIds.includes(p1Id), 'Part 1 should be deleted from WhatsApp');
      assert.ok(deletedIds.includes(p2Id), 'Part 2 should be deleted from WhatsApp');
    });
  
  describe('scheduled regular poll creation with at <postTime>', () => {
    it('should parse postTime for regular poll with at <postTime>', () => {
      const res1 = parsePollCreationText('!poll 4 tomorrow 7pm at 8am');
      assert.ok(res1);
      assert.equal(res1.size, 4);
      assert.equal(res1.dayWord, 'tomorrow');
      assert.equal(res1.timeWord, '7pm');
      assert.equal(res1.when, 'Tomorrow 7pm');
      assert.equal(res1.postTime, '8am');
      assert.equal(res1.at, '8am');

      const res2 = parsePollCreationText('!poll 4 tomorrow at 7pm at 8am');
      assert.ok(res2);
      assert.equal(res2.size, 4);
      assert.equal(res2.timeWord, '7pm');
      assert.equal(res2.postTime, '8am');

      const res3 = parsePollCreationText('!poll 4 tomorrow 7pm at 1 day before at 6pm');
      assert.ok(res3);
      assert.equal(res3.size, 4);
      assert.equal(res3.timeWord, '7pm');
      assert.equal(res3.postTime, '1 day before at 6pm');

      const res4 = parsePollCreationText('!poll auto Saturday 9am at Friday 6pm');
      assert.ok(res4);
      assert.equal(res4.size, 'auto');
      assert.equal(res4.dayWord.toLowerCase(), 'saturday');
      assert.equal(res4.timeWord, '9am');
      assert.equal(res4.postTime, 'Friday 6pm');

      const res5 = parsePollCreationText('!poll 4 tomorrow 7pm at 2h before');
      assert.ok(res5);
      assert.equal(res5.size, 4);
      assert.equal(res5.timeWord, '7pm');
      assert.equal(res5.postTime, '2h before');

      const res6 = parsePollCreationText('!poll 4 tomorrow 7pm --at="8am"');
      assert.ok(res6);
      assert.equal(res6.size, 4);
      assert.equal(res6.timeWord, '7pm');
      assert.equal(res6.postTime, '8am');

      const res7 = parsePollCreationText('!poll 4 tomorrow 7pm --post-time=8am');
      assert.ok(res7);
      assert.equal(res7.size, 4);
      assert.equal(res7.timeWord, '7pm');
      assert.equal(res7.postTime, '8am');

      const res8 = parsePollCreationText('!poll 4 tomorrow 7pm post at 8am');
      assert.ok(res8);
      assert.equal(res8.size, 4);
      assert.equal(res8.timeWord, '7pm');
      assert.equal(res8.postTime, '8am');

      const res9 = parsePollCreationText('!poll Saturday 8am, 9:30am, 4pm at Friday 6pm');
      assert.ok(res9);
      assert.equal(res9.timeSlots.length, 3);
      assert.equal(res9.postTime, 'Friday 6pm');
      assert.equal(res9.dayWord.toLowerCase(), 'saturday');
    });

    it('should NOT treat single time with at as postTime', () => {
      const res1 = parsePollCreationText('!poll 4 tomorrow at 7pm');
      assert.ok(res1);
      assert.equal(res1.size, 4);
      assert.equal(res1.timeWord, '7pm');
      assert.equal(res1.postTime, null);

      const res2 = parsePollCreationText('!poll 4 at 7pm');
      assert.ok(res2);
      assert.equal(res2.size, 4);
      assert.equal(res2.timeWord, '7pm');
      assert.equal(res2.postTime, null);
    });

    it('should correctly determine isPostTimeInFuture', () => {
      // Mock San Jose now: Friday 2026-11-20 12:00 PM
      const mockNowParts = {
        year: 2026,
        month: 10, // Nov
        day: 20,
        weekday: 'fri',
        hour: 12,
        minute: 0
      };

      // Match tomorrow (Saturday) 7pm, post at 8am -> Saturday 8am is future
      const futureCheck1 = isPostTimeInFuture('8am', 'tomorrow', '7pm', mockNowParts);
      assert.equal(futureCheck1.isFuture, true);
      assert.equal(futureCheck1.targetMatchDateKey, '2026-11-21');
      assert.equal(futureCheck1.targetMatchDayIndex, 6);

      // Match tomorrow (Saturday) 7pm, post at Friday 6pm (later today) -> future
      const futureCheck2 = isPostTimeInFuture('Friday 6pm', 'tomorrow', '7pm', mockNowParts);
      assert.equal(futureCheck2.isFuture, true);

      // Match today (Friday) 7pm, post at 8am (earlier today) -> past
      const pastCheck1 = isPostTimeInFuture('8am', 'today', '7pm', mockNowParts);
      assert.equal(pastCheck1.isFuture, false);

      // Match today (Friday) 7pm, post at 5pm (later today) -> future
      const futureCheck3 = isPostTimeInFuture('5pm', 'today', '7pm', mockNowParts);
      assert.equal(futureCheck3.isFuture, true);
    });

    it('should schedule future regular poll in recurringPolls with oneTime: true', async () => {
      // Mock San Jose now: Friday 12:00 PM
      const mockNowParts = {
        year: 2026,
        month: 10,
        day: 20,
        weekday: 'fri',
        hour: 12,
        minute: 0
      };

      const recurringPolls = new Map();
      let persisted = false;
      const context = {
        recurringPolls,
        persistPolls: () => { persisted = true; },
        customSanJoseParts: mockNowParts
      };

      const mockSock = {
        sendMessage: async () => ({})
      };

      const parsed = parsePollCreationText('!poll 4 tomorrow 7pm at 8am');
      assert.ok(parsed);
      assert.equal(parsed.postTime, '8am');

      const res = await handleDirectPollCreation(
        mockSock,
        '120363403838804497@g.us',
        'Alice',
        null,
        parsed,
        {},
        context
      );

      assert.match(res, /Scheduled Match Poll/);
      assert.match(res, /4 spots \(Doubles\)/);
      assert.equal(recurringPolls.size, 1);

      const [scheduleId, sched] = [...recurringPolls.entries()][0];
      assert.equal(sched.oneTime, true);
      assert.equal(sched.size, 4);
      assert.equal(sched.postTime, '8am');
      assert.equal(sched.enabled, true);
      assert.equal(sched.completed, undefined);
      assert.equal(persisted, true);

      // Verify formatRecurringScheduleCard displays Scheduled Match Poll and Match Date
      const card = recurringPollsModule.formatRecurringScheduleCard(sched, 0, 1, mockNowParts);
      assert.match(card, /Scheduled Match Poll/);
      assert.match(card, /Match Date:/);
      assert.match(card, /Scheduled to post/);
    });

    it('should auto-retire oneTime schedule after posting in checkAndPostRecurringPolls', async () => {
      const recurringPolls = new Map();
      let persisted = false;
      let matchPollCreated = false;

      const scheduleId = 'rec_test_onetime';
      const sched = {
        id: scheduleId,
        remoteJid: '120363403838804497@g.us',
        size: 4,
        matchTime: '7pm',
        matchHour: 19,
        matchMinute: 0,
        postTime: '8am',
        postHour: 8,
        postMinute: 0,
        postTimesByDay: {
          6: { hour: 8, minute: 0, postHour: 8, postMinute: 0, daysBefore: 0, postDayIndex: 6 }
        },
        days: 'Saturday',
        daysList: [6],
        daysDisplay: 'Saturday',
        oneTime: true,
        startDate: '2026-11-21',
        endDate: '2026-11-21',
        enabled: true,
        postedMatchDates: [],
        creator: { name: 'Alice', jid: 'alice@s.whatsapp.net' }
      };
      recurringPolls.set(scheduleId, sched);

      const mockSock = {
        sendMessage: async () => ({})
      };

      // Mock San Jose time at posting time: Saturday 2026-11-21 8:05 AM
      const postSweepParts = {
        year: 2026,
        month: 10,
        day: 21,
        weekday: 'sat',
        hour: 8,
        minute: 5
      };

      await recurringPollsModule.checkAndPostRecurringPolls({
        sock: mockSock,
        recurringPolls,
        persistPolls: () => { persisted = true; },
        createMatchPoll: async () => {
          matchPollCreated = true;
          return { pollId: 'poll_onetime_posted' };
        },
        getTargetGroupJid: async () => '120363403838804497@g.us',
        customSanJoseParts: postSweepParts
      });

      assert.equal(matchPollCreated, true, 'createMatchPoll should have been called');
      assert.equal(sched.enabled, false, 'oneTime schedule should be disabled after posting');
      assert.equal(sched.completed, true, 'oneTime schedule should be marked completed');
      assert.equal(sched.postedMatchDates.includes('2026-11-21'), true);

      // Verify status string shows Completed
      const completedCard = recurringPollsModule.formatRecurringScheduleCard(sched, 0, 1, postSweepParts);
      assert.match(completedCard, /🏁 Completed/);
    });
  });
  describe("Numerical poll size scaling down when courts are insufficient (Option B)", () => {
    let origCheck;
    let origBookings;
    let origGetConfig;

    beforeEach(() => {
      origCheck = scvcc.checkCourtAvailability;
      origBookings = scvcc.getCourtBookings;
      origGetConfig = groupsConfig.getGroupConfig;
      groupsConfig.getGroupConfig = () => ({
        sport: "tennis",
        courtBookingEnabled: true,
        tentativeBookingTitles: ["Clinic", "Club Event"]
      });
    });

    afterEach(() => {
      scvcc.checkCourtAvailability = origCheck;
      scvcc.getCourtBookings = origBookings;
      groupsConfig.getGroupConfig = origGetConfig;
    });

    it("should scale down from size 8 to 4 when only 1 court is found with checkCourts=true", async () => {
      scvcc.checkCourtAvailability = async () => ({
        slots: [{ courts: [] }]
      });
      scvcc.getCourtBookings = async () => ({
        bookings: [
          { court: "Court 2", blockTitle: "Pramod Immaneni", players: ["Pramod Immaneni"], durationMins: 90 }
        ]
      });

      let sentPoll = null;
      const mockSock = {
        sendMessage: async (jid, content) => {
          if (content.poll) sentPoll = content.poll;
          return { key: { id: "poll_scale_down_1", remoteJid: jid }, message: content };
        }
      };
      const activePolls = new Map();
      const context = { activePolls, persistPolls: () => {} };

      const res = await createMatchPoll(
        mockSock,
        "group1@g.us",
        8,
        "Tomorrow 7pm",
        null,
        "7pm",
        "Alice",
        "alice@s.whatsapp.net",
        false, // includeCreator
        null,
        false,
        false,
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
        null,
        context
      );

      assert.ok(sentPoll, "Poll should be sent");
      assert.equal(res.size, 4, "Poll size should scale down from 8 to 4");
      assert.equal(sentPoll.values.length, 4, "Values should have 4 slots");
      assert.deepEqual(sentPoll.values, ["Player 1", "Player 2", "Player 3", "Player 4"]);
      assert.match(sentPoll.name, /Court 2 - Booked/);
      assert.match(sentPoll.name, /4 slots \/ 4/);
    });

    it("should keep size 8 when 2 courts (1 booked, 1 available) are found", async () => {
      scvcc.checkCourtAvailability = async () => ({
        slots: [{
          courts: [
            { court: "Court 1", status: "available", availableMinutes: 90 }
          ]
        }]
      });
      scvcc.getCourtBookings = async () => ({
        bookings: [
          { court: "Court 2", blockTitle: "Pramod Immaneni", players: ["Pramod Immaneni"], durationMins: 90 }
        ]
      });

      let sentPoll = null;
      const mockSock = {
        sendMessage: async (jid, content) => {
          if (content.poll) sentPoll = content.poll;
          return { key: { id: "poll_keep_8", remoteJid: jid }, message: content };
        }
      };
      const activePolls = new Map();
      const context = { activePolls, persistPolls: () => {} };

      const res = await createMatchPoll(
        mockSock,
        "group1@g.us",
        8,
        "Tomorrow 7pm",
        null,
        "7pm",
        "Alice",
        "alice@s.whatsapp.net",
        false,
        null,
        false,
        false,
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
        null,
        context
      );

      assert.ok(sentPoll, "Poll should be sent");
      assert.equal(res.size, 8, "Poll size should remain 8");
      assert.equal(sentPoll.values.length, 8, "Values should have 8 slots");
      // Slots 5-8 should be tentative because Court 1 is available (unbooked)
      assert.equal(sentPoll.values[0], "Player 1");
      assert.match(sentPoll.values[4], /Player 5/);
      assert.match(sentPoll.values[4], /[✱*]/);
    });

    it("should scale down from size 12 to 8 when 2 courts (1 booked, 1 tentative) are found", async () => {
      scvcc.checkCourtAvailability = async () => ({
        slots: [{ courts: [] }]
      });
      scvcc.getCourtBookings = async () => ({
        bookings: [
          { court: "Court 2", blockTitle: "Pramod Immaneni", players: ["Pramod Immaneni"], durationMins: 90 },
          { court: "Court 3", blockTitle: "Tennis Clinic", type: "Clinic", durationMins: 90 }
        ]
      });

      let sentPoll = null;
      const mockSock = {
        sendMessage: async (jid, content) => {
          if (content.poll) sentPoll = content.poll;
          return { key: { id: "poll_scale_down_12_to_8", remoteJid: jid }, message: content };
        }
      };
      const activePolls = new Map();
      const context = { activePolls, persistPolls: () => {} };

      const res = await createMatchPoll(
        mockSock,
        "group1@g.us",
        12,
        "Tomorrow 7pm",
        null,
        "7pm",
        "Alice",
        "alice@s.whatsapp.net",
        false,
        null,
        false,
        false,
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
        null,
        context
      );

      assert.ok(sentPoll, "Poll should be sent");
      assert.equal(res.size, 8, "Poll size should scale down from 12 to 8");
      assert.equal(sentPoll.values.length, 8, "Values should have 8 slots");
    });

    it("should NOT scale down when checkCourts is false", async () => {
      let sentPoll = null;
      const mockSock = {
        sendMessage: async (jid, content) => {
          if (content.poll) sentPoll = content.poll;
          return { key: { id: "poll_no_check_courts", remoteJid: jid }, message: content };
        }
      };
      const activePolls = new Map();
      const context = { activePolls, persistPolls: () => {} };

      const res = await createMatchPoll(
        mockSock,
        "group1@g.us",
        8,
        "Tomorrow 7pm",
        null,
        "7pm",
        "Alice",
        "alice@s.whatsapp.net",
        false,
        null,
        false,
        false,
        false,
        false, // checkCourts = false
        false,
        false,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        context
      );

      assert.ok(sentPoll, "Poll should be sent");
      assert.equal(res.size, 8, "Poll size should remain 8 when checkCourts=false");
      assert.equal(sentPoll.values.length, 8, "Values should have 8 slots");
    });
    it("should default pre-booked courts to size court count (e.g. size 12 -> 3 courts) instead of group default preBookCourts: 1", async () => {
      groupsConfig.getGroupConfig = () => ({
        sport: "tennis",
        courtBookingEnabled: true,
        preBookCourts: 1,
        directCourtBookingAccounts: ["Pramod Immaneni", "Conrad Rodricks", "Kejal Patel"],
        defaultBookingPlayers: ["Alice", "Bob", "Charlie", "Dave", "Eve", "Frank"]
      });

      let bookedAttempts = [];
      const origBookCourt = scvcc.bookCourt;
      const origCheckAvail = scvcc.checkCourtAvailability;
      const origGetBookings = scvcc.getCourtBookings;

      try {
        scvcc.checkCourtAvailability = async () => ({
          slots: [{
            time: "7:00 PM",
            courts: [
              { court: "Court 2", status: "available", availableMinutes: 90 },
              { court: "Court 3", status: "available", availableMinutes: 90 },
              { court: "Court 1", status: "available", availableMinutes: 90 }
            ]
          }]
        });
        scvcc.getCourtBookings = async () => ({ bookings: [] });
        scvcc.bookCourt = async (params) => {
          bookedAttempts.push(params);
          return { success: true, reservationId: `res_${bookedAttempts.length}`, court: params.court };
        };

        const res = await preBookCourtsForMatch({
          sock: {},
          remoteJid: "120363403838804497@g.us",
          targetDateMDY: "11/20/2026",
          queryTime: "7:00 PM",
          size: 12,
          isAuto: false,
          preBookCourts: null // Not specified on command
        });

        assert.equal(bookedAttempts.length, 3, "Should attempt to book 3 courts to accommodate size 12");
        assert.equal(res.advanceBookedCourts.length, 3, "Should successfully book 3 courts");
      } finally {
        scvcc.bookCourt = origBookCourt;
        scvcc.checkCourtAvailability = origCheckAvail;
        scvcc.getCourtBookings = origGetBookings;
      }
    });

    it("should default recurring schedule preBookCourts to size court count (e.g. size 8 -> 2 courts) instead of group default preBookCourts: 1", async () => {
      groupsConfig.getGroupConfig = () => ({
        sport: "tennis",
        courtBookingEnabled: true,
        preBookCourts: 1
      });

      const recurringPolls = new Map();
      const parsed = recurringPollsModule.parseRecurringPollText("!recurringpoll 8 7pm mon-thu --courts-strategy=book");
      await recurringPollsModule.scheduleRecurringPoll({
        recurringPolls,
        persistPolls: () => {},
        targetChatId: "120363403838804497@g.us",
        sender: "Pramod",
        senderJid: "pramod@lid",
        params: parsed
      });

      const sched = [...recurringPolls.values()][0];
      assert.equal(sched.size, 8);
      assert.equal(sched.preBookCourts, 2, "Schedule preBookCourts should default to 2 (from size 8) rather than group default 1");
    });

    it("should scale down multi-time slot size from 8 to 4 when only 1 court is found", async () => {
      scvcc.checkCourtAvailability = async () => ({
        slots: [{ courts: [] }]
      });
      scvcc.getCourtBookings = async () => ({
        bookings: [
          { court: "Court 2", blockTitle: "Pramod Immaneni", players: ["Pramod Immaneni"], durationMins: 90 }
        ]
      });

      let sentPoll = null;
      const mockSock = {
        sendMessage: async (jid, content) => {
          if (content.poll) sentPoll = content.poll;
          return { key: { id: "poll_multi_scale_down", remoteJid: jid }, message: content };
        }
      };
      const activePolls = new Map();
      const context = { activePolls, persistPolls: () => {} };

      const timeSlots = [
        { dayWord: "Saturday", timeWord: "8am", size: 8 },
        { dayWord: "Saturday", timeWord: "9:30am", size: 4 }
      ];

      const res = await createMatchPoll(
        mockSock,
        "group1@g.us",
        null,
        "Saturday 8am",
        null,
        null,
        "Alice",
        "alice@s.whatsapp.net",
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
        null,
        context,
        { timeSlots }
      );

      assert.equal(res.err, null);
      assert.equal(res.isMultiTime, true);
      assert.equal(res.timeSlots[0].size, 4, "Slot size should scale down from 8 to 4");
      assert.equal(res.timeSlots[0].slotLimit, 4, "Slot limit should scale down from 8 to 4");
      assert.deepEqual(res.options, [
        "8am (4 spots)",
        "9:30am (4 spots)",
        "No / Can't play"
      ]);
    });

    it("should not pre-book any courts for an opt-in poll when preBookCourts is not specified", async () => {
      groupsConfig.getGroupConfig = () => ({
        sport: "tennis",
        courtBookingEnabled: true,
        directCourtBookingAccounts: ["Pramod Immaneni"],
        defaultBookingPlayers: ["Alice", "Bob", "Charlie"]
      });

      let bookedAttempts = [];
      const origBookCourt = scvcc.bookCourt;
      try {
        scvcc.bookCourt = async (params) => {
          bookedAttempts.push(params);
          return { success: true, reservationId: "res_1", court: params.court };
        };

        const res = await preBookCourtsForMatch({
          sock: {},
          remoteJid: "120363403838804497@g.us",
          targetDateMDY: "11/20/2026",
          queryTime: "7:00 PM",
          size: null, // Opt-in poll
          isAuto: false,
          preBookCourts: null
        });

        assert.equal(bookedAttempts.length, 0, "Should not attempt to book any courts for opt-in poll without explicit preBookCourts");
        assert.equal(res.advanceBookedCourts.length, 0);
        assert.equal(res.prebookedCourts.length, 0);
      } finally {
        scvcc.bookCourt = origBookCourt;
      }
    });

    it("should pre-book courts for an opt-in poll when preBookCourts is explicitly specified", async () => {
      groupsConfig.getGroupConfig = () => ({
        sport: "tennis",
        courtBookingEnabled: true,
        directCourtBookingAccounts: ["Pramod Immaneni"],
        defaultBookingPlayers: ["Alice", "Bob", "Charlie"]
      });

      let bookedAttempts = [];
      const origBookCourt = scvcc.bookCourt;
      const origCheckAvail = scvcc.checkCourtAvailability;
      const origGetBookings = scvcc.getCourtBookings;
      try {
        scvcc.checkCourtAvailability = async () => ({
          slots: [{
            time: "7:00 PM",
            courts: [
              { court: "Court 1", status: "available", availableMinutes: 90 }
            ]
          }]
        });
        scvcc.getCourtBookings = async () => ({ bookings: [] });
        scvcc.bookCourt = async (params) => {
          bookedAttempts.push(params);
          return { success: true, reservationId: "res_1", court: params.court };
        };

        const res = await preBookCourtsForMatch({
          sock: {},
          remoteJid: "120363403838804497@g.us",
          targetDateMDY: "11/20/2026",
          queryTime: "7:00 PM",
          size: null, // Opt-in poll
          isAuto: false,
          preBookCourts: 1 // Explicitly specified
        });

        assert.equal(bookedAttempts.length, 1, "Should book 1 court when explicit preBookCourts=1 is passed");
        assert.equal(res.advanceBookedCourts.length, 1);
      } finally {
        scvcc.bookCourt = origBookCourt;
        scvcc.checkCourtAvailability = origCheckAvail;
        scvcc.getCourtBookings = origGetBookings;
      }
    });

  });

  describe("Split-poll combined reminders and lead-time lineups", () => {
    const crypto = require("crypto");
    const makeOptHash = (name) => crypto.createHash("sha256").update(name).digest();

    it("checkAndSendPollReminders sends a single combined reminder for a 16-slot split poll and syncs state across parts", async () => {
      const messagesSent = [];
      const mockSock = {
        user: { id: "tenbot@s.whatsapp.net" },
        sendMessage: async (jid, content, opts) => {
          messagesSent.push({ jid, content, opts });
          return { key: { id: `rem_${messagesSent.length}`, remoteJid: jid } };
        }
      };

      const now = new Date("2026-10-24T17:00:00.000Z").getTime(); // 10:00 AM PDT (not quiet hours)
      const playAt = new Date(now + 8 * 3600 * 1000).toISOString(); // 8h remaining -> 8h bucket
      const createdAt = new Date(now - 2 * 3600 * 1000).toISOString();

      const part1Opts = Array.from({ length: 11 }, (_, i) => `Player ${i + 2}`);
      const part2Opts = ["Player 13", "Player 14", "Player 15", "Player 16"];

      const p1VoteBuffer = new Map();
      p1VoteBuffer.set("14085550002@s.whatsapp.net", {
        pollUpdateMessageKey: { participant: "14085550002@s.whatsapp.net" },
        vote: { selectedOptions: [makeOptHash("Player 2")] }
      });
      p1VoteBuffer.set("14085550003@s.whatsapp.net", {
        pollUpdateMessageKey: { participant: "14085550003@s.whatsapp.net" },
        vote: { selectedOptions: [makeOptHash("Player 3")] }
      });

      const p2VoteBuffer = new Map();
      p2VoteBuffer.set("14085550013@s.whatsapp.net", {
        pollUpdateMessageKey: { participant: "14085550013@s.whatsapp.net" },
        vote: { selectedOptions: [makeOptHash("Player 13")] }
      });

      const parentPollId = "session_split_16_1";
      const part1State = {
        remoteJid: "group1@g.us",
        name: "🎾 Alice's poll: tomorrow 5:30pm (Part 1/2: Spots 1–12)",
        options: part1Opts,
        size: 12,
        sessionTotalSize: 16,
        type: "fixed",
        when: "tomorrow 5:30pm",
        playAt,
        createdAt,
        status: "active",
        isManual: false,
        creator: { name: "Alice", jid: "14085550001@s.whatsapp.net" },
        parentPollId,
        partNumber: 1,
        totalParts: 2,
        siblingPollIds: ["poll_split_p2"],
        sentReminders: [16],
        reminderCount: 0,
        voteBuffer: p1VoteBuffer
      };
      const part2State = {
        remoteJid: "group1@g.us",
        name: "🎾 tomorrow 5:30pm (Part 2/2: Spots 13–16)",
        options: part2Opts,
        size: 4,
        sessionTotalSize: 16,
        type: "fixed",
        when: "tomorrow 5:30pm",
        playAt,
        createdAt,
        status: "active",
        isManual: false,
        creator: null,
        parentPollId,
        partNumber: 2,
        totalParts: 2,
        siblingPollIds: ["poll_split_p1"],
        sentReminders: [16],
        reminderCount: 0,
        voteBuffer: p2VoteBuffer
      };

      const activePolls = new Map([
        ["poll_split_p1", part1State],
        ["poll_split_p2", part2State]
      ]);
      const messageStore = new Map([
        ["group1@g.us:poll_split_p1", { pollCreationMessage: { name: part1State.name, options: part1Opts.map((o) => ({ optionName: o })) } }],
        ["group1@g.us:poll_split_p2", { pollCreationMessage: { name: part2State.name, options: part2Opts.map((o) => ({ optionName: o })) } }]
      ]);
      const context = { activePolls, messageStore, persistPolls: () => {} };

      await checkAndSendPollReminders(mockSock, context, now);

      assert.equal(messagesSent.length, 1, "Should send only 1 combined reminder for split poll");
      assert.match(messagesSent[0].content.text, /12 spots left/);
      assert.match(messagesSent[0].content.text, /Confirmed \(4\)/);
      assert.match(messagesSent[0].content.text, /Need 4 players/);
      assert.match(messagesSent[0].content.text, /Alice/);
      assert.equal(messagesSent[0].opts.quoted.key.id, "poll_split_p1");
      assert.ok(part1State.sentReminders.includes(8) && part2State.sentReminders.includes(8), "Both parts should mark 8h reminder as sent");
      assert.equal(part1State.reminderCount, 1);
      assert.equal(part2State.reminderCount, 1);

      // Sweeping again immediately should not send a duplicate reminder
      messagesSent.length = 0;
      await checkAndSendPollReminders(mockSock, context, now + 60 * 1000);
      assert.equal(messagesSent.length, 0);
    });

    it("sends combined reminder with all players when Part 1 is filled and Part 2 is still active", async () => {
      const messagesSent = [];
      const mockSock = {
        user: { id: "tenbot@s.whatsapp.net" },
        sendMessage: async (jid, content, opts) => {
          messagesSent.push({ jid, content, opts });
          return { key: { id: `rem_p1filled_${messagesSent.length}`, remoteJid: jid } };
        }
      };

      const now = new Date("2026-10-24T19:00:00.000Z").getTime(); // 12:00 PM PDT
      const playAt = new Date(now + 3.5 * 3600 * 1000).toISOString(); // 3.5h remaining -> 4h bucket
      const createdAt = new Date(now - 5 * 3600 * 1000).toISOString();

      const part1Opts = Array.from({ length: 12 }, (_, i) => `Player ${i + 1}`);
      const part2Opts = ["Player 13", "Player 14", "Player 15", "Player 16"];

      const p1VoteBuffer = new Map();
      for (let i = 1; i <= 12; i++) {
        const jid = `140855510${String(i).padStart(2, "0")}@s.whatsapp.net`;
        p1VoteBuffer.set(jid, {
          pollUpdateMessageKey: { participant: jid },
          vote: { selectedOptions: [makeOptHash(`Player ${i}`)] }
        });
      }
      const p2VoteBuffer = new Map();
      p2VoteBuffer.set("14085551013@s.whatsapp.net", {
        pollUpdateMessageKey: { participant: "14085551013@s.whatsapp.net" },
        vote: { selectedOptions: [makeOptHash("Player 13")] }
      });

      const parentPollId = "session_p1_filled";
      const part1State = {
        remoteJid: "group1@g.us",
        name: "🎾 today 3:30pm (Part 1/2: Spots 1–12)",
        options: part1Opts,
        size: 12,
        sessionTotalSize: 16,
        type: "fixed",
        when: "today 3:30pm",
        playAt,
        createdAt,
        status: "filled",
        isManual: false,
        isAuto: true,
        parentPollId,
        partNumber: 1,
        totalParts: 2,
        sentReminders: [16, 8],
        reminderCount: 2,
        voteBuffer: p1VoteBuffer
      };
      const part2State = {
        remoteJid: "group1@g.us",
        name: "🎾 today 3:30pm (Part 2/2: Spots 13–16)",
        options: part2Opts,
        size: 4,
        sessionTotalSize: 16,
        type: "fixed",
        when: "today 3:30pm",
        playAt,
        createdAt,
        status: "active",
        isManual: false,
        isAuto: true,
        parentPollId,
        partNumber: 2,
        totalParts: 2,
        sentReminders: [16, 8],
        reminderCount: 2,
        voteBuffer: p2VoteBuffer
      };

      const activePolls = new Map([
        ["poll_f_1", part1State],
        ["poll_f_2", part2State]
      ]);
      const messageStore = new Map([
        ["group1@g.us:poll_f_1", { pollCreationMessage: { name: part1State.name, options: part1Opts.map((o) => ({ optionName: o })) } }],
        ["group1@g.us:poll_f_2", { pollCreationMessage: { name: part2State.name, options: part2Opts.map((o) => ({ optionName: o })) } }]
      ]);
      const context = { activePolls, messageStore, persistPolls: () => {} };

      await checkAndSendPollReminders(mockSock, context, now);

      assert.equal(messagesSent.length, 1);
      assert.match(messagesSent[0].content.text, /Need 3 players/i);
      assert.match(messagesSent[0].content.text, /3 spots left/i);
      assert.equal(messagesSent[0].opts.quoted.key.id, "poll_f_2", "Should quote the active part where open spots live");
      assert.match(messagesSent[0].content.text, /Player \(1001\)/);
      assert.match(messagesSent[0].content.text, /@14085551013/);
      assert.ok(Array.isArray(messagesSent[0].content.mentions) && messagesSent[0].content.mentions.includes("14085551013@s.whatsapp.net"));
      assert.equal(part1State.reminderCount, 3);
      assert.equal(part2State.reminderCount, 3);
      assert.ok(part1State.sentReminders.includes(4) && part2State.sentReminders.includes(4));
    });

    it("handleTriggerReminder, handlePauseReminders, and handleResumeReminders operate on the combined logical poll", async () => {
      const messagesSent = [];
      const mockSock = {
        user: { id: "tenbot@s.whatsapp.net" },
        sendMessage: async (jid, content, opts) => {
          messagesSent.push({ jid, content, opts });
          return { key: { id: `man_${messagesSent.length}`, remoteJid: jid } };
        }
      };

      const now = new Date("2026-10-24T19:00:00.000Z").getTime();
      const playAt = new Date(now + 10 * 3600 * 1000).toISOString();
      const parentPollId = "session_cmd_split";
      const part1State = {
        remoteJid: "group1@g.us",
        name: "🎾 tomorrow 5am (Part 1/2: Spots 1–12)",
        options: Array.from({ length: 12 }, (_, i) => `Player ${i + 1}`),
        size: 12,
        sessionTotalSize: 16,
        type: "fixed",
        when: "tomorrow 5am",
        playAt,
        status: "filled",
        parentPollId,
        partNumber: 1,
        totalParts: 2,
        voteBuffer: new Map()
      };
      const part2State = {
        remoteJid: "group1@g.us",
        name: "🎾 tomorrow 5am (Part 2/2: Spots 13–16)",
        options: ["Player 13", "Player 14", "Player 15", "Player 16"],
        size: 4,
        sessionTotalSize: 16,
        type: "fixed",
        when: "tomorrow 5am",
        playAt,
        status: "active",
        parentPollId,
        partNumber: 2,
        totalParts: 2,
        voteBuffer: new Map()
      };

      const activePolls = new Map([
        ["poll_cmd_1", part1State],
        ["poll_cmd_2", part2State]
      ]);
      const context = { activePolls, recurringPolls: new Map(), messageStore: new Map(), persistPolls: () => {} };

      // Manual trigger without specific ID sends only 1 reminder
      await handleTriggerReminder(mockSock, "group1@g.us", "Alice", null, context, false, now);
      assert.equal(messagesSent.length, 1);

      // Manual trigger referencing Part 1 (even though Part 1 is filled while Part 2 is active) succeeds and sends 1 reminder
      messagesSent.length = 0;
      const specificRes = await handleTriggerReminder(mockSock, "group1@g.us", "Alice", "poll_cmd_1", context, false, now);
      assert.equal(specificRes, true);
      assert.equal(messagesSent.length, 1);

      // Pause/Resume targeting Part 1 syncs both parts
      const pauseMsg = await handlePauseReminders(mockSock, "group1@g.us", "Alice", "poll_cmd_1", context);
      assert.match(pauseMsg, /Reminders have been paused/);
      assert.equal(part1State.reminders, false);
      assert.equal(part2State.reminders, false);

      const resumeMsg = await handleResumeReminders(mockSock, "group1@g.us", "Alice", "poll_cmd_1", context);
      assert.match(resumeMsg, /Reminders have been resumed/);
      assert.equal(part1State.reminders, true);
      assert.equal(part2State.reminders, true);
    });

    it("checkPendingLineupGenerations sends a single lead-time lineup reminder for a resolved split poll", async () => {
      const messagesSent = [];
      const mockSock = {
        user: { id: "tenbot@s.whatsapp.net" },
        sendMessage: async (jid, content, opts) => {
          messagesSent.push({ jid, content, opts });
          return { key: { id: `lineup_rem_${messagesSent.length}`, remoteJid: jid } };
        }
      };

      const now = Date.now();
      const playAt = new Date(now + 15 * 60 * 1000).toISOString(); // inside default 30m lead time
      const sampleSchedule = { sets: [{ set: 1, courts: [{ court: "Court 1", teamA: ["A", "B"], teamB: ["C", "D"] }] }] };
      const parentPollId = "session_lineup_split";
      const part1State = {
        remoteJid: "group1@g.us",
        name: "🎾 today 7pm (Part 1/2: Spots 1–12)",
        when: "today 7pm",
        playAt,
        status: "resolved",
        lineupGeneration: "filled",
        lineupLeadTime: 30,
        lineupReminderSent: false,
        lastSchedule: sampleSchedule,
        parentPollId,
        partNumber: 1,
        totalParts: 2,
        voteBuffer: new Map()
      };
      const part2State = {
        ...part1State,
        name: "🎾 today 7pm (Part 2/2: Spots 13–16)",
        partNumber: 2
      };

      const activePolls = new Map([
        ["poll_lu_1", part1State],
        ["poll_lu_2", part2State]
      ]);
      const context = { activePolls, messageStore: new Map(), persistPolls: () => {} };

      const res = await checkPendingLineupGenerations(mockSock, context, now);
      assert.equal(messagesSent.length, 1, "Should send only 1 lead-time lineup reminder across split poll parts");
      assert.equal(res.remindedPollIds.length, 1);
      assert.equal(part1State.lineupReminderSent, true);
      assert.equal(part2State.lineupReminderSent, true);
    });

    it("handles 28-slot split poll with pending spillover total spots and prevents duplicate reminders after Part 3 spawns", async () => {
      const messagesSent = [];
      const mockSock = {
        user: { id: "tenbot@s.whatsapp.net" },
        sendMessage: async (jid, content, opts) => {
          messagesSent.push({ jid, content, opts });
          return { key: { id: `rem_28_${messagesSent.length}`, remoteJid: jid } };
        }
      };

      const now = new Date("2026-10-24T17:00:00.000Z").getTime();
      const playAt = new Date(now + 15.5 * 3600 * 1000).toISOString(); // 15.5h remaining -> 16h bucket
      const createdAt = new Date(now - 2 * 3600 * 1000).toISOString();

      const part1Opts = Array.from({ length: 12 }, (_, i) => `Player ${i + 1}`);
      const part2Opts = Array.from({ length: 12 }, (_, i) => `Player ${i + 13}`);
      const p1VoteBuffer = new Map([
        ["14085552001@s.whatsapp.net", { pollUpdateMessageKey: { participant: "14085552001@s.whatsapp.net" }, vote: { selectedOptions: [makeOptHash("Player 1")] } }],
        ["14085552002@s.whatsapp.net", { pollUpdateMessageKey: { participant: "14085552002@s.whatsapp.net" }, vote: { selectedOptions: [makeOptHash("Player 2")] } }]
      ]);
      const p2VoteBuffer = new Map([
        ["14085552013@s.whatsapp.net", { pollUpdateMessageKey: { participant: "14085552013@s.whatsapp.net" }, vote: { selectedOptions: [makeOptHash("Player 13")] } }]
      ]);

      const parentPollId = "session_split_28";
      const part1State = {
        remoteJid: "group1@g.us",
        name: "🎾 tomorrow 8:30am (Part 1/3: Spots 1–12)",
        options: part1Opts,
        size: 12,
        sessionTotalSize: 28,
        type: "fixed",
        when: "tomorrow 8:30am",
        playAt,
        createdAt,
        status: "active",
        isAuto: true,
        parentPollId,
        partNumber: 1,
        totalParts: 3,
        sentReminders: [],
        reminderCount: 0,
        voteBuffer: p1VoteBuffer
      };
      const part2State = {
        ...part1State,
        name: "🎾 tomorrow 8:30am (Part 2/3: Spots 13–24)",
        options: part2Opts,
        partNumber: 2,
        sentReminders: [],
        voteBuffer: p2VoteBuffer
      };

      const activePolls = new Map([
        ["poll_28_1", part1State],
        ["poll_28_2", part2State]
      ]);
      const messageStore = new Map([
        ["group1@g.us:poll_28_1", { pollCreationMessage: { name: part1State.name, options: part1Opts.map((o) => ({ optionName: o })) } }],
        ["group1@g.us:poll_28_2", { pollCreationMessage: { name: part2State.name, options: part2Opts.map((o) => ({ optionName: o })) } }]
      ]);
      const context = { activePolls, messageStore, persistPolls: () => {} };

      await checkAndSendPollReminders(mockSock, context, now);
      assert.equal(messagesSent.length, 1);
      assert.match(messagesSent[0].content.text, /25 spots left/i);
      assert.match(messagesSent[0].content.text, /Need 1 player/i);
      assert.ok(Array.isArray(messagesSent[0].content.mentions) && messagesSent[0].content.mentions.includes("14085552013@s.whatsapp.net"));

      // Simulate Parts 1 & 2 filling up and spillover Part 3 inheriting synced sentReminders
      part1State.status = "filled";
      part2State.status = "filled";
      activePolls.set("poll_28_3", {
        ...part2State,
        name: "🎾 tomorrow 8:30am (Part 3/3: Spots 25–28)",
        options: ["Player 25", "Player 26", "Player 27", "Player 28"],
        size: 4,
        status: "active",
        partNumber: 3,
        sentReminders: [...part2State.sentReminders],
        voteBuffer: new Map()
      });

      messagesSent.length = 0;
      await checkAndSendPollReminders(mockSock, context, now + 10 * 60 * 1000);
      assert.equal(messagesSent.length, 0, "Spillover Part 3 must not re-trigger already sent 16h reminder");
    });

    it("checkPendingLineupGenerations fallback mode combines all split poll parts into one matchup draw", async () => {
      const messagesSent = [];
      const mockSock = {
        user: { id: "tenbot@s.whatsapp.net" },
        sendMessage: async (jid, content, opts) => {
          messagesSent.push({ jid, content, opts });
          return { key: { id: `fallback_lu_${messagesSent.length}`, remoteJid: jid } };
        }
      };

      const now = Date.now();
      const playAt = new Date(now + 15 * 60 * 1000).toISOString();
      const parentPollId = "session_fallback_16";
      const part1Opts = Array.from({ length: 12 }, (_, i) => `Player ${i + 1}`);
      const part2Opts = ["Player 13", "Player 14", "Player 15", "Player 16"];
      const p1Players = Array.from({ length: 12 }, (_, i) => `P${i + 1}`);
      const p2Players = ["P13", "P14", "P15", "P16"];

      const part1State = {
        remoteJid: "group1@g.us",
        name: "🎾 today 7pm (Part 1/2: Spots 1–12)",
        options: part1Opts,
        size: 12,
        sessionTotalSize: 16,
        type: "fixed",
        when: "today 7pm",
        playAt,
        status: "filled",
        lineupGeneration: "fallback",
        lineupLeadTime: 30,
        lineupReminderSent: false,
        lastPlayers: p1Players,
        parentPollId,
        partNumber: 1,
        totalParts: 2,
        voteBuffer: new Map()
      };
      const part2State = {
        ...part1State,
        name: "🎾 today 7pm (Part 2/2: Spots 13–16)",
        options: part2Opts,
        size: 4,
        lastPlayers: p2Players,
        partNumber: 2
      };

      const activePolls = new Map([
        ["poll_fb_1", part1State],
        ["poll_fb_2", part2State]
      ]);
      const context = { activePolls, messageStore: new Map(), persistPolls: () => {} };

      const res = await checkPendingLineupGenerations(mockSock, context, now);
      assert.equal(messagesSent.length, 1, "Fallback mode should generate and send 1 combined matchup schedule");
      assert.equal(res.generatedPollIds.length, 1);
      assert.equal(part1State.status, "resolved");
      assert.equal(part2State.status, "resolved");
      assert.equal(part1State.lineupReminderSent, true);
      assert.equal(part2State.lineupReminderSent, true);
      assert.equal(part1State.lastPlayers.length, 16);
    });
  });

  describe("Split-poll grouped status display (!activepolls / pollStatusText)", () => {
    const crypto = require("crypto");
    function makeOptHash(name) {
      return crypto.createHash("sha256").update(name).digest();
    }

    it("groups 16-slot split polls (12 + 4, 9 + 4 = 13 votes) into one logical Poll Session block in !activepolls", async () => {
      const now = new Date("2026-10-24T17:00:00.000Z").getTime();
      const playAt = new Date(now + 10 * 3600 * 1000).toISOString();
      const createdAt = new Date(now - 2 * 3600 * 1000).toISOString();

      const part1Opts = Array.from({ length: 12 }, (_, i) => `Player ${i + 1}`);
      const part2Opts = Array.from({ length: 4 }, (_, i) => `Player ${13 + i}`);
      const part1Votes = new Map();
      for (let i = 1; i <= 9; i++) {
        part1Votes.set(`v${i}@s.whatsapp.net`, {
          pollUpdateMessageKey: { remoteJid: "group1@g.us", participant: `v${i}@s.whatsapp.net` },
          vote: { selectedOptions: [makeOptHash(`Player ${i}`)] }
        });
      }
      const part2Votes = new Map();
      for (let i = 10; i <= 13; i++) {
        part2Votes.set(`v${i}@s.whatsapp.net`, {
          pollUpdateMessageKey: { remoteJid: "group1@g.us", participant: `v${i}@s.whatsapp.net` },
          vote: { selectedOptions: [makeOptHash(`Player ${i + 3}`)] }
        });
      }

      const courts = [
        { court: "Court 1", bookingType: "auto" },
        { court: "Court 2", bookingType: "auto" },
        { court: "Court 3", bookingType: "auto" },
        { court: "Court 4", bookingType: "auto" }
      ];
      const advCourts = [
        { court: "Court 1", reservationId: "res-1" },
        { court: "Court 2", reservationId: "res-2" },
        { court: "Court 3", reservationId: "res-3" },
        { court: "Court 4", reservationId: "res-4" }
      ];

      const part1 = {
        remoteJid: "group1@g.us",
        scheduleId: "rec_fri7pm",
        name: "🎾 Friday 7pm (Part 1/2: Spots 1–12)",
        options: part1Opts,
        size: 12,
        type: "fixed",
        when: "Friday 7pm",
        playAt,
        createdAt,
        status: "active",
        isAuto: true,
        isRecurring: true,
        courtsStrategy: "book",
        slotCheck: true,
        lineupGeneration: "filled",
        prebookedCourts: courts,
        advanceBookedCourts: advCourts,
        autoBookedCourts: advCourts,
        parentPollId: "session_fri7pm",
        partNumber: 1,
        totalParts: 2,
        startSlot: 1,
        endSlot: 12,
        partSize: 12,
        sessionTotalSize: 16,
        sentReminders: [64, 32],
        reminderCount: 2,
        voteBuffer: part1Votes
      };
      const part2 = {
        ...part1,
        name: "🎾 Friday 7pm (Part 2/2: Spots 13–16)",
        options: part2Opts,
        size: 4,
        status: "filled",
        partNumber: 2,
        startSlot: 13,
        endSlot: 16,
        partSize: 4,
        voteBuffer: part2Votes
      };

      const activePolls = new Map([
        ["poll_part1", part1],
        ["poll_part2", part2]
      ]);
      const recurringPolls = new Map([
        ["rec_fri7pm", { id: "rec_fri7pm", remoteJid: "group1@g.us", daysDisplay: "Fri", matchDisplay: "7 PM", postDisplay: "8 AM", enabled: true }]
      ]);
      const messageStore = new Map([
        ["group1@g.us:poll_part1", { pollCreationMessage: { options: part1Opts.map((o) => ({ optionName: o })) } }],
        ["group1@g.us:poll_part2", { pollCreationMessage: { options: part2Opts.map((o) => ({ optionName: o })) } }]
      ]);
      const context = { activePolls, recurringPolls, messageStore };

      const activeOut = await handlePollCommand({}, "!activepolls", "group1@g.us", "Alice", "alice@s.whatsapp.net", {}, context);
      assert.doesNotMatch(activeOut, /\n---\n/, "Split parts must be grouped into a single section");
      assert.match(activeOut, /Poll Session session_fri7pm \(Friday 7pm\): 16 spots \(Doubles, split into 2 polls\)\./);
      assert.match(activeOut, /Status: active \(1\/2 parts filled\)/);
      assert.match(activeOut, /Created: 10\/24\/2026, 8:00:00 AM/);
      assert.match(activeOut, /Slots filled: 13\/16/);
      assert.match(activeOut, /Currently playing \(13\):/);
      assert.match(activeOut, /Split Poll Parts \(2\):/);
      assert.match(activeOut, /Part 1\/2 \(Spots 1–12, ID: `poll_part1`\) \[active\]: 9\/12/);
      assert.match(activeOut, /Part 2\/2 \(Spots 13–16, ID: `poll_part2`\) \[filled\]: 4\/4/);

      // Recurring summary in !pollstatus also groups the split session
      const fullOut = pollStatusText("group1@g.us", {}, context);
      assert.match(fullOut, /Poll Session `session_fri7pm` \(Friday 7pm, 2 parts: `poll_part1`, `poll_part2`\) — Status: active/);

      // Targeting a single split part ID still presents the grouped session view
      const singleTargetOut = pollStatusText("group1@g.us", { targetId: "poll_part2" }, context);
      assert.match(singleTargetOut, /Poll Session session_fri7pm/);
      assert.match(singleTargetOut, /Part 1\/2/);
      assert.match(singleTargetOut, /Part 2\/2/);
    });

    it("shows total session size vs currently open capacity for demand-driven spillover split polls", () => {
      const now = new Date("2026-10-24T17:00:00.000Z").getTime();
      const playAt = new Date(now + 10 * 3600 * 1000).toISOString();
      const part1Opts = Array.from({ length: 12 }, (_, i) => `Player ${i + 1}`);
      const part2Opts = Array.from({ length: 12 }, (_, i) => `Player ${i + 13}`);
      const base = {
        remoteJid: "group1@g.us",
        type: "fixed",
        when: "Saturday 8am",
        playAt,
        status: "active",
        parentPollId: "session_28_spill",
        totalParts: 3,
        sessionTotalSize: 28,
        voteBuffer: new Map()
      };
      const activePolls = new Map([
        ["p28_1", { ...base, partNumber: 1, startSlot: 1, endSlot: 12, size: 12, options: part1Opts }],
        ["p28_2", { ...base, partNumber: 2, startSlot: 13, endSlot: 24, size: 12, options: part2Opts }]
      ]);
      const messageStore = new Map([
        ["group1@g.us:p28_1", { pollCreationMessage: { options: part1Opts.map((o) => ({ optionName: o })) } }],
        ["group1@g.us:p28_2", { pollCreationMessage: { options: part2Opts.map((o) => ({ optionName: o })) } }]
      ]);

      const out = pollStatusText("group1@g.us", { activeOnly: true }, { activePolls, recurringPolls: new Map(), messageStore });
      assert.match(out, /Poll Session session_28_spill \(Saturday 8am\): 28 spots \(Doubles, 2\/3 parts created\)\./);
      assert.match(out, /Created: unknown/);
      assert.match(out, /Slots filled: 0\/28 \(0\/24 currently open\)/);
    });
  });

  describe("club closed detection in poll creation and on-demand booking", () => {
    it("should reject poll creation with clubClosed=true when court title matches clubClosedTitles (taking precedence over tentativeBookingTitles)", async () => {
      const origCheck = scvcc.checkCourtAvailability;
      const origBookings = scvcc.getCourtBookings;
      const origGetConfig = groupsConfig.getGroupConfig;

      try {
        groupsConfig.getGroupConfig = () => ({
          name: "Test Group",
          sport: "tennis",
          courtBookingEnabled: true,
          tentativeBookingTitles: ["Clinic", "Holiday"],
          clubClosedTitles: ["Holiday Closure"]
        });

        scvcc.checkCourtAvailability = async () => ({
          slots: [{
            time: "7:00 PM",
            courts: [
              { court: "Court 1", status: "booked", blockTitle: "Holiday Closure" },
              { court: "Court 2", status: "booked", blockTitle: "Holiday Closure" }
            ]
          }]
        });
        scvcc.getCourtBookings = async () => ({
          bookings: [
            { court: "Court 1", blockTitle: "Holiday Closure", durationMins: 90 }
          ]
        });

        let pollSent = false;
        const sentTexts = [];
        const mockSock = {
          sendMessage: async (_jid, msg) => {
            if (msg?.poll) pollSent = true;
            if (msg?.text) sentTexts.push(msg.text);
            return { key: { id: "should_not_exist" } };
          }
        };
        const context = { activePolls: new Map(), persistPolls: () => {} };

        const res = await createMatchPoll(
          mockSock,
          "group1@g.us",
          4,
          "Tomorrow 7pm",
          null,
          null,
          "Alice",
          "alice@s.whatsapp.net",
          false,
          null,
          false,
          false,
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
          null,
          {},
          context
        );

        assert.equal(pollSent, false, "Poll must not be posted when club is closed");
        assert.equal(sentTexts.length, 1, "Should notify group why poll was not created");
        assert.match(sentTexts[0], /Club is closed \(Holiday Closure\)/);
        assert.equal(res.noCourtsAvailable, true);
        assert.equal(res.clubClosed, true);
        assert.equal(res.clubClosedTitle, "Holiday Closure");
        assert.match(res.err, /Club is closed \(Holiday Closure\)/);
      } finally {
        scvcc.checkCourtAvailability = origCheck;
        scvcc.getCourtBookings = origBookings;
        groupsConfig.getGroupConfig = origGetConfig;
      }
    });

    it("handleOnDemandCourtBooking should stop without retrying when bookCourt returns clubClosed", async () => {
      const { handleOnDemandCourtBooking } = require("../lib/commands/poll/courts");
      const origCheck = scvcc.checkCourtAvailability;
      const origBook = scvcc.bookCourt;
      const origGetConfig = groupsConfig.getGroupConfig;

      let bookAttempts = 0;
      groupsConfig.getGroupConfig = () => ({
        name: "Test Group",
        sport: "tennis",
        courtBookingEnabled: true,
        clubClosedTitles: ["Club Closed"]
      });
      scvcc.checkCourtAvailability = async () => ({
        success: true,
        slots: [{ time: "7:00 PM", courts: [{ court: "Court 1", status: "available", availableMinutes: 90 }] }]
      });
      scvcc.bookCourt = async () => {
        bookAttempts++;
        return { success: false, clubClosed: true, clubClosedTitle: "Club Closed", time: "7:00 PM" };
      };

      const pollState = {
        remoteJid: "group1@g.us",
        name: "Tomorrow 7pm",
        targetDateMDY: "11/26/2026",
        queryTime: "7:00 PM",
        courtBookingType: "doubles",
        unbookedCourts: [{ court: "Court 1", time: "7:00 PM" }],
        tentativeCourts: [],
        prebookedCourts: []
      };

      try {
        await handleOnDemandCourtBooking(null, "poll_closed_ondemand", pollState, [], { persistPolls: () => {} });
        assert.equal(bookAttempts, 1, "Should stop after 1 booking attempt when clubClosed is true");
        assert.ok(Array.isArray(pollState.closedTimes));
        assert.equal(pollState.closedTimes.length, 1);
        assert.equal(pollState.closedTimes[0].title, "Club Closed");
      } finally {
        scvcc.checkCourtAvailability = origCheck;
        scvcc.bookCourt = origBook;
        groupsConfig.getGroupConfig = origGetConfig;
      }
    });
  });

  describe("Poll creation time display in !activepolls / pollStatusText", () => {
    it("includes formatted Created timestamp across fixed, opt-in, multi-time, and manual polls in !activepolls", async () => {
      const createdIso = "2026-10-24T15:30:45.000Z"; // 8:30:45 AM PDT in America/Los_Angeles
      const playAtIso = "2026-10-25T16:00:00.000Z";

      const activePolls = new Map([
        ["p_fixed", {
          remoteJid: "group1@g.us",
          type: "fixed",
          size: 4,
          when: "Tomorrow 9am",
          playAt: playAtIso,
          createdAt: createdIso,
          status: "active",
          options: ["Player 1", "Player 2", "Player 3", "Player 4"],
          voteBuffer: new Map()
        }],
        ["p_optin", {
          remoteJid: "group1@g.us",
          type: "opt_in",
          size: 4,
          slotLimit: 4,
          when: "Tomorrow 10am",
          playAt: playAtIso,
          createdAt: createdIso,
          status: "active",
          options: ["Yes", "No"],
          voteBuffer: new Map()
        }],
        ["p_multi", {
          remoteJid: "group1@g.us",
          type: "multi_time",
          when: "Tomorrow",
          playAt: playAtIso,
          createdAt: createdIso,
          status: "active",
          timeSlots: [
            { id: "slot_8am", label: "8 AM", slotLimit: 4, status: "active" }
          ],
          options: ["8 AM", "No"],
          voteBuffer: new Map()
        }],
        ["p_manual", {
          remoteJid: "group1@g.us",
          isManual: true,
          name: "Manual Hit",
          when: "Sunday",
          playAt: null,
          status: "active",
          options: ["9am", "10am"],
          voteBuffer: new Map()
        }]
      ]);

      const messageStore = new Map([
        ["group1@g.us:p_manual", {
          messageTimestamp: Math.floor(new Date(createdIso).getTime() / 1000),
          pollCreationMessage: { options: [{ optionName: "9am" }, { optionName: "10am" }] }
        }]
      ]);
      const context = { activePolls, recurringPolls: new Map(), messageStore };

      const out = await handlePollCommand({}, "!activepolls", "group1@g.us", "Alice", "alice@s.whatsapp.net", {}, context);
      const sections = out.split("\n\n---\n\n");
      assert.equal(sections.length, 4);
      for (const section of sections) {
        assert.match(section, /Created: 10\/24\/2026, 8:30:45 AM/);
      }
    });

    it("falls back to Created: unknown when createdAt and messageTimestamp are missing", () => {
      const activePolls = new Map([
        ["p_nocreated", {
          remoteJid: "group1@g.us",
          type: "fixed",
          size: 4,
          when: "Tomorrow 9am",
          status: "active",
          options: ["Player 1", "Player 2", "Player 3", "Player 4"],
          voteBuffer: new Map()
        }]
      ]);
      const out = pollStatusText("group1@g.us", { activeOnly: true }, { activePolls, recurringPolls: new Map() });
      assert.match(out, /Created: unknown/);
    });
  });

  describe("Poll Title display on a separate line in pollStatusText", () => {
    it("shows Title: on its own line separate from Poll ID for manual, fixed, opt-in, multi-time, and split polls", () => {
      const activePolls = new Map([
        ["p_manual", {
          remoteJid: "group1@g.us",
          isManual: true,
          name: "Friday evening 6pm doubles?",
          when: "Friday 6pm",
          status: "active",
          options: ["In", "Out"],
          voteBuffer: new Map()
        }],
        ["p_manual_custom", {
          remoteJid: "group1@g.us",
          isManual: true,
          name: "Sunday Hit",
          title: "Manual Club Hit",
          when: "Sunday",
          status: "active",
          options: ["9am", "10am"],
          voteBuffer: new Map()
        }],
        ["p_fixed_noncustom", {
          remoteJid: "group1@g.us",
          type: "fixed",
          size: 4,
          name: "🎾 Tomorrow 7pm (4 slots / 4)\n\nCourt 1 - 7:00 PM",
          when: "Tomorrow 7pm",
          status: "active",
          options: ["Player 1", "Player 2", "Player 3", "Player 4"],
          voteBuffer: new Map()
        }],
        ["p_optin_noncustom", {
          remoteJid: "group1@g.us",
          type: "opt_in",
          size: 4,
          slotLimit: 4,
          name: "🎾 Saturday 8am (4 spots — Vote Yes/No)",
          when: "Saturday 8am",
          status: "active",
          options: ["Yes", "No"],
          voteBuffer: new Map()
        }],
        ["p_multi_noncustom", {
          remoteJid: "group1@g.us",
          type: "multi_time",
          name: "🎾 Sunday (Vote for time(s))",
          when: "Sunday 8am",
          status: "active",
          timeSlots: [{ id: "slot_8am", label: "8 AM", slotLimit: 4, status: "active" }],
          options: ["8 AM", "No"],
          voteBuffer: new Map()
        }],
        ["p_split_1", {
          remoteJid: "group1@g.us",
          type: "fixed",
          size: 12,
          parentPollId: "sess_title_1",
          partNumber: 1,
          totalParts: 2,
          sessionTotalSize: 16,
          name: "🎾 Friday 7pm (Part 1/2: Spots 1–12)\n\nCourt 1 - 7:00 PM",
          when: "Friday 7pm",
          status: "active",
          options: Array.from({ length: 12 }, (_, i) => `Player ${i + 1}`),
          voteBuffer: new Map()
        }],
        ["p_split_2", {
          remoteJid: "group1@g.us",
          type: "fixed",
          size: 4,
          parentPollId: "sess_title_1",
          partNumber: 2,
          totalParts: 2,
          sessionTotalSize: 16,
          name: "🎾 Friday 7pm (Part 2/2: Spots 13–16)",
          when: "Friday 7pm",
          status: "active",
          options: ["Player 13", "Player 14", "Player 15", "Player 16"],
          voteBuffer: new Map()
        }]
      ]);

      const ctx = { activePolls, recurringPolls: new Map(), messageStore: new Map() };

      const manualOut = pollStatusText("group1@g.us", { targetId: "p_manual" }, ctx);
      assert.match(manualOut, /^Poll p_manual: User-Created Manual Match Poll\.\nTitle: Friday evening 6pm doubles\?/);
      assert.doesNotMatch(manualOut.split("\n")[0], /Friday evening 6pm doubles\?/);

      const manualCustomOut = pollStatusText("group1@g.us", { targetId: "p_manual_custom" }, ctx);
      assert.match(manualCustomOut, /^Poll p_manual_custom: User-Created Manual Match Poll\.\nTitle: Manual Club Hit/);

      const fixedOut = pollStatusText("group1@g.us", { targetId: "p_fixed_noncustom" }, ctx);
      assert.match(fixedOut, /^Poll p_fixed_noncustom \(Tomorrow 7pm\): 4 spots \(Doubles\)\.\nTitle: 🎾 Tomorrow 7pm \(4 slots \/ 4\)\n/);

      const optInOut = pollStatusText("group1@g.us", { targetId: "p_optin_noncustom" }, ctx);
      assert.match(optInOut, /^Poll p_optin_noncustom \(Saturday 8am\): Opt-in \(Yes\/No, 4 spots max\)\.\nTitle: 🎾 Saturday 8am \(4 spots — Vote Yes\/No\)\n/);

      const multiOut = pollStatusText("group1@g.us", { targetId: "p_multi_noncustom" }, ctx);
      assert.match(multiOut, /^Poll p_multi_noncustom \(Sunday 8am\): Multi-Time Poll \(1 time slots\)\.\nTitle: 🎾 Sunday \(Vote for time\(s\)\)\n/);

      const splitOut = pollStatusText("group1@g.us", { targetId: "p_split_1" }, ctx);
      assert.match(splitOut, /^Poll Session sess_title_1 \(Friday 7pm\): 16 spots \(Doubles, split into 2 polls\)\.\nTitle: 🎾 Friday 7pm\n/);

      // DM / all-chats output keeps Poll ID and Title on separate lines
      const dmOut = pollStatusText(null, {}, ctx);
      assert.match(dmOut, /Chat\/Group: group1@g\.us\nPoll p_manual: User-Created Manual Match Poll\.\nTitle: Friday evening 6pm doubles\?/);
    });
  });
});
