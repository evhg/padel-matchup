"""A frame at each hit, and the people in it: the truth for a test of the direction of sound.

    python hit_frames.py <video> <audio.json> <out_dir> [start s] [end s]

For each hit in audio.json between start and end it saves the frame 30 ms before the hit reached the
phone (the sound needs that long from the middle of the court) and writes the people it finds to
<out_dir>/people.jsonl: {"t": hit time, "s": strength, "d": [[x0, y0, x1, y1, score], ...]} in 1920x1080.
"""
import sys, os, json, subprocess, numpy as np, cv2
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from det import Yolox, detect

S = os.environ.get('HL_HOME') or os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
video, audio, outd = sys.argv[1:4]
a, b = (float(sys.argv[4]), float(sys.argv[5])) if len(sys.argv) > 5 else (0.0, 1e9)
hits = [h for h in json.load(open(audio))['hits'] if a <= h[0] < b]
os.makedirs(outd, exist_ok=True)
m = Yolox(f'{S}/models/yolox_s.onnx')
TILES = [(480, 240, 640, 400), (800, 240, 640, 400), (0, 220, 640, 640), (1280, 220, 640, 640)]
done = set()
if os.path.exists(f'{outd}/people.jsonl'):
    done = {json.loads(l)['t'] for l in open(f'{outd}/people.jsonl')}
with open(f'{outd}/people.jsonl', 'a') as fh:
    for k, (t, s) in enumerate(hits):
        if t in done: continue
        raw = subprocess.run(['ffmpeg', '-v', 'error', '-nostdin', '-ss', f'{max(0, t - 0.03):.3f}', '-i', video, '-frames:v', '1',
                              '-vf', 'zscale=t=linear:npl=100,tonemap=hable,zscale=t=bt709:m=bt709:p=bt709,format=bgr24',
                              '-f', 'rawvideo', '-'], capture_output=True).stdout
        if len(raw) != 1920 * 1080 * 3: continue
        img = np.frombuffer(raw, np.uint8).reshape(1080, 1920, 3)
        if k % 10 == 0: cv2.imwrite(f'{outd}/{t:08.2f}.jpg', img, [cv2.IMWRITE_JPEG_QUALITY, 80])
        d = detect(m, img, TILES, 0.3)
        fh.write(json.dumps({'t': t, 's': s, 'd': [[round(float(v), 1) for v in x[:4]] + [round(float(x[4]), 3)] for x in d]}) + '\n'); fh.flush()
print('HIT_FRAMES_DONE', len(hits))
