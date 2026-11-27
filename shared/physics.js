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
    pushSpeed: 100,    // walking speed while pushing a box
  };

  const FAN = { speed: 260, accel: 2600 }; // fans push up toward -speed
  const FLY = { speed: 110, accel: 1500 };  // Wings: a gentle rise while flying

  /*
   * Optional per-character modifiers (Challenge mode powers), stored on the body so the
   * client predicts them exactly like the server:
   *   jumpMul       jump strength multiplier (Spring)
   *   speedMul      run speed multiplier (Swift)
   *   maxAirJumps   extra jumps in the air (Double jump); airJumps counts what's left
   *   flyT          seconds of flight left (Wings)
   *   acidImmune    acid doesn't kill (Acid skin)
   *   magnet        extra pickup reach for stars, in pixels (Magnet)
   */
  const BOX = { size: TILE };              // boxes are one tile; weight 1, same as a character
  const PULLEY = { speed: 80, thickness: 12 };

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
   *     'X'         pushable box (fills the cell)
   *   objects: [
   *     { type: "plate", at: [x, y], ch: 1 }             pressed while someone or a box is on it
   *     { type: "lever", at: [x, y], ch: 1, dir: 1 }     turns on when walked through moving in dir and stays on;
   *                                                    with toggle: true, walking through the other way turns it off
   *     { type: "gate",  at: [x, y], size: [w, h], ch: 1, invert: false }   open while channel ch is active
   *     { type: "pulley", a: [x, y], b: [x, y], w: 3, travel: 4 }
   *        two linked platforms w tiles wide, their tops starting at the top of row y. The side
   *        carrying more weight (characters and boxes, 1 each, stacked ones included) sinks and
   *        the other rises, by up to `travel` tiles from the start. Equal weight: they stay put.
   *        Instead of travel, min/max (tiles, can be 0) limit how far side a can rise (min < 0)
   *        or sink (max > 0); side b always moves the opposite way.
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
    const boxes = [];
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
        else if (ch === 'X') boxes.push({ tx, ty, x: tx * TILE, y: ty * TILE });
        else if (ch !== '.') throw new Error(`level ${def.id}: unknown tile '${ch}' at ${tx},${ty}`);
      }
    });
    if (!spawns.fire || !spawns.water) throw new Error(`level ${def.id}: needs F and W spawns`);
    if (!exits.fire || !exits.water) throw new Error(`level ${def.id}: needs f and w exits`);

    const inBounds = (tx, ty) => tx >= 0 && ty >= 0 && tx < width && ty < height;
    const plates = [], levers = [], gates = [], pulleys = [];
    for (const o of def.objects || []) {
      if (o.type === 'pulley') {
        const [ax, ay] = o.a, [bx, by] = o.b;
        const w = o.w || 3, travel = o.travel || 4;
        const min = o.min !== undefined ? o.min : -travel;
        const max = o.max !== undefined ? o.max : travel;
        if (!inBounds(ax, ay) || !inBounds(bx, by)) throw new Error(`level ${def.id}: pulley out of bounds`);
        if (min > 0 || max < 0 || min === max) throw new Error(`level ${def.id}: pulley needs min <= 0 <= max`);
        pulleys.push({
          a: { tx: ax, ty: ay, x: ax * TILE, y: ay * TILE },
          b: { tx: bx, ty: by, x: bx * TILE, y: by * TILE },
          tw: w, w: w * TILE, minT: min, maxT: max, min: min * TILE, max: max * TILE,
        });
        continue;
      }
      const [tx, ty] = o.at;
      if (!inBounds(tx, ty)) throw new Error(`level ${def.id}: ${o.type} out of bounds`);
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
      tiles, spawns, exits, gems, plates, levers, gates, boxes, pulleys,
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

  function newBox(b) {
    return { x: b.x, y: b.y, w: BOX.size, h: BOX.size, vy: 0, onGround: false };
  }

  // Dynamic per-attempt state: which gems are taken, which gates are open, where the
  // boxes are, how far each pulley has tipped (o > 0: side a lower, side b higher).
  function createLevelState(level) {
    return {
      gems: level.gems.map(() => false),
      plates: level.plates.map(() => false),
      levers: level.levers.map((l) => l.start),
      gates: level.gates.map((g) => g.invert), // inverted gates start open
      boxes: level.boxes.map(newBox),
      pulleys: level.pulleys.map(() => ({ o: 0 })),
      geysers: [], // temporary updrafts (Challenge mode): { x, y, w, h, t }
    };
  }

  // Deep copy, e.g. so the client can predict on its own copy of a snapshot.
  function cloneState(s) {
    return {
      gems: s.gems.slice(),
      plates: s.plates.slice(),
      levers: s.levers.slice(),
      gates: s.gates.slice(),
      boxes: (s.boxes || []).map((b) => ({ x: b.x, y: b.y, w: BOX.size, h: BOX.size, vy: b.vy || 0, onGround: !!b.onGround })),
      pulleys: (s.pulleys || []).map((p) => ({ o: typeof p === 'number' ? p : p.o })),
      geysers: (s.geysers || []).map((g) => ({ ...g })),
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

  // Characters have no w/h fields; boxes do.
  function rectOf(body) {
    return { x: body.x, y: body.y, w: body.w || CHAR.width, h: body.h || CHAR.height };
  }

  function tileRange(r) {
    return {
      tx0: Math.floor(r.x / TILE), tx1: Math.floor((r.x + r.w - EPS) / TILE),
      ty0: Math.floor(r.y / TILE), ty1: Math.floor((r.y + r.h - EPS) / TILE),
    };
  }

  // Current rects of all pulley platforms: [a0, b0, a1, b1, ...]
  function platformRects(level, state) {
    const out = [];
    if (!state || !state.pulleys) return out;
    level.pulleys.forEach((p, i) => {
      const o = state.pulleys[i].o;
      out.push({ x: p.a.x, y: p.a.y + o, w: p.w, h: PULLEY.thickness, pulley: i, side: 'a' });
      out.push({ x: p.b.x, y: p.b.y - o, w: p.w, h: PULLEY.thickness, pulley: i, side: 'b' });
    });
    return out;
  }

  // Solid rects overlapping r: tiles, closed gates, pulley platforms, and `bodies`
  // (other characters and boxes). Body rects carry a reference back to the body.
  function solidsIn(level, r, bodies, state) {
    const out = [];
    const { tx0, tx1, ty0, ty1 } = tileRange(r);
    for (let ty = ty0; ty <= ty1; ty++) {
      for (let tx = tx0; tx <= tx1; tx++) {
        if (isSolid(level, tx, ty)) out.push({ x: tx * TILE, y: ty * TILE, w: TILE, h: TILE });
      }
    }
    if (state) {
      level.gates.forEach((g, i) => { if (!state.gates[i] && overlaps(r, g.rect)) out.push(g.rect); });
      for (const p of platformRects(level, state)) if (overlaps(r, p)) out.push(p);
    }
    for (const b of bodies) {
      const br = rectOf(b);
      if (overlaps(r, br)) { br.body = b; out.push(br); }
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

  const isBox = (b) => !!b.w;

  function inGeyser(state, r) {
    return !!(state && state.geysers && state.geysers.some((g) => overlaps(r, g)));
  }

  // Move along one axis and snap against anything newly hit. Per-step movement is
  // always under one tile (maxFall * DT = 15px < 24px), so a single check is enough.
  // Obstacles already overlapping before the move are ignored so bodies can't get stuck.
  // If `canPush`, boxes in the way are shoved along x (a box can't push another box).
  // Returns { hit, pushed }.
  function moveAxis(level, body, axis, d, bodies, state, canPush) {
    if (!d) return { hit: false, pushed: false };
    const before = rectOf(body);
    body[axis] += d;
    let hits = solidsIn(level, rectOf(body), bodies, state).filter((o) => !overlaps(before, o));
    let pushed = false;
    if (canPush && axis === 'x' && hits.length && hits.every((o) => o.body && isBox(o.body))) {
      const after = rectOf(body);
      for (const o of hits) {
        const box = o.body;
        const need = d > 0 ? after.x + after.w - box.x : after.x - (box.x + box.w);
        const boxOthers = bodies.filter((b) => b !== box).concat([body]);
        const before2 = box.x;
        moveAxis(level, box, 'x', need, boxOthers, state, false);
        if (box.x !== before2) pushed = true;
      }
      hits = solidsIn(level, rectOf(body), bodies, state).filter((o) => !overlaps(before, o));
    }
    if (!hits.length) return { hit: false, pushed };
    const { w, h } = rectOf(body);
    if (axis === 'x') {
      body.x = d > 0 ? Math.min(...hits.map((o) => o.x)) - w : Math.max(...hits.map((o) => o.x + o.w));
    } else {
      body.y = d > 0 ? Math.min(...hits.map((o) => o.y)) - h : Math.max(...hits.map((o) => o.y + o.h));
    }
    return { hit: true, pushed };
  }

  function approach(v, target, amount) {
    return v < target ? Math.min(v + amount, target) : Math.max(v - amount, target);
  }

  // Step one character. input: { left, right }; jumps come from pressJump().
  // `others` are the other characters; boxes and platforms come from `state`.
  function stepBody(level, body, input, others, dt = DT, state = null) {
    const dir = (input.right ? 1 : 0) - (input.left ? 1 : 0);
    if (dir) body.facing = dir;
    const cap = (body.pushing ? CHAR.pushSpeed : CHAR.maxSpeed) * (body.speedMul || 1);
    if (dir) {
      const accel = body.onGround ? CHAR.groundAccel : CHAR.airAccel;
      // Turning around uses friction too, so direction changes feel snappy.
      const turning = Math.sign(body.vx) === -dir;
      body.vx = approach(body.vx, dir * cap, (accel + (turning ? CHAR.friction : 0)) * dt);
    } else {
      body.vx = approach(body.vx, 0, (body.onGround ? CHAR.friction : CHAR.airAccel * 0.5) * dt);
    }

    body.coyoteT = body.onGround ? CHAR.coyote : Math.max(0, body.coyoteT - dt);
    if (body.onGround) body.airJumps = body.maxAirJumps || 0;
    const jumpVel = CHAR.jumpVel * (body.jumpMul || 1);
    if (body.bufferT > 0 && body.coyoteT > 0) {
      body.vy = -jumpVel;
      body.bufferT = 0;
      body.coyoteT = 0;
    } else if (body.bufferT > 0 && !body.onGround && body.airJumps > 0 && !(body.flyT > 0)) {
      body.vy = -jumpVel; // double jump
      body.airJumps--;
      body.bufferT = 0;
    }
    body.bufferT = Math.max(0, body.bufferT - dt);

    if (body.flyT > 0) {
      body.flyT = Math.max(0, body.flyT - dt);
      body.vy = approach(body.vy, -FLY.speed, FLY.accel * dt);
    } else if (touchesTile(level, rectOf(body), T.FAN) || inGeyser(state, rectOf(body))) body.vy = approach(body.vy, -FAN.speed, FAN.accel * dt);
    else body.vy = Math.min(body.vy + CHAR.gravity * dt, CHAR.maxFall);

    const bodies = others.concat(state && state.boxes ? state.boxes : []);
    const mx = moveAxis(level, body, 'x', body.vx * dt, bodies, state, true);
    body.pushing = mx.pushed;
    if (mx.pushed) body.vx = Math.max(-CHAR.pushSpeed, Math.min(CHAR.pushSpeed, body.vx));
    else if (mx.hit) body.vx = 0;
    const my = moveAxis(level, body, 'y', body.vy * dt, bodies, state, false);
    body.onGround = my.hit && body.vy > 0;
    if (my.hit) body.vy = 0;
  }

  // Does body b rest on top of rect s?
  function restsOn(b, s) {
    const r = rectOf(b);
    return Math.abs(r.y + r.h - s.y) < 0.75 && r.x < s.x + s.w - EPS && r.x + r.w > s.x + EPS;
  }

  // Everything resting on rect s, directly or stacked (box on platform, character on box…).
  function ridersOf(s, all) {
    const out = [];
    const frontier = [s];
    while (frontier.length) {
      const surface = frontier.pop();
      for (const b of all) {
        if (out.includes(b) || !restsOn(b, surface)) continue;
        out.push(b);
        frontier.push(rectOf(b));
      }
    }
    return out;
  }

  // Would rect r overlap any tile, closed gate, or body not in `ignore`?
  function blocked(level, r, all, state, ignore, ignorePlatform) {
    return solidsIn(level, r, all.filter((b) => !ignore.includes(b)), state)
      .some((o) => !(o.pulley === ignorePlatform.pulley && o.side === ignorePlatform.side));
  }

  // Tip each pulley toward its heavier side, carrying whatever rides on the platforms.
  function stepPulleys(level, state, chars, dt) {
    const all = chars.concat(state.boxes);
    level.pulleys.forEach((p, i) => {
      const ps = state.pulleys[i];
      const plats = platformRects(level, state).filter((r) => r.pulley === i);
      const [A, B] = plats;
      const ra = ridersOf(A, all), rb = ridersOf(B, all);
      const dir = Math.sign(ra.length - rb.length);
      if (!dir) return;
      const target = Math.max(p.min, Math.min(p.max, ps.o + dir * PULLEY.speed * dt));
      const d = target - ps.o;
      if (!d) return;
      // A moves by +d, B by -d. Check both before moving anything.
      const moves = [[A, ra, d], [B, rb, -d]];
      const riders = ra.concat(rb);
      for (const [plat, rs, dy] of moves) {
        const np = { x: plat.x, y: plat.y + dy, w: plat.w, h: plat.h };
        if (blocked(level, np, all, state, riders, plat)) return;
        for (const b of rs) {
          const r = rectOf(b);
          r.y += dy;
          if (blocked(level, r, all, state, riders, plat) || overlaps(r, np)) return;
        }
      }
      ps.o = target;
      for (const [, rs, dy] of moves) for (const b of rs) b.y += dy;
    });
  }

  // Boxes fall under gravity and land on anything solid.
  function stepBoxes(level, state, chars, dt) {
    for (const box of state.boxes) {
      box.vy = Math.min(box.vy + CHAR.gravity * dt, CHAR.maxFall);
      const others = chars.concat(state.boxes.filter((b) => b !== box));
      const my = moveAxis(level, box, 'y', box.vy * dt, others, state, false);
      box.onGround = my.hit && box.vy > 0;
      if (my.hit) box.vy = 0;
    }
  }

  // Plates, levers and gates. Plates are pressed by characters and boxes.
  function updateMechanisms(level, state, bodies) {
    const rects = bodies.map(rectOf);
    const heavy = rects.concat((state.boxes || []).map(rectOf));
    level.plates.forEach((p, i) => { state.plates[i] = heavy.some((r) => overlaps(r, p.rect)); });
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
      // A gate never closes on top of a character or a box.
      if (!open && heavy.some((r) => overlaps(r, g.rect))) return;
      state.gates[i] = open;
    });
  }

  // Everything in the world except the characters' own movement, once per tick:
  // switches, pulleys (which carry riders), and falling boxes.
  function stepEnv(level, state, chars, dt = DT) {
    if (state.geysers && state.geysers.length) {
      for (const g of state.geysers) g.t -= dt;
      state.geysers = state.geysers.filter((g) => g.t > 0);
    }
    updateMechanisms(level, state, chars);
    stepPulleys(level, state, chars, dt);
    stepBoxes(level, state, chars, dt);
  }

  function isDeadly(type, element) {
    return type === T.ACID || (type === T.LAVA && element === 'water') || (type === T.WATER && element === 'fire');
  }

  // Returns the deadly tile type under the character's feet, or 0. A few pixels at
  // each edge are forgiven so brushing a pool's corner isn't fatal.
  function hazardUnder(level, body, element) {
    if (!body.onGround) return 0;
    const feet = body.y + CHAR.height;
    if (Math.abs(feet - Math.round(feet / TILE) * TILE) > 0.5) return 0; // on a box or platform, not a tile
    const ty = Math.round(feet / TILE);
    const tx0 = Math.floor((body.x + 4) / TILE), tx1 = Math.floor((body.x + CHAR.width - 4) / TILE);
    for (let tx = tx0; tx <= tx1; tx++) {
      const t = tileAt(level, tx, ty);
      if (t === T.ACID && body.acidImmune) continue;
      if (isDeadly(t, element)) return t;
    }
    return 0;
  }

  // Indices of gems newly collected by this body.
  function collectGems(level, state, body, element) {
    const r = rectOf(body);
    const m = body.magnet || 0;
    const got = [];
    level.gems.forEach((g, i) => {
      if (state.gems[i] || g.el !== element) return;
      const gr = { x: g.tx * TILE + 4 - m, y: g.ty * TILE + 4 - m, w: TILE - 8 + 2 * m, h: TILE - 8 + 2 * m };
      if (overlaps(r, gr)) { state.gems[i] = true; got.push(i); }
    });
    return got;
  }

  // The door as drawn: two tiles tall (the exit cell and the one above) plus a 2px frame.
  function doorRect(level, element) {
    const e = level.exits[element];
    return { x: e.tx * TILE - 2, y: (e.ty - 1) * TILE - 2, w: TILE + 4, h: TILE * 2 + 2 };
  }

  // Any part of the character touching any part of its door counts (edges included).
  function atExit(level, body, element) {
    const r = rectOf(body), d = doorRect(level, element);
    return r.x <= d.x + d.w && r.x + r.w >= d.x && r.y <= d.y + d.h && r.y + r.h >= d.y;
  }

  // One full tick: environment, then every character in a fixed order (each treats
  // the others as solid).
  function stepWorld(level, bodies, inputs, dt = DT, state = null) {
    if (state) stepEnv(level, state, bodies, dt);
    bodies.forEach((b, i) => stepBody(level, b, inputs[i], bodies.filter((_, j) => j !== i), dt, state));
  }

  return {
    TILE, DT, CHAR, FAN, FLY, BOX, PULLEY, T,
    parseLevel, tileAt, isSolid, isDeadly, createLevelState, cloneState, createBody, pressJump,
    stepBody, stepWorld, stepEnv, updateMechanisms, platformRects, hazardUnder, collectGems, atExit, doorRect,
  };
});
