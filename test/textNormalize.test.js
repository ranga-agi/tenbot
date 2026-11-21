process.env.NODE_ENV = 'test';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { normalizeCommandDashes } = require('../lib/textNormalize');
const { extractGroupFlag } = require('../lib/commands/groupCommands');
const { parseReleaseCourtsArgs, parseBookPollCourtsArgs, parsePollCreationText } = require('../lib/commands/poll');
const { parseRecurringPollText } = require('../lib/recurringPolls');
const { parseModifyCourtCommand } = require('../lib/scvcc');
const { routeCommand } = require('../lib/commands');

describe('Smart Dash Normalization for Command Options', () => {
  describe('normalizeCommandDashes', () => {
    it('converts leading em dash and en dash before option names to "--"', () => {
      assert.equal(normalizeCommandDashes('!releasecourt 1 —keep-size'), '!releasecourt 1 --keep-size');
      assert.equal(normalizeCommandDashes('!releasecourt 1 –keep-size'), '!releasecourt 1 --keep-size');
      assert.equal(normalizeCommandDashes('—no-resize all'), '--no-resize all');
      assert.equal(normalizeCommandDashes('!leaderboard –all'), '!leaderboard --all');
      assert.equal(normalizeCommandDashes('!poll 8 —-courts-strategy=book'), '!poll 8 --courts-strategy=book');
    });

    it('normalizes smart dashes inside multi-word flag names without corrupting values', () => {
      assert.equal(
        normalizeCommandDashes('!poll 8 —courts—strategy=book —title="Friday — 7pm"'),
        '!poll 8 --courts-strategy=book --title="Friday — 7pm"'
      );
      assert.equal(
        normalizeCommandDashes('!poll 8 —title="Friday—Night"'),
        '!poll 8 --title="Friday—Night"'
      );
    });

    it('preserves regular prose em dashes, date ranges, and single-dash short flags', () => {
      assert.equal(normalizeCommandDashes('Saturday — 9am'), 'Saturday — 9am');
      assert.equal(normalizeCommandDashes('tomorrow—maybe 6pm'), 'tomorrow—maybe 6pm');
      assert.equal(normalizeCommandDashes('!poll 4 7pm -g Bot-testing'), '!poll 4 7pm -g Bot-testing');
      assert.equal(normalizeCommandDashes('!pollstatus -r'), '!pollstatus -r');
    });
  });

  describe('Parser integration with em/en dashes', () => {
    it('parseReleaseCourtsArgs handles em and en dashes on --keep-size aliases', () => {
      assert.deepEqual(
        parseReleaseCourtsArgs('1 —keep-size'),
        { target: null, countOrAll: 1, specificCourt: null, keepSize: true }
      );
      assert.deepEqual(
        parseReleaseCourtsArgs('–no-resize all'),
        { target: null, countOrAll: 'all', specificCourt: null, keepSize: true }
      );
      assert.deepEqual(
        parseReleaseCourtsArgs('rec_1 Court 2 —preserve—size'),
        { target: 'rec_1', countOrAll: 1, specificCourt: 'Court 2', keepSize: true }
      );
    });

    it('extractGroupFlag handles em and en dashes on --group', () => {
      const em = extractGroupFlag('!poll 4 7pm —group="Bot-testing"');
      assert.equal(em.groupQuery, 'Bot-testing');
      assert.equal(em.cleanText, '!poll 4 7pm');

      const en = extractGroupFlag('!poll 4 7pm –group=Bot-testing');
      assert.equal(en.groupQuery, 'Bot-testing');
      assert.equal(en.cleanText, '!poll 4 7pm');
    });

    it('parsePollCreationText handles smart dashes on options while keeping em dashes in title', () => {
      const parsed = parsePollCreationText('!poll 8 tomorrow 9am —courts-strategy=book —max-courts=2 —title="Friday — 9am"');
      assert.ok(parsed);
      assert.equal(parsed.size, 8);
      assert.equal(parsed.courtsStrategy, 'book');
      assert.equal(parsed.maxCourts, 2);
      assert.equal(parsed.title, 'Friday — 9am');
    });

    it('parseRecurringPollText handles smart dashes on recurring options', () => {
      const parsed = parseRecurringPollText('!recurringpoll auto 7pm mon-thu —max-courts=3 –no-reminders');
      assert.ok(parsed);
      assert.equal(parsed.maxCourts, 3);
      assert.equal(parsed.reminders, false);
    });

    it('parseBookPollCourtsArgs handles smart dashes on --poll and --group', () => {
      const parsed = parseBookPollCourtsArgs('—poll=poll_123 Court 3 —group="Bot-testing"');
      assert.ok(parsed);
      assert.equal(parsed.target, 'poll_123');
      assert.equal(parsed.specificCourt, 'Court 3');
    });

    it('parseModifyCourtCommand handles smart dashes on --group', () => {
      const parsed = parseModifyCourtCommand('!modifycourt 194617 to Court 1 —group="Bot-testing"');
      assert.ok(parsed);
      assert.equal(parsed.reservationId, '194617');
      assert.equal(parsed.court, 'Court 1');
      assert.equal(parsed.group, 'Bot-testing');
    });

    it('routeCommand handles !releasecourt with em dash —keep-size end-to-end', async () => {
      const activePolls = new Map();
      const chatId = '120363403838804497@g.us';
      const pollId = 'poll_smart_dash';
      const pollState = {
        id: pollId,
        name: '🎾 Monday 7pm (8 spots)',
        when: 'Monday 7pm',
        size: 8,
        slotLimit: 8,
        status: 'active',
        remoteJid: chatId,
        creator: { name: 'Admin', jid: 'admin@s.whatsapp.net' },
        prebookedCourts: [
          { court: 'Court 1' },
          { court: 'Court 2' }
        ]
      };
      activePolls.set(pollId, pollState);

      const mockSock = {
        user: { id: 'tenbot@s.whatsapp.net' },
        groupMetadata: async () => ({
          participants: [{ id: 'admin@s.whatsapp.net', admin: 'admin' }]
        }),
        sendMessage: async () => ({ key: { id: 'msg_1', remoteJid: chatId } })
      };

      const res = await routeCommand(
        mockSock,
        '!releasecourt 1 —keep-size',
        chatId,
        'Admin',
        { key: { participant: 'admin@s.whatsapp.net', remoteJid: chatId } },
        {
          activePolls,
          recurringPolls: new Map(),
          latestPollIdByChat: new Map([[chatId, pollId]]),
          persistPolls: () => {}
        }
      );

      assert.match(res, /Poll size preserved at \*8 spots\*/i);
      assert.equal(pollState.size, 8);
      assert.equal(pollState.prebookedCourts.length, 1);
    });
  });
});
