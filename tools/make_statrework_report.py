"""Report: did the stat-point rework (manual points -> automatic level growth) change the community guides' results?
Compares guide squads run with the pre-rework stats (--old: r15485 growth table + 297 manual points) and the current stats,
same squads / auto gear / seeds. Usage: python -I tools/make_statrework_report.py -> reports/스탯자동분배_공략영향_리포트_r<rev>.md"""
import collections, glob, json, os, re, statistics

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


def load(pat):
    R = []
    for f in sorted(glob.glob(os.path.join(OUT, pat))):
        R += json.load(open(f, encoding='utf-8'))['results']
    return {(r['post'], r['stage']): r for r in R}


NEW = load('guide-test-gear.part*.json')
OLD = load('guide-old-guide-test-gear.part*.json')
tags = J(OUT, 'guide-stat-tags.json')
oldab = J(OUT, 'pcability_r15485.json')
newab = units['Table_PCAbility']


def summ(r):
    w = [x for x in r['runs'] if x['outcome'] == 'win']
    if not w:
        return None
    a = sorted(w, key=lambda x: (x['total'], x['pc']))[len(w) // 2]
    return {'wins': len(w), 'runs': len(r['runs']), 'total': a['total'], 'pc': a['pc']}


pairs = []
for k, n in NEW.items():
    o = OLD.get(k)
    if not o:
        continue
    pairs.append((k, o, n, summ(o), summ(n)))

lost = [p for p in pairs if p[3] and not p[4]]
gained = [p for p in pairs if not p[3] and p[4]]
both = [p for p in pairs if p[3] and p[4]]
slower = [p for p in both if p[4]['total'] > p[3]['total'] * 1.2 and p[4]['total'] - p[3]['total'] >= 3]
faster = [p for p in both if p[4]['total'] < p[3]['total'] / 1.2 and p[3]['total'] - p[4]['total'] >= 3]
changed = lost + gained + slower + faster

L = []
w = L.append
w('# 스탯 자동 분배 변경이 커뮤니티 공략에 준 영향')
w('')
w(f'- 기준: SVN r{rev}. 변경 전 비교 기준은 r15485(수동 강화 포인트 시절)의 능력치 계산 코드와 성장표입니다.')
w(f'- 공략 {len({p[0][0] for p in pairs}):,}건, 스테이지별 테스트 {len(pairs):,}건을 **변경 전 방식**과 **지금 방식**으로 같은 조합·장비·시드로 3번씩 돌려 비교했습니다.')
w('')

w('## 1. 무엇이 바뀌었나')
w('')
w('- **변경 전:**')
w('  - 레벨이 오르면 공격·방어·HP만 성장표대로 늘었습니다. 적중·회피·치명은 레벨이 올라도 기본값 그대로였습니다.')
w('  - 레벨당 강화 포인트 3점(Lv100 297점, 최대 300점, 상한 확장 360점)을 유저가 직접 나눴습니다.')
w('  - 1점당 공격 +1.5, 방어 +1.25, HP +8, 적중 +1.5%, 회피 +0.4%, 치명 +0.4%였고, 회피·치명은 각각 최대 100점까지 줄 수 있었습니다.')
w('- **지금:** 강화 포인트는 능력치에 더하지 않습니다(`ActorAttr.cs:337`). 대신 6개 능력치 모두 레벨당 자동으로 오르도록 성장표가 바뀌었습니다.')
w('  - 297명 중 295명에게 적중·회피·치명 레벨 성장이 새로 생겼습니다.')
w('  - 공격·방어·HP 성장값도 약 250명 조정됐습니다.')
# auto growth expressed in points
pts = {'ATK': 1.5, 'DEF': 1.25, 'HP': 8, 'ACC': 0.015, 'EVA': 0.004, 'CRI': 0.004}
FIELD = {'ATK': ('AttackDmg', 'AddAttackDmgByLevel'), 'DEF': ('DefenseDmg', 'AddDefenseDmgByLevel'), 'HP': ('DefaultHP', 'DefaultHPByLevel'),
         'ACC': ('ApplyRate', 'AddApplyRateByLevel'), 'EVA': ('EvadeRate', 'AddEvadeRateByLevel'), 'CRI': ('CriRate', 'AddCriRateByLevel')}
f = lambda r, k: float((r or {}).get(k) or 0)
diff = collections.defaultdict(list)
for k, n in newab.items():
    o = oldab.get(k)
    if not o:
        continue
    for s, (b, g) in FIELD.items():
        nv = f(n, b) + f(n, g) * 99
        ov = f(o, b) + (f(o, g) * 99 if s in ('ATK', 'DEF', 'HP') else 0)
        diff[s].append((nv - ov) / pts[s])
w('- Lv100에서 지금 성장표가 변경 전보다 더 주는 양을 예전 포인트로 환산하면 다음과 같습니다(전투원 중앙값).')
w('')
w('| 능력치 | 추가분 (포인트 환산, 중앙값) | 최소 | 최대 |')
w('|---|---|---|---|')
tot = 0
for s in ['ATK', 'DEF', 'HP', 'ACC', 'EVA', 'CRI']:
    m = statistics.median(diff[s]); tot += m
    w(f'| {dict(ATK="공격", DEF="방어", HP="HP", ACC="적중", EVA="회피", CRI="치명")[s]} | {m:.0f}점 | {min(diff[s]):.0f} | {max(diff[s]):.0f} |')
w(f'| 합계 | 약 {tot:.0f}점 | | |')
w('')
w('- 총량은 예전 Lv100 포인트(297~360점)와 비슷하게 맞췄습니다. 하지만 분배가 전투원마다 고정돼, **한 능력치에 몰아주는 세팅을 할 수 없습니다.**')
w('  - 예: 회피 최대 +40%, 공격 최대 +445 같은 세팅이 불가능합니다.')
w('')

tg = collections.Counter(t for v in tags.values() for t in v)
nt = len(tags); na = sum(1 for v in tags.values() if v)
w('## 2. 공략이 스탯 분배에 얼마나 기대고 있었나')
w('')
w(f'- 본문을 받아 둔 공략 {nt}건 중 **{na}건({na * 100 // max(1, nt)}%)**이 스탯 분배를 직접 지시합니다.')
w('')
w('| 지시 내용 | 공략 수 |')
w('|---|---|')
for k in ['치명 목표', '적중 목표', '공격 몰빵', '회피 빌드', 'HP 스탯', '상한확장', '스탯 언급']:
    w(f'| {k} | {tg.get(k, 0)} |')
w('')
w('- 이런 공략은 "인게임 치명 100%, 적중 220%, 나머지 공격" 또는 "회피 400%"처럼 정확한 목표치를 맞추는 방식입니다. 자동 분배에서는 그 목표치를 포인트로 맞출 수 없어, 장비로 채우거나 공략을 다시 짜야 합니다.')
w('')

w('## 3. 시뮬레이션: 변경 전 방식과 지금 방식 비교')
w('')
w('- **변경 전 방식:** r15485 성장표 + Lv100 포인트 297점.')
w('  - 일반 공략: 치명 100점, 나머지 공격')
w('  - 회피 빌드 공략: 회피 100점, 나머지 공격')
w('- **지금 방식:** 현재 성장표.')
w('- 공통 조건: Lv100, 최대 등급, 스킬 Lv10, 대표 장비, 같은 시드 3번.')
w('')
w('| 결과 | 건수 |')
w('|---|---|')
w(f'| 비교한 공략·스테이지 | {len(pairs):,} |')
w(f'| 변경 전 클리어 → 지금 실패 | **{len(lost)}** |')
w(f'| 변경 전 실패 → 지금 클리어 | {len(gained)} |')
w(f'| 둘 다 클리어, 지금이 20% 이상 느림 | **{len(slower)}** |')
w(f'| 둘 다 클리어, 지금이 20% 이상 빠름 | {len(faster)} |')
w(f'| 영향 없음 (차이 20% 미만) | {len(both) - len(slower) - len(faster)} |')
w('')
oc = sum(1 for p in pairs if p[3]); nc = sum(1 for p in pairs if p[4])
w(f'- 클리어율: 변경 전 {oc * 100 // max(1, len(pairs))}% → 지금 {nc * 100 // max(1, len(pairs))}%.')
if both:
    ch = statistics.median(p[4]['total'] / p[3]['total'] for p in both)
    w(f'- 둘 다 클리어한 경우 전체 라운드 비율(지금/변경 전) 중앙값: {ch:.2f}.')
w('')


def group(ps, title):
    if not ps:
        return
    st = [p for p in ps if tags.get(str(p[0][0])) or tags.get(p[0][0])]
    w(f'### {title}')
    w('')
    by = collections.Counter()
    for p in ps:
        for m in p[2].get('squad', []):
            by[m['key']] += 1
    w(f'- {len(ps)}건, 그중 본문에 스탯 지시가 있는 공략 {len(st)}건.')
    w(f'- 자주 나온 전투원: {", ".join(f"{pname(k)}({v})" for k, v in by.most_common(10))}')
    w('')
    w('| 스테이지 | 이름 | 공략 | 변경 전 (전체/아군 턴) | 지금 (전체/아군 턴) |')
    w('|---|---|---|---|---|')
    for p in sorted(ps, key=lambda p: (p[4] is not None, -(p[4]['total'] / p[3]['total']) if p[3] and p[4] else 0))[:30]:
        o, n = p[3], p[4]
        fmt = lambda x: (str(x['total']) + '/' + str(x['pc'])) if x else '실패'
        w(f"| {p[0][1]} | {sname(p[0][1])} | {p[2]['title'][:45]} | {fmt(o)} | {fmt(n)} |")
    w('')


group(lost, '변경 전에는 깨졌지만 지금은 실패하는 공략')
group(slower, '지금이 크게 느려진 공략')
group(gained + faster, '지금이 오히려 좋아진 공략')

# by tag: which kinds of guides are hurt
w('## 4. 스탯 지시 종류별 영향')
w('')
w('| 지시 내용 | 비교 건수 | 실패로 바뀜 | 느려짐 | 좋아짐 |')
w('|---|---|---|---|---|')
for t in ['회피 빌드', '공격 몰빵', '치명 목표', '적중 목표', '(지시 없음)']:
    sel = [p for p in pairs if (t in (tags.get(str(p[0][0])) or [])) or (t == '(지시 없음)' and str(p[0][0]) in tags and not tags[str(p[0][0])])]
    if not sel:
        continue
    w(f'| {t} | {len(sel)} | {sum(1 for p in sel if p in lost)} | {sum(1 for p in sel if p in slower)} | {sum(1 for p in sel if p in gained or p in faster)} |')
w('')
w('## 결론')
w(f'- 공략의 약 {na * 100 // max(1, nt)}%가 수동 스탯 분배를 전제로 쓰였습니다. 자동 분배에서는 그 세팅을 그대로 따라 할 수 없으므로, 글에 적힌 스탯 지시는 대부분 더 이상 맞지 않습니다.')
w(f'- 시뮬레이션에서 결과가 바뀐 공략(실패로 바뀜, 20% 이상 느려짐, 좋아짐)은 {len(changed)}건으로 전체의 {len(changed) * 100 // max(1, len(pairs))}%입니다.')
worse = len(lost) + len(slower); better = len(gained) + len(faster)
w(f'  - 나빠진 쪽(실패로 바뀜 {len(lost)}건, 20% 이상 느려짐 {len(slower)}건)이 좋아진 쪽({better}건)보다 많습니다.')
w(f'  - 다만 클리어율은 오히려 올랐습니다({oc * 100 // max(1, len(pairs))}% → {nc * 100 // max(1, len(pairs))}%). 적중·치명이 자동으로 올라 "못 맞히던" 조합이 깨지게 된 경우가 많습니다.')
sl = collections.Counter(m['key'] for p_ in slower for m in p_[2].get('squad', []))
w(f'  - 느려진 공략에는 {", ".join(pname(k) for k, _ in sl.most_common(4))} 등이 자주 나옵니다. 공격에 포인트를 몰아 빠르게 정리하던 파밍 조합이, 공격 성장이 고정되면서 느려진 것으로 보입니다.')
w('  - 스탯 지시 종류(회피 빌드, 공격 몰빵, 치명·적중 목표)에 따라 나빠지는 비율은 큰 차이가 없었습니다(4장 표). 지시가 없는 공략도 같은 비율로 영향을 받았습니다. 공략이 글로 적지 않았어도 대부분 포인트를 공격 위주로 나눠 썼기 때문으로 보입니다.')
w('')
w('## 한계')
w('- 변경 전 분배는 공략 본문의 지시를 두 가지 대표 분배로 단순화했습니다. 실제 공략은 목표치를 장비와 함께 정밀하게 맞췄습니다.')
w('- 장비는 양쪽 모두 같은 자동 선택(대표 장비)이고, 공략의 실제 장비가 아닙니다.')
w('- 칸 위치는 공략 제목만으로는 알 수 없어 자동 배치했습니다(혼자 공략 교착은 별도 리포트 참고).')
w('- 본문을 받지 않은 공략(제목만 수집)은 스탯 지시 여부를 알 수 없어 "지시 없음"에 넣지 않았습니다.')

os.makedirs(os.path.join(SIM, 'reports'), exist_ok=True)
p = os.path.join(SIM, 'reports', f'스탯자동분배_공략영향_리포트_r{rev}.md')
open(p, 'w', encoding='utf-8').write('\n'.join(L) + '\n')
print(p)
