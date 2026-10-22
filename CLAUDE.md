# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Tennis tournament tracker (singles and doubles): group stages, auto-advancing knockout draw, live point-by-point scoring with serve tracking and stats, order of play, CSV/JSON exports. Node.js + Express + MongoDB (Mongoose), with a plain HTML/CSS/JS frontend (no build step, no framework). Deployed on Render (`render.yaml`) with MongoDB Atlas. `README.md` documents the user-facing tennis rules and features; treat it as the spec.

## Commands

```bash
npm install
cp .env.example .env   # MONGODB_URI, ADMIN_USERNAME, ADMIN_PASSWORD, JWT_SECRET (server exits if any is missing)
npm start              # http://localhost:3000
npm run dev            # node --watch
npm test               # scoring engine unit tests (test/scoring.test.js), no DB needed
```

Tests are plain `assert` scripts with no framework; a failure throws and exits non-zero. There is no lint setup.

`test/api.test.js` is an end-to-end test against a running server and a **throwaway** database (it writes tournaments, matches and scorers):

```bash
# terminal 1: start the server on 3055 with a test MONGODB_URI
PORT=3055 MONGODB_URI=... ADMIN_USERNAME=... ADMIN_PASSWORD=... JWT_SECRET=... npm start
# terminal 2
BASE=http://localhost:3055 ADMIN_USERNAME=... ADMIN_PASSWORD=... node test/api.test.js
```

Android and iOS apps (Capacitor, own `package.json`, see `mobile/README.md`):

```bash
cd mobile && npm install
npm run build          # copy public/ + lib/scoring.js into www/ with config.js -> app.config.json apiBase, then cap sync (both platforms; build:android / build:ios for one)
npm run apk            # build + signed release APK into mobile/dist/ (needs Android SDK, JAVA_HOME, android/keystore.properties)
```

iOS can't be built on Windows: `codemagic.yaml` (repo root) builds `mobile/ios/App` on a cloud Mac and uploads to TestFlight. Keep the shared scheme `App.xcscheme` committed, because the workflow builds `--scheme App`.

## Architecture

**Files:** `server.js` (all routes and tournament logic, one file), `models.js` (Tournament, Match, Scorer schemas), `lib/scoring.js` (scoring engine), `public/app.js` (entire SPA in one IIFE, renders DOM via an `h()` helper, state in an `S` object).

**Shared scoring engine.** `lib/scoring.js` is a UMD module used by both the server (`require`) and the browser (served at `/scoring.js`, exposed as `window.Scoring`). Keep it dependency-free and browser-compatible. Changes to tennis rules belong here, and both sides pick them up.

**State is derived from the point log.** A match's `log` is an array of `'a'|'b'` per point; `state` is a cache recomputed by `Scoring.computeState(format, log)` (see `recompute()` in `server.js`). Undo is just popping the log. Exceptions: `manual` matches (final score typed in, built by `stateFromSets`, empty log) and `walkover` matches, which set `state.winner` directly. Server, stats (`matchStats`) and current server (`serverFor`) are all derived by replaying the log, never stored.

**Knockout propagation.** Knockout slots can have `sourceA`/`sourceB` instead of a fixed side: `{kind:'winner', match}` or `{kind:'group', stageKey, group, rank}`. `propagate(tournamentId)` resolves sources from finished matches and completed group standings, repeating until stable (handles byes chaining forward). It runs after any change that completes or un-completes a match (`saveScored`). Matches that have started are never refilled. `guardResultChange()` returns 409 when changing a result would affect a later match that has already started.

**Standings.** `computeStandings()` in `server.js` ranks by wins; a two-way tie uses head-to-head, three or more use set difference then game difference. Group-sourced knockout slots resolve through `groupPlacings()`: positions the admin promoted someone into (`tournament.promotions`, set via `PUT /api/tournaments/:id/promotions`) fill immediately; the other positions fill from standings order, skipping promoted entries, once the group table is `complete`.

**Auth.** Admin credentials come from env vars only; scorers are `Scorer` docs (scrypt salt+hash). Login returns a JWT; the client stores it in `localStorage` (`tt_token`) and sends `Authorization: Bearer`. `whoIs()` re-reads the scorer on every request so deleted scorers lose access immediately. Use `admin` / `scorer` (scorer-or-admin) middleware; reads are public. 401 means the client should sign out, 403 means signed in but not allowed.

**Live updates (SSE).** `GET /api/tournaments/:id/events` streams to viewers. A middleware on `/api` sends a `change` event after any successful non-GET whose handler set `res.locals.tid`. `getTournament(id, res)` / `getMatch(id, res)` set this for you, so new write routes should load via those helpers with `res` passed. The client re-fetches on events and also polls as a fallback.

**Mobile app.** `mobile/` wraps `public/` unchanged; there is no separate app code. So the frontend must keep working from another origin. Build every API URL from the `API` constant in `app.js` (`APP_CONFIG.apiBase` from `public/config.js`, empty on the web, the Render URL in the app). Keep asset paths in `index.html` relative. Use `request()` rather than bare `fetch` (it handles the free-tier wake-up retries and only retries reads after network failures). Branch on `isNative` for anything browsers do differently from the WebView: downloads go through Filesystem + Share, and the Android back button is handled. Native plugins are reached with `plugin('Name')`, because no bundler imports the npm packages. The server's CORS allowlist (`CORS_ORIGINS` in `server.js`) must include the Capacitor origins. `mobile/android/` and `mobile/ios/` are generated by `cap add` but committed; `www/` and `dist/` are build output.

**Route conventions.** Wrap async handlers in `ah()`; throw `HttpError(status, message)` for user-facing errors (messages are shown to users verbatim, so write them as plain sentences). Matches are returned through `shapeMatch()` / `sendMatch()`, which add derived fields (`number`, `sideALabel` like "Winner of Semifinals 1", `pointsPlayed`) and omit the raw log.
