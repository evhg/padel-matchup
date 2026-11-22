"""Flights of the ball from the candidates of ball_places.py: who hit, where the ball bounced, how fast it was.

usage: flight.py <ball dir> <walk dir> <out.json> [point ...]
env: HL_HOME (match/court-H.json and match/camera-points.json: eight measured points, some of them on the net)

A candidate is a small yellow island in one picture. A flight is a chain of candidates that moves like a free ball:
each step continues the step before it. A hit, a bounce or a wall breaks the chain, so one chain is one free flight.
A shot that can be timed: the chain starts at a person (the hitter), a ball from another direction ended at that
person just before (so the hit is seen), and the chain ends at a bounce on the court or at a person of the other half.
  distance: from the place of the first picture, on the line of sight at the depth where the hitter stands,
            to the place of the bounce on the floor (or to the other person).   time: between the two events.
One camera does not see depth. Gravity bends the path, and a fit of a free flight reads the depth from the bend, but
spin changes the bend: the fit was 0.9 m short on a smash and 3 m short on a drive. So the fit only says if a chain
is one flight (to cut a chain at a bounce and to join two parts), and the depth comes from the hitter and the floor.
The result is a list of candidates, not of speeds. A low volley looks like a bounce, and a chain can start late:
modal/strip.py cuts the pictures around both ends, and a reader names the picture of each contact (README).
"""
import json, sys, os, glob, numpy as np, cv2
from scipy.optimize import least_squares
import court_map

S = os.environ.get('HL_HOME') or os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SMIN = 16.0; SSEED = 28.0; SMEAN = 26.0          # the strength of a candidate: to count, to start a chain, mean of a chain
G = 9.81; DRAG = 0.0198                          # 1/m: half of air density x drag number 0.55 x area / mass of a padel ball


def camera():
    pts = json.load(open(f'{S}/match/camera-points.json')); W, H = pts['size']; K0 = np.array([[1700., 0, W / 2], [0, 1700., H / 2], [0, 0, 1]])
    obj = np.array([p['court'] for p in pts['points']], np.float32); img = np.array([p['picture'] for p in pts['points']], np.float32)
    fl = cv2.CALIB_USE_INTRINSIC_GUESS | cv2.CALIB_FIX_PRINCIPAL_POINT | cv2.CALIB_FIX_ASPECT_RATIO | cv2.CALIB_ZERO_TANGENT_DIST | cv2.CALIB_FIX_K1 | cv2.CALIB_FIX_K2 | cv2.CALIB_FIX_K3
    rms, K, _, rv, tv = cv2.calibrateCamera([obj], [img], (W, H), K0, np.zeros(5), flags=fl)
    R, _ = cv2.Rodrigues(rv[0]); t = tv[0].ravel(); return {'K': K, 'R': R, 't': t, 'C': -R.T @ t, 'rms': rms, 'scale': W / 1920.0}


def project(cam, X):
    x = (cam['K'] @ (cam['R'] @ np.asarray(X, float).T + cam['t'][:, None])).T; return x[:, :2] / x[:, 2:3]


def ray(cam, uv):
    d = cam['R'].T @ np.linalg.inv(cam['K']) @ np.array([uv[0], uv[1], 1.0]); return d / np.linalg.norm(d)


def ground(cam, uv, z=0.0):
    d = ray(cam, uv); s = (z - cam['C'][2]) / d[2]; return cam['C'] + s * d


def fly(p0, v0, ts):
    """Places of a ball at the times ts (rising, first is 0 or more) with gravity and drag: small steps."""
    out = []; p = np.array(p0, float); v = np.array(v0, float); t = 0.0; h = 1 / 120
    for T in ts:
        while t < T - 1e-9:
            dt = min(h, T - t); a = np.array([0, 0, -G]) - DRAG * np.linalg.norm(v) * v
            vm = v + a * dt / 2; am = np.array([0, 0, -G]) - DRAG * np.linalg.norm(vm) * vm; p = p + vm * dt; v = v + am * dt; t += dt
        out.append(p.copy())
    return np.array(out)


def quad(n, xy, at):
    """The place at picture number `at` from the last pictures of a chain: a straight line, or a bend when there are enough."""
    n = np.asarray(n, float); xy = np.asarray(xy, float); k = 2 if len(n) >= 6 else 1; m = min(len(n), 8 if k == 2 else 3)
    c = np.polyfit(n[-m:] - n[-1], xy[-m:], k); return np.polyval(c[:, 0], at - n[-1]), np.polyval(c[:, 1], at - n[-1])


def grow(C, used, ch, step, miss=4):
    """Add pictures to one end of a chain while a candidate is where the chain says the ball must be."""
    gap = 0; j = ch[-1][0]
    while 0 <= j + step < len(C) and gap <= miss:
        j += step; n = [f for f, k in ch]; xy = [C[f][k, :2] for f, k in ch]
        px, py = quad(n, xy, j); v = np.linalg.norm(np.subtract(xy[-1], xy[-2])) / abs(n[-1] - n[-2]); far = abs(j - n[-1])
        best = None
        for k in range(len(C[j])):
            if used[j][k]: continue
            e = np.hypot(C[j][k, 0] - px, C[j][k, 1] - py)
            if e < (12 + 0.15 * v) * (1 + 0.4 * (far - 1)) and (best is None or e < best[0]): best = (e, k)
        if best is None: gap += 1; continue
        ch.append((j, best[1])); gap = 0
    return ch


def chains(frames, vmax=230.0):
    """Chains of candidates in which each step continues the last: one chain is one free flight, or more than one."""
    C = []
    for f in frames:                                            # the candidates of both gaps, one for each place
        keep = []
        for v in sorted(f['c'], key=lambda v: -v[3]):
            if v[3] < SMIN: continue
            if all(abs(v[1] - k[1]) + abs(v[2] - k[2]) > 10 for k in keep): keep.append(v)
        C.append(np.array([[k[1], k[2], k[3], k[4]] for k in keep], float).reshape(-1, 4))
    T = [f['t'] for f in frames]; used = [np.zeros(len(c), bool) for c in C]; out = []
    for i in range(len(C) - 2):
        for a in (np.argsort(-C[i][:, 2]) if len(C[i]) else []):
            if used[i][a] or C[i][a, 2] < SSEED: continue
            best = None
            for b in range(len(C[i + 1])):
                if used[i + 1][b] or C[i + 1][b, 2] < SSEED: continue
                d1 = C[i + 1][b, :2] - C[i][a, :2]; n1 = np.linalg.norm(d1)
                if n1 < 2 or n1 > vmax: continue
                for c in range(len(C[i + 2])):
                    if used[i + 2][c]: continue
                    e = np.linalg.norm(C[i + 2][c, :2] - C[i + 1][b, :2] - d1)
                    if e < 6 + 0.2 * n1 and (best is None or e < best[0]): best = (e, b, c)
            if best is None: continue
            ch = grow(C, used, [(i, a), (i + 1, best[1]), (i + 2, best[2])], 1)
            ch = grow(C, used, ch[::-1], -1)[::-1]
            if len(ch) >= 6 and np.linalg.norm(C[ch[-1][0]][ch[-1][1], :2] - C[ch[0][0]][ch[0][1], :2]) >= 30 and np.mean([C[f][k, 2] for f, k in ch]) >= SMEAN:
                for (fi, k) in ch: used[fi][k] = True
                out.append({'n': [fi for fi, k in ch], 't': [T[fi] for fi, k in ch], 'uv': [C[fi][k, :2].tolist() for fi, k in ch], 's': [float(C[fi][k, 2]) for fi, k in ch]})
    return sorted(out, key=lambda c: c['t'][0])


def turn(u, v):
    """1: the same direction, -1: the opposite direction."""
    return float(np.dot(u, v) / (np.linalg.norm(u) * np.linalg.norm(v) + 1e-9))


def single(ch, px=40.0):
    """Two chains on the same ball (the streak of a fast ball gives two islands): keep the longer one."""
    ch = sorted(ch, key=lambda c: -len(c['t'])); keep = []
    for c in ch:
        mine = dict(zip(c['n'], c['uv'])); twin = False
        for k in keep:
            both = [n for n in k['n'] if n in mine]
            if len(both) >= max(3, len(c['n']) // 2) and np.median([np.linalg.norm(np.subtract(mine[n], k['uv'][k['n'].index(n)])) for n in both]) < px: twin = True; break
        if not twin: keep.append(c)
    return sorted(keep, key=lambda c: c['t'][0])


def inside(r, m=3.0):
    """The flight is in or near the cage: a fit that puts the ball far away is not a ball of this court."""
    return all(-m <= p[0] <= 10 + m and -m <= p[1] <= 20 + m and -0.5 <= p[2] <= 8 for p in (r['p0'], r['end']))


def join(cam, ch, gap=0.12, lim=6.0):
    """Two chains that are one free flight together are one flight that lost some pictures."""
    ch = sorted(ch, key=lambda c: c['t'][0]); done = True
    while done:
        done = False
        for i, a in enumerate(ch):
            if np.mean(a['s']) < SMEAN + 2: continue
            for b in ch[i + 1:]:
                dt = b['t'][0] - a['t'][-1]
                if not (0 < dt <= gap) or np.mean(b['s']) < SMEAN + 2: continue
                va = np.subtract(a['uv'][-1], a['uv'][-3]); vb = np.subtract(b['uv'][2], b['uv'][0]); g = np.subtract(b['uv'][0], a['uv'][-1])
                if np.linalg.norm(g) > (np.linalg.norm(va) + np.linalg.norm(vb)) / 4 * dt * 60 * 2 + 20 or turn(va, g) < 0.6 or turn(g, vb) < 0.6: continue
                m = {k: a[k] + b[k] for k in a}; r = fit(cam, m['t'], m['uv'], quick=True)
                if r['p90'] <= lim and inside(r):
                    ch.remove(a); ch.remove(b); ch.append(m); ch.sort(key=lambda c: c['t'][0]); done = True; break
            if done: break
    return ch


def bend_error(c, a=0, b=None):
    """How far the pictures of a chain are from one smooth bend, in pixels (the largest and the mean)."""
    t = np.array(c['t'][a:b]); uv = np.array(c['uv'][a:b]); t = t - t[0]
    if len(t) < 5: return 0.0, 0.0
    r = uv - np.stack([np.polyval(np.polyfit(t, uv[:, k], 2), t) for k in (0, 1)], 1); e = np.linalg.norm(r, axis=1); return float(e.max()), float(e.mean())


def cut(cam, c, lim=6.0):
    """A chain that is not one free flight holds a bounce or a hit: cut it at the place that makes two smooth parts.
    The test is the fit in space, because a long flight toward the camera is not a smooth bend in the picture."""
    if len(c['t']) < 10 or bend_error(c)[1] < lim / 2: return [c]
    if np.mean(c['s']) >= SMEAN + 2 and fit(cam, c['t'], c['uv'], quick=True)['p90'] <= 6.0: return [c]
    best = None
    for k in range(5, len(c['t']) - 4):
        e = bend_error(c, 0, k)[1] * k + bend_error(c, k - 1)[1] * (len(c['t']) - k + 1)
        if best is None or e < best[0]: best = (e, k)
    if best is None or best[0] / len(c['t']) > bend_error(c)[1] * 0.6: return [c]
    k = best[1]; part = lambda a, b: {key: c[key][a:b] for key in c}
    return cut(cam, part(0, k), lim) + cut(cam, part(k - 1, None), lim)          # the picture at the cut is in both parts: the ball is there


def fit(cam, ts, uv, end=None, w=60.0, quick=False):
    """The free flight that fits the pictures best. `end`: the known place of the last picture (a bounce on the ground)."""
    ts = np.asarray(ts, float) - ts[0]; uv = np.asarray(uv, float); best = None
    def res(q):
        p = fly(q[:3], q[3:], ts); r = (project(cam, p) - uv).ravel()
        return np.r_[r, (p[-1] - end) * w] if end is not None else r
    for z0 in ((1.0,) if quick else (1.0, 2.2, 0.4)):
        for z1 in ((0.03,) if end is not None else (1.0,) if quick else (0.1, 1.0, 1.8)):
            a = ground(cam, uv[0], z0); b = np.array(end) if end is not None else ground(cam, uv[-1], z1); T = ts[-1]; v = (b - a) / T; v[2] += G * T / 2
            try: r = least_squares(res, np.r_[a, v], method='trf', loss='soft_l1', f_scale=4.0, max_nfev=40 if quick else 120)
            except Exception: continue
            if not np.isfinite(r.cost): continue
            if best is None or r.cost < best.cost: best = r
    if best is None: return {'p0': [99, 99, 99], 'v0': [0, 0, 0], 'speed': 0.0, 'sd': 1e6, 'rms': 1e6, 'p90': 1e6, 'end': [99, 99, 99], 'T': float(ts[-1]), 'n': len(uv), 'length': 0.0, 'top': 0.0, 'low': 0.0}
    r = best; n = len(uv) * 2; J = r.jac; px = np.linalg.norm(project(cam, fly(r.x[:3], r.x[3:], ts)) - uv, axis=1); rms = float(np.median(px)); p90 = float(np.percentile(px, 90))
    try: cov = np.linalg.inv(J.T @ J) * max(1.0, 2 * r.cost / max(1, len(r.fun) - 6))
    except np.linalg.LinAlgError: cov = np.eye(6) * 1e6
    p0, v0 = r.x[:3], r.x[3:]; sp = float(np.linalg.norm(v0)); g = np.r_[np.zeros(3), v0 / sp]; sd = float(np.sqrt(max(0, g @ cov @ g))); path = fly(p0, v0, ts)
    return {'p0': p0.round(2).tolist(), 'v0': v0.round(2).tolist(), 'speed': sp, 'sd': sd, 'rms': rms, 'p90': p90, 'end': path[-1].round(2).tolist(), 'T': float(ts[-1]), 'n': len(uv),
            'length': float(np.linalg.norm(np.diff(path, axis=0), axis=1).sum()), 'top': float(path[:, 2].max()), 'low': float(path[:, 2].min())}


def near(uv, box):
    """How far a place in the picture is from a box, as a share of the height of the box (0: in the box)."""
    dx = max(box[0] - uv[0], 0, uv[0] - box[2]); dy = max(box[1] - uv[1], 0, uv[1] - box[3]); return float(np.hypot(dx, dy) / max(1.0, box[3] - box[1]))


def people(cam, walk, t):
    """The persons of the picture of walk.py that is nearest in time: box in the pixels of the camera file, place on the court."""
    if not walk or not walk['frames']: return []
    k = cam['scale']; f = min(walk['frames'], key=lambda f: abs(f['t'] - t)); out = []
    if abs(f['t'] - t) > 0.25: return []
    for i, p in enumerate(f['people']):
        b = [v * k for v in p['box'][:4]]; pl = court_map.place(p['kp']) if p.get('kp') else None
        if b[3] < 2130 / 3840 * 1920 * k: g = ground(cam, ((b[0] + b[2]) / 2, b[3])); pl = (float(g[0]), float(g[1]), 'box')   # the foot of the box is in the picture
        if pl is None: continue
        out.append({'i': i, 'box': b, 'at': [round(pl[0], 2), round(pl[1], 2)], 'how': pl[2]})
    return out


def who(ps, uv, reach=0.45):
    best = None
    for p in ps:
        d = near(uv, p['box'])
        if d <= reach and (best is None or d < best[0]): best = (d, p)
    return best[1] if best else None


def on_plane_y(cam, uv, y):
    d = ray(cam, uv); s = (y - cam['C'][1]) / d[1]; return cam['C'] + s * d


def launch(p0, end, T):
    """The start velocity of a ball that goes from p0 to end in the time T."""
    v = (np.array(end) - np.array(p0)) / T; v[2] += G * T / 2
    r = least_squares(lambda q: fly(p0, q, [T])[0] - end, v, method='lm'); return r.x


def sd_person(q):
    """How well the depth of a person is known (m): a near person well, a far person not (one pixel there is 0.2 m)."""
    return 0.3 if q['at'][1] < 9 else 1.0


def point(cam, ball, walk):
    fr = ball['frames']; ch = single(join(cam, [p for c in chains(fr) for p in cut(cam, c)])); out = []
    good = [c for c in ch if len(c['t']) >= 8 and np.linalg.norm(np.subtract(c['uv'][-1], c['uv'][0])) >= 150 and np.mean(c['s']) >= SMEAN + 2]
    for c in good:
        uv = np.array(c['uv']); t0, t1 = c['t'][0], c['t'][-1]
        P0 = people(cam, walk, t0); P1 = people(cam, walk, t1); a = who(P0, uv[0]); b = who(P1, uv[-1])
        v1 = uv[min(3, len(uv) - 1)] - uv[0]                         # the ball that came must come from another direction: a part of the same flight is not a hit
        before = [o for o in ch if o is not c and 0 <= t0 - o['t'][-1] <= 0.12 and a and who(P0, o['uv'][-1]) is a and turn(np.subtract(o['uv'][-1], o['uv'][-min(4, len(o['uv']))]), v1) < 0.3]
        after = [o for o in ch if o is not c and 0 <= o['t'][0] - t1 <= 0.15]
        nx = [o for o in after if o['t'][0] - t1 < 0.07 and np.linalg.norm(np.subtract(o['uv'][0], uv[-1])) < 60]
        e = ground(cam, uv[-1], 0.033); m = min(4, len(uv) - 1); vy = (uv[-1][1] - uv[-1 - m][1]) / m
        up = [(o['uv'][min(3, len(o['uv']) - 1)][1] - o['uv'][0][1]) / min(3, len(o['uv']) - 1) for o in nx]
        bounce = bool(nx) and vy > 1.5 and min(up) < vy * 0.5 and 0.2 <= e[0] <= 9.8 and 0.2 <= e[1] <= 19.8
        v2 = uv[-1] - uv[-min(4, len(uv))]
        away = [o for o in after if b and who(P1, o['uv'][0]) is b and turn(v2, np.subtract(o['uv'][min(3, len(o['uv']) - 1)], o['uv'][0])) < 0.3] if not bounce else []
        f = {'t0': round(t0, 3), 't1': round(t1, 3), 'n': len(uv), 'from': uv[0].round(1).tolist(), 'to': uv[-1].round(1).tolist(), 'strength': round(float(np.mean(c['s'])), 1),
             'hitter': a, 'incoming': bool(before), 'bounce': [round(float(e[0]), 2), round(float(e[1]), 2)] if bounce else None, 'catcher': b if not bounce else None, 'outgoing': bool(away)}
        if a and before and (bounce or (b and away and (a['at'][1] - 10) * (b['at'][1] - 10) < 0)):
            tb = max(o['t'][-1] for o in before); th = (tb + t0) / 2; sth = (t0 - tb) / 2 + 1 / 120       # the hit is between the last picture of the ball that came and the first of the ball that went
            if bounce: te = t1 + 1 / 120; ste = 1 / 120; end = e; sde = 0.15
            else: ta = min(o['t'][0] for o in away); te = (t1 + ta) / 2; ste = (ta - t1) / 2 + 1 / 120; end = on_plane_y(cam, uv[-1], b['at'][1]); sde = sd_person(b)
            start = on_plane_y(cam, uv[0], a['at'][1]); T = te - th
            if 0.05 <= start[2] <= 3.5 and -0.2 <= end[2] <= 3.5 and T > 0.1:
                v0 = launch(start, end, T); path = fly(start, v0, np.linspace(0, T, 30)); d = float(np.linalg.norm(np.diff(path, axis=0), axis=1).sum())
                rel = float(np.sqrt((sd_person(a) ** 2 + sde ** 2) / d ** 2 + (sth ** 2 + ste ** 2) / T ** 2))
                f.update({'start': start.round(2).tolist(), 'end': np.array(end).round(2).tolist(), 'metres': round(d, 2), 'seconds': round(T, 3), 'kmh': round(d / T * 3.6, 1), 'rel': round(rel, 3),
                          'kmh_racket': round(float(np.linalg.norm(v0)) * 3.6, 1), 'top': round(float(path[:, 2].max()), 2), 'to_what': 'bounce' if bounce else 'player'})
                if not bounce: f['between_hits'] = round(T, 3)
        out.append(f)
    return out


def one(args):
    name, bd, wd = args; cam = camera(); ball = json.load(open(f'{bd}/{name}.json')); w = f'{wd}/{name}.json'
    return name, point(cam, ball, json.load(open(w)) if os.path.exists(w) else None)


if __name__ == '__main__':
    from multiprocessing import Pool
    bd, wd, o = sys.argv[1:4]; names = sys.argv[4:] or sorted(os.path.basename(f)[:-5] for f in glob.glob(f'{bd}/p*.json'))
    cam = camera(); print('camera: focal length %.0f px, at X %.2f Y %.2f, %.2f m high, error of the eight points %.1f px' % (cam['K'][0, 0], *cam['C'], cam['rms']), flush=True)
    res = {}
    with Pool(int(os.environ.get('JOBS', 4))) as pool:
        for name, fl in pool.imap_unordered(one, [(n, bd, wd) for n in names]):
            res[name] = fl; print(name, len(fl), 'flights,', sum(1 for f in fl if 'kmh' in f), 'timed,', sum(1 for f in fl if 'between_hits' in f), 'hit to hit', flush=True)
    json.dump(res, open(o, 'w'), separators=(',', ':')); print('FLIGHT_DONE', len(res), 'points', sum(len(v) for v in res.values()), 'flights')
