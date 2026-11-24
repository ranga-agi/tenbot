const path = require('path');
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
  evaluateSetWinner,
  migrateDefMatchesToVs,
  getRecentMatches,
  getScores,
  findMatchByIdOrIndex,
  deleteMatch,
  updateMatch,
  pruneExpiredMatches,
  parseDateQuery,
  formatScoresList,
  splitPlayers,
  STATS_FILE,
  SCORES_FILE,
  AVAILABILITY_FILE,
  AVAILABILITY_DIR,
  SCORES_DIR
} = require('../lib/stats');
const {
  formatLeaderboard,
  handleScoreCommand,
  handleListScores,
  handleDeleteScore,
  handleEditScore
} = require('../lib/commands/player');
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
      assert.equal(recent[0].format, 'vs');

      const leaderboard = getLeaderboard();
      const winnerEntry = leaderboard.find((p) => p.name === 'TestWinner');
      const loserEntry = leaderboard.find((p) => p.name === 'TestLoser');

      assert.ok(winnerEntry);
      assert.ok(loserEntry);
      assert.equal(winnerEntry.wins, 2);
      assert.equal(winnerEntry.losses, 0);
      assert.equal(winnerEntry.matches, 1);
      assert.equal(winnerEntry.winRate, 1.0);

      assert.equal(loserEntry.wins, 0);
      assert.equal(loserEntry.losses, 2);
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

      // Points breakdown:
      // Alice: 16 pts (12 games won, 7 games lost)
      assert.equal(alice.points, 16);
      assert.equal(alice.gamesWon, 12);
      assert.equal(alice.gamesLost, 7);

      // Bob: 11 pts (9 games won, 10 games lost)
      assert.equal(bob.points, 11);

      // Charlie: 17 pts (15 games won, 16 games lost, 1 set won = 17 pts)
      assert.equal(charlie.points, 17);

      // Dave: 16 pts (14 games won, 17 games lost, 1 set won = 16 pts)
      assert.equal(dave.points, 16);
      assert.equal(dave.gamesLost, 17);

      // Ranking: Charlie (17 pts) > Alice (16 pts, 7 lost) > Dave (16 pts, 17 lost) > Bob (11 pts)
      // Tiebreaker: Alice and Dave both have 16 points; Alice lost fewer games (7 vs 17), so Alice ranks above Dave!
      assert.equal(leaderboard[0].name, 'Charlie');
      assert.equal(leaderboard[1].name, 'Alice');
      assert.equal(leaderboard[2].name, 'Dave');
      assert.equal(leaderboard[3].name, 'Bob');
    });

    it('should format individual leaderboard cleanly with points and games', () => {
      fs.writeFileSync(STATS_FILE, JSON.stringify({ availability: [], matches: [] }));

      recordMatch('Alice & Bob', 'Charlie & Dave', '6-4');

      const formatted = formatLeaderboard();
      assert.match(formatted, /🏆 \*Leaderboard/);
      assert.match(formatted, /1\. Alice — 8 pts \(6-4 games, 1-0 sets, 1W 0L\)/);
      assert.match(formatted, /2\. Bob — 8 pts \(6-4 games, 1-0 sets, 1W 0L\)/);
      assert.match(formatted, /3\. Charlie — 4 pts \(4-6 games, 0-1 sets, 0W 1L\)/);
      assert.match(formatted, /4\. Dave — 4 pts \(4-6 games, 0-1 sets, 0W 1L\)/);
      assert.match(formatted, /_Scoring: 1 pt\/game \+ 2 pts\/set win • Tiebreaker: fewer games lost_/);
    });

    it('should integrate individual stats through handleScoreCommand', () => {
      fs.writeFileSync(STATS_FILE, JSON.stringify({ availability: [], matches: [] }));

      const res = handleScoreCommand('!score Roger & Rafa def Novak & Andy 6-4 6-2');
      assert.match(res, /Recorded: Roger & Rafa vs Novak & Andy/);

      const leaderboard = getLeaderboard();
      const roger = leaderboard.find((p) => p.name === 'Roger');
      const rafa = leaderboard.find((p) => p.name === 'Rafa');
      const novak = leaderboard.find((p) => p.name === 'Novak');
      const andy = leaderboard.find((p) => p.name === 'Andy');

      assert.ok(roger && roger.wins === 2);
      assert.ok(rafa && rafa.wins === 2);
      assert.ok(novak && novak.losses === 2);
      assert.ok(andy && andy.losses === 2);
    });

    it('should record vs directly and count W-L on sets even when second side wins', () => {
      fs.writeFileSync(STATS_FILE, JSON.stringify({ availability: [], matches: [] }));

      const res = handleScoreCommand('!score Novak & Andy vs Roger & Rafa 4-6 2-6');
      assert.match(res, /Recorded: Novak & Andy vs Roger & Rafa \(4-6 2-6\)\./);

      const leaderboard = getLeaderboard();
      const roger = leaderboard.find((p) => p.name === 'Roger');
      const rafa = leaderboard.find((p) => p.name === 'Rafa');
      const novak = leaderboard.find((p) => p.name === 'Novak');
      const andy = leaderboard.find((p) => p.name === 'Andy');

      assert.equal(roger.wins, 2);
      assert.equal(rafa.wins, 2);
      assert.equal(novak.losses, 2);
      assert.equal(andy.losses, 2);
      assert.equal(roger.gamesWon, 12);
      assert.equal(roger.gamesLost, 6);

      const scoresList = handleListScores();
      assert.match(scoresList, /\*Novak & Andy\* vs \*Roger & Rafa\* \(4-6 2-6\)/);
    });

    it('should support 2-set split matches recorded as vs and count W-L per set', () => {
      fs.writeFileSync(STATS_FILE, JSON.stringify({ availability: [], matches: [] }));

      const res = handleScoreCommand('!score Alice & Bob vs Charlie & Dave 6-4 3-6');
      assert.match(res, /Recorded: Alice & Bob vs Charlie & Dave \(6-4 3-6\)\./);

      const leaderboard = getLeaderboard();
      const alice = leaderboard.find((p) => p.name === 'Alice');
      const charlie = leaderboard.find((p) => p.name === 'Charlie');

      // Alice & Bob: 9 games + 1 set (2 pts) = 11 pts, 1-1 sets, 1W 1L
      assert.equal(alice.points, 11);
      assert.equal(alice.gamesWon, 9);
      assert.equal(alice.gamesLost, 10);
      assert.equal(alice.setsWon, 1);
      assert.equal(alice.setsLost, 1);
      assert.equal(alice.wins, 1);
      assert.equal(alice.losses, 1);

      // Charlie & Dave: 10 games + 1 set (2 pts) = 12 pts, 1-1 sets, 1W 1L
      assert.equal(charlie.points, 12);
      assert.equal(charlie.wins, 1);
      assert.equal(charlie.losses, 1);

      const formatted = formatLeaderboard();
      assert.match(formatted, /1\. Charlie — 12 pts \(10-9 games, 1-1 sets, 1W 1L\)/);
    });

    it('should treat incomplete sets as a win only when leader won at least 4 games', () => {
      assert.equal(evaluateSetWinner(4, 2), 'A');
      assert.equal(evaluateSetWinner(3, 5), 'B');
      assert.equal(evaluateSetWinner(3, 2), null);
      assert.equal(evaluateSetWinner(4, 4), null);

      fs.writeFileSync(STATS_FILE, JSON.stringify({ availability: [], matches: [] }));
      handleScoreCommand('!score Alice vs Bob 4-2 3-2 4-4');

      const leaderboard = getLeaderboard();
      const alice = leaderboard.find((p) => p.name === 'Alice');
      const bob = leaderboard.find((p) => p.name === 'Bob');

      // Only 4-2 counts as a set win (3-2 has < 4 games, 4-4 is tied)
      // Alice: 4+3+4 = 11 games + 1 set (2 pts) = 13 pts, 1W 0L
      assert.equal(alice.points, 13);
      assert.equal(alice.setsWon, 1);
      assert.equal(alice.setsLost, 0);
      assert.equal(alice.wins, 1);
      assert.equal(alice.losses, 0);

      // Bob: 2+2+4 = 8 games + 0 sets = 8 pts, 0W 1L
      assert.equal(bob.points, 8);
      assert.equal(bob.setsWon, 0);
      assert.equal(bob.setsLost, 1);
      assert.equal(bob.wins, 0);
      assert.equal(bob.losses, 1);
    });

    it('should convert legacy def matches to vs format via migrateDefMatchesToVs', () => {
      const legacy = {
        availability: [],
        matches: [
          { id: 'm_legacy1', winner: 'Alice', loser: 'Bob', score: '6-4', date: new Date().toISOString() },
          { id: 'm_legacy2', winner: 'Charlie', loser: 'Dave', score: '6-2', format: 'def', date: new Date().toISOString() }
        ]
      };
      fs.writeFileSync(STATS_FILE, JSON.stringify(legacy));

      const converted = migrateDefMatchesToVs();
      assert.equal(converted, 2);

      const recent = getRecentMatches(5);
      assert.equal(recent.every((m) => m.format === 'vs'), true);

      const listed = handleListScores();
      assert.match(listed, /\*Alice\* vs \*Bob\* \(6-4\)/);
      assert.match(listed, /\*Charlie\* vs \*Dave\* \(6-2\)/);
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

      // handleListScores formatting with empty line before first listing and newline after each
      const listOutput = handleListScores(null, 'week');
      assert.match(listOutput, /🎾 \*Match Scores — Last 7 Days \(\d+\):\*\n\n#1/);
      assert.match(listOutput, /#1 .+\n\n#2 /);
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

    it('should edit an existing score using vs and preserve vs format', async () => {
      fs.writeFileSync(STATS_FILE, JSON.stringify({ availability: [], matches: [] }));
      handleScoreCommand('!score PlayerA def PlayerB 6-4 6-4');

      const mockSock = {
        groupMetadata: async () => ({
          participants: [{ id: 'admin@s.whatsapp.net', admin: 'admin' }]
        })
      };

      const editRes = await handleEditScore(mockSock, 'test@g.us', 'admin@s.whatsapp.net', 'Admin', '#1 PlayerA vs PlayerB 6-4 4-6');
      assert.match(editRes, /Updated match score/);
      assert.match(editRes, /\*Now:\* PlayerA vs PlayerB \(6-4 4-6\)/);

      const recent = getRecentMatches(1);
      assert.equal(recent[0].winner, 'PlayerA');
      assert.equal(recent[0].loser, 'PlayerB');
      assert.equal(recent[0].score, '6-4 4-6');
      assert.equal(recent[0].format, 'vs');
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

  describe("separate storage files and group-based scoring", () => {
    it("should store availability and scores in per-group folder structure availability/<group>.json and scores/<group>.json", () => {
      fs.writeFileSync(STATS_FILE, JSON.stringify({ availability: [], matches: [] }));

      const GID_1 = "120363403838804497@g.us";
      const GID_2 = "120363402559062529@g.us";

      // Set availability in GID_1
      setAvailable("PlayerOne", "Friday 9am", GID_1);
      // Set availability in GID_2
      setAvailable("PlayerTwo", "Saturday 10am", GID_2);

      // Verify files in data/availability/
      const file1 = path.join(AVAILABILITY_DIR, `${GID_1}.json`);
      const file2 = path.join(AVAILABILITY_DIR, `${GID_2}.json`);
      assert.equal(fs.existsSync(file1), true);
      assert.equal(fs.existsSync(file2), true);

      const availG1 = JSON.parse(fs.readFileSync(file1, "utf-8"));
      const availG2 = JSON.parse(fs.readFileSync(file2, "utf-8"));
      assert.equal(availG1.some(a => a.player === "PlayerOne"), true);
      assert.equal(availG1.some(a => a.player === "PlayerTwo"), false);
      assert.equal(availG2.some(a => a.player === "PlayerTwo"), true);
      assert.equal(availG2.some(a => a.player === "PlayerOne"), false);

      // Record match in GID_1
      recordMatch("PlayerOne", "OpponentA", "6-2 6-4", { chatId: GID_1 });
      // Record match in GID_2
      recordMatch("PlayerTwo", "OpponentB", "6-3 6-3", { chatId: GID_2 });

      // Verify files in data/scores/
      const scoreFile1 = path.join(SCORES_DIR, `${GID_1}.json`);
      const scoreFile2 = path.join(SCORES_DIR, `${GID_2}.json`);
      assert.equal(fs.existsSync(scoreFile1), true);
      assert.equal(fs.existsSync(scoreFile2), true);

      const scoresG1 = JSON.parse(fs.readFileSync(scoreFile1, "utf-8"));
      const scoresG2 = JSON.parse(fs.readFileSync(scoreFile2, "utf-8"));
      assert.equal(scoresG1.some(m => m.winner === "PlayerOne"), true);
      assert.equal(scoresG1.some(m => m.winner === "PlayerTwo"), false);
      assert.equal(scoresG2.some(m => m.winner === "PlayerTwo"), true);
      assert.equal(scoresG2.some(m => m.winner === "PlayerOne"), false);

      // Clear availability for GID_1 only
      clearAvailability(GID_1);
      assert.deepEqual(getAvailability(GID_1), []);
      assert.equal(getAvailability(GID_2).length, 1);
    });

    it("should store availability and scores in separate json files", () => {
      clearAvailability();
      setAvailable("Eve", "Sunday 8am");

      assert.equal(fs.existsSync(AVAILABILITY_FILE), true);
      const availRaw = JSON.parse(fs.readFileSync(AVAILABILITY_FILE, "utf-8"));
      assert.equal(Array.isArray(availRaw), true);
      assert.equal(availRaw.some(a => a.player === "Eve"), true);

      recordMatch("Eve", "Frank", "6-2 6-3");
      assert.equal(fs.existsSync(SCORES_FILE), true);
      const scoresRaw = JSON.parse(fs.readFileSync(SCORES_FILE, "utf-8"));
      assert.equal(Array.isArray(scoresRaw), true);
      assert.equal(scoresRaw.some(m => m.winner === "Eve" && m.loser === "Frank"), true);
    });

    it("should calculate points and apply tiebreaker by fewer games lost", () => {
      fs.writeFileSync(STATS_FILE, JSON.stringify({ availability: [], matches: [] }));

      // Player X wins 6-0 (1 set won, 6 games won = 6 + 2 = 8 pts, 0 games lost)
      recordMatch("PlayerX", "Opponent1", "6-0");

      // Player Y wins 6-4 (1 set won, 6 games won = 6 + 2 = 8 pts, 4 games lost)
      recordMatch("PlayerY", "Opponent2", "6-4");

      const board = getLeaderboard();
      const pX = board.find(p => p.name === "PlayerX");
      const pY = board.find(p => p.name === "PlayerY");

      assert.equal(pX.points, 8);
      assert.equal(pX.gamesLost, 0);
      assert.equal(pY.points, 8);
      assert.equal(pY.gamesLost, 4);

      // PlayerX is ranked higher than PlayerY because PlayerX lost fewer games (0 vs 4)
      const idxX = board.findIndex(p => p.name === "PlayerX");
      const idxY = board.findIndex(p => p.name === "PlayerY");
      assert.ok(idxX < idxY, "PlayerX (0 games lost) must rank higher than PlayerY (4 games lost) when tied at 8 points");
    });

    it("should isolate scores by group chatId", () => {
      fs.writeFileSync(STATS_FILE, JSON.stringify({ availability: [], matches: [] }));

      const GROUP_A = "120363000000000001@g.us";
      const GROUP_B = "120363000000000002@g.us";

      recordMatch("Alpha", "Beta", "6-3", { chatId: GROUP_A });
      recordMatch("Gamma", "Delta", "6-4", { chatId: GROUP_B });

      const boardA = getLeaderboard(GROUP_A);
      const boardB = getLeaderboard(GROUP_B);

      assert.equal(boardA.some(p => p.name === "Alpha"), true);
      assert.equal(boardA.some(p => p.name === "Gamma"), false);

      assert.equal(boardB.some(p => p.name === "Gamma"), true);
      assert.equal(boardB.some(p => p.name === "Alpha"), false);
    });

    it("should support handleScoreCommand with group parameter or targeting", () => {
      fs.writeFileSync(STATS_FILE, JSON.stringify({ availability: [], matches: [] }));

      const TARGET_GROUP = "120363000000000003@g.us";
      const res = handleScoreCommand("!score Serena def Venus 6-4 6-4", TARGET_GROUP);
      assert.match(res, /Recorded: Serena vs Venus/);

      const board = getLeaderboard(TARGET_GROUP);
      assert.equal(board.length, 2);
      const serena = board.find(p => p.name === "Serena");
      const venus = board.find(p => p.name === "Venus");

      // Serena won 12 games + 2 sets (4 pts) = 16 pts
      assert.equal(serena.points, 16);
      assert.equal(serena.gamesWon, 12);
      assert.equal(serena.gamesLost, 8);
      // Venus won 8 games + 0 sets = 8 pts
      assert.equal(venus.points, 8);
      assert.equal(venus.gamesWon, 8);
      assert.equal(venus.gamesLost, 12);
    });
  });
});
