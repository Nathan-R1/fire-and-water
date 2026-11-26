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
