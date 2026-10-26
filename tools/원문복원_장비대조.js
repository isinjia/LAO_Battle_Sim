// 원문 능력치 화면의 표시 값과 일치하는 장비 조합을 장착 가능 후보 전체에서 찾는다.
//   node tools/원문복원_장비대조.js <조건.json>
// 조건.json: { key, level, grade, coreLink, linkBonusKey, favor, points:{...}, enchant: 10,
//             target: {hp, atk, def, acc, eva, crit, spd}, fixed?: [slot별 장비 키 또는 null], tolerance?: {acc:0.05,...} }
// 결과는 일치 조합 목록이며, 하나로 좁혀질 때만 장비가 수치로 특정됐다고 본다. 능력치에 기여하지 않는 장비는 구분할 수 없다.
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

const q = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const OLDAB = JSON.parse(fs.readFileSync(path.join(__dirname, 'out', 'pcability_r15485.json'), 'utf8'));
const PT = { atk: 1.5, def: 1.25, hp: 8, eva: 0.004, crit: 0.004, acc: 0.015 };
const A = L.E.ACTOR_ATTR_TYPE, ABS = L.E.VALUE_TYPE.ABS, RATE = L.E.VALUE_TYPE.RATE;
const o = OLDAB[q.key], v = (f) => Number(o[f] || 0), p = Object.assign({ atk: 0, def: 0, hp: 0, acc: 0, eva: 0, crit: 0 }, q.points || {});
const set = { AttackDmg: v('AttackDmg') + p.atk * PT.atk, AddAttackDmgByLevel: v('AddAttackDmgByLevel'), DefenseDmg: v('DefenseDmg') + p.def * PT.def,
  AddDefenseDmgByLevel: v('AddDefenseDmgByLevel'), DefaultHP: v('DefaultHP') + p.hp * PT.hp, DefaultHPByLevel: v('DefaultHPByLevel'),
  ApplyRate: v('ApplyRate') + p.acc * PT.acc, AddApplyRateByLevel: 0, EvadeRate: v('EvadeRate') + p.eva * PT.eva, AddEvadeRateByLevel: 0,
  CriRate: v('CriRate') + p.crit * PT.crit, AddCriRateByLevel: 0 };
L.applyOverrides(Object.entries(set).map(([field, value]) => ({ table: 'Table_PCAbility', keys: q.key, field, value })));

const EQ = L.T('Table_ItemEquip');
const isDev = (k) => /_Test_/i.test(k) || /테스트/.test(L.name((EQ[k] || {}).ItemName, ''));
const slots = [0, 1, 2, 3].map((i) => (q.fixed && q.fixed[i] !== undefined ? (q.fixed[i] ? [q.fixed[i]] : ['']) : [''].concat(L.stats.listEquipCandidates(q.key, i).filter((k) => !isDev(k)))));
const tol = Object.assign({ hp: 0.5, atk: 0.5, def: 0.5, acc: 0.05, eva: 0.05, crit: 0.05, spd: 0.005 }, q.tolerance || {});
const shown = (u) => { const b = u.base; return { hp: Math.trunc(b[ABS][A.HP]), atk: Math.trunc(b[ABS][A.ATK]), def: Math.trunc(b[ABS][A.DEF]), acc: b[RATE][A.APPLY] * 100, eva: b[RATE][A.EVADE] * 100, crit: b[RATE][A.CRI] * 100, spd: b[ABS][A.TURNSPEED] }; };
const hits = [];
let n = 0;
for (const a of slots[0]) for (const b of slots[1]) for (const c of slots[2]) for (const d of slots[3]) {
  const eq = [a, b, c, d];
  if (new Set(eq.filter(Boolean)).size !== eq.filter(Boolean).length && !q.allowDuplicate) { /* 같은 장비 두 개도 장착 가능하므로 허용 여부를 입력으로 둔다 */ }
  n++;
  const u = L.stats.buildPC({ key: q.key, level: q.level, grade: q.grade, coreLink: q.coreLink || 0, linkBonusKey: q.linkBonusKey || '', favor: q.favor || 0,
    equips: eq.map((k) => ({ key: k, enchant: q.enchant === undefined ? 10 : q.enchant })) });
  const s = shown(u);
  if (Object.keys(q.target).every((k) => Math.abs(s[k] - q.target[k]) <= tol[k])) hits.push({ equips: eq.map((k) => (k ? k + ' ' + L.name(EQ[k].ItemName, k) : '(없음)')), shown: s });
  if (hits.length > 200) break;
}
console.log(JSON.stringify({ combos: n, slotCandidates: slots.map((x) => x.length), matches: hits.length, hits: hits.slice(0, 40) }, null, 1));
