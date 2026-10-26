// 장비 네 칸이 더해 주는 능력치(강화 수준별 표 값)가 원문 화면에서 역산한 장비 몫과 같은 조합을 찾는다.
//   node tools/원문복원_장비합산대조.js <전투원키> <강화> '<{"atk":0,"def":0,"hp":0,"acc":0.15,"eva":1,"crit":0,"spd":0}>'
// 장비 몫 = 표시 능력치 - (기존 성장표 + 강화 점수 + 연결) 으로 먼저 계산해서 넣는다. 수치가 없는 장비(효과만 있는 장비)는 구분하지 못한다.
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');
const ROOT = path.join(__dirname, '..');
global.window = global; global.fengari = require('fengari');
const run = (p) => vm.runInThisContext(fs.readFileSync(p, 'utf8'), { filename: p });
run(path.join(ROOT, 'engine', 'enums.js')); run(path.join(ROOT, 'engine', 'core.js'));
const L = global.LOSim; L.data = {};
for (const f of ['stages', 'units', 'skills', 'buffs', 'loc', 'lua']) L.data[f] = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', f + '.json'), 'utf8'));
for (const m of ['stats', 'buffs', 'combat', 'ai', 'battle']) run(path.join(ROOT, 'engine', m + '.js'));
const [key, enchant, tgtS] = process.argv.slice(2);
const tgt = JSON.parse(tgtS);
const A = L.E.ACTOR_ATTR_TYPE, F = { [A.ATK]: 'atk', [A.DEF]: 'def', [A.HP]: 'hp', [A.APPLY]: 'acc', [A.EVADE]: 'eva', [A.CRI]: 'crit', [A.TURNSPEED]: 'spd' };
const DIM = ['atk', 'def', 'hp', 'acc', 'eva', 'crit', 'spd'], SC = { atk: 1, def: 1, hp: 1, acc: 1000, eva: 1000, crit: 1000, spd: 1000 };
const EQ = L.T('Table_ItemEquip');
const lst = (x) => (x === undefined ? [] : Array.isArray(x) ? x : [x]).map(Number);
const vec = (k) => { const o = Object.fromEntries(DIM.map((d) => [d, 0])); if (!k) return o; const t = lst(EQ[k].DefaultAttrType), v = lst(EQ[k]['Lv' + enchant + '_DefaultAttrValue']); if (t.length !== v.length) return o; t.forEach((x, i) => { if (F[x]) o[F[x]] += v[i]; }); return o; };
const sig = (o) => DIM.map((d) => Math.round(o[d] * SC[d])).join(',');
const add = (a, b) => Object.fromEntries(DIM.map((d) => [d, a[d] + b[d]]));
const isDev = (k) => /_Test_/i.test(k) || /테스트/.test(L.name((EQ[k] || {}).ItemName, ''));
const S = [0, 1, 2, 3].map((i) => [''].concat(L.stats.listEquipCandidates(key, i).filter((k) => !isDev(k))));
const left = new Map();
for (const a of S[0]) for (const b of S[1]) { const s = sig(add(vec(a), vec(b))); if (!left.has(s)) left.set(s, []); left.get(s).push([a, b]); }
const want = Object.fromEntries(DIM.map((d) => [d, tgt[d] || 0]));
const out = [];
for (const c of S[2]) for (const d of S[3]) {
  const r = add(vec(c), vec(d)); const need = Object.fromEntries(DIM.map((x) => [x, want[x] - r[x]]));
  for (const [a, b] of left.get(sig(need)) || []) out.push([a, b, c, d]);
}
const nm = (k) => (k ? L.name(EQ[k].ItemName, k) : '(빈칸 또는 수치 없는 장비)');
const noStat = new Set(S.flat().filter((k) => k && DIM.every((d) => vec(k)[d] === 0)));
// 수치 없는 장비는 빈칸과 구분되지 않으므로 빈칸으로 묶어서 센다.
const uniq = new Map(); for (const e of out) { const k = e.map((x) => (noStat.has(x) ? '' : x)).join('|'); if (!uniq.has(k)) uniq.set(k, e.map((x) => (noStat.has(x) ? '' : x))); }
console.log(JSON.stringify({ slotCandidates: S.map((x) => x.length), statlessItems: noStat.size, matches: uniq.size, combos: [...uniq.values()].slice(0, 60).map((e) => e.map(nm)) }, null, 1));
