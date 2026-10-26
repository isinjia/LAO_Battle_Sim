// LOSim.combo -- team composition ("조합") analysis: benchmarks, per-battle metrics, aggregation and the search.
// Pure logic shared by combo-worker.js (browser Web Worker), combo.js (main page: reports) and tools/combo_node.js.
// Needs LOSim (engine) for evaluation; the report/ranking helpers only need plain objects.
//
// Time unit: "기준 턴" (reference turn) = 25 AP time = the time a TurnSpeed-4 unit needs to fill 100 AP once.
// battle.apTime (engine/battle.js) sums every AP advance, so damage / apTime is a speed-aware DPS.
(function () {
  const LOSim = (typeof window !== 'undefined' ? window : globalThis).LOSim = (typeof window !== 'undefined' ? window : globalThis).LOSim || {};
  const C = (LOSim.combo = LOSim.combo || {});
  const num = (r, k, d) => LOSim.num(r, k, d), str = (r, k, d) => LOSim.str(r, k, d);

  C.REF_SPEED = 4;
  C.REF_TURN = 100 / C.REF_SPEED; // 25 AP time
  C.LAYOUTS = {
    single: { label: '단일 (전열 중앙 1기)', cells: [3] },
    f3: { label: '전열 3기', cells: [0, 3, 6] },
    f3m2: { label: '전열 3 + 중열 2 (5기)', cells: [0, 3, 6, 1, 7] },
    x5: { label: 'X자 분산 (5기)', cells: [0, 6, 4, 2, 8] },
    full9: { label: '9칸 전부 (광역 최대치)', cells: [0, 1, 2, 3, 4, 5, 6, 7, 8] },
  };
  C.OBJ = {
    dps: { label: '지속 DPS', bench: 'dummy', metric: 'dps', unit: '피해/기준턴' },
    burst: { label: '순간 화력', bench: 'dummy', metric: 'burst', unit: '개전 피해' },
    survival: { label: '생존 (불사)', bench: 'endurance', metric: 'survival', unit: '생존 점수' },
    clear: { label: '스테이지 클리어', bench: 'stage', metric: 'clear', unit: '클리어 점수' },
    balanced: { label: '종합', bench: null, metric: 'balanced', unit: '종합 지수' },
  };
  C.DEFAULTS = {
    objectives: ['dps', 'burst', 'survival'],
    assume: { grade: 'max', level: 100, skillLevel: 10 },
    dummy: { key: 'MOB_MP_TrainingDummy_N', level: 100, layout: 'f3m2', hpMul: 10, immortal: 1000, turns: 20, burstTurns: 3, regen: true },
    endurance: { stageKey: 'Ch11Stage08', mode: 'stage', wave: 'last', hpMul: 1000, atkMul: 1, regen: true, turns: 30 },
    stage: { stageKey: 'Ch11Stage08', mode: 'stage', maxTurns: 120 },
    weights: { dps: 1, burst: 0.5, survival: 1, clear: 0 },
    seeds: 3, verifySeeds: 20, budget: 600, shortlist: 28, baseSeed: 1000, verifyTop: 10,
    pool: { include: [], exclude: [], search: '' }, locked: [],
  };
  C.ROLE_KO = ['탱커', '딜러', '서포터'];
  C.CLASS_KO = ['경장', '중장', '기동'];

  // ------------------------------------------------------------------ pool / specs / formation
  C.pcPool = function () {
    const T = LOSim.T('Table_PC') || {};
    return Object.values(T).filter((p) => num(p, 'IsUse') === 1 && num(p, 'IsHavingTurn') === 1)
      .map((p) => ({ key: p.Key, name: LOSim.name(p.Name, p.Key), startGrade: num(p, 'StartGrade', 1), maxGrade: num(p, 'MaxGrade', 5), cls: num(p, 'ActorClassType'), role: num(p, 'RoleType') }))
      .filter((p) => !/Dummy|Test/i.test(p.key) && !/더미|테스트/.test(p.name))
      .sort((a, b) => a.key < b.key ? -1 : 1);
  };
  C.filterPool = function (pool, f) {
    f = f || {};
    const inc = new Set(f.include || []), exc = new Set(f.exclude || []);
    const q = (f.search || '').trim().toLowerCase();
    return pool.filter((p) => !exc.has(p.key) && (!inc.size || inc.has(p.key)) &&
      (!q || q.split(/[\s,]+/).filter(Boolean).some((t) => p.key.toLowerCase().includes(t) || String(p.name).toLowerCase().includes(t))) &&
      (f.roles == null || !f.roles.length || f.roles.includes(p.role)));
  };
  C.makeSpec = function (key, gridPos, assume) {
    assume = assume || C.DEFAULTS.assume;
    const pc = LOSim.T('Table_PC', key);
    const sg = num(pc, 'StartGrade', 1), mg = num(pc, 'MaxGrade', 5);
    let grade = assume.grade === 'max' ? mg : assume.grade === 'start' ? sg : Math.max(sg, Math.min(mg, +assume.grade || mg));
    const def = (LOSim.stats && LOSim.stats.defaultSpec && LOSim.stats.defaultSpec(key)) || { skillLevels: [] };
    return { key, gridPos, grade, level: +assume.level || 100, skillLevels: def.skillLevels.map(() => +assume.skillLevel || 1), equips: [] };
  };
  // PC cell (column from the front): gridPos 2/5/8 = front (0), 1/4/7 = mid (1), 0/3/6 = back (2)
  C.cellOf = (gp) => (8 - gp) % 3;
  C.rowOf = (gp) => Math.floor(gp / 3);
  const colCells = (col) => [2 - col + 3, 2 - col, 2 - col + 6]; // middle row first, then top, then bottom
  const prefCache = {};
  // preferred column: tank front; supporter back; dealer as far back as its longest active skill still reaches the enemy mid line
  C.prefCol = function (key) {
    if (prefCache[key] !== undefined) return prefCache[key];
    const pc = LOSim.T('Table_PC', key);
    const role = num(pc, 'RoleType');
    let col;
    if (role === 0) col = 0;
    else if (role === 2) col = 2;
    else {
      let d = 0;
      const g = LOSim.T('Table_SkillGroup', str(pc, 'SkillGroupIndex'));
      for (let i = 1; i <= 2; i++) {
        const sk = str(g, 'SkillIndex' + i);
        const lt = sk && (LOSim.T('Table_SkillLevel', sk + '_Lv10') || LOSim.T('Table_SkillLevel', sk + '_Lv1'));
        d = Math.max(d, num(lt, 'Distance'));
      }
      col = Math.max(0, Math.min(2, d - 2));
    }
    return (prefCache[key] = col);
  };
  // place keys on the 3x3 grid by preferred column (fixed: [{key, gridPos}] kept where they are)
  C.autoFormation = function (keys, fixed) {
    const used = new Set();
    const out = [];
    for (const f of fixed || []) { used.add(f.gridPos); out.push({ key: f.key, gridPos: f.gridPos }); }
    const rest = keys.filter((k) => !out.some((o) => o.key === k)).map((k) => ({ key: k, col: C.prefCol(k) })).sort((a, b) => a.col - b.col);
    for (const r of rest) {
      const order = r.col === 0 ? [0, 1, 2] : r.col === 2 ? [2, 1, 0] : [1, 2, 0];
      let placed = false;
      for (const col of order) {
        for (const gp of colCells(col)) if (!used.has(gp)) { used.add(gp); out.push({ key: r.key, gridPos: gp }); placed = true; break; }
        if (placed) break;
      }
    }
    return out;
  };
  C.squadKey = (sq) => sq.slice().sort((a, b) => a.gridPos - b.gridPos).map((m) => m.gridPos + ':' + m.key).join(',');
  C.memberKey = (sq) => sq.map((m) => m.key).sort().join(',');

  // ------------------------------------------------------------------ benchmarks
  function lastWaveSpawns(stageKey, mode, which) {
    const st = LOSim.T(mode === 'ew' ? 'Table_MapStageEW' : 'Table_MapStage', stageKey);
    if (!st) throw new Error('스테이지 없음: ' + stageKey);
    const cols = [];
    for (let i = 1; i <= 9; i++) if (LOSim.list(st, 'WaveMobGroup' + i).length) cols.push('WaveMobGroup' + i);
    if (LOSim.list(st, 'BossMobGroup').length) cols.push('BossMobGroup');
    if (!cols.length) throw new Error('웨이브 없음: ' + stageKey);
    const col = which === 'last' || which == null ? cols[cols.length - 1] : cols[Math.max(0, Math.min(cols.length - 1, (+which || 1) - 1))];
    const gk = LOSim.list(st, col)[0];
    const g = LOSim.T('Table_MobGroup', gk);
    if (!g) throw new Error('MobGroup 없음: ' + gk);
    const out = [];
    for (let i = 1; i <= 9; i++) { const k = str(g, 'mobIndexString' + i); if (k) out.push({ key: k, level: num(g, 'mobLevel' + i, 1), gridPos: i - 1 }); }
    return { groupKey: gk, waveCol: col, waves: cols.length, spawns: out };
  }
  // bench objects are plain JSON (sent to workers with every job)
  C.makeBench = function (kind, cfg) {
    cfg = cfg || C.DEFAULTS;
    if (kind === 'dummy') {
      const d = Object.assign({}, C.DEFAULTS.dummy, cfg.dummy);
      const cells = (C.LAYOUTS[d.layout] || C.LAYOUTS.f3m2).cells;
      const ab = LOSim.T('Table_MonsterAbility', d.key);
      const nominalHp = Math.trunc((num(ab, 'DefaultHP') + num(ab, 'DefaultHPByLevel') * (d.level - 1)) * d.hpMul);
      const imm = Math.max(1, +d.immortal || 1);
      return { id: 'dummy', kind, cfg: d, cap: d.turns * C.REF_TURN, burstCap: d.burstTurns * C.REF_TURN, regen: d.regen !== false,
        nominalHp, hpScale: imm,
        waves: [cells.map((gp) => ({ key: d.key, level: d.level, gridPos: gp, hpMul: d.hpMul * imm, inert: true }))],
        label: `허수아비 ${cells.length}기 (${(C.LAYOUTS[d.layout] || C.LAYOUTS.f3m2).label}, Lv${d.level}, 명목 HP ${nominalHp.toLocaleString('ko-KR')}, 행동 안 함·매 행동 후 HP 회복) · ${d.turns}기준턴` };
    }
    if (kind === 'endurance') {
      const e = Object.assign({}, C.DEFAULTS.endurance, cfg.endurance);
      const w = lastWaveSpawns(e.stageKey, e.mode, e.wave);
      return { id: 'endurance', kind, cfg: e, cap: e.turns * C.REF_TURN, stageKey: e.stageKey, mode: e.mode, regen: e.regen !== false,
        waves: [w.spawns.map((s) => {
          const sp = Object.assign({}, s, { hpMul: e.hpMul });
          const am = +e.atkMul || 1;
          if (am !== 1) { const ab = LOSim.T('Table_MonsterAbility', s.key); sp.ability = { AttackDmg: num(ab, 'AttackDmg') * am, AddAttackDmgByLevel: num(ab, 'AddAttackDmgByLevel') * am }; }
          return sp;
        })], groupKey: w.groupKey,
        label: `${e.stageKey} ${w.waveCol === 'BossMobGroup' ? '보스' : w.waveCol.replace('WaveMobGroup', '') + '번'} 웨이브(${w.groupKey}, ${w.spawns.length}기, HP×${e.hpMul}${(+e.atkMul || 1) !== 1 ? ', 공격력×' + e.atkMul : ''}${e.regen !== false ? ', 매 행동 후 회복 = 죽지 않음' : ''}) · ${e.turns}기준턴 버티기` };
    }
    if (kind === 'stage') {
      const s = Object.assign({}, C.DEFAULTS.stage, cfg.stage);
      return { id: 'stage', kind, cfg: s, cap: s.maxTurns * C.REF_TURN, stageKey: s.stageKey, mode: s.mode,
        label: `${s.stageKey} 실제 클리어 (최대 ${s.maxTurns}기준턴)` };
    }
    throw new Error('unknown bench ' + kind);
  };
  C.benchesFor = function (objectives) {
    const s = new Set();
    for (const o of objectives) {
      if (o === 'balanced') { s.add('dummy'); s.add('endurance'); s.add('stage'); } else s.add(C.OBJ[o].bench);
    }
    return [...s];
  };

  // ------------------------------------------------------------------ speedups (opt-in; worker / node only)
  // stats.js scans Table_GlobalValue and Table_PCPromotionBonus linearly on EVERY recalc (~35% of battle time).
  // Results are unchanged when those whole-table reads return a subset that still contains every row the engine
  // can look for (same row order): Table_GlobalValue -> rows of the types the engine queries; promotion table ->
  // rows of the PCs in the battle being run. Verified identical by tools/combo_node.js --selftest.
  C.GV_USED = ['FAVOR_MAX_EXPAND', 'FAVOR_EXPANDMAX_BONUS', 'MIN_FIRE_RESIST', 'MAX_FIRE_RESIST', 'MIN_ICE_RESIST', 'MAX_ICE_RESIST',
    'MIN_LIGHTNING_RESIST', 'MAX_LIGHTNING_RESIST', 'MAX_STAGE_SHIELD_RATIO'];
  C.installSpeedups = function () {
    if (C._origT) return;
    const origT = (C._origT = LOSim.T);
    let gvSmall = null;
    const promoCache = new Map();
    LOSim.T = function (table, key) {
      if (key === undefined) {
        if (table === 'Table_GlobalValue') {
          if (!gvSmall) {
            const types = new Set(C.GV_USED.map((n) => LOSim.E.GLOBAL_VALUE_TYPE[n]).filter((x) => x !== undefined));
            const full = origT(table) || {};
            gvSmall = {};
            for (const k in full) if (types.has(num(full[k], 'Type'))) gvSmall[k] = full[k];
          }
          return gvSmall;
        }
        if (table === 'Table_PCPromotionBonus' && C._promoKeys) {
          const ck = C._promoKeys;
          let t = promoCache.get(ck);
          if (!t) {
            const want = new Set(ck.split(','));
            const full = origT(table) || {};
            t = {};
            for (const k in full) if (want.has(full[k].Promotion_PCKey)) t[k] = full[k];
            if (promoCache.size > 5000) promoCache.clear();
            promoCache.set(ck, t);
          }
          return t;
        }
      }
      return origT(table, key);
    };
  };
  C.removeSpeedups = function () { if (C._origT) { LOSim.T = C._origT; C._origT = null; } };

  // damage tap: LOSim.log wrapper that reports damage records of battles that set b._tap (no storage, no effect otherwise)
  C.PCT_HP_BUFFS = new Set(['RATIO_DMG_TARGET_MAX_HP', 'RATIO_DMG_TARGET_CURRENT_HP']);
  function installTap() {
    if (LOSim.log && LOSim.log._comboTap) return;
    const orig = LOSim.log;
    const w = function (b, type, data) { if (b && b._tap && (type === 'damage' || type === 'dot')) b._tap(data); return orig(b, type, data); };
    w._comboTap = true;
    LOSim.log = w;
  }

  // ------------------------------------------------------------------ one battle -> metrics
  C.runOne = function (squad, bench, seed, assume) {
    if (C._origT) C._promoKeys = squad.map((m) => m.key).sort().join(',');
    try { return runOne(squad, bench, seed, assume); } finally { C._promoKeys = null; }
  };
  function runOne(squad, bench, seed, assume) {
    const B = LOSim.battle;
    const specs = squad.map((m) => C.makeSpec(m.key, m.gridPos, assume));
    const setup = { stageKey: bench.stageKey || '', mode: bench.mode || 'stage', squad: specs, seed,
      options: { maxActions: bench.kind === 'stage' ? 6000 : 4000, timeline: true } };
    if (bench.waves) setup.customWaves = bench.waves;
    const b = B.create(setup);
    const out = { seed, outcome: 'running', t: 0, dmg: 0, burst: 0, maxHit: 0, maxHitBy: '', squadActs: 0, deaths: 0, firstDeath: null, hpLeftPct: 0, win: 0, wavesCleared: 0, maxWave: b.maxWave || 0, dummyKilled: 0, pctHpAdj: 0, maxStack: 0, maxStackKey: '', members: [], err: '' };
    if (b.result === 'error') { out.outcome = 'error'; out.err = b.resultReason; return out; }
    // immortal dummies: "% of target HP" damage is rescaled to the nominal HP (actual HP = nominal x hpScale)
    let adj = 0;
    if (bench.hpScale > 1) {
      installTap();
      const k = 1 - 1 / bench.hpScale;
      b._tap = (d) => { if (d && d.dst && d.dst.team === 0 && C.PCT_HP_BUFFS.has(d.buff) && d.dmg > 0) adj += d.dmg * k; };
    }
    const pcs = () => b.allUnits.filter((u) => u.type === 'CHARACTER');
    const enemyTaken = () => { let s = 0; for (const u of b.allUnits) if (u.team === 0) s += u.stats.dmgTaken; return s - adj; };
    // diagnostic: most instances of one buff key on one squad member (runaway stacking shows up here)
    const stackCheck = () => {
      for (const u of b.units) {
        if (u.team !== 1 || !u.buffs || u.buffs.length < 8 || u.buffs.length <= out.maxStack) continue;
        const c = new Map();
        for (const x of u.buffs) { const n = (c.get(x.key) || 0) + 1; c.set(x.key, n); if (n > out.maxStack) { out.maxStack = n; out.maxStackKey = u.key + ' ' + x.key; } }
      }
    };
    const deathAt = new Map();
    let prev = 0;
    while (!b.result && b.apTime < bench.cap) {
      const rec = B.step(b);
      if (!rec || rec.type !== 'action') continue;
      const d = enemyTaken(), delta = d - prev; prev = d;
      if (rec.actor && rec.actor.team === 1) {
        out.squadActs++;
        if (delta > out.maxHit) { out.maxHit = delta; out.maxHitBy = rec.actor.key + (rec.skill ? ' ' + rec.skill : ''); }
      }
      if (bench.burstCap && b.apTime <= bench.burstCap) out.burst = d;
      for (const u of pcs()) if (u.hp <= 0 && !deathAt.has(u)) deathAt.set(u, b.apTime);
      if (bench.regen) for (const u of b.units) if (u.team === 0 && u.hp > 0) u.hp = u.maxHp;
      stackCheck();
    }
    for (const u of pcs()) if (u.hp <= 0 && !deathAt.has(u)) deathAt.set(u, b.apTime);
    out.outcome = b.result || 'cap';
    out.err = b.result === 'error' || b.result === 'stuck' ? String(b.resultReason || '').slice(0, 200) : '';
    out.t = b.apTime;
    out.dmg = enemyTaken(); out.pctHpAdj = adj;
    if (bench.burstCap && b.apTime <= bench.burstCap) out.burst = out.dmg; // battle ended inside the window
    out.win = b.result === 'win' ? 1 : 0;
    out.wavesCleared = b.clearWave; out.maxWave = b.maxWave;
    if (bench.kind === 'dummy' && b.result === 'win') out.dummyKilled = 1;
    const list = pcs();
    let hp = 0, mhp = 0;
    for (const u of list) {
      hp += Math.max(0, u.hp); mhp += u.maxHp || 0;
      const sums = b.allUnits.filter((s) => s.type === 'SUMMON' && s.owner === u);
      out.members.push({ key: u.key, dmg: u.stats.dmgDealt + sums.reduce((a, s) => a + s.stats.dmgDealt, 0), heal: u.stats.healDone, taken: u.stats.dmgTaken,
        actions: u.stats.actions, dead: deathAt.has(u) ? 1 : 0, deathT: deathAt.has(u) ? deathAt.get(u) : null });
    }
    out.deaths = deathAt.size;
    out.firstDeath = deathAt.size ? Math.min(...deathAt.values()) : null;
    out.hpLeftPct = mhp ? (100 * hp) / mhp : 0;
    return out;
  }
  // per-run objective scores (documented in the UI "점수 정의")
  C.scoreRun = function (r, bench) {
    const turns = Math.max(r.t, 1e-9) / C.REF_TURN;
    const s = {};
    if (bench.kind === 'dummy') {
      s.dps = r.dmg / Math.max(turns, 1e-9);
      s.burst = r.burst;
      s.perAct = r.squadActs ? r.dmg / r.squadActs : 0;
      s.maxHit = r.maxHit;
    }
    if (bench.kind === 'endurance') {
      const cap = bench.cap;
      const n = r.members.length || 1;
      // a win (all enemies dead despite the HP multiplier) means everyone alive survived the whole window
      const alive = r.members.reduce((a, m) => a + (m.dead ? Math.min(m.deathT, cap) / cap : 1), 0) / n;
      s.survival = 70 * alive + 20 * (r.deaths === 0 ? 1 : 0) + 10 * (r.hpLeftPct / 100);
      s.aliveFrac = alive; s.deaths = r.deaths; s.zeroDeath = r.deaths === 0 ? 1 : 0;
      s.firstDeathTurns = r.firstDeath == null ? null : r.firstDeath / C.REF_TURN;
      s.hpLeft = r.hpLeftPct;
    }
    if (bench.kind === 'stage') {
      s.clear = r.win ? Math.max(10, 100 - turns) : (10 * r.wavesCleared) / Math.max(1, r.maxWave);
      s.win = r.win; s.clearTurns = r.win ? turns : null; s.deaths = r.deaths; s.hpLeft = r.hpLeftPct;
    }
    return s;
  };
  function stat(vals) {
    const v = vals.filter((x) => x != null && Number.isFinite(x));
    const n = v.length;
    if (!n) return { mean: null, sd: 0, se: 0, min: null, max: null, n: 0 };
    const mean = v.reduce((a, b) => a + b, 0) / n;
    const sd = n > 1 ? Math.sqrt(v.reduce((a, b) => a + (b - mean) * (b - mean), 0) / (n - 1)) : 0;
    return { mean, sd, se: sd / Math.sqrt(n), min: Math.min(...v), max: Math.max(...v), n, vals: n <= 64 ? v.map((x) => Math.round(x * 1000) / 1000) : undefined };
  }
  C.stat = stat;
  // evaluate one job in-process: {squad, bench, seeds:[...], assume}
  C.evaluate = function (job) {
    if (job.raw) return { raw: true, runs: job.seeds.map((sd) => { try { return C.runOne(job.squad, job.bench, sd, job.assume); } catch (e) { return { seed: sd, outcome: 'error', err: String(e && e.message || e).slice(0, 200), t: 0, dmg: 0, burst: 0, maxHit: 0, squadActs: 0, deaths: 5, members: [], hpLeftPct: 0, win: 0, wavesCleared: 0, maxWave: 1 }; } }) };
    const runs = job.seeds.map((sd) => {
      try { return C.runOne(job.squad, job.bench, sd, job.assume); }
      catch (e) { return { seed: sd, outcome: 'error', err: String(e && e.message || e).slice(0, 200), t: 0, dmg: 0, burst: 0, maxHit: 0, squadActs: 0, deaths: 5, members: [], hpLeftPct: 0, win: 0, wavesCleared: 0, maxWave: 1 }; }
    });
    return C.aggregate(job, runs);
  };
  C.aggregate = function (job, runs) {
    const sc = runs.map((r) => C.scoreRun(r, job.bench));
    const keys = new Set(); for (const s of sc) for (const k of Object.keys(s)) keys.add(k);
    const m = {};
    for (const k of keys) m[k] = stat(sc.map((s) => s[k]));
    const mem = {};
    for (const r of runs) for (const x of r.members) {
      const a = mem[x.key] || (mem[x.key] = { key: x.key, dmg: 0, heal: 0, taken: 0, actions: 0, deaths: 0, n: 0 });
      a.dmg += x.dmg; a.heal += x.heal; a.taken += x.taken; a.actions += x.actions; a.deaths += x.dead; a.n++;
    }
    const members = Object.values(mem).map((a) => ({ key: a.key, dmg: a.dmg / a.n, heal: a.heal / a.n, taken: a.taken / a.n, actions: a.actions / a.n, deathRate: a.deaths / a.n }));
    const outcomes = {}; for (const r of runs) outcomes[r.outcome] = (outcomes[r.outcome] || 0) + 1;
    const errs = runs.filter((r) => r.err).map((r) => r.err);
    const best = runs.reduce((a, r) => (r.maxHit > (a ? a.maxHit : -1) ? r : a), null);
    return { squad: job.squad, benchId: job.bench.id, n: runs.length, m, members, outcomes, errors: errs.slice(0, 3),
      maxHitBy: best ? best.maxHitBy : '', dummyKilled: runs.reduce((a, r) => a + (r.dummyKilled || 0), 0),
      maxStack: Math.max(0, ...runs.map((r) => r.maxStack || 0)), maxStackKey: (runs.slice().sort((a, b) => (b.maxStack || 0) - (a.maxStack || 0))[0] || {}).maxStackKey || '',
      pctHpAdj: stat(runs.map((r) => r.pctHpAdj || 0)).mean,
      apTurns: stat(runs.map((r) => r.t / C.REF_TURN)).mean };
  };

  // ------------------------------------------------------------------ search
  // host = { evalMany(jobs) -> Promise<[agg]>, progress(info), stopped() -> bool, log(msg) }
  C.search = async function (cfgIn, host) {
    const cfg = Object.assign({}, C.DEFAULTS, cfgIn || {});
    cfg.assume = Object.assign({}, C.DEFAULTS.assume, cfgIn && cfgIn.assume);
    const t0 = Date.now();
    const log = (m) => host.log && host.log(m);
    const objectives = (cfg.objectives || []).filter((o) => C.OBJ[o]);
    if (!objectives.length) throw new Error('목표를 하나 이상 고르세요');
    const benches = {};
    for (const k of C.benchesFor(objectives)) benches[k] = C.makeBench(k, cfg);
    const pool = C.filterPool(C.pcPool(), cfg.pool);
    const locked = (cfg.locked || []).filter((k) => LOSim.T('Table_PC', k)).slice(0, 5);
    for (const k of locked) if (!pool.some((p) => p.key === k)) { const p = C.pcPool().find((x) => x.key === k); if (p) pool.push(p); }
    if (pool.length < 5) throw new Error('후보 전투원이 5명 미만입니다 (' + pool.length + ')');
    const poolMap = Object.fromEntries(pool.map((p) => [p.key, p]));
    const seeds = Array.from({ length: Math.max(1, cfg.seeds | 0) }, (_, i) => cfg.baseSeed + i);
    const vSeeds = Array.from({ length: Math.max(1, cfg.verifySeeds | 0) }, (_, i) => cfg.baseSeed + 10000 + i);
    const cache = new Map();
    const stats = { evals: 0, battles: 0, cacheHits: 0, phase: '' };
    const res = { config: cfg, benches, pool: pool.length, startedAt: new Date(t0).toISOString(), objectives: {}, warnings: [], engineFlags: [] };
    const flagSeen = new Set();
    let budgetLeft = Infinity;
    const stopped = () => !!(host.stopped && host.stopped());
    const progress = (extra) => host.progress && host.progress(Object.assign({ phase: stats.phase, evals: stats.evals, battles: stats.battles, cacheHits: stats.cacheHits, elapsedMs: Date.now() - t0 }, extra || {}));

    // evaluate squads on one bench (cached); counts against budget unless free
    async function evalSquads(squads, benchId, sd, opts) {
      opts = opts || {};
      const bench = benches[benchId];
      const sk = sd.join('/');
      const jobs = [], idx = [];
      const out = new Array(squads.length);
      squads.forEach((sq, i) => {
        const key = benchId + '|' + sk + '|' + C.squadKey(sq);
        if (cache.has(key)) { out[i] = cache.get(key); stats.cacheHits++; return; }
        jobs.push({ squad: sq, bench, seeds: sd, assume: cfg.assume, key }); idx.push(i);
      });
      if (jobs.length) {
        if (stopped()) throw new Error('STOP');
        const CH = 64;
        const perSeed = jobs.length < 24 && sd.length > 1;
        for (let s = 0; s < jobs.length; s += CH) {
          const part = jobs.slice(s, s + CH);
          let r;
          if (perSeed) {
            const subs = [];
            part.forEach((j, pi) => j.seeds.forEach((seed) => subs.push({ pi, job: { squad: j.squad, bench: j.bench, seeds: [seed], assume: j.assume, raw: true } })));
            let done = 0;
            const total = subs.length;
            progress({ sub: `전투 0/${total}` });
            const rr = await host.evalMany(subs.map((x) => x.job), () => { done++; progress({ sub: `전투 ${done}/${total}` }); });
            const runs = part.map(() => []);
            rr.forEach((x, i) => { runs[subs[i].pi].push(...((x && x.runs) || [])); });
            r = part.map((j, pi) => C.aggregate({ squad: j.squad, bench: j.bench, seeds: j.seeds, assume: j.assume }, runs[pi]));
          } else r = await host.evalMany(part.map((j) => ({ squad: j.squad, bench: j.bench, seeds: j.seeds, assume: j.assume })));
          r.forEach((agg, k) => {
            const j = part[k]; cache.set(j.key, agg); out[idx[s + k]] = agg;
            for (const e of agg.errors || []) if (!flagSeen.has(e) && flagSeen.size < 30) { flagSeen.add(e); res.engineFlags.push({ squad: C.squadKey(j.squad), bench: benchId, msg: e }); }
          });
          stats.evals += part.length; stats.battles += part.reduce((a, j) => a + j.seeds.length, 0);
          if (!opts.free) budgetLeft -= part.length;
          progress();
          if (stopped()) throw new Error('STOP');
        }
      }
      return out;
    }
    const mean = (agg, metric) => (agg && agg.m[metric] && agg.m[metric].mean != null ? agg.m[metric].mean : 0);
    const lcb = (agg, metric) => (agg && agg.m[metric] && agg.m[metric].mean != null ? agg.m[metric].mean - agg.m[metric].se : 0);

    // objective scorer over possibly several benches. refs: normalisers for 'balanced'.
    const refs = {};
    async function scoreSquads(obj, squads, sd, opts) {
      if (obj !== 'balanced') {
        const o = C.OBJ[obj];
        const aggs = await evalSquads(squads, o.bench, sd, opts);
        return aggs.map((a) => ({ score: mean(a, o.metric), robust: lcb(a, o.metric), aggs: { [o.bench]: a } }));
      }
      const w = cfg.weights;
      const parts = Object.keys(w).filter((k) => w[k] > 0 && C.OBJ[k]);
      const per = {};
      for (const k of parts) { const b = C.OBJ[k].bench; if (!per[b]) per[b] = await evalSquads(squads, b, sd, opts); }
      return squads.map((_, i) => {
        let s = 0, r = 0, wt = 0;
        const aggs = {};
        for (const k of parts) {
          const a = per[C.OBJ[k].bench][i]; aggs[C.OBJ[k].bench] = a;
          const ref = refs[k] || 1;
          s += (w[k] * mean(a, C.OBJ[k].metric)) / ref; r += (w[k] * lcb(a, C.OBJ[k].metric)) / ref; wt += w[k];
        }
        return { score: (100 * s) / (wt || 1), robust: (100 * r) / (wt || 1), aggs };
      });
    }

    // ---------------- phase 1: screening (shared per bench) -- solo, then reference-context marginal
    const screen = {}; // benchId -> {solo:{key:agg}, ctx:{key:agg}, ref4:[keys], refAgg}
    const objMetric = (benchId) => ({ dummy: 'dps', endurance: 'survival', stage: 'clear' }[benchId]);
    async function screening(benchId) {
      if (screen[benchId]) return screen[benchId];
      const metric = objMetric(benchId);
      stats.phase = `1차 선별: 단독 평가 (${benchId})`; progress();
      const keys = pool.map((p) => p.key);
      const soloSq = keys.map((k) => C.autoFormation([k]));
      const soloAgg = await evalSquads(soloSq, benchId, seeds.slice(0, 1), { free: true }); // 1 seed: solo ranking only picks the reference squad
      const solo = {}; keys.forEach((k, i) => (solo[k] = soloAgg[i]));
      const ranked = keys.slice().sort((a, b) => mean(solo[b], metric) - mean(solo[a], metric));
      // reference context: the 4 best solo units (for survival/clear: best solo tank+3 next) -- candidates are added as the 5th member
      const ref4 = ranked.slice(0, 4);
      stats.phase = `1차 선별: 기준 분대(${ref4.length}명)+1 평가 (${benchId})`; progress();
      const refSq = C.autoFormation(ref4);
      const [refAgg] = await evalSquads([refSq], benchId, seeds, { free: true });
      const others = keys.filter((k) => !ref4.includes(k));
      const ctxAgg = await evalSquads(others.map((k) => C.autoFormation(ref4.concat([k]))), benchId, seeds, { free: true });
      const ctx = {}; others.forEach((k, i) => (ctx[k] = ctxAgg[i]));
      // ref4 members: leave-one-out inside ref4 + best other -> their marginal value is comparable
      const best5 = others.slice().sort((a, b) => mean(ctx[b], metric) - mean(ctx[a], metric))[0];
      if (best5) {
        const looSq = ref4.map((k) => C.autoFormation(ref4.filter((x) => x !== k).concat([best5])));
        const looAgg = await evalSquads(looSq, benchId, seeds, { free: true });
        const full = await evalSquads([C.autoFormation(ref4.concat([best5]))], benchId, seeds, { free: true });
        ref4.forEach((k, i) => { ctx[k] = Object.assign({}, full[0], { _looAgg: looAgg[i] }); });
      }
      // marginal value of k = score(reference squad with k) - score(reference squad without k)
      const deltaFor = (m) => { const d = {}; for (const k of keys) d[k] = ctx[k] && ctx[k]._looAgg ? mean(ctx[k], m) - mean(ctx[k]._looAgg, m) : mean(ctx[k], m) - mean(refAgg, m); return d; };
      return (screen[benchId] = { solo, ctx, ref4, refAgg, deltaFor, metric });
    }

    function shortlistFor(obj) {
      // rank by marginal contribution in the reference context; keep role diversity and locked members
      const parts = obj === 'balanced' ? Object.keys(cfg.weights).filter((k) => cfg.weights[k] > 0 && C.OBJ[k]) : [obj];
      const z = {};
      for (const k of pool.map((p) => p.key)) z[k] = 0;
      for (const p of parts) {
        const sc = screen[C.OBJ[p].bench];
        const delta = sc.deltaFor(C.OBJ[p].metric);
        const st = stat(pool.map((x) => delta[x.key]));
        const w = obj === 'balanced' ? cfg.weights[p] : 1;
        for (const x of pool) z[x.key] += (w * (delta[x.key] - st.mean)) / (st.sd || 1);
      }
      const K = Math.max(8, cfg.shortlist | 0);
      const ranked = pool.map((p) => p.key).sort((a, b) => z[b] - z[a]);
      const sl = new Set(locked);
      for (const role of [0, 1, 2]) ranked.filter((k) => poolMap[k].role === role).slice(0, 3).forEach((k) => sl.add(k));
      for (const k of ranked) { if (sl.size >= K) break; sl.add(k); }
      return { list: [...sl], z };
    }

    // ---------------- phase 2: genetic search over members + positions
    const rnd = LOSim.makeRng(cfg.baseSeed * 7 + 13);
    const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
    function normalize(sq) { // locked members present, unique keys, unique cells
      const seen = new Set(), cells = new Set(), out = [];
      for (const m of sq) if (!seen.has(m.key) && !cells.has(m.gridPos)) { seen.add(m.key); cells.add(m.gridPos); out.push({ key: m.key, gridPos: m.gridPos }); }
      for (const k of locked) if (!seen.has(k)) {
        if (out.length >= 5) { const i = out.findIndex((m) => !locked.includes(m.key)); cells.delete(out[i].gridPos); seen.delete(out[i].key); out.splice(i, 1); }
        const f = C.autoFormation([k], out).find((m) => m.key === k); out.push(f); seen.add(k); cells.add(f.gridPos);
      }
      return out.slice(0, 5);
    }
    function mutate(sq, sl) {
      const s = sq.map((m) => Object.assign({}, m));
      const r = rnd();
      const free = [0, 1, 2, 3, 4, 5, 6, 7, 8].filter((c) => !s.some((m) => m.gridPos === c));
      if (r < 0.55) { // swap a member for a shortlist unit (same cell)
        const i = Math.floor(rnd() * s.length);
        if (locked.includes(s[i].key)) return s;
        const cand = sl.filter((k) => !s.some((m) => m.key === k));
        if (cand.length) s[i].key = pick(cand);
      } else if (r < 0.8 && free.length) { s[Math.floor(rnd() * s.length)].gridPos = pick(free); } // move to an empty cell
      else { const i = Math.floor(rnd() * s.length), j = Math.floor(rnd() * s.length); const t = s[i].gridPos; s[i].gridPos = s[j].gridPos; s[j].gridPos = t; }
      return s;
    }
    function crossover(a, b) {
      const keys = [...new Set(a.concat(b).map((m) => m.key))];
      const chosen = [];
      for (const k of locked) chosen.push(k);
      const pool2 = keys.filter((k) => !chosen.includes(k));
      while (chosen.length < 5 && pool2.length) chosen.push(pool2.splice(Math.floor(rnd() * pool2.length), 1)[0]);
      const posOf = (k) => (rnd() < 0.5 ? (a.find((m) => m.key === k) || b.find((m) => m.key === k)) : (b.find((m) => m.key === k) || a.find((m) => m.key === k))).gridPos;
      const out = [], cells = new Set();
      for (const k of chosen) { const gp = posOf(k); if (!cells.has(gp)) { cells.add(gp); out.push({ key: k, gridPos: gp }); } }
      const rest = chosen.filter((k) => !out.some((m) => m.key === k));
      return C.autoFormation(rest.concat(out.map((m) => m.key)), out);
    }

    async function optimize(obj, budget) {
      const startBudget = budgetLeft = budget;
      const parts = obj === 'balanced' ? Object.keys(cfg.weights).filter((k) => cfg.weights[k] > 0 && C.OBJ[k]) : [obj];
      for (const p of parts) await screening(C.OBJ[p].bench);
      if (obj === 'balanced') {
        // normalisers: the mean score of the screening context squads (a "typical decent squad")
        for (const p of parts) {
          const sc = screen[C.OBJ[p].bench];
          const st = stat(Object.values(sc.ctx).map((a) => mean(a, C.OBJ[p].metric)));
          refs[p] = Math.max(1e-9, Math.abs(st.mean || 1));
        }
      }
      const { list: sl, z } = shortlistFor(obj);
      const top = sl.slice().sort((a, b) => z[b] - z[a]);
      const memo = new Map();
      const evalPop = async (sqs) => {
        const need = sqs.filter((s) => !memo.has(C.squadKey(s)));
        const uniq = [...new Map(need.map((s) => [C.squadKey(s), s])).values()];
        if (uniq.length) {
          const sc = await scoreSquads(obj, uniq, seeds);
          uniq.forEach((s, i) => memo.set(C.squadKey(s), Object.assign({ squad: s }, sc[i])));
        }
        return sqs.map((s) => memo.get(C.squadKey(s)));
      };
      const PN = 20;
      let popSq = [];
      popSq.push(normalize(C.autoFormation(top.slice(0, 5))));
      const mainBench = C.OBJ[parts[0]].bench;
      popSq.push(normalize(C.autoFormation(screen[mainBench].ref4.concat([top.find((k) => !screen[mainBench].ref4.includes(k))]))));
      while (popSq.length < PN) {
        const w = top.slice(0, Math.min(top.length, 12 + popSq.length));
        const ks = []; while (ks.length < 5) { const k = pick(rnd() < 0.6 ? w : top); if (!ks.includes(k)) ks.push(k); }
        popSq.push(normalize(C.autoFormation(ks)));
      }
      stats.phase = `2차 탐색 (${C.OBJ[obj].label}): 유전 탐색`; progress({ budgetLeft });
      let pop = await evalPop(popSq);
      let gen = 0, stall = 0, bestR = -Infinity;
      const polishBudget = Math.floor(startBudget * 0.2);
      while (budgetLeft > polishBudget && stall < 12 && !stopped()) {
        gen++;
        pop.sort((a, b) => b.robust - a.robust);
        const elite = pop.slice(0, 4);
        const kids = [];
        const tour = () => { let best = null; for (let i = 0; i < 3; i++) { const c = pick(pop); if (!best || c.robust > best.robust) best = c; } return best; };
        let guard = 0;
        while (kids.length < PN - elite.length && guard++ < 400) {
          let child = rnd() < 0.5 ? crossover(tour().squad, tour().squad) : tour().squad;
          child = mutate(child, sl); if (rnd() < 0.35) child = mutate(child, sl);
          child = normalize(child);
          if (child.length < 5) continue;
          const k = C.squadKey(child);
          if (memo.has(k) && rnd() < 0.85) continue;
          if (kids.some((x) => C.squadKey(x) === k)) continue;
          kids.push(child);
        }
        const kidsE = await evalPop(kids.slice(0, Math.max(1, Math.min(kids.length, budgetLeft - polishBudget))));
        pop = elite.concat(kidsE);
        pop.sort((a, b) => b.robust - a.robust);
        if (pop[0].robust > bestR + 1e-9) { bestR = pop[0].robust; stall = 0; } else stall++;
        progress({ gen, best: pop[0].score, budgetLeft });
      }
      // ---------------- phase 3: local polish (positions, then member swaps) of the best distinct member sets
      stats.phase = `3차 다듬기 (${C.OBJ[obj].label}): 배치·교체 국소 탐색`; progress();
      const all = [...memo.values()].sort((a, b) => b.robust - a.robust);
      const seeds3 = []; const seenM = new Set();
      for (const x of all) { const mk = C.memberKey(x.squad); if (seenM.has(mk)) continue; seenM.add(mk); seeds3.push(x); if (seeds3.length >= 3) break; }
      for (const start of seeds3) {
        let cur = start, improved = true;
        while (improved && budgetLeft > 0 && !stopped()) {
          improved = false;
          const nb = [];
          const s = cur.squad;
          const free = [0, 1, 2, 3, 4, 5, 6, 7, 8].filter((c) => !s.some((m) => m.gridPos === c));
          for (let i = 0; i < s.length; i++) for (const c of free) nb.push(s.map((m, j) => (j === i ? { key: m.key, gridPos: c } : m)));
          for (let i = 0; i < s.length; i++) for (let j = i + 1; j < s.length; j++) nb.push(s.map((m, k) => (k === i ? { key: m.key, gridPos: s[j].gridPos } : k === j ? { key: m.key, gridPos: s[i].gridPos } : m)));
          for (let i = 0; i < s.length; i++) if (!locked.includes(s[i].key)) for (const k of top.slice(0, 8)) if (!s.some((m) => m.key === k)) nb.push(s.map((m, j) => (j === i ? { key: k, gridPos: m.gridPos } : m)));
          const fresh = nb.filter((x) => !memo.has(C.squadKey(x)));
          const take = fresh.slice(0, Math.max(0, budgetLeft));
          const ev = await evalPop(take);
          const cand = ev.concat(nb.filter((x) => memo.has(C.squadKey(x))).map((x) => memo.get(C.squadKey(x))));
          for (const c of cand) if (c && c.robust > cur.robust + 1e-9) { cur = c; improved = true; }
        }
      }
      // ---------------- phase 4: verification with fresh seeds (avoids the winner's curse of the search seeds)
      stats.phase = `4차 검증 (${C.OBJ[obj].label}): 상위 ${cfg.verifyTop}개 × 시드 ${vSeeds.length}`; progress();
      const final = []; const seenK = new Set(); const seenMem = new Map();
      for (const x of [...memo.values()].sort((a, b) => b.robust - a.robust)) {
        const k = C.squadKey(x.squad); if (seenK.has(k)) continue;
        const mk = C.memberKey(x.squad); const c = seenMem.get(mk) || 0; if (c >= 2) continue; // at most 2 formations per member set
        seenK.add(k); seenMem.set(mk, c + 1); final.push(x); if (final.length >= cfg.verifyTop) break;
      }
      const ver = await scoreSquads(obj, final.map((x) => x.squad), vSeeds, { free: true });
      let ranked = final.map((x, i) => Object.assign({ squad: x.squad, search: { score: x.score, robust: x.robust } }, ver[i])).sort((a, b) => b.score - a.score);
      // ---------------- phase 5: why -- leave-one-out and pair interactions for the top 3
      stats.phase = `5차 해석 (${C.OBJ[obj].label}): 기여도·시너지`; progress();
      const exSeeds = vSeeds.slice(0, Math.max(3, Math.min(vSeeds.length, seeds.length * 2)));
      for (let ti = 0; ti < Math.min(3, ranked.length) && !stopped(); ti++) {
        const t = ranked[ti];
        const sq = t.squad;
        const [full] = await scoreSquads(obj, [sq], exSeeds, { free: true });
        const loo = await scoreSquads(obj, sq.map((m) => sq.filter((x) => x !== m)), exSeeds, { free: true });
        t.loo = sq.map((m, i) => ({ key: m.key, gridPos: m.gridPos, delta: full.score - loo[i].score, pct: full.score ? (100 * (full.score - loo[i].score)) / full.score : 0 }));
        const pairs = [];
        for (let i = 0; i < sq.length; i++) for (let j = i + 1; j < sq.length; j++) pairs.push([i, j]);
        const two = await scoreSquads(obj, pairs.map(([i, j]) => sq.filter((_, k) => k !== i && k !== j)), exSeeds, { free: true });
        t.fullScore = full.score;
        t.pairs = pairs.map(([i, j], k) => ({ a: sq[i].key, b: sq[j].key, inter: full.score - loo[i].score - loo[j].score + two[k].score, s: full.score, sNoA: loo[i].score, sNoB: loo[j].score, sNoAB: two[k].score }))
          .map((p) => Object.assign(p, { pct: full.score ? (100 * p.inter) / full.score : 0 })).sort((a, b) => Math.abs(b.inter) - Math.abs(a.inter));
        if (obj !== 'balanced') {
          const benchId = C.OBJ[obj].bench, sc = screen[benchId];
          const soloSum = sq.reduce((a, m) => a + mean(sc.solo[m.key], C.OBJ[obj].metric), 0);
          t.soloSum = soloSum;
          t.synergyX = soloSum > 0 && (obj === 'dps' || obj === 'burst') ? full.score / soloSum : null;
        }
      }
      return { ranked, shortlist: sl, z, gens: gen, evalsUsed: startBudget - budgetLeft };
    }

    // ---------- evidence for a callout: how the number was produced ----------
    const METRIC_DEF = {
      dps: '지속 DPS = 전투에서 준 총 피해 ÷ 경과 기준턴 (1기준턴 = 속도 4 유닛이 한 번 행동하는 AP 시간 25)',
      burst: '순간 화력 = 전투 시작 후 처음 몇 기준턴 동안 준 피해 합계',
      survival: '생존 점수 = 70 × (전투원별 생존 시간 비율 평균) + 20 × (사망 0이면 1) + 10 × (남은 HP 비율)',
      clear: '클리어 점수 = 승리 시 max(10, 100 − 클리어 기준턴), 패배 시 10 × 클리어한 웨이브 비율',
      balanced: '종합 점수 = 선택한 목표 점수들을 1차 선별 평균으로 나눠 가중 평균',
      perAct: '행동당 피해 = 총 피해 ÷ 분대 행동 수', maxHit: '최대 단일 피해 = 한 번의 행동으로 준 피해 중 최댓값',
    };
    const sv = (st, d) => (st && st.mean != null ? `${fmt(st.mean, d)} ± ${fmt(st.sd, d)} (최소 ${fmt(st.min, d)} · 최대 ${fmt(st.max, d)} · ${st.n}회)` : '-');
    function benchRows(benchId) {
      const b = benches[benchId];
      if (!b) return [];
      return [['측정 환경', b.label], ['전투원 가정', `등급 ${cfg.assume.grade === 'max' ? '최대' : cfg.assume.grade} · Lv${cfg.assume.level} · 스킬 Lv${cfg.assume.skillLevel} · 장비·코어링크 없음`]];
    }
    function memberTable(agg, squad) {
      if (!agg || !agg.members) return null;
      const tot = agg.members.reduce((a, m) => a + (m.dmg || 0), 0) || 1;
      return { head: ['전투원', '칸', '평균 피해', '피해 비중', '받은 피해', '회복', '행동', '사망률'],
        rows: squad.map((m) => { const x = agg.members.find((y) => y.key === m.key) || {}; return [nmK(m.key), m.gridPos + 1, fmt(x.dmg || 0), fmt((100 * (x.dmg || 0)) / tot, 1) + '%', fmt(x.taken || 0), fmt(x.heal || 0), fmt(x.actions || 0, 1), fmt(100 * (x.deathRate || 0), 0) + '%']; }) };
    }
    const nmK = (k) => (poolMap[k] ? poolMap[k].name : k);
    function contribRows(t) {
      const r = [];
      if (t.loo) r.push(['한 명씩 뺐을 때 점수 변화', t.loo.map((x) => `${nmK(x.key)} −${fmt(x.delta)} (${fmt(x.pct, 0)}%)`).join(' · ')]);
      if (t.pairs && t.pairs.length) { const p = t.pairs[0]; r.push(['가장 큰 짝 상호작용', `${nmK(p.a)} + ${nmK(p.b)}: ${fmt(p.inter)} (${fmt(p.pct, 0)}%) = S ${fmt(p.s)} − S(−${nmK(p.a)}) ${fmt(p.sNoA)} − S(−${nmK(p.b)}) ${fmt(p.sNoB)} + S(−둘) ${fmt(p.sNoAB)}`]); }
      return r;
    }
    function buffRows(stackKey, n) {
      const [unitKey, buffKey] = String(stackKey || '').split(' ');
      const r = LOSim.T('Table_BuffEffect', buffKey);
      if (!r) return [['버프', buffKey || '-']];
      const E = LOSim.E, en = (g, v) => (LOSim.Ename[g] || {})[v] || v;
      const rows = [['보유 전투원', nmK(unitKey)], ['버프 키', buffKey], ['버프 이름', LOSim.name(r.Name, buffKey)],
        ['발동 트리거', en('BUFFEFFECT_TRIGGER_TYPE', num(r, 'BuffEffectTriggerType'))], ['지속 해제 방식', en('BUFFEFFECT_ERASE_TYPE', num(r, 'BuffEffectEraseType'))],
        ['중첩 최대치(BuffEffectOverlapMax)', String(num(r, 'BuffEffectOverlapMax'))]];
      for (let i = 1; i <= 5; i++) {
        const t = num(r, 'BuffEffectType' + i); if (!t) continue;
        const v = parseFloat(r['BuffEffectValue' + i] || 0) || 0, rate = parseFloat(r['BuffEffectRate' + i] || 0) || 0;
        if (!(rate > 0)) continue;
        rows.push([`효과 ${i}`, `${en('BUFFEFFECT_TYPE', t)} ${v} / 중첩 타입 ${en('BUFF_OVERLAP_TYPE', num(r, 'BuffEffectOverlapType' + i))} · 지속 ${num(r, 'BuffEffectLeftCount' + i)} → ${n}중첩이면 합계 ${fmt(v * n, 2)}`]);
      }
      return rows;
    }
    // "Char_X Skill_Y" -> "전투원 · 스킬 이름"
    function prettyBy(v) {
      if (!v) return '-';
      const [u, sk] = String(v).split(' ');
      const st = sk && LOSim.T('Table_Skill', sk);
      return `${nmK(u)}${sk ? ' · ' + (st ? LOSim.name(st.SkillName, sk) : sk) : ''}`;
    }
    function ev(o) { return Object.assign({ formula: '', rows: [], table: null, seeds: null, notes: [] }, o); }

    const per = Math.max(30, Math.floor((cfg.budget | 0) / objectives.length));
    try {
      for (const obj of objectives) {
        const ot = Date.now(), e0 = stats.evals, b0 = stats.battles;
        const r = await optimize(obj, per);
        const o = { objective: obj, label: C.OBJ[obj].label, unit: C.OBJ[obj].unit, top: r.ranked, shortlist: r.shortlist, gens: r.gens, evalsUsed: r.evalsUsed,
          evals: stats.evals - e0, battles: stats.battles - b0, ms: Date.now() - ot };
        o.screening = summarizeScreening(obj);
        o.callouts = callouts(obj, o);
        res.objectives[obj] = o;
        host.partial && host.partial(res);
      }
    } catch (e) {
      if (String(e && e.message) !== 'STOP') throw e;
      res.stopped = true;
    }
    res.elapsedMs = Date.now() - t0; res.evals = stats.evals; res.battles = stats.battles; res.cacheHits = stats.cacheHits;
    res.names = Object.fromEntries(pool.map((p) => [p.key, p.name]));
    res.roles = Object.fromEntries(pool.map((p) => [p.key, p.role]));
    return res;

    function summarizeScreening(obj) {
      const parts = obj === 'balanced' ? Object.keys(cfg.weights).filter((k) => cfg.weights[k] > 0 && C.OBJ[k]) : [obj];
      const out = {};
      for (const p of parts) {
        const sc = screen[C.OBJ[p].bench]; if (!sc) continue;
        const metric = C.OBJ[p].metric;
        const solo = pool.map((x) => ({ key: x.key, v: mean(sc.solo[x.key], metric), sd: sc.solo[x.key] && sc.solo[x.key].m[metric] ? sc.solo[x.key].m[metric].sd : 0, maxHit: sc.solo[x.key] ? mean(sc.solo[x.key], 'maxHit') : 0 })).sort((a, b) => b.v - a.v);
        const delta = sc.deltaFor(metric);
        const ctx = pool.map((x) => ({ key: x.key, delta: delta[x.key] })).sort((a, b) => b.delta - a.delta);
        out[p] = { ref4: sc.ref4, refScore: mean(sc.refAgg, metric), soloTop: solo.slice(0, 15), ctxTop: ctx.slice(0, 15), soloMedian: solo[Math.floor(solo.length / 2)].v, ctxMedian: ctx[Math.floor(ctx.length / 2)].delta };
      }
      return out;
    }
    function callouts(obj, o) {
      const out = [];
      const top = o.top;
      const nm = (k) => (poolMap[k] ? poolMap[k].name : k);
      const sqName = (sq) => sq.map((m) => nm(m.key)).join('·');
      if (!top.length) return out;
      const t1 = top[0];
      const t2 = top.find((x) => C.memberKey(x.squad).split(',').filter((k) => !t1.squad.some((m) => m.key === k)).length >= 2);
      const bench1 = C.OBJ[obj].bench, metric1 = C.OBJ[obj].metric;
      const agg1 = t1.aggs && t1.aggs[bench1];
      if (t2 && t2.score > 0 && t1.score / t2.score >= 1.3) out.push({ level: 'high', text: `1위 조합(${sqName(t1.squad)})의 ${o.label} 점수가 구성원이 2명 이상 다른 차선 조합 대비 ${(t1.score / t2.score).toFixed(2)}배`,
        evidence: ev({ formula: `배율 = 1위 점수 ÷ 차선 점수 = ${fmt(t1.score)} ÷ ${fmt(t2.score)} = ${(t1.score / t2.score).toFixed(2)}배 · ${METRIC_DEF[obj] || ''}`,
          rows: [['1위 조합', sqName(t1.squad)], [`1위 ${o.label} (검증)`, sv(agg1 && agg1.m[metric1])], ['차선 조합 (구성원 2명 이상 다름)', sqName(t2.squad)], [`차선 ${o.label} (검증)`, sv(t2.aggs && t2.aggs[bench1] && t2.aggs[bench1].m[metric1])], ...benchRows(bench1), ...contribRows(t1)],
          table: memberTable(agg1, t1.squad), seeds: agg1 && agg1.m[metric1] && agg1.m[metric1].vals,
          notes: ['검증 수치는 탐색에 쓰지 않은 새 시드로 다시 돌린 결과입니다.', '구성원이 1명만 다른 조합은 사실상 같은 조합이라 비교에서 뺐습니다.'] }) });
      if (obj === 'dps' || obj === 'burst') {
        const sc = o.screening[obj];
        const soloEv = (f) => ev({ formula: f + ` · ${METRIC_DEF[obj] || ''}`, rows: [['측정 방법', '각 전투원을 혼자 같은 환경에 넣어 1차 선별 시드로 측정 (분대 버프 없음)'], ['전체 후보 중앙값', fmt(sc.soloMedian)], ...benchRows(C.OBJ[obj].bench)],
          table: { head: ['순위', '전투원', `단독 ${o.label}`, '편차', '최대 단일 피해'], rows: sc.soloTop.slice(0, 8).map((x, i) => [i + 1, nm(x.key), fmt(x.v), fmt(x.sd), fmt(x.maxHit)]) },
          notes: ['단독 측정은 1차 선별 단계 값이라 시드 수가 적습니다. 정확한 값은 분대로 다시 돌려 확인하세요.'] });
        if (sc && sc.soloTop.length > 2 && sc.soloTop[1].v > 0 && sc.soloTop[0].v / sc.soloTop[1].v >= 1.5) out.push({ level: 'high', text: `단독 ${o.label}: ${nm(sc.soloTop[0].key)} 혼자서 2위(${nm(sc.soloTop[1].key)}) 대비 ${(sc.soloTop[0].v / sc.soloTop[1].v).toFixed(2)}배`,
          evidence: soloEv(`배율 = ${nm(sc.soloTop[0].key)} ${fmt(sc.soloTop[0].v)} ÷ ${nm(sc.soloTop[1].key)} ${fmt(sc.soloTop[1].v)} = ${(sc.soloTop[0].v / sc.soloTop[1].v).toFixed(2)}배`) });
        if (sc && sc.soloMedian > 0 && sc.soloTop[0].v / sc.soloMedian >= 5) out.push({ level: 'mid', text: `단독 ${o.label} 1위 ${nm(sc.soloTop[0].key)} = 전체 중앙값의 ${(sc.soloTop[0].v / sc.soloMedian).toFixed(1)}배`,
          evidence: soloEv(`배율 = ${fmt(sc.soloTop[0].v)} ÷ 중앙값 ${fmt(sc.soloMedian)} = ${(sc.soloTop[0].v / sc.soloMedian).toFixed(1)}배`) });
        const a = t1.aggs.dummy;
        const bd = benches.dummy;
        if (a && a.dummyKilled) out.push({ level: 'high', text: `불사 허수아비(명목 HP의 ${fmt(bd.hpScale)}배)가 검증 ${a.n}회 중 ${a.dummyKilled}회 처치됨 — 피해량이 사실상 무한대 (${prettyBy(a.maxHitBy)})`,
          evidence: ev({ formula: `허수아비 실제 HP = 명목 HP ${fmt(bd.nominalHp)} × ${fmt(bd.hpScale)}배, 매 행동 후 회복 → 한 번의 행동으로 이 값을 넘겨야 처치됨`, rows: [['처치 횟수', `${a.dummyKilled} / ${a.n}회`], ['최대 단일 피해를 낸 행동', prettyBy(a.maxHitBy)], ['최대 단일 피해', sv(a.m.maxHit)], ...benchRows('dummy')], table: memberTable(a, t1.squad), seeds: a.m.maxHit && a.m.maxHit.vals, notes: ['정상적인 피해량으로는 도달할 수 없는 값이라 버프 중첩·배율 계산 이상을 우선 의심합니다.'] }) });
        if (a && a.m.maxHit && a.m.maxHit.max > bd.nominalHp) out.push({ level: 'high', text: `1위 조합의 한 번의 행동 피해 최대 ${fmt(a.m.maxHit.max)} = 허수아비 명목 HP(${fmt(bd.nominalHp)})의 ${fmt(a.m.maxHit.max / bd.nominalHp, 1)}배 (${prettyBy(a.maxHitBy)})`,
          evidence: ev({ formula: `배율 = 최대 단일 피해 ${fmt(a.m.maxHit.max)} ÷ 허수아비 명목 HP ${fmt(bd.nominalHp)} = ${fmt(a.m.maxHit.max / bd.nominalHp, 1)}배 · ${METRIC_DEF.maxHit}`,
            rows: [['그 행동 (전투원 · 스킬)', prettyBy(a.maxHitBy)], ['검증 전투별 최대 단일 피해', sv(a.m.maxHit)], ['지속 DPS (같은 전투)', sv(a.m.dps)], ['같은 버프 최대 중첩', a.maxStack ? `${a.maxStack}개 (${a.maxStackKey})` : '-'], ...benchRows('dummy')],
            table: memberTable(a, t1.squad), seeds: a.m.maxHit.vals, notes: ['한 번의 행동이 허수아비 전체 HP를 넘는 경우, 공격력·스킬 배율 버프가 비정상적으로 쌓였을 가능성이 큽니다. 아래 "같은 버프 최대 중첩" 항목을 함께 보세요.'] }) });
        if (t1.synergyX && t1.synergyX >= 2) out.push({ level: 'mid', text: `1위 조합 피해가 구성원 단독 피해 합의 ${t1.synergyX.toFixed(2)}배 (버프 시너지)`,
          evidence: ev({ formula: `배율 = 분대 점수 ${fmt(t1.fullScore != null ? t1.fullScore : t1.score)} ÷ 구성원 단독 점수 합 ${fmt(t1.soloSum)} = ${t1.synergyX.toFixed(2)}배`,
            rows: [['구성원 단독 점수', t1.squad.map((m) => `${nmK(m.key)} ${fmt(mean(screen[C.OBJ[obj].bench].solo[m.key], C.OBJ[obj].metric))}`).join(' · ')], ...contribRows(t1), ...benchRows(C.OBJ[obj].bench)],
            table: memberTable(a, t1.squad), notes: ['1배보다 크면 서로의 버프로 피해가 늘어난 것입니다. 2배 이상이면 특정 버프 조합이 결과를 지배하고 있다는 뜻입니다.'] }) });
      }
      if (obj === 'survival') {
        const imm = top.filter((t) => t.aggs.endurance && t.aggs.endurance.m.zeroDeath && t.aggs.endurance.m.zeroDeath.mean === 1);
        for (const t of imm.slice(0, 3)) {
          const a = t.aggs.endurance;
          out.push({ level: 'high', text: `${sqName(t.squad)}: ${benches.endurance.label} — 검증 ${a.n}회 모두 사망 0, 평균 잔여 HP ${fmt(a.m.hpLeft.mean, 0)}% (불사 후보)`,
            evidence: ev({ formula: `불사 후보 조건 = 검증 전투 전부에서 사망 0 · ${METRIC_DEF.survival}`,
              rows: [['생존 점수', sv(a.m.survival)], ['사망 수', sv(a.m.deaths)], ['남은 HP %', sv(a.m.hpLeft, 0)], ['생존 시간 비율', sv(a.m.aliveFrac, 2)], ['같은 버프 최대 중첩', a.maxStack ? `${a.maxStack}개 (${a.maxStackKey})` : '-'], ...benchRows('endurance'), ...contribRows(t)],
              table: memberTable(a, t.squad), seeds: a.m.hpLeft && a.m.hpLeft.vals,
              notes: ['적은 HP 배율과 매 행동 후 회복으로 죽지 않게 만들고, 정해진 기준턴 동안 버티는지만 봅니다.', '적 공격력 배율을 올려도 사망 0이면 회피·피해 감소 효과가 상한 없이 쌓였는지 확인하세요.'] }) });
        }
        if (imm.length > 3) out.push({ level: 'mid', text: `상위 ${top.length}개 중 ${imm.length}개 조합이 검증 전투 전부에서 사망 0` });
      }
      if (obj === 'clear') {
        const a = t1.aggs.stage;
        if (a && a.m.win && a.m.win.mean === 1 && a.m.clearTurns && a.m.clearTurns.mean != null) out.push({ level: 'mid', text: `${sqName(t1.squad)}: ${benches.stage.stageKey} ${a.n}회 전승, 평균 ${a.m.clearTurns.mean.toFixed(1)}기준턴 클리어`,
          evidence: ev({ formula: METRIC_DEF.clear, rows: [['클리어 기준턴', sv(a.m.clearTurns, 1)], ['사망 수', sv(a.m.deaths)], ['남은 HP %', sv(a.m.hpLeft, 0)], ...benchRows('stage'), ...contribRows(t1)], table: memberTable(a, t1.squad), seeds: a.m.clearTurns.vals }) });
      }
      const stk = top.slice(0, 5).map((t) => Object.values(t.aggs || {}).reduce((m, a) => (a && a.maxStack > m.n ? { n: a.maxStack, k: a.maxStackKey } : m), { n: 0, k: '' })).sort((x, y) => y.n - x.n)[0];
      if (stk && stk.n >= 5) out.push({ level: 'high', text: `같은 버프가 한 전투원에게 최대 ${stk.n}개 동시 중첩 (${stk.k.split(' ').map((x, i) => (i === 0 ? nm(x) : x)).join(' ')}) — 중첩 규칙(BuffEffectOverlapType=4/__MAX__, OverlapMax 없음) 때문에 매 턴 시작마다 새 인스턴스가 쌓임. 실제 클라이언트에서도 같은지 확인 필요`,
        evidence: ev({ formula: `상위 5개 조합의 검증 전투에서 한 전투원이 같은 버프 키를 동시에 가진 최대 개수 = ${stk.n}`,
          rows: [...buffRows(stk.k, stk.n), ['클라이언트 근거', 'Creature.cs:2612 — OverlapMax가 0보다 클 때만 중첩 수를 검사, 2792 — __MAX__ 분기 주석 처리 → 걸릴 때마다 새로 추가'],
            ['리뉴얼 발동 시점', 'BattleRoundManager.cs:93-148 — 유닛 한 명의 턴 시작마다 모든 유닛의 TURN_START_* 버프를 실행 (유닛 수만큼 반복)'], ['지속시간', '버프 보유자 자신의 턴 종료에만 감소 (오라형은 시전자 사망 전까지 유지)']],
          notes: ['레거시에서는 턴 시작 발동이 라운드당 1번이라 1~2중첩에서 멈췄을 구조입니다.', '실제 게임에서 해당 전투원의 버프 아이콘 중첩 수나 공격력/회피 수치를 확인하면 바로 판별됩니다.'] }) });
      const seenPair = new Set();
      for (const t of top.slice(0, 3)) for (const p of (t.pairs || []).slice(0, 1)) if (p.pct >= 25 && !seenPair.has([p.a, p.b].sort().join()) && seenPair.add([p.a, p.b].sort().join())) out.push({ level: 'mid', text: `${nm(p.a)} + ${nm(p.b)} 조합 상호작용이 분대 점수의 ${p.pct.toFixed(0)}% (둘이 함께일 때만 생기는 효과)`,
        evidence: ev({ formula: `상호작용 = S − S(−${nm(p.a)}) − S(−${nm(p.b)}) + S(−둘) = ${fmt(p.s)} − ${fmt(p.sNoA)} − ${fmt(p.sNoB)} + ${fmt(p.sNoAB)} = ${fmt(p.inter)} → 분대 점수 대비 ${p.pct.toFixed(0)}%`,
          rows: [['분대', sqName(t.squad)], ['S (분대 점수)', fmt(p.s)], [`S(−${nm(p.a)})`, fmt(p.sNoA)], [`S(−${nm(p.b)})`, fmt(p.sNoB)], ['S(−둘)', fmt(p.sNoAB)], ...benchRows(C.OBJ[obj].bench)],
          notes: ['두 사람을 각각 뺐을 때 잃는 점수의 합보다 둘을 함께 뺐을 때 잃는 점수가 훨씬 크면, 두 사람이 함께 있어야만 생기는 효과(서로의 버프·연계)가 있다는 뜻입니다.'] }) });
      return out;
    }
  };

  // ------------------------------------------------------------------ reports (Korean)
  function fmt(v, d) {
    if (v == null || !Number.isFinite(v)) return '-';
    if (d === undefined) d = Math.abs(v) >= 100 ? 0 : Math.abs(v) >= 10 ? 1 : 2;
    return v.toLocaleString('ko-KR', { maximumFractionDigits: d, minimumFractionDigits: 0 });
  }
  C.fmt = fmt;
  C.ms = (s) => (s && s.mean != null ? `${fmt(s.mean)} ± ${fmt(s.sd)}` : '-');
  C.gridText = function (sq, names) {
    // 3x3 as seen by the player: back | mid | front (front faces the enemy on the right)
    const at = {}; for (const m of sq) at[m.gridPos] = (names && names[m.key]) || m.key;
    const rows = [];
    for (let r = 0; r < 3; r++) rows.push([r * 3 + 0, r * 3 + 1, r * 3 + 2].map((gp) => at[gp] || '·').join(' | '));
    return rows;
  };
  C.metricsLine = function (t, obj, res) {
    const a = t.aggs || {};
    const parts = [];
    if (a.dummy) parts.push(`DPS ${C.ms(a.dummy.m.dps)}/기준턴`, `개전 ${res.benches.dummy.cfg.burstTurns}턴 ${C.ms(a.dummy.m.burst)}`, `행동당 ${fmt(a.dummy.m.perAct && a.dummy.m.perAct.mean)}`, `최대 1회 ${fmt(a.dummy.m.maxHit && a.dummy.m.maxHit.max)}`);
    if (a.endurance) parts.push(`생존점수 ${C.ms(a.endurance.m.survival)}`, `무사망 ${fmt(100 * (a.endurance.m.zeroDeath ? a.endurance.m.zeroDeath.mean : 0), 0)}% (${a.endurance.n}회)`, `평균 사망 ${fmt(a.endurance.m.deaths && a.endurance.m.deaths.mean, 2)}`, `잔여HP ${fmt(a.endurance.m.hpLeft && a.endurance.m.hpLeft.mean, 0)}%`);
    if (a.stage) parts.push(`승률 ${fmt(100 * (a.stage.m.win ? a.stage.m.win.mean : 0), 0)}%`, `클리어 ${fmt(a.stage.m.clearTurns && a.stage.m.clearTurns.mean, 1)}기준턴`, `사망 ${fmt(a.stage.m.deaths && a.stage.m.deaths.mean, 2)}`);
    const stk = Object.values(a).reduce((m, x) => Math.max(m, (x && x.maxStack) || 0), 0);
    if (stk >= 5) parts.push(`같은 버프 최대 ${stk}중첩`);
    return parts.join(' · ');
  };
  C.scoreDefs = function (res) {
    const b = res.benches, out = [];
    if (b.dummy) out.push(`지속 DPS = ${b.dummy.label}에게 준 총 피해 ÷ 경과 기준턴 (1기준턴 = 속도 4인 유닛이 한 번 행동하는 시간, AP 시간 25). 순간 화력 = 처음 ${b.dummy.cfg.burstTurns}기준턴 동안의 누적 피해.`);
    if (b.endurance) out.push(`생존 점수 = 70×(구성원 평균 생존 시간 비율) + 20×(전원 생존 여부) + 10×(남은 HP 비율). 벤치: ${b.endurance.label}. 적은 실제 AI로 공격하고 HP만 늘려 쉽게 죽지 않게 함.`);
    if (b.stage) out.push(`클리어 점수 = 승리 시 100 − 클리어 기준턴 (최소 10), 패배 시 10×클리어 웨이브 비율. 벤치: ${b.stage.label}.`);
    if (res.config.objectives.includes('balanced')) out.push(`종합 지수 = 가중치(${Object.entries(res.config.weights).filter(([, w]) => w > 0).map(([k, w]) => C.OBJ[k].label + '×' + w).join(', ')})로 각 점수를 "기준 분대+1 평균"으로 나눈 값의 가중 평균 ×100.`);
    return out;
  };
  C.reportMarkdown = function (res, opts) {
    opts = opts || {};
    const nm = (k) => (res.names && res.names[k]) || k;
    const L = [];
    const cfg = res.config;
    L.push(`# 조합 분석 리포트`, '');
    L.push(`- 생성: ${new Date().toISOString()} · 소요 ${fmt(res.elapsedMs / 1000, 1)}초 · 분대 평가 ${res.evals}회 (전투 ${res.battles}회, 캐시 ${res.cacheHits})${res.stopped ? ' · **중지됨 (부분 결과)**' : ''}`);
    L.push(`- 가정: 등급 ${cfg.assume.grade === 'max' ? '최대' : cfg.assume.grade === 'start' ? '시작' : cfg.assume.grade}, 레벨 ${cfg.assume.level}, 스킬 레벨 ${cfg.assume.skillLevel}, 장비/코어링크 없음`);
    L.push(`- 후보 ${res.pool}명 · 탐색 시드 ${cfg.seeds}개 · 검증 시드 ${cfg.verifySeeds}개 · 예산 ${cfg.budget}${cfg.locked && cfg.locked.length ? ' · 고정: ' + cfg.locked.map(nm).join(', ') : ''}`);
    if (opts.meta) L.push(`- 데이터: ${JSON.stringify(opts.meta)}`);
    L.push('', '## 점수 정의', ...C.scoreDefs(res).map((s) => '- ' + s), '');
    for (const obj of Object.keys(res.objectives)) {
      const o = res.objectives[obj];
      L.push(`## ${o.label} (${o.unit})`, '');
      L.push(`평가 ${o.evals}회 · 전투 ${o.battles}회 · ${fmt(o.ms / 1000, 1)}초 · 세대 ${o.gens}`, '');
      if (o.callouts.length) {
        L.push('**밸런스 이상치 후보**', '');
        for (const c of o.callouts) {
          L.push(`- ${c.level === 'high' ? '**[강]**' : '[중]'} ${c.text}`);
          const e = c.evidence;
          if (!e) continue;
          if (e.formula) L.push(`  - 계산: ${e.formula}`);
          for (const [k, v] of e.rows || []) L.push(`  - ${k}: ${v}`);
          if (e.table && e.table.rows && e.table.rows.length) L.push(`  - ${e.table.head.join(' / ')}: ` + e.table.rows.map((r) => r.join(' / ')).join(' ; '));
          if (e.seeds && e.seeds.length) L.push(`  - 검증 전투별 값: ${e.seeds.map((v) => fmt(v)).join(', ')}`);
          for (const n of e.notes || []) L.push(`  - 참고: ${n}`);
        }
        L.push('');
      }
      L.push('| 순위 | 조합 (위치) | 점수 (평균 ± 표준편차) | 세부 |', '|---|---|---|---|');
      o.top.forEach((t, i) => {
        L.push(`| ${i + 1} | ${t.squad.slice().sort((a, b) => a.gridPos - b.gridPos).map((m) => `${nm(m.key)}@${m.gridPos}`).join(', ')} | ${fmt(t.score)} (탐색 ${fmt(t.search.score)}) | ${C.metricsLine(t, obj, res)} |`);
      });
      L.push('');
      for (const [i, t] of o.top.slice(0, 3).entries()) {
        L.push(`### ${i + 1}위 상세`, '', '```', ...C.gridText(t.squad, res.names).map((r) => '후열 → 전열 : ' + r), '```');
        if (t.loo) L.push('구성원별 기여 (빼면 점수가 얼마나 떨어지는가):', ...t.loo.slice().sort((a, b) => b.delta - a.delta).map((l) => `- ${nm(l.key)} @${l.gridPos} (${C.ROLE_KO[res.roles[l.key]] || ''}): ${fmt(l.delta)} (${fmt(l.pct, 0)}%)`));
        if (t.pairs) L.push('', '짝 시너지 (양수 = 함께일 때 더 강함):', ...t.pairs.slice(0, 4).map((p) => `- ${nm(p.a)} + ${nm(p.b)}: ${p.inter >= 0 ? '+' : ''}${fmt(p.inter)} (${fmt(p.pct, 0)}%)`));
        if (t.synergyX) L.push('', `구성원 단독 점수 합 ${fmt(t.soloSum)} 대비 ${fmt(t.synergyX, 2)}배`);
        const ag = Object.values(t.aggs)[0];
        if (ag && ag.members) L.push('', '구성원 평균: ' + ag.members.map((m) => `${nm(m.key)} 피해 ${fmt(m.dmg)} 치유 ${fmt(m.heal)} 받은피해 ${fmt(m.taken)} 행동 ${fmt(m.actions, 1)} 사망률 ${fmt(100 * m.deathRate, 0)}%`).join(' / '));
        L.push('');
      }
      for (const [p, sc] of Object.entries(o.screening || {})) {
        L.push(`#### 1차 선별 (${C.OBJ[p].label})`, '', `기준 분대: ${sc.ref4.map(nm).join(', ')} (점수 ${fmt(sc.refScore)})`, '',
          '단독 상위: ' + sc.soloTop.slice(0, 10).map((x) => `${nm(x.key)} ${fmt(x.v)}`).join(', '), '',
          '기준 분대에 추가 시 증가량 상위: ' + sc.ctxTop.slice(0, 10).map((x) => `${nm(x.key)} +${fmt(x.delta)}`).join(', '), '');
      }
    }
    if (res.engineFlags && res.engineFlags.length) { L.push('## 엔진 경고 (오류/진행불가로 끝난 전투)', ...res.engineFlags.slice(0, 15).map((f) => `- [${f.bench}] ${f.squad}: ${f.msg}`), ''); }
    L.push('## 해석 시 주의', ...C.caveats().map((c) => '- ' + c));
    return L.join('\n');
  };
  C.caveats = () => [
    '허수아비는 행동하지 않고 매 행동 후 HP가 회복된다: 적 처치 시 발동 효과(처치 후 재행동 등), 적 행동에 반응하는 효과(반격·보호)는 DPS 벤치에서 나타나지 않는다. 이런 효과는 "스테이지 클리어" 목표로 확인.',
    '허수아비의 실제 HP는 명목 HP×1000(죽지 않게)이며, "대상 최대/현재 HP 비례" 피해는 명목 HP 기준으로 환산해 집계한다. 명목 HP 배율 설정에 따라 이 피해가 달라진다.',
    '중첩 형태 4(__MAX__)이고 최대 중첩이 없는 버프는 걸릴 때마다 새 인스턴스가 추가된다(클라이언트 Creature.ApplyBuff와 동일한 포팅). 특히 TURN_START_ALL 트리거 + AURA 지속 버프는 모든 유닛의 턴 시작마다 쌓이고 시전자가 죽기 전까지 사라지지 않아, 긴 전투일수록 피해가 폭증한다. "같은 버프 최대 N중첩" 지표가 크면 실제 게임에서도 같은지 우선 확인할 것.',
    '장비, 코어 링크, 호감도, 확장 패시브(ExtPassive)는 반영하지 않는다 (모든 전투원 동일 조건).',
    '서버 결정값(웨이브 몹그룹 선택 등)과 클라이언트 연출 대기는 근사이며, 이 시뮬레이터 엔진의 미구현/오차가 그대로 점수에 반영된다. 이상치는 반드시 실제 클라이언트에서 재현 확인.',
    '1차 선별은 "단독" 및 "기준 분대+1" 맥락에서 하므로, 특정 조합에서만 강한 전투원은 후보에서 빠질 수 있다 (풀을 직접 좁히거나 고정 멤버로 확인).',
  ];
  C.reportHtml = function (res, opts) {
    const md = C.reportMarkdown(res, opts);
    const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    const lines = md.split('\n');
    const out = [];
    let inTable = false, inCode = false, inList = false;
    const inline = (s) => esc(s).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
    const closeList = () => { if (inList) { out.push('</ul>'); inList = false; } };
    for (const l of lines) {
      if (l.startsWith('```')) { closeList(); out.push(inCode ? '</pre>' : '<pre>'); inCode = !inCode; continue; }
      if (inCode) { out.push(esc(l)); continue; }
      if (l.startsWith('|')) {
        closeList();
        if (/^\|[-| ]+\|$/.test(l)) continue;
        const cells = l.slice(1, -1).split('|').map((c) => c.trim());
        if (!inTable) { out.push('<div class="tw"><table><tr>' + cells.map((c) => '<th>' + inline(c) + '</th>').join('') + '</tr>'); inTable = true; }
        else out.push('<tr>' + cells.map((c) => '<td>' + inline(c) + '</td>').join('') + '</tr>');
        continue;
      }
      if (inTable) { out.push('</table></div>'); inTable = false; }
      const h = /^(#+) (.*)$/.exec(l);
      if (h) { closeList(); out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`); continue; }
      if (l.startsWith('- ')) { if (!inList) { out.push('<ul>'); inList = true; } out.push('<li>' + inline(l.slice(2)) + '</li>'); continue; }
      closeList();
      if (l.trim()) out.push('<p>' + inline(l) + '</p>');
    }
    closeList(); if (inTable) out.push('</table></div>');
    return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>조합 분석 리포트</title>
<style>:root{--bg:#f3f4f2;--panel:#fff;--ink:#15181a;--ink3:#80878c;--rule:#dfe2df;--accent:#c2410c}
@media (prefers-color-scheme:dark){:root{--bg:#111315;--panel:#191c1f;--ink:#eceeee;--ink3:#868d92;--rule:#2c3135;--accent:#f07a3e}}
body{background:var(--bg);color:var(--ink);font-family:"IBM Plex Sans KR","Malgun Gothic",system-ui,sans-serif;font-size:14px;line-height:1.55;max-width:1100px;margin:0 auto;padding:16px}
h1{font-size:22px}h2{font-size:17px;border-bottom:2px solid var(--accent);padding-bottom:4px;margin-top:28px}h3{font-size:15px}h4{font-size:13px;color:var(--ink3)}
.tw{overflow-x:auto}table{border-collapse:collapse;width:100%;font-size:12px;background:var(--panel)}th,td{border-bottom:1px solid var(--rule);padding:5px 8px;text-align:left;vertical-align:top}th{color:var(--ink3);font-weight:500}
pre{background:var(--panel);border:1px solid var(--rule);border-radius:6px;padding:8px;font-family:"IBM Plex Mono",Consolas,monospace;font-size:12px;overflow-x:auto}</style></head><body>${out.join('\n')}</body></html>`;
  };
})();
