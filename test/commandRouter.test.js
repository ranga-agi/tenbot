const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { routeCommand, executeTool, isAddressedToBot, stripLeadingTrigger } = require('../lib/commands/index');
const { handleGroupLineup, buildContextBlurb, getResponse } = require('../index');

describe('commandRouter', () => {
  const dummyContext = {
    chatHistories: new Map(),
    groupMetadataCache: new Map(),
    messageStore: new Map(),
    activePolls: new Map(),
    latestPollIdByChat: new Map(),
    recurringPolls: new Map(),
    persistPolls: () => {},
    nameFor: (jid) => jid || 'Someone'
  };

  describe('routeCommand', () => {
    it('should reply to !ping with pong 🏓', async () => {
      const res = await routeCommand(null, '!ping', 'chat@g.us', 'Alice', {}, dummyContext);
      assert.equal(res, 'pong 🏓');
    });

    it('should reply to !help with help documentation', async () => {
      const res = await routeCommand(null, '!help', 'chat@g.us', 'Alice', {}, dummyContext);
      assert.match(res, /Tennis Group Bot/);
    });

    it('should handle !aliases', async () => {
      const res = await routeCommand(null, '!aliases', 'chat@g.us', 'Alice', {}, dummyContext);
      assert.match(res, /Player Names & Aliases|No player aliases/);

      const listRes = await routeCommand(null, '!alias list', 'chat@g.us', 'Alice', {}, dummyContext);
      assert.match(listRes, /Player Names & Aliases|No player aliases/);
    });

    it('should handle !free and !notfree', async () => {
      const freeRes = await routeCommand(null, '!free tomorrow morning', 'chat@g.us', 'Alice', {}, dummyContext);
      assert.match(freeRes, /Alice is free tomorrow morning/);

      const notFreeRes = await routeCommand(null, '!notfree', 'chat@g.us', 'Alice', {}, dummyContext);
      assert.match(notFreeRes, /Removed Alice from the availability list/);
    });

    it('should return null for non-command messages so they fall through', async () => {
      const res = await routeCommand(null, 'hello everyone, who wants to hit today?', 'chat@g.us', 'Alice', {}, dummyContext);
      assert.equal(res, null);
    });

    it('should return null for unhandled queries to bot', async () => {
      const targetPoll = {
        remoteJid: 'chat@g.us',
        status: 'active'
      };
      const pollContext = {
        ...dummyContext,
        activePolls: new Map([['poll1', targetPoll]])
      };
      const res = await routeCommand(
        null,
        'who should I put my money on today for the win.',
        'chat@g.us',
        'PI',
        {},
        pollContext
      );
      assert.equal(res, null, 'Should return null for non-command queries so they fall through to general LLM');
    });
  });

  describe('handleGroupLineup in index.js', () => {
    it('should detect manual lineup, attribute to poll, record draw, and react with 🤖', async () => {
      const targetPoll = {
        remoteJid: 'chat@g.us',
        when: 'Today 9:00am',
        size: 4,
        type: 'fixed',
        status: 'resolved',
        lastPlayers: ['Alice', 'Bob', 'Charlie', 'Dave']
      };

      const sentMessages = [];
      const dummySock = {
        user: { id: 'bot@s.whatsapp.net' },
        sendMessage: async (jid, payload) => {
          sentMessages.push({ jid, payload });
          return { key: { id: 'msg1' } };
        }
      };

      const pollContext = {
        ...dummyContext,
        activePolls: new Map([['poll_resolved_1', targetPoll]])
      };

      const dummyMsg = {
        key: { remoteJid: 'chat@g.us', id: 'upd_lineup_msg', fromMe: false }
      };

      const res = await handleGroupLineup(
        dummySock,
        'Court 1: Alice & Charlie vs Bob & Dave',
        'chat@g.us',
        'Alice',
        dummyMsg,
        pollContext
      );

      assert.equal(res, true); // Handled manual lineup returns true
      assert.deepEqual(targetPoll.lastPlayers, ['Alice', 'Charlie', 'Bob', 'Dave']);
      assert.ok(targetPoll.lastSchedule);
      const reactMsg = sentMessages.find((m) => m.payload?.react?.text === '🤖');
      assert.ok(reactMsg, 'Expected 🤖 bot emoji reaction to be sent for updated matchups');
      assert.equal(reactMsg.payload.react.key.id, 'upd_lineup_msg');
    });

    it('should return null for non-lineup messages', async () => {
      const targetPoll = {
        remoteJid: 'chat@g.us',
        status: 'active'
      };
      const pollContext = {
        ...dummyContext,
        activePolls: new Map([['poll1', targetPoll]])
      };
      const res = await handleGroupLineup(
        null,
        'hello everyone, who wants to hit today?',
        'chat@g.us',
        'Alice',
        {},
        pollContext
      );
      assert.equal(res, null);
    });
  });

  describe('isAddressedToBot', () => {
    const botJids = ['1234567890@s.whatsapp.net', '24104010813588@lid'];

    it('should recognize leading @tenbot trigger', () => {
      const res = isAddressedToBot('@tenbot create a poll for 9am', {}, botJids);
      assert.equal(res.addressed, true);
      assert.equal(res.promptText, 'create a poll for 9am');
    });

    it('should recognize leading !tenbot and ~tenbot triggers', () => {
      const bang = isAddressedToBot('!tenbot create a poll for 9am', {}, botJids);
      assert.equal(bang.addressed, true);
      assert.equal(bang.promptText, 'create a poll for 9am');

      const tilde = isAddressedToBot('~tenbot: who is playing today?', {}, botJids);
      assert.equal(tilde.addressed, true);
      assert.equal(tilde.promptText, 'who is playing today?');

      const hyphen = isAddressedToBot('!Tenbot - !ping', {}, botJids);
      assert.equal(hyphen.addressed, true);
      assert.equal(hyphen.promptText, '!ping');

      assert.equal(stripLeadingTrigger('!tenbot hello'), 'hello');
      assert.equal(stripLeadingTrigger('~tenbot, check courts'), 'check courts');
    });

    it('should not match !tenbotfoo or mid-sentence !tenbot/~tenbot', () => {
      const partial = isAddressedToBot('!tenbotfoo hello', {}, botJids);
      assert.equal(partial.addressed, false);

      const mid = isAddressedToBot('hey !tenbot what is up', {}, botJids);
      assert.equal(mid.addressed, false);

      const midTilde = isAddressedToBot('hey ~tenbot what is up', {}, botJids);
      assert.equal(midTilde.addressed, false);
    });

    it('should recognize @botNumber prefix directly in text without mentionedJid', () => {
      const res = isAddressedToBot('@24104010813588 who should I put my money on today for the win.', {}, botJids);
      assert.equal(res.addressed, true);
      assert.equal(res.promptText, 'who should I put my money on today for the win.');
    });

    it('should recognize @tenbot mentioned in contextInfo.mentionedJid', () => {
      const msg = {
        message: {
          extendedTextMessage: {
            contextInfo: {
              mentionedJid: ['1234567890@s.whatsapp.net']
            }
          }
        }
      };
      const res = isAddressedToBot('@1234567890 what is the schedule', msg, botJids);
      assert.equal(res.addressed, true);
      assert.equal(res.promptText, 'what is the schedule');
    });

    it('should not be addressed when another user is mentioned', () => {
      const msg = {
        message: {
          extendedTextMessage: {
            contextInfo: {
              mentionedJid: ['9999999999@s.whatsapp.net']
            }
          }
        }
      };
      const res = isAddressedToBot('hey @9999999999 are you playing today?', msg, botJids);
      assert.equal(res.addressed, false);
      assert.equal(res.promptText, 'hey @9999999999 are you playing today?');
    });
  });

  describe('executeTool', () => {
    it('should dispatch parse_lineup to executeLineupTool', async () => {
      const targetPoll = {
        remoteJid: 'chat@g.us',
        when: 'Today 9:00am',
        size: 4,
        status: 'active',
        lastPlayers: ['Alice', 'Bob', 'Charlie', 'Dave']
      };
      const pollContext = {
        ...dummyContext,
        activePolls: new Map([['poll_1', targetPoll]])
      };
      const res = await executeTool(
        null,
        'chat@g.us',
        'Alice',
        {
          name: 'parse_lineup',
          input: { text: 'Court 1: Alice & Bob vs Charlie & Dave at 9:00am' }
        },
        { key: { id: 'msg1', remoteJid: 'chat@g.us' } },
        pollContext
      );
      assert.match(res, /Successfully parsed and recorded lineup/);
    });

    it('should return error message for unknown tool', async () => {
      const res = await executeTool(null, 'chat@g.us', 'Alice', { name: 'non_existent_tool', input: {} }, {}, dummyContext);
      assert.match(res, /Unknown tool/);
    });

    it('should execute get_aliases tool for full list and specific lookup', async () => {
      const namesStore = require('../lib/names');
      const origGetAllEntries = namesStore.getAllEntries;
      const origFind = namesStore.findIdByNameOrAlias;

      const fakeEntries = [
        { id: 'p1@lid', name: 'PI', fullName: 'Pramod Immaneni', aliases: ['Pramod'] },
        { id: 'p2@lid', name: 'Bob', fullName: 'Bob Smith', aliases: [] }
      ];
      namesStore.getAllEntries = () => fakeEntries;
      namesStore.findIdByNameOrAlias = (q) => {
        const lower = String(q).trim().toLowerCase();
        const found = fakeEntries.find(
          (e) => e.name.toLowerCase() === lower || e.fullName.toLowerCase() === lower || e.aliases.some((a) => a.toLowerCase() === lower)
        );
        return found ? { id: found.id, entry: found } : null;
      };

      try {
        const allRes = await executeTool(null, 'chat@g.us', 'PI', { name: 'get_aliases', input: {} }, {}, dummyContext);
        assert.match(allRes, /Player Names & Aliases/);
        assert.match(allRes, /PI \(aliases: Pramod\)/);

        const lookupRes = await executeTool(null, 'chat@g.us', 'PI', { name: 'get_aliases', input: { alias: 'Pramod' } }, {}, dummyContext);
        assert.match(lookupRes, /Alias lookup for "Pramod"/);
        assert.match(lookupRes, /PI \(full name: Pramod Immaneni\) \(aliases: Pramod\)/);

        const missingRes = await executeTool(null, 'chat@g.us', 'PI', { name: 'get_aliases', input: { alias: 'DeletedAlias' } }, {}, dummyContext);
        assert.match(missingRes, /No player or alias matching "DeletedAlias" was found/);
        assert.match(missingRes, /Player Names & Aliases/);
      } finally {
        namesStore.getAllEntries = origGetAllEntries;
        namesStore.findIdByNameOrAlias = origFind;
      }
    });

    it('should execute get_ratings tool for group list and single player lookup', async () => {
      const namesStore = require('../lib/names');
      const ratings = require('../lib/ratings');
      const origGetAllRatings = ratings.getAllRatings;
      const origFindPlayer = ratings.findPlayer;
      const origGetGroupMembers = namesStore.getGroupMembers;
      const origFindName = namesStore.findIdByNameOrAlias;
      const origGetName = namesStore.getName;

      ratings.getAllRatings = () => [
        { id: 'p1@lid', name: 'Alice', rating: 3.75 },
        { id: 'p2@lid', name: 'Bob', rating: 3.25 },
        { id: 'p3@lid', name: 'Outsider', rating: 4.1 }
      ];
      namesStore.getGroupMembers = () => new Set(['p1@lid', 'p2@lid']);
      namesStore.findIdByNameOrAlias = (q) => {
        if (String(q).toLowerCase() === 'ali' || String(q).toLowerCase() === 'alice' || q === 'p1@lid') {
          return { id: 'p1@lid', entry: { name: 'Alice' } };
        }
        return null;
      };
      namesStore.getName = (id) => (id === 'p1@lid' ? 'Alice' : null);
      ratings.findPlayer = (name, jid) => {
        if (jid === 'p1@lid' || String(name).toLowerCase() === 'alice') {
          return { key: 'p1@lid', entry: { rating: 3.75 } };
        }
        return null;
      };

      try {
        const groupRes = await executeTool(null, 'chat@g.us', 'Alice', { name: 'get_ratings', input: {} }, {}, dummyContext);
        assert.match(groupRes, /Alice — 3\.75/);
        assert.match(groupRes, /Bob — 3\.25/);
        assert.equal(groupRes.includes('Outsider'), false);

        const singleRes = await executeTool(null, 'chat@g.us', 'Bob', { name: 'get_ratings', input: { player: 'Ali' } }, {}, dummyContext);
        assert.match(singleRes, /Alice: 3\.75/);

        const selfRes = await executeTool(null, 'chat@g.us', 'Alice', { name: 'get_ratings', input: { player: 'me' } }, { key: { participant: 'p1@lid', remoteJid: 'chat@g.us' } }, dummyContext);
        assert.match(selfRes, /Alice: 3\.75/);

        const missingRes = await executeTool(null, 'chat@g.us', 'Bob', { name: 'get_ratings', input: { player: 'Ghost' } }, {}, dummyContext);
        assert.match(missingRes, /No recorded rating found for "Ghost"/);
        assert.match(missingRes, /Alice — 3\.75/);
      } finally {
        ratings.getAllRatings = origGetAllRatings;
        ratings.findPlayer = origFindPlayer;
        namesStore.getGroupMembers = origGetGroupMembers;
        namesStore.findIdByNameOrAlias = origFindName;
        namesStore.getName = origGetName;
      }
    });

    it('should execute report_score, get_scores, edit_score, delete_score, and get_leaderboard tools', async () => {
      const fs = require('fs');
      const stats = require('../lib/stats');
      const ratings = require('../lib/ratings');
      const namesStore = require('../lib/names');

      const testGroupId = '120363999888777666@g.us';
      const groupScoresFile = stats.getScoresFilePath(testGroupId);
      const origFindName = namesStore.findIdByNameOrAlias;
      const origGroupMembers = namesStore.getGroupMembers;

      namesStore.findIdByNameOrAlias = (q) => {
        const lower = String(q).trim().toLowerCase();
        if (lower === 'ali' || lower === 'alice') return { id: 'p1@lid', entry: { name: 'Alice' } };
        if (lower === 'bob') return { id: 'p2@lid', entry: { name: 'Bob' } };
        return null;
      };
      namesStore.getGroupMembers = () => new Set(['p1@lid', 'p2@lid']);
      ratings.setRating('Alice', 3.5);
      ratings.setRating('Bob', 3.5);

      try {
        if (fs.existsSync(groupScoresFile)) fs.unlinkSync(groupScoresFile);

        const sock = {
          groupMetadata: async () => ({
            participants: [{ id: 'p1@lid', admin: 'admin' }]
          })
        };
        const msg = { key: { participant: 'p1@lid', remoteJid: testGroupId } };

        // 1. Report score via structured args
        const reportRes = await executeTool(null, testGroupId, 'Alice', {
          name: 'report_score',
          input: { side1: ['Ali'], side2: ['Bob'], score: '6-4, 7-5' }
        }, msg, dummyContext);
        assert.match(reportRes, /Recorded: Alice vs Bob \(6-4 7-5\)/);

        // 2. Report second score via raw text
        const reportTextRes = await executeTool(null, testGroupId, 'Alice', {
          name: 'report_score',
          input: { text: 'Bob vs Alice (6-3 6-4)' }
        }, msg, dummyContext);
        assert.match(reportTextRes, /Recorded: Bob vs Alice \(6-3 6-4\)/);

        // 3. Get scores (filtered by player alias and limit)
        const scoresRes = await executeTool(null, testGroupId, 'Alice', {
          name: 'get_scores',
          input: { player: 'Ali', limit: 1 }
        }, msg, dummyContext);
        assert.match(scoresRes, /Player: Alice/);
        assert.match(scoresRes, /#1/);
        assert.equal(scoresRes.includes('#2'), false);

        // 4. Get leaderboard
        const boardRes = await executeTool(null, testGroupId, 'Alice', {
          name: 'get_leaderboard',
          input: {}
        }, msg, dummyContext);
        assert.match(boardRes, /Leaderboard/);
        assert.match(boardRes, /Alice/);
        assert.match(boardRes, /Bob/);

        // 5. Edit score #1
        const editRes = await executeTool(sock, testGroupId, 'Alice', {
          name: 'edit_score',
          input: { scoreId: '#1', score: '6-2 6-2' }
        }, msg, dummyContext);
        assert.match(editRes, /Updated match score/);
        assert.match(editRes, /6-2 6-2/);

        // 6. Delete score #1
        const delRes = await executeTool(sock, testGroupId, 'Alice', {
          name: 'delete_score',
          input: { scoreId: '#1' }
        }, msg, dummyContext);
        assert.match(delRes, /Deleted match score/);
      } finally {
        namesStore.findIdByNameOrAlias = origFindName;
        namesStore.getGroupMembers = origGroupMembers;
        if (fs.existsSync(groupScoresFile)) fs.unlinkSync(groupScoresFile);
      }
    });

    it('should execute get_availability tool scoped to the group', async () => {
      const fs = require('fs');
      const stats = require('../lib/stats');
      const testGroupId = '120363999888777555@g.us';
      const groupAvailFile = stats.getAvailabilityFilePath(testGroupId);

      try {
        if (fs.existsSync(groupAvailFile)) fs.unlinkSync(groupAvailFile);

        const emptyRes = await executeTool(null, testGroupId, 'Alice', {
          name: 'get_availability',
          input: {}
        }, {}, dummyContext);
        assert.match(emptyRes, /No one has marked themselves free yet/);

        stats.setAvailable('Alice', 'Sat morning', testGroupId);
        stats.setAvailable('Bob', 'Sun 4pm', testGroupId);

        const listRes = await executeTool(null, testGroupId, 'Alice', {
          name: 'get_availability',
          input: {}
        }, {}, dummyContext);
        assert.match(listRes, /Who's free:/);
        assert.match(listRes, /Alice – Sat morning/);
        assert.match(listRes, /Bob – Sun 4pm/);
      } finally {
        if (fs.existsSync(groupAvailFile)) fs.unlinkSync(groupAvailFile);
      }
    });

    it('should execute get_poll_status tool with active/targetId filters', async () => {
      const testGroupId = '120363999888777444@g.us';
      const otherGroupId = '120363999888777333@g.us';
      const localActivePolls = new Map([
        ['poll_1', {
          remoteJid: testGroupId,
          size: 4,
          when: 'Saturday 9am',
          status: 'active',
          creator: { name: 'Alice', jid: 'p1@lid' },
          options: ['Player 2', 'Player 3', 'Player 4']
        }],
        ['poll_2', {
          remoteJid: testGroupId,
          size: 4,
          when: 'Sunday 4pm',
          status: 'resolved',
          creator: { name: 'Bob', jid: 'p2@lid' },
          options: ['Player 2', 'Player 3', 'Player 4']
        }],
        ['poll_other', {
          remoteJid: otherGroupId,
          size: 4,
          when: 'Monday 8am',
          status: 'active',
          creator: { name: 'Charlie', jid: 'p3@lid' },
          options: ['Player 2', 'Player 3', 'Player 4']
        }]
      ]);
      const pollContext = {
        ...dummyContext,
        activePolls: localActivePolls,
        recurringPolls: new Map()
      };

      const activeRes = await executeTool(null, testGroupId, 'Alice', {
        name: 'get_poll_status',
        input: { filter: 'active' }
      }, {}, pollContext);
      assert.match(activeRes, /Poll poll_1/);
      assert.equal(activeRes.includes('poll_2'), false);
      assert.equal(activeRes.includes('poll_other'), false);

      const targetRes = await executeTool(null, testGroupId, 'Alice', {
        name: 'get_poll_status',
        input: { targetId: 'Sunday 4pm' }
      }, {}, pollContext);
      assert.match(targetRes, /Poll poll_2/);
      assert.equal(targetRes.includes('poll_1'), false);
    });
  });

  describe('buildContextBlurb', () => {
    it('should omit static leaderboard, recent matches, availability, active polls, and recurring polls from context blurb', () => {
      const blurb = buildContextBlurb('120363000000000000@g.us');
      assert.equal(blurb.includes('Leaderboard (top 5):'), false);
      assert.equal(blurb.includes('Recent matches:'), false);
      assert.equal(blurb.includes('Current availability:'), false);
      assert.equal(blurb.includes('Active poll:'), false);
      assert.equal(blurb.includes('Recurring daily polls:'), false);
      assert.match(blurb, /Current time in San Jose, CA \(Pacific Time\):/);
      assert.match(blurb, /Group Chat History \(Past 2 Weeks\)/);
    });
  });
});
