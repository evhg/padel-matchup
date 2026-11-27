"""The places where the ball can be, picture by picture, in the camera file at its full size and full rate.

usage: ball_places.py <video> <t0> <t1> <out.json>

A ball that was hit hard is a small yellow thing that is in one picture only at its place. For each picture:
yellow = min(red, green) - blue, minus the larger yellow of the pictures GAP before and GAP after, a light blur,
then each island above the floor value is one candidate, at the middle of its weight. Two gaps: 2 pictures for a fast ball, 5 for a slow one.
The file holds candidates, not the ball: an arm or a shoe gives islands too, and flight.py chooses.
ball.py does the same on the working video (30 pictures a second) for the shot check of a rally; this one reads the camera
file, keeps the time stamp of each picture, and gives the middle of each island.
The time of a picture is its own time stamp in the file, not a count from the start.
"""
import sys, subprocess, json, os, numpy as np, cv2

GAPS = (2, 5); KEEP = int(os.environ.get('KEEP', 10)); FLOOR = float(os.environ.get('FLOOR', 6.0))
# CROP=x0,y0,x1,y1 (camera pixels) reads one part of the picture only, and writes the places in the whole picture.
# Over the whole picture the KEEP strongest islands are mostly the near players (shoes, arms, skin), and the far ball,
# a few pixels wide, is not among them: on match2 the last flight of a point ended in the far half in 32 of 182 points.
# A second run over the far half (CROP) keeps its own KEEP islands there. VT=1 decodes with VideoToolbox (a Mac).
CROP = [int(v) for v in os.environ['CROP'].split(',')] if os.environ.get('CROP') else None


def probe(f):
    p = subprocess.run(['ffprobe', '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height,r_frame_rate', '-of', 'json', f], capture_output=True, text=True)
    s = json.loads(p.stdout)['streams'][0]; a, b = s['r_frame_rate'].split('/'); return s['width'], s['height'], float(a) / float(b)


def stamps(f, t0, t1):
    """The time stamp of each picture from t0, in the order of display."""
    p = subprocess.run(['ffprobe', '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'packet=pts_time', '-of', 'csv=p=0', '-read_intervals', f'{max(0, t0 - 2):.3f}%{t1 + 1:.3f}', f], capture_output=True, text=True)
    return sorted(t for t in (float(x.split(',')[0]) for x in p.stdout.split() if x.strip() and x[0].isdigit()) if t >= t0 - 1e-4)


def candidates(d):
    """The islands of one difference picture: [x, y, strength, area, width, height], strongest first."""
    d = cv2.GaussianBlur(d, (0, 0), 2.0); m = (d > FLOOR).astype(np.uint8)
    if not m.any(): return []
    n, lab, st, _ = cv2.connectedComponentsWithStats(m, connectivity=8); out = []
    if n - 1 > 4000: return []                                  # the camera moved or the light changed: no ball in this
    for k in range(1, n):
        x, y, w, h, a = (int(v) for v in st[k])
        if a < 6 or a > 6000: continue
        part = d[y:y + h, x:x + w] * (lab[y:y + h, x:x + w] == k); tot = float(part.sum())
        cx = float((part.sum(0) * np.arange(w)).sum() / tot); cy = float((part.sum(1) * np.arange(h)).sum() / tot)     # the middle of the streak, not its brightest dot
        out.append([round(x + cx, 1), round(y + cy, 1), round(float(part.max()), 1), a, w, h])
    out.sort(key=lambda c: -c[2]); return out[:KEEP]


def main():
    f, t0, t1, o = sys.argv[1], float(sys.argv[2]), float(sys.argv[3]), sys.argv[4]; W, H, fps = probe(f); G = max(GAPS)
    ts = stamps(f, t0, t1)
    hw = ['-hwaccel', 'videotoolbox'] if os.environ.get('VT') else []
    x0, y0, x1, y1 = CROP or (0, 0, W, H); vf = ['-vf', f'crop={x1 - x0}:{y1 - y0}:{x0}:{y0}'] if CROP else []
    w, h = x1 - x0, y1 - y0
    p = subprocess.Popen(['ffmpeg', '-v', 'error', '-nostdin', *hw, '-ss', f'{t0:.4f}', '-i', f, '-t', f'{t1 - t0:.4f}', '-map', '0:v:0', '-fps_mode', 'passthrough',
                          *vf, '-f', 'rawvideo', '-pix_fmt', 'bgr24', '-'], stdout=subprocess.PIPE)
    Y = []; frames = []; i = 0
    while True:
        b = p.stdout.read(w * h * 3)
        if len(b) < w * h * 3: break
        im = np.frombuffer(b, np.uint8).reshape(h, w, 3); bl, g, r = cv2.split(im)
        Y.append(cv2.subtract(cv2.min(r, g).astype(np.int16), bl.astype(np.int16)))
        if len(Y) == 2 * G + 1:                                 # the picture in the middle has its neighbours on both sides
            c = []; mid = Y[G]
            for gap in GAPS:
                d = cv2.subtract(mid, cv2.max(Y[G - gap], Y[G + gap])).astype(np.float32)
                c += [[gap, v[0] + x0, v[1] + y0] + v[2:] for v in candidates(d)]
            k = i - G; frames.append({'t': round(ts[k], 4) if k < len(ts) else round(t0 + k / fps, 4), 'c': c}); Y.pop(0)
        i += 1
    p.wait()
    json.dump({'t0': t0, 't1': t1, 'fps': fps, 'size': [W, H], 'crop': CROP, 'pictures': i, 'stamps': len(ts), 'frames': frames}, open(o, 'w'), separators=(',', ':'))
    print('BALL_DONE', i, 'pictures', len(frames), 'with candidates', sum(len(x['c']) for x in frames))


if __name__ == '__main__': main()
