// Throwaway node test for engine/buffs.js:  node tools/test_buffs.js
global.window = global;
const fs = require('fs'), path = require('path');
const R = (p) => path.join(__dirname, '..', p);
for (const f of ['engine/enums.js', 'engine/core.js', 'engine/stats.js', 'engine/buffs.js']) if (fs.existsSync(R(f))) eval(fs.readFileSync(R(f), 'utf8'));
LOSim.data = {};
for (const f of ['stages', 'units', 'skills', 'buffs', 'loc', 'lua']) LOSim.data[f] = JSON.parse(fs.readFileSync(R('data/' + f + '.json'), 'utf8'));
const E = LOSim.E, B = LOSim.buffs, BT = E.BUFFEFFECT_TYPE, TR = E.BUFFEFFECT_TRIGGER_TYPE, A = E.ACTOR_ATTR_TYPE, VT = E.VALUE_TYPE;
let fails = 0;
const ok = (c, msg) => { console.log((c ? 'ok   ' : 'FAIL ') + msg); if (!c) fails++; };
const near = (a, b) => Math.abs(a - b) < 1e-4;

// ---- coverage
const rows = LOSim.data.buffs.Table_BuffEffect;
const use = {}; let tot = 0;
for (const r of Object.values(rows)) for (let i = 1; i <= 5; ++i) { if (!(parseFloat(r['BuffEffectRate' + i]) > 0)) continue; const t = r['BuffEffectType' + i] || 0; use[t] = (use[t] || 0) + 1; tot++; }
const by = { impl: [0, 0], flag: [0, 0], noop: [0, 0], todo: [0, 0], none: [0, 0] };
const lines = [];
for (const name of Object.keys(BT).filter((k) => k !== '__MAX__')) {
  const s = B.STATUS[name] || 'none', u = use[BT[name]] || 0;
  by[s][0]++; by[s][1] += u;
  lines.push(`//   ${String(BT[name]).padStart(3)} ${name.padEnd(38)} ${String(u).padStart(5)}  ${s}${B.NOTES[name] ? ' - ' + B.NOTES[name] : ''}`);
}
console.log('coverage by type count / usage:', JSON.stringify(by), 'total uses', tot);
ok(by.none[0] === 0, 'every BUFFEFFECT_TYPE has a status');
if (process.argv.includes('--emit-coverage')) {
  const src = fs.readFileSync(R('engine/buffs.js'), 'utf8');
  const pct = (k) => `${by[k][0]} types / ${by[k][1]} uses (${(100 * by[k][1] / tot).toFixed(1)}%)`;
  const head = `//   summary: impl ${pct('impl')}; flag ${pct('flag')}; noop ${pct('noop')}; todo ${pct('todo')}\n//   enum name                                    uses  status\n`;
  fs.writeFileSync(R('engine/buffs.js'), src.replace('// @@COVERAGE@@', head + lines.join('\n')));
  console.log('coverage table written');
}

// ---- units
function mkUnit(type, team, key, gridPos, atk) {
  const tbl = type === 'CHARACTER' ? LOSim.T('Table_PC', key) : LOSim.T('Table_Monster', key);
  const u = new LOSim.Unit({ type, team, key, table: tbl, level: 1, gridPos });
  u.base[VT.ABS][A.ATK] = atk; u.base[VT.ABS][A.DEF] = 100; u.base[VT.ABS][A.HP] = 1000; u.base[VT.RATE][A.CRI] = 0.05;
  u.base[VT.ABS][A.TURNSPEED] = 3;
  u.attr = u.base.map((r) => r.slice());
  u.hp = u.maxHp = 1000; u.equipBuffs = []; u.coreLinkFunc = { stageBuffLevelUp: 0 };
  return u;
}
let a, m;
const battle = { rng: LOSim.makeRng(12345), round: 1, log: [], logEnabled: true };
if (LOSim.stats && LOSim.stats.buildPC) {
  a = LOSim.stats.buildPC({ key: 'Char_3P_Ajax_N', grade: 3, level: 50, gridPos: 4 });
  const mobKey = Object.keys(LOSim.data.units.Table_Monster).find((k) => LOSim.data.units.Table_MonsterAbility[k]);
  m = LOSim.stats.buildMonster(mobKey, 30, { gridPos: 4 });
} else { a = mkUnit('CHARACTER', 1, 'Char_3P_Ajax_N', 4, 300); m = mkUnit('MONSTER', 0, 'MOB_MP_Stalker_B0108', 4, 200); }
battle.units = [a, m];
console.log('ajax skills', a.skills.map((s) => s.key + '@' + s.level).join(','), 'atk', LOSim.stats.getAtk(a), 'mob', m.key);

// 1) direct STAT_ATK_RATIO on Ajax via apply() (item-like path, level 1)
const atk0 = LOSim.stats.getAtk(a);
const keyAtk = Object.keys(rows).find((k) => { const r = rows[k]; return r.BuffEffectType1 === BT.STAT_ATK_RATIO && parseFloat(r.BuffEffectRate1) === 1 && !r.BuffEffectType2 && (r.BuffEffectLeftCount1 || 0) === 2 && (r.BuffEffectTriggerApplyCondition || 0) >= 63 && [63,77].includes(r.BuffEffectTriggerApplyCondition) && [63,77].includes(r.BuffEffectTriggerApplyCondition2) && (r.BuffEffectTriggerApplyCondition2 || 0) >= 63 && r.BuffEffectValue1 && !r.BuffEffectLevelValue1 && [0,5].includes(r.BuffEffectEraseType || 0); });
const b1 = B.apply(battle, a, a, keyAtk, 1, {});
ok(!!b1, 'apply ' + keyAtk);
const v = parseFloat(rows[keyAtk].BuffEffectValue1);
ok(near(B.value(a, BT.STAT_ATK_RATIO), v), 'value(STAT_ATK_RATIO) = ' + v);
const mods = B.statMods(a);
ok(mods.length === 1 && mods[0].attr === A.ATK && mods[0].valueType === VT.RATE && near(mods[0].value, v), 'statMods ATK RATE ' + JSON.stringify(mods));
ok(near(LOSim.stats.getAtk(a), atk0 * (1 + Math.round(v * 1000) / 1000)), `atk ${atk0} -> ${LOSim.stats.getAtk(a)}`);
B.onTurnEnd(battle, a); ok(B.has(a, BT.STAT_ATK_RATIO) && b1.left === 1, 'left 2 -> 1 after owner turn end');
B.onTurnEnd(battle, m); ok(b1.left === 1, 'enemy turn end does not tick');
B.onTurnEnd(battle, a); ok(!B.has(a, BT.STAT_ATK_RATIO), 'expired after 2 owner turns');
ok(near(LOSim.stats.getAtk(a), atk0), 'atk restored');

// 2) Ajax ATTACK_SUCCESS: Effect_3P_Ajax_N_1 requires Effect_3P_Ajax_N_3 on Ajax (IF_BUFFED_KEY_ME)
const sk1 = a.skills.find((s) => s.key === 'Skill_3P_Ajax_N_1');
B.trigger(battle, TR.ATTACK_SUCCESS, { owner: a, skill: sk1, targets: [m], attacker: a });
ok(!B.hasKey(m, 'Effect_3P_Ajax_N_1'), 'Ajax_N_1 not applied without Ajax_N_3 on caster');
const def0 = m.attr[VT.ABS][A.DEF];
B.trigger(battle, TR.ATTACK_SUCCESS, { owner: a, skill: sk1, targets: [m], attacker: a });
const hasN12 = B.hasKey(m, 'Effect_3P_Ajax_N_12');
ok(hasN12, 'Ajax_N_12 (DEF -20%, cond __MAX__) applied to enemy target');
ok(near(B.value(m, BT.STAT_DEF_RATIO), B.list(m, BT.STAT_DEF_RATIO).length * (-0.2 + (sk1.level - 1) * -0.02)), 'DEF_RATIO value = stacks x (-0.2 + (lv-1)*-0.02): ' + B.value(m, BT.STAT_DEF_RATIO));
ok(m.attr[VT.ABS][A.DEF] < def0 || def0 === 0, `mob DEF ${def0} -> ${m.attr[VT.ABS][A.DEF]}`);
// give caster the N_3 key buff by hand and retry until the 25% AP_STOP lands
a.buffs.push({ id: 9999, key: 'Effect_3P_Ajax_N_3', row: rows.Effect_3P_Ajax_N_3, sortIndex: 1, type: BT.STAGE_SHIELD_RATIO, attrType: 3, triggerType: 71, eraseType: 5, eraseTriggerType: 0, value: 0.25, strValue: '', perLevel: 0.025, left: 1, delay: 0, fromAid: a.aid, from: a, skillKey: '', skillLevel: 1, addSkillLevel: 0, overlapped: 0, attrValue: 0, attrRate: 0, isItem: false });
let tries = 0;
while (!B.has(m, BT.STAGE_AP_STOP) && tries++ < 40) B.trigger(battle, TR.ATTACK_SUCCESS, { owner: a, skill: sk1, targets: [m], attacker: a });
ok(B.has(m, BT.STAGE_AP_STOP), 'AP_STOP landed after ' + tries + ' extra hits (25%)');
const ap = B.has(m, BT.STAGE_AP_STOP);
ok(ap && ap.left === (rows.Effect_3P_Ajax_N_1.BuffEffectLeftCount1 || 0), 'AP_STOP left = ' + (ap && ap.left));
ok(B.list(m, BT.STAT_DEF_RATIO).length === 2 + tries, 'OverlapType __MAX__ (4) without OverlapMax stacks per hit (client behaviour): ' + B.list(m, BT.STAT_DEF_RATIO).length);

// 3) AP value instant buff + DoT
m.turnPos = 50;
const apKey = Object.keys(rows).find((k) => { const r = rows[k]; return r.BuffEffectType1 === BT.STAGE_AP_VALUE && parseFloat(r.BuffEffectRate1) === 1 && !(r.BuffEffectLeftCount1) && (r.BuffEffectTriggerApplyCondition || 0) >= 63 && (r.BuffEffectTriggerApplyCondition2 || 0) >= 63 && !r.BuffEffectType2 && (r.BuffEffectEraseType || 0) === 0; });
const apv = parseFloat(rows[apKey].BuffEffectValue1);
B.apply(battle, m, m, apKey, 1, { update: true });
ok(near(m.turnPos, Math.min(100, Math.max(0, 50 + apv))) && !B.has(m, BT.STAGE_AP_VALUE), `AP_VALUE ${apKey} ${apv}: turnPos ${m.turnPos}, instant buff removed`);
const dotKey = Object.keys(rows).find((k) => { const r = rows[k]; return r.BuffEffectType1 === BT.STAGE_FIRE_DOT && parseFloat(r.BuffEffectRate1) === 1 && (r.BuffEffectLeftCount1 || 0) > 0 && (r.BuffEffectTriggerApplyCondition || 0) >= 63 && (r.BuffEffectTriggerApplyCondition2 || 0) >= 63; });
const hp0 = m.hp;
B.apply(battle, a, m, dotKey, 1, {});
B.onTurnEnd(battle, m);
ok(m.hp < hp0, `FIRE_DOT ${dotKey}: hp ${hp0} -> ${m.hp} (res ${LOSim.stats.getResist(m, A.FIRE_RESIST)})`);

// 4) wave start with passives / round start / wave end
const b2 = { rng: LOSim.makeRng(7), round: 1, log: [], logEnabled: true };
const a2 = LOSim.stats.buildPC({ key: 'Char_3P_Ajax_N', grade: 3, level: 50, gridPos: 4 });
const m2 = LOSim.stats.buildMonster(m.key, 30, { gridPos: 4 });
b2.units = [a2, m2];
B.onWaveStart(b2);
console.log('wave start buffs on Ajax:', a2.buffs.map((b) => b.key + ':' + LOSim.Ename.BUFFEFFECT_TYPE[b.type] + ':L' + b.left).join(', '));
B.onTurnStart(b2, a2);
console.log('after Ajax turn start:', a2.buffs.map((b) => b.key + ':' + LOSim.Ename.BUFFEFFECT_TYPE[b.type]).join(', '));
B.onRoundStart(b2);
const left = B.onWaveEnd(b2);
ok(a2.buffs.every((b) => b.eraseType === E.BUFFEFFECT_ERASE_TYPE.PRESERVE), 'wave end clears non-PRESERVE buffs');
console.log('log entries', battle.log.length + b2.log.length, 'sample', JSON.stringify(b2.log.slice(0, 3)));
console.log(fails ? fails + ' FAILED' : 'ALL OK');
process.exitCode = fails ? 1 : 0;
