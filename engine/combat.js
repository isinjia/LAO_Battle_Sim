// LOSim.combat -- port of the renewal-build skill execution / targeting / hit / crit / damage pipeline.
//
// Sources (renewal path only; `#if BEFORE_BATTLE_RENEWAL` blocks skipped, UNITY_EDITOR cheats ignored,
// animation / FX / projectile / UI code ignored):
//   Assets/_Scripts/CreatureBattle/Creature.cs   DoTurnAction 1791-2329, IsDoAttackTarget 5999-6366,
//                                                GetTargetList 6393-6518, DoAttackTarget 6520-7545,
//                                                GetResist 7962, GetBuffEffectValue 8034, GetAttrValue 8049,
//                                                GetDamageRateByGridPos 8077, SpawnSummonActor 8771, GetBuffDistance 8891,
//                                                DoDamage 566-735 (hit-time triggers)
//   Assets/_Scripts/CreatureBattle/Skill.cs      cooldown 58-108, GetSkillDistance 179, IsDistance 204
//   Assets/_Scripts/CreatureBattle/CreatureSkill.cs  OnOwnerTurnEnded 252, ResetAllSkillCooldowns 240
//   Assets/_Scripts/Manager/BattleManager.cs     target lists 3125-3229 / 3845-3906, GetTargetAI 4121-4305,
//                                                provoke/marking 4328-4400, ExtraAction (counter / chain) 4857-5000,
//                                                SetChainAttack 5245, OnCounter 5371, DoApplyBuff 6637,
//                                                OnHitTriggerBuff 6764, OnAllyHitTriggerBuff 6888,
//                                                RemoveTargetResult (resurrect) 2165, DeathBuffeffect 2251
//   Assets/_Scripts/StageMap/StageMapData.cs     IsFrontActorBlockLine 1090-1265, IsBlockRow 1267-1324,
//                                                MoveFrontGridPos 1326-1606, MoveBackGridPos 1608-1928
//   Assets/_Scripts/CreatureBattle/FSM/CreatureState_SkillAttack.cs  LateDamage kill triggers 1167-1270
//   Assets/_Scripts/Manager/BattleRoundManager.cs  ApplyCreatureTurnEndDurations 167 (cooldown tick), ApplyDotBuff 1591
//
// The Unity client simulates combat locally (S2C_* "packets" are raised by the client itself), so no value
// here is taken from a real server. Unity Random.Range(0,1f) is approximated with battle.rng() in [0,1).
(function () {
  const LOSim = (window.LOSim = window.LOSim || {});
  const E = LOSim.E;
  const num = LOSim.num, str = LOSim.str, list = LOSim.list;
  const T = (t, k) => (LOSim.T ? LOSim.T(t, k) : null);
  const BT = E.BUFFEFFECT_TYPE, TR = E.BUFFEFFECT_TRIGGER_TYPE, TT = E.TARGET_TYPE;
  const VT = E.VALUE_TYPE, AT = E.ACTOR_ATTR_TYPE, SA = E.SKILL_ATTR;
  const f32 = Math.fround; // C# float casts

  // =====================================================================================
  // small utilities
  // =====================================================================================
  const counters = (battle) => (battle.counters = battle.counters || {});
  const bump = (battle, k) => { const c = counters(battle); c[k] = (c[k] || 0) + 1; };
  const alive = (u) => !!u && u.hp > 0;
  const log = (battle, t, d) => { if (LOSim.log && battle) LOSim.log(battle, t, d); };
  const uref = (u) => (u ? { aid: u.aid, key: u.key, team: u.team, pos: u.gridPos } : null);
  const rnd = (battle) => battle.rng();
  const rndInt = (battle, n) => (battle.rng.int ? battle.rng.int(n) : Math.floor(battle.rng() * n));
  function shuffle(battle, arr) { // Common.Shuffle (Fisher-Yates)
    for (let i = arr.length - 1; i > 0; i--) { const j = rndInt(battle, i + 1); const t = arr[i]; arr[i] = arr[j]; arr[j] = t; }
    return arr;
  }
  const stableSortDesc = (arr, key) => arr.map((v, i) => [v, i]).sort((a, b) => key(b[0]) - key(a[0]) || a[1] - b[1]).map((x) => x[0]);
  const stableSortAsc = (arr, key) => arr.map((v, i) => [v, i]).sort((a, b) => key(a[0]) - key(b[0]) || a[1] - b[1]).map((x) => x[0]);

  // attrValue[VALUE_TYPE, ACTOR_ATTR_TYPE] (float[,] in C#)
  function attr(u, vt, at) {
    const row = u && u.attr && u.attr[vt];
    return f32(row ? row[at] || 0 : 0);
  }
  const maxHp = (u) => u.maxHp || 0;
  const hpRate = (u) => (maxHp(u) > 0 ? f32(f32(u.hp) / f32(maxHp(u))) : 0); // Creature.GetHPRate (float)
  const getAtk = (u) => (LOSim.stats && LOSim.stats.getAtk ? LOSim.stats.getAtk(u) : attr(u, VT.ABS, AT.ATK));
  const getTurnSpeed = (u) => (LOSim.stats && LOSim.stats.getTurnSpeed ? LOSim.stats.getTurnSpeed(u) : attr(u, VT.ABS, AT.TURNSPEED));

  // Table_GlobalValue lookup by Type (DataManager.Table.cs:496)
  let gvCache = null;
  function gv(name, def) {
    if (!gvCache) {
      gvCache = {};
      const tbl = T('Table_GlobalValue') || {};
      for (const k in tbl) gvCache[num(tbl[k], 'Type')] = num(tbl[k], 'Value');
    }
    const v = gvCache[E.GLOBAL_VALUE_TYPE[name]];
    return v === undefined ? def : v;
  }

  // =====================================================================================
  // buff access (buffs.js owns buff instances; these are guarded adapters)
  // Buff instance fields expected (any of the aliases): effectType|type|BuffEffectType, attrValue|AttrValue,
  // value|BuffEffectValue, valuePerLevel|BuffEffectValuePerLevel, skillLevel, addSkillLevel, from|FromCreature,
  // id|BuffID, leftRound|LeftRoundCount, eraseType|BuffEffectEraseType, eraseTrigger|BuffEffectEraseTriggerType, key
  // =====================================================================================
  const B = () => LOSim.buffs || {};
  const bType = (b) => (b.effectType !== undefined ? b.effectType : b.type !== undefined ? b.type : b.BuffEffectType);
  const bAttr = (b) => f32(b.attrValue !== undefined ? b.attrValue : b.AttrValue || 0);
  function bSetAttr(b, v) { if (b.attrValue !== undefined || b.AttrValue === undefined) b.attrValue = v; else b.AttrValue = v; }
  const bFrom = (b) => b.from || b.src || b.FromCreature || b.fromUnit || null;
  const bId = (b) => (b.id !== undefined ? b.id : b.BuffID || 0);
  const bBase = (b) => f32(b.value !== undefined ? b.value : b.BuffEffectValue || 0);
  const bLeft = (b) => (b.left !== undefined ? b.left : b.leftRound !== undefined ? b.leftRound : b.LeftRoundCount);
  function bSetLeft(b, v) { if (b.left !== undefined) b.left = v; else if (b.leftRound !== undefined || b.LeftRoundCount === undefined) b.leftRound = v; else b.LeftRoundCount = v; }
  const bEraseType = (b) => (b.eraseType !== undefined ? b.eraseType : b.BuffEffectEraseType !== undefined ? b.BuffEffectEraseType : b.table ? num(b.table, 'BuffEffectEraseType') : undefined);
  const bEraseTrigger = (b) => (b.eraseTriggerType !== undefined ? b.eraseTriggerType : b.eraseTrigger !== undefined ? b.eraseTrigger : b.BUffEffectEraseTriggerType !== undefined ? b.BUffEffectEraseTriggerType : b.table ? num(b.table, 'BuffEffectEraseTriggerType', -1) : undefined);
  const bKey = (b) => b.key || b.Key || (b.table && b.table.Key) || '';
  // Common.cs:5902 GetValueLevelPer
  function bLevelValue(b) {
    if (B().levelValue) return f32(B().levelValue(b));
    const per = f32(b.valuePerLevel !== undefined ? b.valuePerLevel : b.BuffEffectValuePerLevel || 0);
    const lv = (b.skillLevel !== undefined ? b.skillLevel : b.SkillLevel || 1) + (b.addSkillLevel || b.AddSkillLevel || 0);
    return f32(bBase(b) + (lv - 1) * per);
  }
  function flatBuffs(u) {
    const out = [];
    for (const e of u.buffs || []) {
      if (!e) continue;
      if (Array.isArray(e.buffs)) out.push(...e.buffs); else out.push(e);
    }
    return out;
  }
  function buffList(u, type) { // ActiveBuffList.CheckExistBuff(type, ref List<Buff>)
    if (!u) return [];
    if (B().list) return B().list(u, type) || [];
    return flatBuffs(u).filter((b) => bType(b) === type);
  }
  function hasBuff(u, type) { // ActiveBuffList.CheckExistBuff(type)
    if (!u) return false;
    if (B().has) return !!B().has(u, type);
    return buffList(u, type).length > 0;
  }
  const firstBuff = (u, type) => buffList(u, type)[0] || null;
  function bval(u, type) { // Creature.GetBuffEffectValue (Creature.cs:8034) float, each term rounded to 5 digits
    if (!u) return 0;
    if (B().value) return f32(B().value(u, type) || 0);
    let v = 0;
    for (const b of buffList(u, type)) v = f32(v + f32(Math.round(bLevelValue(b) * 1e5) / 1e5));
    return v;
  }
  function battrSum(u, type) { // Creature.GetAttrValue (Creature.cs:8049) = sum of Buff.AttrValue
    if (B().attrValue) return f32(B().attrValue(u, type) || 0);
    let v = 0;
    for (const b of buffList(u, type)) v = f32(v + bAttr(b));
    return v;
  }
  function removeBuffObj(battle, u, buff) {
    if (B().remove) B().remove(battle, u, (b) => b === buff);
    else if (u.buffs) u.buffs = u.buffs.filter((b) => b !== buff && !(b.buffs && b.buffs.includes(buff)));
  }
  function removeBuffType(battle, u, type) { // Common.cs:5798 RemoveBuff(type): removes all of that type
    if (B().remove) B().remove(battle, u, (b) => bType(b) === type);
    else for (const b of buffList(u, type)) removeBuffObj(battle, u, b);
  }
  function eraseByTrigger(battle, u, trig) { // Creature.CheckErasePassiveBuffTirgger 8714
    if (B().eraseTrigger) return B().eraseTrigger(battle, u, trig);
    if (trig !== TR.USE_SKILL_ENEMY && trig !== TR.AFTER_COUNTER) return;
    if (B().remove) B().remove(battle, u, (b) => bEraseTrigger(b) === trig);
  }
  function removeBuffStack(battle, u, key, count) { // Creature.RemoveBuffStack 8920 -> RemoveBuffCount
    if (!count) return;
    if (B().removeStack) return B().removeStack(battle, u, key, count);
    let n = 0;
    if (B().remove) B().remove(battle, u, (b) => { if (n < count && bKey(b) === key) { n++; return true; } return false; });
  }
  function trig(battle, type, ctx) {
    if (!B().trigger) return;
    if (ctx && ctx.triggerValue !== undefined && ctx.value === undefined) ctx.value = ctx.triggerValue; // buffs.js reads ctx.value
    B().trigger(battle, type, ctx);
  }
  function recalc(battle, units) {
    if (!(LOSim.stats && LOSim.stats.recalc)) return;
    for (const u of new Set(units)) if (u && alive(u)) LOSim.stats.recalc(u, battle);
  }

  // =====================================================================================
  // unit / grid helpers
  // =====================================================================================
  const TEAM_PC = 1, TEAM_MOB = 0;
  const isAutopilot = (u) => u.type === 'SUMMON' && num(u.table, 'SummonType') === E.SUMMON_TYPE.AUTOPILOT;
  function enemiesOf(battle, u) { return battle.units.filter((x) => alive(x) && x.team !== u.team); }
  function alliesOf(battle, u) { return battle.units.filter((x) => alive(x) && x.team === u.team && x !== u); }
  // LineData.LineCreature: prefer the PC/monster standing on the slot, then an autopilot summon, then any summon.
  // (approximation: installation/environmental summons share slots with PCs in the client)
  function unitAt(battle, team, gridPos, ov) {
    let best = null, rank = 9;
    for (const x of battle.units) {
      if (!alive(x) || x.team !== team) continue;
      const p = ov && ov.has(x) ? ov.get(x) : x.gridPos;
      if (p !== gridPos) continue;
      const r = x.type !== 'SUMMON' ? 0 : isAutopilot(x) ? 1 : 2;
      if (r < rank) { best = x; rank = r; }
    }
    return best;
  }
  // Creature.cs:94-103 (LineSpot setter): Cell is "column distance from the front line".
  const cellOf = (u) => (u.type === 'CHARACTER' || u.type === 'SUMMON' ? (8 - u.gridPos) % 3 : Math.abs(u.gridPos) % 3);
  const rowOf = (u) => Math.floor(u.gridPos / 3) + 1;
  const oriPos = (u) => (u.oriGridPos !== undefined ? u.oriGridPos : u.gridPos); // OriLineSpot (CellGrid/RowGrid, Creature.cs:136-153)
  const lineType = (team) => (team === TEAM_PC ? 'CHARACTER' : 'MONSTER');
  const lineCell = (team, slot) => (team === TEAM_PC ? (8 - slot) % 3 : slot % 3); // Skill.cs:217-225
  const lineRow = (slot) => Math.floor(slot / 3) + 1;

  // =====================================================================================
  // skill helpers
  // =====================================================================================
  const lt = (skill) => (skill && skill.levelTable) || null;
  const st = (skill) => (skill && skill.table) || null;
  const slotOf = (skill) => (skill ? num(st(skill), 'SkillSlotType', skill.slot || 0) : 0);
  const targetType = (skill) => num(st(skill), 'TargetType');
  function gridOf(skill) { return T('Table_Grid', str(lt(skill), 'GridIndex')) || null; }
  function gridData(grid) { // DataManager.GetTargetGridData (DataManager.Table.cs:617)
    const out = [];
    if (!grid) return out;
    for (let p = 1; p <= 9; p++) {
      const s = str(grid, 'Pos' + p);
      if (s !== '') out.push({ pos: p, persent: parseFloat(s) });
    }
    return out;
  }
  function skillBySlot(u, slot) {
    return (u.skills || []).find((s) => slotOf(s) === slot) || null;
  }
  function findSkill(u, key, levelHint) {
    const s = (u.skills || []).find((x) => x.key === key);
    if (s) return s;
    const table = T('Table_Skill', key);
    if (!table) return null;
    const level = levelHint || 1;
    const levelTable = T('Table_SkillLevel', key + '_Lv' + level) || T('Table_SkillLevel', key + '_Lv1');
    return { key, level, slot: num(table, 'SkillSlotType'), table, levelTable, cooldownLeft: 0, _synthetic: true };
  }
  // Creature.GetSkillAttackRate (Creature.cs:5915)
  function skillAttackRate(a, skill) {
    const v = parseFloat(str(lt(skill), 'SkillAttackRate', '0')) || 0;
    if (v === 0) return 0;
    if (a.type === 'CHARACTER') {
      const up = (a.coreLinkFunc && a.coreLinkFunc.stageSkillRatioUp) || a.coreSkillRatioUp || 0;
      if (up) return v + up; // coreLinkFuncEffect.StageSkillRatioUp (Character.cs:1652)
    }
    return v;
  }
  // Creature.GetBuffDistance (Creature.cs:8891): uses the raw BuffEffectValue sum (List<Buff>.GetValue)
  function buffDistance(u, skill) {
    const sumBase = (type) => buffList(u, type).reduce((a, b) => a + bBase(b), 0);
    let d = Math.round(sumBase(BT.STAT_RANGE_VALUE));
    const s1 = skillBySlot(u, 1), s2 = skillBySlot(u, 2);
    if (s1 && s1.key === skill.key) d += Math.round(sumBase(BT.STAT_RANGE_VALUE_ACTIVE_SKILL_1));
    if (s2 && s2.key === skill.key) d += Math.round(sumBase(BT.STAT_RANGE_VALUE_ACTIVE_SKILL_2));
    return d;
  }
  // Skill.GetSkillDistance (Skill.cs:179)
  function skillDistance(u, skill, opts) {
    if (opts && opts.reserve && opts.reserve.distance !== undefined) return opts.reserve.distance; // Skill.cs:183-187
    const l = lt(skill);
    if (!l) return 0;
    let d = num(l, 'Distance');
    if (u.type === 'CHARACTER') {
      d += ((u.coreLinkFunc && u.coreLinkFunc.stageRangeUp) | 0) || (u.coreRangeUp | 0); // ClientData.GetCoreRangeUP
    }
    return Math.max(1, d + buffDistance(u, skill));
  }
  // Skill.IsDistance (Skill.cs:204). target = Unit, or line = {team, slot}
  function isDistance(a, skill, target, line, opts) {
    let cell = 0, row = 0, tType = 'NONE';
    if (target) { cell = cellOf(target); row = rowOf(target); tType = target.type; }
    else if (line) { cell = lineCell(line.team, line.slot); row = lineRow(line.slot); tType = lineType(line.team); }
    const d = skillDistance(a, skill, opts);
    if (a.type !== tType) {
      if (a.type === 'SUMMON' && tType === 'CHARACTER') return Math.abs(cellOf(a) - cell) <= d && Math.abs(rowOf(a) - row) <= d;
      return Math.abs(cellOf(a) + cell + 1) <= d;
    }
    return Math.abs(cellOf(a) - cell) <= d && Math.abs(rowOf(a) - row) <= d;
  }
  // BattleManager.GetTargetListBySkillDistance (3845) -> GetMonsterCellDist / GetPcCellDist (3137/3165)
  function enemyCandidates(battle, a, dist) {
    if (a.type === 'SUMMON' && !isAutopilot(a)) return [];
    const out = [];
    for (const x of battle.units) {
      if (!alive(x) || x.team === a.team) continue;
      if (x.type === 'SUMMON' && (!isAutopilot(x) || num(x.table, 'SummonType') === E.SUMMON_TYPE.ENVIRONMENTAL)) continue;
      if (cellOf(a) + cellOf(x) + 1 <= dist) out.push(x); // GetCellDistance 3125
    }
    return out;
  }
  // BattleManager.GetOurTargetListBySkillDistance (3874) -> GetPcBuffDist / GetMonsterBuffDist (3193/3212)
  function ourCandidates(battle, a, dist, tt) {
    if (a.type === 'SUMMON' && !isAutopilot(a)) return null;
    const wantType = a.team === TEAM_PC ? 'CHARACTER' : 'MONSTER';
    const allowSelf = a.type === 'CHARACTER' && tt === TT.OUR_GRID;
    return battle.units.filter((x) => alive(x) && x.team === a.team && x.type === wantType &&
      Math.abs(cellOf(a) - cellOf(x)) <= dist && Math.abs(rowOf(a) - rowOf(x)) <= dist && (allowSelf || x !== a));
  }
  const crossDist = (a, x) => Math.abs(cellOf(x) + cellOf(a) + 1); // GetTargetList 6400-6401 / CheckDistance 3903

  // =====================================================================================
  // grid area (Creature.DoAttackTarget(grid) 5935, GetTargetList 6393)
  // =====================================================================================
  function areaAround(battle, grid, gd, side, centerSlot, ov) {
    const out = [];
    if (!grid || centerSlot === undefined || centerSlot === null || centerSlot < 0 || centerSlot > 8) return out;
    const sp = num(grid, 'StandardPoint'), usePoint = num(grid, 'UsePoint');
    const centerRow = Math.floor(sp / 3) + 1, centerCell = sp % 3;
    const distRow = lineRow(centerSlot) - centerRow, distCell = (centerSlot % 3) - centerCell; // LineData.Row()/Cell() raw
    for (const g of gd) {
      const gdRow = Math.floor((g.pos - 1) / 3) + 1, gdCell = (g.pos - 1) % 3;
      const r = usePoint !== 0 ? gdRow + distRow : gdRow; // Creature.cs:5953
      const c = usePoint !== 0 ? gdCell + distCell : gdCell;
      if (c >= 0 && c <= 2 && r >= 1 && r <= 3) {
        const x = unitAt(battle, side, (r - 1) * 3 + c, ov);
        if (x && !out.includes(x)) out.push(x);
      }
    }
    return out;
  }
  function enemySideOf(a) { return a.type === 'MONSTER' ? TEAM_PC : (a.type === 'SUMMON' ? 1 - a.team : TEAM_MOB); }
  function ownSideOf(a) { return a.type === 'MONSTER' ? TEAM_MOB : (a.type === 'SUMMON' ? a.team : TEAM_PC); }

  // Creature.GetTargetList (6393). sel = {target, gridPos}; targetParam = the `target` argument.
  function getTargetList(battle, a, skill, sel, targetParam, opts) {
    const tt = targetType(skill), grid = gridOf(skill), gd = gridData(grid);
    let target = targetParam;
    let units = [];
    if (sel.target) {
      const f = sel.target;
      if (alive(f) && f !== a) {
        // 6400: always the cross-side formula, even for ally (OUR) targets -> ally out of "range" gets TargetAid=0
        if (crossDist(a, f) <= skillDistance(a, skill, opts)) { units.push(f); target = f; }
        else sel.target = null; // skillInfo.TargetAid = 0
      } else if (!alive(f)) sel.target = null;
    }
    if (tt === TT.ENEMY_GRID || tt === TT.OUR_GRID) {
      units = [];
      const side = tt === TT.ENEMY_GRID ? enemySideOf(a) : ownSideOf(a);
      const gp = sel.gridPos;
      const valid = gp !== undefined && gp !== null && gp >= 0 && gp <= 8;
      if (tt === TT.OUR_GRID && !valid) { /* targetLine null -> nothing */ }
      else if (isDistance(a, skill, null, valid ? { team: side, slot: gp } : null, opts)) units = areaAround(battle, grid, gd, side, valid ? gp : -1);
      else sel.gridPos = 255;
      if (tt === TT.ENEMY_GRID && opts && opts.isReserve) return { ok: true, units }; // 6437: reserve grid never retargets
    } else if (target) {
      for (const x of areaAround(battle, grid, gd, target.team, oriPos(target))) if (!units.includes(x)) units.push(x); // RowGrid/CellGrid (6480)
    }
    if (num(lt(skill), 'IsSummonSkill') === 1) return { ok: units.length === 0, units }; // 6512
    return { ok: units.length > 0, units };
  }

  // =====================================================================================
  // GetTargetAI(RANDOM) (BattleManager.cs:4121) incl. provoke / marking (4328/4355) and PC best-count (4224)
  // =====================================================================================
  function isMarkingOrProvoke(t, a) { // Creature.cs:8951
    const p = firstBuff(a, BT.STAGE_PROVOKE);
    if (p && bFrom(p) === t) return true;
    return hasBuff(t, BT.STAGE_MARKING);
  }
  function provokeTarget(a, cands, dist) { // 4328
    if (cands.length && cands[0].type === a.type) return null;
    const p = firstBuff(a, BT.STAGE_PROVOKE);
    const pc = p && bFrom(p);
    if (pc && alive(pc) && pc.type !== a.type && cellOf(a) + cellOf(pc) + 1 <= dist) return pc;
    return null;
  }
  function markingTarget(a, cands, dist) { // 4355
    if (cands.length && cands[0].type === a.type) return null;
    const marked = stableSortAsc(cands.filter((t) => hasBuff(t, BT.STAGE_MARKING)), (t) => t.hp);
    for (const t of marked) if (cellOf(a) + cellOf(t) + 1 <= dist) return t;
    return null;
  }
  function targetAI(battle, a, skill, sel, opts) {
    if (sel.target && alive(sel.target)) return true; // 4123
    const tt = targetType(skill), l = lt(skill);
    const slotSkill = skillBySlot(a, slotOf(skill)) || skill; // GetSkillDistance(actor, Table_Skill) uses the slot skill
    const dist = skillDistance(a, slotSkill, opts);
    const cands = tt === TT.OUR || tt === TT.OUR_GRID ? ourCandidates(battle, a, dist, tt) : enemyCandidates(battle, a, dist);
    if (!cands) return false;
    const isSelf = tt === TT.SELF;
    if (!isSelf && cands.length === 0 && num(l, 'IsSummonSkill') === 0 && (a.type !== 'CHARACTER' || tt !== TT.ENEMY_GRID)) return false;
    if (cands.length > 0) {
      const p = provokeTarget(a, cands, dist) || markingTarget(a, cands, dist);
      sel.target = p || cands[rndInt(battle, cands.length)];
    }
    if (isSelf) sel.target = a;
    if (num(l, 'IsSummonSkill') === 1) return pickSummonSlot(battle, a, skill, sel, opts); // 4179
    const grid = gridOf(skill);
    const main = sel.target;
    if (tt === TT.OUR_GRID || tt === TT.ENEMY_GRID) {
      if (main) sel.gridPos = main.gridPos;
      if (grid && num(grid, 'UsePoint') === 0) sel.gridPos = num(grid, 'StandardPoint');
    }
    let count = cands.length;
    if (a.type === 'CHARACTER' && (!main || !isMarkingOrProvoke(main, a))) {
      if (tt === TT.ENEMY_GRID) {
        let best = sel.gridPos;
        if (best !== undefined && best !== 255) count = getTargetList(battle, a, skill, { gridPos: best }, null, opts).units.length;
        const lines = [];
        for (let s = 0; s < 9; s++) if (cellOf(a) + s % 3 + 1 <= skillDistance(a, skill, opts)) lines.push(s); // GetMonsterLineDistance
        for (const s of shuffle(battle, lines)) {
          const n = getTargetList(battle, a, skill, { gridPos: s }, null, opts).units.length;
          if (n > count) { best = s; count = n; }
        }
        sel.target = null; sel.gridPos = best;
      } else if (tt === TT.ENEMY) {
        let best = sel.target;
        count = getTargetList(battle, a, skill, { target: best }, best, opts).units.length;
        for (const e of shuffle(battle, enemyCandidates(battle, a, skillDistance(a, skill, opts)))) {
          const n = getTargetList(battle, a, skill, { target: e }, e, opts).units.length;
          if (n > count) { best = e; count = n; }
        }
        sel.target = best;
      }
    }
    if (a.type === 'CHARACTER') return count > 0 || isSelf;
    return count > 0;
  }

  // =====================================================================================
  // protect / guard (Creature.IsDoAttackTarget 6069-6365, StageMapData 1090-1324)
  // =====================================================================================
  function sameTypeAt(battle, t, slot) {
    return battle.units.find((x) => alive(x) && x.team === t.team && x.type === t.type && x.gridPos === slot) || null;
  }
  function shelterAt(battle, team, slot) {
    return battle.units.find((x) => alive(x) && x.team === team && x.type === 'SUMMON' && x.gridPos === slot && num(x.table, 'IsShelter') === 1) || null;
  }
  const FRONT_PC = { 0: [1, 2], 1: [2], 3: [4, 5], 4: [5], 6: [7, 8], 7: [8] };
  const FRONT_MOB = { 1: [0], 2: [0, 1], 4: [3], 5: [3, 4], 7: [6], 8: [6, 7] };
  function frontBlockLine(battle, t) { // StageMapData.IsFrontActorBlockLine 1090
    let pcVariant;
    if (t.type === 'CHARACTER') pcVariant = true;
    else if (t.type === 'SUMMON') {
      if (!isAutopilot(t)) return null;
      pcVariant = num(t.table, 'InstallPosType') === E.INSTALL_POS_TYPE.PC;
    } else pcVariant = false;
    const slots = (pcVariant ? FRONT_PC : FRONT_MOB)[t.gridPos] || [];
    const found = [];
    for (const gp of slots) {
      const x = sameTypeAt(battle, t, gp);
      if (x && hasBuff(x, BT.STAGE_BLOCK_LINE)) found.push(x);
      const s = shelterAt(battle, t.team, gp);
      if (s) found.push(s);
    }
    if (found.length === 2) {
      if (pcVariant) return stableSortDesc(found, (x) => x.gridPos)[0]; // 1175-1181
      return t; // 1250-1256: client bug `select actor` -> the attacked unit itself
    }
    if (found.length === 1) return found[0];
    return null;
  }
  function blockRow(battle, t) { // StageMapData.IsBlockRow 1267
    const col = t.gridPos % 3;
    const found = [];
    for (const gp of [6 + col, 3 + col, col]) {
      const x = sameTypeAt(battle, t, gp);
      if (x && hasBuff(x, BT.STAGE_BLOCK_ROW)) found.push(x);
    }
    if (found.length === 1) return found[0] !== t ? found[0] : null;
    if (found.length > 1) return stableSortDesc(found, (x) => x.hp)[0];
    return null;
  }
  function applyProtection(battle, a, skill, targetList, ati, opts) {
    const ss = ati.ss;
    const rmSS = (x) => { const i = ss.indexOf(x); if (i >= 0) ss.splice(i, 1); };
    const rmT = (u) => { const i = ati.targets.indexOf(u); if (i >= 0) ati.targets.splice(i, 1); };
    const LINE = BT.STAGE_BLOCK_LINE, ROW = BT.STAGE_BLOCK_ROW, CHAR = BT.STAGE_BLOCK_CHARACTER;
    for (let i = 0; i < targetList.length; i++) {
      let t = targetList[i];
      if (a === t || a.type === t.type) { ati.targets.push(t); continue; } // 6073
      let ignore = num(lt(skill), 'GuardPierce') === 1; // 6086
      if (hasBuff(a, BT.GUARDPIERCE_APPLY)) ignore = true;
      if (hasBuff(a, BT.GUARDPIERCE_NO_APPLY)) ignore = false;
      if (!opts.isCounter && !ignore) {
        let eff = null, blocker = null;
        const bl = frontBlockLine(battle, t); // 6102
        if (bl) {
          const fbc = ss.find((p) => p.block === t && p.eff === CHAR);
          const fbtc = ss.find((p) => p.target === bl);
          if (!fbc) {
            if (fbtc) { rmSS(fbtc); rmT(fbtc.block); }
            const fb = ss.find((p) => p.target === t);
            if (fb) { rmSS(fb); rmT(fb.block); }
            t = bl; eff = LINE; blocker = bl;
          }
        }
        if (!blocker) { // 6147
          const br = blockRow(battle, t);
          if (br) {
            const fba = ss.find((p) => p.block === t && p.eff === LINE);
            const fbc = ss.find((p) => p.block === t && p.eff === CHAR);
            const ftbc = ss.find((p) => p.target === br && p.eff === CHAR);
            if (!fba && !fbc) { t = br; eff = ROW; blocker = br; }
            if (ftbc) { rmSS(ftbc); rmT(ftbc.block); }
          }
        }
        if (blocker) { // 6183
          ss.push({ type: 'block', target: targetList[i], block: t, eff, isOriginalAttacked: targetList.includes(t) });
        } else { // 6205: designated protection (STAGE_BLOCK_CHARACTER)
          const lst = stableSortDesc(buffList(t, CHAR).filter((b) => bFrom(b)), (b) => bFrom(b).hp);
          for (const fbuf of lst) {
            let P = bFrom(fbuf);
            if (!P || !alive(P)) continue;
            const fba = ss.find((p) => p.block === P && p.eff === CHAR);
            if (fba && fba.target) {
              if (t.hp > fba.target.hp) P = null;
              else { rmSS(fba); if (ati.targets.includes(fba.block)) { rmT(fba.block); ati.targets.push(fba.target); } }
            }
            if (ss.find((p) => p.target === t && (p.eff === LINE || p.eff === ROW))) P = null;
            if (P) {
              const fbc2 = ss.find((p) => p.target === P && p.eff === CHAR);
              if (fbc2 && fbc2.block !== t) P = null;
              if (P) { const fta = ss.find((p) => p.block === t && p.eff === CHAR); if (fta && fta.target !== P) P = null; }
            }
            if (ss.find((p) => p.block === t && (p.eff === LINE || p.eff === ROW))) P = null;
            if (P) { const fbt = ss.find((p) => p.target === P && (p.eff === LINE || p.eff === ROW)); if (fbt) { rmSS(fbt); rmT(fbt.block); } }
            if (P && P.type === t.type) { // 6304
              ss.push({ type: 'block', target: t, block: P, eff: CHAR, isOriginalAttacked: targetList.includes(P) });
              t = P;
              break;
            }
          }
        }
      }
      if (!ati.targets.includes(t)) ati.targets.push(t); // 6337
    }
    // 6341-6365: mutual designated protection resolution
    const lbc = ss.filter((p) => p.eff === CHAR);
    if (lbc.length > 0) {
      let find = null;
      for (const blk of lbc) { // GetTogeter 6368
        const f = lbc.filter((p) => p.target === blk.block && p.block === blk.target);
        if (f.length > 0) { find = f[0].block.hp > blk.block.hp ? blk : f[0]; break; }
      }
      if (find) { rmSS(find); rmT(find.block); lbc.splice(lbc.indexOf(find), 1); }
      const removed = [];
      for (const blk of lbc) {
        const f = lbc.find((p) => p.target === blk.block);
        if (f && !removed.includes(blk)) { removed.push(f); rmSS(f); rmT(f.block); }
      }
    }
  }

  // =====================================================================================
  // GetDamageRateByGridPos (Creature.cs:8077). ov = temporary slot override (protector jump-swap)
  // =====================================================================================
  function damageRateByGridPos(battle, a, grid, gd, mainGridPos, t, standard, tt, ov) {
    if (!grid) return 0;
    const sp = num(grid, 'StandardPoint');
    const centerRow = Math.floor(sp / 3) + 1, centerCell = sp % 3;
    const scan = (side, cRow, cCell) => {
      for (const g of gd) {
        const r = Math.floor((g.pos - 1) / 3) + 1 + (cRow - centerRow);
        const c = (g.pos - 1) % 3 + (cCell - centerCell);
        if (c >= 0 && c <= 2 && r >= 1 && r <= 3) {
          if (unitAt(battle, side, (r - 1) * 3 + c, ov) === t) return f32(g.persent);
        }
      }
      return 0;
    };
    if (tt === TT.ENEMY_GRID || tt === TT.OUR_GRID) {
      if (mainGridPos === undefined || mainGridPos < 0 || mainGridPos > 8) return 0;
      const side = tt === TT.ENEMY_GRID ? (a.type === 'MONSTER' ? TEAM_PC : TEAM_MOB) : (a.type === 'MONSTER' ? TEAM_MOB : TEAM_PC);
      return scan(side, lineRow(mainGridPos), mainGridPos % 3); // relative regardless of UsePoint (8104)
    }
    if (tt === TT.ENEMY || tt === TT.OUR) {
      if (!standard) return 0; // C# would NRE here (standardActor null)
      const side = a.type === 'MONSTER' ? (tt === TT.OUR ? TEAM_MOB : TEAM_PC) : (tt === TT.OUR ? TEAM_PC : TEAM_MOB);
      const so = oriPos(standard);
      return scan(side, Math.floor(so / 3) + 1, so % 3);
    }
    return 0;
  }

  // Creature.GetResist (Creature.cs:7962)
  function getResist(u, rt) {
    if (LOSim.stats && LOSim.stats.getResist) return LOSim.stats.getResist(u, rt);
    let v = attr(u, VT.RATE, rt);
    let minT = BT.RESFIRE_VALUE_MIN, fixT = BT.RESFIRE_VALUE_FIX, sysMin = -Number.MAX_VALUE, sysMax = Number.MAX_VALUE;
    if (rt === AT.FIRE_RESIST) { sysMin = gv('MIN_FIRE_RESIST', sysMin); sysMax = gv('MAX_FIRE_RESIST', sysMax); }
    else if (rt === AT.ICE_RESIST) { minT = BT.RESICE_VALUE_MIN; fixT = BT.RESICE_VALUE_FIX; sysMin = gv('MIN_ICE_RESIST', sysMin); sysMax = gv('MAX_ICE_RESIST', sysMax); }
    else if (rt === AT.LIGHTNING_RESIST) { minT = BT.RESLIGHTNING_VALUE_MIN; fixT = BT.RESLIGHTNING_VALUE_FIX; sysMin = gv('MIN_LIGHTNING_RESIST', sysMin); sysMax = gv('MAX_LIGHTNING_RESIST', sysMax); }
    const fix = buffList(u, fixT);
    if (fix.length) { let fv = 0; for (const b of fix) fv = f32(fv + bLevelValue(b)); return fv; }
    const mins = buffList(u, minT);
    if (mins.length) { let mv = 0; for (const b of mins) mv += bLevelValue(b); if (v < mv) v = mv; }
    if (v < sysMin) v = sysMin; else if (v > sysMax) v = sysMax;
    return v;
  }

  // Adaptive magic types (RESIST_CHECK_ATTACK_POWER) from the skill level's buff effects (Creature.cs:6939-6966)
  function adaptiveTypes(skill) {
    const out = [];
    for (const k of list(lt(skill), 'BuffEffectIndex')) {
      const be = T('Table_BuffEffect', k);
      if (!be) continue;
      for (let n = 1; n <= 3; n++) {
        if (num(be, 'BuffEffectType' + n) === BT.RESIST_CHECK_ATTACK_POWER) {
          const s = str(be, 'BuffEffectValue' + n, '0');
          if (/^\s*[-+]?\d+\s*$/.test(s)) out.push(parseInt(s, 10)); // int.TryParse
        }
      }
      if (out.length > 1) break;
    }
    return out;
  }

  // =====================================================================================
  // shared HP-loss / heal / death paths
  // =====================================================================================
  function resolveDeathPre(battle, t, res) { // BattleManager.RemoveTargetResult 2165 (resurrect check at hit time)
    if (t.hp > 0) return false;
    const rb = firstBuff(t, BT.STAGE_RESURRECT_RATIO) || firstBuff(t, BT.STAGE_RESURRECT);
    if (!rb) return false;
    deathTriggers(battle, t); // DeathBuffeffect is called on the resurrect path too (2188)
    const isFlat = bType(rb) === BT.STAGE_RESURRECT;
    removeBuffObj(battle, t, rb);
    t.hp = isFlat ? Math.trunc(bAttr(rb)) : Math.trunc(maxHp(t) * bAttr(rb)); // SetResurrectHp 2205/2209
    if (t.hp > maxHp(t)) t.hp = maxHp(t);
    trig(battle, TR.IF_RESURRECT, { owner: t, skill: null, attacker: t, targets: null, triggerValue: '' });
    log(battle, 'resurrect', { dst: uref(t), hp: t.hp });
    if (res) (res.resurrects = res.resurrects || []).push(t);
    return true;
  }
  function deathTriggers(battle, t) { // BattleManager.DeathBuffeffect 2251
    let mine = [], theirs = [];
    const pick = (type) => battle.units.filter((x) => x.type === type && (alive(x) || x === t));
    if (t.type === 'CHARACTER') { mine = pick('CHARACTER'); theirs = pick('MONSTER'); }
    else if (t.type === 'MONSTER') { mine = pick('MONSTER'); theirs = pick('CHARACTER'); }
    for (const x of mine) trig(battle, TR.FRIENDLY_DEATH, { owner: x, skill: null, attacker: x, dead: t }); // `this == actor` never true -> the dead unit is included
    for (const x of theirs) trig(battle, TR.ENEMY_DEATH, { owner: x, skill: null, attacker: x, dead: t });
    trig(battle, TR.DEATH, { owner: t, skill: null, attacker: t, dead: t });
  }
  function onDeath(battle, t, killer) { // fallback death path (no buffs.onDeath)
    if (t._deadHandled) return;
    t._deadHandled = true;
    t.hp = Math.min(t.hp, 0);
    log(battle, 'death', { dst: uref(t), by: uref(killer) });
    deathTriggers(battle, t);
  }
  // HP <= 0: resurrect check (RemoveTargetResult 2165) + DeathBuffeffect (2251) + aura removal. Returns true if resurrected.
  // With buffs.js present its onDeath does all of it at once (client: resurrect at hit time, death triggers on the die
  // animation -- so DEATH/FRIENDLY_DEATH may fire a little earlier here than in the client, before other targets' BEATEN).
  function processDeath(battle, t, killer, res) {
    if (t.hp > 0 || t._deadHandled) return false;
    if (B().onDeath) {
      if (B().onDeath(battle, t)) {
        log(battle, 'resurrect', { dst: uref(t), hp: t.hp });
        if (res) (res.resurrects = res.resurrects || []).push(t);
        return true;
      }
      t._deadHandled = true;
      log(battle, 'death', { dst: uref(t), by: uref(killer) });
      return false;
    }
    if (resolveDeathPre(battle, t, res)) return true;
    onDeath(battle, t, killer);
    return false;
  }
  function killTriggers(battle, owner, skill, targets, mode) { // CreatureState_SkillAttack.LateDamage 1210-1268
    if (!owner) return;
    const ctx = (sk) => ({ owner, skill: sk, attacker: owner, targets, triggerValue: '' });
    if (mode !== 'counter') trig(battle, TR.IF_ENEMYKILL, ctx(skill));
    trig(battle, TR.IF_ENEMYKILL_PASSIVE, ctx(null));
    trig(battle, TR.IF_ENEMYKILL_AND_IF_COUNTERKILL, ctx(mode === 'counter' ? null : skill));
  }

  // applyDamage: shared HP-loss path (DOT / buff damage / reflect). info:
  //   {kind:'dot'|'buff'|'skill', skill, crit, shield:bool (absorb IMMUNESHIELD/DEF_DAMAGE_REDUCE first),
  //    hitTriggers:bool (BEATEN... default: kind!=='dot' && !!skill), killTriggers:bool (default true), noLog}
  function absorbShields(battle, t, total, a, res) { // Creature.cs:7189-7255
    const all = stableSortAsc(buffList(t, BT.STAGE_IMMUNESHIELD_VALUE).concat(buffList(t, BT.DEF_DAMAGE_REDUCE)), bId);
    let absorbed = 0;
    for (const s of all) {
      if (total <= 0) break;
      const av = bAttr(s);
      if (av <= 0) continue;
      if (av >= total) { absorbed += Math.trunc(total); bSetAttr(s, f32(av - Math.trunc(total))); total = 0; }
      else { absorbed += Math.trunc(av); total -= av; bSetAttr(s, 0); removeBuffObj(battle, t, s); }
    }
    return { total, absorbed };
  }
  function applyDamage(battle, src, target, amount, info) {
    info = info || {};
    if (!alive(target)) return 0;
    let total = amount, absorbed = 0;
    if (info.shield) { const r = absorbShields(battle, target, total, src); total = r.total; absorbed = r.absorbed; }
    const dmg = total > 0 ? Math.trunc(total) : 0;
    target.hp -= dmg;
    if (dmg > 0) {
      if (src && src.stats) src.stats.dmgDealt += dmg;
      if (target.stats) target.stats.dmgTaken += dmg;
    }
    if (!info.noLog) log(battle, info.kind === 'dot' ? 'dot' : 'damage', { src: uref(src), dst: uref(target), dmg, absorbed, hp: target.hp, crit: !!info.crit, buff: info.buffType });
    // Creature.DoDamage 566-735: resurrect check, then hit triggers while alive
    const resurrected = target.hp <= 0 && processDeath(battle, target, src, null);
    const isHit = dmg !== 0 || absorbed > 0;
    const doHit = info.hitTriggers !== undefined ? info.hitTriggers : info.kind !== 'dot' && !!info.skill;
    if (isHit && alive(target)) {
      if (doHit && src) hitTriggers(battle, target, src, info.skill, info);
      else hpTriggers(battle, target);
    }
    if (isHit && doHit && src) allyHitTriggers(battle, target, src, info.skill, info);
    if (target.hp <= 0 && !resurrected) {
      // BattleRoundManager.ApplyDotBuff 1650-1666: kill triggers only for cross-team kills
      if (src && info.killTriggers !== false && src.type !== target.type && (target.type === 'MONSTER' || src.type === 'MONSTER')) {
        killTriggers(battle, src, info.skill || null, [target], 'normal');
        if (src.stats) src.stats.kills++;
      }
    }
    return dmg;
  }
  function heal(battle, src, target, amount, info) {
    info = info || {};
    if (!alive(target)) return 0;
    const before = target.hp;
    target.hp = Math.min(maxHp(target), target.hp + Math.trunc(amount));
    const healed = target.hp - before;
    if (src && src.stats) src.stats.healDone += healed;
    if (!info.noLog) log(battle, 'heal', { src: uref(src), dst: uref(target), amount: healed, hp: target.hp });
    return healed;
  }

  function hpTriggers(battle, t) { // Creature.DoDamage 696-700
    trig(battle, TR.HP_DOWN, { owner: t, skill: null, attacker: t, triggerValue: String(t.hp) });
    trig(battle, TR.HP_UP, { owner: t, skill: null, attacker: t, triggerValue: String(t.hp) });
  }
  // live victim hit by a skill: OnHitTriggerBuff + HP_DOWN/HP_UP (prefers buffs.onHit)
  function hitTriggers(battle, t, a, skill, opts) {
    if (!alive(t)) return;
    if (B().onHit) {
      B().onHit(battle, t, a, skill, { isCounter: !!(opts && opts.isCounter), isAssist: !!(opts && opts.isAssist), skillAttr: beatenAttr(t, skill) });
      return;
    }
    onHitTriggers(battle, t, a, skill, opts);
    hpTriggers(battle, t);
  }
  // element used for BEATEN_* (BattleManager.cs:6826-6884, adaptive RESIST_CHECK_ATTACK_POWER)
  function beatenAttr(t, skill) {
    const magic = num(lt(skill), 'MagicSkillAttrType');
    const ad = skill ? adaptiveTypes(skill) : [];
    if (ad.length <= 1) return magic;
    let lowestType = 0, lowest = 1;
    const same = [];
    for (const m of ad) {
      const rv = getResist(t, AT.NONE_RESIST + m);
      if (lowest > rv) { lowest = rv; lowestType = m; }
      else if (lowest === rv) { if (!same.includes(lowestType)) same.push(lowestType); lowestType = m; same.push(m); }
    }
    if (same.length === ad.length) lowestType = magic;
    else if (same.length === 2) {
      if (same.includes(magic)) lowestType = magic;
      else lowestType = magic === SA.FIRE ? SA.ICE : magic === SA.ICE ? SA.LIGHTNING : SA.FIRE;
    }
    return lowestType;
  }
  // BattleManager.OnHitTriggerBuff (6764) -- fallback when buffs.onHit is missing
  function onHitTriggers(battle, t, a, skill, opts) {
    const special = opts && (opts.isCounter || opts.isAssist);
    trig(battle, TR.BEATEN, { owner: t, skill: null, attacker: t });
    if (!special) {
      trig(battle, TR.BEATEN_ACTIVESKILL, { owner: t, skill: null, attacker: a });
      const n = countKeyTriggers(t, TR.BEATEN_ACTIVE_SKILL_KEY, skill && skill.key);
      for (let i = 0; i < n; i++) trig(battle, TR.BEATEN_ACTIVE_SKILL_KEY, { owner: t, skill: null, attacker: a, triggerValue: '' });
    }
    trig(battle, TR.BEATEN_PHY + beatenAttr(t, skill), { owner: t, skill: null, attacker: a });
  }
  // BattleManager.OnAllyHitTriggerBuff (6888), called for every unit of the hit unit's side (Creature.cs:702-721)
  function allyHitTriggers(battle, t, a, skill, opts) {
    const special = opts && (opts.isCounter || opts.isAssist);
    const sideType = t.type === 'MONSTER' ? 'MONSTER' : 'CHARACTER';
    const magic = num(lt(skill), 'MagicSkillAttrType');
    for (const u of battle.units) {
      if (!alive(u) || u.type !== sideType) continue;
      if (B().onAllyHit) {
        B().onAllyHit(battle, u, a, skill, { isCounter: !!(opts && opts.isCounter), isAssist: !!(opts && opts.isAssist) });
        if (!special) { // 6903-6918 key-match branch (re-fires BEATEN_ACTIVESKILL_ALLY), not in buffs.onAllyHit
          const n = countKeyTriggers(u, TR.BEATEN_ACTIVE_SKILL_KEY, skill && skill.key);
          for (let i = 0; i < n; i++) trig(battle, TR.BEATEN_ACTIVESKILL_ALLY, { owner: u, skill: null, attacker: a, target: t });
        }
        continue;
      }
      trig(battle, TR.BEATEN_ALLY, { owner: u, skill: null, attacker: u, target: t });
      if (!special) {
        trig(battle, TR.BEATEN_ACTIVESKILL_ALLY, { owner: u, skill: null, attacker: a, target: t });
        const n = countKeyTriggers(u, TR.BEATEN_ACTIVE_SKILL_KEY, skill && skill.key);
        for (let i = 0; i < n; i++) trig(battle, TR.BEATEN_ACTIVESKILL_ALLY, { owner: u, skill: null, attacker: a, target: t }); // client uses _ALLY here (6914)
      }
      const ty = [TR.BEATEN_PHY_ALLY, TR.BEATEN_FIRE_ALLY, TR.BEATEN_ICE_ALLY, TR.BEATEN_LIGHTNING_ALLY][magic];
      if (ty !== undefined) trig(battle, ty, { owner: u, skill: null, attacker: a, target: t });
    }
  }
  // CreatureSkill.GetBuffEffectList(BEATEN_ACTIVE_SKILL_KEY) entries whose TriggerValue equals the attacking skill key
  function countKeyTriggers(u, trigType, key) {
    if (!key) return 0;
    let n = 0;
    for (const s of u.skills || []) {
      const l = lt(s);
      if (!l || num(l, 'BuffEffectUseAvailable') !== 1) continue;
      for (const k of list(l, 'BuffEffectIndex')) {
        const be = T('Table_BuffEffect', k);
        if (be && num(be, 'BuffEffectTriggerType') === trigType && str(be, 'BuffEffectTriggerValue') === key) n++;
      }
    }
    return n;
  }

  // =====================================================================================
  // summon (Creature.SpawnSummonActor 8771)
  // =====================================================================================
  function summonCheck(battle, a, skill, gridPos) {
    const l = lt(skill);
    const key = str(l, 'SummonKeyString');
    const tbl = T('Table_Summon', key);
    if (!tbl || !T('Table_SummonAbility', key)) return { ok: false, why: 'no_table' };
    if (!T('Table_Grid', str(l, 'GridIndex'))) return { ok: false, why: 'no_grid' };
    const same = battle.units.filter((x) => alive(x) && x.key === key).length;
    if (num(tbl, 'SummonOverlapCnt') <= same) return { ok: false, why: 'overlap' };
    if (num(tbl, 'IsUse') === 0) return { ok: false, why: 'not_use' };
    if (gridPos === undefined || gridPos === null || gridPos < 0 || gridPos > 8) return { ok: false, why: 'no_pos' };
    const side = a.team; // GetCharacterLineData / GetMonsterLineData by caster side
    const summonAt = battle.units.find((x) => alive(x) && x.team === side && x.type === 'SUMMON' && x.gridPos === gridPos);
    const sType = num(tbl, 'SummonType');
    if (sType === E.SUMMON_TYPE.INSTALLATION || sType === E.SUMMON_TYPE.ENVIRONMENTAL) {
      if (summonAt) return { ok: false, why: 'occupied' };
    } else if (sType === E.SUMMON_TYPE.AUTOPILOT) {
      if (battle.units.find((x) => alive(x) && x.team === side && x.type !== 'SUMMON' && x.gridPos === gridPos)) return { ok: false, why: 'occupied' };
      if (summonAt) return { ok: false, why: 'occupied' };
    }
    return { ok: true, key, tbl };
  }
  // approximation of StageMapData.CellIsSummonAuto: random free own-side slot inside the skill range
  function pickSummonSlot(battle, a, skill, sel, opts) {
    if (sel.gridPos !== undefined && sel.gridPos !== 255 && summonCheck(battle, a, skill, sel.gridPos).ok) return true;
    const slots = [];
    for (let s = 0; s < 9; s++) {
      if (!isDistance(a, skill, null, { team: a.team, slot: s }, opts)) continue;
      if (summonCheck(battle, a, skill, s).ok) slots.push(s);
    }
    if (!slots.length) return false;
    sel.gridPos = slots[rndInt(battle, slots.length)];
    sel.target = null;
    return true;
  }
  function spawnSummon(battle, a, skill, gridPos, res) {
    const chk = summonCheck(battle, a, skill, gridPos);
    if (!chk.ok) { log(battle, 'summon_fail', { src: uref(a), skill: skill.key, why: chk.why, pos: gridPos }); return null; }
    if (!(LOSim.stats && LOSim.stats.buildSummon)) { log(battle, 'summon_fail', { src: uref(a), skill: skill.key, why: 'no_stats_buildSummon' }); return null; }
    const s = LOSim.stats.buildSummon(chk.key, num(lt(skill), 'SummonLevel', 1), a, gridPos);
    if (!s) return null;
    if (s.team === undefined) s.team = a.team;
    if (s.gridPos === undefined) s.gridPos = gridPos;
    s.owner = s.owner || a;
    if (!battle.units.includes(s)) battle.units.push(s);
    res.summons.push(s);
    log(battle, 'summon', { src: uref(a), skill: skill.key, summon: uref(s) });
    trig(battle, TR.SUMMON_CREATE, { owner: s, skill: null, attacker: s }); // Summon.cs:61
    return s;
  }

  // =====================================================================================
  // skill cooldown (Skill.cs:58-108, renewal)
  // =====================================================================================
  function startCooldown(skill, battle) {
    const cd = Math.max(0, battle && battle.hooks && battle.hooks.cooldownTurns ? battle.hooks.cooldownTurns(skill) : num(lt(skill), 'CooldownTurn'));
    skill.cooldownLeft = cd;
    skill._cdSkip = cd > 0; // the use turn itself is not counted
  }
  function tickCooldowns(unit) { // CreatureSkill.OnOwnerTurnEnded -> Skill.DecreaseCooldown
    for (const s of unit.skills || []) {
      if (s._cdSkip) { s._cdSkip = false; continue; }
      if (s.cooldownLeft > 0) s.cooldownLeft--;
    }
  }
  function resetCooldowns(unit) { // CreatureSkill.ResetAllSkillCooldowns (wave start)
    for (const s of unit.skills || []) { s.cooldownLeft = 0; s._cdSkip = false; }
  }

  // =====================================================================================
  // public: canUse / inRange / targets
  // =====================================================================================
  function normSel(mainTarget) {
    if (mainTarget === undefined || mainTarget === null) return {};
    if (typeof mainTarget === 'number') return { gridPos: mainTarget };
    if (mainTarget instanceof LOSim.Unit || mainTarget.aid !== undefined) return { target: mainTarget, gridPos: mainTarget.gridPos };
    return { target: mainTarget.target || mainTarget.unit || null, gridPos: mainTarget.gridPos };
  }
  function canUse(battle, unit, skill, opts) {
    opts = opts || {};
    if (!alive(unit) || !skill || !lt(skill) || !st(skill)) return false;
    const owner = !opts.isCounter && !opts.isAssist && !opts.isReserve && !opts.isDoubleAction;
    if (owner && skill.cooldownLeft > 0) return false; // Creature.cs:1844-1856
    if (hasBuff(unit, BT.STAGE_SEAL_SKILL) && !opts.isReserve) return false; // 2014
    if (num(lt(skill), 'IsSummonSkill') === 1) return pickSummonSlot(battle, unit, skill, {}, opts);
    const tt = targetType(skill);
    if (tt === TT.SELF) return true;
    const dist = skillDistance(unit, skill, opts);
    if (tt === TT.ENEMY_GRID || tt === TT.OUR_GRID) {
      const side = tt === TT.ENEMY_GRID ? enemySideOf(unit) : ownSideOf(unit);
      for (let s = 0; s < 9; s++) if (getTargetList(battle, unit, skill, { gridPos: s }, null, opts).units.length > 0 && isDistance(unit, skill, null, { team: side, slot: s }, opts)) return true;
      return false;
    }
    const c = tt === TT.OUR ? ourCandidates(battle, unit, dist, tt) : enemyCandidates(battle, unit, dist);
    return !!c && c.length > 0;
  }
  function inRange(battle, unit, skill, target, opts) {
    if (!skill) return false;
    const tt = targetType(skill);
    const sel = normSel(target);
    if (tt === TT.SELF) return !sel.target || sel.target === unit;
    if (tt === TT.ENEMY_GRID || tt === TT.OUR_GRID) {
      const side = tt === TT.ENEMY_GRID ? enemySideOf(unit) : ownSideOf(unit);
      if (sel.gridPos === undefined) return false;
      return isDistance(unit, skill, null, { team: side, slot: sel.gridPos }, opts);
    }
    if (!sel.target || !alive(sel.target)) return false;
    const dist = skillDistance(unit, skill, opts);
    if (tt === TT.OUR) return (ourCandidates(battle, unit, dist, tt) || []).includes(sel.target);
    return isDistance(unit, skill, sel.target, null, opts);
  }
  function targets(battle, unit, skill, mainTarget, opts) {
    opts = opts || {};
    const sel = normSel(mainTarget);
    const tt = targetType(skill);
    if (tt === TT.SELF && !sel.target) sel.target = unit;
    const grid = gridOf(skill);
    if ((tt === TT.ENEMY_GRID || tt === TT.OUR_GRID) && grid && num(grid, 'UsePoint') === 0) sel.gridPos = num(grid, 'StandardPoint');
    const standard = sel.target;
    const r = getTargetList(battle, unit, skill, sel, sel.target, opts);
    const gd = gridData(grid);
    return r.units.map((u) => ({ unit: u, gridRate: damageRateByGridPos(battle, unit, grid, gd, sel.gridPos, u, standard, tt, null) }));
  }

  // =====================================================================================
  // extra actions: counter (BattleManager.cs:4857-4976, OnCounter 5371) / chain attack (4982-4999, SetChainAttack 5245)
  // =====================================================================================
  function onCounter(battle, attacker, cand) {
    const s1 = skillBySlot(cand, 1);
    if (!s1) return null;
    if (attacker.type !== cand.type) {
      if (isDistance(cand, s1, attacker, null, {})) return { type: 'counter', unit: cand, skill: s1, target: attacker, counterBuff: null };
      log(battle, 'counter_fail', { unit: uref(cand), why: 'range' }); // Localization 1333
    }
    return null;
  }
  function pickCounterBuff(c, buffs) { // 4894-4910: first buff with the highest GetValueLevelPer
    for (const b of buffs) if (!c.counterBuff || bLevelValue(b) > bLevelValue(c.counterBuff)) c.counterBuff = b;
  }
  function extraActions(battle, actor, res, opts) {
    opts = opts || {};
    const out = [];
    if (opts.isCounter || opts.isAssist || !res || !res.skillKey) return out;
    let counter = null;
    const main = res.mainTarget;
    if (main && alive(main) && !(main.flags && main.flags.counterRemoved)) {
      const cb = buffList(main, BT.STAGE_REFLECTPHYSICS_RATIO_DEFENDER);
      if (cb.length) {
        if (hasBuff(main, BT.STAGE_SEAL_SKILL)) log(battle, 'counter_fail', { unit: uref(main), why: 'seal' });
        else if (hasBuff(main, BT.STAGE_AP_STOP)) log(battle, 'counter_fail', { unit: uref(main), why: 'ap_stop' });
        else { counter = onCounter(battle, actor, main); if (counter) pickCounterBuff(counter, cb); }
      }
    }
    if (!counter && res.otherTargets && res.otherTargets.length) {
      const map = new Map();
      let find = res.otherTargets.filter((c) => {
        if (!c || !alive(c) || (c.flags && c.flags.counterRemoved)) return false;
        const b = buffList(c, BT.STAGE_REFLECTPHYSICS_RATIO_DEFENDER);
        if (b.length) { map.set(c, b); return true; }
        return false;
      });
      find = stableSortDesc(find, (c) => getAtk(c));
      for (const c of find) {
        if (counter) break;
        if (hasBuff(c, BT.STAGE_SEAL_SKILL)) { log(battle, 'counter_fail', { unit: uref(c), why: 'seal' }); continue; }
        if (hasBuff(c, BT.STAGE_AP_STOP)) { log(battle, 'counter_fail', { unit: uref(c), why: 'ap_stop' }); continue; }
        counter = onCounter(battle, actor, c);
        if (!counter) {
          // BattleManager.cs:4954 (r15568): `if (counter != null)` guard added -- before r15568 this path threw
          // NullReferenceException (counter.CounterBuff on null). Now the candidate is simply skipped.
          log(battle, 'counter_fail', { unit: uref(c), why: 'no_counter' });
          continue;
        }
        pickCounterBuff(counter, map.get(c));
      }
    }
    if (counter) { out.push(counter); return out; }
    if (opts.isDoubleAction) return out;
    // chain attack (cooperative attack)
    const cbs = buffList(actor, BT.CHAIN_ATTACK_SKILL_1).concat(buffList(actor, BT.CHAIN_ATTACK_SKILL_2));
    if (!cbs.length) return out;
    const sorted = stableSortDesc(cbs, (b) => (bFrom(b) ? getAtk(bFrom(b)) : -Number.MAX_VALUE));
    for (const b of sorted) {
      const from = bFrom(b);
      if (!from) return out;
      const slot = bType(b) === BT.CHAIN_ATTACK_SKILL_1 ? 1 : 2;
      if (hasBuff(from, BT.STAGE_SEAL_SKILL)) { log(battle, 'chain_fail', { unit: uref(from), why: 'seal' }); continue; }
      if (hasBuff(from, BT.STAGE_AP_STOP)) { log(battle, 'chain_fail', { unit: uref(from), why: 'ap_stop' }); continue; }
      const sk = skillBySlot(from, slot);
      if (!sk) continue;
      let target = res.mainTarget && alive(res.mainTarget) ? res.mainTarget : null;
      if (!target && res.otherTargets && res.otherTargets.length) {
        const inD = res.otherTargets.filter((c) => c && alive(c) && isDistance(from, sk, c, null, {}));
        if (!inD.length) { log(battle, 'chain_fail', { unit: uref(from), why: 'range' }); return out; }
        target = inD[rndInt(battle, inD.length)];
      }
      if (target && target.type !== from.type) {
        if (isDistance(from, sk, target, null, {})) {
          const grid = gridOf(sk);
          const gridPos = grid && num(grid, 'UsePoint') === 0 ? num(grid, 'StandardPoint') : target.gridPos;
          out.push({ type: 'assist', unit: from, skill: sk, target, gridPos, from: actor, fromSkillKey: res.skillKey, buff: b });
          return out;
        }
        log(battle, 'chain_fail', { unit: uref(from), why: 'range' });
      }
    }
    return out;
  }

  // =====================================================================================
  // wait / move (Creature.DoTurnAction 2024-2066)
  // =====================================================================================
  function wait(battle, unit, res) {
    trig(battle, TR.WAIT, { owner: unit, skill: null, attacker: unit });
    log(battle, 'wait', { src: uref(unit) });
    if (res) res.waited = true;
    return res || { actor: unit, waited: true };
  }
  function move(battle, unit, gridPos) {
    const occupied = battle.units.some((x) => alive(x) && x !== unit && x.team === unit.team && x.type === unit.type && x.gridPos === gridPos);
    if (hasBuff(unit, BT.STAGE_SNARE) || occupied) return wait(battle, unit, { actor: unit });
    const from = unit.gridPos;
    unit.gridPos = gridPos; unit.oriGridPos = gridPos;
    trig(battle, TR.MOVE, { owner: unit, skill: null, attacker: unit });
    log(battle, 'move', { src: uref(unit), from, to: gridPos });
    return { actor: unit, moved: true, from, to: gridPos };
  }

  // =====================================================================================
  // knockback / pull (Creature.cs:7397-7453, StageMapData 1326-1928, moveValue forced to 1)
  // =====================================================================================
  const PULL_PC = { 0: 1, 1: 2, 3: 4, 4: 5, 6: 7, 7: 8 }, PULL_MOB = { 1: 0, 2: 1, 4: 3, 5: 4, 7: 6, 8: 7 };
  const PUSH_PC = { 1: 0, 2: 1, 4: 3, 5: 4, 7: 6, 8: 7 }, PUSH_MOB = { 0: 1, 1: 2, 3: 4, 4: 5, 6: 7, 7: 8 };
  function applyMoves(battle, a, targetsHit) {
    const pending = new Map();
    const posOf = (u) => (pending.has(u) ? pending.get(u) : u.gridPos);
    const occupied = (u, slot) => battle.units.some((x) => alive(x) && x !== u && x.team === u.team && posOf(x) === slot);
    for (let pass = 0; pass < 2; pass++) {
      for (const t of targetsHit) {
        if (!alive(t)) continue;
        if (num(t.table, 'ActorClassType') === E.ACTOR_CLASS.ARMORED && num(t.table, 'RoleType') === E.ROLE_TYPE.TANKER) continue; // immune
        if (t.type === 'MONSTER' && num(t.table, 'MonsterType') === E.MONSTER_TYPE.FIXED) continue;
        if (t.type === 'SUMMON' && !isAutopilot(t)) continue;
        const pcLike = t.type !== 'MONSTER';
        const front = firstBuff(t, BT.STAGE_MOVE_FRONT), back = firstBuff(t, BT.STAGE_MOVE_BACK);
        if (front) {
          if (bAttr(front) > 0) {
            const dst = (pcLike ? PULL_PC : PULL_MOB)[posOf(t)];
            if (dst !== undefined && !occupied(t, dst)) { pending.set(t, dst); bSetAttr(front, bAttr(front) - 1); }
          }
        } else if (back) {
          if (bAttr(back) > 0) {
            const dst = (pcLike ? PUSH_PC : PUSH_MOB)[posOf(t)];
            if (dst !== undefined && !occupied(t, dst)) { pending.set(t, dst); bSetAttr(back, bAttr(back) - 1); }
          }
        }
      }
    }
    const moves = [];
    for (const [u, p] of pending) {
      if (p === u.gridPos) continue;
      moves.push({ unit: u, from: u.gridPos, to: p });
      u.gridPos = p; u.oriGridPos = p;
      log(battle, 'pushpull', { dst: uref(u), from: moves[moves.length - 1].from, to: p, by: uref(a) });
    }
    return moves;
  }

  // =====================================================================================
  // execute: DoTurnAction (skill branch) + IsDoAttackTarget + DoApplyBuff/DoAttackTarget + DoDamage + LateDamage
  // opts: {isCounter, isAssist, isReserve, isDoubleAction, counterBuff, assistFrom, assistFromSkillKey, reserve, gridPos}
  // =====================================================================================
  function execute(battle, unit, skill, mainTarget, opts) {
    opts = opts || {};
    const res = {
      actor: unit, skillKey: skill ? skill.key : '', ok: false, waited: false,
      hits: [], kills: [], summons: [], extraActions: [], reserves: [], moves: [],
      mainTarget: null, otherTargets: [], targets: [],
    };
    if (!alive(unit)) { res.skipped = 'dead'; return res; } // 1818
    if (!skill || !lt(skill) || !st(skill)) { res.skipped = 'no_skill'; return wait(battle, unit, res); }
    const isOwnerTurn = !opts.isReserve && !opts.isDoubleAction && !opts.isAssist && !opts.isCounter; // 1810
    if (isOwnerTurn && !opts._skipCooldownCheck && skill.cooldownLeft > 0) { res.skipped = 'cooldown'; return wait(battle, unit, res); } // 1844-1856
    unit.flags = unit.flags || {};
    unit.flags.lastSkillKey = skill.key;

    const l = lt(skill), tbl = st(skill);
    const tt = targetType(skill);
    const isSummon = num(l, 'IsSummonSkill') === 1;
    const sel = normSel(mainTarget);
    if (opts.gridPos !== undefined) sel.gridPos = opts.gridPos;
    if (tt === TT.SELF) sel.target = unit;
    const grid = gridOf(skill), gd = gridData(grid);

    // ---- target resolution phase A (DoTurnAction 1991-2011) ----
    const swapToOtherSlot = () => { // 1995-2009: no target -> other active slot (AP kept), cooldown of that slot NOT re-checked
      const alt = skillBySlot(unit, slotOf(skill) === 1 ? 2 : 1);
      if (!alt || alt === skill || opts._swapped) return null;
      const altOpts = Object.assign({}, opts, { _swapped: true, _skipCooldownCheck: true });
      const s2 = {};
      if (isSummonOf(alt) ? pickSummonSlot(battle, unit, alt, s2, altOpts) : targetAI(battle, unit, alt, s2, altOpts))
        return execute(battle, unit, alt, { target: s2.target, gridPos: s2.gridPos }, altOpts);
      return null;
    };
    if (isSummon) {
      if (!pickSummonSlot(battle, unit, skill, sel, opts)) {
        const sw = swapToOtherSlot(); if (sw) return sw;
        res.skipped = 'no_target'; return wait(battle, unit, res);
      }
    } else {
      const r = getTargetList(battle, unit, skill, sel, null, opts);
      if (!r.ok && !targetAI(battle, unit, skill, sel, opts)) {
        const sw = swapToOtherSlot(); if (sw) return sw;
        res.skipped = 'no_target'; return wait(battle, unit, res);
      }
    }
    if (hasBuff(unit, BT.STAGE_SEAL_SKILL) && !opts.isReserve) { res.skipped = 'seal'; return wait(battle, unit, res); } // 2014

    // ---- phase B (IsDoAttackTarget 6015-6064) ----
    let targetList = [];
    if (!isSummon) {
      if ((tt === TT.ENEMY_GRID || tt === TT.OUR_GRID) && grid && num(grid, 'UsePoint') === 0 && (sel.gridPos === undefined || sel.gridPos === 255)) sel.gridPos = num(grid, 'StandardPoint');
      const targetActor = sel.target && alive(sel.target) ? sel.target : null; // 2113
      let r = getTargetList(battle, unit, skill, sel, targetActor, opts);
      if (!r.ok && tt !== TT.SELF) {
        const dist = skillDistance(unit, skillBySlot(unit, slotOf(skill)) || skill, opts); // GetSkillDistance(this, Table_Skill) -> slot skill
        const lf = tt === TT.OUR || tt === TT.OUR_GRID ? ourCandidates(battle, unit, dist, tt) || [] : enemyCandidates(battle, unit, dist);
        if (lf.length > 0) {
          const pick = lf[rndInt(battle, lf.length)];
          if (tt === TT.OUR || tt === TT.ENEMY) sel.target = pick; else sel.gridPos = pick.gridPos;
        }
        r = getTargetList(battle, unit, skill, sel, targetActor, opts);
        if (!r.ok) {
          // 6060: the action silently becomes a wait, but DoTurnAction still starts the cooldown (2204)
          if (isOwnerTurn) startCooldown(skill, battle);
          res.skipped = 'no_target_late';
          log(battle, 'wait', { src: uref(unit), why: 'no_target_late', skill: skill.key });
          res.waited = true;
          return res;
        }
      }
      targetList = r.units;
    }
    if (isOwnerTurn) startCooldown(skill, battle); // 2204
    res.ok = true;
    unit.stats.actions++;
    unit.stats.skillUse[skill.key] = (unit.stats.skillUse[skill.key] || 0) + 1;
    log(battle, 'skill', { src: uref(unit), skill: skill.key, target: uref(sel.target), gridPos: sel.gridPos, counter: !!opts.isCounter, assist: !!opts.isAssist, reserve: !!opts.isReserve, double: !!opts.isDoubleAction });

    // ---- summon (2280-2321) ----
    if (isSummon) {
      if (!spawnSummon(battle, unit, skill, sel.gridPos, res)) { res.ok = false; res.skipped = 'summon_fail'; return wait(battle, unit, res); }
      return res; // Is_Massive_Summon == 0 -> no attack packet, no DoApplyBuff
    }

    // ---- protect / guard (IsDoAttackTarget 6069-6365) ----
    const ati = { targets: [], ss: [], gridList: [] };
    if (tt === TT.ENEMY_GRID || tt === TT.OUR_GRID) ati.gridList.push(sel.gridPos);
    applyProtection(battle, unit, skill, targetList, ati, opts);
    // LastMainTargetActorID / _LastTargetCreature (2183-2194)
    res.mainTarget = ati.targets.length > 0 && tt !== TT.ENEMY_GRID ? ati.targets[0] : null;
    res.otherTargets = ati.targets.filter((x) => x !== res.mainTarget);
    unit.flags.lastMainTarget = res.mainTarget; unit.flags.lastTargets = res.otherTargets;
    res.targets = ati.targets.slice();
    res.protections = ati.ss.map((p) => ({ original: p.target, protector: p.block, eff: p.eff }));

    // BattleState_Round*Turn: CenterTargetGrid = TargetGridPos when the action has a target grid, else -1 (buffs *_GRID)
    unit.flags.centerTargetGrid = ati.gridList.length > 0 && sel.gridPos !== undefined ? sel.gridPos : -1;
    // ---- DoApplyBuff -> DoAttackTarget (6520) ----
    doAttackTarget(battle, unit, skill, sel, ati, grid, gd, opts, res);

    // DoApplyBuff 6699-6720
    if (B().afterSkill) B().afterSkill(battle, unit, skill, ati.targets, { isCounter: !!opts.isCounter, isAssist: !!opts.isAssist });
    else if (!opts.isCounter && !opts.isAssist) {
      trig(battle, TR.USE_SKILL, { owner: unit, skill, attacker: unit, targets: ati.targets });
      const s1 = skillBySlot(unit, 1), s2 = skillBySlot(unit, 2);
      if (s1 && s1.key === skill.key) trig(battle, TR.USE_ACTIVE_SKILL_1, { owner: unit, skill: null, attacker: unit, targets: ati.targets });
      else if (s2 && s2.key === skill.key) trig(battle, TR.USE_ACTIVE_SKILL_2, { owner: unit, skill: null, attacker: unit, targets: ati.targets });
    }
    recalc(battle, [unit].concat(ati.targets));

    // ---- DoDamage (hit-time) per target, then die animation, then LateDamage kill triggers ----
    if (!res.delayed) {
      for (const h of res.hits) {
        const t = h.target;
        if (h.miss) continue;
        if (!(h.damage !== 0 || h.shield || h.immune)) continue;
        if (t.hp <= 0) processDeath(battle, t, unit, res);
        hitTriggers(battle, t, unit, skill, opts); // live victims only
        allyHitTriggers(battle, t, unit, skill, opts);
      }
      const dead = [];
      for (const t of ati.targets) if (t.hp <= 0 && !dead.includes(t)) { processDeath(battle, t, unit, res); if (t.hp <= 0) dead.push(t); }
      for (const t of dead) {
        res.kills.push(t);
        if (t.team !== unit.team) unit.stats.kills++;
        log(battle, 'kill', { src: uref(unit), dst: uref(t), skill: skill.key });
      }
      // CreatureState_SkillAttack.LateDamage 1196-1268 (one trigger set per dead target)
      const first = ati.ss.length ? 'block' : opts.isCounter ? 'counter' : opts.isAssist ? 'assist' : opts.isDoubleAction ? 'double' : opts.isReserve ? 'reserve' : 'normal';
      for (const t of ati.targets) {
        if (alive(t)) continue;
        if (first === 'normal' || first === 'block' || first === 'double') killTriggers(battle, unit, skill, ati.targets, 'normal');
        else if (first === 'counter') killTriggers(battle, unit, null, ati.targets, 'counter');
        else if (first === 'assist') { const f = opts.assistFrom; if (f) killTriggers(battle, f, findSkill(f, opts.assistFromSkillKey), ati.targets, 'normal'); }
        else if (first === 'reserve') { const as = opts.reserve && opts.reserve.assist; if (as && as.from) killTriggers(battle, as.from, findSkill(as.from, as.fromSkillKey), ati.targets, 'normal'); }
      }
    }

    // ---- next derived action (counter / chain attack) ----
    res.extraActions = extraActions(battle, unit, res, opts);
    return res;
  }
  const isSummonOf = (s) => num(lt(s), 'IsSummonSkill') === 1;

  function doAttackTarget(battle, a, skill, sel, ati, grid, gd, opts, res) {
    const l = lt(skill), tbl = st(skill), tt = targetType(skill);
    const isCounter = !!opts.isCounter, isAssist = !!opts.isAssist;
    // main grid target first (6534-6546)
    const mainGrid = ati.gridList.length > 0 ? ati.gridList[0] : -1;
    const tl = [];
    for (const t of ati.targets) { if (mainGrid !== -1 && t.gridPos === mainGrid) tl.unshift(t); else tl.push(t); }

    // delay skill (6556-6601): reserve and stop
    const dType = num(tbl, 'DelaySkillType');
    if (num(tbl, 'IsDelaySkill') > 0 && (dType === 0 || dType === 2)) {
      let targetUnit = null, targetPos = 255;
      if (sel.target) {
        if (alive(sel.target)) { if (tt === TT.ENEMY || tt === TT.OUR) targetUnit = sel.target; else targetPos = sel.gridPos; }
        else targetPos = sel.gridPos;
      } else targetPos = sel.gridPos;
      const count = Math.max(0, num(tbl, 'DelaySkillRound'));
      const reserve = {
        type: dType, owner: a, ownerAid: a.aid, skillKey: str(tbl, 'DelaySkillKeyString'), parentSkillKey: skill.key,
        skillLevel: skill.level, targetRound: (battle.round || 0) + num(tbl, 'DelaySkillRound'),
        targetGridPos: targetPos === undefined ? 255 : targetPos, targetUnit, distance: skillDistance(a, skill, opts),
        assist: isAssist ? { from: opts.assistFrom, fromSkillKey: opts.assistFromSkillKey } : null,
        // ReserveSkillInfo.InitializeActionPoint (Common.cs:155)
        delayChargeCount: count, recoverySpeed: count > 0 ? getTurnSpeed(a) / count : 0,
        actionPoint: 0, previousActionPoint: 0, isTurnEndReady: false,
      };
      (battle.reserveSkills = battle.reserveSkills || []).push(reserve);
      res.reserves.push(reserve);
      res.delayed = true;
      log(battle, 'reserve', { src: uref(a), skill: skill.key, delaySkill: reserve.skillKey, charge: count, target: uref(targetUnit), gridPos: reserve.targetGridPos });
      return;
    }

    const rate = skillAttackRate(a, skill); // 6603
    const tctx = (extra) => Object.assign({ owner: a, skill, attacker: a, targets: tl, gridPos: sel.gridPos, isCounter, isAssist, isReserve: !!opts.isReserve, action: res }, extra);
    if (num(l, 'IsSummonSkill') === 1) trig(battle, TR.SUMMON_CREATE, tctx());
    if (rate > 0 && !isCounter && !isAssist) trig(battle, TR.ON_ATTACK, tctx()); // 6614

    // ---- hit / evade (6622-6754) ----
    const suc = [];
    for (const t of tl) {
      if (t.flags) t.flags.counterRemoved = false;
      suc.push(t);
      if (a === t || a.type === t.type) continue;
      trig(battle, TR.ATTACKED, { owner: t, skill: null, attacker: a, triggerValue: String(a.hp) });
      if (!isCounter && !isAssist) trig(battle, TR.ATTACKED_ACTIVESKILL, { owner: t, skill: null, attacker: a, triggerValue: String(a.hp) });
      // [final hit] = attacker APPLY(rate) + skill Accuracy - target EVADE(rate)   (6651-6654)
      const apply = attr(a, VT.RATE, AT.APPLY) + f32(num(l, 'Accuracy'));
      const total = apply - attr(t, VT.RATE, AT.EVADE);
      const r = rnd(battle);
      if (t.type !== 'SUMMON' && (r >= total || total < 0)) { // 6696
        if (tt !== TT.OUR) {
          if (num(tbl, 'IsDelaySkill') === 0) {
            suc.splice(suc.indexOf(t), 1);
            res.hits.push({ target: t, damage: 0, crit: false, miss: true, hitRate: total });
            log(battle, 'miss', { src: uref(a), dst: uref(t), skill: skill.key, hitRate: +total.toFixed(4) });
            trig(battle, TR.USE_SKILL_ENEMY, { owner: t, skill, attacker: a, targets: tl });
            trig(battle, TR.ON_EVADE, { owner: t, skill: null, attacker: a, targets: tl });
            trig(battle, TR.ATTACK_FAIL, tctx());
            trig(battle, TR.ATTACK_FAIL_PASSIVE, tctx({ skill: null }));
            if (!isCounter && !isAssist) trig(battle, TR.ON_EVADE_ACTIVESKILL, { owner: t, skill: null, attacker: a, targets: tl });
          }
          continue;
        }
      }
    }
    if (suc.length > 0 && !isAssist) { // 6756
      trig(battle, TR.ATTACK_SUCCESS, tctx({ targets: suc }));
      trig(battle, TR.ATTACK_SUCCESS_PASSIVE, tctx({ skill: null, targets: suc }));
      trig(battle, TR.ATTACK_SUCCESS_AND_IF_BUFFED, tctx({ targets: suc }));
    }
    if (suc.length > 0 && !isAssist && !isCounter) { // 6766
      trig(battle, TR.ATTACK_SUCCESS_ACTIVESKILL, tctx({ targets: suc }));
      for (const u of battle.units) if (alive(u) && u.type === a.type && u !== a) trig(battle, TR.ATTACK_SUCCESS_SKILL_ALLY, { owner: u, skill: null, attacker: u, targets: [] });
    }
    recalc(battle, [a].concat(tl)); // skill debuffs applied above affect this hit (ApplyBuff -> UpdateAll)

    // protector jump-swap (BattleState_Round*Turn.SkillAttack + CreatureState_JumpMove.ChangeLineSpot)
    const ov = new Map();
    for (const p of ati.ss) {
      if (p.block === p.target || p.eff === BT.STAGE_BLOCK_LINE || p.block.type === a.type) continue;
      const pb = ov.has(p.block) ? ov.get(p.block) : p.block.gridPos, pt = ov.has(p.target) ? ov.get(p.target) : p.target.gridPos;
      ov.set(p.block, pt); ov.set(p.target, pb);
    }

    // ---- crit + damage (6781-7380) ----
    const standard = sel.target || null; // DoAttackTarget `target` = GetCreature(skillInfo.TargetAid)
    const maxCount = gd.length; // gridData.Select(p => p.persent != 0).Count == gridData.Count (client quirk)
    const curCount = tl.length;
    const adTypes = adaptiveTypes(skill);
    const magic = num(l, 'MagicSkillAttrType');
    for (const t of suc) {
      if (a === t || a.type === t.type) continue;
      const hit = { target: t, damage: 0, crit: false, miss: false, protectedBy: null, original: t };
      const ssb = ati.ss.find((p) => p.block === t && p.block !== p.target);
      if (ssb) { hit.protectedBy = t; hit.original = ssb.target; hit.protectEff = ssb.eff; }
      // critical (6791-6819)
      let isCri = false;
      if (hasBuff(a, BT.STAGE_CRITICAL_NEXTATTACK)) { removeBuffType(battle, a, BT.STAGE_CRITICAL_NEXTATTACK); isCri = true; }
      else {
        let cri = attr(a, VT.RATE, AT.CRI);
        if (hasBuff(t, BT.DEF_CRTDOWN)) { // 6804
          cri = cri - attr(t, VT.ABS, AT.DEF) * bval(t, BT.DEF_CRTDOWN);
          if (cri < 0) cri = 0;
        }
        if (rnd(battle) <= cri) isCri = true;
      }
      hit.crit = isCri;
      if (isCri && !isAssist) trig(battle, TR.ON_CRITICAL_HIT, tctx({ target: t }));

      const imm = rate > 0 ? firstBuff(t, BT.STAGE_IMMUNESHIELD_TIME) : null; // 6836
      if (imm) {
        bSetAttr(imm, bAttr(imm) - 1);
        if (bAttr(imm) <= 0) removeBuffObj(battle, t, imm);
        hit.immune = true;
        log(battle, 'immune', { src: uref(a), dst: uref(t), skill: skill.key });
      } else {
        // [skill rate] = SkillAttackRate + attr SKILL_ATTACK_RATE(rate) + STAT_SKILL_RATIO   (6868)
        let addRate = attr(a, VT.RATE, AT.SKILL_ATTACK_RATE) + bval(a, BT.STAT_SKILL_RATIO);
        if (hasBuff(a, BT.EVADE_SKILLDMGUP_ME)) { // 6872
          let e = attr(a, VT.RATE, AT.EVADE); if (e < 0) e = 0;
          addRate += e * bval(a, BT.EVADE_SKILLDMGUP_ME);
        }
        if (hasBuff(t, BT.EVADE_SKILLDMGDOWN)) addRate -= attr(t, VT.RATE, AT.EVADE) * bval(t, BT.EVADE_SKILLDMGDOWN); // 6883
        if (hasBuff(a, BT.DEF_SKILLDMGUP_ME)) { // 6890
          let d = attr(a, VT.ABS, AT.DEF); if (d < 0) d = 0;
          addRate += d * bval(a, BT.DEF_SKILLDMGUP_ME);
        }
        if (hasBuff(t, BT.WIDE_SKILL_RATIO) && maxCount > 1 && curCount > 0) addRate += (curCount - 1) * bval(t, BT.WIDE_SKILL_RATIO); // 6899
        const atk = attr(a, VT.ABS, AT.ATK); // 6913
        let skillRate = rate + addRate; if (skillRate < 0) skillRate = 0;
        let dmg = skillRate * atk; // 6918 [skill damage]
        if (isCounter) { // 6920
          if (opts.counterBuff) dmg = dmg * bLevelValue(opts.counterBuff);
          else log(battle, 'counter_no_buff', { src: uref(a) });
        }
        let def = attr(t, VT.ABS, AT.DEF); // 6933
        let resist = 1;
        if (adTypes.length > 1) { // 6968 adaptive element: lowest resist
          let low = 1;
          for (const m of adTypes) low = Math.min(low, getResist(t, AT.NONE_RESIST + m));
          resist = 1 - low;
        } else if (magic !== SA.NONE) { // 6980
          if (magic === SA.FIRE) resist = 1 - getResist(t, AT.FIRE_RESIST);
          else if (magic === SA.ICE) resist = 1 - getResist(t, AT.ICE_RESIST);
          else if (magic === SA.LIGHTNING) resist = 1 - getResist(t, AT.LIGHTNING_RESIST);
        }
        const cls = num(t.table, 'ActorClassType'); // 6995 class bonus
        if (cls === E.ACTOR_CLASS.TROOPER) dmg = dmg + dmg * bval(a, BT.STAGE_TROOPERTYPEDMGBONUS_RATIO);
        else if (cls === E.ACTOR_CLASS.ARMORED) dmg = dmg + dmg * bval(a, BT.STAGE_ARMOREDTYPEDMGBONUS_RATIO);
        else if (cls === E.ACTOR_CLASS.MOBILITY) dmg = dmg + dmg * bval(a, BT.STAGE_MOBILITYTYPEDMGBONUS_RATIO);
        if (isCri) dmg = dmg * 1.5; // 7013
        if (hasBuff(a, BT.STAGE_DEFPIERCE_VALUE)) { def = def - bval(a, BT.STAGE_DEFPIERCE_VALUE); if (def < 0) def = 0; } // 7017
        if (hasBuff(a, BT.STAGE_DEFPIERCE_RATIO)) { // 7027
          if (def < 0) def = 0;
          else {
            let pr = f32(bval(a, BT.STAGE_DEFPIERCE_RATIO) - f32(hpRate(t) * bval(t, BT.CURRENT_HP_PIERCEDOWN)));
            if (pr < 0) pr = 0;
            def = def * (1 - pr); if (def < 0) def = 0;
          }
        }
        if (a !== t && a.type !== t.type && !hasBuff(a, BT.BARRIER_PIERCE)) { // 7049 damage reduction %
          let sr = bval(t, BT.STAGE_SHIELD_RATIO);
          if (1 < sr) sr = 1;
          const mx = f32(gv('MAX_STAGE_SHIELD_RATIO', 0));
          sr = sr < mx ? sr : mx;
          dmg = dmg * f32(1 - sr);
        }
        if (hasBuff(a, BT.DEF_DMG_ADD)) { let d = attr(a, VT.ABS, AT.DEF); if (d < 0) d = 0; dmg += d * bval(a, BT.DEF_DMG_ADD); } // 7066
        let total = magic === SA.NONE ? (dmg - def) * resist : dmg * resist; // 7078
        // grid rate (7088-7107)
        let rateUnit = t;
        if (ati.ss.length > 0) {
          const sp = ati.ss.find((p) => p.block === t);
          if (sp && sp.eff === BT.STAGE_BLOCK_LINE && !sp.isOriginalAttacked) rateUnit = sp.target;
        }
        const gRate = damageRateByGridPos(battle, a, grid, gd, ati.gridList.length ? ati.gridList[0] : -1, rateUnit, standard, tt, rateUnit === t ? ov : null);
        total = total * gRate;
        hit.gridRate = gRate;
        // extra % damage (7110-7131)
        total = total + atk * battrSum(t, BT.STAGE_DAMAGEPHYSICS_RATIO);
        total = total + atk * battrSum(t, BT.STAGE_DAMAGEFIRE_RATIO) * (1 - getResist(t, AT.FIRE_RESIST));
        total = total + atk * battrSum(t, BT.STAGE_DAMAGEICE_RATIO) * (1 - getResist(t, AT.ICE_RESIST));
        total = total + atk * battrSum(t, BT.STAGE_DAMAGELIGHTNING_RATIO) * (1 - getResist(t, AT.LIGHTNING_RESIST));
        total = total + total * bval(t, BT.STAGE_DAMAGEPHYSICS_RATIO_INS);
        total = total + total * bval(t, BT.STAGE_DAMAGEFIRE_RATIO_INS) * (1 - getResist(t, AT.FIRE_RESIST));
        total = total + total * battrSum(t, BT.STAGE_DAMAGEICE_RATIO_INS) * (1 - getResist(t, AT.ICE_RESIST)); // client uses GetAttrValue here
        total = total + total * battrSum(t, BT.STAGE_DAMAGELIGHTNING_RATIO_INS) * (1 - getResist(t, AT.LIGHTNING_RESIST));
        if (total <= 0) total = 1; // 7133
        const shieldList = buffList(t, BT.STAGE_SHIELD_VALUE); // 7139 full block if skill damage < shield value
        if (shieldList.length) {
          let sv = 0; for (const b of shieldList) sv = f32(sv + bAttr(b));
          if (dmg < sv) {
            total = 1; hit.shield = true;
            if (B().consumeShieldCount) B().consumeShieldCount(battle, t);
            else { const s0 = shieldList[0]; if (bEraseType(s0) === E.BUFFEFFECT_ERASE_TYPE.COUNT) { const left = (bLeft(s0) || 0) - 1; bSetLeft(s0, left); if (left <= 0) removeBuffObj(battle, t, s0); } }
          }
        }
        if (rate <= 0) total = 0; // 7178
        total = total + total * bval(t, BT.STAGE_ADDDAMAGE_RATIO); // 7184
        const sh = absorbShields(battle, t, total, a, res); // 7189-7255
        total = sh.total;
        if (sh.absorbed > 0) { hit.shield = true; hit.absorbed = sh.absorbed; }
        let v = f32(f32(1 - f32(f32(a.hp) / f32(maxHp(a)))) * bval(a, BT.STAGE_DAMAGEAMP_BYHP_ME)); // 7263
        total = total * (1 + v);
        v = f32(f32(1 - f32(f32(t.hp) / f32(maxHp(t)))) * bval(a, BT.STAGE_DAMAGEAMP_BYHP_OPP)); // 7271
        total = total * (1 + v);
        if (hasBuff(a, BT.FOCUSED_ATTACK) && maxCount > 1) { // 7276
          const fr = f32(f32((maxCount - curCount) / (maxCount - 1)) * bval(a, BT.FOCUSED_ATTACK));
          total = total + total * fr;
        }
        if (hasBuff(t, BT.WIDE_DAMAGE_RATIO) && maxCount > 1) total = total * (1 + bval(t, BT.WIDE_DAMAGE_RATIO)); // 7294
        if (hasBuff(t, BT.DAMAGE_DISPERSE) && maxCount > 1) { // 7310
          let dr = f32(f32((curCount - 1) / (maxCount - 1)) * bval(t, BT.DAMAGE_DISPERSE));
          if (dr > 1) dr = 1;
          total = total - total * dr;
        }
        if (total < 0) total = 1; // 7331
        if (total > 0) { // 7357
          total = Math.max(1, total);
          const d = Math.trunc(total);
          t.hp = t.hp - d;
          hit.damage = d;
          a.stats.dmgDealt += d;
          t.stats.dmgTaken += d;
        }
        log(battle, 'hit', { src: uref(a), dst: uref(t), skill: skill.key, dmg: hit.damage, crit: isCri, hp: t.hp, rate: gRate, prot: hit.protectedBy ? uref(hit.original) : undefined, shield: hit.shield || undefined });
      }
      res.hits.push(hit);
      trig(battle, TR.USE_SKILL_ENEMY, { owner: t, skill, attacker: a, targets: tl }); // 7379
    }

    // knockback / pull after grid damage (7397-7453)
    const hitTargets = suc.filter((t) => t !== a && t.type !== a.type);
    res.moves = applyMoves(battle, a, hitTargets);

    // stack consumption (7462)
    if (str(l, 'Use_BuffStack')) removeBuffStack(battle, a, str(l, 'Use_BuffStack'), num(l, 'Stack_Consume'));
    for (const t of tl) if (a.type !== t.type) trig(battle, TR.AFTER_ATTACKED, { owner: t, skill: null, attacker: a, triggerValue: String(a.hp) }); // 7467
    if (isCounter) { // 7477
      eraseByTrigger(battle, a, TR.USE_SKILL_ENEMY);
      trig(battle, TR.AFTER_COUNTER, tctx());
    }
    if (isAssist && !isCounter) { // 7485
      const slot = slotOf(skill);
      if (slot === 1) trig(battle, TR.AFTER_CHAIN_ATTACK_SKILL_1_GIVER, tctx({ skill: null }));
      else if (slot === 2) trig(battle, TR.AFTER_CHAIN_ATTACK_SKILL_2_GIVER, tctx({ skill: null }));
      trig(battle, TR.AFTER_CHAIN_ATTACK_SKILL_ALL_GIVER, tctx({ skill: null }));
      const f = opts.assistFrom;
      if (f) {
        const rc = (ty) => trig(battle, ty, { owner: f, skill: null, attacker: a, targets: tl });
        if (slot === 1) rc(TR.AFTER_CHAIN_ATTACK_SKILL_1_RECEIVER);
        else if (slot === 2) rc(TR.AFTER_CHAIN_ATTACK_SKILL_2_RECEIVER);
        rc(TR.AFTER_CHAIN_ATTACK_SKILL_ALL_RECEIVER);
      }
    }
    // count-type attack passives consumed after damage (7513-7539)
    if (B().consumeAttackPassiveCounts) { B().consumeAttackPassiveCounts(battle, a); return; }
    for (const ty of [BT.STAT_ATK_RATIO, BT.STAT_CRITICAL_RATIO, BT.STAGE_DEFPIERCE_RATIO, BT.BARRIER_PIERCE]) {
      for (const b of buffList(a, ty).slice()) {
        if (bEraseType(b) === E.BUFFEFFECT_ERASE_TYPE.COUNT && bEraseTrigger(b) === TR.ATTACK_SUCCESS_PASSIVE) {
          const left = (bLeft(b) || 0) - 1;
          bSetLeft(b, left);
          if (left <= 0) removeBuffObj(battle, a, b);
        }
      }
    }
  }

  LOSim.combat = {
    canUse, inRange, targets, execute, applyDamage, heal,
    enemiesOf, alliesOf, unitAt: (battle, team, gridPos) => unitAt(battle, team, gridPos, null),
    tickCooldowns, resetCooldowns, startCooldown, extraActions, wait, move,
    // exposed internals (AI / UI / tests)
    skillDistance, isDistance: (a, skill, target, line, opts) => isDistance(a, skill, target, line, opts),
    enemyCandidates, ourCandidates, targetAI, getResist, damageRateByGridPos, gridData, skillBySlot, findSkill,
    cellOf, rowOf, onDeath, absorbShields,
  };
})();
