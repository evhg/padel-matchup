"""Consecutive frames of one region, enlarged, to find the ball by eye.
usage: ballstrip.py <video> <out.jpg> <t> <n frames> <x0> <y0> <w> <h> [cols=3] [scale=1]"""
import sys, subprocess, numpy as np, cv2
video, out = sys.argv[1:3]; t = float(sys.argv[3]); n = int(sys.argv[4]); x0, y0, w, h = [int(v) for v in sys.argv[5:9]]
cols = int(sys.argv[9]) if len(sys.argv) > 9 else 3; sc = float(sys.argv[10]) if len(sys.argv) > 10 else 1.0
raw = subprocess.run(['ffmpeg', '-v', 'error', '-nostdin', '-ss', f'{t:.3f}', '-i', video, '-frames:v', str(n), '-vf', f'crop={w}:{h}:{x0}:{y0}', '-f', 'rawvideo', '-pix_fmt', 'bgr24', '-'], capture_output=True).stdout
fr = np.frombuffer(raw, np.uint8).reshape(-1, h, w, 3)
tiles = []
for i, f in enumerate(fr):
    f = cv2.resize(f, None, fx=sc, fy=sc, interpolation=cv2.INTER_NEAREST) if sc != 1 else f.copy()
    cv2.putText(f, f'{t + i / 29.97:.2f}', (6, 22), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (255, 255, 255), 2); tiles.append(f)
while len(tiles) % cols: tiles.append(np.zeros_like(tiles[0]))
cv2.imwrite(out, np.vstack([np.hstack(tiles[i:i + cols]) for i in range(0, len(tiles), cols)]), [cv2.IMWRITE_JPEG_QUALITY, 92])
