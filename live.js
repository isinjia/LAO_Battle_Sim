// Live play: runs battles on the main thread with LOSim.battle.step and draws every action,
// narrates why each unit acted the way it did, flags suspicious situations, and walks a story
// campaign like a new player (retry with more levels on a loss, log bugs on stuck/error).
(function () {
  const L = window.LOSim;
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const APP = () => window.LOApp;
  const OUT_KO = { win: '승리', lose: '패배', stuck: '진행불가', error: '오류(크래시)', timeout: '시간초과' };
  const SPEEDS = { 1: { aps: 1.5, label: '보통' }, 2: { aps: 5, label: '빠름' }, 3: { aps: 20, label: '매우 빠름' }, 4: { aps: 80, label: '초고속' }, 5: { aps: Infinity, label: '최대' } };

  const S = { battle: null, running: false, paused: false, speed: 3, acc: 0, last: 0, tiles: {}, thoughts: 0, onlyIssues: false,
    campaign: null, watch: null, issueRows: new Map(), lastLog: 0, claude: false, stepOnce: false };

  // ---------- helpers ----------
  const E = () => L.E;
  const unitName = (u) => (u ? (u.name || u.key) : '-');
  const byAid = (aid) => S.battle && S.battle.units.concat(S.battle.allUnits || []).find((u) => u.aid === aid);
  const skillName = (key) => { const t = key && L.T('Table_Skill', key); return t ? L.name(t.SkillName, key) : key || ''; };
  const buffName = (key) => { const t = key && L.T('Table_BuffEffect', key); return t ? L.name(t.Name, key) : key || ''; };
  const pct = (a, b) => (b > 0 ? Math.max(0, Math.min(100, (a / b) * 100)) : 0);
  const isFriend = (u) => u.team === 1;
  const has = (u, name) => { const t = E().BUFFEFFECT_TYPE[name]; return t !== undefined && L.buffs && L.buffs.has ? !!L.buffs.has(u, t) : false; };
  const speedOf = (u) => (L.stats && L.stats.getTurnSpeed ? L.stats.getTurnSpeed(u) : 4);

  // ---------- thoughts panel ----------
  function think(kind, html, opts) {
    const box = $('lvThoughts');
    const d = document.createElement('div');
    d.className = 'th th-' + kind;
    d.dataset.kind = kind;
    d.innerHTML = html;
    if (S.onlyIssues && kind !== 'issue' && kind !== 'claude' && kind !== 'stage') d.hidden = true;
    // newest on top; if the reader has scrolled down inside the panel, keep what they are reading in place
    const keep = box.scrollTop > 4, before = box.scrollHeight;
    box.prepend(d);
    if (keep) box.scrollTop += box.scrollHeight - before;
    S.thoughts++;
    if (S.cur && S.running) {
      // plain text for the report: the head / why / result blocks are separated by " | "
      const tmp = document.createElement('div');
      tmp.innerHTML = html.replace(/<div[^>]*>/g, ' | ');
      S.cur.lines.push({ k: kind, t: tmp.textContent.replace(/\s+/g, ' ').trim() });
    }
    if (box.childElementCount > 400) {
      const acts = box.querySelectorAll('.th-ours, .th-theirs');
      for (let i = acts.length - 1, extra = box.childElementCount - 400; i >= 0 && extra > 0; i--, extra--) acts[i].remove();
    }
    return d;
  }
  function issue(key, text) {
    const w = S.watch;
    if (w.flagged.has(key)) return;
    w.flagged.add(key);
    w.issues.push(text);
    think('issue', `<b>문제 의심</b> ${esc(text)}`);
    addIssueRow(w.stageKey, text);
  }
  // campaign-wide issue list: one row per (stage, issue type); retries of the same stage bump the count
  function addIssueRow(stageKey, text) {
    const id = stageKey + '|' + text.replace(/[-\d.,%]+/g, '#'); // same message up to numbers = same issue
    let row = S.issueRows.get(id);
    if (row) { row.count++; row.el.querySelector('.n').textContent = row.count; return; }
    const st = APP().findStage(stageKey) || {};
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${esc(st.idx || stageKey)}</td><td class="note">${esc(stageKey)}</td><td class="wrap">${esc(text)}</td><td class="n">1</td>`;
    $('lvIssueBody').appendChild(tr);
    S.issueRows.set(id, { el: tr, count: 1, stageKey, stage: st.idx || '', text });
    $('lvIssueCount').textContent = String(S.issueRows.size);
    $('lvIssueTotal').textContent = String(S.issueRows.size);
  }

  // ---------- battlefield ----------
  function buildField() {
    const b = S.battle;
    const mk = (team) => {
      let h = '';
      for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) h += `<div class="cell" data-team="${team}" data-pos="${r * 3 + c}"></div>`;
      return h;
    };
    $('lvOurs').innerHTML = mk(1);
    $('lvTheirs').innerHTML = mk(0);
    S.tiles = {};
    renderField(true);
  }
  function tileHtml(u) {
    return `<div class="tile ${isFriend(u) ? 'ours' : 'theirs'}" id="tile${u.aid}">
      <div class="tn">${esc(unitName(u))}</div>
      <div class="tl">Lv${u.level}</div>
      <div class="bar hp"><i></i></div><div class="bar ap"><i></i></div>
      <div class="tb"></div><div class="pops"></div></div>`;
  }
  function renderField(full) {
    const b = S.battle;
    if (!b) return;
    const alive = new Set();
    for (const u of b.units) {
      if (u.removed && u.hp <= 0 && u.type !== 'CHARACTER') continue;
      alive.add(u.aid);
      let t = S.tiles[u.aid];
      const cell = document.querySelector(`.cell[data-team="${u.team === 1 ? 1 : 0}"][data-pos="${u.gridPos}"]`);
      if (!t || t.cellPos !== u.gridPos) {
        if (t && t.el) t.el.remove();
        if (!cell) continue;
        cell.insertAdjacentHTML('beforeend', tileHtml(u));
        t = S.tiles[u.aid] = { el: $('tile' + u.aid), cellPos: u.gridPos };
      }
      const el = t.el;
      el.classList.toggle('dead', u.hp <= 0);
      el.querySelector('.hp i').style.width = pct(u.hp, u.maxHp) + '%';
      el.querySelector('.ap i').style.width = pct(u.turnPos, 100) + '%';
      const tags = [];
      if (has(u, 'STAGE_AP_STOP')) tags.push('<span class="tg bad">행동불가</span>');
      const nb = (u.buffs || []).length;
      if (nb) tags.push(`<span class="tg">버프 ${nb}</span>`);
      el.querySelector('.tb').innerHTML = tags.join('');
      el.title = `${unitName(u)} HP ${Math.max(0, Math.round(u.hp))}/${Math.round(u.maxHp)} AP ${Math.round(u.turnPos)} 속도 ${speedOf(u)}`;
    }
    for (const aid of Object.keys(S.tiles)) if (!alive.has(+aid)) { S.tiles[aid].el && S.tiles[aid].el.remove(); delete S.tiles[aid]; }
    const st = APP().findStage(b.stageKey) || {};
    $('lvStage').textContent = `${st.idx || ''} ${st.name || ''}`;
    $('lvMeta').textContent = `웨이브 ${Math.min(b.waveIndex + 1, b.waves.length)}/${b.waves.length} · 라운드 ${b.round} · 행동 ${b.totalActions}`;
    renderQueue();
  }
  function renderQueue() {
    const b = S.battle;
    const q = b.units.filter((u) => u.hp > 0 && !u.removed && u.type !== 'SUMMON' || (u.type === 'SUMMON' && u.hp > 0 && !u.removed))
      .map((u) => ({ u, stop: has(u, 'STAGE_AP_STOP'), t: has(u, 'STAGE_AP_STOP') ? Infinity : Math.max(0, 100 - u.turnPos) / Math.max(0.01, speedOf(u)) }))
      .sort((a, b2) => a.t - b2.t).slice(0, 10);
    $('lvQueue').innerHTML = q.map((x) => `<span class="qc ${isFriend(x.u) ? 'ours' : 'theirs'} ${x.stop ? 'stop' : ''}">${esc(unitName(x.u))}</span>`).join('');
  }
  function pop(aid, text, cls) {
    if (SPEEDS[S.speed].aps > 25) return;
    const t = S.tiles[aid];
    if (!t) return;
    const p = document.createElement('span');
    p.className = 'pop ' + (cls || '');
    p.textContent = text;
    t.el.querySelector('.pops').appendChild(p);
    setTimeout(() => p.remove(), 900);
  }
  function flash(aid, cls) {
    const t = S.tiles[aid];
    if (!t || SPEEDS[S.speed].aps > 25) return;
    t.el.classList.remove(cls); void t.el.offsetWidth; t.el.classList.add(cls);
  }

  // ---------- narration ----------
  // range is only meaningful for a wait (nothing changed since the decision); after a skill the target may already be dead
  function skillStates(u, usedKey, checkRange) {
    const out = [];
    for (const s of u.skills || []) {
      const slot = L.num(s.table, 'SkillSlotType', s.slot);
      if (slot > 2 || s.key === usedKey) continue;
      const nm = skillName(s.key);
      if (s.cooldownLeft > 0) out.push(`${slot}스킬 '${nm}' 쿨다운 ${s.cooldownLeft}턴 남음`);
      else if (checkRange) {
        let ok = true;
        try { ok = !L.combat || !L.combat.canUse || L.combat.canUse(S.battle, u, s); } catch (e) { ok = true; }
        out.push(`${slot}스킬 '${nm}' ${ok ? '사용 가능' : '사거리 안에 대상 없음'}`);
      } else out.push(`${slot}스킬 '${nm}' 사용 가능`);
    }
    return out;
  }
  function narrate(rec, logs) {
    const b = S.battle;
    const a = byAid(rec.actor && rec.actor.aid);
    if (!a) return;
    const side = isFriend(a) ? '아군' : '적';
    const brain = a.type === 'CHARACTER' ? '자동전투 AI' : `Lua AI(${a.aiKey || '없음'})`;
    const tt = { normal: '', double: ' (추가 행동)', reserve: ' (예약 스킬 발동)', counter: ' (반격)', assist: ' (협동 공격)' }[rec.turnType] || '';
    let head, why = '';
    if (rec.kind === 'skill') {
      const tgt = rec.target ? byAid(rec.target.aid) : null;
      head = `${side} <b>${esc(unitName(a))}</b>${tt} → ${rec.slot ? rec.slot + '스킬 ' : ''}'${esc(skillName(rec.skill))}'${tgt ? ' → ' + esc(unitName(tgt)) : ''}`;
      if (rec.turnType === 'normal') { const o = skillStates(a, rec.skill, false); why = `${brain} 선택${o.length ? ' · 다른 스킬: ' + o.join(' / ') : ''}`; }
    } else if (rec.kind === 'move') {
      head = `${side} <b>${esc(unitName(a))}</b> 이동 ${rec.from + 1} → ${rec.to + 1}칸`;
      why = `${brain}: 사거리 안에 들어가려고 이동`;
    } else {
      head = `${side} <b>${esc(unitName(a))}</b> 대기`;
      const r = rec.reason === 'cooldown' ? '쓰려던 스킬이 쿨다운' : rec.reason === 'no reserved skill' ? 'AI가 아무 행동도 고르지 않음' : '사용할 수 있는 스킬/대상 없음';
      why = `${brain}: ${r} · ${skillStates(a, null, true).join(' / ')}`;
    }
    const res = [];
    let dmg = 0, hits = 0, miss = 0, crit = 0;
    const act = { n: b.totalActions, round: b.round, wave: b.waveIndex + 1, side: isFriend(a) ? 'ally' : 'enemy', actor: unitName(a), actorKey: a.key,
      ai: a.type === 'CHARACTER' ? 'auto-battle' : 'lua:' + (a.aiKey || ''), kind: rec.kind, turnType: rec.turnType,
      ap: Math.round(rec.ap || 0), skill: rec.skill ? { key: rec.skill, name: skillName(rec.skill), slot: rec.slot || null } : null,
      target: rec.target ? unitName(byAid(rec.target.aid)) : null, why: '', hits: [], misses: [], kills: [], buffs: [], heals: [] };
    if (rec.kind === 'move') { act.from = rec.from; act.to = rec.to; }
    if (rec.reason) act.waitReason = rec.reason;
    for (const e of logs) {
      if (e.t === 'hit' && e.dmg === 1 && e.src) {
        const k = e.src.aid, n = (S.watch.minDmg[k] = (S.watch.minDmg[k] || 0) + 1);
        if (n === 5) {
          const sU = byAid(k), dU = byAid(e.dst && e.dst.aid);
          const atk = Math.round(L.stats.getAtk(sU)), def = dU ? Math.round(L.stats.getDef(dU)) : 0;
          issue('min' + k, atk <= def
            ? `${unitName(sU)}의 공격이 계속 최소 피해(1)만 줍니다. 공격력 ${atk} ≤ ${unitName(dU)} 방어력 ${def}이라 (공격력×배율 − 방어력)이 0 이하로 떨어집니다.`
            : `${unitName(sU)}의 공격이 계속 최소 피해(1)만 줍니다. 공격력 ${atk}이 ${unitName(dU)} 방어력 ${def}보다 높은데도 1이므로, 방어력이 아니라 피해 감소·보호막·면역 버프나 낮은 스킬 배율 때문입니다.`);
        }
      }
      if (e.t === 'hit') { act.hits.push({ target: unitName(byAid(e.dst && e.dst.aid)), dmg: e.dmg || 0, crit: !!e.crit, hpAfter: Math.round(e.hp) }); }
      else if (e.t === 'miss') act.misses.push(unitName(byAid(e.dst && e.dst.aid)));
      else if (e.t === 'kill') act.kills.push(unitName(byAid(e.dst && e.dst.aid)));
      else if (e.t === 'heal') act.heals.push({ target: unitName(byAid(e.dst && e.dst.aid)), amount: e.amount });
      else if (e.t === 'buff' && e.op === 'apply' && e.slot === 1 && e.from === a.aid) act.buffs.push({ target: unitName(byAid(e.unit)), key: e.key, name: buffName(e.key), turns: e.left });
      else if (e.t === 'counter_null') act.counterNull = true;
      if (e.t === 'hit') { hits++; dmg += e.dmg || 0; if (e.crit) crit++; pop(e.dst && e.dst.aid, (e.crit ? '치명 ' : '') + (e.dmg || 0).toLocaleString(), e.crit ? 'crit' : ''); flash(e.dst && e.dst.aid, 'hit'); }
      else if (e.t === 'miss') { miss++; pop(e.dst && e.dst.aid, '회피', 'miss'); }
      else if (e.t === 'kill' || e.t === 'death') { const d = byAid(e.dst && e.dst.aid); if (d && e.t === 'kill') res.push(`<span class="k">${esc(unitName(d))} 처치</span>`); }
      else if (e.t === 'heal') { pop(e.dst && e.dst.aid, '+' + (e.amount || 0), 'heal'); res.push(`회복 ${e.amount}`); }
      else if (e.t === 'buff' && e.op === 'apply' && e.slot === 1 && e.from === a.aid) {
        // auras/passives re-apply every update; only mention a buff the first time in a while
        const k = e.unit + '|' + e.key, seen = S.watch.buffSeen[k];
        S.watch.buffSeen[k] = b.totalActions;
        const d = byAid(e.unit);
        if (d && (seen === undefined || b.totalActions - seen > 30)) res.push(`${esc(unitName(d))}에게 '${esc(buffName(e.key))}'`);
      }
      else if (e.t === 'buff' && e.op === 'resurrect') res.push('부활');
      else if (e.t === 'summon') res.push('소환');
      else if (e.t === 'counter_null') issue('cn' + b.totalActions, `반격 처리 중 counter가 null (BattleManager.cs:4953). 실제 클라이언트에서는 NullReference로 전투가 멈출 상황입니다. (${S.watch.stageKey}, 행동 ${b.totalActions})`);
    }
    if (hits || miss) res.unshift(`명중 ${hits}${crit ? ` (치명 ${crit})` : ''}${miss ? ` · 회피 ${miss}` : ''} · 피해 ${dmg.toLocaleString()}`);
    flash(a.aid, 'act');
    act.why = why;
    for (const k of ['hits', 'misses', 'kills', 'buffs', 'heals']) if (!act[k].length) delete act[k];
    if (S.cur) S.cur.actions.push(act);
    think(isFriend(a) ? 'ours' : 'theirs', `<span class="r">R${b.round}</span> ${head}${why ? `<div class="why">${esc(why)}</div>` : ''}${res.length ? `<div class="res">${res.slice(0, 6).join(' · ')}</div>` : ''}`);
  }

  // ---------- problem watch ----------
  function newWatch(stageKey) {
    return { stageKey, flagged: new Set(), issues: [], waitStreak: {}, stopSince: {}, luaSeen: 0, lastHpAt: 0, hpSig: '', buffSeen: {}, oor: {}, hpHist: [], minDmg: {} };
  }
  function watch(rec) {
    const b = S.battle, w = S.watch;
    if (rec.type === 'action' && rec.actor) {
      const aid = rec.actor.aid;
      w.waitStreak[aid] = rec.kind === 'wait' ? (w.waitStreak[aid] || 0) + 1 : 0;
      if (w.waitStreak[aid] === 6) { const u = byAid(aid); issue('wait' + aid, `${unitName(u)}이(가) 6턴 연속 대기 중입니다. 배치(사거리) 또는 AI 문제일 수 있습니다.`); }
      // monster that can reach nobody and never walks closer: client IsUseSkillPos_Preview checks range from the
      // monster's CURRENT cell for every candidate cell (BattleManager.cs:3780-3809), so MoveToUseSkillPos is always -1
      const u = byAid(aid);
      if (u && !isFriend(u) && rec.kind === 'wait') {
        let reach = false;
        for (const s of u.skills || []) { const slot = L.num(s.table, 'SkillSlotType', s.slot); if (slot > 2) continue; try { if (L.combat.canUse(b, u, s)) reach = true; } catch (e) { reach = true; } }
        w.oor[aid] = reach ? 0 : (w.oor[aid] || 0) + 1;
        if (w.oor[aid] === 3) issue('oor' + aid, `${unitName(u)}이(가) 사거리 안에 대상이 없는데 앞으로 이동하지 않고 대기만 합니다. Lua AI는 MoveToUseSkillPos로 이동할 칸을 찾지만, 클라이언트 IsUseSkillPos_Preview(BattleManager.cs:3780)가 후보 칸이 아니라 현재 위치 기준으로 사거리를 검사해서 항상 -1을 돌려줍니다. 사거리 밖 몬스터가 영원히 다가오지 않는 버그 후보입니다.`);
      } else if (u) w.oor[aid] = 0;
    }
    // stalemate by attrition: enemies lose almost no HP over a long window (e.g. ATK below DEF -> minimum damage 1)
    const enemyHp = b.units.filter((x) => x.team !== 1 && x.hp > 0).reduce((s2, x) => s2 + x.hp, 0);
    w.hpHist.push(enemyHp);
    const WIN = 120;
    if (w.hpHist.length > WIN && !b.result) {
      const then = w.hpHist[w.hpHist.length - 1 - WIN];
      if (then > 0 && enemyHp <= then && (then - enemyHp) / then < 0.02) {
        const why = `교착: 최근 ${WIN}행동 동안 적 HP가 ${(((then - enemyHp) / then) * 100).toFixed(1)}%만 줄었습니다 (${Math.round(then)} → ${Math.round(enemyHp)}). 실제 게임이라면 제한 시간(LeftPlayTime) 초과로 패배할 전투입니다.`;
        issue('attrition', why);
        b.result = 'stuck'; b.resultReason = why; b.s.phase = 'ended';
      }
    }
    for (const u of b.units) {
      if (u.hp <= 0) continue;
      if (has(u, 'STAGE_AP_STOP')) {
        if (w.stopSince[u.aid] === undefined) w.stopSince[u.aid] = b.totalActions;
        else if (b.totalActions - w.stopSince[u.aid] >= 25) issue('stop' + u.aid, `${unitName(u)}의 행동불가(STAGE_AP_STOP)가 ${b.totalActions - w.stopSince[u.aid]}행동째 풀리지 않습니다. 리뉴얼에서 지속시간이 '자기 턴 종료'에만 줄어들어 영구 기절이 되는 문제 후보입니다.`);
      } else delete w.stopSince[u.aid];
    }
    const sig = b.units.map((u) => u.aid + ':' + Math.round(u.hp)).join(',');
    if (sig !== w.hpSig) { w.hpSig = sig; w.lastHpAt = b.totalActions; }
    else if (b.totalActions - w.lastHpAt === 40) issue('stale' + w.lastHpAt, `40행동 동안 누구의 HP도 변하지 않았습니다. 교착 상태입니다.`);
    const le = b.luaErrors || [];
    for (; w.luaSeen < le.length; w.luaSeen++) { const e = le[w.luaSeen]; issue('lua' + (e.aiKey || '') + (e.msg || '').slice(0, 40), `Lua AI 오류 (${e.aiKey || e.unit}): ${String(e.msg || e.kind).slice(0, 140)}. 이 몬스터는 이동/대기로 대체 행동합니다.`); }
  }

  // ---------- battle lifecycle ----------
  function startBattle(stageKey, squad, seed) {
    const st = APP().findStage(stageKey) || { mode: 'stage' };
    S.battle = L.battle.create({ stageKey, mode: st.mode, squad, seed, logEnabled: true, options: { maxActions: +$('maxActions').value || 3000 } });
    S.lastLog = 0;
    S.watch = newWatch(stageKey);
    buildField();
    const names = squad.map((s) => (APP().pcName(s.key) || s.key) + ' Lv' + s.level).join(', ');
    S.cur = { stageKey, stage: (st.idx || '') + ' ' + (st.name || ''), attempt: S.attempt || 1, squadLevel: squad[0] && squad[0].level, seed,
      squad: squad.map((s) => ({ key: s.key, name: APP().pcName(s.key) || s.key, gridPos: s.gridPos, grade: s.grade, level: s.level, skillLevels: s.skillLevels, equips: s.equips })),
      waves: S.battle.waves.length, actions: [], lines: [] };
    if (S.record) S.record.battles.push(S.cur);
    think('stage', `<b>${esc(st.idx || stageKey)} ${esc(st.name || '')}</b> 시작 · 분대: ${esc(names)}`);
  }
  function stepBattle() {
    const b = S.battle;
    const rec = L.battle.step(b);
    const logs = b.log.slice(S.lastLog);
    S.lastLog = b.log.length;
    if (b.log.length > 6000) { b.log.splice(0, b.log.length - 2000); S.lastLog = b.log.length; }
    for (const e of logs) if (e.t === 'wave') { think('stage', `웨이브 ${e.wave} 시작 · ${e.monsters.length}마리`); S.watch.hpHist = []; }
    if (rec.type === 'action') { narrate(rec, logs); watch(rec); }
    return rec;
  }
  async function endBattle() {
    const b = S.battle, w = S.watch;
    const r = L.battle.result(b);
    const st = APP().findStage(w.stageKey) || {};
    const cls = { win: 'ok', lose: 'bad', stuck: 'warn', error: 'err', timeout: 'warn' }[r.outcome] || '';
    if (S.cur) Object.assign(S.cur, { outcome: r.outcome, reason: r.reason, totalActions: r.totalActions, waveReached: r.waveReached,
      units: b.units.filter((u) => u.type !== 'SUMMON').map((u) => ({ side: isFriend(u) ? 'ally' : 'enemy', name: unitName(u), key: u.key, level: u.level,
        hp: Math.max(0, Math.round(u.hp)), maxHp: Math.round(u.maxHp), atk: Math.round(L.stats.getAtk(u)), def: Math.round(L.stats.getDef(u)), speed: speedOf(u),
        dmgDealt: Math.round(u.stats.dmgDealt), dmgTaken: Math.round(u.stats.dmgTaken), kills: u.stats.kills, actions: u.stats.actions })),
      errors: (r.errors || []).map((e) => e.msg || e.message), luaErrors: (b.luaErrors || []).slice(0, 20).map((e) => ({ ai: e.aiKey, msg: e.msg || e.kind })),
      clientCrashCandidates: r.clientCrashCandidates, issues: w.issues.slice() });
    think('stage', `<b class="${cls}">${esc(st.idx || w.stageKey)} ${OUT_KO[r.outcome] || r.outcome}</b> · 행동 ${r.totalActions} · ${esc(r.reason || '')}`);
    if (r.outcome === 'stuck' && !w.flagged.has('attrition')) issue('end-stuck', `전투가 진행불가로 끝났습니다: ${r.reason}`);
    if (r.outcome === 'error') issue('end-error', `엔진 예외로 전투가 중단됐습니다 (실제 클라이언트 크래시 후보): ${r.reason}`);
    if (r.outcome === 'timeout') issue('end-timeout', `최대 행동 수에 도달했습니다: ${r.reason}`);
    if (S.claude && (r.outcome !== 'win' || w.issues.length)) await claudeReview(r);
    return r;
  }

  // ---------- Claude commentary ----------
  async function claudeReview(r) {
    const sample = APP().sample();
    if (!sample) return;
    const lines = [...$('lvThoughts').querySelectorAll('.th')].slice(0, 45).reverse().map((d) => d.innerText.replace(/\s+/g, ' ')).join('\n');
    const st = APP().findStage(S.watch.stageKey) || {};
    const d = think('claude', '<b>Claude 분석</b> <span class="wait">생각 중…</span>');
    const prompt = `라스트오리진 전투 시뮬레이터에서 AI가 신규 유저처럼 스테이지를 플레이했다. 아래 기록을 보고 QA 관점으로 짧게 한국어로 답해.
1) 결과가 나온 핵심 이유 (수치 근거)
2) 버그로 의심되는 점과 그 근거 (없으면 없다고)
3) 유저라면 다음 시도에서 바꿀 것 (레벨/배치/전투원)
각 항목 1~2줄, 추측은 추측이라고 표시.

스테이지: ${st.idx || ''} ${st.name || ''} (${S.watch.stageKey})
결과: ${r.outcome} / ${r.reason} / 행동 ${r.totalActions} / 도달 웨이브 ${r.waveReached}
문제 감지: ${S.watch.issues.join(' | ') || '없음'}
최근 행동 기록(오래된 순):
${lines}`;
    try {
      const { text } = await sample(prompt, { onText: ({ text }) => { d.innerHTML = '<b>Claude 분석</b><div class="why">' + esc(text) + '</div>'; } });
      d.innerHTML = '<b>Claude 분석</b><div class="why">' + esc(text) + '</div>';
    } catch (e) {
      d.innerHTML = '<b>Claude 분석</b> <span class="why">' + (e.code === 'not_granted' ? '허용되지 않아 해설을 끕니다.' : '응답 실패: ' + esc(e.code)) + '</span>';
      if (e.code === 'not_granted' || e.code === 'sampling_disabled') { S.claude = false; $('lvClaude').checked = false; }
    }
  }

  // ---------- campaign ----------
  function campaignStages() {
    const all = APP().stages('stage');
    const chs = APP().chapters('stage').filter((c) => /N$/.test(c.key));
    const i0 = chs.findIndex((c) => c.key === $('lvFrom').value), i1 = chs.findIndex((c) => c.key === $('lvTo').value);
    const keep = new Set(chs.slice(Math.min(i0, i1), Math.max(i0, i1) + 1).map((c) => c.key));
    const side = $('lvSide').checked;
    return all.filter((s) => keep.has(s.chapter)).filter((s) => {
      const r = L.T('Table_MapStage', s.key);
      const sub = L.num(r, 'StageSubType');
      return sub === 0 || (side && (sub === 1 || sub === 2));
    });
  }
  function campaignRow(c, st, res) {
    const tb = $('lvCampBody');
    let tr = document.getElementById('cr-' + st.key);
    if (!tr) { tr = document.createElement('tr'); tr.id = 'cr-' + st.key; tb.appendChild(tr); }
    tr.innerHTML = `<td>${esc(st.idx)}</td><td class="note">${esc(st.key)}</td><td><span class="pill o-${res.outcome}">${OUT_KO[res.outcome] || res.outcome}</span></td><td class="n">${res.tries}</td><td class="n">${typeof res.level === 'number' ? 'Lv' + res.level : esc(res.level)}</td><td class="n">${res.actions || 0}</td><td>${esc(res.issues.slice(0, 2).join(' / ').slice(0, 140))}</td>`;
  }

  // ---------- main loop ----------
  async function runLoop() {
    if (S.running) return;
    S.running = true; S.paused = false; setButtons();
    $('lvThoughts').innerHTML = ''; $('lvIssueCount').textContent = '0'; $('lvCampBody').innerHTML = '';
    $('lvIssueBody').innerHTML = ''; $('lvIssueTotal').textContent = '0'; S.issueRows = new Map();
    S.record = {
      format: 'lo-battlesim-live/1', generatedAt: null, simulator: APP().meta ? APP().meta() : null,
      settings: { scenario: $('lvScenario').value, fromChapter: $('lvFrom').value, toChapter: $('lvTo').value, startLevel: +$('lvStartLv').value,
        levelStepOnLoss: +$('lvLvStep').value, useSquadLevels: $('lvUseSquadLv').checked, maxAttempts: +$('lvMaxTry').value, includeSideStages: $('lvSide').checked, maxActions: +$('maxActions').value, seed: +$('seed').value },
      battles: [] };
    ['lvSave', 'lvCopy', 'lvRepSave', 'lvRepCopy'].forEach((id) => { $(id).disabled = false; });
    $('lvClaudeAll').disabled = !APP().sample();
    const base = APP().squad();
    if (!base.length) { think('issue', '분대가 비어 있습니다. 위의 분대 편성에서 전투원을 배치하세요.'); S.running = false; setButtons(); return; }
    const camp = $('lvScenario').value === 'campaign';
    const stages = camp ? campaignStages() : [APP().findStage(APP().currentStageKey())];
    if (!stages.length || !stages[0]) { think('issue', '진행할 스테이지가 없습니다. 챕터 범위나 설정 화면의 스테이지를 확인하세요.'); S.running = false; setButtons(); return; }
    // levels: one shared start level, or each member's own level from the squad editor (+step for everyone on a loss)
    const useSquadLv = camp && $('lvUseSquadLv').checked;
    let level = camp && !useSquadLv ? +$('lvStartLv').value || 1 : null;
    let bump = 0;
    const levelOf = (s) => (useSquadLv ? Math.min(120, (s.level || 1) + bump) : level);
    const levelLabel = () => (useSquadLv ? (bump ? `편성 레벨 +${bump}` : '편성 레벨') : 'Lv' + level);
    const atCap = () => (useSquadLv ? base.every((s) => levelOf(s) >= 120) : level >= 120);
    const step = +$('lvLvStep').value || 5, maxTry = +$('lvMaxTry').value || 5;
    let seed = +$('seed').value || 1;
    S.campaign = { total: stages.length, done: 0 };
    for (const st of stages) {
      if (!S.running) break;
      let tries = 0, res = null;
      const issuesAll = [];
      while (S.running) {
        tries++;
        S.attempt = tries;
        const squad = base.map((s) => Object.assign({}, s, camp ? { level: levelOf(s) } : {}));
        if (tries > 1) think('stage', `<b>재도전 ${tries}회차</b> · 패배해서 파밍했다고 가정하고 분대 레벨을 ${levelLabel()}(으)로 올림`);
        startBattle(st.key, squad, seed++);
        const out = await playOne();
        if (!out) break;
        res = await endBattle();
        issuesAll.push(...S.watch.issues);
        if (!camp || res.outcome !== 'lose' || tries >= maxTry || atCap()) break;
        if (useSquadLv) bump += step; else level = Math.min(120, level + step);
      }
      if (!res) break;
      if (camp) {
        if (res.outcome === 'lose') think('issue', `<b>벽</b> ${esc(st.idx)}: ${esc(levelLabel())}까지 ${tries}번 도전해도 클리어 못 함. 레벨을 유지한 채 다음 스테이지로 진행합니다.`);
        S.campaign.done++;
        campaignRow(S.campaign, st, { outcome: res.outcome, tries, level: useSquadLv ? levelLabel() : level, actions: res.totalActions, issues: [...new Set(issuesAll)] });
        $('lvProg').style.width = (S.campaign.done / S.campaign.total) * 100 + '%';
      }
    }
    if (camp && S.running) think('stage', `<b>캠페인 종료</b> · ${S.campaign.done}/${S.campaign.total} 스테이지`);
    S.running = false; setButtons();
  }
  function playOne() {
    return new Promise((resolve) => {
      S.last = performance.now(); S.acc = 0;
      const frame = (now) => {
        if (!S.running) return resolve(false);
        const b = S.battle;
        if (b.result) { renderField(); return resolve(true); }
        if (S.paused && !S.stepOnce) { S.last = now; return tick(); }
        const aps = SPEEDS[S.speed].aps;
        let n;
        if (S.stepOnce) { n = 1; S.stepOnce = false; }
        else if (aps === Infinity) n = Infinity;
        else { S.acc += ((now - S.last) / 1000) * aps; n = Math.floor(S.acc); S.acc -= n; }
        S.last = now;
        const t0 = performance.now();
        let done = 0;
        while (done < n && !b.result && performance.now() - t0 < 14) {
          const rec = stepBattle();
          if (rec.type === 'action') done++;
          if (rec.type === 'end') break;
        }
        if (done || b.result) renderField();
        tick();
      };
      // setTimeout instead of requestAnimationFrame: keeps playing when the tab is in the background
      const tick = () => setTimeout(() => frame(performance.now()), 16);
      tick();
    });
  }
  function setButtons() {
    $('lvStart').disabled = S.running;
    $('lvPause').disabled = !S.running;
    $('lvPause').textContent = S.paused ? '계속' : '일시정지';
    $('lvStep').disabled = !S.running || !S.paused;
    $('lvStop').disabled = !S.running;
  }

  // ---------- JSON export (for asking Claude / Codex) ----------
  const GUIDE = {
    what: 'LO battle simulator live-play log. The battle engine is a JavaScript port of the Unity client battle code (battle renewal / AP gauge). Monsters run their real Lua AI scripts; allies use the client auto-battle AI.',
    outcome: 'win | lose | stuck (no progress: client freeze candidate or stalemate) | error (engine exception: client crash candidate) | timeout (maxActions reached)',
    campaign: 'Story stages in order. On a loss the whole squad level is raised by settings.levelStepOnLoss and the stage is retried up to settings.maxAttempts.',
    actions: 'One entry per unit action. n = action number in the battle, round = renewal round (one unit action), ap = AP when acting (100 = turn), why = which AI chose it and the state of the other skills, hits/misses/kills/buffs = what happened.',
    issues: 'Heuristic problem flags raised by the simulator (stalemate, minimum damage 1, monster never approaching because of IsUseSkillPos_Preview, AP_STOP never expiring, counter null, Lua errors).',
    askIdeas: ['Which stages are balance walls and why (levels, stats, enemy skills)?', 'Which issues look like real client bugs vs. simulator approximations?', 'For a stuck/error battle, what sequence of actions led to it?'],
  };
  function buildExport() {
    const all = $('lvExpAll').checked;
    const rec = JSON.parse(JSON.stringify(S.record || { battles: [] }));
    rec.generatedAt = new Date().toISOString();
    rec.guide = GUIDE;
    rec.issueSummary = [...S.issueRows.values()].map((r) => ({ stageKey: r.stageKey, stage: r.stage, issue: r.text, occurrences: r.count }));
    rec.stageSummary = [];
    const byStage = new Map();
    for (const bt of rec.battles) {
      const s2 = byStage.get(bt.stageKey) || { stageKey: bt.stageKey, stage: bt.stage, attempts: 0, final: null, finalLevel: null };
      s2.attempts++; s2.final = bt.outcome; s2.finalLevel = bt.squadLevel; byStage.set(bt.stageKey, s2);
      // keep every action for battles that went wrong; won battles keep actions only when asked (size)
      const keep = all || bt.outcome !== 'win' || (bt.issues && bt.issues.length);
      if (!keep) { bt.actionsOmitted = bt.actions.length; delete bt.actions; }
      else if (bt.actions.length > 1500) { bt.actionsOmitted = bt.actions.length - 1500; bt.actions = bt.actions.slice(0, 300).concat(bt.actions.slice(-1200)); bt.actionsNote = 'middle actions omitted (first 300 + last 1200 kept)'; }
    }
    rec.stageSummary = [...byStage.values()];
    return JSON.stringify(rec, null, 1);
  }
  const fileStem = () => `lo-live-${(S.record && S.record.settings.fromChapter || 'run').replace('Chapter_', '')}-${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '')}`;
  async function saveFile(name, text, type, label) {
    const kb = Math.round(text.length / 1024);
    const dl = window.claude && window.claude.use ? await window.claude.use('downloads').catch(() => null) : null;
    if (dl) {
      try { await dl.save({ filename: name, data: new Blob([text], { type }) }); think('stage', `${label} 저장 요청: ${name} (${kb} KB)`); }
      catch (e) { think('stage', `${label} 저장이 취소되었거나 실패했습니다: ${esc(e.code || e.message || e)}`); }
      return;
    }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type }));
    a.download = name; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    think('stage', `${label} 저장: ${name} (${kb} KB) · 브라우저의 다운로드 폴더를 확인하세요`);
  }
  async function copyText(text, label) {
    try { await navigator.clipboard.writeText(text); think('stage', `${label}을(를) 클립보드에 복사했습니다 (${Math.round(text.length / 1024)} KB). Claude나 Codex 대화창에 붙여넣으세요.`); }
    catch (e) { think('stage', '클립보드 복사가 막혀 있습니다. 파일 저장을 사용하세요.'); }
  }
  function reportInput() {
    const rec = JSON.parse(JSON.stringify(S.record || { battles: [] }));
    rec.generatedAt = new Date().toISOString();
    const issues = [...S.issueRows.values()].map((r) => ({ stageKey: r.stageKey, stage: r.stage, text: r.text, occurrences: r.count }));
    return { rec, issues };
  }
  const saveJson = () => saveFile(fileStem() + '.json', buildExport(), 'application/json', '로그 JSON');
  const copyJson = () => copyText(buildExport(), '로그 JSON');
  const saveReport = () => { const { rec, issues } = reportInput(); saveFile(fileStem() + '-report.html', window.LOReport.html(rec, issues, { openFailed: false }), 'text/html', '리포트(HTML)'); };
  const copyReport = () => { const { rec, issues } = reportInput(); copyText(window.LOReport.md(rec, issues, { maxLinesPerBattle: 120 }), '리포트(Markdown)'); };
  async function claudeOverall() {
    const sample = APP().sample();
    if (!sample || !S.record || !S.record.battles.length) return;
    const { rec, issues } = reportInput();
    let text = window.LOReport.md(rec, issues, { maxLinesPerBattle: 40 });
    if (text.length > 200000) text = text.slice(0, 200000) + '\n(이하 생략)';
    const d = think('claude', '<b>Claude 종합 분석</b> <span class="wait">생각 중…</span>');
    $('lvClaudeAll').disabled = true;
    const prompt = `너는 모바일 게임 "라스트오리진"의 QA 리드다. 아래는 전투 시뮬레이터에서 AI가 신규 유저처럼 스토리를 플레이한 기록이다.
한국어로 다음 형식의 종합 리포트를 써라. 수치는 기록에 있는 것만 쓰고, 추측은 추측이라고 표시한다.
1. 한 줄 결론
2. 진행 불가·크래시 버그 후보 (재현 스테이지, 근거, 클라이언트 코드 위치가 있으면 함께, 심각도 높은 순)
3. 밸런스 벽 (스테이지, 필요 레벨 변화, 원인으로 보이는 몬스터·수치)
4. 시뮬레이터 근사 때문일 수 있어 실제 게임에서 확인이 필요한 항목
5. 다음에 돌려볼 실험 2~3개

${text}`;
    try {
      const { text: out } = await sample(prompt, { onText: ({ text: t }) => { d.innerHTML = '<b>Claude 종합 분석</b><div class="why">' + esc(t) + '</div>'; } });
      S.record.claudeSummary = out;
      d.innerHTML = '<b>Claude 종합 분석</b><div class="why">' + esc(out) + '</div>';
      think('stage', 'Claude 분석을 리포트 "결론" 섹션에 넣었습니다. 리포트 저장을 누르면 함께 저장됩니다.');
    } catch (e) {
      d.innerHTML = '<b>Claude 종합 분석</b> <span class="why">' + esc(e.code === 'not_granted' ? 'Claude 사용이 허용되지 않았습니다.' : e.code === 'prompt_too_large' ? '기록이 너무 깁니다. 범위를 줄여 다시 시도하세요.' : '응답 실패: ' + (e.code || e)) + '</span>';
    } finally { $('lvClaudeAll').disabled = !APP().sample(); }
  }

  // ---------- wiring ----------
  function fillChapters() {
    const chs = APP().chapters('stage').filter((c) => /N$/.test(c.key));
    const opts = chs.map((c) => `<option value="${esc(c.key)}">${esc(c.name)} (${esc(c.key.replace('Chapter_', ''))})</option>`).join('');
    $('lvFrom').innerHTML = opts; $('lvTo').innerHTML = opts;
    if (chs.length) { $('lvFrom').value = chs[0].key; $('lvTo').value = chs[Math.min(3, chs.length - 1)].key; }
  }
  window.LOLive = {
    // Markdown of the current/last live-play session (for the Claude Q&A panel)
    reportMarkdown() {
      if (!S.record || !S.record.battles.length || !window.LOReport) return '';
      const { rec, issues } = reportInput();
      return window.LOReport.md(rec, issues, { maxLinesPerBattle: 60 });
    },
    init() {
      fillChapters();
      $('lvSpeed').addEventListener('input', (e) => { S.speed = +e.target.value; $('lvSpeedLbl').textContent = SPEEDS[S.speed].label; });
      $('lvStart').addEventListener('click', runLoop);
      $('lvPause').addEventListener('click', () => { S.paused = !S.paused; setButtons(); });
      $('lvStep').addEventListener('click', () => { S.stepOnce = true; });
      $('lvStop').addEventListener('click', () => { S.running = false; setButtons(); think('stage', '중지됨'); });
      $('lvOnlyIssues').addEventListener('change', (e) => { S.onlyIssues = e.target.checked; document.querySelectorAll('#lvThoughts .th').forEach((d) => { d.hidden = S.onlyIssues && !['issue', 'claude', 'stage'].includes(d.dataset.kind); }); });
      $('lvClaude').addEventListener('change', (e) => { S.claude = e.target.checked; });
      $('lvSave').addEventListener('click', saveJson);
      $('lvCopy').addEventListener('click', copyJson);
      $('lvRepSave').addEventListener('click', saveReport);
      $('lvRepCopy').addEventListener('click', copyReport);
      $('lvClaudeAll').addEventListener('click', claudeOverall);
      $('lvScenario').addEventListener('change', (e) => { $('lvCampOpts').hidden = e.target.value !== 'campaign'; });
      setButtons();
    },
    claudeReady(ok) {
      $('lvClaude').disabled = !ok;
      $('lvClaudeLbl').title = ok ? '' : 'Claude 연결은 claude.ai에 게시된 페이지에서만 동작합니다. 로컬(실행.bat)에서는 쓸 수 없습니다.';
      $('lvClaudeLbl').querySelector('span').textContent = ok ? 'Claude 해설 (패배·문제 발생 시)' : 'Claude 해설 (claude.ai에서만 사용 가능)';
    },
  };
})();
