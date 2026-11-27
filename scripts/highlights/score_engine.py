"""The score of every point, counted backwards from what is sure: who serves, and the set scores a player typed.

usage: score_engine.py <out.json> "<sets as pair0-pair1, e.g. 3-6 2-6 1-6 0-6>" <points-*.json ...>   [TRUTH=<points.json>]

A reader (a person, frames, one day a detector) gives each point a winner and how sure it is. It is wrong for
about 3 points in 10. This file does not trust a winner by itself. It takes, for each set, the one way to give
every point a winner that
  - ends each game on its last point (a new server is a new game), by one of the rules friends play
    (two clear, a deciding point at 40-40, a deciding point at the third deuce),
  - gives each pair the games of the typed set score, the set's winner the last game,
  - and agrees with the reader as much as it can (the product of the reader's confidences is the largest).
Where no way fits, a game may hold one point the reader did not see (a quick point with no rally), at a price.

The side of the serve is a second witness of the count, and it does not depend on who won. The first point of a
game is served from the right, and the side changes with each point. So a point with "side" ("R" or "L") must
stand at an even or an odd place of its game. Two serves in a row from one side mean a point between them that
the reader did not see, and the unseen point goes there. A side that does not fit costs SIDE.
SIDES=<points files, with commas>: rows that only lend their "side" to a point of the log that has none (a person
who corrects the winners does not write the sides again).

Each row has "game_margin": how much more (log units) the cheapest count costs that gives its game to the other
pair (null: no count does). A weak reader still fits the typed score, and the margin says which games rest on it:
on match2 the readers' games of set 3 had 1.5 to 7.8 and were all right; with winner.py as the reader, the two wrong
games had 0.16 and 0.5 (README, "Who won the point, with no person"). honest.py shows a game only from log(19) up.
"""
import sys, os, json, math, itertools

out, final = sys.argv[1], sys.argv[2]; files = sys.argv[3:]
S = os.environ.get('HL_HOME') or os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MT = json.load(open(os.environ.get('HL_MATCH') or f'{S}/match/match.json'))
team_of = {MT['names'][k]: MT['team'][k] for k in MT['names']}
PAIR = [MT.get('team_a') or MT['pair_a'], MT.get('team_b') or MT['pair_b']]
MISS = float(os.environ.get('MISS', 2.5))        # the price (in log units) of one point the reader did not see
ODD = {'adv': 0.0, 'golden': 0.7, 'star': 0.7}   # the price of a rule at 40-40 that is not the usual one
SIDE = float(os.environ.get('SIDE', 3.0))        # the price of one serve from the wrong side for its place in the game


def pair(name):
    if not name: return None
    n = name.strip().lower()
    for i, p in enumerate(PAIR):
        if n == p.lower(): return i
    for k, v in team_of.items():
        if n == k.lower(): return v
    return None


def load(files):
    pts = []
    for f in files:
        for p in json.load(open(f))['points']:
            if p.get('kind', 'point') not in ('point', 'double fault'): continue
            pts.append(dict(p, src=os.path.basename(f), w=pair(p.get('winner')), st=pair(p.get('server'))))
    pts.sort(key=lambda p: p['serve_t']); merged = []
    for p in pts:
        if merged and abs(p['serve_t'] - merged[-1]['serve_t']) < 6.0 and p['src'] != merged[-1]['src']:
            if (p.get('confidence') or 0) > (merged[-1].get('confidence') or 0): merged[-1] = p
            continue
        merged.append(p)
    lend = [q for f in (os.environ.get('SIDES') or '').split(',') if f for q in json.load(open(f))['points'] if q.get('side') in ('R', 'L')]
    for p in merged:
        if p.get('side') not in ('R', 'L') and lend:
            q = min(lend, key=lambda q: abs(q['serve_t'] - p['serve_t']))
            if abs(q['serve_t'] - p['serve_t']) < 4.0: p['side'] = q['side']
    return merged


def side_cost(sides, miss):
    """The price of the serve sides for a game with an unseen point at place `miss` (None: no unseen point)."""
    bad = 0
    for i, sd in enumerate(sides):
        place = i if miss is None or i < miss else i + 1
        if sd in ('R', 'L') and sd != 'RL'[place % 2]: bad += 1
    return bad * SIDE


def over(a, b, mode):
    return max(a, b) >= 4 and (abs(a - b) >= 2 or mode == 'golden' or (mode == 'star' and a + b == 11))


def ends_on_last(ws, mode):
    a = b = 0
    for i, w in enumerate(ws):
        if w == 0: a += 1
        else: b += 1
        if over(a, b, mode): return (0 if a > b else 1) if i == len(ws) - 1 else None
    return None


def p0(p):
    """The reader's chance that pair 0 won this point."""
    if p['w'] is None: return 0.5
    c = min(0.95, max(0.55, float(p.get('confidence') or 0.6)))
    return c if p['w'] == 0 else 1 - c


def best_game(points):
    """-> {winner: (cost, [winner of each point], rule, index of an unseen point or None)}, the cheapest way for each winner."""
    pr = [p0(p) for p in points]; n = len(pr); res = {}; sides = [p.get('side') for p in points]
    cands = [(pr, None, side_cost(sides, None))]
    # one unseen point, at each place: the serve sides say which place fits
    for k in range(n + 1): cands.append((pr[:k] + [0.5] + pr[k:], k, MISS + side_cost(sides, k)))
    for prs, miss, price in cands:
        m = len(prs)
        if m > 13: continue
        for ws in itertools.product((0, 1), repeat=m):
            for mode in ('adv', 'golden', 'star'):
                w = ends_on_last(ws, mode)
                if w is None: continue
                cost = price + ODD[mode] - sum(math.log(q if x == 0 else 1 - q) for q, x in zip(prs, ws) if q != 0.5)
                if w not in res or cost < res[w][0] - 1e-9: res[w] = (cost, list(ws), mode, miss)
    return res


def solve_set(games, want, opts=None, force=None):
    """games: lists of points. want: (games of pair 0, games of pair 1). -> the winner of each game, the total cost.
    force: (index of a game, its winner), for the cheapest count in which that game goes the other way."""
    opts = opts or [best_game(g) for g in games]; n = len(games); setw = 0 if want[0] > want[1] else 1
    INF = 1e9; dp = {(0, 0): (0.0, [])}
    for gi in range(n):
        nd = {}
        for (a, b), (c, path) in dp.items():
            for w in (0, 1):
                if w not in opts[gi]: continue
                if force and force[0] == gi and w != force[1]: continue
                if gi == n - 1 and w != setw: continue
                na, nb = a + (w == 0), b + (w == 1)
                if na > want[0] or nb > want[1]: continue
                cc = c + opts[gi][w][0]
                if (na, nb) not in nd or cc < nd[(na, nb)][0]: nd[(na, nb)] = (cc, path + [w])
        dp = nd
    if tuple(want) not in dp: return None, opts
    return dp[tuple(want)], opts


merged = load(files)
games = []
for p in merged:
    if not games or p.get('server') != games[-1][0].get('server'): games.append([])
    games[-1].append(p)
want = [tuple(int(x) for x in s.split('-')) for s in final.split()]
need = sum(a + b for a, b in want)
print(f"{len(merged)} points, {len(games)} games; the typed score needs {need} games")
rows = []; gi = 0; ok = len(games) == need; sets = [0, 0]
if not ok: print('  the number of games does NOT fit: a server was read wrong, or a game is missing')
for si, wnt in enumerate(want):
    sg = games[gi:gi + sum(wnt)]; gi += sum(wnt)
    if len(sg) != sum(wnt): ok = False; break
    sol, opts = solve_set(sg, wnt)
    if sol is None: print(f"  set {si + 1}: no way to count it as {wnt[0]}-{wnt[1]}"); ok = False; continue
    cost, winners = sol; gm = [0, 0]; changed = unseen = 0
    # how sure each game's winner is: the extra cost (log units) of the cheapest count that gives it to the other pair.
    # A weak reader still fits the typed score; the margin says which games the fit rests on (honest.py, GAME_SURE).
    margins = []
    for k_, w_ in enumerate(winners):
        alt, _ = solve_set(sg, wnt, opts, (k_, 1 - w_)); margins.append(round(alt[0] - cost, 2) if alt else None)
    for g, o, w, margin in zip(sg, opts, winners, margins):
        c, ws, mode, miss = o[w]; a = b = 0; k = 0
        for j, x in enumerate(ws):
            real = None if miss == j else g[k]
            before = {'serving': g[0]['st'], 'sets': list(sets), 'games': list(gm), 'p': [a, b]}
            if x == 0: a += 1
            else: b += 1
            if real is None: unseen += 1; rows.append({'serve_t': None, 'unseen': True, 'set': si + 1, 'server': g[0].get('server'), 'won': x, 'game_margin': margin, 'before': before})
            else:
                if real['w'] is not None and real['w'] != x: changed += 1
                rows.append({'serve_t': real['serve_t'], 'dead_t': real.get('dead_t'), 'set': si + 1, 'server': real.get('server'), 'won': x, 'read': real['w'], 'confidence': real.get('confidence'), 'rule': mode, 'side': real.get('side'), 'side_fits': real.get('side') not in ('R', 'L') or real['side'] == 'RL'[j % 2], 'game_margin': margin, 'before': before}); k += 1
        gm[w] += 1
    sets[0 if wnt[0] > wnt[1] else 1] += 1
    print(f"  set {si + 1}: counted as {gm[0]}-{gm[1]}; {changed} winners changed against the reader, {unseen} unseen points added")
json.dump({'pairs': PAIR, 'final': final, 'ok': ok, 'points': rows}, open(out, 'w'), indent=1)

truth = os.environ.get('TRUTH')
if truth:
    T = [dict(p, w=pair(p.get('winner'))) for p in json.load(open(truth))['points'] if p.get('kind', 'point') in ('point', 'double fault')]
    hit = raw = n = miss = 0
    for t in T:
        r = min((x for x in rows if x['serve_t'] is not None), key=lambda x: abs(x['serve_t'] - t['serve_t']))
        if abs(r['serve_t'] - t['serve_t']) > 4: miss += 1; continue
        n += 1; hit += r['won'] == t['w']; raw += r['read'] == t['w']
    print(f"against the truth: {n} points matched ({miss} of the truth not in the reader's log). Reader alone {raw} of {n} right; engine {hit} of {n} right")
