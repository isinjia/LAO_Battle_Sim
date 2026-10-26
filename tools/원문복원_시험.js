// 원문 공략 조건을 복원해 넣은 시험과, 같은 공략의 기존 예비 시험 조건을 같은 난수로 나란히 실행한다.
//   node tools/원문복원_시험.js --cases <복원조건.json> --out <결과.json> [--seeds 1-10] [--run-timeout-ms 30000] [--stats-only]
// 복원조건.json: [{ id, post, stage, condition, notes, squad: [member] }]
//   member: { key, gridPos(0-8), level, grade, skillLevels[] | skill, coreLink | cores[], linkBonusKey, favor,
//             equips: [{key, enchant}] (빈 배열이면 장비 없음), points: {atk, def, hp, acc, eva, crit},
//             startHpPct, aiFirstSkill(1|2), manual: [rule] }
//   rule: { wave?, turn?(그 전투 구역 안에서 그 전투원의 n번째 본 행동), do: 'skill1'|'skill2'|'wait'|'move', target?: {key|gridPos|lowestHp|highestHp}, moveTo? }
// 입력에 적힌 값만 쓴다. 대표 장비·자동 배치·기본 기술 수준으로 덮어쓰지 않으며, 빠진 항목은 결과의 inputGaps에 남긴다.
// 능력치는 확정된 개발 방향대로 기존 성장표(r15485 Table_PCAbility)와 수동 강화 점수(Table_PCEnchant_StatUpValue)로 만든다.
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
const arg = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const OUT = path.join(__dirname, 'out');
const cases = JSON.parse(fs.readFileSync(arg('--cases'), 'utf8').replace(/^﻿/, ''));
const outPath = arg('--out');
const [s0, s1] = String(arg('--seeds', '1-10')).split('-').map(Number);
const SEEDS = []; for (let s = s0; s <= (s1 || s0); s++) SEEDS.push(s);
const runTimeoutMs = +arg('--run-timeout-ms', 30000);
const STATS_ONLY = args.includes('--stats-only');
const MAX_ACTIONS = 2000;

const OLDAB = JSON.parse(fs.readFileSync(path.join(OUT, 'pcability_r15485.json'), 'utf8'));
const PT = { atk: 1.5, def: 1.25, hp: 8, eva: 0.004, crit: 0.004, acc: 0.015 }; // Table_PCEnchant_StatUpValue 0/1/2/3/5/6
const missions = Object.fromEntries(JSON.parse(fs.readFileSync(path.join(OUT, 'stage-missions.json'), 'utf8')).map((m) => [m.stage, m.missions]));
const A = L.E.ACTOR_ATTR_TYPE, ABS = L.E.VALUE_TYPE.ABS, RATE = L.E.VALUE_TYPE.RATE;
const AB_FIELDS = ['AttackDmg', 'AddAttackDmgByLevel', 'DefenseDmg', 'AddDefenseDmgByLevel', 'DefaultHP', 'DefaultHPByLevel', 'ApplyRate', 'AddApplyRateByLevel', 'EvadeRate', 'AddEvadeRateByLevel', 'CriRate', 'AddCriRateByLevel', 'FireResist', 'IceResist', 'EletronicResist'];

// 기존 성장표 + 공략별 수동 강화 점수. 적중·회피·치명은 기존 방식대로 레벨 성장이 없다.
function oldRules(members) {
  const rules = [];
  for (const m of members) {
    const o = OLDAB[m.key];
    if (!o) continue;
    const v = (f) => Number(o[f] || 0);
    const p = Object.assign({ atk: 0, def: 0, hp: 0, acc: 0, eva: 0, crit: 0 }, m.points || {});
    const set = { AttackDmg: v('AttackDmg') + p.atk * PT.atk, DefenseDmg: v('DefenseDmg') + p.def * PT.def, DefaultHP: v('DefaultHP') + p.hp * PT.hp,
      ApplyRate: v('ApplyRate') + p.acc * PT.acc, AddApplyRateByLevel: 0, EvadeRate: v('EvadeRate') + p.eva * PT.eva, AddEvadeRateByLevel: 0,
      CriRate: v('CriRate') + p.crit * PT.crit, AddCriRateByLevel: 0 };
    for (const f of AB_FIELDS) rules.push({ table: 'Table_PCAbility', keys: m.key, field: f, value: set[f] === undefined ? v(f) : set[f] });
  }
  return rules;
}

function spec(m, gaps) {
  const pc = L.T('Table_PC', m.key);
  if (!pc) throw new Error('알 수 없는 전투원 ' + m.key);
  const def = L.stats.defaultSpec(m.key);
  const need = (k, label) => { if (m[k] === undefined) gaps.push(L.name(pc.Name, m.key) + ' ' + label); };
  need('gridPos', '배치'); need('level', '레벨'); need('grade', '승급'); need('equips', '장비'); need('points', '수동 강화 점수');
  if (m.skillLevels === undefined && m.skill === undefined) gaps.push(L.name(pc.Name, m.key) + ' 기술 수준');
  if (m.coreLink === undefined && m.cores === undefined) gaps.push(L.name(pc.Name, m.key) + ' 코어 연결');
  if (m.favor === undefined) gaps.push(L.name(pc.Name, m.key) + ' 호감도');
  const s = Object.assign(def, {
    gridPos: m.gridPos === undefined ? 0 : m.gridPos, level: m.level || 1, grade: m.grade || def.grade,
    skillLevels: m.skillLevels || def.skillLevels.map(() => m.skill || 1), equips: m.equips || [],
    coreLink: m.coreLink || 0, favor: m.favor || 0, linkBonusKey: m.linkBonusKey || '',
  });
  if (m.cores) s.cores = m.cores;
  if (m.aiFirstSkill) s.aiFirstSkill = m.aiFirstSkill;
  s.manual = m.manual || null;
  return s;
}

// 표시 능력치: 전투 시작 직후 버프 적용 전 값(능력치 화면과 같은 기준)
function shown(u) {
  const b = u.base;
  return { hp: Math.trunc(b[ABS][A.HP]), atk: Math.trunc(b[ABS][A.ATK]), def: Math.trunc(b[ABS][A.DEF]),
    acc: +(b[RATE][A.APPLY] * 100).toFixed(1), eva: +(b[RATE][A.EVADE] * 100).toFixed(1), crit: +(b[RATE][A.CRI] * 100).toFixed(1),
    spd: +b[ABS][A.TURNSPEED].toFixed(2) };
}

// 수동 조작: 자동 전투의 기술 선택 직전에 지시를 확인하고, 맞는 지시가 있으면 그 선택을 넣는다.
const AI = L.ai;
const autoCharacter = AI.autoCharacter;
const manualLog = [];
AI.autoCharacter = function (b, u) {
  const rules = u.spec && u.spec.manual;
  if (!rules || u.reserveSkillList.length) return autoCharacter(b, u);
  const wave = b.waveIndex + 1, turn = ((u._turns || {})[wave] || 0) + 1;
  const foes = b.units.filter((x) => x.team !== 1 && x.hp > 0 && !x.removed);
  // onlyEnemyCols: 살아 있는 적이 모두 이 열에 있을 때만(적 쪽은 0열이 앞줄). once: 한 번만 적용. parity: 'odd'|'even' 본 행동 차례
  const ok = (x) => (x.wave === undefined || x.wave === wave) && (x.turn === undefined || x.turn === turn)
    && (!x.onlyEnemyCols || (foes.length && foes.every((f) => x.onlyEnemyCols.includes(f.gridPos % 3))))
    && (!x.parity || (turn % 2 === 1) === (x.parity === 'odd')) && !(x.once && x._used);
  const r = rules.find(ok);
  if (r && r.once) r._used = true;
  if (!r) return autoCharacter(b, u);
  const sel = AI.newSel(u);
  const note = { wave, turn, unit: u.key, rule: r.do };
  if (r.do === 'wait') sel.skillKey = waitKey();
  else if (r.do === 'move') { sel.skillKey = moveKey(); sel.targetGridPos = r.moveTo; }
  else {
    const slot = r.do === 'skill2' ? 'skill_slot_2' : 'skill_slot_1';
    const ok = AI.getTargetAI(b, sel, u, slot, L.E.ATTACKTARGETTYPE.RANDOM, '', '', '');
    if (!ok) { note.result = '대상 없음, 자동 선택으로 대체'; manualLog.push(note); return autoCharacter(b, u); }
    if (r.target) {
      const s = AI.skillByKey(u, sel.skillKey);
      const tt = L.num(s.table, 'TargetType'), TT = L.E.TARGET_TYPE;
      const tl = (tt === TT.OUR || tt === TT.OUR_GRID ? AI.ourTargetListBySkillDistance(b, u, AI.skillDistance(b, u, s), tt) : AI.targetListBySkillDistance(b, u, AI.skillDistance(b, u, s))) || [];
      let t = null;
      if (r.target.key) t = tl.find((x) => x.key === r.target.key);
      else if (r.target.gridPos !== undefined) t = tl.find((x) => x.gridPos === r.target.gridPos);
      else if (r.target.lowestHp) t = tl.slice().sort((x, y) => x.hp - y.hp)[0];
      else if (r.target.highestHp) t = tl.slice().sort((x, y) => y.hp - x.hp)[0];
      if (t) { sel.targetAid = t.aid; sel.targetGridPos = t.gridPos; note.result = '지정 대상'; } else note.result = '지정 대상이 사거리 밖, 자동 대상 유지';
    }
  }
  manualLog.push(note);
  u.reserveSkillList.push(sel);
};
const waitKey = () => L.C.SKILLKEY_WAIT || 'Wait'; // engine/ai.js:26과 같은 값
const moveKey = () => L.C.SKILLKEY_MOVE || 'Move';

function evalMissions(stage, pcMain, allMain, win) {
  return (missions[stage] || []).map((m) => {
    if (m.type === 'TURN_LIMIT_LESS') return { key: m.key, value: m.value, pcMain, allMain, byPcMain: win && pcMain <= m.value, byAllMain: win && allMain <= m.value, boundary: pcMain === m.value || allMain === m.value };
    return { key: m.key, type: m.type, value: m.value, note: '판정식 미구현' };
  });
}

function runOne(c, squad, seed) {
  const b = L.battle.create({ mode: 'stage', stageKey: c.stage, squad, seed, logEnabled: true, options: { maxActions: MAX_ACTIONS } });
  if (b.result === 'error') return { seed, outcome: 'error', reason: b.resultReason };
  for (const m of squad) for (const r of m.manual || []) delete r._used; // 한 번만 쓰는 지시는 실행마다 새로 센다
  for (const m of squad) {
    const u = b.units.find((x) => x.key === m.key);
    if (u && m.startHpPct !== undefined) u.hp = Math.max(1, Math.round(u.maxHp * m.startHpPct / 100));
  }
  const stats = Object.fromEntries(b.units.map((u) => [u.key, shown(u)]));
  let pcMain = 0, pcExtra = 0, allMain = 0, enemyExtra = 0;
  const order = [], deaths = [], waveFirst = {};
  const alive = new Map(b.units.map((u) => [u.aid, true]));
  const started = Date.now();
  let timedOut = false;
  while (!b.result) {
    L.battle.step(b);
    for (const e of b.log) {
      if (e.t === 'wave') waveFirst[e.wave] = { at: allMain + 0 };
      if (e.t !== 'action' || !e.actor) continue;
      const mine = e.actor.team === 1;
      if (e.turnType === 'normal') { allMain++; if (mine) pcMain++; } else if (mine) pcExtra++; else enemyExtra++;
      if (mine && e.turnType === 'normal') {
        const u = b.allUnits.find((x) => x.aid === e.actor.aid);
        if (u) { u._turns = u._turns || {}; u._turns[e.wave] = (u._turns[e.wave] || 0) + 1; }
      }
      if (order.length < 300) order.push([e.wave, e.round, e.actor.key.replace(/^Char_|^Mon_|_N$/g, ''), e.turnType[0], e.kind === 'skill' ? 's' + (e.slot || '') : e.kind || '-', e.target ? String(e.target.key || '').replace(/^Char_|^Mon_|_N$/g, '') : '']);
    }
    b.log.length = 0;
    for (const u of b.allUnits) {
      const now = u.hp > 0 && !u.removed;
      if (alive.get(u.aid) && !now && u.team === 1) deaths.push({ unit: u.key, wave: b.waveIndex + 1, round: b.round, atMainAction: allMain });
      alive.set(u.aid, now);
    }
    if (!b.result && runTimeoutMs && Date.now() - started >= runTimeoutMs) { timedOut = true; break; }
  }
  const win = b.result === 'win';
  return {
    seed, outcome: timedOut ? 'execution_timeout' : b.result, reason: timedOut ? '계산 시간 제한 ' + runTimeoutMs + 'ms' : b.resultReason || '',
    pcMain, pcExtra, allMain, enemyExtra, rounds: b.totalRounds, waveReached: b.waveIndex + 1, maxWave: b.maxWave,
    stalemateFromAction: b.result === 'timeout' ? b.lastHpChangeAt || 0 : null, deaths,
    survivors: b.allUnits.filter((u) => u.team === 1 && u.type === 'CHARACTER' && u.hp > 0).map((u) => u.key),
    missions: evalMissions(c.stage, pcMain, allMain, win), order, stats,
  };
}

// 원문 목표 수치에 맞춘 강화 점수: member.pointsFromTargets = { basis: 'shown'|'battle', acc, crit, eva, atk, rest: 'atk'|'def'|'hp'|null }
// shown은 능력치 화면 값, battle은 첫 행동 직후(전투 시작 효과 적용 후) 값. 총점은 원문 화면 두 장에서 확인한 레벨×3점.
// 적중·치명·회피는 점수당 증가량이 일정하므로 필요한 점수를 바로 계산하고, 공격은 점수 100점의 증가량으로 환산한다.
function measure(c, members, key, basis) {
  const ov = L.applyOverrides(oldRules(members));
  try {
    const gaps = [];
    const squad = members.map((m) => spec(m, gaps));
    const b = L.battle.create({ mode: 'stage', stageKey: c.stage, squad, seed: 1, logEnabled: false, options: { maxActions: 5 } });
    const u = b.units.find((x) => x.key === key);
    if (basis === 'battle') {
      while (!b.result && !b.totalActions) L.battle.step(b); // 엔진이 행동 단위로만 진행하므로 첫 행동 직후 값(전투 시작 효과 포함)을 쓴다
      const a = u.attr;
      return { acc: a[RATE][A.APPLY] * 100, crit: a[RATE][A.CRI] * 100, eva: a[RATE][A.EVADE] * 100, atk: a[ABS][A.ATK] };
    }
    return shown(u);
  } finally { ov.revert(); }
}
function solvePoints(c) {
  const notes = [];
  for (const m of c.squad) {
    const t = m.pointsFromTargets;
    if (!t) continue;
    const cap = 3 * (m.level || 100);
    const zero = c.squad.map((x) => (x === m ? Object.assign({}, x, { points: {} }) : x));
    const s0 = measure(c, zero, m.key, t.basis);
    const need = { acc: 0, crit: 0, eva: 0, atk: 0 };
    const per = { acc: 1.5, crit: 0.4, eva: 0.4 };
    for (const k of ['crit', 'acc', 'eva']) if (t[k] !== undefined) need[k] = Math.max(0, Math.ceil((t[k] - s0[k]) / per[k] - 1e-9));
    if (t.atk !== undefined) {
      const s1 = measure(c, c.squad.map((x) => (x === m ? Object.assign({}, x, { points: { atk: 100 } }) : x)), m.key, t.basis);
      const perAtk = (s1.atk - s0.atk) / 100;
      need.atk = Math.max(0, Math.ceil((t.atk - s0.atk) / perAtk - 1e-9));
    }
    const used = need.acc + need.crit + need.eva + need.atk;
    const pts = { atk: need.atk, def: 0, hp: 0, acc: need.acc, eva: need.eva, crit: need.crit };
    const over = Object.entries(t).filter(([k, v]) => ['acc', 'crit', 'eva', 'atk'].includes(k) && s0[k] > v).map(([k]) => k);
    if (used > cap) notes.push(m.key + ' 목표 달성에 ' + used + '점 필요, 총점 ' + cap + '점 초과');
    else if (t.rest) pts[t.rest] += cap - used;
    if (over.length) notes.push(m.key + ' 점수 없이도 목표 초과: ' + over.join(','));
    m.points = pts;
    m.pointsSolved = { basis: t.basis, cap, withoutPoints: s0, need };
  }
  return notes;
}

const results = [];
for (const c of cases) {
  const gaps = [];
  let squad, solveNotes = [];
  try { solveNotes = solvePoints(c); squad = c.squad.map((m) => spec(m, gaps)); } catch (e) { results.push({ id: c.id, error: String(e.message) }); continue; }
  const keys = squad.map((s) => s.key);
  const ov = L.applyOverrides(oldRules(c.squad));
  const r = { id: c.id, post: c.post, stage: c.stage, condition: c.condition, notes: c.notes || '', inputGaps: gaps, solveNotes, input: c.squad, runs: [] };
  try {
    const probe = L.battle.create({ mode: 'stage', stageKey: c.stage, squad, seed: 1, options: { maxActions: 1 } });
    r.shownStats = Object.fromEntries(probe.units.filter((u) => keys.includes(u.key)).map((u) => [u.key, shown(u)]));
    r.buildWarnings = probe.units.filter((u) => keys.includes(u.key)).flatMap((u) => (u.warnings || []).map((w) => u.key + ': ' + w));
    r.builtEquips = Object.fromEntries(probe.units.filter((u) => keys.includes(u.key)).map((u) => [u.key, u.equips.map((e) => e.key + '+' + e.enchant)]));
    if (!STATS_ONLY) for (const s of SEEDS) {
      manualLog.length = 0;
      try { const x = runOne(c, squad, s); x.manual = manualLog.slice(0, 50); r.runs.push(x); } catch (e) { r.runs.push({ seed: s, outcome: 'error', reason: String(e.message || e).slice(0, 200) }); }
    }
  } finally { ov.revert(); }
  results.push(r);
  const w = r.runs.filter((x) => x.outcome === 'win').length;
  console.log(c.id, c.stage, c.condition, STATS_ONLY ? JSON.stringify(r.shownStats) : `승리 ${w}/${r.runs.length}`);
}
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, JSON.stringify({ at: new Date().toISOString(), seeds: SEEDS, runTimeoutMs, maxActions: MAX_ACTIONS, results }, null, 1));
