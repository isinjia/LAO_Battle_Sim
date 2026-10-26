// LOSim.audit -- per-character mechanic audit ("캐릭터 점검"). Pure logic shared by
//   audit-worker.js (browser Web Worker), tools/audit_node.js (headless CLI) and audit.js (report formatting only).
// Needs the engine loaded (enums, core, stats, buffs, combat, ai, battle) and LOSim.data. Runtime checks mutate
// LOSim.data.stages / LOSim.data.units by adding private "__AUDIT_*" rows -- only call them in a worker or in node,
// never on the page's main thread.
//
// Entry points
//   A.listPCs()                                   playable characters (same filter as app.js)
//   A.auditCharacter(pcKey, opts, desc)           -> CharResult  (static + runtime)
//   A.staticCheck(pcKey, opts, desc)              -> {findings, skills}
//   A.runtimeCheck(pcKey, opts)                   -> {findings, stats}
//   A.summarize(results) / A.markdown(results, info) / A.findingsMarkdown(results, max)
//   desc = contents of data/skilldesc.json ({skills:{key:{n,d,s}}, buffs:{key:{d:[5]}}}) or null (description checks skipped)
//
// Finding = {sev:'error'|'suspect'|'unverified'|'simlimit'|'info', code, cat:'static'|'desc'|'runtime',
//            char, charName, skill, skillName, effect, slot, msg, evidence, ref, conf:'high'|'med'|'low'}
(function () {
  const LOSim = (window.LOSim = window.LOSim || {});
  const A = (LOSim.audit = LOSim.audit || {});
  A.VERSION = '1.0';
  const E = () => LOSim.E;
  const T = (t, k) => LOSim.T(t, k);
  const num = (r, k, d) => LOSim.num(r, k, d);
  const str = (r, k, d) => LOSim.str(r, k, d);
  const list = (r, k) => LOSim.list(r, k);
  const ename = (en, v) => (LOSim.Ename && LOSim.Ename[en] && LOSim.Ename[en][v]) || String(v);

  A.SEV = { error: '오류', suspect: '의심', unverified: '미확인', simlimit: '시뮬레이터 한계', info: '참고' };
  A.SEV_ORDER = { error: 0, suspect: 1, unverified: 2, simlimit: 3, info: 4 };
  A.CONF = { high: '높음', med: '보통', low: '낮음' };
  A.DEFAULTS = { grade: 'max', level: 90, skillLevel: 10, includeStatic: true, includeRuntime: true, actions: 42, seed: 1, squad: true, gradeScan: true, descMatch: true };

  // ------------------------------------------------------------------ lists
  A.listPCs = function () {
    const rows = Object.values(T('Table_PC') || {});
    return rows.filter((p) => num(p, 'IsUse') === 1 && num(p, 'IsHavingTurn') === 1)
      .map((p) => ({ key: p.Key, name: LOSim.name(p.Name, p.Key), startGrade: num(p, 'StartGrade', 1), maxGrade: num(p, 'MaxGrade', 5), cls: num(p, 'ActorClassType'), role: num(p, 'RoleType') }))
      .filter((p) => !/Dummy|Test/i.test(p.key) && !/더미|테스트/.test(p.name))
      .filter((p) => num(T('Table_PC', p.key), 'Enchant_Exclusive') !== 1 && !/TrainingDummy/.test(str(T('Table_PC', p.key), 'SkillGroupIndex'))) // enhancement modules / cores (no real kit)
      .sort((a, b) => a.name.localeCompare(b.name, 'ko'));
  };

  const skillName = (key) => { const s = T('Table_Skill', key); return s ? LOSim.name(str(s, 'SkillName'), key) : key; };
  const lvRow = (key, lv) => T('Table_SkillLevel', key + '_Lv' + lv);
  const fl = (r, k) => { const v = parseFloat(r && r[k]); return Number.isFinite(v) ? v : 0; };
  const pct = (v) => Math.round(v * 1000) / 10;
  const r4 = (v) => Math.round(v * 10000) / 10000;

  // character skill list: SkillGroup slots 1..10 + delayed skills + form-change skills
  function charSkills(pcKey, grade) {
    const ET = E();
    const pc = T('Table_PC', pcKey);
    const gk = str(pc, 'SkillGroupIndex');
    const g = T('Table_SkillGroup', gk);
    const maxGrade = num(pc, 'MaxGrade', 5);
    const out = [];
    if (!g) return { groupKey: gk, group: null, skills: out, maxGrade };
    for (let i = 1; i <= 10; i++) {
      const key = str(g, 'SkillIndex' + i);
      if (!key) continue;
      const at = num(g, 'SkillActiveType' + i), av = num(g, 'SkillActiveValue' + i);
      const cond = (gr) => at === ET.SKILL_ACTIVE_TYPE.NONE || (at === ET.SKILL_ACTIVE_TYPE.GRADE && gr >= av);
      out.push({ key, groupSlot: i, activeType: at, activeValue: av, reachable: cond(maxGrade), active: cond(grade), table: T('Table_Skill', key), kind: 'group' });
    }
    // related skills reached through the group skills (delayed second hit, transformation)
    const extra = [];
    for (const s of out) {
      if (!s.table) continue;
      const dk = str(s.table, 'DelaySkillKeyString');
      if (dk && !out.some((x) => x.key === dk) && !extra.some((x) => x.key === dk)) extra.push({ key: dk, parent: s.key, kind: 'delay', reachable: s.reachable, active: s.active, table: T('Table_Skill', dk) });
      const fk = str(s.table, 'Matching_Skill_FormChange');
      if (fk && !out.some((x) => x.key === fk) && !extra.some((x) => x.key === fk)) extra.push({ key: fk, parent: s.key, kind: 'form', reachable: s.reachable, active: s.active, table: T('Table_Skill', fk) });
    }
    return { groupKey: gk, group: g, skills: out.concat(extra), maxGrade };
  }
  A.charSkills = charSkills;

  function resolveGrade(pc, opts) {
    const sg = num(pc, 'StartGrade', 1), mg = num(pc, 'MaxGrade', 5);
    if (opts.grade === 'max' || opts.grade === undefined || opts.grade === null || opts.grade === '') return mg;
    if (opts.grade === 'start') return sg;
    return Math.max(sg, Math.min(mg, +opts.grade || mg));
  }

  // buff slot helpers
  const slotDefined = (r, i) => r && (r['BuffEffectType' + i] !== undefined || r['BuffEffectValue' + i] !== undefined || r['BuffEffectLevelValue' + i] !== undefined);
  const slotRate = (r, i) => fl(r, 'BuffEffectRate' + i);
  const slotType = (r, i) => num(r, 'BuffEffectType' + i);
  const slotVal = (r, i, lv) => r4(fl(r, 'BuffEffectValue' + i) + (lv - 1) * fl(r, 'BuffEffectLevelValue' + i));
  const typeStatus = (t) => (LOSim.buffs && LOSim.buffs.STATUS && LOSim.buffs.STATUS[ename('BUFFEFFECT_TYPE', t)]) || 'impl';
  const typeNote = (t) => (LOSim.buffs && LOSim.buffs.NOTES && LOSim.buffs.NOTES[ename('BUFFEFFECT_TYPE', t)]) || '';
  const INERT_BY_DESIGN = new Set(['UI_INFO_NEXTENEMY', 'STAGE_SUPPORT_ATTACK', 'STAGE_EXP_UP', 'STAGE_ANALYZE']);
  const COND_NONE = (c) => c === 77 || c === 63; // BUFFEFFECT_TRIGGER_APPLY_CONDITION __MAX__ / NONE
  const buffDescOf = (desc, key, i) => (desc && desc.buffs && desc.buffs[key] && desc.buffs[key].d && desc.buffs[key].d[i - 1]) || '';
  A.slotInfo = { slotDefined, slotRate, slotType, slotVal, typeStatus };

  // all buff keys a skill declares at any level (+ per level)
  function skillBuffKeys(sk) {
    const maxLv = Math.max(1, num(sk.table, 'MaxSkillLevel', 1));
    const byLv = {};
    const all = new Set();
    for (let lv = 1; lv <= maxLv; lv++) {
      const r = lvRow(sk.key, lv);
      const ks = r ? list(r, 'BuffEffectIndex') : [];
      byLv[lv] = ks;
      ks.forEach((k) => all.add(k));
    }
    return { maxLv, byLv, all: [...all] };
  }

  // ---------- display-only slots: where is the effect really applied? ----------
  // A rate-0 slot with a description is often a UI copy of an effect that another row (or another slot) applies.
  // Family groups put renewal AP effects next to the old speed stats, block/protect variants together, etc.
  const FAMILY_GROUPS = [
    ['STAT_SPEED_VALUE', 'STAT_SPEED_RATIO', 'STAGE_AP_VALUE', 'STAGE_AP_SHIFT', 'ADJUST_AP_ACTIVE_SKILL_1', 'ADJUST_AP_ACTIVE_SKILL_2'],
    ['STAGE_BLOCK_LINE', 'STAGE_BLOCK_GRID', 'STAGE_BLOCK_ROW', 'STAGE_BLOCK_CHARACTER'],
    ['STAGE_SUPPORT_ATTACK', 'STAGE_TOGETHER_ATTACK_ACTIVE_SKILL_1', 'STAGE_TOGETHER_ATTACK_ACTIVE_SKILL_2', 'CHAIN_ATTACK_SKILL_1', 'CHAIN_ATTACK_SKILL_2'],
    ['STAGE_SHIELD_VALUE', 'STAGE_SHIELD_VALUE_LIMITED', 'STAGE_SHIELD_RATIO', 'STAGE_SHIELD_RATIO_LIMITED', 'STAGE_IMMUNESHIELD_VALUE', 'STAGE_IMMUNESHIELD_TIME'],
  ];
  function familyOf(typeName) {
    if (!typeName) return '';
    const g = FAMILY_GROUPS.findIndex((x) => x.includes(typeName));
    if (g >= 0) return 'G' + g;
    // STAT_ATK_RATIO / STAT_ATK_VALUE -> STAT_ATK ; STAGE_X_RATIO_INS -> STAGE_X
    return typeName.replace(/_(RATIO|VALUE|RATE)(_INS|_LIMITED)?$/, '');
  }
  // description of a slot without numbers/placeholders/markup, split into "name : effect"
  function normDesc(d) {
    const t = String(d || '').replace(/<[^>]+>/g, '').replace(/\{\d+\}/g, '').replace(/[-+]?\d+(\.\d+)?%?/g, '').replace(/\s+/g, '');
    const i = t.indexOf(':');
    return { full: t, effect: i >= 0 ? t.slice(i + 1) : t };
  }
  // every Table_BuffEffect key mentioned anywhere in a row (trigger/condition values, buff-applying effect values, ...)
  function rowRefs(r) {
    const out = [];
    for (const [k, v] of Object.entries(r)) {
      if (k === 'Key') continue;
      for (const x of Array.isArray(v) ? v : [v]) if (typeof x === 'string' && /^Effect_/.test(x) && T('Table_BuffEffect', x)) out.push(x);
    }
    return out;
  }
  // search scopes, closest first: same row -> rows reached by references from the character's rows (and sibling
  // rows named <key><digits>) -> any row of the same character prefix or of its summons
  function displayScopes(pcKey, charKeys, cs) {
    const reach = new Set(charKeys);
    const queue = [...charKeys];
    while (queue.length && reach.size < 3000) {
      const k = queue.pop(), r = T('Table_BuffEffect', k);
      if (!r) continue;
      for (const x of rowRefs(r)) if (!reach.has(x)) { reach.add(x); queue.push(x); }
    }
    const all = T('Table_BuffEffect') || {};
    const siblingsOf = (k) => Object.keys(all).filter((x) => x !== k && x.startsWith(k) && /^\d+$/.test(x.slice(k.length)));
    const code = pcKey.replace(/^Char_/, '');
    const prefixes = ['Effect_' + code + '_'];
    // summons created by the character's skills
    for (const sk of cs.skills) {
      if (!sk.table) continue;
      const maxLv = Math.max(1, num(sk.table, 'MaxSkillLevel', 1));
      for (let lv = 1; lv <= maxLv; lv++) {
        const r = lvRow(sk.key, lv), sm = r && str(r, 'SummonKeyString');
        if (sm) prefixes.push('Effect_' + sm.replace(/^SUMMON_/, '') + '_');
      }
    }
    const wide = new Set(Object.keys(all).filter((x) => prefixes.some((p) => x.startsWith(p))));
    return { reach, siblingsOf, wide };
  }
  function findCarrier(k, i, scopes, desc) {
    const r = T('Table_BuffEffect', k);
    const tn = ename('BUFFEFFECT_TYPE', slotType(r, i)), fam = familyOf(tn), nd = normDesc(buffDescOf(desc, k, i));
    const match = (key, j) => {
      const rr = T('Table_BuffEffect', key);
      if (!rr || !(slotRate(rr, j) > 0)) return '';
      const t2 = ename('BUFFEFFECT_TYPE', slotType(rr, j));
      if (t2 === tn) return '같은 효과 종류';
      if (fam && familyOf(t2) === fam) return '같은 계열 효과(' + t2 + ')';
      const d2 = normDesc(buffDescOf(desc, key, j));
      if (nd.effect && d2.effect && nd.effect === d2.effect) return '같은 설명 문구';
      return '';
    };
    const scan = (keys, where) => {
      for (const key of keys) for (let j = 1; j <= 5; j++) {
        if (key === k && j === i) continue;
        const how = match(key, j);
        if (how) return { carrier: key + '#' + j, how, where };
      }
      return null;
    };
    return scan([k], '같은 행의 다른 슬롯')
      || scan(scopes.siblingsOf(k), '같은 버프의 하위 행')
      || scan([...scopes.reach].filter((x) => x !== k), '연결된 버프(트리거·조건·효과값 참조)')
      || scan([...scopes.wide].filter((x) => x !== k && !scopes.reach.has(x)), '같은 전투원(또는 소환물)의 다른 버프');
  }

  // ---------- promotion (grade) dependent effects ----------
  // Pattern (e.g. Aqua): skill A's rows carry "IF_NOT_BUFFED_KEY_ME* [K]" where K is applied by a skill B that unlocks at a
  // higher grade; B then re-applies A's effect through its own rows (USE_ACTIVE_SKILL_n / IF_BUFFED_KEY_ME [K]).
  // Below that grade A's own rows work; at or above it they are switched off on purpose.
  function promoReplacements(pcKey) {
    const pc = T('Table_PC', pcKey);
    const g = pc && T('Table_SkillGroup', str(pc, 'SkillGroupIndex'));
    if (!g) return { byKey: {}, pairs: [] };
    const ET = E();
    const start = num(pc, 'StartGrade', 1), max = num(pc, 'MaxGrade', 5);
    const keysOfSkill = (sk) => { const t = T('Table_Skill', sk); if (!t) return []; const out = new Set(); const mx = Math.max(1, num(t, 'MaxSkillLevel', 1)); for (let lv = 1; lv <= mx; lv++) for (const k of list(lvRow(sk, lv), 'BuffEffectIndex')) out.add(k); return [...out]; };
    const skills = [];
    for (let i = 1; i <= 10; i++) {
      const sk = str(g, 'SkillIndex' + i);
      if (!sk || !T('Table_Skill', sk)) continue;
      const at = num(g, 'SkillActiveType' + i), av = num(g, 'SkillActiveValue' + i);
      const unlock = at === ET.SKILL_ACTIVE_TYPE.GRADE ? av : 0;
      skills.push({ key: sk, slot: num(T('Table_Skill', sk), 'SkillSlotType', i), unlock, keys: keysOfSkill(sk) });
    }
    const ownerOf = {};
    for (const sk of skills) for (const k of sk.keys) (ownerOf[k] = ownerOf[k] || []).push(sk);
    let cand = null;
    const candidates = () => {
      if (cand) return cand;
      const seen = new Set(skills.flatMap((x) => x.keys)), q = [...seen];
      while (q.length && seen.size < 3000) {
        const r = T('Table_BuffEffect', q.pop());
        if (!r) continue;
        for (const v of Object.values(r)) for (const x of Array.isArray(v) ? v : [v]) if (typeof x === 'string' && /^Effect_/.test(x) && !seen.has(x) && T('Table_BuffEffect', x)) { seen.add(x); q.push(x); }
      }
      return (cand = [...seen]);
    };
    const byKey = {}, pairs = [];
    for (const a of skills) for (const k of a.keys) {
      const r = T('Table_BuffEffect', k);
      if (!r) continue;
      for (const n of ['', '2']) {
        const cn = ename('BUFFEFFECT_TRIGGER_APPLY_CONDITION', num(r, 'BuffEffectTriggerApplyCondition' + n));
        if (!/^IF_NOT_BUFFED_KEY_ME/.test(cn || '')) continue;
        for (const ref of list(r, 'BuffEffectTriggerApplyConditionValue' + n).map(String)) {
          const b = (ownerOf[ref] || []).find((x) => x !== a && x.unlock > start && x.unlock <= max);
          if (!b) continue;
          // rows that take over once K is present: any row of the character's skills (or reached from them by key
          // references) whose apply condition is IF_BUFFED_KEY_ME* [K]
          const take = candidates().filter((bk) => {
            const br = T('Table_BuffEffect', bk);
            return br && ['', '2'].some((m) => /^IF_BUFFED_KEY_ME/.test(ename('BUFFEFFECT_TRIGGER_APPLY_CONDITION', num(br, 'BuffEffectTriggerApplyCondition' + m)) || '') && list(br, 'BuffEffectTriggerApplyConditionValue' + m).map(String).includes(ref));
          });
          byKey[k] = { baseSkill: a.key, promoSkill: b.key, grade: b.unlock, flagKey: ref, replacedBy: take };
          pairs.push(byKey[k]);
        }
      }
    }
    return { byKey, pairs, start, max };
  }
  A.promoReplacements = promoReplacements;

  function mkFinding(base, o) { return Object.assign({ cat: 'static', conf: 'med', skill: '', skillName: '', effect: '', slot: 0, evidence: '', ref: '' }, base, o); }

  // ================================================================== A. static checks
  A.staticCheck = function (pcKey, opts, desc) {
    opts = Object.assign({}, A.DEFAULTS, opts || {});
    const ET = E();
    const pc = T('Table_PC', pcKey);
    const base = { char: pcKey, charName: LOSim.name(pc && pc.Name, pcKey) };
    const F = [];
    const add = (o) => F.push(mkFinding(base, o));
    if (!pc) { add({ sev: 'error', code: 'NO_PC', msg: 'Table_PC 행이 없음', conf: 'high' }); return { findings: F, skills: [] }; }
    const grade = resolveGrade(pc, opts);
    const cs = charSkills(pcKey, grade);
    if (!cs.group) { add({ sev: 'error', code: 'NO_SKILLGROUP', msg: 'SkillGroup 행이 없음: ' + cs.groupKey, conf: 'high', ref: 'Table_PC.SkillGroupIndex' }); return { findings: F, skills: [] }; }
    const skillsOut = [];
    // every buff key the character can apply (for "covered" / description lookups)
    const charKeys = new Set();
    const keyOwner = {};
    for (const s of cs.skills) if (s.table) for (const k of skillBuffKeys(s).all) { charKeys.add(k); (keyOwner[k] = keyOwner[k] || []).push(s.key); }
    const liveTypes = new Set(); // BUFFEFFECT_TYPEs with a rate>0 slot somewhere in the character's buffs
    const allLefts = new Set(), allRates = new Set(), allOverMax = new Set();
    for (const k of charKeys) {
      const r = T('Table_BuffEffect', k);
      if (!r) continue;
      for (let i = 1; i <= 5; i++) {
        if (slotRate(r, i) > 0) { liveTypes.add(slotType(r, i)); allRates.add(pct(slotRate(r, i))); }
        if (slotDefined(r, i)) allLefts.add(num(r, 'BuffEffectLeftCount' + i));
      }
      allOverMax.add(num(r, 'BuffEffectOverlapMax'));
      for (const w of list(r, 'BuffEffectTriggerValue_Sub')) { const v = parseFloat(w); if (Number.isFinite(v)) allRates.add(pct(v)); }
    }

    // ---- slot numbers
    const slotsSeen = {};
    for (const s of cs.skills) {
      const info = { key: s.key, name: skillName(s.key), kind: s.kind, parent: s.parent || '', groupSlot: s.groupSlot || 0, reachable: s.reachable, active: s.active,
        slot: s.table ? num(s.table, 'SkillSlotType') : 0, type: s.table ? num(s.table, 'SkillType') : 0, maxLv: s.table ? num(s.table, 'MaxSkillLevel') : 0, keys: [] };
      skillsOut.push(info);
      const sb = { skill: s.key, skillName: info.name };
      if (!s.table) { add(Object.assign({ sev: 'error', code: 'NO_SKILL', msg: 'Table_Skill 행이 없음' + (s.kind !== 'group' ? ' (' + (s.kind === 'delay' ? '지연 스킬' : '변신 스킬') + ', 원본 ' + s.parent + ')' : ''), conf: 'high', ref: s.kind === 'group' ? cs.groupKey + '.SkillIndex' + s.groupSlot : 'Table_Skill ' + s.parent }, sb)); continue; }
      if (s.kind === 'group') {
        if (s.activeType === ET.SKILL_ACTIVE_TYPE.GRADE && s.activeValue > cs.maxGrade) add(Object.assign({ sev: 'suspect', code: 'GRADE_UNREACHABLE', msg: `해금 등급(${s.activeValue})이 최대 등급(${cs.maxGrade})보다 높아 얻을 수 없는 스킬`, evidence: `SkillActiveValue${s.groupSlot}=${s.activeValue}, MaxGrade=${cs.maxGrade}`, conf: 'high', ref: cs.groupKey }, sb));
        if (s.reachable) { const k = info.slot; (slotsSeen[k] = slotsSeen[k] || []).push(s); }
      }
      const maxLv = num(s.table, 'MaxSkillLevel');
      if (maxLv <= 0) { add(Object.assign({ sev: 'error', code: 'MAXLV_ZERO', msg: 'MaxSkillLevel이 0', conf: 'high', ref: 'Table_Skill ' + s.key }, sb)); continue; }
      const kb = skillBuffKeys(s);
      info.keys = kb.all;
      const missingLv = [];
      let prevAtk = null, prevKeys = null;
      const keyDiffs = [], atkDrops = [];
      const useNone = [], rate0 = [];
      for (let lv = 1; lv <= maxLv; lv++) {
        const r = lvRow(s.key, lv);
        if (!r) { missingLv.push(lv); continue; }
        const gi = str(r, 'GridIndex');
        if (gi && !T('Table_Grid', gi)) add(Object.assign({ sev: 'error', code: 'NO_GRID', msg: `Lv${lv} GridIndex가 Table_Grid에 없음: ${gi}`, conf: 'high', ref: 'Table_SkillLevel ' + r.Key }, sb));
        for (const k of list(r, 'BuffEffectIndex')) if (!T('Table_BuffEffect', k)) add(Object.assign({ sev: 'error', code: 'NO_BUFF', msg: `Lv${lv} BuffEffectIndex 키가 Table_BuffEffect에 없음`, effect: k, conf: 'high', evidence: 'client: GetTableBuffEffect -> null', ref: 'Table_SkillLevel ' + r.Key }, sb));
        const atk = fl(r, 'SkillAttackRate');
        if (prevAtk !== null && atk + 1e-9 < prevAtk) atkDrops.push(`Lv${lv - 1} ${prevAtk} → Lv${lv} ${atk}`);
        prevAtk = atk;
        const ks = list(r, 'BuffEffectIndex').join(',');
        if (prevKeys !== null && ks !== prevKeys) keyDiffs.push(lv);
        prevKeys = ks;
        if (list(r, 'BuffEffectIndex').length && num(r, 'BuffEffectUseAvailable') !== 1) useNone.push(lv);
        if (list(r, 'BuffEffectIndex').length && num(r, 'BuffEffectUseAvailable') === 1 && !(fl(r, 'BuffEffectRate') > 0)) rate0.push(lv);
        const smk = str(r, 'SummonKeyString');
        if (num(r, 'IsSummonSkill') === 1 && (!smk || !T('Table_Summon', smk))) add(Object.assign({ sev: 'error', code: 'NO_SUMMON', msg: `Lv${lv} 소환 스킬인데 Table_Summon 행이 없음: ${smk || '(빈 값)'}`, conf: 'high', ref: 'Creature.cs:8771 SpawnSummonActor' }, sb));
      }
      if (rate0.length) add(Object.assign({ sev: 'suspect', code: 'SKILL_BUFFRATE0', msg: `스킬 레벨의 BuffEffectRate가 0이라 버프가 하나도 적용되지 않는 레벨: Lv${rate0.join(', Lv')}` + (rate0.length < maxLv ? ' (다른 레벨은 적용됨)' : ' (전 레벨)'), evidence: 'BuffEffectIndex: ' + kb.all.join(', '), conf: 'high', ref: 'Skill.cs:358 GetBuffEffectTableList (rate 검사)' }, sb));
      if (missingLv.length) add(Object.assign({ sev: 'error', code: 'NO_SKILLLEVEL', msg: `Table_SkillLevel 행 누락: Lv${missingLv.join(', Lv')} (MaxSkillLevel ${maxLv})`, conf: 'high', evidence: 'client: GetTableSkillLevel -> null', ref: 'DataManager.Table.cs:517' }, sb));
      if (atkDrops.length) add(Object.assign({ sev: 'suspect', code: 'ATKRATE_DROP', msg: '스킬 레벨이 올라가는데 SkillAttackRate가 감소', evidence: atkDrops.join('; '), conf: 'med', ref: 'Table_SkillLevel' }, sb));
      if (useNone.length) {
        const mixed = useNone.length < maxLv;
        add(Object.assign({ sev: mixed ? 'suspect' : 'info', code: 'USEAVAIL_NONE', msg: `BuffEffectUseAvailable이 USE가 아니라 버프가 적용되지 않는 레벨: Lv${useNone.join(', Lv')}` + (mixed ? ' (다른 레벨은 적용됨)' : ' (전 레벨)'),
          evidence: 'BuffEffectIndex: ' + kb.all.join(', '), conf: mixed ? 'high' : 'low', ref: 'buffs.js skillRows / Skill.cs GetBuffEffectTableList' }, sb));
      }
      if (keyDiffs.length) add(Object.assign({ sev: 'info', code: 'LV_KEYS_DIFF', msg: `레벨에 따라 BuffEffectIndex 목록이 바뀜 (Lv${keyDiffs.join(', Lv')}에서 변경)`, evidence: [1, ...keyDiffs].map((lv) => `Lv${lv}: ${kb.byLv[lv].join(', ') || '(없음)'}`).join(' / '), conf: 'low', ref: 'Table_SkillLevel' }, sb));
    }
    // two reachable group skills on the same slot
    for (const [slot, arr] of Object.entries(slotsSeen)) {
      if (+slot > 0 && arr.length > 1) add({ sev: 'suspect', code: 'SLOT_DUP', msg: `같은 스킬 슬롯(${slot})을 쓰는 스킬이 ${arr.length}개`, evidence: arr.map((s) => `${s.key}(그룹 ${s.groupSlot}, 해금 ${s.activeType ? '등급' + s.activeValue : '기본'})`).join(', '), conf: 'low', ref: cs.groupKey });
    }

    // ---- buff effect rows
    let displayOnly = 0;
    const displayVerified = [];
    let scopes = null;
    const rate0Groups = new Map();
    const delayTargets = new Set(cs.skills.filter((x) => x.table).map((x) => str(x.table, 'DelaySkillKeyString')).filter(Boolean));
    const groupKeys = new Set(cs.skills.filter((x) => x.kind === 'group' && !delayTargets.has(x.key)).map((x) => x.key)); // delayed hits run as their own skill
    for (const k of charKeys) {
      const r = T('Table_BuffEffect', k);
      if (!r) continue;
      const owners = keyOwner[k] || [];
      const sb = { skill: owners[0] || '', skillName: owners[0] ? skillName(owners[0]) : '', effect: k };
      const seen = {};
      for (let i = 1; i <= 5; i++) {
        if (!slotDefined(r, i)) continue;
        const t = slotType(r, i), tn = ename('BUFFEFFECT_TYPE', t), rate = slotRate(r, i), d = buffDescOf(desc, k, i);
        if (!(rate > 0)) {
          // display-only slot: the effect is applied by another slot/row (same type, same family or same description)
          if (!scopes) scopes = displayScopes(pcKey, charKeys, cs);
          let car = findCarrier(k, i, scopes, desc);
          // weakest evidence (another skill of the same character, matched only by effect family) is not enough to clear it
          let hint = '';
          if (car && car.where.startsWith('같은 전투원') && car.how.startsWith('같은 계열')) { hint = ` · 다른 스킬의 비슷한 효과 후보: ${car.carrier} (${car.how})`; car = null; }
          if (car) {
            displayOnly++;
            if (d) displayVerified.push({ skill: sb.skill, skillName: sb.skillName, effect: k, slot: i, type: tn, desc: d, carrier: car.carrier, how: car.how, where: car.where });
            continue;
          }
          const gk = tn + '|' + d;
          if (rate0Groups.has(gk)) { rate0Groups.get(gk).more.push(k + '#' + i); continue; } // same effect in sibling rows: one finding
          const f0 = mkFinding(base, Object.assign({ sev: d ? 'suspect' : 'info', code: 'RATE0_SLOT', slot: i,
            msg: d ? `효과 설명은 표시되지만 적용 확률(BuffEffectRate${i})이 0이라 클라이언트가 적용하지 않음 (같은 종류의 효과를 적용하는 다른 슬롯도 없음)` : `효과 슬롯 ${i}이(가) 정의돼 있지만 적용 확률 0 (설명 없음 — 비활성 의도일 수 있음)`,
            evidence: `${tn} 값 ${fl(r, 'BuffEffectValue' + i)}${d ? ' · 설명 "' + d + '"' : ''}${hint}`, conf: d ? (hint ? 'low' : 'med') : 'low', ref: 'Creature.cs:3657 ApplyBuff (0 < BuffEffectRate 검사)' }, sb));
          f0.more = []; rate0Groups.set(gk, f0); F.push(f0);
          continue;
        }
        const st = typeStatus(t);
        if (st === 'todo') add(Object.assign({ sev: 'simlimit', code: 'SIM_TODO', slot: i, msg: `시뮬레이터 미지원 효과 ${tn}`, evidence: typeNote(t), conf: 'high', ref: 'engine/buffs.js coverage' }, sb));
        else if (st === 'noop' && !INERT_BY_DESIGN.has(tn)) add(Object.assign({ sev: 'info', code: 'CLIENT_NOOP', slot: i, msg: `클라이언트 전투 코드에 처리가 없는 효과 ${tn} — 전투에서 아무 일도 일어나지 않음`, evidence: (typeNote(t) || 'no battle handler') + (d ? ' · 설명 "' + d + '"' : ''), conf: 'low', ref: 'engine/buffs.js coverage (noop)' }, sb));
        const sig = t + '|' + String(r['BuffEffectValue' + i] || '') + '|' + String(r['BuffEffectLevelValue' + i] || '') + '|' + num(r, 'BuffEffectLeftCount' + i) + '|' + num(r, 'BuffEffectOverlapType' + i);
        if (seen[sig]) add(Object.assign({ sev: 'suspect', code: 'DUP_SLOT', slot: i, msg: `슬롯 ${seen[sig]}과(와) 완전히 같은 효과가 슬롯 ${i}에 중복 정의됨`, evidence: `${tn} 값 ${r['BuffEffectValue' + i] || 0} 레벨당 ${r['BuffEffectLevelValue' + i] || 0} 지속 ${num(r, 'BuffEffectLeftCount' + i)}`, conf: 'low', ref: 'Table_BuffEffect ' + k }, sb));
        else seen[sig] = i;
      }
      // passive skill row on a trigger that the client only evaluates for the skill being used
      const trig = num(r, 'BuffEffectTriggerType'), trn = ename('BUFFEFFECT_TRIGGER_TYPE', trig);
      const ownerSkills = owners.filter((x) => groupKeys.has(x)).map((x) => T('Table_Skill', x)).filter(Boolean); // delayed/form skills excluded
      if (ACTIVE_ONLY_TRIGGERS.has(trn) && ownerSkills.length && ownerSkills.every((t) => num(t, 'SkillType') === 1) && [1, 2, 3, 4, 5].some((i) => slotRate(r, i) > 0))
        add(Object.assign({ sev: 'suspect', code: 'PASSIVE_ACTIVE_TRIGGER', msg: `패시브 스킬의 효과인데 사용 중인 스킬에만 걸리는 트리거(${trn})라 클라이언트에서 발동하지 않음` + (ACTIVE_ONLY_TRIGGERS.get(trn) ? ` (패시브용은 ${ACTIVE_ONLY_TRIGGERS.get(trn)})` : ''),
          evidence: `소속 ${owners.join(', ')} (SkillType PASSIVE) · 트리거 ${trn}`, conf: 'high', ref: 'CreatureSkill.cs:90 GetBuffEffectTableList (skill != null이면 그 스킬의 버프만 조회)' }, sb));
      for (const d of danglingRefs(r)) add(Object.assign({ sev: 'suspect', code: 'DANGLING_REF', msg: `${d.field}가 존재하지 않는 ${d.kind}를 가리킴: ${d.value}`, evidence: d.ctx, conf: 'high', ref: 'Table_BuffEffect ' + k }, sb));
    }

    // ---- promotion-dependent effects (info)
    const promo = promoReplacements(pcKey);
    const seenPromo = new Set();
    for (const pr of promo.pairs) {
      const id = pr.baseSkill + '|' + pr.promoSkill;
      if (seenPromo.has(id)) continue;
      seenPromo.add(id);
      const baseKeys = Object.entries(promo.byKey).filter(([, v]) => v.baseSkill === pr.baseSkill && v.promoSkill === pr.promoSkill).map(([k]) => k);
      add({ sev: 'info', code: 'PROMO_REPLACE', skill: pr.baseSkill, skillName: skillName(pr.baseSkill),
        msg: `${pr.grade}성 승급으로 ${skillName(pr.promoSkill)}이(가) 열리면 이 스킬의 기본 효과가 꺼지고 승급 스킬의 효과로 대체됨` + (pr.replacedBy.length ? '' : ' (대체 효과 행은 데이터에서 특정하지 못함 — 실행 점검의 다른 스킬 효과 적용 기록 참고)'),
        evidence: `기본 효과 ${baseKeys.join(', ')} (조건: ${pr.flagKey} 없을 때) → 대체 ${pr.replacedBy.join(', ') || '없음'} (조건: ${pr.flagKey} 있을 때)`, conf: pr.replacedBy.length ? 'high' : 'med', ref: 'Table_BuffEffect TriggerApplyCondition IF_NOT_BUFFED_KEY_ME / IF_BUFFED_KEY_ME' });
    }

    // ---- description vs data
    if (desc && desc.skills) {
      for (const s of cs.skills) {
        if (!s.table || s.kind === 'form') continue;
        const dd = desc.skills[s.key];
        if (!dd || !dd.d) continue;
        descChecks(s, dd.d, { add, allLefts, allRates, allOverMax, charKeys });
      }
    }
    for (const f of rate0Groups.values()) { if (f.more.length) f.evidence += ` · 같은 효과가 확률 0인 다른 행 ${f.more.length}개: ${f.more.slice(0, 8).join(', ')}${f.more.length > 8 ? ' …' : ''}`; delete f.more; }
    return { findings: F, skills: skillsOut, grade, displayOnly, displayVerified };
  };

  // triggers fired with the skill in use (CreatureSkill.GetBuffEffectTableList looks only at that skill's rows)
  const ACTIVE_ONLY_TRIGGERS = new Map([['ATTACK_SUCCESS', 'ATTACK_SUCCESS_PASSIVE'], ['ATTACK_SUCCESS_AND_IF_BUFFED', ''], ['ATTACK_FAIL', 'ATTACK_FAIL_PASSIVE'], ['ON_CRITICAL_HIT', ''], ['IF_ENEMYKILL', 'IF_ENEMYKILL_PASSIVE'], ['ATTACK_SUCCESS_ACTIVESKILL', '']]);
  // keys referenced by a buff row that must exist in some table
  function danglingRefs(r) {
    const out = [];
    const trn = ename('BUFFEFFECT_TRIGGER_TYPE', num(r, 'BuffEffectTriggerType'));
    const tv = str(r, 'BuffEffectTriggerValue');
    const isBuff = (k) => !!T('Table_BuffEffect', k);
    const isUnit = (k) => !!(T('Table_PC', k) || T('Table_Monster', k) || T('Table_Summon', k) || T('Table_MonsterIW', k));
    const isSkill = (k) => !!T('Table_Skill', k);
    if (tv) {
      if ((trn === 'FRIENDLY' || trn === 'ENEMY') && !isUnit(tv)) out.push({ field: 'BuffEffectTriggerValue', kind: '전투원/몬스터 키', value: tv, ctx: '트리거 ' + trn });
      if (['IF_BUFFED', 'BUFFED_TARGET', 'ATTACK_SUCCESS_AND_IF_BUFFED'].includes(trn) && !isBuff(tv)) out.push({ field: 'BuffEffectTriggerValue', kind: '버프 키', value: tv, ctx: '트리거 ' + trn });
      if (['USE_SKILL_SPEC', 'BEATEN_ACTIVE_SKILL_KEY'].includes(trn) && !isSkill(tv)) out.push({ field: 'BuffEffectTriggerValue', kind: '스킬 키', value: tv, ctx: '트리거 ' + trn });
    }
    for (const n of ['', '2']) {
      const c = num(r, 'BuffEffectTriggerApplyCondition' + n);
      if (COND_NONE(c)) continue;
      const cn = ename('BUFFEFFECT_TRIGGER_APPLY_CONDITION', c);
      const vals = list(r, 'BuffEffectTriggerApplyConditionValue' + n).map(String);
      if (/_KEY_/.test(cn) && !/TROOPCATEGORY/.test(cn)) for (const v of vals) if (/^[A-Za-z]/.test(v) && !isBuff(v)) out.push({ field: 'BuffEffectTriggerApplyConditionValue' + n, kind: '버프 키', value: v, ctx: '조건 ' + cn });
      if (/^SPC_CHAR/.test(cn)) for (const v of vals) if (/^[A-Za-z]/.test(v) && !isUnit(v)) out.push({ field: 'BuffEffectTriggerApplyConditionValue' + n, kind: '전투원 키', value: v, ctx: '조건 ' + cn });
    }
    return out;
  }

  function descChecks(s, text, ctx) {
    const sb = { skill: s.key, skillName: skillName(s.key), cat: 'desc' };
    const add = (o) => ctx.add(Object.assign({}, sb, o));
    const maxLv = Math.max(1, num(s.table, 'MaxSkillLevel', 1));
    const rows = [];
    for (let lv = 1; lv <= maxLv; lv++) rows[lv] = lvRow(s.key, lv);
    const own = skillBuffKeys(s);
    const ownLefts = new Set();
    for (const k of own.all) { const r = T('Table_BuffEffect', k); if (r) for (let i = 1; i <= 5; i++) if (slotDefined(r, i)) ownLefts.add(num(r, 'BuffEffectLeftCount' + i)); }
    const clean = String(text).replace(/<color[^>]*>|<\/color>/g, '');
    const sentences = clean.split(/(?<=[.。])\s+|\n/).map((x) => x.trim()).filter(Boolean);
    const noLv = sentences.filter((x) => !/스킬\s*레벨/.test(x));
    const quote = (x) => '"' + (x.length > 90 ? x.slice(0, 88) + '…' : x) + '"';

    // (0) summon / installation text vs summon data
    // flavour text ("...을 소환하여 피해") is common, so only sentences describing a unit that stays on the field count
    const summonLv = rows.slice(1).some((r) => r && num(r, 'IsSummonSkill') === 1);
    const sumSen = /(유지되|파괴되|최대\s*\d+\s*개|개만|개까지|설치할 수|소환물|설치물)/.test(clean) ? noLv.find((x) => /(소환|설치)/.test(x)) : null;
    if (sumSen && !summonLv && num(s.table, 'SkillType') === 0)
      add({ sev: 'suspect', code: 'DESC_SUMMON', msg: '설명은 소환/설치를 말하지만 이 스킬의 어떤 레벨도 소환 스킬(IsSummonSkill=1, SummonKeyString)이 아님', evidence: `설명 ${quote(sumSen)}`, conf: 'med', ref: 'Table_SkillLevel IsSummonSkill / SummonKeyString' });
    // (1) "N라운드 동안" vs LeftCount
    for (const sen of noLv) {
      if (/소환|설치/.test(sen)) continue;
      for (const m of sen.matchAll(/(\d+)\s*라운드(?!\s*(?:개시|후|이후|째|마다|이상|이하|간격|차|에\s*한))/g)) {
        const n = +m[1];
        if (ctx.allLefts.has(n)) continue;
        if (/점차|최대|최소|매/.test(sen.slice(Math.max(0, m.index - 6), m.index + 12))) continue;
        add({ sev: 'suspect', code: 'DESC_ROUND', msg: `설명의 지속 라운드(${n}라운드)와 일치하는 효과 지속(LeftCount)이 이 전투원의 버프에 없음`,
          evidence: `설명 ${quote(sen)} · 이 스킬 버프의 LeftCount: ${[...ownLefts].sort((a, b) => a - b).join('/') || '없음'}`, conf: ownLefts.size ? 'med' : 'low', ref: 'Table_BuffEffect BuffEffectLeftCountN' });
      }
    }
    // (2) "N% 확률" vs slot / skill rates
    const rates = new Set(ctx.allRates);
    for (let lv = 1; lv <= maxLv; lv++) if (rows[lv]) rates.add(pct(fl(rows[lv], 'BuffEffectRate')));
    for (const sen of noLv) {
      for (const m of sen.matchAll(/(\d+(?:\.\d+)?)\s*%\s*(?:의\s*)?확률/g)) {
        const n = +m[1];
        if (rates.has(n)) continue;
        add({ sev: 'suspect', code: 'DESC_PROB', msg: `설명의 확률(${n}%)과 일치하는 적용 확률이 데이터에 없음`, evidence: `설명 ${quote(sen)} · 데이터 확률: ${[...rates].filter((x) => x > 0 && x < 100).sort((a, b) => a - b).map((x) => x + '%').join(', ') || '100%만 있음'}`, conf: 'med', ref: 'BuffEffectRateN / SkillLevel.BuffEffectRate' });
      }
    }
    // (3) "N% 감소한 피해" vs Table_Grid splash rates
    const gridVals = new Set();
    for (let lv = 1; lv <= maxLv; lv++) { const g = rows[lv] && T('Table_Grid', str(rows[lv], 'GridIndex')); if (g) for (let i = 0; i <= 8; i++) if (g['Pos' + i] !== undefined) gridVals.add(Math.round((1 - fl(g, 'Pos' + i)) * 100)); }
    if (gridVals.size) for (const sen of noLv) {
      for (const m of sen.matchAll(/(\d+)\s*%\s*(?:감소한|감소된)\s*피해|피해(?:가|를)?\s*(\d+)\s*%\s*감소/g)) {
        const n = +(m[1] || m[2]);
        if (gridVals.has(n) || /최대/.test(sen)) continue;
        add({ sev: 'suspect', code: 'DESC_SPLASH', msg: `설명의 주변 피해 감소율(${n}%)이 스킬 범위(Table_Grid) 배율과 다름`, evidence: `설명 ${quote(sen)} · Grid 감소율: ${[...gridVals].filter((x) => x > 0).sort((a, b) => a - b).join('/')}%`, conf: 'med', ref: 'Table_Grid PosN' });
      }
    }
    // (4) "최대 N중첩" vs OverlapMax
    for (const sen of noLv) {
      for (const m of sen.matchAll(/최대\s*(\d+)\s*중첩/g)) {
        const n = +m[1];
        if (ctx.allOverMax.has(n)) continue;
        add({ sev: 'suspect', code: 'DESC_STACK', msg: `설명의 최대 중첩(${n})과 일치하는 BuffEffectOverlapMax가 없음`, evidence: `설명 ${quote(sen)} · OverlapMax: ${[...ctx.allOverMax].filter((x) => x > 0).sort((a, b) => a - b).join('/') || '없음'}`, conf: 'low', ref: 'Table_BuffEffect BuffEffectOverlapMax' });
      }
    }
    // (5) skill-level sentences
    for (const sen of sentences.filter((x) => /스킬\s*레벨/.test(x))) {
      // "스킬 레벨 N(, M / K)에서|부터 (효과 )범위가 증가"
      let m = sen.match(/스킬\s*레벨\s*([\d\s,/]+?)\s*(?:에서|부터)[^.]*?범위가[^.]*?증가/);
      if (m) {
        const lvs = m[1].split(/[\s,/]+/).map(Number).filter((x) => x > 1);
        for (const n of lvs) {
          const a = rows[n - 1], b = rows[n];
          if (!a || !b) continue;
          if (str(a, 'GridIndex') !== str(b, 'GridIndex')) continue;
          add({ sev: 'suspect', code: 'DESC_GRID_LV', msg: `설명은 스킬 레벨 ${n}에서 범위가 증가한다고 하지만 Lv${n - 1}과 Lv${n}의 GridIndex가 같음`, evidence: `설명 ${quote(sen)} · Lv${n - 1}=${str(a, 'GridIndex')}, Lv${n}=${str(b, 'GridIndex')} · 범위가 바뀌는 레벨: ${gridChanges(rows, maxLv) || '없음'}`, conf: 'high', ref: 'Table_SkillLevel GridIndex' });
        }
      }
      m = sen.match(/스킬\s*레벨\s*(\d+)\s*(?:에서|부터)[^.]*?사거리가[^.]*?증가/);
      if (m) {
        const n = +m[1], a = rows[n - 1], b = rows[n];
        if (a && b && !(num(b, 'Distance') > num(a, 'Distance')) && list(a, 'BuffEffectIndex').join() === list(b, 'BuffEffectIndex').join())
          add({ sev: 'suspect', code: 'DESC_RANGE_LV', msg: `설명은 스킬 레벨 ${n}에서 사거리가 증가한다고 하지만 Distance·버프 목록이 그대로임`, evidence: `설명 ${quote(sen)} · Distance Lv${n - 1}=${num(a, 'Distance')}, Lv${n}=${num(b, 'Distance')}`, conf: 'high', ref: 'Table_SkillLevel Distance' });
      }
      m = sen.match(/스킬\s*레벨\s*당\s*\+?\s*(\d+(?:\.\d+)?)\s*%\s*의?\s*적중\s*보정/);
      if (m) {
        const per = +m[1] / 100;
        const bad = [];
        for (let lv = 1; lv <= maxLv; lv++) if (rows[lv] && Math.abs(fl(rows[lv], 'Accuracy') - per * lv) > 0.0051) bad.push(`Lv${lv}=${fl(rows[lv], 'Accuracy')}`);
        const accAll0 = rows.slice(1).every((r) => !r || !fl(r, 'Accuracy'));
        if (bad.length && !(accAll0 && /자신은/.test(sen)))
          add({ sev: 'suspect', code: 'DESC_ACC', msg: `설명은 스킬 레벨 당 적중 보정 ${m[1]}%인데 Accuracy 값이 다름`, evidence: `설명 ${quote(sen)} · 기대 Lv1=${r4(per)}, Lv${maxLv}=${r4(per * maxLv)} · 실제 ${bad.slice(0, 4).join(', ')}${bad.length > 4 ? ' …' : ''}`, conf: 'med', ref: 'Table_SkillLevel Accuracy' });
      }
    }
    for (const sen of noLv) {
      const m = sen.match(/([-+]?\d+(?:\.\d+)?)\s*%\s*의\s*적중\s*보정/);
      if (!m || /레벨\s*당/.test(sen)) continue;
      const v = +m[1] / 100;
      let ok = false;
      for (let lv = 1; lv <= maxLv; lv++) if (rows[lv] && Math.abs(fl(rows[lv], 'Accuracy') - v) < 0.0051) ok = true;
      if (!ok) add({ sev: 'suspect', code: 'DESC_ACC', msg: `설명의 적중 보정(${m[1]}%)과 같은 Accuracy 값이 없음`, evidence: `설명 ${quote(sen)} · Accuracy: ${[...new Set(rows.slice(1).filter(Boolean).map((r) => fl(r, 'Accuracy')))].join('/')}`, conf: 'med', ref: 'Table_SkillLevel Accuracy' });
    }
  }
  function gridChanges(rows, maxLv) {
    const out = [];
    for (let lv = 2; lv <= maxLv; lv++) if (rows[lv] && rows[lv - 1] && str(rows[lv], 'GridIndex') !== str(rows[lv - 1], 'GridIndex')) out.push('Lv' + lv);
    return out.join(', ');
  }

  // ================================================================== B. runtime checks
  const AUDIT_STAGE = '__AUDIT_STAGE__', AUDIT_MG = '__AUDIT_MG__';
  // enemy template: [cloned monster key, enemy gridPos]. Monster cell = gridPos % 3 (0 front, 1 mid, 2 back).
  A.ENEMIES = [
    ['MOB_MP_NightChickS_TU2', 0], // front, trooper tanker
    ['MOB_MP_NightChickC_TU3', 3], // front center, armored
    ['MOB_MP_Scout_N', 4],         // mid, mobility
    ['MOB_MP_Legion_N', 7],        // mid, trooper supporter
    ['MOB_MP_NightChick_TU', 5],   // back, trooper
  ];
  const FILLER_PREF = ['Char_3P_Ajax_N', 'Char_BR_Brownie_N', 'Char_AGS_Aeda_N', 'Char_BR_Amy_N', 'Char_PECS_Fortune_N', 'Char_BR_Nereid_N', 'Char_3P_ConstantiaS2_N', 'Char_PECS_Drone_N', 'Char_BR_Leprechaun_N', 'Char_DS_Johanna_N'];

  function setupAuditData(subj) {
    const D = LOSim.data;
    const mons = D.units.Table_Monster, abs = D.units.Table_MonsterAbility;
    const mg = { Key: AUDIT_MG };
    A.ENEMIES.forEach(([src, pos], i) => {
      const key = '__AUDIT_MOB_' + i;
      const m = mons[src], ab = abs[src];
      if (!m || !ab) throw new Error('audit enemy template missing: ' + src);
      mons[key] = Object.assign({}, m, { Key: key });
      // durable but killable (~6 hits of the subject's strongest skill), DEF 0 so damage checks are not masked,
      // ATK sized to ~5% of the subject's max HP per hit so passive "when hit" effects fire without killing it.
      abs[key] = Object.assign({}, ab, {
        Key: key, DefaultHP: subj.hp, DefaultHPByLevel: 0, AttackDmg: subj.atk, AddAttackDmgByLevel: 0,
        DefenseDmg: 0, AddDefenseDmgByLevel: 0, EvadeRate: '0.050000', FireResist: 0, IceResist: 0, EletronicResist: 0,
      });
      mg['mobIndexString' + (pos + 1)] = key;
      mg['mobLevel' + (pos + 1)] = 1;
    });
    D.stages.Table_MobGroup[AUDIT_MG] = mg;
    const st = { Key: AUDIT_STAGE };
    for (let i = 1; i <= 9; i++) st['WaveMobGroup' + i] = [AUDIT_MG];
    st.BossMobGroup = [AUDIT_MG];
    D.stages.Table_MapStage[AUDIT_STAGE] = st;
  }

  function pickFillers(pcKey, declaredKeys) {
    const pcs = A.listPCs();
    const byKey = Object.fromEntries(pcs.map((p) => [p.key, p]));
    const keysOf = (k) => { const out = new Set(); try { for (const s of charSkills(k, 99).skills) if (s.table) for (const x of skillBuffKeys(s).all) out.add(x); } catch (e) { /* ignore */ } return out; };
    const ok = (k) => k !== pcKey && byKey[k] && ![...keysOf(k)].some((x) => declaredKeys.has(x));
    const out = [];
    const want = [[1, 0], [0, 1], [2, 1], [-1, 2]]; // [class, role]: armored tanker, trooper nuker, mobility nuker, any supporter
    for (const [cls, role] of want) {
      const cand = FILLER_PREF.filter((k) => byKey[k] && (cls < 0 || byKey[k].cls === cls) && byKey[k].role === role).concat(pcs.filter((p) => (cls < 0 || p.cls === cls) && p.role === role).map((p) => p.key));
      const k = cand.find((x) => ok(x) && !out.includes(x));
      if (k) out.push(k);
    }
    for (const p of pcs) { if (out.length >= 4) break; if (ok(p.key) && !out.includes(p.key)) out.push(p.key); }
    return out.slice(0, 4);
  }

  const TR = () => E().BUFFEFFECT_TRIGGER_TYPE;
  // trigger classes used to explain "never applied" effects
  function triggerClass(t) {
    const R = TR();
    const n = ename('BUFFEFFECT_TRIGGER_TYPE', t);
    const set = (names) => names.includes(n);
    if (set(['ALWAYS', 'COMBAT_START', 'ROUND_START', 'FRIENDLY', 'ENEMY', 'TURN_START_SELF', 'TURN_END_SELF', 'TURN_START_ALL', 'TURN_END_ALL', 'TURN_START_ALLY', 'TURN_END_ALLY', 'TURN_START_ENEMY', 'TURN_END_ENEMY', 'AT_FRONT_ROW', 'AT_MID_ROW', 'AT_BACK_ROW', 'HAVE_LESS_HP', 'HAVE_MORE_HP'])) return { cls: 'common', need: null };
    if (set(['USE_SKILL', 'ON_ATTACK', 'ATTACK_SUCCESS', 'ATTACK_SUCCESS_PASSIVE', 'ATTACK_SUCCESS_ACTIVESKILL', 'USE_ACTIVE_SKILL_1', 'USE_ACTIVE_SKILL_2'])) return { cls: 'action', need: 'subjectHits' };
    if (set(['ON_CRITICAL_HIT'])) return { cls: 'action', need: 'crits' };
    if (set(['IF_ENEMYKILL', 'IF_ENEMYKILL_PASSIVE'])) return { cls: 'action', need: 'kills' };
    if (set(['BEATEN', 'BEATEN_PHY', 'ATTACKED', 'ATTACKED_ACTIVESKILL', 'BEATEN_ACTIVESKILL', 'AFTER_ATTACKED', 'USE_SKILL_ENEMY'])) return { cls: 'beaten', need: 'hitsTaken' };
    if (set(['ON_EVADE', 'ON_EVADE_ACTIVESKILL'])) return { cls: 'beaten', need: 'evades' };
    if (set(['ATTACK_FAIL', 'ATTACK_FAIL_PASSIVE'])) return { cls: 'action', need: 'misses' };
    if (set(['ENEMY_DEATH'])) return { cls: 'common', need: 'enemyDeaths' };
    if (set(['AFTER_WAVE'])) return { cls: 'common', need: 'wavesCleared' };
    if (set(['HP_DOWN', 'HP_UP'])) return { cls: 'situational', need: null, why: 'HP 조건' };
    if (set(['BEATEN_ALLY', 'BEATEN_PHY_ALLY', 'BEATEN_ACTIVESKILL_ALLY'])) return { cls: 'ally', need: 'allyHitsTaken' };
    if (set(['ATTACK_SUCCESS_SKILL_ALLY', 'USE_SKILL_ALLY'])) return { cls: 'ally', need: 'allyActions' };
    if (set(['FRIENDLY_DEATH'])) return { cls: 'ally', need: 'allyDeaths' };
    if (set(['AFTER_COUNTER'])) return { cls: 'situational', need: 'counters', why: '반격 발생 필요' };
    if (set(['SUMMON_CREATE'])) return { cls: 'situational', need: 'summons', why: '소환 필요' };
    if (set(['WAIT'])) return { cls: 'situational', need: 'waits', why: '대기 행동 필요 (자동 전투는 대기를 거의 고르지 않음)' };
    if (set(['MOVE'])) return { cls: 'situational', need: 'moves', why: '이동 행동 필요 (자동 전투는 이동하지 않음)' };
    const why = {
      DEATH: '자신 사망 필요 (점검에서는 사망을 막음)', IF_RESURRECT: '부활 필요', GRID_NO: '특정 위치 배치 필요', IF_CHAR_INGRID: '특정 전투원 배치 필요',
      BUFFED_TARGET: '대상에게 특정 버프 필요', IF_BUFFED: '자신에게 특정 버프 필요', IF_ME_BUFFED: '자신 강화 효과 필요', IF_ME_DEBUFFED: '자신 해로운 효과 필요',
      USE_SKILL_SPEC: '특정 스킬 사용 필요', BEATEN_ACTIVE_SKILL_KEY: '특정 적 스킬 피격 필요', BEATEN_FIRE: '화염 피격 필요', BEATEN_ICE: '냉기 피격 필요', BEATEN_LIGHTNING: '전기 피격 필요',
      BEATEN_FIRE_ALLY: '아군 화염 피격 필요', BEATEN_ICE_ALLY: '아군 냉기 피격 필요', BEATEN_LIGHTNING_ALLY: '아군 전기 피격 필요', ATTACK_SUCCESS_AND_IF_BUFFED: '공격 + 특정 버프 필요',
      AFTER_SUPPORT_ATTACK_PASSIVE: '지원 공격 필요', AFTER_TOGETHER_ATTACK_PASSIVE: '협동 공격 필요', IF_ENEMYKILL_AND_IF_COUNTERKILL: '반격으로 처치 필요',
      AFTER_CHAIN_ATTACK_SKILL_1_GIVER: '공격 지원(체인) 필요', AFTER_CHAIN_ATTACK_SKILL_2_GIVER: '공격 지원(체인) 필요', AFTER_CHAIN_ATTACK_SKILL_ALL_GIVER: '공격 지원(체인) 필요',
      AFTER_CHAIN_ATTACK_SKILL_1_RECEIVER: '공격 지원(체인) 필요', AFTER_CHAIN_ATTACK_SKILL_2_RECEIVER: '공격 지원(체인) 필요', AFTER_CHAIN_ATTACK_SKILL_ALL_RECEIVER: '공격 지원(체인) 필요',
    }[n];
    return { cls: 'situational', need: null, why: why || '상황 의존 트리거' };
  }
  A.triggerClass = triggerClass;

  function condText(r) {
    // compacted tables drop 0, so a missing column is IF_BUFFED_ENUM_ME (0), not "no condition"
    const c1 = num(r, 'BuffEffectTriggerApplyCondition'), c2 = num(r, 'BuffEffectTriggerApplyCondition2');
    const parts = [];
    if (!COND_NONE(c1)) parts.push(ename('BUFFEFFECT_TRIGGER_APPLY_CONDITION', c1) + (list(r, 'BuffEffectTriggerApplyConditionValue').length ? '(' + list(r, 'BuffEffectTriggerApplyConditionValue').slice(0, 3).join(',') + ')' : ''));
    if (!COND_NONE(c2)) parts.push(ename('BUFFEFFECT_TRIGGER_APPLY_CONDITION', c2) + (list(r, 'BuffEffectTriggerApplyConditionValue2').length ? '(' + list(r, 'BuffEffectTriggerApplyConditionValue2').slice(0, 3).join(',') + ')' : ''));
    return parts.join(' + ');
  }

  // build the subject PC spec
  function subjectSpec(pcKey, opts, gridPos) {
    const pc = T('Table_PC', pcKey);
    const grade = resolveGrade(pc, opts);
    return { key: pcKey, grade, level: Math.max(1, Math.min(120, +opts.level || 90)), gridPos, skillLevels: new Array(10).fill(Math.max(1, +opts.skillLevel || 10)), equips: [] };
  }

  A.runtimeCheck = function (pcKey, opts) {
    opts = Object.assign({}, A.DEFAULTS, opts || {});
    const pc = T('Table_PC', pcKey);
    const base = { char: pcKey, charName: LOSim.name(pc && pc.Name, pcKey), cat: 'runtime' };
    const F = [];
    const add = (o) => F.push(mkFinding(base, o));
    const t0 = Date.now();
    // probe build (stats for enemy tuning, declared keys)
    let probe;
    try { probe = LOSim.stats.buildPC(subjectSpec(pcKey, opts, 4)); }
    catch (e) { add({ sev: 'error', code: 'BUILD_FAIL', msg: '전투원 생성 실패 (stats.buildPC 예외)', evidence: String(e && e.message), conf: 'high' }); return { findings: F, stats: null }; }
    const declared = {}; // key -> {skills:[skillKey], row}
    for (const s of probe.skills) for (const k of list(s.levelTable, 'BuffEffectIndex')) { const r = T('Table_BuffEffect', k); if (!r) continue; (declared[k] = declared[k] || { skills: [], row: r }).skills.push(s.key); }
    const declaredSet = new Set(Object.keys(declared));
    const maxRate = Math.max(1, ...probe.skills.map((s) => fl(s.levelTable, 'SkillAttackRate')));
    const atk = Math.max(1, LOSim.stats.getAtk(probe));
    const def = Math.max(0, (probe.attr && probe.attr[E().VALUE_TYPE.ABS][E().ACTOR_ATTR_TYPE.DEF]) || 0);
    const tune = { hp: Math.max(200, Math.round(atk * maxRate * 6)), atk: Math.max(10, Math.round(def + probe.maxHp * 0.05)) };
    setupAuditData(tune);
    const fillers = opts.squad === false ? [] : pickFillers(pcKey, declaredSet);
    const staticExplained = opts._staticExplained || null;

    const S = {
      grade: probe.grade, level: probe.level, enemyHp: tune.hp, enemyAtk: tune.atk, fillers, battles: [], scenarios: [],
      subjActions: 0, stalls: 0, liveUses: {}, delayOf: {}, waits: 0, waitReasons: {}, moves: 0, hitsTaken: 0, evades: 0, kills: 0, crits: 0, subjectHits: 0, misses: 0,
      enemyDeaths: 0, wavesCleared: 0, allyHitsTaken: 0, allyActions: 0, allyDeaths: 0, counters: 0, summons: 0, subjectDeaths: 0, auditHeals: 0,
      healToAllies: 0, skills: {}, keys: {}, errors: [], luaErrors: 0, crash: {}, cdStuck: {}, ms: 0,
    };
    for (const s of probe.skills) {
      S.skills[s.key] = { key: s.key, name: skillName(s.key), slot: s.slot, type: s.type, level: s.level, atkRate: fl(s.levelTable, 'SkillAttackRate'), cooldown: num(s.levelTable, 'CooldownTurn'),
        targetType: num(s.table, 'TargetType'), delayKey: str(s.table, 'DelaySkillKeyString'), summon: num(s.levelTable, 'IsSummonSkill') === 1, uses: 0, counterUses: 0, assistUses: 0, buffApplies: 0, hits: 0, misses: 0, dmg: 0, minHits: 0, crits: 0, kills: 0, summons: 0, summonFail: {}, heal: 0, keys: list(s.levelTable, 'BuffEffectIndex') };
    }
    for (const s of probe.skills) { const dk = str(s.table, 'DelaySkillKeyString'); if (dk) S.delayOf[dk] = s.key; }
    for (const k of declaredSet) S.keys[k] = { key: k, skills: declared[k].skills, trigger: ename('BUFFEFFECT_TRIGGER_TYPE', num(declared[k].row, 'BuffEffectTriggerType')), triggered: 0, applied: 0, stacked: 0, immune: 0, ap: 0, slots: {}, onSelf: 0, onAlly: 0, onEnemy: 0 };

    // scenarios: solo front / squad mid / squad back (columns: PC cell = (8-pos)%3 -> 5 front, 4 mid, 3 back)
    const per = Math.max(3, Math.round((+opts.actions || 42) / 3));
    const scenarios = [{ id: 'solo-front', label: '단독·전열', pos: 5, squad: [] }];
    if (fillers.length) {
      scenarios.push({ id: 'squad-mid', label: '분대·중열', pos: 4, squad: [[fillers[0], 5], [fillers[1], 1], [fillers[2], 7], [fillers[3], 3]] });
      scenarios.push({ id: 'squad-back', label: '분대·후열', pos: 3, squad: [[fillers[0], 5], [fillers[1], 4], [fillers[2], 2], [fillers[3], 8]] });
    } else scenarios.push({ id: 'solo-mid', label: '단독·중열', pos: 4, squad: [] }, { id: 'solo-back', label: '단독·후열', pos: 3, squad: [] });
    // promotion-dependent characters: also play at the start grade (before promotion skills unlock)
    S.promo = promoReplacements(pcKey);
    S.grades = [S.grade];
    const startGrade = num(pc, 'StartGrade', 1);
    const gradeLocked = (probe.skills || []).length && Object.keys(S.promo.byKey).length;
    if (opts.gradeScan !== false && gradeLocked && startGrade < S.grade) {
      S.grades.push(startGrade);
      scenarios.push({ id: 'solo-front-g' + startGrade, label: `단독·전열 (${startGrade}성)`, pos: 5, squad: [], grade: startGrade });
      if (fillers.length) scenarios.push({ id: 'squad-mid-g' + startGrade, label: `분대·중열 (${startGrade}성)`, pos: 4, squad: [[fillers[0], 5], [fillers[1], 1], [fillers[2], 7], [fillers[3], 3]], grade: startGrade });
    }
    let seed = (+opts.seed || 1) >>> 0;
    for (const sc of scenarios) {
      const scs = { id: sc.id, label: sc.label, subjActions: 0, battles: 0, outcomes: {} };
      S.scenarios.push(scs);
      let guard = 0, stalls = 0;
      while (scs.subjActions < per && guard++ < 8) {
        const squad = [subjectSpec(pcKey, sc.grade ? Object.assign({}, opts, { grade: sc.grade }) : opts, sc.pos)].concat(sc.squad.filter(([k]) => k).map(([k, pos]) => ({ key: k, gridPos: pos, grade: num(T('Table_PC', k), 'MaxGrade', 5), level: Math.max(1, Math.min(120, +opts.level || 90)), skillLevels: new Array(10).fill(10), equips: [] })));
        const r = runBattle(squad, seed++, per - scs.subjActions, S, pcKey);
        scs.battles++; scs.subjActions += r.subjActions; scs.outcomes[r.outcome] = (scs.outcomes[r.outcome] || 0) + 1;
        S.battles.push({ scenario: sc.id, seed: r.seed, outcome: r.outcome, reason: r.reason, actions: r.totalActions, subjActions: r.subjActions });
        if (r.outcome === 'error' || r.outcome === 'stuck') break;
        if (r.outcome === 'stall' && ++stalls >= 2) { scs.stalled = true; break; }
        if (r.subjActions === 0 && r.outcome !== 'stall') break;
      }
    }
    S.ms = Date.now() - t0;
    delete S.liveUses;
    S.staticExplained = staticExplained;
    S.allyTypes = [pcKey].concat(fillers).map((k) => typeOf(T('Table_PC', k)));
    S.enemyTypes = A.ENEMIES.map(([k]) => typeOf(T('Table_Monster', k)));
    runtimeFindings(S, add, probe);
    delete S.staticExplained;
    return { findings: F, stats: S };
  };

  function runBattle(squad, seed, wantActions, S, pcKey) {
    const L = LOSim;
    const b = L.battle.create({ stageKey: AUDIT_STAGE, mode: 'stage', squad, seed, logEnabled: true, options: { maxActions: Math.max(60, wantActions * (squad.length + 6) * 2) } });
    const res = { seed, outcome: 'running', reason: '', totalActions: 0, subjActions: 0 };
    if (b.result === 'error') {
      res.outcome = 'error'; res.reason = b.resultReason;
      for (const e of b.errors) S.errors.push({ msg: e.msg, stack: String(e.stack || '').split('\n').slice(0, 3).join(' | '), seed, phase: 'create' });
      return res;
    }
    const subj = b.units.find((u) => u.team === 1 && u.key === pcKey);
    const actives = subj.skills.filter((s) => s.slot === 1 || s.slot === 2);
    const cdRun = {};
    let steps = 0, waitRun = 0;
    while (!b.result && res.subjActions < wantActions && steps++ < 5000) {
      // alternate active skills: prefer the slot used less (all battles so far) that is not cooling down
      if (actives.length > 1) {
        const ready = actives.filter((s) => !(s.cooldownLeft > 0));
        const used = (k) => (S.skills[k] ? S.skills[k].uses : 0) + (S.liveUses[k] || 0);
        const cand = (ready.length ? ready : actives).slice().sort((x, y) => used(x.key) - used(y.key) || x.slot - y.slot);
        subj.pcAiFirstSkill = cand[0].slot === 2 ? 2 : 1;
      }
      const hpBefore = new Map(b.units.filter((u) => u.team === 1 && u !== subj).map((u) => [u.aid, u.hp]));
      const cdBefore = subj.skills.map((s) => s.cooldownLeft || 0);
      const rec = L.battle.step(b);
      if (rec && rec.type === 'action' && rec.actor && rec.actor.aid === subj.aid) {
        const own = rec.turnType === 'normal' || rec.turnType === 'double';
        if (own) res.subjActions++;
        if (own && rec.kind === 'skill' && rec.skill) S.liveUses[rec.skill] = (S.liveUses[rec.skill] || 0) + 1;
        // stall guard: the auto AI never moves, so a unit whose targets are all out of range waits forever
        if (own && rec.kind === 'wait' && rec.reason !== 'cooldown') { if (++waitRun >= 3) { res.stalled = true; break; } } else if (own) waitRun = 0;
        for (const u of b.units) if (u.team === 1 && u !== subj && hpBefore.has(u.aid) && u.hp > hpBefore.get(u.aid) && hpBefore.get(u.aid) > 0) {
          const d = u.hp - hpBefore.get(u.aid); S.healToAllies += d; if (rec.skill && S.skills[rec.skill]) S.skills[rec.skill].heal += d;
        }
        // cooldown watchdog: remaining cooldown seen at the start of consecutive own turns (turn-end ticks already ran)
        if (own) subj.skills.forEach((s, i) => {
          if (cdBefore[i] > 0) { cdRun[s.key] = (cdRun[s.key] || 0) + 1; const cd = num(s.levelTable, 'CooldownTurn'); if (cdRun[s.key] > cd + 2) S.cdStuck[s.key] = Math.max(S.cdStuck[s.key] || 0, cdRun[s.key]); }
          else cdRun[s.key] = 0;
        });
      }
      // keep the subject alive so passive/trigger coverage keeps growing (logged as auditHeals)
      if (subj.hp > 0 && subj.hp < subj.maxHp * 0.25) { subj.hp = subj.maxHp; S.auditHeals++; }
    }
    if (!b.result && res.stalled) { b.result = 'stall'; b.resultReason = 'subject waited 3 turns in a row (no target in range)'; S.stalls++; }
    if (!b.result && res.subjActions >= wantActions) { b.result = 'budget'; b.resultReason = 'subject action budget reached'; }
    res.outcome = b.result || 'running'; res.reason = b.resultReason || ''; res.totalActions = b.totalActions;
    S.subjActions += res.subjActions;
    S.wavesCleared += b.clearWave || 0;
    for (const e of b.errors) S.errors.push({ msg: e.msg, stack: String(e.stack || '').split('\n').slice(0, 3).join(' | '), seed, context: e.context ? JSON.stringify(e.context).slice(0, 300) : '' });
    if (b.result === 'stuck') S.errors.push({ msg: 'stuck: ' + b.resultReason, seed, stuck: true });
    S.luaErrors += (b.luaErrors || []).length;
    for (const [k, v] of Object.entries(b.counters || {})) S.crash[k] = (S.crash[k] || 0) + v;
    parseLog(b, subj, S);
    S.liveUses = {};
    return res;
  }

  function parseLog(b, subj, S) {
    const me = subj.aid;
    const allyAids = new Set(b.allUnits.filter((u) => u.team === 1 && u !== subj).map((u) => u.aid));
    const enemyAids = new Set(b.allUnits.filter((u) => u.team === 0).map((u) => u.aid));
    let cur = null; // the subject's skill whose action is being logged
    // effect types each skill actually produced (for the description match): anything the subject applied during that
    // skill's action, plus rows the skill owns whenever they applied (passives, triggers)
    const observe = (l) => {
      const r = T('Table_BuffEffect', l.key);
      const t = r && ename('BUFFEFFECT_TYPE', slotType(r, l.slot));
      if (!t) return;
      const add = (sk) => { if (sk) (sk.obs = sk.obs || {})[t] = (sk.obs[t] || 0) + 1; };
      if (cur && l.from === me) add(cur);
      if (l.from === me || (S.keys[l.key])) { const id = l.key + '#' + l.slot; (S.obsSlots = S.obsSlots || {})[id] = (S.obsSlots[id] || 0) + 1; }
      const ks = S.keys[l.key];
      if (ks) for (const k of ks.skills) if (S.skills[k] !== cur) add(S.skills[k]);
    };
    for (const l of b.log) {
      const sk = l.skill && (S.skills[S.delayOf[l.skill]] || S.skills[l.skill]); // delayed second hits count for the skill that reserved them
      switch (l.t) {
        case 'action':
          if (l.actor && l.actor.aid === me) cur = null; // the action record closes the subject's action
          if (l.actor && l.actor.aid === me) {
            if (l.kind === 'wait') { S.waits++; const r = l.reason || 'wait'; S.waitReasons[r] = (S.waitReasons[r] || 0) + 1; }
            if (l.kind === 'move') S.moves++;
          } else if (l.actor && allyAids.has(l.actor.aid) && l.kind === 'skill') S.allyActions++;
          break;
        case 'skill':
          if (l.src && l.src.aid === me && sk && !(l.reserve && S.delayOf[l.skill])) { if (l.counter) { sk.counterUses++; S.counters++; } else if (l.assist) sk.assistUses++; else sk.uses++; }
          if (l.src && l.src.aid === me) cur = l.counter || l.assist ? null : sk;
          break;
        case 'hit':
          if (l.src && l.src.aid === me) { S.subjectHits++; if (sk) { sk.hits++; sk.dmg += l.dmg || 0; if ((l.dmg || 0) <= 1) sk.minHits++; if (l.crit) sk.crits++; } if (l.crit) S.crits++; }
          if (l.dst && l.dst.aid === me) S.hitsTaken++;
          else if (l.dst && allyAids.has(l.dst.aid)) S.allyHitsTaken++;
          break;
        case 'miss':
          if (l.src && l.src.aid === me) { S.misses++; if (sk) sk.misses++; }
          if (l.dst && l.dst.aid === me) S.evades++;
          break;
        case 'kill':
          if (l.src && l.src.aid === me) { S.kills++; if (sk) sk.kills++; }
          break;
        case 'death':
          if (l.dst && l.dst.aid === me) S.subjectDeaths++;
          else if (l.dst && allyAids.has(l.dst.aid)) S.allyDeaths++;
          else if (l.dst && enemyAids.has(l.dst.aid)) S.enemyDeaths++;
          break;
        case 'summon':
          if (l.src && l.src.aid === me) { S.summons++; if (sk) sk.summons++; }
          break;
        case 'summon_fail':
          if (l.src && l.src.aid === me && sk) sk.summonFail[l.why] = (sk.summonFail[l.why] || 0) + 1;
          break;
        case 'counter_null':
          if (l.unit && l.unit.aid === me) S.crash.counterNullHolder = (S.crash.counterNullHolder || 0) + 1;
          else if (l.attacker && l.attacker.aid === me) S.crash.counterNullAttacker = (S.crash.counterNullAttacker || 0) + 1;
          break;
        case 'buff': {
          if (l.op === 'trigger') {
            if (l.owner === me) for (const k of l.rows || []) if (S.keys[k]) S.keys[k].triggered++;
            break;
          }
          const ks = l.key && S.keys[l.key];
          if (!ks) { if (l.op === 'apply') observe(l); break; }
          if (l.op === 'apply') {
            observe(l);
            ks.applied++; ks.slots[l.slot] = (ks.slots[l.slot] || 0) + 1;
            for (const sk2 of ks.skills) if (S.skills[sk2]) S.skills[sk2].buffApplies++;
            // an effect another skill applies because THIS skill was used (USE_ACTIVE_SKILL_n / USE_SKILL_SPEC / USE_SKILL),
            // e.g. a promotion skill taking over: credit it to the skill in use as well
            if (cur && l.from === me && !ks.skills.includes(cur.key) && /^USE_/.test(ks.trigger)) { cur.buffApplies++; (cur.viaOther = cur.viaOther || {})[l.key] = (cur.viaOther[l.key] || 0) + 1; }
            if (l.unit === me) ks.onSelf++; else if (allyAids.has(l.unit)) ks.onAlly++; else if (enemyAids.has(l.unit)) ks.onEnemy++;
          } else if (l.op === 'stack') ks.stacked++;
          else if (l.op === 'immune') ks.immune++;
          else if (l.op === 'ap') ks.ap++;
          break;
        }
        default: break;
      }
    }
  }

  const typeOf = (row) => ({ body: num(row, 'ActorBodyType'), cls: num(row, 'ActorClassType'), role: num(row, 'RoleType') });
  function runtimeFindings(S, add, probe) {
    const TTn = (t) => ename('TARGET_TYPE', t);
    // engine exceptions / stuck / client-crash counters
    const errs = {};
    for (const e of S.errors) { const k = e.msg; (errs[k] = errs[k] || []).push(e); }
    for (const [msg, arr] of Object.entries(errs)) {
      const stuck = arr[0].stuck;
      add({ sev: 'error', code: stuck ? 'RT_STUCK' : 'RT_EXCEPTION', msg: stuck ? '전투 진행 불가(멈춤)' : '전투 중 엔진 예외 (클라이언트 크래시 후보)', evidence: `${msg} · ${arr.length}회 (seed ${arr.map((e) => e.seed).slice(0, 4).join(',')})${arr[0].stack ? ' · ' + arr[0].stack : ''}${arr[0].context ? ' · ' + arr[0].context : ''}`, conf: 'med', ref: stuck ? 'battle.js roundStarted / BattleManager.coBattleAI' : '' });
    }
    if (S.crash.counterNullHolder) add({ sev: 'error', code: 'RT_COUNTER_NULL', msg: '반격 효과를 가진 이 전투원이 광역 공격의 부가 대상으로 맞았는데 반격을 만들지 못하는 경로에 진입 (클라이언트 NullReference 후보)', evidence: `${S.crash.counterNullHolder}회 · 반격 버프 보유 + 주 대상이 아닌 피격 + 반격 불가(사거리 등)`, conf: 'med', ref: 'BattleManager.cs:4953-4957 ExtraAction (counter.CounterBuff null 역참조) / combat.js counter_null' });
    if (S.crash.counterNullAttacker) add({ sev: 'info', code: 'RT_COUNTER_NULL_ENEMY', msg: '이 전투원의 공격이 적의 반격 null 경로를 유발 (원인은 적 쪽 반격 효과)', evidence: `${S.crash.counterNullAttacker}회`, conf: 'low', ref: 'BattleManager.cs:4953' });
    if (S.stalls) add({ sev: 'info', code: 'RT_STALL', msg: `사거리 안에 대상이 없어 대기만 반복한 전투 ${S.stalls}회 (자동 전투는 이동하지 않음 — 새 전투로 다시 시작함)`, evidence: S.scenarios.filter((x) => x.stalled).map((x) => x.label + ' 시나리오 중단').join(', ') || '-', conf: 'low' });
    if (S.subjActions === 0) { add({ sev: 'error', code: 'RT_NO_ACTION', msg: '점검 전투에서 한 번도 행동하지 못함', evidence: `전투 ${S.battles.length}회: ${S.battles.map((b) => b.outcome + (b.reason ? '(' + b.reason + ')' : '')).join(', ').slice(0, 300)}`, conf: 'med' }); return; }
    if (S.subjectDeaths) add({ sev: 'info', code: 'RT_DIED', msg: `점검 중 ${S.subjectDeaths}회 사망 (체력 25% 미만이면 회복시키지만 한 번에 큰 피해를 받음)`, evidence: `적 공격력 ${S.enemyAtk}`, conf: 'low' });

    // per active skill
    for (const sk of Object.values(S.skills)) {
      const sb = { skill: sk.key, skillName: sk.name };
      if (sk.type !== 0) continue; // passives: covered by the buff checks
      if (sk.slot !== 1 && sk.slot !== 2) continue;
      if (sk.uses === 0) {
        add(Object.assign({ sev: 'suspect', code: 'RT_SKILL_UNUSED', msg: '자동 전투에서 한 번도 사용되지 않은 액티브 스킬 (두 스킬을 번갈아 쓰도록 유도했음)', evidence: `행동 ${S.subjActions}회, 대기 ${S.waits}회 (${Object.entries(S.waitReasons).map(([k, v]) => k + ' ' + v).join(', ') || '-'}), 대상 ${TTn(sk.targetType)}, 사거리 ${num(T('Table_SkillLevel', sk.key + '_Lv' + sk.level), 'Distance')}, 쿨타임 ${sk.cooldown}, 대기만 하다 중단된 전투 ${S.stalls}`, conf: S.stalls ? 'low' : 'med', ref: 'ai.js characterAI / combat.js canUse' }, sb));
        continue;
      }
      const enemyTarget = [3, 4, 9].includes(sk.targetType);
      if (sk.atkRate > 0 && enemyTarget && sk.uses >= 3 && sk.hits === 0 && sk.misses === 0 && !sk.summon && sk.delayKey)
        add(Object.assign({ sev: 'suspect', code: 'RT_DELAY_NO_HIT', msg: `지연 스킬(${sk.delayKey})을 ${sk.uses}회 예약했지만 착탄 기록이 없음`, evidence: `SkillAttackRate ${sk.atkRate}, 대상 ${TTn(sk.targetType)}`, conf: 'med', ref: 'battle.js reserve skills / ReserveSkillInfo' }, sb));
      else if (sk.atkRate > 0 && enemyTarget && sk.uses >= 3 && sk.hits === 0 && sk.misses === 0 && !sk.summon && !sk.delayKey)
        add(Object.assign({ sev: 'suspect', code: 'RT_NO_DAMAGE', msg: '피해 계수가 있는 공격 스킬인데 명중/회피 기록이 전혀 없음', evidence: `사용 ${sk.uses}회, SkillAttackRate ${sk.atkRate}, 대상 ${TTn(sk.targetType)}`, conf: 'med', ref: 'combat.js execute' }, sb));
      else if (sk.atkRate > 0 && enemyTarget && sk.hits >= 3 && sk.dmg === 0)
        add(Object.assign({ sev: 'suspect', code: 'RT_ZERO_DAMAGE', msg: '명중했지만 피해 합계가 0', evidence: `명중 ${sk.hits}회, SkillAttackRate ${sk.atkRate}`, conf: 'med' }, sb));
      else if (sk.atkRate > 0 && sk.hits >= 5 && sk.minHits / sk.hits >= 0.8)
        add(Object.assign({ sev: 'suspect', code: 'RT_MIN_DAMAGE', msg: '방어력 0인 적에게도 대부분 최소 피해(1)', evidence: `명중 ${sk.hits}회 중 ${sk.minHits}회가 1 이하, SkillAttackRate ${sk.atkRate}`, conf: 'med' }, sb));
      if (sk.viaOther) add(Object.assign({ sev: 'info', code: 'RT_VIA_OTHER', msg: '이 스킬을 쓸 때 다른 스킬(승급·패시브)의 효과 행이 대신/추가로 적용됨', evidence: Object.entries(sk.viaOther).map(([k, v]) => `${k} ${v}회`).join(', '), conf: 'high' }, sb));
      if (sk.uses >= 3 && sk.hits === 0 && sk.misses === 0 && sk.buffApplies === 0 && sk.summons === 0 && sk.heal === 0)
        add(Object.assign({ sev: 'suspect', code: 'RT_NO_EFFECT', msg: `${sk.uses}회 사용했지만 피해·버프 적용·소환·회복 기록이 하나도 없음 (사용해도 아무 일도 일어나지 않음)`, evidence: `SkillAttackRate ${sk.atkRate || 0}, 대상 ${TTn(sk.targetType)}, 버프 ${sk.keys.join(', ') || '없음'}`, conf: 'med', ref: 'combat.js execute / Table_SkillLevel' }, sb));
      if (sk.summon && sk.uses > 0 && sk.summons === 0) add(Object.assign({ sev: 'suspect', code: 'RT_NO_SUMMON', msg: '소환 스킬을 사용했지만 소환물이 생성되지 않음', evidence: `사용 ${sk.uses}회, 실패 사유 ${JSON.stringify(sk.summonFail)}`, conf: 'med', ref: 'combat.js spawnSummon' }, sb));
      if (S.cdStuck[sk.key]) add(Object.assign({ sev: 'error', code: 'RT_COOLDOWN_STUCK', msg: '쿨타임이 끝나지 않음', evidence: `CooldownTurn ${sk.cooldown}인데 자신의 턴 ${S.cdStuck[sk.key]}회 연속 쿨타임`, conf: 'med', ref: 'CreatureSkill.OnOwnerTurnEnded' }, sb));
    }

    // per declared buff key
    const usedSkill = (k) => S.keys[k].skills.some((sk) => S.skills[sk] && (S.skills[sk].type !== 0 || S.skills[sk].uses + S.skills[sk].counterUses > 0));
    for (const ks of Object.values(S.keys)) {
      const r = T('Table_BuffEffect', ks.key);
      const owner = ks.skills[0];
      const sb = { skill: owner, skillName: skillName(owner), effect: ks.key };
      const live = [];
      for (let i = 1; i <= 5; i++) if (slotRate(r, i) > 0) live.push(i);
      if (!live.length) continue; // all slots rate 0: reported by the static check
      const liveImpl = live.filter((i) => typeStatus(slotType(r, i)) !== 'todo');
      if (!liveImpl.length) { if (ks.applied === 0) add(Object.assign({ sev: 'simlimit', code: 'RT_SIM_TODO', msg: '시뮬레이터가 지원하지 않는 효과만 있어 확인 불가', evidence: live.map((i) => ename('BUFFEFFECT_TYPE', slotType(r, i))).join(', '), conf: 'high' }, sb)); continue; }
      const trig = num(r, 'BuffEffectTriggerType');
      const tc = triggerClass(trig);
      const cond = condText(r);
      const lvRate = (() => { const s = probe.skills.find((x) => x.key === owner); return s ? fl(s.levelTable, 'BuffEffectRate') : 1; })();
      const minSlotRate = Math.min(...live.map((i) => slotRate(r, i)));
      const ev = `트리거 ${ks.trigger}, 대상 ${TTn(num(r, 'BuffEffectTargetType'))}${cond ? ', 조건 ' + cond : ''}, 트리거 매칭 ${ks.triggered}회, 적용 ${ks.applied}회`;
      if (ks.applied + ks.stacked > 0) {
        // AP effects: applied but the AP never moved
        for (const i of live) {
          const t = ename('BUFFEFFECT_TYPE', slotType(r, i));
          if ((t === 'STAGE_AP_VALUE' || t === 'STAGE_AP_SHIFT') && ks.slots[i] > 0 && ks.ap === 0 && Math.abs(slotVal(r, i, 10)) > 0)
            add(Object.assign({ sev: 'suspect', code: 'RT_AP_NOEFFECT', slot: i, msg: 'AP 효과가 적용됐지만 AP(turnPos) 변화 기록이 없음', evidence: `${t} 값 ${slotVal(r, i, 10)}, 적용 ${ks.slots[i]}회`, conf: 'low', ref: 'buffs.js doBuffOnly' }, sb));
        }
        // a live (rate 1) slot that never landed while the row applied many times
        for (const i of live) {
          if (ks.slots[i] || ks.applied < 5 || slotRate(r, i) < 1) continue;
          const t = slotType(r, i);
          add(Object.assign({ sev: 'unverified', code: 'RT_SLOT_NEVER', slot: i, msg: `행은 ${ks.applied}회 적용됐는데 슬롯 ${i} 효과는 한 번도 붙지 않음 (중첩 불가·면역·대상 조건 가능성)`, evidence: `${ename('BUFFEFFECT_TYPE', t)} 중첩 ${ename('BUFF_OVERLAP_TYPE', num(r, 'BuffEffectOverlapType' + i))}`, conf: 'low', ref: 'buffs.js applyBuffSub' }, sb));
        }
        continue;
      }
      // never applied: explain
      if (S.staticExplained && S.staticExplained.has(ks.key)) continue;
      const pr = S.promo && S.promo.byKey[ks.key];
      if (pr && S.grades && !S.grades.some((g) => g < pr.grade)) { add(Object.assign({ sev: 'unverified', code: 'RT_PROMO_OFF', msg: `${pr.grade}성 이상에서는 승급 스킬(${skillName(pr.promoSkill)})로 대체되어 꺼지는 효과 — ${pr.grade}성 미만 등급으로 점검하지 않아 확인 못 함`, evidence: ev, conf: 'high' }, sb)); continue; }
      if (pr) { add(Object.assign({ sev: 'info', code: 'RT_PROMO_OFF', msg: `${pr.grade}성 이상에서는 승급 스킬(${skillName(pr.promoSkill)})로 대체되어 꺼지는 효과인데, ${pr.grade}성 미만 점검에서도 적용되지 않음`, evidence: ev + ` · 점검 등급 ${S.grades.join('/')}`, conf: 'med' }, sb)); continue; }
      if (!usedSkill(ks.key)) { add(Object.assign({ sev: 'unverified', code: 'RT_NOT_APPLIED', msg: '소속 스킬을 사용하지 않아 확인 못 함', evidence: ev, conf: 'high' }, sb)); continue; }
      if (ks.immune) { add(Object.assign({ sev: 'unverified', code: 'RT_NOT_APPLIED', msg: '대상 면역으로 적용되지 않음', evidence: ev + `, 면역 ${ks.immune}회`, conf: 'med' }, sb)); continue; }
      if (ks.triggered > 0) {
        if (cond) add(Object.assign({ sev: 'unverified', code: 'RT_COND_FAIL', msg: '트리거는 발생했지만 적용 조건을 만족하지 못함 (시나리오에서 조건 미충족)', evidence: ev, conf: 'med' }, sb));
        else if (minSlotRate < 1 || lvRate < 1) add(Object.assign({ sev: 'unverified', code: 'RT_RATE_MISS', msg: '확률 효과가 점검 중 한 번도 당첨되지 않음', evidence: ev + `, 확률 ${live.map((i) => pct(slotRate(r, i)) + '%').join('/')}${lvRate < 1 ? ', 스킬 확률 ' + pct(lvRate) + '%' : ''}`, conf: 'med' }, sb));
        else {
          const tt = num(r, 'BuffEffectTargetType');
          const ttn = TTn(tt);
          const pool = /^OUR|^SELF/.test(ttn) ? S.allyTypes : /^ENEMY/.test(ttn) ? S.enemyTypes : S.allyTypes.concat(S.enemyTypes);
          const okType = (u) => [['ApplyActorBodyType', 'body', 4], ['ApplyActorClassType', 'cls', 3], ['ApplyActorRoleType', 'role', 3]].every(([col, f, mx]) => { const l = [].concat(r[col] === undefined ? [] : r[col]).map(Number); return l.includes(mx) || l.includes(u[f]); });
          const matches = (tt === 0 ? [S.allyTypes[0]] : pool).filter(okType).length;
          const typeTxt = `적용 대상 Body ${list(r, 'ApplyActorBodyType').join('/')} Class ${list(r, 'ApplyActorClassType').join('/')} Role ${list(r, 'ApplyActorRoleType').join('/')}`;
          if (!matches) add(Object.assign({ sev: 'unverified', code: 'RT_TARGET_TYPE', msg: '적용 대상 타입(신체/병과/역할)에 맞는 유닛이 점검 시나리오에 없음', evidence: ev + ', ' + typeTxt, conf: 'high' }, sb));
          else if (/_GRID$/.test(ttn)) add(Object.assign({ sev: 'unverified', code: 'RT_TARGET_TYPE', msg: `범위(${ttn}) 안에 적용 대상 타입에 맞는 유닛이 없었을 수 있음`, evidence: ev + ', ' + typeTxt + `, 시나리오 내 해당 타입 ${matches}기`, conf: 'med' }, sb));
          else add(Object.assign({ sev: 'suspect', code: 'RT_TRIGGER_NO_APPLY', msg: `트리거가 ${ks.triggered}회 발생했고 조건·확률 제약도 없고 대상 타입 유닛(${matches}기)도 있는데 한 번도 적용되지 않음`, evidence: ev + ', ' + typeTxt, conf: 'med', ref: 'buffs.js applyTriggerSub / Creature.cs ApplyBuffTriggerList' }, sb));
        }
        continue;
      }
      // trigger never matched. For an active skill's own row the prerequisite is counted for that skill only.
      const ownSk = S.skills[owner];
      const perSkill = ownSk && ownSk.type === 0 && { subjectHits: 'hits', kills: 'kills', crits: 'crits', misses: 'misses' }[tc.need];
      const needN = tc.need ? (perSkill ? ks.skills.reduce((a, k) => a + ((S.skills[k] && S.skills[k][perSkill]) || 0), 0) : S[tc.need] || 0) : null;
      const trn = ks.trigger;
      if (trn === 'FRIENDLY' || trn === 'ENEMY') { add(Object.assign({ sev: 'unverified', code: 'RT_TRIGGER_NONE', msg: `특정 ${trn === 'FRIENDLY' ? '아군' : '적'}(${str(r, 'BuffEffectTriggerValue') || '?'})과 함께 출전해야 발동 — 점검 시나리오에 없음`, evidence: ev, conf: 'high' }, sb)); continue; }
      if (tc.cls === 'situational' && (tc.need === null || needN === 0)) { add(Object.assign({ sev: 'unverified', code: 'RT_TRIGGER_NONE', msg: `트리거 상황이 점검 시나리오에서 발생하지 않음 (${tc.why || ks.trigger})`, evidence: ev, conf: 'high' }, sb)); continue; }
      if (tc.cls === 'ally' && needN === 0) { add(Object.assign({ sev: 'unverified', code: 'RT_TRIGGER_NONE', msg: '아군 관련 트리거 상황이 발생하지 않음', evidence: ev + `, ${tc.need}=0`, conf: 'high' }, sb)); continue; }
      if (tc.need && needN === 0) { add(Object.assign({ sev: 'unverified', code: 'RT_TRIGGER_NONE', msg: `트리거 전제(${tc.need})가 0회라 확인 못 함`, evidence: ev, conf: 'high' }, sb)); continue; }
      if (lvRate < 1) { add(Object.assign({ sev: 'unverified', code: 'RT_RATE_MISS', msg: `스킬 레벨 확률(${pct(lvRate)}%) 때문에 한 번도 발동하지 않았을 수 있음`, evidence: ev, conf: 'med' }, sb)); continue; }
      add(Object.assign({ sev: 'suspect', code: 'RT_TRIGGER_NEVER', msg: `트리거(${ks.trigger}) 전제 상황은 발생했는데 이 효과는 한 번도 발동 후보가 되지 않음`, evidence: ev + (tc.need ? `, ${perSkill ? '소속 스킬의 ' : ''}${tc.need}=${needN}` : '') + `, 소속 스킬 ${ks.skills.join(',')}`, conf: tc.cls === 'common' || tc.cls === 'action' ? 'med' : 'low', ref: 'buffs.js matchRow/collectSkillRows / Creature.cs ApplyBuffTriggerList' }, sb));
    }
  }

  // ================================================================== combined
  // ================================================================== C. description vs actual effects
  // Phrase dictionary learned from the data itself: every slot description "name : <effect phrase>" tells which
  // BUFFEFFECT_TYPE that phrase stands for. A skill description is then read for those phrases and compared with what
  // the skill really produced in the runtime battles.
  let PHRASES = null;
  const phraseNoun = (t) => String(t || '').replace(/<[^>]+>|\{\d+\}|\([^)]*\)|[-+]?\d+(\.\d+)?%?|%/g, ' ')
    .replace(/\s*(증가|감소|상승|하락|해제|부여|적용|활성화)\s*$/, '').replace(/\s+/g, ' ').trim();
  function phraseDict(desc) {
    if (PHRASES) return PHRASES;
    const m = {};
    for (const [k, v] of Object.entries((desc && desc.buffs) || {})) {
      const r = T('Table_BuffEffect', k);
      if (!r || !v || !v.d) continue;
      v.d.forEach((txt, i) => {
        if (!txt) return;
        const t = ename('BUFFEFFECT_TYPE', slotType(r, i + 1));
        if (!t) return;
        const eff = txt.includes(':') ? txt.split(':').slice(1).join(':') : txt;
        const noun = phraseNoun(eff);
        if (noun.length < 2 || noun.length > 14 || /[<>\[\]]/.test(noun)) return;
        const e = (m[noun] = m[noun] || { n: 0, types: {} });
        e.n++; e.types[t] = (e.types[t] || 0) + 1;
      });
    }
    const out = [];
    for (const [noun, e] of Object.entries(m)) {
      if (e.n < 3) continue;
      // keep the types that make up at least 10% of that phrase's uses (labels are not always consistent)
      const types = Object.entries(e.types).filter(([, c]) => c / e.n >= 0.1).map(([t]) => t);
      const consistent = Math.max(...Object.values(e.types)) / e.n >= 0.8;
      out.push({ noun, key: noun.replace(/\s+/g, ''), types, consistent, n: e.n });
    }
    // longer phrases first so "받는 피해 감소" wins over "피해"
    out.sort((a, b) => b.key.length - a.key.length);
    return (PHRASES = out);
  }
  // "적중 / 치명타 / 행동력이 감소" -> effect ; "공격 적중 시" -> timing word, not an effect
  const CHANGE_RE = /^(?:[\/·,와과및]+[가-힣A-Za-z\s]{1,10}?)*?(?:을|를|이|가|도|의)?(?:크게|대폭|소폭|일시적으로|추가로|매우|대량)?(증가|감소|상승|하락|해제|부여|무시|활성화|지정|봉인|회복|면역|불가|제거|강화|약화|중첩|누적|증폭)/;
  function isEffectUse(flat, key, at) {
    const after = flat.slice(at + key.length, at + key.length + 26);
    if (/^(시|할 시|한경우|하면|률|확률)/.test(after)) return false;
    return CHANGE_RE.test(after) || /^(효과|상태)/.test(after);
  }
  const COND_RE = /(영향\s*(을)?\s*받지\s*않|경우|있을 시|있으면|일 때|인 대상|대상이 .{1,10}(이면|일 시)|확률|웨이브 종료 시|웨이브 개시 시|전투 개시 시|사망 시|피격 시|처치 시|반격 시|회피 시|라운드 개시 시|라운드 종료 시|중첩|스킬 레벨|에게 협동|협동 공격을 유도|스쿼드에)/;
  function descMatch(pcKey, out, desc) {
    const S = out.runtime;
    if (!S || !S.skills || !desc || !desc.skills) return;
    const typesOfKeys = (keys) => {
      const seen = new Set(keys), q = [...keys], types = new Set();
      while (q.length && seen.size < 1500) {
        const r = T('Table_BuffEffect', q.pop());
        if (!r) continue;
        for (let i = 1; i <= 5; i++) if (slotRate(r, i) > 0) { const t = ename('BUFFEFFECT_TYPE', slotType(r, i)); if (t) types.add(t); }
        for (const v of Object.values(r)) for (const x of Array.isArray(v) ? v : [v]) if (typeof x === 'string' && /^Effect_/.test(x) && !seen.has(x) && T('Table_BuffEffect', x)) { seen.add(x); q.push(x); }
      }
      return types;
    };
    const skillKeysAll = (skKey) => { const t = T('Table_Skill', skKey); const out2 = new Set(); if (!t) return []; const mx = Math.max(1, num(t, 'MaxSkillLevel', 1)); for (let lv = 1; lv <= mx; lv++) for (const k of list(lvRow(skKey, lv), 'BuffEffectIndex')) out2.add(k); return [...out2]; };
    // slots whose own description names the phrase (text match is sturdier than type mapping: labels vary)
    const slotIndex = (keys) => {
      const seen = new Set(keys), q = [...keys], out2 = [];
      while (q.length && seen.size < 1500) {
        const k = q.pop(), r = T('Table_BuffEffect', k);
        if (!r) continue;
        for (let i = 1; i <= 5; i++) if (slotRate(r, i) > 0) { const d = buffDescOf(desc, k, i); if (d) out2.push({ id: k + '#' + i, text: d.replace(/\s+/g, '') }); }
        for (const v of Object.values(r)) for (const x of Array.isArray(v) ? v : [v]) if (typeof x === 'string' && /^Effect_/.test(x) && !seen.has(x) && T('Table_BuffEffect', x)) { seen.add(x); q.push(x); }
      }
      return out2;
    };
    const siCache = {};
    const skillSlots = (skKey) => siCache[skKey] || (siCache[skKey] = slotIndex(skillKeysAll(skKey)));
    let csCache = null;
    const charSlots = () => {
      if (csCache) return csCache;
      const code = pcKey.replace(/^Char_/, '');
      const wide = Object.keys(T('Table_BuffEffect') || {}).filter((k) => k.startsWith('Effect_' + code + '_'));
      return (csCache = slotIndex(Object.keys(S.skills).flatMap(skillKeysAll).concat(wide)));
    };
    const obsSlots = S.obsSlots || {};
    const stCache = {};
    const skillTypes = (skKey) => stCache[skKey] || (stCache[skKey] = typesOfKeys(skillKeysAll(skKey)));
    let ctCache = null;
    const charTypes = () => {
      if (ctCache) return ctCache;
      const code = pcKey.replace(/^Char_/, '');
      const wide = Object.keys(T('Table_BuffEffect') || {}).filter((k) => k.startsWith('Effect_' + code + '_'));
      return (ctCache = typesOfKeys(Object.keys(S.skills).flatMap(skillKeysAll).concat(wide)));
    };
    const dict = phraseDict(desc);
    const fam = (t) => familyOf(t);
    out.descMatch = [];
    for (const sk of Object.values(S.skills)) {
      const dd = desc.skills[sk.key];
      if (!dd || !dd.d) continue;
      const text = String(dd.d).replace(/<color[^>]*>|<\/color>/g, '');
      const sentences = text.split(/(?<=[.。])\s+|\n/).map((x) => x.trim()).filter(Boolean);
      const obs = sk.obs || {};
      const obsTypes = Object.keys(obs);
      const items = [];
      for (const sen of sentences) {
        const flat = sen.replace(/\s+/g, '');
        const conditional = COND_RE.test(sen);
        let rest = flat;
        for (const ph of dict) {
          if (!rest.includes(ph.key)) continue;
          const at = rest.indexOf(ph.key);
          rest = rest.split(ph.key).join('□'); // consume so shorter phrases inside it do not match again
          if (!isEffectUse(flat, ph.key, at)) continue;
          const found = obsTypes.find((t) => ph.types.includes(t) || ph.types.some((x) => fam(x) && fam(x) === fam(t)));
          items.push({ phrase: ph.noun, types: ph.types, consistent: ph.consistent, conditional, found: found || '', count: found ? obs[found] : 0, sentence: sen.length > 80 ? sen.slice(0, 78) + '…' : sen });
        }
        if (/피해를\s*(줍|입힙)|\{0\}\s*피해/.test(sen)) items.push({ phrase: '피해', types: ['(hit)'], consistent: true, conditional, found: sk.hits > 0 || sk.dmg > 0 ? 'hit' : '', count: sk.hits, sentence: sen.slice(0, 78) });
        if (/(HP|체력)[^.]{0,12}회복/.test(sen)) items.push({ phrase: '회복', types: ['(heal)'], consistent: true, conditional, found: sk.heal > 0 || obsTypes.some((t) => /HEAL|RECOVER/.test(t)) ? 'heal' : '', count: sk.heal, sentence: sen.slice(0, 78) });
        if (/(소환|설치)합니다|(소환|설치)하며|(소환|설치)하고/.test(sen)) items.push({ phrase: '소환·설치', types: ['(summon)'], consistent: true, conditional, found: sk.summons > 0 ? 'summon' : '', count: sk.summons, sentence: sen.slice(0, 78) });
      }
      if (!items.length) continue;
      const used = sk.uses > 0 || sk.type !== 0 || obsTypes.length > 0;
      const must = items.filter((x) => !x.conditional && x.consistent);
      // effects the description names but the battles never produced: does the data define them anywhere?
      const inData = (x) => {
        if (x.types[0] === '(hit)') return sk.atkRate > 0;
        if (x.types[0] === '(heal)') return [...skillTypes(sk.key), ...charTypes()].some((t) => /HEAL|RECOVER/.test(t));
        if (x.types[0] === '(summon)') return sk.summon;
        const has = (set) => [...set].some((t) => x.types.includes(t) || x.types.some((y) => fam(y) && fam(y) === fam(t)));
        return has(skillTypes(sk.key)) ? 'skill' : has(charTypes()) ? 'char' : '';
      };
      for (const x of must) {
        if (x.found || x.types[0].startsWith('(')) { if (!x.found) x.inData = inData(x); continue; }
        const key = x.phrase.replace(/\s+/g, '');
        const mine = skillSlots(sk.key).filter((z) => z.text.includes(key));
        const anyChar = mine.length ? mine : charSlots().filter((z) => z.text.includes(key));
        const seenSlot = anyChar.find((z) => obsSlots[z.id]);
        if (seenSlot) { x.found = 'slot ' + seenSlot.id; x.count = obsSlots[seenSlot.id]; continue; }
        x.inData = anyChar.length ? (mine.length ? 'skill' : 'char') : inData(x);
        if (anyChar.length) x.slots = anyChar.slice(0, 3).map((z) => z.id);
      }
      const missing = must.filter((x) => !x.found && !x.inData);
      const notSeen = must.filter((x) => !x.found && x.inData);
      const verdict = !used ? 'unused' : !must.length ? 'conditional-only' : missing.length ? 'missing' : notSeen.length ? 'partial' : 'match';
      out.descMatch.push({ skill: sk.key, skillName: sk.name, verdict, items, missing: missing.map((x) => x.phrase), notSeen: notSeen.map((x) => x.phrase) });
      const sb = { skill: sk.key, skillName: sk.name, cat: 'desc' };
      const base = { char: pcKey, charName: out.name };
      if (notSeen.length) out.findings.push(mkFinding(base, Object.assign({ sev: 'unverified', code: 'DESC_EFFECT_UNSEEN', msg: `설명의 효과가 점검 전투에서는 나오지 않음 (데이터에는 해당 효과 행이 있음 — 조건·시나리오 미충족 가능): ${notSeen.map((x) => "'" + x.phrase + "'").join(', ')}`,
        evidence: notSeen.map((x) => `"${x.sentence}" → ${x.slots ? x.slots.join(', ') : x.types.join('/')} (${x.inData === 'skill' ? '이 스킬 행' : '같은 전투원의 다른 행'}에 있음)`).join(' · '), conf: 'med', ref: 'skilldesc vs runtime' }, sb)));
      if (verdict === 'missing') {
        // wording can't always be read reliably: only clear-cut cases become suspects, the rest go to a review list
        const clear = missing.some((x) => x.types[0] === '(summon)') || (sk.uses >= 3 && !obsTypes.length && !sk.hits && !sk.heal && !sk.summons);
        out.findings.push(mkFinding(base, Object.assign({ sev: clear ? 'suspect' : 'unverified', code: 'DESC_EFFECT_MISSING', msg: (clear ? '' : '[검토 필요] ') + `설명에 있는 효과를 전투에서도 데이터에서도 찾지 못함: ${missing.map((x) => "'" + x.phrase + "'").join(', ')}` + (clear ? '' : ' (설명 문구 해석 한계일 수 있음)'),
          evidence: missing.map((x) => `"${x.sentence}" → 기대 ${x.types.join('/')}`).join(' · ') + ` · 실제로 나온 효과: ${obsTypes.join(', ') || '없음'}${sk.hits ? ', 피해 ' + sk.hits + '회' : ''}`, conf: clear ? 'med' : 'low', ref: 'skilldesc vs runtime + Table_BuffEffect' }, sb)));
      }
      if (verdict === 'match') {
        // the description is fulfilled: structural doubts about this skill's rows are not design bugs
        for (const f of out.findings) {
          if (f.skill !== sk.key || f.sev !== 'suspect' || !DESC_PASSABLE.has(f.code)) continue;
          f.sev = 'info'; f.passedByDesc = true;
          f.msg = '[설명 대조 통과] ' + f.msg;
          f.evidence += ` · 설명의 효과(${must.map((x) => x.phrase).join(', ')})가 실제 전투에서 모두 확인됨`;
        }
      }
    }
  }
  // structural findings that a fulfilled description overrides (numbers, missing data and crashes are never passed)
  const DESC_PASSABLE = new Set(['RATE0_SLOT', 'RT_TRIGGER_NEVER', 'RT_TRIGGER_NO_APPLY', 'RT_SLOT_NEVER', 'DUP_SLOT', 'SKILL_BUFFRATE0', 'RT_NO_EFFECT', 'PASSIVE_ACTIVE_TRIGGER', 'USEAVAIL_NONE']);
  A.phraseDict = phraseDict;

  A.auditCharacter = function (pcKey, opts, desc) {
    opts = Object.assign({}, A.DEFAULTS, opts || {});
    const pc = T('Table_PC', pcKey);
    const out = { key: pcKey, name: LOSim.name(pc && pc.Name, pcKey), opts: { grade: opts.grade, level: opts.level, skillLevel: opts.skillLevel }, findings: [], skills: [], runtime: null, ms: 0 };
    const t0 = Date.now();
    let st = null;
    if (opts.includeStatic) {
      try { st = A.staticCheck(pcKey, opts, desc); out.findings.push(...st.findings); out.skills = st.skills; out.grade = st.grade; out.displayOnlySlots = st.displayOnly; out.displayVerified = st.displayVerified || []; }
      catch (e) { out.findings.push(mkFinding({ char: pcKey, charName: out.name }, { sev: 'error', code: 'AUDIT_FAIL', msg: '정적 점검 중 예외 (점검 도구 문제일 수 있음)', evidence: String(e && e.stack || e).slice(0, 400), conf: 'low' })); }
    }
    if (opts.includeRuntime) {
      try {
        // effects whose "never applied" is already explained by a static finding are not re-reported at runtime
        const staticEff = new Set(out.findings.filter((f) => f.effect && ['SIM_TODO', 'PASSIVE_ACTIVE_TRIGGER', 'DANGLING_REF'].includes(f.code)).map((f) => f.effect));
        for (const f of out.findings) if (f.code === 'USEAVAIL_NONE' || f.code === 'SKILL_BUFFRATE0') for (const k of (f.evidence.split('BuffEffectIndex: ')[1] || '').split(', ')) if (k) staticEff.add(k);
        const rt = A.runtimeCheck(pcKey, Object.assign({}, opts, { _staticExplained: staticEff }));
        out.runtime = rt.stats;
        out.findings.push(...rt.findings);
      } catch (e) { out.findings.push(mkFinding({ char: pcKey, charName: out.name }, { sev: 'error', code: 'AUDIT_FAIL', cat: 'runtime', msg: '실행 점검 중 예외 (엔진 또는 점검 도구)', evidence: String(e && e.stack || e).slice(0, 400), conf: 'low' })); }
    }
    if (opts.includeRuntime && opts.descMatch !== false) {
      try { descMatch(pcKey, out, desc); }
      catch (e) { out.findings.push(mkFinding({ char: pcKey, charName: out.name }, { sev: 'info', code: 'AUDIT_FAIL', msg: '설명 대조 중 예외', evidence: String(e && e.stack || e).slice(0, 300), conf: 'low' })); }
    }
    out.findings.sort((a, b) => A.SEV_ORDER[a.sev] - A.SEV_ORDER[b.sev] || (a.skill || '').localeCompare(b.skill || '') || (a.effect || '').localeCompare(b.effect || ''));
    out.counts = countSev(out.findings);
    out.verdict = out.counts.error ? 'error' : out.counts.suspect ? 'suspect' : 'ok';
    out.ms = Date.now() - t0;
    return out;
  };
  function countSev(fs) { const c = { error: 0, suspect: 0, unverified: 0, simlimit: 0, info: 0 }; for (const f of fs) c[f.sev]++; return c; }

  A.summarize = function (results) {
    const s = { chars: results.length, ok: 0, suspectChars: 0, errorChars: 0, unverifiedChars: 0, findings: { error: 0, suspect: 0, unverified: 0, simlimit: 0, info: 0 }, byCode: {} };
    for (const r of results) {
      if (r.verdict === 'error') s.errorChars++; else if (r.verdict === 'suspect') s.suspectChars++; else s.ok++;
      if (r.counts.unverified) s.unverifiedChars++;
      s.displayOnlySlots = (s.displayOnlySlots || 0) + (r.displayOnlySlots || 0);
      for (const f of r.findings) { s.findings[f.sev]++; const k = f.sev + ':' + f.code; s.byCode[k] = (s.byCode[k] || 0) + 1; }
    }
    return s;
  };

  A.CODE_KO = {
    NO_PC: 'PC 행 없음', NO_SKILLGROUP: '스킬 그룹 없음', NO_SKILL: '스킬 행 없음', MAXLV_ZERO: '최대 레벨 0', NO_SKILLLEVEL: '스킬 레벨 행 누락', NO_GRID: 'Grid 없음', NO_BUFF: '버프 키 없음', NO_SUMMON: '소환물 없음',
    GRADE_UNREACHABLE: '해금 불가 스킬', SLOT_DUP: '슬롯 중복', SKILL_BUFFRATE0: '스킬 버프 확률 0', USEAVAIL_NONE: '버프 사용 불가 레벨', LV_KEYS_DIFF: '레벨별 버프 목록 변경', ATKRATE_DROP: '계수 감소',
    RATE0_SLOT: '확률 0 효과 슬롯', SIM_TODO: '시뮬레이터 미지원', CLIENT_NOOP: '클라이언트 미처리 효과', DUP_SLOT: '중복 슬롯',
    DESC_ROUND: '설명-지속 라운드 불일치', DESC_PROB: '설명-확률 불일치', DESC_SPLASH: '설명-범위 피해 불일치', DESC_STACK: '설명-중첩 불일치', DESC_GRID_LV: '설명-레벨별 범위 불일치', DESC_RANGE_LV: '설명-레벨별 사거리 불일치', DESC_ACC: '설명-적중 보정 불일치',
    BUILD_FAIL: '생성 실패', RT_STUCK: '진행 불가', RT_EXCEPTION: '엔진 예외', RT_COUNTER_NULL: '반격 null', RT_NO_ACTION: '행동 없음', RT_DIED: '점검 중 사망', RT_SKILL_UNUSED: '스킬 미사용', RT_NO_DAMAGE: '피해 기록 없음', RT_ZERO_DAMAGE: '피해 0',
    RT_MIN_DAMAGE: '최소 피해 반복', RT_NO_SUMMON: '소환 실패', RT_COOLDOWN_STUCK: '쿨타임 고정', RT_SIM_TODO: '미지원 효과', RT_AP_NOEFFECT: 'AP 변화 없음', RT_SLOT_NEVER: '슬롯 미적용', RT_NOT_APPLIED: '효과 미적용', RT_COND_FAIL: '조건 미충족',
    RT_RATE_MISS: '확률 미당첨', RT_TARGET_TYPE: '대상 타입 없음', RT_NO_EFFECT: '효과 없음', DESC_EFFECT_MISSING: '설명 효과 없음(데이터)', DESC_EFFECT_UNSEEN: '설명 효과 미관측', RT_PROMO_OFF: '승급으로 대체·비활성', RT_VIA_OTHER: '다른 스킬 효과로 적용', PROMO_REPLACE: '승급 시 효과 대체', RT_DELAY_NO_HIT: '지연 스킬 미착탄', RT_STALL: '사거리 밖 대기', RT_COUNTER_NULL_ENEMY: '적 반격 null 유발',
    PASSIVE_ACTIVE_TRIGGER: '패시브에 액티브 전용 트리거', DANGLING_REF: '없는 키 참조', DESC_SUMMON: '설명-소환 불일치', RT_TRIGGER_NO_APPLY: '트리거 후 미적용', RT_TRIGGER_NONE: '트리거 상황 없음', RT_TRIGGER_NEVER: '트리거 미발동', AUDIT_FAIL: '점검 도구 예외',
  };

  // ================================================================== Markdown report
  const mdEsc = (s) => String(s == null ? '' : s).replace(/\|/g, '\\|').replace(/\n/g, ' ');
  A.markdown = function (results, info) {
    info = info || {};
    const s = A.summarize(results);
    const o = info.opts || {};
    const maxRows = info.maxRows || 400;
    const L = [];
    L.push('# 캐릭터 점검 리포트');
    L.push('');
    L.push(`- 생성: ${info.generatedAt || new Date().toISOString()}${info.meta ? ` · 데이터 r${info.meta.dataRevision} (${info.meta.extractedAt}) · 전투 로직 r${info.meta.logicPortRevision} 기준` : ''}`);
    L.push(`- 조건: 등급 ${o.grade === 'max' || !o.grade ? '최대' : o.grade} · 레벨 ${o.level || 90} · 스킬 레벨 ${o.skillLevel || 10} · 장비 없음 · 정적 점검 ${o.includeStatic === false ? '끔' : '켬'} · 실행 점검 ${o.includeRuntime === false ? '끔' : `켬 (전투원당 행동 ${o.actions || 42}회, 단독 전열 / 분대 중열 / 분대 후열)`}`);
    L.push(`- 결과: 전투원 ${s.chars}명 · 정상 ${s.ok} · 의심 ${s.suspectChars} · 오류 ${s.errorChars} · 미확인 항목이 있는 전투원 ${s.unverifiedChars}`);
    L.push(`- 항목 수: 오류 ${s.findings.error} · 의심 ${s.findings.suspect} · 미확인 ${s.findings.unverified} · 시뮬레이터 한계 ${s.findings.simlimit} · 참고 ${s.findings.info}`);
    if (s.displayOnlySlots) L.push(`- 참고: 적용 확률 0인 효과 슬롯 ${s.displayOnlySlots}개는 실제 효과를 다른 곳(같은 행의 다른 슬롯, 하위 행, 트리거·조건으로 연결된 버프, 같은 전투원·소환물의 다른 버프)이 적용하고 있어 '표시 전용'으로 보고 의심에서 뺐습니다. 설명이 있는 슬롯은 아래 '표시 전용으로 판정한 슬롯' 표에 실제 적용 위치와 함께 남깁니다 (클라이언트는 확률 0 슬롯을 적용하지 않음, Creature.cs:3657).`);
    L.push('');
    L.push('심각도: **오류** = 데이터 누락·엔진 예외처럼 클라이언트 크래시/멈춤 후보, **의심** = 기획 의도와 다르게 동작할 가능성이 높음, **미확인** = 점검 시나리오에서 조건이 안 맞아 확인 못 함, **시뮬레이터 한계** = 시뮬레이터가 아직 포팅하지 않은 효과, **참고** = 확인용 정보.');
    L.push('');
    L.push('## 항목 종류별 개수');
    L.push('');
    L.push('| 심각도 | 종류 | 개수 |');
    L.push('|---|---|---:|');
    for (const [k, v] of Object.entries(s.byCode).sort((a, b) => A.SEV_ORDER[a[0].split(':')[0]] - A.SEV_ORDER[b[0].split(':')[0]] || b[1] - a[1])) {
      const [sev, code] = k.split(':');
      L.push(`| ${A.SEV[sev]} | ${A.CODE_KO[code] || code} (${code}) | ${v} |`);
    }
    L.push('');
    const all = [];
    for (const r of results) for (const f of r.findings) all.push(f);
    const top = all.filter((f) => f.sev === 'error' || f.sev === 'suspect').sort((a, b) => A.SEV_ORDER[a.sev] - A.SEV_ORDER[b.sev] || confRank(a.conf) - confRank(b.conf));
    L.push(`## 오류·의심 (${top.length}건${top.length > maxRows ? `, 앞 ${maxRows}건만` : ''})`);
    L.push('');
    L.push('| 심각도 | 신뢰도 | 전투원 | 스킬 | 효과 키 | 내용 | 근거 | 참조 |');
    L.push('|---|---|---|---|---|---|---|---|');
    for (const f of top.slice(0, maxRows)) L.push(`| ${A.SEV[f.sev]} | ${A.CONF[f.conf] || f.conf} | ${mdEsc(f.charName)} (${mdEsc(f.char)}) | ${mdEsc(f.skillName)}${f.skill ? ' `' + mdEsc(f.skill) + '`' : ''} | ${f.effect ? '`' + mdEsc(f.effect) + '`' + (f.slot ? ' #' + f.slot : '') : ''} | ${mdEsc(f.msg)} | ${mdEsc(f.evidence)} | ${mdEsc(f.ref)} |`);
    L.push('');
    const dv = [];
    for (const r of results) for (const v of r.displayVerified || []) dv.push(Object.assign({ charName: r.name || r.charName || r.key, char: r.key }, v));
    if (dv.length) {
      L.push(`## 표시 전용으로 판정한 슬롯 (${dv.length}개, 의심에서 제외)`);
      L.push('');
      L.push('확률 0이라 클라이언트가 적용하지 않지만, 같은 효과를 다른 곳에서 실제로 적용하는 슬롯입니다. 판정이 맞는지 실제 적용 위치로 확인할 수 있습니다.');
      L.push('');
      L.push('| 전투원 | 스킬 | 표시 슬롯 | 효과 | 설명 | 실제 적용 위치 | 판정 근거 |');
      L.push('|---|---|---|---|---|---|---|');
      for (const v of dv.slice(0, maxRows)) L.push(`| ${mdEsc(v.charName)} | ${mdEsc(v.skillName)} | \`${mdEsc(v.effect)}\` #${v.slot} | ${mdEsc(v.type)} | ${mdEsc(v.desc)} | \`${mdEsc(v.carrier)}\` | ${mdEsc(v.where)} · ${mdEsc(v.how)} |`);
      L.push('');
    }
    {
      const dmAll = [];
      for (const r of results) for (const m of r.descMatch || []) dmAll.push(Object.assign({ charName: r.name }, m));
      if (dmAll.length) {
        const vc = {}; for (const m of dmAll) vc[m.verdict] = (vc[m.verdict] || 0) + 1;
        const VK = { match: '설명 효과 모두 확인', partial: '일부 효과는 조건 미충족으로 미관측', missing: '설명 효과를 찾지 못함', 'conditional-only': '조건부 효과만 있어 판단 보류', unused: '사용되지 않음' };
        L.push('## 설명 대조 결과');
        L.push('');
        L.push('스킬 설명에서 효과 문구(데이터의 효과 설명에서 학습한 문구)를 읽어 실제 전투에서 나온 효과와 대조했습니다. 설명의 효과가 모두 확인된 스킬은 확률 0 슬롯·트리거 미발동 같은 구조적 의심을 통과 처리합니다.');
        L.push('');
        L.push(Object.entries(vc).map(([k, v]) => `- ${VK[k] || k}: ${v}개 스킬`).join(String.fromCharCode(10)));
        const miss = all.filter((f) => f.code === 'DESC_EFFECT_MISSING');
        if (miss.length) {
          L.push('');
          L.push(`### 설명 효과를 찾지 못한 스킬 (${miss.length}개) — 의심 ${miss.filter((f) => f.sev === 'suspect').length} / 검토 필요 ${miss.filter((f) => f.sev !== 'suspect').length}`);
          L.push('');
          L.push('| 구분 | 전투원 | 스킬 | 못 찾은 효과 | 근거 |');
          L.push('|---|---|---|---|---|');
          for (const f of miss.slice(0, maxRows)) L.push(`| ${f.sev === 'suspect' ? '의심' : '검토 필요'} | ${mdEsc(f.charName)} | ${mdEsc(f.skillName)} | ${mdEsc((f.msg.split(':').slice(1).join(':') || '').replace(' (설명 문구 해석 한계일 수 있음)', '').trim())} | ${mdEsc(f.evidence)} |`);
        }
        const passed = all.filter((f) => f.passedByDesc);
        if (passed.length) {
          L.push('');
          L.push(`### 설명 대조로 통과 처리한 항목 (${passed.length}개)`);
          L.push('');
          for (const f of passed) L.push(`- ${mdEsc(f.charName)} · ${mdEsc(f.skillName)}: ${mdEsc(f.msg.replace('[설명 대조 통과] ', ''))}`);
        }
        L.push('');
      }
    }
    if (info.includeUnverified !== false) {
      const uv = all.filter((f) => f.sev === 'unverified' || f.sev === 'simlimit');
      const byMsg = {};
      for (const f of uv) { const k = A.SEV[f.sev] + ' · ' + (A.CODE_KO[f.code] || f.code); byMsg[k] = (byMsg[k] || 0) + 1; }
      L.push('## 미확인·시뮬레이터 한계 요약');
      L.push('');
      for (const [k, v] of Object.entries(byMsg).sort((a, b) => b[1] - a[1])) L.push(`- ${k}: ${v}건`);
      L.push('');
    }
    if (info.perCharacter !== false) {
      L.push('## 전투원별 요약');
      L.push('');
      L.push('| 전투원 | 판정 | 오류 | 의심 | 미확인 | 실행(행동/전투) | 스킬 사용 |');
      L.push('|---|---|---:|---:|---:|---|---|');
      for (const r of results) {
        const rt = r.runtime;
        const su = rt ? Object.values(rt.skills).filter((x) => x.type === 0 && (x.slot === 1 || x.slot === 2)).map((x) => `${x.slot}:${x.uses}회/${x.dmg}`).join(' ') : '';
        L.push(`| ${mdEsc(r.name)} (${mdEsc(r.key)}) | ${{ ok: '정상', suspect: '의심', error: '오류' }[r.verdict]} | ${r.counts.error} | ${r.counts.suspect} | ${r.counts.unverified} | ${rt ? rt.subjActions + '/' + rt.battles.length : '-'} | ${su} |`);
      }
      L.push('');
    }
    return L.join('\n');
  };
  const confRank = (c) => ({ high: 0, med: 1, low: 2 }[c] || 3);
  A.confRank = confRank;
})();
