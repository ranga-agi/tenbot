process.env.NODE_ENV = 'test';
const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const scvcc = require('../lib/scvcc');
const courtCommands = require('../lib/commands/courtCommands');
const {
  checkCourtReleasesForPoll,
  releaseAllCourtsForPollState,
  handleReleasePollCourts
} = require('../lib/commands/poll');

const TEST_GROUP_JID = '120363403838804497@g.us';

describe('SCVCC cancelCourtReservation & poll release failure notifications', () => {
  let origAuthFetch;
  let origCancelCourtReservation;
  let origSendBookingNotifications;
  let origConsoleError;
  let origConsoleWarn;

  beforeEach(() => {
    origAuthFetch = scvcc.authFetch;
    origCancelCourtReservation = scvcc.cancelCourtReservation;
    origSendBookingNotifications = courtCommands.sendBookingNotifications;
    origConsoleError = console.error;
    origConsoleWarn = console.warn;
  });

  afterEach(() => {
    scvcc.authFetch = origAuthFetch;
    scvcc.cancelCourtReservation = origCancelCourtReservation;
    courtCommands.sendBookingNotifications = origSendBookingNotifications;
    console.error = origConsoleError;
    console.warn = origConsoleWarn;
  });

  describe('scvcc.cancelCourtReservation', () => {
    const dialogWithCancelBtn = `
      <html><body>
        <input type="hidden" name="__VIEWSTATE" value="vs1" />
        <input type="hidden" name="__EVENTVALIDATION" value="ev1" />
        <a id="ctl00_ctrl_MakeBookingTime_lbCancel" href="javascript:__doPostBack('ctl00$ctrl_MakeBookingTime$lbCancel','')">Cancel</a>
      </body></html>
    `;

    it('succeeds in 1 GET + 1 POST when delta contains ReturnbookingTime', async () => {
      let getCount = 0;
      let postCount = 0;
      scvcc.authFetch = async (url, options) => {
        if (options?.method === 'POST') {
          postCount++;
          return {
            ok: true,
            status: 200,
            text: async () => '1|#||4|28|pageRedirect||%2fdialog.aspx%3fp%3drbmPop%26tt%3dReturnbookingTime(195152)|'
          };
        }
        getCount++;
        return { ok: true, status: 200, text: async () => dialogWithCancelBtn };
      };

      const res = await scvcc.cancelCourtReservation('195152', TEST_GROUP_JID);
      assert.equal(res.success, true);
      assert.match(res.message, /195152/);
      assert.equal(getCount, 1);
      assert.equal(postCount, 1);
    });

    it('returns success: false with extracted message when SCVCC returns rbm_Error or alert()', async () => {
      console.warn = () => {};
      scvcc.authFetch = async (url, options) => {
        if (options?.method === 'POST') {
          return {
            ok: true,
            status: 200,
            text: async () => '<span class="rbm_Error">Cannot cancel within 2 hours of start time.</span>'
          };
        }
        return { ok: true, status: 200, text: async () => dialogWithCancelBtn };
      };

      const res = await scvcc.cancelCourtReservation('195152', TEST_GROUP_JID);
      assert.equal(res.success, false);
      assert.match(res.message, /Cannot cancel within 2 hours of start time/);

      scvcc.authFetch = async (url, options) => {
        if (options?.method === 'POST') {
          return {
            ok: true,
            status: 200,
            text: async () => "alert('Unable to cancel this booking.');"
          };
        }
        return { ok: true, status: 200, text: async () => dialogWithCancelBtn };
      };

      const resAlert = await scvcc.cancelCourtReservation('195152', TEST_GROUP_JID);
      assert.equal(resAlert.success, false);
      assert.match(resAlert.message, /Unable to cancel this booking/);
    });

    it('returns success: false on HTTP 500, empty POST body, or expired login redirect', async () => {
      console.warn = () => {};
      scvcc.authFetch = async (url, options) => {
        if (options?.method === 'POST') {
          return { ok: false, status: 500, text: async () => 'Internal server error' };
        }
        return { ok: true, status: 200, text: async () => dialogWithCancelBtn };
      };
      const res500 = await scvcc.cancelCourtReservation('195152', TEST_GROUP_JID);
      assert.equal(res500.success, false);
      assert.match(res500.message, /HTTP 500/);

      scvcc.authFetch = async (url, options) => {
        if (options?.method === 'POST') {
          return { ok: true, status: 200, text: async () => '   ' };
        }
        return { ok: true, status: 200, text: async () => dialogWithCancelBtn };
      };
      const resEmpty = await scvcc.cancelCourtReservation('195152', TEST_GROUP_JID);
      assert.equal(resEmpty.success, false);
      assert.match(resEmpty.message, /Empty response/i);

      scvcc.authFetch = async (url, options) => {
        if (options?.method === 'POST') {
          return { ok: true, status: 200, text: async () => '<div class="login-content">Please sign in</div>' };
        }
        return { ok: true, status: 200, text: async () => dialogWithCancelBtn };
      };
      const resLogin = await scvcc.cancelCourtReservation('195152', TEST_GROUP_JID);
      assert.equal(resLogin.success, false);
      assert.match(resLogin.message, /session expired/i);
    });

    it('verifies reservation dialog on ambiguous delta: fails if lbCancel is still present, succeeds if gone', async () => {
      console.warn = () => {};
      let getCount = 0;
      let postCount = 0;
      scvcc.authFetch = async (url, options) => {
        if (options?.method === 'POST') {
          postCount++;
          // No "Error" keyword, but also no ReturnbookingTime/showConfirm
          return { ok: true, status: 200, text: async () => '<div>Please confirm cancellation</div>' };
        }
        getCount++;
        return { ok: true, status: 200, text: async () => dialogWithCancelBtn };
      };

      const resStillActive = await scvcc.cancelCourtReservation('195152', TEST_GROUP_JID);
      assert.equal(resStillActive.success, false);
      assert.equal(postCount, 2);
      assert.equal(getCount, 4);
      assert.match(resStillActive.message, /still appears active/i);

      getCount = 0;
      scvcc.authFetch = async (url, options) => {
        if (options?.method === 'POST') {
          return { ok: true, status: 200, text: async () => '<script>GetRadWindow().close();</script>' };
        }
        getCount++;
        if (getCount === 1) {
          return { ok: true, status: 200, text: async () => dialogWithCancelBtn };
        }
        return { ok: true, status: 200, text: async () => '<html><body>Reservation not found</body></html>' };
      };

      const resVerifiedGone = await scvcc.cancelCourtReservation('195152', TEST_GROUP_JID);
      assert.equal(resVerifiedGone.success, true);
      assert.equal(getCount, 2);
    });

    it('retries once on failure and succeeds if the retry succeeds', async () => {
      console.warn = () => {};
      let getCount = 0;
      let postCount = 0;
      scvcc.authFetch = async (url, options) => {
        if (options?.method === 'POST') {
          postCount++;
          if (postCount === 1) {
            return { ok: false, status: 500, text: async () => 'Temporary SCVCC error' };
          }
          return {
            ok: true,
            status: 200,
            text: async () => '1|#||4|28|pageRedirect||%2fdialog.aspx%3fp%3drbmPop%26tt%3dReturnbookingTime(195152)|'
          };
        }
        getCount++;
        return { ok: true, status: 200, text: async () => dialogWithCancelBtn };
      };

      const res = await scvcc.cancelCourtReservation('195152', TEST_GROUP_JID);
      assert.equal(res.success, true);
      assert.equal(getCount, 2);
      assert.equal(postCount, 2);
    });

    it('stops after 1 retry (2 total attempts) when both attempts fail', async () => {
      console.warn = () => {};
      let getCount = 0;
      let postCount = 0;
      scvcc.authFetch = async (url, options) => {
        if (options?.method === 'POST') {
          postCount++;
          return { ok: true, status: 200, text: async () => '<span id="ctl00_ctrl_MakeBookingTime_errorLabel">Unable to cancel reservation at this time.</span>' };
        }
        getCount++;
        return { ok: true, status: 200, text: async () => dialogWithCancelBtn };
      };

      const res = await scvcc.cancelCourtReservation('195152', TEST_GROUP_JID);
      assert.equal(res.success, false);
      assert.match(res.message, /Unable to cancel reservation at this time/);
      assert.equal(getCount, 2);
      assert.equal(postCount, 2);
    });
  });

  describe('poll cancellation failure logging and notification list alerts', () => {
    it('logs error and notifies notification list at 90% mark when scvcc.cancelCourtReservation returns success: false', async () => {
      const errorLogs = [];
      console.error = (...args) => errorLogs.push(args.join(' '));

      const notifications = [];
      courtCommands.sendBookingNotifications = async (sock, chatId, message) => {
        notifications.push({ chatId, message });
      };

      scvcc.cancelCourtReservation = async () => ({
        success: false,
        message: '⚠️ Could not cancel reservation `195152` (reservation still appears active at SCVCC).'
      });

      // Thu Nov 26, 2026 9:00 AM PST -> Sat Nov 28, 2026 6:00 PM PST (57h; 90% = Sat 12:18 PM PST, before 1:45 PM cutoff)
      const t0 = new Date('2026-11-26T17:00:00.000Z').getTime();
      const playAt = new Date('2026-11-29T02:00:00.000Z').getTime();
      const pollState = {
        remoteJid: TEST_GROUP_JID,
        createdAt: new Date(t0).toISOString(),
        playAt: new Date(playAt).toISOString(),
        options: ['Player 1', 'Player 2', 'Player 3', 'Player 4'],
        size: 4,
        type: 'fixed',
        status: 'active',
        prebookedCourts: [{ court: 'Court 1', player: 'P1' }],
        advanceBookedCourts: [{ court: 'Court 1', reservationId: '195152' }],
        courtReleaseWarningsSent: [70, 80],
        courtReleasesDone: [70, 80],
        invalidSlotVotesNotified: [],
        voteBuffer: new Map()
      };
      const messageStore = new Map([
        [`${TEST_GROUP_JID}:poll_90_fail`, { pollCreationMessage: { options: pollState.options.map((o) => ({ optionName: o })) } }]
      ]);
      const sentGroupMessages = [];
      const mockSock = {
        sendMessage: async (jid, msg) => { sentGroupMessages.push({ jid, msg }); }
      };

      await checkCourtReleasesForPoll(mockSock, 'poll_90_fail', pollState, { messageStore, persistPolls: () => {} }, new Date('2026-11-28T20:25:00.000Z').getTime());

      assert.equal(sentGroupMessages.length, 1);
      assert.match(sentGroupMessages[0].msg.text, /Court 1.*has been cancelled/);
      assert.ok(errorLogs.some((l) => l.includes('Failed to cancel SCVCC reservation 195152') && l.includes('still appears active')));
      assert.equal(notifications.length, 1);
      assert.equal(notifications[0].chatId, TEST_GROUP_JID);
      assert.match(notifications[0].message, /Failed to auto-cancel SCVCC reservation `195152`/);
      assert.match(notifications[0].message, /cancel manually/i);
    });

    it('logs error and notifies notification list when scvcc.cancelCourtReservation throws during releaseAllCourtsForPollState and handleReleasePollCourts', async () => {
      const errorLogs = [];
      console.error = (...args) => errorLogs.push(args.join(' '));

      const notifications = [];
      courtCommands.sendBookingNotifications = async (sock, chatId, message) => {
        notifications.push({ chatId, message });
      };

      scvcc.cancelCourtReservation = async () => {
        throw new Error('Network timeout');
      };

      const mockSock = {
        sendMessage: async () => ({ key: { id: 'msg1' } }),
        groupMetadata: async () => ({ participants: [{ id: 'admin@s.whatsapp.net', admin: 'admin' }] })
      };

      await releaseAllCourtsForPollState(
        mockSock,
        {
          id: 'poll_throw_1',
          remoteJid: TEST_GROUP_JID,
          prebookedCourts: [{ court: 'Court 2', reservationId: '195200' }]
        },
        TEST_GROUP_JID,
        {}
      );

      assert.equal(notifications.length, 1);
      assert.match(notifications[0].message, /Failed to auto-cancel SCVCC reservation `195200`/);
      assert.match(notifications[0].message, /Network timeout/);

      notifications.length = 0;
      const pollId = 'poll_throw_2';
      const activePolls = new Map([[pollId, {
        id: pollId,
        remoteJid: TEST_GROUP_JID,
        when: 'Sunday 9am',
        size: 4,
        status: 'active',
        creator: { name: 'Admin', jid: 'admin@s.whatsapp.net' },
        prebookedCourts: [{ court: 'Court 3', reservationId: '195201' }]
      }]]);

      await handleReleasePollCourts(
        mockSock,
        TEST_GROUP_JID,
        'Admin',
        'admin@s.whatsapp.net',
        '!releasecourt 1',
        { activePolls, recurringPolls: new Map(), latestPollIdByChat: new Map([[TEST_GROUP_JID, pollId]]), persistPolls: () => {} }
      );

      assert.equal(notifications.length, 1);
      assert.match(notifications[0].message, /Failed to auto-cancel SCVCC reservation `195201`/);
      assert.ok(errorLogs.some((l) => l.includes('Failed to cancel SCVCC reservation 195201')));
    });
  });
});
