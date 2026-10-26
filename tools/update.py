"""Refresh the simulator from the Unity project and warn when ported battle code changed.

  python -I tools/update.py [UnityProjectFolder]      refresh data + enums, write data/meta.json
  python -I tools/update.py [folder] --mark-ported     record the current C# battle files as the ported baseline
                                                      (run only after engine/*.js has been re-ported to match them)

Tables (LoJson), Lua AI and enums are regenerated automatically. The battle engine (engine/*.js) is a hand port
of C# code, so changes there are only detected (by file hash against engine/port_info.json), never applied.
"""
import glob, hashlib, json, os, sqlite3, subprocess, sys, time

HERE = os.path.dirname(os.path.abspath(__file__))
SIM = os.path.normpath(os.path.join(HERE, '..'))
sys.path.insert(0, HERE)
import project_path

PORT_INFO = os.path.join(SIM, 'engine', 'port_info.json')
META = os.path.join(SIM, 'data', 'meta.json')

# C# files the engine was ported from (relative to the project's Assets folder)
TRACKED = [
    '_Scripts/Manager/BattleManager*.cs', '_Scripts/Manager/BattleRoundManager.cs',
    '_Scripts/CreatureBattle/Creature.cs', '_Scripts/CreatureBattle/Character.cs', '_Scripts/CreatureBattle/Enemy.cs',
    '_Scripts/CreatureBattle/Summon.cs', '_Scripts/CreatureBattle/Skill.cs', '_Scripts/CreatureBattle/CreatureSkill.cs',
    '_Scripts/CreatureBattle/CreatureAI.cs', '_Scripts/CreatureBattle/Buff.cs', '_Scripts/CreatureBattle/CreatureBuffEffect.cs',
    '_Scripts/CreatureBattle/CreatureSpecialPosition.cs', '_Scripts/CreatureBattle/InfiniteWar/*.cs',
    '_Scripts/Battle/LOEffect.cs', '_Scripts/Battle/BattleRoundEndChecker.cs', '_Scripts/Battle/FSMROUND/**/*.cs',
    '_Scripts/BTAI/**/*.cs', '_Scripts/Utils/ActorAttr.cs', '_Scripts/GlobalDefines.cs', '_Scripts/StageMap/StageMapData.cs',
    'Slua/LuaObject/Custom/Lua_CreatureAI.cs',
]


def tracked_files(proj):
    out = set()
    for pat in TRACKED:
        for f in glob.glob(os.path.join(proj, 'Assets', pat), recursive=True):
            out.add(os.path.relpath(f, os.path.join(proj, 'Assets')).replace('\\', '/'))
    return sorted(out)


def sha1(path):
    with open(path, 'rb') as f:
        return hashlib.sha1(f.read().replace(b'\r\n', b'\n')).hexdigest()


def svn_info(proj):
    """(working-copy revision, {Assets/... path: (changed_revision, author)}) from .svn/wc.db; ({}, None) if not SVN."""
    db = os.path.join(proj, '.svn', 'wc.db')
    if not os.path.isfile(db):
        return None, {}
    con = sqlite3.connect('file:' + db.replace('\\', '/') + '?mode=ro', uri=True)
    rev = con.execute('select max(revision) from nodes where op_depth=0').fetchone()[0]
    files = {r[0]: (r[1], r[2]) for r in con.execute(
        "select local_relpath, changed_revision, changed_author from nodes where op_depth=0 and kind='file' and local_relpath like 'Assets/%'")}
    con.close()
    return rev, files


def main():
    args = [a for a in sys.argv[1:] if not a.startswith('--')]
    proj = project_path.resolve(args[0] if args else None)
    project_path.save(proj)
    rev, svn_files = svn_info(proj)
    print(f'Unity project : {proj}')
    print(f'SVN revision  : {rev if rev else "(not an SVN working copy)"}')

    files = tracked_files(proj)
    hashes = {f: sha1(os.path.join(proj, 'Assets', f)) for f in files}

    if '--mark-ported' in sys.argv:
        json.dump({'revision': rev, 'markedAt': time.strftime('%Y-%m-%d %H:%M'), 'files': hashes},
                  open(PORT_INFO, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
        print(f'Baseline saved: {len(hashes)} battle files at r{rev} -> {PORT_INFO}')
        return

    py = sys.executable
    for script in ('extract_data.py', 'gen_enums.py'):
        print(f'\n> {script}')
        r = subprocess.run([py, '-I', os.path.join(HERE, script), proj])
        if r.returncode:
            sys.exit(f'{script} failed')

    base = json.load(open(PORT_INFO, encoding='utf-8')) if os.path.isfile(PORT_INFO) else {'revision': None, 'files': {}}
    changed = []
    for f in sorted(set(files) | set(base['files'])):
        old, new = base['files'].get(f), hashes.get(f)
        if old == new:
            continue
        state = 'added' if old is None else 'deleted' if new is None else 'modified'
        rv, author = svn_files.get('Assets/' + f, (None, None))
        changed.append({'file': f, 'state': state, 'revision': rv, 'author': author})

    meta = {'projectPath': proj, 'svnRevision': rev, 'extractedAt': time.strftime('%Y-%m-%d %H:%M'),
            'logicPortRevision': base.get('revision'), 'logicChanged': changed}
    json.dump(meta, open(META, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)

    print(f'\nData refreshed from r{rev}. Battle logic ported at r{base.get("revision")}.')
    if changed:
        print(f'\n!! {len(changed)} battle code file(s) changed since the port. The simulator still runs the OLD logic for these:')
        for c in changed:
            print(f'   {c["state"]:8} {c["file"]}' + (f'  (r{c["revision"]}, {c["author"]})' if c['revision'] else ''))
        print('   Ask Claude to re-port these changes into _BattleSim/engine, then run: python -I tools/update.py --mark-ported')
    else:
        print('Battle logic: no changes since the port.')


if __name__ == '__main__':
    main()
