// SD character runtime: rebuilds the Unity cut-out rig (Transform tree + SpriteRenderers +
// SkinnedMeshRenderers) from js/sd/<id>.js data and plays the sampled AnimationClips.
//
// For speed every character is drawn as ONE mesh: all of its textures are packed into one
// atlas, and each frame the rig is evaluated on the CPU and written straight into a
// dynamic vertex buffer (sprite quads + CPU-skinned parts), in Unity sorting order.
(function () {
  const FPS = 24;

  // Unity-convention math (left-handed space, same formulas as UnityEngine.Quaternion)
  const U = {
    mul: (a, b) => [
      a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
      a[3] * b[1] + a[1] * b[3] + a[2] * b[0] - a[0] * b[2],
      a[3] * b[2] + a[2] * b[3] + a[0] * b[1] - a[1] * b[0],
      a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2]],
    inv: (q) => { const n = q[0] * q[0] + q[1] * q[1] + q[2] * q[2] + q[3] * q[3] || 1; return [-q[0] / n, -q[1] / n, -q[2] / n, q[3] / n]; },
    // conjugate a rotation by a diagonal sign matrix (how Unity composes under negative scale)
    mirror: (q, sg) => [q[0] * sg[1] * sg[2], q[1] * sg[0] * sg[2], q[2] * sg[0] * sg[1], q[3]],
    norm: (q) => { const n = Math.hypot(q[0], q[1], q[2], q[3]) || 1; return [q[0] / n, q[1] / n, q[2] / n, q[3] / n]; },
    norm3: (v) => { const n = Math.hypot(v[0], v[1], v[2]); return n > 1e-5 ? [v[0] / n, v[1] / n, v[2] / n] : [0, 0, 0]; },
    sub: (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]],
    dist: (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]),
    cross: (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]],
    rot: (q, v) => {
      const [x, y, z, w] = q, x2 = x * 2, y2 = y * 2, z2 = z * 2;
      const xx = x * x2, yy = y * y2, zz = z * z2, xy = x * y2, xz = x * z2, yz = y * z2, wx = w * x2, wy = w * y2, wz = w * z2;
      return [(1 - (yy + zz)) * v[0] + (xy - wz) * v[1] + (xz + wy) * v[2],
        (xy + wz) * v[0] + (1 - (xx + zz)) * v[1] + (yz - wx) * v[2],
        (xz - wy) * v[0] + (yz + wx) * v[1] + (1 - (xx + yy)) * v[2]];
    },
    angleAxis: (deg, axis) => {
      const a = U.norm3(axis), h = deg * Math.PI / 360, s = Math.sin(h);
      return [a[0] * s, a[1] * s, a[2] * s, Math.cos(h)];
    },
    fromMat: (m00, m01, m02, m10, m11, m12, m20, m21, m22) => {
      const tr = m00 + m11 + m22;
      let q;
      if (tr > 0) { const s = Math.sqrt(tr + 1) * 2; q = [(m21 - m12) / s, (m02 - m20) / s, (m10 - m01) / s, 0.25 * s]; }
      else if (m00 > m11 && m00 > m22) { const s = Math.sqrt(1 + m00 - m11 - m22) * 2; q = [0.25 * s, (m01 + m10) / s, (m02 + m20) / s, (m21 - m12) / s]; }
      else if (m11 > m22) { const s = Math.sqrt(1 + m11 - m00 - m22) * 2; q = [(m01 + m10) / s, 0.25 * s, (m12 + m21) / s, (m02 - m20) / s]; }
      else { const s = Math.sqrt(1 + m22 - m00 - m11) * 2; q = [(m02 + m20) / s, (m12 + m21) / s, 0.25 * s, (m10 - m01) / s]; }
      return U.norm(q);
    },
    fromTo: (a, b) => {
      const c = U.cross(a, b), d = a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
      if (d < -0.999999) return [0, 1, 0, 0];
      return U.norm([c[0], c[1], c[2], 1 + d]);
    },
    // Quaternion.LookRotation(forward, upwards)
    lookRotation: (forward, up) => {
      const z = U.norm3(forward);
      if (!z[0] && !z[1] && !z[2]) return [0, 0, 0, 1];
      let x = U.cross(up, z);
      const xl = Math.hypot(x[0], x[1], x[2]);
      if (xl < 1e-6) return U.fromTo([0, 0, 1], z);
      x = [x[0] / xl, x[1] / xl, x[2] / xl];
      const y = U.cross(z, x);
      return U.fromMat(x[0], y[0], z[0], x[1], y[1], z[1], x[2], y[2], z[2]);
    },
    angle2: (a, b) => {
      const la = Math.hypot(a[0], a[1]), lb = Math.hypot(b[0], b[1]);
      if (la < 1e-9 || lb < 1e-9) return 0;
      return Math.acos(Math.max(-1, Math.min(1, (a[0] * b[0] + a[1] * b[1]) / (la * lb)))) * 180 / Math.PI;
    },
    // Quaternion.eulerAngles (Unity applies Z, X, Y), degrees in [0, 360)
    euler: (q) => {
      const [x, y, z, w] = q;
      const sx = 2 * (w * x - y * z);
      const ex = Math.abs(sx) >= 1 ? Math.sign(sx) * 90 : Math.asin(sx) * 180 / Math.PI;
      const ey = Math.atan2(2 * (w * y + x * z), 1 - 2 * (x * x + y * y)) * 180 / Math.PI;
      const ez = Math.atan2(2 * (w * z + x * y), 1 - 2 * (x * x + z * z)) * 180 / Math.PI;
      const wrap = (a) => ((a % 360) + 360) % 360;
      return [wrap(ex), wrap(ey), wrap(ez)];
    },
    // m: column-major 3x3, returns m^-1 v
    solve3: (m, v) => {
      const [a, b, c, d, e, f, g, h, i] = m;
      const A = e * i - f * h, B = c * h - b * i, C = b * f - c * e;
      const det = a * A + d * B + g * C;
      if (Math.abs(det) < 1e-12) return [v[0], v[1], v[2]];
      const inv = [A, B, C, g * f - d * i, a * i - g * c, d * c - a * f, d * h - g * e, g * b - a * h, a * e - d * b];
      return [(inv[0] * v[0] + inv[3] * v[1] + inv[6] * v[2]) / det,
        (inv[1] * v[0] + inv[4] * v[1] + inv[7] * v[2]) / det,
        (inv[2] * v[0] + inv[5] * v[1] + inv[8] * v[2]) / det];
    },
  };
  const templates = {};

  // texture tiling/offset inside the packed atlas: wrap the uv within the texture's own rect (Repeat)
  // GPU skinning: every vertex is a weighted sum of up to 4 "slots"; a slot is a 2D affine matrix
  // (2 RGBA texels: m0..m3, m4..m7 with X = m0*x + m2*y + m4*z + m6, Y = m1*x + m3*y + m5*z + m7)
  // written by the CPU each frame. Sprites get one slot per swappable sprite (inactive ones are zero).
  const SLOT_ROW = 64; // slots per texture row
  const SKIN_VS = [
    'vec2 sdSlot(float s, vec3 p) {',
    '  float row = floor(s / ' + SLOT_ROW + '.0); float col = s - row * ' + SLOT_ROW + '.0; row += sdBase;',
    '  vec2 t = vec2((col * 2.0 + 0.5) / ' + (SLOT_ROW * 2) + '.0, (row + 0.5) / sdBoneH);',
    '  vec4 a = texture2D(sdBones, t); vec4 b = texture2D(sdBones, t + vec2(1.0 / ' + (SLOT_ROW * 2) + '.0, 0.0));',
    '  return vec2(a.x * p.x + a.z * p.y + b.x * p.z + b.z, a.y * p.x + a.w * p.y + b.y * p.z + b.w);',
    '}',
  ].join('\n');
  function sdShader(sh, mat) {
    if (mat.userData.sd) {
      sh.uniforms.sdBones = BA.u;
      sh.uniforms.sdBoneH = BA.uH;
      sh.uniforms.sdBase = mat.userData.sd.base;
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nattribute vec4 sdI;\nattribute vec4 sdW;\nuniform sampler2D sdBones;\nuniform float sdBoneH;\nuniform float sdBase;\n' + SKIN_VS)
        .replace('#include <begin_vertex>', [
          'vec2 sk = vec2(0.0);',
          'if (sdW.x > 0.0) sk += sdW.x * sdSlot(sdI.x, position);',
          'if (sdW.y > 0.0) sk += sdW.y * sdSlot(sdI.y, position);',
          'if (sdW.z > 0.0) sk += sdW.z * sdSlot(sdI.z, position);',
          'if (sdW.w > 0.0) sk += sdW.w * sdSlot(sdI.w, position);',
          'vec3 transformed = vec3(sk, 0.0);',
        ].join('\n'));
    }
    stShader(sh);
  }
  function stShader(sh) {
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec4 st;\nattribute vec4 trect;\nvarying vec4 vSt;\nvarying vec4 vRect;')
      .replace('#include <uv_vertex>', '#include <uv_vertex>\nvSt = st;\nvRect = trect;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec4 vSt;\nvarying vec4 vRect;')
      .replace('#include <map_fragment>', [
        'vec2 uvx = vUv;',
        'if (vSt.x != 0.0) { vec2 l = (vUv - vRect.xy) / vRect.zw; uvx = vRect.xy + fract(l * vSt.xy + vSt.zw) * vRect.zw; }',
        'vec4 texelColor = mapTexelToLinear(texture2D(map, uvx));',
        'diffuseColor *= texelColor;',
      ].join('\n'));
  }

  // Unity's Cull Back keeps clockwise (on screen) faces = three's BackSide; Cull Front keeps FrontSide
  function matIndex(r) {
    const m = r.kind === 0 ? r.sr.mat : r.um && r.um.mat;
    const cull = (m && m.cull) || 0;
    return (r.add ? 1 : 0) + 2 * (cull === 2 ? 1 : cull === 1 ? 2 : 0);
  }

  // index buffer in draw order: normal-blend renderers first, then additive ones (one draw each),
  // split into consecutive runs that share a material
  // one pass in the rig's sorting order: additive parts are drawn where Unity draws them (a glow sorted behind
  // the body stays hidden by it), with a new draw group only where the material changes
  function buildIndex(order) {
    const out = [], groups = [];
    for (const r of order) {
      if (!r.tri.length) continue;
      const mi = matIndex(r), last = groups[groups.length - 1];
      if (last && last[2] === mi) last[1] += r.tri.length;
      else groups.push([out.length, r.tri.length, mi]);
      for (const i of r.tri) out.push(i);
    }
    return { arr: new Uint32Array(out), groups };
  }

  // Colour model of the game's shaders: returns [r, g, b, a, hidden]
  // (evaluated for every renderer every frame: no allocation, the result goes into one shared array)
  const W1 = [1, 1, 1, 1], HALF = [0.5, 0.5, 0.5, 0.5];
  const MT = [0, 0, 0, 0, 0];
  function prop(spec, ov, n, d) { return ov && ov[n] != null ? ov[n] : spec.p[n] != null ? spec.p[n] : d; }
  function out(r, g, b, a, hide) { MT[0] = r; MT[1] = g; MT[2] = b; MT[3] = a; MT[4] = hide; return MT; }
  function matEval(spec, ov) {
    switch (spec.sh) {
      case 'lo': { const c = prop(spec, ov, '_Color', W1), s = prop(spec, ov, '_SecondColour', W1); return out(c[0] * s[0], c[1] * s[1], c[2] * s[2], c[3], 0); }
      case 'padd': case 'pab': { const t = prop(spec, ov, '_TintColor', HALF); return out(2 * t[0], 2 * t[1], 2 * t[2], 2 * t[3], 0); }
      case 'aa': { const c = prop(spec, ov, '_Color', W1); return out(c[0], c[1], c[2], c[3] * prop(spec, ov, '_AdditionalAlpha', 1), 0); }
      case 'cloak': { const c = prop(spec, ov, '_Color', W1); return out(c[0], c[1], c[2], c[3] * Math.max(0, 1 - 0.5 * prop(spec, ov, '_cloaking_On', 0)), 0); }
      case 'holo': { const t = prop(spec, ov, '_TintColor', W1); return out(t[0], t[1], t[2], 1, 0); }
      case 'hide': return out(0, 0, 0, 0, 1);
      case 'bori': return out(1, 1, 1, 1, prop(spec, ov, '_change', 0) > 0.5 ? 1 : 0);
      default: { const c = prop(spec, ov, '_Color', W1); return out(c[0], c[1], c[2], c[3], 0); }
    }
  }
  const pending = {};

  function dequant(q) {
    const bin = atob(q.b), n = bin.length >> 1, out = new Float32Array(n), k = (q.x - q.m) / 65535;
    for (let i = 0; i < n; i++) out[i] = q.m + (bin.charCodeAt(i * 2) | (bin.charCodeAt(i * 2 + 1) << 8)) * k;
    return out;
  }

  // yield to the renderer (idle time when the browser offers it)
  // (hidden tabs may never report idle time: a plain timer always settles it too)
  function idle() {
    return new Promise((r) => {
      let done = false;
      const fin = () => { if (!done) { done = true; r(); } };
      if (window.requestIdleCallback) requestIdleCallback(fin, { timeout: 60 });
      setTimeout(fin, 80);
    });
  }

  // over http(s) atlases come as plain WebP files (no base64 in a script: ~25% less to download and nothing to parse);
  // file:// keeps the data scripts (WebGL refuses images read from file:// as cross-origin)
  const HTTP = /^https?:$/.test(location.protocol);
  function atlasTag() { return SD.texScale <= 0.36 ? 'a35' : 'a50'; }
  function loadAtlasScript(id) {
    const key = id + '.' + atlasTag();
    if (window.SD_ATLAS && SD_ATLAS[key]) return Promise.resolve();
    return new Promise((res) => {
      const s = document.createElement('script');
      s.src = SD.dir(id) + key + '.js' + (window.SD_REV && SD_REV[id] ? '?r=' + SD_REV[id] : '');
      s.onload = s.onerror = () => { s.remove(); res(); };
      document.head.appendChild(s);
    });
  }

  async function loadAtlas(a, id) {
    let s0 = a.s || 1;
    if (!a.u) { // split variant (tools/build_sd.py): pick the file for this scale
      const key = id + '.' + atlasTag();
      if (HTTP) a.u = SD.dir(id) + key + '.webp' + (window.SD_REV && SD_REV[id] ? '?r=' + SD_REV[id] : '');
      else {
        a.u = window.SD_ATLAS && SD_ATLAS[key];
        if (!a.u) return null; // atlas script failed to load
        delete SD_ATLAS[key];
      }
      s0 = atlasTag() === 'a35' ? 0.35 : s0;
    }
    const im = new Image();
    const loaded = new Promise((r) => { im.onload = im.onerror = r; });
    if (window.PACKED) PACKED.setSrc(im, a.u); else im.src = a.u; // 배포판: 마스킹한 .pak 을 되돌려 그린다
    // decode() decodes off the main thread, but may wait indefinitely in a hidden tab: whichever settles first
    await Promise.race([im.decode().catch(() => loaded), loaded.then(() => new Promise((r) => setTimeout(r, 250)))]);
    if (!im.naturalWidth) { if (a.v) a.u = undefined; return null; } // undecodable: refetch on retry
    let src = im;
    const k = SD.texScale / s0;
    if (k < 0.98) {
      await idle();
      src = document.createElement('canvas');
      src.width = Math.max(4, Math.round(im.width * k)); src.height = Math.max(4, Math.round(im.height * k));
      const g = src.getContext('2d');
      g.imageSmoothingQuality = 'high';
      g.drawImage(im, 0, 0, src.width, src.height);
    }
    const tex = new THREE.Texture(src);
    tex.needsUpdate = true;
    // WebGL1 would resize NPOT atlases to a power of two for mipmaps (a main-thread canvas copy): linear only there
    tex.minFilter = SD.mipmaps ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter;
    tex.generateMipmaps = SD.mipmaps;
    tex.anisotropy = SD.mipmaps ? 4 : 1;
    return { tex, rects: a.rects };
  }

  function loadImage(src) {
    return new Promise((res) => { const im = new Image(); im.onload = () => res(im); im.onerror = () => res(null); im.src = src; });
  }

  // Load the per-character data script on demand (works from file:// too).
  function loadScript(id) {
    if (window.SD_DATA && SD_DATA[id]) return Promise.resolve();
    return new Promise((res) => {
      const s = document.createElement('script');
      s.src = SD.dir(id) + id + '.js' + (window.SD_REV && SD_REV[id] ? '?r=' + SD_REV[id] : '');
      s.onload = s.onerror = () => { s.remove(); res(); }; // data-only script: let its source be collected
      document.head.appendChild(s);
    });
  }

  // shelf-pack all textures of a character into one canvas
  function packAtlas(imgs) {
    const order = imgs.map((im, i) => i).sort((a, b) => imgs[b].height - imgs[a].height);
    const W = Math.max(...imgs.map((im) => im.width), imgs.length > 1 ? 2048 : 0);
    const pos = [];
    const GAP = SD.texScale < 1 ? Math.ceil(2 / SD.texScale) : 0; // keeps neighbours apart once downscaled / mipmapped
    let x = 0, y = 0, rowH = 0;
    for (const i of order) {
      const im = imgs[i];
      if (x + im.width > W) { x = 0; y += rowH + GAP; rowH = 0; }
      pos[i] = [x, y];
      x += im.width + GAP;
      rowH = Math.max(rowH, im.height);
    }
    const H = y + rowH;
    const cv = document.createElement('canvas');
    cv.width = W; cv.height = H;
    const g = cv.getContext('2d');
    const rects = imgs.map((im, i) => {
      g.drawImage(im, pos[i][0], pos[i][1]);
      // GL uv origin is bottom-left (texture flipY)
      return [pos[i][0] / W, (H - pos[i][1] - im.height) / H, im.width / W, im.height / H];
    });
    // characters are drawn ~100-200 px tall: upload the atlas at the scale the page asks for (GPU memory on phones)
    let src = cv;
    if (SD.texScale < 1) {
      src = document.createElement('canvas');
      src.width = Math.max(4, Math.round(W * SD.texScale)); src.height = Math.max(4, Math.round(H * SD.texScale));
      const g2 = src.getContext('2d');
      g2.imageSmoothingQuality = 'high';
      g2.drawImage(cv, 0, 0, src.width, src.height);
      cv.width = cv.height = 0; // release the full-size canvas
    }
    const tex = new THREE.CanvasTexture(src);
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.anisotropy = 4;
    return { tex, rects };
  }

  function prepare(id) {
    if (templates[id]) return Promise.resolve(templates[id]);
    if (!pending[id]) {
      pending[id] = build(id).catch(() => null).then((t) => { if (!t) delete pending[id]; return t; });
    }
    return pending[id];
  }

  async function build(id) {
    await Promise.all([loadScript(id), HTTP ? null : loadAtlasScript(id)]);
    const data = window.SD_DATA && SD_DATA[id];
    if (!data) return null;
    if ((data.fmt || 1) !== SD.FORMAT) { delete SD_DATA[id]; window.BUILD_MISMATCH = true; return null; } // newer deploy
    let atlas, nTex;
    if (data.atlas) {
      // packed at build time (tools/build_sd.py packed_atlas): decode off the main thread, scale once if needed
      atlas = await loadAtlas(data.atlas, id);
      if (!atlas) return null; // keeps SD_DATA: a retry only refetches the atlas
      nTex = data.atlas.rects.length;
      data.atlas = null;
    } else {
      const imgs = (await Promise.all(data.tex.map(loadImage))).map((im) => im || document.createElement('canvas'));
      data.tex = null; // the base64 sources are no longer needed once decoded (the atlas canvas holds the pixels)
      // a white tile for untextured (solid colour) meshes
      const white = document.createElement('canvas');
      white.width = white.height = 8;
      white.getContext('2d').fillStyle = '#fff';
      white.getContext('2d').fillRect(0, 0, 8, 8);
      imgs.push(white);
      atlas = packAtlas(imgs);
      nTex = imgs.length;
    }
    await idle(); // let a frame through before building the template
    const wr = atlas.rects[nTex - 1];
    atlas.white = [wr[0] + wr[2] * 0.25, wr[1] + wr[3] * 0.25, wr[2] * 0.5, wr[3] * 0.5];
    const N = data.nodes.length;

    // rest pose, converted Unity (left-handed) -> three (z mirrored)
    const parent = new Int32Array(N), restT = new Float32Array(N * 3), restQ = new Float32Array(N * 4);
    const restS = new Float32Array(N * 3), restA = new Uint8Array(N);
    const pathIx = {};
    data.nodes.forEach((n, i) => {
      parent[i] = n.p;
      restT.set([n.t[0], n.t[1], -n.t[2]], i * 3);
      restQ.set([-n.q[0], -n.q[1], n.q[2], n.q[3]], i * 4);
      restS.set(n.s, i * 3);
      restA[i] = n.a;
      if (!(n.path in pathIx)) pathIx[n.path] = i; // Unity binds a duplicated path to the first match
    });

    // sprites: local quad corners + atlas uv
    const sprites = {};
    for (const [key, s] of Object.entries(data.sprites)) {
      const [t, x, y, w, h, px, py, ww, hh] = s;
      const r = atlas.rects[t];
      const sp = sprites[key] = {
        trect: r,
        x0: -px * ww, x1: (1 - px) * ww, y0: -py * hh, y1: (1 - py) * hh,
        u0: r[0] + x * r[2], u1: r[0] + (x + w) * r[2], v0: r[1] + y * r[3], v1: r[1] + (y + h) * r[3],
      };
      // geometry: Unity's own sprite mesh when exported, else the full-rect quad
      const g = data.spriteMesh && data.spriteMesh[key];
      if (g) {
        sp.gv = new Float32Array(g[0]);
        sp.guv = new Float32Array(g[1].length);
        for (let k = 0; k < g[1].length; k += 2) { sp.guv[k] = r[0] + g[1][k] * r[2]; sp.guv[k + 1] = r[1] + g[1][k + 1] * r[3]; }
        sp.gt = g[2];
      } else {
        sp.gv = new Float32Array([sp.x0, sp.y0, sp.x1, sp.y0, sp.x0, sp.y1, sp.x1, sp.y1]);
        sp.guv = new Float32Array([sp.u0, sp.v0, sp.u1, sp.v0, sp.u0, sp.v1, sp.u1, sp.v1]);
        sp.gt = [0, 1, 2, 2, 1, 3];
      }
    }
    // sprites each renderer can show (its own + animated swaps): each gets its own vertex slot
    const swaps = {};
    for (const c of Object.values(data.clips)) {
      for (const t of c.tracks) {
        if (t.k !== 'sp' || pathIx[t.p] == null) continue;
        const set = swaps[pathIx[t.p]] = swaps[pathIx[t.p]] || new Set();
        for (const k of t.d) if (k && sprites[k]) set.add(k);
      }
    }

    // renderers in Unity sorting order
    const rends = [];
    data.nodes.forEach((n, i) => {
      if (n.sr && n.sr.s && sprites[n.sr.s]) rends.push({ kind: 0, node: i, L: n.sr.L, o: n.sr.o, add: n.sr.add, sr: n.sr });
      if (n.skin && n.skin.pos) rends.push({ kind: 1, node: i, L: n.skin.L, o: n.skin.o, add: 0, sk: n.skin });
      if (n.mesh) n.mesh.forEach((m) => rends.push({ kind: 1, node: i, L: m.L, o: m.o, add: m.add, um: m }));
    });
    rends.sort((a, b) => a.L - b.L || a.o - b.o || a.node - b.node);
    rends.forEach((r, k) => { r.ix = k; });

    let V = 0;
    const A = SD.AXIS;
    for (const r of rends) {
      r.v = V;
      const out = r.tri = [];
      if (r.kind === 0) {
        r.slots = {};
        r.keyIdx = {};
        const keys = new Set([r.sr.s, ...(swaps[r.node] || [])]);
        let nv = 0;
        for (const key of keys) {
          const sp = sprites[key];
          r.keyIdx[key] = Object.keys(r.slots).length;
          r.slots[key] = nv;
          for (const i of sp.gt) out.push(V + nv + i);
          nv += sp.gv.length / 2;
        }
        r.nv = nv;
        r.nSlots = keys.size;
        V += nv;
      } else if (r.um) {
        // mesh exported from Unity: bindposes are exact (Unity space, z mirrored into three)
        const m = r.um, nv = m.pos.length / 3;
        for (const i of m.idx) out.push(V + i);
        r.nv = nv;
        r.pos = new Float32Array(m.pos);
        if (m.bones) {
          r.si = m.si;
          r.sw = new Float32Array(m.sw);
          r.bones = m.bones.map((b) => (b >= 0 ? b : r.node));
          r.inv = r.bones.map((b, k) => { const e = m.bind.slice(k * 16, k * 16 + 16); e[2] = -e[2]; e[6] = -e[6]; e[10] = -e[10]; e[14] = -e[14]; return e; });
        } else {
          r.si = new Uint16Array(nv * 4);
          r.sw = new Float32Array(nv * 4);
          for (let k = 0; k < nv; k++) r.sw[k * 4] = 1;
          r.bones = [r.node];
          r.inv = [[1, 0, 0, 0, 0, 1, 0, 0, 0, 0, -1, 0, 0, 0, 0, 1]];
        }
        const rect = r.trect = m.tex >= 0 ? atlas.rects[m.tex] : atlas.white;
        r.uv = new Float32Array(nv * 2);
        for (let k = 0; k < nv; k++) {
          r.uv[k * 2] = rect[0] + (m.tex >= 0 ? m.uv[k * 2] : 0.5) * rect[2];
          r.uv[k * 2 + 1] = rect[1] + (m.tex >= 0 ? m.uv[k * 2 + 1] : 0.5) * rect[3];
        }
        V += nv;
      } else {
        const sk = r.sk;
        const nv = sk.pos.length / 3;
        for (const i of sk.idx) out.push(V + i);
        r.nv = nv;
        r.pos = new Float32Array(sk.pos);
        r.si = sk.si;
        r.sw = new Float32Array(sk.sw);
        r.bones = sk.bones.map((b) => (b >= 0 ? b : r.node));
        const conv = new THREE.Matrix4().makeScale(A[0] * sk.sf, A[1] * sk.sf, A[2] * sk.sf);
        const bind = new THREE.Matrix4().fromArray(sk.bind);
        r.inv = sk.inv.map((e) => conv.clone().multiply(new THREE.Matrix4().fromArray(e)).multiply(bind).elements.slice());
        const rect = r.trect = atlas.rects[sk.tex] || [0, 0, 1, 1];
        r.uv = new Float32Array(nv * 2);
        for (let k = 0; k < nv; k++) {
          r.uv[k * 2] = rect[0] + sk.uv[k * 2] * rect[2];
          r.uv[k * 2 + 1] = rect[1] + sk.uv[k * 2 + 1] * rect[3];
        }
        V += nv;
      }
    }
    const { arr, groups } = buildIndex(rends);
    const index = new THREE.BufferAttribute(arr, 1);
    // animated sortingOrder needs a per-instance draw order
    const hasSo = Object.values(data.clips).some((c) => c.tracks.some((t) => t.k === 'so'));

    for (const c of Object.values(data.clips)) {
      c.tracks = c.tracks.filter((t) => { t.i = pathIx[t.p]; return t.i != null; });
      for (const t of c.tracks) if (t.d && t.d.b) t.d = dequant(t.d); // uint16 tracks (tools/build_sd.py quantize_clips)
    }
    const rendByNode = {};
    const rendsOfNode = {};
    for (const r of rends) {
      if (r.kind === 0) rendByNode[r.node] = r.ix;
      (rendsOfNode[r.node] = rendsOfNode[r.node] || []).push(r.ix);
      r.mat = (r.kind === 0 ? r.sr.mat : r.um && r.um.mat) || null;
    }

    // subtree [i, end[i]) in pre-order
    const end = new Int32Array(N);
    for (let i = N - 1; i >= 0; i--) { if (end[i] < i + 1) end[i] = i + 1; const p = parent[i]; if (p >= 0 && end[p] < end[i]) end[p] = end[i]; }
    // Puppet2D_GlobalControl.Run(): ParentControls, FaceCamera, IK handles (pre-order of its hierarchy)
    const gcs = [];
    const gcByNode = {};
    data.nodes.forEach((n, i) => {
      if (!n.gc) return;
      const g = Object.assign({ node: i, iks: [], pcs: [] }, n.gc);
      for (let j = i + 1; j < end[i]; j++) {
        const m = data.nodes[j];
        if (m.pc) g.pcs.push(Object.assign({ node: j }, m.pc));
        if (m.ik) g.iks.push(Object.assign({ node: j }, m.ik));
      }
      gcByNode[i] = gcs.length;
      gcs.push(g);
    });
    const iks = gcs.reduce((a, g) => a.concat(g.iks), []);
    const tpl = { id, data, atlas, rendsOfNode, iks, gcs, gcByNode, end, N, parent, restT, restQ, restS, restA, sprites, rends, rendByNode, V, index, groups, hasSo };
    if (SD.pinRoot) pinRoot(tpl);
    measure(tpl);
    templates[id] = tpl;
    return tpl;
  }

  const BA = { W: SLOT_ROW * 2, rows: 0, arr: new Float32Array(0), tex: null, free: [], dirty: false, u: { value: null }, uH: { value: 1 } };
  function baGrow(need) {
    const rows = Math.max(64, BA.rows + Math.max(need, 32));
    const arr = new Float32Array(BA.W * 4 * rows);
    arr.set(BA.arr);
    if (BA.rows < rows) BA.free.push([BA.rows, rows - BA.rows]);
    BA.rows = rows; BA.arr = arr;
    if (BA.tex) BA.tex.dispose();
    BA.tex = new THREE.DataTexture(arr, BA.W, rows, THREE.RGBAFormat, THREE.FloatType);
    BA.tex.magFilter = BA.tex.minFilter = THREE.NearestFilter;
    BA.u.value = BA.tex; BA.uH.value = rows;
    BA.dirty = true;
  }
  function baAlloc(n) {
    for (let pass = 0; pass < 2; pass++) {
      for (let i = 0; i < BA.free.length; i++) {
        const f = BA.free[i];
        if (f[1] < n) continue;
        const start = f[0];
        if (f[1] === n) BA.free.splice(i, 1); else { f[0] += n; f[1] -= n; }
        return start;
      }
      baGrow(n);
    }
    return 0;
  }
  function baFree(start, n) {
    BA.arr.fill(0, start * BA.W * 4, (start + n) * BA.W * 4);
    BA.free.push([start, n]);
    BA.free.sort((a, b) => a[0] - b[0]);
    for (let i = BA.free.length - 2; i >= 0; i--) { // merge neighbours
      const a = BA.free[i], b = BA.free[i + 1];
      if (a[0] + a[1] === b[0]) { a[1] += b[1]; BA.free.splice(i + 1, 1); }
    }
  }
  // called before the first skinned mesh is drawn each frame (onBeforeRender): a single upload for all rigs
  function baFlush() { if (BA.dirty && BA.tex) { BA.tex.needsUpdate = true; BA.dirty = false; } }

  // free shared vertex/index buffers: WebGLGeometries only listens for dispose() on geometries it has drawn,
  // so register them with an empty draw (draw range 0: nothing reaches the screen), then dispose
  let relScene = null, relCam = null, relMat = null;
  function gpuRelease(geos) {
    const r = SD.renderer;
    if (r) {
      if (!relScene) { relScene = new THREE.Scene(); relCam = new THREE.OrthographicCamera(); relMat = new THREE.MeshBasicMaterial(); }
      const meshes = geos.map((g) => { g.setDrawRange(0, 0); const m = new THREE.Mesh(g, relMat); m.frustumCulled = false; relScene.add(m); return m; });
      const ac = r.autoClear, rt = r.getRenderTarget();
      r.autoClear = false; r.setRenderTarget(null);
      try { r.render(relScene, relCam); } catch (e) { /* nothing drawn either way */ }
      r.autoClear = ac; r.setRenderTarget(rt);
      meshes.forEach((m) => relScene.remove(m));
    }
    geos.forEach((g) => g.dispose());
  }

  // Game only: attack / skill clips that carry the whole character around (root-motion bones: a jump, a flying
  // strafe, a slide) keep that motion near their cell: the pose plays untouched and render() pulls the rig back
  // so its travel is softly limited to SD.pinRange (0: none at all). Bones of separate machines (drones, mechs)
  // are not roots and keep moving; tools leave every clip exact.
  const ROOT_BONE = /^(global_ctrl|ch_root|rotation_root|com|com_root.*|root)$/i;
  function pinRoot(tpl) {
    const skip = (SD.pinSkip && SD.pinSkip[tpl.id]) || []; // clips played travelling to the target (see the game)
    const N = tpl.data.nodes;
    const depth = (i) => { let d = 0; while (N[i].p >= 0) { i = N[i].p; d++; } return d; };
    for (const name of ['atk', 'skill']) {
      const c = tpl.data.clips[name];
      if (!c || skip.includes(name)) continue;
      let best = -1, bestR = 0;
      for (const tr of c.tracks) {
        if (tr.k !== 't' || !tr.d || tr.d.length <= 3) continue;
        const n = N[tr.i].n, dp = depth(tr.i);
        const root = dp <= 3 && ROOT_BONE.test(n), pelvis = dp <= 4 && /pelvis/i.test(n);
        if (!root && !pelvis) continue;
        let r = 0;
        for (let k = 3; k < tr.d.length; k += 3) r = Math.max(r, Math.hypot(tr.d[k] - tr.d[0], tr.d[k + 1] - tr.d[1]));
        if (r > (root ? 0.3 : 3) && r > bestR) { best = tr.i; bestR = r; }
      }
      if (best >= 0) (tpl.pinBone || (tpl.pinBone = {}))[name] = best;
    }
  }

  function gpuData(tpl) {
    if (tpl.gpu) return tpl.gpu;
    const V = tpl.V;
    const lp = new Float32Array(V * 3), si = new Float32Array(V * 4), sw = new Float32Array(V * 4), uv = new Float32Array(V * 2);
    let S = 0;
    for (const r of tpl.rends) {
      r.sb = S;
      if (r.kind === 0) {
        for (const key of Object.keys(r.slots)) {
          const sp = tpl.sprites[key], off = r.v + r.slots[key], slot = S + r.keyIdx[key];
          for (let j = 0; j < sp.gv.length / 2; j++) {
            const q = off + j;
            lp[q * 3] = sp.gv[j * 2]; lp[q * 3 + 1] = sp.gv[j * 2 + 1];
            si[q * 4] = slot; sw[q * 4] = 1;
            uv[q * 2] = sp.guv[j * 2]; uv[q * 2 + 1] = sp.guv[j * 2 + 1];
          }
        }
        S += Object.keys(r.slots).length;
      } else {
        lp.set(r.pos, r.v * 3);
        uv.set(r.uv, r.v * 2);
        for (let j = 0; j < r.nv; j++) {
          for (let n = 0; n < 4; n++) {
            si[(r.v + j) * 4 + n] = S + r.si[j * 4 + n];
            sw[(r.v + j) * 4 + n] = r.sw[j * 4 + n];
          }
        }
        S += r.bones.length;
      }
    }
    const rows = Math.max(1, Math.ceil(S / SLOT_ROW));
    tpl.gpu = {
      lp: new THREE.BufferAttribute(lp, 3), si: new THREE.BufferAttribute(si, 4), sw: new THREE.BufferAttribute(sw, 4),
      uv, S, rows,
    };
    return tpl.gpu;
  }

  class SDChar {
    constructor(tpl, opts) {
      // GPU skinning unless the page asks for CPU vertices (tools that read positions back) or lacks float vertex textures
      this.gpu = !(opts && opts.cpu) && SD.gpuSkin;
      this.tpl = tpl;
      const N = tpl.N;
      this.T = new Float32Array(N * 3);
      this.Q = new Float32Array(N * 4);
      this.S = new Float32Array(N * 3);
      this.A = new Uint8Array(N);
      this.EA = new Uint8Array(N);
      this.W = new Float32Array(N * 12);
      const R = tpl.rends.length;
      this.rEn = new Uint8Array(R);
      this.rCol = new Float32Array(R * 4);
      this.rFlip = new Uint8Array(R);
      this.rFlipY = new Uint8Array(R);
      this.rOrd = new Float32Array(R);
      this.rOrdDrawn = null;
      this.rKey = new Array(R);
      this.mprop = new Array(R).fill(null); // animated material property overrides
      this.ikFlip = new Uint8Array(N);
      this.gcOn = tpl.gcs.map(() => new Float32Array(4));

      const geo = new THREE.BufferGeometry();
      this.pos = new Float32Array(tpl.V * 3); // CPU path only
      this.uv = new Float32Array(tpl.V * 2);
      this.col = new Float32Array(tpl.V * 4);
      // per-vertex texture tiling/offset (material._MainTex_ST) and the texture's rect in the atlas;
      // st.x == 0 means untouched
      this.st = new Float32Array(tpl.V * 4);
      this.trect = new Float32Array(tpl.V * 4);
      this.stOn = new Uint8Array(tpl.rends.length);
      // last uploaded colour / sprite per renderer: only positions change every frame (mobile upload cost)
      this.lastCol = new Float32Array(tpl.rends.length * 4).fill(-1);
      this.lastKey = new Array(tpl.rends.length);
      if (this.gpu) {
        const gd = gpuData(tpl);
        this.pos = null;
        geo.setAttribute('position', gd.lp); // static local positions, shared by every instance of the rig
        geo.setAttribute('sdI', gd.si);
        geo.setAttribute('sdW', gd.sw);
        this.uv.set(gd.uv);
        this.boneRows = gd.rows;
        this.boneRow = baAlloc(gd.rows);
        this.sdU = { base: { value: this.boneRow } };
      } else {
        geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
      }
      geo.setAttribute('uv', new THREE.BufferAttribute(this.uv, 2).setUsage(THREE.DynamicDrawUsage));
      geo.setAttribute('color', new THREE.BufferAttribute(this.col, 4).setUsage(THREE.DynamicDrawUsage));
      geo.setAttribute('st', new THREE.BufferAttribute(this.st, 4).setUsage(THREE.DynamicDrawUsage));
      geo.setAttribute('trect', new THREE.BufferAttribute(this.trect, 4).setUsage(THREE.DynamicDrawUsage));
      geo.setIndex(tpl.index);
      tpl.groups.forEach(([s, c, m]) => { if (c) geo.addGroup(s, c, m); });
      if (!this.gpu) for (const r of tpl.rends) if (r.kind === 1) this.uv.set(r.uv, r.v * 2);
      const mk = (add, side) => {
        const m = new THREE.MeshBasicMaterial({
          map: tpl.atlas.tex, vertexColors: true, transparent: true, depthTest: false, depthWrite: false,
          alphaTest: 0.02, side, blending: add ? THREE.AdditiveBlending : THREE.NormalBlending,
        });
        if (this.gpu) {
          m.userData.sd = this.sdU;
          m.onBeforeCompile = (sh) => sdShader(sh, m);
          m.customProgramCacheKey = () => 'sdgpu';
        } else m.onBeforeCompile = stShader;
        return m;
      };
      // material index = additive + 2 * cull mode (see matIndex)
      this.mats = [THREE.DoubleSide, THREE.BackSide, THREE.FrontSide].flatMap((side) => [mk(false, side), mk(true, side)]);
      this.mesh = new THREE.Mesh(geo, this.mats);
      this.mesh.frustumCulled = false;
      if (this.gpu) this.mesh.onBeforeRender = baFlush;
      this.root = new THREE.Group();
      this.root.add(this.mesh);
      this.geo = geo;

      this.time = 0;
      this.clip = null;
      this.clipName = '';
      this.speed = 1;
      this.loop = false;
      this.onEnd = null;
      this.play('idle');
    }

    reset() {
      const t = this.tpl;
      t.iks.forEach((h) => { this.ikFlip[h.node] = h.f; });
      t.gcs.forEach((g, k) => this.gcOn[k].set(g.onoff));
      this.mprop.fill(null);
      this.T.set(t.restT); this.Q.set(t.restQ); this.S.set(t.restS); this.A.set(t.restA);
      t.rends.forEach((r, k) => {
        this.rOrd[k] = r.o;
        if (r.kind === 0) {
          this.rEn[k] = r.sr.e;
          this.rCol.set(r.sr.c, k * 4);
          this.rFlip[k] = r.sr.fx;
          this.rFlipY[k] = r.sr.fy || 0;
          this.rKey[k] = r.sr.s;
        } else {
          this.rEn[k] = r.um ? r.um.e : r.sk.e;
          this.rCol.set(r.um ? r.um.col : [1, 1, 1, 1], k * 4);
        }
      });
    }

    has(name) { return !!this.tpl.data.clips[name]; }

    play(name, onEnd, loop) {
      const c = this.tpl.data.clips[name] || this.tpl.data.clips.idle || Object.values(this.tpl.data.clips)[0];
      // crossfade (game only): hold the pose being left and blend the bones into the new clip
      this.fadeD = SD.crossfade && this.clip ? SD.crossfade : 0;
      if (this.fadeD) {
        if (!this.fT) { this.fT = new Float32Array(this.T.length); this.fQ = new Float32Array(this.Q.length); this.fS = new Float32Array(this.S.length); }
        this.fT.set(this.T); this.fQ.set(this.Q); this.fS.set(this.S);
        this.fadeT = 0;
      }
      this.reset();
      this.clip = c || null;
      this.pinRef = null;
      this.clipName = name;
      this.loop = !!loop;
      this.time = 0;
      this.onEnd = onEnd || null;
      this.apply();
      if (this.fadeD) this.blend();
      this.render();
    }

    // bones between the held pose (fT/fQ/fS) and the clip's, eased over fadeD seconds
    blend() {
      const w0 = Math.min(1, this.fadeT / this.fadeD);
      if (w0 >= 1) { this.fadeD = 0; return; }
      const w = w0 * w0 * (3 - 2 * w0), v = 1 - w;
      const T = this.T, Q = this.Q, S = this.S, fT = this.fT, fQ = this.fQ, fS = this.fS;
      for (let i = 0; i < T.length; i++) { T[i] = fT[i] * v + T[i] * w; S[i] = fS[i] * v + S[i] * w; }
      for (let i = 0; i < Q.length; i += 4) {
        const sg = fQ[i] * Q[i] + fQ[i + 1] * Q[i + 1] + fQ[i + 2] * Q[i + 2] + fQ[i + 3] * Q[i + 3] < 0 ? -v : v;
        const x = fQ[i] * sg + Q[i] * w, y = fQ[i + 1] * sg + Q[i + 1] * w, z = fQ[i + 2] * sg + Q[i + 2] * w, q = fQ[i + 3] * sg + Q[i + 3] * w;
        const l = 1 / (Math.hypot(x, y, z, q) || 1);
        Q[i] = x * l; Q[i + 1] = y * l; Q[i + 2] = z * l; Q[i + 3] = q * l;
      }
    }

    update(dt) {
      if (!this.clip) return;
      this.time += dt * this.speed;
      const c = this.clip;
      if (this.time >= c.dur) {
        if (this.clipName === 'idle' || this.clipName === 'move' || this.loop || (c.loop && !this.onEnd)) {
          this.time %= c.dur;
        } else {
          const cb = this.onEnd;
          this.onEnd = null;
          this.play('idle');
          if (cb) cb();
          return;
        }
      }
      if (dt > 0) {
        this.apply();
        if (this.fadeD) { this.fadeT += dt; this.blend(); }
        this.render();
      }
    }

    apply() {
      const c = this.clip;
      if (!c) return;
      const fpos = Math.min(c.n - 1, this.time * FPS);
      const f0 = Math.min(c.n - 1, Math.floor(fpos + 1e-4)), f1 = Math.min(c.n - 1, f0 + 1), a = Math.max(0, fpos - f0);
      const T = this.T, Q = this.Q, S = this.S, rb = this.tpl.rendByNode;
      for (const t of c.tracks) {
        const i = t.i, d = t.d;
        switch (t.k) {
          case 'q': {
            let i0 = 0, i1 = 0;
            if (d.length > 4) { i0 = f0 * 4; i1 = f1 * 4; }
            let x = d[i0] + (d[i1] - d[i0]) * a, y = d[i0 + 1] + (d[i1 + 1] - d[i0 + 1]) * a;
            let z = d[i0 + 2] + (d[i1 + 2] - d[i0 + 2]) * a, w = d[i0 + 3] + (d[i1 + 3] - d[i0 + 3]) * a;
            const l = 1 / (Math.hypot(x, y, z, w) || 1);
            Q[i * 4] = -x * l; Q[i * 4 + 1] = -y * l; Q[i * 4 + 2] = z * l; Q[i * 4 + 3] = w * l;
            break;
          }
          case 't': case 's': {
            let i0 = 0, i1 = 0;
            if (d.length > 3) { i0 = f0 * 3; i1 = f1 * 3; }
            const x = d[i0] + (d[i1] - d[i0]) * a, y = d[i0 + 1] + (d[i1 + 1] - d[i0 + 1]) * a, z = d[i0 + 2] + (d[i1 + 2] - d[i0 + 2]) * a;
            if (t.k === 't') { T[i * 3] = x; T[i * 3 + 1] = y; T[i * 3 + 2] = -z; } else { S[i * 3] = x; S[i * 3 + 1] = y; S[i * 3 + 2] = z; }
            break;
          }
          case 'a': this.A[i] = d.length > 1 ? d[f0] : d[0]; break;
          case 'en': if (rb[i] != null) this.rEn[rb[i]] = d.length > 1 ? d[f0] : d[0]; break;
          case 'ca': case 'cr': case 'cg': case 'cb':
            if (rb[i] != null) {
              const v = d.length > 1 ? d[f0] + (d[f1] - d[f0]) * a : d[0];
              this.rCol[rb[i] * 4 + { cr: 0, cg: 1, cb: 2, ca: 3 }[t.k]] = v;
            }
            break;
          case 'mt': {
            const v = d.length > 1 ? d[f0] + (d[f1] - d[f0]) * a : d[0];
            for (const k of this.tpl.rendsOfNode[i] || []) {
              const r = this.tpl.rends[k];
              const o = this.mprop[k] || (this.mprop[k] = {});
              if (t.ch) {
                if (!o[t.prop]) o[t.prop] = ((r.mat && r.mat.p[t.prop]) || (t.prop === '_MainTex_ST' ? [1, 1, 0, 0] : [1, 1, 1, 1])).slice();
                o[t.prop]['rgbaxyzw'.indexOf(t.ch) % 4] = v;
              } else o[t.prop] = v;
            }
            break;
          }
          case 'fx': if (rb[i] != null) this.rFlip[rb[i]] = d.length > 1 ? d[f0] : d[0]; break;
          case 'fy': if (rb[i] != null) this.rFlipY[rb[i]] = d.length > 1 ? d[f0] : d[0]; break;
          case 'so': for (const k of this.tpl.rendsOfNode[i] || []) this.rOrd[k] = d.length > 1 ? d[f0] : d[0]; break;
          case 'ikflip': this.ikFlip[i] = d.length > 1 ? d[f0] : d[0]; break;
          case 'on0': case 'on1': case 'on2': case 'on3': {
            const g = this.tpl.gcByNode[i];
            if (g != null) this.gcOn[g][+t.k[2]] = d.length > 1 ? d[f0] : d[0];
            break;
          }
          case 'sp': if (rb[i] != null) { const k = d.length > 1 ? d[f0] : d[0]; if (k && this.tpl.sprites[k]) this.rKey[rb[i]] = k; } break;
        }
      }
    }

    // world matrices (3x4, column-major) for every node
    // world matrices (3x4, column-major) for nodes [from, to); every node is evaluated so
    // inactive transforms still have valid poses (Unity keeps them updated too)
    worldPass(from = 0, to = this.tpl.N) {
      const tp = this.tpl, P = tp.parent, T = this.T, Q = this.Q, S = this.S, W = this.W;
      for (let i = from; i < to; i++) {
        const p = P[i];
        this.EA[i] = this.A[i] && (p < 0 || this.EA[p]) ? 1 : 0;
        const x = Q[i * 4], y = Q[i * 4 + 1], z = Q[i * 4 + 2], w = Q[i * 4 + 3];
        const sx = S[i * 3], sy = S[i * 3 + 1], sz = S[i * 3 + 2];
        const x2 = x + x, y2 = y + y, z2 = z + z;
        const xx = x * x2, xy = x * y2, xz = x * z2, yy = y * y2, yz = y * z2, zz = z * z2, wx = w * x2, wy = w * y2, wz = w * z2;
        const l0 = (1 - (yy + zz)) * sx, l1 = (xy + wz) * sx, l2 = (xz - wy) * sx;
        const l3 = (xy - wz) * sy, l4 = (1 - (xx + zz)) * sy, l5 = (yz + wx) * sy;
        const l6 = (xz + wy) * sz, l7 = (yz - wx) * sz, l8 = (1 - (xx + yy)) * sz;
        const l9 = T[i * 3], l10 = T[i * 3 + 1], l11 = T[i * 3 + 2];
        const o = i * 12;
        if (p < 0) {
          W[o] = l0; W[o + 1] = l1; W[o + 2] = l2; W[o + 3] = l3; W[o + 4] = l4; W[o + 5] = l5;
          W[o + 6] = l6; W[o + 7] = l7; W[o + 8] = l8; W[o + 9] = l9; W[o + 10] = l10; W[o + 11] = l11;
        } else {
          const q = p * 12;
          const p0 = W[q], p1 = W[q + 1], p2 = W[q + 2], p3 = W[q + 3], p4 = W[q + 4], p5 = W[q + 5];
          const p6 = W[q + 6], p7 = W[q + 7], p8 = W[q + 8], p9 = W[q + 9], p10 = W[q + 10], p11 = W[q + 11];
          W[o] = p0 * l0 + p3 * l1 + p6 * l2; W[o + 1] = p1 * l0 + p4 * l1 + p7 * l2; W[o + 2] = p2 * l0 + p5 * l1 + p8 * l2;
          W[o + 3] = p0 * l3 + p3 * l4 + p6 * l5; W[o + 4] = p1 * l3 + p4 * l4 + p7 * l5; W[o + 5] = p2 * l3 + p5 * l4 + p8 * l5;
          W[o + 6] = p0 * l6 + p3 * l7 + p6 * l8; W[o + 7] = p1 * l6 + p4 * l7 + p7 * l8; W[o + 8] = p2 * l6 + p5 * l7 + p8 * l8;
          W[o + 9] = p0 * l9 + p3 * l10 + p6 * l11 + p9; W[o + 10] = p1 * l9 + p4 * l10 + p7 * l11 + p10; W[o + 11] = p2 * l9 + p5 * l10 + p8 * l11 + p11;
        }
      }
    }

    // ── Unity-space transform access (Unity = three with z mirrored) ──
    posU(i) { const W = this.W, o = i * 12; return [W[o + 9], W[o + 10], -W[o + 11]]; }
    localRotU(i) { const Q = this.Q; return [-Q[i * 4], -Q[i * 4 + 1], Q[i * 4 + 2], Q[i * 4 + 3]]; }
    // Transform.rotation as Unity reports it: local rotations composed down the hierarchy,
    // each one mirrored by the sign of the accumulated (lossy) scale of its parent.
    rotSig(i) {
      const chain = [];
      for (let j = i; j >= 0; j = this.tpl.parent[j]) chain.push(j);
      let q = [0, 0, 0, 1];
      const sg = [1, 1, 1];
      const S = this.S;
      for (let k = chain.length - 1; k >= 0; k--) {
        const j = chain[k];
        q = U.mul(q, U.mirror(this.localRotU(j), sg));
        for (let a = 0; a < 3; a++) if (S[j * 3 + a] < 0) sg[a] = -sg[a];
      }
      return [q, sg];
    }
    rotU(i) { return this.rotSig(i)[0]; }
    setRotU(i, R) {
      const p = this.tpl.parent[i];
      let l = R;
      if (p >= 0) { const [qp, sg] = this.rotSig(p); l = U.mirror(U.mul(U.inv(qp), R), sg); }
      l = U.norm(l);
      const Q = this.Q;
      Q[i * 4] = -l[0]; Q[i * 4 + 1] = -l[1]; Q[i * 4 + 2] = l[2]; Q[i * 4 + 3] = l[3];
      this.worldPass(i, this.tpl.end[i]);
    }
    setPosU(i, pu) {
      const p = this.tpl.parent[i], T = this.T;
      let x = pu[0], y = pu[1], z = -pu[2];
      if (p >= 0) {
        const W = this.W, o = p * 12;
        const r = U.solve3([W[o], W[o + 1], W[o + 2], W[o + 3], W[o + 4], W[o + 5], W[o + 6], W[o + 7], W[o + 8]],
          [x - W[o + 9], y - W[o + 10], z - W[o + 11]]);
        x = r[0]; y = r[1]; z = r[2];
      }
      T[i * 3] = x; T[i * 3 + 1] = y; T[i * 3 + 2] = z;
      this.worldPass(i, this.tpl.end[i]);
    }
    setScale(i, s) { this.S.set(s, i * 3); this.worldPass(i, this.tpl.end[i]); }
    transformPointU(i, v) {
      const W = this.W, o = i * 12, x = v[0], y = v[1], z = -v[2];
      return [W[o] * x + W[o + 3] * y + W[o + 6] * z + W[o + 9], W[o + 1] * x + W[o + 4] * y + W[o + 7] * z + W[o + 10],
        -(W[o + 2] * x + W[o + 5] * y + W[o + 8] * z + W[o + 11])];
    }

    // Puppet2D_GlobalControl.Run() — ported from the original scripts
    runPuppet() {
      this.tpl.gcs.forEach((g, gi) => {
        if (!g.en || !g.lu) return;
        for (const pc of g.pcs) this.parentControl(pc);
        // FaceCamera(): AimDirection = transform.forward * _flipCorrection
        const fwd = U.norm3(U.rot(this.rotU(g.node), [0, 0, 1]));
        const aim = [fwd[0] * g.fc, fwd[1] * g.fc, fwd[2] * g.fc];
        const on = this.gcOn[gi];
        g.iks.forEach((h, i) => {
          if (i > 3 || on[i] === 1 || g.type === 1) this.calculateIK(h, aim);
        });
      });
    }

    // Puppet2D_ParentControl.ParentControlRun()
    parentControl(pc) {
      const ctrl = pc.node, bone = pc.bone;
      if (pc.or) this.setRotU(bone, pc.mo ? U.mul(this.rotU(ctrl), pc.oo) : this.rotU(ctrl));
      if (pc.pt) this.setPosU(bone, pc.mo ? this.transformPointU(ctrl, pc.op) : this.posU(ctrl));
      if (pc.sc) { const S = this.S, c = ctrl * 3; this.setScale(bone, [S[c] * pc.os[0], S[c + 1] * pc.os[1], S[c + 2] * pc.os[2]]); }
      if (pc.cp && !pc.pt) this.setPosU(ctrl, this.posU(bone));
    }

    // Puppet2D_IKHandle.CalculateIK()
    calculateIK(h, aim) {
      const ctrl = h.node;
      if (h.multi === 1) { this.calculateMultiIK(h); return; }
      const flipRotation = this.ikFlip[ctrl] ? 1 : -1;
      const top = h.t, mid = h.m, bot = h.b;
      // GetAngle()
      if (h.sq) this.setScale(top, h.ss0);
      const A = this.posU(top), B = this.posU(mid), C = this.posU(bot), T = this.posU(ctrl);
      const topLength = U.dist(A, B), middleLength = U.dist(B, C), length = topLength + middleLength;
      let ikLength = U.dist(A, T);
      const larger = middleLength > topLength;
      if (h.sq && ikLength > length) this.setScale(top, [h.ss0[0], (ikLength / length) * h.ss0[1], h.ss0[2]]);
      ikLength = Math.min(ikLength, length - 0.0001);
      const adjacent = (topLength * topLength - middleLength * middleLength + ikLength * ikLength) / (2 * ikLength);
      const angle = Math.acos(adjacent / topLength) * 180 / Math.PI;
      // Aim joints
      const look = U.lookRotation(U.sub(T, A), aim);
      if (!isNaN(angle)) this.setRotU(top, U.mul(U.mul(look, U.angleAxis(90, h.up)), U.angleAxis(angle * flipRotation, [0, 0, 1])));
      else this.setRotU(top, U.mul(look, U.angleAxis(larger ? -90 : 90, h.up)));
      const Bn = this.posU(mid);
      this.setRotU(mid, U.mul(U.lookRotation(U.sub(T, Bn), aim), U.angleAxis(90, h.up)));
      this.setRotU(bot, U.mul(this.rotU(ctrl), h.off));
      if (h.sc) { const S = this.S, c = ctrl * 3; this.setScale(bot, [S[c] * h.os[0], S[c + 1] * h.os[1], S[c + 2] * h.os[2]]); }
    }

    // Puppet2D_IKHandle.CalculateMultiIK(): CCD chain (numberIkBonesIndex == 1)
    calculateMultiIK(h) {
      if (h.end < 0) return;
      const P = this.tpl.parent;
      for (let it = 0; it < h.it; it++) {
        let node = P[h.end];
        while (node >= 0) {
          const tgt = this.posU(h.node), np = this.posU(node), ep = this.posU(h.end);
          const a = [ep[0] - np[0], ep[1] - np[1]], b = [tgt[0] - np[0], tgt[1] - np[1]];
          const crossZ = a[0] * b[1] - a[1] * b[0];
          let ang = U.angle2(a, b) * (crossZ > 0 ? -1 : 1); // sign of dot(back, cross)
          const ey = U.euler(this.rotU(node))[1] % 360;
          if (ey > 90 && ey < 275) ang *= -1;
          ang *= h.damp;
          ang = -(ang - U.euler(this.localRotU(node))[2]);
          const l = U.angleAxis(ang, [0, 0, 1]);
          const Q = this.Q;
          Q[node * 4] = -l[0]; Q[node * 4 + 1] = -l[1]; Q[node * 4 + 2] = l[2]; Q[node * 4 + 3] = l[3];
          this.worldPass(node, this.tpl.end[node]);
          if (node === h.start) break;
          node = P[node];
        }
      }
      this.setRotU(h.end, this.rotU(h.node));
    }

    // rebuild the index buffer when an animated sortingOrder changed the draw order
    resort() {
      const tp = this.tpl, o = this.rOrd;
      if (this.rOrdDrawn ? o.every((v, k) => v === this.rOrdDrawn[k]) : tp.rends.every((r, k) => o[k] === r.o)) return;
      this.rOrdDrawn = o.slice();
      // few distinct orders per rig: cache their index buffers instead of re-uploading (and leaking) them
      const key = o.join(',');
      const cache = tp.idxCache || (tp.idxCache = {}); // shared by every instance of the rig
      if (cache[key]) { this.useIndex(...cache[key]); return; }
      const ord = tp.rends.slice().sort((a, b) => a.L - b.L || o[a.ix] - o[b.ix] || a.node - b.node);
      const { arr, groups } = buildIndex(ord);
      const ix = new THREE.BufferAttribute(arr, 1);
      cache[key] = [ix, groups];
      this.useIndex(ix, groups);
    }

    useIndex(ix, groups) {
      this.geo.setIndex(ix);
      this.geo.clearGroups();
      for (const [s, c, m] of groups) this.geo.addGroup(s, c, m);
    }

    // evaluate the rig and write the vertex buffer
    render() {
      if (this.tpl.hasSo) this.resort();
      this.worldPass();
      if (this.tpl.gcs.length) this.runPuppet();
      // root motion authored on the pelvis (with IK targets following it): the pose plays untouched and the
      // whole rig is shifted back by the pelvis' travel since the clip started (SD.pinRoot)
      const pb = this.tpl.pinBone && this.tpl.pinBone[this.clipName];
      if (pb != null) {
        const x = this.W[pb * 12 + 9], y = this.W[pb * 12 + 10];
        if (!this.pinRef) this.pinRef = [x, y];
        const dx = x - this.pinRef[0], dy = y - this.pinRef[1], L = Math.hypot(dx, dy);
        const R = SD.pinRanges && SD.pinRanges[this.tpl.id] != null ? SD.pinRanges[this.tpl.id] : SD.pinRange;
        const k = L > 1e-6 && R > 0 ? (R * Math.tanh(L / R)) / L : 0; // share of the travel that is kept
        this.mesh.position.set(dx * (k - 1), dy * (k - 1), 0);
      } else if (this.mesh.position.x || this.mesh.position.y) this.mesh.position.set(0, 0, 0);
      const tp = this.tpl, W = this.W;
      const pos = this.pos, uv = this.uv, col = this.col;
      const gpu = this.gpu, B = BA.arr, bo = gpu ? this.boneRow * BA.W * 4 : 0;
      const rends = tp.rends;
      for (let k = 0; k < rends.length; k++) {
        const r = rends[k];
        const mt = r.mat ? matEval(r.mat, this.mprop[k]) : null;
        const vis = !r.broken && this.EA[r.node] && this.rEn[k] && this.rCol[k * 4 + 3] > 0.003 && !(mt && mt[4]) && !(mt && mt[3] <= 0.003);
        const v = r.v, nv = r.nv;
        if (!vis) {
          if (gpu) B.fill(0, bo + r.sb * 8, bo + (r.sb + (r.kind === 0 ? r.nSlots : r.bones.length)) * 8);
          else pos.fill(0, v * 3, (v + nv) * 3);
          continue;
        }
        let cr = this.rCol[k * 4], cg = this.rCol[k * 4 + 1], cb = this.rCol[k * 4 + 2], ca = this.rCol[k * 4 + 3];
        if (mt) { cr *= mt[0]; cg *= mt[1]; cb *= mt[2]; ca *= mt[3]; }
        const lc = this.lastCol, k4 = k * 4;
        if (lc[k4] !== cr || lc[k4 + 1] !== cg || lc[k4 + 2] !== cb || lc[k4 + 3] !== ca) {
          lc[k4] = cr; lc[k4 + 1] = cg; lc[k4 + 2] = cb; lc[k4 + 3] = ca;
          for (let j = 0; j < nv; j++) { const c = (v + j) * 4; col[c] = cr; col[c + 1] = cg; col[c + 2] = cb; col[c + 3] = ca; }
          this.colDirty = true;
        }
        const st = r.mat && ((this.mprop[k] && this.mprop[k]._MainTex_ST) || r.mat.p._MainTex_ST);
        if (st && (st[0] !== 1 || st[1] !== 1 || st[2] !== 0 || st[3] !== 0) && st[0] !== 0) {
          const tr = r.kind === 0 ? tp.sprites[this.rKey[k]].trect : r.trect;
          for (let j = v; j < v + nv; j++) { this.st.set(st, j * 4); this.trect.set(tr, j * 4); }
          this.stOn[k] = 1; this.stDirty = true;
        } else if (this.stOn[k]) {
          this.st.fill(0, v * 4, (v + nv) * 4);
          this.stOn[k] = 0; this.stDirty = true;
        }
        if (gpu) {
          if (r.kind === 0) {
            const n = r.nSlots;
            B.fill(0, bo + r.sb * 8, bo + (r.sb + n) * 8); // collapse the slots of the sprites not shown
            const ki = r.keyIdx[this.rKey[k]];
            if (ki == null) continue;
            const o = r.node * 12, d = bo + (r.sb + ki) * 8;
            const f = this.rFlip[k] ? -1 : 1, fy = this.rFlipY[k] ? -1 : 1;
            B[d] = W[o] * f; B[d + 1] = W[o + 1] * f; B[d + 2] = W[o + 3] * fy; B[d + 3] = W[o + 4] * fy;
            B[d + 4] = 0; B[d + 5] = 0; B[d + 6] = W[o + 9]; B[d + 7] = W[o + 10];
          } else {
            const nb = r.bones.length;
            for (let bi = 0; bi < nb; bi++) {
              const q = r.bones[bi] * 12, e = r.inv[bi], d = bo + (r.sb + bi) * 8;
              const w0 = W[q], w1 = W[q + 1], w3 = W[q + 3], w4 = W[q + 4], w6 = W[q + 6], w7 = W[q + 7], w9 = W[q + 9], w10 = W[q + 10];
              B[d] = w0 * e[0] + w3 * e[1] + w6 * e[2];
              B[d + 1] = w1 * e[0] + w4 * e[1] + w7 * e[2];
              B[d + 2] = w0 * e[4] + w3 * e[5] + w6 * e[6];
              B[d + 3] = w1 * e[4] + w4 * e[5] + w7 * e[6];
              B[d + 4] = w0 * e[8] + w3 * e[9] + w6 * e[10];
              B[d + 5] = w1 * e[8] + w4 * e[9] + w7 * e[10];
              B[d + 6] = w0 * e[12] + w3 * e[13] + w6 * e[14] + w9;
              B[d + 7] = w1 * e[12] + w4 * e[13] + w7 * e[14] + w10;
            }
          }
          continue;
        }
        if (r.kind === 0) {
          const key = this.rKey[k], s = tp.sprites[key], slot = r.slots[key];
          pos.fill(0, v * 3, (v + nv) * 3); // collapse the slots of the sprites not shown
          if (slot == null) continue;
          const o = r.node * 12;
          const m0 = W[o], m1 = W[o + 1], m3 = W[o + 3], m4 = W[o + 4], m9 = W[o + 9], m10 = W[o + 10];
          const f = this.rFlip[k] ? -1 : 1, fy = this.rFlipY[k] ? -1 : 1;
          const gv = s.gv, n2 = gv.length;
          const b = (v + slot) * 3;
          for (let j = 0, p = b; j < n2; j += 2, p += 3) {
            const x = gv[j] * f, y = gv[j + 1] * fy;
            pos[p] = m0 * x + m3 * y + m9; pos[p + 1] = m1 * x + m4 * y + m10;
          }
          if (this.lastKey[k] !== key) { this.lastKey[k] = key; uv.set(s.guv, (v + slot) * 2); this.uvDirty = true; }
        } else {
          // CPU skinning: M_b = World(bone) * inverse(bind); only x/y are needed
          const nb = r.bones.length;
          const M = this._skinM || (this._skinM = new Float32Array(128 * 8));
          for (let bi = 0; bi < nb; bi++) {
            const q = r.bones[bi] * 12, e = r.inv[bi], d = bi * 8;
            const w0 = W[q], w1 = W[q + 1], w3 = W[q + 3], w4 = W[q + 4], w6 = W[q + 6], w7 = W[q + 7], w9 = W[q + 9], w10 = W[q + 10];
            M[d] = w0 * e[0] + w3 * e[1] + w6 * e[2];
            M[d + 1] = w1 * e[0] + w4 * e[1] + w7 * e[2];
            M[d + 2] = w0 * e[4] + w3 * e[5] + w6 * e[6];
            M[d + 3] = w1 * e[4] + w4 * e[5] + w7 * e[6];
            M[d + 4] = w0 * e[8] + w3 * e[9] + w6 * e[10];
            M[d + 5] = w1 * e[8] + w4 * e[9] + w7 * e[10];
            M[d + 6] = w0 * e[12] + w3 * e[13] + w6 * e[14] + w9;
            M[d + 7] = w1 * e[12] + w4 * e[13] + w7 * e[14] + w10;
          }
          const P3 = r.pos, SI = r.si, SW = r.sw;
          for (let j = 0; j < nv; j++) {
            const px = P3[j * 3], py = P3[j * 3 + 1], pz = P3[j * 3 + 2];
            let X = 0, Y = 0;
            for (let n = 0; n < 4; n++) {
              const wgt = SW[j * 4 + n];
              if (!wgt) continue;
              const d = SI[j * 4 + n] * 8;
              X += wgt * (M[d] * px + M[d + 2] * py + M[d + 4] * pz + M[d + 6]);
              Y += wgt * (M[d + 1] * px + M[d + 3] * py + M[d + 5] * pz + M[d + 7]);
            }
            const b = (v + j) * 3;
            pos[b] = X; pos[b + 1] = Y; pos[b + 2] = 0;
          }
        }
      }
      const at = this.geo.attributes;
      if (gpu) BA.dirty = true;
      else at.position.needsUpdate = true;
      if (this.uvDirty) { at.uv.needsUpdate = true; this.uvDirty = false; }
      if (this.colDirty) { at.color.needsUpdate = true; this.colDirty = false; }
      if (this.stDirty) { at.st.needsUpdate = true; at.trect.needsUpdate = true; this.stDirty = false; }
    }

    setOrder(base) { this.mesh.renderOrder = base; }

    setTint(r, g, b) { for (const m of this.mats) m.color.setRGB(r, g, b); }

    setOpacity(a) { for (const m of this.mats) m.opacity = a; }

    dispose() {
      this.root.parent && this.root.parent.remove(this.root);
      this.geo.setIndex(null); // shared with the template (also the re-sorted ones)
      if (this.gpu) { ['position', 'sdI', 'sdW'].forEach((a) => this.geo.deleteAttribute(a)); baFree(this.boneRow, this.boneRows); } // static attributes are shared
      this.geo.dispose();
      for (const m of this.mats) m.dispose();
    }
  }

  // bounds of the idle pose (sprites only, additive glows excluded) used to normalise size
  function measure(tpl) {
    const c = new SDChar(tpl, { cpu: true });
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    tpl.rends.forEach((r, k) => {
      if (r.kind !== 0 || r.add || !c.EA[r.node] || !c.rEn[k] || c.rCol[k * 4 + 3] < 0.05) return;
      // full sprite rects (as before tight meshes) so unit sizes stay the same
      const s = tpl.sprites[c.rKey[k]], o = r.node * 12, W = c.W;
      if (!s) return;
      for (const [lx, ly] of [[s.x0, s.y0], [s.x1, s.y0], [s.x0, s.y1], [s.x1, s.y1]]) {
        const fx = c.rFlip[k] ? -lx : lx, fy = c.rFlipY[k] ? -ly : ly;
        const x = W[o] * fx + W[o + 3] * fy + W[o + 9], y = W[o + 1] * fx + W[o + 4] * fy + W[o + 10];
        x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
      }
    });
    if (!isFinite(x0)) { x0 = y0 = -1; x1 = y1 = 1; }
    // full-screen backdrops used by skill cut-ins (black quads etc.) would cover the whole field
    const huge = (y1 - y0) * 3;
    const W = c.W;
    const wscale = (n) => Math.max(Math.hypot(W[n * 12], W[n * 12 + 1]), Math.hypot(W[n * 12 + 3], W[n * 12 + 4]));
    tpl.rends.forEach((r) => {
      let ext = 0;
      if (r.kind === 0) {
        const sp = tpl.sprites[r.sr.s];
        if (sp) ext = Math.max(sp.x1 - sp.x0, sp.y1 - sp.y0) * wscale(r.node);
      } else if (r.um && !r.um.bones) {
        let mx = 0;
        for (let k = 0; k < r.pos.length; k += 3) mx = Math.max(mx, Math.abs(r.pos[k]), Math.abs(r.pos[k + 1]));
        ext = 2 * mx * wscale(r.node);
      }
      if (ext > huge) r.broken = true;
    });
    // safety net: a correctly bound skinned part sits near its own bones; drop the ones that don't
    const lim = (y1 - y0) * 0.3;
    tpl.rends.forEach((r) => {
      if (r.kind !== 1 || r.um) return; // exact Unity meshes need no sanity check
      let sx = 0, sy = 0, bx = 0, by = 0;
      for (let j = 0; j < r.nv; j++) { sx += c.pos[(r.v + j) * 3]; sy += c.pos[(r.v + j) * 3 + 1]; }
      for (const b of r.bones) { bx += c.W[b * 12 + 9]; by += c.W[b * 12 + 10]; }
      sx /= r.nv; sy /= r.nv; bx /= r.bones.length; by /= r.bones.length;
      if (Math.hypot(sx - bx, sy - by) > lim) r.broken = true;
    });
    c.dispose();
    tpl.box = { min: { x: x0, y: y0 }, max: { x: x1, y: y1 } };
    tpl.height = Math.max(0.01, y1 - y0);
  }

  const charPool = {};
  const POOL_TOTAL = 40;
  window.SD = {
    AXIS: [-1, 1, -1],
    gpuSkin: false, // the game turns this on when the renderer supports float vertex textures
    texScale: 1, // atlas upload scale (the game lowers it; tools keep full resolution)
    FORMAT: 1, // rig data format (tools/build_sd.py "fmt"); bump both together
    mipmaps: true, // the game turns this off on WebGL1 (NPOT atlases)
    crossfade: 0, // seconds of bone blending between clips (the game sets it; tools keep exact clip poses)
    renderer: null, // set by the game: lets evict() free GPU buffers explicitly
    pinRoot: false, // the game pins root motion in attack / skill clips (see pinRoot)
    pinSkip: null, // { rigId: [clip names] }: clips whose root motion is kept
    pinRange: 0, // rig units of root travel kept (softly) by pinned clips
    pinRanges: null, // { rigId: rig units }: a tighter range for some rigs (units that dash to their target)
    prepare,
    create(id) { const t = templates[id]; return t ? new SDChar(t) : null; },
    // pooled instances for short-lived rigs (enemies): no typed arrays / materials / textures per spawn
    acquire(id) {
      const p = charPool[id];
      if (p && p.length) {
        const c = p.pop();
        c.speed = 1; c.onEnd = null; c.loop = false;
        c.setTint(1, 1, 1); c.setOpacity(1);
        c.root.position.set(0, 0, 0); c.root.scale.set(1, 1, 1); c.root.visible = true;
        c.clip = null; // a reused instance starts clean (no crossfade from its previous life)
        c.play('idle');
        return c;
      }
      return SD.create(id);
    },
    release(c) {
      if (!c) return;
      c.root.parent && c.root.parent.remove(c.root);
      const p = charPool[c.tpl.id] || (charPool[c.tpl.id] = []);
      let total = 0;
      for (const k in charPool) total += charPool[k].length;
      if (p.length < 24 && total < POOL_TOTAL) p.push(c); else c.dispose();
    },
    // forget a rig entirely (phones, once its wave is over): pooled instances, atlas texture, template, source data.
    // The caller guarantees no live instance uses it; SD.prepare() loads it again if it comes back.
    evict(id) {
      const t = templates[id];
      if (!t) return;
      (charPool[id] || []).forEach((c) => c.dispose());
      delete charPool[id];
      t.atlas.tex.dispose();
      // the per-rig static attributes / cached index buffers: dispose through a throwaway geometry
      const geos = [];
      const g = new THREE.BufferGeometry();
      if (t.gpu) { g.setAttribute('position', t.gpu.lp); g.setAttribute('sdI', t.gpu.si); g.setAttribute('sdW', t.gpu.sw); }
      if (t.index) g.setIndex(t.index);
      geos.push(g);
      Object.values(t.idxCache || {}).forEach(([ix]) => { if (ix !== t.index) { const h = new THREE.BufferGeometry(); h.setIndex(ix); geos.push(h); } });
      gpuRelease(geos);
      delete templates[id]; delete pending[id];
      if (window.SD_DATA) delete SD_DATA[id];
    },
    // 전투 시뮬레이터: 리그 파일 위치(sd/chars = 라켓몬스터 바이오로이드, sd/mobs = 디펜스 철충). 원본은 'js/sd/' 고정.
    dir(id) { return SD.dirs ? SD.dirs(id) : 'js/sd/'; },
    loaded() { return Object.keys(templates); },
    // keep pooled instances only for the rigs still to come (called on wave change); the rest free their GPU objects
    trimPool(keepIds) {
      for (const id in charPool) {
        if (keepIds.includes(id)) continue;
        for (const c of charPool[id]) c.dispose();
        charPool[id].length = 0;
      }
    },
    ready(id) { return !!templates[id]; },
    template(id) { return templates[id]; },
  };
})();
