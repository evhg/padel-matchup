"""Cut the clip of each candidate point for the labelling page: some seconds before the last hit, some after.

    python label_clips.py <video> <points.json> <out_dir> [jobs=3] [seconds before=5] [seconds after=3]

points.json is a list with 'lastHit' in seconds of the video. The clips are 640x360 in normal colours
(the video of a phone is HDR), named 001.mp4, 002.mp4, ... in the order of the list. It also writes
cands.json for label_page.py and winners.py.
"""
import sys, os, json, subprocess
from concurrent.futures import ThreadPoolExecutor

video, pointsf, outd = sys.argv[1:4]
jobs = int(sys.argv[4]) if len(sys.argv) > 4 else 3
BEFORE = float(sys.argv[5]) if len(sys.argv) > 5 else 5.0
AFTER = float(sys.argv[6]) if len(sys.argv) > 6 else 3.0
P = sorted(json.load(open(pointsf)), key=lambda p: p['lastHit'])
os.makedirs(outd, exist_ok=True)
# Small first, colours second: the colour step on the full picture took four times as long.
SDR = 'scale=640:360,zscale=t=linear:npl=100,tonemap=hable,zscale=t=bt709:m=bt709:p=bt709,format=yuv420p'


def cut(k):
    p, f = P[k], f'{outd}/{k + 1:03d}.mp4'
    if os.path.exists(f) and os.path.getsize(f) > 10000:
        return
    r = subprocess.run(['ffmpeg', '-v', 'error', '-nostdin', '-y', '-ss', f"{max(0, p['lastHit'] - BEFORE):.2f}", '-t', f'{BEFORE + AFTER:.2f}', '-i', video,
                        '-vf', SDR, '-c:v', 'libx264', '-preset', 'medium', '-crf', '29', '-maxrate', '260k', '-bufsize', '520k',
                        '-c:a', 'aac', '-b:a', '40k', '-ac', '1', '-movflags', '+faststart', f + '.tmp.mp4'], capture_output=True, text=True)
    if r.returncode:
        print('FAILED', k + 1, r.stderr[-200:], flush=True)
    else:
        os.replace(f + '.tmp.mp4', f)


with ThreadPoolExecutor(jobs) as ex:
    list(ex.map(cut, range(len(P))))
json.dump([{'i': k, 'firstHit': p.get('firstHit', p.get('start')), 'end': p['lastHit'], 'lastHit': p['lastHit'], 'hits': p.get('hits'),
            'src': p.get('src')} for k, p in enumerate(P)], open(f'{outd}/cands.json', 'w'), indent=1)
size = sum(os.path.getsize(f'{outd}/{k + 1:03d}.mp4') for k in range(len(P)) if os.path.exists(f'{outd}/{k + 1:03d}.mp4'))
print('CLIPS_DONE', len(P), 'clips', round(size / 1e6, 1), 'MB')
