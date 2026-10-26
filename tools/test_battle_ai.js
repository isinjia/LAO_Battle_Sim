// Scenario checks for ai.js / battle.js:  node test_battle_ai.js
// Reuses node_harness.js loading (stubs for missing modules) by requiring it with no CLI args suppressed.
'use strict';
process.argv = [process.argv[0], __filename, '--all-lua']; // harness main() prints the compile report
require('./node_harness.js');
const LOSim = window.LOSim;
const E = LOSim.E;
let fail = 0;
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fail++; };
const squad = [
  { key: 'Char_BR_PA00EL_N', grade: 3, level: 30, gridPos: 2 },
  { key: 'Char_3P_Daphne_N', grade: 3, level: 30, gridPos: 5 },
];
function mk(seed, mutate) {
  const b = LOSim.battle.create({ stageKey: 'Ch01Stage01', squad, seed });
  if (mutate) mutate(b);
  return b;
}

// 1. Lua load (syntax) error -> thrown like SLua doBuffer -> battle ends 'error' with luaLoadError
{
  const b = mk(1);
  LOSim.battle.step(b); // wave spawn + first action
  for (const u of b.units) if (u.type === 'MONSTER') u.aiKey = 'AI_MP_MarionnetteHW_BOSS_01';
  const r = LOSim.battle.run(b);
  ok(r.outcome === 'error' && r.errors[0] && r.errors[0].luaLoadError, 'syntax error script -> outcome error (' + r.reason + ')');
}
// 2. Lua runtime error -> caught, recorded in luaErrors, fallback Move/Wait, battle continues
{
  const b = mk(2);
  LOSim.battle.step(b);
  LOSim.data.lua.AI_TEST_RuntimeErr = 'function Process() CreatureAI.wait() end'; // lowercase wait: same bug as AI_MP_Fire_Controller_01 etc.
  for (const u of b.units) if (u.type === 'MONSTER') u.aiKey = 'AI_TEST_RuntimeErr';
  const r = LOSim.battle.run(b);
  delete LOSim.data.lua.AI_TEST_RuntimeErr;
  ok(r.outcome !== 'error' && r.luaErrors.some((e) => e.kind === 'runtime'), 'runtime-error script keeps running (outcome ' + r.outcome + ', luaErrors ' + r.luaErrors.length + ': ' + (r.luaErrors[0] && r.luaErrors[0].msg) + ')');
}
// 3. Missing AI file -> stale global Process used, recorded as missing-file
{
  const b = mk(3);
  LOSim.battle.step(b);
  for (const u of b.units) if (u.type === 'MONSTER') u.aiKey = 'AI_TEST_Normal_01';
  const r = LOSim.battle.run(b);
  ok(r.luaErrors.some((e) => e.kind === 'missing-file'), 'missing script recorded (outcome ' + r.outcome + ')');
}
// 4. Everyone AP_STOP -> 'stuck'
{
  const savedHas = LOSim.buffs.has;
  LOSim.buffs.has = (u, t) => (t === E.BUFFEFFECT_TYPE.STAGE_AP_STOP ? { type: t } : savedHas.call(LOSim.buffs, u, t));
  const r = LOSim.battle.run(mk(4));
  LOSim.buffs.has = savedHas;
  ok(r.outcome === 'stuck', 'all AP_STOP -> stuck: ' + r.reason);
}
// 5a. STAGE_DOUBLE_ATTACK_RATIO re-arms on the double action itself (coBattleAI checks every non-reserve turn),
//     so while the buff persists the unit keeps acting inside the same round.
{
  const savedHas = LOSim.buffs.has;
  LOSim.buffs.has = (u, t) => ((u.team === 1 && t === E.BUFFEFFECT_TYPE.STAGE_DOUBLE_ATTACK_RATIO) ? { type: t } : savedHas.call(LOSim.buffs, u, t));
  const b = mk(5); const recs = [];
  while (!b.result) recs.push(LOSim.battle.step(b));
  LOSim.buffs.has = savedHas;
  const dbl = recs.filter((r) => r.turnType === 'double').length;
  ok(dbl >= 2, 'double action chains while buff persists: ' + dbl + ' double actions, outcome ' + b.result);
}
// 5b. Double action armed, but the main action ends as Wait (cooldown/seal/no target inside DoTurnAction):
//     DoubleActionTurn is never cleared, the turn-end block is skipped forever -> round never changes -> 'stuck'
{
  const savedHas = LOSim.buffs.has, savedExec = LOSim.combat.execute;
  LOSim.buffs.has = (u, t) => ((u.team === 1 && t === E.BUFFEFFECT_TYPE.STAGE_DOUBLE_ATTACK_RATIO) ? { type: t } : savedHas.call(LOSim.buffs, u, t));
  LOSim.combat.execute = function (b, u, sk, m, o) {
    if (u.team === 1 && !(o && (o.isDoubleAction || o.isReserve || o.isCounter || o.isAssist))) return LOSim.combat.wait(b, u, { actor: u, ok: false, skillKey: sk.key, hits: [], skipped: 'cooldown(sim)' });
    return savedExec.apply(this, arguments);
  };
  const r = LOSim.battle.run(mk(6));
  LOSim.buffs.has = savedHas; LOSim.combat.execute = savedExec;
  ok(r.outcome === 'stuck', 'double-action + wait: ' + r.outcome + ' / ' + r.reason);
}
// 6. Determinism
{
  const a = JSON.stringify(LOSim.battle.run(mk(7)).perUnit), c = JSON.stringify(LOSim.battle.run(mk(7)).perUnit);
  ok(a === c, 'same seed -> same result');
}
// 7. timeout cap
{
  const b = LOSim.battle.create({ stageKey: 'Ch04Stage03', squad, seed: 1, options: { maxActions: 5 } });
  const r = LOSim.battle.run(b);
  ok(r.outcome === 'timeout' && r.totalActions === 5, 'maxActions cap -> timeout');
}
// 8. step() returns replay records
{
  const b = mk(8); const recs = [];
  while (!b.result) recs.push(LOSim.battle.step(b));
  ok(recs.length > 1 && recs[0].type === 'action' && recs[recs.length - 1].type === 'end', 'step records: ' + recs.length);
}
// 9. choose() contract
{
  const b = mk(9); LOSim.battle.step(b);
  const m = b.units.find((u) => u.type === 'MONSTER' && u.hp > 0);
  m.reserveSkillList.length = 0; m.turnPos = 100; m.turnInfo = { reserveRound: b.round };
  const c = LOSim.ai.choose(b, m);
  ok(c && (c.skill || c.wait || c.move !== undefined), 'choose(monster) -> ' + JSON.stringify({ skill: c.skill && c.skill.key, wait: c.wait, move: c.move }));
}
console.log(fail ? fail + ' FAILED' : 'all passed');
process.exitCode = fail ? 1 : 0;
