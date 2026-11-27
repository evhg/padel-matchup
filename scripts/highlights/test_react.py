"""Tests of the pure parts of react.py on sightings made by hand. Plain asserts; numpy.

usage: python3 scripts/highlights/test_react.py        (prints "ok" and the number of checks, or fails at the first)
"""
import os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import react

n = 0


def check(cond, what):
    global n
    assert cond, what
    n += 1


def body(arm=False, head=False, face=False):
    return {'arm': arm, 'head': head, 'face': face}


def s(t, zone, x, y, **pose):
    return (t, zone, (x, y), body(**pose))


# pair 1 plays the near half (y < 10), pair 0 the far half; the dead ball is at t = 100
NEAR = 1
S = []
for k in range(80):
    t = 99.0 + k * 0.1
    after = t > 100.5
    # near pair: walks back from 8 m to 2 m from the net, partners stay 4 m apart
    S += [s(t, 'near', 3, 8 - (4 if after else 0)), s(t, 'near', 7, 8 - (4 if after else 0))]
    # far pair: stays at 12 m, partners meet in the middle after the point, heads down
    S += [s(t, 'far', 5 - (0.4 if after else 3), 11.5, head=after), s(t, 'far', 5 + (0.2 if after else 3), 11.5, head=after)]
v = react.votes(S, 100.0, 107.0, NEAR)
check(v['away8'] == -1, f'the near pair (pair 1) walked away from the net: a vote for pair 1 {v}')
check(v['close8'] == 1 and v['meet8'] == 1, f'the far pair (pair 0) came together and met: votes for pair 0 {v}')
check(v['head8'] == 1, f'the far pair (pair 0) dropped its heads more {v}')
check(v['net8'] == 1, f'the far pair (pair 0) stood nearer to the net {v}')
check(react.votes(S, 100.0, 100.8, NEAR) == {k: 0 for k in react.VOTES8}, 'less than a second after the point: no vote')
check(react.votes([], 100.0, 107.0, NEAR) == {k: 0 for k in react.VOTES8}, 'nobody seen: no vote')

# a pose: a wrist above the head is an arm up; the nose at the shoulders is a head down
kp = [[0, 0, 0]] * 17
def pose(nose_y, wrist_y):
    k = [list(p) for p in kp]
    k[0] = [50, nose_y, 0.9]; k[1] = [48, nose_y - 2, 0.9]; k[2] = [52, nose_y - 2, 0.9]
    k[5] = [40, 100, 0.9]; k[6] = [60, 100, 0.9]; k[11] = [42, 160, 0.9]; k[12] = [58, 160, 0.9]
    k[9] = [35, wrist_y, 0.9]; k[10] = [65, 150, 0.9]
    return react.pose(k)
check(pose(80, 60)['arm'] is True and pose(80, 140)['arm'] is False, 'a wrist above the nose is an arm up')
check(pose(98, 140)['head'] is True and pose(80, 140)['head'] is False, 'a nose at the shoulders is a head down')
check(pose(80, 140)['face'] is True, 'a nose and two eyes seen: the body faces the camera')

# crossings: one person walks over the net line after the point
C = [s(100.0 + k * 0.1, 'far', 5, 11.5 - k * 0.15) for k in range(30)]
check(react.crossings(C, 99.0, 104.0) == 1, f'one walk over the net line {react.crossings(C, 99.0, 104.0)}')
check(react.crossings([s(100.0 + k * 0.1, 'far', 5, 12) for k in range(30)], 99.0, 104.0) == 0, 'a person who stays: no crossing')
print('ok', n, 'checks')
