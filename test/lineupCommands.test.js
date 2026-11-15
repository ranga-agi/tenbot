const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  isSamePlayerName,
  levenshteinDistance,
  computeNameMatchScore,
  findClosestCandidate,
  buildCandidatePools,
  resolvePlayerWithFallback,
  extractTimeFromLineupMessage,
  getPollMatchTime,
  findBestMatchingPollForLineup,
  reconcileMissingPlayer,
  handleManualLineup,
  executeLineupTool,
  LINEUP_PARSER_TOOL
} = require('../lib/commands/lineupCommands');
const ratings = require('../lib/ratings');

describe('lineupCommands', () => {
  describe('LINEUP_PARSER_TOOL', () => {
    it('should be defined with valid tool name and schema', () => {
      assert.equal(LINEUP_PARSER_TOOL.name, 'parse_lineup');
      assert.equal(typeof LINEUP_PARSER_TOOL.description, 'string');
      assert.ok(LINEUP_PARSER_TOOL.description.length > 0);
      assert.equal(LINEUP_PARSER_TOOL.input_schema.type, 'object');
      assert.ok(LINEUP_PARSER_TOOL.input_schema.properties.isLineup);
      assert.ok(LINEUP_PARSER_TOOL.input_schema.properties.players);
      assert.ok(LINEUP_PARSER_TOOL.input_schema.properties.sets);
      assert.deepEqual(LINEUP_PARSER_TOOL.input_schema.required, ['isLineup']);
    });
  });

  describe('isSamePlayerName', () => {
    it('should match identical names case-insensitively', () => {
      assert.equal(isSamePlayerName('Roger Federer', 'roger federer'), true);
      assert.equal(isSamePlayerName('Alice', 'ALICE'), true);
    });

    it('should match first name and full name prefixes', () => {
      assert.equal(isSamePlayerName('Pramod Immaneni', 'Pramod'), true);
      assert.equal(isSamePlayerName('Pramod', 'Pramod Immaneni'), true);
    });

    it('should return false for different names', () => {
      assert.equal(isSamePlayerName('Alice', 'Bob'), false);
      assert.equal(isSamePlayerName('John', 'David'), false);
    });

    it('should return false for placeholders', () => {
      assert.equal(isSamePlayerName('Player 1', 'Player 2'), false);
      assert.equal(isSamePlayerName('Alice', 'Player 1'), false);
    });
  });

  describe('extractTimeFromLineupMessage', () => {
    it('should extract 12-hour formatted times', () => {
      const res1 = extractTimeFromLineupMessage('Matchup at 7:00pm on Court 3');
      assert.deepEqual(res1, { hour: 19, minute: 0, display: '7:00pm' });

      const res2 = extractTimeFromLineupMessage('Starting at 9am');
      assert.deepEqual(res2, { hour: 9, minute: 0, display: '9am' });
    });

    it('should extract 24-hour formatted times', () => {
      const res = extractTimeFromLineupMessage('Matches at 18:30 on courts 1-2');
      assert.deepEqual(res, { hour: 18, minute: 30, display: '18:30' });
    });

    it('should return null if no time is mentioned', () => {
      const res = extractTimeFromLineupMessage('Court 1: Alice & Bob vs Charlie & David');
      assert.equal(res, null);
    });
  });

  describe('getPollMatchTime', () => {
    it('should extract time from playAt ISO string', () => {
      const pollState = {
        playAt: '2026-11-14T17:00:00.000Z' // 9:00 AM PST
      };
      const res = getPollMatchTime(pollState);
      assert.ok(res);
      assert.equal(typeof res.hour, 'number');
      assert.equal(typeof res.minute, 'number');
    });

    it('should extract time from when string', () => {
      const pollState = {
        when: 'Saturday 7:00pm'
      };
      const res = getPollMatchTime(pollState);
      assert.deepEqual(res, { hour: 19, minute: 0 });
    });
  });

  describe('findBestMatchingPollForLineup', () => {
    it('should match Tier 1 poll when both players and time match exactly', () => {
      const poll1 = {
        remoteJid: 'test_chat@g.us',
        when: 'Today 7:00pm',
        size: 4,
        status: 'active',
        lastPlayers: ['Alice', 'Bob', 'Charlie', 'David']
      };
      const poll2 = {
        remoteJid: 'test_chat@g.us',
        when: 'Today 9:00am',
        size: 4,
        status: 'active',
        lastPlayers: ['Eve', 'Frank', 'Grace', 'Heidi']
      };
      const activePolls = new Map([
        ['poll_7pm', poll1],
        ['poll_9am', poll2]
      ]);

      const lineup = {
        type: 'doubles',
        time: '7:00pm',
        players: ['Alice', 'Bob', 'Charlie', 'David']
      };

      const res = findBestMatchingPollForLineup({
        activePolls,
        latestPollIdByChat: new Map([['test_chat@g.us', 'poll_9am']]),
        chatId: 'test_chat@g.us',
        lineup,
        messageText: 'Lineup at 7:00pm: Alice, Bob, Charlie, David'
      });

      assert.equal(res.targetPollId, 'poll_7pm');
      assert.equal(res.targetPollState, poll1);
      assert.match(res.matchInfo, /exact_players_and_time/);
    });

    it('should match Tier 2 poll when message has no time but player overlap is >= 50%', () => {
      const poll1 = {
        remoteJid: 'test_chat@g.us',
        when: 'Today 8:00pm',
        size: 4,
        status: 'active',
        lastPlayers: ['Alice', 'Bob', 'Charlie', 'David']
      };
      const activePolls = new Map([['poll_8pm', poll1]]);

      const lineup = {
        type: 'doubles',
        players: ['Alice', 'Bob', 'Stranger1', 'Stranger2']
      };

      const res = findBestMatchingPollForLineup({
        activePolls,
        latestPollIdByChat: new Map([['test_chat@g.us', 'poll_8pm']]),
        chatId: 'test_chat@g.us',
        lineup,
        messageText: 'Lineup: Alice & Bob vs Stranger1 & Stranger2'
      });

      assert.equal(res.targetPollId, 'poll_8pm');
      assert.match(res.matchInfo, /qualifying_match/);
    });

    it('should reject match when player overlap is below 50%', () => {
      const poll1 = {
        remoteJid: 'test_chat@g.us',
        when: 'Today 8:00pm',
        size: 4,
        status: 'active',
        lastPlayers: ['Alice', 'Bob', 'Charlie', 'David']
      };
      const activePolls = new Map([['poll_8pm', poll1]]);

      const lineup = {
        type: 'doubles',
        players: ['Alice', 'X1', 'X2', 'X3']
      };

      const res = findBestMatchingPollForLineup({
        activePolls,
        latestPollIdByChat: new Map([['test_chat@g.us', 'poll_8pm']]),
        chatId: 'test_chat@g.us',
        lineup,
        messageText: 'Lineup: Alice & X1 vs X2 & X3'
      });

      assert.equal(res.targetPollId, null);
      assert.equal(res.targetPollState, null);
    });

    it('should match a resolved poll when updating matchups even if another poll is active in the same chat', () => {
      const resolvedPoll = {
        remoteJid: 'test_chat@g.us',
        name: 'Morning Match',
        when: 'Today 9:00am',
        size: 4,
        status: 'resolved',
        lastPlayers: ['Alice', 'Bob', 'Charlie', 'Dave']
      };
      const activePoll = {
        remoteJid: 'test_chat@g.us',
        name: 'Evening Match',
        when: 'Today 6:00pm',
        size: 4,
        status: 'active',
        lastPlayers: ['Eve', 'Frank', 'Grace', 'Heidi']
      };
      const activePolls = new Map([
        ['poll_morning', resolvedPoll],
        ['poll_evening', activePoll]
      ]);

      const updatedLineup = {
        type: 'doubles',
        time: '9:00am',
        players: ['Alice', 'Charlie', 'Bob', 'Dave'],
        sets: [{
          set: 1,
          courts: [{ court: 1, teamA: ['Alice', 'Charlie'], teamB: ['Bob', 'Dave'] }]
        }]
      };

      const res = findBestMatchingPollForLineup({
        activePolls,
        latestPollIdByChat: new Map([['test_chat@g.us', 'poll_evening']]),
        chatId: 'test_chat@g.us',
        lineup: updatedLineup,
        messageText: 'Updated matchups: Court 1: Alice & Charlie vs Bob & Dave 9am'
      });

      assert.equal(res.targetPollId, 'poll_morning');
      assert.equal(res.targetPollState, resolvedPoll);
      assert.match(res.matchInfo, /exact_players_and_time/);
    });

    it('should match a resolved poll on player overlap when updating matchups without time', () => {
      const resolvedPoll = {
        remoteJid: 'test_chat@g.us',
        name: 'Morning Match',
        when: 'Today 9:00am',
        size: 4,
        status: 'resolved',
        lastPlayers: ['Alice', 'Bob', 'Charlie', 'Dave']
      };
      const activePoll = {
        remoteJid: 'test_chat@g.us',
        name: 'Evening Match',
        when: 'Today 6:00pm',
        size: 4,
        status: 'active',
        lastPlayers: ['Eve', 'Frank', 'Grace', 'Heidi']
      };
      const activePolls = new Map([
        ['poll_morning', resolvedPoll],
        ['poll_evening', activePoll]
      ]);

      const updatedLineup = {
        type: 'doubles',
        players: ['Alice', 'Charlie', 'Bob', 'Dave'],
        sets: [{
          set: 1,
          courts: [{ court: 1, teamA: ['Alice', 'Charlie'], teamB: ['Bob', 'Dave'] }]
        }]
      };

      const res = findBestMatchingPollForLineup({
        activePolls,
        latestPollIdByChat: new Map([['test_chat@g.us', 'poll_evening']]),
        chatId: 'test_chat@g.us',
        lineup: updatedLineup,
        messageText: 'Change matchups: Court 1: Alice & Charlie vs Bob & Dave'
      });

      assert.equal(res.targetPollId, 'poll_morning');
      assert.equal(res.targetPollState, resolvedPoll);
      assert.match(res.matchInfo, /qualifying_match/);
    });
  });

  describe('reconcileMissingPlayer', () => {
    it('should reconcile singles match when 1 player is detected instead of 2', () => {
      const lineup = {
        type: 'singles',
        players: ['Alice'],
        sets: [{
          set: 1,
          courts: [{ court: 1, teamA: ['Alice'], teamB: [] }]
        }]
      };

      reconcileMissingPlayer(lineup, 'poll_singles', {
        size: 2,
        courtBookingType: 'singles',
        creator: { name: 'Bob', jid: 'bob@s.whatsapp.net' }
      }, 'Bob', 'bot@s.whatsapp.net', new Map());

      assert.equal(lineup.players.length, 2);
      assert.ok(lineup.players.includes('Bob'));
      assert.deepEqual(lineup.sets[0].courts[0].teamB, ['Bob']);
    });

    it('should reconcile 2-court doubles match when 7 players are detected instead of 8', () => {
      const lineup = {
        type: 'doubles',
        players: ['P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P7'],
        sets: [{
          set: 1,
          courts: [
            { court: 1, teamA: ['P1', 'P2'], teamB: ['P3', 'P4'] },
            { court: 2, teamA: ['P5', 'P6'], teamB: ['P7'] }
          ]
        }]
      };

      reconcileMissingPlayer(lineup, 'poll_8', {
        size: 8,
        creator: { name: 'Player8', jid: 'p8@s.whatsapp.net' },
        lastPlayers: ['P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P7', 'Player8']
      }, 'Player8', 'bot@s.whatsapp.net', new Map());

      assert.equal(lineup.players.length, 8);
      assert.ok(lineup.players.includes('Player8'));
      assert.deepEqual(lineup.sets[0].courts[1].teamB, ['P7', 'Player8']);
    });

    it('should reconcile 3-court doubles match when 11 players are detected instead of 12', () => {
      const lineup = {
        type: 'doubles',
        players: ['P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P7', 'P8', 'P9', 'P10', 'P11'],
        sets: [{
          set: 1,
          courts: [
            { court: 1, teamA: ['P1', 'P2'], teamB: ['P3', 'P4'] },
            { court: 2, teamA: ['P5', 'P6'], teamB: ['P7', 'P8'] },
            { court: 3, teamA: ['P9', 'P10'], teamB: ['P11'] }
          ]
        }]
      };

      reconcileMissingPlayer(lineup, 'poll_12', {
        size: 12,
        creator: { name: 'P12', jid: 'p12@s.whatsapp.net' },
        lastPlayers: ['P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P7', 'P8', 'P9', 'P10', 'P11', 'P12']
      }, 'P12', 'bot@s.whatsapp.net', new Map());

      assert.equal(lineup.players.length, 12);
      assert.ok(lineup.players.includes('P12'));
      assert.deepEqual(lineup.sets[0].courts[2].teamB, ['P11', 'P12']);
    });

    it('should reconcile standalone lineup without active poll using sender', () => {
      const lineup = {
        type: 'doubles',
        players: ['Alice', 'Bob', 'Charlie'],
        sets: [{
          set: 1,
          courts: [{ court: 1, teamA: ['Alice', 'Bob'], teamB: ['Charlie'] }]
        }]
      };

      reconcileMissingPlayer(lineup, null, null, 'Dave', 'bot@s.whatsapp.net', new Map());

      assert.equal(lineup.players.length, 4);
      assert.ok(lineup.players.includes('Dave'));
      assert.deepEqual(lineup.sets[0].courts[0].teamB, ['Charlie', 'Dave']);
    });

    it('should not modify lineup when player count is already a valid configuration', () => {
      const lineup = {
        type: 'doubles',
        players: ['Alice', 'Bob', 'Charlie', 'Dave'],
        sets: [{
          set: 1,
          courts: [{ court: 1, teamA: ['Alice', 'Bob'], teamB: ['Charlie', 'Dave'] }]
        }]
      };

      reconcileMissingPlayer(lineup, 'poll_4', {
        size: 4,
        creator: { name: 'Eve' }
      }, 'Eve', 'bot@s.whatsapp.net', new Map());

      assert.equal(lineup.players.length, 4);
      assert.equal(lineup.players.includes('Eve'), false);
    });
  });

  describe('resolvePlayerWithFallback', () => {
    it('should resolve typos to voters who voted (Priority 1)', () => {
      const voterCandidates = [
        { canonicalName: 'Terence Park', name: 'Terence Park', fullName: 'Terence Park', aliases: [] },
        { canonicalName: 'Somnath Mani', name: 'Somnath Mani', fullName: 'Somnath Mani', aliases: [] }
      ];
      const groupCandidates = [
        { canonicalName: 'David S', name: 'David S', fullName: 'David S', aliases: [] }
      ];

      // "Terrence" (edit distance 1) should resolve to voter "Terence Park"
      const res1 = resolvePlayerWithFallback('Terrence', voterCandidates, groupCandidates);
      assert.equal(res1, 'Terence Park');

      // "Som" (prefix) should resolve to voter "Somnath Mani"
      const res2 = resolvePlayerWithFallback('Som', voterCandidates, groupCandidates);
      assert.equal(res2, 'Somnath Mani');
    });

    it('should resolve to group members when not found among voters (Priority 2)', () => {
      const voterCandidates = [
        { canonicalName: 'Alice', name: 'Alice', fullName: 'Alice', aliases: [] }
      ];
      const groupCandidates = [
        { canonicalName: 'David Smith', name: 'David Smith', fullName: 'David Smith', aliases: ['Dave'] }
      ];

      // "Dave" is not a voter, but is in groupCandidates aliases
      const res = resolvePlayerWithFallback('Dave', voterCandidates, groupCandidates);
      assert.equal(res, 'David Smith');
    });

    it('should prioritize voters over group members if both have potential matches', () => {
      const voterCandidates = [
        { canonicalName: 'John Miller', name: 'John Miller', fullName: 'John Miller', aliases: [] }
      ];
      const groupCandidates = [
        { canonicalName: 'Johnathan Smith', name: 'Johnathan Smith', fullName: 'Johnathan Smith', aliases: [] }
      ];

      // Query "John" matches voter "John Miller" first
      const res = resolvePlayerWithFallback('John', voterCandidates, groupCandidates);
      assert.equal(res, 'John Miller');
    });

    it('should leave unknown names untouched without error', () => {
      const voterCandidates = [
        { canonicalName: 'Alice', name: 'Alice', fullName: 'Alice', aliases: [] }
      ];
      const groupCandidates = [
        { canonicalName: 'Bob', name: 'Bob', fullName: 'Bob', aliases: [] }
      ];

      const res = resolvePlayerWithFallback('Mysterious Stranger', voterCandidates, groupCandidates);
      assert.equal(res, 'Mysterious Stranger');
    });
  });

  describe('handleManualLineup', () => {
    it('should update lastPlayers, lastSchedule and send 🤖 reaction on a resolved poll', async () => {
      const targetPoll = {
        remoteJid: 'test_chat@g.us',
        name: 'Morning Match',
        when: 'Today 9:00am',
        size: 4,
        status: 'resolved',
        lastPlayers: ['Alice', 'Bob', 'Charlie', 'Dave'],
        lastSchedule: null
      };

      const activePolls = new Map([['poll_resolved', targetPoll]]);
      const sentReactions = [];
      const dummySock = {
        user: { id: 'bot@s.whatsapp.net' },
        sendMessage: async (jid, payload) => {
          if (payload.react) {
            sentReactions.push({ jid, react: payload.react });
          }
          return { key: { id: 'msg1' } };
        }
      };

      const updatedLineup = {
        type: 'doubles',
        time: '9:00am',
        players: ['Alice', 'Charlie', 'Bob', 'Dave'],
        sets: [{
          set: 1,
          courts: [{ court: 1, teamA: ['Alice', 'Charlie'], teamB: ['Bob', 'Dave'] }]
        }]
      };

      let persisted = false;
      const context = {
        activePolls,
        persistPolls: () => { persisted = true; },
        messageStore: new Map()
      };

      const dummyMsg = {
        key: { remoteJid: 'test_chat@g.us', id: 'lineup_msg_123', fromMe: false }
      };

      await handleManualLineup(
        dummySock,
        'test_chat@g.us',
        'Alice',
        updatedLineup,
        dummyMsg,
        'Change matchups: Court 1: Alice & Charlie vs Bob & Dave 9am',
        context
      );

      assert.equal(targetPoll.status, 'resolved');
      assert.equal(targetPoll.manualLineupPosted, true);
      assert.deepEqual(targetPoll.lastPlayers, ['Alice', 'Charlie', 'Bob', 'Dave']);
      assert.equal(targetPoll.lastSchedule, updatedLineup);
      assert.equal(persisted, true);
      assert.equal(sentReactions.length, 1);
      assert.equal(sentReactions[0].react.text, '🤖');
      assert.deepEqual(sentReactions[0].react.key, dummyMsg.key);
    });

    it('should automatically add poll creator as 4th player when 3 players are posted for a 4-player doubles court', async () => {
      const targetPoll = {
        remoteJid: 'test_chat@g.us',
        when: 'Today 7:00am',
        size: 4,
        status: 'active',
        creator: { name: 'Pramod Immaneni', jid: 'pramod@s.whatsapp.net' },
        lastPlayers: ['Pramod Immaneni', 'Srinivas Chinnamalli', 'Vikram Takru', 'Ghufran Ahmed'],
        lastSchedule: null
      };

      const activePolls = new Map([['poll_7am', targetPoll]]);
      const sentMessages = [];
      const dummySock = {
        user: { id: 'bot@s.whatsapp.net' },
        sendMessage: async (jid, payload) => {
          sentMessages.push({ jid, payload });
          return { key: { id: 'msg1' } };
        }
      };

      // 3 players tagged by the creator on Court 3
      const threePlayerLineup = {
        type: 'singles',
        time: '7:00am',
        players: ['Srinivas Chinnamalli', 'Vikram Takru', 'Ghufran Ahmed'],
        sets: [{
          set: 1,
          courts: [{ court: 3, teamA: ['Srinivas Chinnamalli', 'Vikram Takru'], teamB: ['Ghufran Ahmed'] }]
        }]
      };

      let persisted = false;
      const context = {
        activePolls,
        persistPolls: () => { persisted = true; },
        messageStore: new Map()
      };

      const dummyMsg = {
        key: { remoteJid: 'test_chat@g.us', id: 'lineup_msg_456', fromMe: false }
      };

      await handleManualLineup(
        dummySock,
        'test_chat@g.us',
        'Pramod Immaneni',
        threePlayerLineup,
        dummyMsg,
        '@Srinivas Chinnamalli @Vikram Takru @Ghufran Ahmed Court 3 7.00 AM',
        context
      );

      assert.equal(targetPoll.status, 'resolved');
      assert.equal(threePlayerLineup.type, 'doubles');
      assert.equal(threePlayerLineup.players.length, 4);
      assert.ok(threePlayerLineup.players.includes('Pramod Immaneni'));
      const court3 = threePlayerLineup.sets[0].courts[0];
      assert.equal(court3.teamA.length + court3.teamB.length, 4);
      assert.ok(court3.teamB.includes('Pramod Immaneni'));
      assert.equal(persisted, true);
    });

    it('should reconcile 2-court doubles match when 7 players are posted for an 8-player poll', async () => {
      const targetPoll = {
        remoteJid: 'test_chat@g.us',
        when: 'Today 8:00am',
        size: 8,
        status: 'active',
        creator: { name: 'Player8', jid: 'p8@s.whatsapp.net' },
        lastPlayers: ['P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P7', 'Player8'],
        lastSchedule: null
      };

      const activePolls = new Map([['poll_8am', targetPoll]]);
      const dummySock = {
        user: { id: 'bot@s.whatsapp.net' },
        sendMessage: async () => ({ key: { id: 'msg1' } })
      };

      const sevenPlayerLineup = {
        type: 'doubles',
        time: '8:00am',
        players: ['P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P7'],
        sets: [{
          set: 1,
          courts: [
            { court: 1, teamA: ['P1', 'P2'], teamB: ['P3', 'P4'] },
            { court: 2, teamA: ['P5', 'P6'], teamB: ['P7'] }
          ]
        }]
      };

      let persisted = false;
      const context = {
        activePolls,
        persistPolls: () => { persisted = true; },
        messageStore: new Map()
      };

      const dummyMsg = {
        key: { remoteJid: 'test_chat@g.us', id: 'lineup_msg_789', fromMe: false }
      };

      await handleManualLineup(
        dummySock,
        'test_chat@g.us',
        'Player8',
        sevenPlayerLineup,
        dummyMsg,
        'Court 1: P1 & P2 vs P3 & P4, Court 2: P5 & P6 vs P7',
        context
      );

      assert.equal(targetPoll.status, 'resolved');
      assert.equal(sevenPlayerLineup.players.length, 8);
      assert.ok(sevenPlayerLineup.players.includes('Player8'));
      assert.deepEqual(sevenPlayerLineup.sets[0].courts[1].teamB, ['P7', 'Player8']);
      assert.equal(persisted, true);
    });

    it('should NOT call ratings.ensureRated and should resolve typos to voters', async () => {
      const targetPoll = {
        remoteJid: 'test_chat@g.us',
        when: 'Today 9:00am',
        size: 4,
        status: 'active',
        lastPlayers: ['Terence Park', 'Bob', 'Alice', 'Charlie'],
        lastSchedule: null
      };

      const activePolls = new Map([['poll_typo_test', targetPoll]]);
      const dummySock = {
        user: { id: 'bot@s.whatsapp.net' },
        sendMessage: async () => ({ key: { id: 'msg1' } })
      };

      // Notice "Terrence" (with double 'r') is posted in manual lineup
      const lineupWithTypo = {
        type: 'doubles',
        time: '9:00am',
        players: ['Terrence', 'Bob', 'Alice', 'Charlie'],
        sets: [{
          set: 1,
          courts: [{ court: 1, teamA: ['Terrence', 'Bob'], teamB: ['Alice', 'Charlie'] }]
        }]
      };

      let ensureRatedCalled = false;
      const origEnsureRated = ratings.ensureRated;
      ratings.ensureRated = async () => {
        ensureRatedCalled = true;
      };

      try {
        const context = {
          activePolls,
          persistPolls: () => {},
          messageStore: new Map()
        };

        await handleManualLineup(
          dummySock,
          'test_chat@g.us',
          'Bob',
          lineupWithTypo,
          { key: { remoteJid: 'test_chat@g.us', id: 'msg_typo' } },
          'Court 1: Terrence & Bob vs Alice & Charlie 9am',
          context
        );

        // 1. ratings.ensureRated MUST NOT be called!
        assert.equal(ensureRatedCalled, false, 'ratings.ensureRated should not be called from manual lineups');

        // 2. "Terrence" typo must resolve to voter "Terence Park"
        assert.ok(lineupWithTypo.players.includes('Terence Park'), 'Terrence should resolve to voter Terence Park');
        assert.equal(lineupWithTypo.players.includes('Terrence'), false);
        assert.deepEqual(lineupWithTypo.sets[0].courts[0].teamA, ['Terence Park', 'Bob']);
      } finally {
        ratings.ensureRated = origEnsureRated;
      }
    });
  });

  describe('executeLineupTool', () => {
    it('should parse deterministic lineup text and record to matching poll', async () => {
      const targetPoll = {
        remoteJid: 'test_chat@g.us',
        name: 'Tennis 9am',
        when: 'Today 9:00am',
        size: 4,
        status: 'active',
        lastPlayers: ['Alice', 'Bob', 'Charlie', 'Dave']
      };
      const activePolls = new Map([['poll_9am', targetPoll]]);
      let persisted = false;
      const context = {
        activePolls,
        persistPolls: () => { persisted = true; },
        messageStore: new Map()
      };

      const dummySock = {
        user: { id: 'bot@s.whatsapp.net' },
        sendMessage: async () => ({ key: { id: 'msg1' } })
      };

      const res = await executeLineupTool(
        dummySock,
        'parse_lineup',
        { text: 'Court 1: Alice & Bob vs Charlie & Dave 9am' },
        'Alice',
        'test_chat@g.us',
        { key: { remoteJid: 'test_chat@g.us', id: 'm1' } },
        context
      );

      assert.match(res, /Successfully parsed and recorded lineup/);
      assert.equal(targetPoll.status, 'resolved');
      assert.equal(persisted, true);
    });

    it('should handle pre-structured lineup input directly', async () => {
      const targetPoll = {
        remoteJid: 'test_chat@g.us',
        name: 'Tennis 6pm',
        when: 'Today 6:00pm',
        size: 4,
        status: 'active',
        lastPlayers: ['Alice', 'Bob', 'Charlie', 'Dave']
      };
      const activePolls = new Map([['poll_6pm', targetPoll]]);
      const context = {
        activePolls,
        persistPolls: () => {},
        messageStore: new Map()
      };

      const dummySock = {
        user: { id: 'bot@s.whatsapp.net' },
        sendMessage: async () => ({ key: { id: 'msg1' } })
      };

      const res = await executeLineupTool(
        dummySock,
        'parse_lineup',
        {
          pollId: 'poll_6pm',
          lineup: {
            type: 'doubles',
            time: '6:00pm',
            players: ['Alice', 'Charlie', 'Bob', 'Dave'],
            sets: [{
              set: 1,
              courts: [{ court: 1, teamA: ['Alice', 'Charlie'], teamB: ['Bob', 'Dave'] }]
            }]
          }
        },
        'Alice',
        'test_chat@g.us',
        { key: { remoteJid: 'test_chat@g.us', id: 'm2' } },
        context
      );

      assert.match(res, /Successfully parsed and recorded lineup/);
      assert.equal(targetPoll.status, 'resolved');
    });

    it('should return helpful error message when input cannot be parsed', async () => {
      const context = {
        activePolls: new Map(),
        persistPolls: () => {},
        messageStore: new Map()
      };

      const res = await executeLineupTool(
        null,
        'parse_lineup',
        { text: 'Are we playing tennis today?' },
        'Alice',
        'test_chat@g.us',
        null,
        context
      );

      assert.match(res, /Could not parse a valid match lineup/);
    });

    it('should parse courts without vs with 4 players (first two vs next two) and 3 players (first two vs third)', () => {
      const { parseLineup } = require('../lib/lineupParser');
      const text = `LINEUPS FOR TODAY

FIRST SET 7.00 pm

COURT 2 - JJ - Conrad vs Mausam - Amit
COURT 3 - Deepak - Mehul vs Chandra - Vik
COURT 5 - VJ - Anupam vs Som - Kej

SECOND SET -
COURT 3 - Mausam - Kej vs Mehul - Chandra
COURT 2 - Amit - Conrad vs JJ - Deepak
COURT 5 - Anupam - Som - Vik - VJ`;
      const roster = ['JJ', 'Conrad', 'Mausam', 'Amit', 'Deepak', 'Mehul', 'Chandra', 'Vik', 'VJ', 'Anupam', 'Som', 'Kej'];

      const res = parseLineup(text, roster);
      assert.ok(res);
      assert.equal(res.sets.length, 2);
      assert.equal(res.sets[1].courts.length, 3);

      const court5Set2 = res.sets[1].courts.find((c) => c.court === 5);
      assert.ok(court5Set2);
      assert.deepEqual(court5Set2.teamA, ['Anupam', 'Som']);
      assert.deepEqual(court5Set2.teamB, ['Vik', 'VJ']);

      // 3-player court test: first two vs third
      const text3 = `COURT 5 - Anupam - Som - Vik`;
      const res3 = parseLineup(text3, roster);
      assert.ok(res3);
      assert.equal(res3.sets[0].courts.length, 1);
      assert.deepEqual(res3.sets[0].courts[0].teamA, ['Anupam', 'Som']);
      assert.deepEqual(res3.sets[0].courts[0].teamB, ['Vik']);
    });
  });
});
