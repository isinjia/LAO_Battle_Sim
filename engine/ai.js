// LOSim.ai -- monster/summon Lua AI (CreatureAI.cs API run through fengari) + PC auto-battle AI.
// Port of:
//   Assets/_Scripts/CreatureBattle/CreatureAI.cs           (Process + the static API exposed to Lua)
//   Assets/Slua/LuaObject/Custom/Lua_CreatureAI.cs          (exported member list)
//   Assets/Slua/Plugins/Slua_Managed/LuaSvr.cs/LuaState.cs (start = doFile + run("Process"); doBuffer throws on load error)
//   Assets/_Scripts/Manager/BattleManager.cs  GetTargetCount / IsUseSkillPos_Preview / IsSetTarget /
//       GetTargetAI (both overloads) / SetTarget* / IsProvoke / IsStage_marking / *CellDist / *BuffDist
//   Assets/_Scripts/CreatureBattle/Character.cs AI()  + BattleManager.AutoCharacter / BattleStart (renewal)
// Renewal build only (BEFORE_BATTLE_RENEWAL undefined). ROUND_ATTACK_COUNT_MAX = 1.
//
// Selection objects (SkillSelectInfo) used in unit.reserveSkillList:
//   {aid, skillKey, targetAid, targetGridPos}   (targetGridPos 255 = "none", like SkillSelectInfo())
//
// Unit fields this module reads/writes (other modules may set the flags):
//   unit.reserveSkillList  [] queue        unit.lastSkillInfo  (Creature.LastskillInfo, battle.js sets)
//   unit.turnInfo {reserveRound, turnPos}  unit.flags.beAttacked (combat sets on damage != 0; reset per round)
//   unit.flags.attackerAid (combat sets, Creature.AttackerAID)    unit.flags.reserveDistance (battle.js, reserve attack)
//   unit.pcAiFirstSkill (1|2, PCInfo.AIInfo.FirstSkillSlotType; default 1)
(function () {
  const LOSim = (window.LOSim = window.LOSim || {});
  const E = LOSim.E;
  const C = LOSim.C;
  const AI = (LOSim.ai = LOSim.ai || {});

  const SKILL_SLOT_1 = 'skill_slot_1';
  const WAIT = () => C.SKILLKEY_WAIT || 'Wait';
  const MOVE = () => C.SKILLKEY_MOVE || 'Move';
  const ACTIVE_ROUND = () => C.ACTIVE_ROUND || 100;
  const ROUND_ATTACK_COUNT_MAX = 1; // GlobalDefines.cs:496 (renewal)
  const TT = E.TARGET_TYPE;
  const ATT = E.ATTACKTARGETTYPE;
  const BT = E.BUFFEFFECT_TYPE;

  // ------------------------------------------------------------------ unit helpers
  const isPC = (u) => u.type === 'CHARACTER';
  const isMob = (u) => u.type === 'MONSTER';
  const isSum = (u) => u.type === 'SUMMON';
  const alive = (u) => u && u.hp > 0 && !u.removed;
  AI.alive = alive;
  // BattleManager.ListCreature order (battle.js keeps battle.units sorted like coNextRound: CreatureType, LineSpot)
  const list = (battle) => battle.units.filter(alive);
  const getCreature = (battle, aid) => (aid ? battle.units.find((u) => u.aid === aid && alive(u)) || null : null);
  AI.getCreature = getCreature;
  // Creature.LineSpot setter: CHARACTER/SUMMON use (8-pos)%3, others pos%3  (0 = front column)
  const cell = (u) => (isPC(u) || isSum(u) ? (8 - u.gridPos) % 3 : Math.abs(u.gridPos) % 3);
  const row = (u) => Math.floor(u.gridPos / 3) + 1;
  AI.cell = cell; AI.row = row;
  const summonType = (u) => LOSim.num(u.table, 'SummonType');
  const summonGroupAlly = (u) => u.team === 1; // SUMMON_GROUP.ALLY_SUMMON
  const isAutopilot = (u) => isSum(u) && summonType(u) === E.SUMMON_TYPE.AUTOPILOT;
  const actorClass = (u) => LOSim.num(u.table, 'ActorClassType');
  const actorRole = (u) => LOSim.num(u.table, 'RoleType');
  const hpRate = (u) => (u.maxHp > 0 ? u.hp / u.maxHp : 0);
  const getAtk = (u) => {
    if (LOSim.stats && LOSim.stats.getAtk) return LOSim.stats.getAtk(u);
    return (u.attr && u.attr[E.VALUE_TYPE.ABS] && u.attr[E.VALUE_TYPE.ABS][E.ACTOR_ATTR_TYPE.ATK]) || 0;
  };
  const getAttr = (u, vt, at) => {
    if (LOSim.stats && LOSim.stats.getAttr) return LOSim.stats.getAttr(u, vt, at);
    return (u.attr && u.attr[vt] && u.attr[vt][at]) || 0;
  };
  const rngInt = (battle, n) => (n > 0 ? battle.rng.int(n) : 0);
  const pick = (battle, arr) => (arr.length ? arr[rngInt(battle, arr.length)] : null); // List.GetRandom()
  const shuffle = (battle, arr) => { // Common.Shuffle (Fisher-Yates)
    for (let i = arr.length - 1; i > 0; i--) { const j = rngInt(battle, i + 1); const t = arr[i]; arr[i] = arr[j]; arr[j] = t; }
    return arr;
  };
  // stable sorts like LINQ OrderBy
  const orderBy = (arr, f) => arr.map((x, i) => [x, i]).sort((a, b) => (f(a[0]) - f(b[0])) || (a[1] - b[1])).map((p) => p[0]);
  const orderByDesc = (arr, f) => arr.map((x, i) => [x, i]).sort((a, b) => (f(b[0]) - f(a[0])) || (a[1] - b[1])).map((p) => p[0]);

  // ------------------------------------------------------------------ buff helpers (buffs.js owns the shape)
  function has(u, typeName) {
    const t = BT[typeName];
    if (t === undefined) return null;
    if (LOSim.buffs && LOSim.buffs.has) return LOSim.buffs.has(u, t) || null;
    return (u.buffs || []).find((b) => b && (b.type === t || b.effectType === t)) || null;
  }
  function bvalue(u, typeName) {
    const t = BT[typeName];
    if (t === undefined || !LOSim.buffs || !LOSim.buffs.value) return 0;
    return LOSim.buffs.value(u, t) || 0;
  }
  const buffKeyOf = (b) => b && (b.key || b.effectKey || b.buffKey || (b.table && b.table.Key));
  // Creature.IsApplyBuff(buffKeyString) / IsApplyBuffCount
  function hasKey(u, key) {
    if (LOSim.buffs && LOSim.buffs.hasKey) return !!LOSim.buffs.hasKey(u, key);
    return (u.buffs || []).some((b) => buffKeyOf(b) === key);
  }
  function countKey(u, key) {
    if (LOSim.buffs && LOSim.buffs.countKey) return LOSim.buffs.countKey(u, key) | 0;
    return (u.buffs || []).filter((b) => buffKeyOf(b) === key).length;
  }
  function buffFrom(battle, b) {
    if (!b) return null;
    const f = b.from || b.src || b.fromUnit || null;
    if (f) return f;
    return b.fromAid ? battle.units.find((u) => u.aid === b.fromAid) || null : null;
  }

  // ------------------------------------------------------------------ skill helpers
  const skillSlot = (s) => (s.slot !== undefined && s.slot !== null ? s.slot : LOSim.num(s.table, 'SkillSlotType'));
  // Creature.GetSkillBySkillLevelSlot(slot) == CreatureSkill.GetSkill(slotType)
  function skillBySlot(u, slot) { return (u.skills || []).find((s) => skillSlot(s) === slot) || null; }
  function skillByKey(u, key) { return key ? (u.skills || []).find((s) => s.key === key) || null : null; }
  AI.skillBySlot = skillBySlot; AI.skillByKey = skillByKey;
  const slotOfUseType = (useSkillType) => (useSkillType === SKILL_SLOT_1 ? 1 : 2); // anything else -> slot 2 (as C#)
  const targetType = (s) => LOSim.num(s.table, 'TargetType');
  const needAP = (s) => LOSim.num(s.levelTable, 'NeedActionPoint');
  AI.needAP = needAP;
  const isSummonSkill = (s) => LOSim.num(s.levelTable, 'IsSummonSkill') === 1;
  function gridRow(s) { return LOSim.T('Table_Grid', LOSim.str(s.levelTable, 'GridIndex')); }

  // Skill.GetSkillDistance()
  function skillDistance(battle, u, s) {
    if (!s) return 0;
    if (u.flags && u.flags.reserveDistance !== undefined && u.flags.reserveDistance !== null) return u.flags.reserveDistance;
    if (LOSim.combat && LOSim.combat.skillDistance) return LOSim.combat.skillDistance(u, s, {}); // combat.js: (unit, skill, opts)
    if (!s.levelTable) return 0;
    let d = LOSim.num(s.levelTable, 'Distance');
    if (isPC(u)) d += u.coreRangeUp || (u.flags && u.flags.coreRangeUp) || 0;
    let bd = bvalue(u, 'STAT_RANGE_VALUE');
    const s1 = skillBySlot(u, 1), s2 = skillBySlot(u, 2);
    if (s1 && s1.key === s.key) bd += bvalue(u, 'STAT_RANGE_VALUE_ACTIVE_SKILL_1');
    if (s2 && s2.key === s.key) bd += bvalue(u, 'STAT_RANGE_VALUE_ACTIVE_SKILL_2');
    return Math.max(1, d + Math.trunc(bd));
  }
  AI.skillDistance = skillDistance;

  // ------------------------------------------------------------------ grid / target lists (BattleManager)
  const cellDist = (myCell, enemyCell) => myCell + enemyCell + 1; // GetCellDistance
  function monsterCellDist(battle, c, d) { // GetMonsterCellDist
    const L = list(battle);
    const out = L.filter((u) => isMob(u) && cellDist(c, cell(u)) <= d);
    for (const s of L) if (isSum(s) && !summonGroupAlly(s) && isAutopilot(s) && cellDist(c, cell(s)) <= d) out.push(s);
    return out;
  }
  function pcCellDist(battle, c, d) { // GetPcCellDist
    const L = list(battle);
    const out = L.filter((u) => isPC(u) && Math.abs(cell(u) + c + 1) <= d);
    for (const s of L) if (isSum(s) && summonGroupAlly(s) && isAutopilot(s) && Math.abs(cell(s) + c + 1) <= d) out.push(s);
    return out;
  }
  function pcBuffDist(battle, caster, d, tt) { // GetPcBuffDist
    if (tt === undefined) tt = TT.OUR;
    return list(battle).filter((u) => isPC(u) && Math.abs(cell(caster) - cell(u)) <= d && Math.abs(row(caster) - row(u)) <= d &&
      (tt === TT.OUR_GRID || u !== caster));
  }
  function monsterBuffDist(battle, caster, d) { // GetMonsterBuffDist
    return list(battle).filter((u) => isMob(u) && Math.abs(cell(caster) - cell(u)) <= d && Math.abs(row(caster) - row(u)) <= d && u !== caster);
  }
  function targetListBySkillDistance(battle, a, d) { // GetTargetListBySkillDistance
    if (isPC(a)) return monsterCellDist(battle, cell(a), d);
    if (isSum(a)) {
      if (isAutopilot(a)) return summonGroupAlly(a) ? monsterCellDist(battle, cell(a), d) : pcCellDist(battle, cell(a), d);
    }
    if (isMob(a)) return pcCellDist(battle, cell(a), d);
    return [];
  }
  function ourTargetListBySkillDistance(battle, a, d, tt) { // GetOurTargetListBySkillDistance
    if (isPC(a)) return pcBuffDist(battle, a, d, tt);
    if (isSum(a)) {
      if (isAutopilot(a)) return summonGroupAlly(a) ? pcBuffDist(battle, a, d) : monsterBuffDist(battle, a, d);
      return null;
    }
    return monsterBuffDist(battle, a, d);
  }
  AI.targetListBySkillDistance = targetListBySkillDistance;
  AI.ourTargetListBySkillDistance = ourTargetListBySkillDistance;

  // StageMapData occupancy. PC side holds CHARACTER + PC-side summons; monster side holds MONSTER + enemy summons.
  const onPcSide = (u) => isPC(u) || (isSum(u) && u.team === 1);
  function occupied(battle, pcSide, pos) { return list(battle).some((u) => onPcSide(u) === pcSide && u.gridPos === pos); }
  function emptyLine(battle, pcSide) { const r = []; for (let i = 0; i < 9; i++) if (!occupied(battle, pcSide, i)) r.push(i); return r; }
  // GetEmptyGridPosList(actorType): MONSTER -> monster line, everything else -> character line
  const emptyGridPosList = (battle, u) => emptyLine(battle, !isMob(u));
  AI.emptyGridPosList = emptyGridPosList;
  function actorByGridPosPC(battle, typeIsChar, pos) {
    return list(battle).find((u) => (typeIsChar ? isPC(u) : isSum(u) && u.team === 1) && u.gridPos === pos) || null;
  }

  // number of units a skill would hit (Creature.GetTargetList) -- combat.js owns grid targeting
  function countTargets(battle, a, s, main, gridPos) {
    if (LOSim.combat && LOSim.combat.targets) {
      const r = LOSim.combat.targets(battle, a, s, { target: main || null, gridPos: gridPos === undefined ? 255 : gridPos });
      return Array.isArray(r) ? r.length : 0;
    }
    return main ? 1 : 0;
  }

  // ------------------------------------------------------------------ provoke / marking
  const checkDistance = (a, t) => cell(a) + cell(t) + 1;
  function isProvoke(battle, ss, a, tl, s) {
    if (tl.length > 0 && tl[0].type === a.type) return false;
    const b = has(a, 'STAGE_PROVOKE');
    if (b) {
      const pc = buffFrom(battle, b);
      if (pc && pc.type !== a.type && checkDistance(a, pc) <= skillDistance(battle, a, s)) { ss.targetAid = pc.aid; return true; }
    }
    return false;
  }
  function isStageMarking(battle, ss, a, tl, s) {
    if (tl.length > 0 && tl[0].type === a.type) return false;
    const hpOrder = orderBy(tl.filter((t) => has(t, 'STAGE_MARKING')), (t) => t.hp);
    for (const t of hpOrder) if (checkDistance(a, t) <= skillDistance(battle, a, s)) { ss.targetAid = t.aid; return true; }
    return false;
  }
  function isMarkingOrProvoke(battle, self, att) {
    const p = att ? has(att, 'STAGE_PROVOKE') : null;
    if (p && buffFrom(battle, p) === self) return true;
    return !!has(self, 'STAGE_MARKING');
  }

  // ------------------------------------------------------------------ SetTarget* (BattleManager._getTargetAIFunc)
  const PM = (battle, ss, a, tl, s) => isProvoke(battle, ss, a, tl, s) || isStageMarking(battle, ss, a, tl, s);
  const highest = (f) => (battle, ss, tl, a, s) => {
    if (PM(battle, ss, a, tl, s)) return true;
    const ft = orderByDesc(tl, f);
    if (ft.length > 0) ss.targetAid = ft[0].aid; else ss.targetAid = pick(battle, tl).aid; // (GetRandom on empty -> NRE, unreachable)
    return true;
  };
  const AF = E.ACTOR_ATTR_TYPE, VT = E.VALUE_TYPE;
  const targetFuncs = {};
  targetFuncs[ATT.SELF] = (battle, ss, tl, a) => { ss.targetAid = a.aid; return true; };
  targetFuncs[ATT.BACKEND] = (battle, ss, tl, a, s) => {
    if (PM(battle, ss, a, tl, s)) return true;
    const l = orderByDesc(tl, cell);
    if (!l.length) throw new Error('ArgumentOutOfRange: SetTargetBackEnd on empty list'); // list[0] on empty list in C#
    const f = tl.filter((t) => cell(t) === cell(l[0]));
    if (!f.length) return false;
    ss.targetAid = pick(battle, f).aid; return true;
  };
  targetFuncs[ATT.RANDOM] = (battle, ss, tl, a, s) => {
    if (!tl.length) return false;
    if (PM(battle, ss, a, tl, s)) return true;
    const t = tl[rngInt(battle, tl.length)]; if (!t) return false;
    ss.targetAid = t.aid; return true;
  };
  targetFuncs[ATT.OURTEAM] = (battle, ss, tl) => {
    const t = tl[rngInt(battle, tl.length)]; if (!t) throw new Error('ArgumentOutOfRange: SetTargetOurTeam on empty list');
    ss.targetAid = t.aid; return true;
  };
  targetFuncs[ATT.ACTORID] = (battle, ss, tl, a, s, p1) => {
    if (PM(battle, ss, a, tl, s)) return true;
    const id = Number(p1);
    const t = tl.find((x) => x.aid === id); if (!t) return false;
    ss.targetAid = t.aid; return true;
  };
  targetFuncs[ATT.NEAR] = (battle, ss, tl, a, s) => {
    if (PM(battle, ss, a, tl, s)) return true;
    let l = orderBy(tl, cell); if (!l.length) return false;
    l = l.filter((x) => cell(x) === cell(l[0]));
    ss.targetAid = pick(battle, l).aid; return true;
  };
  function groupByRow(tl) { const m = new Map(); for (const t of tl) { const r = row(t); if (!m.has(r)) m.set(r, []); m.get(r).push(t); } return [...m.values()]; }
  targetFuncs[ATT.ACTORNEAR_ROWINCNT] = (battle, ss, tl, a, s, p1) => {
    if (PM(battle, ss, a, tl, s)) return true;
    const rowCount = parseInt(p1, 10) || 0; let chk = 100; const lf = [];
    for (const g of groupByRow(tl).filter((g) => g.length >= rowCount)) for (const t of g) { const d = checkDistance(a, t); if (d <= chk) { chk = d; lf.push(t); } }
    if (!lf.length) return false;
    const aid = lf[rngInt(battle, lf.length)].aid; if (!aid) return false;
    ss.targetAid = aid; return true;
  };
  targetFuncs[ATT.APPLYBUFF] = (battle, ss, tl, a, s, p1) => {
    if (PM(battle, ss, a, tl, s)) return true;
    const t = tl.find((x) => hasKey(x, p1)); if (!t) return false;
    ss.targetAid = t.aid; return true;
  };
  targetFuncs[ATT.ACTORCLASSNEAR_ROWINCNT] = (battle, ss, tl, a, s, p1) => {
    // NOTE: C# parses param1 for BOTH rowCount and the actor class (param2 is ignored) -- reproduced.
    if (PM(battle, ss, a, tl, s)) return true;
    const rowCount = parseInt(p1, 10) || 0; const cls = parseInt(p1, 10); const lf = [];
    for (const g of groupByRow(tl).filter((g) => g.length >= rowCount)) for (const t of g) if (actorClass(t) === cls) lf.push(t);
    if (!lf.length) return false;
    ss.targetAid = pick(battle, orderBy(lf, cell)).aid; return true;
  };
  targetFuncs[ATT.ACTORCLASSNEAR] = (battle, ss, tl, a, s, p1) => {
    if (PM(battle, ss, a, tl, s)) return true;
    const ft = orderBy(tl.filter((l) => actorClass(l) === parseInt(p1, 10)), cell);
    if (!ft.length) return false;
    ss.targetAid = ft[0].aid; return true;
  };
  targetFuncs[ATT.ACTORCLASS] = (battle, ss, tl, a, s, p1) => {
    if (PM(battle, ss, a, tl, s)) return true;
    const ft = tl.filter((l) => actorClass(l) === parseInt(p1, 10));
    ss.targetAid = (ft.length ? pick(battle, ft) : pick(battle, tl)).aid; return true;
  };
  targetFuncs[ATT.ACTORROLE] = (battle, ss, tl, a, s, p1) => {
    if (PM(battle, ss, a, tl, s)) return true;
    const ft = tl.filter((l) => actorRole(l) === parseInt(p1, 10));
    ss.targetAid = (ft.length ? pick(battle, ft) : pick(battle, tl)).aid; return true;
  };
  targetFuncs[ATT.HPLOW] = (battle, ss, tl, a, s) => {
    if (PM(battle, ss, a, tl, s)) return true;
    const ft = orderBy(tl, (p) => p.hp); ss.targetAid = (ft.length ? ft[0] : pick(battle, tl)).aid; return true;
  };
  targetFuncs[ATT.ATKHIGHEST] = (battle, ss, tl, a, s) => highest(getAtk)(battle, ss, tl, a, s);
  targetFuncs[ATT.HPHIGHEST] = (battle, ss, tl, a, s) => highest((p) => p.hp)(battle, ss, tl, a, s);
  targetFuncs[ATT.EVADEHIGHEST] = (battle, ss, tl, a, s) => highest((p) => getAttr(p, VT.RATE, AF.EVADE))(battle, ss, tl, a, s);
  targetFuncs[ATT.DEFENSEHIGHEST] = (battle, ss, tl, a, s) => highest((p) => getAttr(p, VT.ABS, AF.DEF))(battle, ss, tl, a, s);
  targetFuncs[ATT.FIRERESISTHIGHEST] = (battle, ss, tl, a, s) => highest((p) => getAttr(p, VT.ABS, AF.FIRE_RESIST))(battle, ss, tl, a, s);
  targetFuncs[ATT.ICERESISTHIGHEST] = (battle, ss, tl, a, s) => highest((p) => getAttr(p, VT.ABS, AF.ICE_RESIST))(battle, ss, tl, a, s);
  targetFuncs[ATT.ELETRONICRESISTHIGHEST] = (battle, ss, tl, a, s) => highest((p) => getAttr(p, VT.ABS, AF.LIGHTNING_RESIST))(battle, ss, tl, a, s);
  targetFuncs[ATT.APHIGHEST] = (battle, ss, tl, a, s) => highest((p) => p.turnPos)(battle, ss, tl, a, s);

  // ------------------------------------------------------------------ summon placement (IsSummonCreateAuto + CellIsSummonAuto)
  // APPROXIMATION: StageMapData.CellIsSummonAuto (summon grid rules incl. buff-gated cells) is not ported; we use
  // combat.summonCells(battle, actor, skill) if provided, else empty own-side cells within skill distance.
  function summonCreateAuto(battle, s) {
    const lt = s.levelTable;
    if (LOSim.num(lt, 'IsSummonSkill') === 1 && LOSim.str(lt, 'SkillAttackRate', '0') === '0') {
      const key = LOSim.str(lt, 'SummonKeyString');
      const ts = LOSim.T('Table_Summon', key);
      const cnt = list(battle).filter((u) => u.key === key).length;
      if (ts && LOSim.num(ts, 'SummonOverlapCnt') <= cnt) return false;
    }
    return true;
  }
  function summonCells(battle, a, s) {
    if (LOSim.combat && LOSim.combat.summonCells) return LOSim.combat.summonCells(battle, a, s) || [];
    const pcSide = onPcSide(a);
    const d = skillDistance(battle, a, s);
    return emptyLine(battle, pcSide).filter((p) => Math.abs((pcSide ? (8 - p) % 3 : p % 3) - cell(a)) <= d);
  }

  // ------------------------------------------------------------------ GetTargetAI (overload 1: AI scripts and PC auto)
  function newSel(a) { return { aid: a.aid, skillKey: '', targetAid: 0, targetGridPos: 255 }; }
  AI.newSel = newSel;
  function getTargetAI(battle, ss, a, useSkillType, attackType, p1, p2, p3) {
    if (!a) return false;
    ss.aid = a.aid;
    if (has(a, 'STAGE_SEAL_SKILL')) { ss.skillKey = WAIT(); return true; }
    const s = skillBySlot(a, slotOfUseType(useSkillType));
    if (!s) return false;
    ss.skillKey = s.key;
    const tt = targetType(s);
    let tl;
    if (tt === TT.OUR || tt === TT.OUR_GRID) tl = ourTargetListBySkillDistance(battle, a, skillDistance(battle, a, s), tt);
    else tl = targetListBySkillDistance(battle, a, skillDistance(battle, a, s));
    if (!tl) return false;
    if (tt !== TT.SELF) {
      if (tl.length === 0 && (!isPC(a) || tt !== TT.ENEMY_GRID)) return false;
    } else attackType = ATT.SELF;

    const fn = targetFuncs[attackType];
    if (!fn) throw new Error('IndexOutOfRange: ATTACKTARGETTYPE ' + attackType);
    const result = fn(battle, ss, tl, a, s, p1, p2, p3);
    if (isSummonSkill(s)) {
      if (summonCreateAuto(battle, s)) {
        const cells = summonCells(battle, a, s);
        if (cells.length > 0) { ss.targetGridPos = pick(battle, cells); ss.targetAid = 0; return true; }
        return false;
      }
      return false;
    }
    const main = getCreature(battle, ss.targetAid);
    if (tt === TT.OUR_GRID || tt === TT.ENEMY_GRID) {
      if (main) ss.targetGridPos = main.gridPos;
      const g = gridRow(s);
      if (g && LOSim.num(g, 'UsePoint') === 0) ss.targetGridPos = LOSim.num(g, 'StandardPoint');
    }
    let targetCount = tl.length;
    if (isPC(a) && (!main || !isMarkingOrProvoke(battle, main, a))) targetCount = pcBestTarget(battle, ss, a, s, tt, targetCount);
    if (isPC(a)) return targetCount > 0 || attackType === ATT.SELF;
    return result;
  }
  AI.getTargetAI = getTargetAI;

  // PC "hit the most units" refinement shared by both GetTargetAI overloads
  function pcBestTarget(battle, ss, a, s, tt, targetCount) {
    const dist = skillDistance(battle, a, s);
    if (tt === TT.ENEMY_GRID) {
      let best = ss.targetGridPos;
      if (best !== 255) { ss.targetAid = 0; targetCount = countTargets(battle, a, s, null, best); }
      const lines = []; for (let i = 0; i < 9; i++) if (Math.abs((i % 3) + cell(a) + 1) <= dist) lines.push(i); // GetMonsterLineDistance
      shuffle(battle, lines);
      for (const ln of lines) { const n = countTargets(battle, a, s, null, ln); if (n > targetCount) { best = ln; targetCount = n; } }
      ss.targetAid = 0; ss.targetGridPos = best;
    } else if (tt === TT.ENEMY) {
      let best = ss.targetAid;
      targetCount = countTargets(battle, a, s, getCreature(battle, ss.targetAid), ss.targetGridPos);
      const enemys = shuffle(battle, monsterCellDist(battle, cell(a), dist));
      for (const e of enemys) { const n = countTargets(battle, a, s, e, e.gridPos); if (n > targetCount) { best = e.aid; targetCount = n; } }
      ss.targetAid = best;
    }
    return targetCount;
  }

  // ------------------------------------------------------------------ GetTargetAI (overload 2: DoTurnAction re-target, RANDOM)
  AI.retargetRandom = function (battle, ss, a, s) {
    if (getCreature(battle, ss.targetAid)) return true;
    ss.aid = a.aid;
    const tt = targetType(s);
    let tl;
    if (tt === TT.OUR || tt === TT.OUR_GRID) tl = ourTargetListBySkillDistance(battle, a, skillDistance(battle, a, s), tt);
    else tl = targetListBySkillDistance(battle, a, skillDistance(battle, a, s));
    if (!tl) return false;
    let attackType = ATT.RANDOM;
    if (tt !== TT.SELF) {
      if (tl.length === 0 && !isSummonSkill(s) && (!isPC(a) || tt !== TT.ENEMY_GRID)) return false;
    } else attackType = ATT.SELF;
    if (tl.length > 0 && !PM(battle, ss, a, tl, s)) { const t = pick(battle, tl); if (!t) return false; ss.targetAid = t.aid; }
    if (isSummonSkill(s)) {
      if (summonCreateAuto(battle, s)) {
        const cells = summonCells(battle, a, s);
        if (cells.length) { ss.targetGridPos = pick(battle, cells); ss.targetAid = 0; return true; }
      }
      return false;
    }
    const main = getCreature(battle, ss.targetAid);
    if (tt === TT.OUR_GRID || tt === TT.ENEMY_GRID) {
      if (main) ss.targetGridPos = main.gridPos;
      const g = gridRow(s);
      if (g && LOSim.num(g, 'UsePoint') === 0) ss.targetGridPos = LOSim.num(g, 'StandardPoint');
    }
    let targetCount = tl.length;
    if (isPC(a) && (!main || !isMarkingOrProvoke(battle, main, a))) targetCount = pcBestTarget(battle, ss, a, s, tt, targetCount);
    if (ss.targetGridPos !== 255) ss.targetAid = 0;
    if (isPC(a)) return targetCount > 0 || attackType === ATT.SELF;
    return targetCount > 0;
  };

  // ------------------------------------------------------------------ previews used by Lua
  function getTargetCount(battle, a, s) { // BattleManager.GetTargetCount
    if (!s || !a) return -1;
    const d = skillDistance(battle, a, s);
    if (isPC(a) || isSum(a)) return monsterCellDist(battle, cell(a), d).length;
    if (isMob(a)) return pcCellDist(battle, cell(a), d).length;
    throw new Error('NullReference: GetTargetCount targetList'); // targetList stays null for other types
  }
  function isUseSkillPosPreview(battle, a, s) { // BattleManager.IsUseSkillPos_Preview
    if (!s || !a) return -1;
    const posList = [];
    for (let i = 0; i < 9; i++) {
      if (i === a.gridPos) continue;
      if (occupied(battle, false, i)) continue; // IsActorByGridPos(MONSTER, i) -- always the monster line, also for summons
      // NOTE (client bug, reproduced): the range check uses the actor's CURRENT position, not cell i.
      if (targetListBySkillDistance(battle, a, skillDistance(battle, a, s)).length === 0) continue;
      posList.push(i);
    }
    if (!posList.length) return -1;
    return posList[rngInt(battle, posList.length)]; // UnityEngine.Random.Range (unseeded in client)
  }
  function isSetTarget(battle, useSkillType, a, targetAid) {
    const t = getCreature(battle, targetAid);
    if (!t || t.type === a.type) return false;
    const s = skillBySlot(a, slotOfUseType(useSkillType));
    if (!s) throw new Error('NullReference: IsSetTarget skill');
    const tl = targetListBySkillDistance(battle, a, skillDistance(battle, a, s));
    return tl.some((x) => x.aid === targetAid);
  }

  // ------------------------------------------------------------------ CreatureAI static API (operates on `cur`)
  let cur = null; // {battle, unit}   (CreatureAI.creature static)
  const enqueue = (ss) => cur.unit.reserveSkillList.push(ss);
  const waitSel = () => ({ aid: cur.unit.aid, skillKey: WAIT(), targetAid: 0, targetGridPos: 0 });
  function getTargetOrWait(useSkillType, att, p1, p2, p3) {
    const ss = newSel(cur.unit);
    if (!getTargetAI(cur.battle, ss, cur.unit, useSkillType, att, p1, p2, p3)) {
      ss.aid = cur.unit.aid; ss.skillKey = WAIT(); ss.targetAid = 0; ss.targetGridPos = 0; enqueue(ss); return 0;
    }
    enqueue(ss); return 1;
  }
  function getTargetOrNothing(useSkillType, att, p1, p2, p3) {
    const ss = newSel(cur.unit);
    if (!getTargetAI(cur.battle, ss, cur.unit, useSkillType, att, p1, p2, p3)) return 0;
    enqueue(ss); return 1;
  }
  const API = {
    GetRandomValue: (v) => { if (v < 0) throw new Error('ArgumentOutOfRangeException: maxValue'); return rngInt(cur.battle, v); },
    IsAction: () => (cur.unit.isAction ? 1 : 0), // Creature.IsAction is never assigned in the client -> always 0
    IsAttacked: () => (cur.unit.flags && cur.unit.flags.beAttacked ? 1 : 0),
    GetLastAttackEnemyAID: () => (cur.unit.flags && cur.unit.flags.attackerAid) || 0,
    IsApplyBuffTarget: (k) => (list(cur.battle).some((u) => isPC(u) && hasKey(u, k)) ? 1 : 0),
    IsApplyBuff: (k) => (hasKey(cur.unit, k) ? 1 : 0),
    IsExistTarget_FrontCol: () => {
      const p = cur.unit.gridPos;
      if (p === 0 || p === 3 || p === 6) {
        for (const g of [2, 5, 8]) if (actorByGridPosPC(cur.battle, true, g)) return 1;
        for (const g of [2, 5, 8]) if (actorByGridPosPC(cur.battle, false, g)) return 1;
      }
      return 0;
    },
    ISCharacterInBattle: (k) => (list(cur.battle).some((u) => u.key === k) ? 1 : 0),
    RemoveBuff: () => null, // body commented out in the client
    GetGridPos: () => cur.unit.gridPos,
    IsLiveOurTeam: () => {
      const u = cur.unit;
      if (isPC(u) || isSum(u)) return list(cur.battle).some((p) => isPC(p) && p !== u) ? 1 : 0;
      if (isMob(u)) return list(cur.battle).some((p) => isMob(p) && p !== u) ? 1 : 0;
      return 0;
    },
    GetHPPer: () => hpRate(cur.unit) * 100,
    GetHP: () => cur.unit.hp | 0,
    IsUseSkillPos: (t) => {
      const s = skillBySlot(cur.unit, slotOfUseType(t)); if (!s) return 0;
      return isUseSkillPosPreview(cur.battle, cur.unit, s) < 0 ? 0 : 1;
    },
    GetReserveSkillCount: () => cur.unit.reserveSkillList.length,
    Wait: () => { enqueue(waitSel()); },
    MoveToUseSkillPos: (t) => { // string overload (no TargetType filter)
      const s = skillBySlot(cur.unit, slotOfUseType(t)); if (!s) return -1;
      return isUseSkillPosPreview(cur.battle, cur.unit, s);
    },
    MoveToFrontPos: () => { for (const p of emptyLine(cur.battle, false)) if (p === 0 || p === 3 || p === 6) return p; return -1; },
    GetTargetCount: (t) => getTargetCount(cur.battle, cur.unit, skillBySlot(cur.unit, slotOfUseType(t))),
    IsSetTarget_ActorID: (t, aid) => (isSetTarget(cur.battle, t, cur.unit, aid) ? 1 : 0),
    SetTarget_ActorID: (t, aid) => { getTargetOrWait(t, ATT.ACTORID, String(aid), '0', ''); },
    SetTarget_Near: (t) => getTargetOrNothing(t, ATT.NEAR, '', '', ''),
    SetTarget_RowInCnt_By_Near: (t, n) => getTargetOrNothing(t, ATT.ACTORNEAR_ROWINCNT, String(n), '', ''),
    SetTarget_ActorClassAndRowInCnt_By_Near: (t, cls, n) => getTargetOrNothing(t, ATT.ACTORCLASSNEAR_ROWINCNT, String(cls), String(n), ''),
    SetTarget_ApplyBuff: (t, k) => getTargetOrNothing(t, ATT.APPLYBUFF, k, '', ''),
    SetTarget_ActorClass_By_Near: (t, cls) => getTargetOrNothing(t, ATT.ACTORCLASSNEAR, String(cls), '', ''),
    SetTarget_ActorClass: (t, cls) => getTargetOrWait(t, ATT.ACTORCLASS, String(cls), '', ''),
    SetTarget_ActorRole: (t, r) => { getTargetOrWait(t, ATT.ACTORROLE, String(r), '', ''); },
    SetTarget_HPLow: (t) => { getTargetOrWait(t, ATT.HPLOW, '', '', ''); },
    SetTarget_AtkHighest: (t) => { getTargetOrWait(t, ATT.ATKHIGHEST, '', '', ''); },
    SetTarget: (t, attackType) => {
      const name = String(attackType).toUpperCase();
      let c = ATT[name];
      if (c === undefined && /^-?\d+$/.test(name)) c = parseInt(name, 10); // Enum.Parse accepts numbers
      if (c === undefined || name === '__MAX__') throw new Error("ArgumentException: Requested value '" + attackType + "' was not found.");
      getTargetOrWait(t, c, '', '', '');
    },
    Move: (pos) => {
      const ok = emptyGridPosList(cur.battle, cur.unit).indexOf(pos) >= 0;
      if (!ok) enqueue(waitSel());
      else enqueue({ aid: cur.unit.aid, skillKey: MOVE(), targetAid: 0, targetGridPos: pos & 0xff });
    },
    IsBeAttackedSameRow: () => 0,
    IsCriNextAttack: () => (has(cur.unit, 'STAGE_CRITICAL_NEXTATTACK') ? 1 : 0),
    GetRoundCount: () => cur.battle.round,
    GetApplyBuffCount: (k) => countKey(cur.unit, k),
    GetMyPartyCount: () => (isMob(cur.unit) ? list(cur.battle).filter(isMob).length : list(cur.battle).filter(isPC).length),
    GetEnemyPartyCount: () => (isMob(cur.unit) ? list(cur.battle).filter(isPC).length : list(cur.battle).filter(isMob).length),
  };
  // Lua argument signatures (SLua checkType): s = string, i = int, n = number(ulong)
  const SIG = {
    GetRandomValue: 'i', IsApplyBuffTarget: 's', IsApplyBuff: 's', ISCharacterInBattle: 's', RemoveBuff: 'xs',
    IsUseSkillPos: 's', MoveToUseSkillPos: 's', GetTargetCount: 's', IsSetTarget_ActorID: 'sn', SetTarget_ActorID: 'sn',
    SetTarget_Near: 's', SetTarget_RowInCnt_By_Near: 'si', SetTarget_ActorClassAndRowInCnt_By_Near: 'sii',
    SetTarget_ApplyBuff: 'ss', SetTarget_ActorClass_By_Near: 'si', SetTarget_ActorClass: 'si', SetTarget_ActorRole: 'si',
    SetTarget_HPLow: 's', SetTarget_AtkHighest: 's', SetTarget: 'ss', Move: 'i', GetApplyBuffCount: 's',
  };
  AI.API_NAMES = Object.keys(API);
  // MoveToUseSkillPos(SKILL_SLOT_TYPE) overload used by CreatureAI.Process fallback
  function moveToUseSkillPosEnum(slot) {
    const s = skillBySlot(cur.unit, slot); if (!s) return -1;
    const tt = targetType(s);
    if (tt !== TT.ENEMY && tt !== TT.ENEMY_GRID) return -1;
    return isUseSkillPosPreview(cur.battle, cur.unit, s);
  }

  // ------------------------------------------------------------------ fengari Lua bridge
  const getF = () => (typeof window !== 'undefined' && window.fengari) || (typeof fengari !== 'undefined' ? fengari : null); // eslint-disable-line no-undef
  function luaState(battle) {
    if (battle._lua) return battle._lua;
    const F = getF();
    if (!F) throw new Error('fengari not loaded (Lua AI unavailable)');
    const { lua, lauxlib, lualib, to_luastring } = F;
    const L = lauxlib.luaL_newstate();
    lualib.luaL_openlibs(L);
    lua.lua_newtable(L);
    for (const name of Object.keys(API)) {
      const sig = SIG[name] || '';
      lua.lua_pushjsfunction(L, function (L2) {
        let args;
        try {
          args = [];
          for (let i = 0; i < sig.length; i++) {
            const k = sig[i], idx = i + 1;
            if (k === 's') args.push(F.to_jsstring(lauxlib.luaL_checkstring(L2, idx)));
            else if (k === 'i') args.push(Math.trunc(lauxlib.luaL_checknumber(L2, idx)));
            else if (k === 'n') args.push(Math.trunc(lauxlib.luaL_checknumber(L2, idx)));
            else args.push(null);
          }
        } catch (e) { if (e && e.status !== undefined) throw e; throw e; }
        let ret;
        try {
          ret = API[name].apply(null, args);
        } catch (e) {
          if (e && e.status !== undefined) throw e; // already a Lua error
          // C# exception inside a SLua wrapper -> error(l,e) -> Lua error (caught by Process' pcall)
          if (cur && cur.battle) (cur.battle.luaErrors = cur.battle.luaErrors || []).push({ kind: 'api-exception', api: name, msg: String(e && e.message), stack: e && e.stack, aiKey: cur.aiKey, unit: cur.unit.key, round: cur.battle.round });
          lauxlib.luaL_error(L2, to_luastring('CreatureAI.' + name + ': ' + (e && e.message)));
          return 0;
        }
        if (ret === undefined) return 0;
        if (ret === null) { lua.lua_pushnil(L2); return 1; }
        if (typeof ret === 'number') { if (Number.isInteger(ret)) lua.lua_pushinteger(L2, ret); else lua.lua_pushnumber(L2, ret); return 1; }
        if (typeof ret === 'boolean') { lua.lua_pushboolean(L2, ret); return 1; }
        lua.lua_pushstring(L2, to_luastring(String(ret))); return 1;
      });
      lua.lua_setfield(L, -2, to_luastring(name));
    }
    lua.lua_setglobal(L, to_luastring('CreatureAI'));
    battle._lua = { F, L, chunks: {} };
    return battle._lua;
  }

  // compile (cached per AI name). Load/syntax error -> throws like SLua LuaState.doBuffer.
  function compile(LS, aiKey, src) {
    if (LS.chunks[aiKey] !== undefined) return LS.chunks[aiKey];
    const { lua, lauxlib, to_luastring } = LS.F;
    let code = src;
    if (code.charCodeAt(0) === 0xfeff) code = code.slice(1); // CleanUTF8Bom
    const buf = to_luastring(code);
    const st = lauxlib.luaL_loadbuffer(LS.L, buf, buf.length, to_luastring('@' + aiKey + '.lua'));
    if (st !== lua.LUA_OK) {
      const msg = lua.lua_tojsstring(LS.L, -1);
      lua.lua_pop(LS.L, 1);
      const err = new Error('Lua load error (' + aiKey + '.lua): ' + msg);
      err.luaLoadError = true; err.aiKey = aiKey;
      throw err;
    }
    LS.chunks[aiKey] = lauxlib.luaL_ref(LS.L, lua.LUA_REGISTRYINDEX);
    return LS.chunks[aiKey];
  }

  function pcallTop(LS, nargs) {
    const { lua } = LS.F;
    const st = lua.lua_pcall(LS.L, nargs, 0, 0);
    if (st !== lua.LUA_OK) {
      const msg = lua.lua_tojsstring(LS.L, -1) || ('lua error ' + st);
      lua.lua_pop(LS.L, 1);
      return msg;
    }
    return null;
  }

  // LuaSvr.start(aiKey + ".lua") == doFile + run("Process") on the shared state
  function luaStart(battle, unit, aiKey) {
    const LS = luaState(battle);
    const { lua, to_luastring } = LS.F;
    const L = LS.L;
    const src = LOSim.data && LOSim.data.lua ? LOSim.data.lua[aiKey] : undefined;
    const errs = (battle.luaErrors = battle.luaErrors || []);
    if (src === undefined) {
      // doFile: "Can't find {fn}" logged, returns null; run("Process") still calls whatever Process is global.
      errs.push({ kind: 'missing-file', aiKey, unit: unit.key, round: battle.round });
    } else {
      const ref = compile(LS, aiKey, src);
      lua.lua_rawgeti(L, lua.LUA_REGISTRYINDEX, ref);
      const e = pcallTop(LS, 0);
      if (e) errs.push({ kind: 'runtime', where: 'chunk', aiKey, unit: unit.key, msg: e, round: battle.round });
    }
    const t = lua.lua_getglobal(L, to_luastring('Process'));
    if (t !== lua.LUA_TFUNCTION) { lua.lua_pop(L, 1); errs.push({ kind: 'no-Process', aiKey, unit: unit.key, round: battle.round }); return; }
    const e2 = pcallTop(LS, 0);
    if (e2) {
      errs.push({ kind: 'runtime', where: 'Process', aiKey, unit: unit.key, msg: e2, round: battle.round });
      if (LOSim.log) LOSim.log(battle, 'luaError', { unit: unit.key, aiKey, msg: e2 });
    }
  }

  // compile only (for --all-lua checks). Returns {aiKey: errorMessage}
  AI.compileAll = function (luaTable) {
    const fake = { units: [], rng: LOSim.makeRng(1), round: 0 };
    const LS = luaState(fake);
    const out = {};
    for (const k of Object.keys(luaTable || {})) {
      try { compile(LS, k, luaTable[k]); } catch (e) { out[k] = e.message; }
    }
    return out;
  };

  // ------------------------------------------------------------------ CreatureAI.Process (monster / summon)
  AI.processMonster = function (battle, unit) {
    if (!unit.reserveSkillList) unit.reserveSkillList = [];
    if (!unit.turnInfo || unit.turnInfo.reserveRound !== battle.round) return;
    const aiKey = unit.aiKey || LOSim.str(unit.table, 'AIKeyString');
    let turnValue = unit.turnPos;
    let before = ROUND_ATTACK_COUNT_MAX;
    if (unit.reserveSkillList.length > 0) before = unit.reserveSkillList.length;
    unit.reserveSkillList.length = 0;
    let count = 0;
    const prev = cur;
    cur = { battle, unit, aiKey };
    try {
      while (turnValue >= ACTIVE_ROUND()) {
        luaStart(battle, unit, aiKey);
        const q = unit.reserveSkillList;
        if (q.length === 0) {
          let pos = moveToUseSkillPosEnum(1);
          if (pos === -1) pos = moveToUseSkillPosEnum(2);
          if (pos !== -1) API.Move(pos); else API.Wait();
        }
        const ss = q[0];
        if (!ss) break;
        if (unit.lastSkillInfo && ss.skillKey === MOVE()) ss.skillKey = WAIT();
        if (ss.skillKey === WAIT() || ss.skillKey === MOVE()) break;
        const s = skillByKey(unit, ss.skillKey);
        if (!s) return;
        turnValue -= needAP(s);
        count++;
        if (q.length > before) q.splice(count); // script registered several actions -> keep the first `count`
        if (count === before) break;
      }
    } finally { cur = prev; }
  };

  // ------------------------------------------------------------------ Character.AI (PC auto battle)
  AI.characterAI = function (battle, unit) {
    if (!unit.reserveSkillList) unit.reserveSkillList = [];
    let first = SKILL_SLOT_1, second = 'skill_slot_2';
    if (unit.pcAiFirstSkill === 2) { first = 'skill_slot_2'; second = SKILL_SLOT_1; }
    const ss = newSel(unit);
    // NOTE: like the client, cooldown is NOT considered here; DoTurnAction converts a cooling-down skill to Wait.
    if (!getTargetAI(battle, ss, unit, first, ATT.RANDOM, '', '', '')) {
      if (!getTargetAI(battle, ss, unit, second, ATT.RANDOM, '', '', '')) {
        ss.aid = unit.aid; ss.skillKey = WAIT(); ss.targetAid = 0; ss.targetGridPos = 0;
      }
    }
    unit.reserveSkillList.push(ss);
  };
  const isActiveSkillKey = (k) => !!k && k !== WAIT() && k !== MOVE();
  // BattleManager.AutoCharacter (renewal)
  AI.autoCharacter = function (battle, unit) {
    let curTP = unit.turnPos;
    for (const ss of unit.reserveSkillList.slice()) {
      if (!isActiveSkillKey(ss.skillKey)) return;
      const s = skillByKey(unit, ss.skillKey);
      if (s && s.levelTable) curTP -= needAP(s);
    }
    while (curTP >= ACTIVE_ROUND() && unit.reserveSkillList.length < ROUND_ATTACK_COUNT_MAX) {
      AI.characterAI(battle, unit);
      const last = unit.reserveSkillList[unit.reserveSkillList.length - 1];
      if (!isActiveSkillKey(last.skillKey)) return;
      const s = skillByKey(unit, last.skillKey);
      if (s && s.levelTable) curTP -= needAP(s);
      else break; // (C#: skill==null leaves currTurnPos unchanged; count limit still ends the loop)
    }
  };

  // unit.AI() dispatch
  AI.runAI = function (battle, unit) {
    if (!unit.reserveSkillList) unit.reserveSkillList = [];
    if (isPC(unit)) AI.characterAI(battle, unit);
    else AI.processMonster(battle, unit);
  };

  // ------------------------------------------------------------------ public contract
  // choose(battle, unit) -> {skill, target, gridPos, sel} | {wait:true} | {move:gridPos}
  // Runs the unit's AI if nothing is reserved yet and describes the first reserved selection (does not dequeue).
  AI.choose = function (battle, unit) {
    if (!unit.reserveSkillList) unit.reserveSkillList = [];
    if (unit.reserveSkillList.length === 0) {
      if (isPC(unit)) AI.autoCharacter(battle, unit);
      else {
        if (!unit.turnInfo) unit.turnInfo = { reserveRound: battle.round, turnPos: unit.turnPos };
        AI.processMonster(battle, unit);
      }
    }
    const ss = unit.reserveSkillList[0];
    if (!ss || ss.skillKey === WAIT() || !ss.skillKey) return { wait: true, sel: ss || null };
    if (ss.skillKey === MOVE()) return { move: ss.targetGridPos, sel: ss };
    return { skill: skillByKey(unit, ss.skillKey), target: getCreature(battle, ss.targetAid), gridPos: ss.targetGridPos, sel: ss };
  };
})();
