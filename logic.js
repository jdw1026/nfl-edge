/* NFL Edge — pure pricing/mispricing logic. No DOM, no fetch.
   Works in the browser (window.NFLEdgeLogic) and in Node (module.exports). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.NFLEdgeLogic = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ---------- odds helpers ----------
  function impliedFromAmerican(odds) {
    const o = Number(String(odds).replace('+', ''));
    if (!isFinite(o) || o === 0) return null;
    return o < 0 ? (-o) / ((-o) + 100) : 100 / (o + 100);
  }
  function devig2(pA, pB) {
    if (pA == null || pB == null) return [null, null];
    const s = pA + pB;
    return s > 0 ? [pA / s, pB / s] : [null, null];
  }
  function fmtPct(p, d = 1) { return (p * 100).toFixed(d) + '%'; }
  function cents(p) { return Math.round(p * 100) + '¢'; }

  // ---------- NFL margin model ----------
  // pmf(m | mu) ∝ Normal(m; mu, SIGMA) * W[|m|]  (key-number bumps calibrated to
  // historical |margin| frequencies: 3≈15%, 7≈9%, 6≈6.4%, 10≈5.8%, 14≈4.4% ...)
  const SIGMA_MARGIN = 13.2;
  const SIGMA_TOTAL = 13.0;
  const MAXM = 70;
  const W = {0:0.08,1:1,2:0.806,3:3.061,4:1.163,5:0.701,6:1.396,7:2.028,8:0.936,9:0.586,
    10:1.484,11:0.862,12:0.628,13:0.911,14:1.428,15:0.628,16:0.904,17:1.185,18:0.981};

  function marginPMF(mu) {
    const pm = new Float64Array(2 * MAXM + 1);
    let Z = 0;
    for (let m = -MAXM; m <= MAXM; m++) {
      const v = Math.exp(-0.5 * ((m - mu) / SIGMA_MARGIN) ** 2) * (W[Math.abs(m)] ?? 1);
      pm[m + MAXM] = v; Z += v;
    }
    for (let i = 0; i < pm.length; i++) pm[i] /= Z;
    return pm;
  }
  // P(home margin > x) for arbitrary real x (strict)
  function pMarginGreater(pm, x) {
    let s = 0;
    for (let m = Math.floor(x) + 1; m <= MAXM; m++) s += pm[m + MAXM];
    return s;
  }
  function pMarginEquals(pm, x) {
    if (!Number.isInteger(x) || Math.abs(x) > MAXM) return 0;
    return pm[x + MAXM];
  }
  // Fair (no-push) probability that HOME covers a line L (home margin + L > 0).
  // L is the home handicap (negative when home favored). Returns {cover, push}.
  function homeCoverProb(mu, L) {
    const pm = marginPMF(mu);
    const thr = -L;                       // cover iff margin > thr
    const gt = pMarginGreater(pm, thr);
    const eq = pMarginEquals(pm, thr);
    return { cover: gt / (1 - eq), push: eq };
  }
  function homeWinProb(mu) {
    const pm = marginPMF(mu);
    const gt = pMarginGreater(pm, 0), eq = pMarginEquals(pm, 0);
    return gt / (1 - eq);
  }
  function solveMu(fn, target, lo = -35, hi = 35) {
    // fn increasing in mu
    for (let i = 0; i < 60; i++) {
      const mid = (lo + hi) / 2;
      if (fn(mid) < target) lo = mid; else hi = mid;
    }
    return (lo + hi) / 2;
  }
  function muFromMoneyline(pHomeFair) {
    if (pHomeFair == null) return null;
    return solveMu(homeWinProb, Math.min(0.995, Math.max(0.005, pHomeFair)));
  }
  function muFromSpread(homeLine, pHomeCoverFair) {
    if (homeLine == null || pHomeCoverFair == null) return null;
    return solveMu(mu => homeCoverProb(mu, homeLine).cover, Math.min(0.995, Math.max(0.005, pHomeCoverFair)));
  }

  // ---------- totals model (normal) ----------
  function erf(x) { // Abramowitz-Stegun 7.1.26
    const s = Math.sign(x); x = Math.abs(x);
    const t = 1 / (1 + 0.3275911 * x);
    const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
    return s * y;
  }
  function Phi(z) { return 0.5 * (1 + erf(z / Math.SQRT2)); }
  function PhiInv(p) {
    let lo = -8, hi = 8;
    for (let i = 0; i < 80; i++) { const m = (lo + hi) / 2; if (Phi(m) < p) lo = m; else hi = m; }
    return (lo + hi) / 2;
  }
  function muTotalFromLine(line, pOverFair) {
    if (line == null || pOverFair == null) return null;
    return line - SIGMA_TOTAL * PhiInv(1 - Math.min(0.995, Math.max(0.005, pOverFair)));
  }
  function pOver(muT, line) { return 1 - Phi((line - muT) / SIGMA_TOTAL); }

  // ---------- Polymarket fee ----------
  // Sports markets: taker fee ≈ rate * p * (1-p) per share (exponent 1). Default rate 3%.
  function takerFee(price, schedule) {
    const rate = schedule && isFinite(schedule.rate) ? schedule.rate : 0.03;
    const exp = schedule && isFinite(schedule.exponent) ? schedule.exponent : 1;
    return rate * Math.pow(price * (1 - price), exp);
  }

  // ---------- name matching ----------
  function normName(s) {
    return String(s || '')
      .toLowerCase()
      .replace(/\b(jr|sr|ii|iii|iv|v)\b\.?/g, '')
      .replace(/[^a-z\s]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }
  function playerFromQuestion(q) {
    // "A.J. Brown: Anytime Touchdown" -> "A.J. Brown"
    const i = String(q || '').indexOf(':');
    return i > 0 ? q.slice(0, i).trim() : null;
  }

  // ---------- Polymarket market parsing ----------
  function parseJSONish(v) {
    if (Array.isArray(v)) return v;
    if (typeof v === 'string') { try { return JSON.parse(v); } catch (e) { return null; } }
    return null;
  }
  function marketView(m) {
    const outcomes = parseJSONish(m.outcomes) || [];
    const prices = (parseJSONish(m.outcomePrices) || []).map(Number);
    const bid0 = isFinite(m.bestBid) ? Number(m.bestBid) : null;   // bid for outcome[0]
    const ask0 = isFinite(m.bestAsk) ? Number(m.bestAsk) : null;   // ask for outcome[0]
    const ask1 = bid0 != null ? 1 - bid0 : null;                   // ask for outcome[1]
    const bid1 = ask0 != null ? 1 - ask0 : null;
    const mid0 = (bid0 != null && ask0 != null) ? (bid0 + ask0) / 2 : (isFinite(prices[0]) ? prices[0] : null);
    return {
      id: m.id, question: m.question, slug: m.slug, type: m.sportsMarketType || null,
      line: isFinite(m.line) ? Number(m.line) : null,
      outcomes, prices, bid0, ask0, bid1, ask1, mid0,
      liquidity: Number(m.liquidityNum || m.liquidity || 0),
      volume: Number(m.volumeNum || m.volume || 0),
      fee: m.feeSchedule || null, feesEnabled: !!m.feesEnabled,
      active: m.active !== false && m.closed !== true,
      description: m.description || ''
    };
  }
  function classify(mv) {
    const t = (mv.type || '').toLowerCase(), q = (mv.question || '').toLowerCase();
    const hasOU = mv.outcomes.some(o => /^over$/i.test(o)) && mv.outcomes.some(o => /^under$/i.test(o));
    const gameTotalQ = /^[^:]+ vs\.? [^:]+:\s*(o\/u|over\/under|total)/.test(q) || (/^(o\/u|total|over\/under)/.test(q));
    // 1) trust Polymarket's sportsMarketType when present
    if (t) {
      if (/^moneyline/.test(t)) return 'moneyline';
      if (/^spread/.test(t)) return 'spread';
      if (/^total/.test(t)) return 'total';
      if (/first/.test(t) && /touchdown|td/.test(t)) return 'first_td';
      if (/^anytime_touchdown/.test(t)) return 'anytime_td';
      if (/two_plus_touchdown/.test(t)) return 'two_plus_td';
      if (hasOU && mv.line != null) return 'player_ou';
      if (mv.outcomes.length === 2 && /^yes$/i.test(mv.outcomes[0] || '') && /^no$/i.test(mv.outcomes[1] || '')) return 'player_yesno';
      return 'other';
    }
    // 2) fall back to question text
    if (/^[^:]+ vs\.? [^:]+$/.test(mv.question || '')) return 'moneyline';
    if (/^spread:/.test(q)) return 'spread';
    if (hasOU && gameTotalQ) return 'total';
    if (/first touchdown|first td/.test(q)) return 'first_td';
    if (/anytime touchdown/.test(q)) return 'anytime_td';
    if (/2\+ touchdowns/.test(q)) return 'two_plus_td';
    if (hasOU && mv.line != null) return 'player_ou';
    if (mv.outcomes.length === 2 && /^yes$/i.test(mv.outcomes[0] || '') && /^no$/i.test(mv.outcomes[1] || '')) return 'player_yesno';
    return 'other';
  }

  // Team nickname map for matching Polymarket outcome labels to ESPN teams
  const NICK = {
    ari:'Cardinals', atl:'Falcons', bal:'Ravens', buf:'Bills', car:'Panthers', chi:'Bears', cin:'Bengals',
    cle:'Browns', dal:'Cowboys', den:'Broncos', det:'Lions', gb:'Packers', hou:'Texans', ind:'Colts',
    jax:'Jaguars', kc:'Chiefs', lac:'Chargers', la:'Rams', lv:'Raiders', mia:'Dolphins', min:'Vikings',
    ne:'Patriots', no:'Saints', nyg:'Giants', nyj:'Jets', phi:'Eagles', pit:'Steelers', sea:'Seahawks',
    sf:'49ers', tb:'Buccaneers', ten:'Titans', was:'Commanders'
  };
  const ESPN_TO_POLY = { LAR:'la', WSH:'was', JAX:'jax', LV:'lv', KC:'kc', NE:'ne', NO:'no', NYG:'nyg', NYJ:'nyj',
    SF:'sf', TB:'tb', GB:'gb', LAC:'lac' };
  function polyAbbr(espnAbbr) {
    const a = String(espnAbbr || '').toUpperCase();
    return ESPN_TO_POLY[a] || a.toLowerCase();
  }
  function gameSlug(awayAbbr, homeAbbr, etDate) { return `nfl-${polyAbbr(awayAbbr)}-${polyAbbr(homeAbbr)}-${etDate}`; }

  // ---------- book (DraftKings via ESPN) fair values ----------
  function bookFromEspnOdds(odds) {
    if (!odds) return null;
    const out = { provider: odds.provider && odds.provider.displayName || 'Book' };
    const ml = odds.moneyline;
    if (ml && ml.home && ml.away) {
      const ph = impliedFromAmerican((ml.home.close || ml.home.open || {}).odds);
      const pa = impliedFromAmerican((ml.away.close || ml.away.open || {}).odds);
      const [fh, fa] = devig2(ph, pa);
      out.ml = { homeOdds: (ml.home.close || {}).odds, awayOdds: (ml.away.close || {}).odds, pHome: fh, pAway: fa };
    }
    const ps = odds.pointSpread;
    if (ps && ps.home && ps.away) {
      const hc = ps.home.close || ps.home.open || {}, ac = ps.away.close || ps.away.open || {};
      const homeLine = parseFloat(String(hc.line).replace('+', ''));
      const ph = impliedFromAmerican(hc.odds), pa = impliedFromAmerican(ac.odds);
      const [fh, fa] = devig2(ph, pa);
      if (isFinite(homeLine)) out.spread = { homeLine, homeOdds: hc.odds, awayOdds: ac.odds, pHomeCover: fh, pAwayCover: fa };
    } else if (isFinite(odds.spread)) {
      out.spread = { homeLine: Number(odds.spread), pHomeCover: 0.5, pAwayCover: 0.5 };
    }
    const tt = odds.total;
    if (tt && tt.over && tt.under) {
      const oc = tt.over.close || tt.over.open || {}, uc = tt.under.close || tt.under.open || {};
      const line = parseFloat(String(oc.line).replace(/[ou]/i, ''));
      const po = impliedFromAmerican(oc.odds), pu = impliedFromAmerican(uc.odds);
      const [fo, fu] = devig2(po, pu);
      if (isFinite(line)) out.total = { line, overOdds: oc.odds, underOdds: uc.odds, pOver: fo, pUnder: fu };
    } else if (isFinite(odds.overUnder)) {
      out.total = { line: Number(odds.overUnder), pOver: 0.5, pUnder: 0.5 };
    }
    // model parameters implied by the book
    const muML = out.ml ? muFromMoneyline(out.ml.pHome) : null;
    const muSp = out.spread ? muFromSpread(out.spread.homeLine, out.spread.pHomeCover) : null;
    out.muML = muML; out.muSpread = muSp;
    out.mu = (muML != null && muSp != null) ? (muML + muSp) / 2 : (muML ?? muSp);
    out.muTotal = out.total ? muTotalFromLine(out.total.line, out.total.pOver) : null;
    return out;
  }

  // ---------- scanning one game ----------
  // game: {id, away:{abbr,nick,name}, home:{abbr,nick,name}, kickoff, slug, propsSlug}
  // markets: array of raw gamma markets for the main event; props: raw markets of player-props event
  // book: output of bookFromEspnOdds; injuries: Map normName -> {status, team, comment}
  function scanGame(game, markets, props, book, injuries, opts) {
    const o = Object.assign({ minEdgeML: 0.02, minEdgeSpread: 0.025, minEdgeTotal: 0.025, minEdgeProp: 0.015,
      minLiquidity: 200, consistencyPts: 1.5 }, opts || {});
    const flags = [], rows = { ml: null, spreads: [], totals: [] };
    const mvs = (markets || []).map(marketView).filter(m => m.active);
    const isHome = (label) => normName(label) === normName(game.home.nick) || normName(label) === normName(game.home.name);
    const isAway = (label) => normName(label) === normName(game.away.nick) || normName(label) === normName(game.away.name);
    const link = `https://polymarket.com/event/${game.slug}`;
    const mkFlag = (f) => flags.push(Object.assign({ game: game.label, kickoff: game.kickoff, link }, f));
    const edgeNet = (fair, ask, fee) => fair - ask - takerFee(ask, fee);

    // --- moneyline
    const ml = mvs.find(m => classify(m) === 'moneyline');
    let polyMuML = null;
    if (ml && ml.outcomes.length === 2) {
      const homeIdx = isHome(ml.outcomes[0]) ? 0 : (isHome(ml.outcomes[1]) ? 1 : 1);
      const askHome = homeIdx === 0 ? ml.ask0 : ml.ask1, askAway = homeIdx === 0 ? ml.ask1 : ml.ask0;
      const bidHome = homeIdx === 0 ? ml.bid0 : ml.bid1, bidAway = homeIdx === 0 ? ml.bid1 : ml.bid0;
      const midHome = (bidHome != null && askHome != null) ? (bidHome + askHome) / 2 : null;
      if (midHome != null) polyMuML = muFromMoneyline(midHome);
      rows.ml = { askHome, askAway, bidHome, bidAway, fairHome: book && book.ml ? book.ml.pHome : null, fairAway: book && book.ml ? book.ml.pAway : null, liquidity: ml.liquidity };
      if (book && book.ml && ml.liquidity >= o.minLiquidity) {
        const cands = [
          { side: game.home.nick, ask: askHome, fair: book.ml.pHome },
          { side: game.away.nick, ask: askAway, fair: book.ml.pAway }
        ];
        for (const c of cands) {
          if (c.ask == null || c.fair == null) continue;
          const net = edgeNet(c.fair, c.ask, ml.fee);
          if (net >= o.minEdgeML) mkFlag({ kind: 'ML', title: `${c.side} moneyline`, buy: `${c.side} to win`, ask: c.ask, fair: c.fair,
            edge: c.fair - c.ask, net, ev: net / c.ask, liquidity: ml.liquidity,
            why: `${book.provider} de-vigged ${fmtPct(c.fair)} vs Poly ask ${cents(c.ask)} (${book.ml.homeOdds} / ${book.ml.awayOdds})` });
        }
      }
      // arb within market
      if (askHome != null && askAway != null && askHome + askAway < 0.995)
        mkFlag({ kind: 'ARB', title: 'Moneyline both sides < $1', buy: `${game.home.nick} @ ${cents(askHome)} + ${game.away.nick} @ ${cents(askAway)}`,
          ask: askHome + askAway, fair: 1, edge: 1 - askHome - askAway, net: 1 - askHome - askAway - takerFee(askHome, ml.fee) - takerFee(askAway, ml.fee), ev: (1 - askHome - askAway) / (askHome + askAway), liquidity: ml.liquidity, why: 'Yes-ask + No-ask under $1 — riskless if both fill' });
    }

    // --- spreads
    const spreads = mvs.filter(m => classify(m) === 'spread' && m.line != null && m.outcomes.length === 2);
    const ladder = [];
    for (const s of spreads) {
      const teamIsHome = isHome(s.outcomes[0]);
      const teamIsAway = isAway(s.outcomes[0]);
      if (!teamIsHome && !teamIsAway) continue;
      // outcome[0] = team with handicap s.line (negative = laying points). Convert to home line:
      const homeLine = teamIsHome ? s.line : -s.line;
      ladder.push({ m: s, homeLine, teamLabel: s.outcomes[0], oppLabel: s.outcomes[1], teamIsHome });
      if (book && book.mu != null && s.liquidity >= o.minLiquidity) {
        const hc = homeCoverProb(book.mu, homeLine);
        const fairTeam = teamIsHome ? hc.cover : 1 - hc.cover;
        const fairOpp = 1 - fairTeam;
        rows.spreads.push({ label: `${s.outcomes[0]} ${s.line > 0 ? '+' : ''}${s.line}`, ask0: s.ask0, ask1: s.ask1, fair0: fairTeam, fair1: fairOpp, liquidity: s.liquidity, oppLabel: `${s.outcomes[1]} ${-s.line > 0 ? '+' : ''}${-s.line}` });
        const cands = [
          { side: `${s.outcomes[0]} ${s.line > 0 ? '+' : ''}${s.line}`, ask: s.ask0, fair: fairTeam },
          { side: `${s.outcomes[1]} ${-s.line > 0 ? '+' : ''}${-s.line}`, ask: s.ask1, fair: fairOpp }
        ];
        for (const c of cands) {
          if (c.ask == null) continue;
          const net = edgeNet(c.fair, c.ask, s.fee);
          if (net >= o.minEdgeSpread) mkFlag({ kind: 'SPREAD', title: c.side, buy: c.side, ask: c.ask, fair: c.fair, edge: c.fair - c.ask, net, ev: net / c.ask, liquidity: s.liquidity,
            why: `Model from ${book.provider} line ${game.home.nick} ${book.spread ? (book.spread.homeLine > 0 ? '+' : '') + book.spread.homeLine : ''} (${book.spread ? book.spread.homeOdds + '/' + book.spread.awayOdds : ''}), ML ${book.ml ? book.ml.homeOdds + '/' + book.ml.awayOdds : ''} → implied ${game.home.nick} ${book.mu > 0 ? '-' : '+'}${Math.abs(book.mu).toFixed(1)}` });
        }
      }
      if (s.ask0 != null && s.ask1 != null && s.ask0 + s.ask1 < 0.995)
        mkFlag({ kind: 'ARB', title: `Spread ${s.outcomes[0]} ${s.line} both sides < $1`, buy: `${s.outcomes[0]} ${s.line} @ ${cents(s.ask0)} + ${s.outcomes[1]} ${-s.line} @ ${cents(s.ask1)}`, ask: s.ask0 + s.ask1, fair: 1, edge: 1 - s.ask0 - s.ask1, net: 1 - s.ask0 - s.ask1 - takerFee(s.ask0, s.fee) - takerFee(s.ask1, s.fee), ev: (1 - s.ask0 - s.ask1) / (s.ask0 + s.ask1), liquidity: s.liquidity, why: 'Both sides of one spread sum under $1' });
    }
    // ladder monotonicity: P(home covers L) must fall as L gets harder for home (more negative)
    const byHome = ladder.filter(l => l.m.mid0 != null && l.m.liquidity >= o.minLiquidity)
      .map(l => ({ homeLine: l.homeLine, pHome: l.teamIsHome ? l.m.mid0 : 1 - l.m.mid0, l }))
      .sort((a, b) => b.homeLine - a.homeLine); // easiest for home first (largest homeLine)
    for (let i = 1; i < byHome.length; i++) {
      const prev = byHome[i - 1], cur = byHome[i];
      if (cur.pHome > prev.pHome + 0.015) {
        mkFlag({ kind: 'LADDER', title: `Spread ladder inverted: ${game.home.nick} ${fmtLine(cur.homeLine)} priced above ${fmtLine(prev.homeLine)}`,
          buy: `${game.home.nick} ${fmtLine(prev.homeLine)} (easier line is cheaper)`, ask: null, fair: null, edge: cur.pHome - prev.pHome, net: cur.pHome - prev.pHome, ev: null, liquidity: Math.min(prev.l.m.liquidity, cur.l.m.liquidity),
          why: `${fmtPct(cur.pHome)} to cover ${fmtLine(cur.homeLine)} vs ${fmtPct(prev.pHome)} to cover ${fmtLine(prev.homeLine)} — a harder line can't be likelier` });
      }
    }
    // ML vs spread-ladder consistency (Polymarket-internal)
    let polyMuSpread = null;
    if (byHome.length >= 2) {
      // least-squares fit of mu to ladder mids (liquidity-weighted)
      let best = null;
      for (let mu = -25; mu <= 25; mu += 0.25) {
        let err = 0, wsum = 0;
        for (const r of byHome) { const w = Math.log10(10 + r.l.m.liquidity); const p = homeCoverProb(mu, r.homeLine).cover; err += w * (p - r.pHome) ** 2; wsum += w; }
        err /= wsum;
        if (!best || err < best.err) best = { mu, err };
      }
      polyMuSpread = best ? best.mu : null;
    }
    if (polyMuML != null && polyMuSpread != null && Math.abs(polyMuML - polyMuSpread) >= o.consistencyPts) {
      const mlSays = polyMuML, spSays = polyMuSpread;
      // If ML implies home stronger than ladder does, home is "rich" on ML / cheap on spread (or away cheap on ML)
      const homeRicherOnML = mlSays > spSays;
      mkFlag({ kind: 'CONSIST', title: `ML vs spread ladder disagree by ${Math.abs(mlSays - spSays).toFixed(1)} pts`,
        buy: homeRicherOnML ? `${game.away.nick} ML or ${game.home.nick} spread` : `${game.home.nick} ML or ${game.away.nick} spread`,
        ask: null, fair: null, edge: Math.abs(mlSays - spSays) / 10, net: Math.abs(mlSays - spSays) / 10, ev: null, liquidity: ml ? ml.liquidity : 0,
        why: `Poly ML implies ${game.home.nick} ${fmtLine(-mlSays)}; Poly spread book implies ${fmtLine(-spSays)}${book && book.mu != null ? `; ${book.provider} implies ${fmtLine(-book.mu)}` : ''}` });
    }

    // --- totals
    const totals = mvs.filter(m => classify(m) === 'total' && m.line != null);
    for (const t of totals) {
      const overIdx = t.outcomes.findIndex(x => /^over$/i.test(x));
      if (overIdx < 0) continue;
      const askOver = overIdx === 0 ? t.ask0 : t.ask1, askUnder = overIdx === 0 ? t.ask1 : t.ask0;
      if (book && book.muTotal != null && t.liquidity >= o.minLiquidity) {
        const fo = pOver(book.muTotal, t.line), fu = 1 - fo;
        rows.totals.push({ line: t.line, askOver, askUnder, fairOver: fo, fairUnder: fu, liquidity: t.liquidity });
        for (const c of [{ side: `Over ${t.line}`, ask: askOver, fair: fo }, { side: `Under ${t.line}`, ask: askUnder, fair: fu }]) {
          if (c.ask == null) continue;
          const net = edgeNet(c.fair, c.ask, t.fee);
          if (net >= o.minEdgeTotal) mkFlag({ kind: 'TOTAL', title: c.side, buy: c.side, ask: c.ask, fair: c.fair, edge: c.fair - c.ask, net, ev: net / c.ask, liquidity: t.liquidity,
            why: `${book.provider} total ${book.total.line} (${book.total.overOdds}/${book.total.underOdds}) → mean ${book.muTotal.toFixed(1)}; at ${t.line} fair ${c.side.startsWith('Over') ? 'over' : 'under'} = ${fmtPct(c.fair)}` });
        }
      }
      if (askOver != null && askUnder != null && askOver + askUnder < 0.995)
        mkFlag({ kind: 'ARB', title: `Total ${t.line} both sides < $1`, buy: `Over @ ${cents(askOver)} + Under @ ${cents(askUnder)}`, ask: askOver + askUnder, fair: 1, edge: 1 - askOver - askUnder, net: 1 - askOver - askUnder - takerFee(askOver, t.fee) - takerFee(askUnder, t.fee), ev: (1 - askOver - askUnder) / (askOver + askUnder), liquidity: t.liquidity, why: 'Over-ask + Under-ask under $1' });
    }

    // --- player props
    const pvs = (props || []).map(marketView).filter(m => m.active);
    const propLink = game.propsSlug ? `https://polymarket.com/event/${game.propsSlug}` : link;
    const byPlayer = {};
    for (const p of pvs) {
      const cls = classify(p);
      if (!['first_td', 'anytime_td', 'two_plus_td', 'player_ou', 'player_yesno'].includes(cls)) continue;
      const name = playerFromQuestion(p.question);
      if (!name) continue;
      const key = normName(name);
      (byPlayer[key] = byPlayer[key] || { name, mk: {} });
      byPlayer[key].mk[cls] = byPlayer[key].mk[cls] || [];
      byPlayer[key].mk[cls].push(p);
    }
    for (const key in byPlayer) {
      const P = byPlayer[key];
      const inj = injuries && injuries.get ? injuries.get(key) : null;
      const outLike = inj && /^(out|injured reserve|ir|suspension|suspended|inactive|physically unable|pup|doubtful)/i.test(inj.status || '') || (inj && /inactive/i.test(inj.comment || ''));
      const firm = inj && !/doubtful/i.test(inj.status || '');
      // 1) ruled-out player: "No"/"Under" should be ~$1 (rules: inactive → No / Under)
      if (outLike) {
        const lists = [].concat(P.mk.first_td || [], P.mk.anytime_td || [], P.mk.two_plus_td || [], P.mk.player_ou || [], P.mk.player_yesno || []);
        for (const m of lists) {
          const isOU = classify(m) === 'player_ou';
          const noIdx = isOU ? m.outcomes.findIndex(x => /^under$/i.test(x)) : m.outcomes.findIndex(x => /^no$/i.test(x));
          if (noIdx < 0) continue;
          const askNo = noIdx === 0 ? m.ask0 : m.ask1;
          if (askNo == null) continue;
          const fair = firm ? 0.995 : 0.90;
          const net = fair - askNo - takerFee(askNo, m.fee);
          if (net >= o.minEdgeProp) mkFlag({ kind: 'PROP', title: `${m.question} → ${isOU ? 'Under' : 'No'}`, buy: `${isOU ? 'Under' : 'No'} on "${m.question}"`, ask: askNo, fair, edge: fair - askNo, net, ev: net / askNo, liquidity: m.liquidity, link: propLink,
            why: `${P.name} is ${inj.status}${inj.comment ? ' (' + inj.comment + ')' : ''} per ESPN — market rules: inactive/does not play resolves ${isOU ? 'Under' : 'No'}${firm ? '' : ' (Doubtful: not a lock)'}` });
        }
      }
      // 2) subset consistency: First TD Yes ≤ Anytime Yes; 2+ TD Yes ≤ Anytime Yes
      const any = (P.mk.anytime_td || [])[0];
      if (any) {
        const anyYesIdx = any.outcomes.findIndex(x => /^yes$/i.test(x));
        const anyYesAsk = anyYesIdx === 0 ? any.ask0 : any.ask1;
        const anyNoAsk = anyYesIdx === 0 ? any.ask1 : any.ask0;
        for (const [cls, label] of [['first_td', 'First TD'], ['two_plus_td', '2+ TD']]) {
          const sub = (P.mk[cls] || [])[0];
          if (!sub) continue;
          const yIdx = sub.outcomes.findIndex(x => /^yes$/i.test(x)) >= 0 ? sub.outcomes.findIndex(x => /^yes$/i.test(x)) : 0;
          const subYesBid = yIdx === 0 ? sub.bid0 : sub.bid1;
          const subNoAsk = yIdx === 0 ? sub.ask1 : sub.ask0;
          if (subNoAsk != null && anyNoAsk != null && subNoAsk < anyNoAsk - 0.01) {
            const edge = anyNoAsk - subNoAsk; // lower bound of mispricing
            mkFlag({ kind: 'SUBSET', title: `${P.name}: ${label} "No" cheaper than Anytime "No"`, buy: `No on "${sub.question}"`, ask: subNoAsk, fair: anyNoAsk, edge, net: edge - takerFee(subNoAsk, sub.fee), ev: (edge - takerFee(subNoAsk, sub.fee)) / subNoAsk, liquidity: sub.liquidity, link: propLink,
              why: `${label} is a subset of Anytime TD, so ${label} "No" must be worth at least Anytime "No" (${cents(anyNoAsk)}); it's offered at ${cents(subNoAsk)}` });
          }
          if (subYesBid != null && anyYesAsk != null && subYesBid > anyYesAsk + 0.005) {
            const cost = (1 - subYesBid) + anyYesAsk;
            mkFlag({ kind: 'ARB', title: `${P.name}: ${label} Yes bid > Anytime Yes ask`, buy: `No on "${sub.question}" @ ${cents(1 - subYesBid)} + Yes on "${any.question}" @ ${cents(anyYesAsk)}`, ask: cost, fair: 1, edge: 1 - cost, net: 1 - cost - takerFee(1 - subYesBid, sub.fee) - takerFee(anyYesAsk, any.fee), ev: (1 - cost) / cost, liquidity: Math.min(sub.liquidity, any.liquidity), link: propLink,
              why: 'Pays ≥ $1 in every outcome (first/2+ TD ⇒ anytime TD)' });
          }
        }
      }
    }

    return { flags, rows, polyMuML, polyMuSpread, bookMu: book ? book.mu : null, counts: { markets: mvs.length, props: pvs.length } };
  }
  function fmtLine(x) { return (x > 0 ? '+' : '') + (Math.round(x * 2) / 2).toFixed(1).replace('.0', ''); }

  // ---------- injuries index ----------
  function buildInjuryIndex(espnInjuries) {
    const map = new Map();
    const teams = (espnInjuries && espnInjuries.injuries) || [];
    for (const t of teams) {
      for (const inj of (t.injuries || [])) {
        const a = inj.athlete || {};
        const name = a.displayName || `${a.firstName || ''} ${a.lastName || ''}`;
        const key = normName(name);
        if (!key) continue;
        const rec = { name, team: (a.team && a.team.abbreviation) || t.abbreviation || '', status: inj.status || (inj.type && inj.type.description) || '', comment: inj.shortComment || '', detail: inj.details && inj.details.type || '', pos: a.position && a.position.abbreviation || '', date: inj.date };
        // keep the most severe / latest
        const prev = map.get(key);
        if (!prev || (new Date(rec.date || 0) >= new Date(prev.date || 0))) map.set(key, rec);
      }
    }
    return map;
  }

  // ---------- ESPN scoreboard → games ----------
  function etDateOf(iso) {
    try {
      const d = new Date(iso);
      const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(d);
      const g = (t) => parts.find(p => p.type === t).value;
      return `${g('year')}-${g('month')}-${g('day')}`;
    } catch (e) { return String(iso).slice(0, 10); }
  }
  function gamesFromScoreboard(sb) {
    const out = [];
    for (const ev of (sb && sb.events) || []) {
      const comp = (ev.competitions || [])[0]; if (!comp) continue;
      const home = (comp.competitors || []).find(c => c.homeAway === 'home'), away = (comp.competitors || []).find(c => c.homeAway === 'away');
      if (!home || !away) continue;
      const g = {
        id: ev.id, label: `${away.team.abbreviation} @ ${home.team.abbreviation}`, name: ev.shortName || ev.name,
        kickoff: comp.date || ev.date, status: (comp.status && comp.status.type && comp.status.type.state) || (ev.status && ev.status.type && ev.status.type.state) || '',
        home: { abbr: home.team.abbreviation, nick: home.team.name, name: home.team.displayName, score: home.score },
        away: { abbr: away.team.abbreviation, nick: away.team.name, name: away.team.displayName, score: away.score },
        odds: (comp.odds || [])[0] || null
      };
      const date = etDateOf(g.kickoff);
      g.slug = gameSlug(g.away.abbr, g.home.abbr, date);
      g.propsSlug = g.slug + '-player-props';
      g.book = bookFromEspnOdds(g.odds);
      out.push(g);
    }
    return out;
  }

  return { impliedFromAmerican, devig2, marginPMF, homeCoverProb, homeWinProb, muFromMoneyline, muFromSpread,
    muTotalFromLine, pOver, Phi, takerFee, normName, playerFromQuestion, marketView, classify, bookFromEspnOdds,
    scanGame, buildInjuryIndex, gamesFromScoreboard, gameSlug, polyAbbr, etDateOf, fmtPct, cents, fmtLine, NICK };
});
