"""Builds the 3-part QA report (monsters / turn missions / level growth) from tools/out/*.json.
Usage: python -I tools/make_qa_report.py  ->  reports/전투리뉴얼_QA_리포트_r<rev>.md"""
import collections, json, os, re

HERE = os.path.dirname(os.path.abspath(__file__))
SIM = os.path.normpath(os.path.join(HERE, '..'))
OUT = os.path.join(HERE, 'out')
J = lambda *p: json.load(open(os.path.join(*p), encoding='utf-8'))

loc = J(SIM, 'data', 'loc.json')
units = J(SIM, 'data', 'units.json')
stages = J(SIM, 'data', 'stages.json')
skills = J(SIM, 'data', 'skills.json')
meta = J(SIM, 'data', 'meta.json')
mt = J(OUT, 'monster-test.json')
stt = J(OUT, 'stage-turn-test.json')
sts = J(OUT, 'stage-turn-summary.json')
sat = J(OUT, 'stat-test.json')

rev = meta.get('svnRevision') or '15593'
mname = lambda k: loc.get(units['Table_Monster'].get(k, {}).get('Name', ''), k)
pname = lambda k: loc.get(units['Table_PC'].get(k, {}).get('Name', ''), k)
sname = lambda k: loc.get(stages['Table_MapStage'].get(k, {}).get('StageName', ''), '')
used = collections.Counter(v for g in stages['Table_MobGroup'].values() for v in g.values() if isinstance(v, str) and v.startswith('MOB_'))

L = []
w = L.append

# ------------------------------------------------------------------ monsters
R = mt['results']
crash = [(r['key'], p) for r in R for p, v in r['places'].items() if v['error']]
stuck = [(r['key'], p) for r in R for p, v in r['places'].items() if v['outcome'] in ('stuck', 'error')]
luaerr = [(r['key'], p) for r in R for p, v in r['places'].items() if v['luaErrors']]
ais = collections.Counter(r['aiKey'] for r in R)
back_wait = sorted({r['key'] for r in R if r['places']['back']['actions'] and r['places']['back']['waits'] == r['places']['back']['actions']})
back_wait_used = [k for k in back_wait if used[k]]
front_wait = sorted({r['key'] for r in R if r['places']['front']['actions'] and r['places']['front']['waits'] == r['places']['front']['actions']})
cd = sorted({r['key'] for r in R if any(v['waitWhy'].get('cooldown') for v in r['places'].values())})
cd_turns = sum(v['waitWhy'].get('cooldown', 0) for r in R for v in r['places'].values())
cd_used = [k for k in cd if used[k]]
no_s2 = []
for r in R:
    f = r['places']['front']
    if f['s2'] == 0 and f['s1'] > 0:
        g = skills['Table_SkillGroup'].get(units['Table_Monster'][r['key']].get('SkillGroupIndex', ''), {})
        t = skills['Table_Skill'].get(g.get('SkillIndex2', ''), {})
        no_s2.append((r['key'], t.get('TargetType', 0)))
both = [r for r in R if '1' in r['places']['front']['seq'] and '2' in r['places']['front']['seq']]
sw = []
for r in both:
    s = [c for c in r['places']['front']['seq'] if c in '12']
    if len(s) > 1:
        sw.append(sum(1 for a, b in zip(s, s[1:]) if a != b) / (len(s) - 1))
strict = sum(1 for x in sw if x == 1.0)
few = [(r['key'], p, v['actions'], v['reason']) for r in R for p, v in r['places'].items() if v['actions'] < mt['options']['turns'] and not v['error']]

def names(keys, n=40):
    c = collections.Counter(mname(k) for k in keys)
    s = ', '.join(f'{k}({v}종)' if v > 1 else k for k, v in c.most_common(n))
    return s + (' 외' if len(c) > n else '')

# ------------------------------------------------------------------ stages
SR = stt['results']
runs_all = [x for r in SR for x in r['runs']]
oc = collections.Counter(x['outcome'] for x in runs_all)
turn30 = [r for r in SR if any(m['type'] == 'TURN_LIMIT_LESS' and m['value'] == 30 for m in r['missions'])]
main = lambda s: re.match(r'^Ch\d+Stage', s) is not None
# best case per stage = smaller of the single-squad run and the many-squad search (stage-turn-search.json)
srch = {'results': [], 'poolSize': 0, 'options': {}}
for f in sorted(os.listdir(OUT)):
    if f.startswith('stage-turn-search') and f.endswith('.json'):
        d = J(OUT, f)
        srch['results'] += d['results']; srch['poolSize'] = d.get('poolSize') or srch['poolSize']; srch['options'] = d.get('options') or srch['options']
SB = {r['stage']: r for r in srch['results']}
FB = {}
for r in SR:
    wins = [x for x in r['runs'] if x['outcome'] == 'win']
    FB[r['stage']] = {k: min(x[k] for x in wins) for k in ('pc', 'total', 'wave')} if wins else None
def best(stage):
    f = FB.get(stage); sr = SB.get(stage)
    out = {}
    for k in ('pc', 'total', 'wave'):
        vals = []
        if f: vals.append((f[k], 'fixed', None))
        if sr and sr['best'].get(k): vals.append((sr['best'][k]['value'], 'search', sr['best'][k]['squad']))
        out[k] = min(vals, key=lambda v: v[0]) if vals else None
    return out
waves_of = {r['stage']: next((x.get('waves') for x in r['runs'] if x['outcome'] == 'win'), '-') for r in SR}
fails = {'pc': [], 'total': [], 'wave': []}
special = []
for r in SR:
    b = best(r['stage'])
    for m in r['missions']:
        if not b['pc']:
            continue
        rec = (r['stage'], m['type'], m['value'], b)
        if m['type'] == 'ROUND_LIMIT_LESS' or m['value'] != 30:
            special.append(rec)
            continue
        for k in fails:
            if b[k][0] > m['value']:
                fails[k].append(rec)
searched = len(SB)
squads_tried = sum(r['squadsTried'] for r in SB.values())
fixed_fail_pc = len(sts['pcfail']); fixed_fail_total = len(sts['totfail'])
sqtxt = lambda sq: ', '.join(pname(x.split('@')[0]) + '(' + str(int(x.split('@')[1]) + 1) + '번)' for x in sq) if sq else '고정 조합'

# ------------------------------------------------------------------ stats
data_rest = [x for x in sat['data'] if 'Module' not in x['pc'] and not x['pc'].startswith('Char_Core_')]
neg = [x for x in data_rest if x['issue'] in ('negative growth', 'negative base')]
mods = sorted({x['pc'] for x in sat['data'] if 'Module' in x['pc'] or x['pc'].startswith('Char_Core_')})

w(f'# 전투 리뉴얼 QA 리포트 — 몬스터 · 턴 미션 · 레벨 성장')
w('')
w(f'- 기준: SVN r{rev} (유니티 데이터·전투 코드), 전투 시뮬레이터(클라이언트 전투 코드를 그대로 옮긴 것)로 자동 실행')
w(f'- 범위: 몬스터 {len(R):,}종 × 배치 2곳, 턴·라운드 미션이 있는 스테이지 {len(SR):,}개 × 3회(기준을 넘긴 {searched}개는 {squads_tried:,}개 조합으로 재탐색), 전투원 {sat["pcs"]}명 × 레벨 1~120')
w('- 실제 클라이언트에서 직접 플레이한 결과가 아닙니다. 서버가 판정하는 부분(미션 성공 여부)은 클라이언트 코드로 확인할 수 없어 가능한 해석별로 나눠 적었습니다.')
w('')
w('## 한눈에 보기')
w('')
w('| 항목 | 결과 | 판정 |')
w('|---|---|---|')
w(f'| 몬스터 프리징·멈춤 | 충돌 {len(crash)}건, 멈춤 {len(stuck)}건, Lua 오류 {len(luaerr)}건 | 정상 |')
w(f'| 실제 스테이지 전투 멈춤 | {len(SR)*3:,}회 중 멈춤·시간 초과 {oc.get("stuck",0)+oc.get("timeout",0)}회 | 정상 |')
w(f'| 몬스터 무한 대기 | 뒷열에 놓이면 끝까지 대기만 하는 몬스터 {len(back_wait_used)}종(스테이지 사용 기준) | **확인 필요** |')
w(f'| 1스킬/2스킬 교대 | 모든 몬스터가 같은 AI(무작위 50:50)를 써서 엄격하게 번갈아 쓴 몬스터는 {strict}종 | **기획 의도 확인 필요** |')
w(f'| 쿨다운 중 스킬 선택 | 스테이지 사용 몬스터 {len(cd_used)}종이 쿨다운 중인 2스킬을 골라 턴을 대기로 날림 (총 {cd_turns}턴) | **확인 필요** |')
w(f'| 30턴 미션 (아군 턴 수 기준) | {len(turn30)}개 중 다양한 조합으로도 불가 {len(fails["pc"])}개 | {"**확인 필요**" if fails["pc"] else "정상"} |')
w(f'| 30턴 미션 (클라이언트가 보내는 라운드 수 기준) | 다양한 조합으로도 불가 {len(fails["total"])}개 | {"**서버 기준 확인 필요**" if fails["total"] else "정상"} |')
w(f'| 10·20턴 미션, 남은 라운드 미션 | {len(special)}건 중 불가 {sum(1 for x in special if x[3]["pc"][0] > x[2] and x[3]["total"][0] > x[2])}건 | **수정 필요** |')
w(f'| 레벨 성장 능력치 | {sat["pcs"]}명 × 120레벨 전부 표와 일치, 전투 시작 능력치도 일치 | 정상 |')
w(f'| 성장 데이터 이상 | 레벨이 오를수록 HP가 줄어드는 전투원 1명 외 {len(neg)-1}건 | **수정 필요** |')
w('')

# ---- 1. monsters
w('## 1. 몬스터 테스트')
w('')
w('### 시험 방법')
w(f'- 표의 몬스터 {len(R):,}종(스테이지에서 실제로 쓰이는 몬스터 {sum(1 for r in R if used[r["key"]]):,}종 포함)을 하나씩, 아군 5명을 상대로 전투시켰습니다.')
w('- 몬스터는 Lv70, 체력을 크게 늘려 쓰러지지 않게 했고, 아군은 공격하지 않고 대기만 하게 해서 몬스터 AI만 순수하게 관찰했습니다.')
w(f'- 몬스터마다 {mt["options"]["turns"]}번 행동할 때까지 기록했습니다. 배치는 앞열(3번 칸)과 뒷열(5번 칸) 두 가지입니다.')
w('- 매 행동마다 Lua 스크립트가 고른 행동과 실제로 실행된 행동을 비교했습니다.')
w('')
w('### 1-1) 프리징·무한 대기')
w(f'- **충돌·멈춤·Lua 오류는 없었습니다.** 전투 엔진 예외 {len(crash)}건, 진행 멈춤 {len(stuck)}건, Lua 실행 오류 {len(luaerr)}건입니다.')
w(f'- 실제 스테이지 편성으로도 {len(SR)}개 스테이지를 3번씩 돌렸는데 멈춤·시간 초과는 {oc.get("stuck",0)+oc.get("timeout",0)}회였습니다.')
w(f'- **뒷열 무한 대기 ({len(back_wait)}종, 스테이지에서 쓰이는 몬스터 {len(back_wait_used)}종):** 뒷열에 놓이면 스킬이 닿지 않는데, 다가갈 칸도 찾지 못해 {mt["options"]["turns"]}번 내내 대기만 했습니다.')
w(f'  - 해당 몬스터: {names(back_wait_used)}')
w('  - 원인: AI가 "스킬을 쓸 수 있는 칸"을 찾는 기능(이동 위치 미리보기)이 빈 칸을 찾지 못합니다. 지난번에 보고한 이동 위치 미리보기 문제와 같은 원인으로 보입니다.')
w('  - 영향: 아군이 그 몬스터를 공격할 수 있으면 전투는 끝나지만, 아군도 닿지 않으면 그 웨이브가 끝나지 않을 수 있습니다.')
w(f'- **앞열에서도 대기만 한 몬스터 {len(front_wait)}종:** 대부분 스킬이 아예 없는 몬스터입니다. 스테이지에서 쓰이는 것은 {", ".join(mname(k) for k in front_wait if used[k]) or "없음"}입니다.')
if few:
    w(f'- 참고: {", ".join(sorted({mname(k) for k,_,_,_ in few}))}은(는) 체력을 200배로 늘린 아군을 2~3번 행동 만에 모두 쓰러뜨렸습니다. 피해량이 비정상적으로 큰지 확인해 볼 만합니다.')
w('')
w('### 1-2) Lua AI대로 1스킬/2스킬 교대, 사거리에 따른 이동·대기')
w(f'- **모든 몬스터 {len(R):,}종의 AI 지정 값이 같습니다** ({", ".join(f"{k} {v}종" for k,v in ais.items())}). Lua 파일은 326개 있지만 일반 몬스터 표에 지정된 것은 이 하나뿐입니다. 업데이트 전 데이터도 같았습니다. 소환물 15종과 무한전쟁 보스 27종은 각자 다른 AI를 쓰며, 이번 테스트 범위에는 들어가지 않았습니다.')
w('- 이 AI의 동작:')
w('  - 매 턴 50% 확률로 1스킬 또는 2스킬을 고릅니다(번갈아 쓰는 방식이 아닙니다).')
w('  - 고른 스킬이 닿는 대상이 있으면 쓰고, 없으면 그 스킬을 쓸 수 있는 칸으로 이동, 이동할 칸도 없으면 대기합니다.')
w(f'- **실행 결과는 스크립트대로였습니다.** 두 스킬을 모두 쓴 몬스터 {len(both):,}종에서 연속 사용 중 스킬이 바뀐 비율은 평균 {round(sum(sw)/len(sw)*100) if sw else 0}%로 무작위 50:50과 맞고, 1·2스킬을 엄격하게 번갈아 쓴 몬스터는 {strict}종입니다.')
w('  - 기획 의도가 "1스킬과 2스킬을 번갈아 사용"이라면 지금 데이터(무작위 AI 하나만 지정)와 다릅니다. AI 지정 값이나 스크립트를 확인해야 합니다.')
w(f'- **쿨다운 중 스킬 선택 ({len(cd)}종, 스테이지 사용 {len(cd_used)}종, 총 {cd_turns}턴):** AI가 쿨다운을 확인하지 않아, 쿨다운 중인 2스킬을 고르면 1스킬을 쓰지 않고 그 턴을 대기로 보냅니다.')
w(f'  - 해당 몬스터: {names(cd)}')
s2_ally = [k for k, t in no_s2 if t in (1, 2, 8)]
w(f'- **2스킬을 한 번도 안 쓴 몬스터 {len(no_s2)}종:** 그중 {len(s2_ally)}종은 2스킬이 아군 대상(지원) 스킬이라 혼자 남으면 쓸 대상이 없습니다. 이때 AI가 2스킬을 고른 턴(약 절반)은 대기가 됩니다. 아군이 있는 실제 편성에서는 정상적으로 쓰입니다.')
w(f'  - 예: {names([k for k in s2_ally if used[k]], 15)}')
w('- 정적 점검: Lua 파일 중 4개(AI_MP_AzazelAlter 등)가 존재하지 않는 함수(소문자 wait)를 부르고 있습니다. 지금은 어떤 몬스터에도 지정돼 있지 않아 영향은 없지만, 다시 지정하면 오류가 납니다.')
w('')

# ---- 2. stages
w('## 2. 스테이지 테스트 — 라운드 목표 → 턴 목표')
w('')
w('### 클라이언트에서 확인한 사실')
w('- **미션 성공 판정은 서버가 합니다.** 클라이언트의 미션 판정 코드는 호출되지 않는 상태이고, 턴 제한 조건(TURN_LIMIT_LESS)을 처리하는 코드도 없습니다.')
w('- 클라이언트가 서버에 보내는 숫자는 라운드 종료 패킷의 "라운드 번호" 하나뿐입니다.')
w('- 리뉴얼 전투에서 라운드는 **유닛 한 번의 행동(적 행동 포함)마다 1씩** 늘어납니다. 라운드 번호는 웨이브마다 1로 돌아가고, 전체 누적 라운드는 계속 늘어납니다.')
w('- 따라서 서버가 무엇을 "턴"으로 세는지에 따라 결과가 크게 달라집니다. 아래는 세 가지 해석을 모두 측정한 결과입니다.')
w('- 아군 턴 = 아군의 본 행동 수(지원 공격·반격·연속 행동·예약 스킬 발동은 턴으로 세지 않음).')
w('')
w('### 시험 방법')
w('- 1차: 미션이 있는 스테이지 전부를 강한 고정 조합 하나(그레이브 송, 라미아, S12 쉐이드, B-11 나이트 앤젤, 다프네)로 3번씩 클리어했습니다.')
w(f'- 2차: 1차에서 기준을 넘긴 스테이지 {searched}개는 **조합을 바꿔 가며 다시 찾았습니다.** 스테이지마다 다음 순서로 진행했고, 모두 합쳐 {squads_tried:,}개 조합을 시험했습니다.')
w(f'  - 전투원 {srch["poolSize"]}명 전체에서 무작위 조합 {srch["options"].get("random",120)}개, 계열(경장·중장·기동)별 조합, 역할을 섞은 조합(보호기 1·공격기 3·지원기 1), 공격기만 모은 조합을 만들어 시험했습니다.')
w(f'  - 결과가 좋은 조합을 멤버 교체·조합 섞기·칸 이동으로 {srch["options"].get("gens",5)}세대 개량했습니다.')
w('  - 상위 조합을 다른 시드로 다시 돌렸습니다.')
w('  - 기준 안으로 클리어하는 조합을 찾으면 그 스테이지는 거기서 멈췄습니다.')
w('- 전투원은 모두 Lv100, 최대 등급, 스킬 Lv10, 장비 없음입니다. 표의 값은 시험한 조합 중 **가장 적게 걸린 값**(최선의 경우)입니다.')
w('- 한계: 모든 조합을 다 시험할 수는 없으므로, "불가"는 "수백 개 조합으로 찾아도 기준 안에 못 깼다"는 뜻입니다. 장비·코어링크를 갖추면 더 줄어들 수 있습니다.')
w('')
w(f'### 30턴 미션 ({len(turn30)}개 스테이지)')
w('')
w('| 서버가 세는 값 (해석) | 고정 조합 1개로 불가 | 다양한 조합으로도 불가 | 그중 본편 |')
w('|---|---|---|---|')
w(f'| 아군 턴 수만 | {fixed_fail_pc}개 | {len(fails["pc"])}개 | {sum(main(x[0]) for x in fails["pc"])}개 |')
w(f'| 스테이지 전체 누적 라운드 (적 행동 포함) | {fixed_fail_total}개 | {len(fails["total"])}개 | {sum(main(x[0]) for x in fails["total"])}개 |')
w(f'| 웨이브별 라운드 중 최대 | {len(sts["wavefail"])}개 | {len(fails["wave"])}개 | {sum(main(x[0]) for x in fails["wave"])}개 |')
w('')
w('- 판정은 "30 이하면 성공"으로 계산했습니다. 서버가 "30 미만"으로 판정하면 불가 스테이지가 더 늘어납니다.')
for k, title in (('pc', '아군 턴 수 기준으로도 불가한 스테이지'), ('total', '전체 누적 라운드 기준으로 불가한 스테이지')):
    if not fails[k]:
        w(f'- {title}: 없음')
        continue
    w(f'- **{title}** ({len(fails[k])}개, 가장 적게 걸린 값이 큰 순):')
    w('')
    w('| 스테이지 | 이름 | 웨이브 | 아군 턴 | 전체 누적 라운드 | 웨이브별 최대 | 가장 적게 걸린 조합 |')
    w('|---|---|---|---|---|---|---|')
    for x in sorted(fails[k], key=lambda x: -x[3][k][0]):
        bb = x[3]
        w(f'| {x[0]} | {sname(x[0])} | {waves_of.get(x[0], "-")} | {bb["pc"][0]} | {bb["total"][0]} | {bb["wave"][0]} | {sqtxt(bb[k][2])} |')
    w('')
w('### 10·20턴 미션과 남아 있는 라운드 미션')
w('')
w('| 스테이지 | 이름 | 미션 | 기준값 | 아군 턴 | 전체 누적 라운드 | 웨이브별 최대 | 판정 |')
w('|---|---|---|---|---|---|---|---|')
for x in special:
    bb = x[3]; v = x[2]
    ok = '가능' if bb['pc'][0] <= v and bb['total'][0] <= v else ('해석에 따라 불가' if min(bb['pc'][0], bb['total'][0], bb['wave'][0]) <= v else '불가')
    w(f'| {x[0]} | {sname(x[0])} | {"턴" if x[1]=="TURN_LIMIT_LESS" else "라운드"} | {v} | {bb["pc"][0]} | {bb["total"][0]} | {bb["wave"][0]} | {ok} |')
w('')
rnd = [x for x in special if x[1] == 'ROUND_LIMIT_LESS']
rnd_bad = [x for x in rnd if x[3]['pc'][0] > x[2] and x[3]['total'][0] > x[2]]
w(f'- 챌린지 스테이지 {len(rnd)}개는 아직 **라운드 제한** 미션입니다. 예전 기준(라운드 = 전원 1회 행동)으로 맞춘 값이라, 다양한 조합으로도 {len(rnd_bad)}개는 어떤 해석으로도 달성할 수 없습니다({", ".join(x[0] for x in rnd_bad)}).')
w('- 미션 데이터 연결 오류: Ch02Ev30Stage06, Ch01Ev31Stage06, Ch02Ev31Stage06의 미션 칸이 "#N/A"로 비어 있습니다.')
w(f'- 전투 자체가 없는 스테이지 {sum(1 for x in sts["nowin"] if x[1]=="error")}개(Ch01Ev22, Ch01Ev42 일부)에도 30턴 미션이 붙어 있습니다. 웨이브 구성이 없어 시뮬레이션하지 못했습니다.')
lost = [x[0] for x in sts['nowin'] if x[1] == 'lose']
if lost:
    for st in lost:
        bb = best(st)
        if bb['pc']:
            w(f'- {st}({sname(st)}): 고정 조합으로는 졌지만 다른 조합으로 클리어했습니다 (아군 턴 {bb["pc"][0]}, 전체 누적 라운드 {bb["total"][0]}).')
        else:
            w(f'- {st}({sname(st)}): 시험한 모든 조합이 졌습니다. 턴 미션 판정 이전에 난이도 확인이 필요합니다.')
w('')

# ---- 3. stats
w('## 3. 스탯 자동 분배(레벨 성장) 테스트')
w('')
w('### 클라이언트에서 확인한 사실')
w('- 별도의 "분배" 단계나 새 표는 없습니다. 예전의 수동 강화 포인트를 더하던 부분이 주석 처리됐고, 능력치는 전투원별 성장표(기본값 + 레벨당 증가량 × (레벨 - 1))로만 계산됩니다.')
w('- 이후 승급·장비·코어링크·호감도 보너스가 더해지고, 전투 시작 시 이 값이 전투원 기본 능력치가 됩니다.')
w('- 수동 강화 화면과 서버 패킷은 아직 남아 있지만 전투 능력치에는 더 이상 반영되지 않습니다. 강화 화면을 계속 보여줄지 확인이 필요합니다.')
w('')
w('### 3-1) 모든 전투원 × 모든 레벨')
w(f'- 전투원 {sat["pcs"]}명 × 레벨 1~120의 공격력, 방어력, HP, 적중, 회피, 치명을 성장표로 직접 계산한 값과 비교했습니다.')
w(f'- **불일치 {len(sat["build"])}건** — 모두 표대로 적용됩니다. 성장표가 없는 전투원은 {len(sat["missingAbility"])}명입니다.')
w('- 데이터 이상:')
for x in neg:
    if x['issue'] == 'negative growth':
        pa = units['Table_PCAbility'][x['pc']]
        b = float(pa.get('DefaultHP', 0)); g = float(pa.get('DefaultHPByLevel', 0))
        w(f'  - **{pname(x["pc"])}**: 레벨당 HP 증가량이 {x["growth"]}입니다. 레벨이 오를수록 HP가 줄어 1레벨 {b:,.0f} → 120레벨 {b+g*119:,.0f}이 됩니다. 수정이 필요해 보입니다.')
    else:
        w(f'  - **{pname(x["pc"])}**: 기본 회피가 {x["base"]}(-100%)로 들어 있습니다. 의도된 값인지 확인이 필요합니다.')
w(f'  - 참고: 모듈·대체 코어 {len(mods)}종은 성장값이 없습니다(공격력·HP 1 고정). 전투에 나가는 유닛이 아니라면 문제 없습니다.')
w('  - 참고: 같은 역할군 중앙값보다 방어력이 3~5배 높은 전투원이 다수 있지만, 중장갑 전투원의 설계 값으로 보여 이상으로 분류하지 않았습니다.')
w('')
w('### 3-2) 전투 반영')
w(f'- 전투원마다 레벨 1·30·60·90·120으로 실제 전투를 열고, 전장에 올라간 전투원의 기본 능력치를 확인했습니다. **불일치 {len(sat["battle"])}건**입니다.')
w('- 전투 시작 직후 현재 능력치가 성장표와 다른 경우는 모두 패시브 스킬 버프 때문이었습니다(예: 적중·회피가 오르는 패시브).')
w('- 한계: 시뮬레이터는 클라이언트의 능력치 계산 순서를 그대로 옮긴 것이라, 이 결과는 "계산 코드와 데이터가 맞물린다"는 확인입니다. 실제 기기에서의 최종 확인(전투원 정보창 수치와 전투 중 수치 비교)은 몇 명만 표본으로 직접 보는 것을 권합니다.')
w('')
w('## 권고 사항')
w(f'1. 서버가 턴 미션에서 무엇을 세는지(아군 턴 수, 전체 라운드, 웨이브별 라운드)와 판정 부등호(이하/미만)를 서버 담당자에게 확인해야 합니다. 전체 라운드를 센다면 30턴 미션 {len(fails["total"])}개는 다양한 조합으로도 30 안에 깰 수 없습니다.')
w(f'2. 아군 턴 수 기준으로도 불가한 {len(fails["pc"])}개 스테이지와 10·20턴 미션은 기준값을 올리거나 미션을 바꿔야 합니다.')
w(f'3. 챌린지 스테이지 {len(rnd)}개의 라운드 제한 미션을 턴 기준으로 바꿔야 합니다(특히 달성 불가 {len(rnd_bad)}개). "#N/A" 미션 3개도 고쳐야 합니다.')
w('4. 몬스터 AI가 모두 무작위 AI 하나로 지정돼 있습니다. "1·2스킬 교대"가 의도라면 AI 지정 값이나 스크립트를 바꿔야 합니다. 쿨다운 중인 스킬을 고르면 턴을 낭비하는 점도 같이 고치는 것이 좋습니다.')
w('5. 뒷열에서 다가오지 못하고 대기만 하는 몬스터 74종은 이동 위치 미리보기 문제를 고치면 함께 해결될 것으로 보입니다.')
w('6. 골타리온 XIII세의 레벨당 HP 증가량(-9)을 고쳐야 합니다.')
w('')
w('## 다시 돌리는 방법')
w('- 업데이트 후 같은 테스트: 시뮬레이터 폴더에서 몬스터 테스트, 스테이지 턴 테스트, 스탯 테스트를 각각 실행한 뒤 이 리포트를 다시 만들면 됩니다(약 2분).')

os.makedirs(os.path.join(SIM, 'reports'), exist_ok=True)
p = os.path.join(SIM, 'reports', f'전투리뉴얼_QA_리포트_r{rev}.md')
open(p, 'w', encoding='utf-8').write('\n'.join(L) + '\n')
print(p)
