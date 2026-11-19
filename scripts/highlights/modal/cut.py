"""Pieces of a match video that is on the Modal volume, cut without a new encode: the full picture for a reel.

usage: modal run cut.py --name <folder> --windows "960-995,2900-2955"
Each piece goes to /vol/<name>/cut/<start>-<end>.mov. A cut without a new encode starts on a key frame, so a piece
starts up to about a second before the asked time: the true start is printed and written to cut/index.json.
Only the picture and the first sound track are kept (no location tags).
"""
import modal, subprocess, os, json
app = modal.App('kicksmash-cut')
vol = modal.Volume.from_name('kicksmash-matches')
image = modal.Image.debian_slim(python_version='3.11').apt_install('ffmpeg')


@app.function(image=image, cpu=2, memory=4096, timeout=3600, volumes={'/vol': vol})
def cut(name: str, windows: str):
    d = f'/vol/{name}/cut'; os.makedirs(d, exist_ok=True); done = []
    ix = json.load(open(f'{d}/index.json')) if os.path.exists(f'{d}/index.json') else {}
    for w in [x for x in windows.split(',') if x]:
        a, b = [float(v) for v in w.split('-')]; o = f'{d}/{int(a):05d}-{int(b):05d}.mov'
        r = subprocess.run(['ffmpeg', '-v', 'error', '-nostdin', '-y', '-ss', str(a), '-t', str(b - a), '-i', f'/vol/{name}/video.mov', '-map', '0:v:0', '-map', '0:a:0',
                            '-c', 'copy', '-map_metadata', '-1', '-avoid_negative_ts', 'make_zero', o], capture_output=True, text=True)
        ok = os.path.exists(o) and os.path.getsize(o) > 1000
        # the first picture of the piece, on the clock of the whole video: the key frame at or before a
        p = subprocess.run(['ffprobe', '-v', 'error', '-skip_frame', 'nokey', '-select_streams', 'v:0', '-show_entries', 'frame=pts_time', '-of', 'csv=p=0',
                            '-read_intervals', f'{max(0, a - 3)}%{a + 0.01}', f'/vol/{name}/video.mov'], capture_output=True, text=True)
        keys = [float(x.split(',')[0]) for x in p.stdout.split() if x.strip()]
        start = max([k for k in keys if k <= a + 0.001], default=a)
        if ok: ix[os.path.basename(o)] = {'asked': [a, b], 'start': start, 'bytes': os.path.getsize(o)}
        done.append((w, ok, start, os.path.getsize(o) if ok else 0, r.stderr.strip()[-160:]))
    json.dump(ix, open(f'{d}/index.json', 'w'), indent=1); vol.commit(); return done


@app.local_entrypoint()
def main(name: str, windows: str):
    for w, ok, start, size, err in cut.remote(name, windows): print(w, 'ok' if ok else 'FAILED ' + err, 'starts at', round(start, 3), round(size / 1e6, 1), 'MB')
