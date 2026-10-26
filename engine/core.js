// LOSim core: shared data model, helpers and module contracts for the browser battle simulator.
// Ported from the Unity client (E:\LAO\1_Onestre_QA\Assets\_Scripts), battle renewal path
// (BEFORE_BATTLE_RENEWAL NOT defined). Plain script (no ES modules): every module attaches to window.LOSim.
//
// Load order (index.html and tools/node_harness.js):
//   enums.js, core.js, stats.js, buffs.js, combat.js, ai.js, battle.js
//
// Module ownership / contracts (each file exports onto LOSim.<name>):
//   LOSim.stats  (stats.js)  -- port of Utils/ActorAttr.cs + Creature.UpdateAttr/attr getters
//       buildPC(spec) -> Unit           spec = PCSpec (below)
//       buildMonster(key, level, opts) -> Unit     opts = {gridPos, wave, isIW}
//       buildSummon(key, level, owner, gridPos) -> Unit
//       recalc(unit, battle)            recompute unit.attr from unit.base + active buffs (Creature.UpdateAttr)
//       getTurnSpeed(unit), getAtk(unit) ... thin getters mirroring Creature.GetTurnSpeed()/GetATk() etc.
//   LOSim.buffs  (buffs.js)  -- port of Buff.cs, LOEffect.cs, CreatureBuffEffect.cs, Creature buff handling
//       apply(battle, src, target, effectKey, level, ctx) -> appliedBuff|null
//       trigger(battle, triggerType, ctx)   fire BUFFEFFECT_TRIGGER_TYPE hooks on every unit (ROUND_START, TURN_START, HIT, KILL, ...)
//       onTurnEnd(battle, unit)             duration ticks (renewal: owner turn end, LOEffect.cs)
//       onWaveEnd(battle)
//       value(unit, BUFFEFFECT_TYPE) -> number      Creature.GetBuffEffectValue
//       has(unit, BUFFEFFECT_TYPE) -> buff|null     ActiveBuffList.CheckExistBuff
//       remove(battle, unit, predicate)
//   LOSim.combat (combat.js) -- port of Creature skill execution / damage / hit / crit / grid targeting
//       canUse(battle, unit, skill) -> bool          range, cooldown, conditions
//       targets(battle, unit, skill, mainTarget) -> [{unit, gridRate}]  TARGET_TYPE + Table_Grid
//       execute(battle, unit, skill, mainTarget) -> ActionResult   full action incl. protect/guard, counter, assist, chain, summon, reserve skills
//   LOSim.ai     (ai.js)     -- monster Lua AI (CreatureAI.cs API via fengari) + PC auto battle AI (BTAI/Actions/Auto)
//       choose(battle, unit) -> {skill, target} | {wait:true} | {move:gridPos}
//   LOSim.battle (battle.js) -- port of BattleRoundManager / BattleManager loop, renewal AP gauge
//       create(setup) -> Battle            setup = {stageKey, mode:'stage'|'ew'|'iw', squad:[PCSpec], seed, options}
//       run(battle, {maxActions}) -> BattleResult
//       step(battle) -> one action (for UI replay)
//
// Everything is deterministic given `seed` (use battle.rng(), never Math.random()).

(function () {
  const LOSim = (window.LOSim = window.LOSim || {});
  const E = LOSim.E;

  // ---------- data access ----------
  // Tables are compacted: default values (0, '', '0', [], ['0']) are omitted. Always read via num()/str()/list().
  LOSim.data = null; // {stages, units, skills, buffs, loc, lua} loaded by LOSim.load()
  LOSim.T = function (table, key) {
    const D = LOSim.data;
    for (const g of ['stages', 'units', 'skills', 'buffs']) {
      const t = D[g][table];
      if (t) return key === undefined ? t : t[key] || null;
    }
    return null;
  };
  LOSim.num = (row, k, def = 0) => {
    if (!row) return def;
    const v = row[k];
    if (v === undefined || v === null || v === '') return def;
    const n = typeof v === 'number' ? v : parseFloat(v);
    return Number.isFinite(n) ? n : def;
  };
  LOSim.str = (row, k, def = '') => {
    const v = row && row[k];
    return v === undefined || v === null || v === '0' ? def : String(v);
  };
  LOSim.list = (row, k) => {
    const v = row && row[k];
    if (v === undefined || v === null) return [];
    return (Array.isArray(v) ? v : [v]).filter((x) => x !== '' && x !== '0' && x !== null);
  };
  LOSim.name = (locKey, fallback) => (LOSim.data && LOSim.data.loc[locKey]) || fallback || locKey;

  LOSim.load = async function (base = 'data/') {
    const files = ['stages', 'units', 'skills', 'buffs', 'loc', 'lua'];
    const out = {};
    await Promise.all(files.map(async (f) => { out[f] = await (await fetch(base + f + '.json')).json(); }));
    LOSim.data = out;
    return out;
  };

  // ---------- constants (GlobalDefines.cs Const) ----------
  LOSim.C = {
    ACTIVE_ROUND: 100, // renewal AP threshold (GlobalDefines.cs:479)
    GRID: 9,           // 3x3 grid per side, index 0..8
    SKILLKEY_WAIT: 'Wait', SKILLKEY_MOVE: 'Move', // overwrite in battle.js if Const differs
  };

  // ---------- what-if overrides (data patches applied around a simulation, then reverted) ----------
  // rules: [{ table, keys?: '*'|key|[keys], where?: {field|prefix*: value|[values]}, field: name|prefix*, op?: 'set'|'mul'|'add'|'clear', value? }]
  //        | { const: 'ACTIVE_ROUND', value }   (LOSim.C constants)
  // Compacted rows omit defaults, so a missing field reads as 0 / '' in `where` and as 0 for mul/add.
  // Returns { summary:[{rule, rows, sample:[{key, field, from, to}]}], revert() }.
  const isDef = (v) => v === undefined || v === null || v === '' || v === '0' || v === 0;
  function ovMatch(row, f, want) {
    const ws = Array.isArray(want) ? want : [want];
    const fields = f.endsWith('*') ? Object.keys(row).filter((k) => k.startsWith(f.slice(0, -1))) : [f];
    const vals = fields.map((k) => row[k]);
    if (f.endsWith('*') && !vals.length) vals.push(undefined);
    return vals.some((v) => ws.some((w) => (isDef(v) && isDef(w)) || String(v) === String(w) || (v !== undefined && Number(v) === Number(w) && String(w).trim() !== '')));
  }
  LOSim.ovMatch = ovMatch;
  LOSim.applyOverrides = function (rules) {
    const undo = [];
    const summary = [];
    for (const r of Array.isArray(rules) ? rules : rules ? [rules] : []) {
      if (r.const) {
        if (!(r.const in LOSim.C)) throw new Error('unknown const ' + r.const + ' (have ' + Object.keys(LOSim.C).join(',') + ')');
        const from = LOSim.C[r.const];
        undo.push(() => { LOSim.C[r.const] = from; });
        LOSim.C[r.const] = r.value;
        summary.push({ rule: r, rows: 1, sample: [{ key: 'LOSim.C', field: r.const, from, to: r.value }] });
        continue;
      }
      const t = LOSim.T(r.table);
      if (!t) throw new Error('unknown table ' + r.table);
      if (!r.field) throw new Error('rule needs field');
      const op = r.op || 'set';
      if (!['set', 'mul', 'add', 'clear'].includes(op)) throw new Error('op must be set|mul|add|clear');
      const keys = r.keys === undefined || r.keys === '*' ? Object.keys(t) : (Array.isArray(r.keys) ? r.keys : [r.keys]).map(String);
      let n = 0;
      const sample = [];
      for (const k of keys) {
        const row = t[k];
        if (!row) { if (r.keys !== undefined && r.keys !== '*') throw new Error('no row ' + k + ' in ' + r.table); continue; }
        if (r.where && !Object.entries(r.where).every(([f, w]) => ovMatch(row, f, w))) continue;
        const fields = r.field.endsWith('*') ? Object.keys(row).filter((x) => x.startsWith(r.field.slice(0, -1))) : [r.field];
        let hit = false;
        for (const f of fields) {
          const had = Object.prototype.hasOwnProperty.call(row, f);
          const from = row[f];
          let to;
          if (op === 'set') to = r.value;
          else if (op === 'clear') to = undefined;
          else {
            if (Array.isArray(from)) continue;
            const base = LOSim.num(row, f);
            to = op === 'mul' ? base * Number(r.value) : base + Number(r.value);
          }
          if (to === from) continue;
          undo.push(() => { if (had) row[f] = from; else delete row[f]; });
          if (to === undefined) delete row[f]; else row[f] = to;
          hit = true;
          if (sample.length < 8) sample.push({ key: k, field: f, from: from === undefined ? '(기본값)' : from, to: to === undefined ? '(기본값)' : to });
        }
        if (hit) n++;
      }
      summary.push({ rule: r, rows: n, sample });
    }
    let done = false;
    return { summary, revert() { if (done) return; done = true; for (let i = undo.length - 1; i >= 0; i--) undo[i](); } };
  };
  // run fn with overrides applied, always reverting (sync or async)
  LOSim.withOverrides = function (rules, fn) {
    if (!rules || (Array.isArray(rules) && !rules.length)) return fn(null);
    const ov = LOSim.applyOverrides(rules);
    let res;
    try { res = fn(ov.summary); } catch (e) { ov.revert(); throw e; }
    if (res && typeof res.then === 'function') return res.finally(() => ov.revert());
    ov.revert();
    return res;
  };

  // ---------- RNG (mulberry32) ----------
  LOSim.makeRng = function (seed) {
    let a = seed >>> 0;
    const r = () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    r.int = (n) => Math.floor(r() * n);      // 0..n-1 (Common.GetRandomValue semantics: check and match)
    r.chance = (p) => r() < p;
    return r;
  };

  // ---------- Unit (mirrors Creature) ----------
  // attr / base are [VALUE_TYPE][ACTOR_ATTR_TYPE] arrays exactly like Creature.attrValue / baseAttrValue.
  const NV = () => (E.VALUE_TYPE.__MAX__ || 2);
  const NA = () => (E.ACTOR_ATTR_TYPE.__MAX__ || 17);
  LOSim.newAttr = () => Array.from({ length: NV() }, () => new Array(NA()).fill(0));

  let nextAid = 1;
  LOSim.Unit = class Unit {
    constructor(o) {
      this.aid = nextAid++;
      this.type = o.type;            // 'CHARACTER' | 'MONSTER' | 'SUMMON'  (eCreatureType)
      this.team = o.team;            // 1 = player (TeamType 1), 0 = enemy (TeamType 0)
      this.key = o.key;              // table key (Char_..., MOB_..., SUMMON_...)
      this.table = o.table;          // Table_PC | Table_Monster | Table_Summon row
      this.ability = o.ability;      // *Ability row
      this.level = o.level || 1;
      this.grade = o.grade || 0;
      this.gridPos = o.gridPos;      // 0..8 on its own side
      this.base = LOSim.newAttr();   // baseAttrValue (no buffs)
      this.attr = LOSim.newAttr();   // attrValue (with buffs) -- read through LOSim.stats getters
      this.hp = 0; this.maxHp = 0;
      this.turnPos = 0;              // renewal AP 0..100 (Creature.TurnPos)
      this.skills = [];              // [{key, level, slot, table, levelTable, cooldownLeft}]  slot 1..n
      this.buffs = [];               // active LOEffect/Buff instances (buffs.js owns the shape)
      this.aiKey = o.aiKey || '';    // Lua AI name for monsters/summons
      this.flags = {};               // free-form per-module state (counter used this round, etc.)
      this.stats = { dmgDealt: 0, dmgTaken: 0, healDone: 0, kills: 0, actions: 0, skillUse: {} };
    }
    get alive() { return this.hp > 0; }
    get name() { return LOSim.name(this.table && this.table.Name, this.key); }
  };

  // ---------- PCSpec (what the UI / Claude tools pass in) ----------
  // { key:'Char_BR_PA00EL_N', grade:3..5, level:1..120, gridPos:0..8,
  //   skillLevels:[lv1..lvN] (default 1 each), equips:[{key:'Equip_Chip_Atk_T1', enchant:0..10}] (up to 4),
  //   coreLink:0..5 (full link slots, default 0), favor:0..200, linkBonusKey:'' (FullLink bonus choice) }

  // ---------- battle log ----------
  LOSim.log = function (battle, type, data) {
    if (!battle.logEnabled) return;
    battle.log.push(Object.assign({ round: battle.round, t: type }, data));
  };
})();
