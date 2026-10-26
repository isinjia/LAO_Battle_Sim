// Headless team-composition search (same logic as the "조합 분석" tab: combo-core.js).
//   node tools/combo_node.js --objective dps|burst|survival|clear|balanced[,..] [--budget small|medium|large|N]
//        [--seeds 3] [--verify 20] [--threads N] [--stage Ch11Stage08] [--layout f3m2|x5|single|f3|full9]
//        [--grade max|start|N] [--level 100] [--skill 10] [--pool "검색어"] [--include k1,k2] [--exclude k1,k2]
//        [--lock k1,k2] [--shortlist 28] [--dummy-turns 20] [--burst-turns 3] [--hpmul 10] [--endure-turns 30] [--endure-hpmul 1000] [--endure-atkmul 1] [--no-regen]
//   node tools/combo_node.js --selftest      checks that the speed shims (combo-core installSpeedups) do not change results
// Writes tools/out/combo-<objectives>-<time>.{json,md}.
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const os = require('os');
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');

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

if (!isMainThread) {
  const L = loadEngine();
  if (workerData && workerData.speedups) L.combo.installSpeedups();
  parentPort.on('message', (m) => {
    const out = m.jobs.map((j) => L.withOverrides(j.overrides, () => L.combo.evaluate(j)));
    parentPort.postMessage({ id: m.id, out });
  });
  parentPort.postMessage({ ready: true });
  return;
}

// ------------------------------------------------------------------ main thread
const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : d; };
const has = (n) => argv.includes(n);
const csv = (s) => (s ? String(s).split(',').map((x) => x.trim()).filter(Boolean) : []);

function makePool(n) {
  const ws = [];
  let seq = 0;
  const pending = new Map();
  for (let i = 0; i < n; i++) {
    const w = new Worker(__filename, { workerData: { speedups: true } });
    w.ready = new Promise((res) => w.once('message', () => res()));
    w.on('message', (m) => { if (m.id && pending.has(m.id)) { pending.get(m.id)(m.out); pending.delete(m.id); } });
    w.on('error', (e) => { console.error('worker error', e); process.exit(1); });
    ws.push(w);
  }
  const send = (w, jobs) => new Promise((res) => { const id = ++seq; pending.set(id, res); w.postMessage({ id, jobs }); });
  return {
    async evalMany(jobs, onEach) {
      await Promise.all(ws.map((w) => w.ready));
      // small chunks so long and short jobs balance across threads
      const chunks = [];
      const size = Math.max(1, Math.ceil(jobs.length / (ws.length * 3)));
      for (let i = 0; i < jobs.length; i += size) chunks.push({ start: i, jobs: jobs.slice(i, i + size) });
      const out = new Array(jobs.length);
      let next = 0;
      await Promise.all(ws.map(async (w) => {
        while (next < chunks.length) {
          const c = chunks[next++];
          const r = await send(w, c.jobs);
          r.forEach((x, k) => { out[c.start + k] = x; onEach && onEach(); });
        }
      }));
      return out;
    },
    close() { for (const w of ws) w.terminate(); },
  };
}

async function selftest(L) {
  const C = L.combo;
  const pool = C.pcPool();
  const pick = (i) => pool[(i * 37) % pool.length].key;
  const squads = [0, 1, 2].map((s) => C.autoFormation([pick(s * 5), pick(s * 5 + 1), pick(s * 5 + 2), pick(s * 5 + 3), pick(s * 5 + 4)]));
  let ok = true;
  for (const kind of ['dummy', 'endurance', 'stage']) {
    const bench = C.makeBench(kind, Object.assign({}, C.DEFAULTS, { dummy: { turns: 6 }, endurance: { turns: 8 } }));
    for (const sq of squads) {
      C.removeSpeedups();
      let t = Date.now();
      const a = JSON.stringify(C.evaluate({ squad: sq, bench, seeds: [1, 2] }));
      const ta = Date.now() - t;
      C.installSpeedups();
      t = Date.now();
      const b = JSON.stringify(C.evaluate({ squad: sq, bench, seeds: [1, 2] }));
      const tb = Date.now() - t;
      const same = a === b;
      ok = ok && same;
      console.log(`${kind.padEnd(9)} ${C.squadKey(sq).slice(0, 70).padEnd(70)} ${same ? 'IDENTICAL' : 'DIFFERENT'}  ${ta}ms -> ${tb}ms`);
    }
  }
  C.removeSpeedups();
  console.log(ok ? 'selftest OK' : 'selftest FAILED');
  return ok;
}

async function main() {
  const L = loadEngine();
  const C = L.combo;
  if (has('--selftest')) { process.exit((await selftest(L)) ? 0 : 1); }
  const objectives = csv(flag('--objective', 'dps'));
  const B = flag('--budget', 'small');
  const budget = { small: 150, medium: 600, large: 2000 }[B] || +B || 150;
  const cfg = {
    objectives, budget,
    seeds: +flag('--seeds', B === 'small' ? 2 : 3), verifySeeds: +flag('--verify', B === 'small' ? 8 : 20),
    verifyTop: +flag('--verify-top', 10), shortlist: +flag('--shortlist', B === 'small' ? 20 : 28),
    assume: { grade: isNaN(+flag('--grade', 'max')) ? flag('--grade', 'max') : +flag('--grade'), level: +flag('--level', 100), skillLevel: +flag('--skill', 10) },
    dummy: { layout: flag('--layout', 'f3m2'), turns: +flag('--dummy-turns', 20), burstTurns: +flag('--burst-turns', 3), hpMul: +flag('--hpmul', 10), level: +flag('--dummy-level', 100) },
    endurance: { stageKey: flag('--stage', 'Ch11Stage08'), turns: +flag('--endure-turns', B === 'small' ? 20 : 30), hpMul: +flag('--endure-hpmul', 1000), atkMul: +flag('--endure-atkmul', 1), regen: !has('--no-regen'), wave: flag('--wave', 'last') },
    stage: { stageKey: flag('--stage', 'Ch11Stage08'), maxTurns: +flag('--stage-turns', 120) },
    pool: { search: flag('--pool', ''), include: csv(flag('--include')), exclude: csv(flag('--exclude')) },
    locked: csv(flag('--lock')),
    baseSeed: +flag('--seed', 1000),
  };
  if (flag('--weights')) { cfg.weights = {}; for (const kv of csv(flag('--weights'))) { const [k, v] = kv.split('='); cfg.weights[k] = +v; } }
  const nThreads = Math.max(1, +flag('--threads', Math.min(6, Math.max(1, os.cpus().length - 1))));
  const pool = makePool(nThreads);
  console.log(`combo search: objectives=${objectives.join(',')} budget=${budget} seeds=${cfg.seeds} verify=${cfg.verifySeeds} threads=${nThreads}`);
  let lastPrint = 0;
  const t0 = Date.now();
  const res = await C.search(cfg, {
    evalMany: (jobs, onEach) => pool.evalMany(jobs, onEach),
    progress: (p) => { if (Date.now() - lastPrint > 3000) { lastPrint = Date.now(); console.log(`  [${(p.elapsedMs / 1000).toFixed(0)}s] ${p.phase} · 평가 ${p.evals} · 전투 ${p.battles}${p.best != null ? ' · 최고 ' + C.fmt(p.best) : ''}`); } },
    log: (m) => console.log(m),
  });
  pool.close();
  const nm = (k) => res.names[k] || k;
  for (const [obj, o] of Object.entries(res.objectives)) {
    console.log(`\n=== ${o.label} (${o.unit}) — ${o.evals} evals, ${o.battles} battles, ${(o.ms / 1000).toFixed(1)}s`);
    o.top.slice(0, 5).forEach((t, i) => {
      console.log(`${i + 1}. ${C.fmt(t.score)}  ${t.squad.slice().sort((a, b) => a.gridPos - b.gridPos).map((m) => nm(m.key) + '@' + m.gridPos).join(', ')}`);
      console.log('   ' + C.metricsLine(t, obj, res));
      if (t.loo) console.log('   기여: ' + t.loo.slice().sort((a, b) => b.delta - a.delta).map((l) => `${nm(l.key)} ${C.fmt(l.pct, 0)}%`).join(', '));
      if (t.pairs && t.pairs.length) console.log('   시너지: ' + t.pairs.slice(0, 2).map((p) => `${nm(p.a)}+${nm(p.b)} ${C.fmt(p.pct, 0)}%`).join(', '));
    });
    for (const c of o.callouts) console.log('   ! ' + c.text);
    for (const [p, sc] of Object.entries(o.screening)) console.log(`   선별(${p}) 단독 상위: ` + sc.soloTop.slice(0, 6).map((x) => `${nm(x.key)} ${C.fmt(x.v)}`).join(', '));
  }
  if (res.engineFlags.length) console.log('\nengine flags:', res.engineFlags.slice(0, 5));
  const outDir = path.join(__dirname, 'out');
  fs.mkdirSync(outDir, { recursive: true });
  const stem = path.join(outDir, `combo-${objectives.join('_')}-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`);
  fs.writeFileSync(stem + '.json', JSON.stringify(res, null, 1));
  fs.writeFileSync(stem + '.md', C.reportMarkdown(res));
  console.log(`\nsaved ${stem}.json / .md · total ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}
main().catch((e) => { console.error(e); process.exit(1); });
