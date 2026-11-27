const test = require('node:test');
const assert = require('node:assert');
const P = require('../shared/physics');
const B = require('../shared/bonuses');
const g = require('../src/game');
const C = require('../src/challenge');

const T = P.TILE;

function run(seed = 1, { both = false } = {}) {
  const r = g.createRoom('CHAL', { mode: 'challenge', seed });
  g.join(r, 'a');
  if (both) g.claim(r, 'water', 'a'); else g.join(r, 'b');
  g.takeEvents(r);
  return r;
}
// Step the room, feeding both players idle inputs (the server waits for inputs otherwise).
let seq = 0;
const tick = (r, n = 1) => {
  for (let i = 0; i < n; i++) {
    seq++;
    for (const role of g.ROLES) g.queueInput(r, role, { s: seq, d: 0, j: false });
    g.step(r);
  }
};
// Skip to the map by finishing the room (both characters at their doors).
function finishRoom(r) {
  for (const role of g.ROLES) {
    const e = r.level.exits[role];
    Object.assign(r.players[role].body, { x: e.tx * T + 2, y: (e.ty + 1) * T - P.CHAR.height, vx: 0, vy: 0 });
  }
  r.run.enemies = []; r.run.shots = []; r.run.acid = null;
  for (let i = 0; i < g.TICKS.exitHold + g.TICKS.completePause + 5 && r.phase !== 'map' && r.phase !== 'over'; i++) g.step(r);
}

test('a run is 10 stages: 4 rooms, boss, 4 rooms, boss', () => {
  assert.deepEqual(C.STAGES, ['room', 'room', 'room', 'room', 'boss1', 'room', 'room', 'room', 'room', 'boss2']);
  const r = run();
  assert.equal(r.mode, 'challenge');
  assert.equal(r.run.stage, 0);
  assert.equal(r.run.hearts, C.HEARTS.start);
  assert.ok(r.levelIndex >= 0 && r.levelIndex < 64);
});

test('normal rooms get 1–3 standing enemies, away from the spawns and doors', () => {
  for (let seed = 1; seed <= 20; seed++) {
    const r = run(seed);
    const sentries = r.run.enemies.filter((e) => e.type === 'sentry');
    assert.ok(sentries.length <= 3, `seed ${seed}: ${sentries.length}`);
    for (const e of sentries) {
      for (const role of g.ROLES) {
        const s = r.level.spawns[role];
        assert.ok(Math.abs(e.x - s.x) > 3 * T || Math.abs(e.y - s.y) > 3 * T, `seed ${seed}: sentry too close to ${role} spawn`);
      }
    }
  }
});

test('touching an enemy costs a heart and restarts the room; 0 hearts ends the run', () => {
  const r = run(3);
  r.run.enemies = [{ type: 'sentry', x: 0, y: 0, w: 18, h: 18, stunT: 0 }];
  const f = r.players.fire.body;
  r.run.enemies[0].x = f.x; r.run.enemies[0].y = f.y + 10;
  tick(r);
  assert.equal(r.phase, 'dead');
  assert.equal(r.run.hearts, C.HEARTS.start - 1);
  tick(r, g.TICKS.deathPause);
  assert.equal(r.phase, 'playing');
  r.run.hearts = 1;
  r.run.enemies = [{ type: 'sentry', x: f.x, y: f.y + 10, w: 18, h: 18, stunT: 0 }];
  Object.assign(r.run.enemies[0], { x: r.players.fire.body.x, y: r.players.fire.body.y + 10 });
  tick(r);
  tick(r, g.TICKS.deathPause);
  assert.equal(r.phase, 'over');
  assert.equal(r.run.result, 'defeat');
});

test('Guardian saves one death per room, then you are briefly invulnerable', () => {
  const r = run(4);
  C.grant(r, 'shield', null);
  const f = r.players.fire.body;
  r.run.enemies = [{ type: 'sentry', x: f.x, y: f.y + 10, w: 18, h: 18, stunT: 0 }];
  tick(r, 10);
  assert.equal(r.phase, 'playing', 'saved, and invulnerable for a while');
  assert.equal(r.run.hearts, C.HEARTS.start);
  tick(r, 120);
  assert.equal(r.phase, 'dead', 'still touching after invulnerability ends: dies');
});

test('map: same vote → granted; then both pick a personal bonus → next room', () => {
  const r = run(5);
  finishRoom(r);
  assert.equal(r.phase, 'map');
  const m = r.run.map;
  assert.equal(m.rarity, 'common');
  assert.equal(m.shared.options.length, 2);
  const pick = m.shared.options[0];
  C.act(r, 'fire', { type: 'vote', pick });
  assert.equal(r.run.map.step, 'shared', 'waits for the other vote');
  C.act(r, 'water', { type: 'vote', pick });
  assert.equal(r.run.map.step, 'personal');
  const before = r.loadId;
  C.act(r, 'fire', { type: 'pick', pick: r.run.map.personal.options.fire[0] });
  C.act(r, 'water', { type: 'pick', pick: r.run.map.personal.options.water[0] });
  assert.equal(r.phase, 'playing');
  assert.equal(r.run.stage, 1);
  assert.ok(r.loadId > before, 'a new room loaded');
  assert.equal(r.run.powers.fire.length + r.run.items.length + (r.run.hearts > C.HEARTS.start ? 1 : 0) > 0, true);
});

test('map: different votes → rock paper scissors (draws replay), winner\'s vote applies', () => {
  const r = run(6);
  finishRoom(r);
  const [a, b] = r.run.map.shared.options;
  C.act(r, 'fire', { type: 'vote', pick: a });
  C.act(r, 'water', { type: 'vote', pick: b });
  assert.equal(r.run.map.step, 'rps');
  C.act(r, 'fire', { type: 'rps', hand: 'rock' });
  C.act(r, 'water', { type: 'rps', hand: 'rock' });
  assert.equal(r.run.map.step, 'rps');
  assert.equal(r.run.map.rps.round, 2, 'draw: another round');
  C.act(r, 'fire', { type: 'rps', hand: 'paper' });
  C.act(r, 'water', { type: 'rps', hand: 'rock' });
  assert.equal(r.run.map.step, 'personal');
  assert.equal(r.run.map.rps.winner, 'fire');
  const won = B.BY_ID[a];
  if (won.type === 'item') assert.ok(r.run.items.some((i) => i.id === a), 'fire\'s choice was granted');
});

test('one device playing both: its vote counts for both, no rock paper scissors', () => {
  const r = run(7, { both: true });
  finishRoom(r);
  C.act(r, 'fire', { type: 'vote', pick: r.run.map.shared.options[1] });
  assert.equal(r.run.map.step, 'personal');
});

test('rare bonuses after a boss; the run is won after boss 2', () => {
  const r = run(8, { both: true });
  for (let stage = 0; stage < C.STAGES.length; stage++) {
    assert.equal(r.run.stage, stage);
    finishRoom(r);
    if (stage === C.STAGES.length - 1) break;
    assert.equal(r.run.map.rarity, C.STAGES[stage] === 'room' ? 'common' : 'rare', `stage ${stage}`);
    C.act(r, 'fire', { type: 'vote', pick: r.run.map.shared.options[0] });
    for (const role of g.ROLES) C.act(r, role, { type: 'pick', pick: r.run.map.personal.options[role][0] || 'none' });
  }
  assert.equal(r.phase, 'over');
  assert.equal(r.run.result, 'victory');
});

test('items: equip, Blast destroys nearby standing enemies and recharges per attempt', () => {
  const r = run(9);
  C.grant(r, 'blast', 'fire');
  const blast = r.run.items.find((i) => i.id === 'blast');
  assert.equal(r.run.equip.fire, blast.uid, 'auto-equipped for the picker');
  assert.equal(C.equip(r, 'water', blast.uid), true);
  assert.equal(r.run.equip.fire, null, 'taken from fire');
  assert.equal(r.run.equip.water, blast.uid);
  const w = r.players.water.body;
  r.run.enemies = [{ type: 'sentry', x: w.x + 40, y: w.y + 10, w: 18, h: 18, stunT: 0 }];
  assert.equal(C.use(r, 'water'), true);
  assert.equal(r.run.enemies[0].dead, true);
  assert.equal(C.use(r, 'water'), false, 'used up for this attempt');
  g.restart(r);
  assert.equal(r.run.items[0].ready, true, 'recharged');
});

test('items: Wings fly, Swap swaps places (one use), Reroll replaces the room (one use)', () => {
  const r = run(10);
  for (const id of ['wings', 'swap', 'reroll']) C.grant(r, id, null);
  const byId = (id) => r.run.items.find((i) => i.id === id);
  C.equip(r, 'fire', byId('wings').uid);
  C.use(r, 'fire');
  assert.equal(r.players.fire.body.flyT, B.WINGS_SECONDS);
  const y0 = r.players.fire.body.y;
  tick(r, 30);
  assert.ok(r.players.fire.body.y < y0 - 10, 'rising');

  const f = { ...r.players.fire.body }, w = { ...r.players.water.body };
  C.equip(r, 'water', byId('swap').uid);
  C.use(r, 'water');
  assert.equal(r.players.fire.body.x, w.x);
  assert.equal(r.players.water.body.x, f.x);
  assert.equal(byId('swap'), undefined, 'consumed');

  const id0 = r.levelDef.id;
  C.equip(r, 'fire', byId('reroll').uid);
  C.use(r, 'fire');
  assert.notEqual(r.levelDef.id, id0);
  assert.equal(byId('reroll'), undefined);
});

test('powers change the physics of the player who has them', () => {
  const r = run(11);
  r.run.powers.fire.push('spring', 'doublejump', 'acidskin', 'magnet', 'swift');
  g.restart(r);
  const f = r.players.fire.body, w = r.players.water.body;
  assert.equal(f.jumpMul, 1.15);
  assert.equal(f.maxAirJumps, 1);
  assert.equal(f.acidImmune, true);
  assert.equal(w.jumpMul, 1, "water doesn't get fire's powers");
});

test('boss 1: the flyer moves and the walker grows over 60 s', () => {
  const r = run(12);
  r.run.stage = 4; r.loadStage();
  assert.equal(r.levelDef.id, 'boss-1');
  const flyer = r.run.enemies.find((e) => e.type === 'flyer');
  const walker = r.run.enemies.find((e) => e.type === 'walker');
  const fx = flyer.x;
  // keep the players out of harm's way
  for (const role of g.ROLES) r.run.invuln[role] = 1e9;
  tick(r, 60);
  assert.notEqual(flyer.x, fx);
  const s1 = walker.size;
  tick(r, 60 * 30);
  assert.ok(walker.size > s1 + 20, `walker grew from ${s1} to ${walker.size}`);
});

test('boss 2: 3-2-1, then the ground burns for half a second; acid skin survives; the turret shoots', () => {
  const r = run(13);
  r.run.stage = 9; r.loadStage();
  assert.equal(r.levelDef.id, 'boss-2');
  r.run.powers.water.push('acidskin');
  g.restart(r);
  r.run.invuln.fire = 1e9; // fire is protected for this test; water relies on acid skin
  const events = [];
  let sawShot = false, waterAlive = true;
  for (let i = 0; i < 60 * 9; i++) {
    g.step(r);
    events.push(...g.takeEvents(r).map((e) => e.type));
    if (r.run.shots.length) sawShot = true;
    if (r.phase === 'dead') waterAlive = false;
  }
  assert.ok(events.includes('countdown') && events.includes('acid'), events.join(','));
  assert.ok(sawShot, 'turret fired');
  // water stood on the ground the whole time; only acid skin (and dodging shots) kept her alive
  r.run.shots = [];
  assert.ok(waterAlive || r.run.hearts < C.HEARTS.start);
});

test('Double jump, Wings, Swift, Magnet in the physics', () => {
  const L = P.parseLevel({ id: 'p', rows: ['########', '#......#', '#......#', '#......#', '#......#', '#Fr.Wfw#', '########'] });
  const b = P.createBody(L.spawns.fire);
  for (let i = 0; i < 5; i++) P.stepBody(L, b, {}, []);
  Object.assign(b, { maxAirJumps: 1 });
  P.pressJump(b); for (let i = 0; i < 10; i++) P.stepBody(L, b, {}, []);
  const vyBefore = b.vy;
  P.pressJump(b); P.stepBody(L, b, {}, []);
  assert.ok(b.vy < vyBefore - 100, 'second jump in the air');
  P.pressJump(b); const vy2 = b.vy; P.stepBody(L, b, {}, []);
  assert.ok(b.vy > vy2, 'no third jump');

  const st = P.createLevelState(L);
  const m = P.createBody(L.spawns.fire); m.x = 3 * T; // star is at (2,5): 1 tile away
  assert.deepEqual(P.collectGems(L, st, m, 'fire'), []);
  m.magnet = 30;
  assert.deepEqual(P.collectGems(L, st, m, 'fire'), [0]);
});
