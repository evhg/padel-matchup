"""Which detections are candidates for players: on the court, confident enough.

usage: cands.py <dets.jsonl> <keep.json> [max_frames]
"""
import sys, json, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from court import zone
dets, out = sys.argv[1], sys.argv[2]
mx = int(sys.argv[3]) if len(sys.argv) > 3 else 10 ** 9
keep, n, c = {}, 0, {'near': 0, 'far': 0, 'off': 0}
for line in open(dets):
    r = json.loads(line); n += 1
    if n > mx: break
    ks = []
    for i, b in enumerate(r['d']):
        if b[4] < 0.45: continue
        z = zone(b)
        c[z or 'off'] += 1
        if z: ks.append(i)
    if ks: keep[r['f']] = ks
json.dump(keep, open(out, 'w'))
print('frames', n, 'with candidates', len(keep), c)
