// =====================================================================================================
//  씬 화면 — 인게임 전투 화면(Scene_StageBattle + Panel_StageBattle)과 같은 구성을 1920x1080 캔버스에 그린다.
//  칸 좌표는 Scene_StageBattle.unity 의 spot(line1~3 / line1-1~3) 월드 좌표를 원근 투영한 값이고,
//  UI 는 Panel_StageBattle.prefab 의 구성(턴 순서 바, 스킬 패널, 행동 개시 버튼, 승인 버튼, 스킬 미리보기 창,
//  적 행동 예측 표식)을 원작 아틀라스 스프라이트(ui/sprites)로 따라 그린다. SD 는 라켓몬스터 방식(sandbox-sd.js).
// =====================================================================================================
(function () {
  const C = window.CORE, L = C.L, TT = C.TT, num = C.num, str = C.str;
  let W = 1920, H = 1080;
  const SCENE = { canvas: null, ctx: null, zoom: 1, host: null, mouse: { x: -1, y: -1 }, hits: [], pops: [], last: 0, t: 0, status: '', statusUntil: 0, imgs: {}, tints: {}, running: false, hoverUnit: null };

  // ---------------------------------------------------------------- 그림 자료
  function img(path) { let im = SCENE.imgs[path]; if (!im) { im = new Image(); im._ok = false; im.onload = () => { im._ok = true; }; if (window.PACKED) PACKED.setSrc(im, path); else im.src = path; SCENE.imgs[path] = im; } return im._ok ? im : null; }
  const sprite = (name) => img('ui/sprites/' + name + '.png');
  const skillImg = (icon) => img('ui/skill/' + icon + '.png');
  const faceImg = (u) => { const n = C.tbarIcon(u); return n ? img('ui/tbar/' + n + '.png') : null; };
  function tinted(name, color) { // 흰색 스프라이트에 색을 입힌 사본(NGUI UISprite.color 와 같음)
    const key = name + '|' + color; let cv = SCENE.tints[key];
    if (cv !== undefined) return cv;
    const im = sprite(name); if (!im) return null;
    cv = document.createElement('canvas'); cv.width = im.width; cv.height = im.height;
    const g = cv.getContext('2d'); g.drawImage(im, 0, 0); g.globalCompositeOperation = 'multiply'; g.fillStyle = color; g.fillRect(0, 0, cv.width, cv.height); g.globalCompositeOperation = 'destination-in'; g.drawImage(im, 0, 0);
    SCENE.tints[key] = cv; return cv;
  }
  function drawSliced(ctx, name, x, y, w, h, opts) { // 9분할(테두리 값은 ui/sprites.json)
    opts = opts || {};
    const src = opts.color ? tinted(name, opts.color) : sprite(name); if (!src) return;
    const info = C.SPRITES[name], b = info ? info.b : [0, 0, 0, 0];
    const [l, t, r, bt] = b, sw = src.width, sh = src.height;
    ctx.save(); ctx.globalAlpha = opts.alpha == null ? 1 : opts.alpha;
    if (!l && !t && !r && !bt) { ctx.drawImage(src, x, y, w, h); ctx.restore(); return; }
    const cw = Math.max(0, sw - l - r), ch = Math.max(0, sh - t - bt), dw = Math.max(0, w - l - r), dh = Math.max(0, h - t - bt);
    const parts = [[0, 0, l, t, x, y, l, t], [l, 0, cw, t, x + l, y, dw, t], [sw - r, 0, r, t, x + w - r, y, r, t],
      [0, t, l, ch, x, y + t, l, dh], [l, t, cw, ch, x + l, y + t, dw, dh], [sw - r, t, r, ch, x + w - r, y + t, r, dh],
      [0, sh - bt, l, bt, x, y + h - bt, l, bt], [l, sh - bt, cw, bt, x + l, y + h - bt, dw, bt], [sw - r, sh - bt, r, bt, x + w - r, y + h - bt, r, bt]];
    for (const p of parts) if (p[2] > 0 && p[3] > 0 && p[6] > 0 && p[7] > 0) ctx.drawImage(src, p[0], p[1], p[2], p[3], p[4], p[5], p[6], p[7]);
    ctx.restore();
  }
  function drawImg(ctx, im, cx, cy, w, h, alpha) { if (!im) return; ctx.save(); if (alpha != null) ctx.globalAlpha = alpha; ctx.drawImage(im, cx - w / 2, cy - h / 2, w, h); ctx.restore(); }
  function text(ctx, s, x, y, o) {
    o = o || {}; ctx.save();
    ctx.font = `${o.weight || 700} ${o.size || 20}px "Noto Sans KR", "Malgun Gothic", sans-serif`;
    ctx.textAlign = o.align || 'left'; ctx.textBaseline = o.base || 'middle';
    if (o.outline !== false) { ctx.lineJoin = 'round'; ctx.lineWidth = o.lw || 3; ctx.strokeStyle = o.outlineColor || 'rgba(0,0,0,.8)'; ctx.strokeText(s, x, y); }
    ctx.fillStyle = o.color || '#fff'; ctx.fillText(s, x, y);
    const w = ctx.measureText(s).width; ctx.restore(); return w;
  }
  function circleClip(ctx, im, cx, cy, d) { if (!im) return; ctx.save(); ctx.beginPath(); ctx.arc(cx, cy, d / 2, 0, Math.PI * 2); ctx.clip(); ctx.drawImage(im, cx - d / 2, cy - d / 2, d, d); ctx.restore(); }
  const hit = (x, y, w, h, kind, data, cursor) => SCENE.hits.push({ x, y, w, h, kind, data, cursor: cursor || 'pointer' });

  // ---------------------------------------------------------------- 전장 좌표 (Scene_StageBattle.unity spot 기준, 원근 투영)
  const PC_X = [[-32.73, -21.94, -11.44], [-34.61, -23.26, -12.10], [-36.52, -24.64, -12.83]];
  const MOB_X = [[12.49, 23.18, 33.68], [13.40, 24.49, 35.54], [14.19, 25.95, 37.45]];
  const ROW_Y = [6.17, -0.68, -8.41], ROW_Z = [34.4, 33.03, 32.15];
  const GY = 590, SX = 21, SY = 22, UNIT_H = 190;
  function cellPos(team, pos) { const r = Math.floor(pos / 3), c = pos % 3; const X = (team === 1 ? PC_X : MOB_X)[r][c]; const fieldScale = Math.min(1, (W - 100) / 1700, (H - 420) / 600); const f = 33 / ROW_Z[r] * fieldScale; const centerY = Math.min(H / 2 + 50, H - 315 - 190 * fieldScale); return { x: W / 2 + X * SX * f, y: centerY - ROW_Y[r] * SY * f, f, r, c }; }
  const unitPos = (u) => cellPos(u.team === 1 ? 1 : 0, u.gridPos);
  const unitBox = (u) => { const p = unitPos(u); const h = UNIT_H * p.f, w = 120 * p.f; return { x: p.x - w / 2, y: p.y - h, w, h, p }; };

  // ---------------------------------------------------------------- 캔버스
  SCENE.setWidth = function (w) { C.setup.autoResolution = !w; if (w) C.setup.aspect = w; SCENE.fit(); };
  SCENE.mount = function (host) {
    SCENE.host = host;
    W = +(C.setup.aspect || 1920); if (window.UI) { UI.width = W; UI.height = H; }
    const cv = document.createElement('canvas'); cv.width = W; cv.height = H; cv.className = 'scene-canvas';
    host.appendChild(cv); SCENE.canvas = cv; SCENE.ctx = cv.getContext('2d');
    const toLocal = (ev) => { const r = window.VIEW ? VIEW.rect(cv) : cv.getBoundingClientRect(), p = window.VIEW ? VIEW.point(ev) : { x: ev.clientX, y: ev.clientY }; return { x: (p.x - r.left) * W / r.width, y: (p.y - r.top) * H / r.height }; };
    cv.addEventListener('mousemove', (ev) => { SCENE.mouse = toLocal(ev); const h = hitAt(SCENE.mouse); cv.style.cursor = h ? h.cursor : 'default'; onHover(h); });
    cv.addEventListener('mouseleave', () => { SCENE.mouse = { x: -1, y: -1 }; onHover(null); });
    cv.addEventListener('mousedown', (ev) => { if (ev.button !== 0) return; SCENE.pressAt = toLocal(ev); });
    cv.addEventListener('mouseup', (ev) => { if (ev.button !== 0) return; const p = toLocal(ev); const d = SCENE.pressAt ? Math.hypot(p.x - SCENE.pressAt.x, p.y - SCENE.pressAt.y) : 0; if (d < 24) onClick(hitAt(p)); });
    SCENE.fit();
    if (!SCENE.running) { SCENE.running = true; tick(); }
  };
  SCENE.fit = function () {
    const host = SCENE.host, cv = SCENE.canvas; if (!host || !cv) return;
    const body = host.closest('.win-body') || host;
    const hw = Math.max(1, body.clientWidth || 800), hh = Math.max(1, body.clientHeight || 450);
    let cssW, cssH;
    if (C.setup.autoResolution !== false) {
      // 창 전체를 채우고 조작부는 기준 해상도에 맞춰 균일하게 확대·축소한다.
      //  원작 UIRoot 기준(1920x1080)보다 좁아지지 않게 해야 왼쪽 아래 턴 순서 바와 오른쪽 아래 스킬 패널이 원작처럼 떨어져 있다.
      const scale = Math.min(hw / 1920, hh / 1080);
      W = hw / scale; H = hh / scale; cssW = hw; cssH = hh;
    } else {
      W = +(C.setup.aspect || 2340); H = 1080;
      const scale = Math.min(hw / W, hh / H); cssW = W * scale; cssH = H * scale;
    }
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const pxW = Math.max(1, Math.round(cssW * dpr)), pxH = Math.max(1, Math.round(cssH * dpr));
    if (cv.width !== pxW || cv.height !== pxH) { cv.width = pxW; cv.height = pxH; }
    cv.style.width = cssW * SCENE.zoom + 'px'; cv.style.height = cssH * SCENE.zoom + 'px';
    if (window.UI) { UI.width = W; UI.height = H; }
    SCENE.resolution = { width: pxW, height: pxH, logicalWidth: W, logicalHeight: H, automatic: C.setup.autoResolution !== false };
  };
  function hitAt(p) { for (let i = SCENE.hits.length - 1; i >= 0; i--) { const h = SCENE.hits[i]; if (p.x >= h.x && p.x <= h.x + h.w && p.y >= h.y && p.y <= h.y + h.h) return h; } return null; }
  function onHover(h) {
    const m = C.S.manual; SCENE.hoverUnit = h && h.kind === 'unit' ? h.data : null;
    if (!m || m.sel) return;
    if (h && h.kind === 'unit' && m.mode === 'skill' && m.cands) {
      const t = h.data;
      if (m.cands.kind === 'unit' && m.cands.units.includes(t)) { C.manualHover({ aid: m.unit.aid, skillKey: m.skill.key, targetAid: t.aid, targetGridPos: 255 }); return; }
      if (m.cands.kind === 'cell' && m.cands.fixed === null && (t.team === 1) === (m.cands.side === 1) && m.cands.cells.includes(t.gridPos)) { C.manualHover({ aid: m.unit.aid, skillKey: m.skill.key, targetAid: 0, targetGridPos: t.gridPos }); return; }
    }
    if (h && h.kind === 'cell' && m.mode === 'skill' && m.cands && m.cands.kind === 'cell' && m.cands.fixed === null && h.data.team === m.cands.side) { C.manualHover({ aid: m.unit.aid, skillKey: m.skill.key, targetAid: 0, targetGridPos: h.data.pos }); return; }
    if (m.hover) C.manualHover(null);
  }
  function onClick(h) {
    try { onClickInner(h); } catch (e) { console.error(e); SCENE.setStatus('선택을 처리하지 못했습니다. 다시 선택해 주세요.'); }
  }
  function onClickInner(h) {
    const S = C.S, m = S.manual;
    if (h && h.kind === 'unit') C.inspect({ kind: 'unit', unit: h.data });
    if (h && h.kind === 'skill' && h.data) C.inspect({ kind: 'skill', skill: h.data, unit: m ? m.unit : (S.pending && S.pending.unit) || (S.lastAction && S.lastAction.actor) });
    if (!h) { if (m && m.sel && m.mode !== 'wait') C.manualCancelTarget(); return; } // 빈 곳 탭: 대상 선택 취소(ConfirmCancel)
    switch (h.kind) {
      case 'skill': if (m && h.data && !h.data.cooldownLeft) C.manualChooseSkill(h.data); break;
      case 'move': if (m) C.manualChooseMove(); break;
      case 'wait': if (m) C.manualChooseWait(); break;
      case 'confirm': if (m && m.sel && (!m.needPlay || (m.mode === 'move' && C.sysOn('moveConfirm')))) C.manualExecute(); break;
      case 'play': C.playConfirmed(); break;
      case 'restart': C.startBattle(); break;
      case 'auto': C.setAuto(!C.isAuto()); break;
      case 'unit': if (m) { if (!C.manualClickUnit(h.data) && m.sel && m.mode !== 'wait') C.manualCancelTarget(); } break;
      case 'cell': if (m) C.manualClickCell(h.data.team, h.data.pos); break;
      case 'log': if (window.WM) WM.show('log'); break;
      default: break;
    }
  }
  SCENE.setStatus = (s) => { SCENE.status = s; SCENE.statusUntil = performance.now() + 4000; };
  C.on('status', SCENE.setStatus);
  // 피해 숫자는 동작 중간(hitDelay)에 뜨고, 그때까지 체력 막대는 이전 값을 유지한다(인게임 타이밍)
  SCENE.hp = new Map(); SCENE.hpHold = new Map();
  SCENE.actionArrows = [];
  C.on('action', (info) => {
    addActionArrows(info);
    const at = performance.now() + (info.hitDelay || 0) * 1000;
    for (const p of info.pops) SCENE.pops.push({ aid: p.aid, text: p.text, cls: p.cls, t0: at, dy: (Math.random() - 0.5) * 20 });
    const b = C.S.battle; if (b) for (const u of b.units) { if (!SCENE.hp.has(u.aid)) SCENE.hp.set(u.aid, u.hp); SCENE.hpHold.set(u.aid, at); }
  });
  // 실행 당시의 칸을 저장하여 이동·사망 뒤에도 행동 경로를 유지한다.
  function addActionArrows(info) {
    const b = C.S.battle, a = info.actor, rec = info.rec;
    if (SCENE.arrowBattle !== b) { SCENE.arrowBattle = b; SCENE.actionArrows = []; }
    const point = (team, pos) => ({ team, pos });
    const start = point(a.team, rec.kind === 'move' ? rec.from : a.gridPos);
    const label = rec.kind === 'skill' ? C.skillName(rec.skill) : rec.kind === 'move' ? '이동' : '대기';
    let routes = info.routes || [];
    if (rec.kind === 'move') routes = [{ point: point(a.team, rec.to), kind: 'move' }];
    if (!routes.length) routes = [{ point: start, kind: 'self' }];
    const t0 = performance.now(), duration = Math.max(2200, (info.animDur || 0) * 1000 + 500);
    routes.forEach((r, i) => {
      const target = r.point ? null : C.byAid(r.aid);
      if (!r.point && !target) return;
      SCENE.actionArrows.push({ from: start, to: r.point || point(target.team, target.gridPos), label: C.unitName(a) + ' · ' + label + (r.kind === 'miss' ? ' · 회피' : ''), color: r.kind === 'move' ? '#7dc9ff' : r.kind === 'heal' || (target && target.team === a.team) ? '#8ef2b1' : a.team === 1 ? '#ffd36a' : '#ff8989', t0, duration, lane: i });
    });
    SCENE.actionArrows = SCENE.actionArrows.slice(-24);
  }
  function drawActionArrows(ctx, now) {
    if (SCENE.arrowBattle !== C.S.battle) { SCENE.actionArrows = []; return; }
    SCENE.actionArrows = SCENE.actionArrows.filter(a => now < a.t0 + a.duration);
    for (const a of SCENE.actionArrows) {
      const age = now - a.t0, fade = Math.min(1, age / 100, (a.duration - age) / 450);
      const p = cellPos(a.from.team, a.from.pos), q = cellPos(a.to.team, a.to.pos);
      const same = a.from.team === a.to.team && a.from.pos === a.to.pos;
      const x0 = p.x, y0 = p.y - 85 * p.f, x1 = same ? q.x + 28 : q.x, y1 = q.y - 100 * q.f;
      const cx = same ? x0 + 145 : (x0 + x1) / 2, cy = Math.min(y0, y1) - (same ? 160 : Math.min(190, 65 + Math.abs(x1 - x0) * 0.15)) - a.lane * 22;
      const t = Math.min(1, age / 320), ax = x0 + (cx - x0) * t, ay = y0 + (cy - y0) * t;
      const bx = cx + (x1 - cx) * t, by = cy + (y1 - cy) * t;
      const ex = ax + (bx - ax) * t, ey = ay + (by - ay) * t, angle = Math.atan2(by - ay, bx - ax);
      ctx.save(); ctx.globalAlpha = Math.max(0, fade); ctx.lineCap = 'round';
      const path = () => { ctx.beginPath(); ctx.moveTo(x0, y0); ctx.quadraticCurveTo(ax, ay, ex, ey); };
      path(); ctx.strokeStyle = 'rgba(0,0,0,.65)'; ctx.lineWidth = 9; ctx.stroke();
      path(); ctx.strokeStyle = a.color; ctx.lineWidth = 4; ctx.stroke();
      ctx.beginPath(); ctx.moveTo(ex, ey); ctx.lineTo(ex - 18 * Math.cos(angle - .45), ey - 18 * Math.sin(angle - .45)); ctx.lineTo(ex - 18 * Math.cos(angle + .45), ey - 18 * Math.sin(angle + .45)); ctx.closePath(); ctx.fillStyle = a.color; ctx.fill();
      if (t > .6) {
        const lx = (x0 + 2 * cx + x1) / 4, ly = (y0 + 2 * cy + y1) / 4 - 19;
        ctx.font = '700 20px "Malgun Gothic", sans-serif'; const w = ctx.measureText(a.label).width + 22;
        ctx.fillStyle = 'rgba(15,20,28,.88)'; ctx.beginPath(); ctx.roundRect(lx - w / 2, ly - 16, w, 32, 7); ctx.fill();
        text(ctx, a.label, lx, ly, { size: 20, align: 'center', color: a.color, outline: false });
      }
      ctx.restore();
    }
  }
  function shownHp(u, now, dt) {
    let v = SCENE.hp.has(u.aid) ? SCENE.hp.get(u.aid) : u.hp;
    const hold = SCENE.hpHold.get(u.aid) || 0;
    if (now >= hold) { v += (u.hp - v) * Math.min(1, dt * 8); if (Math.abs(u.hp - v) < 1) v = u.hp; }
    SCENE.hp.set(u.aid, v); return v;
  }
  // 행동력 연출 단계 (Panel_StageBattle.coTurnApEffectEndCheck → coArrangeApTrackSlots). 단계 목록은 sandbox-core apPresentation 이 만든다
  function apPhase(now) {
    const an = C.S.apAnim; if (!an || !an.phases || !an.phases.length) return null;
    if (now < an.t0) return { name: 'wait', p: 0, an };
    let t = now - an.t0;
    for (const ph of an.phases) { if (t < ph.dur) return { name: ph.name, p: ph.dur > 0 ? t / ph.dur : 1, an }; t -= ph.dur; }
    return { name: 'done', p: 1, an };
  }
  // 게이지에 보일 행동력: 경주 단계에서만 이전 값 → 현재 값으로 채운다. 경주를 생략한 라운드는 처음부터 현재 값
  function gaugeAp(pre, cur, ph) {
    if (!ph || ph.name === 'done' || ph.name === 'lineup' || ph.name === 'final' || ph.name === 'hold') return cur;
    const racing = ph.an.phases.some((p) => p.name === 'advance');
    if (ph.name === 'advance') return pre + (cur - pre) * ph.p;
    return racing ? pre : cur;
  }
  function shownAp(u, now) { const pre = u.preTurnPos === undefined ? u.turnPos : u.preTurnPos; return gaugeAp(pre, u.turnPos, apPhase(now)); }

  // ---------------------------------------------------------------- 매 프레임
  function tick() {
    setTimeout(tick, 33); // 가려진 창에서도 진행
    const now = performance.now(); const dt = Math.min(0.05, Math.max(0, (now - (SCENE.last || now)) / 1000)); SCENE.last = now; SCENE.t += dt;
    if (!SCENE.ctx) return;
    SCENE.dt = dt;
    renderSD(dt, now);
    draw(now);
  }
  function renderSD(dt, now) {
    const S = C.S, b = S.battle;
    if (!b || !C.sysOn('sd') || !window.SDL || !SDL.ok) return;
    const items = [];
    for (const u of b.units) {
      if (u.removed && !C.isPC(u)) continue;
      const rig = SDL.rigOf(u); if (!rig || SDL.failed[rig]) continue;
      if (!SDL.ready(rig)) continue;
      let an = S.anims.get(u.aid) || {};
      // 부활하면 사망 표시 상태를 되돌린다.
      if (u.hp > 0) { u._deathVisualAt = null; u._deathVisualDone = false; if (an.name === 'die') { S.anims.delete(u.aid); an = {}; } }
      if (u.hp <= 0) {
        if (u._deathVisualDone) { u._sdSlot = null; continue; }
        if (u._deathVisualAt == null) u._deathVisualAt = an.startedAt == null ? now : an.startedAt;
        const clip = u._sd && u._sd.tpl.data.clips.die;
        const duration = clip ? clip.dur * 1000 : 1500;
        const elapsed = now - u._deathVisualAt;
        if (elapsed > duration + 450) { u._deathVisualDone = true; u._sdSlot = null; SDL.release(u); continue; }
        an = { ...an, name: elapsed < 0 ? 'idle' : 'die' };
        u._deathVisualAlpha = elapsed > duration ? Math.max(0, 1 - (elapsed - duration) / 450) : 1;
      }
      if (an.until && now > an.until) { S.anims.delete(u.aid); an.name = null; }
      if (!an.name && an.tintUntil && now > an.tintUntil) S.anims.delete(u.aid);
      items.push({ holder: u, key: rig, anim: an.name || 'idle', h: 110, flip: C.isPC(u) ? C.optOn('sd', 'flipAlly') : C.optOn('sd', 'flipEnemy'),
        tint: an.tintUntil && now < an.tintUntil ? [1, 0.45, 0.45] : null, alpha: u.hp <= 0 ? u._deathVisualAlpha : 1, onEnd: () => { const cur = S.anims.get(u.aid); if (cur && cur.name !== 'move') S.anims.delete(u.aid); } });
    }
    SDL.renderFrame(items, dt);
  }

  // ---------------------------------------------------------------- 그리기
  function draw(now) {
    const ctx = SCENE.ctx, S = C.S, b = S.battle;
    ctx.setTransform(SCENE.canvas.width / W, 0, 0, SCENE.canvas.height / H, 0, 0);
    SCENE.hits = [];
    // 배경
    const bg = img('ui/bg/' + (C.setup.bg || 'route') + '.jpg');
    if (bg) { const k = Math.max(W / bg.width, H / bg.height); ctx.drawImage(bg, (W - bg.width * k) / 2, (H - bg.height * k) / 2, bg.width * k, bg.height * k); } else { ctx.fillStyle = '#1a2230'; ctx.fillRect(0, 0, W, H); }
    const grd = ctx.createLinearGradient(0, 300, 0, H); grd.addColorStop(0, 'rgba(0,0,0,0)'); grd.addColorStop(1, 'rgba(0,0,0,.45)'); ctx.fillStyle = grd; ctx.fillRect(0, 0, W, H);
    if (!b) { drawIdle(ctx); drawHud(ctx, now, null, null, []); return; }
    const m = S.manual, pv = S.preview, markers = C.intentMarkers();
    drawCells(ctx, m, pv);
    // 유닛(먼 줄부터)
    const units = b.units.filter((u) => !(u.removed && !C.isPC(u))).sort((x, y) => Math.floor(x.gridPos / 3) - Math.floor(y.gridPos / 3) || x.gridPos - y.gridPos);
    for (const u of units) drawUnit(ctx, u, now, m, pv, markers);
    for (const u of units) drawUnitHud(ctx, u, m, pv, markers);
    drawPredictMarkers(ctx, markers);
    for (const u of units) drawTurnIndicator(ctx, u);
    drawActionArrows(ctx, now);
    drawPops(ctx, now);
    drawHud(ctx, now, m, pv, markers);
    drawTopInfo(ctx);
    if (S.result) drawResult(ctx, S.result);
    if (SCENE.status && now < SCENE.statusUntil) text(ctx, SCENE.status, 24, H - 24, { size: 22, color: '#ffd86e' });
  }
  function drawIdle(ctx) {
    text(ctx, '배치 창에서 아군·적을 정하고 행동 개시(또는 오른쪽 창의 전투 시작)를 누르세요', W / 2, H / 2, { size: 30, align: 'center', color: '#dfe7f0' });
    for (let p = 0; p < 9; p++) { for (const team of [1, 0]) { const c = cellPos(team, p); drawCellMark(ctx, c, team === 1 ? 'rgba(90,200,120,.5)' : 'rgba(230,90,90,.5)'); text(ctx, String(p + 1), c.x, c.y - 10, { size: 18, align: 'center', color: '#fff' }); } }
  }
  function drawCellMark(ctx, c, color, strong) {
    const rx = 46 * c.f, ry = 16 * c.f;
    ctx.save(); ctx.beginPath(); ctx.ellipse(c.x, c.y, rx, ry, 0, 0, Math.PI * 2); ctx.strokeStyle = color; ctx.lineWidth = strong ? 4 : 2; ctx.stroke();
    if (strong) { ctx.fillStyle = color.replace(/[\d.]+\)$/, '.18)'); ctx.fill(); } ctx.restore();
  }
  function drawCells(ctx, m, pv) {
    const b = C.S.battle;
    // 이동 후보 / 범위형 스킬 기준 칸 후보
    if (m && m.mode === 'move' && m.cands) for (const p of m.cands.cells) { const c = cellPos(1, p); drawCellMark(ctx, c, 'rgba(120,230,140,.9)', true); hit(c.x - 46 * c.f, c.y - 16 * c.f, 92 * c.f, 32 * c.f, 'cell', { team: 1, pos: p }); }
    if (m && m.mode === 'skill' && m.cands && m.cands.kind === 'cell' && m.cands.fixed === null && !m.sel) for (const p of m.cands.cells) { const c = cellPos(m.cands.side, p); drawCellMark(ctx, c, 'rgba(255,120,80,.9)', true); hit(c.x - 46 * c.f, c.y - 16 * c.f, 92 * c.f, 32 * c.f, 'cell', { team: m.cands.side, pos: p }); }
    if (m && m.sel && m.sel.skillKey === C.MOVE) { const c = cellPos(1, m.sel.targetGridPos); drawCellMark(ctx, c, 'rgba(120,230,140,1)', true); const im = faceImg(m.unit); if (im) circleClip(ctx, im, c.x, c.y - 40 * c.f, 60 * c.f); text(ctx, '이동', c.x, c.y + 20 * c.f, { size: 16, align: 'center', color: '#8ce62e' }); }
    // 미리보기 범위 칸(격자 배율)
    if (pv && C.sysOn('preview')) {
      for (const r of pv.targets) { if (r.dmgN === undefined && !r.ally) continue; const c = unitPos(r.unit); drawCellMark(ctx, c, r.ally ? 'rgba(120,200,255,.8)' : 'rgba(255,170,60,.9)', true); if (r.gridRate) text(ctx, Math.round(r.gridRate * 100) + '%', c.x, c.y + 24 * c.f, { size: 16, align: 'center', color: '#ffd86e' }); }
      if (pv.gridPos !== undefined && pv.gridPos !== 255 && (pv.tt === TT.ENEMY_GRID || pv.tt === TT.OUR_GRID)) { const side = pv.tt === TT.ENEMY_GRID ? (C.isMob(pv.actor) ? 1 : 0) : (C.isMob(pv.actor) ? 0 : 1); const c = cellPos(side, pv.gridPos); drawCellMark(ctx, c, 'rgba(255,230,120,1)', true); }
    }
    // 수동 선택 중 후보 유닛 칸
    if (m && m.mode === 'skill' && m.cands && m.cands.kind === 'unit' && !m.sel) for (const t of m.cands.units) { const c = unitPos(t); drawCellMark(ctx, c, 'rgba(255,90,70,.9)', true); }
    // 행동 중 유닛 칸
    const act = C.S.pending && C.S.pending.unit; if (act && b) { const c = unitPos(act); drawCellMark(ctx, c, 'rgba(255,255,255,.9)', true); }
  }
  function drawUnit(ctx, u, now, m, pv, markers) {
    if (u.hp <= 0 && u._deathVisualDone) return;
    const bx = unitBox(u), p = bx.p, dead = u.hp <= 0;
    const an = C.S.anims.get(u.aid) || {};
    let drawn = false;
    if (C.sysOn('sd') && window.SDL && SDL.ok) {
      const k = (UNIT_H * p.f) / 110; // 칸 안 사람형 110px → 화면 유닛 높이
      drawn = SDL.drawTo(ctx, u, p.x, p.y, k, dead && an.name !== 'die' ? 0.35 : 1);
    }
    if (!drawn) { // 리그 없음: 실루엣 + 이름표
      const im = faceImg(u);
      ctx.save(); ctx.globalAlpha = dead ? 0.35 : 1;
      ctx.fillStyle = u.team === 1 ? 'rgba(80,160,110,.55)' : 'rgba(170,70,70,.55)'; ctx.beginPath(); ctx.roundRect(bx.x + bx.w * 0.2, bx.y + bx.h * 0.15, bx.w * 0.6, bx.h * 0.85, 12); ctx.fill();
      if (im) circleClip(ctx, im, p.x, bx.y + bx.h * 0.35, 90 * p.f); else text(ctx, C.unitName(u), p.x, bx.y + bx.h * 0.5, { size: 18 * p.f, align: 'center' });
      ctx.restore();
    }
    hit(bx.x, bx.y, bx.w, bx.h, 'unit', u);
  }
  function drawUnitHud(ctx, u, m, pv, markers) {
    const bx = unitBox(u), p = bx.p, dead = u.hp <= 0, S = C.S;
    const hud = C.sysOn('hud');
    if (hud && !dead) drawCreatureInfo(ctx, u, m, pv, !!(m && m.sel && m.sel.targetAid === u.aid));
    if (false) {
      const bw = 96 * p.f, bh = 8 * p.f, x = p.x - bw / 2, y = p.y + 8 * p.f;
      ctx.fillStyle = 'rgba(0,0,0,.72)'; ctx.fillRect(x - 1, y - 1, bw + 2, bh + 2);
      const hpv = shownHp(u, performance.now(), SCENE.dt || 0);
      ctx.fillStyle = u.team === 1 ? '#19c05a' : '#ff1a1a'; ctx.fillRect(x, y, bw * Math.max(0, Math.min(1, hpv / u.maxHp)), bh);
      if (pv && C.sysOn('preview')) { const r = pv.targets.find((t) => t.unit === u && t.dmgN !== undefined); if (r) { const left = Math.max(0, u.hp - r.dmgN); ctx.fillStyle = 'rgba(255,255,255,.75)'; ctx.fillRect(x + bw * (left / u.maxHp), y, bw * ((u.hp - left) / u.maxHp), bh); } }
      if (C.optOn('hud', 'names')) text(ctx, `Lv.${u.level} ${C.unitName(u)}`, p.x, y + bh + 12 * p.f, { size: 15 * p.f, align: 'center', color: '#fff' });
      // 효과 아이콘(최대 5개)
      const icons = (u.buffs || []).filter((b) => !b.isItem).slice(0, 5);
      icons.forEach((bf, i) => { const ic = (C.ICONS.buff[bf.key] || [])[0]; const im = ic ? sprite(ic) : null; if (im) ctx.drawImage(im, x + i * 22 * p.f, y - 26 * p.f, 20 * p.f, 20 * p.f); });
    }
    // 후보·선택 표시 (UI_Battle_main_Field_cursor_r / selectIcon)
    const isCand = !dead && m && !m.sel && m.mode === 'skill' && m.cands && m.cands.kind === 'unit' && m.cands.units.includes(u);
    const isSel = !dead && m && m.sel && m.sel.targetAid === u.aid;
    if (isCand || isSel) {
      const g = u.team === 1 ? 'g' : 'r'; const im = sprite('UI_Battle_Main_Field_Frame_selectIcon_' + g), ol = sprite('UI_Battle_Main_Field_Frame_selectIcon_outline_' + g);
      // 원본 프리팹의 조각 위치와 회전을 한 그룹으로 유지한다.
      // 화면 좌표는 아래가 양수이므로 원본의 세로 위치와 회전 부호를 뒤집는다.
      const pieces = [[32.4, -13.3, 0], [-3.4, 41.5, 120], [-32.6, -16.2, 240]];
      const scale = 0.85 * p.f * (isSel ? 1.06 : 1);
      ctx.save(); ctx.translate(p.x, bx.y + bx.h * 0.55); ctx.scale(scale, scale);
      ctx.rotate(-SCENE.t * 0.6);
      for (const [x, y, angle] of pieces) {
        ctx.save(); ctx.translate(x, -y); ctx.rotate(-angle * Math.PI / 180);
        if (im) ctx.drawImage(im, -36, -58, 72, 116);
        if (ol) { ctx.globalCompositeOperation = 'lighter'; ctx.globalAlpha = isSel ? 0.95 : 0.65; ctx.drawImage(ol, -36, -58, 72, 116); }
        ctx.restore();
      }
      ctx.restore();
    }
    if (false) { // (UICreatureInfo 프리팹으로 대체)
      const w = 190 * 1, x = p.x - w / 2, y = bx.y - 62;
      drawSliced(ctx, 'UI_Battle_Main_Field_Frame_mini', x, y, w, 20, { color: '#9c9c9c' });
      text(ctx, 'Lv.', x + 6, y + 10, { size: 13, color: '#ffd400' }); text(ctx, String(u.level), x + 28, y + 10, { size: 13, color: '#ffd100' }); text(ctx, C.unitName(u), x + 54, y + 10, { size: 13 });
      const r0 = pv && pv.targets.find((t) => t.unit === u && t.dmgN !== undefined); const dmg = r0 ? (C.optOn('preview', 'exact') ? r0.dmgN : r0.clientDmg) : 0;
      ctx.fillStyle = '#000'; ctx.fillRect(x + 4, y + 24, w - 8, 10); ctx.fillStyle = '#ff0303'; ctx.fillRect(x + 6, y + 25, (w - 12) * Math.max(0, Math.min(1, u.hp / u.maxHp)), 8);
      if (dmg) { ctx.fillStyle = 'rgba(255,255,255,.8)'; const left = Math.max(0, u.hp - dmg); ctx.fillRect(x + 6 + (w - 12) * (left / u.maxHp), y + 25, (w - 12) * ((u.hp - left) / u.maxHp), 8); if (left <= 0) { ctx.fillStyle = '#ffb000'; ctx.fillRect(x + 6, y + 23, 4, 12); } }
      text(ctx, 'HP', x + 6, y + 44, { size: 12 }); text(ctx, `${Math.max(0, Math.round(u.hp)).toLocaleString()} / ${Math.round(u.maxHp).toLocaleString()}`, x + 32, y + 44, { size: 12 });
      if (r0) { const hx = p.x, hy = y - 28; ctx.fillStyle = 'rgba(0,0,0,.55)'; ctx.beginPath(); ctx.moveTo(hx - 70, hy - 18); ctx.lineTo(hx + 70, hy - 18); ctx.lineTo(hx + 56, hy + 18); ctx.lineTo(hx - 56, hy + 18); ctx.closePath(); ctx.fill(); text(ctx, '예상', hx - 44, hy - 2, { size: 16 }); text(ctx, Math.round(r0.hit * 100) + '%', hx + 30, hy, { size: 30, align: 'center' }); }
    }
    const hov = m && m.hover && m.hover.targetAid === u.aid; if (hov) { ctx.save(); ctx.strokeStyle = 'rgba(255,220,120,.9)'; ctx.lineWidth = 3; ctx.strokeRect(bx.x, bx.y, bx.w, bx.h); ctx.restore(); }
    // 원본 이미지는 이미 아래를 향한다. 원근 배율에 맞춰 머리 위에 표시한다.
    // 대기 표시(원작 WaitLb)
    const la = S.lastAction; if (la && la.rec.kind === 'wait' && la.actor === u && performance.now() - la.t0 < 1200) text(ctx, '대기', p.x, bx.y + bx.h * 0.4, { size: 35, align: 'center' });
    // 사망: 피해 반영 시점까지 살아 있는 모습으로 두었다가 쓰러진다
    void dead;
  }
  // 적 행동 예측 표식 (EnemyPredict.DrawEnemyPrediction): 대상 아군 머리 위 "예상 적이름 → 스킬명"
  function drawTurnIndicator(ctx, u) {
    const S = C.S, bx = unitBox(u), p = bx.p, dead = u.hp <= 0;
    const actingNow = S.pending ? S.pending.unit : S.lastAction && performance.now() < S.lastAction.t0 + S.lastAction.animDur * 1000 ? S.lastAction.actor : null;
    if (!dead && actingNow === u) {
      {
        const scale = p.f, w = 64 * scale, h = 34 * scale;
        const bob = Math.sin(SCENE.t * 4) * 4 * scale;
        const x = p.x - w / 2, y = bx.y - 16 * scale - h + bob;
        ctx.save();
        ctx.shadowColor = '#ffb800'; ctx.shadowBlur = (8 + Math.sin(SCENE.t * 4) * 3) * scale;
        ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + w, y); ctx.lineTo(x + w / 2, y + h); ctx.closePath();
        ctx.fillStyle = '#ffcf24'; ctx.fill();
        ctx.shadowBlur = 0; ctx.lineJoin = 'round'; ctx.lineWidth = 4 * scale; ctx.strokeStyle = '#29200b'; ctx.stroke();
        const badgeW = 96 * scale, badgeH = 29 * scale;
        roundPath(ctx, p.x - badgeW / 2, y - badgeH - 7 * scale, badgeW, badgeH, 6 * scale);
        ctx.fillStyle = 'rgba(25,20,8,0.96)'; ctx.fill(); ctx.lineWidth = 2 * scale; ctx.strokeStyle = '#ffcf24'; ctx.stroke();
        text(ctx, '현재 턴', p.x, y - badgeH / 2 - 7 * scale, { size: 22 * scale, align: 'center', color: '#ffdf62', outline: false });
        ctx.restore();
      }
    }
  }
  function drawPredictMarkers(ctx, markers) {
    const stack = new Map();
    for (const mk of markers) {
      let follow, textS;
      const sname = mk.skill ? C.skillName(mk.skill.key) : mk.isMove ? '이동' : '대기';
      if (mk.target && mk.target.hp > 0) { follow = unitBox(mk.target); textS = ['예상', mk.enemy.name, '→', sname]; }
      else if (mk.targetGridPos !== 255) { const c = cellPos(1, mk.targetGridPos); follow = { x: c.x - 40, y: c.y - 120, w: 80, h: 120 }; textS = ['예상', mk.enemy.name, '→', sname]; }
      else { follow = unitBox(mk.enemy); textS = ['예상', mk.isWait ? '대기' : mk.isMove ? '이동' : sname]; }
      const key = follow.x + ',' + follow.y; const n = stack.get(key) || 0; stack.set(key, n + 1);
      const cx = follow.x + follow.w / 2, cy = Math.max(200 + 34 * n, follow.y - 22 - 34 * n); // 턴 순서 바(위 180px) 아래로
      ctx.save(); ctx.font = '700 19px "Noto Sans KR", sans-serif';
      const parts = textS.map((s, i) => ({ s, w: ctx.measureText(s).width, color: i === 0 ? '#ffd86e' : s === '→' ? '#ff8a80' : '#fff' }));
      const tw = parts.reduce((a, p) => a + p.w, 0) + (parts.length - 1) * 14; const w = Math.max(120, tw + 20), h = 30;
      ctx.fillStyle = mk.isMove || mk.isWait ? 'rgba(20,51,102,.85)' : 'rgba(115,13,13,.85)'; ctx.beginPath(); ctx.roundRect(cx - w / 2, cy - h / 2, w, h, 4); ctx.fill();
      let x = cx - tw / 2; for (const p of parts) { text(ctx, p.s, x, cy, { size: 19, color: p.color }); x += p.w + 14; }
      ctx.restore();
    }
  }
  function drawPops(ctx, now) {
    SCENE.pops = SCENE.pops.filter((p) => now - p.t0 < 1000);
    for (const p of SCENE.pops) { const u = C.byAid(p.aid); if (!u) continue; const bx = unitBox(u); const k = (now - p.t0) / 1000; const y = bx.y + bx.h * 0.45 - k * 60 + p.dy; const a = k < 0.2 ? k / 0.2 : 1 - (k - 0.2) / 0.8; text(ctx, p.text, bx.p.x, y, { size: p.cls === 'crit' ? 40 : p.cls === 'miss' ? 26 : 32, align: 'center', color: p.cls === 'heal' ? '#8ce62e' : p.cls === 'crit' ? '#ffb22e' : p.cls === 'miss' ? '#cfd8e3' : '#ff6e5a', outlineColor: `rgba(0,0,0,${0.8 * a})`, lw: 5 }); }
  }
  // 턴 순서 바 (wrapper/sprTurnBar + UIBattleCreature)
  // =====================================================================================================
  //  원작 프리팹 UI: Panel_StageBattle / UIBattleCreature / UICreatureInfo 의 위젯 배치를 그대로 그린다 (sandbox-ui.js)
  // =====================================================================================================
  // 행동력 트랙 상수: UIBattleCreature.cs AP_TRACK_LEFT_X -920 / RIGHT_X -15 / ALLY_Y 150 / ENEMY_Y 50 / FIRST_Y 100, _apWinnerScale 0.85,
  //  Panel_StageBattle._turnApSlotSpacing 102, _apWinnerSlotExtraSpacing 14, _turnApWaveEntryDuration 0.7, _turnApWaveEntryInterval 0.1, UIConstants.Scale65
  //  칸은 UI_BattleCreatureScroll/ScrollView(화면 왼쪽 아래 고정) 기준이고, ScrollView 패널의 잘림 영역(중심 -555,155 크기 1150x310) 밖은 그리지 않는다.
  const AP_TRACK = { LEFT_X: -920, RIGHT_X: -15, ALLY_Y: 150, ENEMY_Y: 50, FIRST_Y: 100, SLOT: 102, WINNER_GAP: 14, SCALE: 0.65, WINNER_SCALE: 0.85, WAVE_ENTRY: 0.7, WAVE_INTERVAL: 0.1, CLIP: [-555, 155, 1150, 310] };
  function hitFromUi(o, rect, kind) { hit(rect.x, rect.y, rect.w, rect.h, kind.kind || kind, kind.data); }
  // 오른쪽 아래 스킬 패널 — 라이브 전투 화면(2400x1200 캡처)에서 잰 배치를 설계 좌표(1080 기준)로 환산해 화면 오른쪽 아래에 붙인다.
  //  패널 바탕(사다리꼴) → 헤더 띠("스킬명 : …", 속성 아이콘) → 오른쪽 버프 띠 → "AP n" → 버튼 4개(원형 아이콘 + AP 배지 + 3x3 범위 격자)
  const SKP = { pitch: 122.4, grid0: -513, circleDx: -18, circleY: -166, circleR: 41, ringR: 36, iconD: 70, boxW: 76, boxBottom: -14, badgeY: -113, badgeW: 68, badgeH: 25, cell: 18, cellPitch: 21.6, gridTopY: -83 };
  function roundPath(ctx, x, y, w, h, r) { ctx.beginPath(); ctx.roundRect(x, y, w, h, r); }
  function drawSkillPanel(ctx, now, m, who) {
    const R = W, B = H, S = C.S, u = S.pending && S.pending.unit;
    ctx.save();
    // 바탕
    ctx.beginPath(); ctx.moveTo(R - 612, B - 288); ctx.lineTo(R, B - 288); ctx.lineTo(R, B); ctx.lineTo(R - 693, B); ctx.closePath();
    ctx.fillStyle = 'rgba(30,36,46,0.74)'; ctx.fill();
    ctx.strokeStyle = 'rgba(120,130,145,0.35)'; ctx.lineWidth = 2; ctx.stroke();
    // 헤더 띠 (왼쪽 끝 사선) + 속성 아이콘 + 글자
    const curSk = m && m.skill;
    ctx.beginPath(); ctx.moveTo(R - 616, B - 279); ctx.lineTo(R - 345, B - 279); ctx.lineTo(R - 330, B - 236); ctx.lineTo(R - 639, B - 236); ctx.closePath();
    ctx.fillStyle = 'rgba(206,211,218,0.88)'; ctx.fill();
    const attr = curSk ? (['UI_Battle_Atktype_normal', 'UI_Battle_Atktype_fire', 'UI_Battle_Atktype_ice', 'UI_Battle_Atktype_electric'][num(curSk.levelTable, 'MagicSkillAttrType')] || 'UI_Battle_Atktype_normal') : 'UI_Battle_Atktype_normal';
    const at = sprite(attr); if (at) ctx.drawImage(at, R - 623, B - 278, 40, 40);
    const head = m ? (curSk ? `스킬명 : ${C.skillName(curSk.key)}` : m.mode === 'move' ? '이동' : m.mode === 'wait' ? '대기' : '전술 정보') : (u ? `${C.unitName(u)} 행동 중` : '전술 정보');
    text(ctx, head, R - 576, B - 257, { size: 27, color: '#2a2e36', outline: false });
    // 오른쪽 버프 띠 (스킬 효과 아이콘)
    ctx.beginPath(); ctx.moveTo(R - 333, B - 261); ctx.lineTo(R, B - 261); ctx.lineTo(R, B - 219); ctx.lineTo(R - 318, B - 219); ctx.closePath();
    ctx.fillStyle = 'rgba(170,178,190,0.80)'; ctx.fill();
    const effs = curSk && who ? C.effectsOf(who, curSk).filter((e) => e.icon).slice(0, 5) : [];
    effs.forEach((e, i) => { const im = sprite(e.icon); if (im) ctx.drawImage(im, R - 290 + i * 40, B - 257, 34, 34); });
    // 총 행동력 "AP n" (행동 중인 유닛의 행동력 게이지)
    // 버튼 4개
    const skills = who ? C.activeSkills(who) : [];
    const s1 = skills.find((s) => C.slotOf(s) === 1), s2 = skills.find((s) => C.slotOf(s) === 2);
    const btns = [['skill', s1], ['skill', s2], ['move', null], ['wait', null]];
    const enabled = !!m;
    btns.forEach(([kind, sk], k) => {
      const gx = R + SKP.grid0 + k * SKP.pitch, cx = gx + SKP.circleDx, cy = B + SKP.circleY;
      const sel = m && ((kind === 'skill' && sk && m.skill === sk) || (kind === 'move' && m.mode === 'move') || (kind === 'wait' && m.mode === 'wait'));
      const cd = kind === 'skill' && sk && sk.cooldownLeft > 0;
      const usable = enabled && !cd && (kind !== 'skill' || !!sk) && !(kind === 'move' && S.pending && S.pending.turn && S.pending.turn.isMoveFollowup);
      const icon = kind === 'skill' ? (sk ? skillImg(C.skillIcon(sk.key)) : null) : skillImg(kind === 'move' ? 'SkillIconCircle_Move' : 'SkillIconCircle_Wait');
      ctx.save(); ctx.globalAlpha = usable ? 1 : 0.5;
      // 아래 상자 (선택 시 금색 발광)
      const bx = gx - SKP.boxW / 2, by = cy, bh = (B + SKP.boxBottom) - by;
      if (sel) { ctx.shadowColor = 'rgba(255,190,70,0.9)'; ctx.shadowBlur = 28; }
      roundPath(ctx, bx, by, SKP.boxW, bh, 12); ctx.fillStyle = sel ? 'rgba(232,160,44,0.92)' : 'rgba(26,28,34,0.9)'; ctx.fill(); ctx.shadowBlur = 0;
      ctx.strokeStyle = sel ? 'rgba(255,220,120,0.9)' : 'rgba(90,95,105,0.8)'; ctx.lineWidth = 2; ctx.stroke();
      // 원형 아이콘
      ctx.beginPath(); ctx.arc(cx, cy, SKP.circleR, 0, Math.PI * 2); ctx.fillStyle = sel ? '#e9a62e' : '#101216'; ctx.fill();
      if (icon) circleClip(ctx, icon, cx, cy, SKP.iconD); else { ctx.fillStyle = '#2a2d35'; ctx.beginPath(); ctx.arc(cx, cy, SKP.iconD / 2, 0, Math.PI * 2); ctx.fill(); }
      ctx.beginPath(); ctx.arc(cx, cy, SKP.ringR, 0, Math.PI * 2); ctx.strokeStyle = sel ? '#fff1b0' : '#e8b830'; ctx.lineWidth = 3; ctx.stroke();
      ctx.beginPath(); ctx.arc(cx, cy, SKP.circleR - 1, -Math.PI * 0.62, Math.PI * 0.12); ctx.strokeStyle = 'rgba(255,244,210,0.95)'; ctx.lineWidth = 3; ctx.stroke();
      if (sel) { ctx.beginPath(); ctx.arc(cx, cy, SKP.circleR + 4, 0, Math.PI * 2); ctx.strokeStyle = 'rgba(255,200,80,0.7)'; ctx.lineWidth = 4; ctx.stroke(); }
      // 쿨다운 배지
      if (cd) { ctx.beginPath(); ctx.arc(cx + 45, cy + 27, 13, 0, Math.PI * 2); ctx.fillStyle = '#15171c'; ctx.fill(); ctx.strokeStyle = '#e8b830'; ctx.lineWidth = 2; ctx.stroke(); text(ctx, String(sk.cooldownLeft), cx + 45, cy + 28, { size: 18, align: 'center', outline: false }); }
      // AP 배지 / Move / Wait
      const bcx = gx + 16, bcy = B + SKP.badgeY;
      roundPath(ctx, bcx - SKP.badgeW / 2, bcy - SKP.badgeH / 2, SKP.badgeW, SKP.badgeH, 12); ctx.fillStyle = 'rgba(14,15,19,0.95)'; ctx.fill(); ctx.strokeStyle = 'rgba(200,170,90,0.9)'; ctx.lineWidth = 1.5; ctx.stroke();
      if (kind === 'skill' && C.sysOn('skillApReturn')) { const ap = sk ? num(sk.levelTable, 'NeedActionPoint') : 0; const w1 = text(ctx, 'AP', bcx - 24, bcy + 1, { size: 19, color: '#5ec8f0', outline: false }); text(ctx, `-${ap}`, bcx - 24 + w1 + 4, bcy + 1, { size: 23, color: '#fff', outline: false }); }
      else if (kind === 'skill') text(ctx, `Skill${k + 1}`, bcx, bcy + 1, { size: 21, align: 'center', color: '#fff', outline: false });
      else text(ctx, kind === 'move' ? 'Move' : 'Wait', bcx, bcy + 1, { size: 23, align: 'center', color: '#fff', outline: false });
      // 3x3 범위 격자
      let on = [];
      if (kind === 'skill' && sk) { const gd = L.combat.gridData(L.T('Table_Grid', str(sk.levelTable, 'GridIndex'))); on = gd.filter((g) => g.persent).map((g) => g.pos - 1); }
      else if (kind === 'move' && who && S.battle) on = L.ai.emptyGridPosList(S.battle, who).slice();
      else if (kind === 'wait' && who) on = [who.gridPos];
      for (let i = 0; i < 9; i++) { const c = i % 3, r = Math.floor(i / 3); const x = gx + (c - 1) * SKP.cellPitch - SKP.cell / 2, y = B + SKP.gridTopY + r * SKP.cellPitch - SKP.cell / 2; ctx.fillStyle = on.includes(i) ? '#f5c518' : (sel ? 'rgba(120,80,20,0.7)' : 'rgba(62,66,74,0.95)'); ctx.fillRect(x, y, SKP.cell, SKP.cell); }
      ctx.restore();
      if (usable || (kind === 'skill' && sk)) hit(gx - 50, cy - 48, 100, (B + SKP.boxBottom) - (cy - 48), kind, sk);
    });
    ctx.restore();
  }
  function drawHud(ctx, now, m, pv, markers) {
    const lay = UI.layout('battle'); if (!lay.length) return;
    const S = C.S, b = S.battle, u = S.pending && S.pending.unit;
    const ov = {};
    ov['UI_penel_rightTop/btnScreen'] = { active: false };
    ov['UI_penel_rightTop/btnAnomaly'] = { active: false };
    ov['btnBattleLog/Label (1)'] = { text: '기록' };
    // 실행 중 쓰지 않거나 숨겨 두는 것들(원작 코드가 끄거나 화면 밖에 두는 것)
    for (const k of ['Panel_StageBattle/lblScreenRound', 'UICreatureTooltip', 'Panel_StageBattle/lblBtnT', 'lblCenterDesc', 'targetCutIn', 'targetCut_ori', 'CutIn1', 'CutIn2', 'CutIn3', 'Panel_StageBattle/GameObject', 'btnStepBytStep', 'player_squad', 'UI_penel_bottom/skill_penel', 'round_label_main', 'delayWrapper', 'skill_icon_frame (2)', 'skill_icon_frame (3)', 'tactic_viewer', 'speed_control', 'btnBattleLog/bg']) ov[k] = { active: false };
    // 오른쪽 위: 자동 전투 토글 (BattleAutoActive / BattleAutoLock), LOG
    const auto = C.isAuto();
    ov['battleAuto/BattleAutoActive'] = { active: auto, hit: 'auto' }; ov['battleAuto/BattleAutoLock'] = { active: !auto, hit: 'auto' };
    ov['BattleAutoActive/BgSp'] = { hit: 'auto' }; ov['BattleAutoLock/BgSp'] = { hit: 'auto' };
    ov['UI_penel_rightTop/btnBattleLog'] = { hit: 'log' };
    // 행동 개시 (이동·대기 확정 시에만 켜짐: UpdateCurrentRoundPlayButton)
    const moveConfirm = !!(m && m.sel && m.mode === 'move' && C.sysOn('moveConfirm'));
    const canPlay = !b || !!S.result || !!(m && m.sel && m.needPlay && !moveConfirm);
    ov['UI_penel_right/play_btn_Eye guidance/play_btn_root'] = { active: canPlay }; // 실행할 행동(이동·대기 확정)이 있을 때만 표시
    ov['play_btn_root/play_btn'] = { hit: canPlay ? (!b || S.result ? 'restart' : 'play') : null };
    ov['play_btn_root/play_btn label'] = { text: !b ? '전투 시작' : S.result ? '다시 시작' : '행동 개시' };
    ov['play_btn_Eye guidance/play_btn_Eye guidance'] = { active: canPlay, alpha: 0.6 + 0.3 * Math.sin(now / 250) };
    ov['play_btn_Eye guidance/play_btn_Eye guidance/play_btn_Eye guidance2'] = { active: canPlay, alpha: 0.35 + 0.25 * Math.sin(now / 250) };
    const who = m ? m.unit : u || (S.lastAction && S.lastAction.actor);
    // 승인 버튼 (UI_ATK_Confirm): 찍은 대상 머리 위(_skillconfirm)
    if (m && m.sel && (!m.needPlay || moveConfirm)) {
      const t = m.sel.targetAid ? C.byAid(m.sel.targetAid) : null;
      const bx = t ? unitBox(t) : unitBox(m.unit);
      const destination = moveConfirm ? cellPos(m.unit.team, m.sel.targetGridPos) : null;
      const headX = destination ? destination.x : bx.x + bx.w / 2, headY = destination ? destination.y : bx.y + 10;
      const root = UI.find('battle', 'Panel_StageBattle/UI_ATK_Confirm');
      const button = moveConfirm && UI.find('battle', 'UI_ATK_Confirm/UI_ATK_Confirm_BTN_BG');
      const rx = button ? (button.rect[0] + button.rect[2]) / 2 : root ? root.rect[0] : 344;
      const ry = button ? (button.rect[1] + button.rect[3]) / 2 : root ? root.rect[1] : 33;
      ov['Panel_StageBattle/UI_ATK_Confirm'] = { active: true, move: [headX - W / 2 - rx + (moveConfirm ? 0 : 60), (H / 2 - headY) - ry - (moveConfirm ? 0 : 40)] };
      ov['UI_ATK_Confirm/UI_ATK_Confirm_BTN_BG'] = { hit: 'confirm' };
      ov['UI_ATK_Confirm/Confirm_btn_Eye guidance'] = { active: true, alpha: 0.6 + 0.3 * Math.sin(now / 250) };
    } else ov['Panel_StageBattle/UI_ATK_Confirm'] = { active: false };
    UI.draw(ctx, lay, { W, H, ox: 0, oy: 0, scale: 1, ov, hit: hitFromUi });
    drawSkillPanel(ctx, now, m, who);
    drawTrack(ctx, now, markers);
    // 수동 대상 선택 중 미리보기 창 (SkillPreview: 승인 버튼 옆)
    if (m && m.sel && !m.needPlay && pv && C.sysOn('preview')) { const h = SCENE.hits.find((x) => x.kind === 'confirm'); if (h) drawPreviewPanel(ctx, pv, h.x + h.w / 2, h.y + h.h / 2, h.x + h.w / 2 > W * 0.62); }
  }
  // 행동력 트랙 (UIBattleCreature 들): Anchor 기준 좌표. 인게임과 같은 순서로 칸을 움직인다.
  //  라운드 시작 대기 → 진입(직전 칸 → 이전 행동력 위치) → 경주(행동력 비례 이동) → 유지 → 줄 세우기(1등 칸 비우고 우승자부터 자기 줄에)
  //  → 우승자는 두 줄 사이 공통 1등 칸으로(0.85 배율), 나머지는 행동력 순으로 한 칸씩 앞으로. 경주를 생략한 라운드는 줄 세우기부터.
  //  새로 생긴 칸(웨이브 시작·소환)은 왼쪽 화면 밖에서 진영별 대기 칸으로 입장한다. 예약(지연) 공격은 독립 행동력을 가진 칸으로 함께 선다.
  function drawTrack(ctx, now, markers) {
    const b = C.S.battle; if (!b) return;
    const anchor = UI.find('battle', 'UI_BattleCreatureScroll/ScrollView');
    const ax = anchor ? anchor.rect[0] : 183 - (1920 - W) / 2, ay = anchor ? anchor.rect[1] : -H / 2;
    const lay = UI.layout('tbar'); if (!lay.length) return;
    const S = C.S;
    if (SCENE.trackBattle !== b) { SCENE.trackBattle = b; SCENE.track = { pos: new Map(), enter: new Map(), winner: null, ruid: 0 }; }
    const T = SCENE.track;
    const easeInOut = (p) => (p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2), easeOut = (p) => 1 - (1 - p) * (1 - p);
    const clamp01 = (v) => Math.max(0, Math.min(1, v)), lerp = (p, q, k) => p + (q - p) * k;
    const mix = (p, q, k) => ({ x: lerp(p.x, q.x, k), y: lerp(p.y, q.y, k), s: lerp(p.s === undefined ? AP_TRACK.SCALE : p.s, q.s === undefined ? AP_TRACK.SCALE : q.s, k) });
    // GetApTrackSlotPosition: 공통 1등 칸(우승자 확대 폭만큼) 뒤로 102 간격. GetApTrackPosition: 왼쪽 끝 ~ 2등 칸을 행동력 0~100 으로
    const ratio = AP_TRACK.WINNER_SCALE / AP_TRACK.SCALE, winnerSlot = Math.max(1, ratio);
    const slotX = (i) => AP_TRACK.RIGHT_X - (Math.max(0, i) + winnerSlot) * AP_TRACK.SLOT - AP_TRACK.WINNER_GAP;
    const apX = (ap) => lerp(AP_TRACK.LEFT_X, slotX(0), clamp01(ap / 100));
    const trackY = (ally) => (ally ? AP_TRACK.ALLY_Y : AP_TRACK.ENEMY_Y);
    const faceWidget = UI.find('tbar', 'UIBattleCreature/TbarIcon'); const fr = faceWidget ? faceWidget.rect : [-120, 0, 0, 120];
    // GetFirstApTrackSlotPosition: 초상화의 오른쪽 경계와 세로 중심을 고정한 채 확대한다
    const firstPos = { x: AP_TRACK.RIGHT_X - fr[2] * AP_TRACK.SCALE * (ratio - 1), y: AP_TRACK.FIRST_Y - (fr[1] + fr[3]) / 2 * AP_TRACK.SCALE * (ratio - 1), s: AP_TRACK.WINNER_SCALE };
    const slotPos = (it, i) => ({ x: slotX(i), y: trackY(it.ally), s: AP_TRACK.SCALE });
    const apPos = (it, ap) => ({ x: apX(ap), y: trackY(it.ally), s: AP_TRACK.SCALE });

    // 트랙 항목: 살아 있는 유닛 + 독립 행동력을 가진 예약(지연) 공격 (AddReservedActionPointUI)
    const items = [];
    for (const u of b.units) if (C.alive(u)) items.push({ key: 'u' + u.aid, u, ally: C.isPC(u) || (u.type === 'SUMMON' && u.team === 1), pre: u.preTurnPos === undefined ? u.turnPos : u.preTurnPos, cur: u.turnPos });
    for (const r of b.reserveSkills || []) if (r.owner && C.alive(r.owner)) {
      if (!r._uid) r._uid = ++T.ruid;
      items.push({ key: 'r' + r._uid, u: r.owner, reserve: r, ally: C.isPC(r.owner) || r.owner.team === 1, pre: r.previousActionPoint || 0, cur: r.actionPoint || 0 });
    }
    const byKey = new Map(items.map((it) => [it.key, it]));
    const ranked = (wk) => items.filter((it) => it.key !== wk).sort((p, q) => (q.cur - p.cur) || (p.u.aid - q.u.aid)); // TurnValue 내림차순, Aid 보조
    // coArrangeApTrackSlots 1단계: 1등 칸을 비워 둔 채 우승자부터 자기 진영 칸에 줄 세움. 2단계: 우승자는 공통 1등 칸, 나머지는 한 칸 앞으로
    const lineupLayout = (wk) => { const w = byKey.get(wk), line = w ? [w].concat(ranked(wk)) : ranked(wk); const out = new Map(); line.forEach((it, i) => out.set(it.key, slotPos(it, i))); return out; };
    const finalLayout = (wk) => { const out = new Map(); ranked(wk).forEach((it, i) => out.set(it.key, slotPos(it, i))); if (byKey.has(wk)) out.set(wk, Object.assign({}, firstPos)); return out; };

    // 우승자(이번 행동권 주인): 행동 직전 멈춤(pending) 중이면 그 유닛. 멈춤이 없는 라운드는 지금 행동 중인 유닛
    const pend = S.pending, pt = pend && pend.turn;
    let winnerKey = pt ? (pt.isReserve && pt.reserve && pt.reserve._uid ? 'r' + pt.reserve._uid : pend.unit ? 'u' + pend.unit.aid : null) : null;
    const ph = apPhase(now), an = ph && ph.an;
    const stale = !an || (an.round !== b.round && ph.name === 'done');
    if (!winnerKey && stale) { const la = S.lastAction; if (la && la.actor && now < la.t0 + (la.animDur || 0) * 1000 && C.alive(la.actor)) winnerKey = 'u' + la.actor.aid; }
    if (winnerKey) T.winner = winnerKey;
    const wk = (an && an.winner) || winnerKey || T.winner;

    // 연출 시작 직전 칸 위치를 기억해 두고(진입 단계의 출발점), 새로 생긴 칸은 왼쪽 화면 밖에서 출발한다
    const idlePos = (it) => T.pos.get(it.key) || null;
    if (an && ph.name !== 'wait' && !an.start) { an.start = new Map(); for (const it of items) an.start.set(it.key, idlePos(it)); an.winner = wk; }
    const startOf = (it) => (an && an.start && an.start.get(it.key)) || idlePos(it) || { x: -2000, y: trackY(it.ally), s: AP_TRACK.SCALE };

    const placed = new Map();
    const animating = an && ph.name !== 'wait' && ph.name !== 'done';
    if (animating) {
      const racing = an.phases.some((p) => p.name === 'advance');
      const lineup = lineupLayout(wk), fin = finalLayout(wk);
      for (const it of items) {
        const st = startOf(it); let p;
        if (ph.name === 'entry') p = mix(st, apPos(it, it.pre), easeInOut(ph.p));
        else if (ph.name === 'advance') p = apPos(it, lerp(it.pre, it.cur, ph.p));
        else if (ph.name === 'hold') p = apPos(it, it.cur);
        else if (ph.name === 'lineup') p = mix(racing ? apPos(it, it.cur) : st, lineup.get(it.key), easeOut(ph.p));
        else p = mix(lineup.get(it.key), fin.get(it.key), easeOut(ph.p));
        placed.set(it.key, p); T.pos.set(it.key, p);
      }
    } else if (an && ph.name === 'done' && !stale) {
      const fin = finalLayout(wk);
      for (const it of items) { const p = fin.get(it.key); placed.set(it.key, p); T.pos.set(it.key, p); }
    } else {
      // 대기 중(라운드 시작 대기·행동 재생·연출 없는 라운드): 기억한 칸 위치 유지. 연출 없는 라운드가 바뀌었으면 최종 배치로 바로 정렬
      const fin = stale && (winnerKey || !an) ? finalLayout(wk) : null;
      let newN = 0;
      for (const it of items) {
        let p = T.pos.get(it.key);
        if (fin && (p || !T.enter.has(it.key))) p = fin.get(it.key);
        if (!p) { // PlayApTrackWaitingSlotEntry: 진영별 생성 순서 대기 칸으로 왼쪽 화면 밖에서 입장
          let en = T.enter.get(it.key);
          if (!en) {
            const idx = items.filter((o) => o.ally === it.ally && o !== it && (T.pos.has(o.key) || T.enter.has(o.key))).length;
            en = { t0: now + newN++ * AP_TRACK.WAVE_INTERVAL * C.timeScale() * 1000, dur: Math.max(1, AP_TRACK.WAVE_ENTRY * C.timeScale() * 1000), to: slotPos(it, idx) };
            T.enter.set(it.key, en);
          }
          const k = clamp01((now - en.t0) / en.dur);
          p = mix({ x: -2000, y: en.to.y, s: AP_TRACK.SCALE }, en.to, easeOut(k));
          if (k >= 1) { T.pos.set(it.key, en.to); T.enter.delete(it.key); }
        } else T.pos.set(it.key, p);
        placed.set(it.key, p);
      }
    }
    for (const k of Array.from(T.pos.keys())) if (!byKey.has(k)) { T.pos.delete(k); T.enter.delete(k); }

    const showSelect = wk && byKey.has(wk) && !animating; // Tbar_select: 연출이 끝난 뒤 우승자 칸에만
    const tags = {}; let tagN = 0;
    const order = items.slice().sort((p, q) => placed.get(p.key).x - placed.get(q.key).x); // 오른쪽 칸이 위에 그려지도록
    const [ccx, ccy, cw, ch] = AP_TRACK.CLIP;
    ctx.save(); ctx.beginPath(); ctx.rect(W / 2 + ax + ccx - cw / 2, H / 2 - ay - ccy - ch / 2, cw, ch); ctx.clip();
    for (const it of order) {
      const u = it.u, face = faceImg(u), p = placed.get(it.key);
      const tag = C.isMob(u) ? (tags[u.key] === undefined ? (tags[u.key] = String.fromCharCode(65 + tagN++)) : tags[u.key]) : '';
      const mk = !it.reserve && markers.find((x) => x.enemy === u);
      const ap = gaugeAp(it.pre, it.cur, ph);
      const ov = {
        'UIBattleCreature/TbarIcon': { texture: face, circle: true, fillStyle: face ? undefined : (it.ally ? '#2a4d3a' : '#4d2a2a'), hit: { kind: 'unit', data: u } },
        'TbarIcon/uiLable': { active: false }, 'TbarIcon/taget_label': { text: tag, active: !!tag },
        'TbarIcon/Tbar_select': { active: !!showSelect && it.key === wk },
        'TbarIcon/Tbar_outline': { color: it.ally ? [1, 0.7655, 0, 1] : [1, 0.35, 0.3, 1] },
        'TbarIcon/texDelaySkill': { active: !!it.reserve, texture: it.reserve ? skillImg(C.skillIcon(it.reserve.skillKey)) : null, circle: true },
        'TbarIcon/ActionBubble': { active: !!mk }, 'ActionBubble/ActionBubble_skillIcon': { active: !!mk, texture: mk ? skillImg(mk.icon) : null, circle: true },
        'ActionBubble/ActionBubble_disable': { active: false }, 'ActionBubble_disable/ActionBubble_disable (1)': { active: false },
        'TurnAp/Top': { active: false }, 'Bottom/Bg/spCur': { fill: clamp01(ap / 100) }, 'Bottom/Bg/spUse': { active: false },
        'TbarIcon/UI_Cha_select_icon_Enemy': { active: false }, 'TbarIcon/UI_Cha_select_icon_player2': { active: false }, 'TbarIcon/UI_ATK_Confirm': { active: false },
      };
      if (!C.optOn('hud', 'apBars')) ov['UIBattleCreature/TurnApEffect'] = { active: false };
      UI.draw(ctx, lay, { W, H, ox: ax + p.x, oy: ay + p.y, scale: p.s || AP_TRACK.SCALE, ov, hit: hitFromUi });
    }
    ctx.restore();
    const manual = S.manual;
    const winnerUnit = wk && byKey.has(wk) ? byKey.get(wk).u : null;
    if (C.sysOn('skillReturnPreview') && C.sysOn('skillApReturn') && manual && manual.mode === 'skill' && manual.skill && winnerUnit === manual.unit) {
      const cost = num(manual.skill.levelTable, 'NeedActionPoint');
      const percent = Math.max(0, Math.min(100, 100 - cost * 10));
      const returnX = apX(percent);
      const ally = C.isPC(manual.unit) || manual.unit.team === 1;
      const cx = W / 2 + ax + returnX + (fr[0] + fr[2]) / 2 * AP_TRACK.SCALE;
      const cy = H / 2 - ay - trackY(ally) - (fr[1] + fr[3]) / 2 * AP_TRACK.SCALE;
      const radius = Math.abs(fr[2] - fr[0]) * AP_TRACK.SCALE / 2;
      ctx.save();
      ctx.strokeStyle = '#7ddcff'; ctx.fillStyle = 'rgba(70,180,255,0.18)'; ctx.lineWidth = 3;
      ctx.setLineDash([7, 5]); ctx.beginPath(); ctx.arc(cx, cy, radius, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(cx, cy - radius - 8); ctx.lineTo(cx, cy + radius + 8); ctx.stroke();
      ctx.setLineDash([]);
      text(ctx, `재출발 ${percent}%`, Math.max(95, Math.min(W - 95, cx)), cy - radius - 22, { size: 21, align: 'center', color: '#7ddcff' });
      ctx.restore();
    }
  }
  // 유닛 정보 (UICreatureInfo): 발밑 체력 막대(LineView), 선택 시 상태 창(SelectState) + 예상 명중률(SelectTarget)
  function drawCreatureInfo(ctx, u, m, pv, selected) {
    const lay = UI.layout('cinfo'); if (!lay.length) return;
    const bx = unitBox(u), p = bx.p;
    const r = pv && pv.targets.find((t) => t.unit === u && t.dmgN !== undefined); const dmg = r ? (C.optOn('preview', 'exact') ? r.dmgN : r.clientDmg) : 0;
    const hpv = shownHp(u, performance.now(), SCENE.dt || 0);
    const ratio = Math.max(0, Math.min(1, hpv / u.maxHp)), left = Math.max(0, Math.min(1, (u.hp - dmg) / u.maxHp));
    const ov = {
      'Wrapper/LineView': { active: !selected }, 'Wrapper/SelectView': { active: !!selected }, 'Wrapper/WaitLb': { active: false }, 'Wrapper/BuffOverSp': { active: false },
      'LineView/CreatureTagLb': { text: u._tag || '' },
      'SliderLineHpInfo/SliderLineHpSp': { fill: ratio }, 'SliderLineHpInfo/SliderLineHpPreviewSp': { fill: dmg ? left : ratio, color: dmg ? [0.45, 0, 0, 1] : undefined },
      'SliderLineHpInfo/MarkDestroySp': { active: !!dmg && left <= 0 },
      'LineView/LineTarget': { active: false },
      'SelectState/SliderSelectHpSp': { fill: ratio }, 'SelectState/SliderSelectPreviewHpSp': { fill: dmg ? left : ratio, color: dmg ? [0.45, 0, 0, 1] : undefined }, 'SelectState/MarkDestroySp': { active: !!dmg && left <= 0 },
      'TextWrapper/CreatureNameLb': { text: C.unitName(u) }, 'TextWrapper/CreatureLvLb': { text: String(u.level) }, 'TextWrapper/CreatureHpLb': { text: `${Math.max(0, Math.round(u.hp)).toLocaleString()} / ${Math.round(u.maxHp).toLocaleString()}` },
      'SelectView/SelectTarget': { active: !!(selected && r) }, 'SelectTarget/HiRateLb': { text: r ? Math.round(r.hit * 100) + '%' : '' }, 'SelectTarget/DefLb': { active: false },
    };
    const sc = 0.9 * p.f;
    UI.draw(ctx, lay, { W, H, ox: p.x - W / 2 - 60 * sc, oy: (H / 2 - p.y) - 6 * sc, scale: sc, ov });
  }

  function drawPreviewPanel(ctx, pv, bx, by, placeLeft) {
    const PW = 400, PAD = 18;
    const lines = []; // [{type, ...}] 위에서 아래로
    const sk = pv.skill;
    const exact = C.optOn('preview', 'exact');
    const main = pv.main;
    const rows = [];
    rows.push({ kind: 'title', name: `${C.skillName(sk.key)}`, ap: `${num(sk.levelTable, 'NeedActionPoint')}${pv.cd ? `  재사용 ${pv.cd}턴` : ''}`, attr: num(sk.levelTable, 'MagicSkillAttrType') });
    const tname = pv.tt === TT.SELF ? `${C.unitName(pv.actor)} (자신)` : main ? C.unitName(main.unit) : pv.mainTarget ? C.unitName(pv.mainTarget) : (pv.gridPos !== undefined && pv.gridPos !== 255 ? `${pv.gridPos + 1}번 칸` : '');
    rows.push({ kind: 'target', text: tname });
    if (pv.summon) rows.push({ kind: 'stat', text: '소환 스킬: 피해 없음' });
    else if (pv.rate > 0) {
      if (main) {
        const dmg = exact ? main.dmgN : main.clientDmg;
        const left = Math.max(0, main.hp - dmg);
        rows.push({ kind: 'dmg', value: main.immune ? '무적 방어막' : dmg.toLocaleString() + (dmg >= main.hp && main.hp > 0 ? '  격파' : ''), immune: main.immune, hp: main.hp, maxHp: main.maxHp, left, bar: `${main.hp.toLocaleString()}  →  ${left.toLocaleString()}  (${main.maxHp ? Math.round(left * 100 / main.maxHp) : 0}%)` });
        rows.push({ kind: 'stat', parts: [['명중 ', '#b8c6d4'], [`${Math.round(main.hit * 100)}%`, main.hit >= 0.9 ? '#8ce62e' : main.hit >= 0.6 ? '#ffc14d' : '#ff6e5a'], ['     치명타 ', '#b8c6d4'], [`${Math.round(main.crit * 100)}%`, main.crit >= 0.5 ? '#8ce62e' : '#ffd86e'], [main.crit > 0 ? ' (1.5배)' : '', '#b8c6d4']] });
        const others = pv.targets.filter((r) => r !== main && !r.ally && r.dmgN !== undefined);
        if (others.length) rows.push({ kind: 'others', text: '함께 맞음  ' + others.map((r) => `${C.unitName(r.unit)} ${r.immune ? '무적' : (exact ? r.dmgN : r.clientDmg).toLocaleString()}`).join(' · ') });
        if (main.protects) rows.push({ kind: 'note', text: `${C.unitName(main.protects)} 대신 맞음(보호)` });
      } else rows.push({ kind: 'stat', text: '맞는 대상이 없습니다' });
    } else if (pv.tt !== TT.SELF) rows.push({ kind: 'stat', text: '피해 없음 · 효과만 적용' });
    for (const n of pv.notes) rows.push({ kind: 'note', text: n });
    if (pv.effects.length) { rows.push({ kind: 'etitle' }); for (const e of pv.effects.slice(0, 6)) rows.push({ kind: 'effect', e }); }
    // 높이 계산
    let h = PAD; const hs = rows.map((r) => (r.kind === 'title' ? 48 : r.kind === 'target' ? 32 : r.kind === 'dmg' ? 76 : r.kind === 'etitle' ? 28 : r.kind === 'effect' ? 42 : 30));
    h += hs.reduce((a, c) => a + c, 0) + PAD;
    const x = placeLeft ? bx - 104 - PW - 92 : bx + 104;
    let y = by - 60; if (y + h > H - 8) y = H - 8 - h; if (y < 8) y = 8;
    drawSliced(ctx, 'Bg_Dot_3', x, y, PW, h, { color: '#111111', alpha: 0.92 });
    drawSliced(ctx, 'Text_Board_RightGradation_1', x, y, PW, h, { color: '#07345a', alpha: 0.75 });
    drawSliced(ctx, 'Square-frame_2', x, y, PW, h);
    let cy = y + PAD;
    rows.forEach((r, i) => {
      const rh = hs[i], lx = x + PAD;
      if (r.kind === 'title') {
        const at = sprite(['UI_Battle_Atktype_normal', 'UI_Battle_Atktype_fire', 'UI_Battle_Atktype_ice', 'UI_Battle_Atktype_electric'][r.attr] || 'UI_Battle_Atktype_normal');
        if (at) ctx.drawImage(at, lx, cy, 36, 36);
        text(ctx, r.name, lx + 46, cy + 18, { size: 26, color: '#ffc01c' });
        text(ctx, 'AP ', x + PW - PAD - ctx.measureText(r.ap).width - 30, cy + 18, { size: 22, color: '#15e4ff' }); text(ctx, r.ap, x + PW - PAD, cy + 18, { size: 22, align: 'right' });
        ctx.fillStyle = 'rgba(255,255,255,.55)'; ctx.fillRect(lx, cy + 44, PW - PAD * 2, 2);
      } else if (r.kind === 'target') { text(ctx, '대상  ', lx, cy + 14, { size: 22, color: '#b8c6d4' }); text(ctx, r.text, lx + 60, cy + 14, { size: 22 }); }
      else if (r.kind === 'dmg') {
        text(ctx, '예상 피해', lx, cy + 18, { size: 20, color: '#b8c6d4' }); text(ctx, r.value, lx + 100, cy + 16, { size: 34, color: r.immune ? '#b8c6d4' : '#ff735a' });
        if (!r.immune && r.maxHp > 0) { const bw = PW - PAD * 2, bh = 18, byy = cy + 46; ctx.fillStyle = 'rgba(0,0,0,.85)'; ctx.fillRect(lx, byy, bw, bh); ctx.fillStyle = 'rgba(255,82,56,.95)'; ctx.fillRect(lx, byy, bw * Math.min(1, r.hp / r.maxHp), bh); ctx.fillStyle = 'rgb(140,229,0)'; ctx.fillRect(lx, byy, bw * Math.min(1, r.left / r.maxHp), bh); drawSliced(ctx, 'UI_Battle_gauge_outline_base', lx - 1, byy - 1, bw + 2, bh + 2); text(ctx, r.bar, lx + bw / 2, byy + bh / 2, { size: 15, align: 'center' }); }
      } else if (r.kind === 'stat') { if (r.parts) { let px2 = lx; for (const [s, col] of r.parts) { px2 += text(ctx, s, px2, cy + 14, { size: 22, color: col }); } } else text(ctx, r.text, lx, cy + 14, { size: 22, color: '#b8c6d4' }); }
      else if (r.kind === 'others' || r.kind === 'note') text(ctx, r.text, lx, cy + 14, { size: 17, color: r.kind === 'note' ? '#ffd86e' : '#b8c6d4' });
      else if (r.kind === 'etitle') text(ctx, '적용 효과', lx, cy + 14, { size: 19, color: '#b8c6d4' });
      else if (r.kind === 'effect') { const e = r.e; const ic = e.icon ? sprite(e.icon) : null; if (ic) ctx.drawImage(ic, lx, cy + 2, 36, 36); const tx = lx + (ic ? 46 : 0); const w1 = text(ctx, e.target, tx, cy + 18, { size: 19, color: e.debuff ? '#ff6e5a' : '#8ce62e' }); const tail = [e.rate > 0 && e.rate < 1 ? `확률 ${Math.round(e.rate * 100)}%` : '', e.turns > 0 ? `${e.turns}턴` : ''].filter(Boolean).join(', '); text(ctx, e.text.slice(0, 26) + (tail ? ` (${tail})` : ''), tx + w1 + 10, cy + 18, { size: 17 }); }
      cy += rh;
    });
  }
  function drawTopInfo(ctx) {
    const b = C.S.battle; if (!b) return;
    text(ctx, `웨이브 ${Math.min(b.waveIndex + 1, b.waves.length)}/${b.waves.length} · 행동 ${b.totalActions}`, 24, 30, { size: 20, color: '#dfe7f0' });
    const on = C.SYSTEMS.filter((s) => s.test && s.on).map((s) => s.name).join(' · ');
    if (on) text(ctx, '시험 중: ' + on, 24, H - 56, { size: 17, color: '#ffd86e' });
  }
  function drawResult(ctx, r) {
    ctx.fillStyle = 'rgba(0,0,0,.45)'; ctx.fillRect(0, H / 2 - 110, W, 220);
    text(ctx, C.OUT_KO[r.outcome] || r.outcome, W / 2, H / 2 - 20, { size: 90, align: 'center', color: r.outcome === 'win' ? '#ffd86e' : '#ff6e5a', lw: 8 });
    text(ctx, `총 행동 ${r.totalActions}회`, W / 2, H / 2 + 60, { size: 22, align: 'center', color: '#dfe7f0' });
  }
  window.SCENE = SCENE;
})();
