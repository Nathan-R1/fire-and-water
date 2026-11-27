// Intended solutions for the box/pulley templates, run through the real physics.
// Characters are placed by hand at each step (the walking itself is tested elsewhere);
// what's being checked is that the boxes and pulleys do what the puzzle needs.

const test = require('node:test');
const assert = require('node:assert');
const P = require('../shared/physics');
const { LEVELS } = require('../src/game');

const T = P.TILE;
const NONE = { left: false, right: false };
const RIGHT = { left: false, right: true };
const LEFT = { left: true, right: false };

function setup(id) {
  const def = LEVELS.find((l) => l.id.startsWith(id));
  const level = P.parseLevel(def);
  const state = P.createLevelState(level);
  const fire = P.createBody(level.spawns.fire);
  const water = P.createBody(level.spawns.water);
  const run = (n, fi = NONE, wi = NONE) => {
    for (let i = 0; i < n; i++) {
      P.stepWorld(level, [fire, water], [fi, wi], P.DT, state);
      for (const [b, el] of [[fire, 'fire'], [water, 'water']]) {
        const h = P.hazardUnder(level, b, el);
        if (h) throw new Error(`${el} died at (${(b.x / T).toFixed(1)}, ${(b.y / T).toFixed(1)})`);
      }
    }
  };
  const plat = (i, side) => P.platformRects(level, state)[i * 2 + (side === 'a' ? 0 : 1)];
  const standOn = (body, r, dx = 0) => { body.x = r.x + r.w / 2 - P.CHAR.width / 2 + dx; body.y = r.y - P.CHAR.height - 0.5; body.vx = body.vy = 0; };
  const boxOn = (k, r, dx = 0) => { const b = state.boxes[k]; b.x = r.x + r.w / 2 - T / 2 + dx; b.y = r.y - T - 0.5; b.vy = 0; };
  const p = (i) => level.pulleys[i];
  return { level, state, fire, water, run, plat, standOn, boxOn, p };
}

test('43 Counterweight: water waits on b, fire + box sink a, water rises to the ledge', () => {
  const s = setup('43');
  s.standOn(s.water, s.plat(0, 'b'));
  s.run(30);
  assert.equal(s.state.pulleys[0].o, 0, 'b cannot sink below its start');
  s.boxOn(0, s.plat(0, 'a'), -20);
  s.run(30);
  assert.equal(s.state.pulleys[0].o, 0, 'box vs water: balanced');
  s.standOn(s.fire, s.plat(0, 'a'), 20);
  s.run(200);
  assert.equal(s.state.pulleys[0].o, s.p(0).max, 'fire + box outweigh water');
  assert.ok(Math.abs(s.water.y + P.CHAR.height - 8 * T) < 1, 'water level with the ledge');
  s.run(90, NONE, RIGHT);
  assert.ok(s.water.x > 26 * T && s.water.onGround, 'water walked onto the ledge');
  s.run(120, RIGHT, NONE);
  assert.ok(s.fire.x > 17 * T && s.fire.onGround, 'fire walked into the lava works alive');
});

test('42 One at a Time: box raises the bridge; one can cross, two sink it', () => {
  const s = setup('42');
  s.boxOn(0, s.plat(0, 'a'));
  s.run(120);
  assert.equal(s.state.pulleys[0].o, s.p(0).max);
  const bridge = s.plat(0, 'b');
  assert.equal(bridge.y, 17 * T, 'bridge level with the ground');
  s.standOn(s.fire, bridge);
  s.run(30);
  assert.equal(s.state.pulleys[0].o, s.p(0).max, 'one crosser: balanced');
  s.standOn(s.water, bridge, 30);
  s.run(30);
  assert.ok(s.state.pulleys[0].o < s.p(0).max, 'two crossers: the bridge sinks');
});

test('44 Pulley Step: box on a raises b into a step to the ledge', () => {
  const s = setup('44');
  s.boxOn(0, s.plat(0, 'a'));
  s.run(120);
  const step = s.plat(0, 'b');
  assert.equal(step.y, 14 * T);
  s.standOn(s.fire, step);
  s.run(10);
  P.pressJump(s.fire);
  s.run(40, RIGHT, NONE);
  s.run(30);
  assert.ok(s.fire.x > 25 * T && Math.abs(s.fire.y + P.CHAR.height - 11 * T) < 1, 'fire jumped up onto the ledge');
});

test('45 Seesaw: one player on each side holds it level', () => {
  const s = setup('45');
  s.standOn(s.fire, s.plat(0, 'a'));
  s.standOn(s.water, s.plat(0, 'b'));
  s.run(60);
  assert.equal(s.state.pulleys[0].o, 0);
  s.water.x = 2 * T; s.water.y = 14 * T + T - P.CHAR.height; // water steps back to the start
  s.run(60);
  assert.ok(s.state.pulleys[0].o > 0, 'fire alone sinks');
});

test('36 Wedge It: a box in the doorway keeps the gate open', () => {
  const s = setup('36');
  s.fire.x = 9 * T + 2; // on plate 1: gate 1 opens
  s.run(5);
  assert.equal(s.state.gates[0], true);
  s.state.boxes[0].x = 16 * T; // wedge box 1 in the gateway
  s.fire.x = 3 * T;
  s.run(10);
  assert.equal(s.state.plates[0], false);
  assert.equal(s.state.gates[0], true, 'gate held open by the box');
});

test('37 Special Delivery: the box pushed off the shelf lands on a plate', () => {
  const s = setup('37');
  s.fire.x = 6 * T; s.fire.y = 15 * T - P.CHAR.height;
  s.run(150, RIGHT, NONE);
  assert.equal(s.state.plates.some(Boolean), true, 'a plate is pressed');
  assert.equal(s.state.gates[0], true);
});

test('41 Going Down: riding the platform down past the wall', () => {
  const s = setup('41');
  s.standOn(s.fire, s.plat(0, 'a'));
  s.run(400);
  assert.equal(s.state.pulleys[0].o, s.p(0).max);
  s.run(40, RIGHT, NONE); // walk off under the wall onto the first island
  s.run(20);
  assert.ok(s.fire.x > 13 * T && s.fire.onGround, 'fire walked under the wall onto the first island');
});
