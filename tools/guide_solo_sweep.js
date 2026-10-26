// Phase 2 for one-character guides: the title names the character but not the cell, so try all 9 cells
// (Lv100, max grade, skill Lv10, "대표 장비") and keep the best one per guide/stage.
//   node tools/guide_solo_sweep.js            (targets: tools/out/phase2-targets.json, one-character entries)
// Writes tools/out/guide-solo-sweep.json
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const OUT = path.join(__dirname, 'out');
const targets = JSON.parse(fs.readFileSync(path.join(OUT, 'phase2-targets.json'), 'utf8'));
const names = JSON.parse(fs.readFileSync(path.join(OUT, 'pc-names.json'), 'utf8'));
const items = [];
for (const [tags, stage, post, title, members] of targets) {
  if (members.length !== 1) continue;
  const key = (names[members[0]] || [])[0];
  if (!key) continue;
  for (let gp = 0; gp < 9; gp++) items.push({ post, title, stage, source: 'sweep', note: 'cell ' + (gp + 1), squad: [{ key, gridPos: gp }] });
}
// reuse guide_test.js on a temporary list
const tmp = path.join(OUT, 'guide-squads.sweep.json');
fs.writeFileSync(tmp, JSON.stringify(items));
const bak = path.join(OUT, 'guide-squads.json');
const keep = fs.readFileSync(bak);
fs.writeFileSync(bak, fs.readFileSync(tmp));
try {
  execFileSync(process.execPath, [path.join(__dirname, 'guide_test.js'), '--seeds', '3', '--gear'], { stdio: 'ignore' });
} finally {
  fs.writeFileSync(bak, keep);
}
const res = JSON.parse(fs.readFileSync(path.join(OUT, 'guide-test-gear.json'), 'utf8')).results;
const best = {};
for (const r of res) {
  const k = r.post + '|' + r.stage;
  const w = r.runs.filter((x) => x.outcome === 'win');
  const cand = { cell: r.note, wins: w.length, runs: r.runs.length, pc: w.length ? Math.min(...w.map((x) => x.pc)) : null, total: w.length ? Math.min(...w.map((x) => x.total)) : null,
    outcomes: r.runs.map((x) => x.outcome), title: r.title, stage: r.stage, post: r.post, name: r.squad[0] && r.squad[0].name };
  const b = best[k];
  if (!b || cand.wins > b.wins || (cand.wins === b.wins && cand.pc !== null && (b.pc === null || cand.pc < b.pc))) best[k] = cand;
  (best[k].all = best[k].all || []).push(cand.cell + ':' + cand.outcomes.map((o) => o[0]).join(''));
}
fs.writeFileSync(path.join(OUT, 'guide-solo-sweep.json'), JSON.stringify(Object.values(best), null, 1));
for (const b of Object.values(best)) console.log(b.stage, b.name, '| best', b.cell, 'wins', b.wins + '/' + b.runs, 'pc', b.pc, 'total', b.total);
