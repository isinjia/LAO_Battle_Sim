// 원문복원_시험.js를 여러 프로세스로 나눠 실행하고 결과를 하나로 합친다.
//   node tools/원문복원_병렬.js --cases <시험입력.json> --out <결과.json> [--jobs 48] [--seeds 1-10] [--run-timeout-ms 30000]
'use strict';
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const args = process.argv.slice(2);
const arg = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const cases = JSON.parse(fs.readFileSync(arg('--cases'), 'utf8'));
const out = path.resolve(arg('--out'));
const jobs = Math.min(+arg('--jobs', 48), cases.length);
const dir = out.replace(/\.json$/, '') + '_조각';
fs.mkdirSync(dir, { recursive: true });
let left = jobs;
const t0 = Date.now();
for (let j = 0; j < jobs; j++) {
  const part = cases.filter((_, i) => i % jobs === j);
  const cin = path.join(dir, 'in' + j + '.json'), cout = path.join(dir, 'out' + j + '.json');
  fs.writeFileSync(cin, JSON.stringify(part));
  const p = spawn(process.execPath, [path.join(__dirname, '원문복원_시험.js'), '--cases', cin, '--out', cout, '--seeds', arg('--seeds', '1-10'), '--run-timeout-ms', arg('--run-timeout-ms', '30000')],
    { stdio: ['ignore', fs.openSync(path.join(dir, 'log' + j + '.txt'), 'w'), fs.openSync(path.join(dir, 'err' + j + '.txt'), 'w')] });
  p.on('exit', (code) => {
    if (code) console.log('조각 ' + j + ' 종료 코드 ' + code);
    if (--left) return;
    const results = [];
    let meta = null;
    for (let k = 0; k < jobs; k++) { const f = path.join(dir, 'out' + k + '.json'); if (!fs.existsSync(f)) { console.log('조각 ' + k + ' 결과 없음'); continue; } const d = JSON.parse(fs.readFileSync(f, 'utf8')); meta = meta || d; results.push(...d.results); }
    const order = new Map(cases.map((c, i) => [c.id, i]));
    results.sort((a, b) => order.get(a.id) - order.get(b.id));
    fs.writeFileSync(out, JSON.stringify(Object.assign({}, meta, { results }), null, 1));
    console.log('완료', results.length, '건', Math.round((Date.now() - t0) / 1000) + '초');
  });
}
