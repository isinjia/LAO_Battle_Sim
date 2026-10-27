// =====================================================================================================
//  창 관리자 — 유니티 편집기처럼 창을 끌어 옮기고, 모서리로 크기를 바꾸고, 창마다 배율(확대·축소)을 조절한다.
//  창 배치는 이 브라우저에 저장된다. 위 메뉴의 "창" 에서 닫은 창을 다시 열고, "레이아웃 초기화"로 기본 배치로 돌린다.
// =====================================================================================================
(function () {
  const KEY = 'lo-sandbox-layout-v2';
  const store = {
    get() { try { return JSON.parse(localStorage.getItem(KEY) || 'null') || {}; } catch (e) { return {}; } },
    set(v) { try { localStorage.setItem(KEY, JSON.stringify(v)); } catch (e) { /* 저장 불가 */ } },
  };
  const WM = { wins: {}, order: [], root: null, menu: null, zTop: 10, saved: store.get() };

  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }

  WM.init = function (root, menuRoot) {
    WM.root = root; WM.menu = menuRoot;
    window.addEventListener('resize', () => { for (const id in WM.wins) WM.fit(WM.wins[id]); });
  };

  // spec: {id, title, x, y, w, h, minW, minH, content(el), scalable(bool, 기본 true), hidden(처음엔 닫힘), help(도움말 주제, 기본 id), onResize(win), onScale(win)}
  WM.create = function (spec) {
    const el = document.createElement('div');
    el.className = 'win'; el.dataset.id = spec.id;
    el.innerHTML = `<div class="win-title"><span class="win-name">${spec.title}</span>
      <span class="win-tools">${spec.scalable === false ? '' : `<label class="win-scale" title="창 안 내용 배율">배율 <input type="range" min="50" max="200" step="10" value="100"><b>100%</b></label>`}
      <button class="win-btn win-help" title="이 창의 도움말 (F1)">?</button><button class="win-btn win-min" title="접기">—</button><button class="win-btn win-close" title="닫기">×</button></span></div>
      <div class="win-body"><div class="win-content"></div></div>${['n', 's', 'w', 'e', 'nw', 'ne', 'sw', 'se'].map(dir => `<div class="win-resize win-resize-${dir}" data-dir="${dir}" title="크기 조절"></div>`).join('')}`;
    const body = el.querySelector('.win-body'), content = el.querySelector('.win-content');
    if (spec.content) content.appendChild(spec.content);
    WM.root.appendChild(el);
    const win = { id: spec.id, spec, el, body, content, x: spec.x, y: spec.y, w: spec.w, h: spec.h, scale: 1, min: false, hidden: !!spec.hidden, title: spec.title };
    const sv = WM.saved[spec.id];
    if (sv) Object.assign(win, { x: sv.x, y: sv.y, w: sv.w, h: sv.h, scale: sv.scale || 1, min: !!sv.min, hidden: !!sv.hidden });
    WM.wins[spec.id] = win; WM.order.push(spec.id);
    // 끌어서 이동
    const title = el.querySelector('.win-title');
    title.addEventListener('mousedown', (ev) => {
      if (ev.target.closest('.win-tools')) return;
      WM.front(win);
      const sx = ev.clientX - win.x, sy = ev.clientY - win.y;
      const mv = (e) => { win.x = e.clientX - sx; win.y = e.clientY - sy; WM.apply(win); };
      const up = () => { document.removeEventListener('mousemove', mv); document.removeEventListener('mouseup', up); WM.save(); };
      document.addEventListener('mousemove', mv); document.addEventListener('mouseup', up); ev.preventDefault();
    });
    title.addEventListener('dblclick', (ev) => { if (ev.target.closest('.win-tools')) return; WM.toggleMin(win); });
    el.addEventListener('mousedown', () => WM.front(win));
    // 네 테두리와 네 모서리: 반대쪽 끝은 고정하고 잡은 방향만 늘리거나 줄인다.
    el.querySelectorAll('.win-resize').forEach(handle => handle.addEventListener('pointerdown', (ev) => {
      if (ev.button !== 0 || win.min) return;
      WM.front(win);
      const dir = handle.dataset.dir, sx = ev.clientX, sy = ev.clientY;
      const x0 = win.x, y0 = win.y, w0 = win.w, h0 = win.h;
      const minW = spec.minW || 240, minH = spec.minH || 120;
      const oldCursor = document.body.style.cursor, oldSelect = document.body.style.userSelect;
      document.body.style.cursor = getComputedStyle(handle).cursor; document.body.style.userSelect = 'none';
      const mv = (e) => {
        if (e.pointerId !== ev.pointerId) return;
        const dx = e.clientX - sx, dy = e.clientY - sy;
        if (dir.includes('e')) win.w = Math.max(minW, w0 + dx);
        if (dir.includes('w')) { win.w = Math.max(minW, w0 - dx); win.x = x0 + w0 - win.w; }
        if (dir.includes('s')) win.h = Math.max(minH, h0 + dy);
        if (dir.includes('n')) { win.h = Math.max(minH, h0 - dy); win.y = y0 + h0 - win.h; }
        WM.apply(win);
      };
      const up = (e) => {
        if (e.pointerId !== ev.pointerId) return;
        handle.removeEventListener('pointermove', mv); handle.removeEventListener('pointerup', up);
        handle.removeEventListener('pointercancel', up); handle.removeEventListener('lostpointercapture', up);
        if (handle.hasPointerCapture(ev.pointerId)) handle.releasePointerCapture(ev.pointerId);
        document.body.style.cursor = oldCursor; document.body.style.userSelect = oldSelect; WM.save();
      };
      handle.addEventListener('pointermove', mv); handle.addEventListener('pointerup', up);
      handle.addEventListener('pointercancel', up); handle.addEventListener('lostpointercapture', up);
      handle.setPointerCapture(ev.pointerId);
      ev.preventDefault(); ev.stopPropagation();
    }));
    el.querySelector('.win-min').addEventListener('click', () => WM.toggleMin(win));
    el.querySelector('.win-close').addEventListener('click', () => WM.hide(win));
    el.querySelector('.win-help').addEventListener('click', () => { if (window.HELP) HELP.open(spec.help || spec.id); });
    const sc = el.querySelector('.win-scale input');
    if (sc) sc.addEventListener('input', () => { win.scale = +sc.value / 100; WM.apply(win); WM.save(); });
    WM.apply(win); WM.fit(win);
    WM.renderMenu();
    return win;
  };
  WM.apply = function (win) {
    const el = win.el;
    el.style.left = win.x + 'px'; el.style.top = win.y + 'px'; el.style.width = win.w + 'px';
    el.style.height = win.min ? '' : win.h + 'px';
    el.classList.toggle('min', win.min); el.hidden = win.hidden;
    const sc = el.querySelector('.win-scale');
    if (sc) { sc.querySelector('input').value = Math.round(win.scale * 100); sc.querySelector('b').textContent = Math.round(win.scale * 100) + '%'; }
    if (win.spec.scalable !== false) { win.content.style.zoom = win.scale; }
    if (win.spec.onResize) win.spec.onResize(win);
  };
  WM.fit = function (win) { // 화면 밖으로 나간 창을 안으로
    const W = WM.root.clientWidth, H = WM.root.clientHeight;
    if (!W || !H) return;
    win.x = clamp(win.x, -win.w + 80, W - 80); win.y = clamp(win.y, 0, H - 32);
    WM.apply(win);
  };
  WM.front = function (win) { win.el.style.zIndex = ++WM.zTop; };
  WM.toggleMin = function (win) { win.min = !win.min; WM.apply(win); WM.save(); };
  WM.hide = function (win) { win.hidden = true; WM.apply(win); WM.save(); WM.renderMenu(); };
  WM.show = function (id) { const w = WM.wins[id]; if (!w) return; w.hidden = false; w.min = false; WM.apply(w); WM.front(w); WM.fit(w); WM.save(); WM.renderMenu(); };
  WM.save = function () {
    const o = {}; for (const id in WM.wins) { const w = WM.wins[id]; o[id] = { x: w.x, y: w.y, w: w.w, h: w.h, scale: w.scale, min: w.min, hidden: w.hidden }; }
    store.set(o);
  };
  WM.resetLayout = function () {
    for (const id in WM.wins) { const w = WM.wins[id]; Object.assign(w, { x: w.spec.x, y: w.spec.y, w: w.spec.w, h: w.spec.h, scale: 1, min: false, hidden: !!w.spec.hidden }); WM.apply(w); }
    WM.save(); WM.renderMenu();
  };
  WM.renderMenu = function () {
    if (!WM.menu) return;
    WM.menu.innerHTML = WM.order.map((id) => { const w = WM.wins[id]; return `<button class="menu-item ${w.hidden ? 'off' : ''}" data-win="${id}">${w.hidden ? '☐' : '☑'} ${w.title}</button>`; }).join('');
    WM.menu.querySelectorAll('[data-win]').forEach((b) => b.addEventListener('click', () => { const w = WM.wins[b.dataset.win]; if (w.hidden) WM.show(w.id); else WM.hide(w); }));
  };
  window.WM = WM;
})();
