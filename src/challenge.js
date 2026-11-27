// Challenge mode: a roguelike run of 10 rooms — 4 normal rooms, boss 1, 4 normal rooms,
// boss 2 — with team hearts, a team inventory, personal inventories, and a map between
// rooms where the team votes on a team bonus (rock-paper-scissors on a tie) and each
// player picks a personal one. Enemies live here too. No I/O; driven by src/game.js.

const P = require('../shared/physics');
const B = require('../shared/bonuses');

const ROLES = ['fire', 'water'];
const STAGES = ['room', 'room', 'room', 'room', 'boss1', 'room', 'room', 'room', 'room', 'boss2'];
const HEARTS = { start: 5, max: 8 };
const GUARDIAN_INVULN = 1;      // seconds of safety after Guardian sends you back to start
// Boss 2's acid floor: a 3 s countdown, then all ground burns for 0.1 s. A jump keeps you
// in the air ~0.62 s, so you have about half a second in which to jump.
const ACID = { period: 9, countdown: 3, burn: 0.1, firstAt: 4 };
const GUN = { speed: 480, range: 5 * 24, size: 8 };
const PATROL = { size: 20, speed: 45, minRun: 3 };          // walkers pacing along platforms
const BOMBER = { w: 30, h: 18, speed: 80, cooldown: 1.2, gravity: 900, size: 10 };
// Rooms 6–9 only:
const BURROW = { hideMin: 5, hideMax: 10, warn: 2, out: 0.6, radius: 1.5 * 24 };  // hides, cracks, bursts
const MIMIC = { shakeEvery: 5, shake: 0.6 };                                       // a box that stabs
const CHARGER = { size: 22, sight: 6 * 24, height: 1.5 * 24, charge: 1.6, back: 0.35, maxRun: 10 * 24, tired: 5, minRun: 5 };
const SHOOTER = { period: 1.6, speed: 200, size: 10 };
const BOSS_DEFS = { boss1: require('../levels/boss-1.json'), boss2: require('../levels/boss-2.json') };
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
    equip: { fire: null, water: null }, // uid of the yellow item each player has equipped
    effects: { fire: { cloakT: 0, shieldT: 0 }, water: { cloakT: 0, shieldT: 0 } },
    inElement: { fire: false, water: false }, // for Element Ward: were you in your element last tick?
    bullets: [],                     // Blaster shots
    used: new Set(),                 // campaign levels already played this run
    map: null,                       // the between-rooms screen (votes and picks)
    result: null,                    // 'victory' | 'defeat'
    shieldUsed: false,
    invuln: { fire: 0, water: 0 },
    time: 0,                         // seconds into the current attempt (enemy clocks)
    enemies: [],
    shots: [],
    acid: null,                      // { next, countdown, burning }
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

function enemySpecs(run, kind, level) {
  if (kind === 'boss1') {
    return [
      { type: 'flyer', x0: 4 * T, x1: 36 * T, y: 9.5 * T, amp: 3 * T, speed: 95, w: 34, h: 24 },
      { type: 'walker', x0: 6 * T, x1: 33 * T, floor: 21 * T, speed: 70, size0: 22, size1: 72, grow: 60 },
    ];
  }
  if (kind === 'boss2') {
    return [{ type: 'shooter', x: 19.5 * T - 14, y: 1.2 * T, w: 28, h: 22 }, { type: 'acid' }];
  }
  // Room 1 is an exact campaign level, untouched, so it's winnable with no bonuses at all.
  if (run.stage === 0) return [];
  const count = run.stage < 4 ? 1 + Math.floor(run.rand() * 2) : 2 + Math.floor(run.rand() * 2);
  const spots = sentrySpots(level);
  // Room 2 has sentries; rooms 3–4 sentries or patrolling walkers; rooms 6–9 one of
  // sentries, walkers, burrowers, mimics or chargers. Never a mix of these.
  const types = run.stage < 2 ? ['sentry'] : run.stage < 4 ? ['sentry', 'patrol'] : ['sentry', 'patrol', 'burrower', 'mimic', 'charger'];
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

// The bomber flies along the highest row with an open stretch of at least 12 tiles
// (nothing solid in that row), patrolling just that stretch.
function bomberLane(level) {
  for (let ty = 1; ty < level.height - 4; ty++) {
    let best = null, start = null;
    for (let tx = 1; tx <= level.width - 1; tx++) {
      const open = tx < level.width - 1 && !P.isSolid(level, tx, ty);
      if (open && start === null) start = tx;
      if (!open && start !== null) {
        if (!best || tx - start > best.len) best = { tx0: start, len: tx - start };
        start = null;
      }
    }
    if (best && best.len >= 12) {
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

// ── Enemies ──

function resetEnemies(room) {
  const run = room.run;
  run.time = 0;
  run.shots = [];
  run.bullets = [];
  run.acid = null;
  run.enemies = room.enemySpecs.filter((e) => e.type !== 'acid').map((e) => ({ ...e, stunT: 0, dead: false, dir: 1, x: e.x ?? e.x0, size: e.size0, yNow: e.y }));
  room.state.blocks = [];
  for (const e of run.enemies) {
    if (e.type === 'mimic') { e.block = { x: e.x, y: e.y, w: e.w, h: e.h }; room.state.blocks.push(e.block); e.shakeT = run.rand() * MIMIC.shakeEvery; }
    if (e.type === 'burrower') { e.phase = 'hidden'; e.t = BURROW.hideMin * 0.6; e.x = 0; e.y = 0; }
    if (e.type === 'charger') {
      Object.assign(e, { mode: 'ready', homeX: e.x, vx: 0, vy: 0, onGround: false, coyoteT: 0, bufferT: 0, w: CHARGER.size, h: CHARGER.size });
    }
  }
  if (room.enemySpecs.some((e) => e.type === 'acid')) run.acid = { next: ACID.firstAt, countdown: 0, burning: 0 };
}

const shrink = (r, by) => ({ x: r.x + by, y: r.y + by, w: r.w - 2 * by, h: r.h - 2 * by });
const overlaps = (a, b) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
const charRect = (b) => ({ x: b.x, y: b.y, w: P.CHAR.width, h: P.CHAR.height });

function enemyRect(e) {
  if (e.type === 'walker') return { x: e.x, y: e.floor - e.size, w: e.size, h: e.size };
  return { x: e.x, y: e.y, w: e.w, h: e.h };
}

// Advance enemies one tick. Returns the roles hit this tick: [{ role, cause }].
function updateEnemies(room, dt) {
  const run = room.run;
  run.time += dt;
  for (const r of ROLES) {
    run.invuln[r] = Math.max(0, run.invuln[r] - dt);
    run.effects[r].cloakT = Math.max(0, run.effects[r].cloakT - dt);
    run.effects[r].shieldT = Math.max(0, run.effects[r].shieldT - dt);
  }
  for (const it of allItems(run)) if (it.coolT > 0) it.coolT = Math.max(0, it.coolT - dt);
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
  }
  for (const e of run.enemies) {
    if (e.dead) continue;
    if (e.stunT > 0) { e.stunT -= dt; continue; }
    if (e.type === 'flyer') {
      e.x += e.dir * e.speed * dt;
      if (e.x < e.x0) { e.x = e.x0; e.dir = 1; } else if (e.x > e.x1) { e.x = e.x1; e.dir = -1; }
      e.yNow = e.y + Math.sin(run.time * 1.7) * e.amp; // e.y is the centre line
    } else if (e.type === 'walker') {
      e.size = e.size0 + (e.size1 - e.size0) * Math.min(1, run.time / e.grow);
      walk(room, e);
      if (e.x < e.x0) { e.x = e.x0; e.dir = 1; } else if (e.x + e.size > e.x1) { e.x = e.x1 - e.size; e.dir = -1; }
    } else if (e.type === 'patrol') {
      walk(room, e);
      if (e.x < e.x0) { e.x = e.x0; e.dir = 1; } else if (e.x > e.x1) { e.x = e.x1; e.dir = -1; }
    } else if (e.type === 'bomber') {
      e.x += e.dir * e.speed * dt;
      if (e.x < e.x0) { e.x = e.x0; e.dir = 1; } else if (e.x > e.x1) { e.x = e.x1; e.dir = -1; }
      e.cool = Math.max(0, (e.cool ?? 0) - dt);
      const cx = e.x + e.w / 2;
      const below = ROLES.filter((r) => !cloaked(r)).some((r) => {
        const b = room.players[r].body;
        return Math.abs(b.x + P.CHAR.width / 2 - cx) < 12 && b.y > e.y;
      });
      if (below && e.cool === 0) {
        e.cool = BOMBER.cooldown;
        run.shots.push({ x: cx - BOMBER.size / 2, y: e.y + e.h, vx: 0, vy: 40, g: BOMBER.gravity, kind: 'bomb' });
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
    } else if (e.type === 'mimic') {
      e.shakeT = (e.shakeT + dt) % MIMIC.shakeEvery;
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
          run.shots.push({ x: cx - SHOOTER.size / 2, y: cy, vx: (dx / d) * SHOOTER.speed, vy: (dy / d) * SHOOTER.speed });
        }
      }
    }
  }
  // Enemy shots and bombs stop at anything solid: rock, boxes, mimics, closed gates,
  // pulley platforms. The check covers the whole distance moved, so a fast bomb can't
  // skip through a thin platform.
  const hitsSolid = (x0, y0, x1, y1, size) => blockedRects(room, {
    x: Math.min(x0, x1), y: Math.min(y0, y1), w: Math.abs(x1 - x0) + size, h: Math.abs(y1 - y0) + size,
  }).length > 0;
  run.shots = run.shots.filter((sh) => {
    if (sh.g) sh.vy += sh.g * dt; // bombs fall
    const x0 = sh.x, y0 = sh.y;
    sh.x += sh.vx * dt; sh.y += sh.vy * dt;
    return !hitsSolid(x0, y0, sh.x, sh.y, SHOOTER.size) && sh.x > -50 && sh.x < room.level.pxWidth + 50 && sh.y < room.level.pxHeight + 50;
  });
  // Blaster shots: short range, destroy sentries, stun bosses.
  run.bullets = run.bullets.filter((b) => {
    const bx0 = b.x;
    b.x += b.vx * dt; b.left -= Math.abs(b.vx * dt);
    if (b.left <= 0 || hitsSolid(bx0, b.y, b.x, b.y, GUN.size)) return false;
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
    if (a.burning > 0) {
      a.burning -= dt;
      if (a.burning <= 0) { a.next = ACID.period - ACID.countdown - ACID.burn; }
    } else if (a.countdown > 0) {
      a.countdown -= dt;
      if (a.countdown <= 0) { a.burning = ACID.burn; room.events.push({ type: 'acid' }); }
    } else {
      a.next -= dt;
      if (a.next <= 0) { a.countdown = ACID.countdown; room.events.push({ type: 'countdown' }); }
    }
    if (a.burning > 0) {
      for (const r of ROLES) {
        const p = room.players[r];
        if (p.body.onGround && !p.body.acidImmune) hits.push({ role: r, cause: 'acid floor' });
      }
    }
  }
  // Touching an enemy (not while cloaked) or an enemy shot.
  for (const r of ROLES) {
    const cr = shrink(charRect(room.players[r].body), 2);
    if (!cloaked(r)) {
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
          // walking into its side ("pushing" it) gets you stabbed; standing on it is fine
          const b = p.body, er = liveRect(e);
          const level = b.y + P.CHAR.height > er.y + 2 && b.y < er.y + er.h;
          const pushRight = p.input.right && Math.abs(b.x + P.CHAR.width - er.x) < 1.5;
          const pushLeft = p.input.left && Math.abs(b.x - (er.x + er.w)) < 1.5;
          if (level && (pushRight || pushLeft)) { hits.push({ role: r, cause: 'mimic' }); break; }
          continue;
        }
        if (overlaps(cr, shrink(liveRect(e), 2))) { hits.push({ role: r, cause: e.type }); break; }
      }
    }
    for (const sh of run.shots) if (overlaps(cr, { x: sh.x, y: sh.y, w: SHOOTER.size, h: SHOOTER.size })) { hits.push({ role: r, cause: sh.kind === 'bomb' ? 'bomb' : 'shot' }); break; }
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

// Walkers turn around instead of walking into boxes, mimics, closed gates, pulley
// platforms or rock. Only new contact counts, so one a box was pushed into can leave.
function walk(room, e) {
  const dt = P.DT;
  const now = enemyRect(e);
  const next = { ...now, x: now.x + e.dir * e.speed * dt };
  if (blockedRects(room, next).some((o) => !overlaps(now, o))) { e.dir = -e.dir; return; }
  e.x = next.x;
}

function blockedRects(room, r) {
  const out = [];
  const tx0 = Math.floor(r.x / T), tx1 = Math.floor((r.x + r.w - 0.001) / T);
  const ty0 = Math.floor(r.y / T), ty1 = Math.floor((r.y + r.h - 0.001) / T);
  for (let ty = ty0; ty <= ty1; ty++) for (let tx = tx0; tx <= tx1; tx++) if (P.isSolid(room.level, tx, ty)) out.push({ x: tx * T, y: ty * T, w: T, h: T });
  room.level.gates.forEach((g, i) => { if (!room.state.gates[i] && overlaps(r, g.rect)) out.push(g.rect); });
  for (const p of P.platformRects(room.level, room.state)) if (overlaps(r, p)) out.push(p);
  for (const b of room.state.boxes.concat(room.state.blocks || [])) if (overlaps(r, b)) out.push(b);
  return out;
}

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

function liveRect(e) {
  return e.type === 'flyer' ? { x: e.x, y: e.yNow ?? e.y, w: e.w, h: e.h } : enemyRect(e);
}

// Something would kill `role`. Returns true if they're saved: Shield, the moment of
// safety after Guardian, or Guardian itself (once per room: back to the start).
function absorb(room, role) {
  const run = room.run;
  if (run.invuln[role] > 0 || run.effects[role].shieldT > 0) return true;
  if (!run.shieldUsed && run.items.some((i) => i.id === 'guardian')) {
    run.shieldUsed = true;
    run.invuln[role] = GUARDIAN_INVULN;
    toStart(room, role);
    room.events.push({ type: 'guardian', role });
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
  e.dead = true;
  if (e.block) room.state.blocks = room.state.blocks.filter((b) => b !== e.block);
}

const allItems = (run) => run.items.concat(run.personal.fire, run.personal.water);
const ownedIds = (run, role) => run.personal[role].map((i) => i.id);

function bodyMods(run, role) {
  return { ...B.mods(ownedIds(run, role)), flyT: 0, airJumps: 0 };
}

// Called at the start of every attempt (room load, restart, after a death).
function onAttempt(room) {
  const run = room.run;
  run.started = false; // enemies and the clock wait until someone moves (see game.js)
  run.shieldUsed = false;
  run.invuln = { fire: 0, water: 0 };
  run.effects = { fire: { cloakT: 0, shieldT: 0 }, water: { cloakT: 0, shieldT: 0 } };
  run.inElement = { fire: false, water: false };
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
    def = BOSS_DEFS[kind];
    label = `Boss ${kind === 'boss1' ? 1 : 2}`;
  }
  room.enemySpecs = [];
  load(def, { index: run.stage, total: STAGES.length, label });
  room.enemySpecs = enemySpecs(run, kind, room.level);
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
  const avail = (rarity) => B.pool(scope, rarity).filter((b) => !exclude.has(b.id));
  const out = [];
  for (let k = 0; k < n; k++) {
    const tiers = boss ? ['rare'] : run.rand() < uncommonChance ? ['uncommon', 'common'] : ['common'];
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
  const total = room.level.gems.length;
  const stars = room.state.gems.filter(Boolean).length;
  const chance = total ? Math.min(1, stars / total) : 0;
  // team: no duplicates of team items you already hold (healing can repeat)
  const teamOwned = new Set(run.items.map((i) => i.id));
  const personal = {};
  // each player's offer is drawn independently: both can be offered the same thing
  // repeatable items (Spring, Swift, Magnet) stay on offer after you have them
  const notRepeat = (ids) => new Set(ids.filter((id) => !B.BY_ID[id].repeat));
  for (const r of ROLES) personal[r] = offer(run, 'personal', 2, notRepeat(ownedIds(run, r)), chance, boss);
  run.map = {
    rarity: boss ? 'rare' : 'common',
    uncommonChance: boss ? 0 : chance,
    step: 'shared',
    shared: { options: offer(run, 'team', 2, teamOwned, chance, boss), votes: {} },
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
    if (b.color === 'yellow') {
      const who = b.scope === 'personal' ? [role] : role ? [role, ...ROLES] : ROLES;
      for (const r of who) if (!run.equip[r]) { run.equip[r] = it.uid; break; }
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

// Equip an active item (a team item is taken from the partner if they had it).
function equip(room, role, uid) {
  const run = room.run;
  if (!ROLES.includes(role) || !findEquippable(run, role, uid)) return false;
  for (const r of ROLES) if (run.equip[r] === uid) run.equip[r] = null;
  run.equip[role] = uid;
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

// The ✦ button: use the equipped item.
function use(room, role) {
  const run = room.run;
  if (room.phase !== 'playing' || !ROLES.includes(role)) return false;
  const it = findEquippable(run, role, run.equip[role]);
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
      run.bullets.push({ x: dir > 0 ? me.x + P.CHAR.width : me.x - GUN.size, y: me.y + 10, vx: dir * GUN.speed, left: GUN.range });
      break;
    }
    case 'cloak': run.effects[role].cloakT = b.duration; break;
    case 'shield': run.effects[role].shieldT = b.duration; break;
    case 'wings': me.flyT = b.duration; break;
    default: return false;
  }
  if (b.uses === 'combat') it.ready = false;
  if (b.uses === 'cooldown') it.coolT = b.cooldown;
  if (b.uses === 'once') {
    it.spent = true; it.ready = false;
    for (const r of ROLES) if (run.equip[r] === it.uid) run.equip[r] = null; // used up: can't be equipped
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
    effects: run.effects,
    map: run.map && {
      rarity: run.map.rarity,
      uncommonChance: run.map.uncommonChance,
      step: run.map.step,
      shared: run.map.shared,
      rps: run.map.rps,
      personal: run.map.personal,
    },
    result: run.result,
    invuln: run.invuln,
    guardianReady: run.items.some((i) => i.id === 'guardian') && !run.shieldUsed,
    enemies: run.enemies.filter((e) => !e.dead).map((e) => {
      const r = liveRect(e);
      return {
        type: e.type, x: r.x, y: r.y, w: r.w, h: r.h, stun: e.stunT > 0,
        phase: e.phase, shake: e.type === 'mimic' && e.shakeT > MIMIC.shakeEvery - MIMIC.shake, mode: e.mode, dir: e.dir,
      };
    }),
    shots: run.shots.map((sh) => ({ x: sh.x, y: sh.y, kind: sh.kind })),
    bullets: run.bullets.map((b) => ({ x: b.x, y: b.y })),
    acid: run.acid && { countdown: Math.max(0, run.acid.countdown), burning: run.acid.burning > 0 },
  };
}

module.exports = {
  STAGES, HEARTS, ACID, createRun, start, loadStage, onAttempt, onComplete, updateEnemies, absorb,
  act, equip, use, view, grant, sentrySpots, enemySpecs, rng, offer,
};
