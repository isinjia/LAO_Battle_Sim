// Fewest-turn clear search: for each stage, try many different squads and formations to find the smallest
// number of turns a clear can take (best case), so "this mission is impossible" is not decided by one squad.
//   node tools/stage_turn_search.js [--stages a,b,..] [--threads N] [--random 120] [--gens 5] [--children 40]
// Default stages: every stage the single-squad run (stage-turn-summary.json) could not clear within its limit.
// Squads: all usable PCs (modules / cores excluded), Lv100, max grade, skill Lv10, no equipment.
// Per stage: random squads + class/role-themed squads + the previous squad, then a few generations of mutation
// (swap members, crossover, move cells), then the best ones re-run on more seeds. Tracks separately the minimum of
//   pc (our actions), total (TotalRound incl. enemies), wave (largest per-wave Round).
// Writes tools/out/stage-turn-search.json
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
  run(path.join(ROOT, 'combo-core.js'));
  return L;
}
const PREV = [['Char_DS_GraveSong_N', 5], ['Char_3P_Lamia_N', 2], ['Char_AGS_Shade_N', 4], ['Char_BR_NightAngel_N', 1], ['Char_3P_Daphne_N', 3]];

function workerMain() {
  const L = loadEngine();
  const C = L.combo;
  C.installSpeedups();
  const pool = C.pcPool().filter((p) => !/Module|_Core_/.test(p.key));
  const keys = pool.map((p) => p.key);
  const byCls = {}, byRole = {};
  for (const p of pool) { (byCls[p.cls] = byCls[p.cls] || []).push(p.key); (byRole[p.role] = byRole[p.role] || []).push(p.key); }
  let rs = 12345;
  const rnd = () => { rs = (rs * 1103515245 + 12345) >>> 0; return rs / 4294967296; };
  const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
  const sample = (arr, n, avoid) => { const out = []; const seen = new Set(avoid || []); let g = 0; while (out.length < n && g++ < 500) { const k = pick(arr); if (!seen.has(k)) { seen.add(k); out.push(k); } } return out; };
  const form = (ks) => C.autoFormation(ks);
  const sqKey = (sq) => C.squadKey(sq);

  function run(stage, sq, seed) {
    const squad = sq.map((m) => C.makeSpec(m.key, m.gridPos));
    const b = L.battle.create({ mode: 'stage', stageKey: stage, squad, seed, logEnabled: true, options: { maxActions: 700 } });
    let pc = 0, extra = 0, wave = 0;
    while (!b.result) {
      L.battle.step(b);
      for (const e of b.log) if (e.t === 'action' && e.actor && e.actor.team === 1) { if (e.turnType === 'normal') pc++; else extra++; } // a turn = main action only (assist / counter / double / reserve are not turns)
      b.log.length = 0;
      if (b.round > wave) wave = b.round;
    }
    const win = b.result === 'win';
    return { win, pc, extra, total: b.totalRounds, wave, waves: b.waveIndex + 1, maxWave: b.maxWave || b.waves.length };
  }
  const score = (r) => (r.win ? r.pc : 10000 - r.waves * 1000 + r.pc);

  function searchStage(st, o) {
    rs = 12345 + st.stage.length * 7919;
    const best = { pc: null, total: null, wave: null };
    const seen = new Map();
    let battles = 0, wins = 0;
    const note = (sq, r, seed) => {
      battles++;
      if (!r.win) return;
      wins++;
      for (const k of ['pc', 'total', 'wave']) if (!best[k] || r[k] < best[k].value) best[k] = { value: r[k], squad: sq.map((m) => m.key + '@' + m.gridPos), seed, other: { pc: r.pc, total: r.total, wave: r.wave } };
    };
    const evalSq = (sq) => {
      const k = sqKey(sq);
      if (seen.has(k)) return seen.get(k);
      let r;
      try { r = run(st.stage, sq, 1); } catch (e) { r = { win: false, pc: 9999, total: 9999, wave: 9999, waves: 0, err: String(e.message || e) }; }
      note(sq, r, 1);
      const v = { sq, r, s: score(r) };
      seen.set(k, v);
      return v;
    };
    const done = () => best.pc && best.total && best.pc.value <= st.limit && best.total.value <= st.limit;

    // phase A: diverse starting squads
    const starts = [];
    starts.push(PREV.map(([k, g]) => ({ key: k, gridPos: g })));
    for (let i = 0; i < o.random; i++) starts.push(form(sample(keys, 5)));
    for (const cls of Object.keys(byCls)) for (let i = 0; i < 8; i++) starts.push(form(sample(byCls[cls], 5)));
    for (let i = 0; i < 24; i++) {
      const ks = [];
      ks.push(...sample(byRole[0] || [], 1, ks)); ks.push(...sample(byRole[1] || [], 3, ks)); ks.push(...sample(byRole[2] || [], 1, ks));
      if (ks.length === 5) starts.push(form(ks));
    }
    for (let i = 0; i < 16; i++) { const ks = sample(byRole[1] || keys, 5); if (ks.length === 5) starts.push(form(ks)); } // all dealers
    let pop = [];
    for (const sq of starts) { pop.push(evalSq(sq)); if (done()) break; }

    // phase B: evolve
    for (let g = 0; g < o.gens && !done(); g++) {
      pop.sort((a, b) => a.s - b.s);
      const elite = pop.slice(0, 16);
      const kids = [];
      for (let i = 0; i < o.children; i++) {
        const a = pick(elite).sq;
        let ks = a.map((m) => m.key);
        const t = rnd();
        if (t < 0.4) { const j = Math.floor(rnd() * 5); ks[j] = sample(keys, 1, ks)[0] || ks[j]; kids.push(form(ks)); }
        else if (t < 0.6) { const b2 = pick(elite).sq.map((m) => m.key); const mix = [...new Set(ks.slice(0, 2 + Math.floor(rnd() * 2)).concat(b2))].slice(0, 5); while (mix.length < 5) mix.push(sample(keys, 1, mix)[0]); kids.push(form(mix)); }
        else if (t < 0.8) { const sq = a.map((m) => Object.assign({}, m)); const j = Math.floor(rnd() * 5); const usedG = new Set(sq.map((m) => m.gridPos)); const free = [0, 1, 2, 3, 4, 5, 6, 7, 8].filter((x) => !usedG.has(x)); if (free.length) sq[j].gridPos = pick(free); kids.push(sq); }
        else { const sq = a.map((m) => Object.assign({}, m)); const i1 = Math.floor(rnd() * 5), i2 = Math.floor(rnd() * 5); const tg = sq[i1].gridPos; sq[i1].gridPos = sq[i2].gridPos; sq[i2].gridPos = tg; kids.push(sq); }
      }
      for (const sq of kids) { pop.push(evalSq(sq)); if (done()) break; }
    }

    // phase C: re-run the best squads on more seeds (best case = smallest value seen on any seed)
    pop.sort((a, b) => a.s - b.s);
    const top = [];
    for (const k of ['pc', 'total']) if (best[k]) top.push(best[k].squad.map((s) => { const [key, gp] = s.split('@'); return { key, gridPos: +gp }; }));
    for (const v of pop.slice(0, 6)) top.push(v.sq);
    for (const sq of top) for (let seed = 2; seed <= o.verify + 1; seed++) { if (done()) break; try { note(sq, run(st.stage, sq, seed), seed); } catch (e) { battles++; } }
    return { stage: st.stage, limit: st.limit, kind: st.kind, battles, wins, squadsTried: seen.size, best };
  }

  parentPort.on('message', (m) => { parentPort.postMessage({ res: searchStage(m.st, m.o) }); });
  parentPort.postMessage({ ready: true, pool: pool.length });
}

async function main() {
  const args = process.argv.slice(2);
  const arg = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
  const o = { random: +arg('random', 120), gens: +arg('gens', 5), children: +arg('children', 40), verify: +arg('verify', 3) };
  const sum = JSON.parse(fs.readFileSync(path.join(__dirname, 'out', 'stage-turn-summary.json'), 'utf8'));
  const lim = new Map();
  for (const x of [].concat(sum.pcfail, sum.totfail, sum.special)) {
    const prev = lim.get(x[0]);
    if (!prev || x[2] < prev.limit) lim.set(x[0], { stage: x[0], limit: x[2], kind: x[1] });
  }
  let items = [...lim.values()];
  if (arg('stages')) {
    const w = arg('stages').split(',');
    for (const k of w) if (!lim.has(k)) items.push({ stage: k, limit: +arg('limit', 30), kind: 'TURN_LIMIT_LESS' }); // e.g. stages the single squad lost
    const ws = new Set(w); items = items.filter((x) => ws.has(x.stage));
  }
  const threads = Math.max(1, Math.min(+arg('threads', os.cpus().length - 1), 16));
  const queue = items.slice();
  const results = [];
  const t0 = Date.now();
  let poolSize = 0;
  await Promise.all(Array.from({ length: threads }, () => new Promise((resolve, reject) => {
    const w = new Worker(__filename);
    const next = () => { const st = queue.shift(); if (!st) { w.terminate(); resolve(); return; } w.postMessage({ st, o }); };
    w.on('message', (m) => {
      if (m.ready) { poolSize = m.pool; next(); return; }
      results.push(m.res);
      const b = m.res.best;
      process.stderr.write(`  ${results.length}/${items.length} ${m.res.stage} limit ${m.res.limit} -> pc ${b.pc ? b.pc.value : '-'} total ${b.total ? b.total.value : '-'} (${m.res.squadsTried} squads, ${Math.round((Date.now() - t0) / 1000)}s)\n`);
      next();
    });
    w.on('error', reject);
  })));
  results.sort((a, b) => a.stage.localeCompare(b.stage));
  const file = path.join(__dirname, 'out', arg('out', 'stage-turn-search.json'));
  fs.writeFileSync(file, JSON.stringify({ at: new Date().toISOString(), options: o, poolSize, results }, null, 1));
  console.log('stages', results.length, 'in', Math.round((Date.now() - t0) / 1000) + 's ->', file);
}

if (isMainThread) main().catch((e) => { console.error(e); process.exit(1); });
else workerMain();
