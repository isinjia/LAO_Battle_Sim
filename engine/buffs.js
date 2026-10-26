// LOSim.buffs -- buff / debuff engine.
// Port of the renewal client (BEFORE_BATTLE_RENEWAL NOT defined; legacy branches skipped, UNITY_EDITOR cheats and
// all FX/UI/packet code dropped):
//   CreatureBattle/Buff.cs, Battle/LOEffect.cs                       buff record, duration ticks (owner turn end)
//   CreatureBattle/Creature.cs  2421 ApplyBuffSub, 3040-3916 overlap/trigger lists/ApplyBuff/rate/immunity/apply-target
//                               3918-5416 CheckTriggetApplyCondition, 5431-5913 DoBuffAttr/DoBuffOnly,
//                               8034 GetBuffEffectValue, 8049 GetAttrValue, 8249-8746 item buffs / erase checks,
//                               8756 RemoveBuffAll
//   CreatureBattle/CreatureSkill.cs 90 GetBuffEffectTableList, Skill.cs 277 IsHaveBuff, 346 GetBuffEffectTableList,
//                               561 IsGridInPos; StageMap/StageMapData.cs 970 GetValidTargetGridList
//   Common.cs 5385-5907          ActiveBuffList extension methods (CheckExistBuff, Remove*, AddRound, AddEffect ...)
//   Manager/BattleManager.cs     6160 ApplyBuffEffectAttrAll, 6192 ApplyBuffEffectBuffAll (+After*DamageApply),
//                               6321 ApplyDotBuff, 6637 DoApplyBuff, 6744 RemoveRoundBuffZero, 6764 OnHitTriggerBuff,
//                               6888 OnAllyHitTriggerBuff, 2167 RemoveTargetResult (resurrect), 2245 DeathBuffeffect,
//                               3286 RemoveAuraBuffsFromCaster
//   Manager/BattleRoundManager.cs 75 ApplyCreatureTurnBuffTrigger, 167 ApplyCreatureTurnEndDurations,
//                               232 ApplyRoundStartBuffs, 254 ApplyPriorityAnomalyBuffs, 517 OnGameStart,
//                               768 coEndRound, 1289 coNextRound (renewal), 1591 ApplyDotBuff, 1727 LastBuffCheck
//
// =====================================================================================================================
// HOW STATS ARE BUILT (Creature.UpdateAttr -> BattleManager.ApplyBuffEffectAttrAll, implemented in stats.js):
//   attr = raw attr (no buffs);  RATE row reset to 0 for every attr EXCEPT APPLY, EVADE, SKILL_ATTACK_RATE, CRI,
//   FIRE/ICE/LIGHTNING_RESIST (those keep their base percentage in RATE);  for every active buff in list order the
//   AttrEffect from statMods() is added: attr[valueType][attr] += round(value,3)  (MAXHP/HP handled specially);
//   finally ABS[i] += ABS[i] * RATE[i] for every attr.
//   => ATK/DEF/HP/TURNSPEED final = (base + sum *_VALUE) * (1 + sum *_RATIO)   (ABS row)
//   => APPLY/EVADE/CRI/RES final = base% + sum *_RATIO                        (RATE row; *_VALUE land in ABS row,
//      which is normally 0 so they are effectively inert -- faithful to the client)
//   statMods value = MathF.Round(BuffEffectValue + (SkillLevel + AddSkillLevel - 1) * LevelValue, 4)
//   STAT_SPEED_VALUE / STAT_SPEED_RATIO are commented out in the client (Creature.cs:5658) -> they change nothing.
//   BUFFER_ATK_ATKUP: value * caster.base[ABS][ATK] (captured when applied), clamped >= 0, added to ATK ABS.
//   STAT_RES*_RATIO: negative value flipped to positive while the unit has RES*_DEBUFF_REVERSE.
//
// BUFF RECORD (unit.buffs[] in insertion order == ActiveBuffList dictionary order):
//   {id, key, row, sortIndex(1..5), type(BUFFEFFECT_TYPE), attrType(BUFF_ATTR_TYPE), triggerType, eraseType,
//    eraseTriggerType, value(BuffEffectValue), strValue, perLevel(LevelValue), left(LeftRoundCount), delay,
//    fromAid, from(unit|null), skillKey, skillLevel, addSkillLevel, overlapped, attrValue, attrRate, isItem}
//
// DURATIONS: ROUND/TURN erase: left-- at the OWNER's turn end (onTurnEnd); removed when < 1. left==0 on a ROUND/TURN
//   buff = instant effect: it is applied by the next updateBuff() and then removed (RemoveRoundBuffZero).
//   COUNT: left-- when the owner fires its BuffEffectEraseTriggerType (trigger()), plus the explicit consumers below.
//   TRIGGER: removed when the owner fires BuffEffectEraseTriggerType.  PERMANENT: until wave end.
//   PRESERVE: survives wave end.  AURA: removed when the caster dies / leaves (onDeath / onUnitRemoved).
//
// QUIRK KEPT FROM THE CLIENT: updateBuff() (Creature.UpdateBuff) re-runs DoBuffOnly over EVERY active buff, so a
//   persistent STAGE_AP_VALUE / *_DAMAGE_APPLY / RATIO_DMG_* buff with left > 0 fires again on every updateBuff call.
//
// ---------------------------------------------------------------------------------------------------------------------
// WHAT combat.js / battle.js MUST CALL (C# call site in brackets). ctx keys for trigger():
//   {owner, skill, targets, attacker, target, value, itemBuffs}
//     owner    unit whose skills/equipment buffs fire (C# `this` of ApplyBuffTriggerList). Omitted -> every live unit.
//     skill    unit.skills entry that is being used (C# Skill) or null.
//     targets  array of units = AttackTargetInfo.TargetAidList (null = no AttackTargetInfo). Buffs with
//              BuffEffectTargetType ENEMY/OUR are applied ONLY through this list (or ctx.target); SELF/*_GRID/*_ALL
//              buffs find their own targets.
//     attacker unit passed as `attacker` (becomes buff.from / FromActorID). Default: owner.
//     target   C# triggerTarget (only ON_CRITICAL_HIT passes it: the crit victim).
//   Battle.js:
//     wave start      onWaveStart(battle)           [OnGameStart: ALWAYS, COMBAT_START, GRID_NO, FRIENDLY, ENEMY, ROUND_START]
//     round start     onRoundStart(battle)          [coNextRound: anomaly, ROUND_START, LastBuffCheck] -- AFTER Round++
//     turn acquired   onTurnStart(battle, unit)     [ApplyCreatureTurnBuffTrigger(true)] -- skip if has(unit, STAGE_AP_STOP)
//     turn end        onTurnEnd(battle, unit)       [TURN_END_* triggers + DoT + duration ticks] after all derived actions
//     wave end        onWaveEnd(battle)             [coEndRound: RemoveBuffAll, AFTER_WAVE] -> returns EXP_UP bonuses
//     unit removed    onUnitRemoved(battle, unit)   [RemoveCreature -> aura removal]
//   Combat.js (Creature.DoAttackTarget 6520+, BattleManager.DoApplyBuff 6637):
//     summon skill        trigger(SUMMON_CREATE, {owner:caster, skill, targets, attacker:caster})
//     damaging skill, not counter/assist: trigger(ON_ATTACK, {owner:caster, skill, targets, attacker:caster})
//     per enemy target before hit roll:   trigger(ATTACKED, {owner:victim, attacker:caster});
//                                         + ATTACKED_ACTIVESKILL when not counter/assist
//     miss (non-delay skill, skill target != OUR): trigger(USE_SKILL_ENEMY,{owner:victim,skill,targets,attacker:caster}),
//         ON_EVADE {owner:victim, skill:null, targets, attacker:caster}, ATTACK_FAIL {owner:caster, skill, targets},
//         ATTACK_FAIL_PASSIVE {owner:caster, skill:null, targets}, ON_EVADE_ACTIVESKILL (not counter/assist)
//     >=1 hit, not assist: ATTACK_SUCCESS {owner:caster, skill, targets:hitList}, ATTACK_SUCCESS_PASSIVE {skill:null},
//         ATTACK_SUCCESS_AND_IF_BUFFED {skill}
//     >=1 hit, not assist/counter: ATTACK_SUCCESS_ACTIVESKILL {skill}; every other same-type unit:
//         ATTACK_SUCCESS_SKILL_ALLY {owner:ally, targets:[], attacker:ally}
//     crit (not assist): consume STAGE_CRITICAL_NEXTATTACK; trigger(ON_CRITICAL_HIT,{owner:caster,skill,targets,target:victim})
//     damage landed on a live unit (not DoT): onHit(battle, victim, attacker, skill) [OnHitTriggerBuff + HP_DOWN/HP_UP]
//         and onAllyHit for allies with BEATEN_*_ALLY buffs
//     after damage: skill Use_BuffStack -> removeStack(); AFTER_ATTACKED {owner:victim, attacker:caster} per enemy target;
//         counter: eraseTrigger(caster, USE_SKILL_ENEMY) + AFTER_COUNTER {owner:caster, skill, targets};
//         assist: AFTER_CHAIN_ATTACK_SKILL_{1,2,ALL}_GIVER / _RECEIVER; consumeAttackPassiveCounts(caster)
//     end of action: afterSkill(battle, caster, skill, targets, {isCounter, isAssist})  [USE_SKILL, USE_ACTIVE_SKILL_n,
//         updateBuff on caster + targets]
//     wait / move:  trigger(WAIT|MOVE, {owner:unit})       death: onDeath(battle, unit) (handles resurrect)
//     Damage-side queries: value()/attrValue()/has()/list() -- see coverage table "flag" rows.
// =====================================================================================================================
// COVERAGE (BUFFEFFECT_TYPE; uses = effect slots with Rate>0 in Table_BuffEffect, 19057 total). Status:
//   impl  = implemented here;  flag = state kept here, effect must be read by combat.js/battle.js via has/value/attrValue;
//   noop  = no battle handler in the client either (faithfully inert);  todo = not ported (reason given)
//   summary: impl 64 types / 12292 uses (64.5%); flag 53 types / 6255 uses (32.8%); noop 38 types / 473 uses (2.5%); todo 2 types / 37 uses (0.2%)
//   enum name                                    uses  status
//     0 STAT_ATK_VALUE                           208  impl
//     1 STAT_ATK_RATIO                          1933  impl
//     2 STAT_DEF_VALUE                           100  impl
//     3 STAT_DEF_RATIO                           702  impl
//     4 STAT_HP_VALUE                              0  impl - statMods(); HP side effect handled in stats.js
//     5 STAT_HP_RATIO                             67  impl - statMods(); HP side effect in stats.js
//     6 STAT_RATING_VALUE                        124  impl
//     7 STAT_RATING_RATIO                       1268  impl
//     8 STAT_CRITICAL_VALUE                       87  impl
//     9 STAT_CRITICAL_RATIO                      911  impl
//    10 STAT_AVOID_VALUE                          13  impl
//    11 STAT_AVOID_RATIO                         846  impl
//    12 STAT_SPEED_VALUE                           9  impl - client case commented out (Creature.cs:5658): no stat change
//    13 STAT_SPEED_RATIO                        1105  impl - client case commented out (Creature.cs:5658): no stat change
//    14 STAT_RESFIRE_VALUE                         0  impl
//    15 STAT_RESFIRE_RATIO                       285  impl
//    16 STAT_RESICE_VALUE                          0  impl
//    17 STAT_RESICE_RATIO                        234  impl
//    18 STAT_RESLIGHTNING_VALUE                    0  impl
//    19 STAT_RESLIGHTNING_RATIO                  266  impl
//    20 STAGE_AP_VALUE                          1008  impl - updateBuff: TurnPos=clamp(TurnPos+v,0,100)
//    21 STAGE_AP_SHIFT                            29  impl - updateBuff: TurnPos=clamp(v)
//    22 STAGE_AP_STOP                            167  flag - battle.js: skip turn / AP gain while has()
//    23 UI_INFO_NEXTENEMY                         80  noop - UI only
//    24 STAGE_THORNS_RATIO                         0  noop
//    25 STAGE_REFLECTPHYSICS_VALUE                 0  noop
//    26 STAGE_REFLECTFIRE_VALUE                    0  noop
//    27 STAGE_REFLECTICE_VALUE                     0  noop
//    28 STAGE_REFLECTLIGHTNIG_VALUE                0  noop
//    29 STAGE_REFLECTPHYSICS_RATIO_DEFENDER      231  flag - counter attack (combat); removal sets unit.flags.counterRemoved
//    30 STAGE_REFLECTFIRE_RATIO_DEFENDER           1  noop
//    31 STAGE_REFLECTICE_RATIO_DEFENDER            0  noop
//    32 STAGE_REFLECTLIGHTNIG_RATIO_DEFENDER       0  noop
//    33 STAGE_IMMUNESHIELD_TIME                   97  flag - combat decrements buff.attrValue
//    34 STAGE_SHIELD_VALUE                       112  flag - combat; consumeShieldCount()
//    35 STAGE_SHIELD_VALUE_LIMITED                 0  noop
//    36 STAGE_SHIELD_RATIO                       803  flag
//    37 STAGE_SHIELD_RATIO_LIMITED                 0  noop
//    38 STAGE_IMMUNESHIELD_VALUE                 122  flag
//    39 STAGE_DAMAGEPHYSICS_RATIO                  1  flag
//    40 STAGE_DAMAGEPHYSICS_VALUE                  0  noop
//    41 STAGE_DAMAGEFIRE_RATIO                     0  flag
//    42 STAGE_DAMAGEFIRE_VALUE                     0  noop
//    43 STAGE_DAMAGEICE_RATIO                      0  flag
//    44 STAGE_DAMAGEICE_VALUE                      0  noop
//    45 STAGE_DAMAGELIGHTNING_RATIO                0  flag
//    46 STAGE_DAMAGELIGHTNING_VALUE                0  noop
//    47 STAGE_LOCKON01_TIME                        0  noop
//    48 STAGE_ADDDAMAGE_RATIO                    439  flag
//    49 STAGE_ADDDAMAGE_VALUE                      1  noop
//    50 STAGE_BLOCK_LINE                          66  flag
//    51 STAGE_BLOCK_GRID                           1  noop
//    52 STAGE_MOVE_BACK                           53  flag
//    53 STAGE_MOVE_FRONT                          17  flag
//    54 STAGE_CRITICAL_NEXTATTACK                 10  flag - combat: remove(type) + forced crit
//    55 STAT_RANGE_VALUE                         298  flag
//    56 STAGE_AGRO_VALUE                           1  noop
//    57 STAGE_DEFPIERCE_VALUE                      1  flag
//    58 STAGE_DEFPIERCE_RATIO                    565  flag
//    59 STAGE_GRID_CHANGE                          1  noop
//    60 STAGE_TROOPERTYPEDMGBONUS_RATIO          267  flag
//    61 STAGE_ARMOREDTYPEDMGBONUS_RATIO          259  flag
//    62 STAGE_MOBILITYTYPEDMGBONUS_RATIO         187  flag
//    63 STAGE_CHARCHANGE_PERMANENT                21  todo - transformation swaps PC info/skills (server PCInfo) -- buff record kept, no swap
//    64 STAGE_CHARCHANGE_LIMITED                  16  todo - transformation swaps PC info/skills (server PCInfo) -- buff record kept, no swap
//    65 STAGE_PHYSICS_DOT                        160  impl
//    66 STAGE_FIRE_DOT                            95  impl
//    67 STAGE_ICE_DOT                             37  impl
//    68 STAGE_LIGHTNING_DOT                       47  impl
//    69 STAGE_REMOVE_BUFF_ENUM                   165  impl
//    70 STAGE_PHYSICS_DAMAGE_APPLY               125  impl
//    71 STAGE_FIRE_DAMAGE_APPLY                   21  impl
//    72 STAGE_ICE_DAMAGE_APPLY                     2  impl
//    73 STAGE_LIGHTNING_DAMAGE_APPLY               6  impl
//    74 STAGE_PROVOKE                             83  flag
//    75 STAGE_BLOCK_ROW                           64  flag
//    76 STAGE_BLOCK_CHARACTER                    113  flag
//    77 STAGE_SUPPORT_ATTACK                     138  noop - only referenced by UI auto-AI condition
//    78 STAGE_SNARE                               87  flag
//    79 STAGE_SEAL_SKILL                          43  flag
//    80 STAGE_DAMAGEAMP_BYHP_ME                   31  flag
//    81 STAGE_DAMAGEAMP_BYHP_OPP                  72  flag
//    82 STAGE_RESURRECT                           96  impl - onDeath(): hp = attrValue
//    83 STAGE_DAMAGEPHYSICS_RATIO_INS            540  flag
//    84 STAGE_DAMAGEFIRE_RATIO_INS               100  flag
//    85 STAGE_DAMAGEICE_RATIO_INS                 61  flag
//    86 STAGE_DAMAGELIGHTNING_RATIO_INS          138  flag
//    87 STAGE_MARKING                            163  flag
//    88 STAGE_REMOVE_BUFF                        423  impl
//    89 STAGE_REMOVE_DEBUFF                      180  impl
//    90 STAGE_DEBUFF_RATEUP                      129  impl
//    91 STAGE_DEBUFF_PERDOWN                     387  impl
//    92 STAGE_BUFFEFFECTRATE_CHANGE               30  impl
//    93 REMOVE_SUMMON_INSTENV                      3  noop
//    94 BARRIER_PIERCE                           213  flag
//    95 STAGE_EXP_UP                              83  impl - onWaveEnd() returns bonus (no battle effect)
//    96 STAGE_ANALYZE                              1  noop
//    97 STAGE_REMOVE_BUFF_KEY_ALL_ATTRTYPE       210  impl
//    98 STAGE_RESURRECT_RATIO                    199  impl - onDeath(): hp = maxHp*attrValue
//    99 STAGE_REMOVE_ALL_BUFF                    153  impl
//   100 STAGE_REMOVE_ALL_DEBUFF                  192  impl
//   101 STAGE_IMMUNITY_DEBUFF                    146  impl
//   102 STAGE_TOGETHER_ATTACK_ACTIVE_SKILL_1      34  noop
//   103 STAGE_TOGETHER_ATTACK_ACTIVE_SKILL_2      80  noop
//   104 STAT_MAXHP_VALUE                           0  impl
//   105 STAT_MAXHP_RATIO                           0  impl
//   106 STAT_SKILL_RATIO                         445  flag
//   107 STAT_RANGE_VALUE_ACTIVE_SKILL_1           17  flag
//   108 STAT_RANGE_VALUE_ACTIVE_SKILL_2            5  flag
//   109 FOCUSED_ATTACK                            37  flag
//   110 DAMAGE_DISPERSE                           43  flag
//   111 EVADE_SKILLDMGUP_ME                       17  flag
//   112 EVADE_SKILLDMGDOWN                         8  flag
//   113 DEF_SKILLDMGUP_ME                         31  flag
//   114 DEF_CRTDOWN                               11  flag
//   115 BUFFER_ATK_ATKUP                           7  impl
//   116 RESFIRE_VALUE_MIN                         15  impl
//   117 RESICE_VALUE_MIN                          27  impl
//   118 RESLIGHTNING_VALUE_MIN                    15  impl
//   119 RESFIRE_VALUE_FIX                          5  impl
//   120 RESICE_VALUE_FIX                           5  impl
//   121 RESLIGHTNING_VALUE_FIX                     5  impl
//   122 RESFIRE_DEBUFF_REVERSE                     3  impl
//   123 RESICE_DEBUFF_REVERSE                      3  impl
//   124 RESLIGHTNING_DEBUFF_REVERSE                3  impl
//   125 BUFF_DISALLOW                             26  impl
//   126 REMOVE_BUFF_RESIST                        69  impl
//   127 ACTION_NUMBER_CHANGE                     104  noop
//   128 PROVOKE_ATTACKER                           1  noop
//   129 CURRENT_HP_PIERCEDOWN                     15  flag
//   130 GUARDPIERCE_APPLY                         75  flag
//   131 GUARDPIERCE_NO_APPLY                      20  flag
//   132 DAMAGE_RECOVER_THISROUND                   0  noop
//   133 SAME_SKILL_HIT_DAMAGE_REDUCE               0  noop
//   134 STAGE_SEAL_SKILL_ACTIVE_1                  0  noop
//   135 STAGE_SEAL_SKILL_ACTIVE_2                  1  noop
//   136 STAGE_SEAL_SKILL_PASSIVE                   0  noop
//   137 ADD_ROLE_TYPE                              0  noop
//   138 WIDE_SKILL_RATIO                          10  flag
//   139 WIDE_DAMAGE_RATIO                          0  flag
//   140 STAGE_DOUBLE_ATTACK_RATIO                  2  flag
//   141 RESIST_CHECK_ATTACK_POWER                  6  flag
//   142 DEF_DAMAGE_REDUCE                          1  impl - attrValue = trunc(trunc(caster DEF)*value) at apply; combat reads attrValue
//   143 DEF_DMG_ADD                                1  flag
//   144 RATIO_DMG_GIVER_MAX_HP                     2  impl
//   145 RATIO_DMG_GIVER_CURRENT_HP                 3  impl
//   146 RATIO_DMG_TARGET_MAX_HP                   13  impl
//   147 RATIO_DMG_TARGET_CURRENT_HP                0  impl
//   148 ADJUST_AP_ACTIVE_SKILL_1                  13  noop - only DescriptHelper (text)
//   149 ADJUST_AP_ACTIVE_SKILL_2                  13  noop - only DescriptHelper (text)
//   150 BUFF_DISALLOW_SPECIFIC                     3  impl
//   151 ENUM_DISALLOW_SPECIFIC                     6  impl
//   152 CHAIN_ATTACK_SKILL_1                      88  flag - BattleManager.SetChainAttack (battle.js)
//   153 CHAIN_ATTACK_SKILL_2                      21  flag - BattleManager.SetChainAttack (battle.js)
//   154 ADJUST_COOLTIME_SKILL_1                    0  noop
//   155 ADJUST_COOLTIME_SKILL_2                    0  noop
//   156 ADJUST_COOLTIME_SKILL_ALL                  0  noop
// =====================================================================================================================
(function () {
  const LOSim = (window.LOSim = window.LOSim || {});
  const E = LOSim.E;
  const num = LOSim.num, str = LOSim.str, list = LOSim.list;
  const BT = E.BUFFEFFECT_TYPE, TR = E.BUFFEFFECT_TRIGGER_TYPE, OV = E.BUFF_OVERLAP_TYPE, ER = E.BUFFEFFECT_ERASE_TYPE;
  const BA = E.BUFF_ATTR_TYPE, AC = E.BUFFEFFECT_TRIGGER_APPLY_CONDITION, TT = E.TARGET_TYPE;
  const VT = E.VALUE_TYPE, A = E.ACTOR_ATTR_TYPE;
  const ANOMALY_AID = 2147483647; // Const.ATTACKER_ID_BY_ANOMALY = int.MaxValue
  const ACTIVE_ROUND = (LOSim.C && LOSim.C.ACTIVE_ROUND) || 100;

  // ------------------------------------------------------------------ status table (drives the coverage comment)
  const STATUS = {
    impl: 'STAT_ATK_VALUE STAT_ATK_RATIO STAT_DEF_VALUE STAT_DEF_RATIO STAT_HP_VALUE STAT_HP_RATIO STAT_RATING_VALUE STAT_RATING_RATIO STAT_CRITICAL_VALUE STAT_CRITICAL_RATIO STAT_AVOID_VALUE STAT_AVOID_RATIO STAT_SPEED_VALUE STAT_SPEED_RATIO STAT_RESFIRE_VALUE STAT_RESFIRE_RATIO STAT_RESICE_VALUE STAT_RESICE_RATIO STAT_RESLIGHTNING_VALUE STAT_RESLIGHTNING_RATIO STAGE_AP_VALUE STAGE_AP_SHIFT STAGE_PHYSICS_DOT STAGE_FIRE_DOT STAGE_ICE_DOT STAGE_LIGHTNING_DOT STAGE_REMOVE_BUFF_ENUM STAGE_PHYSICS_DAMAGE_APPLY STAGE_FIRE_DAMAGE_APPLY STAGE_ICE_DAMAGE_APPLY STAGE_LIGHTNING_DAMAGE_APPLY STAGE_RESURRECT STAGE_REMOVE_BUFF STAGE_REMOVE_DEBUFF STAGE_DEBUFF_RATEUP STAGE_DEBUFF_PERDOWN STAGE_BUFFEFFECTRATE_CHANGE STAGE_REMOVE_BUFF_KEY_ALL_ATTRTYPE STAGE_RESURRECT_RATIO STAGE_REMOVE_ALL_BUFF STAGE_REMOVE_ALL_DEBUFF STAGE_IMMUNITY_DEBUFF STAT_MAXHP_VALUE STAT_MAXHP_RATIO BUFFER_ATK_ATKUP RESFIRE_VALUE_MIN RESICE_VALUE_MIN RESLIGHTNING_VALUE_MIN RESFIRE_VALUE_FIX RESICE_VALUE_FIX RESLIGHTNING_VALUE_FIX RESFIRE_DEBUFF_REVERSE RESICE_DEBUFF_REVERSE RESLIGHTNING_DEBUFF_REVERSE BUFF_DISALLOW REMOVE_BUFF_RESIST DEF_DAMAGE_REDUCE RATIO_DMG_GIVER_MAX_HP RATIO_DMG_GIVER_CURRENT_HP RATIO_DMG_TARGET_MAX_HP RATIO_DMG_TARGET_CURRENT_HP BUFF_DISALLOW_SPECIFIC ENUM_DISALLOW_SPECIFIC STAGE_EXP_UP',
    flag: 'STAGE_AP_STOP STAGE_REFLECTPHYSICS_RATIO_DEFENDER STAGE_IMMUNESHIELD_TIME STAGE_SHIELD_VALUE STAGE_SHIELD_RATIO STAGE_IMMUNESHIELD_VALUE STAGE_DAMAGEPHYSICS_RATIO STAGE_DAMAGEFIRE_RATIO STAGE_DAMAGEICE_RATIO STAGE_DAMAGELIGHTNING_RATIO STAGE_ADDDAMAGE_RATIO STAGE_BLOCK_LINE STAGE_MOVE_BACK STAGE_MOVE_FRONT STAGE_CRITICAL_NEXTATTACK STAT_RANGE_VALUE STAGE_DEFPIERCE_VALUE STAGE_DEFPIERCE_RATIO STAGE_TROOPERTYPEDMGBONUS_RATIO STAGE_ARMOREDTYPEDMGBONUS_RATIO STAGE_MOBILITYTYPEDMGBONUS_RATIO STAGE_PROVOKE STAGE_BLOCK_ROW STAGE_BLOCK_CHARACTER STAGE_SNARE STAGE_SEAL_SKILL STAGE_DAMAGEAMP_BYHP_ME STAGE_DAMAGEAMP_BYHP_OPP STAGE_DAMAGEPHYSICS_RATIO_INS STAGE_DAMAGEFIRE_RATIO_INS STAGE_DAMAGEICE_RATIO_INS STAGE_DAMAGELIGHTNING_RATIO_INS STAGE_MARKING BARRIER_PIERCE STAT_SKILL_RATIO STAT_RANGE_VALUE_ACTIVE_SKILL_1 STAT_RANGE_VALUE_ACTIVE_SKILL_2 FOCUSED_ATTACK DAMAGE_DISPERSE EVADE_SKILLDMGUP_ME EVADE_SKILLDMGDOWN DEF_SKILLDMGUP_ME DEF_CRTDOWN CURRENT_HP_PIERCEDOWN GUARDPIERCE_APPLY GUARDPIERCE_NO_APPLY WIDE_SKILL_RATIO WIDE_DAMAGE_RATIO STAGE_DOUBLE_ATTACK_RATIO RESIST_CHECK_ATTACK_POWER DEF_DMG_ADD CHAIN_ATTACK_SKILL_1 CHAIN_ATTACK_SKILL_2',
    noop: 'UI_INFO_NEXTENEMY STAGE_THORNS_RATIO STAGE_REFLECTPHYSICS_VALUE STAGE_REFLECTFIRE_VALUE STAGE_REFLECTICE_VALUE STAGE_REFLECTLIGHTNIG_VALUE STAGE_REFLECTFIRE_RATIO_DEFENDER STAGE_REFLECTICE_RATIO_DEFENDER STAGE_REFLECTLIGHTNIG_RATIO_DEFENDER STAGE_SHIELD_VALUE_LIMITED STAGE_SHIELD_RATIO_LIMITED STAGE_DAMAGEPHYSICS_VALUE STAGE_DAMAGEFIRE_VALUE STAGE_DAMAGEICE_VALUE STAGE_DAMAGELIGHTNING_VALUE STAGE_LOCKON01_TIME STAGE_ADDDAMAGE_VALUE STAGE_BLOCK_GRID STAGE_AGRO_VALUE STAGE_GRID_CHANGE STAGE_SUPPORT_ATTACK REMOVE_SUMMON_INSTENV STAGE_ANALYZE STAGE_TOGETHER_ATTACK_ACTIVE_SKILL_1 STAGE_TOGETHER_ATTACK_ACTIVE_SKILL_2 ACTION_NUMBER_CHANGE PROVOKE_ATTACKER DAMAGE_RECOVER_THISROUND SAME_SKILL_HIT_DAMAGE_REDUCE STAGE_SEAL_SKILL_ACTIVE_1 STAGE_SEAL_SKILL_ACTIVE_2 STAGE_SEAL_SKILL_PASSIVE ADD_ROLE_TYPE ADJUST_AP_ACTIVE_SKILL_1 ADJUST_AP_ACTIVE_SKILL_2 ADJUST_COOLTIME_SKILL_1 ADJUST_COOLTIME_SKILL_2 ADJUST_COOLTIME_SKILL_ALL',
    todo: 'STAGE_CHARCHANGE_PERMANENT STAGE_CHARCHANGE_LIMITED',
  };
  const NOTES = {
    STAT_SPEED_VALUE: 'client case commented out (Creature.cs:5658): no stat change',
    STAT_SPEED_RATIO: 'client case commented out (Creature.cs:5658): no stat change',
    STAT_HP_VALUE: 'statMods(); HP side effect handled in stats.js', STAT_HP_RATIO: 'statMods(); HP side effect in stats.js',
    STAGE_AP_VALUE: 'updateBuff: TurnPos=clamp(TurnPos+v,0,100)', STAGE_AP_SHIFT: 'updateBuff: TurnPos=clamp(v)',
    STAGE_AP_STOP: 'battle.js: skip turn / AP gain while has()', STAGE_EXP_UP: 'onWaveEnd() returns bonus (no battle effect)',
    STAGE_RESURRECT: 'onDeath(): hp = attrValue', STAGE_RESURRECT_RATIO: 'onDeath(): hp = maxHp*attrValue',
    STAGE_REFLECTPHYSICS_RATIO_DEFENDER: 'counter attack (combat); removal sets unit.flags.counterRemoved',
    STAGE_SHIELD_VALUE: 'combat; consumeShieldCount()', STAGE_IMMUNESHIELD_TIME: 'combat decrements buff.attrValue',
    STAGE_CRITICAL_NEXTATTACK: 'combat: remove(type) + forced crit', CHAIN_ATTACK_SKILL_1: 'BattleManager.SetChainAttack (battle.js)',
    CHAIN_ATTACK_SKILL_2: 'BattleManager.SetChainAttack (battle.js)', STAGE_SUPPORT_ATTACK: 'only referenced by UI auto-AI condition',
    ADJUST_AP_ACTIVE_SKILL_1: 'only DescriptHelper (text)', ADJUST_AP_ACTIVE_SKILL_2: 'only DescriptHelper (text)',
    UI_INFO_NEXTENEMY: 'UI only', DEF_DAMAGE_REDUCE: 'attrValue = trunc(trunc(caster DEF)*value) at apply; combat reads attrValue',
    STAGE_CHARCHANGE_PERMANENT: 'transformation swaps PC info/skills (server PCInfo) -- buff record kept, no swap',
    STAGE_CHARCHANGE_LIMITED: 'transformation swaps PC info/skills (server PCInfo) -- buff record kept, no swap',
  };
  const statusOf = {};
  for (const s in STATUS) for (const n of STATUS[s].split(/\s+/)) statusOf[n] = s;

  // ------------------------------------------------------------------ helpers
  const F = (v) => Math.fround(v);
  const fnum = (row, k) => { const v = parseFloat(row && row[k]); return Number.isFinite(v) ? F(v) : 0; };
  const round = (v, d) => { const p = Math.pow(10, d); return Math.round(v * p) / p; };
  const log = (battle, data) => { if (battle && LOSim.log) LOSim.log(battle, 'buff', data); };
  const typeName = (t) => (LOSim.Ename && LOSim.Ename.BUFFEFFECT_TYPE[t]) || String(t);
  const trigName = (t) => (LOSim.Ename && LOSim.Ename.BUFFEFFECT_TRIGGER_TYPE[t]) || String(t);
  const rowOf = (key) => (key && LOSim.T('Table_BuffEffect', key)) || null;
  const rng = (battle) => (battle && battle.rng ? battle.rng() : 0);
  const isDurationErase = (e) => e === ER.ROUND || e === ER.TURN; // LOEffect.IsDurationEraseType (renewal)
  const isTurnTrigger = (t) => t >= TR.TURN_START_SELF && t <= TR.TURN_END_ALL; // BattleManager.IsCreatureTurnTrigger
  const TYPE_ORDER = { CHARACTER: 1, MONSTER: 2, SUMMON: 3 };
  const BEATEN_FAMILY = new Set([TR.BEATEN, TR.BEATEN_FIRE, TR.BEATEN_ICE, TR.BEATEN_LIGHTNING, TR.BEATEN_PHY, TR.ON_EVADE,
    TR.USE_SKILL_ENEMY, TR.ATTACKED, TR.ATTACKED_ACTIVESKILL, TR.BEATEN_ACTIVESKILL, TR.BEATEN_ACTIVE_SKILL_KEY,
    TR.ON_EVADE_ACTIVESKILL, TR.AFTER_ATTACKED]);
  const RECORDED_TRIGGERS = new Set([TR.ALWAYS, TR.COMBAT_START, TR.GRID_NO, TR.ROUND_START]);

  let nextBuffId = 1;

  function state(battle) {
    if (!battle) return { failed: new Map(), suc: new Map(), totalTurns: 0, selfTurns: new Map() };
    if (!battle.buffState) battle.buffState = { failed: new Map(), suc: new Map(), totalTurns: 0, selfTurns: new Map() };
    return battle.buffState;
  }

  // Creature list (BattleManager.ListCreature). Units removed from the field have unit.removed = true.
  function allUnits(battle) {
    let arr;
    if (!battle) arr = [];
    else if (Array.isArray(battle.units)) arr = battle.units;
    else arr = [].concat(battle.pcs || [], battle.mobs || battle.monsters || [], battle.summons || []);
    return arr.filter((u) => u && !u.removed);
  }
  // coNextRound sort: creature type, then LineSpot
  const sortedUnits = (battle) => allUnits(battle).slice().sort((a, b) =>
    (TYPE_ORDER[a.type] - TYPE_ORDER[b.type]) || (a.gridPos - b.gridPos) || (a.aid - b.aid));
  const ofType = (battle, type) => allUnits(battle).filter((u) => u.type === type);
  const findAid = (battle, aid) => allUnits(battle).find((u) => u.aid === aid) || null;
  const alive = (u) => !!u && u.hp > 0;

  // Creature attribute accessors used by conditions
  const bodyType = (u) => num(u.table, 'ActorBodyType');
  const classType = (u) => num(u.table, 'ActorClassType');
  const roleType = (u) => num(u.table, 'RoleType');
  const cell = (u) => (u.type === 'MONSTER' ? Math.abs(u.gridPos) % 3 : (8 - u.gridPos) % 3); // Creature.cs:96
  const rowNo = (u) => Math.trunc(u.gridPos / 3) + 1;
  const hpRate = (u) => (u.maxHp > 0 ? F(u.hp / u.maxHp) : 0);
  const attrAbs = (u, a) => (u.attr ? u.attr[VT.ABS][a] : 0);
  const attrRate = (u, a) => (u.attr ? u.attr[VT.RATE][a] : 0);
  const isSummonAutopilot = (u) => num(u.table, 'SummonType') === E.SUMMON_TYPE.AUTOPILOT;
  const installPos = (u) => num(u.table, 'InstallPosType');
  const stageBuffLevelUp = (u) => (u && u.type === 'CHARACTER' && u.coreLinkFunc ? (u.coreLinkFunc.stageBuffLevelUp | 0) : 0);

  function recalc(battle, unit) {
    if (LOSim.stats && LOSim.stats.recalc) LOSim.stats.recalc(unit, battle);
  }

  // ------------------------------------------------------------------ queries (Common.cs CheckExistBuff family)
  const levelValue = (b) => b.value + (b.skillLevel + b.addSkillLevel - 1) * b.perLevel; // GetValueLevelPer
  function list_(unit, type, attrType) {
    return (unit && unit.buffs ? unit.buffs : []).filter((b) => b.type === type && (attrType === undefined || b.attrType === attrType));
  }
  function has(unit, type, attrType) { return list_(unit, type, attrType)[0] || null; }
  // Creature.GetBuffEffectValue: sum of round(BuffEffectValue + (lv-1)*LevelValue, 5)  (level = SkillLevel+AddSkillLevel)
  function value(unit, type) {
    let v = 0;
    for (const b of list_(unit, type)) v += F(round(levelValue(b), 5));
    return v;
  }
  // Creature.GetAttrValue: sum of buff.AttrValue (overlap stacks, DoT damage, DEF_DAMAGE_REDUCE, shields ...)
  function attrValue(unit, type) { let v = 0; for (const b of list_(unit, type)) v += b.attrValue; return v; }
  const hasKey = (unit, key) => (unit && unit.buffs ? unit.buffs.some((b) => b.key === key) : false);
  const countKey = (unit, key) => (unit && unit.buffs ? unit.buffs.filter((b) => b.key === key).length : 0);

  // ------------------------------------------------------------------ removal
  function removeBuff(battle, unit, b, reason) {
    const i = unit.buffs.indexOf(b);
    if (i < 0) return false;
    unit.buffs.splice(i, 1);
    if (b.type === BT.STAGE_REFLECTPHYSICS_RATIO_DEFENDER && reason === 'dispel') unit.flags.counterRemoved = true;
    log(battle, { op: 'remove', unit: unit.aid, key: b.key, type: typeName(b.type), id: b.id, reason });
    return true;
  }
  const isTransform = (b) => b.type === BT.STAGE_CHARCHANGE_PERMANENT || b.type === BT.STAGE_CHARCHANGE_LIMITED;
  // Common.cs:5645 RemoveBuff_By_BuffAttrType (effectType __MAX__ = all); returns "counter removed"
  function removeByAttrType(battle, unit, attrType, effectType) {
    let counter = false;
    for (const b of unit.buffs.slice()) {
      if (b.attrType !== attrType) continue;
      if (effectType !== BT.__MAX__ && b.type !== effectType) continue;
      if (isTransform(b)) continue;
      if (removeBuff(battle, unit, b, 'dispel') && b.type === BT.STAGE_REFLECTPHYSICS_RATIO_DEFENDER) counter = true;
    }
    return counter;
  }
  // Common.cs:5798 RemoveBuff(type): all of that type (transform included)
  function removeType(battle, unit, type) {
    let any = false;
    for (const b of unit.buffs.slice()) if (b.type === type) any = removeBuff(battle, unit, b, 'type') || any;
    return any;
  }
  const byLeftAsc = (arr) => arr.map((b, i) => [b, i]).sort((x, y) => (x[0].left - y[0].left) || (x[1] - y[1])).map((x) => x[0]);
  // Common.cs:5486 RemoveBuff_Round: remove the key's buff with the fewest rounds left
  function removeOneByKeyRound(battle, unit, key) {
    const c = byLeftAsc(unit.buffs.filter((b) => b.key === key));
    if (c.length && !isTransform(c[0])) removeBuff(battle, unit, c[0], 'overlapMax');
  }
  function removeOneByGroupRound(battle, unit, group) {
    const c = byLeftAsc(unit.buffs.filter((b) => num(b.row, 'BuffEffectOverlapGroup') === group));
    if (c.length && !isTransform(c[0])) removeBuff(battle, unit, c[0], 'overlapGroupMax');
  }
  function removeAllByKey(battle, unit, key) { for (const b of unit.buffs.slice()) if (b.key === key) removeBuff(battle, unit, b, 'key'); }
  function removeOneByKey(battle, unit, key) { const b = unit.buffs.find((x) => x.key === key); if (b) removeBuff(battle, unit, b, 'key'); }

  // public remove(battle, unit, predicate)
  function remove(battle, unit, predicate) {
    let n = 0;
    for (const b of unit.buffs.slice()) if (predicate(b)) { removeBuff(battle, unit, b, 'api'); n++; }
    if (n) recalc(battle, unit);
    return n;
  }
  // BattleManager.RemoveRoundBuffZero
  function removeRoundZero(battle, unit) {
    for (const b of unit.buffs.slice()) if (b.left === 0 && isDurationErase(b.eraseType)) removeBuff(battle, unit, b, 'instant');
  }

  // ------------------------------------------------------------------ skills
  function skillsOf(unit) {
    const s = unit && unit.skills ? unit.skills : [];
    for (const k of s) if (k && !k._owner) Object.defineProperty(k, '_owner', { value: unit, enumerable: false });
    return s;
  }
  const lvBuffs = (skill) => list(skill && skill.levelTable, 'BuffEffectIndex');
  const skillType = (skill) => (skill.type !== undefined ? skill.type : num(skill.table, 'SkillType'));
  const skillSlot = (skill) => (skill.slot !== undefined ? skill.slot : num(skill.table, 'SkillSlotType'));
  // Skill.cs:277 IsHaveBuff (level table + the owner's extended active skills)
  function isHaveBuff(skill, key) {
    if (!skill || !skill.levelTable) return false;
    if (lvBuffs(skill).includes(key)) return true;
    const owner = skill._owner;
    return !!owner && skillsOf(owner).some((s) => s.ext && lvBuffs(s).includes(key));
  }
  // CreatureSkill.GetSkill_From_BuffKeyString
  const skillFromBuffKey = (unit, key) => skillsOf(unit).find((s) => isHaveBuff(s, key)) || null;

  // equipment buffs (stats.js fills unit.equipBuffs = [{effectKey, level:1, equipKey, enchant}])
  const equipBuffKeys = (unit) => (unit && unit.type === 'CHARACTER' ? (unit.equipBuffs || []).map((e) => e.effectKey).filter(Boolean) : []);
  const isItemBuffKey = (unit, key) => equipBuffKeys(unit).includes(key); // Creature.IsItemBuff

  // ------------------------------------------------------------------ grid (Skill.IsGridInPos / StageMapData.GetValidTargetGridList)
  const ALL_GRID = { Pos1: '1', Pos2: '1', Pos3: '1', Pos4: '1', Pos5: '1', Pos6: '1', Pos7: '1', Pos8: '1', Pos9: '1', StandardPoint: 4, UsePoint: 1 };
  function validGrid(grid, targetGridNo, target) {
    const cr = Math.trunc(num(grid, 'StandardPoint') / 3), cc = num(grid, 'StandardPoint') % 3;
    const offR = Math.trunc(targetGridNo / 3) - cr, offC = (targetGridNo % 3) - cc;
    const ti = target.gridPos;
    if (!(ti >= 0 && ti < 9)) return false;
    for (let p = 1; p <= 9; ++p) {
      if (!num(grid, 'Pos' + p)) continue; // "0" (or missing = compacted "0") is not part of the pattern
      const r = Math.trunc((p - 1) / 3) + offR, c = ((p - 1) % 3) + offC;
      if (r < 0 || r > 2 || c < 0 || c > 2) continue;
      if (r * 3 + c === ti) return true;
    }
    return false;
  }
  function isGridInPos(skill, caster, target, buffTargetType) {
    const lt = skill && skill.levelTable;
    if (!lt) return false;
    let grid = LOSim.T('Table_Grid', str(lt, 'GridIndex'));
    if (!grid) return false;
    const fixed = num(grid, 'UsePoint') === 0;
    const center = caster.flags && caster.flags.centerTargetGrid !== undefined ? caster.flags.centerTargetGrid : -1;
    let no = fixed ? num(grid, 'StandardPoint') : (skillType(skill) === E.SKILL_TYPE.PASSIVE ? -1 : center);
    const st = num(skill.table, 'TargetType');
    switch (buffTargetType) {
      case TT.OUR: return caster !== target;
      case TT.OUR_GRID:
        if (st === TT.ENEMY || st === TT.ENEMY_GRID || st === TT.ENEMY_ALL) { grid = ALL_GRID; no = fixed ? 4 : caster.gridPos; }
        else if (fixed) no = num(grid, 'StandardPoint');
        else if (no < 0 || no > 8 || st === TT.SELF) no = caster.gridPos;
        break;
      case TT.ENEMY: return false;
      case TT.ENEMY_GRID:
        if (!fixed && (st === TT.SELF || st === TT.OUR || st === TT.OUR_GRID || st === TT.OUR_ALL)) return false;
        if (no < 0 || no > 8) return false;
        break;
      default: return true;
    }
    return validGrid(grid, no, target);
  }

  // ------------------------------------------------------------------ apply conditions
  // Creature.CheckApplyBuffCondition (body/class/role lists; __MAX__ = any)
  function checkApplyBuffCondition(unit, row) {
    const ok = (col, maxV, v) => { const l = (row[col] === undefined ? [] : [].concat(row[col])).map(Number); return l.includes(maxV) || l.includes(v); };
    return ok('ApplyActorBodyType', E.ACTOR_BODY_TYPE.__MAX__, bodyType(unit)) &&
      ok('ApplyActorClassType', E.ACTOR_CLASS.__MAX__, classType(unit)) &&
      ok('ApplyActorRoleType', E.ROLE_TYPE.__MAX__, roleType(unit));
  }
  function condLists(row, n) {
    const s = n === 2 ? '2' : '';
    const raw = (k) => { const v = row[k]; return v === undefined || v === null ? [] : [].concat(v).map(String); };
    return {
      cond: num(row, 'BuffEffectTriggerApplyCondition' + s),
      vals: raw('BuffEffectTriggerApplyConditionValue' + s),
      subs: raw('BuffEffectTriggerValue_Sub' + s),
      attrType: num(row, 'BuffEffectTriggerBuffAttrType' + s),
    };
  }
  // Creature.CheckTriggerApplyCondition: both conditions must hold. `me` = triggerFromActor (buff owner),
  // `self` = the unit receiving the buff ("target" in the condition names), attackerAid = FromActorID.
  function checkTriggerApplyCondition(battle, self, me, row, attackerAid) {
    return checkCond(battle, self, me, condLists(row, 1), attackerAid) && checkCond(battle, self, me, condLists(row, 2), attackerAid);
  }
  const isApplyEnum = (u, t, at) => (at === BA.__MAX__ ? !!has(u, t) : !!has(u, t, at));
  const partyType = (me, enemy) => {
    const t = me.type === 'MONSTER' ? 'MONSTER' : 'CHARACTER';
    return enemy ? (t === 'MONSTER' ? 'CHARACTER' : 'MONSTER') : t;
  };
  const toByte = (s) => (parseInt(s, 10) || 0) & 255;
  function checkCond(battle, self, me, c, attackerAid) {
    const V = c.vals, S = c.subs;
    const st = state(battle);
    const round_ = (battle && battle.round) || 0;
    const enumCheck = (who, negate) => {
      const isAND = S[0] === 'AND', isOR = !isAND;
      for (const v of V) {
        const t = parseInt(v, 10);
        if (!Number.isFinite(t)) continue;
        let hit = isApplyEnum(who, t, c.attrType);
        if (negate) hit = !hit;
        if (hit) { if (isOR) return true; } else if (isAND) return false;
      }
      return isAND;
    };
    const countIs = (units, n) => units.length === n;
    switch (c.cond) {
      case AC.NONE: return true;
      case AC.IF_BUFFED_ENUM_ME: return enumCheck(me, false);
      case AC.IF_BUFFED_KEY_ME: return V.some((k) => hasKey(me, k));
      case AC.AT_FRONT_ROW_ME: return cell(me) === 0;
      case AC.AT_MID_ROW_ME: return cell(me) === 1;
      case AC.AT_BACK_ROW_ME: return cell(me) === 2;
      case AC.HP_RATIO_UP_ME: return V.some((v) => Number.isFinite(parseFloat(v)) && hpRate(me) >= F(parseFloat(v)));
      case AC.HP_RATIO_DOWN_ME: return V.some((v) => Number.isFinite(parseFloat(v)) && hpRate(me) <= F(parseFloat(v)));
      case AC.HP_RATIO_LESS_THEN_ME: { const at = findAid(battle, attackerAid); if (!at) return false; return !(hpRate(self) >= hpRate(at)); }
      case AC.HP_RATIO_MORE_THEN_ME: { const at = findAid(battle, attackerAid); if (!at) return false; return !(hpRate(self) <= hpRate(at)); }
      case AC.IFBUFF_STACK_COUNT_ME:
        if (V.length > 0 && V.length === S.length) for (let i = 0; i < V.length; ++i) { const n = parseInt(S[i], 10); if (Number.isFinite(n) && countKey(me, V[i]) >= n) return true; }
        return false;
      case AC.IF_BUFFED_ENUM_TARGET: return enumCheck(self, false);
      case AC.IF_BUFFED_KEY_TARGET: return V.some((k) => hasKey(self, k));
      case AC.HP_RATIO_UP_TARGET: return V.some((v) => Number.isFinite(parseFloat(v)) && hpRate(self) >= F(parseFloat(v)));
      case AC.HP_RATIO_DOWN_TARGET: return V.some((v) => Number.isFinite(parseFloat(v)) && hpRate(self) <= F(parseFloat(v)));
      case AC.SPC_CHAR_TARGET: return V.includes(self.key);
      case AC.SPC_CHAR_IN_BATTLE: return V.some((k) => allUnits(battle).some((u) => u.key === k));
      case AC.AT_FRONT_ROW_TARGET: return cell(self) === 0;
      case AC.AT_MID_ROW_TARGET: return cell(self) === 1;
      case AC.AT_BACK_ROW_TARGET: return cell(self) === 2;
      case AC.IF_BUFFED_KEY_ME_TOGETHER: return V.every((k) => hasKey(me, k));
      case AC.IF_BUFFED_KEY_COUNT_ME: case AC.IF_BUFFED_KEY_COUNT_TARGET: {
        const who = c.cond === AC.IF_BUFFED_KEY_COUNT_ME ? me : self;
        let n = 0; for (const k of V) n += countKey(who, k);
        const need = parseInt(S[0], 10);
        return S.length > 0 && Number.isFinite(need) && need <= n;
      }
      case AC.HP_RATIO_RANGE_ME: { // uses the receiving unit's HP (client code)
        if (V.length < 2) return false;
        const lo = parseFloat(V[0]), hi = parseFloat(V[1]);
        if (!Number.isFinite(lo) || !Number.isFinite(hi)) return false;
        const h = hpRate(self); return F(lo) <= h && F(hi) >= h;
      }
      case AC.IF_NOT_BUFFED_KEY_ME: return V.some((k) => !hasKey(me, k));
      case AC.IF_BUFF_STACK_COUNT_TARGET:
        if (V.length !== S.length) return false;
        for (let i = 0; i < V.length; ++i) { const n = parseInt(S[i], 10); if (Number.isFinite(n) && countKey(self, V[i]) >= n) return true; }
        return false;
      case AC.IF_NOT_BUFFED_KEY_ME_TOGETHER: return !V.some((k) => hasKey(me, k));
      case AC.CHECK_COUNT_OTHER_PARTY: return V.some((v) => countIs(ofType(battle, partyType(me, true)), toByte(v)));
      case AC.CHECK_COUNT_MY_PARTY: return V.some((v) => countIs(ofType(battle, partyType(me, false)), toByte(v)));
      case AC.CHECK_COUNT_ALL_PARTY: return V.some((v) => allUnits(battle).length === toByte(v));
      case AC.CHECK_COUNT_TURN_UP: case AC.CHECK_COUNT_TURN_DOWN: case AC.CHECK_COUNT_TURN:
      case AC.CHECK_COUNT_TURN_UP_SELF: case AC.CHECK_COUNT_TURN_DOWN_SELF: case AC.CHECK_COUNT_TURN_SELF: {
        const self_ = c.cond === AC.CHECK_COUNT_TURN_UP_SELF || c.cond === AC.CHECK_COUNT_TURN_DOWN_SELF || c.cond === AC.CHECK_COUNT_TURN_SELF;
        const tc = self_ ? (st.selfTurns.get(me.aid) || 0) : st.totalTurns;
        for (const v of V) {
          const req = parseInt(v, 10);
          if (c.cond === AC.CHECK_COUNT_TURN_UP || c.cond === AC.CHECK_COUNT_TURN_UP_SELF) { if (tc >= req) return true; }
          else if (c.cond === AC.CHECK_COUNT_TURN_DOWN || c.cond === AC.CHECK_COUNT_TURN_DOWN_SELF) { if (tc <= req) return true; }
          else if (tc === req) return true;
        }
        return false;
      }
      case AC.CHECK_TURN_EVEN_NUMBER: case AC.CHECK_TURN_ODD_NUMBER: {
        const tc = st.selfTurns.get(me.aid) || 0;
        return tc > 0 && tc % 2 === (c.cond === AC.CHECK_TURN_EVEN_NUMBER ? 0 : 1);
      }
      case AC.CHECK_COUNT_ROUND_UP: return V.some((v) => round_ >= toByte(v));
      case AC.CHECK_COUNT_ROUND_DOWN: return V.some((v) => round_ <= toByte(v));
      case AC.CHECK_COUNT_ROUND: return V.some((v) => round_ === toByte(v));
      case AC.SPC_CHAR_NOT_BATTLE: return !V.some((k) => allUnits(battle).some((u) => u.key === k));
      case AC.IFBUFF_COUNT_ME: // client reads the RECEIVING unit (IsApplyBuffCount on `this`)
        if (V.length !== S.length) return false;
        for (let i = 0; i < V.length; ++i) if (countKey(self, V[i]) === parseInt(S[i], 10)) return true;
        return false;
      case AC.CHECK_COUNT_BIO_MY_PARTY: case AC.CHECK_COUNT_AGS_MY_PARTY: case AC.CHECK_COUNT_BIO_ENEMY: case AC.CHECK_COUNT_AGS_ENEMY: {
        const enemy = c.cond === AC.CHECK_COUNT_BIO_ENEMY || c.cond === AC.CHECK_COUNT_AGS_ENEMY;
        const body = (c.cond === AC.CHECK_COUNT_BIO_MY_PARTY || c.cond === AC.CHECK_COUNT_BIO_ENEMY) ? E.ACTOR_BODY_TYPE.ANDROID : E.ACTOR_BODY_TYPE.ROBOT;
        const us = ofType(battle, partyType(me, enemy)).filter((u) => bodyType(u) === body);
        return V.some((v) => us.length === toByte(v));
      }
      case AC.IF_BUFFED_KEY_MY_PARTY: return V.some((k) => ofType(battle, partyType(me, false)).some((u) => hasKey(u, k)));
      case AC.IF_BUFFED_KEY_ENEMY_PARTY: return V.some((k) => ofType(battle, partyType(me, true)).some((u) => hasKey(u, k)));
      case AC.CHECK_COUNT_ACTOR_CLASS_MY_PARTY: case AC.CHECK_COUNT_ROLE_TYPE_MY_PARTY:
      case AC.CHECK_COUNT_ACTOR_CLASS_ENEMY_PARTY: case AC.CHECK_COUNT_ROLE_TYPE_ENEMY_PARTY: {
        const enemy = c.cond === AC.CHECK_COUNT_ACTOR_CLASS_ENEMY_PARTY || c.cond === AC.CHECK_COUNT_ROLE_TYPE_ENEMY_PARTY;
        const isClass = c.cond === AC.CHECK_COUNT_ACTOR_CLASS_MY_PARTY || c.cond === AC.CHECK_COUNT_ACTOR_CLASS_ENEMY_PARTY;
        const want = toByte(V[0]);
        // enemy variants key off CHARACTER (summons count as "MONSTER side" there) -- same as client
        const side = enemy ? (me.type === 'CHARACTER' ? 'MONSTER' : 'CHARACTER') : partyType(me, false);
        const us = ofType(battle, side).filter((u) => (isClass ? classType(u) : roleType(u)) === want);
        return S.some((v) => us.length === toByte(v));
      }
      case AC.IF_SPC_TROOPCATEGORY_KEY_ME: return false; // Table_TroopCategory not extracted (0 rows use it)
      case AC.CHECK_ROUND_EVEN_NUMBER: return ((round_ === 0 ? 1 : round_) % 2) === 0;
      case AC.CHECK_ROUND_ODD_NUMBER: return ((round_ === 0 ? 1 : round_) % 2) !== 0;
      case AC.IF_ALL_NOT_BUFFED_KEY_TARGET: case AC.IF_NOT_BUFFED_KEY_TARGET_TOGETHER: return !V.some((k) => hasKey(self, k));
      case AC.IF_NOT_BUFFED_KEY_TARGET: return V.some((k) => !hasKey(self, k));
      case AC.ME_ATK_HIGHER_THEN_DEF: case AC.ME_ATK_LOWER_THEN_DEF: {
        const r = parseFloat(V[0]); if (!Number.isFinite(r)) return false;
        const a = attrAbs(me, A.ATK) * F(r), d = attrAbs(me, A.DEF);
        return c.cond === AC.ME_ATK_HIGHER_THEN_DEF ? a > d : a < d;
      }
      case AC.ME_ATK_HIGHER_THEN_TARGET_ATK: return attrAbs(me, A.ATK) > attrAbs(self, A.ATK);
      case AC.ME_ATK_LOWER_THEN_TARGET_ATK: return attrAbs(me, A.ATK) < attrAbs(self, A.ATK);
      case AC.ME_DEF_HIGHER_THEN_TARGET_DEF: return attrAbs(me, A.DEF) > attrAbs(self, A.DEF);
      case AC.ME_DEF_LOWER_THEN_TARGET_DEF: return attrAbs(me, A.DEF) < attrAbs(self, A.DEF);
      case AC.ME_EVD_HIGHER_THEN_TARGET_EVD: return attrRate(me, A.EVADE) > attrRate(self, A.EVADE);
      case AC.ME_EVD_LOWER_THEN_TARGET_EVD: return attrRate(me, A.EVADE) < attrRate(self, A.EVADE);
      case AC.ME_SPD_HIGHER_THEN_TARGET_SPD: return attrAbs(me, A.TURNSPEED) > attrAbs(self, A.TURNSPEED);
      case AC.ME_SPD_LOWER_THEN_TARGET_SPD: return attrAbs(me, A.TURNSPEED) < attrAbs(self, A.TURNSPEED);
      case AC.IF_NOT_BUFFED_ENUM_ME: return enumCheck(me, true);
      case AC.IF_NOT_BUFFED_ENUM_TARGET: return enumCheck(self, true);
      case AC.OURTEAM_NEAR: case AC.OURTEAM_NOT_NEAR: {
        let near = 0;
        for (const u of ofType(battle, self.type)) {
          const nc = rowNo(self) === rowNo(u) && Math.abs(cell(self) - cell(u)) === 1;
          const nr = cell(self) === cell(u) && Math.abs(rowNo(self) - rowNo(u)) === 1;
          if (nc || nr) near++;
        }
        if (c.cond === AC.OURTEAM_NOT_NEAR) return near === 0;
        const need = parseInt(V[0], 10);
        return Number.isFinite(need) && near >= need;
      }
      case AC.IF_RANDOM_BUFF_KEY_RATE_TARGET: return true;
      case AC.SPC_CHAR_IN_BATTLE_MORE: {
        let cur = 0; for (const k of V) if (allUnits(battle).some((u) => u.key === k)) ++cur;
        const tn = parseInt(S[0], 10), mx = parseInt(S[1], 10);
        if (!Number.isFinite(tn) || !Number.isFinite(mx)) return false;
        return tn === cur || (tn === mx && mx <= cur);
      }
      case AC.IF_BUFFED_KEY_MY_PARTY_COUNT: case AC.IF_BUFFED_KEY_ENEMY_PARTY_COUNT: {
        let t = me.type;
        if (c.cond === AC.IF_BUFFED_KEY_ENEMY_PARTY_COUNT) t = t === 'CHARACTER' ? 'MONSTER' : t === 'MONSTER' ? 'CHARACTER' : t;
        let n = 0; for (const u of ofType(battle, t)) if (V.some((k) => hasKey(u, k))) ++n;
        return S.some((s) => n === parseInt(s, 10));
      }
      default: return true; // includes __MAX__ (77) = "no condition"
    }
  }

  // ------------------------------------------------------------------ ApplyBuffSub (one effect slot)
  function applyBuffSub(battle, target, isItem, triggerFrom, sortIndex, skill, row, type, val, perLevel, overType, leftTurnCount, attackerAid, strValue, itemLv) {
    const st = state(battle);
    if (!isItem) {
      if (!skill) { skill = skillFromBuffKey(target, row.Key); if (!skill) return null; }
      else if (!isHaveBuff(skill, row.Key)) return null;
    }
    if (type === BT.STAGE_BLOCK_CHARACTER) {
      const fa = findAid(battle, attackerAid);
      if (fa && fa.type !== target.type) return null;
      if (fa === target) return null;
    }
    const sucT = st.suc.get(target);
    if (sucT && sucT.has(row) && sucT.get(row).has(sortIndex)) return null;
    if (!checkApplyBuffCondition(target, row)) return null;
    if ((type === BT.STAGE_MOVE_BACK || type === BT.STAGE_MOVE_FRONT) && classType(target) === E.ACTOR_CLASS.ARMORED && roleType(target) === E.ROLE_TYPE.TANKER) return null;

    const tableTrig = num(row, 'BuffEffectTriggerType');
    const recorded = RECORDED_TRIGGERS.has(tableTrig) || isTurnTrigger(tableTrig) || attackerAid === ANOMALY_AID;
    if (!checkTriggerApplyCondition(battle, target, triggerFrom, row, attackerAid)) {
      if (recorded) {
        let fa = findAid(battle, attackerAid);
        if (!fa && attackerAid === ANOMALY_AID) fa = triggerFrom;
        if (fa) { if (!st.failed.has(fa)) st.failed.set(fa, new Set()); st.failed.get(fa).add(row); }
      }
      return null;
    }
    if (recorded) {
      if (!st.suc.has(target)) st.suc.set(target, new Map());
      const m = st.suc.get(target);
      if (!m.has(row)) m.set(row, new Set());
      m.get(row).add(sortIndex);
    }

    const attacker = findAid(battle, attackerAid);
    const isExt = !!(skill && skill.ext);
    let addSkillLevel = 0;
    if (attacker && attacker.type === 'CHARACTER' && stageBuffLevelUp(attacker) && !isItem && !isExt) addSkillLevel = stageBuffLevelUp(attacker);
    if (BEATEN_FAMILY.has(tableTrig) && triggerFrom && triggerFrom.type === 'CHARACTER' && stageBuffLevelUp(triggerFrom) && !isItem && !isExt) addSkillLevel = stageBuffLevelUp(triggerFrom);
    const skillLevel = !isItem ? skill.level : itemLv;

    const buff = {
      id: nextBuffId++, key: row.Key, row, sortIndex, type, attrType: num(row, 'BuffAttrType'),
      triggerType: tableTrig, eraseType: num(row, 'BuffEffectEraseType'), eraseTriggerType: num(row, 'BuffEffectEraseTriggerType'),
      value: val, strValue: strValue || '', perLevel, left: leftTurnCount, delay: 0,
      fromAid: attackerAid, from: attacker, skillKey: !isItem ? skill.key : '', skillLevel, addSkillLevel,
      overlapped: 0, attrValue: 0, attrRate: 0, isItem: !!isItem,
    };
    if (type === BT.BUFFER_ATK_ATKUP) buff.attrRate = F(buff.from ? buff.from.base[VT.ABS][A.ATK] : 0);

    // overlap max (per key or per overlap group)
    const overMax = num(row, 'BuffEffectOverlapMax');
    const isPassiveSkill = !isItem && skillType(skill) === E.SKILL_TYPE.PASSIVE;
    const usePassive = num(row, 'BuffUseType') === E.BUFF_USE_TYPE.PASSIVE;
    if (overMax > 0) {
      const group = num(row, 'BuffEffectOverlapGroup');
      if (group < 0) {
        if (countKey(target, row.Key) >= overMax) {
          let removed = false;
          if (overType === OV.__MAX__) {
            if (isItem) { if (!usePassive && hasKey(target, row.Key)) { removeOneByKey(battle, target, row.Key); removed = true; } }
            else if (isPassiveSkill || usePassive) {
              const rep = byLeftAsc(target.buffs.filter((b) => b.key === row.Key))[0];
              if (rep) Object.assign(rep, { skillKey: buff.skillKey, left: buff.left, delay: 0, fromAid: buff.fromAid, from: buff.from, type: buff.type, value: buff.value, skillLevel: buff.skillLevel, addSkillLevel: buff.addSkillLevel, perLevel: buff.perLevel, attrType: buff.attrType, sortIndex: buff.sortIndex, overlapped: 0, strValue: buff.strValue, row: buff.row });
            } else if (hasKey(target, row.Key)) { removeOneByKeyRound(battle, target, row.Key); removed = true; }
          }
          if (overType === OV.RENEW) removed = true;
          if (!removed) return null;
        }
      } else if (target.buffs.filter((b) => num(b.row, 'BuffEffectOverlapGroup') === group).length >= overMax) {
        let removed = false;
        if (overType === OV.__MAX__) {
          if (isItem) { if (!usePassive && hasKey(target, row.Key)) { removeOneByGroupRound(battle, target, group); removed = true; } }
          else if (target.buffs.some((b) => num(b.row, 'BuffEffectOverlapGroup') > 0 && num(b.row, 'BuffEffectOverlapGroup') === group)) { removeOneByGroupRound(battle, target, group); removed = true; }
        }
        if (overType === OV.RENEW) removed = true;
        if (!removed) return null;
      }
    }

    let skipAdd = false;
    const eraseType = buff.eraseType;
    if (overType === OV.NONE) {
      if (!(leftTurnCount === 0 && isDurationErase(eraseType)) && has(target, type)) return null;
    } else if (overType === OV.RENEW) {
      const ex = list_(target, type);
      if (ex.length) {
        if (type === BT.STAGE_BLOCK_CHARACTER) { const f = ex.find((b) => b.fromAid === attackerAid); if (f && !isTransform(f)) removeBuff(battle, target, f, 'renew'); }
        else removeType(battle, target, type);
      }
    } else if (overType === OV.ADDTURN && !isItem) {
      if (skillType(skill) === E.SKILL_TYPE.ACTIVE && has(target, type)) {
        for (const b of list_(target, type)) b.left += leftTurnCount; // Common.AddRound
        skipAdd = true;
      }
    } else if (overType === OV.OVERLAP && !isItem) {
      if (skillType(skill) === E.SKILL_TYPE.ACTIVE && has(target, type)) {
        for (const b of list_(target, type)) { // Common.AddEffect
          b.left = leftTurnCount; b.value = val;
          if (!(overMax > 0 && overMax - 1 <= b.overlapped)) { b.overlapped += 1; b.attrValue += F(levelValue(b)); }
        }
        skipAdd = true;
      }
    }

    if (!skipAdd) {
      target.buffs.push(buff);
      log(battle, { op: 'apply', unit: target.aid, key: row.Key, slot: sortIndex, type: typeName(type), value: val, left: leftTurnCount, from: attackerAid, lv: skillLevel + addSkillLevel });
    } else log(battle, { op: 'stack', unit: target.aid, key: row.Key, type: typeName(type), mode: overType === OV.ADDTURN ? 'ADDTURN' : 'OVERLAP' });
    recalc(battle, target);

    if (type === BT.STAGE_REMOVE_BUFF_ENUM) {
      const t = Math.trunc(buff.value);
      if (t < BT.__MAX__) {
        if (t === BT.STAGE_CHARCHANGE_PERMANENT || t === BT.STAGE_CHARCHANGE_LIMITED) { const b = has(target, t); if (b) removeBuff(battle, target, b, 'removeEnum'); }
        else removeType(battle, target, t);
      }
      if (t === BT.STAGE_REFLECTPHYSICS_RATIO_DEFENDER) target.flags.counterRemoved = true; // OnRemoveBuff
    }
    if (!(isPassiveSkill || isItem || usePassive) && type === BT.DEF_DAMAGE_REDUCE && attacker) {
      let d = Math.trunc(attackAbsDef(attacker)); if (d < 0) d = 0;
      buff.attrValue = Math.trunc(F(d * value(target, BT.DEF_DAMAGE_REDUCE)));
    }
    if (type === BT.STAGE_REMOVE_ALL_BUFF && removeByAttrType(battle, target, BA.BUFF, BT.__MAX__)) target.flags.counterRemoved = true;
    if (type === BT.STAGE_REMOVE_ALL_DEBUFF && removeByAttrType(battle, target, BA.DEBUFF, BT.__MAX__)) target.flags.counterRemoved = true;
    if (type === BT.STAGE_REMOVE_BUFF) {
      const t = Math.trunc(buff.value);
      if (t === BT.STAGE_REFLECTPHYSICS_RATIO_DEFENDER) target.flags.counterRemoved = true;
      removeByAttrType(battle, target, BA.BUFF, t);
    }
    recalc(battle, target);
    return buff;
  }
  const attackAbsDef = (u) => attrAbs(u, A.DEF);

  // ------------------------------------------------------------------ ApplyBuff (whole row: 5 effect slots)
  // Returns the list of created buffs (C# returns bool = list non-empty).
  function applyBuff(battle, target, isItem, triggerFrom, skill, triggerType, row, attacker, itemLv) {
    const out = [];
    if (!alive(target)) return out;
    const attrType = num(row, 'BuffAttrType');
    if (attrType === BA.BUFF && has(target, BT.BUFF_DISALLOW)) return out;
    const attackerAid = attacker ? attacker.aid : ANOMALY_AID;
    let upRate = 0;
    let downList = null, immList = null, disList = null;
    if (attrType === BA.DEBUFF) {
      for (const b of list_(target, BT.STAGE_DEBUFF_RATEUP)) { const v = F(levelValue(b)); upRate += v; b.attrValue = v; }
      downList = list_(target, BT.STAGE_DEBUFF_PERDOWN);
      for (const b of downList) b.attrValue = F(levelValue(b));
      immList = list_(target, BT.STAGE_IMMUNITY_DEBUFF);
    }
    if (attrType === BA.BUFF) disList = list_(target, BT.BUFF_DISALLOW_SPECIFIC);
    const enumDis = list_(target, BT.ENUM_DISALLOW_SPECIFIC);
    const immune = (l, t) => {
      if (!l || !l.length) return false;
      const f = l.find((p) => Math.trunc(p.value) === t);
      if (f) log(battle, { op: 'immune', unit: target.aid, key: row.Key, type: typeName(t), by: f.key });
      return !!f;
    };
    const rateCheck = (base, t) => { // Creature.IsCheckBuffRate
      if ((t === BT.STAGE_REMOVE_ALL_BUFF || t === BT.STAGE_REMOVE_BUFF) && has(target, BT.REMOVE_BUFF_RESIST)) base -= value(target, BT.REMOVE_BUFF_RESIST);
      if (downList && downList.length) {
        for (const b of downList) if (!(rng(battle) <= base - F(levelValue(b)))) return false;
        return true;
      }
      return rng(battle) <= base;
    };
    for (let i = 1; i <= 5; ++i) {
      const rate = fnum(row, 'BuffEffectRate' + i);
      if (!(rate > 0)) continue;
      const t = num(row, 'BuffEffectType' + i);
      if (!rateCheck(rate + upRate, t)) continue;
      if (immune(immList, t) || immune(disList, t) || immune(enumDis, t)) continue;
      const b = applyBuffSub(battle, target, isItem, triggerFrom, i, skill, row, t,
        fnum(row, 'BuffEffectValue' + i), fnum(row, 'BuffEffectLevelValue' + i),
        num(row, 'BuffEffectOverlapType' + i), num(row, 'BuffEffectLeftCount' + i), attackerAid,
        row['BuffEffectValue' + i] === undefined ? '0' : String(row['BuffEffectValue' + i]), itemLv === undefined ? 1 : itemLv);
      if (b) { b.triggerType = triggerType; out.push(b); }
    }
    return out;
  }

  // ------------------------------------------------------------------ candidate buff rows (Skill.GetBuffEffectTableList / Creature.ApplyItemBuffList)
  function matchRow(battle, actor, row, ctx, triggerType, skillKey) {
    const tt = num(row, 'BuffEffectTriggerType');
    const tv = str(row, 'BuffEffectTriggerValue');
    const att = ctx.attacker;
    const intRate = (u) => (u.maxHp > 0 ? Math.trunc(u.hp / u.maxHp) : 0); // C# int / int
    switch (tt) {
      case TR.HP_DOWN: return tv.length > 0 && hpRate(actor) < F(parseFloat(tv)) ? 1 : 0;
      case TR.HP_UP: return tv.length > 0 && hpRate(actor) > F(parseFloat(tv)) ? 1 : 0;
      case TR.BUFFED_TARGET: return ctx.targets && tv.length > 0 ? ctx.targets.filter((u) => hasKey(u, tv)).length : 0; // one entry per matching target
      case TR.USE_SKILL_SPEC: return tv.length > 0 && skillKey === tv ? 1 : 0;
      case TR.IF_BUFFED: return tv.length > 0 && hasKey(actor, tv) ? 1 : 0;
      case TR.HAVE_LESS_HP: return att && att.maxHp > 0 && actor.maxHp > 0 && intRate(att) > intRate(actor) ? 1 : 0;
      case TR.HAVE_MORE_HP: return att && att.maxHp > 0 && actor.maxHp > 0 && intRate(att) < intRate(actor) ? 1 : 0;
      case TR.AT_FRONT_ROW: return cell(actor) === 0 ? 1 : 0;
      case TR.AT_MID_ROW: return cell(actor) === 1 ? 1 : 0;
      case TR.AT_BACK_ROW: return cell(actor) === 2 ? 1 : 0;
      default:
        if (tt !== triggerType) return 0;
        if (triggerType === TR.GRID_NO) return actor.gridPos === toByte(ctx.value || '') ? 1 : 0;
        if (triggerType === TR.ATTACK_SUCCESS_AND_IF_BUFFED) return tv.length > 0 && hasKey(actor, tv) ? 1 : 0;
        return 1;
    }
  }
  function skillRows(battle, actor, skill, ctx, triggerType) {
    const out = [];
    const lt = skill.levelTable;
    if (!lt || num(lt, 'BuffEffectUseAvailable') !== E.BUFFEFFECT_USE_AVAILABLE.USE) return out;
    const rate = (parseFloat(lt.BuffEffectRate) || 0) + value(actor, BT.STAGE_BUFFEFFECTRATE_CHANGE);
    if (!(rng(battle) <= rate)) return out;
    for (const k of lvBuffs(skill)) {
      const row = rowOf(k);
      if (!row) continue;
      const n = matchRow(battle, actor, row, ctx, triggerType, skill.key);
      for (let i = 0; i < n; ++i) out.push(row);
    }
    return out;
  }
  function collectSkillRows(battle, actor, skill, ctx, triggerType) {
    const out = [];
    const sk = skillsOf(actor);
    if (skill && triggerType !== TR.ON_ATTACK && triggerType !== TR.SUMMON_CREATE) {
      const own = sk.find((s) => s.key === skill.key && !s.ext);
      if (own) {
        out.push(...skillRows(battle, actor, own, ctx, triggerType));
        for (const ext of sk.filter((s) => s.ext)) out.push(...skillRows(battle, actor, ext, ctx, triggerType));
      }
    } else {
      for (const s of sk) {
        if ((triggerType === TR.ON_ATTACK || triggerType === TR.SUMMON_CREATE) && skill) {
          if (skillSlot(s) < E.SKILL_SLOT_TYPE.SLOT_3 && skillSlot(s) !== skillSlot(skill)) continue;
        }
        out.push(...skillRows(battle, actor, s, ctx, triggerType));
      }
    }
    return out;
  }
  function itemRows(battle, actor, ctx, triggerType) {
    const out = [];
    if (actor.type !== 'CHARACTER') return out;
    for (const k of equipBuffKeys(actor)) {
      const row = rowOf(k);
      if (!row) continue;
      const n = matchRow(battle, actor, row, ctx, triggerType, ctx.skill ? ctx.skill.key : '');
      for (let i = 0; i < n; ++i) out.push(row);
    }
    return out;
  }

  // ------------------------------------------------------------------ erase checks (Creature.CheckErasePassiveBuff)
  function checkErasePassive(battle, unit, triggerType, ctx) {
    const skillKey = ctx.skill ? ctx.skill.key : null;
    const att = ctx.attacker;
    for (const b of unit.buffs.filter((x) => x.eraseType === ER.COUNT)) {
      const row = b.row;
      const ev = str(row, 'BuffEffectEraseTriggerValue');
      if (b.eraseTriggerType !== triggerType) continue;
      const dec = () => { if (b.left > 0) b.left--; };
      if (b.eraseTriggerType === TR.HP_DOWN) { if (unit.hp < (parseInt(ev, 10) || 0)) dec(); }
      else if (b.eraseTriggerType === TR.HP_UP) { if (unit.hp > (parseInt(ev, 10) || 0)) dec(); }
      else if (b.eraseTriggerType === TR.BUFFED_TARGET) { if (str(row, 'BuffEffectTriggerValue').length > 0 && hasKey(unit, ev)) dec(); }
      else if (b.eraseTriggerType === TR.USE_SKILL_SPEC) { if (skillKey && skillKey === ev) dec(); }
      else if (triggerType === TR.GRID_NO) { if (unit.gridPos === toByte(ev)) dec(); }
      else if (triggerType === TR.USE_SKILL_ENEMY) { if ((att && att.type === 'MONSTER') || unit.flags.beAttacked) dec(); }
      else if (b.type !== BT.STAGE_SHIELD_VALUE && b.type !== BT.STAT_ATK_RATIO && b.type !== BT.STAT_CRITICAL_RATIO &&
        b.type !== BT.STAGE_DEFPIERCE_RATIO && b.type !== BT.BARRIER_PIERCE) dec();
      if (b.left === 0) removeBuff(battle, unit, b, 'countErase');
    }
    for (const b of unit.buffs.filter((x) => x.eraseType === ER.TRIGGER)) {
      const row = b.row;
      const ev = str(row, 'BuffEffectEraseTriggerValue');
      let rm = false;
      if (b.eraseTriggerType === TR.HP_DOWN) rm = unit.hp < (parseInt(ev, 10) || 0);
      else if (b.eraseTriggerType === TR.HP_UP) rm = unit.hp > (parseInt(ev, 10) || 0);
      else if (b.eraseTriggerType === TR.BUFFED_TARGET) rm = str(row, 'BuffEffectTriggerValue').length > 0 && hasKey(unit, ev);
      else if (b.eraseTriggerType === TR.USE_SKILL_SPEC) rm = !!skillKey && skillKey === ev;
      else if (b.eraseTriggerType === triggerType) {
        if (triggerType === TR.GRID_NO) rm = unit.gridPos === toByte(ev);
        else rm = triggerType !== TR.USE_SKILL_ENEMY || b.type !== BT.STAGE_REFLECTPHYSICS_RATIO_DEFENDER;
      }
      if (rm) removeBuff(battle, unit, b, 'triggerErase');
    }
    recalc(battle, unit);
  }
  // Creature.CheckErasePassiveBuffTirgger (counter attack: USE_SKILL_ENEMY / AFTER_COUNTER)
  function eraseTrigger(battle, unit, triggerType) {
    if (triggerType !== TR.USE_SKILL_ENEMY && triggerType !== TR.AFTER_COUNTER) return;
    for (const b of unit.buffs.slice()) if (b.eraseType === ER.TRIGGER && b.eraseTriggerType === triggerType) removeBuff(battle, unit, b, 'triggerErase');
    recalc(battle, unit);
  }

  // ------------------------------------------------------------------ ApplyBuffTriggerList_Sub
  function applyTriggerSub(battle, owner, isItem, triggerType, skill, targets, attacker, rows, triggerTarget, isReapply) {
    let any = false;
    const isSkillNull = !skill;
    const notSelected = new Set();
    for (let i = 0; i < rows.length; ++i) {
      if (!isReapply && notSelected.has(i)) continue;
      const row = rows[i];
      let thisApplied = false;
      const localItem = isReapply ? (isItem || isItemBuffKey(owner, row.Key)) : isItem;
      const tgtType = num(row, 'BuffEffectTargetType');
      let noneTarget = !!(targets && targets.length);
      if ([TT.OUR_GRID, TT.ENEMY_GRID, TT.ALL_UNIT, TT.ALL_GRID, TT.SELF, TT.OUR_ALL, TT.ENEMY_ALL].includes(tgtType)) noneTarget = false;
      const doApply = (t, sk) => { const r = applyBuff(battle, t, localItem, owner, sk, triggerType, row, attacker, 1); if (r.length) { any = true; thisApplied = true; } };
      if (!noneTarget) {
        if (!localItem) {
          if (isSkillNull) skill = null;
          if (!skill) { skill = skillFromBuffKey(owner, row.Key); if (!skill) return any; }
        }
        let actors = [];
        if (tgtType === TT.ENEMY_GRID || tgtType === TT.ENEMY_ALL) {
          if (owner.type === 'CHARACTER') actors = ofType(battle, 'MONSTER');
          else if (owner.type === 'SUMMON') actors = ofType(battle, 'SUMMON').filter((u) => installPos(u) !== installPos(owner) && num(u.table, 'SummonType') === num(owner.table, 'SummonType'));
          else actors = ofType(battle, 'CHARACTER');
        } else if (tgtType === TT.OUR_GRID || tgtType === TT.OUR_ALL) {
          if (owner.type === 'CHARACTER') {
            actors = ofType(battle, 'CHARACTER');
            const ti = actors.findIndex((u) => u.key === 'Char_BR_Thetis_N'); // Thetis-last hack (Creature.cs:3349)
            if (ti >= 0 && ti < actors.length - 1) { const t = actors[ti]; actors[ti] = actors[actors.length - 1]; actors[actors.length - 1] = t; }
          } else if (owner.type === 'SUMMON') actors = ofType(battle, 'SUMMON').filter((u) => installPos(u) === installPos(owner) && num(u.table, 'SummonType') === num(owner.table, 'SummonType'));
          else actors = ofType(battle, 'MONSTER');
        } else if (tgtType === TT.ALL_UNIT || tgtType === TT.ALL_GRID) {
          const su = ofType(battle, 'SUMMON').filter(isSummonAutopilot);
          actors = ofType(battle, 'CHARACTER').concat(ofType(battle, 'MONSTER'),
            su.filter((u) => installPos(u) === E.INSTALL_POS_TYPE.PC), su.filter((u) => installPos(u) === E.INSTALL_POS_TYPE.MONSTER));
        } else if (tgtType === TT.SELF) actors = [owner];
        for (const t of actors) {
          if (localItem) { if (alive(t)) doApply(t, null); }
          else if (isGridInPos(skill, owner, t, tgtType)) doApply(t, skill);
        }
      } else if (tgtType === TT.ENEMY || tgtType === TT.OUR) {
        const want = (t) => (tgtType === TT.ENEMY ? owner.type !== t.type : owner.type === t.type);
        const sk = localItem ? null : skill; // NOTE: `skill` may be null/stale here exactly like the client
        if (triggerTarget) { if (want(triggerTarget)) doApply(triggerTarget, sk); }
        else for (const t of targets) if (t && want(t)) doApply(t, sk);
      }
      // IF_RANDOM_BUFF_KEY_RATE_TARGET: pick one of the following rows by weight
      if (!isReapply && thisApplied && num(row, 'BuffEffectTriggerApplyCondition') === AC.IF_RANDOM_BUFF_KEY_RATE_TARGET) {
        const keys = list(row, 'BuffEffectTriggerApplyConditionValue'), ws = [].concat(row.BuffEffectTriggerValue_Sub || []);
        const cand = [];
        let total = 0;
        if (keys.length === ws.length) {
          let ci = 0;
          for (let j = i + 1; j < rows.length && ci < keys.length; ++j) {
            if (rows[j].Key === keys[ci]) {
              const w = parseFloat(ws[ci]);
              if (Number.isFinite(w)) { cand.push([j, w]); total += w; }
              ++ci;
            }
          }
          if (Math.abs(1 - total) > 1e-6 && total > 0) for (const c of cand) c[1] /= total;
        }
        const r = rng(battle);
        let cum = 0;
        for (const [j, w] of cand) {
          cum += w;
          if (r <= cum) { for (const [k] of cand) if (k !== j) notSelected.add(k); break; }
        }
      }
    }
    return any;
  }

  // ------------------------------------------------------------------ ApplyBuffTriggerList (one owner)
  function triggerOwner(battle, owner, triggerType, ctx) {
    ctx = ctx || {};
    const attacker = ctx.attacker === undefined ? owner : ctx.attacker;
    const c = { skill: ctx.skill || null, targets: ctx.targets || null, attacker, value: ctx.value || '' };
    checkErasePassive(battle, owner, triggerType, c);
    const items = ctx.itemBuffs === false ? [] : itemRows(battle, owner, c, triggerType);
    if (owner.type === 'SUMMON' && !isSummonAutopilot(owner)) return false;
    const rows = collectSkillRows(battle, owner, c.skill, c, triggerType);
    if (rows.length || items.length) log(battle, { op: 'trigger', trigger: trigName(triggerType), owner: owner.aid, rows: rows.map((r) => r.Key), items: items.map((r) => r.Key) });
    let applied = false;
    if (rows.length) {
      const sk = (triggerType === TR.ON_ATTACK || triggerType === TR.SUMMON_CREATE) ? null : c.skill;
      applied = applyTriggerSub(battle, owner, false, triggerType, sk, c.targets, attacker, rows, ctx.target || null, false);
    }
    if (items.length) applyTriggerSub(battle, owner, true, triggerType, null, c.targets, attacker, items, ctx.target || null, false);
    return applied;
  }

  // public trigger(): ctx.owner given -> that unit only; else every live unit (sorted) as its own owner/attacker.
  function trigger(battle, triggerType, ctx) {
    ctx = ctx || {};
    if (ctx.owner) return triggerOwner(battle, ctx.owner, triggerType, ctx);
    let any = false;
    for (const u of sortedUnits(battle)) {
      if (!alive(u)) continue;
      any = triggerOwner(battle, u, triggerType, Object.assign({}, ctx, { owner: u, attacker: ctx.attacker || u })) || any;
    }
    return any;
  }

  // ------------------------------------------------------------------ anomaly (map environment) buffs
  function anomalyRows(battle) {
    const key = battle && (battle.anomalyKey || (battle.stage && str(battle.stage, 'AnomalyKey')));
    const an = key ? LOSim.T('Table_Anomaly', key) : null;
    return an ? list(an, 'BuffEffectIndex').map(rowOf).filter(Boolean) : [];
  }
  // ApplyPriorityAnomalyBuffs: every anomaly row (any trigger type) through each live creature, attacker = ANOMALY
  function applyAnomaly(battle) {
    const rows = anomalyRows(battle);
    if (!rows.length) return;
    const groups = new Map();
    for (const r of rows) { const t = num(r, 'BuffEffectTriggerType'); if (!groups.has(t)) groups.set(t, []); groups.get(t).push(r); }
    for (const u of sortedUnits(battle)) {
      if (!alive(u)) continue;
      for (const [t, rs] of groups) applyTriggerSub(battle, u, true, t, null, null, null, rs, null, false);
    }
    lastBuffCheck(battle, {});
  }

  // ------------------------------------------------------------------ LastBuffCheck (renewal) -- retry failed buffs
  function lastBuffCheck(battle, opt) {
    opt = opt || {};
    const st = state(battle);
    const anomaly = new Set(anomalyRows(battle));
    let passes = 0;
    for (const s of st.failed.values()) passes += s.size;
    passes = passes * 5 + 1;
    let applied = 0;
    while (passes-- > 0 && st.failed.size > 0) {
      const before = applied;
      for (const [owner, set] of Array.from(st.failed.entries())) {
        if (!alive(owner)) continue;
        const groups = new Map();
        for (const r of set) { const t = num(r, 'BuffEffectTriggerType'); if (!groups.has(t)) groups.set(t, []); groups.get(t).push(r); }
        for (const [t, rs] of groups) {
          const isEnv = rs.every((r) => anomaly.has(r));
          if (!isEnv && t === TR.ROUND_START && !opt.isRoundStart) continue;
          if (!isEnv && isTurnTrigger(t) && (!opt.turnOwner || !matchesTurnTrigger(t, owner === opt.turnOwner, sameTeam(owner, opt.turnOwner), opt.isTurnStart !== false))) continue;
          if (owner.type === 'SUMMON' && !isSummonAutopilot(owner)) continue;
          // ReApplyBuffTriggerList: environment tables as item buffs without attacker; others attacker = owner
          const env = rs.filter((r) => anomaly.has(r)), oth = rs.filter((r) => !anomaly.has(r));
          const cnt = () => owner.buffs.length;
          const n0 = cnt();
          if (env.length) applyTriggerSub(battle, owner, true, t, null, null, null, env, null, true);
          if (oth.length) applyTriggerSub(battle, owner, false, t, null, null, owner, oth, null, true);
          applied += Math.max(0, cnt() - n0);
          updateBuff(battle, owner);
        }
      }
      if (applied === before) break;
    }
    st.failed.clear();
    st.suc.clear();
  }
  // isPlayerTeam: characters + summons installed on the PC side
  const isPlayer = (u) => u.type === 'CHARACTER' || (u.type === 'SUMMON' && installPos(u) === E.INSTALL_POS_TYPE.PC);
  const sameTeam = (a, b) => isPlayer(a) === isPlayer(b);
  function matchesTurnTrigger(t, isSelf, isAlly, isStart) {
    if (isStart) return t === TR.TURN_START_ALL || (t === TR.TURN_START_SELF && isSelf) || (t === TR.TURN_START_ALLY && (isSelf || isAlly)) || (t === TR.TURN_START_ENEMY && !isSelf && !isAlly);
    return t === TR.TURN_END_ALL || (t === TR.TURN_END_SELF && isSelf) || (t === TR.TURN_END_ALLY && (isSelf || isAlly)) || (t === TR.TURN_END_ENEMY && !isSelf && !isAlly);
  }

  // ------------------------------------------------------------------ damage helper
  // Buff damage goes through LOSim.combat.applyDamage(battle, src, target, amount, info) when combat.js provides it.
  // FALLBACK (no combat.applyDamage): hp is subtracted directly, recorded in stats/log, and onDeath() is called.
  function buffDamage(battle, src, target, amount, info) {
    amount = Math.trunc(amount);
    if (LOSim.combat && typeof LOSim.combat.applyDamage === 'function') return LOSim.combat.applyDamage(battle, src, target, amount, info);
    target.hp -= amount;
    if (target.stats) target.stats.dmgTaken += amount;
    if (src && src.stats) src.stats.dmgDealt += amount;
    log(battle, Object.assign({ op: 'damage', unit: target.aid, from: src ? src.aid : null, amount, hp: target.hp }, info));
    if (target.hp <= 0) onDeath(battle, target, src);
    return amount;
  }

  // ------------------------------------------------------------------ UpdateBuff (ApplyBuffEffectBuffAll)
  function doBuffOnly(battle, unit, b) {
    const back = b.attrValue;
    b.attrValue = F(levelValue(b));
    switch (b.type) {
      case BT.STAGE_AP_VALUE: {
        const ap = b.attrValue;
        unit.turnPos = Math.min(ACTIVE_ROUND, Math.max(0, unit.turnPos + ap));
        if (unit.flags.apTracking) unit.flags.apCarry = Math.min(ACTIVE_ROUND, Math.max(0, (unit.flags.apCarry || 0) + ap));
        log(battle, { op: 'ap', unit: unit.aid, delta: ap, turnPos: unit.turnPos, key: b.key });
        break;
      }
      case BT.STAGE_AP_SHIFT:
        unit.turnPos = Math.min(ACTIVE_ROUND, Math.max(0, b.attrValue));
        if (unit.flags.apTracking) unit.flags.apCarry = unit.turnPos;
        b.attrValue = unit.turnPos;
        log(battle, { op: 'ap', unit: unit.aid, set: unit.turnPos, key: b.key });
        break;
      case BT.STAGE_AP_STOP: break;
      case BT.STAGE_REMOVE_BUFF: {
        const t = Math.trunc(b.value);
        if (t === BT.STAGE_REFLECTPHYSICS_RATIO_DEFENDER) unit.flags.counterRemoved = true;
        removeByAttrType(battle, unit, BA.BUFF, t);
        break;
      }
      case BT.STAGE_REMOVE_DEBUFF: removeByAttrType(battle, unit, BA.DEBUFF, Math.trunc(b.value)); break;
      case BT.STAGE_FIRE_DOT: case BT.STAGE_ICE_DOT: case BT.STAGE_LIGHTNING_DOT: {
        const res = b.type === BT.STAGE_FIRE_DOT ? A.FIRE_RESIST : b.type === BT.STAGE_ICE_DOT ? A.ICE_RESIST : A.LIGHTNING_RESIST;
        let d = F(levelValue(b)) * (1 - getResist(unit, res));
        d += d * b.overlapped;
        if (d <= 0) d = 1;
        b.attrValue = Math.trunc(F(d));
        break;
      }
      case BT.STAGE_REMOVE_BUFF_KEY_ALL_ATTRTYPE: removeAllByKey(battle, unit, b.strValue); break;
      case BT.STAGE_REMOVE_ALL_BUFF: if (removeByAttrType(battle, unit, BA.BUFF, BT.__MAX__)) unit.flags.counterRemoved = true; break;
      case BT.STAGE_REMOVE_ALL_DEBUFF: if (removeByAttrType(battle, unit, BA.DEBUFF, BT.__MAX__)) unit.flags.counterRemoved = true; break;
      default: if (back !== 0) b.attrValue = back;
    }
  }
  function getResist(unit, res) {
    return LOSim.stats && LOSim.stats.getResist ? LOSim.stats.getResist(unit, res) : attrRate(unit, res);
  }
  function afterPhysicsDamage(battle, unit, type) {
    for (const b of list_(unit, type)) {
      const from = b.from;
      if (!from) continue;
      let dmg;
      switch (type) {
        case BT.STAGE_PHYSICS_DAMAGE_APPLY: dmg = from.base[VT.ABS][A.ATK] * b.attrValue; break;
        case BT.RATIO_DMG_GIVER_MAX_HP: dmg = from.maxHp * value(unit, type); break;
        case BT.RATIO_DMG_GIVER_CURRENT_HP: dmg = from.hp * value(unit, type); break;
        case BT.RATIO_DMG_TARGET_MAX_HP: dmg = unit.maxHp * value(unit, type); break;
        case BT.RATIO_DMG_TARGET_CURRENT_HP: dmg = unit.hp * value(unit, type); break;
        default: return;
      }
      if (1 > dmg) return; // client returns from the whole function
      if (unit.hp > 0) buffDamage(battle, from, unit, Math.trunc(dmg), { damageType: E.eDamageType.BUFFEFFECT, buffType: typeName(type), key: b.key });
    }
  }
  function afterAttrDamage(battle, unit, type, res) {
    for (const b of list_(unit, type)) {
      const from = b.from;
      if (!from || unit.hp <= 0) continue;
      let dmg = from.base[VT.ABS][A.ATK] * b.attrValue * (1 - getResist(unit, res));
      if (1 > dmg) dmg = 1;
      buffDamage(battle, from, unit, Math.trunc(dmg), { damageType: E.eDamageType.BUFFEFFECT, buffType: typeName(type), key: b.key });
    }
  }
  function updateBuff(battle, unit) {
    if (!unit || !unit.buffs) return;
    for (const b of unit.buffs.slice()) if (!(b.delay > 0)) doBuffOnly(battle, unit, b); // snapshot, like the client
    afterPhysicsDamage(battle, unit, BT.STAGE_PHYSICS_DAMAGE_APPLY);
    afterPhysicsDamage(battle, unit, BT.RATIO_DMG_GIVER_MAX_HP);
    afterPhysicsDamage(battle, unit, BT.RATIO_DMG_GIVER_CURRENT_HP);
    afterPhysicsDamage(battle, unit, BT.RATIO_DMG_TARGET_MAX_HP);
    afterPhysicsDamage(battle, unit, BT.RATIO_DMG_TARGET_CURRENT_HP);
    afterAttrDamage(battle, unit, BT.STAGE_FIRE_DAMAGE_APPLY, A.FIRE_RESIST);
    afterAttrDamage(battle, unit, BT.STAGE_ICE_DAMAGE_APPLY, A.ICE_RESIST);
    afterAttrDamage(battle, unit, BT.STAGE_LIGHTNING_DAMAGE_APPLY, A.LIGHTNING_RESIST);
    removeRoundZero(battle, unit);
    recalc(battle, unit);
  }
  const updateAll = (battle) => { for (const u of allUnits(battle)) { recalc(battle, u); updateBuff(battle, u); } };

  // ------------------------------------------------------------------ statMods (DoBuffEffectTypeAttr)
  const REVERSE = {};
  REVERSE[BT.STAT_RESFIRE_RATIO] = BT.RESFIRE_DEBUFF_REVERSE;
  REVERSE[BT.STAT_RESICE_RATIO] = BT.RESICE_DEBUFF_REVERSE;
  REVERSE[BT.STAT_RESLIGHTNING_RATIO] = BT.RESLIGHTNING_DEBUFF_REVERSE;
  function statMods(unit) {
    const out = [];
    const map = (t) => (LOSim.stats && LOSim.stats.buffEffectToAttr ? LOSim.stats.buffEffectToAttr(t) : null);
    for (const b of unit.buffs || []) {
      if (b.delay > 0) continue;
      const back = b.attrValue;
      let v = round(F(levelValue(b)), 4);
      const m = map(b.type);
      if (!m) { b.attrValue = back !== 0 ? back : v; continue; }
      if (REVERSE[b.type] !== undefined && has(unit, REVERSE[b.type]) && v < 0) v = -v;
      if (b.type === BT.BUFFER_ATK_ATKUP) { v = F(v * b.attrRate); if (v < 0) v = 0; }
      b.attrValue = v;
      out.push({ attr: m.attr, valueType: m.valueType, value: v, rawValue: F(b.value + (b.skillLevel - 1) * b.perLevel), key: b.key, id: b.id });
    }
    return out;
  }

  // ------------------------------------------------------------------ DoT (owner turn end)
  function applyDot(battle, unit) {
    const killTriggers = (killer, skillKey) => {
      if (!killer) return;
      if (!((unit.type === 'MONSTER' && unit.type !== killer.type) || (unit.type !== 'MONSTER' && killer.type === 'MONSTER'))) return;
      const sk = skillsOf(killer).find((s) => s.key === skillKey) || null;
      triggerOwner(battle, killer, TR.IF_ENEMYKILL, { skill: sk, targets: [unit], attacker: killer });
      triggerOwner(battle, killer, TR.IF_ENEMYKILL_PASSIVE, { skill: null, targets: [unit], attacker: killer });
      triggerOwner(battle, killer, TR.IF_ENEMYKILL_AND_IF_COUNTERKILL, { skill: sk, targets: [unit], attacker: killer });
    };
    const run = (type, res) => {
      const bl = list_(unit, type);
      if (!bl.length) return;
      if (type === BT.STAGE_PHYSICS_DOT && unit.isSuperman) return;
      let dmg = 0, killer = null, killerSkill = null, from = null;
      for (const b of bl) {
        from = b.from;
        let t = F(levelValue(b));
        if (res !== null) t = t * (1 - getResist(unit, res));
        dmg += t + t * b.overlapped;
        if (1 > dmg) dmg = 1;
        if (unit.hp - Math.trunc(dmg) <= 0 && !killer) { killer = b.from; killerSkill = b.skillKey; }
      }
      if (unit.hp > 0) {
        buffDamage(battle, from, unit, Math.trunc(dmg), { damageType: E.eDamageType.DOT, buffType: typeName(type) });
        if (unit.hp <= 0) killTriggers(killer, killerSkill);
      }
    };
    run(BT.STAGE_PHYSICS_DOT, null);
    run(BT.STAGE_FIRE_DOT, A.FIRE_RESIST);
    run(BT.STAGE_ICE_DOT, A.ICE_RESIST);
    run(BT.STAGE_LIGHTNING_DOT, A.LIGHTNING_RESIST);
  }

  // ------------------------------------------------------------------ turn / round / wave hooks
  function turnTriggers(battle, owner, isStart) {
    const st = state(battle);
    if (isStart) { st.totalTurns++; st.selfTurns.set(owner.aid, (st.selfTurns.get(owner.aid) || 0) + 1); }
    for (const u of sortedUnits(battle)) {
      if (!alive(u)) continue;
      let rel;
      if (u === owner) rel = isStart ? TR.TURN_START_SELF : TR.TURN_END_SELF;
      else if (sameTeam(u, owner)) rel = isStart ? TR.TURN_START_ALLY : TR.TURN_END_ALLY;
      else rel = isStart ? TR.TURN_START_ENEMY : TR.TURN_END_ENEMY;
      triggerOwner(battle, u, rel, { attacker: u });
      if (u === owner) triggerOwner(battle, u, isStart ? TR.TURN_START_ALLY : TR.TURN_END_ALLY, { attacker: u });
      triggerOwner(battle, u, isStart ? TR.TURN_START_ALL : TR.TURN_END_ALL, { attacker: u });
    }
    lastBuffCheck(battle, { turnOwner: owner, isTurnStart: isStart });
    updateAll(battle);
  }
  // ApplyCreatureTurnBuffTrigger(owner, true). Call when the unit acquires its main turn (not for reserved skills).
  function onTurnStart(battle, unit) { if (unit) turnTriggers(battle, unit, true); }
  // ApplyCreatureTurnBuffTrigger(owner, false) + ApplyCreatureTurnEndDurations(owner)
  function onTurnEnd(battle, unit) {
    if (!unit) return;
    turnTriggers(battle, unit, false);
    if (!alive(unit)) return;
    const snapshot = unit.buffs.slice();
    applyDot(battle, unit);
    for (const b of snapshot) {
      if (!unit.buffs.includes(b)) continue;
      if (isDurationErase(b.eraseType)) { // LOEffect.reduceBuffTurns(true)
        --b.left;
        if (b.left < 1) removeBuff(battle, unit, b, 'expired');
      }
    }
    lastBuffCheck(battle, {});
    recalc(battle, unit);
    updateBuff(battle, unit);
  }
  // coNextRound (renewal), buff part. Call after battle.round was incremented, before choosing the next turn owner.
  function onRoundStart(battle) {
    applyAnomaly(battle);
    updateAll(battle);
    for (const u of sortedUnits(battle)) if (alive(u)) triggerOwner(battle, u, TR.ROUND_START, { attacker: u });
    lastBuffCheck(battle, { isRoundStart: true });
  }
  // Per-unit part of OnGameStart: ALWAYS, COMBAT_START, GRID_NO, FRIENDLY, ENEMY (passive skills + equipment).
  function applyEquipAndPassives(battle, unit) {
    const all = allUnits(battle);
    triggerOwner(battle, unit, TR.ALWAYS, { attacker: unit });
    triggerOwner(battle, unit, TR.COMBAT_START, { attacker: unit });
    triggerOwner(battle, unit, TR.GRID_NO, { attacker: unit, value: '' });
    const rowsByTrig = (t) => { const o = []; for (const s of skillsOf(unit)) { if (!s.levelTable || num(s.levelTable, 'BuffEffectUseAvailable') !== 1) continue; for (const k of lvBuffs(s)) { const r = rowOf(k); if (r && num(r, 'BuffEffectTriggerType') === t) o.push(r); } } return o; };
    for (const r of rowsByTrig(TR.FRIENDLY)) {
      const tv = str(r, 'BuffEffectTriggerValue');
      if (all.some((u) => u.key === tv && u.aid !== unit.aid)) applyBuff(battle, unit, false, unit, null, TR.FRIENDLY, r, unit, 1);
    }
    for (const r of rowsByTrig(TR.ENEMY)) {
      const tv = str(r, 'BuffEffectTriggerValue');
      if (all.some((u) => u.key === tv && u.aid !== unit.aid)) triggerOwner(battle, unit, TR.ENEMY, { attacker: unit });
    }
  }
  // OnGameStart buff part (wave entry). battle.js still owns TurnPos reset and first-turn calculation; call
  // onTurnStart(acquired owner) afterwards.
  function onWaveStart(battle) {
    const st = state(battle);
    st.totalTurns = 0; st.selfTurns.clear(); st.failed.clear(); st.suc.clear();
    let units = allUnits(battle).slice();
    const ti = units.findIndex((u) => u.key === 'Char_BR_Thetis_N');
    if (ti >= 0 && ti < units.length - 1) { const t = units[ti]; units[ti] = units[units.length - 1]; units[units.length - 1] = t; }
    applyAnomaly(battle);
    for (const u of units) applyEquipAndPassives(battle, u);
    for (const u of sortedUnits(battle)) if (alive(u)) triggerOwner(battle, u, TR.ROUND_START, { attacker: u });
    lastBuffCheck(battle, { isRoundStart: true });
    for (const u of units) updateBuff(battle, u);
    lastBuffCheck(battle, {});
    updateAll(battle);
  }
  // coEndRound buff part. Returns [{unit, expBonus}] from STAGE_EXP_UP (read before the buffs are cleared).
  function onWaveEnd(battle) {
    const exp = [];
    for (const u of allUnits(battle)) {
      if (u.type === 'CHARACTER' && has(u, BT.STAGE_EXP_UP)) {
        let v = 0; for (const b of list_(u, BT.STAGE_EXP_UP)) v += F(levelValue(b));
        exp.push({ unit: u, expBonus: Math.trunc(v * 10000) });
      }
    }
    for (const u of allUnits(battle)) { // RemoveBuffAll: keep transform + PRESERVE
      for (const b of u.buffs.slice()) if (!isTransform(b) && b.eraseType !== ER.PRESERVE) removeBuff(battle, u, b, 'waveEnd');
      recalc(battle, u); updateBuff(battle, u);
    }
    for (const u of allUnits(battle)) {
      const lim = has(u, BT.STAGE_CHARCHANGE_LIMITED);
      if (lim) removeBuff(battle, u, lim, 'waveEnd');
      triggerOwner(battle, u, TR.AFTER_WAVE, { attacker: u });
      lastBuffCheck(battle, {});
      updateBuff(battle, u);
    }
    return exp;
  }

  // ------------------------------------------------------------------ combat helpers
  // BattleManager.OnHitTriggerBuff + the HP_DOWN/HP_UP part of Creature.DoDamage (live victim, non-DoT damage).
  // opt = {isCounter, isAssist, skillAttr (SKILL_ATTR of the level table, default MagicSkillAttrType)}
  function onHit(battle, victim, attacker, skill, opt) {
    opt = opt || {};
    if (!alive(victim)) return;
    const lt = skill && skill.levelTable;
    triggerOwner(battle, victim, TR.BEATEN, { attacker: victim });
    if (!opt.isCounter && !opt.isAssist) {
      triggerOwner(battle, victim, TR.BEATEN_ACTIVESKILL, { attacker });
      const skKey = lt ? str(lt, 'SkillIndex') : (skill ? skill.key : '');
      for (const s of skillsOf(victim)) {
        if (!s.levelTable || num(s.levelTable, 'BuffEffectUseAvailable') !== 1) continue;
        for (const k of lvBuffs(s)) {
          const r = rowOf(k);
          if (r && num(r, 'BuffEffectTriggerType') === TR.BEATEN_ACTIVE_SKILL_KEY && str(r, 'BuffEffectTriggerValue') === skKey) triggerOwner(battle, victim, TR.BEATEN_ACTIVE_SKILL_KEY, { attacker });
        }
      }
    }
    // NOTE: adaptive element (RESIST_CHECK_ATTACK_POWER) selection is combat's; pass opt.skillAttr to override.
    const attr = opt.skillAttr !== undefined ? opt.skillAttr : num(lt, 'MagicSkillAttrType');
    triggerOwner(battle, victim, TR.BEATEN_PHY + attr, { attacker });
    triggerOwner(battle, victim, TR.HP_DOWN, { attacker: victim, value: String(victim.hp) });
    triggerOwner(battle, victim, TR.HP_UP, { attacker: victim, value: String(victim.hp) });
  }
  // BattleManager.OnAllyHitTriggerBuff (call for each ally of the victim that should react)
  function onAllyHit(battle, ally, attacker, skill, opt) {
    opt = opt || {};
    const lt = skill && skill.levelTable;
    triggerOwner(battle, ally, TR.BEATEN_ALLY, { attacker: ally });
    if (!opt.isCounter && !opt.isAssist) triggerOwner(battle, ally, TR.BEATEN_ACTIVESKILL_ALLY, { attacker });
    const attr = num(lt, 'MagicSkillAttrType');
    triggerOwner(battle, ally, [TR.BEATEN_PHY_ALLY, TR.BEATEN_FIRE_ALLY, TR.BEATEN_ICE_ALLY, TR.BEATEN_LIGHTNING_ALLY][attr] || TR.BEATEN_PHY_ALLY, { attacker });
  }
  // DoApplyBuff end-of-action part: USE_SKILL (+ USE_ACTIVE_SKILL_n) unless counter/assist, then UpdateBuff caster+targets.
  function afterSkill(battle, caster, skill, targets, opt) {
    opt = opt || {};
    if (!opt.isCounter && !opt.isAssist) {
      triggerOwner(battle, caster, TR.USE_SKILL, { skill, targets: targets || [], attacker: caster });
      const slot = skill ? skillSlot(skill) : 0;
      if (slot === E.SKILL_SLOT_TYPE.SLOT_1) triggerOwner(battle, caster, TR.USE_ACTIVE_SKILL_1, { skill: null, targets: targets || [], attacker: caster });
      else if (slot === E.SKILL_SLOT_TYPE.SLOT_2) triggerOwner(battle, caster, TR.USE_ACTIVE_SKILL_2, { skill: null, targets: targets || [], attacker: caster });
    }
    updateBuff(battle, caster);
    for (const t of targets || []) if (t) updateBuff(battle, t);
  }
  // Death processing: RemoveTargetResult (resurrect) / EventDie (DeathBuffeffect) / RemoveAuraBuffsFromCaster.
  // Returns true when the unit resurrected.
  function deathTriggers(battle, dead) {
    let mates = [], foes = [];
    if (dead.type === 'CHARACTER') { mates = ofType(battle, 'CHARACTER'); foes = ofType(battle, 'MONSTER'); }
    else if (dead.type === 'MONSTER') { mates = ofType(battle, 'MONSTER'); foes = ofType(battle, 'CHARACTER'); }
    for (const u of mates) triggerOwner(battle, u, TR.FRIENDLY_DEATH, { attacker: u });
    for (const u of foes) triggerOwner(battle, u, TR.ENEMY_DEATH, { attacker: u });
    triggerOwner(battle, dead, TR.DEATH, { attacker: dead });
    for (const u of allUnits(battle)) updateBuff(battle, u);
  }
  function onDeath(battle, unit) {
    if (!unit || unit.hp > 0 || unit.flags._dying) return false;
    unit.flags._dying = true;
    try {
      const rb = has(unit, BT.STAGE_RESURRECT_RATIO) || has(unit, BT.STAGE_RESURRECT);
      if (rb) {
        deathTriggers(battle, unit);
        removeBuff(battle, unit, rb, 'resurrect');
        unit.hp = rb.type === BT.STAGE_RESURRECT ? Math.trunc(rb.attrValue) : Math.trunc(unit.maxHp * rb.attrValue);
        log(battle, { op: 'resurrect', unit: unit.aid, hp: unit.hp, key: rb.key });
        recalc(battle, unit);
        triggerOwner(battle, unit, TR.IF_RESURRECT, { attacker: unit });
        return true;
      }
      removeAura(battle, unit);
      deathTriggers(battle, unit);
      return false;
    } finally { unit.flags._dying = false; }
  }
  function removeAura(battle, caster) {
    for (const t of allUnits(battle)) {
      let n = 0;
      for (const b of t.buffs.slice()) if (b.eraseType === ER.AURA && b.fromAid === caster.aid) { removeBuff(battle, t, b, 'auraCasterGone'); n++; }
      if (n) { recalc(battle, t); updateBuff(battle, t); }
    }
  }
  function onUnitRemoved(battle, unit) { removeAura(battle, unit); unit.buffs.length = 0; }
  // Const.BuffEffectAttackPassiveCountArr consumption after an attack (Creature.cs:7515)
  function consumeAttackPassiveCounts(battle, unit) {
    for (const t of [BT.STAT_ATK_RATIO, BT.STAT_CRITICAL_RATIO, BT.STAGE_DEFPIERCE_RATIO, BT.BARRIER_PIERCE]) {
      for (const b of list_(unit, t)) {
        if (b.eraseType === ER.COUNT && b.eraseTriggerType === TR.ATTACK_SUCCESS_PASSIVE) {
          b.left--;
          if (!(b.left > 0)) removeBuff(battle, unit, b, 'countUsed');
        }
      }
    }
    recalc(battle, unit);
  }
  // STAGE_SHIELD_VALUE block consumption (Creature.cs:7156): first shield buff, COUNT erase only
  function consumeShieldCount(battle, unit) {
    const b = list_(unit, BT.STAGE_SHIELD_VALUE)[0];
    if (b && b.eraseType === ER.COUNT) { b.left--; if (!(b.left > 0)) removeBuff(battle, unit, b, 'countUsed'); }
  }
  // Creature.RemoveBuffStack (skill Use_BuffStack / Stack_Consume)
  function removeStack(battle, unit, key, n) {
    let r = 0;
    for (const b of unit.buffs.filter((x) => x.key === key)) { if (n <= 0) break; if (isTransform(b)) continue; removeBuff(battle, unit, b, 'stackConsume'); n--; r++; }
    recalc(battle, unit);
    return r;
  }

  // ------------------------------------------------------------------ public apply()
  // Direct application of one Table_BuffEffect row (= Creature.ApplyBuff). src = triggerFromActor / owner of the skill,
  // level = item buff level when no skill is involved. ctx = {skill, attacker, triggerType, isItem, update}
  // Without ctx.skill the src skill that lists the effect is used; if none, it is applied like an item buff at `level`.
  function apply(battle, src, target, effectKey, level, ctx) {
    ctx = ctx || {};
    const row = rowOf(effectKey);
    if (!row || !target) return null;
    let skill = ctx.skill || null, isItem = !!ctx.isItem;
    if (!isItem && !skill) { skill = src ? skillFromBuffKey(src, effectKey) : null; if (!skill) isItem = true; }
    const attacker = ctx.attacker !== undefined ? ctx.attacker : src;
    const r = applyBuff(battle, target, isItem, src || target, isItem ? null : skill, ctx.triggerType !== undefined ? ctx.triggerType : num(row, 'BuffEffectTriggerType'), row, attacker, level || 1);
    ctx.applied = r;
    if (ctx.update) updateBuff(battle, target);
    return r[0] || null;
  }

  LOSim.buffs = {
    // contract
    apply, trigger, onTurnStart, onTurnEnd, onRoundStart, onWaveStart, onWaveEnd, value, has, remove, statMods, applyEquipAndPassives,
    // queries
    attrValue, list: list_, hasKey, countKey, levelValue,
    // hooks for combat.js / battle.js
    triggerOwner, updateBuff, updateAll, removeRoundZero, lastBuffCheck, onHit, onAllyHit, afterSkill, onDeath, onUnitRemoved,
    eraseTrigger, consumeAttackPassiveCounts, consumeShieldCount, removeStack, applyDot, buffDamage,
    // internals exposed for tests / tooling
    _checkTriggerApplyCondition: checkTriggerApplyCondition, _isGridInPos: isGridInPos, _applyBuff: applyBuff,
    STATUS: statusOf, NOTES, ANOMALY_AID,
  };
})();
