"""The numbers of a match from the count of score_engine.py: games in a row, breaks, games at 40-40, points won on serve.

usage: stats.py <engine.json>        (prints the numbers)

`stats_of(engine)` reads the file that score_engine.py writes ("points": one row for each point, in order, with "set",
"server", "won", "before": {"serving", "games", "p"}, and "unseen" for a point the engine added). Pure, the standard
library only. A number says what it rests on ("rests"):
  games    the winner of each game: sure when the engine agrees with the typed score ("ok"), because a new server
           is a new game and the set scores fix who won the games
  points   the winner of each point: sure only where a person confirmed it or the game forces it (`forced`)
A reel shows a number that rests on points only when every point under it is sure (honest.py).
"""
import itertools, json, sys


def games_of(engine):
    """The games of the count, in order: [{"set", "server", "serving", "points": [rows]}]. A game is a run of rows with
    the same set, the same games before it and the same server. Pure."""
    out = []
    for r in engine.get('points', []):
        b = r.get('before') or {}
        k = (r.get('set'), tuple(b.get('games') or ()), r.get('server'))
        if not out or out[-1]['key'] != k:
            out.append({'key': k, 'set': r.get('set'), 'server': r.get('server'), 'serving': b.get('serving'), 'points': []})
        out[-1]['points'].append(r)
    return out


def winner_of(game):
    """The pair that won a game: the winner of its last point (the engine ends each game on its last point). Pure."""
    return game['points'][-1].get('won') if game['points'] else None


def _over(a, b, mode):
    return max(a, b) >= 4 and (abs(a - b) >= 2 or mode == 'golden' or (mode == 'star' and a + b == 11))


def ways(n, fixed, winner):
    """Every list of winners for a game of n points that ends on its last point, won by `winner`, by one of the rules
    friends play (two clear, a deciding point at 40-40, a deciding point at the third deuce), and keeps the winners in
    `fixed` (None: free). Pure."""
    out = []
    if n > 16: return out
    for ws in itertools.product((0, 1), repeat=n):
        if any(f is not None and f != w for f, w in zip(fixed, ws)): continue
        for mode in ('adv', 'golden', 'star'):
            a = b = 0; ok = False
            for i, w in enumerate(ws):
                a += w == 0; b += w == 1
                if _over(a, b, mode): ok = i == n - 1 and (0 if a > b else 1) == winner; break
            if ok: out.append(ws); break
    return out


def forced(engine, sure=None):
    """{serve_t: winner} of the points whose winner the count forces: every way to play the game (its number of points,
    its winner, the winners that are sure) gives the point the same winner. The last point of every game is forced; so
    is every point of a game of four. `sure`: {serve_t: winner} known for sure (a person, or a detector that is sure);
    default: the rows with confidence 1.0. A game with an unseen point or a serve from the wrong side forces only its
    last point. Pure."""
    out = {}
    if not engine.get('ok'): return out
    for g in games_of(engine):
        P = g['points']; w = winner_of(g)
        if w is None: continue
        if sure is None: fx = [r['won'] if r.get('confidence') == 1.0 and not r.get('unseen') else None for r in P]
        else: fx = [sure.get(r.get('serve_t')) for r in P]
        odd = any(r.get('unseen') or r.get('side_fits') is False for r in P)
        ws = [] if odd else ways(len(P), fx, w)
        for i, r in enumerate(P):
            if r.get('unseen') or r.get('serve_t') is None: continue
            if i == len(P) - 1: out[r['serve_t']] = w
            elif ws and len({x[i] for x in ws}) == 1: out[r['serve_t']] = ws[0][i]
    return out


def stats_of(engine):
    """The numbers of one count. -> {"ok", "games": [[a, b] per set], "in_a_row": {"pair", "games", "rests"},
    "breaks": {"by": [pair 0, pair 1], "rests"}, "deuce": {"won": [..], "of": n, "rests"},
    "on_serve": {"by_server": {name: [won, of]}, "by_pair": [[won, of], [won, of]], "rests": "points"}}.
    A point the engine added (unseen) counts in its game, never in "on_serve". Pure."""
    G = games_of(engine); sets = {}
    run_pair = None; run = best = 0; best_pair = None
    breaks = [0, 0]; deuce_won = [0, 0]; deuce_of = 0
    by_server = {}; by_pair = [[0, 0], [0, 0]]
    for g in G:
        w = winner_of(g)
        if w is None: continue
        s = sets.setdefault(g['set'], [0, 0]); s[w] += 1
        run = run + 1 if w == run_pair else 1; run_pair = w
        if run > best: best, best_pair = run, w
        if g['serving'] in (0, 1) and w != g['serving']: breaks[w] += 1
        a = b = 0; at_deuce = False
        for r in g['points']:
            if a >= 3 and b >= 3: at_deuce = True
            a += r.get('won') == 0; b += r.get('won') == 1
        if at_deuce: deuce_of += 1; deuce_won[w] += 1
        for r in g['points']:
            if r.get('unseen') or r.get('won') not in (0, 1) or g['serving'] not in (0, 1): continue
            hold = int(r['won'] == g['serving'])
            c = by_server.setdefault(r.get('server'), [0, 0]); c[0] += hold; c[1] += 1
            by_pair[g['serving']][0] += hold; by_pair[g['serving']][1] += 1
    return {'ok': bool(engine.get('ok')), 'games': [sets[k] for k in sorted(sets)],
            'in_a_row': {'pair': best_pair, 'games': best, 'rests': 'games'},
            'breaks': {'by': breaks, 'rests': 'games'},
            'deuce': {'won': deuce_won, 'of': deuce_of, 'rests': 'points'},
            'on_serve': {'by_server': by_server, 'by_pair': by_pair, 'rests': 'points'}}


if __name__ == '__main__':
    E = json.load(open(sys.argv[1])); S = stats_of(E)
    print(json.dumps(S, indent=1)); print('forced winners:', len(forced(E)), 'of', sum(1 for r in E['points'] if not r.get('unseen')))
