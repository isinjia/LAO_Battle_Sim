# -*- coding: utf-8 -*-
"""시뮬레이터가 실제로 읽는 이미지 자료만 골라 저장소 안 폴더(sd/chars, sd/mobs, ui/skill, ui/tbar, ui/bg)에 복사한다.

예전에는 이 폴더들을 다른 프로젝트 폴더로 연결(junction)해 썼는데, 그러면 저장소와 배포본에 이미지가 빠진다.
이 스크립트는 연결 대상 폴더에서 필요한 파일만 복사해 실제 폴더로 만든다. 자료가 바뀌면 다시 실행하면 된다.

사용: python -I tools/collect_assets.py            (복사)
      python -I tools/collect_assets.py --dry-run  (무엇이 얼마나 복사될지 보기만)
"""
import json, os, re, shutil, sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DRY = '--dry-run' in sys.argv

def unity_project():
    f = ROOT / 'unity_project.txt'
    if f.exists():
        p = Path(f.read_text(encoding='utf-8').strip())
        if (p / 'Assets').exists():
            return p
    return ROOT.parent / '1_Onestre_QA'

PROJ = unity_project()
TEX = PROJ / 'Assets' / 'AssetBundleResource' / 'Texture'
# 자료 출처(연결 대상이었던 폴더). 환경이 다르면 여기만 고친다.
SOURCES = {
    'sd/chars': Path(r'E:\LAO_MINI_GAME\6_LAO_Laket_Monster\js\sd'),
    'sd/mobs': Path(r'E:\LAO_MINI_GAME\5_LAO_Defence\js\sd'),
    'ui/bg': Path(r'E:\LAO_MINI_GAME\6_LAO_Laket_Monster\assets\bg'),
    'ui/skill': TEX / 'SkillTexture',
    'ui/tbar': TEX / 'TbarIcon',
}

def js_list(path, var):
    m = re.search(var + r'\s*=\s*(\[.*?\]);', path.read_text(encoding='utf-8'), re.S)
    return json.loads(m.group(1)) if m else []

def needed():
    want = {}
    rigs = js_list(ROOT / 'sd' / 'chars' / 'index.js', 'SD_LIST')
    mobs = js_list(ROOT / 'sd' / 'charmap.js', 'SD_MOBRIGS')
    # http 로 읽을 때 쓰는 파일: 리그 자료 스크립트와 아틀라스 이미지. 시뮬레이터는 배율 1(a50)만 쓴다.
    want['sd/chars'] = ['index.js'] + [r + s for r in rigs for s in ('.js', '.a50.webp')]
    want['sd/mobs'] = [r + s for r in mobs for s in ('.js', '.a50.webp')]
    icons = json.loads((ROOT / 'data' / 'icons.json').read_text(encoding='utf-8'))
    skill = set(icons['skill'].values()) | {'SkillIconCircle_Wait', 'SkillIconCircle_Move', 'SkillIconCircle_None'}
    want['ui/skill'] = sorted(n + '.png' for n in skill if n)
    tbar = set(icons['pcTbar'].values()) | set(icons['mobTbar'].values())
    want['ui/tbar'] = sorted(n + '.png' for n in tbar if n)
    want['ui/bg'] = sorted(p.name for p in SOURCES['ui/bg'].glob('*.jpg')) if SOURCES['ui/bg'].exists() else []
    return want

def is_link(p):
    try:
        return p.is_symlink() or (p.exists() and os.path.islink(p)) or bool(os.lstat(p).st_file_attributes & 0x400)
    except (OSError, AttributeError):
        return False

def main():
    want = needed()
    total = 0
    for rel, names in want.items():
        src = SOURCES[rel]; dst = ROOT / rel
        if not src.exists():
            print(f'[{rel}] 출처 폴더가 없습니다: {src}'); continue
        files = [(src / n) for n in names if (src / n).exists()]
        missing = len(names) - len(files)
        size = sum(f.stat().st_size for f in files)
        total += size
        print(f'[{rel}] {len(files)}개 파일, {size / 1048576:.1f} MB' + (f' (출처에 없는 파일 {missing}개는 건너뜀)' if missing else ''))
        if DRY:
            continue
        if is_link(dst):
            # 연결 폴더는 연결만 끊는다(대상 폴더의 파일은 건드리지 않음)
            os.rmdir(dst) if os.name == 'nt' else dst.unlink()
        dst.mkdir(parents=True, exist_ok=True)
        keep = {f.name for f in files}
        for old in dst.iterdir():
            if old.is_file() and old.name not in keep and old.name != 'index.js':
                old.unlink()
        for f in files:
            t = dst / f.name
            if not t.exists() or t.stat().st_size != f.stat().st_size or int(t.stat().st_mtime) < int(f.stat().st_mtime):
                shutil.copy2(f, t)
    print(f'합계 {total / 1048576:.1f} MB' + (' (미리 보기만, 복사하지 않음)' if DRY else ''))

if __name__ == '__main__':
    main()
