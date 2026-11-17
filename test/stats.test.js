const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const {
  setAvailable,
  removeAvailable,
  clearAvailability,
  getAvailability,
  recordMatch,
  getLeaderboard,
  getRecentMatches,
  getScores,
  findMatchByIdOrIndex,
  deleteMatch,
  updateMatch,
  pruneExpiredMatches,
  parseDateQuery,
  formatScoresList,
  splitPlayers,
  STATS_FILE
} = require('../lib/stats');
const {
  formatLeaderboard,
  handleScoreCommand,
  handleListScores,
  handleDeleteScore,
  handleEditScore
} = require('../lib/commands/playerCommands');
const ratings = require('../lib/ratings');

describe('stats', () => {
  let originalStats = null;

  before(() => {
    if (fs.existsSync(STATS_FILE)) {
      originalStats = fs.readFileSync(STATS_FILE, 'utf-8');
    }
  });

  after(() => {
    if (originalStats !== null) {
      fs.writeFileSync(STATS_FILE, originalStats);
    }
  });

  describe('availability', () => {
    it('should add, get, update, and remove availability', () => {
      clearAvailability();
      assert.deepEqual(getAvailability(), []);

      setAvailable('Alice', 'tomorrow 9am');
      const list1 = getAvailability();
      assert.equal(list1.length, 1);
      assert.equal(list1[0].player, 'Alice');
      assert.equal(list1[0].when, 'tomorrow 9am');

      // Update same player
      setAvailable('Alice', 'Saturday 10am');
      const list2 = getAvailability();
      assert.equal(list2.length, 1);
      assert.equal(list2[0].when, 'Saturday 10am');

      // Remove player
      removeAvailable('Alice');
      assert.deepEqual(getAvailability(), []);
    });
  });

  describe('splitPlayers', () => {
    it('should split side strings with &, +, and, or comma', () => {
      assert.deepEqual(splitPlayers('Alice & Bob'), ['Alice', 'Bob']);
      assert.deepEqual(splitPlayers('Alice + Bob'), ['Alice', 'Bob']);
      assert.deepEqual(splitPlayers('Alice and Bob'), ['Alice', 'Bob']);
      assert.deepEqual(splitPlayers('Alice, Bob'), ['Alice', 'Bob']);
      assert.deepEqual(splitPlayers('Single Player'), ['Single Player']);
      assert.deepEqual(splitPlayers(['Alice', 'Bob']), ['Alice', 'Bob']);
      assert.deepEqual(splitPlayers(''), []);
    });
  });

  describe('match results & individual leaderboard', () => {
    it('should record singles matches and calculate individual leaderboard', () => {
      fs.writeFileSync(STATS_FILE, JSON.stringify({ availability: [], matches: [] }));

      recordMatch('TestWinner', 'TestLoser', '6-4 6-2');

      const recent = getRecentMatches(5);
      assert.ok(recent.length > 0);
      assert.equal(recent[0].winner, 'TestWinner');
      assert.equal(recent[0].loser, 'TestLoser');

      const leaderboard = getLeaderboard();
      const winnerEntry = leaderboard.find((p) => p.name === 'TestWinner');
      const loserEntry = leaderboard.find((p) => p.name === 'TestLoser');

      assert.ok(winnerEntry);
      assert.ok(loserEntry);
      assert.equal(winnerEntry.wins, 1);
      assert.equal(winnerEntry.losses, 0);
      assert.equal(winnerEntry.matches, 1);
      assert.equal(winnerEntry.winRate, 1.0);

      assert.equal(loserEntry.wins, 0);
      assert.equal(loserEntry.losses, 1);
      assert.equal(loserEntry.matches, 1);
      assert.equal(loserEntry.winRate, 0.0);
    });

    it('should credit individual players in doubles matches', () => {
      fs.writeFileSync(STATS_FILE, JSON.stringify({ availability: [], matches: [] }));

      // Doubles match with string pairing
      recordMatch('Alice & Bob', 'Charlie & Dave', '6-4');

      const leaderboard = getLeaderboard();
      assert.equal(leaderboard.length, 4);

      const alice = leaderboard.find((p) => p.name === 'Alice');
      const bob = leaderboard.find((p) => p.name === 'Bob');
      const charlie = leaderboard.find((p) => p.name === 'Charlie');
      const dave = leaderboard.find((p) => p.name === 'Dave');

      assert.ok(alice, 'Alice should have an individual ranking');
      assert.ok(bob, 'Bob should have an individual ranking');
      assert.ok(charlie, 'Charlie should have an individual ranking');
      assert.ok(dave, 'Dave should have an individual ranking');

      assert.equal(alice.wins, 1);
      assert.equal(alice.losses, 0);
      assert.equal(bob.wins, 1);
      assert.equal(bob.losses, 0);

      assert.equal(charlie.wins, 0);
      assert.equal(charlie.losses, 1);
      assert.equal(dave.wins, 0);
      assert.equal(dave.losses, 1);
    });

    it('should aggregate records across multiple matches with rotating partners', () => {
      fs.writeFileSync(STATS_FILE, JSON.stringify({ availability: [], matches: [] }));

      // Match 1: Alice & Bob beat Charlie & Dave
      recordMatch('Alice & Bob', 'Charlie & Dave', '6-4');
      // Match 2: Alice & Charlie beat Bob & Dave
      recordMatch('Alice & Charlie', 'Bob & Dave', '6-3');
      // Match 3: Singles - Dave beats Charlie
      recordMatch('Dave', 'Charlie', '7-5');

      const leaderboard = getLeaderboard();

      // Alice: 2-0 (100%)
      const alice = leaderboard.find((p) => p.name === 'Alice');
      assert.equal(alice.wins, 2);
      assert.equal(alice.losses, 0);
      assert.equal(alice.winRate, 1.0);

      // Bob: 1-1 (50%)
      const bob = leaderboard.find((p) => p.name === 'Bob');
      assert.equal(bob.wins, 1);
      assert.equal(bob.losses, 1);
      assert.equal(bob.winRate, 0.5);

      // Dave: 1-2 (33.3%)
      const dave = leaderboard.find((p) => p.name === 'Dave');
      assert.equal(dave.wins, 1);
      assert.equal(dave.losses, 2);

      // Charlie: 1-2 (33.3%)
      const charlie = leaderboard.find((p) => p.name === 'Charlie');
      assert.equal(charlie.wins, 1);
      assert.equal(charlie.losses, 2);

      // Sorting order: Alice (2W) > Bob (1W, 50%) > Charlie & Dave (1W, 33%)
      assert.equal(leaderboard[0].name, 'Alice');
      assert.equal(leaderboard[1].name, 'Bob');
    });

    it('should format individual leaderboard cleanly with win percentages', () => {
      fs.writeFileSync(STATS_FILE, JSON.stringify({ availability: [], matches: [] }));

      recordMatch('Alice & Bob', 'Charlie & Dave', '6-4');

      const formatted = formatLeaderboard();
      assert.match(formatted, /🏆 \*Leaderboard/);
      assert.match(formatted, /1\. Alice — 1W 0L \(100\.0%\)/);
      assert.match(formatted, /2\. Bob — 1W 0L \(100\.0%\)/);
      assert.match(formatted, /3\. Charlie — 0W 1L \(0\.0%\)/);
      assert.match(formatted, /4\. Dave — 0W 1L \(0\.0%\)/);
    });

    it('should integrate individual stats through handleScoreCommand', () => {
      fs.writeFileSync(STATS_FILE, JSON.stringify({ availability: [], matches: [] }));

      const res = handleScoreCommand('!score Roger & Rafa def Novak & Andy 6-4 6-2');
      assert.match(res, /Recorded: Roger & Rafa def Novak & Andy/);

      const leaderboard = getLeaderboard();
      const roger = leaderboard.find((p) => p.name === 'Roger');
      const rafa = leaderboard.find((p) => p.name === 'Rafa');
      const novak = leaderboard.find((p) => p.name === 'Novak');
      const andy = leaderboard.find((p) => p.name === 'Andy');

      assert.ok(roger && roger.wins === 1);
      assert.ok(rafa && rafa.wins === 1);
      assert.ok(novak && novak.losses === 1);
      assert.ok(andy && andy.losses === 1);
    });
  });

  describe('2-week retention and calendar month reset', () => {
    it('should prune matches older than 14 days', () => {
      const now = Date.now();
      const dayMs = 24 * 60 * 60 * 1000;

      const matches = [
        { id: 'm_fresh', winner: 'Alice', loser: 'Bob', score: '6-4', date: new Date(now - 2 * dayMs).toISOString() },
        { id: 'm_border', winner: 'Alice', loser: 'Bob', score: '6-4', date: new Date(now - 13 * dayMs).toISOString() },
        { id: 'm_expired', winner: 'Alice', loser: 'Bob', score: '6-4', date: new Date(now - 15 * dayMs).toISOString() }
      ];
      fs.writeFileSync(STATS_FILE, JSON.stringify({ availability: [], matches }));

      const pruned = pruneExpiredMatches();
      assert.equal(pruned, 1, 'Should prune 1 match older than 14 days');

      const recent = getRecentMatches(10);
      assert.equal(recent.length, 2);
      assert.ok(recent.some(m => m.id === 'm_fresh'));
      assert.ok(recent.some(m => m.id === 'm_border'));
      assert.ok(!recent.some(m => m.id === 'm_expired'));
    });

    it('should reset leaderboard at the start of a calendar month', () => {
      // Simulate today being Nov 2, 2026
      const now = new Date(2026, 10, 2, 12, 0, 0);

      // Match on Nov 1 (current calendar month, yesterday)
      const matchCurMonth = {
        id: 'm_cur',
        winner: 'Novak',
        loser: 'Carlos',
        winners: ['Novak'],
        losers: ['Carlos'],
        score: '6-4',
        date: new Date(2026, 10, 1, 14, 0, 0).toISOString()
      };

      // Match on Oct 31 (previous calendar month, 2 days ago, within 14-day window)
      const matchPrevMonth = {
        id: 'm_prev',
        winner: 'Carlos',
        loser: 'Novak',
        winners: ['Carlos'],
        losers: ['Novak'],
        score: '6-4',
        date: new Date(2026, 9, 31, 14, 0, 0).toISOString()
      };

      fs.writeFileSync(STATS_FILE, JSON.stringify({ availability: [], matches: [matchCurMonth, matchPrevMonth] }));

      // By default: current month only
      const monthlyLeaderboard = getLeaderboard(null, { now });
      const novak = monthlyLeaderboard.find(p => p.name === 'Novak');
      const carlos = monthlyLeaderboard.find(p => p.name === 'Carlos');

      assert.ok(novak);
      assert.equal(novak.wins, 1, 'Novak should have 1 win from current month');
      assert.equal(novak.losses, 0, 'Novak should have 0 losses from current month');

      assert.ok(carlos);
      assert.equal(carlos.wins, 0, 'Carlos should have 0 wins in current month');
      assert.equal(carlos.losses, 1, 'Carlos should have 1 loss in current month');

      // With allTime: true: includes previous month
      const allTimeBoard = getLeaderboard(null, { allTime: true, now });
      const novakAll = allTimeBoard.find(p => p.name === 'Novak');
      const carlosAll = allTimeBoard.find(p => p.name === 'Carlos');
      assert.equal(novakAll.wins, 1);
      assert.equal(novakAll.losses, 1);
      assert.equal(carlosAll.wins, 1);
      assert.equal(carlosAll.losses, 1);
    });
  });

  describe('listing, querying, modifying, and deleting scores', () => {
    it('should query scores by day and date range via parseDateQuery and getScores', () => {
      const now = new Date();
      const dayMs = 24 * 60 * 60 * 1000;

      const mToday = {
        id: 'm_today',
        winner: 'Alice',
        loser: 'Bob',
        score: '6-4',
        date: now.toISOString()
      };
      const mYesterday = {
        id: 'm_yesterday',
        winner: 'Charlie',
        loser: 'Dave',
        score: '6-2',
        date: new Date(now.getTime() - dayMs).toISOString()
      };
      const m5DaysAgo = {
        id: 'm_5d',
        winner: 'Bob',
        loser: 'Dave',
        score: '7-5',
        date: new Date(now.getTime() - 5 * dayMs).toISOString()
      };

      fs.writeFileSync(STATS_FILE, JSON.stringify({ availability: [], matches: [mToday, mYesterday, m5DaysAgo] }));

      // Query today
      const todayQuery = parseDateQuery('today', now);
      const todayScores = getScores(todayQuery);
      assert.equal(todayScores.length, 1);
      assert.equal(todayScores[0].id, 'm_today');

      // Query yesterday
      const yestQuery = parseDateQuery('yesterday', now);
      const yestScores = getScores(yestQuery);
      assert.equal(yestScores.length, 1);
      assert.equal(yestScores[0].id, 'm_yesterday');

      // Query limit
      const limitQuery = parseDateQuery('2', now);
      const limitScores = getScores({}, { limit: limitQuery.limit });
      assert.equal(limitScores.length, 2);

      // handleListScores formatting
      const listOutput = handleListScores(null, 'today');
      assert.match(listOutput, /Alice/);
      assert.match(listOutput, /Bob/);
    });

    it('should delete a score and revert rating changes', () => {
      fs.writeFileSync(STATS_FILE, JSON.stringify({ availability: [], matches: [] }));

      // Record a match with known ratings
      ratings.setRating('PlayerOne', 3.50);
      ratings.setRating('PlayerTwo', 3.50);

      const scoreRes = handleScoreCommand('!score PlayerOne def PlayerTwo 6-0 6-0');
      assert.match(scoreRes, /Recorded:/);

      const r1After = ratings.getRating('PlayerOne');
      const r2After = ratings.getRating('PlayerTwo');
      assert.ok(r1After > 3.50, 'Winner rating should increase');
      assert.ok(r2After < 3.50, 'Loser rating should decrease');

      // Delete the score via #1
      const mockSock = {
        groupMetadata: async () => ({
          participants: [{ id: 'admin@s.whatsapp.net', admin: 'admin' }]
        })
      };

      const delRes = handleDeleteScore(mockSock, 'test@g.us', 'admin@s.whatsapp.net', 'Admin', '#1');
      // handleDeleteScore is async
      return Promise.resolve(delRes).then((res) => {
        assert.match(res, /Deleted match score/);

        // Ratings should be reverted to baseline 3.50
        const r1Reverted = ratings.getRating('PlayerOne');
        const r2Reverted = ratings.getRating('PlayerTwo');
        assert.equal(r1Reverted, 3.50);
        assert.equal(r2Reverted, 3.50);

        // Matches in stats.json should be empty
        const remaining = getRecentMatches(5);
        assert.equal(remaining.length, 0);
      });
    });

    it('should edit an existing score and update ratings', async () => {
      fs.writeFileSync(STATS_FILE, JSON.stringify({ availability: [], matches: [] }));

      ratings.setRating('PlayerA', 3.50);
      ratings.setRating('PlayerB', 3.50);

      handleScoreCommand('!score PlayerA def PlayerB 6-4 6-4');

      const mockSock = {
        groupMetadata: async () => ({
          participants: [{ id: 'admin@s.whatsapp.net', admin: 'admin' }]
        })
      };

      // Edit match #1 to a more decisive score: 6-0 6-0
      const editRes = await handleEditScore(mockSock, 'test@g.us', 'admin@s.whatsapp.net', 'Admin', '#1 6-0 6-0');
      assert.match(editRes, /Updated match score/);
      assert.match(editRes, /6-0 6-0/);

      const recent = getRecentMatches(1);
      assert.equal(recent[0].score, '6-0 6-0');
    });

    it('should reject unauthorized users from deleting or editing scores', async () => {
      fs.writeFileSync(STATS_FILE, JSON.stringify({ availability: [], matches: [] }));

      recordMatch('Hero', 'Villain', '6-4');

      const mockSock = {
        groupMetadata: async () => ({
          participants: [
            { id: 'admin@s.whatsapp.net', admin: 'admin' },
            { id: 'stranger@s.whatsapp.net', admin: null }
          ]
        })
      };

      const resDel = await handleDeleteScore(mockSock, 'test@g.us', 'stranger@s.whatsapp.net', 'Stranger', '#1');
      assert.match(resDel, /Only group admins or players involved/);

      const resEdit = await handleEditScore(mockSock, 'test@g.us', 'stranger@s.whatsapp.net', 'Stranger', '#1 6-0');
      assert.match(resEdit, /Only group admins or players involved/);
    });
  });
});
