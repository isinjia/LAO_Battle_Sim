// Recommended stat-point builds per character (manual stat-point era = r15485 growth table + points).
//   node tools/stat_reco_build.js        -> tools/out/stat-reco.json
// For every combat character: stats before points at Lv100 / Lv120 (max grade, promotion bonus) without gear and with
// "대표 장비"; community targets (stat-reco-community.json) are turned into points:
//   points = ceil((target - current) / per-point), capped per stat (crit/evade 100, accuracy 300) and by the budget
//   (Lv100 297, Lv120 357); the rest goes to the stat the community puts "나머지" into (attack by default).
// Build A = community standard; build B = a distinct alternative seen in the guides (evasion / HP / defence),
// otherwise the role template. Characters without community data use the median targets of their role+class group.
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(__dirname, 'out');
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
const C = L.combo, A = L.E.ACTOR_ATTR_TYPE, ABS = L.E.VALUE_TYPE.ABS, RATE = L.E.VALUE_TYPE.RATE;

const OLDAB = JSON.parse(fs.readFileSync(path.join(OUT, 'pcability_r15485.json'), 'utf8'));
const COM = JSON.parse(fs.readFileSync(path.join(OUT, 'stat-reco-community.json'), 'utf8'));
const PER = { atk: 1.5, def: 1.25, hp: 8, acc: 0.015, eva: 0.004, crit: 0.004 };
const CAP = { crit: 100, eva: 100, acc: 300, atk: 9999, def: 9999, hp: 9999 };
const BUDGET = { 100: 297, 120: 357 };
const FIELDS = ['AttackDmg', 'AddAttackDmgByLevel', 'DefenseDmg', 'AddDefenseDmgByLevel', 'DefaultHP', 'DefaultHPByLevel', 'ApplyRate', 'AddApplyRateByLevel', 'EvadeRate', 'AddEvadeRateByLevel', 'CriRate', 'AddCriRateByLevel'];
// old growth table in place (rate stats had no level growth then)
const rules = [];
for (const [k, o] of Object.entries(OLDAB)) {
  if (!L.T('Table_PCAbility', k)) continue;
  for (const f of FIELDS) rules.push({ table: 'Table_PCAbility', keys: k, field: f, value: /^Add(Apply|Evade|Cri)RateByLevel$/.test(f) ? 0 : Number(o[f] || 0) });
}
L.applyOverrides(rules);

// auto gear (same rule as guide_test.js --gear, test items excluded)
const EQ = L.T('Table_ItemEquip') || {};
const W = { [A.ATK]: 1, [A.CRI]: 1, [A.APPLY]: 0.7, [A.TURNSPEED]: 1.2, [A.HP]: 0.4, [A.DEF]: 0.2, [A.EVADE]: 0.2 };
const lv10 = (eq) => { const t = L.list(eq, 'DefaultAttrType').map(Number), v = L.list(eq, 'Lv10_DefaultAttrValue').map(Number); return t.length === v.length ? t.map((x, i) => [x, v[i]]) : []; };
const isDev = (k) => /_Test_/i.test(k) || /테스트/.test(L.name((EQ[k] || {}).ItemName, ''));
const MAXV = {};
for (const k in EQ) if (!isDev(k)) for (const [t, v] of lv10(EQ[k])) MAXV[t] = Math.max(MAXV[t] || 0, Math.abs(v));
const eqScore = (eq) => lv10(eq).reduce((s, [t, v]) => s + (W[t] || 0) * (MAXV[t] ? v / MAXV[t] : 0), 0) + L.num(eq, 'ItemGrade') * 0.01;
const autoGear = (key) => [0, 1, 2, 3].map((i) => { let b = null, bs = 0; for (const k of L.stats.listEquipCandidates(key, i)) { if (isDev(k)) continue; const s = eqScore(EQ[k]); if (s > bs) { bs = s; b = k; } } return b ? { key: b, enchant: 10 } : { key: '', enchant: 0 }; });

function stats(key, level, gear) {
  const s = Object.assign(C.makeSpec(key, 4), { level });
  if (gear) s.equips = autoGear(key);
  const u = L.stats.buildPC(s);
  return { atk: u.attr[ABS][A.ATK], def: u.attr[ABS][A.DEF], hp: u.attr[ABS][A.HP], acc: u.attr[RATE][A.APPLY], eva: u.attr[RATE][A.EVADE], crit: u.attr[RATE][A.CRI], spd: u.attr[ABS][A.TURNSPEED] };
}
const med = (a) => { if (!a || !a.length) return null; const s = a.slice().sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };

// allocate a budget: first the targets (crit, accuracy, evasion) then the rest stat
function allocate(base, targets, rest, budget) {
  const pts = { atk: 0, def: 0, hp: 0, acc: 0, eva: 0, crit: 0 };
  let left = budget;
  const unmet = [];
  for (const st of ['crit', 'acc', 'eva']) {
    const t = targets[st];
    if (t == null) continue;
    const need = Math.max(0, Math.ceil((t / 100 - base[st]) / PER[st] - 1e-9));
    const give = Math.min(need, CAP[st], left);
    pts[st] = give; left -= give;
    if (give < need) unmet.push(st);
  }
  const room = Math.max(0, CAP[rest] - pts[rest]);
  const toRest = Math.min(left, room);
  pts[rest] += toRest; left -= toRest;
  if (left > 0) { const spill = rest === 'atk' ? 'hp' : 'atk'; pts[spill] += left; } // over the per-stat cap -> attack (or HP)
  const after = Object.fromEntries(Object.keys(pts).map((s) => [s, base[s] + pts[s] * PER[s]]));
  return { pts, after, unmet };
}

const pcs = C.pcPool().filter((p) => !/Module|_Core_/.test(p.key));
// role+class templates from characters with community data
const group = {};
for (const p of pcs) {
  const c = COM[p.key];
  if (!c) continue;
  const g = (group[p.role + ':' + p.cls] = group[p.role + ':' + p.cls] || { crit: [], acc: [], eva: [], rest: {} });
  for (const s of ['crit', 'acc', 'eva']) if (med(c[s]) != null) g[s].push(med(c[s]));
  for (const [r, n] of Object.entries(c.rest || {})) g.rest[r] = (g.rest[r] || 0) + n;
}
let roleNow = 1;
const PREF = (role) => (role === 0 ? ['hp', 'def', 'atk', 'eva'] : ['atk', 'hp', 'def', 'eva']);
// most mentioned rest stat; ties go to the role's usual choice (attack, tanks: HP)
const topRest = (r) => Object.entries(r || {}).sort((a, b) => b[1] - a[1] || PREF(roleNow).indexOf(a[0]) - PREF(roleNow).indexOf(b[0]))[0];
const out = [];
for (const p of pcs) {
  roleNow = p.role;
  const c = COM[p.key];
  const g = group[p.role + ':' + p.cls] || {};
  const src = c && c.n >= 2 ? 'community' : 'template';
  const tgtA = {
    crit: (c && med(c.crit)) ?? med(g.crit || []) ?? (p.role === 1 ? 100 : null),
    acc: (c && med(c.acc)) ?? med(g.acc || []) ?? null,
    eva: null,
  };
  const restA = ((c && topRest(c.rest)) || topRest(g.rest) || [p.role === 0 ? 'hp' : 'atk'])[0];
  // build B: evasion build when the guides show one, else HP/defence for tanks, else accuracy-heavy for others
  let tgtB = null, restB = null, labelB = '';
  if (c && c.eva && c.eva.length >= 2 && med(c.eva) >= 100) { tgtB = { crit: tgtA.crit, acc: tgtA.acc, eva: med(c.eva) }; restB = 'eva'; labelB = '회피형 (커뮤니티 회피 빌드)'; }
  else if (c && c.rest && (c.rest.hp || c.rest.def) && restA === 'atk') { tgtB = { crit: tgtA.crit, acc: tgtA.acc, eva: null }; restB = (c.rest.hp || 0) >= (c.rest.def || 0) ? 'hp' : 'def'; labelB = restB === 'hp' ? '생존형 (나머지 체력)' : '생존형 (나머지 방어)'; }
  else if (p.role === 0) { tgtB = { crit: null, acc: tgtA.acc, eva: null }; restB = restA === 'hp' ? 'def' : 'hp'; labelB = restB === 'hp' ? '체력형 탱커' : '방어형 탱커'; }
  const rec = { key: p.key, name: p.name, role: p.role, cls: p.cls, src, n: c ? c.n : 0, guides: c ? c.guides.slice(0, 8) : [],
    community: c ? { crit: med(c.crit), acc: med(c.acc), eva: med(c.eva), spd: med(c.spd), rest: c.rest, noStat: c.noStat } : null, builds: [] };
  for (const [label, tgt, rest] of [['표준', tgtA, restA], [labelB, tgtB, restB]]) {
    if (!tgt) continue;
    const b = { label, targets: tgt, rest, lv: {} };
    for (const lv of [100, 120]) {
      const base0 = stats(p.key, lv, false), baseG = stats(p.key, lv, true);
      b.lv[lv] = { budget: BUDGET[lv], noGear: allocate(base0, tgt, rest, BUDGET[lv]), gear: allocate(baseG, tgt, rest, BUDGET[lv]), base0, baseG };
    }
    rec.builds.push(b);
  }
  out.push(rec);
}
fs.writeFileSync(path.join(OUT, 'stat-reco.json'), JSON.stringify(out, null, 1));
console.log('characters', out.length, 'community', out.filter((r) => r.src === 'community').length, 'template', out.filter((r) => r.src === 'template').length, 'with build B', out.filter((r) => r.builds.length > 1).length);
