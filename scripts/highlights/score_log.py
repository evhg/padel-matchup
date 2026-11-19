"""From a log of every point of a match to the score at every point, with the rules of padel as the check.

usage: score_log.py <out.json> "<final sets, e.g. 6-3 6-2 6-1 6-0>" <points-A.json> [<points-B.json> ...]

A point log (one file for each stretch of the match; stretches may overlap) has
  {"points": [{"serve_t": s, "server": name, "side": "R"|"L", "kind": "point"|"let"|"double fault"|"not a point",
               "dead_t": s, "winner": pair name | "unclear", "confidence": 0-1, ...}], ...}
and match.json (HL_MATCH, default match/match.json under HL_HOME) says which player is in which pair.

Who made the log does not matter here: a person, a reader of frames, one day a detector. This file only does what
the rules allow, and it says where the log and the rules do not agree:
- a new server is a new game; inside a game the points are counted to four, two clear, or to a deciding point at
  40-40. Friends use both in one match (one set with advantage, the next with a deciding point), so each game
  is tried with both rules and keeps the one that makes it end on its last point;
- the side of a serve says how many points the game has had (right = even): a point on the wrong side is reported;
- a point with no clear winner is filled in only when exactly one answer makes its game end where it ended;
- the sets are counted from the games, and the result is compared with the final score a player typed.

The score box of a reel is drawn from this file only when "verdict" is "agrees with the final score". The score of
the fifth reel had no such check: it named a winner who had hit the ball out.
"""
import sys, os, json, itertools

out, final = sys.argv[1], sys.argv[2]; files = sys.argv[3:]
S = os.environ.get('HL_HOME') or os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MT = json.load(open(os.environ.get('HL_MATCH') or f'{S}/match/match.json'))
team_of = {MT['names'][k]: MT['team'][k] for k in MT['names']}
PAIR = [MT.get('team_a') or MT['pair_a'], MT.get('team_b') or MT['pair_b']]
WORD = ['0', '15', '30', '40']


def pair(name):
    """The pair (0 or 1) that a name of a pair or of a player means, or None."""
    if not name: return None
    n = name.strip().lower()
    for i, p in enumerate(PAIR):
        if n == p.lower(): return i
    for k, v in team_of.items():
        if n == k.lower(): return v
    return None


# 1. one list of points in the order of play; a point that two stretches both have is taken once (the surer one)
pts = []
for f in files:
    for p in json.load(open(f))['points']:
        if p.get('kind', 'point') not in ('point', 'double fault'): continue
        p = dict(p, src=os.path.basename(f), w=pair(p.get('winner')), st=pair(p.get('server'))); pts.append(p)
pts.sort(key=lambda p: p['serve_t']); merged = []
for p in pts:
    if merged and abs(p['serve_t'] - merged[-1]['serve_t']) < 6.0 and p['src'] != merged[-1]['src']:
        if (p.get('confidence') or 0) > (merged[-1].get('confidence') or 0): merged[-1] = p
        continue
    merged.append(p)

# 2. games: a new server is a new game
games = []
for p in merged:
    if not games or p.get('server') != games[-1]['server']: games.append({'server': p.get('server'), 'st': p['st'], 'points': []})
    games[-1]['points'].append(p)


def play(ws, golden):
    """Walk a game. ws: the winner (0 or 1) of each point. -> (the winner of the game or None, the index of the
    point that ended it or None, the score before each point as [a, b])."""
    a = b = 0; before = []
    for i, w in enumerate(ws):
        before.append([a, b])
        if w == 0: a += 1
        else: b += 1
        if (golden and max(a, b) >= 4) or (not golden and max(a, b) >= 4 and abs(a - b) >= 2): return (0 if a > b else 1), i, before
    return None, None, before


def fits(ws, golden): w, i, _ = play(ws, golden); return w is not None and i == len(ws) - 1


def rule(ws):
    """The rule at 40-40 that makes this game end on its last point: True (deciding point), False (advantage), or
    None when neither does. A game that never reached 40-40 fits both, and the answer is the match's usual rule."""
    return next((r for r in (GOLDEN, not GOLDEN) if fits(ws, r)), None)


# 3. which rule at 40-40? A game that goes on after 4-3 was played with advantage.
long_games = [g for g in games if len(g['points']) > 7]
GOLDEN = not long_games
notes = []; filled = 0
for gi, g in enumerate(games):
    ws = [p['w'] for p in g['points']]; unk = [i for i, w in enumerate(ws) if w is None]; g['n'] = gi + 1
    if unk:
        ok = [c for c in itertools.product((0, 1), repeat=len(unk)) if rule([c[unk.index(i)] if i in unk else w for i, w in enumerate(ws)]) is not None] if len(unk) <= 6 else []
        if len(ok) == 1:
            for i, c in zip(unk, ok[0]): g['points'][i]['w'] = c; g['points'][i]['filled'] = True; filled += 1
            ws = [p['w'] for p in g['points']]
        else: g['bad'] = f'{len(unk)} points with no clear winner and {len(ok)} ways to end the game'; notes.append(f"game {gi + 1} ({g['server']}): {g['bad']}"); continue
    r = rule(ws); w, i, before = play(ws, GOLDEN if r is None else r)
    if w is None: g['bad'] = 'the points do not end a game'
    elif i != len(ws) - 1: g['bad'] = f'the game is won at point {i + 1} of {len(ws)}'
    else: g['winner'] = w; g['before'] = before; g['golden'] = r
    if g.get('bad'): notes.append(f"game {gi + 1} ({g['server']}): {g['bad']}")
    for k, p in enumerate(g['points']):
        if p.get('side') in ('R', 'L') and (p['side'] == 'R') != (k % 2 == 0): notes.append(f"game {gi + 1} point {k + 1} at {p['serve_t']:.1f}: served from the {p['side']} side, the count says the other")

# 4. sets, and the score before and after every point
want = [tuple(int(x) for x in s.split('-')) for s in final.split()]
sets = [0, 0]; gm = [0, 0]; got = []; rows = []; good = True; prev = None
for g in games:
    # inside a set the two pairs serve in turn; a new set may start with either pair
    if prev is not None and gm != [0, 0] and g['st'] is not None and g['st'] == prev['st']: notes.append(f"games {prev['n']} and {g['n']}: the same pair serves two games in a row")
    prev = g
    if 'winner' not in g: good = False
    for k, p in enumerate(g['points']):
        if 'winner' in g:
            a, b = g['before'][k]
            def words(a, b):
                if a >= 3 and b >= 3: return ['40', '40'] if a == b else (['AD', '40'] if a > b else ['40', 'AD'])
                return [WORD[min(a, 3)], WORD[min(b, 3)]]
            st = {'serving': g['st'], 'sets': list(sets), 'games': list(gm), 'points': words(a, b)}
            last = k == len(g['points']) - 1
            a2, b2 = (a + 1, b) if p['w'] == 0 else (a, b + 1)
            if last:
                g2 = list(gm); g2[g['winner']] += 1; s2 = list(sets)
                if max(g2) >= 6 and abs(g2[0] - g2[1]) >= 2: s2[g['winner']] += 1; g2 = [0, 0]
                en = {'serving': None, 'sets': s2, 'games': g2, 'points': ['0', '0']}
            else: en = {'serving': g['st'], 'sets': list(sets), 'games': list(gm), 'points': words(a2, b2)}
            rows.append({'serve_t': p['serve_t'], 'dead_t': p.get('dead_t'), 'server': p.get('server'), 'side': p.get('side'), 'game': g['n'], 'won': p['w'], 'filled': bool(p.get('filled')),
                         'confidence': p.get('confidence'), 'how': p.get('how'), 'before': st, 'after': en, 'sure': good})
        else: rows.append({'serve_t': p['serve_t'], 'server': p.get('server'), 'game': g['n'], 'won': p['w'], 'sure': False})
    if 'winner' in g:
        gm[g['winner']] += 1
        if max(gm) >= 6 and abs(gm[0] - gm[1]) >= 2: got.append(tuple(gm)); sets[g['winner']] += 1; gm = [0, 0]
if gm != [0, 0]: got.append(tuple(gm))
same = [tuple(sorted(x)) for x in got] == [tuple(sorted(x)) for x in want] and not notes
verdict = 'agrees with the final score' if same else 'does NOT agree with the final score'
json.dump({'pairs': PAIR, 'golden_point': GOLDEN, 'final': final, 'sets_found': got, 'verdict': verdict, 'notes': notes, 'filled_by_the_rules': filled,
           'games': [{'n': g['n'], 'server': g['server'], 'points': len(g['points']), 'winner': PAIR[g['winner']] if 'winner' in g else None, 'bad': g.get('bad'),
                      't0': g['points'][0]['serve_t'], 't1': g['points'][-1].get('dead_t')} for g in games], 'points': rows}, open(out, 'w'), indent=1)
print(f"{len(merged)} points, {len(games)} games, sets found {' '.join('%d-%d' % x for x in got)}; final score {final}: {verdict}")
print(f"golden point: {GOLDEN}; winners filled in by the rules: {filled}")
for n in notes: print(' -', n)
