"""Per-character recommended stat-point builds (manual stat-point era) as a document.
Usage: python -I tools/make_stat_reco_report.py -> reports/전투원별_추천성장_r<rev>.md (then md2doku.py for DokuWiki)"""
import glob, json, os, statistics

HERE = os.path.dirname(os.path.abspath(__file__))
SIM = os.path.normpath(os.path.join(HERE, '..'))
OUT = os.path.join(HERE, 'out')
J = lambda *p: json.load(open(os.path.join(*p), encoding='utf-8'))
rev = J(SIM, 'data', 'meta.json').get('svnRevision', '')
R = J(OUT, 'stat-reco.json')
ROLE = {0: '보호기', 1: '공격기', 2: '지원기'}
CLS = {0: '경장', 1: '중장', 2: '기동'}
LBL = {'atk': '공격', 'def': '방어', 'hp': '체력', 'acc': '적중', 'eva': '회피', 'crit': '치명'}


def pts(p):
    return ' · '.join(f'{LBL[k]} {v}' for k, v in sorted(p.items(), key=lambda kv: -kv[1]) if v)


def tgt(t, rest):
    s = []
    if t.get('crit') is not None:
        s.append(f"치명 {t['crit']:.0f}%")
    if t.get('acc') is not None:
        s.append(f"적중 {t['acc']:.0f}%")
    if t.get('eva') is not None:
        s.append(f"회피 {t['eva']:.0f}%")
    s.append(f'나머지 {LBL[rest]}')
    return ', '.join(s)


def unmet(a):
    return ', '.join(LBL[x] for x in a['unmet'])


# validation (guide squads: recommended build A vs fixed split), if the runs exist
def load(pat):
    out = {}
    for f in sorted(glob.glob(os.path.join(OUT, pat))):
        for r in J(f)['results']:
            out[(r['post'], r['stage'])] = r
    return out


V_old, V_reco = load('guide-old-guide-test-gear.part*.json'), load('guide-reco-guide-test-gear.part*.json')

L = []
w = L.append
w('# 전투원별 추천 성장 (수동 스탯 분배 기준)')
w('')
w(f'- 기준: SVN r{rev}의 데이터와 **수동 스탯 분배 규칙**(r15485 능력치 계산·성장표)입니다.')
w('  - 레벨당 3점: Lv100 297점, Lv120 357점(상한 확장 360점)')
w('  - 1점당 공격 +1.5, 방어 +1.25, 체력 +8, 적중 +1.5%, 회피 +0.4%, 치명 +0.4%')
w('  - 항목별 상한: 치명·회피 100점, 적중 300점')
w(f'- 대상: 전투에 나가는 전투원 {len(R)}명. 커뮤니티 근거가 있는 {sum(1 for r in R if r["src"] == "community")}명은 공략 본문의 세팅을, 나머지는 같은 역할·계열 전투원들의 커뮤니티 세팅(중앙값)을 기본틀로 썼습니다.')
w('- 커뮤니티 근거: 아카라이브 라스트오리진 채널 공략 본문에서 "치명 100", "적중 225", "나머지 공격" 같은 세팅 지시를 뽑아, 전투원마다 여러 공략의 중앙값으로 정했습니다.')
w('')
w('## 읽는 법')
w('- **목표치:** 공략이 말하는 인게임 수치(장비·패시브 포함)입니다.')
w('- **포인트:** 그 목표치를 맞추는 데 필요한 분배입니다. 남는 점수는 "나머지" 능력치에 넣습니다.')
w('  - **대표 장비 기준:** 칸마다 공격·치명·적중·행동력 위주의 10강 장비를 낀 상태에서 계산했습니다. 장비가 목표치를 일부 채우므로 포인트가 덜 듭니다.')
w('  - **장비 없음 기준:** 포인트만으로 채울 때입니다. 상한 때문에 못 채우는 항목은 "장비로 채움"에 적었습니다.')
w('- **추천 B:** 커뮤니티에 뚜렷한 다른 용도가 있을 때(회피 빌드, 체력·방어 생존형)나 보호기의 대안일 때만 적었습니다.')
w('- 행동력은 포인트로 올릴 수 없어 장비로 맞춰야 합니다. 커뮤니티 공략의 목표 행동력이 있으면 비고에 적었습니다.')
w('')

if V_old and V_reco:
    pairs = [(k, V_old[k], V_reco[k]) for k in V_reco if k in V_old]
    win = lambda r: [x for x in r['runs'] if x['outcome'] == 'win']
    mid = lambda r: sorted(win(r), key=lambda x: (x['total'], x['pc']))[len(win(r)) // 2]['total'] if win(r) else None
    co = sum(1 for _, o, _r in pairs if win(o)); cr = sum(1 for _, _o, r in pairs if win(r))
    both = [(mid(o), mid(r)) for _, o, r in pairs if win(o) and win(r)]
    w('## 검증: 추천 분배로 커뮤니티 공략을 돌리면')
    w('')
    w(f'- 커뮤니티 공략 조합 {len(pairs):,}건을 수동 분배 시절 방식으로, 전원 **추천 A 분배**와 **단순 분배**(치명 100점 + 나머지 공격, 회피 빌드 공략은 회피 100점 + 나머지 공격)로 각각 돌렸습니다. 대표 장비, 같은 시드 3번입니다.')
    w('')
    w('| 항목 | 단순 분배 | 추천 A |')
    w('|---|---|---|')
    w(f'| 클리어 | {co:,}건 ({co * 100 // max(1, len(pairs))}%) | {cr:,}건 ({cr * 100 // max(1, len(pairs))}%) |')
    if both:
        ratio = statistics.median(b / a for a, b in both if a)
        faster = sum(1 for a, b in both if b < a * 0.9); slower = sum(1 for a, b in both if b > a * 1.1)
        w(f'| 둘 다 클리어한 {len(both):,}건의 전체 라운드 (추천/단순, 중앙값) | 1.00 | {ratio:.2f} |')
        w(f'| 10% 이상 빨라짐 / 느려짐 | | {faster}건 / {slower}건 |')
    w('')

for role in (1, 0, 2):
    rs = sorted([r for r in R if r['role'] == role], key=lambda r: (-r['n'], r['name']))
    w(f'## {ROLE[role]} ({len(rs)}명)')
    w('')
    w('| 전투원 | 계열 | 근거 | 추천 | 목표치 | Lv100 포인트 (대표 장비) | Lv100 포인트 (장비 없음) | 장비로 채움 | Lv120 포인트 (대표 장비) | 비고 |')
    w('|---|---|---|---|---|---|---|---|---|---|')
    for r in rs:
        src = f"커뮤니티 {r['n']}건" if r['src'] == 'community' else '역할 기본틀'
        note = []
        cm = r.get('community') or {}
        if cm.get('spd'):
            note.append(f"행동력 {cm['spd']:.2f}")
        if cm.get('noStat'):
            note.append(f"노스탯 공략 {cm['noStat']}건")
        for i, b in enumerate(r['builds']):
            l100, l120 = b['lv']['100'], b['lv']['120']
            w(f"| {r['name'] if i == 0 else ''} | {CLS.get(r['cls'], '') if i == 0 else ''} | {src if i == 0 else ''} | {'A ' if i == 0 else 'B '}{b['label']} | {tgt(b['targets'], b['rest'])} | {pts(l100['gear']['pts'])} | {pts(l100['noGear']['pts'])} | {unmet(l100['noGear']) or '-'} | {pts(l120['gear']['pts'])} | {', '.join(note) if i == 0 else ''} |")
    w('')

w('## 한계')
w('- **추출 한계:** 커뮤니티 목표치는 공략 본문에서 자동으로 뽑은 값입니다. 여러 명이 나오는 공략은 바로 앞에 쓰인 이름 기준으로 나눠, 일부는 다른 전투원의 수치가 섞였을 수 있습니다. 근거 공략이 적은 전투원은 직접 확인을 권합니다.')
w('- **목표치의 성격:** 공략 목표치는 파밍 공략 기준이라, 고난도 보스전에는 맞지 않을 수 있습니다.')
w('- **대표 장비 기준 포인트:** 대표 장비 기준 포인트는 실제 유저 장비와 다르면 달라집니다. 장비가 약하면 "장비 없음" 쪽에 가깝게 잡으세요.')
w('- **역할 기본틀:** 역할 기본틀로 만든 추천은 그 전투원의 스킬 특성(치명 보정, 적중 버프 등)을 반영하지 못합니다.')

os.makedirs(os.path.join(SIM, 'reports'), exist_ok=True)
p = os.path.join(SIM, 'reports', f'전투원별_추천성장_r{rev}.md')
open(p, 'w', encoding='utf-8').write('\n'.join(L) + '\n')
print(p)
