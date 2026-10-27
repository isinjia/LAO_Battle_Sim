// =====================================================================================================
//  배포판 이미지 보호 — tools/build_dist.mjs 가 이미지를 바이트 마스킹한 <파일>.pak 으로 내보내면, 브라우저에서
//  여기서 되돌려 메모리의 blob: 주소로 그린다. 네트워크 탭·주소 직접 열기·"이미지 저장"에는 그림이 아닌 데이터만 보인다.
//  window.PACK 이 없으면(로컬 개발) 모든 경로를 그대로 통과시킨다. 가볍게 퍼 가는 것을 막는 장치이지 자물쇠는 아니다.
// =====================================================================================================
(function () {
  const on = !!window.PACK && /^https?:$/.test(location.protocol);
  const K = Array.from('LAO-battle-sim-2026', (c) => c.charCodeAt(0));
  // tools/build_dist.mjs 와 같은 마스크(자기 자신이 역함수)
  function unmask(u8) {
    for (let i = 0; i < u8.length; i++) u8[i] ^= K[i % K.length] ^ ((i * 131 + 7) & 255);
    return u8;
  }
  const pakUrl = (u) => { const q = u.indexOf('?'); return q < 0 ? u + '.pak' : u.slice(0, q) + '.pak' + u.slice(q); };
  const mimeOf = (u) => /\.jpe?g(\?|$)/i.test(u) ? 'image/jpeg' : /\.png(\?|$)/i.test(u) ? 'image/png' : 'image/webp';
  const packedPath = (u) => typeof u === 'string' && /^(sd\/(chars|mobs)|ui)\//.test(u) && /\.(webp|jpe?g|png)(\?|$)/i.test(u);
  // 이미지 주소 -> 그릴 수 있는 주소(배포판이면 .pak 을 받아 되돌린 blob: 주소, 아니면 그대로)
  async function src(u) {
    if (!on || !packedPath(u)) return u;
    const r = await fetch(pakUrl(u));
    if (!r.ok) throw new Error('pack ' + r.status + ' ' + u);
    return URL.createObjectURL(new Blob([unmask(new Uint8Array(await r.arrayBuffer()))], { type: mimeOf(u) }));
  }
  // Image 에 주소를 건다: blob: 주소는 읽은 뒤 바로 해제해 개발자 도구에서 다시 열 수 없게
  function setSrc(img, u) {
    if (!on || !packedPath(u)) { img.src = u; return; }
    src(u).then((b) => {
      const done = () => { img.removeEventListener('load', done); img.removeEventListener('error', done); setTimeout(() => URL.revokeObjectURL(b), 0); };
      img.addEventListener('load', done); img.addEventListener('error', done);
      img.src = b;
    }).catch(() => { img.dispatchEvent(new Event('error')); });
  }
  window.PACKED = { on, src, setSrc, unmask, pakUrl };
})();
