// Level sanity checker. Approximates what each character can reach on the tile grid
// (walk, jump, fall, partner boost, fans) and reports levels where an exit, gem or
// switch can't be reached. It's a coarse model, not a proof of solvability:
// gates are assumed openable and partner boosts are allowed anywhere. Playtest anyway.
//
// Usage: node tools/levelcheck.js [levels/NN-name.json ...]

const P = require('../shared/physics');
const { T } = P;

// Max horizontal cell distance for a jump that rises dy tiles (from the physics:
// ~87px jump height, 180px/s run speed). 4 = only possible with a partner boost.
const REACH = { 0: 4, 1: 4, 2: 4, 3: 3, 4: 2 };

function analyse(def) {
  const level = P.parseLevel(def);
  const errors = [];
  const info = [];

  const gateCells = new Set();
  for (const g of level.gates) {
    for (let y = g.ty; y < g.ty + g.th; y++) for (let x = g.tx; x < g.tx + g.tw; x++) gateCells.add(`${x},${y}`);
  }

  function reach(element, { boost, gatesSolid }) {
    const tile = (x, y) => P.tileAt(level, x, y);
    const solid = (x, y) => P.isSolid(level, x, y) || (gatesSolid && gateCells.has(`${x},${y}`));
    const empty = (x, y) => !solid(x, y);
    const clear = (x, y) => empty(x, y) && empty(x, y - 1);
    const fanAt = (x, y) => tile(x, y) === T.FAN || tile(x, y - 1) === T.FAN;
    const stand = (x, y) => clear(x, y) && solid(x, y + 1) && !fanAt(x, y);
    const safe = (x, y) => !P.isDeadly(tile(x, y + 1), element);

    const seen = new Set();
    const fanCells = new Set(); // cells passed through while riding a fan
    const queue = [];
    const add = (x, y) => {
      const k = `${x},${y}`;
      if (seen.has(k) || !stand(x, y) || !safe(x, y)) return;
      seen.add(k);
      queue.push([x, y]);
    };

    // Drop down a column from (x, y) and land, or ride a fan if one catches you.
    function fall(x, y) {
      for (let yy = y; yy < level.height; yy++) {
        if (!clear(x, yy)) return;
        if (fanAt(x, yy)) return ride(x, yy);
        if (stand(x, yy)) return add(x, yy);
      }
    }

    // Ride a fan column up to its top, then step off to either side.
    const ridden = new Set();
    function ride(x, y) {
      if (ridden.has(`${x},${y}`)) return;
      ridden.add(`${x},${y}`);
      let top = tile(x, y) === T.FAN ? y : y - 1;
      while (!solid(x, top - 1) && (tile(x, top - 1) === T.FAN || tile(x, top - 2) === T.FAN)) top--; // 1-tile gaps (gems, gates) do not stop the lift
      for (let yy = top; yy <= y; yy++) fanCells.add(`${x},${yy}`);
      const hover = top - 1; // feet hover around the top edge of the fan
      for (const d of [-1, 1]) {
        for (let k = 1; k <= 3; k++) {
          const nx = x + d * k;
          if (!clear(nx, hover)) break;
          if (stand(nx, hover)) { add(nx, hover); break; }
          if (tile(nx, hover) === T.FAN || tile(nx, hover - 1) === T.FAN) { ride(nx, hover); break; }
          fall(nx, hover + 1);
        }
      }
    }

    const sp = level.spawns[element];
    const sx = Math.floor((sp.x + P.CHAR.width / 2) / P.TILE);
    const sy = Math.floor((sp.y + P.CHAR.height - 1) / P.TILE);
    if (!stand(sx, sy)) errors.push(`${element} spawn (${sx},${sy}) is not on solid ground`);
    add(sx, sy);

    const maxUp = boost ? 4 : 3;
    while (queue.length) {
      const [x, y] = queue.shift();
      for (const d of [-1, 1]) {
        // walk, or walk off an edge / into a fan
        const nx = x + d;
        if (clear(nx, y)) {
          if (stand(nx, y)) add(nx, y);
          else if (fanAt(nx, y)) ride(nx, y);
          else for (let k = 0; k <= 2; k++) { if (!clear(x + d * (1 + k), y)) break; fall(x + d * (1 + k), y); }
        }
        // jumps: up to maxUp tiles up, sideways by REACH[dy]
        for (let dy = 0; dy <= maxUp; dy++) {
          let headroom = true;
          for (let k = 1; k <= dy + 1; k++) if (!empty(x, y - k)) headroom = false;
          if (!headroom) break;
          for (let dx = 1; dx <= REACH[dy]; dx++) {
            const tx = x + d * dx, ty = y - dy;
            if (!empty(tx, ty) || !empty(tx, ty - 1)) break; // something in the way at the top of the arc
            if (stand(tx, ty)) add(tx, ty);
            else if (fanAt(tx, ty)) ride(tx, ty);
            else if (dy === 0) fall(tx, ty);
          }
        }
        // straight up (e.g. onto a ledge directly above with an open edge) is covered by dx=1
      }
    }
    return { nodes: seen, fanCells };
  }

  function gemReachable(g, r) {
    if (r.fanCells.has(`${g.tx},${g.ty}`)) return true;
    for (const k of r.nodes) {
      const [x, y] = k.split(',').map(Number);
      if (Math.abs(x - g.tx) <= 2 && g.ty >= y - 3 && g.ty <= y) return true;
    }
    return false;
  }

  const result = {};
  for (const el of ['fire', 'water']) {
    const coop = reach(el, { boost: true, gatesSolid: false });
    const solo = reach(el, { boost: false, gatesSolid: false });
    const locked = reach(el, { boost: true, gatesSolid: true });
    result[el] = coop;
    const e = level.exits[el];
    const ek = `${e.tx},${e.ty}`;
    if (!coop.nodes.has(ek)) errors.push(`${el} exit (${e.tx},${e.ty}) unreachable`);
    else {
      if (!solo.nodes.has(ek)) info.push(`${el} needs a partner boost`);
      if (locked.nodes.has(ek) && level.gates.length) info.push(`${el} exit reachable without opening any gate`);
    }
    level.gems.forEach((g) => {
      if (g.el === el && !gemReachable(g, coop)) errors.push(`${el} gem (${g.tx},${g.ty}) unreachable`);
    });
  }

  const triggers = [...level.plates.map((p) => ['plate', p]), ...level.levers.map((l) => ['lever', l])];
  for (const [kind, t] of triggers) {
    const k = `${t.tx},${t.ty}`;
    if (!result.fire.nodes.has(k) && !result.water.nodes.has(k)) errors.push(`${kind} ch${t.ch} at (${t.tx},${t.ty}) unreachable`);
    if (!level.gates.some((g) => g.ch === t.ch)) errors.push(`${kind} ch${t.ch} controls no gate`);
  }
  for (const g of level.gates) {
    if (!triggers.some(([, t]) => t.ch === g.ch)) errors.push(`gate ch${g.ch} has no plate or lever`);
  }
  for (const el of ['fire', 'water']) {
    const e = level.exits[el];
    if (!P.isSolid(level, e.tx, e.ty + 1)) errors.push(`${el} exit has no floor`);
  }

  return { errors, info };
}

module.exports = { analyse };

if (require.main === module) {
  const fs = require('fs');
  const path = require('path');
  const dir = path.join(__dirname, '..', 'levels');
  const files = process.argv.slice(2).length
    ? process.argv.slice(2)
    : fs.readdirSync(dir).filter((f) => /^\d{2}-.*\.json$/.test(f)).sort().map((f) => path.join(dir, f));
  let bad = 0;
  for (const f of files) {
    const def = JSON.parse(fs.readFileSync(f, 'utf8'));
    let r;
    try { r = analyse(def); } catch (e) { r = { errors: [e.message], info: [] }; }
    const tag = r.errors.length ? 'FAIL' : 'ok  ';
    if (r.errors.length) bad++;
    console.log(`${tag} ${path.basename(f)}  ${def.name}${r.info.length ? `  [${r.info.join('; ')}]` : ''}`);
    for (const e of r.errors) console.log(`       - ${e}`);
  }
  process.exitCode = bad ? 1 : 0;
}
