"""Which sounds of a clip are shots, and who hit them: the ball, the arms and the turn of the two teams, together.

usage: shotseq.py <track.json> <ball flights .npz> <audio.json> <out.json> [pairs json, default [[0,3],[1,2]]]
For each sound:
  ball  - a flight of the ball ends or starts within reach of a player at that moment (strong), or the ball flies on
          smoothly through that moment (then the sound is not a shot of this ball: the next court, a shout, a shoe),
          or two flights meet far from every player (the floor or the glass).
  arm   - the fastest wrist of each player around the sound, in body heights a second.
  turn  - the teams hit in turn. The best labelling of the whole row of sounds is found in one pass (Viterbi).
A pause of more than DEAD seconds without a shot ends the rally: what comes after is 'after the point'.
"""
import sys, json, numpy as np
sys.path.insert(0, __import__('os').path.dirname(__import__('os').path.abspath(__file__)))
from shots import wrist_speed, arm_up, FPS
DEAD = 3.6
def fit(ts, ps):
    d = 2 if len(ts) >= 5 else 1
    return [np.polyfit(ts, [p[k] for p in ps], d) for k in (0, 1)]
def player_at(p, f):
    i = int(np.argmin([abs(x - f) for x in p['f']]))
    if abs(p['f'][i] - f) > 5: return None
    return np.array(p['box'][i][:4]), np.array(p['kp'][i])
def analyse(tr, flights, sounds, pairs):
    near = set(pairs[tr['near_pair']]); t0 = tr['t0']; rows = []
    speeds = {k: wrist_speed(p) for k, p in tr['players'].items()}
    for ts, strength in sounds:
        f = (ts - t0) * FPS; ev = {}
        # the ball: ends and starts of flights near this moment, taken to this moment along their own curve
        ends = []
        for fl in flights:
            pts = fl['pts']
            if f - 7 <= fl['f1'] <= f + 2:
                tail = pts[-6:]; co = fit([p[0] for p in tail], [p[1:3] for p in tail]); g = min(f, fl['f1'] + 5)
                ends.append(('end', np.array([np.polyval(co[0], g), np.polyval(co[1], g)]), np.array(pts[-1][1:3]), fl))
            if f - 2 <= fl['f0'] <= f + 7:
                head = pts[:6]; co = fit([p[0] for p in head], [p[1:3] for p in head]); g = max(f, fl['f0'] - 5)
                ends.append(('start', np.array([np.polyval(co[0], g), np.polyval(co[1], g)]), np.array(pts[0][1:3]), fl))
        through = any(fl['f0'] <= f - 4 and fl['f1'] >= f + 4 and fl.get('body', 0) < 0.55 for fl in flights)
        per = {}
        for k, p in tr['players'].items():
            pa = player_at(p, f)
            if pa is None: continue
            box, kp = pa; h = max(30.0, box[3] - box[1])
            hands = [kp[w, :2] for w in (9, 10) if kp[w, 2] > 0.3] or [np.array([(box[0] + box[2]) / 2, box[1] + 0.35 * h])]
            dball = None; how = None
            for kind, q, raw, fl in ends:
                d = min(min(np.linalg.norm(q - hd), np.linalg.norm(raw - hd)) for hd in hands) / h
                if dball is None or d < dball: dball, how = d, kind
            sp = [v for (g, v) in speeds[k] if f - 9 <= g <= f + 4]
            per[int(k)] = {'dball': None if dball is None else round(float(dball), 2), 'how': how, 'arm': round(max(sp), 2) if sp else None,
                           'up': bool(any(arm_up(p, f + d) for d in (-6, -3, 0)))}
        rows.append({'t': ts, 'f': round(f, 1), 'strength': strength, 'through': bool(through), 'ends': len(ends), 'per': per, 'near': sorted(near)})
    return rows
def score(rows):
    """-> for each sound the scores of (near hit, far hit, other) and the likely hitter of each team."""
    med = float(np.median([r['strength'] for r in rows])) if rows else 1.0
    out = []
    for r in rows:
        loud = 0.5 * float(np.clip(np.log2(max(r['strength'], 1e-6) / med), -1.5, 1.5))      # a racket is louder than a bounce or the next court
        # a team that the tracker does not see at this moment can still hit: an unknown, not a no
        best = {True: (-0.5 + loud, None), False: (-0.5 + loud, None)}; seen = {True: False, False: False}
        for k, e in r['per'].items():
            s = -0.2 + loud
            if e['dball'] is not None: s += 3.2 * max(0.0, 1 - e['dball'] / 0.8)
            if e['arm'] is not None: s += 1.1 * float(np.clip((e['arm'] - 1.6) / 1.4, -1, 1.6))
            side = k in r['near']
            if not seen[side] or s > best[side][0]: best[side] = (s, k)
            seen[side] = True
        nohand = all(e['dball'] is None or e['dball'] > 1.2 for e in r['per'].values())
        other = 0.2 + (2.6 if r['through'] else 0.0) + (1.6 if r['ends'] >= 2 and nohand else 0.0)
        out.append((best[True], best[False], other))
    return out
def gap_score(g):
    """How likely is this time between two shots that follow each other in a rally."""
    if g < 0.3: return -4.0
    if g < 0.45: return -1.5
    if g <= 2.9: return 0.0
    if g <= DEAD: return -0.8
    return -5.0          # a break: the rally ended before, or starts after. Rare inside one row of sounds.
def viterbi(rows, sc):
    """The best row of labels. A state is the last shot (which sound, which team): so the time since that shot counts,
    and a team does not hit twice in a row (a large cost, not forbidden)."""
    n = len(rows); T = [r['t'] for r in rows]
    oth = np.concatenate([[0.0], np.cumsum([s[2] for s in sc])])          # the score of 'other' for the sounds i..j-1 is oth[j] - oth[i]
    best = {}                                                            # (j, team) -> (score, previous state)
    for j in range(n):
        for team in (True, False):
            hit = sc[j][0][0] if team else sc[j][1][0]
            cand = (oth[j] + hit, None)                                  # the first shot of the row
            for i in range(j):
                for tm in (True, False):
                    v = best[(i, tm)][0] + (oth[j] - oth[i + 1]) + hit + gap_score(T[j] - T[i]) - (4.0 if tm == team else 0.0)
                    if v > cand[0]: cand = (v, (i, tm))
            best[(j, team)] = cand
    end = max(best, key=lambda k: best[k][0] + (oth[n] - oth[k[0] + 1])) if best else None
    if end is None or best[end][0] + (oth[n] - oth[end[0] + 1]) < oth[n]: return [('other', None)] * n
    labs = [('other', None)] * n; st = end
    while st is not None:
        j, team = st; labs[j] = ('near' if team else 'far', sc[j][0][1] if team else sc[j][1][1]); st = best[st][1]
    return labs
def label(tr, flights, sounds, pairs):
    rows = analyse(tr, flights, sounds, pairs); sc = score(rows); labs = viterbi(rows, sc)
    # the rally is the longest row of shots without a break; shots before it and after it are not of the point
    hits = [i for i, (lab, _) in enumerate(labs) if lab != 'other']; chains = []
    for i in hits:
        if chains and rows[i]['t'] - rows[chains[-1][-1]]['t'] <= DEAD: chains[-1].append(i)
        else: chains.append([i])
    main = set(max(chains, key=len)) if chains else set(); first = min(main) if main else 0
    res = []
    for i, (r, (lab, who), s) in enumerate(zip(rows, labs, sc)):
        if lab != 'other' and i not in main: lab = 'before' if i < first else 'after'
        res.append({'t': r['t'], 'label': lab, 'who': who, 'scores': [round(s[0][0], 1), round(s[1][0], 1), round(s[2], 1)], 'through': r['through'], 'per': r['per']})
    return res
if __name__ == '__main__':
    tr = json.load(open(sys.argv[1])); z = np.load(sys.argv[2]); flights = json.loads(str(z['flights'])); A = json.load(open(sys.argv[3]))
    pairs = json.loads(sys.argv[5]) if len(sys.argv) > 5 else [[0, 3], [1, 2]]
    t0 = tr['t0']; t1 = t0 + tr['frames'] / FPS
    sounds = [(t, s) for t, s in A['hits'] if t0 + 0.2 <= t <= t1 - 0.2]
    res = label(tr, flights, sounds, pairs)
    json.dump(res, open(sys.argv[4], 'w'))
    for r in res:
        per = ' '.join(f"{k}:{'-' if e['dball'] is None else e['dball']}/{e['arm']}{'^' if e['up'] else ''}" for k, e in sorted(r['per'].items()))
        print(f"{r['t']:8.2f} (+{r['t'] - t0:5.2f})  {r['label']:6s} {'' if r['who'] is None else r['who']!s:2s} n/f/o {r['scores']}  {'through ' if r['through'] else ''}{per}")
    print('shots', sum(1 for r in res if r['label'] in ('near', 'far')), 'of', len(res), 'sounds')
