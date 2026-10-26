"""원문 복원 시험 결과를 집계하고 항목별 원인 분류를 만든다.
python -I tools/원문복원_집계.py  ->  tools/out/원문복원시험_20261022/집계_원문복원.json
조건 이름: preliminary=기존 예비 조건 재현, restored=원문 근거 값만 반영(엄격), restored-target=원문 목표 수치로 강화 점수 계산,
restored-inferred=변환 중 해석이 들어간 값 포함, restored-cell/os=확인 못 한 배치·장비의 후보별 결과.
"""
import json, os, statistics
from collections import Counter, defaultdict

HERE = os.path.dirname(os.path.abspath(__file__))
D = os.path.join(HERE, 'out', '원문복원시험_20261022')
J = lambda f: json.load(open(os.path.join(D, f), encoding='utf-8'))
inputs = {c['id']: c for f in ['시험입력_본문_최종.json', '시험입력_티아멧_전체.json'] for c in J(f)}
names = {k: v['name'] for k, v in J('기준표/전투원표.json').items()}
stage_names = {}
for f in ['추출입력/part%d.json' % i for i in range(5)]:
    for r in J(f):
        for s in r['stages']:
            k, n = s.split('(', 1)
            stage_names[k] = n.rstrip(')')
_st = json.load(open(os.path.join(HERE, '..', 'data', 'stages.json'), encoding='utf-8'))['Table_MapStage']
_loc = json.load(open(os.path.join(HERE, '..', 'data', 'loc.json'), encoding='utf-8'))
for k, v in _st.items():
    stage_names.setdefault(k, _loc.get(v.get('StageName', ''), k))
titles = {r['post']: r['title'] for r in J('공략별_근거자료.json')}


def summ(r):
    runs = r['runs']
    oc = Counter(u['outcome'] for u in runs)
    wins = [u for u in runs if u['outcome'] == 'win']
    done = [u for u in runs if u['outcome'] != 'execution_timeout']
    mis = [m for u in wins for m in u['missions'] if 'byPcMain' in m]
    return {
        'runs': len(runs), 'win': oc['win'], 'lose': oc['lose'], 'actionLimit': oc['timeout'], 'execTimeout': oc['execution_timeout'], 'stuck': oc['stuck'], 'error': oc['error'],
        'judged': len(done),
        'pcMainWin': [u['pcMain'] for u in wins], 'pcExtraWin': [u['pcExtra'] for u in wins], 'allMainWin': [u['allMain'] for u in wins],
        'stalemateFrom': [u['stalemateFromAction'] for u in runs if u['outcome'] == 'timeout'],
        'firstDeath': Counter((u['deaths'][0]['unit'], u['deaths'][0]['wave']) for u in runs if u['deaths']).most_common(3),
        'waveReached': Counter('%d/%d' % (u['waveReached'], u['maxWave']) for u in runs).most_common(),
        'missionPcMainOk': sum(1 for u in wins if any(m.get('byPcMain') for m in u['missions'])),
        'missionAllMainOk': sum(1 for u in wins if any(m.get('byAllMain') for m in u['missions'])),
        'hasTurnMission': any('byPcMain' in m for u in runs for m in u['missions']),
    }


res = {}
for f in ['결과_본문복원.json', '결과_티아멧_9장.json']:
    for r in J(f)['results']:
        res[r['id']] = r
cases = defaultdict(dict)
for rid, r in res.items():
    c = inputs[rid]
    key = str(c.get('caseIndex', rid.split('-')[0]))
    cond = r['condition']
    tag = cond
    if cond in ('restored-cell', 'restored-os'):
        tag = cond + ':' + rid.split('-', 2)[2]
    cases[key][tag] = (r, c)

ROWS = []
for key, conds in sorted(cases.items(), key=lambda x: int(x[0])):
    pr, pc = conds['preliminary']
    rr, rc = conds['restored']
    P, R = summ(pr), summ(rr)
    extra = {t: summ(v[0]) for t, v in conds.items() if t not in ('preliminary', 'restored')}
    best = max([R] + [v for t, v in extra.items() if not t.startswith('restored-os')], key=lambda s: s['win'])
    kept = {m: [f for f, v in p.items() if not v.startswith('원문')] for m, p in rc['provenance'].items()}
    restored_fields = {m: [f for f, v in p.items() if v.startswith('원문')] for m, p in rc['provenance'].items()}
    # 원인 분류
    if R['win'] > P['win'] and R['win'] >= 5:
        cause = '원문 조건 복원 부족(예비 조건과 원문 조건의 차이)'
    elif rc.get('outdated'):
        cause = '원문 공략 자체의 조건부 성공(작성자가 이후 게임 변경으로 무효라고 밝힘)'
    elif best['win'] > P['win'] and best['win'] >= 5:
        cause = '원문 조건 복원 부족(목표 수치·배치 후보를 반영하면 성공)'
    elif rc['post'] == 56681644:
        cause = '원인 미확정(적 회피 351%와 아군 적중 차이로 교착, 개편 전 적 자료 없음)'
    elif best['win'] == 0:
        cause = '원인 미확정(원문 조건 일부 미복원' + (', 원문이 확률·경계 조건을 언급)' if rc.get('conditional') else ')')
    else:
        cause = '원인 미확정(일부 난수에서만 승리' + (', 원문이 확률·경계 조건을 언급)' if rc.get('conditional') else ')')
    ROWS.append({
        'case': key, 'post': rc['post'], 'title': titles.get(rc['post'], ''), 'stage': rc['stage'], 'stageName': stage_names.get(rc['stage'], rc['stage']),
        'members': [names.get(m['key'], m['key']) for m in rc['squad']],
        'preliminary': P, 'restored': R, 'variants': extra, 'restoredFields': restored_fields, 'keptPreliminary': kept,
        'conditional': rc.get('conditional', []), 'claimed': rc.get('claimed', []), 'unresolved': rc.get('unresolved', []), 'outdated': rc.get('outdated', ''),
        'cause': cause,
    })

def tally(key):
    return {
        '항목': len(ROWS),
        '한 번 이상 승리': sum(1 for r in ROWS if r[key]['win'] > 0),
        '10회 모두 승리': sum(1 for r in ROWS if r[key]['win'] == r[key]['runs']),
        '승리 없음': sum(1 for r in ROWS if r[key]['win'] == 0),
        '실행 수': sum(r[key]['runs'] for r in ROWS), '승리 수': sum(r[key]['win'] for r in ROWS), '패배 수': sum(r[key]['lose'] for r in ROWS),
        '행동 제한 수': sum(r[key]['actionLimit'] for r in ROWS), '계산 시간 제한 수': sum(r[key]['execTimeout'] for r in ROWS),
    }

pairs = Counter()
for r in ROWS:
    p, q = r['preliminary']['win'], r['restored']['win']
    pairs['좋아짐' if q > p else '나빠짐' if q < p else '같음'] += 1
out = {'예비': tally('preliminary'), '원문': tally('restored'), '변화': dict(pairs), '원인': dict(Counter(r['cause'] for r in ROWS)), 'rows': ROWS}
json.dump(out, open(os.path.join(D, '집계_원문복원.json'), 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
import sys
sys.stdout.reconfigure(encoding='utf-8')
print(json.dumps({k: v for k, v in out.items() if k != 'rows'}, ensure_ascii=False, indent=1))
