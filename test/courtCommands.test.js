const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const scvcc = require('../lib/scvcc');
const {
  handleCourtCommand,
  executeCourtTool
} = require('../lib/commands/courtCommands');

describe('courtCommands', () => {
  describe('handleCourtCommand', () => {
    it('should return null for non-court commands', async () => {
      const res = await handleCourtCommand(null, '!help', 'chat@g.us', 'Alice');
      assert.equal(res, null);
    });

    it('should parse !cancelcourt without reservation ID and prompt usage', async () => {
      const res = await handleCourtCommand(null, '!cancelcourt', 'chat@g.us', 'Alice');
      assert.equal(res, null);
    });

    it('should preserve parsed.requester when "for <Player>" is passed in !bookcourt', async () => {
      let passedArgs = null;
      const originalBookCourt = scvcc.bookCourt;
      scvcc.bookCourt = async (args) => {
        passedArgs = args;
        return { success: true, message: 'Booked mock court' };
      };

      try {
        const cmd = '!bookcourt Court 3 10:30am tomorrow for Vijay Parthasarathy with Kejal Patel, Vishal Singh, Gaurav Puri';
        await handleCourtCommand(null, cmd, 'chat@g.us', 'PI');

        assert.ok(passedArgs);
        assert.equal(passedArgs.requester, 'Vijay Parthasarathy');
        assert.equal(passedArgs.requestedBy, 'PI');
        assert.deepEqual(passedArgs.players, ['Kejal Patel', 'Vishal Singh', 'Gaurav Puri']);
      } finally {
        scvcc.bookCourt = originalBookCourt;
      }
    });

    it('should not force sender as requester when 4 players are already listed without "for"', async () => {
      let passedArgs = null;
      const originalBookCourt = scvcc.bookCourt;
      scvcc.bookCourt = async (args) => {
        passedArgs = args;
        return { success: true, message: 'Booked mock court' };
      };

      try {
        const cmd = '!bookcourt Court 3 10:30am tomorrow with Vijay Parthasarathy, Kejal Patel, Vishal Singh, Gaurav Puri';
        await handleCourtCommand(null, cmd, 'chat@g.us', 'PI');

        assert.ok(passedArgs);
        assert.equal(passedArgs.requester, null);
        assert.equal(passedArgs.requestedBy, 'PI');
        assert.deepEqual(passedArgs.players, ['Vijay Parthasarathy', 'Kejal Patel', 'Vishal Singh', 'Gaurav Puri']);
      } finally {
        scvcc.bookCourt = originalBookCourt;
      }
    });

    it('should default requester to sender when fewer than 4 players are listed without "for"', async () => {
      let passedArgs = null;
      const originalBookCourt = scvcc.bookCourt;
      scvcc.bookCourt = async (args) => {
        passedArgs = args;
        return { success: true, message: 'Booked mock court' };
      };

      try {
        const cmd = '!bookcourt Court 3 10:30am tomorrow with Kejal Patel, Vishal Singh, Gaurav Puri';
        await handleCourtCommand(null, cmd, 'chat@g.us', 'PI');

        assert.ok(passedArgs);
        assert.equal(passedArgs.requester, 'PI');
        assert.equal(passedArgs.requestedBy, 'PI');
        assert.deepEqual(passedArgs.players, ['Kejal Patel', 'Vishal Singh', 'Gaurav Puri']);
      } finally {
        scvcc.bookCourt = originalBookCourt;
      }
    });

    it('should handle singular !courtbooking and !booking in group chat', async () => {
      let getBookingsCalled = false;
      const originalGetBookings = scvcc.getCourtBookings;
      scvcc.getCourtBookings = async (args) => {
        getBookingsCalled = true;
        assert.equal(args.chatId, '120363403838804497@g.us');
        return { success: true, message: 'Court bookings list' };
      };

      try {
        const res1 = await handleCourtCommand(null, '!courtbooking tomorrow', '120363403838804497@g.us', 'Alice');
        assert.equal(getBookingsCalled, true);
        assert.equal(res1, 'Court bookings list');

        getBookingsCalled = false;
        const res2 = await handleCourtCommand(null, '!booking tomorrow 6pm', '120363403838804497@g.us', 'Alice');
        assert.equal(getBookingsCalled, true);
        assert.equal(res2, 'Court bookings list');
      } finally {
        scvcc.getCourtBookings = originalGetBookings;
      }
    });

    it('should handle !book and !reserve aliases for court booking in group chat', async () => {
      let bookCalled = false;
      const originalBookCourt = scvcc.bookCourt;
      scvcc.bookCourt = async (args) => {
        bookCalled = true;
        assert.equal(args.chatId, '120363403838804497@g.us');
        assert.equal(args.time, '9am');
        return { success: true, message: 'Court booked successfully' };
      };

      try {
        const res1 = await handleCourtCommand(null, '!book Court 2 9am tomorrow', '120363403838804497@g.us', 'Alice');
        assert.equal(bookCalled, true);
        assert.equal(res1, 'Court booked successfully');

        bookCalled = false;
        const res2 = await handleCourtCommand(null, '!reserve Court 3 9am tomorrow', '120363403838804497@g.us', 'Alice');
        assert.equal(bookCalled, true);
        assert.equal(res2, 'Court booked successfully');
      } finally {
        scvcc.bookCourt = originalBookCourt;
      }
    });
  });

  describe('executeCourtTool', () => {
    it('should return unknown message for unrecognized court tool', async () => {
      const res = await executeCourtTool(null, 'nonexistent_court_tool', {}, 'Alice', 'chat@g.us');
      assert.equal(res, 'Unknown court tool nonexistent_court_tool');
    });
  });

  describe('bookCourt availability filtering', () => {
    it('should return failure when only courts with < 90m availability exist and minAvailableMinutes: 90 is specified', async () => {
      const origCheck = scvcc.checkCourtAvailability;
      scvcc.checkCourtAvailability = async () => ({
        success: true,
        slots: [{
          time: '10:00 AM',
          courts: [
            { court: 'Court 1', status: 'available', availableMinutes: 30, resourceId: '1' },
            { court: 'Court 2', status: 'available', availableMinutes: 60, resourceId: '2' }
          ]
        }]
      });

      try {
        const res = await scvcc.bookCourt({ when: 'tomorrow', time: '10am', minAvailableMinutes: 90 });
        assert.equal(res.success, false);
        assert.match(res.message, /No courts are available at SCVCC/);
      } finally {
        scvcc.checkCourtAvailability = origCheck;
      }
    });

    it('should select court with >= 90m availability when minAvailableMinutes: 90 is specified', async () => {
      const origCheck = scvcc.checkCourtAvailability;
      const origAuthFetch = scvcc.authFetch;
      scvcc.checkCourtAvailability = async () => ({
        success: true,
        slots: [{
          time: '10:00 AM',
          courts: [
            { court: 'Court 1', status: 'available', availableMinutes: 30, resourceId: '1' },
            { court: 'Court 2', status: 'available', availableMinutes: 60, resourceId: '2' },
            { court: 'Court 3', status: 'available', availableMinutes: 90, resourceId: '3' }
          ]
        }]
      });

      let capturedDialogUrl = null;
      scvcc.authFetch = async (url) => {
        capturedDialogUrl = url;
        throw new Error('STOP_AFTER_SELECTION');
      };

      try {
        await scvcc.bookCourt({ when: 'tomorrow', time: '10am', minAvailableMinutes: 90 });
      } catch (err) {
        if (err.message !== 'STOP_AFTER_SELECTION') throw err;
      } finally {
        scvcc.checkCourtAvailability = origCheck;
        scvcc.authFetch = origAuthFetch;
      }

      assert.ok(capturedDialogUrl);
      assert.ok(capturedDialogUrl.includes('resourceID=3'), 'Should have selected Court 3 with 90m availability');
    });

    it('should skip specifically requested court if it has < 90m and pick another court with >= 90m', async () => {
      const origCheck = scvcc.checkCourtAvailability;
      const origAuthFetch = scvcc.authFetch;
      scvcc.checkCourtAvailability = async () => ({
        success: true,
        slots: [{
          time: '10:00 AM',
          courts: [
            { court: 'Court 1', status: 'available', availableMinutes: 60, resourceId: '1' },
            { court: 'Court 2', status: 'available', availableMinutes: 90, resourceId: '2' }
          ]
        }]
      });

      let capturedDialogUrl = null;
      scvcc.authFetch = async (url) => {
        capturedDialogUrl = url;
        throw new Error('STOP_AFTER_SELECTION');
      };

      try {
        await scvcc.bookCourt({ when: 'tomorrow', time: '10am', court: 'Court 1', minAvailableMinutes: 90 });
      } catch (err) {
        if (err.message !== 'STOP_AFTER_SELECTION') throw err;
      } finally {
        scvcc.checkCourtAvailability = origCheck;
        scvcc.authFetch = origAuthFetch;
      }

      assert.ok(capturedDialogUrl);
      assert.ok(capturedDialogUrl.includes('resourceID=2'), 'Should have selected Court 2 with 90m availability instead of Court 1');
    });

    it('should fail when specifically requested court has < 90m and no other court has >= 90m', async () => {
      const origCheck = scvcc.checkCourtAvailability;
      scvcc.checkCourtAvailability = async () => ({
        success: true,
        slots: [{
          time: '10:00 AM',
          courts: [
            { court: 'Court 1', status: 'available', availableMinutes: 60, resourceId: '1' },
            { court: 'Court 2', status: 'available', availableMinutes: 30, resourceId: '2' }
          ]
        }]
      });

      try {
        const res = await scvcc.bookCourt({ when: 'tomorrow', time: '10am', court: 'Court 1', minAvailableMinutes: 90 });
        assert.equal(res.success, false);
      } finally {
        scvcc.checkCourtAvailability = origCheck;
      }
    });
  });

  describe('calculateAvailabilityDuration and supervisor override 90m enforcement', () => {
    it('should terminate availability duration if subsequent slot has a block title (e.g. clinic)', () => {
      const mockGrid = [
        {
          time: '6:30 PM',
          courts: [
            { court: 'Court 5', status: 'unavailable', blockTitle: null, prebookedPlayers: [] }
          ]
        },
        {
          time: '7:00 PM',
          courts: [
            { court: 'Court 5', status: 'booked', blockTitle: '3.0+ Live Ball Clinic', prebookedPlayers: [] }
          ]
        },
        {
          time: '7:30 PM',
          courts: [
            { court: 'Court 5', status: 'booked', blockTitle: '3.0+ Live Ball Clinic', prebookedPlayers: [] }
          ]
        }
      ];

      // With allowOverride: false -> 0m because starting slot is unavailable
      const normalRes = scvcc.calculateAvailabilityDuration(mockGrid, 0, 'Court 5', { allowOverride: false });
      assert.equal(normalRes.minutes, 0);

      // With allowOverride: true -> only 30m because 7:00 PM has clinic block title
      const overrideRes = scvcc.calculateAvailabilityDuration(mockGrid, 0, 'Court 5', { allowOverride: true });
      assert.equal(overrideRes.minutes, 30);
      assert.equal(overrideRes.durationLabel, '30 minutes');
    });

    it('should terminate availability duration if subsequent slot has players assigned', () => {
      const mockGrid = [
        {
          time: '6:30 PM',
          courts: [
            { court: 'Court 5', status: 'unavailable', blockTitle: null, prebookedPlayers: [] }
          ]
        },
        {
          time: '7:00 PM',
          courts: [
            { court: 'Court 5', status: 'booked', blockTitle: null, prebookedPlayers: ['John Doe'] }
          ]
        }
      ];

      const overrideRes = scvcc.calculateAvailabilityDuration(mockGrid, 0, 'Court 5', { allowOverride: true });
      assert.equal(overrideRes.minutes, 30);
    });

    it('should return 90 minutes when 3 consecutive slots are unblocked with no title and no players', () => {
      const mockGrid = [
        {
          time: '6:30 PM',
          courts: [
            { court: 'Court 5', status: 'unavailable', blockTitle: null, prebookedPlayers: [] }
          ]
        },
        {
          time: '7:00 PM',
          courts: [
            { court: 'Court 5', status: 'unavailable', blockTitle: null, prebookedPlayers: [] }
          ]
        },
        {
          time: '7:30 PM',
          courts: [
            { court: 'Court 5', status: 'unavailable', blockTitle: null, prebookedPlayers: [] }
          ]
        }
      ];

      const overrideRes = scvcc.calculateAvailabilityDuration(mockGrid, 0, 'Court 5', { allowOverride: true });
      assert.equal(overrideRes.minutes, 90);
      assert.equal(overrideRes.durationLabel, '90 minutes');
    });

    it('bookCourt should reject specifically requested court if only 30m is available before clinic and minAvailableMinutes is 90', async () => {
      const origCheck = scvcc.checkCourtAvailability;
      scvcc.checkCourtAvailability = async () => ({
        success: true,
        slots: [{
          time: '6:30 PM',
          courts: [
            {
              court: 'Court 5',
              status: 'unavailable',
              availableMinutes: 0,
              overrideAvailableMinutes: 30, // only 30m before clinic
              blockTitle: null,
              prebookedPlayers: [],
              resourceId: '5'
            }
          ]
        }]
      });

      try {
        const res = await scvcc.bookCourt({
          when: 'tomorrow',
          time: '6:30pm',
          court: 'Court 5',
          minAvailableMinutes: 90
        });
        assert.equal(res.success, false);
        assert.match(res.message, /No courts are available at SCVCC/);
      } finally {
        scvcc.checkCourtAvailability = origCheck;
      }
    });

    it('bookCourt should book via supervisor override when court has 90m unblocked with no title and no players', async () => {
      const origCheck = scvcc.checkCourtAvailability;
      const origAuthFetch = scvcc.authFetch;
      scvcc.checkCourtAvailability = async () => ({
        success: true,
        slots: [{
          time: '6:30 PM',
          courts: [
            {
              court: 'Court 5',
              status: 'unavailable',
              availableMinutes: 0,
              overrideAvailableMinutes: 90, // full 90m unblocked
              blockTitle: null,
              prebookedPlayers: [],
              resourceId: '5'
            }
          ]
        }]
      });

      let capturedDialogUrl = null;
      scvcc.authFetch = async (url) => {
        capturedDialogUrl = url;
        throw new Error('STOP_AFTER_SELECTION');
      };

      try {
        await scvcc.bookCourt({
          when: 'tomorrow',
          time: '6:30pm',
          court: 'Court 5',
          minAvailableMinutes: 90
        });
      } catch (err) {
        if (err.message !== 'STOP_AFTER_SELECTION') throw err;
      } finally {
        scvcc.checkCourtAvailability = origCheck;
        scvcc.authFetch = origAuthFetch;
      }

      assert.ok(capturedDialogUrl);
      assert.ok(capturedDialogUrl.includes('resourceID=5'), 'Should select Court 5 when 90m unblocked is available');
    });

    it('bookCourt should never use supervisor override if slot has a block title (booked by somebody else)', async () => {
      const origCheck = scvcc.checkCourtAvailability;
      scvcc.checkCourtAvailability = async () => ({
        success: true,
        slots: [{
          time: '6:30 PM',
          courts: [
            {
              court: 'Court 5',
              status: 'unavailable',
              availableMinutes: 0,
              overrideAvailableMinutes: 0,
              blockTitle: 'Tennis Clinic',
              prebookedPlayers: [],
              resourceId: '5'
            }
          ]
        }]
      });

      try {
        const res = await scvcc.bookCourt({
          when: 'tomorrow',
          time: '6:30pm',
          court: 'Court 5',
          minAvailableMinutes: 90
        });
        assert.equal(res.success, false);
      } finally {
        scvcc.checkCourtAvailability = origCheck;
      }
    });
  });

    describe('getCourtBookings spanning multi-slot reservations', () => {
    it('should show courts spanning across the entire duration in all 30m slots', async () => {
      const origAuthFetch = scvcc.authFetch;
      const testChatId = '120363403838804497@g.us';

      const mockHtml = `
        <tr>
          <td><div class="tscell">6:30 PM</div></td>
          <td rowspan="3">
            <div class="ncCourtNum">Court 2</div>
            <img title="Doubles" />
            <div class="playerName" title="Immaneni, Pramod">Pramod Immaneni</div>
          </td>
        </tr>
        <tr>
          <td><div class="tscell">7:00 PM</div></td>
          <td><div class="ncCourtNum">Court 1</div><div class="blockTitle">Blocked</div></td>
        </tr>
        <tr>
          <td><div class="tscell">7:30 PM</div></td>
          <td><div class="ncCourtNum">Court 1</div><div class="blockTitle">Blocked</div></td>
        </tr>
        <tr>
          <td><div class="tscell">8:00 PM</div></td>
          <td><div class="ncCourtNum">Court 1</div><div class="blockTitle">Blocked</div></td>
        </tr>
      `;

      scvcc.authFetch = async () => ({
        ok: true,
        text: async () => mockHtml
      });

      try {
        const res = await scvcc.getCourtBookings({ when: 'today', chatId: testChatId });
        assert.ok(res.success);

        const ct2At630 = res.bookings.find(b => b.court === 'Court 2' && b.time === '6:30 PM');
        const ct2At700 = res.bookings.find(b => b.court === 'Court 2' && b.time === '7:00 PM');
        const ct2At730 = res.bookings.find(b => b.court === 'Court 2' && b.time === '7:30 PM');
        const ct2At800 = res.bookings.find(b => b.court === 'Court 2' && b.time === '8:00 PM');

        assert.ok(ct2At630, 'Court 2 should be present at 6:30 PM');
        assert.ok(ct2At700, 'Court 2 should be present at 7:00 PM');
        assert.ok(ct2At730, 'Court 2 should be present at 7:30 PM');
        assert.ok(!ct2At800, 'Court 2 should NOT be present at 8:00 PM');

        assert.ok(res.message.includes('Court 2'));
        assert.ok(res.message.includes('Booked: PI'));
      } finally {
        scvcc.authFetch = origAuthFetch;
      }
    });
  });

  describe('pause and resume court bookings', () => {
    const groupsConfig = require('../lib/groupsConfig');
    const origConfig = JSON.parse(JSON.stringify(groupsConfig.loadRawConfig() || {}));
    const origIsSuper = groupsConfig.isSuperAdmin;
    const testChatId = '120363403838804497@g.us';
    const adminUser = '11111@s.whatsapp.net';
    const regularUser = '22222@s.whatsapp.net';
    const superUser = '99999@s.whatsapp.net';

    const mockSock = {
      groupMetadata: async (jid) => ({
        id: jid,
        subject: 'Bot-testing',
        participants: [
          { id: adminUser, admin: 'admin' },
          { id: regularUser, admin: null }
        ]
      })
    };

    function setupMocks() {
      groupsConfig.isSuperAdmin = (jid) => jid === superUser;
    }

    function teardownMocks() {
      groupsConfig.isSuperAdmin = origIsSuper;
      groupsConfig.saveRawConfig(origConfig);
      const namesStore = require('../lib/names');
      if (typeof namesStore.getGroupMembers === 'function') {
        const gm = namesStore.getGroupMembers(testChatId);
        if (gm) gm.clear();
      }
    }

    it('should reject non-admin from pausing court bookings for a group', async () => {
      setupMocks();
      try {
        const res = await handleCourtCommand(mockSock, '!pausecourtbookings', testChatId, 'Regular', regularUser);
        assert.match(res, /Only group admins or the bot superadmin can pause court bookings/);
      } finally {
        teardownMocks();
      }
    });

    it('should reject non-admin from resuming court bookings for a group', async () => {
      setupMocks();
      try {
        const res = await handleCourtCommand(mockSock, '!resumecourtbookings', testChatId, 'Regular', regularUser);
        assert.match(res, /Only group admins or the bot superadmin can resume court bookings/);
      } finally {
        teardownMocks();
      }
    });

    it('should reject non-superadmin from pausing all groups', async () => {
      setupMocks();
      try {
        const res = await handleCourtCommand(mockSock, '!pausecourtbookings all', testChatId, 'Admin', adminUser);
        assert.match(res, /Only the bot superadmin can pause court bookings for all groups/);

        const res2 = await handleCourtCommand(mockSock, '!pauseallcourtbookings', testChatId, 'Admin', adminUser);
        assert.match(res2, /Only the bot superadmin can pause court bookings for all groups/);
      } finally {
        teardownMocks();
      }
    });

    it('should reject non-superadmin from resuming all groups', async () => {
      setupMocks();
      try {
        const res = await handleCourtCommand(mockSock, '!resumecourtbookings all', testChatId, 'Admin', adminUser);
        assert.match(res, /Only the bot superadmin can resume court bookings for all groups/);

        const res2 = await handleCourtCommand(mockSock, '!resumeallcourtbookings', testChatId, 'Admin', adminUser);
        assert.match(res2, /Only the bot superadmin can resume court bookings for all groups/);
      } finally {
        teardownMocks();
      }
    });

    it('should allow group admin to pause court bookings for current group', async () => {
      setupMocks();
      try {
        const res = await handleCourtCommand(mockSock, '!pausecourtbookings', testChatId, 'Admin', adminUser);
        assert.match(res, /Court bookings paused for/);
        const cfg = groupsConfig.loadRawConfig();
        assert.equal(cfg.groups[testChatId].courtBookingEnabled, false);
      } finally {
        teardownMocks();
      }
    });

    it('should allow group admin to resume court bookings for current group', async () => {
      setupMocks();
      try {
        const res = await handleCourtCommand(mockSock, '!resumecourtbookings', testChatId, 'Admin', adminUser);
        assert.match(res, /Court bookings resumed for/);
        const cfg = groupsConfig.loadRawConfig();
        assert.equal(cfg.groups[testChatId].courtBookingEnabled, true);
      } finally {
        teardownMocks();
      }
    });

    it('should allow superadmin to pause court bookings across all groups with a single command', async () => {
      setupMocks();
      try {
        const res = await handleCourtCommand(mockSock, '!pauseallcourtbookings', testChatId, 'Super', superUser);
        assert.match(res, /Court bookings paused for all groups/);
        const cfg = groupsConfig.loadRawConfig();
        assert.equal(cfg.defaults.courtBookingEnabled, false);
        for (const g of Object.values(cfg.groups)) {
          assert.equal(g.courtBookingEnabled, false);
        }
      } finally {
        teardownMocks();
      }
    });

    it('should allow superadmin to resume court bookings across all groups with a single command', async () => {
      setupMocks();
      try {
        const res = await handleCourtCommand(mockSock, '!resumeallcourtbookings', testChatId, 'Super', superUser);
        assert.match(res, /Court bookings resumed for all groups/);
        const cfg = groupsConfig.loadRawConfig();
        assert.equal(cfg.defaults.courtBookingEnabled, true);
        for (const g of Object.values(cfg.groups)) {
          assert.equal(g.courtBookingEnabled, true);
        }
      } finally {
        teardownMocks();
      }
    });

    it('should handle pause_court_bookings and resume_court_bookings tools', async () => {
      setupMocks();
      try {
        // Group admin tool execution
        const resAdminPause = await executeCourtTool(mockSock, 'pause_court_bookings', { group: testChatId }, 'Admin', testChatId, adminUser);
        assert.match(resAdminPause, /Court bookings paused for/);

        const resAdminResume = await executeCourtTool(mockSock, 'resume_court_bookings', { group: testChatId }, 'Admin', testChatId, adminUser);
        assert.match(resAdminResume, /Court bookings resumed for/);

        // Non-admin tool execution rejected
        const resNonAdmin = await executeCourtTool(mockSock, 'pause_court_bookings', { group: testChatId }, 'Regular', testChatId, regularUser);
        assert.match(resNonAdmin, /Only group admins or the bot superadmin can pause court bookings/);

        // Superadmin all groups tool execution
        const resSuperPause = await executeCourtTool(mockSock, 'pause_court_bookings', { all: true }, 'Super', testChatId, superUser);
        assert.match(resSuperPause, /Court bookings paused for all groups/);

        const resSuperResume = await executeCourtTool(mockSock, 'resume_court_bookings', { all: true }, 'Super', testChatId, superUser);
        assert.match(resSuperResume, /Court bookings resumed for all groups/);
      } finally {
        teardownMocks();
      }
    });
  });

  describe("court webcam (!webcam)", () => {
    const origGetWebcam = scvcc.getCourtWebcamSnapshot;
    const origGetClip = scvcc.getCourtWebcamClip;
    const testChatId = "120363403838804497@g.us";

    function restore() {
      scvcc.getCourtWebcamSnapshot = origGetWebcam;
      scvcc.getCourtWebcamClip = origGetClip;
    }

    it("should return a photo snapshot object for !webcam by default without player links", async () => {
      const mockImageBuf = Buffer.from("fake-jpeg-image-bytes");
      scvcc.getCourtWebcamSnapshot = async () => ({
        success: true,
        imageBuffer: mockImageBuf,
        playerUrl: "https://g1.ipcamlive.com/player/player.php?alias=5ca7b2391ca5e&autoplay=1"
      });

      try {
        const res = await handleCourtCommand(null, "!webcam", testChatId, "Alice");
        assert.ok(typeof res === "object" && res !== null, "Should return media object so routeCommand does not fall through");
        assert.equal(res.image, mockImageBuf);
        assert.match(res.caption, /SCVCC Tennis Court Webcam/);
        assert.equal(res.caption.includes("player.php"), false, "Should NOT include player link");
        assert.equal(res.caption.includes("Live Player"), false, "Should NOT include player link");

        const resCam = await handleCourtCommand(null, "!camera", testChatId, "Alice");
        assert.ok(typeof resCam === "object" && resCam !== null);
        assert.equal(resCam.image, mockImageBuf);
      } finally {
        restore();
      }
    });

    it("should return a 10s video clip object when video option is requested (!webcam video)", async () => {
      const mockVideoBuf = Buffer.from("fake-mp4-video-bytes");
      scvcc.getCourtWebcamClip = async (duration) => ({
        success: true,
        videoBuffer: mockVideoBuf,
        duration: 10,
        playerUrl: "https://g1.ipcamlive.com/player/player.php?alias=5ca7b2391ca5e&autoplay=1"
      });

      try {
        const res = await handleCourtCommand(null, "!webcam video", testChatId, "Alice");
        assert.ok(typeof res === "object" && res !== null, "Should return media object so routeCommand does not fall through");
        assert.equal(res.video, mockVideoBuf);
        assert.equal(res.mimetype, "video/mp4");
        assert.match(res.caption, /SCVCC Tennis Court Webcam \(10s clip\)/);
        assert.equal(res.caption.includes("player.php"), false, "Should NOT include player link");
        assert.equal(res.caption.includes("Live Player"), false, "Should NOT include player link");

        const resClip = await handleCourtCommand(null, "!camera clip", testChatId, "Alice");
        assert.ok(typeof resClip === "object" && resClip !== null);
        assert.equal(resClip.video, mockVideoBuf);
      } finally {
        restore();
      }
    });

    it("should reject webcam command when court booking is disabled for group", async () => {
      const groupsConfig = require("../lib/groupsConfig");
      const origIsCourtBookingEnabled = groupsConfig.isCourtBookingEnabled;
      groupsConfig.isCourtBookingEnabled = () => false;
      try {
        const res = await handleCourtCommand(null, "!webcam", testChatId, "Alice");
        assert.match(res, /Court webcam and booking functionality is not enabled/);
      } finally {
        groupsConfig.isCourtBookingEnabled = origIsCourtBookingEnabled;
      }
    });

    it("should handle get_court_webcam tool execution defaulting to photo and sending video when requested", async () => {
      const mockImageBuf = Buffer.from("tool-image-bytes");
      const mockVideoBuf = Buffer.from("tool-video-bytes");
      scvcc.getCourtWebcamSnapshot = async () => ({
        success: true,
        imageBuffer: mockImageBuf,
        playerUrl: "https://g1.ipcamlive.com/player/player.php?alias=5ca7b2391ca5e&autoplay=1"
      });
      scvcc.getCourtWebcamClip = async (duration) => ({
        success: true,
        videoBuffer: mockVideoBuf,
        duration: 10,
        playerUrl: "https://g1.ipcamlive.com/player/player.php?alias=5ca7b2391ca5e&autoplay=1"
      });

      try {
        const sentMessages = [];
        const mockSock = {
          sendMessage: async (jid, content) => {
            sentMessages.push({ jid, content });
            return { key: { id: "msg-tool-" + sentMessages.length } };
          }
        };

        // Default tool call -> photo snapshot
        const toolResDefault = await executeCourtTool(mockSock, "get_court_webcam", {}, "Alice", testChatId);
        assert.match(toolResDefault, /Live court webcam photo snapshot has been sent to the chat/);
        assert.equal(toolResDefault.includes("player.php"), false, "Should NOT include player link in tool output");
        assert.equal(sentMessages.length, 1);
        assert.equal(sentMessages[0].content.image, mockImageBuf);
        assert.equal(sentMessages[0].content.caption.includes("player.php"), false);

        // format: video tool call -> 10s video clip
        const toolResVideo = await executeCourtTool(mockSock, "get_court_webcam", { format: "video" }, "Alice", testChatId);
        assert.match(toolResVideo, /Live 10-second court webcam video clip has been sent to the chat/);
        assert.equal(toolResVideo.includes("player.php"), false, "Should NOT include player link in tool output");
        assert.equal(sentMessages.length, 2);
        assert.equal(sentMessages[1].content.video, mockVideoBuf);
        assert.equal(sentMessages[1].content.caption.includes("player.php"), false);
      } finally {
        restore();
      }
    });
  });

  describe("checkCourtAvailability untitled blocked courts (⚪)", () => {
    const origAuthFetch = scvcc.authFetch;
    const testChatId = "120363403838804497@g.us";

    const buildMockSheetHtml = () => `
      <tr>
        <td><div class="tscell">6:30 PM</div></td>
        <td class="rbm_TimeSlotPanelSlotAvailable"><div class="ncCourtNum">Court 1</div></td>
        <td rowspan="3">
          <div class="ncCourtNum">Court 2</div>
          <img title="Doubles" />
          <div class="playerName" title="Immaneni, Pramod">Pramod Immaneni</div>
        </td>
        <td><div class="ncCourtNum">Court 3</div><div class="blockTitle">3.0+ Live Ball Clinic</div></td>
        <td><div class="ncCourtNum">Court 5</div></td>
        <td><div class="ncCourtNum">Court 6</div><div class="playerName" title="Doe, John">John Doe</div></td>
      </tr>
      <tr>
        <td><div class="tscell">7:00 PM</div></td>
        <td class="rbm_TimeSlotPanelSlotAvailable"><div class="ncCourtNum">Court 1</div></td>
        <td><div class="ncCourtNum">Court 3</div><div class="blockTitle">3.0+ Live Ball Clinic</div></td>
        <td><div class="ncCourtNum">Court 5</div></td>
        <td><div class="ncCourtNum">Court 6</div><div class="playerName" title="Doe, John">John Doe</div></td>
      </tr>
      <tr>
        <td><div class="tscell">7:30 PM</div></td>
        <td class="rbm_TimeSlotPanelSlotAvailable"><div class="ncCourtNum">Court 1</div></td>
        <td><div class="ncCourtNum">Court 3</div><div class="blockTitle">3.0+ Live Ball Clinic</div></td>
        <td><div class="ncCourtNum">Court 5</div></td>
        <td><div class="ncCourtNum">Court 6</div><div class="playerName" title="Doe, John">John Doe</div></td>
      </tr>
    `;

    it("should include untitled blocked courts with ⚪ icon in specific time queries while excluding titled blocked courts", async () => {
      const namesStore = require('../lib/names');
      namesStore.addGroupMember(testChatId, { id: '90611059302558@lid', name: 'PI', fullName: 'Pramod Immaneni' });
      scvcc.authFetch = async () => ({
        ok: true,
        text: async () => buildMockSheetHtml()
      });

      try {
        const res = await scvcc.checkCourtAvailability({
          when: "today",
          time: "6:30pm",
          chatId: testChatId
        });
        assert.equal(res.success, true);
        assert.match(res.message, /🟢 \*Court 1\* \(90 minutes\)/);
        assert.match(res.message, /🔵 \*Court 2\* \(Booked: PI, 90m\)/);
        assert.match(res.message, /⚪ \*Court 5\* \(Blocked: 90 minutes\)/);
        assert.equal(res.message.includes("Court 3"), false, "Titled blocked court (Clinic) should not be listed");
        assert.equal(res.message.includes("Court 6"), false, "Other member booked court should not be listed");
      } finally {
        scvcc.authFetch = origAuthFetch;
      }
    });

    it("should include untitled blocked courts with ⚪ icon in multi-slot queries", async () => {
      const namesStore = require('../lib/names');
      namesStore.addGroupMember(testChatId, { id: '90611059302558@lid', name: 'PI', fullName: 'Pramod Immaneni' });
      scvcc.authFetch = async () => ({
        ok: true,
        text: async () => buildMockSheetHtml()
      });

      try {
        const res = await scvcc.checkCourtAvailability({
          when: "today",
          time: "evening",
          chatId: testChatId
        });
        assert.equal(res.success, true);
        assert.match(res.message, /• \*6:30 PM\*: 🟢 Court 1 \(90m\) \| 🔵 Court 2 \(Booked: PI, 90m\) \| ⚪ Court 5 \(Blocked: 90m\)/);
        assert.equal(res.message.includes("Court 3"), false);
        assert.equal(res.message.includes("Court 6"), false);
      } finally {
        scvcc.authFetch = origAuthFetch;
      }
    });
  });

  describe("club closed detection in SCVCC availability, bookings, and bookCourt", () => {
    const testChatId = "120363403838804497@g.us";
    const groupsConfig = require("../lib/groupsConfig");

    it("should detect club closed from court sheet blockTitle, zero durations, and prevent preceding slot override from spanning in", async () => {
      const origGetGroupConfig = groupsConfig.getGroupConfig;
      const origAuthFetch = scvcc.authFetch;
      const closedHtml = `
        <table>
          <tr>
            <td><div class="tscell">6:00 PM</div></td>
            <td class="rbm_TimeSlotPanelSlotAvailable"><div class="ncCourtNum">Court 1</div></td>
            <td class="openResSectionBlocked"><div class="ncCourtNum">Court 2</div></td>
          </tr>
          <tr>
            <td><div class="tscell">6:30 PM</div></td>
            <td class="openResSectionBlocked"><div class="ncCourtNum">Court 1</div><div class="blockTitle">Club Closed - Holiday</div></td>
            <td class="openResSectionBlocked"><div class="ncCourtNum">Court 2</div></td>
          </tr>
          <tr>
            <td><div class="tscell">7:00 PM</div></td>
            <td class="rbm_TimeSlotPanelSlotAvailable"><div class="ncCourtNum">Court 1</div></td>
            <td class="rbm_TimeSlotPanelSlotAvailable"><div class="ncCourtNum">Court 2</div></td>
          </tr>
        </table>
      `;

      groupsConfig.getGroupConfig = () => ({
        name: "Test",
        sport: "tennis",
        courtBookingEnabled: true,
        clubClosedTitles: ["/^Club Closed/i"]
      });
      scvcc.authFetch = async () => ({
        ok: true,
        text: async () => closedHtml
      });

      try {
        // 1. Direct query at closed slot 6:30 PM
        const closedRes = await scvcc.checkCourtAvailability({
          when: "today",
          time: "6:30pm",
          chatId: testChatId
        });
        assert.equal(closedRes.success, true);
        assert.equal(closedRes.clubClosed, true);
        assert.equal(closedRes.clubClosedTitle, "Club Closed - Holiday");
        assert.equal(closedRes.totalAvailable, 0);
        assert.equal(closedRes.totalBlocked, 0);
        assert.match(closedRes.message, /🚫 \*Club Closed\*: Club Closed - Holiday/);

        // 2. Query at 6:00 PM should NOT extend into closed 6:30 PM slot (overrideAvailableMinutes <= 30)
        const earlierRes = await scvcc.checkCourtAvailability({
          when: "today",
          time: "6:00pm",
          chatId: testChatId
        });
        assert.equal(earlierRes.clubClosed, false);
        const court2At6 = earlierRes.slots[0].courts.find((c) => c.court === "Court 2");
        assert.equal(court2At6.overrideAvailableMinutes, 30);

        // 3. getCourtBookings should tag the closed booking and closedTimes
        const bookingsRes = await scvcc.getCourtBookings({
          when: "today",
          time: "6:30pm",
          chatId: testChatId
        });
        assert.equal(bookingsRes.clubClosed, true);
        assert.equal(bookingsRes.clubClosedTitle, "Club Closed - Holiday");
        assert.ok(bookingsRes.closedTimes.some((ct) => ct.time === "6:30 PM"));

        // 4. scvcc.bookCourt must refuse to book when club is closed without opening booking dialog
        const bookRes = await scvcc.bookCourt({
          when: "today",
          time: "6:30pm",
          chatId: testChatId,
          minAvailableMinutes: 90
        });
        assert.equal(bookRes.success, false);
        assert.equal(bookRes.clubClosed, true);
        assert.equal(bookRes.clubClosedTitle, "Club Closed - Holiday");
        assert.match(bookRes.message, /Club is closed/i);
      } finally {
        groupsConfig.getGroupConfig = origGetGroupConfig;
        scvcc.authFetch = origAuthFetch;
      }
    });

    it("should reject scvcc.bookCourt immediately on mocked club-closed availability", async () => {
      const origCheck = scvcc.checkCourtAvailability;
      const origGetGroupConfig = groupsConfig.getGroupConfig;
      groupsConfig.getGroupConfig = () => ({
        name: "Test",
        sport: "tennis",
        courtBookingEnabled: true,
        clubClosedTitles: ["Holiday Closure"]
      });
      scvcc.checkCourtAvailability = async () => ({
        success: true,
        slots: [{
          time: "10:00 AM",
          courts: [
            { court: "Court 1", status: "booked", blockTitle: "Holiday Closure", availableMinutes: 0 }
          ]
        }]
      });

      try {
        const res = await scvcc.bookCourt({ when: "tomorrow", time: "10am", chatId: testChatId });
        assert.equal(res.success, false);
        assert.equal(res.clubClosed, true);
        assert.equal(res.clubClosedTitle, "Holiday Closure");
      } finally {
        scvcc.checkCourtAvailability = origCheck;
        groupsConfig.getGroupConfig = origGetGroupConfig;
      }
    });
  });

  describe('!bookcourt for Poll ID', () => {
    const groupsConfig = require('../lib/groupsConfig');
    const { parseBookPollCourtsArgs } = require('../lib/commands/poll');
    const testChatId = '120363999888777666@g.us';
    const adminJid = 'admin@s.whatsapp.net';
    const creatorJid = 'creator@s.whatsapp.net';
    const memberJid = 'member@s.whatsapp.net';

    function setupEnv() {
      const origBookCourt = scvcc.bookCourt;
      const origIsEnabled = groupsConfig.isCourtBookingEnabled;
      const origGetCfg = groupsConfig.getGroupConfig;
      const origGetPref = groupsConfig.getBookingCourtPreference;
      const origGetPlayers = groupsConfig.getDefaultBookingPlayers;
      const origGetNotifs = groupsConfig.getBookingNotifications;
      const origGetNotifications = groupsConfig.getNotifications;
      const origIsSuper = groupsConfig.isSuperAdmin;
      const origIsAllowed = groupsConfig.isGroupAllowed;
      const origGetGroupJid = groupsConfig.getGroupJid;

      groupsConfig.isCourtBookingEnabled = () => true;
      groupsConfig.getGroupConfig = () => ({ name: 'Sat Tennis', sport: 'tennis', courtBookingEnabled: true, maxCourts: 2 });
      groupsConfig.getBookingCourtPreference = () => [];
      groupsConfig.getDefaultBookingPlayers = () => ['Alice', 'Bob', 'Charlie', 'Dave'];
      groupsConfig.getBookingNotifications = () => [];
      groupsConfig.getNotifications = () => [];
      groupsConfig.isSuperAdmin = () => false;
      groupsConfig.isGroupAllowed = (jid) => jid === testChatId;
      groupsConfig.getGroupJid = (q) => (q && q.toLowerCase() === 'sat tennis' ? testChatId : null);

      return () => {
        scvcc.bookCourt = origBookCourt;
        groupsConfig.isCourtBookingEnabled = origIsEnabled;
        groupsConfig.getGroupConfig = origGetCfg;
        groupsConfig.getBookingCourtPreference = origGetPref;
        groupsConfig.getDefaultBookingPlayers = origGetPlayers;
        groupsConfig.getBookingNotifications = origGetNotifs;
        groupsConfig.getNotifications = origGetNotifications;
        groupsConfig.isSuperAdmin = origIsSuper;
        groupsConfig.isGroupAllowed = origIsAllowed;
        groupsConfig.getGroupJid = origGetGroupJid;
      };
    }

    function createMockSock(sentMessages = []) {
      return {
        user: { id: 'tenbot@s.whatsapp.net' },
        groupMetadata: async () => ({
          participants: [
            { id: adminJid, admin: 'admin' },
            { id: creatorJid, admin: null },
            { id: memberJid, admin: null }
          ]
        }),
        sendMessage: async (jid, payload) => {
          sentMessages.push({ jid, payload });
          return { key: { id: `msg_${sentMessages.length}`, remoteJid: jid } };
        }
      };
    }

    it('should parse poll-based !bookcourt args and ignore direct court booking args', () => {
      assert.deepEqual(parseBookPollCourtsArgs('poll_123'), { target: 'poll_123', mode: 'votes', count: null });
      assert.deepEqual(parseBookPollCourtsArgs('poll_123 all'), { target: 'poll_123', mode: 'all', count: null });
      assert.deepEqual(parseBookPollCourtsArgs('all poll_123'), { target: 'poll_123', mode: 'all', count: null });
      assert.deepEqual(parseBookPollCourtsArgs('poll_123 2'), { target: 'poll_123', mode: 'count', count: 2 });
      assert.deepEqual(parseBookPollCourtsArgs('3 session_abc'), { target: 'session_abc', mode: 'count', count: 3 });
      assert.deepEqual(parseBookPollCourtsArgs('rec_1 all'), { target: 'rec_1', mode: 'all', count: null });
      assert.deepEqual(parseBookPollCourtsArgs('3EB01234567890AB'), { target: '3EB01234567890AB', mode: 'votes', count: null });

      // Direct booking inputs must return null so normal !bookcourt flow handles them
      assert.equal(parseBookPollCourtsArgs('Court 2 9am tomorrow'), null);
      assert.equal(parseBookPollCourtsArgs('6pm tomorrow with Alice, Bob'), null);
      assert.equal(parseBookPollCourtsArgs('tomorrow'), null);
      assert.equal(parseBookPollCourtsArgs('all'), null);
      assert.equal(parseBookPollCourtsArgs('2'), null);
    });

    it('should book Math.ceil(votes / 4) - booked courts when only pollId is specified', async () => {
      const restore = setupEnv();
      const bookCalls = [];
      let persisted = false;
      let nextCourtNum = 2;
      scvcc.bookCourt = async (args) => {
        bookCalls.push(args);
        const c = `Court ${nextCourtNum++}`;
        return { success: true, court: c, date: args.when, time: '9:00 AM', reservationId: `200${nextCourtNum}`, players: args.players };
      };

      const voteBuffer = new Map();
      for (let i = 1; i <= 9; i++) {
        voteBuffer.set(`voter${i}@s.whatsapp.net`, { vote: {} });
      }
      const pollId = 'poll_votes_1';
      const pollState = {
        id: pollId,
        name: '🎾 Saturday 9am (12 spots) - Court 1 - Booked',
        when: 'Saturday 9am',
        queryTime: '9:00am',
        targetDateMDY: '11/28/2026',
        size: 12,
        slotLimit: 8,
        status: 'active',
        remoteJid: testChatId,
        creator: { name: 'Creator', jid: creatorJid },
        prebookedCourts: [{ court: 'Court 1', player: 'Creator', bookingType: 'auto' }],
        advanceBookedCourts: [{ court: 'Court 1', reservationId: '1001', time: '9:00 AM' }],
        autoBookedCourts: [{ court: 'Court 1', reservationId: '1001', time: '9:00 AM' }],
        releasedCourts: [{ court: 'Court 2', time: '9:00 AM' }, { court: 'Court 3', time: '9:00 AM' }],
        voteBuffer
      };
      const context = {
        activePolls: new Map([[pollId, pollState]]),
        recurringPolls: new Map(),
        persistPolls: () => { persisted = true; }
      };

      try {
        const sock = createMockSock();
        const res = await handleCourtCommand(sock, `!bookcourt ${pollId}`, testChatId, 'Creator', creatorJid, null, context);
        // 9 votes / 4 = ceil(2.25) = 3 courts; 1 booked -> books 2 additional courts
        assert.equal(bookCalls.length, 2);
        assert.equal(persisted, true);
        assert.equal(pollState.prebookedCourts.length, 3);
        assert.equal(pollState.releasedCourts.length, 0);
        assert.equal(pollState.slotLimit, undefined);
        assert.match(res, /Booked 2 additional court\(s\)/);
        assert.match(res, /Total courts for poll: \*3\* \(12 player spots\)/);
      } finally {
        restore();
      }
    });

    it('should use 2 players per court for Singles polls', async () => {
      const restore = setupEnv();
      const bookCalls = [];
      scvcc.bookCourt = async (args) => {
        bookCalls.push(args);
        return { success: true, court: 'Court 4', date: args.when, time: '10:00 AM', reservationId: '3001', players: args.players };
      };

      const voteBuffer = new Map([
        ['v1@s.whatsapp.net', { vote: {} }],
        ['v2@s.whatsapp.net', { vote: {} }]
      ]);
      const pollId = 'poll_singles_1';
      const pollState = {
        id: pollId,
        when: 'Sunday 10am',
        queryTime: '10:00am',
        targetDateMDY: '11/29/2026',
        size: 2,
        courtBookingType: 'singles',
        status: 'active',
        remoteJid: testChatId,
        creator: { name: 'Creator', jid: creatorJid },
        prebookedCourts: [],
        voteBuffer
      };
      const context = { activePolls: new Map([[pollId, pollState]]), recurringPolls: new Map() };

      try {
        const res = await handleCourtCommand(createMockSock(), `!book ${pollId}`, testChatId, 'Admin', adminJid, null, context);
        assert.equal(bookCalls.length, 1);
        assert.equal(bookCalls[0].players.length, 2);
        assert.match(res, /Booked 1 additional court\(s\)/);
        assert.match(res, /2 player spots/);
      } finally {
        restore();
      }
    });

    it('should aggregate deduplicated votes across split-poll siblings and sync state across parts', async () => {
      const restore = setupEnv();
      const bookCalls = [];
      let nextCourt = 3;
      scvcc.bookCourt = async (args) => {
        bookCalls.push(args);
        const c = `Court ${nextCourt++}`;
        return { success: true, court: c, date: args.when, time: '8:00 AM', reservationId: `400${nextCourt}`, players: args.players };
      };

      const vb1 = new Map();
      for (let i = 1; i <= 9; i++) vb1.set(`p${i}@s.whatsapp.net`, { vote: {} });
      const vb2 = new Map();
      for (let i = 10; i <= 13; i++) vb2.set(`p${i}@s.whatsapp.net`, { vote: {} });

      const sessionId = 'session_split_1';
      const part1 = {
        id: 'poll_part_1',
        parentPollId: sessionId,
        partNumber: 1,
        sessionTotalSize: 16,
        size: 12,
        when: 'Saturday 8am',
        queryTime: '8:00am',
        targetDateMDY: '11/28/2026',
        status: 'active',
        remoteJid: testChatId,
        creator: { name: 'Creator', jid: creatorJid },
        prebookedCourts: [{ court: 'Court 1' }, { court: 'Court 2' }],
        releasedCourts: [{ court: 'Court 3' }, { court: 'Court 4' }],
        voteBuffer: vb1
      };
      const part2 = {
        id: 'poll_part_2',
        parentPollId: sessionId,
        partNumber: 2,
        sessionTotalSize: 16,
        size: 4,
        when: 'Saturday 8am',
        queryTime: '8:00am',
        targetDateMDY: '11/28/2026',
        status: 'filled',
        remoteJid: testChatId,
        creator: { name: 'Creator', jid: creatorJid },
        prebookedCourts: [{ court: 'Court 1' }, { court: 'Court 2' }],
        releasedCourts: [{ court: 'Court 3' }, { court: 'Court 4' }],
        voteBuffer: vb2
      };
      const context = {
        activePolls: new Map([['poll_part_1', part1], ['poll_part_2', part2]]),
        recurringPolls: new Map()
      };

      try {
        // 9 + 4 = 13 total votes -> ceil(13/4) = 4 courts; 2 booked -> books 2 more
        const res = await handleCourtCommand(createMockSock(), `!bookcourt ${sessionId}`, testChatId, 'Admin', adminJid, null, context);
        assert.equal(bookCalls.length, 2);
        assert.ok(bookCalls[0].excludeCourts.includes('Court 1'));
        assert.ok(bookCalls[0].excludeCourts.includes('Court 2'));
        assert.equal(part1.prebookedCourts.length, 4);
        assert.equal(part2.prebookedCourts.length, 4);
        assert.equal(part1.releasedCourts.length, 0);
        assert.equal(part2.releasedCourts.length, 0);
        assert.match(res, /Booked 2 additional court\(s\)/);
        assert.match(res, /Total courts for poll: \*4\* \(16 player spots\)/);
      } finally {
        restore();
      }
    });

    it('should book courts up to full poll size when "all" is specified', async () => {
      const restore = setupEnv();
      const bookCalls = [];
      let nextCourt = 2;
      scvcc.bookCourt = async (args) => {
        bookCalls.push(args);
        return { success: true, court: `Court ${nextCourt++}`, date: args.when, time: '6:00 PM', reservationId: `500${nextCourt}` };
      };

      const pollId = 'poll_all_1';
      const pollState = {
        id: pollId,
        when: 'Friday 6pm',
        queryTime: '6:00pm',
        targetDateMDY: '11/27/2026',
        size: 12,
        status: 'active',
        remoteJid: testChatId,
        creator: { name: 'Creator', jid: creatorJid },
        prebookedCourts: [{ court: 'Court 1' }],
        voteBuffer: new Map([['v1@s.whatsapp.net', { vote: {} }]])
      };
      const context = { activePolls: new Map([[pollId, pollState]]), recurringPolls: new Map() };

      try {
        // size 12 -> ceil(12/4) = 3 courts total; 1 booked -> books 2 more despite maxCourts=2 in groupCfg
        const res = await handleCourtCommand(createMockSock(), `!bookcourt ${pollId} all`, testChatId, 'Creator', creatorJid, null, context);
        assert.equal(bookCalls.length, 2);
        assert.equal(pollState.prebookedCourts.length, 3);
        assert.match(res, /Booked 2 additional court\(s\)/);
      } finally {
        restore();
      }
    });

    it('should book exact number of additional courts when count is specified and enforce permissions', async () => {
      const restore = setupEnv();
      let calls = 0;
      scvcc.bookCourt = async (args) => {
        calls++;
        if (calls >= 2) return { success: false, message: 'No courts left' };
        return { success: true, court: 'Court 5', date: args.when, time: '7:00 PM', reservationId: '6001' };
      };

      const sentMessages = [];
      const sock = createMockSock(sentMessages);
      const pollId = 'poll_count_1';
      const pollState = {
        id: pollId,
        when: 'Thursday 7pm',
        queryTime: '7:00pm',
        targetDateMDY: '11/26/2026',
        size: 4,
        status: 'filled',
        remoteJid: testChatId,
        creator: { name: 'Creator', jid: creatorJid },
        prebookedCourts: [{ court: 'Court 1' }],
        voteBuffer: new Map([
          ['a@s.whatsapp.net', {}],
          ['b@s.whatsapp.net', {}],
          ['c@s.whatsapp.net', {}],
          ['d@s.whatsapp.net', {}]
        ])
      };
      const context = { activePolls: new Map([[pollId, pollState]]), recurringPolls: new Map() };

      try {
        // Non-creator / non-admin must be rejected
        const denied = await handleCourtCommand(sock, `!bookcourt ${pollId} 1`, testChatId, 'Member', memberJid, null, context);
        assert.match(denied, /Only the poll creator or group admins/);
        assert.equal(calls, 0);

        // Request 2 additional via DM with --group; only 1 succeeds (partial availability warning + group notification + status flips to active)
        const dmRes = await handleCourtCommand(sock, `!bookcourt ${pollId} 2 --group="Sat Tennis"`, 'admin_dm@s.whatsapp.net', 'Admin', adminJid, null, context);
        assert.match(dmRes, /Booked 1 additional court\(s\)/);
        assert.match(dmRes, /Requested \*2\* additional court\(s\), booked \*1\*/);
        assert.equal(pollState.size, 8);
        assert.equal(pollState.status, 'active');
        assert.ok(sentMessages.some((m) => m.jid === testChatId && /Booked 1 additional court/.test(m.payload.text)));

        // Also test via executeCourtTool('book_court', { pollId, count: 1 })
        calls = 0;
        scvcc.bookCourt = async (args) => ({ success: true, court: 'Court 6', date: args.when, time: '7:00 PM', reservationId: '6002' });
        const toolRes = await executeCourtTool(sock, 'book_court', { pollId, count: 1 }, 'Admin', testChatId, adminJid, context);
        assert.match(toolRes, /Booked 1 additional court\(s\)/);
        assert.equal(pollState.prebookedCourts.length, 3);
      } finally {
        restore();
      }
    });
  });
});
