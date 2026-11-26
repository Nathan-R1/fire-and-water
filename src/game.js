// Room state: who controls which character, their inputs, and the physics world.
// No I/O here, so it can be unit tested.

const P = require('../shared/physics');
const DEFAULT_LEVEL = require('../levels/test-01.json');

const ROLES = ['fire', 'water'];

function createRoom(code, levelDef = DEFAULT_LEVEL) {
  const level = P.parseLevel(levelDef);
  const players = {};
  for (const role of ROLES) {
    players[role] = { body: P.createBody(level.spawns[role]), input: { left: false, right: false }, socketId: null };
  }
  return { code, levelDef, level, players };
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
      p.input = { left: false, right: false };
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
  room.players[role].input = { left: dir === -1, right: dir === 1 };
}

function jump(room, role) {
  if (!ROLES.includes(role)) return;
  P.pressJump(room.players[role].body);
}

// Advance one fixed physics step.
function step(room) {
  P.stepWorld(
    room.level,
    ROLES.map((r) => room.players[r].body),
    ROLES.map((r) => room.players[r].input),
  );
}

function snapshot(room) {
  const out = {};
  for (const role of ROLES) {
    const { body, socketId } = room.players[role];
    out[role] = { x: body.x, y: body.y, vx: body.vx, vy: body.vy, onGround: body.onGround, connected: !!socketId };
  }
  return out;
}

module.exports = { ROLES, createRoom, join, leave, isEmpty, setInput, jump, step, snapshot };
