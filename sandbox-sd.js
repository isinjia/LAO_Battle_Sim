// =====================================================================
//  전투 시뮬레이터 SD 레이어 — 라켓몬스터(E:\LAO_MINI_GAME\6_LAO_Laket_Monster\js\sdfield.js) 방식
//  원작 컷아웃 리그 런타임(sd/sd.js, 라켓몬스터 것을 복사)으로 애니메이션한 SD를 화면 밖 WebGL 캔버스
//  한 장에 칸(슬롯)별로 렌더링한 뒤, 각 유닛 타일의 2D 캔버스에 복사한다.
//  three.js(CDN) 또는 리그 데이터가 없으면 타일은 이름표만 보여 준다(자동 대체).
//
//  리그 파일 위치: sd/chars (라켓몬스터 바이오로이드 206종), sd/mobs (디펜스 철충 23종) — 둘 다 폴더 연결(junction).
//  전투원 키 -> 리그 이름 대응: sd/charmap.js (SD_CHARMAP), 철충: MOB_MP_<이름>_<접미> -> e_<이름>_N
// =====================================================================
(function () {
  const SDL = {
    COLS: 6, ROWS: 4, CW: 150, CH: 172, R: 2, // 칸 폭: 옆으로 길게 뻗는 부스터·날개가 잘리지 않게
    ok: false, renderer: null, scene: null, camera: null, canvas: null,
    status: {}, frameSlots: [], failed: {},
    // three.js 를 비동기로 불러온다. 막혀 있으면 4초 뒤 포기(이름표 표시로 진행)
    loadThree() {
      if (this._three) return this._three;
      this._three = new Promise((res) => {
        if (typeof THREE !== 'undefined') return res(true);
        const s = document.createElement('script');
        s.src = 'https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js'; s.crossOrigin = 'anonymous'; s.async = true;
        let done = false;
        const fin = (ok) => { if (!done) { done = true; res(ok); } };
        s.onload = () => fin(typeof THREE !== 'undefined'); s.onerror = () => fin(false);
        setTimeout(() => fin(typeof THREE !== 'undefined'), 4000);
        document.head.appendChild(s);
      });
      return this._three;
    },
    async init() {
      if (this.ok) return true;
      if (!(await this.loadThree()) || !window.SD) return false;
      try {
        this.canvas = document.createElement('canvas');
        this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, alpha: true, antialias: true, premultipliedAlpha: true });
        this.renderer.setPixelRatio(1);
        this.renderer.setSize(this.COLS * this.CW * this.R, this.ROWS * this.CH * this.R, false);
        this.renderer.setClearColor(0x000000, 0);
        this.scene = new THREE.Scene();
        const w = this.COLS * this.CW, h = this.ROWS * this.CH;
        this.camera = new THREE.OrthographicCamera(0, w, h, 0, -1000, 1000);
        SD.renderer = this.renderer;
        SD.crossfade = 0.12;
        SD.texScale = 1;
        SD.dirs = (id) => (id.startsWith('e_') ? 'sd/mobs/' : 'sd/chars/');
        this.ok = true;
      } catch (e) { console.warn('SD 레이어 비활성', e); this.ok = false; }
      return this.ok;
    },
    // 유닛 -> 리그 이름 (없으면 null)
    rigOf(unit) {
      if (!unit) return null;
      if (unit.type === 'CHARACTER') return (window.SD_CHARMAP && SD_CHARMAP[unit.key]) || null;
      // 철충: MOB_MP_NightChick_TU2 -> e_NightChick_N (접미사가 달라도 모델은 같다)
      const m = /^MOB_MP_([A-Za-z0-9]+)_([A-Za-z0-9]+)$/.exec(unit.key || '');
      if (!m || !window.SD_MOBRIGS) return null;
      const stem = m[1];
      for (const cand of ['e_' + stem + '_N', 'e_' + stem + '_' + m[2], 'e_' + stem + '_EW']) if (SD_MOBRIGS.includes(cand)) return cand;
      return null;
    },
    // 리그 준비(비동기). 준비 전에는 false. 여러 리그를 동시에 디코드하지 않고 하나씩 준비한다(라켓몬스터와 같음)
    ready(key) {
      if (!this.ok || !key) return false;
      const st = this.status[key];
      if (st === 'ok') return true;
      if (!st) {
        this.status[key] = 'loading';
        this.queue = (this.queue || Promise.resolve()).then(() => SD.prepare(key)).then((t) => { this.status[key] = t ? 'ok' : 'fail'; if (!t) this.failed[key] = true; }, (e) => { console.warn('SD 준비 실패', key, e); this.status[key] = 'fail'; this.failed[key] = true; });
      }
      return false;
    },
    // 이번 프레임에 그릴 SD 목록을 받아 한 번에 렌더링한다. items: [{holder, key, anim, flip, h}]
    renderFrame(items, dt) {
      this.frameSlots = [];
      if (!this.ok || !items.length) return;
      const max = this.COLS * this.ROWS;
      const used = new Set(), slots = [];
      items.slice(0, max).forEach((it, i) => {
        let c = it.holder._sd;
        if (!c || c.tpl.id !== it.key) { if (c) { this.scene.remove(c.root); c.dispose && c.dispose(); } c = it.holder._sd = SD.create(it.key); if (!c) return; c.play('idle', null, true); c._anim = 'idle'; }
        if (it.anim && c._anim !== it.anim) {
          const name = c.has(it.anim) ? it.anim : 'idle';
          const loop = name === 'idle' || name === 'move';
          c._anim = it.anim;
          c.play(name, loop ? null : () => { c._anim = 'idle'; if (it.onEnd) it.onEnd(); }, loop);
        }
        // 사망 동작의 마지막 자세에서 멈춘다. 공용 실행기의 기본 동작은 종료 시 대기로 돌아간다.
        if (it.anim === 'die' && c.clipName === 'die') {
          const end = Math.max(0, c.clip.dur - 0.0001);
          c.time = Math.min(end, c.time + dt * c.speed);
          c.apply(); if (c.fadeD) { c.fadeT += dt; c.blend(); } c.render();
        } else c.update(dt);
        if (it.tint) c.setTint(it.tint[0], it.tint[1], it.tint[2]); else c.setTint(1, 1, 1);
        c.setOpacity(it.alpha == null ? 1 : it.alpha);
        // 리그 전체 높이가 아니라 공통 키 기준(사람형 ≈ 9)으로 맞춘다. 칸을 넘는 큰 리그만 줄인다
        const t = c.tpl, k = Math.min((it.h || 110) / 9, (this.CH - 8) / t.height);
        const col = i % this.COLS, row = Math.floor(i / this.COLS);
        const cx = col * this.CW + this.CW / 2, by = (this.ROWS - 1 - row) * this.CH + 6;
        c.root.scale.set(it.flip ? -k : k, k, 1);
        const mid = (t.box.min.x + t.box.max.x) / 2 * k;
        c.root.position.set(cx - (it.flip ? -mid : mid), by - t.box.min.y * k, 0);
        if (!c.root.parent) this.scene.add(c.root);
        c.root.visible = true;
        used.add(c); slots.push({ c, col, row });
        it.holder._sdSlot = { sx: col * this.CW * this.R, sy: row * this.CH * this.R, f: this.frameSlots.length };
        this.frameSlots.push(it.holder);
      });
      for (const o of this.scene.children) o.visible = false;
      for (const c of used) c.root.visible = true;
      // 가산(빛) 재질은 투명 캔버스에 그리면 뿌옇게 남으므로 두 번에 나눈다(라켓몬스터와 같음)
      const glow = [...used].some((c) => c.tpl.rends && c.tpl.rends.some((r) => r.add));
      const setPass = (p) => { for (const c of used) (c.mats || []).forEach((m, i) => {
        const add = i % 2 === 1; m.visible = p === 0 ? !add : true;
        if (add) return;
        if (p === 1) { m.blending = THREE.CustomBlending; m.blendSrc = m.blendSrcAlpha = THREE.ZeroFactor; m.blendDst = m.blendDstAlpha = THREE.OneMinusSrcAlphaFactor; }
        else m.blending = THREE.NormalBlending;
      }); };
      // 각 칸은 자기 캐릭터만 렌더한다. 사망·공격 중 바깥으로 뻗는 부품이 옆 칸에 찍히지 않게 가위 영역도 제한한다.
      const renderIsolated = () => {
        const r = this.renderer, autoClear = r.autoClear;
        r.autoClear = false; r.setScissorTest(false); r.clear();
        for (const c of used) c.root.visible = false;
        try {
          r.setScissorTest(true);
          for (const slot of slots) {
            slot.c.root.visible = true;
            r.setScissor(slot.col * this.CW * this.R, (this.ROWS - 1 - slot.row) * this.CH * this.R, this.CW * this.R, this.CH * this.R);
            r.render(this.scene, this.camera);
            slot.c.root.visible = false;
          }
        } finally {
          r.setScissorTest(false); r.autoClear = autoClear;
          for (const c of used) c.root.visible = true;
        }
      };
      if (!glow) { this.glowOn = false; renderIsolated(); return; }
      setPass(0); renderIsolated();
      if (!this.base) { this.base = document.createElement('canvas'); this.base.width = this.canvas.width; this.base.height = this.canvas.height; this.bctx = this.base.getContext('2d'); }
      this.bctx.clearRect(0, 0, this.base.width, this.base.height); this.bctx.drawImage(this.canvas, 0, 0);
      setPass(1); renderIsolated();
      setPass(0); for (const c of used) (c.mats || []).forEach((m) => { m.visible = true; });
      this.glowOn = true;
    },
    // holder 의 SD 칸을 타일 캔버스(크기 CW*R x CH*R)에 복사한다
    blit(holder, cv) {
      const s = holder._sdSlot; if (!s || this.frameSlots[s.f] !== holder) return false;
      const R = this.R, g = cv.getContext('2d');
      g.clearRect(0, 0, cv.width, cv.height);
      if (this.glowOn) {
        g.drawImage(this.base, s.sx, s.sy, this.CW * R, this.CH * R, 0, 0, cv.width, cv.height);
        g.globalAlpha = 0.6; g.globalCompositeOperation = 'lighter';
        g.drawImage(this.canvas, s.sx, s.sy, this.CW * R, this.CH * R, 0, 0, cv.width, cv.height);
        g.globalAlpha = 0.5; g.globalCompositeOperation = 'source-over';
      }
      g.drawImage(this.canvas, s.sx, s.sy, this.CW * R, this.CH * R, 0, 0, cv.width, cv.height);
      g.globalAlpha = 1; g.globalCompositeOperation = 'source-over';
      return true;
    },
    // holder 의 SD 칸을 2D 캔버스에 그린다(라켓몬스터 sdfield.draw 와 같은 합성). 발 위치 (cx, footY), 배율 k(1 = 칸 원본 크기)
    drawTo(ctx, holder, cx, footY, k, alpha) {
      const s = holder._sdSlot; if (!s || this.frameSlots[s.f] !== holder) return false;
      const R = this.R, W = this.CW * k, H = this.CH * k;
      const dx = cx - W / 2, dy = footY - H + 6 * k;
      ctx.save(); ctx.globalAlpha = alpha == null ? 1 : alpha;
      if (this.glowOn) {
        ctx.drawImage(this.base, s.sx, s.sy, this.CW * R, this.CH * R, dx, dy, W, H);
        ctx.globalAlpha = (alpha == null ? 1 : alpha) * 0.6; ctx.globalCompositeOperation = 'lighter';
        ctx.drawImage(this.canvas, s.sx, s.sy, this.CW * R, this.CH * R, dx, dy, W, H);
        ctx.globalAlpha = (alpha == null ? 1 : alpha) * 0.5; ctx.globalCompositeOperation = 'source-over';
      }
      ctx.drawImage(this.canvas, s.sx, s.sy, this.CW * R, this.CH * R, dx, dy, W, H);
      ctx.restore();
      return true;
    },
    release(holder) { if (holder && holder._sd) { this.scene && this.scene.remove(holder._sd.root); holder._sd.dispose && holder._sd.dispose(); holder._sd = null; holder._sdSlot = null; } },
  };
  window.SDL = SDL;
})();
