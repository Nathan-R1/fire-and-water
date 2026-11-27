# Fire & Water: Game Plan

This is an online two-player co-op puzzle platformer, played on phones first. One player controls **Ember** (fire) and the other controls **Ripple** (water). They have to work together to get both characters to their exits in each level.

> **Originality:** the game uses the fire-and-water co-op *genre*, but the characters, names, art, sound, UI and levels are all our own. We don't copy the layouts, sprites or look of any existing game.

---

## 1. Core game design

### The rules
- Each player controls one character with **◀ ▶ Jump**.
- The level is a single screen of tiles with platforms, slopes, hazards and puzzle pieces.
- **Elemental hazards:**
  | Pool | Ember (fire) | Ripple (water) |
  |---|---|---|
  | Lava | safe | dies |
  | Water | dies | safe |
  | Acid | dies | dies |
- If either character dies, the level restarts for both of them. Co-op means you succeed or fail as a pair.
- **Gems:** red gems can only be collected by Ember and blue gems only by Ripple. Gems are optional and count towards the score.
- **Exits:** each character has its own door. A level is complete when **both characters are standing in their doors at the same time**.

### Puzzle pieces (introduced gradually across levels)
| Piece | Behaviour |
|---|---|
| Pressure plate | Active while anything stands on it. Moves a linked platform or door. |
| Lever | Toggles between two states. Linked to platforms or gates. |
| Moving platform | Moves along a path between two points when its link is active. Carries whatever is on it. |
| Gate | A solid barrier that opens while its link is active. |
| Pushable box | Can be pushed, stood on, and used to weigh down a plate. |
| Elemental gate | Only Ember (or only Ripple) can pass through. |
| Wind / fan (later) | Pushes characters upward. |
| Light beam + mirror (later) | Rotate mirrors to hit a sensor. |

### Scoring
- Time taken, gems collected and deaths give a **rank of S, A, B or C**.
- Each level has a target time.
- Leaderboards are per level and ranked by fastest time with all gems.

### Game flow
```
Home ─► Create room / Join by code ─► Lobby (pick character, both tap Ready)
     ─► Level select (unlocked levels, ranks) ─► Play ─► Results ─► Next / Retry / Select
```

---

## 2. Technical design

### Physics
- The simulation runs at a **fixed 60 Hz** (no variable timestep) and is deterministic, written in plain JS with no engine.
- The same physics code is shared by server and client (`shared/`), which client-side prediction depends on.
- Collision uses axis-aligned bounding boxes (AABB) against a tile grid. Movement resolves on X then Y. Slopes are a later step and need special tiles.
- Movement includes acceleration, friction, gravity, a jump with a fixed height, **coyote time** (a short grace period to jump after walking off a ledge) and **jump buffering** (a jump pressed just before landing still counts). These matter a lot on touch screens.
- Characters collide with each other, so one can stand on the other. Boxes and moving platforms are dynamic bodies.

### Networking
- The **server is authoritative**: it decides what actually happened, so cheating and desync aren't possible.
- Clients send **input only**: `{seq, left, right, jump}` each tick.
- The server sends snapshots at 20–30 Hz with the full level state (characters, plates, gates, platforms, boxes, gems, timer).
- **Client-side prediction** for your own character: it moves immediately on input, then corrects to the server's position using the input sequence number. Without this, jumping feels laggy.
- The **other character** is shown about 100ms in the past, interpolated between two snapshots so it moves smoothly.
- **Events** (death, gem pickup, level complete) are sent reliably as separate messages so sounds and effects play exactly once.
- **Reconnect:** each player gets a session token stored in `localStorage`. If they rejoin within 60s they get the same character back and the level pauses while they're away.

### Level format
Levels are JSON, created in **Tiled** (a free map editor) and exported, then validated by a schema:
```json
{
  "id": "forest-01", "name": "First Steps", "width": 40, "height": 23, "tileSize": 24,
  "tiles": "base64-RLE...",
  "spawns": { "fire": [3, 20], "water": [5, 20] },
  "exits":  { "fire": [36, 4], "water": [38, 4] },
  "objects": [
    { "id": "p1", "type": "plate",    "at": [12, 20], "links": ["g1"] },
    { "id": "g1", "type": "gate",     "at": [20, 15], "size": [1, 3] },
    { "id": "m1", "type": "platform", "path": [[8,10],[8,16]], "speed": 2, "linkedBy": "l1" }
  ],
  "gems": [{ "el": "fire", "at": [10, 18] }],
  "targetTime": 90
}
```
- The level size (40×23 tiles at 24px, so 960×552) fits a landscape phone screen.
- Levels are stored in the repo (`levels/`) and synced to Supabase on deploy. Storing them in the repo means changes are reviewed and versioned. Supabase serves the level list and unlock data.

### Data model (Supabase)
| Table | Purpose |
|---|---|
| `players` | A row per device or account: `id`, `display_name`, `created_at`. Uses **Supabase anonymous auth** at first, which can later be upgraded to email or OAuth. |
| `levels` | `id`, `name`, `world`, `order`, `data jsonb`, `target_time`, `published` |
| `rooms` | Already exists. Add `level_id` and `players` |
| `runs` | One row per completed level: `level_id`, `fire_player`, `water_player`, `time_ms`, `gems`, `deaths`, `rank`, `created_at` |
| `progress` | A view built from `runs`: best rank per player and level, used to unlock levels |

- **RLS:** players can read levels, the leaderboard and their own progress. **Only the server writes `runs`**, so clients can't submit fake times.
- The browser uses the publishable key for login and reads only. The secret key stays on Render.
- **Privacy:** display names should be short handles, not real names, and we don't collect email unless accounts are added. Before any public launch, check with the DPO (Privacy@Totara.com) about storing player data.

### Client
- Plain JS with Canvas 2D at first. Switch to PixiJS only if performance needs it.
- Phones play in landscape and are prompted to rotate. The game uses the Fullscreen API and a PWA manifest so it can be added to the home screen and run without the browser address bar.
- **Controls:** ◀ ▶ on the left and **Jump** on the right, with large hit areas and optional haptic feedback (`navigator.vibrate`). Keyboard and gamepad are supported for desktop.
- The screen layer is separate from the game so the Home, Lobby, Select and Results screens are simple DOM elements on top of the canvas.

### Hosting and operations
- **Render:** move to the **Starter** plan before real players arrive, since the free plan sleeps when idle and drops WebSockets. Rooms are held in memory, so stay on **one instance**. Scaling to multiple instances needs sticky sessions or a Redis adapter, which isn't needed for a while.
- Deploys restart the server and kill live rooms. To limit the damage, send an "updating, rejoin in 10s" message on shutdown (`SIGTERM`), then rely on reconnect.
- **Rate limits:** cap the number of input messages per socket and room creation per IP.
- **Logging:** structured logs for room lifecycle, errors and tick-time warnings.
- **CI (GitHub Actions):** run tests and level validation on every PR. Render deploys from `main` after merge.

### Testing
- **Physics:** unit tests on `shared/`, such as landing on a platform, hitting your head on a ceiling, coyote time and pushing a box.
- **Levels:** headless simulations that replay recorded inputs and check the level can be completed. This catches levels that become impossible after a change.
- **Netcode:** a test with fake latency and packet loss that checks clients reconcile to the server's state.
- **Manual:** check each milestone on real iOS Safari and Android Chrome.

---

## 3. Milestones

Each milestone ends deployed and playable on two phones.

| # | Milestone | Done when |
|---|---|---|
| **M0** | ✅ Shell | Two phones share a room and walk left and right |
| **M1** | ✅ Platforming | Gravity, jumping, tile collision, a hand-written test level, Jump button, landscape layout, 60 Hz shared physics |
| **M2** | ✅ Netcode feel | Prediction and reconciliation, interpolating the partner, and jumping feels instant at about 150ms ping |
| **M3** | ✅ Hazards and win | Lava, water and acid pools, death and restart for both, exits, level complete and results screen |
| **M4** | 🟡 Puzzles (plates, levers, gates, fans, gems and timer done; boxes, moving platforms and rank to do) | Plates, levers, gates, moving platforms, boxes, gems, timer and rank |
| **M5** | 🟡 Levels pipeline (32 draft levels in ASCII JSON with a reachability checker, played in order; Tiled, level select and replays to do) | Tiled to JSON with validation, 10 tutorial levels (**World 1**), level select with unlocks, replay-based checks that levels can be completed |
| **M6** | Accounts and progress | Anonymous auth, display names, `runs`/`progress` in Supabase, per-level leaderboards |
| **M7** | Lobby and reconnect | Home, Create, Join and Lobby screens, choosing a character, ready-up, session-token reconnect, safe shutdown on deploy |
| **M8** | Art and audio | Original sprite sheets (idle, run, jump, die), tileset, particles, music and sound effects, settings screen |
| **M9** | Launch prep | Starter plan, rate limits, PWA, performance pass on low-end Android, privacy review, about 20 levels across 2 worlds |
| Later | Extras | Wind and mirrors, a third world, an in-game level editor, sharing custom levels, solo mode controlling both characters, spectator mode |

M1 and M2 are the risky part, because touch-controlled jumping over a network is what makes or breaks the game. Everything after that is content and features on a proven base.

---

## 4. Open questions
1. **Art:** draw sprites ourselves, use a commissioned artist, or use licensed asset packs (CC0, or itch.io with a commercial licence)? Check the licence on every asset.
2. **Accounts:** is anonymous play enough at launch, or do we need logins from the start so progress follows players across devices?
3. **Audience:** friends only, or public? This affects moderation of display names, privacy review and hosting cost.
4. **Solo mode:** should one person be able to control both characters? It adds control-switching UI but makes testing levels much easier.
