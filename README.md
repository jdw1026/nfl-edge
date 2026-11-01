# NFL Edge

A lightweight, install-free iPhone web app that scans **Polymarket NFL markets** for mispricing against
**DraftKings lines (via ESPN's public scoreboard feed)** and the **ESPN injury report**. No API keys, no backend —
the page talks to the public APIs directly from your phone.

## What it flags
| Kind | Check |
|---|---|
| Moneyline | Poly ask vs de-vigged DraftKings moneyline |
| Spread / Total | Poly ask at every line vs a key-number-aware NFL margin model fitted to the book's line + juice + moneyline |
| Prop · ruled out | A player marked Out / IR / inactive still has "No" or "Under" priced under $1 (Polymarket's rules resolve those No/Under) |
| Prop · subset | First-TD or 2+-TD "No" priced below Anytime-TD "No" (impossible — subset) |
| Arb | Both sides of one market sum under $1; or First/2+ TD "Yes" bid above Anytime "Yes" ask |
| Ladder / Consistency | Spread ladder not monotone; Poly moneyline and spread book imply different lines |

Edges are shown **after Polymarket's taker fee**, against **live asks** (what you'd actually pay).

## Run it on your iPhone
1. Host these files on any static host (GitHub Pages is free — the included workflow deploys on push to `main`).
2. Open the URL in Safari → Share → **Add to Home Screen**. It launches full-screen like an app.
3. Tap **Scan now**. Rescan ~90 minutes before kickoff when inactives drop — that's when the prop edges appear.

## Notes
- Polymarket's API is called directly; if your browser blocks it (CORS), the app falls back to a public CORS relay
  (toggle in Settings).
- In-play games skip the book comparison (pregame lines) but keep prop and consistency checks.
- Not betting advice. Thin books fill at worse prices than the displayed ask.

## Dev
```
node test/logic.test.js     # engine unit tests
node test/render.test.js    # Playwright render with mocked APIs (iPhone viewport)
```
