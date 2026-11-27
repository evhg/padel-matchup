"""The court finder: the court lines of one film, found from its frames, not drawn by hand.

usage: court_find.py <frames ...> [--out match/court.json] [--report court-find.json] [--debug court-find.jpg]
       court_find.py --video <film> [same options]       (27 frames read from the film by seeking)
       The frames in the order of the film (match/kf/*.jpg; a glob in quotes is fine). Exit 0: sure, 2: not sure.
       --out is written only when the court is sure; --report always.

A player's phone stands behind the back glass, put there by hand, so its height, place and angle change every
match. The lines therefore belong to the film, not to the club. This file finds them from the picture:

1. Backgrounds: the film in three parts (start, middle, end); each part's background is the median of up to 15 of
   its frames, the whole film's of up to 25. The players move and the lines do not, so the players vanish.
2. The white lines: a white top-hat of the brightness (a thin bright line on a darker floor) where the colour is
   pale. Then, by Hough and a fit to the middle of the line in each column or row:
   - the near service line (court Y 3.05 m): the flat white line with the most support in the lower picture;
   - the centre service line (X 5 m): the steep white line up from the service line's T;
   - the net's white band (Y 10 m, 0.92 m high at the posts, a little lower at the centre): the flat white line
     across the centre line with the most white on both sides of it.
3. The camera. These three lines leave two numbers open: the focal length and the tilt (from a phone in the middle
   of the glass, the plane of the centre line holds the camera's own axis). A grid of both gives one camera each in
   closed form (camera_for); the side walls (X 0 and X 10 m) decide: the camera whose two wall feet lie on colour
   edges with the floor's colour inside wins. Then a least-squares fit of 8 numbers (focal length, place, three
   angles, one lens bend) and the net's sag to every line, the walls included. Where the far service line is seen
   through the net, it joins the fit. The floor's homography H is the camera's.
4. The checks (judge): the error of each line in pixels, both walls found, the far service line where the camera
   puts it (when the band does not hide it), no second court that fits nearly as well, a camera that is a phone
   behind the back glass, and the three parts' courts close to the whole film's.
5. The phone moved: the three parts' backgrounds against each other (phase correlation of the whole picture).

The answer is "ok" with the court.json fields that court.py reads (plus "H", the camera and a confidence), or
"not_sure" with a reason code, never a court that did not pass the checks:
  lines_not_found     the near service line, the centre line or the net's band is not in the picture
  walls_not_found     a side wall is not found, so nothing fixes the focal length
  fit_poor            the lines do not agree with one court (line error, the far service line elsewhere, a second
                      court as good, or parts of the film that give different courts)
  camera_implausible  the fitted camera is not a phone behind the back glass (height, distance, angles)
  moved               the phone moved during the film ("do not move the phone")
  too_few_frames      fewer than 9 frames: no median without players, and no part to check another

The court: X 0..10 m across (0 at the picture's left), Y 0 at the near back glass .. 10 at the net .. 20 at the
far back glass, Z up. The same as court_map.py; "H" maps court metres to picture pixels like match/court-H.json.
All pixel numbers are for a 1920x1080 picture; a 4K frame is made small first. Tests: test_court_find.py.
"""
import json, math, sys
import numpy as np, cv2

W0, H0 = 1920, 1080
SVC_Y, NET_Y, FAR_SVC_Y, FAR_Y = 3.05, 10.0, 16.95, 20.0
NET_POST_Z, NET_MID_Z = 0.92, 0.88
TAPE_DROP = 0.025        # the white band is about 5 cm deep: its middle is this far under the net's top
PERSON = 1.70            # metres: a standing player's box, for FAR_H0 and FAR_H1
TAPE_GAP = 12            # pixels: a gap in the band wider than this ends it (a post, mostly)

# the checks (pixels of a 1920x1080 picture)
MAX_RMS = 4.0            # the error of all line samples
MAX_LINE = 7.0           # the error of one line (its mean distance)
MOVED_PX = 8.0           # the picture of one part of the film moved this much against another: the phone moved
MIN_MATCH = 0.08         # or matches another part this badly (phase correlation: 0.4 to 0.8 on films that did not move)
LINE_CONTRAST = 2.0      # the service line against the floor's bright speckles (see find_service_line)
MIN_FRAMES = 9           # frames of the film at the least (three for each part)
MAX_SPREAD = 40.0        # a court corner of one part's fit this far from the whole film's fit: the fit is not stable
FLOOR_SOFT = 4.0         # a wall's edge counts less when its inner side is not the floor's colour (in floor tolerances)
# a phone behind the back glass: the focal length of a 0.5x or 1x lens (pixels of a 1920 wide picture), and the
# lens's place in metres (Y 0 is the back glass, Z the height). The search keeps to these, and the check too.
PRIOR = {'f': (500.0, 2400.0), 'Y': (-4.0, 1.0), 'Z': (0.4, 4.5)}


# ---------------------------------------------------------------------------------------------------------------
# the camera

def rot(yaw, pitch, roll):
    """World (X right, Y along the court, Z up) to camera (x right, y down, z forward)."""
    R0 = np.array([[1., 0, 0], [0, 0, -1], [0, 1, 0]])
    cy, sy = math.cos(yaw), math.sin(yaw); cp, sp = math.cos(pitch), math.sin(pitch); cr, sr = math.cos(roll), math.sin(roll)
    Ry = np.array([[cy, 0, -sy], [0, 1, 0], [sy, 0, cy]])          # turn left/right
    Rx = np.array([[1, 0, 0], [0, cp, -sp], [0, sp, cp]])          # look down: positive pitch
    Rz = np.array([[cr, -sr, 0], [sr, cr, 0], [0, 0, 1]])
    return Rz @ Rx @ Ry @ R0


class Camera:
    """p = [f, X, Y, Z, yaw, pitch, roll, k1]: the focal length in pixels, the lens's place in court metres, three
    angles in radians, and one number of barrel distortion (the wide lens). The picture's centre is the principal point."""

    def __init__(self, p, size=(W0, H0)):
        p = list(p) + [0.0] * (8 - len(p)); self.p = np.asarray(p, float); self.size = size
        f, X, Y, Z, ya, pi, ro, self.k1 = self.p
        self.sag = NET_POST_Z - NET_MID_Z
        self.f = f; self.c = np.array([size[0] / 2, size[1] / 2])
        self.R = rot(ya, pi, ro); self.C = np.array([X, Y, Z]); self.t = -self.R @ self.C

    def cam(self, P):
        P = np.atleast_2d(np.asarray(P, float))
        if P.shape[1] == 2: P = np.c_[P, np.zeros(len(P))]
        return (self.R @ P.T + self.t[:, None]).T

    def project(self, P, ok=False):
        """Court points (X, Y[, Z]) -> pixels. With ok=True also a mask of the points the lens can show."""
        q = self.cam(P); z = q[:, 2]; zs = np.where(z > 1e-6, z, 1e-6)
        n = q[:, :2] / zs[:, None]; r2 = (n ** 2).sum(1)
        uv = self.f * n * (1 + self.k1 * r2)[:, None] + self.c
        return (uv, (z > 0.3) & (r2 < 2.2)) if ok else uv

    def H(self):
        """Court metres (X, Y) on the floor -> picture pixels: the homography that is closest to the camera over the
        part of the floor in the picture (exact when k1 is 0)."""
        if self.k1 == 0:
            M = np.array([[self.f, 0, self.c[0]], [0, self.f, self.c[1]], [0, 0, 1]]) @ np.c_[self.R[:, 0], self.R[:, 1], self.t]
            return M / M[2, 2]
        g = np.array([(x, y) for x in np.linspace(0, 10, 11) for y in np.linspace(0, 20, 21)])
        uv, ok = self.project(g, ok=True)
        ok &= (uv[:, 0] > -50) & (uv[:, 0] < self.size[0] + 50) & (uv[:, 1] > -50) & (uv[:, 1] < self.size[1] + 50)
        Hm, _ = cv2.findHomography(g[ok], uv[ok], 0)
        return Hm / Hm[2, 2]


def tape_points(n=41, sag=NET_POST_Z - NET_MID_Z):
    """The middle of the net's white band, from the left post to the right post: it hangs "sag" metres lower at
    the centre than at the posts (a parabola; the rules give 4 cm, a slack net more, so the fit takes its own)."""
    X = np.linspace(0, 10, n)
    Z = NET_POST_Z - TAPE_DROP - sag * (1 - ((X - 5) / 5) ** 2)
    return np.c_[X, np.full(n, NET_Y), Z]


def _seg(a, b, n=60):
    k = np.linspace(0, 1, n)[:, None]; return np.asarray(a, float) * (1 - k) + np.asarray(b, float) * k


# each line that is looked for, as court points along it (a little longer than the paint: the ends are not used)
MODEL = {
    'service': _seg((-1, SVC_Y, 0), (11, SVC_Y, 0)),
    'centre': _seg((5, SVC_Y - 0.5, 0), (5, FAR_SVC_Y, 0)),     # seen through the net beyond it
    'tape': tape_points(41),                                    # model_of() uses the camera's own sag
    'left': _seg((0, -1, 0), (0, NET_Y, 0)),
    'right': _seg((10, -1, 0), (10, NET_Y, 0)),
    'far_service': _seg((0, FAR_SVC_Y, 0), (10, FAR_SVC_Y, 0)),
}


def poly_dist(Q, S):
    """Signed distance of the points S to the polyline Q (both in pixels)."""
    a, b = Q[:-1], Q[1:]; d = b - a; L2 = np.maximum((d ** 2).sum(1), 1e-9)
    k = np.clip(((S[:, None, :] - a[None]) * d[None]).sum(2) / L2[None], 0, 1)
    P = a[None] + k[..., None] * d[None]; e = S[:, None, :] - P; dist = np.sqrt((e ** 2).sum(2))
    j = dist.argmin(1); i = np.arange(len(S))
    sgn = np.sign(d[j, 0] * e[i, j, 1] - d[j, 1] * e[i, j, 0])
    return dist[i, j] * np.where(sgn == 0, 1, sgn)


def model_of(k, cam):
    return tape_points(41, cam.sag) if k == 'tape' else MODEL[k]


def tape_inside(cam, S, margin=10):
    """The samples of the band between the camera's two posts (the band's run often goes on past a post, along the
    rail of the side wall or the net of the next court)."""
    q = cam.project(tape_points(2, cam.sag)); return (S[:, 0] > q[0, 0] + margin) & (S[:, 0] < q[1, 0] - margin)


def line_errors(cam, obs):
    """{line: distances of its samples to the camera's picture of the line}, in pixels. The band's samples outside
    the posts count as 0 (and a camera that keeps fewer than 40% of them gets 50 px for each one it drops)."""
    out = {}
    for k, S in obs.items():
        if S is None or k not in MODEL: continue
        Q, ok = cam.project(model_of(k, cam), ok=True)
        if ok.sum() < 2: out[k] = np.full(len(S), 500.0); continue
        if k == 'tape':
            m = tape_inside(cam, S); e = np.zeros(len(S))
            if m.sum() >= 2: e[m] = poly_dist(Q[ok], S[m])
            if m.mean() < 0.4: e[~m] = 50.0
            out[k] = e
        else:
            out[k] = poly_dist(Q[ok], S)
    return out


def rms_of(errs, keys=None):
    v = np.concatenate([e[e != 0] if k == 'tape' else e for k, e in errs.items() if keys is None or k in keys] or [np.zeros(1)])
    return float(np.sqrt(np.mean(v ** 2))) if len(v) else 0.0


def angles(R):
    """The inverse of rot(): R -> (yaw, pitch, roll)."""
    M = R @ np.array([[1., 0, 0], [0, 0, -1], [0, 1, 0]]).T
    pitch = math.asin(max(-1.0, min(1.0, M[2, 1]))); yaw = math.atan2(M[2, 0], M[2, 2])
    cp, sp, cy, sy = math.cos(pitch), math.sin(pitch), math.cos(yaw), math.sin(yaw)
    A = np.array([[cy, 0, -sy], [-sp * sy, cp, -sp * cy], [cp * sy, sp, cp * cy]])
    Z = M @ A.T; return yaw, pitch, math.atan2(Z[1, 0], Z[0, 0])


def camera_for(f, tilt, svc, ctr, tape, size=(W0, H0)):
    """The camera with focal length f whose view along the court rises `tilt` radians above its axis (about the
    pitch), and that puts the service line, the centre line and the net's band where they are seen. The court's Y
    direction lies in the plane of the centre line at that tilt; its X direction is square to it and lies in the plane
    of the service line; the distance comes from the T of the service line and the band at the centre line.
    The centre line cannot give the tilt by itself: from a phone in the middle of the back glass its plane holds the
    camera's own axis. So the tilt and f are searched (find_camera), and the side walls decide."""
    K = np.array([[f, 0, size[0] / 2], [0, f, size[1] / 2], [0, 0, 1]]); Ki = np.linalg.inv(K)
    nc = K.T @ ctr; ns = K.T @ svc
    if abs(nc[0]) < 1e-9: return None
    dy = np.array([(nc[1] * math.sin(tilt) - nc[2] * math.cos(tilt)) / nc[0], -math.sin(tilt), math.cos(tilt)])
    dy /= np.linalg.norm(dy)
    dx = np.cross(ns, dy); dx /= np.linalg.norm(dx)
    if dx[0] < 0: dx = -dx
    dz = np.cross(dx, dy); R = np.c_[dx, dy, dz]
    T = _cross(svc, ctr); Tn = _cross(tape, ctr)
    wT = R.T @ Ki @ np.r_[T, 1]; wN = R.T @ Ki @ np.r_[Tn, 1]
    A = np.array([5, SVC_Y, 0.0]); Bp = np.array([5, NET_Y, NET_MID_Z - TAPE_DROP])
    (s, u), *_ = np.linalg.lstsq(np.c_[-wT, wN], Bp - A, rcond=None)
    if s <= 0 or u <= 0: return None
    C = A - s * wT
    return Camera([f, *C, *angles(R), 0.0], size)


LO = np.array([300, -3, -10, 0.2, -0.7, -0.35, -0.35, -0.6])
HI = np.array([4000, 13, 4, 8, 0.7, 1.3, 0.35, 0.3])


def fit_camera(obs, start, free=None):
    """Least squares of the camera on the observed lines, each line counting as much as 30 samples, from the camera
    `start`. The band is cut to the start's posts first. free: a mask of the 8 numbers to fit; the net's sag is
    fitted too (0 to 15 cm)."""
    from scipy.optimize import least_squares
    free = np.ones(8, bool) if free is None else np.asarray(free, bool)
    obs = {k: S for k, S in obs.items() if S is not None and k in MODEL}
    if 'tape' in obs:
        m = tape_inside(start, obs['tape']); obs['tape'] = obs['tape'][m] if m.sum() >= 10 else obs['tape']
    wts = {k: math.sqrt(30.0 / max(len(S), 1)) for k, S in obs.items()}
    p0 = np.clip(start.p.copy(), LO + 1e-6, HI - 1e-6)

    def cam_of(q):
        p = p0.copy(); p[free] = q[:-1]; cam = Camera(p, start.size); cam.sag = q[-1]; return cam

    def res(q):
        cam = cam_of(q); e = {}
        for k, S in obs.items():
            Q, ok = cam.project(model_of(k, cam), ok=True)
            e[k] = poly_dist(Q[ok], S) if ok.sum() >= 2 else np.full(len(S), 500.0)
        return np.concatenate([e[k] * wts[k] for k in sorted(e)])
    q0 = np.r_[p0[free], np.clip(start.sag, 0.001, 0.149)]
    r = least_squares(res, q0, bounds=(np.r_[LO[free], 0.0], np.r_[HI[free], 0.15]), loss='soft_l1', f_scale=3.0, max_nfev=300)
    return cam_of(r.x)


# ---------------------------------------------------------------------------------------------------------------
# lines in the picture

def fit_line(pts):
    """Total least squares: (a, b, c) with a x + b y + c = 0 and a^2 + b^2 = 1."""
    pts = np.asarray(pts, float); m = pts.mean(0); u, s, vt = np.linalg.svd(pts - m)
    n = vt[1]; return np.array([n[0], n[1], -n @ m])


def robust_line(pts, tol=3.0, iters=4):
    pts = np.asarray(pts, float); keep = np.ones(len(pts), bool)
    for _ in range(iters):
        if keep.sum() < 5: return None, keep
        L = fit_line(pts[keep]); d = np.abs(pts @ L[:2] + L[2])
        keep = d < max(tol, 2.5 * np.median(d[keep]))
    return fit_line(pts[keep]), keep


def white_map(bg):
    """How much each pixel looks like a painted line: bright against its neighbourhood, and pale."""
    hsv = cv2.cvtColor(bg, cv2.COLOR_BGR2HSV)
    k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (25, 25))
    th = cv2.morphologyEx(hsv[..., 2], cv2.MORPH_TOPHAT, k).astype(np.float32)
    pale = np.clip((110 - hsv[..., 1].astype(np.float32)) / 50, 0, 1)
    return th * pale


def background(frames):
    a = np.stack([cv2.resize(f, (W0, H0), interpolation=cv2.INTER_AREA) if f.shape[1] != W0 else f for f in frames])
    return np.median(a, 0).astype(np.uint8)


def _thresh(w):
    return max(15.0, 0.4 * float(np.percentile(w[int(0.4 * H0):], 99.5)))


def _hough(mask, lo, hi, votes, n=8):
    L = cv2.HoughLines(mask, 2, np.pi / 720, votes, min_theta=lo, max_theta=hi)
    return [] if L is None else [np.array([math.cos(th), math.sin(th), -rho]) for rho, th in L[:n, 0]]


def _y_at(L, x): return -(L[0] * x + L[2]) / L[1]
def _x_at(L, y): return -(L[1] * y + L[2]) / L[0]


def _cross(L1, L2):
    p = np.cross(L1, L2); return p[:2] / p[2]


def _samples(w, L, t, along, rng, step=6, half=12, skip=()):
    """The centre of the white line near L, every `step` pixels: along 'x' (a flat line) or 'y' (a steep one)."""
    out = []
    for s in range(int(rng[0]), int(rng[1]), step):
        if any(abs(s - k) < 22 for k in skip): continue
        if along == 'x':
            if not 0 <= s < W0: continue
            c = int(round(_y_at(L, s))); idx = np.arange(c - half, c + half + 1); idx = idx[(idx >= 0) & (idx < H0)]
            v = w[idx, s] if len(idx) else np.zeros(0)
        else:
            if not 0 <= s < H0: continue
            c = int(round(_x_at(L, s))); idx = np.arange(c - half, c + half + 1); idx = idx[(idx >= 0) & (idx < W0)]
            v = w[s, idx] if len(idx) else np.zeros(0)
        if len(v) < half or v.max() < t: continue
        k = v >= 0.5 * v.max(); m = float((idx[k] * v[k]).sum() / v[k].sum())
        out.append((s, m) if along == 'x' else (m, s))
    return np.array(out, float).reshape(-1, 2)


def find_service_line(w, t):
    """The near service line: the flat white line with the most support in the lower part of the picture."""
    m = (w > t).astype(np.uint8); m[:int(0.4 * H0)] = 0
    best = None
    for L in _hough(m, math.radians(75), math.radians(105), int(0.2 * W0)):
        pts = _samples(w, L, t, 'x', (0, W0), step=8, half=14)
        if len(pts) < 40: continue
        L2, keep = robust_line(pts, 2.5)
        if L2 is None: continue
        span = np.ptp(pts[keep, 0])
        if best is None or span > best['span']: best = dict(line=L2, pts=pts[keep], span=span)
    if not best or best['span'] <= 0.45 * W0: return None
    # a painted line stands out of the floor: its middle is far brighter than the floor's bright speckles (3.7 to 4.1
    # times their 90th percentile on the stored films, 0.7 on a picture of noise)
    P = best['pts'].round().astype(int); on = float(np.median(w[P[:, 1].clip(0, H0 - 1), P[:, 0].clip(0, W0 - 1)]))
    return best if on >= LINE_CONTRAST * float(np.percentile(w[int(0.5 * H0):], 90)) else None


def find_centre_line(w, t, svc):
    """The centre service line: steep, white, from the service line's T up towards the net (fainter as it goes: the
    samples take a lower threshold). Of the candidates the longest wins, a little less so the further its T is from
    the middle of the picture (a reflection in the glass also makes a steep white streak)."""
    m = (w > 0.6 * t).astype(np.uint8); yy = np.arange(H0)[:, None]; xx = np.arange(W0)[None, :]
    m[yy > _y_at(svc, xx) - 8] = 0; m[:, :int(0.2 * W0)] = 0; m[:, int(0.8 * W0):] = 0
    best = None
    for L in _hough(m, 0, math.radians(25), 60) + _hough(m, math.radians(155), math.pi - 1e-4, 60):
        T = _cross(svc, L)
        if not 0.2 * W0 < T[0] < 0.8 * W0: continue
        pts = _samples(w, L, 0.5 * t, 'y', (int(0.05 * H0), int(T[1]) - 10), step=6, half=10)
        if len(pts) < 8: continue
        pts = pts[np.argsort(-pts[:, 1])]          # from the service line upwards
        run = [pts[0]]
        if pts[0][1] < T[1] - 40: continue
        for p in pts[1:]:
            if run[-1][1] - p[1] > 70: break
            run.append(p)
        run = np.array(run); L2, keep = robust_line(run, 2.0)
        if L2 is None: continue
        span = T[1] - run[keep, 1].min(); score = span * (1 - 0.5 * abs(T[0] - W0 / 2) / (W0 / 2))
        if best is None or score > best['score']: best = dict(line=L2, pts=run[keep], span=span, score=score)
    return best if best and best['span'] > 0.08 * H0 else None


def find_tape(w, t, svc, ctr):
    """The net's white top band: flat, across the centre line above the service line; its ends are the posts."""
    T = _cross(svc, ctr); ylo, yhi = max(5, int(T[1] - 0.62 * H0)), int(T[1] - 0.08 * H0)
    xc = _x_at(ctr, (ylo + yhi) / 2)
    m = (w > t * 0.8).astype(np.uint8); m[:ylo] = 0; m[yhi:] = 0
    m[:, :max(0, int(xc - 0.42 * W0))] = 0; m[:, int(xc + 0.42 * W0):] = 0
    best = None
    for L in _hough(m, math.radians(80), math.radians(100), int(0.08 * W0), n=30):
        X = _cross(L, ctr)
        if not ylo <= X[1] <= yhi: continue
        ends, on = [], []
        for d in (-1, 1):
            x = X[0]; last = X[0]; gap = 0; hits = []
            while 0 <= x < W0 and gap <= TAPE_GAP:
                y = int(round(_y_at(L, x)))
                v = w[max(0, y - 2):y + 3, int(x)].max() if 0 <= y < H0 else 0
                if v > 0.6 * t: last = x; gap = 0; hits.append(abs(x - X[0]))
                else: gap += 2
                x += 2 * d
            ends.append(last); on.append(np.array(hits))
        a, b = X[0] - ends[0], ends[1] - X[0]; r = min(a, b)
        if r < 0.06 * W0 or max(a, b) > 3 * r: continue
        # the white along it within the same reach on both sides of the centre line: the phone stands near the
        # middle, so the band is about as long on each side (a run that goes on past one post does not count)
        score = 2 * sum(int((h <= r).sum()) for h in on)
        if best is None or score > best[0]: best = (score, L, ends)
    if best is None: return None
    _, L, (xl, xr) = best
    for half in (6, 3):                       # lock on: a line between two white lines drifts to the stronger one
        pts = _samples(w, L, 0.6 * t, 'x', (xl + 4, xr - 4), step=6, half=half, skip=(_cross(L, ctr)[0],))
        if len(pts) < 20: return None
        L, keep = robust_line(pts, 2.0)
        if L is None: return None
    return dict(line=L, pts=pts[keep], ends=np.array([[xl, _y_at(L, xl)], [xr, _y_at(L, xr)]]))


# ---------------------------------------------------------------------------------------------------------------
# the side walls decide the camera

def floor_map(bg, svc, ctr, tape):
    """The floor's colour, taken beside the centre line between the service line and the net, and for each pixel
    how far its colour is from it (Lab units), plus the colour gradients. -> dict or None"""
    lab = cv2.cvtColor(cv2.medianBlur(bg, 5), cv2.COLOR_BGR2LAB).astype(np.float32)
    T = _cross(svc, ctr); ty = _y_at(tape, T[0]); ys = np.arange(int(ty + 0.35 * (T[1] - ty)), int(T[1] - 14), 3)
    xs = np.r_[np.arange(-200, -24, 6), np.arange(24, 200, 6)]
    if len(ys) < 3: return None
    smp = np.array([lab[y, int(np.clip(_x_at(ctr, y) + dx, 0, bg.shape[1] - 1))] for y in ys for dx in xs])
    f0 = np.median(smp, 0); tol = max(8.0, 2.0 * float(np.percentile(np.linalg.norm(smp - f0, axis=1), 80)))
    g = cv2.GaussianBlur(lab, (0, 0), 1.2)
    return dict(D=np.linalg.norm(lab - f0, axis=2), tol=tol,
                gx=cv2.Sobel(g, cv2.CV_32F, 1, 0, ksize=3), gy=cv2.Sobel(g, cv2.CV_32F, 0, 1, ksize=3))


def _wall_points(cam, side, top):
    """The camera's picture of one wall's foot (court Y 0.3 .. 9.5), inside the picture and below the band, with
    the normal that points into the court."""
    Y = np.linspace(0.3, 9.5, 48); X = 0.0 if side == 'left' else 10.0
    Q, ok = cam.project(np.c_[np.full(len(Y), X), Y], ok=True)
    In = cam.project(np.c_[np.full(len(Y), 5.0), Y])
    ok &= (Q[:, 0] > 4) & (Q[:, 0] < cam.size[0] - 5) & (Q[:, 1] > top) & (Q[:, 1] < cam.size[1] - 5)
    if ok.sum() < 2: return np.zeros((0, 2)), np.zeros((0, 2))
    d = np.gradient(Q, axis=0); n = np.c_[-d[:, 1], d[:, 0]]; n /= np.linalg.norm(n, axis=1)[:, None] + 1e-9
    n *= np.sign(((In - Q) * n).sum(1))[:, None]
    return Q[ok], n[ok]


def _at(D, P):
    H, W = D.shape; P = np.round(P).astype(int); return D[P[:, 1].clip(0, H - 1), P[:, 0].clip(0, W - 1)]


def _at(A, P):
    H, W = A.shape[:2]; P = np.round(P).astype(int); return A[P[:, 1].clip(0, H - 1), P[:, 0].clip(0, W - 1)]


def _edge(fm, Q, n, o):
    """The colour edge across the line moved by o pixels along n, if the floor is on its inner side."""
    P = Q + o * n
    e = np.abs(_at(fm['gx'], P) * n[:, :1] + _at(fm['gy'], P) * n[:, 1:]).sum(1)
    din = sum(_at(fm['D'], Q + (o + k) * n) for k in (4, 8, 12)) / 3
    return e * np.exp(-(din / (FLOOR_SOFT * fm['tol'])) ** 2)


def _best_edge(fm, Q, n, reach, step=1):
    best = np.full(len(Q), -1.0); at = np.zeros(len(Q))
    for o in range(-reach, reach + 1, step):
        v = _edge(fm, Q, n, o); at = np.where(v > best, o, at); best = np.maximum(best, v)
    return best, at


def wall_score(cam, fm, top, reach):
    """How well the camera's two wall feet sit on colour edges with the floor inside them (both in the picture)."""
    s = []
    for side in ('left', 'right'):
        Q, n = _wall_points(cam, side, top)
        if len(Q) < 8: return 0.0
        s.append(float(_best_edge(fm, Q, n, reach, 2 if reach > 3 else 1)[0].mean()))
    return float(np.mean(s))


def wall_samples(cam, fm, top, reach=20):
    """The wall feet near where the camera puts them: the strongest such edge along each normal, then a line."""
    out = {}
    for side in ('left', 'right'):
        Q, n = _wall_points(cam, side, top)
        if len(Q) < 8: out[side] = None; continue
        best, at = _best_edge(fm, Q, n, reach); P = Q + at[:, None] * n
        keep = best > 0.35 * np.median(best)
        L, k2 = robust_line(P[keep], 2.5) if keep.sum() >= 8 else (None, None)
        out[side] = P[keep][k2] if L is not None and k2.sum() >= 8 else None
    return out


def _thin(S, n=60):
    return S if S is None or len(S) <= n else S[np.linspace(0, len(S) - 1, n).astype(int)]


def find_camera(lines, fm):
    """Search the focal length and the tilt (the two numbers the service line, the centre line and the band leave
    open) for the camera whose walls fall on colour edges with the floor inside; then fit everything, walls included.
    The search keeps to a phone behind the back glass (PRIOR). -> [(rms ok, wall score, camera, samples)], best first;
    the checks of solve() say whether the first is sure."""
    svc, ctr, tape = lines['service']['line'], lines['centre']['line'], lines['tape']['line']
    obs = {k: _thin(lines[k]['pts']) for k in ('service', 'centre', 'tape')}
    top = _y_at(tape, W0 / 2) + 4
    cells = []
    for f in np.geomspace(PRIOR['f'][0], PRIOR['f'][1], 40):
        for tilt in np.radians(np.arange(-4, 52, 1.0)):
            cam = camera_for(f, tilt, svc, ctr, tape)
            if cam is None or not (PRIOR['Z'][0] < cam.C[2] < PRIOR['Z'][1] and PRIOR['Y'][0] < cam.C[1] < PRIOR['Y'][1]): continue
            e = line_errors(cam, obs)
            if max(rms_of(e, (k,)) for k in e) > 8: continue
            s = wall_score(cam, fm, top, 8)
            if s > 0: cells.append((s, f, tilt))
    if not cells: return []
    cells.sort(reverse=True); seeds = []
    for s, f, tilt in cells:
        if all(abs(math.log(f / f2)) > 0.08 or abs(tilt - t2) > math.radians(2.5) for _, f2, t2 in seeds): seeds.append((s, f, tilt))
        if len(seeds) == 4: break
    tried = []
    for _, f0, t0 in seeds:
        fine = []
        for f in f0 * np.geomspace(0.94, 1.06, 9):
            for tilt in t0 + np.radians(np.linspace(-1.2, 1.2, 9)):
                cam = camera_for(f, tilt, svc, ctr, tape)
                if cam is not None: fine.append((wall_score(cam, fm, top, 2), cam))
        if not fine: continue
        s, cam = max(fine, key=lambda r: r[0])
        o = dict(obs)
        for it in range(2):
            o.update(wall_samples(cam, fm, top, 20 if it == 0 else 6))
            o['left'], o['right'] = _thin(o['left'], 40), _thin(o['right'], 40)
            if o['left'] is None and o['right'] is None: break
            cam = fit_camera(o, cam)
        r = rms_of(line_errors(cam, o)); tried.append((r <= MAX_RMS, s, cam, o))
    tried.sort(key=lambda c: (c[0], c[1]), reverse=True)
    return tried


# ---------------------------------------------------------------------------------------------------------------
# one background -> one court, or a reason

def find_lines(bg):
    """The three painted or white lines that start everything. -> (lines, white map, threshold) or (reason, ...)"""
    w = white_map(bg); t = _thresh(w)
    svc = find_service_line(w, t)
    if svc is None: return 'service', w, t
    ctr = find_centre_line(w, t, svc['line'])
    if ctr is None: return 'centre', w, t
    tape = find_tape(w, t, svc['line'], ctr['line'])
    if tape is None: return 'net', w, t
    # the centre line from its T to the band only (above the band it runs into whatever is behind the court)
    near = ctr['pts'][ctr['pts'][:, 1] > _y_at(tape['line'], ctr['pts'][:, 0]) + 6]
    L, keep = robust_line(near, 2.0) if len(near) >= 6 else (None, None)
    if L is None or keep.sum() < 6: return 'centre', w, t
    ctr = dict(ctr, line=L, pts=near[keep])
    return {'service': svc, 'centre': ctr, 'tape': tape}, w, t


def key_points(cam):
    """Court points the pipeline leans on: the net's foot at the posts and the centre, the service line's T, the far
    corners and the service line at the walls."""
    return cam.project(np.array([(0, NET_Y), (10, NET_Y), (5, NET_Y), (5, SVC_Y), (0, FAR_Y), (10, FAR_Y),
                                 (0, SVC_Y), (10, SVC_Y)], float))


def far_service_check(cam, w, t):
    """The far service line where the camera puts it: seen or not, and how far off. It is seen through the net, and
    from a high phone it hides behind the net's band; then there is no verdict."""
    X = np.r_[np.linspace(0.6, 4.4, 14), np.linspace(5.6, 9.4, 14)]
    Q, ok = cam.project(np.c_[X, np.full(len(X), FAR_SVC_Y)], ok=True)
    tq = cam.project(tape_points(41, cam.sag)); band = np.interp(Q[:, 0], tq[:, 0], tq[:, 1])
    vis = ok & (np.abs(Q[:, 1] - band) > 12) & (Q[:, 0] > 0) & (Q[:, 0] < w.shape[1] - 1)
    offs, pts = [], []
    for (x, y) in Q[vis]:
        ys = np.arange(int(y) - 15, int(y) + 16); ys = ys[(ys >= 0) & (ys < w.shape[0])]
        if not len(ys): continue
        col = w[ys, int(x)]
        pk = [i for i in range(1, len(col) - 1) if col[i] > 0.5 * t and col[i] >= col[i - 1] and col[i] >= col[i + 1]]
        if pk:                                # the white line nearest to the place (the far glass's foot is near too)
            i = min(pk, key=lambda i: abs(ys[i] - y)); offs.append(float(ys[i] - y)); pts.append((x, float(ys[i])))
    nv = int(vis.sum()); out = dict(visible=nv, seen=len(offs), offset=None, ratio=None, verdict='hidden' if nv < 6 else 'not_seen')
    if nv >= 6 and len(offs) >= max(5, 0.4 * nv):
        o = np.array(offs); med = float(np.median(o))
        if np.median(np.abs(o - med)) <= 3.0:
            out['pts'] = np.array(pts)[np.abs(o - med) <= 4.0]
            ny = cam.project([(5, NET_Y)])[0][1]; fy = cam.project([(5, FAR_SVC_Y)])[0][1]
            out.update(offset=round(med, 1), ratio=round((ny - (fy + med)) / max(ny - fy, 1e-6), 3))
            out['verdict'] = 'agrees' if abs(med) <= max(4.0, 0.25 * abs(ny - fy)) else 'disagrees'
    return out


def camera_check(cam):
    f, X, Y, Z = cam.p[:4]; yaw, pitch, roll = np.degrees(cam.p[4:7])
    bad = []
    if not PRIOR['f'][0] <= f <= PRIOR['f'][1]: bad.append(f'focal length {f:.0f} px')
    if not PRIOR['Z'][0] <= Z <= PRIOR['Z'][1]: bad.append(f'height {Z:.2f} m')
    if not PRIOR['Y'][0] <= Y <= PRIOR['Y'][1]: bad.append(f'{-Y:.2f} m behind the back glass')
    if abs(X - 5) > 3.0: bad.append(f'{X - 5:+.2f} m from the centre line')
    if abs(roll) > 8 or abs(yaw) > 15 or not -3 <= pitch <= 50: bad.append(f'angles {yaw:.1f}/{pitch:.1f}/{roll:.1f} deg')
    if abs(cam.k1) > 0.25: bad.append(f'lens bend {cam.k1:.3f}')
    return bad


def line_marks(lines):
    """What the picture itself says, before any camera: the service line's T, the band at the centre line, and the
    service line's angle. A phone that moved changes these."""
    svc, ctr, tape = (lines[k]['line'] for k in ('service', 'centre', 'tape'))
    ang = lambda L: math.atan(-L[0] / L[1]) if abs(L[1]) > 1e-9 else math.pi / 2      # the slope's angle, sign-free
    return dict(T=_cross(svc, ctr), N=_cross(tape, ctr), a_svc=ang(svc))


def picture_shift(a, b):
    """How far the whole picture moved between two backgrounds (phase correlation), and how well they match (0..1)."""
    ga, gb = (cv2.cvtColor(x, cv2.COLOR_BGR2GRAY).astype(np.float32) for x in (a, b))
    win = cv2.createHanningWindow(ga.shape[::-1], cv2.CV_32F)
    (dx, dy), r = cv2.phaseCorrelate(ga, gb, win)
    return float(math.hypot(dx, dy)), float(r)


def marks_moved(m1, m2):
    """Pixels between two sets of marks (the service line's angle counts as its shift at the picture's edge)."""
    return float(max(np.abs(m1['T'] - m2['T']).max(), np.abs(m1['N'] - m2['N']).max(),
                     abs(m1['a_svc'] - m2['a_svc']) * W0 / 2))


def solve(bg):
    """One background picture -> {'ok', 'reason', 'detail', 'camera', 'samples', 'checks', 'marks'}."""
    lines, w, t = find_lines(bg)
    if isinstance(lines, str):
        return dict(ok=False, reason='lines_not_found', detail=f'no {lines} line', camera=None, marks=None)
    marks = line_marks(lines)
    fm = floor_map(bg, lines['service']['line'], lines['centre']['line'], lines['tape']['line'])
    tried = find_camera(lines, fm) if fm is not None else []
    if not tried: return dict(ok=False, reason='walls_not_found', detail='no camera puts both walls on an edge', camera=None, marks=marks)
    good, s, cam, obs = tried[0]
    far = far_service_check(cam, w, t)
    if far['verdict'] == 'agrees':           # seen where it should be: let it sharpen the depth, then check again
        obs = dict(obs, far_service=_thin(far['pts'], 30)); cam = fit_camera(obs, cam)
    far = far_service_check(cam, w, t); far.pop('pts', None)
    # a second camera that fits as well but puts the court elsewhere: the walls do not decide
    rival = None
    for g2, s2, c2, _ in tried[1:]:
        if g2 and s2 >= 0.85 * s and np.abs(key_points(c2)[:6] - key_points(cam)[:6]).max() > 15: rival = round(s2 / s, 2); break
    out = judge(cam, obs, far, rival)
    out.update(camera=cam, samples=obs, marks=marks)
    out['checks']['wall_score'] = round(s, 1)
    return out


def judge(cam, obs, far=None, rival=None):
    """The checks of one fitted camera: is this court sure? -> {'ok', 'reason', 'detail', 'confidence', 'checks'}
    obs: the samples of each line; far: far_service_check's answer; rival: the score share of a second court."""
    far = far or dict(verdict='hidden')
    walls = {k: (0 if obs.get(k) is None else len(obs[k])) for k in ('left', 'right')}
    e = line_errors(cam, obs)
    per = {k: round(float(np.mean(np.abs(v[v != 0] if k == 'tape' else v))), 2) for k, v in e.items() if len(v)}
    rms = rms_of(e); bad = camera_check(cam)
    checks = dict(rms=round(rms, 2), lines=per, walls=walls, rival=rival, far_service=far,
                  camera=dict(f=round(cam.f, 1), X=round(cam.C[0], 2), Y=round(cam.C[1], 2), Z=round(cam.C[2], 2),
                              yaw=round(math.degrees(cam.p[4]), 2), pitch=round(math.degrees(cam.p[5]), 2),
                              roll=round(math.degrees(cam.p[6]), 2), k1=round(cam.k1, 4), sag=round(cam.sag, 3)))
    out = dict(ok=False, checks=checks, reason=None, detail='')
    if min(walls.values()) == 0:
        out.update(reason='walls_not_found', detail='left' if walls['left'] == 0 else 'right')
    elif rms > MAX_RMS or max(per.values()) > MAX_LINE:
        out.update(reason='fit_poor', detail=f'line error {rms:.1f} px')
    elif far.get('verdict') == 'disagrees':
        out.update(reason='fit_poor', detail=f'far service line {far["offset"]} px from its place')
    elif rival is not None:
        out.update(reason='fit_poor', detail=f'a second court fits as well ({rival})')
    elif bad:
        out.update(reason='camera_implausible', detail='; '.join(bad))
    else:
        out['ok'] = True
    conf = max(0.0, 1 - rms / (2 * MAX_RMS)) * (0.6 + 0.4 * min(1.0, sum(walls.values()) / 40))
    conf *= 1.0 if far.get('verdict') == 'agrees' else 0.9
    out['confidence'] = round(conf if out['ok'] else 0.0, 2)
    return out


# ---------------------------------------------------------------------------------------------------------------
# the court.json fields

def court_fields(cam):
    """The numbers court.py reads, from the camera (pixels of a 1920x1080 picture), plus H and the camera."""
    P = lambda X, Y, Z=0.0: cam.project([(X, Y, Z)])[0]
    nf, pl, pr = P(5, NET_Y), P(0, NET_Y), P(10, NET_Y)
    ft, fl, fr = P(5, FAR_Y), P(0, FAR_Y), P(10, FAR_Y)

    def slope(X):
        a, b = P(X, NET_Y), P(X, 4.0); return abs((b[1] - a[1]) / (b[0] - a[0] + 1e-9))

    def leaves(X, edge):
        Ys = np.linspace(NET_Y, -2, 600); Q, ok = cam.project(np.c_[np.full(len(Ys), X), Ys], ok=True)
        hit = np.where(ok & ((Q[:, 0] <= 0) if edge == 0 else (Q[:, 0] >= edge)))[0]
        return float(Q[hit[0], 1]) if len(hit) else float(cam.size[1])
    side = (slope(0) + slope(10)) / 2
    wall_out = (leaves(0, 0) + leaves(10, cam.size[0])) / 2
    h0 = P(5, FAR_Y)[1] - P(5, FAR_Y, PERSON)[1]; h1 = P(5, NET_Y)[1] - P(5, NET_Y, PERSON)[1]
    c = dict(NET_FOOT_Y=round(nf[1]), FAR_TOP_Y=round(ft[1]), FAR_L0=round(fl[0]), FAR_R0=round(fr[0]),
             POST_L=round(pl[0]), POST_R=round(pr[0]), SIDE_SLOPE=round(side, 3), WALL_OUT_Y=round(min(wall_out, cam.size[1])),
             FAR_H0=round(h0), FAR_H1=round(h1))
    # the detector's tiles: two 640x400 over the far half (a far player's head at the far glass to the net), and two
    # 640x640 at the sides of the near half
    W, H = cam.size; cx = (c['POST_L'] + c['POST_R']) / 2
    fy = int(np.clip((c['FAR_TOP_Y'] - 1.3 * c['FAR_H0'] + c['NET_FOOT_Y'] + 40) / 2 - 200, 0, H - 400))
    ny = int(np.clip(c['NET_FOOT_Y'] - c['FAR_H1'], 0, H - 640))
    c['TILES'] = [[int(np.clip(cx - 480, 0, W - 640)), fy, 640, 400], [int(np.clip(cx - 160, 0, W - 640)), fy, 640, 400],
                  [0, ny, 640, 640], [W - 640, ny, 640, 640]]
    c['H'] = [[round(float(v), 8) for v in row] for row in cam.H()]
    c['camera'] = dict(f=round(cam.f, 1), C=[round(float(v), 3) for v in cam.C],
                       ypr=[round(math.degrees(v), 3) for v in cam.p[4:7]], k1=round(cam.k1, 5), size=list(cam.size))
    return c


# ---------------------------------------------------------------------------------------------------------------
# the film: three parts, the phone that moved, the answer

def _load(f):
    img = cv2.imread(f) if isinstance(f, str) else f
    if img is None: return None
    return cv2.resize(img, (W0, H0), interpolation=cv2.INTER_AREA) if img.shape[:2] != (H0, W0) else img


def find_court(frames, parts=3, per_part=15):
    """frames: pictures of one film in its order (paths or BGR arrays, any size of 16:9). Each part of the film gives
    a background (the median of up to per_part of its frames, so the players vanish) and a court; the court of the
    whole film is the median of all of them. -> the report (see the top of this file)."""
    n = len(frames)
    if n < MIN_FRAMES:          # one picture keeps its players, and a part of the film cannot be checked by another
        return dict(status='not_sure', reason='too_few_frames', detail=f'{n} frames, {MIN_FRAMES} at the least',
                    confidence=0.0, _whole=dict(camera=None))
    groups = [g for g in np.array_split(np.arange(n), parts) if len(g)]
    pick = lambda g: [g[int(i)] for i in np.unique(np.linspace(0, len(g) - 1, min(per_part, len(g))).round())]
    imgs = {}
    for g in groups:
        for i in pick(g):
            im = _load(frames[i])
            if im is not None: imgs[int(i)] = im
    res, bgs = [], []
    for g in groups:
        ims = [imgs[int(i)] for i in pick(g) if int(i) in imgs]
        bgs.append(background(ims) if ims else None)
        res.append(solve(bgs[-1]) if ims else dict(ok=False, reason='lines_not_found', detail='no frames', camera=None))
    allidx = sorted(imgs)[:: max(1, len(imgs) // 25)]
    whole = solve(background([imgs[i] for i in allidx])) if len(groups) > 1 else res[0]
    part_info = []
    for g, r in zip(groups, res):
        part_info.append(dict(frames=[int(g[0]), int(g[-1])], ok=r['ok'], reason=r.get('reason'), detail=r.get('detail'),
                              key=None if r.get('camera') is None else key_points(r['camera'])[:6].round(1).tolist()))
    # moved: the parts' pictures against each other (the phone moved, the whole picture shifts); the lines and the
    # fitted courts of the parts are reported too (they say how stable the finder is, not that the phone moved)
    seen = [b for b, r in zip(bgs, res) if b is not None and r.get('camera') is not None]    # parts that show a court
    shifts = [picture_shift(a, b) for i, a in enumerate(seen) for b in seen[i + 1:]]
    moved = max([d for d, _ in shifts] or [0.0]); changed = min([r for _, r in shifts] or [1.0])
    mk = [r['marks'] for r in res if r.get('marks') is not None]
    lines_moved = max([marks_moved(a, b) for i, a in enumerate(mk) for b in mk[i + 1:]] or [0.0])
    oks = [r for r in res if r['ok']]
    spread = None
    if oks and whole.get('camera') is not None:
        spread = max(float(np.abs(key_points(r['camera'])[:6] - key_points(whole['camera'])[:6]).max()) for r in oks)
    report = dict(status='not_sure', reason=None, detail='', confidence=0.0, checks=whole.get('checks'),
                  parts=part_info, moved_px=round(moved, 1), picture_match=round(changed, 2),
                  lines_moved_px=round(lines_moved, 1), spread_px=None if spread is None else round(spread, 1))
    if moved > MOVED_PX or changed < MIN_MATCH:
        report.update(reason='moved', detail=f'the picture moved {moved:.0f} px between parts of the film' if moved > MOVED_PX
                      else f'the parts of the film do not show the same picture (match {changed:.2f})')
    elif not whole['ok']:
        report.update(reason=whole['reason'], detail=whole['detail'])
    elif len(groups) > 1 and len(mk) < 2:
        report.update(reason='lines_not_found', detail='the lines are seen in one part of the film only')
    elif spread is not None and spread > MAX_SPREAD:
        report.update(reason='fit_poor', detail=f'the parts of the film give courts {spread:.0f} px apart')
    else:
        report.update(status='ok', confidence=whole['confidence'], court=court_fields(whole['camera']))
        report['court']['confidence'] = whole['confidence']
    report['_whole'] = whole
    return report


def draw(bg, cam, samples=None):
    """The fitted court over the picture: red floor lines, yellow net band, blue samples."""
    out = bg.copy()
    for a, b in [((0, 0), (0, 20)), ((10, 0), (10, 20)), ((-1, SVC_Y), (11, SVC_Y)), ((5, SVC_Y), (5, FAR_SVC_Y)),
                 ((0, FAR_SVC_Y), (10, FAR_SVC_Y)), ((0, FAR_Y), (10, FAR_Y)), ((0, NET_Y), (10, NET_Y))]:
        q, ok = cam.project(_seg(a, b, 120), ok=True)
        if ok.sum() > 1: cv2.polylines(out, [q[ok].astype(np.int32)], False, (0, 0, 255), 2)
    cv2.polylines(out, [cam.project(tape_points(41, cam.sag)).astype(np.int32)], False, (0, 255, 255), 2)
    for S in (samples or {}).values():
        if S is not None:
            for p in S: cv2.circle(out, (int(p[0]), int(p[1])), 3, (255, 0, 0), -1)
    return out


def video_frames(path, n=27):
    """n pictures spread over a film, read by seeking (the film is not decoded from the start)."""
    cap = cv2.VideoCapture(path); fps = cap.get(cv2.CAP_PROP_FPS) or 30; total = cap.get(cv2.CAP_PROP_FRAME_COUNT)
    dur = total / fps if total > 0 else 0; out = []
    for s in np.linspace(0.03, 0.97, n) * dur:
        cap.set(cv2.CAP_PROP_POS_MSEC, s * 1000); ok, img = cap.read()
        if ok: out.append(img)
    cap.release(); return out


def main(argv):
    import argparse, glob
    ap = argparse.ArgumentParser(description='Find the court lines of one film from its frames.')
    ap.add_argument('frames', nargs='*', help='frames in film order (a glob is fine)')
    ap.add_argument('--video', help='a film: frames are read from it by seeking')
    ap.add_argument('--out', help='court.json to write when the court is sure')
    ap.add_argument('--report', help='the whole report (always written)')
    ap.add_argument('--debug', help='a picture of the fitted court over the background')
    a = ap.parse_args(argv)
    files = sorted(sum((glob.glob(f) or [f] for f in a.frames), []))
    frames = video_frames(a.video) if a.video else files
    rep = find_court(frames)
    whole = rep.pop('_whole')
    if a.debug and whole.get('camera') is not None:
        idx = np.linspace(0, len(frames) - 1, min(15, len(frames))).astype(int)
        cv2.imwrite(a.debug, cv2.resize(draw(background([_load(frames[i]) for i in idx]), whole['camera'], whole.get('samples')), (960, 540)))
    if a.report: json.dump(rep, open(a.report, 'w'), indent=1)
    if a.out and rep['status'] == 'ok': json.dump(rep['court'], open(a.out, 'w'))
    print(json.dumps({k: rep.get(k) for k in ('status', 'reason', 'detail', 'confidence', 'moved_px')}))
    return 0 if rep['status'] == 'ok' else 2


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))


