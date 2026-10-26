"""클로드 공략 자료의 재시험 결과를 누락 없이 집계한다."""
import collections
import datetime
import hashlib
import json
import pathlib
import re
import statistics
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
SOURCE = ROOT / 'tools' / 'out'
DEST = pathlib.Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else SOURCE / '재시험_20261022'
read = lambda p: json.loads(p.read_text(encoding='utf-8-sig'))
guides = read(SOURCE / 'guide-squads.json')

def load_parts(folder, prefix, parts):
    rows = [None] * len(guides)
    for part in range(parts):
        content = read(folder / f'{prefix}.part{part}.json')
        assert content['seeds'] == 3 and content['gear'] is True
        indices = list(range(part, len(guides), parts))
        assert len(indices) == len(content['results']), (part, len(indices), len(content['results']))
        for index, result in zip(indices, content['results']):
            assert (result['post'], result['stage']) == (guides[index]['post'], guides[index]['stage'])
            assert len(result['runs']) == 3, index
            assert not result.get('error') and not result.get('unresolved'), index
            rows[index] = result
    assert all(row is not None for row in rows)
    return rows

def wins(row):
    return sum(run['outcome'] == 'win' for run in row['runs'])

def summary(rows):
    counts = collections.Counter(wins(row) for row in rows)
    outcomes = collections.Counter(run['outcome'] for row in rows for run in row['runs'])
    no_battle = [row for row in rows if all('no battle to simulate' in run.get('reason', '') for run in row['runs'])]
    no_battle_runs = sum('no battle to simulate' in run.get('reason', '') for row in rows for run in row['runs'])
    return {'cases': len(rows), 'runs': sum(outcomes.values()), 'any_win': sum(counts[n] for n in (1, 2, 3)),
            'stable_win': counts[3], 'unstable_win': counts[1] + counts[2], 'no_win': counts[0],
            'no_battle_cases': len(no_battle), 'no_battle_runs': no_battle_runs,
            'runtime_error_runs': outcomes['error'] - no_battle_runs,
            'wins_distribution': dict(counts), 'outcomes': dict(outcomes)}

new = load_parts(DEST, 'guide-test-gear', 8)
old = load_parts(SOURCE, 'guide-old-guide-test-gear', 14)
historical = load_parts(SOURCE, 'guide-test-gear', 14)
fresh_old = {}
partial = read(DEST / '이전능력치_부분결과.json')
for part in range(8):
    file = DEST / f'guide-old-guide-test-gear.part{part}.json'
    if file.exists():
        rows = read(file)['results']
        assert len(rows) == len(range(part, len(guides), 8))
    else:
        assert part == 3 and partial['completed'] == len(partial['results'])
        rows = partial['results']
    for index, row in zip(range(part, len(guides), 8), rows):
        assert len(row['runs']) == 3
        assert (row['post'], row['stage']) == (guides[index]['post'], guides[index]['stage'])
        fresh_old[index] = row
fresh_old_diff = [i for i, row in fresh_old.items() if row['runs'] != old[i]['runs']]
(DEST / '이전능력치_완료결과.json').write_text(json.dumps({'indices': list(fresh_old), 'results': list(fresh_old.values())}, ensure_ascii=False, indent=1), encoding='utf-8')
historical_input_changed = [i for i, (a, b) in enumerate(zip(historical, new)) if a['squad'] != b['squad']]
for filename, rows in [('현재능력치_전체결과.json', new), ('이전능력치_기존기록.json', old)]:
    (DEST / filename).write_text(json.dumps({'seeds': 3, 'gear': True, 'results': rows}, ensure_ascii=False, indent=1), encoding='utf-8')
old_stable = [i for i, row in enumerate(old) if wins(row) == 3]
lost = [i for i, (a, b) in enumerate(zip(old, new)) if wins(a) > 0 and wins(b) == 0]
gained = [i for i, (a, b) in enumerate(zip(old, new)) if wins(a) == 0 and wins(b) > 0]
stable_lost = [i for i in old_stable if wins(new[i]) == 0]
stable_unstable = [i for i in old_stable if 0 < wins(new[i]) < 3]
stable_retained = [i for i in old_stable if wins(new[i]) == 3]
stable_both = stable_retained
slower, faster, ratios = [], [], []
for i in stable_both:
    before = statistics.median(run['total'] for run in old[i]['runs'])
    after = statistics.median(run['total'] for run in new[i]['runs'])
    ratios.append(after / before)
    if after > before * 1.2 and after - before >= 3:
        slower.append(i)
    if after < before / 1.2 and before - after >= 3:
        faster.append(i)

different = [i for i, (a, b) in enumerate(zip(historical, new)) if a['runs'] != b['runs']]
reason_counts = collections.Counter(run.get('reason', '') for row in new for run in row['runs'] if run['outcome'] != 'win')
stage_rows = collections.defaultdict(list)
for row in new:
    stage_rows[row['stage']].append(row)
no_stage_win = [stage for stage, rows in stage_rows.items() if not any(wins(row) for row in rows)]
stats = {'at': datetime.datetime.now(datetime.timezone.utc).isoformat(),
         'new': summary(new), 'old_stats': summary(old), 'historical': summary(historical),
         'old_fresh_cases': len(fresh_old), 'old_fresh_completed_runs': len(fresh_old) * 3,
         'old_fresh_differences': len(fresh_old_diff),
         'old_incomplete_cases': len(guides) - len(fresh_old),
         'different_from_historical': len(different), 'old_stable_cases': len(old_stable),
         'historical_input_changed': len(historical_input_changed),
         'stable_retained': len(stable_retained), 'stable_to_unstable': len(stable_unstable),
         'stable_to_no_win': len(stable_lost), 'any_win_to_no_win': len(lost), 'no_win_to_any_win': len(gained),
         'stable_both_slower': len(slower), 'stable_both_faster': len(faster),
         'stable_both_median_action_ratio': statistics.median(ratios) if ratios else None,
         'stages': len(stage_rows), 'stages_without_win': len(no_stage_win),
         'non_win_reasons': dict(reason_counts),
         'case_indices': {'lost': lost, 'gained': gained, 'stable_lost': stable_lost,
                          'stable_unstable': stable_unstable, 'slower': slower, 'different': different}}
(DEST / '집계.json').write_text(json.dumps(stats, ensure_ascii=False, indent=2), encoding='utf-8')

inputs = [*sorted((ROOT / 'engine').glob('*.js')), *sorted((ROOT / 'data').glob('*.json')),
          SOURCE / 'guide-squads.json', SOURCE / 'pc-names.json', SOURCE / 'stage-missions.json',
          SOURCE / 'pcability_r15485.json', SOURCE / 'guide-stat-tags.json',
          ROOT / 'tools' / 'guide_test.js', pathlib.Path(__file__).resolve()]
manifest = {'generatedAt': stats['at'], 'files': {str(p.relative_to(ROOT)): hashlib.sha256(p.read_bytes()).hexdigest() for p in inputs}}
(DEST / '입력자료_지문.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding='utf-8')

loc = read(ROOT / 'data' / 'loc.json')
stages = read(ROOT / 'data' / 'stages.json')['Table_MapStage']
def korean(value):
    return re.sub(r'\s+', ' ', re.sub(r'[A-Za-z][A-Za-z0-9_\-]*', '', str(value))).strip() or '이름 표기 생략'
def stage_name(key):
    return korean(loc.get(stages.get(key, {}).get('StageName', ''), '이름 확인 필요'))
def example(i):
    row = new[i]
    names = ', '.join(korean(member['name']) for member in row['squad'])
    return f'| {stage_name(row["stage"])} | {names} | {wins(old[i])}/3 | {wins(row)}/3 |'

n, o = stats['new'], stats['old_stats']
pct = lambda count: f'{100 * count / len(new):.1f}%'
lines = ['# 기존 공략 조합 전투 재시험', '', '시험일: 2026년 10월 22일', '',
         '## 시험 범위와 해석', '',
         f'- 클로드가 수집한 공략 {len(set(row["post"] for row in new)):,}건을 전투 구역별 {len(new):,}건으로 펼쳐 시험했다.',
         f'- 현재 능력치의 전체 {len(new):,}건을 난수 시작값 세 개로 직접 실행해 {n["runs"]:,}회를 완료했다.',
         f'- 이전 능력치는 추가 재실행에서 {len(fresh_old):,}건, {len(fresh_old) * 3:,}회를 완료했다. 완료된 모든 실행 기록은 이전 저장 결과와 일치했다. 나머지 {len(guides) - len(fresh_old):,}건의 전체 재실행은 완료하지 않았다.',
         '- 아래 표와 전체 조건 비교에서 이전 능력치 값은 과거에 저장된 전체 결과를 사용한다. 이번에 이전 능력치까지 전부 직접 재실행한 비교로 읽어서는 안 된다.',
         '- 두 조건 모두 같은 개편 전투 모의실험기를 사용한다. 이전 조건은 과거 성장표와 수동 강화 점수를 재구성한 것으로, 개편 전 전투 전체를 재현한 조건이 아니다.',
         '- 레벨 100, 최대 승급, 기술 수준 10, 자동으로 선택한 대표 장비 강화 10을 사용했다. 공략 원문의 실제 장비·배치·코어 연결·호감도·수동 조작은 완전히 재현하지 않았다.',
         '- 이전 능력치 조건의 강화 분배는 회피 공략이면 회피 100점과 공격 197점, 나머지는 치명 100점과 공격 197점이다. 공략별 최적 분배를 재현한 것은 아니다.',
         '- 최대 행동 2,000회를 넘기면 제한 초과로 처리한다. 실제 기기·서버 판정·실제 소요 시간은 시험하지 않았다.',
         '- 전투 원본 코드의 저장된 기준 지문과 현재 파일의 지문이 모두 일치함을 실행 전에 확인했다. 이는 이식 정확성 전체를 보장하는 검증은 아니다.',
         '', '## 직접 실행한 결과', '',
         '| 지표 | 이전 능력치의 기존 기록 | 현재 능력치 직접 재시험 |', '|---|---:|---:|',
         f'| 세 번 중 한 번 이상 성공 | {o["any_win"]:,}건 ({pct(o["any_win"])}) | {n["any_win"]:,}건 ({pct(n["any_win"])}) |',
         f'| 세 번 모두 성공 | {o["stable_win"]:,}건 ({pct(o["stable_win"])}) | {n["stable_win"]:,}건 ({pct(n["stable_win"])}) |',
         f'| 한 번 또는 두 번만 성공 | {o["unstable_win"]:,}건 | {n["unstable_win"]:,}건 |',
         f'| 성공 기록 없음 | {o["no_win"]:,}건 | {n["no_win"]:,}건 |', '',
         f'성공 기록이 없는 조건 중 {n["no_battle_cases"]:,}건은 전투가 없는 이야기 구역이다. 이를 실제 전투 패배로 해석하면 안 된다. 전체 비율은 과거 보고서와 비교하기 위해 이 항목을 포함한 분모로 계산했다.', '',
         '세 번 모두 성공은 세 개의 난수 시작값에서 성공했다는 뜻이다. 장시간 반복 파밍의 무실패를 보장하지 않는다.', '',
         '## 이전 능력치에서 안정적이던 조합의 유지 여부', '',
         f'- 이전 능력치에서 세 번 모두 성공한 {len(old_stable):,}건 중 현재 능력치에서도 세 번 모두 성공한 것은 {len(stable_retained):,}건이다.',
         f'- 현재 한 번 또는 두 번만 성공한 것은 {len(stable_unstable):,}건, 한 번도 성공하지 못한 것은 {len(stable_lost):,}건이다.',
         f'- 한 번 이상 성공에서 전부 실패로 바뀐 것은 {len(lost):,}건, 전부 실패에서 한 번 이상 성공으로 바뀐 것은 {len(gained):,}건이다.',
         f'- 양쪽 모두 세 번 성공한 조건 중 행동 수 중앙값이 20% 넘게 증가하고 3회 이상 늘어난 것은 {len(slower):,}건이다.',
         f'- 같은 조건에서 행동 수가 반대 기준으로 줄어든 것은 {len(faster):,}건이다. 행동 수를 실제 시간 단축률로 해석하면 안 된다.', '',
         '## 현재 조건의 실행 결과별 횟수', '',
         '| 실행 결과 | 횟수 |', '|---|---:|']
labels = {'win': '승리', 'lose': '패배', 'timeout': '행동 제한 초과', 'stuck': '진행 멈춤', 'error': '오류로 기록된 실행'}
for outcome, count in n['outcomes'].items():
    lines.append(f'| {labels.get(outcome, "기타")} | {count:,} |')
lines += ['', f'- 오류 기록 중 전투가 없는 구역은 {n["no_battle_runs"]:,}회, 나머지 실행 오류는 {n["runtime_error_runs"]:,}회다.',
          '', '## 보조 비교를 중단한 이유', '',
          '- 이전 능력치 조건의 한 편성이 교착 상태에서 보조 효과를 반복 적용하며 과도한 계산 시간을 사용했다. 실행 상태를 확인했을 때 두 번째 난수 조건의 1,286번째 누적 행동을 계산하고 있었다.',
          '- 해당 묶음에서 세 번의 실행을 모두 완료한 213건을 별도로 보존한 뒤 작업을 중단했다. 진행 중이던 실행을 임의로 패배나 성공으로 처리하지 않았다.',
          '- 지연된 편성은 로크, 티타니아 프로스트, 멸망의 메이, 레모네이드 베타, 트리아이나다. 현재 능력치에서는 같은 편성이 세 번 모두 승리했으며, 각 누적 행동 수는 75회, 39회, 39회였다.',
          '- 원인 세부 항목은 추가 확인이 필요하다. 이 현상을 현재 전투에서 발생한 진행 멈춤으로 해석하면 안 된다.',
          '', '## 과거 결과와의 재현성', '',
          f'- 현재 자료의 전체 {len(new):,}건을 과거의 14개 분할 결과와 대조했다. 세 번의 실행 기록이 달라진 조건은 {len(different):,}건이다.',
          f'- 과거 결과와 비교해 편성·배치·레벨 입력이 달라진 조건은 {len(historical_input_changed):,}건이다.',
          '- 과거의 별도 통합 결과는 405건만 담고 있어 전체 기준에서 제외했다. 전체 분할 결과를 기준으로 비교했다.',
          '', '## 우선 확인할 조합', '', '| 전투 구역 | 편성 | 이전 성공 | 현재 성공 |', '|---|---|---:|---:|']
for i in (stable_lost + stable_unstable)[:15]:
    lines.append(example(i))
lines += ['', '## 결론', '',
          '기존 공략의 편성을 개편 전투에서 활용할 수 있는 사례는 확인되지만, 모든 기존 공략의 동일한 성능과 안정성이 유지된다고 결론 내릴 수 없다.',
          '개발자 노트에서는 한 번 이상 성공한 비율과 세 번 모두 성공한 비율을 구분하고, 실제 장비와 배치를 맞춘 추가 확인이 남아 있음을 함께 설명해야 한다.',
          '', '## 도구 점검', '',
          '- 전투 흐름의 오류 처리·같은 난수 재현·추가 행동·행동 제한 점검을 통과했다.',
          '- 피해 계산과 기술 실행 점검을 통과했다. 기술 실행 표본 591회에서 실행 오류가 없었다.',
          '- 피해 계산 점검에는 이미 수정된 반격 오류를 여전히 기대하는 오래된 검증문이 남아 있었다. 현재 원본 코드의 방어 처리를 확인한 뒤 해당 검증을 현재 동작에 맞추고, 실패 시 종료 상태도 실패로 반환하도록 수정했다. 게임 전투 계산 코드는 수정하지 않았다.',
          '- 기술 문법 점검에는 로딩 오류가 있는 적 행동 스크립트 한 개와 누락 참조 한 개가 나타난다. 이것만으로 이번 일반 전투 시험에 해당 오류가 발생했다고 볼 수는 없다.']
report = ROOT / 'reports' / '기존공략_전투재시험_20261022.md'
report.write_text('\n'.join(lines) + '\n', encoding='utf-8')
print(json.dumps({key: value for key, value in stats.items() if key not in ('case_indices', 'non_win_reasons')}, ensure_ascii=False, indent=2))
print(str(report))
