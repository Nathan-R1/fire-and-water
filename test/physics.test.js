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
    '#F.W...fw#',
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

test('characters pass through each other sideways', () => {
  const a = P.createBody(level.spawns.fire);
  const b = P.createBody(level.spawns.water);
  const bx = b.x;
  for (let i = 0; i < 120; i++) P.stepWorld(level, [a, b], [RIGHT, NONE]);
  assert.ok(a.x > bx + P.CHAR.width, 'walked right through');
  assert.equal(b.x, bx, 'without pushing the other');
});

test('jumping up into the other character doesn\'t bump: only landing on their head counts', () => {
  const bottom = P.createBody(level.spawns.fire);
  const top = P.createBody({ x: bottom.x, y: 30 });
  for (let i = 0; i < 120; i++) P.stepWorld(level, [bottom, top], [NONE, NONE]);
  assert.equal(top.onGround, true, 'standing on the head');
  // the bottom one walks out from under, then back in and jumps: it passes up through
  for (let i = 0; i < 30; i++) P.stepWorld(level, [bottom, top], [RIGHT, NONE]);
  assert.ok(top.y > FLOOR_Y - P.CHAR.height - 1, 'top dropped to the floor');
  for (let i = 0; i < 30; i++) P.stepWorld(level, [bottom, top], [LEFT, NONE]);
  P.pressJump(bottom);
  let minY = Infinity;
  for (let i = 0; i < 40; i++) { P.stepWorld(level, [bottom, top], [NONE, NONE]); minY = Math.min(minY, bottom.y); }
  assert.ok(minY < FLOOR_Y - 40, `jumped freely (${FLOOR_Y - minY}px)`);
});

test('parseLevel rejects ragged rows and missing spawns', () => {
  assert.throws(() => P.parseLevel({ id: 'x', rows: ['###', '#F'] }));
  assert.throws(() => P.parseLevel({ id: 'x', rows: ['###', '#F#'] }));
  assert.throws(() => P.parseLevel({ id: 'x', rows: ['#####', '#FW.#', '#####'] }), /exits/);
  assert.throws(() => P.parseLevel({ id: 'x', rows: ['######', '#FWfwZ', '######'] }), /unknown tile/);
});
