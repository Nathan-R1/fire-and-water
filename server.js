const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const game = require('./src/game');
const db = require('./src/db');

const PORT = process.env.PORT || 3000;
const TICK_HZ = 30;
const ROOM_CODE_RE = /^[A-Z0-9]{4,8}$/;

const app = express();
app.use(express.static(path.join(__dirname, 'public')));
app.get('/healthz', (_req, res) => res.json({ ok: true, db: db.enabled }));

const server = http.createServer(app);
const io = new Server(server);

const rooms = new Map(); // code -> { state, dbId }

io.on('connection', (socket) => {
  let room = null;
  let role = null;

  socket.on('join', async (rawCode) => {
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
    socket.emit('joined', { code, role, world: game.WORLD, player: game.PLAYER });
  });

  socket.on('input', (dir) => {
    if (room && role) game.setInput(room.state, role, dir);
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

let last = Date.now();
setInterval(() => {
  const now = Date.now();
  const dt = (now - last) / 1000;
  last = now;
  for (const { state } of rooms.values()) {
    game.step(state, dt);
    io.to(state.code).emit('state', game.snapshot(state));
  }
}, 1000 / TICK_HZ);

server.listen(PORT, () => console.log(`listening on :${PORT}`));
