"""First look at the two transmitter recordings of a match: levels, the time between the two, the drift, and the
difference in arrival time of each sharp sound.

usage: tx_first.py <left_dir> <right_dir> <out.json>
Each folder has the WAV files of one transmitter (mono, 48 kHz), in the order of their names.
"""
import sys, glob, json, numpy as np, soundfile as sf
from scipy.signal import fftconvolve, butter, sosfiltfilt, find_peaks
ld, rd, out = sys.argv[1:4]
SR = 48000
def load(d):
    fs = sorted(f for f in glob.glob(d + '/*.WAV') if sf.info(f).duration > 60)
    xs = [sf.read(f, dtype='float32')[0] for f in fs]
    return np.concatenate(xs), [f.split('/')[-1] for f in fs]
L, lf = load(ld); R, rf = load(rd)
def clock(name): h = name.split('_')[3][:6]; return int(h[:2]) * 3600 + int(h[2:4]) * 60 + int(h[4:6])
rep = {}
for nm, x, fs in (('left', L, lf), ('right', R, rf)):
    rep[nm] = {'files': fs, 'minutes': round(len(x) / SR / 60, 2), 'start_clock_s': clock(fs[0]), 'peak': float(np.abs(x).max()),
               'rms_db': round(float(20 * np.log10(np.sqrt(np.mean(x[::7].astype(np.float64) ** 2)) + 1e-12)), 1), 'over_full_scale': int((np.abs(x) > 1.0).sum())}
    print(nm, rep[nm])
# envelopes at 1 kHz: the loudest sample of each millisecond, high-passed so hits count more than voices and wind
sos = butter(4, [1500, 9000], 'bandpass', fs=SR, output='sos')
def env(x):
    y = np.abs(sosfiltfilt(sos, x).astype(np.float32)); n = len(y) // 48
    return y[:n * 48].reshape(n, 48).max(1)
EL, ER = env(L), env(R)
# the offset between the two recordings: where a sound in left is found in right
def offset(a, b, guess, span):
    """a[i] is b[i + off]: search off around guess (ms)."""
    a = np.log1p(200 * a); b = np.log1p(200 * b); a = a - a.mean(); b = b - b.mean()
    c = fftconvolve(b, a[::-1], mode='full'); lag = np.arange(-len(a) + 1, len(b))
    m = (lag >= guess - span) & (lag <= guess + span); k = np.argmax(c[m]); return int(lag[m][k]), float(c[m][k] / (np.std(c[m]) + 1e-9))
g = (rep['left']['start_clock_s'] - rep['right']['start_clock_s']) * 1000
off0, q0 = offset(EL[:1_200_000], ER[:1_400_000], g, 20000)
print('clock names say right started', g / 1000, 's before left; the sound says', off0 / 1000, 's (peak', round(q0, 1), 'sigma)')
blocks = []
for b0 in range(0, len(EL) - 600_000, 600_000):
    a = EL[b0:b0 + 600_000]; lo = b0 + off0 - 3000
    if lo < 0 or lo + 606_000 > len(ER): continue
    o, q = offset(a, ER[lo:lo + 606_000], 3000, 2500); blocks.append((round(b0 / 60000, 1), off0 - 3000 + o, round(q, 1)))
print('offset by ten-minute block (minute, ms, sigma):', blocks)
rep['offset_ms'] = off0; rep['blocks'] = blocks
# sharp sounds in left, and when the same sound arrives in right (to a sample)
pk, pr = find_peaks(EL, height=np.percentile(EL, 99.7), distance=180)
BL = sosfiltfilt(sos, L).astype(np.float32); BR = sosfiltfilt(sos, R).astype(np.float32)
bx = np.array([b[0] * 60000 for b in blocks]); bo = np.array([b[1] for b in blocks])
tdoa = []
for p in pk:
    o = float(np.interp(p, bx + 300_000, bo)) if len(bx) else off0
    i = p * 48; j = int(round((p + o) * 48)); W = 960; S = 2400            # 20 ms of left, searched over +-50 ms of right
    if i - W < 0 or i + W > len(BL) or j - W - S < 0 or j + W + S > len(BR): continue
    a = BL[i - W:i + W]; b = BR[j - W - S:j + W + S]
    c = fftconvolve(b, a[::-1], mode='valid'); k = int(np.argmax(np.abs(c)))
    e = float(np.abs(c[k]) / (np.linalg.norm(a) * np.linalg.norm(b[k:k + 2 * W]) + 1e-9))
    tdoa.append((p / 1000, (k - S) / 48.0 + (o - round(o * 48) / 48 * 0), e))
T = np.array(tdoa); good = T[T[:, 2] > 0.5]
print('sharp sounds in left:', len(pk), 'matched in right with a clear shape:', len(good))
if len(good):
    h, edges = np.histogram(good[:, 1], bins=np.arange(-50, 51, 5)); print('difference right minus left, ms, in 5 ms bins from -50:', h.tolist())
    print('percentiles 1, 5, 25, 50, 75, 95, 99:', np.round(np.percentile(good[:, 1], [1, 5, 25, 50, 75, 95, 99]), 1).tolist())
rep['tdoa'] = [[round(float(a), 3), round(float(b), 3), round(float(c), 2)] for a, b, c in tdoa]
json.dump(rep, open(out, 'w'))
