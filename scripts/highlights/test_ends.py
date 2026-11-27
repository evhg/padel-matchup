"""Tests of the pure parts of ends.py on flights made by hand. Plain asserts.

usage: python3 scripts/highlights/test_ends.py        (prints "ok" and the number of checks, or fails at the first)
"""
import os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import ends

n = 0


def check(cond, what):
    global n
    assert cond, what
    n += 1


def fl(t0, t1, hitter=None, bounce=None, catcher=None):
    return {'t0': t0, 't1': t1, 'hitter': {'at': hitter} if hitter else None, 'bounce': bounce, 'catcher': {'at': catcher} if catcher else None}


DEAD = 20.0
check(ends.end_of([fl(18.0, 18.4, hitter=[3, 4], bounce=[4, 8])], DEAD) == ('net', 'near'), 'a near hit that bounced in its own half: the net')
check(ends.end_of([fl(18.0, 18.6, hitter=[3, 4], bounce=[4, 15]), fl(18.7, 19.2, bounce=[5, 17])], DEAD) == ('double', 'far'), 'two bounces in the far half')
check(ends.end_of([fl(18.0, 18.6, hitter=[3, 15], bounce=[4, 5])], DEAD) == ('unreturned', 'near'), 'a far hit that crossed and was not returned')
check(ends.end_of([fl(18.0, 18.6, hitter=[3, 4])], DEAD) == ('nobounce', 'near'), 'a hit with no bounce and no catcher')
check(ends.end_of([fl(18.0, 18.6, bounce=[4, 5])], DEAD) == ('none', None), 'no hit seen')
check(ends.end_of([fl(10.0, 10.6, hitter=[3, 4], bounce=[4, 8])], DEAD) == ('none', None), 'a hit long before the dead ball')

# votes: pair 1 plays the near half; the near pair lost a point into the net: a vote for pair 0
v, kind = ends.votes([fl(18.0, 18.4, hitter=[3, 4], bounce=[4, 8])], DEAD, 1)
check(kind == 'net' and v['endnet'] == 1 and v['endunret'] == 0, f'the near pair (pair 1) lost: +1 {v}')
v, kind = ends.votes([fl(18.0, 18.6, hitter=[3, 15], bounce=[4, 5])], DEAD, 1)
check(v['endunret'] == 1, f'the near pair (pair 1) did not return it: a vote for pair 0 {v}')

# merge: the crop's candidates replace the whole picture's inside the crop
a = {'frames': [{'t': 1.0, 'c': [[2, 50, 50, 30], [2, 500, 500, 40]]}]}
b = {'crop': [0, 0, 100, 100], 'frames': [{'t': 1.0, 'c': [[2, 60, 40, 20]]}]}
m = ends.merge(a, b)
check(m['frames'][0]['c'] == [[2, 500, 500, 40], [2, 60, 40, 20]], f'outside the crop from the whole picture, inside from the crop {m}')
print('ok', n, 'checks')
