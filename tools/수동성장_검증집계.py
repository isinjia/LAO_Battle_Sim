"""기존 성장표와 수동 능력치 분배를 유지한 공략 시험을 집계한다."""
import collections
import datetime
import hashlib
import json
import pathlib
import re

ROOT = pathlib.Path(__file__).resolve().parent.parent
SOURCE = ROOT / 'tools' / 'out'
PREVIOUS = SOURCE / '재시험_20261022'
DEST = PREVIOUS / '수동성장_추가검증'
read = lambda p: json.loads(p.read_text(encoding='utf-8-sig'))
guides = read(SOURCE / 'guide-squads.json')
partial = read(PREVIOUS / '이전능력치_부분결과.json')

def check(index, row):
    assert (row['post'], row['stage']) == (guides[index]['post'], guides[index]['stage']), index
    assert len(row['runs']) == 3 and not row.get('unresolved') and not row.get('error'), index

def load_parts(folder, prefix, count, indices=None):
    indices = list(range(len(guides))) if indices is None else indices
    rows = {}
    for part in range(count):
        data = read(folder / f'{prefix}.part{part}.json')
        selected = indices[part::count]
        assert len(selected) == len(data['results']), part
        assert data['seeds'] == 3 and data['gear'] is True
        for index, row in zip(selected, data['results']):
            check(index, row)
            assert index not in rows
            rows[index] = row
    return rows

basic = {}
for part in range(8):
    file = PREVIOUS / f'guide-old-guide-test-gear.part{part}.json'
    rows = read(file)['results'] if file.exists() else partial['results']
    assert file.exists() or part == 3
    for index, row in zip(range(part, len(guides), 8), rows):
        check(index, row)
        basic[index] = row
pending = read(DEST / '미완료항목.json')
assert set(pending) == set(range(len(guides))) - set(basic)
extra = load_parts(DEST, 'guide-old-guide-test-gear', 8, pending)
active_index = 3 + len(partial['results']) * 8
for seed, completed in enumerate(partial['active']['runs']):
    if extra[active_index]['runs'][seed]['outcome'] == 'execution_timeout':
        extra[active_index]['runs'][seed] = completed
basic.update(extra)
recommended = load_parts(DEST, 'guide-reco-guide-test-gear', 32)
resistance_indices = read(DEST / '저항복원항목.json')
basic.update(load_parts(DEST / '저항복원', 'guide-old-guide-test-gear', 1, resistance_indices))
recommended.update(load_parts(DEST / '저항복원', 'guide-reco-guide-test-gear', 1, resistance_indices))
assert set(basic) == set(recommended) == set(range(len(guides)))
basic = [basic[i] for i in range(len(guides))]
recommended = [recommended[i] for i in range(len(guides))]

def wins(row):
    return sum(run['outcome'] == 'win' for run in row['runs'])

def excluded(row):
    return all('no battle to simulate' in run.get('reason', '') for run in row['runs'])

def unresolved(row):
    return any(run['outcome'] == 'execution_timeout' or (run['outcome'] == 'error' and 'no battle to simulate' not in run.get('reason', '')) for run in row['runs'])

def summary(rows):
    counts = collections.Counter(run['outcome'] for row in rows for run in row['runs'])
    groups = collections.Counter()
    for row in rows:
        category = 'excluded' if excluded(row) else 'review' if unresolved(row) else 'stable' if wins(row) == 3 else 'mixed' if wins(row) else 'failed'
        groups[category] += 1
    assert sum(groups.values()) == len(rows)
    stage_groups = collections.defaultdict(list)
    for row in rows:
        if not excluded(row):
            stage_groups[row['stage']].append(row)
    return {'cases': len(rows), 'valid_cases': len(rows) - groups['excluded'], 'runs': sum(counts.values()),
            'any_win': sum(wins(row) > 0 for row in rows), 'groups': dict(groups), 'outcomes': dict(counts),
            'stalemate_runs': sum('stalemate' in run.get('reason', '') for row in rows for run in row['runs']),
            'stages': len(stage_groups),
            'stages_any_win': sum(any(wins(row) for row in group) for group in stage_groups.values()),
            'stages_stable': sum(any(wins(row) == 3 for row in group) for group in stage_groups.values()),
            'stages_no_win_resolved': sum(not any(wins(row) or unresolved(row) for row in group) for group in stage_groups.values())}

old_basic = load_parts(SOURCE, 'guide-old-guide-test-gear', 14)
old_recommended = load_parts(SOURCE, 'guide-reco-guide-test-gear', 14)
def replay_differences(rows, previous):
    return sum(run != previous[i]['runs'][s] for i, row in enumerate(rows) for s, run in enumerate(row['runs']) if i not in resistance_indices and run['outcome'] != 'execution_timeout')

stats = {'generatedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
         'basic': summary(basic), 'recommended': summary(recommended),
         'basic_record_differences': replay_differences(basic, old_basic),
         'recommended_record_differences': replay_differences(recommended, old_recommended)}
stats['resistance_restored_cases'] = len(resistance_indices)
paired_resolved = [i for i, (a, b) in enumerate(zip(basic, recommended)) if not excluded(a) and not unresolved(a) and not unresolved(b)]
gained = [i for i in paired_resolved if wins(basic[i]) == 0 and wins(recommended[i]) > 0]
lost = [i for i in paired_resolved if wins(basic[i]) > 0 and wins(recommended[i]) == 0]
stats.update({'paired_resolved': len(paired_resolved), 'manual_distribution_gained': len(gained), 'manual_distribution_lost': len(lost)})
for label, rows in [('기본수동분배_전체결과.json', basic), ('추천수동분배_전체결과.json', recommended)]:
    (DEST / label).write_text(json.dumps({'seeds': 3, 'gear': True, 'oldGrowth': True, 'results': rows}, ensure_ascii=False, indent=1), encoding='utf-8')
(DEST / '수동성장_집계.json').write_text(json.dumps(stats, ensure_ascii=False, indent=2), encoding='utf-8')

inputs = [SOURCE / name for name in ['guide-squads.json', 'pcability_r15485.json', 'stat-reco.json', 'stat-reco-community.json', 'guide-stat-tags.json']]
inputs += list((ROOT / 'engine').glob('*.js')) + list((ROOT / 'data').glob('*.json'))
inputs += [pathlib.Path(__file__).resolve(), ROOT / 'tools' / 'guide_test.js']
fingerprint = {str(path.relative_to(ROOT)): hashlib.sha256(path.read_bytes()).hexdigest() for path in inputs}
(DEST / '수동성장_입력자료지문.json').write_text(json.dumps(fingerprint, ensure_ascii=False, indent=2), encoding='utf-8')

loc = read(ROOT / 'data' / 'loc.json')
stages = read(ROOT / 'data' / 'stages.json')['Table_MapStage']
def korean(value):
    value = str(value).replace('LRL', '엘알엘')
    numbers = {'I': '1', 'II': '2', 'III': '3', 'IV': '4', 'V': '5', 'VI': '6', 'VII': '7', 'VIII': '8', 'IX': '9', 'X': '10'}
    value = re.sub(r'\b[IVX]+\b', lambda m: numbers.get(m.group(), ''), value)
    return re.sub(r'\s+', ' ', re.sub(r'[A-Za-z][A-Za-z0-9_\-/]*', '', value)).strip(' /') or '이름 표기 생략'
def stage_name(row):
    return korean(loc.get(stages[row['stage']].get('StageName', ''), '이름 확인 필요'))
def example(i):
    row = recommended[i]
    return f'| {stage_name(row)} | {", ".join(korean(m["name"]) for m in row["squad"])} | {wins(basic[i])}/3 | {wins(row)}/3 |'

b, r = stats['basic'], stats['recommended']
percentage = lambda count, data: f'{100 * count / data["valid_cases"]:.1f}%'
lines = ['# 기존 능력치와 수동 분배를 유지한 전투 공략 검증', '', '시험일: 2026년 10월 22일', '',
         '## 적용 조건', '',
         '- 능력치 자동 성장을 없애고 기존 성장표와 수동 강화 점수를 유지하는 조건으로 시험했다. 게임의 원본 능력치 표를 수정한 것은 아니며 모의실험 안에서만 해당 조건을 적용했다.',
         '- 전투 규칙은 개편된 방식이다. 개편 전 전투 엔진 자체를 재현한 비교는 아니다.',
         f'- 기존 공략 2,488건을 전투 구역별 {len(guides):,}건으로 펼치고, 각 조건에서 난수 시작값 세 개로 실행했다.',
         '- 기본 수동 분배는 회피 공략에 회피 100점과 공격 197점, 나머지 공략에 치명 100점과 공격 197점을 적용했다.',
         '- 추천 수동 분배는 클로드가 수집한 공략의 적중·치명·회피 목표를 참고한 전투원별 표준 분배다. 공략별 원문 분배를 그대로 복원한 값은 아니다. 자료가 부족한 전투원은 역할별 목표를 사용한다.',
         '- 시험에 사용한 전투원 206명의 추천 분배가 모두 존재하며, 강화 점수 합계 297점과 회피·치명 각각 100점 상한을 넘지 않음을 확인했다.',
         '- 기존 도구는 포츈의 기본 화염·냉기·전기 저항 35%를 복원하지 않았다. 기존 능력치 복원 범위에 저항을 포함하도록 시험 도구를 보완하고, 포츈이 들어간 네 항목을 두 분배 조건에서 다시 실행했다.',
         '- 레벨 100, 최대 승급, 기술 수준 10, 대표 장비 강화 10으로 통일했다. 편성·배치·장비 선택 기준은 두 조건에서 같다.',
         '- 실제 공략의 레벨·코어 연결·호감도·장비·배치·수동 조작을 완전히 복원하지 않았다. 따라서 실패가 곧 해당 원본 공략의 불가능을 뜻하지는 않는다.', '',
         '## 결과', '',
         f'전체 {len(guides):,}건 중 전투가 없는 이야기 구역 8건을 제외한 {b["valid_cases"]:,}건을 비율의 분모로 사용했다.', '',
         '| 지표 | 기본 수동 분배 | 추천 수동 분배 |', '|---|---:|---:|',
         f'| 한 번 이상 성공 | {b["any_win"]:,}건 ({percentage(b["any_win"], b)}) | {r["any_win"]:,}건 ({percentage(r["any_win"], r)}) |',
         f'| 세 번 모두 성공 | {b["groups"].get("stable", 0):,}건 ({percentage(b["groups"].get("stable", 0), b)}) | {r["groups"].get("stable", 0):,}건 ({percentage(r["groups"].get("stable", 0), r)}) |',
         f'| 한두 번만 성공하고 나머지는 실패 | {b["groups"].get("mixed", 0):,}건 | {r["groups"].get("mixed", 0):,}건 |',
         f'| 세 번 모두 성공 없음, 실행 완료 | {b["groups"].get("failed", 0):,}건 | {r["groups"].get("failed", 0):,}건 |',
         f'| 계산 제한 등으로 확인 보류 | {b["groups"].get("review", 0):,}건 | {r["groups"].get("review", 0):,}건 |',
         f'| 전투 없는 구역, 집계 제외 | {b["groups"].get("excluded", 0):,}건 | {r["groups"].get("excluded", 0):,}건 |', '',
         '한 번 이상 성공과 세 번 모두 성공은 서로 겹치는 지표다. 세 번 성공했다고 장시간 반복 파밍의 무실패가 보장되는 것은 아니다.',
         f'전투 구역 {r["stages"]:,}곳 중 추천 분배로 한 번 이상 성공한 공략 조합이 있는 구역은 {r["stages_any_win"]:,}곳, 세 번 모두 성공한 조합이 있는 구역은 {r["stages_stable"]:,}곳이다.', '',
         '## 수동 분배 선택에 따른 차이', '',
         f'- 두 조건에서 판정이 완료된 {len(paired_resolved):,}건을 비교했다.',
         f'- 기본 분배에서 성공이 없었지만 추천 분배에서는 성공한 항목은 {len(gained):,}건이다.',
         f'- 반대로 기본 분배에서는 성공했지만 추천 분배에서는 성공이 없는 항목은 {len(lost):,}건이다.',
         '- 전투원별 표준 추천 하나가 모든 공략에 최적이라는 의미는 아니다. 원문의 장비와 필요한 능력치 목표를 맞춰야 하는 공략이 남아 있다.', '',
         '| 전투 구역 | 편성 | 기본 성공 | 추천 성공 |', '|---|---|---:|---:|']
for i in gained[:8] + lost[:5]:
    lines.append(example(i))
lines += ['', '## 실행 제한과 재현성', '',
          '- 이전 시험에서 완료한 기본 분배 2,644건을 보존하고, 미완료 134건을 추가로 실행했다. 추천 분배는 전체 2,778건을 새로 실행했다.',
          '- 추가 실행과 추천 분배 시험은 한 번의 전투에 계산 시간 30초 제한을 두었다. 이 제한은 실제 게임의 전투 시간 제한이 아니다. 제한을 넘긴 실행은 패배로 처리하지 않고 확인 보류로 분리했다.',
          '- 행동 수 2,000회 제한과 계산 시간 제한은 별개다. 행동 수 제한에 도달한 결과는 승리가 확인되지 않은 완료 실행으로 집계한다.',
          f'- 계산 제한에 걸리지 않고 저항 복원으로 입력이 바뀌지 않은 실행을 과거 저장 결과와 대조했을 때 달라진 기록은 기본 분배 {stats["basic_record_differences"]:,}회, 추천 분배 {stats["recommended_record_differences"]:,}회다.', '',
          '| 실행 결과 | 기본 수동 분배 | 추천 수동 분배 |', '|---|---:|---:|']
labels = [('win', '승리'), ('lose', '패배'), ('timeout', '행동 수 제한 도달'), ('execution_timeout', '계산 시간 제한'), ('stuck', '진행 멈춤'), ('error', '오류 기록')]
for key, label in labels:
    lines.append(f'| {label} | {b["outcomes"].get(key, 0):,}회 | {r["outcomes"].get(key, 0):,}회 |')
lines += ['', '오류 기록 중 전투가 없는 구역은 조건별 24회다. 이 기록은 전투 중 발생한 오류와 구분해야 한다.',
          f'행동 수 제한에 도달한 실행 중 체력 변화가 오래 없었다는 교착 기록은 기본 분배 {b["stalemate_runs"]:,}회, 추천 분배 {r["stalemate_runs"]:,}회다. 따라서 진행 멈춤 판정이 없다는 사실을 전투 교착도 없다는 뜻으로 읽으면 안 된다. 실제 장비·배치·적중 조건과 이동·효과 지속 규칙을 확인해야 한다.', '',
          '계산 시간 제한이 발생한 항목은 다음과 같다. 성공 횟수가 0이라고 확인 보류 항목을 확정 실패로 보아서는 안 된다.', '',
          '| 분배 | 전투 구역 | 편성 |', '|---|---|---|']
for label, rows in [('기본', basic), ('추천', recommended)]:
    for row in rows:
        if unresolved(row):
            lines.append(f'| {label} | {stage_name(row)} | {", ".join(korean(m["name"]) for m in row["squad"])} |')
lines += ['',
          '## 개발자 노트에 반영할 내용', '',
          '- 능력치 자동 성장 도입과 수동 분배 제거에 관한 설명은 삭제한다.',
          '- 기존 성장 방식과 수동 분배를 유지한 채 개편 전투에서 기존 공략 조합을 시험했다는 사실을 설명한다.',
          '- 기존 조합 상당수를 활용할 수 있었지만, 공략별 장비·배치·분배까지 모두 복원한 시험은 아니므로 모든 공략의 동일한 동작을 보장한다고 쓰지 않는다.',
          '- 이전에 자동 성장 조건으로 산출했던 성공률과 기존 조합 유지율을 이 조건의 결과로 인용하지 않는다.']
report = ROOT / 'reports' / '수동능력치유지_공략검증_20261022.md'
report.write_text('\n'.join(lines) + '\n', encoding='utf-8')
print(json.dumps(stats, ensure_ascii=False, indent=2))
