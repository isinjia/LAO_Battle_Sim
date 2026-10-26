"""기존 수동 능력치 유지 조건의 실행 기록을 상세 보고서로 정리한다."""
import collections
import hashlib
import json
import pathlib
import re
import statistics

ROOT = pathlib.Path(__file__).resolve().parent.parent
SOURCE = ROOT / 'tools' / 'out'
DEST = SOURCE / '재시험_20261022' / '수동성장_추가검증'
read = lambda p: json.loads(p.read_text(encoding='utf-8-sig'))
basic = read(DEST / '기본수동분배_전체결과.json')['results']
recommended = read(DEST / '추천수동분배_전체결과.json')['results']
summary = read(DEST / '수동성장_집계.json')
guides = read(SOURCE / 'guide-squads.json')
loc = read(ROOT / 'data' / 'loc.json')
stages = read(ROOT / 'data' / 'stages.json')['Table_MapStage']
recommendations = {x['key']: x for x in read(SOURCE / 'stat-reco.json')}

def win_count(row):
    return sum(x['outcome'] == 'win' for x in row['runs'])

def excluded(row):
    return all('no battle to simulate' in x.get('reason', '') for x in row['runs'])

def review(row):
    return any(x['outcome'] == 'execution_timeout' or (x['outcome'] == 'error' and 'no battle to simulate' not in x.get('reason', '')) for x in row['runs'])

def clean(value):
    value = str(value).replace('LRL', '엘알엘').replace('Battle Stage', '전투 구역')
    roman = {'I':'1','II':'2','III':'3','IV':'4','V':'5','VI':'6','VII':'7','VIII':'8','IX':'9','X':'10'}
    value = re.sub(r'\b[IVX]+\b', lambda m: roman.get(m.group(), ''), value)
    value = re.sub(r'\b\d+-\d+\s*', '', value)
    value = re.sub(r'[A-Za-z][A-Za-z0-9_\-/]*', '', value)
    return re.sub(r'\s+', ' ', value).strip(' /') or '이름 표기 생략'

def stage_name(key):
    return clean(loc.get(stages[key].get('StageName', ''), '이름 확인 필요'))

def members(row):
    return ' · '.join(clean(x['name']) for x in row['squad'])

def link(label, path):
    return f'[{label}](/{path.resolve().as_posix()})'

def percent(n, d):
    return f'{100*n/d:.1f}%' if d else '해당 없음'

def group_summary(rows):
    return {'cases':len(rows), 'any':sum(win_count(r)>0 for r in rows), 'stable':sum(win_count(r)==3 for r in rows),
            'review':sum(review(r) for r in rows)}

valid_indices = [i for i,r in enumerate(basic) if not excluded(r)]
valid_basic = [basic[i] for i in valid_indices]
valid_recommended = [recommended[i] for i in valid_indices]
assert len(valid_indices) == 2770
assert all((a['post'],a['stage'],a['squad']) == (b['post'],b['stage'],b['squad']) for a,b in zip(basic,recommended))
by_size = {str(size): {'basic':group_summary([r for r in valid_basic if len(r['squad'])==size]),
                      'recommended':group_summary([r for r in valid_recommended if len(r['squad'])==size])} for size in range(1,6)}
by_content = {}
for key,is_event in [('본편',False),('이벤트',True)]:
    by_content[key] = {'basic':group_summary([r for r in valid_basic if ('Ev' in r['stage']) == is_event]),
                       'recommended':group_summary([r for r in valid_recommended if ('Ev' in r['stage']) == is_event])}
by_stage = collections.defaultdict(list)
for i in valid_indices:
    by_stage[basic[i]['stage']].append(i)
both_failed = [(key,indices) for key,indices in by_stage.items() if not any(win_count(basic[i]) or win_count(recommended[i]) or review(basic[i]) or review(recommended[i]) for i in indices)]
both_failed.sort(key=lambda x:(-len(x[1]),x[0]))

def mission_summary(rows):
    selected = {key:idx for key,idx in by_stage.items() if any(m.get('type')=='TURN_LIMIT_LESS' and m.get('value')==30 for m in rows[idx[0]]['missions'])}
    results = {}
    for key,indices in selected.items():
        wins = [run for i in indices for run in rows[i]['runs'] if run['outcome']=='win']
        results[key] = {'cleared':bool(wins),'pc30':any(x['pc']<=30 for x in wins),'all30':any(x['total']<=30 for x in wins),
                        'minimum_pc':min((x['pc'] for x in wins),default=None),'minimum_total':min((x['total'] for x in wins),default=None)}
    return {'stages':len(selected),'with_win':sum(x['cleared'] for x in results.values()),
            'pc30':sum(x['pc30'] for x in results.values()),'all30':sum(x['all30'] for x in results.values()),
            'minimum_pc_exactly_30':sum(x['minimum_pc']==30 for x in results.values()),'details':results}

missions = {'basic':mission_summary(basic),'recommended':mission_summary(recommended)}
used = {m['key'] for row in basic for m in row['squad']}
used_sources = collections.Counter(recommendations[k]['src'] for k in used)
assert len(used)==206 and used_sources['community']==97 and used_sources['template']==109
title_high_level = sum(bool(re.search(r'(105|110|115|120)\s*(?:렙|레벨|lv)',x['title'],re.I)) for x in guides)
title_no_link = sum('노링' in x['title'] for x in guides)
details = {'by_size':by_size,'by_content':by_content,'missions':missions,
           'both_failed_stages':[{'stage':key,'indices':indices} for key,indices in both_failed],
           'used_recommendation_sources':dict(used_sources),'titles_high_level':title_high_level,'titles_no_link':title_no_link}
(DEST / '상세분석_집계.json').write_text(json.dumps(details,ensure_ascii=False,indent=2),encoding='utf-8')

b,r = summary['basic'],summary['recommended']
N = 2770
L=[]
w=L.append
w('# 기존 능력치와 수동 분배 유지 조건의 전투 검증 상세 보고서')
w('')
w('시험일: 2026년 10월 22일  |  대상: 기존 공략 조합의 개편 전투 활용 가능성')
w('')
w('## 1. 검토 결론과 판단 범위')
w('')
w('기존 성장표와 수동 능력치 분배를 유지한 상태에서도 기존 공략 조합 상당수가 개편 전투에서 클리어되는 것을 확인했다. 다만 이번 시험만으로 기존 공략 전체의 동작·반복 안정성·소요 시간이 그대로 유지된다고 결론 내릴 수는 없다.')
w('')
w(f'추천 수동 분배에서는 유효 시험 {N:,}건 중 {r["any_win"]:,}건({percent(r["any_win"],N)})이 한 번 이상 성공했고, {r["groups"]["stable"]:,}건({percent(r["groups"]["stable"],N)})이 세 번 모두 성공했다. 다섯 명 편성은 세 번 모두 성공한 비율이 {percent(by_size["5"]["recommended"]["stable"],by_size["5"]["recommended"]["cases"])}였지만, 한 명 편성은 {percent(by_size["1"]["recommended"]["stable"],by_size["1"]["recommended"]["cases"])}였다. 적은 인원으로 반복 파밍하는 공략의 정밀 재현을 우선할 근거가 된다.')
w('')
w('이 수치는 공략 제목에서 추출한 편성에 시험용 육성·장비·배치를 적용한 결과다. 원문 공략 조건을 완전히 복원한 호환성 시험이나, 개편 전 전투 엔진과 개편 후 전투 엔진을 같은 조건으로 비교한 시험은 아니다. 이전 대화에서 자동 성장 조건을 섞어 산출한 기존 조합 유지율은 이번 결론의 근거에서 제외한다.')
w('')
w('| 판단 항목 | 이번에 확인한 내용 | 아직 확인하지 못한 내용 |')
w('|---|---|---|')
w('| 기존 편성 활용 | 수집한 전투원 조합을 개편 전투에서 실행해 승패 기록 확보 | 모든 원문 공략이 그대로 작동하는지 |')
w('| 수동 능력치 유지 | 기존 성장표와 수동 강화 점수 반영 | 최종 반영될 실제 게임 화면·서버의 능력치 일치 |')
w('| 반복 안정성 | 서로 다른 난수 시작값 세 개에서 성공 횟수 확인 | 장시간 반복 파밍의 실패율 |')
w('| 전투 흐름 | 본 행동·추가 행동·누적 행동 수 기록 | 개편 전후 실제 조작감·연출 시간·실제 분당 파밍량 |')
w('| 제한 임무 | 저장된 임무 조건과 행동 수를 가정별 대조 | 서버가 세는 행동 종류와 경계값 판정 |')
w('')
w('## 2. 시험 자료와 대상 선정')
w('')
w('| 구분 | 범위 |')
w('|---|---|')
w('| 공략 출처 | 클로드가 수집해 저장한 라스트오리진 커뮤니티 공략 자료 |')
w('| 서로 다른 공략 글 | 2,488건 |')
w('| 공략과 전투 구역의 조합 | 2,778건 |')
w('| 포함된 전투 구역 | 314곳 |')
w('| 전투가 없는 구역 제외 후 | 2,770건, 전투 구역 308곳 |')
w('| 사용된 전투원 | 206명 |')
w('| 조건별 실행 | 세 개의 난수 시작값으로 8,334개 실행 기록 |')
w('| 유효 전투 실행 | 조건별 8,310개 기록, 계산 제한으로 미완료인 기록 포함 |')
w('')
w('한 공략이 여러 전투 구역을 안내하면 구역별로 별도 항목을 만들었다. 같은 공략과 같은 구역이 중복 집계된 항목은 없었다. 서로 다른 항목이 같은 전투원이나 구역을 공유하므로, 2,770건을 완전히 독립적인 표본으로 취급해서는 안 된다.')
w('')
w('입력 자료 2,778건은 모두 공략 제목에서 전투원을 추출한 항목이었다. 원문 편성 이미지에서 배치를 직접 복원한 입력은 이번 전체 시험 자료에 없었다. 전투원 이름이 해석된 공략만 선정했으므로, 게임 전체 공략이나 전체 전투 구역을 대표하는 무작위 표본도 아니다.')
w('')
w('## 3. 능력치 복원과 두 비교 조건')
w('')
w('두 조건 모두 전투 규칙·기술·적·전투 구역 자료는 개편 상태를 사용하고, 전투원의 기본 성장표와 수동 능력치 분배를 기존 방식으로 재현했다. 능력치 자동 성장 조건은 이번 비교에 포함하지 않았다.')
w('')
w('| 항목 | 기본 수동 분배 | 추천 수동 분배 |')
w('|---|---|---|')
w('| 성장표 | 기존 성장표 | 기존 성장표 |')
w('| 적중·회피·치명의 레벨 성장 | 기존 방식대로 추가 자동 성장 없음 | 기존 방식대로 추가 자동 성장 없음 |')
w('| 수동 강화 점수 | 100레벨 기준 297점 | 100레벨 기준 최대 297점 |')
w('| 일반 공략 분배 | 치명 100점, 공격 197점 | 전투원별 적중·치명·회피 목표를 우선한 뒤 남는 점수 분배 |')
w('| 회피 공략 분배 | 회피 100점, 공격 197점 | 전투원별 저장된 표준 추천 분배 사용 |')
w('| 분배 근거 | 단순화한 비교용 규칙 | 수집 공략의 전투원별 목표치, 자료 부족 시 역할별 기준 |')
w('| 의미 | 단순한 기존 분배에서 조합이 작동하는지 | 목표 능력치를 고려한 기존 분배에서 조합이 작동하는지 |')
w('')
w('추천 분배에 쓰인 206명 중 97명은 커뮤니티 자료 기반이고, 109명은 자료가 부족해 역할별 기준을 사용했다. 추천 분배라는 이름이 각 공략의 원문 분배를 그대로 읽어 넣었다는 뜻은 아니다. 공략마다 다른 장비·지원 효과·상대 회피에 따라 최적 분배는 달라질 수 있다.')
w('')
w('수동 강화 점수의 합계가 297점을 넘지 않고, 회피와 치명에 각각 100점을 초과해 분배하지 않았는지 확인했다. 기존과 현재 성장표의 다른 항목도 비교했고, 기존 비교 도구가 포츈의 기본 화염·냉기·전기 저항 35%를 복원하지 않는 점을 보완했다. 포츈이 포함된 네 항목은 두 조건에서 다시 실행해 최종 기록에 반영했다.')
w('')
w('## 4. 공통 육성·장비·배치 조건')
w('')
w('| 항목 | 실제 시험 조건 | 해석상 주의점 |')
w('|---|---|---|')
w('| 레벨 | 전원 100 | 105~120레벨을 요구하는 원문 공략과 차이 가능 |')
w('| 승급 | 전투원별 최대 승급 | 원문의 저등급 편성과 기술 구성이 다를 수 있음 |')
w('| 기술 수준 | 10 | 원문 기술 수준과 다를 수 있음 |')
w('| 코어 연결 | 없음 | 연결 보너스와 완전 연결 선택 효과 미반영 |')
w('| 호감도 | 추가 능력치 보너스 없음 | 호감도 확장 효과 미반영 |')
w('| 장비 | 장착 가능한 후보 중 능력치 점수로 선택, 강화 10 | 원문의 전용·회피·반격·특수 효과 장비를 재현하지 못할 수 있음 |')
w('| 배치 | 역할·사거리 기준의 저장된 자동 배치 | 원문의 특정 칸을 전제로 한 보호·지원·회피 공략과 차이 가능 |')
w('| 조작 | 자동 전투 | 수동 기술 선택·이동이 필요한 공략은 재현 부족 |')
w('| 난수 | 시작값 1·2·3 | 같은 시작값을 두 분배 조건에서 사용 |')
w('')
w(f'제목에 105~120레벨을 명시한 항목이 {title_high_level}건 있었지만 입력 전투원에는 개별 레벨이 지정돼 있지 않아 모두 100레벨로 실행됐다. 반대로 무연결을 명시한 항목은 {title_no_link}건이지만, 실제 시험은 원문 표기와 무관하게 모든 항목에 연결 보너스를 주지 않았다. 특히 연결을 요구하는 공략의 실패를 전투 개편 탓으로 단정할 수 없는 이유다.')
w('')
w('장비는 공격·치명·적중·행동력 등의 수치를 기준으로 자동 선택했다. 수치 없이 보조 효과만 주는 장비의 가치는 이 선택 규칙으로 충분히 평가하지 못한다. 원문 장비를 맞추지 않은 상태에서 분배만 바꾸는 시험이라는 한계를 함께 봐야 한다.')
w('')
w('## 5. 집계 기준')
w('')
w('| 지표 | 정의 |')
w('|---|---|')
w('| 한 번 이상 성공 | 세 실행 중 승리 기록이 하나 이상 존재 |')
w('| 세 번 모두 성공 | 서로 다른 난수 시작값 세 개에서 모두 승리 |')
w('| 한두 번만 성공 | 세 실행의 판정이 끝났으며 승리가 한 번 또는 두 번 |')
w('| 성공 없음, 실행 완료 | 승리가 없고 계산 시간 제한 없이 세 실행의 판정이 끝남 |')
w('| 확인 보류 | 계산 시간 제한 등으로 한 번 이상 실행이 미완료 |')
w('| 집계 제외 | 적 편성이 없어 전투 자체가 없는 이야기 구역 |')
w('')
w('한 번 이상 성공은 세 번 모두 성공을 포함하는 지표이므로 둘을 더하면 안 된다. 확인 보류 항목의 승리 횟수가 0이더라도 확정 실패로 분류하지 않았다. 전체 비율은 전투가 없는 8건을 제외한 2,770건을 분모로 하며, 확인 보류 항목은 분모에 남겨 성공률을 부풀리지 않았다.')
w('')
w('서로 다른 난수 시작값 세 개의 실행은 초기 재현성을 살피는 최소 확인이다. 세 번 모두 성공을 장기 파밍의 무실패 보증이나 통계적으로 확정된 안정성으로 해석해서는 안 된다.')
w('')
w('모의실험의 중단 기준에 쓰는 전체 실행 행동 수와, 뒤의 제한 임무 분석에 쓰는 본 행동 수는 구분한다. 추가 행동을 포함해 실행 제한에 도달했다고 해서 임무 판정용 행동 수도 같은 값이라는 뜻은 아니다.')
w('')
w('## 6. 전체 결과')
w('')
w('| 항목 | 기본 수동 분배 | 추천 수동 분배 |')
w('|---|---:|---:|')
for label,key in [('한 번 이상 성공','any_win')]:
    w(f'| {label} | {b[key]:,}건 ({percent(b[key],N)}) | {r[key]:,}건 ({percent(r[key],N)}) |')
for label,key in [('세 번 모두 성공','stable'),('한두 번만 성공','mixed'),('성공 없음, 실행 완료','failed'),('확인 보류','review')]:
    w(f'| {label} | {b["groups"].get(key,0):,}건 ({percent(b["groups"].get(key,0),N)}) | {r["groups"].get(key,0):,}건 ({percent(r["groups"].get(key,0),N)}) |')
w('| 전투가 없는 구역, 분모 제외 | 8건 | 8건 |')
w('')
w('### 실행 한 번을 단위로 센 결과')
w('')
w('| 실행 결과 | 기본 수동 분배 | 추천 수동 분배 |')
w('|---|---:|---:|')
for key,label in [('win','승리'),('lose','패배'),('timeout','행동 수 제한 도달'),('execution_timeout','계산 시간 제한'),('stuck','진행 멈춤 판정'),('error','전투 없는 구역의 오류 기록')]:
    w(f'| {label} | {b["outcomes"].get(key,0):,}회 | {r["outcomes"].get(key,0):,}회 |')
w('')
w(f'유효 실행 8,310개 기록을 분모로 한 승리 비율은 기본 분배 {percent(b["outcomes"]["win"],8310)}, 추천 분배 {percent(r["outcomes"]["win"],8310)}다. 이는 공략별로 한 번 이상 성공했는지를 센 74.9%·76.3%와 다른 지표다. 오류 기록 24회는 조건별 8개 이야기 항목을 세 번 시도하면서 생긴 것으로, 전투 중 예외가 발생한 기록은 없었다.')
w('')
w('## 7. 편성 인원과 콘텐츠별 분석')
w('')
w('### 편성 인원별')
w('')
w('| 편성 인원 | 유효 항목 | 기본 한 번 이상 | 기본 세 번 모두 | 추천 한 번 이상 | 추천 세 번 모두 |')
w('|---|---:|---:|---:|---:|---:|')
for size in range(1,6):
    a,c=by_size[str(size)]['basic'],by_size[str(size)]['recommended']
    w(f'| {size}명 | {a["cases"]:,}건 | {a["any"]:,}건 ({percent(a["any"],a["cases"])}) | {a["stable"]:,}건 ({percent(a["stable"],a["cases"])}) | {c["any"]:,}건 ({percent(c["any"],c["cases"])}) | {c["stable"]:,}건 ({percent(c["stable"],c["cases"])}) |')
w('')
w('적은 인원으로 구성한 공략에서 성공 비율이 낮았다. 특정 전투원의 장비·회피·반격·지원 범위에 의존하는 공략은 원문 조건을 맞추지 못했을 때 결과 차이가 커질 수 있다. 반면 다섯 명 편성은 더 높은 성공 비율을 보였다. 다만 서로 다른 구역과 공략을 비교한 것이므로, 인원을 늘린 것만으로 성공률이 올라간다는 인과관계를 확인한 시험은 아니다.')
w('')
w('### 본편과 이벤트')
w('')
w('| 구분 | 유효 항목 | 기본 한 번 이상 | 기본 세 번 모두 | 추천 한 번 이상 | 추천 세 번 모두 |')
w('|---|---:|---:|---:|---:|---:|')
for name,data in by_content.items():
    a,c=data['basic'],data['recommended']
    w(f'| {name} | {a["cases"]:,}건 | {a["any"]:,}건 ({percent(a["any"],a["cases"])}) | {a["stable"]:,}건 ({percent(a["stable"],a["cases"])}) | {c["any"]:,}건 ({percent(c["any"],c["cases"])}) | {c["stable"]:,}건 ({percent(c["stable"],c["cases"])}) |')
w('')
w('본편에는 본편의 도전 구역이 포함돼 있다. 위 분류는 저장된 구역 연결을 따른 것으로, 두 콘텐츠의 난도가 같은 조건이라는 뜻은 아니다.')
w('')
w('## 8. 수동 분배를 바꿨을 때의 변화')
w('')
w('두 조건에서 판정이 끝난 2,768건을 짝지어 비교했다. 기본 분배에서 성공이 없었지만 추천 분배에서는 성공한 항목이 68건이고, 반대로 기본 분배에서 성공했지만 추천 분배에서는 성공이 없는 항목이 30건이었다. 추천 분배로 세 번 모두 성공한 항목은 전체 기준으로 60건 늘었다.')
w('')
w('추천 분배는 모든 공략에 최적인 분배가 아니다. 원문에서 요구하는 치명·적중 수치를 맞추는 대신 다른 능력치를 우선하면, 일부 조합은 오히려 불리해질 수 있다. 개별 분배를 유지할 수 있다는 점은 조정 수단이 남는다는 의미지만, 개편으로 바뀐 행동 순서나 효과 지속까지 분배만으로 해결된다고 확인한 것은 아니다.')
w('')
w('| 사례 | 편성 | 기본 성공 | 추천 성공 | 해석 |')
w('|---|---|---:|---:|---|')
resolved=[i for i in valid_indices if not review(basic[i]) and not review(recommended[i])]
gained=[i for i in resolved if not win_count(basic[i]) and win_count(recommended[i])]
lost=[i for i in resolved if win_count(basic[i]) and not win_count(recommended[i])]
selected=[]
seen=set()
for indices in [gained,lost]:
    added=0
    for i in indices:
        token=(basic[i]['stage'],members(basic[i]))
        if token in seen:continue
        seen.add(token);selected.append(i);added+=1
        if added==4:break
for i in selected:
    w(f'| {stage_name(basic[i]["stage"])} | {members(basic[i])} | {win_count(basic[i])}/3 | {win_count(recommended[i])}/3 | {"추천 분배에서 성공 확인" if i in gained else "표준 추천이 원문에 최적은 아님"} |')
w('')
w('## 9. 실패·교착·확인 보류 분석')
w('')
w('### 행동 수 제한과 교착 정황')
w('')
w(f'기본 분배는 {b["outcomes"]["timeout"]}회, 추천 분배는 {r["outcomes"]["timeout"]}회가 모의실험의 실행 행동 2,000회 제한에 도달했다. 그중 오랫동안 양쪽 체력 변화가 없었다는 교착 진단 기록은 각각 {b["stalemate_runs"]}회와 {r["stalemate_runs"]}회다. 진행 멈춤 판정이 0회라는 사실을 전투가 끝나지 않는 상황도 없었다는 의미로 읽어서는 안 된다.')
w('')
w('이 결과만으로 원인을 하나로 확정할 수는 없다. 사거리 밖 배치, 적중 부족, 필요한 특수 장비 누락, 이동 규칙, 행동 불가 효과의 해제 시점 등을 원문 조건과 함께 확인해야 한다. 체력 변화가 없었다는 기록은 재현 우선순위를 정할 근거이며, 곧바로 특정 원인을 입증하는 자료는 아니다.')
w('')
w('### 계산 시간 제한으로 남은 항목')
w('')
w('| 조건 | 전투 구역 | 편성 | 승패를 확정하지 못한 실행 |')
w('|---|---|---|---:|')
for label,rows in [('기본 분배',basic),('추천 분배',recommended)]:
    for row in rows:
        count=sum(x['outcome']=='execution_timeout' for x in row['runs'])
        if count:w(f'| {label} | {stage_name(row["stage"])} | {members(row)} | {count}회 |')
w('')
w('계산 시간 제한은 한 번의 전투 계산에 30초를 적용한 시험 장치다. 실제 게임에서 전투가 30초를 넘으면 실패한다는 뜻이 아니다. 이 항목은 미완료로 남기고 성공 또는 패배에 임의로 포함하지 않았다. 이미 오래 걸려 중단한 실행의 완료 기록은 보존했고, 미완료 항목만 추가로 시도했다.')
w('')
w('### 두 분배 모두 수집 공략에서 성공을 찾지 못한 구역')
w('')
w(f'계산 제한으로 미확정인 항목을 제외하고, 두 분배 모두에서 수집한 공략 조합으로 성공을 찾지 못한 구역은 {len(both_failed)}곳이다. 아래 숫자는 그 구역에서 시험한 공략 항목 수다. 해당 구역의 모든 가능한 조합을 시험했다는 뜻은 아니다.')
w('')
w('| 전투 구역 | 수집 공략 항목 수 | 우선 확인 관점 |')
w('|---|---:|---|')
for key,indices in both_failed:
    hint='여러 수집 조합에서 반복되는 조건 확인' if len(indices)>=3 else '원문 육성·장비·배치부터 재현'
    w(f'| {stage_name(key)} | {len(indices)}건 | {hint} |')
w('')
w('## 10. 전투 구역별 활용 가능성과 제한 임무')
w('')
w('| 구역 단위 지표 | 기본 수동 분배 | 추천 수동 분배 |')
w('|---|---:|---:|')
w(f'| 시험한 전투 구역 | {b["stages"]}곳 | {r["stages"]}곳 |')
w(f'| 한 번 이상 성공한 공략이 있는 구역 | {b["stages_any_win"]}곳 | {r["stages_any_win"]}곳 |')
w(f'| 세 번 모두 성공한 공략이 있는 구역 | {b["stages_stable"]}곳 | {r["stages_stable"]}곳 |')
w('')
w('추천 분배에서 성공한 공략 항목 수가 더 많아도, 성공한 구역 수는 기본 분배보다 적을 수 있다. 한 구역에 여러 공략이 몰려 있기 때문이다. 실제로 추천 분배는 성공 항목이 늘었지만 성공 구역은 292곳에서 289곳으로 줄었다. 전체 성공률 하나로 모든 구역의 개선 여부를 판단하면 안 된다.')
w('')
w('### 30회 제한 임무의 가정별 대조')
w('')
w('유효 시험 구역 중 저장된 자료에 30회 제한 임무가 있는 구역은 166곳이다. 실제 서버 판정은 확인하지 않았으므로, 30회 이하를 성공으로 가정한 탐색 결과만 제시한다.')
w('')
w('| 지표 | 기본 수동 분배 | 추천 수동 분배 |')
w('|---|---:|---:|')
for label,key in [('대상 구역','stages'),('수집 공략 중 전투 승리 기록이 있는 구역','with_win'),('아군 본 행동만 30회 이하인 승리 기록이 있는 구역','pc30'),('적을 포함한 전체 본 행동이 30회 이하인 승리 기록이 있는 구역','all30')]:
    w(f'| {label} | {missions["basic"][key]}곳 | {missions["recommended"][key]}곳 |')
w('')
w('아군 본 행동과 전체 본 행동은 다른 지표다. 지원 공격·반격·연속 행동·예약 기술 발동은 이 기록의 아군 본 행동 수에 더하지 않는다. 어떤 값을 서버가 사용하는지, 30회 이하인지 30회 미만인지 확인해야 한다. 아군 본 행동 최솟값이 정확히 30회인 구역도 조건별 한 곳씩 있어 경계값의 영향이 있다.')
w('')
w('기준 안에 드는 기록은 수집한 여러 공략과 세 난수 실행 중 하나라도 찾은 경우다. 임무를 매번 안정적으로 달성한다는 뜻이 아니다. 기준 안에 드는 기록을 찾지 못한 구역도 원문 조건이나 다른 편성으로 달성할 가능성이 남아 있으므로 달성 불가로 단정하지 않는다.')
w('')
w('## 11. 이번 결과가 설명할 수 있는 범위와 한계')
w('')
w('| 한계 | 결과에 미칠 수 있는 영향 | 후속 확인 |')
w('|---|---|---|')
w('| 원문 이미지 배치 미복원 | 보호 범위·지원 범위·사거리 차이 | 원문의 아홉 칸 위치 재현 |')
w('| 대표 장비 사용 | 회피·반격·전용 효과 조건 누락 | 원문 장비와 강화 수준 적용 |')
w('| 레벨 100으로 통일 | 상한 확장 공략의 피해·생존 부족 | 원문의 레벨과 상한 확장 적용 |')
w('| 연결·호감도 보너스 없음 | 원문 요구 능력치 미달 | 연결 수와 선택 보너스·호감도 재현 |')
w('| 최대 승급으로 통일 | 원문의 승급 상태·기술 조건과 차이 | 실제 승급 상태 적용 |')
w('| 전투원별 표준 분배 | 공략별 요구 능력치와 불일치 | 원문의 적중·치명·회피 목표 적용 |')
w('| 자동 전투만 실행 | 수동 기술 선택·이동 공략 재현 부족 | 원문의 조작 순서 재현 |')
w('| 난수 시작값 세 개 | 드문 실패나 특정 순서 누락 | 원문 조건을 맞춘 뒤 반복 횟수 확대 |')
w('| 개편 전 엔진 부재 | 전후 차이를 전투 규칙 변화로 분리하기 어려움 | 같은 편성으로 실제 개편 전후 실행 대조 |')
w('| 서버 판정 미확인 | 턴 제한 임무 판정 해석 차이 | 서버가 세는 값과 경계 조건 확인 |')
w('')
w('실패 수를 그대로 개편 때문에 깨진 공략 수로 해석할 수 없고, 성공 수도 원문 공략의 완전한 호환을 입증하지 않는다. 검증된 것은 지정한 시험 조건에서 해당 편성이 승리하거나 승리하지 못했다는 사실이다. 실제 초 단위 시간과 자원 소모를 측정하지 않았으므로 파밍 효율의 전후 증감도 결론 내리지 않는다.')
w('')
w('## 12. 후속 검증 우선순위와 완료 기준')
w('')
w('| 우선순위 | 대상 | 수행 내용 | 완료 기준 |')
w('|---|---|---|---|')
w('| 먼저 확인 | 계산 제한이 남은 새해 물자 탐색 4·설원 탐사 7의 해당 편성 | 원문 조건 재현 후 실제 게임과 모의실험의 행동·효과 기록 대조 | 승패 확인 또는 교착 진입 지점과 원인 특정 |')
w('| 먼저 확인 | 두 분배에서 여러 공략이 함께 실패한 구역 | 원문 배치·장비·육성 복원 후 재시험 | 시험 조건 차이와 전투 규칙 문제 구분 |')
w('| 다음 확인 | 한 명·두 명 반복 파밍 공략 | 연결·호감도·정확한 능력치와 위치 복원 | 대표 난수뿐 아니라 장기 반복에서 실패 기록 확인 |')
w('| 다음 확인 | 한두 번만 성공한 조합 | 실패한 난수에서 사망·적중·행동 순서 추적 | 실패 원인 설명과 조정 전후 재현 |')
w('| 병행 확인 | 30회 제한 임무 | 서버 기준과 경계값 확정 | 같은 전투 기록의 클라이언트·서버 판정 일치 |')
w('| 이후 확대 | 세 번 모두 성공한 대표 편성 | 실제 기기에서 조작감·연출·반복 시간 확인 | 실제 전투 완주와 기록한 행동 흐름의 일치 |')
w('')
w('추가 반복 횟수를 늘리기 전에 원문 조건부터 맞추는 것이 우선이다. 현재처럼 배치·장비·연결이 다른 상태에서 난수만 더 많이 돌리면, 원문 공략 재현 여부에 대한 불확실성을 충분히 줄이지 못한다.')
w('')
w('## 13. 개발자 노트에 사용할 수 있는 표현')
w('')
w('확인한 사실에 맞는 표현은 “기존 성장 방식과 수동 능력치 분배를 유지한 조건으로 기존 공략 조합을 시험했고, 상당수 조합이 개편 전투에서도 클리어되는 것을 확인했다”는 수준이다. “모든 기존 공략을 그대로 사용할 수 있다”, “전투 시간과 파밍 효율이 유지된다”, “교착 문제가 없다”는 표현을 뒷받침할 자료는 아직 없다.')
w('')
w('아래 문장은 개발자 노트에 넣을 수 있는 초안이다.')
w('')
w('> 사령관님들께서 키워두신 전투원과 직접 맞춰두신 능력치를 다시 손봐야 하는 건 아닌지 걱정하실 것 같습니다. 이번에는 기존 성장 방식과 수동 능력치 분배를 유지한 상태에서, 그동안 사용하시던 공략 조합들을 바뀐 전투로 돌려봤습니다. 상당수 조합은 그대로 전투를 마칠 수 있었지만, 이 결과만 보고 모든 공략을 똑같이 쓰실 수 있다고 말씀드리기는 어렵습니다. 특히 적은 인원으로 반복 파밍하는 조합은 장비나 칸 하나에도 결과가 달라질 수 있어서, 공략에 적힌 조건을 맞춰 다시 살펴봐야 할 부분이 남아 있습니다.')
w('')
w('## 부록. 실행 기록과 재현성 근거')
w('')
w('기본 분배는 앞선 시험에서 완료한 2,644건을 보존하고, 미완료였던 134건을 추가로 실행했다. 추천 분배는 전체 2,778건을 새로 실행했다. 이후 포츈의 저항 복원에 영향을 받는 네 항목을 두 조건에서 다시 실행해 덮어 반영했다. 계산 제한 때문에 미완료인 기록은 별도 상태를 유지한다.')
w('')
w('계산 제한에 걸리지 않았고 저항 복원으로 입력이 바뀌지 않은 실행은 과거 저장 기록과 모두 일치했다. 전투 계산 도구의 기초 점검도 수행했지만, 이것이 실제 클라이언트 전체와의 완전한 일치를 보장하지는 않는다. 게임 원본 능력치·전투 자료는 이번 보고서 작성이나 시험 조건 변경으로 수정하지 않았다.')
w('')
w('| 근거 자료 | 용도 |')
w('|---|---|')
sources=[('기본 수동 분배 전체 실행 기록',DEST/'기본수동분배_전체결과.json','항목별 편성·난수별 승패·행동 수·종료 이유'),
         ('추천 수동 분배 전체 실행 기록',DEST/'추천수동분배_전체결과.json','추천 분배 조건의 같은 기록'),
         ('전체 결과 집계',DEST/'수동성장_집계.json','성공·실패·보류·구역 단위 집계'),
         ('상세 분석 집계',DEST/'상세분석_집계.json','편성 인원·콘텐츠·임무·공통 실패 구역 분석'),
         ('시험 입력 자료 지문',DEST/'수동성장_입력자료지문.json','성장표·공략·전투 도구의 입력 식별'),
         ('기존 공략 편성 입력',SOURCE/'guide-squads.json','제목에서 추출한 편성과 배치'),
         ('전투원별 추천 분배',SOURCE/'stat-reco.json','추천 점수와 목표 능력치의 근거'),
         ('기존 성장표',SOURCE/'pcability_r15485.json','기존 능력치 복원의 기준'),
         ('요약 보고서',ROOT/'reports/수동능력치유지_공략검증_20261022.md','이번 상세 분석의 기초 결과')]
for label,path,purpose in sources:w(f'| {link(label,path)} | {purpose} |')
w('')
w('구역별·편성별 수치는 저장된 실행 기록에서 다시 집계했다. 실제 게임을 새로 구동하거나 추가 전투를 실행한 보고서는 아니며, 이번 요청에서는 기존 시험 기록의 분석 범위를 확장했다.')
report=ROOT/'reports/수동능력치유지_전투검증_상세보고서_20261022.md'
report.write_text('\n'.join(L)+'\n',encoding='utf-8')
fingerprints={'보고서':hashlib.sha256(report.read_bytes()).hexdigest(), '집계':hashlib.sha256((DEST/'상세분석_집계.json').read_bytes()).hexdigest()}
(DEST/'상세보고서_자료지문.json').write_text(json.dumps(fingerprints,ensure_ascii=False,indent=2),encoding='utf-8')
print(json.dumps({'sections':13,'lines':len(L),'characters':len(report.read_text(encoding='utf-8')),'valid_cases':len(valid_indices),'both_failed_stages':len(both_failed),'used_sources':dict(used_sources)},ensure_ascii=False))
