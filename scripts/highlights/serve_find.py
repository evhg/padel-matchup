"""The start of every serve, at both ends, from the pictures (poses at 10 a second) and then the ball and the sound.

fast_points.py finds the serve from the sound and from the near server's pose (pose_serve). A camera on the back glass
hears few hits (match2: one hit in a clip at the median, the serve 1.5 dB over the noise), and a far serve is not seen.
Here the pictures give the serve, at either end, and the ball and the sound give the exact hit near that moment.

Three steps (README "The start of every serve"):
1. the pictures: play starts after a wait (onsets, choose). The poses come from walk_mps.py ({"t", "people": [{"box",
   "zone", "kp"}]}, 1920 x 1080), or the detector's boxes (boxes=True);
2. the ball: the serve's flight from the server's half towards the net (serve_flight), from ball_places.py's candidates
   linked by flight.py's chains(): a full-picture pass at each onset, and a far-half pass (CROP) for a far serve;
3. the sound: the click just before the ball's first picture (sound_hit).
On match2 (sets 3 and 4, tuned on sets 1 and 2) this finds 40 of 81 serves within 0.3 s: far under the bar of 95%.
"""
import numpy as np

# tuned on sets 1 and 2 of match2 only (README "The start of every serve")
CUT_Y = 1060          # a box that reaches this row is cut by the picture's bottom edge (the near server under the camera)
FAST = 0.2            # a fast player: the feet move this many of his heights in 0.3 s
CALM = 0.12           # a calm picture: no whole player moves more than this
QUIET = 2.0           # the wait before a serve: this many seconds ...
QUIET_SHARE = 0.75    # ... with this share of calm pictures at least
BURST = 3             # then play: this many fast pictures among the next 5
LAG = 0.2             # play starts this long after the hit (boxes at 3 a second: 0.55, with QUIET_SHARE 0.6)
RANK = 1              # the activity of a picture: the fastest player (1), or the second fastest (2: the server's ball bounce does not count)


def foot(p):
    """The middle of a person's feet: the ankles when the model is sure of both, else the bottom of the box."""
    k = p['kp']
    if k[15][2] > 0.3 and k[16][2] > 0.3: return np.array([(k[15][0] + k[16][0]) / 2, (k[15][1] + k[16][1]) / 2])
    b = p['box']; return np.array([(b[0] + b[2]) / 2, b[3]])


def activity(frames, boxes=False):
    """(t, a) for each picture: a is how far the RANK-th fastest whole player moved in the 0.3 s before (the picture
    nearest 0.3 s back), in his heights. A player is matched to the nearest person of the same half in that picture.
    Cut boxes do not count. boxes: the feet from the box only (the detector's boxes of match/kf have no pose). Pure."""
    t = np.array([f['t'] for f in frames], float); a = np.zeros(len(t)); seen = []
    ft = (lambda p: np.array([(p['box'][0] + p['box'][2]) / 2, p['box'][3]])) if boxes else foot
    for i, f in enumerate(frames):
        seen.append([(ft(p), p['box'][3] - p['box'][1], p['zone']) for p in f['people'] if p['zone'] in ('far', 'near') and p['box'][3] < CUT_Y])
        j = int(np.searchsorted(t, t[i] - 0.3 - 0.04))
        if j >= i or not 0.25 <= t[i] - t[j] <= 0.4: continue
        v = sorted((min(np.linalg.norm(x - y) for y, _, zz in seen[j] if zz == z) / h for x, h, z in seen[i]
                    if any(zz == z for _, _, zz in seen[j])), reverse=True)
        a[i] = v[int(RANK) - 1] if len(v) >= RANK else 0.0
    return t, a


def onsets(t, a):
    """The moments when play starts after a wait: [(serve time, seconds of the wait)]. The serve is LAG before the
    first fast picture of a burst that follows QUIET s of calm pictures. Pure."""
    out = []; fast = a >= FAST; calm = a < CALM; rate = 1.0 / max(np.median(np.diff(t)), 1e-3) if len(t) > 1 else 10.0
    for i in range(1, len(t)):
        if not fast[i] or fast[i - 1]: continue
        nx = (t >= t[i]) & (t < t[i] + 0.5)
        if fast[nx].mean() < BURST / 5: continue
        b4 = (t >= t[i] - QUIET) & (t < t[i])
        if b4.sum() < 0.8 * QUIET * rate or calm[b4].mean() < QUIET_SHARE: continue
        out.append((round(float(t[i]) - LAG, 2), 0.0))
    return out


MIN_N = 16            # a serve's flight: this many pictures of the ball (59.94 a second) at least,
CROSS = 30            # from this many camera pixels or more behind the net's row, in the server's half,
RISE = 150            # towards the net: a near serve rises this many camera pixels in the picture,
DROP = 80             # a far serve drops this many.
PICK = 'long'         # of the flights that pass: the longest one, or the first one ('first')
EDGE = 150            # a near serve starts this many camera pixels or more from the picture's sides (the next court)


def in_half(x, y, end, k=2.0, width=3840):
    """The camera pixel (x, y) is on the court, in the half `end` (court.py's numbers, at 1920 x 1080 times k)."""
    import court as C
    x, y = x / k, y / k
    if end == 'far':
        if not C.FAR_TOP_Y - 1.5 * C.FAR_H0 <= y <= C.NET_FOOT_Y: return False      # the ball is above the floor
        q = max(0.0, (y - C.FAR_TOP_Y) / (C.NET_FOOT_Y - C.FAR_TOP_Y))
        return C.FAR_L0 + (C.POST_L - C.FAR_L0) * q - 60 <= x <= C.FAR_R0 + (C.POST_R - C.FAR_R0) * q + 60
    # the near half: a ball in the air there is high in the picture and far to the side (a near server under the
    # camera hits it at the height of his head), so the side walls on the floor say nothing; only the picture's sides
    return y >= C.NET_FOOT_Y and EDGE / k <= x <= (width - EDGE) / k


def serve_flight(chains, net_y, lo, hi):
    """The serve from the ball: a long flight that starts in [lo, hi] in one half, behind the net's row (camera pixels),
    and goes towards the net, as (t, 'near' or 'far': the server's end), or None. t is the first picture of that
    flight. chains: flight.py's chains() of ball_places.py's candidates. Pure."""
    ok = []
    for c in chains:
        if not lo <= c['t'][0] <= hi or len(c['t']) < MIN_N: continue
        (x0, y0), y1 = c['uv'][0], c['uv'][-1][1]
        if y0 > net_y + CROSS and y0 - y1 >= RISE and in_half(x0, y0, 'near'): ok.append((c, 'near'))
        elif y0 < net_y - CROSS and y1 - y0 >= DROP and in_half(x0, y0, 'far'): ok.append((c, 'far'))
    if not ok: return None
    c, end = min(ok, key=lambda q: q[0]['t'][0]) if PICK == 'first' else max(ok, key=lambda q: len(q[0]['t']))
    return round(c['t'][0], 3), end


def play_after(t, a, t0, quiet=1.5):
    """How long play goes on after t0: to the first QUIET-long stretch with QUIET_SHARE calm pictures. Pure."""
    calm = a < CALM; m = np.where(t >= t0)[0]; rate = 1.0 / max(np.median(np.diff(t)), 1e-3) if len(t) > 1 else 10.0
    for i in m:
        w = (t >= t[i]) & (t < t[i] + quiet)
        if w.sum() >= 0.8 * quiet * rate and calm[w].mean() >= QUIET_SHARE: return float(t[i] - t0)
    return float(t[-1] - t0) if len(m) else 0.0


def choose(t, a, ons, lo, hi):
    """The serve of a clip [lo, hi] among the onsets: the one whose play lasts longest (a first serve into the net
    gives a short play, then a wait, then the second serve). Pure."""
    c = [o for o in ons if lo <= o[0] <= hi]
    if not c: return None
    return max(c, key=lambda o: play_after(t, a, o[0] + LAG))[0]


HIT_CUT = 3000.0      # the sound: the band over this many Hz ...
HIT_DB = 2.0          # ... this many dB over its own median of the half second around, at least
HIT_BEFORE, HIT_AFTER = 0.25, 0.05       # the hit of the racket is this near the ball's first picture (before, after)


def sound_hit(x, sr, t):
    """The sound's hit nearest the ball: the loudest click in [t - HIT_BEFORE, t + HIT_AFTER] of x (mono, sr Hz),
    or None when none is HIT_DB over the noise. The ball is first seen a few pictures after the contact. Pure."""
    from scipy.signal import butter, sosfilt
    from scipy.ndimage import median_filter
    hop = sr // 100; a = int((t - 1.0) * sr); b = int((t + 1.0) * sr)
    if a < 0 or b > len(x): return None
    y = sosfilt(butter(4, HIT_CUT, 'highpass', fs=sr, output='sos'), x[a:b])
    e = 10 * np.log10(np.add.reduceat(y ** 2, np.arange(0, len(y), hop)) / hop + 1e-12); c = e - median_filter(e, 51)
    i0, i1 = int((1.0 - HIT_BEFORE) * 100), int((1.0 + HIT_AFTER) * 100) + 1
    k = i0 + int(np.argmax(c[i0:i1]))
    return round(t - 1.0 + k / 100, 2) if c[k] >= HIT_DB else None


SEEN_LATE = 0.1       # without a click, the ball's first picture is this long after the hit


def serve_time(chains, net_y, lo, hi, x=None, sr=16000):
    """The serve in the window [lo, hi] that the pictures give: the ball's flight (serve_flight), then the sound's
    click just before it (sound_hit), as (t, end, 'sound' | 'ball'), or None. Pure."""
    b = serve_flight(chains, net_y, lo, hi)
    if b is None: return None
    h = sound_hit(x, sr, b[0]) if x is not None else None
    return (h, b[1], 'sound') if h is not None else (round(b[0] - SEEN_LATE, 2), b[1], 'ball')
