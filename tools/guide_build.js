// Builds tools/out/guide-squads.json from guide-candidates.json (guide titles -> squad) for guide_test.js.
//   node tools/guide_build.js
// Only guides whose every named character resolved; formation = combo-core autoFormation (front for tanks, back for supporters),
// because a title names the members but not their cells. Squads read from the formation image (guide-squads-read.json) win.
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
global.window = global;
global.fengari = require('fengari');
const run = (p) => vm.runInThisContext(fs.readFileSync(p, 'utf8'), { filename: p });
run(path.join(ROOT, 'engine', 'enums.js'));
run(path.join(ROOT, 'engine', 'core.js'));
const L = global.LOSim;
L.data = {};
for (const f of ['stages', 'units', 'skills', 'buffs', 'loc', 'lua']) L.data[f] = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', f + '.json'), 'utf8'));
for (const m of ['stats', 'buffs', 'combat', 'ai', 'battle']) run(path.join(ROOT, 'engine', m + '.js'));
run(path.join(ROOT, 'combo-core.js'));

const OUT = path.join(__dirname, 'out');
const c = JSON.parse(fs.readFileSync(path.join(OUT, 'guide-candidates.json'), 'utf8'));
const readPath = path.join(OUT, 'guide-squads-read.json');
const read = fs.existsSync(readPath) ? JSON.parse(fs.readFileSync(readPath, 'utf8')) : [];
const readBy = new Map(read.map((r) => [r.post + '|' + r.stage, r]));
const out = [];
for (const g of c) {
  if (!g.stages.length || !g.chars.length || g.chars.some((x) => !x.key)) continue;
  const keys = [...new Set(g.chars.map((x) => x.key))].slice(0, 5);
  const form = L.combo.autoFormation(keys);
  for (const st of g.stages) {
    const r = readBy.get(g.id + '|' + st);
    out.push(r ? Object.assign({ title: g.title, event: g.event || '', label: g.label, time: g.time }, r, { source: 'image' })
      : { post: g.id, title: g.title, stage: st, event: g.event || '', label: g.label, time: g.time, source: 'title', squad: form.map((m) => ({ key: m.key, gridPos: m.gridPos })) });
  }
}
fs.writeFileSync(path.join(OUT, 'guide-squads.json'), JSON.stringify(out));
console.log('entries', out.length, 'stages', new Set(out.map((x) => x.stage)).size, 'from images', out.filter((x) => x.source === 'image').length);
