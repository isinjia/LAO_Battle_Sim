// 배포(Cloudflare Workers) 앞단. 정적 자산(dist/)을 내보내기 전에 다음을 막는다.
// - 이미지·리그·자료 파일을 주소창에 직접 입력해 여는 것(문서로 열기)
// - 다른 사이트 페이지에서 끌어다 쓰는 것(교차 사이트 요청)
// 시뮬레이터 페이지 안에서 스크립트가 받는 요청(같은 출처, 문서 아님)만 통과한다.
const PROTECTED = /\.(pak|webp|png|jpe?g|json|js)$/i;
const PAGE = /^\/($|index\.html$|sandbox\.html$)/;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (PROTECTED.test(url.pathname) && !PAGE.test(url.pathname)) {
      const dest = request.headers.get('Sec-Fetch-Dest') || '';
      const site = request.headers.get('Sec-Fetch-Site') || '';
      const referer = request.headers.get('Referer') || '';
      const sameOrigin = site === 'same-origin' || (!site && referer.startsWith(url.origin + '/'));
      if (dest === 'document' || site === 'cross-site' || !sameOrigin) return new Response('Not found', { status: 404 });
    }
    const res = await env.ASSETS.fetch(request);
    const h = new Headers(res.headers);
    h.set('X-Robots-Tag', 'noindex, nofollow');
    h.set('X-Content-Type-Options', 'nosniff');
    if (PROTECTED.test(url.pathname)) h.set('Cache-Control', 'private, max-age=3600');
    return new Response(res.body, { status: res.status, headers: h });
  },
};
