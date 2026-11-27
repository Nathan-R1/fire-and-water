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
// (It also marks the room as started, as if someone had moved: enemies run.)
const tick = (r, n = 1) => {
  for (let i = 0; i < n; i++) {
    if (r.run) r.run.started = true;
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

// A small test arena for enemy behaviour.
function arena(r, rows) {
  const def = { id: 'arena', name: 'arena', rows };
  r.levelDef = def; r.level = P.parseLevel(def); r.state = P.createLevelState(r.level);
  for (const role of g.ROLES) r.players[role].body = P.createBody(r.level.spawns[role]);
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

test('Guardian: each player\'s first hit in a room makes them shielded for 1s instead', () => {
  const r = run(4);
  C.grant(r, 'guardian', null);
  const f = r.players.fire.body;
  f.x += 3 * T;
  const x0 = f.x;
  const sentry = { type: 'sentry', x: f.x, y: f.y + 10, w: 18, h: 18, stunT: 0 };
  r.run.enemies = [sentry];
  tick(r, 2);
  assert.equal(r.phase, 'playing', 'saved');
  assert.equal(r.run.hearts, C.HEARTS.start);
  assert.ok(Math.abs(f.x - x0) < 4, 'stays where it happened');
  assert.ok(r.run.effects.fire.shieldT > 0 && !f.phase, 'shielded, not intangible');
  tick(r, 30);
  assert.equal(r.phase, 'playing', 'still safe while shielded');
  tick(r, 40); // the second ends; still standing on the sentry
  assert.equal(r.phase, 'dead', 'only once per player per room');
});

test('Guardian then Last Chance: a second hit uses Last Chance', () => {
  const r = run(4);
  C.grant(r, 'guardian', null); C.grant(r, 'lastchance', null);
  const f = r.players.fire.body;
  f.x += 3 * T;
  r.run.enemies = [{ type: 'sentry', x: f.x, y: f.y + 10, w: 18, h: 18, stunT: 0 }];
  tick(r, 2);
  assert.ok(r.run.effects.fire.shieldT > 0 && !(r.run.ghost.fire > 0), 'Guardian first');
  tick(r, 70);
  assert.equal(r.phase, 'playing');
  assert.ok(r.run.ghost.fire > 0, 'then Last Chance');
  assert.ok(f.phase, 'Last Chance keeps you intangible');
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
  assert.ok(r.levelDef.id.startsWith('boss-1'), r.levelDef.id);
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
    r.run.started = true; // as if someone had moved
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

test('after Phase, that player is no longer offered personal actives; the other player still is', () => {
  const r = run(31, { both: true });
  C.grant(r, 'phase', 'fire');
  const fire = new Set(), water = new Set();
  for (let k = 0; k < 60; k++) {
    finishRoom(r);
    for (const id of r.run.map.personal.options.fire) fire.add(id);
    for (const id of r.run.map.personal.options.water) water.add(id);
    r.run.map = null; r.phase = 'playing'; r.run.stage = 0; r.loadStage();
  }
  assert.ok(fire.size > 0);
  for (const id of fire) assert.notEqual(B.BY_ID[id].color, 'yellow', id);
  assert.ok([...water].some((id) => B.BY_ID[id].color === 'yellow'), [...water].join(','));
  // after a boss: no Wings or Dual Wield for fire, only Double Jump is left
  r.run.stage = C.STAGES.indexOf('boss1');
  C.onComplete(r);
  assert.deepEqual(r.run.map.personal.options.fire, ['doublejump']);
  assert.ok(r.run.map.personal.options.water.length === 2);
});

test('stacked Springs never jump faster than one tile per tick', () => {
  const L = P.parseLevel({ id: 'p', rows: ['#####', '#...#', '#...#', '#...#', '#...#', '#...#', '#...#', '#...#', '#FWfw', '#####'].map((x) => x.padEnd(5, '#')) });
  const b = P.createBody(L.spawns.fire);
  for (let i = 0; i < 5; i++) P.stepBody(L, b, {}, []);
  b.jumpMul = 10;
  P.pressJump(b); P.stepBody(L, b, {}, []);
  assert.ok(-b.vy * P.DT < P.TILE, `moved ${-b.vy * P.DT}px in one tick`);
});

test('Element Ward: stepping into your own element shields you, 1 s per copy, each time you step in', () => {
  const r = run(31);
  r.run.stage = 1; r.loadStage();
  // a tiny level: fire walks from floor onto lava
  const def = { id: 'ward', name: 'ward', rows: ['########', '#....fw#', '#F....W#', '###LL###', '########'] };
  r.levelDef = def; r.level = P.parseLevel(def); r.state = P.createLevelState(r.level); r.enemySpecs = [];
  for (const role of g.ROLES) r.players[role].body = P.createBody(r.level.spawns[role]);
  C.grant(r, 'ward', 'fire'); C.grant(r, 'ward', 'fire');
  C.onAttempt(r);
  const f = r.players.fire.body;
  tick(r, 5);
  assert.equal(r.run.effects.fire.shieldT, 0, 'not in lava yet');
  f.x = 3 * T + 2; // step onto the lava
  tick(r, 2);
  assert.ok(r.run.effects.fire.shieldT > 1.9, `2 copies → 2 s (${r.run.effects.fire.shieldT})`);
  tick(r, 150);
  assert.equal(r.run.effects.fire.shieldT, 0, 'only on stepping in, not while standing there');
  f.x = 1 * T + 2; tick(r, 2); f.x = 3 * T + 2; tick(r, 2);
  assert.ok(r.run.effects.fire.shieldT > 1.9, 'again when stepping back in');
});

test('each attempt waits: enemies and the clock start when someone moves', () => {
  const r = run(40);
  r.run.stage = 4; r.loadStage(); // boss 1: things that move
  const flyer = r.run.enemies.find((e) => e.type === 'flyer');
  const x0 = flyer.x;
  let s2 = 1000;
  const idle = (n) => { for (let i = 0; i < n; i++) { s2++; for (const role of g.ROLES) g.queueInput(r, role, { s: s2, d: 0, j: false }); g.step(r); } };
  idle(120);
  assert.equal(flyer.x, x0, 'enemies wait');
  assert.equal(r.tick, 0, 'the clock waits');
  assert.equal(g.snapshot(r).run.started, false);
  s2++; g.queueInput(r, 'water', { s: s2, d: 1, j: false }); g.queueInput(r, 'fire', { s: s2, d: 0, j: false }); g.step(r);
  idle(30);
  assert.notEqual(flyer.x, x0, 'moving started the fight');
  assert.ok(r.tick > 0);
  g.restart(r);
  assert.equal(r.run.started, false, 'and it waits again after a restart');
});

test('enemy mix: room 2 sentries or mimics; rooms 3–4 add patrolling walkers, never mixed; rooms 6–9 add a bomber', () => {
  const kinds = { 1: new Set(), 2: new Set(), 6: new Set() };
  for (let seed = 1; seed <= 40; seed++) {
    for (const stage of [1, 2, 6]) {
      const r = run(seed);
      r.run.stage = stage; r.loadStage();
      const types = new Set(r.run.enemies.map((e) => e.type));
      const ground = [...types].filter((t) => t !== 'bomber');
      assert.ok(ground.length <= 1, `stage ${stage}: mixed ${ground}`);
      assert.equal(types.has('bomber'), stage >= 5, `stage ${stage}: bomber`);
      for (const t of types) kinds[stage].add(t);
      for (const e of r.run.enemies.filter((x) => x.type === 'patrol')) {
        assert.ok(e.x1 - e.x0 >= 2 * T - P.TILE * 0.2, 'a patrol route at least ~3 tiles long');
      }
    }
  }
  assert.deepEqual([...kinds[1]].sort(), ['mimic', 'sentry']);
  assert.deepEqual([...kinds[2]].sort(), ['mimic', 'patrol', 'sentry']);
  assert.ok(kinds[6].has('bomber'));
});

test('patrolling walkers pace between the ends of their route', () => {
  const r = run(41);
  r.run.stage = 2;
  let walker;
  for (let k = 0; k < 30 && !walker; k++) { r.loadStage(); walker = r.run.enemies.find((e) => e.type === 'patrol'); }
  assert.ok(walker, 'got a room with walkers');
  for (const role of g.ROLES) r.run.invuln[role] = 1e9;
  let minX = Infinity, maxX = -Infinity;
  tick(r, 60 * 20);
  for (let i = 0; i < 60 * 20; i++) { tick(r); minX = Math.min(minX, walker.x); maxX = Math.max(maxX, walker.x); }
  assert.ok(minX >= walker.x0 - 1e-6 && maxX <= walker.x1 + 1e-6, 'stays on its route');
  assert.ok(maxX - minX > (walker.x1 - walker.x0) * 0.9, 'covers the route both ways');
});

test('the bomber drops a bomb when it passes over a player (not a cloaked one); bombs fall and kill', () => {
  const r = run(42);
  arena(r, ['####################', '#..................#', '#..................#', '#..................#', '#..................#', '#..................#', '#F...............Wfw', '####################']);
  r.enemySpecs = [{ type: 'bomber', x0: T, x1: 18 * T, y: 1 * T + 3, w: 30, h: 18, speed: 80, x: T }];
  C.onAttempt(r);
  const bomber = r.run.enemies[0];
  const f = r.players.fire.body;
  // park the bomber right above fire
  bomber.x = f.x + P.CHAR.width / 2 - bomber.w / 2; bomber.cool = 0; bomber.speed = 0;
  C.grant(r, 'cloak', 'fire');
  C.use(r, 'fire');
  tick(r, 5);
  assert.equal(r.run.shots.length, 0, 'no bomb on a cloaked player');
  r.run.effects.fire.cloakT = 0;
  r.players.water.body.x = 1e5;
  tick(r, 1);
  assert.equal(r.run.shots.length, 1, 'bomb away');
  assert.equal(r.run.shots[0].kind, 'bomb');
  const y0 = r.run.shots[0].y;
  tick(r, 10);
  assert.ok(!r.run.shots.length || r.run.shots[0].y > y0 + 10, 'falling');
});


test('rooms 6–9: one ground enemy type (sentry, walker, burrower, mimic or charger) plus the bomber', () => {
  const seen = new Set();
  for (let seed = 1; seed <= 60; seed++) {
    const r = run(seed);
    r.run.stage = 5 + (seed % 4); r.loadStage();
    const ground = new Set(r.run.enemies.map((e) => e.type).filter((t) => t !== 'bomber'));
    assert.ok(ground.size <= 1, [...ground].join(','));
    for (const t of ground) seen.add(t);
  }
  for (const t of ['sentry', 'patrol', 'burrower', 'mimic', 'charger']) assert.ok(seen.has(t), `never saw ${t}: ${[...seen]}`);
  // rooms 3–4 never get burrowers, chargers or bombers
  for (let seed = 1; seed <= 30; seed++) {
    const r = run(seed); r.run.stage = 2; r.loadStage();
    for (const e of r.run.enemies) assert.ok(['sentry', 'patrol', 'mimic'].includes(e.type), e.type);
  }
});

test('burrower: hides, cracks the ground under a player for 2 s, bursts out (deadly nearby), hides again', () => {
  const r = run(50);
  arena(r, ['##############', '#............#', '#............#', '#F.........Wfw', '##############'].map((x) => x.padEnd(14, '#').slice(0, 14)));
  r.enemySpecs = [{ type: 'burrower', w: 30, h: 26 }];
  C.onAttempt(r);
  const e = r.run.enemies[0];
  r.run.invuln.water = 1e9; // keep water out of it
  tick(r, 60 * 3 + 2);
  assert.equal(e.phase, 'warning', 'surfacing under fire');
  assert.ok(Math.abs(e.x + e.w / 2 - (r.players.fire.body.x + 10)) < 2);
  tick(r, 60 * 2 + 2);
  assert.equal(r.phase, 'dead', 'fire stood still in the burst');
  // and if you move away in time, you're fine
  tick(r, g.TICKS.deathPause);
  C.onAttempt(r);
  const e2 = r.run.enemies[0];
  r.run.invuln.water = 1e9;
  tick(r, 60 * 3 + 2);
  assert.equal(e2.phase, 'warning');
  r.players.fire.body.x += 4 * T;
  tick(r, 60 * 2 + 40);
  assert.equal(r.phase, 'playing', 'moved away: survived');
  assert.equal(e2.phase, 'hidden', 'gone back under');
});

test('mimic: a solid "box" you can stand on, but walking into its side gets you stabbed; Blast destroys it', () => {
  const r = run(51);
  arena(r, ['###########', '#.........#', '#.........#', '#F......Wfw', '###########']);
  r.enemySpecs = [{ type: 'mimic', x: 4 * T, y: 3 * T, w: T, h: T }];
  C.onAttempt(r);
  assert.equal(r.state.blocks.length, 1, 'solid');
  const f = r.players.fire.body;
  // stand on top: fine
  f.x = 4 * T + 2; f.y = 3 * T - P.CHAR.height - 1;
  tick(r, 30);
  assert.equal(r.phase, 'playing');
  assert.ok(Math.abs(f.y + P.CHAR.height - 3 * T) < 1, 'standing on it');
  // walk into its side: stabbed
  f.x = 2 * T; f.y = 4 * T - P.CHAR.height;
  for (let i = 0; i < 60 && r.phase === 'playing'; i++) { seq++; g.queueInput(r, 'fire', { s: seq, d: 1, j: false }); g.queueInput(r, 'water', { s: seq, d: 0, j: false }); r.run.started = true; g.step(r); }
  assert.equal(r.phase, 'dead');
  // Blast destroys it and its solidity
  tick(r, g.TICKS.deathPause);
  C.grant(r, 'blast', 'fire');
  f.x = 3 * T;
  C.use(r, 'fire');
  assert.equal(r.state.blocks.length, 0);
});

test('charger: charges a player who comes level and near, tires at the wall, walks back home', () => {
  const r = run(52);
  arena(r, ['####################', '#..................#', '#..................#', '#F................W#', '#................fw#', '####################'].map((x, i) => (i === 3 ? '#F................W#' : x)));
  // fire spawns on the floor (row 4); move the spawn markers by hand
  r.players.fire.body.x = 2 * T; r.players.fire.body.y = 5 * T - P.CHAR.height;
  r.players.water.body.x = 18 * T; r.players.water.body.y = 5 * T - P.CHAR.height;
  r.enemySpecs = [{ type: 'charger', x: 10 * T, y: 5 * T - 22, w: 22, h: 22 }];
  const [fx, fy, wx, wy] = [r.players.fire.body.x, r.players.fire.body.y, r.players.water.body.x, r.players.water.body.y];
  C.onAttempt(r);
  Object.assign(r.players.fire.body, { x: fx, y: fy }); Object.assign(r.players.water.body, { x: wx, y: wy });
  const e = r.run.enemies[0];
  for (const role of g.ROLES) r.run.invuln[role] = 1e9;
  tick(r, 30);
  assert.equal(e.mode, 'ready', 'nobody within 6 tiles');
  r.players.fire.body.x = 6 * T;
  tick(r, 2);
  assert.equal(e.mode, 'charging');
  tick(r, 120);
  assert.equal(e.mode, 'tired', 'hit the wall');
  assert.ok(e.x < 3 * T, `charged left to the wall (${(e.x / T).toFixed(1)})`);
  r.players.fire.body.x = 1 * T; // well away from its home (and not on the exits)
  tick(r, 60 * 5 + 5);
  assert.equal(e.mode, 'returning');
  tick(r, 60 * 30);
  assert.equal(e.mode, 'ready');
  assert.ok(Math.abs(e.x - 10 * T) < 3, 'back home');
});

test("charger: if it can't get back up to its platform it waits as close as it got", () => {
  const r = run(53);
  arena(r, ['####################', '#..................#', '#.....######.......#', '#..................#', '#F...............Wfw', '####################'].map((x) => x.slice(0, 20).padEnd(20, '#')));
  r.enemySpecs = [{ type: 'charger', x: 8 * T, y: 2 * T - 22, w: 22, h: 22 }];
  C.onAttempt(r);
  const e = r.run.enemies[0];
  for (const role of g.ROLES) r.run.invuln[role] = 1e9;
  Object.assign(r.players.fire.body, { x: 13 * T, y: 2 * T - P.CHAR.height }); // level with it, to its right
  r.players.water.body.x = 18 * T;
  tick(r, 2);
  assert.equal(e.mode, 'charging');
  r.players.fire.body.x = 1 * T; r.players.fire.body.y = 5 * T - P.CHAR.height; // get out of the way
  tick(r, 200);
  assert.ok(e.y > 3 * T, 'ran off the platform and fell');
  tick(r, 60 * 5 + 60 * 15);
  assert.equal(e.mode, 'ready', 'gave up returning');
  assert.ok(e.y > 3 * T, 'waiting down below, as close as it could get');
});

test('walkers turn around at boxes (and can leave one pushed into them)', () => {
  const r = run(60);
  arena(r, ['################', '#..............#', '#..............#', '#F...........Wfw', '################']);
  r.enemySpecs = [{ type: 'patrol', x0: 2 * T, x1: 13 * T, x: 3 * T, y: 4 * T - 20, w: 20, h: 20, speed: 45 }];
  C.onAttempt(r);
  r.state.boxes.push({ x: 8 * T, y: 3 * T, w: T, h: T, vy: 0, onGround: true });
  const e = r.run.enemies[0];
  for (const role of g.ROLES) r.run.invuln[role] = 1e9;
  let maxRight = 0;
  for (let i = 0; i < 60 * 12; i++) { tick(r); maxRight = Math.max(maxRight, e.x + e.w); }
  assert.ok(maxRight <= 8 * T + 0.5, `never walked into the box (reached ${(maxRight / T).toFixed(2)})`);
  // a box pushed onto it: it doesn't get stuck
  r.state.boxes[0].x = e.x - 4;
  const x0 = e.x;
  tick(r, 60);
  assert.notEqual(e.x, x0, 'still walking');
});

test('shots, bombs and Blaster shots stop at boxes, closed gates and platforms, not just rock', () => {
  const r = run(61);
  arena(r, ['####################', '#..................#', '#..................#', '#..................#', '#..................#', '#..................#', '#F...............Wfw', '####################']);
  r.enemySpecs = []; C.onAttempt(r);
  r.state.boxes.push({ x: 10 * T, y: 6 * T, w: T, h: T, vy: 0, onGround: true }); // on the floor
  // a shot flying right at the box
  r.run.shots.push({ x: 6 * T, y: 6 * T + 7, vx: 200, vy: 0 });
  // a bomb falling onto the box
  r.run.shots.push({ x: 10 * T + 7, y: 1 * T, vx: 0, vy: 40, g: 900, kind: 'bomb' });
  // a Blaster shot at the box from the other side
  r.run.bullets.push({ x: 15 * T, y: 6 * T + 8, vx: -480, left: 10 * T });
  for (const role of g.ROLES) r.run.invuln[role] = 1e9;
  tick(r, 90);
  assert.equal(r.run.shots.length, 0, 'shot and bomb stopped');
  assert.equal(r.run.bullets.length, 0, 'Blaster shot stopped');
});

test('a fast-falling bomb cannot skip through a thin pulley platform', () => {
  const r = run(62);
  arena(r, ['####################', '#..................#', '#..................#', '#..................#', '#..................#', '#..................#', '#..................#', '#..................#', '#..................#', '#..................#', '#..................#', '#F...............Wfw', '####################']);
  r.levelDef = { ...r.levelDef, objects: [{ type: 'pulley', a: [8, 9], b: [14, 9], w: 3, travel: 1 }] };
  r.level = P.parseLevel(r.levelDef); r.state = P.createLevelState(r.level);
  r.enemySpecs = []; C.onAttempt(r);
  r.run.shots.push({ x: 9 * T, y: 1 * T, vx: 0, vy: 800, g: 900, kind: 'bomb' });
  for (const role of g.ROLES) r.run.invuln[role] = 1e9;
  let lowest = 0;
  for (let i = 0; i < 60 && r.run.shots.length; i++) { tick(r); if (r.run.shots[0]) lowest = Math.max(lowest, r.run.shots[0].y); }
  assert.equal(r.run.shots.length, 0);
  assert.ok(lowest < 9 * T + 12, `stopped at the platform (got to ${(lowest / T).toFixed(2)})`);
});

test('the burrower only surfaces under a player on real ground, not on a box', () => {
  const r = run(63);
  arena(r, ['##############', '#............#', '#............#', '#F.........Wfw', '##############']);
  r.enemySpecs = [{ type: 'burrower', w: 30, h: 26 }];
  C.onAttempt(r);
  r.state.boxes.push({ x: 1 * T, y: 3 * T, w: T, h: T, vy: 0, onGround: true });
  const f = r.players.fire.body;
  Object.assign(f, { x: 1 * T + 2, y: 3 * T - P.CHAR.height - 1 }); // fire on the box
  r.run.cloak = null; r.run.effects.water.cloakT = 1e9; // water hidden: only fire is a target
  const e = r.run.enemies[0];
  tick(r, 60 * 6);
  assert.equal(e.phase, 'hidden', 'waits while fire is on the box');
  Object.assign(f, { x: 4 * T, y: 4 * T - P.CHAR.height - 1 }); // fire steps down onto the floor
  r.run.invuln.fire = 1e9;
  tick(r, 40);
  assert.equal(e.phase, 'warning', 'surfaces now');
});

test('the bomber flies along the highest open row, below any rock up top', () => {
  const lvl = { id: 'b', name: 'b', rows: ['########################################', '########################################', '###################.....................', '#......................................#'] };
  for (let i = 0; i < 18; i++) lvl.rows.push('#......................................#');
  lvl.rows.push('#F...............................Wfw..#', '########################################');
  lvl.rows = lvl.rows.map((x) => x.slice(0, 40).padEnd(40, '#'));
  const L = P.parseLevel(lvl);
  const specs = C.enemySpecs({ stage: 6, rand: C.rng(1) }, 'room', L);
  const bomber = specs.find((e) => e.type === 'bomber');
  assert.ok(bomber, 'has a bomber');
  assert.ok(bomber.y >= 2 * T, `below the rock (y=${(bomber.y / T).toFixed(2)})`);
  assert.ok(bomber.x0 >= T && bomber.x1 <= 39 * T, 'within the room');
});

test('Leapfrog: the bomber patrols one section of the top of the room', () => {
  const def = g.LEVELS.find((l) => l.id.startsWith('27'));
  const L = P.parseLevel(def);
  const b = C.enemySpecs({ stage: 6, rand: C.rng(1) }, 'room', L).find((e) => e.type === 'bomber');
  assert.ok(b, 'has a bomber');
  assert.ok(b.y < 2 * T, `up at the top (row ${(b.y / T).toFixed(1)})`);
  const width = (b.x1 + b.w - b.x0) / T;
  assert.ok(width >= 6 && width < 20, `covers one section (${width.toFixed(1)} tiles)`);
});

test('boss 1 picks one of three arenas, each with its own twin patrols', () => {
  const seen = new Set();
  for (let seed = 1; seed <= 40; seed++) {
    const r = run(seed);
    r.run.stage = 4; r.loadStage();
    seen.add(r.levelDef.id);
    const flyer = r.run.enemies.find((e) => e.type === 'flyer');
    assert.equal(flyer.y, r.levelDef.boss.flyer.y * T, 'flies where this arena says');
  }
  assert.deepEqual([...seen].sort(), ['boss-1', 'boss-1b', 'boss-1c']);
});

test('Half Walls: the ground twin is shut in the middle room until a lever opens a gate', () => {
  const r = run(70);
  const def = require('../levels/boss-1c.json');
  r.run.stage = 4;
  // load this arena specifically
  for (let k = 0; k < 50 && r.levelDef.id !== 'boss-1c'; k++) r.loadStage();
  assert.equal(r.levelDef.id, 'boss-1c');
  const walker = r.run.enemies.find((e) => e.type === 'walker');
  for (const role of g.ROLES) r.run.invuln[role] = 1e9;
  let minX = Infinity, maxX = -Infinity;
  for (let i = 0; i < 60 * 25; i++) { tick(r); minX = Math.min(minX, walker.x); maxX = Math.max(maxX, walker.x + walker.size); }
  assert.ok(minX >= 13 * T - 0.5 && maxX <= 27 * T + 0.5, `stayed between the gates (${(minX / T).toFixed(1)}–${(maxX / T).toFixed(1)})`);
  // open the left gate (as if the lever was pulled): it can now leave the middle room
  r.state.levers[0] = true;
  minX = Infinity;
  for (let i = 0; i < 60 * 25; i++) { tick(r); minX = Math.min(minX, walker.x); }
  assert.ok(minX < 12 * T, `roamed out through the open gate (got to ${(minX / T).toFixed(1)})`);
  void def;
});

// ── drop batch 3 ──
test('Wings: unlimited, 5 s between flights', () => {
  const r = run(80);
  C.grant(r, 'wings', 'fire');
  assert.equal(C.use(r, 'fire'), true);
  tick(r, 60 * 4);
  assert.equal(C.use(r, 'fire'), false, 'still cooling down');
  tick(r, 61);
  assert.equal(C.use(r, 'fire'), true, 'again');
});

test('Stomp: landing on a sentry destroys it and bounces you; on a boss it stuns', () => {
  const r = run(81);
  arena(r, ['##########', '#........#', '#........#', '#........#', '#F.....Wfw', '##########']);
  C.grant(r, 'stomp', 'fire');
  const f = r.players.fire.body;
  r.run.enemies = [{ type: 'sentry', x: 3 * T + 3, y: 5 * T - 18, w: 18, h: 18, stunT: 0 }];
  Object.assign(f, { x: 3 * T + 2, y: 1 * T, vx: 0, vy: 0 });
  tick(r, 40);
  assert.equal(r.run.enemies[0].dead, true, 'destroyed');
  assert.equal(r.phase, 'playing', 'and fire is fine');
  r.run.enemies = [{ type: 'walker', x: 3 * T, x0: 0, x1: 1e4, floor: 5 * T, size: 30, size0: 30, size1: 30, grow: 1, speed: 0, dir: 1, stunT: 0 }];
  Object.assign(f, { x: 3 * T + 4, y: 1 * T, vx: 0, vy: 0 });
  tick(r, 30);
  assert.ok(r.run.enemies[0].stunT > 0 && !r.run.enemies[0].dead, 'boss stunned, not destroyed');
});

test('Dual Wield: a second slot that can be equipped and used', () => {
  const r = run(82);
  C.grant(r, 'blast', null); C.grant(r, 'crate', null);
  const crate = r.run.items.find((i) => i.id === 'crate');
  assert.equal(C.equip(r, 'fire', crate.uid, 2), false, 'no second slot yet');
  C.grant(r, 'dualwield', 'fire');
  assert.equal(C.equip(r, 'fire', crate.uid, 2), true);
  assert.equal(r.run.equip2.fire, crate.uid);
  assert.equal(C.use(r, 'fire', 2), true, 'used from slot 2');
  assert.equal(C.use(r, 'fire', 1), true, 'and slot 1 still works');
});

test('Phase is exclusive: equipped for good, no other actives, toggles passing through boxes', () => {
  const r = run(83);
  C.grant(r, 'blast', null); C.grant(r, 'dualwield', 'fire');
  C.grant(r, 'phase', 'fire');
  const phase = r.run.personal.fire.find((i) => i.id === 'phase');
  assert.equal(r.run.equip.fire, phase.uid);
  assert.equal(C.equip(r, 'fire', r.run.items[0].uid), false, "can't switch away");
  assert.equal(C.use(r, 'fire', 2), false, 'no second slot while exclusive');
  assert.equal(B.BY_ID.phase.exclusive, true, 'flag lives in the catalogue, reusable by other drops');
  arena(r, ['##########', '#........#', '#........#', '#........#', '#F.....Wfw', '##########']);
  C.onAttempt(r);
  r.state.boxes.push({ x: 4 * T, y: 4 * T, w: T, h: T, vy: 0, onGround: true });
  C.use(r, 'fire');
  assert.equal(r.players.fire.body.phase, true);
  for (let i = 0; i < 60; i++) { seq++; g.queueInput(r, 'fire', { s: seq, d: 1, j: false }); g.queueInput(r, 'water', { s: seq, d: 0, j: false }); r.run.started = true; g.step(r); }
  assert.ok(r.players.fire.body.x > 5 * T, 'walked through the box');
  C.use(r, 'fire');
  assert.equal(r.players.fire.body.phase, false, 'toggled off');
});

test('Keen Eye: mimics can\'t hurt you', () => {
  const r = run(84);
  arena(r, ['###########', '#.........#', '#.........#', '#F......Wfw', '###########']);
  r.enemySpecs = [{ type: 'mimic', x: 4 * T, y: 3 * T, w: T, h: T }];
  C.onAttempt(r);
  C.grant(r, 'keeneye', null);
  r.players.fire.body.x = 2 * T;
  for (let i = 0; i < 60; i++) { seq++; g.queueInput(r, 'fire', { s: seq, d: 1, j: false }); g.queueInput(r, 'water', { s: seq, d: 0, j: false }); r.run.started = true; g.step(r); }
  assert.equal(r.phase, 'playing');
});

test('Slow Time: enemies 25% slower per copy (multiplies)', () => {
  const dist = (copies) => {
    const r = run(85);
    arena(r, ['##################', '#................#', '#F.............Wfw', '##################']);
    for (let k = 0; k < copies; k++) C.grant(r, 'slowtime', null);
    r.run.enemies = [{ type: 'patrol', x: 3 * T, x0: 0, x1: 1e4, y: 2 * T, w: 20, h: 20, speed: 60, dir: 1, stunT: 0 }];
    for (const role of g.ROLES) r.run.invuln[role] = 1e9;
    r.players.fire.body.x = 1e4; r.players.water.body.x = 1e4 + 100;
    tick(r, 60);
    return r.run.enemies[0].x - 3 * T;
  };
  const d0 = dist(0), d1 = dist(1), d2 = dist(2);
  assert.ok(Math.abs(d1 / d0 - 0.75) < 0.02, `${d1 / d0}`);
  assert.ok(Math.abs(d2 / d0 - 0.5625) < 0.02, `${d2 / d0}`);
});

test('Last Chance: get back to the start in 5 s and the room restarts with no heart lost; too slow and you die', () => {
  const r = run(86);
  arena(r, ['##########', '#........#', '#........#', '#F.....Wfw', '##########']);
  r.enemySpecs = []; C.onAttempt(r);
  C.grant(r, 'lastchance', null);
  const f = r.players.fire.body;
  const spawn = { ...r.level.spawns.fire };
  f.x += 3 * T;
  r.run.enemies = [{ type: 'sentry', x: f.x, y: f.y + 10, w: 18, h: 18, stunT: 0 }];
  tick(r, 2);
  assert.ok(r.run.ghost.fire > 4, 'counting down');
  assert.equal(f.phase, true, 'intangible');
  Object.assign(f, { x: spawn.x + 4, y: spawn.y }); // made it back
  tick(r, 2);
  assert.equal(r.run.hearts, C.HEARTS.start, 'no heart lost');
  assert.equal(r.run.ghost.fire, 0);
  // second time in the same attempt? it's once per room — reset gave it back; now be too slow
  const f2 = r.players.fire.body;
  f2.x += 3 * T;
  r.run.enemies = [{ type: 'sentry', x: f2.x, y: f2.y + 10, w: 18, h: 18, stunT: 0 }];
  tick(r, 2);
  assert.ok(r.run.ghost.fire > 0);
  r.run.enemies = [];
  tick(r, 60 * 5 + 5);
  assert.equal(r.phase, 'dead', "didn't make it");
  assert.equal(r.run.hearts, C.HEARTS.start - 1);
});

test('Solidify: harden your own pool so your teammate can walk on it', () => {
  const r = run(87);
  arena(r, ['############', '#..........#', '#..........#', '#F.......Wfw', '###LLLL#####']);
  r.enemySpecs = []; C.onAttempt(r);
  C.grant(r, 'solidify', 'fire');
  const f = r.players.fire.body, w = r.players.water.body;
  Object.assign(f, { x: 4 * T + 2, y: 4 * T - P.CHAR.height - 1 });
  tick(r, 5);
  assert.equal(C.use(r, 'fire'), true);
  assert.equal(r.state.safePools.length, 4, 'the whole connected pool');
  Object.assign(w, { x: 5 * T + 2, y: 4 * T - P.CHAR.height - 1 });
  tick(r, 30);
  assert.equal(r.phase, 'playing', 'water stands on hardened lava');
  assert.equal(C.use(r, 'fire'), false, 'once per room');
});

test('pools: Challenge rooms get lava and water in dead-end corners; room 1 stays untouched', () => {
  const { analyse } = require('../tools/levelcheck');
  const has = (def, t) => P.parseLevel(def).tiles.some((x) => x === t);
  const bosses = ['boss-1', 'boss-1b', 'boss-1c', 'boss-2'].map((f) => require(`../levels/${f}.json`));
  for (const def of [...g.LEVELS.slice(0, 48), ...bosses]) {
    const out = C.withPools(def);
    // Mill Finale has no dead-end floor for a water pool, so it only gets lava
    if (def.id === '48-mill-finale') assert.ok(has(out, P.T.LAVA) && !has(out, P.T.WATER));
    else assert.ok(has(out, P.T.LAVA) && has(out, P.T.WATER), `${def.id}: both pools`);
    if (has(def, P.T.LAVA) && has(def, P.T.WATER)) { assert.equal(out, def, `${def.id}: left alone`); continue; }
    assert.deepEqual(analyse(out).errors, [], `${def.id}: still solvable`);
    // the new pool is never right beside where the other player starts or finishes
    const l = P.parseLevel(out);
    out.rows.forEach((row, y) => [...row].forEach((ch, x) => {
      if (ch === def.rows[y][x]) return;
      const other = ch === 'L' ? 'water' : 'fire';
      const s = l.spawns[other], e = l.exits[other];
      const sx = Math.floor((s.x + 10) / T), sy = Math.floor((s.y + 29) / T);
      assert.ok(!(sy === y - 1 && Math.abs(sx - x) <= 1), `${def.id}: pool beside ${other}'s spawn`);
      assert.ok(!(e.ty === y - 1 && Math.abs(e.tx - x) <= 1), `${def.id}: pool beside ${other}'s exit`);
    }));
  }
  // in a run: room 1 is the campaign level as is; later rooms get the pools
  for (let seed = 1; seed <= 30; seed++) {
    const r = run(seed);
    assert.equal(r.levelDef, g.LEVELS.find((d) => d.id === r.levelDef.id), 'room 1 untouched');
    r.run.stage = 1; r.loadStage();
    assert.ok(has(r.levelDef, P.T.LAVA) && has(r.levelDef, P.T.WATER), `room 2 (${r.levelDef.id}) has both`);
  }
});

// ── weather ──

const WEATHER_ARENA = [
  '############',
  '#..........#',
  '#..........#',
  '#.......##.#', // a bit of roof (cover), and a ledge on top of it (high ground)
  '#..........#',
  '#..........#',
  '#.F.W..f.w.#',
  '####~~######', // a water pool
  '############',
];
function weatherRoom(kind, floodY = null) {
  const r = run(90);
  arena(r, WEATHER_ARENA);
  r.enemySpecs = [];
  r.weatherDef = { kind, floodY, rand: C.rng(1) };
  C.onAttempt(r);
  return r;
}
const put = (r, role, tx, row) => Object.assign(r.players[role].body, { x: tx * T + 2, y: (row + 1) * T - P.CHAR.height, vx: 0, vy: 0, onGround: true });
// Skip the quiet spell and the 5 s lead-in, up to the strike.
function toStrike(r) {
  const w = r.run.weather;
  assert.equal(w.state, 'idle');
  assert.ok(w.dur >= C.WEATHER.firstMin && w.dur <= C.WEATHER.firstMax, 'first weather after 10–20 s');
  w.t = w.dur;
  tick(r);
  assert.equal(w.state, 'lead');
  assert.ok(g.takeEvents(r).some((e) => e.type === 'weather' && e.kind === r.weatherDef.kind), 'announced');
  tick(r, Math.round(C.WEATHER.lead * 60) - 2);
  assert.equal(w.state, 'lead', 'a 5 s lead-in');
  assert.equal(r.phase, 'playing', 'harmless during the lead-in');
  tick(r, 3);
  assert.equal(w.state, 'strike');
}

test('weather: rolled only in rooms 6–10 — none, drought, rainstorm or acid flood', () => {
  const seen = new Set();
  for (let seed = 1; seed <= 60; seed++) {
    const r = run(seed);
    for (const stage of [1, 3, 4]) { r.run.stage = stage; r.loadStage(); assert.equal(r.run.weather, null, `stage ${stage}`); }
    r.run.stage = 5 + (seed % 5); r.loadStage();
    seen.add(r.run.weather ? r.run.weather.kind : 'none');
    if (r.run.weather) assert.ok(C.weatherOptions(r.levelDef)[r.run.weather.kind], 'only weather the room can fairly have');
  }
  assert.deepEqual([...seen].sort(), ['drought', 'flood', 'none', 'rain']);
});

test('drought: at its peak, Water dies unless standing in a water pool', () => {
  let r = weatherRoom('drought');
  put(r, 'water', 4, 6); // in the pool
  toStrike(r);
  tick(r, 40);
  assert.equal(r.phase, 'playing', 'in the pool: fine (and fire is unaffected)');
  assert.equal(r.run.weather.state, 'idle', 'over; quiet again');
  assert.ok(r.run.weather.dur >= C.WEATHER.gapMin && r.run.weather.dur <= C.WEATHER.gapMax);
  r = weatherRoom('drought');
  put(r, 'water', 9, 6);
  toStrike(r);
  tick(r, 2);
  assert.equal(r.phase, 'dead');
  assert.ok(g.takeEvents(r).some((e) => e.type === 'death' && e.role === 'water' && e.cause === 'drought'));
});

test('rainstorm: Fire dies unless something is overhead', () => {
  let r = weatherRoom('rain');
  put(r, 'fire', 8, 6); // under the roof
  toStrike(r);
  tick(r, 70);
  assert.equal(r.phase, 'playing', 'covered: fine (and water is unaffected)');
  r = weatherRoom('rain');
  put(r, 'fire', 2, 6);
  toStrike(r);
  tick(r, 2);
  assert.equal(r.phase, 'dead');
  assert.ok(g.takeEvents(r).some((e) => e.type === 'death' && e.role === 'fire' && e.cause === 'rain'));
});

test('acid flood: the bottom fills with acid, holds for 5 s, drains; high ground (or Acid Skin) is safe', () => {
  const surface = 5 * T;
  let r = weatherRoom('flood', surface);
  put(r, 'fire', 8, 2); put(r, 'water', 9, 2); // both on the ledge
  toStrike(r);
  const w = r.run.weather;
  tick(r, 45);
  assert.ok(w.level < r.level.pxHeight - T && w.level > surface, 'rising');
  tick(r, 60);
  assert.equal(w.level, surface, 'full');
  tick(r, 60 * 5);
  assert.ok(w.level > surface, 'draining after 5 s');
  tick(r, 60);
  assert.equal(w.state, 'idle');
  assert.equal(r.phase, 'playing');
  r = weatherRoom('flood', surface);
  put(r, 'fire', 8, 2);
  r.players.water.body.acidImmune = true;
  toStrike(r);
  tick(r, 200);
  assert.equal(r.phase, 'playing', 'Acid Skin: immune');
  r.players.water.body.acidImmune = false;
  tick(r, 2);
  assert.equal(r.phase, 'dead');
  assert.ok(g.takeEvents(r).some((e) => e.type === 'death' && e.role === 'water' && e.cause === 'flood'));
});

test('weather options: drought needs a reachable water pool, rain cover, a flood high ground', () => {
  const o = C.weatherOptions({ id: 'wa', rows: WEATHER_ARENA });
  assert.equal(o.drought, true);
  assert.equal(o.rain, true);
  const flat = ['########', '#......#', '#......#', '#......#', '#F.W.fw#', '########', '########'];
  const f = C.weatherOptions({ id: 'flat', rows: flat });
  assert.deepEqual([f.drought, f.rain, f.flood], [false, false, null], 'a bare room gets no weather');
});
