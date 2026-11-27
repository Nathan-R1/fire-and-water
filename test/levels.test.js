const test = require('node:test');
const assert = require('node:assert');
const { analyse } = require('../tools/levelcheck');
const { LEVELS } = require('../src/game');

for (const def of LEVELS) {
  test(`level ${def.id} passes the reachability check`, () => {
    assert.deepEqual(analyse(def).errors, []);
  });
}

test('vertical gates are at least 2 tiles tall (characters are 30px)', () => {
  for (const def of LEVELS) {
    for (const o of def.objects || []) {
      if (o.type === 'gate' && o.size[0] === 1) assert.ok(o.size[1] >= 2, `${def.id} gate at ${o.at}`);
    }
  }
});

// Real physics, not the coarse checker: every pulley must travel its full range in
// both directions when weighted, and nothing should move by itself at the start.
const P = require('../shared/physics');

for (const def of LEVELS) {
  const probe = P.parseLevel(def);
  if (!probe.pulleys.length && !probe.boxes.length) continue;

  test(`level ${def.id}: pulleys travel their full range`, () => {
    probe.pulleys.forEach((p, i) => {
      const level = P.parseLevel(def);
      level.gates = []; // gates open
      const state = P.createLevelState(level);
      const weigh = (side) => {
        const r = P.platformRects(level, state)[i * 2 + (side === 'a' ? 0 : 1)];
        state.boxes = [{ x: r.x + r.w / 2 - P.BOX.size / 2, y: r.y - P.BOX.size - 0.5, w: P.BOX.size, h: P.BOX.size, vy: 0, onGround: false }];
        for (let t = 0; t < 900; t++) P.stepEnv(level, state, []);
      };
      weigh('a');
      assert.equal(state.pulleys[i].o, p.max, `pulley ${i}: weight on a should sink it to max`);
      weigh('b');
      assert.equal(state.pulleys[i].o, p.min, `pulley ${i}: weight on b should sink it to min`);
    });
  });

  test(`level ${def.id}: nothing moves on its own at the start`, () => {
    const level = P.parseLevel(def);
    const state = P.createLevelState(level);
    const bodies = [P.createBody(level.spawns.fire), P.createBody(level.spawns.water)];
    const start = state.boxes.map((b) => b.y);
    const idle = { left: false, right: false };
    for (let t = 0; t < 180; t++) P.stepWorld(level, bodies, [idle, idle], P.DT, state);
    state.pulleys.forEach((ps, i) => assert.equal(ps.o, 0, `pulley ${i} moved`));
    state.boxes.forEach((b, i) => assert.equal(b.y, start[i], `box ${i} fell`));
  });
}
