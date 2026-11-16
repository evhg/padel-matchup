"""Like dbg.py, but only the far half of the court, enlarged. usage: dbgfar.py <video> <track.json> <out.jpg> [frames=8]"""
import json, sys, os, numpy as np, cv2
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from people import read_frames
video, trf, out = sys.argv[1:4]; k = int(sys.argv[4]) if len(sys.argv) > 4 else 8
T = json.load(open(trf)); names = ['0', '1', '2', '3']; colr = [(0, 255, 255), (255, 200, 0), (0, 160, 255), (120, 255, 120)]
want = set(int(x) for x in np.linspace(10, T['frames'] - 10, k)); tiles = []
X0, X1, Y0, Y1, Z = 560, 1360, 380, 620, 2.4
for n, (t, img) in enumerate(read_frames(video, T['t0'], T['frames'] / T['fps'])):
    if n not in want: continue
    im = cv2.resize(img[Y0:Y1, X0:X1], None, fx=Z, fy=Z, interpolation=cv2.INTER_CUBIC)
    for key, p in T['players'].items():
        j = int(np.argmin(np.abs(np.array(p['f']) - n)))
        if abs(p['f'][j] - n) <= 3:
            b = p['box'][j]; c = colr[int(key)]
            if b[3] > Y1 + 30: continue
            q = [int((b[0] - X0) * Z), int((b[1] - Y0) * Z), int((b[2] - X0) * Z), int((b[3] - Y0) * Z)]
            cv2.rectangle(im, (q[0], q[1]), (q[2], q[3]), c, 2); cv2.putText(im, names[int(key)], (q[0], max(24, q[1] - 6)), cv2.FONT_HERSHEY_SIMPLEX, 0.9, c, 2)
    cv2.putText(im, f'{int(t // 60)}:{t % 60:04.1f}', (10, im.shape[0] - 12), cv2.FONT_HERSHEY_SIMPLEX, 0.9, (255, 255, 255), 2)
    tiles.append(im)
cv2.imwrite(out, np.vstack(tiles), [cv2.IMWRITE_JPEG_QUALITY, 85])
