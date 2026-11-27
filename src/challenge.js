// Challenge mode: a roguelike run of 10 rooms — 4 normal rooms, boss 1, 4 normal rooms,
// boss 2 — with team hearts, a team inventory, personal powers, and a map between rooms
// where the team votes on a shared bonus (rock-paper-scissors on a tie) and each player
// picks a personal one. Enemies live here too. No I/O; driven by src/game.js.

const P = require('../shared/physics');
const B = require('../shared/bonuses');

const ROLES = ['fire', 'water'];
const STAGES = ['room', 'room', 'room', 'room', 'boss1', 'room', 'room', 'room', 'room', 'boss2'];
const HEARTS = { start: 5, max: 8 };
const SHIELD_INVULN = 1.5;      // seconds of safety after Guardian saves you
const ACID = { period: 9, countdown: 3, burn: 0.5, firstAt: 4 };
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
    items: [],                       // team inventory: { uid, id, ready }
    nextUid: 1,
    powers: { fire: [], water: [] },
    equip: { fire: null, water: null }, // uid of the yellow item each player has equipped
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
  const count = run.stage < 4 ? 1 + Math.floor(run.rand() * 2) : 2 + Math.floor(run.rand() * 2);
  const spots = sentrySpots(level);
  const chosen = [];
  for (const s of pickN(run.rand, spots, spots.length)) {
    if (chosen.length >= count) break;
    if (chosen.some((c) => Math.abs(c.tx - s.tx) < 5 && c.ty === s.ty)) continue;
    chosen.push(s);
  }
  return chosen.map((s) => ({ type: 'sentry', x: s.tx * T + 3, y: (s.ty + 1) * T - 18, w: 18, h: 18 }));
}

// ── Enemies ──

function resetEnemies(room) {
  const run = room.run;
  run.time = 0;
  run.shots = [];
  run.acid = null;
  run.enemies = room.enemySpecs.filter((e) => e.type !== 'acid').map((e) => ({ ...e, stunT: 0, dead: false, dir: 1, x: e.x ?? e.x0, size: e.size0, yNow: e.y }));
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
  for (const r of ROLES) run.invuln[r] = Math.max(0, run.invuln[r] - dt);
  const bodies = ROLES.map((r) => room.players[r].body);
  for (const e of run.enemies) {
    if (e.dead) continue;
    if (e.stunT > 0) { e.stunT -= dt; continue; }
    if (e.type === 'flyer') {
      e.x += e.dir * e.speed * dt;
      if (e.x < e.x0) { e.x = e.x0; e.dir = 1; } else if (e.x > e.x1) { e.x = e.x1; e.dir = -1; }
      e.yNow = e.y + Math.sin(run.time * 1.7) * e.amp; // e.y is the centre line
    } else if (e.type === 'walker') {
      e.size = e.size0 + (e.size1 - e.size0) * Math.min(1, run.time / e.grow);
      e.x += e.dir * e.speed * dt;
      if (e.x < e.x0) { e.x = e.x0; e.dir = 1; } else if (e.x + e.size > e.x1) { e.x = e.x1 - e.size; e.dir = -1; }
    } else if (e.type === 'shooter') {
      e.cool = (e.cool ?? SHOOTER.period) - dt;
      if (e.cool <= 0) {
        e.cool = SHOOTER.period;
        const cx = e.x + e.w / 2, cy = e.y + e.h;
        const target = bodies.map((b) => ({ b, d: Math.hypot(b.x + 10 - cx, b.y + 15 - cy) })).sort((a, b) => a.d - b.d)[0].b;
        const dx = target.x + 10 - cx, dy = target.y + 15 - cy, d = Math.hypot(dx, dy) || 1;
        run.shots.push({ x: cx - SHOOTER.size / 2, y: cy, vx: (dx / d) * SHOOTER.speed, vy: (dy / d) * SHOOTER.speed });
      }
    }
  }
  // Shots fly straight and stop at rock.
  run.shots = run.shots.filter((s) => {
    s.x += s.vx * dt; s.y += s.vy * dt;
    const tx = Math.floor((s.x + SHOOTER.size / 2) / T), ty = Math.floor((s.y + SHOOTER.size / 2) / T);
    return P.tileAt(room.level, tx, ty) !== P.T.SOLID && s.x > -50 && s.x < room.level.pxWidth + 50 && s.y < room.level.pxHeight + 50;
  });
  // Acid floor: 3-2-1, then half a second when touching any ground kills.
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
  // Touching an enemy or a shot.
  for (const r of ROLES) {
    const cr = shrink(charRect(room.players[r].body), 2);
    for (const e of run.enemies) {
      if (e.dead || e.stunT > 0) continue;
      const er = e.type === 'flyer' ? { x: e.x, y: e.yNow ?? e.y, w: e.w, h: e.h } : enemyRect(e);
      if (overlaps(cr, shrink(er, 2))) { hits.push({ role: r, cause: e.type }); break; }
    }
    for (const s of run.shots) if (overlaps(cr, { x: s.x, y: s.y, w: SHOOTER.size, h: SHOOTER.size })) { hits.push({ role: r, cause: 'shot' }); break; }
  }
  return hits;
}

// Something would kill `role`. Returns true if they're saved (invulnerable or Guardian).
function absorb(room, role) {
  const run = room.run;
  if (run.invuln[role] > 0) return true;
  if (!run.shieldUsed && run.items.some((i) => i.id === 'shield')) {
    run.shieldUsed = true;
    run.invuln[role] = SHIELD_INVULN;
    room.events.push({ type: 'shield', role });
    return true;
  }
  return false;
}

// ── Run flow ──

function bodyMods(run, role) {
  return { ...B.mods(run.powers[role]), flyT: 0, airJumps: 0 };
}

// Called at the start of every attempt (room load, restart, after a death).
function onAttempt(room) {
  const run = room.run;
  run.shieldUsed = false;
  run.invuln = { fire: 0, water: 0 };
  for (const it of run.items) it.ready = true; // rechargeable items refill each attempt
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

// The room was cleared: open the map (bonus choices), or the run is won.
function onComplete(room) {
  const run = room.run;
  if (run.stage === STAGES.length - 1) {
    run.result = 'victory';
    room.phase = 'over';
    room.events.push({ type: 'run-over', result: 'victory' });
    return;
  }
  const rarity = stageKind(run) === 'room' ? 'common' : 'rare';
  const sharedPool = B.pool('shared', rarity).filter((b) => !(b.color === 'green' && run.items.some((i) => i.id === b.id)));
  const personal = {};
  for (const r of ROLES) {
    const own = new Set(run.powers[r]);
    personal[r] = pickN(run.rand, B.pool('personal', rarity).filter((b) => !own.has(b.id)), 2).map((b) => b.id);
  }
  run.map = {
    rarity,
    step: 'shared',
    shared: { options: pickN(run.rand, sharedPool, 2).map((b) => b.id), votes: {} },
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
  else if (b.type === 'power') run.powers[role].push(id);
  else if (b.type === 'item') {
    const it = { uid: run.nextUid++, id, ready: true };
    run.items.push(it);
    // Equip a new yellow item for whoever has nothing equipped (the picker first).
    if (b.color === 'yellow') for (const r of role ? [role, ...ROLES] : ROLES) if (!run.equip[r]) { run.equip[r] = it.uid; break; }
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

// Equip one of the team's yellow items (taking it from the partner if they had it).
function equip(room, role, uid) {
  const run = room.run;
  const it = run.items.find((i) => i.uid === uid);
  if (!it || B.BY_ID[it.id].color !== 'yellow') return false;
  for (const r of ROLES) if (run.equip[r] === uid) run.equip[r] = null;
  run.equip[role] = uid;
  return true;
}

// The ✦ button: use the equipped item.
function use(room, role) {
  const run = room.run;
  if (room.phase !== 'playing') return false;
  const it = run.items.find((i) => i.uid === run.equip[role]);
  if (!it || !it.ready) return false;
  const me = room.players[role].body;
  const other = room.players[role === 'fire' ? 'water' : 'fire'].body;
  const cx = me.x + P.CHAR.width / 2, cy = me.y + P.CHAR.height / 2;
  const near = (r, dist) => Math.hypot(r.x + r.w / 2 - cx, r.y + r.h / 2 - cy) < dist;
  const consume = () => { run.items = run.items.filter((i) => i !== it); for (const r of ROLES) if (run.equip[r] === it.uid) run.equip[r] = null; };
  switch (it.id) {
    case 'blast':
      it.ready = false;
      for (const e of run.enemies) {
        const er = e.type === 'flyer' ? { x: e.x, y: e.yNow ?? e.y, w: e.w, h: e.h } : enemyRect(e);
        if (e.type === 'sentry' && near(er, 80)) e.dead = true;
        else if (near(er, 140)) e.stunT = 2.5;
      }
      run.shots = run.shots.filter((s) => !near({ x: s.x, y: s.y, w: 10, h: 10 }, 110));
      break;
    case 'wings':
      it.ready = false;
      me.flyT = B.WINGS_SECONDS;
      break;
    case 'swap': {
      consume();
      const a = { x: me.x, y: me.y, vx: me.vx, vy: me.vy };
      Object.assign(me, { x: other.x, y: other.y, vx: other.vx, vy: other.vy });
      Object.assign(other, a);
      break;
    }
    case 'reroll':
      if (stageKind(run) !== 'room') return false;
      consume();
      room.loadStage();
      break;
    default:
      return false;
  }
  room.events.push({ type: 'used', id: it.id, role });
  return true;
}

// What clients need to draw the run (sent with every snapshot).
function view(room) {
  const run = room.run;
  return {
    stage: run.stage,
    stages: STAGES,
    hearts: run.hearts,
    maxHearts: run.maxHearts,
    items: run.items.map((i) => ({ uid: i.uid, id: i.id, ready: i.ready })),
    powers: run.powers,
    equip: run.equip,
    map: run.map && {
      rarity: run.map.rarity,
      step: run.map.step,
      shared: run.map.shared,
      rps: run.map.rps,
      personal: run.map.personal,
    },
    result: run.result,
    invuln: run.invuln,
    shieldReady: run.items.some((i) => i.id === 'shield') && !run.shieldUsed,
    enemies: run.enemies.filter((e) => !e.dead).map((e) => {
      const r = e.type === 'flyer' ? { x: e.x, y: e.yNow ?? e.y, w: e.w, h: e.h } : enemyRect(e);
      return { type: e.type, x: r.x, y: r.y, w: r.w, h: r.h, stun: e.stunT > 0 };
    }),
    shots: run.shots.map((s) => ({ x: s.x, y: s.y })),
    acid: run.acid && { countdown: Math.max(0, run.acid.countdown), burning: run.acid.burning > 0 },
  };
}

module.exports = {
  STAGES, HEARTS, ACID, createRun, start, loadStage, onAttempt, onComplete, updateEnemies, absorb,
  act, equip, use, view, grant, sentrySpots, enemySpecs, rng,
};
