"""Render one segment of the reel to an mp4 (H.264, AAC 48 kHz stereo, 30000/1001 fps; 1920x1080, or 1080x1920 with TALL=1).

Segments (JSON, one per call):
  {"kind": "card", "image": "x.jpg", "dur": 3.5}       optional "hold_end": true: no fade to black at the end (the last card of a reel)
  {"kind": "clip", "t0", "t1", "track": "clip.json", "names": [...], "team": [...], "title", "sub", "tags_until": 4.0}
      optional "won": {"team": 0|1, "name": "Team X", "at": seconds of the video}: who won the point, and the moment the
          ball is dead (in the net, out, the second bounce). The line appears just after that moment, never before it.
      optional "notes": [{"t0", "t1", "who": player, "value", "unit", "label"}]: a measured number over that player's head
  {"kind": "replay", "t0", "t1", "track": "clip.json", "focus": id or null, "zoom": 2.2, "speed": 0.5, "title"}
usage: render.py <video> <segment.json> <out.mp4>
Environment: TALL=1 (the vertical reel). SCALE (K: the output is K times as large; 2 gives 3840x2160). HIRES (a folder
of 4K pieces of the match with their index.json: a segment that lies inside one piece takes its pictures from it, and
a replay at half speed then shows only real pictures). SRMIX and CACHE (replays). COUNTER=0 (a clip without the shot
counter). Each run prints one line that says where its pictures came from.
"""
import sys, os, json, subprocess, numpy as np, cv2
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import gfx
from people import read_frames
import hdr

video, segf, out = sys.argv[1], sys.argv[2], sys.argv[3]
seg = json.load(open(segf))
FPS_N, FPS_D = 30000, 1001
FPS = FPS_N / FPS_D
W, H = 1920, 1080
# The vertical reel: the middle 1440 columns of the picture, 1080 wide, between a head and a foot of graphics.
TALL = os.environ.get('TALL') == '1'
OW, OH = (1080, 1920) if TALL else (W, H)
VY, VS, VX = 480, 0.75, 240
# The scale. Every position and size in this file is a design number: it belongs to the 1920x1080 picture (the
# vertical reel: 1080x1920), and the boxes of a track file do too. SCALE=K makes the output K times as large. Only
# this block knows K: px() (a design number -> pixels of the output), fit() (a picture -> the size of the output
# picture), Art and put() (a graphic of gfx.py: drawn K times as large, measured and placed in design numbers), and
# stage(). The replay has one more number of this kind, the pixels of a 4K piece for one design unit.
K = gfx.reel_scale()
def px(v): return int(round(v * K))
PW, PH = px(W), px(H)                    # the picture of the match, in pixels of the output
def fit(img):
    """A picture at the size of the output picture."""
    h, w = img.shape[:2]
    return img if (w, h) == (PW, PH) else cv2.resize(img, (PW, PH), interpolation=cv2.INTER_CUBIC if PW > w else cv2.INTER_AREA)
class Art:
    """A graphic of gfx.py. `shape` is its design size: the layout below measures with it."""
    def __init__(self, img): self.img = img; self.shape = (img.shape[0] / K, img.shape[1] / K)
def put(fr, a, x, y, alpha=1.0):
    """Blend a graphic onto the frame, its top left corner at the design point (x, y)."""
    gfx.blit(fr, a.img, px(x), px(y), alpha)
BASE = gfx.tall_base(seg.get('venue', ''), *seg.get('foot', ['', '', ''])) if TALL else None
def stage(fr, frame=False):
    """The picture (PW x PH) on its stage: itself (wide), or cropped and set into the vertical frame."""
    if not TALL:
        if frame: cv2.rectangle(fr, (0, 0), (PW - 1, PH - 1), gfx.LIME[::-1], px(10))
        return fr
    c = BASE.copy(); c[px(VY):px(VY) + px(810)] = cv2.resize(fr[:, px(VX):px(VX) + px(1440)], (px(1080), px(810)), interpolation=cv2.INTER_AREA)
    if frame: cv2.rectangle(c, (0, px(VY)), (px(OW) - 1, px(VY) + px(810) - 1), gfx.LIME[::-1], px(8))
    return c
def pt(x, y): return (x, y) if not TALL else ((x - VX) * VS, y * VS + VY)
# where the standing graphics go
BUG = (48, 40) if not TALL else (40, 70)
BADGE_L = (48, 104) if not TALL else (40, 140)
LT = (48, 900) if not TALL else (40, 250)
def right(img, y=None): return (OW - img.shape[1] - (48 if not TALL else 40), (40 if not TALL else 70) if y is None else y)

X264 = ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '19', '-pix_fmt', 'yuv420p']      # one setting for every segment: build.py joins them with a stream copy
def encoder(out, audio_args):
    """ffmpeg that takes raw BGR frames on stdin and the given audio input, and writes the mp4."""
    cmd = ['ffmpeg', '-v', 'error', '-nostdin', '-y', '-f', 'rawvideo', '-pix_fmt', 'bgr24', '-s', f'{px(OW)}x{px(OH)}', '-r', f'{FPS_N}/{FPS_D}', '-i', '-', *audio_args,
           '-map', '0:v:0', '-map', '1:a:0', *X264, '-c:a', 'aac', '-b:a', '160k', '-ar', '48000', '-ac', '2', '-shortest', '-movflags', '+faststart', out]
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

HDR = hdr.kind(video) if seg['kind'] in ('clip', 'fast', 'replay') else None; SDRVF = hdr.vf(HDR) if HDR else None

# Where the pictures come from: the working video (1920x1080, 30 pictures a second), or a 4K piece of the same match.
# HIRES names the folder of the pieces. Its index.json says for each file at which second of the match its first
# picture is ("start"): the picture of the match time t is at the time t - start of the piece. A piece is used only
# when it holds the whole window of the segment. If none does, the working video is read as before and enlarged.
from types import SimpleNamespace
def probe(path):
    """-> (width, height, pictures a second, seconds) of the video in a file."""
    r = subprocess.run(['ffprobe', '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height,r_frame_rate,duration', '-of', 'json', path], capture_output=True, text=True)
    s = json.loads(r.stdout)['streams'][0]; a, b = s['r_frame_rate'].split('/')
    return s['width'], s['height'], float(a) / float(b), float(s.get('duration') or 0)
def source(t0, t1, rate=FPS):
    """The source of the pictures of [t0, t1] of the match, and one line that says which it is.
    rate: the pictures a second that the segment needs (a replay at half speed needs 60); a piece with fewer is not used."""
    d = os.environ.get('HIRES'); why = ''
    if d and os.path.exists(os.path.join(d, 'index.json')):
        why = ', no 4K piece holds this window'
        for name, e in sorted(json.load(open(os.path.join(d, 'index.json'))).items()):
            f = os.path.join(d, name)
            if not (e['start'] <= t0 and os.path.exists(f)): continue
            w, h, fps, dur = probe(f)
            if t1 > e['start'] + dur - 0.1: continue
            if fps < 0.99 * rate: why = f', the 4K piece {name} has {fps:.2f} pictures a second and the segment needs {rate:.2f}'; continue
            print(f'source: 4K piece {name} ({w}x{h}, {fps:.2f} pictures a second) for {t0:.2f}-{t1:.2f} -> {PW}x{PH}')
            return SimpleNamespace(hires=True, file=f, shift=e['start'], w=w, h=h, fps=fps, trc=hdr.kind(f))
    print(f'source: working video for {t0:.2f}-{t1:.2f} -> {PW}x{PH}' + (f' (enlarged {K} times)' if K != 1 else '') + why)
    return SimpleNamespace(hires=False, file=video, shift=0.0, w=W, h=H, fps=FPS, trc=HDR)
def pictures(src, t0, dur, fps=None):
    """The pictures of [t0, t0 + dur) of the match with their times, in normal colours (hdr.py) and at PW x PH."""
    if not src.hires:
        for t, img in read_frames(video, t0, dur, fps=fps, vf=SDRVF): yield t, fit(img)
        return
    # the size first, the colours after it: this is the order in which the working video itself was made
    vf = ([] if (src.w, src.h) == (PW, PH) else [f'scale={PW}:{PH}:flags=lanczos']) + ([hdr.vf(src.trc)] if src.trc else [])
    for t, img in read_frames(src.file, t0 - src.shift, dur, fps=fps or FPS, size=(PW, PH), vf=','.join(vf) or None): yield t + src.shift, img
def count(path):
    """How many pictures a video file has."""
    r = subprocess.run(['ffprobe', '-v', 'error', '-select_streams', 'v:0', '-count_packets', '-show_entries', 'stream=nb_read_packets', '-of', 'csv=p=0', path], capture_output=True, text=True)
    return int(r.stdout.strip().strip(','))

bugimg = Art(gfx.bug(seg.get('venue', '')))
COUNTER = os.environ.get('COUNTER') != '0'       # COUNTER=0: a clip without the shot counter (build.py then leaves "N shots" out of its sub-title)
_cnt = {}
def draw_counter(fr, hits, t, last_extra=1.6, calm=False):
    """The rally counter at the top right: it rises with each shot heard; after the last one it shows the total."""
    if not hits: return
    k = sum(1 for h in hits if h <= t)
    if k == 0 or t > hits[-1] + 4.0: return
    final = k == len(hits) and t > hits[-1] + 0.5
    pop = max(0.0, 1 - (t - hits[k - 1]) / 0.22) if not final else max(0.0, 1 - (t - hits[-1] - 0.5) / 0.3)
    if calm: final, pop = False, 0.0       # at six times the speed the number only counts: no jump at each shot
    key = (k, final, round(pop, 1))
    if key not in _cnt: _cnt[key] = Art(gfx.counter(k, final, key[2]))
    c = _cnt[key]; put(fr, c, *right(c))

_met = {}
def draw_meter(fr, m, t):
    """A measured number at the top right, where the counter was: {"label": "<NAME> BPM", "points": [[t, value], ...]}.
    The value at t is read off the line between the two nearest points. Only a number that was measured belongs here."""
    if not m or not m.get('points'): return
    v = int(round(float(np.interp(t, [q[0] for q in m['points']], [q[1] for q in m['points']]))))
    if v not in _met: _met[v] = Art(gfx.counter(v, False, 0.0, m.get('label', '')))
    c = _met[v]; put(fr, c, *right(c))

if seg['kind'] == 'card':
    print('source: the card', seg['image'])
    img = cv2.imread(seg['image']); n = int(round(seg['dur'] * FPS))
    if img.shape[:2] != (px(OH), px(OW)): img = cv2.resize(img, (px(OW), px(OH)), interpolation=cv2.INTER_CUBIC)      # a card that was made at another scale
    enc = encoder(out, ['-f', 'lavfi', '-t', f"{seg['dur']:.3f}", '-i', 'anullsrc=r=48000:cl=stereo'])
    black = np.zeros_like(img)
    for i in range(n):
        # the last card of a reel stays to its last picture: a reel that ends on black shows black where it stops
        a = ease(i / 8) if seg.get('hold_end') else min(ease(i / 8), ease((n - 1 - i) / 8))
        enc.stdin.write(cv2.addWeighted(img, a, black, 1 - a, 0).tobytes() if a < 1 else img.tobytes())
    enc.stdin.close(); enc.wait()

elif seg['kind'] == 'clip':
    t0, t1 = seg['t0'], seg['t1']
    tr = json.load(open(seg['track'])) if seg.get('track') else None
    off = int(round((t0 - tr['t0']) * FPS)) if tr else 0
    tags = {i: Art(gfx.name_tag(nm, seg['team'][i])) for i, nm in enumerate(seg.get('names', [])) if nm}
    lt = Art(gfx.lower_third(seg['title'], seg.get('sub'))) if seg.get('title') else None
    tag_until = seg.get('tags_until', 4.0)
    wb = None
    if seg.get('won'):
        # after the ball is dead, never before: the picture tells the end, the line only names it
        wn = seg['won']; wb = Art(gfx.lower_third(wn['name'], wn.get('what') or 'wins the point', gfx.LIME if wn['team'] == 0 else (120, 160, 255)))
        # 'at' is the moment the ball is dead. The line once came 1.4 s after the last HIT, and at most 1.8 s before the
        # end of the clip: it named the winner while a player was still running for the ball. reel_points.py now gives
        # the dead moment and makes the clip long enough after it.
        w_at = max(4.7, wn['at'] - t0 + 0.35)
    # "says": [{"t0", "t1" (seconds of the video), "who": player, "text"}]: a bubble over that player's head
    says = [dict(x, img=Art(gfx.speech(x['text'], seg['team'][x['who']]))) for x in seg.get('says', [])]; say_at = {}
    says += [dict(x, img=Art(gfx.stat_bubble(x['value'], x.get('unit', ''), x.get('label'), seg['team'][x['who']]))) for x in seg.get('notes', [])]
    smooth = {}
    src = source(t0, t1)
    # TALL_FOLLOW=1: the window of the vertical reel follows the players instead of standing in the middle. Each frame it
    # takes the middle of the leftmost and the rightmost player (both fit in 1440 of 1920 columns when they are not
    # too far apart), held where nobody is followed, smoothed over a second, and kept inside the picture.
    follow = None
    if TALL and tr and os.environ.get('TALL_FOLLOW') == '1':
        nf = int(np.ceil((t1 - t0) * FPS)) + 2; want = []; last = W / 2
        for q in range(nf):
            xs = [((b[0] + b[2]) / 2, b[3] - b[1]) for b in track_at(tr, q + off).values()]
            if xs:
                lo, hi = min(x for x, _ in xs), max(x for x, _ in xs)
                # far apart: the nearer (taller) players count more, they are the ones a viewer sees
                last = (lo + hi) / 2 if hi - lo <= 1240 else sum(x * h for x, h in xs) / sum(h for _, h in xs)
            want.append(last)
        k = int(FPS); w = np.convolve(np.pad(np.array(want), k, mode='edge'), np.ones(2 * k + 1) / (2 * k + 1), mode='valid')
        follow = np.clip(w - 720, 0, W - 1440)
        print(f'tall window follows the players: VX {follow.min():.0f}-{follow.max():.0f}')
    enc = encoder(out, ['-ss', f'{t0:.3f}', '-t', f'{t1 - t0:.3f}', '-i', video])
    n = 0
    for t, img in pictures(src, t0, t1 - t0):
        if follow is not None: VX = int(round(follow[min(n, len(follow) - 1)]))
        fr = stage(img.copy()); s = n / FPS
        put(fr, bugimg, *BUG)
        if tr and s < tag_until + 0.5:
            a = min(ease((s - 0.3) / 0.4), ease((tag_until + 0.5 - s) / 0.5))
            placed = []
            # the bigger (nearer) players first; a tag that would cover another moves up
            bigger = []
            for k, b in sorted(track_at(tr, n + off).items(), key=lambda kb: -(kb[1][3] - kb[1][1])):
                # a player who stands behind a nearer one gets no tag there: the tag would sit on the wrong back
                hid = any(b[3] - b[1] < 0.6 * (q[3] - q[1]) and q[0] - 0.5 * (q[2] - q[0]) < b[4] < q[2] + 0.5 * (q[2] - q[0]) and q[1] - 0.15 * (q[3] - q[1]) < b[5] < q[3] for q in bigger)
                bigger.append(b)
                if hid: smooth.pop(k, None); continue
                if k not in tags or a <= 0: continue
                tx, ty = pt(b[4], b[5])
                if k in smooth: tx, ty = 0.6 * smooth[k][0] + 0.4 * tx, 0.6 * smooth[k][1] + 0.4 * ty
                smooth[k] = (tx, ty)
                tg = tags[k]; x, y = int(tx - tg.shape[1] / 2), int(ty - tg.shape[0] - 6)
                # a tag stays whole inside the picture; a player outside the picture (the vertical crop) gets none
                if not 0 <= tx <= OW: continue
                x = min(max(x, 8), OW - tg.shape[1] - 8)
                for _ in range(3):
                    if any(x < px + pw + 6 and px < x + tg.shape[1] + 6 and y < py + ph + 4 and py < y + tg.shape[0] + 4 for (px, py, pw, ph) in placed): y -= tg.shape[0] + 4
                placed.append((x, y, tg.shape[1], tg.shape[0]))
                put(fr, tg, x, max(96 if not TALL else VY + 4, y), a)
        if lt is not None and s < 4.5:
            a = min(ease((s - 0.2) / 0.4), ease((4.5 - s) / 0.5))
            put(fr, lt, int(LT[0] - 60 * (1 - ease((s - 0.2) / 0.4))), LT[1], a)
        if wb is not None and s >= w_at:
            a = min(ease((s - w_at) / 0.35), ease((t1 - t0 - s) / 0.3))
            put(fr, wb, int(LT[0] - 60 * (1 - ease((s - w_at) / 0.35))), LT[1], a)
        for q in says:
            if not (q['t0'] <= t0 + s <= q['t1'] + 0.3) or not tr: continue
            b = track_at(tr, n + off).get(q['who'])
            if b is not None:
                tx, ty = pt(b[4], b[5]); old = say_at.get(id(q)); say_at[id(q)] = (tx, ty) if old is None else (0.8 * old[0] + 0.2 * tx, 0.8 * old[1] + 0.2 * ty)
            # a measured number belongs to one body: when the tracker does not have that player, it is not shown
            # (a bubble with a heart rate once stood over empty grass, and then over a player of the other pair)
            if id(q) not in say_at or (b is None and 'value' in q): continue
            tx, ty = say_at[id(q)]; im = q['img']; a = min(ease((t0 + s - q['t0']) / 0.25), ease((q['t1'] + 0.3 - t0 - s) / 0.3))
            x = int(min(max(tx - im.shape[1] / 2, 8), OW - im.shape[1] - 8)); y = int(max(96 if not TALL else VY + 4, ty - im.shape[0] - 28))
            if seg.get('score_box') and not TALL and y < 168 and x + im.shape[1] > OW - 48 - 440: y = 168      # the score box has that corner
            put(fr, im, x, y, a)
        if COUNTER: draw_counter(fr, seg.get('hits'), t0 + s)
        draw_meter(fr, seg.get('meter'), t0 + s)
        enc.stdin.write(fr.tobytes()); n += 1
    enc.stdin.close(); enc.wait()

elif seg['kind'] == 'fast':
    # the long middle of a rally at several times the speed, with the counter racing
    t0, t1 = seg['t0'], seg['t1']; sp = seg.get('speed', 6)
    chain = []; r = float(sp)
    while r > 2.0: chain.append('atempo=2.0'); r /= 2.0
    chain.append(f'atempo={r:.4f}')
    enc = encoder(out, ['-ss', f'{t0:.3f}', '-t', f'{t1 - t0:.3f}', '-i', video, '-af', ','.join(chain) + ',volume=0.6'])
    ff = Art(gfx.badge(f'x{sp}', gfx.INK, gfx.LIME, 44)); lt = Art(gfx.lower_third(seg['title'], seg.get('sub'))) if seg.get('title') else None
    n = 0
    for t, img in pictures(source(t0, t1), t0, t1 - t0, fps=FPS / sp):
        fr = stage(img.copy()); s = n / FPS
        put(fr, bugimg, *BUG); put(fr, ff, *BADGE_L)
        if lt is not None and s < 4.5:
            a = min(ease((s - 0.2) / 0.4), ease((4.5 - s) / 0.5)); put(fr, lt, LT[0], LT[1], a)
        draw_counter(fr, seg.get('hits'), t, calm=True)
        enc.stdin.write(fr.tobytes()); n += 1
    enc.stdin.close(); enc.wait()

elif seg['kind'] == 'file':
    # a part made elsewhere (the versus opening): taken as it is. versus.py makes it at the design size; at another
    # scale it is enlarged and encoded like every other segment, or the join of build.py would not hold.
    import shutil; part = seg['path_tall'] if TALL else seg['path']
    if K == 1 or probe(part)[:2] == (px(OW), px(OH)): print('source: the file', part); shutil.copyfile(part, out)
    else:
        print(f'source: the file {part}, enlarged {K} times')
        subprocess.run(['ffmpeg', '-v', 'error', '-nostdin', '-y', '-i', part, '-vf', f'scale={px(OW)}:{px(OH)}:flags=lanczos', '-r', f'{FPS_N}/{FPS_D}', *X264, '-c:a', 'copy', '-movflags', '+faststart', out], check=True)

elif seg['kind'] == 'replay':
    t0, t1 = seg['t0'], seg['t1']; speed = seg.get('speed', 0.5); zoom = seg.get('zoom', 2.0)
    tr = json.load(open(seg['track'])) if seg.get('track') else None
    off = int(round((t0 - tr['t0']) * FPS)) if tr else 0
    # 'badge': null in the segment = no badge (a close look at a reaction is not a replay of a shot)
    rb = Art(gfx.badge(seg.get('badge', 'Replay'))) if seg.get('badge', 'Replay') else None; lt = Art(gfx.lower_third(seg['title'], seg.get('sub'))) if seg.get('title') else None
    tag = Art(gfx.name_tag(seg['focus_name'], seg.get('focus_team', 0))) if seg.get('focus_name') else None
    steps = int(round(1 / speed))
    # True slow motion: a 4K piece has 60 pictures a second, so at half speed every picture of the replay is a real one.
    # A piece with too few pictures for the speed is not used; then the working video and the interpolation do it as before.
    src = source(t0, t1, FPS * steps)
    # the window follows the focus player (or the given point), smoothed
    cw, ch = int(W / zoom) // 2 * 2, int(H / zoom) // 2 * 2
    cx, cy = seg.get('cx', W / 2), seg.get('cy', H / 2)
    frames = [] if src.hires else list(read_frames(video, t0, t1 - t0))
    centres = []; first = None
    for n in range(int(np.ceil((t1 - t0) * FPS)) if src.hires else len(frames)):
        b = track_at(tr, n + off).get(seg.get('focus')) if tr and seg.get('focus') is not None else None
        if b is not None:
            cx, cy = (b[0] + b[2]) / 2, (b[1] + b[3]) / 2 - 0.05 * (b[3] - b[1])
            if first is None: first = n
        centres.append((cx, cy))
    # Before the tracker has the player, the window waits where the player will be found, not at the middle of the
    # picture: a replay once opened on two seconds of empty grass, because the track began late.
    if first: centres[:first] = [centres[first]] * first
    c = np.array(centres); k = 9
    c = np.stack([np.convolve(np.pad(c[:, j], k, mode='edge'), np.ones(2 * k + 1) / (2 * k + 1), mode='valid') for j in (0, 1)], 1)
    def origin(cc, r=1):
        """The top left corner of the window around a centre. r: the pixels of the source for one design unit."""
        return int(np.clip((cc[0] - cw / 2) * r, 0, (W - cw) * r)), int(np.clip((cc[1] - ch / 2) * r, 0, (H - ch) * r))
    def centre(nf):
        """The centre of the window at the (broken) frame number nf of the working video."""
        n = min(int(nf), len(c) - 1); wgt = nf - n
        return (1 - wgt) * c[n] + wgt * c[min(n + 1, len(c) - 1)]
    # 1. the zoomed pictures of the real frames. The upscale model makes cloth, lines and rackets crisper; it is mixed
    #    in at half strength and kept off the heads, where it paints over what little of a face the camera recorded.
    #    At a scale above 1 the model is off unless SRMIX asks for it: it is far too slow there on a processor.
    SRMIX = float(os.environ.get('SRMIX') or ('0.5' if K == 1 else '0'))
    import hashlib
    cdir = os.environ.get('CACHE') or os.path.join(os.path.dirname(os.path.abspath(out)), 'cache'); os.makedirs(cdir, exist_ok=True)
    key = [t0, t1, zoom, seg.get('focus'), seg.get('cx'), seg.get('cy'), speed, SRMIX] + ([first] if first else [])
    # An entry of the cache belongs to one scale and one source: an entry of a 1080p render is never taken for a 4K
    # render. (The plain entry, scale 1 from the working video, keeps the key that it always had.)
    if K != 1 or src.hires: key += [f'scale {K}', 'piece ' + os.path.basename(src.file) if src.hires else 'working video']
    cfile = os.path.join(cdir, 'replay-' + hashlib.md5(json.dumps(key).encode()).hexdigest()[:12] + '.mkv')
    CACHE_X264 = ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '8', '-pix_fmt', 'yuv444p']
    views = []
    if src.hires:
        # The real pictures, each one cut from the 4K picture where the window is at its own moment. They arrive in
        # normal colours, nothing is invented, and the upscale model has nothing to add. One picture at a time goes
        # through memory (a 4K picture is 25 MB): into the cache, and then from the cache onto the stage.
        if not os.path.exists(cfile):
            r = src.w / W; cws, chs = int(round(cw * r)), int(round(ch * r))
            # ffmpeg hands over only the part of the picture that the window ever touches (and 4 pixels around it,
            # for the colour samples at its edge): less to convert
            xs, ys = zip(*(origin(cc, r) for cc in c)); ux, uy = max(0, min(xs) - 4) // 2 * 2, max(0, min(ys) - 4) // 2 * 2
            uw, uh = min(src.w - ux, (max(xs) + cws - ux + 5) // 2 * 2), min(src.h - uy, (max(ys) + chs - uy + 5) // 2 * 2)
            # setpts: each picture of the piece exactly once (a phone does not keep the time between two pictures exactly even)
            vf = ','.join([f'crop={uw}:{uh}:{ux}:{uy}'] + ([hdr.vf(src.trc)] if src.trc else []) + ['setpts=N/FRAME_RATE/TB'])
            wr = subprocess.Popen(['ffmpeg', '-v', 'error', '-nostdin', '-y', '-f', 'rawvideo', '-pix_fmt', 'bgr24', '-s', f'{PW}x{PH}', '-r', f'{FPS_N}/{FPS_D}', '-i', '-', *CACHE_X264, '-f', 'matroska', cfile + '.part'], stdin=subprocess.PIPE)
            for m, (t, img) in enumerate(read_frames(src.file, t0 - src.shift, t1 - t0, size=(uw, uh), vf=vf)):
                x0, y0 = origin(centre(m / steps), r)
                wr.stdin.write(cv2.resize(img[y0 - uy:y0 - uy + chs, x0 - ux:x0 - ux + cws], (PW, PH), interpolation=cv2.INTER_CUBIC if PW > cws else cv2.INTER_AREA).tobytes())
            wr.stdin.close(); wr.wait(); os.replace(cfile + '.part', cfile)
        total = count(cfile); slow = (img for t, img in read_frames(cfile, 0, 36000, size=(PW, PH)))
    elif os.path.exists(cfile):
        raw = subprocess.run(['ffmpeg', '-v', 'error', '-nostdin', '-i', cfile, '-f', 'rawvideo', '-pix_fmt', 'bgr24', '-'], capture_output=True).stdout
        slow = np.frombuffer(raw, np.uint8).reshape(-1, H, W, 3); frames = []
    elif SRMIX > 0: import sr
    for n, (t, img) in enumerate(frames):
        x0, y0 = origin(c[n]); crop = np.ascontiguousarray(img[y0:y0 + ch, x0:x0 + cw])
        v = cv2.resize(crop, (W, H), interpolation=cv2.INTER_CUBIC)
        if SRMIX > 0:
            u = cv2.resize(sr.up4(crop), (W, H), interpolation=cv2.INTER_AREA)
            w = np.full((H, W), SRMIX, np.float32)
            for bx in (track_at(tr, n + off).values() if tr else []):
                hx, hy = (bx[4] - x0) * W / cw, (bx[5] + 0.11 * (bx[3] - bx[1]) - y0) * H / ch; r = max(14.0, 0.11 * (bx[3] - bx[1]) * W / cw)
                cv2.circle(w, (int(hx), int(hy)), int(r * 1.5), 0.0, -1)
            w = cv2.GaussianBlur(w, (0, 0), 12)[:, :, None]
            v = (v * (1 - w) + u * w).astype(np.uint8)
        views.append(v)
    # 2. new frames between the real ones (ffmpeg's motion interpolation): at half speed every second picture is new
    if views: mi = subprocess.run(['ffmpeg', '-v', 'error', '-nostdin', '-f', 'rawvideo', '-pix_fmt', 'bgr24', '-s', f'{W}x{H}', '-r', f'{FPS_N}/{FPS_D}', '-i', '-',
                         '-vf', f'minterpolate=fps={FPS_N * steps}/{FPS_D}:mi_mode=mci:mc_mode=aobmc:me_mode=bidir:vsbmc=1', '-f', 'rawvideo', '-pix_fmt', 'bgr24', '-'],
                        input=b''.join(v.tobytes() for v in views), capture_output=True)
    if views:
        slow = np.frombuffer(mi.stdout, np.uint8).reshape(-1, H, W, 3)
        subprocess.run(['ffmpeg', '-v', 'error', '-nostdin', '-y', '-f', 'rawvideo', '-pix_fmt', 'bgr24', '-s', f'{W}x{H}', '-r', f'{FPS_N}/{FPS_D}', '-i', '-', *CACHE_X264, cfile], input=slow.tobytes())
    atempo = f'atempo={speed}' if speed >= 0.5 else f'atempo=0.5,atempo={speed / 0.5}'
    enc = encoder(out, ['-ss', f'{t0:.3f}', '-t', f'{t1 - t0:.3f}', '-i', video, '-af', f'{atempo},volume=0.45'])
    if not src.hires:
        if HDR: slow = hdr.sdr(np.ascontiguousarray(np.array(slow)), HDR)      # the cache holds the frames as read; the colours are made right here
        total = len(slow)
    r = src.w / W if src.hires else 1
    for m, pic in enumerate(slow):
        nf = m / steps; x0, y0 = (v / r for v in origin(centre(nf), r))
        fr = stage(fit(pic).copy(), frame=True)       # a thin lime frame marks the replay
        put(fr, bugimg, *BUG)
        if rb: put(fr, rb, *(BADGE_L if seg.get('badge_left') else right(rb)))      # "badge_left": the top right corner is kept free (scorebox.py)
        if tag is not None and tr:
            bx = track_at(tr, nf + off).get(seg.get('focus'))
            if bx is not None:
                tx, ty = pt((bx[4] - x0) * W / cw, (bx[5] - y0) * H / ch)
                top = 60 if not TALL else VY + 4
                if seg.get('badge_left') and not TALL and tx + tag.shape[1] / 2 > OW - 48 - 440: top = 168      # the score box has that corner: the tag stays under it
                put(fr, tag, int(tx - tag.shape[1] / 2), int(max(top, ty - tag.shape[0] - 10)))
        if lt is not None:
            s = m / FPS; a2 = min(ease((s - 0.2) / 0.4), ease((total / FPS - s) / 0.5))
            put(fr, lt, LT[0], LT[1], a2)
        enc.stdin.write(fr.tobytes())
    enc.stdin.close(); enc.wait()
print('wrote', out)
