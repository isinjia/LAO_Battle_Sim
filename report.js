// Builds a readable report of a live-play session: a self-contained HTML file (to read or share)
// and a Markdown version (to paste into Claude / Codex). Input is the record live.js keeps.
(function () {
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const OUT_KO = { win: '승리', lose: '패배', stuck: '진행불가', error: '오류(크래시)', timeout: '시간초과' };
  const ISSUE_TYPES = [
    { key: 'crash', label: '클라이언트 크래시 후보', test: (t) => /counter가 null|엔진 예외|Lua AI 오류|NullReference/.test(t) },
    { key: 'freeze', label: '진행불가·교착', test: (t) => /교착|진행불가|최대 행동 수/.test(t) },
    { key: 'approach', label: '몬스터 미접근 (IsUseSkillPos_Preview)', test: (t) => /IsUseSkillPos_Preview/.test(t) },
    { key: 'apstop', label: '행동불가 미해제 (AP_STOP)', test: (t) => /STAGE_AP_STOP/.test(t) },
    { key: 'mindmg', label: '최소 피해(1) 반복', test: (t) => /최소 피해/.test(t) },
    { key: 'wait', label: '연속 대기', test: (t) => /연속 대기/.test(t) },
  ];
  const typeOf = (t) => (ISSUE_TYPES.find((x) => x.test(t)) || { key: 'etc', label: '기타' });

  // ---------- analysis shared by both formats ----------
  function analyze(rec, issues) {
    const stages = new Map();
    for (const b of rec.battles) {
      const s = stages.get(b.stageKey) || { stageKey: b.stageKey, stage: b.stage, attempts: 0, outcomes: [], firstLevel: b.squadLevel, finalLevel: b.squadLevel, final: null, actions: 0, issues: 0 };
      s.attempts++; s.outcomes.push(b.outcome); s.finalLevel = b.squadLevel; s.final = b.outcome; s.actions += b.totalActions || 0; s.issues += (b.issues || []).length;
      stages.set(b.stageKey, s);
    }
    const list = [...stages.values()];
    const walls = list.filter((s) => s.final !== 'win' && s.outcomes.includes('lose') && !s.outcomes.some((o) => o === 'stuck' || o === 'error'));
    const retries = list.filter((s) => s.final === 'win' && s.attempts > 1);
    const broken = list.filter((s) => s.outcomes.some((o) => o === 'stuck' || o === 'error' || o === 'timeout'));
    const grouped = {};
    for (const i of issues) { const t = typeOf(i.text); (grouped[t.key] = grouped[t.key] || { label: t.label, items: [] }).items.push(i); }
    const conclusions = [];
    const cleared = list.filter((s) => s.final === 'win').length;
    conclusions.push(`${list.length}개 스테이지 중 ${cleared}개 클리어, ${walls.length}개 벽(최대 도전까지 패배), ${broken.length}개에서 진행불가·오류·시간초과 발생.`);
    if (retries.length) conclusions.push(`재도전 끝에 클리어한 스테이지: ${retries.map((s) => `${s.stage} (Lv${s.firstLevel}→Lv${s.finalLevel}, ${s.attempts}회)`).join(', ')}.`);
    if (walls.length) conclusions.push(`벽: ${walls.map((s) => `${s.stage} (Lv${s.finalLevel}까지 ${s.attempts}회 패배)`).join(', ')}.`);
    for (const k of ['crash', 'freeze', 'approach', 'apstop']) {
      const g = grouped[k];
      if (g) conclusions.push(`${g.label}: ${g.items.length}건 (${[...new Set(g.items.map((i) => i.stage || i.stageKey))].join(', ')}).`);
    }
    if (grouped.mindmg) conclusions.push(`최소 피해(1)만 들어가는 전투: ${[...new Set(grouped.mindmg.items.map((i) => i.stage || i.stageKey))].join(', ')} — 해당 구간의 몬스터 방어력·피해 감소 버프 수치 점검 대상.`);
    return { stages: list, walls, retries, broken, grouped, conclusions, cleared };
  }

  const settingsText = (s) => s ? `${s.scenario === 'campaign' ? '스토리 캠페인' : '단일 스테이지'} · ${String(s.fromChapter || '').replace('Chapter_', '')} ~ ${String(s.toChapter || '').replace('Chapter_', '')} · 시작 Lv${s.startLevel} · 패배 시 +${s.levelStepOnLoss} · 최대 ${s.maxAttempts}회 · 사이드 ${s.includeSideStages ? '포함' : '제외'} · 시드 ${s.seed}` : '';
  const simText = (m) => m ? `데이터 r${m.dataRevision} (${m.extractedAt}) · 전투 로직 r${m.logicPortRevision} 기준${m.logicChangedSincePort && m.logicChangedSincePort.length ? ` · 미반영 로직 변경 ${m.logicChangedSincePort.length}건` : ''}` : '';

  // ---------- HTML ----------
  function html(rec, issues, opts) {
    const A = analyze(rec, issues);
    const squad = (rec.battles[0] && rec.battles[0].squad) || [];
    const kpi = (v, l) => `<div class="kpi"><b>${esc(v)}</b><span>${esc(l)}</span></div>`;
    const pill = (o) => `<span class="pill o-${esc(o)}">${esc(OUT_KO[o] || o)}</span>`;
    let h = `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>라이브 플레이 리포트 ${esc((rec.generatedAt || '').slice(0, 10))}</title><style>
:root{--bg:#f4f5f3;--panel:#fff;--panel2:#f7f8f6;--ink:#15181a;--ink2:#4b5155;--ink3:#80878c;--rule:#dfe2df;--accent:#c2410c;--win:#15803d;--lose:#b91c1c;--stuck:#a16207;--err:#7e22ce;--timeout:#475569;color-scheme:light}
@media (prefers-color-scheme:dark){:root{--bg:#111315;--panel:#191c1f;--panel2:#1f2326;--ink:#eceeee;--ink2:#b6bcbf;--ink3:#868d92;--rule:#2c3135;--accent:#f07a3e;--win:#4ade80;--lose:#f87171;--stuck:#facc15;--err:#c084fc;--timeout:#94a3b8;color-scheme:dark}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.6 "Malgun Gothic","Apple SD Gothic Neo",system-ui,sans-serif}
main{max-width:1100px;margin:0 auto;padding:28px max(16px,env(safe-area-inset-left)) 60px;display:grid;gap:22px}
h1{margin:0;font-size:24px}h2{margin:0 0 10px;font-size:17px}h3{margin:0;font-size:15px}.meta{color:var(--ink3);font-size:12px;font-family:Consolas,monospace}
section{background:var(--panel);border:1px solid var(--rule);border-radius:8px;padding:16px;min-width:0}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px}.kpi{background:var(--panel2);border-radius:6px;padding:10px 12px;display:grid}.kpi b{font-size:22px}.kpi span{font-size:12px;color:var(--ink3)}
ul{margin:0;padding-left:20px;display:grid;gap:4px}.tw{overflow-x:auto}table{border-collapse:collapse;width:100%;font-size:13px}th,td{text-align:left;padding:6px 8px;border-bottom:1px solid var(--rule);vertical-align:top}th{color:var(--ink3);font-weight:500;white-space:nowrap}td.n,th.n{text-align:right;white-space:nowrap}
.pill{display:inline-block;padding:0 6px;border-radius:4px;font-size:11px;border:1px solid currentColor;white-space:nowrap}.o-win{color:var(--win)}.o-lose{color:var(--lose)}.o-stuck{color:var(--stuck)}.o-error{color:var(--err)}.o-timeout{color:var(--timeout)}
details{border-top:1px solid var(--rule);padding:8px 0}details>summary{cursor:pointer;display:flex;gap:8px;align-items:center;flex-wrap:wrap}details[open]>summary{margin-bottom:10px}
.log{max-height:520px;overflow:auto;background:var(--panel2);border-radius:6px;padding:8px;font-size:12px;display:grid;gap:3px}
.l{padding:2px 6px;border-left:3px solid transparent;white-space:pre-wrap;word-break:break-word}.l-ours{border-color:var(--win)}.l-theirs{border-color:var(--lose)}.l-issue{border-color:var(--stuck);background:rgba(250,204,21,.12)}.l-stage{border-color:var(--ink3);font-weight:600}.l-claude{border-color:var(--err)}
.note{color:var(--ink3);font-size:12px}.claude{white-space:pre-wrap}.grp{margin-top:12px}
</style></head><body><main>
<header><h1>라이브 플레이 리포트</h1><div class="meta">생성 ${esc((rec.generatedAt || '').replace('T', ' ').slice(0, 19))} · ${esc(simText(rec.simulator))}</div>
<div class="meta">${esc(settingsText(rec.settings))}</div>
<div class="meta">분대: ${esc(squad.map((s) => `${s.name}(${s.gridPos + 1}칸 G${s.grade})`).join(', '))}</div></header>
<section><h2>요약</h2><div class="kpis">${kpi(A.stages.length, '진행한 스테이지')}${kpi(A.cleared, '클리어')}${kpi(A.walls.length, '벽 (클리어 실패)')}${kpi(A.broken.length, '진행불가·오류 발생')}${kpi(issues.length, '감지된 문제')}${kpi(rec.battles.length, '총 전투 수')}</div></section>
<section><h2>결론</h2><ul>${A.conclusions.map((c) => `<li>${esc(c)}</li>`).join('')}</ul>
${rec.claudeSummary ? `<h3 style="margin-top:14px">Claude 종합 분석</h3><div class="claude">${esc(rec.claudeSummary)}</div>` : ''}</section>
<section><h2>스테이지 결과</h2><div class="tw"><table><thead><tr><th>스테이지</th><th>키</th><th>최종</th><th class="n">도전</th><th>레벨</th><th>시도별 결과</th><th class="n">총 행동</th><th class="n">문제</th></tr></thead><tbody>
${A.stages.map((s) => `<tr><td>${esc(s.stage)}</td><td class="note">${esc(s.stageKey)}</td><td>${pill(s.final)}</td><td class="n">${s.attempts}</td><td>${s.firstLevel === s.finalLevel ? 'Lv' + s.finalLevel : `Lv${s.firstLevel}→${s.finalLevel}`}</td><td>${s.outcomes.map((o) => esc(OUT_KO[o] || o)).join(' → ')}</td><td class="n">${s.actions}</td><td class="n">${s.issues}</td></tr>`).join('')}
</tbody></table></div></section>
<section><h2>감지된 문제 (${issues.length}건)</h2>`;
    const order = [...ISSUE_TYPES.map((t) => t.key), 'etc'];
    for (const k of order) {
      const g = A.grouped[k];
      if (!g) continue;
      h += `<div class="grp"><h3>${esc(g.label)} · ${g.items.length}건</h3><div class="tw"><table><thead><tr><th>스테이지</th><th>내용</th><th class="n">횟수</th></tr></thead><tbody>${g.items.map((i) => `<tr><td>${esc(i.stage || i.stageKey)}</td><td>${esc(i.text)}</td><td class="n">${i.occurrences || 1}</td></tr>`).join('')}</tbody></table></div></div>`;
    }
    if (!issues.length) h += '<p class="note">감지된 문제가 없습니다.</p>';
    h += `</section><section><h2>전투별 상세 (AI 생각 기록 포함)</h2><p class="note">펼치면 해당 전투의 유닛 최종 상태, 감지된 문제, 행동마다의 AI 판단 기록이 시간 순서로 나옵니다.</p>`;
    rec.battles.forEach((b) => {
      const lines = b.lines || [];
      h += `<details${b.outcome && b.outcome !== 'win' && opts.openFailed ? ' open' : ''}><summary>${pill(b.outcome || 'running')}<b>${esc(b.stage)}</b><span class="note">${esc(b.stageKey)} · ${b.attempt}회차 · 분대 Lv${b.squadLevel} · 행동 ${b.totalActions || 0} · 웨이브 ${b.waveReached || 0}/${b.waves}${(b.issues || []).length ? ` · 문제 ${b.issues.length}건` : ''}</span></summary>
<p class="note">결과 사유: ${esc(b.reason || '')} · 시드 ${b.seed}</p>`;
      if (b.units) h += `<div class="tw"><table><thead><tr><th>진영</th><th>유닛</th><th class="n">Lv</th><th class="n">HP</th><th class="n">공격</th><th class="n">방어</th><th class="n">속도</th><th class="n">준 피해</th><th class="n">받은 피해</th><th class="n">처치</th><th class="n">행동</th></tr></thead><tbody>${b.units.map((u) => `<tr><td>${u.side === 'ally' ? '아군' : '적'}</td><td>${esc(u.name)}</td><td class="n">${u.level}</td><td class="n">${u.hp}/${u.maxHp}</td><td class="n">${u.atk}</td><td class="n">${u.def}</td><td class="n">${u.speed}</td><td class="n">${(u.dmgDealt || 0).toLocaleString()}</td><td class="n">${(u.dmgTaken || 0).toLocaleString()}</td><td class="n">${u.kills}</td><td class="n">${u.actions}</td></tr>`).join('')}</tbody></table></div>`;
      if ((b.issues || []).length) h += `<ul style="margin-top:8px">${b.issues.map((t) => `<li>${esc(t)}</li>`).join('')}</ul>`;
      if (lines.length) h += `<div class="log" style="margin-top:8px">${lines.map((l) => `<div class="l l-${esc(l.k)}">${esc(l.t)}</div>`).join('')}</div>`;
      h += '</details>';
    });
    h += '</section></main></body></html>';
    return h;
  }

  // ---------- Markdown (compact, for an LLM) ----------
  function md(rec, issues, opts) {
    const A = analyze(rec, issues);
    const maxLines = opts && opts.maxLinesPerBattle || 120;
    const L = [];
    L.push('# 라이브 플레이 리포트', '', `- 생성: ${(rec.generatedAt || '').replace('T', ' ').slice(0, 19)}`, `- 시뮬레이터: ${simText(rec.simulator)}`, `- 설정: ${settingsText(rec.settings)}`);
    const squad = (rec.battles[0] && rec.battles[0].squad) || [];
    L.push(`- 분대: ${squad.map((s) => `${s.name}(${s.gridPos + 1}칸 G${s.grade})`).join(', ')}`, '', '## 결론', ...A.conclusions.map((c) => `- ${c}`));
    if (rec.claudeSummary) L.push('', '### Claude 종합 분석', rec.claudeSummary);
    L.push('', '## 스테이지 결과', '| 스테이지 | 최종 | 도전 | 레벨 | 시도별 | 문제 |', '|---|---|---|---|---|---|');
    for (const s of A.stages) L.push(`| ${s.stage} (${s.stageKey}) | ${OUT_KO[s.final] || s.final} | ${s.attempts} | Lv${s.firstLevel}${s.firstLevel !== s.finalLevel ? '→' + s.finalLevel : ''} | ${s.outcomes.map((o) => OUT_KO[o] || o).join('→')} | ${s.issues} |`);
    L.push('', `## 감지된 문제 (${issues.length}건)`);
    for (const k of [...ISSUE_TYPES.map((t) => t.key), 'etc']) {
      const g = A.grouped[k];
      if (!g) continue;
      L.push('', `### ${g.label} (${g.items.length}건)`, ...g.items.map((i) => `- [${i.stage || i.stageKey}] ${i.text}${i.occurrences > 1 ? ` (×${i.occurrences})` : ''}`));
    }
    L.push('', '## 전투 기록 (승리하고 문제 없는 전투는 요약만)');
    for (const b of rec.battles) {
      L.push('', `### ${b.stage} · ${b.attempt}회차 · Lv${b.squadLevel} · ${OUT_KO[b.outcome] || b.outcome} · 행동 ${b.totalActions || 0}`, `사유: ${b.reason || ''}`);
      const detail = b.outcome !== 'win' || (b.issues || []).length;
      if (!detail) continue;
      if (b.units) L.push('유닛(HP/공격/방어/속도/준 피해): ' + b.units.map((u) => `${u.side === 'ally' ? '아' : '적'}:${u.name} ${u.hp}/${u.maxHp} ${u.atk}/${u.def}/${u.speed} ${u.dmgDealt}`).join(' · '));
      const lines = (b.lines || []).filter((l) => l.k !== 'stage');
      const shown = lines.length > maxLines ? lines.slice(-maxLines) : lines;
      if (lines.length > maxLines) L.push(`(앞부분 ${lines.length - maxLines}줄 생략, 마지막 ${maxLines}줄)`);
      L.push('```', ...shown.map((l) => l.t), '```');
    }
    return L.join('\n');
  }

  window.LOReport = { html, md, analyze };
})();
