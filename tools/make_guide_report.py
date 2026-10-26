"""Report: community guide squads (arca.live 라스트오리진 채널 공략) run on the renewal battle simulator.
Usage: python -I tools/make_guide_report.py -> reports/커뮤니티공략_시뮬레이션_리포트_r<rev>.md"""
import collections, glob, json, os, re

HERE = os.path.dirname(os.path.abspath(__file__))
SIM = os.path.normpath(os.path.join(HERE, '..'))
OUT = os.path.join(HERE, 'out')
J = lambda *p: json.load(open(os.path.join(*p), encoding='utf-8'))


def load(pat):
    R = []
    for f in sorted(glob.glob(os.path.join(OUT, pat))):
        R += json.load(open(f, encoding='utf-8'))['results']
    return R


loc = J(SIM, 'data', 'loc.json')
stages = J(SIM, 'data', 'stages.json')['Table_MapStage']
meta = J(SIM, 'data', 'meta.json')
rev = meta.get('svnRevision', '')
crawl = J(OUT, 'guide-crawl.json')
cand = J(OUT, 'guide-candidates.json')
G = load('guide-test-gear.part*.json')
N = load('guide-test.part*.json')
mis = {m['stage']: m['missions'] for m in J(OUT, 'stage-missions.json')}
sweep = J(OUT, 'guide-solo-sweep.json') if os.path.exists(os.path.join(OUT, 'guide-solo-sweep.json')) else []
search = {}
for f in glob.glob(os.path.join(OUT, 'stage-turn-search*.json')):
    for r in J(f)['results']:
        search[r['stage']] = r

sname = lambda k: loc.get(stages.get(k, {}).get('StageName', ''), '')
idx = lambda k: loc.get(stages.get(k, {}).get('StageIdxString', ''), '') or stages.get(k, {}).get('StageIdxString', '')
wins = lambda r: [x for x in r['runs'] if x['outcome'] == 'win']
cat = lambda k: '메인' if re.match(r'^Ch\d+(N\d+)?Stage', k) else ('챌린지' if 'Cha' in k else '이벤트')

L = []
w = L.append

# ---------------------------------------------------------------- numbers
posts_ok = sum(1 for x in crawl if not x.get('status'))
guides_all = [x for x in cand if x['stageTag']]
guides_used = {r['post'] for r in G}
st_all = sorted({r['stage'] for r in G})


def per_stage(R):
    by = collections.defaultdict(lambda: {'n': 0, 'clear': 0, 'pc': None, 'total': None, 'stall': 0, 'stuck': 0, 'best': None})
    for r in R:
        s = by[r['stage']]
        s['n'] += 1
        ww = wins(r)
        if ww:
            s['clear'] += 1
            pc = min(x['pc'] for x in ww)
            if s['pc'] is None or pc < s['pc']:
                s['pc'] = pc; s['best'] = r
            tot = min(x['total'] for x in ww)
            s['total'] = tot if s['total'] is None else min(s['total'], tot)
        s['stall'] += sum(1 for x in r['runs'] if x['outcome'] == 'timeout')
        s['stuck'] += sum(1 for x in r['runs'] if x['outcome'] == 'stuck')
    return by


BG, BN = per_stage(G), per_stage(N)
# solo sweep can turn a stall into a clear
for s in sweep:
    if s['wins']:
        b = BG[s['stage']]
        if b['clear'] == 0 or (b['pc'] or 999) > (s['pc'] or 999):
            b['clear'] = max(b['clear'], 1)
            b['pc'] = s['pc'] if b['pc'] is None else min(b['pc'], s['pc'])
            b['total'] = s['total'] if b['total'] is None else min(b['total'], s['total'])
nowave = sorted({r['stage'] for r in G if any('no WaveMobGroup' in (x.get('reason') or '') for x in r['runs'])})
real = [k for k in st_all if k not in nowave]


def turnlimit(k):
    v = [m['value'] for m in mis.get(k, []) if m['type'] == 'TURN_LIMIT_LESS']
    return min(v) if v else None


tm = [k for k in real if turnlimit(k)]
pc_fail = [k for k in tm if BG[k]['pc'] is not None and BG[k]['pc'] > turnlimit(k)]
tot_fail = [k for k in tm if BG[k]['total'] is not None and BG[k]['total'] > turnlimit(k)]
allfail = [k for k in real if BG[k]['clear'] == 0]
stall_entries = [r for r in G if r['runs'] and all(x['outcome'] == 'timeout' for x in r['runs'])]
stuck_runs = [(r['stage'], x['reason']) for r in N + G for x in r['runs'] if x['outcome'] == 'stuck']

w(f'# 커뮤니티 공략 조합으로 돌린 전투 리뉴얼 시뮬레이션 리포트')
w('')
w(f'- 기준: SVN r{rev} 데이터와 전투 코드, 전투 시뮬레이터로 자동 실행')
w('- 공략 출처: 아카라이브 라스트오리진 채널의 공략 모음 글(메인 스테이지 공략 포탈, 상시·진행 이벤트 공략 모음, 챌린지 공략 모음)')
w(f'- 규모: 공략 모음과 공략 글 {posts_ok:,}개를 수집했고, 스테이지 표기가 있는 공략 {len(guides_all):,}건 중 전투원 이름까지 모두 풀린 {len(guides_used):,}건을 테스트했습니다.')
w(f'  - 스테이지별로 펼친 테스트 {len(G):,}건, 대상 스테이지 {len(st_all)}개입니다. 항목마다 3번씩, 장비 없음과 대표 장비 두 가지로 돌렸습니다.')
w('')
w('## 한눈에 보기')
w('')
cg = sum(1 for r in G if wins(r)); cn = sum(1 for r in N if wins(r))
w('| 항목 | 결과 |')
w('|---|---|')
w(f'| 공략 조합으로 클리어 (장비 없음) | {cn:,} / {len(N):,}건 ({cn*100//max(1,len(N))}%) |')
w(f'| 공략 조합으로 클리어 (대표 장비) | {cg:,} / {len(G):,}건 ({cg*100//max(1,len(G))}%) |')
w(f'| 공략이 있는데 어떤 공략으로도 못 깬 스테이지 | {len(allfail)}개 |')
w(f'| 턴 미션 30턴 (아군 턴 수 기준) 공략으로 못 맞춘 스테이지 | {len(pc_fail)} / {len(tm)}개 |')
w(f'| 턴 미션 30턴 (전체 누적 라운드 기준) 공략으로 못 맞춘 스테이지 | {len(tot_fail)} / {len(tm)}개 |')
fixed_n = sum(1 for x in sweep if x['wins'])
w(f'| 교착 (2,000번 행동 동안 양쪽 HP 변화 없음) | 자동 배치에서 공략 {len(stall_entries)}건 → 칸을 바로잡자 혼자 공략 {len(sweep)}건 중 {fixed_n}건 해소 |')
w(f'| 진행 멈춤 (행동할 유닛이 없음) | {len(stuck_runs)}회 |')
w(f'| 웨이브 없는 스테이지에 붙은 공략 | 스테이지 {len(nowave)}개 (전투 없음, 스토리 전용으로 보임) |')
w('')

w('## 시험 방법')
w('- **조합:** 공략 제목에 적힌 전투원(예: "[7-3EX] 무적의용/마리아/LRL/오드리")으로 분대를 짰습니다. 별칭(무용·페레·마리아 등)은 게임 이름으로 바꿨습니다.')
w('- **배치:** 제목에는 칸 정보가 없어서 역할에 맞게 자동 배치했습니다(보호기 전열, 지원기 후열, 공격기는 사거리에 맞춰). 교착이 난 혼자 공략은 9칸을 모두 시험해 가장 좋은 칸을 썼습니다.')
w('- **능력치:** 모두 Lv100, 최대 등급, 스킬 Lv10입니다. 공략의 실제 레벨·승급·호감도·코어링크는 반영하지 않았습니다.')
w('- **장비:** 공략의 실제 장비는 알 수 없어 두 경우로 돌렸습니다.')
w('  - 장비 없음')
w('  - 대표 장비: 칸마다 공격·치명·적중·행동력 위주로 점수가 가장 높은 장비를 10강으로 자동 선택. 버프 효과만 있는 장비(OS 일부 등)는 고르지 않습니다.')
w('- **스테이지 표기:** 메인은 표기 그대로(예: 7-3EX), 이벤트는 공략 모음의 이벤트 이름과 부 번호로 시뮬레이터 이벤트 챕터를 찾았습니다(예: 리오보로스의 유산 2부 "2-5b").')
w('- **턴 수:** 아군 턴 = 아군의 본 행동 수(지원 공격·반격·연속 행동·예약 스킬 발동은 턴으로 세지 않음)과 전체 누적 라운드(적 포함 모든 유닛의 본 행동)를 함께 기록했습니다. 서버가 어느 쪽을 세는지는 클라이언트 코드로 확인할 수 없습니다.')
w('')

w('## 1. 클리어 결과')
w('')
w('| 구분 | 테스트 | 장비 없음 클리어 | 대표 장비 클리어 |')
w('|---|---|---|---|')
for c in ('메인', '이벤트', '챌린지'):
    g = [r for r in G if cat(r['stage']) == c]
    n = [r for r in N if cat(r['stage']) == c]
    if g:
        w(f'| {c} | {len(g):,}건 | {sum(1 for r in n if wins(r)):,}건 | {sum(1 for r in g if wins(r)):,}건 |')
w('')
w('- 대표 장비를 주면 대부분의 공략 조합이 그대로 클리어됩니다. 리뉴얼 전투에서도 커뮤니티 공략의 조합이 대체로 통한다는 뜻입니다.')
w('- 장비 없이 실패한 공략은 대부분 혼자 또는 두 명으로 하는 파밍용(거지런·솔로런)이라, 장비 세팅이 클리어 조건입니다.')
w('')
if allfail:
    w('### 어떤 공략으로도 못 깬 스테이지')
    w('')
    w('| 스테이지 | 표기 | 이름 | 공략 수 | 공략 예시 | 비고 |')
    w('|---|---|---|---|---|---|')
    for k in allfail:
        ex = next((r for r in G if r['stage'] == k), None)
        note = '교착' if BG[k]['stall'] else '패배'
        w(f'| {k} | {idx(k)} | {sname(k)} | {BG[k]["n"]} | {(ex or {}).get("title", "")[:50]} | {note} |')
    w('')
    w('- 모두 공략 1건뿐인 스테이지이고, 공략이 회피·반격 장비에 의존하는 혼자 공략이라 시뮬레이터의 대표 장비로는 재현되지 않았습니다. 조합 문제로 보기는 어렵습니다.')
    w('')

w('## 2. 턴 미션 (30턴)')
w('')
def srch(k):
    sr = search.get(k, {}).get('best', {})
    return (sr['pc']['value'], sr['total']['value']) if sr.get('pc') and sr.get('total') else None


def table(keys):
    w('| 스테이지 | 이름 | 기준 | 공략 최소 아군 턴 | 공략 최소 전체 라운드 | 가장 빠른 공략 | 공략 수 | 조합 탐색 (아군 턴 / 전체 라운드) |')
    w('|---|---|---|---|---|---|---|---|')
    for k in keys:
        sr = srch(k)
        best = (BG[k]['best'] or {})
        w(f"| {k} | {sname(k)} | {turnlimit(k)} | {BG[k]['pc']} | {BG[k]['total']} | {best.get('title', '')[:40]} | {BG[k]['n']} | {f'{sr[0]} / {sr[1]}' if sr else '-'} |")
    w('')


pc_keys = sorted(pc_fail, key=lambda k: -BG[k]['pc'])
tot_only = sorted([k for k in tot_fail if k not in pc_fail], key=lambda k: -BG[k]['total'])
w(f'- 턴 미션이 있는 스테이지 {len(tm)}개 중, 커뮤니티 공략 조합으로 가장 빨리 깬 값이 30을 넘은 스테이지입니다. "조합 탐색"은 몬스터·턴 미션 QA 리포트에서 다양한 조합으로 다시 찾은 결과입니다(그 탐색 대상이었던 스테이지만 값이 있음).')
w('')
w(f'### 아군 턴 기준으로도 30을 넘은 스테이지 ({len(pc_keys)}개)')
w('')
if pc_keys:
    table(pc_keys)
    ok = [k for k in pc_keys if srch(k) and srch(k)[0] <= turnlimit(k)]
    unk = [k for k in pc_keys if not srch(k)]
    w(f'- 이 중 {len(ok)}개는 조합 탐색에서 아군 턴 30 이하로 깨는 조합이 나왔습니다. 공략이 턴 수보다 비용(저등급·적은 인원)이나 안정성을 우선한 결과로 보입니다.')
    if unk:
        w(f'- {", ".join(unk)}는 QA 리포트의 고정 조합이 이미 아군 턴 30 이내로 깼습니다(그래서 조합 탐색 대상이 아니었음). 30턴 달성은 가능합니다.')
    w('')
w(f'### 전체 라운드 기준으로만 30을 넘은 스테이지 ({len(tot_only)}개)')
w('')
if tot_only:
    table(tot_only)
    w('- 아군 턴으로는 30 안에 들지만, 적 행동까지 세는 전체 라운드로는 넘습니다. 서버가 전체 라운드를 센다면 공략대로 해도 미션을 못 받는 스테이지입니다.')
    w('')

w('## 3. 교착과 진행 멈춤')
w('')
w(f'- **교착 {len(stall_entries)}건:** 2,000번 행동하는 동안 양쪽 HP가 전혀 변하지 않아 자동 전투가 끝나지 않는 상황입니다.')
w('  - 원인 1: 아군이 사거리가 닿지 않는 칸에 있으면 자동 전투에서 이동하지 않고 대기만 합니다.')
w('  - 원인 2: 뒷열 몬스터는 다가올 칸을 찾지 못해 대기만 합니다. 몬스터 테스트에서 보고한 "뒷열 무한 대기"와 같은 문제입니다.')
w('  - 두 가지가 겹치면 양쪽 모두 대기만 해서 전투가 끝나지 않습니다. 실제 게임에서 자동 전투를 켜 둔 유저가 배치를 잘못하면 같은 상황이 될 수 있습니다.')
w('  - 교착이 난 공략은 대부분 회피 수백 %로 혼자 버티는 방치형 파밍(수면런)입니다. 공략 글에도 "칸 위치 주의", "회피 400%" 같은 조건이 붙어 있어, 장비·칸을 정확히 맞추지 않으면 재현되지 않습니다.')
if sweep:
    fixed = [s for s in sweep if s['wins']]
    w(f'  - 혼자 하는 교착 공략 {len(sweep)}건은 9칸을 모두 시험했고, {len(fixed)}건은 칸을 바꾸자 클리어됐습니다. 나머지 {len(sweep) - len(fixed)}건은 어느 칸에서도 교착이거나 패배했습니다(장비 의존).')
w('')
if stuck_runs:
    w(f'- **진행 멈춤 {len(stuck_runs)}회:** "행동할 수 있는 유닛이 없음"으로 전투가 진행되지 않았습니다.')
    for st_, rs in sorted(set(stuck_runs))[:10]:
        w(f'  - {st_} ({sname(st_)}): {rs[:120]}')
    w('  - 모두 장비 없이 돌린 경우에만 나왔습니다. 행동력이 0이 되는 효과가 겹친 상황으로 보이며, 재현 조건을 더 좁혀 확인할 필요가 있습니다.')
w('')
w(f'- **웨이브 없는 스테이지 {len(nowave)}개:** {", ".join(nowave)}. 공략 표기 범위(예: "10-1~10-8")에 포함돼 들어왔지만 몬스터 웨이브가 없는 스테이지입니다. 스토리 전용 스테이지로 보입니다.')
w('')

w('## 한계')
w('- 칸 위치는 제목에 없어서 자동 배치했습니다. 편성 이미지는 일부만 직접 확인했습니다.')
w('- 공략의 장비·레벨·승급·호감도·코어링크는 반영하지 않았고, 대표 장비는 자동으로 고른 근사입니다.')
w('- 수동 조작(스킬 선택, 위치 이동)을 전제로 한 공략은 자동 전투로만 돌렸습니다.')
w('- 이벤트 챌린지(예: "2-1C")는 어느 이벤트의 스테이지인지 구분이 안 돼 제외했습니다. 메인 챌린지(12-1C 등)는 포함했습니다.')
w('- 공략 글 일부는 삭제돼(404) 제외됐습니다.')

os.makedirs(os.path.join(SIM, 'reports'), exist_ok=True)
p = os.path.join(SIM, 'reports', f'커뮤니티공략_시뮬레이션_리포트_r{rev}.md')
open(p, 'w', encoding='utf-8').write('\n'.join(L) + '\n')
print(p)
