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

test('a character with no input waits instead of guessing, then carries on', () => {
  const r = newRoom();
  g.queueInput(r, 'fire', { s: 1, d: 1, j: false });
  g.step(r);
  const x = r.players.fire.body.x;
  for (let i = 0; i < g.MAX_WAIT; i++) g.step(r);
  assert.equal(r.players.fire.body.x, x, 'frozen while waiting');
  g.step(r);
  assert.ok(r.players.fire.body.x > x, 'moves on its last input after MAX_WAIT');
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
