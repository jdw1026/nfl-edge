const assert = require('assert');
const L = require('../logic.js');

function approx(a, b, tol, msg) { assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b} (tol ${tol})`); }

// --- odds math
approx(L.impliedFromAmerican('-166'), 0.624, 0.001, 'implied -166');
approx(L.impliedFromAmerican('+140'), 0.4167, 0.001, 'implied +140');
const [fh, fa] = L.devig2(L.impliedFromAmerican('-162'), L.impliedFromAmerican('+136'));
approx(fh, 0.593, 0.005, 'devig home'); approx(fh + fa, 1, 1e-9, 'devig sums to 1');

// --- margin model sanity
const pm = L.marginPMF(0);
let s = 0; for (const v of pm) s += v; approx(s, 1, 1e-9, 'pmf sums');
assert.ok(pm[3 + 70] > pm[2 + 70] && pm[3 + 70] > pm[4 + 70], 'key number 3 bump');
assert.ok(pm[7 + 70] > pm[6 + 70] && pm[7 + 70] > pm[8 + 70], 'key number 7 bump');
approx(L.homeWinProb(0), 0.5, 0.01, 'pickem = 50%');
// -3 at -115/-105 and ML -162/+136 should both imply mu near +3
const muSp = L.muFromSpread(-3, L.devig2(L.impliedFromAmerican('-115'), L.impliedFromAmerican('-105'))[0]);
const muML = L.muFromMoneyline(fh);
approx(muSp, 3.2, 1.0, 'mu from spread'); approx(muML, 3.0, 1.2, 'mu from ML');
// monotone cover probs
const c1 = L.homeCoverProb(3, -2.5).cover, c2 = L.homeCoverProb(3, -3.5).cover, c3 = L.homeCoverProb(3, -7.5).cover;
assert.ok(c1 > c2 && c2 > c3, 'cover prob decreases with harder line');
// half point through 3 should be worth ~ 15% of mass -> ~ 0.14-0.17 gap between -2.5 and -3.5 at mu=3
approx(c1 - c2, 0.09, 0.03, 'landing exactly on 3 when favored by 3 ≈ 9%');

// --- totals
const muT = L.muTotalFromLine(54.5, 0.5); approx(muT, 54.5, 1e-6, 'total mean at 50/50');
approx(L.pOver(54.5, 53.5), 0.53, 0.01, 'one point on total ≈ 3%');

// --- fee
approx(L.takerFee(0.92, { rate: 0.03, exponent: 1 }), 0.0022, 0.0002, 'fee at 92c');

// --- names
assert.strictEqual(L.normName('Walter Nolen III'), 'walter nolen');
assert.strictEqual(L.normName('A.J. Brown'), 'aj brown');
assert.strictEqual(L.playerFromQuestion('A.J. Brown: Anytime Touchdown'), 'A.J. Brown');

// --- ESPN book parsing
const odds = { provider: { displayName: 'DraftKings' }, details: 'LAR -6.5', overUnder: 45.5, spread: -6.5,
  moneyline: { home: { close: { odds: '-270' } }, away: { close: { odds: '+220' } } },
  pointSpread: { home: { close: { line: '-6.5', odds: '-118' } }, away: { close: { line: '+6.5', odds: '-102' } } },
  total: { over: { close: { line: 'o45.5', odds: '-112' } }, under: { close: { line: 'u45.5', odds: '-108' } } } };
const book = L.bookFromEspnOdds(odds);
approx(book.ml.pAway, 0.30, 0.01, 'Chargers fair ≈ 30%');
approx(book.mu, 6.5, 1.5, 'mu ≈ 6.5');
approx(book.muTotal, 45.7, 0.5, 'total mean');

// --- scanGame with Polymarket-like markets (today's LAC @ LAR)
const game = { label: 'LAC @ LAR', kickoff: '2026-11-01T21:05Z', slug: 'nfl-lac-la-2026-11-01', propsSlug: 'nfl-lac-la-2026-11-01-player-props',
  home: { abbr: 'LAR', nick: 'Rams', name: 'Los Angeles Rams' }, away: { abbr: 'LAC', nick: 'Chargers', name: 'Los Angeles Chargers' } };
const mk = (q, type, outcomes, bid, ask, extra) => Object.assign({ question: q, sportsMarketType: type, outcomes: JSON.stringify(outcomes), outcomePrices: JSON.stringify([(bid + ask) / 2, 1 - (bid + ask) / 2]), bestBid: bid, bestAsk: ask, liquidityNum: 50000, active: true, closed: false, feesEnabled: true, feeSchedule: { rate: 0.03, exponent: 1 } }, extra || {});
const markets = [
  mk('Chargers vs. Rams', 'moneyline', ['Chargers', 'Rams'], 0.26, 0.27),
  mk('Spread: Rams (-5.5)', 'spreads', ['Rams', 'Chargers'], 0.54, 0.55, { line: -5.5 }),
  mk('Spread: Rams (-6.5)', 'spreads', ['Rams', 'Chargers'], 0.50, 0.51, { line: -6.5 }),
  mk('Spread: Rams (-7.5)', 'spreads', ['Rams', 'Chargers'], 0.44, 0.45, { line: -7.5 }),
  mk('Spread: Rams (-3.5)', 'spreads', ['Rams', 'Chargers'], 0.61, 0.62, { line: -3.5 }),
  mk('Chargers vs. Rams: O/U 44.5', 'totals', ['Over', 'Under'], 0.54, 0.55, { line: 44.5 }),
];
const res = L.scanGame(game, markets, [], book, new Map(), {});
const mlFlag = res.flags.find(f => f.kind === 'ML');
assert.ok(mlFlag && /Chargers/.test(mlFlag.title), 'Chargers ML flagged');
approx(mlFlag.edge, 0.03, 0.01, 'Chargers ML edge ≈ 3 pts');
assert.ok(!res.flags.some(f => f.kind === 'LADDER'), 'no ladder inversion');
assert.ok(res.polyMuML != null && res.polyMuSpread != null, 'poly mus computed');
console.log('LAC@LAR: polyMuML', res.polyMuML.toFixed(2), 'polyMuSpread', res.polyMuSpread.toFixed(2), 'bookMu', res.bookMu.toFixed(2), 'flags', res.flags.map(f => f.kind + ':' + f.title));

// --- props: A.J. Brown out → First TD "No" at 92c flagged; Anytime No at 99.9c not flagged; subset flagged
const gameNE = { label: 'NE @ MIA', kickoff: '2026-11-01T21:25Z', slug: 'nfl-ne-mia-2026-11-01', propsSlug: 'nfl-ne-mia-2026-11-01-player-props',
  home: { abbr: 'MIA', nick: 'Dolphins', name: 'Miami Dolphins' }, away: { abbr: 'NE', nick: 'Patriots', name: 'New England Patriots' } };
const props = [
  mk('A.J. Brown: Anytime Touchdown', 'anytime_touchdowns', ['Yes', 'No'], 0.001, 0.04),
  mk('A.J. Brown: First Touchdown', 'first_touchdown', ['Yes', 'No'], 0.08, 0.11),
  mk('A.J. Brown: Receiving Yards O/U 60.5', 'player_receiving_yards', ['Over', 'Under'], 0.45, 0.55, { line: 60.5 }),
  mk('Hunter Henry: Anytime Touchdown', 'anytime_touchdowns', ['Yes', 'No'], 0.30, 0.33),
];
const injuries = L.buildInjuryIndex({ injuries: [{ displayName: 'New England Patriots', injuries: [
  { status: 'Out', shortComment: 'inactive', date: '2026-11-01T16:39Z', athlete: { displayName: 'A.J. Brown', position: { abbreviation: 'WR' }, team: { abbreviation: 'NE' } }, type: { description: 'out' } } ] }] });
assert.ok(injuries.get('aj brown'), 'injury index has Brown');
const r2 = L.scanGame(gameNE, [], props, null, injuries, {});
const propFlags = r2.flags.filter(f => f.kind === 'PROP');
assert.ok(propFlags.some(f => /First Touchdown/.test(f.title) && Math.abs(f.ask - 0.92) < 1e-9), 'First TD No @92c flagged');
assert.ok(propFlags.some(f => /Receiving Yards/.test(f.title) && Math.abs(f.ask - 0.55) < 1e-9), 'Yards Under flagged');
assert.ok(!propFlags.some(f => /Anytime/.test(f.title)), 'Anytime No at 99.9c not flagged');
assert.ok(r2.flags.some(f => f.kind === 'SUBSET'), 'subset flag');
console.log('NE@MIA props:', r2.flags.map(f => `${f.kind}: ${f.title} ask=${f.ask} net=${(f.net*100).toFixed(1)}`));

// --- scoreboard → games
const sb = { events: [{ id: '1', shortName: 'LAC @ LAR', date: '2026-11-01T21:05Z', competitions: [{ date: '2026-11-01T21:05Z', competitors: [
  { homeAway: 'home', team: { abbreviation: 'LAR', name: 'Rams', displayName: 'Los Angeles Rams' } },
  { homeAway: 'away', team: { abbreviation: 'LAC', name: 'Chargers', displayName: 'Los Angeles Chargers' } }], odds: [odds] }] },
  { id: '2', shortName: 'PHI @ WSH', date: '2026-11-02T01:20Z', competitions: [{ date: '2026-11-02T01:20Z', competitors: [
  { homeAway: 'home', team: { abbreviation: 'WSH', name: 'Commanders', displayName: 'Washington Commanders' } },
  { homeAway: 'away', team: { abbreviation: 'PHI', name: 'Eagles', displayName: 'Philadelphia Eagles' } }], odds: [] }] }] };
const games = L.gamesFromScoreboard(sb);
assert.strictEqual(games[0].slug, 'nfl-lac-la-2026-11-01');
assert.strictEqual(games[1].slug, 'nfl-phi-was-2026-11-01', 'SNF slug uses ET date');
console.log('ALL LOGIC TESTS PASSED');
