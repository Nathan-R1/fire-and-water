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

// ── Levels 59–64: full scripted playthroughs with real inputs (test/helpers/sim.js) ──
const { sim } = require('./helpers/sim');

test('59 Stepping Stones: each fetches a box into the other\'s pool as a stepping stone', () => {
  const s = sim('59');
  s.walk('fire', 15.3);
  s.jump('fire', 1, 30).land();
  s.walk('fire', 18.6);
  s.walk('fire', 11.8);
  s.walk('fire', 15);
  // water: hop onto the box and over
  s.walk('water', 6.4); s.jump('water', 1, 40).land();
  s.jump('water', 1, 40).land();
  // water wades the water lake, gets right of box1, pushes it into the middle
  s.walk('water', 29.6); s.jump('water', 1, 30).land();
  s.walk('water', 32.4);
  s.walk('water', 26.9);
  s.walk('water', 30);
  // fire crosses the water lake on box1
  s.walk('fire', 21.4); s.jump('fire', 1, 40).land();
  s.jump('fire', 1, 40).land();
  // fire climbs onto water's head, then up onto the ledge
  s.jump('fire', -1, 9).land();
  s.jump('fire', 1, 45).land();
  // water jumps back over box1, pushes it to the wall and climbs
  s.walk('water', 29.2); s.jump('water', -1, 40).land();
  s.walk('water', 31.4);
  s.walk('water', 30.4); s.jump('water', 1, 25).land();
  s.jump('water', 1, 40).land();
  s.walk('fire', 37.5); s.walk('water', 35.3);
  assert.ok(s.atExit('fire') && s.atExit('water'), 'both at their exits');
});

test('60 Three Tiers: box on the floor plate, hazards on each tier, plate + fan + latched lever', () => {
  const s = sim('60');
  s.walk('fire', 11.2); s.walk('fire', 29.9);
  s.walk('water', 3.3); s.jumpTo('water', 6.3);
  s.jumpTo('water', 10); s.walk('water', 12);
  s.walk('fire', 3.3); s.jumpTo('fire', 6.3); s.jumpTo('fire', 9.5);
  s.walk('water', 13.3); s.jumpTo('water', 17.5);
  s.walk('water', 25.3); s.jumpTo('water', 28.5);
  s.walk('fire', 19.3); s.jumpTo('fire', 23.5); s.walk('fire', 25.3); s.jumpTo('fire', 28.5);
  s.walk('water', 33.3);
  s.jumpTo('water', 36.2);
  s.jumpTo('water', 33.4); s.walk('water', 31.5);
  s.walk('fire', 33.3); s.jumpTo('fire', 36.2); s.jumpTo('fire', 33.4);
  // tier 2: water over the water pool (fine) and lava 21-22 by jumping; fire over water 28-29
  s.walk('water', 30.7); s.jumpTo('water', 27);
  s.walk('water', 23.7); s.jumpTo('water', 20);
  s.walk('water', 15.5);
  s.walk('fire', 30.7); s.jumpTo('fire', 27); s.walk('fire', 20.5); s.walk('fire', 16.5); s.jumpTo('fire', 14.4);
  s.walk('fire', 10);
  s.walk('fire', 9.1); s.steer('fire', 9.0, 150);
  s.hold('fire', -1, 20); s.land();
  s.walk('fire', 2.6);
  s.walk('water', 10); s.walk('water', 9.1); s.steer('water', 9.0, 150); s.hold('water', -1, 20); s.land(); s.walk('water', 3.7);
  assert.ok(s.atExit('fire') && s.atExit('water'), 'both at their exits');
});

test('61 Ratchet: water jumps her platform up with a box, then puts it on the plate', () => {
  const s = sim('61');
  s.walk('water', 8); s.jumpTo('water', 4.6);
  // fire up the stairs to the counterweight ledge
  s.walk('fire', 27.5); s.jumpTo('fire', 31);
  s.jumpTo('fire', 34.6);
  s.jumpTo('fire', 36.6);
  s.jumpTo('fire', 32.6);
  s.walk('fire', 28.4);
  s.walk('fire', 28.0); s.wait(60);
  for (let k = 1; k <= 6; k++) { s.jumpTo('water', 4.6); s.wait(10); }
  s.walk('water', 9.8);
  s.walk('fire', 30); s.wait(30); s.walk('fire', 38.4);
  s.walk('water', 8.5);
  assert.ok(s.atExit('fire') && s.atExit('water'), 'both at their exits');
});

test('62 Lids: a held lid lowers fire into the cavern; a box on the other lid\'s weight lets him back up', () => {
  const s = sim('62');
  s.walk('fire', 7); s.wait(30);
  s.walk('water', 12.4);
  s.walk('water', 15.6);
  s.wait(400);
  s.hold('fire', 1, 20); s.land();
  s.walk('fire', 22);
  s.walk('fire', 28.5);
  s.walk('water', 24.3); s.walk('water', 22.4); s.wait(90);
  s.walk('fire', 31); s.steer('fire', 31, 150);
  s.hold('fire', 1, 25); s.land();
  s.walk('water', 22.6); s.jumpTo('water', 28.5);
  s.walk('fire', 38.3); s.walk('water', 36.5);
  assert.ok(s.atExit('fire') && s.atExit('water'), 'both at their exits');
});

test('63 Box Doors: each pushes their box out of their own pool tunnel and makes the other a stepping stone', () => {
  const s = sim('63');
  s.walk('water', 6.5); s.land();
  s.walk('fire', 33.5); s.land();
  // stepping stones: water pushes her box (fire's stone) to the middle of the water lake
  // water hops over her box and pushes it back to the middle of the water lake
  s.jumpTo('water', 8.4);
  s.walk('water', 6.4);
  s.walk('water', 9.6);
  // fire does the same in the lava lake, pushing his box right
  s.jumpTo('fire', 31.6);
  s.walk('fire', 33.5);
  s.walk('fire', 30.5);
  // swap sides along the floor: water to the lava lake, fire to the water lake
  s.walk('fire', 15); s.walk('water', 12.6); s.jumpTo('water', 17.5); s.walk('water', 29.8); s.walk('fire', 9.6);
  s.jumpTo('fire', 5.5);
  s.jumpTo('fire', 1.4);
  s.jumpTo('water', 34.5);
  s.jumpTo('water', 38.4);
  assert.ok(s.atExit('fire') && s.atExit('water'), 'both at their exits');
});

test('64 The Grand Machine: stepping stone, lid, ratchet and plate in one', () => {
  const s = sim('64');
  // 1. stepping stone
  s.walk('fire', 13.6); s.jumpTo('fire', 17.4);
  s.walk('fire', 10.4);
  s.walk('fire', 18); s.walk('water', 4.4); s.jumpTo('water', 9.4); s.jumpTo('water', 14);
  // 2. lid: both on its counterweight
  s.jumpTo('fire', 20); s.walk('water', 17.2); s.jumpTo('water', 19.3); s.wait(90);
  s.hold('fire', 1, 10); s.land(); s.walk('fire', 26); s.steer('fire', 26, 150);
  s.hold('fire', -1, 20); s.land(); s.walk('fire', 22.6);
  s.hold('water', -1, 12); s.land(); s.wait(120);
  s.walk('fire', 27.9);
  s.walk('fire', 23.5);
  // water opens the lid alone and rides up
  s.walk('water', 17.2); s.jumpTo('water', 20); s.wait(90);
  s.hold('water', 1, 10); s.land(); s.walk('water', 26); s.steer('water', 26, 150); s.hold('water', 1, 12); s.land();
  // 3. ratchet: water pushes the box onto B and stays on with it
  s.walk('water', 31.6);
  // fire: stairs, box3 onto A, onto A
  s.walk('fire', 3.6); s.jumpTo('fire', 5);
  s.jumpTo('fire', 8);
  s.jumpTo('fire', 10.6);
  s.walk('fire', 15.0); s.wait(30);
  for (let k = 1; k <= 6; k++) { s.jumpTo('water', s.cx('water')); s.wait(10); }
  s.walk('water', 35.6);
  s.walk('water', 34.5);
  s.walk('fire', 18); s.walk('fire', 23); s.jumpTo('fire', 28.6); s.walk('fire', 29.6); s.jumpTo('fire', 34.8); s.walk('fire', 38.4);
  assert.ok(s.atExit('fire') && s.atExit('water'), 'both at their exits');
});
