// The client predicts fixed-rule enemies with shared/enemies.js. Starting from a
// snapshot, its prediction must land exactly where the server's enemies really are.
const test = require('node:test');
const assert = require('node:assert');
const P = require('../shared/physics');
const E = require('../shared/enemies');
const g = require('../src/game');
const C = require('../src/challenge');

const T = P.TILE;

function run(seed) {
  const r = g.createRoom('PRED', { mode: 'challenge', seed });
  g.join(r, 'a'); g.join(r, 'b');
  g.takeEvents(r);
  return r;
}
let seq = 0;
const tick = (r, n = 1) => {
  for (let i = 0; i < n; i++) {
    seq++;
    for (const role of g.ROLES) g.queueInput(r, role, { s: seq, d: 0, j: false });
    g.step(r);
  }
};
const safe = (r) => { for (const role of g.ROLES) r.run.invuln[role] = 1e9; };

// What the client starts from: a snapshot, through JSON like the real network.
const snap = (r) => JSON.parse(JSON.stringify(g.snapshot(r)));
const predicted = (s) => ({
  started: s.run.started, time: s.run.time, slow: s.run.slow,
  enemies: s.run.enemies, shots: s.run.shots, bullets: s.run.bullets, acid: s.run.acid, weather: s.run.weather,
});
const close = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-6, `${msg}: ${a} vs ${b}`);

function checkMatches(r, pr) {
  for (const e of r.run.enemies.filter((x) => !x.dead && E.PREDICTED.has(x.type))) {
    const p = pr.enemies.find((x) => x.id === e.id);
    assert.ok(p, `enemy ${e.id} predicted`);
    const a = E.view(e), b = E.view(p);
    for (const k of ['x', 'y', 'w', 'h']) close(b[k], a[k], `${e.type} ${e.id} ${k}`);
  }
  close(pr.time, r.run.time, 'enemy clock');
}

test('predicting boss 1 forward from a snapshot matches the server (flyer, growing walker)', () => {
  const r = run(12);
  r.run.stage = 4; r.loadStage(); g.takeEvents(r);
  safe(r);
  r.run.started = true;
  tick(r, 30);
  const s = snap(r);
  const pr = predicted(s);
  const state = P.cloneState(s);
  for (let i = 0; i < 40; i++) E.predict(pr, P.DT, r.level, state);
  tick(r, 40);
  checkMatches(r, pr);
});

test('predicting patrols, bombs in flight and slow time matches the server', () => {
  const r = run(42);
  const rows = ['####################', '#..................#', '#..................#', '#..................#', '#......#####.......#', '#..................#', '#F...............Wfw', '####################'];
  const def = { id: 'arena', name: 'arena', rows };
  r.levelDef = def; r.level = P.parseLevel(def); r.state = P.createLevelState(r.level);
  for (const role of g.ROLES) r.players[role].body = P.createBody(r.level.spawns[role]);
  r.enemySpecs = [
    { type: 'patrol', x0: 2 * T, x1: 16 * T, y: 6 * T - 20, w: 20, h: 20, speed: 45, x: 3 * T },
    { type: 'flyer', x0: T, x1: 17 * T, y: 2 * T, w: 26, h: 18, speed: 70, amp: 12, x: 2 * T },
  ];
  C.onAttempt(r);
  safe(r);
  C.grant(r, 'slowtime', null);
  r.run.started = true;
  r.players.fire.body.x = 1e5; r.players.water.body.x = 1e5; // nobody under the bombs
  // a falling bomb, as if the bomber had just dropped it
  r.run.shots.push({ id: 99, x: 9 * T, y: T + 20, vx: 0, vy: 40, g: 900, kind: 'bomb' });
  tick(r, 1);
  const s = snap(r);
  assert.ok(s.run.slow < 1, 'slow time on');
  const pr = predicted(s);
  const state = P.cloneState(s);
  for (let i = 0; i < 90; i++) E.predict(pr, P.DT, r.level, state);
  tick(r, 90);
  checkMatches(r, pr);
  assert.deepEqual(pr.shots.map((x) => x.id), r.run.shots.map((x) => x.id), 'the bomb hit the platform on both');
});

test('predicting boss 2: the acid countdown and burn line up with the server', () => {
  const r = run(7);
  r.run.stage = 9; r.loadStage(); g.takeEvents(r);
  safe(r);
  r.run.started = true;
  tick(r, 10);
  assert.ok(r.run.acid, 'boss 2 has the acid floor');
  const s = snap(r);
  const pr = predicted(s);
  const state = P.cloneState(s);
  // through a whole cycle: countdown, burn, quiet
  for (let i = 0; i < 60 * 9; i++) {
    E.predict(pr, P.DT, r.level, state);
    tick(r, 1);
    if (r.phase !== 'playing') break;
    for (const k of ['next', 'countdown', 'burning']) close(pr.acid[k] ?? 0, r.run.acid[k] ?? 0, `acid ${k} at step ${i}`);
  }
});

test('nothing moves until the room has started', () => {
  const r = run(12);
  r.run.stage = 4; r.loadStage(); g.takeEvents(r);
  const s = snap(r);
  assert.equal(s.run.started, false);
  const pr = predicted(s);
  const before = JSON.stringify(pr);
  for (let i = 0; i < 30; i++) E.predict(pr, P.DT, r.level, P.cloneState(s));
  assert.equal(JSON.stringify(pr), before);
});

test('snapshots carry the server step count, every step including pauses', () => {
  const r = run(3);
  const a = g.snapshot(r).st;
  tick(r, 5);
  assert.equal(g.snapshot(r).st, a + 5);
});
