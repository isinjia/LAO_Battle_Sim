"""기본 전투원만 담은 연결 폴더 없는 독립 실행본을 만든다."""
from pathlib import Path
import json, re, shutil, urllib.request, subprocess, zipfile, os, sys

SRC = Path(__file__).resolve().parents[1]
OUT = SRC.parent / '전투실험_단독실행'
PCS = ['Char_BR_PA00EL_N', 'Char_BR_Amy_N', 'Char_PECS_MightyR_N', 'Char_3P_ConstantiaS2_N', 'Char_3P_Daphne_N']
MOBS = ['MOB_MP_NightChick_N', 'MOB_MP_BigChick_N', 'MOB_MP_Legion_N']
RIGS = ['pa00el', 'amy', 'mightyr', 'constantia', 'daphne']
ENEMY_RIGS = ['e_NightChick_N', 'e_BigChick_N', 'e_Legion_N']

def write(path, text):
    target = OUT / path
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(text, encoding='utf-8')

def dump(path, data):
    write(path, json.dumps(data, ensure_ascii=False, separators=(',', ':')))

def copy(source, target=None):
    dest = OUT / (target or source)
    dest.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(SRC / source, dest)

def build():
    # 빌드 결과 폴더를 무조건 지우거나 기존 사용자의 자료를 덮지 않는다.
    if OUT.exists() and '--refresh' not in sys.argv:
        raise SystemExit('출력 폴더가 이미 있습니다. 기존 자료를 보존하기 위해 중단합니다.')
    OUT.mkdir(exist_ok=True)
    for file in ['sandbox.html', 'sandbox-core.js', 'sandbox-panels.js', 'sandbox-scene.js', 'sandbox-sd.js', 'sandbox-ui.js', 'sandbox-wm.js', 'sandbox-help.js', 'sandbox-view.js', 'sd/sd.js']:
        copy(file)
    for file in (SRC / 'engine').glob('*.js'):
        copy(file.relative_to(SRC))
    for rig in RIGS:
        for suffix in ['.js', '.a50.webp']:
            copy('sd/chars/' + rig + suffix)
    for rig in ENEMY_RIGS:
        for suffix in ['.js', '.a50.webp']:
            copy('sd/mobs/' + rig + suffix)
    write('sd/chars/index.js', 'window.SD_LIST=' + json.dumps(RIGS) + ';')
    write('sd/charmap.js', 'window.SD_CHARMAP=' + json.dumps(dict(zip(PCS, RIGS))) + ';\nwindow.SD_MOBRIGS=' + json.dumps(ENEMY_RIGS) + ';')

    # 초기 전투원과 재귀적으로 참조하는 스킬·효과·규칙만 남긴다.
    data = {name: json.loads((SRC / ('data/' + name + '.json')).read_text(encoding='utf-8')) for name in ['units', 'skills', 'buffs', 'stages']}
    index = {}
    for group, tables in data.items():
        for table, rows in tables.items():
            for key, row in rows.items():
                index.setdefault(key, []).append((group, table, row))
    selected = {group: {table: {} for table in tables} for group, tables in data.items()}
    queue, visited = [], set()
    def add(group, table, key, row):
        token = (group, table, key)
        if token not in visited:
            visited.add(token); selected[group][table][key] = row; queue.append(row)
            if table == 'Table_Skill':
                for level_key, level_row in data['skills']['Table_SkillLevel'].items():
                    if level_key.startswith(key + '_Lv'): add('skills', 'Table_SkillLevel', level_key, level_row)
    for group, tables in data.items():
        for table, rows in tables.items():
            if group == 'units' and table not in ['Table_PC', 'Table_PCAbility', 'Table_PCPromotionBonus', 'Table_Monster', 'Table_MonsterAbility', 'Table_MonsterIW', 'Table_Summon', 'Table_SummonAbility', 'Table_CoreLink', 'Table_EquipSlot', 'Table_ItemEquip']:
                for key, row in rows.items(): add(group, table, key, row)
            elif table in ['Table_PC', 'Table_PCAbility', 'Table_PCPromotionBonus', 'Table_CoreLink', 'Table_EquipSlot']:
                for key, row in rows.items():
                    if key in PCS or any(key.startswith(pc + '_') for pc in PCS) or row.get('Promotion_PCKey') in PCS: add(group, table, key, row)
            elif table in ['Table_Monster', 'Table_MonsterAbility']:
                for key, row in rows.items():
                    if key in MOBS: add(group, table, key, row)
    def strings(value):
        if isinstance(value, str): yield value
        elif isinstance(value, dict):
            for v in value.values(): yield from strings(v)
        elif isinstance(value, list):
            for v in value: yield from strings(v)
    while queue:
        row = queue.pop()
        for value in strings(row):
            for key in [value] + re.findall(r'[A-Za-z][A-Za-z0-9_]*', value):
                for group, table, target in index.get(key, []):
                    if table in ['Table_PC', 'Table_Monster', 'Table_MonsterIW', 'Table_Summon', 'Table_SummonAbility', 'Table_ItemEquip'] and key not in PCS + MOBS: continue
                    add(group, table, key, target)
    for group, tables in selected.items(): dump('data/' + group + '.json', tables)
    for name in ['loc', 'lua']: copy('data/' + name + '.json')
    icons = json.loads((SRC / 'data/icons.json').read_text(encoding='utf-8'))
    keep = {'skill': set(selected['skills']['Table_Skill']), 'buff': set(selected['buffs']['Table_BuffEffect']), 'buffDesc': set(selected['buffs']['Table_BuffEffect']), 'pcTbar': set(PCS), 'mobTbar': set(MOBS), 'stageBG': set()}
    icons = {kind: {k: v for k, v in values.items() if k in keep.get(kind, set())} for kind, values in icons.items()}
    dump('data/icons.json', icons)

    for file in (SRC / 'ui').glob('*.json'): copy(file.relative_to(SRC))
    for file in (SRC / 'ui/sprites').glob('*.png'): copy(file.relative_to(SRC))
    for file in (SRC / 'ui/bg').glob('*.jpg'): copy(file.relative_to(SRC))
    skill_icons = set(icons['skill'].values()) | {'SkillIconCircle_Move', 'SkillIconCircle_Wait', 'SkillIconCircle_Move_active', 'SkillIconCircle_Wait_active', 'SkillIconCircle_None'}
    for icon in skill_icons:
        file = SRC / 'ui/skill' / (icon + '.png')
        if file.exists(): copy(file.relative_to(SRC))
    for icon in list(icons['pcTbar'].values()) + list(icons['mobTbar'].values()):
        file = SRC / 'ui/tbar' / (icon + '.png')
        if file.exists(): copy(file.relative_to(SRC))

    for url, filename in [('https://cdn.jsdelivr.net/npm/fengari-web@0.1.4/dist/fengari-web.js', 'fengari-web.js'), ('https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js', 'three.min.js')]:
        with urllib.request.urlopen(url, timeout=60) as response:
            target = OUT / 'vendor' / filename; target.parent.mkdir(exist_ok=True); target.write_bytes(response.read())
    for url, filename in [('https://cdn.jsdelivr.net/npm/fengari-web@0.1.4/LICENSE', 'fengari-web-license.txt'), ('https://cdn.jsdelivr.net/npm/three@0.128.0/LICENSE', 'three-license.txt')]:
        with urllib.request.urlopen(url, timeout=60) as response:
            (OUT / 'vendor' / filename).write_bytes(response.read())
    html = (OUT / 'sandbox.html').read_text(encoding='utf-8')
    html = re.sub(r'<link[^>]+fonts.googleapis.com[^>]*>\s*', '', html)
    html = html.replace('https://cdn.jsdelivr.net/npm/fengari-web@0.1.4/dist/fengari-web.js', 'vendor/fengari-web.js')
    write('sandbox.html', html)
    sd = (OUT / 'sandbox-sd.js').read_text(encoding='utf-8').replace('https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js', 'vendor/three.min.js')
    write('sandbox-sd.js', sd)
    core = (OUT / 'sandbox-core.js').read_text(encoding='utf-8')
    core = core.replace('lo-sandbox-setup-v2', 'lo-portable-setup-v1').replace('lo-sandbox-systems-v3', 'lo-portable-systems-v1').replace('lo-sandbox-verdicts-v1', 'lo-portable-verdicts-v1')
    write('sandbox-core.js', core)
    write('사용방법.txt', '전투 실험 시뮬레이터 독립 실행본\n\n실행.exe를 두 번 누르세요.\n폴더 전체를 다른 위치나 컴퓨터로 복사해 사용할 수 있습니다.\n윈도우와 최신 브라우저가 필요합니다. 인터넷 연결이나 별도 개발 도구 설치는 필요하지 않습니다.\n실행 안내창을 닫으면 종료됩니다.\n\n포함: 초기 아군 5명, 몬스터 3종, 배경과 화면 자료, 모든 실험 기능.\n다른 캐릭터 및 몬스터의 모델과 이미지 자료는 포함하지 않았습니다.\n')
    compiler = Path('C:/Windows/Microsoft.NET/Framework64/v4.0.30319/csc.exe')
    launcher = OUT / '실행.exe'
    launcher_source = SRC / 'tools/portable-launcher.cs'
    if not launcher.exists() or launcher.stat().st_mtime < launcher_source.stat().st_mtime:
        subprocess.run([str(compiler), '/nologo', '/target:winexe', '/reference:System.Windows.Forms.dll', '/out:' + str(launcher), str(launcher_source)], check=True)
    files = [p for p in OUT.rglob('*') if p.is_file() and p.suffix.lower() != '.zip']
    if any(os.lstat(p).st_file_attributes & 0x400 for p in OUT.rglob('*')): raise RuntimeError('외부 연결이 남아 있습니다.')
    archive = OUT.with_suffix('.zip')
    with zipfile.ZipFile(archive, 'w', zipfile.ZIP_DEFLATED) as z:
        for file in files: z.write(file, file.relative_to(OUT.parent))
    print(json.dumps({'folder': str(OUT), 'files': len(files), 'bytes': sum(p.stat().st_size for p in files), 'archiveBytes': archive.stat().st_size, 'pcs': len(selected['units']['Table_PC']), 'mobs': len(selected['units']['Table_Monster']), 'skills': len(selected['skills']['Table_Skill']), 'buffs': len(selected['buffs']['Table_BuffEffect'])}, ensure_ascii=False))

if __name__ == '__main__': build()
