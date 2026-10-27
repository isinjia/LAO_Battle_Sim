// =====================================================================================================
//  화면 방향 — 휴대폰·태블릿을 세로로 들고 들어오면 화면 전체를 90도 돌려 가로 화면처럼 보여 준다.
//  화면을 CSS 로 돌리면 브라우저가 주는 포인터 좌표는 여전히 세로 기준이므로, 창 끌기와 씬 클릭은
//  VIEW.point(ev) / VIEW.rect(el) 로 돌린 화면 기준 좌표를 얻어 쓴다.
// =====================================================================================================
(function () {
  const VIEW = { rotated: false, app: null };
  const isTouch = () => (window.matchMedia && matchMedia('(pointer: coarse)').matches) || 'ontouchstart' in window;
  const wantRotate = () => isTouch() && window.innerHeight > window.innerWidth;

  VIEW.apply = function () {
    const app = VIEW.app || (VIEW.app = document.getElementById('app'));
    if (!app) return;
    const on = wantRotate();
    VIEW.rotated = on;
    document.documentElement.classList.toggle('rotated', on);
    if (on) {
      // 가로 길이 = 화면 세로, 세로 길이 = 화면 가로. 왼쪽 위를 축으로 시계 방향 90도 돌리고 제자리로 민다.
      const W = window.innerWidth, H = window.innerHeight;
      app.style.width = H + 'px'; app.style.height = W + 'px';
      app.style.transformOrigin = '0 0'; app.style.transform = 'rotate(90deg) translateY(-100%)';
    } else {
      app.style.width = ''; app.style.height = ''; app.style.transform = ''; app.style.transformOrigin = '';
    }
  };
  // 포인터 이벤트의 화면 좌표 → 돌린 화면(앱) 좌표
  VIEW.point = (ev) => VIEW.rotated ? { x: ev.clientY, y: window.innerWidth - ev.clientX } : { x: ev.clientX, y: ev.clientY };
  // 요소의 화면 사각형 → 앱 좌표 사각형
  VIEW.rect = (el) => {
    const r = el.getBoundingClientRect();
    if (!VIEW.rotated) return { left: r.left, top: r.top, width: r.width, height: r.height };
    return { left: r.top, top: window.innerWidth - r.right, width: r.height, height: r.width };
  };
  // 브라우저가 지원하면 가로로 고정도 시도한다(전체 화면이 아니면 거부되는 브라우저가 많아 실패는 무시).
  VIEW.tryLock = function () {
    try { const o = screen.orientation; if (o && o.lock && isTouch()) o.lock('landscape').catch(() => {}); } catch (e) { /* 지원 안 함 */ }
  };

  VIEW.apply();
  window.addEventListener('resize', () => { VIEW.apply(); if (window.WM) for (const id in WM.wins) WM.fit(WM.wins[id]); });
  window.addEventListener('orientationchange', () => setTimeout(VIEW.apply, 50));
  document.addEventListener('pointerdown', VIEW.tryLock, { once: true });
  window.VIEW = VIEW;
})();
