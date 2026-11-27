// Generator for levels 33–64 (boxes and pulleys). The JSON files it writes are the
// source of truth; this script is kept so the drafts can be regenerated while tuning.
// Usage: node tools/gen-levels-33-64.js
//
// Geometry cheat sheet (40×23 tiles, floor top at row 21, so you stand in row 20):
//   jump: up 3 tiles, or 4 with a boost (partner or box); across 4 tiles on the flat
//   ground(x0, x1, top): solid from row `top` down to the floor; you stand in row top-1
//   pulley: side a sinks by up to `max` tiles and rises by up to -`min`; side b mirrors it

const fs = require('fs');
const path = require('path');
const OUT = path.join(__dirname, '..', 'levels');
const W = 40, H = 23;

function level(num, slug, name, world, build) {
  const g = Array.from({ length: H }, (_, y) => Array.from({ length: W }, (_, x) =>
    (x === 0 || x === W - 1 || y === 0 || y >= 21) ? '#' : '.'));
  const objects = [];
  const L = {
    rect(x0, y0, x1, y1, ch = '#') { for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) g[y][x] = ch; },
    clear(x0, y0, x1, y1) { L.rect(x0, y0, x1, y1, '.'); },
    ground(x0, x1, top) { L.rect(x0, top, x1, 20); },
    plat(x0, x1, y) { L.rect(x0, y, x1, y); },
    wall(x, y0, y1) { L.rect(x, y0, x, y1); },
    pool(x0, x1, y, ch) { L.rect(x0, y, x1, y, ch); },
    fan(x0, x1, y0, y1) { L.rect(x0, y0, x1, y1, '^'); },
    put(x, y, ch) { g[y][x] = ch; },
    box(x, y) { g[y][x] = 'X'; },
    plate(x, y, ch) { objects.push({ type: 'plate', at: [x, y], ch }); },
    lever(x, y, ch, opts = {}) { objects.push({ type: 'lever', at: [x, y], ch, ...opts }); },
    gate(x, y, w, h, ch, invert = false) {
      for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) if (g[yy][xx] === '#') g[yy][xx] = '.';
      objects.push({ type: 'gate', at: [x, y], size: [w, h], ch, ...(invert ? { invert: true } : {}) });
    },
    pulley(a, b, w, min, max) {
      // carve the shafts the platforms move through
      for (const [[x, y], sign] of [[a, 1], [b, -1]]) {
        const lo = Math.min(y + sign * min, y + sign * max), hi = Math.max(y + sign * min, y + sign * max);
        for (let yy = Math.max(1, lo); yy <= Math.min(20, hi); yy++) for (let xx = x; xx < x + w; xx++) if (g[yy][xx] === '#') g[yy][xx] = '.';
      }
      objects.push({ type: 'pulley', a, b, w, min, max });
    },
    // A tunnel only one element survives: a pool floor under a 2-tile-high ceiling,
    // too long to jump across. el: 'L' (fire only) or '~' (water only).
    tunnel(x0, x1, floorRow, el) {
      L.rect(x0, floorRow - 3, x1, floorRow - 3); // ceiling
      L.clear(x0, floorRow - 2, x1, floorRow - 1);
      L.pool(x0, x1, floorRow, el);
    },
  };
  build(L);
  const id = `${String(num).padStart(2, '0')}-${slug}`;
  const def = { id, name, world, rows: g.map((r) => r.join('')), objects };
  const json = JSON.stringify(def, null, 2).replace(/\[\n\s+(-?\d+),\n\s+(-?\d+)\n\s+\]/g, '[$1, $2]');
  fs.writeFileSync(path.join(OUT, `${id}.json`), json + '\n');
}

// ───────────── World 5: Crate Works (boxes) ─────────────

level(33, 'first-crate', 'First Crate', 5, (L) => {
  L.put(2, 20, 'F'); L.put(4, 20, 'W');
  L.box(10, 20);
  L.ground(20, 38, 17); // 4 tiles up: stand on the box to climb
  L.put(13, 18, 'r'); L.put(15, 18, 'b');
  L.put(24, 14, 'r'); L.put(27, 14, 'b');
  L.put(32, 16, 'f'); L.put(35, 16, 'w');
});

level(34, 'hold-the-door', 'Hold the Door', 5, (L) => {
  L.put(2, 20, 'F'); L.put(4, 20, 'W');
  L.box(8, 20);
  L.plate(12, 20, 1);
  L.wall(20, 1, 16); L.gate(20, 17, 1, 4, 1);
  L.pool(24, 25, 21, 'L'); L.put(24, 18, 'b');
  L.pool(29, 30, 21, '~'); L.put(30, 18, 'r');
  L.put(34, 20, 'f'); L.put(36, 20, 'w');
});

level(35, 'stairway', 'Crate Stairway', 5, (L) => {
  L.put(2, 20, 'F'); L.put(4, 20, 'W');
  L.pool(7, 9, 21, 'L'); L.put(8, 18, 'b');
  L.pool(12, 13, 21, '~'); L.put(12, 18, 'r');
  L.ground(17, 22, 18); L.box(19, 17);   // a step with a box on it
  L.ground(23, 38, 14);                  // 4 above the step: push the box to the wall and climb
  L.put(28, 11, 'r'); L.put(31, 11, 'b');
  L.put(34, 13, 'f'); L.put(36, 13, 'w');
});

level(36, 'wedge-it', 'Wedge It', 5, (L) => {
  L.put(2, 20, 'F'); L.put(4, 20, 'W');
  L.plate(9, 20, 1); L.box(13, 20);
  L.wall(16, 1, 16); L.gate(16, 17, 1, 4, 1);       // wedge the box in the doorway
  L.pool(19, 20, 21, 'L'); L.put(19, 18, 'b');
  L.plate(23, 20, 2); L.box(26, 20);
  L.wall(29, 1, 16); L.gate(29, 17, 1, 4, 2);
  L.pool(32, 33, 21, '~'); L.put(33, 18, 'r');
  L.put(35, 20, 'f'); L.put(37, 20, 'w');
});

level(37, 'special-delivery', 'Special Delivery', 5, (L) => {
  L.put(2, 20, 'F'); L.put(4, 20, 'W');
  L.plat(1, 9, 15);                 // a shelf over the start…
  L.plat(10, 12, 18);               // …reached by this step
  L.box(8, 14);                     // push it off the shelf onto the plate below
  L.plate(10, 17, 1);
  L.plate(11, 20, 1);
  L.wall(20, 1, 16); L.gate(20, 17, 1, 4, 1);
  L.put(3, 13, 'r'); L.put(5, 13, 'b');
  L.pool(25, 27, 21, 'L'); L.put(26, 18, 'b');
  L.pool(30, 31, 21, '~'); L.put(30, 18, 'r');
  L.put(35, 20, 'f'); L.put(37, 20, 'w');
});

level(38, 'box-train', 'Box Train', 5, (L) => {
  L.put(2, 20, 'F'); L.put(3, 20, 'W');
  L.box(6, 20); L.plate(8, 20, 1);
  L.box(11, 20);
  L.wall(14, 1, 16); L.gate(14, 17, 1, 4, 1);
  L.plate(19, 20, 2);
  L.wall(24, 1, 16); L.gate(24, 17, 1, 4, 2);
  L.pool(27, 28, 21, 'L'); L.put(27, 18, 'b');
  L.pool(31, 32, 21, '~'); L.put(32, 18, 'r');
  L.put(35, 20, 'f'); L.put(37, 20, 'w');
  L.put(17, 18, 'r'); L.put(21, 18, 'b');
});

level(39, 'crate-divide', 'Crate Divide', 5, (L) => {
  L.rect(19, 1, 20, 20);
  // left: fire
  L.put(2, 20, 'F');
  L.pool(5, 7, 21, '~'); L.put(6, 18, 'r');
  L.box(10, 20);
  L.ground(14, 18, 17); L.put(17, 16, 'f'); L.put(15, 13, 'r');
  // right: water
  L.put(37, 20, 'W');
  L.pool(32, 34, 21, 'L'); L.put(33, 18, 'b');
  L.box(29, 20);
  L.ground(21, 25, 17); L.put(22, 16, 'w'); L.put(24, 13, 'b');
});

level(40, 'crate-escape', 'Crate Escape', 5, (L) => {
  L.put(2, 20, 'F'); L.put(4, 20, 'W');
  L.box(7, 20); L.plate(10, 20, 1);
  L.wall(13, 1, 16); L.gate(13, 17, 1, 4, 1);
  L.pool(16, 17, 21, 'A');
  L.box(21, 20);
  L.ground(25, 38, 17);
  L.wall(30, 1, 13); L.gate(30, 14, 1, 3, 2);
  L.plate(27, 16, 2);
  L.pool(33, 34, 17, '~'); L.put(33, 14, 'r');
  L.put(19, 18, 'b'); L.put(27, 13, 'b');
  L.put(36, 16, 'f'); L.put(38, 16, 'w');
});

// ───────────── World 6: Pulley Mill (pulleys) ─────────────

// ── Puzzle templates (geometry worked out by hand; see the notes on each) ──

// Pulley step (base row 17): a box on side a (x0+12) raises side b (x0+21) by 3 into a
// step up to a ledge 6 tiles above the ground. Two on b outweigh the box: one at a time.
function pulleyStep(L, x0, ledgeTo = 38) {
  L.ground(x0, x0 + 11, 17);
  L.pulley([x0 + 12, 17], [x0 + 21, 17], 3, 0, 3);
  L.ground(x0 + 15, x0 + 20, 17);
  L.ground(x0 + 24, ledgeTo, 11);
}

// Counterweight (base row 14): `up` waits on side b (flush with the ground), then the
// other character and the box step onto side a: 2 beats 1, so a sinks 6 into a cavern
// floored with the other character's element and b lifts `up` to the high ledge.
// Returns the cavern's x range (rows 18–20).
function counterweight(L, up) {
  const pool = up === 'water' ? 'L' : '~';
  L.ground(1, 12, 14);
  L.pulley([13, 14], [22, 14], 3, 0, 6);
  L.ground(16, 21, 14);
  L.ground(22, 24, 15);            // under b
  L.ground(25, 38, 8);
  L.clear(16, 18, 38, 20);         // the cavern under everything
  L.pool(16, 38, 21, pool);
  return [16, 38];
}

// Bridge (base row 17): a box pushed left onto side a (x 3–8) raises side b (x 16–21)
// out of an acid chasm into a bridge. Two on the bridge outweigh the box and sink it.
function bridge(L) {
  L.ground(1, 2, 17);
  L.pulley([3, 17], [16, 20], 6, 0, 3);
  L.ground(9, 12, 17);
  L.box(9, 16);
  L.pool(13, 24, 21, 'A');
}

// Seesaw: two pulley platforms over acid that sink under whoever stands on them.
// One player on each holds them level.
function seesaw(L, x0, row = 16) {
  L.pulley([x0, row], [x0 + 6, row], 3, -3, 3);
}

level(41, 'going-down', 'Going Down', 6, (L) => {
  L.ground(1, 8, 10);
  L.put(2, 9, 'F'); L.put(4, 9, 'W');
  L.pulley([9, 10], [30, 12], 3, -8, 9);   // stand on the left platform to ride down
  L.wall(12, 1, 16);   // stops a running jump from the ledge; walk under it off the lowered platform
  L.pool(1, 33, 21, 'A');
  L.plat(12, 17, 19); L.put(15, 16, 'r');
  L.plat(21, 24, 18); L.put(22, 16, 'b');
  L.plat(27, 29, 18);
  L.put(35, 20, 'f'); L.put(37, 20, 'w');
});

level(42, 'one-at-a-time', 'One at a Time', 6, (L) => {
  bridge(L);
  L.put(11, 16, 'F'); L.put(12, 16, 'W');
  L.ground(25, 38, 17);
  L.put(14, 14, 'r'); L.put(23, 14, 'b'); L.put(18, 13, 'r'); L.put(19, 13, 'b');
  L.put(33, 16, 'f'); L.put(36, 16, 'w');
});

level(43, 'counterweight', 'Counterweight', 6, (L) => {
  counterweight(L, 'water');
  L.put(2, 13, 'F'); L.put(4, 13, 'W'); L.box(9, 13);
  L.put(31, 7, 'w'); L.put(34, 20, 'f');
  L.put(23, 5, 'b'); L.put(27, 19, 'r'); L.put(30, 4, 'b'); L.put(20, 19, 'r');
});

level(44, 'pulley-step', 'Pulley Step', 6, (L) => {
  pulleyStep(L, 1);
  L.put(2, 16, 'F'); L.put(4, 16, 'W'); L.box(9, 16);
  L.put(23, 12, 'r'); L.put(23, 11, 'b');
  L.pool(28, 29, 11, 'L'); L.pool(32, 33, 11, '~');
  L.put(28, 8, 'b'); L.put(33, 8, 'r');
  L.put(35, 10, 'f'); L.put(37, 10, 'w');
});

level(45, 'seesaw', 'Seesaw', 6, (L) => {
  L.ground(1, 4, 15); L.put(2, 14, 'F'); L.put(3, 14, 'W');
  seesaw(L, 6);
  L.pool(1, 38, 21, 'A');
  L.ground(16, 38, 15);
  L.put(7, 12, 'r'); L.put(13, 12, 'b');
  L.pool(22, 23, 15, 'L'); L.pool(27, 28, 15, '~');
  L.put(22, 12, 'b'); L.put(28, 12, 'r');
  L.put(34, 14, 'f'); L.put(36, 14, 'w');
});

level(46, 'heavy-lifting', 'Heavy Lifting', 6, (L) => {
  counterweight(L, 'fire');
  L.put(2, 13, 'W'); L.put(4, 13, 'F'); L.box(9, 13);
  L.put(31, 7, 'f'); L.put(34, 20, 'w');
  L.put(23, 5, 'r'); L.put(27, 19, 'b'); L.put(30, 4, 'r'); L.put(20, 19, 'b');
});

level(47, 'seesaw-crossing', 'Seesaw Crossing', 6, (L) => {
  L.ground(1, 4, 15); L.put(2, 14, 'F'); L.put(3, 14, 'W');
  seesaw(L, 6);
  L.ground(16, 18, 15);
  seesaw(L, 20);
  L.pool(1, 38, 21, 'A');
  L.ground(30, 38, 15);
  L.put(7, 12, 'r'); L.put(13, 12, 'b'); L.put(21, 12, 'b'); L.put(27, 12, 'r');
  L.put(16, 12, 'r'); L.put(18, 12, 'b');
  L.put(34, 14, 'f'); L.put(36, 14, 'w');
});

level(48, 'mill-finale', 'Mill Finale', 6, (L) => {
  pulleyStep(L, 1, 30);
  L.put(2, 16, 'F'); L.put(4, 16, 'W'); L.box(9, 16);
  // up on the ledge: a second box raises a bridge over the chasm
  L.box(26, 10);
  L.pulley([28, 11], [32, 14], 3, 0, 3);
  L.clear(31, 11, 36, 20); L.pool(31, 36, 21, 'A');
  L.ground(37, 38, 11);
  L.put(37, 10, 'f'); L.put(38, 10, 'w');
  L.put(23, 12, 'r'); L.put(23, 11, 'b'); L.put(33, 8, 'r'); L.put(34, 8, 'b');
});

level(49, 'wedge-and-lift', 'Wedge and Lift', 7, (L) => {
  L.ground(1, 13, 17);
  L.put(2, 16, 'F'); L.put(4, 16, 'W');
  L.plate(6, 16, 1); L.box(9, 16);
  L.wall(12, 1, 12); L.gate(12, 13, 1, 4, 1);
  L.pulley([14, 17], [23, 17], 3, 0, 3);
  L.ground(17, 22, 17);
  L.ground(26, 38, 11);
  L.put(24, 12, 'r'); L.put(24, 11, 'b'); L.put(8, 13, 'r'); L.put(10, 13, 'b');
  L.put(33, 10, 'f'); L.put(36, 10, 'w');
});

level(50, 'lever-lift', 'Lever Lift', 7, (L) => {
  counterweight(L, 'water');
  L.put(2, 13, 'F'); L.put(4, 13, 'W'); L.box(9, 13);
  L.lever(28, 20, 1);                      // only fire gets down here
  L.wall(32, 1, 4); L.gate(32, 5, 1, 3, 1); // and it opens water's way to the exit
  L.put(35, 7, 'w'); L.put(36, 20, 'f');
  L.put(27, 4, 'b'); L.put(30, 19, 'r'); L.put(23, 5, 'b'); L.put(20, 19, 'r');
});

level(51, 'crate-on-the-lift', 'Crate on the Lift', 7, (L) => {
  L.ground(1, 9, 11);
  L.put(2, 10, 'F'); L.put(4, 10, 'W');
  L.box(7, 10);
  L.pulley([10, 11], [30, 11], 3, -7, 7);
  L.wall(13, 1, 15);
  L.ground(14, 29, 19);
  L.plate(20, 18, 1);
  L.wall(26, 1, 16); L.gate(26, 17, 1, 2, 1);
  L.pool(1, 13, 21, 'A');
  L.ground(33, 38, 19);
  L.put(35, 18, 'f'); L.put(37, 18, 'w');
  L.put(17, 16, 'r'); L.put(23, 16, 'b');
});

level(52, 'balancing-act', 'Balancing Act', 7, (L) => {
  L.ground(1, 4, 15); L.put(2, 14, 'F'); L.put(3, 14, 'W');
  seesaw(L, 6);
  L.pool(1, 16, 21, 'A');
  L.ground(16, 38, 15);
  L.plate(19, 14, 1); L.box(22, 14);
  L.wall(25, 1, 10); L.gate(25, 11, 1, 4, 1);   // wedge the box in the doorway
  L.pool(28, 29, 15, 'L'); L.pool(31, 32, 15, '~');
  L.put(7, 12, 'r'); L.put(13, 12, 'b'); L.put(28, 12, 'b'); L.put(32, 12, 'r');
  L.put(35, 14, 'f'); L.put(37, 14, 'w');
});

level(53, 'split-decision', 'Split Decision', 7, (L) => {
  L.rect(19, 1, 20, 20);
  // fire: box onto plate opens the gate to the exit
  L.put(2, 20, 'F'); L.box(5, 20); L.plate(9, 20, 1);
  L.wall(13, 1, 16); L.gate(13, 17, 1, 4, 2);
  L.pool(15, 16, 21, '~'); L.put(17, 20, 'f'); L.put(16, 18, 'r');
  // water: box onto plate opens fire's gate; fire's plate opens water's gate
  L.put(37, 20, 'W'); L.box(34, 20); L.plate(30, 20, 2);
  L.wall(26, 1, 16); L.gate(26, 17, 1, 4, 1);
  L.pool(23, 24, 21, 'L'); L.put(22, 20, 'w'); L.put(23, 18, 'b');
});

level(54, 'weighty-matters', 'Weighty Matters', 7, (L) => {
  pulleyStep(L, 1);
  L.put(2, 16, 'F'); L.put(3, 16, 'W');
  L.box(5, 16); L.plate(7, 16, 1);     // one box holds the gate open…
  L.box(10, 16);                       // …the other works the pulley
  L.wall(29, 1, 7); L.gate(29, 8, 1, 3, 1);
  L.put(23, 12, 'r'); L.put(23, 11, 'b'); L.put(27, 8, 'b'); L.put(31, 8, 'r');
  L.put(34, 10, 'f'); L.put(37, 10, 'w');
});

level(55, 'bridges', 'Bridges', 7, (L) => {
  L.ground(1, 2, 17);
  L.pulley([3, 17], [14, 20], 4, 0, 3);
  L.ground(7, 11, 17); L.box(8, 16);
  L.put(10, 16, 'F'); L.put(11, 16, 'W');
  L.pool(12, 19, 21, 'A');
  L.ground(20, 27, 17); L.box(21, 16);
  L.pulley([23, 17], [30, 20], 3, 0, 3);
  L.ground(26, 27, 17);
  L.pool(28, 34, 21, 'A');
  L.ground(35, 38, 17);
  L.put(15, 14, 'r'); L.put(16, 14, 'b'); L.put(31, 14, 'r'); L.put(32, 14, 'b');
  L.put(36, 16, 'f'); L.put(38, 16, 'w');
});

level(56, 'down-and-across', 'Down and Across', 7, (L) => {
  L.ground(1, 8, 8);
  L.put(2, 7, 'F'); L.put(4, 7, 'W');
  L.pulley([9, 8], [34, 14], 3, -5, 9);   // ride down
  L.wall(12, 1, 13);
  L.ground(12, 17, 17); L.box(15, 16);
  L.pulley([18, 17], [25, 20], 3, 0, 3);  // box on a raises the bridge b
  L.ground(21, 22, 17);
  L.pool(1, 11, 21, 'A'); L.pool(23, 33, 21, 'A');
  L.ground(29, 33, 17);
  L.ground(37, 38, 17);
  L.put(26, 14, 'r'); L.put(27, 14, 'b'); L.put(6, 5, 'r'); L.put(7, 5, 'b');
  L.put(30, 16, 'f'); L.put(32, 16, 'w');
});

// ───────────── World 8: Grand Machine (everything) ─────────────

level(57, 'fan-and-crate', 'Fan and Crate', 8, (L) => {
  L.put(2, 20, 'F'); L.put(4, 20, 'W');
  L.box(8, 20); L.plate(12, 20, 1);
  L.fan(16, 17, 8, 20); L.gate(16, 13, 2, 1, 1);
  L.plat(18, 38, 8);
  L.pool(20, 22, 8, 'L'); L.pool(26, 28, 8, '~');
  L.put(16, 10, 'r'); L.put(17, 10, 'b');
  L.put(34, 7, 'f'); L.put(36, 7, 'w');
});

level(58, 'lava-works', 'Lava Works', 8, (L) => {
  counterweight(L, 'water');
  L.put(2, 13, 'F'); L.put(3, 13, 'W');
  L.plate(5, 13, 1); L.box(8, 13);
  L.wall(11, 1, 9); L.gate(11, 10, 1, 4, 1);        // wedge, then counterweight
  L.fan(30, 31, 8, 20);                             // fire rides back up from the works
  L.put(28, 7, 'w'); L.put(35, 7, 'f');
  L.put(30, 12, 'r'); L.put(23, 5, 'b'); L.put(20, 19, 'r'); L.put(26, 4, 'b');
});

level(59, 'water-works', 'Water Works', 8, (L) => {
  counterweight(L, 'fire');
  L.put(2, 13, 'W'); L.put(4, 13, 'F'); L.box(9, 13);
  L.lever(28, 20, 1);
  L.wall(32, 1, 4); L.gate(32, 5, 1, 3, 1);
  L.put(35, 7, 'f'); L.put(36, 20, 'w');
  L.put(27, 4, 'r'); L.put(30, 19, 'b'); L.put(23, 5, 'r'); L.put(20, 19, 'b');
});

level(60, 'switchyard', 'Switchyard', 8, (L) => {
  L.put(2, 20, 'F'); L.put(4, 20, 'W');
  L.lever(7, 20, 1, { toggle: true });
  L.wall(10, 1, 16); L.gate(10, 17, 1, 4, 1);
  L.box(13, 20); L.plate(17, 20, 2);
  L.wall(20, 1, 16); L.gate(20, 17, 1, 4, 2);
  L.wall(24, 1, 16); L.gate(24, 17, 1, 4, 1, true);
  L.lever(27, 20, 1, { toggle: true, dir: -1 });
  L.pool(30, 31, 21, '~'); L.put(30, 18, 'r');
  L.pool(33, 34, 21, 'L'); L.put(34, 18, 'b');
  L.put(36, 20, 'f'); L.put(38, 20, 'w');
  L.put(15, 18, 'r'); L.put(22, 18, 'b');
});

level(61, 'updraft-lift', 'Updraft Lift', 8, (L) => {
  pulleyStep(L, 1);
  L.put(2, 16, 'F'); L.put(4, 16, 'W'); L.box(9, 16);
  L.fan(30, 31, 4, 10);
  L.plat(32, 38, 4);
  L.pool(27, 28, 11, '~'); L.pool(34, 35, 4, 'L');
  L.put(30, 6, 'r'); L.put(31, 6, 'b'); L.put(23, 12, 'r'); L.put(23, 11, 'b');
  L.put(33, 3, 'f'); L.put(37, 3, 'w');
});

level(62, 'crate-relay', 'Crate Relay', 8, (L) => {
  L.ground(1, 9, 14);
  L.put(2, 13, 'F'); L.put(4, 13, 'W');
  L.box(7, 13);
  L.plate(13, 20, 1);
  L.wall(20, 1, 16); L.gate(20, 17, 1, 4, 1);
  L.box(23, 20);
  L.ground(27, 38, 17);
  L.pool(28, 29, 17, 'L'); L.pool(32, 33, 17, '~');
  L.put(28, 14, 'b'); L.put(33, 14, 'r');
  L.put(35, 16, 'f'); L.put(37, 16, 'w');
  L.plat(10, 12, 17);
});

level(63, 'tipping-point', 'Tipping Point', 8, (L) => {
  L.ground(1, 4, 15); L.put(2, 14, 'F'); L.put(3, 14, 'W');
  seesaw(L, 6);
  L.ground(16, 22, 15); L.box(18, 14);
  seesaw(L, 24);
  L.pool(1, 33, 21, 'A');
  L.ground(34, 38, 15);
  L.plate(20, 14, 1);
  L.wall(35, 1, 10); L.gate(35, 11, 1, 4, 1);
  L.put(7, 12, 'r'); L.put(13, 12, 'b'); L.put(25, 12, 'b'); L.put(31, 12, 'r');
  L.put(36, 14, 'f'); L.put(38, 14, 'w');
});

level(64, 'grand-machine', 'The Grand Machine', 8, (L) => {
  counterweight(L, 'water');
  L.put(2, 13, 'F'); L.put(3, 13, 'W');
  L.plate(5, 13, 1); L.box(8, 13);
  L.wall(11, 1, 9); L.gate(11, 10, 1, 4, 1);        // wedge the box, then use it as the weight
  L.lever(24, 20, 2);                               // fire, down in the works…
  L.fan(33, 34, 8, 20);                             // …rides the updraft back up…
  L.wall(29, 1, 4); L.gate(29, 5, 1, 3, 2);         // …to the exits behind the gate
  L.pool(26, 27, 8, '~');
  L.put(36, 7, 'f'); L.put(38, 7, 'w');
  L.put(20, 19, 'r'); L.put(27, 19, 'r'); L.put(23, 5, 'b'); L.put(31, 6, 'b');
});

console.log('written', fs.readdirSync(OUT).filter((f) => /^\d\d-/.test(f)).length);
