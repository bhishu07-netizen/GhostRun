# How Ghostrun works

A teardown of the whole system: what runs where, how a game moves from lobby to results, and why each piece is built the way it is.

## 1. Architecture

```
 Phone (browser)                         Supabase Postgres
 ───────────────                         ─────────────────
 index.html + Vite bundle                 6 tables, RLS on, no policies
   main.js   screens + game loop   ──►    11+1 SECURITY DEFINER RPCs
   api.js    fetch /rest/v1/rpc/*  ◄──    _tick() advances the game clock
   map.js    MapLibre + pastel style
   camera.js photo hint capture
        │
        └─► OpenFreeMap vector tiles (map only)
```

- **No server code of its own.** The app is static files on Vercel. All game rules live in Postgres functions (`supabase/migrations/`).
- **The browser can't read the tables directly.** RLS is enabled with no policies, and table privileges are revoked from `anon`. The only way in is through the public RPC functions, which run as `SECURITY DEFINER` and decide what each player may see.
- **No websockets.** Each phone calls `get_state` every 3 s, and that call runs `_tick`, which fires pings, applies hint penalties and ends the game when time runs out. A **pg_cron job (`ghostrun-tick`, every 30 s)** also runs `_tick_all()`, so the game clock keeps moving and old games are cleaned up even when no phone is open.

## 2. Identity

There are no accounts. `create_game` and `join_game` return `{player_id, secret}`. The server stores only `sha256(secret)`. The phone keeps both values in `localStorage` (`gr.session`) and sends them with every call. `_auth()` checks the hash and updates `last_seen`.

The profile (name, avatar, birth year) stays on the phone (`gr.profile`). The server only receives `p_age_ok`.

## 3. Data model

| Table | What it holds | Lifetime |
|---|---|---|
| `games` | code, mode, status `lobby → live → ended`, timers (`hunt_starts_at`, `ends_at`, `next_ping_at`), `ping_seq`, `catches`, `winner` | deleted 24 h after creation (cleanup runs inside `create_game`) |
| `players` | name, avatar, team, `alive`, `caught_by`, `secret_hash` | with its game |
| `locations` | one row per player: latest lat/lng/accuracy | only while the game is live; wiped by `_end` |
| `pings` | each ping's ghost-position `snapshot` (`kind`: `ping` or `penalty`) | snapshots blanked at game end |
| `hints` | photo hint due per ghost per ping: `deadline`, `photo` (JPEG data URL), `penalized` | wiped at game end |
| `catches` | hunter's claim on a ghost: `pending → confirmed / rejected` | with its game |
| `push_subs` | a device's push subscription (endpoint and keys) linked to a player and game | deleted when the game ends or the player leaves |
| `push_outbox` | alerts waiting to be sent, one row per device | deleted as they're sent; dropped after 10 minutes |

## 4. Game lifecycle

**Lobby.** The host is a hunter; everyone who joins starts as a ghost. A player can switch their own team; the host can move anyone. Max 12 players. Codes are 4 characters from an alphabet without 0/O/1/I.

**Start** (`start_game`, host only, needs at least 1 hunter and 1 ghost):
- Head start: 1 min in Quick, 5 min in the other modes. Hunters can't report catches during it.
- `ends_at`: Quick is 15 min, 1 hour is 60 min, Endless has none.
- `start_players` is frozen and sets the ping ladder.

**Ping ladder** (`_interval_min`): base 15 / 20 / 25 min for ≤5 / 6–7 / 8+ players at start, minus 5 min per catch, never below 5 min. Quick mode has no pings.

**Each `_tick`** (runs on every `get_state`):
1. No ghosts left → hunters win.
2. Past `ends_at` → ghosts win.
3. Past `next_ping_at` → `ping_seq++`, snapshot **every** ghost (last known position plus `at`; `no_gps: true` with no coordinates if their location is missing or older than 2 min), give each ghost a hint with a 60 s deadline, schedule the next ping.
4. A hint whose deadline passed without a photo → a **penalty ping** that shows only that ghost's position.

**Catching.** A hunter calls `report_catch`. The ghost sees a "did they tag you?" dialog (`catch_request` in their state) and answers through `respond_catch`. On yes (`_apply_catch`):
- the ghost becomes a hunter (`alive=false`, `caught_by`);
- `catches++`, which shortens the ping interval, and the ping timer restarts;
- their open hints are cancelled;
- `_tick` runs, so the last catch ends the game right away.

On no, the hunter gets an "escaped" toast and must wait 30 s before claiming the same ghost again.

**Play zone** (`set_zone`, host only, lobby only):
- **Setting it:** the host taps a size (250 m, 500 m, 1 km or 2 km), and the zone becomes a circle around where they're standing. The circle is drawn on every player's map.
- **What counts as outside:** being further from the centre than the radius plus the GPS accuracy (at least 20 m). This stops wobble at the edge from counting.
- **On leaving the zone:** a ghost gets an alert ("You left the play zone"), and the app shows a banner with a 30-second countdown.
- **The penalty:** after the head start, a ghost who stays out 30 seconds is revealed to hunters as a `zone` ping. It repeats at most once a minute while they stay out, and hunters get a toast and alert, and a "left the zone" marker.
- **Server:** `_zone_check` runs inside `_tick`, and `players.out_since` tracks when each ghost left.

**Leaving** (`leave_game`): the player is deleted. If they were host, the earliest remaining player becomes host, and a lobby with nobody left is deleted. In a live game, no hunters left means ghosts win, and no ghosts left means hunters win.

**End.** `_end` sets the winner, deletes all locations and photo hints, and blanks every ping snapshot. The results screen works out the awards on the phone: **Last Ghost** for every survivor, **Bloodhound** for the hunter with the most catches.

## 5. Who sees what (`get_state`)

| | Hunter | Ghost |
|---|---|---|
| Players list (names, teams, caught) | ✅ | ✅ |
| Live position of own teammates (fresh within 2 min) | ✅ hunters | ✅ ghosts |
| Ghost positions | only via the last 6 pings/penalty/zone snapshots | ❌ |
| The play zone | ✅ | ✅ |
| Each ghost's GPS freshness (`ghost_gps`, after head start) | ✅ | ❌ |
| Photo hints | ✅ (incremental via `p_photos_since`) | ❌ |
| Own catch claims (last 2 min) | ✅ | — |
| "Hunters last saw you" + due hint + pending catch | — | ✅ |

A hunter's live position is never sent to ghosts.

## 6. Client internals (`src/`)

- **`main.js`**: one file holds every screen. `renderProfile → renderHome → (poll loop) renderLobby / renderLive / renderResults`. Each poll replaces the whole screen with `innerHTML` built from the new state, with every value escaped by `esc()`. `detectEvents(prev, next)` compares two states to trigger the caught splash, the ping buzz and the "escaped" toast. A 1 s ticker updates the `[data-t]` countdowns between polls. `clockOffset` corrects for a wrong phone clock using the server's `now`.
- **`map.js`**: MapLibre with a globe projection and no area limit, so it works anywhere. On the menus it opens over the player's last known spot (`gr.lastpos`, rounded to about 100 m, stored only on the phone). If location is already allowed, it quietly moves there without a permission prompt. Otherwise it shows the whole globe and slowly turns it. Buildings rise the first time the map is zoomed in close enough to see them. `avatarMarker` is an HTML marker with a coloured ring. `circle()` draws the GPS accuracy halo.
- **`pastelStyle.js`**: a hand-written MapLibre style over OpenFreeMap tiles.
- **`camera.js`**: live back camera through `getUserMedia`, falling back to an `<input capture>` picker. The frame is redrawn on a canvas at no more than 720 px and JPEG quality is lowered until the image is under ~380 KB (the server limit is 400 000 characters).
- **GPS**: `watchPosition` with high accuracy, sent at most every 5 s. A Wake Lock keeps the screen on during play.

## 7. Security & privacy posture

- **CSP** in `vercel.json`: scripts from self only; connections only to OpenFreeMap and the project's Supabase URL; framing blocked.
- **Publishable key** in `api.js`: safe to ship, because it can only call the RPCs above.
- **Server-side checks**: inputs are validated in SQL (mode and team via CHECK constraints, avatar whitelist, JPEG-only photos, 20-character names).

## 8. GPS honesty

A ghost can't hide by turning location off:
- Hunters get a yellow banner listing every ghost whose GPS has been silent for more than 2 minutes (or never arrived).
- Ping markers show how old the position is (when the ghost was really there), not when the ping fired.
- The ghost gets a banner of their own as soon as location is denied, or after 60 s without a fix.
- No-GPS ghosts still get the photo-hint camera, and missing it still triggers a penalty.

## 9. Alerts (web push)

A website can't track location in the background. Instead, ghosts can lock their phone and get woken up in time for each ping.

- **Turning on alerts (`src/push.js`, `public/sw.js`).** In the lobby or the game menu, a player taps **Turn on alerts**. The browser asks permission and subscribes to its push service with the public VAPID key from `.env`. `save_push` stores the subscription against the player's current game, and the app re-links the device to every game it joins. On iPhone, web push only works from the Home Screen app, so a Safari tab shows an "Add to Home Screen" hint instead.
- **Queueing.** Game events call `_notify()`, which writes one row per subscribed device into `push_outbox`, all in English:
  - start: "The hunt is on!";
  - head start over: "Go hunt!" / "Hunters are coming";
  - about a minute before a ping, to ghosts only: "Ping in 1 minute";
  - at the ping: "Ping! Send your photo hint";
  - catch claimed: "X says they caught you";
  - catch rejected: "X says they escaped";
  - end: "Hunters win!" / "Ghosts win!".
- **Sending.** An `AFTER INSERT` trigger on `push_outbox` calls the `send-push` Edge Function through `pg_net`, and the 30-second cron job calls it again as a safety net. The function:
  - checks the shared hook secret;
  - reads the VAPID keys from Supabase Vault through `_push_config()`, which only the service role can call;
  - claims and deletes the queued rows, then sends them;
  - forgets subscriptions the push service reports as gone (404/410).
- **Privacy.** Payloads are encrypted end to end, so the push service can't read them. Subscriptions are deleted when the game ends, and queued alerts older than 10 minutes are dropped.

## 10. Known limits

- **Catches are on the honour system.** The tagged ghost confirms their own catch.
- **Host transfer is arbitrary on a tie.** If two players joined in the same instant, which one becomes host is not defined.

## 11. Testing

- `npm run build && npx vite preview --port 4173 &` then `npm run test:e2e`: two simulated phones play a full Endless game against an in-memory copy of the server rules. It covers profile and age gate, lobby, head start, ping, photo hint, rejected and confirmed catch, results, leave, a third phone with location denied (hunter + ghost warnings, still gets photo hint), JS errors, last-position memory, a phone in London hosting a game, alerts, the play zone (setting it, warning outside, clearing back inside), and phone-width overflow. 60 checks.
- The server functions were play-tested inside rolled-back transactions on the live database: auth, guards, pings, penalties, catches, win conditions, data wiping, the hardening fixes, no-GPS snapshots and cron-driven pings and time-up.
