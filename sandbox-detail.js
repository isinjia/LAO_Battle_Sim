// =====================================================================================================
//  길게 누르기 상세 정보창 — 원작 Panel_BattleCharacterDetail(전투판 캐릭터·몬스터를 0.3초 누르면 뜨는 창)을
//  프리팹에서 내보낸 배치(ui/layout_*.json 의 detail, 효과 목록 줄 buffgroup·buffdesc)로 그대로 그린다.
//  채우는 값은 원작 코드와 같은 규칙: 능력치는 기본값 대비 증감 표시(▲/▼), 스킬 설명의 {0} 은 기본 공격력 × 스킬 배율,
//  효과 목록은 효과 분류(Table_Buff_Group_Category)별 묶음 + 전체/강화/해로움/일반 필터. 배경을 누르면 닫힌다.
// =====================================================================================================
(function () {
  const C = window.CORE, L = C.L, num = C.num, str = C.str;
  const E = C.E;
  const DETAIL = { unit: null, data: null, desc: null };
  // 원작 상수 (Common.cs / GlobalDefines.cs / 프리팹 직렬화 값)
  const COLOR_GREEN = '[42ff62]', COLOR_RED = '[f10916]', COLOR_VALUE = '[fffb26]', COLOR_END = '[-]';
  const MARK_UP = ' (▲', MARK_DOWN = ' (▼', MARK_END = ')';
  const BUFF_COLOR = { 0: [0.2656, 0.85, 0.2125, 1], 1: [1, 0.2, 0.2, 1], 3: [0.9717, 0.9717, 0.9717, 1] }; // UIBattleApplyBuffDesc _colorBuff/_colorDeBuff/_colorEtc
  const GROUP_UP = [0.2656, 0.85, 0.2125, 1], GROUP_DOWN = [0.95, 0.149, 0.149, 1]; // UIBattleBuffGroupInfo _colorUp/_colorDown
  const LONG_PRESS = 300; // ObjectPicker.longPressTime 0.3초
  DETAIL.LONG_PRESS = LONG_PRESS;
  // 스크롤 패널 잘림 영역 [왼, 아래, 오른, 위] (프리팹 UIPanel mClipRange)
  const CLIP_BUFF = [16, -320, 736, 320], CLIP_DESC = [-679, -288, -39, -88], CLIP_MOB = [-664, -249, -54, 45];
  const ROW_H = 60, GROUP_PAD = 4;

  const imgs = {};
  const img = (path) => PACKED.cached(imgs, path); // 배포판은 ImageBitmap(개발자 도구에 그림이 남지 않음)
  const loc = (k, fb) => (DETAIL.data && DETAIL.data.loc[k]) || fb || k;
  const fmt = (s, ...a) => String(s).replace(/\{(\d+)\}/g, (m, i) => (a[+i] !== undefined ? a[+i] : m));
  // NGUI 서식 → 그리기 함수가 아는 서식([RRGGBB] / [-])으로. [c] [/c] [sub] [/sub] 는 지우고 8자리 색은 6자리로.
  const ngui = (s) => String(s == null ? '' : s).replace(/\[\/?c\]|\[\/?sub\]|\[\/?b\]/g, '').replace(/\[([0-9a-fA-F]{6})[0-9a-fA-F]{2}\]/g, '[$1]');
  // StringHelper.Demical2Point: 소수 둘째 자리에서 버림, 뒤 0 없앰
  const d2 = (v) => { const t = Math.trunc((Number(v) || 0) * 100) / 100; return String(+t.toFixed(2)); };

  DETAIL.load = async function () {
    try { DETAIL.data = await (await fetch('ui/detail.json', { cache: 'no-store' })).json(); } catch (e) { DETAIL.data = { loc: {}, buffGroups: [], mobInfo: {}, buffDescFmt: {} }; }
    try { DETAIL.desc = await (await fetch('data/skilldesc.json', { cache: 'no-store' })).json(); } catch (e) { DETAIL.desc = { skills: {}, buffs: {} }; }
  };
  DETAIL.load();

  // 원작 Character.ActiveLongPress: 결과 화면에서는 막는다
  DETAIL.canOpen = (u) => !!(u && C.S.battle && !C.S.result && u.hp > 0);
  DETAIL.open = function (u) {
    if (!DETAIL.canOpen(u)) return false;
    DETAIL.unit = u; DETAIL.tab = 'skill'; DETAIL.skill = 0; DETAIL.filter = 0; DETAIL.fNew = 0; DETAIL.scroll = 0; DETAIL.descScroll = 0; DETAIL.mobScroll = 0; DETAIL.closed = new Set();
    return true;
  };
  // 효과 목록 보기 방식(원작 옵션, 기본은 일반 방식). 창을 닫았다 열어도 유지한다.
  //  실험 시스템 '체력 막대 밑 버프 표기2'와 서로 연동: 새 방식 ↔ 실험 켬, 일반 방식 ↔ 실험 끔. 시작할 때는 실험 설정을 따른다.
  try { DETAIL.newType = localStorage.getItem('sandbox.detailBuffNewType') === '1'; } catch (e) { DETAIL.newType = false; }
  DETAIL.setNewType = function (on) {
    if (DETAIL.newType !== on) { DETAIL.newType = on; DETAIL.scroll = 0; }
    try { localStorage.setItem('sandbox.detailBuffNewType', on ? '1' : '0'); } catch (e) { /* 저장 불가 */ }
    if (C.sysOn('skillIcons') !== on) C.toggleSystem('skillIcons', on);
  };
  C.on('systems', () => { if (C.sysOn('skillIcons') !== DETAIL.newType) DETAIL.setNewType(C.sysOn('skillIcons')); });
  DETAIL.close = function () { DETAIL.unit = null; };

  // ---------------------------------------------------------------- 값 만들기
  const ATK = E.ACTOR_ATTR_TYPE, ABS = E.VALUE_TYPE.ABS, RATE = E.VALUE_TYPE.RATE;
  const isPC = (u) => C.isPC(u) || (u.type === 'SUMMON' && u.team === 1);
  function classRole(u) {
    const t = u.table || {}; const ac = num(t, 'ActorClassType'), rt = num(t, 'RoleType');
    const a = { [E.ACTOR_CLASS.TROOPER]: '201', [E.ACTOR_CLASS.ARMORED]: '202', [E.ACTOR_CLASS.MOBILITY]: '203' }[ac];
    const r = { [E.ROLE_TYPE.TANKER]: '204', [E.ROLE_TYPE.NUKER]: '205', [E.ROLE_TYPE.SUPPORTER]: '206' }[rt];
    return (a ? loc(a) : '') + ' ' + (r ? loc(r) : '');
  }
  // GetUpdateStatusABSInt / ABSfloat / RATE
  function statText(u, attr, kind) {
    const before = (u.base && u.base[kind === 'rate' ? RATE : ABS][attr]) || 0, after = (u.attr && u.attr[kind === 'rate' ? RATE : ABS][attr]) || 0;
    let s, change;
    if (kind === 'int') { s = String(Math.trunc(after)); change = Math.trunc(after) - Math.trunc(before); }
    else if (kind === 'float') { s = d2(after); change = Math.round((after - before) * 1000) / 1000; }
    else { s = d2(after * 100) + '%'; change = Math.round((after - before) * 100 * 1000) / 1000; }
    if (change === 0) return s;
    return (change > 0 ? COLOR_GREEN : COLOR_RED) + s + (change > 0 ? MARK_UP : MARK_DOWN) + d2(Math.abs(change)) + (kind === 'rate' ? '%' : '') + MARK_END + COLOR_END;
  }
  function resist(u, attr) {
    const v = L.stats.getResist(u, attr) || 0, b = (u.base && u.base[RATE][attr]) || 0;
    return { text: d2(v * 100) + '%', color: v > b ? [0, 1, 0, 1] : v < b ? [1, 0, 0, 1] : [1, 1, 1, 1] };
  }
  // 정보창 스킬 목록: 슬롯 5 이하(원작 SkillSlotType <= SKILLSLOTMAX), 최대 5개
  const skillsOf = (u) => (u.skills || []).filter((s) => C.slotOf(s) <= 5).slice(0, 5);
  function skillDesc(u, sk) {
    const d = DETAIL.desc && DETAIL.desc.skills[sk.key];
    const text = d ? d.d : (DETAIL.data.skillDesc || {})[sk.key] || ''; if (!text || text === '0') return '';
    const atk = (u.base && u.base[ABS][ATK.ATK]) || 0;
    const v = Math.floor(atk * (parseFloat(str(sk.levelTable, 'SkillAttackRate', '0')) || 0));
    return fmt(text, COLOR_VALUE + v + COLOR_END);
  }
  // BuffDesc.GetBuffDescTypeCondition: 서식(정수/백분율/없음)과 곱할 능력치(DescOption)
  function buffDescText(u, bf) {
    const slot = (bf.sortIndex || 1) - 1;
    const d = DETAIL.desc && DETAIL.desc.buffs[bf.key]; const text = d && d.d ? d.d[slot] : '';
    const f = DETAIL.data.buffDescFmt[bf.key] || ''; const out = +(f[slot * 2] || 0), opt = +(f[slot * 2 + 1] || 0);
    if (out === E.NUM_OUTPUTTYPE.NONE) return text || C.buffName(bf.key);
    let v = Number(bf.attrValue) || 0;
    if (out === E.NUM_OUTPUTTYPE.PERCENT) v *= 100;
    // BUFF_DESC_OPTION: 1 공격력 2 방어력 3 체력 4 회피 5 행동력 6 치명 7 적중 (현재 능력치를 곱함)
    const mul = { 1: [ABS, ATK.ATK], 2: [ABS, ATK.DEF], 3: [ABS, ATK.HP], 4: [RATE, ATK.EVADE], 5: [ABS, ATK.TURNSPEED], 6: [RATE, ATK.CRI], 7: [RATE, ATK.APPLY] }[opt];
    if (mul && u.attr) v *= Math.max(0, u.attr[mul[0]][mul[1]] || 0);
    let s = d2(Math.abs(v)); if (v > 0) s = fmt(loc('2000244', '+{0}'), s); else if (v < 0) s = fmt(loc('2000245', '-{0}'), s);
    return text ? fmt(text, s) : C.buffName(bf.key);
  }
  function buffTime(bf) {
    const row = bf.row || L.T('Table_BuffEffect', bf.key) || {};
    if (num(row, 'BuffEffectEraseType') === 1) return fmt(loc('1174', '{0}횟수 남음'), bf.left);
    return num(row, 'BuffEffectLeftCount' + (bf.sortIndex || 1)) === 0 ? loc('421', '영구') : fmt(loc('674', '{0}라운드 남음'), bf.left);
  }
  // InitBuffInfo: 효과 분류별 묶음(분류 표시 순서대로), 줄 번호는 전체 목록 순서
  function buffGroups(u) {
    const list = (u.buffs || []).slice();
    const groups = [];
    list.forEach((bf, i) => {
      const g = DETAIL.data.buffGroups.find((x) => x.types.includes(bf.type)); if (!g) return;
      let e = groups.find((x) => x.g === g); if (!e) groups.push(e = { g, rows: [] });
      e.rows.push({ bf, n: i + 1 });
    });
    return groups.sort((a, b) => a.g.order - b.g.order);
  }
  const attrTypeOf = (bf) => num(bf.row || L.T('Table_BuffEffect', bf.key) || {}, 'BuffAttrType');
  const rowVisible = (bf, filter) => filter === 0 || attrTypeOf(bf) === [null, E.BUFF_ATTR_TYPE.BUFF, E.BUFF_ATTR_TYPE.DEBUFF, E.BUFF_ATTR_TYPE.ETC][filter];

  // ---------------------------------------------------------------- 글자 줄바꿈 (UILabel ResizeHeight: 폭에 맞춰 줄을 나눈다)
  function wrap(ctx, text, size, width) {
    ctx.save(); ctx.font = `700 ${size}px "Noto Sans KR", "Malgun Gothic", sans-serif`;
    const plain = (s) => s.replace(/\[([0-9a-fA-F]{6}|-)\]/g, '');
    const out = [];
    for (const para of String(text).split('\n')) {
      let line = '';
      for (const ch of Array.from(para)) {
        const next = line + ch;
        if (ctx.measureText(plain(next)).width > width && plain(line).length) {
          const sp = line.lastIndexOf(' ');
          if (sp > 0 && ch !== ' ') { out.push(line.slice(0, sp)); line = line.slice(sp + 1) + ch; } else { out.push(line); line = ch === ' ' ? '' : ch; }
        } else line = next;
      }
      out.push(line);
    }
    ctx.restore();
    return out;
  }
  const lineH = (size) => size * 1.15;
  // 프리팹에서 꺼져 있던 묶음을 켤 때 그 아래 위젯도 모두 켠다(내보낸 배치는 조상까지 접은 활성 값이라서)
  function showTree(ov, lay, root, on) {
    for (const o of lay) if (o.path === root || o.path.startsWith(root + '/')) ov[o.path] = Object.assign(ov[o.path] || {}, { active: on });
  }
  function clipRect(ctx, W, H, r) { ctx.beginPath(); ctx.rect(W / 2 + r[0], H / 2 - r[3], r[2] - r[0], r[3] - r[1]); ctx.clip(); }

  // ---------------------------------------------------------------- 그리기
  DETAIL.draw = function (ctx, W, H, hit) {
    const u = DETAIL.unit; if (!u || !DETAIL.data) return;
    if (!C.S.battle || !C.S.battle.units.includes(u)) { DETAIL.close(); return; }
    const lay = UI.layout('detail'); if (!lay.length) return;
    const mob = !isPC(u);
    const uiHit = (o, r, k) => hit(r.x, r.y, r.w, r.h, 'detail', k);
    // 뒤 배경(Panel_Base GoBackGround): 누르면 닫힘
    ctx.save(); ctx.fillStyle = 'rgba(0,0,0,0.7)'; ctx.fillRect(0, 0, W, H); ctx.restore();
    hit(0, 0, W, H, 'detail', { act: 'close' }, 'default');
    const ov = {};
    // 창 바탕은 눌러도 닫히지 않는다
    ov['CreatureStatus/Bg/BgSp'] = { hit: { act: 'none' } }; ov['BuffStatus/BgSp'] = { hit: { act: 'none' } };
    // 프로필
    const tb = C.tbarIcon(u) || '';
    const face = mob || u.type === 'SUMMON' ? img('ui/tbar/' + tb + '.png') : (img('ui/inven/' + tb.replace(/^TbarIcon_/, 'InvenIcon_') + '.png') || img('ui/tbar/' + tb + '.png'));
    ov['Profile/IconTx'] = { texture: face, fillStyle: face ? undefined : '#2a2d35' };
    ov['Profile/ClassLb'] = { text: classRole(u) };
    ov['Profile/LvLb'] = { text: 'Lv. ' + u.level };
    ov['Profile/NameLb'] = { text: C.unitName(u) };
    ov['Hp/HpLb'] = { text: Math.max(0, Math.round(u.hp)) + ' / ' + Math.round(u.maxHp) };
    const tp = Number(u.turnPos) || 0; ov['CurrentAp/CurrentApLb'] = { text: tp % 1 === 0 ? String(tp) : tp.toFixed(2) };
    // 능력치 (UpdateStatus)
    ov['TableStat/AttackLb'] = { text: ngui(statText(u, ATK.ATK, 'int')) };
    ov['TableStat/DefLb'] = { text: ngui(statText(u, ATK.DEF, 'int')) };
    ov['TableStat/RateLb'] = { text: ngui(statText(u, ATK.APPLY, 'rate')) };
    ov['TableStat/EvadeLb'] = { text: ngui(statText(u, ATK.EVADE, 'rate')) };
    ov['TableStat/CriLb'] = { text: ngui(statText(u, ATK.CRI, 'rate')) };
    ov['TableStat/ApLb'] = { text: ngui(statText(u, ATK.TURNSPEED, 'float')) };
    for (const [n, a] of [['FireLb', ATK.FIRE_RESIST], ['IceLb', ATK.ICE_RESIST], ['LightningLb', ATK.LIGHTNING_RESIST]]) { const r = resist(u, a); ov['Resist/' + n] = { text: r.text, color: r.color }; }
    // 탭: 몬스터만 탭 버튼(스킬/정보)
    const P = 'Panel_BattleCharacterDetail/CreatureStatus/';
    ov['CreatureStatus/TabBtns'] = { active: mob };
    showTree(ov, lay, P + 'TabBtns/BtnSkillInfo', mob && DETAIL.tab === 'monster');
    showTree(ov, lay, P + 'TabBtns/BtnMonsterInfo', mob && DETAIL.tab === 'skill');
    ov[P + 'TabBtns/BtnSkillInfo'].hit = { act: 'tab', tab: 'skill' }; ov[P + 'TabBtns/BtnMonsterInfo'].hit = { act: 'tab', tab: 'monster' };
    ov['CreatureStatus/SkillInfo'] = { active: DETAIL.tab === 'skill' };
    showTree(ov, lay, P + 'MonsterInfo', DETAIL.tab === 'monster');
    ov['CreatureStatus/ExtSkillInfo'] = { active: false };
    // 스킬 (OnBtnSkill)
    const skills = skillsOf(u), cur = skills[Math.min(DETAIL.skill, skills.length - 1)];
    const onSkill = DETAIL.tab === 'skill'; // 직접 켜는 위젯은 부모(SkillInfo)가 꺼져도 켜지므로 탭을 따라 끈다
    for (let i = 0; i < 5; i++) {
      const sk = skills[i];
      ov['HaveSkill/wrapper/skill' + (i + 1)] = { active: onSkill && !!sk, hit: sk ? { act: 'skill', i } : null };
      ov['skill' + (i + 1) + '/texSkillIcon' + (i + 1)] = { texture: sk ? img('ui/skill/' + C.skillIcon(sk.key) + '.png') : null, circle: true };
      ov['HaveSkill/wrapper/skill' + (i + 1) + '/select'] = { active: onSkill && !!sk && sk === cur };
    }
    ov['SkillInfo/SkillCostLb'] = { active: false }; ov['SkillDistLb/SkillCostLb'] = { active: false }; // 개편 후 AP 비용 숨김
    ov['SkillInfo/SkillExpLb'] = { active: false }; ov['SkillInfo/SkillExpBg'] = { active: false }; // 스킬 경험치(시뮬레이터에 자료 없음)
    let descLines = [];
    if (cur) {
      const lv = cur.levelTable || {};
      ov['SkillInfo/SkillNameLb'] = { text: ngui(fmt(loc('414', 'Lv. {0} {1}'), cur.level || 1, C.skillName(cur.key))) };
      ov['SkillNameLb/SkillTypeSp'] = { sprite: ['UI_Battle_Atktype_normal', 'UI_Battle_Atktype_fire', 'UI_Battle_Atktype_ice', 'UI_Battle_Atktype_electric'][num(lv, 'MagicSkillAttrType')] || 'UI_Battle_Atktype_normal' };
      ov['SkillInfo/SkillDistLb'] = { text: String(mob ? num(lv, 'Distance') : L.combat.skillDistance(u, cur, {})) };
      const cells = L.combat.gridData(L.T('Table_Grid', str(lv, 'GridIndex'))) || [];
      for (let s = 0; s < 9; s++) {
        const g = cells.find((c) => c.pos - 1 === s); const p = g ? Number(g.persent) || 0 : 0;
        const col = p >= 0.999 ? [1, 0.945, 0.278, 1] : Math.abs(p - 0.75) < 1e-3 ? [1, 0.682, 0, 1] : Math.abs(p - 0.5) < 1e-3 ? [1, 0.475, 0, 1] : Math.abs(p - 0.25) < 1e-3 ? [0.6, 0.286, 0.149, 1] : [0.639, 0.443, 0.345, 1];
        ov['Skill_01_Range/slot' + s + '/slot_0_DMG'] = { active: onSkill && p > 0, color: col };
      }
      const descO = lay.find((o) => o.path.endsWith('SkillInfo/ScrollSkillDesc/SkillDescLb'));
      if (descO) descLines = wrap(ctx, ngui(skillDesc(u, cur)), descO.fontSize, descO.rect[2] - descO.rect[0]);
    }
    ov['SkillInfo/ScrollSkillDesc/SkillDescLb'] = { hideText: true };
    // 몬스터 정보 (Mob_Info)
    ov['ScrollView/infoText'] = { hideText: true };
    // 효과 목록 탭 (SetBuffGroupInfoUIType): 일반 방식 전체/강화/해로움/일반, 새 방식 전체/아군/적군/전장. 필터는 방식마다 따로 기억한다.
    const nt = DETAIL.newType, fi = nt ? DETAIL.fNew : DETAIL.filter;
    const tabs = ['BtnBuffInfoAll', 'BtnBuffInfoBuff', 'BtnBuffInfoDeBuff', 'BtnBuffInfoEtc'], keys = nt ? [null, '1442', '1443', '1444'] : [null, '2000487', '2000488', '2000489'];
    tabs.forEach((t, i) => {
      ov['TabBtns/' + t] = { hit: { act: 'filter', i } };
      ov[t + '/On'] = { active: fi === i };
      if (keys[i]) { ov[t + '/TitleLb'] = { text: loc(keys[i]) }; ov[t + '/On/TitleLb'] = { text: loc(keys[i]) }; }
    });
    ov['BuffStatus/BuffViewTypeDescLb'] = { text: loc(nt ? ['1445', '1446', '1447', '1448'][fi] : String(2000490 + fi)) }; // RefreshBuffInfo
    ov['Scroll/BuffGroupInfoUINormalType'] = { active: !nt };
    ov['Scroll/BuffGroupInfoUINewType'] = { active: nt };
    ov['BuffStatus/ChangeBtn'] = { hit: { act: 'change' } };
    UI.draw(ctx, lay, { W, H, ox: 0, oy: 0, scale: 1, ov, hit: uiHit });

    // 스킬 설명 (스크롤 영역 안, 위에서 아래로)
    if (DETAIL.tab === 'skill' && descLines.length) {
      const o = lay.find((x) => x.path.endsWith('SkillInfo/ScrollSkillDesc/SkillDescLb'));
      DETAIL.descMax = Math.max(0, descLines.length * lineH(o.fontSize) - (CLIP_DESC[3] - CLIP_DESC[1]) + (CLIP_DESC[3] - o.rect[3]));
      drawLines(ctx, W, H, o, descLines, CLIP_DESC, DETAIL.descScroll = Math.min(DETAIL.descScroll, DETAIL.descMax));
    }
    if (DETAIL.tab === 'monster') {
      const o = lay.find((x) => x.path.endsWith('ScrollView/infoText'));
      if (o) {
        const lines = wrap(ctx, ngui(DETAIL.data.mobInfo[u.key] || ''), o.fontSize, o.rect[2] - o.rect[0]);
        DETAIL.mobMax = Math.max(0, lines.length * lineH(o.fontSize) - (CLIP_MOB[3] - CLIP_MOB[1]) + (CLIP_MOB[3] - o.rect[3]));
        drawLines(ctx, W, H, o, lines, CLIP_MOB, DETAIL.mobScroll = Math.min(DETAIL.mobScroll, DETAIL.mobMax));
      }
    }
    if (nt) drawBuffListNew(ctx, W, H, u); else drawBuffList(ctx, W, H, u, hit);
  };
  // 왼쪽 위 기준 여러 줄 라벨
  function drawLines(ctx, W, H, o, lines, clip, scroll) {
    ctx.save(); clipRect(ctx, W, H, clip);
    const size = o.fontSize, x = W / 2 + o.rect[0], y0 = H / 2 - o.rect[3] - scroll;
    lines.forEach((ln, i) => { const y = y0 + lineH(size) * i; if (y > H / 2 - clip[1] + size || y + size < H / 2 - clip[3]) return; UI.drawText(ctx, o, x, y, o.rect[2] - o.rect[0], lineH(size), ln); });
    ctx.restore();
  }
  // 효과 목록 (UIBattleBuffGroupInfo + UIBattleApplyBuffDesc 를 UITable 처럼 위에서 아래로 쌓는다)
  function drawBuffList(ctx, W, H, u, hit) {
    const gLay = UI.layout('buffgroup'), rLay = UI.layout('buffdesc'); if (!gLay.length || !rLay.length) return;
    const groups = buffGroups(u);
    ctx.save(); clipRect(ctx, W, H, CLIP_BUFF);
    let y = 0; const top = CLIP_BUFF[3], x0 = CLIP_BUFF[0];
    const items = [];
    for (const e of groups) {
      const rows = e.rows.filter((r) => rowVisible(r.bf, DETAIL.filter)); if (!rows.length) continue; // 보이는 줄이 없으면 묶음도 숨김
      const open = !DETAIL.closed.has(e.g.name);
      items.push({ kind: 'g', e, rows, open, y });
      y += ROW_H + GROUP_PAD * 2;
      if (open) for (const r of rows) { items.push({ kind: 'r', r, y }); y += ROW_H; }
    }
    DETAIL.buffMax = Math.max(0, y - (CLIP_BUFF[3] - CLIP_BUFF[1]));
    DETAIL.scroll = Math.min(DETAIL.scroll, DETAIL.buffMax);
    const clipTop = H / 2 - CLIP_BUFF[3], clipBot = H / 2 - CLIP_BUFF[1];
    for (const it of items) {
      const oy = top - it.y + DETAIL.scroll - (it.kind === 'g' ? GROUP_PAD : 0);
      const sy = H / 2 - oy; if (sy > clipBot || sy + ROW_H < clipTop) continue;
      const vis = (yy, hh) => Math.max(yy, clipTop) < Math.min(yy + hh, clipBot);
      if (it.kind === 'g') {
        const g = it.e.g;
        let total = 0; for (const r of it.e.rows) total += (Number(r.bf.attrValue) || 0) * (g.view === E.NUM_OUTPUTTYPE.PERCENT ? 100 : 1);
        const mark = total > 0 ? '▲' : total < 0 ? '▼' : '';
        const val = g.view === E.NUM_OUTPUTTYPE.NONE ? '' : mark + d2(Math.abs(total)) + (g.view === E.NUM_OUTPUTTYPE.PERCENT ? '%' : '');
        const gov = { 'Pos/GroupNameLb': { text: g.name }, 'Pos/TotalCountLb': { text: '(' + it.e.rows.length + ')' }, 'Pos/TotalValueLb': { text: val, color: total > 0 ? GROUP_UP : total < 0 ? GROUP_DOWN : undefined },
          'Pos/On': { active: it.open }, 'Pos/Off': { active: !it.open } };
        if (vis(sy, ROW_H)) { gov['On/BtnBuffOff'] = { hit: { act: 'group', name: g.name } }; gov['Off/BtnBuffOn'] = { hit: { act: 'group', name: g.name } }; }
        UI.draw(ctx, gLay, { W, H, ox: x0, oy, scale: 1, ov: gov, hit: (o, r, k) => hit(r.x, r.y, r.w, r.h, 'detail', k) });
      } else {
        const bf = it.r.bf, at = attrTypeOf(bf);
        const icon = (C.ICONS.buff[bf.key] || [])[(bf.sortIndex || 1) - 1] || '';
        const rov = { 'Pos/IconSp': { sprite: icon || 'box', active: !!icon }, 'Pos/DescLb': { text: ngui(it.r.n + ' ' + buffDescText(u, bf)), color: BUFF_COLOR[at] }, 'Pos/TimeLb': { text: buffTime(bf) } };
        UI.draw(ctx, rLay, { W, H, ox: x0, oy, scale: 1, ov: rov });
      }
    }
    ctx.restore();
  }

  // 효과 목록 새 방식 (InitBuffInfoNewType + UIBattleBuffGroupInfo_NewType)
  //  같은 효과·같은 시전자·같은 남은 턴을 한 묶음으로, 효과 그룹(BuffEffectGroup)이 있는 효과만. 묶음마다 그룹 이름·스킬 아이콘·설명 줄(효과 칸별)·
  //  중첩 수·남은 턴·시전 전투원 얼굴. 배경(Bg/BgSp)은 내용에 맞춰 늘어난다(EnvelopContent 위 24, 아래 -1).
  const NEW_COLOR = { 0: [0.2667, 0.851, 0.2118, 1], 1: [0.949, 0.149, 0.149, 1], 3: [1, 1, 1, 1] };
  const ENV_TOP = 24, ENV_BOTTOM = -1;
  function newGroups(u) {
    const out = [], idx = new Map();
    for (const bf of u.buffs || []) {
      const ek = DETAIL.data.effectGroupOf[bf.key] || str(bf.row || {}, 'BuffEffectGroup');
      const g = ek && DETAIL.data.effectGroups[ek]; if (!g) continue;
      const k = bf.key + '|' + bf.fromAid + '|' + bf.left;
      let e = idx.get(k); if (!e) { idx.set(k, e = { g, buffs: [] }); out.push(e); }
      e.buffs.push(bf);
    }
    return out;
  }
  function newVisible(u, g, fi) {
    let src = g.type;
    if (!isPC(u) && (src === 0 || src === 1)) src = 1 - src; // 0/1 은 시전 측: 대상 기준 아군/적군으로 바꾼다
    return fi === 0 || src === fi - 1;
  }
  function drawBuffListNew(ctx, W, H, u) {
    const lay = UI.layout('buffgroup2'); if (!lay.length) return;
    const R = 'UIBattleBuffGroupInfo_NewType/Pos/', CT = R + 'Content';
    const items = newGroups(u).filter((e) => newVisible(u, e.g, DETAIL.fNew));
    ctx.save(); clipRect(ctx, W, H, CLIP_BUFF);
    let cursor = 0; const drawList = [];
    for (const e of items) {
      const bf0 = e.buffs[0], row = bf0.row || L.T('Table_BuffEffect', bf0.key) || {};
      const descs = (DETAIL.desc.buffs[bf0.key] || {}).d || [];
      const ov = {};
      ov[CT + '/GroupNameLb'] = { text: e.g.name };
      // 설명 줄: 설명이 있고 확률이 0보다 큰 효과 칸만 차례로 (SetBuffDescriptions)
      let li = 0; const at = num(row, 'BuffAttrType');
      for (let i = 0; i < 5; i++) {
        const desc = descs[i]; if (!desc || desc === '0' || !(parseFloat(str(row, 'BuffEffectRate' + (i + 1), '0')) > 0) || li >= 5) continue;
        const applied = e.buffs.find((b) => b.sortIndex === i + 1);
        li++; showTree(ov, lay, CT + '/BuffInfoLb_' + li, true);
        Object.assign(ov[CT + '/BuffInfoLb_' + li], { text: ngui(applied ? buffDescText(u, applied) : desc), color: NEW_COLOR[at] });
      }
      for (let j = li + 1; j <= 5; j++) showTree(ov, lay, CT + '/BuffInfoLb_' + j, false);
      ov[CT + '/BuffIcon'] = { texture: e.g.icon && e.g.icon !== '0' ? img('ui/skill/' + e.g.icon + '.png') : null, circle: true };
      const counts = {}; for (const b of e.buffs) counts[b.sortIndex] = (counts[b.sortIndex] || 0) + 1;
      ov[CT + '/BuffIcon/TotalCountLb'] = { text: fmt(loc('1441', '{0} 중첩'), Math.max(...Object.values(counts))) };
      const tbar = e.g.source && C.ICONS.pcTbar[e.g.source];
      const face = tbar ? img('ui/tbar/' + tbar + '.png') : null;
      showTree(ov, lay, CT + '/ChaIcon', !!tbar); // 얼굴이 없으면 얼굴 칸(남은 턴 글자 포함)을 끈다
      if (tbar) { ov[CT + '/ChaIcon'].texture = face; ov[CT + '/ChaIcon/CountLb'].text = buffTime(bf0); }
      // 켜진 내용 위젯의 외곽으로 배경 크기 맞춤, 묶음 전체 외곽으로 쌓기 높이
      const on = (o) => { let a = o.active; for (const k of Object.keys(ov)) if ((o.path === k || o.path.startsWith(k + '/')) && ov[k].active !== undefined && (o.path === k || ov[k].active === false)) a = ov[k].active; return a; };
      const box = (list) => list.reduce((b, o) => [Math.min(b[0], o.rect[0]), Math.min(b[1], o.rect[1]), Math.max(b[2], o.rect[2]), Math.max(b[3], o.rect[3])], [1e9, 1e9, -1e9, -1e9]);
      const content = lay.filter((o) => o.kind !== 'node' && o.path.startsWith(CT + '/') && on(o));
      const cb = box(content), bgO = lay.find((o) => o.path === R + 'Bg/BgSp');
      if (bgO && content.length) ov[R + 'Bg/BgSp'] = { rect: [bgO.rect[0], cb[1] + ENV_BOTTOM, bgO.rect[2], cb[3] + ENV_TOP] };
      const all = lay.filter((o) => o.kind !== 'node' && on(o)).map((o) => (ov[o.path] && ov[o.path].rect ? { rect: ov[o.path].rect } : o));
      const ib = box(all);
      drawList.push({ ov, top: ib[3], y: cursor });
      cursor += (ib[3] - ib[1]) + GROUP_PAD * 2;
    }
    DETAIL.buffMax = Math.max(0, cursor - (CLIP_BUFF[3] - CLIP_BUFF[1]));
    DETAIL.scroll = Math.min(DETAIL.scroll, DETAIL.buffMax);
    for (const it of drawList) {
      const oy = CLIP_BUFF[3] - it.y - GROUP_PAD + DETAIL.scroll - it.top;
      UI.draw(ctx, lay, { W, H, ox: CLIP_BUFF[0], oy, scale: 1, ov: it.ov });
    }
    ctx.restore();
  }

  // ---------------------------------------------------------------- 조작
  DETAIL.click = function (h) {
    const k = h && h.kind === 'detail' ? h.data : { act: 'close' };
    if (!k) return;
    switch (k.act) {
      case 'close': DETAIL.close(); break;
      case 'skill': DETAIL.skill = k.i; DETAIL.descScroll = 0; break;
      case 'tab': DETAIL.tab = k.tab; break;
      case 'filter': if (DETAIL.newType) DETAIL.fNew = k.i; else DETAIL.filter = k.i; DETAIL.scroll = 0; break;
      case 'group': if (DETAIL.closed.has(k.name)) DETAIL.closed.delete(k.name); else DETAIL.closed.add(k.name); break;
      case 'change': // OnBtnBuffGroupInfoUIType: 일반 ↔ 새 방식, 설정으로 저장(GameOption.BattleBuffGroupInfoUITypeNormal)
        DETAIL.setNewType(!DETAIL.newType); // 실험 '체력 막대 밑 버프 표기2'도 같이 켜고 끈다
        break;
      default: break;
    }
  };
  // 마우스 휠: 포인터가 있는 스크롤 영역을 움직인다 (원작 UIScrollView 드래그 대신)
  DETAIL.wheel = function (p, dy, W, H) {
    if (!DETAIL.unit) return false;
    const x = p.x - W / 2, y = H / 2 - p.y, inR = (r) => x >= r[0] && x <= r[2] && y >= r[1] && y <= r[3];
    if (inR(CLIP_BUFF)) DETAIL.scroll = Math.max(0, Math.min(DETAIL.buffMax || 0, DETAIL.scroll + dy));
    else if (DETAIL.tab === 'skill' && inR(CLIP_DESC)) DETAIL.descScroll = Math.max(0, Math.min(DETAIL.descMax || 0, DETAIL.descScroll + dy));
    else if (DETAIL.tab === 'monster' && inR(CLIP_MOB)) DETAIL.mobScroll = Math.max(0, Math.min(DETAIL.mobMax || 0, DETAIL.mobScroll + dy));
    return true;
  };
  window.DETAIL = DETAIL;
})();
