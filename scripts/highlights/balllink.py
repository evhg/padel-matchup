"""Join the ball candidates of a clip into flights: smooth paths that only a thrown or hit ball makes.

usage: balllink.py <cand.npz> <out.npz>      (adds 'path' [frame: x, y, width or nan] and 'flights' to the candidates)
A flight ends where the ball changes its way suddenly: a racket, the floor, the glass. The place and the time where two
flights meet is a 'junction'. Clutter (arms, shoes, the next court) seldom makes six points in a row on one smooth curve.
"""
import sys, os, json, numpy as np
MAXSTEP, MINLEN = 230.0, 6
def fit(ts, ps, deg=2):
    ts = np.asarray(ts, float); ps = np.asarray(ps, float); d = min(deg, len(ts) - 1)
    return [np.polyfit(ts, ps[:, k], d) for k in (0, 1)]
def at(co, t): return np.array([np.polyval(co[0], t), np.polyval(co[1], t)])
def grow(C, seed, used):
    """seed: [(frame, index)] of three points. Extend both ways while the next point is where the curve says."""
    tr = list(seed)
    for direction in (1, -1):
        miss = 0
        while miss < 3:
            last = tr[-1] if direction == 1 else tr[0]
            f = last[0] + direction * (miss + 1)
            if f < 0 or f >= len(C): break
            tail = tr[-6:] if direction == 1 else tr[:6]
            ts = [p[0] for p in tail]; ps = [C[p[0], p[1], :2] for p in tail]
            co = fit(ts, ps, 2 if len(tail) >= 5 else 1); pred = at(co, f)
            v = np.linalg.norm(at(co, last[0]) - at(co, last[0] - direction)); tol = 4.0 + 0.16 * v + 2.0 * miss
            best = None
            for k in range(C.shape[1]):
                c = C[f, k]
                if not np.isfinite(c[0]): break
                if (f, k) in used: continue
                d = np.linalg.norm(c[:2] - pred)
                if d <= tol and (best is None or d < best[0]): best = (d, k)
            if best is None: miss += 1; continue
            if direction == 1: tr.append((f, best[1]))
            else: tr.insert(0, (f, best[1]))
            miss = 0
    return tr
def quality(C, tr):
    ts = np.array([p[0] for p in tr], float); ps = np.array([C[p[0], p[1], :2] for p in tr]); pk = np.array([C[p[0], p[1], 2] for p in tr])
    travel = np.linalg.norm(ps[-1] - ps[0]); span = ts[-1] - ts[0] + 1
    res = 0.0
    if len(tr) >= 4:
        co = fit(ts, ps, 2); res = float(np.sqrt(np.mean([np.sum((at(co, t) - p) ** 2) for t, p in zip(ts, ps)])))
    return {'n': len(tr), 'travel': float(travel), 'res': res, 'peak': float(np.median(pk)), 'fill': len(tr) / span, 'body': float(np.mean([C[p[0], p[1], 7] for p in tr]))}
def link(C):
    n, K = C.shape[:2]; seeds = []
    for i in range(n - 2):
        A = [(k, C[i, k]) for k in range(K) if np.isfinite(C[i, k, 0])]; B = [(k, C[i + 1, k]) for k in range(K) if np.isfinite(C[i + 1, k, 0])]
        D = [(k, C[i + 2, k]) for k in range(K) if np.isfinite(C[i + 2, k, 0])]
        for ka, a in A:
            for kb, b in B:
                v = b[:2] - a[:2]; s = np.linalg.norm(v)
                if s < 1.5 or s > MAXSTEP: continue
                pred = b[:2] + v
                for kd, d in D:
                    e = np.linalg.norm(d[:2] - pred)
                    if e <= 3.0 + 0.14 * s: seeds.append((e / (3.0 + 0.14 * s) - 0.002 * (a[2] + b[2] + d[2]), [(i, ka), (i + 1, kb), (i + 2, kd)]))
    seeds.sort(key=lambda s: s[0])
    used = set(); flights = []
    for _, sd in seeds:
        if any(p in used for p in sd): continue
        tr = grow(C, sd, used); q = quality(C, tr)
        if q['n'] < MINLEN or q['travel'] < 22 or q['res'] > 3.5 + 0.02 * q['travel'] or q['fill'] < 0.6: continue
        # an arm or a leg also moves on a smooth curve, but inside the moving body and not far
        if os.environ.get('NOBODY') != '1' and q['body'] > 0.55 and not (q['travel'] >= 110 and q['travel'] / q['n'] >= 9): continue
        for p in tr: used.add(p)
        flights.append((tr, q))
    return flights
if __name__ == '__main__':
    z = np.load(sys.argv[1]); C = z['cand']; fl = link(C)
    fl.sort(key=lambda f: f[0][0][0])
    path = np.full((len(C), 3), np.nan, np.float32); owner = np.full(len(C), -1)
    out = []
    # one ball: where two flights claim the same frame, the better one keeps it
    order = sorted(range(len(fl)), key=lambda j: -(fl[j][1]['n'] * fl[j][1]['peak']))
    for j in order:
        tr, q = fl[j]
        for f, k in tr:
            if owner[f] < 0: owner[f] = j; path[f] = [C[f, k, 0], C[f, k, 1], C[f, k, 5]]
    for j, (tr, q) in enumerate(fl):
        own = sum(1 for f, k in tr if owner[f] == j)
        out.append({'f0': int(tr[0][0]), 'f1': int(tr[-1][0]), 'pts': [[int(f), float(C[f, k, 0]), float(C[f, k, 1]), float(C[f, k, 5]), float(C[f, k, 2])] for f, k in tr], 'own': own, **q})
    np.savez_compressed(sys.argv[2], cand=C, t0=z['t0'], fps=z['fps'], path=path, flights=json.dumps(out))
    print('flights', len(out), 'frames with the ball', int(np.isfinite(path[:, 0]).sum()), 'of', len(C))
    for o in out: print(f"  {o['f0']:4d}-{o['f1']:4d} n {o['n']:3d} travel {o['travel']:6.0f} res {o['res']:.1f} peak {o['peak']:.0f} body {o['body']:.2f} own {o['own']}")
