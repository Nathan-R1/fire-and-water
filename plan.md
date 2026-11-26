# Fire & Water: Plan

Online two-player co-op platformer in the style of the Fire Boy & Water Girl genre, with our own characters, art and levels. It targets phones first.

## Phase 1: Shell (current scope)

- Two players join the same room using a short room code in the URL (`/?room=ABCD`).
- The first player in a room controls the **fire** character and the second controls the **water** character. Anyone after that watches.
- The screen is a flat 2D canvas with a floor and no obstacles.
- Controls are large on-screen ◀ ▶ buttons that move the character while held (pointer events, so they work for touch and mouse). Arrow keys and A/D also work for testing on a desktop.
- Characters only walk left and right. There is no jumping, gravity or level content yet.

## Architecture

```
Phone A ─┐                       ┌─ Supabase (Postgres)
         ├─ WebSocket ─ Render ──┤   rooms, later: levels, progress
Phone B ─┘   (Socket.IO)  Node    └─ secret key, server only
```

- **Render Web Service** runs Node with Express and Socket.IO. It:
  - serves the static client from `public/`
  - holds room state in memory and is the authority on game state. Clients send only input (`left`, `right` or `stop`), the server runs physics at 30 Hz and broadcasts positions, and clients interpolate between updates.
- **Supabase** stores data that has to outlive a server process. In phase 1 that is only a `rooms` table, which records when a room is created or ended. Later it will hold levels, completions and leaderboards.
  - Only the server talks to Supabase, using the secret key. The browser never gets a key.
  - The server still runs without Supabase env vars, so local development works with no setup.
- Gameplay traffic does not go through Supabase. Realtime state over a WebSocket to Render has lower latency, and it lets the server enforce the rules later (hazards, doors, win conditions).

## File layout

```
server.js                 Express + Socket.IO, room + tick loop
src/game.js               pure game-state/physics (testable)
src/db.js                 optional Supabase client
public/index.html         canvas + control buttons
public/client.js          input, rendering, interpolation
public/style.css          full-screen, no-scroll, landscape-friendly
supabase/migrations/001_rooms.sql
render.yaml               Render Blueprint
.env.example
```

## Supabase schema (phase 1)

```sql
create table public.rooms (
  id          uuid primary key default gen_random_uuid(),
  code        text not null,
  created_at  timestamptz not null default now(),
  ended_at    timestamptz
);
alter table public.rooms enable row level security;  -- no policies: server-only access
```

The migration file is `supabase/migrations/001_rooms.sql`.

## Render config

- Type: Web Service, runtime Node, build `npm install`, start `npm start`
- Health check path: `/healthz`
- Env vars: `SUPABASE_URL`, `SUPABASE_SECRET_KEY` (secret). Render provides `PORT` automatically.

## Later phases (not started)

1. Gravity and jumping (on-screen jump button), plus platforms from a tile map
2. Hazards: fire dies in water, water dies in lava, and both die in poison
3. Collectible gems and an exit door for each character
4. Levels stored in Supabase and a level select screen
5. Reconnect and resume, so a player gets their slot back after a dropped connection
6. Sprites and sound
