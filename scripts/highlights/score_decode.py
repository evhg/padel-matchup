"""The rules of padel as a teacher: find the score history that agrees best with weak guesses of who won each point.

usage: score_decode.py simulate [matches=300]
A detector says for each point which pair won, and is right with probability q. The decoder knows:
  - where each game starts and ends (a new server is a new game; the serve test gives this),
  - the rules of a game (four points, golden point at 3-3 or two clear with advantage) and of a tie-break,
  - optionally the final score of each set, typed by a player.
It returns the most probable winner of every point and game. No point is labelled by a person.
"""
import sys, math, random
GOLDEN = True
def game_over(a, b, tb=False):
    """-> 0 or 1 (the pair that won) or None, for a game (or a tie-break) at a points to b."""
    if tb: return 0 if (a >= 7 and a - b >= 2) else (1 if (b >= 7 and b - a >= 2) else None)
    if GOLDEN: return 0 if a == 4 else (1 if b == 4 else None)
    return 0 if (a >= 4 and a - b >= 2) else (1 if (b >= 4 and b - a >= 2) else None)
def play_game(p, tb=False):
    a = b = 0; seq = []
    while game_over(a, b, tb) is None:
        w = 0 if random.random() < p else 1; seq.append(w); a, b = (a + 1, b) if w == 0 else (a, b + 1)
    return seq, game_over(a, b, tb)
def play_match(best_of=3):
    """-> list of sets; a set is a list of games; a game is (points, winner, is tie-break)."""
    sets = []; won = [0, 0]; base = random.uniform(0.42, 0.58)
    while max(won) < (best_of + 1) // 2:
        g = [0, 0]; games = []; k = 0
        while True:
            tb = g == [6, 6]; p = min(0.9, max(0.1, base + (0.08 if k % 2 == 0 else -0.08)))     # the pair that serves wins a little more
            seq, w = play_game(p, tb); games.append((seq, w, tb)); g[w] += 1; k += 1
            if tb or (max(g) >= 6 and abs(g[0] - g[1]) >= 2): break
        sets.append(games); won[0 if g[0] > g[1] else 1] += 1
    return sets
def decode_game(obs, tb=False):
    """obs: for each point log P(observation | pair 0 won), log P(observation | pair 1 won).
    -> {winner: (log-likelihood, point winners)} over the point orders that end the game at exactly this length."""
    n = len(obs); best = {(0, 0): (0.0, [])}
    for i, (l0, l1) in enumerate(obs):
        nxt = {}
        for (a, b), (v, path) in best.items():
            if game_over(a, b, tb) is not None: continue                       # the game was over before: not a valid order
            for w, l in ((0, l0), (1, l1)):
                s = (a + 1, b) if w == 0 else (a, b + 1); c = (v + l, path + [w])
                if s not in nxt or c[0] > nxt[s][0]: nxt[s] = c
        best = nxt
    out = {}
    for (a, b), (v, path) in best.items():
        w = game_over(a, b, tb)
        if w is not None and (w not in out or v > out[w][0]): out[w] = (v, path)
    return out
def set_over(a, b): return (max(a, b) >= 6 and abs(a - b) >= 2) or max(a, b) == 7
def decode_set(games_obs, final=None):
    """games_obs: [(obs of the game, is tie-break)]. final: (games of pair 0, games of pair 1) or None.
    -> for each game (winner, point winners): the best choice with a valid order of games (and the typed score)."""
    opts = [decode_game(o, tb) for o, tb in games_obs]; best = {(0, 0): (0.0, [])}
    for i, o in enumerate(opts):
        nxt = {}
        for (a, b), (v, path) in best.items():
            if set_over(a, b): continue
            for w, (l, pts) in o.items():
                s = (a + 1, b) if w == 0 else (a, b + 1); c = (v + l, path + [(w, pts)])
                if s not in nxt or c[0] > nxt[s][0]: nxt[s] = c
        best = nxt
    ends = {s: c for s, c in best.items() if (final is None or s == tuple(final))}
    if not ends: ends = best
    return max(ends.values(), key=lambda c: c[0])[1] if ends else [(0, [0] * len(o)) for o, _ in games_obs]
def trial(q, use_final, n):
    lq, lr = math.log(q), math.log(1 - q); pt = pc = gt = gc = st = sc = raw = 0
    for _ in range(n):
        for games in play_match():
            obs = []
            for seq, w, tb in games:
                g = []
                for x in seq:
                    seen = x if random.random() < q else 1 - x; raw += seen == x
                    g.append((lq, lr) if seen == 0 else (lr, lq))
                obs.append((g, tb))
            final = (sum(1 for _, w, _ in games if w == 0), sum(1 for _, w, _ in games if w == 1)) if use_final else None
            dec = decode_set(obs, final); ok_so_far = True
            for (seq, w, tb), (dw, dpts) in zip(games, dec):
                gt += 1; gc += dw == w
                for x, y in zip(seq, dpts):
                    pt += 1; pc += x == y; ok_so_far = ok_so_far and x == y; st += 1; sc += ok_so_far       # the score on screen is right only while every point before it is right
    return raw / pt, pc / pt, gc / gt, sc / st
if __name__ == '__main__' and len(sys.argv) > 1 and sys.argv[1] == 'simulate':
    n = int(sys.argv[2]) if len(sys.argv) > 2 else 300; random.seed(7)
    for golden in (True, False):
        GOLDEN = golden; print('golden point' if golden else 'advantage')
        print('  detector right | typed final score | points right | games right | score on screen right')
        for q in (0.6, 0.7, 0.8, 0.9, 0.95):
            for uf in (False, True):
                raw, p, g, s = trial(q, uf, n)
                print(f'  {raw * 100:13.0f}% | {"yes" if uf else "no ":17s} | {p * 100:11.1f}% | {g * 100:10.1f}% | {s * 100:6.1f}%')

def trial2(sure_share, q_sure, use_final, n):
    """A more real detector: for a share of the points it is nearly sure (right with q_sure), for the others it does not know.
    -> points right, games right, and how often the score on screen (games of the set, points of the game) is exactly right."""
    pt = pc = gt = gc = st = sc = 0
    for _ in range(n):
        for games in play_match():
            obs = []
            for seq, w, tb in games:
                g = []
                for x in seq:
                    if random.random() < sure_share:
                        seen = x if random.random() < q_sure else 1 - x
                        g.append((math.log(q_sure), math.log(1 - q_sure)) if seen == 0 else (math.log(1 - q_sure), math.log(q_sure)))
                    else: g.append((math.log(0.5), math.log(0.5)))
                obs.append((g, tb))
            final = (sum(1 for _, w, _ in games if w == 0), sum(1 for _, w, _ in games if w == 1)) if use_final else None
            dec = decode_set(obs, final); ta = tb_ = da = db = 0
            for (seq, w, tb), (dw, dpts) in zip(games, dec):
                gt += 1; gc += dw == w; a = b = c = d = 0
                for x, y in zip(seq, dpts):
                    pt += 1; pc += x == y
                    a, b = (a + 1, b) if x == 0 else (a, b + 1); c, d = (c + 1, d) if y == 0 else (c, d + 1)
                    st += 1; sc += (ta, tb_, a, b) == (da, db, c, d)
                ta, tb_ = (ta + 1, tb_) if w == 0 else (ta, tb_ + 1); da, db = (da + 1, db) if dw == 0 else (da, db + 1)
    return pc / pt, gc / gt, sc / st
if __name__ == '__main__' and len(sys.argv) > 1 and sys.argv[1] == 'simulate2':
    n = int(sys.argv[2]) if len(sys.argv) > 2 else 300; random.seed(11); GOLDEN = True
    print('share of points the detector is sure of | how often it is right there | typed final | points right | games right | score on screen right')
    for share, qs in ((1.0, 0.8), (1.0, 0.9), (1.0, 0.95), (1.0, 0.98), (0.6, 0.97), (0.8, 0.97), (0.9, 0.98), (1.0, 0.995)):
        for uf in (False, True):
            p, g, s = trial2(share, qs, uf, n)
            print(f'  {share * 100:5.0f}% | {qs * 100:5.1f}% | {"yes" if uf else "no "} | {p * 100:5.1f}% | {g * 100:5.1f}% | {s * 100:5.1f}%')
