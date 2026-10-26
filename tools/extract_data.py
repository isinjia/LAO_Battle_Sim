"""Extract battle-relevant tables from Assets/LastOneTable/LoJson.js.bytes into _BattleSim/data/*.json.

Each output file is {TableName: {Key: row}} with display-only columns dropped.
Re-run after a table update:  python -I tools/extract_data.py [UnityProjectFolder]
(normally run through 업데이트.bat / tools/update.py)
"""
import json, os, re, glob, sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import project_path
PROJ = project_path.resolve(sys.argv[1] if len(sys.argv) > 1 else None)
OUT = os.path.join(HERE, '..', 'data')
os.makedirs(OUT, exist_ok=True)

d = json.load(open(os.path.join(PROJ, 'Assets', 'LastOneTable', 'LoJson.js.bytes'), encoding='utf-8-sig'))

DROP = re.compile(r'(_Desc(Option|Output)?$|^BuffIcon\d|^OutputFX$|^BFX_Location$|Img|Icon|Model|Fullbody|Voice|Lobby|Marriage|Story|Gift|Favor(Ratio)?$|Dialog|Record|Loading|Banner|Skin|Collection)')
KEEP_ALWAYS = {'Key', 'Name', 'StageName', 'SkillName', 'ItemName'}

def table(name, keep=None, drop_extra=()):
    rows = d.get(name, [])
    out = {}
    for r in rows:
        if keep:
            r = {k: v for k, v in r.items() if k in keep or k in KEEP_ALWAYS}
        else:
            r = {k: v for k, v in r.items() if k in KEEP_ALWAYS or not (DROP.search(k) or k in drop_extra)}
        # compact: drop default-valued columns; engine reads missing as 0 / '' (see engine/core.js num/str)
        out[r['Key']] = {k: v for k, v in r.items() if k == 'Key' or v not in (0, '', '0', [], ['0'], [''], None, '0.000000')}
    return out

def dump(fname, obj):
    p = os.path.join(OUT, fname)
    with open(p, 'w', encoding='utf-8') as f:
        json.dump(obj, f, ensure_ascii=False, separators=(',', ':'))
    print(f'{fname:24} {os.path.getsize(p) // 1024:6} KB')

STAGE_KEEP = None
stages = {
    'Table_MapStage': table('Table_MapStage'),
    'Table_MapStageEW': table('Table_MapStageEW'),
    'Table_MapStageIW': table('Table_MapStageIW'),
    'Table_MapChapter': table('Table_MapChapter'),
    'Table_MobGroup': table('Table_MobGroup', drop_extra=('Rank_A_Reward', 'Rank_B_Reward', 'Rank_S_Reward')),
    'Table_MobGroupIW': table('Table_MobGroupIW'),
    'Table_Anomaly': table('Table_Anomaly'),
}
units = {
    'Table_PC': table('Table_PC'),
    'Table_PCAbility': table('Table_PCAbility'),
    'Table_PCPromotionBonus': table('Table_PCPromotionBonus'),
    'Table_Monster': table('Table_Monster'),
    'Table_MonsterAbility': table('Table_MonsterAbility'),
    'Table_MonsterIW': table('Table_MonsterIW'),
    'Table_Summon': table('Table_Summon'),
    'Table_SummonAbility': table('Table_SummonAbility'),
    'Table_CoreLink': table('Table_CoreLink'),
    'Table_CoreLinkBonus': table('Table_CoreLinkBonus'),
    'Table_ItemEquip': table('Table_ItemEquip'),
    'Table_EquipSlot': table('Table_EquipSlot'),
    'Table_GlobalValue': table('Table_GlobalValue'),
    'Table_PCExp': table('Table_PCExp'),
}
skills = {
    'Table_SkillGroup': table('Table_SkillGroup'),
    'Table_Skill': table('Table_Skill'),
    'Table_SkillLevel': table('Table_SkillLevel'),
    'Table_Grid': table('Table_Grid'),
}
buffs = {'Table_BuffEffect': table('Table_BuffEffect')}

# Korean names for everything the UI shows
need = set()
for t in (stages, units, skills, buffs):
    for tab in t.values():
        for r in tab.values():
            for k in ('Name', 'StageName', 'SkillName', 'ItemName', 'ChapterName'):
                v = r.get(k)
                if isinstance(v, str) and v: need.add(v)
loc = {r['Key']: r['Korea'] for r in d['Table_Localization'] if r['Key'] in need and r.get('Korea')}

# Lua AI scripts (plain text in the editor; the bundle build encrypts them)
lua = {}
for f in glob.glob(os.path.join(PROJ, 'Assets', 'LuaAI', '*.lua.txt')):
    lua[os.path.basename(f)[:-len('.lua.txt')]] = open(f, encoding='utf-8-sig', errors='replace').read()

dump('stages.json', stages)
dump('units.json', units)
dump('skills.json', skills)
dump('buffs.json', buffs)
dump('loc.json', loc)
dump('lua.json', lua)
