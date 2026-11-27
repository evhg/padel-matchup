"""How the four players react in the 8 s after a point: votes for winner.py (improvement 1 of the Mac lab, issue 374).

usage: react.py feats <walk dir of walk_mps.py> <ident.json> <feats.json of winner.py> <out feats.json>
       react.py ends <walk dir> <ident.json> <engine.json>      (the change of ends, against the count)

Each point of winner.py's feats file gets more votes (+1: pair 0 won, -1: pair 1 won, 0: no evidence) from the
people of walk_mps.py (ten pictures a second, from 1.5 s before the dead ball to 8 s after it, or to 1.5 s before the
next serve). The half of the court is a pair through ident.json's near pair, as in winner.py. Each vote says which
pair does MORE of a thing; `winner.py fit` gives it its weight and its sign (on the sets it is fitted on only):
  away8     the pair whose mean distance from the net grows more (from the last second of play to the 8 s after)
  close8    the pair whose two players come closer together (the smallest distance between them after the point)
  meet8     the pair whose two players meet (closer than 1.2 m) at any moment after the point
  arms8     the pair with more pictures of a wrist above the head (a raised arm, a racket up)
  head8     the pair with more pictures of a dropped head (the nose at the height of the shoulders or lower)
  turn8     the pair that shows the camera its back less: near players face away from the camera in play, far
            players face it; this counts the pictures of a player who faces away from the net
  still8    the pair that moves less (the sum of the steps of its players' feet on the floor)
  net8      the pair that walks to the net: the smallest distance of a player of the pair to the net after the point
A side change (`ends`): two or more walks over the net line after the point. Measured on match2 it finds none of the 14
changes of ends: the next serve comes 14 to 100 s after such a point, and the walk is later than the 8 s of walk_mps.py.
ident.json already knows the ends (its near pair, every 20 s), so this is not a vote.

Measured on match2 (27 November 2026, fitted on sets 1 and 2, the 51 held-back points of winner.py): the six votes of
winner.py with away8, close8, meet8 and head8 give 33 of 51 (65%; the six alone 31, 61%). README, "Who won the point".
"""
import json, math, os, sys
import numpy as np
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
NET_Y = 10.0
VOTES8 = ('away8', 'close8', 'meet8', 'arms8', 'head8', 'turn8', 'still8', 'net8')
# COCO key points
NOSE, LEYE, REYE, LSH, RSH, LWR, RWR, LHIP, RHIP, LAN, RAN = 0, 1, 2, 5, 6, 9, 10, 11, 12, 15, 16


def pose(kp):
    """Facts of one body from its 17 key points (picture space): arm up, head down, facing the camera."""
    k = np.asarray(kp, float); c = k[:, 2]; ok = lambda *i: all(c[j] > 0.4 for j in i)
    out = {'arm': None, 'head': None, 'face': None}
    if ok(LSH, RSH, LHIP, RHIP):
        sh = k[[LSH, RSH], 1].mean(); hp = k[[LHIP, RHIP], 1].mean(); torso = max(hp - sh, 1.0)
        top = k[NOSE, 1] if ok(NOSE) else sh - 0.35 * torso
        w = [k[j, 1] for j in (LWR, RWR) if c[j] > 0.4]
        if w: out['arm'] = bool(min(w) < top - 0.15 * torso)
        if ok(NOSE): out['head'] = bool(k[NOSE, 1] > sh - 0.12 * torso)
        # the face: the nose and both eyes seen well -> the body faces the camera
        out['face'] = bool(c[NOSE] > 0.6 and c[LEYE] > 0.5 and c[REYE] > 0.5)
    return out


def sightings(walk, place):
    """[(t, half, (x, y) on the floor, pose facts)] of every person of a walk file."""
    out = []
    for f in walk['frames']:
        for p in f['people']:
            q = place(p['kp'])
            if q is None: continue
            out.append((f['t'], p['zone'], (q[0], q[1]), pose(p['kp'])))
    return out


def votes(S, dead, until, near_pair):
    """The votes of one point from its sightings. Pure."""
    pair = lambda h: near_pair if h == 'near' else 1 - near_pair
    v = {k: 0 for k in VOTES8}
    if until <= dead + 1.0: return v
    pre = [s for s in S if dead - 1.0 <= s[0] <= dead + 0.3]
    post = [s for s in S if dead + 0.5 <= s[0] <= until]
    if not post: return v
    by = {0: [], 1: []}
    for s in post: by[pair(s[1])].append(s)
    def more(f, less=False, eps=1e-9):
        """+1/-1 for the pair with the larger value of f(pair) (both must have a value)."""
        a, b = f(0), f(1)
        if a is None or b is None or abs(a - b) <= eps: return 0
        return (1 if a > b else -1) * (-1 if less else 1)
    def mean_net(ss): return float(np.mean([abs(s[2][1] - NET_Y) for s in ss])) if ss else None
    def away(pr):
        a = mean_net([s for s in pre if pair(s[1]) == pr]); b = mean_net(by[pr])
        return None if a is None or b is None else b - a
    v['away8'] = more(away)
    def pairdist(pr):
        """The smallest distance between two people of the pair's half seen in the same picture."""
        t = {}
        for s in by[pr]: t.setdefault(s[0], []).append(s[2])
        ds = [math.dist(a, b) for ps in t.values() if len(ps) >= 2 for i, a in enumerate(ps) for b in ps[i + 1:]]
        return min(ds) if ds else None
    v['close8'] = more(pairdist, less=True)
    v['meet8'] = more(lambda pr: (1.0 if (pairdist(pr) or 99) < 1.2 else 0.0) if pairdist(pr) is not None else None)
    def frac(key, want=True, ss=None):
        def f(pr):
            xs = [s[3][key] for s in (ss or by)[pr] if s[3][key] is not None]
            return (sum(1 for x in xs if x == want) / len(xs)) if len(xs) >= 5 else None
        return f
    early = {pr: [s for s in by[pr] if s[0] <= dead + 4.0] for pr in (0, 1)}
    v['arms8'] = more(frac('arm', ss=early))
    v['head8'] = more(frac('head', ss=early))
    def turned(pr):
        xs = [(s[3]['face'] if s[1] == 'near' else not s[3]['face']) for s in early[pr] if s[3]['face'] is not None]
        return (sum(xs) / len(xs)) if len(xs) >= 5 else None
    v['turn8'] = more(turned)
    def moved(pr):
        t = {}
        for s in by[pr]: t.setdefault(round(s[0], 2), []).append(s[2])
        ts = sorted(t); tot = 0.0; n = 0
        for a, b in zip(ts, ts[1:]):
            if b - a > 0.25: continue
            for p in t[b]:
                q = min(t[a], key=lambda r: math.dist(p, r)); d = math.dist(p, q)
                if d < 1.5: tot += d; n += 1
        return tot / max(1, len(ts)) if n else None
    v['still8'] = more(moved, less=True)
    v['net8'] = more(lambda pr: min((abs(s[2][1] - NET_Y) for s in by[pr]), default=None), less=True)
    return v


def crossings(S, dead, until, step=1.5):
    """How many times a person walks over the net line after the point: a sighting more than 0.5 m on one side, and the
    nearest sighting of the next picture (within `step` m) more than 0.5 m on the other side."""
    by = {}
    for s in S:
        if dead + 0.5 <= s[0] <= until: by.setdefault(round(s[0], 2), []).append(s[2])
    n = 0; tracks = []                                  # [place now, the last side seen more than 0.5 m from the line]
    side = lambda y: 0 if abs(y - NET_Y) <= 0.5 else (1 if y > NET_Y else -1)
    for t in sorted(by):
        free = list(range(len(tracks))); new = []
        for p in by[t]:
            j = min(free, key=lambda i: math.dist(p, tracks[i][0]), default=None)
            if j is not None and math.dist(p, tracks[j][0]) <= step:
                free.remove(j); tr = tracks[j]
            else:
                tr = [p, 0]
            sd = side(p[1])
            if sd and tr[1] and sd != tr[1]: n += 1
            new.append([p, sd or tr[1]])
        tracks = new
    return n


def side_change(S, dead, until, near_pair):
    """True when two or more people walk over the net line after the point (the pairs change ends)."""
    return crossings(S, dead, until) >= 2


def _walk(wd, st):
    f = f'{wd}/p{st:.2f}.json'
    return json.load(open(f)) if os.path.exists(f) else None


if __name__ == '__main__':
    import court_map
    cmd = sys.argv[1]
    if cmd == 'feats':
        wd, idf, ff, of = sys.argv[2:6]
        I = json.load(open(idf)); rows = json.load(open(ff)); rows.sort(key=lambda r: r['serve_t']); n = 0
        for i, r in enumerate(rows):
            w = _walk(wd, r['serve_t']); nxt = rows[i + 1]['serve_t'] if i + 1 < len(rows) else r['dead_t'] + 30
            if w is None: r['votes'].update({k: 0 for k in VOTES8}); continue
            S = sightings(w, court_map.place); n += 1
            r['votes'].update(votes(S, r['dead_t'], min(r['dead_t'] + 8.0, nxt - 1.5), r['near_pair']))
        json.dump(rows, open(of, 'w')); print(len(rows), 'points,', n, 'with a walk file')
    elif cmd == 'ends':
        wd, idf, ef = sys.argv[2:5]
        E = json.load(open(ef)); I = json.load(open(idf))
        P = [p for p in E['points'] if p.get('serve_t') is not None and not p.get('unseen')]; P.sort(key=lambda p: p['serve_t'])
        tp = fp = fn = tn = 0
        for i, p in enumerate(P):
            w = _walk(wd, p['serve_t']); nxt = P[i + 1] if i + 1 < len(P) else None
            if w is None or nxt is None or p.get('dead_t') is None: continue
            b = int(p['serve_t'] // I['bin']); near = I['near_pair'][min(b, len(I['near_pair']) - 1)]
            g0 = sum(p['before']['games']); g1 = sum(nxt['before']['games'])
            truth = (nxt['set'] == p['set'] and g1 == g0 + 1 and g1 % 2 == 1)
            said = side_change(sightings(w, court_map.place), p['dead_t'], min(p['dead_t'] + 8.0, nxt['serve_t'] - 1.0), near)
            tp += said and truth; fp += said and not truth; fn += truth and not said; tn += not said and not truth
        print(f'change of ends: {tp} found, {fn} missed, {fp} false, {tn} right no (of {tp + fp + fn + tn} points)')
