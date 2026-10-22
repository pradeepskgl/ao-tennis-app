// End-to-end API test. Start the server with test env vars and a throwaway database, then:
//   BASE=http://localhost:3055 ADMIN_USERNAME=... ADMIN_PASSWORD=... node test/api.test.js
const assert = require('assert');
const BASE = process.env.BASE || 'http://localhost:3055';
const U = process.env.ADMIN_USERNAME, P = process.env.ADMIN_PASSWORD;
const tokens = { admin: '', scorer: '' };
async function call(method, path, body, as = 'admin') {
  const tok = as ? tokens[as] : '';
  const res = await fetch(BASE + '/api' + path, { method, headers: { 'Content-Type': 'application/json', ...(tok ? { Authorization: 'Bearer ' + tok } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data, headers: res.headers };
}
const start = (id, as = 'admin') => call('POST', `/matches/${id}/start`, null, as); // 409 if already started: fine
const play = async (id, side, n, as = 'admin') => { await start(id, as); let r; for (let i = 0; i < n; i++) r = await call('POST', `/matches/${id}/point`, { side }, as); return r; };
const winGames = (id, side, g, as) => play(id, side, g * 4, as);
const matchesOf = async (tid) => (await call('GET', `/tournaments/${tid}/matches`, null, null)).data;
const result = (id, sets, as = 'admin') => call('POST', `/matches/${id}/result`, { sets }, as);
const win = (id, side) => result(id, side === 'a' ? [{ a: 6, b: 0 }, { a: 6, b: 0 }] : [{ a: 0, b: 6 }, { a: 0, b: 6 }]);

(async () => {
  assert.deepStrictEqual((await fetch(BASE + '/healthz').then((r) => r.json())), { ok: true, db: true });

  /* ---------- auth + scorers ---------- */
  assert.strictEqual((await call('POST', '/auth/login', { username: U, password: 'wrong' }, null)).status, 401);
  tokens.admin = (await call('POST', '/auth/login', { username: U, password: P }, null)).data.token;
  for (const [m, p] of [['POST', '/tournaments'], ['POST', '/scorers'], ['POST', '/matches/000000000000000000000000/point']]) {
    assert.strictEqual((await call(m, p, {}, null)).status, 401, `${m} ${p} needs sign-in`);
  }
  assert.strictEqual((await call('POST', '/scorers', { username: 'x', password: 'longenough' })).status, 400);
  assert.strictEqual((await call('POST', '/scorers', { username: 'court1', password: 'short' })).status, 400);
  assert.strictEqual((await call('POST', '/scorers', { username: U, password: 'longenough' })).status, 400);
  const sc = await call('POST', '/scorers', { username: 'Court1', password: 'court-one-pass' });
  assert.strictEqual(sc.status, 201); assert.strictEqual(sc.data.username, 'court1');
  assert.strictEqual((await call('POST', '/scorers', { username: 'court1', password: 'another-pass' })).status, 409);
  const login = await call('POST', '/auth/login', { username: 'court1', password: 'court-one-pass' }, null);
  assert.strictEqual(login.data.role, 'scorer'); tokens.scorer = login.data.token;
  assert.strictEqual((await call('GET', '/auth/me', null, 'scorer')).data.role, 'scorer');
  assert.strictEqual((await call('POST', '/tournaments', { name: 'X', type: 'singles' }, 'scorer')).status, 403);
  assert.strictEqual((await call('GET', '/scorers', null, 'scorer')).status, 403);

  /* ---------- doubles: seeding, stages, groups ---------- */
  let r = await call('POST', '/tournaments', { name: 'Test Doubles Open', type: 'doubles' });
  const tid = r.data.id;
  const teams = 'ABCDEFGH'.split('').map((c) => ({ player1: c + '1', player2: c + '2' }));
  r = await call('POST', `/tournaments/${tid}/entries`, { entries: teams });
  const ids = r.data.entries.map((e) => e._id);
  assert.strictEqual((await call('PUT', `/tournaments/${tid}/entries/order`, { ids: ids.slice(1) })).status, 400);
  assert.strictEqual((await call('PUT', `/tournaments/${tid}/entries/order`, { ids: [ids[0], ...ids.slice(0, 7)] })).status, 400);
  r = await call('PUT', `/tournaments/${tid}/entries/order`, { ids: [...ids].reverse() });
  assert.deepStrictEqual(r.data.entries.map((e) => e.name), [...teams].reverse().map((t) => `${t.player1} / ${t.player2}`));
  await call('PUT', `/tournaments/${tid}/entries/order`, { ids });

  r = await call('PUT', `/tournaments/${tid}/stages`, { stages: r.data.stages.map((s) => ({ ...s, enabled: s.key !== 'quarterfinal' })) });
  r = await call('POST', `/tournaments/${tid}/fixtures/generate`, { stageKey: 'group', groupsCount: 2 });
  assert.strictEqual(r.data.created, 12);

  // knockout built up front from group positions, before any group match is played
  r = await call('POST', `/tournaments/${tid}/fixtures/generate`, { stageKey: 'semifinal', source: 'previous', qualifiers: 2 });
  assert.strictEqual(r.data.created, 3); assert.deepStrictEqual(r.data.stages.sort(), ['final', 'semifinal']);
  let ms = await matchesOf(tid);
  let sf = ms.filter((m) => m.stageKey === 'semifinal'); let fin = ms.find((m) => m.stageKey === 'final');
  assert.deepStrictEqual(sf.map((m) => [m.sideALabel, m.sideBLabel]), [['Group A winner', 'Group B runner-up'], ['Group B winner', 'Group A runner-up']]);
  assert.deepStrictEqual([fin.sideALabel, fin.sideBLabel], ['Winner of Semifinals 1', 'Winner of Semifinals 2']);

  // finish Group A only: its slots fill, Group B's stay open
  const grp = ms.filter((m) => m.stageKey === 'group');
  for (const m of grp.filter((m) => m.group === 'Group A')) await win(m.id, 'a');
  ms = await matchesOf(tid); sf = ms.filter((m) => m.stageKey === 'semifinal');
  assert.ok(sf[0].sideA && !sf[0].sideB && sf[1].sideB && !sf[1].sideA, 'Group A slots filled only');
  for (const m of grp.filter((m) => m.group === 'Group B')) await win(m.id, 'a');
  const st = (await call('GET', `/tournaments/${tid}/standings`, null, null)).data;
  assert.ok(st.every((g) => g.rows.every((r) => r.points === r.won * 2)), 'points = 2 per win'); assert.strictEqual(st[0].rows[0].setPct, 100); assert.strictEqual(st[0].rows[0].gamePct, 100); // won every match 6-0 6-0 assert.strictEqual(st[0].rows[0].points, 6);
  assert.ok(st.every((g) => g.complete));
  ms = await matchesOf(tid); sf = ms.filter((m) => m.stageKey === 'semifinal');
  assert.strictEqual(sf[0].sideA.name, st[0].rows[0].name); assert.strictEqual(sf[0].sideB.name, st[1].rows[1].name);

  // semis -> final fills automatically; scorer scores with serve set
  assert.strictEqual((await call('POST', `/matches/${sf[0].id}/serve`, { first: 'b', aFirst: 2, bFirst: 1 }, 'scorer')).data.serve.first, 'b');
  await winGames(sf[0].id, 'a', 6, 'scorer'); r = await winGames(sf[0].id, 'a', 6, 'scorer');
  assert.strictEqual(r.data.status, 'completed');
  const stats = (await call('GET', `/matches/${sf[0].id}/stats`, null, null)).data;
  assert.ok(stats.available && stats.hasServe); assert.strictEqual(stats.a.serviceGames, 6); assert.strictEqual(stats.a.breaks, 6);
  assert.strictEqual((await call('POST', `/matches/${sf[0].id}/walkover`, { side: 'b' }, 'scorer')).status, 403);
  assert.strictEqual((await call('PUT', `/matches/${sf[0].id}`, { court: 'x' }, 'scorer')).status, 403);
  r = await result(sf[1].id, [{ a: 4, b: 6 }, { a: 6, b: 3 }, { a: 2, b: 6 }], 'scorer');
  assert.strictEqual(r.data.winnerSide, 'b');
  fin = (await matchesOf(tid)).find((m) => m.stageKey === 'final');
  assert.strictEqual(fin.sideA.id, sf[0].sideA.id); assert.strictEqual(fin.sideB.id, sf[1].sideB.id);

  // undoing a semi re-opens the final slot; once the final starts, the semi is locked
  r = await call('POST', `/matches/${sf[0].id}/undo`, null, 'scorer'); assert.strictEqual(r.data.status, 'live');
  fin = (await matchesOf(tid)).find((m) => m.stageKey === 'final'); assert.strictEqual(fin.sideA, null);
  await call('POST', `/matches/${sf[0].id}/point`, { side: 'a' }, 'scorer');
  await play(fin.id, 'a', 1);
  assert.strictEqual((await call('POST', `/matches/${sf[0].id}/reset`)).status, 409);
  assert.strictEqual((await call('POST', `/matches/${grp[0].id}/reset`)).status, 409, 'group result locked too');
  assert.strictEqual((await call('POST', `/tournaments/${tid}/fixtures/generate`, { stageKey: 'semifinal', source: 'previous' })).status, 409);
  await call('POST', `/matches/${fin.id}/reset`);
  assert.strictEqual((await call('POST', `/matches/${sf[0].id}/reset`)).status, 200);

  // hand-picking a player for a bracket slot replaces the link
  r = await call('PUT', `/matches/${fin.id}`, { sideA: ids[7] });
  assert.strictEqual(r.data.sideA.id, ids[7]); assert.strictEqual(r.data.sideALabel, null);

  /* ---------- singles: seeded bracket with byes, head-to-head ---------- */
  r = await call('POST', '/tournaments', { name: '=Singles Cup', type: 'singles' }); const sid = r.data.id;
  r = await call('POST', `/tournaments/${sid}/entries`, { entries: ['P1', 'P2', 'P3', 'P4', '=P5'].map((name) => ({ name })) });
  r = await call('POST', `/tournaments/${sid}/fixtures/generate`, { stageKey: 'quarterfinal', source: 'entries' });
  assert.strictEqual(r.data.created, 7);
  let sm = await matchesOf(sid);
  const qf = sm.filter((m) => m.stageKey === 'quarterfinal');
  assert.deepStrictEqual(qf.map((m) => [m.sideA.name, m.isBye ? 'Bye' : m.sideB.name]), [['P1', 'Bye'], ['P4', '=P5'], ['P2', 'Bye'], ['P3', 'Bye']]);
  const sfs = sm.filter((m) => m.stageKey === 'semifinal');
  assert.strictEqual(sfs[0].sideA.name, 'P1'); assert.strictEqual(sfs[0].sideBLabel, 'Winner of Quarterfinals 2');
  assert.deepStrictEqual([sfs[1].sideA.name, sfs[1].sideB.name], ['P2', 'P3']);

  // head-to-head: P1 and P2 both win 2; P2 has far better games but lost to P1
  const t2 = (await call('GET', `/tournaments/${sid}`)).data;
  const gid = (await call('PUT', `/tournaments/${sid}/stages`, { stages: [...t2.stages, { name: 'Round robin', kind: 'group', enabled: true }] })).data.stages.find((x) => x.name === 'Round robin').key;
  await call('POST', `/tournaments/${sid}/fixtures/generate`, { stageKey: gid, groupsCount: 1 });
  sm = (await matchesOf(sid)).filter((m) => m.stageKey === gid);
  assert.strictEqual(sm.length, 10);
  const pairs = [['P1', 'P2', [6, 4, 6, 4]], ['P1', 'P3', [6, 4, 6, 4]], ['P4', 'P1', [6, 0, 6, 0]], ['P2', 'P3', [6, 0, 6, 0]], ['P2', 'P4', [6, 0, 6, 0]], ['P3', 'P4', [6, 4, 6, 4]]];
  const find = (x, y) => sm.find((m) => (m.sideA.name === x && m.sideB.name === y) || (m.sideA.name === y && m.sideB.name === x));
  for (const [x, y, sc2] of pairs) {
    const m = find(x, y);
    const sets = m.sideA.name === x ? [{ a: sc2[0], b: sc2[1] }, { a: sc2[2], b: sc2[3] }] : [{ a: sc2[1], b: sc2[0] }, { a: sc2[3], b: sc2[2] }];
    assert.strictEqual((await result(m.id, sets)).status, 200);
  }
  const rr = (await call('GET', `/tournaments/${sid}/standings`, null, null)).data.find((g) => g.stageKey === gid);
  assert.deepStrictEqual(rr.rows.map((x) => x.name), ['P1', 'P2', 'P3', 'P4', '=P5'], 'P1 above P2 and P3 above P4 on head-to-head');
  assert.ok(rr.rows.find((x) => x.name === 'P2').gamesFor - rr.rows.find((x) => x.name === 'P2').gamesAgainst > rr.rows.find((x) => x.name === 'P1').gamesFor - rr.rows.find((x) => x.name === 'P1').gamesAgainst);
  assert.ok(rr.rows.find((x) => x.name === 'P1').h2h);

  /* ---------- exports ---------- */
  r = await call('GET', `/tournaments/${sid}/results.csv`, null, null);
  assert.strictEqual(r.status, 200); assert.ok(r.headers.get('content-disposition').includes('singles-cup-results.csv'));
  assert.ok(r.data.startsWith('Stage,Match,Group'));
  const raw = new Uint8Array(await (await fetch(`${BASE}/api/tournaments/${sid}/results.csv`)).arrayBuffer());
  assert.deepStrictEqual([...raw.slice(0, 3)], [0xef, 0xbb, 0xbf], 'UTF-8 BOM for Excel'); assert.ok(r.data.includes("'=P5") && !/,=P5/.test(r.data), 'formula cells neutralised');
  assert.ok(r.data.includes('6-4 6-4'));
  r = await call('GET', `/tournaments/${sid}/standings.csv`, null, null); assert.ok(r.data.includes('Games won') && r.data.includes('Lost,Points,Sets won,Sets lost,Set %,Games won,Games lost,Game %'));
  assert.strictEqual((await call('GET', `/tournaments/${sid}/backup.json`, null, null)).status, 401);
  r = await call('GET', `/tournaments/${sid}/backup.json`);
  assert.ok(r.data.tournament && Array.isArray(r.data.matches) && r.data.matches[0].log);

  /* ---------- live updates ---------- */
  const ctrl = new AbortController();
  const es = await fetch(`${BASE}/api/tournaments/${sid}/events`, { signal: ctrl.signal });
  assert.ok(es.headers.get('content-type').startsWith('text/event-stream'));
  const reader = es.body.getReader(); let got = '';
  const waitFor = (async () => { while (!got.includes('event: change')) { const { value } = await reader.read(); got += new TextDecoder().decode(value); } })();
  await call('PUT', `/tournaments/${sid}`, { status: 'live' });
  await Promise.race([waitFor, new Promise((_, rej) => setTimeout(() => rej(new Error('no SSE event')), 3000))]);
  ctrl.abort();

  /* ---------- admin promotes from group standings ---------- */
  {
    const pt = (await call('POST', '/tournaments', { name: 'Promo Cup', type: 'singles' })).data;
    const ents = (await call('POST', `/tournaments/${pt.id}/entries`, { entries: ['A', 'B', 'C', 'D', 'E', 'F'].map((name) => ({ name })) })).data.entries;
    const idOf = (n) => ents.find((e) => e.name === n)._id;
    await call('PUT', `/tournaments/${pt.id}/stages`, { stages: pt.stages.map((s) => ({ ...s, enabled: ['group', 'semifinal', 'final'].includes(s.key) })) });
    await call('POST', `/tournaments/${pt.id}/fixtures/generate`, { stageKey: 'group', groupsCount: 2 });
    await call('POST', `/tournaments/${pt.id}/fixtures/generate`, { stageKey: 'semifinal', source: 'previous', qualifiers: 2 });
    let st = (await call('GET', `/tournaments/${pt.id}/standings`, null, null)).data;
    const ga = st.find((g) => g.group === 'Group A');
    assert.deepStrictEqual(ga.feeds.map((f) => [f.rank, f.match]), [[1, 'Semifinals 1'], [2, 'Semifinals 2']]);
    const inA = ga.rows.map((r) => r.name);
    const promo = (rank, name, as = 'admin') => call('PUT', `/tournaments/${pt.id}/promotions`, { stageKey: 'group', group: 'Group A', rank, entryId: name ? idOf(name) : null }, as);
    assert.strictEqual((await promo(1, inA[2], null)).status, 401);
    assert.strictEqual((await promo(1, inA[2], 'scorer')).status, 403);
    assert.strictEqual((await promo(1, ga.rows.length ? ['A', 'B', 'C', 'D', 'E', 'F'].find((n) => !inA.includes(n)) : 'A')).status, 400, 'not in this group');
    assert.strictEqual((await promo(9, inA[0])).status, 400, 'no such position');
    // promote the last-placed player as group winner before any match is played: semifinal 1 fills now
    r = await promo(1, inA[2]);
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.data.find((g) => g.group === 'Group A').promoted['1'], idOf(inA[2]));
    let sf = (await matchesOf(pt.id)).filter((m) => m.stageKey === 'semifinal');
    assert.strictEqual(sf[0].sideA.name, inA[2]); assert.strictEqual(sf[1].sideB, null, 'runner-up waits for the group');
    // finish Group A: inA[0] wins everything; runner-up = best of the rest, skipping the promoted player
    const gm = (await matchesOf(pt.id)).filter((m) => m.group === 'Group A');
    for (const m of gm) await win(m.id, [m.sideA.name, m.sideB.name].includes(inA[0]) ? (m.sideA.name === inA[0] ? 'a' : 'b') : 'a');
    st = (await call('GET', `/tournaments/${pt.id}/standings`, null, null)).data;
    const placed = st.find((g) => g.group === 'Group A');
    assert.strictEqual(placed.rows[0].name, inA[0]);
    sf = (await matchesOf(pt.id)).filter((m) => m.stageKey === 'semifinal');
    assert.strictEqual(sf[0].sideA.name, inA[2], 'promoted winner kept');
    assert.strictEqual(sf[1].sideB.name, inA[0], 'standings leader takes the open runner-up place');
    // several positions confirmed at once; the same entry twice is refused
    assert.strictEqual((await call('PUT', `/tournaments/${pt.id}/promotions`, { stageKey: 'group', group: 'Group A', picks: { 1: idOf(inA[1]), 2: idOf(inA[1]) } })).status, 400);
    r = await call('PUT', `/tournaments/${pt.id}/promotions`, { stageKey: 'group', group: 'Group A', picks: { 1: idOf(inA[2]), 2: idOf(inA[1]) } });
    assert.deepStrictEqual(r.data.find((g) => g.group === 'Group A').promoted, { 1: idOf(inA[2]), 2: idOf(inA[1]) });
    sf = (await matchesOf(pt.id)).filter((m) => m.stageKey === 'semifinal');
    assert.strictEqual(sf[1].sideB.name, inA[1]);
    await call('PUT', `/tournaments/${pt.id}/promotions`, { stageKey: 'group', group: 'Group A', picks: { 2: null } });
    // undo: back to the standings order
    await promo(1, null);
    sf = (await matchesOf(pt.id)).filter((m) => m.stageKey === 'semifinal');
    assert.strictEqual(sf[0].sideA.name, inA[0]); assert.strictEqual(sf[1].sideB.name, placed.rows.filter((x) => x.name !== inA[0])[0].name);
    // locked once a semifinal fed by the group has started
    for (const m of (await matchesOf(pt.id)).filter((m) => m.group === 'Group B')) await win(m.id, 'a');
    await play(sf[0].id, 'a', 1);
    assert.strictEqual((await promo(1, inA[2])).status, 409);
    assert.strictEqual((await call('DELETE', `/tournaments/${pt.id}`)).status, 200);
  }

  /* ---------- coin toss + doubles serving order ---------- */
  r = await call('POST', '/tournaments', { name: 'Toss Doubles', type: 'doubles' });
  const did = r.data.id;
  r = await call('POST', `/tournaments/${did}/entries`, { entries: ['P', 'Q', 'R'].map((c) => ({ player1: c + '1', player2: c + '2' })) });
  const [p, q, third] = r.data.entries.map((e) => e._id);
  let tm = (await call('POST', `/tournaments/${did}/matches`, { stageKey: 'final', sideA: p, sideB: q })).data;
  assert.strictEqual(tm.toss, null);
  assert.strictEqual((await call('POST', `/matches/${tm.id}/toss`, { winner: 'a', choice: 'defer', decision: 'serve' }, 'scorer')).status, 400);
  assert.strictEqual((await call('POST', `/matches/${tm.id}/toss`, { winner: 'a', choice: 'serve', decision: 'serve' }, null)).status, 401);
  // A wins, defers; B picks the end; A then chooses to receive, so B serves first
  r = await call('POST', `/matches/${tm.id}/toss`, { winner: 'a', choice: 'defer', deferredChoice: 'end', decision: 'receive', end: 'North end', aFirst: 2, bFirst: 1 }, 'scorer');
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual([r.data.toss.winner, r.data.toss.deferredChoice, r.data.toss.end], ['a', 'end', 'North end']);
  assert.deepStrictEqual([r.data.serve.first, r.data.serve.aFirst, r.data.serve.bFirst], ['b', 2, 1]);
  // serving order for set 2 is kept with the serve settings
  r = await call('POST', `/matches/${tm.id}/serve`, { ...r.data.serve, sets: [{ set: 2, aFirst: 1, bFirst: 2, bDeuce: 2 }] }, 'scorer');
  assert.deepStrictEqual(r.data.serve.sets, [{ set: 2, aFirst: 1, bFirst: 2, aDeuce: null, bDeuce: 2 }]);
  assert.strictEqual((await call('POST', `/matches/${tm.id}/serve`, { first: 'a', sets: [{ set: 1 }] }, 'scorer')).status, 400);
  // points need "Start match"; the toss locks once the match starts, and is cleared when the players change
  assert.strictEqual((await call('POST', `/matches/${tm.id}/point`, { side: 'a' }, 'scorer')).status, 409, 'start first');
  r = await start(tm.id, 'scorer');
  assert.strictEqual(r.status, 200); assert.strictEqual(r.data.status, 'live'); assert.ok(r.data.startedAt && !r.data.endedAt);
  assert.strictEqual((await start(tm.id, 'scorer')).status, 409, 'already started');
  assert.strictEqual((await call('PUT', `/matches/${tm.id}`, { sideB: third })).status, 409, 'players locked once started');
  assert.strictEqual((await call('POST', `/matches/${tm.id}/point`, { side: 'a' }, 'scorer')).status, 200);
  assert.strictEqual((await call('POST', `/matches/${tm.id}/toss`, { winner: 'b', choice: 'serve', decision: 'serve' }, 'scorer')).status, 409);
  r = await call('POST', `/matches/${tm.id}/reset`, undefined, 'scorer');
  assert.strictEqual(r.data.startedAt, null); assert.strictEqual(r.data.status, 'scheduled');
  // match time: from start to the last point
  r = await play(tm.id, 'a', 48, 'scorer');
  assert.strictEqual(r.data.status, 'completed'); assert.ok(new Date(r.data.endedAt) >= new Date(r.data.startedAt));
  const csv = (await call('GET', `/tournaments/${did}/results.csv`, null, null)).data;
  assert.ok(/,0:00:\d\d,/.test(csv), 'match time in the results CSV');
  r = await call('POST', `/matches/${tm.id}/undo`, undefined, 'scorer');
  assert.strictEqual(r.data.endedAt, null, 'undoing the last point resumes the clock');
  await call('POST', `/matches/${tm.id}/reset`, undefined, 'scorer');
  tm = (await call('PUT', `/matches/${tm.id}`, { sideB: third })).data;
  assert.strictEqual(tm.toss, null);
  assert.strictEqual((await call('DELETE', `/tournaments/${did}`)).status, 200);

  /* ---------- scorer removal revokes access ---------- */
  await call('DELETE', `/scorers/${sc.data.id}`);
  assert.strictEqual((await call('GET', '/auth/me', null, 'scorer')).status, 401);

  assert.strictEqual((await call('DELETE', `/tournaments/${tid}`)).status, 200);
  assert.strictEqual((await call('DELETE', `/tournaments/${sid}`)).status, 200);
  console.log('api tests passed');
})().catch((e) => { console.error(e); process.exit(1); });
