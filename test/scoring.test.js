const assert = require('assert');
const S = require('../lib/scoring');

const pts = (side, n) => Array(n).fill(side);
const game = (side) => pts(side, 4);
const games = (side, n) => [].concat(...Array(n).fill(0).map(() => game(side)));

// Regular 6, with Ad, best of 3
const R = { games: 6, scoring: 'ad', setsMode: 'best3' };
let st = S.computeState(R, [...games('a', 6), ...games('a', 6)]);
assert.strictEqual(st.winner, 'a'); assert.strictEqual(S.scoreline(st), '6-0 6-0');

// Deuce / advantage
st = S.computeState(R, ['a','a','a','b','b','b']);
assert.deepStrictEqual(S.gameDisplay(R, st), { a: '40', b: '40' });
st = S.computeState(R, ['a','a','a','b','b','b','a']);
assert.deepStrictEqual(S.gameDisplay(R, st), { a: 'Ad', b: '40' });
st = S.computeState(R, ['a','a','a','b','b','b','a','b']);
assert.deepStrictEqual(S.gameDisplay(R, st), { a: '40', b: '40' });
st = S.computeState(R, ['a','a','a','b','b','b','a','a']);
assert.deepStrictEqual(st.games, { a: 1, b: 0 });

// No-Ad: sudden death at deuce
const NA = { games: 6, scoring: 'noad', setsMode: 'best3' };
st = S.computeState(NA, ['a','a','a','b','b','b','b']);
assert.deepStrictEqual(st.games, { a: 0, b: 1 });

// 6-5 continues, 7-5 wins set; 6-6 goes to tie-breaker
const alt = []; for (let i = 0; i < 5; i++) alt.push(...game('a'), ...game('b'));
st = S.computeState(R, alt);
assert.deepStrictEqual(st.games, { a: 5, b: 5 });
st = S.computeState(R, [...alt, ...game('a')]);
assert.deepStrictEqual(st.games, { a: 6, b: 5 }); assert.strictEqual(st.sets.length, 0);
st = S.computeState(R, [...alt, ...game('a'), ...game('a')]);
assert.strictEqual(S.scoreline(st), '7-5');
st = S.computeState(R, [...alt, ...game('a'), ...game('b')]);
assert.strictEqual(st.mode, 'tiebreak');
const tbLog = [...alt, ...game('a'), ...game('b'), ...pts('a', 5), ...pts('b', 5), 'a', 'a'];
st = S.computeState(R, tbLog);
assert.strictEqual(S.scoreline(st), '7-6(5)'); assert.strictEqual(st.mode, 'game');
st = S.computeState(R, [...alt, ...game('a'), ...game('b'), ...pts('a', 6), ...pts('b', 6), 'a']);
assert.strictEqual(st.mode, 'tiebreak'); assert.strictEqual(st.sets.length, 0);

// Fast 4: first to 4, tie-break at 3-3
const F = { games: 4, scoring: 'ad', setsMode: 'best3' };
st = S.computeState(F, games('a', 4)); assert.strictEqual(S.scoreline(st), '4-0');
const alt3 = []; for (let i = 0; i < 3; i++) alt3.push(...game('a'), ...game('b'));
st = S.computeState(F, alt3); assert.strictEqual(st.mode, 'tiebreak');
st = S.computeState(F, [...alt3, ...pts('b', 7)]); assert.strictEqual(S.scoreline(st), '3-4(0)');
st = S.computeState(F, [...games('a', 3), ...games('b', 2), ...game('a')]);   // 4-2
assert.strictEqual(S.scoreline(st), '4-2');

// Best of 2 + 10 point match tie-breaker
const M = { games: 4, scoring: 'noad', setsMode: 'best2_mtb10' };
st = S.computeState(M, [...games('a', 4), ...games('b', 4)]);
assert.strictEqual(st.mode, 'matchtb'); assert.strictEqual(st.winner, null);
st = S.computeState(M, [...games('a', 4), ...games('b', 4), ...pts('a', 9), ...pts('b', 9)]);
assert.strictEqual(st.mode, 'matchtb');
st = S.computeState(M, [...games('a', 4), ...games('b', 4), ...pts('a', 9), ...pts('b', 9), 'b', 'b']);
assert.strictEqual(st.winner, 'b'); assert.strictEqual(S.scoreline(st), '4-0 0-4 [9-11]');
st = S.computeState(M, [...games('a', 4), ...games('a', 4)]);
assert.strictEqual(st.winner, 'a'); assert.strictEqual(st.sets.length, 2);

// Best of 3 goes to a deciding full set at 1-1
st = S.computeState(R, [...games('a', 6), ...games('b', 6)]);
assert.strictEqual(st.mode, 'game'); assert.strictEqual(st.winner, null); assert.strictEqual(st.sets.length, 2);

// Points after the match ends are ignored
st = S.computeState(R, [...games('a', 12), 'b', 'b']);
assert.strictEqual(st.winner, 'a'); assert.strictEqual(st.sets.length, 2);

// Validation
assert.throws(() => S.normalizeFormat({ games: 5, scoring: 'ad', setsMode: 'best3' }));
console.log('scoring tests passed');

/* ---------------- serve rotation ---------------- */
{
  const R = { games: 6, scoring: 'ad', setsMode: 'best3' };
  const srv = (log, serve, dbl) => S.serverFor(R, S.computeState(R, log), serve, dbl);
  // singles: alternate every game
  assert.deepStrictEqual(srv([], { first: 'b' }), { side: 'b', player: null });
  assert.strictEqual(srv(['a', 'a'], { first: 'b' }).side, 'b');           // mid-game: no change
  assert.strictEqual(srv(game('a'), { first: 'b' }).side, 'a');
  assert.strictEqual(srv([...game('a'), ...game('a')], { first: 'b' }).side, 'b');
  assert.strictEqual(srv([], null), null);
  // doubles rotation: A1, B2, A2, B1 when A starts with player 1 and B with player 2
  const sv = { first: 'a', aFirst: 1, bFirst: 2 };
  const seq = [0, 1, 2, 3, 4].map((g) => srv(games('a', g), sv, true));
  assert.deepStrictEqual(seq, [{ side: 'a', player: 1 }, { side: 'b', player: 2 }, { side: 'a', player: 2 }, { side: 'b', player: 1 }, { side: 'a', player: 1 }]);
  // tie-breaker at 6-6 (12 games played): point 1 by A1, then B2 x2, then A2 x2
  const at66 = []; for (let i = 0; i < 6; i++) at66.push(...game('a'), ...game('b'));
  const tb = (n) => srv([...at66, ...pts('a', n)], sv, true);
  assert.deepStrictEqual(tb(0), { side: 'a', player: 1 });
  assert.deepStrictEqual(tb(1), { side: 'b', player: 2 });
  assert.deepStrictEqual(tb(2), { side: 'b', player: 2 });
  assert.deepStrictEqual(tb(3), { side: 'a', player: 2 });
  // after the tie-break set (13 games), the side that received first serves: B
  const afterTb = [...at66, ...pts('a', 7)];
  assert.strictEqual(S.computeState(R, afterTb).sets.length, 1);
  assert.deepStrictEqual(srv(afterTb, sv, true), { side: 'b', player: 2 });
  // finished match: nobody serves
  assert.strictEqual(srv(games('a', 12), sv, true), null);

  // set 2 after a 6-0 set (6 games): A serves first again, and the rotation carries on (A2, B1)
  const set1 = games('a', 6);
  assert.deepStrictEqual(S.serveOrder(S.computeState(R, set1), sv), { set: 2, chosen: false, aFirst: 2, bFirst: 1, aDeuce: null, bDeuce: null, startsAt: 6 });
  assert.deepStrictEqual(srv(set1, sv, true), { side: 'a', player: 2 });
  // both teams change their order for set 2: A1, B2, then A2, B1
  const sv2 = { ...sv, sets: [{ set: 2, aFirst: 1, bFirst: 2 }] };
  assert.deepStrictEqual([0, 1, 2, 3].map((g) => srv([...set1, ...games('a', g)], sv2, true)),
    [{ side: 'a', player: 1 }, { side: 'b', player: 2 }, { side: 'a', player: 2 }, { side: 'b', player: 1 }]);
  assert.strictEqual(S.serveOrder(S.computeState(R, set1), sv2).chosen, true);
  // a set-2 order does not touch set 1
  assert.deepStrictEqual(srv(games('a', 2), sv2, true), { side: 'a', player: 2 });
  // set 2 after 6-3 (9 games): B serves the first game of set 2
  const set63 = []; for (let i = 0; i < 3; i++) set63.push(...game('a'), ...game('b')); set63.push(...games('a', 3));
  const o = S.serveOrder(S.computeState(R, set63), sv);
  assert.strictEqual(srv(set63, sv, true).side, 'b');
  assert.deepStrictEqual(srv(set63, { ...sv, sets: [{ set: 2, aFirst: 2, bFirst: 1 }] }, true), { side: 'b', player: 1 });
  assert.deepStrictEqual(srv(set63, sv, true), { side: 'b', player: o.bFirst });
}

/* ---------------- courts, receivers and ends ---------------- */
{
  const R = { games: 6, scoring: 'ad', setsMode: 'best3' };
  const NA = { games: 6, scoring: 'noad', setsMode: 'best3' };
  const st = (log, f = R) => S.computeState(f, log);
  const sv = { first: 'a', aFirst: 1, bFirst: 2, aDeuce: 2, bDeuce: 1 };
  const toss = { winner: 'b', choice: 'end', decision: 'serve', end: 'Pool end' }; // B picked the end, A serves
  const pos = (log, f = R) => S.positions(f, st(log, f), sv, true, toss);

  // first point: A1 serves from deuce to B1 (B's deuce receiver); B starts at the Pool end
  assert.deepStrictEqual(pos([]), { server: { side: 'a', player: 1 }, receiver: { side: 'b', player: 1 }, court: 'deuce', receiverChooses: false, changeEnds: false, atEnd: 'b' });
  // second point: ad court, B2 receives
  assert.deepStrictEqual([pos(['a']).court, pos(['a']).receiver], ['ad', { side: 'b', player: 2 }]);
  // deuce (3-3) is played from the deuce court, advantage from the ad court
  assert.strictEqual(pos(['a', 'a', 'a', 'b', 'b', 'b']).court, 'deuce');
  assert.strictEqual(pos(['a', 'a', 'a', 'b', 'b', 'b', 'a']).court, 'ad');
  // no-Ad deciding point: the receivers choose
  const dp = pos(['a', 'a', 'a', 'b', 'b', 'b'], NA);
  assert.deepStrictEqual([dp.receiverChooses, dp.receiver], [true, { side: 'b', player: null }]);
  // ends change after games 1, 3, 5...: A is at the Pool end after game 1, B again after game 3
  assert.deepStrictEqual([pos(game('a')).changeEnds, pos(game('a')).atEnd], [true, 'a']);
  assert.deepStrictEqual([pos(games('a', 2)).changeEnds, pos(games('a', 2)).atEnd], [false, 'a']);
  assert.strictEqual(pos(games('a', 3)).atEnd, 'b');
  // set ends 6-0 (even): no change before set 2, change after its first game
  assert.deepStrictEqual([pos(games('a', 6)).changeEnds, pos(games('a', 6)).atEnd], [false, 'a']); // 3 changes
  assert.strictEqual(pos(games('a', 7)).changeEnds, true);
  // set ends 6-3 (odd): change before set 2
  const s63 = []; for (let i = 0; i < 3; i++) s63.push(...game('a'), ...game('b')); s63.push(...games('a', 3));
  assert.strictEqual(pos(s63).changeEnds, true);
  // next change: after game 1, then 3; during a game it is that game if odd
  assert.deepStrictEqual(S.nextEndChange(R, st([])), { game: 1 });
  assert.deepStrictEqual(S.nextEndChange(R, st(game('a'))), { game: 3 });
  assert.deepStrictEqual(S.nextEndChange(R, st([...games('a', 2), 'a'])), { game: 3 });
  const at65 = []; for (let i = 0; i < 5; i++) at65.push(...game('a'), ...game('b')); at65.push(...game('a'));
  assert.deepStrictEqual(S.nextEndChange(R, st(at65)), { game: 13, tiebreak: true });
  const at66b = [...at65, ...game('b')];
  assert.deepStrictEqual(S.nextEndChange(R, st(at66b)), { point: 6, orAtEnd: true });
  assert.deepStrictEqual(S.nextEndChange(R, st([...at66b, ...pts('a', 6)])), { point: 12, orAtEnd: true });
  const MT = { games: 4, scoring: 'noad', setsMode: 'best2_mtb10' };
  assert.deepStrictEqual(S.nextEndChange(MT, S.computeState(MT, [...games('a', 4), ...games('b', 4), 'a'])), { point: 6, orAtEnd: false });
  // Fast 4 at 3-2: the 7th game would be the tie-breaker
  assert.deepStrictEqual(S.nextEndChange(MT, S.computeState(MT, [...games('a', 3), ...games('b', 2)])), { game: 7, tiebreak: true });
  // no toss: ends unknown, changes still shown
  assert.strictEqual(S.positions(R, st(game('a')), sv, true, null).atEnd, null);
  // singles: no player numbers
  assert.deepStrictEqual(S.positions(R, st([]), { first: 'b' }, false, null).receiver, { side: 'a', player: null });

  // tie-breaker at 6-6, won 7-5 by A: 12 points
  const at66 = []; for (let i = 0; i < 6; i++) at66.push(...game('a'), ...game('b'));
  const tbLog = [...at66, ...['a', 'b', 'a', 'b', 'a', 'b', 'a', 'b', 'a', 'b', 'a', 'a']];
  const [tb] = S.tiebreakPoints(R, tbLog, sv, true, toss);
  assert.strictEqual(tb.set, 1); assert.strictEqual(tb.mtb, false); assert.strictEqual(tb.points.length, 12);
  // 12 games played = 6 changes, so B is back at the Pool end; A1 serves point 1 from deuce
  assert.deepStrictEqual(tb.points[0], { n: 1, won: 'a', score: { a: 1, b: 0 }, server: { side: 'a', player: 1 }, receiver: { side: 'b', player: 1 }, court: 'deuce', receiverChooses: false, changeEnds: false, atEnd: 'b' });
  // points 2-3 by B2 (ad then deuce), points 4-5 by A2
  assert.deepStrictEqual(tb.points.slice(1, 5).map((p) => [p.server.side + p.server.player, p.court]), [['b2', 'ad'], ['b2', 'deuce'], ['a2', 'ad'], ['a2', 'deuce']]);
  // change ends after 6 points
  assert.deepStrictEqual(tb.points.map((p) => p.changeEnds), [false, false, false, false, false, false, true, false, false, false, false, false]);
  assert.strictEqual(tb.points[6].atEnd, 'a');
  assert.deepStrictEqual(tb.points[11].score, { a: 7, b: 5 });
  // after the tie-break set (13 games, odd): change ends before set 2; set 1 had 7 + 1 changes
  assert.strictEqual(S.changeEndsNow(st(tbLog)), true);
  assert.strictEqual(S.endChanges(st(tbLog)), 8);

  // match tie-breaker: set 2 ended 6-0 after 6-0 the other way, change every 6 points
  const M = { games: 6, scoring: 'ad', setsMode: 'best2_mtb10' };
  const mtb = S.tiebreakPoints(M, [...games('a', 6), ...games('b', 6), ...pts('a', 10)], sv, true, toss);
  assert.strictEqual(mtb.length, 1); assert.strictEqual(mtb[0].mtb, true); assert.strictEqual(mtb[0].set, 3);
  assert.deepStrictEqual(mtb[0].points.filter((p) => p.changeEnds).map((p) => p.n), [7]);
  // a later set's receiving sides replace the earlier ones
  const sv2 = { ...sv, sets: [{ set: 2, aFirst: 1, bFirst: 1, bDeuce: 2 }] };
  assert.deepStrictEqual(S.serveOrder(st(games('a', 6)), sv2).bDeuce, 2);
  assert.deepStrictEqual(S.serveOrder(st(games('a', 6)), sv2).aDeuce, 2);
}

/* ---------------- coin toss ---------------- */
{
  // winner A chooses to serve or receive and receives: B serves first; B picks the end
  assert.deepStrictEqual(S.tossOutcome({ winner: 'a', choice: 'serve', decision: 'receive' }),
    { chooser: 'a', pick: 'serve', serveChooser: 'a', endChooser: 'b', firstServer: 'b' });
  // winner A chooses the end: B decides, and serves
  assert.strictEqual(S.tossOutcome({ winner: 'a', choice: 'end', decision: 'serve' }).firstServer, 'b');
  // winner B defers, A picks the end, B then decides to serve
  const d = S.tossOutcome({ winner: 'b', choice: 'defer', deferredChoice: 'end', decision: 'serve' });
  assert.deepStrictEqual([d.chooser, d.endChooser, d.serveChooser, d.firstServer], ['a', 'a', 'b', 'b']);
  assert.throws(() => S.tossOutcome({ winner: 'a', choice: 'defer', decision: 'serve' }), /deferred/);
  assert.throws(() => S.tossOutcome({ winner: 'a', choice: 'serve' }), /serve or receive/);
  assert.throws(() => S.tossOutcome({}), /won the toss/);
}

/* ---------------- manual final score ---------------- */
{
  const R = { games: 6, scoring: 'ad', setsMode: 'best3' };
  const F2 = { games: 4, scoring: 'noad', setsMode: 'best2_mtb10' };
  let s1 = S.stateFromSets(R, [{ a: 6, b: 4 }, { a: 7, b: 6, tbLoser: 5 }]);
  assert.strictEqual(s1.winner, 'a'); assert.strictEqual(S.scoreline(s1), '6-4 7-6(5)'); assert.deepStrictEqual(s1.sets[1].tb, { a: 7, b: 5 });
  s1 = S.stateFromSets(R, [{ a: 6, b: 4 }, { a: 3, b: 6 }, { a: 5, b: 7 }]);
  assert.strictEqual(s1.winner, 'b');
  s1 = S.stateFromSets(R, [{ a: 7, b: 6 }, { a: 6, b: 0 }]);                    // tie-break points optional
  assert.strictEqual(S.scoreline(s1), '7-6 6-0');
  s1 = S.stateFromSets(R, [{ a: 6, b: 7, tbLoser: 10 }, { a: 0, b: 6 }]);
  assert.deepStrictEqual(s1.sets[0].tb, { a: 10, b: 12 });
  s1 = S.stateFromSets(F2, [{ a: 4, b: 2 }, { a: 3, b: 4, tbLoser: 4 }, { a: 8, b: 10 }]);
  assert.strictEqual(s1.winner, 'b'); assert.strictEqual(S.scoreline(s1), '4-2 3-4(4) [8-10]');
  s1 = S.stateFromSets(F2, [{ a: 4, b: 1 }, { a: 4, b: 0 }, { a: '', b: '' }]);   // blank 3rd row ignored
  assert.strictEqual(s1.winner, 'a');
  for (const [fmt, sets] of [
    [R, [{ a: 6, b: 5 }, { a: 6, b: 0 }]],          // 6-5 is not a finished set
    [R, [{ a: 8, b: 6 }, { a: 6, b: 0 }]],
    [R, [{ a: 6, b: 4 }]],                           // match not finished
    [R, [{ a: 6, b: 4 }, { a: 6, b: 4 }, { a: 6, b: 4 }]], // extra set
    [R, [{ a: 6, b: 4, tbLoser: 3 }, { a: 6, b: 0 }]], // tb points on a non-tb set
    [F2, [{ a: 4, b: 3 }, { a: 2, b: 4 }]],          // needs the match tie-breaker
    [F2, [{ a: 5, b: 3 }, { a: 4, b: 0 }]],
    [F2, [{ a: 4, b: 0 }, { a: 0, b: 4 }, { a: 10, b: 9 }]],
    [F2, [{ a: 4, b: 0 }, { a: 0, b: 4 }, { a: 13, b: 10 }]],
    [R, [{ a: 6.5, b: 4 }, { a: 6, b: 0 }]],
  ]) assert.throws(() => S.stateFromSets(fmt, sets), JSON.stringify(sets));
}
console.log('serve + manual score tests passed');

/* ---------------- match stats ---------------- */
{
  const R = { games: 6, scoring: 'ad', setsMode: 'best3' };
  // A serves game 1 and holds to love; B serves game 2: A gets 40-0 (3 break points), B saves one, A breaks.
  const log = [...game('a'), 'a', 'a', 'a', 'b', 'a'];
  const st = S.matchStats(R, log, { first: 'a' });
  assert.strictEqual(st.hasServe, true);
  assert.strictEqual(st.a.serviceGames, 1); assert.strictEqual(st.a.serviceGamesHeld, 1);
  assert.strictEqual(st.b.serviceGames, 1); assert.strictEqual(st.b.serviceGamesHeld, 0);
  assert.strictEqual(st.a.breaks, 1);
  assert.strictEqual(st.b.breakPointsFaced, 2); assert.strictEqual(st.b.breakPointsSaved, 1);
  assert.strictEqual(st.a.breakPointChances, 2);
  assert.strictEqual(st.a.pointsWon, 8); assert.strictEqual(st.b.pointsWon, 1);
  assert.strictEqual(st.a.servePoints, 4); assert.strictEqual(st.a.servePointsWon, 4);
  assert.strictEqual(st.a.returnPoints, 5); assert.strictEqual(st.a.returnPointsWon, 4);
  assert.strictEqual(st.a.longestRun, 7);
  // without serve info only point totals
  const ns = S.matchStats(R, log, null);
  assert.strictEqual(ns.hasServe, false); assert.strictEqual(ns.a.pointsWon, 8); assert.strictEqual(ns.a.servePoints, 0);
  // no-ad deuce point is a break point
  const NA = { games: 6, scoring: 'noad', setsMode: 'best3' };
  const st2 = S.matchStats(NA, ['a', 'a', 'a', 'b', 'b', 'b', 'a'], { first: 'b' });
  assert.strictEqual(st2.b.breakPointsFaced, 4); assert.strictEqual(st2.b.breakPointsSaved, 3); assert.strictEqual(st2.a.breaks, 1);
}
console.log('stats tests passed');
