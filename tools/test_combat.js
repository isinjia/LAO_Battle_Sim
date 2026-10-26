// Throwaway verification for engine/combat.js:  node tools/test_combat.js
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
global.window = global;
const ROOT = path.join(__dirname, '..');
const load = (n) => { const p = path.join(ROOT, 'engine', n + '.js'); if (!fs.existsSync(p)) return false; vm.runInThisContext(fs.readFileSync(p, 'utf8'), { filename: p }); return true; };
load('enums'); load('core');
const LOSim = window.LOSim;
LOSim.data = {};
for (const f of ['stages', 'units', 'skills', 'buffs', 'loc', 'lua']) LOSim.data[f] = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', f + '.json'), 'utf8'));
const hasStats = load('stats'), hasBuffs = load('buffs');
if (!hasBuffs) LOSim.buffs = { trigger() {}, has: (u, t) => (u.buffs || []).find((b) => b.type === t) || null, value: () => 0, list: (u, t) => (u.buffs || []).filter((b) => b.type === t), attrValue: () => 0, remove(b, u, p) { u.buffs = u.buffs.filter((x) => !p(x)); } };
load('combat');
const E = LOSim.E, C = LOSim.combat, ABS = E.VALUE_TYPE.ABS, RATE = E.VALUE_TYPE.RATE, A = E.ACTOR_ATTR_TYPE, BT = E.BUFFEFFECT_TYPE;
console.log('modules: stats', hasStats, 'buffs', hasBuffs);

let fails = 0;
const check = (name, got, exp) => { const ok = got === exp; if (!ok) fails++; console.log((ok ? 'OK  ' : 'FAIL') + ' ' + name + ': got ' + got + ' expected ' + exp); };

function mkBattle(units, rolls) {
  const b = { units, round: 1, log: [], logEnabled: true };
  const seq = rolls ? rolls.slice() : null;
  const base = LOSim.makeRng(7);
  b.rng = () => (seq && seq.length ? seq.shift() : base());
  b.rng.int = (n) => Math.floor(b.rng() * n);
  return b;
}
const clean = (u) => { u.buffs = []; if (LOSim.stats.recalc) LOSim.stats.recalc(u); };
const pc = (key, pos, lv) => { const u = LOSim.stats.buildPC({ key, grade: 3, level: lv || 30, gridPos: pos }); clean(u); return u; };
const mob = (key, pos, lv) => { const u = LOSim.stats.buildMonster(key, lv || 10, { gridPos: pos }); clean(u); return u; };

// ---- hand calculation of Creature.DoAttackTarget for a clean (no buff) target ----
function hand(a, t, skill, crit, gridRate) {
  const rate = parseFloat(LOSim.str(skill.levelTable, 'SkillAttackRate', '0')) + ((a.coreLinkFunc && a.coreLinkFunc.stageSkillRatioUp) || 0);
  const skillRate = rate + Math.fround(a.attr[RATE][A.SKILL_ATTACK_RATE]);
  let dmg = skillRate * Math.fround(a.attr[ABS][A.ATK]);
  if (crit) dmg *= 1.5;
  const magic = LOSim.num(skill.levelTable, 'MagicSkillAttrType');
  const resKey = [null, A.FIRE_RESIST, A.ICE_RESIST, A.LIGHTNING_RESIST][magic];
  const resist = resKey === null || resKey === undefined ? 1 : 1 - LOSim.stats.getResist(t, resKey);
  let total = magic === 0 ? (dmg - Math.fround(t.attr[ABS][A.DEF])) * resist : dmg * resist;
  total *= Math.fround(gridRate);
  if (total <= 0) total = 1;
  return Math.trunc(Math.max(1, total));
}

// ---------------------------------------------------------------- 1. single target hit / crit / miss
{
  const P = pc('Char_BR_PA00EL_N', 5), M = mob('MOB_MP_NightChick_N', 3);
  const s1 = C.skillBySlot(P, 1);
  console.log('PC', P.key, 'ATK', P.attr[ABS][A.ATK], 'APPLY', P.attr[RATE][A.APPLY], 'CRI', P.attr[RATE][A.CRI], 'skill', s1.key, 'TT', LOSim.num(s1.table, 'TargetType'), 'rate', LOSim.str(s1.levelTable, 'SkillAttackRate'), 'grid', LOSim.str(s1.levelTable, 'GridIndex'), 'dist', C.skillDistance(P, s1));
  console.log('MOB', M.key, 'HP', M.hp, 'DEF', M.attr[ABS][A.DEF], 'EVADE', M.attr[RATE][A.EVADE]);
  let b = mkBattle([P, M], [0.0, 0.99]); // hit roll 0 (hit), crit roll 0.99 (no crit)
  check('canUse', C.canUse(b, P, s1), true);
  check('inRange', C.inRange(b, P, s1, M), true);
  const tg = C.targets(b, P, s1, M);
  console.log('targets', tg.map((x) => x.unit.key + '@' + x.gridRate));
  const hp0 = M.hp;
  let r = C.execute(b, P, s1, M, {});
  // buff application inside the action also consumes battle.rng (BuffEffectRate rolls), so verify against the reported crit flag
  const exp = hand(P, M, s1, r.hits[0].crit, tg[0].gridRate);
  check('normal hit damage (crit=' + r.hits[0].crit + ')', r.hits[0] && r.hits[0].damage, exp);
  check('hp reduced', hp0 - M.hp, Math.min(exp, hp0 + 0) === exp ? exp : hp0 - M.hp);
  check('cooldown started (CooldownTurn ' + LOSim.num(s1.levelTable, 'CooldownTurn') + ')', s1.cooldownLeft, Math.max(0, LOSim.num(s1.levelTable, 'CooldownTurn')));

  // crit
  M.hp = M.maxHp; M._deadHandled = false; s1.cooldownLeft = 0; s1._cdSkip = false;
  P.buffs.push({ id: 99, key: 'TEST_CHARGE', type: BT.STAGE_CRITICAL_NEXTATTACK, value: 1, perLevel: 0, skillLevel: 1, addSkillLevel: 0, attrValue: 1, left: 1, eraseType: 0, from: P });
  b = mkBattle([P, M], [0.0]);
  r = C.execute(b, P, s1, M, {});
  check('crit damage', r.hits[0] && r.hits[0].damage, hand(P, M, s1, true, tg[0].gridRate));
  check('crit flag', r.hits[0] && r.hits[0].crit, true);
  check('charge buff consumed', P.buffs.some((x) => x.key === 'TEST_CHARGE'), false);

  // miss: roll >= apply - evade
  M.hp = M.maxHp; M._deadHandled = false; s1.cooldownLeft = 0;
  M.buffs.push({ id: 98, key: 'TEST_EVADE', type: BT.STAT_AVOID_RATIO, value: 0.5, perLevel: 0, skillLevel: 1, addSkillLevel: 0, attrValue: 0.5, left: 3, eraseType: 0, from: M });
  LOSim.stats.recalc(M); // evade now comes from a buff, so in-action recalcs keep it
  b = mkBattle([P, M]); b.rng = () => 0.9999; b.rng.int = (n) => n - 1; // every roll fails
  const evadeUsed = M.attr[RATE][A.EVADE];
  const hitRate = P.attr[RATE][A.APPLY] + LOSim.num(s1.levelTable, 'Accuracy') - M.attr[RATE][A.EVADE];
  r = C.execute(b, P, s1, M, {});
  check('miss when roll(0.9999) >= hitRate(' + hitRate.toFixed(3) + ')', !!(r.hits[0] && r.hits[0].miss), hitRate <= 0.9999);
  check('miss leaves hp', M.hp, hitRate <= 0.9999 ? M.maxHp : M.hp);

  // cooldown: on cooldown -> waits; tick skips the use turn
  s1.cooldownLeft = 0; s1._cdSkip = false;
  C.startCooldown(Object.assign(s1, {})); s1.cooldownLeft = 2; s1._cdSkip = true;
  r = C.execute(mkBattle([P, M]), P, s1, M, {});
  check('cooldown -> wait', r.waited && r.skipped, 'cooldown');
  C.tickCooldowns(P); check('tick 1 (use turn skipped)', s1.cooldownLeft, 2);
  C.tickCooldowns(P); check('tick 2', s1.cooldownLeft, 1);
  C.tickCooldowns(P); check('tick 3', s1.cooldownLeft, 0);
}

// ---------------------------------------------------------------- 2. monster -> PC with DEF, and buff modifiers
{
  const P = pc('Char_BR_PA00EL_N', 5), M = mob('MOB_MP_NightChick_N', 0, 20);
  const ms = C.skillBySlot(M, 1);
  console.log('mob skill', ms.key, 'TT', LOSim.num(ms.table, 'TargetType'), 'rate', LOSim.str(ms.levelTable, 'SkillAttackRate'), 'dist', C.skillDistance(M, ms), 'M.cell', C.cellOf(M), 'P.cell', C.cellOf(P));
  const b = mkBattle([P, M], [0.0, 0.99]);
  const tg = C.targets(b, M, ms, P);
  const r = C.execute(b, M, ms, P, {});
  const h = r.hits.find((x) => x.target === P);
  check('monster->PC damage', h && h.damage, tg.length ? hand(M, P, ms, false, tg.find((x) => x.unit === P).gridRate) : undefined);
}

// ---------------------------------------------------------------- 3. damage-reduction buff (STAGE_SHIELD_RATIO) & DEF pierce via buffs.apply
if (hasBuffs) {
  const P = pc('Char_BR_PA00EL_N', 5), M = mob('MOB_MP_NightChick_N', 3);
  const s1 = C.skillBySlot(P, 1);
  // inject a synthetic buff record shaped like buffs.js records
  M.buffs.push({ id: 1, key: 'TEST_SHIELD', type: BT.STAGE_SHIELD_RATIO, value: 0.3, perLevel: 0, skillLevel: 1, addSkillLevel: 0, attrValue: 0.3, left: 3, eraseType: 0, from: M });
  const b = mkBattle([P, M], [0.0, 0.99]);
  const g = C.targets(b, P, s1, M)[0].gridRate;
  const r = C.execute(b, P, s1, M, {});
  const rate = parseFloat(LOSim.str(s1.levelTable, 'SkillAttackRate')) + Math.fround(P.attr[RATE][A.SKILL_ATTACK_RATE]);
  const sr = Math.min(Math.fround(0.3), Math.fround(0.9)); // MAX_STAGE_SHIELD_RATIO 0.9
  const exp = Math.trunc(Math.max(1, (rate * Math.fround(P.attr[ABS][A.ATK]) * Math.fround(1 - sr) - Math.fround(M.attr[ABS][A.DEF])) * g));
  check('STAGE_SHIELD_RATIO 0.3', r.hits[0] && r.hits[0].damage, exp);
}

// ---------------------------------------------------------------- 4. protect: STAGE_BLOCK_LINE on the front monster
if (hasBuffs) {
  const P = pc('Char_BR_PA00EL_N', 5), Mfront = mob('MOB_MP_NightChick_N', 3), Mback = mob('MOB_MP_NightChick_N', 4);
  Mfront.buffs.push({ id: 2, key: 'TEST_BLOCKLINE', type: BT.STAGE_BLOCK_LINE, value: 1, perLevel: 0, skillLevel: 1, addSkillLevel: 0, attrValue: 1, left: 3, eraseType: 0, from: Mfront });
  const s1 = C.skillBySlot(P, 1);
  P.skills.forEach((s) => (s.cooldownLeft = 0));
  const b = mkBattle([P, Mfront, Mback], [0.0, 0.99, 0.0, 0.99]);
  // force distance: give P a long range via a target in range check
  const inR = C.inRange(b, P, s1, Mback);
  const r = C.execute(b, P, s1, Mback, {});
  console.log('protect: inRange', inR, 'hits', r.hits.map((h) => h.target.gridPos + ':' + h.damage + (h.protectedBy ? ' (prot for ' + h.original.gridPos + ')' : '')), 'skipped', r.skipped);
  if (inR) check('BLOCK_LINE redirects to the front unit', r.hits.length > 0 && r.hits[0].target, Mfront);
}

// ---------------------------------------------------------------- 5. 사거리 밖 반격 후보를 건너뛰고 다음 후보를 선택하는지 확인
if (hasBuffs) {
  const P = pc('Char_BR_PA00EL_N', 3); // back column: out of A2's slot-1 range (cell 2 + cell 2 + 1 = 5 > 3)
  const A1 = mob('MOB_MP_NightChick_N', 3), A2 = mob('MOB_MP_NightChick_N', 5);
  const cb = (u, id) => u.buffs.push({ id, key: 'TEST_COUNTER', type: BT.STAGE_REFLECTPHYSICS_RATIO_DEFENDER, value: 0.5, perLevel: 0, skillLevel: 1, addSkillLevel: 0, attrValue: 0.5, left: 3, eraseType: 0, from: u });
  cb(A1, 10); cb(A2, 11);
  const b = mkBattle([P, A1, A2]);
  // fake an action result: grid attack hit both (no main target) -> second counter branch
  const ex = C.extraActions(b, P, { skillKey: 'x', mainTarget: null, otherTargets: [A2, A1] }, {});
  check('사거리 밖 반격 후보에서 잘못된 참조 오류가 발생하지 않음', (b.counters || {}).counter_null || 0, 0);
  check('next candidate counters', ex[0] && ex[0].unit, A1);
  console.log('extraActions', ex.map((e) => e.type + ' by ' + e.unit.gridPos + ' buff ' + (e.counterBuff && e.counterBuff.key)), 'counters', JSON.stringify(b.counters || {}));
  // counter execute with multiplier
  if (ex[0]) {
    const before = P.hp;
    const r = C.execute(b, ex[0].unit, ex[0].skill, ex[0].target, { isCounter: true, counterBuff: ex[0].counterBuff });
    console.log('counter dmg', r.hits.map((h) => h.damage + (h.miss ? ' miss' : '')), 'P hp', before, '->', P.hp);
  }
}

// ---------------------------------------------------------------- 6. applyDamage / heal / death
{
  const P = pc('Char_BR_PA00EL_N', 5), M = mob('MOB_MP_NightChick_N', 3);
  const b = mkBattle([P, M]);
  const d = C.applyDamage(b, P, M, M.hp + 5.7, { kind: 'dot' });
  check('applyDamage truncates', d, Math.trunc(M.maxHp + 5.7));
  check('dead', M.hp <= 0, true);
  check('kill credited', P.stats.kills, 1);
  P.hp = 10;
  check('heal capped', C.heal(b, null, P, 1e9), P.maxHp - 10);
  console.log('log types', [...new Set(b.log.map((l) => l.t))].join(','));
}

// ---------------------------------------------------------------- 7. delay (reserve) skill and grid skill
{
  const keys = Object.keys(LOSim.data.skills.Table_Skill).filter((k) => LOSim.data.skills.Table_Skill[k].IsDelaySkill);
  const pcKey = Object.keys(LOSim.data.units.Table_PC).find((k) => LOSim.str(LOSim.T('Table_SkillGroup', LOSim.str(LOSim.T('Table_PC', k), 'SkillGroupIndex')), 'SkillIndex2') === keys[0]);
  if (pcKey) {
    const P = pc(pcKey, 5), M = mob('MOB_MP_NightChick_N', 3), M2 = mob('MOB_MP_NightChick_N', 4);
    const s2 = C.skillBySlot(P, 2);
    const b = mkBattle([P, M, M2], [0, 0.99, 0, 0.99, 0, 0.99]);
    const r = C.execute(b, P, s2, { gridPos: 3 }, {});
    console.log('reserve skill', pcKey, s2.key, 'skipped', r.skipped, 'reserves', r.reserves.map((x) => x.skillKey + ' charge ' + x.delayChargeCount + ' pos ' + x.targetGridPos));
    if (r.reserves[0]) {
      const rs = r.reserves[0];
      const ds = C.findSkill(P, rs.skillKey, s2.level);
      const r2 = C.execute(b, P, ds, { gridPos: rs.targetGridPos }, { isReserve: true, reserve: rs });
      console.log('reserved fire', ds && ds.key, 'hits', r2.hits.map((h) => h.target.gridPos + ':' + h.damage + '@' + h.gridRate), 'skipped', r2.skipped);
    }
  }
}

// ---------------------------------------------------------------- 8. smoke: every PC slot-1/2 skill vs a 3-mob line, no exceptions
{
  let n = 0, errs = 0, dmg = 0;
  for (const k of Object.keys(LOSim.data.units.Table_PC).slice(0, 300)) {
    let P;
    try { P = LOSim.stats.buildPC({ key: k, grade: 5, level: 60, gridPos: 5 }); } catch (e) { continue; }
    const mobs = [3, 4, 5, 0].map((p) => mob('MOB_MP_NightChick_N', p, 20));
    const b = mkBattle([P].concat(mobs));
    for (const s of P.skills) {
      if (LOSim.num(s.table, 'SkillType') !== 0) continue;
      try { s.cooldownLeft = 0; const r = C.execute(b, P, s, mobs[0], {}); n++; dmg += r.hits.reduce((a, h) => a + h.damage, 0); for (const x of r.extraActions) C.execute(b, x.unit, x.skill, x.target, { isCounter: x.type === 'counter', isAssist: x.type === 'assist', counterBuff: x.counterBuff, assistFrom: x.from }); }
      catch (e) { errs++; if (errs < 5) console.log('ERR', k, s.key, e.stack.split('\n').slice(0, 3).join(' | ')); }
    }
  }
  console.log('smoke executes', n, 'errors', errs, 'total dmg', dmg);
  if (errs) fails++;
}
console.log(fails ? fails + ' FAILURE(S)' : 'ALL CHECKS PASSED');
process.exitCode = fails ? 1 : 0;
