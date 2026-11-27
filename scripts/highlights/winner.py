"""Who won each point, with no person: the last flight of the ball, the players after the point, their voices.

usage: winner.py feats <points.json> <flight.json> <walk dir> <ident.json> <out feats.json>
                       [SCRIBE=<left.json>,<right.json> PHONE=<phone.json of tx_phone.py>]
       winner.py fit <feats.json> <engine.json> <sets, e.g. 1,2> <out weights.json>
       winner.py measure <feats.json> <weights.json> <truth.json> [sets]
       winner.py points <feats.json> <weights.json> <reader points.json ...> <out points.json>

`points.json` gives the serve and the dead moment of each point (serve_t, dead_t; a reader's file or the engine's).
Each point gets votes for the pair that won it (+1: pair 0, -1: pair 1, 0: no evidence):
  bounce    the last bounce of flight.py in the 1.5 s before the dead ball: the ball died in that half, so the
            pair of that half lost
  hitter    the pair of the last hitter lost (an error ends more points of friends than a winner does)
  crossed   the last hit stayed in its own half (the net): its pair lost; it reached the other half: its pair won
  away      ident.json (one picture a second, with names) from 0.5 s to 5 s after the dead ball: the pair that
            walks further from the net won (the losers go to the net for the ball, the winners back to their places)
  partners  the pair whose two players come closer together won (a hand slap)
  voice     words and sounds that each recorder on the fence heard in the 2 s after the dead ball (Scribe): the
            half that says more won. NEAR_RECORDER says which recorder hangs in the near half (left on match2)
The half of the court is a pair through ident.json's near pair. `fit` gives each vote a weight (a logistic sum,
fitted on the sets named and nothing else), `measure` scores a split against a truth file, and `points` writes a
points file for score_engine.py: the reader's server and side with the detector's winner and chance. The engine then
adds the count: a new server is a new game, the set scores say who won each game, the sides say how many points.
Measured on match2 in the README ("Who won the point, with no person"). numpy only.
"""
import json, math, os, sys
import numpy as np

NET_Y = 10.0                 # the net, in metres from the near back wall (court_map.py)
VOTES = ('bounce', 'hitter', 'crossed', 'away', 'partners', 'voice')


def half(y):
    """'near' or 'far' for a place in metres along the court."""
    return 'near' if y < NET_Y else 'far'


def pair_of(h, near_pair):
    """The pair that plays in a half."""
    return near_pair if h == 'near' else 1 - near_pair


def vote(pair):
    """+1 for pair 0, -1 for pair 1, 0 for none."""
    return 0 if pair is None else (1 if pair == 0 else -1)


def ball(flights, dead, near_pair):
    """bounce, hitter and crossed from the flights of one point (flight.py)."""
    out = {'bounce': 0, 'hitter': 0, 'crossed': 0}
    bs = [f for f in flights if f.get('bounce') and dead - 1.5 <= f['t1'] <= dead + 0.4]
    if bs: out['bounce'] = -vote(pair_of(half(bs[-1]['bounce'][1]), near_pair))
    hs = [f for f in flights if f.get('hitter') and dead - 2.5 <= f['t0'] <= dead + 0.1]
    if hs:
        h = hs[-1]; hh = half(h['hitter']['at'][1]); mine = vote(pair_of(hh, near_pair))
        out['hitter'] = -mine
        end = h['bounce'] or (h.get('catcher') or {}).get('at')
        if end is not None: out['crossed'] = -mine if half(end[1]) == hh else mine
    return out


def after(by, times, pairs, dead, until, floor):
    """away and partners from ident.json's sightings between the dead ball and `until` (the next serve less 1.5 s)."""
    team = lambda k: 0 if k in pairs[0] else 1
    b = min(dead + 5.0, until)
    if b <= dead + 0.5: return {'away': 0, 'partners': 0}
    def at(t0, t1):
        ps = {}
        for t in times[(times >= t0) & (times <= t1)]:
            for s in by[t]:
                box = s['box']
                if s['id'] < 0 or box[3] >= 1075: continue           # a foot under the picture has no place
                ps.setdefault(team(s['id']), {}).setdefault(s['id'], []).append(floor((box[0] + box[2]) / 2, box[3]))
        return ps
    p0, p1 = at(dead - 1.0, dead + 0.5), at(dead + 0.5, b)
    net = {}; part = {}
    for pr in (0, 1):
        a, c = p0.get(pr), p1.get(pr)
        if a and c:
            g = lambda d: float(np.mean([abs(q[1] - NET_Y) for v in d.values() for q in v]))
            net[pr] = g(c) - g(a)
        if c and len(c) == 2:
            x, y = c.values(); part[pr] = min(math.dist(u, v) for u in x for v in y)
    out = {'away': 0, 'partners': 0}
    if len(net) == 2 and net[0] != net[1]: out['away'] = 1 if net[0] > net[1] else -1
    if len(part) == 2 and part[0] != part[1]: out['partners'] = 1 if part[0] < part[1] else -1
    return out


def voice(words, offsets, dead, near_pair, near_rec='left', span=2.0):
    """+1/-1 for the pair of the half whose recorder heard more words and sounds in the `span` s after the dead ball."""
    n = {s: sum(1 for w in words[s] if dead <= w['t'] - offsets[s] <= dead + span and w.get('kind') in ('word', 'audio_event')) for s in words}
    far_rec = 'right' if near_rec == 'left' else 'left'
    if n[near_rec] == n[far_rec]: return 0
    return vote(pair_of('near' if n[near_rec] > n[far_rec] else 'far', near_pair))


def feats(points, flight, ident, words=None, offsets=None, near_rec='left'):
    """The votes of each point that has a serve and a dead moment. Pure."""
    import court_map
    by = {}
    for s in ident['sightings']: by.setdefault(s['t'], []).append(s)
    times = np.array(sorted(by)); P = [p for p in points if p.get('serve_t') is not None and p.get('dead_t') is not None]
    P.sort(key=lambda p: p['serve_t']); rows = []
    for i, p in enumerate(P):
        st, dead = p['serve_t'], p['dead_t']; b = int(st // ident['bin'])
        near = ident['near_pair'][min(b, len(ident['near_pair']) - 1)]
        nxt = P[i + 1]['serve_t'] if i + 1 < len(P) else dead + 30
        v = ball(flight.get('p%.2f' % st, []), dead, near)
        v.update(after(by, times, ident['pairs'], dead, nxt - 1.5, court_map.floor))
        v['voice'] = voice(words, offsets, dead, near, near_rec) if words else 0
        rows.append({'serve_t': st, 'dead_t': dead, 'set': p.get('set'), 'near_pair': near, 'votes': v})
    return rows


def chance(row, w):
    """The chance that pair 0 won: the logistic sum of the votes with the weights of `w`."""
    z = w.get('bias', 0.0) + sum(w.get(k, 0.0) * row['votes'].get(k, 0) for k in VOTES)
    return 1 / (1 + math.exp(-max(-30.0, min(30.0, z))))


def fit(rows, ys, l2=1.0, steps=3000, lr=0.1, use=VOTES):
    """Weights of a logistic sum of the votes, for labels ys (0 or 1: the pair that won), with a penalty l2 on each
    weight. No bias: a pair that won more points of the sets it is fitted on is not more likely to win the next set."""
    X = np.array([[r['votes'].get(k, 0) for k in use] for r in rows], float); y = np.array([1.0 if v == 0 else 0.0 for v in ys])
    wv = np.zeros(len(use))
    for _ in range(steps):
        p = 1 / (1 + np.exp(-(X @ wv))); g = X.T @ (p - y) / len(y) + l2 * wv / len(y); wv -= lr * g
    return {k: round(float(x), 3) for k, x in zip(use, wv)}


def right(rows, ys, w):
    """(right, of decided, of all): a point with no vote, or votes that cancel, is not decided."""
    ok = [(chance(r, w) > 0.5) == (y == 0) for r, y in zip(rows, ys) if chance(r, w) != 0.5]; return sum(ok), len(ok), len(ys)


def points_file(rows, w, readers, names):
    """A points file for score_engine.py: for each row, the reader's row nearest in time (server, side, kind), with the
    detector's winner (a pair's name from `names`) and its chance as "confidence"."""
    out = []
    for r in rows:
        src = min(readers, key=lambda q: abs(q['serve_t'] - r['serve_t']))
        if abs(src['serve_t'] - r['serve_t']) > 4.0: continue
        c = chance(r, w)
        out.append({k: src.get(k) for k in ('serve_t', 'dead_t', 'server', 'side', 'kind')} |
                   {'winner': None if c == 0.5 else names[0 if c > 0.5 else 1], 'confidence': round(max(c, 1 - c), 3)})
    return {'chunk': 'detector', 'points': out}


def _load_words():
    sc, ph = os.environ.get('SCRIBE'), os.environ.get('PHONE')
    if not (sc and ph): return None, None
    P = json.load(open(ph)); f = dict(zip(('left', 'right'), sc.split(',')))
    return {s: json.load(open(f[s]))['words'] for s in f}, {s: P[s]['offset_s'] for s in f}


def _labels(path):
    """serve_t -> the pair that won, from an engine file ("won") or a points file of names ("winner", match.json)."""
    E = json.load(open(path)); out = {}
    if 'pairs' in E:
        return {p['serve_t']: (p['set'], p['won']) for p in E['points'] if p.get('serve_t') is not None and not p.get('unseen')}
    S = os.environ.get('HL_HOME') or os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    M = json.load(open(os.environ.get('HL_MATCH') or f'{S}/match/match.json')); team = {M['names'][k].lower(): M['team'][k] for k in M['names']}
    pair = [M.get('team_a') or M['pair_a'], M.get('team_b') or M['pair_b']]
    for p in E['points']:
        if p.get('kind', 'point') not in ('point', 'double fault') or not p.get('winner'): continue
        n = p['winner'].lower(); y = 0 if n == pair[0].lower() else 1 if n == pair[1].lower() else team.get(n)
        if y is not None: out[p['serve_t']] = (None, y)
    return out


def _match(rows, lab, sets=None):
    """The rows that have a label within 4 s, and their labels."""
    R, Y = [], []
    for r in rows:
        if sets and r['set'] not in sets: continue
        t = min(lab, key=lambda t: abs(t - r['serve_t']), default=None)
        if t is None or abs(t - r['serve_t']) > 4.0: continue
        R.append(r); Y.append(lab[t][1])
    return R, Y


if __name__ == '__main__':
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    cmd = sys.argv[1]
    if cmd == 'feats':
        pf, ff, wd, idf, of = sys.argv[2:7]
        words, offs = _load_words()
        rows = feats(json.load(open(pf))['points'], json.load(open(ff)), json.load(open(idf)), words, offs, os.environ.get('NEAR_RECORDER', 'left'))
        json.dump(rows, open(of, 'w')); print(len(rows), 'points')
    elif cmd == 'fit':
        rows = json.load(open(sys.argv[2])); sets = [int(s) for s in sys.argv[4].split(',')]
        R, Y = _match(rows, _labels(sys.argv[3]), sets); w = fit(R, Y)
        w['fitted_on'] = {'sets': sets, 'points': len(R)}; json.dump(w, open(sys.argv[5], 'w'), indent=1)
        print('weights', w, 'right on its own sets (right, decided, all):', right(R, Y, w))
    elif cmd == 'measure':
        rows = json.load(open(sys.argv[2])); w = json.load(open(sys.argv[3])); sets = [int(s) for s in sys.argv[5].split(',')] if len(sys.argv) > 5 else None
        R, Y = _match(rows, _labels(sys.argv[4]), sets)
        for k in VOTES:
            n = [(r['votes'][k] > 0) == (y == 0) for r, y in zip(R, Y) if r['votes'][k]]
            print(f'  {k:9s} {sum(n):3d} of {len(n):3d} with a vote ({sum(n) / max(1, len(n)):.0%}), of {len(R)} points')
        c, n, a = right(R, Y, w); print(f'  combined  {c:3d} of {n:3d} decided ({c / max(1, n):.0%}), of {a} points')
    elif cmd == 'points':
        rows = json.load(open(sys.argv[2])); w = json.load(open(sys.argv[3])); readers = []
        for f in sys.argv[4:-1]: readers += [p for p in json.load(open(f))['points'] if p.get('kind', 'point') in ('point', 'double fault')]
        S = os.environ.get('HL_HOME') or os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        M = json.load(open(os.environ.get('HL_MATCH') or f'{S}/match/match.json'))
        out = points_file(rows, w, readers, [M.get('team_a') or M['pair_a'], M.get('team_b') or M['pair_b']])
        json.dump(out, open(sys.argv[-1], 'w'), indent=1); print(len(out['points']), 'points')
