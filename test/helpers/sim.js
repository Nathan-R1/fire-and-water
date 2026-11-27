// A tiny scripted "player" for solution tests: real inputs through the real physics.

const P = require('../../shared/physics');
const { LEVELS } = require('../../src/game');

const T = P.TILE;
const NONE = { left: false, right: false };

function sim(idPrefix) {
  const def = LEVELS.find((l) => l.id.startsWith(idPrefix));
  const level = P.parseLevel(def);
  const state = P.createLevelState(level);
  const chars = { fire: P.createBody(level.spawns.fire), water: P.createBody(level.spawns.water) };
  const input = { fire: NONE, water: NONE };
  const gems = new Set();
  let ticks = 0;

  function tick() {
    ticks++;
    P.stepWorld(level, [chars.fire, chars.water], [input.fire, input.water], P.DT, state);
    for (const el of ['fire', 'water']) {
      const h = P.hazardUnder(level, chars[el], el);
      if (h) throw new Error(`${el} died at tile (${cx(el).toFixed(1)}, ${((chars[el].y + P.CHAR.height) / T).toFixed(1)}) after ${ticks} ticks`);
      for (const i of P.collectGems(level, state, chars[el], el)) gems.add(i);
    }
  }

  const cx = (el) => (chars[el].x + P.CHAR.width / 2) / T; // centre, in tiles
  const feet = (el) => (chars[el].y + P.CHAR.height) / T;

  const s = {
    level, state, chars, gems,
    cx, feet,
    wait(n) { for (let i = 0; i < n; i++) tick(); return s; },
    // Walk until the character's centre reaches tile x (+0.5 = middle of the tile).
    walk(el, x, max = 900) {
      const dir = Math.sign(x - cx(el));
      input[el] = dir > 0 ? { left: false, right: true } : { left: true, right: false };
      for (let i = 0; i < max && (cx(el) - x) * dir < 0; i++) tick();
      input[el] = NONE;
      if ((cx(el) - x) * dir < 0) throw new Error(`${el} got stuck walking to ${x} (at ${cx(el).toFixed(2)}, ${feet(el).toFixed(2)})`);
      return s;
    },
    // Jump while holding a direction for `hold` ticks (dir 0 = straight up).
    jump(el, dir, hold = 40) {
      P.pressJump(chars[el]);
      input[el] = dir > 0 ? { left: false, right: true } : dir < 0 ? { left: true, right: false } : NONE;
      for (let i = 0; i < hold; i++) tick();
      input[el] = NONE;
      return s;
    },
    // Hold a direction for n ticks (pushing a box, walking off a ledge…).
    hold(el, dir, n) {
      input[el] = dir > 0 ? { left: false, right: true } : { left: true, right: false };
      for (let i = 0; i < n; i++) tick();
      input[el] = NONE;
      return s;
    },
    // Jump and steer so the character's centre ends up over tile x, then land.
    jumpTo(el, x, max = 120) {
      P.pressJump(chars[el]);
      let left = false;
      for (let i = 0; i < max; i++) {
        const d = x - cx(el);
        input[el] = Math.abs(d) < 0.15 ? NONE : d > 0 ? { left: false, right: true } : { left: true, right: false };
        tick();
        if (!chars[el].onGround) left = true;
        if (left && chars[el].onGround) break;
      }
      input[el] = NONE;
      return s;
    },
    // Keep steering toward tile x for n ticks (e.g. hovering in a fan).
    steer(el, x, n) {
      for (let i = 0; i < n; i++) {
        const d = x - cx(el);
        input[el] = Math.abs(d) < 0.1 ? NONE : d > 0 ? { left: false, right: true } : { left: true, right: false };
        tick();
      }
      input[el] = NONE;
      return s;
    },
    land(max = 200) {
      for (let i = 0; i < max && !(chars.fire.onGround && chars.water.onGround); i++) tick();
      return s;
    },
    at(el, x, y) { chars[el].x = x * T - P.CHAR.width / 2; chars[el].y = y * T - P.CHAR.height; chars[el].vx = chars[el].vy = 0; return s; },
    atExit(el) { return P.atExit(level, chars[el], el); },
    box(i) { return { x: state.boxes[i].x / T, y: state.boxes[i].y / T }; },
    plat(i, side) { return P.platformRects(level, state)[i * 2 + (side === 'a' ? 0 : 1)]; },
  };
  return s;
}

module.exports = { sim, T };
