const test = require('node:test');
const assert = require('node:assert');
const g = require('../src/game');

const LV = (id, rows) => ({ id, name: id, rows });
// Each character spawns one tile from its door: fire walks left, water walks right.
const L1 = LV('one', ['########', '#......#', '#fF..Ww#', '########']);
const L2 = LV('two', ['########', '#......#', '#F.W.fw#', '########']);
// Water spawns next to a lava pool.
const LAVA = LV('lava', ['########', '#......#', '#F.fwW.#', '######L#']);

const room = () => g.createRoom('ABCD', { levels: [L2] });

test('there are 32 levels and they all load', () => {
  assert.equal(g.LEVELS.length, 32);
  for (let i = 0; i < g.LEVELS.length; i++) g.createRoom('X', { startIndex: i });
});

test('first two joiners get fire then water, third spectates', () => {
  const r = room();
  assert.equal(g.join(r, 'a'), 'fire');
  assert.equal(g.join(r, 'b'), 'water');
  assert.equal(g.join(r, 'c'), null);
});

test('freed slot is reused and its input cleared', () => {
  const r = room();
  g.join(r, 'a'); g.join(r, 'b');
  g.setInput(r, 'fire', 1);
  g.leave(r, 'a');
  assert.deepEqual(r.players.fire.input, { left: false, right: false });
  assert.equal(g.join(r, 'c'), 'fire');
});

test('rejects bad input', () => {
  const r = room();
  g.setInput(r, 'fire', 5);
  g.setInput(r, 'nope', 1);
  g.jump(r, 'nope');
  assert.deepEqual(r.players.fire.input, { left: false, right: false });
});

test('both in their doors completes the level and moves to the next', () => {
  const r = g.createRoom('ABCD', { levels: [L1, L2] });
  g.takeEvents(r);
  g.setInput(r, 'fire', -1);
  g.setInput(r, 'water', 1);
  for (let i = 0; i < 40; i++) g.step(r);
  g.setInput(r, 'fire', 0);
  g.setInput(r, 'water', 0);
  for (let i = 0; i < g.TICKS.exitHold + 30 && r.phase === 'playing'; i++) g.step(r);
  assert.equal(r.phase, 'complete');
  const done = g.takeEvents(r).find((e) => e.type === 'complete');
  assert.equal(done.index, 0);
  for (let i = 0; i < g.TICKS.completePause; i++) g.step(r);
  assert.equal(r.levelIndex, 1);
  assert.equal(r.levelDef.id, 'two');
  assert.equal(r.phase, 'playing');
});

test('a death restarts the level for both after a pause', () => {
  const r = g.createRoom('ABCD', { levels: [LAVA] });
  g.takeEvents(r);
  g.setInput(r, 'water', 1);
  let dead = false;
  for (let i = 0; i < 60 && !dead; i++) { g.step(r); dead = r.phase === 'dead'; }
  assert.ok(dead, 'water died');
  const ev = g.takeEvents(r).find((e) => e.type === 'death');
  assert.equal(ev.role, 'water');
  r.players.fire.body.x = 999;
  for (let i = 0; i < g.TICKS.deathPause; i++) g.step(r);
  assert.equal(r.phase, 'playing');
  assert.equal(r.players.fire.body.x, r.level.spawns.fire.x, 'fire reset too');
  assert.equal(r.deaths, 1);
});

test('snapshot includes level, phase and mechanism state', () => {
  const r = g.createRoom('ABCD', { levels: [L2] });
  g.join(r, 'a');
  const s = g.snapshot(r);
  assert.equal(s.fire.connected, true);
  assert.equal(s.water.connected, false);
  assert.equal(s.level, 0);
  assert.equal(s.phase, 'playing');
  assert.ok(Array.isArray(s.gates));
});

test('claim and release let one device control both characters', () => {
  const r = room();
  assert.equal(g.join(r, 'a'), 'fire');
  assert.equal(g.claim(r, 'water', 'a'), true, 'free character can be claimed');
  assert.equal(g.claim(r, 'water', 'b'), false, 'taken by someone else');
  assert.equal(g.claim(r, 'fire', 'a'), true, 'already yours');
  g.release(r, 'water');
  assert.equal(g.join(r, 'b'), 'water');
  g.leave(r, 'a');
  assert.equal(r.players.fire.socketId, null);
  assert.equal(r.players.water.socketId, 'b');
});
