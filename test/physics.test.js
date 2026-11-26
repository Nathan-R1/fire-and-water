const test = require('node:test');
const assert = require('node:assert');
const P = require('../shared/physics');

const NONE = { left: false, right: false };
const RIGHT = { left: false, right: true };
const LEFT = { left: true, right: false };

// Arena: floor top at row 9, a 2-tile ledge at row 6 (18px above a standing head).
const ARENA = {
  id: 'arena',
  rows: [
    '##########',
    '#........#',
    '#........#',
    '#........#',
    '#........#',
    '#........#',
    '#.....##.#',
    '#........#',
    '#F.W.....#',
    '##########',
  ],
};
const level = P.parseLevel(ARENA);
const FLOOR_Y = 9 * P.TILE - P.CHAR.height;

function run(body, input, steps, others = []) {
  for (let i = 0; i < steps; i++) P.stepBody(level, body, input, others);
}

test('settles onto the floor', () => {
  const b = P.createBody({ x: 30, y: 30 });
  run(b, NONE, 120);
  assert.equal(b.y, FLOOR_Y);
  assert.equal(b.onGround, true);
  assert.equal(b.vy, 0);
});

test('jump rises about 3.5 tiles and lands again', () => {
  const b = P.createBody(level.spawns.fire);
  run(b, NONE, 5);
  P.pressJump(b);
  let minY = b.y;
  for (let i = 0; i < 120; i++) { P.stepBody(level, b, NONE, []); minY = Math.min(minY, b.y); }
  const height = FLOOR_Y - minY;
  assert.ok(height > 80 && height < 95, `jump height ${height}`);
  assert.equal(b.y, FLOOR_Y);
  assert.equal(b.onGround, true);
});

test('cannot jump in mid-air after coyote time', () => {
  const b = P.createBody({ x: 30, y: 30 });
  run(b, NONE, 10); // falling, never grounded
  P.pressJump(b);
  P.stepBody(level, b, NONE, []);
  assert.ok(b.vy > 0, 'still falling');
});

test('coyote time: jump shortly after leaving the ground works', () => {
  const b = P.createBody(level.spawns.fire);
  run(b, NONE, 5);
  b.onGround = false; // simulate walking off a ledge this tick
  P.stepBody(level, b, NONE, []);
  P.pressJump(b);
  P.stepBody(level, b, NONE, []);
  assert.ok(b.vy < 0, 'jumped');
});

test('jump buffer: pressing just before landing jumps on landing', () => {
  const b = P.createBody({ x: 30, y: FLOOR_Y - 10 });
  b.vy = 300;
  P.pressJump(b); // pressed while still in the air
  let jumped = false;
  for (let i = 0; i < 6; i++) { P.stepBody(level, b, NONE, []); if (b.vy < 0) jumped = true; }
  assert.ok(jumped, 'buffered jump fired after landing');
});

test('walls stop horizontal movement', () => {
  const b = P.createBody(level.spawns.fire);
  run(b, LEFT, 120);
  assert.equal(b.x, P.TILE); // right edge of left wall
  run(b, RIGHT, 300);
  assert.equal(b.x, 9 * P.TILE - P.CHAR.width);
});

test('head bonks on a ceiling', () => {
  const b = P.createBody({ x: 6 * P.TILE + 2, y: FLOOR_Y });
  run(b, NONE, 2);
  P.pressJump(b);
  run(b, NONE, 30);
  // never passed through the ledge bottom (row 6 bottom)
  assert.ok(b.y >= 7 * P.TILE - 1e-6);
});

test('one character can stand on the other', () => {
  const bottom = P.createBody(level.spawns.fire);
  const top = P.createBody({ x: bottom.x, y: 30 });
  for (let i = 0; i < 120; i++) P.stepWorld(level, [bottom, top], [NONE, NONE]);
  assert.equal(bottom.y, FLOOR_Y);
  assert.ok(Math.abs(top.y - (FLOOR_Y - P.CHAR.height)) < 1e-6, `top.y ${top.y}`);
  assert.equal(top.onGround, true);
});

test('characters block each other sideways', () => {
  const a = P.createBody(level.spawns.fire);
  const b = P.createBody(level.spawns.water);
  for (let i = 0; i < 120; i++) P.stepWorld(level, [a, b], [RIGHT, NONE]);
  assert.ok(a.x + P.CHAR.width <= b.x + 1e-6);
});

test('test-01: high ledge needs a partner boost', () => {
  const L = P.parseLevel(require('../levels/test-01.json'));
  const stepTop = 9 * P.TILE, ledgeTop = 5 * P.TILE;
  const jumpH = (P.CHAR.jumpVel ** 2) / (2 * P.CHAR.gravity);
  assert.ok(stepTop - ledgeTop > jumpH, 'unreachable alone');
  assert.ok(stepTop - P.CHAR.height - ledgeTop < jumpH, 'reachable from partner');
  // every other step is reachable alone
  for (const [lower, upper] of [[21, 18], [18, 15], [15, 12], [12, 9]]) {
    assert.ok((lower - upper) * P.TILE < jumpH);
  }
  assert.ok(L.spawns.fire && L.spawns.water);
});

test('parseLevel rejects ragged rows and missing spawns', () => {
  assert.throws(() => P.parseLevel({ id: 'x', rows: ['###', '#F'] }));
  assert.throws(() => P.parseLevel({ id: 'x', rows: ['###', '#F#'] }));
});
