// Room state and game rules: who controls which character, the current level,
// deaths, gems, exits and moving on to the next level. No I/O, so it's unit testable.
// Anything the clients need to react to once (sounds, banners) goes in room.events.

const fs = require('fs');
const path = require('path');
const P = require('../shared/physics');
const C = require('./challenge');

const ROLES = ['fire', 'water'];
const TICKS = { exitHold: 30, deathPause: 60, completePause: 180 }; // at 60 Hz
// Per-player input buffer. Clients send one input per 60 Hz tick and the server steps
// each character once per input, so the client can predict its own character exactly.
// If inputs arrive late the character waits (up to MAX_WAIT ticks) instead of moving on
// a guess. After that it only stops: it never keeps walking on an old input, so a
// delayed jump can't walk you into lava. When inputs pile up it applies two per tick.
const MAX_WAIT = 30; // 0.5 s
const CATCH_UP_AT = 3;
const MAX_QUEUE = 120;

const LEVEL_DIR = path.join(__dirname, '..', 'levels');
const LEVELS = fs.readdirSync(LEVEL_DIR)
  .filter((f) => /^\d{2}-.*\.json$/.test(f))
  .sort()
  .map((f) => JSON.parse(fs.readFileSync(path.join(LEVEL_DIR, f), 'utf8')));

// mode: 'campaign' (the 64 levels in order) or 'challenge' (a roguelike run, see challenge.js)
function createRoom(code, { levels = LEVELS, startIndex = 0, mode = 'campaign', seed } = {}) {
  const room = {
    code,
    mode,
    levels,
    levelIndex: Math.max(0, Math.min(startIndex, levels.length - 1)),
    loadId: 0, // bumps on every level load, so clients can drop stale snapshots
    players: {},
    events: [],
  };
  for (const role of ROLES) room.players[role] = newPlayer();
  if (mode === 'challenge') {
    room.run = C.createRun(seed);
    room.loadStage = () => C.loadStage(room, (def, info) => loadDef(room, def, info));
    C.start(room, (def, info) => loadDef(room, def, info));
  } else {
    loadLevel(room, room.levelIndex);
  }
  return room;
}

function loadLevel(room, index) {
  room.levelIndex = index;
  loadDef(room, room.levels[index], { index, total: room.levels.length });
}

function loadDef(room, def, info) {
  room.levelDef = def;
  room.level = P.parseLevel(def);
  room.deaths = 0;
  room.loadId++;
  room.levelInfo = { ...info, load: room.loadId };
  resetAttempt(room);
  room.events.push({ type: 'level', ...room.levelInfo, def });
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
  if (room.mode === 'challenge' && room.enemySpecs) C.onAttempt(room);
}

function newPlayer() {
  return { socketId: null, input: { left: false, right: false }, body: null, queue: [], lastSeq: 0, ack: 0, waited: 0 };
}

// Take control of a specific character if nobody has it. Returns true on success.
function claim(room, role, socketId) {
  if (!ROLES.includes(role)) return false;
  const p = room.players[role];
  if (p.socketId) return p.socketId === socketId;
  p.socketId = socketId;
  p.queue = [];
  p.lastSeq = 0;
  p.ack = 0;
  return true;
}

// Give up control of one character (it stands still until someone claims it).
function release(room, role) {
  if (!ROLES.includes(role)) return;
  const p = room.players[role];
  p.socketId = null;
  p.input = { left: false, right: false };
  p.queue = [];
}

// Assign the first free role, or null if the room is full (spectator).
function join(room, socketId) {
  return ROLES.find((role) => claim(room, role, socketId)) || null;
}

function leave(room, socketId) {
  for (const role of ROLES) if (room.players[role].socketId === socketId) release(room, role);
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
      if (p.socketId) {
        if (++p.waited <= MAX_WAIT) continue; // wait for the late input
        p.input = { left: false, right: false }; // stalled too long: stand still
      }
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
  if (room.phase === 'map' || room.phase === 'over') return; // challenge: between rooms / run ended
  if (room.phase === 'dead') {
    if (++room.phaseTicks >= TICKS.deathPause) {
      if (room.mode === 'challenge' && room.run.hearts <= 0) {
        room.run.result = 'defeat';
        room.phase = 'over';
        room.events.push({ type: 'run-over', result: 'defeat' });
        return;
      }
      resetAttempt(room);
      room.events.push({ type: 'restart' });
    }
    return;
  }
  if (room.phase === 'complete') {
    if (++room.phaseTicks >= TICKS.completePause) {
      if (room.mode === 'challenge') C.onComplete(room);
      else loadLevel(room, (room.levelIndex + 1) % room.levels.length);
    }
    return;
  }

  // Challenge: each attempt waits for someone to move before enemies and the clock start.
  const waiting = room.mode === 'challenge' && !room.run.started;
  if (!waiting) room.tick++;
  const bodies = ROLES.map((r) => room.players[r].body);
  P.stepEnv(room.level, room.state, bodies);
  for (const [role, inp] of nextSteps(room)) {
    const p = room.players[role];
    if (inp) {
      p.ack = inp.s;
      p.input = { left: inp.d === -1, right: inp.d === 1 };
      if (inp.j) P.pressJump(p.body);
      if (waiting && (inp.d !== 0 || inp.j)) room.run.started = true;
    }
    P.stepBody(room.level, p.body, p.input, bodies.filter((b) => b !== p.body), P.DT, room.state);
  }

  const hits = room.mode === 'challenge' && room.run.started ? C.updateEnemies(room, P.DT) : [];
  for (const role of ROLES) {
    const body = room.players[role].body;
    const killer = P.hazardUnder(room.level, body, role) || (hits.find((h) => h.role === role) || {}).cause;
    if (killer && !(room.mode === 'challenge' && C.absorb(room, role))) {
      room.phase = 'dead';
      room.phaseTicks = 0;
      room.deaths++;
      if (room.mode === 'challenge') room.run.hearts--;
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
      label: room.levelInfo.label,
      timeMs: Math.round(room.tick * P.DT * 1000),
      gems: room.state.gems.filter(Boolean).length,
      totalGems: room.level.gems.length,
      deaths: room.deaths,
      last: room.mode === 'campaign' && room.levelIndex === room.levels.length - 1,
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
      onGround: body.onGround, coyoteT: body.coyoteT, bufferT: body.bufferT, pushing: !!body.pushing,
      jumpMul: body.jumpMul || 1, speedMul: body.speedMul || 1, maxAirJumps: body.maxAirJumps || 0,
      airJumps: body.airJumps || 0, flyT: body.flyT || 0, acidImmune: !!body.acidImmune, magnet: body.magnet || 0,
      ack, connected: !!socketId,
    };
  }
  return {
    ...chars,
    mode: room.mode,
    level: room.loadId,
    run: room.mode === 'challenge' ? C.view(room) : undefined,
    tick: room.tick,
    phase: room.phase,
    timeMs: Math.round(room.tick * P.DT * 1000),
    gems: room.state.gems,
    plates: room.state.plates,
    levers: room.state.levers,
    gates: room.state.gates,
    boxes: room.state.boxes.map((b) => ({ x: b.x, y: b.y, vy: b.vy, onGround: b.onGround })),
    pulleys: room.state.pulleys.map((p) => p.o),
    geysers: room.state.geysers || [],
    blocks: room.state.blocks || [],
  };
}

function takeEvents(room) {
  const e = room.events;
  room.events = [];
  return e;
}

module.exports = {
  ROLES, TICKS, LEVELS, MAX_WAIT, C, createRoom, loadLevel, claim, release, join, leave, isEmpty, setInput, queueInput, jump, restart, step, snapshot, takeEvents,
};
