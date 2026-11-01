// Renders the app in a mobile viewport with mocked ESPN + Polymarket responses.
const { chromium, devices } = require('playwright');
const http = require('http'); const fs = require('fs'); const path = require('path');
const root = path.join(__dirname, '..');

function mk(q, type, outcomes, bid, ask, extra) {
  return Object.assign({ id: String(Math.random()).slice(2), question: q, sportsMarketType: type, slug: q.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
    outcomes: JSON.stringify(outcomes), outcomePrices: JSON.stringify([(bid + ask) / 2, 1 - (bid + ask) / 2]),
    bestBid: bid, bestAsk: ask, liquidityNum: 40000, volumeNum: 1000, active: true, closed: false, feesEnabled: true, feeSchedule: { rate: 0.03, exponent: 1 } }, extra || {});
}
const dk = (homeML, awayML, homeLine, homeJ, awayJ, total, oJ, uJ) => ({ provider: { displayName: 'DraftKings' },
  moneyline: { home: { close: { odds: homeML } }, away: { close: { odds: awayML } } },
  pointSpread: { home: { close: { line: String(homeLine), odds: homeJ } }, away: { close: { line: String(-homeLine), odds: awayJ } } },
  total: { over: { close: { line: 'o' + total, odds: oJ } }, under: { close: { line: 'u' + total, odds: uJ } } } });
const game = (id, away, home, date, odds, state = 'pre') => ({ id, shortName: `${away[0]} @ ${home[0]}`, date, competitions: [{ date, status: { type: { state } },
  competitors: [{ homeAway: 'home', team: { abbreviation: home[0], name: home[1], displayName: home[2] } }, { homeAway: 'away', team: { abbreviation: away[0], name: away[1], displayName: away[2] } }], odds: [odds] }] });

const scoreboard = { events: [
  game('1', ['LAC', 'Chargers', 'Los Angeles Chargers'], ['LAR', 'Rams', 'Los Angeles Rams'], '2026-11-01T21:05Z', dk('-270', '+220', -6.5, '-118', '-102', 45.5, '-112', '-108')),
  game('2', ['NE', 'Patriots', 'New England Patriots'], ['MIA', 'Dolphins', 'Miami Dolphins'], '2026-11-01T21:25Z', dk('+270', '-340', 7, '-110', '-110', 41.5, '-108', '-112')),
  game('3', ['KC', 'Chiefs', 'Kansas City Chiefs'], ['DEN', 'Broncos', 'Denver Broncos'], '2026-11-01T21:25Z', dk('-108', '-112', 1.5, '-120', '+100', 41.5, '-102', '-118')),
] };
const injuries = { injuries: [{ displayName: 'New England Patriots', injuries: [
  { status: 'Out', shortComment: 'inactive', date: '2026-11-01T16:39Z', athlete: { displayName: 'A.J. Brown', position: { abbreviation: 'WR' }, team: { abbreviation: 'NE' } }, type: { description: 'out' } },
  { status: 'Out', shortComment: 'illness', date: '2026-11-01T16:39Z', athlete: { displayName: 'TreVeyon Henderson', position: { abbreviation: 'RB' }, team: { abbreviation: 'NE' } }, type: { description: 'out' } } ] }] };
const events = {
  'nfl-lac-la-2026-11-01': [{ slug: 'nfl-lac-la-2026-11-01', title: 'Chargers vs. Rams', markets: [
    mk('Chargers vs. Rams', 'moneyline', ['Chargers', 'Rams'], 0.26, 0.27),
    mk('Spread: Rams (-3.5)', 'spreads', ['Rams', 'Chargers'], 0.61, 0.62, { line: -3.5 }),
    mk('Spread: Rams (-5.5)', 'spreads', ['Rams', 'Chargers'], 0.54, 0.55, { line: -5.5 }),
    mk('Spread: Rams (-6.5)', 'spreads', ['Rams', 'Chargers'], 0.50, 0.51, { line: -6.5 }),
    mk('Spread: Rams (-7.5)', 'spreads', ['Rams', 'Chargers'], 0.44, 0.45, { line: -7.5 }),
    mk('Chargers vs. Rams: O/U 44.5', 'totals', ['Over', 'Under'], 0.54, 0.55, { line: 44.5 }) ] }],
  'nfl-lac-la-2026-11-01-player-props': [{ slug: 'nfl-lac-la-2026-11-01-player-props', markets: [ mk('Puka Nacua: Anytime Touchdown', 'anytime_touchdowns', ['Yes', 'No'], 0.40, 0.43) ] }],
  'nfl-ne-mia-2026-11-01': [{ slug: 'nfl-ne-mia-2026-11-01', title: 'Patriots vs. Dolphins', markets: [
    mk('Patriots vs. Dolphins', 'moneyline', ['Patriots', 'Dolphins'], 0.75, 0.76),
    mk('Spread: Patriots (-6.5)', 'spreads', ['Patriots', 'Dolphins'], 0.52, 0.53, { line: -6.5 }),
    mk('Spread: Patriots (-7.5)', 'spreads', ['Patriots', 'Dolphins'], 0.45, 0.46, { line: -7.5 }),
    mk('Spread: Patriots (-8.5)', 'spreads', ['Patriots', 'Dolphins'], 0.43, 0.44, { line: -8.5 }),
    mk('Patriots vs. Dolphins: O/U 42.5', 'totals', ['Over', 'Under'], 0.49, 0.50, { line: 42.5 }) ] }],
  'nfl-ne-mia-2026-11-01-player-props': [{ slug: 'nfl-ne-mia-2026-11-01-player-props', markets: [
    mk('A.J. Brown: Anytime Touchdown', 'anytime_touchdowns', ['Yes', 'No'], 0.001, 0.04),
    mk('A.J. Brown: First Touchdown', 'first_touchdown', ['Yes', 'No'], 0.08, 0.11),
    mk('TreVeyon Henderson: Anytime Touchdown', 'anytime_touchdowns', ['Yes', 'No'], 0.05, 0.09),
    mk('Hunter Henry: Anytime Touchdown', 'anytime_touchdowns', ['Yes', 'No'], 0.30, 0.33) ] }],
  'nfl-kc-den-2026-11-01': [{ slug: 'nfl-kc-den-2026-11-01', title: 'Chiefs vs. Broncos', markets: [
    mk('Chiefs vs. Broncos', 'moneyline', ['Chiefs', 'Broncos'], 0.515, 0.525),
    mk('Spread: Chiefs (-1.5)', 'spreads', ['Chiefs', 'Broncos'], 0.48, 0.49, { line: -1.5 }),
    mk('Spread: Chiefs (-2.5)', 'spreads', ['Chiefs', 'Broncos'], 0.46, 0.47, { line: -2.5 }),
    mk('Spread: Chiefs (-3.5)', 'spreads', ['Chiefs', 'Broncos'], 0.38, 0.39, { line: -3.5 }),
    mk('Spread: Broncos (-1.5)', 'spreads', ['Broncos', 'Chiefs'], 0.45, 0.46, { line: -1.5 }),
    mk('Chiefs vs. Broncos: O/U 40.5', 'totals', ['Over', 'Under'], 0.51, 0.52, { line: 40.5 }) ] }],
  'nfl-kc-den-2026-11-01-player-props': [],
};

(async () => {
  const server = http.createServer((req, res) => {
    const p = path.join(root, decodeURIComponent(req.url.split('?')[0] === '/' ? '/index.html' : req.url.split('?')[0]));
    if (!p.startsWith(root) || !fs.existsSync(p)) { res.writeHead(404); return res.end(); }
    const ext = path.extname(p); const types = { '.html': 'text/html', '.js': 'text/javascript', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
    res.writeHead(200, { 'content-type': types[ext] || 'application/octet-stream' }); fs.createReadStream(p).pipe(res);
  }).listen(0);
  const port = server.address().port;
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ ...devices['iPhone 13'] });
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', e => errors.push(String(e))); page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  await page.route('**/*', async (route) => {
    const u = route.request().url();
    const json = (o) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(o), headers: { 'access-control-allow-origin': '*' } });
    if (u.startsWith('https://site.api.espn.com/') && /scoreboard/.test(u)) return json(scoreboard);
    if (u.startsWith('https://site.api.espn.com/') && /injuries/.test(u)) return json(injuries);
    if (u.startsWith('https://gamma-api.polymarket.com/events')) { const slug = new URL(u).searchParams.get('slug'); return json(events[slug] || []); }
    if (u.startsWith(`http://localhost:${port}`) || u.startsWith(`http://127.0.0.1:${port}`)) return route.continue();
    return route.fulfill({ status: 404, body: '' });
  });
  await page.addInitScript(() => { try { localStorage.setItem('nfledge.settings', JSON.stringify({ minEdgeTotal: 1.0 })); } catch (e) {} });
  await page.goto(`http://localhost:${port}/`);
  await page.click('#scanBtn');
  await page.waitForFunction(() => window.NFLEdgeApp && window.NFLEdgeApp.state.lastRun, null, { timeout: 20000 });
  const titles = await page.$$eval('#edges .card .title', els => els.map(e => e.textContent));
  console.log('FLAGS:', titles);
  const must = [/Chargers moneyline/, /A\.J\. Brown: First Touchdown/, /TreVeyon Henderson: Anytime Touchdown/];
  for (const m of must) if (!titles.some(t => m.test(t))) { console.error('MISSING FLAG', m); process.exitCode = 1; }
  if (!titles.some(t => /Under 42\.5/.test(t))) { console.error('MISSING Under 42.5'); process.exitCode = 1; }
  await page.screenshot({ path: path.join(__dirname, 'shot-edges.png'), fullPage: true });
  await page.click('.tab[data-tab=games]'); await page.waitForTimeout(100);
  await page.screenshot({ path: path.join(__dirname, 'shot-games.png'), fullPage: true });
  await page.click('.tab[data-tab=settings]'); await page.waitForTimeout(100);
  await page.screenshot({ path: path.join(__dirname, 'shot-settings.png'), fullPage: true });
  const status = await page.$eval('#status', e => e.textContent);
  console.log('STATUS:', status);
  if (errors.length) { console.error('PAGE ERRORS:', errors); process.exitCode = 1; }
  await browser.close(); server.close();
  console.log(process.exitCode ? 'RENDER TEST FAILED' : 'RENDER TEST PASSED');
})();
