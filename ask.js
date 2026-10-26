// "결과에 대해 Claude에게 질문" -- a follow-up chat attached to a tab's results.
// LOAsk.mount(container, { id, title, getContext: () => markdown|'' , suggestions: [..], intro })
// The current results (Markdown) are the first turn of the conversation; follow-up questions keep the history.
// On claude.ai it calls Claude through the page's `sample` capability; elsewhere it offers "질문+결과 복사".
(function () {
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const MAX_CTX = 180000;
  const RULES = `너는 모바일 게임 "라스트오리진"의 QA·밸런스 담당을 돕는 분석가다. 아래 "현재 결과"는 Unity 클라이언트의 전투 로직(전투 리뉴얼, AP 게이지)을 포팅한 시뮬레이터가 만든 결과다.
규칙:
- 한국어로 답한다. 결론을 먼저, 근거 수치를 그다음에 쓴다.
- 수치·이름은 "현재 결과"에 있는 것만 쓴다. 결과에 없는 내용은 없다고 말하고, 추측은 추측이라고 표시한다.
- 실제 게임 버그일 가능성과 시뮬레이터 근사(장비·코어링크 미반영, 허수아비 벤치 등) 때문일 가능성을 구분한다.
- 필요하면 다음에 시뮬레이터로 돌려볼 실험을 1~2개 제안한다.`;

  function css() {
    if (document.getElementById('askCss')) return;
    const st = document.createElement('style');
    st.id = 'askCss';
    st.textContent = `.ask-msgs{max-height:460px;overflow:auto;display:grid;gap:8px;align-content:start}
.ask-msg{padding:8px 10px;border-radius:6px;white-space:pre-wrap;word-break:break-word;font-size:13px;line-height:1.6}
.ask-u{background:var(--accent-soft);justify-self:end;max-width:90%}.ask-a{background:var(--panel-2)}.ask-n{font-size:12px;color:var(--ink-3);padding:2px 4px}
.ask-chips{display:flex;flex-wrap:wrap;gap:6px}.ask-chips button{font-size:12px;padding:3px 10px;border-radius:999px}
.ask-modes{display:flex;gap:4px;border-bottom:1px solid var(--rule)}.ask-modes button{border:none;border-bottom:2px solid transparent;border-radius:0;background:none;padding:6px 10px;color:var(--ink-2)}
.ask-modes button[aria-selected=true]{border-bottom-color:var(--accent);color:var(--ink);font-weight:600}
.ask-rep{border:1px solid var(--rule);border-radius:6px;padding:12px 16px;max-height:640px;overflow:auto;font-size:13.5px;line-height:1.7;background:var(--panel)}
.ask-rep h1{font-size:19px;margin:6px 0}.ask-rep h2{font-size:16px;margin:14px 0 6px;color:var(--ink);text-transform:none;letter-spacing:0}.ask-rep h3{font-size:14px;margin:10px 0 4px}
.ask-rep table{margin:6px 0}.ask-rep td,.ask-rep th{white-space:normal}.ask-rep code{font-family:var(--f-mono);font-size:12px;background:var(--panel-2);padding:0 3px;border-radius:3px}
.ask-rep pre{background:var(--panel-2);padding:8px;border-radius:6px;white-space:pre-wrap}.ask-rep ul,.ask-rep ol{padding-left:20px;margin:4px 0}
.ask-off{display:flex;flex-wrap:wrap;align-items:center;gap:10px;border:2px solid var(--accent);background:var(--accent-soft);border-radius:8px;padding:12px 14px;font-size:13.5px;line-height:1.6}
.ask-off strong{display:block;font-size:14.5px}.ask-off .grow{flex:1 1 260px}
.ask-off button.go{background:var(--accent);color:var(--accent-ink);border:none;font-weight:600;padding:8px 14px;border-radius:6px;white-space:nowrap}
.ask-off a.go{display:inline-block;background:var(--accent);color:var(--accent-ink);text-decoration:none;font-weight:600;padding:8px 14px;border-radius:6px;white-space:nowrap}
.ask-log{font-family:var(--f-mono);font-size:11.5px;color:var(--ink-3);display:grid;gap:2px;max-height:140px;overflow:auto}`;
    document.head.appendChild(st);
  }

  // small Markdown -> HTML (headings, lists, tables, code, bold/italic/inline code)
  function md2html(md) {
    const inline = (t) => esc(t).replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>').replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<i>$2</i>');
    const lines = String(md || '').replace(/\r/g, '').split('\n');
    const out = [];
    let i = 0;
    while (i < lines.length) {
      const l = lines[i];
      if (/^```/.test(l)) { const buf = []; i++; while (i < lines.length && !/^```/.test(lines[i])) buf.push(lines[i++]); i++; out.push('<pre>' + esc(buf.join('\n')) + '</pre>'); continue; }
      const h = l.match(/^(#{1,4})\s+(.*)$/);
      if (h) { const n = Math.min(3, h[1].length); out.push(`<h${n}>${inline(h[2])}</h${n}>`); i++; continue; }
      if (/^\s*\|.*\|\s*$/.test(l) && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1])) {
        const cells = (x) => x.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
        const head = cells(l); i += 2; const rows = [];
        while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) rows.push(cells(lines[i++]));
        out.push(`<div class="tablewrap"><table><thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`);
        continue;
      }
      if (/^\s*([-*]|\d+\.)\s+/.test(l)) {
        const ordered = /^\s*\d+\./.test(l); const items = [];
        while (i < lines.length && /^\s*([-*]|\d+\.)\s+/.test(lines[i])) items.push(lines[i++].replace(/^\s*([-*]|\d+\.)\s+/, ''));
        out.push(`<${ordered ? 'ol' : 'ul'}>${items.map((x) => `<li>${inline(x)}</li>`).join('')}</${ordered ? 'ol' : 'ul'}>`);
        continue;
      }
      if (!l.trim()) { i++; continue; }
      const para = [];
      while (i < lines.length && lines[i].trim() && !/^(#{1,4}\s|```|\s*([-*]|\d+\.)\s|\s*\|)/.test(lines[i])) para.push(lines[i++]);
      if (!para.length) para.push(lines[i++]);
      out.push('<p>' + inline(para.join(' ')) + '</p>');
    }
    return out.join('\n');
  }
  const MARK = '=== 리포트 ===';
  const PUBLISHED_URL = 'https://claude.ai/artifact/J4Df7d2tgAPfNT1qgAStA5';
  const REPORT_RULES = `너는 모바일 게임 "라스트오리진"의 QA 리드다. 아래 "현재 결과"(전투 시뮬레이터 리포트)를 바탕으로, "요청"에 맞춘 추가 분석 리포트를 한국어 Markdown으로 쓴다.
- 도구가 주어졌다면 가설을 확인하는 데 필요한 만큼만 추가 시뮬레이션을 돌린다 (조건을 바꿔 비교: 멤버 제외, 위치 변경, 레벨 변경 등). 도구 결과의 수치는 그대로 인용한다.
- 데이터·규칙을 바꿔 보는 가정 실험(예: 버프 OverlapMax=1 강제, 스킬·버프 수치 배율 변경, AP 기준값 변경)은 도구의 overrides 인자로 직접 강제한다. 다른 방법(멤버 제외 등)으로 대체하지 말고, 먼저 query_table/preview_overrides로 대상 행이 맞게 바뀌는지 확인한 뒤 compareBaseline:true로 원본과 같은 시드로 비교한다. 강제가 정말 불가능할 때만 그렇다고 밝히고 이유를 쓴다.
- 수치마다 출처를 밝힌다: (원래 결과) 또는 (추가 실행: 조건 요약, 오버라이드가 있으면 그 내용과 바뀐 행 수). 결과에 없는 수치를 만들지 않는다. 추측은 추측이라고 쓴다.
- 실제 게임 버그 가능성과 시뮬레이터 근사(장비·코어링크 미반영, 허수아비 벤치 등) 가능성을 구분한다.
- 구성: # 제목 / ## 요약 (3줄 이내) / ## 분석 (소제목·표 활용) / ## 근거 데이터 / ## 결론과 권고 / ## 한계와 다음 실험
- 도구를 다 쓴 뒤 마지막 메시지에 "${MARK}" 한 줄을 쓰고, 그 아래에 완성된 리포트 전체만 쓴다.`;

  function mount(container, o) {
    css();
    const id = o.id;
    const card = document.createElement('section');
    card.className = 'card';
    card.innerHTML = `<h2>${esc(o.title || '결과에 대해 Claude에게 질문')} <span class="sp" id="${id}State">연결 확인 중…</span></h2>
<div class="ask-off" id="${id}Off" hidden></div>
<div class="ask-modes" role="tablist"><button type="button" role="tab" aria-selected="true" data-m="qa">질문하기</button><button type="button" role="tab" aria-selected="false" data-m="rep">추가 분석 리포트</button></div>
<div id="${id}Rep" hidden style="display:grid;gap:8px">
<p class="note">현재 결과를 바탕으로 원하는 분석을 지시하면 Claude가 새 리포트를 씁니다. 필요하면 시뮬레이션을 직접 더 돌려 가설을 확인합니다. 완성된 리포트는 저장하거나, 고칠 점을 말해 다시 쓰게 할 수 있습니다.</p>
<textarea id="${id}RepReq" rows="3" placeholder="예: 1위 조합에서 히루메를 빼고 다른 서포터로 바꿨을 때 DPS가 얼마나 떨어지는지 비교하고, 버프 중첩 없이도 강한 조합이 있는지 정리해줘"></textarea>
<div class="row"><label><span>필요하면 시뮬레이션 추가 실행</span><input type="checkbox" id="${id}RepSim" checked></label>
<button class="primary" id="${id}RepGo">리포트 작성</button><button id="${id}RepStop" disabled>중지</button><button id="${id}RepCopyReq" title="claude.ai 밖(Claude Code·Codex)에서 쓰도록 요청과 결과를 함께 복사">요청+결과 복사</button><span class="note" id="${id}RepMsg"></span></div>
<div class="ask-log" id="${id}RepLog" hidden></div>
<div class="ask-rep" id="${id}RepOut" hidden></div>
<div class="row" id="${id}RepActs" hidden><button id="${id}RepHtml">리포트 저장 (HTML)</button><button id="${id}RepMdSave">Markdown 저장</button><button id="${id}RepMdCopy">Markdown 복사</button></div>
<div class="row" id="${id}RepRev" hidden><label class="grow">고칠 점·추가 요청<input id="${id}RepRevIn" placeholder="예: 3번 항목을 생존 벤치로도 확인해서 표로 추가해줘"></label><button id="${id}RepRevGo">다시 쓰기</button></div>
</div>
<div id="${id}Qa" style="display:grid;gap:8px">
<p class="note">${esc(o.intro || '이 탭의 현재 결과를 Claude가 읽고 답합니다. 이어서 질문하면 앞 대화를 기억합니다. 결과를 새로 만들면 새 대화로 시작합니다.')}</p>
<div class="ask-chips" id="${id}Chips">${(o.suggestions || []).map((q) => `<button type="button">${esc(q)}</button>`).join('')}</div>
<div class="ask-msgs" id="${id}Msgs"></div>
<textarea id="${id}Input" rows="3" placeholder="예: ${esc((o.suggestions || [''])[0])}"></textarea>
<div class="row"><button class="primary" id="${id}Send">질문하기</button><button id="${id}Stop" disabled>중지</button><button id="${id}Clear">대화 지우기</button>
<button id="${id}Copy" title="Claude Code·Codex·다른 대화창에 붙여넣을 수 있게 결과와 질문을 함께 복사합니다">질문+결과 복사</button><span class="note" id="${id}Msg"></span></div>
</div>`;
    container.appendChild(card);
    const $ = (s) => document.getElementById(id + s);
    let turns = [], ctxSig = '', ctl = null, busy = false;

    const sample = () => (window.LOApp && window.LOApp.sample && window.LOApp.sample()) || null;
    let offShown = '';
    const status = () => (window.LOApp && window.LOApp.claudeStatus ? window.LOApp.claudeStatus() : (sample() ? 'ok' : 'local'));
    const perm = () => (window.LOApp && window.LOApp.claudePerm ? window.LOApp.claudePerm() : '');
    const hasTools = () => !(window.LOApp && window.LOApp.claudeTools) || window.LOApp.claudeTools();
    const OFF = {
      local: () => `<div class="grow"><strong>이 화면(로컬 실행)에서는 Claude가 답하거나 리포트를 쓸 수 없습니다</strong>질문하기와 추가 분석 리포트는 claude.ai에 로그인한 웹 브라우저(크롬 등)에서 게시 링크로 열어야 동작합니다. 같은 결과를 그쪽에서 다시 만든 뒤 사용하세요.</div><a class="go" href="${PUBLISHED_URL}" target="_blank" rel="noopener">게시 링크로 열기 ↗</a>`,
      denied: () => {
        const p = perm();
        const w = (window.LOApp && window.LOApp.claudeWhere && window.LOApp.claudeWhere()) || { framed: true, host: '', waitMs: 0 };
        const whereTxt = (w.framed ? 'claude.ai 화면 안' : '단독 페이지') + ' · 주소 ' + w.host + ' · 응답 ' + (w.waitMs / 1000).toFixed(1) + '초';
        if (!w.framed) {
          return `<div class="grow"><strong>페이지가 claude.ai 화면 밖에서 따로 열려 있습니다</strong>지금 주소(${esc(w.host)})는 페이지 내용만 단독으로 보여 주는 주소라 Claude 기능이 동작하지 않습니다. 오른쪽 버튼으로 claude.ai 화면에서 다시 여세요. 앞으로는 주소창에 claude.ai/artifact/… 주소로 여시면 됩니다.<span class="note" style="display:block;font-family:var(--f-mono);font-size:11px">진단: ${esc(whereTxt)}</span></div><a class="go" href="${PUBLISHED_URL}" target="_top" rel="noopener">claude.ai에서 열기</a>`;
        }
        const head = {
          denied: ['이 페이지의 Claude 사용 권한이 꺼져 있습니다', '예전에 허용 창에서 거부했거나 권한을 꺼 둔 상태라 허용 창이 다시 뜨지 않습니다. "권한 설정 열기"로 패널을 열어 Claude 사용(sample)을 켠 뒤 "새로 고침"을 누르세요.'],
          prompt: ['Claude 사용을 아직 허용하지 않았습니다', '"Claude 사용 허용"을 누르면 허용 창이 뜹니다. 허용한 뒤 "새로 고침"을 누르세요.'],
          granted: ['권한은 켜져 있지만 이 페이지가 연결을 받지 못했습니다', '페이지가 권한이 켜지기 전에 열렸거나 연결 확인이 늦어진 경우입니다. "새로 고침"을 누르세요.'],
        }[p] || ((((window.LOApp && window.LOApp.claudePermAll && window.LOApp.claudePermAll()) || '') === '권한 기능 없음' && w.waitMs < 9000) ? ['claude.ai가 이 페이지에 Claude 기능을 주지 않았습니다', '페이지는 claude.ai 화면 안에서 제대로 열렸지만, claude.ai가 Claude 사용·권한·저장 기능을 하나도 주지 않았습니다. 페이지 쪽에서 켤 수 있는 설정은 없습니다. 회사(조직) 관리자 설정에서 아티팩트 기능이 꺼져 있을 수 있으니, 관리자에게 아티팩트의 Claude 사용(sample) 허용 여부를 확인해 보세요.'] : null) || (!p && w.waitMs >= 9000 ? ['claude.ai 화면 안이지만 10초 동안 응답이 없었습니다', '브라우저 확장 프로그램(광고 차단, 보안 도구 등)이 claude.ai와 페이지 사이의 통신을 막고 있을 수 있습니다. 크롬 시크릿 창(확장 프로그램 꺼짐)에서 로그인해 같은 주소로 열어 보세요. 그래도 같으면 회사(조직) 설정에서 막혀 있을 수 있습니다.'] : null) || ['이 화면에서는 Claude를 쓸 수 없습니다', 'claude.ai에 로그인한 웹 브라우저에서 열었는지 확인하세요. 로그인돼 있는데도 이렇게 나오면 회사(조직) 설정에서 아티팩트의 Claude 사용이 막혀 있거나 이 계정에서 Claude를 쓸 수 없는 상태일 수 있습니다. "권한 설정 열기"로 Claude 사용 항목이 있는지 확인해 보세요.'];
        const noPerm = ((window.LOApp && window.LOApp.claudePermAll && window.LOApp.claudePermAll()) || '') === '권한 기능 없음';
        const btns = (p === 'prompt' ? '<button type="button" class="go" data-req="1">Claude 사용 허용</button>' : '')
          + (p !== 'granted' && !noPerm ? '<button type="button" class="go" data-perm="1">권한 설정 열기</button>' : '')
          + '<button type="button" class="go" data-reload="1">새로 고침</button>';
        return `<div class="grow"><strong>${head[0]}</strong>${head[1]}<span class="note" data-pm style="display:block"></span><span class="note" style="display:block;font-family:var(--f-mono);font-size:11px">진단: Claude 사용 권한=${esc(p || '알 수 없음')} · 전체 권한: ${esc((window.LOApp && window.LOApp.claudePermAll && window.LOApp.claudePermAll()) || '-')} · ${esc(whereTxt)}</span></div><div class="row" style="gap:6px">${btns}</div>`;
      },
      error: () => `<div class="grow"><strong>게시 페이지이지만 Claude 연결에 실패했습니다</strong>오류: ${esc((window.LOApp && window.LOApp.claudeErr && window.LOApp.claudeErr()) || '알 수 없음')}. "새로 고침"을 누르세요.<span class="note" data-pm style="display:block"></span></div><button type="button" class="go" data-reload="1">새로 고침</button>`,
    };
    const setState = () => {
      const st = status();
      const on = st === 'ok' && !!sample();
      $('State').textContent = on ? (hasTools() ? '연결됨 · 사용량은 보는 사람 계정에서 차감' : '연결됨 · 추가 시뮬레이션(도구) 미지원')
        : st === 'pending' ? '연결 확인 중…' : st === 'local' ? '연결 안 됨 · 게시 링크에서만 동작' : '연결 안 됨';
      const key = on || st === 'pending' ? '' : st + ':' + perm() + ':' + (st === 'error' && window.LOApp && window.LOApp.claudeErr ? window.LOApp.claudeErr() : '');
      if (key !== offShown) {
        offShown = key;
        $('Off').hidden = !key;
        if (key) {
          $('Off').innerHTML = (OFF[st] || OFF.error)();
          const note = (t) => { const n = $('Off').querySelector('[data-pm]'); if (n) n.textContent = t; };
          const rl = $('Off').querySelector('[data-reload]');
          if (rl) rl.addEventListener('click', () => { note('새로 고치는 중…'); location.reload(); });
          const rq = $('Off').querySelector('[data-req]');
          if (rq) rq.addEventListener('click', async () => {
            note('허용 창을 여는 중…');
            try { const r = await window.LOApp.requestClaude(); note(r === 'granted' ? '허용됐습니다. "새로 고침"을 누르세요.' : '허용되지 않았습니다 (상태: ' + r + '). "권한 설정 열기"로 켜 주세요.'); }
            catch (e) { note('허용 창을 열지 못했습니다. "권한 설정 열기"를 써 주세요.'); }
          });
          const pb = $('Off').querySelector('[data-perm]');
          if (pb) pb.addEventListener('click', async () => {
            note('권한 패널을 여는 중…');
            try { await window.LOApp.openClaudePermissions(); note('패널을 닫았습니다. Claude 사용을 켰다면 "새로 고침"을 누르세요.'); setTimeout(setState, 1500); }
            catch (e) { note('권한 패널을 열지 못했습니다. 페이지 위쪽 아티팩트 메뉴의 "권한(Permissions)"에서 Claude 사용을 켠 뒤 새로 고쳐 주세요.'); }
          });
        }
      }
      // only a connected view that reports no tool support locks the checkbox; before connecting it stays as the viewer left it
      if (on && !hasTools()) { if (!$('RepSim').disabled) { $('RepSim').checked = false; $('RepSim').disabled = true; $('RepSim').title = '이 화면은 도구 호출을 지원하지 않습니다'; } }
      else if ($('RepSim').disabled) { $('RepSim').disabled = false; $('RepSim').checked = true; $('RepSim').title = ''; }
      for (const b of ['Send', 'RepGo', 'RepRevGo']) { const el = $(b); if (el && !busy && !repBusy) { el.disabled = !on; el.title = on ? '' : 'claude.ai에 게시된 링크에서만 동작합니다'; } }
    };

    const add = (cls, text) => { const d = document.createElement('div'); d.className = 'ask-msg ' + cls; d.textContent = text; $('Msgs').appendChild(d); $('Msgs').scrollTop = $('Msgs').scrollHeight; return d; };
    const context = () => {
      let c = '';
      try { c = o.getContext() || ''; } catch (e) { c = ''; }
      if (c.length > MAX_CTX) c = c.slice(0, MAX_CTX) + '\n\n(결과가 길어 이하 생략)';
      return c;
    };
    const firstTurn = (ctx, q) => `${RULES}\n\n# 현재 결과\n${ctx}\n\n# 질문\n${q}`;

    async function ask(q) {
      q = String(q || '').trim();
      if (!q || busy) return;
      const ctx = context();
      if (!ctx) { $('Msg').textContent = '먼저 이 탭에서 결과를 만들어 주세요.'; return; }
      const s = sample();
      if (!s) { $('Msg').textContent = '이 화면에서는 Claude가 답할 수 없습니다. "질문+결과 복사"로 다른 곳에 붙여넣어 물어보세요.'; return; }
      const sig = ctx.length + ':' + ctx.slice(0, 200) + ctx.slice(-200);
      if (sig !== ctxSig) {
        if (turns.length) add('ask-n', '결과가 바뀌어 새 대화로 시작합니다.');
        turns = []; ctxSig = sig;
      }
      $('Input').value = '';
      $('Msg').textContent = '';
      add('ask-u', q);
      turns.push({ role: 'user', content: turns.length ? q : firstTurn(ctx, q) });
      const out = add('ask-a', '생각 중…');
      busy = true; $('Send').disabled = true; $('Stop').disabled = false;
      ctl = new AbortController();
      try {
        // keep the first turn (it carries the results) and the latest exchanges
        const send = turns.length > 13 ? [turns[0], ...turns.slice(-12)] : turns;
        const { text, truncated } = await s(send, { cache: false, signal: ctl.signal, onText: ({ text: t }) => { out.textContent = t; } });
        out.textContent = text;
        turns.push({ role: 'assistant', content: text });
        if (truncated) add('ask-n', '답변이 길어 중간에 끊겼습니다. 범위를 좁혀 다시 물어보세요.');
      } catch (e) {
        out.textContent = e.text || '';
        if (e.code === 'not_granted' && window.LOApp && window.LOApp.claudeDenied) { window.LOApp.claudeDenied(); setState(); }
        const msg = { not_granted: 'Claude 사용이 허용되지 않았습니다.', sampling_disabled: '이 계정에서는 Claude를 쓸 수 없습니다.', rate_limited: '요청이 많습니다. 잠시 후 다시 질문해 주세요.', prompt_too_large: '결과가 너무 깁니다. 범위를 줄인 결과로 다시 시도해 주세요.', cancelled: '' }[e.code];
        if (msg !== '') add('ask-n', msg || '답변을 받지 못했습니다: ' + (e.code || e.message || e));
        turns.pop();
        if (!out.textContent) out.remove();
      } finally { busy = false; $('Send').disabled = false; $('Stop').disabled = true; }
    }

    // ---------------- mode switch
    card.querySelectorAll('.ask-modes button').forEach((b) => b.addEventListener('click', () => {
      card.querySelectorAll('.ask-modes button').forEach((x) => x.setAttribute('aria-selected', String(x === b)));
      $('Qa').hidden = b.dataset.m !== 'qa'; $('Rep').hidden = b.dataset.m !== 'rep';
      $('Qa').style.display = b.dataset.m === 'qa' ? 'grid' : 'none'; $('Rep').style.display = b.dataset.m === 'rep' ? 'grid' : 'none';
    }));
    $('Rep').style.display = 'none';

    // ---------------- report mode
    let repTurns = [], repText = '', repCtl = null, repBusy = false;
    const repLog = (t) => { const el = $('RepLog'); el.hidden = false; const d = document.createElement('div'); d.textContent = t; el.appendChild(d); el.scrollTop = el.scrollHeight; };
    const extract = (t) => { const k = t.lastIndexOf(MARK); return (k >= 0 ? t.slice(k + MARK.length) : t).trim(); };
    const showRep = (t) => { $('RepOut').hidden = false; $('RepOut').innerHTML = md2html(t); };
    async function writeReport(isRevision) {
      if (repBusy) return;
      const s = sample();
      if (!s) { $('RepMsg').textContent = '이 화면에서는 Claude가 리포트를 쓸 수 없습니다. "요청+결과 복사"로 Claude Code·Codex에 맡기세요.'; return; }
      let tools = [];
      if ($('RepSim').checked && o.tools) { try { tools = (o.tools() || []).filter(Boolean); } catch (e) { tools = []; } }
      const bytes = (x) => new TextEncoder().encode(x).length;
      const fit = (x, max) => { let s = String(x || ''); while (bytes(s) > max) s = s.slice(0, Math.floor(s.length * 0.9)); return s; };
      tools = tools.filter((t) => { const ok = bytes(JSON.stringify(t.inputSchema || {})) <= 4000; if (!ok) repLog(`! ${t.name}: 입력 설명이 4KB를 넘어 이번 실행에서 뺐습니다`); return ok; })
        .map((t) => (bytes(t.description) > 1000 ? Object.assign({}, t, { description: fit(t.description, 990) }) : t));
      const wrapped = tools.map((t) => Object.assign({}, t, { execute: async (input, ctx) => {
        repLog(`▶ ${t.name} ${JSON.stringify(input).slice(0, 180)}`);
        try { const r = await t.execute(input, ctx); repLog(`  ✓ ${t.name} 완료`); return r; }
        catch (e) { repLog(`  ✗ ${t.name}: ${e.message || e}`); throw e; }
      } }));
      if (!isRevision) {
        const req = $('RepReq').value.trim();
        if (!req) { $('RepMsg').textContent = '어떤 분석을 할지 적어 주세요.'; return; }
        const ctx = context();
        if (!ctx) { $('RepMsg').textContent = '먼저 이 탭에서 결과를 만들어 주세요.'; return; }
        repTurns = [{ role: 'user', content: `${REPORT_RULES}\n\n# 현재 결과\n${ctx}\n\n# 요청\n${req}` }];
        $('RepLog').innerHTML = ''; $('RepLog').hidden = true;
      } else {
        const rv = $('RepRevIn').value.trim();
        if (!rv) return;
        repTurns.push({ role: 'assistant', content: `${MARK}\n${repText}` }, { role: 'user', content: `${rv}\n\n위 요청을 반영해 리포트 전체를 다시 써라. 마지막에 "${MARK}" 아래에 완성본만.` });
        $('RepRevIn').value = '';
      }
      repBusy = true; $('RepGo').disabled = true; $('RepRevGo').disabled = true; $('RepStop').disabled = false;
      $('RepMsg').textContent = tools.length ? 'Claude가 분석 중입니다 (추가 시뮬레이션을 돌리면 몇 분 걸릴 수 있습니다)…' : 'Claude가 리포트를 쓰는 중…';
      repCtl = new AbortController();
      try {
        const opt = { signal: repCtl.signal, modelTier: 'complex', onText: ({ text }) => { const k = text.lastIndexOf(MARK); if (k >= 0) showRep(extract(text)); } };
        if (tools.length) opt.tools = wrapped; else opt.cache = false;
        const { text, truncated } = await s(repTurns, opt);
        repText = extract(text);
        showRep(repText);
        $('RepActs').hidden = false; $('RepRev').hidden = false;
        $('RepMsg').textContent = truncated ? '리포트가 길어 중간에 끊겼습니다. "다시 쓰기"로 범위를 좁혀 요청하세요.' : '완료';
      } catch (e) {
        if (isRevision) repTurns.splice(-2, 2);
        if (e.code === 'not_granted' && window.LOApp && window.LOApp.claudeDenied) { window.LOApp.claudeDenied(); setState(); }
        const msg = { not_granted: 'Claude 사용이 허용되지 않았습니다.', tools_unavailable: '이 화면은 추가 시뮬레이션(도구)을 지원하지 않습니다. 체크를 끄고 다시 시도하세요.', rate_limited: '요청이 많습니다. 잠시 후 다시 시도하세요.', prompt_too_large: '결과가 너무 깁니다. 범위를 줄인 결과로 다시 시도하세요.', cancelled: '중지했습니다.' }[e.code];
        $('RepMsg').textContent = msg || ('리포트를 받지 못했습니다: ' + (e.code || e.message || e));
        if (e.text && e.text.includes(MARK)) showRep(extract(e.text));
      } finally { repBusy = false; $('RepGo').disabled = false; $('RepRevGo').disabled = false; $('RepStop').disabled = true; }
    }
    async function saveAs(name, text, type) {
      const dl = window.claude && window.claude.use ? await window.claude.use('downloads').catch(() => null) : null;
      if (dl) { try { await dl.save({ filename: name, data: new Blob([text], { type }) }); $('RepMsg').textContent = '저장 요청: ' + name; } catch (e) { $('RepMsg').textContent = '저장이 취소되었거나 실패했습니다.'; } return; }
      const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type })); a.download = name; document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000); $('RepMsg').textContent = '저장: ' + name + ' · 다운로드 폴더를 확인하세요';
    }
    const stem = () => `lo-${id.replace(/^ask/, '').toLowerCase()}-analysis-${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '')}`;
    setState();
    setInterval(setState, 1500);
    $('RepGo').addEventListener('click', () => writeReport(false));
    $('RepRevGo').addEventListener('click', () => writeReport(true));
    $('RepStop').addEventListener('click', () => repCtl && repCtl.abort());
    $('RepMdCopy').addEventListener('click', async () => { try { await navigator.clipboard.writeText(repText); $('RepMsg').textContent = 'Markdown을 복사했습니다'; } catch (e) { $('RepMsg').textContent = '클립보드 복사가 막혀 있습니다.'; } });
    $('RepMdSave').addEventListener('click', () => saveAs(stem() + '.md', repText, 'text/markdown'));
    $('RepHtml').addEventListener('click', () => {
      const title = (repText.match(/^#\s+(.+)$/m) || [, '추가 분석 리포트'])[1];
      const doc = `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><style>
:root{--bg:#f4f5f3;--panel:#fff;--panel-2:#f2f3f1;--ink:#15181a;--ink-2:#4b5155;--ink-3:#80878c;--rule:#dfe2df;color-scheme:light}@media (prefers-color-scheme:dark){:root{--bg:#111315;--panel:#191c1f;--panel-2:#1f2326;--ink:#eceeee;--ink-2:#b6bcbf;--ink-3:#868d92;--rule:#2c3135;color-scheme:dark}}
body{margin:0;background:var(--bg);color:var(--ink);font:14.5px/1.75 "Malgun Gothic","Apple SD Gothic Neo",system-ui,sans-serif}main{max-width:960px;margin:0 auto;padding:28px 18px 60px}
h1{font-size:24px}h2{font-size:18px;margin-top:28px;border-bottom:1px solid var(--rule);padding-bottom:4px}h3{font-size:15px}table{border-collapse:collapse;width:100%;font-size:13px;margin:8px 0}th,td{border-bottom:1px solid var(--rule);padding:6px 8px;text-align:left;vertical-align:top}th{color:var(--ink-3);font-weight:500}
code{background:var(--panel-2);padding:0 4px;border-radius:3px;font-size:12.5px}pre{background:var(--panel-2);padding:10px;border-radius:6px;white-space:pre-wrap}.meta{color:var(--ink-3);font-size:12px}.tablewrap{overflow-x:auto}
</style></head><body><main><div class="meta">LO 전투 시뮬레이터 · Claude 추가 분석 · ${esc(new Date().toLocaleString('ko-KR'))}</div>${md2html(repText)}</main></body></html>`;
      saveAs(stem() + '.html', doc, 'text/html');
    });
    $('RepCopyReq').addEventListener('click', async () => {
      const ctx = context();
      const req = $('RepReq').value.trim() || '이 결과에서 가장 중요한 문제를 더 깊게 분석한 리포트를 써줘.';
      if (!ctx) { $('RepMsg').textContent = '먼저 이 탭에서 결과를 만들어 주세요.'; return; }
      const text = `${REPORT_RULES.replace(/- 도구가 주어졌다면[^\n]*\n/, '')}\n\n# 현재 결과\n${ctx}\n\n# 요청\n${req}`;
      try { await navigator.clipboard.writeText(text); $('RepMsg').textContent = `복사했습니다 (${Math.round(text.length / 1024)} KB). Claude Code·Codex에 붙여넣으세요.`; }
      catch (e) { $('RepMsg').textContent = '클립보드 복사가 막혀 있습니다.'; }
    });

    $('Send').addEventListener('click', () => ask($('Input').value));
    $('Input').addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) ask($('Input').value); });
    $('Stop').addEventListener('click', () => ctl && ctl.abort());
    $('Clear').addEventListener('click', () => { turns = []; ctxSig = ''; $('Msgs').innerHTML = ''; $('Msg').textContent = ''; });
    $('Chips').querySelectorAll('button').forEach((b) => b.addEventListener('click', () => { if (sample()) ask(b.textContent); else $('Input').value = b.textContent; }));
    $('Copy').addEventListener('click', async () => {
      const ctx = context();
      if (!ctx) { $('Msg').textContent = '먼저 이 탭에서 결과를 만들어 주세요.'; return; }
      const q = $('Input').value.trim() || '이 결과에서 가장 중요한 문제 3가지와 근거를 정리해줘.';
      const text = firstTurn(ctx, q);
      try { await navigator.clipboard.writeText(text); $('Msg').textContent = `복사했습니다 (${Math.round(text.length / 1024)} KB). Claude·Codex 대화창에 붙여넣으세요.`; }
      catch (e) { $('Msg').textContent = '클립보드 복사가 막혀 있습니다.'; }
    });
  }
  window.LOAsk = { mount };
})();
