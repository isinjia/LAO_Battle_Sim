// "캐릭터 점검" tab: audits every playable character's skills / buff effects and lists the ones that do not behave
// as designed. The checks themselves live in audit-core.js (LOSim.audit, shared with tools/audit_node.js) and run in
// a pool of audit-worker.js Web Workers, so the page never freezes. This file is UI + orchestration + export.
(function () {
  const SEV_CLS = { error: 'o-error', suspect: 'o-lose', unverified: 'o-stuck', simlimit: 'o-timeout', info: 'o-timeout' };
  const VERDICT = { ok: ['정상', 'o-win'], suspect: ['의심', 'o-lose'], error: ['오류', 'o-error'] };
  const LS_KEY = 'lo-audit-settings';
  const PAGE = 300;

  const css = `
.au-filters { display:flex; flex-wrap:wrap; gap:8px; align-items:end; }
.au-filters label { font-size:12px; color:var(--ink-2); display:grid; gap:3px; }
.au-tbl th[data-sort] { cursor:pointer; user-select:none; }
.au-tbl th[data-sort]:hover { color:var(--ink); }
.au-tbl th .ar { font-size:10px; margin-left:3px; }
.au-tbl td.ev { white-space:normal; min-width:260px; max-width:560px; color:var(--ink-2); font-size:11.5px; }
.au-tbl td.msg { white-space:normal; min-width:220px; max-width:420px; }
.au-tbl code, .au-det code { font-family:var(--f-mono); font-size:11px; }
.au-chars { display:grid; gap:6px; }
.au-chars details { border:1px solid var(--rule); border-radius:6px; background:var(--panel-2); }
.au-chars summary { cursor:pointer; padding:6px 10px; display:flex; flex-wrap:wrap; gap:8px; align-items:center; font-size:13px; }
.au-chars summary .nm { font-weight:600; }
.au-chars summary .k { font-family:var(--f-mono); font-size:11px; color:var(--ink-3); }
.au-chars summary .cnt { margin-left:auto; font-family:var(--f-mono); font-size:11px; color:var(--ink-2); }
.au-det { padding:4px 10px 10px; display:grid; gap:10px; }
.au-det h3 { margin:4px 0 0; font-size:12px; color:var(--ink-2); font-weight:600; }
.au-claude { white-space:pre-wrap; word-break:break-word; font-size:13px; background:var(--panel-2); border-radius:6px; padding:10px; max-height:520px; overflow:auto; }
.au-more { justify-self:start; }
`;

  let APP = null, ROOT = null, A = null;
  const $ = (id) => ROOT.querySelector('#' + id);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const S = { results: [], byKey: new Map(), running: false, workers: [], queue: [], total: 0, done: 0, failed: [], opts: null, started: 0,
    sort: { col: 'sev', dir: 1 }, shown: PAGE, renderTimer: null, claudeText: '', hasDesc: null, finishedAt: null };

  function loadCore() {
    if (window.LOSim && window.LOSim.audit) return Promise.resolve(window.LOSim.audit);
    return new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = 'audit-core.js';
      s.onload = () => (window.LOSim && window.LOSim.audit ? res(window.LOSim.audit) : rej(new Error('audit-core.js did not load')));
      s.onerror = () => rej(new Error('audit-core.js not found'));
      document.head.appendChild(s);
    });
  }

  // ------------------------------------------------------------------ layout
  function render(container) {
    container.innerHTML = `
<style>${css}</style>
<section class="card" aria-labelledby="au-h">
  <h2 id="au-h">캐릭터 점검 <span class="sp">전투원마다 스킬·버프 효과가 기획대로 동작하는지 데이터와 실제 전투로 확인합니다</span></h2>
  <div class="row">
    <label>등급<select id="auGrade"><option value="max">최대 등급</option><option value="start">시작 등급</option><option value="3">3</option><option value="4">4</option><option value="5">5</option></select></label>
    <label>레벨<input type="number" id="auLevel" min="1" max="120" value="90"></label>
    <label>스킬 레벨<input type="number" id="auSkLv" min="1" max="10" value="10"></label>
    <label title="전투원 1명당 실행 점검에서 행동시킬 횟수 (단독·전열 / 분대·중열 / 분대·후열 세 시나리오에 나눔)">행동 수<input type="number" id="auActions" min="6" max="300" value="42"></label>
    <label>시드<input type="number" id="auSeed" min="1" value="1"></label>
    <label><span>정적 점검 (데이터·설명)</span><input type="checkbox" id="auStatic" checked></label>
    <label><span>실행 점검 (전투)</span><input type="checkbox" id="auRuntime" checked></label>
    <label title="끄면 단독 배치만으로 점검합니다 (아군 대상 효과는 확인 불가)"><span>분대 시나리오</span><input type="checkbox" id="auSquad" checked></label>
  </div>
  <div class="row">
    <label class="grow">대상 전투원 (이름·키 검색, 비우면 전체)<input type="search" id="auFilter" placeholder="예: 에이미, Char_BR_, 기동"></label>
    <span class="note" id="auTargetCount"></span>
    <button class="primary" id="auStart">점검 시작</button><button id="auStop" disabled>중지</button>
  </div>
  <div class="prog" aria-hidden="true"><i id="auProg"></i></div>
  <div class="note" id="auStatus">장비 없음 · 적은 5기(전열 2, 중열 2, 후열 1)이며 HP·공격력을 점검 대상에 맞춰 조정하고 방어력은 0으로 둡니다. 실행 점검은 워커에서 돌아가 화면이 멈추지 않습니다.</div>
  <div class="row">
    <span class="note">내보내기</span>
    <button id="auSave" disabled>리포트 저장 (HTML)</button>
    <button id="auCopy" disabled>리포트 복사 (Markdown)</button>
    <button id="auJson" disabled>원본 JSON 저장</button>
    <button id="auClaude" disabled title="claude.ai에 게시된 페이지에서만 동작합니다">Claude 분석</button>
  </div>
</section>
<section class="card" aria-labelledby="au-h2">
  <h2 id="au-h2">요약 <span class="sp" id="auSumNote"></span></h2>
  <div class="kpis" id="auKpis"></div>
  <div class="note">심각도 — <b>오류</b>: 데이터 누락·엔진 예외·멈춤 (클라이언트 크래시/진행불가 후보) · <b>의심</b>: 기획 의도와 다르게 동작할 가능성이 높음 · <b>미확인</b>: 점검 시나리오에서 조건이 맞지 않아 확인하지 못함 · <b>시뮬레이터 한계</b>: 아직 포팅하지 않은 효과 · <b>참고</b>: 확인용 정보</div>
</section>
<section class="card" id="auClaudeCard" hidden aria-labelledby="au-h5"><h2 id="au-h5">Claude 분석</h2><div class="au-claude" id="auClaudeOut"></div></section>
<section class="card" aria-labelledby="au-h3">
  <h2 id="au-h3">발견 항목 <span class="sp" id="auFindCount"></span></h2>
  <div class="au-filters">
    <label>심각도<select id="auSev"><option value="es">오류 + 의심</option><option value="error">오류</option><option value="suspect">의심</option><option value="unverified">미확인</option><option value="simlimit">시뮬레이터 한계</option><option value="info">참고</option><option value="all">전체</option></select></label>
    <label>신뢰도<select id="auConf"><option value="">전체</option><option value="high">높음만</option><option value="med">보통 이상</option></select></label>
    <label>종류<select id="auCode"><option value="">전체</option></select></label>
    <label>점검<select id="auCat"><option value="">전체</option><option value="static">데이터</option><option value="desc">설명 비교</option><option value="runtime">실행</option></select></label>
    <label class="grow">전투원·스킬·효과 키<input type="search" id="auFFilter"></label>
  </div>
  <div class="tablewrap"><table class="au-tbl"><thead><tr>
    <th data-sort="sev">심각도</th><th data-sort="conf">신뢰도</th><th data-sort="char">전투원</th><th data-sort="skill">스킬</th><th data-sort="effect">효과 키</th><th data-sort="code">종류</th><th>내용</th><th>근거</th>
  </tr></thead><tbody id="auFBody"><tr><td colspan="8" class="note">점검 시작을 누르면 결과가 여기에 쌓입니다.</td></tr></tbody></table></div>
  <button class="au-more" id="auMore" hidden>더 보기</button>
</section>
<section class="card" aria-labelledby="au-h4">
  <h2 id="au-h4">전투원별 상세 <span class="sp">눌러서 스킬 사용·피해·버프 적용 현황을 봅니다</span></h2>
  <div class="row"><label>판정<select id="auVerdict"><option value="">전체</option><option value="error">오류</option><option value="suspect">의심</option><option value="ok">정상</option></select></label></div>
  <div class="au-chars" id="auChars"></div>
</section>`;
  }

  // ------------------------------------------------------------------ settings
  const FIELDS = ['auGrade', 'auLevel', 'auSkLv', 'auActions', 'auSeed', 'auStatic', 'auRuntime', 'auSquad', 'auFilter'];
  function saveSettings() {
    try { const o = {}; for (const id of FIELDS) { const el = $(id); o[id] = el.type === 'checkbox' ? el.checked : el.value; } localStorage.setItem(LS_KEY, JSON.stringify(o)); } catch (e) { /* storage blocked */ }
  }
  function restoreSettings() {
    try { const o = JSON.parse(localStorage.getItem(LS_KEY) || 'null'); if (!o) return; for (const id of FIELDS) if (o[id] !== undefined) { const el = $(id); if (el.type === 'checkbox') el.checked = !!o[id]; else el.value = o[id]; } } catch (e) { /* ignore */ }
  }
  function readOpts() {
    const g = $('auGrade').value;
    return {
      grade: /^\d+$/.test(g) ? +g : g, level: Math.max(1, Math.min(120, +$('auLevel').value || 90)), skillLevel: Math.max(1, Math.min(10, +$('auSkLv').value || 10)),
      actions: Math.max(6, Math.min(300, +$('auActions').value || 42)), seed: Math.max(1, +$('auSeed').value || 1),
      includeStatic: $('auStatic').checked, includeRuntime: $('auRuntime').checked, squad: $('auSquad').checked,
    };
  }
  function targetList() {
    const q = $('auFilter').value.trim().toLowerCase();
    const all = A.listPCs();
    if (!q) return all;
    const terms = q.split(/[,\s]+/).filter(Boolean);
    return all.filter((p) => terms.some((t) => (p.key + ' ' + p.name).toLowerCase().includes(t)));
  }
  function updateTargetCount() {
    const n = targetList().length;
    const excluded = (APP.pcs() || []).length - A.listPCs().length;
    $('auTargetCount').textContent = `대상 ${n}명` + (excluded > 0 ? ` (강화 재료 모듈 ${excluded}명은 제외)` : '');
  }

  // ------------------------------------------------------------------ run
  function poolSize() { return Math.max(1, Math.min(3, (navigator.hardwareConcurrency || 4) - 1)); } // each worker holds its own ~35 MB copy of the tables
  function start() {
    if (S.running) return;
    const opts = readOpts();
    if (!opts.includeStatic && !opts.includeRuntime) { status('정적 점검과 실행 점검 중 하나는 켜야 합니다.'); return; }
    const list = targetList();
    if (!list.length) { status('검색에 맞는 전투원이 없습니다.'); return; }
    saveSettings();
    S.results = []; S.byKey = new Map(); S.failed = []; S.opts = opts; S.queue = list.map((p) => p.key); S.total = list.length; S.done = 0; S.shown = PAGE;
    S.started = Date.now(); S.finishedAt = null; S.claudeText = ''; $('auClaudeCard').hidden = true;
    S.running = true;
    setButtons();
    S.poolTarget = Math.min(poolSize(), list.length);
    S.spawnFails = 0;
    status(`워커 ${S.poolTarget}개 준비 중… (엔진과 데이터를 불러옵니다)`);
    S.workers = [];
    spawn(); // workers are started one after another (each loads ~35 MB of tables) to keep the local server happy
    scheduleRender();
  }
  function spawn() {
    if (!S.running || S.workers.filter((x) => !x.dead).length >= S.poolTarget || !S.queue.length) return;
    let w;
    try { w = new Worker('audit-worker.js'); } catch (e) { status('워커를 만들 수 없습니다: ' + e.message); finish(true); return; }
    const slot = { w, busy: null, ready: false, dead: false };
    w.onmessage = (ev) => onWorkerMsg(slot, ev.data);
    w.onerror = (ev) => { if (ev.preventDefault) ev.preventDefault(); killSlot(slot, ev.message || 'worker error'); };
    S.workers.push(slot);
    w.postMessage({ type: 'init' });
  }
  // uncaught worker error (e.g. a script failed to load): requeue its job, replace the worker (bounded retries)
  function killSlot(slot, msg) {
    if (slot.dead) return;
    slot.dead = true;
    try { slot.w.terminate(); } catch (e) { /* ignore */ }
    if (slot.busy) { S.queue.unshift(slot.busy); slot.busy = null; }
    S.spawnFails++;
    if (!S.running) return;
    if (S.spawnFails <= 6) { status(`워커 오류로 다시 시작합니다 (${S.spawnFails}회): ${msg}`); setTimeout(spawn, 500 * S.spawnFails); }
    else if (S.workers.every((x) => x.dead)) { status('워커를 시작하지 못했습니다: ' + msg); finish(true); }
    checkDone();
  }
  function onWorkerMsg(slot, m) {
    if (!S.running || slot.dead) return;
    if (m.type === 'ready') { slot.ready = true; if (S.hasDesc === null) S.hasDesc = m.hasDesc; spawn(); next(slot); return; }
    if (m.type === 'result') {
      slot.busy = null;
      S.results.push(m.result); S.byKey.set(m.result.key, m.result); S.done++;
      next(slot); scheduleRender(); return;
    }
    if (m.type === 'error') {
      if (!m.id) { killSlot(slot, m.message); return; } // init failed
      const k = m.key || slot.busy;
      slot.busy = null;
      if (k) { S.failed.push({ key: k, message: m.message }); S.done++; }
      next(slot); scheduleRender();
    }
  }
  function next(slot) {
    if (!S.running || slot.dead || !slot.ready || slot.busy) return;
    const k = S.queue.shift();
    if (!k) { checkDone(); return; }
    slot.busy = k;
    slot.w.postMessage({ type: 'audit', id: k, key: k, opts: S.opts });
  }
  function checkDone() {
    if (S.running && !S.queue.length && S.workers.every((x) => x.dead || !x.busy) && S.done >= S.total) finish(false);
  }
  function stop() { if (S.running) finish(true); }
  function finish(stopped) {
    S.running = false;
    for (const s of S.workers) try { s.w.terminate(); } catch (e) { /* ignore */ }
    S.workers = []; S.queue = [];
    S.finishedAt = Date.now();
    setButtons();
    renderAll();
    const secs = ((S.finishedAt - S.started) / 1000).toFixed(0);
    status((stopped ? '중지됨 · ' : '완료 · ') + `${S.results.length}명 점검 (${secs}초)` + (S.failed.length ? ` · 점검 실패 ${S.failed.length}명: ${S.failed.slice(0, 5).map((f) => f.key + ' (' + f.message + ')').join(', ')}` : '') +
      (S.hasDesc === false ? ' · data/skilldesc.json이 없어 설명 비교는 건너뜀 (node tools/audit_node.js --extract-desc 로 생성)' : ''));
  }
  function setButtons() {
    $('auStart').disabled = S.running; $('auStop').disabled = !S.running;
    const has = S.results.length > 0;
    for (const id of ['auSave', 'auCopy', 'auJson']) $(id).disabled = !has || S.running;
    $('auClaude').disabled = !has || S.running || !(APP.sample && APP.sample());
  }
  function status(t) { $('auStatus').textContent = t; }
  function scheduleRender() {
    if (S.renderTimer) return;
    S.renderTimer = setTimeout(() => { S.renderTimer = null; renderAll(); }, 400);
  }

  // ------------------------------------------------------------------ rendering
  function renderAll() {
    const pct = S.total ? (S.done / S.total) * 100 : 0;
    $('auProg').style.width = pct.toFixed(1) + '%';
    if (S.running) status(`점검 중 ${S.done} / ${S.total} · 워커 ${S.workers.filter((x) => !x.dead).length}개 · ${((Date.now() - S.started) / 1000).toFixed(0)}초`);
    renderKpis(); renderCodeOptions(); renderFindings(); renderChars();
  }
  function renderKpis() {
    const s = A.summarize(S.results);
    const kpi = (v, l, cls) => `<div class="kpi"><b class="${cls || ''}">${esc(v)}</b><span>${esc(l)}</span></div>`;
    $('auKpis').innerHTML = kpi(s.chars + (S.running ? ' / ' + S.total : ''), '점검한 전투원') + kpi(s.ok, '정상 (오류·의심 없음)', 'o-win') + kpi(s.suspectChars, '의심 전투원', 'o-lose') +
      kpi(s.errorChars, '오류 전투원', 'o-error') + kpi(s.findings.unverified, '미확인 항목', 'o-stuck') + kpi(s.findings.simlimit, '시뮬레이터 한계 항목', 'o-timeout');
    $('auSumNote').textContent = s.chars ? `항목: 오류 ${s.findings.error} · 의심 ${s.findings.suspect} · 미확인 ${s.findings.unverified} · 한계 ${s.findings.simlimit} · 참고 ${s.findings.info}` + (s.displayOnlySlots ? ` · 표시 전용(확률 0) 슬롯 ${s.displayOnlySlots}개 제외` : '') : '';
  }
  function allFindings() { const out = []; for (const r of S.results) for (const f of r.findings) out.push(f); return out; }
  function renderCodeOptions() {
    const sel = $('auCode'), cur = sel.value;
    const codes = {};
    for (const f of allFindings()) codes[f.code] = (codes[f.code] || 0) + 1;
    const keys = Object.keys(codes).sort((a, b) => codes[b] - codes[a]);
    const html = '<option value="">전체</option>' + keys.map((k) => `<option value="${esc(k)}">${esc((A.CODE_KO[k] || k) + ' (' + codes[k] + ')')}</option>`).join('');
    if (sel.dataset.sig !== keys.join() + JSON.stringify(codes)) { sel.innerHTML = html; sel.dataset.sig = keys.join() + JSON.stringify(codes); sel.value = keys.includes(cur) ? cur : ''; }
  }
  function filtered() {
    const sev = $('auSev').value, conf = $('auConf').value, code = $('auCode').value, cat = $('auCat').value;
    const q = $('auFFilter').value.trim().toLowerCase();
    return allFindings().filter((f) => {
      if (sev === 'es' ? !(f.sev === 'error' || f.sev === 'suspect') : sev !== 'all' && f.sev !== sev) return false;
      if (conf === 'high' && f.conf !== 'high') return false;
      if (conf === 'med' && f.conf === 'low') return false;
      if (code && f.code !== code) return false;
      if (cat && f.cat !== cat) return false;
      if (q && !(f.char + ' ' + f.charName + ' ' + f.skill + ' ' + f.skillName + ' ' + f.effect).toLowerCase().includes(q)) return false;
      return true;
    });
  }
  const SORTERS = {
    sev: (f) => A.SEV_ORDER[f.sev] * 10 + A.confRank(f.conf), conf: (f) => A.confRank(f.conf), char: (f) => f.charName, skill: (f) => f.skillName || f.skill, effect: (f) => f.effect, code: (f) => f.code,
  };
  function renderFindings() {
    const fs = filtered();
    const { col, dir } = S.sort;
    const key = SORTERS[col] || SORTERS.sev;
    fs.sort((a, b) => { const x = key(a), y = key(b); const c = typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y), 'ko'); return c * dir || SORTERS.sev(a) - SORTERS.sev(b); });
    for (const th of ROOT.querySelectorAll('.au-tbl th[data-sort]')) {
      const c = th.dataset.sort;
      th.innerHTML = th.textContent.replace(/[▲▼]$/, '') + (c === col ? `<span class="ar">${dir > 0 ? '▲' : '▼'}</span>` : '');
    }
    $('auFindCount').textContent = `${fs.length}건 표시` + (fs.length > S.shown ? ` (앞 ${S.shown}건)` : '');
    if (!S.results.length) return;
    $('auFBody').innerHTML = fs.length ? fs.slice(0, S.shown).map((f) => `<tr>
<td><span class="pill ${SEV_CLS[f.sev]}">${esc(A.SEV[f.sev])}</span></td><td>${esc(A.CONF[f.conf] || f.conf)}</td>
<td><a href="#" data-char="${esc(f.char)}">${esc(f.charName)}</a><div class="note"><code>${esc(f.char)}</code></div></td>
<td>${esc(f.skillName)}${f.skill ? `<div class="note"><code>${esc(f.skill)}</code></div>` : ''}</td>
<td>${f.effect ? `<code>${esc(f.effect)}</code>${f.slot ? ' #' + f.slot : ''}` : ''}</td>
<td>${esc(A.CODE_KO[f.code] || f.code)}<div class="note">${esc({ static: '데이터', desc: '설명 비교', runtime: '실행' }[f.cat] || f.cat)}</div></td>
<td class="msg">${esc(f.msg)}</td><td class="ev">${esc(f.evidence)}${f.ref ? `<div class="note">참조: ${esc(f.ref)}</div>` : ''}</td></tr>`).join('')
      : '<tr><td colspan="8" class="note">조건에 맞는 항목이 없습니다.</td></tr>';
    $('auMore').hidden = fs.length <= S.shown;
  }
  function renderChars() {
    const v = $('auVerdict').value;
    const list = S.results.slice().sort((a, b) => ({ error: 0, suspect: 1, ok: 2 }[a.verdict] - { error: 0, suspect: 1, ok: 2 }[b.verdict]) || a.name.localeCompare(b.name, 'ko')).filter((r) => !v || r.verdict === v);
    const box = $('auChars');
    const open = new Set([...box.querySelectorAll('details[open]')].map((d) => d.dataset.key));
    box.innerHTML = list.map((r) => {
      const [vt, vc] = VERDICT[r.verdict];
      const c = r.counts;
      return `<details data-key="${esc(r.key)}"${open.has(r.key) ? ' open' : ''}><summary><span class="pill ${vc}">${vt}</span><span class="nm">${esc(r.name)}</span><span class="k">${esc(r.key)}</span>
<span class="cnt">오류 ${c.error} · 의심 ${c.suspect} · 미확인 ${c.unverified} · 한계 ${c.simlimit}${r.runtime ? ` · 행동 ${r.runtime.subjActions}` : ''}</span></summary><div class="au-det">${open.has(r.key) ? charDetail(r) : ''}</div></details>`;
    }).join('') || '<p class="note">아직 결과가 없습니다.</p>';
  }
  function charDetail(r) {
    const rt = r.runtime;
    const h = [];
    h.push(`<div class="note">조건: 등급 ${esc(r.grade || (rt && rt.grade) || '-')} · 레벨 ${esc(rt ? rt.level : r.opts.level)} · 스킬 레벨 ${esc(r.opts.skillLevel)} · 점검 ${r.ms}ms</div>`);
    if (rt) {
      h.push(`<div class="note">실행: 행동 ${rt.subjActions}회 · 전투 ${rt.battles.length}회 (${rt.battles.map((b) => esc(b.scenario + ':' + b.outcome)).join(', ')}) · 적 HP ${rt.enemyHp} / 공격력 ${rt.enemyAtk} · 받은 공격 ${rt.hitsTaken} · 처치 ${rt.kills} · 치명타 ${rt.crits} · 대기 ${rt.waits} · 체력 보정 ${rt.auditHeals}회 · 분대 ${esc((rt.fillers || []).map((k) => (APP.pcMap()[k] || {}).name || k).join(', ') || '없음')}</div>`);
      const sk = Object.values(rt.skills);
      h.push('<h3>스킬</h3><div class="tablewrap"><table><thead><tr><th>스킬</th><th class="n">슬롯</th><th>종류</th><th class="n">사용</th><th class="n">반격·지원</th><th class="n">명중</th><th class="n">빗나감</th><th class="n">피해 합계</th><th class="n">처치</th><th class="n">계수</th><th class="n">쿨타임</th><th class="n">아군 회복</th></tr></thead><tbody>' +
        sk.map((s) => `<tr><td>${esc(s.name)} <code>${esc(s.key)}</code></td><td class="n">${s.slot}</td><td>${s.type === 0 ? '액티브' : '패시브'}</td><td class="n">${s.type === 0 ? s.uses : '-'}</td><td class="n">${s.counterUses + s.assistUses || ''}</td><td class="n">${s.hits || ''}</td><td class="n">${s.misses || ''}</td><td class="n">${s.dmg ? s.dmg.toLocaleString() : ''}</td><td class="n">${s.kills || ''}</td><td class="n">${s.atkRate || ''}</td><td class="n">${s.cooldown || ''}</td><td class="n">${s.heal || ''}</td></tr>`).join('') + '</tbody></table></div>');
      const ks = Object.values(rt.keys);
      h.push('<h3>선언된 버프 효과 (적용 / 선언)</h3><div class="tablewrap"><table><thead><tr><th>효과 키</th><th>소속 스킬</th><th>트리거</th><th class="n">트리거 매칭</th><th class="n">적용</th><th>슬롯별 적용</th><th class="n">자신</th><th class="n">아군</th><th class="n">적</th><th class="n">중첩</th><th class="n">AP 변화</th></tr></thead><tbody>' +
        ks.map((k) => `<tr><td><code>${esc(k.key)}</code></td><td>${esc(k.skills.join(', '))}</td><td>${esc(k.trigger)}</td><td class="n">${k.triggered}</td><td class="n ${k.applied + k.stacked ? '' : 'o-stuck'}">${k.applied}</td><td>${esc(Object.entries(k.slots).map(([s, n]) => '#' + s + ':' + n).join(' '))}</td><td class="n">${k.onSelf || ''}</td><td class="n">${k.onAlly || ''}</td><td class="n">${k.onEnemy || ''}</td><td class="n">${k.stacked || ''}</td><td class="n">${k.ap || ''}</td></tr>`).join('') + '</tbody></table></div>');
    } else if (r.skills && r.skills.length) {
      h.push('<h3>스킬</h3><div class="tablewrap"><table><thead><tr><th>스킬</th><th class="n">슬롯</th><th>종류</th><th>해금</th><th>버프 키</th></tr></thead><tbody>' +
        r.skills.map((s) => `<tr><td>${esc(s.name)} <code>${esc(s.key)}</code></td><td class="n">${s.slot}</td><td>${s.type === 0 ? '액티브' : '패시브'}${s.kind !== 'group' ? ' (' + esc(s.kind) + ')' : ''}</td><td>${s.active ? '사용' : s.reachable ? '등급 부족' : '불가'}</td><td><code>${esc((s.keys || []).join(', '))}</code></td></tr>`).join('') + '</tbody></table></div>');
    }
    if (r.findings.length) {
      h.push('<h3>발견 항목</h3><div class="tablewrap"><table class="au-tbl"><thead><tr><th>심각도</th><th>스킬</th><th>효과 키</th><th>내용</th><th>근거</th></tr></thead><tbody>' +
        r.findings.map((f) => `<tr><td><span class="pill ${SEV_CLS[f.sev]}">${esc(A.SEV[f.sev])}</span></td><td>${esc(f.skillName)}</td><td>${f.effect ? '<code>' + esc(f.effect) + '</code>' + (f.slot ? ' #' + f.slot : '') : ''}</td><td class="msg">${esc(f.msg)}</td><td class="ev">${esc(f.evidence)}</td></tr>`).join('') + '</tbody></table></div>');
    }
    return h.join('');
  }

  // ------------------------------------------------------------------ export
  function info() {
    return { generatedAt: new Date().toISOString(), opts: S.opts || readOpts(), meta: APP.meta ? APP.meta() : null, failed: S.failed };
  }
  function sortedResults() { return S.results.slice().sort((a, b) => a.name.localeCompare(b.name, 'ko')); }
  const stem = () => `lo-audit-${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '')}`;
  async function saveFile(name, text, type, label) {
    const kb = Math.round(text.length / 1024);
    const dl = window.claude && window.claude.use ? await window.claude.use('downloads').catch(() => null) : null;
    if (dl) {
      try { await dl.save({ filename: name, data: new Blob([text], { type }) }); status(`${label} 저장 요청: ${name} (${kb} KB)`); }
      catch (e) { status(`${label} 저장이 취소되었거나 실패했습니다: ${e.code || e.message || e}`); }
      return;
    }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type }));
    a.download = name; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    status(`${label} 저장: ${name} (${kb} KB) · 브라우저의 다운로드 폴더를 확인하세요`);
  }
  async function copyText(text, label) {
    try { await navigator.clipboard.writeText(text); status(`${label}을(를) 클립보드에 복사했습니다 (${Math.round(text.length / 1024)} KB). Claude나 Codex 대화창에 붙여넣으세요.`); }
    catch (e) { status('클립보드 복사가 막혀 있습니다. 리포트 저장을 사용하세요.'); }
  }
  function reportHtml() {
    const rs = sortedResults();
    const s = A.summarize(rs);
    const inf = info();
    const o = inf.opts;
    const m = inf.meta;
    const kpi = (v, l, c) => `<div class="kpi"><b class="${c || ''}">${esc(v)}</b><span>${esc(l)}</span></div>`;
    const all = []; for (const r of rs) for (const f of r.findings) all.push(f);
    const top = all.filter((f) => f.sev === 'error' || f.sev === 'suspect').sort((a, b) => A.SEV_ORDER[a.sev] - A.SEV_ORDER[b.sev] || A.confRank(a.conf) - A.confRank(b.conf) || a.charName.localeCompare(b.charName, 'ko'));
    const pill = (f) => `<span class="pill ${SEV_CLS[f.sev]}">${esc(A.SEV[f.sev])}</span>`;
    const byCode = Object.entries(s.byCode).sort((a, b) => A.SEV_ORDER[a[0].split(':')[0]] - A.SEV_ORDER[b[0].split(':')[0]] || b[1] - a[1]);
    let h = `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>캐릭터 점검 리포트 ${esc(inf.generatedAt.slice(0, 10))}</title><style>
:root{--bg:#f4f5f3;--panel:#fff;--panel2:#f7f8f6;--ink:#15181a;--ink2:#4b5155;--ink3:#80878c;--rule:#dfe2df;--accent:#c2410c;--win:#15803d;--lose:#b91c1c;--stuck:#a16207;--err:#7e22ce;--timeout:#475569;color-scheme:light}
@media (prefers-color-scheme:dark){:root{--bg:#111315;--panel:#191c1f;--panel2:#1f2326;--ink:#eceeee;--ink2:#b6bcbf;--ink3:#868d92;--rule:#2c3135;--accent:#f07a3e;--win:#4ade80;--lose:#f87171;--stuck:#facc15;--err:#c084fc;--timeout:#94a3b8;color-scheme:dark}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.6 "Malgun Gothic","Apple SD Gothic Neo",system-ui,sans-serif}
main{max-width:1200px;margin:0 auto;padding:28px max(16px,env(safe-area-inset-left)) 60px;display:grid;gap:22px}
h1{margin:0;font-size:24px}h2{margin:0 0 10px;font-size:17px}h3{margin:8px 0 4px;font-size:13px;color:var(--ink2)}.meta{color:var(--ink3);font-size:12px}
section{background:var(--panel);border:1px solid var(--rule);border-radius:8px;padding:16px;min-width:0}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px}.kpi{background:var(--panel2);border-radius:6px;padding:10px 12px;display:grid}.kpi b{font-size:22px}.kpi span{font-size:12px;color:var(--ink3)}
.tw{overflow-x:auto}table{border-collapse:collapse;width:100%;font-size:12.5px}th,td{text-align:left;padding:5px 8px;border-bottom:1px solid var(--rule);vertical-align:top}th{color:var(--ink3);font-weight:500;white-space:nowrap}td.n,th.n{text-align:right}
td.w{min-width:240px}code{font-family:Consolas,monospace;font-size:11.5px}.note{color:var(--ink3);font-size:12px}
.pill{display:inline-block;padding:0 6px;border-radius:4px;font-size:11px;border:1px solid currentColor;white-space:nowrap}
.o-win{color:var(--win)}.o-lose{color:var(--lose)}.o-stuck{color:var(--stuck)}.o-error{color:var(--err)}.o-timeout{color:var(--timeout)}
details{border:1px solid var(--rule);border-radius:6px;margin:6px 0;background:var(--panel2)}summary{cursor:pointer;padding:6px 10px}details>div{padding:4px 10px 10px}
ul{margin:4px 0;padding-left:20px}pre{white-space:pre-wrap;word-break:break-word;background:var(--panel2);padding:10px;border-radius:6px;font:13px/1.6 inherit}
</style></head><body><main>
<header><h1>캐릭터 점검 리포트</h1><div class="meta">${esc(inf.generatedAt.replace('T', ' ').slice(0, 16))} UTC${m ? ` · 데이터 r${esc(m.dataRevision)} (${esc(m.extractedAt)}) · 전투 로직 r${esc(m.logicPortRevision)} 기준` : ''}</div>
<div class="meta">조건: 등급 ${esc(o.grade === 'max' ? '최대' : o.grade === 'start' ? '시작' : o.grade)} · 레벨 ${esc(o.level)} · 스킬 레벨 ${esc(o.skillLevel)} · 장비 없음 · 정적 점검 ${o.includeStatic ? '켬' : '끔'} · 실행 점검 ${o.includeRuntime ? `켬 (전투원당 행동 ${esc(o.actions)}회, 단독·전열 / 분대·중열 / 분대·후열${o.squad ? '' : ' → 단독만'})` : '끔'} · 시드 ${esc(o.seed)}</div></header>
<section><h2>요약</h2><div class="kpis">${kpi(s.chars, '점검한 전투원')}${kpi(s.ok, '정상 (오류·의심 없음)', 'o-win')}${kpi(s.suspectChars, '의심 전투원', 'o-lose')}${kpi(s.errorChars, '오류 전투원', 'o-error')}${kpi(s.findings.unverified, '미확인 항목', 'o-stuck')}${kpi(s.findings.simlimit, '시뮬레이터 한계 항목', 'o-timeout')}</div>
<p class="note">심각도 — 오류: 데이터 누락·엔진 예외·멈춤 (클라이언트 크래시/진행불가 후보) · 의심: 기획 의도와 다르게 동작할 가능성이 높음 · 미확인: 점검 시나리오에서 조건이 맞지 않아 확인하지 못함 · 시뮬레이터 한계: 아직 포팅하지 않은 효과 · 참고: 확인용 정보.
실행 점검은 시뮬레이터(클라이언트 전투 로직 포팅) 기준이며, 적은 HP·공격력을 대상에 맞춰 조정한 5기, 방어력 0, 체력 25% 미만이면 회복시킵니다.</p>
${s.displayOnlySlots ? `<p class="note">적용 확률 0인 효과 슬롯 ${s.displayOnlySlots}개는 실제 효과를 다른 곳(같은 행의 다른 슬롯, 하위 행, 트리거·조건으로 연결된 버프, 같은 전투원·소환물의 다른 버프)이 적용하고 있어 '표시 전용'으로 보고 의심에서 뺐습니다. 설명이 있는 슬롯은 아래 '표시 전용으로 판정한 슬롯' 표에 실제 적용 위치와 함께 남깁니다 (클라이언트는 확률 0 슬롯을 적용하지 않음, Creature.cs:3657).</p>` : ''}
${S.claudeText ? `<h3>Claude 분석</h3><pre>${esc(S.claudeText)}</pre>` : ''}
<h3>항목 종류별 개수</h3><div class="tw"><table><thead><tr><th>심각도</th><th>종류</th><th class="n">개수</th></tr></thead><tbody>${byCode.map(([k, v]) => { const [sev, code] = k.split(':'); return `<tr><td><span class="pill ${SEV_CLS[sev]}">${esc(A.SEV[sev])}</span></td><td>${esc(A.CODE_KO[code] || code)} <code>${esc(code)}</code></td><td class="n">${v}</td></tr>`; }).join('')}</tbody></table></div>
${inf.failed && inf.failed.length ? `<p class="note">점검 실패: ${esc(inf.failed.map((f) => f.key + ' (' + f.message + ')').join(', '))}</p>` : ''}</section>
<section><h2>오류·의심 (${top.length}건)</h2><div class="tw"><table><thead><tr><th>심각도</th><th>신뢰도</th><th>전투원</th><th>스킬</th><th>효과 키</th><th>내용</th><th>근거</th></tr></thead><tbody>
${top.map((f) => `<tr><td>${pill(f)}</td><td>${esc(A.CONF[f.conf] || f.conf)}</td><td>${esc(f.charName)}<div class="note"><code>${esc(f.char)}</code></div></td><td>${esc(f.skillName)}${f.skill ? `<div class="note"><code>${esc(f.skill)}</code></div>` : ''}</td><td>${f.effect ? `<code>${esc(f.effect)}</code>${f.slot ? ' #' + f.slot : ''}` : ''}</td><td class="w">${esc(f.msg)}<div class="note">${esc(A.CODE_KO[f.code] || f.code)}</div></td><td class="w">${esc(f.evidence)}${f.ref ? `<div class="note">참조: ${esc(f.ref)}</div>` : ''}</td></tr>`).join('')}
</tbody></table></div></section>
${(() => {
  const dv = [];
  for (const r of sortedResults()) for (const v of r.displayVerified || []) dv.push(Object.assign({ charName: r.name || r.charName || r.key }, v));
  if (!dv.length) return '';
  return `<section><h2>표시 전용으로 판정한 슬롯 (${dv.length}개, 의심에서 제외)</h2><p class="note">확률 0이라 클라이언트가 적용하지 않지만, 같은 효과를 다른 곳에서 실제로 적용하는 슬롯입니다.</p><div class="tw"><table><thead><tr><th>전투원</th><th>스킬</th><th>표시 슬롯</th><th>효과</th><th>설명</th><th>실제 적용 위치</th><th>판정 근거</th></tr></thead><tbody>${dv.map((v) => `<tr><td>${esc(v.charName)}</td><td>${esc(v.skillName)}</td><td><code>${esc(v.effect)}</code> #${v.slot}</td><td>${esc(v.type)}</td><td class="w">${esc(v.desc)}</td><td><code>${esc(v.carrier)}</code></td><td class="w">${esc(v.where)} · ${esc(v.how)}</td></tr>`).join('')}</tbody></table></div></section>`;
})()}
${(() => {
  const rs = sortedResults(); const dm = []; for (const r of rs) for (const m of r.descMatch || []) dm.push(m);
  if (!dm.length) return '';
  const VK = { match: '설명 효과 모두 확인', partial: '일부 효과 조건 미충족', missing: '설명 효과를 찾지 못함', 'conditional-only': '조건부 효과만 (판단 보류)', unused: '사용 안 됨' };
  const vc = {}; for (const m of dm) vc[m.verdict] = (vc[m.verdict] || 0) + 1;
  const miss = []; const passed = [];
  for (const r of rs) for (const f of r.findings) { if (f.code === 'DESC_EFFECT_MISSING') miss.push(f); if (f.passedByDesc) passed.push(f); }
  return `<section><h2>설명 대조 결과</h2><p class="note">스킬 설명의 효과 문구를 실제 전투에서 나온 효과와 대조했습니다. 설명의 효과가 모두 확인된 스킬은 확률 0 슬롯·트리거 미발동 같은 구조적 의심을 통과 처리합니다.</p>
<div class="kpis">${Object.entries(vc).map(([k, v]) => `<div class="kpi"><b>${v}</b><span>${esc(VK[k] || k)}</span></div>`).join('')}</div>
${miss.length ? `<h3>설명 효과를 찾지 못한 스킬 (${miss.length}개 · 의심 ${miss.filter((f) => f.sev === 'suspect').length} / 검토 필요 ${miss.filter((f) => f.sev !== 'suspect').length})</h3><div class="tw"><table><thead><tr><th>구분</th><th>전투원</th><th>스킬</th><th>못 찾은 효과</th><th>근거</th></tr></thead><tbody>${miss.map((f) => `<tr><td>${f.sev === 'suspect' ? '의심' : '검토 필요'}</td><td>${esc(f.charName)}</td><td>${esc(f.skillName)}</td><td class="w">${esc((f.msg.split(':').slice(1).join(':') || '').replace(' (설명 문구 해석 한계일 수 있음)', '').trim())}</td><td class="w">${esc(f.evidence)}</td></tr>`).join('')}</tbody></table></div>` : ''}
${passed.length ? `<h3>설명 대조로 통과 처리한 항목 (${passed.length}개)</h3><ul>${passed.map((f) => `<li>${esc(f.charName)} · ${esc(f.skillName)}: ${esc(f.msg.replace('[설명 대조 통과] ', ''))}</li>`).join('')}</ul>` : ''}</section>`;
})()}
<section><h2>전투원별 상세</h2><p class="note">펼치면 스킬 사용·피해, 선언된 버프 효과별 적용 횟수, 전체 발견 항목(미확인 포함)을 볼 수 있습니다.</p>`;
    for (const r of rs.slice().sort((a, b) => ({ error: 0, suspect: 1, ok: 2 }[a.verdict] - { error: 0, suspect: 1, ok: 2 }[b.verdict]) || a.name.localeCompare(b.name, 'ko'))) {
      const [vt, vc] = VERDICT[r.verdict];
      const c = r.counts, rt = r.runtime;
      h += `<details><summary><span class="pill ${vc}">${vt}</span> <b>${esc(r.name)}</b> <code>${esc(r.key)}</code> <span class="note">오류 ${c.error} · 의심 ${c.suspect} · 미확인 ${c.unverified} · 한계 ${c.simlimit}</span></summary><div>`;
      if (rt) {
        h += `<div class="note">행동 ${rt.subjActions}회 · 전투 ${rt.battles.length}회 · 적 HP ${rt.enemyHp} / 공격력 ${rt.enemyAtk} · 받은 공격 ${rt.hitsTaken} · 처치 ${rt.kills} · 분대 ${esc((rt.fillers || []).join(', ') || '없음')}</div>`;
        h += '<h3>스킬</h3><div class="tw"><table><thead><tr><th>스킬</th><th class="n">슬롯</th><th class="n">사용</th><th class="n">명중</th><th class="n">피해</th><th class="n">계수</th></tr></thead><tbody>' + Object.values(rt.skills).map((s) => `<tr><td>${esc(s.name)} <code>${esc(s.key)}</code></td><td class="n">${s.slot}${s.type ? ' (P)' : ''}</td><td class="n">${s.type === 0 ? s.uses : '-'}</td><td class="n">${s.hits || ''}</td><td class="n">${s.dmg || ''}</td><td class="n">${s.atkRate || ''}</td></tr>`).join('') + '</tbody></table></div>';
        h += '<h3>버프 효과</h3><div class="tw"><table><thead><tr><th>효과 키</th><th>트리거</th><th class="n">매칭</th><th class="n">적용</th><th>슬롯</th></tr></thead><tbody>' + Object.values(rt.keys).map((k) => `<tr><td><code>${esc(k.key)}</code></td><td>${esc(k.trigger)}</td><td class="n">${k.triggered}</td><td class="n ${k.applied + k.stacked ? '' : 'o-stuck'}">${k.applied}</td><td>${esc(Object.entries(k.slots).map(([x, n]) => '#' + x + ':' + n).join(' '))}</td></tr>`).join('') + '</tbody></table></div>';
      }
      if (r.findings.length) h += '<h3>발견 항목</h3><ul>' + r.findings.map((f) => `<li><span class="pill ${SEV_CLS[f.sev]}">${esc(A.SEV[f.sev])}</span> ${f.skillName ? esc(f.skillName) + ' · ' : ''}${f.effect ? '<code>' + esc(f.effect) + '</code> · ' : ''}${esc(f.msg)} <span class="note">${esc(f.evidence)}</span></li>`).join('') + '</ul>';
      h += '</div></details>';
    }
    h += '</section></main></body></html>';
    return h;
  }
  async function claude() {
    const sample = APP.sample && APP.sample();
    if (!sample) { status('Claude는 claude.ai에 게시된 페이지에서만 쓸 수 있습니다.'); setButtons(); return; }
    let text = A.markdown(sortedResults(), Object.assign({ maxRows: 180, perCharacter: false }, info()));
    if (text.length > 150000) text = text.slice(0, 150000) + '\n(이하 생략)';
    const prompt = `너는 모바일 게임 "라스트오리진"의 QA 리드다. 아래는 전투 시뮬레이터(클라이언트 전투 로직 포팅)로 모든 전투원의 스킬·버프 효과를 점검한 결과다.
한국어로 다음 형식의 판단을 써라. 수치·키는 아래 기록에 있는 것만 쓰고, 추측은 추측이라고 표시한다.
1. 한 줄 결론
2. 기획 의도와 다르게 동작할 가능성이 가장 높은 항목 (전투원·스킬·효과 키·근거, 우선순위 높은 순, 최대 15개)
3. 크래시·진행불가 후보
4. 점검 도구의 오탐일 가능성이 있는 항목 유형과 이유
5. 기획/개발에 확인 요청할 질문 3~5개

${text}`;
    $('auClaudeCard').hidden = false;
    const out = $('auClaudeOut');
    out.textContent = '생각 중…';
    $('auClaude').disabled = true;
    try {
      const { text: res } = await sample(prompt, { onText: ({ text: t }) => { out.textContent = t; } });
      S.claudeText = res; out.textContent = res;
      status('Claude 분석을 받았습니다. 리포트 저장을 누르면 함께 저장됩니다.');
    } catch (e) {
      out.textContent = e.code === 'not_granted' ? 'Claude 사용이 허용되지 않았습니다.' : e.code === 'prompt_too_large' ? '결과가 너무 깁니다. 대상 전투원을 줄여 다시 시도하세요.' : e.code === 'cancelled' ? '취소되었습니다.' : '응답 실패: ' + (e.code || e.message || e);
    } finally { setButtons(); }
  }

  // ------------------------------------------------------------------ wiring
  function wire() {
    $('auStart').addEventListener('click', start);
    $('auStop').addEventListener('click', stop);
    $('auFilter').addEventListener('input', () => { updateTargetCount(); saveSettings(); });
    for (const id of FIELDS) $(id).addEventListener('change', saveSettings);
    for (const id of ['auSev', 'auConf', 'auCode', 'auCat']) $(id).addEventListener('change', () => { S.shown = PAGE; renderFindings(); });
    $('auFFilter').addEventListener('input', () => { S.shown = PAGE; renderFindings(); });
    $('auVerdict').addEventListener('change', renderChars);
    $('auMore').addEventListener('click', () => { S.shown += PAGE; renderFindings(); });
    ROOT.querySelector('.au-tbl thead').addEventListener('click', (e) => {
      const th = e.target.closest('th[data-sort]');
      if (!th) return;
      const c = th.dataset.sort;
      S.sort = { col: c, dir: S.sort.col === c ? -S.sort.dir : 1 };
      renderFindings();
    });
    $('auFBody').addEventListener('click', (e) => {
      const a = e.target.closest('a[data-char]');
      if (!a) return;
      e.preventDefault();
      $('auVerdict').value = '';
      renderChars();
      const d = $('auChars').querySelector(`details[data-key="${CSS.escape(a.dataset.char)}"]`);
      if (d) { d.open = true; d.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
    });
    $('auChars').addEventListener('toggle', (e) => {
      const d = e.target;
      if (!d.open || d.tagName !== 'DETAILS') return;
      const r = S.byKey.get(d.dataset.key);
      const body = d.querySelector('.au-det');
      if (r && body && !body.innerHTML) body.innerHTML = charDetail(r);
    }, true);
    $('auSave').addEventListener('click', () => saveFile(stem() + '-report.html', reportHtml(), 'text/html', '리포트(HTML)'));
    $('auCopy').addEventListener('click', () => copyText(A.markdown(sortedResults(), Object.assign({ maxRows: 600 }, info())), '리포트(Markdown)'));
    $('auJson').addEventListener('click', () => saveFile(stem() + '.json', JSON.stringify({ info: info(), summary: A.summarize(S.results), results: sortedResults() }, null, 1), 'application/json', '원본 JSON'));
    $('auClaude').addEventListener('click', claude);
    // Claude may connect after mount
    const t = setInterval(() => { if (!ROOT.isConnected) { clearInterval(t); return; } if (!S.running) setButtons(); }, 3000);
  }

  let descCache = null;
  async function auditOneTool(i) {
    const key = String(i.key || '');
    if (!window.LOSim.T('Table_PC', key)) throw new Error('unknown character ' + key);
    const core = await loadCore();
    if (descCache === null) descCache = await fetch('data/skilldesc.json').then((r) => (r.ok ? r.json() : null)).catch(() => null);
    const opts = Object.assign({}, core.DEFAULTS, S.opts || {}, i.grade ? { grade: String(i.grade) } : {}, i.level ? { level: +i.level } : {}, i.skillLevel ? { skillLevel: +i.skillLevel } : {}, i.actions ? { actions: Math.min(120, +i.actions) } : {});
    const ov = Array.isArray(i.overrides) ? i.overrides : i.overrides ? [i.overrides] : [];
    const changes = window.LOApp && window.LOApp.checkOverrides ? window.LOApp.checkOverrides(ov) : null;
    const r = window.LOSim.withOverrides(ov, () => core.auditCharacter(key, opts, descCache));
    return { key, name: r.name, overridesApplied: changes || undefined, verdict: r.verdict, counts: r.counts, grades: r.runtime && r.runtime.grades,
      findings: r.findings.filter((f) => f.sev !== 'info' || f.code === 'PROMO_REPLACE').slice(0, 40).map((f) => ({ sev: f.sev, code: f.code, skill: f.skillName, effect: f.effect, msg: f.msg, evidence: String(f.evidence || '').slice(0, 300) })),
      descMatch: (r.descMatch || []).map((m) => ({ skill: m.skillName, verdict: m.verdict, missing: m.missing, notSeen: m.notSeen })),
      skills: r.runtime ? Object.values(r.runtime.skills).map((s) => ({ name: s.name, slot: s.slot, uses: s.uses, hits: s.hits, dmg: Math.round(s.dmg), buffApplies: s.buffApplies })) : [] };
  }
  window.LOAudit = {
    reportTools: () => [{
      name: 'audit_character',
      description: 'Re-run the full character audit (data checks + runtime battles + description match) for ONE character, optionally at another grade/level/skill level (grade: "max", "start" or 1-5). Returns verdict, finding list (severity, code, skill, message, evidence), description-match verdicts and per-skill usage. Takes a few seconds; use for a handful of characters only. ' + ((window.LOApp && window.LOApp.OV_HINT) || ''),
      inputSchema: { type: 'object', properties: { key: { type: 'string' }, grade: { type: 'string' }, level: { type: 'number' }, skillLevel: { type: 'number' }, actions: { type: 'number' }, overrides: window.LOApp && window.LOApp.ovSchema ? window.LOApp.ovSchema() : { type: 'array', items: { type: 'object' } } }, required: ['key'] },
      execute: (i) => auditOneTool(i),
    }, {
      name: 'character_findings',
      description: 'Return every finding (including unverified/info) of one character from the CURRENT audit results without re-running anything.',
      inputSchema: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'] },
      execute: (i) => { const r = S.byKey.get(String(i.key)) || S.results.find((x) => x.key === String(i.key) || x.name === String(i.key)); if (!r) throw new Error('not in current results'); return { key: r.key, name: r.name, verdict: r.verdict, findings: r.findings.slice(0, 80).map((f) => ({ sev: f.sev, code: f.code, skill: f.skillName, effect: f.effect, msg: f.msg, evidence: String(f.evidence || '').slice(0, 240) })) }; },
    }],
    // for automation / other tabs: current results and the two report formats
    results: () => S.results.slice(),
    reportHtml: () => (A && S.results.length ? reportHtml() : ''),
    reportMarkdown: (o) => (A && S.results.length ? A.markdown(sortedResults(), Object.assign({ maxRows: 600 }, info(), o || {})) : ''),
    mount(container, app) {
      APP = app; ROOT = container;
      container.innerHTML = '<section class="card"><p class="note">점검 모듈을 불러오는 중…</p></section>';
      loadCore().then((core) => {
        A = core;
        render(container);
        restoreSettings();
        wire();
        updateTargetCount();
        setButtons();
        renderKpis();
      }).catch((e) => { container.innerHTML = `<section class="card"><p class="note">점검 모듈을 불러오지 못했습니다: ${esc(e.message)}</p></section>`; });
    },
  };
})();
