"""The clean clips of a reel from the whole film: each stretch decoded from the camera file, then joined into what the
reel job's step "clips" writes. The work of `modal/fullclips.py` (by hand) and of `modal/fastreel.py` (a whole film,
with no person); each Modal function there reloads the store, calls one of these, and commits.

A phone cuts its stretches out of the film without decoding, and the reel job then finds the joins and the flash-backs
of that cut. With the whole film on the store there is nothing to repair: each stretch is decoded from the camera file
from the key frame before it, and encoded once. `join` writes what `run_make` looks for before it skips the step
"clips": clean4k.mp4, proxy.mp4, index.json, match/stretches.json, match/kf/ and match/kf_times.txt, and film.json
(where each clip sits in the film).

A copy of the stretches made with `ffmpeg -c copy` and joined does not work as the job's "video" (27 November 2026):
a stretch cut inside a group of pictures gives "Invalid data found" at each join, each machine then counts other
pictures, and the job stops with "clean file 196.20 s, working copy 196.06 s".
"""
import os, json, subprocess
from fractions import Fraction

# The curves of an HDR film into normal video, and the colour tags of every file the job writes (fastreel.py too)
TONE = {'arib-std-b67': ("zscale=tin=arib-std-b67:min=bt2020nc:pin=bt2020:rin=tv:t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,"
                         "tonemap=tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv,format=yuv420p,eq=contrast=1.13:brightness=-0.02:saturation=1.22"),
        'smpte2084': ("zscale=tin=smpte2084:min=bt2020nc:pin=bt2020:rin=tv:t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,"
                      "tonemap=tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv,format=yuv420p")}
C709 = ['-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709']


def sh(cmd):
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0: raise RuntimeError(f"{os.path.basename(cmd[0])} failed: {(r.stdout + r.stderr)[-1500:]}")
    return r.stdout


def probe(path):
    s = json.loads(sh(['ffprobe', '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height,r_frame_rate,color_transfer', '-of', 'json', path]))['streams'][0]
    n, d = s['r_frame_rate'].split('/')
    return {'w': s['width'], 'h': s['height'], 'rate': s['r_frame_rate'], 'fps': float(n) / float(d), 'trc': s.get('color_transfer', '')}


def frames_of(path):
    return int(sh(['ffprobe', '-v', 'error', '-select_streams', 'v:0', '-count_packets', '-show_entries', 'stream=nb_read_packets', '-of', 'csv=p=0', path]).strip().strip(','))


def even_frames(start, end, fps):
    """How many pictures a stretch keeps: an even number, so the working copy (every second picture) keeps the clock."""
    return max(2, int((end - start) * fps) // 2 * 2)


def checked(stretches):
    """The stretches in the order of the film, or ValueError: none empty, none over the next. Pure."""
    S = sorted([float(a), float(b)] for a, b in stretches)
    if not S or any(b <= a for a, b in S) or any(S[i][1] > S[i + 1][0] for i in range(len(S) - 1)):
        raise ValueError('the stretches must not be empty and must not overlap')
    return S


def clean_stretch(video, i, start, end, info, W):
    """One stretch of the film as a 4K piece and a 1080p piece at half the frame rate, and its sound, in W/parts/."""
    import time
    a = time.time(); n = even_frames(start, end, info['fps'])
    tone = TONE.get(info['trc'], 'format=yuv420p'); big = 'scale=3840:-2:flags=lanczos,' if info['w'] > 3840 else ''
    r = Fraction(info['rate']); halve = r > 40; r2 = r / 2 if halve else r
    half = (f"select='not(mod(n,2))'," if halve else '') + f'setpts=N/({r2.numerator}/{r2.denominator})/TB'
    graph = f"[0:v]select='lt(n,{n})',setpts=N/({info['rate']})/TB,{big}{tone},split=2[a][b];[b]scale=1920:-2:flags=lanczos,{half}[p]"
    tmp = f'/tmp/stretch-{i:02d}'; os.makedirs(tmp, exist_ok=True)
    sh(['ffmpeg', '-v', 'error', '-nostdin', '-y', '-threads', '0', '-ss', f'{start:.3f}', '-t', f'{end - start + 2:.3f}', '-i', video, '-filter_complex', graph,
        '-map', '[a]', '-r', info['rate'], '-c:v', 'libx264', '-preset', 'fast', '-crf', '16', '-g', '60', '-pix_fmt', 'yuv420p', *C709, '-an', f'{tmp}/p4k.mp4',
        '-map', '[p]', '-r', f'{r2.numerator}/{r2.denominator}', '-c:v', 'libx264', '-preset', 'fast', '-crf', '17', '-g', '30', '-pix_fmt', 'yuv420p', *C709, '-an', f'{tmp}/pp.mp4'])
    got, gotp = frames_of(f'{tmp}/p4k.mp4'), frames_of(f'{tmp}/pp.mp4')
    if got != n or gotp != (n // 2 if halve else n): raise RuntimeError(f'stretch {i}: {got} pictures and {gotp} in the working copy, {n} wanted')
    sh(['ffmpeg', '-v', 'error', '-nostdin', '-y', '-ss', f'{start:.3f}', '-t', f"{n / info['fps']:.4f}", '-i', video, '-map', '0:a:0', '-vn', '-ar', '48000', '-ac', '2', '-c:a', 'pcm_s16le', f'{tmp}/a.wav'])
    d = f'{W}/parts'; os.makedirs(d, exist_ok=True)
    for src, name in ((f'{tmp}/p4k.mp4', f'v4k-{i:02d}.mp4'), (f'{tmp}/pp.mp4', f'vp-{i:02d}.mp4'), (f'{tmp}/a.wav', f'a-{i:02d}.wav')): sh(['cp', src, f'{d}/{name}'])
    return {'i': i, 'frames': n, 'seconds': round(time.time() - a, 1)}


def join(W, stretches, info, parts):
    """The pieces into clean4k.mp4 and proxy.mp4 with the sound, 3 frames a second, and stretches.json (as the job's
    join_clean), and film.json: where each clip sits in the film."""
    n = len(stretches); fps = info['fps']; tmp = '/tmp/film-join'; os.makedirs(tmp, exist_ok=True)
    for kind in ('v4k', 'vp', 'a'):
        with open(f'{tmp}/{kind}.txt', 'w') as f:
            for i in range(n): f.write(f"file '{W}/parts/{kind}-{i:02d}.{'wav' if kind == 'a' else 'mp4'}'\n")
    sh(['ffmpeg', '-v', 'error', '-nostdin', '-y', '-f', 'concat', '-safe', '0', '-i', f'{tmp}/a.txt', '-c:a', 'aac', '-b:a', '256k', '-ar', '48000', f'{tmp}/a.m4a'])
    for kind, name in (('v4k', 'clean4k.mp4'), ('vp', 'proxy.mp4')):
        sh(['ffmpeg', '-v', 'error', '-nostdin', '-y', '-f', 'concat', '-safe', '0', '-i', f'{tmp}/{kind}.txt', '-i', f'{tmp}/a.m4a', '-map', '0:v', '-map', '1:a', '-c', 'copy', '-shortest',
            '-movflags', '+faststart', f'{tmp}/{name}'])
        sh(['cp', f'{tmp}/{name}', f'{W}/{name}'])
    dur = lambda p: float(sh(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', p]).strip())
    d4, dp, fp = dur(f'{tmp}/clean4k.mp4'), dur(f'{tmp}/proxy.mp4'), probe(f'{tmp}/proxy.mp4')['fps']
    if abs(d4 - dp) > 0.1 or not 29 < fp < 31: raise RuntimeError(f'clean file {d4:.2f} s, working copy {dp:.2f} s at {fp:.2f} a second')
    M = f'{W}/match'; kf = f'{M}/kf'; os.makedirs(kf, exist_ok=True)
    json.dump({'clean4k.mp4': {'start': 0.0}}, open(f'{W}/index.json', 'w'))
    sh(['ffmpeg', '-v', 'error', '-nostdin', '-y', '-i', f'{tmp}/proxy.mp4', '-vf', "select='not(mod(n,10))'", '-fps_mode', 'passthrough', '-q:v', '2', f'{kf}/%06d.jpg'])
    k = len([x for x in os.listdir(kf) if x.endswith('.jpg')])
    open(f'{M}/kf_times.txt', 'w').write(''.join(f'{i * 10 / fp:.3f}\n' for i in range(k)))
    edges = [0]
    for p in parts: edges.append(edges[-1] + p['frames'])
    json.dump({'stretches': [[round(edges[i] / fps, 3), round(edges[i + 1] / fps, 3)] for i in range(n)], 'joins_raw': edges[1:-1], 'flashes_raw': [], 'fps': fps,
               'scale': 2 if info['h'] >= 2000 or info['w'] >= 3000 else 1}, open(f'{M}/stretches.json', 'w'))
    film = [[round(s, 3), round(s + p['frames'] / fps, 3)] for (s, _), p in zip(stretches, parts)]
    json.dump({'clips': film}, open(f'{W}/film.json', 'w'))
    return {'clean4k': round(d4, 2), 'proxy': round(dp, 2), 'frames3': k, 'film': film}
