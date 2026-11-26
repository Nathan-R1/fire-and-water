// Pure game state + physics. No I/O, so it can be unit tested.

const WORLD = { width: 960, height: 540, floorY: 460 };
const PLAYER = { width: 40, height: 60, speed: 240 }; // speed in px/sec
const ROLES = ['fire', 'water'];

function createRoom(code) {
  return {
    code,
    players: {
      fire: { x: 200, y: WORLD.floorY - PLAYER.height, dir: 0, socketId: null },
      water: { x: 720, y: WORLD.floorY - PLAYER.height, dir: 0, socketId: null },
    },
  };
}

// Assign the first free role, or null if the room is full (spectator).
function join(room, socketId) {
  for (const role of ROLES) {
    if (!room.players[role].socketId) {
      room.players[role].socketId = socketId;
      return role;
    }
  }
  return null;
}

function leave(room, socketId) {
  for (const role of ROLES) {
    const p = room.players[role];
    if (p.socketId === socketId) {
      p.socketId = null;
      p.dir = 0;
    }
  }
}

function isEmpty(room) {
  return ROLES.every((r) => !room.players[r].socketId);
}

// dir: -1 left, 0 stop, 1 right
function setInput(room, role, dir) {
  if (!ROLES.includes(role)) return;
  if (dir !== -1 && dir !== 0 && dir !== 1) return;
  room.players[role].dir = dir;
}

function step(room, dt) {
  for (const role of ROLES) {
    const p = room.players[role];
    p.x += p.dir * PLAYER.speed * dt;
    p.x = Math.max(0, Math.min(WORLD.width - PLAYER.width, p.x));
  }
}

function snapshot(room) {
  const out = {};
  for (const role of ROLES) {
    const { x, y, dir, socketId } = room.players[role];
    out[role] = { x, y, dir, connected: !!socketId };
  }
  return out;
}

module.exports = { WORLD, PLAYER, ROLES, createRoom, join, leave, isEmpty, setInput, step, snapshot };
