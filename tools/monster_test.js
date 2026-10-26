// Monster behaviour test: every Table_Monster row fights a fixed, very durable PC squad so its Lua AI runs for many turns.
//   node tools/monster_test.js [--only key1,key2] [--turns 16] [--max 600] [--threads N]
// Checks per monster and placement (front / back column):
//   crash (engine exception), stuck (engine stall detection), Lua errors, no turn taken,
//   long wait streaks (and why: the script chose Wait, or a chosen skill was converted to Wait),
//   move loops, Lua decision vs executed action, skill 1 / skill 2 usage sequence.
// Writes tools/out/monster-test.json
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
  return L;
}

// PC side: front column 2/5/8, mid 4, back 1. Durable, and they only wait (see workerMain) so the monster keeps acting.
function pickSquad(L) {
  const pcs = Object.values(L.T('Table_PC')).filter((p) => L.num(p, 'IsUse') === 1 && L.num(p, 'IsHavingTurn') === 1 && !/Dummy|Test/i.test(p.Key) && L.T('Table_PCAbility', p.Key));
  const byRole = (r) => pcs.filter((p) => L.num(p, 'RoleType') === r).map((p) => p.Key).sort();
  const tank = byRole(0), dps = byRole(1), sup = byRole(2);
  const keys = [tank[0], tank[1], dps[0], dps[1], sup[0]];
  return keys.map((k, i) => Object.assign(L.stats.defaultSpec(k), { level: 100, gridPos: [5, 2, 8, 4, 1][i] }));
}
const SAFE = [
  { table: 'Table_PCAbility', field: 'DefaultHP', op: 'mul', value: 200 },
  { table: 'Table_PCAbility', field: 'DefaultHPByLevel', op: 'mul', value: 200 },
  { table: 'Table_PCAbility', field: 'AttackDmg', op: 'mul', value: 0.02 },
  { table: 'Table_PCAbility', field: 'AddAttackDmgByLevel', op: 'mul', value: 0.02 },
];
const PLACES = [{ id: 'front', gridPos: 3 }, { id: 'back', gridPos: 5 }];

function testOne(L, key, squad, o) {
  const mon = L.T('Table_Monster', key);
  const level = 70; // fixed: DefaultLevel is 1 for most rows
  const aiKey = L.str(mon, 'AIKeyString');
  const out = { key, name: L.name(mon.Name, key), aiKey, level, places: {} };
  for (const pl of PLACES) {
    const r = { outcome: '', reason: '', actions: 0, seq: [], waits: 0, moves: 0, s1: 0, s2: 0, other: 0, maxWaitStreak: 0, waitWhy: {}, maxMoveStreak: 0,
      mismatch: [], luaErrors: [], error: '', firstTurnAt: -1 };
    let b;
    try {
      b = L.battle.create({ mode: 'stage', squad, seed: 7, logEnabled: false, customWaves: [[{ key, level, gridPos: pl.gridPos, hpMul: 5000 }]], options: { maxActions: o.max } });
      // record what the Lua script queued for the monster, to compare with the action actually taken
      const orig = L.ai.processMonster;
      let decided = null;
      L.ai.processMonster = function (battle, unit) { orig.call(this, battle, unit); if (battle === b && unit.key === key) decided = (unit.reserveSkillList || []).map((s) => s.skillKey); };
      let wStreak = 0, mStreak = 0, total = 0;
      try {
        while (!b.result) {
          const n0 = b.log.length;
          b.logEnabled = true;
          L.battle.step(b);
          for (let i = n0; i < b.log.length; i++) {
            const e = b.log[i];
            if (e.t !== 'action' || !e.actor || e.actor.key !== key) continue;
            total++;
            if (r.firstTurnAt < 0) r.firstTurnAt = b.totalActions;
            let tag;
            if (e.kind === 'skill') { const sl = e.slot === 1 ? 1 : e.slot === 2 ? 2 : 0; if (sl === 1) r.s1++; else if (sl === 2) r.s2++; else r.other++; tag = sl ? String(sl) : 'S'; wStreak = 0; mStreak = 0; }
            else if (e.kind === 'move') { r.moves++; tag = 'M'; mStreak++; wStreak = 0; }
            else { r.waits++; tag = 'W'; wStreak++; mStreak = 0;
              const why = e.reason ? e.reason : decided && decided[0] && decided[0] !== 'Wait' && decided[0] !== 'Move' ? 'skill-converted' : 'script-wait';
              r.waitWhy[why] = (r.waitWhy[why] || 0) + 1; }
            if (decided && decided.length) {
              const want = decided[0];
              const did = e.kind === 'skill' ? e.skill : e.kind === 'move' ? 'Move' : 'Wait';
              if (want !== did && r.mismatch.length < 6) r.mismatch.push({ at: total, want, did, why: e.reason || '' });
            }
            decided = null;
            r.seq.push(tag);
            r.maxWaitStreak = Math.max(r.maxWaitStreak, wStreak);
            r.maxMoveStreak = Math.max(r.maxMoveStreak, mStreak);
          }
          b.log.length = 0;
          if (total >= o.turns) break;
        }
      } finally { L.ai.processMonster = orig; }
      r.actions = total;
      r.outcome = b.result || 'running'; r.reason = b.resultReason || '';
      r.totalActions = b.totalActions;
      r.luaErrors = (b.luaErrors || []).slice(0, 3).map((e) => ({ kind: e.kind, msg: String(e.msg || '').slice(0, 200) }));
      r.engineErrors = (b.errors || []).slice(0, 3).map((e) => String(e.message || e.msg || e).slice(0, 200));
    } catch (e) {
      r.error = String((e && e.stack) || e).split('\n').slice(0, 3).join(' | ');
    }
    r.seq = r.seq.join('');
    out.places[pl.id] = r;
  }
  return out;
}

function workerMain() {
  const L = loadEngine();
  const ov = L.applyOverrides(SAFE);
  // the PC side only waits: no AP drain / stun / kill interferes with the monster's own AI
  L.ai.autoCharacter = function (battle, unit) { unit.reserveSkillList = [{ aid: unit.aid, skillKey: L.C.SKILLKEY_WAIT || 'Wait', targetAid: 0, targetGridPos: 0 }]; };
  const squad = pickSquad(L);
  parentPort.on('message', (m) => {
    const res = m.keys.map((k) => { try { return testOne(L, k, squad, m.o); } catch (e) { return { key: k, fatal: String(e && e.stack || e) }; } });
    parentPort.postMessage({ res });
  });
  parentPort.postMessage({ ready: true, squad: squad.map((s) => s.key + '@' + s.gridPos) });
  void ov;
}

async function main() {
  const args = process.argv.slice(2);
  const arg = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
  const o = { turns: +arg('turns', 20), max: +arg('max', 1500) };
  const L = loadEngine();
  let keys = Object.keys(L.T('Table_Monster'));
  if (arg('only')) keys = arg('only').split(',');
  const threads = Math.max(1, Math.min(+arg('threads', os.cpus().length - 1), 16));
  const chunks = [];
  for (let i = 0; i < keys.length; i += 8) chunks.push(keys.slice(i, i + 8));
  const results = [];
  let squadInfo = null, done = 0;
  const t0 = Date.now();
  await Promise.all(Array.from({ length: threads }, () => new Promise((resolve, reject) => {
    const w = new Worker(__filename, { workerData: {} });
    const next = () => { const c = chunks.shift(); if (!c) { w.terminate(); resolve(); return; } w.postMessage({ keys: c, o }); };
    w.on('message', (m) => {
      if (m.ready) { squadInfo = m.squad; next(); return; }
      results.push(...m.res); done += m.res.length;
      if (done % 80 < 8) process.stderr.write(`  ${done}/${keys.length} (${Math.round((Date.now() - t0) / 1000)}s)\n`);
      next();
    });
    w.on('error', reject);
  })));
  results.sort((a, b) => keys.indexOf(a.key) - keys.indexOf(b.key));
  const outDir = path.join(__dirname, 'out');
  fs.mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, 'monster-test.json');
  fs.writeFileSync(file, JSON.stringify({ at: new Date().toISOString(), squad: squadInfo, options: o, results }, null, 1));
  console.log('monsters', results.length, 'in', Math.round((Date.now() - t0) / 1000) + 's ->', file);
}

if (isMainThread) main().catch((e) => { console.error(e); process.exit(1); });
else workerMain();
