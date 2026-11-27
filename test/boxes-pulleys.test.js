const test = require('node:test');
const assert = require('node:assert');
const P = require('../shared/physics');

const NONE = { left: false, right: false };
const RIGHT = { left: false, right: true };
const LEFT = { left: true, right: false };
const T = P.TILE;

function world(rows, objects = []) {
  const level = P.parseLevel({ id: 't', rows, objects });
  const state = P.createLevelState(level);
  const fire = P.createBody(level.spawns.fire);
  const water = P.createBody(level.spawns.water);
  const run = (n, fi = NONE, wi = NONE) => { for (let i = 0; i < n; i++) P.stepWorld(level, [fire, water], [fi, wi], P.DT, state); };
  return { level, state, fire, water, run };
}

const FLAT = [
  '################',
  '#..............#',
  '#..............#',
  '#..............#',
  '#F...X.......Ww#',
  '#############f##',
].map((r, i) => (i === 5 ? '################' : r));
FLAT[4] = '#F...X......fWw#';

test('boxes rest on the floor and can be pushed, slower than walking', () => {
  const w = world(FLAT);
  w.run(10);
  const box = w.state.boxes[0];
  assert.equal(box.y, 4 * T);
  const x0 = box.x;
  w.run(90, RIGHT);
  assert.ok(box.x > x0 + 50, `box moved ${box.x - x0}`);
  assert.ok(w.fire.vx <= P.CHAR.pushSpeed + 1e-9, 'pushing speed cap');
  assert.ok(Math.abs(w.fire.x + P.CHAR.width - box.x) < 1e-6, 'fire is right behind the box');
});

test('a box stops against an obstacle (here the other character) and blocks the pusher', () => {
  const w = world(FLAT);
  w.run(400, RIGHT);
  const box = w.state.boxes[0];
  assert.ok(Math.abs(box.x + T - w.water.x) < 1e-6, `box stopped at water (${box.x + T} vs ${w.water.x})`);
  assert.equal(w.fire.vx, 0);
});

test('a box cannot be pushed into another box', () => {
  const rows = FLAT.slice();
  rows[4] = '#F...XX.....fWw#';
  const w = world(rows);
  w.run(120, RIGHT);
  assert.equal(w.state.boxes[0].x, 5 * T);
  assert.equal(w.state.boxes[1].x, 6 * T);
});

test('you can stand on a box and jump higher from it', () => {
  const rows = FLAT.slice();
  rows[3] = '#....X.........#';
  rows[4] = '#F..........fWw#';
  const w = world(rows);
  w.run(30);
  const box = w.state.boxes[0];
  assert.equal(box.y, 4 * T, 'box fell to the floor');
  w.fire.x = box.x + 2; w.fire.y = box.y - P.CHAR.height - 2;
  w.run(20);
  assert.equal(w.fire.y, box.y - P.CHAR.height);
  assert.equal(w.fire.onGround, true);
});

test('a box pushed off a ledge falls and can hold a plate down', () => {
  const rows = [
    '################',
    '#..............#',
    '#F.X.....W.....#',
    '#######........#',
    '#......fw......#',
    '################',
  ];
  const w = world(rows, [
    { type: 'plate', at: [8, 4], ch: 1 },
    { type: 'gate', at: [12, 3], size: [1, 2], ch: 1 },
  ]);
  w.run(150, RIGHT);
  const box = w.state.boxes[0];
  assert.ok(box.y >= 4 * T - 1e-6, `box fell (y=${box.y})`);
  box.x = 8 * T; // slide it onto the plate
  w.fire.x = 2 * T; w.fire.y = 3 * T - P.CHAR.height; w.water.x = 2 * T + 40; w.water.y = 3 * T - P.CHAR.height;
  w.run(3);
  assert.equal(w.state.plates[0], true);
  assert.equal(w.state.gates[0], true);
});

const PULLEY_ROWS = [
  '################',
  '#..............#',
  '#..............#',
  '#..............#',
  '#..............#',
  '#..............#',
  '#..............#',
  '#..............#',
  '#F..........fwW#',
  '################',
];
const PULLEY = { type: 'pulley', a: [2, 6], b: [8, 6], w: 3, travel: 2 };

test('pulley: an empty pulley stays balanced', () => {
  const w = world(PULLEY_ROWS, [PULLEY]);
  w.run(60);
  assert.equal(w.state.pulleys[0].o, 0);
});

test('pulley: a character sinks one side and raises the other, then stops at the limit', () => {
  const w = world(PULLEY_ROWS, [PULLEY]);
  w.fire.x = 3 * T; w.fire.y = 6 * T - P.CHAR.height - 1;
  w.run(20);
  assert.ok(w.state.pulleys[0].o > 0, 'side a went down');
  const [A, B] = P.platformRects(w.level, w.state);
  assert.ok(Math.abs(w.fire.y + P.CHAR.height - A.y) < 1, 'rider carried down with the platform');
  assert.ok(B.y < 6 * T, 'side b went up');
  w.run(120);
  assert.equal(w.state.pulleys[0].o, 2 * T, 'stops at travel limit');
});

test('pulley: equal weights balance; a box tips it back', () => {
  const w = world(PULLEY_ROWS, [PULLEY]);
  w.fire.x = 3 * T; w.fire.y = 6 * T - P.CHAR.height - 1;
  w.water.x = 9 * T; w.water.y = 6 * T - P.CHAR.height - 1;
  w.run(60);
  assert.equal(w.state.pulleys[0].o, 0, 'one each: balanced');
  w.state.boxes.push({ x: 8 * T, y: 6 * T - T - 2, w: T, h: T, vy: 0, onGround: false });
  w.run(60);
  assert.ok(w.state.pulleys[0].o < 0, 'water + box outweigh fire: side b down');
  const [A] = P.platformRects(w.level, w.state);
  assert.ok(Math.abs(w.fire.y + P.CHAR.height - A.y) < 1, 'fire carried up');
});

test('pulley: a platform will not crush something underneath it', () => {
  const rows = PULLEY_ROWS.slice();
  const w = world(rows, [{ type: 'pulley', a: [2, 6], b: [8, 6], w: 3, travel: 3 }]);
  // water stands on the floor under side a; fire weighs side a down
  w.water.x = 3 * T; w.water.y = 9 * T - P.CHAR.height;
  w.fire.x = 3 * T; w.fire.y = 6 * T - P.CHAR.height - 1;
  w.run(120);
  const [A] = P.platformRects(w.level, w.state);
  assert.ok(A.y + A.h <= w.water.y + 1e-6, 'platform stopped above water');
});

test('hazards are not triggered while standing on a box over a pool', () => {
  const rows = [
    '########',
    '#......#',
    '#F.X.Ww#',
    '#.fLL..#',
    '########',
  ].map((r, i) => (i === 3 ? '###LL###' : r));
  rows[2] = '#F.XfWw#';
  const w = world(rows);
  w.state.boxes[0].x = 3 * T; // on top of the lava, flush with the floor
  w.run(5);
  w.water.x = 3 * T + 2; w.water.y = w.state.boxes[0].y - P.CHAR.height - 1;
  w.run(5);
  assert.equal(w.water.onGround, true);
  assert.equal(P.hazardUnder(w.level, w.water, 'water'), 0);
});
