// UI + worker pool + Claude tools for the LO battle simulator.
(function () {
  const $ = (id) => document.getElementById(id);
  const L = window.LOSim;
  const state = { mode: 'stage', chapter: '', stageKey: '', squad: {}, sel: null, last: null, sweep: null, busy: false };
  const OUTCOMES = ['win', 'lose', 'stuck', 'error', 'timeout'];
  const OUT_KO = { win: '승리', lose: '패배', stuck: '진행불가', error: '오류(크래시)', timeout: '시간초과' };
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const setStatus = (t) => { $('status').textContent = t; };

  // ---------- data indexes ----------
  let STAGES = {}, CHAPTERS = {}, PCS = [], PCMAP = {}, META = null;
  function buildIndexes() {
    const T = (t) => L.T(t) || {};
    const chapName = {};
    for (const c of Object.values(T('Table_MapChapter'))) chapName[c.Key] = L.name(c.ChapterName, c.Key);
    const mk = (mode, rows, chapOf, idxOf, nameOf, wavesOf) => {
      const list = [];
      for (const r of Object.values(rows)) {
        const waves = wavesOf(r);
        if (!waves) continue;
        const ch = chapOf(r);
        list.push({ key: r.Key, mode, chapter: ch, chapterName: chapName[ch] || ch, idx: idxOf(r), name: nameOf(r), waves });
      }
      return list;
    };
    const wavesStage = (r) => { let n = 0; for (let i = 1; i <= 9; i++) if (L.list(r, 'WaveMobGroup' + i).length) n++; if (L.list(r, 'BossMobGroup').length) n++; return n; };
    const wavesEW = (r) => { let n = 0; for (let i = 1; i <= 9; i++) if (L.list(r, 'WaveMobGroup' + i).length) n++; return n; };
    STAGES = {
      stage: mk('stage', T('Table_MapStage'), (r) => r.ChapterIndex || '기타', (r) => r.StageIdxString || r.Key, (r) => L.name(r.StageName, ''), wavesStage),
      ew: mk('ew', T('Table_MapStageEW'), (r) => 'EW ' + (L.str(r, 'Stage_Chapter') || L.str(r, 'Chapter_Num') || '?'), (r) => (L.str(r, 'Stage_Num') || r.Key), (r) => L.name(r.StageName, ''), wavesEW),
      iw: mk('iw', T('Table_MapStageIW'), (r) => 'IW ' + (L.str(r, 'SeasonIWKey') || '?'), (r) => r.Key, (r) => '', (r) => (L.list(r, 'IW_MobGroup').length ? 1 : 0)),
    };
    CHAPTERS = {};
    for (const m in STAGES) {
      CHAPTERS[m] = [];
      const seen = new Set();
      for (const s of STAGES[m]) if (!seen.has(s.chapter)) { seen.add(s.chapter); CHAPTERS[m].push({ key: s.chapter, name: s.chapterName }); }
    }
    PCS = Object.values(T('Table_PC')).filter((p) => L.num(p, 'IsUse') === 1 && L.num(p, 'IsHavingTurn') === 1)
      .map((p) => ({ key: p.Key, name: L.name(p.Name, p.Key), startGrade: L.num(p, 'StartGrade', 1), maxGrade: L.num(p, 'MaxGrade', 5), cls: L.num(p, 'ActorClassType'), role: L.num(p, 'RoleType') }))
      .filter((p) => !/Dummy|Test/i.test(p.key) && !/더미|테스트/.test(p.name))
      .sort((a, b) => a.name.localeCompare(b.name, 'ko'));
    PCMAP = Object.fromEntries(PCS.map((p) => [p.key, p]));
  }
  const findStage = (key) => { for (const m in STAGES) { const s = STAGES[m].find((x) => x.key === key); if (s) return s; } return null; };

  // ---------- squad ----------
  function specFor(key) {
    if (L.stats && L.stats.defaultSpec) { try { return L.stats.defaultSpec(key); } catch (e) { /* fall through */ } }
    const p = PCMAP[key] || {};
    return { key, grade: p.startGrade || 1, level: 1, skillLevels: [], equips: [] };
  }
  function squadList() {
    return Object.entries(state.squad).filter(([, s]) => s).map(([pos, s]) => Object.assign({}, s, { gridPos: +pos }));
  }
  function defaultSquad() {
    const picks = PCS.filter((p) => p.startGrade === 3 && !/모듈|MP$/.test(p.name)).slice(0, 5);
    const pos = [1, 4, 7, 3, 5];
    state.squad = {};
    picks.forEach((p, i) => { state.squad[pos[i]] = Object.assign(specFor(p.key), { level: 50 }); });
  }

  // ---------- render: stage ----------
  function renderChapters() {
    const list = CHAPTERS[state.mode] || [];
    $('chapter').innerHTML = list.map((c) => `<option value="${esc(c.key)}">${esc(c.name)} (${esc(c.key)})</option>`).join('');
    if (!list.find((c) => c.key === state.chapter)) state.chapter = list[0] ? list[0].key : '';
    $('chapter').value = state.chapter;
    renderStages();
  }
  function renderStages() {
    const list = (STAGES[state.mode] || []).filter((s) => s.chapter === state.chapter);
    $('stage').innerHTML = list.map((s) => `<option value="${esc(s.key)}">${esc(s.idx)} ${esc(s.name)} · ${s.waves}웨이브 (${esc(s.key)})</option>`).join('');
    if (!list.find((s) => s.key === state.stageKey)) state.stageKey = list[0] ? list[0].key : '';
    $('stage').value = state.stageKey;
    renderStageInfo();
  }
  function renderStageInfo() {
    const s = findStage(state.stageKey);
    $('stageInfo').textContent = s ? s.key : '';
    if (!s) { $('waves').textContent = ''; return; }
    if (s.mode === 'stage') {
      const r = L.T('Table_MapStage', s.key);
      const parts = [];
      for (let i = 1; i <= 10; i++) {
        const groups = i <= 9 ? L.list(r, 'WaveMobGroup' + i) : L.list(r, 'BossMobGroup');
        if (!groups.length) continue;
        const g = L.T('Table_MobGroup', groups[0]);
        const mobs = [];
        for (let j = 1; j <= 9; j++) { const m = L.str(g, 'mobIndexString' + j); if (m) mobs.push(`${L.name((L.T('Table_Monster', m) || {}).Name, m)} Lv${L.num(g, 'mobLevel' + j, 1)}`); }
        parts.push(`${i <= 9 ? 'W' + i : '보스'}${groups.length > 1 ? `(${groups.length}종 중 1)` : ''}: ${mobs.join(', ')}`);
      }
      $('waves').innerHTML = parts.map(esc).join('<br>') || '이 스테이지에는 웨이브 데이터가 없습니다.';
    } else $('waves').textContent = `${s.waves}웨이브`;
  }

  // ---------- render: squad ----------
  function renderGrid() {
    const g = $('grid');
    let h = '<div class="lbl"><span>후열</span><span>중열</span><span>전열</span></div>';
    // grid index 0..8: rows top->bottom, columns back->front (verify against StageMapData; labels only)
    for (let i = 0; i < 9; i++) {
      const s = state.squad[i];
      const p = s && PCMAP[s.key];
      h += `<button class="slot ${s ? 'filled' : ''} ${state.sel === i ? 'sel' : ''}" data-pos="${i}" aria-label="${i + 1}번 칸${p ? ' ' + esc(p.name) : ' 비어 있음'}">
        <span class="pos">${i + 1}</span>${p ? `<span class="nm">${esc(p.name)}</span><span class="sub">G${s.grade} · Lv${s.level}</span>` : '<span class="sub">비어 있음</span>'}</button>`;
    }
    g.innerHTML = h;
    g.querySelectorAll('.slot').forEach((b) => b.addEventListener('click', () => { state.sel = +b.dataset.pos; renderGrid(); renderEditor(); }));
    saveSettings();
  }

  // ---------- saved settings (this browser only) ----------
  const LS_KEY = 'lo-sim-settings-v1', LS_PRESETS = 'lo-sim-presets-v1';
  const PERSIST = ['runs', 'seed', 'maxActions', 'bulkLv', 'bulkSk', 'lvScenario', 'lvFrom', 'lvTo', 'lvStartLv', 'lvLvStep', 'lvMaxTry', 'lvSide', 'lvUseSquadLv', 'lvSpeed', 'lvOnlyIssues', 'lvExpAll'];
  const store = {
    get(k) { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* storage blocked: settings just are not kept */ } },
  };
  let restoring = true;
  function saveSettings() {
    if (restoring) return;
    const fields = {};
    for (const id of PERSIST) { const el = $(id); if (el) fields[id] = el.type === 'checkbox' ? el.checked : el.value; }
    store.set(LS_KEY, { squad: state.squad, mode: state.mode, chapter: state.chapter, stageKey: state.stageKey, fields });
  }
  function validSquad(sq) {
    const out = {};
    for (const [pos, s] of Object.entries(sq || {})) if (s && PCMAP[s.key] && +pos >= 0 && +pos <= 8) out[pos] = s;
    return out;
  }
  function restoreSettings() {
    const s = store.get(LS_KEY);
    if (!s) return false;
    const sq = validSquad(s.squad);
    if (Object.keys(sq).length) state.squad = sq;
    if (s.mode && STAGES[s.mode]) { state.mode = s.mode; state.chapter = s.chapter || ''; state.stageKey = s.stageKey || ''; $('mode').value = s.mode; }
    return s.fields || {};
  }
  function applyFields(fields) {
    for (const [id, v] of Object.entries(fields || {})) {
      const el = $(id);
      if (!el) continue;
      if (el.type === 'checkbox') el.checked = !!v; else if (el.tagName !== 'SELECT' || [...el.options].some((o) => o.value === v)) el.value = v;
      el.dispatchEvent(new Event(el.type === 'range' ? 'input' : 'change'));
    }
  }
  function renderPresets(selected) {
    const ps = store.get(LS_PRESETS) || {};
    $('presetSel').innerHTML = '<option value="">(선택)</option>' + Object.keys(ps).sort().map((n) => `<option ${n === selected ? 'selected' : ''}>${esc(n)}</option>`).join('');
  }
  function wirePresets() {
    $('presetSave').addEventListener('click', () => {
      const name = $('presetName').value.trim() || $('presetSel').value;
      if (!name) { setStatus('편성 이름을 입력하세요.'); return; }
      if (!squadList().length) { setStatus('빈 편성은 저장할 수 없습니다.'); return; }
      const ps = store.get(LS_PRESETS) || {};
      ps[name] = JSON.parse(JSON.stringify(state.squad));
      store.set(LS_PRESETS, ps); renderPresets(name); $('presetName').value = '';
      setStatus(`편성 "${name}" 저장됨`);
    });
    $('presetLoad').addEventListener('click', () => {
      const name = $('presetSel').value, ps = store.get(LS_PRESETS) || {};
      if (!name || !ps[name]) return;
      state.squad = validSquad(ps[name]); state.sel = null; renderGrid(); renderEditor();
      setStatus(`편성 "${name}" 불러옴`);
    });
    $('presetDel').addEventListener('click', () => {
      const name = $('presetSel').value, ps = store.get(LS_PRESETS) || {};
      if (!name || !ps[name]) return;
      delete ps[name]; store.set(LS_PRESETS, ps); renderPresets('');
      setStatus(`편성 "${name}" 삭제됨`);
    });
  }
  function equipOptions(pcKey, slot) {
    let keys = [];
    if (L.stats && L.stats.listEquipCandidates) { try { keys = L.stats.listEquipCandidates(pcKey, slot) || []; } catch (e) { keys = []; } }
    if (!keys.length) keys = Object.keys(L.T('Table_ItemEquip') || {});
    return keys.map((k) => ({ key: k, name: L.name((L.T('Table_ItemEquip', k) || {}).ItemName, k) }));
  }
  function renderEditor() {
    const ed = $('editor');
    if (state.sel === null) { ed.hidden = true; return; }
    ed.hidden = false;
    const s = state.squad[state.sel];
    const pcOpts = '<option value="">(비우기)</option>' + PCS.map((p) => `<option value="${p.key}" ${s && s.key === p.key ? 'selected' : ''}>${esc(p.name)} · ${p.startGrade}성 (${p.key})</option>`).join('');
    let h = `<div class="row"><label>전투원 검색<input id="edSearch" placeholder="이름 또는 키" autocomplete="off"></label><label class="grow">${state.sel + 1}번 칸 전투원<select id="edPc">${pcOpts}</select></label>`;
    if (s) h += `<label>배치 칸<select id="edMove">${[0, 1, 2, 3, 4, 5, 6, 7, 8].map((i) => { const o = state.squad[i]; return `<option value="${i}" ${i === state.sel ? 'selected' : ''}>${i + 1}번 ${['후열', '중열', '전열'][i % 3]}${o && i !== state.sel ? ' (' + esc((PCMAP[o.key] || {}).name || o.key) + '와 교체)' : ''}</option>`; }).join('')}</select></label>`;
    h += '</div>';
    if (s) {
      const p = PCMAP[s.key] || {};
      const grades = []; for (let gr = p.startGrade || 1; gr <= (p.maxGrade || 5); gr++) grades.push(gr);
      h += `<div class="row">
        <label>등급<select id="edGrade">${grades.map((gr) => `<option ${gr === s.grade ? 'selected' : ''}>${gr}</option>`).join('')}</select></label>
        <label>레벨<input type="number" id="edLv" min="1" max="120" value="${s.level}"></label>
        <label class="grow">스킬 레벨 (쉼표, 슬롯 순)<input id="edSk" value="${(s.skillLevels || []).join(',')}" placeholder="예: 10,10,10"></label>
        <label>코어링크<input type="number" id="edCore" min="0" max="5" value="${s.coreLink || 0}"></label>
      </div><div class="equips">`;
      for (let e = 0; e < 4; e++) {
        const cur = (s.equips || [])[e] || {};
        h += `<div class="eq"><select id="edEq${e}" aria-label="장비 ${e + 1}"><option value="">장비 ${e + 1} 없음</option>${equipOptions(s.key, e).map((o) => `<option value="${esc(o.key)}" ${cur.key === o.key ? 'selected' : ''}>${esc(o.name)}</option>`).join('')}</select>
          <input type="number" id="edEn${e}" min="0" max="10" value="${cur.enchant || 0}" aria-label="장비 ${e + 1} 강화"></div>`;
      }
      h += '</div>';
    }
    ed.innerHTML = h;
    $('edSearch').addEventListener('input', (ev) => {
      const q = ev.target.value.trim().toLowerCase();
      const cur = $('edPc').value;
      const list = PCS.filter((p) => !q || (p.key + ' ' + p.name).toLowerCase().includes(q) || p.key === cur);
      $('edPc').innerHTML = '<option value="">(비우기)</option>' + list.map((p) => `<option value="${p.key}" ${cur === p.key ? 'selected' : ''}>${esc(p.name)} · ${p.startGrade}성 (${p.key})</option>`).join('');
    });
    if ($('edMove')) $('edMove').addEventListener('change', (ev) => {
      const to = +ev.target.value, from = state.sel;
      if (to === from) return;
      const other = state.squad[to];
      state.squad[to] = state.squad[from];
      if (other) state.squad[from] = other; else delete state.squad[from];
      state.sel = to; renderGrid(); renderEditor();
    });
    $('edPc').addEventListener('change', (ev) => {
      const k = ev.target.value;
      if (!k) delete state.squad[state.sel];
      else if (Object.keys(state.squad).length >= 5 && !state.squad[state.sel]) { setStatus('분대는 최대 5명입니다.'); ev.target.value = ''; return; }
      else state.squad[state.sel] = Object.assign(specFor(k), { level: (state.squad[state.sel] || {}).level || 50 });
      renderGrid(); renderEditor();
    });
    if (!s) return;
    const upd = () => {
      s.grade = +$('edGrade').value; s.level = Math.max(1, Math.min(120, +$('edLv').value || 1));
      s.skillLevels = $('edSk').value.split(',').map((x) => parseInt(x, 10)).filter((x) => x > 0);
      s.coreLink = +$('edCore').value || 0;
      s.equips = [0, 1, 2, 3].map((e) => ({ key: $('edEq' + e).value, enchant: +$('edEn' + e).value || 0 })).filter((x) => x.key);
      renderGrid();
    };
    ed.querySelectorAll('select:not(#edPc), input').forEach((x) => x.addEventListener('change', upd));
  }

  // ---------- worker pool ----------
  const POOL = Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 4) - 1));
  let workers = [], jobSeq = 0, stopFlag = false;
  function pool() {
    if (workers.length) return workers;
    for (let i = 0; i < POOL; i++) { const w = new Worker('sim-worker.js'); w.postMessage({ type: 'init' }); workers.push(w); }
    return workers;
  }
  function runOnWorker(w, setup, runs, onProg) {
    return new Promise((res, rej) => {
      const id = ++jobSeq;
      const h = (ev) => {
        const m = ev.data; if (m.id !== id) return;
        if (m.type === 'progress') onProg && onProg(m.done);
        else if (m.type === 'result') { w.removeEventListener('message', h); res(m.results); }
        else if (m.type === 'error') { w.removeEventListener('message', h); rej(new Error(m.message)); }
      };
      w.addEventListener('message', h);
      w.postMessage({ type: 'run', id, setup, runs });
    });
  }
  async function simulate(setup, runs, onProg) {
    const ws = pool();
    const per = Math.ceil(runs / ws.length);
    const done = new Array(ws.length).fill(0);
    const jobs = ws.map((w, i) => {
      const n = Math.max(0, Math.min(per, runs - i * per));
      if (!n) return Promise.resolve([]);
      return runOnWorker(w, Object.assign({}, setup, { seed: setup.seed + i * per }), n, (d) => { done[i] = d; onProg && onProg(done.reduce((a, b) => a + b, 0)); });
    });
    return (await Promise.all(jobs)).flat();
  }
  function currentSetup(stageKey, extra) {
    const s = findStage(stageKey || state.stageKey) || { mode: state.mode };
    return Object.assign({ stageKey: stageKey || state.stageKey, mode: s.mode, squad: squadList(), seed: +$('seed').value || 1, options: { maxActions: +$('maxActions').value || 3000 } }, extra || {});
  }

  // ---------- summaries ----------
  function summarize(results) {
    const n = results.length || 1;
    const c = Object.fromEntries(OUTCOMES.map((o) => [o, 0]));
    const reasons = {}, errors = {};
    let act = 0, wave = 0, hp = 0, wins = 0;
    const units = {};
    for (const r of results) {
      c[r.outcome] = (c[r.outcome] || 0) + 1;
      act += r.totalActions || 0; wave += r.waveReached || 0;
      if (r.outcome === 'win') { wins++; hp += r.hpLeftPct || 0; }
      if (r.outcome === 'stuck' || r.outcome === 'timeout') reasons[r.reason || '?'] = (reasons[r.reason || '?'] || 0) + 1;
      for (const e of r.errors || []) { const k = String(e.message || e).slice(0, 160); errors[k] = (errors[k] || 0) + 1; }
      for (const u of r.perUnit || []) {
        const k = u.team + ':' + u.key;
        const a = units[k] || (units[k] = { key: u.key, name: u.name, team: u.team, n: 0, dmgDealt: 0, dmgTaken: 0, healDone: 0, kills: 0, actions: 0, died: 0 });
        a.n++; a.dmgDealt += u.dmgDealt || 0; a.dmgTaken += u.dmgTaken || 0; a.healDone += u.healDone || 0; a.kills += u.kills || 0; a.actions += u.actions || 0; if (!u.alive) a.died++;
      }
    }
    const top = (o) => Object.entries(o).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k, v]) => ({ reason: k, count: v }));
    const per = Object.values(units).filter((u) => u.team === 1).map((u) => ({ key: u.key, name: u.name, avgDmg: Math.round(u.dmgDealt / u.n), avgTaken: Math.round(u.dmgTaken / u.n), avgHeal: Math.round(u.healDone / u.n), avgKills: +(u.kills / u.n).toFixed(2), avgActions: +(u.actions / u.n).toFixed(1), deathRate: +(u.died / u.n).toFixed(2) }));
    return { runs: results.length, outcomes: c, winRate: +(c.win / n).toFixed(3), avgActions: Math.round(act / n), avgWaveReached: +(wave / n).toFixed(2), avgHpLeftPctOnWin: wins ? +(hp / wins).toFixed(1) : null, stuckReasons: top(reasons), errors: top(errors), squad: per };
  }
  function obar(c, n) {
    return `<div class="obar" role="img" aria-label="${OUTCOMES.map((o) => `${OUT_KO[o]} ${c[o] || 0}`).join(', ')}">${OUTCOMES.filter((o) => c[o]).map((o) => `<i style="width:${(c[o] / n) * 100}%;background:var(--${o === 'error' ? 'err' : o})" title="${OUT_KO[o]} ${c[o]}"></i>`).join('')}</div>`;
  }
  const legend = () => `<div class="legend">${OUTCOMES.map((o) => `<span><i style="background:var(--${o === 'error' ? 'err' : o})"></i>${OUT_KO[o]}</span>`).join('')}</div>`;
  function renderSummary(sum, stageKey) {
    const s = findStage(stageKey) || {};
    let h = `<div class="note">${esc(s.idx || '')} ${esc(s.name || '')} (${esc(stageKey)}) · ${sum.runs}회</div>
      <div class="kpis"><div class="kpi"><b>${(sum.winRate * 100).toFixed(1)}%</b><span>승률</span></div>
      <div class="kpi"><b>${sum.avgActions}</b><span>평균 행동 수</span></div>
      <div class="kpi"><b>${sum.avgWaveReached}</b><span>평균 도달 웨이브</span></div>
      <div class="kpi"><b>${sum.avgHpLeftPctOnWin == null ? '-' : sum.avgHpLeftPctOnWin + '%'}</b><span>승리 시 남은 HP</span></div></div>
      ${obar(sum.outcomes, sum.runs)}${legend()}`;
    if (sum.errors.length || sum.stuckReasons.length) {
      h += '<div class="tablewrap"><table><thead><tr><th>오류·진행불가 원인</th><th class="n">횟수</th></tr></thead><tbody>' +
        [...sum.errors.map((e) => `<tr><td><span class="pill o-error">오류</span> ${esc(e.reason)}</td><td class="n">${e.count}</td></tr>`), ...sum.stuckReasons.map((e) => `<tr><td><span class="pill o-stuck">진행불가</span> ${esc(e.reason)}</td><td class="n">${e.count}</td></tr>`)].join('') + '</tbody></table></div>';
    }
    h += '<div class="tablewrap"><table><thead><tr><th>전투원</th><th class="n">평균 피해</th><th class="n">받은 피해</th><th class="n">회복</th><th class="n">처치</th><th class="n">행동</th><th class="n">사망률</th></tr></thead><tbody>' +
      sum.squad.map((u) => `<tr><td>${esc(u.name)}</td><td class="n">${u.avgDmg.toLocaleString()}</td><td class="n">${u.avgTaken.toLocaleString()}</td><td class="n">${u.avgHeal.toLocaleString()}</td><td class="n">${u.avgKills}</td><td class="n">${u.avgActions}</td><td class="n">${Math.round(u.deathRate * 100)}%</td></tr>`).join('') + '</tbody></table></div>';
    $('paneSum').innerHTML = h;
  }
  function renderSweep(rows) {
    let h = legend() + '<div class="tablewrap"><table><thead><tr><th>스테이지</th><th class="n">승률</th><th>결과 분포</th><th class="n">평균 행동</th><th class="n">진행불가</th><th class="n">오류</th><th>주요 원인</th></tr></thead><tbody>';
    for (const r of rows) {
      const s = findStage(r.stageKey) || {};
      const why = (r.summary.errors[0] && r.summary.errors[0].reason) || (r.summary.stuckReasons[0] && r.summary.stuckReasons[0].reason) || '';
      h += `<tr><td>${esc(s.idx || r.stageKey)} <span class="note">${esc(r.stageKey)}</span></td><td class="n">${(r.summary.winRate * 100).toFixed(0)}%</td><td style="min-width:120px">${obar(r.summary.outcomes, r.summary.runs)}</td><td class="n">${r.summary.avgActions}</td><td class="n">${r.summary.outcomes.stuck || 0}</td><td class="n">${r.summary.outcomes.error || 0}</td><td>${esc(why.slice(0, 80))}</td></tr>`;
    }
    $('paneSweep').innerHTML = h + '</tbody></table></div>';
  }
  function renderLog(r) {
    const lines = (r.log || []).slice(0, 2500).map((e) => {
      const { round, t, ...rest } = e;
      return `[${String(round).padStart(3)}] ${t.padEnd(8)} ${JSON.stringify(rest)}`;
    });
    $('paneLog').innerHTML = `<div class="note">결과: <span class="pill o-${r.outcome}">${OUT_KO[r.outcome] || r.outcome}</span> ${esc(r.reason || '')} · 행동 ${r.totalActions || 0} · 시드 ${r.seed}</div><div class="log">${esc(lines.join('\n')) || '로그 없음'}</div>`;
  }
  function showTab(t) {
    document.querySelectorAll('.tabs button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === t)));
    document.querySelectorAll('[data-pane]').forEach((p) => { p.hidden = p.dataset.pane !== t; });
  }

  // ---------- actions ----------
  function setBusy(b) { state.busy = b; ['btnRun', 'btnOne', 'btnSweep'].forEach((id) => { $(id).disabled = b; }); $('btnStop').disabled = !b; if (!b) $('progBar').style.width = '0'; }
  const prog = (d, n) => { $('progBar').style.width = Math.min(100, (d / n) * 100) + '%'; };
  async function doRun(stageKey, runs) {
    if (!squadList().length) throw new Error('분대에 전투원이 없습니다.');
    const setup = currentSetup(stageKey);
    const res = await simulate(setup, runs, (d) => prog(d, runs));
    const sum = summarize(res);
    state.last = { stageKey: setup.stageKey, summary: sum };
    saveRun({ kind: 'run', stageKey: setup.stageKey, summary: sum });
    return sum;
  }
  async function doSweep(stageKeys, runs) {
    if (!squadList().length) throw new Error('분대에 전투원이 없습니다.');
    stopFlag = false;
    const rows = [];
    for (let i = 0; i < stageKeys.length && !stopFlag; i++) {
      setStatus(`챕터 실행 중 ${i + 1}/${stageKeys.length} · ${stageKeys[i]}`);
      const res = await simulate(currentSetup(stageKeys[i]), runs);
      rows.push({ stageKey: stageKeys[i], summary: summarize(res) });
      prog(i + 1, stageKeys.length);
      renderSweep(rows);
    }
    state.sweep = rows;
    saveRun({ kind: 'sweep', stageKeys, summary: rows.map((r) => ({ stageKey: r.stageKey, winRate: r.summary.winRate, outcomes: r.summary.outcomes, avgActions: r.summary.avgActions, topIssue: (r.summary.errors[0] || r.summary.stuckReasons[0] || {}).reason || '' })) });
    return rows;
  }
  function wire() {
    $('mode').addEventListener('change', (e) => { state.mode = e.target.value; renderChapters(); });
    $('chapter').addEventListener('change', (e) => { state.chapter = e.target.value; renderStages(); saveSettings(); });
    $('stage').addEventListener('change', (e) => { state.stageKey = e.target.value; renderStageInfo(); saveSettings(); });
    $('bulkApply').addEventListener('click', () => { const lv = +$('bulkLv').value || 1, sk = +$('bulkSk').value || 1; for (const s of Object.values(state.squad)) { s.level = lv; const n = (L.stats && s.skillLevels && s.skillLevels.length) || 5; s.skillLevels = new Array(n).fill(sk); } renderGrid(); renderEditor(); });
    $('clearSquad').addEventListener('click', () => { state.squad = {}; state.sel = null; renderGrid(); renderEditor(); });
    document.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));
    $('btnRun').addEventListener('click', async () => {
      setBusy(true); showTab('sum');
      try { const runs = Math.max(1, Math.min(2000, +$('runs').value || 1)); setStatus('실행 중…'); renderSummary(await doRun(state.stageKey, runs), state.stageKey); setStatus('완료'); }
      catch (e) { setStatus('실패: ' + e.message); } finally { setBusy(false); }
    });
    $('btnOne').addEventListener('click', async () => {
      setBusy(true); showTab('log');
      try { const ws = pool(); const [r] = await runOnWorker(ws[0], currentSetup(null, { logEnabled: true }), 1); renderLog(r); setStatus('완료'); }
      catch (e) { setStatus('실패: ' + e.message); } finally { setBusy(false); }
    });
    $('btnSweep').addEventListener('click', async () => {
      setBusy(true); showTab('sweep');
      try { const keys = (STAGES[state.mode] || []).filter((s) => s.chapter === state.chapter).map((s) => s.key); await doSweep(keys, Math.max(1, Math.min(500, +$('runs').value || 20))); setStatus('챕터 실행 완료'); }
      catch (e) { setStatus('실패: ' + e.message); } finally { setBusy(false); }
    });
    $('btnStop').addEventListener('click', () => { stopFlag = true; workers.forEach((w) => w.terminate()); workers = []; setBusy(false); setStatus('중지됨'); });
  }

  // ---------- db: run history ----------
  let db = null;
  async function saveRun(rec) {
    if (!db) return;
    try { await db.collection('runs').add(Object.assign({ at: Date.now(), squad: squadList().map((s) => ({ key: s.key, gridPos: s.gridPos, grade: s.grade, level: s.level, skillLevels: s.skillLevels, equips: s.equips })) }, rec)); } catch (e) { /* history is optional */ }
  }
  function renderHist(docs) {
    if (!docs.length) { $('paneHist').innerHTML = '<p class="note">저장된 실행 기록이 없습니다.</p>'; return; }
    $('paneHist').innerHTML = '<div class="tablewrap"><table><thead><tr><th>시각</th><th>종류</th><th>스테이지</th><th class="n">승률</th><th>분대</th></tr></thead><tbody>' + docs.map((d) => {
      const r = d.data() || {};
      const wr = r.kind === 'run' ? ((r.summary && r.summary.winRate) * 100).toFixed(0) + '%' : (r.summary || []).length + '개 스테이지';
      return `<tr><td>${esc(new Date(r.at).toLocaleString('ko-KR'))}</td><td>${r.kind === 'run' ? '단일' : '챕터'}</td><td>${esc(r.stageKey || (r.stageKeys || [])[0] + ' …')}</td><td class="n">${esc(wr)}</td><td>${esc((r.squad || []).map((s) => (PCMAP[s.key] || {}).name || s.key).join(', '))}</td></tr>`;
    }).join('') + '</tbody></table></div>';
  }

  // ---------- tools Claude may call while writing an extra-analysis report ----------
  // Pure: they never change the squad/stage shown on the page.
  // what-if overrides: Claude may force table values / engine constants for one simulation (reverted afterwards)
  function overrideDoc() {
    const L = window.LOSim, E = (L && L.E) || {};
    const mx = (E.BUFF_OVERLAP_TYPE || {}).__MAX__;
    return 'overrides (optional): array of what-if rules applied ONLY to this run and reverted afterwards. Rule: {table, keys?: "*"|key|[keys] (default all rows), where?: {field: value|[values]} (field may end with * = any field with that prefix; a missing field counts as 0), field (may end with *), op: set|mul|add|clear (default set), value}. Or {const: "ACTIVE_ROUND", value}. '
      + 'Example, cap stacking of every buff that has an unlimited (__MAX__) overlap slot: {table:"Table_BuffEffect", where:{"BuffEffectOverlapType*":' + (mx === undefined ? 4 : mx) + ', BuffEffectOverlapMax:0}, field:"BuffEffectOverlapMax", value:1}. One buff only: {table:"Table_BuffEffect", keys:"Effect_3P_Hirume_N_41", field:"BuffEffectOverlapMax", value:1}. Halve a value: {..., field:"BuffEffectValue1", op:"mul", value:0.5}. '
      + 'BUFF_OVERLAP_TYPE=' + JSON.stringify(E.BUFF_OVERLAP_TYPE || {}) + '. Use query_table to find table/field names and preview_overrides to check which rows change. compareBaseline:true also runs the unmodified data with the same seeds.';
  }
  // tool descriptions are capped at 1 KB by the sample runtime; the long override manual lives in the parameter schema (4 KB cap)
  const OV_HINT = 'overrides (optional) forces what-if data/rule changes for this run only; see the overrides parameter.';
  const ovSchema = () => ({ type: 'array', items: { type: 'object' }, description: overrideDoc() });
  const ovList = (o) => (Array.isArray(o) ? o : o ? [o] : []);
  // validate on the main thread (throws on bad table/const); returns the change summary
  function checkOverrides(ov) {
    ov = ovList(ov);
    if (!ov.length) return null;
    const a = window.LOSim.applyOverrides(ov); a.revert();
    const out = a.summary.map((s) => ({ rule: s.rule, changedRows: s.rows, sample: s.sample.slice(0, 5) }));
    if (out.every((c) => !c.changedRows)) throw new Error('overrides matched no rows (check table/field/where with query_table): ' + JSON.stringify(ov));
    return out;
  }
  function queryTable(i) {
    const L = window.LOSim, D = L.data;
    if (!i.table) return { tables: Object.fromEntries(['stages', 'units', 'skills', 'buffs'].flatMap((g) => Object.entries(D[g] || {}).map(([t, v]) => [t, Object.keys(v).length]))), note: 'Rows are compacted: fields with default values (0, "", "0") are omitted.' };
    const t = L.T(i.table);
    if (!t) throw new Error('unknown table ' + i.table);
    const lim = Math.max(1, Math.min(60, +i.limit || 15));
    const pick = (row) => {
      if (!Array.isArray(i.fields) || !i.fields.length) return row;
      const o = { Key: row.Key };
      for (const f of i.fields) { if (f.endsWith('*')) { for (const k in row) if (k.startsWith(f.slice(0, -1))) o[k] = row[k]; } else if (f in row) o[f] = row[f]; }
      return o;
    };
    const keys = i.key ? (Array.isArray(i.key) ? i.key : [i.key]).map(String) : Object.keys(t);
    const txt = i.contains ? String(i.contains).toLowerCase() : '';
    const rows = [], fieldSet = new Set();
    let total = 0;
    for (const k of keys) {
      const row = t[k];
      if (!row) continue;
      if (i.where && !Object.entries(i.where).every(([f, w]) => L.ovMatch(row, f, w))) continue;
      if (txt && !(k.toLowerCase().includes(txt) || String(L.name(row.Name || '', '')).toLowerCase().includes(txt))) continue;
      total++;
      for (const f in row) fieldSet.add(f);
      if (rows.length < lim) rows.push(Object.assign(pick(row), row.Name ? { _name: L.name(row.Name, '') } : {}));
    }
    return { table: i.table, matched: total, shown: rows.length, fields: [...fieldSet].sort().slice(0, 150), rows };
  }
  function overrideTools() {
    return [{
      name: 'query_table',
      description: 'Read game data tables used by the simulator. No table = list table names with row counts. With table: rows filtered by key (string or array), where ({field: value}, field may end with *), contains (text in key or localized name); fields (optional list, may end with *) limits columns; limit default 15 (max 60). Returns matched count, field names seen and rows (compacted: default-valued fields omitted).',
      inputSchema: { type: 'object', properties: { table: { type: 'string' }, key: { type: 'string' }, where: { type: 'object' }, contains: { type: 'string' }, fields: { type: 'array', items: { type: 'string' } }, limit: { type: 'number' } } },
      execute: async (i) => queryTable(i),
    }, {
      name: 'preview_overrides',
      description: 'Dry-run what-if overrides without simulating: per rule, how many rows would change and sample before/after values. Use it before simulating with overrides.',
      inputSchema: { type: 'object', properties: { overrides: ovSchema() }, required: ['overrides'] },
      execute: async (i) => ({ changes: checkOverrides(i.overrides) || [] }),
    }];
  }

  function reportToolsBase() {
    const byTool = Object.fromEntries(TOOLS.map((t) => [t.name, t]));
    return [byTool.list_stages, byTool.list_chapters, byTool.list_characters].concat(overrideTools(), [{
      name: 'simulate_stage',
      description: 'Run battles on one stage and return a summary (winRate, outcome counts, avgActions, avgWaveReached, stuck reasons, engine errors, per-member averages). squad (optional, default = current page squad): [{key, gridPos 0-8, grade?, level?, skillLevels?}]; level (optional) overrides every member level; runs default 30 (max 300). ' + OV_HINT,
      inputSchema: { type: 'object', properties: { stageKey: { type: 'string' }, squad: { type: 'array', items: { type: 'object' } }, level: { type: 'number' }, runs: { type: 'number' }, overrides: ovSchema(), compareBaseline: { type: 'boolean' } }, required: ['stageKey'] },
      execute: async (i) => {
        const k = String(i.stageKey);
        if (!findStage(k)) throw new Error('unknown stageKey ' + k);
        let sq = Array.isArray(i.squad) && i.squad.length ? i.squad.slice(0, 5).map((u) => { const key = String(u.key); if (!PCMAP[key]) throw new Error('unknown character ' + key); return Object.assign(specFor(key), { level: 50 }, u.grade ? { grade: +u.grade } : {}, u.level ? { level: +u.level } : {}, Array.isArray(u.skillLevels) ? { skillLevels: u.skillLevels.map(Number) } : {}, { key, gridPos: Math.max(0, Math.min(8, +u.gridPos || 0)) }); }) : squadList();
        if (i.level) sq = sq.map((s) => Object.assign({}, s, { level: Math.max(1, Math.min(120, +i.level)) }));
        if (!sq.length) throw new Error('empty squad');
        const ov = ovList(i.overrides);
        const changes = checkOverrides(ov);
        const runs = Math.max(1, Math.min(300, +i.runs || 30));
        const pack = (res) => { const sum = summarize(res); return Object.assign({}, sum, { perMember: sum.squad, squad: undefined }); };
        const out = { stageKey: k, squadUsed: sq.map((s) => ({ key: s.key, name: (PCMAP[s.key] || {}).name, gridPos: s.gridPos, grade: s.grade, level: s.level })) };
        if (changes) out.overridesApplied = changes;
        Object.assign(out, pack(await simulate(currentSetup(k, { squad: sq, overrides: ov }), runs)));
        if (changes && i.compareBaseline) out.baseline = pack(await simulate(currentSetup(k, { squad: sq }), runs));
        return out;
      },
    }]);
  }

  // ---------- results as Markdown (for the Claude Q&A panel) ----------
  function setupMarkdown() {
    const L = [];
    const sq = squadList().map((s) => `${(PCMAP[s.key] || {}).name || s.key}(${s.gridPos + 1}칸 G${s.grade} Lv${s.level})`).join(', ');
    if (state.last) {
      const s = findStage(state.last.stageKey) || {};
      const m = state.last.summary;
      L.push(`# 반복 실행 결과: ${s.idx || ''} ${s.name || ''} (${state.last.stageKey})`, `- 분대: ${sq}`, `- ${m.runs}회 · 승률 ${(m.winRate * 100).toFixed(1)}% · 결과 ${JSON.stringify(m.outcomes)} · 평균 행동 ${m.avgActions} · 평균 도달 웨이브 ${m.avgWaveReached} · 승리 시 남은 HP ${m.avgHpLeftPctOnWin}%`);
      if (m.errors.length) L.push('- 오류: ' + m.errors.map((e) => `${e.reason} ×${e.count}`).join(' / '));
      if (m.stuckReasons.length) L.push('- 진행불가·시간초과 원인: ' + m.stuckReasons.map((e) => `${e.reason} ×${e.count}`).join(' / '));
      L.push('', '| 전투원 | 평균 피해 | 받은 피해 | 회복 | 처치 | 행동 | 사망률 |', '|---|---|---|---|---|---|---|');
      for (const u of m.squad) L.push(`| ${u.name} | ${u.avgDmg} | ${u.avgTaken} | ${u.avgHeal} | ${u.avgKills} | ${u.avgActions} | ${Math.round(u.deathRate * 100)}% |`);
    }
    if (state.sweep && state.sweep.length) {
      L.push('', `# 챕터 일괄 실행 결과 (${state.sweep.length}개 스테이지)`, `- 분대: ${sq}`, '', '| 스테이지 | 키 | 승률 | 결과 | 평균 행동 | 주요 원인 |', '|---|---|---|---|---|---|');
      for (const r of state.sweep) { const s = findStage(r.stageKey) || {}; L.push(`| ${s.idx || ''} | ${r.stageKey} | ${(r.summary.winRate * 100).toFixed(0)}% | ${JSON.stringify(r.summary.outcomes)} | ${r.summary.avgActions} | ${((r.summary.errors[0] || r.summary.stuckReasons[0] || {}).reason || '').slice(0, 100)} |`); }
    }
    return L.join('\n');
  }

  // ---------- Claude ----------
  let sample = null, chatTurns = [], askCtl = null;
  // Claude connection: local (no claude.ai runtime) | pending | ok | denied | error
  let claudeStatus = window.claude && window.claude.use ? 'pending' : 'local', claudeTools = false, claudeErr = '', claudePerm = '', claudePermAll = '', claudeWaitMs = 0;
  // framed inside the claude.ai viewer, or opened on its own (top-level: every use() resolves null)
  const claudeFramed = (() => { try { return window.top !== window.self; } catch (e) { return true; } })();
  const RULES = `너는 "라스트오리진" 전투 시뮬레이터를 조작하는 QA 도우미야. 이 페이지는 Unity 클라이언트의 전투 리뉴얼(AP 게이지) 로직을 포팅한 엔진으로 전투를 돌린다.
도구로 스테이지를 찾고(list_stages), 전투원을 찾고(list_characters), 분대를 설정하고(set_squad), 시뮬레이션을 돌린다(run_simulation, sweep_stages). 결과의 outcome은 win/lose/stuck(진행불가: 실제 게임의 멈춤 버그에 대응)/error(엔진 예외: 실제 클라이언트 크래시 후보)/timeout이다.
규칙: 반복 횟수는 사용자가 정하지 않으면 run_simulation 50, sweep_stages 20으로 한다. sweep_stages는 한 번에 최대 40개 스테이지. 숫자는 도구 결과에 있는 값만 말하고 추측하지 마. 답은 한국어로 짧게, 결론 먼저, 그다음 근거 수치, 마지막에 다음에 해볼 실험 1~2개.`;
  function stageBrief(s) { return { key: s.key, mode: s.mode, idx: s.idx, name: s.name, chapter: s.chapter, waves: s.waves }; }
  const TOOLS = [
    { name: 'list_stages', description: 'Search stages. Returns up to `limit` (default 40) of {key, mode, idx, name, chapter, waves}. Filter by mode (stage|ew|iw), chapter key (e.g. Chapter_04N) and/or a text query matched against key, idx and name.',
      inputSchema: { type: 'object', properties: { mode: { type: 'string' }, chapter: { type: 'string' }, query: { type: 'string' }, limit: { type: 'number' } } },
      execute: (i) => { const mode = String(i.mode || 'stage'); const q = String(i.query || '').toLowerCase(); let l = STAGES[mode] || []; if (i.chapter) l = l.filter((s) => s.chapter === String(i.chapter)); if (q) l = l.filter((s) => (s.key + ' ' + s.idx + ' ' + s.name).toLowerCase().includes(q)); return l.slice(0, Math.min(200, +i.limit || 40)).map(stageBrief); } },
    { name: 'list_chapters', description: 'List chapter keys for a mode (stage|ew|iw) with display names. Returns [{key, name, stages}].',
      inputSchema: { type: 'object', properties: { mode: { type: 'string' } } },
      execute: (i) => { const m = String(i.mode || 'stage'); return (CHAPTERS[m] || []).map((c) => ({ key: c.key, name: c.name, stages: STAGES[m].filter((s) => s.chapter === c.key).length })); } },
    { name: 'list_characters', description: 'Search playable characters (Table_PC). Returns up to 30 {key, name, startGrade, maxGrade, classType, roleType} matching the query (Korean name or key).',
      inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
      execute: (i) => { const q = String(i.query || '').toLowerCase(); return PCS.filter((p) => !q || (p.key + ' ' + p.name).toLowerCase().includes(q)).slice(0, 30).map((p) => ({ key: p.key, name: p.name, startGrade: p.startGrade, maxGrade: p.maxGrade, classType: p.cls, roleType: p.role })); } },
    { name: 'get_setup', description: 'Current stage and squad shown on the page. Returns {stageKey, mode, squad:[{key, name, gridPos, grade, level, skillLevels, equips}]}.',
      execute: () => ({ stageKey: state.stageKey, mode: state.mode, squad: squadList().map((s) => Object.assign({ name: (PCMAP[s.key] || {}).name }, s)) }) },
    { name: 'set_stage', description: 'Select the stage shown on the page by key. Returns the selected stage summary.',
      inputSchema: { type: 'object', properties: { stageKey: { type: 'string' } }, required: ['stageKey'] },
      execute: (i) => { const s = findStage(String(i.stageKey)); if (!s) throw new Error('unknown stageKey'); state.mode = s.mode; state.chapter = s.chapter; state.stageKey = s.key; $('mode').value = s.mode; renderChapters(); return stageBrief(s); } },
    { name: 'set_squad', description: 'Replace the squad (max 5). units: [{key, gridPos 0-8, grade?, level?, skillLevels?, equips?:[{key, enchant}]}]. Missing fields use defaults (start grade, level 50). Returns the resulting squad.',
      inputSchema: { type: 'object', properties: { units: { type: 'array', items: { type: 'object' } } }, required: ['units'] },
      execute: (i) => { const us = (Array.isArray(i.units) ? i.units : []).slice(0, 5); const sq = {}; for (const u of us) { const k = String(u.key); if (!PCMAP[k]) throw new Error('unknown character ' + k); const pos = Math.max(0, Math.min(8, +u.gridPos || 0)); const s = specFor(k); s.level = +u.level || 50; if (u.grade) s.grade = +u.grade; if (Array.isArray(u.skillLevels)) s.skillLevels = u.skillLevels.map(Number); if (Array.isArray(u.equips)) s.equips = u.equips.map((e) => ({ key: String(e.key), enchant: +e.enchant || 0 })); sq[pos] = s; } state.squad = sq; state.sel = null; renderGrid(); renderEditor(); return squadList().map((s) => ({ key: s.key, gridPos: s.gridPos, grade: s.grade, level: s.level })); } },
    { name: 'set_squad_levels', description: 'Set level (and optionally skill level for every skill) for all squad members. Returns the squad.',
      inputSchema: { type: 'object', properties: { level: { type: 'number' }, skillLevel: { type: 'number' } }, required: ['level'] },
      execute: (i) => { for (const s of Object.values(state.squad)) { s.level = Math.max(1, Math.min(120, +i.level)); if (i.skillLevel) s.skillLevels = new Array((s.skillLevels || []).length || 5).fill(+i.skillLevel); } renderGrid(); renderEditor(); return squadList().map((s) => ({ key: s.key, level: s.level })); } },
    { name: 'run_simulation', description: 'Run the current squad on one stage `runs` times (default 50, max 1000). Returns a summary: winRate, outcome counts, avgActions, avgWaveReached, stuck reasons, engine errors, per-squad-member averages.',
      inputSchema: { type: 'object', properties: { stageKey: { type: 'string' }, runs: { type: 'number' } } },
      execute: async (i) => { const k = String(i.stageKey || state.stageKey); if (!findStage(k)) throw new Error('unknown stageKey'); setBusy(true); try { const sum = await doRun(k, Math.max(1, Math.min(1000, +i.runs || 50))); renderSummary(sum, k); showTab('sum'); return Object.assign({ stageKey: k }, sum); } finally { setBusy(false); } } },
    { name: 'sweep_stages', description: 'Run the current squad on many stages (stageKeys, or every stage of `chapter`; max 40) `runs` times each (default 20, max 200). Returns per stage {stageKey, idx, winRate, outcomes, avgActions, topIssue}.',
      inputSchema: { type: 'object', properties: { stageKeys: { type: 'array', items: { type: 'string' } }, chapter: { type: 'string' }, mode: { type: 'string' }, runs: { type: 'number' } } },
      execute: async (i) => { let keys = Array.isArray(i.stageKeys) ? i.stageKeys.map(String) : (STAGES[String(i.mode || 'stage')] || []).filter((s) => s.chapter === String(i.chapter || '')).map((s) => s.key); keys = keys.filter((k) => findStage(k)).slice(0, 40); if (!keys.length) throw new Error('no stages'); setBusy(true); showTab('sweep'); try { const rows = await doSweep(keys, Math.max(1, Math.min(200, +i.runs || 20))); return rows.map((r) => ({ stageKey: r.stageKey, idx: (findStage(r.stageKey) || {}).idx, winRate: r.summary.winRate, outcomes: r.summary.outcomes, avgActions: r.summary.avgActions, topIssue: (r.summary.errors[0] || r.summary.stuckReasons[0] || {}).reason || '' })); } finally { setBusy(false); } } },
    { name: 'run_one_with_log', description: 'Run one battle with a full action log and return its outcome plus the last 60 log lines (use it to explain a loss, a stuck battle or an error).',
      inputSchema: { type: 'object', properties: { stageKey: { type: 'string' }, seed: { type: 'number' } } },
      execute: async (i) => { const k = String(i.stageKey || state.stageKey); const [r] = await runOnWorker(pool()[0], currentSetup(k, { logEnabled: true, seed: +i.seed || +$('seed').value || 1 }), 1); renderLog(r); showTab('log'); return { outcome: r.outcome, reason: r.reason, totalActions: r.totalActions, waveReached: r.waveReached, errors: (r.errors || []).slice(0, 3), tail: (r.log || []).slice(-60) }; } },
  ];
  function addMsg(cls, text) { const d = document.createElement('div'); d.className = 'msg ' + cls; d.textContent = text; $('msgs').appendChild(d); $('msgs').scrollTop = $('msgs').scrollHeight; return d; }
  async function ask() {
    const q = $('ask').value.trim();
    if (!q || !sample) return;
    $('ask').value = '';
    addMsg('u', q);
    chatTurns.push({ role: 'user', content: q });
    const out = addMsg('a', '생각 중…');
    askCtl = new AbortController();
    $('btnAsk').disabled = true; $('btnAskStop').disabled = false;
    const tools = TOOLS.map((t) => Object.assign({}, t, { execute: async (input, ctx) => { addMsg('t', `▶ ${t.name} ${JSON.stringify(input).slice(0, 160)}`); return t.execute(input, ctx); } }));
    try {
      const turns = [{ role: 'user', content: RULES }, ...chatTurns.slice(-12)];
      const { text } = await sample(turns, { tools, signal: askCtl.signal, onText: ({ text }) => { out.textContent = text; } });
      chatTurns.push({ role: 'assistant', content: text });
      $('msgs').appendChild(out);
    } catch (e) {
      out.textContent = e.text || '';
      if (e.code === 'not_granted' || e.code === 'sampling_disabled' || e.code === 'tools_unavailable') { $('claudeState').textContent = '이 화면에서는 Claude를 쓸 수 없습니다'; }
      else if (e.code !== 'cancelled') addMsg('t', e.code === 'rate_limited' ? '요청이 많습니다. 잠시 후 다시 보내 주세요.' : '응답이 중단되었습니다: ' + e.code);
      chatTurns.pop();
    } finally { $('btnAsk').disabled = false; $('btnAskStop').disabled = true; }
  }

  // ---------- boot ----------
  async function boot() {
    wire();
    try {
      await L.load('data/');
    } catch (e) { setStatus('데이터를 불러오지 못했습니다: ' + e.message); return; }
    buildIndexes();
    fetch('data/meta.json').then((r) => (r.ok ? r.json() : null)).then((m) => {
      if (!m) return;
      META = m;
      const warn = (m.logicChanged || []).length;
      $('verInfo').innerHTML = `전투 리뉴얼(AP) · 데이터 r${esc(m.svnRevision)} (${esc(m.extractedAt)}) · 전투 로직 r${esc(m.logicPortRevision)} 기준` +
        (warn ? `<span class="verwarn" title="${esc(m.logicChanged.map((c) => c.file + (c.revision ? ' r' + c.revision : '')).join(', '))}">로직 변경 ${warn}건 미반영</span>` : '');
    }).catch(() => {});
    defaultSquad();
    state.mode = 'stage';
    const savedFields = restoreSettings();
    renderChapters(); renderGrid();
    const missing = ['stats', 'buffs', 'combat', 'ai', 'battle'].filter((m) => !L[m]);
    setStatus(missing.length ? '엔진 모듈 없음: ' + missing.join(', ') : `준비됨 · 스테이지 ${STAGES.stage.length} · 전투원 ${PCS.length} · 워커 ${POOL}`);
    pool();
    window.LOApp = {
      findStage, squad: () => squadList(), stages: (m) => STAGES[m] || [], chapters: (m) => CHAPTERS[m] || [],
      currentStageKey: () => state.stageKey, pcName: (k) => (PCMAP[k] || {}).name, sample: () => sample, claudeStatus: () => claudeStatus, claudeTools: () => claudeTools, claudeErr: () => claudeErr, claudePerm: () => claudePerm, claudePermAll: () => claudePermAll, claudeWhere: () => ({ framed: claudeFramed, host: location.host, waitMs: claudeWaitMs }), reconnectClaude: () => connectClaude(), openClaudePermissions: () => openClaudePermissions(), requestClaude: () => requestClaude(),
      claudeDenied: () => { claudeStatus = 'denied'; claudePerm = 'denied'; sample = null; $('claudeState').textContent = 'Claude 사용 권한이 꺼져 있습니다'; $('btnAsk').disabled = true; },
      pcs: () => PCS, pcMap: () => PCMAP, specFor: (k) => specFor(k), esc, reportTools: () => reportToolsBase(), overrideDoc, checkOverrides, ovSchema, OV_HINT,
      setSquad: (list) => { state.squad = {}; for (const s of list.slice(0, 5)) state.squad[s.gridPos] = Object.assign(specFor(s.key), s); state.sel = null; renderGrid(); renderEditor(); },
      saveFile: null,
      meta: () => META && { dataRevision: META.svnRevision, extractedAt: META.extractedAt, logicPortRevision: META.logicPortRevision, logicChangedSincePort: (META.logicChanged || []).map((c) => c.file) },
    };
    if (window.LOLive) { window.LOLive.init(); window.LOLive.claudeReady(!!sample); }
    if (savedFields) applyFields(savedFields);
    wirePresets(); renderPresets('');
    restoring = false;
    saveSettings();
    document.addEventListener('change', (e) => { if (e.target && PERSIST.includes(e.target.id)) saveSettings(); });
    document.addEventListener('input', (e) => { if (e.target && PERSIST.includes(e.target.id)) saveSettings(); });
    // one squad editor, shown in whichever view is open
    const VIEWS = { setup: ['vSetup', 'setupView'], live: ['vLive', 'liveView'], audit: ['vAudit', 'auditView'], combo: ['vCombo', 'comboView'] };
    const mounted = {};
    const view = (name) => {
      for (const [k, [btn, pane]] of Object.entries(VIEWS)) { $(pane).hidden = k !== name; $(btn).setAttribute('aria-pressed', String(k === name)); }
      if (name === 'setup' || name === 'live') (name === 'live' ? $('lvSquadSlot') : $('setupSquadSlot')).appendChild($('squadCard'));
      // feature tabs mount lazily the first time they are opened
      const mod = { audit: window.LOAudit, combo: window.LOCombo }[name];
      if (mod && !mounted[name]) {
        mounted[name] = true;
        try { mod.mount($(VIEWS[name][1]), window.LOApp); } catch (e) { $(VIEWS[name][1]).textContent = '화면을 여는 중 오류: ' + e.message; }
        // Q&A panel below the tab (the module renders into its own children, so append a separate holder)
        if (window.LOAsk) {
          const holder = document.createElement('div');
          const host = $(VIEWS[name][1]);
          const place = () => { if (!holder.isConnected) host.appendChild(holder); };
          place(); new MutationObserver(place).observe(host, { childList: true });
          const q = name === 'audit'
            ? { id: 'askAudit', getContext: () => (window.LOAudit && window.LOAudit.reportMarkdown({ maxRows: 300 })) || '', tools: () => (window.LOAudit && window.LOAudit.reportTools ? window.LOAudit.reportTools() : []).concat(reportToolsBase()), suggestions: ['오류·의심 중 먼저 확인할 5개를 골라줘', '설명 대조에서 검토 필요한 항목 중 진짜 누락으로 보이는 건?', '승급 대체 효과가 있는 캐릭터를 정리해줘'] }
            : { id: 'askCombo', getContext: () => (window.LOCombo && window.LOCombo.reportMarkdown()) || '', tools: () => (window.LOCombo && window.LOCombo.reportTools ? window.LOCombo.reportTools() : []).concat(reportToolsBase()), suggestions: ['1위 조합이 강한 이유를 쉽게 설명해줘', '버프 중첩 효과를 빼면 어떤 조합이 남아?', '이 결과를 실제 게임에서 재현하려면 어떻게 해?'] };
          window.LOAsk.mount(holder, q);
        }
      }
    };
    for (const k of Object.keys(VIEWS)) $(VIEWS[k][0]).addEventListener('click', () => view(k));
    if (window.LOAsk) {
      window.LOAsk.mount($('setupAskSlot'), { id: 'askSetup', getContext: setupMarkdown, tools: () => reportToolsBase(),
        suggestions: ['이 결과에서 승률이 낮은 이유는?', '어떤 전투원이 제 역할을 못 하고 있어?', '진행불가·오류가 왜 생겼는지 설명해줘'] });
      window.LOAsk.mount($('liveView'), { id: 'askLive', getContext: () => (window.LOLive && window.LOLive.reportMarkdown()) || '', tools: () => reportToolsBase(),
        suggestions: ['가장 큰 벽이 된 스테이지와 원인은?', '감지된 문제 중 실제 버그일 가능성이 높은 것은?', '레벨을 얼마나 올려야 막힌 구간을 넘길 수 있어?'] });
    }
  }
  boot();

  function connectClaude() {
    if (!(window.claude && window.claude.use)) { claudeStatus = 'local'; $('claudeState').textContent = 'Claude 연결 불가 (로컬 실행 화면)'; $('btnAsk').disabled = true; return; }
    claudeStatus = 'pending'; claudeErr = ''; claudePerm = '';
    $('claudeState').textContent = 'Claude 연결 확인 중…';
    const t0 = Date.now();
    Promise.resolve().then(() => window.claude.use('sample')).then(async (s) => {
      claudeWaitMs = Date.now() - t0;
      claudePerm = await permState();
      if (!s) {
        claudeStatus = 'denied';
        $('claudeState').textContent = claudePerm === 'denied' ? 'Claude 사용 권한이 꺼져 있습니다' : '이 화면에서는 Claude를 쓸 수 없습니다';
        $('btnAsk').disabled = true; return;
      }
      const lim = await s.limits().catch(() => null);
      claudeTools = !lim || !!lim.tools;
      sample = s; claudeStatus = 'ok';
      $('claudeState').textContent = claudeTools ? '연결됨 · 사용량은 보는 사람 계정에서 차감' : '연결됨 · 이 화면은 도구 호출을 지원하지 않아 아래 질문 카드만 사용 가능';
      $('btnAsk').disabled = !claudeTools;
      if (window.LOLive && window.LOApp) window.LOLive.claudeReady(claudeTools);
    }).catch((e) => {
      claudeStatus = e && (e.code === 'not_granted' || e.code === 'sampling_disabled') ? 'denied' : 'error';
      claudeErr = String((e && (e.code || e.message)) || e);
      $('claudeState').textContent = 'Claude 연결 실패: ' + claudeErr; $('btnAsk').disabled = true;
    });
  }
  // permissions is built into the claude.ai runtime: read the sample grant without prompting
  async function permState() {
    try {
      const p = await window.claude.use('permissions');
      if (!p) { claudePermAll = '권한 기능 없음'; return ''; }
      const all = await p.state().catch(() => null);
      claudePermAll = all ? Object.entries(all).map(([k, v]) => k + '=' + v).join(', ') || '(비어 있음)' : '읽기 실패';
      return await p.state('sample');
    } catch (e) { claudePermAll = '읽기 실패: ' + ((e && (e.code || e.message)) || e); return ''; }
  }
  // "prompt": ask once with the platform dialog; the sample namespace is fixed for this page load, so reload after a grant
  async function requestClaude() {
    const p = window.claude && window.claude.use ? await window.claude.use('permissions').catch(() => null) : null;
    if (!p) throw new Error('unavailable');
    const r = await p.request(['sample']);
    claudePerm = (r && r.sample) || claudePerm;
    return claudePerm;
  }
  // a standing refusal is lifted only from the platform's Permissions panel (pages cannot re-ask)
  async function openClaudePermissions() {
    const p = window.claude && window.claude.use ? await window.claude.use('permissions').catch(() => null) : null;
    if (!p) throw new Error('unavailable');
    await p.manage();
    connectClaude();
  }
  connectClaude();
  if (window.claude && window.claude.use) {
    window.claude.use('db').then((d) => {
      if (!d) return;
      db = d;
      db.collection('runs').orderBy('at', 'desc').limit(30).onSnapshot((snap) => renderHist(snap.docs), () => {});
    });
  }
  $('btnAsk').addEventListener('click', ask);
  $('ask').addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) ask(); });
  $('btnAskStop').addEventListener('click', () => askCtl && askCtl.abort());
  $('btnAskClear').addEventListener('click', () => { chatTurns = []; $('msgs').innerHTML = ''; });
})();
