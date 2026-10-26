// Level-growth ("스탯 자동 분배") check for every combat PC at every level 1..120.
//   node tools/stat_test.js
// 1) data: Table_PCAbility row present, growth per level >= 0, no zero growth on ATK/DEF/HP, outliers against the role median
// 2) stat build: expected value from the table formula (ActorAttr.cs:249-285, enchant points no longer added :337)
//    vs the simulator's buildPC at every level (start grade, no equipment / core link / favor)
// 3) battle: the PC's stats on the battlefield at battle start (levels 1, 30, 60, 90, 120) vs the expected values;
//    differences are listed with the buffs active at that moment (passives) so they can be told apart from errors.
// Writes tools/out/stat-test.json
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

const E = L.E, ABS = E.VALUE_TYPE.ABS, RATE = E.VALUE_TYPE.RATE, A = E.ACTOR_ATTR_TYPE;
const num = L.num;
const MAX_LV = 120;
const STATS = [
  ['ATK', ABS, A.ATK, 'AttackDmg', 'AddAttackDmgByLevel'],
  ['DEF', ABS, A.DEF, 'DefenseDmg', 'AddDefenseDmgByLevel'],
  ['HP', ABS, A.HP, 'DefaultHP', 'DefaultHPByLevel'],
  ['ACC', RATE, A.APPLY, 'ApplyRate', 'AddApplyRateByLevel'],
  ['EVA', RATE, A.EVADE, 'EvadeRate', 'AddEvadeRateByLevel'],
  ['CRI', RATE, A.CRI, 'CriRate', 'AddCriRateByLevel'],
];
const expected = (pa, lv) => Object.fromEntries(STATS.map(([n, , , b, g]) => [n, num(pa, b) + num(pa, g) * (lv - 1)]));
const close = (a, b) => Math.abs(a - b) <= Math.max(1e-6, Math.abs(b) * 1e-6) + 0.5 * (Number.isInteger(b) ? 0 : 0);
const valueOf = (attr, vt, at) => attr[vt][at];

const pcs = Object.values(L.T('Table_PC')).filter((p) => num(p, 'IsUse') === 1 && num(p, 'IsHavingTurn') === 1 && !/Dummy|Test/i.test(p.Key));
const out = { at: new Date().toISOString(), pcs: pcs.length, missingAbility: [], data: [], build: [], battle: [], battleNotes: [], perPC: {} };

// ---- 1) data
const byRole = {};
for (const p of pcs) {
  const pa = L.T('Table_PCAbility', p.Key);
  if (!pa) { out.missingAbility.push(p.Key); continue; }
  const role = num(p, 'RoleType');
  for (const [n, , , b, g] of STATS) {
    if (num(pa, g) < 0) out.data.push({ pc: p.Key, stat: n, issue: 'negative growth', growth: num(pa, g) });
    if (['ATK', 'DEF', 'HP'].includes(n) && num(pa, g) === 0) out.data.push({ pc: p.Key, stat: n, issue: 'no growth per level', base: num(pa, b) });
    if (num(pa, b) < 0) out.data.push({ pc: p.Key, stat: n, issue: 'negative base', base: num(pa, b) });
  }
  const e120 = expected(pa, MAX_LV);
  (byRole[role] = byRole[role] || []).push({ key: p.Key, e120 });
}
const median = (xs) => { const s = xs.slice().sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : 0; };
for (const [role, list] of Object.entries(byRole)) {
  for (const n of ['ATK', 'DEF', 'HP']) {
    const md = median(list.map((x) => x.e120[n]));
    for (const x of list) {
      const r = md ? x.e120[n] / md : 0;
      if (r > 2.5 || r < 0.4) out.data.push({ pc: x.key, stat: n, issue: 'outlier at Lv120 vs role median', role: +role, value: Math.round(x.e120[n]), roleMedian: Math.round(md), ratio: Math.round(r * 100) / 100 });
    }
  }
}

// ---- 2) build at every level
for (const p of pcs) {
  const pa = L.T('Table_PCAbility', p.Key);
  if (!pa) continue;
  let bad = 0;
  for (let lv = 1; lv <= MAX_LV; lv++) {
    const spec = Object.assign(L.stats.defaultSpec(p.Key), { level: lv, gridPos: 4 });
    const u = L.stats.buildPC(spec);
    const ex = expected(pa, lv);
    for (const [n, vt, at] of STATS) {
      const got = valueOf(u.base || u.attr, vt, at);
      if (!close(got, ex[n])) { bad++; if (out.build.length < 200) out.build.push({ pc: p.Key, level: lv, stat: n, expected: ex[n], got }); }
    }
    if (Math.abs(u.maxHp - ex.HP) > 1) { bad++; if (out.build.length < 200) out.build.push({ pc: p.Key, level: lv, stat: 'maxHp', expected: ex.HP, got: u.maxHp }); }
  }
  out.perPC[p.Key] = { buildMismatch: bad };
}

// ---- 3) on the battlefield at battle start
const BATTLE_LV = [1, 30, 60, 90, 120];
for (const p of pcs) {
  const pa = L.T('Table_PCAbility', p.Key);
  if (!pa) continue;
  for (const lv of BATTLE_LV) {
    let b;
    try {
      b = L.battle.create({ mode: 'stage', stageKey: 'Ch01Stage01', squad: [Object.assign(L.stats.defaultSpec(p.Key), { level: lv, gridPos: 4 })], seed: 1, options: { maxActions: 50 } });
      L.battle.step(b); // wave spawn + game start triggers (passives)
    } catch (e) { out.battle.push({ pc: p.Key, level: lv, issue: 'battle error', msg: String(e.message || e).slice(0, 200) }); continue; }
    const u = b.allUnits.find((x) => x.team === 1 && x.key === p.Key);
    if (!u) { out.battle.push({ pc: p.Key, level: lv, issue: 'PC missing on battlefield' }); continue; }
    const ex = expected(pa, lv);
    for (const [n, vt, at] of STATS) {
      const base = valueOf(u.base, vt, at);
      if (!close(base, ex[n])) out.battle.push({ pc: p.Key, level: lv, stat: n, issue: 'base stat differs', expected: ex[n], got: base });
      const cur = valueOf(u.attr, vt, at);
      if (!close(cur, ex[n]) && out.battleNotes.length < 400) out.battleNotes.push({ pc: p.Key, level: lv, stat: n, expected: ex[n], current: cur, buffs: (u.buffs || []).map((x) => x.key).slice(0, 6) });
    }
    if (Math.abs(u.maxHp - ex.HP) > 1 && !(u.buffs || []).length) out.battle.push({ pc: p.Key, level: lv, stat: 'maxHp', issue: 'max HP differs', expected: ex.HP, got: u.maxHp });
  }
}

const file = path.join(__dirname, 'out', 'stat-test.json');
fs.writeFileSync(file, JSON.stringify(out, null, 1));
console.log('pcs', pcs.length, 'missingAbility', out.missingAbility.length, 'data issues', out.data.length, 'build mismatches', out.build.length, 'battle issues', out.battle.length, 'battle notes (buffed)', out.battleNotes.length, '->', file);
