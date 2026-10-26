// node inspect_run.js <stageKey> <level> [seed]  -- runs the app's default squad (same pick as app.js) and prints a compact action log.
global.window = global;
global.fengari = require('fengari');
const fs = require('fs'), path = require('path');
const R = (f) => (0, eval)(fs.readFileSync(path.join(__dirname, '..', f), 'utf8'));
['engine/enums.js', 'engine/core.js', 'engine/stats.js', 'engine/buffs.js', 'engine/combat.js', 'engine/ai.js', 'engine/battle.js'].forEach(R);
const D = {}; for (const f of ['stages', 'units', 'skills', 'buffs', 'loc', 'lua']) D[f] = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', f + '.json'), 'utf8'));
LOSim.data = D;
const [stageKey = 'Ch04Stage01', lv = '50', seed = '1'] = process.argv.slice(2);
const pcs = Object.values(D.units.Table_PC).filter((p) => LOSim.num(p, 'IsUse') === 1 && LOSim.num(p, 'IsHavingTurn') === 1 && LOSim.num(p, 'StartGrade') === 3)
  .map((p) => ({ key: p.Key, name: LOSim.name(p.Name, p.Key) })).filter((p) => !/모듈|MP$/.test(p.name)).sort((a, b) => a.name.localeCompare(b.name, 'ko')).slice(0, 5);
const pos = [1, 4, 7, 3, 5];
const squad = pcs.map((p, i) => Object.assign(LOSim.stats.defaultSpec(p.key), { level: +lv, gridPos: pos[i] }));
const b = LOSim.battle.create({ stageKey, mode: 'stage', squad, seed: +seed, logEnabled: true });
const r = LOSim.battle.run(b, {});
for (const u of b.units) console.log(u.team, u.gridPos, u.key, 'Lv' + u.level, 'HP', Math.round(u.hp) + '/' + Math.round(u.maxHp), 'ATK', Math.round(LOSim.stats.getAtk(u)), 'DEF', Math.round(LOSim.stats.getDef(u)), 'SPD', LOSim.stats.getTurnSpeed(u), 'skills', u.skills.map((s) => s.key.replace(/^Skill_/, '') + ':' + s.level).join(','));
const want = new Set(['action', 'hit', 'miss', 'kill', 'wait', 'move', 'buff']);
let n = 0;
for (const e of b.log) { if (!want.has(e.t) || e.t === 'buff') continue; if (n++ > 70) break; console.log(JSON.stringify(e).slice(0, 220)); }
console.log('RESULT', r.outcome, r.reason, 'actions', r.totalActions);
