// Room state and game rules: who controls which character, the current level,
// deaths, gems, exits and moving on to the next level. No I/O, so it's unit testable.
// Anything the clients need to react to once (sounds, banners) goes in room.events.

const fs = require('fs');
const path = require('path');
const P = require('../shared/physics');

const ROLES = ['fire', 'water'];
const TICKS = { exitHold: 30, deathPause: 60, completePause: 180 }; // at 60 Hz

const LEVEL_DIR = path.join(__dirname, '..', 'levels');
const LEVELS = fs.readdirSync(LEVEL_DIR)
  .filter((f) => /^\d{2}-.*\.json$/.test(f))
  .sort()
  .map((f) => JSON.parse(fs.readFileSync(path.join(LEVEL_DIR, f), 'utf8')));

function createRoom(code, { levels = LEVELS, startIndex = 0 } = {}) {
  const room = {
    code,
    levels,
    levelIndex: Math.max(0, Math.min(startIndex, levels.length - 1)),
    players: {},
    events: [],
  };
  for (const role of ROLES) room.players[role] = { socketId: null, input: { left: false, right: false }, body: null };
  loadLevel(room, room.levelIndex);
  return room;
}

function loadLevel(room, index) {
  room.levelIndex = index;
  room.levelDef = room.levels[index];
  room.level = P.parseLevel(room.levelDef);
  room.deaths = 0;
  resetAttempt(room);
  room.events.push({ type: 'level', index, total: room.levels.length, def: room.levelDef });
}

// Put everyone back at the start of the current level.
function resetAttempt(room) {
  room.state = P.createLevelState(room.level);
  room.tick = 0;
  room.phase = 'playing';
  room.phaseTicks = 0;
  room.exitTicks = 0;
  room.result = null;
  for (const role of ROLES) {
    room.players[role].body = P.createBody(room.level.spawns[role]);
  }
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
  if (!ROLES.includes(role) || room.phase !== 'playing') return;
  P.pressJump(room.players[role].body);
}

function restart(room) {
  if (room.phase !== 'playing') return;
  resetAttempt(room);
  room.events.push({ type: 'restart' });
}

// Advance one fixed physics step.
function step(room) {
  if (room.phase === 'dead') {
    if (++room.phaseTicks >= TICKS.deathPause) {
      resetAttempt(room);
      room.events.push({ type: 'restart' });
    }
    return;
  }
  if (room.phase === 'complete') {
    if (++room.phaseTicks >= TICKS.completePause) {
      loadLevel(room, (room.levelIndex + 1) % room.levels.length);
    }
    return;
  }

  room.tick++;
  const bodies = ROLES.map((r) => room.players[r].body);
  P.stepWorld(room.level, bodies, ROLES.map((r) => room.players[r].input), P.DT, room.state);

  for (const role of ROLES) {
    const body = room.players[role].body;
    const killer = P.hazardUnder(room.level, body, role);
    if (killer) {
      room.phase = 'dead';
      room.phaseTicks = 0;
      room.deaths++;
      room.events.push({ type: 'death', role, cause: killer });
      return;
    }
    for (const i of P.collectGems(room.level, room.state, body, role)) room.events.push({ type: 'gem', role, index: i });
  }

  const bothIn = ROLES.every((r) => P.atExit(room.level, room.players[r].body, r));
  room.exitTicks = bothIn ? room.exitTicks + 1 : 0;
  if (room.exitTicks >= TICKS.exitHold) {
    room.phase = 'complete';
    room.phaseTicks = 0;
    room.result = {
      index: room.levelIndex,
      timeMs: Math.round(room.tick * P.DT * 1000),
      gems: room.state.gems.filter(Boolean).length,
      totalGems: room.level.gems.length,
      deaths: room.deaths,
      last: room.levelIndex === room.levels.length - 1,
    };
    room.events.push({ type: 'complete', ...room.result });
  }
}

function snapshot(room) {
  const chars = {};
  for (const role of ROLES) {
    const { body, socketId } = room.players[role];
    chars[role] = { x: body.x, y: body.y, vx: body.vx, vy: body.vy, onGround: body.onGround, connected: !!socketId };
  }
  return {
    ...chars,
    level: room.levelIndex,
    phase: room.phase,
    timeMs: Math.round(room.tick * P.DT * 1000),
    gems: room.state.gems,
    plates: room.state.plates,
    levers: room.state.levers,
    gates: room.state.gates,
  };
}

function takeEvents(room) {
  const e = room.events;
  room.events = [];
  return e;
}

module.exports = {
  ROLES, TICKS, LEVELS, createRoom, loadLevel, join, leave, isEmpty, setInput, jump, restart, step, snapshot, takeEvents,
};
