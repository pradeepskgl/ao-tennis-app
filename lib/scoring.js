/*
 * Tennis scoring engine (shared by the server and the browser).
 *
 * Match state is always derived by replaying the point log ("a" / "b" per point),
 * which makes undo trivial and keeps the server the single source of truth.
 *
 * Format:
 *   games     4 (Fast 4) or 6 (Regular 6)
 *   scoring   'ad' (advantage) or 'noad' (sudden-death at deuce)
 *   setsMode  'best3'        - first to 2 sets
 *             'best2_mtb10'  - best of 2 sets; at 1-1 a 10-point match tie-breaker
 *
 * Set rules:
 *   Fast 4     first to 4 games; at 3-3 a 7-point tie-breaker (win by 2) decides the set (4-3)
 *   Regular 6  first to 6 games, 2 clear; at 6-6 a 7-point tie-breaker (win by 2) decides the set (7-6)
 * Match tie-breaker: first to 10, win by 2.
 *
 * Serve: sides alternate every game (a tie-breaker counts as one game in the rotation).
 * In a tie-breaker the player due to serve takes the first point, then players alternate
 * every two points. Doubles rotate A-first, B-first, A-second, B-second.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Scoring = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const other = (s) => (s === 'a' ? 'b' : 'a');
  const DEFAULT_FORMAT = { games: 6, scoring: 'ad', setsMode: 'best3' };

  function normalizeFormat(f) {
    const games = Number(f && f.games);
    if (![4, 6].includes(games)) throw new Error('Games per set must be 4 (Fast 4) or 6 (Regular 6)');
    if (!f || !['ad', 'noad'].includes(f.scoring)) throw new Error('Scoring must be "ad" or "noad"');
    if (!['best3', 'best2_mtb10'].includes(f.setsMode)) throw new Error('Sets must be "best3" or "best2_mtb10"');
    return { games, scoring: f.scoring, setsMode: f.setsMode };
  }

  const newState = () => ({ sets: [], games: { a: 0, b: 0 }, points: { a: 0, b: 0 }, mode: 'game', winner: null });
  const tiebreakAt = (f) => (f.games === 4 ? 3 : 6);

  function closeSet(f, st, extra) {
    st.sets.push(Object.assign({ a: st.games.a, b: st.games.b }, extra || {}));
    st.games = { a: 0, b: 0 };
    st.points = { a: 0, b: 0 };
    st.mode = 'game';
    const wins = { a: 0, b: 0 };
    st.sets.forEach((s) => { wins[s.a > s.b ? 'a' : 'b']++; });
    if (wins.a === 2 || wins.b === 2) st.winner = wins.a === 2 ? 'a' : 'b';
    else if (f.setsMode === 'best2_mtb10' && st.sets.length === 2) st.mode = 'matchtb';
  }

  function afterGame(f, st, s) {
    const g = st.games;
    const o = other(s);
    const setWon = f.games === 4 ? g[s] === 4 : g[s] >= 6 && g[s] - g[o] >= 2;
    if (setWon) closeSet(f, st);
    else if (g.a === tiebreakAt(f) && g.b === tiebreakAt(f)) st.mode = 'tiebreak';
  }

  function applyPoint(f, st, s) {
    const o = other(s);
    const p = st.points;
    p[s]++;
    if (st.mode === 'matchtb') {
      if (p[s] >= 10 && p[s] - p[o] >= 2) closeSet(f, st, { a: p.a, b: p.b, mtb: true });
      return;
    }
    if (st.mode === 'tiebreak') {
      if (p[s] >= 7 && p[s] - p[o] >= 2) {
        st.games[s]++;
        closeSet(f, st, { tb: { a: p.a, b: p.b } });
      }
      return;
    }
    const gameWon = f.scoring === 'ad' ? p[s] >= 4 && p[s] - p[o] >= 2 : p[s] >= 4;
    if (gameWon) {
      st.points = { a: 0, b: 0 };
      st.games[s]++;
      afterGame(f, st, s);
    }
  }

  function computeState(format, log) {
    const f = normalizeFormat(format);
    const st = newState();
    for (const side of log) {
      if (st.winner) break;
      applyPoint(f, st, side);
    }
    return st;
  }

  // Games played so far in the match (a tie-break set counts its tie-breaker as one game).
  function gamesPlayed(st) {
    let n = 0;
    st.sets.forEach((s) => { if (!s.mtb) n += s.a + s.b; });
    return n + st.games.a + st.games.b;
  }

  /*
   * Doubles serving order for the set in progress (the match tie-breaker counts as a set).
   * serve.sets = [{ set, aFirst, bFirst }] holds orders chosen again at the start of a later set;
   * without one the rotation simply carries on from the previous set.
   * Returns { set, chosen, aFirst, bFirst, startsAt } where aFirst/bFirst say which player of each
   * team serves that team's first game of the set, and startsAt is the rotation count at set start.
   */
  function serveOrder(st, serve) {
    const sv = serve || {};
    const pick = (v) => (Number(v) === 2 ? 2 : 1);
    const set = st.sets.length + 1;
    const startsAt = gamesPlayed(st) - st.games.a - st.games.b;
    const sets = Array.isArray(sv.sets) ? sv.sets.filter(Boolean) : [];
    // aDeuce/bDeuce: which player of each team receives in the deuce court (null = not recorded).
    // A team keeps its receiving sides until it records new ones for a later set.
    const deuce = (v) => ([1, 2].includes(Number(v)) ? Number(v) : null);
    const recv = { aDeuce: deuce(sv.aDeuce), bDeuce: deuce(sv.bDeuce) };
    sets.filter((o) => Number(o.set) <= set).sort((x, y) => x.set - y.set).forEach((o) => {
      if (deuce(o.aDeuce)) recv.aDeuce = deuce(o.aDeuce);
      if (deuce(o.bDeuce)) recv.bDeuce = deuce(o.bDeuce);
    });
    const own = set > 1 ? sets.find((o) => Number(o.set) === set) : null;
    if (own) return { set, chosen: true, aFirst: pick(own.aFirst), bFirst: pick(own.bFirst), ...recv, startsAt };
    if (!['a', 'b'].includes(sv.first)) return { set, chosen: false, aFirst: pick(sv.aFirst), bFirst: pick(sv.bFirst), ...recv, startsAt };
    // Carry on the match rotation: find each team's first service game of this set.
    const carried = (s, base) => {
      const n = (startsAt % 2 === 0) === (s === sv.first) ? startsAt : startsAt + 1;
      return Math.floor(n / 2) % 2 === 0 ? base : 3 - base;
    };
    return { set, chosen: false, aFirst: carried('a', pick(sv.aFirst)), bFirst: carried('b', pick(sv.bFirst)), ...recv, startsAt };
  }

  /*
   * Ends: players change ends after the 1st, 3rd, 5th... game of each set (a set tie-breaker
   * counts as one game, so this also covers the change at the end of a set), and after every
   * 6 points of a tie-breaker. endChanges counts the changes so far.
   */
  function endChanges(st) {
    let n = 0;
    st.sets.forEach((s) => {
      if (s.mtb) return void (n += Math.floor((s.a + s.b - 1) / 6));
      n += Math.floor((s.a + s.b + 1) / 2);
      if (s.tb) n += Math.floor((s.tb.a + s.tb.b - 1) / 6);
    });
    n += Math.floor((st.games.a + st.games.b + 1) / 2);
    if (st.mode !== 'game') n += Math.floor((st.points.a + st.points.b) / 6);
    return n;
  }

  // True when the players change ends before the next point.
  function changeEndsNow(st) {
    if (st.winner) return false;
    const p = st.points.a + st.points.b;
    if (p > 0) return st.mode !== 'game' && p % 6 === 0;
    const k = st.games.a + st.games.b;
    if (k > 0) return k % 2 === 1;
    const last = st.sets[st.sets.length - 1];
    return !!last && !last.mtb && (last.a + last.b) % 2 === 1;
  }

  /*
   * When the players next change ends, seen from before the next point. null once the match is over.
   *   { game: n }                       after game n of this set
   *   { game: n, tiebreak: true }       game n would be the set tie-breaker: after its 6th point,
   *                                     or after game 1 of the next set if this set ends first
   *   { point: n, orAtEnd: bool }       after point n of the tie-breaker in progress (orAtEnd: a set
   *                                     tie-breaker also ends with a change if it finishes sooner)
   */
  function nextEndChange(format, st) {
    if (!st || st.winner) return null;
    const f = normalizeFormat(format);
    if (st.mode !== 'game') {
      return { point: (Math.floor((st.points.a + st.points.b) / 6) + 1) * 6, orAtEnd: st.mode === 'tiebreak' };
    }
    const k = st.games.a + st.games.b;
    const game = k % 2 === 0 ? k + 1 : k + 2;
    return game === 2 * tiebreakAt(f) + 1 ? { game, tiebreak: true } : { game };
  }

  /*
   * Where everyone stands for the next point.
   * Returns null once the match is over, otherwise
   *   { server, receiver, court, receiverChooses, changeEnds, atEnd }
   *   server/receiver  { side, player } (player is null in singles or when not recorded); null without serve info
   *   court            'deuce' | 'ad': where the server serves from and the receiver receives
   *   receiverChooses  no-Ad deciding point: the receiving side picks the court
   *   changeEnds       the players change ends before this point
   *   atEnd            side at the end named in the toss (toss.end), or null without a toss
   */
  function positions(format, st, serve, doubles, toss) {
    if (!st || st.winner) return null;
    const f = normalizeFormat(format);
    const court = (st.points.a + st.points.b) % 2 === 0 ? 'deuce' : 'ad';
    const receiverChooses = st.mode === 'game' && f.scoring === 'noad' && st.points.a === 3 && st.points.b === 3;
    const server = serverFor(f, st, serve, doubles);
    let receiver = null;
    if (server) {
      const side = other(server.side);
      const deuce = doubles && !receiverChooses ? serveOrder(st, serve)[side + 'Deuce'] : null;
      receiver = { side, player: deuce ? (court === 'deuce' ? deuce : 3 - deuce) : null };
    }
    let atEnd = null;
    if (toss) {
      try {
        const o = tossOutcome(toss);
        atEnd = endChanges(st) % 2 === 0 ? o.endChooser : other(o.endChooser);
      } catch (e) { /* incomplete toss: ends unknown */ }
    }
    return { server, receiver, court, receiverChooses, changeEnds: changeEndsNow(st), atEnd };
  }

  /*
   * Point-by-point detail of every tie-breaker (set and match tie-breakers) in the log.
   * Returns [{ set, mtb, points: [{ n, won, score, ...positions }] }]; score is after the point.
   */
  function tiebreakPoints(format, log, serve, doubles, toss) {
    const f = normalizeFormat(format);
    const st = newState();
    const out = [];
    let cur = null;
    for (const side of log || []) {
      if (st.winner) break;
      if (st.mode === 'game') {
        applyPoint(f, st, side);
        continue;
      }
      if (!cur) out.push((cur = { set: st.sets.length + 1, mtb: st.mode === 'matchtb', points: [] }));
      const pos = positions(f, st, serve, doubles, toss);
      const score = { a: st.points.a, b: st.points.b };
      score[side]++;
      const setsBefore = st.sets.length;
      applyPoint(f, st, side);
      cur.points.push({ n: cur.points.length + 1, won: side, score, ...pos });
      if (st.sets.length !== setsBefore) cur = null;
    }
    return out;
  }

  /*
   * Who serves the next point.
   * serve = { first: 'a'|'b', aFirst: 1|2, bFirst: 1|2, sets? }  (aFirst/bFirst/sets only matter in doubles)
   * Returns { side, player } (player is 1 or 2 in doubles, null in singles) or null if unknown.
   */
  function serverFor(format, st, serve, doubles) {
    if (!serve || !['a', 'b'].includes(serve.first) || !st || st.winner) return null;
    let n = gamesPlayed(st);
    if (st.mode !== 'game') n += Math.floor((st.points.a + st.points.b + 1) / 2);
    const side = n % 2 === 0 ? serve.first : other(serve.first);
    if (!doubles) return { side, player: null };
    const order = serveOrder(st, serve);
    const first = side === 'a' ? order.aFirst : order.bFirst;
    return { side, player: Math.floor((n - order.startsAt) / 2) % 2 === 0 ? first : 3 - first };
  }

  /*
   * Coin toss. toss = { winner, choice: 'serve'|'end'|'defer', deferredChoice?: 'serve'|'end',
   *                     decision: 'serve'|'receive' }
   * The winner picks serve/receive or the end, or defers so the opponent picks first; the other
   * side then gets the remaining choice.
   * Returns { chooser, pick, serveChooser, endChooser, firstServer }; throws a readable Error if incomplete.
   */
  function tossOutcome(toss) {
    const t = toss || {};
    if (!['a', 'b'].includes(t.winner)) throw new Error('Choose who won the toss.');
    if (!['serve', 'end', 'defer'].includes(t.choice)) throw new Error("Choose the toss winner's choice.");
    const chooser = t.choice === 'defer' ? other(t.winner) : t.winner;
    const pick = t.choice === 'defer' ? t.deferredChoice : t.choice;
    if (!['serve', 'end'].includes(pick)) throw new Error('The toss winner deferred: choose what the opponent picked.');
    if (!['serve', 'receive'].includes(t.decision)) throw new Error('Choose whether to serve or receive first.');
    const serveChooser = pick === 'serve' ? chooser : other(chooser);
    return { chooser, pick, serveChooser, endChooser: other(serveChooser), firstServer: t.decision === 'serve' ? serveChooser : other(serveChooser) };
  }

  function toScore(v) {
    if (v === '' || v === null || v === undefined) return null;
    const n = Number(v);
    if (!Number.isInteger(n) || n < 0 || n > 99) throw new Error('Scores must be whole numbers between 0 and 99.');
    return n;
  }

  /*
   * Build a finished match state from set scores typed in by the admin.
   * sets = [{ a, b, tbLoser? }]  - tbLoser: optional tie-breaker points of the set loser.
   * Throws a readable Error if any set is impossible for the format or the match isn't finished.
   */
  function stateFromSets(format, sets) {
    const f = normalizeFormat(format);
    const rows = (Array.isArray(sets) ? sets : []).filter((r) => r && !(toScore(r.a) === null && toScore(r.b) === null));
    if (!rows.length) throw new Error('Enter the score of at least one set.');
    const st = newState();
    const tbAt = tiebreakAt(f);
    rows.forEach((raw, i) => {
      const label = st.mode === 'matchtb' ? 'Match tie-breaker' : `Set ${i + 1}`;
      if (st.winner) throw new Error(`${label}: the match was already decided.`);
      const a = toScore(raw.a);
      const b = toScore(raw.b);
      if (a === null || b === null) throw new Error(`${label}: enter both scores.`);
      if (a === b) throw new Error(`${label}: a set can't end level.`);
      const hi = Math.max(a, b);
      const lo = Math.min(a, b);
      const winner = a > b ? 'a' : 'b';
      if (st.mode === 'matchtb') {
        if (!(hi >= 10 && hi - lo >= 2 && (hi === 10 || hi - lo === 2))) {
          throw new Error('Match tie-breaker: first to 10, win by 2 (for example 10-7 or 12-10).');
        }
        closeSet(f, st, { a, b, mtb: true });
        return;
      }
      const lost = toScore(raw.tbLoser);
      let extra;
      if (hi === tbAt + 1 && lo === tbAt) {
        extra = { tb: null };
        if (lost !== null) {
          const won = Math.max(7, lost + 2);
          extra.tb = winner === 'a' ? { a: won, b: lost } : { a: lost, b: won };
        }
      } else {
        const ok = f.games === 4 ? hi === 4 && lo <= 2 : (hi === 6 && lo <= 4) || (hi === 7 && lo === 5);
        if (!ok) throw new Error(`${label}: ${a}-${b} is not a valid ${f.games === 4 ? 'Fast 4' : 'Regular 6'} set score.`);
        if (lost !== null) throw new Error(`${label}: tie-breaker points only apply to a ${tbAt + 1}-${tbAt} set.`);
      }
      st.games = { a, b };
      closeSet(f, st, extra);
    });
    if (!st.winner) {
      throw new Error(st.mode === 'matchtb' ? 'One set all: enter the match tie-breaker score.' : 'These sets do not finish the match. Add the deciding set.');
    }
    return st;
  }

  /*
   * Point-by-point statistics from the log. Serve-based figures need serve settings.
   * Returns { hasServe, a: {...}, b: {...} }.
   */
  function matchStats(format, log, serve) {
    const f = normalizeFormat(format);
    const blank = () => ({
      pointsWon: 0, servePoints: 0, servePointsWon: 0, returnPoints: 0, returnPointsWon: 0,
      serviceGames: 0, serviceGamesHeld: 0, breakPointsFaced: 0, breakPointsSaved: 0,
      breakPointChances: 0, breaks: 0, longestRun: 0,
    });
    const out = { hasServe: !!(serve && ['a', 'b'].includes(serve.first)), a: blank(), b: blank() };
    const st = newState();
    let run = { side: null, n: 0 };
    for (const side of log || []) {
      if (st.winner) break;
      const srvInfo = out.hasServe ? serverFor(f, st, serve, false) : null;
      const srv = srvInfo ? srvInfo.side : null;
      const inGame = st.mode === 'game';
      let breakPoint = false;
      if (srv && inGame) {
        const ret = other(srv);
        const p = st.points;
        breakPoint = f.scoring === 'ad' ? p[ret] + 1 >= 4 && p[ret] + 1 - p[srv] >= 2 : p[ret] + 1 >= 4;
      }
      const gamesBefore = st.games.a + st.games.b;
      const setsBefore = st.sets.length;
      applyPoint(f, st, side);
      const gameDone = inGame && (st.games.a + st.games.b !== gamesBefore || st.sets.length !== setsBefore);

      out[side].pointsWon++;
      run = run.side === side ? { side, n: run.n + 1 } : { side, n: 1 };
      out[side].longestRun = Math.max(out[side].longestRun, run.n);
      if (srv) {
        const ret = other(srv);
        out[srv].servePoints++;
        out[ret].returnPoints++;
        if (side === srv) out[srv].servePointsWon++;
        else out[ret].returnPointsWon++;
        if (breakPoint) {
          out[srv].breakPointsFaced++;
          out[ret].breakPointChances++;
          if (side === srv) out[srv].breakPointsSaved++;
        }
        if (gameDone) {
          out[srv].serviceGames++;
          if (side === srv) out[srv].serviceGamesHeld++;
          else out[ret].breaks++;
        }
      }
    }
    return out;
  }

  // What to show for the current game ("0/15/30/40/Ad" or raw tie-breaker points).
  function gameDisplay(f, st) {
    const p = st.points;
    if (st.mode !== 'game') return { a: String(p.a), b: String(p.b) };
    if (f.scoring === 'ad' && p.a >= 3 && p.b >= 3) {
      if (p.a === p.b) return { a: '40', b: '40' };
      return p.a > p.b ? { a: 'Ad', b: '40' } : { a: '40', b: 'Ad' };
    }
    const L = ['0', '15', '30', '40'];
    return { a: L[Math.min(p.a, 3)], b: L[Math.min(p.b, 3)] };
  }

  function phaseLabel(f, st) {
    if (st.winner) return 'Final';
    if (st.mode === 'matchtb') return 'Match tie-breaker (first to 10, win by 2)';
    if (st.mode === 'tiebreak') return 'Set tie-breaker (first to 7, win by 2)';
    if (f.scoring === 'noad' && st.points.a === 3 && st.points.b === 3) return 'Deuce, next point wins the game';
    if (f.scoring === 'ad' && st.points.a >= 3 && st.points.a === st.points.b) return 'Deuce';
    return 'In play';
  }

  function formatLabel(f) {
    return [
      f.games === 4 ? 'Fast 4' : 'Regular 6',
      f.scoring === 'ad' ? 'with Ad' : 'no Ad',
      f.setsMode === 'best3' ? 'best of 3 sets' : 'best of 2 sets + 10-point match tie-breaker',
    ].join(', ');
  }

  function scoreline(st) {
    if (!st || !st.sets) return '';
    return st.sets
      .map((s) => (s.mtb ? `[${s.a}-${s.b}]` : s.tb ? `${s.a}-${s.b}(${Math.min(s.tb.a, s.tb.b)})` : `${s.a}-${s.b}`))
      .join(' ');
  }

  return { DEFAULT_FORMAT, normalizeFormat, newState, computeState, gameDisplay, phaseLabel, formatLabel, scoreline, tiebreakAt, gamesPlayed, serverFor, serveOrder, tossOutcome, endChanges, changeEndsNow, nextEndChange, positions, tiebreakPoints, stateFromSets, matchStats };
});
