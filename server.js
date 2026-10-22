require('dotenv').config();
// Optional, e.g. DNS_SERVERS=8.8.8.8,1.1.1.1 when the local resolver can't answer the
// SRV lookup behind a mongodb+srv:// URI ("querySrv ECONNREFUSED").
if (process.env.DNS_SERVERS) require('dns').setServers(process.env.DNS_SERVERS.split(',').map((s) => s.trim()).filter(Boolean));
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const Scoring = require('./lib/scoring');
const { Tournament, Match, Scorer } = require('./models');

const { MONGODB_URI, JWT_SECRET, ADMIN_USERNAME, ADMIN_PASSWORD } = process.env;
const PORT = process.env.PORT || 3000;
for (const [k, v] of Object.entries({ MONGODB_URI, JWT_SECRET, ADMIN_USERNAME, ADMIN_PASSWORD })) {
  if (!v) {
    console.error(`Missing environment variable ${k}. See .env.example`);
    process.exit(1);
  }
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const clean = (v) => String(v == null ? '' : v).trim().replace(/\s+/g, ' ');
const same = (x, y) => x != null && y != null && String(x) === String(y);
const fmtOf = (m) => (m.format && m.format.toObject ? m.format.toObject() : m.format);

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(express.json({ limit: '100kb' }));
app.use((req, res, next) => {
  res.set({ 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'same-origin' });
  next();
});

// The mobile app serves its pages from a localhost origin and calls this API cross-origin.
// Auth is a Bearer token (no cookies), so credentials are never allowed.
const CORS_ORIGINS = new Set([
  'https://localhost', // Capacitor Android
  'capacitor://localhost', // Capacitor iOS
  'http://localhost',
  ...String(process.env.CORS_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean),
]);
app.use('/api', (req, res, next) => {
  res.vary('Origin');
  if (!CORS_ORIGINS.has(req.headers.origin)) return next();
  res.set({
    'Access-Control-Allow-Origin': req.headers.origin,
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE',
    'Access-Control-Max-Age': '86400',
  });
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
});

/* ------------------------- live updates (SSE) ------------------------- */

const streams = new Map(); // tournamentId -> Set(res)
let streamCount = 0;

function notify(tid, data) {
  const set = streams.get(String(tid));
  if (!set) return;
  const msg = `event: change\ndata: ${JSON.stringify(data || {})}\n\n`;
  set.forEach((r) => r.write(msg));
}

// Any successful write that names a tournament (res.locals.tid) tells its viewers to refresh.
app.use('/api', (req, res, next) => {
  if (req.method !== 'GET') {
    res.on('finish', () => {
      if (res.statusCode < 400 && res.locals.tid) notify(res.locals.tid, res.locals.event);
    });
  }
  next();
});

app.get('/api/tournaments/:id/events', (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).end();
  if (streamCount >= 2000) return res.status(503).end();
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.flushHeaders();
  res.write('retry: 5000\n\n');
  const key = req.params.id;
  if (!streams.has(key)) streams.set(key, new Set());
  streams.get(key).add(res);
  streamCount++;
  req.on('close', () => {
    const set = streams.get(key);
    if (set && set.delete(res)) streamCount--;
    if (set && !set.size) streams.delete(key);
  });
});
setInterval(() => streams.forEach((set) => set.forEach((r) => r.write(': ping\n\n'))), 25000).unref();

app.get('/healthz', (req, res) => res.json({ ok: true, db: mongoose.connection.readyState === 1 }));

/* ------------------------------ auth ------------------------------ */

const digest = (v) => crypto.createHash('sha256').update(String(v)).digest();
const safeEqual = (a, b) => crypto.timingSafeEqual(digest(a), digest(b));
const scrypt = (pw, salt) =>
  new Promise((resolve, reject) => crypto.scrypt(String(pw), salt, 64, (e, k) => (e ? reject(e) : resolve(k.toString('hex')))));
const failedLogins = new Map();

app.post('/api/auth/login', ah(async (req, res) => {
  const now = Date.now();
  const recent = (failedLogins.get(req.ip) || []).filter((t) => now - t < 15 * 60 * 1000);
  if (recent.length >= 10) return res.status(429).json({ error: 'Too many failed attempts. Try again in 15 minutes.' });
  const username = String((req.body || {}).username || '');
  const password = String((req.body || {}).password || '');

  const adminUser = safeEqual(username, ADMIN_USERNAME);
  const adminPass = safeEqual(password, ADMIN_PASSWORD);
  if (adminUser && adminPass) {
    failedLogins.delete(req.ip);
    return res.json({ token: jwt.sign({ role: 'admin' }, JWT_SECRET, { expiresIn: '12h' }), role: 'admin', name: ADMIN_USERNAME });
  }
  const scorer = !adminUser && username ? await Scorer.findOne({ username: username.trim().toLowerCase() }) : null;
  const hash = await scrypt(password, scorer ? scorer.salt : 'no-such-user');
  if (scorer && safeEqual(hash, scorer.hash)) {
    failedLogins.delete(req.ip);
    const token = jwt.sign({ role: 'scorer', sub: String(scorer._id) }, JWT_SECRET, { expiresIn: '12h' });
    return res.json({ token, role: 'scorer', name: scorer.username });
  }
  recent.push(now);
  failedLogins.set(req.ip, recent);
  res.status(401).json({ error: 'Incorrect username or password.' });
}));

async function whoIs(req) {
  const header = req.get('Authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token) return null;
  let payload;
  try {
    payload = jwt.verify(token, JWT_SECRET);
  } catch {
    return null;
  }
  if (payload.role === 'admin') return { role: 'admin', name: ADMIN_USERNAME };
  if (payload.role === 'scorer' && mongoose.isValidObjectId(payload.sub)) {
    const s = await Scorer.findById(payload.sub); // removed scorers lose access immediately
    return s ? { role: 'scorer', name: s.username } : null;
  }
  return null;
}

// 401 = not signed in (client signs out); 403 = signed in but not allowed.
const requireRole = (...roles) =>
  ah(async (req, res, next) => {
    const who = await whoIs(req);
    if (!who) return res.status(401).json({ error: 'Please sign in.' });
    if (!roles.includes(who.role)) return res.status(403).json({ error: 'Only the admin can do this.' });
    req.who = who;
    next();
  });
const admin = requireRole('admin');
const scorer = requireRole('admin', 'scorer');

app.get('/api/auth/me', scorer, (req, res) => res.json(req.who));

/* ------------------------- scorer accounts ------------------------- */

app.get('/api/scorers', admin, ah(async (req, res) => {
  const list = await Scorer.find().sort({ username: 1 });
  res.json(list.map((s) => ({ id: String(s._id), username: s.username, createdAt: s.createdAt })));
}));

app.post('/api/scorers', admin, ah(async (req, res) => {
  const username = clean(req.body.username).toLowerCase();
  const password = String(req.body.password || '');
  if (!/^[a-z0-9._-]{3,30}$/.test(username)) throw new HttpError(400, 'Usernames need 3 to 30 letters, numbers, dots, dashes or underscores.');
  if (safeEqual(username, String(ADMIN_USERNAME).toLowerCase())) throw new HttpError(400, 'That username is taken by the admin.');
  if (password.length < 8) throw new HttpError(400, 'Passwords need at least 8 characters.');
  if (await Scorer.exists({ username })) throw new HttpError(409, 'A scorer with that username already exists.');
  const salt = crypto.randomBytes(16).toString('hex');
  const s = await Scorer.create({ username, salt, hash: await scrypt(password, salt) });
  res.status(201).json({ id: String(s._id), username: s.username });
}));

app.delete('/api/scorers/:id', admin, ah(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) throw new HttpError(404, 'Scorer not found');
  const r = await Scorer.deleteOne({ _id: req.params.id });
  if (!r.deletedCount) throw new HttpError(404, 'Scorer not found');
  res.json({ ok: true });
}));

/* ----------------------------- helpers ---------------------------- */

const DEFAULT_STAGES = () => [
  { key: 'group', name: 'Group Stage', kind: 'group', enabled: true, order: 0 },
  { key: 'quarterfinal', name: 'Quarterfinals', kind: 'knockout', enabled: true, order: 1 },
  { key: 'semifinal', name: 'Semifinals', kind: 'knockout', enabled: true, order: 2 },
  { key: 'final', name: 'Finals', kind: 'knockout', enabled: true, order: 3 },
];

function parseFormat(f) {
  try {
    return Scoring.normalizeFormat(f);
  } catch (e) {
    throw new HttpError(400, e.message);
  }
}

async function getTournament(id, res) {
  if (!mongoose.isValidObjectId(id)) throw new HttpError(404, 'Tournament not found');
  const t = await Tournament.findById(id);
  if (!t) throw new HttpError(404, 'Tournament not found');
  if (res) res.locals.tid = t._id;
  return t;
}

async function getMatch(id, res) {
  if (!mongoose.isValidObjectId(id)) throw new HttpError(404, 'Match not found');
  const m = await Match.findById(id);
  if (!m) throw new HttpError(404, 'Match not found');
  if (res) {
    res.locals.tid = m.tournament;
    res.locals.event = { match: String(m._id) };
  }
  return m;
}

const sortMatches = (list) => [...list].sort((x, y) => x.order - y.order);

// Match numbers within each stage ("QF 2") for labels like "Winner of Quarterfinals 2".
function matchContext(t, matches) {
  const num = new Map();
  const counters = {};
  sortMatches(matches).forEach((m) => {
    counters[m.stageKey] = (counters[m.stageKey] || 0) + 1;
    num.set(String(m._id), { n: counters[m.stageKey], stageKey: m.stageKey });
  });
  return { num, stageName: (key) => (t.stages.find((s) => s.key === key) || { name: 'Earlier round' }).name };
}

const ordinal = (n) => (n === 1 ? 'winner' : n === 2 ? 'runner-up' : `${n}${n === 3 ? 'rd' : 'th'} place`);

function sourceLabel(src, ctx) {
  if (!src) return null;
  if (src.kind === 'group') return `${src.group} ${ordinal(src.rank)}`;
  const info = ctx.num.get(String(src.match));
  return info ? `Winner of ${ctx.stageName(info.stageKey)} ${info.n}` : 'Winner of earlier match';
}

// Plain copy of a match's serve settings.
function pickServe(sv) {
  const order = (o) => ({ aFirst: o.aFirst, bFirst: o.bFirst, aDeuce: o.aDeuce == null ? null : o.aDeuce, bDeuce: o.bDeuce == null ? null : o.bDeuce });
  return { first: sv.first || null, ...order(sv), sets: (sv.sets || []).map((o) => ({ set: o.set, ...order(o) })) };
}

function shapeMatch(m, t, ctx) {
  const side = (id) => {
    if (!id) return null;
    const e = t.entries.id(id);
    return { id: String(id), name: e ? e.name : 'Unknown', player1: e ? e.player1 : undefined, player2: e ? e.player2 : undefined };
  };
  const info = ctx.num.get(String(m._id));
  return {
    id: String(m._id),
    tournament: String(m.tournament),
    stageKey: m.stageKey,
    number: info ? info.n : null,
    group: m.group,
    round: m.round,
    order: m.order,
    sideA: side(m.sideA),
    sideB: side(m.sideB),
    sideALabel: m.sideA ? null : sourceLabel(m.sourceA, ctx),
    sideBLabel: m.sideB ? null : m.isBye ? 'Bye' : sourceLabel(m.sourceB, ctx),
    format: m.format,
    state: m.state,
    status: m.status,
    winnerSide: m.winnerSide,
    walkover: m.walkover,
    manual: m.manual,
    serve: m.serve ? pickServe(m.serve) : null,
    toss: m.toss && m.toss.winner
      ? { winner: m.toss.winner, choice: m.toss.choice, deferredChoice: m.toss.deferredChoice, decision: m.toss.decision, end: m.toss.end, recordedAt: m.toss.recordedAt }
      : null,
    isBye: m.isBye,
    scheduledAt: m.scheduledAt,
    court: m.court,
    notes: m.notes,
    pointsPlayed: m.log.length,
    startedAt: m.startedAt || null,
    endedAt: m.endedAt || null,
  };
}

async function sendMatch(res, m, status = 200) {
  const t = await Tournament.findById(m.tournament);
  const all = await Match.find({ tournament: m.tournament });
  const fresh = all.find((x) => same(x._id, m._id)) || m;
  res.status(status).json(shapeMatch(fresh, t, matchContext(t, all)));
}

function buildEntry(type, raw) {
  const r = raw || {};
  if (type === 'singles') {
    const name = clean(r.name);
    if (!name) throw new HttpError(400, 'Player name is required.');
    return { name };
  }
  const p1 = clean(r.player1);
  const p2 = clean(r.player2);
  if (!p1 || !p2) throw new HttpError(400, 'Both players are required for a doubles team.');
  const team = clean(r.name);
  return { name: team || `${p1} / ${p2}`, player1: p1, player2: p2 };
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function roundRobin(ids) {
  const a = [...ids];
  if (a.length % 2) a.push(null);
  const n = a.length;
  const out = [];
  for (let r = 0; r < n - 1; r++) {
    for (let i = 0; i < n / 2; i++) {
      const x = a[i];
      const y = a[n - 1 - i];
      if (x && y) out.push({ a: x, b: y, round: r + 1 });
    }
    a.splice(1, 0, a.pop());
  }
  return out;
}

// Standard bracket positions: seed 1 and 2 can only meet in the final, top seeds get the byes.
function seedOrder(size) {
  let o = [1];
  while (o.length < size) {
    const n = o.length * 2;
    o = o.flatMap((x) => [x, n + 1 - x]);
  }
  return o;
}

/* ---------------------------- standings ---------------------------- */

const POINTS_PER_WIN = 2;

// Who takes each finishing position of a group (index = rank - 1): positions the admin promoted
// someone into first, then, once every group match is finished, everyone else in standings order.
function groupPlacings(t, table) {
  const out = [];
  (t.promotions || []).filter((p) => p.stageKey === table.stageKey && p.group === table.group).forEach((p) => { out[p.rank - 1] = String(p.entry); });
  if (table.complete) {
    const rest = table.rows.map((r) => r.entryId).filter((id) => !out.includes(id));
    for (let i = 0; i < table.rows.length; i++) if (!out[i]) out[i] = rest.shift();
  }
  return out;
}

const fedByGroup = (m, stageKey, group) => [m.sourceA, m.sourceB].filter((s) => s && s.kind === 'group' && s.stageKey === stageKey && s.group === group);

function computeStandings(t, matches) {
  const out = [];
  const ctx = matchContext(t, matches);
  for (const stage of t.stages.filter((s) => s.kind === 'group')) {
    for (const g of t.groups.filter((x) => x.stageKey === stage.key)) {
      const rows = new Map(
        g.entryIds.map((id) => {
          const e = t.entries.id(id);
          return [
            String(id),
            { entryId: String(id), name: e ? e.name : 'Unknown', played: 0, won: 0, lost: 0, setsFor: 0, setsAgainst: 0, gamesFor: 0, gamesAgainst: 0, h2h: false },
          ];
        })
      );
      const gm = matches.filter((m) => m.stageKey === stage.key && m.group === g.name);
      gm.filter((m) => m.status === 'completed' && !m.isBye).forEach((m) => {
        const A = rows.get(String(m.sideA));
        const B = rows.get(String(m.sideB));
        if (!A || !B) return;
        A.played++;
        B.played++;
        if (m.winnerSide === 'a') {
          A.won++;
          B.lost++;
        } else {
          B.won++;
          A.lost++;
        }
        if (m.walkover || !m.state) return;
        m.state.sets.forEach((s) => {
          if (s.a > s.b) {
            A.setsFor++;
            B.setsAgainst++;
          } else {
            B.setsFor++;
            A.setsAgainst++;
          }
          if (!s.mtb) {
            A.gamesFor += s.a;
            A.gamesAgainst += s.b;
            B.gamesFor += s.b;
            B.gamesAgainst += s.a;
          }
        });
      });
      const byDiff = (x, y) =>
        y.setsFor - y.setsAgainst - (x.setsFor - x.setsAgainst) ||
        y.gamesFor - y.gamesAgainst - (x.gamesFor - x.gamesAgainst) ||
        x.name.localeCompare(y.name);
      // Head-to-head decides a tie between exactly two players on wins.
      const headToHead = (x, y) => {
        const m = gm.find(
          (k) => k.status === 'completed' && ((same(k.sideA, x.entryId) && same(k.sideB, y.entryId)) || (same(k.sideA, y.entryId) && same(k.sideB, x.entryId)))
        );
        if (!m) return 0;
        const w = m.winnerSide === 'a' ? m.sideA : m.sideB;
        x.h2h = y.h2h = true;
        return same(w, x.entryId) ? -1 : 1;
      };
      // Share of sets and games won, as a percentage with one decimal (null before any are played).
      const pct = (w, l) => (w + l ? Math.round((1000 * w) / (w + l)) / 10 : null);
      rows.forEach((r) => {
        r.points = r.won * POINTS_PER_WIN;
        r.setPct = pct(r.setsFor, r.setsAgainst);
        r.gamePct = pct(r.gamesFor, r.gamesAgainst);
      });
      const all = [...rows.values()].sort((x, y) => y.won - x.won);
      const sorted = [];
      for (let i = 0; i < all.length; ) {
        let j = i;
        while (j < all.length && all[j].won === all[i].won) j++;
        const tie = all.slice(i, j);
        if (tie.length === 2) tie.sort((x, y) => headToHead(x, y) || byDiff(x, y));
        else tie.sort(byDiff);
        sorted.push(...tie);
        i = j;
      }
      sorted.forEach((r, i) => (r.rank = i + 1));
      const done = gm.length > 0 && gm.every((m) => m.status === 'completed');
      const table = { stageKey: stage.key, stageName: stage.name, group: g.name, complete: done, rows: sorted };
      table.placings = groupPlacings(t, table);
      table.promoted = {};
      (t.promotions || []).filter((p) => p.stageKey === stage.key && p.group === g.name).forEach((p) => { table.promoted[p.rank] = String(p.entry); });
      // Knockout slots this group feeds, e.g. { rank: 1, match: 'Semifinals 1' }
      table.feeds = matches
        .flatMap((m) => fedByGroup(m, stage.key, g.name).map((s) => {
          const info = ctx.num.get(String(m._id));
          return { rank: s.rank, match: info ? `${ctx.stageName(info.stageKey)} ${info.n}` : 'Next stage' };
        }))
        .sort((x, y) => x.rank - y.rank);
      out.push(table);
    }
  }
  return out;
}

/* ------------------------ bracket advancement ------------------------ */

const isStarted = (m) => !!m.startedAt || m.log.length > 0 || m.manual || (m.walkover && !m.isBye);

function dependentsOf(m, matches) {
  return matches.filter((x) =>
    [x.sourceA, x.sourceB].some(
      (s) => s && ((s.kind === 'winner' && same(s.match, m._id)) || (s.kind === 'group' && m.group && s.stageKey === m.stageKey && s.group === m.group))
    )
  );
}

function downstreamStarted(m, matches, seen = new Set()) {
  if (seen.has(String(m._id))) return false;
  seen.add(String(m._id));
  return dependentsOf(m, matches).some((d) => isStarted(d) || (d.isBye && downstreamStarted(d, matches, seen)));
}

// Changing a finished result is blocked once a later match fed by it has started.
async function guardResultChange(m) {
  if (m.status !== 'completed' && !m.group) return;
  const all = await Match.find({ tournament: m.tournament });
  if (downstreamStarted(m, all)) {
    throw new HttpError(409, 'A later match that depends on this result has already started. Reset that match first.');
  }
}

// Fill knockout slots from finished matches and completed groups.
async function propagate(tournamentId) {
  const t = await Tournament.findById(tournamentId);
  if (!t) return;
  for (let pass = 0; pass < 12; pass++) {
    const matches = await Match.find({ tournament: t._id });
    const standings = computeStandings(t, matches);
    const resolve = (src) => {
      if (!src) return null;
      if (src.kind === 'winner') {
        const u = matches.find((x) => same(x._id, src.match));
        if (!u || u.status !== 'completed' || !u.winnerSide) return null;
        return u.winnerSide === 'a' ? u.sideA : u.sideB;
      }
      const table = standings.find((s) => s.stageKey === src.stageKey && s.group === src.group);
      const id = table && table.placings[src.rank - 1];
      return id ? new mongoose.Types.ObjectId(id) : null;
    };
    let changed = false;
    for (const m of matches) {
      if ((!m.sourceA && !m.sourceB) || isStarted(m)) continue;
      const a = m.sourceA ? resolve(m.sourceA) : m.sideA;
      const b = m.sourceB ? resolve(m.sourceB) : m.sideB;
      let dirty = false;
      if (String(m.sideA || '') !== String(a || '')) {
        m.sideA = a;
        dirty = true;
      }
      if (!m.isBye && String(m.sideB || '') !== String(b || '')) {
        m.sideB = b;
        dirty = true;
      }
      if (dirty && m.toss) m.toss = null; // the toss was between the old sides
      if (m.isBye) {
        const status = m.sideA ? 'completed' : 'scheduled';
        if (m.status !== status) {
          m.status = status;
          m.winnerSide = m.sideA ? 'a' : null;
          m.state = { ...Scoring.newState(), winner: m.winnerSide };
          m.markModified('state');
          dirty = true;
        }
      }
      if (dirty) {
        await m.save();
        changed = true;
      }
    }
    if (!changed) break;
  }
}

/* ------------------------- tournaments (read) --------------------- */

app.get('/api/tournaments', ah(async (req, res) => {
  const list = await Tournament.find().sort({ createdAt: -1 }).lean();
  res.json(list.map((t) => ({ id: String(t._id), name: t.name, type: t.type, status: t.status, entryCount: t.entries.length, createdAt: t.createdAt })));
}));

app.get('/api/tournaments/:id', ah(async (req, res) => {
  const t = (await getTournament(req.params.id)).toObject();
  res.json({ ...t, id: String(t._id) });
}));

app.get('/api/tournaments/:id/matches', ah(async (req, res) => {
  const t = await getTournament(req.params.id);
  const matches = sortMatches(await Match.find({ tournament: t._id }));
  const ctx = matchContext(t, matches);
  res.json(matches.map((m) => shapeMatch(m, t, ctx)));
}));

app.get('/api/tournaments/:id/standings', ah(async (req, res) => {
  const t = await getTournament(req.params.id);
  res.json(computeStandings(t, await Match.find({ tournament: t._id })));
}));

// Admin promotes a player/team into a group finishing position for the next stage (entryId null = back to standings).
app.put('/api/tournaments/:id/promotions', admin, ah(async (req, res) => {
  const t = await getTournament(req.params.id, res);
  const { stageKey, group } = req.body;
  const g = t.groups.find((x) => x.stageKey === stageKey && x.name === group);
  if (!g) throw new HttpError(404, 'Group not found.');
  // picks = { rank: entryId | null } confirms several positions at once; or a single { rank, entryId }
  const picks = req.body.picks && typeof req.body.picks === 'object' ? req.body.picks : { [req.body.rank]: req.body.entryId };
  const list = Object.entries(picks).map(([rank, entryId]) => ({ rank: Number(rank), entryId: entryId || null }));
  if (!list.length) throw new HttpError(400, 'Nothing to promote.');
  for (const { rank, entryId } of list) {
    if (!Number.isInteger(rank) || rank < 1 || rank > g.entryIds.length) throw new HttpError(400, 'Choose a finishing position in this group.');
    if (entryId && !g.entryIds.some((id) => same(id, entryId))) throw new HttpError(400, 'That player or team is not in this group.');
  }
  const chosen = list.filter((p) => p.entryId).map((p) => String(p.entryId));
  if (new Set(chosen).size !== chosen.length) throw new HttpError(400, 'The same player or team is picked for two positions.');
  const matches = await Match.find({ tournament: t._id });
  if (matches.some((m) => fedByGroup(m, stageKey, group).length && isStarted(m))) {
    throw new HttpError(409, 'A next-stage match fed by this group has already started. Reset its score first.');
  }
  // one position per entry, one entry per position
  const mine = (p) => p.stageKey === stageKey && p.group === group;
  t.promotions = t.promotions.filter((p) => !(mine(p) && (list.some((x) => x.rank === p.rank) || chosen.some((id) => same(p.entry, id)))));
  list.filter((p) => p.entryId).forEach((p) => t.promotions.push({ stageKey, group, rank: p.rank, entry: p.entryId }));
  await t.save();
  await propagate(t._id);
  res.json(computeStandings(t, await Match.find({ tournament: t._id })));
}));

app.get('/api/matches/:id', ah(async (req, res) => {
  await sendMatch(res, await getMatch(req.params.id));
}));

app.get('/api/matches/:id/stats', ah(async (req, res) => {
  const m = await getMatch(req.params.id);
  if (m.manual || m.walkover || !m.log.length) return res.json({ available: false });
  const t = await Tournament.findById(m.tournament);
  const serve = m.serve && m.serve.first ? pickServe(m.serve) : null;
  res.json({
    available: true,
    ...Scoring.matchStats(fmtOf(m), m.log, serve),
    tiebreaks: Scoring.tiebreakPoints(fmtOf(m), m.log, serve, !!t && t.type === 'doubles', m.toss && m.toss.winner ? m.toss : null),
  });
}));

/* ------------------------------ export ----------------------------- */

function csvCell(v) {
  let s = String(v == null ? '' : v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // stop spreadsheets treating names as formulas
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
const toCsv = (rows) => '\ufeff' + rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
const fileSlug = (name) => clean(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'tournament';

function sendFile(res, name, type, body) {
  res.set({ 'Content-Type': type, 'Content-Disposition': `attachment; filename="${name}"` });
  res.send(body);
}

// h:mm:ss from Start match to the result ('' if the match was not timed or is not finished).
function matchTime(m) {
  if (!m.startedAt || !m.endedAt) return '';
  const s = Math.max(0, Math.round((m.endedAt - m.startedAt) / 1000));
  return `${Math.floor(s / 3600)}:${String(Math.floor(s / 60) % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

app.get('/api/tournaments/:id/results.csv', ah(async (req, res) => {
  const t = await getTournament(req.params.id);
  const matches = sortMatches(await Match.find({ tournament: t._id }));
  const ctx = matchContext(t, matches);
  const stageOrder = (k) => (t.stages.find((s) => s.key === k) || { order: 99 }).order;
  const rows = [['Stage', 'Match', 'Group', 'Court', 'Scheduled', 'Side A', 'Side B', 'Status', 'Winner', 'Score', 'Match time', 'Format', 'Notes']];
  matches
    .sort((x, y) => stageOrder(x.stageKey) - stageOrder(y.stageKey) || x.order - y.order)
    .forEach((m) => {
      const s = shapeMatch(m, t, ctx);
      const nameA = s.sideA ? s.sideA.name : s.sideALabel || 'TBD';
      const nameB = s.sideB ? s.sideB.name : s.sideBLabel || 'TBD';
      const winner = m.winnerSide ? (m.winnerSide === 'a' ? nameA : nameB) : '';
      const score = m.isBye ? 'Bye' : m.walkover ? 'Walkover' : Scoring.scoreline(m.state);
      const status = m.status === 'completed' ? (m.manual ? 'Completed (entered)' : 'Completed') : m.status === 'live' ? 'Live' : 'Scheduled';
      rows.push([ctx.stageName(m.stageKey), s.number, m.group, m.court, m.scheduledAt, nameA, nameB, status, winner, score, matchTime(m), Scoring.formatLabel(fmtOf(m)), m.notes]);
    });
  sendFile(res, `${fileSlug(t.name)}-results.csv`, 'text/csv; charset=utf-8', toCsv(rows));
}));

app.get('/api/tournaments/:id/standings.csv', ah(async (req, res) => {
  const t = await getTournament(req.params.id);
  const tables = computeStandings(t, await Match.find({ tournament: t._id }));
  const rows = [['Stage', 'Group', 'Rank', t.type === 'singles' ? 'Player' : 'Team', 'Played', 'Won', 'Lost', 'Points', 'Sets won', 'Sets lost', 'Set %', 'Games won', 'Games lost', 'Game %']];
  tables.forEach((tb) => tb.rows.forEach((r) => rows.push([tb.stageName, tb.group, r.rank, r.name, r.played, r.won, r.lost, r.points, r.setsFor, r.setsAgainst, r.setPct ?? '', r.gamesFor, r.gamesAgainst, r.gamePct ?? ''])));
  sendFile(res, `${fileSlug(t.name)}-standings.csv`, 'text/csv; charset=utf-8', toCsv(rows));
}));

app.get('/api/tournaments/:id/backup.json', admin, ah(async (req, res) => {
  const t = await getTournament(req.params.id);
  const matches = await Match.find({ tournament: t._id }).lean();
  const body = JSON.stringify({ exportedAt: new Date().toISOString(), tournament: t.toObject(), matches }, null, 2);
  sendFile(res, `${fileSlug(t.name)}-backup.json`, 'application/json; charset=utf-8', body);
}));

/* ------------------------ tournaments (admin) --------------------- */

const sendTournament = (res, t, status = 200) => res.status(status).json({ ...t.toObject(), id: String(t._id) });

app.post('/api/tournaments', admin, ah(async (req, res) => {
  const name = clean(req.body.name);
  if (!name) throw new HttpError(400, 'Tournament name is required.');
  if (!['singles', 'doubles'].includes(req.body.type)) throw new HttpError(400, 'Choose singles or doubles.');
  const t = await Tournament.create({ name, type: req.body.type, stages: DEFAULT_STAGES() });
  sendTournament(res, t, 201);
}));

app.put('/api/tournaments/:id', admin, ah(async (req, res) => {
  const t = await getTournament(req.params.id, res);
  if (req.body.name !== undefined) {
    const name = clean(req.body.name);
    if (!name) throw new HttpError(400, 'Tournament name is required.');
    t.name = name;
  }
  if (req.body.status !== undefined) {
    if (!['setup', 'live', 'completed'].includes(req.body.status)) throw new HttpError(400, 'Invalid status.');
    t.status = req.body.status;
  }
  if (req.body.defaultFormat) t.defaultFormat = parseFormat(req.body.defaultFormat);
  await t.save();
  sendTournament(res, t);
}));

app.delete('/api/tournaments/:id', admin, ah(async (req, res) => {
  const t = await getTournament(req.params.id, res);
  res.locals.event = { deleted: true };
  await Match.deleteMany({ tournament: t._id });
  await t.deleteOne();
  res.json({ ok: true });
}));

/* ------------------------------ players --------------------------- */

app.post('/api/tournaments/:id/entries', admin, ah(async (req, res) => {
  const t = await getTournament(req.params.id, res);
  const list = Array.isArray(req.body.entries) ? req.body.entries : [req.body];
  if (!list.length || list.length > 128) throw new HttpError(400, 'Add between 1 and 128 entries at a time.');
  list.forEach((raw) => t.entries.push(buildEntry(t.type, raw)));
  await t.save();
  sendTournament(res, t, 201);
}));

// Seeding: the list order is the seed order used by draws.
app.put('/api/tournaments/:id/entries/order', admin, ah(async (req, res) => {
  const t = await getTournament(req.params.id, res);
  const ids = Array.isArray(req.body.ids) ? req.body.ids.map(String) : [];
  const current = t.entries.map((e) => String(e._id));
  if (ids.length !== current.length || new Set(ids).size !== ids.length || !ids.every((id) => current.includes(id))) {
    throw new HttpError(400, 'The new order must list every player or team exactly once.');
  }
  t.entries = ids.map((id) => t.entries.id(id).toObject());
  await t.save();
  sendTournament(res, t);
}));

app.put('/api/tournaments/:id/entries/:entryId', admin, ah(async (req, res) => {
  const t = await getTournament(req.params.id, res);
  const e = t.entries.id(req.params.entryId);
  if (!e) throw new HttpError(404, 'Entry not found');
  e.set(buildEntry(t.type, req.body));
  await t.save();
  sendTournament(res, t);
}));

app.delete('/api/tournaments/:id/entries/:entryId', admin, ah(async (req, res) => {
  const t = await getTournament(req.params.id, res);
  const e = t.entries.id(req.params.entryId);
  if (!e) throw new HttpError(404, 'Entry not found');
  const used = await Match.exists({ tournament: t._id, $or: [{ sideA: e._id }, { sideB: e._id }] });
  if (used) throw new HttpError(409, 'This entry is in a fixture. Edit or delete those matches first.');
  e.deleteOne();
  t.groups.forEach((g) => (g.entryIds = g.entryIds.filter((x) => !same(x, e._id))));
  t.promotions = t.promotions.filter((p) => !same(p.entry, e._id));
  await t.save();
  sendTournament(res, t);
}));

/* ------------------------------ stages ---------------------------- */

app.put('/api/tournaments/:id/stages', admin, ah(async (req, res) => {
  const t = await getTournament(req.params.id, res);
  const stages = req.body.stages;
  if (!Array.isArray(stages) || !stages.length || stages.length > 12) throw new HttpError(400, 'Provide between 1 and 12 stages.');
  const next = stages.map((s, i) => {
    const name = clean(s.name).slice(0, 60);
    if (!name) throw new HttpError(400, 'Every stage needs a name.');
    if (!['group', 'knockout'].includes(s.kind)) throw new HttpError(400, 'Stage type must be group or knockout.');
    const known = s.key && t.stages.some((x) => x.key === s.key);
    return { key: known ? s.key : 'stage-' + crypto.randomBytes(4).toString('hex'), name, kind: s.kind, enabled: !!s.enabled, order: i };
  });
  const used = await Match.distinct('stageKey', { tournament: t._id });
  if (used.some((k) => !next.some((s) => s.key === k))) {
    throw new HttpError(409, 'A stage with fixtures cannot be removed. Delete its matches first, or just switch the stage off.');
  }
  t.stages = next;
  await t.save();
  sendTournament(res, t);
}));

/* ----------------------------- fixtures --------------------------- */

app.post('/api/tournaments/:id/fixtures/generate', admin, ah(async (req, res) => {
  const t = await getTournament(req.params.id, res);
  const { stageKey, source = 'entries', draw = 'listed' } = req.body;
  const chain = req.body.chain !== false;
  const enabled = t.stages.filter((s) => s.enabled).sort((x, y) => x.order - y.order);
  const idx = enabled.findIndex((s) => s.key === stageKey);
  if (idx < 0) throw new HttpError(400, 'Choose a stage that is switched on.');
  const stage = enabled[idx];
  if (t.entries.length < 2) throw new HttpError(400, 'Add at least two players or teams first.');

  // Knockout stages that follow directly are built as one bracket.
  const chained = [];
  if (stage.kind === 'knockout' && chain) {
    for (let i = idx + 1; i < enabled.length && enabled[i].kind === 'knockout'; i++) chained.push(enabled[i]);
  }
  const replaceKeys = [stageKey, ...chained.map((s) => s.key)];
  const existing = await Match.find({ tournament: t._id, stageKey: { $in: replaceKeys } });
  if (existing.some((m) => isStarted(m))) {
    throw new HttpError(409, 'Matches in this part of the draw have already started. Edit them individually instead.');
  }

  const docs = [];
  const newGroups = [];
  const last = await Match.findOne({ tournament: t._id, stageKey: { $nin: replaceKeys } }).sort({ order: -1 });
  let order = last ? last.order + 1 : 0;
  const make = (key, a, b, extra = {}) => {
    const d = {
      _id: new mongoose.Types.ObjectId(),
      tournament: t._id,
      stageKey: key,
      group: '',
      round: 1,
      order: order++,
      sideA: null,
      sideB: null,
      sourceA: null,
      sourceB: null,
      format: t.defaultFormat,
      state: Scoring.newState(),
      ...extra,
    };
    // a / b: { entry } | { source } | null (bye)
    if (a && a.entry) d.sideA = a.entry;
    if (a && a.source) d.sourceA = a.source;
    if (b && b.entry) d.sideB = b.entry;
    if (b && b.source) d.sourceB = b.source;
    if (!b) {
      d.isBye = true;
      d.walkover = true;
      if (d.sideA) {
        d.status = 'completed';
        d.winnerSide = 'a';
        d.state.winner = 'a';
      }
    }
    docs.push(d);
    return d;
  };
  // Pair a seeded list into a bracket of the next power of two; top seeds get byes.
  const bracketPairs = (seeds) => {
    let size = 1;
    while (size < seeds.length) size *= 2;
    size = Math.max(size, 2);
    const pos = seedOrder(size);
    const pairs = [];
    for (let i = 0; i < size; i += 2) {
      const x = seeds[pos[i] - 1] || null;
      const y = seeds[pos[i + 1] - 1] || null;
      if (x || y) pairs.push(x ? [x, y] : [y, x]);
    }
    return pairs;
  };

  if (stage.kind === 'group') {
    const ids = (draw === 'random' ? shuffle(t.entries) : [...t.entries]).map((e) => e._id);
    const k = Math.max(1, Math.min(Number(req.body.groupsCount) || 2, Math.floor(ids.length / 2)));
    const buckets = Array.from({ length: k }, () => []);
    ids.forEach((id, i) => {
      const row = Math.floor(i / k);
      const col = i % k;
      buckets[row % 2 === 0 ? col : k - 1 - col].push(id); // snake seeding
    });
    buckets.forEach((members, gi) => {
      const name = 'Group ' + String.fromCharCode(65 + gi);
      newGroups.push({ stageKey, name, entryIds: members });
      roundRobin(members).forEach((r) => make(stageKey, { entry: r.a }, { entry: r.b }, { group: name, round: r.round }));
    });
  } else {
    let firstRound = [];
    if (source === 'previous') {
      const prev = enabled[idx - 1];
      if (!prev) throw new HttpError(400, 'There is no earlier stage to take qualifiers from.');
      if (prev.kind === 'group') {
        const groups = t.groups.filter((g) => g.stageKey === prev.key);
        if (!groups.length) throw new HttpError(409, `Generate the ${prev.name} fixtures first.`);
        const q = Math.max(1, Math.min(8, Number(req.body.qualifiers) || 2));
        const slot = (g, rank) => ({ source: { kind: 'group', stageKey: prev.key, group: g.name, rank } });
        if (q === 2 && groups.length >= 2) {
          // Group winners meet the runner-up of the next group (A1 v B2, B1 v A2, ...).
          firstRound = groups.map((g, i) => [slot(g, 1), slot(groups[(i + 1) % groups.length], 2)]);
        } else {
          const seeds = [];
          for (let r = 1; r <= q; r++) groups.forEach((g) => r <= g.entryIds.length && seeds.push(slot(g, r)));
          firstRound = bracketPairs(seeds);
        }
      } else {
        const prevMatches = sortMatches(await Match.find({ tournament: t._id, stageKey: prev.key }));
        if (!prevMatches.length) throw new HttpError(409, `${prev.name} has no fixtures yet.`);
        for (let i = 0; i < prevMatches.length; i += 2) {
          const w = (m) => (m ? { source: { kind: 'winner', match: m._id } } : null);
          firstRound.push([w(prevMatches[i]), w(prevMatches[i + 1])]);
        }
      }
    } else {
      const seeds = (draw === 'random' ? shuffle(t.entries) : [...t.entries]).map((e) => ({ entry: e._id }));
      firstRound = bracketPairs(seeds);
    }
    if (!firstRound.length) throw new HttpError(400, 'No fixtures could be generated.');
    let round = firstRound.map(([a, b]) => make(stageKey, a, b));
    for (const next of chained) {
      if (round.length < 2) break;
      const created = [];
      for (let i = 0; i < round.length; i += 2) {
        const a = { source: { kind: 'winner', match: round[i]._id } };
        const b = round[i + 1] ? { source: { kind: 'winner', match: round[i + 1]._id } } : null;
        created.push(make(next.key, a, b));
      }
      round = created;
    }
  }

  await Match.deleteMany({ tournament: t._id, stageKey: { $in: replaceKeys } });
  t.groups = t.groups.filter((g) => g.stageKey !== stageKey).concat(newGroups);
  if (newGroups.length) t.promotions = t.promotions.filter((p) => p.stageKey !== stageKey);
  await t.save();
  await Match.insertMany(docs);
  await propagate(t._id);
  const stagesTouched = [...new Set(docs.map((d) => d.stageKey))];
  res.status(201).json({ created: docs.length, stages: stagesTouched });
}));

function checkSides(t, a, b) {
  const valid = (id) => id == null || id === '' || (mongoose.isValidObjectId(id) && t.entries.id(id));
  if (!valid(a) || !valid(b)) throw new HttpError(400, 'Unknown player or team.');
  if (a && b && same(a, b)) throw new HttpError(400, 'A match needs two different sides.');
}

app.post('/api/tournaments/:id/matches', admin, ah(async (req, res) => {
  const t = await getTournament(req.params.id, res);
  const { stageKey, sideA, sideB } = req.body;
  if (!t.stages.some((s) => s.key === stageKey)) throw new HttpError(400, 'Unknown stage.');
  checkSides(t, sideA, sideB);
  const last = await Match.findOne({ tournament: t._id }).sort({ order: -1 });
  const m = await Match.create({
    tournament: t._id,
    stageKey,
    group: clean(req.body.group).slice(0, 30),
    order: last ? last.order + 1 : 0,
    sideA: sideA || null,
    sideB: sideB || null,
    format: req.body.format ? parseFormat(req.body.format) : t.defaultFormat,
    state: Scoring.newState(),
    court: clean(req.body.court).slice(0, 40),
    scheduledAt: clean(req.body.scheduledAt).slice(0, 60),
    notes: clean(req.body.notes).slice(0, 300),
  });
  await sendMatch(res, m, 201);
}));

app.put('/api/matches/:id', admin, ah(async (req, res) => {
  const m = await getMatch(req.params.id, res);
  const t = await getTournament(m.tournament);
  const b = req.body;

  const changingA = 'sideA' in b && String(b.sideA || '') !== String(m.sideA || '');
  const changingB = 'sideB' in b && String(b.sideB || '') !== String(m.sideB || '');
  const formatChanging = b.format && JSON.stringify(parseFormat(b.format)) !== JSON.stringify(parseFormat(fmtOf(m)));
  if ((changingA || changingB || formatChanging) && (m.log.length || m.manual || m.startedAt)) {
    throw new HttpError(409, 'Scoring has started. Reset the score before changing the players or the match format.');
  }
  if (changingA || changingB) {
    if (m.status === 'completed') await guardResultChange(m);
    const a = 'sideA' in b ? b.sideA || null : m.sideA;
    const c = 'sideB' in b ? b.sideB || null : m.sideB;
    checkSides(t, a, c);
    m.sideA = a;
    m.sideB = c;
    if (changingA) m.sourceA = null; // a hand-picked player replaces the bracket link
    if (changingB) m.sourceB = null;
    m.toss = null; // the toss was between the old sides
    if (m.isBye || m.walkover) {
      m.isBye = false;
      m.walkover = false;
      m.status = 'scheduled';
      m.winnerSide = null;
      m.state = Scoring.newState();
    }
  }
  if (formatChanging) m.format = parseFormat(b.format);
  if (b.serve !== undefined) m.serve = parseServe(b.serve);
  if (b.stageKey !== undefined) {
    if (!t.stages.some((s) => s.key === b.stageKey)) throw new HttpError(400, 'Unknown stage.');
    m.stageKey = b.stageKey;
  }
  if (b.group !== undefined) m.group = clean(b.group).slice(0, 30);
  if (b.court !== undefined) m.court = clean(b.court).slice(0, 40);
  if (b.scheduledAt !== undefined) m.scheduledAt = clean(b.scheduledAt).slice(0, 60);
  if (b.notes !== undefined) m.notes = clean(b.notes).slice(0, 300);
  if (b.round !== undefined && Number.isFinite(Number(b.round))) m.round = Number(b.round);
  if (b.order !== undefined && Number.isFinite(Number(b.order))) m.order = Number(b.order);
  await m.save();
  await propagate(m.tournament);
  await sendMatch(res, m);
}));

app.delete('/api/matches/:id', admin, ah(async (req, res) => {
  const m = await getMatch(req.params.id, res);
  await guardResultChange(m);
  await m.deleteOne();
  await Match.updateMany({ 'sourceA.match': m._id }, { $set: { sourceA: null } });
  await Match.updateMany({ 'sourceB.match': m._id }, { $set: { sourceB: null } });
  await propagate(m.tournament);
  res.json({ ok: true });
}));

app.post('/api/tournaments/:id/apply-format', admin, ah(async (req, res) => {
  const t = await getTournament(req.params.id, res);
  const format = parseFormat(req.body.format);
  const filter = { tournament: t._id, isBye: false, manual: { $ne: true }, status: 'scheduled', 'log.0': { $exists: false } };
  if (req.body.stageKey) filter.stageKey = req.body.stageKey;
  const r = await Match.updateMany(filter, { $set: { format } });
  if (!req.body.stageKey) {
    t.defaultFormat = format;
    await t.save();
  }
  res.json({ updated: r.modifiedCount });
}));

/* ------------------------------ scoring --------------------------- */

function parseServe(sv) {
  const s = sv || {};
  if (s.first != null && !['a', 'b'].includes(s.first)) throw new HttpError(400, 'First server must be side "a" or "b".');
  const pick = (v) => (Number(v) === 2 ? 2 : 1);
  const deuce = (v) => ([1, 2].includes(Number(v)) ? Number(v) : null);
  const sets = new Map(); // one serving order per later set; the last one sent wins
  for (const o of Array.isArray(s.sets) ? s.sets : []) {
    const set = Number(o && o.set);
    if (!Number.isInteger(set) || set < 2 || set > 5) throw new HttpError(400, 'A serving order can be set for set 2 to 5.');
    sets.set(set, { set, aFirst: pick(o.aFirst), bFirst: pick(o.bFirst), aDeuce: deuce(o.aDeuce), bDeuce: deuce(o.bDeuce) });
  }
  return { first: s.first || null, aFirst: pick(s.aFirst), bFirst: pick(s.bFirst), aDeuce: deuce(s.aDeuce), bDeuce: deuce(s.bDeuce), sets: [...sets.values()].sort((x, y) => x.set - y.set) };
}

function parseToss(b) {
  const toss = {
    winner: b.winner,
    choice: b.choice,
    deferredChoice: b.choice === 'defer' ? b.deferredChoice : null,
    decision: b.decision,
    end: clean(b.end).slice(0, 40),
  };
  try {
    return { toss, outcome: Scoring.tossOutcome(toss) };
  } catch (e) {
    throw new HttpError(400, e.message);
  }
}

// Match time runs from "Start match" until the result is in.
function markEnd(m) {
  if (m.status !== 'completed') m.endedAt = null;
  else if (m.startedAt && !m.endedAt) m.endedAt = new Date();
}

function recompute(m) {
  const state = Scoring.computeState(fmtOf(m), m.log);
  m.state = state;
  m.markModified('state');
  m.winnerSide = state.winner;
  m.status = state.winner ? 'completed' : m.log.length || m.startedAt ? 'live' : 'scheduled';
  markEnd(m);
}

// Save, then refresh the bracket if the result changed.
async function saveScored(m, wasCompleted, res) {
  await m.save();
  if (wasCompleted || m.status === 'completed') await propagate(m.tournament);
  await sendMatch(res, m);
}

app.post('/api/matches/:id/point', scorer, ah(async (req, res) => {
  const m = await getMatch(req.params.id, res);
  if (!['a', 'b'].includes(req.body.side)) throw new HttpError(400, 'side must be "a" or "b".');
  if (!m.sideA || !m.sideB) throw new HttpError(409, 'Both sides must be set before scoring.');
  if (m.status === 'completed') throw new HttpError(409, 'This match is finished. Undo the last point or reset the score to change it.');
  if (!m.startedAt && !m.log.length) throw new HttpError(409, 'Press Start match before scoring points.');
  m.log.push(req.body.side);
  recompute(m);
  await saveScored(m, false, res);
}));

app.post('/api/matches/:id/start', scorer, ah(async (req, res) => {
  const m = await getMatch(req.params.id, res);
  if (m.isBye) throw new HttpError(409, 'A bye is not played.');
  if (!m.sideA || !m.sideB) throw new HttpError(409, 'Both sides must be set before the match starts.');
  if (m.status === 'completed') throw new HttpError(409, 'This match is already finished.');
  if (m.startedAt) throw new HttpError(409, 'This match has already started.');
  m.startedAt = new Date();
  m.endedAt = null;
  m.status = 'live';
  await m.save();
  await sendMatch(res, m);
}));

app.post('/api/matches/:id/undo', scorer, ah(async (req, res) => {
  const m = await getMatch(req.params.id, res);
  if (m.walkover) throw new HttpError(409, 'Reset the score to undo a walkover.');
  if (m.manual) throw new HttpError(409, 'This score was entered by hand. Reset the score to clear it.');
  if (!m.log.length) throw new HttpError(409, 'Nothing to undo.');
  const was = m.status === 'completed';
  if (was) await guardResultChange(m);
  m.log.pop();
  recompute(m);
  await saveScored(m, was, res);
}));

app.post('/api/matches/:id/reset', scorer, ah(async (req, res) => {
  const m = await getMatch(req.params.id, res);
  if (m.isBye) throw new HttpError(409, 'A bye has no score to reset. Edit the match to add an opponent.');
  const was = m.status === 'completed';
  if (was) await guardResultChange(m);
  m.log = [];
  m.walkover = false;
  m.manual = false;
  m.startedAt = null; // back to "not started"
  recompute(m);
  await saveScored(m, was, res);
}));

app.post('/api/matches/:id/serve', scorer, ah(async (req, res) => {
  const m = await getMatch(req.params.id, res);
  m.serve = parseServe(req.body);
  await m.save();
  await sendMatch(res, m);
}));

// Record the coin toss; it sets who serves first (and, in doubles, each team's first server).
app.post('/api/matches/:id/toss', scorer, ah(async (req, res) => {
  const m = await getMatch(req.params.id, res);
  if (m.isBye) throw new HttpError(409, 'A bye has no toss.');
  if (!m.sideA || !m.sideB) throw new HttpError(409, 'Both sides must be set first.');
  if (isStarted(m)) throw new HttpError(409, 'The match has started. Reset the score to record the toss again.');
  const { toss, outcome } = parseToss(req.body || {});
  const old = m.serve || {};
  const sv = parseServe({ ...pickServe(old), first: outcome.firstServer });
  if (req.body.aFirst !== undefined) sv.aFirst = Number(req.body.aFirst) === 2 ? 2 : 1;
  if (req.body.bFirst !== undefined) sv.bFirst = Number(req.body.bFirst) === 2 ? 2 : 1;
  m.toss = { ...toss, recordedAt: new Date() };
  m.serve = sv;
  await m.save();
  await sendMatch(res, m);
}));

app.post('/api/matches/:id/walkover', admin, ah(async (req, res) => {
  const m = await getMatch(req.params.id, res);
  if (!['a', 'b'].includes(req.body.side)) throw new HttpError(400, 'side must be "a" or "b".');
  if (!m.sideA || !m.sideB) throw new HttpError(409, 'Both sides must be set first.');
  const was = m.status === 'completed';
  if (was) await guardResultChange(m);
  m.walkover = true;
  m.manual = false;
  m.status = 'completed';
  m.winnerSide = req.body.side;
  m.state = { ...(m.state || Scoring.newState()), winner: req.body.side };
  markEnd(m);
  m.markModified('state');
  await saveScored(m, was, res);
}));

app.post('/api/matches/:id/result', scorer, ah(async (req, res) => {
  const m = await getMatch(req.params.id, res);
  if (m.isBye) throw new HttpError(409, 'A bye has no score. Edit the match to add an opponent first.');
  if (!m.sideA || !m.sideB) throw new HttpError(409, 'Both sides must be set first.');
  let state;
  try {
    state = Scoring.stateFromSets(fmtOf(m), req.body.sets);
  } catch (e) {
    throw new HttpError(400, e.message);
  }
  const was = m.status === 'completed';
  if (was && m.winnerSide !== state.winner) await guardResultChange(m);
  m.log = [];
  m.manual = true;
  m.walkover = false;
  m.state = state;
  m.markModified('state');
  m.winnerSide = state.winner;
  m.status = 'completed';
  markEnd(m);
  await saveScored(m, was, res);
}));

/* ------------------------------ static ---------------------------- */

app.get('/scoring.js', (req, res) => res.sendFile(path.join(__dirname, 'lib', 'scoring.js')));
app.use(express.static(path.join(__dirname, 'public')));

app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

app.use((err, req, res, next) => {
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
  if (err.name === 'ValidationError') return res.status(400).json({ error: Object.values(err.errors).map((e) => e.message).join(' ') });
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON.' });
  console.error(err);
  res.status(500).json({ error: 'Something went wrong on the server.' });
});

mongoose
  .connect(MONGODB_URI)
  .then(() => app.listen(PORT, () => console.log(`Tennis tracker running on port ${PORT}`)))
  .catch((err) => {
    console.error('MongoDB connection failed:', err.message);
    process.exit(1);
  });

module.exports = app;
