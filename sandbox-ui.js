// =====================================================================================================
//  원작 NGUI 전투 화면(Panel_StageBattle, UIBattleCreature, UICreatureInfo)을 프리팹에서 내보낸 위젯 배치
//  (ui/layout_<너비>.json, tools/export_ui.py)로 그대로 그린다. 스프라이트·색·글꼴 크기·깊이·앵커가 원본 값이다.
//  동적인 부분(글자·활성·아이콘·채움·위치 이동)은 경로 끝 이름으로 덮어쓴다.
// =====================================================================================================
(function () {
  const UI = { layouts: {}, width: 1920, height: 1080, imgs: {}, tints: {} };
  const SPR = () => (window.CORE && CORE.SPRITES) || {};
  const img = (path) => PACKED.cached(UI.imgs, path); // 배포판은 ImageBitmap(개발자 도구에 그림이 남지 않음)
  const sprite = (name) => img('ui/sprites/' + String(name).replace(/ /g, '_') + '.png');
  function tinted(name, color) {
    const key = name + '|' + color; let cv = UI.tints[key]; if (cv !== undefined) return cv;
    const im = sprite(name); if (!im) return null;
    cv = document.createElement('canvas'); cv.width = im.width; cv.height = im.height;
    const g = cv.getContext('2d'); g.drawImage(im, 0, 0); g.globalCompositeOperation = 'multiply'; g.fillStyle = color; g.fillRect(0, 0, cv.width, cv.height); g.globalCompositeOperation = 'destination-in'; g.drawImage(im, 0, 0);
    UI.tints[key] = cv; return cv;
  }
  const rgb = (c) => `rgb(${Math.round(c[0] * 255)},${Math.round(c[1] * 255)},${Math.round(c[2] * 255)})`;
  UI.load = async function () {
    for (const w of [1920, 2340, 2400]) { try { UI.layouts[w] = await (await fetch('ui/layout_' + w + '.json', { cache: 'no-store' })).json(); } catch (e) { /* 없음 */ } }
  };
  // 두 기준 너비에서 계산된 앵커 위치의 변화량으로 임의 해상도의 앵커를 계산한다.
  UI.layout = (key) => {
    const base = UI.layouts[1920] && UI.layouts[1920][key] || [];
    if (key !== 'battle') return base;
    const cacheKey = UI.width + ':' + UI.height;
    if (UI._layoutKey === cacheKey) return UI._battleLayout;
    const wide = new Map(((UI.layouts[2400] || {}).battle || []).map(o => [o.path, o]));
    const dw = UI.width - 1920, dh = UI.height - 1080;
    UI._battleLayout = base.map(o => {
      const q = wide.get(o.path) || o;
      const vertical = o.path.includes('/UI_penel_rightTop') ? dh / 2 : o.path.includes('/UI_penel_bottom') || o.path.includes('/UI_penel_right/') || o.path.includes('/UI_BattleCreatureScroll') ? -dh / 2 : 0;
      const rect = o.rect.map((v, i) => i % 2 === 0 ? v + (q.rect[i] - v) * dw / 480 : v + vertical);
      return { ...o, rect };
    });
    UI._layoutKey = cacheKey; return UI._battleLayout;
  };
  UI.find = (key, suffix) => UI.layout(key).find((o) => o.path.endsWith(suffix)) || null;
  // BattleAtlas_add 는 NGUI "Unlit/Transparent Additive"(Blend SrcAlpha One) 재질: 빛처럼 더해 그린다(어두운 색은 거의 안 보임)
  const ADDITIVE_ATLAS = new Set(['6cc41b1687d41d0489d2dc7a5ab5590b']);
  // 9분할/채움 스프라이트
  function drawSprite(ctx, o, x, y, w, h, color, alpha, fill, flip) {
    const name = o.sprite; const src = color ? tinted(name, color) : sprite(name); if (!src) return;
    const info = SPR()[String(name).replace(/ /g, '_')], b = info ? info.b : [0, 0, 0, 0];
    ctx.save(); ctx.globalAlpha = alpha;
    if (ADDITIVE_ATLAS.has(o.atlas)) ctx.globalCompositeOperation = 'lighter';
    if (flip === 1 || flip === 3) { ctx.translate(x + w, 0); ctx.scale(-1, 1); x = 0; }
    if (flip === 2 || flip === 3) { ctx.translate(0, y + h); ctx.scale(1, -1); y = 0; }
    if (fill !== undefined && fill < 1) { // 채움(가로) — 슬라이더 전경도 같은 방식
      ctx.beginPath(); if ((o.fillDir || 0) === 1) ctx.rect(x, y + h * (1 - fill), w, h * fill); else ctx.rect(x, y, w * fill, h); ctx.clip();
    }
    const [l, t, r, bt] = b, sw = src.width, sh = src.height;
    if (o.type === 1 && (l || t || r || bt)) {
      const cw = Math.max(0, sw - l - r), ch = Math.max(0, sh - t - bt), dw = Math.max(0, w - l - r), dh = Math.max(0, h - t - bt);
      const parts = [[0, 0, l, t, x, y, l, t], [l, 0, cw, t, x + l, y, dw, t], [sw - r, 0, r, t, x + w - r, y, r, t], [0, t, l, ch, x, y + t, l, dh], [l, t, cw, ch, x + l, y + t, dw, dh], [sw - r, t, r, ch, x + w - r, y + t, r, dh], [0, sh - bt, l, bt, x, y + h - bt, l, bt], [l, sh - bt, cw, bt, x + l, y + h - bt, dw, bt], [sw - r, sh - bt, r, bt, x + w - r, y + h - bt, r, bt]];
      for (const p of parts) if (p[2] > 0 && p[3] > 0 && p[6] > 0 && p[7] > 0) ctx.drawImage(src, p[0], p[1], p[2], p[3], p[4], p[5], p[6], p[7]);
    } else if (o.type === 2) { // 바둑판
      ctx.beginPath(); ctx.rect(x, y, w, h); ctx.clip(); for (let yy = y; yy < y + h; yy += sh) for (let xx = x; xx < x + w; xx += sw) ctx.drawImage(src, xx, yy);
    } else ctx.drawImage(src, x, y, w, h);
    ctx.restore();
  }
  // NGUI 색 코드([RRGGBB], [-]) 가 섞인 글자
  function drawLabel(ctx, o, x, y, w, h, text, color, alpha, scale) {
    let size = Math.max(6, Math.round((o.fontSize || 20) * scale));
    ctx.save(); ctx.globalAlpha = alpha;
    const font = (s) => `700 ${s}px "Noto Sans KR", "Malgun Gothic", sans-serif`;
    ctx.font = font(size); ctx.textBaseline = 'middle';
    // NGUI Overflow.ShrinkContent(0): 상자에 들어가지 않으면 글자 크기를 줄인다
    if (!o.overflow && w > 0) {
      const plain = String(text).split('\n').map((l) => l.replace(/\[(?:[0-9a-fA-F]{6}|-)\]/g, ''));
      const k = Math.min(1, w / Math.max(1, ...plain.map((l) => ctx.measureText(l).width)), h > 0 && plain.length > 1 ? h / (size * 1.15 * plain.length) : 1);
      if (k < 1) { size = Math.max(6, Math.floor(size * k)); ctx.font = font(size); }
    }
    const piv = o.pivot === undefined ? 4 : o.pivot; const px = [0, 0.5, 1, 0, 0.5, 1, 0, 0.5, 1][piv], py = [1, 1, 1, 0.5, 0.5, 0.5, 0, 0, 0][piv];
    let align = o.align || 0; if (align === 0) align = px === 0 ? 1 : px === 1 ? 3 : 2;
    const lines = String(text).split('\n');
    const lh = size * 1.15; const totalH = lh * lines.length;
    let ty = y + h * (1 - py) - totalH * (1 - py) + lh / 2;
    for (const line of lines) {
      const segs = []; let cur = rgb(color); let rest = line;
      const re = /\[([0-9a-fA-F]{6}|-)\]/g; let last = 0, m;
      while ((m = re.exec(line))) { if (m.index > last) segs.push({ t: line.slice(last, m.index), c: cur }); cur = m[1] === '-' ? rgb(color) : '#' + m[1]; last = m.index + m[0].length; }
      if (last < line.length) segs.push({ t: line.slice(last), c: cur });
      const tw = segs.reduce((a, s) => a + ctx.measureText(s.t).width, 0);
      let tx = align === 1 ? x : align === 3 ? x + w - tw : x + (w - tw) / 2;
      for (const s of segs) {
        ctx.textAlign = 'left';
        if (o.effect) { ctx.lineJoin = 'round'; ctx.lineWidth = Math.max(2, size * 0.12); ctx.strokeStyle = o.effectColor ? `rgba(${Math.round(o.effectColor[0] * 255)},${Math.round(o.effectColor[1] * 255)},${Math.round(o.effectColor[2] * 255)},${o.effectColor[3]})` : 'rgba(0,0,0,.8)'; ctx.strokeText(s.t, tx, ty); }
        ctx.fillStyle = s.c; ctx.fillText(s.t, tx, ty); tx += ctx.measureText(s.t).width;
      }
      ty += lh;
    }
    ctx.restore();
  }
  // 위젯 목록 그리기. opts: {W, H (캔버스 크기), ox, oy (설계 좌표 이동), scale, ov: {경로끝: {active, text, sprite, color, fill, alpha, texture(img|canvas), circle, move:[dx,dy], rect(EnvelopContent 처럼 크기를 바꿀 때)}}, hit(o, rect)}
  UI.draw = function (ctx, widgets, opts) {
    const W = opts.W, H = opts.H, s = opts.scale || 1, ox = opts.ox || 0, oy = opts.oy || 0, ov = opts.ov || {};
    const rules = Object.keys(ov);
    const matchOv = (path) => { let out = null; for (const k of rules) if (path.endsWith(k)) out = Object.assign(out || {}, ov[k]); return out; };
    // 그룹 이동/비활성: 조상 경로 규칙의 move/active 는 자손에도 적용
    const groupRules = rules.filter((k) => ov[k] && (ov[k].move || ov[k].active === false || ov[k].groupAlpha !== undefined));
    const list = widgets.filter((o) => o.kind !== 'node');
    for (const o of list) {
      const self = matchOv(o.path) || {};
      let active = o.active, dx = 0, dy = 0, galpha = 1;
      for (const k of groupRules) { if (o.path.includes(k + '/') || o.path.endsWith(k)) { const g = ov[k]; if (g.active === false) active = false; if (g.active === true && o.path.endsWith(k)) active = true; if (g.move) { dx += g.move[0]; dy += g.move[1]; } if (g.groupAlpha !== undefined) galpha *= g.groupAlpha; } }
      if (self.active !== undefined) active = self.active;
      if (!active) continue;
      const r = self.rect || o.rect; let x = W / 2 + ox + (r[0] + dx) * s, y = H / 2 - oy - (r[3] + dy) * s, w = (r[2] - r[0]) * s, h = (r[3] - r[1]) * s;
      const color = self.color || o.color || [1, 1, 1, 1]; const alpha = (self.alpha !== undefined ? self.alpha : color[3]) * galpha;
      // 회전·뒤집힌 위젯(o.m 2x2 행렬, o.org 기준점, o.lrect 자기 좌표 사각형): 캔버스를 그 행렬로 돌려 자기 좌표에 그린다. 누르기 영역은 외곽 사각형.
      const hx = x, hy = y, hw = w, hh = h;
      if (o.m) {
        const m = o.m, lr = o.lrect; ctx.save();
        ctx.transform(s * m[0], -s * m[2], -s * m[1], s * m[3], W / 2 + ox + (o.org[0] + dx) * s, H / 2 - oy - (o.org[1] + dy) * s);
        x = lr[0]; y = -lr[3]; w = lr[2] - lr[0]; h = lr[3] - lr[1];
      }
      if (o.kind === 'sprite') {
        const name = self.sprite || o.sprite; const isWhite = color[0] > 0.98 && color[1] > 0.98 && color[2] > 0.98;
        drawSprite(ctx, Object.assign({}, o, { sprite: name }), x, y, w, h, isWhite ? null : rgb(color), alpha, self.fill !== undefined ? self.fill : o.fill, o.flip);
      } else if (o.kind === 'label') {
        if (self.text !== undefined && self.text !== null) drawLabel(ctx, o, x, y, w, h, self.text, color, alpha, o.m ? 1 : s * (o.scale ? o.scale[0] : 1));
        else if (o.text && !self.hideText) drawLabel(ctx, o, x, y, w, h, o.text, color, alpha, o.m ? 1 : s * (o.scale ? o.scale[0] : 1));
      } else if (o.kind === 'texture') {
        if (self.texture) { ctx.save(); ctx.globalAlpha = alpha; if (self.circle) { ctx.beginPath(); ctx.arc(x + w / 2, y + h / 2, Math.min(w, h) / 2, 0, Math.PI * 2); ctx.clip(); } ctx.drawImage(self.texture, x, y, w, h); ctx.restore(); }
        else if (self.fillStyle) { ctx.save(); ctx.globalAlpha = alpha; ctx.fillStyle = self.fillStyle; ctx.fillRect(x, y, w, h); ctx.restore(); }
      }
      if (o.m) ctx.restore();
      if (self.hit && opts.hit) opts.hit(o, { x: hx, y: hy, w: hw, h: hh }, self.hit);
    }
  };
  // 라벨 한 줄을 그 라벨의 글꼴·정렬로 그린다(정보창의 여러 줄 설명처럼 줄을 직접 나눠 그릴 때)
  UI.drawText = (ctx, o, x, y, w, h, text) => { const c = o.color || [1, 1, 1, 1]; drawLabel(ctx, o, x, y, w, h, text, c, c[3], 1); };
  // 설계 좌표(원점 중앙, y 위) -> 캔버스
  UI.toCanvas = (W, H, x, y) => ({ x: W / 2 + x, y: H / 2 - y });
  window.UI = UI;
})();
