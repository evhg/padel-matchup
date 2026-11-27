"""How a point ended, from the ball at both ends: votes for winner.py (improvement 2 of the Mac lab, issue 374).

usage: ends.py merge <ball dir> <far ball dir> <out dir>      (ball_places.py's files, the far half read again: CROP)
       ends.py feats <flight.json> <feats.json of winner.py> <out feats.json>
       ends.py kinds <flight.json> <points.json with "how"> [sets] (the end kinds against a reader's words)

`merge`: ball_places.py over the whole picture keeps the strongest islands, mostly the near players, and loses the far
ball. ball_places.py with CROP= over the far half keeps islands of its own there. For each picture the merged file has
the whole picture's candidates outside the crop and the crop's candidates inside it. flight.py then reads the merged
folder as it reads ball_places.py's.

The end of a point, from the flights of flight.py in the last 3 s before the dead ball (court metres: y 0 at the near
back wall, 10 at the net, 20 at the far back wall):
  net        the last hit's ball bounced in its own half, or stopped at the net: the hitter's pair lost
  double     two bounces in one half with no hit between: the pair of that half lost
  unreturned the last hit crossed and bounced in the other half, and no hit came from that half: that half lost
  nobounce   the last hit's ball has no bounce and no catcher (out over a wall, or not seen): the hitter's pair lost
  none       no hit was seen in the last 3 s
Each kind is its own vote (endnet, enddouble, endunret, endnobounce), so `winner.py fit` weighs each by its own record.

Measured on match2 (27 November 2026, the Mac lab): it does not help yet. The far-half pass (ball_places.py CROP=) and
looser far thresholds (flight.py FAR_Y=910) doubled the bounces seen in the far half in the last 3 s of a point (26 to
55), but the cross-validation on sets 1 and 2 fell from 70% to 64%, because the looser thresholds add false bounces. With
the old thresholds and the poses of walk_mps.py for the hitter, the six votes of winner.py and the end votes give 31 of
the 51 held-back points (61%, as before), and 31 with the votes of react.py too (react.py alone: 33). The end votes on the
held-back points: endunret 3 of 3, endnet 3 of 7, endnobounce 3 of 7. Against the owner's words of set 3, the code finds
3 of 14 points into the net; most points get "none", because no hit is seen in the last 3 s: flight.py names a hitter
only when the ball that came to the player is seen too, and that is rare at the far end.
"""
import json, os, sys

NET_Y = 10.0
VOTESE = ('endnet', 'enddouble', 'endunret', 'endnobounce')


def merge(a, b):
    """One picture list from the whole picture (a) and the crop (b): b's candidates inside b's crop."""
    x0, y0, x1, y1 = b['crop']; inside = lambda c: x0 <= c[1] < x1 and y0 <= c[2] < y1
    bt = {round(f['t'], 3): f['c'] for f in b['frames']}
    out = dict(a); out['frames'] = []
    for f in a['frames']:
        c = bt.get(round(f['t'], 3))
        out['frames'].append({'t': f['t'], 'c': f['c'] if c is None else [x for x in f['c'] if not inside(x)] + c})
    out['merged_crop'] = b['crop']; return out


def half(y): return 'near' if y < NET_Y else 'far'


def end_of(flights, dead):
    """(kind, half that lost) of one point from its flights. Pure."""
    F = sorted([f for f in flights if dead - 3.0 <= f['t1'] and f['t0'] <= dead + 0.3], key=lambda f: f['t0'])
    hits = [i for i, f in enumerate(F) if f.get('hitter')]
    if not hits: return 'none', None
    i = hits[-1]; h = F[i]; hh = half(h['hitter']['at'][1]); other = 'far' if hh == 'near' else 'near'
    after = F[i:]
    bounces = [half(f['bounce'][1]) for f in after if f.get('bounce')]
    if bounces and bounces[0] == hh: return 'net', hh
    if len(bounces) >= 2 and bounces[0] == bounces[1] == other: return 'double', other
    if bounces and bounces[0] == other: return 'unreturned', other
    if not h.get('bounce') and not h.get('catcher') and len(after) == 1: return 'nobounce', hh
    return 'none', None


def votes(flights, dead, near_pair):
    """The four end votes of one point: +1 for pair 0, -1 for pair 1, 0 for none."""
    kind, lost = end_of(flights, dead); v = {k: 0 for k in VOTESE}
    if lost is None: return v, kind
    pair = near_pair if lost == 'near' else 1 - near_pair            # the pair that lost
    key = {'net': 'endnet', 'double': 'enddouble', 'unreturned': 'endunret', 'nobounce': 'endnobounce'}[kind]
    v[key] = 1 if pair == 1 else -1; return v, kind


if __name__ == '__main__':
    cmd = sys.argv[1]
    if cmd == 'merge':
        bd, fd, od = sys.argv[2:5]; os.makedirs(od, exist_ok=True); n = 0
        for name in sorted(os.listdir(bd)):
            if not name.endswith('.json'): continue
            a = json.load(open(f'{bd}/{name}')); fb = f'{fd}/{name}'
            if os.path.exists(fb): a = merge(a, json.load(open(fb))); n += 1
            json.dump(a, open(f'{od}/{name}', 'w'), separators=(',', ':'))
        print('merged', n, 'points')
    elif cmd == 'feats':
        F = json.load(open(sys.argv[2])); rows = json.load(open(sys.argv[3])); from collections import Counter; c = Counter()
        for r in rows:
            v, kind = votes(F.get('p%.2f' % r['serve_t'], []), r['dead_t'], r['near_pair']); r['votes'].update(v); r['end'] = kind; c[kind] += 1
        json.dump(rows, open(sys.argv[4], 'w')); print(len(rows), 'points', dict(c))
    elif cmd == 'kinds':
        F = json.load(open(sys.argv[2])); P = json.load(open(sys.argv[3]))['points']
        from collections import Counter; c = Counter()
        for p in P:
            if p.get('dead_t') is None or not p.get('how'): continue
            w = p['how'].split()[0].strip(':,').lower(); said = {'net': 'net', 'out': 'out', 'winner': 'winner'}.get(w)
            if said is None: continue
            k, _ = end_of(F.get('p%.2f' % p['serve_t'], []) or next((v for n, v in F.items() if abs(float(n[1:]) - p['serve_t']) < 2), []), p['dead_t'])
            c[(said, k)] += 1
        for (s, k), n in sorted(c.items()): print(f'  reader {s:7s} code {k:11s} {n}')
