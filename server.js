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

const app = express();
app.use(express.static(path.join(__dirname, 'public')));
app.use('/shared', express.static(path.join(__dirname, 'shared')));
app.get('/healthz', (_req, res) => res.json({ ok: true, db: db.enabled }));

const server = http.createServer(app);
const io = new Server(server);

const rooms = new Map(); // code -> { state, dbId }

io.on('connection', (socket) => {
  let room = null;
  let role = null;

  socket.on('join', (rawCode) => {
    if (room) return; // one room per socket
    const code = String(rawCode || '').toUpperCase();
    if (!ROOM_CODE_RE.test(code)) return socket.emit('error-msg', 'Invalid room code');

    let entry = rooms.get(code);
    if (!entry) {
      entry = { state: game.createRoom(code), dbId: null };
      rooms.set(code, entry);
      db.roomCreated(code).then((id) => { entry.dbId = id; });
    }
    room = entry;
    role = game.join(room.state, socket.id);
    socket.join(code);
    socket.emit('joined', { code, role, level: room.state.levelDef, char: P.CHAR, tile: P.TILE });
  });

  socket.on('input', (dir) => {
    if (room && role) game.setInput(room.state, role, dir);
  });

  socket.on('jump', () => {
    if (room && role) game.jump(room.state, role);
  });

  socket.on('disconnect', () => {
    if (!room) return;
    game.leave(room.state, socket.id);
    if (game.isEmpty(room.state) && io.sockets.adapter.rooms.get(room.state.code) == null) {
      rooms.delete(room.state.code);
      db.roomEnded(room.dbId);
    }
  });
});

// Fixed-timestep loop: physics at exactly 60 Hz regardless of timer jitter,
// snapshots at ~30 Hz.
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
  if (now - lastSnapshot >= SNAPSHOT_MS) {
    lastSnapshot = now;
    for (const { state } of rooms.values()) io.to(state.code).emit('state', game.snapshot(state));
  }
}, 1000 / 120);

server.listen(PORT, () => console.log(`listening on :${PORT}`));
