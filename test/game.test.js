const test = require('node:test');
const assert = require('node:assert');
const g = require('../src/game');

test('first two joiners get fire then water, third spectates', () => {
  const r = g.createRoom('ABCD');
  assert.equal(g.join(r, 'a'), 'fire');
  assert.equal(g.join(r, 'b'), 'water');
  assert.equal(g.join(r, 'c'), null);
});

test('freed slot is reused', () => {
  const r = g.createRoom('ABCD');
  g.join(r, 'a'); g.join(r, 'b');
  g.leave(r, 'a');
  assert.equal(g.join(r, 'c'), 'fire');
});

test('movement and clamping', () => {
  const r = g.createRoom('ABCD');
  const x0 = r.players.fire.x;
  g.setInput(r, 'fire', 1);
  g.step(r, 0.5);
  assert.equal(r.players.fire.x, x0 + g.PLAYER.speed * 0.5);
  g.setInput(r, 'fire', -1);
  g.step(r, 100);
  assert.equal(r.players.fire.x, 0);
  g.setInput(r, 'water', 1);
  g.step(r, 100);
  assert.equal(r.players.water.x, g.WORLD.width - g.PLAYER.width);
});

test('rejects bad input', () => {
  const r = g.createRoom('ABCD');
  g.setInput(r, 'fire', 5);
  g.setInput(r, 'nope', 1);
  assert.equal(r.players.fire.dir, 0);
});
