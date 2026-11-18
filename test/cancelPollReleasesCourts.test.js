const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const scvcc = require('../lib/scvcc');
const courtCommands = require('../lib/commands/courtCommands');
const {
  releaseAllCourtsForPollState,
  cancelOrDeletePoll,
  handlePollCommand,
  executePollTool
} = require('../lib/commands/pollCommands');

const TEST_GROUP_JID = '120363403838804497@g.us';

describe('cancel poll releases all booked courts', () => {
  let mockSock;
  let sentMessages;
  let cancelledReservations;
  let sentNotifications;

  beforeEach(() => {
    sentMessages = [];
    cancelledReservations = [];
    sentNotifications = [];

    mockSock = {
      sendMessage: async (jid, content) => {
        sentMessages.push({ jid, content });
        return { key: { id: `msg_${Date.now()}` } };
      },
      groupMetadata: async () => ({
        id: TEST_GROUP_JID,
        subject: 'Bot-testing',
        participants: [
          { id: 'admin@s.whatsapp.net', admin: 'admin' },
          { id: 'user@s.whatsapp.net', admin: null }
        ]
      })
    };

    // Spy on scvcc.cancelCourtReservation
    scvcc.cancelCourtReservation = async (resId, chatId) => {
      cancelledReservations.push({ resId, chatId });
      return {
        success: true,
        message: `Reservation ${resId} cancelled at SCVCC`
      };
    };

    // Spy on sendBookingNotifications
    courtCommands.sendBookingNotifications = async (sock, chatId, msg) => {
      sentNotifications.push({ chatId, msg });
    };
  });

  it('releases all courts and notifies for single-time poll', async () => {
    const pollState = {
      id: 'poll_st_1',
      remoteJid: TEST_GROUP_JID,
      title: 'Saturday Tennis',
      size: 8,
      slotLimit: 8,
      status: 'active',
      prebookedCourts: [
        { court: 'Court 1', reservationId: 'RES-101' },
        { court: 'Court 2', reservationId: 'RES-102' }
      ],
      autoBookedCourts: [
        { court: 'Court 1', reservationId: 'RES-101' },
        { court: 'Court 2', reservationId: 'RES-102' }
      ]
    };

    const released = await releaseAllCourtsForPollState(mockSock, pollState, TEST_GROUP_JID, {});

    assert.deepEqual(released, ['Court 1', 'Court 2']);
    assert.equal(cancelledReservations.length, 2);
    assert.equal(cancelledReservations[0].resId, 'RES-101');
    assert.equal(cancelledReservations[1].resId, 'RES-102');
    assert.equal(sentNotifications.length, 2);
    assert.equal(pollState.size, 0);
    assert.equal(pollState.status, 'stopped');
    assert.equal(pollState.prebookedCourts.length, 0);
  });

  it('releases all courts across slots for multi-time poll', async () => {
    const pollState = {
      id: 'poll_mt_1',
      remoteJid: TEST_GROUP_JID,
      title: 'Sunday Multi-time',
      type: 'multi_time',
      status: 'active',
      timeSlots: [
        {
          label: '8:00 AM',
          timeDisplay: '8:00 AM',
          size: 4,
          status: 'active',
          prebookedCourts: [{ court: 'Court 3', reservationId: 'RES-301' }],
          autoBookedCourts: [{ court: 'Court 3', reservationId: 'RES-301' }]
        },
        {
          label: '9:30 AM',
          timeDisplay: '9:30 AM',
          size: 4,
          status: 'active',
          prebookedCourts: [{ court: 'Court 4', reservationId: 'RES-401' }],
          advanceBookedCourts: [{ court: 'Court 4', reservationId: 'RES-401' }]
        }
      ]
    };

    const released = await releaseAllCourtsForPollState(mockSock, pollState, TEST_GROUP_JID, {});

    assert.equal(released.length, 2);
    assert.ok(released.some(r => r.includes('Court 3')));
    assert.ok(released.some(r => r.includes('Court 4')));
    assert.equal(cancelledReservations.length, 2);
    assert.equal(cancelledReservations[0].resId, 'RES-301');
    assert.equal(cancelledReservations[1].resId, 'RES-401');
    assert.equal(sentNotifications.length, 2);
    assert.equal(pollState.timeSlots[0].status, 'stopped');
    assert.equal(pollState.timeSlots[1].status, 'stopped');
  });

  it('cancelOrDeletePoll releases courts and deletes sibling polls', async () => {
    const activePolls = new Map();
    const context = {
      activePolls,
      latestPollIdByChat: new Map([[TEST_GROUP_JID, 'poll_p1']]),
      persistPolls: () => {}
    };

    const poll1 = {
      id: 'poll_p1',
      remoteJid: TEST_GROUP_JID,
      title: 'Part 1',
      status: 'active',
      siblingPollIds: ['poll_p1', 'poll_p2'],
      prebookedCourts: [{ court: 'Court 1', reservationId: 'RES-P1' }]
    };

    const poll2 = {
      id: 'poll_p2',
      remoteJid: TEST_GROUP_JID,
      title: 'Part 2',
      status: 'active',
      siblingPollIds: ['poll_p1', 'poll_p2'],
      prebookedCourts: [{ court: 'Court 2', reservationId: 'RES-P2' }]
    };

    activePolls.set('poll_p1', poll1);
    activePolls.set('poll_p2', poll2);

    const res = await cancelOrDeletePoll(mockSock, TEST_GROUP_JID, 'poll_p1', context);

    assert.equal(activePolls.has('poll_p1'), false);
    assert.equal(activePolls.has('poll_p2'), false);
    assert.equal(cancelledReservations.length, 2);
    assert.ok(res.releasedCourts.includes('Court 1'));
    assert.ok(res.releasedCourts.includes('Court 2'));
  });

  it('!cancelpoll command reports released courts and notifies group if from DM', async () => {
    const activePolls = new Map();
    const context = {
      activePolls,
      latestPollIdByChat: new Map([[TEST_GROUP_JID, 'poll_dm_test']]),
      persistPolls: () => {}
    };

    const pollState = {
      id: 'poll_dm_test',
      remoteJid: TEST_GROUP_JID,
      title: 'Weekend Singles',
      status: 'active',
      creator: { jid: 'admin@s.whatsapp.net', name: 'Admin' },
      prebookedCourts: [{ court: 'Court 5', reservationId: 'RES-501' }]
    };
    activePolls.set('poll_dm_test', pollState);

    // Cancel from within group chat
    const replyGroup = await handlePollCommand(
      mockSock,
      '!cancelpoll',
      TEST_GROUP_JID,
      'Admin',
      'admin@s.whatsapp.net',
      null,
      context
    );

    assert.ok(replyGroup.includes('Poll cancelled'));
    assert.ok(replyGroup.includes('Court 5'));
    assert.equal(cancelledReservations.length, 1);
    assert.equal(cancelledReservations[0].resId, 'RES-501');

    // Reset and test cancel from DM targeting group
    cancelledReservations = [];
    const pollState2 = {
      id: 'poll_dm_test2',
      remoteJid: TEST_GROUP_JID,
      title: 'Weekend Doubles',
      status: 'active',
      creator: { jid: 'admin@s.whatsapp.net', name: 'Admin' },
      prebookedCourts: [{ court: 'Court 6', reservationId: 'RES-601' }]
    };
    activePolls.set('poll_dm_test2', pollState2);
    context.latestPollIdByChat.set(TEST_GROUP_JID, 'poll_dm_test2');

    const replyDm = await handlePollCommand(
      mockSock,
      '!cancelpoll --group="Bot-testing"',
      'admin@s.whatsapp.net', // DM
      'Admin',
      'admin@s.whatsapp.net',
      null,
      context
    );

    assert.ok(replyDm.includes('Poll cancelled'));
    assert.ok(replyDm.includes('Court 6'));
    // Group should receive notification
    assert.ok(sentMessages.some(m => m.jid === TEST_GROUP_JID && m.content?.text?.includes('Court 6')));
  });

  it('cancel_poll tool in executePollTool releases courts and returns report', async () => {
    const activePolls = new Map();
    const context = {
      activePolls,
      latestPollIdByChat: new Map([[TEST_GROUP_JID, 'poll_tool_test']]),
      persistPolls: () => {}
    };

    const pollState = {
      id: 'poll_tool_test',
      remoteJid: TEST_GROUP_JID,
      title: 'Evening Hit',
      status: 'active',
      creator: { jid: 'admin@s.whatsapp.net', name: 'Admin' },
      prebookedCourts: [{ court: 'Court 7', reservationId: 'RES-701' }]
    };
    activePolls.set('poll_tool_test', pollState);

    const toolResult = await executePollTool(
      mockSock,
      'cancel_poll',
      { pollId: 'poll_tool_test' },
      'Admin',
      'admin@s.whatsapp.net',
      TEST_GROUP_JID,
      null,
      context
    );

    assert.ok(toolResult.includes('Poll cancelled and deleted from WhatsApp successfully'));
    assert.ok(toolResult.includes('Court 7'));
    assert.equal(cancelledReservations.length, 1);
    assert.equal(cancelledReservations[0].resId, 'RES-701');
  });
});
