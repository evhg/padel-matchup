"""Cards that are not in gfx.py, so that a new card does not make every part of a reel older than its drawing code.

stats_grid: the numbers of a match, six to a card. rows: [(big value, what it counts, who, team 0 | 1 | None)].
Only a number that the score engine counted, or that a device measured, belongs on it (README: "A number on the
screen is a measured number")."""
import cv2, numpy as np
import gfx
from gfx import W, H, TW, TH, LIME, WHITE, font, tracked, tracked_w

SOFT = (120, 160, 255)     # the second pair on a dark ground (gfx.BLUE is for a filled tag)


def _tile(d, cx, y, row, big, mid, small, maxw):
    val, lab, who, team = (list(row) + [None, None])[:4]
    f = gfx._fit(str(val), big, 2, maxw); w = tracked_w(str(val), f, 2); tracked(d, (cx - w / 2, y), str(val), f, LIME, 2)
    f2 = gfx._fit(lab.upper(), mid, 3, maxw, 'SemiBold'); w2 = tracked_w(lab.upper(), f2, 3); tracked(d, (cx - w2 / 2, y + big * 1.12), lab.upper(), f2, WHITE, 3)
    if who:
        f3 = gfx._fit(who.upper(), small, 4, maxw); w3 = tracked_w(who.upper(), f3, 4)
        tracked(d, (cx - w3 / 2, y + big * 1.12 + mid * 1.55), who.upper(), f3, LIME if team == 0 else SOFT if team == 1 else (200, 205, 212), 4)


def stats_grid(bg_bgr, title, rows, foot='kicksma.sh'):
    im, d = gfx._over(gfx.darken(bg_bgr))
    gfx.centred(d, 70, title.upper(), font(64, 'ExtraBold'), WHITE, 6); d.rectangle((W / 2 - 60, 158, W / 2 + 60, 164), fill=LIME)
    cols = 3; colw = W / (cols + 0.3); x0 = (W - colw * cols) / 2
    for i, row in enumerate(rows[:6]): _tile(d, x0 + colw * (i % cols + 0.5), 215 + 375 * (i // cols), row, 150, 36, 34, colw - 50)
    gfx.centred(d, 985, foot.upper(), font(38, 'ExtraBold'), LIME, 10)
    return cv2.cvtColor(np.array(im), cv2.COLOR_RGB2BGR)


def stats_grid_tall(bg_bgr, title, rows, foot='kicksma.sh'):
    im, d = gfx._over(gfx._tall_bg(bg_bgr))
    gfx._c(d, 200, title.upper(), gfx._fit(title.upper(), 68, 6, TW - 120), WHITE, 6); d.rectangle((TW / 2 - 60, 296, TW / 2 + 60, 302), fill=LIME)
    for i, row in enumerate(rows[:6]): _tile(d, TW * (0.27 if i % 2 == 0 else 0.73), 400 + 440 * (i // 2), row, 150, 34, 32, TW / 2 - 50)
    gfx._c(d, 1760, foot.upper(), font(40, 'ExtraBold'), LIME, 10)
    return cv2.cvtColor(np.array(im), cv2.COLOR_RGB2BGR)
