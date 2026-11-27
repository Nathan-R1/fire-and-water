// The client predicts its own character by replaying unacknowledged inputs on top of
// the server's state. That only works if the server applies exactly one physics step
// per input, in order. These tests check that contract, including under jittery delivery.

const test = require('node:test');
const assert = require('node:assert');
const P = require('../shared/physics');
const g = require('../src/game');

const LV = { id: 'net', name: 'net', rows: [
  '########################',
  '#......................#',
  '#......................#',
  '#........####..........#',
  '#......................#',
  '#F...............W..fw.#',
  '########################',
] };

function newRoom() {
  const r = g.createRoom('NETT', { levels: [LV] });
  g.join(r, 'a');
  g.join(r, 'b');
  g.takeEvents(r);
  return r;
}

test('queueInput rejects bad and out-of-order messages', () => {
  const r = newRoom();
  g.queueInput(r, 'fire', { s: 1, d: 1, j: false });
  g.queueInput(r, 'fire', { s: 1, d: 1 });          // duplicate
  g.queueInput(r, 'fire', { s: 0, d: 1 });          // old
  g.queueInput(r, 'fire', { s: 2, d: 7 });          // bad dir
  g.queueInput(r, 'fire', { s: 2.5, d: 1 });        // bad seq
  g.queueInput(r, 'fire', null);
  g.queueInput(r, 'nobody', { s: 3, d: 1 });
  assert.equal(r.players.fire.queue.length, 1);
});

test('one physics step per input: ack advances one per tick', () => {
  const r = newRoom();
  for (let s = 1; s <= 3; s++) g.queueInput(r, 'fire', { s, d: 1, j: false });
  g.step(r);
  assert.equal(r.players.fire.ack, 1);
  g.step(r);
  assert.equal(r.players.fire.ack, 2);
});

test('a stalled character waits, then stops rather than walking on its old input', () => {
  const r = newRoom();
  for (let s = 1; s <= 20; s++) { g.queueInput(r, 'fire', { s, d: 1, j: false }); g.step(r); } // full speed, queue empty
  const x = r.players.fire.body.x;
  for (let i = 0; i < g.MAX_WAIT; i++) g.step(r);
  assert.equal(r.players.fire.body.x, x, 'frozen while waiting');
  for (let i = 0; i < 60; i++) g.step(r);
  const b = r.players.fire.body;
  assert.equal(b.vx, 0, 'stopped');
  assert.ok(b.x - x < 12, `slid only ${(b.x - x).toFixed(1)}px`);
});

test('a backlog is worked off two inputs per tick', () => {
  const r = newRoom();
  for (let s = 1; s <= 10; s++) g.queueInput(r, 'fire', { s, d: 1, j: false });
  g.step(r);
  assert.equal(r.players.fire.ack, 2);
});

test('inputs during a pause are acknowledged and ignored', () => {
  const r = newRoom();
  r.phase = 'dead';
  g.queueInput(r, 'fire', { s: 1, d: 1, j: true });
  const x = r.players.fire.body.x;
  g.step(r);
  assert.equal(r.players.fire.ack, 1);
  assert.equal(r.players.fire.queue.length, 0);
  assert.equal(r.players.fire.body.x, x);
});

// Client-side prediction as in public/client.js, against the real game loop, with
// inputs and snapshots delivered late and in bursts (but in order, like TCP).
function predictionErrors(maxJitterTicks, seed) {
  let rnd = seed;
  const rand = () => (rnd = (rnd * 16807) % 2147483647) / 2147483647;
  const r = newRoom();
  const level = r.level;
  let target = null, me = null, pending = [], seq = 0, upAt = 0, downAt = 0;
  const up = [], down = [], predicted = new Map();
  let errors = 0, compared = 0;
  const toInput = (d) => ({ left: d < 0, right: d > 0 });
  const step = (inp) => { if (inp.j) P.pressJump(me); P.stepBody(level, me, toInput(inp.d), [target.water], P.DT, target); };
  const script = (t) => ({ d: t < 50 ? 1 : t < 100 ? -1 : (t % 40 < 20 ? 1 : -1), j: t % 23 === 5 });

  for (let t = 0; t < 360; t++) {
    if (t < 240) {
      const sc = script(t);
      const inp = { s: ++seq, d: sc.d, j: sc.j };
      upAt = Math.max(upAt, t + 3 + Math.floor(rand() * maxJitterTicks));
      up.push([upAt, inp]);
      if (!target || target.phase === 'playing') {
        pending.push(inp);
        if (me) { step(inp); predicted.set(inp.s, { x: me.x, y: me.y }); }
      }
    }
    while (up.length && up[0][0] <= t) g.queueInput(r, 'fire', up.shift()[1]);
    g.queueInput(r, 'water', { s: t + 1, d: 0, j: false });
    g.step(r);
    g.takeEvents(r);
    if (t % 2 === 0) {
      downAt = Math.max(downAt, t + 3 + Math.floor(rand() * maxJitterTicks));
      down.push([downAt, JSON.parse(JSON.stringify(g.snapshot(r)))]);
    }
    while (down.length && down[0][0] <= t) {
      const s = down.shift()[1];
      target = s;
      const srv = s.fire;
      const p = predicted.get(srv.ack);
      // Once the script stops sending, the server moves on by itself (by design).
      if (p && s.phase === 'playing' && t < 240) {
        compared++;
        if (Math.hypot(p.x - srv.x, p.y - srv.y) > 1e-6) errors++;
      }
      me = { x: srv.x, y: srv.y, vx: srv.vx, vy: srv.vy, onGround: srv.onGround, coyoteT: srv.coyoteT, bufferT: srv.bufferT };
      pending = pending.filter((q) => q.s > srv.ack);
      if (s.phase === 'playing') for (const q of pending) step(q);
    }
  }
  return { errors, compared };
}

for (const jitter of [0, 4, g.MAX_WAIT - 1]) {
  test(`prediction matches the server exactly with up to ${jitter} ticks of jitter`, () => {
    for (const seed of [1, 7, 42]) {
      const { errors, compared } = predictionErrors(jitter, seed);
      assert.ok(compared > 50, `compared ${compared}`);
      assert.equal(errors, 0, `seed ${seed}`);
    }
  });
}

test('a predicted death happens on the same input as the server death', () => {
  const LAVA = { id: 'lava', name: 'lava', rows: [
    '############',
    '#..........#',
    '#F.W.....fw#',
    '#.....LL####',
    '############',
  ].map((row, i) => (i === 3 ? '######LL####' : row)) };
  const r = g.createRoom('NETL', { levels: [LAVA] });
  g.join(r, 'a'); g.join(r, 'b'); g.takeEvents(r);
  // Client side: predict water walking right from the spawn until a hazard is hit.
  const me = P.createBody(r.level.spawns.water);
  let predictedSeq = null;
  for (let s = 1; s <= 60 && !predictedSeq; s++) {
    P.stepBody(r.level, me, { left: false, right: true }, [r.players.fire.body], P.DT, r.state);
    if (P.hazardUnder(r.level, me, 'water')) predictedSeq = s;
  }
  assert.ok(predictedSeq, 'prediction hit the lava');
  // Server side: same inputs.
  let deathAck = null;
  for (let s = 1; s <= 60 && !deathAck; s++) {
    g.queueInput(r, 'water', { s, d: 1, j: false });
    g.queueInput(r, 'fire', { s, d: 0, j: false });
    g.step(r);
    if (g.takeEvents(r).some((e) => e.type === 'death' && e.role === 'water')) deathAck = r.players.water.ack;
  }
  assert.equal(deathAck, predictedSeq);
});

// Same contract with boxes and pulleys: the client predicts the environment too
// (as public/client.js does: stepEnv on a cloned snapshot, then the character).
function envPredictionErrors(levelDef, script, steps, role = 'water') {
  const other = role === 'fire' ? 'water' : 'fire';
  const r = g.createRoom('NETE', { levels: [levelDef] });
  g.join(r, 'a'); g.join(r, 'b'); g.takeEvents(r);
  const level = r.level;
  let snap = null, me = null, local = null, partner = null, pending = [], seq = 0;
  const predicted = new Map();
  let errors = 0, compared = 0, worst = 0;
  const step = (inp) => {
    if (inp.j) P.pressJump(me);
    P.stepEnv(level, local, [me, partner]);
    P.stepBody(level, me, { left: inp.d < 0, right: inp.d > 0 }, [partner], P.DT, local);
  };
  const inFlight = [];
  for (let t = 0; t < steps; t++) {
    const sc = script(t);
    const inp = { s: ++seq, d: sc.d, j: !!sc.j };
    pending.push(inp);
    if (me) { step(inp); predicted.set(inp.s, { x: me.x, y: me.y }); }
    inFlight.push([t + 4, inp]);
    while (inFlight.length && inFlight[0][0] <= t) g.queueInput(r, role, inFlight.shift()[1]);
    g.queueInput(r, other, { s: t + 1, d: 0, j: false });
    g.step(r); g.takeEvents(r);
    if (t % 2 === 0) {
      snap = JSON.parse(JSON.stringify(g.snapshot(r)));
      const srv = snap[role];
      const p = predicted.get(srv.ack);
      if (p && snap.phase === 'playing') {
        compared++;
        const e = Math.hypot(p.x - srv.x, p.y - srv.y);
        worst = Math.max(worst, e);
        if (e > 1e-6) errors++;
      }
      me = { x: srv.x, y: srv.y, vx: srv.vx, vy: srv.vy, onGround: srv.onGround, coyoteT: srv.coyoteT, bufferT: srv.bufferT, pushing: srv.pushing };
      local = P.cloneState(snap);
      partner = { x: snap[other].x, y: snap[other].y, vx: 0, vy: 0, onGround: true };
      pending = pending.filter((q) => q.s > srv.ack);
      for (const q of pending) step(q);
    }
  }
  return { errors, compared, worst, room: r };
}

test('prediction matches the server exactly while pushing a box', () => {
  const def = g.LEVELS.find((l) => l.id.startsWith('33'));
  const { errors, compared, room } = envPredictionErrors(def, (t) => ({ d: t < 200 ? 1 : 0, j: t === 210 }), 260);
  assert.ok(room.state.boxes[0].x > 12 * P.TILE, 'the box was pushed');
  assert.ok(compared > 50);
  assert.equal(errors, 0);
});

test('prediction stays exact riding a pulley down', () => {
  const def = g.LEVELS.find((l) => l.id.startsWith('41'));
  // walk right off the ledge onto the platform, ride it down, then walk under the wall
  const { worst, compared, room } = envPredictionErrors(def, (t) => ({ d: t < 40 || t > 420 ? 1 : 0 }), 480);
  assert.ok(room.state.pulleys[0].o > 0, 'the platform went down');
  assert.ok(compared > 100);
  assert.ok(worst < 1e-6, `worst error ${worst}`);
});
