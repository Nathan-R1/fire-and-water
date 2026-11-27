// Room state and game rules: who controls which character, the current level,
// deaths, gems, exits and moving on to the next level. No I/O, so it's unit testable.
// Anything the clients need to react to once (sounds, banners) goes in room.events.

const fs = require('fs');
const path = require('path');
const P = require('../shared/physics');

const ROLES = ['fire', 'water'];
const TICKS = { exitHold: 30, deathPause: 60, completePause: 180 }; // at 60 Hz
// Per-player input buffer. Clients send one input per 60 Hz tick and the server steps
// each character once per input, so the client can predict its own character exactly.
// If inputs arrive late the character waits (up to MAX_WAIT ticks) instead of moving on
// a guess; after that it carries on with its last input (e.g. connection dropped).
// When inputs pile up it applies two per tick to catch up.
const MAX_WAIT = 8;
const CATCH_UP_AT = 3;
const MAX_QUEUE = 120;

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
  for (const role of ROLES) room.players[role] = newPlayer();
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

function newPlayer() {
  return { socketId: null, input: { left: false, right: false }, body: null, queue: [], lastSeq: 0, ack: 0, waited: 0 };
}

// Assign the first free role, or null if the room is full (spectator).
function join(room, socketId) {
  for (const role of ROLES) {
    if (!room.players[role].socketId) {
      const p = room.players[role];
      p.socketId = socketId;
      p.queue = [];
      p.lastSeq = 0;
      p.ack = 0;
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
      p.queue = [];
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

// Queue one tick of input from a client: { s: seq, d: -1|0|1, j: bool }.
function queueInput(room, role, msg) {
  if (!ROLES.includes(role) || !msg) return;
  const p = room.players[role];
  const { s, d } = msg;
  if (!Number.isInteger(s) || s <= p.lastSeq) return;
  if (d !== -1 && d !== 0 && d !== 1) return;
  p.lastSeq = s;
  p.queue.push({ s, d, j: msg.j === true });
  if (p.queue.length > MAX_QUEUE) p.queue.shift();
}

// Inputs during pauses (death, level complete) are acknowledged and ignored.
function discardInputs(room) {
  for (const role of ROLES) {
    const p = room.players[role];
    if (p.queue.length) p.ack = p.queue[p.queue.length - 1].s;
    p.queue = [];
    p.waited = 0;
  }
}

// How many physics steps each character takes this tick, applying queued inputs.
// Returns a list of [role, input] per step. Players with no socket always step
// (with no input) so a disconnected character still falls and settles.
function nextSteps(room) {
  const steps = [];
  for (const role of ROLES) {
    const p = room.players[role];
    const n = p.queue.length > CATCH_UP_AT ? 2 : p.queue.length ? 1 : 0;
    if (n === 0) {
      if (p.socketId && ++p.waited <= MAX_WAIT) continue; // wait for the late input
      steps.push([role, null]);
      continue;
    }
    p.waited = 0;
    for (let k = 0; k < n; k++) steps.push([role, p.queue.shift()]);
  }
  return steps;
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
  if (room.phase !== 'playing') discardInputs(room);
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
  P.updateMechanisms(room.level, room.state, bodies);
  for (const [role, inp] of nextSteps(room)) {
    const p = room.players[role];
    if (inp) {
      p.ack = inp.s;
      p.input = { left: inp.d === -1, right: inp.d === 1 };
      if (inp.j) P.pressJump(p.body);
    }
    P.stepBody(room.level, p.body, p.input, bodies.filter((b) => b !== p.body), P.DT, room.state);
  }

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
    const { body, socketId, ack } = room.players[role];
    chars[role] = {
      x: body.x, y: body.y, vx: body.vx, vy: body.vy,
      onGround: body.onGround, coyoteT: body.coyoteT, bufferT: body.bufferT,
      ack, connected: !!socketId,
    };
  }
  return {
    ...chars,
    level: room.levelIndex,
    tick: room.tick,
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
  ROLES, TICKS, LEVELS, MAX_WAIT, createRoom, loadLevel, join, leave, isEmpty, setInput, queueInput, jump, restart, step, snapshot, takeEvents,
};
