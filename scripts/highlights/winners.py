"""Turn the line from the labelling page into the list of points with their winner.

usage: winners.py <cands.json> "<Who won: 1A 2B 3? ...>" <out.json>
A = the first pair of match.json (pair 0), B = the second (pair 1). A point with "?" has no winner and is left out.
"N" is a candidate that was not a point (a warm-up, a pause, a ball of another court); those go to 'not_points'.
"""
import sys, json, re
cands, line, out = sys.argv[1:4]
C = {c['i'] + 1: c for c in json.load(open(cands))}
pts, nots = [], []
for n, w in re.findall(r'\b(\d+)([ABN?])', line.split('(')[0]):
    c = C.get(int(n))
    if c and w in 'AB': pts.append({'n': int(n), 'firstHit': c['firstHit'], 'won': 'AB'.index(w)})
    if c and w == 'N': nots.append(int(n))
json.dump({'points': pts, 'not_points': nots}, open(out, 'w'), indent=1)
print('points with a winner:', len(pts), 'pair 0:', sum(1 for p in pts if p['won'] == 0), 'pair 1:', sum(1 for p in pts if p['won'] == 1))
