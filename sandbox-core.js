// =====================================================================================================
//  전투 시스템 실험 시뮬레이터 — 핵심(화면과 무관): 배치, 전투 진행, 시험 시스템, 미리보기, 행동 예고.
//  화면(씬·창)은 CORE.on('...') 으로 사건을 받아 그린다.
//
//  - 전투 엔진(engine/*.js)은 기존 시뮬레이터와 같다. battle.js 의 beforeAction 훅(행동 직전 멈춤) 하나만 쓴다.
//  - 시험 시스템을 추가하려면 SYSTEMS 배열에 항목을 넣고 sysOn('아이디')로 분기한다. 엔진은 건드리지 않는다.
//  - 클라이언트 QA 빌드의 Panel_StageBattle.EnemyPredict / SkillPreview / EnemyActionLock 과 같은 표시·규칙을 따른다.
// =====================================================================================================
(function () {
  const L = window.LOSim;
  const num = L.num, str = L.str, list = L.list;
  const E = L.E, BT = E.BUFFEFFECT_TYPE, TT = E.TARGET_TYPE, AT = E.ACTOR_ATTR_TYPE, VT = E.VALUE_TYPE, SA = E.SKILL_ATTR, AC = E.ACTOR_CLASS, ATT = E.ATTACKTARGETTYPE;
  const WAIT = 'Wait', MOVE = 'Move';
  const OUT_KO = { win: '승리', lose: '패배', stuck: '진행불가', error: '오류(크래시)', timeout: '시간초과' };
  const ROLE_KO = ['보호기', '공격기', '지원기'], CLASS_KO = ['경장', '중장', '기동'];
  const TT_KO = { 0: '자신', 1: '아군 1명', 2: '아군 범위(칸)', 3: '적 1명', 4: '적 범위(칸)', 5: '전체', 6: '전체 범위', 7: '시스템', 8: '아군 전체', 9: '적 전체' };
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  const store = {
    get(k) { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* 저장 불가 */ } },
  };
  const KEY_SETUP = 'lo-sandbox-setup-v2', KEY_SYS = 'lo-sandbox-systems-v3', KEY_VERDICT = 'lo-sandbox-verdicts-v1';

  // ---------------------------------------------------------------- 사건
  const handlers = {};
  const on = (evt, fn) => { (handlers[evt] = handlers[evt] || []).push(fn); };
  const emit = (evt, data) => { for (const fn of handlers[evt] || []) { try { fn(data); } catch (e) { console.error('[' + evt + ']', e); } } };

  // ---------------------------------------------------------------- 시험 시스템 등록표
  const SYSTEMS = [
    { id: 'manual', name: '아군 수동 조작 (AUTO 끔)', on: true, builtin: true,
      desc: '인게임 수동 전투: 아군 턴이 오면 1번 스킬이 자동 선택되어 대상 후보가 표시되고, 대상을 찍으면 승인 버튼(승인 즉시 실행), 이동·대기는 행동 개시 버튼으로 실행합니다. 끄면 씬 오른쪽 위 AUTO 와 같이 자동 전투가 고릅니다.' },
    { id: 'preview', name: '스킬 효과 미리보기', test: true, on: true,
      desc: '대상을 선택하면 승인 버튼 옆에 예상 피해·남는 체력·명중·치명타·함께 맞는 대상·적용 효과를 표시합니다.' },
    { id: 'intent', name: '적 행동 예측 표시', test: true, on: true,
      desc: '적이 다음에 사용할 스킬과 공격 대상을 표시합니다. 턴바에는 스킬 아이콘을, 대상 머리 위에는 적 이름과 스킬명을 표시합니다.',
      opts: [{ id: 'lock', name: '예고한 적 행동 유지', on: true, desc: '켜면 적이 예고한 행동을 실행합니다. 대상이 사라지면 같은 스킬로 가장 가까운 대상을 선택하고, 대상이 없으면 대기합니다. 끄면 차례가 왔을 때 행동이 달라질 수 있습니다.' }] },
    { id: 'skillApReturn', name: '스킬 소모 행동력에 따른 재출발', test: true, on: false,
      desc: '스킬 사용 후 턴이 끝나면 10에서 소모 행동력을 뺀 값에 해당하는 위치에서 다시 시작합니다. 소모 3이면 7(70%), 소모 5이면 5(50%), 소모 8이면 2(20%)입니다. 끄면 기존 전투 규칙을 사용합니다. 아군과 적에게 모두 적용되며 이동·대기는 기존 방식입니다.' },
    { id: 'skillReturnPreview', name: '스킬별 재출발 위치 미리보기', test: true, on: false,
      desc: '스킬 소모 행동력에 따른 재출발 실험을 함께 켜면, 선택한 스킬 사용 후 돌아갈 위치를 턴바의 하늘색 점선과 백분율로 표시합니다. 스킬에 지정된 소모량 기준이며 별도 행동력 효과는 포함하지 않습니다.' },
    { id: 'slotCooldown', name: '스킬 쿨타임 적용', test: true, on: false,
      desc: '켜면 아군과 적의 1번 스킬은 재사용 대기 없이 사용하고, 2번 스킬은 지정된 재사용 대기를 적용합니다. 끄면 두 스킬 모두 기존 설정을 따릅니다.' },
    { id: 'actAfterMove', name: '이동 후 행동 가능', test: true, on: false,
      desc: '켜면 이동 후 턴을 끝내지 않고 같은 전투원이 스킬 또는 대기를 한 번 더 선택합니다. 한 턴에 이동은 한 번만 가능하며 아군과 적 모두 적용됩니다. 끄면 이동 즉시 턴을 종료합니다.' },
    { id: 'waitHeal', name: '대기 시 회복', test: true, on: false,
      desc: '켜면 아군과 적이 대기할 때 체력의 일부를 회복하고 AP를 모두 소진합니다. 전투원별 누적 대기 횟수에 따라 최대 체력의 20% → 15% → 10% → 5% → 2.5% → 1.25% → 1%를 회복하며, 이후에는 0.5% → 0.25%처럼 절반씩 줄어듭니다. 대기 횟수는 새 전투를 시작하면 초기화됩니다. 끄면 기존 대기 규칙을 사용합니다.' },
    { id: 'moveConfirm', name: '이동 위치에서 승인', test: true, on: false,
      desc: '켜면 이동할 칸을 선택했을 때 그 위치에 승인 버튼을 표시하고 행동 개시 버튼은 숨깁니다. 승인을 누르면 이동합니다. 끄면 기존 행동 개시 방식으로 이동합니다.' },
    // 기본 기능(실험 대상 아님): 창에 표시하지 않는다
    { id: 'sd', name: 'SD 캐릭터 표시', on: true, builtin: true,
      desc: '라켓몬스터 방식으로 원작 SD 리그를 재생합니다(바이오로이드 206종·철충 23종). 리그가 없는 유닛은 이름표로 표시됩니다.',
      opts: [{ id: 'flipAlly', name: '아군 좌우 반전', on: false }, { id: 'flipEnemy', name: '적 좌우 반전', on: false }] }, // 기본: 아군은 오른쪽(적 쪽)을 본다
    { id: 'hud', name: '유닛 정보 표시', on: true, builtin: true, desc: '유닛 발밑에 체력 막대와 이름·레벨을, 턴 순서 바에 행동력 게이지를 표시합니다(원작 UICreatureInfo / UIBattleCreature 구성).',
      opts: [{ id: 'names', name: '이름·레벨 표시', on: true }, { id: 'apBars', name: '턴 순서 바에 행동력 게이지', on: true }] },
  ];
  const SYS = Object.fromEntries(SYSTEMS.map((s) => [s.id, s]));
  const sysOn = (id) => !!(SYS[id] && SYS[id].on);
  const optOn = (id, oid) => { if (id === 'preview' && oid === 'exact') return sysOn('preview'); const s = SYS[id]; const o = s && (s.opts || []).find((x) => x.id === oid); return !!(s && s.on && o && o.on); };
  const VERDICTS = ['미정', '추가 찬성', '추가 반대', '보류(수정 필요)'];
  let verdicts = store.get(KEY_VERDICT) || {};
  function restoreSystems() {
    const saved = store.get(KEY_SYS) || {};
    for (const s of SYSTEMS) { const v = saved[s.id]; if (!v) continue; if (typeof v.on === 'boolean') s.on = v.on; for (const o of s.opts || []) if (v.opts && typeof v.opts[o.id] === 'boolean') o.on = v.opts[o.id]; }
  }
  function saveSystems() { const o = {}; for (const s of SYSTEMS) o[s.id] = { on: s.on, opts: Object.fromEntries((s.opts || []).map((x) => [x.id, x.on])) }; store.set(KEY_SYS, o); }

  // ---------------------------------------------------------------- 데이터 색인
  let PCS = [], PCMAP = {}, MOBS = [], MOBMAP = {}, ICONS = { skill: {}, buff: {}, stageBG: {}, mobTbar: {}, pcTbar: {}, buffDesc: {} }, SPRITES = {};
  function buildIndexes() {
    const T = (t) => L.T(t) || {};
    PCS = Object.values(T('Table_PC')).filter((p) => num(p, 'IsUse') === 1 && num(p, 'IsHavingTurn') === 1)
      .map((p) => ({ key: p.Key, name: L.name(p.Name, p.Key), startGrade: num(p, 'StartGrade', 1), maxGrade: num(p, 'MaxGrade', 5), cls: num(p, 'ActorClassType'), role: num(p, 'RoleType'), rig: !!(window.SDL && SDL.rigOf({ type: 'CHARACTER', key: p.Key })) }))
      .filter((p) => !/Dummy|Test/i.test(p.key) && !/더미|테스트/.test(p.name))
      .sort((a, b) => (b.rig - a.rig) || a.name.localeCompare(b.name, 'ko'));
    PCMAP = Object.fromEntries(PCS.map((p) => [p.key, p]));
    MOBS = Object.values(T('Table_Monster')).filter((m) => num(m, 'IsUse', 1) === 1 && str(m, 'SkillGroupIndex'))
      .map((m) => ({ key: m.Key, name: L.name(m.Name, m.Key), ai: str(m, 'AIKeyString'), grade: num(m, 'StartGrade'), cls: num(m, 'ActorClassType'), role: num(m, 'RoleType'), rig: !!(window.SDL && SDL.rigOf({ type: 'MONSTER', key: m.Key })) }))
      .sort((a, b) => (b.rig - a.rig) || a.name.localeCompare(b.name, 'ko') || a.key.localeCompare(b.key));
    MOBMAP = Object.fromEntries(MOBS.map((m) => [m.key, m]));
  }
  const pcName = (k) => (PCMAP[k] || {}).name || k;
  const mobName = (k) => (MOBMAP[k] || {}).name || L.name((L.T('Table_Monster', k) || {}).Name, k);
  const unitName = (u) => (u ? (u.name || u.key) : '-');
  const skillName = (key) => { const t = key && L.T('Table_Skill', key); return t ? L.name(t.SkillName, key) : key || ''; };
  const buffName = (key) => { const t = key && L.T('Table_BuffEffect', key); return t ? L.name(t.Name, '효과') : '효과'; };
  const slotOf = (s) => (s.slot !== undefined && s.slot !== null ? s.slot : num(s.table, 'SkillSlotType'));
  const cooldownTurns = (s) => sysOn('slotCooldown') && slotOf(s) === 1 ? 0 : Math.max(0, num(s.levelTable, 'CooldownTurn'));
  const activeSkills = (u) => (u.skills || []).filter((s) => slotOf(s) === 1 || slotOf(s) === 2).sort((a, b) => slotOf(a) - slotOf(b));
  const alive = (u) => u && u.hp > 0 && !u.removed;
  const isPC = (u) => u.type === 'CHARACTER';
  const isMob = (u) => u.type === 'MONSTER';
  const speedOf = (u) => L.stats.getTurnSpeed(u);
  const hasB = (u, name) => { const t = BT[name]; return t !== undefined && !!L.buffs.has(u, t); };
  const skillIcon = (key) => (key === WAIT ? 'SkillIconCircle_Wait' : key === MOVE ? 'SkillIconCircle_Move' : ICONS.skill[key] || 'SkillIconCircle_None');
  const tbarIcon = (u) => (isPC(u) ? ICONS.pcTbar[u.key] : isMob(u) ? ICONS.mobTbar[u.key] : '') || '';

  // ---------------------------------------------------------------- 상태
  const DEFAULT_ALLY = [['Char_BR_PA00EL_N', 5], ['Char_BR_Amy_N', 2], ['Char_PECS_MightyR_N', 8], ['Char_3P_ConstantiaS2_N', 4], ['Char_3P_Daphne_N', 1]];
  const DEFAULT_ENEMY = [['MOB_MP_NightChick_N', 0], ['MOB_MP_NightChick_N', 6], ['MOB_MP_BigChick_N', 3], ['MOB_MP_Legion_N', 2], ['MOB_MP_Legion_N', 8]];
  const setup = { ally: {}, enemy: {}, seed: 1, maxActions: 2000, speed: 1, bg: 'route', aspect: 2340, autoResolution: true }; // 원작 UI 는 긴 화면(19.5:9) 기준으로 배치되어 있다
  const S = { battle: null, lastLog: 0, pending: null, pendingSel: null, manual: null, preview: null, lastPreview: null, forcePause: false,
    playing: false, timer: null, intents: new Map(), dryRun: false, anims: new Map(), log: [], lastAction: null, result: null };

  function makeRng(seed) { // 엔진과 같은 mulberry32, 상태를 읽고 되돌릴 수 있게
    let a = seed >>> 0;
    const r = () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    r.int = (n) => Math.floor(r() * n); r.chance = (p) => r() < p;
    Object.defineProperty(r, 'state', { get: () => a, set: (v) => { a = v >>> 0; } });
    return r;
  }

  // ---------------------------------------------------------------- 배치
  function defaultSetup() {
    setup.ally = {}; setup.enemy = {};
    for (const [k, pos] of DEFAULT_ALLY) if (PCMAP[k]) setup.ally[pos] = Object.assign(L.stats.defaultSpec(k) || { key: k, grade: 3, skillLevels: [] }, { level: 50, skillLevels: new Array(((L.stats.defaultSpec(k) || {}).skillLevels || []).length || 5).fill(5) });
    for (const [k, pos] of DEFAULT_ENEMY) if (L.T('Table_Monster', k)) setup.enemy[pos] = { key: k, level: 70 };
  }
  function saveSetup() { store.set(KEY_SETUP, { ally: setup.ally, enemy: setup.enemy, seed: setup.seed, maxActions: setup.maxActions, speed: setup.speed, bg: setup.bg, aspect: setup.aspect, autoResolution: setup.autoResolution }); emit('setup'); }
  function restoreSetup() {
    const s = store.get(KEY_SETUP); if (!s) return false;
    const al = {}; for (const [p, v] of Object.entries(s.ally || {})) if (v && PCMAP[v.key] && +p >= 0 && +p <= 8) al[p] = v;
    const en = {}; for (const [p, v] of Object.entries(s.enemy || {})) if (v && L.T('Table_Monster', v.key) && +p >= 0 && +p <= 8) en[p] = v;
    if (!Object.keys(al).length && !Object.keys(en).length) return false;
    setup.ally = al; setup.enemy = en; if (s.seed) setup.seed = +s.seed; if (s.maxActions) setup.maxActions = +s.maxActions; if (s.speed) setup.speed = +s.speed; if (s.bg) setup.bg = s.bg; if (s.aspect) setup.aspect = +s.aspect; setup.autoResolution = s.autoResolution !== false;
    return true;
  }
  function newAllySpec(k, level) { return Object.assign(L.stats.defaultSpec(k) || { key: k, grade: 1, skillLevels: [] }, { level: level || 50, skillLevels: ((L.stats.defaultSpec(k) || {}).skillLevels || [1]).map(() => 5) }); }
  const squadSpecs = () => Object.entries(setup.ally).map(([pos, s]) => Object.assign({}, L.stats.defaultSpec(s.key) || { key: s.key }, s, { gridPos: +pos }));
  const enemyWave = () => Object.entries(setup.enemy).map(([pos, e]) => ({ key: e.key, level: e.level || 1, gridPos: +pos }));

  // ---------------------------------------------------------------- 전투 진행
  function logLine(kind, html) { const d = document.createElement('div'); d.innerHTML = html; const text = d.textContent; S.log.unshift({ kind, html, text, t: Date.now() }); if (S.log.length > 500) S.log.length = 500; emit('log', { kind, html, text }); }
  function startBattle() {
    if (!Object.keys(setup.ally).length) { emit('status', '아군을 1명 이상 배치하세요.'); return false; }
    if (!Object.keys(setup.enemy).length) { emit('status', '몬스터를 1마리 이상 배치하세요.'); return false; }
    resetBattle(true);
    const seed = +setup.seed || 1;
    const b = L.battle.create({ stageKey: null, mode: 'stage', squad: squadSpecs(), seed, logEnabled: true, customWaves: [enemyWave()], options: { maxActions: +setup.maxActions || 2000 } });
    b.rng = makeRng(seed);
    b.hooks = { beforeAction, skillApReturn: () => sysOn('skillApReturn'), cooldownTurns, actAfterMove: () => sysOn('actAfterMove'), waitHeal: () => sysOn('waitHeal') };
    S.battle = b; S.lastLog = 0; S.forcePause = true; S.log = []; S.result = null;
    if (b.result === 'error') { logLine('issue', '<b>전투를 시작하지 못했습니다. 배치를 확인하고 다시 시작해 주세요.</b>'); emit('battle'); return false; }
    logLine('stage', `<b>전투 시작</b><div class="why">아군: ${esc(squadSpecs().map((s) => `${pcName(s.key)} 레벨 ${s.level}`).join(', '))}\n적: ${esc(enemyWave().map((m) => `${mobName(m.key)} 레벨 ${m.level}`).join(', '))}\n시험 시스템: ${SYSTEMS.filter((s) => s.on && !s.builtin).map((s) => s.name + (s.opts || []).filter((o) => o.on).map((o) => `(${o.name})`).join('')).join(', ') || '없음'}</div>`);
    emit('battle');
    advance();
    if (S.battle && !S.battle.result) startPlay(); // 인게임처럼 전투는 바로 진행되고, 아군 턴(수동)에서만 멈춘다
    return true;
  }
  function resetBattle(silent) {
    stopPlay();
    if (S.battle && window.SDL) for (const u of S.battle.allUnits || []) SDL.release(u);
    S.battle = null; S.pending = null; S.pendingSel = null; S.manual = null; S.preview = null; S.lastPreview = null; S.intents = new Map(); S.anims = new Map(); S.lastAction = null; S.result = null; S.apAnim = null;
    if (!silent) { S.log = []; logLine('stage', '초기화했습니다. 전투 시작을 누르세요.'); }
    emit('battle');
  }
  function beforeAction(b, turn) { // 엔진 훅: 확정된 행동자가 행동하기 직전
    const u = turn && turn.creature;
    if (S.forcePause) return true;
    if (!u || turn.isReserve) return false;
    if (sysOn('manual') && isPC(u)) return true;
    if (S.playing) return true; // 자동 진행: 인게임처럼 행동력 연출 → 라운드 시작 대기 → 행동 순서로 멈춰서 시간을 맞춘다
    if (sysOn('preview') || sysOn('intent')) return true; // 단계 진행: 행동 직전에 멈춰 예측·선택을 볼 수 있게
    if (sysOn('intent') && isMob(u) && !S.playing) return true;
    return false;
  }
  function advance() {
    const b = S.battle; if (!b || b.result) return null;
    const rec = L.battle.step(b);
    const logs = b.log.slice(S.lastLog); S.lastLog = b.log.length;
    for (const e of logs) if (e.t === 'wave') logLine('stage', `웨이브 ${e.wave} 시작 · 몬스터 ${e.monsters.length}마리`);
    if (rec.type === 'input') {
      // 인게임 순서: 라운드 시작 대기(1초) → 행동력 연출(진입 → 경주 → 유지 → 줄 세우기 → 1등 칸) → 행동
      const pres = apPresentation(b, rec.turn);
      S.apAnim = { t0: performance.now() + (pres.total > 0 ? ROUND_START_WAIT * timeScale() * 1000 : 0), phases: pres.phases, total: pres.total, round: b.round };
      onInput(rec);
    }
    else if (rec.type === 'action') onAction(rec, logs);
    if (b.result) onEnd();
    refreshIntents();
    emit('battle');
    return rec;
  }
  function go() { // 멈춘 상태를 풀고 행동 실행(수동 선택이 있으면 그 선택으로)
    const b = S.battle; if (!b || !S.pending) return null;
    if (S.manual) { if (!S.manual.sel) return null; const u = S.manual.unit; u.reserveSkillList.length = 0; u.reserveSkillList.push(S.manual.sel); }
    S.pending = null; S.manual = null; S.preview = null;
    L.battle.resume(b);
    return advance();
  }
  // 행동 직전 유닛이 실제로 쓸 선택. 아군은 라운드 시작 때 고른 것, 몬스터·소환수는 턴에서 AI를 다시 돌리므로(원본) 지금 난수 상태로 미리 돌린 결과(고정 중이면 고정된 행동).
  function upcomingSel(u) {
    const cur = u.reserveSkillList && u.reserveSkillList[0];
    if (isPC(u)) return cur || null;
    if (optOn('intent', 'lock') && u.lockedIntent) return resolveLocked(S.battle, u, u.lockedIntent);
    return computeIntent(S.battle, u) || cur || null;
  }
  function onInput(rec) {
    S.forcePause = false; S.pending = rec;
    const u = rec.unit; if (!u) return;
    S.pendingSel = upcomingSel(u);
    if (sysOn('manual') && isPC(u)) {
      S.manual = { unit: u, skill: null, sel: null, mode: null, cands: null, hover: null, needPlay: false };
      S.preview = null;
      emit('input', rec);
      autoSelectFirstSkill(u);
      return;
    }
    else { S.manual = null; const sel = S.pendingSel; const pv = sysOn('preview') && sel && sel.skillKey && sel.skillKey !== WAIT && sel.skillKey !== MOVE ? estimateSel(u, sel) : null; S.preview = null; S.lastPreview = pv ? Object.assign({ aid: u.aid }, pv) : null; emit('input', rec); return; }
    S.lastPreview = S.preview ? Object.assign({ aid: u.aid }, S.preview) : null;
    emit('input', rec);
  }
  // ---- 연출 시간 (클라이언트 Panel_StageBattle.coTurnApEffectEndCheck → coArrangeApTrackSlots / BattleState_RoundStarting 1초 대기)
  //  진입 _turnApTrackEntryDuration 0.3초 → 경주 (전투 계산 시간 × _turnApSimulationTimeScale 0.2, 최소 0.15초, 최대 2초)
  //  → 유지 _turnApTrackHoldDuration 0.35초 → 줄 세우기 _turnApSlotArrangeDuration 0.25초 → 1등 칸 이동 0.25초
  const SPEED_SCALE = { 1: 1, 2: 0.5, 3: 0.2, 4: 0 };
  const timeScale = () => (SPEED_SCALE[+setup.speed] !== undefined ? SPEED_SCALE[+setup.speed] : 1);
  const AP_PRESENT = { entry: 0.3, hold: 0.35, arrange: 0.25 };
  function apAdvanceDuration(b) { const t = (b && b.s && b.s.apAdvance) || 0; return t > 0 ? Math.min(2, Math.max(0.15, t * 0.2)) : 0.15; }
  // 전투 계산과 같이, 연출 시작 시점에 이미 행동력이 가득 찬 행동 가능 유닛(또는 준비된 예약 공격)이 있으면 경주를 생략한다
  function apRaceSkipped(b) {
    const pre = (u) => (u.preTurnPos === undefined ? u.turnPos : u.preTurnPos);
    if (b.units.some((u) => alive(u) && !u.removed && pre(u) >= 100 && speedOf(u) > 0 && !hasB(u, 'STAGE_AP_STOP'))) return true;
    return (b.reserveSkills || []).some((r) => r.owner && alive(r.owner) && (r.previousActionPoint || 0) >= 100);
  }
  // 이번 라운드 행동력 연출의 단계 목록(밀리초). 화면(sandbox-scene drawTrack)이 단계별로 칸 위치를 계산한다
  function apPresentation(b, turn) {
    const k = timeScale() * 1000, phases = [];
    if (turn && turn.isMoveFollowup) return { phases, total: 0 }; // 이동 후 행동(실험 시스템)은 연출 없이 이어짐
    if (!apRaceSkipped(b)) phases.push({ name: 'entry', dur: AP_PRESENT.entry * k }, { name: 'advance', dur: apAdvanceDuration(b) * k }, { name: 'hold', dur: AP_PRESENT.hold * k });
    phases.push({ name: 'lineup', dur: AP_PRESENT.arrange * k }, { name: 'final', dur: AP_PRESENT.arrange * k });
    return { phases, total: phases.reduce((a, p) => a + p.dur, 0) };
  }
  const ROUND_START_WAIT = 1.0;
  function animDuration(u, name) { try { const c = u._sd && u._sd.tpl.data.clips[name]; if (c && c.dur) return c.dur; } catch (e) { /* 리그 없음 */ } return name === 'move' ? 0.7 : name === 'wait' ? 0.6 : 1.5; }
  // coBottomSkillActive: 자동 전투가 아니면 1번 스킬(쿨다운이면 2번)을 자동으로 눌러 대상 후보를 띄운다. 봉인이면 선택하지 않는다.
  function autoSelectFirstSkill(u) {
    if (hasB(u, 'STAGE_SEAL_SKILL')) return;
    const sks = activeSkills(u);
    const s1 = sks.find((s) => slotOf(s) === 1), s2 = sks.find((s) => slotOf(s) === 2);
    if (s1 && !(s1.cooldownLeft > 0)) manualChooseSkill(s1);
    else if (s2 && !(s2.cooldownLeft > 0)) manualChooseSkill(s2);
  }
  function onAction(rec, logs) {
    const b = S.battle, a = byAid(rec.actor && rec.actor.aid); if (!a) return;
    const info = narrate(rec, logs, a);
    const animName = rec.kind === 'skill' ? (rec.slot === 1 ? 'atk' : 'skill') : rec.kind === 'move' ? 'move' : 'wait';
    info.animDur = animDuration(a, animName) * timeScale(); // 초
    info.hitDelay = rec.kind === 'skill' ? info.animDur * 0.45 : 0; // 피해 숫자·체력 반영 시점(동작 중간)
    info.t0 = performance.now();
    if (rec.kind === 'skill') S.anims.set(a.aid, { name: rec.slot === 1 ? 'atk' : 'skill' });
    else if (rec.kind === 'move') S.anims.set(a.aid, { name: 'move', until: performance.now() + 700 });
    for (const e of logs) {
      if (e.t === 'hit' && e.dst) { const an = S.anims.get(e.dst.aid) || {}; if (an.name !== 'die') { an.tintUntil = performance.now() + 350; S.anims.set(e.dst.aid, an); } }
      if ((e.t === 'kill' || e.t === 'death') && e.dst) S.anims.set(e.dst.aid, { name: 'die', startedAt: info.t0 + info.hitDelay * 1000 });
    }
    for (const u of b.units) if (u.hp <= 0 && !(S.anims.get(u.aid) || {}).name && !u._deadShown) { u._deadShown = true; S.anims.set(u.aid, { name: 'die', startedAt: info.t0 + info.hitDelay * 1000 }); }
    if (isMob(a) && rec.turnType === 'normal') {
      const it = S.intents.get(a.aid);
      if (it && sysOn('intent')) { const same = describeSel(a, it) === describeAction(rec); logLine('sys', `<b>적 행동 예측 ${same ? '<span class="ok">일치</span>' : '<span class="warn">불일치</span>'}</b> ${esc(unitName(a))}: 예측 "${esc(describeSel(a, it))}" → 실제 "${esc(describeAction(rec))}"${optOn('intent', 'lock') ? ' · 고정 적용' : ' · 행동 변경 가능'}`); }
      a.lockedIntent = null; S.intents.delete(a.aid); // EnemyActionLock.OnRealTurn → Forget
    }
    // 실제 실행 기록에서 방향 표시용 대상 수집. 보호·회피·회복·효과 대상도 포함한다.
    const routes = new Map();
    const addRoute = (aid, kind) => { if (aid == null) return; const key = String(aid); if (!routes.has(key)) routes.set(key, { aid, kind }); };
    for (const e of logs) {
      if (e.src && e.src.aid === a.aid && e.dst && ['hit', 'miss', 'heal'].includes(e.t)) addRoute(e.dst.aid, e.t);
      if (e.t === 'buff' && e.op === 'apply' && e.from === a.aid) addRoute(e.unit, 'effect');
    }
    if (rec.kind === 'skill' && !routes.size && rec.target) addRoute(rec.target.aid, 'effect');
    info.routes = [...routes.values()];
    S.lastPreview = null; S.lastAction = info;
    emit('action', info);
  }
  function onEnd() {
    const b = S.battle; if (!b || b._ended) return; b._ended = true;
    stopPlay();
    const r = L.battle.result(b); S.result = r;
    logLine('stage', `<b class="${{ win: 'ok', lose: 'bad', stuck: 'warn', error: 'bad', timeout: 'warn' }[r.outcome] || ''}">${OUT_KO[r.outcome] || '전투 종료'}</b> · 행동 ${r.totalActions}`);
    if (r.outcome === 'win') for (const u of b.units) if (isPC(u) && alive(u)) S.anims.set(u.aid, { name: 'win' });
    emit('end', r);
  }
  function loop() {
    if (!S.playing) return;
    const b = S.battle; if (!b || b.result) { stopPlay(); return; }
    let rec;
    // 수동 전투에서는 아군의 대상 선택을 기다리고, 자동 전투에서는 계속 진행한다.
    if (S.pending) { if (S.manual && !S.manual.sel) { stopPlay(); emit('status', '아군 수동 조작: 스킬과 대상을 선택하세요.'); return; } rec = go(); }
    else rec = advance();
    if (!S.playing) return;
    if (S.manual && !S.manual.sel) { stopPlay(); return; }
    let d = 0;
    if (rec && rec.type === 'input') d = ROUND_START_WAIT * timeScale() * 1000 + (S.apAnim ? S.apAnim.total : 0); // 라운드 시작 대기 + 행동력 연출 전체
    else if (rec && rec.type === 'action') d = (S.lastAction ? S.lastAction.animDur : 1.5) * 1000; // 행동 동작이 끝날 때까지
    S.timer = setTimeout(loop, d);
  }
  // 수동 조작 중 아군 입력을 기다리는 상태에서 '자동 진행'·'다음 행동'을 누르면, 그 유닛은 라운드 시작 때 자동 전투가 고른 행동으로 실행한다(인게임 AUTO 와 같음)
  function resolveManualByAI() {
    const m = S.manual; if (!m || m.sel) return false;
    const sel = S.pendingSel || upcomingSel(m.unit); if (!sel) return false;
    m.sel = sel; m.needPlay = false; S.preview = null;
    logLine('sys', `${esc(unitName(m.unit))}: 버튼으로 진행 → 자동 전투 선택(${esc(describeSel(m.unit, sel))})으로 실행`);
    emit('manual'); return true;
  }
  function startPlay() { if (!S.battle || S.battle.result || S.playing) return; S.playing = true; emit('battle'); loop(); }
  function stopPlay() { S.playing = false; if (S.timer) { clearTimeout(S.timer); S.timer = null; } emit('battle'); }
  function stepOnce() {
    if (!S.battle || S.battle.result) return;
    if (S.pending) { if (S.manual && !S.manual.sel && !resolveManualByAI()) { emit('status', '스킬 버튼을 누르고 대상을 찍은 뒤 승인하세요.'); return; } go(); }
    else advance();
  }

  // ---------------------------------------------------------------- 적 행동 예측 / 고정 (EnemyPredict + EnemyActionLock)
  const origPM = L.ai.processMonster;
  L.ai.processMonster = function (battle, unit) {
    // EnemyActionLock.TryApply: 고정된 결정이 있으면 AI 대신 예약 목록에 넣는다(지금 상태로 검증한 것을)
    if (!S.dryRun && battle === S.battle && optOn('intent', 'lock') && unit.lockedIntent) {
      if (!unit.turnInfo || unit.turnInfo.reserveRound !== battle.round) return;
      unit.reserveSkillList.length = 0;
      if (unit.turnPos < (L.C.ACTIVE_ROUND || 100)) return;
      const ss = resolveLocked(battle, unit, unit.lockedIntent);
      if (unit.lastSkillInfo && ss.skillKey === MOVE) ss.skillKey = WAIT;
      unit.reserveSkillList.push(ss);
      return;
    }
    return origPM.call(this, battle, unit);
  };
  // EnemyActionLock.Resolve: 대상이 사라졌으면 같은 스킬로 가장 가까운 대상, 없으면 대기. 이동 칸이 막혔으면 대기.
  function resolveLocked(b, u, s) {
    const wait = () => ({ aid: u.aid, skillKey: WAIT, targetAid: 0, targetGridPos: 0 });
    if (!s || !s.skillKey) return wait();
    if (s.skillKey === WAIT) return Object.assign({}, s);
    if (s.skillKey === MOVE) return L.ai.emptyGridPosList(b, u).includes(s.targetGridPos) ? Object.assign({}, s) : wait();
    const sk = L.ai.skillByKey(u, s.skillKey);
    if (!sk || sk.cooldownLeft > 0) return wait();
    if (hasB(u, 'STAGE_SEAL_SKILL')) return wait();
    const tt = num(sk.table, 'TargetType');
    if (tt !== TT.ENEMY && tt !== TT.ENEMY_GRID) return Object.assign({}, s);
    let valid = true;
    if (s.targetAid) { const t = L.ai.getCreature(b, s.targetAid); valid = !!(t && alive(t) && L.combat.isDistance(u, sk, t, null, {})); }
    else if (s.targetGridPos < 9) { const t = b.units.find((x) => alive(x) && x.team !== u.team && x.gridPos === s.targetGridPos); valid = !!(t && L.combat.isDistance(u, sk, null, { team: 1, slot: s.targetGridPos }, {})); }
    if (valid) return Object.assign({}, s);
    const re = L.ai.newSel(u);
    let ok = false;
    const saved = b.rng.state;
    try { ok = L.ai.getTargetAI(b, re, u, slotOf(sk) === 2 ? 'skill_slot_2' : 'skill_slot_1', ATT.NEAR, '', '', ''); } catch (e) { ok = false; }
    b.rng.state = saved;
    if (ok && re.skillKey === s.skillKey && (re.targetAid || re.targetGridPos !== 255)) return re;
    return wait();
  }
  // EnemyActionLock.Decide: 행동력이 찼고 이번 라운드가 자기 차례인 것처럼 꾸며 AI를 돌리고 모두 되돌린다
  function computeIntent(b, u) {
    if (!b || !alive(u) || isPC(u) || b.round < 1 || u.inert) return null;
    u.reserveSkillList = u.reserveSkillList || [];
    const saved = { rng: b.rng.state, tp: u.turnPos, ti: u.turnInfo, rl: u.reserveSkillList.slice(), last: u.lastSkillInfo, le: (b.luaErrors || []).length, lg: b.log.length };
    S.dryRun = true; let out = null;
    try { u.turnPos = L.C.ACTIVE_ROUND || 100; u.turnInfo = { reserveRound: b.round, turnPos: u.turnPos, isReserve: 0 }; u.lastSkillInfo = null; u.reserveSkillList.length = 0; origPM(b, u); const ss = u.reserveSkillList[0]; out = ss ? Object.assign({}, ss) : null; }
    catch (e) { out = null; }
    finally { if (b.rng && 'state' in b.rng) b.rng.state = saved.rng; u.turnPos = saved.tp; u.turnInfo = saved.ti; u.lastSkillInfo = saved.last; u.reserveSkillList.length = 0; u.reserveSkillList.push(...saved.rl); if (b.luaErrors) b.luaErrors.length = saved.le; b.log.length = saved.lg; S.dryRun = false; }
    return out;
  }
  function refreshIntents() {
    const b = S.battle; if (!b) return;
    if (!sysOn('intent') || b.result) { for (const u of b.units) u.lockedIntent = null; S.intents = new Map(); emit('intents'); return; }
    const lock = optOn('intent', 'lock');
    for (const u of b.units) {
      if (!alive(u) || !isMob(u)) { S.intents.delete(u.aid); continue; }
      if (lock) { if (!u.lockedIntent) u.lockedIntent = computeIntent(b, u); if (u.lockedIntent) S.intents.set(u.aid, resolveLocked(b, u, u.lockedIntent)); else S.intents.delete(u.aid); }
      else { u.lockedIntent = null; const it = computeIntent(b, u); if (it) S.intents.set(u.aid, it); else S.intents.delete(u.aid); }
    }
    emit('intents');
  }
  function describeSel(u, ss) {
    if (!ss || !ss.skillKey || ss.skillKey === WAIT) return '대기';
    if (ss.skillKey === MOVE) return `이동 → ${ss.targetGridPos + 1}번 칸`;
    const s = L.ai.skillByKey(u, ss.skillKey);
    const t = ss.targetAid ? byAid(ss.targetAid) : null;
    const tt = s ? num(s.table, 'TargetType') : -1;
    const tgt = t ? unitName(t) : (tt === TT.ENEMY_GRID || tt === TT.OUR_GRID) && ss.targetGridPos !== 255 ? `${ss.targetGridPos + 1}번 칸` : tt === TT.SELF ? '자신' : '';
    return `${s ? slotOf(s) + '스킬 ' : ''}'${skillName(ss.skillKey)}'${tgt ? ' → ' + tgt : ''}`;
  }
  function describeAction(rec) {
    if (rec.kind === 'wait') return '대기';
    if (rec.kind === 'move') return `이동 → ${rec.to + 1}번 칸`;
    const t = rec.target ? byAid(rec.target.aid) : null;
    const s = L.T('Table_Skill', rec.skill);
    const tt = s ? num(s, 'TargetType') : -1;
    const tgt = t ? unitName(t) : (tt === TT.ENEMY_GRID || tt === TT.OUR_GRID) && rec.gridPos !== undefined && rec.gridPos !== 255 ? `${rec.gridPos + 1}번 칸` : tt === TT.SELF ? '자신' : '';
    return `${rec.slot ? rec.slot + '스킬 ' : ''}'${skillName(rec.skill)}'${tgt ? ' → ' + tgt : ''}`;
  }
  // 예측 표식용: {enemy, skillKey, skill, icon, target(유닛), targetGridPos, isMove, isWait}
  function intentMarkers() {
    const b = S.battle, out = [];
    if (!b || !sysOn('intent')) return out;
    for (const [aid, it] of S.intents) {
      const en = byAid(aid); if (!en || !alive(en)) continue;
      const m = { enemy: en, skillKey: it.skillKey, isMove: it.skillKey === MOVE, isWait: it.skillKey === WAIT, icon: skillIcon(it.skillKey), skill: null, target: null, targetGridPos: 255 };
      if (!m.isMove && !m.isWait) {
        m.skill = L.ai.skillByKey(en, it.skillKey);
        if (it.targetAid) m.target = byAid(it.targetAid);
        const tt = m.skill ? num(m.skill.table, 'TargetType') : -1;
        if (!m.target && it.targetGridPos !== 255 && it.targetGridPos < 9 && (tt === TT.ENEMY || tt === TT.ENEMY_GRID)) { m.targetGridPos = it.targetGridPos; m.target = b.units.find((x) => alive(x) && x.team === 1 && x.gridPos === it.targetGridPos) || null; }
      }
      out.push(m);
    }
    return out;
  }

  // ---------------------------------------------------------------- 스킬 효과 미리보기 (SkillPreview)
  function snapshot(b) {
    const cloneAttr = (a) => a.map((r) => r.slice());
    const units = b.allUnits.map((u) => ({ u, hp: u.hp, maxHp: u.maxHp, turnPos: u.turnPos, gridPos: u.gridPos, oriGridPos: u.oriGridPos, removed: u.removed, deadHandled: u._deadHandled, deadShown: u._deadShown, leftRoundCount: u.leftRoundCount, inert: u.inert,
      attrRef: u.attr, attr: cloneAttr(u.attr), baseRef: u.base, base: u.base === u.attr ? null : cloneAttr(u.base),
      buffs: u.buffs.map((x) => ({ obj: x, data: Object.assign({}, x) })), flags: Object.assign({}, u.flags), stats: Object.assign({}, u.stats, { skillUse: Object.assign({}, u.stats.skillUse) }),
      skills: (u.skills || []).map((sk) => ({ sk, cd: sk.cooldownLeft, skip: sk._cdSkip, skip2: sk._skipCdDec })), rl: (u.reserveSkillList || []).slice(), last: u.lastSkillInfo, ti: u.turnInfo, locked: u.lockedIntent }));
    return { units, unitsArr: b.units.slice(), allArr: b.allUnits.slice(), reserve: b.reserveSkills.map((r) => ({ obj: r, data: Object.assign({}, r) })), log: b.log.length, lua: (b.luaErrors || []).length,
      counters: b.counters ? Object.assign({}, b.counters) : undefined, rng: b.rng.state, s: Object.assign({}, b.s), extraQueue: b.s.extraQueue ? b.s.extraQueue.slice() : null,
      actualKey: b.actualKey, result: b.result, resultReason: b.resultReason, totalTurnCount: b.totalTurnCount, selfTurnCounts: new Map(b.selfTurnCounts), totalActions: b.totalActions, apTime: b.apTime };
  }
  function restore(b, sn) {
    for (const r of sn.units) {
      const u = r.u;
      u.hp = r.hp; u.maxHp = r.maxHp; u.turnPos = r.turnPos; u.gridPos = r.gridPos; u.oriGridPos = r.oriGridPos; u.removed = r.removed; u._deadHandled = r.deadHandled; u._deadShown = r.deadShown; u.leftRoundCount = r.leftRoundCount; u.inert = r.inert;
      u.attr = r.attrRef; for (let v = 0; v < r.attr.length; v++) for (let k = 0; k < r.attr[v].length; k++) u.attr[v][k] = r.attr[v][k];
      u.base = r.baseRef; if (r.base) for (let v = 0; v < r.base.length; v++) for (let k = 0; k < r.base[v].length; k++) u.base[v][k] = r.base[v][k];
      u.buffs.length = 0; for (const x of r.buffs) { for (const k of Object.keys(x.obj)) if (!(k in x.data)) delete x.obj[k]; Object.assign(x.obj, x.data); u.buffs.push(x.obj); }
      u.flags = r.flags; u.stats = r.stats;
      for (const x of r.skills) { x.sk.cooldownLeft = x.cd; x.sk._cdSkip = x.skip; x.sk._skipCdDec = x.skip2; }
      u.reserveSkillList = u.reserveSkillList || []; u.reserveSkillList.length = 0; u.reserveSkillList.push(...r.rl);
      u.lastSkillInfo = r.last; u.turnInfo = r.ti; u.lockedIntent = r.locked;
    }
    b.units.length = 0; b.units.push(...sn.unitsArr); b.allUnits.length = 0; b.allUnits.push(...sn.allArr);
    b.reserveSkills.length = 0; for (const x of sn.reserve) { Object.assign(x.obj, x.data); b.reserveSkills.push(x.obj); }
    b.log.length = sn.log; if (b.luaErrors) b.luaErrors.length = sn.lua;
    if (sn.counters === undefined) delete b.counters; else b.counters = sn.counters;
    b.rng.state = sn.rng; b.s = sn.s; if (sn.extraQueue) b.s.extraQueue = sn.extraQueue;
    b.actualKey = sn.actualKey; b.result = sn.result; b.resultReason = sn.resultReason; b.totalTurnCount = sn.totalTurnCount; b.selfTurnCounts = sn.selfTurnCounts; b.totalActions = sn.totalActions; b.apTime = sn.apTime;
  }
  // 시험 실행: 명중 강제·치명 고정으로 엔진 실행 함수를 돌린 뒤 되돌린다
  function trial(a, skill, sel, crit) {
    const b = S.battle, ST = L.stats, sn = snapshot(b), origRecalc = ST.recalc;
    const force = (u) => { if (u !== a) return; u.attr[VT.RATE][AT.APPLY] = 5; u.attr[VT.RATE][AT.CRI] = crit ? 5 : -5; };
    ST.recalc = function (u, bt) { const r = origRecalc.call(this, u, bt); force(u); return r; };
    force(a); S.dryRun = true;
    let res = null, err = null, events = [];
    try { res = L.combat.execute(b, a, skill, { target: sel.target || null, gridPos: sel.gridPos === undefined ? 255 : sel.gridPos }, { gridPos: sel.gridPos }); events = b.log.slice(sn.log); }
    catch (e) { err = e; }
    finally { ST.recalc = origRecalc; restore(b, sn); S.dryRun = false; }
    return { res, err, events };
  }
  // 클라이언트 Creature.GetDamagePreview 와 같은 공식(명중·치명·보호 없이 현재 상태로 계산)
  function clientDamagePreview(a, t, skill, gridRate, targetCount) {
    const BF = L.buffs, ST = L.stats, lt = skill.levelTable;
    const attr = (u, vt, at) => u.attr[vt][at], bval = (u, ty) => (ty === undefined ? 0 : BF.value(u, ty) || 0), bsum = (u, ty) => (ty === undefined ? 0 : BF.attrValue(u, ty) || 0), has = (u, ty) => ty !== undefined && !!BF.has(u, ty);
    let rate = parseFloat(str(lt, 'SkillAttackRate', '0')) || 0;
    if (isPC(a)) { const up = (a.coreLinkFunc && a.coreLinkFunc.stageSkillRatioUp) || 0; if (up) rate += up; }
    if (rate <= 0 || has(t, BT.STAGE_IMMUNESHIELD_TIME)) return 0;
    let add = attr(a, VT.RATE, AT.SKILL_ATTACK_RATE) + bval(a, BT.STAT_SKILL_RATIO);
    if (has(a, BT.EVADE_SKILLDMGUP_ME)) add += Math.max(0, attr(a, VT.RATE, AT.EVADE)) * bval(a, BT.EVADE_SKILLDMGUP_ME);
    if (has(t, BT.EVADE_SKILLDMGDOWN)) add -= attr(t, VT.RATE, AT.EVADE) * bval(t, BT.EVADE_SKILLDMGDOWN);
    if (has(a, BT.DEF_SKILLDMGUP_ME)) add += Math.max(0, attr(a, VT.ABS, AT.DEF)) * bval(a, BT.DEF_SKILLDMGUP_ME);
    const grid = L.T('Table_Grid', str(lt, 'GridIndex')), gd = L.combat.gridData(grid);
    if (has(t, BT.WIDE_SKILL_RATIO) && gd.length > 1) add += (targetCount - 1) * bval(t, BT.WIDE_SKILL_RATIO);
    const atk = attr(a, VT.ABS, AT.ATK);
    let dmg = Math.max(0, rate + add) * atk;
    let def = attr(t, VT.ABS, AT.DEF), resist = 1;
    const magic = num(lt, 'MagicSkillAttrType');
    if (magic === SA.FIRE) resist = 1 - ST.getResist(t, AT.FIRE_RESIST); else if (magic === SA.ICE) resist = 1 - ST.getResist(t, AT.ICE_RESIST); else if (magic === SA.LIGHTNING) resist = 1 - ST.getResist(t, AT.LIGHTNING_RESIST);
    const cls = num(t.table, 'ActorClassType');
    if (cls === AC.TROOPER) dmg += dmg * bval(a, BT.STAGE_TROOPERTYPEDMGBONUS_RATIO); else if (cls === AC.ARMORED) dmg += dmg * bval(a, BT.STAGE_ARMOREDTYPEDMGBONUS_RATIO); else if (cls === AC.MOBILITY) dmg += dmg * bval(a, BT.STAGE_MOBILITYTYPEDMGBONUS_RATIO);
    if (has(a, BT.STAGE_DEFPIERCE_VALUE)) def = Math.max(0, def - bval(a, BT.STAGE_DEFPIERCE_VALUE));
    if (has(a, BT.STAGE_DEFPIERCE_RATIO)) { let pr = bval(a, BT.STAGE_DEFPIERCE_RATIO) - (t.maxHp > 0 ? t.hp / t.maxHp : 0) * bval(t, BT.CURRENT_HP_PIERCEDOWN); if (pr < 0) pr = 0; def = Math.max(0, def * (1 - pr)); }
    if (a !== t && a.type !== t.type && !has(a, BT.BARRIER_PIERCE)) { let sr = bval(t, BT.STAGE_SHIELD_RATIO); if (sr > 1) sr = 1; dmg *= 1 - sr; }
    if (has(a, BT.DEF_DMG_ADD)) dmg += Math.max(0, attr(a, VT.ABS, AT.DEF)) * bval(a, BT.DEF_DMG_ADD);
    let total = magic === SA.NONE ? (dmg - def) * resist : dmg * resist;
    total *= gridRate;
    total += atk * bsum(t, BT.STAGE_DAMAGEPHYSICS_RATIO);
    total += atk * bsum(t, BT.STAGE_DAMAGEFIRE_RATIO) * (1 - ST.getResist(t, AT.FIRE_RESIST));
    total += atk * bsum(t, BT.STAGE_DAMAGEICE_RATIO) * (1 - ST.getResist(t, AT.ICE_RESIST));
    total += atk * bsum(t, BT.STAGE_DAMAGELIGHTNING_RATIO) * (1 - ST.getResist(t, AT.LIGHTNING_RESIST));
    total += total * bval(t, BT.STAGE_DAMAGEPHYSICS_RATIO_INS);
    total += total * bval(t, BT.STAGE_DAMAGEFIRE_RATIO_INS) * (1 - ST.getResist(t, AT.FIRE_RESIST));
    total += total * bsum(t, BT.STAGE_DAMAGEICE_RATIO_INS) * (1 - ST.getResist(t, AT.ICE_RESIST));
    total += total * bsum(t, BT.STAGE_DAMAGELIGHTNING_RATIO_INS) * (1 - ST.getResist(t, AT.LIGHTNING_RESIST));
    if (total <= 0) total = 1;
    return Math.trunc(total);
  }
  function estimateSel(u, ss) {
    const s = L.ai.skillByKey(u, ss.skillKey) || (L.combat.findSkill && L.combat.findSkill(u, ss.skillKey));
    if (!s) return null;
    return estimate(u, s, { target: ss.targetAid ? byAid(ss.targetAid) : null, gridPos: ss.targetGridPos });
  }
  function estimate(a, skill, sel) {
    const C = L.combat, BF = L.buffs, lt = skill.levelTable, tbl = skill.table, tt = num(tbl, 'TargetType');
    const grid = L.T('Table_Grid', str(lt, 'GridIndex'));
    const out = { actor: a, skill, tt, targets: [], effects: effectsOf(a, skill), rate: parseFloat(str(lt, 'SkillAttackRate', '0')) || 0, needAP: num(lt, 'NeedActionPoint'), dist: C.skillDistance(a, skill, {}), cd: num(lt, 'CooldownTurn'),
      summon: num(lt, 'IsSummonSkill') === 1, gridPos: sel.gridPos, magic: num(lt, 'MagicSkillAttrType'), warn: [], notes: [], mainTarget: sel.target || null };
    if ((tt === TT.ENEMY_GRID || tt === TT.OUR_GRID) && grid && num(grid, 'UsePoint') === 0) out.gridPos = num(grid, 'StandardPoint');
    if (out.summon) { out.summonKey = str(lt, 'SummonKeyString'); return out; }
    const hpBefore = new Map(S.battle.units.map((u) => [u.aid, u.hp]));
    const tN = trial(a, skill, sel, false), tC = trial(a, skill, sel, true);
    if (tN.err) { out.error = tN.err.message; return out; }
    const rN = tN.res, rC = tC.res;
    if (!rN || !rN.ok || rN.waited) { out.notes.push('이 행동은 ' + (rN && rN.skipped === 'cooldown' ? '쿨다운이라 대기로' : rN && rN.skipped === 'seal' ? '봉인이라 대기로' : '대상이 없어 대기(또는 다른 스킬)로') + ' 바꿉니다.'); return out; }
    if (rN.skillKey !== skill.key) { out.notes.push('대상이 없어 다른 스킬 ' + skillName(rN.skillKey) + '(으)로 바꿉니다.'); }
    if (rN.delayed) out.notes.push('예약(지연) 스킬: 지금은 피해가 없고 나중에 발동합니다.');
    const attr = (u, vt, at) => u.attr[vt][at];
    const byTarget = (r) => { const m = new Map(); for (const h of r.hits || []) m.set(h.target.aid, h); return m; };
    const hN = byTarget(rN), hC = byTarget(rC);
    const healN = new Map(), buffsN = new Map();
    for (const e of tN.events) {
      if (e.t === 'heal' && e.dst) healN.set(e.dst.aid, (healN.get(e.dst.aid) || 0) + (e.amount || 0));
      if (e.t === 'buff' && e.op === 'apply' && e.slot === 1 && e.from === a.aid) { const l = buffsN.get(e.unit) || []; if (!l.includes(e.key)) l.push(e.key); buffsN.set(e.unit, l); }
    }
    const order = (rN.targets || []).map((t) => t.aid);
    const enemyCount = (rN.targets || []).filter((t) => t.type !== a.type).length;
    for (const aid of new Set([...order, ...hN.keys(), ...healN.keys(), ...buffsN.keys()])) {
      const t = byAid(aid); if (!t) continue;
      const hn = hN.get(aid), hc = hC.get(aid);
      const row = { unit: t, ally: t === a || t.type === a.type, gridRate: hn ? hn.gridRate || 0 : 0, heal: healN.get(aid) || 0, buffs: buffsN.get(aid) || [] };
      if (row.ally || !hn) { out.targets.push(row); continue; }
      const hitTotal = attr(a, VT.RATE, AT.APPLY) + Math.fround(num(lt, 'Accuracy')) - attr(t, VT.RATE, AT.EVADE);
      row.hit = t.type === 'SUMMON' ? 1 : Math.max(0, Math.min(1, hitTotal));
      let cri = attr(a, VT.RATE, AT.CRI);
      if (BF.has(t, BT.DEF_CRTDOWN)) cri = Math.max(0, cri - attr(t, VT.ABS, AT.DEF) * BF.value(t, BT.DEF_CRTDOWN));
      row.crit = BF.has(a, BT.STAGE_CRITICAL_NEXTATTACK) ? 1 : Math.max(0, Math.min(1, cri));
      row.immune = !!hn.immune; row.shield = !!(hn.shield || hn.absorbed);
      row.dmgN = hn.damage || 0; row.dmgC = hc ? hc.damage || 0 : row.dmgN;
      row.clientDmg = clientDamagePreview(a, t, skill, row.gridRate, Math.max(1, enemyCount)); // 클라이언트 공식값
      row.noDamage = out.rate <= 0;
      if (hn.protectedBy && hn.original && hn.original !== t) { row.protects = hn.original; }
      const hp0 = hpBefore.get(aid) || 0; row.hp = hp0; row.maxHp = t.maxHp;
      row.killN = row.dmgN >= hp0; row.killC = row.dmgC >= hp0;
      out.targets.push(row);
    }
    for (const p of rN.protections || []) if (p.original && !out.targets.some((r) => r.unit === p.original)) out.targets.push({ unit: p.original, ally: false, gridRate: 0, protectedBy: p.protector, heal: 0, buffs: [] });
    if ((rN.protections || []).length) out.warn.push('가로막기·보호로 실제 피해 대상이 바뀝니다.');
    // 주 대상 = 찍은 대상(없으면 첫 적 대상)
    out.main = out.targets.find((r) => !r.ally && r.dmgN !== undefined && (!out.mainTarget || r.unit === out.mainTarget)) || out.targets.find((r) => !r.ally && r.dmgN !== undefined) || null;
    return out;
  }
  // 스킬에 묶인 효과 목록: {key, name, icon, target(라벨), debuff, rate, turns}
  function effectsOf(a, skill) {
    const out = [];
    for (const k of list(skill.levelTable, 'BuffEffectIndex')) {
      const row = L.T('Table_BuffEffect', k); if (!row) continue;
      const icons = ICONS.buff[k] || [], descs = ICONS.buffDesc[k] || [];
      const tgt = num(row, 'BuffEffectTargetType');
      const label = { 0: '자신', 1: '아군', 2: '아군', 8: '아군 전체', 3: '대상', 4: '대상', 9: '적 전체', 5: '전체', 6: '전체' }[tgt] || '대상';
      for (let i = 0; i < 5; i++) {
        if (!num(row, 'BuffEffectType' + (i + 1))) continue;
        const dk = descs[i]; const dt = dk ? L.name(dk, '') : '';
        const rate = parseFloat(str(row, 'BuffEffectRate' + (i + 1), '0')) || 0;
        out.push({ key: k, name: buffName(k), text: dt && dt !== dk ? dt : buffName(k), icon: icons[i] || '', target: label, debuff: num(row, 'BuffAttrType') === 1, rate, turns: num(row, 'BuffEffectLeftCount' + (i + 1)) });
      }
    }
    return out;
  }

  // ---------------------------------------------------------------- 수동 조작
  function manualCandidates(u, skill) {
    const b = S.battle, C = L.combat, tt = num(skill.table, 'TargetType'), dist = C.skillDistance(u, skill, {});
    if (num(skill.levelTable, 'IsSummonSkill') === 1) return { kind: 'summon' };
    if (tt === TT.SELF) return { kind: 'self' };
    if (tt === TT.ENEMY) return { kind: 'unit', units: C.enemyCandidates(b, u, dist) || [] };
    if (tt === TT.OUR) return { kind: 'unit', units: C.ourCandidates(b, u, dist, tt) || [] };
    if (tt === TT.ENEMY_GRID || tt === TT.OUR_GRID) {
      const grid = L.T('Table_Grid', str(skill.levelTable, 'GridIndex'));
      const fixed = grid && num(grid, 'UsePoint') === 0 ? num(grid, 'StandardPoint') : null;
      const side = tt === TT.ENEMY_GRID ? (isMob(u) ? 1 : 0) : (isMob(u) ? 0 : 1);
      const cells = []; for (let s = 0; s < 9; s++) { try { if (C.inRange(b, u, skill, { gridPos: s })) cells.push(s); } catch (e) { /* 범위 밖 */ } }
      return { kind: 'cell', side, cells, fixed };
    }
    return { kind: 'none' };
  }
  function manualChooseSkill(skill) {
    const m = S.manual; if (!m) return;
    m.skill = skill; m.mode = 'skill'; m.sel = null; m.hover = null; S.preview = null;
    m.cands = manualCandidates(m.unit, skill);
    const u = m.unit;
    if (m.cands.kind === 'self') manualPick({ aid: u.aid, skillKey: skill.key, targetAid: u.aid, targetGridPos: 255 });
    else if (m.cands.kind === 'cell' && m.cands.fixed !== null) manualPick({ aid: u.aid, skillKey: skill.key, targetAid: 0, targetGridPos: m.cands.fixed });
    else if (m.cands.kind === 'summon') { const ss = L.ai.newSel(u); const saved = S.battle.rng.state; const ok = L.ai.getTargetAI(S.battle, ss, u, slotOf(skill) === 1 ? 'skill_slot_1' : 'skill_slot_2', ATT.RANDOM, '', '', ''); S.battle.rng.state = saved; if (ok) manualPick(ss); else m.noSummon = true; }
    emit('manual');
  }
  function manualChooseMove() { const m = S.manual; if (!m) return; if (hasB(m.unit, 'STAGE_SNARE')) { emit('status', '속박 상태라 이동할 수 없습니다.'); return; } m.mode = 'move'; m.skill = null; m.sel = null; m.hover = null; m.needPlay = false; m.cands = { kind: 'move', cells: L.ai.emptyGridPosList(S.battle, m.unit) }; S.preview = null; emit('manual'); }
  function manualChooseWait() { const m = S.manual; if (!m) return; m.mode = 'wait'; m.skill = null; m.cands = null; m.sel = { aid: m.unit.aid, skillKey: WAIT, targetAid: 0, targetGridPos: 0 }; m.needPlay = true; S.preview = null; S.lastPreview = null; emit('manual'); }
  function manualPick(sel) { const m = S.manual; if (!m) return; m.sel = sel; m.hover = null; m.needPlay = sel.skillKey === MOVE || sel.skillKey === WAIT; S.preview = sysOn('preview') && !m.needPlay ? estimateSel(m.unit, sel) : null; S.lastPreview = S.preview ? Object.assign({ aid: m.unit.aid }, S.preview) : null; emit('manual'); }
  // 행동 개시 버튼: 이동·대기가 확정됐을 때만 실행한다 (SetPlay)
  function playConfirmed() { const m = S.manual; if (!m || !m.sel || !m.needPlay) return false; go(); if (S.battle && !S.battle.result) startPlay(); return true; }
  // 자동 전투 토글 (GameOption.BattleAuto): 켜면 아군도 자동 전투가 고르고 멈추지 않는다
  function setAuto(on) {
    SYS.manual.on = !on; onSystemsChanged('manual');
    if (on && S.battle && !S.battle.result && !S.playing) startPlay();
  }
  function manualCancelTarget() { const m = S.manual; if (!m) return; m.sel = null; m.hover = null; S.preview = null; S.lastPreview = null; if (m.mode === 'wait') { m.mode = null; m.cands = null; } emit('manual'); }
  function manualHover(sel) { const m = S.manual; if (!m || m.sel) return; m.hover = sel; emit('manual'); }
  // 전투판의 유닛/칸을 눌렀을 때 → 선택을 만든다. 돌려주는 값: true 면 처리됨
  function manualClickUnit(t) {
    const m = S.manual; if (!m || m.mode !== 'skill' || !m.cands || !m.skill) return false;
    if (m.cands.kind === 'unit' && m.cands.units.includes(t)) { manualPick({ aid: m.unit.aid, skillKey: m.skill.key, targetAid: t.aid, targetGridPos: 255 }); return true; }
    if (m.cands.kind === 'cell' && m.cands.fixed === null && (t.team === 1) === (m.cands.side === 1) && m.cands.cells.includes(t.gridPos)) { manualPick({ aid: m.unit.aid, skillKey: m.skill.key, targetAid: 0, targetGridPos: t.gridPos }); return true; }
    return false;
  }
  function manualClickCell(team, pos) {
    const m = S.manual; if (!m) return false;
    if (m.mode === 'move' && team === 1 && m.cands.cells.includes(pos)) { manualPick({ aid: m.unit.aid, skillKey: MOVE, targetAid: 0, targetGridPos: pos }); return true; }
    if (m.mode === 'skill' && m.cands && m.cands.kind === 'cell' && m.cands.fixed === null && team === m.cands.side && m.cands.cells.includes(pos)) { manualPick({ aid: m.unit.aid, skillKey: m.skill.key, targetAid: 0, targetGridPos: pos }); return true; }
    return false;
  }
  // 승인: 선택을 실행하고, 인게임처럼 다음 아군 턴(또는 멈춤 지점)까지 자동으로 이어 간다
  function manualExecute() { if (S.manual && S.manual.sel) { go(); if (S.battle && !S.battle.result) startPlay(); } }

  // ---------------------------------------------------------------- 기록
  function narrate(rec, logs, a) {
    const b = S.battle, side = isPC(a) ? '아군' : '적';
    const brain = isPC(a) ? (sysOn('manual') && rec.turnType === 'normal' ? '수동 조작' : '자동 전투') : '적의 행동';
    const tt = { normal: '', double: ' (추가 행동)', reserve: ' (예약 스킬 발동)', counter: ' (반격)', assist: ' (협동 공격)' }[rec.turnType] || '';
    let head, why = '';
    if (rec.kind === 'skill') { head = `${side} <b>${esc(unitName(a))}</b>${tt} → ${esc(describeAction(rec))}`; if (rec.turnType === 'normal') why = `${brain} 선택`; }
    else if (rec.kind === 'move') { head = `${side} <b>${esc(unitName(a))}</b> 이동 ${rec.from + 1} → ${rec.to + 1}번 칸`; why = brain === '수동 조작' ? '수동 조작: 이동 선택' : `${brain}: 사거리 안에 들어가려고 이동`; }
    else { head = `${side} <b>${esc(unitName(a))}</b> 대기`; why = `${brain}: ${rec.reason === 'cooldown' ? '쓰려던 스킬이 쿨다운' : rec.reason === 'no reserved skill' ? '선택할 수 있는 행동 없음' : '대상 없음'}`; }
    const res = [], info = { rec, actor: a, hits: [], kills: [], heals: [], pops: [] };
    let dmg = 0, hits = 0, miss = 0, crit = 0;
    const actual = new Map();
    for (const e of logs) {
      if (e.t === 'hit') { hits++; dmg += e.dmg || 0; if (e.crit) crit++; if (e.dst) { actual.set(e.dst.aid, { dmg: e.dmg || 0, crit: !!e.crit, miss: false }); info.pops.push({ aid: e.dst.aid, text: (e.crit ? '치명 ' : '') + (e.dmg || 0).toLocaleString(), cls: e.crit ? 'crit' : 'dmg' }); } }
      else if (e.t === 'miss') { miss++; if (e.dst) { actual.set(e.dst.aid, { miss: true }); info.pops.push({ aid: e.dst.aid, text: 'MISS', cls: 'miss' }); } }
      else if (e.t === 'kill') { const d = byAid(e.dst && e.dst.aid); if (d) { res.push(`<span class="k">${esc(unitName(d))} 처치</span>`); info.kills.push(d.aid); } }
      else if (e.t === 'heal') { res.push(`회복 ${e.amount}`); if (e.dst) info.pops.push({ aid: e.dst.aid, text: '+' + (e.amount || 0), cls: 'heal' }); }
      else if (e.t === 'buff' && e.op === 'apply' && e.slot === 1 && e.from === a.aid) { const d = byAid(e.unit); if (d) res.push(`${esc(unitName(d))}에게 '${esc(buffName(e.key))}'`); }
      else if (e.t === 'buff' && e.op === 'resurrect') res.push('부활');
      else if (e.t === 'summon') res.push('소환');
      else if (e.t === 'immune') res.push('면역');
    }
    if (hits || miss) res.unshift(`명중 ${hits}${crit ? ` (치명 ${crit})` : ''}${miss ? ` · 회피 ${miss}` : ''} · 피해 ${dmg.toLocaleString()}`);
    logLine(isPC(a) ? 'ours' : 'theirs', `<span class="r">R${b.round}</span> ${head}${why ? `<div class="why">${esc(why)}</div>` : ''}${res.length ? `<div class="res">${res.slice(0, 8).join(' · ')}</div>` : ''}`);
    return info;
  }
  function onSystemsChanged(id) {
    saveSystems();
    if (S.battle) {
      if (id === 'slotCooldown' && sysOn(id)) for (const u of S.battle.allUnits) for (const sk of u.skills || []) if (slotOf(sk) === 1) { sk.cooldownLeft = 0; sk._cdSkip = false; }
      refreshIntents();
      if (S.pending) {
        const u = S.pending.unit; S.pendingSel = upcomingSel(u); const sel = S.pendingSel;
        if (u && S.manual === null && sysOn('manual') && isPC(u)) { S.manual = { unit: u, skill: null, sel: null, mode: null, cands: null, hover: null }; S.preview = null; }
        else if (S.manual && !sysOn('manual')) { S.manual = null; S.preview = null; }
        else if (!sysOn('preview')) S.preview = null;
        if (S.manual && S.manual.sel && sysOn('preview')) S.preview = estimateSel(u, S.manual.sel);
        S.lastPreview = S.preview ? Object.assign({ aid: u.aid }, S.preview) : null;
      }
    }
    logLine('sys', `<b>시스템 변경</b> ${esc(SYS[id].name)}: ${sysOn(id) ? '켬' : '끔'}${(SYS[id].opts || []).map((o) => ` · ${esc(o.name)} ${o.on ? '켬' : '끔'}`).join('')}`);
    emit('systems'); emit('battle');
  }
  const byAid = (aid) => S.battle && S.battle.allUnits.find((u) => u.aid === aid);

  // ---------------------------------------------------------------- 동일성 검증(개발용): 콘솔 SANDBOX.verifySame(시드)
  function verifySame(seed) {
    seed = seed || +setup.seed || 1;
    const mk = () => L.battle.create({ stageKey: null, mode: 'stage', squad: squadSpecs(), seed, logEnabled: true, customWaves: [enemyWave()], options: { maxActions: 600 } });
    const sig = (b) => b.log.filter((e) => ['action', 'hit', 'miss', 'kill', 'heal', 'wave', 'end'].includes(e.t)).map((e) => JSON.stringify(e).replace(/"aid":\d+/g, '"aid":0'));
    const A = mk(); while (!A.result) L.battle.step(A);
    const B = mk(); B.rng = makeRng(seed); B.hooks = { beforeAction: () => true };
    const saveBattle = S.battle, saveLock = SYS.intent.opts[0].on;
    SYS.intent.opts[0].on = false; S.battle = B;
    try { while (!B.result) { const r = L.battle.step(B); if (r.type === 'input') { for (const u of B.units) if (alive(u) && isMob(u)) computeIntent(B, u); const u = r.unit, sel = u && u.reserveSkillList[0]; if (sel && sel.skillKey && sel.skillKey !== WAIT && sel.skillKey !== MOVE) estimateSel(u, sel); L.battle.resume(B); } } }
    finally { S.battle = saveBattle; SYS.intent.opts[0].on = saveLock; }
    const sa = sig(A), sb = sig(B); let first = -1;
    for (let i = 0; i < Math.max(sa.length, sb.length); i++) if (sa[i] !== sb[i]) { first = i; break; }
    return { same: first < 0, eventsA: sa.length, eventsB: sb.length, outcomeA: A.result, outcomeB: B.result, firstDiff: first, a: first >= 0 ? sa[first] : null, b: first >= 0 ? sb[first] : null };
  }

  // ---------------------------------------------------------------- 시작
  async function load() {
    restoreSystems();
    await L.load('data/');
    try { ICONS = await (await fetch('data/icons.json', { cache: 'no-store' })).json(); } catch (e) { /* 아이콘 없이 진행 */ }
    try { SPRITES = await (await fetch('ui/sprites.json', { cache: 'no-store' })).json(); } catch (e) { /* 스프라이트 정보 없이 진행 */ }
    buildIndexes();
    if (!restoreSetup()) defaultSetup();
    emit('loaded');
  }

  let inspected = null;
  function inspect(selection) { inspected = selection; emit('inspect', selection); }
  window.CORE = {
    L, E, TT, WAIT, MOVE, OUT_KO, ROLE_KO, CLASS_KO, TT_KO, esc, num, str, list,
    SYSTEMS, SYS, sysOn, optOn, VERDICTS, get verdicts() { return verdicts; }, setVerdict(id, v) { verdicts[id] = Object.assign({}, verdicts[id], v); store.set(KEY_VERDICT, verdicts); },
    toggleSystem(id, on) { SYS[id].on = on; onSystemsChanged(id); }, toggleOpt(id, oid, on) { SYS[id].opts.find((x) => x.id === oid).on = on; onSystemsChanged(id); },
    get PCS() { return PCS; }, get PCMAP() { return PCMAP; }, get MOBS() { return MOBS; }, get MOBMAP() { return MOBMAP; }, get ICONS() { return ICONS; }, get SPRITES() { return SPRITES; },
    setup, S, on, emit, load, get inspected() { return inspected; }, inspect, saveSetup, defaultSetup, newAllySpec, squadSpecs, enemyWave,
    startBattle, resetBattle, stepOnce, startPlay, stopPlay, go,
    manualChooseSkill, manualChooseMove, manualChooseWait, manualPick, manualCancelTarget, manualHover, manualClickUnit, manualClickCell, manualExecute, manualCandidates, playConfirmed, setAuto, isAuto: () => !sysOn('manual'),
    estimate, estimateSel, computeIntent, intentMarkers, describeSel, describeAction, effectsOf,
    pcName, mobName, unitName, skillName, buffName, slotOf, cooldownTurns, activeSkills, alive, isPC, isMob, speedOf, hasB, byAid, skillIcon, tbarIcon, timeScale, verifySame, logLine,
  };
  window.SANDBOX = window.CORE;
})();
