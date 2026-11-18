"""Broadcast graphics for the highlight reel: cards, lower thirds, name tags. Kicksmash colours, Barlow Condensed."""
import os, numpy as np, cv2
from PIL import Image, ImageDraw, ImageFont, ImageFilter

S = os.environ.get('HL_HOME') or os.path.dirname(os.path.dirname(os.path.abspath(__file__)))   # models/, fonts/ and match/ live here
LIME, INK, BLUE, WHITE = (200, 241, 53), (20, 22, 26), (27, 79, 216), (255, 255, 255)
W, H = 1920, 1080
_fonts = {}
def font(size, weight='ExtraBold'):
    k = (size, weight)
    if k not in _fonts: _fonts[k] = ImageFont.truetype(f'{S}/fonts/BarlowCondensed-{weight}.ttf', size)
    return _fonts[k]

def text_w(s, f): return f.getbbox(s)[2]

def tracked(d, xy, s, f, fill, spacing=0):
    """Text with letter spacing."""
    x, y = xy
    for ch in s:
        d.text((x, y), ch, font=f, fill=fill); x += f.getlength(ch) + spacing
    return x

def tracked_w(s, f, spacing): return sum(f.getlength(ch) + spacing for ch in s) - spacing

def rgba_to_bgra(im):
    a = np.array(im); return a[:, :, [2, 1, 0, 3]]

def blit(frame, bgra, x, y, alpha=1.0):
    """Alpha-blend a BGRA image onto a BGR frame at (x, y), clipped."""
    h, w = bgra.shape[:2]
    x0, y0 = max(0, x), max(0, y); x1, y1 = min(frame.shape[1], x + w), min(frame.shape[0], y + h)
    if x1 <= x0 or y1 <= y0: return
    src = bgra[y0 - y:y1 - y, x0 - x:x1 - x]
    a = (src[:, :, 3:4].astype(np.float32) / 255.0) * alpha
    dst = frame[y0:y1, x0:x1].astype(np.float32)
    frame[y0:y1, x0:x1] = (dst * (1 - a) + src[:, :, :3].astype(np.float32) * a).astype(np.uint8)

def name_tag(name, team):
    """A small pill that floats over a player's head: lime for one pair, blue for the other; a pointer below."""
    f = font(34, 'ExtraBold'); s = name.upper()
    tw = int(tracked_w(s, f, 1.5)); pad = 14; h = 46
    im = Image.new('RGBA', (tw + 2 * pad, h + 12), (0, 0, 0, 0)); d = ImageDraw.Draw(im)
    bg, fg = (LIME, INK) if team == 0 else (BLUE, WHITE)
    d.rounded_rectangle((0, 0, tw + 2 * pad - 1, h - 1), 8, fill=bg + (255,))
    cx = (tw + 2 * pad) // 2
    d.polygon([(cx - 9, h - 1), (cx + 9, h - 1), (cx, h + 10)], fill=bg + (255,))
    tracked(d, (pad, 1), s, f, fg + (255,), 1.5)
    return rgba_to_bgra(im)

def lower_third(title, sub=None, col=LIME):
    """Bottom-left: a bar in the colour, the title on ink, a smaller line under it."""
    f1, f2 = font(64, 'ExtraBold'), font(34, 'SemiBold')
    t = title.upper(); w1 = int(tracked_w(t, f1, 2)); w2 = int(tracked_w(sub.upper(), f2, 2)) if sub else 0
    w = max(w1, w2) + 64; h = 86 + (48 if sub else 0)
    im = Image.new('RGBA', (w + 14, h), (0, 0, 0, 0)); d = ImageDraw.Draw(im)
    d.rectangle((0, 0, 13, h - 1), fill=tuple(col) + (255,))
    d.rectangle((14, 0, w + 13, h - 1), fill=INK + (235,))
    tracked(d, (40, 4), t, f1, WHITE + (255,), 2)
    if sub: tracked(d, (40, 82), sub.upper(), f2, tuple(col) + (255,), 2)
    return rgba_to_bgra(im)

def badge(text, bg=LIME, fg=INK, size=40):
    f = font(size, 'ExtraBold'); s = text.upper(); tw = int(tracked_w(s, f, 3)); pad = 18; h = int(size * 1.35)
    im = Image.new('RGBA', (tw + 2 * pad, h), (0, 0, 0, 0)); d = ImageDraw.Draw(im)
    d.rectangle((0, 0, tw + 2 * pad - 1, h - 1), fill=bg + (255,))
    tracked(d, (pad, int(size * 0.02)), s, f, fg + (255,), 3)
    return rgba_to_bgra(im)

def bug(venue):
    """Top-left: KICKSMASH and the venue, always on."""
    f1, f2 = font(34, 'ExtraBold'), font(30, 'SemiBold')
    a, b = 'KICKSMASH', venue.upper()
    wa, wb = int(tracked_w(a, f1, 3)), int(tracked_w(b, f2, 3))
    im = Image.new('RGBA', (wa + wb + 76, 50), (0, 0, 0, 0)); d = ImageDraw.Draw(im)
    d.rectangle((0, 0, wa + 31, 49), fill=LIME + (255,)); tracked(d, (16, 2), a, f1, INK + (255,), 3)
    d.rectangle((wa + 32, 0, wa + wb + 75, 49), fill=INK + (225,)); tracked(d, (wa + 48, 5), b, f2, WHITE + (255,), 3)
    return rgba_to_bgra(im)

def darken(bg_bgr, blur=18, dim=0.38):
    im = Image.fromarray(cv2.cvtColor(bg_bgr, cv2.COLOR_BGR2RGB)).filter(ImageFilter.GaussianBlur(blur))
    return (np.array(im).astype(np.float32) * dim).astype(np.uint8)

def centred(d, y, s, f, fill, spacing=0):
    w = tracked_w(s, f, spacing); tracked(d, ((W - w) / 2, y), s, f, fill, spacing); return w

def intro_card(bg_bgr, venue, date, pair_a, pair_b, score, kicker='MATCH HIGHLIGHTS'):
    """The opening card over a blurred frame of the court."""
    im = Image.fromarray(darken(bg_bgr)); d = ImageDraw.Draw(im)
    centred(d, 150, kicker, font(44, 'SemiBold'), LIME, 10)
    d.rectangle((W / 2 - 60, 222, W / 2 + 60, 228), fill=LIME)
    fa = font(150, 'ExtraBold')
    centred(d, 270, pair_a.upper(), fa, WHITE, 3)
    centred(d, 438, 'VS', font(60, 'SemiBold'), LIME, 8)
    centred(d, 520, pair_b.upper(), fa, WHITE, 3)
    centred(d, 740, score, font(110, 'ExtraBold'), LIME, 12)
    centred(d, 900, '  ·  '.join(x for x in (venue, date) if x).upper(), font(40, 'SemiBold'), (200, 205, 212), 6)
    return cv2.cvtColor(np.array(im), cv2.COLOR_RGB2BGR)

def stats_card(bg_bgr, title, rows, foot='kicksma.sh'):
    """rows: [(big number, label)], up to four across."""
    im = Image.fromarray(darken(bg_bgr)); d = ImageDraw.Draw(im)
    centred(d, 150, title.upper(), font(72, 'ExtraBold'), WHITE, 6)
    d.rectangle((W / 2 - 60, 250, W / 2 + 60, 256), fill=LIME)
    n = len(rows); colw = W / (n + 0.6); x0 = (W - colw * n) / 2
    for i, (num, lab) in enumerate(rows):
        cx = x0 + colw * (i + 0.5)
        f = font(190, 'ExtraBold'); w = tracked_w(str(num), f, 2)
        tracked(d, (cx - w / 2, 380), str(num), f, LIME, 2)
        f2 = font(40, 'SemiBold'); w2 = tracked_w(lab.upper(), f2, 4)
        tracked(d, (cx - w2 / 2, 620), lab.upper(), f2, WHITE, 4)
    centred(d, 900, foot.upper(), font(44, 'ExtraBold'), LIME, 10)
    return cv2.cvtColor(np.array(im), cv2.COLOR_RGB2BGR)

def player_card(frame_bgr, box, name, team, sub=None):
    """A close-up of one player (the box, with room around it) on the right, the name on the left."""
    x0, y0, x1, y1 = box[:4]; bh = y1 - y0; cx = (x0 + x1) / 2
    ch = min(H, bh * 1.25); cw = ch * (900 / 1080)
    cy = (y0 + y1) / 2
    X0 = int(np.clip(cx - cw / 2, 0, frame_bgr.shape[1] - cw)); Y0 = int(np.clip(cy - ch / 2, 0, frame_bgr.shape[0] - ch))
    crop = frame_bgr[Y0:Y0 + int(ch), X0:X0 + int(cw)]
    crop = cv2.resize(crop, (900, 1080), interpolation=cv2.INTER_LANCZOS4)
    canvas = darken(frame_bgr, 24, 0.3)
    canvas[:, W - 900:] = crop
    im = Image.fromarray(cv2.cvtColor(canvas, cv2.COLOR_BGR2RGB)); d = ImageDraw.Draw(im)
    col = LIME if team == 0 else (120, 160, 255)
    d.rectangle((W - 900 - 14, 0, W - 900, H), fill=col)
    tracked(d, (110, 380), name.upper(), font(210, 'ExtraBold'), WHITE, 4)
    d.rectangle((114, 610, 114 + 120, 618), fill=col)
    if sub: tracked(d, (114, 650), sub.upper(), font(48, 'SemiBold'), col, 6)
    return cv2.cvtColor(np.array(im), cv2.COLOR_RGB2BGR)

def counter(n, final=False, pop=0.0):
    """Top-right: the rally's shot count. `pop` (0..1) makes the number larger for a moment when it rises."""
    size = int(84 * (1 + 0.22 * pop)); f = font(size, 'ExtraBold'); f2 = font(30, 'SemiBold')
    s = str(n); lab = 'SHOTS'
    wn = int(text_w(s, f)); wl = int(tracked_w(lab, f2, 4)); w = max(150, wn + 44, wl + 44); h = 150
    im = Image.new('RGBA', (w, h), (0, 0, 0, 0)); d = ImageDraw.Draw(im)
    d.rectangle((0, 0, w - 1, h - 1), fill=(LIME if final else INK) + (255 if final else 225,))
    d.rectangle((0, h - 8, w - 1, h - 1), fill=(INK if final else LIME) + (255,))
    d.text(((w - wn) / 2, 44 - size * 0.42 + 6), s, font=f, fill=(INK if final else WHITE) + (255,))
    tracked(d, ((w - wl) / 2, 100), lab, f2, (INK if final else LIME) + (255,), 4)
    return rgba_to_bgra(im)

def outro_card(bg_bgr, line1, line2, foot='kicksma.sh'):
    im = Image.fromarray(darken(bg_bgr, 22, 0.28)); d = ImageDraw.Draw(im)
    centred(d, 330, 'KICKSMASH', font(200, 'ExtraBold'), LIME, 10)
    d.rectangle((W / 2 - 60, 580, W / 2 + 60, 586), fill=LIME)
    centred(d, 630, line1.upper(), font(56, 'SemiBold'), WHITE, 6)
    centred(d, 710, line2.upper(), font(40, 'SemiBold'), (200, 205, 212), 6)
    return cv2.cvtColor(np.array(im), cv2.COLOR_RGB2BGR)

# ---- the vertical reel (1080 x 1920, for a phone held upright) ----
TW, TH = 1080, 1920
def _tall_bg(bg_bgr, dim=0.3):
    h, w = bg_bgr.shape[:2]; cw = int(h * TW / TH); x0 = (w - cw) // 2
    return darken(cv2.resize(bg_bgr[:, x0:x0 + cw], (TW, TH), interpolation=cv2.INTER_CUBIC), 20, dim)
def _c(d, y, s, f, fill, spacing=0):
    w = tracked_w(s, f, spacing); tracked(d, ((TW - w) / 2, y), s, f, fill, spacing)
def _fit(s, size, spacing, maxw, weight='ExtraBold'):
    while size > 40 and tracked_w(s, font(size, weight), spacing) > maxw: size -= 6
    return font(size, weight)

def intro_card_tall(bg_bgr, venue, date, pair_a, pair_b, score, kicker='MATCH HIGHLIGHTS'):
    im = Image.fromarray(_tall_bg(bg_bgr)); d = ImageDraw.Draw(im)
    _c(d, 420, kicker, font(44, 'SemiBold'), LIME, 10); d.rectangle((TW / 2 - 60, 492, TW / 2 + 60, 498), fill=LIME)
    fa = _fit(pair_a.upper(), 150, 3, TW - 120); fb = _fit(pair_b.upper(), 150, 3, TW - 120); f = fa if fa.size < fb.size else fb
    _c(d, 580, pair_a.upper(), f, WHITE, 3); _c(d, 770, 'VS', font(60, 'SemiBold'), LIME, 8); _c(d, 870, pair_b.upper(), f, WHITE, 3)
    _c(d, 1130, score, _fit(score, 110, 10, TW - 120), LIME, 10)
    _c(d, 1330, venue.upper(), font(40, 'SemiBold'), (200, 205, 212), 6); _c(d, 1390, date.upper(), font(40, 'SemiBold'), (200, 205, 212), 6)
    return cv2.cvtColor(np.array(im), cv2.COLOR_RGB2BGR)

def stats_card_tall(bg_bgr, title, rows, foot='kicksma.sh'):
    im = Image.fromarray(_tall_bg(bg_bgr)); d = ImageDraw.Draw(im)
    _c(d, 330, title.upper(), _fit(title.upper(), 72, 6, TW - 120), WHITE, 6); d.rectangle((TW / 2 - 60, 430, TW / 2 + 60, 436), fill=LIME)
    for i, (num, lab) in enumerate(rows):
        cx = TW * (0.27 if i % 2 == 0 else 0.73); y = 560 + 420 * (i // 2)
        f = font(190, 'ExtraBold'); w = tracked_w(str(num), f, 2); tracked(d, (cx - w / 2, y), str(num), f, LIME, 2)
        f2 = font(40, 'SemiBold'); w2 = tracked_w(lab.upper(), f2, 4); tracked(d, (cx - w2 / 2, y + 240), lab.upper(), f2, WHITE, 4)
    _c(d, 1520, foot.upper(), font(44, 'ExtraBold'), LIME, 10)
    return cv2.cvtColor(np.array(im), cv2.COLOR_RGB2BGR)

def outro_card_tall(bg_bgr, line1, line2):
    im = Image.fromarray(_tall_bg(bg_bgr, 0.26)); d = ImageDraw.Draw(im)
    _c(d, 720, 'KICKSMASH', _fit('KICKSMASH', 200, 8, TW - 120), LIME, 8); d.rectangle((TW / 2 - 60, 950, TW / 2 + 60, 956), fill=LIME)
    _c(d, 1000, line1.upper(), _fit(line1.upper(), 52, 5, TW - 100, 'SemiBold'), WHITE, 5); _c(d, 1080, line2.upper(), font(36, 'SemiBold'), (200, 205, 212), 5)
    return cv2.cvtColor(np.array(im), cv2.COLOR_RGB2BGR)

def player_card_tall(frame_bgr, box, name, team, sub=None):
    """The close-up fills the top two thirds; the name stands under it."""
    x0, y0, x1, y1 = box[:4]; bh = y1 - y0; cx = (x0 + x1) / 2; cy = (y0 + y1) / 2
    ch = min(frame_bgr.shape[0], bh * 1.25); cw = ch * (1080 / 1280)
    X0 = int(np.clip(cx - cw / 2, 0, frame_bgr.shape[1] - cw)); Y0 = int(np.clip(cy - ch / 2, 0, frame_bgr.shape[0] - ch))
    crop = cv2.resize(frame_bgr[Y0:Y0 + int(ch), X0:X0 + int(cw)], (1080, 1280), interpolation=cv2.INTER_LANCZOS4)
    canvas = np.zeros((TH, TW, 3), np.uint8); canvas[:] = INK[::-1]; canvas[:1280] = crop
    im = Image.fromarray(cv2.cvtColor(canvas, cv2.COLOR_BGR2RGB)); d = ImageDraw.Draw(im)
    col = LIME if team == 0 else (120, 160, 255)
    d.rectangle((0, 1280, TW, 1294), fill=col)
    f = _fit(name.upper(), 230, 4, TW - 140); tracked(d, (70, 1350), name.upper(), f, WHITE, 4)
    d.rectangle((74, 1620, 194, 1628), fill=col)
    if sub: tracked(d, (74, 1660), sub.upper(), font(52, 'SemiBold'), col, 6)
    return cv2.cvtColor(np.array(im), cv2.COLOR_RGB2BGR)

def tall_base(venue, pair_a, pair_b, score):
    """The standing frame of the vertical reel: ink, the two pairs and the score under the picture."""
    im = Image.new('RGB', (TW, TH), INK); d = ImageDraw.Draw(im)
    d.rectangle((0, 0, TW, 10), fill=LIME)
    f = _fit(pair_a.upper(), 76, 3, TW - 160)
    tracked(d, (60, 1420), pair_a.upper(), f, LIME, 3); tracked(d, (60, 1512), 'VS', font(36, 'SemiBold'), (150, 156, 165), 6)
    tracked(d, (60, 1566), pair_b.upper(), f, (120, 160, 255), 3)
    tracked(d, (60, 1690), score, font(64, 'ExtraBold'), WHITE, 8)
    w = tracked_w('KICKSMA.SH', font(34, 'ExtraBold'), 8); tracked(d, (TW - w - 60, 1716), 'KICKSMA.SH', font(34, 'ExtraBold'), (150, 156, 165), 8)
    return cv2.cvtColor(np.array(im), cv2.COLOR_RGB2BGR)
