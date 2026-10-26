// Throwaway check for engine/stats.js:  node tools/test_stats.js
global.window = global;
const fs = require('fs'), path = require('path');
const root = path.join(__dirname, '..');
for (const f of ['enums.js', 'core.js', 'stats.js']) eval(fs.readFileSync(path.join(root, 'engine', f), 'utf8'));
LOSim.data = {};
for (const f of ['stages', 'units', 'skills', 'buffs', 'loc', 'lua']) LOSim.data[f] = JSON.parse(fs.readFileSync(path.join(root, 'data', f + '.json'), 'utf8'));

const S = LOSim.stats, A = LOSim.E.ACTOR_ATTR_TYPE;
function show(label, u) {
  console.log(`\n== ${label}: ${u.key} lv${u.level} g${u.grade} team${u.team}`);
  console.log({
    atk: S.getAtk(u), def: S.getDef(u), hp: S.getHp(u), maxHp: S.getMaxHp(u), spd: S.getTurnSpeed(u),
    apply: +S.getApply(u).toFixed(4), evade: +S.getEvade(u).toFixed(4), cri: +S.getCri(u).toFixed(4),
    fire: S.getResist(u, A.FIRE_RESIST), ice: S.getResist(u, A.ICE_RESIST), lightning: S.getResist(u, A.LIGHTNING_RESIST),
  });
  console.log('skills:', u.skills.map((s) => `${s.key} L${s.level} slot${s.slot} type${s.type}`).join(', '));
  if (u.equips && u.equips.length) console.log('equips:', u.equips.map((e) => e.key + '+' + e.enchant).join(', '), 'buffs:', JSON.stringify(u.equipBuffs));
  if (u.warnings && u.warnings.length) console.log('warnings:', u.warnings);
}

const key = 'Char_BR_PA00EL_N';
console.log('equip slots:', JSON.stringify(S.equipSlotsOf(key)));
const cands = S.listEquipCandidates(key, 0);
console.log('slot0 candidates:', cands.length, cands.slice(0, 5));
show('PC lv1', S.buildPC(S.defaultSpec(key)));
show('PC lv50 +equip', S.buildPC({ key, grade: 3, level: 50, equips: [{ key: 'Equip_Chip_Atk_T1', enchant: 10 }] }));
show('PC lv50 g5 +equip +5 core +fav', S.buildPC({ key, grade: 5, level: 50, equips: [{ key: 'Equip_Chip_Atk_T1', enchant: 10 }], coreLink: 5, favor: 200, linkBonusKey: 'Core_Bonus_SPD_10' }));
show('MOB lv1', S.buildMonster('MOB_MP_NightChick_N', 1, { gridPos: 4 }));
show('MOB lv30', S.buildMonster('MOB_MP_NightChick_N', 30, { gridPos: 4 }));
show('IW', S.buildMonster('MOB_MP_Demolisher_BOSS_Challenge1', 1, { isIW: true }));
show('SUMMON', S.buildSummon('SUMMON_SU_RabbitBarrier_N', 5, null, 1));

// buff mod plumbing with a fake buffs module
const u = S.buildMonster('MOB_MP_NightChick_N', 30, {});
LOSim.buffs = { statMods: () => [{ attr: A.ATK, valueType: 1, value: 0.2 }, { attr: A.ATK, valueType: 0, value: 10 }, { attr: A.CRI, valueType: 1, value: 0.1 }] };
S.recalc(u, null);
console.log('\nbuffed mob lv30 atk (expect (44+10)*1.2=64.8):', S.getAtk(u), 'cri (expect 0.1):', S.getCri(u));

// Hand check (ActorAttr.cs:249): PA00EL lv50 ATK = AttackDmg 54 + AddAttackDmgByLevel 9 * 49 = 495, + chip Lv10 40 => 535.
// HP (:255) = 136 + 25*49 = 1361. CRI (:273) = 0.15 + 0.001*49 = 0.199.
const p = S.buildPC({ key, grade: 3, level: 50, equips: [{ key: 'Equip_Chip_Atk_T1', enchant: 10 }] });
LOSim.buffs = null; S.recalc(p, null);
console.log('hand check atk', S.getAtk(p), '== 535', S.getAtk(p) === 535, '| hp', p.maxHp, '== 1361', '| cri', S.getCri(p).toFixed(3), '== 0.199');
