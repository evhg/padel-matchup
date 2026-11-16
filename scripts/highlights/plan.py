"""Choose the moments of the recap reel: the best points, spread over the match and shared equally between the two ends.

usage: plan.py <audio.json> <ident.json> <plan.json> [points=6]
A reel never singles out one pair (the owner, 14 November 2026): half the points have each pair at the camera end.
A point always shows its end (the owner: "rallies should always capture the point").
"""
import sys, json, numpy as np
audio, ident, out = sys.argv[1], sys.argv[2], sys.argv[3]
NPTS = int(sys.argv[4]) if len(sys.argv) > 4 else 6
A = json.load(open(audio)); M = json.load(open(ident))
BIN = M['bin']; near_pair = M['near_pair']; sure = M['sure']
dur = A['seconds']
def bin_of(t): return min(len(near_pair) - 1, int(t // BIN))
# the match starts when the pairs first stand in pairs for a minute
start_bin = next((b for b in range(len(sure) - 3) if all(sure[b:b + 3])), 0)
t_start = start_bin * BIN
# a point of the match has both pairs on the court: two friends who hit to each other in a break are not a rally
# (in this match: 55 "shots" in 109 seconds at 42:28, with only two people on the court)
byf = {}
for s in M['sightings']: byf.setdefault(s['t'], 0); byf[s['t']] += 1
ft = np.array(sorted(byf)); fn = np.array([byf[t] for t in ft])
def crowd(p):
    m = (ft >= p['start'] - 1) & (ft <= p['end'] + 1)
    return float((fn[m] >= 3).mean()) if m.any() else 0.0
def real(p): return crowd(p) >= 0.3 and sure[bin_of(p['lastHit'])]     # the pairs stand in pairs when it ends: serve practice between sets does not
pts = [p for p in A['points'] if p['start'] >= t_start and p['end'] <= dur - 15 and real(p)]
print('dropped (not four on court):', [(f"{int(p['start'] // 60)}:{int(p['start'] % 60):02d}", p['hits'], round(crowd(p), 2)) for p in A['points'] if p['start'] >= t_start and not real(p)])
print(f'match play from {int(t_start // 60)}:{int(t_start % 60):02d}; points in play {len(pts)} of {len(A["points"])}')

def worth(p):
    w = p['score']
    if p['reactionDb'] >= 3.5: w += 8    # they reacted: a shout, a cheer
    if p['burst']['n'] >= 4: w += 4      # a fast exchange at the net
    return w
for p in pts:
    p['near'] = near_pair[bin_of(p['lastHit'])]; p['sure'] = bool(sure[bin_of(p['lastHit'])]); p['worth'] = worth(p)

# the longest rally of the match is always in: it is the story everybody tells afterwards
marathon = max([p for p in pts if sure[bin_of(p['lastHit'])] and sure[bin_of(p['firstHit'])]], key=lambda p: p['hits'])
if marathon['hits'] < 30: marathon = None
chosen = [marathon] if marathon else []
per = {0: 0, 1: 0}
if marathon: per[marathon['near']] += 1
quota = (NPTS + 1) // 2
ranked = sorted([p for p in pts if p['sure'] and p is not marathon], key=lambda p: -p['worth'])
while len(chosen) < NPTS:
    # best first; a point close in time to a chosen one loses worth, so the reel covers the match
    def adj(p): return p['worth'] - 8 * sum(1 for q in chosen if abs(p['lastHit'] - q['lastHit']) < 150) - 100 * any(abs(p['lastHit'] - q['lastHit']) < 60 for q in chosen) + 6 * min([abs(p['lastHit'] - q['lastHit']) for q in chosen] + [1200]) / 1200
    cands = [p for p in ranked if p not in chosen and per[p['near']] < quota]
    if not cands: break
    p = max(cands, key=adj); chosen.append(p); per[p['near']] += 1
chosen.sort(key=lambda p: p['lastHit'])
best = max([p for p in chosen if p is not marathon], key=lambda p: p['worth'])

def title(p):
    if p is marathon: return 'The marathon'
    if p is best: return 'Point of the match'
    if p['burst']['n'] >= 4: return 'Net battle'
    if p['smashDb'] >= 12: return 'Big hitting'
    if p['reactionDb'] >= 3.5: return 'They loved that one'
    return 'Great rally'
def rally_end(p):
    """The last shot of the rally itself. One to three sounds after a pause of three seconds are the players
    after the point: a ball sent back, a ball bounced, a high five (16:41 and 53:32 of the first match)."""
    h = p['hitTimes']
    for k in range(len(h) - 1, max(len(h) - 4, 0), -1):
        if h[k] - h[k - 1] >= 2.9: return h[k - 1]
    return h[-1]
clips = []
for p in chosen:
    # the end of a point matters most: a long rally joins late, never ends early
    pre = 16.0 if p is best else 12.0
    end = rally_end(p); hits = [h for h in p['hitTimes'] if h <= end]
    # nothing that might be the point is cut: the clip still runs to the last sound, but never long after the rally
    t0 = max(end - pre, p['firstHit'] - 2.5); t1 = min(p['clipEnd'], p['lastHit'] + 3.2, end + 6.5)
    c = {'kind': 'point', 't0': round(t0, 2), 't1': round(t1, 2), 'lastHit': end, 'hits': len(hits), 'score': p['score'], 'worth': p['worth'], 'near': p['near'], 'ends_sure': p['sure'],
         'title': title(p), 'hitTimes': hits, 'strongest': p['strongest'], 'reactionDb': p['reactionDb'], 'laugh': p['laugh'], 'best': p is best}
    if p is marathon:
        # the whole rally: the long middle runs fast, the last seconds at the true speed
        c['fast_from'] = round(p['firstHit'] - 1.5, 2); c['t0'] = round(end - 9.0, 2); c['marathon'] = True
    clips.append(c)
times = [p['start'] for p in pts] + [p['end'] for p in pts]
stats = {'rallies': len(pts), 'longest': max(p['hits'] for p in pts), 'shots': sum(p['hits'] for p in pts), 'minutes': int(round((max(times) - min(times)) / 60))}
json.dump({'t_start': t_start, 'clips': clips, 'stats': stats}, open(out, 'w'), indent=1)
def mm(t): return f'{int(t // 60)}:{int(t % 60):02d}'
for c in clips:
    print(f"{c['kind']:6s} {mm(c['t0']):>6s}  {c['t1'] - c['t0']:5.1f} s  near pair {c['near']}{'' if c['ends_sure'] else '?'}  hits {c['hits']:3d}  {c['title']}  worth {c['worth']}" + (f"  fast from {mm(c['fast_from'])}" if c.get('marathon') else ''))
print('near-pair balance of the points:', [sum(1 for c in clips if c['near'] == k) for k in (0, 1)], 'total seconds', round(sum(c['t1'] - c['t0'] for c in clips)))
print('stats', stats)
