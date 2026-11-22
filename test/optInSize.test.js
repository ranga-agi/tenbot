process.env.NODE_ENV = 'test';
const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const pollCommands = require('../lib/commands/poll');
const recurringPolls = require('../lib/recurringPolls');
const scvcc = require('../lib/scvcc');
const groupsConfig = require('../lib/groupsConfig');
const namesStore = require('../lib/names');
const ratings = require('../lib/ratings');
const pairHistory = require('../lib/pairHistory');
const playerActivity = require('../lib/playerActivity');
const { CLAUDE_TOOLS } = require('../lib/claudeTools');
const { helpText } = require('../lib/help');
const { executeRecurringTool } = require('../lib/commands/recurringCommands');

const {
  parsePollCreationText,
  handleDirectPollCreation,
  createMatchPoll,
  processPollVoteEvent,
  sendPollReminder,
  checkPendingLineupGenerations,
  pollStatusText,
  generateMatchupsFromPoll,
  handleReleasePollCourts,
  handleBookPollCourts,
  parseModifyInstanceCommand,
  handleModifyPollInstance,
  handleSetPollSlots,
  handlePollCommand,
  executePollTool,
  preBookCourtsForMatch
} = pollCommands;

const {
  parseRecurringPollText,
  extractOverrideSlotsArgs,
  scheduleRecurringPoll,
  modifyRecurringPoll,
  formatRecurringScheduleCard,
  simulateRecurringPoll,
  checkAndPostRecurringPolls,
  checkAndExecuteAdvanceBookings,
  overrideRecurringPollInstanceSlots
} = recurringPolls;

const yesHash = crypto.createHash('sha256').update('Yes').digest();
const noHash = crypto.createHash('sha256').update('No').digest();

describe('Opt-In (Yes/No) Poll Size Cap Feature', () => {
  const originals = {};
  const CHAT_ID = '120363403838804497@g.us';
  const ADMIN_JID = 'admin1@s.whatsapp.net';
  const BOT_JID = 'bot@s.whatsapp.net';

  beforeEach(() => {
    originals.ensureRated = ratings.ensureRated;
    originals.recordDraw = pairHistory.recordDraw;
    originals.recordPlayed = playerActivity.recordPlayed;
    originals.recordVoted = playerActivity.recordVoted;
    originals.getName = namesStore.getName;
    originals.resolveCanonicalId = namesStore.resolveCanonicalId;
    originals.getPnByLid = namesStore.getPnByLid;
    originals.isTenbot = namesStore.isTenbot;
    originals.getAllEntries = namesStore.getAllEntries;
    originals.findIdByNameOrAlias = namesStore.findIdByNameOrAlias;
    originals.getGroupConfig = groupsConfig.getGroupConfig;
    originals.isCourtBookingEnabled = groupsConfig.isCourtBookingEnabled;
    originals.getBookingDuration = groupsConfig.getBookingDuration;
    originals.getLineupGeneration = groupsConfig.getLineupGeneration;
    originals.isSuperAdmin = groupsConfig.isSuperAdmin;
    originals.checkCourtAvailability = scvcc.checkCourtAvailability;
    originals.getCourtBookings = scvcc.getCourtBookings;
    originals.bookCourt = scvcc.bookCourt;
    originals.cancelCourtReservation = scvcc.cancelCourtReservation;
    originals.detectPrebookedCourt = scvcc.detectPrebookedCourt;

    ratings.ensureRated = async () => {};
    pairHistory.recordDraw = () => {};
    playerActivity.recordPlayed = () => {};
    playerActivity.recordVoted = () => {};
    groupsConfig.isSuperAdmin = (jid) => jid === ADMIN_JID;

    const testPlayers = new Map();
    for (let i = 1; i <= 20; i++) {
      testPlayers.set(`p${i}@s.whatsapp.net`, `Player${i}`);
    }
    testPlayers.set(ADMIN_JID, 'Alice');

    namesStore.getName = (jid) => testPlayers.get(jid) || originals.getName(jid);
    namesStore.resolveCanonicalId = (jid) => jid;
    namesStore.getPnByLid = (jid) => jid;
    namesStore.isTenbot = () => false;
  });

  afterEach(() => {
    ratings.ensureRated = originals.ensureRated;
    pairHistory.recordDraw = originals.recordDraw;
    playerActivity.recordPlayed = originals.recordPlayed;
    playerActivity.recordVoted = originals.recordVoted;
    namesStore.getName = originals.getName;
    namesStore.resolveCanonicalId = originals.resolveCanonicalId;
    namesStore.getPnByLid = originals.getPnByLid;
    namesStore.isTenbot = originals.isTenbot;
    namesStore.getAllEntries = originals.getAllEntries;
    namesStore.findIdByNameOrAlias = originals.findIdByNameOrAlias;
    groupsConfig.getGroupConfig = originals.getGroupConfig;
    groupsConfig.isCourtBookingEnabled = originals.isCourtBookingEnabled;
    groupsConfig.getBookingDuration = originals.getBookingDuration;
    groupsConfig.getLineupGeneration = originals.getLineupGeneration;
    groupsConfig.isSuperAdmin = originals.isSuperAdmin;
    scvcc.checkCourtAvailability = originals.checkCourtAvailability;
    scvcc.getCourtBookings = originals.getCourtBookings;
    scvcc.bookCourt = originals.bookCourt;
    scvcc.cancelCourtReservation = originals.cancelCourtReservation;
    scvcc.detectPrebookedCourt = originals.detectPrebookedCourt;
  });

  function createMockSock(sentMessages) {
    let seq = 1;
    return {
      user: { id: BOT_JID },
      groupMetadata: async () => ({
        participants: [{ id: ADMIN_JID, admin: 'admin' }]
      }),
      sendMessage: async (jid, content, opts) => {
        const id = `msg_${seq++}`;
        const rec = { id, jid, content, opts };
        sentMessages.push(rec);
        return {
          key: { id, remoteJid: jid, fromMe: true },
          message: content.poll
            ? {
                pollCreationMessage: {
                  name: content.poll.name,
                  options: content.poll.values.map((v) => ({ optionName: v })),
                  selectableOptionsCount: content.poll.selectableCount ?? 1
                }
              }
            : content
        };
      }
    };
  }

  function createContext() {
    return {
      activePolls: new Map(),
      messageStore: new Map(),
      latestPollIdByChat: new Map(),
      recurringPolls: new Map(),
      persistPolls: () => {}
    };
  }

  describe('1. Parsing Poll Creation Text', () => {
    it('parses capped opt-in commands and natural language variants', () => {
      const a = parsePollCreationText('!poll opt-in 8 tomorrow 7pm');
      assert.equal(a.isOptIn, true);
      assert.equal(a.pollType, 'opt_in');
      assert.equal(a.size, 8);
      assert.equal(a.dayWord.toLowerCase(), 'tomorrow');
      assert.equal(a.timeWord.toLowerCase(), '7pm');

      const b = parsePollCreationText('!poll 8 opt-in tomorrow 7pm');
      assert.equal(b.isOptIn, true);
      assert.equal(b.pollType, 'opt_in');
      assert.equal(b.size, 8);

      const c = parsePollCreationText('!optinpoll 16 Friday 7pm');
      assert.equal(c.isOptIn, true);
      assert.equal(c.pollType, 'opt_in');
      assert.equal(c.size, 16);

      const d = parsePollCreationText('!yesnopoll 12 Saturday 9am');
      assert.equal(d.isOptIn, true);
      assert.equal(d.pollType, 'opt_in');
      assert.equal(d.size, 12);

      const e = parsePollCreationText('!poll yes/no for 6 tonight 8pm');
      assert.equal(e.isOptIn, true);
      assert.equal(e.pollType, 'opt_in');
      assert.equal(e.size, 6);

      const f = parsePollCreationText('create a yes/no poll for 10 tomorrow 6:30pm');
      assert.equal(f.isOptIn, true);
      assert.equal(f.pollType, 'opt_in');
      assert.equal(f.size, 10);
    });

    it('keeps uncapped opt-in poll with size=null and isolates custom title', () => {
      const uncapped = parsePollCreationText('!poll opt-in tomorrow 7:30pm');
      assert.equal(uncapped.isOptIn, true);
      assert.equal(uncapped.pollType, 'opt_in');
      assert.equal(uncapped.size, null);

      const titled = parsePollCreationText('!poll opt-in 8 tomorrow 7pm titled "8am Practice"');
      assert.equal(titled.isOptIn, true);
      assert.equal(titled.size, 8);
      assert.equal(titled.title, '8am Practice');
    });
  });

  describe('2. Poll Creation, Scale-Down, Large Sizes & Simulation', () => {
    it('creates a capped 8-spot Yes/No poll without Player 1..8 options', async () => {
      const sent = [];
      const sock = createMockSock(sent);
      const ctx = createContext();

      const res = await createMatchPoll(
        sock, CHAT_ID, 8, 'Tomorrow 7pm', 'tomorrow', '7pm',
        'Alice', ADMIN_JID, true, null, false, true,
        false, false, false, false, null, null, null, null, null, null, null,
        ctx, { isOptIn: true, type: 'opt_in' }
      );

      assert.equal(res.err, null);
      assert.equal(res.isOptIn, true);
      assert.equal(res.size, 8);
      assert.equal(res.slotLimit, 8);
      assert.deepEqual(res.options, ['Yes', 'No']);
      assert.match(res.pollTitle, /\(8 spots — Vote Yes\/No\)/);

      const state = ctx.activePolls.get(res.pollId);
      assert.equal(state.type, 'opt_in');
      assert.equal(state.size, 8);
      assert.equal(state.slotLimit, 8);
      assert.deepEqual(state.options, ['Yes', 'No']);
      assert.equal(sent.length, 1);
      assert.deepEqual(sent[0].content.poll.values, ['Yes', 'No']);
    });

    it('keeps >12 spot capped opt-in poll (e.g. 16 spots) as a single Yes/No poll', async () => {
      const sent = [];
      const sock = createMockSock(sent);
      const ctx = createContext();

      const parsed = parsePollCreationText('!poll opt-in 16 tomorrow 7pm');
      await handleDirectPollCreation(sock, CHAT_ID, 'Alice', { key: { participant: ADMIN_JID } }, parsed, { isCommand: true }, ctx);

      assert.equal(ctx.activePolls.size, 1);
      const [, state] = [...ctx.activePolls.entries()][0];
      assert.equal(state.type, 'opt_in');
      assert.equal(state.size, 16);
      assert.equal(state.slotLimit, 16);
      assert.deepEqual(state.options, ['Yes', 'No']);
      assert.equal(state.parentPollId || null, null);
    });

    it('scales down capped opt-in capacity when checkCourts finds fewer courts', async () => {
      groupsConfig.getGroupConfig = () => ({ name: 'Test', sport: 'tennis', courtBookingEnabled: true });
      scvcc.checkCourtAvailability = async () => ({
        slots: [{ time: '7:00 PM', courts: [{ court: 'Court 1', status: 'available', availableMinutes: 90 }] }]
      });
      scvcc.getCourtBookings = async () => ({ bookings: [] });

      const sent = [];
      const sock = createMockSock(sent);
      const ctx = createContext();

      const res = await createMatchPoll(
        sock, CHAT_ID, 8, 'Tomorrow 7pm', 'tomorrow', '7pm',
        'Alice', ADMIN_JID, false, null, false, true,
        false, true, false, false, null, null, null, null, null, null, null,
        ctx, { isOptIn: true, type: 'opt_in' }
      );

      assert.equal(res.err, null);
      assert.equal(res.givenCount, 8);
      assert.equal(res.size, 4);
      assert.equal(res.slotLimit, 4);
      assert.match(res.pollTitle, /\(4 spots — Vote Yes\/No\)/);
      const state = ctx.activePolls.get(res.pollId);
      assert.equal(state.size, 4);
      assert.equal(state.slotLimit, 4);
    });

    it('schedules future one-time capped opt-in poll via "at <postTime>"', async () => {
      const sent = [];
      const sock = createMockSock(sent);
      const ctx = {
        ...createContext(),
        customSanJoseParts: { year: 2026, month: 10, day: 21, hour: 7, minute: 0, weekday: 'sat' }
      };

      const parsed = parsePollCreationText('!poll opt-in 8 tomorrow 7pm at 8am');
      const reply = await handleDirectPollCreation(sock, CHAT_ID, 'Alice', { key: { participant: ADMIN_JID } }, parsed, { isCommand: true }, ctx);

      assert.equal(ctx.recurringPolls.size, 1);
      const [, sched] = [...ctx.recurringPolls.entries()][0];
      assert.equal(sched.type, 'opt_in');
      assert.equal(sched.size, 8);
      assert.equal(sched.oneTime, true);
      assert.match(reply, /8 spots max/i);
    });

    it('simulates capped opt-in poll summary with spot cap', async () => {
      const sent = [];
      const sock = createMockSock(sent);
      const ctx = createContext();
      groupsConfig.getGroupConfig = () => ({ name: 'Test', sport: 'tennis', courtBookingEnabled: true });
      scvcc.checkCourtAvailability = async () => ({
        slots: [{
          time: '7:00 PM',
          courts: [
            { court: 'Court 1', status: 'available', availableMinutes: 90 },
            { court: 'Court 2', status: 'available', availableMinutes: 90 }
          ]
        }]
      });
      scvcc.getCourtBookings = async () => ({ bookings: [] });

      const parsed = parsePollCreationText('!simulatepoll opt-in 8 tomorrow 7pm');
      const reply = await handleDirectPollCreation(sock, CHAT_ID, 'Alice', { key: { participant: ADMIN_JID } }, parsed, { isCommand: true, simulate: true }, ctx);

      assert.equal(ctx.activePolls.size, 0);
      assert.match(reply, /Opt-in \(Yes\/No, 8 spots max\)/);
    });
  });

  describe('3. Voting, Waitlist, Fill, Unvote Revert & Matchups', () => {
    it('tracks Yes votes up to cap, auto-generates matchups in filled mode, warns on excess, and reverts on unvote', async () => {
      const sent = [];
      const sock = createMockSock(sent);
      const ctx = createContext();

      // Test none/fallback fill -> waitlist -> revert -> active first, then filled auto-matchups
      const res = await createMatchPoll(
        sock, CHAT_ID, 4, 'Tomorrow 7pm', 'tomorrow', '7pm',
        'Alice', ADMIN_JID, false, null, false, true,
        false, false, false, false, null, null, null, null, null, null, null,
        ctx, { isOptIn: true, type: 'opt_in', lineupGeneration: 'fallback' }
      );
      const pollId = res.pollId;
      const pollState = ctx.activePolls.get(pollId);

      // 3 Yes votes -> stays active
      for (let i = 1; i <= 3; i++) {
        await processPollVoteEvent(sock, { id: pollId, remoteJid: CHAT_ID }, [{
          pollUpdateMessageKey: { remoteJid: CHAT_ID, participant: `p${i}@s.whatsapp.net` },
          senderTimestampMs: 1000 + i * 100,
          vote: { selectedOptions: [yesHash] }
        }], ctx);
      }
      assert.equal(pollState.status, 'active');

      // 4th Yes vote -> fills poll
      await processPollVoteEvent(sock, { id: pollId, remoteJid: CHAT_ID }, [{
        pollUpdateMessageKey: { remoteJid: CHAT_ID, participant: 'p4@s.whatsapp.net' },
        senderTimestampMs: 1400,
        vote: { selectedOptions: [yesHash] }
      }], ctx);
      assert.equal(pollState.status, 'filled');
      assert.deepEqual(pollState.lastPlayers, ['Player1', 'Player2', 'Player3', 'Player4']);

      // 5th Yes vote -> warns waitlist / excess without replacing first 4
      await processPollVoteEvent(sock, { id: pollId, remoteJid: CHAT_ID }, [{
        pollUpdateMessageKey: { remoteJid: CHAT_ID, participant: 'p5@s.whatsapp.net' },
        senderTimestampMs: 1500,
        vote: { selectedOptions: [yesHash] }
      }], ctx);
      const warnMsg = sent.find((m) =>
        m.content?.text &&
        /slot limit for this match poll has been set to \*4 players\*/i.test(m.content.text) &&
        /@5\b/.test(m.content.text)
      );
      assert.ok(warnMsg, 'Expected excess vote warning with @mention');
      assert.ok(Array.isArray(warnMsg.content.mentions) && warnMsg.content.mentions.includes('p5@s.whatsapp.net'));
      assert.equal(warnMsg.opts?.quoted?.key?.id, pollId);

      // Switch Player1 to No (still 4 Yes voters remaining: Player2..Player5 -> stays filled!)
      // Then switch Player2 to No (3 Yes voters left -> reverts from filled to active)
      await processPollVoteEvent(sock, { id: pollId, remoteJid: CHAT_ID }, [{
        pollUpdateMessageKey: { remoteJid: CHAT_ID, participant: 'p1@s.whatsapp.net' },
        senderTimestampMs: 1600,
        vote: { selectedOptions: [noHash] }
      }], ctx);
      assert.equal(pollState.status, 'filled');
      assert.equal(pollState.lastExcessSignature, null);

      await processPollVoteEvent(sock, { id: pollId, remoteJid: CHAT_ID }, [{
        pollUpdateMessageKey: { remoteJid: CHAT_ID, participant: 'p2@s.whatsapp.net' },
        senderTimestampMs: 1700,
        vote: { selectedOptions: [noHash] }
      }], ctx);
      assert.equal(pollState.status, 'active');

      // Now test lineupGeneration: 'filled' auto-generates matchups on 4th Yes vote
      const resAuto = await createMatchPoll(
        sock, CHAT_ID, 4, 'Tomorrow 8pm', 'tomorrow', '8pm',
        'Alice', ADMIN_JID, false, null, false, true,
        false, false, false, false, null, null, null, null, null, null, null,
        ctx, { isOptIn: true, type: 'opt_in', lineupGeneration: 'filled' }
      );
      for (let i = 1; i <= 4; i++) {
        await processPollVoteEvent(sock, { id: resAuto.pollId, remoteJid: CHAT_ID }, [{
          pollUpdateMessageKey: { remoteJid: CHAT_ID, participant: `p${i}@s.whatsapp.net` },
          senderTimestampMs: 2000 + i * 100,
          vote: { selectedOptions: [yesHash] }
        }], ctx);
      }
      const autoState = ctx.activePolls.get(resAuto.pollId);
      assert.equal(autoState.status, 'resolved');
      assert.equal(autoState.lastPlayers.length, 4);
      assert.ok(sent.some((m) => m.content?.text && /Match|Round|Court/i.test(m.content.text)));
    });

    it('caps fallback deadline matchups and manual !matchups to size limit', async () => {
      const sent = [];
      const sock = createMockSock(sent);
      const ctx = createContext();

      const now = Date.now();
      const res = await createMatchPoll(
        sock, CHAT_ID, 4, 'Tomorrow 7pm', 'tomorrow', '7pm',
        'Alice', ADMIN_JID, false, null, false, true,
        false, false, false, false, null, null, null, null, null, null, null,
        ctx, { isOptIn: true, type: 'opt_in', lineupGeneration: 'fallback', lineupLeadTime: 30 }
      );
      const state = ctx.activePolls.get(res.pollId);
      // 5 Yes votes arrive (e.g., 4 active + 1 waitlist)
      for (let i = 1; i <= 5; i++) {
        await processPollVoteEvent(sock, { id: res.pollId, remoteJid: CHAT_ID }, [{
          pollUpdateMessageKey: { remoteJid: CHAT_ID, participant: `p${i}@s.whatsapp.net` },
          senderTimestampMs: 1000 + i * 50,
          vote: { selectedOptions: [yesHash] }
        }], ctx);
      }

      // Manual !matchups slices to 4
      await generateMatchupsFromPoll(sock, CHAT_ID, res.pollId, null, {}, ctx);
      const manualMsg = sent[sent.length - 1]?.content?.text || '';
      assert.ok(manualMsg.length > 0);
      assert.match(manualMsg, /Player1/);
      assert.match(manualMsg, /Player4/);
      assert.doesNotMatch(manualMsg, /Player5/);

      // Fallback deadline sweep also caps at 4
      state.status = 'filled';
      state.playAt = new Date(now + 15 * 60 * 1000).toISOString();
      const genIds = await checkPendingLineupGenerations(sock, ctx, now);
      assert.deepEqual([...genIds], [res.pollId]);
      assert.equal(state.status, 'resolved');
      assert.deepEqual(state.lastPlayers, ['Player1', 'Player2', 'Player3', 'Player4']);
    });

    it('clears lastExcessSignature when excess clears and re-warns with @mention and quoted poll on re-vote', async () => {
      const sent = [];
      const sock = createMockSock(sent);
      const ctx = createContext();

      const res = await createMatchPoll(
        sock, CHAT_ID, 2, 'Tomorrow 7pm', 'tomorrow', '7pm',
        'Alice', ADMIN_JID, false, null, false, true,
        false, false, false, false, null, null, null, null, null, null, null,
        ctx, { isOptIn: true, type: 'opt_in', lineupGeneration: 'none' }
      );
      const pollId = res.pollId;
      const state = ctx.activePolls.get(pollId);

      for (let i = 1; i <= 3; i++) {
        await processPollVoteEvent(sock, { id: pollId, remoteJid: CHAT_ID }, [{
          pollUpdateMessageKey: { remoteJid: CHAT_ID, participant: `p${i}@s.whatsapp.net` },
          senderTimestampMs: 1000 + i * 100,
          vote: { selectedOptions: [yesHash] }
        }], ctx);
      }
      assert.equal(state.lastExcessSignature, 'Player3');
      const firstWarnCount = sent.filter((m) => m.content?.text && /slot limit for this match poll/i.test(m.content.text)).length;
      assert.equal(firstWarnCount, 1);

      // Player3 unvotes -> lastExcessSignature cleared
      await processPollVoteEvent(sock, { id: pollId, remoteJid: CHAT_ID }, [{
        pollUpdateMessageKey: { remoteJid: CHAT_ID, participant: 'p3@s.whatsapp.net' },
        senderTimestampMs: 1500,
        vote: { selectedOptions: [] }
      }], ctx);
      assert.equal(state.lastExcessSignature, null);

      // Player3 votes Yes again -> warned again with @mention and quoted poll
      await processPollVoteEvent(sock, { id: pollId, remoteJid: CHAT_ID }, [{
        pollUpdateMessageKey: { remoteJid: CHAT_ID, participant: 'p3@s.whatsapp.net' },
        senderTimestampMs: 1600,
        vote: { selectedOptions: [yesHash] }
      }], ctx);
      assert.equal(state.lastExcessSignature, 'Player3');
      const warns = sent.filter((m) => m.content?.text && /slot limit for this match poll/i.test(m.content.text));
      assert.equal(warns.length, 2);
      assert.match(warns[1].content.text, /@3\b/);
      assert.ok(warns[1].content.mentions.includes('p3@s.whatsapp.net'));
      assert.equal(warns[1].opts?.quoted?.key?.id, pollId);
    });
  });

  describe('4. Reminders & !pollstatus Display', () => {
    it('shows X/limit in reminders, skips auto-reminder when full, and formats status & waitlist', async () => {
      const sent = [];
      const sock = createMockSock(sent);
      const ctx = createContext();

      const res = await createMatchPoll(
        sock, CHAT_ID, 4, 'Tomorrow 7pm', 'tomorrow', '7pm',
        'Alice', ADMIN_JID, false, null, false, true,
        false, false, false, false, null, null, null, null, null, null, null,
        ctx, { isOptIn: true, type: 'opt_in', lineupGeneration: 'none' }
      );
      const state = ctx.activePolls.get(res.pollId);

      // 1 Yes vote
      await processPollVoteEvent(sock, { id: res.pollId, remoteJid: CHAT_ID }, [{
        pollUpdateMessageKey: { remoteJid: CHAT_ID, participant: 'p1@s.whatsapp.net' },
        senderTimestampMs: 1000,
        vote: { selectedOptions: [yesHash] }
      }], ctx);

      const sentRem = await sendPollReminder(sock, res.pollId, state, false, ctx);
      assert.equal(sentRem, true);
      const remMsg = sent[sent.length - 1].content.text;
      assert.match(remMsg, /\*1\/4 player\(s\)/i);

      // 4 more Yes votes (5 total -> full + 1 waitlist)
      for (let i = 2; i <= 5; i++) {
        await processPollVoteEvent(sock, { id: res.pollId, remoteJid: CHAT_ID }, [{
          pollUpdateMessageKey: { remoteJid: CHAT_ID, participant: `p${i}@s.whatsapp.net` },
          senderTimestampMs: 1000 + i * 100,
          vote: { selectedOptions: [yesHash] }
        }], ctx);
      }

      // Auto-reminder skips when full (status === 'filled' or openSpots <= 0)
      state.status = 'active';
      const skippedWhenFull = await sendPollReminder(sock, res.pollId, state, false, ctx);
      assert.equal(skippedWhenFull, false);

      // Manual reminder sends when forced
      const forcedWhenFull = await sendPollReminder(sock, res.pollId, state, true, ctx);
      assert.equal(forcedWhenFull, true);

      // !pollstatus shows limit and waitlist
      const status = pollStatusText(CHAT_ID, { targetId: res.pollId }, ctx);
      assert.match(status, /Opt-in \(Yes\/No, 4 spots max\)/);
      assert.match(status, /Yes votes \(4\/4\):/);
      assert.match(status, /Waitlist \(1\): Player5/);
    });
  });

  describe('5. Court Release (!releasecourt) & Book (!bookcourt)', () => {
    it('resizes capped opt-in poll on release, preserves size on --keep-size, and expands on !bookcourt', async () => {
      groupsConfig.getGroupConfig = () => ({ name: 'Test', sport: 'tennis', courtBookingEnabled: true });
      groupsConfig.isCourtBookingEnabled = () => true;
      scvcc.cancelCourtReservation = async () => ({ success: true, message: 'Cancelled' });
      scvcc.bookCourt = async ({ court }) => ({
        success: true,
        court: court || 'Court 3',
        players: ['Alice', 'Bob'],
        time: '7:00 PM',
        reservationId: 'res-303',
        duration: '90 Minutes',
        partySize: 'Doubles'
      });
      scvcc.checkCourtAvailability = async () => ({
        slots: [{ time: '7:00 PM', courts: [{ court: 'Court 3', status: 'available', availableMinutes: 90 }] }]
      });
      scvcc.getCourtBookings = async () => ({ bookings: [] });

      const sent = [];
      const sock = createMockSock(sent);
      const ctx = createContext();

      const res = await createMatchPoll(
        sock, CHAT_ID, 8, 'Tomorrow 7pm', 'tomorrow', '7pm',
        'Alice', ADMIN_JID, false, null, false, true,
        false, false, false, false, null, null, null, null, null, null,
        {
          prebookedCourts: [
            { court: 'Court 1', player: 'Alice', reservationId: 'r1' },
            { court: 'Court 2', player: 'Bob', reservationId: 'r2' }
          ],
          autoBookedCourts: [
            { court: 'Court 1', reservationId: 'r1', players: ['Alice'] },
            { court: 'Court 2', reservationId: 'r2', players: ['Bob'] }
          ]
        },
        ctx, { isOptIn: true, type: 'opt_in', lineupGeneration: 'none' }
      );
      const state = ctx.activePolls.get(res.pollId);
      assert.equal(state.size, 8);
      assert.equal(state.slotLimit, 8);

      // Release 1 court without --keep-size -> shrinks to 4
      await handleReleasePollCourts(sock, CHAT_ID, 'Alice', ADMIN_JID, `${res.pollId} 1`, ctx);
      assert.equal(state.size, 4);
      assert.equal(state.slotLimit, 4);
      assert.match(state.name, /\(4 spots/);

      // Book 1 court back -> expands back to 8
      await handleBookPollCourts(sock, CHAT_ID, 'Alice', ADMIN_JID, `${res.pollId} 1`, ctx);
      assert.equal(state.size, 8);
      assert.match(state.name, /\(8 spots/);

      // Release 1 court WITH --keep-size -> stays 8
      await handleReleasePollCourts(sock, CHAT_ID, 'Alice', ADMIN_JID, `${res.pollId} 1 --keep-size`, ctx);
      assert.equal(state.size, 8);

      // Uncapped opt-in poll stays uncapped when booking an extra court
      const uncappedRes = await createMatchPoll(
        sock, CHAT_ID, null, 'Tomorrow 8pm', 'tomorrow', '8pm',
        'Alice', ADMIN_JID, false, null, false, true,
        false, false, false, false, null, null, null, null, null, null,
        { prebookedCourts: [{ court: 'Court 1', player: 'Alice', reservationId: 'r9' }], autoBookedCourts: [] },
        ctx, { isOptIn: true, type: 'opt_in' }
      );
      await handleBookPollCourts(sock, CHAT_ID, 'Alice', ADMIN_JID, `${uncappedRes.pollId} 1`, ctx);
      assert.equal(ctx.activePolls.get(uncappedRes.pollId).size, null);
    });
  });

  describe('6. !setslots & !modifyinstance', () => {
    it('supports !setslots opt-in <N>, reset for uncapped opt-in, and recurring schedule overrides', async () => {
      const sent = [];
      const sock = createMockSock(sent);
      const ctx = createContext();

      // Create uncapped opt-in poll
      const uncapped = await createMatchPoll(
        sock, CHAT_ID, null, 'Tomorrow 7pm', 'tomorrow', '7pm',
        'Alice', ADMIN_JID, false, null, false, true,
        false, false, false, false, null, null, null, null, null, null, null,
        ctx, { isOptIn: true, type: 'opt_in' }
      );
      const pState = ctx.activePolls.get(uncapped.pollId);
      assert.equal(pState.size, null);

      // !setslots opt-in 8 via command parser
      const setReply = await handlePollCommand(sock, `!setslots ${uncapped.pollId} opt-in 8`, CHAT_ID, 'Alice', ADMIN_JID, { key: { participant: ADMIN_JID } }, ctx);
      assert.match(setReply, /8 slots/);
      assert.equal(pState.size, 8);
      assert.equal(pState.slotLimit, 8);

      // !setslots reset reverts originally uncapped opt-in back to null
      const resetReply = await handlePollCommand(sock, `!setslots ${uncapped.pollId} reset`, CHAT_ID, 'Alice', ADMIN_JID, { key: { participant: ADMIN_JID } }, ctx);
      assert.match(resetReply, /Removed slot limit/);
      assert.equal(pState.size, null);
      assert.equal(pState.slotLimit, null);

      // Recurring override via !setslots rec_1 Friday opt-in 8
      ctx.recurringPolls.set('rec_1', {
        id: 'rec_1',
        remoteJid: CHAT_ID,
        size: 12,
        matchTime: '7pm',
        daysList: [5],
        creator: { name: 'Alice', jid: ADMIN_JID }
      });
      const recOverrideReply = await handlePollCommand(sock, '!setslots rec_1 Friday opt-in 8', CHAT_ID, 'Alice', ADMIN_JID, { key: { participant: ADMIN_JID } }, ctx);
      assert.match(recOverrideReply, /Opt-in \(Yes\/No, 8 spots\)/i);
      const overrides = Object.values(ctx.recurringPolls.get('rec_1').instanceSlotOverrides || {});
      assert.ok(overrides.includes('opt-in:8'));
    });

    it('parses !modifyinstance opt-in <N>, avoids time misparse, and preserves cap on unrelated changes', async () => {
      const parsedCap = parseModifyInstanceCommand('!modifyinstance rec_1 opt-in 8');
      assert.equal(parsedCap.targetId, 'rec_1');
      assert.equal(parsedCap.updates.type, 'opt_in');
      assert.equal(parsedCap.updates.isExplicitOptIn, true);
      assert.equal(parsedCap.updates.size, 8);

      const parsedTimeOnly = parseModifyInstanceCommand('!modifyinstance rec_1 opt-in 7:30pm');
      assert.equal(parsedTimeOnly.updates.type, 'opt_in');
      assert.equal(parsedTimeOnly.updates.size, null);
      assert.equal(parsedTimeOnly.updates.timeWord, '7:30pm');

      const sent = [];
      const sock = createMockSock(sent);
      const ctx = createContext();

      // Start with a fixed 8-spot poll, convert to opt-in 6
      const fixed = await createMatchPoll(
        sock, CHAT_ID, 8, 'Tomorrow 7pm', 'tomorrow', '7pm',
        'Alice', ADMIN_JID, false, null, false, true,
        false, false, false, false, null, null, null, null, null, null, null,
        ctx
      );
      const reply1 = await handleModifyPollInstance(sock, CHAT_ID, 'Alice', ADMIN_JID, fixed.pollId, { type: 'opt_in', isExplicitOptIn: true, size: 6 }, ctx);
      assert.match(reply1, /Opt-in \(Yes\/No, 6 spots max\)/);
      const [pollId2, state2] = [...ctx.activePolls.entries()].find(([, s]) => s.status === 'active');
      assert.equal(state2.type, 'opt_in');
      assert.equal(state2.size, 6);
      assert.equal(state2.slotLimit, 6);

      // Modify only time (to 7:30pm) -> preserves type: 'opt_in' and size: 6
      await handleModifyPollInstance(sock, CHAT_ID, 'Alice', ADMIN_JID, pollId2, { timeWord: '7:30pm', when: 'Tomorrow 7:30pm' }, ctx);
      const [, state3] = [...ctx.activePolls.entries()].find(([, s]) => s.status === 'active');
      assert.equal(state3.type, 'opt_in');
      assert.equal(state3.size, 6);
      assert.equal(state3.slotLimit, 6);

      // Uncap opt-in 6 -> opt-in
      await handleModifyPollInstance(sock, CHAT_ID, 'Alice', ADMIN_JID, [...ctx.activePolls.keys()].pop(), { type: 'opt_in', isExplicitOptIn: true, size: null }, ctx);
      const [, state4] = [...ctx.activePolls.entries()].find(([, s]) => s.status === 'active');
      assert.equal(state4.type, 'opt_in');
      assert.equal(state4.size, null);
    });
  });

  describe('7. Recurring Polls: Parse, Schedule, Modify, Post, Simulate & Advance Book', () => {
    it('parses and schedules capped opt-in recurring polls and formats cards cleanly', async () => {
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
      groupsConfig.getGroupConfig = () => ({ name: 'Test', sport: 'tennis', courtBookingEnabled: true });

      const parsed = parseRecurringPollText('!recurringpoll opt-in 8 7pm mon-fri');
      assert.equal(parsed.type, 'opt_in');
      assert.equal(parsed.isExplicitOptIn, true);
      assert.equal(parsed.size, 8);

      const extracted = extractOverrideSlotsArgs('rec_1 Friday opt-in 8');
      assert.deepEqual(extracted, { scheduleId: 'rec_1', targetDayOrDate: 'Friday', slots: 'opt-in:8' });

      const ctx = createContext();
      const schedMsg = await scheduleRecurringPoll({
        recurringPolls: ctx.recurringPolls,
        persistPolls: ctx.persistPolls,
        targetChatId: CHAT_ID,
        sender: 'Alice',
        senderJid: ADMIN_JID,
        params: parsed
      });

      assert.match(schedMsg, /Opt-in \(Yes\/No, 8 spots max\)/);
      const [recId, sched] = [...ctx.recurringPolls.entries()][0];
      assert.equal(sched.type, 'opt_in');
      assert.equal(sched.size, 8);

      // Modify to uncapped opt-in
      await modifyRecurringPoll({
        recurringPolls: ctx.recurringPolls,
        persistPolls: ctx.persistPolls,
        targetChatId: CHAT_ID,
        senderJid: ADMIN_JID,
        scheduleId: recId,
        updates: { type: 'opt_in', isExplicitOptIn: true, size: null }
      });
      assert.equal(sched.type, 'opt_in');
      assert.equal(sched.size, null);

      // Modify to opt-in 10
      await modifyRecurringPoll({
        recurringPolls: ctx.recurringPolls,
        persistPolls: ctx.persistPolls,
        targetChatId: CHAT_ID,
        senderJid: ADMIN_JID,
        scheduleId: recId,
        updates: { type: 'opt_in', isExplicitOptIn: true, size: 10 }
      });
      assert.equal(sched.type, 'opt_in');
      assert.equal(sched.size, 10);

      // Override an instance to opt-in:6 and check card formatting
      overrideRecurringPollInstanceSlots({
        recurringPolls: ctx.recurringPolls,
        activePolls: ctx.activePolls,
        persistPolls: ctx.persistPolls,
        targetChatId: CHAT_ID,
        scheduleId: recId,
        targetDayOrDate: 'Friday',
        slots: 'opt-in:6'
      });
      const card = formatRecurringScheduleCard(sched);
      assert.match(card, /Opt-in \(Yes\/No, 10 spots max\)/);
      assert.match(card, /Opt-in \(6 spots\)/);

      // Simulate recurring poll
      const simOut = await simulateRecurringPoll({
        recurringPolls: ctx.recurringPolls,
        scheduleId: recId
      });
      assert.match(simOut, /Opt-in \(Yes\/No, 10 spots max\)/);
    });

    it('posts capped opt-in polls and advance-books courts matching capped size & opt-in override', async () => {
      groupsConfig.getGroupConfig = () => ({ name: 'Test', sport: 'tennis', courtBookingEnabled: true });
      groupsConfig.isCourtBookingEnabled = () => true;
      const bookedCalls = [];
      scvcc.bookCourt = async (args) => {
        bookedCalls.push(args);
        return {
          success: true,
          court: `Court ${bookedCalls.length}`,
          time: '7:00 PM',
          players: ['Alice', 'Bob'],
          reservationId: `res_${bookedCalls.length}`,
          duration: '90 Minutes',
          partySize: 'Doubles'
        };
      };
      scvcc.checkCourtAvailability = async () => ({
        slots: [{
          time: '7:00 PM',
          courts: [
            { court: 'Court 1', status: 'available', availableMinutes: 90 },
            { court: 'Court 2', status: 'available', availableMinutes: 90 }
          ]
        }]
      });
      scvcc.getCourtBookings = async () => ({ bookings: [] });

      const sent = [];
      const sock = createMockSock(sent);
      const ctx = createContext();

      // Match on Sun Nov 22, 2026 at 7pm; advance booking runs day before at 7am; poll posts at 8am
      const schedId = 'rec_opt_adv';
      ctx.recurringPolls.set(schedId, {
        id: schedId,
        remoteJid: CHAT_ID,
        enabled: true,
        type: 'opt_in',
        size: 4,
        matchTime: '7pm',
        matchHour: 19,
        matchMinute: 0,
        matchDisplay: '7:00 PM',
        postTime: '1 day before at 8am',
        postHour: 8,
        postMinute: 0,
        postDaysBefore: 1,
        daysList: [0], // Sunday
        includeCreator: false,
        courtBookingType: 'pre-book',
        bookingStrategy: 'advanced',
        bookingSchedule: '1 day before at 7am',
        bookingDaysBefore: 1,
        bookingHour: 7,
        bookingMinute: 0,
        preBookCourts: 1,
        bookingPlayers: ['Alice', 'Bob'],
        instanceSlotOverrides: { '2026-11-22': 'opt-in:8' },
        postedMatchDates: [],
        advanceBookings: {},
        creator: { name: 'Alice', jid: ADMIN_JID }
      });

      // Run advance booking sweep at Sat 2026-11-21 07:05
      await checkAndExecuteAdvanceBookings({
        sock,
        recurringPolls: ctx.recurringPolls,
        persistPolls: ctx.persistPolls,
        preBookCourtsForMatch,
        activePolls: ctx.activePolls,
        customSanJoseParts: { year: 2026, month: 10, day: 21, hour: 7, minute: 5, weekday: 'sat' }
      });
      // Because override was opt-in:8, 2 courts should be booked!
      assert.equal(bookedCalls.length, 2);

      // Run post sweep at Sat 2026-11-21 08:05
      await checkAndPostRecurringPolls({
        sock,
        recurringPolls: ctx.recurringPolls,
        persistPolls: ctx.persistPolls,
        createMatchPoll,
        activePolls: ctx.activePolls,
        customSanJoseParts: { year: 2026, month: 10, day: 21, hour: 8, minute: 5, weekday: 'sat' }
      });
      assert.equal(ctx.activePolls.size, 1);
      const [, posted] = [...ctx.activePolls.entries()][0];
      assert.equal(posted.type, 'opt_in');
      assert.equal(posted.size, 8);
      assert.equal(posted.slotLimit, 8);
      assert.deepEqual(posted.options, ['Yes', 'No']);
    });
  });

  describe('8. AI Tools & Help Documentation', () => {
    it('supports type: opt_in + numeric size across poll and recurring AI tools', async () => {
      const sent = [];
      const sock = createMockSock(sent);
      const ctx = createContext();

      // create_poll
      const createdMsg = await executePollTool(sock, 'create_poll', {
        type: 'opt_in',
        size: 8,
        when: 'tomorrow 7pm'
      }, 'Alice', ADMIN_JID, CHAT_ID, { key: { participant: ADMIN_JID } }, ctx);
      assert.match(createdMsg, /capped at 8 spots max/i);
      const [pollId, createdState] = [...ctx.activePolls.entries()][0];
      assert.equal(createdState.type, 'opt_in');
      assert.equal(createdState.size, 8);

      // limit_poll_slots
      const limitedMsg = await executePollTool(sock, 'limit_poll_slots', {
        pollId,
        type: 'opt_in',
        slots: 6
      }, 'Alice', ADMIN_JID, CHAT_ID, { key: { participant: ADMIN_JID } }, ctx);
      assert.match(limitedMsg, /6 slots/);
      assert.equal(createdState.slotLimit, 6);

      // schedule_recurring_poll & modify_recurring_poll
      const recCreateMsg = await executeRecurringTool(sock, 'schedule_recurring_poll', {
        type: 'opt_in',
        size: 8,
        matchTime: '7pm',
        days: 'mon,wed'
      }, 'Alice', ADMIN_JID, CHAT_ID, ctx);
      assert.match(recCreateMsg, /8 spots max/);
      const [recId, recState] = [...ctx.recurringPolls.entries()][0];
      assert.equal(recState.type, 'opt_in');
      assert.equal(recState.size, 8);

      await executeRecurringTool(sock, 'modify_recurring_poll', {
        scheduleId: recId,
        type: 'opt_in',
        size: 12
      }, 'Alice', ADMIN_JID, CHAT_ID, ctx);
      assert.equal(recState.size, 12);
    });

    it('documents opt-in [size] in helpText and exposes type parameter in CLAUDE_TOOLS', () => {
      assert.match(helpText('poll'), /opt-in\s+\[size\]/i);
      assert.match(helpText('recurringpoll'), /opt-in\s+\[size\]/i);
      assert.match(helpText('modifyinstance'), /opt-in\s+\[size\]/i);
      assert.match(helpText('setslots'), /opt-in\s+<n>/i);

      for (const toolName of ['create_poll', 'simulate_poll', 'schedule_recurring_poll', 'modify_poll_instance', 'limit_poll_slots']) {
        const tool = CLAUDE_TOOLS.find((t) => t.name === toolName);
        assert.ok(tool, `${toolName} should exist in CLAUDE_TOOLS`);
        assert.deepEqual(tool.input_schema.properties.type?.enum, ['spots', 'opt_in']);
      }
    });
  });
});
