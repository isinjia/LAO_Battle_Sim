// =====================================================================================================
//  보조 창들 — 오른쪽: 시험 시스템 / 배치·전투 옵션, 아래: 행동 기록 / 적 행동 예측 표 / 판정 메모
// =====================================================================================================
(function () {
  const C = window.CORE, L = C.L, esc = C.esc, num = C.num;
  const $ = (id) => document.getElementById(id);
  const COLS_ALLY = ['후열', '중열', '전열'], COLS_ENEMY = ['전열', '중열', '후열'];
  const P = { selA: null, selE: null };

  // ---------------------------------------------------------------- 시험 시스템 창
  function renderSystems(el) {
    el.innerHTML = `<div class="sys">${C.SYSTEMS.filter((s) => !s.builtin).map((s) => { const v = C.verdicts[s.id] || {}; return `<div class="sysrow ${s.on ? '' : 'off'}">
        <label class="hd"><input type="checkbox" data-on="${s.id}" ${s.on ? 'checked' : ''}> ${esc(s.name)} ${s.test ? '<span class="tag">시험</span>' : ''}</label>
        <div class="desc">${esc(s.desc)}</div>
        ${(s.opts || []).length ? `<div class="opts">${s.opts.map((o) => `<label title="${esc(o.desc || '')}"><input type="checkbox" data-opt="${s.id}:${o.id}" ${o.on ? 'checked' : ''} ${s.on ? '' : 'disabled'}> <span>${esc(o.name)}${o.desc ? ` <span class="note">— ${esc(o.desc)}</span>` : ''}</span></label>`).join('')}</div>` : ''}
        <div class="verdict">판정 <select data-verdict="${s.id}">${C.VERDICTS.map((x) => `<option ${v.verdict === x ? 'selected' : ''}>${x}</option>`).join('')}</select><input data-memo="${s.id}" placeholder="메모 (왜 좋은지/나쁜지)" value="${esc(v.memo || '')}"></div>
      </div>`; }).join('')}</div>
      <div class="row"><button id="verdictCopy">판정·메모 복사</button><span class="note">판정과 메모는 이 브라우저에 저장됩니다.</span></div>`;
    el.querySelectorAll('[data-on]').forEach((x) => x.addEventListener('change', () => { if (x.dataset.on === 'manual') C.setAuto(!x.checked); else C.toggleSystem(x.dataset.on, x.checked); renderSystems(el); }));
    if (!el._sysBound) { el._sysBound = true; C.on('systems', () => renderSystems(el)); }
    el.querySelectorAll('[data-opt]').forEach((x) => x.addEventListener('change', () => { const [a, b] = x.dataset.opt.split(':'); C.toggleOpt(a, b, x.checked); }));
    el.querySelectorAll('[data-verdict]').forEach((x) => x.addEventListener('change', () => C.setVerdict(x.dataset.verdict, { verdict: x.value })));
    el.querySelectorAll('[data-memo]').forEach((x) => x.addEventListener('change', () => C.setVerdict(x.dataset.memo, { memo: x.value })));
    el.querySelector('#verdictCopy').addEventListener('click', async () => {
      const lines = ['# 전투 시스템 실험 판정', '', '| 시스템 | 현재 상태 | 판정 | 메모 |', '|---|---|---|---|'];
      for (const s of C.SYSTEMS.filter((x) => !x.builtin)) { const v = C.verdicts[s.id] || {}; lines.push(`| ${s.name}${s.test ? ' (시험)' : ''} | ${s.on ? '켬' : '끔'}${(s.opts || []).filter((o) => o.on).map((o) => ' · ' + o.name).join('')} | ${v.verdict || '미정'} | ${(v.memo || '').replace(/\|/g, '/')} |`); }
      try { await navigator.clipboard.writeText(lines.join('\n')); C.emit('status', '판정·메모를 복사했습니다.'); } catch (e) { C.emit('status', '클립보드 복사가 막혀 있습니다.'); }
    });
  }

  // ---------------------------------------------------------------- 배치·전투 옵션 창
  function renderSetup(el) {
    const st = C.setup, S = C.S;
    const grid = (ally) => {
      const data = ally ? st.ally : st.enemy, sel = ally ? P.selA : P.selE;
      let h = `<div class="grid9"><div class="lbl">${(ally ? COLS_ALLY : COLS_ENEMY).map((c) => `<span>${c}</span>`).join('')}</div>`;
      for (let i = 0; i < 9; i++) { const s = data[i]; const nm = s ? (ally ? C.pcName(s.key) : C.mobName(s.key)) : ''; const sub = s ? (ally ? `${s.grade}등급 · 레벨 ${s.level}` : `레벨 ${s.level}`) : '비어 있음'; h += `<button class="slot ${s ? 'filled' : ''} ${sel === i ? 'sel' : ''}" data-side="${ally ? 'a' : 'e'}" data-pos="${i}"><span class="pos">${i + 1}</span>${s ? `<span class="nm">${esc(nm)}</span>` : ''}<span class="sub">${esc(sub)}</span></button>`; }
      return h + '</div>';
    };
    const editor = (ally) => {
      const data = ally ? st.ally : st.enemy, sel = ally ? P.selA : P.selE;
      if (sel === null) return '';
      const s = data[sel], listAll = ally ? C.PCS : C.MOBS;
      const opts = (q) => '<option value="">(비우기)</option>' + listAll.filter((p) => !q || (p.key + ' ' + p.name).toLowerCase().includes(q) || (s && s.key === p.key)).slice(0, 400).map((p) => `<option value="${p.key}" ${s && s.key === p.key ? 'selected' : ''}>${esc(p.name)}${ally ? ` · ${p.startGrade}성` : ''}</option>`).join('');
      let h = `<div class="editor" data-ed="${ally ? 'a' : 'e'}"><div class="row"><label>검색<input class="edSearch" placeholder="이름 검색" autocomplete="off"></label><label class="grow">${sel + 1}번 칸<select class="edKey">${opts('')}</select></label>`;
      if (s) h += `<label>칸 이동<select class="edMove">${[0, 1, 2, 3, 4, 5, 6, 7, 8].map((i) => `<option value="${i}" ${i === sel ? 'selected' : ''}>${i + 1}번 ${(ally ? COLS_ALLY : COLS_ENEMY)[i % 3]}${data[i] && i !== sel ? ' (교체)' : ''}</option>`).join('')}</select></label>`;
      h += '</div>';
      if (s && ally) { const p = C.PCMAP[s.key] || {}; const grades = []; for (let g = p.startGrade || 1; g <= (p.maxGrade || 5); g++) grades.push(g); h += `<div class="row"><label>등급<select class="edGrade">${grades.map((g) => `<option ${g === s.grade ? 'selected' : ''}>${g}</option>`).join('')}</select></label><label>레벨<input type="number" class="edLv" min="1" max="120" value="${s.level}"></label><label class="grow">스킬 레벨(쉼표)<input class="edSk" value="${(s.skillLevels || []).join(',')}"></label></div><div class="note">${esc(C.ROLE_KO[p.role] || '')} · ${esc(C.CLASS_KO[p.cls] || '')}</div>`; }
      else if (s) { const m = C.MOBMAP[s.key] || {}; h += `<div class="row"><label>레벨<input type="number" class="edLv" min="1" max="200" value="${s.level}"></label></div><div class="note">${esc(C.ROLE_KO[m.role] || '')} ${esc(C.CLASS_KO[m.cls] || '')}</div>`; }
      return h + '</div>';
    };
    const bgNames = ['도로','마을','기지','해변','야영지','절벽','해안','숲','격납고','병원','등대','둥지','밤의 절벽','매점','하늘'];
    const bgs = ['route', 'town', 'base', 'beach', 'camp', 'cliff', 'coast', 'forest', 'hangar', 'hospital', 'lighttower', 'nest', 'nightcliff', 'px', 'sky'];
    el.innerHTML = `
      <div class="row"><button class="primary" id="btnStart">${S.battle ? '다시 시작' : '전투 시작'}</button><button id="btnStep" ${!S.battle || S.battle.result || S.playing ? 'disabled' : ''}>다음 행동</button><button id="btnPlay" ${!S.battle || S.battle.result ? 'disabled' : ''}>${S.playing ? '일시 정지' : '자동 진행'}</button><button id="btnReset" ${S.battle ? '' : 'disabled'}>초기화</button></div>
      <div class="row"><input type="hidden" id="seed" value="${st.seed}"><input type="hidden" id="maxActions" value="${st.maxActions}"><label>연출 속도<select id="speed">${[['1', '실시간(인게임과 같음)'], ['2', '2배속'], ['3', '5배속'], ['4', '최대(연출 없음)']].map(([v, n]) => `<option value="${v}" ${+st.speed === +v ? 'selected' : ''}>${n}</option>`).join('')}</select></label><label>배경<select id="bg">${bgs.map((b,i) => `<option value="${b}" ${st.bg === b ? 'selected' : ''}>${bgNames[i]}</option>`).join('')}</select></label><label>화면 해상도<select id="aspect"><option value="auto" ${st.autoResolution !== false ? 'selected' : ''}>창 크기에 맞춤</option>${[['1920', '16:9 (1920×1080)'], ['2340', '19.5:9 (2340×1080)'], ['2400', '20:9 (2400×1080)']].map(([v, n]) => `<option value="${v}" ${st.autoResolution === false && +st.aspect === +v ? 'selected' : ''}>${n}</option>`).join('')}</select></label></div>
      <h3>아군 배치 <span class="note">최대 5명</span></h3>${grid(true)}${editor(true)}
      <div class="row"><label>일괄 레벨<input type="number" id="allyLv" min="1" max="120" value="50"></label><label>일괄 스킬 레벨<input type="number" id="allySk" min="1" max="10" value="5"></label><button id="allyBulk">적용</button></div>
      <h3>적 배치</h3>${grid(false)}${editor(false)}
      <div class="row"><label>일괄 레벨<input type="number" id="enemyLv" min="1" max="200" value="70"></label><button id="enemyBulk">적용</button><button id="resetDefault">기본 배치로</button></div>
      <div class="note">실험 항목을 켜고 끄며 전투의 차이를 비교해 보세요.</div>`;
    $('btnStart').addEventListener('click', () => C.startBattle());
    $('btnStep').addEventListener('click', () => C.stepOnce());
    $('btnPlay').addEventListener('click', () => { if (S.playing) C.stopPlay(); else { C.setAuto(true); if (!S.battle) C.startBattle(); else if (!S.playing) C.startPlay(); } });
    $('btnReset').addEventListener('click', () => C.resetBattle(false));
    $('seed').addEventListener('change', (e) => { st.seed = +e.target.value || 1; C.saveSetup(); });
    $('maxActions').addEventListener('change', (e) => { st.maxActions = +e.target.value || 2000; C.saveSetup(); });
    $('speed').addEventListener('change', (e) => { st.speed = +e.target.value; C.saveSetup(); });
    $('bg').addEventListener('change', (e) => { st.bg = e.target.value; C.saveSetup(); });
    $('aspect').addEventListener('change', (e) => { st.autoResolution = e.target.value === 'auto'; if (!st.autoResolution) st.aspect = +e.target.value; C.saveSetup(); if (window.SCENE) SCENE.setWidth(st.autoResolution ? 0 : st.aspect); });
    el.querySelectorAll('.slot').forEach((b) => b.addEventListener('click', () => { if (b.dataset.side === 'a') P.selA = +b.dataset.pos; else P.selE = +b.dataset.pos; const ally = b.dataset.side === 'a', pos = +b.dataset.pos, spec = (ally ? st.ally : st.enemy)[pos]; if (spec) { const unit = ally ? L.stats.buildPC({ ...spec, gridPos: pos }) : L.stats.buildMonster(spec.key, spec.level, { gridPos: pos }); C.inspect({ kind: 'unit', unit, setup: true }); } renderSetup(el); }));
    el.querySelectorAll('.editor').forEach((ed) => {
      const ally = ed.dataset.ed === 'a', data = ally ? st.ally : st.enemy, sel = ally ? P.selA : P.selE, s = data[sel], listAll = ally ? C.PCS : C.MOBS;
      ed.querySelector('.edSearch').addEventListener('input', (ev) => { const q = ev.target.value.trim().toLowerCase(); const cur = ed.querySelector('.edKey').value; ed.querySelector('.edKey').innerHTML = '<option value="">(비우기)</option>' + listAll.filter((p) => !q || (p.key + ' ' + p.name).toLowerCase().includes(q) || p.key === cur).slice(0, 400).map((p) => `<option value="${p.key}" ${cur === p.key ? 'selected' : ''}>${esc(p.name)}</option>`).join(''); });
      ed.querySelector('.edKey').addEventListener('change', (ev) => { const k = ev.target.value; if (!k) delete data[sel]; else if (ally) { if (Object.keys(data).length >= 5 && !data[sel]) { C.emit('status', '아군은 최대 5명입니다.'); ev.target.value = ''; return; } data[sel] = C.newAllySpec(k, (data[sel] || {}).level || 50); } else data[sel] = { key: k, level: (data[sel] || {}).level || 70 }; C.saveSetup(); renderSetup(el); });
      const mv = ed.querySelector('.edMove'); if (mv) mv.addEventListener('change', (ev) => { const to = +ev.target.value; if (to === sel) return; const other = data[to]; data[to] = data[sel]; if (other) data[sel] = other; else delete data[sel]; if (ally) P.selA = to; else P.selE = to; C.saveSetup(); renderSetup(el); });
      if (!s) return;
      const upd = () => { s.level = Math.max(1, Math.min(ally ? 120 : 200, +ed.querySelector('.edLv').value || 1)); if (ally) { s.grade = +ed.querySelector('.edGrade').value; s.skillLevels = ed.querySelector('.edSk').value.split(',').map((x) => parseInt(x, 10)).filter((x) => x > 0); } C.saveSetup(); renderSetup(el); };
      ed.querySelectorAll('.edLv, .edGrade, .edSk').forEach((x) => x.addEventListener('change', upd));
    });
    $('allyBulk').addEventListener('click', () => { const lv = +$('allyLv').value || 1, sk = +$('allySk').value || 1; for (const s of Object.values(st.ally)) { s.level = lv; s.skillLevels = new Array((s.skillLevels || []).length || 5).fill(sk); } C.saveSetup(); renderSetup(el); });
    $('enemyBulk').addEventListener('click', () => { const lv = +$('enemyLv').value || 1; for (const e of Object.values(st.enemy)) e.level = lv; C.saveSetup(); renderSetup(el); });
    $('resetDefault').addEventListener('click', () => { C.defaultSetup(); P.selA = P.selE = null; C.saveSetup(); renderSetup(el); });
  }

  // ---------------------------------------------------------------- 기록 창
  function renderLog(el) {
    el.innerHTML = `<div class="row"><label class="inl"><input type="checkbox" id="logOnlySys"> 시험 시스템 기록만</label><button id="logClear">비우기</button></div><div class="log" id="logList"></div>`;
    const list = el.querySelector('#logList');
    const fill = () => { const only = el.querySelector('#logOnlySys').checked; list.innerHTML = C.S.log.filter((l) => !only || l.kind === 'sys' || l.kind === 'stage').map((l) => `<div class="th th-${l.kind}">${l.html}</div>`).join('') || '<div class="th th-stage">전투 시작을 누르면 행동과 시험 시스템 동작이 여기에 쌓입니다.</div>'; };
    el.querySelector('#logOnlySys').addEventListener('change', fill);
    el.querySelector('#logClear').addEventListener('click', () => { C.S.log.length = 0; fill(); });
    C.on('log', fill); C.on('battle', fill); fill();
  }

  // ---------------------------------------------------------------- 예측 표 창
  function renderIntents(el) {
    const fill = () => {
      const b = C.S.battle;
      if (!b) { el.innerHTML = '<div class="note">전투를 시작하면 적이 다음에 할 행동을 확인할 수 있습니다.</div>'; return; }
      if (!C.sysOn('intent')) { el.innerHTML = '<div class="note">적 행동 예측 표시가 꺼져 있습니다.</div>'; return; }
      const rows = C.intentMarkers().map((m) => `<tr><td>${esc(C.unitName(m.enemy))}</td><td>${m.enemy.gridPos + 1}</td><td class="n">${Math.round(m.enemy.turnPos)}</td><td>${esc(m.isWait ? '대기' : m.isMove ? '이동' : C.skillName(m.skillKey))}</td><td>${esc(m.target ? `${C.unitName(m.target)} (${m.target.gridPos + 1}번)` : m.targetGridPos !== 255 ? `${m.targetGridPos + 1}번 칸` : '-')}</td><td>${m.enemy.lockedIntent ? '<span class="pill" style="color:var(--it)">고정</span>' : '<span class="pill">예측</span>'}</td></tr>`);
      el.innerHTML = `<div class="note">${C.optOn('intent', 'lock') ? '예고한 적 행동을 유지합니다. 대상이 사라지면 다른 대상을 선택하거나 대기합니다.' : '적의 차례가 되면 예고한 행동이 달라질 수 있습니다.'}</div><div class="tablewrap"><table><thead><tr><th>몬스터</th><th>칸</th><th class="n">행동력</th><th>다음 행동</th><th>대상</th><th>상태</th></tr></thead><tbody>${rows.join('') || '<tr><td colspan="6" class="note">살아 있는 몬스터가 없습니다.</td></tr>'}</tbody></table></div>
        `;
    };
    C.on('intents', fill); C.on('battle', fill); C.on('manual', fill); fill();
  }

  // 선택 정보 창: 전투판과 배치 창 어느 쪽에서 눌러도 같은 정보로 연결한다.
  function renderInspector(el) {
    let selected = C.inspected;
    const pct = v => (100 * (Number(v) || 0)).toFixed(1) + '%';
    const value = v => Number.isFinite(Number(v)) ? Number(v).toLocaleString('ko-KR', { maximumFractionDigits: 2 }) : '—';
    const rows = list => '<table class="inspect-stats"><tbody>' + list.map(([k,v]) => `<tr><th>${esc(k)}</th><td>${esc(String(v))}</td></tr>`).join('') + '</tbody></table>';
    const clean = text => String(text || '').replace(/<[^>]*>/g, '').replace(/\[(?:[a-fA-F0-9]{6}|-)\]/g, '');
    const fill = () => {
      if (!selected) { el.innerHTML = '<div class="note">전투판의 캐릭터·몬스터나 스킬 버튼을 누르면 정보가 표시됩니다. 배치 창의 유닛을 눌러도 확인할 수 있습니다.</div>'; return; }
      const u = selected.unit;
      const stale = !selected.setup && u && C.S.battle && !C.S.battle.allUnits.includes(u);
      const note = selected.setup ? '<div class="note">배치 기준 능력치입니다. 전투 중 효과는 포함되지 않습니다.</div>' : stale || (!selected.setup && !C.S.battle) ? '<div class="note">이전 전투에서 선택한 정보입니다.</div>' : '';
      let html = note;
      if (selected.kind === 'skill') {
        const sk = selected.skill, lv = sk.levelTable || {}, tbl = sk.table || {}, passive = num(tbl,'SkillType') === 1;
        const descKey = tbl.SkillDescriptionSimple || tbl.SkillDescription;
        const description = descKey ? L.name(descKey, '') : '';
        html += `<h3>${esc(C.skillName(sk.key))}</h3><div class="note">${u ? esc(C.unitName(u)) + ' · ' : ''}${passive ? '지속 효과' : '스킬 ' + C.slotOf(sk)} · 레벨 ${sk.level || 1}</div>`;
        if (description && description !== descKey && !/[{}]/.test(description)) html += `<p>${esc(clean(description))}</p>`;
        html += rows([['대상', C.TT_KO[num(tbl,'TargetType')] || '대상 없음'], ['소모 행동력', num(lv,'NeedActionPoint')], ['사거리', u && !passive ? L.combat.skillDistance(u, sk, {}) : num(lv,'Distance')], ['공격 배율', pct(num(lv,'SkillAttackRate'))], ['속성', ['물리','화염','냉기','전기'][num(lv,'MagicSkillAttrType')] || '기타'], ['재사용 대기', C.cooldownTurns(sk) + '턴'], ['남은 재사용 대기', (sk.cooldownLeft || 0) + '턴']]);
        const effects = u ? C.effectsOf(u, sk).filter(e => !/^Effect_/.test(e.text || e.name)) : [];
        const seen = new Set();
        const readableEffects = effects.filter(e => { const key = [e.text || e.name, e.target, Math.min(1,e.rate), e.turns].join('|'); if (seen.has(key)) return false; seen.add(key); return true; });
        html += '<h3>효과</h3>' + (readableEffects.length ? '<ul>' + readableEffects.map(e => `<li>${esc(clean(e.text || e.name))}<div class="note">${esc(e.target)}${e.rate ? ' · 확률 ' + pct(Math.min(1,e.rate)) : ''}${e.turns > 0 ? ' · ' + e.turns + '턴' : ''}</div></li>`).join('') + '</ul>' : '<div class="note">표시할 효과 설명이 없습니다.</div>');
        if (u) html += '<button data-inspect-owner>사용자 정보 보기</button>';
      } else if (u) {
        const st = L.stats, tbl = u.table || {};
        html += `<h3>${esc(C.unitName(u))}</h3><div class="note">${u.team === 1 ? '아군' : '적'} · ${esc(C.CLASS_KO[num(tbl,'ActorClassType')] || '')} · ${esc(C.ROLE_KO[num(tbl,'RoleType')] || '')}</div>`;
        html += rows([['레벨',u.level],['배치',u.gridPos + 1 + '번 칸'],['체력',value(Math.max(0,u.hp)) + ' / ' + value(u.maxHp)],['행동력',value(u.turnPos || 0) + ' / 100'],['공격력',value(st.getAtk(u))],['방어력',value(st.getDef(u))],['행동 속도',value(st.getTurnSpeed(u))],['적중률',pct(st.getApply(u))],['회피율',pct(st.getEvade(u))],['치명타 확률',pct(st.getCri(u))]]);
        html += '<h3>보유 스킬</h3>' + (u.skills || []).map((sk,i) => `<button class="inspect-skill" data-inspect-skill="${i}">${esc(C.skillName(sk.key))} <span class="note">레벨 ${sk.level || 1}${sk.cooldownLeft ? ' · 대기 ' + sk.cooldownLeft + '턴' : ''}</span></button>`).join('');
        const buffs = u.buffs || [];
        html += '<h3>현재 효과</h3>' + (buffs.length ? '<ul>' + buffs.map(b => `<li>${esc(C.buffName(b.key))}${b.left > 0 ? ' · 남은 ' + b.left + '턴' : ''}</li>`).join('') + '</ul>' : '<div class="note">적용 중인 효과가 없습니다.</div>');
      }
      const body = el.closest('.win-body'), scroll = body ? body.scrollTop : 0;
      el.innerHTML = html;
      if (body) body.scrollTop = scroll;
      el.querySelectorAll('[data-inspect-skill]').forEach(btn => btn.addEventListener('click', () => C.inspect({ kind:'skill', unit:u, skill:u.skills[+btn.dataset.inspectSkill], setup:selected.setup })));
      const back = el.querySelector('[data-inspect-owner]'); if (back) back.addEventListener('click', () => C.inspect({ kind:'unit', unit:u, setup:selected.setup }));
    };
    C.on('inspect', item => { selected = item; fill(); const body = el.closest('.win-body'); if (body) body.scrollTop = 0; });
    C.on('battle', fill); fill();
  }
  window.PANELS = { renderInspector, renderSystems, renderSetup, renderLog, renderIntents };
})();
