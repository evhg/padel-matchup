"""Detect people on every sampled frame of the match. Resumable: one JSON line per frame.

usage: run_det.py <frames_dir> <out.jsonl> [model] [stride]
Each line: {"f": "000123.jpg", "d": [[x0,y0,x1,y1,score], ...]}
"""
import sys, os, json, time, cv2
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from det import Yolox, detect
from court import TILES as _CT

S = os.environ.get('HL_HOME') or os.path.dirname(os.path.dirname(os.path.abspath(__file__)))   # models/, fonts/ and match/ live here
frames_dir, out = sys.argv[1], sys.argv[2]
model = sys.argv[3] if len(sys.argv) > 3 else 'yolox_s'
stride = int(sys.argv[4]) if len(sys.argv) > 4 else 1
# Native-resolution tiles for a 1920x1080 picture: the far half of the court twice, and both sides.
TILES = _CT or [(480, 240, 640, 400), (800, 240, 640, 400), (0, 220, 640, 640), (1280, 220, 640, 640)]
m = Yolox(f'{S}/models/{model}.onnx')
done = set()
if os.path.exists(out):
    for line in open(out):
        try: done.add(json.loads(line)['f'])
        except Exception: pass
files = sorted(f for f in os.listdir(frames_dir) if f.endswith('.jpg'))[::stride]
t0 = time.time(); n = 0
with open(out, 'a') as fh:
    for f in files:
        if f in done: continue
        img = cv2.imread(os.path.join(frames_dir, f))
        if img is None: continue
        d = detect(m, img, TILES, 0.3)
        fh.write(json.dumps({'f': f, 'd': [[round(float(v), 1) for v in b[:4]] + [round(float(b[4]), 3)] for b in d]}) + '\n'); fh.flush()
        n += 1
        if n % 200 == 0: print(f'{n} frames, {(time.time() - t0) / n:.2f} s a frame', flush=True)
print(f'done: {n} new frames in {time.time() - t0:.0f} s', flush=True)
