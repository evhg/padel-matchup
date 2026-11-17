"""Draw the ball candidates of a time window over its middle frame: a dot for each, the colour runs from blue (early) to red (late).
usage: balldbg.py <video> <cand.npz> <out.jpg> <t_from> <t_to> [more windows: t_from t_to ...]"""
import sys, json, subprocess, numpy as np, cv2
video, cf, out = sys.argv[1:4]; wins = [float(x) for x in sys.argv[4:]]
z = np.load(cf); C, t0, fps = z['cand'], float(z['t0']), float(z['fps'])
P = z['path'] if 'path' in z else None
FL = json.loads(str(z['flights'])) if 'flights' in z else []
tiles = []
for a, b in zip(wins[0::2], wins[1::2]):
    tm = (a + b) / 2
    raw = subprocess.run(['ffmpeg', '-v', 'error', '-nostdin', '-ss', f'{tm:.3f}', '-i', video, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'bgr24', '-'], capture_output=True).stdout
    im = np.frombuffer(raw, np.uint8).reshape(1080, 1920, 3).copy(); im = (im * 0.6).astype(np.uint8)
    i0, i1 = int(round((a - t0) * fps)), int(round((b - t0) * fps))
    for i in range(max(0, i0), min(len(C), i1 + 1)):
        w = (i - i0) / max(1, i1 - i0); col = (int(255 * (1 - w)), 60, int(255 * w))
        for k, c in enumerate(C[i]):
            if not np.isfinite(c[0]): break
            cv2.circle(im, (int(c[0]), int(c[1])), 2, col, 1)
    for fl in FL:
        pts = [p for p in fl['pts'] if i0 <= p[0] <= i1]
        if len(pts) < 2: continue
        col = (0, 0, 255) if fl.get('body', 0) > 0.55 else (0, 255, 0)
        for u, v in zip(pts, pts[1:]): cv2.line(im, (int(u[1]), int(u[2])), (int(v[1]), int(v[2])), col, 2)
        cv2.putText(im, str(fl['f0']), (int(pts[0][1]) + 6, int(pts[0][2]) - 6), cv2.FONT_HERSHEY_SIMPLEX, 0.6, col, 2)
    cv2.putText(im, f'{a:.1f}-{b:.1f}', (20, 50), cv2.FONT_HERSHEY_SIMPLEX, 1.4, (255, 255, 255), 3); tiles.append(im)
cols = 2 if len(tiles) > 1 else 1
while len(tiles) % cols: tiles.append(np.zeros_like(tiles[0]))
rows = [np.hstack(tiles[i:i + cols]) for i in range(0, len(tiles), cols)]
sheet = np.vstack(rows); s = 1920 / sheet.shape[1] * (1 if cols == 1 else 1.5)
cv2.imwrite(out, cv2.resize(sheet, None, fx=min(1, s), fy=min(1, s), interpolation=cv2.INTER_AREA), [cv2.IMWRITE_JPEG_QUALITY, 88])
