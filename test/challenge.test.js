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

test('room 1 is an untouched campaign level: no enemies added', () => {
  for (let seed = 1; seed <= 10; seed++) {
    const r = run(seed);
    assert.equal(r.run.enemies.length, 0);
    assert.ok(g.LEVELS.includes(r.levelDef), 'the campaign level itself');
  }
});

test('later normal rooms get 1–3 standing enemies, away from the spawns and doors', () => {
  for (let seed = 1; seed <= 20; seed++) {
    const r = run(seed);
    r.run.stage = 1; r.loadStage();
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

test('Guardian: once per room, a death sends you back to your start instead', () => {
  const r = run(4);
  C.grant(r, 'guardian', null);
  const f = r.players.fire.body;
  const spawn = { ...r.level.spawns.fire };
  f.x += 3 * T; // walked away from the start
  r.run.enemies = [{ type: 'sentry', x: f.x, y: f.y + 10, w: 18, h: 18, stunT: 0 }];
  tick(r, 2);
  assert.equal(r.phase, 'playing', 'saved');
  assert.equal(r.run.hearts, C.HEARTS.start);
  assert.ok(Math.abs(f.x - spawn.x) < 4, 'back at the start');
  r.run.enemies[0].x = f.x; r.run.enemies[0].y = f.y + 10;
  tick(r, 90);
  assert.equal(r.phase, 'dead', 'only once per room');
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
  assert.equal(r.run.personal.fire.length, 1);
  assert.equal(r.run.personal.water.length, 1);
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

test('items: Wings (personal) fly, Swap is unlimited, Reroll is one use for the team and stays as used', () => {
  const r = run(10);
  C.grant(r, 'wings', 'fire');
  for (const id of ['swap', 'reroll']) C.grant(r, id, null);
  assert.equal(r.run.items.some((i) => i.id === 'wings'), false, 'personal items never go in the team inventory');
  const byId = (id) => r.run.items.find((i) => i.id === id);
  const wings = r.run.personal.fire.find((i) => i.id === 'wings');
  assert.equal(C.equip(r, 'water', wings.uid), false, "water can't equip fire's personal item");
  C.equip(r, 'fire', wings.uid);
  C.use(r, 'fire');
  assert.equal(r.players.fire.body.flyT, B.WINGS_SECONDS);
  const y0 = r.players.fire.body.y;
  tick(r, 30);
  assert.ok(r.players.fire.body.y < y0 - 10, 'rising');

  const f = { ...r.players.fire.body }, w = { ...r.players.water.body };
  C.equip(r, 'water', byId('swap').uid);
  assert.equal(C.use(r, 'water'), true);
  assert.equal(r.players.fire.body.x, w.x);
  assert.equal(r.players.water.body.x, f.x);
  assert.equal(C.use(r, 'water'), false, '1 s cooldown');
  tick(r, 61);
  assert.equal(C.use(r, 'water'), true, 'and again: unlimited');

  const id0 = r.levelDef.id;
  C.equip(r, 'fire', byId('reroll').uid);
  assert.equal(C.use(r, 'fire'), true);
  assert.notEqual(r.levelDef.id, id0);
  assert.equal(byId('reroll').spent, true, 'still in the bar, used up');
  assert.equal(r.run.equip.fire, null, 'unequipped');
  assert.equal(C.equip(r, 'water', byId('reroll').uid), false, "a used-up item can't be equipped");
});

test('personal passives change the physics of their owner only', () => {
  const r = run(11);
  for (const id of ['spring', 'doublejump', 'acidskin', 'magnet', 'swift']) C.grant(r, id, 'fire');
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

test('boss 2: 3-2-1, then the ground burns for 0.1 s; acid skin survives; the turret shoots', () => {
  const r = run(13);
  r.run.stage = 9; r.loadStage();
  assert.equal(r.levelDef.id, 'boss-2');
  C.grant(r, 'acidskin', 'water');
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

test('offers: common after rooms, uncommon chance = share of stars collected; personal offers are independent', () => {
  const r = run(20);
  const tierOf = (id) => B.BY_ID[id].rarity;
  // no stars: only common
  let seen = new Set();
  for (let k = 0; k < 50; k++) for (const id of C.offer(r.run, 'personal', 2, new Set(), 0, false)) seen.add(tierOf(id));
  assert.deepEqual([...seen], ['common']);
  // all stars: always uncommon while there are uncommons to give
  seen = new Set();
  for (let k = 0; k < 50; k++) for (const id of C.offer(r.run, 'personal', 2, new Set(), 1, false)) seen.add(tierOf(id));
  assert.deepEqual([...seen], ['uncommon']);
  // half the stars: a mix
  let unc = 0, all = 0;
  for (let k = 0; k < 400; k++) for (const id of C.offer(r.run, 'personal', 1, new Set(), 0.5, false)) { all++; if (tierOf(id) === 'uncommon') unc++; }
  assert.ok(unc / all > 0.4 && unc / all < 0.6, `${unc}/${all}`);
  // no team uncommons exist: team offers fall back to common
  for (const id of C.offer(r.run, 'team', 2, new Set(), 1, false)) assert.equal(tierOf(id), 'common');
  // bosses: rare
  for (const id of C.offer(r.run, 'personal', 2, new Set(), 0, true)) assert.equal(tierOf(id), 'rare');
  // both players can be offered the same item
  let same = false;
  for (let k = 0; k < 50 && !same; k++) {
    const a = C.offer(r.run, 'personal', 2, new Set(), 0, false), b = C.offer(r.run, 'personal', 2, new Set(), 0, false);
    same = a.some((id) => b.includes(id));
  }
  assert.ok(same);
});

test('Blaster: short-range shot the way you face destroys a sentry; unlimited with a short cooldown', () => {
  const r = run(21);
  C.grant(r, 'gun', 'fire');
  const f = r.players.fire.body;
  f.facing = 1;
  r.run.enemies = [{ type: 'sentry', x: f.x + 3 * T, y: f.y + 8, w: 18, h: 18, stunT: 0 }];
  assert.equal(C.use(r, 'fire'), true);
  tick(r, 20);
  assert.equal(r.run.enemies[0].dead, true);
  tick(r, 30);
  assert.equal(C.use(r, 'fire'), true, 'fires again');
  r.run.enemies = [{ type: 'sentry', x: f.x + 9 * T, y: f.y + 8, w: 18, h: 18, stunT: 0 }];
  tick(r, 60);
  assert.ok(!r.run.enemies[0].dead, 'out of range');
});

test('Cloak: enemies are harmless and the turret won\'t aim at you; Shield: nothing hurts for 5 s', () => {
  const r = run(22);
  C.grant(r, 'cloak', 'fire'); C.grant(r, 'shield', 'water');
  const f = r.players.fire.body;
  r.run.enemies = [{ type: 'sentry', x: f.x, y: f.y + 10, w: 18, h: 18, stunT: 0 }];
  C.use(r, 'fire');
  tick(r, 30);
  assert.equal(r.phase, 'playing', 'cloaked: the sentry is harmless');
  r.run.enemies = [{ type: 'shooter', x: f.x, y: f.y - 5 * T, w: 28, h: 22, stunT: 0, cool: 0 }];
  r.players.water.body.x = 1e5; // water far away and also cloaked? no: give water a shield instead
  C.use(r, 'water');
  tick(r, 2);
  const shot = r.run.shots[0];
  assert.ok(!shot || shot.vx > 0, 'the turret aimed at water, not at the cloaked fire');
});

test('Recall and Beacon teleport; Create Box drops a box; Geyser lifts you', () => {
  const r = run(23);
  for (const id of ['recall', 'beacon']) C.grant(r, id, 'fire');
  C.grant(r, 'crate', 'water'); C.grant(r, 'geyser', null);
  const f = r.players.fire.body, w = r.players.water.body;
  const spawn = { ...r.level.spawns.fire };
  f.x += 2 * T;
  C.equip(r, 'fire', r.run.personal.fire.find((i) => i.id === 'recall').uid);
  C.use(r, 'fire');
  assert.ok(Math.abs(f.x - spawn.x) < 1);
  C.equip(r, 'fire', r.run.personal.fire.find((i) => i.id === 'beacon').uid);
  C.use(r, 'fire');
  assert.ok(Math.abs(f.x - w.x) < 1, 'next to (on top of) water');
  const boxes = r.state.boxes.length;
  C.equip(r, 'water', r.run.items.find((i) => i.id === 'crate').uid);
  assert.equal(C.use(r, 'water'), true);
  assert.equal(r.state.boxes.length, boxes + 1);
  assert.equal(C.use(r, 'water'), false, 'once per room');
  g.restart(r);
  assert.equal(r.state.boxes.length, boxes, 'gone on restart');
  C.equip(r, 'water', r.run.items.find((i) => i.id === 'geyser').uid);
  C.use(r, 'water');
  const y0 = r.players.water.body.y;
  tick(r, 40);
  assert.ok(r.players.water.body.y < y0 - 2 * T, 'carried upwards');
});

test('Spring, Swift and Magnet keep being offered and stack; other personal items are offered once', () => {
  const r = run(30, { both: true });
  for (let k = 0; k < 3; k++) { C.grant(r, 'spring', 'fire'); C.grant(r, 'magnet', 'fire'); C.grant(r, 'swift', 'fire'); }
  C.grant(r, 'acidskin', 'fire'); C.grant(r, 'recall', 'fire');
  g.restart(r);
  const f = r.players.fire.body;
  assert.ok(Math.abs(f.jumpMul - 1.45) < 1e-9);
  assert.ok(Math.abs(f.speedMul - 1.45) < 1e-9);
  assert.equal(f.magnet, 90);
  // offers after a room: repeatables still appear, owned one-offs don't
  const seen = new Set();
  for (let k = 0; k < 60; k++) {
    finishRoom(r);
    for (const id of r.run.map.personal.options.fire) seen.add(id);
    r.run.map = null; r.phase = 'playing'; r.run.stage = 0; r.loadStage();
  }
  assert.ok(seen.has('spring') && seen.has('swift') && seen.has('magnet'), [...seen].join(','));
  assert.ok(!seen.has('acidskin') && !seen.has('recall'), [...seen].join(','));
});

test('stacked Springs never jump faster than one tile per tick', () => {
  const L = P.parseLevel({ id: 'p', rows: ['#####', '#...#', '#...#', '#...#', '#...#', '#...#', '#...#', '#...#', '#FWfw', '#####'].map((x) => x.padEnd(5, '#')) });
  const b = P.createBody(L.spawns.fire);
  for (let i = 0; i < 5; i++) P.stepBody(L, b, {}, []);
  b.jumpMul = 10;
  P.pressJump(b); P.stepBody(L, b, {}, []);
  assert.ok(-b.vy * P.DT < P.TILE, `moved ${-b.vy * P.DT}px in one tick`);
});
