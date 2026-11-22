"""Pictures of the camera file around a moment, cut around a place and set side by side: for a reader who checks a hit or a bounce.

usage: modal run strip.py --jobs jobs.json --out <dir>
jobs.json: [{"name": "s01-hit", "t": 5584.90, "before": 5, "after": 6, "centres": [[x, y], ...] or [x, y], "half": 200}]
Each picture of the strip carries its time stamp. `centres`: the middle of the cut for each picture, or one place for all.
"""
import modal, os, json
app = modal.App('kicksmash-strip')
vol = modal.Volume.from_name('kicksmash-matches')
image = modal.Image.debian_slim(python_version='3.11').apt_install('ffmpeg', 'libgl1', 'libglib2.0-0').pip_install('numpy==2.4.6', 'opencv-python-headless==5.0.0.93')


@app.function(image=image, cpu=2, memory=4096, timeout=1200, volumes={'/vol': vol}, max_containers=40)
def strip(job):
    import subprocess, numpy as np, cv2
    folder, j = job; f = f'/vol/{folder}/video.mov'; W, H, FPS = 3840, 2160, 60000 / 1001; n = j['before'] + j['after'] + 1; t0 = j['t'] - j['before'] / FPS
    p = subprocess.run(['ffprobe', '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'packet=pts_time', '-of', 'csv=p=0', '-read_intervals', f'{t0 - 2:.3f}%{t0 + n / FPS + 1:.3f}', f], capture_output=True, text=True)
    ts = sorted(t for t in (float(x.split(',')[0]) for x in p.stdout.split() if x.strip() and x[0].isdigit()) if t >= t0 - 0.004)
    q = subprocess.Popen(['ffmpeg', '-v', 'error', '-nostdin', '-ss', f'{t0 - 0.004:.4f}', '-i', f, '-frames:v', str(n), '-map', '0:v:0', '-fps_mode', 'passthrough', '-f', 'rawvideo', '-pix_fmt', 'bgr24', '-'], stdout=subprocess.PIPE)
    tiles = []; half = j.get('half', 200); z = j.get('zoom', 1.5); cs = j['centres']
    for i in range(n):
        b = q.stdout.read(W * H * 3)
        if len(b) < W * H * 3: break
        im = np.frombuffer(b, np.uint8).reshape(H, W, 3); c = cs[min(i, len(cs) - 1)] if isinstance(cs[0], (list, tuple)) else cs
        x0 = int(min(max(c[0] - half, 0), W - 2 * half)); y0 = int(min(max(c[1] - half, 0), H - 2 * half)); t = im[y0:y0 + 2 * half, x0:x0 + 2 * half]
        t = cv2.resize(t, None, fx=z, fy=z, interpolation=cv2.INTER_CUBIC); lab = '%d  %.3f' % (i + 1, ts[i] if i < len(ts) else t0 + i / FPS)
        cv2.rectangle(t, (0, 0), (190, 30), (0, 0, 0), -1); cv2.putText(t, lab, (6, 22), 0, 0.7, (0, 255, 255), 2); tiles.append(t)
    q.kill()
    if not tiles: return j['name'], None
    per = j.get('per_row', 6); rows = []
    for r in range(0, len(tiles), per):
        row = tiles[r:r + per]; row += [np.zeros_like(tiles[0])] * (per - len(row)); rows.append(np.hstack(row))
    ok, buf = cv2.imencode('.jpg', np.vstack(rows), [cv2.IMWRITE_JPEG_QUALITY, 88]); return j['name'], buf.tobytes()


@app.local_entrypoint()
def main(jobs: str, out: str, folder: str = 'match2'):
    js = [(folder, j) for j in json.load(open(jobs)) if not os.path.exists(f"{out}/{j['name']}.jpg")]; os.makedirs(out, exist_ok=True); ok = 0
    for name, data in strip.map(js, order_outputs=False, return_exceptions=True) if js else []:
        if data: open(f'{out}/{name}.jpg', 'wb').write(data); ok += 1
        else: print('FAILED', name)
    print('STRIP_DONE', ok, 'of', len(js))
