const test = require('node:test');
const assert = require('node:assert');
const P = require('../shared/physics');
const g = require('../src/game');

test('first two joiners get fire then water, third spectates', () => {
  const r = g.createRoom('ABCD');
  assert.equal(g.join(r, 'a'), 'fire');
  assert.equal(g.join(r, 'b'), 'water');
  assert.equal(g.join(r, 'c'), null);
});

test('freed slot is reused and its input cleared', () => {
  const r = g.createRoom('ABCD');
  g.join(r, 'a'); g.join(r, 'b');
  g.setInput(r, 'fire', 1);
  g.leave(r, 'a');
  assert.deepEqual(r.players.fire.input, { left: false, right: false });
  assert.equal(g.join(r, 'c'), 'fire');
});

test('walking right moves the character', () => {
  const r = g.createRoom('ABCD');
  for (let i = 0; i < 10; i++) g.step(r);
  const x0 = r.players.water.body.x;
  g.setInput(r, 'water', 1);
  for (let i = 0; i < 30; i++) g.step(r);
  assert.ok(r.players.water.body.x > x0 + 50);
});

test('jump leaves the ground', () => {
  const r = g.createRoom('ABCD');
  for (let i = 0; i < 10; i++) g.step(r);
  const y0 = r.players.water.body.y;
  g.jump(r, 'water');
  for (let i = 0; i < 10; i++) g.step(r);
  assert.ok(r.players.water.body.y < y0 - 30);
});

test('rejects bad input', () => {
  const r = g.createRoom('ABCD');
  g.setInput(r, 'fire', 5);
  g.setInput(r, 'nope', 1);
  g.jump(r, 'nope');
  assert.deepEqual(r.players.fire.input, { left: false, right: false });
});

test('snapshot has positions and connection flags', () => {
  const r = g.createRoom('ABCD');
  g.join(r, 'a');
  const s = g.snapshot(r);
  assert.equal(s.fire.connected, true);
  assert.equal(s.water.connected, false);
  assert.equal(typeof s.fire.y, 'number');
  assert.ok(P.DT > 0);
});
