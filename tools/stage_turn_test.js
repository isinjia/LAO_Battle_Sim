// Turn-limit mission check: can each stage with a TURN_LIMIT_LESS / ROUND_LIMIT_LESS mission be cleared within its limit?
//   node tools/stage_turn_test.js [--seeds 3] [--threads N] [--only Ch01Stage01,..]
// Input: tools/out/stage-missions.json (stage -> missions, made from LoJson Table_MissionObject).
// The server decides the mission, so three counters are measured per clear:
//   total  = TotalRound over the whole stage (one round = one unit action incl. enemies; what C2W_ROUND_ENDED reports)
//   wave   = the largest per-wave Round (Round resets every wave)
//   pc     = actions taken by our squad only (the plain meaning of "turn")
// Squad: a strong Lv100 / max grade / skill Lv10 squad, so the numbers are a best case (lower bound).
// Writes tools/out/stage-turn-test.json
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const os = require('os');
const { Worker, isMainThread, parentPort } = require('worker_threads');

const ROOT = path.join(__dirname, '..');
function loadEngine() {
  global.window = global;
  global.fengari = require('fengari');
  const run = (p) => vm.runInThisContext(fs.readFileSync(p, 'utf8'), { filename: p });
  run(path.join(ROOT, 'engine', 'enums.js'));
  run(path.join(ROOT, 'engine', 'core.js'));
  const L = global.LOSim;
  L.data = {};
  for (const f of ['stages', 'units', 'skills', 'buffs', 'loc', 'lua']) L.data[f] = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', f + '.json'), 'utf8'));
  for (const m of ['stats', 'buffs', 'combat', 'ai', 'battle']) run(path.join(ROOT, 'engine', m + '.js'));
  return L;
}
const SQUAD = [['Char_DS_GraveSong_N', 5], ['Char_3P_Lamia_N', 2], ['Char_AGS_Shade_N', 4], ['Char_BR_NightAngel_N', 1], ['Char_3P_Daphne_N', 3]];

function runStage(L, squad, stage, seed) {
  const b = L.battle.create({ mode: 'stage', stageKey: stage, squad, seed, logEnabled: true, options: { maxActions: 3000 } });
  let pc = 0, extra = 0, all = 0, waveMax = 0;
  while (!b.result) {
    L.battle.step(b);
    for (const e of b.log) if (e.t === 'action') { all++; if (e.actor && e.actor.team === 1) { if (e.turnType === 'normal') pc++; else extra++; } } // a turn = main action only
    b.log.length = 0;
    if (b.round > waveMax) waveMax = b.round;
  }
  return { outcome: b.result, reason: b.resultReason || '', total: b.totalRounds, wave: waveMax, pc, extra, all, waves: b.maxWave || b.waves.length };
}

function workerMain() {
  const L = loadEngine();
  const squad = SQUAD.map(([k, gp]) => { const s = L.stats.defaultSpec(k); const pc = L.T('Table_PC', k); return Object.assign(s, { grade: L.num(pc, 'MaxGrade') || 5, level: 100, gridPos: gp, skillLevels: s.skillLevels.map(() => 10) }); });
  parentPort.on('message', (m) => {
    const res = m.items.map((it) => {
      const runs = [];
      for (let i = 0; i < m.seeds; i++) { try { runs.push(runStage(L, squad, it.stage, 11 + i)); } catch (e) { runs.push({ outcome: 'error', reason: String(e && e.message || e).slice(0, 200) }); } }
      return Object.assign({}, it, { runs });
    });
    parentPort.postMessage({ res });
  });
  parentPort.postMessage({ ready: true });
}

async function main() {
  const args = process.argv.slice(2);
  const arg = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
  let items = JSON.parse(fs.readFileSync(path.join(__dirname, 'out', 'stage-missions.json'), 'utf8'));
  if (arg('only')) { const w = new Set(arg('only').split(',')); items = items.filter((x) => w.has(x.stage)); }
  const seeds = +arg('seeds', 3);
  const threads = Math.max(1, Math.min(+arg('threads', os.cpus().length - 1), 16));
  const chunks = [];
  for (let i = 0; i < items.length; i += 4) chunks.push(items.slice(i, i + 4));
  const results = [];
  const t0 = Date.now();
  await Promise.all(Array.from({ length: threads }, () => new Promise((resolve, reject) => {
    const w = new Worker(__filename);
    const next = () => { const c = chunks.shift(); if (!c) { w.terminate(); resolve(); return; } w.postMessage({ items: c, seeds }); };
    w.on('message', (m) => {
      if (m.ready) { next(); return; }
      results.push(...m.res);
      if (results.length % 80 < 4) process.stderr.write(`  ${results.length}/${items.length} (${Math.round((Date.now() - t0) / 1000)}s)\n`);
      next();
    });
    w.on('error', reject);
  })));
  results.sort((a, b) => a.stage.localeCompare(b.stage));
  const file = path.join(__dirname, 'out', 'stage-turn-test.json');
  fs.writeFileSync(file, JSON.stringify({ at: new Date().toISOString(), squad: SQUAD, seeds, results }, null, 1));
  console.log('stages', results.length, 'in', Math.round((Date.now() - t0) / 1000) + 's ->', file);
}

if (isMainThread) main().catch((e) => { console.error(e); process.exit(1); });
else workerMain();
