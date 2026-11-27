"""Tests of serve_find.py on made-up pictures, flights and sound. Plain asserts.

usage: python3 scripts/highlights/test_serve_find.py        (numpy and scipy; prints "ok" and the number of checks)
"""
import os, sys
import numpy as np
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import serve_find as sf

CHECKS = 0


def check(cond, what):
    global CHECKS
    assert cond, what
    CHECKS += 1


def person(x, y, h, zone):
    kp = [[x, y - h * 0.9, 0.9]] * 15 + [[x - 5, y, 0.9], [x + 5, y, 0.9]]
    return {'box': [x - h / 4, y - h, x + h / 4, y, 0.9], 'zone': zone, 'score': 0.9, 'kp': kp}


def film(serve=10.0, fps=10.0, end=20.0, cut_server=True):
    """Four players: still from 3 s to the serve (the near server under the camera: a cut box that moves), then all
    run from 0.3 s after the serve; before 3 s they walk to their places."""
    fr = []
    for i in range(int(end * fps)):
        t = round(i / fps, 2); run = t >= serve + 0.3; walk = t < 3.0
        d = (t - serve - 0.3) * 300 if run else (3.0 - t) * 150 if walk else 0.0
        ps = [person(900 + d, 380, 80, 'far'), person(1100 - d, 370, 80, 'far'), person(700 + d, 600, 260, 'near')]
        if cut_server: ps.append(person(300 + 40 * np.sin(t * 7), 1075, 450, 'near'))
        fr.append({'t': t, 'people': ps})
    return fr


fr = film()
t, a = sf.activity(fr)
check(a[(t > 4) & (t < 9.9)].max() < sf.CALM, 'the wait is calm (the cut box of the near server does not count)')
check(a[(t > 10.6) & (t < 12)].min() >= sf.FAST, 'the play is fast')
ons = sf.onsets(t, a)
check(len(ons) == 1 and abs(ons[0][0] - (10.0 + 0.3 + 0.1 - sf.LAG)) <= 0.15, f'one onset at the serve: {ons}')
check(sf.choose(t, a, ons, 0, 20) == ons[0][0], 'choose takes it')
check(sf.choose(t, a, ons, 12, 20) is None, 'nothing in a clip after it')

t3, a3 = sf.activity(fr[::3], boxes=True)
o3 = sf.onsets(t3, a3)
check(len(o3) == 1 and abs(o3[0][0] - 10.0) <= 0.5, f'boxes at 3 a second find it too: {o3}')

# a first serve into the net: a short play, a wait, then the second serve and a long rally
f1 = film(serve=6.0, end=8.0); f2 = film(serve=13.0, end=25.0)
two = [f for f in f1 if f['t'] < 7.2] + [{'t': f['t'], 'people': f['people']} for f in f2 if f['t'] >= 8.5]
t2, a2 = sf.activity(two); o2 = sf.onsets(t2, a2)
check(len(o2) == 2, f'two onsets: {o2}')
check(abs(sf.choose(t2, a2, o2, 0, 25) - o2[1][0]) < 1e-9, 'the second serve: its play is the longer one')

# the ball, on court.py's own court (the net's row at 1140 in a 3840 x 2160 camera file): the serve's flight goes from
# the server's half towards the net; a bounce before it, a ball on the next court and a short flight do not count
bounce = {'t': [9.6 + i / 60 for i in range(20)], 'uv': [[1800, 1600 - 3 * i] for i in range(20)]}
nextc = {'t': [9.7 + i / 60 for i in range(40)], 'uv': [[5 + 10 * i, 1500 - 20 * i] for i in range(40)]}
near = {'t': [10.2 + i / 60 for i in range(30)], 'uv': [[1980 + 30 * i, 1580 - 25 * i] for i in range(30)]}
far = {'t': [20.1 + i / 60 for i in range(30)], 'uv': [[1900 + 20 * i, 1040 + 11 * i] for i in range(30)]}
check(sf.serve_flight([bounce, nextc, near], 1140, 9, 11) == (10.2, 'near'), 'a near serve from the ball')
check(sf.serve_flight([far], 1140, 19, 21) == (20.1, 'far'), 'a far serve')
check(sf.serve_flight([near], 1140, 10.5, 11) is None, 'a flight that starts outside the window does not count')
check(sf.serve_flight([{'t': near['t'][:8], 'uv': near['uv'][:8]}], 1140, 9, 11) is None, 'a short flight does not count')

# the sound: a click 0.1 s before the ball's first picture
sr = 16000; x = np.random.default_rng(1).normal(0, 0.01, sr * 4).astype(np.float32)
k = int(2.0 * sr); x[k:k + 80] += np.random.default_rng(2).normal(0, 0.3, 80).astype(np.float32)
check(sf.sound_hit(x, sr, 2.1) == 2.0, f'the click: {sf.sound_hit(x, sr, 2.1)}')
check(sf.sound_hit(x, sr, 3.0) is None, 'no click near 3.0')
check(sf.sound_hit(x, sr, 0.5) is None, 'too near the start of the sound')

print('ok', CHECKS)
