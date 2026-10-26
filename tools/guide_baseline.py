"""Best community guide result per stage (guide-test-gear parts + one-character cell sweep) -> tools/out/guide-baseline.json.
"Best" = fewest total rounds (every unit's action, closest to the real clear time), then fewest of our actions.
Usage: python -I tools/guide_baseline.py"""
import glob, json, os

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'out')
R = []
for f in sorted(glob.glob(os.path.join(OUT, 'guide-test-gear.part*.json'))):
    R += json.load(open(f, encoding='utf-8'))['results']
names = json.load(open(os.path.join(OUT, 'pc-names.json'), encoding='utf-8'))
sweep_p = os.path.join(OUT, 'guide-solo-sweep.json')
sweep = json.load(open(sweep_p, encoding='utf-8')) if os.path.exists(sweep_p) else []
better = lambda a, b: (a['total'], a['pc']) < (b['total'], b['pc'])
base = {}
for r in R:
    w = [x for x in r['runs'] if x['outcome'] == 'win']
    if not w:
        continue
    cand = {'pc': min(x['pc'] for x in w), 'total': min(x['total'] for x in w), 'post': r['post'], 'title': r['title'],
            'squad': [{'key': q['key'], 'gridPos': q['gridPos']} for q in r['squad']], 'wins': len(w)}
    if r['stage'] not in base or better(cand, base[r['stage']]):
        base[r['stage']] = cand
for s in sweep:
    if not s['wins']:
        continue
    cand = {'pc': s['pc'], 'total': s['total'], 'post': s['post'], 'title': s['title'],
            'squad': [{'key': names[s['name']][0], 'gridPos': int(s['cell'].split()[-1]) - 1}], 'wins': s['wins']}
    if s['stage'] not in base or better(cand, base[s['stage']]):
        base[s['stage']] = cand
json.dump(base, open(os.path.join(OUT, 'guide-baseline.json'), 'w', encoding='utf-8'), ensure_ascii=False)
print('baseline stages', len(base))
