"""Tests of the pure parts of winner.py on flights and words made by hand. Plain asserts; numpy.

usage: python3 scripts/highlights/test_winner.py        (prints "ok" and the number of checks, or fails at the first)
"""
import os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import winner

n = 0


def check(cond, what):
    global n
    assert cond, what
    n += 1


def fl(t0, t1, hitter=None, bounce=None, catcher=None):
    return {'t0': t0, 't1': t1, 'hitter': {'at': hitter} if hitter else None, 'bounce': bounce, 'catcher': {'at': catcher} if catcher else None}


# pair 1 plays the near half (y < 10), pair 0 the far half
NEAR = 1
b = winner.ball([fl(10.0, 10.6, hitter=[3, 3], bounce=[4, 15])], 11.0, NEAR)
check(b['bounce'] == -1, f'the last bounce is in the far half: pair 0 lost, a vote for pair 1 {b}')
check(b['hitter'] == 1, f'the near hitter (pair 1) lost: a vote for pair 0 {b}')
check(b['crossed'] == -1, f'the near hit reached the far half: a vote for its own pair 1 {b}')
b = winner.ball([fl(10.0, 10.4, hitter=[3, 3], bounce=[4, 6])], 11.0, NEAR)
check(b['bounce'] == 1 and b['crossed'] == 1, f'into its own half (the net): pair 1 lost {b}')
check(winner.ball([fl(5.0, 5.5, hitter=[3, 3], bounce=[4, 6])], 11.0, NEAR) == {'bounce': 0, 'hitter': 0, 'crossed': 0}, 'a flight long before the dead ball votes nothing')
check(winner.ball([], 11.0, NEAR) == {'bounce': 0, 'hitter': 0, 'crossed': 0}, 'no flight, no vote')

# the voice: more words at the near recorder (left) after the dead ball is a vote for the near pair
words = {'left': [{'t': 101.0, 'kind': 'word'}, {'t': 101.5, 'kind': 'word'}], 'right': [{'t': 101.2, 'kind': 'word'}, {'t': 90.0, 'kind': 'word'}]}
off = {'left': 0.0, 'right': 0.0}
check(winner.voice(words, off, 100.0, NEAR) == -1, 'the near half spoke more: pair 1')
check(winner.voice(words, off, 100.0, NEAR, near_rec='right') == 1, 'with the recorders the other way: pair 0')
check(winner.voice(words, {'left': 50.0, 'right': 0.0}, 100.0, NEAR) == 1, 'the offset moves the words of a recorder')
check(winner.voice({'left': [], 'right': []}, off, 100.0, NEAR) == 0, 'silence votes nothing')

# the chance and the points file
row = {'serve_t': 5.0, 'votes': {'bounce': 1, 'voice': -1}}
check(winner.chance(row, {'bounce': 1.0, 'voice': 1.0}) == 0.5, 'votes that cancel give one half')
check(winner.chance(row, {'bounce': 2.0, 'voice': 1.0}) > 0.5, 'the heavier vote wins')
pf = winner.points_file([row], {'bounce': 1.0, 'voice': 1.0}, [{'serve_t': 5.2, 'server': 's', 'side': 'R'}], ['A', 'B'])
check(pf['points'][0]['winner'] is None and pf['points'][0]['side'] == 'R', f'no winner at one half; the reader keeps the side {pf}')
check(winner.points_file([row], {}, [{'serve_t': 20.0}], ['A', 'B'])['points'] == [], 'no reader row within 4 s: no point')

# fit: a vote that is always right gets a positive weight, one that is always wrong a negative weight
R = [{'votes': {'bounce': v, 'voice': -v}} for v in (1, -1) * 20]; Y = [0 if v == 1 else 1 for v in (1, -1) * 20]
w = winner.fit(R, Y, use=('bounce', 'voice'))
check(w['bounce'] > 0 > w['voice'], f'the signs of the weights {w}')
check(winner.right(R, Y, w) == (40, 40, 40), 'right on the points it was fitted on')
print('ok', n, 'checks')
