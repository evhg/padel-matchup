"""Frames of a finished video at the given times, as one sheet, to watch it by eye.
usage: peek.py <mp4> <out.jpg> <cols> t1 t2 ..."""
import sys, subprocess, numpy as np, cv2
mp4, out, cols = sys.argv[1], sys.argv[2], int(sys.argv[3]); ts = [float(x) for x in sys.argv[4:]]
info = subprocess.run(['ffprobe', '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', mp4], capture_output=True, text=True).stdout.strip().split(',')
w, h = int(info[0]), int(info[1]); tw = 960 if w >= h else 540; th = int(tw * h / w); tiles = []
for t in ts:
    raw = subprocess.run(['ffmpeg', '-v', 'error', '-nostdin', '-ss', f'{t:.3f}', '-i', mp4, '-frames:v', '1', '-vf', f'scale={tw}:{th}', '-f', 'rawvideo', '-pix_fmt', 'bgr24', '-'], capture_output=True).stdout
    if len(raw) < tw * th * 3: continue
    im = np.frombuffer(raw, np.uint8).reshape(th, tw, 3).copy()
    cv2.putText(im, f'{t:.1f}s', (tw - 110, th - 14), cv2.FONT_HERSHEY_SIMPLEX, 0.8, (255, 255, 255), 2); tiles.append(im)
while len(tiles) % cols: tiles.append(np.zeros_like(tiles[0]))
cv2.imwrite(out, np.vstack([np.hstack(tiles[r:r + cols]) for r in range(0, len(tiles), cols)]), [cv2.IMWRITE_JPEG_QUALITY, 82])
