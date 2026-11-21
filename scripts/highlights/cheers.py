"""Add the sound of an audience to a reel: one cheer after each point, never over a player's own voice.

usage: cheers.py <reel.mp4> <workdir of reel_points.py> <points.json> <cheer_dir> <out.mp4> [level dB=-20]

Friends who play have no audience. A reel of a professional match has one, and measured on such a reel the crowd
starts at the winning shot, lasts 3.5 to 5 seconds (9.6 for the best point) and is quiet during the rally.
The owner asked for that sound (19 November 2026) with two rules:
- each point gets a different cheer ("cheer": "<file>" in a point of points.json; a file is used once);
- a cheer never sounds at the same time as a player who shouts or celebrates.

CHEER_AT=slowmo: the cheer starts with the first slow look after its point (the "react" or the "replay" of that
point), where no player talks; a point with no slow look keeps the rule below. A funny clip takes a jeer or a
laugh for its file, not a cheer.

So a cheer starts at the first moment after the point is decided ("dead_t"; without it, the last shot) when no
voice is heard for 1.5 seconds, inside the clip of the point or at its end. A smash that flies out is not cheered
while it is in the air. If a voice comes back while the cheer runs, the cheer goes down by 12 dB for as
long as the voice lasts. A voice is 150 ms or more of sound in the speech band, 6 dB over the level of the rally:
a racket hit is shorter than that.

The picture is copied as it is. The level is the loudest half second of a cheer, in dB under full scale: the
players stay the loudest thing in the reel.
"""
import sys, os, re, glob, json, subprocess, numpy as np
from scipy.signal import butter, sosfilt

reel, work, pointsf, cdir, out = sys.argv[1:6]
LEVEL = float(sys.argv[6]) if len(sys.argv) > 6 else -20.0
SR = 48000; FR = SR // 20                           # 50 ms


def sound(f, ch):
    raw = subprocess.run(['ffmpeg', '-v', 'error', '-nostdin', '-i', f, '-vn', '-ac', str(ch), '-ar', str(SR), '-f', 'f32le', '-'], capture_output=True, check=True).stdout
    return np.frombuffer(raw, np.float32).reshape(-1, ch).copy()


def length(f):
    return float(subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f], capture_output=True, text=True).stdout.strip())


P = json.load(open(pointsf))['points']
segs = sorted(glob.glob(f'{work}/[0-9][0-9]-*.json')); at = 0.0; clips = {}; slow = {}
for s in segs:
    d = json.load(open(s)); n = os.path.basename(s)[3:-5]; ln = length(s[:-5] + '.mp4')
    if d['kind'] == 'clip' and n.startswith('point'): clips[int(n[5:])] = (at, ln, d)
    m = re.match(r'(react|replay)(\d+)$', n)
    if m and int(m.group(2)) not in slow: slow[int(m.group(2))] = at          # the first slow look after point i
    at += ln
x = sound(reel, 2); mono = x.mean(1)
band = sosfilt(butter(4, [300, 3000], 'bandpass', fs=SR, output='sos'), mono)
k = len(band) // FR; lev = 10 * np.log10((band[:k * FR].reshape(k, FR) ** 2).mean(1) + 1e-12)
used = set(); report = []
for i, c in enumerate(P):
    if not c.get('cheer') or i not in clips: continue
    if c['cheer'] in used: sys.exit(f"cheer {c['cheer']} is used twice: each point needs its own")
    used.add(c['cheer'])
    a, ln, d = clips[i]; last = a + ((c.get('dead_t') or c['last_t']) - d['t0']); end = a + ln      # the crowd answers the end of the point, not the last hit
    f0, f1, fe = int(a * 20), int(last * 20), int(end * 20)
    thr = float(np.median(lev[f0:max(f0 + 1, f1)])) + 6.0
    loud = lev > thr
    voice = loud & np.roll(loud, 1) & np.roll(loud, 2); voice = voice | np.roll(voice, -1) | np.roll(voice, -2)     # 150 ms or more
    voice[fe:] = False                               # after the clip the sound is the reel's own (a replay), not a player
    start = fe
    for f in range(f1 + 3, fe):
        if not voice[f:f + 30].any(): start = f; break       # a shout often comes half a second after the point: look 1.5 s ahead
    # CHEER_AT=slowmo (the owner, 21 November 2026): the crowd answers in the slow look after the point, where no player talks
    if os.environ.get('CHEER_AT') == 'slowmo' and i in slow: start = int((slow[i] + 0.2) * 20)
    ch = sound(os.path.join(cdir, c['cheer']), 1)[:, 0]
    kk = len(ch) // (SR // 2); peak = max(float(np.sqrt((ch[j * (SR // 2):(j + 1) * (SR // 2)] ** 2).mean())) for j in range(max(kk, 1)))
    ch = ch * (10 ** (LEVEL / 20) / (peak + 1e-9))
    s0 = start * FR; n = min(len(ch), len(x) - s0)
    if n <= 0: continue
    # down by 12 dB while a voice is heard, with a slope of 100 ms so the step is not heard
    g = np.repeat(np.where(voice[start:start + n // FR + 1], 10 ** (-12 / 20), 1.0), FR)[:n]
    g = np.convolve(g, np.ones(SR // 10) / (SR // 10), 'same'); g[:SR // 50] *= np.linspace(0, 1, SR // 50)
    x[s0:s0 + n] += (ch[:n] * g)[:, None]
    report.append((i, c['cheer'], round(last, 2), round(start / 20, 2), round(start / 20 - last, 2), round(n / SR, 1), int(voice[start:start + n // FR].sum()) * 50))
over = np.abs(x) > 0.8                              # only a sum over 0.8 of full scale is rounded off, with no step at 0.8
x[over] = np.sign(x[over]) * (0.8 + 0.2 * np.tanh((np.abs(x[over]) - 0.8) / 0.2))
tmp = out + '.cheers.wav'
import soundfile as sf
sf.write(tmp, x, SR, subtype='PCM_24')
subprocess.run(['ffmpeg', '-v', 'error', '-nostdin', '-y', '-i', reel, '-i', tmp, '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '256k', '-movflags', '+faststart', out], check=True)
os.remove(tmp)
for r in report: print('point %d  %s  decided %.2f s  cheer from %.2f s (%.2f s after)  %.1f s long  voice under it %d ms' % r)
print('CHEERS_DONE', len(report))
