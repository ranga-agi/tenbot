const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  parseSide,
  parseSetRatingCommand,
  parseUnsetRatingCommand,
  handleUnsetRating,
  parseFullNameCommand,
  parseAliasCommand,
  handleScoreCommand,
  handleEditScore,
  parseMatchResultExpression,
  handlePlayerCommand,
  splitScoreCommandEntries,
  nameFor,
  canUserManagePlayerAlias
} = require('../lib/commands/player');
const namesStore = require('../lib/names');
const stats = require('../lib/stats');

describe('playerCommands', () => {
  describe('parseSide', () => {
    it('should split partners separated by &, and, +, or hyphen', () => {
      assert.deepEqual(parseSide('Mike & Sara'), ['Mike', 'Sara']);
      assert.deepEqual(parseSide('Mike and Sara'), ['Mike', 'Sara']);
      assert.deepEqual(parseSide('Mike + Sara'), ['Mike', 'Sara']);
      assert.deepEqual(parseSide('Mike-Sara'), ['Mike', 'Sara']);
      assert.deepEqual(parseSide('Mike - Sara'), ['Mike', 'Sara']);
    });

    it('should return a single player when no delimiter exists', () => {
      assert.deepEqual(parseSide('Roger'), ['Roger']);
    });
  });

  describe('parseUnsetRatingCommand', () => {
    it('should parse command with player name only', () => {
      const res = parseUnsetRatingCommand('!unsetrating Bob');
      assert.deepEqual(res, { name: 'Bob', rating: null });
    });

    it('should parse command with player name and explicit rating', () => {
      const res = parseUnsetRatingCommand('!unsetrating Bob = 3.5');
      assert.deepEqual(res, { name: 'Bob', rating: 3.5 });

      const res2 = parseUnsetRatingCommand('!unsetrating Bob 3.75');
      assert.deepEqual(res2, { name: 'Bob', rating: 3.75 });
    });

    it('should parse self unsetrating', () => {
      const res = parseUnsetRatingCommand('!unsetrating', 'Alice');
      assert.deepEqual(res, { name: 'Alice', rating: null });

      const res2 = parseUnsetRatingCommand('!unsetrating 3.5', 'Alice');
      assert.deepEqual(res2, { name: 'Alice', rating: 3.5 });
    });
  });

  describe('parseFullNameCommand', () => {
    it('should parse command with player name and full name', () => {
      const res = parseFullNameCommand('!setfullname John = Johnathan Smith');
      assert.deepEqual(res, { name: 'John', fullName: 'Johnathan Smith' });

      const res2 = parseFullNameCommand('!fullname John = Johnathan Smith');
      assert.deepEqual(res2, { name: 'John', fullName: 'Johnathan Smith' });
    });

    it('should parse command for sender when only full name provided', () => {
      const res = parseFullNameCommand('!fullname Johnathan Smith', 'John');
      assert.deepEqual(res, { name: 'John', fullName: 'Johnathan Smith' });
    });
  });

  describe('parseAliasCommand', () => {
    it('should parse alias addition for self', () => {
      const res = parseAliasCommand('!setalias Johnny', 'John');
      assert.deepEqual(res, { name: 'John', alias: 'Johnny' });

      const resAdd = parseAliasCommand('!addalias Johnny', 'John');
      assert.deepEqual(resAdd, { name: 'John', alias: 'Johnny' });
    });

    it('should parse alias addition for another player', () => {
      const res = parseAliasCommand('!setalias John = Johnny');
      assert.deepEqual(res, { name: 'John', alias: 'Johnny' });

      const resDel = parseAliasCommand('!deletealias John = Johnny');
      assert.deepEqual(resDel, { name: 'John', alias: 'Johnny' });
    });
  });

  describe('!alias and !setalias commands', () => {
    it('should list caller aliases for !alias and named player aliases for !alias <name>', async () => {
      const origGetAllEntries = namesStore.getAllEntries;
      const origFind = namesStore.findIdByNameOrAlias;
      const origResolveId = namesStore.resolveCanonicalId;
      const origGetPn = namesStore.getPnByLid;

      const fakeEntries = [
        { id: '111@lid', name: 'Alice', fullName: 'Alice Wonderland', aliases: ['Ali', 'AW'] },
        { id: '222@lid', name: 'Bob', fullName: 'Robert Smith', aliases: ['Bobby'] }
      ];

      namesStore.getAllEntries = () => fakeEntries;
      namesStore.resolveCanonicalId = (id) => id;
      namesStore.getPnByLid = () => null;
      namesStore.findIdByNameOrAlias = (q) => {
        const lower = String(q).trim().toLowerCase();
        const found = fakeEntries.find(
          (e) =>
            e.id.toLowerCase() === lower ||
            e.name.toLowerCase() === lower ||
            e.fullName.toLowerCase() === lower ||
            e.aliases.some((a) => a.toLowerCase() === lower)
        );
        return found ? { id: found.id, entry: found } : null;
      };

      try {
        const sock = { groupMetadata: async () => ({ participants: [] }) };

        const selfRes = await handlePlayerCommand(sock, '!alias', '120363@g.us', 'Someone', '111@lid');
        assert.match(selfRes, /Aliases for "Alice"/);
        assert.match(selfRes, /Alice \(full name: Alice Wonderland\) \(aliases: Ali, AW\)/);

        const namedRes = await handlePlayerCommand(sock, '!alias Bob', '120363@g.us', 'Alice', '111@lid');
        assert.match(namedRes, /Aliases for "Bob"/);
        assert.match(namedRes, /Bob \(full name: Robert Smith\) \(aliases: Bobby\)/);

        const unknownRes = await handlePlayerCommand(sock, '!alias UnknownPlayer', '120363@g.us', 'Alice', '111@lid');
        assert.match(unknownRes, /No player or alias matching "UnknownPlayer" was found/);

        const noCallerRes = await handlePlayerCommand(sock, '!alias', '120363@g.us', 'Charlie', '999@lid');
        assert.match(noCallerRes, /No aliases recorded for "Charlie"/);
        assert.match(noCallerRes, /!setalias <alias>/);
      } finally {
        namesStore.getAllEntries = origGetAllEntries;
        namesStore.findIdByNameOrAlias = origFind;
        namesStore.resolveCanonicalId = origResolveId;
        namesStore.getPnByLid = origGetPn;
      }
    });

    it('should use !setalias to add an alias and return usage when missing args', async () => {
      const origAdd = namesStore.addAliasForPlayer;
      const calls = [];
      namesStore.addAliasForPlayer = (player, alias, senderJid, chatId) => {
        calls.push({ player, alias, senderJid, chatId });
        return { name: player, aliases: [alias] };
      };

      try {
        const sock = { groupMetadata: async () => ({ participants: [] }) };
        const badRes = await handlePlayerCommand(sock, '!setalias', '120363@g.us', 'Alice', '111@lid');
        assert.match(badRes, /!setalias <alias>/);

        const okRes = await handlePlayerCommand(sock, '!setalias Ali', '120363@g.us', 'Alice', '111@lid');
        assert.match(okRes, /Added alias "Ali" for player "Alice"/);
        assert.equal(calls.length, 1);
        assert.deepEqual(calls[0], { player: 'Alice', alias: 'Ali', senderJid: '111@lid', chatId: '120363@g.us' });
      } finally {
        namesStore.addAliasForPlayer = origAdd;
      }
    });
  });

  describe('parseSetRatingCommand', () => {
    it('should parse "!setrating 4.0" as self rating', () => {
      const res = parseSetRatingCommand('!setrating 4.0', 'Alice');
      assert.deepEqual(res, { name: 'Alice', rating: 4.0 });
    });

    it('should parse "!setrating John = 3.75"', () => {
      const res = parseSetRatingCommand('!setrating John = 3.75');
      assert.deepEqual(res, { name: 'John', rating: 3.75 });
    });

    it('should parse "!setrating for John 3.5"', () => {
      const res = parseSetRatingCommand('!setrating for John 3.5');
      assert.deepEqual(res, { name: 'John', rating: 3.5 });
    });

    it('should return null for invalid text', () => {
      assert.equal(parseSetRatingCommand('!setrating'), null);
      assert.equal(parseSetRatingCommand('!setrating abc'), null);
    });
  });

  describe('handleScoreCommand', () => {
    it('should reject score reports where sides have different numbers of players', () => {
      const res = handleScoreCommand('!score Mike & Sara def John 6-4 6-2');
      assert.match(res, /Both sides need the same number of players/);
    });

    it('should reject invalid syntax', () => {
      const res = handleScoreCommand('!score Mike won against John');
      assert.match(res, /Couldn't parse that/);
    });

    it('should reject uneven sides with vs', () => {
      const uneven = handleScoreCommand('!score Mike & Sara vs John 6-4 6-2');
      assert.match(uneven, /Both sides need the same number of players/);
    });

    it('should reject an entire multi-score batch if any entry cannot be parsed', () => {
      const res = handleScoreCommand('!score Mike vs John 6-4 6-2\nAlice won against Bob');
      assert.match(res, /Couldn't parse entry #2/);
      assert.match(res, /No scores were recorded/);
    });

    it('should reject an entire multi-score batch if any entry has uneven sides', () => {
      const res = handleScoreCommand('!score Mike vs John 6-4; Alice & Sara vs Bob 6-2');
      assert.match(res, /Error on entry #2/);
      assert.match(res, /Both sides need the same number of players/);
      assert.match(res, /No scores were recorded/);
    });
  });

  describe('splitScoreCommandEntries', () => {
    it('should split entries on newlines and semicolons and strip prefixes/headers', () => {
      assert.deepEqual(
        splitScoreCommandEntries('Mike vs John 6-4; Alice vs Bob 6-3 6-2'),
        ['Mike vs John 6-4', 'Alice vs Bob 6-3 6-2']
      );

      assert.deepEqual(
        splitScoreCommandEntries(
          'Set 1:\n- Court 1: Mike & Sara vs John & Alex 6-4 4-6\n2. Match 2: Alice vs Bob 6-3 7-5\n• C3: Charlie def Dave 6-1'
        ),
        [
          'Mike & Sara vs John & Alex 6-4 4-6',
          'Alice vs Bob 6-3 7-5',
          'Charlie def Dave 6-1'
        ]
      );

      assert.deepEqual(
        splitScoreCommandEntries('  1) Roger vs Rafa 6-4 6-4  \n  Round 2: \n  Novak vs Andy 7-5 6-3 '),
        ['Roger vs Rafa 6-4 6-4', 'Novak vs Andy 7-5 6-3']
      );
    });
  });

  describe('parseMatchResultExpression', () => {
    it('should parse vs, vs., versus, and v. preserving order and format=vs', () => {
      const resDef = parseMatchResultExpression('Mike def John 6-4 6-2');
      assert.deepEqual(resDef, { winners: ['Mike'], losers: ['John'], sets: [[6, 4], [6, 2]], format: 'vs' });

      const resA = parseMatchResultExpression('Mike vs John 6-4 6-2');
      assert.deepEqual(resA, { winners: ['Mike'], losers: ['John'], sets: [[6, 4], [6, 2]], format: 'vs' });

      const resSplit = parseMatchResultExpression('Mike vs John 6-4 4-6');
      assert.deepEqual(resSplit, { winners: ['Mike'], losers: ['John'], sets: [[6, 4], [4, 6]], format: 'vs' });

      const resDoubles = parseMatchResultExpression('Mike & Sara vs. John & Alex 4-6 6-3 10-8');
      assert.deepEqual(resDoubles, {
        winners: ['Mike', 'Sara'],
        losers: ['John', 'Alex'],
        sets: [[4, 6], [6, 3], [10, 8]],
        format: 'vs'
      });

      const resReversedSplit = parseMatchResultExpression('Mike versus John 6-4 3-6 7-6(4)');
      assert.deepEqual(resReversedSplit, { winners: ['Mike'], losers: ['John'], sets: [[6, 4], [3, 6], [7, 6]], format: 'vs' });

      const resVDot = parseMatchResultExpression('Alice v. Bob 3-6 6-4 6-7(5)');
      assert.deepEqual(resVDot, { winners: ['Alice'], losers: ['Bob'], sets: [[3, 6], [6, 4], [6, 7]], format: 'vs' });
    });

    it('should parse comma-separated scores, parenthesized scores, and hyphenated doubles sides', () => {
      const resComma = parseMatchResultExpression('Mike & Sara vs John & Alex 6-4, 7-5');
      assert.deepEqual(resComma, {
        winners: ['Mike', 'Sara'],
        losers: ['John', 'Alex'],
        sets: [[6, 4], [7, 5]],
        format: 'vs'
      });

      const resParens = parseMatchResultExpression('Mike & Sara vs John & Alex (6-4 7-5)');
      assert.deepEqual(resParens, {
        winners: ['Mike', 'Sara'],
        losers: ['John', 'Alex'],
        sets: [[6, 4], [7, 5]],
        format: 'vs'
      });

      const resParensCommaTiebreak = parseMatchResultExpression('Mike & Sara vs John & Alex (7-6(4), 6-4)');
      assert.deepEqual(resParensCommaTiebreak, {
        winners: ['Mike', 'Sara'],
        losers: ['John', 'Alex'],
        sets: [[7, 6], [6, 4]],
        format: 'vs'
      });

      const resHyphenPlayers = parseMatchResultExpression('Mike-Sara vs John-Alex 6-4 7-5');
      assert.deepEqual(resHyphenPlayers, {
        winners: ['Mike', 'Sara'],
        losers: ['John', 'Alex'],
        sets: [[6, 4], [7, 5]],
        format: 'vs'
      });

      const resCombined = parseMatchResultExpression('Mike-Sara vs John-Alex (6-4, 7-5)');
      assert.deepEqual(resCombined, {
        winners: ['Mike', 'Sara'],
        losers: ['John', 'Alex'],
        sets: [[6, 4], [7, 5]],
        format: 'vs'
      });
    });

    it('should preserve a registered hyphenated player name in chat when matched as a single player', () => {
      const origFind = namesStore.findIdByNameOrAlias;
      namesStore.findIdByNameOrAlias = (name) => {
        if (name === 'Mary-Jane') return { id: 'mj@lid', entry: { name: 'Mary-Jane' } };
        if (name === 'Bob') return { id: 'bob@lid', entry: { name: 'Bob' } };
        return null;
      };
      try {
        const res = parseMatchResultExpression('Mary-Jane vs Bob 6-4 7-5', '120363@g.us');
        assert.deepEqual(res, {
          winners: ['Mary-Jane'],
          losers: ['Bob'],
          sets: [[6, 4], [7, 5]],
          format: 'vs'
        });
      } finally {
        namesStore.findIdByNameOrAlias = origFind;
      }
    });
  });

  describe('handleEditScore', () => {
    it('should support parenthesized and comma-separated scores as well as hyphenated sides', async () => {
      const origFindMatch = stats.findMatchByIdOrIndex;
      const origUpdateMatch = stats.updateMatch;
      const updates = [];

      const fakeMatch = {
        id: 'm_test_1',
        winner: 'Alice',
        loser: 'Bob',
        winners: ['Alice'],
        losers: ['Bob'],
        score: '6-4 6-4',
        sets: [[6, 4], [6, 4]]
      };
      stats.findMatchByIdOrIndex = () => fakeMatch;
      stats.updateMatch = (id, upd) => {
        updates.push({ id, upd });
        return { ...fakeMatch, ...upd };
      };

      try {
        const sock = { groupMetadata: async () => ({ participants: [] }) };
        const resScoreOnly = await handleEditScore(sock, '120363@g.us', 'alice@s.whatsapp.net', 'Alice', '#1 (6-4, 7-5)');
        assert.match(resScoreOnly, /Updated match score/);
        assert.deepEqual(updates[0].upd.sets, [[6, 4], [7, 5]]);
        assert.equal(updates[0].upd.score, '6-4 7-5');

        const resFull = await handleEditScore(sock, '120363@g.us', 'alice@s.whatsapp.net', 'Alice', '#1 Mike-Sara vs John-Alex (6-4 7-5)');
        assert.match(resFull, /Updated match score/);
        assert.deepEqual(updates[1].upd.winners, ['Mike', 'Sara']);
        assert.deepEqual(updates[1].upd.losers, ['John', 'Alex']);
        assert.deepEqual(updates[1].upd.sets, [[6, 4], [7, 5]]);
      } finally {
        stats.findMatchByIdOrIndex = origFindMatch;
        stats.updateMatch = origUpdateMatch;
      }
    });
  });

  describe('nameFor', () => {
    it('should format phone number digits if no registered name exists', () => {
      const formatted = nameFor('14085551234@s.whatsapp.net');
      assert.match(formatted, /1234/);
    });

    it('should return "Player" or digits for bare numbers', () => {
      const formatted = nameFor('9999@s.whatsapp.net');
      assert.match(formatted, /9999/);
    });
  });

  describe('canUserManagePlayerAlias', () => {
    it('should allow user to manage alias for themselves', async () => {
      const sock = {};
      const res = await canUserManagePlayerAlias(sock, '120363@g.us', '123@s.whatsapp.net', 'Alice', 'Alice');
      assert.equal(res, true);

      const res2 = await canUserManagePlayerAlias(sock, '120363@g.us', '123@s.whatsapp.net', 'Alice', 'me');
      assert.equal(res2, true);
    });
  });

  describe('tennisRecord configuration commands', () => {
    it('should display configuration via !trconfig', async () => {
      const sock = {
        groupMetadata: async () => ({ participants: [] })
      };
      const res = await handlePlayerCommand(sock, '!trconfig', '120363@g.us', 'Alice', '123@s.whatsapp.net');
      assert.ok(res);
      assert.match(res, /TennisRecord Configuration/);
      assert.match(res, /URL/);
      assert.match(res, /Timeout/);
    });

    it('should display cert status via !certstatus', async () => {
      const sock = {
        groupMetadata: async () => ({ participants: [] })
      };
      const res = await handlePlayerCommand(sock, '!certstatus', '120363@g.us', 'Alice', '123@s.whatsapp.net');
      assert.ok(res);
      assert.match(res, /TennisRecord SSL certificate check status/);
    });
  });
});
