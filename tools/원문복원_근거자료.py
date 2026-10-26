"""원문 복원 대상 공략별 근거 자료를 만든다: 출처 주소, 저장 본문 출처, 확보 이미지, 추출한 조건과 인용문, 시험 입력 반영 여부, 미확인 항목.
python -I tools/원문복원_근거자료.py  ->  tools/out/원문복원시험_20261022/공략별_근거자료.json, 공략별_근거자료.csv
"""
import csv, glob, json, os

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, 'out')
D = os.path.join(OUT, '원문복원시험_20261022')
J = lambda p: json.load(open(p, encoding='utf-8'))

targets = J(os.path.join(OUT, '원문조건복원_20261022', '원문복원_대상과근거.json'))
crawl = {x['id']: x for x in J(os.path.join(OUT, 'guide-crawl.json'))}
bodies = {x['id']: x for x in J(os.path.join(OUT, 'guide-bodies.json'))}
extract = {e['post']: e for e in J(os.path.join(D, '전체추출.json'))}
mapped = {}
for f in ['복원값_본문_엄격.json', '복원값_화면_56681644.json']:
    for r in J(os.path.join(D, f)):
        mapped.setdefault(r['post'], []).append(r)
old_reads = J(os.path.join(D, '근거', '이전대화_원문본문읽기.json'))
images = {
    56681644: [('근거/56681644_능력치화면_기록7632.png', '능력치 화면: 레벨·강화 점수·연결·표시 능력치·장비 네 칸')],
    126512218: [('근거/126512218_능력치화면_기록6481.png', '능력치 화면: 레벨·강화 점수·연결·완전 연결 보너스·표시 능력치·장비 네 칸')],
    126444550: [('근거/126444550_편성화면_기록7569.png', '편성 화면: 구성원 다섯 명·페레그리누스 표시 능력치·장비 네 칸')],
}
FIELDS = ['members', 'placement', 'level', 'grade', 'skillLevel', 'coreLink', 'fullLinkBonus', 'favorOath', 'statPoints', 'equipment', 'noEquipment', 'startHp', 'instructions']
KOR = {'members': '구성원', 'placement': '배치', 'level': '레벨', 'grade': '승급', 'skillLevel': '기술 수준', 'coreLink': '코어 연결', 'fullLinkBonus': '완전 연결 보너스',
       'favorOath': '호감도·서약', 'statPoints': '강화 점수·능력치 목표', 'equipment': '장비', 'noEquipment': '장비 없음 명시', 'startHp': '시작 체력', 'instructions': '조작 지시'}
NEED = ['배치', '레벨', '승급', '기술 수준', '코어 연결', '호감도·서약', '강화 점수·능력치 목표', '장비', '시작 체력', '조작 지시']

rows = []
for t in targets:
    p = t['post']
    c, b, e = crawl.get(p) or {}, bodies.get(p) or {}, extract.get(p)
    ctext, btext = c.get('text', '') or '', b.get('text', '') or ''
    if btext and len(btext) >= len(ctext):
        src = '본문 저장 자료(guide-bodies)'
    elif ctext:
        src = '목록 수집 자료(guide-crawl, 최대 3,000자)'
    elif str(p) in old_reads:
        src = '이전 수집 대화의 본문 읽기 기록(일부)'
    else:
        src = ''
    if b.get('status') == 404:
        missing = '수집 당시 원문 404 응답(삭제 또는 이동 추정)'
    elif not src:
        missing = '저장 본문 없음, 원문 사이트 접근 차단(내장 브라우저 451 응답, 크롬 확장 접근 정책)으로 새로 받을 수 없음'
    else:
        missing = ''
    found = {}
    if e and e.get('relevant'):
        for f in FIELDS:
            if e.get(f):
                found[KOR[f]] = [x.get('quote', '') for x in e[f]][:6]
    covered = set(found)
    if '장비 없음 명시' in covered:
        covered.add('장비')
    if '완전 연결 보너스' in covered:
        covered.add('코어 연결')
    m = mapped.get(p, [])
    in_test = sorted({f for r in m for s in r['squad'] for f in (s.get('fields') or {})})
    if p == 56681644:
        covered |= {'레벨', '승급', '강화 점수·능력치 목표', '코어 연결', '장비'}
    level = '보류(자료 없음)' if not src and p not in images else ('보류(설정 정보 없음)' if not covered else '부분')
    rows.append({
        'post': p, 'url': t['url'], 'title': t['title'], 'stages': t['stages'], 'caseIndices': t['caseIndices'],
        'writtenAt': '미확보(원문 접근 차단, 수집 자료에 작성일 없음)', 'editedAt': '미확보',
        'editMentions': [x.get('quote', '') for x in (e or {}).get('editsOrDates', [])][:5],
        'textSource': src or '없음', 'textLength': max(len(ctext), len(btext)), 'imagesInPost': c.get('imgs'),
        'imagesSaved': [{'file': f, 'what': w} for f, w in images.get(p, [])],
        'imagesNotSaved': '원문 이미지 주소가 수집 자료에 없고 사이트 접근이 막혀 원본 이미지는 저장하지 못함' if c.get('imgs') and p not in images else '',
        'imageDependent': [x.get('what', '') for x in (e or {}).get('imageDependent', [])][:5],
        'conditionsFound': found, 'conditionsUsedInTest': in_test,
        'unconfirmed': [n for n in NEED if n not in covered],
        'conditional': [x.get('quote', '') for x in (e or {}).get('conditional', [])][:5],
        'claimedResult': [x.get('quote', '') for x in (e or {}).get('claimedResult', [])][:5],
        'restoration': level if not m else '부분(시험 반영)', 'missingReason': missing,
    })

json.dump(rows, open(os.path.join(D, '공략별_근거자료.json'), 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
with open(os.path.join(D, '공략별_근거자료.csv'), 'w', encoding='utf-8-sig', newline='') as f:
    w = csv.writer(f)
    w.writerow(['글 번호', '주소', '제목', '시험 항목 수', '본문 출처', '본문 길이', '글 속 이미지 수', '저장 이미지', '원문에서 찾은 조건', '시험 반영 항목', '미확인 항목', '복원 수준', '누락 사유'])
    for r in rows:
        w.writerow([r['post'], r['url'], r['title'], len(r['caseIndices']), r['textSource'], r['textLength'], r['imagesInPost'] or '',
                    ' / '.join(x['file'] for x in r['imagesSaved']), ', '.join(r['conditionsFound']), ', '.join(r['conditionsUsedInTest']),
                    ', '.join(r['unconfirmed']), r['restoration'], r['missingReason']])
from collections import Counter
print(len(rows), Counter(r['restoration'] for r in rows), Counter(bool(r['missingReason']) for r in rows))
print(Counter(len(r['unconfirmed']) for r in rows if r['restoration'] != '보류(자료 없음)'))
