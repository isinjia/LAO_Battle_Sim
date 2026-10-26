// Headless character mechanic audit ("캐릭터 점검"), same logic as the browser tab (audit-core.js).
//   node tools/audit_node.js [--limit N] [--char <key|name substring>] [--no-static] [--no-runtime]
//        [--grade max|start|N] [--level 90] [--skill-level 10] [--actions 42] [--seed 1] [--solo]
//        [--extract-desc]   (re)build data/skilldesc.json from Assets/LastOneTable/LoJson.js.bytes and exit
// Writes tools/out/audit-<stamp>.json / .md and tools/out/audit-latest.json / .md, prints a summary.
// data/skilldesc.json (skill / buff effect description texts) is rebuilt automatically when missing or older than LoJson.
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

global.window = global;
global.fengari = require('fengari');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(__dirname, 'out');
const DESC = path.join(ROOT, 'data', 'skilldesc.json');

function projectRoot() {
  try { const m = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'meta.json'), 'utf8')); if (m.projectPath && fs.existsSync(m.projectPath)) return m.projectPath; } catch (e) { /* fall through */ }
  return path.join(ROOT, '..');
}
const LOJSON = path.join(projectRoot(), 'Assets', 'LastOneTable', 'LoJson.js.bytes');

// ---------------------------------------------------------------- description extraction (read-only on Assets)
function extractDesc() {
  if (!fs.existsSync(LOJSON)) { console.log('LoJson not found, description checks skipped: ' + LOJSON); return null; }
  let s = fs.readFileSync(LOJSON, 'utf8');
  if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);
  const d = JSON.parse(s);
  s = null;
  const loc = {};
  for (const r of d.Table_Localization || []) loc[r.Key] = r.Korea;
  const by = (t) => { const o = {}; for (const r of d[t] || []) o[r.Key] = r; return o; };
  const PC = by('Table_PC'), SG = by('Table_SkillGroup'), SK = by('Table_Skill'), SL = by('Table_SkillLevel'), BE = by('Table_BuffEffect');
  const L = (k) => (k && k !== '0' && loc[k] ? loc[k] : '');
  const out = { meta: { source: 'Assets/LastOneTable/LoJson.js.bytes', builtAt: new Date().toISOString(), sourceMtime: fs.statSync(LOJSON).mtime.toISOString() }, skills: {}, buffs: {} };
  const addSkill = (k) => {
    if (!k || k === '0' || out.skills[k] || !SK[k]) return;
    const r = SK[k];
    out.skills[k] = { n: L(r.SkillName), d: L(r.SkillDescription), s: L(r.SkillDescriptionSimple) };
    for (let lv = 1; lv <= (r.MaxSkillLevel || 1); lv++) {
      const l = SL[k + '_Lv' + lv];
      if (!l) continue;
      for (const b of l.BuffEffectIndex || []) {
        if (!b || b === '0' || out.buffs[b] || !BE[b]) continue;
        const be = BE[b];
        const dd = [1, 2, 3, 4, 5].map((i) => L(be['BuffEffectType' + i + '_Desc']));
        if (dd.some(Boolean)) out.buffs[b] = { d: dd };
      }
    }
    if (r.DelaySkillKeyString) addSkill(r.DelaySkillKeyString);
    if (r.Matching_Skill_FormChange) addSkill(r.Matching_Skill_FormChange);
  };
  for (const p of Object.values(PC)) {
    const g = SG[p.SkillGroupIndex];
    if (!g) continue;
    for (let i = 1; i <= 10; i++) addSkill(g['SkillIndex' + i]);
  }
  fs.writeFileSync(DESC, JSON.stringify(out));
  console.log(`data/skilldesc.json: ${Object.keys(out.skills).length} skills, ${Object.keys(out.buffs).length} buff effects (${Math.round(fs.statSync(DESC).size / 1024)} KB)`);
  return out;
}
function loadDesc(force) {
  const stale = !fs.existsSync(DESC) || (fs.existsSync(LOJSON) && fs.statSync(LOJSON).mtimeMs > fs.statSync(DESC).mtimeMs);
  if (force || stale) return extractDesc();
  return JSON.parse(fs.readFileSync(DESC, 'utf8'));
}

// ---------------------------------------------------------------- engine
function loadEngine() {
  for (const m of ['enums', 'core']) vm.runInThisContext(fs.readFileSync(path.join(ROOT, 'engine', m + '.js'), 'utf8'), { filename: m + '.js' });
  const L = window.LOSim;
  L.data = {};
  for (const f of ['stages', 'units', 'skills', 'buffs', 'loc', 'lua']) L.data[f] = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', f + '.json'), 'utf8'));
  for (const m of ['stats', 'buffs', 'combat', 'ai', 'battle']) vm.runInThisContext(fs.readFileSync(path.join(ROOT, 'engine', m + '.js'), 'utf8'), { filename: m + '.js' });
  vm.runInThisContext(fs.readFileSync(path.join(ROOT, 'audit-core.js'), 'utf8'), { filename: 'audit-core.js' });
  return L;
}

function main() {
  const argv = process.argv.slice(2);
  const flag = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : d; };
  const has = (n) => argv.includes(n);
  if (has('--extract-desc')) { extractDesc(); return; }
  const desc = loadDesc(false);
  const L = loadEngine();
  const A = L.audit;
  let pcs = A.listPCs();
  const q = flag('--char');
  if (q) { const terms = q.split(',').map((x) => x.trim().toLowerCase()).filter(Boolean); pcs = pcs.filter((p) => terms.some((t) => p.key.toLowerCase() === t || (p.key + ' ' + p.name).toLowerCase().includes(t))); }
  const lim = parseInt(flag('--limit', '0'), 10);
  if (lim > 0) pcs = pcs.slice(0, lim);
  const g = flag('--grade', 'max');
  const opts = Object.assign({}, A.DEFAULTS, {
    grade: /^\d+$/.test(g) ? +g : g, level: +flag('--level', 90), skillLevel: +flag('--skill-level', 10), actions: +flag('--actions', 42), seed: +flag('--seed', 1),
    includeStatic: !has('--no-static'), includeRuntime: !has('--no-runtime'), squad: !has('--solo'),
  });
  console.log(`audit ${pcs.length} characters · grade ${opts.grade} · Lv${opts.level} · skill Lv${opts.skillLevel} · static ${opts.includeStatic} · runtime ${opts.includeRuntime} (${opts.actions} actions) · desc ${desc ? 'yes' : 'no'}`);
  const results = [];
  const t0 = Date.now();
  pcs.forEach((p, i) => {
    const r = A.auditCharacter(p.key, opts, desc);
    results.push(r);
    const c = r.counts;
    process.stdout.write(`[${String(i + 1).padStart(3)}/${pcs.length}] ${r.verdict.padEnd(7)} E${c.error} S${c.suspect} U${c.unverified} L${c.simlimit} I${c.info}  ${p.name} (${p.key}) ${r.ms}ms\n`);
  });
  const ms = Date.now() - t0;
  let meta = null;
  try { const m = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'meta.json'), 'utf8')); meta = { dataRevision: m.svnRevision, extractedAt: m.extractedAt, logicPortRevision: m.logicPortRevision }; } catch (e) { /* none */ }
  const info = { generatedAt: new Date().toISOString(), opts, meta, elapsedMs: ms };
  fs.mkdirSync(OUT, { recursive: true });
  const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
  const json = JSON.stringify({ info, summary: A.summarize(results), results }, null, 1);
  const md = A.markdown(results, Object.assign({ maxRows: 2000 }, info));
  for (const n of ['audit-' + stamp, 'audit-latest']) { fs.writeFileSync(path.join(OUT, n + '.json'), json); fs.writeFileSync(path.join(OUT, n + '.md'), md); }
  const s = A.summarize(results);
  console.log(`\n---- ${s.chars} characters in ${(ms / 1000).toFixed(1)}s: ok ${s.ok} · suspect ${s.suspectChars} · error ${s.errorChars} · with unverified ${s.unverifiedChars}`);
  console.log(`findings: error ${s.findings.error} · suspect ${s.findings.suspect} · unverified ${s.findings.unverified} · simlimit ${s.findings.simlimit} · info ${s.findings.info}`);
  for (const [k, v] of Object.entries(s.byCode).sort((a, b) => b[1] - a[1])) console.log(`  ${String(v).padStart(5)}  ${k}`);
  console.log('report: ' + path.join(OUT, 'audit-' + stamp + '.md'));
}
main();
