// Can a squad clear each stage faster than the best community guide squad (guide-baseline.json)?
//   node tools/stage_beat_guides.js [--stages a,b] [--threads N] [--random 80] [--gens 5] [--children 36] [--verify 5]
// Same conditions as the guide run: Lv100, max grade, skill Lv10, "대표 장비" (auto gear, see guide_test.js).
// Start population = every guide squad for the stage + random / class / role squads; then mutation generations.
// Score = our actions (pc) on a win, then total rounds, then fewer members. Best per member count is kept too
// ("efficient": same speed with fewer characters). Winners are re-run on more seeds (median reported).
// Writes tools/out/stage-beat-guides.json
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const os = require('os');
const { Worker, isMainThread, parentPort } = require('worker_threads');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(__dirname, 'out');
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

function workerMain() {
  const L = loadEngine();
  const C = L.combo;
  C.installSpeedups();
  // ---- auto gear (same rule as guide_test.js --gear)
  const A = L.E.ACTOR_ATTR_TYPE;
  const W = { [A.ATK]: 1, [A.CRI]: 1, [A.APPLY]: 0.7, [A.TURNSPEED]: 1.2, [A.HP]: 0.4, [A.DEF]: 0.2, [A.EVADE]: 0.2 };
  const EQ = L.T('Table_ItemEquip') || {};
  const lv10 = (eq) => { const t = L.list(eq, 'DefaultAttrType').map(Number), v = L.list(eq, 'Lv10_DefaultAttrValue').map(Number); return t.length === v.length ? t.map((x, i) => [x, v[i]]) : []; };
  const MAXV = {};
  // dev-only items ("테스트 아이템" etc.) are never picked
  const isDev = (k) => /_Test_/i.test(k) || /테스트/.test(L.name((EQ[k] || {}).ItemName, ''));
  for (const k in EQ) if (!isDev(k)) for (const [t, v] of lv10(EQ[k])) MAXV[t] = Math.max(MAXV[t] || 0, Math.abs(v));
  const eqScore = (eq) => lv10(eq).reduce((s, [t, v]) => s + (W[t] || 0) * (MAXV[t] ? v / MAXV[t] : 0), 0) + L.num(eq, 'ItemGrade') * 0.01;
  const gearCache = {};
  const autoGear = (key) => gearCache[key] || (gearCache[key] = [0, 1, 2, 3].map((i) => {
    let best = null, bs = 0;
    for (const k of L.stats.listEquipCandidates(key, i)) { if (isDev(k)) continue; const sc = eqScore(EQ[k]); if (sc > bs) { bs = sc; best = k; } }
    return best ? { key: best, enchant: 10 } : { key: '', enchant: 0 };
  }));
  const spec = (m) => { const s = C.makeSpec(m.key, m.gridPos); s.equips = autoGear(m.key); return s; };

  const pool = C.pcPool().filter((p) => !/Module|_Core_/.test(p.key));
  const allKeys = pool.map((p) => p.key);
  const allByCls = {}, allByRole = {};
  for (const p of pool) { (allByCls[p.cls] = allByCls[p.cls] || []).push(p.key); (allByRole[p.role] = allByRole[p.role] || []).push(p.key); }
  let rs = 1;
  const rnd = () => { rs = (rs * 1103515245 + 12345) >>> 0; return rs / 4294967296; };
  const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
  const sample = (arr, n, avoid) => { const out = []; const seen = new Set(avoid || []); let g = 0; while (out.length < n && g++ < 500) { const k = pick(arr); if (!seen.has(k)) { seen.add(k); out.push(k); } } return out; };
  const form = (ks) => C.autoFormation(ks);

  function run(stage, sq, seed) {
    const b = L.battle.create({ mode: 'stage', stageKey: stage, squad: sq.map(spec), seed, logEnabled: true, options: { maxActions: 600 } });
    let pc = 0, extra = 0;
    while (!b.result) {
      L.battle.step(b);
      for (const e of b.log) if (e.t === 'action' && e.actor && e.actor.team === 1) { if (e.turnType === 'normal') pc++; else extra++; } // a turn = main action only (assist / counter / double / reserve are not turns)
      b.log.length = 0;
    }
    return { win: b.result === 'win', pc, extra, total: b.totalRounds, waves: b.waveIndex + 1 };
  }
  // the median run by total rounds (then our turns): all reported numbers of a squad come from this one run
  const medRun = (w) => { if (!w.length) return null; const a = w.slice().sort((x, y) => x.total - y.total || x.pc - y.pc); return a[Math.floor(a.length / 2)]; };
  const score = (r, n) => (r.win ? r.total * 1000 + r.pc * 10 + n : 1e7 - r.waves * 1e5 + r.total); // total rounds first (clear time), then our actions, then members

  function searchStage(it, o) {
    rs = 7 + it.stage.length * 7919;
    // --budget: same investment as the guide = only characters whose start grade is not above the guide's best one,
    // and no more members than the guide used
    let keys = allKeys, byCls = allByCls, byRole = allByRole, maxN = 5;
    if (o.budget) {
      const sg = (k) => L.num(L.T('Table_PC', k), 'StartGrade', 1);
      const cap = Math.max(...it.base.squad.map((m) => sg(m.key)));
      maxN = it.base.squad.length;
      keys = allKeys.filter((k) => sg(k) <= cap);
      byCls = {}; byRole = {};
      for (const p of pool) if (keys.includes(p.key)) { (byCls[p.cls] = byCls[p.cls] || []).push(p.key); (byRole[p.role] = byRole[p.role] || []).push(p.key); }
    }
    const okSq = (sq) => sq.length <= maxN && sq.every((m) => keys.includes(m.key));
    const seen = new Map();
    let battles = 0;
    const evalSq = (sq) => {
      if (!sq.length || !okSq(sq)) return { sq, r: { win: false }, s: 1e9 };
      const k = C.squadKey(sq);
      if (seen.has(k)) return seen.get(k);
      let r; try { r = run(it.stage, sq, 1); } catch (e) { r = { win: false, pc: 999, total: 999, waves: 0 }; }
      battles++;
      const v = { sq, r, s: score(r, sq.length) };
      seen.set(k, v);
      return v;
    };
    const starts = [];
    for (const g of it.guides) starts.push(g);
    for (const g of it.guides) if (g.length > 1) starts.push(form(g.map((m) => m.key))); // guide members, auto cells
    for (let i = 0; i < o.random; i++) starts.push(form(sample(keys, 1 + Math.floor(rnd() * maxN))));
    for (const cls of Object.keys(byCls)) for (let i = 0; i < 6; i++) starts.push(form(sample(byCls[cls], maxN)));
    for (let i = 0; i < 16; i++) { const ks = []; ks.push(...sample(byRole[0] || [], 1, ks)); ks.push(...sample(byRole[1] || [], 3, ks)); ks.push(...sample(byRole[2] || [], 1, ks)); if (ks.length === 5) starts.push(form(ks)); }
    let pop = starts.map(evalSq);
    for (let g = 0; g < o.gens; g++) {
      pop.sort((a, b) => a.s - b.s);
      const elite = pop.slice(0, 14);
      for (let i = 0; i < o.children; i++) {
        const a = pick(elite).sq;
        let ks = a.map((m) => m.key);
        const t = rnd();
        let child;
        if (t < 0.3) { const j = Math.floor(rnd() * ks.length); ks[j] = sample(keys, 1, ks)[0] || ks[j]; child = form(ks); }
        else if (t < 0.45 && ks.length > 1) { ks.splice(Math.floor(rnd() * ks.length), 1); child = a.filter((m) => ks.includes(m.key)).map((m) => Object.assign({}, m)); } // drop a member
        else if (t < 0.55 && ks.length < 5) { const add = sample(keys, 1, ks)[0]; child = form(ks.concat(add)); }
        else if (t < 0.7) { const b2 = pick(elite).sq.map((m) => m.key); const mix = [...new Set(ks.slice(0, Math.max(1, Math.floor(rnd() * ks.length))).concat(b2))].slice(0, 5); child = form(mix); }
        else if (t < 0.85) { child = a.map((m) => Object.assign({}, m)); const j = Math.floor(rnd() * child.length); const used = new Set(child.map((m) => m.gridPos)); const free = [0, 1, 2, 3, 4, 5, 6, 7, 8].filter((x) => !used.has(x)); if (free.length) child[j].gridPos = pick(free); }
        else { child = a.map((m) => Object.assign({}, m)); if (child.length > 1) { const i1 = Math.floor(rnd() * child.length), i2 = Math.floor(rnd() * child.length); const tg = child[i1].gridPos; child[i1].gridPos = child[i2].gridPos; child[i2].gridPos = tg; } }
        pop.push(evalSq(child));
      }
    }
    // verify: best overall + best per member count, on more seeds
    const wins = [...seen.values()].filter((v) => v.r.win).sort((a, b) => a.s - b.s);
    const picks = [];
    if (wins[0]) picks.push(wins[0]);
    for (let n = 1; n <= 5; n++) { const b = wins.find((v) => v.sq.length === n); if (b && !picks.includes(b)) picks.push(b); }
    for (const v of wins.slice(1, 4)) if (!picks.includes(v)) picks.push(v);
    const verified = picks.map((v) => {
      const runs = [];
      for (let s = 1; s <= o.verify; s++) { try { runs.push(run(it.stage, v.sq, s)); } catch (e) { runs.push({ win: false }); } battles++; }
      const w = runs.filter((x) => x.win);
      const m = medRun(w);
      return { squad: v.sq.map((m) => m.key + '@' + m.gridPos), members: v.sq.length, wins: w.length, runs: runs.length, minPc: w.length ? Math.min(...w.map((x) => x.pc)) : null, medPc: m ? m.pc : null, medExtra: m ? m.extra : null, minTotal: w.length ? Math.min(...w.map((x) => x.total)) : null, medTotal: m ? m.total : null };
    });
    // the guide baseline on the same seeds (fair comparison)
    const gRuns = [];
    for (let s = 1; s <= o.verify; s++) { try { gRuns.push(run(it.stage, it.base.squad, s)); } catch (e) { gRuns.push({ win: false }); } battles++; }
    const gw = gRuns.filter((x) => x.win);
    const gm = medRun(gw);
    const guide = { post: it.base.post, title: it.base.title, squad: it.base.squad.map((m) => m.key + '@' + m.gridPos), members: it.base.squad.length, wins: gw.length, runs: gRuns.length,
      minPc: gw.length ? Math.min(...gw.map((x) => x.pc)) : null, medPc: gm ? gm.pc : null, medExtra: gm ? gm.extra : null, minTotal: gw.length ? Math.min(...gw.map((x) => x.total)) : null, medTotal: gm ? gm.total : null };
    return { stage: it.stage, battles, squadsTried: seen.size, guide, verified };
  }
  parentPort.on('message', (m) => { parentPort.postMessage({ res: searchStage(m.it, m.o) }); });
  parentPort.postMessage({ ready: true });
}

async function main() {
  const args = process.argv.slice(2);
  const arg = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
  const o = { random: +arg('random', 80), gens: +arg('gens', 5), children: +arg('children', 36), verify: +arg('verify', 5), budget: args.includes('--budget') };
  const base = JSON.parse(fs.readFileSync(path.join(OUT, 'guide-baseline.json'), 'utf8'));
  const gs = JSON.parse(fs.readFileSync(path.join(OUT, 'guide-squads.json'), 'utf8'));
  const byStage = {};
  for (const g of gs) (byStage[g.stage] = byStage[g.stage] || []).push(g.squad.map((m) => ({ key: m.key, gridPos: m.gridPos })));
  let items = Object.entries(base).map(([stage, b]) => ({ stage, base: b, guides: (byStage[stage] || []).slice(0, 40).concat([b.squad]) }));
  if (arg('stages')) { const w = new Set(arg('stages').split(',')); items = items.filter((x) => w.has(x.stage)); }
  const threads = Math.max(1, Math.min(+arg('threads', os.cpus().length - 1), 16));
  const queue = items.slice();
  const results = [];
  const t0 = Date.now();
  await Promise.all(Array.from({ length: threads }, () => new Promise((resolve, reject) => {
    const w = new Worker(__filename);
    const next = () => { const it = queue.shift(); if (!it) { w.terminate(); resolve(); return; } w.postMessage({ it, o }); };
    w.on('message', (m) => {
      if (m.ready) { next(); return; }
      results.push(m.res);
      const v = m.res.verified[0];
      process.stderr.write(`  ${results.length}/${items.length} ${m.res.stage} guide total ${m.res.guide.minTotal} -> best ${v ? v.minTotal : '-'} (${v ? v.members : '-'}명, ${m.res.squadsTried} squads, ${Math.round((Date.now() - t0) / 1000)}s)\n`);
      next();
    });
    w.on('error', reject);
  })));
  results.sort((a, b) => a.stage.localeCompare(b.stage));
  fs.writeFileSync(path.join(OUT, arg('out', 'stage-beat-guides.json')), JSON.stringify({ at: new Date().toISOString(), options: o, results }, null, 1));
  console.log('stages', results.length, 'in', Math.round((Date.now() - t0) / 1000) + 's');
}

if (isMainThread) main().catch((e) => { console.error(e); process.exit(1); });
else workerMain();
