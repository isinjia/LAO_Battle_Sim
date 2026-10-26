// 원문 복원 시험의 입력을 만든다. 같은 시험 항목마다 두 조건을 만든다.
//   preliminary: 기존 예비 시험(기본 수동 분배)과 같은 조건 — 레벨 100, 최대 승급, 기술 10, 연결·호감도 없음, 대표 장비 +10,
//                저장된 자동 배치, 강화 점수 치명 100·공격 197(회피 공략은 회피 100·공격 197).
//   restored:    위 조건에서 원문 근거가 있는 항목만 원문 값으로 바꾼 조건. 바꾸지 못한 항목은 provenance에 '예비 조건 유지'로 남긴다.
//   node tools/원문복원_입력생성.js <복원값.json ...> --out <시험입력.json>
// 복원값.json: [{ caseIndex, post, stage, squad:[{key, fields:{...}, evidence:{...}}], membersConfirmed, ... }]
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
run(path.join(ROOT, 'combo-core.js'));

const args = process.argv.slice(2);
const outPath = args[args.indexOf('--out') + 1];
const inputs = args.filter((a, i) => a !== '--out' && args[i - 1] !== '--out');
const OUT = path.join(__dirname, 'out');
const guides = JSON.parse(fs.readFileSync(path.join(OUT, 'guide-squads.json'), 'utf8'));
const TAGS = JSON.parse(fs.readFileSync(path.join(OUT, 'guide-stat-tags.json'), 'utf8'));

// guide_test.js의 대표 장비(--gear) 선택과 같은 규칙
const A = L.E.ACTOR_ATTR_TYPE;
const W = { [A.ATK]: 1, [A.CRI]: 1, [A.APPLY]: 0.7, [A.TURNSPEED]: 1.2, [A.HP]: 0.4, [A.DEF]: 0.2, [A.EVADE]: 0.2 };
const EQ = L.T('Table_ItemEquip') || {};
const lv10 = (eq) => { const t = L.list(eq, 'DefaultAttrType').map(Number), v = L.list(eq, 'Lv10_DefaultAttrValue').map(Number); return t.length === v.length ? t.map((x, i) => [x, v[i]]) : []; };
const isDev = (k) => /_Test_/i.test(k) || /테스트/.test(L.name((EQ[k] || {}).ItemName, ''));
const MAXV = {};
for (const k in EQ) if (!isDev(k)) for (const [t, v] of lv10(EQ[k])) MAXV[t] = Math.max(MAXV[t] || 0, Math.abs(v));
const eqScore = (eq) => lv10(eq).reduce((s, [t, v]) => s + (W[t] || 0) * (MAXV[t] ? v / MAXV[t] : 0), 0) + L.num(eq, 'ItemGrade') * 0.01;
function autoGear(key) {
  const out = [];
  for (let i = 0; i < 4; i++) {
    let best = null, bs = 0;
    for (const k of L.stats.listEquipCandidates(key, i)) { if (isDev(k)) continue; const sc = eqScore(EQ[k]); if (sc > bs) { bs = sc; best = k; } }
    out.push(best ? { key: best, enchant: 10 } : { key: '', enchant: 0 });
  }
  return out;
}

function preliminaryMember(key, gridPos, evade) {
  const pc = L.T('Table_PC', key);
  const def = L.stats.defaultSpec(key);
  return { key, gridPos, level: 100, grade: L.num(pc, 'MaxGrade') || 5, skillLevels: def.skillLevels.map(() => 10), coreLink: 0, linkBonusKey: '', favor: 0,
    equips: autoGear(key), points: evade ? { atk: 197, eva: 100 } : { atk: 197, crit: 100 } };
}

const FIELDS = ['gridPos', 'level', 'grade', 'skill', 'skillLevels', 'coreLink', 'linkBonusKey', 'favor', 'points', 'equips', 'startHpPct', 'aiFirstSkill', 'manual'];
const cases = [];
for (const file of inputs) for (const r of JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''))) {
  const g = guides[r.caseIndex];
  if (!g || g.post !== r.post || g.stage !== r.stage) throw new Error('시험 항목 불일치 ' + r.caseIndex + ' ' + r.post + ' ' + r.stage);
  const evade = (TAGS[g.post] || []).includes('회피 빌드');
  const pre = g.squad.map((m) => preliminaryMember(m.key, m.gridPos, evade));
  cases.push({ id: r.caseIndex + '-예비', caseIndex: r.caseIndex, post: r.post, stage: r.stage, condition: 'preliminary', squad: pre });
  // 원문 편성: 원문이 구성원을 확정했으면 그 구성원, 아니면 예비 시험의 구성원
  const keys = r.membersConfirmed ? r.squad.map((m) => m.key) : pre.map((m) => m.key);
  const provenance = {};
  const squad = keys.map((key) => {
    const base = pre.find((m) => m.key === key) || preliminaryMember(key, 0, evade);
    const src = r.squad.find((m) => m.key === key) || { fields: {}, evidence: {} };
    const m = Object.assign({}, base);
    const pv = provenance[key] = {};
    for (const f of FIELDS) {
      if (src.fields && src.fields[f] !== undefined && src.fields[f] !== null) {
        let v = src.fields[f];
        if (f === 'skill') { m.skillLevels = base.skillLevels.map(() => v); pv.skillLevels = '원문: ' + (src.evidence && (src.evidence.skill || src.evidence.skillLevels) || ''); continue; }
        if (f === 'equips' && Array.isArray(v) && v.length) {
          // 칸별로 원문이 확정한 장비만 바꾸고, 모르는 칸(null)은 예비 조건의 대표 장비를 남긴다
          // {key:''}는 원문 화면으로 '수치 없는 장비 또는 빈칸'까지 확인된 칸: 대표 장비를 넣지 않는다
          v = v.map((e, i) => (e && e.key ? { key: e.key, enchant: e.enchant === undefined || e.enchant === null ? 10 : e.enchant } : e && e.key === '' ? { key: '', enchant: 0 } : base.equips[i]));
          pv.equips = '원문(칸별): ' + (src.evidence && src.evidence.equips || '') + ' | 모르는 칸 ' + (src.fields.equips.map((e, i) => (e ? null : i)).filter((x) => x !== null).join(',') || '없음') + ' 예비 유지';
        } else pv[f] = '원문: ' + (src.evidence && src.evidence[f] || '');
        if (f === 'points') v = Object.assign({ atk: 0, def: 0, hp: 0, acc: 0, eva: 0, crit: 0 }, v);
        m[f] = v;
      } else if (['gridPos', 'level', 'grade', 'skillLevels', 'coreLink', 'favor', 'points', 'equips'].includes(f) && !pv[f]) pv[f] = '예비 조건 유지';
    }
    if (!pre.find((x) => x.key === key)) pv.member = '원문에서 추가된 구성원';
    return m;
  });
  // 원문 배치와 예비 배치가 같은 칸에 겹치면, 원문 근거가 없는 구성원만 같은 열을 우선해 가장 가까운 빈칸으로 옮기고 기록한다
  let clash = false;
  const fixed = new Set(squad.filter((m) => (provenance[m.key].gridPos || '').startsWith('원문')).map((m) => m.gridPos));
  const fromPre = squad.filter((m) => !(provenance[m.key].gridPos || '').startsWith('원문'));
  const used = new Set(fixed);
  for (const m of fromPre) if (!fixed.has(m.gridPos)) used.add(m.gridPos); // 원문 칸과 겹치지 않는 예비 칸은 그대로 둔다
  for (const m of fromPre) {
    if (!fixed.has(m.gridPos)) continue;
    clash = true;
    const from = m.gridPos;
    const free = [0, 1, 2, 3, 4, 5, 6, 7, 8].filter((c) => !used.has(c))
      .sort((a, b) => (Math.abs(a % 3 - from % 3) * 10 + Math.abs(((a / 3) | 0) - ((from / 3) | 0))) - (Math.abs(b % 3 - from % 3) * 10 + Math.abs(((b / 3) | 0) - ((from / 3) | 0))));
    m.gridPos = free[0];
    used.add(m.gridPos);
    provenance[m.key].gridPos = '충돌 해소용 임의 배치: 예비 칸 ' + from + '을 원문 구성원이 차지해 칸 ' + m.gridPos + '으로 이동';
  }
  cases.push({ id: r.caseIndex + '-원문', caseIndex: r.caseIndex, post: r.post, stage: r.stage, condition: 'restored', squad, provenance, cellClash: clash,
    restorationLevel: r.restorationLevel || '부분', displayedTargets: r.displayedTargets || {}, conditional: r.conditional || [], claimed: r.claimed || [],
    unresolved: r.unresolved || [], imageOnly: r.imageOnly || [], outdated: r.outdated || '' });
}
fs.writeFileSync(outPath, JSON.stringify(cases, null, 1));
console.log('항목', cases.length / 2, '칸 겹침', cases.filter((c) => c.cellClash).length);
