"""Community stat settings per character, from guide bodies (manual stat-point era).
Inputs: tools/out/guide-crawl.json (+ guide-bodies.json if present), guide-candidates.json, pc-names.json
Output: tools/out/stat-reco-community.json  {pcKey: {n, crit:[..], acc:[..], eva:[..], hp:[..], spd:[..], rest:{atk,hp,eva,def}, noStat, guides:[ids]}}
Targets are in-game values the guide asks for (gear and passives included), e.g. "치명 100", "적중 225", "회피 230".
Attribution: one-character guide -> that character; otherwise the nearest character name written before the number.
Usage: python -I tools/stat_reco_extract.py"""
import collections, json, os, re

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'out')
J = lambda n: json.load(open(os.path.join(OUT, n), encoding='utf-8'))
cand = {c['id']: c for c in J('guide-candidates.json')}
texts = {}
for x in J('guide-crawl.json'):
    if x.get('text'):
        texts[x['id']] = x['text']
if os.path.exists(os.path.join(OUT, 'guide-bodies.json')):
    for x in J('guide-bodies.json'):
        if x.get('status') == 200 and x.get('text'):
            texts[x['id']] = x['text']
names = J('pc-names.json')

# name patterns per character: in-game name, its parts, and the community short names used in titles
ALIAS = {}
for n, ks in names.items():
    k = ks[0]
    al = {n}
    parts = n.split()
    if len(parts) > 1 and len(parts[-1]) >= 2:
        al.add(parts[-1])
    ALIAS[k] = al
for c in cand.values():
    for ch in c['chars']:
        if ch['key'] and ch['raw'] and len(ch['raw']) >= 2:
            ALIAS[ch['key']].add(re.sub(r'\s*\d+$', '', ch['raw']))

STAT = [
    ('crit', r'(?:치명(?:타|률)?|치확|크리)\s*(?:컷|은|는|을|를|:)?\s*(\d{2,3}(?:\.\d)?)\s*(?:%|프로|퍼)?'),
    ('acc', r'(?:적중(?:률)?|명중)\s*(?:컷|은|는|을|를|:)?\s*(\d{2,3}(?:\.\d)?)\s*(?:%|프로|퍼)?'),
    ('eva', r'(?:회피(?:율)?)\s*(?:컷|은|는|을|를|:)?\s*(\d{2,3}(?:\.\d)?)\s*(?:%|프로|퍼)?'),
    ('spd', r'(?:행동력|행력|행동)\s*(?:컷|은|는|을|를|:)?\s*([3-6]\.\d{1,2})'),
    ('hp', r'(?:체력|HP|hp)\s*(?:컷|은|는|을|를|:)?\s*(\d{4,5})'),
]
REST = [('atk', r'나머지\s*(?:는|은)?\s*(?:전부|다|올|모두)?\s*공(?:격|격력)?|올공|공격력?\s*몰빵|공\s*몰빵'),
        ('hp', r'나머지\s*(?:는|은)?\s*(?:전부|다|올|모두)?\s*(?:체력|HP|hp)|체력\s*몰빵|올체'),
        ('eva', r'나머지\s*(?:는|은)?\s*(?:전부|다|올|모두)?\s*회피|올회피|회피\s*몰빵'),
        ('def', r'나머지\s*(?:는|은)?\s*(?:전부|다|올|모두)?\s*방어|방어\s*몰빵|올방')]
BOUNDS = {'crit': (20, 100), 'acc': (80, 400), 'eva': (20, 600), 'spd': (3.0, 6.5), 'hp': (1000, 30000)}

res = collections.defaultdict(lambda: {'n': 0, 'crit': [], 'acc': [], 'eva': [], 'spd': [], 'hp': [], 'rest': collections.Counter(), 'noStat': 0, 'guides': []})
for gid, t in texts.items():
    c = cand.get(gid)
    if not c:
        continue
    keys = [ch['key'] for ch in c['chars'] if ch['key']]
    keys = list(dict.fromkeys(keys))
    if not keys:
        continue
    # positions of character mentions in the body
    marks = []
    for k in keys:
        for a in ALIAS.get(k, ()):
            for m in re.finditer(re.escape(a), t):
                marks.append((m.start(), k))
    marks.sort()
    def owner(pos):
        if len(keys) == 1:
            return keys[0]
        o = None
        for p, k in marks:
            if p <= pos:
                o = k
            else:
                break
        return o
    seen = set()
    for stat, pat in STAT:
        for m in re.finditer(pat, t):
            v = float(m.group(1))
            lo, hi = BOUNDS[stat]
            if not (lo <= v <= hi):
                continue
            k = owner(m.start())
            if not k:
                continue
            res[k][stat].append(v)
            seen.add(k)
    for r, pat in REST:
        for m in re.finditer(pat, t):
            k = owner(m.start())
            if k:
                res[k]['rest'][r] += 1
                seen.add(k)
    for m in re.finditer(r'노\s*스[텟탯]', t):
        k = owner(m.start())
        if k:
            res[k]['noStat'] += 1
    for k in seen:
        res[k]['n'] += 1
        res[k]['guides'].append(gid)
out = {k: dict(v, rest=dict(v['rest'])) for k, v in res.items()}
json.dump(out, open(os.path.join(OUT, 'stat-reco-community.json'), 'w', encoding='utf-8'), ensure_ascii=False)
print('characters with community settings', len(out), 'with >=3 guides', sum(1 for v in out.values() if v['n'] >= 3))
