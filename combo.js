// "조합 분석" tab: searches squads (members + 3x3 formation) for balance outliers -- highest sustained DPS,
// burst, squads that never die, fastest stage clear. Search logic lives in combo-core.js (LOSim.combo, shared with
// tools/combo_node.js); battles run in combo-worker.js Web Workers so the page never freezes.
(function () {
  const LS_KEY = 'lo-combo-settings-v2';
  let APP = null, root = null, C = null, pool = null, running = false, stopFlag = false, lastRes = null, t0 = 0, doneJobs = 0, estJobs = 1;
  const locked = [];
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const $ = (id) => root.querySelector('#' + id);
  const store = {
    get() { try { return JSON.parse(localStorage.getItem(LS_KEY) || 'null'); } catch (e) { return null; } },
    set(v) { try { localStorage.setItem(LS_KEY, JSON.stringify(v)); } catch (e) { /* storage blocked: settings are just not kept */ } },
  };

  function loadCore() {
    if (window.LOSim && window.LOSim.combo && window.LOSim.combo.search) return Promise.resolve();
    return new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = 'combo-core.js';
      s.onload = () => res();
      s.onerror = () => rej(new Error('combo-core.js를 불러오지 못했습니다'));
      document.head.appendChild(s);
    });
  }

  // ------------------------------------------------------------------ worker pool
  function makePool() {
    const n = Math.max(1, Math.min(6, (navigator.hardwareConcurrency || 4) - 1));
    const ws = [];
    let seq = 0;
    const pending = new Map();
    const failAll = (err) => { for (const p of pending.values()) p.rej(err); pending.clear(); };
    for (let i = 0; i < n; i++) {
      const w = new Worker('combo-worker.js');
      w.onmessage = (ev) => {
        const m = ev.data;
        if (m.type !== 'result' && m.type !== 'error') return;
        const p = pending.get(m.id); if (!p) return;
        pending.delete(m.id);
        if (m.type === 'result') p.res(m.out); else p.rej(new Error(m.message));
      };
      w.onerror = (e) => { e.preventDefault && e.preventDefault(); failAll(new Error('워커 오류: ' + (e.message || '스크립트를 불러오지 못했습니다 (네트워크 확인)'))); };
      w.postMessage({ type: 'init' });
      ws.push(w);
    }
    const send = (w, jobs) => new Promise((res, rej) => { const id = ++seq; pending.set(id, { res, rej }); w.postMessage({ type: 'eval', id, jobs }); });
    return {
      size: n,
      async evalMany(jobs, onDone) {
        const out = new Array(jobs.length);
        let next = 0;
        await Promise.all(ws.map(async (w) => {
          while (next < jobs.length) {
            const i = next++;
            const [r] = await send(w, [jobs[i]]);
            out[i] = r; onDone && onDone();
          }
        }));
        return out;
      },
      terminate() { for (const w of ws) w.terminate(); failAll(new Error('STOP')); },
    };
  }

  // ------------------------------------------------------------------ markup
  const CSS = `
  .cb-call details>summary{cursor:pointer;list-style:none}.cb-call details>summary::-webkit-details-marker{display:none}
  .cb-call details>summary::before{content:'▸ ';color:var(--ink-3)}.cb-call details[open]>summary::before{content:'▾ '}
  .cb-ev{margin:8px 0 4px 14px;padding:10px;border-left:2px solid var(--rule);display:grid;gap:8px;font-size:12.5px}
  .cb-ev p{margin:0}.cb-evt th{white-space:nowrap;color:var(--ink-3);font-weight:500;vertical-align:top;padding-right:12px}.cb-evt td{white-space:normal}
  .cb-seeds{display:flex;align-items:flex-end;gap:2px;height:30px}.cb-seeds span{flex:0 0 8px;display:flex;align-items:flex-end;height:30px}.cb-seeds i{display:block;width:8px;background:var(--accent);border-radius:2px 2px 0 0}
  .cb-evn{margin:0;padding-left:18px;color:var(--ink-2)}
  .cb-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:12px}
  .cb-box{border:1px solid var(--rule);border-radius:6px;padding:10px;display:grid;gap:8px;align-content:start;min-width:0}
  .cb-box h3{margin:0;font-size:12px;font-weight:600;color:var(--ink-2)}
  .cb-box .row>label{flex:1 1 90px}
  .cb-box input[type=number]{width:100%}
  .cb-box select{width:100%}
  .cb-chk{display:flex;flex-wrap:wrap;gap:6px 14px;font-size:13px}
  .cb-chk label{display:flex;gap:5px;align-items:center;cursor:pointer}
  .cb-chips{display:flex;flex-wrap:wrap;gap:4px}
  .cb-chip{font-size:12px;border:1px solid var(--rule);border-radius:12px;padding:1px 4px 1px 8px;background:var(--panel-2);display:inline-flex;gap:4px;align-items:center}
  .cb-chip button{border:none;background:none;padding:0 4px;color:var(--ink-3)}
  .cb-mini{display:grid;grid-template-columns:repeat(3,64px);gap:2px;font-size:10.5px}
  .cb-mini span{border:1px solid var(--rule);border-radius:3px;padding:1px 3px;min-height:18px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;background:var(--panel-2);color:var(--ink-3)}
  .cb-mini span.on{color:var(--ink);background:var(--panel);font-weight:600}
  .cb-mini span.r0{border-color:var(--win)} .cb-mini span.r1{border-color:var(--lose)} .cb-mini span.r2{border-color:var(--accent)}
  .cb-call{display:grid;gap:4px;margin:0;padding:0;list-style:none}
  .cb-call li{font-size:12.5px;padding:6px 8px;border-radius:5px;background:var(--panel-2);border-left:3px solid var(--stuck)}
  .cb-call li.high{border-left-color:var(--lose);background:var(--accent-soft)}
  .cb-bar{display:inline-block;height:8px;border-radius:2px;background:var(--accent);vertical-align:middle;margin-right:6px}
  .cb-bar.neg{background:var(--ink-3)}
  .cb-det{font-size:12px;display:grid;gap:4px;white-space:normal}
  td.cb-mem{white-space:normal;min-width:180px}
  .cb-out{white-space:pre-wrap;font-size:12.5px;background:var(--panel-2);border-radius:6px;padding:10px;max-height:480px;overflow:auto}
  details.cb-help summary{cursor:pointer;color:var(--ink-2);font-size:12.5px}
  details.cb-help div{font-size:12.5px;color:var(--ink-2);display:grid;gap:6px;margin-top:6px}
  .cb-role{font-size:10px;color:var(--ink-3)}
  `;
  function html() {
    return `<style>${CSS}</style>
<section class="card" aria-labelledby="cb-h">
  <h2 id="cb-h">조합 분석 <span class="sp">전투원·배치를 바꿔 가며 수천 번 전투를 돌려 밸런스 이상치(괴물 조합)를 찾습니다</span></h2>
  <div class="cb-grid">
    <div class="cb-box"><h3>목표 (여러 개 선택 가능)</h3>
      <div class="cb-chk" id="cbObj">
        <label><input type="checkbox" value="dps" checked>지속 DPS</label>
        <label><input type="checkbox" value="burst">순간 화력</label>
        <label><input type="checkbox" value="survival" checked>생존 (불사)</label>
        <label><input type="checkbox" value="clear">스테이지 클리어</label>
        <label><input type="checkbox" value="balanced">종합</label>
      </div>
      <div class="note">목표마다 탐색 예산을 나눠 씁니다. 지속 DPS와 순간 화력은 같은 전투에서 함께 측정됩니다.</div>
    </div>
    <div class="cb-box"><h3>전투원 가정 (모두 동일)</h3>
      <div class="row">
        <label>등급<select id="cbGrade"><option value="max">최대 등급</option><option value="start">시작 등급</option><option value="3">B 고정</option><option value="4">A 고정</option><option value="5">S 고정</option><option value="6">SS 고정</option></select></label>
        <label>레벨<input type="number" id="cbLevel" min="1" max="120" value="100"></label>
        <label>스킬 Lv<input type="number" id="cbSkill" min="1" max="10" value="10"></label>
      </div>
      <div class="note">장비·코어 링크·호감도 없음. 같은 조건에서 캐릭터 자체 성능만 비교합니다.</div>
    </div>
    <div class="cb-box"><h3>DPS 벤치 (허수아비)</h3>
      <div class="row">
        <label>배치<select id="cbLayout"></select></label>
        <label>Lv<input type="number" id="cbDLevel" min="1" max="200" value="100"></label>
      </div>
      <div class="row">
        <label title="허수아비 명목 HP = 표적 더미 HP × 이 값. '대상 HP 비례' 피해는 이 HP 기준으로 환산합니다">HP 배율<input type="number" id="cbHpMul" min="1" max="1000" value="10"></label>
        <label title="측정 시간 (1기준턴 = 속도 4인 유닛이 한 번 행동하는 시간)">측정 기준턴<input type="number" id="cbTurns" min="3" max="100" value="20"></label>
        <label title="순간 화력: 개전 후 이 시간 동안 준 피해">개전 기준턴<input type="number" id="cbBurst" min="1" max="20" value="3"></label>
      </div>
    </div>
    <div class="cb-box"><h3>생존·클리어 벤치 (실제 스테이지 적)</h3>
      <div class="row"><label>챕터<select id="cbChap"></select></label><label>스테이지<select id="cbStage"></select></label></div>
      <div class="row">
        <label>버티기 웨이브<select id="cbWave"></select></label>
        <label title="적 HP 배율">적 HP 배율<input type="number" id="cbEHp" min="1" max="100000" value="1000"></label>
        <label>버티기 기준턴<input type="number" id="cbETurns" min="5" max="200" value="30"></label>
        <label title="적 공격력 배율: 상위 조합이 모두 사망 0으로 같아지면 올려서 한계를 비교하세요">적 공격력 배율<input type="number" id="cbEAtk" min="0.1" max="100" step="0.5" value="1"></label>
      </div>
      <div class="cb-chk"><label title="켜면 적이 매 행동 후 HP를 회복해 절대 죽지 않습니다. 순수하게 '얼마나 버티는가'만 봅니다 (끄면 적을 다 잡아도 생존으로 인정)"><input type="checkbox" id="cbERegen" checked>적 무적 (매 행동 후 HP 회복)</label></div>
      <div class="note">생존: 실제 적 AI가 공격하는 웨이브를 정해진 시간 동안 버팁니다. 클리어: 같은 스테이지를 처음부터 실제로 클리어합니다.</div>
    </div>
    <div class="cb-box"><h3>후보 전투원</h3>
      <div class="row"><label class="grow">이름·키 검색 (공백/쉼표로 여러 개)<input id="cbSearch" placeholder="예: 앤젤, PECS"></label></div>
      <div class="cb-chk" id="cbRoles"><label><input type="checkbox" value="0" checked>탱커</label><label><input type="checkbox" value="1" checked>딜러</label><label><input type="checkbox" value="2" checked>서포터</label></div>
      <div class="row"><label class="grow">제외 (이름 또는 키, 쉼표)<input id="cbExclude" placeholder="예: 라미아, Char_BR_Alvis_N"></label></div>
      <div class="row"><label class="grow">고정 멤버 (최대 5)<input id="cbLockIn" list="cbPcList" placeholder="이름 입력 후 추가"></label><button id="cbLockAdd">추가</button></div>
      <datalist id="cbPcList"></datalist>
      <div class="cb-chips" id="cbLocked"></div>
      <div class="note" id="cbPoolInfo"></div>
    </div>
    <div class="cb-box"><h3>탐색</h3>
      <div class="row">
        <label title="1차 선별(전 후보 단독·기준 분대+1 평가) 이후 유전 탐색·배치 다듬기에 쓸 분대 평가 횟수">예산<input type="number" id="cbBudget" min="30" max="20000" value="600"></label>
        <label title="분대 하나를 평가할 때 돌리는 전투 수 (같은 시드를 모든 분대에 사용)">시드<input type="number" id="cbSeeds" min="1" max="20" value="3"></label>
        <label title="상위 조합을 새 시드로 다시 돌려 최종 순위를 정합니다 (운 좋은 시드 배제)">검증 시드<input type="number" id="cbVSeeds" min="3" max="500" value="20"></label>
      </div>
      <div class="row">
        <label title="1차 선별 후 남길 후보 수">후보 압축<input type="number" id="cbShort" min="8" max="80" value="28"></label>
        <label>시작 시드<input type="number" id="cbBase" min="1" value="1000"></label>
      </div>
      <div class="row" title="종합 목표에서 각 점수의 가중치">
        <label>종합: DPS<input type="number" id="cbWd" step="0.5" min="0" value="1"></label>
        <label>순간<input type="number" id="cbWb" step="0.5" min="0" value="0.5"></label>
        <label>생존<input type="number" id="cbWs" step="0.5" min="0" value="1"></label>
        <label>클리어<input type="number" id="cbWc" step="0.5" min="0" value="0"></label>
      </div>
      <div class="row"><button id="cbP1">빠르게 (150)</button><button id="cbP2">보통 (600)</button><button id="cbP3">정밀 (2000)</button></div>
    </div>
  </div>
  <div class="row">
    <button class="primary" id="cbStart">분석 시작</button><button id="cbStop" disabled>중지</button>
    <span class="note" id="cbStatus">대기 중</span>
  </div>
  <div class="prog" aria-hidden="true"><i id="cbProg"></i></div>
  <details class="cb-help"><summary>분석 방법과 점수 정의</summary><div id="cbHelp"></div></details>
</section>
<section class="card" aria-labelledby="cb-hr" id="cbResCard" hidden>
  <h2 id="cb-hr">결과 <span class="sp" id="cbResMeta"></span></h2>
  <div class="row">
    <button id="cbSaveHtml">리포트 저장 (HTML)</button><button id="cbCopyMd">리포트 복사 (Markdown)</button><button id="cbSaveJson">원본 JSON 저장</button>
    <button id="cbClaude" title="claude.ai에 게시된 페이지에서만 동작합니다">Claude 분석</button>
    <span class="note" id="cbExpMsg"></span>
  </div>
  <div class="cb-out" id="cbClaudeOut" hidden></div>
  <div class="tabs" role="tablist" id="cbTabs"></div>
  <div id="cbPanel"></div>
</section>`;
  }

  // ------------------------------------------------------------------ settings
  const FIELDS = ['cbGrade', 'cbLevel', 'cbSkill', 'cbLayout', 'cbDLevel', 'cbHpMul', 'cbTurns', 'cbBurst', 'cbChap', 'cbStage', 'cbWave', 'cbEHp', 'cbEAtk', 'cbETurns', 'cbSearch', 'cbExclude', 'cbBudget', 'cbSeeds', 'cbVSeeds', 'cbShort', 'cbBase', 'cbWd', 'cbWb', 'cbWs', 'cbWc'];
  function save() {
    const v = { f: {}, obj: checked('cbObj'), roles: checked('cbRoles'), locked: locked.slice(), regen: $('cbERegen').checked };
    for (const id of FIELDS) v.f[id] = $(id).value;
    store.set(v);
  }
  function restore() {
    const v = store.get(); if (!v) return;
    for (const id of FIELDS) if (v.f && v.f[id] !== undefined && id !== 'cbChap' && id !== 'cbStage' && id !== 'cbWave') $(id).value = v.f[id];
    if (v.f && v.f.cbStage) { const s = APP.findStage(v.f.cbStage); if (s) { $('cbChap').value = s.chapter; renderStages(v.f.cbStage); } }
    if (v.f && v.f.cbWave) $('cbWave').value = v.f.cbWave;
    if (Array.isArray(v.obj)) root.querySelectorAll('#cbObj input').forEach((i) => (i.checked = v.obj.includes(i.value)));
    if (Array.isArray(v.roles)) root.querySelectorAll('#cbRoles input').forEach((i) => (i.checked = v.roles.includes(i.value)));
    if (typeof v.regen === 'boolean') $('cbERegen').checked = v.regen;
    if (Array.isArray(v.locked)) for (const k of v.locked) if (APP.pcMap()[k] && !locked.includes(k)) locked.push(k);
  }
  const checked = (id) => [...root.querySelectorAll('#' + id + ' input:checked')].map((i) => i.value);

  function renderStages(sel) {
    const ch = $('cbChap').value;
    const list = APP.stages('stage').filter((s) => s.chapter === ch);
    $('cbStage').innerHTML = list.map((s) => `<option value="${esc(s.key)}">${esc(s.idx)} ${esc(s.name || '')} · ${s.waves}웨이브</option>`).join('');
    if (sel && list.some((s) => s.key === sel)) $('cbStage').value = sel;
    renderWaves();
  }
  function renderWaves() {
    const s = APP.findStage($('cbStage').value);
    const n = s ? s.waves : 1;
    let h = '<option value="last">마지막(보스) 웨이브</option>';
    for (let i = 1; i <= n; i++) h += `<option value="${i}">${i}웨이브</option>`;
    $('cbWave').innerHTML = h;
  }
  function resolveKeys(text) {
    const pcs = APP.pcs(), out = [], miss = [];
    for (const t of String(text || '').split(/[,\n]+/).map((x) => x.trim()).filter(Boolean)) {
      const p = pcs.find((x) => x.key === t) || pcs.find((x) => x.name === t) || pcs.find((x) => x.name.includes(t));
      if (p) out.push(p.key); else miss.push(t);
    }
    return { keys: out, miss };
  }
  function readCfg() {
    const g = $('cbGrade').value;
    const ex = resolveKeys($('cbExclude').value);
    return {
      objectives: checked('cbObj'),
      assume: { grade: g === 'max' || g === 'start' ? g : +g, level: +$('cbLevel').value || 100, skillLevel: +$('cbSkill').value || 10 },
      dummy: { layout: $('cbLayout').value, level: +$('cbDLevel').value || 100, hpMul: +$('cbHpMul').value || 10, turns: +$('cbTurns').value || 20, burstTurns: +$('cbBurst').value || 3 },
      endurance: { stageKey: $('cbStage').value, mode: 'stage', wave: $('cbWave').value, hpMul: +$('cbEHp').value || 1000, atkMul: +$('cbEAtk').value || 1, regen: $('cbERegen').checked, turns: +$('cbETurns').value || 30 },
      stage: { stageKey: $('cbStage').value, mode: 'stage', maxTurns: 120 },
      weights: { dps: +$('cbWd').value || 0, burst: +$('cbWb').value || 0, survival: +$('cbWs').value || 0, clear: +$('cbWc').value || 0 },
      budget: +$('cbBudget').value || 600, seeds: +$('cbSeeds').value || 3, verifySeeds: +$('cbVSeeds').value || 20,
      shortlist: +$('cbShort').value || 28, baseSeed: +$('cbBase').value || 1000, verifyTop: 10,
      pool: { search: $('cbSearch').value, exclude: ex.keys, roles: checked('cbRoles').map(Number) },
      locked: locked.slice(),
      _excludeMiss: ex.miss,
    };
  }
  function poolInfo() {
    if (!C) return;
    const cfg = readCfg();
    const n = C.filterPool(C.pcPool(), cfg.pool).length;
    const benches = C.benchesFor(cfg.objectives.length ? cfg.objectives : ['dps']).length;
    $('cbPoolInfo').innerHTML = `후보 <b>${n}</b>명` + (cfg._excludeMiss.length ? ` · <span class="o-stuck">찾지 못함: ${esc(cfg._excludeMiss.join(', '))}</span>` : '') +
      ` · 1차 선별 약 ${(2 * n + 6) * benches}회 평가 + 예산 ${cfg.budget}회`;
    $('cbLocked').innerHTML = locked.map((k) => `<span class="cb-chip">${esc(APP.pcMap()[k] ? APP.pcMap()[k].name : k)}<button data-k="${esc(k)}" aria-label="고정 해제">×</button></span>`).join('') || '<span class="note">고정 멤버 없음</span>';
    $('cbLocked').querySelectorAll('button').forEach((b) => b.addEventListener('click', () => { locked.splice(locked.indexOf(b.dataset.k), 1); poolInfo(); save(); }));
  }
  function helpText() {
    const cfg = readCfg();
    const res = { benches: {}, config: cfg };
    try { for (const k of C.benchesFor(['balanced'])) res.benches[k] = C.makeBench(k, cfg); } catch (e) { /* stage without waves */ }
    const defs = C.scoreDefs(res).map((s) => `<p>${esc(s)}</p>`).join('');
    return `<p><b>1차 선별</b>: 후보 전원을 (1) 혼자, (2) "기준 분대"(단독 상위 4명)에 다섯 번째로 넣어 평가합니다. (2)의 점수 증가량 = 그 전투원이 강한 분대에 더해 주는 가치로, 자기 딜과 아군 버프를 함께 반영합니다. 상위 ${esc(cfg.shortlist)}명(역할별 최소 3명, 고정 멤버 포함)만 남깁니다.</p>
<p><b>2차 탐색</b>: 남은 후보로 5명 분대와 3×3 배치를 함께 유전 탐색합니다 (교차·멤버 교체·칸 이동·칸 교환). 모든 분대는 같은 시드 묶음으로 평가해 비교 잡음을 줄이고, 순위는 "평균 − 표준오차"로 매겨 운 좋은 결과를 덜 믿습니다. 평가한 분대는 캐시합니다.</p>
<p><b>3차 다듬기</b>: 상위 3개 멤버 구성에 대해 칸 이동·교환·멤버 교체를 하나씩 시도해 더 좋아지지 않을 때까지 국소 탐색합니다.</p>
<p><b>4차 검증</b>: 상위 ${esc(cfg.verifyTop)}개를 탐색에 쓰지 않은 새 시드 ${esc(cfg.verifySeeds)}개로 다시 돌려 최종 순위와 평균 ± 표준편차를 냅니다.</p>
<p><b>5차 해석</b>: 상위 3개 분대에서 한 명씩 빼 보고(기여도), 두 명씩 빼 보아(짝 상호작용 = 둘이 함께일 때만 생기는 점수) 왜 강한지 설명합니다.</p>
${defs}<p><b>주의</b></p>${C.caveats().map((c) => `<p>· ${esc(c)}</p>`).join('')}`;
  }

  // ------------------------------------------------------------------ run
  function setStatus(t) { $('cbStatus').textContent = t; }
  function setBusy(b) { running = b; $('cbStart').disabled = b; $('cbStop').disabled = !b; if (!b) $('cbProg').style.width = '0'; }
  async function start() {
    if (running) return;
    const cfg = readCfg();
    if (!cfg.objectives.length) { setStatus('목표를 하나 이상 고르세요'); return; }
    if (cfg.objectives.includes('balanced') && !Object.values(cfg.weights).some((w) => w > 0)) { setStatus('종합 가중치가 모두 0입니다'); return; }
    delete cfg._excludeMiss;
    try { for (const k of C.benchesFor(cfg.objectives)) C.makeBench(k, cfg); } catch (e) { setStatus('벤치 설정 오류: ' + e.message); return; }
    save();
    setBusy(true); stopFlag = false; t0 = Date.now(); doneJobs = 0;
    const nPool = C.filterPool(C.pcPool(), cfg.pool).length;
    estJobs = C.benchesFor(cfg.objectives).length * (2 * nPool + 6) + cfg.budget + cfg.objectives.length * (cfg.verifyTop * (cfg.objectives.includes('balanced') ? 3 : 1) + 48);
    if (!pool) pool = makePool();
    const cfgVerifySeeds = Math.max(1, cfg.verifySeeds || 20);
    let phase = '';
    const tick = () => {
      const s = (Date.now() - t0) / 1000;
      const pct = Math.min(99, (100 * doneJobs) / estJobs);
      $('cbProg').style.width = pct.toFixed(1) + '%';
      setStatus(`${phase} · 분대 평가 ${Math.floor(doneJobs).toLocaleString()} · ${s.toFixed(0)}초 경과${pct > 3 ? ` · 남은 시간 약 ${Math.max(0, (s * (100 - pct)) / pct / 60).toFixed(1)}분` : ''}`);
    };
    const timer = setInterval(tick, 1000);
    try {
      const res = await C.search(cfg, {
        evalMany: (jobs, onEach) => { if (stopFlag) return Promise.reject(new Error('STOP')); return pool.evalMany(jobs, () => { doneJobs += jobs[0] && jobs[0].raw ? 1 / Math.max(1, cfgVerifySeeds) : 1; onEach && onEach(); }); },
        stopped: () => stopFlag,
        progress: (p) => { phase = p.phase + (p.sub ? ` · ${p.sub}` : ''); tick(); },
        partial: (r) => { lastRes = r; renderResults(r); },
      });
      res.meta = APP.meta ? APP.meta() : null;
      lastRes = res;
      renderResults(res);
      setStatus(`${res.stopped ? '중지됨 (부분 결과)' : '완료'} · 분대 평가 ${res.evals.toLocaleString()} · 전투 ${res.battles.toLocaleString()} · ${(res.elapsedMs / 1000).toFixed(0)}초`);
    } catch (e) {
      if (String(e && e.message) === 'STOP') setStatus('중지됨');
      else { setStatus('오류: ' + (e && e.message)); console.error(e); }
    } finally {
      clearInterval(timer);
      setBusy(false);
    }
  }
  function stop() {
    stopFlag = true;
    if (pool) { pool.terminate(); pool = null; } // in-flight battles are abandoned; a new pool is made next time
    setStatus('중지하는 중…');
  }

  // ------------------------------------------------------------------ results
  let curTab = null;
  const nm = (k) => (lastRes && lastRes.names && lastRes.names[k]) || (APP.pcMap()[k] || {}).name || k;
  // evidence block for an outlier callout: formula, values, per-member table, per-seed values, notes
  function evidenceHtml(e) {
    let h = '<div class="cb-ev">';
    if (e.formula) h += `<p><b>계산</b> ${esc(e.formula)}</p>`;
    if (e.rows && e.rows.length) h += `<table class="cb-evt"><tbody>${e.rows.map(([k, v]) => `<tr><th>${esc(k)}</th><td>${esc(v)}</td></tr>`).join('')}</tbody></table>`;
    if (e.table && e.table.rows && e.table.rows.length) h += `<div class="tablewrap"><table><thead><tr>${e.table.head.map((x) => `<th>${esc(x)}</th>`).join('')}</tr></thead><tbody>${e.table.rows.map((r) => `<tr>${r.map((x) => `<td>${esc(x)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
    if (e.seeds && e.seeds.length) {
      const mx = Math.max(...e.seeds.map((v) => Math.abs(v))) || 1;
      h += `<p class="note">검증 전투별 값 (${e.seeds.length}회)</p><div class="cb-seeds">${e.seeds.map((v) => `<span title="${esc(C.fmt(v))}"><i style="height:${Math.max(2, (Math.abs(v) / mx) * 28)}px"></i></span>`).join('')}</div><p class="note">${esc(e.seeds.map((v) => C.fmt(v)).join(' · '))}</p>`;
    }
    if (e.notes && e.notes.length) h += `<ul class="cb-evn">${e.notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>`;
    return h + '</div>';
  }
  function mini(sq) {
    const at = {}; for (const m of sq) at[m.gridPos] = m.key;
    let h = '<div class="cb-mini" aria-label="배치 (왼쪽 후열, 오른쪽 전열)">';
    for (let i = 0; i < 9; i++) {
      const k = at[i];
      const role = k ? (APP.pcMap()[k] || {}).role : null;
      h += k ? `<span class="on r${role}" title="${esc(nm(k))} · ${i + 1}번 칸 · ${esc(C.ROLE_KO[role] || '')}">${esc(nm(k))}</span>` : '<span>·</span>';
    }
    return h + '</div>';
  }
  function renderResults(res) {
    $('cbResCard').hidden = false;
    $('cbResMeta').textContent = `분대 평가 ${res.evals != null ? res.evals.toLocaleString() : '…'} · 전투 ${res.battles != null ? res.battles.toLocaleString() : '…'}${res.stopped ? ' · 중지됨' : ''}`;
    const objs = Object.keys(res.objectives);
    if (!curTab || !objs.includes(curTab)) curTab = objs[0];
    $('cbTabs').innerHTML = objs.map((o) => `<button role="tab" data-o="${o}" aria-selected="${o === curTab}">${esc(res.objectives[o].label)}</button>`).join('');
    $('cbTabs').querySelectorAll('button').forEach((b) => b.addEventListener('click', () => { curTab = b.dataset.o; renderResults(res); }));
    const o = res.objectives[curTab];
    if (!o) { $('cbPanel').innerHTML = '<p class="note">아직 결과가 없습니다.</p>'; return; }
    let h = '';
    h += `<p class="note">벤치: ${esc(Object.values(res.benches).filter((b) => curTab === 'balanced' || b.id === C.OBJ[curTab].bench).map((b) => b.label).join(' / '))} · 평가 ${o.evals.toLocaleString()}회 · ${(o.ms / 1000).toFixed(0)}초 · 유전 ${o.gens}세대</p>`;
    if (o.callouts.length) h += `<h3 style="margin:4px 0;font-size:13px">밸런스 이상치 후보 <span class="note" style="font-weight:400">· 줄을 누르면 수치의 근거가 펼쳐집니다</span></h3><ul class="cb-call">${o.callouts.map((c) => `<li class="${c.level}">${c.evidence ? `<details><summary>${esc(c.text)}</summary>${evidenceHtml(c.evidence)}</details>` : esc(c.text)}</li>`).join('')}</ul>`;
    h += `<div class="tablewrap"><table><thead><tr><th>#</th><th>배치 (후열 · 중열 · 전열)</th><th class="n">${esc(o.unit)}<br><span class="note">검증 평균 ± 편차</span></th><th>세부 지표</th><th></th></tr></thead><tbody>`;
    o.top.forEach((t, i) => {
      const main = t.aggs[C.OBJ[curTab].bench];
      const sd = main && main.m[C.OBJ[curTab].metric] ? main.m[C.OBJ[curTab].metric].sd : null;
      h += `<tr><td>${i + 1}</td><td>${mini(t.squad)}</td><td class="n"><b>${C.fmt(t.score)}</b>${sd != null ? `<br><span class="note">± ${C.fmt(sd)}</span>` : ''}<br><span class="note">탐색 ${C.fmt(t.search.score)}</span></td>
        <td class="wrap">${esc(C.metricsLine(t, curTab, res))}${detail(t)}</td>
        <td><button data-apply="${i}">분대에 적용</button><br><button data-live="${i}" style="margin-top:4px">라이브로 보기</button></td></tr>`;
    });
    h += '</tbody></table></div>';
    for (const [p, sc] of Object.entries(o.screening || {})) {
      h += `<details class="cb-help"><summary>1차 선별 결과 (${esc(C.OBJ[p].label)}) — 기준 분대: ${esc(sc.ref4.map(nm).join(', '))}</summary><div class="tablewrap"><table><thead><tr><th>#</th><th>단독 상위</th><th class="n">점수</th><th>기준 분대 +1 증가량 상위</th><th class="n">증가량</th></tr></thead><tbody>` +
        sc.soloTop.map((x, i) => `<tr><td>${i + 1}</td><td>${esc(nm(x.key))}</td><td class="n">${C.fmt(x.v)}</td><td>${esc(nm(sc.ctxTop[i].key))}</td><td class="n">${C.fmt(sc.ctxTop[i].delta)}</td></tr>`).join('') +
        `</tbody></table></div><p class="note">단독 중앙값 ${C.fmt(sc.soloMedian)} · 증가량 중앙값 ${C.fmt(sc.ctxMedian)}</p></details>`;
    }
    if (res.engineFlags && res.engineFlags.length) h += `<details class="cb-help"><summary>엔진 경고 ${res.engineFlags.length}건 (오류·진행불가로 끝난 전투)</summary><div>${res.engineFlags.map((f) => `<p>[${esc(f.bench)}] ${esc(f.squad)}: ${esc(f.msg)}</p>`).join('')}</div></details>`;
    $('cbPanel').innerHTML = h;
    $('cbPanel').querySelectorAll('[data-apply]').forEach((b) => b.addEventListener('click', () => apply(o.top[+b.dataset.apply], false)));
    $('cbPanel').querySelectorAll('[data-live]').forEach((b) => b.addEventListener('click', () => apply(o.top[+b.dataset.live], true)));
  }
  function detail(t) {
    if (!t.loo) {
      const a = Object.values(t.aggs)[0];
      return a && a.members ? `<div class="cb-det"><span class="note">${a.members.map((m) => `${esc(nm(m.key))} 피해 ${C.fmt(m.dmg)}${m.deathRate ? ` · 사망률 ${C.fmt(100 * m.deathRate, 0)}%` : ''}`).join(' / ')}</span></div>` : '';
    }
    const mx = Math.max(1e-9, ...t.loo.map((l) => Math.abs(l.pct)));
    let h = '<div class="cb-det"><span class="note">빼면 떨어지는 점수 (기여도)</span>';
    for (const l of t.loo.slice().sort((a, b) => b.delta - a.delta)) {
      h += `<div><span class="cb-bar ${l.delta < 0 ? 'neg' : ''}" style="width:${Math.round((60 * Math.abs(l.pct)) / mx)}px"></span>${esc(nm(l.key))} <span class="cb-role">${l.gridPos + 1}번 칸</span> ${C.fmt(l.pct, 0)}%</div>`;
    }
    if (t.pairs && t.pairs.length) h += `<span class="note">짝 상호작용 (양수 = 함께일 때 더 강함)</span>` + t.pairs.slice(0, 3).map((p) => `<div>${esc(nm(p.a))} + ${esc(nm(p.b))}: ${p.inter >= 0 ? '+' : ''}${C.fmt(p.pct, 0)}%</div>`).join('');
    if (t.synergyX) h += `<div>구성원 단독 점수 합 대비 <b>${C.fmt(t.synergyX, 2)}배</b></div>`;
    return h + '</div>';
  }
  function apply(t, live) {
    const assume = (lastRes && lastRes.config.assume) || C.DEFAULTS.assume;
    APP.setSquad(t.squad.map((m) => Object.assign(C.makeSpec(m.key, m.gridPos, assume), { gridPos: m.gridPos })));
    if (live) { const b = document.getElementById('vLive'); if (b) b.click(); }
    else $('cbExpMsg').textContent = '분대 편성에 적용했습니다 (설정·통계 / 라이브 플레이 화면의 분대 편성)';
  }

  // ------------------------------------------------------------------ export
  const stem = () => 'combo-' + (lastRes ? Object.keys(lastRes.objectives).join('_') : 'x') + '-' + new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  async function saveFile(name, text, type, label) {
    const dl = window.claude && window.claude.use ? await window.claude.use('downloads').catch(() => null) : null;
    if (dl) {
      try { await dl.save({ filename: name, data: new Blob([text], { type }) }); $('cbExpMsg').textContent = `${label} 저장 요청: ${name}`; }
      catch (e) { $('cbExpMsg').textContent = `${label} 저장이 취소되었거나 실패했습니다: ${e.code || e.message || e}`; }
      return;
    }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type }));
    a.download = name; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    $('cbExpMsg').textContent = `${label} 저장: ${name} · 브라우저의 다운로드 폴더를 확인하세요`;
  }
  const meta = () => (lastRes && lastRes.meta) || (APP.meta && APP.meta()) || null;
  async function copyMd() {
    if (!lastRes) return;
    const md = C.reportMarkdown(lastRes, { meta: meta() });
    try { await navigator.clipboard.writeText(md); $('cbExpMsg').textContent = `리포트(Markdown)를 복사했습니다 (${Math.round(md.length / 1024)} KB)`; }
    catch (e) { $('cbExpMsg').textContent = '클립보드 복사가 막혀 있습니다. 파일 저장을 사용하세요.'; }
  }
  async function claude() {
    const sample = APP.sample && APP.sample();
    if (!sample || !lastRes) { $('cbExpMsg').textContent = 'Claude는 claude.ai에 게시된 페이지에서만 쓸 수 있습니다'; return; }
    let md = C.reportMarkdown(lastRes, { meta: meta() });
    if (md.length > 150000) md = md.slice(0, 150000) + '\n(이하 생략)';
    const out = $('cbClaudeOut'); out.hidden = false; out.textContent = 'Claude가 분석하는 중…';
    $('cbClaude').disabled = true;
    const prompt = `너는 모바일 게임 "라스트오리진"의 밸런스 QA 리드다. 아래는 전투 시뮬레이터로 수천 번 전투를 돌려 찾은 조합 분석 결과다.
한국어로 다음을 써라. 수치는 리포트에 있는 것만 쓰고, 추측은 추측이라고 표시한다.
1. 한 줄 결론 (가장 위험한 밸런스 이상치)
2. 이상치 후보 목록: 조합/캐릭터, 근거 수치, 왜 그런지(기여도·짝 시너지·버프 중첩 근거), 실제 게임 버그일 가능성 vs 시뮬레이터 근사일 가능성
3. 실제 클라이언트에서 재현할 순서 (편성, 스테이지, 확인할 수치)
4. 추가로 돌려 볼 분석 제안

${md}`;
    try {
      const { text } = await sample(prompt, { onText: ({ text: t }) => { out.textContent = t; } });
      out.textContent = text;
    } catch (e) { out.textContent = 'Claude 분석 실패: ' + (e.code || e.message || e); }
    finally { $('cbClaude').disabled = false; }
  }

  // ------------------------------------------------------------------ mount
  function init() {
    C = window.LOSim.combo;
    root.innerHTML = html();
    $('cbLayout').innerHTML = Object.entries(C.LAYOUTS).map(([k, v]) => `<option value="${k}">${esc(v.label)}</option>`).join('');
    $('cbLayout').value = 'f3m2';
    $('cbChap').innerHTML = APP.chapters('stage').map((c) => `<option value="${esc(c.key)}">${esc(c.name)}</option>`).join('');
    const def = APP.findStage(C.DEFAULTS.endurance.stageKey) || APP.stages('stage')[0];
    if (def) { $('cbChap').value = def.chapter; renderStages(def.key); }
    $('cbPcList').innerHTML = APP.pcs().map((p) => `<option value="${esc(p.name)}">${esc(p.key)}</option>`).join('');
    restore();
    $('cbChap').addEventListener('change', () => { renderStages(); save(); });
    $('cbStage').addEventListener('change', () => { renderWaves(); save(); });
    root.addEventListener('change', () => { save(); poolInfo(); });
    root.addEventListener('input', (e) => { if (e.target && (e.target.id === 'cbSearch' || e.target.id === 'cbExclude' || e.target.id === 'cbBudget')) poolInfo(); });
    $('cbLockAdd').addEventListener('click', () => {
      const r = resolveKeys($('cbLockIn').value);
      for (const k of r.keys) if (!locked.includes(k) && locked.length < 5) locked.push(k);
      $('cbLockIn').value = ''; poolInfo(); save();
    });
    $('cbP1').addEventListener('click', () => { $('cbBudget').value = 150; $('cbSeeds').value = 2; $('cbVSeeds').value = 10; $('cbShort').value = 20; poolInfo(); save(); });
    $('cbP2').addEventListener('click', () => { $('cbBudget').value = 600; $('cbSeeds').value = 3; $('cbVSeeds').value = 20; $('cbShort').value = 28; poolInfo(); save(); });
    $('cbP3').addEventListener('click', () => { $('cbBudget').value = 2000; $('cbSeeds').value = 4; $('cbVSeeds').value = 50; $('cbShort').value = 36; poolInfo(); save(); });
    root.querySelector('details.cb-help').addEventListener('toggle', (e) => { if (e.target.open) $('cbHelp').innerHTML = helpText(); });
    $('cbStart').addEventListener('click', start);
    $('cbStop').addEventListener('click', stop);
    $('cbSaveHtml').addEventListener('click', () => lastRes && saveFile(stem() + '.html', C.reportHtml(lastRes, { meta: meta() }), 'text/html', '리포트(HTML)'));
    $('cbCopyMd').addEventListener('click', copyMd);
    $('cbSaveJson').addEventListener('click', () => lastRes && saveFile(stem() + '.json', JSON.stringify(lastRes, null, 1), 'application/json', '원본 JSON'));
    $('cbClaude').addEventListener('click', claude);
    poolInfo();
  }

  async function evaluateSquadTool(i) {
    if (!C || !lastRes) throw new Error('먼저 조합 분석을 실행해야 합니다');
    const obj = String(i.objective || Object.keys(lastRes.objectives)[0] || 'dps');
    if (!C.OBJ[obj]) throw new Error('objective must be one of ' + Object.keys(C.OBJ).join(','));
    const benchId = C.OBJ[obj].bench === undefined ? 'dummy' : C.OBJ[obj].bench;
    if (obj === 'balanced') throw new Error('balanced is a mix; evaluate dps / burst / survival / clear separately');
    const pcs = APP.pcMap();
    const squad = (Array.isArray(i.squad) ? i.squad : []).slice(0, 5).map((m) => { const k = String(m.key); if (!pcs[k]) throw new Error('unknown character ' + k); return { key: k, gridPos: Math.max(0, Math.min(8, +m.gridPos || 0)) }; });
    if (!squad.length) throw new Error('squad is empty');
    const cfg = lastRes.config;
    const bench = C.makeBench(benchId, cfg);
    const n = Math.max(1, Math.min(30, +i.seeds || 8));
    const seeds = Array.from({ length: n }, (_, k) => (cfg.baseSeed || 1000) + 20000 + k);
    if (!pool) pool = makePool();
    const ov = Array.isArray(i.overrides) ? i.overrides : i.overrides ? [i.overrides] : [];
    const changes = APP.checkOverrides ? APP.checkOverrides(ov) : null;
    const st = (s) => (s && s.mean != null ? { mean: Math.round(s.mean * 100) / 100, sd: Math.round(s.sd * 100) / 100, min: s.min, max: s.max } : null);
    const one = async (rules) => {
      const subs = seeds.map((sd) => Object.assign({ squad, bench, seeds: [sd], assume: cfg.assume, raw: true }, rules.length ? { overrides: rules } : {}));
      const rr = await pool.evalMany(subs);
      const agg = C.aggregate({ squad, bench, seeds, assume: cfg.assume }, rr.flatMap((x) => (x && x.runs) || []));
      return { metrics: Object.fromEntries(Object.entries(agg.m).map(([k, v]) => [k, st(v)])),
        members: agg.members.map((m) => ({ key: m.key, name: (pcs[m.key] || {}).name, dmg: Math.round(m.dmg), taken: Math.round(m.taken), heal: Math.round(m.heal), actions: Math.round(m.actions * 10) / 10, deathRate: Math.round(m.deathRate * 100) / 100 })),
        maxStack: agg.maxStack, maxStackKey: agg.maxStackKey, maxHitBy: agg.maxHitBy, outcomes: agg.outcomes, errors: agg.errors };
    };
    const out = Object.assign({ objective: obj, bench: bench.label, seeds: n }, changes ? { overridesApplied: changes } : {}, await one(ov));
    if (changes && i.compareBaseline) out.baseline = await one([]);
    return out;
  }
  window.LOCombo = {
    reportMarkdown: () => (lastRes && C ? C.reportMarkdown(lastRes, { meta: meta() }) : ''),
    reportTools: () => [{
      name: 'evaluate_squad',
      description: 'Evaluate any 5-member squad (with 3x3 positions) on the SAME benchmark settings as the last combo analysis. objective: dps | burst | survival | clear. seeds default 8 (max 30). Returns metric mean/sd/min/max, per-member damage/taken/heal/actions/deathRate, max same-buff stack and which buff. Use it to test hypotheses (remove a member, swap positions, replace a character, or force data/rule changes). ' + (APP.OV_HINT || ''),
      inputSchema: { type: 'object', properties: { squad: { type: 'array', items: { type: 'object', properties: { key: { type: 'string' }, gridPos: { type: 'number' } } } }, objective: { type: 'string' }, seeds: { type: 'number' }, overrides: APP.ovSchema ? APP.ovSchema() : { type: 'array', items: { type: 'object' } }, compareBaseline: { type: 'boolean' } }, required: ['squad'] },
      execute: (i) => evaluateSquadTool(i),
    }],
    mount(container, app) {
      root = container; APP = app;
      root.innerHTML = '<section class="card"><p class="note">조합 분석 모듈을 불러오는 중…</p></section>';
      loadCore().then(init).catch((e) => { root.innerHTML = `<section class="card"><p class="o-error">${esc(e.message)}</p></section>`; });
    },
  };
})();
