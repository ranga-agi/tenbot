const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  handleListRecurringPolls,
  handleListRecurringAdvanceBookings,
  handleRecurringCommand,
  executeRecurringTool
} = require('../lib/commands/recurringCommands');
const commands = require('../lib/commands');
const recurringPollsModule = require('../lib/recurringPolls');
const groupsConfig = require('../lib/groupsConfig');

describe('recurringCommands', () => {
  describe('handleListRecurringPolls', () => {
    it('should return no schedules message when recurringPolls map is empty', () => {
      const context = { recurringPolls: new Map() };
      const res = handleListRecurringPolls('test_chat@g.us', context);
      assert.match(res, /No recurring match polls scheduled/i);
    });

    it('should format recurring poll schedule list when schedules exist', () => {
      const recurringPolls = new Map([
        ['rec_test1', {
          id: 'rec_test1',
          remoteJid: 'test_chat@g.us',
          daysDisplay: 'Mon, Wed, Fri',
          matchDisplay: '7:00 PM',
          postDisplay: '8:00 AM',
          size: 4,
          enabled: true
        }]
      ]);
      const res = handleListRecurringPolls('test_chat@g.us', { recurringPolls });
      assert.match(res, /rec_test1/);
      assert.match(res, /Mon, Wed, Fri/);
      assert.match(res, /7:00 PM/);
    });
  });

  describe('listRecurringAdvanceBookings & advancebookings command', () => {
    it('should parse !recurringpoll advancedbookings variants cleanly', () => {
      assert.deepEqual(
        recurringPollsModule.parseRecurringPollText('!recurringpoll advancedbookings'),
        { action: 'advance_bookings', scheduleId: null }
      );
      assert.deepEqual(
        recurringPollsModule.parseRecurringPollText('!recurringpoll advancedbookings rec_1'),
        { action: 'advance_bookings', scheduleId: 'rec_1' }
      );
      assert.deepEqual(
        recurringPollsModule.parseRecurringPollText('!recurringpolls advancedbookings rec_2'),
        { action: 'advance_bookings', scheduleId: 'rec_2' }
      );
      assert.deepEqual(
        recurringPollsModule.parseRecurringPollText('!recurringpoll advancebookings'),
        { action: 'advance_bookings', scheduleId: null }
      );
      assert.deepEqual(
        recurringPollsModule.parseRecurringPollText('!recurringpoll rec_3 advancedbookings'),
        { action: 'advance_bookings', scheduleId: 'rec_3' }
      );
      assert.deepEqual(
        recurringPollsModule.parseRecurringPollText('!advancedbookings rec_4'),
        { action: 'advance_bookings', scheduleId: 'rec_4' }
      );
      assert.deepEqual(
        recurringPollsModule.parseRecurringPollText('!recurringpoll advanced bookings rec_5'),
        { action: 'advance_bookings', scheduleId: 'rec_5' }
      );
    });

    it('should handle empty state and chats with no advance booking schedules', () => {
      const emptyRes = recurringPollsModule.listRecurringAdvanceBookings({
        recurringPolls: new Map(),
        chatId: 'test_chat@g.us'
      });
      assert.match(emptyRes, /No recurring match polls scheduled/i);

      const standardOnly = new Map([
        ['rec_std', {
          id: 'rec_std',
          remoteJid: 'test_chat@g.us',
          matchTime: '7:00 PM',
          matchDisplay: '7:00 PM',
          daysDisplay: 'Mon',
          courtsStrategy: 'lookup',
          enabled: true,
          advanceBookings: {}
        }]
      ]);
      const noAdvRes = recurringPollsModule.listRecurringAdvanceBookings({
        recurringPolls: standardOnly,
        chatId: 'test_chat@g.us'
      });
      assert.match(noAdvRes, /No advance court bookings found/i);
    });

    it('should format configured schedules waiting for trigger, completed bookings, partial bookings with manual courts, and posted polls', () => {
      const customNow = { year: 2026, month: 10, day: 20, hour: 10, minute: 0 }; // 2026-11-20 10:00 AM SJ
      const recurringPolls = new Map([
        ['rec_adv1', {
          id: 'rec_adv1',
          remoteJid: 'test_chat@g.us',
          title: 'Friday Lights',
          matchTime: '7:00 PM',
          matchDisplay: '7:00 PM',
          matchHour: 19,
          matchMinute: 0,
          postTime: '8:00 AM',
          postDisplay: '8:00 AM',
          postHour: 8,
          postMinute: 0,
          days: 'fri',
          daysList: [5],
          daysDisplay: 'Fri',
          size: 8,
          bookingStrategy: 'advanced',
          bookingSchedule: '-7days 7:00AM',
          preBookCourts: 2,
          enabled: true,
          advanceBookings: {
            // Expired entry (before customNow 2026-11-20 10:00 AM) -> should be filtered out
            '2026-11-19': {
              targetDateMDY: '11/19/2026',
              matchTime: '7:00 PM',
              targetCourtsCount: 1,
              completed: true,
              autoBookedCourts: [{ court: 'Court 4', reservationId: 'old_999', players: ['Old'] }]
            },
            // Upcoming entry with 1 auto + 1 manual -> completed 2/2, poll not yet posted
            '2026-11-27': {
              targetDateMDY: '11/27/2026',
              matchTime: '7:00 PM',
              targetCourtsCount: 2,
              completed: true,
              autoBookedCourts: [{
                court: 'Court 1',
                time: '7:00 PM',
                reservationId: '194617',
                players: ['Alice', 'Bob', 'Charlie', 'Dave'],
                duration: '90 Minutes',
                partySize: 'Doubles'
              }],
              prebookedCourts: [
                { court: 'Court 1', player: 'Alice', time: '7:00 PM', bookingType: 'auto' },
                { court: 'Court 2', player: 'John', fullName: 'John Doe', time: '7:00 PM', bookingType: 'manual' }
              ]
            },
            // Upcoming entry with 1/2 courts (retrying) and poll already posted
            '2026-12-04': {
              targetDateMDY: '12/04/2026',
              matchTime: '7:00 PM',
              targetCourtsCount: 2,
              completed: false,
              retryCount: 2,
              pollCreated: true,
              autoBookedCourts: [{
                court: 'Court 3',
                time: '7:00 PM',
                reservationId: '195001',
                players: ['Alice', 'Bob']
              }]
            }
          }
        }],
        ['rec_morning', {
          id: 'rec_morning',
          remoteJid: 'test_chat@g.us',
          matchTime: '8:00 AM',
          matchDisplay: '8:00 AM',
          daysDisplay: 'Fri',
          bookingStrategy: 'advanced',
          bookingSchedule: '-7days 7:00AM',
          preBookCourts: 1,
          enabled: true,
          advanceBookings: {
            '2026-11-27': {
              targetDateMDY: '11/27/2026',
              matchTime: '8:00 AM',
              targetCourtsCount: 1,
              completed: true,
              pollCreated: true,
              autoBookedCourts: [{ court: 'Court 5', reservationId: '194500', players: ['Mia'] }]
            }
          }
        }],
        ['rec_waiting', {
          id: 'rec_waiting',
          remoteJid: 'test_chat@g.us',
          matchTime: '6:00 PM',
          matchDisplay: '6:00 PM',
          daysDisplay: 'Mon',
          bookingStrategy: 'advanced',
          bookingSchedule: '-7days 7:00AM',
          preBookCourts: 1,
          enabled: false,
          advanceBookings: {}
        }],
        ['rec_other_group', {
          id: 'rec_other_group',
          remoteJid: 'other_chat@g.us',
          matchTime: '8:00 PM',
          matchDisplay: '8:00 PM',
          daysDisplay: 'Sat',
          bookingStrategy: 'advanced',
          bookingSchedule: '-7days 7:00AM',
          enabled: true,
          advanceBookings: {
            '2026-11-28': {
              targetDateMDY: '11/28/2026',
              matchTime: '8:00 PM',
              targetCourtsCount: 1,
              completed: true,
              autoBookedCourts: [{ court: 'Court 5', reservationId: '777777', players: ['Eve'] }]
            }
          }
        }]
      ]);

      const res = recurringPollsModule.listRecurringAdvanceBookings({
        recurringPolls,
        chatId: 'test_chat@g.us',
        customSanJoseParts: customNow
      });

      assert.match(res, /Recurring Advance Court Bookings/);
      assert.match(res, /📅 \*Friday, 11\/27\/2026\*/);
      assert.equal((res.match(/Friday, 11\/27\/2026/g) || []).length, 1);
      assert.ok(res.indexOf('rec_morning') < res.indexOf('rec_adv1'), 'Same-day entries should sort chronologically (8:00 AM before 7:00 PM)');
      assert.ok(res.indexOf('11/27/2026') < res.indexOf('12/04/2026'), 'Days should sort chronologically');
      assert.match(res, /rec_adv1/);
      assert.match(res, /Friday Lights/);
      assert.match(res, /✅ 2\/2 courts/);
      assert.match(res, /Court 1.*\[auto booked\].*Doubles, 90 Minutes.*Alice, Bob, Charlie, Dave.*194617/);
      assert.match(res, /Court 2.*\[manual by John Doe\]/);
      assert.match(res, /Poll: 🕒 Not yet posted/);
      assert.match(res, /📅 \*Friday, 12\/04\/2026\*/);
      assert.match(res, /⏳ 1\/2 courts \(retrying\)/);
      assert.match(res, /Poll: ✅ Already posted/);
      assert.match(res, /Attempts: 2 retries/);
      assert.match(res, /Waiting for Booking Trigger/i);
      assert.match(res, /rec_waiting/);
      assert.match(res, /\(Paused\)/);
      assert.match(res, /-7days 7:00AM \(1 court\)/);

      // Expired and other group entries should NOT appear
      assert.equal(res.includes('old_999'), false);
      assert.equal(res.includes('rec_other_group'), false);
      assert.equal(res.includes('777777'), false);

      // Filtering by specific scheduleId
      const singleRes = recurringPollsModule.listRecurringAdvanceBookings({
        recurringPolls,
        chatId: 'test_chat@g.us',
        scheduleId: 'rec_adv1',
        customSanJoseParts: customNow
      });
      assert.match(singleRes, /rec_adv1/);
      assert.equal(singleRes.includes('rec_waiting'), false);

      // Unknown scheduleId
      const missingRes = recurringPollsModule.listRecurringAdvanceBookings({
        recurringPolls,
        chatId: 'test_chat@g.us',
        scheduleId: 'rec_missing',
        customSanJoseParts: customNow
      });
      assert.match(missingRes, /was not found/i);
    });

    it('should restrict !recurringpoll advancedbookings to admins or poll creators in group chats', async () => {
      const recurringPolls = new Map([
        ['rec_alice', {
          id: 'rec_alice',
          remoteJid: 'test_chat@g.us',
          creator: { name: 'Alice', jid: 'alice@s.whatsapp.net' },
          matchTime: '7:00 PM',
          matchDisplay: '7:00 PM',
          daysDisplay: 'Fri',
          bookingStrategy: 'advanced',
          bookingSchedule: '-7days 7:00AM',
          enabled: true,
          advanceBookings: {
            '2099-11-27': {
              targetDateMDY: '11/27/2099',
              matchTime: '7:00 PM',
              targetCourtsCount: 1,
              completed: true,
              autoBookedCourts: [{ court: 'Court 1', reservationId: '888111', players: ['Alice'] }]
            }
          }
        }],
        ['rec_bob', {
          id: 'rec_bob',
          remoteJid: 'test_chat@g.us',
          creator: { name: 'Bob', jid: 'bob@s.whatsapp.net' },
          matchTime: '8:00 PM',
          matchDisplay: '8:00 PM',
          daysDisplay: 'Sat',
          bookingStrategy: 'advanced',
          bookingSchedule: '-7days 7:00AM',
          enabled: true,
          advanceBookings: {
            '2099-11-28': {
              targetDateMDY: '11/28/2099',
              matchTime: '8:00 PM',
              targetCourtsCount: 1,
              completed: true,
              autoBookedCourts: [{ court: 'Court 2', reservationId: '999222', players: ['Bob'] }]
            }
          }
        }]
      ]);
      const mockSock = {
        groupMetadata: async () => ({
          subject: 'Test Group',
          participants: [
            { id: 'admin@s.whatsapp.net', admin: 'admin' },
            { id: 'alice@s.whatsapp.net', admin: null },
            { id: 'bob@s.whatsapp.net', admin: null },
            { id: 'charlie@s.whatsapp.net', admin: null }
          ]
        })
      };
      const context = { recurringPolls, activePolls: new Map() };

      // 1. Non-admin, non-creator (Charlie) is rejected for both list and specific schedule
      const charlieAll = await handleListRecurringAdvanceBookings(mockSock, 'test_chat@g.us', 'Charlie', 'charlie@s.whatsapp.net', null, context);
      assert.match(charlieAll, /Only group admins or poll creators can view advance court bookings/i);

      const charlieOne = await handleRecurringCommand(mockSock, '!recurringpoll advancedbookings rec_alice', 'test_chat@g.us', 'Charlie', 'charlie@s.whatsapp.net', context);
      assert.match(charlieOne, /Only the creator of this recurring poll or group admins can view its advance bookings/i);

      // 2. Non-admin creator (Alice) can view her own schedule(s), but NOT Bob's
      const aliceAll = await handleRecurringCommand(mockSock, '!recurringpoll advancedbookings', 'test_chat@g.us', 'Alice', 'alice@s.whatsapp.net', context);
      assert.match(aliceAll, /rec_alice/);
      assert.match(aliceAll, /888111/);
      assert.equal(aliceAll.includes('rec_bob'), false);
      assert.equal(aliceAll.includes('999222'), false);

      const aliceOwnViaAlias = await handleRecurringCommand(mockSock, '!advancedbookings rec_alice', 'test_chat@g.us', 'Alice', 'alice@s.whatsapp.net', context);
      assert.match(aliceOwnViaAlias, /rec_alice/);
      assert.match(aliceOwnViaAlias, /888111/);

      const aliceOwnViaRouter = await commands.routeCommand(mockSock, '!recurringpoll advancedbookings rec_alice', 'test_chat@g.us', 'Alice', { key: { participant: 'alice@s.whatsapp.net' } }, context);
      assert.match(aliceOwnViaRouter, /rec_alice/);
      assert.match(aliceOwnViaRouter, /888111/);

      const aliceBobDenied = await handleRecurringCommand(mockSock, '!recurringpoll advancedbookings rec_bob', 'test_chat@g.us', 'Alice', 'alice@s.whatsapp.net', context);
      assert.match(aliceBobDenied, /Only the creator of this recurring poll or group admins can view its advance bookings/i);

      // 3. Group admin (non-creator) can view ALL schedules in the group
      const adminAll = await handleRecurringCommand(mockSock, '!recurringpoll advancedbookings', 'test_chat@g.us', 'Admin', 'admin@s.whatsapp.net', context);
      assert.match(adminAll, /rec_alice/);
      assert.match(adminAll, /888111/);
      assert.match(adminAll, /rec_bob/);
      assert.match(adminAll, /999222/);

      const adminBob = await handleRecurringCommand(mockSock, '!recurringpoll advancedbookings rec_bob', 'test_chat@g.us', 'Admin', 'admin@s.whatsapp.net', context);
      assert.match(adminBob, /rec_bob/);
      assert.match(adminBob, /999222/);
    });

    it('should enforce admin or creator authorization for --group DM access on !recurringpoll advancedbookings', async () => {
      const origIsGroupAllowed = groupsConfig.isGroupAllowed;
      const origGetGroupConfig = groupsConfig.getGroupConfig;
      const origIsSuperAdmin = groupsConfig.isSuperAdmin;
      groupsConfig.isGroupAllowed = (gId) => gId === 'weekday_group@g.us';
      groupsConfig.getGroupConfig = (gId) => (gId === 'weekday_group@g.us' ? { name: 'Weekday Group' } : null);
      groupsConfig.isSuperAdmin = (jid) => jid === 'super@s.whatsapp.net';

      try {
        const recurringPolls = new Map([
          ['rec_dm1', {
            id: 'rec_dm1',
            remoteJid: 'weekday_group@g.us',
            creator: { name: 'Bob', jid: 'bob@s.whatsapp.net' },
            matchTime: '7:00 PM',
            matchDisplay: '7:00 PM',
            daysDisplay: 'Mon',
            bookingStrategy: 'advanced',
            bookingSchedule: '-7days 7:00AM',
            enabled: true,
            advanceBookings: {
              '2099-12-01': {
                targetDateMDY: '12/01/2099',
                matchTime: '7:00 PM',
                targetCourtsCount: 1,
                completed: true,
                autoBookedCourts: [{ court: 'Court 2', reservationId: '555222', players: ['Bob'] }]
              }
            }
          }]
        ]);
        const mockSock = {
          groupFetchAllParticipating: async () => ({
            'weekday_group@g.us': {
              subject: 'Weekday Group',
              participants: [
                { id: 'admin@s.whatsapp.net', admin: 'admin' },
                { id: 'bob@s.whatsapp.net', admin: null },
                { id: 'outsider@s.whatsapp.net', admin: null }
              ]
            }
          }),
          groupMetadata: async () => ({
            subject: 'Weekday Group',
            participants: [
              { id: 'admin@s.whatsapp.net', admin: 'admin' },
              { id: 'bob@s.whatsapp.net', admin: null },
              { id: 'outsider@s.whatsapp.net', admin: null }
            ]
          })
        };

        // Non-admin & non-creator via DM --group is rejected
        const outsiderRes = await handleRecurringCommand(
          mockSock,
          '!recurringpoll advancedbookings --group="Weekday Group"',
          'outsider@s.whatsapp.net',
          'Outsider',
          'outsider@s.whatsapp.net',
          { recurringPolls, activePolls: new Map() }
        );
        assert.match(outsiderRes, /Only group admins or poll creators can view advance court bookings/i);

        // Poll creator via DM --group can view their own schedule
        const creatorRes = await handleRecurringCommand(
          mockSock,
          '!recurringpoll advancedbookings --group="Weekday Group"',
          'bob@s.whatsapp.net',
          'Bob',
          'bob@s.whatsapp.net',
          { recurringPolls, activePolls: new Map() }
        );
        assert.match(creatorRes, /rec_dm1/);
        assert.match(creatorRes, /555222/);

        // Group admin via DM --group can view group advance bookings
        const adminRes = await handleRecurringCommand(
          mockSock,
          '!recurringpoll advancedbookings --group="Weekday Group"',
          'admin@s.whatsapp.net',
          'Admin',
          'admin@s.whatsapp.net',
          { recurringPolls, activePolls: new Map() }
        );
        assert.match(adminRes, /rec_dm1/);
        assert.match(adminRes, /555222/);

        // Bot superadmin via DM --group can view advance bookings
        const superRes = await handleRecurringCommand(
          mockSock,
          '!recurringpoll advancedbookings --group="Weekday Group"',
          'super@s.whatsapp.net',
          'Super',
          'super@s.whatsapp.net',
          { recurringPolls, activePolls: new Map() }
        );
        assert.match(superRes, /rec_dm1/);
        assert.match(superRes, /555222/);
      } finally {
        groupsConfig.isGroupAllowed = origIsGroupAllowed;
        groupsConfig.getGroupConfig = origGetGroupConfig;
        groupsConfig.isSuperAdmin = origIsSuperAdmin;
      }
    });

    it('should display club-closed advance booking entries without retrying status', () => {
      const recurringPolls = new Map([
        ['rec_closed1', {
          id: 'rec_closed1',
          remoteJid: 'test_chat@g.us',
          matchTime: '7:00 PM',
          matchDisplay: '7:00 PM',
          daysDisplay: 'Thu',
          bookingStrategy: 'advanced',
          bookingSchedule: '-7days 7:00AM',
          enabled: true,
          advanceBookings: {
            '2099-11-26': {
              targetDateMDY: '11/26/2099',
              matchTime: '7:00 PM',
              targetCourtsCount: 2,
              completed: true,
              clubClosed: true,
              clubClosedTitle: 'Thanksgiving Day - Club Closed',
              retryCount: 1,
              autoBookedCourts: [],
              prebookedCourts: []
            }
          }
        }]
      ]);

      const res = recurringPollsModule.listRecurringAdvanceBookings({
        recurringPolls,
        chatId: 'test_chat@g.us'
      });
      assert.match(res, /🚫 Club Closed \(Thanksgiving Day - Club Closed\)/);
      assert.match(res, /Rebooking skipped — club is closed \(Thanksgiving Day - Club Closed\)/);
      assert.equal(res.includes('(retrying)'), false);
    });
  });

  describe('handleRecurringCommand', () => {
    it('should handle !recurringpolls list command', async () => {
      const context = { recurringPolls: new Map() };
      const res = await handleRecurringCommand(null, '!recurringpolls', 'test_chat@g.us', 'Alice', '123@s.whatsapp.net', context);
      assert.match(res, /No recurring match polls scheduled/i);
    });

    it('should return null for non-recurring commands', async () => {
      const res = await handleRecurringCommand(null, '!help', 'test_chat@g.us', 'Alice', '123@s.whatsapp.net', {});
      assert.equal(res, null);
    });
  });

  describe('executeRecurringTool', () => {
    it('should execute list_recurring_polls tool', async () => {
      const context = { recurringPolls: new Map() };
      const res = await executeRecurringTool(null, 'list_recurring_polls', {}, '123@s.whatsapp.net', 'test_chat@g.us', 'Alice', context);
      assert.match(res, /No recurring match polls scheduled/i);
    });

    it('should execute get_recurring_advance_bookings tool with admin/creator authorization', async () => {
      const recurringPolls = new Map([
        ['rec_tool1', {
          id: 'rec_tool1',
          remoteJid: 'test_chat@g.us',
          creator: { name: 'Alice', jid: 'alice@s.whatsapp.net' },
          matchTime: '7:00 PM',
          matchDisplay: '7:00 PM',
          daysDisplay: 'Thu',
          bookingStrategy: 'advanced',
          bookingSchedule: '-7days 7:00AM',
          enabled: true,
          advanceBookings: {
            '2099-11-26': {
              targetDateMDY: '11/26/2099',
              matchTime: '7:00 PM',
              targetCourtsCount: 1,
              completed: true,
              autoBookedCourts: [{ court: 'Court 3', reservationId: '333444', players: ['Alice'] }]
            }
          }
        }]
      ]);
      const mockSock = {
        groupMetadata: async () => ({
          subject: 'Test Group',
          participants: [
            { id: 'admin@s.whatsapp.net', admin: 'admin' },
            { id: 'alice@s.whatsapp.net', admin: null },
            { id: 'other@s.whatsapp.net', admin: null }
          ]
        })
      };
      const context = { recurringPolls, activePolls: new Map() };

      // Creator succeeds
      const directToolRes = await executeRecurringTool(
        mockSock,
        'get_recurring_advance_bookings',
        { scheduleId: 'rec_tool1' },
        'Alice',
        'alice@s.whatsapp.net',
        'test_chat@g.us',
        context
      );
      assert.match(directToolRes, /rec_tool1/);
      assert.match(directToolRes, /333444/);

      // Admin succeeds via commands.executeTool
      const routedToolRes = await commands.executeTool(
        mockSock,
        'test_chat@g.us',
        'Admin',
        { name: 'get_recurring_advance_bookings', input: {} },
        { key: { participant: 'admin@s.whatsapp.net' } },
        context
      );
      assert.match(routedToolRes, /rec_tool1/);
      assert.match(routedToolRes, /333444/);

      // Non-admin / non-creator is rejected via commands.executeTool
      const deniedToolRes = await commands.executeTool(
        mockSock,
        'test_chat@g.us',
        'Other',
        { name: 'get_recurring_advance_bookings', input: {} },
        { key: { participant: 'other@s.whatsapp.net' } },
        context
      );
      assert.match(deniedToolRes, /Only group admins or poll creators can view advance court bookings/i);
    });

    it('should return unknown message for unrecognized tool', async () => {
      const res = await executeRecurringTool(null, 'nonexistent_recurring_tool', {}, '123@s.whatsapp.net', 'test_chat@g.us', 'Alice', {});
      assert.equal(res, 'Unknown recurring tool nonexistent_recurring_tool');
    });
  });
});
