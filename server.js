const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const P = require('./shared/physics');
const game = require('./src/game');
const db = require('./src/db');

const PORT = process.env.PORT || 3000;
const SNAPSHOT_MS = 1000 / 30;
const ROOM_CODE_RE = /^[A-Z0-9]{4,8}$/;
const DEV = process.env.DEV === '1'; // local testing: enables the Skip room button
const EMPTY_ROOM_MS = Number(process.env.EMPTY_ROOM_MS) || 60 * 1000; // keep an empty room (and its level) this long, e.g. across a reload

const app = express();
app.use(express.static(path.join(__dirname, 'public')));
app.use('/shared', express.static(path.join(__dirname, 'shared')));
app.get('/healthz', (_req, res) => res.json({ ok: true, db: db.enabled, levels: game.LEVELS.length }));

const server = http.createServer(app);
const io = new Server(server);

const rooms = new Map(); // code -> { state, dbId, controllers }
// controllers: socketId -> { socket, roles: Set, active } — one device may control both
// characters (for testing on a single phone); 'active' is the one its buttons drive.

const other = (role) => (role === 'fire' ? 'water' : 'fire');

function sendRoles(ctl) {
  ctl.socket.emit('roles', { roles: [...ctl.roles], active: ctl.active });
}

io.on('connection', (socket) => {
  let room = null;
  let ctl = null; // this socket's controller entry

  // msg: { code, level? } — level (1-based) only applies when the room is new.
  socket.on('join', (msg) => {
    if (room) return; // one room per socket
    const code = String((msg && msg.code) || '').toUpperCase();
    if (!ROOM_CODE_RE.test(code)) return socket.emit('error-msg', 'Invalid room code');

    let entry = rooms.get(code);
    if (!entry) {
      const startIndex = msg && Number.isInteger(msg.level) ? msg.level - 1 : 0;
      const mode = msg && msg.mode === 'challenge' ? 'challenge' : 'campaign';
      entry = { state: game.createRoom(code, { startIndex, mode }), dbId: null, controllers: new Map() };
      game.takeEvents(entry.state); // initial 'level' event is covered by 'joined'
      rooms.set(code, entry);
      db.roomCreated(code).then((id) => { entry.dbId = id; });
    }
    room = entry;
    clearTimeout(room.emptyTimer); // someone came back before it expired
    room.emptyTimer = null;
    let role = game.join(room.state, socket.id);
    if (!role) {
      // Room full, but if one device is controlling both, take its spare character.
      for (const c of room.controllers.values()) {
        if (c.roles.size < 2) continue;
        const spare = other(c.active);
        game.release(room.state, spare);
        c.roles.delete(spare);
        sendRoles(c);
        if (game.claim(room.state, spare, socket.id)) role = spare;
        break;
      }
    }
    ctl = { socket, roles: new Set(role ? [role] : []), active: role };
    room.controllers.set(socket.id, ctl);
    socket.join(code);
    const s = room.state;
    socket.emit('joined', {
      code, role, roles: [...ctl.roles], char: P.CHAR, tile: P.TILE,
      mode: s.mode,
      dev: DEV,
      level: { ...s.levelInfo, def: s.levelDef },
      levels: s.mode === 'campaign' ? s.levels.map((l) => ({ name: l.name, world: l.world })) : [],
    });
  });

  // One message per client tick per controlled character: { r: role, s: seq, d: dir, j: jump }
  socket.on('i', (msg) => {
    if (!ctl || !msg) return;
    const role = msg.r || ctl.active;
    if (ctl.roles.has(role)) game.queueInput(room.state, role, msg);
  });

  // Switch to the other character, taking control of it too if nobody else has it.
  socket.on('swap', () => {
    if (!ctl) return;
    const want = ctl.active ? other(ctl.active) : game.ROLES.find((r) => !room.state.players[r].socketId);
    if (!want) return socket.emit('notice', 'Both characters are taken');
    if (!ctl.roles.has(want)) {
      if (!game.claim(room.state, want, socket.id)) {
        return socket.emit('notice', `Your partner is playing ${want === 'fire' ? '🔥 Fire' : '💧 Water'}`);
      }
      ctl.roles.add(want);
    }
    ctl.active = want;
    sendRoles(ctl);
  });

  // Latency probe for the ping readout.
  socket.on('p', (cb) => { if (typeof cb === 'function') cb(); });

  socket.on('restart', () => {
    if (ctl && ctl.roles.size) game.restart(room.state);
  });

  // ── Challenge mode ──
  const owns = (r) => ctl && ctl.roles.has(r);
  socket.on('use', (msg) => { if (room && room.state.mode === 'challenge' && owns(msg && msg.r)) game.C.use(room.state, msg.r); });
  socket.on('equip', (msg) => { if (room && room.state.mode === 'challenge' && msg && owns(msg.r)) game.C.equip(room.state, msg.r, msg.uid); });
  socket.on('map', (msg) => { if (room && room.state.mode === 'challenge' && msg && owns(msg.r)) game.C.act(room.state, msg.r, msg); });
  // Dev only: finish the current room straight away (both treated as at their doors).
  socket.on('dev-skip', () => {
    if (!DEV || !room || room.state.phase !== 'playing') return;
    const s = room.state;
    for (const r of game.ROLES) {
      const e = s.level.exits[r];
      Object.assign(s.players[r].body, { x: e.tx * 24 + 2, y: (e.ty + 1) * 24 - 30, vx: 0, vy: 0, onGround: true });
    }
    s.exitTicks = game.TICKS.exitHold;
    s.skipPause = true; // and no end-of-room pause before the drops
    if (s.run) { s.run.enemies = []; s.run.shots = []; s.run.acid = null; }
  });

  // After a run ends: start a new one in the same room.
  socket.on('newrun', () => {
    if (!room || room.state.mode !== 'challenge' || room.state.phase !== 'over' || !ctl.roles.size) return;
    const old = room.state;
    const fresh = game.createRoom(old.code, { mode: 'challenge' });
    for (const r of game.ROLES) Object.assign(fresh.players[r], { socketId: old.players[r].socketId });
    room.state = fresh;
    io.to(old.code).emit('event', { type: 'level', ...fresh.levelInfo, def: fresh.levelDef });
    game.takeEvents(fresh);
  });

  // Level picker: jump the whole room to level index n (0-based). Campaign only.
  socket.on('goto', (n) => {
    if (!ctl || !ctl.roles.size || room.state.mode !== 'campaign') return;
    if (!Number.isInteger(n) || n < 0 || n >= room.state.levels.length) return;
    game.loadLevel(room.state, n);
  });

  socket.on('disconnect', () => {
    if (!room) return;
    game.leave(room.state, socket.id);
    room.controllers.delete(socket.id);
    if (game.isEmpty(room.state) && io.sockets.adapter.rooms.get(room.state.code) == null) {
      const entry = room;
      clearTimeout(entry.emptyTimer);
      entry.emptyTimer = setTimeout(() => {
        const code = entry.state.code;
        if (rooms.get(code) !== entry || io.sockets.adapter.rooms.get(code) != null) return;
        rooms.delete(code);
        db.roomEnded(entry.dbId);
      }, EMPTY_ROOM_MS);
    }
  });
});

// Fixed-timestep loop: physics at exactly 60 Hz regardless of timer jitter,
// snapshots at ~30 Hz, events as soon as they happen.
let last = performance.now();
let acc = 0;
let lastSnapshot = 0;
setInterval(() => {
  const now = performance.now();
  acc += Math.min(now - last, 250) / 1000; // cap catch-up after a stall
  last = now;
  while (acc >= P.DT) {
    for (const { state } of rooms.values()) game.step(state);
    acc -= P.DT;
  }
  for (const { state } of rooms.values()) {
    for (const e of game.takeEvents(state)) io.to(state.code).emit('event', e);
  }
  if (now - lastSnapshot >= SNAPSHOT_MS) {
    lastSnapshot = now;
    for (const { state } of rooms.values()) io.to(state.code).emit('state', game.snapshot(state));
  }
}, 1000 / 120);

server.listen(PORT, () => console.log(`listening on :${PORT}`));
