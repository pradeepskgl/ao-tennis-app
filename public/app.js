(() => {
  const root = document.getElementById('app');
  const S = {
    token: localStorage.getItem('tt_token') || '',
    role: null, // 'admin' | 'scorer' | null
    user: '',
    view: 'list',
    tournaments: [],
    scorers: [],
    t: null,
    matches: [],
    standings: [],
    tab: 'matches',
    draftStages: [],
    matchDlg: null,
    schedFilter: { entry: '', hideDone: false },
    es: null,
  };
  const isAdmin = () => S.role === 'admin';
  const canScore = () => S.role === 'admin' || S.role === 'scorer';

  /* ----------------------------- utilities ----------------------------- */

  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    let value;
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k === 'value') value = v;
      else if (k === 'checked' || k === 'selected' || k === 'disabled') el[k] = !!v;
      else el.setAttribute(k, v === true ? '' : v);
    }
    kids.flat(Infinity).forEach((c) => {
      if (c === null || c === undefined || c === false) return;
      el.append(c.nodeType ? c : document.createTextNode(c));
    });
    if (value !== undefined) el.value = value;
    return el;
  }

  // replaceChildren that skips null/false and flattens arrays (like h()).
  function fill(el, ...kids) {
    el.replaceChildren(...kids.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false));
    return el;
  }

  function toast(msg, bad) {
    const t = h('div', { class: 'toast' + (bad ? ' bad' : ''), role: bad ? 'alert' : 'status' }, msg);
    document.getElementById('toasts').append(t);
    setTimeout(() => t.remove(), bad ? 6000 : 3000);
  }

  async function api(path, opts = {}) {
    const res = await fetch('/api' + path, {
      method: opts.method || 'GET',
      headers: { 'Content-Type': 'application/json', ...(S.token ? { Authorization: 'Bearer ' + S.token } : {}) },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    let data = null;
    try { data = await res.json(); } catch { /* empty body */ }
    if (!res.ok) {
      if (res.status === 401 && S.token) signOut(true);
      throw new Error((data && data.error) || res.statusText || 'Request failed');
    }
    return data;
  }

  async function act(fn, okMsg) {
    try {
      const r = await fn();
      if (okMsg) toast(okMsg);
      return r;
    } catch (e) {
      toast(e.message, true);
      return undefined;
    }
  }

  const typeLabel = (t) => (t.type === 'singles' ? 'Singles' : 'Doubles');
  const unitLabel = (t, n) => (t.type === 'singles' ? (n === 1 ? 'player' : 'players') : n === 1 ? 'team' : 'teams');
  const statusLabel = { setup: 'Setting up', live: 'Live', completed: 'Completed' };
  const sideOf = (m, k) => (k === 'a' ? m.sideA : m.sideB);
  const sideLabel = (m, k) => {
    const s = sideOf(m, k);
    if (s) return s.name;
    return (k === 'a' ? m.sideALabel : m.sideBLabel) || 'TBD';
  };
  const stageOf = (key) => S.t.stages.find((s) => s.key === key);
  const matchTitle = (m) => {
    const st = stageOf(m.stageKey);
    return [st ? st.name + (st.kind === 'knockout' && m.number ? ' ' + m.number : '') : '', m.group].filter(Boolean).join(', ');
  };
  const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;
  function whenLabel(v) {
    if (!v) return '';
    if (!ISO_TIME.test(v)) return v;
    const d = new Date(v);
    return d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' }) + ', ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  function seg(options, value, onChange, disabled) {
    return h('div', { class: 'seg', role: 'group' },
      options.map(([v, label]) =>
        h('button', { type: 'button', class: 'seg-btn' + (v === value ? ' on' : ''), 'aria-pressed': String(v === value), disabled, onclick: () => onChange(v) }, label)));
  }

  function field(label, input, hint) {
    return h('div', { class: 'field' }, h('label', {}, label), input, hint ? h('p', { class: 'hint' }, hint) : null);
  }

  function modal(title, content, wide) {
    const body = h('div', { class: 'modal-body' }, content);
    const d = h('dialog', { class: 'modal' + (wide ? ' wide' : '') },
      h('div', { class: 'modal-head' }, h('h2', {}, title), h('button', { class: 'icon', 'aria-label': 'Close', onclick: () => d.close() }, '×')),
      body);
    d.addEventListener('close', () => { d.remove(); if (S.matchDlg && S.matchDlg.dialog === d) S.matchDlg = null; });
    d.addEventListener('click', (e) => { if (e.target === d) d.close(); });
    document.body.append(d);
    d.showModal();
    return { dialog: d, body };
  }

  async function downloadWithAuth(path, filename) {
    const res = await fetch('/api' + path, { headers: { Authorization: 'Bearer ' + S.token } });
    if (!res.ok) throw new Error('Download failed. Sign in again and retry.');
    const url = URL.createObjectURL(await res.blob());
    const a = h('a', { href: url, download: filename });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }

  /* ----------------------------- auth ----------------------------- */

  function signOut(expired) {
    S.token = '';
    S.role = null;
    S.user = '';
    localStorage.removeItem('tt_token');
    if (S.matchDlg) S.matchDlg.dialog.close();
    if (S.tab === 'setup') S.tab = 'matches';
    if (S.view === 'scorers') location.hash = '#/';
    render();
    toast(expired ? 'Your session expired. Sign in again to keep editing.' : 'Signed out.');
  }

  function openLogin() {
    const err = h('p', { class: 'err', role: 'alert' });
    const user = h('input', { type: 'text', autocomplete: 'username', required: true, autocapitalize: 'none' });
    const pass = h('input', { type: 'password', autocomplete: 'current-password', required: true });
    const form = h('form', {
      onsubmit: async (e) => {
        e.preventDefault();
        err.textContent = '';
        try {
          const r = await api('/auth/login', { method: 'POST', body: { username: user.value, password: pass.value } });
          S.token = r.token;
          S.role = r.role;
          S.user = r.name;
          localStorage.setItem('tt_token', r.token);
          dlg.dialog.close();
          render();
          toast(r.role === 'admin' ? 'Signed in as admin.' : `Signed in as scorer ${r.name}.`);
        } catch (ex) {
          err.textContent = ex.message;
        }
      },
    }, field('Username', user), field('Password', pass), err, h('button', { class: 'btn', type: 'submit' }, 'Sign in'),
    h('p', { class: 'hint' }, 'Admins manage everything. Scorers can score matches only.'));
    const dlg = modal('Sign in', form);
    user.focus();
  }

  /* ----------------------------- scoreboard ----------------------------- */

  function currentServer(m) {
    if (!m.serve || m.walkover || m.manual || m.status === 'completed' || !m.sideA || !m.sideB) return null;
    return Scoring.serverFor(m.format, m.state || Scoring.newState(), m.serve, S.t && S.t.type === 'doubles');
  }

  // Player name for a { side, player } ref, or the side's name when the player isn't known.
  function playerShort(m, ref) {
    if (!ref) return '–';
    const side = sideOf(m, ref.side);
    return (ref.player && side['player' + ref.player]) || side.name;
  }

  // Next point: who serves from which court, who receives, and which side is at which end.
  // The two ends of the court, as named at the venue.
  const COURT_ENDS = ['Pool end', 'Entrance end'];
  const otherEnd = (end) => (end === COURT_ENDS[0] ? COURT_ENDS[1] : end === COURT_ENDS[1] ? COURT_ENDS[0] : 'other end');
  const cap = (x) => x.charAt(0).toUpperCase() + x.slice(1);

  function courtInfo(m) {
    if (m.walkover || m.manual || m.isBye || m.status === 'completed' || !m.sideA || !m.sideB) return null;
    const st = m.state || Scoring.newState();
    const p = Scoring.positions(m.format, st, m.serve, S.t.type === 'doubles', m.toss);
    if (!p) return null;
    const name = (k) => sideOf(m, k).name;
    const endName = m.toss && m.toss.end;
    const atEnd = p.atEnd && endName ? [name(p.atEnd), name(p.atEnd === 'a' ? 'b' : 'a')] : null;
    const parts = [];
    if (p.changeEnds) {
      const moves = S.t.type === 'singles' ? 'moves' : 'move';
      parts.push(h('p', { class: 'ends-change' }, h('span', { class: 'badge live' }, 'Change ends now'), ' ',
        atEnd ? `${atEnd[0]} ${moves} to the ${endName}; ${atEnd[1]} ${moves} to the ${otherEnd(endName)}.` : 'Players swap ends before this point.'));
    }
    if (p.server) {
      const court = p.court === 'deuce' ? 'deuce court' : 'ad court';
      parts.push(
        h('p', { class: 'serving' }, h('span', { class: 'srv' }),
          `${m.status === 'live' ? 'Serving' : 'Serves first'}: ${serverName(m, p.server)}${p.receiverChooses ? '' : `, from the ${court}`}`),
        h('p', {}, p.receiverChooses
          ? `Receiving: ${name(p.receiver.side)}. Deciding point: ${S.t.type === 'doubles' ? 'the receiving team chooses who receives' : 'the receiver chooses the court'}.`
          : `Receiving: ${serverName(m, p.receiver)}, in the ${court}`));
    }
    if (atEnd && !p.changeEnds) parts.push(h('p', {}, `${endName}: ${atEnd[0]}. ${cap(otherEnd(endName))}: ${atEnd[1]}.`));
    const next = Scoring.nextEndChange(m.format, st);
    if (next) parts.push(h('p', { class: 'hint' }, `Next change of ends: ${endChangeLabel(m.format, next)}.`));
    return h('div', { class: 'court-info' }, parts);
  }

  // Ends change after games 1, 3, 5... of each set and every 6 points of a tie-breaker.
  function endChangeLabel(f, next) {
    if (next.point) return `after point ${next.point} of the tie-breaker${next.orAtEnd ? ', or when it ends' : ''}`;
    if (next.tiebreak) return `after 6 points of the tie-breaker at ${Scoring.tiebreakAt(f)}-${Scoring.tiebreakAt(f)}, or after game 1 of the next set if this set ends first`;
    return `after game ${next.game} of this set`;
  }

// Elapsed match time as h:mm:ss; a running clock ticks via the timer below.
  const clockText = (ms) => {
    const s = Math.max(0, Math.floor(ms / 1000));
    return `${Math.floor(s / 3600)}:${String(Math.floor(s / 60) % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  };
  function matchClock(m) {
    const start = new Date(m.startedAt).getTime();
    if (m.endedAt) return h('span', { class: 'clock' }, clockText(new Date(m.endedAt).getTime() - start));
    return h('span', { class: 'clock', 'data-clock': String(start) }, clockText(Date.now() - start));
  }
  setInterval(() => document.querySelectorAll('[data-clock]').forEach((el) => { el.textContent = clockText(Date.now() - Number(el.dataset.clock)); }), 1000);

  function serverName(m, srv) {
    const side = sideOf(m, srv.side);
    if (srv.player && side['player' + srv.player]) return `${side['player' + srv.player]} (${side.name})`;
    return side.name;
  }

  function scoreboard(m, size) {
    const st = m.state || Scoring.newState();
    const f = m.format;
    const live = m.status === 'live';
    const done = m.status === 'completed';
    const g = Scoring.gameDisplay(f, st);
    const srv = currentServer(m);

    function row(k) {
      const o = k === 'a' ? 'b' : 'a';
      const side = sideOf(m, k);
      const cells = [];
      if (m.isBye) {
        if (k === 'a' && side) cells.push(h('span', { class: 'c w' }, 'Bye'));
      } else if (!m.walkover) {
        st.sets.forEach((s) => {
          if (s.mtb) cells.push(h('span', { class: 'c mtb' }, `[${s[k]}]`));
          else {
            const lostTb = s.tb && s[k] < s[o];
            cells.push(h('span', { class: 'c' + (s[k] > s[o] ? ' w' : '') }, String(s[k]), lostTb ? h('sup', {}, String(s.tb[k])) : null));
          }
        });
        if (live && st.mode !== 'matchtb') cells.push(h('span', { class: 'c cur' }, String(st.games[k])));
        if (live) cells.push(h('span', { class: 'c pt' }, g[k]));
      } else if (m.winnerSide === k) cells.push(h('span', { class: 'c w' }, 'W/O'));
      return h('div', { class: 'sb-row' + (done && m.winnerSide === k ? ' win' : '') + (side ? '' : ' tbd') },
        h('span', { class: 'sb-name' }, h('span', { class: 'sb-text' }, sideLabel(m, k)), srv && srv.side === k ? h('span', { class: 'srv', title: 'Serving', role: 'img', 'aria-label': 'serving' }) : null,
          done && !m.isBye && m.winnerSide === k ? h('span', { class: 'win-tag' }, 'Winner') : null),
        h('span', { class: 'sb-cells' }, cells));
    }

    let foot;
    if (m.isBye) foot = m.sideA ? 'Bye, advances automatically' : 'Bye, waiting for the earlier result';
    else if (m.walkover) foot = `Walkover: ${sideLabel(m, m.winnerSide)} wins`;
    else if (done) foot = [h('b', {}, `Winner: ${sideLabel(m, m.winnerSide)}`), m.manual ? ' (score entered)' : '', m.startedAt && m.endedAt ? [' · ', matchClock(m)] : null];
    else if (live) foot = [m.pointsPlayed ? Scoring.phaseLabel(f, st) : 'Started', m.startedAt ? [' · ', matchClock(m)] : null, Scoring.changeEndsNow(st) ? h('span', { class: 'badge live sb-ends' }, 'Change ends') : null];
    else foot = m.sideA && m.sideB ? [whenLabel(m.scheduledAt), m.court].filter(Boolean).join(', ') || 'Not started' : 'Waiting for earlier results';

    return h('div', { class: 'sb' + (live ? ' live' : '') + (size ? ' ' + size : '') }, row('a'), row('b'), h('div', { class: 'sb-foot' }, foot));
  }

  /* ----------------------------- list + scorers pages ----------------------------- */

  async function showList() {
    closeStream();
    S.view = 'list';
    S.t = null;
    try { S.tournaments = await api('/tournaments'); } catch (e) { toast(e.message, true); S.tournaments = []; }
    render();
  }

  function listView() {
    const name = h('input', { type: 'text', maxlength: 100, placeholder: 'e.g. Club Championship 2026', required: true });
    let type = 'singles';
    const typeBox = h('div');
    const drawType = () => fill(typeBox, seg([['singles', 'Singles'], ['doubles', 'Doubles']], type, (v) => { type = v; drawType(); }));
    drawType();
    const create = isAdmin()
      ? h('form', {
          class: 'panel',
          onsubmit: async (e) => {
            e.preventDefault();
            const t = await act(() => api('/tournaments', { method: 'POST', body: { name: name.value, type } }));
            if (t) { S.tab = 'setup'; location.hash = `#/t/${t.id}/setup`; }
          },
        },
        h('h3', {}, 'New tournament'),
        h('div', { class: 'row', style: 'margin-top:.6rem' }, field('Tournament name', name), h('div', { class: 'field', style: 'flex:0 0 auto' }, h('label', {}, 'Format'), typeBox),
          h('button', { class: 'btn', type: 'submit' }, 'Create tournament')))
      : null;

    return h('main', { class: 'wrap' },
      h('h1', {}, 'Tournaments'),
      h('p', { class: 'sub' }, 'Live scores, draws and standings for singles and doubles events.'),
      h('div', { style: 'height:1rem' }), create,
      S.tournaments.length
        ? h('ul', { class: 't-list' }, S.tournaments.map((t) =>
            h('li', {}, h('a', { class: 't-item', href: `#/t/${t.id}/matches` },
              h('div', {}, h('h3', {}, t.name), h('span', { class: 'sub' }, `${t.type === 'singles' ? 'Singles' : 'Doubles'}, ${t.entryCount} ${t.type === 'singles' ? 'players' : 'teams'}`)),
              h('span', { class: 'badge' + (t.status === 'live' ? ' live' : '') }, statusLabel[t.status])))))
        : h('div', { class: 'empty', style: 'margin-top:1rem' }, isAdmin() ? 'No tournaments yet. Create the first one above.' : 'No tournaments yet. Check back soon.'));
  }

  async function showScorers() {
    closeStream();
    S.view = 'scorers';
    if (!isAdmin()) { location.hash = '#/'; return; }
    try { S.scorers = await api('/scorers'); } catch (e) { toast(e.message, true); }
    render();
  }

  function scorersView() {
    const user = h('input', { type: 'text', maxlength: 30, autocomplete: 'off', autocapitalize: 'none', placeholder: 'court1' });
    const pass = h('input', { type: 'password', autocomplete: 'new-password', minlength: 8 });
    return h('main', { class: 'wrap' },
      h('a', { class: 'back', href: '#/' }, '← All tournaments'),
      h('h1', {}, 'Scorers'),
      h('p', { class: 'sub' }, 'Scorer logins can score matches, set the serve and enter final scores, in any tournament. They cannot change players, formats or fixtures. Removing a scorer signs them out straight away.'),
      h('form', { class: 'panel', style: 'margin-top:1rem', onsubmit: (e) => {
        e.preventDefault();
        act(async () => { await api('/scorers', { method: 'POST', body: { username: user.value, password: pass.value } }); await showScorers(); }, 'Scorer added');
      } },
        h('div', { class: 'row' }, field('Username', user), field('Password', pass),
          h('button', { class: 'btn', type: 'submit' }, 'Add scorer')),
        h('p', { class: 'hint' }, 'Password: at least 8 characters. Share it with the scorer directly.')),
      S.scorers.length
        ? h('div', { class: 'panel' }, h('ul', { class: 'list', style: 'margin:0' }, S.scorers.map((s) => h('li', {}, h('span', {}, s.username),
            h('button', { class: 'btn danger small', onclick: () => {
              if (confirm(`Remove scorer ${s.username}?`)) act(async () => { await api('/scorers/' + s.id, { method: 'DELETE' }); await showScorers(); }, 'Scorer removed');
            } }, 'Remove')))))
        : h('div', { class: 'empty' }, 'No scorers yet. Add one for each court or volunteer.'));
  }

  /* ----------------------------- tournament page ----------------------------- */

  async function loadTournament(id) {
    const [t, matches, standings] = await Promise.all([api('/tournaments/' + id), api(`/tournaments/${id}/matches`), api(`/tournaments/${id}/standings`)]);
    S.t = t;
    S.matches = matches;
    S.standings = standings;
    S.draftStages = t.stages.map((s) => ({ ...s }));
  }

  async function openTournament(id, tab) {
    S.view = 'tournament';
    S.tab = tab || 'matches';
    try {
      await loadTournament(id);
    } catch (e) {
      toast(e.message, true);
      location.hash = '#/';
      return;
    }
    if (S.tab === 'setup' && !isAdmin()) S.tab = 'matches';
    openStream(id);
    render();
  }

  async function reload() {
    await loadTournament(S.t.id);
    render();
    refreshMatchModal(true);
  }

  const enabledStages = () => S.t.stages.filter((s) => s.enabled).sort((a, b) => a.order - b.order);
  const hasGroupStage = () => S.standings.some((tb) => enabledStages().some((s) => s.key === tb.stageKey));
  const hasBracket = () => enabledStages().some((s) => s.kind === 'knockout' && S.matches.some((m) => m.stageKey === s.key));

  function tournamentView() {
    const t = S.t;
    const tabs = [['matches', 'Matches']];
    if (hasBracket()) tabs.push(['draw', 'Draw']);
    tabs.push(['schedule', 'Schedule']);
    if (hasGroupStage()) tabs.push(['standings', 'Standings']);
    if (isAdmin()) tabs.push(['setup', 'Setup']);
    if (!tabs.some(([k]) => k === S.tab)) S.tab = 'matches';

    const tools = isAdmin()
      ? h('div', { class: 't-tools' },
          h('select', { 'aria-label': 'Tournament status', value: t.status, onchange: (e) => act(async () => { await api('/tournaments/' + t.id, { method: 'PUT', body: { status: e.target.value } }); await reload(); }) },
            Object.entries(statusLabel).map(([v, l]) => h('option', { value: v }, l))),
          h('button', { class: 'btn ghost small', onclick: () => {
            const n = prompt('Tournament name', t.name);
            if (n && n.trim()) act(async () => { await api('/tournaments/' + t.id, { method: 'PUT', body: { name: n } }); await reload(); });
          } }, 'Rename'),
          h('button', { class: 'btn danger small', onclick: () => {
            if (confirm(`Delete "${t.name}" with all its players and matches? This cannot be undone.`)) {
              act(async () => { await api('/tournaments/' + t.id, { method: 'DELETE' }); location.hash = '#/'; }, 'Tournament deleted');
            }
          } }, 'Delete'))
      : null;

    const downloads = h('div', { class: 'downloads' },
      h('span', { class: 'sub' }, 'Download:'),
      h('a', { href: `/api/tournaments/${t.id}/results.csv`, download: true }, 'Results (CSV)'),
      hasGroupStage() ? h('a', { href: `/api/tournaments/${t.id}/standings.csv`, download: true }, 'Standings (CSV)') : null,
      isAdmin() ? h('button', { class: 'linklike', onclick: () => act(() => downloadWithAuth(`/tournaments/${t.id}/backup.json`, 'backup.json'), 'Backup downloaded') }, 'Full backup (JSON)') : null);

    return h('main', { class: 'wrap' },
      h('a', { class: 'back', href: '#/' }, '← All tournaments'),
      h('div', { class: 't-head' },
        h('div', {}, h('h1', {}, t.name), h('p', { class: 'sub' }, `${typeLabel(t)} tournament, ${t.entries.length} ${unitLabel(t, t.entries.length)}, ${statusLabel[t.status].toLowerCase()}`)),
        tools),
      h('nav', { class: 'tabs', 'aria-label': 'Tournament sections' },
        tabs.map(([k, l]) => h('a', { class: 'tab' + (S.tab === k ? ' on' : ''), href: `#/t/${t.id}/${k}`, 'aria-current': S.tab === k ? 'page' : null }, l))),
      h('div', { id: 'pane' }, paneContent()),
      downloads);
  }

  function paneContent() {
    if (S.tab === 'standings') return standingsPane();
    if (S.tab === 'draw') return drawPane();
    if (S.tab === 'schedule') return schedulePane();
    if (S.tab === 'setup' && isAdmin()) return setupPane();
    return matchesPane();
  }

  function refreshPane() {
    const pane = document.getElementById('pane');
    if (pane && S.tab !== 'setup') fill(pane, paneContent());
  }

  /* ----------------------------- matches tab ----------------------------- */

  function matchCard(m) {
    return h('div', {},
      h('button', { class: 'match', type: 'button', onclick: () => openMatch(m.id), 'aria-label': `${sideLabel(m, 'a')} versus ${sideLabel(m, 'b')}, open match` }, scoreboard(m)),
      h('div', { class: 'match-meta' }, [m.number && stageOf(m.stageKey).kind === 'knockout' ? `Match ${m.number}` : '', Scoring.formatLabel(m.format)].filter(Boolean).join('. ')));
  }

  function matchesPane() {
    const stages = enabledStages();
    if (!stages.length) return h('div', { class: 'empty' }, isAdmin() ? 'All stages are switched off. Turn at least one on in Setup.' : 'The format for this tournament has not been set yet.');
    return h('div', {},
      !S.matches.length ? h('div', { class: 'empty', style: 'margin-bottom:1.25rem' }, isAdmin() ? 'No fixtures yet. Add players, then generate fixtures in Setup.' : 'Fixtures have not been published yet.') : null,
      stages.map((stage) => {
        const ms = S.matches.filter((m) => m.stageKey === stage.key);
        if (!ms.length) return null;
        const groups = [...new Set(ms.map((m) => m.group))];
        return h('section', { class: 'stage' },
          h('h2', {}, stage.name),
          groups.map((g) => h('div', {}, g ? h('div', { class: 'group-name' }, g) : null,
            h('div', { class: 'match-grid' }, ms.filter((m) => m.group === g).map(matchCard)))));
      }));
  }

  /* ----------------------------- draw (bracket) tab ----------------------------- */

  function drawPane() {
    const rounds = enabledStages()
      .filter((s) => s.kind === 'knockout')
      .map((s) => ({ stage: s, ms: S.matches.filter((m) => m.stageKey === s.key) }))
      .filter((r) => r.ms.length);
    if (!rounds.length) return h('div', { class: 'empty' }, 'The knockout draw appears here once it is made.');
    return h('div', { class: 'bracket-wrap' },
      h('div', { class: 'bracket' }, rounds.map((r, i) =>
        h('section', { class: 'round' + (i === rounds.length - 1 ? ' last' : '') },
          h('h3', { class: 'round-name' }, r.stage.name),
          h('div', { class: 'round-matches' }, r.ms.map((m) =>
            h('div', { class: 'bm' },
              h('button', { class: 'match', type: 'button', onclick: () => openMatch(m.id), 'aria-label': `${r.stage.name} match ${m.number}: ${sideLabel(m, 'a')} versus ${sideLabel(m, 'b')}` }, scoreboard(m, 'mini')))))))),
      h('p', { class: 'hint' }, 'Winners move into the next round automatically.', h('span', { class: 'phone-only' }, ' Swipe sideways to see later rounds.')));
  }

  /* ----------------------------- schedule tab ----------------------------- */

  function schedulePane() {
    const f = S.schedFilter;
    const involves = (m) => !f.entry || (m.sideA && m.sideA.id === f.entry) || (m.sideB && m.sideB.id === f.entry);
    const list = S.matches.filter((m) => !m.isBye && involves(m) && !(f.hideDone && m.status === 'completed'));
    const timed = list.filter((m) => ISO_TIME.test(m.scheduledAt)).sort((x, y) => x.scheduledAt.localeCompare(y.scheduledAt) || (x.court || '').localeCompare(y.court || ''));
    const other = list.filter((m) => !ISO_TIME.test(m.scheduledAt));

    const days = new Map();
    timed.forEach((m) => {
      const key = m.scheduledAt.slice(0, 10);
      if (!days.has(key)) days.set(key, []);
      days.get(key).push(m);
    });

    const row = (m, time) => {
      const status = m.status === 'live' ? h('span', { class: 'badge live' }, 'Live') : m.status === 'completed' ? h('span', { class: 'sched-score' }, m.walkover ? 'W/O' : Scoring.scoreline(m.state)) : null;
      return h('button', { class: 'sched-row', type: 'button', onclick: () => openMatch(m.id) },
        h('span', { class: 'sched-time' }, time),
        h('span', { class: 'sched-court' }, m.court || ''),
        h('span', { class: 'sched-match' },
          h('span', { class: 'sched-stage' }, matchTitle(m)),
          h('span', {}, h('span', { class: m.winnerSide === 'a' ? 'won' : '' }, sideLabel(m, 'a')), h('span', { class: 'vs' }, ' vs '), h('span', { class: m.winnerSide === 'b' ? 'won' : '' }, sideLabel(m, 'b')))),
        h('span', { class: 'sched-status' }, status));
    };

    const filters = h('div', { class: 'row sched-filters' },
      field(S.t.type === 'singles' ? 'Show matches for' : 'Show matches for team',
        h('select', { value: f.entry, onchange: (e) => { f.entry = e.target.value; refreshPane(); } },
          h('option', { value: '' }, 'Everyone'), S.t.entries.map((e) => h('option', { value: e._id }, e.name)))),
      h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: f.hideDone, onchange: (e) => { f.hideDone = e.target.checked; refreshPane(); } }), 'Hide finished matches'));

    const sections = [];
    days.forEach((ms, day) => {
      const d = new Date(day + 'T12:00');
      sections.push(h('section', { class: 'stage' },
        h('h2', {}, d.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })),
        h('div', { class: 'sched' }, ms.map((m) => row(m, new Date(m.scheduledAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }))))));
    });
    const withText = other.filter((m) => m.scheduledAt || m.court);
    const unscheduled = other.filter((m) => !m.scheduledAt && !m.court && m.status !== 'completed');
    if (withText.length) sections.push(h('section', { class: 'stage' }, h('h2', {}, 'Other times'), h('div', { class: 'sched' }, withText.map((m) => row(m, m.scheduledAt)))));
    if (unscheduled.length) sections.push(h('section', { class: 'stage' }, h('h2', {}, 'Not scheduled yet'), h('div', { class: 'sched' }, unscheduled.map((m) => row(m, '')))));

    return h('div', {}, filters,
      sections.length ? sections : h('div', { class: 'empty' }, f.entry || f.hideDone ? 'No matches match these filters.' : isAdmin() ? 'Give matches a court and time under "Edit fixture" to build the order of play.' : 'The order of play has not been published yet.'));
  }

  /* ----------------------------- standings tab ----------------------------- */

  const ordinal = (n) => (n === 1 ? 'winner' : n === 2 ? 'runner-up' : `${n}${n === 3 ? 'rd' : 'th'} place`);
  const placeLabel = (group, rank) => `${group} ${ordinal(rank)}`;
  const promotedRank = (tb, entryId) => Number(Object.keys(tb.promoted || {}).find((k) => tb.promoted[k] === entryId)) || null;

  // Group positions that go through: the ones the next stage takes, or the top two before it is built.
  function qualifyingRanks(tb) {
    const ranks = [...new Set(tb.feeds.map((f) => f.rank))];
    return ranks.length ? ranks : [1, 2].filter((r) => r <= tb.rows.length);
  }

  // Who is going through (so far): promoted entries, then the rest in standings order.
  function qualifiers(tb) {
    const promoted = Object.values(tb.promoted || {});
    const rest = tb.rows.map((r) => r.entryId).filter((id) => !promoted.includes(id));
    return new Set(qualifyingRanks(tb).map((rank) => tb.promoted[rank] || rest.shift()));
  }

  // Admin: choose who goes through in each qualifying position of a group (Auto = final standings).
  // Unconfirmed picks, per group: { rank: entryId | '' } (kept across live refreshes).
  const promoDrafts = {};
  const promoOpen = new Set(); // groups whose promote section the admin has opened

  function promotePanel(tb) {
    const ranks = qualifyingRanks(tb);
    const key = [S.t.id, tb.stageKey, tb.group].join('|');
    const draft = promoDrafts[key] || {};
    const nameOf = (id) => (tb.rows.find((r) => r.entryId === id) || {}).name;
    const current = (rank) => tb.promoted[rank] || '';
    const pick = (rank) => (rank in draft ? draft[rank] : current(rank));
    const changes = ranks.filter((rank) => pick(rank) !== current(rank));
    const twice = ranks.map(pick).filter(Boolean).some((id, i, all) => all.indexOf(id) !== i);
    const redraw = () => refreshPane();
    const confirmPicks = () => act(async () => {
      const picks = Object.fromEntries(changes.map((rank) => [rank, pick(rank) || null]));
      await api(`/tournaments/${S.t.id}/promotions`, { method: 'PUT', body: { stageKey: tb.stageKey, group: tb.group, picks } });
      delete promoDrafts[key];
      await reload();
    }, 'Promotion confirmed');
    return h('details', { class: 'promote panel', open: promoOpen.has(key) || Object.keys(tb.promoted).length > 0 || changes.length > 0,
      ontoggle: (e) => { if (e.target.open) promoOpen.add(key); else promoOpen.delete(key); } },
      h('summary', {}, 'Promote to the next stage'),
      ranks.map((rank) => {
        const feeds = tb.feeds.filter((f) => f.rank === rank).map((f) => f.match).join(', ');
        const auto = !current(rank) && tb.placings[rank - 1] ? `Auto: ${nameOf(tb.placings[rank - 1])}` : 'Auto: from the final standings';
        const id = `promo-${tb.stageKey}-${tb.group}-${rank}`.replace(/\s+/g, '-');
        return h('div', { class: 'field' + (changes.includes(rank) ? ' changed' : '') },
          h('label', { for: id }, placeLabel(tb.group, rank), feeds ? h('span', { class: 'sub' }, ` → ${feeds}`) : null),
          h('select', { id, onchange: (e) => { promoDrafts[key] = { ...draft, [rank]: e.target.value }; redraw(); } },
            h('option', { value: '' }, auto),
            tb.rows.map((r) => h('option', { value: r.entryId, selected: r.entryId === pick(rank) }, r.name))));
      }),
      changes.length
        ? h('div', { class: 'promo-confirm' },
            h('p', {}, 'To confirm: ', changes.map((rank, i) => [i ? '; ' : '', h('b', {}, pick(rank) ? nameOf(pick(rank)) : 'Auto'), ` as ${placeLabel(tb.group, rank)}`]), '.'),
            twice ? h('p', { class: 'err' }, 'The same player or team is picked for two positions.') : null,
            h('div', { class: 'btn-row' },
              h('button', { class: 'btn', disabled: twice, onclick: confirmPicks }, 'Confirm promotion'),
              h('button', { class: 'btn ghost', onclick: () => { delete promoDrafts[key]; redraw(); } }, 'Cancel')))
        : null,
      h('p', { class: 'hint' }, tb.feeds.length
        ? 'Pick who goes through in each position, then press Confirm promotion: they fill their next-stage slot straight away, even before the group finishes. Positions left on Auto follow the final standings (skipping anyone promoted).'
        : 'The next stage is not built from this group yet. Confirmed picks are kept and fill the slots once you generate the next stage from group qualifiers in Setup.'));
  }

  const pctLabel = (v) => (v == null ? '–' : `${Math.round(v)}%`);

  function standingsPane() {
    const tables = S.standings.filter((s) => enabledStages().some((e) => e.key === s.stageKey));
    if (!tables.length) return h('div', { class: 'empty' }, 'Standings appear once group fixtures are created.');
    return h('div', {}, tables.map((tb) =>
      h('section', { class: 'stage' },
        h('h2', {}, tb.group, ' ', tb.stageName !== 'Group Stage' ? h('span', { class: 'sub' }, tb.stageName) : null, tb.complete ? h('span', { class: 'badge', style: 'margin-left:.5rem' }, 'Complete') : null),
        h('div', { class: 'table-wrap' }, h('table', { class: 'standings' },
          h('thead', {}, h('tr', {}, ['#', S.t.type === 'singles' ? 'Player' : 'Team', 'P', 'W', 'L', 'Pts', 'Sets', 'Set%', 'Games', 'Game%'].map((x) => h('th', { scope: 'col', title: { Pts: 'Points: 2 per win', 'Set%': 'Share of sets won', 'Game%': 'Share of games won' }[x] || null },
            x, ['Sets', 'Games'].includes(x) ? h('span', { class: 'th-sub' }, 'W-L') : null)))),
          h('tbody', {}, tb.rows.map((r) => h('tr', { class: qualifiers(tb).has(r.entryId) ? 'q' : '' },
            h('td', {}, r.rank), h('td', { class: 'name' }, r.name, r.h2h ? h('span', { class: 'h2h', title: 'Placed by head-to-head result' }, 'H2H') : null,
              promotedRank(tb, r.entryId) ? h('span', { class: 'promo-tag', title: 'Promoted to the next stage by the admin' }, `Promoted: ${placeLabel(tb.group, promotedRank(tb, r.entryId))}`) : null),
            h('td', {}, r.played), h('td', {}, r.won), h('td', {}, r.lost), h('td', { class: 'pts' }, r.points),
            h('td', {}, `${r.setsFor}-${r.setsAgainst}`), h('td', {}, pctLabel(r.setPct)),
            h('td', {}, `${r.gamesFor}-${r.gamesAgainst}`), h('td', {}, pctLabel(r.gamePct))))))),
        isAdmin() ? promotePanel(tb) : null)),
      h('p', { class: 'hint phone-only' }, 'Swipe a table sideways to see all columns.'),
      h('p', { class: 'hint' }, 'Pts: 2 points per win. Set% and Game%: share of sets and games won. Ranked by points (wins). When two are level, their head-to-head result decides (marked H2H); three or more level are split by set difference, then game difference. Those going through to the next stage are highlighted.'));
  }

  /* ----------------------------- match modal ----------------------------- */

  function openMatch(id) {
    const m = S.matches.find((x) => x.id === id);
    if (!m) return;
    const d = modal(`${sideLabel(m, 'a')} vs ${sideLabel(m, 'b')}`, '', true);
    const live = h('div');
    const score = h('div');
    const details = h('div');
    // prep (toss + serve) and controls hold forms: a live update leaves them alone while being edited.
    const prep = h('div', { oninput: markDirty });
    const controls = h('div', { oninput: markDirty });
    const stats = h('div');
    d.body.append(live, prep, score, details, controls, stats);
    S.matchDlg = { dialog: d.dialog, body: d.body, live, prep, score, details, controls, stats, id, dirty: false };
    renderMatchModal(true);
  }

  // full = also rebuild the controls (after your own actions); otherwise only the live score part.
  function refreshMatchModal(full) {
    if (!S.matchDlg) return;
    if (!S.matches.some((m) => m.id === S.matchDlg.id)) { S.matchDlg.dialog.close(); return; }
    renderMatchModal(full);
  }

  function applyMatchUpdate(m) {
    const i = S.matches.findIndex((x) => x.id === m.id);
    if (i >= 0) S.matches[i] = m;
    refreshPane();
    renderMatchModal(true);
  }

  function renderMatchModal(full) {
    if (!S.matchDlg) return;
    const m = S.matches.find((x) => x.id === S.matchDlg.id);
    if (!m) return;
    const { dialog, body, live, prep, score, details, controls, stats } = S.matchDlg;
    dialog.querySelector('.modal-head h2').textContent = `${sideLabel(m, 'a')} vs ${sideLabel(m, 'b')}`;
    fill(live, 
      h('p', { class: 'sub', style: 'margin:0 0 .6rem' }, [matchTitle(m), whenLabel(m.scheduledAt), m.court].filter(Boolean).join(', ')),
      scoreboard(m, 'big'),
      m.startedAt ? h('p', { class: 'match-clock' }, m.endedAt ? 'Match time: ' : 'Match time (running): ', matchClock(m)) : null,
      courtInfo(m));
    fill(score, ...(canScore() ? scoreControls(m) : []));
    fill(details,
      tossSummary(m),
      h('p', { class: 'hint' }, Scoring.formatLabel(m.format)),
      m.notes ? h('p', {}, m.notes) : null);
    // Stats stay at the end; the old table is kept until the new one arrives so the page doesn't jump.
    if (m.pointsPlayed > 0) loadStats(m, stats);
    else fill(stats);
    // Before the first point the toss and serve come first; once play starts, the score buttons do.
    const started = isUnderway(m) || m.manual || m.walkover || m.status === 'completed';
    if (started ? prep.nextSibling !== details : prep.nextSibling !== score) body.insertBefore(prep, started ? details : score);
    if (full || !S.matchDlg.dirty) {
      S.matchDlg.dirty = false;
      fill(prep, ...(canScore() ? prepControls(m, started) : []));
      fill(controls, ...(canScore() ? matchControls(m) : []));
    }
  }

  async function loadStats(m, box) {
    let s;
    try { s = await api(`/matches/${m.id}/stats`); } catch { return; }
    if (!s || !s.available) return;
    const a = s.a;
    const b = s.b;
    const pct = (x, y) => (y ? `${x}/${y} (${Math.round((100 * x) / y)}%)` : '–');
    const rows = [['Points won', a.pointsWon, b.pointsWon], ['Longest run of points', a.longestRun, b.longestRun]];
    if (s.hasServe) {
      rows.push(
        ['Service points won', pct(a.servePointsWon, a.servePoints), pct(b.servePointsWon, b.servePoints)],
        ['Return points won', pct(a.returnPointsWon, a.returnPoints), pct(b.returnPointsWon, b.returnPoints)],
        ['Service games held', pct(a.serviceGamesHeld, a.serviceGames), pct(b.serviceGamesHeld, b.serviceGames)],
        ['Break points converted', pct(a.breaks, a.breakPointChances), pct(b.breaks, b.breakPointChances)],
        ['Break points saved', pct(a.breakPointsSaved, a.breakPointsFaced), pct(b.breakPointsSaved, b.breakPointsFaced)]);
    }
    fill(box, 
      h('div', { class: 'section-title' }, 'Match stats'),
      h('div', { class: 'table-wrap' }, h('table', { class: 'stats' },
        h('thead', {}, h('tr', {}, h('th', { scope: 'col' }, sideLabel(m, 'a')), h('th', { scope: 'col' }, ''), h('th', { scope: 'col' }, sideLabel(m, 'b')))),
        h('tbody', {}, rows.map(([label, x, y]) => h('tr', {}, h('td', {}, String(x)), h('td', { class: 'stat-label' }, label), h('td', {}, String(y))))))),
      s.hasServe ? null : h('p', { class: 'hint' }, 'Set who serves first to see serve and break-point stats.'),
      ...(s.tiebreaks || []).map((tb) => tiebreakTable(m, tb)));
  }

  // Point by point: who served from which court, who received, and the ends.
  function tiebreakTable(m, tb) {
    const endName = m.toss && m.toss.end;
    const cols = ['#', 'Server', 'Receiver', 'Score'];
    const rows = [];
    // Who is at the named end only changes at a change of ends, so it is shown on those rows.
    const endRow = (p, text) => h('tr', { class: 'change' }, h('td', { colspan: cols.length },
      text, endName && p.atEnd ? h('span', { class: 'court-tag' }, `${sideOf(m, p.atEnd).name} at the ${endName}`) : null));
    tb.points.forEach((p, i) => {
      if (p.changeEnds) rows.push(endRow(p, 'Change ends'));
      else if (i === 0 && endName && p.atEnd) rows.push(endRow(p, 'Start'));
      rows.push(h('tr', {},
        h('td', {}, String(p.n)),
        h('td', {}, playerShort(m, p.server), p.server ? h('span', { class: 'court-tag' }, p.court === 'deuce' ? 'Deuce court' : 'Ad court') : null),
        h('td', {}, playerShort(m, p.receiver)),
        h('td', { class: 'score' }, p.won === 'a' ? h('b', {}, String(p.score.a)) : String(p.score.a), '-', p.won === 'b' ? h('b', {}, String(p.score.b)) : String(p.score.b))));
    });
    return h('div', {},
      h('div', { class: 'section-title' }, tb.mtb ? 'Match tie-breaker' : `Set ${tb.set} tie-breaker`),
      h('div', { class: 'table-wrap' }, h('table', { class: 'tb-points' },
        h('thead', {}, h('tr', {}, cols.map((c) => h('th', { scope: 'col' }, c)))),
        h('tbody', {}, rows))),
      h('p', { class: 'hint' }, `Score is ${m.sideA.name} first, after the point; the point winner's score is in bold.`));
  }

// Started with "Start match" (or scored before that button existed).
  const isUnderway = (m) => !!m.startedAt || m.pointsPlayed > 0;

  function scoreControls(m) {
    const call = (path, body, ok) => act(async () => applyMatchUpdate(await api(`/matches/${m.id}/${path}`, { method: 'POST', body })), ok);
    const out = [];
    const ready = m.sideA && m.sideB && !m.isBye;

    out.push(h('div', { class: 'section-title' }, 'Score'));
    if (ready && m.status !== 'completed' && !isUnderway(m)) {
      out.push(h('button', { class: 'btn start-btn', onclick: () => call('start', undefined, 'Match started') }, 'Start match'),
        h('p', { class: 'hint' }, 'Point scoring opens once the match is started. Record the coin toss and the serve first. The match clock starts now.'));
    } else if (ready && m.status !== 'completed') {
      out.push(h('div', { class: 'point-btns' },
        h('button', { class: 'btn', onclick: () => call('point', { side: 'a' }) }, `Point: ${m.sideA.name}`),
        h('button', { class: 'btn', onclick: () => call('point', { side: 'b' }) }, `Point: ${m.sideB.name}`)));
    } else if (m.status === 'completed') {
      out.push(h('p', {}, `Match finished. Winner: ${sideLabel(m, m.winnerSide)}.`));
    } else out.push(h('p', { class: 'hint' }, m.isBye ? 'This is a bye, so there is nothing to score.' : 'Scoring opens when both sides are known.'));
    out.push(h('div', { class: 'btn-row' },
      h('button', { class: 'btn ghost small', disabled: !m.pointsPlayed || m.walkover || m.manual, onclick: () => call('undo') }, 'Undo last point'),
      h('button', { class: 'btn ghost small', disabled: m.isBye || (!m.pointsPlayed && !m.walkover && !m.manual && !m.startedAt), onclick: () => { if (confirm('Reset this match to not started? The score and match clock are cleared.')) call('reset', undefined, 'Score reset'); } }, 'Reset score'),
      isAdmin() && ready && !m.walkover && m.status !== 'completed'
        ? [h('button', { class: 'btn ghost small', onclick: () => { if (confirm(`Award a walkover to ${m.sideA.name}?`)) call('walkover', { side: 'a' }); } }, `Walkover to ${m.sideA.name}`),
           h('button', { class: 'btn ghost small', onclick: () => { if (confirm(`Award a walkover to ${m.sideB.name}?`)) call('walkover', { side: 'b' }); } }, `Walkover to ${m.sideB.name}`)]
        : null));
    return out;
  }

  // Coin toss (before the first point) and serve settings.
  function prepControls(m, started) {
    const out = [];
    if (!m.sideA || !m.sideB || m.isBye) return out;
    if (!started) {
      out.push(h('div', { class: 'section-title' }, 'Coin toss'), tossEditor(m));
    } else if (!m.toss && m.status !== 'completed') {
      out.push(h('p', { class: 'hint' }, 'No coin toss was recorded for this match. The toss can only be recorded before the match starts: reset the match to record it.'));
    }
    if (m.status !== 'completed') out.push(h('div', { class: 'section-title' }, 'Serve'), serveEditor(m));
    return out;
  }

  function matchControls(m) {
    const out = [];
    const ready = m.sideA && m.sideB && !m.isBye;

    if (ready) {
      out.push(h('div', { class: 'section-title' }, 'Enter final score'));
      out.push(resultEditor(m));
    }
    if (!isAdmin()) return out;

    out.push(h('div', { class: 'section-title' }, 'Match format'));
    out.push(formatEditor(m.format, {
      locked: m.pointsPlayed > 0 || m.manual,
      lockedMsg: 'Scoring has started. Reset the score to change the format.',
      saveLabel: 'Save match format',
      onSave: (fmt) => act(async () => applyMatchUpdate(await api('/matches/' + m.id, { method: 'PUT', body: { format: fmt } })), 'Match format saved'),
    }));

    out.push(h('div', { class: 'section-title' }, 'Edit fixture'));
    out.push(fixtureForm(m, (updated) => { applyMatchUpdate(updated); reload(); }));
    return out;
  }

  // Keep a half-filled form when a live update re-renders the match dialog.
  function markDirty() { if (S.matchDlg) S.matchDlg.dirty = true; }

  // Doubles: which player of each team serves first, and which receives in the deuce court.
  function serveOrderPicker(m, order, onChange) {
    const pick = (side, key, label) => h('div', { class: 'step' }, h('label', {}, `${side.name}: ${label}`),
      seg([[1, side.player1 || 'Player 1'], [2, side.player2 || 'Player 2']], order[key], (v) => { order[key] = v; markDirty(); onChange(); }));
    return [
      pick(m.sideA, 'aFirst', 'who serves first'), pick(m.sideA, 'aDeuce', 'who receives in the deuce court'),
      pick(m.sideB, 'bFirst', 'who serves first'), pick(m.sideB, 'bDeuce', 'who receives in the deuce court'),
    ];
  }

  function tossSummary(m) {
    const t = m.toss;
    if (!t) return null;
    let o;
    try { o = Scoring.tossOutcome(t); } catch { return null; }
    const name = (k) => sideOf(m, k).name;
    const pickLabel = (p) => (p === 'serve' ? 'to serve or receive' : 'the end');
    const first = t.choice === 'defer'
      ? `${name(t.winner)} won the toss and deferred; ${name(o.chooser)} chose ${pickLabel(o.pick)}.`
      : `${name(t.winner)} won the toss and chose ${pickLabel(o.pick)}.`;
    const serve = `${name(o.serveChooser)} chose to ${t.decision} first.`;
    const end = t.end ? `${name(o.endChooser)} chose to start at the ${t.end}.` : `${name(o.endChooser)} chose the end.`;
    return h('p', { class: 'hint' }, `Toss: ${first} ${serve} ${end}`);
  }

  function tossEditor(m) {
    const t = m.toss || {};
    const d = { winner: t.winner || null, choice: t.choice || null, deferredChoice: t.deferredChoice || null, decision: t.decision || null };
    // keep an end typed in before the dropdown existed
    const endChoices = COURT_ENDS.includes(t.end) || !t.end ? COURT_ENDS : [...COURT_ENDS, t.end];
    const endInput = h('select', {},
      h('option', { value: '' }, 'Not recorded'),
      endChoices.map((e) => h('option', { value: e, selected: e === t.end }, e)));
    const err = h('p', { class: 'err', role: 'alert' });
    const box = h('div');
    const set = (k, v) => { d[k] = v; markDirty(); draw(); };
    const other = (k) => (k === 'a' ? 'b' : 'a');
    const name = (k) => sideOf(m, k).name;
    const picks = [['serve', 'Serve or receive'], ['end', 'The end']];

    function draw() {
      const parts = [h('div', { class: 'step' }, h('label', {}, 'Won the toss'), seg([['a', m.sideA.name], ['b', m.sideB.name]], d.winner, (v) => set('winner', v)))];
      if (d.winner) {
        parts.push(h('div', { class: 'step' }, h('label', {}, `${name(d.winner)} chose`),
          seg([...picks, ['defer', `Let ${name(other(d.winner))} choose`]], d.choice, (v) => set('choice', v))));
      }
      const chooser = d.choice === 'defer' ? other(d.winner) : d.winner;
      if (d.winner && d.choice === 'defer') {
        parts.push(h('div', { class: 'step' }, h('label', {}, `${name(chooser)} chose`), seg(picks, d.deferredChoice, (v) => set('deferredChoice', v))));
      }
      const pick = d.choice === 'defer' ? d.deferredChoice : d.choice;
      if (d.winner && pick) {
        const serveChooser = pick === 'serve' ? chooser : other(chooser);
        const serveStep = h('div', { class: 'step' }, h('label', {}, `${name(serveChooser)} chose to`),
          seg([['serve', 'Serve first'], ['receive', 'Receive first']], d.decision, (v) => set('decision', v)));
        const endStep = field(`${name(other(serveChooser))}: starting end`, endInput);
        parts.push(...(pick === 'serve' ? [serveStep, endStep] : [endStep, serveStep]));
      }
      let ready = true;
      try { Scoring.tossOutcome(d); } catch { ready = false; }
      parts.push(err, h('div', { class: 'btn-row' }, h('button', { class: 'btn small', disabled: !ready, onclick: async () => {
        err.textContent = '';
        try {
          applyMatchUpdate(await api(`/matches/${m.id}/toss`, { method: 'POST', body: { ...d, end: endInput.value } }));
          toast('Toss saved');
        } catch (e) { err.textContent = e.message; }
      } }, m.toss ? 'Save toss again' : 'Save toss')));
      parts.push(h('p', { class: 'hint' }, 'Saving the toss sets who serves first. It can be changed until the first point.'));
      fill(box, ...parts);
    }
    draw();
    return box;
  }

  function serveEditor(m) {
    const sv = m.serve || { first: null, aFirst: 1, bFirst: 1, sets: [] };
    const save = (patch, ok) => act(async () => applyMatchUpdate(await api(`/matches/${m.id}/serve`, { method: 'POST', body: { ...sv, ...patch } })), ok);
    const parts = [h('div', { class: 'step' }, h('label', {}, m.toss ? 'Serves first (from the toss)' : 'Serves first'),
      seg([['a', m.sideA.name], ['b', m.sideB.name]], sv.first, (v) => save({ first: v })))];
    if (S.t.type === 'doubles') parts.push(serveOrderEditor(m, sv, save));
    parts.push(h('p', { class: 'hint' }, sv.first
      ? 'The server is worked out from the score: it changes every game, and in a tie-breaker after the first point and then every two points. Fix the choices here if they were set wrong.'
      : 'Choose who serves first to show the server during the match and record serve stats.'));
    return h('div', {}, parts);
  }

  // Doubles serving order for the set in progress. Each team may change its order at the start of a set.
  function serveOrderEditor(m, sv, save) {
    const st = m.state || Scoring.newState();
    const cur = Scoring.serveOrder(st, sv);
    const keys = ['aFirst', 'bFirst', 'aDeuce', 'bDeuce'];
    const order = Object.fromEntries(keys.map((k) => [k, cur[k]]));
    const label = st.mode === 'matchtb' ? 'match tie-breaker' : `set ${cur.set}`;
    const box = h('div');
    function draw() {
      const changed = keys.some((k) => order[k] !== cur[k]);
      fill(box,
        h('p', { class: 'step', style: 'font-weight:600' }, `Serving and receiving order, ${label}`),
        ...serveOrderPicker(m, order, draw),
        h('div', { class: 'btn-row' }, h('button', { class: 'btn small', disabled: !changed && (cur.set === 1 || cur.chosen), onclick: () => save(cur.set === 1
          ? { ...order }
          : { sets: [...(sv.sets || []).filter((o) => o.set !== cur.set), { set: cur.set, ...order }] }, 'Serving order saved') }, 'Save serving order')),
        h('p', { class: 'hint' }, cur.set === 1
          ? 'Each team can change who serves first and who receives in which court at the start of each set.'
          : cur.chosen ? `Saved for ${label}.` : `Carried on from the previous set. Save to keep it, or change it for ${label}.`));
    }
    draw();
    return box;
  }

  function resultEditor(m) {
    const f = m.format;
    const tbScore = f.games === 4 ? '4-3' : '7-6';
    const existing = (m.state && m.state.sets) || [];
    const labels = ['Set 1', 'Set 2', f.setsMode === 'best3' ? 'Set 3' : 'Match tie-breaker'];
    const num = (v, label) => h('input', { type: 'number', min: 0, max: 99, inputmode: 'numeric', value: v === undefined ? '' : v, 'aria-label': label });
    const rows = labels.map((label, i) => {
      const s = existing[i];
      return {
        label,
        a: num(s ? s.a : undefined, `${label}, ${m.sideA.name}`),
        b: num(s ? s.b : undefined, `${label}, ${m.sideB.name}`),
        tb: i === 2 && f.setsMode !== 'best3' ? null : num(s && s.tb ? Math.min(s.tb.a, s.tb.b) : undefined, `${label}, tie-breaker points of the set loser`),
      };
    });
    const err = h('p', { class: 'err', role: 'alert' });
    return h('div', {},
      h('div', { class: 'res-grid' },
        h('span', {}), h('span', { class: 'res-head' }, m.sideA.name), h('span', { class: 'res-head' }, m.sideB.name), h('span', { class: 'res-head' }, 'Tie-break'),
        rows.map((r) => [h('span', { class: 'res-label' }, r.label), r.a, r.b, r.tb || h('span')])),
      h('p', { class: 'hint' }, `Leave unused rows empty. Tie-break is optional: for a ${tbScore} set, enter the loser's tie-breaker points (5 for ${tbScore}(5)).`),
      err,
      h('div', { class: 'btn-row' }, h('button', { class: 'btn small', onclick: async () => {
        err.textContent = '';
        if ((m.pointsPlayed > 0 || m.walkover) && !confirm('This replaces the current score of this match. Continue?')) return;
        try {
          applyMatchUpdate(await api(`/matches/${m.id}/result`, { method: 'POST', body: { sets: rows.map((r) => ({ a: r.a.value, b: r.b.value, tbLoser: r.tb ? r.tb.value : '' })) } }));
          toast('Final score saved');
          reload();
        } catch (e) { err.textContent = e.message; }
      } }, 'Save final score')));
  }

  function formatEditor(initial, opts) {
    const fmt = { ...initial };
    const box = h('div');
    function draw() {
      const tb = fmt.games === 4 ? '3-3' : '6-6';
      fill(box, 
        h('div', { class: 'step' }, h('label', {}, 'Games per set'), seg([[4, 'Fast 4'], [6, 'Regular 6']], fmt.games, (v) => { fmt.games = v; draw(); }, opts.locked)),
        h('div', { class: 'step' }, h('label', {}, 'Scoring'), seg([['ad', 'With Ad'], ['noad', 'No Ad']], fmt.scoring, (v) => { fmt.scoring = v; draw(); }, opts.locked)),
        h('div', { class: 'step' }, h('label', {}, 'Sets'),
          seg([['best3', 'Best of 3 sets'], ['best2_mtb10', 'Best of 2 sets + 10-point match tie-breaker']], fmt.setsMode, (v) => { fmt.setsMode = v; draw(); }, opts.locked)),
        h('p', { class: 'hint' }, `At ${tb} in games a 7-point set tie-breaker is played (win by 2).` +
          (fmt.setsMode === 'best2_mtb10' ? ' At one set each, a 10-point match tie-breaker (win by 2) decides the match.' : '')),
        opts.locked ? h('p', { class: 'hint' }, opts.lockedMsg) : null,
        h('div', { class: 'btn-row' },
          h('button', { class: 'btn small', disabled: opts.locked, onclick: () => opts.onSave({ ...fmt }) }, opts.saveLabel),
          opts.extra ? opts.extra(() => ({ ...fmt })) : null));
    }
    draw();
    return box;
  }

  function fixtureForm(m, onDone, createOpts) {
    const t = S.t;
    const entryOpts = (sel, label) => [h('option', { value: '' }, label || 'TBD'), ...t.entries.map((e) => h('option', { value: e._id, selected: sel === e._id }, e.name))];
    const stageSel = h('select', {}, enabledStages().map((s) => h('option', { value: s.key, selected: (m ? m.stageKey : createOpts.stageKey) === s.key }, s.name)));
    const locked = !!m && (m.pointsPlayed > 0 || m.manual);
    const a = h('select', { disabled: locked }, entryOpts(m && m.sideA ? m.sideA.id : '', m && m.sideALabel));
    const b = h('select', { disabled: locked }, entryOpts(m && m.sideB ? m.sideB.id : '', m && m.sideBLabel));
    const group = h('input', { type: 'text', maxlength: 30, value: m ? m.group : createOpts.group || '', placeholder: 'e.g. Group A' });
    const court = h('input', { type: 'text', maxlength: 40, value: m ? m.court : '', placeholder: 'Court 1' });
    const old = m ? m.scheduledAt : '';
    const when = old && !ISO_TIME.test(old)
      ? h('input', { type: 'text', maxlength: 60, value: old })
      : h('input', { type: 'datetime-local', value: old ? old.slice(0, 16) : '' });
    const notes = h('input', { type: 'text', maxlength: 300, value: m ? m.notes : '' });
    const body = () => {
      const out = { stageKey: stageSel.value, group: group.value, court: court.value, scheduledAt: when.value, notes: notes.value };
      // Only send sides that were changed, so bracket links stay in place.
      if (!m || a.value !== (m.sideA ? m.sideA.id : '')) out.sideA = a.value || null;
      if (!m || b.value !== (m.sideB ? m.sideB.id : '')) out.sideB = b.value || null;
      return out;
    };
    const linked = m && (m.sideALabel || m.sideBLabel) && !m.isBye;
    return h('div', {},
      h('div', { class: 'row' }, field('Stage', stageSel), field('Group (group stages)', group)),
      h('div', { class: 'row', style: 'margin-top:.75rem' }, field(t.type === 'singles' ? 'Player A' : 'Team A', a), field(t.type === 'singles' ? 'Player B' : 'Team B', b)),
      locked ? h('p', { class: 'hint' }, 'Players are locked while a score exists. Reset the score to change them.') : null,
      linked ? h('p', { class: 'hint' }, 'Open slots fill in automatically from earlier results. Picking a player here replaces that link.') : null,
      h('div', { class: 'row', style: 'margin-top:.75rem' }, field('Court', court), field('Date and time', when, old && !ISO_TIME.test(old) ? 'Clear this to switch to a date picker.' : null)),
      h('div', { style: 'margin-top:.75rem' }, field('Notes', notes)),
      h('div', { class: 'btn-row' },
        h('button', { class: 'btn small', onclick: () => act(async () => {
          const res = m ? await api('/matches/' + m.id, { method: 'PUT', body: body() }) : await api(`/tournaments/${t.id}/matches`, { method: 'POST', body: body() });
          onDone(res);
        }, m ? 'Fixture saved' : 'Match added') }, m ? 'Save fixture' : 'Add match'),
        m ? h('button', { class: 'btn danger small', onclick: () => {
          if (confirm('Delete this match?')) act(async () => { await api('/matches/' + m.id, { method: 'DELETE' }); if (S.matchDlg) S.matchDlg.dialog.close(); await reload(); }, 'Match deleted');
        } }, 'Delete match') : null));
  }

  /* ----------------------------- setup tab ----------------------------- */

  function setupPane() {
    return h('div', {}, setupPlayers(), setupFormat(), setupFixtures());
  }

  function setupPlayers() {
    const t = S.t;
    const single = t.type === 'singles';
    const sec = h('section', { class: 'setup-sec panel' });
    const name = h('input', { type: 'text', maxlength: 80, placeholder: single ? 'Player name' : 'Team name (optional)' });
    const p1 = h('input', { type: 'text', maxlength: 60, placeholder: 'Player 1' });
    const p2 = h('input', { type: 'text', maxlength: 60, placeholder: 'Player 2' });
    const bulk = h('textarea', { rows: 5, placeholder: single ? 'One player per line' : 'One team per line, like: Asha / Priya' });

    const add = (entries) => act(async () => { await api(`/tournaments/${t.id}/entries`, { method: 'POST', body: { entries } }); await reload(); });
    const saveOrder = (ids) => act(async () => { await api(`/tournaments/${t.id}/entries/order`, { method: 'PUT', body: { ids } }); await reload(); });
    const ids = t.entries.map((e) => e._id);
    const move = (from, to) => {
      if (to < 0 || to >= ids.length || from === to) return;
      const next = [...ids];
      next.splice(to, 0, next.splice(from, 1)[0]);
      saveOrder(next);
    };
    let dragFrom = null;

    sec.append(
      h('h2', {}, '1. Add ' + (single ? 'players' : 'teams')),
      h('form', { class: 'row', onsubmit: (e) => { e.preventDefault(); add([single ? { name: name.value } : { name: name.value, player1: p1.value, player2: p2.value }]); } },
        single ? field('Player', name) : [field('Player 1', p1), field('Player 2', p2), field('Team name', name)],
        h('button', { class: 'btn', type: 'submit', style: 'margin-bottom:0' }, 'Add')),
      h('details', { style: 'margin-top:.75rem' }, h('summary', {}, 'Add many at once'),
        h('div', { style: 'margin-top:.5rem' }, bulk),
        h('button', { class: 'btn small', style: 'margin-top:.5rem', onclick: () => {
          const lines = bulk.value.split('\n').map((l) => l.trim()).filter(Boolean);
          if (!lines.length) return;
          add(lines.map((l) => { if (single) return { name: l }; const [x, y] = l.split('/').map((s) => s.trim()); return { player1: x, player2: y }; }));
        } }, 'Add all')),
      t.entries.length
        ? h('div', {}, h('p', { class: 'hint', style: 'margin-top:.9rem' }, 'Seeding: number 1 is the top seed. Drag the list or use the arrows. Draws in "seeded order" use this list, and top seeds get any byes.'),
           h('ol', { class: 'list seeds' }, t.entries.map((e, i) => h('li', {
             draggable: 'true',
             ondragstart: (ev) => { dragFrom = i; ev.dataTransfer.effectAllowed = 'move'; ev.currentTarget.classList.add('dragging'); },
             ondragend: (ev) => ev.currentTarget.classList.remove('dragging'),
             ondragover: (ev) => { ev.preventDefault(); ev.currentTarget.classList.add('drop'); },
             ondragleave: (ev) => ev.currentTarget.classList.remove('drop'),
             ondrop: (ev) => { ev.preventDefault(); ev.currentTarget.classList.remove('drop'); if (dragFrom !== null) move(dragFrom, i); dragFrom = null; },
           },
            h('span', { class: 'seed-name' }, h('span', { class: 'grip', 'aria-hidden': 'true' }, '⋮⋮'), h('span', { class: 'seed-no' }, String(i + 1)), e.name,
              !single && e.name !== `${e.player1} / ${e.player2}` ? h('span', { class: 'sub' }, ` (${e.player1} / ${e.player2})`) : null),
            h('span', { class: 'btn-row', style: 'margin:0' },
              h('button', { class: 'btn ghost small', disabled: i === 0, 'aria-label': `Move ${e.name} up`, onclick: () => move(i, i - 1) }, '↑'),
              h('button', { class: 'btn ghost small', disabled: i === t.entries.length - 1, 'aria-label': `Move ${e.name} down`, onclick: () => move(i, i + 1) }, '↓'),
              h('button', { class: 'btn ghost small', onclick: () => {
                if (single) {
                  const n = prompt('Player name', e.name);
                  if (n && n.trim()) act(async () => { await api(`/tournaments/${t.id}/entries/${e._id}`, { method: 'PUT', body: { name: n } }); await reload(); });
                } else {
                  const x = prompt('Player 1', e.player1); if (!x) return;
                  const y = prompt('Player 2', e.player2); if (!y) return;
                  const team = prompt('Team name (leave blank to use both names)', e.name === `${e.player1} / ${e.player2}` ? '' : e.name) || '';
                  act(async () => { await api(`/tournaments/${t.id}/entries/${e._id}`, { method: 'PUT', body: { name: team, player1: x, player2: y } }); await reload(); });
                }
              } }, 'Edit'),
              h('button', { class: 'btn danger small', onclick: () => { if (confirm(`Remove ${e.name}?`)) act(async () => { await api(`/tournaments/${t.id}/entries/${e._id}`, { method: 'DELETE' }); await reload(); }); } }, 'Remove'))))))
        : h('p', { class: 'hint' }, 'Nobody added yet.'));
    return sec;
  }

  function setupFormat() {
    const t = S.t;
    const sec = h('section', { class: 'setup-sec panel' });
    const list = h('div');
    const kindOpts = [['group', 'Group stage'], ['knockout', 'Knockout']];

    function drawStages() {
      const newName = h('input', { type: 'text', maxlength: 60, placeholder: 'New stage, e.g. Plate Final' });
      let newKind = 'knockout';
      const kindBox = h('span');
      const drawKind = () => fill(kindBox, seg(kindOpts, newKind, (v) => { newKind = v; drawKind(); }));
      drawKind();
      fill(list, 
        ...S.draftStages.map((s, i) => h('div', { class: 'stage-row' + (s.enabled ? '' : ' off') },
          h('input', { type: 'checkbox', checked: s.enabled, 'aria-label': `Include ${s.name}`, onchange: (e) => { s.enabled = e.target.checked; drawStages(); } }),
          h('input', { type: 'text', value: s.name, maxlength: 60, 'aria-label': 'Stage name', onchange: (e) => { s.name = e.target.value; } }),
          h('select', { 'aria-label': 'Stage type', value: s.kind, onchange: (e) => { s.kind = e.target.value; } }, kindOpts.map(([v, l]) => h('option', { value: v }, l))),
          h('span', { class: 'btn-row', style: 'margin:0' },
            h('button', { class: 'btn ghost small', disabled: i === 0, 'aria-label': 'Move up', onclick: () => { [S.draftStages[i - 1], S.draftStages[i]] = [S.draftStages[i], S.draftStages[i - 1]]; drawStages(); } }, '↑'),
            h('button', { class: 'btn ghost small', disabled: i === S.draftStages.length - 1, 'aria-label': 'Move down', onclick: () => { [S.draftStages[i + 1], S.draftStages[i]] = [S.draftStages[i], S.draftStages[i + 1]]; drawStages(); } }, '↓'),
            h('button', { class: 'btn danger small', 'aria-label': `Remove ${s.name}`, onclick: () => { S.draftStages.splice(i, 1); drawStages(); } }, 'Remove')))),
        h('div', { class: 'row', style: 'margin-top:.9rem' }, field('Add a stage', newName), h('div', { class: 'field', style: 'flex:0 0 auto' }, h('label', {}, 'Type'), kindBox),
          h('button', { class: 'btn ghost', onclick: () => { if (newName.value.trim()) { S.draftStages.push({ key: null, name: newName.value.trim(), kind: newKind, enabled: true }); drawStages(); } } }, 'Add stage')),
        h('div', { class: 'btn-row' }, h('button', { class: 'btn', onclick: () => act(async () => { await api(`/tournaments/${t.id}/stages`, { method: 'PUT', body: { stages: S.draftStages } }); await reload(); }, 'Stages saved') }, 'Save stages')));
    }
    drawStages();

    sec.append(
      h('h2', {}, '2. Tournament format'),
      h('p', { class: 'hint', style: 'margin:0 0 .5rem' }, 'Tick the stages this tournament uses and untick any you want to skip. Order sets the sequence of play.'),
      list,
      h('div', { class: 'section-title' }, 'Default match format'),
      h('p', { class: 'hint', style: 'margin:0 0 .5rem' }, 'New fixtures start with this format. You can still change the format of any individual match.'),
      formatEditor(t.defaultFormat, {
        saveLabel: 'Save default',
        onSave: (fmt) => act(async () => { await api('/tournaments/' + t.id, { method: 'PUT', body: { defaultFormat: fmt } }); await reload(); }, 'Default format saved'),
        extra: (get) => h('button', { class: 'btn ghost small', onclick: () => {
          if (confirm('Apply this format to every match that has not started yet?')) {
            act(async () => { const r = await api(`/tournaments/${t.id}/apply-format`, { method: 'POST', body: { format: get() } }); await reload(); toast(`Updated ${r.updated} unstarted matches`); });
          }
        } }, 'Apply to all unstarted matches'),
      }));
    return sec;
  }

  function setupFixtures() {
    const t = S.t;
    const sec = h('section', { class: 'setup-sec' }, h('h2', {}, '3. Fixtures'));
    const stages = enabledStages();
    if (t.entries.length < 2) sec.append(h('div', { class: 'empty' }, 'Add at least two players or teams to build fixtures.'));
    else if (!stages.length) sec.append(h('div', { class: 'empty' }, 'No stages are switched on.'));

    stages.forEach((stage, idx) => {
      const ms = S.matches.filter((m) => m.stageKey === stage.key);
      const prev = stages[idx - 1];
      const following = [];
      if (stage.kind === 'knockout') for (let i = idx + 1; i < stages.length && stages[i].kind === 'knockout'; i++) following.push(stages[i]);
      const opts = { groupsCount: 2, draw: 'listed', source: prev ? 'previous' : 'entries', qualifiers: 2, chain: true };
      const ctl = h('div');
      const drawCtl = () => {
        const parts = [];
        if (stage.kind === 'group') {
          parts.push(field('Number of groups', h('input', { type: 'number', min: 1, max: Math.max(1, Math.floor(t.entries.length / 2)), value: opts.groupsCount, onchange: (e) => { opts.groupsCount = Number(e.target.value); } })));
          parts.push(field('Draw', h('select', { value: opts.draw, onchange: (e) => { opts.draw = e.target.value; } }, [h('option', { value: 'listed' }, 'Seeded order (snake)'), h('option', { value: 'random' }, 'Random draw')])));
        } else {
          parts.push(field('Who plays here', h('select', { value: opts.source, onchange: (e) => { opts.source = e.target.value; drawCtl(); } },
            [h('option', { value: 'entries' }, 'All entries'), prev ? h('option', { value: 'previous' }, prev.kind === 'group' ? `Qualifiers from ${prev.name}` : `Winners of ${prev.name}`) : null])));
          if (opts.source === 'entries') parts.push(field('Draw', h('select', { value: opts.draw, onchange: (e) => { opts.draw = e.target.value; } }, [h('option', { value: 'listed' }, 'Seeded order'), h('option', { value: 'random' }, 'Random draw')])));
          if (opts.source === 'previous' && prev && prev.kind === 'group') parts.push(field('Qualifiers per group', h('input', { type: 'number', min: 1, max: 8, value: opts.qualifiers, onchange: (e) => { opts.qualifiers = Number(e.target.value); } })));
        }
        const replaced = S.matches.filter((m) => m.stageKey === stage.key || (opts.chain && following.some((f) => f.key === m.stageKey))).length;
        fill(ctl, 
          h('div', { class: 'row' }, parts,
            h('button', { class: 'btn', style: 'flex:0 0 auto', disabled: t.entries.length < 2, onclick: () => {
              if (replaced && !confirm(`Replace the ${replaced} existing fixtures in this part of the draw?`)) return;
              act(async () => { await api(`/tournaments/${t.id}/fixtures/generate`, { method: 'POST', body: { stageKey: stage.key, ...opts } }); await reload(); }, 'Fixtures generated');
            } }, ms.length ? 'Regenerate fixtures' : 'Generate fixtures')),
          following.length
            ? h('label', { class: 'check', style: 'margin-top:.6rem' }, h('input', { type: 'checkbox', checked: opts.chain, onchange: (e) => { opts.chain = e.target.checked; drawCtl(); } }),
                `Also build ${following.map((f) => f.name).join(' and ')}, with winners moving through automatically`)
            : null);
      };
      drawCtl();

      sec.append(h('div', { class: 'panel' },
        h('h3', {}, stage.name, h('span', { class: 'sub', style: 'font:400 .9rem Public Sans,sans-serif;margin-left:.6rem' }, stage.kind === 'group' ? 'Round robin in groups' : 'Knockout')),
        h('div', { style: 'margin-top:.6rem' }, ctl),
        stage.kind === 'knockout' ? h('p', { class: 'hint' }, 'You can build the knockout before earlier stages finish: open slots fill in as results come in. Draws that are not a power of two give byes to the top seeds.') : null,
        ms.length
          ? h('div', { style: 'margin-top:.6rem' }, ms.map((m) => h('div', { class: 'fx-row' },
              h('span', {}, m.group ? h('span', { class: 'sub' }, m.group + ': ') : stage.kind === 'knockout' ? h('span', { class: 'sub' }, `${m.number}. `) : null,
                sideLabel(m, 'a'), h('span', { class: 'vs' }, 'vs'), sideLabel(m, 'b'),
                m.status !== 'scheduled' && !m.isBye ? h('span', { class: 'badge' + (m.status === 'live' ? ' live' : ''), style: 'margin-left:.5rem' }, m.status === 'live' ? 'Live' : m.walkover ? 'W/O' : Scoring.scoreline(m.state) || 'Done') : null,
                m.scheduledAt || m.court ? h('span', { class: 'sub' }, '  ' + [whenLabel(m.scheduledAt), m.court].filter(Boolean).join(', ')) : null),
              h('button', { class: 'btn ghost small', onclick: () => openMatch(m.id) }, 'Edit'))))
          : h('p', { class: 'hint' }, 'No fixtures in this stage yet.'),
        h('div', { class: 'btn-row' }, h('button', { class: 'btn ghost small', onclick: () => {
          const d = modal(`Add match to ${stage.name}`, '');
          fill(d.body, fixtureForm(null, async () => { d.dialog.close(); await reload(); }, { stageKey: stage.key }));
        } }, 'Add a match manually'))));
    });
    return sec;
  }

  /* ----------------------------- live updates ----------------------------- */

  let refreshTimer = null;
  let lastSync = 0;

  function closeStream() {
    if (S.es) { S.es.close(); S.es = null; }
  }

  function openStream(id) {
    closeStream();
    if (!window.EventSource) return;
    const es = new EventSource(`/api/tournaments/${id}/events`);
    es.addEventListener('change', (ev) => {
      let data = {};
      try { data = JSON.parse(ev.data); } catch { /* ignore */ }
      if (data.deleted) {
        toast('This tournament was deleted.');
        location.hash = '#/';
        return;
      }
      clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => syncLive(!data.match), 250);
    });
    S.es = es;
  }

  // Pull fresh scores. Setup is left alone so half-typed changes aren't lost.
  async function syncLive(includeTournament) {
    if (S.view !== 'tournament' || !S.t) return;
    const id = S.t.id;
    try {
      const [matches, standings, t] = await Promise.all([
        api(`/tournaments/${id}/matches`), api(`/tournaments/${id}/standings`), includeTournament ? api('/tournaments/' + id) : null]);
      if (!S.t || S.t.id !== id) return;
      S.matches = matches;
      S.standings = standings;
      lastSync = Date.now();
      if (t && S.tab !== 'setup') {
        S.t = t;
        S.draftStages = t.stages.map((s) => ({ ...s }));
        render();
      } else refreshPane();
      refreshMatchModal(false);
    } catch { /* ignore transient errors */ }
  }

  // Safety net if the live connection drops (e.g. a proxy closes it).
  setInterval(() => {
    if (document.hidden || S.view !== 'tournament') return;
    const streaming = S.es && S.es.readyState === 1;
    if (!streaming || Date.now() - lastSync > 60000) syncLive(false);
  }, 30000);

  /* ----------------------------- shell + routing ----------------------------- */

  function headerBar() {
    return h('header', { class: 'top' },
      h('a', { href: '#/', class: 'brand' }, h('span', { class: 'ball' }), 'AO Tennis Score Tracker'),
      h('div', { class: 'top-right' },
        S.role
          ? [isAdmin() ? h('a', { class: 'top-link', href: '#/scorers' }, 'Scorers') : null,
             h('span', { class: 'chip' }, isAdmin() ? 'Admin' : `Scorer: ${S.user}`),
             h('button', { class: 'btn ghost small', onclick: () => signOut(false) }, 'Sign out')]
          : h('button', { class: 'btn ghost small', onclick: openLogin }, 'Sign in')));
  }

  function render() {
    const view = S.view === 'list' ? listView() : S.view === 'scorers' ? scorersView() : tournamentView();
    fill(root, headerBar(), view);
  }

  function route() {
    const [, p1, id, tab] = location.hash.split('/');
    if (p1 === 't' && id) {
      if (S.t && S.t.id === id && S.view === 'tournament') {
        S.tab = tab === 'setup' && !isAdmin() ? 'matches' : tab || 'matches';
        render();
      } else openTournament(id, tab);
    } else if (p1 === 'scorers') showScorers();
    else showList();
  }
  window.addEventListener('hashchange', route);

  (async function init() {
    if (S.token) {
      try {
        const me = await api('/auth/me');
        S.role = me.role;
        S.user = me.name;
      } catch {
        S.token = '';
        localStorage.removeItem('tt_token');
      }
    }
    route();
  })();
})();
