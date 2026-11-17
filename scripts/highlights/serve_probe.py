"""A first test of one score signal: which team serves each point, from where the players stand before it.
usage: serve_probe.py <ident.json> <audio.json>
The partner of the server stands at the net. At the camera end that is easy to see: feet high in the picture, a small box."""
import sys, json, numpy as np
M = json.load(open(sys.argv[1])); A = json.load(open(sys.argv[2])); pairs = M['pairs']; BIN = M['bin']
by = {}
for s in M['sightings']:
    if s['id'] >= 0 and s['conf'] >= 0.5: by.setdefault(round(s['t']), {})[s['id']] = s
def team(k): return 0 if k in pairs[0] else 1
rows = []
for p in A['points']:
    t = p['firstHit']; b = min(len(M['near_pair']) - 1, int(t // BIN))
    if not M['sure'][b]: continue
    nearT = M['near_pair'][b]; net = {0: [], 1: []}; back = {0: [], 1: []}; who_back = {}
    for u in range(int(t) - 6, int(t)):
        for k, s in by.get(u, {}).items():
            x0, y0, x1, y1 = s['box'][:4]; h = y1 - y0; T = team(k)
            if s['zone'] == 'near':
                if y1 < 700 and h < 330: net[T].append(k)
                elif y1 > 780 or h > 420: back[T].append(k); who_back.setdefault(k, []).append((x0 + x1) / 2)
            else:
                if y1 >= 545: net[T].append(k)
                elif y1 <= 524: back[T].append(k); who_back.setdefault(k, []).append((x0 + x1) / 2)
    farT = 1 - nearT
    # votes: a team with a player at the net and a player at the back is the team that serves
    sn = (len(net[nearT]) >= 2) + (len(back[nearT]) >= 1); sf = (len(net[farT]) >= 2) + (len(back[farT]) >= 1)
    nn, nf = len(net[nearT]), len(net[farT])
    if nn >= 2 and nn > nf: srv = nearT
    elif nf >= 2 and nf > nn: srv = farT
    elif nn >= 2 and nf >= 2: srv = nearT if nn >= nf else farT
    else: srv = None
    server = None
    if srv is not None:
        c = [k for k in who_back if team(k) == srv and len(who_back[k]) >= 2 and k not in net[srv][:1]]
        if c: server = max(c, key=lambda k: len(who_back[k]))
    rows.append((t, p['hits'], nearT, srv, server, nn, nf))
names = {k: f'p{k}' for k in range(4)}
seq = ''.join('?' if r[3] is None else 'AB'[r[3]] for r in rows)
print('serving team by point (A = the first pair, B = the second pair, ? = not seen):'); print(seq)
print('servers:', ' '.join('--' if r[4] is None else names[r[4]] for r in rows))
runs = []; 
for r in rows:
    if r[3] is None: continue
    if runs and runs[-1][0] == r[3]: runs[-1][1] += 1; runs[-1][3] = r[0]
    else: runs.append([r[3], 1, r[0], r[0]])
print('runs of one serving team:', len(runs)); print(' '.join(f"{'AB'[a]}{n}@{int(t0 // 60)}" for a, n, t0, t1 in runs))
print('points with a serving team:', sum(1 for r in rows if r[3] is not None), 'of', len(rows))
