// LOSim.stats -- unit construction + attribute calculation.
// Port of (renewal build, BEFORE_BATTLE_RENEWAL not defined):
//   Assets/_Scripts/Utils/ActorAttr.cs              UpdateAttrPC / UpdateAttrMonster / UpdateAttrSummon / core link
//   Assets/_Scripts/Manager/BattleManager.cs        ApplyBuffEffectAttrAll (6160), CheckActiveSkill (7013)
//   Assets/_Scripts/CreatureBattle/Creature.cs      ApplyActorAttrEffect (5459), DoBuffEffectTypeAttr (5549), getters (2390, 7962)
//   Assets/_Scripts/CreatureBattle/Character.cs     UpdateAll/UpdateAttr (1549/1579), core link function effects (1629-1715)
//   Assets/_Scripts/CreatureBattle/Enemy.cs, Summon.cs, InfiniteWar/InfiniteBoss.cs
//   Assets/_Scripts/Manager/DataManager.Table.cs    GetTableSkillGroup (366), GetTableSkill (486)
//
// attr arrays are [VALUE_TYPE][ACTOR_ATTR_TYPE] exactly like Creature.attrValue.
// Convention inherited from the client: after the "rate apply" pass the ABS row holds the final value for
// ATK / DEF / HP / TURNSPEED, while the RATE row holds the final value for the percentage stats
// (APPLY, EVADE, CRI, *_RESIST, SKILL_ATTACK_RATE). The getters below read the right row.
(function () {
  const LOSim = (window.LOSim = window.LOSim || {});
  const E = LOSim.E;
  const num = LOSim.num, str = LOSim.str, list = LOSim.list;
  const T = (table, key) => LOSim.T(table, key);

  const ABS = E.VALUE_TYPE.ABS, RATE = E.VALUE_TYPE.RATE;
  const A = E.ACTOR_ATTR_TYPE;
  const NA = A.__MAX__;
  const CLB = E.CORE_LINK_BONUS;

  // ---------------------------------------------------------------- helpers
  const copyAttr = (src) => src.map((row) => row.slice());
  const zeroAttr = (attr) => { for (const row of attr) row.fill(0); };

  // ActorAttr.cs:105 IsRateValue
  function isRateValue(type) {
    return type === A.APPLY || type === A.EVADE || type === A.CRI ||
      type === A.FIRE_RESIST || type === A.ICE_RESIST || type === A.LIGHTNING_RESIST;
  }

  // ActorAttr.cs:179 / 344 / 693 / 735 "비율 값 적용": ABS = ABS * (1 + RATE)
  function applyRate(attr) {
    for (let i = 0; i < NA; ++i) attr[ABS][i] = attr[ABS][i] * (1 + attr[RATE][i]);
  }

  function globalValue(typeName) {
    const t = E.GLOBAL_VALUE_TYPE[typeName];
    const tbl = T('Table_GlobalValue') || {};
    for (const k in tbl) if (num(tbl[k], 'Type') === t) return tbl[k];
    return null;
  }

  // ---------------------------------------------------------------- PC attributes
  // Equipment value for an enchant level. ActorAttr.cs:73 GetEquippedItemAttrValueCount / :89 GetEquippedItemAttrValue
  function equipAttrValues(eq, enchant) {
    return list(eq, 'Lv' + enchant + '_DefaultAttrValue').map(Number);
  }
  function equipAttrTypes(eq) {
    // DefaultAttrType contains 0 (= ATK) legitimately; LOSim.list() drops '0' strings but keeps numeric 0.
    const v = eq && eq.DefaultAttrType;
    if (v === undefined || v === null) return [];
    return (Array.isArray(v) ? v : [v]).map(Number);
  }

  // ActorAttr.cs:361 UpdateEquippedItemAttrPC
  function addEquipAttr(attr, eq, enchant) {
    const types = equipAttrTypes(eq);
    const vals = equipAttrValues(eq, enchant);
    if (types.length !== vals.length) return; // :363 count mismatch -> item contributes nothing
    for (let i = 0; i < types.length; ++i) {
      const type = types[i];
      if (isRateValue(type)) attr[RATE][type] += vals[i]; // :370
      else attr[ABS][type] += vals[i];                    // :373
    }
  }

  // ActorAttr.cs:118 Convert_CoreLinkBonusType_To_ActorAttrType
  function coreBonusAttr(type) {
    switch (type) {
      case CLB.STAT_HP_RATIO: return A.HP;
      case CLB.STAT_ATK_RATIO: return A.ATK;
      case CLB.STAT_DEF_RATIO: return A.DEF;
      case CLB.STAT_RATING_RATIO: return A.APPLY;
      case CLB.STAT_AVOID_RATIO: return A.EVADE;
      case CLB.STAT_CRITICAL_RATIO: return A.CRI;
      case CLB.STAT_SPEED_RATIO: return A.TURNSPEED;
    }
    return A.__MAX__;
  }
  const isFuncCoreBonus = (t) => t === CLB.STAGE_RANGE_UP || t === CLB.STAGE_BUFFLEVEL_UP ||
    t === CLB.STAGE_EXP_UP || t === CLB.STAGE_SKILLRATIO_UP || t === CLB.COST_DOWN;

  // ActorAttr.cs:396 UpdateEquippedCorePC_Sub. corePC == null => 100% (full-link bonus / favor bonus)
  function addCoreBonus(attr, bonusKey, pcRow, corePC) {
    const b = T('Table_CoreLinkBonus', bonusKey);
    if (!b) return;
    const type = num(b, 'CoreLink_Bonus');
    if (isFuncCoreBonus(type)) return; // :404 functional bonuses handled in coreLinkFunc
    let point = 0.1; // :413 default 10%
    let firstPoint = 0;
    if (!corePC) point = 1; // :418
    else {
      const leftGrade = num(corePC, 'StartGrade') - 2; // :425
      if (leftGrade > 0) point += leftGrade * 0.05;    // :428
      firstPoint = point;
      if (pcRow.Key === corePC.Key) point = 1;         // :433 same character 100%
      else {
        if (num(pcRow, 'RoleType') === num(corePC, 'RoleType')) point += firstPoint;             // :440
        if (num(pcRow, 'ActorClassType') === num(corePC, 'ActorClassType')) point += firstPoint; // :447
      }
    }
    const coreAttrValue = num(b, 'CoreLink_Bonus_Value'); // :456
    if (point > 1) point = 1;                              // :457
    const resultValue = coreAttrValue * point;             // :458
    const at = coreBonusAttr(type);
    if (at === A.__MAX__) return;
    if (type === CLB.STAT_SPEED_RATIO) attr[ABS][at] += resultValue; // :462 speed is flat
    else attr[RATE][at] += resultValue;                                // :468
  }

  // Character.cs:1629 UpdateCoreLink_FunctionEffect_Sub
  function addCoreFunc(func, bonusKey) {
    const b = T('Table_CoreLinkBonus', bonusKey);
    if (!b) return;
    const type = num(b, 'CoreLink_Bonus');
    const v = num(b, 'CoreLink_Bonus_Value');
    if (type === CLB.STAGE_RANGE_UP) func.stageRangeUp += Math.trunc(v);
    else if (type === CLB.STAGE_BUFFLEVEL_UP) func.stageBuffLevelUp += Math.trunc(v);
    else if (type === CLB.STAGE_EXP_UP) func.stageExpUp += v;
    else if (type === CLB.STAGE_SKILLRATIO_UP) func.stageSkillRatioUp += v;
    else if (type === CLB.COST_DOWN) func.costDown += v;
  }
  const newCoreFunc = () => ({ stageRangeUp: 0, stageBuffLevelUp: 0, stageExpUp: 0, stageSkillRatioUp: 0, costDown: 0 });
  // IsStageRangeUp etc. flags are equivalent to value != 0.

  // DataManager.Table.cs:1789 GetTablePCPromotionBonus(pcKey, grade)
  function promotionBonus(pcKey, grade) {
    const tbl = T('Table_PCPromotionBonus') || {};
    for (const k in tbl) {
      const r = tbl[k];
      if (r.Promotion_PCKey === pcKey && num(r, 'PC_Grade') === grade) return r;
    }
    return null;
  }

  // Core slot list of a spec: array of PC keys occupying core (PCITEM) slots.
  // spec.cores (explicit list of PC keys) wins; otherwise spec.coreLink = N cores of the same character.
  function specCores(spec) {
    if (Array.isArray(spec.cores)) return spec.cores.filter((k) => !!k).slice(0, 5);
    const n = Math.max(0, Math.min(5, spec.coreLink | 0));
    return new Array(n).fill(spec.key);
  }

  // ActorAttr.cs:243 UpdateAttrPC (server/client shared). Returns attr after the rate-apply pass.
  // Inputs taken from the spec instead of ClientPcInfo (server data): grade, level, equips, cores, linkBonusKey, favor.
  function calcPCAttr(unit) {
    const pc = unit.table, pa = unit.ability, spec = unit.spec;
    const level = unit.level, grade = unit.grade;
    const attr = LOSim.newAttr(); // :246 InitAttrAll
    attr[ABS][A.ATK] = num(pa, 'AttackDmg') + num(pa, 'AddAttackDmgByLevel') * (level - 1);      // :249
    attr[ABS][A.DEF] = num(pa, 'DefenseDmg') + num(pa, 'AddDefenseDmgByLevel') * (level - 1);    // :252
    attr[ABS][A.HP] = num(pa, 'DefaultHP') + num(pa, 'DefaultHPByLevel') * (level - 1);          // :255
    attr[RATE][A.APPLY] = num(pa, 'ApplyRate') + num(pa, 'AddApplyRateByLevel') * (level - 1);   // :267
    attr[RATE][A.EVADE] = num(pa, 'EvadeRate') + num(pa, 'AddEvadeRateByLevel') * (level - 1);   // :270
    attr[RATE][A.CRI] = num(pa, 'CriRate') + num(pa, 'AddCriRateByLevel') * (level - 1);         // :273
    attr[RATE][A.FIRE_RESIST] = num(pa, 'FireResist');                                           // :276
    attr[RATE][A.ICE_RESIST] = num(pa, 'IceResist');                                             // :279
    attr[RATE][A.LIGHTNING_RESIST] = num(pa, 'EletronicResist');                                 // :282
    attr[ABS][A.TURNSPEED] = num(pa, 'TurnSpeed');                                               // :285

    // :288 promotion bonus (ClientData.cs:204 picks the row for (pcKey, current grade))
    const bonus = promotionBonus(pc.Key, grade);
    if (bonus && num(pc, 'StartGrade') < grade) {
      attr[ABS][A.ATK] += num(bonus, 'AttackDmg_Bonus');
      attr[ABS][A.DEF] += num(bonus, 'DefenseDmg_Bonus');
      attr[ABS][A.HP] += num(bonus, 'DefaultHP_Bonus');
      attr[RATE][A.APPLY] += num(bonus, 'ApplyRate_Bonus');
      attr[RATE][A.EVADE] += num(bonus, 'EvadeRate_Bonus');
      attr[RATE][A.CRI] += num(bonus, 'CriRate_Bonus');
      attr[RATE][A.FIRE_RESIST] += num(bonus, 'FireResist_Bonus');
      attr[RATE][A.ICE_RESIST] += num(bonus, 'IceResist_Bonus');
      attr[RATE][A.LIGHTNING_RESIST] += num(bonus, 'EletronicResist_Bonus');
      attr[ABS][A.TURNSPEED] += num(bonus, 'TurnSpeed_Bonus');
    }

    // :304 equipment
    for (const e of unit.equips) addEquipAttr(attr, e.table, e.enchant);

    // :313 core slots -> UpdateEquippedCorePC (:379): always uses the OWNER's Table_CoreLink.Link_Bonus,
    // scaled by the core PC's grade / role / class match.
    const linkTbl = T('Table_CoreLink', pc.Key);
    for (const coreKey of unit.cores) {
      const corePC = T('Table_PC', coreKey);
      if (!corePC || !linkTbl) continue; // :384 / :387
      for (const bk of list(linkTbl, 'Link_Bonus')) addCoreBonus(attr, bk, pc, corePC);
    }

    // :319 full-link (500%) bonus: client receives CoreLinkBonus_KeyString from the server.
    // ASSUMPTION: applied whenever spec.linkBonusKey is given (the UI should only offer it at 5 links).
    if (spec.linkBonusKey && T('Table_CoreLinkBonus', spec.linkBonusKey)) addCoreBonus(attr, spec.linkBonusKey, pc, null);

    // :326 favor (affection) max-expand bonus
    const fav = favorBonusKey(spec);
    if (fav) addCoreBonus(attr, fav, pc, null);

    // :337 enchant points are no longer summed (commented out in client)
    applyRate(attr); // :344
    return attr;
  }

  // ActorAttr.cs:326-335. spec.favor is the displayed value (ClientData ViewFavorPoint = FavorPoint/100);
  // FAVOR_MAX_EXPAND is compared against the raw FavorPoint, so raw = favor*100.
  function favorBonusKey(spec) {
    const gvMax = globalValue('FAVOR_MAX_EXPAND');
    const gvBonus = globalValue('FAVOR_EXPANDMAX_BONUS');
    if (!gvMax || !gvBonus) return '';
    const raw = (spec.favor || 0) * 100;
    if (raw >= Math.trunc(num(gvMax, 'Value'))) {
      const k = list(gvBonus, 'ValueStr')[0] || '';
      return T('Table_CoreLinkBonus', k) ? k : '';
    }
    return '';
  }

  // Character.cs:1681 UpdateCoreLink_FunctionEffect + :1590 full link + :1593 favor
  function calcCoreFunc(unit) {
    const func = newCoreFunc();
    for (const coreKey of unit.cores) {
      if (!T('Table_PC', coreKey)) continue;
      // :1692 replacement cores look up the OWNER's link table, other cores their own key
      const linkKey = (coreKey === 'Char_Core_Normal_N' || coreKey === 'Char_Core_Special_N') ? unit.key : coreKey;
      const linkTbl = T('Table_CoreLink', linkKey);
      if (!linkTbl) continue;
      for (const bk of list(linkTbl, 'Link_Bonus')) addCoreFunc(func, bk);
    }
    if (unit.spec.linkBonusKey) addCoreFunc(func, unit.spec.linkBonusKey);
    const fav = favorBonusKey(unit.spec);
    if (fav) addCoreFunc(func, fav);
    return func;
  }

  // ---------------------------------------------------------------- monster / summon attributes
  // ActorAttr.cs:646 UpdateAttrMonster (double) and :700 UpdateAttrSummon -- identical formulas.
  // startGrade is unused by the live formula (grade term is commented out at :653).
  function calcMobAttr(ab, level) {
    const attr = LOSim.newAttr();
    attr[ABS][A.ATK] = num(ab, 'AttackDmg') + num(ab, 'AddAttackDmgByLevel') * (level - 1);   // :663 / :705
    attr[ABS][A.DEF] = num(ab, 'DefenseDmg') + num(ab, 'AddDefenseDmgByLevel') * (level - 1); // :666 / :708
    attr[ABS][A.HP] = num(ab, 'DefaultHP') + num(ab, 'DefaultHPByLevel') * (level - 1);       // :669 / :711
    attr[RATE][A.APPLY] = num(ab, 'ApplyRate');               // :672 (no per-level growth for mobs)
    attr[RATE][A.EVADE] = num(ab, 'EvadeRate');               // :675
    attr[RATE][A.CRI] = num(ab, 'CriRate');                   // :678
    attr[RATE][A.FIRE_RESIST] = num(ab, 'FireResist');        // :681
    attr[RATE][A.ICE_RESIST] = num(ab, 'IceResist');          // :684
    attr[RATE][A.LIGHTNING_RESIST] = num(ab, 'EletronicResist'); // :687
    attr[ABS][A.TURNSPEED] = num(ab, 'TurnSpeed');            // :690
    applyRate(attr);                                          // :693
    return attr;
  }

  // Raw (pre-buff) attribute calc per creature type == the first line of each XXX.UpdateAttr().
  function calcRawAttr(unit) {
    if (unit.type === 'CHARACTER') return calcPCAttr(unit);   // Character.cs:1581 PC.UPdateAttrPC
    return calcMobAttr(unit.ability, unit.level);              // Enemy.cs:800 / InfiniteBoss.cs:298 / Summon.cs:424
  }

  // ---------------------------------------------------------------- buff -> attr
  // Creature.cs:5549 DoBuffEffectTypeAttr: which BUFFEFFECT_TYPE writes which attr/value row.
  // Exposed so buffs.js can build statMods() with the same mapping.
  // NOTE: STAT_SPEED_VALUE / STAT_SPEED_RATIO are commented out in the client (:5658) -> they do NOT change TURNSPEED.
  // NOTE: BUFFER_ATK_ATKUP: value = AttrValue * caster.baseAttr[ABS][ATK] (clamped >= 0), ATK/ABS (:5729).
  // NOTE: STAT_RES*_RATIO: buffs.js must flip negative values to positive when the unit has RES*_DEBUFF_REVERSE (:5677).
  const BE = E.BUFFEFFECT_TYPE;
  const BUFF_ATTR_MAP = {};
  const mapBE = (name, attr, vt) => { if (BE[name] !== undefined) BUFF_ATTR_MAP[BE[name]] = { attr, valueType: vt }; };
  mapBE('STAT_ATK_VALUE', A.ATK, ABS); mapBE('STAT_ATK_RATIO', A.ATK, RATE);
  mapBE('STAT_DEF_VALUE', A.DEF, ABS); mapBE('STAT_DEF_RATIO', A.DEF, RATE);
  mapBE('STAT_HP_VALUE', A.HP, ABS); mapBE('STAT_HP_RATIO', A.HP, RATE);
  mapBE('STAT_MAXHP_VALUE', A.MAXHP, ABS); mapBE('STAT_MAXHP_RATIO', A.MAXHP, RATE);
  mapBE('STAT_RATING_VALUE', A.APPLY, ABS); mapBE('STAT_RATING_RATIO', A.APPLY, RATE);
  mapBE('STAT_CRITICAL_VALUE', A.CRI, ABS); mapBE('STAT_CRITICAL_RATIO', A.CRI, RATE);
  mapBE('STAT_AVOID_VALUE', A.EVADE, ABS); mapBE('STAT_AVOID_RATIO', A.EVADE, RATE);
  mapBE('STAT_RESFIRE_VALUE', A.FIRE_RESIST, ABS); mapBE('STAT_RESFIRE_RATIO', A.FIRE_RESIST, RATE);
  mapBE('STAT_RESICE_VALUE', A.ICE_RESIST, ABS); mapBE('STAT_RESICE_RATIO', A.ICE_RESIST, RATE);
  mapBE('STAT_RESLIGHTNING_VALUE', A.LIGHTNING_RESIST, ABS); mapBE('STAT_RESLIGHTNING_RATIO', A.LIGHTNING_RESIST, RATE);
  mapBE('BUFFER_ATK_ATKUP', A.ATK, ABS);
  function buffEffectToAttr(buffEffectType) { return BUFF_ATTR_MAP[buffEffectType] || null; }

  // BattleManager.cs:6160 ApplyBuffEffectAttrAll + Creature.cs:5459 ApplyActorAttrEffect
  function applyBuffMods(unit, attr, mods) {
    // :6164 reset RATE of non-percentage stats so the rate is not applied twice
    for (let i = 0; i < NA; ++i) {
      if (i === A.APPLY || i === A.EVADE || i === A.SKILL_ATTACK_RATE || i === A.FIRE_RESIST ||
        i === A.ICE_RESIST || i === A.LIGHTNING_RESIST || i === A.CRI) continue;
      attr[RATE][i] = 0;
    }
    let hpModSig = 0, hpBefore = attr[ABS][A.HP], hasMaxHpMod = false;
    // :6180 ApplyActiveBuffEffectAttr -> DoBuffAttr -> ApplyActorAttrEffect, in buff list order
    for (const m of mods) {
      if (!m) continue;
      const v = Number(m.value) || 0;
      // MAXHP / HP use the raw buff value (BuffEffectValue + (SkillLevel-1)*PerLevel) without rounding;
      // buffs.js may supply m.rawValue for that, else m.value.
      const raw = m.rawValue !== undefined ? Number(m.rawValue) : v;
      if (m.attr === A.MAXHP) { // :5466
        const before = attr[ABS][A.HP];
        attr[ABS][A.HP] = m.valueType === ABS ? before + raw : before + before * raw;
        // :5483 SetMaxHp((int)attr HP) -> Character.cs:1396 / Enemy.cs:533: maxHp set, hp clamped
        unit.maxHp = Math.trunc(attr[ABS][A.HP]);
        if (unit.hp > unit.maxHp) unit.hp = unit.maxHp;
        hasMaxHpMod = true;
      } else if (m.attr === A.HP) { // :5485
        const before = attr[ABS][A.HP];
        attr[ABS][A.HP] = m.valueType === ABS ? before + raw : before + before * raw;
        hpModSig += (m.valueType === ABS ? 1 : 1000003) * raw;
      } else {
        // :5536 generic: attr[valueType][attrType] += Math.Round(value, 3)
        attr[m.valueType][m.attr] += Math.round(v * 1000) / 1000; // C# Math.Round is banker's; diff only at exact .0005 ties
      }
    }
    // :5491-5517 HP buffs also change current HP: hpCount = (int)(attrHPBefore / HP); afterHP = (int)(attrHPAfter / hpCount);
    // HP += afterHP - HP. APPROXIMATION: the client re-runs this on every UpdateAttr() (re-healing each time);
    // here it fires only when the set of HP mods changes (tracked by a signature), which is the intended behaviour.
    const prevSig = unit.flags._hpModSig || 0;
    if (hpModSig !== prevSig) {
      unit.flags._hpModSig = hpModSig;
      if (hpModSig !== 0 && unit.hp > 0) {
        const hpCount = Math.trunc(hpBefore / unit.hp);
        if (hpCount > 0) {
          const afterHP = Math.trunc(attr[ABS][A.HP] / hpCount);
          unit.hp = unit.hp + (afterHP - unit.hp);
        }
      }
    }
    void hasMaxHpMod; // MAXHP is never reset when the buff ends (client keeps the last SetMaxHp value).
    // :6183 final: ABS += ABS * RATE
    for (let i = 0; i < NA; ++i) attr[ABS][i] += attr[ABS][i] * attr[RATE][i];
  }

  // Creature.UpdateAttr(): raw attr + ApplyBuffEffectAttrAll. Writes unit.attr in place.
  function recalc(unit, battle) {
    const raw = calcRawAttr(unit);
    const mods = (LOSim.buffs && LOSim.buffs.statMods) ? (LOSim.buffs.statMods(unit, battle) || []) : [];
    applyBuffMods(unit, raw, mods);
    for (let v = 0; v < raw.length; ++v) for (let i = 0; i < NA; ++i) unit.attr[v][i] = raw[v][i];
    return unit;
  }

  // ---------------------------------------------------------------- skills
  const SKILL_SLOTS = 10;
  // Table_SkillLevel rows are keyed `${SkillIndex}_Lv${SkillLevel}` (verified: every row in skills.json).
  // DataManager.Table.cs:517 GetTableSkillLevel(skillIndex, level)
  function skillLevelRow(skillKey, level) {
    return T('Table_SkillLevel', skillKey + '_Lv' + level);
  }
  function makeSkill(skillKey, level, opts) {
    const table = T('Table_Skill', skillKey);
    if (!table) return null;
    let lv = Math.max(1, level | 0);
    const maxLv = num(table, 'MaxSkillLevel');
    if (maxLv > 0 && lv > maxLv) lv = maxLv;
    let lt = skillLevelRow(skillKey, lv);
    while (!lt && lv > 1) lt = skillLevelRow(skillKey, --lv); // safety: client would crash on a missing row
    if (!lt) return null;
    return Object.assign({
      key: skillKey, level: lv,
      slot: num(table, 'SkillSlotType'),           // Skill.cs:173 GetSlotType = Table_Skill.SkillSlotType
      type: num(table, 'SkillType'),               // SKILL_TYPE.ACTIVE(0) / PASSIVE(1)
      table, levelTable: lt, cooldownLeft: 0,
    }, opts || {});
  }

  // BattleManager.cs:7062 CheckActiveSkillCondition
  function checkActiveCond(condType, value, grade) {
    if (condType === E.SKILL_ACTIVE_TYPE.NONE) return true;
    if (condType === E.SKILL_ACTIVE_TYPE.GRADE) return grade >= value;
    return false;
  }

  // BattleManager.cs:7013 CheckActiveSkill -> [{key, level}] in group slot order, level = SkillDefaultLevelN.
  // Used for summons (Creature.cs:8868) and, by assumption, for the PC HaveSkillList the server sends.
  function groupSkillsByCondition(groupKey, grade) {
    const g = T('Table_SkillGroup', groupKey);
    const out = [];
    if (!g) return out;
    for (let i = 1; i <= SKILL_SLOTS; ++i) {
      if (!checkActiveCond(num(g, 'SkillActiveType' + i), num(g, 'SkillActiveValue' + i), grade)) continue;
      const k = str(g, 'SkillIndex' + i);
      if (!k || !T('Table_Skill', k)) continue; // :7085 ActiveSkill returns null for '' / unknown
      out.push({ key: k, defaultLevel: num(g, 'SkillDefaultLevel' + i), groupSlot: i });
    }
    return out;
  }

  // DataManager.Table.cs:366 GetTableSkillGroup(key, activeType, grade) via :486 GetTableSkill(key, grade)
  function groupSkillsForMob(groupKey, grade) {
    const g = T('Table_SkillGroup', groupKey);
    const out = [];
    if (!g) return out;
    const activeType = grade > 0 ? E.SKILL_ACTIVE_TYPE.GRADE : E.SKILL_ACTIVE_TYPE.NONE;
    for (let i = 1; i <= SKILL_SLOTS; ++i) {
      if (!(num(g, 'SkillActiveType' + i) <= activeType && num(g, 'SkillActiveValue' + i) <= grade)) continue;
      const k = str(g, 'SkillIndex' + i);
      if (!k || !T('Table_Skill', k)) continue;
      out.push({ key: k, defaultLevel: num(g, 'SkillDefaultLevel' + i), groupSlot: i });
    }
    return out;
  }

  // CreatureSkill.cs:27 InitSkill keeps one Skill per key (dictionary) -> dedupe, first wins.
  function pushUnique(arr, s) { if (s && !arr.some((x) => x.key === s.key && !!x.ext === !!s.ext)) arr.push(s); }

  // ---------------------------------------------------------------- equipment helpers
  // Common.cs:2737 GetPcEquipSlot: Slot01..09 item types. PCITEM slots hold cores, the others equipment.
  function equipSlots(pcKey) {
    const es = T('Table_EquipSlot', pcKey);
    const out = [];
    if (!es) return out;
    for (let i = 1; i <= 9; ++i) {
      const itemType = num(es, 'Slot0' + i + 'Type');
      out.push({ slotNo: i, itemType, isCore: itemType === E.ITEM_TYPE.PCITEM, subTypes: list(es, 'Slot0' + i + 'SubType').map(Number) });
    }
    return out;
  }
  // The 4 equipment slots (non-core), in slot order. PCSpec.equips[i] goes to equipSlotsOf(pcKey)[i].
  const equipSlotsOf = (pcKey) => equipSlots(pcKey).filter((s) => !s.isCore);

  // UI/Scene_CharacterDetails/Panel_ItemEquipInventory.cs:419-424 equip filter:
  // ItemType == slot type, RoleLimit == pc.RoleType || ROLE_TYPE.__MAX__, ClassLimit == pc.ActorClassType || ACTOR_CLASS.__MAX__,
  // PCLimit empty / '0' / == pc key. (LevelLimit is enforced server-side; not checked here.)
  function equipAllowed(pcRow, eq, slotItemType) {
    if (!pcRow || !eq) return false;
    if (slotItemType !== undefined && num(eq, 'ItemType') !== slotItemType) return false;
    const role = num(eq, 'RoleLimit'), cls = num(eq, 'ClassLimit');
    if (!(role === num(pcRow, 'RoleType') || role === E.ROLE_TYPE.__MAX__)) return false;
    if (!(cls === num(pcRow, 'ActorClassType') || cls === E.ACTOR_CLASS.__MAX__)) return false;
    const pcLimit = str(eq, 'PCLimit');
    if (pcLimit && pcLimit !== pcRow.Key) return false;
    return true;
  }

  // slotIndex: 0..3 = n-th equipment (non-core) slot of the PC.
  function listEquipCandidates(pcKey, slotIndex) {
    const pcRow = T('Table_PC', pcKey);
    const slot = equipSlotsOf(pcKey)[slotIndex];
    if (!pcRow || !slot) return [];
    const tbl = T('Table_ItemEquip') || {};
    const out = [];
    for (const k in tbl) if (equipAllowed(pcRow, tbl[k], slot.itemType)) out.push(k);
    return out;
  }

  // Creature.cs:8299 ApplyItemBuffList: LvN_BuffIndex (a Table_BuffEffect key) of each equipped item is
  // evaluated on EVERY trigger (ApplyBuffTriggerList, Creature.cs:3110) as an item buff with level 1
  // (ApplyBuff itemBuffLv default = 1, Creature.cs:3599). It is not a one-shot battle-start buff.
  function equipBuffKey(eq, enchant) { return str(eq, 'Lv' + enchant + '_BuffIndex'); }

  // ---------------------------------------------------------------- builders
  function finishBuild(unit) {
    recalc(unit, null);
    unit.maxHp = Math.trunc(unit.attr[ABS][A.HP]); // Character.cs:1768 MaxHP = (Int32)attr HP; mobs: see buildMonster
    unit.hp = unit.maxHp;
    return unit;
  }

  function defaultSpec(pcKey) {
    const pc = T('Table_PC', pcKey);
    if (!pc) return null;
    const grade = num(pc, 'StartGrade');
    const n = groupSkillsByCondition(str(pc, 'SkillGroupIndex'), num(pc, 'MaxGrade') || 5).length;
    return {
      key: pcKey, grade, level: Math.max(1, num(pc, 'DefaultLevel', 1)), gridPos: 0,
      skillLevels: new Array(n).fill(1), equips: [], coreLink: 0, favor: 0, linkBonusKey: '',
    };
  }

  // PCSpec: { key, grade, level, gridPos, skillLevels[], equips:[{key, enchant}], coreLink | cores:[pcKey],
  //           favor, linkBonusKey, extSkills?:[{key, level}] }
  function buildPC(specIn) {
    const def = defaultSpec(specIn && specIn.key);
    if (!def) throw new Error('buildPC: unknown PC ' + (specIn && specIn.key));
    const spec = Object.assign({}, def, specIn);
    const pc = T('Table_PC', spec.key);
    const ab = T('Table_PCAbility', spec.key); // Character.cs:233 GetTablePCAbility(pcInfo.Index)
    const unit = new LOSim.Unit({
      type: 'CHARACTER', team: 1, key: spec.key, table: pc, ability: ab,
      level: Math.max(1, spec.level | 0), grade: spec.grade | 0, gridPos: spec.gridPos,
    });
    unit.spec = spec;
    unit.warnings = [];

    // equipment (non-PCITEM slots, ClientData.cs:262)
    const slots = equipSlotsOf(spec.key);
    unit.equips = [];
    unit.equipBuffs = [];
    (spec.equips || []).slice(0, slots.length).forEach((e, i) => {
      if (!e || !e.key) return;
      const eq = T('Table_ItemEquip', e.key);
      if (!eq) { unit.warnings.push('unknown equip ' + e.key); return; }
      const enchant = Math.max(0, Math.min(10, e.enchant | 0));
      if (!equipAllowed(pc, eq, slots[i].itemType)) unit.warnings.push('equip ' + e.key + ' not allowed in slot ' + slots[i].slotNo);
      unit.equips.push({ key: e.key, enchant, slotNo: slots[i].slotNo, table: eq });
      const bk = equipBuffKey(eq, enchant);
      if (bk) unit.equipBuffs.push({ effectKey: bk, level: 1, equipKey: e.key, enchant });
    });
    unit.cores = specCores(spec);
    unit.coreLinkFunc = calcCoreFunc(unit);

    // skills: HaveSkillList comes from the server. ASSUMPTION: equals CheckActiveSkill(SkillGroupIndex, grade)
    // order (group slot 1..10, grade gate), with levels from spec.skillLevels[i] (default SkillDefaultLevel / 1).
    // Character.cs:174 InitCharacter adds them in list order.
    const grp = groupSkillsByCondition(str(pc, 'SkillGroupIndex'), unit.grade);
    grp.forEach((g, i) => {
      const lv = (spec.skillLevels && spec.skillLevels[i]) || g.defaultLevel || 1;
      pushUnique(unit.skills, makeSkill(g.key, lv));
    });
    // Character.cs:198 ExtSkillList (extended passive skills; server data). Only from spec.extSkills.
    for (const x of spec.extSkills || []) pushUnique(unit.skills, makeSkill(x.key, x.level || 1, { ext: true }));

    unit.base = calcPCAttr(unit); // Character.cs:1553 baseAttrValue = DeepCopy(attr) right after UPdateAttrPC (no buffs)
    return finishBuild(unit);
  }

  // opts = {gridPos, wave, isIW, grade}
  function buildMonster(key, level, opts) {
    opts = opts || {};
    const isIW = !!opts.isIW;
    const table = isIW ? T('Table_MonsterIW', key) : T('Table_Monster', key);
    if (!table) throw new Error('buildMonster: unknown monster ' + key);
    const ab = T('Table_MonsterAbility', key); // Enemy.cs:209 / InfiniteBoss.cs:191 GetTableMonsterAbility(index)
    // ASSUMPTION: NetMonsterInfo.Level / Grade come from the server; we use the given level (default
    // Table.DefaultLevel) and Table.StartGrade.
    const lv = Math.max(1, (level | 0) || num(table, 'DefaultLevel', 1));
    const grade = opts.grade !== undefined ? opts.grade : num(table, 'StartGrade');
    const unit = new LOSim.Unit({
      type: 'MONSTER', team: 0, key, table, ability: ab, level: lv, grade,
      gridPos: opts.gridPos, aiKey: str(table, 'AIKeyString'),
    });
    unit.isIW = isIW;
    unit.wave = opts.wave;
    unit.equips = []; unit.equipBuffs = []; unit.cores = []; unit.coreLinkFunc = newCoreFunc();

    const groupKey = str(table, 'SkillGroupIndex');
    let list0;
    if (isIW) list0 = groupSkillsForMob(groupKey, num(table, 'StartGrade')); // InfiniteBoss.cs:174
    else {
      list0 = groupSkillsForMob(groupKey, 0);                 // Enemy.cs:193
      const have = groupSkillsForMob(groupKey, grade);        // Enemy.cs:194
      if (have.length > 0) list0 = have;
    }
    // Enemy.cs:203 / InfiniteBoss.cs:316: monsters always use skill level 1 (SkillDefaultLevel is NOT used).
    for (const g of list0) pushUnique(unit.skills, makeSkill(g.key, 1));

    unit.base = calcMobAttr(ab, lv); // Enemy.cs:73 baseAttrValue = UpdateAttrMonster (no buffs)
    // ASSUMPTION: NetMonsterInfo.MaxHP / HP are server values; we use (int)attr HP like the summon path (Creature.cs:8863).
    return finishBuild(unit);
  }

  // Creature.cs:8857-8868 summon creation: level = SkillLevel.SummonLevel (passed in), grade = Table_Summon.StartGrade,
  // HP = MaxHP = (int)attr HP, skills = CheckActiveSkill(SkillGroupIndex, grade) with SkillDefaultLevel.
  function buildSummon(key, level, owner, gridPos) {
    const table = T('Table_Summon', key);
    if (!table) throw new Error('buildSummon: unknown summon ' + key);
    const ab = T('Table_SummonAbility', key); // Summon.cs:97
    const grade = num(table, 'StartGrade');
    const lv = Math.max(1, (level | 0) || num(table, 'DefaultLevel', 1));
    const unit = new LOSim.Unit({
      type: 'SUMMON',
      // Creature.cs:8866 TeamId from InstallPosType; follow the owner's side when known.
      team: owner ? owner.team : (num(table, 'InstallPosType') === E.INSTALL_POS_TYPE.PC ? 1 : 0),
      key, table, ability: ab, level: lv, grade, gridPos, aiKey: str(table, 'AIKeyString'),
    });
    unit.owner = owner || null;
    unit.equips = []; unit.equipBuffs = []; unit.cores = []; unit.coreLinkFunc = newCoreFunc();
    for (const g of groupSkillsByCondition(str(table, 'SkillGroupIndex'), grade)) {
      pushUnique(unit.skills, makeSkill(g.key, g.defaultLevel || 1)); // Summon.cs:85 level = HaveSkillList SkillLevel
    }
    // Creature.cs:8859 creation-time calc uses float[,]: HP = (int)fround(...)
    const createAttr = calcMobAttr(ab, lv);
    finishBuild(unit);
    unit.maxHp = unit.hp = Math.trunc(Math.fround(createAttr[ABS][A.HP]));
    // Summon.cs:415 baseAttrValue = attrValue (same array reference -> base follows buffs). Mirrored by aliasing.
    unit.base = unit.attr;
    return unit;
  }

  // ---------------------------------------------------------------- getters (Creature.cs)
  // Creature.cs:2390 GetTurnSpeed: floor 1
  function getTurnSpeed(u) { const v = u.attr[ABS][A.TURNSPEED]; return 1 > v ? 1 : v; }
  // Creature.cs:2398 GetATk: floor 1
  function getAtk(u) { const v = u.attr[ABS][A.ATK]; return 1 > v ? 1 : v; }
  // Character.cs:1794 / Summon.cs:232 / Enemy.cs:803 GetBaseAtt
  function getBaseAtk(u) { return u.base[ABS][A.ATK]; }
  // DEF has no getter in the client; damage code reads attrValue[ABS, DEF] directly (Creature.cs:6933)
  function getDef(u) { return u.attr[ABS][A.DEF]; }
  function getHp(u) { return u.hp; }
  function getMaxHp(u) { return u.maxHp; }
  // Percentage stats are read from the RATE row (Creature.cs:6651 APPLY, :6654 EVADE, :6800 CRI)
  function getEvade(u) { return u.attr[RATE][A.EVADE]; }
  function getCri(u) { return u.attr[RATE][A.CRI]; }
  function getApply(u) { return u.attr[RATE][A.APPLY]; }
  function getSkillAttackRate(u) { return u.attr[RATE][A.SKILL_ATTACK_RATE]; } // Creature.cs:6868

  // Creature.cs:7962 GetResist(resistType)
  const RESIST_INFO = {};
  RESIST_INFO[A.FIRE_RESIST] = ['RESFIRE_VALUE_MIN', 'RESFIRE_VALUE_FIX', 'MIN_FIRE_RESIST', 'MAX_FIRE_RESIST'];
  RESIST_INFO[A.ICE_RESIST] = ['RESICE_VALUE_MIN', 'RESICE_VALUE_FIX', 'MIN_ICE_RESIST', 'MAX_ICE_RESIST'];
  RESIST_INFO[A.LIGHTNING_RESIST] = ['RESLIGHTNING_VALUE_MIN', 'RESLIGHTNING_VALUE_FIX', 'MIN_LIGHTNING_RESIST', 'MAX_LIGHTNING_RESIST'];
  function getResist(u, resistType) {
    let resistValue = u.attr[RATE][resistType];
    const info = RESIST_INFO[resistType];
    // :7966 default min/fix types are the FIRE ones; system bounds are +-inf for other types
    const minType = BE[info ? info[0] : 'RESFIRE_VALUE_MIN'];
    const fixType = BE[info ? info[1] : 'RESFIRE_VALUE_FIX'];
    let sysMin = -Infinity, sysMax = Infinity;
    if (info) {
      // r15554 Creature.cs:7978-7991: GetTableGlobalValue(...)?.Value ?? 0 -- a missing row now clamps to 0
      // (before r15554 a missing row threw NullReferenceException)
      const gmin = globalValue(info[2]), gmax = globalValue(info[3]);
      sysMin = gmin ? num(gmin, 'Value') : 0;
      sysMax = gmax ? num(gmax, 'Value') : 0;
    }
    const B = LOSim.buffs;
    // :7995 FIX buffs: sum of (BuffEffectValue + (lv-1)*PerLevel) replaces everything (no system clamp)
    if (B && B.has && B.value && B.has(u, fixType)) return B.value(u, fixType);
    // :8007 MIN buffs raise the floor
    if (B && B.has && B.value && B.has(u, minType)) {
      const minValue = B.value(u, minType);
      if (resistValue < minValue) resistValue = minValue;
    }
    if (resistValue < sysMin) resistValue = sysMin;          // :8021
    else if (resistValue > sysMax) resistValue = sysMax;
    return resistValue;
  }

  LOSim.stats = {
    buildPC, buildMonster, buildSummon, recalc,
    getTurnSpeed, getAtk, getBaseAtk, getDef, getHp, getMaxHp, getEvade, getCri, getApply, getSkillAttackRate, getResist,
    listEquipCandidates, defaultSpec,
    // extras for other modules / UI
    equipSlots, equipSlotsOf, buffEffectToAttr, isRateValue,
    calcRawAttr, skillLevelRow, makeSkill,
    groupSkillsByCondition, groupSkillsForMob,
  };
})();
