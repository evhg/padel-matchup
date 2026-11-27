"""The fast reel, with no person: a player's clips in, a reel of the eighth reel's kind out, on the match page.

deploy: modal deploy fastreel.py           (the reel host `serve.py` starts it; see "Start" below)
test:   modal run fastreel.py --request req.json --dry      (writes under the request's "out" folder,
        prints each progress line instead of posting it, and posts nothing to Kicksmash)

Start. `assemble` in serve.py joins a player's upload and tells Kicksmash (POST /api/reel/upload). When Kicksmash's
answer carries "fastReel" (the start request below), `assemble` starts `make` with it. The start request:

  {"upload": "<upload token>",                       the clips are uploads/<token>/video.<ext> (or "video": a path on the store)
   "matches": [{"code": "AB12", "title_a": "Ana & Bo", "title_b": "Cy & Di", "score": "6-3 6-2",
                "players": [{"id": "<player id>", "name": "Ana", "team": 1, "sex": "m"}, ... four]}, ...],
                (team: 1 and 2, 0 and 1, or "a" and "b"; `teams_from_zero` makes them 0 and 1, the engine's count)
   "music": "bounce"?,                                 the track when the player wrote no choices.json
   "place": "<camera place>"?, "court": {court.json}?, "venue": ""?, "grade": "glass"?,
   "whole": true?}                                     the upload is the whole film (the "Full reel"), not a phone's cut

  A whole film (27 November 2026): the same reel, with no person. The step "clips" reads the film's sound only (no
  picture is decoded: `film_sound`, film_plan.js, the phone's own choice of stretches), then decodes each stretch from
  the camera file on its own machine (`film_stretch`, `film_join`: film_clips.py, the work of fullclips.py). The steps
  after it are the fast reel's. The score box, the winner of each point and the numbers go in only when the engine is
  sure (honest.py); when they stay out, reel.json says why ("score": {"shown": false, "why": "<code>"}) and the post of
  the finished reel carries "noScore": "<code>". Every reel, fast and whole, also says what it could not do, as codes
  (missing.py): reel.json and the post of the finished reel carry "missing": ["<code>", ...], and the match page shows
  each code as a row of "What this reel could not do": the thing, the reason and a tip for the next film.

  An upload may hold more than one match of the same four players (24 November 2026: two matches, other pairs). The
  job finds the match of each clip from its near pair. "sex" is optional: with it the man/woman split is evidence.

  The player's choices: uploads/<token>/choices.json (serve.py cleans it), read at the start and again before the
  music, because the player can change the track while the reel is made:
  {"teams": [nameA | null, nameB | null], "crowd": bool, "numbers": bool, "music": "bounce" | "dnb" | "bigscreen" |
   "sunrise" | "none", "at": seconds}. teams: the titles of the upload's own match (the first one), null for the
  first names of the pair. crowd false: no cheers. numbers false: no card of numbers (the fast reel has none yet).
  music: assets/kicksmash-music-<name>.m4a ("bounce": kicksmash-music-warm-bounce.m4a), "none": the match sound only.
  No file: all on, and "bounce".

  A player's watch: uploads/<token>/hr.json, {"player": "Ana", "zone": "Asia/Bangkok", "rows": [{"t": "10:24", "bpm": 171}]},
  one value a minute (read from a screenshot of the watch's graph). With the clip times of meta.json ("times": the place
  of each clip in the film and when the film began) it is the heart-rate box of the reel (fast_points.py, meter_of).

Steps, and what Kicksmash hears after each (POST {KICKSMASH_URL}/api/reel/report, Bearer <the request's "report">):
  clips    the joins and the flash-backs of the phone's cut found, a clean 4K file and a 1080p working copy (a whole film:
           its sound read, a first report at 6%, then the stretches decoded from the camera file)
  players  people in 3 frames a second, who is who (who.py). Not sure: the job stops here (see "Names")
  follow   the players through each clip (track.py, one machine for each clip); beside it the ball of each clip (ball.py,
           balllink.py, one machine for each clip) and the openings
  replays  the plan (fast_points.py, reel_points.py) and every part drawn (render.py, one machine for each part)
  opening  the openings are there (portrait.py once, then versus.py, one machine for each match and layout)
  music    the parts joined, the crowd (cheers.py), the level, the track (music.py)
  finish   1080p wide.mp4 and tall.mp4, share.mp4 (the public version: the tall layout without the end card, the match
           sound only; share.py), versus.jpg (1200x630), poster.jpg (720 wide, tall) and reel.json (its matches, and
           "share": true when share.mp4 is there; not served), under reels/<new token>/; then
           POST {code, host, token, missing: [codes]} for each match of the upload (missing.py), and "noScore": "<code>"
           for a whole film's reel with no score (honest.py)
  Each progress POST is {code, progress: {pct, minutesLeft, step}}; while the job waits for names it adds
  "waiting": "names" to progress. A step that fails posts {code, failed: "<the error>"} for each match.

Names. When who.py is not sure of a name, it writes names.json and one face picture for each track to
reels/<upload token>/ (the token the app already keeps for this upload; the reel host serves /r/<token>/names.json and
/r/<token>/face-<n>.jpg). A player answers through the reel host, `POST /u/<upload token>/names` with a ticket of that
upload (serve.py), and that starts `resume`, which goes on from the step "players".

names.json: {"v": 1, "state": "names", "upload": "<token>", "players": [{"id", "name"}],
             "tracks": [{"track": 0, "face": "face-0.jpg", "guess": "<player id>", "confidence": 0.55, "ask": true}],
             "answer": {"method": "POST", "path": "/u/<token>/names", "body": {"names": {"<track>": "<player id>"}}}}

Secrets: none. `settings` (from_dict, as serve.py) holds KICKSMASH_URL and REELS_HOST. The posts carry the start
request's "report": a key Kicksmash signs for the codes of this upload alone, for three days (`signReelReport` in
src/lib/domain/matchReel.ts). It can report progress and the finished reel of those matches, and nothing else, so no
operator secret of Kicksmash lives on Modal.

Machines: processors only (no step was faster for a graphics card, measured 24 November 2026). Each function has its
own processors, memory and time limit; see the decorators.
"""
import modal, os, json, time, math, subprocess, secrets as pysecrets

HERE = os.path.dirname(os.path.abspath(__file__)); HL = os.path.dirname(HERE)
SETTINGS = {'KICKSMASH_URL': os.environ.get('KICKSMASH_URL', 'https://kicksma.sh'),
            'REELS_HOST': os.environ.get('REELS_HOST', 'https://evhg--kicksmash-reels-web.us-east.modal.run')}
APP = os.environ.get('FASTREEL_APP', 'kicksmash-fastreel')
app = modal.App(APP)
vol = modal.Volume.from_name('kicksmash-matches')
# Always two secrets, so a machine of the job sees the same list as the side that started it (Modal matches them by
# place): the operator's, or an empty one for a dry run.
SECRETS = [modal.Secret.from_dict(SETTINGS)]

PY = ['numpy==2.4.6', 'onnxruntime==1.32.0', 'scikit-learn==1.9.1', 'opencv-python-headless==5.0.0.93', 'rtmlib==0.0.16', 'scipy==1.17.1',
      'pillow==13.0.0', 'tqdm==4.70.1', 'soundfile==0.14.0', 'rembg==2.0.87', 'kokoro-onnx==0.6.1']
base = modal.Image.from_registry('ubuntu:24.04', add_python='3.11').apt_install('ffmpeg', 'libgl1', 'libglib2.0-0').pip_install(*PY)
image = base.add_local_dir(HL, '/root/hl', ignore=['__pycache__', 'modal', '*.md', '*.sh', '*.js'])
# A whole film's sound: the Rally Finder's core in Node, the file the phone loads (public/lab/rf-core.js), and the
# engine's python files, which every machine of the job imports this file beside.
sound_image = (modal.Image.from_registry('ubuntu:24.04', add_python='3.11').apt_install('ffmpeg', 'nodejs')
               .add_local_dir(HL, '/root/hl', ignore=['__pycache__', 'modal', '*.md', '*.sh', '*.js'])
               .add_local_file(f'{HL}/film_plan.js', '/root/hl/film_plan.js')
               .add_local_file(f'{os.path.dirname(os.path.dirname(HL))}/public/lab/rf-core.js', '/root/hl/rf-core.js'))
# who.py's man/woman split: an open image-text model (CLIP, MIT licence), in the image so a run downloads nothing
who_image = (base.pip_install('torch==2.15.0', index_url='https://download.pytorch.org/whl/cpu').pip_install('transformers==4.57.1')
             .run_commands("python -c \"from transformers import CLIPModel, CLIPProcessor as P; CLIPModel.from_pretrained('openai/clip-vit-base-patch32'); P.from_pretrained('openai/clip-vit-base-patch32')\"")
             .add_local_dir(HL, '/root/hl', ignore=['__pycache__', 'modal', '*.md', '*.sh', '*.js']))

ASSETS = '/vol/assets'
# The player's track (choices.json): assets/kicksmash-music-<name>.m4a. "bounce" is the first track (36 s, its drop and
# tempo measured by hand: 7.2 s, 100 a minute); a longer track gets its drop and tempo from `beat_of`.
TRACKS = {'bounce': ('kicksmash-music-warm-bounce.m4a', {'DROP': '7.2', 'BPM': '100', 'BARS': '10'})}
CHOICES = {'teams': [None, None], 'crowd': True, 'numbers': True, 'music': 'bounce'}
STEPS = ['clips', 'players', 'follow', 'replays', 'opening', 'music', 'finish']
# The share of the work done when a step ends, and the minutes it took on the clips of 24 November 2026 (196 s)
DONE = {'clips': 18, 'players': 35, 'follow': 50, 'replays': 70, 'opening': 78, 'music': 90, 'finish': 100}
TONE = {'arib-std-b67': ("zscale=tin=arib-std-b67:min=bt2020nc:pin=bt2020:rin=tv:t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,"
                         "tonemap=tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv,format=yuv420p,eq=contrast=1.13:brightness=-0.02:saturation=1.22"),
        'smpte2084': ("zscale=tin=smpte2084:min=bt2020nc:pin=bt2020:rin=tv:t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,"
                      "tonemap=tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv,format=yuv420p")}
C709 = ['-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709']


# ---------------------------------------------------------------- helpers (every machine)

def sh(cmd, env=None, check=True):
    """Run a command; on failure raise with the end of its output (never a secret: no command here holds one)."""
    a = time.time(); r = subprocess.run(cmd, capture_output=True, text=True, env=env)
    if check and r.returncode != 0: raise RuntimeError(f"{os.path.basename(cmd[0])} {os.path.basename(cmd[1]) if len(cmd) > 1 else ''} failed: {(r.stdout + r.stderr)[-1500:]}")
    return round(time.time() - a, 1), (r.stdout + r.stderr)


def home(W):
    """HL_HOME for the engine scripts: models/ and fonts/ from the store's assets, match/ in this job's work folder."""
    os.makedirs('/work', exist_ok=True); os.makedirs(f'{W}/match', exist_ok=True)
    for name, src in (('models', f'{ASSETS}/models'), ('fonts', f'{ASSETS}/fonts'), ('match', f'{W}/match')):
        p = f'/work/{name}'
        if os.path.islink(p): os.remove(p)
        os.symlink(src, p)
    return dict(os.environ, HL_HOME='/work', PYTHONDONTWRITEBYTECODE='1', U2NET_HOME=f'{ASSETS}/models/u2net/birefnet-general-lite')


def probe(path):
    out = subprocess.run(['ffprobe', '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height,r_frame_rate,color_transfer', '-of', 'json', path], capture_output=True, text=True).stdout
    s = json.loads(out)['streams'][0]; n, d = s['r_frame_rate'].split('/')
    return {'w': s['width'], 'h': s['height'], 'rate': s['r_frame_rate'], 'fps': float(n) / float(d), 'trc': s.get('color_transfer', '')}


def duration(path):
    return float(subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', path], capture_output=True, text=True).stdout.strip())


def paths(req):
    """The work folder, where the reel goes, where the names go, and where the clips are."""
    up = req.get('upload') or ''
    if req.get('dry'):
        root = '/vol/' + req.get('out', f"test/fastreel-{time.strftime('%Y-%m-%d')}").strip('/')
        return {'W': f'{root}/work', 'reels': f'{root}/reels', 'answer': f'{root}/names-answer.json', 'choices': f'{root}/choices.json',
                'video': '/vol/' + req['video'].lstrip('/') if req.get('video') else None, 'up': f'/vol/uploads/{up}' if up else None}
    video = None
    if req.get('video'): video = '/vol/' + req['video'].lstrip('/')
    elif up:
        d = f'/vol/uploads/{up}'; video = next((f'{d}/{n}' for n in sorted(os.listdir(d)) if n.startswith('video.')), None) if os.path.isdir(d) else None
    return {'W': f'/vol/work/fastreel/{up}', 'reels': '/vol/reels', 'answer': f'/vol/uploads/{up}/names-answer.json', 'choices': f'/vol/uploads/{up}/choices.json', 'video': video,
            'up': f'/vol/uploads/{up}' if up else None}


def choices_of(P, req):
    """The player's reel choices (uploads/<token>/choices.json, cleaned by serve.py): the team names, the crowd, the card of
    numbers, the track. No file: all on, and the request's track or "bounce". The player can change the file while the
    reel is made, so it is read at the start and again before the music."""
    c = dict(CHOICES, music=req.get('music') or 'bounce')
    try: got = json.load(open(P['choices']))
    except (OSError, ValueError): got = {}
    if isinstance(got, dict):
        if isinstance(got.get('teams'), list) and len(got['teams']) == 2: c['teams'] = [t if isinstance(t, str) and t.strip() else None for t in got['teams']]
        for k in ('crowd', 'numbers'):
            if isinstance(got.get(k), bool): c[k] = got[k]
        if isinstance(got.get('music'), str) and got['music'].replace('-', '').isalnum(): c['music'] = got['music']
    return c


def beat_of(path):
    """Where the beat of a track comes in (the largest rise of the level from one second to the next, between 1 s and
    20 s) and its tempo (the strongest repeat of the rises after it, 0.3 s to 1 s apart). On the first track this gives
    7.2 s and 100 a minute, the values measured by hand."""
    import numpy as np
    raw = subprocess.run(['ffmpeg', '-v', 'error', '-i', path, '-t', '60', '-ac', '1', '-ar', '8000', '-f', 's16le', '-'], capture_output=True).stdout
    x = np.frombuffer(raw, np.int16).astype(float) / 32768
    hop = 40; e = 20 * np.log10(np.sqrt(np.add.reduceat(x ** 2, np.arange(0, len(x), hop)) / hop) + 1e-6)    # 5 ms
    s = 200; rise = [(e[i:i + s].mean() - e[i - s:i].mean(), i) for i in range(s, min(len(e) - s, 4000))]
    drop = max(rise)[1] * 0.005 if rise else 0.0
    o = np.maximum(np.diff(e), 0)[int(drop / 0.005):int(drop / 0.005) + 5600]; o = o - o.mean()
    ac = np.correlate(o, o, 'full')[len(o) - 1:]
    # The strongest repeat from 0.5 s to 2.6 s is one, two, four or eight beats (two at 100 a minute on the first track:
    # 1.2 s); the shorter repeats are the off-beats. The tempo is the count of beats that lands nearest 110 a minute.
    lag = max(range(100, 520), key=lambda L: ac[L]) * 0.005
    bpm = min((60 * n / lag for n in (1, 2, 4, 8) if 80 <= 60 * n / lag <= 180), key=lambda b: abs(b - 110), default=100.0)
    return round(drop, 2), round(bpm, 1)


def track_of(name):
    """The file of a track on the store and music.py's settings for it; a track that is not there plays as "bounce"."""
    f = f'kicksmash-music-{name}.m4a'
    if name == 'bounce' or not os.path.exists(f'{ASSETS}/{f}'): return TRACKS['bounce']
    drop, bpm = beat_of(f'{ASSETS}/{f}')
    env = {'DROP': str(drop), 'BPM': str(bpm), 'BARS': '8'}
    if duration(f'{ASSETS}/{f}') > 120: env['SECTION'] = '8'       # a full-length track moves on one section at each hit
    return f, env


# ---------------------------------------------------------------- step functions

@app.function(image=sound_image, volumes={'/vol': vol}, cpu=2, memory=4096, timeout=1800)
def film_sound(video):
    """A whole film's stretches from its sound: the sound track alone (the demuxer skips the picture, so a 4K film of
    40 GB is not decoded), then film_plan.js, what the phone runs for a fast reel. Answers the plan: the stretches, and
    every point the sound found ("rallies"), the most the film can hold (honest.py)."""
    vol.reload(); a = time.time()
    rate = subprocess.run(['ffprobe', '-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=sample_rate', '-of', 'csv=p=0', video], capture_output=True, text=True).stdout.strip()
    if not rate.isdigit(): raise RuntimeError('the film has no sound: its stretches come from the sound')
    sh(['ffmpeg', '-v', 'error', '-nostdin', '-y', '-i', video, '-map', '0:a:0', '-vn', '-ac', '1', '-ar', rate, '-f', 'f32le', '/tmp/sound.raw'])
    read = round(time.time() - a, 1)
    t, log = sh(['node', '/root/hl/film_plan.js', '/tmp/sound.raw', rate, '/tmp/plan.json'])
    plan = json.load(open('/tmp/plan.json')); plan.update(read_s=read, plan_s=t); print(log.strip(), flush=True)
    return plan


@app.function(image=image, volumes={'/vol': vol}, cpu=8, memory=12288, timeout=1800, max_containers=16)
def film_stretch(job):
    """One stretch of a whole film, decoded from the camera file: a 4K piece, a 1080p piece, its sound (film_clips.py)."""
    import sys; sys.path.insert(0, '/root/hl'); import film_clips
    vol.reload(); r = film_clips.clean_stretch(*job); vol.commit()
    return r


@app.function(image=image, volumes={'/vol': vol}, cpu=4, memory=4096, timeout=1200)
def film_join(W, stretches, info, parts):
    """The pieces of a whole film into what the step "clips" writes (film_clips.py, as join_clean)."""
    import sys; sys.path.insert(0, '/root/hl'); import film_clips
    vol.reload(); r = film_clips.join(W, stretches, info, parts); vol.commit()
    return r


@app.function(image=image, volumes={'/vol': vol}, cpu=8, memory=4096, timeout=900)
def cuts(video):
    """The joins and the flash-backs of the phone's cut (fast_reel.py's detector, with FLASH_LEAD)."""
    import sys; sys.path.insert(0, '/root/hl'); import fast_reel
    vol.reload(); os.makedirs('/tmp/cuts', exist_ok=True)
    a = time.time(); fps, n, joins, flashes = fast_reel.joins_and_flashes(video, '/tmp/cuts')
    return {'fps': fps, 'frames': n, 'joins': joins, 'flashes': flashes, 'seconds': round(time.time() - a, 1)}


@app.function(image=image, volumes={'/vol': vol}, cpu=8, memory=12288, timeout=1800, max_containers=12)
def clean_part(job):
    """Frames [a, b) of the clips with the flash-backs out, the HDR curve turned into normal video, as a 4K piece and a
    1080p piece at half the frame rate. Every machine decodes from the start, so the frame numbers are those of the
    detector (a seek into an HEVC film after a join does not give the same pictures)."""
    video, a, b, drop, info, out4k, outp = job
    vol.reload()
    keep = f'between(n,{a},{b - 1})' + ''.join(f'*not(between(n,{x},{y - 1}))' for x, y in drop if x < b and y > a)
    tone = TONE.get(info['trc'], 'format=yuv420p')
    big = 'scale=3840:-2:flags=lanczos,' if info['w'] > 3840 else ''
    # The working copy takes every second picture of the piece, and each piece keeps an even number of pictures
    # (`make`), so the 4K file and the working copy keep one clock. The fps filter drifted 0.12 s in 180 s over ten pieces.
    from fractions import Fraction
    r = Fraction(info['rate']); halve = r > 40; r2 = r / 2 if halve else r
    half = (f"select='not(mod(n,2))'," if halve else '') + f'setpts=N/({r2.numerator}/{r2.denominator})/TB'
    graph = f"[0:v]select='{keep}',setpts=N/({info['rate']})/TB,{big}{tone},split=2[a][b];[b]scale=1920:-2:flags=lanczos,{half}[p]"
    t, _ = sh(['ffmpeg', '-v', 'error', '-nostdin', '-y', '-threads', '0', '-to', f"{(b / info['fps']) + 3:.3f}", '-i', video, '-filter_complex', graph,
               '-map', '[a]', '-r', info['rate'], '-c:v', 'libx264', '-preset', 'fast', '-crf', '16', '-g', '60', '-pix_fmt', 'yuv420p', *C709, '-an', '/tmp/p4k.mp4',
               '-map', '[p]', '-r', f'{r2.numerator}/{r2.denominator}', '-c:v', 'libx264', '-preset', 'fast', '-crf', '17', '-g', '30', '-pix_fmt', 'yuv420p', *C709, '-an', '/tmp/pp.mp4'])
    sh(['cp', '/tmp/p4k.mp4', out4k]); sh(['cp', '/tmp/pp.mp4', outp]); vol.commit()
    return t


@app.function(image=image, volumes={'/vol': vol}, cpu=4, memory=4096, timeout=1200)
def join_clean(W, video, parts, drop_s, info):
    """The pieces into clean4k.mp4 and proxy.mp4 with the sound (the flash-backs out of it too), and 3 frames a second."""
    vol.reload()
    sel = '+'.join(f'between(t,{x:.4f},{y:.4f})' for x, y in drop_s)
    af = (f"aselect='not({sel})',asetpts=N/SR/TB," if sel else '') + 'aresample=48000'
    t1, _ = sh(['ffmpeg', '-v', 'error', '-nostdin', '-y', '-i', video, '-vn', '-af', af, '-c:a', 'aac', '-b:a', '256k', '-ar', '48000', '/tmp/a.m4a'])
    for kind, name in (('4k', 'clean4k.mp4'), ('p', 'proxy.mp4')):
        with open(f'/tmp/{kind}.txt', 'w') as f:
            for p in parts: f.write(f"file '{p[kind]}'\n")
        sh(['ffmpeg', '-v', 'error', '-nostdin', '-y', '-f', 'concat', '-safe', '0', '-i', f'/tmp/{kind}.txt', '-i', '/tmp/a.m4a', '-map', '0:v', '-map', '1:a', '-c', 'copy', '-shortest',
            '-movflags', '+faststart', f'/tmp/{name}'])
        sh(['cp', f'/tmp/{name}', f'{W}/{name}'])
    # the two files keep one clock, and the working copy has 30 pictures a second (track.py counts on it): checked, not assumed
    d4, dp, fp = duration('/tmp/clean4k.mp4'), duration('/tmp/proxy.mp4'), probe('/tmp/proxy.mp4')['fps']
    if abs(d4 - dp) > 0.1 or not 29 < fp < 31: raise RuntimeError(f'clean file {d4:.2f} s, working copy {dp:.2f} s at {fp:.2f} a second')
    json.dump({'clean4k.mp4': {'start': 0.0}}, open(f'{W}/index.json', 'w'))     # render.py's HIRES: the 4K file and its start
    kf = f'{W}/match/kf'; os.makedirs(kf, exist_ok=True)
    # About 3 a second: every 10th picture of the working copy, so the time of each is exact (the fps filter's pictures
    # were 0.17 to 0.25 s from their listed time, and a portrait taken from the 4K file at that time missed its player)
    pf = probe('/tmp/proxy.mp4')['fps']
    sh(['ffmpeg', '-v', 'error', '-nostdin', '-y', '-i', '/tmp/proxy.mp4', '-vf', "select='not(mod(n,10))'", '-fps_mode', 'passthrough', '-q:v', '2', f'{kf}/%06d.jpg'])
    n = len([x for x in os.listdir(kf) if x.endswith('.jpg')])
    open(f'{W}/match/kf_times.txt', 'w').write(''.join(f'{i * 10 / pf:.3f}\n' for i in range(n)))
    vol.commit()
    return {'frames3': n, 'seconds': round(duration(f'{W}/proxy.mp4'), 2)}


@app.function(image=who_image, volumes={'/vol': vol}, cpu=16, memory=16384, timeout=1800)
def players(W, req, answer):
    """People in each frame (run_det.py, cands.py, feat2.py, feat.py), then who is who (who.py)."""
    vol.reload(); env = home(W); M = f'{W}/match'; H = '/root/hl'; times = {}
    if not os.path.exists(f'{M}/feat-dino.npz'):
        # the detector uses 4 threads (det.py): four of them on four quarters of the frames, then one list in frame order
        a = time.time(); frames = sorted(x for x in os.listdir(f'{M}/kf') if x.endswith('.jpg')); procs = []
        for q in range(4):
            d = f'/tmp/kf{q}'; os.makedirs(d, exist_ok=True)
            for x in frames[q::4]: os.symlink(f'{M}/kf/{x}', f'{d}/{x}') if not os.path.exists(f'{d}/{x}') else None
            procs.append(subprocess.Popen(['python', '-u', f'{H}/run_det.py', d, f'/tmp/dets{q}.jsonl'], env=env, stdout=subprocess.DEVNULL, stderr=open(f'/tmp/det{q}.log', 'w')))
        for q, pr in enumerate(procs):
            if pr.wait() != 0: raise RuntimeError('run_det.py failed: ' + open(f'/tmp/det{q}.log').read()[-800:])
        rows = [l for q in range(4) for l in open(f'/tmp/dets{q}.jsonl') if l.strip()]
        open(f'{M}/dets.jsonl', 'w').write(''.join(sorted(rows, key=lambda l: json.loads(l)['f'])))
        times['people'] = round(time.time() - a)
        for name, cmd in (('on_court', ['cands.py', f'{M}/dets.jsonl', f'{M}/keep.json']),
                          ('pose_colours', ['feat2.py', f'{M}/kf', f'{M}/dets.jsonl', f'{M}/feat2.npz', f'{M}/keep.json']),
                          ('look', ['feat.py', f'{M}/kf', f'{M}/dets.jsonl', f'{M}/feat-dino.npz', f'{M}/keep.json'])):
            times[name], _ = sh(['python', '-u', f'{H}/{cmd[0]}', *cmd[1:]], env=env)
        vol.commit()
    json.dump(req, open(f'{M}/request.json', 'w'))
    gal = '/vol/gallery/faces.json'          # face templates of players (gallery.py); never in the repository
    times['who'], log = sh(['python', '-u', f'{H}/who.py', f'{M}/request.json', answer], env=dict(env, GALLERY=gal, CLEAN=f'{W}/clean4k.mp4'))
    vol.commit()
    return {'who': json.load(open(f'{M}/who.json')), 'times': times, 'log': '\n'.join(l for l in log.splitlines() if not l.startswith('[ WARN'))[-2500:]}


@app.function(image=image, volumes={'/vol': vol}, cpu=4, memory=8192, timeout=1800, max_containers=16)
def follow(job):
    """One clip through track.py, with the ident files of its match."""
    W, n, a, b, m = job
    vol.reload(); env = home(W); M = f'{W}/match'; out = f'{M}/tracks/c{n}.json'
    os.makedirs(f'{M}/tracks', exist_ok=True)
    t, log = sh(['python', '-u', '/root/hl/track.py', f'{W}/proxy.mp4', f'{M}/ident-m{m}', f'{a + 0.05:.2f}', f'{b - 0.05:.2f}', '/tmp/t.json'], env=env)
    sh(['cp', '/tmp/t.json', out]); vol.commit()
    return n, t, log.strip().splitlines()[-1] if log.strip() else ''


@app.function(image=image, volumes={'/vol': vol}, cpu=4, memory=8192, timeout=1800, max_containers=16)
def ball(job):
    """One clip through ball.py and balllink.py: the flights of the ball, so the plan can see where play starts.
    A phone hears players who wait as hits; the ball does not fly while they wait (fast_points.py, after_idle)."""
    W, n, a, b = job
    vol.reload(); M = f'{W}/match'; os.makedirs(f'{M}/ball', exist_ok=True)
    t, _ = sh(['python', '-u', '/root/hl/ball.py', f'{W}/proxy.mp4', f'{a:.3f}', f'{b:.3f}', '/tmp/b.npz'])
    sh(['python', '-u', '/root/hl/balllink.py', '/tmp/b.npz', '/tmp/bl.npz'])
    sh(['cp', '/tmp/bl.npz', f'{M}/ball/c{n}.npz']); vol.commit()
    return n, t


@app.function(image=image, volumes={'/vol': vol}, cpu=8, memory=8192, timeout=1800)
def openings(work: str, matches: str, scale: int = 2, grade: str = 'glass'):
    """The portrait of each player (portrait.py, once for all openings), then each opening on its own machine.
    work: the work folder; matches: the matches that get an opening, "1,2". Runs beside `follow`. Alone:
    modal run fastreel.py::openings --work /vol/<work folder> --matches 1,2."""
    W = work
    vol.reload(); env = home(W); M = f'{W}/match'
    idents = sorted(f'{M}/{x}' for x in os.listdir(M) if x.startswith('ident-m') and x.endswith('.json') and x[7:-5].isdigit())
    t, log = sh(['python', '-u', '/root/hl/portrait.py', M, f'{W}/clean4k.mp4', f'{M}/portraits.json', *idents], env=dict(env, PORTRAIT_FALLBACK=f'{M}/faces-chosen.json'))
    vol.commit()
    done = list(opening.map([(W, int(m), tall, scale, grade) for m in matches.split(',') if m for tall in (False, True)]))
    return {'portraits': t, 'log': [l for l in log.splitlines() if l.startswith('portrait')], 'openings': done}


@app.function(image=image, volumes={'/vol': vol}, cpu=8, memory=16384, timeout=1800, max_containers=8)
def opening(job):
    """One opening (versus.py) for one match and one layout, in 4K, with the voice; the portraits of portrait.py."""
    W, m, tall, scale, grade = job
    vol.reload(); env = home(W); M = f'{W}/match'
    kf4k = f'{M}/kf4k'; os.makedirs(kf4k, exist_ok=True)
    F = json.load(open(f'{M}/portraits.json')); T = [float(x) for x in open(f'{M}/kf_times.txt')]
    for lst in F.values():
        for o in lst[:1]:
            p = f"{kf4k}/{o['f']}"
            if not o.get('hi') and not os.path.exists(p):      # a choice of faces.py: its 4K frame
                sh(['ffmpeg', '-v', 'error', '-nostdin', '-y', '-ss', f"{T[int(o['f'][:6]) - 1]:.3f}", '-i', f'{W}/clean4k.mp4', '-frames:v', '1', '-q:v', '2', p])
    env.update(CUTOUT='birefnet-general-lite', KF4K=kf4k, SCALE=str(scale))
    if grade: env['GRADE'] = grade
    if tall: env['TALL'] = '1'
    out = f"{M}/versus-m{m}-{'tall' if tall else 'wide'}.mp4"
    t, log = sh(['python', '/root/hl/versus.py', f'{M}/match-{m}.json', f'{M}/portraits.json', f'{M}/kf', '/tmp/v.mp4'], env=env)
    sh(['cp', '/tmp/v.mp4', out]); vol.commit()
    return m, tall, t, [l for l in log.splitlines() if l.startswith(('portrait', 'voice', 'wrote'))]


@app.function(image=image, volumes={'/vol': vol}, cpu=8, memory=16384, timeout=1800, max_containers=30)
def render_part(job):
    """One part of the reel (render.py), from the 4K clean file."""
    W, seg, tall, scale = job
    vol.reload(); env = home(W); out = seg[:-5] + '.mp4'
    env.update(SCALE=str(scale), HIRES=W, CACHE='/tmp/cache', COUNTER='0')
    if tall: env.update(TALL='1', TALL_FOLLOW='1')
    t, log = sh(['python', '-u', '/root/hl/render.py', f'{W}/proxy.mp4', seg, '/tmp/part.mp4'], env=env)
    sh(['cp', '/tmp/part.mp4', out]); vol.commit()
    return os.path.basename(out), t


@app.function(image=image, volumes={'/vol': vol}, cpu=8, memory=8192, timeout=1800, max_containers=2)
def finish_layout(job):
    """One layout: the parts joined (reel_points.py), the crowd, the level, the music, then 1080p. The tall layout also
    makes share.mp4, the public version (share.py): the pictures of tall.mp4 before the end card, copied and not encoded
    again, over the sound of the join (the match sound only), whatever music and crowd the player chose."""
    W, tall, music, crowd, scale = job
    vol.reload(); env = home(W); M = f'{W}/match'; H = '/root/hl'; k = 'tall' if tall else 'wide'
    work = f"{M}/{'reel-tall' if tall else 'reel'}"; times = {}
    env.update(SCALE=str(scale), HIRES=W, VERSUS=f'{M}/versus-m1', CHEER_AT='slowmo', COUNTER='0')
    if tall: env.update(TALL='1', TALL_FOLLOW='1')
    # Every part was drawn by this job from the plan beside it; the code in the image can carry a newer time than the
    # part, and reel_points.py would then draw every part again on this one machine.
    now = time.time()
    for f in os.listdir(work):
        if f.endswith('.mp4'): os.utime(f'{work}/{f}', (now, now))
    times['join'], _ = sh(['python', f'{H}/reel_points.py', f'{W}/proxy.mp4', f'{M}/points.json', f'{M}/match-1.json', work, f'/tmp/{k}.mp4'], env=env)
    join = f'/tmp/{k}.mp4'          # the parts with their own sound: the sound of share.mp4
    if crowd: times['crowd'], _ = sh(['python', f'{H}/cheers.py', join, work, f'{M}/points.json', f'{ASSETS}/cheers', f'/tmp/{k}-c.mp4'], env=env)
    else: os.replace(join, f'/tmp/{k}-c.mp4'); join = f'/tmp/{k}-c.mp4'         # the player chose no crowd: the match sound only
    times['level'], _ = sh(['ffmpeg', '-v', 'error', '-nostdin', '-y', '-i', f'/tmp/{k}-c.mp4', '-c:v', 'copy', '-af', 'loudnorm=I=-16:TP=-1.5:LRA=11', '-ar', '48000', '-c:a', 'aac', '-b:a', '192k',
                            '-movflags', '+faststart', f'/tmp/{k}-n.mp4'])
    src = f'/tmp/{k}-n.mp4'
    if music != 'none':
        name, menv = track_of(music); times['track'] = [name, menv]
        times['music'], _ = sh(['python', f'{H}/music.py', src, work, f'{M}/points.json', f'{ASSETS}/{name}', f'/tmp/{k}-m.mp4'], env=dict(env, **menv))
        src = f'/tmp/{k}-m.mp4'
    size = '1080:1920' if tall else '1920:1080'
    enc = ['-vf', f'scale={size}:flags=lanczos', '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-pix_fmt', 'yuv420p', *C709]
    keys = []
    if tall:
        import sys; sys.path.insert(0, H); import share
        if os.path.exists(f'{W}/share.mp4'): os.remove(f'{W}/share.mp4')      # a share.mp4 of an earlier run never passes for this one
        keys = share.key_args(share.body(work)[0])      # the first picture of the end card: a key frame
    times['1080p'], _ = sh(['ffmpeg', '-v', 'error', '-nostdin', '-y', '-i', src, *enc, *keys, '-c:a', 'copy', '-movflags', '+faststart', f'/tmp/{k}-1080.mp4'])
    out = f'{W}/{k}.mp4'; sh(['cp', f'/tmp/{k}-1080.mp4', out])
    if tall:
        sheet(out, f'{W}/sheet-tall.jpg')
        # The public version. When it fails, tall.mp4 and wide.mp4 still go out; reel.json then says "share": false,
        # and the daily post skips the reel ("no public version").
        a = time.time()
        try:
            how, secs = share.cut(work, join, f'/tmp/{k}-1080.mp4', '/tmp/share.mp4', enc)
            sh(['cp', '/tmp/share.mp4', f'{W}/share.mp4']); times['share'] = [how, secs, round(time.time() - a, 1)]
        except Exception as e:
            times['share'] = f'failed: {str(e)[-300:]}'; print('share.mp4', times['share'], flush=True)
    vol.commit()
    return k, times, round(duration(out), 2)


def sheet(video, out, step=3.0):
    """One frame every 3 s of a finished reel on one sheet, to look at (as the person's sheet of 24 November)."""
    import numpy as np, cv2
    w, h = (480, 270) if 'wide' in os.path.basename(video) else (270, 480); cols = 8 if w > h else 12
    raw = subprocess.run(['ffmpeg', '-v', 'error', '-i', video, '-vf', f'fps=1/{step},scale={w}:{h}', '-f', 'rawvideo', '-pix_fmt', 'bgr24', '-'], capture_output=True).stdout
    fr = np.frombuffer(raw, np.uint8).reshape(-1, h, w, 3).copy()
    for i, f in enumerate(fr): cv2.putText(f, f'{i * step + step / 2:.1f}s', (4, h - 8), 0, 0.55, (255, 255, 255), 2)
    t = list(fr)
    while len(t) % cols: t.append(np.zeros_like(t[0]))
    cv2.imwrite(out, np.vstack([np.hstack(t[i:i + cols]) for i in range(0, len(t), cols)]), [cv2.IMWRITE_JPEG_QUALITY, 82])


# ---------------------------------------------------------------- the job

class Report:
    """Progress for each match of the upload: a POST to Kicksmash, or a line on stdout in a dry run."""

    def __init__(self, req, total_min):
        self.req, self.t0, self.total = req, time.time(), total_min

    def post(self, body):
        if self.req.get('dry'):
            print('POST /api/reel/report', json.dumps({k: v for k, v in body.items() if k != 'token'} | ({'token': '<new token>'} if 'token' in body else {})), flush=True); return 'dry'
        import urllib.request
        req = urllib.request.Request(os.environ['KICKSMASH_URL'].rstrip('/') + '/api/reel/report', data=json.dumps(body).encode(), method='POST',
                                     headers={'Authorization': f"Bearer {self.req.get('report', '')}", 'Content-Type': 'application/json'})
        what = 'failed' if 'failed' in body else 'progress ' + str(body['progress'].get('step')) if 'progress' in body else 'reel'
        try:
            with urllib.request.urlopen(req, timeout=20) as r: got = r.status
        except Exception as e:      # a progress line that does not arrive stops nothing, but the log says so
            got = f'failed: {str(e)[:120]}'
        print('POST', body.get('code'), what, '->', got, flush=True)
        return got

    def fail(self, why):
        for m in self.req.get('matches', []): self.post({'code': m['code'], 'failed': why})

    def step(self, step, waiting=None, pct=None):
        pct = pct or DONE[step]; spent = (time.time() - self.t0) / 60
        left = 0 if waiting or pct >= 100 else max(1, round(max(self.total - spent, spent * (100 - pct) / max(pct, 1))))
        for m in self.req['matches']:
            progress = {'pct': pct, 'minutesLeft': left, 'step': step}
            # the page reads names.json and the faces from the reel host while the job waits
            if waiting: progress.update(waiting=waiting, host=os.environ['REELS_HOST'], upload=self.req['upload'])
            self.post({'code': m['code'], 'progress': progress})
        print(f'STEP {step} {pct}% after {spent:.1f} min', flush=True)


def teams_from_zero(req):
    """The engine counts the two teams 0 and 1. Kicksmash sends 1 and 2 (`fastReelStart`), a person may write "a" and
    "b": each becomes 0 and 1, in place. On 25 November 2026 the first real start sent 1 and 2, team 0 was empty, and
    the opening and the tracker failed. Pure but for the change in place."""
    for m in req.get('matches', []):
        seen = sorted({str(p.get('team')).lower() for p in m.get('players', [])})
        to = {seen[0]: 0, seen[1]: 1} if len(seen) == 2 else {}
        for p in m.get('players', []): p['team'] = to.get(str(p.get('team')).lower(), p.get('team'))
    return req


@app.function(image=image, volumes={'/vol': vol}, secrets=SECRETS, cpu=1, memory=2048, timeout=5400)
def make(req):
    """The whole fast reel (`run_make`). A step that fails tells Kicksmash, for each match of the upload, before the
    error goes on: the page then says the reel did not work, and the note desk looks at why (25 November 2026: the
    first real start failed, and the page waited for a reel that never came)."""
    try:
        return run_make(req)
    except Exception as e:
        Report(req, 0).fail(f'{type(e).__name__}: {str(e)[-240:]}')
        raise


def whole_film(P, W, M, R):
    """The step "clips" for a whole film: the stretches from its sound (`film_sound`, kept in match/film-plan.json, so a
    second run reads no sound again), then each stretch decoded from the camera file on its own machine, then one join."""
    import sys; sys.path.insert(0, '/root/hl'); import film_clips
    a = time.time(); fp = f'{M}/film-plan.json'
    plan = json.load(open(fp)) if os.path.exists(fp) else film_sound.remote(P['video'])
    json.dump(plan, open(fp, 'w')); vol.commit()
    try: S = film_clips.checked(plan['stretches'])
    except ValueError: raise RuntimeError(f"the sound of the film gave no stretch to make a reel of ({plan.get('rallies')} points heard)")
    print('film:', plan.get('rallies'), 'points heard,', len(S), 'stretches,', round(sum(b - a_ for a_, b in S)), 's', flush=True)
    R.step('clips', pct=6)
    info = probe(P['video']); sound = round(time.time() - a)
    parts = sorted(film_stretch.map([(P['video'], i, s, e, info, W) for i, (s, e) in enumerate(S)]), key=lambda p: p['i'])
    j = film_join.remote(W, S, info, parts)
    vol.reload()
    return {'sound': sound, 'read_s': plan.get('read_s'), 'rallies': plan.get('rallies'), 'stretches': len(S), 'parts': [p['seconds'] for p in parts], 'join': {k: j[k] for k in ('clean4k', 'proxy', 'frames3')}}


def run_make(req):
    """The whole fast reel. Each step skips what is already on the store, so `resume` goes on where it stopped."""
    t0 = time.time(); vol.reload(); P = paths(req); W = P['W']; M = f'{W}/match'; os.makedirs(M, exist_ok=True)
    if not P['video'] or not os.path.exists(P['video']): raise RuntimeError('no clips for this request')
    teams_from_zero(req)
    json.dump(req, open(f'{W}/request.json', 'w')); vol.commit()
    whole = bool(req.get('whole'))         # the whole film, not a phone's cut: its stretches come from its sound
    clock = {}; R = Report(req, 30 if whole else 25)
    CH = choices_of(P, req); clock['choices_start'] = CH
    for i, t in enumerate(CH['teams']):       # the team names the player chose are for the upload's own match, the first
        if t: req['matches'][0]['title_a' if i == 0 else 'title_b'] = t
    # the camera place: the request's court, or the store's court of the place (court.py; README "court lines")
    court = req.get('court') or (json.load(open(f"/vol/courts/{req['place']}.json")) if req.get('place') and os.path.exists(f"/vol/courts/{req['place']}.json") else None)
    if not court and not os.path.exists(f'{M}/court.json'): raise RuntimeError('no court lines for this camera place: put courts/<place>.json on the store')
    if court: json.dump(court, open(f'{M}/court.json', 'w'))

    # 1. clips
    a = time.time()
    if whole and not (os.path.exists(f'{W}/clean4k.mp4') and os.path.exists(f'{M}/stretches.json')):
        clock['film'] = whole_film(P, W, M, R)
    elif not (os.path.exists(f'{W}/clean4k.mp4') and os.path.exists(f'{M}/stretches.json')):
        info = probe(P['video']); c = cuts.remote(P['video']); fps = c['fps']
        drop = c['flashes']; n = c['frames']; joins = c['joins']
        k = max(4, min(12, math.ceil(n / 1200)))                     # about 20 s of 4K for each machine
        edges = [round(i * n / k) for i in range(k + 1)]
        kept = lambda a_, b_: (b_ - a_) - sum(max(0, min(y, b_) - max(x, a_)) for x, y in drop)
        for i in range(1, k):        # an even number of kept pictures in each piece: the working copy takes every second one
            if kept(edges[i - 1], edges[i]) % 2: edges[i] += 1
        jobs = [(P['video'], edges[i], edges[i + 1], drop, info, f'{W}/parts/v4k-{i:02d}.mp4', f'{W}/parts/vp-{i:02d}.mp4') for i in range(k)]
        os.makedirs(f'{W}/parts', exist_ok=True); vol.commit()
        clock['clean_parts'] = list(clean_part.map(jobs))
        vol.reload()
        drop_s = [(x / fps, y / fps) for x, y in drop]
        j = join_clean.remote(W, P['video'], [{'4k': x[5], 'p': x[6]} for x in jobs], drop_s, info)
        vol.reload()
        gone = lambda f: sum(min(y, f) - x for x, y in drop if x < f)        # frames cut before frame f
        cutsec = [0.0] + [(jn - gone(jn)) / fps for jn in joins] + [j['seconds']]
        json.dump({'stretches': [[round(cutsec[i], 3), round(cutsec[i + 1], 3)] for i in range(len(cutsec) - 1)], 'joins_raw': joins, 'flashes_raw': drop, 'fps': fps,
                   'scale': 2 if info['h'] >= 2000 or info['w'] >= 3000 else 1}, open(f'{M}/stretches.json', 'w'))
        vol.commit(); print('clips:', len(joins) + 1, 'clips,', len(drop), 'flash-backs cut,', j, flush=True)
    clock['clips'] = round(time.time() - a); R.step('clips')

    # 2. players
    a = time.time(); ans = P['answer'] if os.path.exists(P['answer']) else ''
    w = players.remote(W, req, ans); print(w['log'], flush=True); clock['players'] = round(time.time() - a); clock['players_parts'] = w['times']
    vol.reload()
    if w['who']['state'] != 'sure':
        up = req.get('upload') or 'test'; d = f"{P['reels']}/{up}"; os.makedirs(d, exist_ok=True)
        for f in os.listdir(f'{M}/names'): sh(['cp', f'{M}/names/{f}', f'{d}/{f}'])
        vol.commit(); R.step('players', waiting='names')
        return {'state': 'names', 'names': f'{d}/names.json', 'clock': clock}
    R.step('players')
    ST = json.load(open(f'{M}/stretches.json')); scale = ST.get('scale', 2); C = json.load(open(f'{M}/clips.json'))['clips']
    nm = len(req['matches'])

    # 3. follow, with the openings beside it
    a = time.time()
    ops = openings.spawn(W, ','.join(str(m) for m in range(1, nm + 1) if any(c['match'] == m for c in C)), scale, req.get('grade', 'glass'))
    jobs = [(W, n, c['a'], c['b'], c['match']) for n, c in enumerate(C)
            if not os.path.exists(f'{M}/tracks/c{n}.json') or os.path.getmtime(f'{M}/tracks/c{n}.json') < os.path.getmtime(f"{M}/ident-m{c['match']}.json")]
    balls = [ball.spawn((W, n, c['a'], c['b'])) for n, c in enumerate(C) if not os.path.exists(f'{M}/ball/c{n}.npz')]
    clock['follow_parts'] = [(n, t) for n, t, _ in follow.map(jobs)] if jobs else []
    clock['ball_parts'] = [h.get() for h in balls]
    vol.reload(); clock['follow'] = round(time.time() - a); R.step('follow')

    # 4. replays: the plan, then every part
    a = time.time(); env = home(W)
    env.update(CHEERS=f'{ASSETS}/cheers', ENDCARD=f'{ASSETS}/endcard/feedback.png')
    if P.get('up') and os.path.isdir(P['up']): env['UPLOAD_DIR'] = P['up']      # meta.json (clip times), hr.json (a watch)
    sh(['python', '/root/hl/fast_points.py', f'{W}/proxy.mp4', f'{M}/request.json', f'{M}/points.json'], env=env)
    if not CH['numbers']:       # the card of numbers (reel_points.py "card"): fast_points.py writes none yet, and none goes in
        pts = json.load(open(f'{M}/points.json')); pts.pop('card', None); json.dump(pts, open(f'{M}/points.json', 'w'), indent=1)
    score = None
    if whole:       # a score, a winner of each point and numbers only when the engine is sure (honest.py)
        import sys; sys.path.insert(0, '/root/hl'); import honest
        # the points the sound heard; none counted when a person chose the stretches (fullclips.py by hand)
        found = json.load(open(f'{M}/film-plan.json')).get('rallies') if os.path.exists(f'{M}/film-plan.json') else None
        shown, why, need = honest.verdict([m.get('score') for m in req['matches']], found)
        score = {'shown': shown, 'why': why, 'found': found, 'need': need}
        if not shown:
            pts = json.load(open(f'{M}/points.json')); score['stripped'] = honest.strip(pts); json.dump(pts, open(f'{M}/points.json', 'w'), indent=1)
        json.dump(score, open(f'{M}/score.json', 'w')); clock['score'] = score; print('score', score, flush=True)
    # What the reel could not do, and why (missing.py): codes only; the match page has the words and a tip for each.
    import sys; sys.path.insert(0, '/root/hl'); import missing
    heart = bool(P.get('up')) and os.path.exists(f"{P['up']}/hr.json")
    gaps = missing.missing_of(whole, score, json.load(open(f'{M}/points.json')), C, heart)
    clock['missing'] = gaps; print('missing', gaps, flush=True)
    op = ops.get(); clock['portraits'] = op['portraits']; print('\n'.join(op['log']), flush=True)
    for o in op['openings']: print('opening', o, flush=True)     # reel_points.py puts the opening in only when its files are there
    vol.reload(); clock['opening_wait'] = round(time.time() - a)
    segs = []
    for tall in (False, True):
        e = dict(env, SCALE=str(scale), HIRES=W, VERSUS=f'{M}/versus-m1', COUNTER='0', **({'TALL': '1', 'TALL_FOLLOW': '1'} if tall else {}))
        work = f"{M}/{'reel-tall' if tall else 'reel'}"
        _, log = sh(['python', '/root/hl/reel_points.py', f'{W}/proxy.mp4', f'{M}/points.json', f'{M}/match-1.json', work, '/tmp/x.mp4', 'plan'], env=e)
        names = [l.strip() for l in log.splitlines() if l.startswith('  ') and l.strip().endswith('.json')]
        segs += [(W, f'{work}/{s}', tall, scale) for s in names]
    vol.commit()
    clock['render_parts'] = list(render_part.map(segs))
    vol.reload(); clock['replays'] = round(time.time() - a); R.step('replays'); R.step('opening')

    # 5. music: both layouts on two machines
    a = time.time(); vol.reload(); CH = choices_of(P, req); clock['choices_music'] = CH      # the player may have changed the track meanwhile
    clock['finish_parts'] = list(finish_layout.map([(W, False, CH['music'], CH['crowd'], scale), (W, True, CH['music'], CH['crowd'], scale)]))
    vol.reload(); clock['music'] = round(time.time() - a); R.step('music')

    # 6. finish: the files under a new token, then the match pages. "finish" goes BEFORE the reel's address: a progress
    # line takes a shown reel off the page (`setReelProgress`), so on 25 November 2026 the job's own last "100%" hid the
    # reel it had just published, and the page said "being made" for good.
    R.step('finish')
    token = pysecrets.token_urlsafe(24); d = f"{P['reels']}/{token}"; os.makedirs(d, exist_ok=True)
    sh(['cp', f'{W}/wide.mp4', f'{d}/wide.mp4']); sh(['cp', f'{W}/tall.mp4', f'{d}/tall.mp4'])
    # share.mp4, the public version for TikTok and @kicksma.sh (finish_layout, share.py): only from this run
    share = os.path.exists(f'{W}/share.mp4')
    if share: sh(['cp', f'{W}/share.mp4', f'{d}/share.mp4'])
    sh(['ffmpeg', '-v', 'error', '-nostdin', '-y', '-ss', '4.6', '-i', f'{M}/versus-m1-wide.mp4', '-frames:v', '1', '-vf', 'scale=1200:-2:flags=lanczos,crop=1200:630', '-q:v', '3', f'{d}/versus.jpg'])
    # The tall reel's poster on the match page: the same moment of the opening, both teams on it, so the page shows a
    # picture and not a black box before the reel plays (the owner, 25 November 2026).
    sh(['ffmpeg', '-v', 'error', '-nostdin', '-y', '-ss', '4.6', '-i', f'{M}/versus-m1-tall.mp4', '-frames:v', '1', '-vf', 'scale=720:-2:flags=lanczos', '-q:v', '3', f'{d}/poster.jpg'])
    # Which matches the reel is of, for the post to @kicksma.sh (scripts/social/instagram.py): the reel host serves
    # only .mp4, .jpg and names.json, so this file stays on the store.
    # A whole film's reel says whether it has a score, and why not (honest.py); every reel says what it could not do
    # (missing.py), and the match page says it in the fold "What this reel could not do".
    json.dump({'made': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()), 'upload': req.get('upload'), 'share': share, 'whole': whole,
               **({'score': {k: score[k] for k in ('shown', 'why', 'found', 'need')}} if score else {}), 'missing': gaps,
               'matches': [{k: m.get(k) for k in ('code', 'title_a', 'title_b', 'score')} for m in req['matches']]}, open(f'{d}/reel.json', 'w'), indent=1)
    vol.commit()
    clock['all'] = round(time.time() - t0)
    no_score = {'noScore': score['why']} if score and not score['shown'] else {}
    for m in req['matches']: R.post({'code': m['code'], 'host': os.environ['REELS_HOST'], 'token': token, **no_score, 'missing': gaps})
    if req.get('dry'): json.dump({'clock': clock, 'reel': d}, open(f'{W}/clock.json', 'w'), indent=1); vol.commit()
    return {'state': 'ready', 'reel': d if req.get('dry') else f'reels/{token}', 'clock': clock}


@app.function(image=image, volumes={'/vol': vol}, secrets=SECRETS, cpu=0.25, memory=512, timeout=3600)
def resume(upload: str, names: dict):
    """The players answered names.json (serve.py, POST /u/<token>/names, checked there): keep the answer beside the
    upload and go on from "players"; the steps before it are on the store and are not made again."""
    vol.reload()
    json.dump({'names': names, 'at': int(time.time())}, open(f'/vol/uploads/{upload}/names-answer.json', 'w')); vol.commit()
    return make.remote(json.load(open(f'/vol/work/fastreel/{upload}/request.json')))


@app.local_entrypoint()
def main(request: str, dry: bool = False):
    req = json.load(open(request))
    if dry: req['dry'] = True
    if not req.get('dry') and not req.get('report'): raise SystemExit('a run that posts needs the request\'s "report" key')
    a = time.time(); res = make.remote(req)
    print(json.dumps(res, indent=1)); print(f'WALL {round(time.time() - a)} s')
