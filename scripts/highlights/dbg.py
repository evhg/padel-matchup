"""Draw a clip's tracks on a few of its frames, to check the names by eye.
usage: dbg.py <video> <track.json> <out.jpg> [frames=6]"""
import json, sys, os, numpy as np, cv2
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from people import read_frames
video, trf, out = sys.argv[1:4]; k = int(sys.argv[4]) if len(sys.argv) > 4 else 6
T = json.load(open(trf)); names = ['0', '1', '2', '3']; colr = [(0, 255, 255), (255, 200, 0), (0, 160, 255), (120, 255, 120)]
want = set(int(x) for x in np.linspace(10, T['frames'] - 10, k)); tiles = []
for n, (t, img) in enumerate(read_frames(video, T['t0'], T['frames'] / T['fps'])):
    if n not in want: continue
    im = img.copy()
    for key, p in T['players'].items():
        j = int(np.argmin(np.abs(np.array(p['f']) - n)))
        if abs(p['f'][j] - n) <= 3:
            b = [int(v) for v in p['box'][j]]; c = colr[int(key)]
            cv2.rectangle(im, (b[0], b[1]), (b[2], b[3]), c, 3); cv2.putText(im, names[int(key)], (b[0], max(30, b[1] - 8)), cv2.FONT_HERSHEY_SIMPLEX, 1.2, c, 3)
    cv2.putText(im, f'{int(t // 60)}:{t % 60:04.1f}', (20, 1060), cv2.FONT_HERSHEY_SIMPLEX, 1.2, (255, 255, 255), 3)
    tiles.append(cv2.resize(im, (960, 540)))
while len(tiles) % 2: tiles.append(np.zeros_like(tiles[0]))
cv2.imwrite(out, np.vstack([np.hstack(tiles[r:r + 2]) for r in range(0, len(tiles), 2)]), [cv2.IMWRITE_JPEG_QUALITY, 82])
