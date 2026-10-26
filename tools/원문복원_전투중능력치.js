// 시험 입력 한 항목으로 전투를 만들고, 첫 행동 직전(전투 시작 버프 적용 후)의 아군 회피·적중·치명을 출력한다.
//   node tools/원문복원_전투중능력치.js <시험입력.json> <id>
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');
const ROOT = path.join(__dirname, '..');
global.window = global; global.fengari = require('fengari');
const run = (p) => vm.runInThisContext(fs.readFileSync(p, 'utf8'), { filename: p });
run(path.join(ROOT, 'engine', 'enums.js')); run(path.join(ROOT, 'engine', 'core.js'));
const L = global.LOSim; L.data = {};
for (const f of ['stages', 'units', 'skills', 'buffs', 'loc', 'lua']) L.data[f] = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', f + '.json'), 'utf8'));
for (const m of ['stats', 'buffs', 'combat', 'ai', 'battle']) run(path.join(ROOT, 'engine', m + '.js'));
const OLDAB = JSON.parse(fs.readFileSync(path.join(__dirname, 'out', 'pcability_r15485.json'), 'utf8'));
const PT = { atk: 1.5, def: 1.25, hp: 8, eva: 0.004, crit: 0.004, acc: 0.015 };
const c = JSON.parse(fs.readFileSync(process.argv[2], 'utf8')).find((x) => x.id === process.argv[3]);
const rules = [];
for (const m of c.squad) {
  const o = OLDAB[m.key], v = (f) => Number(o[f] || 0), p = Object.assign({ atk: 0, def: 0, hp: 0, acc: 0, eva: 0, crit: 0 }, m.points || {});
  const set = { AttackDmg: v('AttackDmg') + p.atk * PT.atk, AddAttackDmgByLevel: v('AddAttackDmgByLevel'), DefenseDmg: v('DefenseDmg') + p.def * PT.def, AddDefenseDmgByLevel: v('AddDefenseDmgByLevel'),
    DefaultHP: v('DefaultHP') + p.hp * PT.hp, DefaultHPByLevel: v('DefaultHPByLevel'), ApplyRate: v('ApplyRate') + p.acc * PT.acc, AddApplyRateByLevel: 0,
    EvadeRate: v('EvadeRate') + p.eva * PT.eva, AddEvadeRateByLevel: 0, CriRate: v('CriRate') + p.crit * PT.crit, AddCriRateByLevel: 0 };
  for (const [field, value] of Object.entries(set)) rules.push({ table: 'Table_PCAbility', keys: m.key, field, value });
}
L.applyOverrides(rules);
const squad = c.squad.map((m) => Object.assign(L.stats.defaultSpec(m.key), m));
const b = L.battle.create({ mode: 'stage', stageKey: c.stage, squad, seed: 1, logEnabled: true, options: { maxActions: 50 } });
L.battle.step(b);
const A = L.E.ACTOR_ATTR_TYPE, R = L.E.VALUE_TYPE.RATE;
for (const u of b.units) console.log(u.team === 1 ? '아군' : '적', u.key, '칸', u.gridPos, '회피', (u.attr[R][A.EVADE] * 100).toFixed(1), '적중', (u.attr[R][A.APPLY] * 100).toFixed(1), '치명', (u.attr[R][A.CRI] * 100).toFixed(1), '버프', (u.buffs || []).map((x) => x.key || x.effectKey).slice(0, 8).join(','));
