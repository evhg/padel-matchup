"""Put one music track under a finished reel, with its drop on a hit.

usage: music.py <reel.mp4> <workdir of reel_points.py> <points.json> <track.wav> <out.mp4>
env:   DROP (s, where the drop is in the track), BPM, BARS (length of the loop after the drop, in bars of four beats),
       LUFS (level of the music at full strength, default -20; the reel is at -16)
       SECTION (bars; for a full-length track: each hit starts the next section of the track, so the music moves on
       through the piece and no part plays twice. 0 = the loop of BARS bars starts again at each hit)

The owner's idea (21 November 2026): "time the drop with a sudden hit or smash". The plan of the reel knows each hit.
- The music waits for the announcement of the opening to end. Then it comes in as a DJ brings a track in: the
  first bar of the drop plays backwards and rises from nothing, and the drop lands on the first hit of the first clip (MIXIN=intro: the
  old way, the quiet start of the track under the opening).
- In a slow look the beat goes away (only the low part stays, quieter), so the crowd sound has room.
- The beat comes back, from its first bar, on the hit that matters in the next clip: the serve of a full rally, the
  last hit of a clip that starts late. A short silence before the hit makes it land.
- The music goes down under voices.
The time of a hit is set on the sharpest click (the sound above 2 kHz) from 0.6 s before the plan to 1.0 s after it,
and not later than 0.1 s after the ball is dead: a ball that rolls into the fence after the point is louder than a far serve.
A track with nearly all its energy under 60 Hz is silent on a phone: a layer one octave up is made from the bass.
"""
import sys, os, glob, json, subprocess, numpy as np, soundfile as sf
from scipy.signal import butter, sosfilt, sosfiltfilt
from scipy.ndimage import uniform_filter1d as smooth
reel, work, pointsf, track, out = sys.argv[1:6]
SR = 48000; DROP = float(os.environ.get('DROP', 4.385)); BPM = float(os.environ.get('BPM', 100)); BARS = int(os.environ.get('BARS', 10)); LUFS = float(os.environ.get('LUFS', -20)); SECTION = int(os.environ.get('SECTION', 0))
P = json.load(open(pointsf)); tmp = out + '.tmp'; os.makedirs(tmp, exist_ok=True)


def length(f): return float(subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f], capture_output=True, text=True).stdout.strip())


def decode(f, name):
    o = f'{tmp}/{name}.wav'; subprocess.run(['ffmpeg', '-v', 'error', '-nostdin', '-y', '-i', f, '-map', '0:a:0', '-ar', str(SR), '-ac', '2', '-c:a', 'pcm_f32le', o], check=True); return sf.read(o, dtype='float32')[0]


def lufs(x):
    f = f'{tmp}/m.wav'; sf.write(f, x, SR, subtype='FLOAT')
    r = subprocess.run(['ffmpeg', '-nostdin', '-i', f, '-af', 'ebur128', '-f', 'null', '-'], capture_output=True, text=True).stderr
    return float(r.split('Integrated loudness:')[1].split('I:')[1].split('LUFS')[0])


A = decode(reel, 'reel'); N = len(A); mono = A.mean(1)
vd = float(subprocess.run(['ffprobe', '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=duration', '-of', 'csv=p=0', reel], capture_output=True, text=True).stdout.strip().strip(','))
# the parts of the reel on its own clock
segs = sorted(glob.glob(f'{work}/[0-9][0-9]-*.json')); at = 0.0; parts = []
for s in segs:
    d = json.load(open(s)); n = os.path.basename(s)[3:-5]; ln = length(s[:-5] + '.mp4'); parts.append({'name': n, 'kind': d['kind'], 'at': at, 'len': ln, 'd': d}); at += ln
# the hit of each clip
hop = 240; hf = sosfilt(butter(4, 2000, 'high', fs=SR, output='sos'), mono); e5 = np.sqrt(np.maximum(0, (hf[:N // hop * hop].reshape(-1, hop) ** 2).mean(1)))
click = np.maximum(0, np.diff(np.log(e5 + 1e-5))) * np.sqrt(e5[1:])      # a sharp rise that is also loud
hits = []
for p in parts:
    if p['kind'] != 'clip' or not p['name'].startswith('point'): continue
    c = P['points'][int(p['name'][5:])]; d = p['d']
    src = c['serve_t'] if not c.get('start_t') else c['last_t']
    if not d['t0'] <= src <= d['t1']: src = c['serve_t'] if d['t0'] <= c['serve_t'] <= d['t1'] else c['last_t']
    t = p['at'] + src - d['t0']; dead = p['at'] + d['dead'] - d['t0'] if d.get('dead') else t + 1.0
    a = int((t - 0.6) * SR / hop); b = max(a + 8, int((min(t + 1.0, dead + 0.1)) * SR / hop)); near = 1 - 0.4 * np.abs((np.arange(a, b) + 1) * hop / SR - t)
    k = a + int(np.argmax(click[a:b] * near)); tr = (k + 1) * hop / SR
    hits.append({'clip': c['id'], 'title': c['title'], 'kind': 'moment' if c.get('start_t') else 'serve', 'plan': round(t, 2), 'hit': round(tr, 3), 'part': p})
# the track: quiet start, drop, loop
T = decode(track, 'track'); beat = 60 / BPM; loop0 = int(DROP * SR); loopn = int(round(BARS * 4 * beat * SR))
if loop0 + loopn > len(T): sys.exit('the track is too short for the loop')
xf = int(0.02 * SR); loop = T[loop0:loop0 + loopn].copy(); tail = T[loop0 + loopn:loop0 + loopn + xf]
if len(tail) == xf:  # the seam: the first 20 ms of a round come in over what followed the last bar
    r = np.linspace(0, 1, xf)[:, None]; loop[:xf] = loop[:xf] * r + tail * (1 - r)
M = np.zeros((N, 2), np.float32); g = np.zeros(N, np.float32)   # g: 1 = the whole beat, 0 = the low part only
first = hits[0]['hit']; fi = int(first * SR); talk_end = None
if os.environ.get('MIXIN', 'dj') == 'dj' and parts and parts[0]['kind'] == 'file':
    oe = int(parts[0]['len'] * SR); vb = sosfilt(butter(4, [300, 3400], 'band', fs=SR, output='sos'), mono[:oe]); blk = SR // 10
    lv = np.array([np.sqrt((vb[i:i + blk] ** 2).mean()) for i in range(0, oe - blk, blk)]); on = np.where(lv > lv.max() * 10 ** (-28 / 20))[0]
    talk_end = (on[-1] + 1) * 0.1 + 0.1 if len(on) else 0.0
if talk_end is not None and 0.6 < first - talk_end < loopn / SR:
    # the first bar of the drop, played backwards and rising: the bass swells up to the hit (a DJ's way into a drop)
    n = fi - int(talk_end * SR); M[fi - n:fi] = loop[:n][::-1] * (np.linspace(0, 1, n)[:, None] ** 1.5 * 0.55); g[fi - n:fi] = 1
else:
    i0 = int((first - DROP) * SR); a = max(0, i0); M[a:fi] = T[a - i0:fi - i0]; g[a:fi] = 1
gap0 = int(0.12 * SR); M[fi - gap0:fi] *= np.linspace(1, 0, gap0)[:, None] ** 2
outro = next((p for p in parts if p['kind'] == 'card'), None)      # the first card after the clips (the numbers, or the end card): the beat is whole from there
starts = [h['hit'] for h in hits] + ([outro['at']] if outro else [])
for j, st in enumerate(starts):
    a = int(st * SR); b = int(starts[j + 1] * SR) if j + 1 < len(starts) else N; n = b - a
    if SECTION:
        sec = int(round(SECTION * 4 * beat * SR))
        if j == 0: at_track = loop0
        if at_track + n > len(T) - SR: at_track = loop0                       # the end of the track: from the drop again
        M[a:b] = T[at_track:at_track + n]; at_track = loop0 + -(-(at_track + n - loop0) // sec) * sec
    else: M[a:b] = np.tile(loop, (n // loopn + 1, 1))[:n]
    gap = int(0.14 * SR)
    if j + 1 < len(starts): M[b - gap:b] *= np.linspace(1, 0, gap)[:, None] ** 2
# where the beat is whole: from a hit to the first slow look (or other part) after its clip; and in the outro
for j, h in enumerate(hits):
    p = h['part']; end = p['at'] + p['len']; g[int(h['hit'] * SR):int(end * SR)] = 1
if outro: g[int(outro['at'] * SR):] = 1
k = int(0.35 * SR); soft = smooth(g, k)
for h in hits: a = int(h['hit'] * SR); soft[a:a + k] = np.maximum(soft[a:a + k], g[a:a + k])   # a hit opens at once
lo = sosfiltfilt(butter(4, 220, 'low', fs=SR, output='sos'), M, axis=0)
sub = sosfiltfilt(butter(4, 110, 'low', fs=SR, output='sos'), M, axis=0); pk = np.abs(sub).max() + 1e-9
oct_ = sosfiltfilt(butter(2, [110, 380], 'band', fs=SR, output='sos'), np.tanh(5 * sub / pk), axis=0) * pk * 0.5      # the bass a phone can play
spec = np.abs(np.fft.rfft(T[:SR * 60].mean(1))) ** 2; fq = np.fft.rfftfreq(len(T[:SR * 60]), 1 / SR); subshare = spec[fq < 60].sum() / spec.sum()
if subshare > 0.5: body = sosfiltfilt(butter(2, 38, 'high', fs=SR, output='sos'), M, axis=0) - 0.45 * sosfiltfilt(butter(2, 65, 'low', fs=SR, output='sos'), M, axis=0) + oct_
else: body = sosfiltfilt(butter(2, 28, 'high', fs=SR, output='sos'), M, axis=0); oct_ = oct_ * 0      # a track with its bass above 60 Hz needs no help
ref = body[int(starts[0] * SR):int(starts[0] * SR) + loopn]; gain = 10 ** ((LUFS - lufs(ref)) / 20)
music = (body * soft[:, None] + (lo * 0.55 + oct_ * 0.4) * (1 - soft[:, None])) * gain
# down under voices: the level of the reel between 400 and 3000 Hz, slow enough that one ball hit does not pump
v = sosfilt(butter(2, [400, 3000], 'band', fs=SR, output='sos'), mono); kk = int(0.25 * SR); ve = np.sqrt(np.maximum(0, smooth(v.astype(np.float64) ** 2, kk)))
thr = np.percentile(ve[ve > 0], 60); duck = np.clip(20 * np.log10(ve / thr + 1e-9) * 0.7, 0, 7); duck = smooth(duck, kk)
music *= (10 ** (-duck / 20))[:, None]
if outro: fo = int(2.5 * SR); e = min(N, int(vd * SR)); music[e - fo:e] *= np.linspace(1, 0, fo)[:, None]; music[e:] = 0
sf.write(f'{tmp}/mix.wav', A + music, SR, subtype='FLOAT')
subprocess.run(['ffmpeg', '-v', 'error', '-nostdin', '-y', '-i', reel, '-i', f'{tmp}/mix.wav', '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'copy', '-af', 'alimiter=limit=0.84:level=false', '-ar', '48000', '-c:a', 'aac', '-b:a', '320k',
                '-t', f'{vd:.3f}', '-movflags', '+faststart', out], check=True)
rep = {'hits': [{k: v for k, v in h.items() if k != 'part'} for h in hits], 'music_gain_db': round(20 * np.log10(gain), 1), 'music_lufs_full': LUFS, 'duck_max_db': round(float(duck.max()), 1),
       'share_whole_beat': round(float(g.mean()), 2), 'music_starts_s': None if talk_end is None else round(float(talk_end), 2), 'sub_share_of_track': round(float(subshare), 2), 'reel_s': round(vd, 2)}
json.dump(rep, open(out[:-4] + '-music.json', 'w'), indent=1)
for h in rep['hits']: print('%-22s %-6s plan %7.2f  hit %8.3f' % (h['title'][:22], h['kind'], h['plan'], h['hit']))
print({k: v for k, v in rep.items() if k != 'hits'}); print('MUSIC_DONE')
