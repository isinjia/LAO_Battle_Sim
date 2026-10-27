// 배포판 dist/ 만들기. Cloudflare Workers Builds 가 `npx wrangler deploy` 를 돌릴 때 wrangler.jsonc 의 build.command 로 먼저 실행된다.
// - 실험 시뮬레이터에 필요한 파일만 담는다(도구·보고서·옛 LO 전투 시뮬레이터 제외)
// - 코드 파일은 terser 로 압축·지역 이름 줄이기 뒤 javascript-obfuscator 로 한 번 더 뒤섞는다(전역 이름은 유지)
// - 이미지는 바이트 마스킹한 <파일>.pak 으로 바꾼다(sandbox-pack.js 가 브라우저 메모리에서 되돌린다)
// 저장소와 로컬 실행은 읽을 수 있는 원본 그대로다.
//   node tools/build_dist.mjs            (배포판 만들기)
//   node tools/build_dist.mjs --plain    (압축·난독화 없이 이미지 마스킹만: 문제 원인 가를 때)
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'dist');
const PLAIN = process.argv.includes('--plain');

async function loadTool(name, version, entry) {
  const file = path.join(ROOT, 'node_modules', name, entry);
  if (!fs.existsSync(file)) execSync(`npm install --no-save --no-audit --no-fund ${name}@${version}`, { cwd: ROOT, stdio: 'inherit' });
  return import(pathToFileURL(file).href);
}

// 담을 파일·폴더
const FILES = ['index.html', 'sandbox.html', 'sd/sd.js', 'sd/charmap.js', 'ui/sprites.json', 'ui/layout_1920.json', 'ui/layout_2340.json', 'ui/layout_2400.json', 'ui/detail.json'];
const DIRS = ['engine', 'data', 'sd/chars', 'sd/mobs', 'ui/sprites', 'ui/skill', 'ui/tbar', 'ui/inven', 'ui/bg'];
const CODE = (rel) => /^(sandbox-[\w-]+\.js|engine\/[\w-]+\.js|sd\/sd\.js)$/.test(rel); // 압축·난독화 대상
const TERSER = {
  ecma: 2020,
  compress: { passes: 2, keep_classnames: true, keep_fnames: true },
  mangle: { keep_classnames: true, keep_fnames: true }, // 지역 이름만. 전역(CORE, SCENE, WM …)과 속성 이름은 그대로
  format: { comments: false },
};
// 가벼운 난독화: 문자열을 표로 빼고 이름을 16진수로 바꾼다. 흐름 평탄화·죽은 코드는 전투 계산 속도를 떨어뜨려 쓰지 않는다.
const OBF = {
  compact: true, simplify: true, renameGlobals: false, identifierNamesGenerator: 'hexadecimal', seed: 20261027, // 같은 입력이면 같은 결과
  stringArray: true, stringArrayThreshold: 0.6, stringArrayEncoding: ['base64'], stringArrayRotate: true, stringArrayShuffle: true,
  splitStrings: false, controlFlowFlattening: false, deadCodeInjection: false, selfDefending: false, debugProtection: false,
  disableConsoleOutput: false, unicodeEscapeSequence: false, target: 'browser',
};

function copyTree(rel) {
  const src = path.join(ROOT, rel), dst = path.join(OUT, rel);
  if (fs.statSync(src).isDirectory()) {
    fs.mkdirSync(dst, { recursive: true });
    for (const f of fs.readdirSync(src)) copyTree(path.posix.join(rel, f));
  } else { fs.mkdirSync(path.dirname(dst), { recursive: true }); fs.copyFileSync(src, dst); }
}
function walk(dir, fn) {
  for (const f of fs.readdirSync(dir)) {
    const p = path.join(dir, f);
    if (fs.statSync(p).isDirectory()) walk(p, fn); else fn(p, f);
  }
}

// ── 이미지 마스킹(sandbox-pack.js 와 같은, 자기 자신이 역함수인 바이트 마스크) ──
const K = Array.from('LAO-battle-sim-2026', (c) => c.charCodeAt(0));
function mask(buf) {
  const u8 = new Uint8Array(buf);
  for (let i = 0; i < u8.length; i++) u8[i] ^= K[i % K.length] ^ ((i * 131 + 7) & 255);
  return u8;
}
function packImages() {
  let files = 0;
  for (const rel of ['sd/chars', 'sd/mobs', 'ui']) walk(path.join(OUT, rel), (p, f) => {
    if (!/\.(webp|jpe?g|png)$/i.test(f)) return;
    fs.writeFileSync(p + '.pak', mask(fs.readFileSync(p)));
    fs.rmSync(p); files++;
  });
  // 되돌리기 켜기: 다른 스크립트보다 먼저 실행되는 인라인 스크립트
  const htmlFile = path.join(OUT, 'sandbox.html');
  fs.writeFileSync(htmlFile, fs.readFileSync(htmlFile, 'utf8').replace('<head>', '<head>\n<script>window.PACK=1</script>'));
  return files;
}

async function main() {
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  for (const f of FILES) copyTree(f);
  for (const d of DIRS) copyTree(d);
  for (const f of fs.readdirSync(ROOT)) if (/^sandbox-[\w-]+\.js$/.test(f)) copyTree(f);
  // file:// 용 아틀라스 스크립트 사본(.a35.js/.a50.js)과 쓰지 않는 배율은 배포에 넣지 않는다
  let dropped = 0;
  for (const rel of ['sd/chars', 'sd/mobs']) for (const f of fs.readdirSync(path.join(OUT, rel))) if (/\.a\d+\.js$/.test(f) || /\.a35\.webp$/.test(f)) { fs.rmSync(path.join(OUT, rel, f)); dropped++; }
  const packed = packImages();

  const htmlFile = path.join(OUT, 'sandbox.html');
  let html = fs.readFileSync(htmlFile, 'utf8').replace(/<!--[\s\S]*?-->/g, '');
  let scripts = [];
  walk(OUT, (p) => { const rel = path.relative(OUT, p).split(path.sep).join('/'); if (CODE(rel)) scripts.push(rel); });
  let before = 0, after = 0, inline = 0;
  if (!PLAIN) {
    const { minify } = await loadTool('terser', '5.31.0', 'main.js');
    const Obf = (await loadTool('javascript-obfuscator', '4.1.1', 'dist/index.js')).default;
    const squeeze = async (code, label) => {
      const t = await minify(code, TERSER);
      if (t.code == null) throw new Error('terser 실패: ' + label);
      // 인라인 스크립트 안에 "</script" 가 그대로 남으면 페이지 파서가 거기서 스크립트를 끊어 버린다(난독화 결과가 무작위라 가끔 생김)
      return Obf.obfuscate(t.code, OBF).getObfuscatedCode().replace(/<\/script/gi, '<\\/script');
    };
    for (const rel of scripts) {
      const file = path.join(OUT, rel), code = fs.readFileSync(file, 'utf8');
      const out = await squeeze(code, rel);
      fs.writeFileSync(file, out);
      before += code.length; after += out.length;
    }
    // 페이지 안의 인라인 스크립트도 같이(되돌리기 스위치 한 줄은 제외)
    for (const m of [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)]) {
      if (/^\s*window\.PACK=1\s*$/.test(m[1])) continue;
      const out = await squeeze(m[1], '인라인 스크립트');
      html = html.replace(m[0], () => '<script>' + out + '</script>');
      inline++;
    }
  }
  fs.writeFileSync(htmlFile, html);
  console.log(`dist: 코드 ${scripts.length}개${PLAIN ? ' (압축 없음)' : ` 압축·난독화 (${Math.round(before / 1024)} KB -> ${Math.round(after / 1024)} KB)`}, 이미지 ${packed}개 마스킹, 불필요 파일 ${dropped}개 제외`);
}

main().catch((e) => { console.error(e); process.exit(1); });
