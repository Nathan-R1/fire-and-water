const test = require('node:test');
const assert = require('node:assert');
const P = require('../shared/physics');

const NONE = { left: false, right: false };
const RIGHT = { left: false, right: true };
const LEFT = { left: true, right: false };
const FLOOR = (row) => row * P.TILE - P.CHAR.height;

function sim(level, state, bodies, inputs, steps) {
  for (let i = 0; i < steps; i++) P.stepWorld(level, bodies, inputs, P.DT, state);
}

test('pools: fire safe in lava, dies in water; both die in acid', () => {
  const L = P.parseLevel({ id: 'h', rows: [
    '##########',
    '#........#',
    '#F.W..fw.#',
    '#LL~~AA###',
  ] });
  const at = (tx) => { const b = P.createBody({ x: tx * P.TILE + 2, y: FLOOR(3) }); P.stepBody(L, b, NONE, []); return b; };
  assert.equal(P.hazardUnder(L, at(1), 'fire'), 0);
  assert.equal(P.hazardUnder(L, at(1), 'water'), P.T.LAVA);
  assert.equal(P.hazardUnder(L, at(3), 'fire'), P.T.WATER);
  assert.equal(P.hazardUnder(L, at(3), 'water'), 0);
  assert.equal(P.hazardUnder(L, at(5), 'fire'), P.T.ACID);
  assert.equal(P.hazardUnder(L, at(5), 'water'), P.T.ACID);
});

test('gems: only the matching element collects them', () => {
  const L = P.parseLevel({ id: 'g', rows: ['#######', '#F.rbw#', '#W...f#', '#######'] });
  const st = P.createLevelState(L);
  const b = P.createBody({ x: 3 * P.TILE + 2, y: FLOOR(2) });
  assert.deepEqual(P.collectGems(L, st, b, 'water'), []);
  assert.deepEqual(P.collectGems(L, st, b, 'fire'), [0]);
  assert.deepEqual(P.collectGems(L, st, b, 'fire'), [], 'not collected twice');
});

const GATED = {
  id: 'gate',
  rows: [
    '#..........#',
    '#..........#',
    '#..........#',
    '#..........#',
    '#F.W.....fw#',
    '#..........#',
  ],
};

test('plate holds a gate open only while pressed', () => {
  const L = P.parseLevel({ ...GATED, objects: [
    { type: 'plate', at: [1, 4], ch: 1 },
    { type: 'gate', at: [6, 3], size: [1, 2], ch: 1 },
  ] });
  const st = P.createLevelState(L);
  const fire = P.createBody(L.spawns.fire);   // standing on the plate
  const water = P.createBody(L.spawns.water);
  sim(L, st, [fire, water], [NONE, RIGHT], 90);
  assert.equal(st.gates[0], true);
  assert.ok(water.x > 7 * P.TILE, 'water walked through the open gate');
  sim(L, st, [fire, water], [RIGHT, NONE], 20);
  assert.equal(st.plates[0], false);
  assert.equal(st.gates[0], false, 'gate closed again');
});

test('a closed gate blocks; it never closes on top of someone', () => {
  const L = P.parseLevel({ ...GATED, objects: [
    { type: 'plate', at: [9, 4], ch: 1 },
    { type: 'gate', at: [6, 3], size: [1, 2], ch: 1 },
  ] });
  const st = P.createLevelState(L);
  const fire = P.createBody(L.spawns.fire);
  const water = P.createBody(L.spawns.water);
  sim(L, st, [fire, water], [RIGHT, NONE], 90);
  assert.ok(fire.x + P.CHAR.width <= 6 * P.TILE + 1e-6, 'stopped at the gate');

  st.gates[0] = true; // open, with a character standing in the doorway
  fire.x = 6 * P.TILE + 2;
  P.updateMechanisms(L, st, [fire, water]);
  assert.equal(st.gates[0], true);
});

test('lever latches on when walked through in its direction; toggle levers switch back', () => {
  const L = P.parseLevel({ ...GATED, objects: [
    { type: 'lever', at: [4, 4], ch: 1 },
    { type: 'lever', at: [4, 4], ch: 2, toggle: true },
    { type: 'gate', at: [6, 3], size: [1, 2], ch: 1 },
    { type: 'gate', at: [7, 3], size: [1, 2], ch: 2 },
  ] });
  const st = P.createLevelState(L);
  const fire = P.createBody(L.spawns.fire);
  const water = P.createBody({ x: 10 * P.TILE, y: FLOOR(5) });
  sim(L, st, [fire, water], [RIGHT, NONE], 30);
  assert.deepEqual(st.levers, [true, true]);
  sim(L, st, [fire, water], [LEFT, NONE], 60);
  assert.deepEqual(st.levers, [true, false]);
});

test('inverted gate starts open and closes when its channel is on', () => {
  const L = P.parseLevel({ ...GATED, objects: [
    { type: 'plate', at: [9, 4], ch: 1 },
    { type: 'gate', at: [6, 3], size: [1, 2], ch: 1, invert: true },
  ] });
  const st = P.createLevelState(L);
  assert.equal(st.gates[0], true);
  const fire = P.createBody(L.spawns.fire);
  const water = P.createBody({ x: 9 * P.TILE + 2, y: FLOOR(5) });
  sim(L, st, [fire, water], [NONE, NONE], 5);
  assert.equal(st.gates[0], false);
});

test('fans lift a character', () => {
  const L = P.parseLevel({ id: 'fan', rows: [
    '#######',
    '#.....#',
    '#.....#',
    '#.^...#',
    '#.^...#',
    '#.^...#',
    '#F^Wfw#',
    '#######',
  ] });
  const b = P.createBody({ x: 2 * P.TILE + 2, y: FLOOR(7) });
  for (let i = 0; i < 60; i++) P.stepBody(L, b, NONE, []);
  assert.ok(b.y < FLOOR(7) - 2 * P.TILE, `rose to ${b.y}`);
});

test('atExit needs the character standing in its door', () => {
  const L = P.parseLevel({ id: 'e', rows: ['######', '#FWfw#', '######'] });
  const b = P.createBody({ x: 3 * P.TILE + 2, y: FLOOR(2) - 1 });
  assert.equal(P.atExit(L, b, 'fire'), false, 'not grounded yet');
  for (let i = 0; i < 5; i++) P.stepBody(L, b, NONE, []);
  assert.equal(P.atExit(L, b, 'fire'), true);
  assert.equal(P.atExit(L, b, 'water'), false);
});
