const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { parseScoreReport, parseScoreReports, DEFAULT_SET } = require('../lib/scoreReport');

describe('scoreReport', () => {
  const dummyOptions = {
    resolveName: (raw) => {
      const lower = String(raw).trim().toLowerCase();
      const known = {
        mike: 'Mike',
        sara: 'Sara',
        john: 'John',
        alex: 'Alex',
        alice: 'Alice',
        bob: 'Bob'
      };
      return known[lower] || null;
    },
    findMatchup: () => null
  };

  it('should parse "A & B beat C & D <score>"', () => {
    const report = parseScoreReport('Mike & Sara beat John & Alex 6-4 6-2', dummyOptions);
    assert.ok(report);
    assert.equal(report.format, 'vs');
    assert.deepEqual(report.winners, ['Mike', 'Sara']);
    assert.deepEqual(report.losers, ['John', 'Alex']);
    assert.deepEqual(report.sets, [[6, 4], [6, 2]]);
    assert.equal(report.assumedScore, false);
  });

  it('should parse "A def B <score>" in singles', () => {
    const report = parseScoreReport('Alice def Bob 6-3 6-4', dummyOptions);
    assert.ok(report);
    assert.equal(report.format, 'vs');
    assert.deepEqual(report.winners, ['Alice']);
    assert.deepEqual(report.losers, ['Bob']);
    assert.deepEqual(report.sets, [[6, 3], [6, 4]]);
  });

  it('should parse "A vs B <score>" directly as vs including 2-set splits', () => {
    const reportA = parseScoreReport('Alice vs Bob 6-3 6-4', dummyOptions);
    assert.ok(reportA);
    assert.equal(reportA.format, 'vs');
    assert.deepEqual(reportA.winners, ['Alice']);
    assert.deepEqual(reportA.losers, ['Bob']);
    assert.deepEqual(reportA.sets, [[6, 3], [6, 4]]);

    const reportSplit = parseScoreReport('Alice vs. Bob 6-4 4-6', dummyOptions);
    assert.ok(reportSplit);
    assert.equal(reportSplit.format, 'vs');
    assert.deepEqual(reportSplit.winners, ['Alice']);
    assert.deepEqual(reportSplit.losers, ['Bob']);
    assert.deepEqual(reportSplit.sets, [[6, 4], [4, 6]]);

    const doublesReport = parseScoreReport('Mike & Sara versus John & Alex 3-6 6-4 10-8', dummyOptions);
    assert.ok(doublesReport);
    assert.equal(doublesReport.format, 'vs');
    assert.deepEqual(doublesReport.winners, ['Mike', 'Sara']);
    assert.deepEqual(doublesReport.losers, ['John', 'Alex']);
    assert.deepEqual(doublesReport.sets, [[3, 6], [6, 4], [10, 8]]);
  });

  it('should return null for "A vs B" when no score is given', () => {
    assert.equal(parseScoreReport('Alice vs Bob', dummyOptions), null);
  });

  it('should parse score with tiebreak notation', () => {
    const report = parseScoreReport('Alice def Bob 7-6(4) 6-4', dummyOptions);
    assert.ok(report);
    assert.deepEqual(report.sets, [[7, 6], [6, 4]]);
  });

  it('should parse "we won" using findMatchup resolver', () => {
    const optionsWithMatchup = {
      resolveName: (raw) => (String(raw).trim().toLowerCase() === 'we' ? 'Alice' : null),
      findMatchup: (names) => {
        if (names.includes('Alice')) {
          return { team: ['Alice', 'Bob'], opponents: ['Charlie', 'Dave'] };
        }
        return null;
      }
    };

    const report = parseScoreReport('we won 6-4', optionsWithMatchup);
    assert.ok(report);
    assert.deepEqual(report.winners, ['Alice', 'Bob']);
    assert.deepEqual(report.losers, ['Charlie', 'Dave']);
    assert.deepEqual(report.sets, [[6, 4]]);
  });

  it('should return null for non-score messages and general banter', () => {
    assert.equal(parseScoreReport('we beat the traffic today', dummyOptions), null);
    assert.equal(parseScoreReport('who won the US Open?', dummyOptions), null);
    assert.equal(parseScoreReport('hello everyone', dummyOptions), null);
  });

  describe('parseScoreReports (multi-match)', () => {
    it('should parse multiple matches across lines with Court prefixes', () => {
      const reports = parseScoreReports(
        'Court 1: Mike & Sara vs John & Alex 6-4 6-2\nCourt 2: Alice vs Bob 6-3 4-6',
        dummyOptions
      );
      assert.equal(reports.length, 2);
      assert.deepEqual(reports[0].winners, ['Mike', 'Sara']);
      assert.deepEqual(reports[0].losers, ['John', 'Alex']);
      assert.deepEqual(reports[0].sets, [[6, 4], [6, 2]]);
      assert.deepEqual(reports[1].winners, ['Alice']);
      assert.deepEqual(reports[1].losers, ['Bob']);
      assert.deepEqual(reports[1].sets, [[6, 3], [4, 6]]);
    });

    it('should parse semicolon-separated matches and mixed chat messages', () => {
      const semiReports = parseScoreReports(
        'Mike vs John 6-4; Alice beat Bob 6-2 6-3',
        dummyOptions
      );
      assert.equal(semiReports.length, 2);
      assert.deepEqual(semiReports[0].sets, [[6, 4]]);
      assert.deepEqual(semiReports[1].sets, [[6, 2], [6, 3]]);

      const mixedReports = parseScoreReports(
        'Great games today! Mike beat John 6-4. Alice vs Bob 6-3 7-5.',
        dummyOptions
      );
      assert.equal(mixedReports.length, 2);
      assert.deepEqual(mixedReports[0].winners, ['Mike']);
      assert.deepEqual(mixedReports[1].winners, ['Alice']);
    });
  });
});
