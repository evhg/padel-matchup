"""Every person on the court after each point, ten times a second, on a Mac's graphics chip (walk.py's file, longer).

usage: walk_mps.py <video> <points.json> <out dir> [before=1.5] [after=8.0] [pictures a second=10]
env: HL_HOME (match/court.json for court.zone), MODEL (ultralytics pose weights, yolo11l-pose.pt), IMGSZ (2560)

walk.py reads the 1080p working copy with YOLOX and RTMPose on the processor, and the files of match2 stop 1.5 s after
the dead ball: the players' reaction is cut. This reads the camera file (4K) from `before` s before the dead ball to
`after` s after it, and finds the people with an ultralytics pose model on the graphics chip (MPS). It writes one
file for each point, named as walk.py's (p<serve_t>.json), in walk.py's form and in walk.py's picture space (1920 x
1080), so flight.py, ident.py and winner.py read it as they read walk.py's: {"t0", "fps", "frames": [{"t", "people":
[{"box", "zone", "score", "kp"}]}]}. A person counts only where court.zone puts the box on the court (the next court
and the people outside the glass are dropped). An HDR film is read as it is (no tone curve): the pose model does not
need the colours, and the ffmpeg of Homebrew has no zscale.
"""
import json, os, subprocess, sys, time
import numpy as np
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from court import zone

W0, H0 = 1920, 1080          # walk.py's picture space


def size_of(video):
    s = subprocess.run(['ffprobe', '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', video],
                       capture_output=True, text=True, check=True).stdout.strip().split(',')
    return int(s[0]), int(s[1])


def frames(video, t0, dur, fps, w, h):
    """Pictures of [t0, t0 + dur) at `fps`, decoded by VideoToolbox, as BGR arrays with their times."""
    cmd = ['ffmpeg', '-v', 'error', '-nostdin', '-hwaccel', 'videotoolbox', '-ss', f'{t0:.3f}', '-i', video, '-t', f'{dur:.3f}',
           '-map', '0:v:0', '-vf', f'fps={fps}', '-f', 'rawvideo', '-pix_fmt', 'bgr24', '-']
    p = subprocess.Popen(cmd, stdout=subprocess.PIPE); n = w * h * 3; i = 0
    while True:
        b = p.stdout.read(n)
        if len(b) < n: break
        yield t0 + i / fps, np.frombuffer(b, np.uint8).reshape(h, w, 3); i += 1
    p.stdout.close(); p.wait()


def far_box():
    """The far half of the court in walk.py's space, with room for a standing player: [x0, y0, x1, y1].
    In the whole picture a far player is small (80 to 150 pixels at 1080p), and the model gives one of the two a low
    score or none (match2: 0.11 to 0.35, where a crop of the camera file gives 0.7 to 0.9). So the far half is read a
    second time, cut from the camera file at its own size."""
    import court as C
    return [min(C.POST_L, C.FAR_L0) - 60, C.FAR_TOP_Y - 1.5 * C.FAR_H0, max(C.POST_R, C.FAR_R0) + 60, C.NET_FOOT_Y + 20]


def people(res, k, want, ox=0.0, oy=0.0):
    """One picture's people in the half `want`, in walk.py's form and space. k: the scale from the film to 1920 x 1080;
    ox, oy: where the picture that the model read starts in the film (a crop)."""
    out = []
    if res.boxes is None or res.keypoints is None: return out
    bx = res.boxes.xyxy.cpu().numpy(); bx[:, [0, 2]] += ox; bx[:, [1, 3]] += oy; bx *= k; sc = res.boxes.conf.cpu().numpy()
    kp = res.keypoints.data.cpu().numpy(); kp[:, :, 0] += ox; kp[:, :, 1] += oy; kp[:, :, :2] *= k
    for b, s, q in zip(bx, sc, kp):
        z = zone([*b, s], W0, H0)
        if z != want: continue
        out.append({'box': [round(float(x), 1) for x in b] + [round(float(s), 2)], 'zone': z, 'score': round(float(s), 2), 'kp': np.round(q, 1).tolist()})
    return out


def main():
    video, pf, od = sys.argv[1:4]
    before = float(sys.argv[4]) if len(sys.argv) > 4 else 1.5; after = float(sys.argv[5]) if len(sys.argv) > 5 else 8.0
    fps = float(sys.argv[6]) if len(sys.argv) > 6 else 10.0
    from ultralytics import YOLO
    model = YOLO(os.environ.get('MODEL', 'yolo11l-pose.pt')); imgsz = int(os.environ.get('IMGSZ', 1920))
    w, h = size_of(video); k = W0 / w; os.makedirs(od, exist_ok=True)
    fx0, fy0, fx1, fy1 = (int(round(v / k)) for v in far_box()); fx0, fy0 = max(fx0, 0), max(fy0, 0); fx1, fy1 = min(fx1, w), min(fy1, h)
    fsz = int(min(2560, max(640, (fx1 - fx0 + 31) // 32 * 32)))         # the crop at its own size
    P = [p for p in json.load(open(pf))['points'] if p.get('serve_t') is not None and p.get('dead_t') is not None and not p.get('unseen')]
    t_all = time.time(); n_all = 0
    for p in P:
        name = 'p%.2f' % p['serve_t']; out = f'{od}/{name}.json'
        if os.path.exists(out): continue
        t0 = p['dead_t'] - before; t = time.time(); fr = []
        batch = []
        def flush():
            if not batch: return
            rs = model.predict([b[1] for b in batch], imgsz=imgsz, device='mps', verbose=False, conf=0.25)
            rf = model.predict([np.ascontiguousarray(b[1][fy0:fy1, fx0:fx1]) for b in batch], imgsz=fsz, device='mps', verbose=False, conf=0.25)
            for (tt, _), r, q in zip(batch, rs, rf):
                fr.append({'t': round(tt, 3), 'people': people(r, k, 'near') + people(q, k, 'far', fx0, fy0)})
            batch.clear()
        for tt, img in frames(video, t0, before + after, fps, w, h):
            batch.append((tt, img))
            if len(batch) == 8: flush()
        flush()
        json.dump({'t0': round(t0, 3), 'fps': fps, 'dead_t': p['dead_t'], 'frames': fr}, open(out, 'w'))
        n_all += len(fr)
        print(f'{name} {len(fr)} pictures, {sum(len(f["people"]) for f in fr)} sightings, {time.time() - t:.1f} s', flush=True)
    print('WALK_MPS_DONE', len(P), 'points', n_all, 'pictures', f'{time.time() - t_all:.0f} s')


if __name__ == '__main__':
    main()
