"""Where is the Unity project? Resolution order:
  1. command-line argument passed to the calling script
  2. _BattleSim/unity_project.txt (one line: the project folder, saved by 업데이트.bat)
  3. the folder that contains _BattleSim (when _BattleSim sits inside the project)
A valid project has Assets/LastOneTable/LoJson.js.bytes."""
import os, sys

HERE = os.path.dirname(os.path.abspath(__file__))
SIM = os.path.normpath(os.path.join(HERE, '..'))
CONFIG = os.path.join(SIM, 'unity_project.txt')


def is_project(p):
    return bool(p) and os.path.isfile(os.path.join(p, 'Assets', 'LastOneTable', 'LoJson.js.bytes'))


def resolve(arg=None):
    cands = []
    if arg: cands.append(arg)
    if os.path.isfile(CONFIG):
        cands.append(open(CONFIG, encoding='utf-8-sig').read().strip().strip('"'))
    cands.append(os.path.normpath(os.path.join(SIM, '..')))
    for c in cands:
        if is_project(c):
            return os.path.normpath(c)
    sys.exit('Unity project not found. Tried: ' + ' | '.join(cands) +
             '\nPass the project folder (the one containing Assets) or put it in ' + CONFIG)


def save(p):
    with open(CONFIG, 'w', encoding='utf-8') as f:
        f.write(os.path.normpath(p) + '\n')
