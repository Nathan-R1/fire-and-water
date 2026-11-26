// Deterministic platformer physics shared by server (Node) and client (browser).
// Units: pixels and seconds. Always stepped with the fixed DT.

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

  // Level def: { rows: ["#####", "#F.W#", ...] }  '#' solid, F/W spawns, anything else empty.
  function parseLevel(def) {
    const height = def.rows.length;
    const width = def.rows[0].length;
    const solid = new Uint8Array(width * height);
    const spawns = {};
    def.rows.forEach((row, ty) => {
      if (row.length !== width) throw new Error(`level ${def.id}: row ${ty} has length ${row.length}, expected ${width}`);
      for (let tx = 0; tx < width; tx++) {
        const ch = row[tx];
        if (ch === '#') solid[ty * width + tx] = 1;
        else if (ch === 'F') spawns.fire = spawnAt(tx, ty);
        else if (ch === 'W') spawns.water = spawnAt(tx, ty);
      }
    });
    if (!spawns.fire || !spawns.water) throw new Error(`level ${def.id}: needs F and W spawns`);
    return { id: def.id, name: def.name, width, height, pxWidth: width * TILE, pxHeight: height * TILE, solid, spawns };
  }

  // Spawn standing on the bottom of the marker tile, centred horizontally.
  function spawnAt(tx, ty) {
    return { x: tx * TILE + (TILE - CHAR.width) / 2, y: (ty + 1) * TILE - CHAR.height };
  }

  function isSolid(level, tx, ty) {
    if (tx < 0 || tx >= level.width || ty < 0 || ty >= level.height) return true;
    return level.solid[ty * level.width + tx] === 1;
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

  // Solid rects (tiles + other characters) overlapping r.
  function solidsIn(level, r, others) {
    const out = [];
    const tx0 = Math.floor(r.x / TILE), tx1 = Math.floor((r.x + r.w - EPS) / TILE);
    const ty0 = Math.floor(r.y / TILE), ty1 = Math.floor((r.y + r.h - EPS) / TILE);
    for (let ty = ty0; ty <= ty1; ty++) {
      for (let tx = tx0; tx <= tx1; tx++) {
        if (isSolid(level, tx, ty)) out.push({ x: tx * TILE, y: ty * TILE, w: TILE, h: TILE });
      }
    }
    for (const o of others) {
      const or = rectOf(o);
      if (overlaps(r, or)) out.push(or);
    }
    return out;
  }

  // Move along one axis and snap against anything newly hit. Per-step movement is
  // always under one tile (maxFall * DT = 15px < 24px), so a single check is enough.
  // Obstacles already overlapping before the move are ignored so bodies can't get stuck.
  function moveAxis(level, body, axis, d, others) {
    if (!d) return false;
    const before = rectOf(body);
    body[axis] += d;
    const after = rectOf(body);
    const hits = solidsIn(level, after, others).filter((o) => !overlaps(before, o));
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
  function stepBody(level, body, input, others, dt = DT) {
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

    body.vy = Math.min(body.vy + CHAR.gravity * dt, CHAR.maxFall);

    if (moveAxis(level, body, 'x', body.vx * dt, others)) body.vx = 0;
    const hitY = moveAxis(level, body, 'y', body.vy * dt, others);
    body.onGround = hitY && body.vy > 0;
    if (hitY) body.vy = 0;
  }

  // Step every body in a fixed order; each treats the others as solid.
  function stepWorld(level, bodies, inputs, dt = DT) {
    bodies.forEach((b, i) => stepBody(level, b, inputs[i], bodies.filter((_, j) => j !== i), dt));
  }

  return { TILE, DT, CHAR, parseLevel, isSolid, createBody, pressJump, stepBody, stepWorld };
});
