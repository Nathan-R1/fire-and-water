// Deterministic platformer physics + level mechanics, shared by server (Node) and
// client (browser). Units: pixels and seconds. Always stepped with the fixed DT.

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Physics = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const TILE = 24;
  const DT = 1 / 60;
  const EPS = 1e-6;

  const CHAR = {
    width: 20,
    height: 30,
    maxSpeed: 180,
    groundAccel: 1800,
    airAccel: 1100,
    friction: 2000,
    gravity: 1800,
    maxFall: 900,
    jumpVel: 560,      // peak height = jumpVel² / 2g ≈ 87px ≈ 3.6 tiles
    coyote: 0.1,       // seconds you can still jump after walking off a ledge
    jumpBuffer: 0.12,  // seconds a jump press is remembered before landing
  };

  const FAN = { speed: 260, accel: 2600 }; // fans push up toward -speed

  // Tile types
  const T = { EMPTY: 0, SOLID: 1, LAVA: 2, WATER: 3, ACID: 4, FAN: 5 };
  const TILE_CHARS = { '#': T.SOLID, L: T.LAVA, '~': T.WATER, A: T.ACID, '^': T.FAN };
  const SOLID_TYPES = new Set([T.SOLID, T.LAVA, T.WATER, T.ACID]); // pools are walkable surfaces

  /*
   * Level def:
   * {
   *   id, name,
   *   rows: ["####", "#F.w#", ...],
   *     '#' solid   'L' lava   '~' water   'A' acid   '^' fan (pushes up)
   *     'F' / 'W'   fire / water spawn (cell the character stands in)
   *     'f' / 'w'   fire / water exit door (cell the character stands in)
   *     'r' / 'b'   red (fire) / blue (water) gem
   *   objects: [
   *     { type: "plate", at: [x, y], ch: 1 }             pressed while someone stands on it
   *     { type: "lever", at: [x, y], ch: 1, dir: 1 }     turns on when walked through moving in dir and stays on;
   *                                                    with toggle: true, walking through the other way turns it off
   *     { type: "gate",  at: [x, y], size: [w, h], ch: 1, invert: false }   open while channel ch is active
   *   ]
   * }
   */
  function parseLevel(def) {
    const height = def.rows.length;
    const width = def.rows[0].length;
    const tiles = new Uint8Array(width * height);
    const spawns = {};
    const exits = {};
    const gems = [];
    def.rows.forEach((row, ty) => {
      if (row.length !== width) throw new Error(`level ${def.id}: row ${ty} has length ${row.length}, expected ${width}`);
      for (let tx = 0; tx < width; tx++) {
        const ch = row[tx];
        if (ch in TILE_CHARS) tiles[ty * width + tx] = TILE_CHARS[ch];
        else if (ch === 'F') spawns.fire = spawnAt(tx, ty);
        else if (ch === 'W') spawns.water = spawnAt(tx, ty);
        else if (ch === 'f') exits.fire = { tx, ty };
        else if (ch === 'w') exits.water = { tx, ty };
        else if (ch === 'r') gems.push({ el: 'fire', tx, ty });
        else if (ch === 'b') gems.push({ el: 'water', tx, ty });
        else if (ch !== '.') throw new Error(`level ${def.id}: unknown tile '${ch}' at ${tx},${ty}`);
      }
    });
    if (!spawns.fire || !spawns.water) throw new Error(`level ${def.id}: needs F and W spawns`);
    if (!exits.fire || !exits.water) throw new Error(`level ${def.id}: needs f and w exits`);

    const plates = [], levers = [], gates = [];
    for (const o of def.objects || []) {
      const [tx, ty] = o.at;
      if (tx < 0 || ty < 0 || tx >= width || ty >= height) throw new Error(`level ${def.id}: ${o.type} out of bounds`);
      if (o.type === 'plate') {
        plates.push({ ch: o.ch, tx, ty, rect: { x: tx * TILE + 2, y: (ty + 1) * TILE - 6, w: TILE - 4, h: 6 } });
      } else if (o.type === 'lever') {
        levers.push({ ch: o.ch, tx, ty, dir: o.dir || 1, toggle: !!o.toggle, start: !!o.on, rect: { x: tx * TILE, y: ty * TILE, w: TILE, h: TILE } });
      } else if (o.type === 'gate') {
        const [w, h] = o.size || [1, 1];
        gates.push({ ch: o.ch, invert: !!o.invert, tx, ty, tw: w, th: h, rect: { x: tx * TILE, y: ty * TILE, w: w * TILE, h: h * TILE } });
      } else {
        throw new Error(`level ${def.id}: unknown object type ${o.type}`);
      }
    }

    return {
      id: def.id, name: def.name, width, height, pxWidth: width * TILE, pxHeight: height * TILE,
      tiles, spawns, exits, gems, plates, levers, gates,
    };
  }

  // Spawn standing on the bottom of the marker tile, centred horizontally.
  function spawnAt(tx, ty) {
    return { x: tx * TILE + (TILE - CHAR.width) / 2, y: (ty + 1) * TILE - CHAR.height };
  }

  function tileAt(level, tx, ty) {
    if (tx < 0 || tx >= level.width || ty < 0 || ty >= level.height) return T.SOLID;
    return level.tiles[ty * level.width + tx];
  }

  function isSolid(level, tx, ty) {
    return SOLID_TYPES.has(tileAt(level, tx, ty));
  }

  // Dynamic per-attempt state: which gems are taken, which gates are open, etc.
  function createLevelState(level) {
    return {
      gems: level.gems.map(() => false),
      plates: level.plates.map(() => false),
      levers: level.levers.map((l) => l.start),
      gates: level.gates.map((g) => g.invert), // inverted gates start open
    };
  }

  function createBody(spawn) {
    return { x: spawn.x, y: spawn.y, vx: 0, vy: 0, onGround: false, coyoteT: 0, bufferT: 0 };
  }

  function pressJump(body) {
    body.bufferT = CHAR.jumpBuffer;
  }

  function overlaps(a, b) {
    return a.x < b.x + b.w - EPS && a.x + a.w > b.x + EPS && a.y < b.y + b.h - EPS && a.y + a.h > b.y + EPS;
  }

  function rectOf(body) {
    return { x: body.x, y: body.y, w: CHAR.width, h: CHAR.height };
  }

  function tileRange(r) {
    return {
      tx0: Math.floor(r.x / TILE), tx1: Math.floor((r.x + r.w - EPS) / TILE),
      ty0: Math.floor(r.y / TILE), ty1: Math.floor((r.y + r.h - EPS) / TILE),
    };
  }

  // Solid rects (tiles, closed gates, other characters) overlapping r.
  function solidsIn(level, r, others, state) {
    const out = [];
    const { tx0, tx1, ty0, ty1 } = tileRange(r);
    for (let ty = ty0; ty <= ty1; ty++) {
      for (let tx = tx0; tx <= tx1; tx++) {
        if (isSolid(level, tx, ty)) out.push({ x: tx * TILE, y: ty * TILE, w: TILE, h: TILE });
      }
    }
    if (state) {
      level.gates.forEach((g, i) => { if (!state.gates[i] && overlaps(r, g.rect)) out.push(g.rect); });
    }
    for (const o of others) {
      const or = rectOf(o);
      if (overlaps(r, or)) out.push(or);
    }
    return out;
  }

  function touchesTile(level, r, type) {
    const { tx0, tx1, ty0, ty1 } = tileRange(r);
    for (let ty = ty0; ty <= ty1; ty++) {
      for (let tx = tx0; tx <= tx1; tx++) if (tileAt(level, tx, ty) === type) return true;
    }
    return false;
  }

  // Move along one axis and snap against anything newly hit. Per-step movement is
  // always under one tile (maxFall * DT = 15px < 24px), so a single check is enough.
  // Obstacles already overlapping before the move are ignored so bodies can't get stuck.
  function moveAxis(level, body, axis, d, others, state) {
    if (!d) return false;
    const before = rectOf(body);
    body[axis] += d;
    const after = rectOf(body);
    const hits = solidsIn(level, after, others, state).filter((o) => !overlaps(before, o));
    if (!hits.length) return false;
    if (axis === 'x') {
      body.x = d > 0 ? Math.min(...hits.map((o) => o.x)) - CHAR.width : Math.max(...hits.map((o) => o.x + o.w));
    } else {
      body.y = d > 0 ? Math.min(...hits.map((o) => o.y)) - CHAR.height : Math.max(...hits.map((o) => o.y + o.h));
    }
    return true;
  }

  function approach(v, target, amount) {
    return v < target ? Math.min(v + amount, target) : Math.max(v - amount, target);
  }

  // input: { left: bool, right: bool }. Jumps come from pressJump().
  function stepBody(level, body, input, others, dt = DT, state = null) {
    const dir = (input.right ? 1 : 0) - (input.left ? 1 : 0);
    if (dir) {
      const accel = body.onGround ? CHAR.groundAccel : CHAR.airAccel;
      // Turning around uses friction too, so direction changes feel snappy.
      const turning = Math.sign(body.vx) === -dir;
      body.vx = approach(body.vx, dir * CHAR.maxSpeed, (accel + (turning ? CHAR.friction : 0)) * dt);
    } else {
      body.vx = approach(body.vx, 0, (body.onGround ? CHAR.friction : CHAR.airAccel * 0.5) * dt);
    }

    body.coyoteT = body.onGround ? CHAR.coyote : Math.max(0, body.coyoteT - dt);
    if (body.bufferT > 0 && body.coyoteT > 0) {
      body.vy = -CHAR.jumpVel;
      body.bufferT = 0;
      body.coyoteT = 0;
    }
    body.bufferT = Math.max(0, body.bufferT - dt);

    if (touchesTile(level, rectOf(body), T.FAN)) body.vy = approach(body.vy, -FAN.speed, FAN.accel * dt);
    else body.vy = Math.min(body.vy + CHAR.gravity * dt, CHAR.maxFall);

    if (moveAxis(level, body, 'x', body.vx * dt, others, state)) body.vx = 0;
    const hitY = moveAxis(level, body, 'y', body.vy * dt, others, state);
    body.onGround = hitY && body.vy > 0;
    if (hitY) body.vy = 0;
  }

  // Plates, levers and gates. Run once per tick before moving bodies.
  function updateMechanisms(level, state, bodies) {
    const rects = bodies.map(rectOf);
    level.plates.forEach((p, i) => { state.plates[i] = rects.some((r) => overlaps(r, p.rect)); });
    level.levers.forEach((l, i) => {
      bodies.forEach((b, j) => {
        if (!overlaps(rects[j], l.rect)) return;
        if (b.vx * l.dir > 20) state.levers[i] = true;
        else if (l.toggle && b.vx * l.dir < -20) state.levers[i] = false;
      });
    });
    const active = new Set();
    level.plates.forEach((p, i) => { if (state.plates[i]) active.add(p.ch); });
    level.levers.forEach((l, i) => { if (state.levers[i]) active.add(l.ch); });
    level.gates.forEach((g, i) => {
      const open = active.has(g.ch) !== g.invert;
      // A gate never closes on top of a character.
      if (!open && rects.some((r) => overlaps(r, g.rect))) return;
      state.gates[i] = open;
    });
  }

  function isDeadly(type, element) {
    return type === T.ACID || (type === T.LAVA && element === 'water') || (type === T.WATER && element === 'fire');
  }

  // Returns the deadly tile type under the character's feet, or 0. A few pixels at
  // each edge are forgiven so brushing a pool's corner isn't fatal.
  function hazardUnder(level, body, element) {
    if (!body.onGround) return 0;
    const ty = Math.floor((body.y + CHAR.height + 1) / TILE);
    const tx0 = Math.floor((body.x + 4) / TILE), tx1 = Math.floor((body.x + CHAR.width - 4) / TILE);
    for (let tx = tx0; tx <= tx1; tx++) {
      const t = tileAt(level, tx, ty);
      if (isDeadly(t, element)) return t;
    }
    return 0;
  }

  // Indices of gems newly collected by this body.
  function collectGems(level, state, body, element) {
    const r = rectOf(body);
    const got = [];
    level.gems.forEach((g, i) => {
      if (state.gems[i] || g.el !== element) return;
      const gr = { x: g.tx * TILE + 4, y: g.ty * TILE + 4, w: TILE - 8, h: TILE - 8 };
      if (overlaps(r, gr)) { state.gems[i] = true; got.push(i); }
    });
    return got;
  }

  // Standing in the doorway: centre inside the door cell and feet on its floor.
  function atExit(level, body, element) {
    const e = level.exits[element];
    const cx = body.x + CHAR.width / 2;
    const feet = body.y + CHAR.height;
    return body.onGround && cx >= e.tx * TILE && cx <= (e.tx + 1) * TILE && Math.abs(feet - (e.ty + 1) * TILE) < 1;
  }

  // Step every body in a fixed order; each treats the others as solid.
  function stepWorld(level, bodies, inputs, dt = DT, state = null) {
    if (state) updateMechanisms(level, state, bodies);
    bodies.forEach((b, i) => stepBody(level, b, inputs[i], bodies.filter((_, j) => j !== i), dt, state));
  }

  return {
    TILE, DT, CHAR, FAN, T,
    parseLevel, tileAt, isSolid, isDeadly, createLevelState, createBody, pressJump,
    stepBody, stepWorld, updateMechanisms, hazardUnder, collectGems, atExit,
  };
});
