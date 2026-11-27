// Print a level as text with objects drawn in: = pulley platform (start position),
// : pulley travel, _ plate, / lever, | gate. Usage: node tools/showlevel.js 42 [43 ...]
const fs = require('fs');
const path = require('path');
const dir = path.join(__dirname, '..', 'levels');
for (const n of process.argv.slice(2)) {
  const f = fs.readdirSync(dir).find((x) => x.startsWith(String(n).padStart(2, '0') + '-'));
  const def = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
  const g = def.rows.map((r) => r.split(''));
  const set = (x, y, c) => { if (g[y] && g[y][x] === '.') g[y][x] = c; };
  for (const o of def.objects || []) {
    if (o.type === 'pulley') {
      const min = o.min ?? -(o.travel || 4), max = o.max ?? (o.travel || 4);
      for (const [[x, y], s] of [[o.a, 1], [o.b, -1]]) {
        for (let k = min; k <= max; k++) for (let i = 0; i < (o.w || 3); i++) set(x + i, y + s * k, ':');
        for (let i = 0; i < (o.w || 3); i++) g[y][x + i] = '=';
      }
    } else if (o.type === 'plate') g[o.at[1]][o.at[0]] = '_';
    else if (o.type === 'lever') g[o.at[1]][o.at[0]] = '/';
    else if (o.type === 'gate') for (let y = 0; y < o.size[1]; y++) for (let x = 0; x < o.size[0]; x++) g[o.at[1] + y][o.at[0] + x] = '|';
  }
  console.log(`${f}\n    ${'0123456789'.repeat(4)}\n` + g.map((r, y) => `${String(y).padStart(2)}  ${r.join('')}`).join('\n'));
}
