"""Report: squads that clear stages faster / with fewer members than the best community guide squad.
Usage: python -I tools/make_beat_report.py -> reports/공략대비_빠른조합_리포트_r<rev>.md"""
import collections, json, os, re

HERE = os.path.dirname(os.path.abspath(__file__))
SIM = os.path.normpath(os.path.join(HERE, '..'))
OUT = os.path.join(HERE, 'out')
J = lambda *p: json.load(open(os.path.join(*p), encoding='utf-8'))
loc = J(SIM, 'data', 'loc.json')
units = J(SIM, 'data', 'units.json')
stages = J(SIM, 'data', 'stages.json')['Table_MapStage']
rev = J(SIM, 'data', 'meta.json').get('svnRevision', '')
pname = lambda k: loc.get(units['Table_PC'].get(k, {}).get('Name', ''), k)
sname = lambda k: loc.get(stages.get(k, {}).get('StageName', ''), '')
sidx = lambda k: loc.get(stages.get(k, {}).get('StageIdxString', ''), '') or stages.get(k, {}).get('StageIdxString', '')
cat = lambda k: '메인' if re.match(r'^Ch\d+(N\d+)?Stage', k) else ('챌린지' if 'Cha' in k else '이벤트')
sq = lambda lst: ', '.join(f"{pname(x.split('@')[0])}({int(x.split('@')[1]) + 1})" for x in lst)


def section(R, title, note, h='##'):
    L = []
    w = L.append
    w(f'{h} {title}')
    w('')
    for n in note: w(n)
    w('')
    rows = []
    for r in R:
        g = r['guide']
        vs = [v for v in r['verified'] if v['wins'] == v['runs'] and v['runs']]          # cleared on every verify seed
        if not vs or g['medTotal'] is None:
            rows.append({'r': r, 'g': g, 'best': None, 'eff': None}); continue
        best = min(vs, key=lambda v: (v['medTotal'], v['medPc'], v['members']))
        eff = min([v for v in vs if v['members'] < g['members'] and v['medTotal'] <= g['medTotal']] or [None],
                  key=lambda v: (v['members'], v['medTotal']) if v else (9, 0)) if any(v['members'] < g['members'] and v['medTotal'] <= g['medTotal'] for v in vs) else None
        rows.append({'r': r, 'g': g, 'best': best, 'eff': eff})

    valid = [x for x in rows if x['best'] and x['g']['wins'] == x['g']['runs']]
    faster = [x for x in valid if x['best']['medTotal'] < x['g']['medTotal']]
    same = [x for x in valid if x['best']['medTotal'] == x['g']['medTotal']]
    effic = [x for x in valid if x['eff']]
    gain = lambda x: x['g']['medTotal'] - x['best']['medTotal']
    ratio = lambda x: x['best']['medTotal'] / x['g']['medTotal']
    guide_unstable = [x for x in rows if x['g']['wins'] < x['g']['runs']]

    w('')
    w(h + '# 한눈에 보기')
    w('')
    w('| 항목 | 결과 |')
    w('|---|---|')
    w(f'| 비교 가능한 스테이지 (공략이 5번 모두 클리어) | {len(valid)}개 |')
    w(f'| 공략보다 빠른 조합을 찾음 | **{len(faster)}개** ({len(faster) * 100 // max(1, len(valid))}%) |')
    w(f'| 공략과 같은 속도 | {len(same)}개 |')
    if faster:
        rs = sorted(ratio(x) for x in faster)
        w(f'| 빨라진 정도 (전체 라운드, 중앙값) | 공략 대비 {round((1 - rs[len(rs) // 2]) * 100)}% 단축 |')
    w(f'| 같거나 빠른 속도를 더 적은 인원으로 | {len(effic)}개 |')
    w(f'| 공략 조합이 시뮬레이터에서 불안정 (5번 중 일부 실패) | {len(guide_unstable)}개 (비교에서 제외) |')
    w('')

    # top characters in the best squads
    cnt = collections.Counter()
    for x in faster:
        for s in x['best']['squad']:
            cnt[s.split('@')[0]] += 1
    w(h + '# 더 빠른 조합에 자주 나온 전투원')
    w('')
    w('| 전투원 | 등장 스테이지 수 |')
    w('|---|---|')
    for k, v in cnt.most_common(15):
        w(f'| {pname(k)} | {v} |')
    w('')
    hir = [x for x in faster if any(t.startswith('Char_3P_Hirume_N@') for t in x['best']['squad'])]
    w(f'- 빠른 조합 중 {len(hir)}개에 천향의 히루메가 들어 있습니다. 히루메는 앞서 보고한 "버프 무한 중첩" 문제의 대상이라, 이 조합들의 속도는 그 문제가 고쳐지면 달라질 수 있습니다.')
    w('- 특정 전투원이 압도적으로 많이 나오면, 리뉴얼 전투에서 그 전투원이 지나치게 강하거나(밸런스) 스테이지 설계와 잘 맞물린다는 신호입니다.')
    w('')

    w(h + '# 단축 폭이 큰 스테이지 (상위 40)')
    w('')
    w('| 스테이지 | 표기 | 이름 | 공략 (전체 라운드/아군 턴, 인원) | 찾은 조합 (전체 라운드/아군 턴, 인원) | 찾은 조합 (칸) | 공략 제목 |')
    w('|---|---|---|---|---|---|---|')
    for x in sorted(faster, key=lambda x: (ratio(x), -gain(x)))[:40]:
        g, b, k = x['g'], x['best'], x['r']['stage']
        w(f"| {k} | {sidx(k)} | {sname(k)} | {g['medTotal']}/{g['medPc']}, {g['members']}명 | **{b['medTotal']}/{b['medPc']}**, {b['members']}명 | {sq(b['squad'])} | {g['title'][:40]} |")
    w('')
    if effic:
        w(h + '# 더 적은 인원으로 같거나 빠르게 (상위 30)')
        w('')
        w('| 스테이지 | 이름 | 공략 (전체, 인원) | 찾은 조합 (전체, 인원) | 찾은 조합 (칸) |')
        w('|---|---|---|---|---|')
        for x in sorted(effic, key=lambda x: (x['eff']['members'] - x['g']['members'], x['eff']['medTotal'] - x['g']['medTotal']))[:30]:
            g, e, k = x['g'], x['eff'], x['r']['stage']
            w(f"| {k} | {sname(k)} | {g['medTotal']}, {g['members']}명 | **{e['medTotal']}, {e['members']}명** | {sq(e['squad'])} |")
        w('')

    w(h + '# 구분별')
    w('')
    w('| 구분 | 비교 스테이지 | 빠른 조합 찾음 | 단축 중앙값 |')
    w('|---|---|---|---|')
    for c in ('메인', '이벤트', '챌린지'):
        v = [x for x in valid if cat(x['r']['stage']) == c]
        f = sorted(ratio(x) for x in v if x in faster)
        if v:
            w(f'| {c} | {len(v)} | {len(f)} | {str(round((1 - f[len(f) // 2]) * 100)) + "%" if f else "-"} |')
    w('')
    return L, valid, faster, effic, cnt


R_full = J(OUT, 'stage-beat-guides.json')['results']
bp = os.path.join(OUT, 'stage-beat-guides-budget.json')
R_bud = J(bp)['results'] if os.path.exists(bp) else []
L = ['# 커뮤니티 공략보다 빠르거나 효율적인 조합 탐색 리포트', '']
L += [f'- 기준: SVN r{rev}, 전투 시뮬레이터 자동 실행. 조건은 커뮤니티 공략 테스트와 같습니다: Lv100, 최대 등급, 스킬 Lv10, 대표 장비(자동 선택, 테스트 아이템 제외).',
      '- 속도 기준은 **전체 라운드**(적을 포함한 모든 유닛의 본 행동 수, 클라이언트가 서버에 보내는 라운드 값, 실제 클리어 시간에 가까움)이고, **아군 턴 = 아군의 본 행동 수(지원 공격·반격·연속 행동·예약 스킬 발동은 턴으로 세지 않음)**을 함께 적었습니다.',
      '- 표의 숫자는 시드 5개 중 전체 라운드가 가운데인 **한 판**의 값입니다(두 숫자가 같은 판에서 나옴). 공략 조합도 같은 시드로 다시 돌려 비교했고, 찾은 조합은 시드 5개 모두 클리어한 경우만 인정했습니다.',
      '- 두 가지 조건으로 찾았습니다.',
      '  - **같은 투자 조건:** 공략에 쓰인 전투원의 최고 시작 등급 이하 전투원만, 공략 인원 이하로. "공략과 같은 비용으로 더 빠른가"를 봅니다.',
      '  - **제한 없음:** 전투원 전체(모두 Lv100 최대 등급 가정). "최고 전력이면 얼마나 빨라지는가"를 봅니다. 저등급 파밍 공략과 비교하면 당연히 크게 빨라지므로 밸런스 참고용입니다.', '']
parts = []
if R_bud:
    Lb, vb, fb, eb, cb = section(R_bud, '1. 같은 투자 조건 (공략과 같은 비용)', [f'- 대상 {len(R_bud)}개 스테이지, 시험한 조합 {sum(r["squadsTried"] for r in R_bud):,}개.'])
    parts.append(Lb)
Lf, vf, ff, ef, cf = section(R_full, ('2' if R_bud else '1') + '. 제한 없음 (참고)', [f'- 대상 {len(R_full)}개 스테이지, 시험한 조합 {sum(r["squadsTried"] for r in R_full):,}개.'])
parts.append(Lf)
for p_ in parts: L += p_
L += ['## 읽을 때 주의할 점',
      '- 장비는 실제 공략의 세팅이 아니라 자동으로 고른 근사입니다. 특정 장비(반격·회피·행동력 OS 등)를 전제로 한 공략은 불리하게 측정될 수 있습니다.',
      '- 모든 전투원을 Lv100 최대 등급으로 가정했습니다. 유저 보유·승급 여부는 고려하지 않았습니다.',
      '- 전체 행동 수는 연출 길이를 반영하지 않습니다. 실제 클리어 시간은 스킬 연출에 따라 달라집니다.',
      '- 찾은 조합은 탐색으로 얻은 근사 최선입니다.',
      '- 칸 번호는 편성 화면 기준 1~9번(1행 왼쪽부터, 오른쪽 열이 전열)입니다.']
os.makedirs(os.path.join(SIM, 'reports'), exist_ok=True)
p = os.path.join(SIM, 'reports', f'공략대비_빠른조합_리포트_r{rev}.md')
open(p, 'w', encoding='utf-8').write('\n'.join(L) + '\n')
print(p)
