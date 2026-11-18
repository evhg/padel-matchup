"""The difference in arrival time of each sharp sound at the two transmitters, from the start of each sound.

usage: tx_tdoa.py <left_dir> <right_dir> <offset_ms> <out.json>
offset_ms: where a sound of left is found in right (tx_first.py). A sound that starts in left at t is looked for in
right near t + offset; the difference to that place says which transmitter the sound was nearer to.
"""
import sys, glob, json, numpy as np, soundfile as sf
from scipy.signal import butter, sosfiltfilt, find_peaks
ld, rd, off, out = sys.argv[1], sys.argv[2], float(sys.argv[3]), sys.argv[4]
SR = 48000
def load(d): return np.concatenate([sf.read(f, dtype='float32')[0] for f in sorted(glob.glob(d + '/*.WAV')) if sf.info(f).duration > 20])
sos = butter(4, [2000, 10000], 'bandpass', fs=SR, output='sos')
def prep(x):
    y = np.abs(sosfiltfilt(sos, x).astype(np.float32)); n = len(y) // 12
    return y[:n * 12].reshape(n, 12).max(1)                      # 0.25 ms steps
EL, ER = prep(load(ld)), prep(load(rd)); STEP = 0.25
def onsets(e):
    """Sharp sounds: (start in ms, peak level). The start is where the level first passes a third of the peak."""
    thr = np.percentile(e[::40], 99.9); pk, _ = find_peaks(e, height=thr, distance=int(120 / STEP)); res = []
    for p in pk:
        a = max(0, p - int(8 / STEP)); seg = e[a:p + 1]; k = int(np.argmax(seg >= e[p] / 3)); res.append(((a + k) * STEP, float(e[p])))
    return np.array(res)
OL, OR = onsets(EL), onsets(ER)
print('sharp sounds: left', len(OL), 'right', len(OR))
rt = OR[:, 0]; pairs = []
for t, a in OL:
    lo, hi = np.searchsorted(rt, t + off - 60), np.searchsorted(rt, t + off + 60)
    if hi > lo:
        k = lo + int(np.argmax(OR[lo:hi, 1])); pairs.append((t / 1000, rt[k] - (t + off), a, OR[k, 1]))
P = np.array(pairs); d = P[:, 1]
print('heard by both:', len(P), 'of', len(OL))
h, _ = np.histogram(d, bins=np.arange(-60, 61, 5)); print('right minus left, ms, 5 ms bins from -60:', h.tolist())
print('percentiles 2, 10, 25, 50, 75, 90, 98:', np.round(np.percentile(d, [2, 10, 25, 50, 75, 90, 98]), 1).tolist())
lv = 20 * np.log10(P[:, 3] / P[:, 2]); print('level right against left, dB, percentiles 10, 50, 90:', np.round(np.percentile(lv, [10, 50, 90]), 1).tolist())
c = np.corrcoef(d, lv)[0, 1]; print('time difference against level difference, correlation:', round(float(c), 2))
json.dump({'offset_ms': off, 'pairs': [[round(float(a), 3), round(float(b), 2), round(float(20 * np.log10(r / l)), 1)] for a, b, l, r in pairs]}, open(out, 'w'))
