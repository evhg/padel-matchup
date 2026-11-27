"""The last swing of a point from the poses alone: a vote for winner.py (the far hitter, issue 374, after improvement 3).

usage: swing.py feats <walk dir of walk_mps.py> <feats.json of winner.py> <out feats.json>     (SWING= the threshold)

flight.py names a hitter only where the ball's chain starts at a person. At the far end the ball is a few pixels and
the chain often starts late or not at all, so the last hit that flight.py sees is mostly a near player's, and its ball
ends "at a person" (the near hitter in 137 of 177 points with a hit; a catcher in 101 of the 120 points where ends.py finds
no end). The poses see the swing even where the ball is not seen.

A swing: a wrist faster than SWING box heights a second between two pictures (walk_mps.py at 10 or 30 pictures a
second), for a person followed from picture to picture (the nearest box of the same half, within one box height).
Both key points must have a score of 0.3 or more. The vote, for the last swing from 3 s before the dead ball to 0.3 s
after it:
  swing     +1/-1: the pair of the half of the last swing (winner.py fit gives the sign: a pair that swings last
            either hit the winner or made the error)

Measured on match2 (27 November 2026, the Mac lab): it does not help. At ten pictures a second (walk_mps.py's 8 s
after the point) a swing is two or three pictures, and no threshold beats the six votes of winner.py in the
cross-validation of sets 1 and 2 (70%). At 30 pictures a second (walk_mps.py, 3 s before the dead ball to 0.3 s after
it: 18,018 pictures in 34 min) the thresholds 3 to 13 give 70% to 73%; only 4 gives 73%. With 4, on the 51 held-back
points: the six votes and swing 30 of 51 (59%; the six alone 31), swing 20 of 44 with a vote. The engine: set 3 33 of
43 points and 7 of 7 games, 16 of 30 games sure; against the owner's set 3 points 4 point scores (4 right) and 4
winner lines (4 right). A swing is not a hit: in the last 3 s all four players swing, at the ball and at nothing.
A first try at ten pictures a second, to move the last hit to the person the ball ended at when that person swung
within 0.5 s, fits only 12 to 14 points of sets 1 and 2 and gives 67% to 68%.
"""
import json, math, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

LWR, RWR = 9, 10
SWING = float(os.environ.get('SWING', 5.0))            # box heights a second
VOTESS = ('swing',)


def swings(walk, a, b, thr=SWING):
    """[(t, zone)] of the swings between film times a and b. Pure."""
    fr = [f for f in walk['frames'] if a - 0.15 <= f['t'] <= b]; out = []
    for f0, f1 in zip(fr, fr[1:]):
        dt = f1['t'] - f0['t']
        if not 0 < dt <= 0.15: continue
        for p in f1['people']:
            bx = p['box']; h = max(1.0, bx[3] - bx[1]); cx, cy = (bx[0] + bx[2]) / 2, (bx[1] + bx[3]) / 2
            prev = [q for q in f0['people'] if q['zone'] == p['zone']]
            if not prev: continue
            q = min(prev, key=lambda q: math.hypot((q['box'][0] + q['box'][2]) / 2 - cx, (q['box'][1] + q['box'][3]) / 2 - cy))
            if math.hypot((q['box'][0] + q['box'][2]) / 2 - cx, (q['box'][1] + q['box'][3]) / 2 - cy) > h: continue
            d = max((math.hypot(p['kp'][j][0] - q['kp'][j][0], p['kp'][j][1] - q['kp'][j][1]) / h
                     for j in (LWR, RWR) if p['kp'][j][2] >= 0.3 and q['kp'][j][2] >= 0.3), default=0.0) / dt
            if d > thr and a <= f1['t'] <= b: out.append((f1['t'], p['zone']))
    return out


def votes(walk, dead, near_pair, thr=SWING):
    """The swing vote of one point. Pure."""
    s = swings(walk, dead - 3.0, dead + 0.3, thr) if walk else []
    if not s: return {'swing': 0}
    zone = max(s)[1]; pair = near_pair if zone == 'near' else 1 - near_pair
    return {'swing': 1 if pair == 0 else -1}


if __name__ == '__main__':
    cmd, wd, ff, of = sys.argv[1:5]
    rows = json.load(open(ff)); n = 0
    for r in rows:
        w = f"{wd}/p{r['serve_t']:.2f}.json"; walk = json.load(open(w)) if os.path.exists(w) else None
        r['votes'].update(votes(walk, r['dead_t'], r['near_pair'])); n += bool(r['votes']['swing'])
    json.dump(rows, open(of, 'w')); print(len(rows), 'points,', n, 'with a swing vote')
