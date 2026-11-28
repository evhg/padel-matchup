"""The opening of the reel: the two teams face each other, like the start of a round in an arcade fighting game.

usage: versus.py <match.json> <faces.json> <frames_dir> <out.mp4> [still seconds ...]     (TALL=1 for the vertical reel)

An original design in Kicksmash colours: team A slides in from the left on lime, "VS" hits the middle, team B slides in
from the right on blue, the score sets, "GAME ON". Every sound is made here from numbers (no samples): whooshes, thumps,
a boom, a short chord. The announcer's lines are spoken by an offline voice when one is installed (VOICE=0 turns it off).
With times after the output name, it writes those frames as <out>.jpg and no video (to look before rendering).
Environment: TALL=1 (the vertical reel). SCALE (K: the output is K times as large; 2 gives 3840x2160). KF4K (a folder of
4K frames with the names of the sampled frames: a portrait whose frame is there is cut from it, so at SCALE=2 a face has
the detail of the camera and is not an enlarged picture). Each run prints one line for each portrait that says where it
came from. <faces.json> of portrait.py: the first entry of each player is the portrait, cut from its own camera frame
("hi"); of faces.py: the largest sharp face that looks to the camera.
"""
import sys, os, json, subprocess, tempfile, numpy as np, cv2
from PIL import Image, ImageFilter
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import gfx
S = os.environ.get('HL_HOME') or os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
matchf, facesf, frames, out = sys.argv[1:5]; stills = [float(x) for x in sys.argv[5:]]
MT = json.load(open(matchf)); FACES = json.load(open(facesf))
TALL = os.environ.get('TALL') == '1'
W, H = (1080, 1920) if TALL else (1920, 1080)
FPS = 30000 / 1001; DUR = 6.5
LIME, INK, BLUE, WHITE = gfx.LIME, gfx.INK, (60, 110, 255), (255, 255, 255)
names = [MT['names'][str(i)] for i in range(4)]; team = [MT['team'][str(i)] for i in range(4)]
A = sorted([k for k in range(4) if team[k] == 0], key=lambda k: names[k]); B = sorted([k for k in range(4) if team[k] == 1], key=lambda k: names[k])
import teams; teams.fill(MT)
title_a = ('Team ' + MT['team_a']) if MT.get('team_a') else MT['pair_a']; title_b = ('Team ' + MT['team_b']) if MT.get('team_b') else MT['pair_b']
# "title_a" and "title_b" in match.json: the whole title of a team as the players say it ("The girls"), with no "Team"
title_a, title_b = MT.get('title_a') or title_a, MT.get('title_b') or title_b
# The scale. Every position and size in this file is a design number: it belongs to the 1920x1080 picture (the vertical
# reel: 1080x1920). SCALE=K makes the output K times as large. Only this block knows K: px() (a design number -> pixels
# of the output), dw() and dh() (the design size of a picture that is drawn K times as large), sheet() and ital() (a
# canvas and a font of gfx.py: the text and the plates are drawn sharp at the final size, and measured in design
# numbers), and put() below (a picture at a design point). With K = 1 each of them does what the file did before.
K = gfx.reel_scale()
def px(v): return int(round(v * K))
def dw(im): return im.width / K
def dh(im): return im.height / K
def sheet(size, mode='RGBA', colour=(0, 0, 0, 0)): return gfx._sheet(mode, size, colour)
def ital(size): return gfx.font(size, 'ExtraBoldItalic')

# ---- the portraits: the best face of each player, cut out of its background ----
KF4K = os.environ.get('KF4K')
def face_again(im, face, m):
    """The face of a sampled frame, in a frame m times as large that the camera took up to a second before or after:
    the player moved. -> the nearest face of about the same size around the old place (x, y, w, h, how far in faces,
    how much to the camera), or None. The same detector as faces.py (YuNet, MIT licence), on the frame as stored."""
    x, y, w, h = (v * m for v in face); cx, cy = x + w / 2, y + h / 2; R = 6 * max(w, h)
    x0, y0 = int(max(0, cx - R)), int(max(0, cy - R)); cr = im[y0:int(cy + R), x0:int(cx + R)]
    det = cv2.FaceDetectorYN.create(f'{S}/models/yunet.onnx', '', (cr.shape[1], cr.shape[0]), 0.6, 0.3, 50)
    best = None; found = det.detect(cr)[1]
    for f in ([] if found is None else found):
        d = float(np.hypot(x0 + f[0] + f[2] / 2 - cx, y0 + f[1] + f[3] / 2 - cy)) / max(w, h)
        if 0.5 <= f[2] / w <= 2 and d <= 3 and (best is None or d < best[4]): best = (x0 + float(f[0]), y0 + float(f[1]), float(f[2]), float(f[3]), d, float(abs(f[4] - f[6]) / f[2]))
    return best
def portrait(k, height):
    """-> the portrait of player k, px(height) high, and the design place of the face inside it; None when the frames of
    this match hold no face of the player (28 November 2026: a film of two matches, whose first match had one clip, gave
    one player no face, and the opening failed on an empty list). The name plate then shows alone."""
    if not FACES.get(str(k)):
        print(f"portrait {k} {names[k]}: no face in this match's frames; the name plate shows alone"); return None
    if FACES[str(k)][0].get('hi'):
        # portrait.py chose it (best first): its frame of the camera file, and the face in that frame
        o = FACES[str(k)][0]; hi = o['hi']
        im = cv2.imread(os.path.join(os.path.dirname(os.path.abspath(facesf)), hi['file'])); x, y, w, h = hi['face']
        said = f"{hi['file']} ({hi['t']:.2f} s), score {o.get('score', 0):.3f}"
    else:
        c = [o for o in FACES[str(k)] if o['sharp'] >= 220] or FACES[str(k)]
        o = max(c, key=lambda o: o['face'][2] ** 1.5 * min(o['sharp'], 450) * o['eyes'] ** 2)
        im = cv2.imread(f"{frames}/{o['f']}"); x, y, w, h = o['face']; said = f"sampled frame {o['f']}"
    if KF4K and not o.get('hi') and os.path.exists(f"{KF4K}/{o['f']}"):      # the same name, not the same moment: find the player again
        big = cv2.imread(f"{KF4K}/{o['f']}"); f = face_again(big, o['face'], big.shape[1] / im.shape[1])
        if f is None: said += ' (the 4K frame has no face near the old place)'
        else:
            im = big; x, y, w, h = f[:4]; said = f"4K frame {KF4K}/{o['f']}, the face {f[4]:.1f} faces from its old place"
            if f[5] < 0.6 * o['eyes']: said += f", and turned away more (eyes {f[5]:.2f} of the face width; sampled frame: {o['eyes']:.2f})"
    cx = x + w / 2; r = max(w, h)
    if os.environ.get('HDR'):      # the frames of an HDR video are stored as read
        import hdr; im = hdr.sdr(im, os.environ['HDR'])
    x0, x1 = int(max(0, cx - 2.1 * r)), int(min(im.shape[1], cx + 2.1 * r)); y0, y1 = int(max(0, y - 1.1 * r)), int(min(im.shape[0], y + 3.9 * r))
    cr = im[y0:y1, x0:x1]
    from rembg import remove, new_session
    global _ses
    try: _ses
    except NameError:
        # CUTOUT names the model that cuts the person out. The first one (u2net_human_seg) keeps a fence or a net
        # behind the player; birefnet-general-lite (MIT licence, about 7 seconds a portrait) does not.
        # Without the memory arena of the runtime: with it the process kept 12 GB from the second portrait to the end
        # (and the kernel killed it); without it, 7 GB while one portrait is cut and under 1 GB after. The mask is the same.
        import onnxruntime; so = onnxruntime.SessionOptions(); so.enable_cpu_mem_arena = False
        os.environ.setdefault('U2NET_HOME', f'{S}/models/u2net'); _ses = new_session(os.environ.get('CUTOUT', 'u2net_human_seg'), sess_opts=so)
    if os.environ.get('GRADE'):      # under the lamps of a hall a face is pale and blue: a little warmer
        cr = np.clip(cr.astype(np.float32) * np.array([0.93, 1.0, 1.06], np.float32), 0, 255).astype(np.uint8)
    rgba = np.array(remove(cv2.cvtColor(cr, cv2.COLOR_BGR2RGB), session=_ses, post_process_mask=os.environ.get('CUTOUT', 'u2net_human_seg').startswith('u2net')))
    # only the person: a loose hand of somebody else, or a piece of a racket, goes
    al = (rgba[:, :, 3] > 100).astype(np.uint8); nlab, lab, stats, _ = cv2.connectedComponentsWithStats(al, 8)
    if nlab > 2: rgba[:, :, 3] = np.where(lab == 1 + int(np.argmax(stats[1:, cv2.CC_STAT_AREA])), rgba[:, :, 3], 0)
    # the cut at the chest fades out, so no hard edge shows
    fade = np.ones(rgba.shape[0], np.float32); n = int(rgba.shape[0] * 0.14); fade[-n:] = np.linspace(1, 0, n) ** 0.7
    rgba[:, :, 3] = (rgba[:, :, 3] * fade[:, None]).astype(np.uint8)
    print(f"portrait {k} {names[k]}: {said}; face {w:.0f} pixels wide, cut {rgba.shape[1]}x{rgba.shape[0]} -> {px(height)} high ({px(height) / rgba.shape[0]:.2f} times)")
    p = Image.fromarray(rgba).resize((int(rgba.shape[1] * height * K / rgba.shape[0]), px(height)), Image.LANCZOS)
    rgb = p.convert('RGB').filter(ImageFilter.UnsharpMask(radius=2.2 * K, percent=70, threshold=2))      # real pixels, a little crisper; no invented detail
    p = Image.merge('RGBA', (*rgb.split(), p.split()[3]))
    # the face's place inside the portrait, so two portraits can stand with their heads level
    return p, ((cx - x0) * height / rgba.shape[0], (y + h / 2 - y0) * height / rgba.shape[0])

def put(canvas, img, x, y):
    """alpha_composite at the design point (x, y) that also takes a place partly outside the canvas."""
    x, y = px(x), px(y); cx0, cy0 = max(0, x), max(0, y); cx1, cy1 = min(canvas.width, x + img.width), min(canvas.height, y + img.height)
    if cx1 <= cx0 or cy1 <= cy0: return
    canvas.alpha_composite(img.crop((cx0 - x, cy0 - y, cx1 - x, cy1 - y)), (cx0, cy0))
def tint(img, colour):
    a = img.split()[3]; s = Image.new('RGBA', img.size, colour + (255,)); s.putalpha(a); return s
def plate(text, bg, fg, size, pad=26, skew=16):
    f = ital(size); tw = int(f.getlength(text)); h = int(size * 1.18)
    im, d = sheet((tw + 2 * pad + skew, h))
    d.polygon([(skew, 0), (tw + 2 * pad + skew, 0), (tw + 2 * pad, h), (0, h)], fill=bg + (255,))
    d.text((pad + skew // 2, -int(size * 0.06)), text, font=f, fill=fg + (255,)); return im
def words(text, size, fill, shadow=None, off=8):
    f = ital(size); tw = int(f.getlength(text)); h = int(size * 1.2)
    im, d = sheet((tw + 40, h + 20))
    if shadow: d.text((10 + off, off), text, font=f, fill=shadow + (255,))
    d.text((10, 0), text, font=f, fill=fill + (255,)); return im
def fit_words(text, size, maxw, fill, shadow=None):
    while size > 44 and ital(size).getlength(text) > maxw: size -= 6
    return words(text, size, fill, shadow, off=max(4, size // 14))
def e_out(x): x = min(1.0, max(0.0, x)); return 1 - (1 - x) ** 3
def e_back(x):
    x = min(1.0, max(0.0, x)); c = 1.70158; return 1 + (c + 1) * (x - 1) ** 3 + c * (x - 1) ** 2

# ---- the layout ----
if TALL:
    PH = 600
    SLOT = {A[0]: (280, 800), A[1]: (800, 800), B[0]: (280, 1660), B[1]: (800, 1660)}       # the middle of the feet line of each portrait
    TITLE_A, TITLE_B = (60, 70, 'l'), (W - 60, 990, 'r'); VS_AT, VS_SIZE = (540, 905), 250; SCORE_Y = 1815; MAXW = W - 120
    PANEL_A = [(0, 0), (W, 0), (W, 860), (0, 980)]; PANEL_B = [(0, 1000), (W, 880), (W, H), (0, H)]
else:
    PH = 620
    SLOT = {A[0]: (215, 800), A[1]: (585, 800), B[0]: (1335, 800), B[1]: (1705, 800)}
    TITLE_A, TITLE_B = (70, 36, 'l'), (W - 70, 36, 'r'); VS_AT, VS_SIZE = (960, 450), 300; SCORE_Y = 955; MAXW = 800
    PANEL_A = [(0, 0), (1030, 0), (870, H), (0, H)]; PANEL_B = [(1050, 0), (W, 0), (W, H), (890, H)]
P = {k: portrait(k, PH) for k in range(4)}
def panel(poly, colour, phase):
    im, d = sheet((W, H))
    base = tuple(int(INK[i] * 0.72 + colour[i] * 0.28) for i in range(3)); d.polygon(poly, fill=base + (255,))
    st, ds = sheet((W, H))
    for x in range(-H, W + H, 90): ds.polygon([(x + phase, 0), (x + 34 + phase, 0), (x + 34 - H * 0.3 + phase, H), (x - H * 0.3 + phase, H)], fill=colour + (26,))
    mask, dm = sheet((W, H), 'L', 0); dm.polygon(poly, fill=255); im.paste(st, (0, 0), Image.composite(st.split()[3], Image.new('L', im.size, 0), mask))
    return im
VS_IMG = words('VS', VS_SIZE, WHITE, INK, off=VS_SIZE // 16)
GO = plate('GAME ON', LIME, INK, 190 if not TALL else 112, pad=44 if not TALL else 30, skew=30)
GO_AT = VS_AT if not TALL else (VS_AT[0], VS_AT[1] + 22)      # vertical: it must not cover the name plates above it
T_A = fit_words(title_a.upper(), 104, MAXW, WHITE, INK); T_B = fit_words(title_b.upper(), 104, MAXW, WHITE, INK)
SC = plate(MT['score'].replace('   ', '  ·  '), INK, LIME, 84 if not TALL else 70, pad=40, skew=24)
META = words('  ·  '.join(x for x in (MT.get('venue'), MT['date']) if x).upper(), 34, (200, 205, 212))      # a match can have no venue
NAME = {k: plate(names[k].upper(), LIME if team[k] == 0 else BLUE, INK if team[k] == 0 else WHITE, 62) for k in range(4)}
# A match where nobody said who is who has the team's name for each player: the title says it once, so no plate under the portrait.
PLATE = {k: names[k].strip().lower() not in ('', str(MT.get('team_a', '')).lower(), str(MT.get('team_b', '')).lower()) for k in range(4)}

# when things happen (seconds)
T_IN = {A[0]: 0.30, A[1]: 0.52, B[0]: 2.70, B[1]: 2.92}; T_VS = 2.0; T_SCORE = 4.35; T_GO = 5.05
def frame(t):
    c = sheet((W, H), colour=INK + (255,))[0]
    ka = e_out((t - 0.15) / 0.35); kb = e_out((t - 2.55) / 0.35)
    shake = (0, 0)
    for t0, amp in ((T_VS, 16), (T_GO, 10)):
        if 0 <= t - t0 < 0.32: shake = (int(amp * np.sin((t - t0) * 95) * (1 - (t - t0) / 0.32)), int(amp * np.cos((t - t0) * 80) * (1 - (t - t0) / 0.32)))
    if ka > 0: put(c, panel(PANEL_A, LIME, int(t * 60) % 90), (-W * (1 - ka) if not TALL else 0) + shake[0], (0 if not TALL else -H * 0.5 * (1 - ka)) + shake[1])
    if kb > 0: put(c, panel(PANEL_B, BLUE, -int(t * 60) % 90), (W * (1 - kb) if not TALL else 0) + shake[0], (0 if not TALL else H * 0.5 * (1 - kb)) + shake[1])
    for k in A + B:
        x = e_back((t - T_IN[k]) / 0.36)
        if t < T_IN[k]: continue
        if P[k] is not None:
            img, (fx, fy) = P[k]; side = -1 if team[k] == 0 else 1
            px = SLOT[k][0] - fx + side * (1 - x) * 900 + shake[0]; py = SLOT[k][1] - PH + shake[1]
            put(c, tint(img, LIME if team[k] == 0 else BLUE), px + side * 18, py)            # a flat shadow in the team's colour
            put(c, img, px, py)
        n = e_back((t - T_IN[k] - 0.22) / 0.2)
        if t >= T_IN[k] + 0.22 and PLATE[k]:
            pl = NAME[k]; s = 1.6 - 0.6 * n; q = pl.resize((int(pl.width * s), int(pl.height * s)), Image.BILINEAR) if s != 1 else pl
            put(c, q, SLOT[k][0] - dw(q) / 2 + shake[0], SLOT[k][1] - 8 - (dh(q) - dh(pl)) / 2 + shake[1])
    for (x, y, al), img, t0 in ((TITLE_A, T_A, 0.75), (TITLE_B, T_B, 3.15)):
        k = e_out((t - t0) / 0.3)
        if k > 0:
            im2 = img.copy(); im2.putalpha(im2.split()[3].point(lambda v: int(v * k)))
            put(c, im2, (x if al == 'l' else x - dw(img)) + (-60 if al == 'l' else 60) * (1 - k), y)
    if t >= T_VS and t < T_GO + 0.1:
        k = min(1.0, (t - T_VS) / 0.16); s = 3.4 - 2.4 * k if k < 1 else 1 + 0.06 * np.exp(-(t - T_VS - 0.16) * 9) * np.cos((t - T_VS) * 30)
        v = VS_IMG.resize((int(VS_IMG.width * s), int(VS_IMG.height * s)), Image.BILINEAR)
        if t > T_GO: v.putalpha(v.split()[3].point(lambda a: int(a * max(0, 1 - (t - T_GO) / 0.1))))
        put(c, v, VS_AT[0] - dw(v) / 2 + shake[0], VS_AT[1] - dh(v) / 2 + shake[1])
    k = e_out((t - T_SCORE) / 0.3)
    if k > 0:
        s2 = SC.crop((0, 0, max(2, int(SC.width * k)), SC.height)); put(c, s2, W / 2 - dw(SC) / 2, SCORE_Y - dh(SC) / 2)
        m = META.copy(); m.putalpha(m.split()[3].point(lambda v: int(v * e_out((t - T_SCORE - 0.25) / 0.3)))); put(c, m, W / 2 - dw(META) / 2, SCORE_Y + dh(SC) / 2 + 10)
    if t >= T_GO:
        k = min(1.0, (t - T_GO) / 0.14); s = 2.6 - 1.6 * k
        g = GO.resize((int(GO.width * s), int(GO.height * s)), Image.BILINEAR); put(c, g, GO_AT[0] - dw(g) / 2 + shake[0], GO_AT[1] - dh(g) / 2 + shake[1])
    a = np.array(c.convert('RGB'))[:, :, ::-1].astype(np.float32)
    for t0, peak, d in ((T_VS, 0.85, 0.28), (T_GO, 0.6, 0.22), (DUR - 0.12, 1.0, 0.12)):          # white flashes; the last one is the cut to the first point
        if t0 <= t < t0 + d: a += (255 - a) * peak * ((1 - (t - t0) / d) if t0 < DUR - 0.2 else (t - t0) / d)
    return np.clip(a, 0, 255).astype(np.uint8)

if stills:
    cv2.imwrite(out, (np.hstack if TALL else np.vstack)([cv2.resize(frame(t), (px(W) // 2, px(H) // 2)) for t in stills]), [cv2.IMWRITE_JPEG_QUALITY, 88]); sys.exit(0)

# ---- the sound, made from numbers ----
SR = 48000; N = int(DUR * SR); rng = np.random.default_rng(5); mix = np.zeros(N)
from scipy.signal import butter, lfilter
def band(x, lo, hi):
    b, a = butter(2, [lo / (SR / 2), min(0.99, hi / (SR / 2))], btype='band'); return lfilter(b, a, x)
def add(sig, t, gain=1.0):
    i = int(t * SR); j = min(N, i + len(sig))
    if i < N: mix[i:j] += sig[:j - i] * gain
def whoosh(d=0.42, up=True):
    n = int(d * SR); x = rng.standard_normal(n); tt = np.linspace(0, 1, n); env = np.sin(np.pi * tt) ** 1.5
    lo, hi = band(x, 300, 1200), band(x, 1500, 6000); w = tt if up else 1 - tt
    return (lo * (1 - w) + hi * w) * env * 0.5
def thump(d=0.32, f0=130, f1=48):
    n = int(d * SR); tt = np.arange(n) / SR; f = f1 + (f0 - f1) * np.exp(-tt * 22); ph = 2 * np.pi * np.cumsum(f) / SR
    click = band(rng.standard_normal(n), 1200, 5000) * np.exp(-tt * 90) * 0.5
    return np.sin(ph) * np.exp(-tt * 11) + click
def boom(d=1.3):
    n = int(d * SR); tt = np.arange(n) / SR; f = 30 + 70 * np.exp(-tt * 9); ph = 2 * np.pi * np.cumsum(f) / SR
    low = np.tanh(2.2 * np.sin(ph) * np.exp(-tt * 3.2)); crash = band(rng.standard_normal(n), 2500, 11000) * np.exp(-tt * 4.5) * 0.35
    body = band(rng.standard_normal(n), 80, 700) * np.exp(-tt * 14) * 0.9
    return low + crash + body
def riser(d=0.45):
    n = int(d * SR); tt = np.linspace(0, 1, n); x = rng.standard_normal(n)
    return (band(x, 500, 2000) * (1 - tt) + band(x, 3000, 10000) * tt) * tt ** 2 * 0.6
def chord(d=0.9, notes=(110.0, 164.81, 220.0, 329.63)):
    n = int(d * SR); tt = np.arange(n) / SR; s = np.zeros(n)
    for f in notes:
        for h, g in ((1, 1.0), (2, 0.5), (3, 0.33), (4, 0.2), (5, 0.14)): s += g * np.sin(2 * np.pi * f * h * tt)   # a bright, saw-like tone
    return np.tanh(s * 0.35) * np.exp(-tt * 3.5) * 0.7
def kick():
    n = int(0.22 * SR); tt = np.arange(n) / SR; f = 45 + 90 * np.exp(-tt * 35); return np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-tt * 16)
add(whoosh(), 0.12, 0.8); add(whoosh(), 2.52, 0.8)
for k in A + B: add(thump(), T_IN[k] + 0.22, 0.9)
add(riser(), T_VS - 0.45, 0.8); add(boom(), T_VS, 1.0)
add(whoosh(0.3), T_SCORE - 0.05, 0.5); add(thump(0.25, 220, 90), T_SCORE + 0.28, 0.5)
add(boom(0.9), T_GO, 0.7); add(chord(), T_GO, 0.6)
for b in np.arange(0.30, T_GO - 0.1, 60 / 140):                      # a quiet pulse under it all, 140 beats a minute
    if abs(b - T_VS) > 0.25: add(kick(), b, 0.28)
# the announcer
lines = [(0.72, f"{' and '.join(names[k] for k in A) if not MT.get('team_a') else 'Team ' + MT['team_a']}!"), (T_VS - 0.02, 'Versus!'),
         (3.12, f"{' and '.join(names[k] for k in B) if not MT.get('team_b') else 'Team ' + MT['team_b']}!"), (T_GO - 0.02, 'Game on!')]
if MT.get('title_a'): lines[0] = (0.72, MT['title_a'].replace('&', 'and') + '!')
if MT.get('title_b'): lines[2] = (3.12, MT['title_b'].replace('&', 'and') + '!')
# The voice. First choice: Kokoro (Apache 2.0, commercial use permitted), voice VOICE_NAME. Second: the piper test voice
# (its data is for non-commercial use). Neither there, or VOICE=0: the opening has no speech.
def speak_kokoro(text, td):
    from kokoro_onnx import Kokoro
    import soundfile as sf
    global _kok
    try: _kok
    except NameError: _kok = Kokoro(f'{S}/models/kokoro/kokoro-v1.0.onnx', f'{S}/models/kokoro/voices-v1.0.bin')
    a, sr = _kok.create(text, voice=os.environ.get('VOICE_NAME', 'am_michael'), speed=0.92, lang='en-us'); sf.write(f'{td}/a.wav', a, sr); return int(sr * 0.97)
def speak_piper(text, td):
    subprocess.run([piper, '-m', voice, '-f', f'{td}/a.wav'], input=text.encode(), check=True, capture_output=True); return int(22050 * 0.92)
voice = f'{S}/models/voice/en_US-ryan-high.onnx'; piper = os.path.join(os.path.dirname(sys.executable), 'piper')
speak = None
VOICE_DIR = os.environ.get('VOICE_DIR')        # lines made before by another voice service: <dir>/<VOICE_PREFIX>-a.mp3, -vs, -b, -go
def speak_files(text, td):
    tag = {0: 'a', 1: 'vs', 2: 'b', 3: 'go'}[[t for _, t in lines].index(text)]
    subprocess.run(['ffmpeg', '-v', 'error', '-y', '-i', f"{VOICE_DIR}/{os.environ.get('VOICE_PREFIX', 'voice')}-{tag}.mp3", '-ar', '48000', f'{td}/a.wav'], check=True); return 48000
if os.environ.get('VOICE', '1') == '1' and VOICE_DIR: speak = speak_files
elif os.environ.get('VOICE', '1') == '1':
    if os.path.exists(f'{S}/models/kokoro/kokoro-v1.0.onnx') and os.environ.get('VOICE_ENGINE', 'kokoro') == 'kokoro': speak = speak_kokoro
    elif os.path.exists(voice) and os.path.exists(piper): speak = speak_piper
if speak:
    for t0, text in lines:
        with tempfile.TemporaryDirectory() as td:
            rate = speak(text, td)
            # a little slower and deeper, with a short hall behind it
            raw = subprocess.run(['ffmpeg', '-v', 'error', '-i', f'{td}/a.wav', '-af', f'asetrate={rate},aresample=48000,aecho=0.8:0.6:70|140:0.22|0.12,acompressor=threshold=-18dB:ratio=4:makeup=4',
                                  '-ac', '1', '-f', 'f32le', '-'], capture_output=True, check=True).stdout
            v = np.frombuffer(raw, np.float32).astype(np.float64); v = v / (np.abs(v).max() + 1e-9)
            add(v, t0, 0.95); print(f'voice {t0:.2f} s  {len(v) / SR:.2f} s  "{text}"')
mix = np.tanh(mix * 0.9); mix = mix / np.abs(mix).max() * 0.4                 # about -6 dB at the loudest moment: the court's own sound is quiet
mix[-int(0.05 * SR):] *= np.linspace(1, 0, int(0.05 * SR))
wav = out + '.f32'; np.stack([mix, mix], 1).astype(np.float32).tofile(wav)

enc = subprocess.Popen(['ffmpeg', '-v', 'error', '-nostdin', '-y', '-f', 'rawvideo', '-pix_fmt', 'bgr24', '-s', f'{px(W)}x{px(H)}', '-r', '30000/1001', '-i', '-',
                        '-f', 'f32le', '-ar', '48000', '-ac', '2', '-i', wav, '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '19', '-pix_fmt', 'yuv420p',
                        '-c:a', 'aac', '-b:a', '160k', '-ar', '48000', '-ac', '2', '-shortest', '-movflags', '+faststart', out], stdin=subprocess.PIPE)
n = int(round(DUR * FPS))
for i in range(n): enc.stdin.write(np.ascontiguousarray(frame(i / FPS)).tobytes())
enc.stdin.close(); enc.wait(); os.remove(wav); print('wrote', out, f'{n} frames')
