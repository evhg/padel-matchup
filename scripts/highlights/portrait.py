"""The portrait of each player for the opening (versus.py): a flattering face, not only the largest one.

usage: portrait.py <match dir> <clean 4K video> <out.json> <ident.json> [<ident.json> ...]

In:  <match dir>/kf/ and kf_times.txt (the frames at 3 a second and their times), feat2.npz (the pose of each
     sighting), dets.jsonl (every person of each frame), the ident files (the player of each near sighting; the
     ids are the keys of the output). The clean 4K video has the clock of kf_times.txt (fastreel.py `join_clean`).
Out: <out.json>: {"<player>": [{"f", "t", "face", "sharp", "eyes", "hi": {"file", "face", "t"}, "score", "why"}, ...]},
     best first. "hi" is the 4K frame of the chosen moment, a file beside <out.json>, and the face in it: versus.py
     cuts the portrait from that frame. PORTRAIT_SHEET=<file.jpg>: a sheet of the best faces of each player, with
     their scores and their three weakest tests, to look at. PORTRAIT_FALLBACK=<faces-chosen.json of who.py>: the
     choice for a player who has no face here. PORTRAIT_DEBUG=<file.json>: the scores of both passes.

The old rule (faces.py, then versus.py) took the largest sharp face that looks to the camera. A large face is a
player near the camera, and a player near the camera is often in a stroke: the opening of 24 November 2026 showed a
racket across a face, in motion blur, from below. This rule looks at every near sighting of a player, in all clips:
1. The pose at 3 a second (no picture read): the person upright, the hands down and away from the face, nobody in
   front of the face, slow (between points, not in a stroke), and room around the head for the cut-out.
2. The face (YuNet, its five points) in the same frame: frontal or three-quarter, the head level, not from below.
3. The best moments of each player (at least a second apart) again in the 4K file, every second frame of 0.4 s
   around each: sharp and without motion blur, the eyes open, the mouth closed or smiling, good light, nothing
   over the face (the share of skin), and the face like the player's other faces (SFace, as gallery.py).
Each test is a factor from 0 to 1, so a frame that fails one test badly loses, and no test is a hard limit: every
match gets a portrait. The best frame of the 4K pass is the portrait.
"""
import sys, os, json, time, subprocess, threading, numpy as np, cv2
from fractions import Fraction
from concurrent.futures import ThreadPoolExecutor

S = os.environ.get('HL_HOME') or os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MOMENTS = 8          # moments of each player that go to the 4K pass
APART = 1.0          # seconds between two moments of one player
HALF = 0.2           # seconds before and after a moment in the 4K pass
XS, YS = [0, 4, 6, 8, 10, 12], [1, 5, 7, 9, 11, 13]      # the x and the y values of a YuNet row (2 and 3 are its size)
_local = threading.local()


def models():
    """A face detector and a face recogniser for this thread (an OpenCV model is not safe in two threads)."""
    if not hasattr(_local, 'det'):
        _local.det = cv2.FaceDetectorYN.create(f'{S}/models/yunet.onnx', '', (320, 320), 0.5, 0.3, 50)
        _local.rec = cv2.FaceRecognizerSF.create(f'{S}/models/sface/face_recognition_sface_2021dec.onnx', '')
    return _local.det, _local.rec


def bell(v, ok, soft):
    """1 while |v| <= ok, then down like a bell: 0.37 at ok + soft."""
    return float(np.exp(-(max(0.0, abs(v) - ok) / soft) ** 2))


def geometry(f):
    """The pose of a face from YuNet's five points (right eye, left eye, nose, right and left mouth corner).
    -> yaw (the nose beside the middle of the eyes, in eye distances), roll (degrees), pitch (where the nose is
    between the eyes and the mouth: about 0.55 for a level head; lower when the face is seen from below)."""
    re, le, no, rm, lm = (np.array(f[i:i + 2], np.float64) for i in (4, 6, 8, 10, 12))
    em, mm = (re + le) / 2, (rm + lm) / 2; ed = float(np.linalg.norm(le - re)) + 1e-6
    yaw = float(no[0] - em[0]) / ed
    roll = float(np.degrees(np.arctan2(le[1] - re[1], le[0] - re[0])))
    pitch = float(no[1] - em[1]) / max(1e-6, float(mm[1] - em[1]))
    return yaw, roll, pitch, ed


def face_score(f):
    """The pose factors of one face."""
    yaw, roll, pitch, _ = geometry(f)
    return {'yaw': bell(yaw, 0.18, 0.22), 'roll': bell(roll, 10, 12), 'pitch': bell(pitch - 0.55, 0.12, 0.15), 'det': float(min(1.0, f[14] / 0.9))}


def pose_score(kp, box, others, fw, face, W, H, speed):
    """The factors of the pose at 3 a second. kp: 17 points (x, y, score) in frame pixels; face: x, y, w, h."""
    fx, fy, fwd, fh = face; cx, cy = fx + fwd / 2, fy + fh / 2; r = max(fwd, fh)
    out = {}
    # the hands: a wrist near the face, or over the shoulders, is a stroke, a racket over the face or a hand in the hair
    sh_y = min(kp[5, 1], kp[6, 1]) if min(kp[5, 2], kp[6, 2]) > 0.3 else cy + 1.5 * r
    hand = 1.0
    for w in (9, 10):
        if kp[w, 2] < 0.3: continue
        d = float(np.hypot(kp[w, 0] - cx, kp[w, 1] - cy)) / r
        hand *= min(1.0, max(0.05, (d - 1.0) / 2.0))
        if kp[w, 1] < sh_y: hand *= 0.3
    out['hands'] = hand
    # upright: the line from the middle of the hips to the middle of the shoulders, against the vertical
    if min(kp[5, 2], kp[6, 2], kp[11, 2], kp[12, 2]) > 0.3:
        s, h = (kp[5, :2] + kp[6, :2]) / 2, (kp[11, :2] + kp[12, :2]) / 2
        out['upright'] = bell(np.degrees(np.arctan2(abs(s[0] - h[0]), max(1e-6, h[1] - s[1]))), 12, 15)
    else: out['upright'] = 1.0
    # another person over the face: in front (feet lower in the picture) is the worst; behind only crowds the cut-out
    g = (fx - 0.3 * fwd, fy - 0.3 * fh, fx + 1.3 * fwd, fy + 1.3 * fh); ga = (g[2] - g[0]) * (g[3] - g[1]); clear = 1.0
    for d in others:
        ix = max(0.0, min(g[2], d[2]) - max(g[0], d[0])) * max(0.0, min(g[3], d[3]) - max(g[1], d[1]))
        if ix / ga > 0.08: clear = min(clear, 0.1 if d[3] > box[3] - 0.05 * (box[3] - box[1]) else 0.7)
    out['clear'] = clear
    # room: versus.py cuts 2.1 face sizes to each side, 1.1 above and to the chest below
    hx = (min(W, cx + 2.1 * r) - max(0, cx - 2.1 * r)) / (4.2 * r); vy = (min(H, fy + 2.6 * r) - max(0, fy - 1.1 * r)) / (3.7 * r)
    out['room'] = float(min(1.0, hx / 0.97) ** 3 * min(1.0, vy / 0.97) ** 3)
    # between points, not in a stroke: the speed of the box, in body heights a second
    out['still'] = 1.0 / (1.0 + (speed / 0.8) ** 2) if speed is not None else 0.8
    return out


def looks(img, f):
    """The factors of the picture of one face (a frame at 4K). f: YuNet's row in the coordinates of img."""
    x, y, w, h = (float(v) for v in f[:4]); yaw, roll, pitch, ed = geometry(f)
    g = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    # the inner face: no hair, no background
    ix0, iy0, ix1, iy1 = int(x + 0.18 * w), int(y + 0.22 * h), int(x + 0.82 * w), int(y + 0.92 * h)
    inner = img[max(0, iy0):iy1, max(0, ix0):ix1]
    if min(inner.shape[:2]) < 12: return None
    gi = cv2.cvtColor(inner, cv2.COLOR_BGR2GRAY)
    # sharp, at one size for every face (a small face is not sharper for having fewer pixels)
    gn = cv2.resize(gi, (96, int(96 * gi.shape[0] / gi.shape[1])), interpolation=cv2.INTER_AREA).astype(np.float32)
    sharp = float(cv2.Laplacian(gn, cv2.CV_32F).var())
    # motion blur takes the edges of one direction only: the two strengths of the structure tensor
    gx, gy = cv2.Sobel(gn, cv2.CV_32F, 1, 0), cv2.Sobel(gn, cv2.CV_32F, 0, 1)
    a, b, c = float((gx * gx).mean()), float((gy * gy).mean()), float((gx * gy).mean())
    tr, det = a + b, a * b - c * c; l1 = tr / 2 + np.sqrt(max(0.0, tr * tr / 4 - det)); l2 = tr - l1
    aniso = float(l2 / max(1e-6, l1))
    ref = float(np.median(gi)) + 1e-6
    def dark(cx, cy, hw, hh, k):
        p = g[int(max(0, cy - hh)):int(cy + hh), int(max(0, cx - hw)):int(cx + hw)]
        return float((p < k * ref).mean()) if p.size else 0.0
    # open eyes have a dark iris in a light eye; a closed eye is skin with a line of lashes
    eyes = (dark(f[4], f[5], 0.22 * ed, 0.12 * ed, 0.55) + dark(f[6], f[7], 0.22 * ed, 0.12 * ed, 0.55)) / 2
    mw = float(np.hypot(f[12] - f[10], f[13] - f[11]))
    mouth = dark((f[10] + f[12]) / 2, (f[11] + f[13]) / 2, 0.3 * mw, 0.16 * mw, 0.6)        # an open mouth is dark between the lips
    smile = mw / max(1e-6, ed)
    # the light: not dark, not burnt, not half in shadow
    L = float(gi.mean()); burnt = float((gi > 245).mean())
    half = abs(float(gi[:, :gi.shape[1] // 2].mean()) - float(gi[:, gi.shape[1] // 2:].mean())) / max(1.0, L)
    # skin: a racket, a hand or a net post over the face is not skin
    ycc = cv2.cvtColor(inner, cv2.COLOR_BGR2YCrCb)
    skin = float(((ycc[:, :, 1] >= 133) & (ycc[:, :, 1] <= 178) & (ycc[:, :, 2] >= 77) & (ycc[:, :, 2] <= 135)).mean())
    return {'sharp': sharp, 'aniso': aniso, 'eyes_dark': eyes, 'mouth_dark': mouth, 'smile': smile, 'light': L, 'burnt': burnt, 'half': half, 'skin': skin,
            'w': w, 'yaw': yaw, 'roll': roll, 'pitch': pitch}


def look_factors(m, top):
    """The factors of looks(): each 0..1, 1 is good. top: the player's highest sharpness and eye darkness of all
    moments (a face's own light and skin set both numbers, so a player is measured against the player)."""
    return {'sharp': min(1.0, m['sharp'] / (0.8 * top['sharp'] + 1e-6)) ** 0.7, 'blur': min(1.0, m['aniso'] / 0.35) ** 0.8,
            'eyes': 0.5 + 0.5 * min(1.0, m['eyes_dark'] / (0.5 * top['eyes_dark'] + 1e-6)), 'mouth': 1.0 - min(0.5, max(0.0, m['mouth_dark'] - 0.15) / 0.6),
            'smile': 0.85 + 0.15 * min(1.0, max(0.0, (m['smile'] - 0.78) / 0.15)),
            'light': bell(m['light'] - 135, 45, 40) * (1 - min(0.8, 3 * m['burnt'])) * bell(m['half'], 0.2, 0.25),
            'size': min(1.0, m['w'] / 140) ** 0.8, 'skin': min(1.0, m['skin'] / 0.45) ** 1.5}


def detect_near(det, img, cx, cy, w, scale=1.0):
    """The face near (cx, cy) of about width w in img. -> YuNet's row in img's coordinates, or None."""
    R = 3 * w; x0, y0 = int(max(0, cx - R)), int(max(0, cy - R)); cr = img[y0:int(cy + R), x0:int(cx + R)]
    if min(cr.shape[:2]) < 40: return None
    k = 1.0
    if max(cr.shape[:2]) > 640: k = 640 / max(cr.shape[:2]); cr = cv2.resize(cr, None, fx=k, fy=k, interpolation=cv2.INTER_AREA)
    det.setInputSize((cr.shape[1], cr.shape[0])); r = det.detect(cr)[1]
    if r is None: return None
    best = None
    for f in r:
        f = f.copy(); f[:14] /= k; f[XS] += x0; f[YS] += y0
        d = float(np.hypot(f[0] + f[2] / 2 - cx, f[1] + f[3] / 2 - cy)) / w
        if 0.6 <= f[2] / w <= 1.6 and d <= 1.2 and (best is None or d < best[0]): best = (d, f)
    return None if best is None else best[1]


def main():
    M, video, outf = sys.argv[1:4]; idents = sys.argv[4:]
    a0 = time.time()
    T = np.array([float(x) for x in open(f'{M}/kf_times.txt')])
    z = np.load(f'{M}/feat2.npz'); zbox, zkp, zfr, znames = z['box'], z['kp'], z['frame'], z['names']
    key = {(str(znames[zfr[i]]), tuple(np.round(zbox[i][:4], 1))): i for i in range(len(zbox))}
    dets = {}
    for l in open(f'{M}/dets.jsonl'):
        if l.strip(): r = json.loads(l); dets[r['f']] = r['d']
    seen = {}
    for p in idents:
        for s in json.load(open(p))['sightings']:
            if s['id'] < 0 or s['zone'] != 'near': continue
            seen[(s['id'], s['f'])] = s
    players = sorted({k for k, _ in seen})
    det, _ = models()
    # 1. every near sighting: the pose, then the face in the frame at 3 a second
    cand = {k: [] for k in players}; frames = {}
    for (k, fname), s in sorted(seen.items(), key=lambda kv: kv[0][1]):
        i = key.get((fname, tuple(np.round(np.array(s['box'][:4], np.float32), 1))))
        if i is None: continue
        kp = zkp[i]
        if kp[:3, 2].min() < 0.4: continue                     # the nose and both eyes: the face is to the camera
        hx, hy = kp[:5, 0][kp[:5, 2] > 0.3].mean(), kp[:5, 1][kp[:5, 2] > 0.3].mean()
        ear = max(abs(kp[3, 0] - kp[4, 0]), 1.6 * abs(kp[1, 0] - kp[2, 0]))
        if ear < 22: continue                                   # too few pixels for a portrait, even at 4K
        if fname not in frames: frames = {fname: cv2.imread(f'{M}/kf/{fname}')}
        im = frames[fname]
        if im is None: continue
        f = detect_near(det, im, hx, hy, ear)
        if f is None or f[14] < 0.7: continue
        n = int(fname[:6]); v = []
        for d in (-1, 1):
            o = seen.get((k, f'{n + d:06d}.jpg'))
            if o and 0 < n + d <= len(T):
                c0 = np.array([(s['box'][0] + s['box'][2]) / 2, (s['box'][1] + s['box'][3]) / 2]); c1 = np.array([(o['box'][0] + o['box'][2]) / 2, (o['box'][1] + o['box'][3]) / 2])
                v.append(float(np.linalg.norm(c1 - c0)) / max(1.0, s['box'][3] - s['box'][1]) / max(0.05, abs(T[n + d - 1] - T[n - 1])))
        others = [d for d in dets.get(fname, []) if d[4] >= 0.3 and iou(d, s['box']) < 0.6]
        face = [float(x) for x in f[:4]]
        P = pose_score(kp, s['box'], others, f[2], face, im.shape[1], im.shape[0], float(np.mean(v)) if v else None)
        P.update(face_score(f))
        P['size'] = min(1.0, f[2] / 75) ** 0.8
        cand[k].append({'f': fname, 't': float(T[n - 1]), 'box': s['box'], 'face': face, 'why1': P, 's1': float(np.prod(list(P.values())))})
    a1 = time.time()
    print('faces at 3 a second', {k: len(v) for k, v in cand.items()}, f'{a1 - a0:.0f} s', flush=True)
    if os.environ.get('PORTRAIT_DEBUG'): json.dump(cand, open(os.environ['PORTRAIT_DEBUG'], 'w'), default=float)
    # 2. the best moments, at least APART seconds from each other
    jobs = []
    for k in players:
        took = []
        for c in sorted(cand[k], key=lambda c: -c['s1']):
            if len(took) >= MOMENTS: break
            if all(abs(c['t'] - o['t']) >= APART for o in took): took.append(c)
        jobs += [(k, c) for c in took]
    # 3. each moment again in the 4K file
    info = subprocess.run(['ffprobe', '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height,r_frame_rate', '-of', 'json', video], capture_output=True, text=True).stdout
    st = json.loads(info)['streams'][0]; VW, VH = st['width'], st['height']; fps = float(Fraction(st['r_frame_rate']))
    step = 2 if fps > 40 else 1
    def window(job):
        k, c = job; det, rec = models()
        m = VW / 1920.0; fx, fy, fw, fh = (v * m for v in c['face']); cx, cy = fx + fw / 2, fy + fh / 2
        t0 = max(0.0, c['t'] - HALF)
        p = subprocess.Popen(['ffmpeg', '-v', 'error', '-nostdin', '-ss', f'{t0:.3f}', '-i', video, '-t', f'{2 * HALF:.3f}', '-vf', f"select='not(mod(n,{step}))'",
                              '-fps_mode', 'passthrough', '-f', 'rawvideo', '-pix_fmt', 'bgr24', '-'], stdout=subprocess.PIPE)
        best, embs, j, n = None, [], 0, VW * VH * 3
        while True:
            buf = p.stdout.read(n)
            if len(buf) < n: break
            img = np.frombuffer(buf, np.uint8).reshape(VH, VW, 3); t = t0 + j * step / fps; j += 1
            f = detect_near(det, img, cx, cy, fw)
            if f is None: continue
            L = looks(img, f)
            if L is None: continue
            R = 1.2 * max(f[2], f[3]); x0, y0 = int(max(0, f[0] + f[2] / 2 - R)), int(max(0, f[1] + f[3] / 2 - R))
            cr = img[y0:int(f[1] + f[3] / 2 + R), x0:int(f[0] + f[2] / 2 + R)]; g = f.copy(); g[XS] -= x0; g[YS] -= y0
            try: e = rec.feature(rec.alignCrop(cr, g))[0]; e = e / (np.linalg.norm(e) + 1e-9)
            except cv2.error: e = None
            if e is not None: embs.append(e)
            G = face_score(f); s = float(np.prod(list(look_factors(L, {'sharp': 1e9, 'eyes_dark': 1.0}).values()) + list(G.values())))   # inside one moment: no caps
            if best is None or s > best['s']:
                best = {'t': round(t, 3), 'face': [float(v) for v in f[:4]], 'eyes': float(geometry(f)[3] / f[2]), 'L': L, 'G': G, 's': s, 'emb': e,
                        'jpg': cv2.imencode('.jpg', img, [cv2.IMWRITE_JPEG_QUALITY, 95])[1]}
            cx, cy, fw = f[0] + f[2] / 2, f[1] + f[3] / 2, f[2]          # follow the face through the window
        p.stdout.close(); p.wait()
        # the frame with the best picture of this window; every face of it counts for the player's mean face
        return k, c, best, embs
    with ThreadPoolExecutor(4) as ex: res = list(ex.map(window, jobs))
    a2 = time.time()
    print(f'4K pass: {len(jobs)} moments, {a2 - a1:.0f} s', flush=True)
    if os.environ.get('PORTRAIT_DEBUG'):
        json.dump([{'k': k, 'f': c['f'], 's1': c['s1'], **({'t': o['t'], 'L': o['L']} if o else {})} for k, c, o, _ in res], open(os.environ['PORTRAIT_DEBUG'] + '.4k.json', 'w'), default=float)
    # 4. each moment against the player's other moments; the face like the player's other faces (the mean of all
    # their 4K faces is the player)
    best = {}
    for k in players:
        rows = [(c, o) for kk, c, o, _ in res if kk == k and o is not None]
        embs = [e for kk, _, _, es in res if kk == k for e in es]
        mean = np.mean(embs, 0) if embs else None
        if mean is not None: mean /= np.linalg.norm(mean) + 1e-9
        top = {q: float(np.percentile([o['L'][q] for _, o in rows] or [1.0], 80)) for q in ('sharp', 'eyes_dark')}   # not the maximum: one odd frame
        for c, o in rows:
            cs = float(o['emb'] @ mean) if (o['emb'] is not None and mean is not None) else 0.5
            o['F'] = {**look_factors(o['L'], top), **o['G'], 'same': float(min(1.0, max(0.2, (cs - 0.25) / 0.4)))}
            P = {q: v for q, v in c['why1'].items() if q in ('hands', 'upright', 'clear', 'room', 'still')}
            o['why'] = {**P, **o['F']}; o['score'] = float(np.prod(list(o['why'].values())))
        rows.sort(key=lambda co: -co[1]['score'])
        best[k] = rows
    os.makedirs(os.path.dirname(os.path.abspath(outf)) or '.', exist_ok=True)
    pdir = os.path.join(os.path.dirname(os.path.abspath(outf)), 'portraits'); os.makedirs(pdir, exist_ok=True)
    chosen = {}
    for k in players:
        lst = []
        for c, o in best[k][:3]:
            e = {'f': c['f'], 't': o['t'], 'face': c['face'], 'sharp': round(o['L']['sharp'], 1), 'eyes': round(o['eyes'], 3),
                 'score': round(o['score'], 4), 'why': {q: round(v, 3) for q, v in o['why'].items()}}
            if not lst:
                fn = f'portrait-{k}.jpg'; open(f'{pdir}/{fn}', 'wb').write(o['jpg'].tobytes())
                e['hi'] = {'file': f'portraits/{fn}', 'face': o['face'], 't': o['t']}
            lst.append(e)
        chosen[str(k)] = lst
        if lst: print(f"portrait {k}: {lst[0]['f']} at {lst[0]['t']:.2f} s, score {lst[0]['score']:.3f}", {q: round(v, 2) for q, v in lst[0]['why'].items()}, flush=True)
    # a player with no face here keeps the choice of faces.py (PORTRAIT_FALLBACK: who.py's faces-chosen.json)
    fb = os.environ.get('PORTRAIT_FALLBACK')
    if fb and os.path.exists(fb):
        for k, lst in json.load(open(fb)).items():
            if not chosen.get(k) and lst: chosen[k] = lst; print(f'portrait {k}: no face passed here; the choice of faces.py', flush=True)
    json.dump(chosen, open(outf, 'w'))
    if os.environ.get('PORTRAIT_SHEET'): sheet(best, players, os.environ['PORTRAIT_SHEET'])
    print(f'portraits in {time.time() - a0:.0f} s', flush=True)


def iou(a, b):
    ix = max(0.0, min(a[2], b[2]) - max(a[0], b[0])) * max(0.0, min(a[3], b[3]) - max(a[1], b[1]))
    u = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - ix
    return ix / max(1e-6, u)


def sheet(best, players, path):
    """One row for each player: the best frames of each window, best first, with the score. To look at."""
    rows = []
    for k in players:
        tiles = []
        for c, o in best[k][:8]:
            x, y, w, h = o['face']; r = max(w, h); im = cv2.imdecode(o['jpg'], cv2.IMREAD_COLOR)
            cr = im[int(max(0, y - 1.1 * r)):int(y + 3.9 * r), int(max(0, x + w / 2 - 2.1 * r)):int(x + w / 2 + 2.1 * r)]
            cr = cv2.resize(cr, (240, 286)); cv2.putText(cr, f"{o['score']:.3f}", (6, 24), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (0, 255, 255), 2)
            for i, (q, v) in enumerate(sorted(o['why'].items(), key=lambda qv: qv[1])[:3]):      # the three weakest factors
                cv2.putText(cr, f'{q} {v:.2f}', (6, 220 + 22 * i), cv2.FONT_HERSHEY_SIMPLEX, 0.55, (0, 255, 255), 2)
            tiles.append(cr)
        while len(tiles) < 8: tiles.append(np.zeros((286, 240, 3), np.uint8))
        rows.append(np.hstack(tiles))
    if rows: cv2.imwrite(path, np.vstack(rows), [cv2.IMWRITE_JPEG_QUALITY, 85])


if __name__ == '__main__':
    main()
