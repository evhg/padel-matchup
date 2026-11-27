"""Tests of the pure parts of swing.py on poses made by hand. Plain asserts.

usage: python3 scripts/highlights/test_swing.py        (prints "ok" and the number of checks, or fails at the first)
"""
import os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import swing

n = 0


def check(cond, what):
    global n
    assert cond, what
    n += 1


def person(zone, x, wrist_y, h=100):
    kp = [[x, 0, 0.0] for _ in range(17)]
    kp[swing.LWR] = [x, wrist_y, 0.9]; kp[swing.RWR] = [x, wrist_y, 0.9]
    return {'box': [x - 20, 0, x + 20, h], 'zone': zone, 'score': 0.9, 'kp': kp}


# 30 pictures a second; the far player (box 100 px high) moves a wrist 30 px in one picture at t = 99.0: 9 box heights a
# second; the near player stands still
frames = []
for k in range(90):
    t = round(97.0 + k / 30, 3)
    frames.append({'t': t, 'people': [person('far', 500, 50 + (30 if t >= 99.0 else 0)), person('near', 900, 60)]})
walk = {'t0': 97.0, 'fps': 30.0, 'frames': frames}
s = swing.swings(walk, 97.0, 100.0, 5.0)
check(len(s) == 1 and s[0][1] == 'far' and abs(s[0][0] - 99.0) < 0.04, f'one swing of the far player at 99.0 {s}')
check(swing.swings(walk, 97.0, 100.0, 10.0) == [], 'a threshold above 9 box heights a second: no swing')
check(swing.votes(walk, 100.0, 1, 5.0) == {'swing': 1}, 'the far half (pair 0 when pair 1 is near) swung last: +1')
check(swing.votes(walk, 100.0, 0, 5.0) == {'swing': -1}, 'the far half is pair 1: -1')
check(swing.votes(None, 100.0, 0, 5.0) == {'swing': 0}, 'no walk file: no vote')
low = {'t0': 97.0, 'fps': 30.0, 'frames': [dict(f, people=[dict(p, kp=[[a, b, 0.1] for a, b, _ in p['kp']]) for p in f['people']]) for f in frames]}
check(swing.swings(low, 97.0, 100.0, 5.0) == [], 'wrists with a low score: no swing')
print('ok', n, 'checks')
