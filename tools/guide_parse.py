"""Turns the crawled guide list (tools/out/guide-crawl.json) into stage + character candidates.
Usage: python -I tools/guide_parse.py  -> tools/out/guide-candidates.json
A guide title looks like "[거지런] [2-1EX] [2분 14초] [노링크] 에이다 1" or "[Ex 통합] [0:30] 페레그리누스":
bracket tags carry the stage and the clear time; the rest names the main characters ("A/B/C", trailing number = variant)."""
import json, os, re

HERE = os.path.dirname(os.path.abspath(__file__))
SIM = os.path.normpath(os.path.join(HERE, '..'))
OUT = os.path.join(HERE, 'out')
J = lambda *p: json.load(open(os.path.join(*p), encoding='utf-8'))

names = J(OUT, 'pc-names.json')                 # 한글 이름 -> [PC key]
stages = J(SIM, 'data', 'stages.json')['Table_MapStage']
loc = J(SIM, 'data', 'loc.json')
crawl = J(OUT, 'guide-crawl.json')

# community short names -> in-game names (extend as new ones show up)
ALIAS = {
    '페레': '페레그리누스', '무적의용': '무적의 용', '쉐이드': 'S12 쉐이드', '뽀끄루': '뽀끄루 대마왕', '싸프': '사이클롭스 프린세스',
    '사이클로스 프린세스': '사이클롭스 프린세스', '레모네이드': '레모네이드 알파', '레몬에이드': '레모네이드 알파',
    '마리아': '보속의 마리아', '메이': '멸망의 메이', '마리': '불굴의 마리', '레이스': 'AL 레이스', '엘븐': '엘븐 포레스트메이커',
    '포레스트': '엘븐 포레스트메이커', '레나': '레나 더 챔피언', '폴른': 'CT2199W 폴른', '티아맷': 'X-00 티아멧', '티아멧': 'X-00 티아멧',
    '잉글리시 셰퍼드': '잉글리쉬 셰퍼드', '프로스트 서번트': '프로스트 서펀트', '린티블룸': 'P-29 린트블룸', '스파르탄 캡틴': 'S25 스파르탄 캡틴',
    '스파르탄 어썰트': 'S25A 스파르탄 어썰트', '캡틴': 'S25 스파르탄 캡틴', '어썰트': 'S25A 스파르탄 어썰트', '무용': '무적의 용',
    'AGS 4기': None, 'AGS덱': None, '공격기': None,
}
norm = lambda s: re.sub(r'\s+', '', s).lower()
NM = {norm(k): v[0] for k, v in names.items()}


def find_pc(token):
    t = token.strip()
    t = t.split(' or ')[0]
    t = re.sub(r'\([^)]*\)?', '', t)                         # "(SS)", "(120렙)", "(캡틴" ...
    t = re.sub(r'\s*\d*\s*-\s*[A-Z]$', '', t)                # "-A", " 1 - A"
    t = re.sub(r'(SS|S)?승급$', '', t).strip()
    t = re.sub(r'^\d+-\d+\S*\s+', '', t)                     # leading stage tag left in the name
    t = re.sub(r'\s*\d+(-[A-Z])?$', '', t).strip()          # "에이다 1", "무적의용/마리아 3-A"
    if not t:
        return None, t
    full = ALIAS.get(t, t)
    if full is None:
        return None, t
    k = NM.get(norm(full))
    if k:
        return k, t
    cands = [v for n, v in NM.items() if norm(full) in n]   # partial name ("라비아타" -> "라비아타 프로토타입")
    if len(cands) == 1:
        return cands[0], t
    return None, t


IDX = {}
for k, r in stages.items():
    s = loc.get(r.get('StageIdxString', ''), '') or r.get('StageIdxString', '')
    if s:
        IDX.setdefault(s.upper(), []).append(k)


# event name (as written on the board) -> {part number: chapter prefix}; filled from the crawled event index pages
EVENT_MAP = json.load(open(os.path.join(OUT, 'event-map.json'), encoding='utf-8')) if os.path.exists(os.path.join(OUT, 'event-map.json')) else {}
SUF = {'EX': 'Ex', 'B': 'B', 'C': 'C', 'S': 'S', '': ''}


def expand(tag):
    """'3-1EX ~ 3-2EX' / '3-1EX/3-3EX' / '1-1~4B' / '2-5b' -> [(part, n, suffix)]"""
    t = tag.upper().replace(' ', '')
    out = []
    for piece in t.split('/'):
        m = re.match(r'^(\d+)-(\d+)(EX|B|C|S)?(?:~(?:(\d+)-)?(\d+)(EX|B|C|S)?)?$', piece)
        if not m:
            continue
        part, a, s1, part2, b, s2 = m.group(1), int(m.group(2)), m.group(3) or '', m.group(4), m.group(5), m.group(6) or ''
        suf = s1 or s2
        for n in range(a, int(b or a) + 1):
            out.append((int(part), n, suf))
    return out


def stage_keys(tag, label, event=None):
    keys = []
    for part, n, suf in expand(tag):
        if label == '메인' or (label == '챌린지' and not event):
            s = f'{part}-{n}{SUF[suf]}'.upper()
            keys += [k for k in IDX.get(s, []) if re.match(r'^Ch\d+(N\d+)?Stage', k)]
        elif event:
            pre = (EVENT_MAP.get(event) or {}).get(str(part))
            if pre:
                k = f'{pre}Stage{n:02d}{SUF[suf]}'
                if k in stages:
                    keys.append(k)
    return keys


nz = lambda s: re.sub(r'[\s!?~,.:·]', '', s or '').lower()
EV_ALIAS = {'장미': '연꽃 위에 피는 장미', '초코여왕': '이상한 나라의 초코여왕', '리오로보스의유산': '리오보로스의 유산', '바니니바': '영원한 겨울의 방주'}
EV_NAMES = sorted(EVENT_MAP, key=lambda n: -len(nz(n)))
PARENT = {}
for e in crawl:
    for t, cid in e.get('links') or []:
        PARENT.setdefault(int(cid), e['id'])
BYID = {e['id']: e for e in crawl}


def event_of(x):
    """event chapter family of a guide: walk up the index pages it was linked from and match an event name"""
    if x['label'] == '진행이벤트':
        return '오르카 AGS여 단결하라!'
    if x['label'] == '메인':
        return None
    cur, hops, texts = x['id'], 0, [x.get('title') or '', x.get('linkText') or '', (x.get('text') or '')[:200]]
    while cur in PARENT and hops < 6:
        cur = PARENT[cur]; hops += 1
        e = BYID.get(cur) or {}
        texts += [e.get('title') or '', e.get('linkText') or '']
    blob = nz(' '.join(texts))
    for n in EV_NAMES:
        if nz(n) in blob:
            return n
    for a, n in EV_ALIAS.items():
        if nz(a) in blob:
            return n
    return None


res = []
for x in crawl:
    if x.get('isIndex') or x.get('status'):
        continue
    title = x.get('linkText') or x.get('title') or ''
    tags = re.findall(r'\[([^\]]+)\]', title)
    rest = re.sub(r'\[[^\]]*\]', '', title).strip()
    stage_tag = next((t for t in tags if re.match(r'^\s*\d+-\d+', t)), '')
    time_tag = next((t for t in tags if re.search(r'\d+\s*[:분]', t) or '측정' in t), '')
    chars = []
    for tok in re.split(r'[/,+]', rest):
        k, raw = find_pc(tok)
        if raw:
            chars.append({'raw': raw, 'key': k})
    res.append({'id': x['id'], 'label': x['label'], 'path': x.get('path', ''), 'title': title, 'stageTag': stage_tag, 'time': time_tag,
                'event': event_of(x), 'stages': stage_keys(stage_tag, x['label'], event_of(x)) if stage_tag else [], 'chars': chars, 'imgs': x.get('imgs', 0), 'text': x.get('text', '')[:300]})
json.dump(res, open(os.path.join(OUT, 'guide-candidates.json'), 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
ok = [r for r in res if r['stages'] and r['chars'] and all(c['key'] for c in r['chars'])]
print('guides', len(res), 'with stage', sum(1 for r in res if r['stages']), 'fully resolved', len(ok))
unk = {}
for r in res:
    for c in r['chars']:
        if not c['key']:
            unk[c['raw']] = unk.get(c['raw'], 0) + 1
print('unresolved names', sorted(unk.items(), key=lambda x: -x[1])[:60])
