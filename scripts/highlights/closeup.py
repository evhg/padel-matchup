"""A close look at one player (a reaction or a replay): where render.py puts its window, and whether the player is in it.

render.py ("replay") cuts a window of 1/zoom of the picture around one player of the track, follows that player, and
holds the last place where the tracker loses him. The tall reel then shows the middle 3/4 of the window's width. On
27 November 2026 a reel from the whole film showed two close looks without their player: in one the player walked out
of the picture at the left after the point, and the window held his last box, at the edge, for 2 s of empty court; in
the other the "player" stood behind the side glass during a break, small beside the glass wall. Nothing checked the
window against the track before the part was drawn. So `framed` does what render.py does with the window, frame by
frame, and says how much of the part shows the player, and how large. A close look is drawn only when:

- the player's box is inside the shown window (`INSIDE` of its area, in the tall layout, the narrower one) in
  `SHARE` of the part's frames or more; a frame where the tracker does not hold the player counts as outside;
- the player's box is `TALL` of the window's height or more (the median over the frames that hold him): a smaller
  player is a figure in a corner, not a close look.

Measured on the ten close looks of that reel (the tall layout): the eight that show their player had him inside in 78%
to 100% of the frames, at 0.35 to 0.68 of the window's height; the two bad ones scored 8% of the frames (walked out)
and 0.30 of the height (behind the glass).
Pure: numbers in, numbers out.
"""
import numpy as np

FPS = 30000 / 1001
W, H = 1920, 1080
ZMIN, ZMAX = 1.5, 2.0       # a window is never narrower than half the picture (README, "A close look at the far end")
SHOWN = 1440 / 1920         # the tall reel shows the middle 1440 of 1920 columns of the window (render.py, stage)
SHARE = 0.7                 # the player inside the shown window in 70% of the frames of the part, or more
INSIDE = 0.75               # inside: 75% of the box's area in the shown window, or more
TALL = 0.33                 # the box's median height: a third of the window's height, or more
SMOOTH = 9                  # render.py smooths the window's centre over 2 * 9 + 1 frames


def track_at(tr, f):
    """Each player at frame f, interpolated: box (4) followed by the head point (2). Absent when not followed there
    (more than 6 frames past either end of the track, or inside a gap of more than 30 frames)."""
    out = {}
    for k, p in tr['players'].items():
        fs = p['f']
        v = lambda j: np.array(p['box'][j] + p['head'][j])
        i = np.searchsorted(fs, f)
        if i == 0:
            if fs[0] - f <= 6: out[int(k)] = v(0)
            continue
        if i >= len(fs):
            if f - fs[-1] <= 6: out[int(k)] = v(-1)
            continue
        a, b = fs[i - 1], fs[i]
        if b - a > 30: continue
        w = (f - a) / (b - a)
        out[int(k)] = (1 - w) * v(i - 1) + w * v(i)
    return out


def height(tr, who, a, b):
    """How tall the player is in the picture between a and b (the median of the track's boxes), or None."""
    p = tr['players'].get(str(who))
    if not p: return None
    f = np.array(p['f']) / tr['fps'] + tr['t0']; m = (f >= a) & (f <= b)
    if not m.any(): return None
    box = np.array(p['box'])[m]; return float(np.median(box[:, 3] - box[:, 1]))


def zoom_for(tr, who, a, b):
    """The zoom of a close look: the player about 520 lines tall, between ZMIN and ZMAX."""
    h = height(tr, who, a, b)
    return float(np.clip(520 / max(h, 60), ZMIN, ZMAX)) if h else ZMAX


def window(zoom):
    """The size of the window (width, height) in the 1920x1080 picture."""
    return int(W / zoom) // 2 * 2, int(H / zoom) // 2 * 2


def centres(tr, focus, off, n, start=(W / 2, H / 2)):
    """The smoothed centre of the window for each of n frames from frame `off` of the track, as render.py moves it:
    the focus player's box (a little above its middle), the last one held where the tracker loses him, the first one
    held before the tracker finds him. -> (array n x 2, the frame the tracker first holds him or None)."""
    cx, cy = start; cs = []; first = None
    for k in range(n):
        b = track_at(tr, k + off).get(focus) if tr and focus is not None else None
        if b is not None:
            cx, cy = (b[0] + b[2]) / 2, (b[1] + b[3]) / 2 - 0.05 * (b[3] - b[1])
            if first is None: first = k
        cs.append((cx, cy))
    if first: cs[:first] = [cs[first]] * first
    c = np.array(cs, float).reshape(-1, 2)
    if len(c): c = np.stack([np.convolve(np.pad(c[:, j], SMOOTH, mode='edge'), np.ones(2 * SMOOTH + 1) / (2 * SMOOTH + 1), mode='valid') for j in (0, 1)], 1)
    return c, first


def framed(tr, who, t0, t1, zoom=None):
    """How well a close look of [t0, t1] shows player `who`: {'share': frames with the box inside the shown window over
    all frames, 'tall': the box's median height over the window's height, 'ok': both at their limits, 'zoom'}."""
    zoom = zoom or zoom_for(tr, who, t0, t1)
    cw, ch = window(zoom); n = max(int(np.ceil((t1 - t0) * FPS)), 1); off = int(round((t0 - tr['t0']) * FPS))
    c, _ = centres(tr, who, off, n)
    inside, hs = 0, []
    for k in range(n):
        b = track_at(tr, k + off).get(who)
        if b is None: continue
        x0 = float(np.clip(c[k][0] - cw / 2, 0, W - cw)); y0 = float(np.clip(c[k][1] - ch / 2, 0, H - ch))
        sx0, sx1 = x0 + cw * (1 - SHOWN) / 2, x0 + cw * (1 + SHOWN) / 2
        area = max((b[2] - b[0]) * (b[3] - b[1]), 1.0)
        ix = max(0.0, min(b[2], sx1) - max(b[0], sx0)); iy = max(0.0, min(b[3], y0 + ch) - max(b[1], y0))
        if ix * iy / area >= INSIDE: inside += 1
        hs.append((b[3] - b[1]) / ch)
    share = inside / n; tall = float(np.median(hs)) if hs else 0.0
    return {'share': round(share, 2), 'tall': round(tall, 2), 'ok': share >= SHARE and tall >= TALL, 'zoom': round(zoom, 2)}


def _test():
    """Made-up tracks: a player who stays, one who walks out of the picture, one who is lost, one who is small."""
    def track(boxes, fps=FPS, step=2):
        return {'fps': fps, 't0': 0.0, 'players': {'3': {'f': [k * step for k in range(len(boxes))], 'box': boxes, 'head': [[(b[0] + b[2]) / 2, b[1]] for b in boxes]}}}
    stay = track([[800, 400, 1000, 900]] * 40)
    assert framed(stay, 3, 0.5, 2.0)['ok'], framed(stay, 3, 0.5, 2.0)
    # walks out at the left: x falls 40 px a track frame, from 600 to past the edge
    out = track([[600 - 40 * k, 400, 800 - 40 * k, 900] for k in range(40)])
    r = framed(out, 3, 0.5, 2.5); assert not r['ok'] and r['share'] < SHARE, r
    # lost after 0.5 s: the window holds his last box, and the frames without him count as outside
    lost = track([[800, 400, 1000, 900]] * 8)
    r = framed(lost, 3, 0.0, 2.4); assert not r['ok'] and r['share'] < SHARE, r
    # small: 170 lines tall, at the largest zoom (540 lines of window): 0.31 of its height
    small = track([[1400, 300, 1480, 470]] * 40)
    r = framed(small, 3, 0.5, 2.0); assert not r['ok'] and r['share'] >= SHARE and r['tall'] < TALL, r
    # render.py's window for a player held all through follows him: the centre is his box's centre, a little high
    c, first = centres(stay, 3, 0, 10); assert first == 0 and abs(c[5][0] - 900) < 1 and abs(c[5][1] - 625) < 1, c[5]
    print('closeup: 5 checks passed')


if __name__ == '__main__':
    _test()
