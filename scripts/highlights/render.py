"""Render one segment of the reel to an mp4 (H.264, AAC 48 kHz stereo, 1920x1080, 30000/1001 fps).

Segments (JSON, one per call):
  {"kind": "card", "image": "x.jpg", "dur": 3.5}
  {"kind": "clip", "t0", "t1", "track": "clip.json", "names": [...], "team": [...], "title", "sub", "tags_until": 4.0}
  {"kind": "replay", "t0", "t1", "track": "clip.json", "focus": id or null, "zoom": 2.2, "speed": 0.5, "title"}
usage: render.py <video> <segment.json> <out.mp4>
"""
import sys, os, json, subprocess, numpy as np, cv2
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import gfx
from people import read_frames

video, segf, out = sys.argv[1], sys.argv[2], sys.argv[3]
seg = json.load(open(segf))
FPS_N, FPS_D = 30000, 1001
FPS = FPS_N / FPS_D
W, H = 1920, 1080
# The vertical reel: the middle 1440 columns of the picture, 1080 wide, between a head and a foot of graphics.
TALL = os.environ.get('TALL') == '1'
OW, OH = (1080, 1920) if TALL else (W, H)
VY, VS, VX = 480, 0.75, 240
BASE = gfx.tall_base(seg.get('venue', ''), *seg.get('foot', ['', '', ''])) if TALL else None
def stage(fr, frame=False):
    """The picture on its stage: itself (wide), or cropped and set into the vertical frame."""
    if not TALL:
        if frame: cv2.rectangle(fr, (0, 0), (W - 1, H - 1), gfx.LIME[::-1], 10)
        return fr
    c = BASE.copy(); c[VY:VY + 810] = cv2.resize(fr[:, VX:VX + 1440], (1080, 810), interpolation=cv2.INTER_AREA)
    if frame: cv2.rectangle(c, (0, VY), (OW - 1, VY + 809), gfx.LIME[::-1], 8)
    return c
def pt(x, y): return (x, y) if not TALL else ((x - VX) * VS, y * VS + VY)
# where the standing graphics go
BUG = (48, 40) if not TALL else (40, 70)
BADGE_L = (48, 104) if not TALL else (40, 140)
LT = (48, 900) if not TALL else (40, 250)
def right(img, y=None): return (OW - img.shape[1] - (48 if not TALL else 40), (40 if not TALL else 70) if y is None else y)

def encoder(out, audio_args):
    """ffmpeg that takes raw BGR frames on stdin and the given audio input, and writes the mp4."""
    cmd = ['ffmpeg', '-v', 'error', '-nostdin', '-y', '-f', 'rawvideo', '-pix_fmt', 'bgr24', '-s', f'{OW}x{OH}', '-r', f'{FPS_N}/{FPS_D}', '-i', '-', *audio_args,
           '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '19', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '160k', '-ar', '48000', '-ac', '2', '-shortest', '-movflags', '+faststart', out]
    return subprocess.Popen(cmd, stdin=subprocess.PIPE)

def ease(x): x = min(1.0, max(0.0, x)); return x * x * (3 - 2 * x)

def track_at(tr, f):
    """Each player at frame f, interpolated: box (4) followed by the head point (2). Absent when not followed there."""
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

bugimg = gfx.bug(seg.get('venue', ''))
_cnt = {}
def draw_counter(fr, hits, t, last_extra=1.6):
    """The rally counter at the top right: it rises with each shot heard; after the last one it shows the total."""
    if not hits: return
    k = sum(1 for h in hits if h <= t)
    if k == 0 or t > hits[-1] + 4.0: return
    final = k == len(hits) and t > hits[-1] + 0.5
    pop = max(0.0, 1 - (t - hits[k - 1]) / 0.22) if not final else max(0.0, 1 - (t - hits[-1] - 0.5) / 0.3)
    key = (k, final, round(pop, 1))
    if key not in _cnt: _cnt[key] = gfx.counter(k, final, key[2])
    c = _cnt[key]; gfx.blit(fr, c, *right(c))

if seg['kind'] == 'card':
    img = cv2.imread(seg['image']); n = int(round(seg['dur'] * FPS))
    enc = encoder(out, ['-f', 'lavfi', '-t', f"{seg['dur']:.3f}", '-i', 'anullsrc=r=48000:cl=stereo'])
    black = np.zeros_like(img)
    for i in range(n):
        a = min(ease(i / 8), ease((n - 1 - i) / 8))
        enc.stdin.write(cv2.addWeighted(img, a, black, 1 - a, 0).tobytes() if a < 1 else img.tobytes())
    enc.stdin.close(); enc.wait()

elif seg['kind'] == 'clip':
    t0, t1 = seg['t0'], seg['t1']
    tr = json.load(open(seg['track'])) if seg.get('track') else None
    off = int(round((t0 - tr['t0']) * FPS)) if tr else 0
    tags = {i: gfx.name_tag(nm, seg['team'][i]) for i, nm in enumerate(seg.get('names', [])) if nm}
    lt = gfx.lower_third(seg['title'], seg.get('sub')) if seg.get('title') else None
    tag_until = seg.get('tags_until', 4.0)
    smooth = {}
    enc = encoder(out, ['-ss', f'{t0:.3f}', '-t', f'{t1 - t0:.3f}', '-i', video])
    n = 0
    for t, img in read_frames(video, t0, t1 - t0):
        fr = stage(img.copy()); s = n / FPS
        gfx.blit(fr, bugimg, *BUG)
        if tr and s < tag_until + 0.5:
            a = min(ease((s - 0.3) / 0.4), ease((tag_until + 0.5 - s) / 0.5))
            placed = []
            # the bigger (nearer) players first; a tag that would cover another moves up
            for k, b in sorted(track_at(tr, n + off).items(), key=lambda kb: -(kb[1][3] - kb[1][1])):
                if k not in tags or a <= 0: continue
                tx, ty = pt(b[4], b[5])
                if k in smooth: tx, ty = 0.6 * smooth[k][0] + 0.4 * tx, 0.6 * smooth[k][1] + 0.4 * ty
                smooth[k] = (tx, ty)
                tg = tags[k]; x, y = int(tx - tg.shape[1] / 2), int(ty - tg.shape[0] - 6)
                for _ in range(3):
                    if any(x < px + pw + 6 and px < x + tg.shape[1] + 6 and y < py + ph + 4 and py < y + tg.shape[0] + 4 for (px, py, pw, ph) in placed): y -= tg.shape[0] + 4
                placed.append((x, y, tg.shape[1], tg.shape[0]))
                gfx.blit(fr, tg, x, max(96 if not TALL else VY + 4, y), a)
        if lt is not None and s < 4.5:
            a = min(ease((s - 0.2) / 0.4), ease((4.5 - s) / 0.5))
            gfx.blit(fr, lt, int(LT[0] - 60 * (1 - ease((s - 0.2) / 0.4))), LT[1], a)
        draw_counter(fr, seg.get('hits'), t0 + s)
        enc.stdin.write(fr.tobytes()); n += 1
    enc.stdin.close(); enc.wait()

elif seg['kind'] == 'fast':
    # the long middle of a rally at several times the speed, with the counter racing
    t0, t1 = seg['t0'], seg['t1']; sp = seg.get('speed', 6)
    chain = []; r = float(sp)
    while r > 2.0: chain.append('atempo=2.0'); r /= 2.0
    chain.append(f'atempo={r:.4f}')
    enc = encoder(out, ['-ss', f'{t0:.3f}', '-t', f'{t1 - t0:.3f}', '-i', video, '-af', ','.join(chain) + ',volume=0.6'])
    ff = gfx.badge(f'x{sp}', gfx.INK, gfx.LIME, 44); lt = gfx.lower_third(seg['title'], seg.get('sub')) if seg.get('title') else None
    n = 0
    for t, img in read_frames(video, t0, t1 - t0, fps=FPS / sp):
        fr = stage(img.copy()); s = n / FPS
        gfx.blit(fr, bugimg, *BUG); gfx.blit(fr, ff, *BADGE_L)
        if lt is not None and s < 4.5:
            a = min(ease((s - 0.2) / 0.4), ease((4.5 - s) / 0.5)); gfx.blit(fr, lt, LT[0], LT[1], a)
        draw_counter(fr, seg.get('hits'), t)
        enc.stdin.write(fr.tobytes()); n += 1
    enc.stdin.close(); enc.wait()

elif seg['kind'] == 'replay':
    t0, t1 = seg['t0'], seg['t1']; speed = seg.get('speed', 0.5); zoom = seg.get('zoom', 2.0)
    tr = json.load(open(seg['track'])) if seg.get('track') else None
    off = int(round((t0 - tr['t0']) * FPS)) if tr else 0
    rb = gfx.badge('Replay'); lt = gfx.lower_third(seg['title'], seg.get('sub')) if seg.get('title') else None
    tag = gfx.name_tag(seg['focus_name'], seg.get('focus_team', 0)) if seg.get('focus_name') else None
    # the window follows the focus player (or the given point), smoothed
    cw, ch = W / zoom, H / zoom
    cx, cy = seg.get('cx', W / 2), seg.get('cy', H / 2)
    frames = list(read_frames(video, t0, t1 - t0))
    centres = []
    for n in range(len(frames)):
        b = track_at(tr, n + off).get(seg.get('focus')) if tr and seg.get('focus') is not None else None
        if b is not None: cx, cy = (b[0] + b[2]) / 2, (b[1] + b[3]) / 2 - 0.05 * (b[3] - b[1])
        centres.append((cx, cy))
    c = np.array(centres); k = 9
    c = np.stack([np.convolve(np.pad(c[:, j], k, mode='edge'), np.ones(2 * k + 1) / (2 * k + 1), mode='valid') for j in (0, 1)], 1)
    atempo = f'atempo={speed}' if speed >= 0.5 else f'atempo=0.5,atempo={speed / 0.5}'
    enc = encoder(out, ['-ss', f'{t0:.3f}', '-t', f'{t1 - t0:.3f}', '-i', video, '-af', f'{atempo},volume=0.45'])
    def view(img, cc):
        x0 = int(np.clip(cc[0] - cw / 2, 0, W - cw)); y0 = int(np.clip(cc[1] - ch / 2, 0, H - ch))
        return cv2.resize(img[y0:y0 + int(ch), x0:x0 + int(cw)], (W, H), interpolation=cv2.INTER_CUBIC), x0, y0
    steps = int(round(1 / speed)); total = len(frames) * steps; m = 0
    for n in range(len(frames)):
        for j in range(steps):
            w = j / steps
            a = frames[n][1]; b = frames[min(n + 1, len(frames) - 1)][1]
            img = a if w == 0 else cv2.addWeighted(a, 1 - w, b, w, 0)
            cc = (1 - w) * c[n] + w * c[min(n + 1, len(c) - 1)]
            fr, x0, y0 = view(img, cc)
            fr = stage(fr, frame=True)       # a thin lime frame marks the replay
            gfx.blit(fr, bugimg, *BUG); gfx.blit(fr, rb, *right(rb))
            if tag is not None and tr:
                bx = track_at(tr, n + off).get(seg.get('focus'))
                if bx is not None:
                    tx, ty = pt((bx[4] - x0) * zoom, (bx[5] - y0) * zoom)
                    gfx.blit(fr, tag, int(tx - tag.shape[1] / 2), int(max(60 if not TALL else VY + 4, ty - tag.shape[0] - 10)))
            if lt is not None:
                s = m / FPS; a2 = min(ease((s - 0.2) / 0.4), ease((total / FPS - s) / 0.5))
                gfx.blit(fr, lt, LT[0], LT[1], a2)
            enc.stdin.write(fr.tobytes()); m += 1
    enc.stdin.close(); enc.wait()
print('wrote', out)
