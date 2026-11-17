"""Who serves each point, from where the four players stand just before the first sound of it.

usage: serve.py <ident.json> <audio.json> <out.json>
The camera end is easy to read: when that pair serves, one of them stands at the net (a small box, feet high in the
picture) and the other at the back (a large box). When the far pair serves, both players of the camera end are at the back.
Then the server is the back player of the pair that serves, and the side is where that player stands.
"""
import sys, json, numpy as np
M = json.load(open(sys.argv[1])); A = json.load(open(sys.argv[2])); pairs = M['pairs']; BIN = M['bin']
by = {}
for s in M['sightings']: by.setdefault(s['t'], []).append(s)
T = np.array(sorted(by))
def team(k): return 0 if k in pairs[0] else 1
def depth(s):
    x0, y0, x1, y1 = s['box'][:4]; h = y1 - y0
    if s['zone'] == 'near': return 'net' if (y1 < 705 and h < 340) else ('back' if (h >= 400 or y1 >= 770) else 'mid')
    return 'net' if y1 >= 546 else ('back' if y1 <= 530 else 'mid')
hits = [t for t, s in A['hits']]; groups = []
for t in hits:
    if groups and t - groups[-1][-1] < 3.5: groups[-1].append(t)
    else: groups.append([t])
rows = []
for g in groups:
    t1 = g[0]; b = min(len(M['near_pair']) - 1, int(t1 // BIN))
    if not M['sure'][b]: continue
    nearT = M['near_pair'][b]; farT = 1 - nearT
    fr = [t for t in T if t1 - 4.2 <= t <= t1 - 0.15]
    vn = vf = 0; cand = {}
    for t in fr:
        S = by[t]; near = [s for s in S if s['zone'] == 'near']; far = [s for s in S if s['zone'] == 'far']
        dn = [depth(s) for s in near]; df = [depth(s) for s in far]
        if 'net' in dn and 'back' in dn:
            vn += 1
            for s in near:
                if depth(s) == 'back': cand.setdefault('near', []).append(s)
        elif 'net' not in dn and 'back' in dn and 'net' in df and 'back' in df:
            vf += 1
            for s in far:
                if depth(s) == 'back': cand.setdefault('far', []).append(s)
    if vn == vf: continue
    end = 'near' if vn > vf else 'far'; srvT = nearT if end == 'near' else farT; cs = cand.get(end, [])
    ids = [s['id'] for s in cs if s['id'] >= 0 and team(s['id']) == srvT]
    server = max(set(ids), key=ids.count) if ids else None
    xs = [(s['box'][0] + s['box'][2]) / 2 for s in cs if server is None or s['id'] == server]
    x = float(np.median(xs)) if xs else None
    side = None if x is None else (('R' if x > 960 else 'L') if end == 'near' else ('R' if x < 960 else 'L'))
    rows.append({'t': t1, 'n': len(g), 'last': g[-1], 'end': end, 'team': srvT, 'server': server, 'side': side, 'votes': [vn, vf]})
# one point can have two starts (a fault, then the second serve): same server side within 25 s, the first with one or two sounds
pts = []
for r in rows:
    if pts and r['team'] == pts[-1]['team'] and r['side'] == pts[-1]['side'] and r['t'] - pts[-1]['t'] < 25 and pts[-1]['n'] <= 2: pts[-1].update(n=pts[-1]['n'] + r['n'], last=r['last'])
    else: pts.append(dict(r))
json.dump(pts, open(sys.argv[3], 'w'))
print('sound groups', len(groups), 'with a clear formation', len(rows), 'points after joining faults', len(pts))
runs = []
for p in pts:
    if runs and runs[-1]['team'] == p['team']: runs[-1]['pts'].append(p)
    else: runs.append({'team': p['team'], 'pts': [p]})
print('runs of one serving pair:', len(runs))
for r in runs:
    ps = r['pts']; srv = [p['server'] for p in ps if p['server'] is not None]
    print(f"  {'AB'[r['team']]} {int(ps[0]['t'] // 60):2d}:{int(ps[0]['t'] % 60):02d}-{int(ps[-1]['t'] // 60):2d}:{int(ps[-1]['t'] % 60):02d}  points {len(ps):2d}  end {ps[0]['end']:4s}  servers {''.join(str(s) for s in srv) or '-':12s}  sides {''.join(p['side'] or '?' for p in ps)}")
