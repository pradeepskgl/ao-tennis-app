# AO Tennis Score Tracker

Track singles and doubles tournaments with group stages, an auto-advancing knockout draw, live point-by-point scoring, serve tracking, match stats, an order of play and CSV exports.

Stack: Node.js + Express, MongoDB (Mongoose), plain HTML/CSS/JS frontend served by Express. Deploys on Render with MongoDB Atlas.

## Who can do what
| | Viewers | Scorers | Admin |
|---|---|---|---|
| See scores, draw, schedule, standings, stats; download CSVs | yes | yes | yes |
| Score points, undo, reset, record the toss, set serve and serving order, enter a final score | | yes | yes |
| Walkovers, match format, fixtures, players, stages, tournaments | | | yes |
| Manage scorer logins, download full backup | | | yes |

The admin login comes from environment variables. Scorer logins are created by the admin on the **Scorers** page (one per court or volunteer works well); removing a scorer signs them out immediately.

## Run locally
```bash
npm install
cp .env.example .env      # fill in MONGODB_URI, ADMIN_USERNAME, ADMIN_PASSWORD, JWT_SECRET
npm start                 # http://localhost:3000
npm test                  # scoring engine tests
```
`test/api.test.js` is an end-to-end test: run it against a server started with test env vars and a throwaway database.

## Deploy on Render
1. Push this folder to GitHub and create a **Web Service** (build `npm install`, start `npm start`), or use `render.yaml`.
2. Set `MONGODB_URI` (Atlas), `ADMIN_USERNAME`, `ADMIN_PASSWORD`, `JWT_SECRET`.
3. In Atlas, allow Render's outbound IPs (or 0.0.0.0/0) under Network Access.

**Free tier sleep:** Render's free web services sleep after a period without traffic, and the next visit can take close to a minute to wake. For tournament days, either switch the service to a paid instance for the event, or have an uptime monitor (for example UptimeRobot) request `/healthz` every 5 to 10 minutes during the event. `/healthz` also reports whether the database is connected.

Now that there is a phone app, keep the server awake all the time: point an UptimeRobot (free) HTTP monitor at `https://<your-service>.onrender.com/healthz` every 5 minutes. One service awake around the clock uses about 744 of the 750 free instance-hours a month, so this only works for a single free service. Even so, the app shows "Waking up the server…" and retries if it ever finds the server asleep.

## Android and iOS apps
The frontend is also packaged as Android and iOS apps with Capacitor (`mobile/`). Android installs from an APK file you share directly, and later from Google Play. iOS builds in the cloud with Codemagic (`codemagic.yaml`) and goes out through TestFlight and the App Store. Build steps, signing and releases are in [mobile/README.md](mobile/README.md). Phone users can find install instructions at `/android.html`, and the privacy policy the app stores require is at `/privacy.html`.

The app calls the server from its own origin (`https://localhost` on Android, `capacitor://localhost` on iOS), and the server allows those origins for CORS. Add any others in the optional `CORS_ORIGINS` env var (comma-separated).

## Setting up a tournament
1. **Create tournament**: name + Singles or Doubles.
2. **Add players** (or teams of two), one at a time or in bulk (`Asha / Priya` per line for doubles).
   **Seeding:** the player list is the seed order (number 1 at the top). Drag rows or use the arrows.
3. **Tournament format**: Group Stage, Quarterfinals, Semifinals, Finals. Each is optional; add, rename, reorder or remove stages. Set the default match format.
4. **Fixtures**, per stage:
   - *Group stage*: number of groups; seeded snake draw or random; round robin in each group.
   - *Knockout*: from all entries (seeded bracket: 1 and 2 in opposite halves, top seeds get byes), from group qualifiers (A1 v B2, B1 v A2 for two per group), or from the winners of the previous round.
     The following knockout rounds are built at the same time, and **winners move through automatically**. You can build the knockout before the groups finish: slots show "Group A winner" or "Winner of Semifinals 1" until the result is in.
   - Edit any match (players, court, date and time, notes) or add matches by hand. Picking a player for a bracket slot replaces its automatic link.
   - Once a later match has started, the results feeding it are locked; reset the later match first to change them.

## Match format
1. Games per set: **Fast 4** or **Regular 6**
2. Scoring: **With Ad** or **No Ad**
3. Sets: **Best of 3**, or **Best of 2 + 10-point match tie-breaker**

Set tie-breaker: first to 7, win by 2, at **3-3** (Fast 4) or **6-6** (Regular 6). Match tie-breaker: first to 10, win by 2. The format locks once a match has a score.

## Scoring, serve and stats
- **Start match** (scorers and admins, singles and doubles): the point buttons appear once the match is started; record the toss and serve before starting. Starting also starts the **match clock**, shown running in the match and on live cards, and stopped at the result (also in the Results CSV as "Match time"). **Reset score** returns a match to not started and clears the clock; undoing the winning point resumes it.
- Point buttons, undo, reset, walkover (admin), or **Enter final score** (checked against the format; no need to start the match).
- **Coin toss:** record who won the toss and what they chose (serve or receive, the end, or let the opponent choose first), the other side's choice, and the starting end. Saving the toss sets who serves first. It can be changed until the first point, and is cleared if the players in the match change.
- **Doubles serving order:** save which player serves first for each team. Each team can change its order at the start of every set (and the match tie-breaker); without a change the rotation carries on from the previous set.
- **Doubles receiving sides:** save which player of each team receives in the deuce court (also changeable at the start of each set).
- **Next point:** the match shows who serves and from which court (deuce or ad), who receives, and which team is at the end named in the toss. On a no-Ad deciding point it notes that the receivers choose.
- **Changing ends** (standard rules): after the 1st game and every odd game of each set (3, 5, 7...), and after every 6 points of a set or match tie-breaker. A set tie-breaker counts as one game, so a set ending 7-6 (13 games) is followed by a change; when a set ends with an even number of games the change comes after the first game of the next set. Before each such point the match shows **Change ends now** (also beside the point buttons and on live score cards), says which team moves to which end when the toss named one, and always shows when the next change is due.
- **Tie-breakers:** each set or match tie-breaker gets a point-by-point table: server, court, receiver, who won the point, the score, which team was at the named end, and where ends were changed.
- **Serve:** choose who serves first (or let the toss set it). The server is then worked out from the score: it changes every game; in tie-breakers after the first point and then every two points; a tie-breaker counts as one game, so the side that received first in it serves first in the next set. Doubles rotate A1, B1, A2, B2.
- **Stats** (from point-by-point scoring): points won, longest run of points, and with serve set: service and return points won, service games held, break points converted and saved.
- Everyone watching a tournament sees scores change **instantly** (server-sent events), with a background refresh as a fallback.

## Views
- **Matches**: every match by stage and group.
- **Draw**: the knockout bracket.
- **Schedule**: order of play by day and time, with court; filter to one player or team, hide finished matches.
- **Standings**: group tables with **Points** (2 per win), **Set%** and **Game%** (share of sets and games won); all also in the Standings CSV. Ranked by points (wins); two players level are split by their **head-to-head** result (marked H2H); three or more level by set difference, then game difference.
- **Promote to the next stage** (admin, on Standings): under each group table, pick who takes each qualifying position (for example "Group A winner → Semifinals 1"), then press **Confirm promotion** (or Cancel). The confirmed pick fills that knockout slot straight away, even before the group finishes; positions left on **Auto** follow the final standings, skipping anyone promoted. Promoted players are marked, and the highlight shows who is going through. Picks lock once a next-stage match fed by that group has started (reset it to change them).

## Exports
- **Results (CSV)** and **Standings (CSV)** for everyone (opens in Excel or Google Sheets).
- **Full backup (JSON)** for the admin: the tournament plus every match including point logs.
