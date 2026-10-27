"""NGUI 프리팹(Panel_StageBattle, UIBattleCreature, UICreatureInfo)을 위젯 목록 JSON으로 내보낸다.
각 위젯: 이름 경로, 설계 해상도(1920x1080, 원점 중앙, y 위) 기준 사각형 [l,b,r,t], 깊이, 종류(sprite/label/texture),
스프라이트 이름·분할 종류·색·채움, 글자·크기·정렬, 활성 여부. 앵커는 NGUI 규칙대로 풀어서 사각형에 반영한다.
필요한 스프라이트 중 ui/sprites 에 없는 것은 아틀라스에서 잘라 넣는다.
사용: python tools/export_ui.py
"""
import re, io, os, json, sys
PROJ = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..'))
if not os.path.isdir(os.path.join(PROJ, 'Assets')): PROJ = os.path.join(PROJ, '1_Onestre_QA')  # 시뮬레이터가 E:\LAO\LAO_Battle_Sim 에 있을 때 본편 프로젝트
ASSETS = os.path.join(PROJ, 'Assets', 'AssetBundleResource')
OUT = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'ui'))
SPR_DIR = os.path.join(OUT, 'sprites')
PREFABS = {
    'battle': 'UI/Panel_StageBattle.prefab',
    'tbar': 'UI/UIBattleCreature.prefab',
    'cinfo': 'UI/object/UICreatureInfo.prefab',
}
SCREEN = [-960.0, -540.0, 960.0, 540.0]  # l, b, r, t (UIRoot 1920x1080)
# 실행 중 트윈으로 옮겨지는 노드의 표시 상태(프리팹은 숨김 상태로 저장됨): 경로 끝 이름 -> (위치, 배율)
RUNTIME_POSE = {'UI_penel_bottom/wrapper': ([-152.0, 60.0], [1.0, 1.0])}
PIVOT = {0: (0, 1), 1: (0.5, 1), 2: (1, 1), 3: (0, 0.5), 4: (0.5, 0.5), 5: (1, 0.5), 6: (0, 0), 7: (0.5, 0), 8: (1, 0)}

def fnum(v, d=0.0):
    try: return float(v)
    except Exception: return d

def parse(path):
    s = io.open(path, encoding='utf-8', errors='replace').read().replace('\r\n', '\n')
    docs = re.split(r'--- !u!', s)
    go, tr, comps = {}, {}, {}
    for d in docs[1:]:
        m = re.match(r'(\d+) &(\d+)', d)
        if not m: continue
        cid, fid = m.group(1), m.group(2)
        if cid == '1':
            name = re.search(r'm_Name: (.*)', d); act = re.search(r'm_IsActive: (\d)', d)
            go[fid] = {'name': name.group(1).strip() if name else '?', 'active': (act.group(1) if act else '1') == '1'}
        elif cid == '4':
            g = re.search(r'm_GameObject: \{fileID: (\d+)\}', d); father = re.search(r'm_Father: \{fileID: (\d+)\}', d)
            lp = re.search(r'm_LocalPosition: \{x: ([-\d.e]+), y: ([-\d.e]+), z: ([-\d.e]+)\}', d)
            ls = re.search(r'm_LocalScale: \{x: ([-\d.e]+), y: ([-\d.e]+), z: ([-\d.e]+)\}', d)
            chs = d.split('m_Children:')[1].split('m_Father')[0] if 'm_Children:' in d else ''
            tr[fid] = {'go': g.group(1) if g else None, 'father': father.group(1) if father else '0',
                       'lp': [fnum(x) for x in lp.groups()] if lp else [0, 0, 0], 'ls': [fnum(x, 1) for x in ls.groups()] if ls else [1, 1, 1],
                       'ch': re.findall(r'- \{fileID: (\d+)\}', chs)}
        elif cid == '114':
            g = re.search(r'm_GameObject: \{fileID: (\d+)\}', d)
            if not g: continue
            c = {}
            for k in ['mWidth', 'mHeight', 'mDepth', 'mPivot', 'mType', 'mFillDirection', 'mFontSize', 'mAlignment', 'mOverflow', 'mFlip', 'keepAspectRatio', 'mClipping', 'maxLineCount', 'mEffectStyle']:
                mm = re.search(r'\b' + k + r': (-?\d+)', d)
                if mm: c[k] = int(mm.group(1))
            for k in ['mFillAmount', 'alpha', 'mEffectDistance']:
                mm = re.search(r'\b' + k + r': ([-\d.e]+)', d)
                if mm: c[k] = fnum(mm.group(1), 1)
            mm = re.search(r'mSpriteName: (.*)', d)
            if mm: c['sprite'] = mm.group(1).strip()
            mm = re.search(r'mText: (.*)', d)
            if mm:
                t = mm.group(1).strip()
                if t.startswith('"') or t.startswith("'"):
                    try: t = json.loads(t) if t.startswith('"') else t[1:-1]
                    except Exception: t = t.strip('"\'')
                c['text'] = t
            mm = re.search(r'mColor: \{r: ([\d.e-]+), g: ([\d.e-]+), b: ([\d.e-]+), a: ([\d.e-]+)\}', d)
            if mm: c['color'] = [round(fnum(x, 1), 4) for x in mm.groups()]
            mm = re.search(r'mEffectColor: \{r: ([\d.e-]+), g: ([\d.e-]+), b: ([\d.e-]+), a: ([\d.e-]+)\}', d)
            if mm: c['effectColor'] = [round(fnum(x, 1), 4) for x in mm.groups()]
            mm = re.search(r'mAtlas: \{fileID: \d+, guid: ([0-9a-f]+)', d)
            if mm: c['atlas'] = mm.group(1)
            mm = re.search(r'mTexture: \{fileID: \d+, guid: ([0-9a-f]+)', d)
            if mm: c['texture'] = mm.group(1)
            mm = re.search(r'mMat: \{fileID: \d+, guid: ([0-9a-f]+)', d)
            if mm: c['mat'] = mm.group(1)
            anchors = {}
            for side in ['leftAnchor', 'rightAnchor', 'bottomAnchor', 'topAnchor']:
                am = re.search(side + r':\n\s*target: \{fileID: (\d+)\}\n\s*relative: ([-\d.e]+)\n\s*absolute: (-?\d+)', d)
                if am and am.group(1) != '0': anchors[side[0]] = [am.group(1), fnum(am.group(2)), int(am.group(3))]
            if anchors: c['anchors'] = anchors
            # 종류 판별
            if 'sprite' in c and 'mWidth' in c: c['kind'] = 'sprite'
            elif 'text' in c or 'mFontSize' in c: c['kind'] = 'label'
            elif 'texture' in c or ('mWidth' in c and 'mClipping' not in c and 'mPivot' in c and 'sprite' not in c): c['kind'] = 'texture'
            elif 'mClipping' in c: c['kind'] = 'panel'
            else: continue
            comps.setdefault(g.group(1), []).append(c)
    return go, tr, comps

def export(key, rel):
    go, tr, comps = parse(os.path.join(ASSETS, rel))
    byGo = {t['go']: fid for fid, t in tr.items()}
    roots = [fid for fid, t in tr.items() if t['father'] not in tr]
    world = {}  # fid -> (x, y, sx, sy)
    def walk(fid, px, py, psx, psy, path, active):
        t = tr[fid]; g = go.get(t['go'], {'name': '?', 'active': True})
        p = (path + '/' if path else '') + g['name']
        lp, ls = t['lp'], t['ls']
        for k, (rp, rs) in RUNTIME_POSE.items():
            if p.endswith(k): lp = [rp[0], rp[1], 0]; ls = [rs[0], rs[1], 1]
        x = px + lp[0] * psx; y = py + lp[1] * psy
        sx = psx * ls[0]; sy = psy * ls[1]
        act = active and g['active']
        world[fid] = {'x': x, 'y': y, 'sx': sx, 'sy': sy, 'path': p, 'active': act, 'name': g['name']}
        for c in t['ch']:
            if c in tr: walk(c, x, y, sx, sy, p, act)
    for r in roots: walk(r, 0, 0, 1, 1, '', True)
    rootT = roots[0]
    widgets = []
    for fid, w in world.items():
        for c in comps.get(tr[fid]['go'], []):
            if c.get('kind') == 'panel': continue
            widgets.append(dict(c, fid=fid, path=w['path'], name=w['name'], active=w['active'], x=w['x'], y=w['y'], sx=w['sx'], sy=w['sy']))
    # 사각형 계산 (앵커 없음)
    def base_rect(wd):
        pw, ph = PIVOT.get(wd.get('mPivot', 4), (0.5, 0.5))
        W = wd.get('mWidth', 0) * wd['sx']; H = wd.get('mHeight', 0) * wd['sy']
        l = wd['x'] - W * pw; b = wd['y'] - H * ph
        return [l, b, l + W, b + H]
    rect = {}
    for wd in widgets: rect[wd['fid']] = base_rect(wd)
    byFid = {wd['fid']: wd for wd in widgets}
    def sides_of(target_fid):
        if target_fid == rootT: return SCREEN  # 루트 패널 = 화면
        if target_fid in rect: return rect[target_fid]
        if target_fid in world: w = world[target_fid]; return [w['x'], w['y'], w['x'], w['y']]
        return SCREEN
    # 앵커 풀기: 부모부터 차례로. 앵커로 위젯이 옮겨지면 자손 트랜스폼도 같이 옮긴다(NGUI 는 트랜스폼 위치를 바꾼다)
    widgets.sort(key=lambda wd: wd['path'].count('/'))
    for _ in range(3):
        for wd in widgets:
            an = wd.get('anchors')
            if not an: continue
            r = list(rect[wd['fid']])
            for side, i, axis in [('l', 0, 0), ('r', 2, 0), ('b', 1, 1), ('t', 3, 1)]:
                if side not in an: continue
                tfid, relv, absv = an[side]
                ts = sides_of(tfid)
                if axis == 0: r[i] = ts[0] + (ts[2] - ts[0]) * relv + absv * wd['sx']
                else: r[i] = ts[1] + (ts[3] - ts[1]) * relv + absv * wd['sy']
            pw, ph = PIVOT.get(wd.get('mPivot', 4), (0.5, 0.5))
            nx = r[0] + (r[2] - r[0]) * pw; ny = r[1] + (r[3] - r[1]) * ph
            dx, dy = nx - wd['x'], ny - wd['y']
            rect[wd['fid']] = r
            if abs(dx) > 1e-6 or abs(dy) > 1e-6:
                wd['x'], wd['y'] = nx, ny
                prefix = wd['path'] + '/'
                for f2, w2 in world.items():
                    if w2['path'].startswith(prefix):
                        w2['x'] += dx; w2['y'] += dy
                        if f2 in rect:
                            rr = rect[f2]; rect[f2] = [rr[0] + dx, rr[1] + dy, rr[2] + dx, rr[3] + dy]
                        for wd2 in byFid.values():
                            if wd2['fid'] == f2: wd2['x'] += dx; wd2['y'] += dy
                world[wd['fid']]['x'], world[wd['fid']]['y'] = nx, ny
    out = []
    for fid, w in world.items():  # 위젯 없는 노드(기준점 용)
        if not any(c.get('kind') not in (None, 'panel') for c in comps.get(tr[fid]['go'], [])):
            out.append({'path': w['path'], 'name': w['name'], 'kind': 'node', 'active': w['active'], 'rect': [round(w['x'], 1), round(w['y'], 1), round(w['x'], 1), round(w['y'], 1)], 'depth': -999, 'scale': [round(w['sx'], 4), round(w['sy'], 4)]})
    for wd in widgets:
        r = rect[wd['fid']]
        o = {'path': wd['path'], 'name': wd['name'], 'kind': wd['kind'], 'active': wd['active'], 'rect': [round(v, 1) for v in r], 'depth': wd.get('mDepth', 0),
             'pivot': wd.get('mPivot', 4), 'scale': [round(wd['sx'], 4), round(wd['sy'], 4)]}
        for k, nk in [('sprite', 'sprite'), ('mType', 'type'), ('mFillDirection', 'fillDir'), ('mFillAmount', 'fill'), ('mFlip', 'flip'), ('color', 'color'), ('text', 'text'), ('mFontSize', 'fontSize'), ('mAlignment', 'align'), ('mOverflow', 'overflow'), ('effectColor', 'effectColor'), ('mEffectStyle', 'effect'), ('texture', 'texture'), ('atlas', 'atlas'), ('mWidth', 'w'), ('mHeight', 'h')]:
            if k in wd: o[nk] = wd[k]
        out.append(o)
    out.sort(key=lambda o: o['depth'])
    return out

def main():
    global SCREEN
    for width in [1920, 2340, 2400]:
        SCREEN = [-width / 2.0, -540.0, width / 2.0, 540.0]
        data = {}
        for key, rel in PREFABS.items():
            data[key] = export(key, rel)
        json.dump(data, io.open(os.path.join(OUT, 'layout_%d.json' % width), 'w', encoding='utf-8'), ensure_ascii=False)
        print(width, {k: len(v) for k, v in data.items()})
    # 빠진 스프라이트 잘라내기
    need = set(o['sprite'] for d in data.values() for o in d if o.get('sprite'))
    have = set(f[:-4] for f in os.listdir(SPR_DIR) if f.endswith('.png'))
    missing = sorted(n for n in need if n.replace(' ', '_') not in have)
    print('missing sprites', len(missing), missing[:40])
    if missing:
        try:
            from PIL import Image
        except Exception:
            print('PIL 없음'); return
        atlas_dir = os.path.join(ASSETS, 'Atlas')
        info = {}
        if os.path.exists(os.path.join(OUT, 'sprites.json')): info = json.load(io.open(os.path.join(OUT, 'sprites.json'), encoding='utf-8'))
        for name in os.listdir(atlas_dir):
            if not name.endswith('.prefab'): continue
            s = io.open(os.path.join(atlas_dir, name), encoding='utf-8', errors='replace').read()
            mat = re.search(r'material: \{fileID: \d+, guid: ([0-9a-f]+)', s)
            png = None
            if mat:
                for mf in os.listdir(atlas_dir):
                    if mf.endswith('.mat.meta') and ('guid: ' + mat.group(1)) in io.open(os.path.join(atlas_dir, mf), encoding='utf-8', errors='replace').read():
                        ms = io.open(os.path.join(atlas_dir, mf[:-5]), encoding='utf-8', errors='replace').read()
                        tg = re.search(r'm_Texture: \{fileID: 2800000, guid: ([0-9a-f]+)', ms)
                        if tg:
                            for pf in os.listdir(atlas_dir):
                                if pf.endswith('.png.meta') and ('guid: ' + tg.group(1)) in io.open(os.path.join(atlas_dir, pf), encoding='utf-8', errors='replace').read():
                                    png = os.path.join(atlas_dir, pf[:-5]); break
            if not png: continue
            im = None
            for m in re.finditer(r'- name: (.*)\n\s*x: (\d+)\n\s*y: (\d+)\n\s*width: (\d+)\n\s*height: (\d+)\n\s*borderLeft: (\d+)\n\s*borderRight: (\d+)\n\s*borderTop: (\d+)\n\s*borderBottom: (\d+)', s):
                nm = m.group(1).strip()
                if nm not in missing: continue
                if im is None: im = Image.open(png).convert('RGBA')
                x, y, w, h, l, r, t, b = map(int, m.groups()[1:])
                if x + w > im.width or y + h > im.height: continue
                im.crop((x, y, x + w, y + h)).save(os.path.join(SPR_DIR, nm.replace(' ', '_') + '.png'))
                info[nm.replace(' ', '_')] = {'w': w, 'h': h, 'b': [l, t, r, b]}
                missing.remove(nm); print('  cropped', nm, 'from', name)
        json.dump(info, io.open(os.path.join(OUT, 'sprites.json'), 'w', encoding='utf-8'))
        print('still missing', missing)

if __name__ == '__main__':
    main()
