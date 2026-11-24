"""
The fast reel from a phone's clips: the steps a person did by hand on 24 November 2026, as one script, so
the note desk (or anyone) makes it in minutes instead of improvising.

  python fast_reel.py --upload uploads/<dir> --codes AB12,CD34 --card card.json [--music track.m4a] [--work DIR]

`--upload` is the folder on the Modal volume `kicksmash-matches` (newest finished meta.json under
uploads/); `--codes` the match pages that show the reel; `--card` the opening card, a JSON list of
[text, weight, size, colour] lines (weights r, s, b, x; colours ink, muted, lime). The Modal token and
CRON_SECRET come from the environment and are never printed; neither is the reel's own token.

What the steps are, and why:
1. The clips. The phone joined its stretches without decoding, and an HEVC film joined that way shows
   flash-backs: 0.3 to 0.8 s of the previous stretch, a few seconds after a join (ffmpeg: "Duplicate
   POC"). A join is a jump in the picture; a flash is two jumps less than 1.5 s apart where the frame
   after the second matches the frame before the first. Flashes are cut out.
2. The pieces. Each stretch longer than 16 s keeps 14 s: the window that holds its loudest moment, as
   late as it can (the reaction comes after the point).
3. The replay. The loudest moment of all, 3 s before to 1 s after, at half speed (the clips are 60 fps).
4. Cards, music under the court sound (ducked while players speak or hit), a wide file and a tall one
   (the court in the middle over a blurred copy of itself).
5. Both files go to reels/<new token>/ and every code gets the reel through /api/admin/match-reel.
"""
import argparse, json, os, secrets, subprocess, sys
import numpy as np
from PIL import Image, ImageDraw, ImageFont

FPS_OUT = 30
HERE = os.path.dirname(os.path.abspath(__file__))
FONT = '/usr/share/fonts/opentype/inter/'
COLOURS = {'ink': (245, 245, 247), 'muted': (152, 152, 158), 'lime': (200, 241, 53)}
BG = (12, 12, 14)


def run(cmd, **kw):
    return subprocess.run(cmd, check=True, **kw)


def ff(*args):
    run(['ffmpeg', '-nostdin', '-v', 'error', '-y', *args])


def duration(f):
    return float(subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f], capture_output=True, text=True).stdout)


def modal(*args):
    # Modal's own output can carry ids; nothing of it is printed.
    return subprocess.run([os.environ.get('MODAL_BIN', 'modal'), *args], check=True, capture_output=True, text=True)


def joins_and_flashes(clips, work, keep=False):
    small = os.path.join(work, 'small.gray')
    if not (keep and os.path.exists(small)):
        ff('-threads', '0', '-i', clips, '-vf', 'scale=96:54:flags=area,format=gray', '-f', 'rawvideo', small)
    a = np.fromfile(small, dtype=np.uint8).reshape(-1, 54, 96).astype(np.float32)
    if not keep:
        os.remove(small)
    fps = len(a) / duration(clips)
    d = np.abs(np.diff(a, axis=0)).mean(axis=(1, 2))
    med = float(np.median(d))
    jumps = []
    for i in range(len(d)):
        lo, hi = max(0, i - 30), min(len(d), i + 31)
        local = float(np.median(np.r_[d[lo:i], d[i + 1:hi]]))
        if d[i] > max(4 * local, 4 * med, 2.0):
            jumps.append(i + 1)
    # A flash (x, y): the picture after it is the picture before it, moved on a little.
    def flash(x, y):
        return y - x < 1.5 * fps and np.abs(a[x - 1] - a[y]).mean() < 0.7 * np.abs(a[x - 1] - a[x]).mean()
    flashes, joins, i = [], [], 0
    while i < len(jumps):
        x = jumps[i]
        y = jumps[i + 1] if i + 1 < len(jumps) else None
        z = jumps[i + 2] if i + 2 < len(jumps) else None
        if y is not None and z is not None and flash(y, z) and z - x < 2.5 * fps:
            # a join, then a flash of the stretch before it: (y, z) is the flash, x the join
            joins.append(x); flashes.append((y, z)); i += 3
        elif y is not None and flash(x, y):
            flashes.append((x, y)); i += 2
        else:
            joins.append(x); i += 1
    return fps, len(a), joins, flashes


def loudness(clips, work):
    raw = os.path.join(work, 'a.raw')
    ff('-i', clips, '-vn', '-ac', '1', '-ar', '16000', '-f', 's16le', raw)
    x = np.fromfile(raw, dtype=np.int16).astype(np.float32) / 32768
    os.remove(raw)
    w = 1600
    r = np.sqrt(np.convolve(x ** 2, np.ones(w) / w, 'valid')[::w] + 1e-12)
    return 20 * np.log10(r)  # one value each 0.1 s


def plan(fps, n, joins, flashes, db):
    cuts = [0, *joins, n]
    pieces = []
    for s, e in zip(cuts, cuts[1:]):
        t0, t1 = s / fps, e / fps
        if t1 - t0 > 16:
            seg = db[int(t0 * 10):int(t1 * 10)]
            peak = t0 + int(np.argmax(seg)) / 10
            start = max(t0, min(peak - 4, t1 - 14))
            t0, t1 = start, start + 14
        # a flash inside the piece splits it in two
        parts = [(t0, t1)]
        for fx, fy in flashes:
            a, b = fx / fps, fy / fps
            nxt = []
            for p0, p1 in parts:
                if a < p1 and b > p0:
                    if a - p0 > 0.4: nxt.append((p0, a))
                    if p1 - b > 0.4: nxt.append((b, p1))
                else:
                    nxt.append((p0, p1))
            parts = nxt
        pieces += parts
    peak = int(np.argmax(db)) / 10
    return pieces, (max(0.0, peak - 3), 4.0)


def card(W, H, path, lines, k):
    im = Image.new('RGB', (W, H), BG); d = ImageDraw.Draw(im)
    files = {'r': 'Inter-Regular.otf', 's': 'Inter-SemiBold.otf', 'b': 'Inter-Bold.otf', 'x': 'Inter-ExtraBold.otf'}
    rows = [(t, ImageFont.truetype(FONT + files[w], int(size * k)), int(size * k * 1.25), COLOURS[c]) for t, w, size, c in lines]
    y = (H - sum(h for *_, h, _ in rows)) // 2
    for t, f, h, c in rows:
        if t:
            d.text(((W - d.textlength(t, font=f)) / 2, y), t, font=f, fill=c)
        y += h
    im.save(path)


def replay_label(W, H, path, k, top):
    im = Image.new('RGBA', (W, H), (0, 0, 0, 0)); d = ImageDraw.Draw(im)
    f = ImageFont.truetype(FONT + 'Inter-Bold.otf', int(40 * k)); t = 'Replay'
    w = d.textlength(t, font=f); x = W - w - int(60 * k); y = int(top * k)
    d.rounded_rectangle((x - 22 * k, y - 12 * k, x + w + 22 * k, y + 58 * k), radius=30 * k, fill=(12, 12, 14, 200)); d.text((x, y), t, font=f, fill=COLOURS['lime'])
    im.save(path)


def render(clips, pieces, replay, card_lines, music, work):
    p = os.path.join(work, 'p'); os.makedirs(p, exist_ok=True)
    for tag, (W, H, k, top) in {'w': (1920, 1080, 1.0, 48), 't': (1080, 1920, 0.75, 260)}.items():
        card(W, H, f'{work}/open_{tag}.png', card_lines, k)
        card(W, H, f'{work}/end_{tag}.png', [['kicksma.sh', 'x', 96, 'lime'], ['Your match, your reel', 's', 40, 'muted']], k)
        replay_label(W, H, f'{work}/replay_{tag}.png', k, top)
    names = []
    for i, (a, b) in enumerate(pieces):
        d = round(b - a, 3); fo = round(d - 0.12, 3); out = f'{p}/{i:02d}.mp4'
        ff('-ss', str(a), '-i', clips, '-t', str(d), '-vf', f'scale=1920:1080:flags=lanczos,fps={FPS_OUT},format=yuv420p,fade=in:st=0:d=0.12,fade=out:st={fo}:d=0.12',
           '-af', f'aresample=48000,aformat=channel_layouts=stereo,afade=in:st=0:d=0.08,afade=out:st={fo}:d=0.12', '-c:v', 'libx264', '-preset', 'fast', '-crf', '18', '-c:a', 'aac', '-b:a', '192k', out)
        names.append(out)
    r0, rd = replay
    ff('-t', str(rd), '-ss', str(r0), '-i', clips, '-t', str(2 * rd), '-loop', '1', '-i', f'{work}/replay_w.png', '-f', 'lavfi', '-t', str(2 * rd), '-i', 'anullsrc=r=48000:cl=stereo',
       '-filter_complex', f'[0:v]setpts=2*PTS,scale=1920:1080:flags=lanczos,fps={FPS_OUT},format=yuv420p[v];[v][1:v]overlay=0:0,fade=in:st=0:d=0.15,fade=out:st={2 * rd - 0.25}:d=0.2,format=yuv420p[o]',
       '-map', '[o]', '-map', '2:a', '-t', str(2 * rd), '-c:v', 'libx264', '-preset', 'fast', '-crf', '18', '-c:a', 'aac', f'{p}/replay.mp4')
    for c, dur in (('open', 3.5), ('end', 2.5)):
        ff('-loop', '1', '-i', f'{work}/{c}_w.png', '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo', '-t', str(dur), '-vf', f'fps={FPS_OUT},format=yuv420p,fade=in:st=0:d=0.3,fade=out:st={dur - 0.3}:d=0.3',
           '-c:v', 'libx264', '-preset', 'fast', '-crf', '18', '-c:a', 'aac', '-shortest', f'{p}/{c}.mp4')
    with open(f'{work}/list.txt', 'w') as f:
        for n in [f'{p}/open.mp4', *names, f'{p}/replay.mp4', f'{p}/end.mp4']:
            f.write(f"file '{n}'\n")
    body = f'{work}/body.mp4'
    ff('-f', 'concat', '-safe', '0', '-i', f'{work}/list.txt', '-c:v', 'libx264', '-preset', 'fast', '-crf', '19', '-r', str(FPS_OUT), '-c:a', 'aac', '-b:a', '192k', body)
    D = duration(body)
    wide = f'{work}/wide.mp4'
    ff('-i', body, '-stream_loop', '-1', '-i', music, '-filter_complex',
       f'[0:a]loudnorm=I=-17:TP=-1.5:LRA=11,asplit=2[court][key];[1:a]atrim=0:{D},volume=0.55,afade=in:st=0:d=1,afade=out:st={D - 2}:d=2[mus];'
       '[mus][key]sidechaincompress=threshold=0.04:ratio=6:attack=15:release=400[duck];[court][duck]amix=inputs=2:normalize=0,alimiter=limit=0.89[a]',
       '-map', '0:v', '-map', '[a]', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', wide)
    E = round(D - 2.5, 3); tall = f'{work}/tall.mp4'
    ff('-i', wide, '-loop', '1', '-i', f'{work}/open_t.png', '-loop', '1', '-i', f'{work}/end_t.png', '-filter_complex',
       '[0:v]split=2[a][b];[a]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,boxblur=30:3,eq=brightness=-0.12[bg];[b]scale=1080:-2[fg];'
       '[bg][fg]overlay=(W-w)/2:(H-h)/2[v1];[1:v]format=yuva420p,fade=out:st=3.2:d=0.3:alpha=1[o];[v1][o]overlay=0:0:enable=\'lt(t,3.5)\'[v2];'
       f'[2:v]format=yuva420p,fade=in:st=0:d=0.3:alpha=1,setpts=PTS+{E}/TB[e];[v2][e]overlay=0:0:enable=\'gte(t,{E})\'[v3];[v3]format=yuv420p[v]',
       '-map', '[v]', '-map', '0:a', '-t', str(D), '-c:v', 'libx264', '-preset', 'fast', '-crf', '20', '-c:a', 'copy', '-movflags', '+faststart', tall)
    os.remove(body)
    return wide, tall


def publish(wide, tall, codes, host):
    import urllib.request
    token = secrets.token_urlsafe(24)
    for f, name in ((wide, 'wide'), (tall, 'tall')):
        modal('volume', 'put', 'kicksmash-matches', f, f'reels/{token}/{name}.mp4')
    for code in codes:
        req = urllib.request.Request('https://kicksma.sh/api/admin/match-reel', method='POST', data=json.dumps({'code': code, 'host': host, 'token': token}).encode(),
                                     headers={'Authorization': f"Bearer {os.environ['CRON_SECRET']}", 'Content-Type': 'application/json'})
        with urllib.request.urlopen(req, timeout=30) as r:
            print(code, json.load(r))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--upload', required=True); ap.add_argument('--codes', required=True); ap.add_argument('--card', required=True)
    ap.add_argument('--music', default=None, help='a local track; by default the store\'s assets/kicksmash-music-warm-bounce.m4a')
    ap.add_argument('--host', default='https://evhg--kicksmash-reels-web.us-east.modal.run')
    ap.add_argument('--work', default='fast-reel-work'); ap.add_argument('--no-publish', action='store_true')
    o = ap.parse_args()
    os.makedirs(o.work, exist_ok=True)
    clips = os.path.join(o.work, 'clips.mp4')
    if not os.path.exists(clips):
        modal('volume', 'get', '--force', 'kicksmash-matches', f'{o.upload.rstrip("/")}/video.mp4', clips)
    music = o.music or os.path.join(o.work, 'music.m4a')
    if not os.path.exists(music):
        modal('volume', 'get', '--force', 'kicksmash-matches', 'assets/kicksmash-music-warm-bounce.m4a', music)
    fps, n, joins, flashes = joins_and_flashes(clips, o.work)
    db = loudness(clips, o.work)
    pieces, replay = plan(fps, n, joins, flashes, db)
    print(f'{n} frames, {len(joins)} joins, {len(flashes)} flash-backs cut, {len(pieces)} pieces, replay at {replay[0]:.1f}s')
    wide, tall = render(clips, pieces, replay, json.load(open(o.card)), music, o.work)
    print(f'wide {duration(wide):.1f}s, tall {duration(tall):.1f}s')
    if not o.no_publish:
        publish(wide, tall, [c.strip() for c in o.codes.split(',') if c.strip()], o.host)


if __name__ == '__main__':
    sys.exit(main())
