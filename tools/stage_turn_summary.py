"""Single-squad turn-mission run (stage-turn-test.json) -> stages over their limit (stage-turn-summary.json),
the input of stage_turn_search.js and make_qa_report.py. A turn = a main action (see stage_turn_test.js).
Usage: python -I tools/stage_turn_summary.py"""
import collections, json, os

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'out')
R = json.load(open(os.path.join(OUT, 'stage-turn-test.json'), encoding='utf-8'))['results']
nowin, pcfail, wavefail, totfail, special = [], [], [], [], []
for r in R:
    wins = [x for x in r['runs'] if x['outcome'] == 'win']
    if not wins:
        c = collections.Counter(x['outcome'] for x in r['runs']).most_common(1)[0][0]
        nowin.append((r['stage'], c, r['runs'][0].get('reason', '')[:70]))
        continue
    mn = {k: min(x[k] for x in wins) for k in ('total', 'wave', 'pc')}
    wv = wins[0]['waves']
    for m in r['missions']:
        rec = (r['stage'], m['type'], m['value'], mn['total'], mn['wave'], mn['pc'], wv, len(wins))
        if m['type'] == 'ROUND_LIMIT_LESS' or m['value'] != 30:
            special.append(rec)
            continue
        if mn['pc'] > m['value']:
            pcfail.append(rec)
        if mn['wave'] > m['value']:
            wavefail.append(rec)
        if mn['total'] > m['value']:
            totfail.append(rec)
json.dump({'nowin': nowin, 'pcfail': pcfail, 'wavefail': wavefail, 'totfail': totfail, 'special': special},
          open(os.path.join(OUT, 'stage-turn-summary.json'), 'w', encoding='utf-8'), ensure_ascii=False)
print('pcfail', len(pcfail), 'totfail', len(totfail), 'wavefail', len(wavefail), 'special', len(special), 'nowin', len(nowin))
