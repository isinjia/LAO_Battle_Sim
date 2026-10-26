// Runs community guide squads (tools/out/guide-squads.json) on their stages and compares the turns with the stage missions.
//   node tools/guide_test.js [--seeds 5]
// guide-squads.json: [{ post, title, stage, squad: [{ name|key, gridPos 0-8, level?, grade?, skill? }], source, note }]
//   gridPos: row*3 + col, rows top->bottom, col 0 = back, 2 = front (the in-game formation screen with the enemy on the right).
// Missing level/grade/skill -> Lv100, max grade, skill Lv10 (guides are written for end-game accounts). No equipment.
// Writes tools/out/guide-test.json
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

const args = process.argv.slice(2);
const seeds = +(args[args.indexOf('--seeds') + 1] || 5) || 5;
const OUT = path.join(__dirname, 'out');
const outputArg = args.indexOf('--output-dir');
const RESULT_OUT = outputArg >= 0 ? path.resolve(args[outputArg + 1]) : OUT;
fs.mkdirSync(RESULT_OUT, { recursive: true });
let guides = JSON.parse(fs.readFileSync(path.join(OUT, 'guide-squads.json'), 'utf8'));
const indicesArg = args.indexOf('--indices-file');
if (indicesArg >= 0) {
  const indices = new Set(JSON.parse(fs.readFileSync(args[indicesArg + 1], 'utf8').replace(/^\uFEFF/, '')));
  guides = guides.filter((_, index) => indices.has(index));
}
const timeoutArg = args.indexOf('--run-timeout-ms');
const runTimeoutMs = timeoutArg >= 0 ? Number(args[timeoutArg + 1]) : 0;
if (timeoutArg >= 0 && !(runTimeoutMs > 0)) throw new Error('실행 제한 시간은 양수여야 합니다.');
// --part i/n: run every n-th entry starting at i (parallel processes); output file gets the part suffix
const PART = (() => { const i = args.indexOf('--part'); if (i < 0) return null; const [a, b] = args[i + 1].split('/').map(Number); return { a, b }; })();
if (PART) guides = guides.filter((_, i) => i % PART.b === PART.a);
const names = JSON.parse(fs.readFileSync(path.join(OUT, 'pc-names.json'), 'utf8'));
const missions = JSON.parse(fs.readFileSync(path.join(OUT, 'stage-missions.json'), 'utf8'));
const MIS = Object.fromEntries(missions.map((m) => [m.stage, m.missions]));
const norm = (s) => String(s).replace(/\s+/g, '').toLowerCase();
const NAME = {};
for (const [n, ks] of Object.entries(names)) NAME[norm(n)] = ks[0];

// "대표 장비" (--gear): per equipment slot the allowed item with the best weighted Lv10 stat line (attack/crit/accuracy/speed first).
// Items that only carry a buff (no stat line) are not picked: their value cannot be scored without simulating.
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
function autoGear(key) {
  if (gearCache[key]) return gearCache[key];
  const out = [];
  for (let i = 0; i < 4; i++) {
    const c = L.stats.listEquipCandidates(key, i);
    let best = null, bs = 0;
    for (const k of c) { if (isDev(k)) continue; const sc = eqScore(EQ[k]); if (sc > bs) { bs = sc; best = k; } }
    if (best) out.push({ key: best, enchant: 10 }); else out.push({ key: '', enchant: 0 });
  }
  return (gearCache[key] = out);
}
const GEAR = args.includes('--gear');
// --old: rebuild the pre-rework stats (manual stat points) = r15485 Table_PCAbility + Lv100 points (3/level, 297)
// split per guide: evasion guides (guide-stat-tags.json "회피 빌드") 100 pts evade + 197 attack, the rest 100 pts crit + 197 attack.
// Point values from Table_PCEnchant_StatUpValue (attack 1.5, evade/crit 0.004 per point).
const OLD = args.includes('--old');
const OLDAB = OLD ? JSON.parse(fs.readFileSync(path.join(OUT, 'pcability_r15485.json'), 'utf8')) : null;
const TAGS = OLD && fs.existsSync(path.join(OUT, 'guide-stat-tags.json')) ? JSON.parse(fs.readFileSync(path.join(OUT, 'guide-stat-tags.json'), 'utf8')) : {};
const AB_FIELDS = ['AttackDmg', 'AddAttackDmgByLevel', 'DefenseDmg', 'AddDefenseDmgByLevel', 'DefaultHP', 'DefaultHPByLevel', 'ApplyRate', 'AddApplyRateByLevel', 'EvadeRate', 'AddEvadeRateByLevel', 'CriRate', 'AddCriRateByLevel', 'FireResist', 'IceResist', 'EletronicResist'];
// --reco: instead of the fixed split, each character gets its recommended build A (stat-reco.json, Lv100, with gear)
const RECO = OLD && args.includes('--reco') ? Object.fromEntries(JSON.parse(fs.readFileSync(path.join(OUT, 'stat-reco.json'), 'utf8')).map((r) => [r.key, r.builds[0] && r.builds[0].lv['100'].gear.pts])) : null;
function oldRules(keys, evadeBuild) {
  const rules = [];
  for (const k of keys) {
    const o = OLDAB[k];
    if (!o) continue;
    const v = (f) => Number(o[f] || 0);
    const rp = RECO && RECO[k];
    if (rp) {
      const set2 = { AttackDmg: v('AttackDmg') + rp.atk * 1.5, AddAttackDmgByLevel: v('AddAttackDmgByLevel'), DefenseDmg: v('DefenseDmg') + rp.def * 1.25, AddDefenseDmgByLevel: v('AddDefenseDmgByLevel'),
        DefaultHP: v('DefaultHP') + rp.hp * 8, DefaultHPByLevel: v('DefaultHPByLevel'), ApplyRate: v('ApplyRate') + rp.acc * 0.015, AddApplyRateByLevel: 0,
        EvadeRate: v('EvadeRate') + rp.eva * 0.004, AddEvadeRateByLevel: 0, CriRate: v('CriRate') + rp.crit * 0.004, AddCriRateByLevel: 0 };
      for (const f of AB_FIELDS) rules.push({ table: 'Table_PCAbility', keys: k, field: f, value: set2[f] === undefined ? v(f) : set2[f] });
      continue;
    }
    const set = { AttackDmg: v('AttackDmg') + 197 * 1.5, AddAttackDmgByLevel: v('AddAttackDmgByLevel'), DefenseDmg: v('DefenseDmg'), AddDefenseDmgByLevel: v('AddDefenseDmgByLevel'),
      DefaultHP: v('DefaultHP'), DefaultHPByLevel: v('DefaultHPByLevel'), ApplyRate: v('ApplyRate'), AddApplyRateByLevel: 0,
      EvadeRate: v('EvadeRate') + (evadeBuild ? 100 * 0.004 : 0), AddEvadeRateByLevel: 0, CriRate: v('CriRate') + (evadeBuild ? 0 : 100 * 0.004), AddCriRateByLevel: 0 };
    for (const f of AB_FIELDS) rules.push({ table: 'Table_PCAbility', keys: k, field: f, value: set[f] === undefined ? v(f) : set[f] });
  }
  return rules;
}

function resolve(m) {
  if (m.key && L.T('Table_PC', m.key)) return m.key;
  return NAME[norm(m.name || '')] || null;
}

const results = [];
for (const g of guides) {
  const res = { post: g.post, title: g.title, stage: g.stage, source: g.source || '', note: g.note || '', squad: [], unresolved: [], runs: [], missions: MIS[g.stage] || [] };
  if (!L.T('Table_MapStage', g.stage)) { res.error = 'unknown stage'; results.push(res); continue; }
  const squad = [];
  for (const m of g.squad || []) {
    const key = resolve(m);
    if (!key) { res.unresolved.push(m.name || m.key); continue; }
    const pc = L.T('Table_PC', key);
    const def = L.stats.defaultSpec(key);
    const grade = m.grade ? Math.max(L.num(pc, 'StartGrade', 1), Math.min(L.num(pc, 'MaxGrade', 5), +m.grade)) : (L.num(pc, 'MaxGrade') || 5);
    squad.push(Object.assign(def, { gridPos: m.gridPos | 0, level: +m.level || 100, grade, skillLevels: def.skillLevels.map(() => +m.skill || 10) }, GEAR ? { equips: autoGear(key) } : {}));
    res.squad.push({ key, name: L.name(pc.Name, key), gridPos: m.gridPos | 0, level: +m.level || 100 });
  }
  if (!squad.length) { res.error = 'empty squad'; results.push(res); continue; }
  const ovr = OLD ? L.applyOverrides(oldRules(squad.map((x) => x.key), (TAGS[g.post] || []).includes('회피 빌드'))) : null;
  // rebuild the specs' units inside battle.create, so overrides apply
  for (let s = 1; s <= seeds; s++) {
    try {
      const b = L.battle.create({ mode: 'stage', stageKey: g.stage, squad, seed: s, logEnabled: true, options: { maxActions: 2000 } });
      let pc = 0, extra = 0, wave = 0;
      const started = Date.now();
      let executionTimeout = false;
      while (!b.result) {
        L.battle.step(b);
        for (const e of b.log) if (e.t === 'action' && e.actor && e.actor.team === 1) { if (e.turnType === 'normal') pc++; else extra++; } // a turn = main action only (assist / counter / double / reserve are not turns)
        b.log.length = 0;
        if (b.round > wave) wave = b.round;
        if (!b.result && runTimeoutMs && Date.now() - started >= runTimeoutMs) { executionTimeout = true; break; }
      }
      res.runs.push({ outcome: executionTimeout ? 'execution_timeout' : b.result, reason: executionTimeout ? '모의실험 실행 시간 제한 초과: ' + runTimeoutMs + '밀리초' : b.resultReason || '', pc, extra, total: b.totalRounds, wave, waveReached: b.waveIndex + 1 });
    } catch (e) { res.runs.push({ outcome: 'error', reason: String(e.message || e).slice(0, 200) }); }
  }
  if (ovr) ovr.revert();
  results.push(res);
}
fs.writeFileSync(path.join(RESULT_OUT, (OLD ? (RECO ? 'guide-reco-' : 'guide-old-') : '') + (GEAR ? 'guide-test-gear' : 'guide-test') + (PART ? '.part' + PART.a : '') + '.json'), JSON.stringify({ at: new Date().toISOString(), seeds, gear: GEAR, results }, null, 1));
if (!PART) for (const r of results) {
  const w = r.runs.filter((x) => x.outcome === 'win');
  const mn = (k) => (w.length ? Math.min(...w.map((x) => x[k])) : '-');
  console.log(`${r.stage} ${r.title || ''} | win ${w.length}/${r.runs.length} | pc ${mn('pc')} total ${mn('total')} wave ${mn('wave')} ${r.unresolved.length ? '| unresolved ' + r.unresolved.join(',') : ''}${r.error ? '| ' + r.error : ''}`);
}
