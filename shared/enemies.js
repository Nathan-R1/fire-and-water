// Challenge mode enemy motion, shared by server (rules) and client (prediction).
//
// The parts of the enemies that follow fixed rules live here: how flyers, walkers,
// patrols and bombers move, how shots and bombs fly, and the boss-2 acid and weather
// clocks. The server runs them as the real thing; the client runs the same code to
// predict them forward to the moment your own (predicted) character is at, so they line
// up with you exactly. Decisions that depend on the players or on chance (when a bomber
// drops, when the turret fires, where the burrower surfaces, the charger) stay on the
// server; the client shows those enemies smoothed between snapshots instead.

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./physics'));
  else root.Enemies = factory(root.Physics);
})(typeof self !== 'undefined' ? self : this, function (P) {
  const T = P.TILE;

  // Enemies the client predicts (the rest are interpolated between snapshots).
  const PREDICTED = new Set(['sentry', 'flyer', 'walker', 'patrol', 'bomber', 'mimic', 'shooter']);

  const SHOT_SIZE = 10;  // enemy shots and bombs
  const GUN_SIZE = 8;    // Blaster shots
  const MIMIC = { shakeEvery: 5, shake: 0.6 };
  // Boss 2's acid floor: a 3 s countdown, then all ground burns for 0.1 s.
  const ACID = { period: 9, countdown: 3, burn: 0.1, firstAt: 4 };
  // Weather (rooms 6–10): after 10–20 s, then again 10–20 s after each one ends, a 5 s
  // lead-in, then the strike. Times are real seconds (Slow Time doesn't slow weather).
  const WEATHER = {
    firstMin: 10, firstMax: 20, gapMin: 10, gapMax: 20, lead: 5,
    drought: 0.5, rain: 1, rise: 1.5, hold: 5, drain: 1,
    depth: 2, // the flood rises this many tiles above the lowest floor you can stand on
  };

  const overlaps = (a, b) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;

  function enemyRect(e) {
    if (e.type === 'walker') return { x: e.x, y: e.floor - e.size, w: e.size, h: e.size };
    return { x: e.x, y: e.y, w: e.w, h: e.h };
  }
  function liveRect(e) {
    return e.type === 'flyer' ? { x: e.x, y: e.yNow ?? e.y, w: e.w, h: e.h } : enemyRect(e);
  }

  // Everything solid overlapping r: rock and pools, closed gates, pulley platforms,
  // boxes and mimics. `state` is the level state (server's, or the client's predicted).
  function blockedRects(level, state, r) {
    const out = [];
    const tx0 = Math.floor(r.x / T), tx1 = Math.floor((r.x + r.w - 0.001) / T);
    const ty0 = Math.floor(r.y / T), ty1 = Math.floor((r.y + r.h - 0.001) / T);
    for (let ty = ty0; ty <= ty1; ty++) for (let tx = tx0; tx <= tx1; tx++) if (P.isSolid(level, tx, ty)) out.push({ x: tx * T, y: ty * T, w: T, h: T });
    level.gates.forEach((g, i) => { if (!state.gates[i] && overlaps(r, g.rect)) out.push(g.rect); });
    for (const p of P.platformRects(level, state)) if (overlaps(r, p)) out.push(p);
    for (const b of (state.boxes || []).concat(state.blocks || [])) if (overlaps(r, b)) out.push(b);
    return out;
  }

  // Walkers turn around instead of walking into boxes, mimics, closed gates, pulley
  // platforms or rock. Only new contact counts, so one a box was pushed into can leave.
  function walk(level, state, e, dt) {
    const now = enemyRect(e);
    const next = { ...now, x: now.x + e.dir * e.speed * dt };
    if (blockedRects(level, state, next).some((o) => !overlaps(now, o))) { e.dir = -e.dir; return; }
    e.x = next.x;
  }

  // Move one enemy by its fixed rules. `time` is the run's enemy clock (after this tick).
  // Returns false while it's stunned (frozen), so the caller skips its decisions too.
  function move(e, dt, time, level, state) {
    if (e.stunT > 0) { e.stunT -= dt; return false; }
    if (e.type === 'flyer') {
      e.x += e.dir * e.speed * dt;
      if (e.x < e.x0) { e.x = e.x0; e.dir = 1; } else if (e.x > e.x1) { e.x = e.x1; e.dir = -1; }
      e.yNow = e.y + Math.sin(time * 1.7) * e.amp; // e.y is the centre line
    } else if (e.type === 'walker') {
      e.size = e.size0 + (e.size1 - e.size0) * Math.min(1, time / e.grow);
      walk(level, state, e, dt);
      if (e.x < e.x0) { e.x = e.x0; e.dir = 1; } else if (e.x + e.size > e.x1) { e.x = e.x1 - e.size; e.dir = -1; }
    } else if (e.type === 'patrol') {
      walk(level, state, e, dt);
      if (e.x < e.x0) { e.x = e.x0; e.dir = 1; } else if (e.x > e.x1) { e.x = e.x1; e.dir = -1; }
    } else if (e.type === 'bomber') {
      e.x += e.dir * e.speed * dt;
      if (e.x < e.x0) { e.x = e.x0; e.dir = 1; } else if (e.x > e.x1) { e.x = e.x1; e.dir = -1; }
      e.cool = Math.max(0, (e.cool ?? 0) - dt);
    } else if (e.type === 'mimic') {
      e.shakeT = (e.shakeT + dt) % MIMIC.shakeEvery;
    }
    return true;
  }

  // Did something moving from (x0, y0) to (x1, y1) hit anything solid on the way? The
  // check covers the whole distance, so a fast bomb can't skip through a thin platform.
  function hitsSolid(level, state, x0, y0, x1, y1, size) {
    return blockedRects(level, state, {
      x: Math.min(x0, x1), y: Math.min(y0, y1), w: Math.abs(x1 - x0) + size, h: Math.abs(y1 - y0) + size,
    }).length > 0;
  }

  // Enemy shots and bombs: fly (bombs fall), and stop at anything solid or off screen.
  function stepShots(shots, dt, level, state) {
    return shots.filter((sh) => {
      if (sh.g) sh.vy += sh.g * dt;
      const x0 = sh.x, y0 = sh.y;
      sh.x += sh.vx * dt; sh.y += sh.vy * dt;
      return !hitsSolid(level, state, x0, y0, sh.x, sh.y, SHOT_SIZE) && sh.x > -50 && sh.x < level.pxWidth + 50 && sh.y < level.pxHeight + 50;
    });
  }

  // Blaster shots: fly straight for their range; stop at anything solid. (Hitting
  // enemies is the server's call.) Returns the ones still flying.
  function stepBullets(bullets, dt, level, state) {
    return bullets.filter((b) => {
      const bx0 = b.x;
      b.x += b.vx * dt; b.left -= Math.abs(b.vx * dt);
      return b.left > 0 && !hitsSolid(level, state, bx0, b.y, b.x, b.y, GUN_SIZE);
    });
  }

  // The acid floor's clock. Returns 'countdown' or 'acid' on the tick each one starts.
  function stepAcid(a, dt) {
    if (a.burning > 0) {
      a.burning -= dt;
      if (a.burning <= 0) a.next = ACID.period - ACID.countdown - ACID.burn;
    } else if (a.countdown > 0) {
      a.countdown -= dt;
      if (a.countdown <= 0) { a.burning = ACID.burn; return 'acid'; }
    } else {
      a.next -= dt;
      if (a.next <= 0) { a.countdown = ACID.countdown; return 'countdown'; }
    }
    return null;
  }

  // The weather's clock: idle → lead-in → strike → idle. `gap()` gives the next quiet
  // spell (the server rolls it; the client doesn't know it, so it waits for the server).
  // Returns 'lead' on the tick a lead-in starts. Also updates the flood's surface.
  function stepWeather(w, dt, pxHeight, gap) {
    w.t += dt;
    let started = null;
    if (w.t >= w.dur) {
      const next = (state, dur) => { w.state = state; w.t = 0; w.dur = dur; };
      if (w.state === 'idle') { next('lead', WEATHER.lead); started = 'lead'; }
      else if (w.state === 'lead') next('strike', w.kind === 'flood' ? WEATHER.rise + WEATHER.hold + WEATHER.drain : WEATHER[w.kind]);
      else next('idle', gap());
    }
    w.level = floodLevel(w, pxHeight);
    return started;
  }

  // Where the flood's surface is (pixels from the top); the room's floor when there's none.
  function floodLevel(w, pxHeight) {
    if (w.kind !== 'flood' || w.state !== 'strike') return pxHeight;
    const bottom = pxHeight - T;
    const k = w.t < WEATHER.rise ? w.t / WEATHER.rise : w.t < WEATHER.rise + WEATHER.hold ? 1 : Math.max(0, (w.dur - w.t) / WEATHER.drain);
    return bottom - k * (bottom - w.floodY);
  }

  // Client prediction: advance a copy of a snapshot's run (enemies, shots, bullets,
  // acid, weather, time, slow, started) by one physics step, in the same order and with
  // the same clocks as the server's updateEnemies. Only the fixed-rule parts: firing,
  // bomb drops, burrowers, chargers and who gets hit stay the server's call. `state` is
  // the client's predicted level state (boxes, gates…), so walkers turn where you see.
  function predict(pr, dt, level, state) {
    if (!pr.started) return; // enemies and the clock wait until someone moves
    const edt = dt * (pr.slow || 1); // Slow Time slows enemies, shots and the acid
    pr.time += edt;
    for (const e of pr.enemies) if (!e.dead && PREDICTED.has(e.type)) move(e, edt, pr.time, level, state);
    pr.shots = stepShots(pr.shots, edt, level, state);
    pr.bullets = stepBullets(pr.bullets, dt, level, state);
    if (pr.acid) stepAcid(pr.acid, edt);
    // The next quiet spell is rolled on the server: wait for it rather than guess.
    if (pr.weather) stepWeather(pr.weather, dt, level.pxHeight, () => Infinity);
  }

  // What the client draws for an enemy.
  function view(e) {
    const r = liveRect(e);
    return {
      id: e.id, type: e.type, x: r.x, y: r.y, w: r.w, h: r.h, stun: e.stunT > 0,
      phase: e.phase, shake: e.type === 'mimic' && e.shakeT > MIMIC.shakeEvery - MIMIC.shake, mode: e.mode, dir: e.dir,
    };
  }

  return {
    PREDICTED, SHOT_SIZE, GUN_SIZE, MIMIC, ACID, WEATHER,
    overlaps, enemyRect, liveRect, blockedRects, walk, move, hitsSolid,
    stepShots, stepBullets, stepAcid, stepWeather, floodLevel, predict, view,
  };
});
