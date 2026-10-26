// LOSim.battle -- battle loop, renewal AP gauge turn order, waves, win/lose, stall detection.
// Port of (renewal path, BEFORE_BATTLE_RENEWAL undefined):
//   BattleManager.StartBattle (wave queue)               BattleManager.BattleStart / AutoCharacter
//   BattleManager.coBattleAI (one call == one "tick")    BattleManager.CalcNewTurn / PrepareReservedAction
//   BattleRoundManager.OnGameStart / FirstTurnCalc / coNextRound / OnChangeRound / coEndRound
//   BattleRoundManager.ApplyCreatureTurnBuffTrigger / ApplyCreatureTurnEndDurations /
//       ApplyAcquiredCreatureTurnStartBuffTrigger / GetNextActionPointAdvanceTime / ProcessSummonLifeCycle
//   Creature.DoTurnAction (pre-execution part: wait/move/cooldown/seal/retarget), ResetActionPoint / BeginActionPointCycle
//   Panel_StageBattle.GetFirstExecutableTurn (who acts; auto mode)
//   ReserveSkillInfo (Common.cs) delayed skills with their own AP gauge
//
// In the renewal a "round" is ONE unit's action (+ its derived actions); OnChangeRound runs after each.
// Packets/animation/UI waits are replaced by direct calls. EW squad swap after a wipe is NOT simulated (lose).
(function () {
  const LOSim = (window.LOSim = window.LOSim || {});
  const E = LOSim.E;
  const C = LOSim.C;
  const B = (LOSim.battle = LOSim.battle || {});
  const TR = E.BUFFEFFECT_TRIGGER_TYPE;
  const BT = E.BUFFEFFECT_TYPE;
  const CT = E.eCreatureType; // NONE 0, CHARACTER 1, MONSTER 2, SUMMON 3
  const ACTIVE_ROUND = () => C.ACTIVE_ROUND || 100;
  const WAIT = () => C.SKILLKEY_WAIT || 'Wait';
  const MOVE = () => C.SKILLKEY_MOVE || 'Move';
  const f32 = Math.fround;

  // ------------------------------------------------------------------ small helpers
  const alive = (u) => u && u.hp > 0 && !u.removed;
  const isPC = (u) => u.type === 'CHARACTER';
  const isMob = (u) => u.type === 'MONSTER';
  const isSum = (u) => u.type === 'SUMMON';
  const ctype = (u) => CT[u.type] || 0;
  const live = (b) => b.units.filter(alive);
  const monsters = (b) => b.units.filter((u) => alive(u) && isMob(u)); // GetMonsterList (Enemy)
  const characters = (b) => b.units.filter((u) => alive(u) && isPC(u)); // GetCharacter
  const cell = (u) => (isPC(u) || isSum(u) ? (8 - u.gridPos) % 3 : Math.abs(u.gridPos) % 3);
  const has = (u, name) => {
    const t = BT[name];
    if (t === undefined) return null;
    if (LOSim.buffs && LOSim.buffs.has) return LOSim.buffs.has(u, t) || null;
    return null;
  };
  const turnSpeed = (u) => {
    if (LOSim.stats && LOSim.stats.getTurnSpeed) return +LOSim.stats.getTurnSpeed(u) || 0;
    const a = u.attr && u.attr[E.VALUE_TYPE.ABS];
    return (a && a[E.ACTOR_ATTR_TYPE.TURNSPEED]) || 0;
  };
  const recalc = (b, u) => { if (LOSim.stats && LOSim.stats.recalc) LOSim.stats.recalc(u, b); };
  const fire = (b, trig, ctx) => { if (LOSim.buffs && LOSim.buffs.trigger) LOSim.buffs.trigger(b, trig, ctx || {}); };
  const log = (b, t, d) => { if (LOSim.log) LOSim.log(b, t, d); };
  const uref = (u) => (u ? { aid: u.aid, key: u.key, name: u.name, team: u.team, gridPos: u.gridPos } : null);

  function initUnitBattleState(u) {
    u._bsInit = true;
    u.reserveSkillList = u.reserveSkillList || []; // Creature.ReserveSkillList (queue)
    u.lastSkillInfo = null;
    u.turnInfo = null;
    u.turnPos = f32(u.turnPos || 0);
    u.flags = u.flags || {};
    u.flags.apTracking = false; u.flags.apCarry = 0;
    u.flags.waitHealCount = 0; u.flags.waitApExhausted = false;
    for (const s of u.skills || []) { s.cooldownLeft = 0; s._skipCdDec = false; }
  }

  // ------------------------------------------------------------------ AP helpers (Creature.cs renewal)
  // shared with buffs.js: STAGE_AP_VALUE/SHIFT write unit.turnPos and, while unit.flags.apTracking, unit.flags.apCarry
  function beginActionPointCycle(u) { if (u.flags.apTracking) return; u.flags.apTracking = true; u.flags.apCarry = 0; u.flags.apReturnBase = 0; }
  function cancelActionPointCycle(u) { u.flags.apTracking = false; u.flags.apCarry = 0; u.flags.apReturnBase = 0; u.flags.waitApExhausted = false; }
  function resetActionPoint(u, b) {
    const experiment = b && b.hooks && b.hooks.skillApReturn && b.hooks.skillApReturn();
    const base = experiment ? (u.flags.apReturnBase || 0) : 0;
    u.turnPos = u.flags.apTracking && !u.flags.waitApExhausted ? f32(Math.min(ACTIVE_ROUND(), Math.max(0, base + (u.flags.apCarry || 0)))) : 0;
    cancelActionPointCycle(u);
  }
  // For buffs.js: STAGE_AP_VALUE / STAGE_AP_SHIFT must go through these so AP gained during the owner's cycle is kept.
  B.addAP = function (u, v) {
    u.turnPos = f32(Math.min(ACTIVE_ROUND(), Math.max(0, u.turnPos + v)));
    if (u.flags.apTracking) u.flags.apCarry = Math.min(ACTIVE_ROUND(), Math.max(0, (u.flags.apCarry || 0) + v));
  };
  B.setAP = function (u, v) {
    u.turnPos = f32(Math.min(ACTIVE_ROUND(), Math.max(0, v)));
    if (u.flags.apTracking) u.flags.apCarry = u.turnPos;
  };
  B.resetActionPoint = resetActionPoint;

  // ------------------------------------------------------------------ cooldowns (Skill.cs renewal)
  function startCooldown(s, b) {
    if (LOSim.combat && LOSim.combat.startCooldown) { LOSim.combat.startCooldown(s, b); return; }
    const cd = Math.max(0, LOSim.num(s.levelTable, 'CooldownTurn'));
    s.cooldownLeft = cd; s._skipCdDec = cd > 0;
  }
  function onOwnerTurnEnded(u) { // CreatureSkill.OnOwnerTurnEnded
    if (LOSim.combat && LOSim.combat.tickCooldowns) { LOSim.combat.tickCooldowns(u); return; }
    for (const s of u.skills || []) {
      if (s._skipCdDec) { s._skipCdDec = false; continue; }
      if (s.cooldownLeft > 0) s.cooldownLeft--;
    }
  }
  function resetWaveSkillCooldowns(b) {
    if (LOSim.combat && LOSim.combat.resetCooldowns) { for (const u of b.units) LOSim.combat.resetCooldowns(u); return; }
    for (const u of b.units) for (const s of u.skills || []) { s.cooldownLeft = 0; s._skipCdDec = false; } }

  // ------------------------------------------------------------------ delayed (reserve) skills -- ReserveSkillInfo
  // combat.js calls this when a skill with Table_Skill.DelaySkillKeyString/DelaySkillRound is used (Creature.cs ~6595).
  B.addReserveSkill = function (b, owner, o) {
    const dcc = Math.max(0, o.chargeCount | 0);
    const r = {
      owner, aid: owner.aid, ownerAid: owner.aid, skillKey: o.skillKey, targetGridPos: o.targetGridPos === undefined ? 255 : o.targetGridPos,
      targetAid: o.targetAid || 0, distance: o.distance, delayType: o.delayType || 0, turnInfo: o.turnInfo || null,
      delayChargeCount: dcc, recoverySpeed: dcc > 0 ? turnSpeed(owner) / dcc : 0,
      actionPoint: 0, previousActionPoint: 0, isTurnEndReady: false,
    };
    b.reserveSkills.push(r);
    log(b, 'reserveSkill', { unit: owner.key, skill: r.skillKey, charge: dcc });
    return r;
  };
  B.getReserveRoundSkillList = (b) => b.reserveSkills;
  // reserve records are created by combat.js (doAttackTarget delay branch) or B.addReserveSkill; same shape
  const rAid = (r) => (r.aid !== undefined ? r.aid : r.ownerAid !== undefined ? r.ownerAid : r.owner && r.owner.aid);
  const rTargetAid = (r) => r.targetAid || (r.targetUnit && r.targetUnit.aid) || 0;
  const isReady = (r) => (r.delayChargeCount === 0 ? !!r.isTurnEndReady : r.actionPoint >= ACTIVE_ROUND()); // ReserveSkillInfo.IsReady
  B.isReserveReady = isReady;
  const reserveTurn = (b, r) => ({ aid: rAid(r), index: 1, isReserve: 1, reserve: r, reserveRound: b.round, preTurnPos: r.previousActionPoint || 0, turnPos: r.actionPoint, creature: r.owner });

  // ------------------------------------------------------------------ turn list sort (identical comparator in 3 places in C#)
  function turnCompare(b) {
    return (x, y) => {
      if (x.reserveRound < y.reserveRound) return -1;
      if (x.reserveRound > y.reserveRound) return 1;
      if (x.turnPos > y.turnPos) return -1;
      if (x.turnPos < y.turnPos) return 1;
      if (x.aid === y.aid) {
        const r = (y.isReserve | 0) - (x.isReserve | 0);
        return r !== 0 ? r : (x.index | 0) - (y.index | 0);
      }
      const A = x.creature, Bc = y.creature;
      if (ctype(A) > ctype(Bc)) return 1;
      if (ctype(A) < ctype(Bc)) return -1;
      const sa = turnSpeed(A), sb = turnSpeed(Bc);
      if (sa > sb) return -1;
      if (sa < sb) return 1;
      if (cell(A) < cell(Bc)) return -1;
      if (cell(A) > cell(Bc)) return 1;
      return A.gridPos < Bc.gridPos ? -1 : 1;
    };
  }

  // GetNextActionPointAdvanceTime
  function nextAPAdvanceTime(b, list) {
    let t = Infinity;
    for (const u of list) {
      if (!u || u.hp <= 0 || has(u, 'STAGE_AP_STOP')) continue;
      const sp = turnSpeed(u);
      if (sp <= 0) continue;
      t = Math.min(t, Math.max(0, ACTIVE_ROUND() - u.turnPos) / sp);
    }
    for (const r of b.reserveSkills) {
      if (!r.owner || !alive(r.owner) || r.delayChargeCount === 0 || r.recoverySpeed <= 0) continue;
      t = Math.min(t, Math.max(0, ACTIVE_ROUND() - r.actionPoint) / r.recoverySpeed);
    }
    return t === Infinity ? 0 : t;
  }

  // ------------------------------------------------------------------ buff trigger points
  // TURN_START_* / TURN_END_* relation triggers (ApplyCreatureTurnBuffTrigger)
  function creatureTurnTrigger(b, owner, isStart) {
    if (isStart) { b.totalTurnCount++; b.selfTurnCounts.set(owner, (b.selfTurnCounts.get(owner) || 0) + 1); }
    if (isStart && LOSim.buffs && LOSim.buffs.onTurnStart) { LOSim.buffs.onTurnStart(b, owner); return; }
    if (!isStart && LOSim.buffs && LOSim.buffs.onTurnEnd) return; // buffs.onTurnEnd fires TURN_END_* itself (creatureTurnEndDurations)
    const isPlayerTeam = (u) => u.team === 1;
    for (const bo of live(b)) {
      let rel;
      if (bo === owner) rel = isStart ? TR.TURN_START_SELF : TR.TURN_END_SELF;
      else if (isPlayerTeam(bo) === isPlayerTeam(owner)) rel = isStart ? TR.TURN_START_ALLY : TR.TURN_END_ALLY;
      else rel = isStart ? TR.TURN_START_ENEMY : TR.TURN_END_ENEMY;
      fire(b, rel, { owner: bo, unit: bo, turnOwner: owner });
      if (bo === owner) fire(b, isStart ? TR.TURN_START_ALLY : TR.TURN_END_ALLY, { owner: bo, unit: bo, turnOwner: owner });
      fire(b, isStart ? TR.TURN_START_ALL : TR.TURN_END_ALL, { owner: bo, unit: bo, turnOwner: owner });
    }
    for (const u of live(b)) recalc(b, u);
  }
  // ApplyCreatureTurnEndDurations
  function creatureTurnEndDurations(b, owner) {
    onOwnerTurnEnded(owner); // CreatureSkill.OnOwnerTurnEnded (cooldowns) -- also for a dead owner
    if (LOSim.buffs && LOSim.buffs.onTurnEnd) { LOSim.buffs.onTurnEnd(b, owner); return; } // TURN_END_* + DOT + ticks
    if (!alive(owner)) return;
    recalc(b, owner);
  }
  function roundStartBuffs(b) { // ApplyRoundStartBuffs (+ ApplyPriorityAnomalyBuffs before it)
    if (LOSim.buffs && LOSim.buffs.onRoundStart) LOSim.buffs.onRoundStart(b);
    else for (const u of live(b)) fire(b, TR.ROUND_START, { owner: u, unit: u });
  }

  // ------------------------------------------------------------------ wave data (StartBattle)
  function weightedPick(b, groups, rates) {
    if (groups.length <= 1) return groups[0];
    // SERVER-SIDE DECISION: when a wave lists several MobGroups the server picks one by WaveMobGroupRate*.
    // We reproduce it with a weighted pick on battle.rng (exact server RNG/algorithm unknown).
    const w = groups.map((_, i) => Math.max(0, parseFloat(rates[i]) || 0));
    const tot = w.reduce((a, c) => a + c, 0);
    if (tot <= 0) return groups[b.rng.int(groups.length)];
    let r = b.rng() * tot;
    for (let i = 0; i < groups.length; i++) { r -= w[i]; if (r < 0) return groups[i]; }
    return groups[groups.length - 1];
  }
  function mobGroupSpawns(groupKey, iw, iwLevel) {
    const g = LOSim.T(iw ? 'Table_MobGroupIW' : 'Table_MobGroup', groupKey) || (iw ? LOSim.T('Table_MobGroup', groupKey) : null);
    if (!g) throw new Error('MobGroup not found: ' + groupKey);
    const out = [];
    for (let i = 1; i <= 9; i++) {
      const key = LOSim.str(g, 'mobIndexString' + i);
      if (!key) continue;
      // DataManager (TR path) / server: GridPosIndex = index of mobIndexString(index+1)
      out.push({ key, level: iw ? iwLevel || LOSim.num(g, 'mobLevel' + i, 1) : LOSim.num(g, 'mobLevel' + i, 1), gridPos: i - 1 });
    }
    return out;
  }
  // setup.customWaves (combo analysis benchmarks): [[{key, level, gridPos, grade?, hpMul?, ability?, inert?}], ...]
  // Synthetic enemy waves without a stage row. Optional per spawn: grade (Table grade override), hpMul (multiplies
  // DefaultHP/DefaultHPByLevel), ability (shallow overrides of the *Ability row), inert (never runs its AI -> always Wait).
  function buildCustomWaves(b) {
    b.stage = b.stageKey ? (LOSim.T(b.mode === 'ew' ? 'Table_MapStageEW' : b.mode === 'iw' ? 'Table_MapStageIW' : 'Table_MapStage', b.stageKey) || null) : null;
    return b.setup.customWaves.map((w, i) => ({
      groupKey: 'custom' + (i + 1),
      spawns: (w || []).map((sp) => Object.assign({}, sp, { level: sp.level || 1, gridPos: sp.gridPos | 0 })),
    }));
  }
  function buildWaves(b) {
    const waves = [];
    if (Array.isArray(b.setup.customWaves) && b.setup.customWaves.length) return buildCustomWaves(b);
    if (b.mode === 'iw') {
      const st = LOSim.T('Table_MapStageIW', b.stageKey);
      if (!st) throw new Error('Table_MapStageIW not found: ' + b.stageKey);
      b.stage = st;
      const gk = LOSim.str(st, 'IW_MobGroup');
      waves.push({ groupKey: gk, spawns: mobGroupSpawns(gk, true, LOSim.num(st, 'IW_MobLevel', 1)) });
      return waves;
    }
    const st = LOSim.T(b.mode === 'ew' ? 'Table_MapStageEW' : 'Table_MapStage', b.stageKey);
    if (!st) throw new Error((b.mode === 'ew' ? 'Table_MapStageEW' : 'Table_MapStage') + ' not found: ' + b.stageKey);
    b.stage = st;
    const cols = [];
    for (let i = 1; i <= 9; i++) cols.push(['WaveMobGroup' + i, 'WaveMobGroupRate' + i]);
    cols.push(['BossMobGroup', 'BossMobGroupRate']);
    for (const [gc, rc] of cols) {
      const groups = LOSim.list(st, gc);
      if (!groups.length) continue; // map.WaveMobGroupN.Count > 0
      const gk = weightedPick(b, groups, LOSim.list(st, rc).length ? (Array.isArray(st[rc]) ? st[rc] : [st[rc]]) : []);
      waves.push({ groupKey: gk, candidates: groups.length > 1 ? groups : undefined, spawns: mobGroupSpawns(gk, false) });
    }
    return waves;
  }

  // ------------------------------------------------------------------ create
  B.create = function (setup) {
    setup = setup || {};
    const opts = setup.options || {};
    const b = {
      setup, stageKey: setup.stageKey, mode: setup.mode || 'stage',
      units: [], allUnits: [], waves: [], waveIndex: -1, maxWave: 0, clearWave: 0,
      round: 0, totalRounds: 0, totalActions: 0, actionCount: 0,
      rng: LOSim.makeRng(setup.seed === undefined ? 1 : setup.seed),
      log: [], logEnabled: !!setup.logEnabled, result: null, errors: [], luaErrors: [],
      reserveSkills: [], totalTurnCount: 0, selfTurnCounts: new Map(),
      apTime: 0, // sum of AP-advance times (game time; a unit with TurnSpeed s acts every 100/s)
      maxActions: opts.maxActions || 3000, maxActionsPerRound: opts.maxActionsPerRound || 200,
      s: { phase: 'init' },
    };
    try {
      b.waves = buildWaves(b);
      b.maxWave = b.waves.length;
      if (!b.maxWave) throw new Error('stage ' + b.stageKey + ' has no WaveMobGroup1..9/BossMobGroup (no battle to simulate)');
      for (const spec of setup.squad || []) {
        if (!LOSim.stats || !LOSim.stats.buildPC) throw new Error('LOSim.stats.buildPC missing');
        const u = LOSim.stats.buildPC(spec);
        u.team = 1; u.type = u.type || 'CHARACTER';
        if (spec.gridPos !== undefined) u.gridPos = spec.gridPos;
        if (spec.aiFirstSkill) u.pcAiFirstSkill = spec.aiFirstSkill;
        initUnitBattleState(u);
        b.units.push(u); b.allUnits.push(u);
      }
    } catch (e) {
      b.errors.push({ msg: String(e && e.message), stack: e && e.stack, context: { phase: 'create', stageKey: b.stageKey } });
      b.result = 'error'; b.resultReason = String(e && e.message);
    }
    return b;
  };

  // spawn a unit mid-battle (summons) -- combat.js should use this so the loop tracks it
  B.addUnit = function (b, u) {
    initUnitBattleState(u);
    if (!b.units.includes(u)) b.units.push(u);
    if (!b.allUnits.includes(u)) b.allUnits.push(u);
    if (u.leftRoundCount === undefined) u.leftRoundCount = LOSim.num(u.table, 'LifeCycleRound');
    return u;
  };

  // ------------------------------------------------------------------ wave start (STATEMOVE -> spawn -> OnGameStart)
  function lastActionTurnInit(b) {
    const s = b.s;
    s.lastActionTurn = null; s.doubleActionTurn = null; s.doubleActionSel = null; s.confirmed = null;
    s.executingReserved = null; s.ownerTurnEndApplied = false; s.apOwner = null;
    for (const u of b.units) cancelActionPointCycle(u);
  }
  function beginWave(b) {
    b.waveIndex++;
    const w = b.waves[b.waveIndex];
    b.units = b.units.filter((u) => alive(u) && !isMob(u)); // AllRemoveEnemy; dead PCs are gone from ListCreature
    for (const sp of w.spawns) {
      if (!LOSim.stats || !LOSim.stats.buildMonster) throw new Error('LOSim.stats.buildMonster missing');
      const mo = { gridPos: sp.gridPos, wave: b.waveIndex, isIW: b.mode === 'iw' };
      if (sp.grade !== undefined) mo.grade = sp.grade; // customWaves only (stage spawns never carry grade)
      const m = LOSim.stats.buildMonster(sp.key, sp.level, mo);
      if (sp.hpMul || sp.ability) applySpawnOverrides(b, m, sp); // customWaves only
      if (sp.inert) m.inert = true;
      m.team = 0; m.type = m.type || 'MONSTER'; m.gridPos = sp.gridPos;
      if (!m.aiKey) m.aiKey = LOSim.str(m.table, 'AIKeyString');
      initUnitBattleState(m);
      b.units.push(m); b.allUnits.push(m);
    }
    log(b, 'wave', { wave: b.waveIndex + 1, group: w.groupKey, monsters: w.spawns.map((s) => s.key + '@' + s.gridPos) });
    lastActionTurnInit(b);
    resetWaveSkillCooldowns(b);
    onGameStart(b);
  }

  function applySpawnOverrides(b, m, sp) {
    const ab = Object.assign({}, m.ability || {}, sp.ability || {});
    const mul = +sp.hpMul || 1;
    if (mul !== 1) { ab.DefaultHP = LOSim.num(ab, 'DefaultHP') * mul; ab.DefaultHPByLevel = LOSim.num(ab, 'DefaultHPByLevel') * mul; }
    m.ability = ab;
    if (LOSim.stats.calcRawAttr) m.base = LOSim.stats.calcRawAttr(m);
    recalc(b, m);
    m.maxHp = m.hp = Math.trunc(m.attr[E.VALUE_TYPE.ABS][E.ACTOR_ATTR_TYPE.HP]);
  }

  function sortUnits(b) { // coNextRound ListCreature sort: CreatureType then LineSpot
    b.units.sort((x, y) => (ctype(x) - ctype(y)) || (x.gridPos < y.gridPos ? -1 : 1));
  }

  // BattleRoundManager.OnGameStart
  function onGameStart(b) {
    b.totalTurnCount = 0; b.selfTurnCounts = new Map();
    if (monsters(b).length === 0) { endRound(b); return; }
    for (const u of b.units) u.turnPos = 0;
    // Thetis hack: move Char_BR_Thetis_N to the end of ListCreature before passive application
    const ti = b.units.findIndex((u) => u.key === 'Char_BR_Thetis_N');
    if (ti >= 0 && ti < b.units.length - 1) { const t = b.units[ti]; b.units[ti] = b.units[b.units.length - 1]; b.units[b.units.length - 1] = t; }
    if (LOSim.buffs && LOSim.buffs.onWaveStart) {
      // anomaly + ALWAYS, COMBAT_START, GRID_NO, FRIENDLY, ENEMY (applyEquipAndPassives per unit) + ROUND_START
      LOSim.buffs.onWaveStart(b);
    } else {
      for (const u of live(b)) {
        if (LOSim.buffs && LOSim.buffs.applyEquipAndPassives) LOSim.buffs.applyEquipAndPassives(b, u);
        else for (const t of [TR.ALWAYS, TR.COMBAT_START, TR.GRID_NO, TR.FRIENDLY, TR.ENEMY]) fire(b, t, { owner: u });
      }
      roundStartBuffs(b);
    }
    // FirstTurnCalc (renewal)
    b.round = 1; b.totalRounds++;
    for (const u of b.units) recalc(b, u);
    const list = live(b);
    const t = nextAPAdvanceTime(b, list);
    const turns = list.map((u) => ({
      aid: u.aid, creature: u, index: 1, isReserve: 0, preTurnPos: u.turnPos, reserveRound: b.round,
      turnPos: has(u, 'STAGE_AP_STOP') ? u.turnPos : Math.min(ACTIVE_ROUND(), u.turnPos + turnSpeed(u) * t),
    }));
    turns.sort(turnCompare(b));
    b.s.apAdvance = t; b.apTime += t;
    acquireTurnStart(b, turns);
    roundStarted(b, turns);
  }

  // ApplyAcquiredCreatureTurnStartBuffTrigger
  function acquireTurnStart(b, turns) {
    b.s.acquired = null;
    for (const tn of turns) if (!tn.isReserve) {
      const u = tn.creature; cancelActionPointCycle(u);
      u.turnInfo = { reserveRound: tn.reserveRound, turnPos: tn.turnPos, isReserve: 0 };
      u.turnPos = f32(tn.turnPos); u.preTurnPos = f32(tn.preTurnPos);
      u.flags.reserveDistance = undefined;
    }
    for (const tn of turns) {
      if (tn.isReserve && isReady(tn.reserve)) break;
      if (tn.isReserve || tn.reserveRound !== b.round || tn.turnPos < ACTIVE_ROUND()) continue;
      const o = tn.creature;
      if (!alive(o) || has(o, 'STAGE_AP_STOP')) continue;
      beginActionPointCycle(o);
      const apBefore = o.turnPos;
      creatureTurnTrigger(b, o, true);
      b.s.acquired = { unit: o, apBefore, apAfter: o.turnPos };
      break;
    }
    for (const tn of turns) if (!tn.isReserve) tn.turnPos = tn.creature.turnPos;
  }

  // Panel_StageBattle.GetFirstExecutableTurn
  function firstExecutableTurn(b, turns) {
    for (const tn of turns) {
      const a = tn.creature;
      if (!a || !alive(a)) continue;
      if (tn.isReserve) { if (!isReady(tn.reserve)) continue; }
      else if (tn.turnPos < ACTIVE_ROUND() || has(a, 'STAGE_AP_STOP')) continue;
      return tn;
    }
    return null;
  }

  // RoundStarted -> AP presentation -> auto start (Panel_StageBattle) -> BattleManager.BattleStart
  function roundStarted(b, turns) {
    b.s.turnList = turns;
    b.s.actionsThisRound = 0;
    const first = firstExecutableTurn(b, turns);
    if (!first) {
      // _currentRoundActor == null -> TryStartCurrentRoundAction returns forever: the client freezes here.
      const l = live(b);
      const stopped = l.filter((u) => has(u, 'STAGE_AP_STOP')).length;
      const zero = l.filter((u) => turnSpeed(u) <= 0).length;
      const why = stopped === l.length ? 'all units have STAGE_AP_STOP'
        : (b.s.apAdvance === 0 ? 'AP cannot advance (every unit is AP_STOP or has TurnSpeed<=0; ' + zero + ' with speed<=0, ' + stopped + ' AP_STOP)'
          : 'no executable turn after AP advance (max AP ' + Math.max(...l.map((u) => u.turnPos)) + ')' +
            (b.s.acquired && b.s.acquired.apAfter < ACTIVE_ROUND() ? '; turn acquirer ' + b.s.acquired.unit.key + ' lost AP during TURN_START (' + b.s.acquired.apBefore + ' -> ' + b.s.acquired.apAfter + ')' : ''));
      finish(b, 'stuck', 'no unit can act at round ' + b.round + ' (wave ' + (b.waveIndex + 1) + '): ' + why);
      return;
    }
    battleStart(b, first);
  }

  // BattleManager.BattleStart (auto)
  function battleStart(b, confirmed) {
    const s = b.s;
    s.confirmed = confirmed;
    s.lastActionTurn = null; s.doubleActionTurn = null; s.doubleActionSel = null;
    for (const u of live(b)) {
      u.reserveSkillList.length = 0;
      u.lastSkillInfo = null;
      if (isMob(u) || isSum(u)) { if (LOSim.ai && LOSim.ai.runAI && !u.inert) LOSim.ai.runAI(b, u); } // inert: customWaves dummy
      else if (isPC(u) && u.turnPos >= ACTIVE_ROUND() && !has(u, 'STAGE_AP_STOP')) {
        if (LOSim.ai && LOSim.ai.autoCharacter) LOSim.ai.autoCharacter(b, u);
      }
    }
    // optional UI hook (sandbox): pause right before the confirmed actor acts so the page can show a preview or take
    // a manual selection. Without b.hooks the flow is unchanged. Resume with B.resume(b).
    if (b.hooks && b.hooks.beforeAction && b.hooks.beforeAction(b, confirmed)) { s.phase = 'input'; return; }
    s.phase = 'ai';
  }
  B.resume = function (b) { if (b.s.phase === 'input') b.s.phase = 'ai'; };

  // BattleRoundManager.OnChangeRound -> RoundEnding -> RoundStarting -> coNextRound
  function onChangeRound(b) { b.round++; b.totalRounds++; b.s.phase = 'nextRound'; }

  function processSummonLifeCycle(b) {
    for (const u of live(b)) if (isSum(u)) {
      if (u.leftRoundCount === undefined) u.leftRoundCount = LOSim.num(u.table, 'LifeCycleRound');
      u.leftRoundCount--;
      if (u.leftRoundCount <= 0) { u.leftRoundCount = 0; removeUnit(b, u); log(b, 'summonExpire', { unit: u.key }); }
    }
  }

  function removeUnit(b, u) {
    u.removed = true;
    if (LOSim.buffs && LOSim.buffs.onUnitRemoved) LOSim.buffs.onUnitRemoved(b, u);
  }

  // coNextRound (renewal)
  function nextRound(b) {
    for (const u of b.units) if (!u._bsInit) { B.addUnit(b, u); } // summons pushed by combat.js spawnSummon
    processSummonLifeCycle(b);
    sortUnits(b);
    if (monsters(b).length === 0) { endRound(b); return; }
    if (characters(b).length === 0) { finish(b, 'lose', 'all PCs dead'); return; } // (EW squad swap not simulated)
    for (const u of live(b)) { u.reserveSkillList.length = 0; u.flags.beAttacked = false; u.flags.isHit = false; } // InitValue
    for (const u of live(b)) recalc(b, u);
    roundStartBuffs(b);
    const list = live(b);
    const t = nextAPAdvanceTime(b, list);
    b.s.apAdvance = t; b.apTime += t;
    for (const r of b.reserveSkills) {
      r.previousActionPoint = r.actionPoint;
      if (r.delayChargeCount > 0) r.actionPoint = Math.min(ACTIVE_ROUND(), r.actionPoint + r.recoverySpeed * t);
    }
    const turns = list.map((u) => ({
      aid: u.aid, creature: u, index: 1, isReserve: 0, preTurnPos: u.turnPos, reserveRound: b.round,
      turnPos: has(u, 'STAGE_AP_STOP') ? u.turnPos : Math.min(ACTIVE_ROUND(), u.turnPos + turnSpeed(u) * t),
    }));
    for (const r of b.reserveSkills) if (r.owner) turns.push(reserveTurn(b, r));
    turns.sort(turnCompare(b));
    acquireTurnStart(b, turns);
    roundStarted(b, turns);
  }

  // BattleManager.CalcNewTurn (renewal). The extra per-reserved-skill TurnInfo rows of the C# never qualify
  // (their TurnPos = AP - NeedActionPoint < 100 because AP is clamped to 100) and are omitted.
  function calcNewTurn(b) {
    for (const u of b.units) if (!u._bsInit) B.addUnit(b, u);
    const turns = [];
    for (const u of live(b)) {
      recalc(b, u);
      turns.push({ aid: u.aid, creature: u, index: 1, isReserve: 0, preTurnPos: u.turnPos, turnPos: u.turnPos, reserveRound: b.round });
    }
    for (const r of b.reserveSkills) if (r.owner) turns.push(reserveTurn(b, r));
    if (!turns.length) return null;
    turns.sort(turnCompare(b));
    const s = b.s;
    if (s.confirmed) {
      const c = s.confirmed; s.confirmed = null;
      const ct = turns.find((t) => t.aid === c.aid && (t.isReserve | 0) === (c.isReserve | 0) && t.index === c.index && (!t.isReserve || t.reserve === c.reserve));
      const a = ct && ct.creature;
      if (ct && a && alive(a) && ct.reserveRound === b.round &&
        (ct.isReserve ? isReady(ct.reserve) : a.turnPos >= ACTIVE_ROUND() && !has(a, 'STAGE_AP_STOP'))) {
        turns.splice(turns.indexOf(ct), 1); turns.unshift(ct);
      }
    }
    for (const t of turns) {
      if (!t.isReserve) { const a = t.creature; if (!a || has(a, 'STAGE_AP_STOP')) continue; }
      if (t.isReserve && !isReady(t.reserve)) continue;
      if ((t.isReserve || t.turnPos >= ACTIVE_ROUND()) && t.reserveRound === b.round) return t;
    }
    return null;
  }

  function prepareReservedAction(b, r) {
    const i = b.reserveSkills.indexOf(r); if (i >= 0) b.reserveSkills.splice(i, 1);
    b.s.executingReserved = r;
    const turn = reserveTurn(b, r);
    r.owner.reserveSkillList.unshift({ aid: rAid(r), skillKey: r.skillKey, targetGridPos: r.targetGridPos === undefined ? 255 : r.targetGridPos, targetAid: rTargetAid(r), reserve: r });
    return turn;
  }

  // ------------------------------------------------------------------ coBattleAI: one tick. Returns an action record or null.
  function battleAI(b) {
    const s = b.s;
    if (monsters(b).length === 0) { endRound(b); return null; }
    if (characters(b).length === 0) { finish(b, 'lose', 'all PCs dead'); return null; }
    let actionTurn = null;
    if (s.moveFollowup) {
      const next = s.moveFollowup;
      if (!alive(next.creature) || !(b.hooks && b.hooks.actAfterMove && b.hooks.actAfterMove())) s.moveFollowup = null;
      else {
        if (!next.prepared) {
          next.prepared = true;
          next.creature.reserveSkillList.length = 0;
          if (isPC(next.creature) && LOSim.ai.autoCharacter) LOSim.ai.autoCharacter(b, next.creature);
          s.confirmed = next;
          if (b.hooks.beforeAction && b.hooks.beforeAction(b, next)) { s.phase = 'input'; return null; }
        }
        actionTurn = next; s.moveFollowup = null; s.lastActionTurn = next;
      }
    }
    // ExtraAction region: counter / chain(assist) decided by combat.execute (res.extraActions) run as their own actions
    if (s.extraQueue && s.extraQueue.length) {
      const x = s.extraQueue.shift();
      if (x.unit && alive(x.unit)) { b.actionCount++; return doExtraAction(b, x); }
    }
    if (!actionTurn && (s.apOwner || s.executingReserved) && !s.doubleActionTurn) {
      if (!s.ownerTurnEndApplied && s.apOwner) {
        creatureTurnTrigger(b, s.apOwner, false);
        creatureTurnEndDurations(b, s.apOwner);
        s.ownerTurnEndApplied = true;
      }
      if (s.executingReserved) s.executingReserved = null;
      for (const r of b.reserveSkills) if (r.delayChargeCount === 0) r.isTurnEndReady = true;
      const te = b.reserveSkills.find((r) => r.delayChargeCount === 0 && isReady(r) && r.owner && alive(r.owner));
      if (te) {
        actionTurn = prepareReservedAction(b, te);
        s.lastActionTurn = actionTurn;
      } else {
        if (s.apOwner) resetActionPoint(s.apOwner, b);
        s.apOwner = null; s.ownerTurnEndApplied = false;
        onChangeRound(b);
        return null;
      }
    }
    let guard = 0;
    while (!actionTurn) {
      if (++guard > 50) { finish(b, 'stuck', 'coBattleAI: CalcNewTurn keeps returning a turn whose actor cannot act (client infinite loop)'); return null; }
      if (s.doubleActionTurn && s.doubleActionTurn.creature && b.actualKey !== WAIT() && b.actualKey !== MOVE()) {
        actionTurn = s.doubleActionTurn;
        actionTurn.creature.reserveSkillList.unshift(s.doubleActionSel);
        s.doubleActionTurn = null; s.doubleActionSel = null;
      } else {
        actionTurn = calcNewTurn(b);
        if (!actionTurn) break;
        const a = actionTurn.creature;
        if (a && actionTurn.isReserve) actionTurn = prepareReservedAction(b, actionTurn.reserve);
        else if (!a || !alive(a) || a.turnPos < ACTIVE_ROUND()) { actionTurn = null; continue; }
      }
      if (actionTurn) {
        s.lastActionTurn = actionTurn;
        const a = actionTurn.creature;
        if (!actionTurn.isReserve && a && a.reserveSkillList.length > 0) {
          const d = a.reserveSkillList[0];
          const ds = d && LOSim.ai && LOSim.ai.skillByKey ? LOSim.ai.skillByKey(a, d.skillKey) : null;
          if (d && ds && has(a, 'STAGE_DOUBLE_ATTACK_RATIO')) {
            const slot = LOSim.num(ds.table, 'SkillSlotType');
            if (slot === 1 || slot === 2) {
              s.doubleActionTurn = Object.assign({}, actionTurn, { isDouble: 1 });
              s.doubleActionSel = d;
            }
          }
        }
      }
    }
    b.actionCount++;
    if (actionTurn) {
      const a = actionTurn.creature;
      if (!s.apOwner && !actionTurn.isReserve && !actionTurn.isDouble) {
        s.apOwner = a;
        for (const u of b.units) if (u !== a) cancelActionPointCycle(u);
        beginActionPointCycle(a);
      }
      const rec = doTurnAction(b, a, actionTurn);
      if (rec.kind === 'wait' && alive(a) && b.hooks && b.hooks.waitHeal && b.hooks.waitHeal()) {
        const count = a.flags.waitHealCount || 0;
        const rates = [0.2, 0.15, 0.1, 0.05, 0.025, 0.0125, 0.01];
        const rate = count < rates.length ? rates[count] : 0.01 * Math.pow(0.5, count - 6);
        const healed = Math.max(0, Math.min(Math.trunc(a.maxHp * rate), a.maxHp - a.hp));
        a.flags.waitHealCount = count + 1;
        a.flags.waitApExhausted = true;
        a.hp += healed; a.stats.healDone += healed;
        if (healed > 0) log(b, 'heal', { src: uref(a), dst: uref(a), amount: healed, hp: a.hp });
        rec.waitHeal = healed;
        rec.waitHealRate = rate;
      }
      if (rec.kind === 'move' && !actionTurn.isReserve && !actionTurn.isDouble && !actionTurn.isMoveFollowup && b.hooks && b.hooks.actAfterMove && b.hooks.actAfterMove()) {
        s.moveFollowup = Object.assign({}, actionTurn, { isMoveFollowup: true, prepared: false });
      }
      // 스킬 소모 행동력을 100점 기준 트랙 단위로 환산해 턴 종료 후 출발점을 정한다.
      if (!actionTurn.isReserve && !actionTurn.isDouble && rec.kind === 'skill') {
        const used = LOSim.ai.skillByKey(a, rec.skill);
        const cost = used ? LOSim.num(used.levelTable, 'NeedActionPoint') : 10;
        a.flags.apReturnBase = Math.max(0, Math.min(ACTIVE_ROUND(), ACTIVE_ROUND() - cost * 10));
      }
      return rec;
    }
    onChangeRound(b);
    return null;
  }

  // ------------------------------------------------------------------ Creature.DoTurnAction (+ Enemy/Summon overrides)
  function doTurnAction(b, a, turn, depth) {
    depth = depth || 0;
    const AI = LOSim.ai || {};
    const isReserve = !!turn.isReserve, isDouble = !!turn.isDouble;
    if ((isMob(a) || isSum(a)) && AI.runAI && !a.inert) { // inert (customWaves dummy): no AI -> Wait
      if (!isReserve || isSum(a)) AI.runAI(b, a); // Enemy: AI() unless counter/assist/reserve; Summon: unless counter/assist
      if (isMob(a) && isReserve && a.reserveSkillList.length === 0 && turn.reserve) {
        const r = turn.reserve;
        a.reserveSkillList.push({ aid: rAid(r), skillKey: r.skillKey, targetGridPos: r.targetGridPos === undefined ? 255 : r.targetGridPos, targetAid: rTargetAid(r), reserve: r });
      }
      if (a.reserveSkillList.length === 0) AI.runAI(b, a);
    }
    a.turnInfo = { reserveRound: turn.reserveRound, turnPos: turn.turnPos, isReserve: isReserve ? 1 : 0 };
    a.flags.reserveDistance = isReserve && turn.reserve ? turn.reserve.distance : undefined;
    const ownerTurnSkillUse = !isReserve && !isDouble;
    if (!alive(a)) return { type: 'noop', reason: 'actor dead' };
    if (a.reserveSkillList.length === 0) a.reserveSkillList.push({ aid: a.aid, skillKey: WAIT(), targetAid: 0, targetGridPos: 0, missing: true });
    const sel = a.reserveSkillList.shift();
    a.lastSkillInfo = sel;
    if (!sel.skillKey) sel.skillKey = WAIT();
    if (turn.isMoveFollowup && sel.skillKey === MOVE()) sel.skillKey = WAIT();
    let skill = null;
    if (ownerTurnSkillUse && sel.skillKey !== WAIT() && sel.skillKey !== MOVE()) {
      const ss = AI.skillByKey ? AI.skillByKey(a, sel.skillKey) : null;
      if (ss && ss.cooldownLeft > 0) { sel.skillKey = WAIT(); sel.cooldownBlocked = true; }
    }
    let main = null;
    const viaCombat = !!(LOSim.combat && LOSim.combat.execute);
    if (sel.skillKey !== WAIT() && sel.skillKey !== MOVE()) {
      skill = AI.skillByKey ? AI.skillByKey(a, sel.skillKey) : null;
      if (!skill && sel.reserve && LOSim.combat && LOSim.combat.findSkill) skill = LOSim.combat.findSkill(a, sel.skillKey, sel.reserve.skillLevel); // delay skill key
      if (viaCombat && skill) {
        // combat.execute owns: cooldown->Wait, no-target retarget/slot swap, SEAL->Wait, StartCooldown (Creature.cs 1844-2210)
        main = AI.getCreature ? AI.getCreature(b, sel.targetAid) : null;
      } else if (!skill) {
        // transformed creature: fall back to the same slot (simplified), else re-run AI and retry (C# recursion)
        if (depth < 3 && AI.runAI) { AI.runAI(b, a); return doTurnAction(b, a, turn, depth + 1); }
        sel.skillKey = WAIT();
      } else {
        main = AI.getCreature ? AI.getCreature(b, sel.targetAid) : null;
        let n = 1;
        if (LOSim.combat && LOSim.combat.targets) n = (LOSim.combat.targets(b, a, skill, { target: main, gridPos: sel.targetGridPos }) || []).length;
        if (n === 0 && AI.retargetRandom) {
          if (!AI.retargetRandom(b, sel, a, skill)) {
            const other = AI.skillBySlot(a, LOSim.num(skill.table, 'SkillSlotType') === 1 ? 2 : 1);
            if (other) { skill = other; sel.skillKey = other.key; }
            if (!other || !AI.retargetRandom(b, sel, a, skill)) sel.skillKey = WAIT();
          }
          main = AI.getCreature(b, sel.targetAid);
        }
      }
    }
    if (!viaCombat && has(a, 'STAGE_SEAL_SKILL') && !isReserve && sel.skillKey !== WAIT() && sel.skillKey !== MOVE()) sel.skillKey = WAIT();

    const rec = { type: 'action', round: b.round, wave: b.waveIndex + 1, actor: uref(a), ap: a.turnPos,
      turnType: isReserve ? 'reserve' : isDouble ? 'double' : 'normal', kind: null, skill: null, target: null, gridPos: sel.targetGridPos };
    if (sel.skillKey === MOVE()) {
      const occ = live(b).some((u) => (isPC(u) || (isSum(u) && u.team === 1)) === (isPC(a) || (isSum(a) && a.team === 1)) && u.gridPos === sel.targetGridPos);
      if (has(a, 'STAGE_SNARE') || occ) sel.skillKey = WAIT();
      else {
        rec.kind = 'move'; rec.from = a.gridPos; a.gridPos = sel.targetGridPos; a.oriGridPos = a.gridPos; rec.to = a.gridPos;
        fire(b, TR.MOVE, { owner: a });
        if (LOSim.buffs && LOSim.buffs.updateAll) LOSim.buffs.updateAll(b);
      }
    }
    if (sel.skillKey !== WAIT() && sel.skillKey !== MOVE()) {
      if (a.turnPos >= ACTIVE_ROUND() || isReserve || isDouble) {
        rec.kind = 'skill'; rec.skill = skill.key; rec.slot = LOSim.num(skill.table, 'SkillSlotType');
        rec.target = uref(main);
        b.actualKey = sel.skillKey;
        if (viaCombat) {
          const mt = sel.reserve ? (sel.reserve.targetUnit && alive(sel.reserve.targetUnit) ? sel.reserve.targetUnit : { gridPos: sel.reserve.targetGridPos }) : { target: main, gridPos: sel.targetGridPos };
          const res = LOSim.combat.execute(b, a, skill, mt,
            { gridPos: sel.targetGridPos, isReserve, isDoubleAction: isDouble, reserve: sel.reserve || null });
          afterExecute(b, a, res, rec);
        } else {
          if (ownerTurnSkillUse) startCooldown(skill, b);
          a.stats.actions++;
          a.stats.skillUse[skill.key] = (a.stats.skillUse[skill.key] || 0) + 1;
        }
        log(b, 'action', rec);
        return rec;
      }
      sel.skillKey = WAIT();
    }
    if (sel.skillKey === WAIT()) {
      rec.kind = 'wait'; if (sel.cooldownBlocked) rec.reason = 'cooldown'; if (sel.missing) rec.reason = 'no reserved skill';
      fire(b, TR.WAIT, { owner: a });
    }
    b.actualKey = sel.skillKey;
    a.stats.actions++;
    log(b, 'action', rec);
    return rec;
  }
  // bookkeeping after combat.execute: actual skill key (double action / wait quirks), IsbeAttacked/AttackerAID, derived actions
  function afterExecute(b, a, res, rec) {
    if (!res) return;
    rec.result = summarize(res);
    if (res.waited || !res.ok) { b.actualKey = res.ok ? res.skillKey : WAIT(); if (res.waited) { rec.kind = 'wait'; rec.reason = res.skipped || 'wait'; } }
    else { b.actualKey = res.skillKey; if (res.skillKey !== rec.skill) rec.skill = res.skillKey; }
    for (const h of res.hits || []) {
      const t = h && h.target;
      if (!t || h.miss) continue;
      if (h.damage !== 0 || h.shield) { t.flags = t.flags || {}; t.flags.beAttacked = true; t.flags.attackerAid = a.aid; } // Creature.DoDamage 672 / BattleManager 2315
    }
    // one derived action per action (counter OR chain/assist); none after a counter/assist (combat returns [])
    if (res.extraActions && res.extraActions.length) (b.s.extraQueue = b.s.extraQueue || []).push(res.extraActions[0]);
  }
  // counter (Counterattack) / assist (AssistTurnInfo) derived action
  function doExtraAction(b, x) {
    const a = x.unit;
    const isCounter = x.type === 'counter';
    const rec = { type: 'action', round: b.round, wave: b.waveIndex + 1, actor: uref(a), ap: a.turnPos, turnType: x.type,
      kind: 'skill', skill: x.skill && x.skill.key, target: uref(x.target), gridPos: x.gridPos };
    b.s.lastActionTurn = { aid: a.aid, creature: a, isCounter, isAssist: !isCounter };
    const res = LOSim.combat.execute(b, a, x.skill, { target: x.target, gridPos: x.gridPos === undefined ? (x.target ? x.target.gridPos : 255) : x.gridPos },
      { isCounter, isAssist: !isCounter, counterBuff: x.counterBuff || null, assistFrom: x.from, assistFromSkillKey: x.fromSkillKey, gridPos: x.gridPos });
    const keep = b.actualKey;
    afterExecute(b, a, res, rec);
    b.actualKey = keep; // ActualActionSkillKey belongs to the main action for the double-action check
    log(b, 'action', rec);
    return rec;
  }
  function summarize(res) {
    if (!res || typeof res !== 'object') return res;
    const o = {};
    for (const k of Object.keys(res)) { const v = res[k]; if (v === null || typeof v !== 'object') o[k] = v; else if (Array.isArray(v)) o[k] = v.length; }
    return o;
  }

  // ------------------------------------------------------------------ wave end (coEndRound)
  function endRound(b) {
    const pcs = characters(b);
    if (pcs.length > 0) b.clearWave++;
    b.reserveSkills.length = 0; // ClearReserveRoundSkill
    lastActionTurnInit(b);
    for (const u of b.units) if (isSum(u) && !u.removed) removeUnit(b, u); // summons collected
    if (b.clearWave >= b.maxWave && pcs.length > 0) { finish(b, 'win', 'all ' + b.maxWave + ' waves cleared'); return; }
    if (characters(b).length === 0) { finish(b, 'lose', 'all PCs dead'); return; }
    if (LOSim.buffs && LOSim.buffs.onWaveEnd) LOSim.buffs.onWaveEnd(b); // RemoveBuffAll + AFTER_WAVE
    else for (const u of b.units) { u.buffs = []; }
    for (const u of live(b)) recalc(b, u);
    b.s.phase = 'nextWave';
  }

  // diagnostics for 'timeout': a stalemate (actions happen, nothing changes) vs. a slow battle
  function stalemateHint(b) {
    const idle = b.totalActions - (b.lastHpChangeAt || 0);
    if (idle < 50) return '';
    const stopped = live(b).filter((u) => has(u, 'STAGE_AP_STOP')).map((u) => u.key + '@' + u.gridPos);
    return '; stalemate: no HP change in the last ' + idle + ' actions' + (stopped.length ? '; permanently AP_STOP (never gets a turn, so its turn-based AP_STOP never ticks down): ' + stopped.join(', ') : '');
  }

  function finish(b, outcome, reason) {
    if (b.result) return;
    b.result = outcome; b.resultReason = reason; b.s.phase = 'ended';
    log(b, 'end', { outcome, reason });
  }

  // ------------------------------------------------------------------ step / run
  // step(battle): advance until exactly one unit action executes (or the battle ends). Returns a compact record.
  B.step = function (b) {
    if (b.result) return { type: 'end', outcome: b.result, reason: b.resultReason };
    let ctx = { phase: b.s.phase };
    try {
      for (let spin = 0; spin < 10000; spin++) {
        if (b.result) return { type: 'end', outcome: b.result, reason: b.resultReason };
        if (b.totalActions >= b.maxActions) { finish(b, 'timeout', 'maxActions ' + b.maxActions + ' reached' + stalemateHint(b)); continue; }
        const ph = b.s.phase;
        ctx = { phase: ph, round: b.round, wave: b.waveIndex + 1 };
        if (ph === 'init' || ph === 'nextWave') {
          if (b.waveIndex + 1 >= b.waves.length) { finish(b, 'win', 'no more waves'); continue; }
          beginWave(b);
        } else if (ph === 'nextRound') {
          nextRound(b);
        } else if (ph === 'input') {
          // waiting for the UI (see battleStart hook); the confirmed turn's actor is about to act
          const c = b.s.confirmed;
          return { type: 'input', round: b.round, wave: b.waveIndex + 1, turn: c, actor: c && c.creature ? uref(c.creature) : null, unit: c && c.creature };
        } else if (ph === 'ai') {
          const rec = battleAI(b);
          if (rec && rec.type === 'action') {
            b.totalActions++; b.s.actionsThisRound++;
            const hpSig = live(b).map((u) => u.aid + ':' + u.hp).join(',');
            if (hpSig !== b._hpSig) { b._hpSig = hpSig; b.lastHpChangeAt = b.totalActions; }
            if (b.s.actionsThisRound > b.maxActionsPerRound) finish(b, 'stuck', 'round ' + b.round + ' never ends: ' + b.s.actionsThisRound + ' actions without a round change (last actor ' + rec.actor.key + ')');
            return rec;
          }
        } else throw new Error('bad phase ' + ph);
      }
      finish(b, 'stuck', 'battle loop made no progress (10000 internal steps without an action)');
      return { type: 'end', outcome: b.result, reason: b.resultReason };
    } catch (e) {
      const act = b.s.lastActionTurn && b.s.lastActionTurn.creature;
      b.errors.push({ msg: String(e && e.message), stack: e && e.stack, luaLoadError: !!(e && e.luaLoadError), aiKey: e && e.aiKey,
        context: Object.assign(ctx, { totalActions: b.totalActions, actor: uref(act) }) });
      finish(b, 'error', String(e && e.message));
      return { type: 'end', outcome: b.result, reason: b.resultReason };
    }
  };

  B.result = function (b) {
    const pcs = b.allUnits.filter(isPC);
    const hpNow = pcs.reduce((a, u) => a + Math.max(0, u.hp), 0), hpMax = pcs.reduce((a, u) => a + (u.maxHp || 0), 0);
    const r = {
      outcome: b.result || 'running', reason: b.resultReason || '',
      waveReached: b.waveIndex + 1, wavesCleared: b.clearWave, maxWave: b.maxWave,
      totalActions: b.totalActions, rounds: b.totalRounds,
      survivors: pcs.filter(alive).map((u) => u.key),
      hpLeftPct: hpMax > 0 ? Math.round((hpNow / hpMax) * 1000) / 10 : 0,
      perUnit: b.allUnits.map((u) => ({ key: u.key, name: u.name, team: u.team, dmgDealt: u.stats.dmgDealt, dmgTaken: u.stats.dmgTaken,
        healDone: u.stats.healDone, kills: u.stats.kills, actions: u.stats.actions, alive: alive(u) })),
      waves: b.waves.map((w) => w.groupKey),
      // combat.js counters for code paths where the real client throws (e.g. counter_null = NullReference in coBattleAI)
      clientCrashCandidates: Object.assign({}, b.counters || {}),
      errors: b.errors, luaErrors: b.luaErrors,
    };
    if (b.setup && b.setup.options && b.setup.options.timeline) r.apTime = b.apTime; // opt-in (combo analysis)
    return r;
  };

  B.run = function (b, opts) {
    if (opts && opts.maxActions) b.maxActions = opts.maxActions;
    while (!b.result) B.step(b);
    return B.result(b);
  };
})();
