"""Tests of speed.py on flights made by hand. Plain asserts.

usage: python3 scripts/highlights/test_speed.py        (prints "ok" and the number of checks, or fails at the first)
"""
import os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import speed

n = 0


def check(cond, what):
    global n
    assert cond, what
    n += 1


def flight(y=14.0, rel=0.09, n_seen=48, secs=0.8, kmh=50.0, hitter=True):
    return {'t0': 100.0, 'n': n_seen, 'seconds': secs, 'kmh': kmh, 'rel': rel, 'to_what': 'bounce',
            'start': [5.0, y, 1.2], 'hitter': {'at': [5.0, y]} if hitter else None}


good = flight()
check(abs(speed.seen(good) - 48 / 49) < 1e-9, 'seen: 48 of 49 pictures at 59.94 a second')
check(speed.kept(good), 'a far drive, a good fit, the ball seen in 98% of its pictures: kept')
check(not speed.kept(flight(y=5.0)), 'a near hitter: not kept')
check(not speed.kept(flight(rel=0.11)), 'a fit error over 0.10: not kept')
check(not speed.kept(flight(n_seen=40)), 'the ball seen in 82% of the pictures: not kept')
check(not speed.kept(flight(kmh=25.0)) and not speed.kept(flight(kmh=170.0)), 'under 30 or over 160 km/h: not kept')
check(not speed.kept(flight(hitter=False)), 'no hitter: not kept')
check(not speed.kept({'n': 10}), 'a flight without a time: not kept')
F = {'p1': [good, flight(kmh=60.0), flight(y=5.0, kmh=90.0)], 'p2': [{'n': 3}]}
check([f['kmh'] for _, f in speed.shots(F)] == [60.0, 50.0], 'the kept shots of a match, the fastest first')
print('ok', n, 'checks')
