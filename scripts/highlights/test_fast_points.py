"""Tests of fast_points.py's checks of everyone on the court (court counts made by hand). Plain asserts.

usage: python3 scripts/highlights/test_fast_points.py        (numpy and scipy; prints "ok" and the number of checks)

The numbers are those of the whole film of 27 November 2026 (README, "Every clip is a point"): six points with a
player in each half 87 to 100% of the rally and 8 to 22 ball flights in each 10 s; a break with 44% and 3.0.
"""
import os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import fast_points as fp

CHECKS = 0


def check(cond, what):
    global CHECKS
    assert cond, what
    CHECKS += 1


def frames(a, b, far, near, whole=None, step=1 / 3):
    """Court counts at 3 a second from a to b: `far` and `near` players in each frame, `whole` of the near ones not cut
    off by the picture's edge (all of them unless given)."""
    out, t = [], a
    while t <= b + 1e-9:
        out.append((round(t, 3), far, near, near if whole is None else whole)); t += step
    return out


# a rally: two players in each half the whole time, and 15 flights in 10 s
rally = frames(10, 20, 2, 2)
oc = fp.on_court(rally, 10, 20)
check(oc['both'] == 1.0 and oc['three'] == 1.0, f'a rally on the court {oc}')
check(fp.not_a_point(oc, [10 + i * 0.66 for i in range(15)], 10, 20) is None, 'a rally is a point')

# the break of that morning: the far half empty for most of it, two players who walk back
brk = frames(20, 32, 0, 1) + frames(32.33, 54, 1, 2)[::2] + frames(32.66, 54, 0, 2)[::2]
brk.sort()
oc = fp.on_court(brk, 20, 54)
check(oc['both'] < fp.BOTH_HALVES, f'a break: one half empty {oc}')
check(fp.not_a_point(oc, None, 20, 54) == 'half_empty', 'a break is not a point')

# both halves on the court, but almost no ball in the air: players who wait at their places
check(fp.not_a_point(fp.on_court(rally, 10, 20), [11.0, 17.0], 10, 20) == 'few_flights', 'two flights in 10 s')
# no ball step: the court decides alone; a short stretch is not judged by its flights
check(fp.not_a_point(fp.on_court(rally, 10, 20), None, 10, 20) is None, 'no ball file')
check(fp.not_a_point(fp.on_court(rally, 10, 12), [], 10, 12) is None, 'under 3 s: no flight rate')
# no court counts at all (an older work folder): nothing is left out for them
check(fp.on_court(None, 10, 20) is None and fp.not_a_point(None, None, 10, 20) is None, 'no detector files')

# the clip opens when two players are on the court, wherever they are: the far pair that serves while the near pair
# waits under the phone (the near half empty until 71.9 s, the far pair there from 66.9 s)
serve = frames(66.9, 71.5, 2, 0) + frames(71.9, 93, 2, 2)
check(abs(fp.first_on_court(serve, 66.87, 93.13) - 66.9) < 0.01, 'the far pair opens the clip')
check(fp.first_on_court(frames(20, 30, 0, 1), 20, 30) is None, 'one player is not play')
check(fp.first_on_court(serve, 80, 79) is None, 'an empty window')

# everyone in the picture although the tracker named the near pair wrongly: three or more on the court
check(fp.on_court(frames(170, 189, 2, 2), 170, 189)['three'] >= fp.ON_COURT_KEEP, 'four players on the court')
check(fp.on_court(frames(10, 20, 0, 1), 10, 20)['three'] < fp.ON_COURT_KEEP, 'one player on the court')
# 25 November 2026: the far pair small, the near pair cut off at the edges (legs, an arm and a racket): it plays, so it
# is a point, but the players are not in the picture
cut = fp.on_court(frames(144.9, 150.9, 2, 2, whole=0), 144.9, 150.9)
check(cut['both'] == 1.0 and fp.not_a_point(cut, None, 144.9, 150.9) is None, 'cut-off players still play')
check(cut['three'] < fp.ON_COURT_KEEP, 'cut-off players are not in the picture')

print('ok', CHECKS, 'checks')
