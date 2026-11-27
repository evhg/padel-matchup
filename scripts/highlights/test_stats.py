"""Tests of stats.py and of the tiers of honest.py, on counts made by hand. Plain asserts, the standard library only.

usage: python3 scripts/highlights/test_stats.py        (prints "ok" and the number of checks, or fails at the first)
"""
import os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import stats, honest

CHECKS = 0


def check(cond, what):
    global CHECKS
    assert cond, what
    CHECKS += 1


def engine(games, ok=True):
    """A count in the shape of score_engine.py: games = [(set, server, serving pair, [winner of each point])]. A winner
    of None is an unseen point the engine added (it won for the game's winner); the serve times count up by ten."""
    rows = []; t = 100.0; sets = {}
    for st, server, serving, ws in games:
        g = sets.setdefault(st, [0, 0]); a = b = 0; won = [w for w in ws if w is not None]
        gw = max((0, 1), key=lambda k: won.count(k))
        for w in ws:
            x = gw if w is None else w
            r = {'set': st, 'server': server, 'won': x, 'confidence': 0.8, 'side_fits': True,
                 'before': {'serving': serving, 'sets': [0, 0], 'games': list(g), 'p': [a, b]}}
            if w is None: r.update(serve_t=None, unseen=True)
            else: r['serve_t'] = t; t += 10
            rows.append(r); a += x == 0; b += x == 1
        g[gw] += 1
    return {'pairs': ['A', 'B'], 'final': '', 'ok': ok, 'points': rows}


# a set of 1-2: pair 0 holds to love, pair 1 holds after 40-40 (advantage), then holds with one point lost
E = engine([(1, 'p0', 0, [0, 0, 0, 0]),
            (1, 'p1', 1, [1, 0, 0, 1, 0, 1, 1, 1]),
            (1, 'p2', 1, [1, 0, 1, 1, 1])])
S = stats.stats_of(E)
check(S['games'] == [[1, 2]], f"games per set {S['games']}")
check(S['in_a_row'] == {'pair': 1, 'games': 2, 'rests': 'games'}, f"games in a row {S['in_a_row']}")
check(S['breaks']['by'] == [0, 0], f"no break: each pair won its own serve {S['breaks']}")
check(S['deuce'] == {'won': [0, 1], 'of': 1, 'rests': 'points'}, f"one game at 40-40, won by pair 1 {S['deuce']}")
check(S['on_serve']['by_server'] == {'p0': [4, 4], 'p1': [5, 8], 'p2': [4, 5]}, f"points on serve {S['on_serve']['by_server']}")
check(S['on_serve']['by_pair'] == [[4, 4], [9, 13]], f"points on serve by pair {S['on_serve']['by_pair']}")

# breaks: each game goes to the pair that receives; an unseen point counts in the game, never in the points on serve
B = engine([(1, 'p0', 0, [1, 1, None, 0, 1]), (1, 'p1', 1, [0, 0, 0, 0]), (1, 'p0', 0, [1, 1, 1, 1])])
SB = stats.stats_of(B)
check(SB['breaks']['by'] == [1, 2], f"every game a break {SB['breaks']}")
check(SB['on_serve']['by_server']['p0'] == [1, 8], f"the unseen point is left out {SB['on_serve']['by_server']}")
check(SB['in_a_row']['games'] == 1, f"no run past one {SB['in_a_row']}")
check(SB['games'] == [[1, 2]], f"three games {SB['games']}")

# games in a row run across sets
R = engine([(1, 'p0', 0, [0, 0, 0, 0]), (1, 'p1', 1, [0, 0, 0, 0]), (2, 'p0', 0, [0, 0, 0, 0]), (2, 'p1', 1, [1, 1, 1, 1])])
check(stats.stats_of(R)['in_a_row']['games'] == 3, 'three games in a row over the end of a set')

# ways: a game of four has one way; a game of five has four (the lost point at any of the first four places)
check(stats.ways(4, [None] * 4, 0) == [(0, 0, 0, 0)], 'one way to win a game of four')
check(len(stats.ways(5, [None] * 5, 0)) == 4, 'four ways to win a game of five')
check(stats.ways(5, [1, None, None, None, None], 0) == [(1, 0, 0, 0, 0)], 'a sure point leaves one way')
check(stats.ways(3, [None] * 3, 0) == [], 'no way to win a game of three')
check(len(stats.ways(7, [None] * 7, 0)) > 0, 'a game of seven ends at a deciding point (golden)')

# forced: every point of a game of four, the last point of every game, and more where a point is sure
F = stats.forced(E)
check(all(F.get(t) == 0 for t in (100.0, 110.0, 120.0, 130.0)), f'a game of four is forced {F}')
check(F.get(210.0) == 1 and F.get(260.0) == 1, 'the last point of each game is forced')
check(F.get(200.0) == 1, 'a game of eight went 40-40, so its last two points are forced')
check(not any(t in F for t in (140.0, 150.0, 160.0, 170.0, 180.0, 190.0, 220.0)), 'a point before 40-40 is not forced alone')
F2 = stats.forced(E, sure={140.0: 1})
check(not any(t in F2 for t in (150.0, 160.0, 170.0, 180.0, 190.0)), 'one sure point of a game at 40-40 forces no other')
F3 = stats.forced(E, sure={230.0: 0})
check(all(F3.get(t) == 1 for t in (220.0, 240.0, 250.0)), f'one sure loss of five forces the rest {F3}')
check(stats.forced(engine([(1, 'p0', 0, [0, 0, 0, 0])], ok=False)) == {}, 'nothing is forced when the count is not sure')
check(stats.forced(B).get(100.0) is None and stats.forced(B).get(130.0) is not None, 'a game with an unseen point forces its last point only')

# honest.tiers: the three codes of the old verdict first
check(honest.tiers([None], 10)['why'] == 'no_score', 'no score')
check(honest.tiers(['6-0'], 10)['why'] == 'few_points', 'too few points')
t0 = honest.tiers(['6-0'], 30)
check(t0['why'] == 'no_winners' and not t0['sets_games'] and t0['winners'] == {}, 'no count: nothing is shown')
check(honest.tiers(['1-2'], 30, engine=dict(E, ok=False))['why'] == 'no_winners', 'a count that does not fit shows nothing')

rows = {'points': [{'serve_t': 100.0, 'before': {'games': [0, 0], 'points': ['0', '0']}}, {'serve_t': 140.0, 'before': {'games': [1, 0]}}]}
T = honest.tiers(['1-2'], 30, engine=E, rows=rows, detector={140.0: (1, 0.97), 150.0: (1, 0.97), 160.0: (0, 0.6)})
check(T['sets_games'] and T['why'] is None, 'a sure count shows the sets and the games')
check(T['points'] == [100.0], 'a point score only where score_rows gives one')
check(T['winners'][100.0] == [0, 'forced'] and T['winners'][260.0] == [1, 'forced'], 'forced winners stand')
check(T['winners'][140.0] == [1, 'detector'], 'a sure detector winner that the count keeps stands')
check(150.0 not in T['winners'], 'a sure detector winner that the count contradicts does not stand')
check(160.0 not in T['winners'], 'an unsure detector winner does not stand')

# honest.verdict did not change for the callers that pass no count
check(honest.verdict(['6-3 6-2'], 113) == (False, 'no_winners', 68), 'the old verdict')
check(honest.verdict(['6-3 6-2'], 113, 68) == (True, None, 68), 'the old verdict with sure winners')

# honest.strip: with no tier, as before; with a tier, only what its tier does not allow
P = {'card': {}, 'score_box': True, 'points': [{'id': 'a', 'serve_t': 100.0, 'won': 0}, {'id': 'b', 'serve_t': 140.0, 'won': 0}, {'id': 'c', 'serve_t': 150.0, 'won': 0}]}
gone = honest.strip(P, T)
check('score_box' in P and 'card' in P, 'the box stays when the games are sure')
check(P['points'][0].get('won') == 0, 'a forced winner stays')
check('won' not in P['points'][1], 'a winner that differs from the line goes')
check('won' not in P['points'][2] and gone == ['won:b', 'won:c'], f'a winner with no line goes {gone}')
P2 = {'card': {}, 'score_box': True, 'points': [{'id': 'a', 'won': 1}]}
check(honest.strip(P2) == ['card', 'score_box', 'won:a'] and P2 == {'points': [{'id': 'a'}]}, 'strip with no tier takes all')

print('ok', CHECKS, 'checks')
