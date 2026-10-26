// Node harness for the LOSim engine.
//   node node_harness.js <stageKey> [seed] [--mode stage|ew|iw] [--max N] [--log] [--json]
//   node node_harness.js --all-lua          compile every Lua AI script and report load errors
// Loads engine/*.js in the browser order (missing modules are replaced by the STUBS below, clearly marked).
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

global.window = global;
global.fengari = require('fengari');
window.fengari = global.fengari;

const ROOT = path.join(__dirname, '..');
const ENGINE = path.join(ROOT, 'engine');
const loaded = {};
function load(name) {
  const p = path.join(ENGINE, name + '.js');
  if (!fs.existsSync(p)) { loaded[name] = false; return false; }
  vm.runInThisContext(fs.readFileSync(p, 'utf8'), { filename: p });
  loaded[name] = true;
  return true;
}

load('enums');
load('core');
const LOSim = window.LOSim;
LOSim.data = {};
for (const f of ['stages', 'units', 'skills', 'buffs', 'loc', 'lua']) LOSim.data[f] = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', f + '.json'), 'utf8'));
for (const m of ['stats', 'buffs', 'combat', 'ai', 'battle']) load(m);

// ====================================================================== STUBS (only used when a module file is missing)
const E = LOSim.E;
const ABS = E.VALUE_TYPE.ABS, AT = E.ACTOR_ATTR_TYPE;
function stubSkills(groupKey, levels) {
  const g = LOSim.T('Table_SkillGroup', groupKey);
  const out = [];
  for (let i = 1; i <= 2; i++) {
    const key = LOSim.str(g, 'SkillIndex' + i);
    if (!key) continue;
    const lv = (levels && levels[i - 1]) || LOSim.num(g, 'SkillDefaultLevel' + i, 1);
    const table = LOSim.T('Table_Skill', key);
    const levelTable = LOSim.T('Table_SkillLevel', key + '_Lv' + lv) || LOSim.T('Table_SkillLevel', key + '_Lv1');
    out.push({ key, level: lv, slot: LOSim.num(table, 'SkillSlotType', i), table, levelTable, cooldownLeft: 0 });
  }
  return out;
}
function stubUnit(type, team, key, table, ability, level, gridPos) {
  const u = new LOSim.Unit({ type, team, key, table, ability, level, gridPos, aiKey: LOSim.str(table, 'AIKeyString') });
  const hp = LOSim.num(ability, 'DefaultHP', 100) + LOSim.num(ability, 'DefaultHPByLevel') * (level - 1);
  u.hp = u.maxHp = Math.round(hp);
  u.base[ABS][AT.ATK] = u.attr[ABS][AT.ATK] = LOSim.num(ability, 'AttackDmg', 10) + LOSim.num(ability, 'AddAttackDmgByLevel') * (level - 1);
  u.base[ABS][AT.TURNSPEED] = u.attr[ABS][AT.TURNSPEED] = LOSim.num(ability, 'TurnSpeed', 3);
  u.skills = stubSkills(LOSim.str(table, 'SkillGroupIndex'));
  return u;
}
if (!loaded.stats) {
  LOSim.stats = { // STUB -- stats.js missing
    buildPC(spec) { const t = LOSim.T('Table_PC', spec.key); return stubUnit('CHARACTER', 1, spec.key, t, LOSim.T('Table_PCAbility', spec.key), spec.level || 1, spec.gridPos); },
    buildMonster(key, level, o) {
      const t = (o && o.isIW && LOSim.T('Table_MonsterIW', key)) || LOSim.T('Table_Monster', key);
      return stubUnit('MONSTER', 0, key, t, LOSim.T('Table_MonsterAbility', key), level, o.gridPos);
    },
    recalc() {},
    getTurnSpeed(u) { return u.attr[ABS][AT.TURNSPEED]; },
    getAtk(u) { return u.attr[ABS][AT.ATK]; },
  };
}
if (!loaded.buffs) {
  LOSim.buffs = { // STUB -- buffs.js missing: no buffs at all
    apply() { return null; }, trigger() {}, onTurnEnd() {}, onWaveEnd() {}, onWaveStart() {},
    value() { return 0; }, has() { return null; }, remove() {}, applyEquipAndPassives() {},
  };
}
if (!loaded.combat) {
  LOSim.combat = { // STUB -- combat.js missing: single-target damage = ATK * SkillAttackRate, no hit/crit/def
    targets(b, a, s, main, gridPos) {
      if (main) return [{ unit: main, gridRate: 1 }];
      if (gridPos !== undefined && gridPos !== 255) {
        const t = b.units.find((u) => u.hp > 0 && !u.removed && u.team !== a.team && u.gridPos === gridPos);
        return t ? [{ unit: t, gridRate: 1 }] : [];
      }
      return [];
    },
    execute(b, a, s, main, o) {
      const tl = this.targets(b, a, s, main, o && o.gridPos);
      const tt = LOSim.num(s.table, 'TargetType');
      if (tt === E.TARGET_TYPE.SELF || tt === E.TARGET_TYPE.OUR || tt === E.TARGET_TYPE.OUR_GRID) return { hits: 0 };
      let dealt = 0;
      for (const { unit: t } of tl) {
        if (t.team === a.team) continue;
        const dmg = Math.max(1, Math.round(LOSim.stats.getAtk(a) * (parseFloat(LOSim.str(s.levelTable, 'SkillAttackRate', '1')) || 1)));
        t.hp = Math.max(0, t.hp - dmg); dealt += dmg;
        a.stats.dmgDealt += dmg; t.stats.dmgTaken += dmg;
        t.flags.beAttacked = true; t.flags.attackerAid = a.aid;
        if (t.hp <= 0) a.stats.kills++;
      }
      return { hits: tl.length, dmg: dealt };
    },
  };
}
// ======================================================================

function defaultSquad() {
  const pcs = Object.values(LOSim.data.units.Table_PC).filter((p) => p.StartGrade === 3 && p.IsUse === 1).map((p) => p.Key).sort();
  const grid = [2, 5, 8, 4, 0]; // front x3 (PC front column is 2/5/8), mid 4, back 0
  return pcs.slice(0, 5).map((key, i) => ({ key, grade: 3, level: 30, gridPos: grid[i] }));
}

function allLua() {
  const errs = LOSim.ai.compileAll(LOSim.data.lua);
  const n = Object.keys(LOSim.data.lua).length;
  console.log('compiled ' + n + ' Lua AI scripts, ' + Object.keys(errs).length + ' load errors');
  for (const [k, v] of Object.entries(errs)) console.log('  ' + k + ': ' + v);
  // scripts referenced by tables but missing from data/lua.json
  const used = new Set();
  for (const t of ['Table_Monster', 'Table_MonsterIW', 'Table_Summon']) for (const r of Object.values(LOSim.data.units[t] || {})) if (r.AIKeyString) used.add(r.AIKeyString);
  const missing = [...used].filter((k) => !(k in LOSim.data.lua));
  console.log(missing.length + ' AIKeyString referenced by Table_Monster/IW/Summon without a script' + (missing.length ? ': ' + missing.slice(0, 30).join(', ') + (missing.length > 30 ? ' ...' : '') : ''));
}

function main() {
  const argv = process.argv.slice(2);
  console.log('modules: ' + Object.entries(loaded).map(([k, v]) => k + (v ? '' : '(STUB)')).join(' '));
  if (argv.includes('--all-lua')) { allLua(); return; }
  const flag = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
  const pos = argv.filter((a, i) => !a.startsWith('--') && !(i > 0 && argv[i - 1].startsWith('--') && ['--mode', '--max'].includes(argv[i - 1])));
  const stageKey = pos[0] || 'Ch01Stage01';
  const seed = parseInt(pos[1] || '1', 10);
  const squad = defaultSquad();
  console.log('stage ' + stageKey + ' seed ' + seed + ' squad ' + squad.map((s) => s.key + '@' + s.gridPos).join(', '));
  const b = LOSim.battle.create({ stageKey, mode: flag('--mode') || 'stage', squad, seed, logEnabled: argv.includes('--log'), options: { maxActions: parseInt(flag('--max') || '3000', 10) } });
  const t0 = Date.now();
  const r = LOSim.battle.run(b);
  const ms = Date.now() - t0;
  if (argv.includes('--log')) for (const l of b.log) console.log(JSON.stringify(l));
  if (argv.includes('--json')) { console.log(JSON.stringify(r, null, 1)); return; }
  console.log('---- BattleResult (' + ms + ' ms)');
  console.log({ outcome: r.outcome, reason: r.reason, waveReached: r.waveReached, wavesCleared: r.wavesCleared, maxWave: r.maxWave, totalActions: r.totalActions, rounds: r.rounds, survivors: r.survivors, hpLeftPct: r.hpLeftPct, waves: r.waves });
  console.table(r.perUnit.map((u) => ({ key: u.key, team: u.team, dmgDealt: u.dmgDealt, dmgTaken: u.dmgTaken, kills: u.kills, actions: u.actions, alive: u.alive })));
  if (r.errors.length) console.log('errors:', JSON.stringify(r.errors, null, 1));
  const le = {};
  for (const e of r.luaErrors) { const k = e.kind + ' ' + e.aiKey + ' ' + (e.msg || ''); le[k] = (le[k] || 0) + 1; }
  if (Object.keys(le).length) { console.log('lua errors (count x kind aiKey msg):'); for (const [k, v] of Object.entries(le)) console.log('  ' + v + ' x ' + k); }
}
main();
