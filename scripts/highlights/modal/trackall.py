"""Follow the four players through many pieces of a match at once: one Modal machine for each piece.
usage: modal run trackall.py --clips clips.txt --out <dir> [--folder <folder on the volume>]
clips.txt: one line "name t0 t1" for each piece. The volume holds <folder>/proxy.mov (the working video) and
<folder>/hl/ with models/ (yolox_s.onnx, dinov2_small.onnx, rtmpose-m/) and match/ (ident.json, ident-model.pkl,
ident-far.pkl, ident-colours.json, match.json, court.json). The result of a piece is the same file that track.py
writes on one machine (tested: equal sightings and boxes)."""
import modal, os, json
app = modal.App('kicksmash-trackall')
vol = modal.Volume.from_name('kicksmash-matches')
image = (modal.Image.debian_slim(python_version='3.11').apt_install('ffmpeg', 'libgl1', 'libglib2.0-0')
         .pip_install('numpy==2.4.6', 'onnxruntime==1.32.0', 'scikit-learn==1.9.1', 'opencv-python-headless==5.0.0.93', 'rtmlib==0.0.16', 'scipy==1.17.1', 'tqdm')
         .add_local_dir(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), '/root/hl', ignore=['__pycache__', 'modal']))


@app.function(image=image, cpu=4, memory=8192, timeout=1800, volumes={'/vol': vol}, max_containers=60)
def track(job):
    import subprocess
    folder, name, t0, t1 = job; os.makedirs('/work', exist_ok=True)
    for d in ('models', 'match'):
        if not os.path.exists(f'/work/{d}'): os.symlink(f'/vol/{folder}/hl/{d}', f'/work/{d}')
    r = subprocess.run(['python', '-u', '/root/hl/track.py', f'/vol/{folder}/proxy.mov', '/work/match/ident', str(t0), str(t1), '/tmp/out.json'], capture_output=True, text=True, env=dict(os.environ, HL_HOME='/work', PYTHONDONTWRITEBYTECODE='1'))
    if r.returncode != 0 or not os.path.exists('/tmp/out.json'): return name, None, (r.stdout + r.stderr)[-700:]
    return name, open('/tmp/out.json').read(), r.stdout[-120:]


@app.local_entrypoint()
def main(clips: str, out: str, folder: str = 'match2'):
    jobs = [(folder, a, float(b), float(c)) for a, b, c in (l.split() for l in open(clips) if l.strip()) if not os.path.exists(f'{out}/{a}.json')]
    print(len(jobs), 'pieces to follow'); ok = bad = 0
    for name, text, log in track.map(jobs, order_outputs=False, return_exceptions=True) if jobs else []:
        if text: open(f'{out}/{name}.json', 'w').write(text); ok += 1
        else: bad += 1; print('FAILED', name, str(log)[-300:])
    print('TRACKALL_MODAL_DONE', ok, 'ok', bad, 'failed')
