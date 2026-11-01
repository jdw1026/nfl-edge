/* NFL Edge — app: fetch Polymarket + ESPN, run the scanner, render. */
(function () {
  'use strict';
  const L = window.NFLEdgeLogic;
  const $ = (s, el) => (el || document).querySelector(s);
  const $$ = (s, el) => Array.from((el || document).querySelectorAll(s));

  const ESPN_SB = 'https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard';
  const ESPN_INJ = 'https://site.api.espn.com/apis/site/v2/sports/football/nfl/injuries';
  const GAMMA = 'https://gamma-api.polymarket.com';
  const RELAYS = [
    u => 'https://corsproxy.io/?url=' + encodeURIComponent(u),
    u => 'https://api.allorigins.win/raw?url=' + encodeURIComponent(u)
  ];

  const DEFAULTS = { minEdgeML: 2.0, minEdgeSpread: 2.0, minEdgeTotal: 2.0, minEdgeProp: 1.5, minLiquidity: 200,
    consistencyPts: 1.5, useRelays: true, includeFinal: false, showAll: false, scope: 'week' };
  const state = { settings: loadSettings(), games: [], flags: [], status: {}, lastRun: null, tab: 'edges', filter: 'all', transport: null };

  function loadSettings() {
    try { return Object.assign({}, DEFAULTS, JSON.parse(localStorage.getItem('nfledge.settings') || '{}')); } catch (e) { return Object.assign({}, DEFAULTS); }
  }
  function saveSettings() { try { localStorage.setItem('nfledge.settings', JSON.stringify(state.settings)); } catch (e) {} }

  // ---------- fetch with CORS-relay fallback ----------
  async function fetchJSON(url, { timeout = 15000, allowRelay = true } = {}) {
    const attempts = [u => u].concat(allowRelay && state.settings.useRelays ? RELAYS : []);
    let lastErr = null;
    for (let i = 0; i < attempts.length; i++) {
      const target = attempts[i](url);
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), timeout);
      try {
        const r = await fetch(target, { signal: ctrl.signal, headers: { 'accept': 'application/json' } });
        clearTimeout(t);
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const j = await r.json();
        return { data: j, via: i === 0 ? 'direct' : ('relay' + i) };
      } catch (e) { clearTimeout(t); lastErr = e; }
    }
    throw lastErr || new Error('fetch failed');
  }
  async function mapLimit(items, limit, fn) {
    const out = new Array(items.length); let i = 0;
    async function worker() { while (i < items.length) { const k = i++; try { out[k] = { ok: true, value: await fn(items[k], k) }; } catch (e) { out[k] = { ok: false, error: e }; } } }
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
    return out;
  }

  // ---------- main scan ----------
  async function runScan() {
    const btn = $('#scanBtn'); btn.disabled = true; btn.textContent = 'Scanning…';
    state.status = { espn: 'loading', inj: 'loading', poly: 'loading', games: 0, markets: 0, props: 0, polyOk: 0, polyMiss: 0 };
    renderStatus();
    let sb = null, inj = null;
    try {
      let url = ESPN_SB;
      if (state.settings.scope === 'today') {
        const d = new Date(); const ymd = d.getFullYear() + String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0');
        url += '?dates=' + ymd;
      }
      const r = await fetchJSON(url); sb = r.data; state.status.espn = 'ok (' + r.via + ')';
    } catch (e) { state.status.espn = 'failed: ' + (e.message || e); }
    try { const r = await fetchJSON(ESPN_INJ); inj = r.data; state.status.inj = 'ok'; } catch (e) { state.status.inj = 'failed'; }
    renderStatus();
    if (!sb) { finish(); return; }

    const injuries = L.buildInjuryIndex(inj);
    let games = L.gamesFromScoreboard(sb);
    if (!state.settings.includeFinal) games = games.filter(g => g.status !== 'post');
    state.status.games = games.length;
    const opts = {
      minEdgeML: state.settings.minEdgeML / 100, minEdgeSpread: state.settings.minEdgeSpread / 100,
      minEdgeTotal: state.settings.minEdgeTotal / 100, minEdgeProp: state.settings.minEdgeProp / 100,
      minLiquidity: Number(state.settings.minLiquidity) || 0, consistencyPts: Number(state.settings.consistencyPts) || 1
    };
    let via = null;
    const results = await mapLimit(games, 4, async (g) => {
      const [main, props] = await Promise.all([
        fetchJSON(`${GAMMA}/events?slug=${g.slug}`).catch(e => ({ data: [], err: e })),
        fetchJSON(`${GAMMA}/events?slug=${g.propsSlug}`).catch(e => ({ data: [], err: e }))
      ]);
      via = via || main.via || props.via;
      const ev = Array.isArray(main.data) ? main.data[0] : null;
      const pev = Array.isArray(props.data) ? props.data[0] : null;
      g.polyFound = !!ev; g.propsFound = !!pev; g.polyErr = main.err ? String(main.err.message || main.err) : null;
      if (ev && ev.slug) g.slug = ev.slug;
      if (pev && pev.slug) g.propsSlug = pev.slug;
      const markets = ev ? (ev.markets || []) : [];
      const pmarkets = pev ? (pev.markets || []) : [];
      const live = g.status === 'in';
      const book = live ? null : g.book;   // don't compare in-play prices to pregame book lines
      const res = L.scanGame(g, markets, pmarkets, book, injuries, opts);
      g.scan = res; g.live = live;
      return res;
    });
    let flags = [];
    results.forEach((r, i) => {
      const g = games[i];
      if (r.ok) { flags = flags.concat(r.value.flags); state.status.markets += r.value.counts.markets; state.status.props += r.value.counts.props; if (g.polyFound) state.status.polyOk++; else state.status.polyMiss++; }
      else { g.polyErr = String(r.error && r.error.message || r.error); state.status.polyMiss++; }
    });
    state.transport = via;
    state.status.poly = state.status.polyOk ? `ok (${via || 'direct'})` : (games.length ? 'no markets found' : 'n/a');
    flags.sort((a, b) => (b.net ?? 0) - (a.net ?? 0));
    state.games = games; state.flags = flags; state.lastRun = new Date();
    finish();
    function finish() { btn.disabled = false; btn.textContent = 'Scan now'; renderStatus(); render(); }
  }

  // ---------- rendering ----------
  const KIND_LABEL = { ML: 'Moneyline', SPREAD: 'Spread', TOTAL: 'Total', PROP: 'Prop · ruled out', SUBSET: 'Prop · subset', ARB: 'Arb', LADDER: 'Ladder', CONSIST: 'Consistency' };
  const KIND_CLASS = { ML: 'k-ml', SPREAD: 'k-sp', TOTAL: 'k-tot', PROP: 'k-prop', SUBSET: 'k-prop', ARB: 'k-arb', LADDER: 'k-cons', CONSIST: 'k-cons' };
  function esc(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
  function pts(x) { return x == null ? '—' : (x >= 0 ? '+' : '') + (x * 100).toFixed(1); }
  function c(x) { return x == null ? '—' : Math.round(x * 100) + '¢'; }
  function kickoffFmt(iso) {
    try { return new Intl.DateTimeFormat(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' }).format(new Date(iso)); } catch (e) { return ''; }
  }
  function renderStatus() {
    const s = state.status;
    const bits = [];
    bits.push(`<span class="chip ${/ok/.test(s.espn || '') ? 'ok' : (/fail/.test(s.espn || '') ? 'bad' : '')}">ESPN/DK ${esc(s.espn || '')}</span>`);
    bits.push(`<span class="chip ${/ok/.test(s.inj || '') ? 'ok' : (/fail/.test(s.inj || '') ? 'bad' : '')}">Injuries ${esc(s.inj || '')}</span>`);
    bits.push(`<span class="chip ${/ok/.test(s.poly || '') ? 'ok' : (/no|fail/.test(s.poly || '') ? 'bad' : '')}">Polymarket ${esc(s.poly || '')}</span>`);
    if (s.games) bits.push(`<span class="chip">${s.games} games · ${s.markets} markets · ${s.props} props</span>`);
    if (state.lastRun) bits.push(`<span class="chip">updated ${new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(state.lastRun)}</span>`);
    $('#status').innerHTML = bits.join('');
  }
  function render() {
    $$('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === state.tab));
    $$('.pane').forEach(p => p.classList.toggle('active', p.id === 'pane-' + state.tab));
    renderEdges(); renderGames(); renderProps(); renderSettings();
  }
  function flagCard(f) {
    const evPct = f.ev != null ? ` · EV ${(f.ev * 100).toFixed(0)}%` : '';
    return `<article class="card ${KIND_CLASS[f.kind] || ''}">
      <div class="row1"><span class="kind">${esc(KIND_LABEL[f.kind] || f.kind)}</span><span class="edge">${pts(f.net)} pts</span></div>
      <div class="title">${esc(f.title)}</div>
      <div class="meta">${esc(f.game)} · ${esc(kickoffFmt(f.kickoff))}</div>
      <div class="buy">Buy: <b>${esc(f.buy)}</b>${f.ask != null ? (f.kind === 'ARB' ? ` · total cost <b>${c(f.ask)}</b>` : ` @ <b>${c(f.ask)}</b>`) : ''}${f.fair != null && f.kind !== 'ARB' ? ` · fair ${c(f.fair)}` : ''}${evPct}</div>
      <div class="why">${esc(f.why)}</div>
      <div class="foot"><span>liquidity $${Math.round(f.liquidity || 0).toLocaleString()}</span><a href="${esc(f.link)}" target="_blank" rel="noopener">Open on Polymarket ↗</a></div>
    </article>`;
  }
  function renderEdges() {
    const el = $('#edges');
    const filt = state.filter;
    let list = state.flags;
    if (filt === 'lines') list = list.filter(f => ['ML', 'SPREAD', 'TOTAL'].includes(f.kind));
    if (filt === 'props') list = list.filter(f => ['PROP', 'SUBSET'].includes(f.kind));
    if (filt === 'struct') list = list.filter(f => ['ARB', 'LADDER', 'CONSIST'].includes(f.kind));
    $$('.filt').forEach(b => b.classList.toggle('active', b.dataset.f === filt));
    if (!state.lastRun) { el.innerHTML = `<div class="empty">Tap <b>Scan now</b> to pull live Polymarket books and compare them to DraftKings lines (via ESPN) and the injury report.</div>`; return; }
    if (!list.length) { el.innerHTML = `<div class="empty">No edges above your thresholds right now. Lower them in Settings or rescan closer to kickoff — Polymarket tends to lag the books on late news.</div>`; return; }
    el.innerHTML = list.map(flagCard).join('');
  }
  function renderGames() {
    const el = $('#games');
    if (!state.games.length) { el.innerHTML = `<div class="empty">No games loaded yet.</div>`; return; }
    el.innerHTML = state.games.map(g => {
      const b = g.book || {}, r = (g.scan && g.scan.rows) || { ml: null, spreads: [], totals: [] };
      const ml = r.ml;
      const rowsHtml = [];
      if (ml) rowsHtml.push(`<tr><td>ML ${esc(g.home.nick)}</td><td>${c(ml.askHome)}</td><td>${ml.fairHome != null ? c(ml.fairHome) : '—'}</td><td class="${cls(ml.fairHome, ml.askHome)}">${ml.fairHome != null ? pts(ml.fairHome - ml.askHome) : '—'}</td></tr>
        <tr><td>ML ${esc(g.away.nick)}</td><td>${c(ml.askAway)}</td><td>${ml.fairAway != null ? c(ml.fairAway) : '—'}</td><td class="${cls(ml.fairAway, ml.askAway)}">${ml.fairAway != null ? pts(ml.fairAway - ml.askAway) : '—'}</td></tr>`);
      const sp = r.spreads.slice().sort((a, b) => Math.abs(Math.abs(a.fair0 - 0.5)) - Math.abs(Math.abs(b.fair0 - 0.5)));
      const spShow = state.settings.showAll ? sp : sp.slice(0, 2);
      for (const s of spShow) rowsHtml.push(`<tr><td>${esc(s.label)}</td><td>${c(s.ask0)}</td><td>${c(s.fair0)}</td><td class="${cls(s.fair0, s.ask0)}">${pts(s.fair0 - s.ask0)}</td></tr>
        <tr><td>${esc(s.oppLabel)}</td><td>${c(s.ask1)}</td><td>${c(s.fair1)}</td><td class="${cls(s.fair1, s.ask1)}">${pts(s.fair1 - s.ask1)}</td></tr>`);
      const tt = r.totals.slice().sort((a, b) => Math.abs(a.fairOver - 0.5) - Math.abs(b.fairOver - 0.5));
      const ttShow = state.settings.showAll ? tt : tt.slice(0, 1);
      for (const t of ttShow) rowsHtml.push(`<tr><td>Over ${t.line}</td><td>${c(t.askOver)}</td><td>${c(t.fairOver)}</td><td class="${cls(t.fairOver, t.askOver)}">${pts(t.fairOver - t.askOver)}</td></tr>
        <tr><td>Under ${t.line}</td><td>${c(t.askUnder)}</td><td>${c(t.fairUnder)}</td><td class="${cls(t.fairUnder, t.askUnder)}">${pts(t.fairUnder - t.askUnder)}</td></tr>`);
      const bookLine = b.spread ? `${esc(g.home.abbr)} ${b.spread.homeLine > 0 ? '+' : ''}${b.spread.homeLine} (${esc(b.spread.homeOdds || '')}/${esc(b.spread.awayOdds || '')})` : 'no line';
      const bookML = b.ml ? `ML ${esc(b.ml.homeOdds)} / ${esc(b.ml.awayOdds)}` : '';
      const bookTot = b.total ? `O/U ${b.total.line}` : '';
      const polyNote = g.polyFound ? '' : `<div class="warn">No Polymarket event found for slug <code>${esc(g.slug)}</code>${g.polyErr ? ' — ' + esc(g.polyErr) : ''}</div>`;
      const liveNote = g.live ? `<div class="warn">Live game — book comparison off (pregame lines), props/consistency still on.</div>` : '';
      const mus = g.scan ? `<div class="mus">Implied ${esc(g.home.nick)} line — Poly ML: ${g.scan.polyMuML != null ? L.fmtLine(-g.scan.polyMuML) : '—'} · Poly spreads: ${g.scan.polyMuSpread != null ? L.fmtLine(-g.scan.polyMuSpread) : '—'} · ${esc(b.provider || 'Book')}: ${g.scan.bookMu != null ? L.fmtLine(-g.scan.bookMu) : '—'}</div>` : '';
      return `<article class="game">
        <div class="ghead"><div><b>${esc(g.away.nick)} @ ${esc(g.home.nick)}</b><div class="meta">${esc(kickoffFmt(g.kickoff))}${g.status === 'in' ? ' · LIVE' : ''}${g.status === 'post' ? ' · Final' : ''}</div></div>
          <div class="book"><div>${esc(b.provider || 'Book')}: ${bookLine}</div><div>${bookML} ${bookTot}</div></div></div>
        ${polyNote}${liveNote}${mus}
        ${rowsHtml.length ? `<table><thead><tr><th>Market</th><th>Poly ask</th><th>Fair</th><th>Edge</th></tr></thead><tbody>${rowsHtml.join('')}</tbody></table>` : ''}
        <div class="foot"><a href="https://polymarket.com/event/${esc(g.slug)}" target="_blank" rel="noopener">Game markets ↗</a>${g.propsFound ? `<a href="https://polymarket.com/event/${esc(g.propsSlug)}" target="_blank" rel="noopener">Player props ↗</a>` : ''}</div>
      </article>`;
    }).join('');
    function cls(fair, ask) { if (fair == null || ask == null) return ''; const d = fair - ask; return d >= 0.02 ? 'pos' : (d <= -0.02 ? 'neg' : ''); }
  }
  function renderProps() {
    const el = $('#props');
    const list = state.flags.filter(f => ['PROP', 'SUBSET'].includes(f.kind) || (f.kind === 'ARB' && /Yes bid/.test(f.title)));
    if (!state.lastRun) { el.innerHTML = `<div class="empty">Scan first. This tab lists player-prop markets where a ruled-out player's "No"/"Under" is still priced below $1, and First-TD / 2+-TD markets priced inconsistently with Anytime TD.</div>`; return; }
    if (!list.length) { el.innerHTML = `<div class="empty">No prop mispricings above threshold. Inactives drop ~90 min before kickoff — rescan then.</div>`; return; }
    el.innerHTML = list.map(flagCard).join('');
  }
  function renderSettings() {
    const s = state.settings;
    for (const k of ['minEdgeML', 'minEdgeSpread', 'minEdgeTotal', 'minEdgeProp', 'minLiquidity', 'consistencyPts']) { const i = $('#' + k); if (i && document.activeElement !== i) i.value = s[k]; }
    $('#useRelays').checked = !!s.useRelays; $('#includeFinal').checked = !!s.includeFinal; $('#showAll').checked = !!s.showAll;
    $$('input[name=scope]').forEach(r => r.checked = r.value === s.scope);
  }

  // ---------- wiring ----------
  function wire() {
    $('#scanBtn').addEventListener('click', () => runScan().catch(e => { state.status.poly = 'error: ' + (e.message || e); renderStatus(); $('#scanBtn').disabled = false; $('#scanBtn').textContent = 'Scan now'; }));
    $$('.tab').forEach(t => t.addEventListener('click', () => { state.tab = t.dataset.tab; render(); }));
    $$('.filt').forEach(b => b.addEventListener('click', () => { state.filter = b.dataset.f; renderEdges(); }));
    for (const k of ['minEdgeML', 'minEdgeSpread', 'minEdgeTotal', 'minEdgeProp', 'minLiquidity', 'consistencyPts']) {
      $('#' + k).addEventListener('change', e => { state.settings[k] = Number(e.target.value); saveSettings(); });
    }
    $('#useRelays').addEventListener('change', e => { state.settings.useRelays = e.target.checked; saveSettings(); });
    $('#includeFinal').addEventListener('change', e => { state.settings.includeFinal = e.target.checked; saveSettings(); });
    $('#showAll').addEventListener('change', e => { state.settings.showAll = e.target.checked; saveSettings(); renderGames(); });
    $$('input[name=scope]').forEach(r => r.addEventListener('change', e => { if (e.target.checked) { state.settings.scope = e.target.value; saveSettings(); } }));
    $('#rescanAfter').addEventListener('click', () => { state.tab = 'edges'; render(); runScan(); });
    render(); renderStatus();
  }
  document.addEventListener('DOMContentLoaded', wire);
  window.NFLEdgeApp = { state, runScan };
})();
