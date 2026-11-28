// Challenge mode: a roguelike run of 10 rooms — 4 normal rooms, boss 1, 4 normal rooms,
// boss 2 — with team hearts, a team inventory, personal inventories, and a map between
// rooms where the team votes on a team bonus (rock-paper-scissors on a tie) and each
// player picks a personal one. Enemies live here too. No I/O; driven by src/game.js.

const P = require('../shared/physics');
const B = require('../shared/bonuses');
const E = require('../shared/enemies');

const ROLES = ['fire', 'water'];
const STAGES = ['room', 'room', 'room', 'room', 'boss1', 'room', 'room', 'room', 'room', 'boss2'];
const HEARTS = { start: 5, max: 8 };
const GUARDIAN_SECONDS = 1;          // Guardian: shielded after your first hit each room
const LAST_CHANCE_SECONDS = 5;      // Last Chance: seconds to get back to the start
// The acid floor, weather clock and mimic timings live in shared/enemies.js (the client
// predicts them too). Boss 2's acid: a 3 s countdown, then all ground burns for 0.1 s; a
// jump keeps you in the air ~0.62 s, so you have about half a second in which to jump.
// Weather: drought (water must be in a water pool), rainstorm (fire must be under cover),
// acid flood (get above it).
const { ACID, WEATHER, MIMIC } = E;
const GUN = { speed: 480, range: 5 * 24, size: 8 };
const PATROL = { size: 20, speed: 45, minRun: 3 };          // walkers pacing along platforms
const BOMBER = { w: 30, h: 18, speed: 80, cooldown: 1.2, gravity: 900, size: 10 };
// Rooms 6–9 only:
const BURROW = { hideMin: 5, hideMax: 10, warn: 2, out: 0.6, radius: 1.5 * 24 };  // hides, cracks, bursts
const CHARGER = { size: 22, sight: 6 * 24, height: 1.5 * 24, charge: 1.6, back: 0.35, maxRun: 10 * 24, tired: 5, minRun: 5 };
const SHOOTER = { period: 1.6, speed: 200, size: 10 };
// Chests (rooms 2–4 and 6–9): half the rooms have one. Open it (touch it) to get a
// team bonus after the room: common, or uncommon from a rare chest. Rare chests are
// usually high up on a little platform of their own. Neither has to be reachable.
const CHEST = { chance: 0.5, rare: 0.1, rarePlatform: 0.7, w: 20, h: 16 };
// Fake chests (same rooms): mimics that look like a chest. Rolled separately from the
// real chest, so a room can have either, both or neither.
const FAKE_CHEST = { chance: 0.25 };
const LIFESTEAL = 0.3; // chance of a heart per enemy destroyed
// Boss 1 has three arenas (picked at random per run); boss 2 has one.
const BOSS_DEFS = {
  boss1: [require('../levels/boss-1.json'), require('../levels/boss-1b.json'), require('../levels/boss-1c.json')],
  boss2: [require('../levels/boss-2.json')],
};
const T = P.TILE;

// Small seeded RNG (mulberry32), so a run can be replayed from its seed.
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pickN = (rand, arr, n) => {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a.slice(0, n);
};

function createRun(seed = (Math.random() * 2 ** 32) >>> 0) {
  return {
    seed,
    rand: rng(seed),
    stage: -1,
    hearts: HEARTS.start,
    maxHearts: HEARTS.max,
    items: [],                       // team inventory: { uid, id, ready, spent, coolT }
    personal: { fire: [], water: [] }, // each player's own items, same shape
    nextUid: 1,
    equip: { fire: null, water: null },  // uid of the active item in each player's ✦ slot
    equip2: { fire: null, water: null }, // second slot (Dual Wield)
    ghost: { fire: 0, water: 0 },        // Last Chance countdown (s): intangible, get back to the start
    lastChanceUsed: false,
    effects: { fire: { cloakT: 0, shieldT: 0 }, water: { cloakT: 0, shieldT: 0 } },
    inElement: { fire: false, water: false }, // for Element Ward: were you in your element last tick?
    bullets: [],                     // Blaster shots
    used: new Set(),                 // campaign levels already played this run
    map: null,                       // the between-rooms screen (votes and picks)
    result: null,                    // 'victory' | 'defeat'
    guardUsed: { fire: false, water: false },
    invuln: { fire: 0, water: 0 },
    time: 0,                         // seconds into the current attempt (enemy clocks)
    enemies: [],
    shots: [],
    acid: null,                      // { next, countdown, burning }
    chest: null,                     // this room's chest: { x, y, w, h, rare, open }
    solidUsed: { fire: false, water: false }, // Solidify: first own pool this attempt done
  };
}

// ── Rooms ──

// Normal rooms come from the campaign: earlier worlds before boss 1, later after.
function pickLevel(run, levels) {
  const early = run.stage < 4;
  const range = early ? [0, 16] : [16, 48];
  const options = [];
  for (let i = range[0]; i < Math.min(range[1], levels.length); i++) if (!run.used.has(i)) options.push(i);
  const i = options.length ? options[Math.floor(run.rand() * options.length)] : range[0];
  run.used.add(i);
  return i;
}

// Where a standing enemy can go without blocking the level: open floor you can jump
// over (3 clear tiles above), away from spawns, doors, switches, boxes and machinery.
function sentrySpots(level) {
  const busy = [];
  const mark = (tx, ty, r = 4) => busy.push({ tx, ty, r });
  const sp = (s) => ({ tx: Math.floor((s.x + 10) / T), ty: Math.floor((s.y + 29) / T) });
  for (const el of ROLES) { const s = sp(level.spawns[el]); mark(s.tx, s.ty, 5); mark(level.exits[el].tx, level.exits[el].ty, 4); }
  for (const o of [...level.plates, ...level.levers, ...level.boxes]) mark(o.tx, o.ty, 3);
  for (const g of level.gates) for (let y = g.ty; y < g.ty + g.th; y++) for (let x = g.tx; x < g.tx + g.tw; x++) mark(x, y, 2);
  for (const p of level.pulleys) for (const s of [p.a, p.b]) for (let i = 0; i < p.tw; i++) mark(s.tx + i, s.ty, 3);
  const solid = (x, y) => P.tileAt(level, x, y) === P.T.SOLID;
  const empty = (x, y) => P.tileAt(level, x, y) === P.T.EMPTY;
  const spots = [];
  for (let y = 2; y < level.height - 1; y++) {
    for (let x = 2; x < level.width - 2; x++) {
      if (!empty(x, y) || !solid(x, y + 1)) continue;
      if (!(solid(x - 1, y + 1) && solid(x + 1, y + 1) && empty(x - 1, y) && empty(x + 1, y))) continue;
      let open = true;
      for (let k = 1; k <= 3; k++) for (let dx = -1; dx <= 1; dx++) if (!empty(x + dx, y - k)) open = false;
      if (!open) continue;
      if (busy.some((b) => Math.abs(b.tx - x) <= b.r && Math.abs(b.ty - y) <= b.r)) continue;
      spots.push({ tx: x, ty: y });
    }
  }
  return spots;
}

// Element Ward and Solidify need a pool of your own element, so a Challenge room with no
// lava or no water gets a 1-tile pool of the missing kind in a dead-end corner beside
// the spawns or the exits, where nobody has to walk (never right beside the other
// player's spawn or exit). Done before enemies are placed, so none sit on it.
function withPools(def) {
  const level = P.parseLevel(def);
  const has = (type) => level.tiles.some((t) => t === type);
  const rows = def.rows.slice();
  const set = (tx, ty, str) => { rows[ty] = rows[ty].slice(0, tx) + str + rows[ty].slice(tx + str.length); };
  let changed = false;
  for (const [el, type, ch] of [['fire', P.T.LAVA, 'L'], ['water', P.T.WATER, '~']]) {
    if (has(type)) continue;
    const corner = poolCorners(P.parseLevel({ ...def, rows }), el)[0];
    if (corner) { set(corner.tx, corner.ty + 1, ch); changed = true; }
    // No dead end anywhere: leave it out rather than put a pool on someone's route.
  }
  return changed ? { ...def, rows } : def;
}

// Dead-end floor beside the spawns or the exits: the tiles between the outermost of a
// pair and the wall, where nobody has to walk. Own spawn's side first, then the exits.
function poolCorners(level, el) {
  const solid = (x, y) => P.tileAt(level, x, y) === P.T.SOLID;
  const empty = (x, y) => P.tileAt(level, x, y) === P.T.EMPTY;
  const ground = (x, y) => [P.T.SOLID, P.T.LAVA, P.T.WATER, P.T.ACID].includes(P.tileAt(level, x, y));
  const floor = (x, y) => empty(x, y) && ground(x, y + 1); // can walk here (pools count)
  const wall = (x, y) => solid(x, y) && solid(x, y - 1);
  const sp = (s) => ({ tx: Math.floor((s.x + 10) / T), ty: Math.floor((s.y + 29) / T) });
  const other = el === 'fire' ? 'water' : 'fire';
  const things = [...ROLES.map((r) => sp(level.spawns[r])), ...ROLES.map((r) => level.exits[r]),
    ...level.plates, ...level.levers, ...level.boxes];
  const out = [];
  for (const g of [[sp(level.spawns[el]), sp(level.spawns[other])], [level.exits[el], level.exits[other]]]) {
    for (const a of g) {
      for (const dir of [-1, 1]) {
        const tiles = [];
        let x = a.tx + dir;
        for (; Math.abs(x - a.tx) <= 8 && floor(x, a.ty); x += dir) tiles.push(x);
        if (!wall(x, a.ty) || !tiles.length) continue; // not a dead end
        const beyond = (t) => g.some((m) => m.ty === a.ty && Math.sign(m.tx - t) === dir);
        // not right next to where the other player spawns or finishes: one wrong tap
        const theirs = [sp(level.spawns[other]), level.exits[other]];
        const besideTheirs = (t) => theirs.some((m) => m.ty === a.ty && Math.abs(m.tx - t) <= 1);
        for (const t of tiles.reverse()) { // nearest the wall first
          if (solid(t, a.ty + 1) && !beyond(t) && !besideTheirs(t) && !things.some((o) => o.tx === t && o.ty === a.ty)) out.push({ tx: t, ty: a.ty });
        }
      }
    }
  }
  return out;
}

// ── Chests ──

const hasChests = (run) => STAGES[run.stage] === 'room' && run.stage !== 0; // rooms 2–4, 6–9

// Tiles to keep clear of: spawns, exits and machinery.
function busyTiles(level) {
  const sp = (s) => ({ tx: Math.floor((s.x + 10) / T), ty: Math.floor((s.y + 29) / T) });
  const out = [];
  for (const el of ROLES) { out.push({ ...sp(level.spawns[el]), r: 3 }, { ...level.exits[el], r: 3 }); }
  for (const o of [...level.plates, ...level.levers, ...level.boxes, ...level.gems]) out.push({ tx: o.tx, ty: o.ty, r: 1 });
  for (const g of level.gates) for (let y = g.ty; y < g.ty + g.th; y++) for (let x = g.tx; x < g.tx + g.tw; x++) out.push({ tx: x, ty: y, r: 1 });
  return out;
}
const nearBusy = (busy, x, y) => busy.some((b) => Math.abs(b.tx - x) <= b.r && Math.abs(b.ty - y) <= b.r);

// A rare chest's own platform: 3 tiles of rock high in open air, with 2 clear tiles all
// round and 3 above, away from pulley shafts. Picked from the highest rows that have
// room. Returns { def, chest } or null.
function chestPlatform(run, def) {
  const level = P.parseLevel(def);
  const empty = (x, y) => P.tileAt(level, x, y) === P.T.EMPTY;
  const shafts = new Set();
  for (const p of level.pulleys) for (const s of [p.a, p.b]) for (let i = -1; i <= p.tw; i++) shafts.add(s.tx + i);
  const busy = busyTiles(level);
  const spots = [];
  for (let y = 4; y <= Math.floor(level.height / 2); y++) {
    for (let x = 3; x + 5 < level.width - 1; x++) {
      let ok = true;
      for (let yy = y - 3; yy <= y + 2 && ok; yy++) for (let xx = x - 2; xx <= x + 4 && ok; xx++) {
        if (!empty(xx, yy) || shafts.has(xx) || nearBusy(busy, xx, yy)) ok = false;
      }
      if (ok) spots.push({ x, y });
    }
  }
  if (!spots.length) return null;
  const top = Math.min(...spots.map((s) => s.y));
  const high = spots.filter((s) => s.y <= top + 2);
  const at = high[Math.floor(run.rand() * high.length)];
  const rows = def.rows.slice();
  rows[at.y] = rows[at.y].slice(0, at.x) + '###' + rows[at.y].slice(at.x + 3);
  return { def: { ...def, rows }, chest: chestAt(at.x + 1, at.y - 1, true) };
}

// Floor for an ordinary chest: an empty tile with headroom and rock under it, away from
// spawns, exits, machinery, stars and enemies.
function chestFloor(run, level, enemies) {
  const empty = (x, y) => P.tileAt(level, x, y) === P.T.EMPTY;
  const busy = busyTiles(level);
  const spots = [];
  for (let y = 2; y < level.height - 1; y++) for (let x = 1; x < level.width - 1; x++) {
    if (!empty(x, y) || !empty(x, y - 1) || !P.isSolid(level, x, y + 1) || nearBusy(busy, x, y)) continue;
    const r = { x: (x - 2) * T, y: (y - 2) * T, w: 5 * T, h: 4 * T };
    if (enemies.some((e) => e.x !== undefined && e.y !== undefined && overlaps(r, { x: e.x ?? e.x0, y: e.y, w: e.w || T, h: e.h || T }))) continue;
    spots.push({ x, y });
  }
  if (!spots.length) return null;
  const at = spots[Math.floor(run.rand() * spots.length)];
  return at;
}

const chestAt = (tx, ty, rare) => ({ x: tx * T + (T - CHEST.w) / 2, y: (ty + 1) * T - CHEST.h, w: CHEST.w, h: CHEST.h, rare, open: false });

function enemySpecs(run, kind, level, def = {}) {
  if (kind === 'boss1') {
    // each arena says where the twins fly and walk (tiles); defaults: the original arena
    const b = def.boss || { flyer: { x0: 4, x1: 36, y: 9.5, amp: 3 }, walker: { x0: 6, x1: 33, x: 6 } };
    return [
      { type: 'flyer', x0: b.flyer.x0 * T, x1: b.flyer.x1 * T, y: b.flyer.y * T, amp: b.flyer.amp * T, speed: 95, w: 34, h: 24 },
      { type: 'walker', x0: b.walker.x0 * T, x1: b.walker.x1 * T, x: b.walker.x * T, floor: 21 * T, speed: 70, size0: 22, size1: 72, grow: 60 },
    ];
  }
  if (kind === 'boss2') {
    return [{ type: 'shooter', x: 19.5 * T - 14, y: 1.2 * T, w: 28, h: 22 }, { type: 'acid' }];
  }
  // Room 1 is an exact campaign level, untouched, so it's winnable with no bonuses at all.
  if (run.stage === 0) return [];
  const count = run.stage < 4 ? 1 + Math.floor(run.rand() * 2) : 2 + Math.floor(run.rand() * 2);
  const spots = sentrySpots(level);
  // Room 2 has sentries or mimics; rooms 3–4 sentries, patrolling walkers or mimics;
  // rooms 6–9 one of sentries, walkers, burrowers, mimics or chargers. Never a mix.
  const types = run.stage < 2 ? ['sentry', 'mimic'] : run.stage < 4 ? ['sentry', 'patrol', 'mimic'] : ['sentry', 'patrol', 'burrower', 'mimic', 'charger'];
  const type = types[Math.floor(run.rand() * types.length)];
  let specs = [];
  if (type === 'patrol') specs = patrolSpecs(run, spots, count);
  else if (type === 'burrower') specs = [{ type: 'burrower', w: 30, h: 26 }];
  else if (type === 'mimic') specs = sentrySpecs(run, spots, count).map((e) => ({ type: 'mimic', x: e.x - 3, y: e.y - 6, w: T, h: T }));
  else if (type === 'charger') specs = chargerSpecs(run, spots, Math.max(1, count - 1));
  if (!specs.length) specs = sentrySpecs(run, spots, count); // no room for the chosen kind
  // Rooms 6–9: a bomber flies along the top and drops bombs on whoever it passes over.
  if (run.stage >= 5) {
    const lane = bomberLane(level);
    if (lane) specs.push({ type: 'bomber', ...lane, w: BOMBER.w, h: BOMBER.h, speed: BOMBER.speed, x: run.rand() < 0.5 ? lane.x0 : lane.x1 });
  }
  return specs;
}

// The bomber flies along the highest row with an open stretch of at least 6 tiles
// (nothing solid in that row), patrolling the longest such stretch in that row. Where
// walls divide the top of a room (e.g. Leapfrog) it covers just one section. Only in
// the top half of the room, so it never ends up at head height.
const BOMBER_MIN_RUN = 6;
function bomberLane(level) {
  for (let ty = 1; ty <= Math.floor(level.height / 2); ty++) {
    let best = null, start = null;
    for (let tx = 1; tx <= level.width - 1; tx++) {
      const open = tx < level.width - 1 && !P.isSolid(level, tx, ty);
      if (open && start === null) start = tx;
      if (!open && start !== null) {
        if (!best || tx - start > best.len) best = { tx0: start, len: tx - start };
        start = null;
      }
    }
    if (best && best.len >= BOMBER_MIN_RUN) {
      return { x0: best.tx0 * T, x1: (best.tx0 + best.len) * T - BOMBER.w, y: ty * T + (T - BOMBER.h) / 2 };
    }
  }
  return null;
}

function sentrySpecs(run, spots, count) {
  const chosen = [];
  for (const s of pickN(run.rand, spots, spots.length)) {
    if (chosen.length >= count) break;
    if (chosen.some((c) => Math.abs(c.tx - s.tx) < 5 && c.ty === s.ty)) continue;
    chosen.push(s);
  }
  return chosen.map((s) => ({ type: 'sentry', x: s.tx * T + 3, y: (s.ty + 1) * T - 18, w: 18, h: 18 }));
}

// Chargers wait on wide platforms: runs of safe floor at least CHARGER.minRun tiles.
function chargerSpecs(run, spots, count) {
  return floorRuns(spots, CHARGER.minRun).length
    ? pickN(run.rand, floorRuns(spots, CHARGER.minRun), count).map((r) => {
      const x = (r.tx0 + Math.floor((r.tx1 - r.tx0) / 2)) * T + 1;
      return { type: 'charger', x, y: (r.ty + 1) * T - CHARGER.size, w: CHARGER.size, h: CHARGER.size };
    })
    : [];
}

function floorRuns(spots, min) {
  const key = new Set(spots.map((s) => `${s.tx},${s.ty}`));
  const runs = [];
  for (const s of spots) {
    if (key.has(`${s.tx - 1},${s.ty}`)) continue;
    let end = s.tx;
    while (key.has(`${end + 1},${s.ty}`)) end++;
    if (end - s.tx + 1 >= min) runs.push({ ty: s.ty, tx0: s.tx, tx1: end });
  }
  return runs;
}

// Walkers pace along runs of safe floor (the same safe cells sentries use), at least
// PATROL.minRun tiles long, one walker per run.
function patrolSpecs(run, spots, count) {
  const key = new Set(spots.map((s) => `${s.tx},${s.ty}`));
  const runs = [];
  for (const s of spots) {
    if (key.has(`${s.tx - 1},${s.ty}`)) continue; // not the start of a run
    let end = s.tx;
    while (key.has(`${end + 1},${s.ty}`)) end++;
    if (end - s.tx + 1 >= PATROL.minRun) runs.push({ ty: s.ty, tx0: s.tx, tx1: end });
  }
  return pickN(run.rand, runs, count).map((r) => {
    const x0 = r.tx0 * T, x1 = (r.tx1 + 1) * T - PATROL.size;
    return { type: 'patrol', x0, x1, x: x0 + run.rand() * (x1 - x0), y: (r.ty + 1) * T - PATROL.size, w: PATROL.size, h: PATROL.size, speed: PATROL.speed };
  });
}

// ── Weather ──

// Which weather a room can fairly have, from where each character can stand (the level
// checker's coarse reachability): drought needs a water pool Water can stand in, rain
// needs somewhere covered Fire can stand, and a flood needs somewhere above it for both.
const weatherCache = new Map();
function weatherOptions(def) {
  const key = def.id + '|' + def.rows.join('');
  if (weatherCache.has(key)) return weatherCache.get(key);
  const level = P.parseLevel(def);
  const { reach } = require('../tools/levelcheck').analyse(def);
  const cells = (el) => [...reach[el]].map((k) => k.split(',').map(Number));
  const drought = cells('water').some(([x, y]) => P.tileAt(level, x, y + 1) === P.T.WATER);
  const covered = (x, y) => { for (let yy = 1; yy <= y - 2; yy++) if (P.isSolid(level, x, yy)) return true; return false; };
  const rain = cells('fire').some(([x, y]) => covered(x, y));
  const lowest = Math.max(...cells('fire').concat(cells('water')).map(([, y]) => y));
  const top = lowest + 1 - WEATHER.depth; // flood surface, in tiles
  const flood = ROLES.every((el) => cells(el).some(([, y]) => y + 1 <= top)) ? top * T : null;
  const out = { drought, rain, flood };
  weatherCache.set(key, out);
  return out;
}

// Rolled once per room (rooms 6–10): none, drought, rainstorm or acid flood, equally
// likely; a kind the room can't fairly have counts as none.
function rollWeather(run, def) {
  if (run.stage < 5) return null;
  const kind = ['none', 'drought', 'rain', 'flood'][Math.floor(run.rand() * 4)];
  const seed = Math.floor(run.rand() * 2 ** 31);
  const opts = weatherOptions(def);
  if (kind === 'none' || !opts[kind]) return null;
  return { kind, floodY: opts.flood, rand: rng(seed) };
}

function resetWeather(room) {
  const w = room.weatherDef;
  if (!w) { room.run.weather = null; return; }
  const gap = WEATHER.firstMin + w.rand() * (WEATHER.firstMax - WEATHER.firstMin);
  room.run.weather = { kind: w.kind, floodY: w.floodY, state: 'idle', t: 0, dur: gap, level: room.level.pxHeight };
}

const covered = (room, b) => blockedRects(room, { x: b.x + P.CHAR.width / 2 - 4, y: T, w: 8, h: Math.max(0, b.y - T) }).length > 0;

function updateWeather(room, dt, hits) {
  const run = room.run, w = run.weather;
  if (!w) return;
  const gap = () => WEATHER.gapMin + room.weatherDef.rand() * (WEATHER.gapMax - WEATHER.gapMin);
  if (E.stepWeather(w, dt, room.level.pxHeight, gap) === 'lead') room.events.push({ type: 'weather', kind: w.kind });
  if (w.state !== 'strike') return;
  const umbrella = teamCount(run, 'umbrella') > 0; // rain and drought can't hurt you
  for (const r of ROLES) {
    const b = room.players[r].body;
    if (umbrella && w.kind !== 'flood') continue;
    if (w.kind === 'drought' && r === 'water' && !onOwnPool(room.level, b, 'water')) hits.push({ role: r, cause: 'drought' });
    if (w.kind === 'rain' && r === 'fire' && !covered(room, b)) hits.push({ role: r, cause: 'rain' });
    if (w.kind === 'flood' && !b.acidImmune && b.y + P.CHAR.height > w.level + 2) hits.push({ role: r, cause: 'flood' });
  }
}

// ── Enemies ──

function resetEnemies(room) {
  const run = room.run;
  run.time = 0;
  run.shots = [];
  run.bullets = [];
  run.acid = null;
  run.enemies = room.enemySpecs.filter((e) => e.type !== 'acid').map((e, i) => ({ ...e, id: i, stunT: 0, dead: false, dir: 1, x: e.x ?? e.x0, size: e.size0, yNow: e.y }));
  run.shotId = 0;
  room.state.blocks = [];
  for (const e of run.enemies) {
    if (e.type === 'mimic') { e.block = { x: e.x, y: e.y, w: e.w, h: e.h }; room.state.blocks.push(e.block); e.shakeT = run.rand() * MIMIC.shakeEvery; }
    if (e.type === 'burrower') { e.phase = 'hidden'; e.t = BURROW.hideMin * 0.6; e.x = 0; e.y = 0; }
    if (e.type === 'charger') {
      Object.assign(e, { mode: 'ready', homeX: e.x, vx: 0, vy: 0, onGround: false, coyoteT: 0, bufferT: 0, w: CHARGER.size, h: CHARGER.size });
    }
  }
  if (room.enemySpecs.some((e) => e.type === 'acid')) run.acid = { next: ACID.firstAt, countdown: 0, burning: 0 };
  resetWeather(room);
}

const shrink = (r, by) => ({ x: r.x + by, y: r.y + by, w: r.w - 2 * by, h: r.h - 2 * by });
const overlaps = (a, b) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
const charRect = (b) => ({ x: b.x, y: b.y, w: P.CHAR.width, h: P.CHAR.height });

const { enemyRect, liveRect } = E;

// Advance enemies one tick. Returns the roles hit this tick: [{ role, cause }].
function updateEnemies(room, dt) {
  const run = room.run;
  const playerDt = dt;
  // Slow Time: enemies (and their shots and timers) run 25% slower per copy.
  dt *= Math.pow(0.75, teamCount(run, 'slowtime'));
  run.time += dt;
  lastChanceTick(room, playerDt);
  for (const r of ROLES) {
    run.invuln[r] = Math.max(0, run.invuln[r] - playerDt);
    run.effects[r].cloakT = Math.max(0, run.effects[r].cloakT - playerDt);
    run.effects[r].shieldT = Math.max(0, run.effects[r].shieldT - playerDt);
  }
  for (const it of allItems(run)) if (it.coolT > 0) it.coolT = Math.max(0, it.coolT - playerDt);
  const cloaked = (r) => run.effects[r].cloakT > 0;
  // Element Ward: stepping into your own element shields you for 1 s per copy.
  for (const r of ROLES) {
    const inside = onOwnPool(room.level, room.players[r].body, r);
    const wards = run.personal[r].filter((i) => i.id === 'ward').length;
    if (inside && !run.inElement[r] && wards) {
      run.effects[r].shieldT = Math.max(run.effects[r].shieldT, wards);
      room.events.push({ type: 'ward', role: r, seconds: wards });
    }
    run.inElement[r] = inside;
    // Solidify: the first pool of your own element you step into each attempt hardens
    if (inside && !run.solidUsed[r] && run.personal[r].some((i) => i.id === 'solidify')) {
      run.solidUsed[r] = true;
      harden(room, room.players[r].body, r);
      room.events.push({ type: 'solidify', role: r });
    }
    // Chest: either of you touching it opens it
    const c = run.chest;
    if (c && !c.open && overlaps(charRect(room.players[r].body), c)) {
      c.open = true;
      room.events.push({ type: 'chest', role: r, rare: c.rare });
    }
  }
  for (const e of run.enemies) {
    if (e.dead) continue;
    // fixed-rule movement (shared with the client's prediction); false while stunned
    if (!E.move(e, dt, run.time, room.level, room.state)) continue;
    if (e.type === 'bomber') {
      const cx = e.x + e.w / 2;
      const below = ROLES.filter((r) => !cloaked(r)).some((r) => {
        const b = room.players[r].body;
        return Math.abs(b.x + P.CHAR.width / 2 - cx) < 12 && b.y > e.y;
      });
      if (below && e.cool === 0) {
        e.cool = BOMBER.cooldown;
        run.shots.push({ id: ++run.shotId, x: cx - BOMBER.size / 2, y: e.y + e.h, vx: 0, vy: 40, g: BOMBER.gravity, kind: 'bomb' });
      }
    } else if (e.type === 'burrower') {
      e.t -= dt;
      if (e.phase === 'hidden' && e.t <= 0) {
        // surface under a visible player who's standing on something
        const targets = ROLES.filter((r) => !cloaked(r) && onRealGround(room, room.players[r].body));
        if (!targets.length) { e.t = 0.5; continue; }
        const b = room.players[targets[Math.floor(run.rand() * targets.length)]].body;
        e.x = b.x + P.CHAR.width / 2 - e.w / 2;
        e.y = b.y + P.CHAR.height - e.h;
        e.phase = 'warning'; e.t = BURROW.warn;
      } else if (e.phase === 'warning' && e.t <= 0) {
        e.phase = 'out'; e.t = BURROW.out;
        room.events.push({ type: 'burrow' });
      } else if (e.phase === 'out' && e.t <= 0) {
        e.phase = 'hidden'; e.t = BURROW.hideMin + run.rand() * (BURROW.hideMax - BURROW.hideMin);
      }
    } else if (e.type === 'charger') {
      stepCharger(room, e, dt, cloaked);
    } else if (e.type === 'shooter') {
      e.cool = (e.cool ?? SHOOTER.period) - dt;
      if (e.cool <= 0) {
        e.cool = SHOOTER.period;
        const cx = e.x + e.w / 2, cy = e.y + e.h;
        // aims at the nearest player it can see (Cloak hides you)
        const targets = ROLES.filter((r) => !cloaked(r)).map((r) => room.players[r].body)
          .map((b) => ({ b, d: Math.hypot(b.x + 10 - cx, b.y + 15 - cy) })).sort((a, b) => a.d - b.d);
        if (targets.length) {
          const t = targets[0].b;
          const dx = t.x + 10 - cx, dy = t.y + 15 - cy, d = Math.hypot(dx, dy) || 1;
          run.shots.push({ id: ++run.shotId, x: cx - SHOOTER.size / 2, y: cy, vx: (dx / d) * SHOOTER.speed, vy: (dy / d) * SHOOTER.speed });
        }
      }
    }
  }
  // Enemy shots and bombs fly, and stop at anything solid (shared with the client).
  run.shots = E.stepShots(run.shots, dt, room.level, room.state);
  // Blaster shots: short range, destroy sentries, stun bosses.
  run.bullets = E.stepBullets(run.bullets, playerDt, room.level, room.state).filter((b) => {
    const br = { x: b.x, y: b.y, w: GUN.size, h: GUN.size };
    for (const e of run.enemies) {
      if (e.dead || !overlaps(br, liveRect(e))) continue;
      if (e.type === 'burrower' && e.phase !== 'out') continue;
      if (killable(e)) kill(room, e); else e.stunT = Math.max(e.stunT, 1.5);
      return false;
    }
    return true;
  });
  // Acid floor: 3-2-1, then a moment when touching any ground kills.
  const hits = [];
  const a = run.acid;
  if (a) {
    const started = E.stepAcid(a, dt); // shared with the client
    if (started) room.events.push({ type: started });
    if (a.burning > 0) {
      for (const r of ROLES) {
        const p = room.players[r];
        if (p.body.onGround && !p.body.acidImmune) hits.push({ role: r, cause: 'acid floor' });
      }
    }
  }
  updateWeather(room, playerDt, hits);
  stomps(room);
  // Touching an enemy (not while cloaked) or an enemy shot.
  for (const r of ROLES) {
    const cr = shrink(charRect(room.players[r].body), 2);
    if (!cloaked(r) && !(run.ghost[r] > 0)) {
      const p = room.players[r];
      for (const e of run.enemies) {
        if (e.dead || e.stunT > 0) continue;
        if (e.type === 'burrower') {
          if (e.phase !== 'out') continue;
          const c = { x: e.x + e.w / 2, y: e.y + e.h };
          const me = { x: p.body.x + P.CHAR.width / 2, y: p.body.y + P.CHAR.height / 2 };
          if (Math.hypot(me.x - c.x, me.y - c.y) < BURROW.radius + 12) { hits.push({ role: r, cause: 'burrower' }); break; }
          continue;
        }
        if (e.type === 'mimic') {
          if (teamCount(run, 'keeneye')) continue; // Keen Eye: decoys can't hurt you
          // walking into its side ("pushing" it) gets you stabbed; standing on it is fine
          const b = p.body, er = liveRect(e);
          const level = b.y + P.CHAR.height > er.y + 2 && b.y < er.y + er.h;
          const pushRight = p.input.right && Math.abs(b.x + P.CHAR.width - er.x) < 1.5;
          const pushLeft = p.input.left && Math.abs(b.x - (er.x + er.w)) < 1.5;
          if (level && (pushRight || pushLeft)) { hits.push({ role: r, cause: e.chest ? 'fakechest' : 'mimic' }); break; }
          continue;
        }
        if (overlaps(cr, shrink(liveRect(e), 2))) { hits.push({ role: r, cause: e.type }); break; }
      }
    }
    const umbrella = teamCount(run, 'umbrella') > 0; // bombs bounce off umbrellas
    for (const sh of run.shots) if (!(umbrella && sh.kind === 'bomb') && overlaps(cr, { x: sh.x, y: sh.y, w: SHOOTER.size, h: SHOOTER.size })) { hits.push({ role: r, cause: sh.kind === 'bomb' ? 'bomb' : 'shot' }); break; }
  }
  return hits;
}

// Standing on the level's own ground (rock or a pool), not on a box, mimic or platform.
function onRealGround(room, b) {
  if (!b.onGround) return false;
  const feet = b.y + P.CHAR.height;
  if (Math.abs(feet - Math.round(feet / T) * T) > 0.5) return false; // platforms sit off the grid
  const ty = Math.round(feet / T);
  const under = { x: b.x, y: feet, w: P.CHAR.width, h: 2 };
  if (room.state.boxes.concat(room.state.blocks || []).some((o) => overlaps(under, o))) return false;
  if (P.platformRects(room.level, room.state).some((o) => overlaps(under, o))) return false;
  const tx0 = Math.floor((b.x + 4) / T), tx1 = Math.floor((b.x + P.CHAR.width - 4) / T);
  for (let tx = tx0; tx <= tx1; tx++) if (P.isSolid(room.level, tx, ty)) return true;
  return false;
}

const blockedRects = (room, r) => E.blockedRects(room.level, room.state, r);

// Standing on a pool of your own element (lava for fire, water for water)?
function onOwnPool(level, body, role) {
  if (!body.onGround) return false;
  const own = role === 'fire' ? P.T.LAVA : P.T.WATER;
  const ty = Math.round((body.y + P.CHAR.height) / T);
  const tx0 = Math.floor((body.x + 4) / T), tx1 = Math.floor((body.x + P.CHAR.width - 4) / T);
  for (let tx = tx0; tx <= tx1; tx++) if (P.tileAt(level, tx, ty) === own) return true;
  return false;
}

// The charger: waits, charges in a straight line at a player who comes level and near,
// gets tired, then walks slowly home; if it can't get home it waits where it got to.
function stepCharger(room, e, dt, cloaked) {
  const run = room.run;
  const input = { left: false, right: false };
  if (e.mode === 'ready') {
    for (const r of ROLES) {
      if (cloaked(r)) continue;
      const b = room.players[r].body;
      const dx = b.x + P.CHAR.width / 2 - (e.x + e.w / 2);
      const dy = b.y + P.CHAR.height - (e.y + e.h);
      if (Math.abs(dx) < CHARGER.sight && Math.abs(dy) < CHARGER.height) {
        e.mode = 'charging'; e.dir = Math.sign(dx) || 1; e.run0 = e.x; e.blockedT = 0;
        room.events.push({ type: 'charge' });
        break;
      }
    }
  }
  if (e.mode === 'charging') {
    e.speedMul = CHARGER.charge;
    input[e.dir > 0 ? 'right' : 'left'] = true;
  } else if (e.mode === 'tired') {
    e.t -= dt;
    if (e.t <= 0) { e.mode = 'returning'; e.bestD = Math.abs(e.x - e.homeX); e.stuckT = 0; }
  } else if (e.mode === 'returning') {
    e.speedMul = CHARGER.back;
    const d = e.homeX - e.x;
    if (Math.abs(d) < 2) { e.mode = 'ready'; e.vx = 0; }
    else input[d > 0 ? 'right' : 'left'] = true;
  }
  const x0 = e.x;
  P.stepBody(room.level, e, input, [], dt, room.state);
  if (e.mode === 'charging') {
    const blocked = Math.abs(e.x - x0) < 0.2 && Math.abs(e.vx) < 1;
    e.blockedT = blocked ? e.blockedT + dt : 0;
    if (e.blockedT > 0.1 || Math.abs(e.x - e.run0) >= CHARGER.maxRun) { e.mode = 'tired'; e.t = CHARGER.tired; e.vx = 0; }
  } else if (e.mode === 'returning') {
    const d = Math.abs(e.x - e.homeX);
    if (d < e.bestD - 0.5) { e.bestD = d; e.stuckT = 0; } else e.stuckT += dt;
    if (e.stuckT > 1) { e.mode = 'ready'; e.homeX = e.x; e.vx = 0; } // as close as it can get
  } else if (e.mode === 'ready') e.vx = 0;
  void run;
}

// Stomp: land on an enemy from above to destroy it (bigger ones are stunned) and bounce.
function stomps(room) {
  const run = room.run;
  for (const r of ROLES) {
    const b = room.players[r].body;
    const feet = b.y + P.CHAR.height;
    const prev = run.prevFeet[r] ?? feet;
    run.prevFeet[r] = feet;
    if (!run.personal[r].some((i) => i.id === 'stomp') || feet < prev - 0.01) continue; // only coming down
    for (const e of run.enemies) {
      if (e.dead || (e.type === 'burrower' && e.phase !== 'out')) continue;
      const er = liveRect(e);
      const across = b.x < er.x + er.w && b.x + P.CHAR.width > er.x;
      if (!across || prev > er.y + 6 || feet < er.y - 2) continue;
      if (killable(e)) kill(room, e); else e.stunT = Math.max(e.stunT, 2.5);
      b.vy = -P.CHAR.jumpVel * 0.7;
      b.onGround = false;
      room.events.push({ type: 'stomp', role: r });
      break;
    }
  }
}

const teamCount = (run, id) => run.items.filter((i) => i.id === id).length;

// Last Chance: count down; back at your start in time → the room restarts, no heart lost.
function lastChanceTick(room, dt) {
  const run = room.run;
  for (const r of ROLES) {
    if (!(run.ghost[r] > 0)) continue;
    const b = room.players[r].body, s = room.level.spawns[r];
    if (Math.hypot(b.x - s.x, b.y - s.y) < T) {
      run.ghost[r] = 0;
      b.phase = false;
      room.events.push({ type: 'lastchance-saved', role: r });
      room.resetRequested = true;
      return;
    }
    run.ghost[r] -= dt;
    if (run.ghost[r] <= 0) {
      run.ghost[r] = 0;
      b.phase = false;
      run.ghostFailed = r; // game.js turns this into a death
    }
  }
}


// Something would kill `role`. Returns true if they're saved: already safe (shielded,
// or Last Chance's intangibility), Guardian (each player's first hit in a room: 1s
// shielded where they are), then Last Chance.
function absorb(room, role) {
  const run = room.run;
  if (run.invuln[role] > 0 || run.effects[role].shieldT > 0 || run.ghost[role] > 0) return true;
  if (!run.guardUsed[role] && run.items.some((i) => i.id === 'guardian')) {
    run.guardUsed[role] = true;
    run.effects[role].shieldT = Math.max(run.effects[role].shieldT, GUARDIAN_SECONDS);
    room.events.push({ type: 'guardian', role });
    return true;
  }
  if (!run.lastChanceUsed && teamCount(run, 'lastchance')) {
    run.lastChanceUsed = true;
    run.ghost[role] = LAST_CHANCE_SECONDS;
    room.players[role].body.phase = true; // intangible
    room.events.push({ type: 'lastchance', role });
    return true;
  }
  return false;
}

function toStart(room, role) {
  const s = room.level.spawns[role];
  Object.assign(room.players[role].body, { x: s.x, y: s.y, vx: 0, vy: 0, flyT: 0 });
}

// ── Items ──

const killable = (e) => ['sentry', 'patrol', 'mimic', 'burrower'].includes(e.type);
function kill(room, e) {
  const run = room.run;
  e.dead = true;
  if (e.block) room.state.blocks = room.state.blocks.filter((b) => b !== e.block);
  if (teamCount(run, 'lifesteal') && run.rand() < LIFESTEAL) heal(room, 1, 'lifesteal');
}

function heal(room, n, source) {
  const run = room.run;
  const before = run.hearts;
  run.hearts = Math.min(run.maxHearts, run.hearts + n);
  if (run.hearts > before) room.events.push({ type: 'heal', source, hearts: run.hearts - before });
}

const allItems = (run) => run.items.concat(run.personal.fire, run.personal.water);
const ownedIds = (run, role) => run.personal[role].map((i) => i.id);

function bodyMods(run, role) {
  return { ...B.mods(ownedIds(run, role)), flyT: 0, dashT: 0, airJumps: 0, phase: false };
}

// Called at the start of every attempt (room load, restart, after a death).
function onAttempt(room) {
  const run = room.run;
  run.started = false; // enemies and the clock wait until someone moves (see game.js)
  run.guardUsed = { fire: false, water: false };
  run.invuln = { fire: 0, water: 0 };
  run.effects = { fire: { cloakT: 0, shieldT: 0 }, water: { cloakT: 0, shieldT: 0 } };
  run.inElement = { fire: false, water: false };
  run.ghost = { fire: 0, water: 0 };
  run.ghostFailed = null;
  run.lastChanceUsed = false;
  run.prevFeet = {};
  run.solidUsed = { fire: false, water: false };
  if (run.chest) run.chest.open = false; // like stars: open it again after a restart
  room.resetRequested = false;
  for (const it of allItems(run)) { if (!it.spent) it.ready = true; it.coolT = 0; } // once-per-room items recharge
  for (const r of ROLES) Object.assign(room.players[r].body, bodyMods(run, r));
  resetEnemies(room);
}

function stageKind(run) { return STAGES[run.stage]; }

// Load the room for the current stage (or a different one, for Reroll).
function loadStage(room, load) {
  const run = room.run;
  const kind = stageKind(run);
  let def, label;
  if (kind === 'room') {
    const i = pickLevel(run, room.levels);
    def = room.levels[i];
    label = `Room ${run.stage + 1}/${STAGES.length}`;
  } else {
    const arenas = BOSS_DEFS[kind];
    def = arenas[Math.floor(run.rand() * arenas.length)];
    label = `Boss ${kind === 'boss1' ? 1 : 2}`;
  }
  if (run.stage > 0) def = withPools(def); // room 1 stays an exact copy
  run.chest = null;
  let chest = null; // 'common' | 'rare' | a placed rare chest
  if (hasChests(run) && run.rand() < CHEST.chance) {
    chest = run.rand() < CHEST.rare ? 'rare' : 'common';
    if (chest === 'rare' && run.rand() < CHEST.rarePlatform) {
      const placed = chestPlatform(run, def);
      if (placed) { def = placed.def; chest = placed.chest; }
    }
  }
  room.enemySpecs = [];
  load(def, { index: run.stage, total: STAGES.length, label });
  room.enemySpecs = enemySpecs(run, kind, room.level, def);
  if (typeof chest === 'string') {
    const at = chestFloor(run, room.level, room.enemySpecs);
    if (at) run.chest = chestAt(at.x, at.y, chest === 'rare');
  } else run.chest = chest;
  if (hasChests(run) && run.rand() < FAKE_CHEST.chance) {
    const rare = run.rand() < CHEST.rare; // looks rare as often as a real one is
    const at = chestFloor(run, room.level, room.enemySpecs.concat(run.chest ? [run.chest] : []));
    if (at) room.enemySpecs.push({ type: 'mimic', chest: true, rare, ...chestAt(at.x, at.y, rare), open: undefined });
  }
  room.weatherDef = rollWeather(run, def);
  onAttempt(room);
}

function start(room, load) {
  room.run.stage = 0;
  loadStage(room, load);
}

// Offer `n` bonuses from one scope. After a normal room each offer is common, or
// uncommon with a chance equal to the share of stars collected (falls back to common
// if there's nothing uncommon left). After a boss, everything is rare.
function offer(run, scope, n, exclude, uncommonChance, boss) {
  return offerFrom(run, scope, n, exclude, () => (boss ? ['rare'] : run.rand() < uncommonChance ? ['uncommon', 'common'] : ['common']));
}

// Team bonuses come in a fixed tier (chest common, rare chest uncommon, boss rare),
// dropping a tier when there's nothing left to offer in it.
const TEAM_TIERS = { common: ['common'], uncommon: ['uncommon', 'common'], rare: ['rare', 'uncommon', 'common'] };
function offerTeam(run, n, exclude, tier) {
  return offerFrom(run, 'team', n, exclude, () => TEAM_TIERS[tier]);
}

function offerFrom(run, scope, n, exclude, tiersFor) {
  const avail = (rarity) => B.pool(scope, rarity).filter((b) => !exclude.has(b.id));
  const out = [];
  for (let k = 0; k < n; k++) {
    const tiers = tiersFor();
    for (const tier of tiers) {
      const left = avail(tier).filter((b) => !out.includes(b.id));
      if (left.length) { out.push(left[Math.floor(run.rand() * left.length)].id); break; }
    }
  }
  return out;
}

// The room was cleared: open the map (bonus choices), or the run is won.
function onComplete(room) {
  const run = room.run;
  if (run.stage === STAGES.length - 1) {
    run.result = 'victory';
    room.phase = 'over';
    room.events.push({ type: 'run-over', result: 'victory' });
    return;
  }
  const boss = stageKind(run) !== 'room';
  if (teamCount(run, 'rest')) heal(room, 1, 'rest');
  // Team bonuses only from a boss or an opened chest.
  const teamFrom = boss ? 'boss' : run.chest && run.chest.open ? (run.chest.rare ? 'rarechest' : 'chest') : null;
  const teamTier = { boss: 'rare', rarechest: 'uncommon', chest: 'common' }[teamFrom];
  const total = room.level.gems.length;
  const stars = room.state.gems.filter(Boolean).length;
  const chance = total ? Math.min(1, stars / total) : 0;
  // team: no duplicates of team items you already hold (healing can repeat)
  const teamOwned = new Set(run.items.map((i) => i.id));
  const personal = {};
  // each player's offer is drawn independently: both can be offered the same thing
  // repeatable items (Spring, Swift, Magnet) stay on offer after you have them
  const notRepeat = (ids) => new Set(ids.filter((id) => !B.BY_ID[id].repeat));
  // a player locked into an exclusive item (Phase) can't use other actives or a second
  // slot: don't offer them actives or Dual Wield
  const useless = B.LIST.filter((b) => b.scope === 'personal' && b.color === 'yellow').map((b) => b.id).concat('dualwield');
  for (const r of ROLES) {
    const exclude = notRepeat(ownedIds(run, r));
    if (exclusiveOf(run, r)) for (const id of useless) exclude.add(id);
    personal[r] = offer(run, 'personal', 2, exclude, chance, boss);
  }
  run.map = {
    rarity: boss ? 'rare' : 'common',
    uncommonChance: boss ? 0 : chance,
    step: 'shared',
    teamFrom,
    shared: { options: teamTier ? offerTeam(run, 2, teamOwned, teamTier) : [], votes: {} },
    rps: null,
    personal: { options: personal, picks: {} },
  };
  room.phase = 'map';
  autoAct(room);
}

function grant(room, id, role) {
  const run = room.run;
  const b = B.BY_ID[id];
  if (!b) return;
  if (id === 'heal2') run.hearts = Math.min(run.maxHearts, run.hearts + 2);
  else if (id === 'fullheal') { run.maxHearts += 1; run.hearts = run.maxHearts; }
  else {
    const it = { uid: run.nextUid++, id, ready: true, spent: false, coolT: 0 };
    if (b.scope === 'personal') run.personal[role].push(it); else run.items.push(it);
    // Equip a new active item straight away for whoever has nothing equipped.
    if (b.exclusive) { run.equip[role] = it.uid; run.equip2[role] = null; } // replaces their other actives
    else if (b.color === 'yellow') {
      const who = b.scope === 'personal' ? [role] : role ? [role, ...ROLES] : ROLES;
      for (const r of who) {
        if (exclusiveOf(run, r)) continue;
        if (!run.equip[r]) { run.equip[r] = it.uid; break; }
        if (hasSecondSlot(run, r) && !run.equip2[r]) { run.equip2[r] = it.uid; break; }
      }
    }
    if (b.scope === 'personal') Object.assign(room.players[role].body, B.mods(ownedIds(run, role)));
  }
  room.events.push({ type: 'bonus', id, role: role || null });
}

const controllerOf = (room, role) => room.players[role].socketId;

// Fill in choices for players who aren't there, and for one device playing both.
function autoAct(room) {
  const m = room.run.map;
  if (!m) return;
  const [a, b] = ROLES;
  const sa = controllerOf(room, a), sb = controllerOf(room, b);
  const solo = !sa || !sb || sa === sb;
  if (m.step === 'shared' && solo) {
    const v = m.shared.votes[a] ?? m.shared.votes[b];
    if (v !== undefined) { m.shared.votes[a] = v; m.shared.votes[b] = v; }
  }
  if (m.step === 'shared' && !m.shared.options.length) { m.step = 'personal'; }
  if (m.step === 'personal') {
    for (const r of ROLES) if (!controllerOf(room, r) && !m.personal.picks[r]) m.personal.picks[r] = m.personal.options[r][0] || 'none';
  }
  advance(room);
}

function advance(room) {
  const run = room.run;
  const m = run.map;
  if (m.step === 'shared') {
    const v = m.shared.votes;
    if (v.fire === undefined || v.water === undefined) return;
    if (v.fire === v.water) { grant(room, v.fire, null); m.step = 'personal'; }
    else { m.step = 'rps'; m.rps = { picks: {}, round: 1, last: null }; }
  }
  if (m.step === 'personal') {
    const p = m.personal.picks;
    if (!p.fire || !p.water) return;
    for (const r of ROLES) if (p[r] !== 'none') grant(room, p[r], r);
    run.map = null;
    run.stage++;
    room.phase = 'playing';
    room.loadStage();
  }
}

const BEATS = { rock: 'scissors', paper: 'rock', scissors: 'paper' };

// Messages from players while on the map. Returns false if not allowed.
function act(room, role, msg) {
  const run = room.run;
  const m = run.map;
  if (room.phase !== 'map' || !m || !ROLES.includes(role) || !msg) return false;
  if (msg.type === 'vote' && m.step === 'shared' && m.shared.options.includes(msg.pick)) {
    m.shared.votes[role] = msg.pick;
  } else if (msg.type === 'rps' && m.step === 'rps' && BEATS[msg.hand]) {
    m.rps.picks[role] = msg.hand;
    const { fire, water } = m.rps.picks;
    if (fire && water) {
      m.rps.last = { fire, water };
      if (fire === water) { m.rps.round++; m.rps.picks = {}; }
      else {
        const winner = BEATS[fire] === water ? 'fire' : 'water';
        m.rps.winner = winner;
        grant(room, m.shared.votes[winner], null);
        m.step = 'personal';
      }
    }
  } else if (msg.type === 'pick' && m.step === 'personal' && (m.personal.options[role].includes(msg.pick) || (msg.pick === 'none' && !m.personal.options[role].length))) {
    m.personal.picks[role] = msg.pick;
  } else return false;
  autoAct(room);
  return true;
}

// The item a player may equip: an active team item that isn't used up, or one of
// their own active personal items.
function findEquippable(run, role, uid) {
  const team = run.items.find((i) => i.uid === uid);
  if (team) return B.BY_ID[team.id].color === 'yellow' && !team.spent ? team : null;
  const own = run.personal[role].find((i) => i.uid === uid);
  return own && B.BY_ID[own.id].color === 'yellow' ? own : null;
}

const exclusiveOf = (run, role) => run.personal[role].find((i) => B.BY_ID[i.id].exclusive) || null;
const hasSecondSlot = (run, role) => run.personal[role].some((i) => i.id === 'dualwield') && !exclusiveOf(run, role);
const slotsOf = (run, slot) => (slot === 2 ? run.equip2 : run.equip);

// Equip an active item in slot 1 or 2 (a team item is taken from wherever it was).
// A player with an exclusive item (Phase) can't equip anything else.
function equip(room, role, uid, slot = 1) {
  const run = room.run;
  if (!ROLES.includes(role) || !findEquippable(run, role, uid)) return false;
  if (exclusiveOf(run, role)) return false;
  if (slot === 2 && !hasSecondSlot(run, role)) return false;
  for (const r of ROLES) for (const sl of [run.equip, run.equip2]) if (sl[r] === uid) sl[r] = null;
  slotsOf(run, slot)[role] = uid;
  return true;
}

// A free spot for a new box: the cell in front of you, else the one above you.
function boxSpot(room, body) {
  const facing = body.facing || 1;
  const feet = body.y + P.CHAR.height;
  const ty = Math.round(feet / T) - 1;
  const cx = Math.floor((body.x + P.CHAR.width / 2) / T);
  const free = (tx, ty2) => {
    const r = { x: tx * T, y: ty2 * T, w: T, h: T };
    if (P.isSolid(room.level, tx, ty2)) return false;
    const bodies = ROLES.map((r2) => room.players[r2].body);
    return !bodies.some((b) => overlaps(r, charRect(b))) && !room.state.boxes.some((b) => overlaps(r, b));
  };
  for (const [tx, ty2] of [[cx + facing, ty], [cx + 2 * facing, ty], [cx, ty - 2]]) if (free(tx, ty2)) return { x: tx * T, y: ty2 * T };
  return null;
}

// Solidify: harden the whole connected pool of your element under your feet.
function harden(room, me, role) {
  const own = role === 'fire' ? P.T.LAVA : P.T.WATER;
  const ty = Math.round((me.y + P.CHAR.height) / T);
  const start = [];
  for (let tx = Math.floor((me.x + 4) / T); tx <= Math.floor((me.x + P.CHAR.width - 4) / T); tx++) if (P.tileAt(room.level, tx, ty) === own) start.push([tx, ty]);
  const seen = new Set(room.state.safePools);
  while (start.length) {
    const [x, y] = start.pop();
    const k = `${x},${y}`;
    if (seen.has(k) || P.tileAt(room.level, x, y) !== own) continue;
    seen.add(k);
    start.push([x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]);
  }
  room.state.safePools = [...seen];
}

// The ✦ button (or the second one, with Dual Wield): use the equipped item.
function use(room, role, slot = 1) {
  const run = room.run;
  if (room.phase !== 'playing' || !ROLES.includes(role)) return false;
  const excl = exclusiveOf(run, role);
  if (excl && (slot !== 1 || run.equip[role] !== excl.uid)) return false; // only the exclusive item works
  if (slot === 2 && !hasSecondSlot(run, role)) return false;
  const it = findEquippable(run, role, slotsOf(run, slot)[role]);
  if (it) run.started = true; // using an item starts the room too
  if (!it) return false;
  const b = B.BY_ID[it.id];
  if (it.spent || !it.ready || it.coolT > 0) return false;
  const me = room.players[role].body;
  const other = room.players[role === 'fire' ? 'water' : 'fire'].body;
  const cx = me.x + P.CHAR.width / 2, cy = me.y + P.CHAR.height / 2;
  const near = (r, dist) => Math.hypot(r.x + r.w / 2 - cx, r.y + r.h / 2 - cy) < dist;
  switch (it.id) {
    case 'blast':
      for (const e of run.enemies) {
        if (e.type === 'burrower' && e.phase !== 'out') continue;
        if (killable(e) && near(liveRect(e), 80)) kill(room, e);
        else if (near(liveRect(e), 140)) e.stunT = 2.5;
      }
      run.shots = run.shots.filter((sh) => !near({ x: sh.x, y: sh.y, w: 10, h: 10 }, 110));
      break;
    case 'crate': {
      const spot = boxSpot(room, me);
      if (!spot) return false;
      room.state.boxes.push({ x: spot.x, y: spot.y, w: P.BOX.size, h: P.BOX.size, vy: 0, onGround: false });
      break;
    }
    case 'geyser': {
      const tx = Math.floor(cx / T);
      const feet = me.y + P.CHAR.height;
      room.state.geysers.push({ x: (tx - 0.5) * T, y: feet - 7 * T, w: 2 * T, h: 7 * T, t: 5 });
      break;
    }
    case 'swap': {
      const a = { x: me.x, y: me.y, vx: me.vx, vy: me.vy };
      Object.assign(me, { x: other.x, y: other.y, vx: other.vx, vy: other.vy });
      Object.assign(other, a);
      break;
    }
    case 'reroll':
      if (stageKind(run) !== 'room') return false;
      break;
    case 'recall': toStart(room, role); break;
    case 'beacon': {
      const top = { x: other.x, y: other.y - P.CHAR.height };
      const tx0 = Math.floor(top.x / T), tx1 = Math.floor((top.x + P.CHAR.width - 1) / T);
      const tyTop = Math.floor(top.y / T);
      const clear = [tx0, tx1].every((tx) => !P.isSolid(room.level, tx, tyTop));
      Object.assign(me, clear ? top : { x: other.x, y: other.y }, { vx: 0, vy: 0 });
      break;
    }
    case 'gun': {
      const dir = me.facing || 1;
      run.bullets.push({ id: ++run.shotId, x: dir > 0 ? me.x + P.CHAR.width : me.x - GUN.size, y: me.y + 10, vx: dir * GUN.speed, left: GUN.range });
      break;
    }
    case 'cloak': run.effects[role].cloakT = b.duration; break;
    case 'shield': run.effects[role].shieldT = b.duration; break;
    case 'wings': me.flyT = b.duration; break;
    case 'phase': me.phase = !me.phase; break;
    case 'dash':
      me.dashT = P.DASH.time; me.dashDir = me.facing || 1;
      break;
    default: return false;
  }
  if (b.uses === 'combat') it.ready = false;
  if (b.uses === 'cooldown') it.coolT = b.cooldown;
  if (b.uses === 'once') {
    it.spent = true; it.ready = false;
    for (const r of ROLES) for (const sl of [run.equip, run.equip2]) if (sl[r] === it.uid) sl[r] = null; // used up
  }
  room.events.push({ type: 'used', id: it.id, role });
  if (it.id === 'reroll') room.loadStage();
  return true;
}

// What clients need to draw the run (sent with every snapshot).
function view(room) {
  const run = room.run;
  const item = (i) => ({ uid: i.uid, id: i.id, ready: i.ready, spent: i.spent, cool: i.coolT > 0 });
  return {
    stage: run.stage,
    stages: STAGES,
    started: !!run.started,
    hearts: run.hearts,
    maxHearts: run.maxHearts,
    items: run.items.map(item),
    personal: { fire: run.personal.fire.map(item), water: run.personal.water.map(item) },
    equip: run.equip,
    equip2: run.equip2,
    secondSlot: { fire: hasSecondSlot(run, 'fire'), water: hasSecondSlot(run, 'water') },
    locked: { fire: !!exclusiveOf(run, 'fire'), water: !!exclusiveOf(run, 'water') },
    ghost: run.ghost,
    keenEye: teamCount(run, 'keeneye') > 0,
    umbrella: teamCount(run, 'umbrella') > 0,
    chest: run.chest && { x: run.chest.x, y: run.chest.y, w: run.chest.w, h: run.chest.h, rare: run.chest.rare, open: run.chest.open },
    effects: run.effects,
    map: run.map && {
      rarity: run.map.rarity,
      teamFrom: run.map.teamFrom,
      uncommonChance: run.map.uncommonChance,
      step: run.map.step,
      shared: run.map.shared,
      rps: run.map.rps,
      personal: run.map.personal,
    },
    result: run.result,
    invuln: run.invuln,
    guardianReady: ROLES.filter((r) => run.items.some((i) => i.id === 'guardian') && !run.guardUsed[r]),
    // Full enemy state: the client predicts the fixed-rule ones forward (shared/enemies.js)
    // and smooths the rest between snapshots.
    time: run.time,
    slow: Math.pow(0.75, teamCount(run, 'slowtime')),
    enemies: run.enemies.filter((e) => !e.dead).map(({ block, ...e }) => e),
    shots: run.shots.map((sh) => ({ ...sh })),
    bullets: run.bullets.map((b) => ({ ...b })),
    weather: run.weather && { ...run.weather },
    acid: run.acid && { ...run.acid },
  };
}

module.exports = {
  STAGES, HEARTS, ACID, WEATHER, weatherOptions, withPools, createRun, start, loadStage, onAttempt, onComplete, updateEnemies, absorb,
  act, equip, use, view, grant, sentrySpots, enemySpecs, rng, offer, offerTeam, kill, CHEST,
};
