"""One sound track for the reel from two recorders on the fence, on the clock of the phone.

    python tx_mix.py <phone sound file> <left_dir> <right_dir> <phone.json of tx_phone.py> <out.wav> [quieter dB=18]

A phone behind the glass sounds dull; a recorder on the fence hears the hits and the voices. At each moment the
recorder with more level over its own noise floor leads, and the share moves slowly, so no jump is heard. When
nothing happens, the recorder with less noise leads. The two recorders are up to 34 ms apart for one sound; with one of them in the lead that is not
heard as an echo. The offsets of tx_phone.py for each ten minutes give the drift of the clocks. Where no recorder
ran (before the players switched them on), the phone sound stays, at the level of the mix. The file keeps the
full range (32-bit); a compressor and a loudness step after it set the level for the reel.
The work goes in pieces of one minute: three full recordings of a match do not fit in memory at once.

The steady noise of the hall (air conditioning, a machine beside one recorder) comes out before the mix, for each
recorder with its own noise picture: the level of each frequency in the quiet moments of that recorder. A sound
that stands over that picture passes whole; what is at the level of the picture goes down by "quieter dB"
(0 = leave the noise in). It has to happen here: the compressor after this step lifts whatever is quiet, so the
noise of the hall became the loudest thing between two points.
"""
import sys, glob, json, subprocess, numpy as np, soundfile as sf

from scipy.signal import stft, istft
from scipy.ndimage import uniform_filter1d

phone_f, ld, rd, pj, out = sys.argv[1:6]
QUIETER = float(sys.argv[6]) if len(sys.argv) > 6 else 18.0
NFFT, HOP, PAD = 2048, 512, 8192                                       # 43 ms windows; PAD hides the edges of a piece
SR = 48000; BLOCK = SR * 60; WIN = int(SR * 0.05); SLOW = 6           # level over 50 ms, smoothed over 0.3 s
PJ = json.load(open(pj))


class Recorder:
    """A folder of files read as one long recording, without loading it."""
    def __init__(self, d, side):
        self.files = []; at = 0
        for f in sorted(x for x in glob.glob(d + '/*.WAV') + glob.glob(d + '/*.wav') if sf.info(x).duration > 20):
            n = sf.info(f).frames; self.files.append((at, n, f)); at += n
        self.n = at
        b = PJ[side]['blocks']; t = np.array([q['phone_s'] + 300 for q in b], float); o = np.array([q['offset'] for q in b], float)
        self.slope, self.base = np.polyfit(t, o, 1) if len(b) >= 3 else (0.0, PJ[side]['offset_s'])

    def read(self, a, b):
        y = np.zeros(b - a, np.float32)
        for at, n, f in self.files:
            lo, hi = max(a, at), min(b, at + n)
            if hi > lo: y[lo - a:hi - a] = sf.read(f, start=lo - at, stop=hi - at, dtype='float32')[0]
        return y

    def on_phone_clock(self, a, n):
        """Samples a .. a+n of the phone clock, taken from the right place of this recording."""
        tp = np.arange(a, a + n) / SR; src = (tp + self.base + self.slope * tp) * SR
        i0, i1 = int(np.floor(src[0])) - 1, int(np.ceil(src[-1])) + 2
        if i1 <= 0 or i0 >= self.n: return np.zeros(n, np.float32)
        seg = self.read(max(i0, 0), min(i1, self.n)); src = src - max(i0, 0)
        ok = (src >= 0) & (src < len(seg) - 1); y = np.zeros(n, np.float32)
        i = np.floor(src[ok]).astype(np.int64); f = (src[ok] - i).astype(np.float32)
        y[ok] = seg[i] * (1 - f) + seg[i + 1] * f
        return y


def power(x):
    k = len(x) // WIN; p = (x[:k * WIN].reshape(k, WIN).astype(np.float64) ** 2).mean(1)
    return np.convolve(p, np.ones(SLOW) / SLOW, 'same')


R, L = Recorder(rd, 'right'), Recorder(ld, 'left')
ph = subprocess.Popen(['ffmpeg', '-v', 'error', '-nostdin', '-i', phone_f, '-ac', '1', '-ar', str(SR), '-f', 'f32le', '-'], stdout=subprocess.PIPE)
# Each recorder has its own noise floor (one hung beside a machine): the lead goes by the level over that floor.
def floor_of(rec):
    v = []
    for a in range(SR * 300, max(SR * 301, rec.n - SR * 60), SR * 300):
        v.append(power(rec.read(a, a + SR * 20)))
    return float(np.percentile(np.concatenate(v), 30)) + 1e-30
FR, FL = floor_of(R), floor_of(L)


def noise_picture(rec):
    """The level of each frequency when nothing happens: the 30th percentile of 20 seconds from each five minutes.
    A hit or a voice fills a few of those moments, the hall fills all of them."""
    m = []
    for a in range(SR * 300, max(SR * 301, rec.n - SR * 60), SR * 300):
        m.append(np.abs(stft(rec.read(a, a + SR * 20), SR, nperseg=NFFT, noverlap=NFFT - HOP)[2]).astype(np.float32))
    return np.percentile(np.concatenate(m, 1), 30, axis=1) * 1.48      # the 30th percentile of noise is 0.68 of its mean level


def box(x, k, axis):
    return uniform_filter1d(x, k, axis=axis, mode='nearest')


def quieter(x, pic):
    """x with the steady noise taken down. Two looks at each moment: the sound itself, with a strict bar (a hit is
    short and strong), and its mean over 50 ms, with a low bar (a voice is long and soft). The kinder one decides."""
    if QUIETER <= 0 or not np.any(x): return x
    Z = stft(x, SR, nperseg=NFFT, noverlap=NFFT - HOP)[2]; P = np.abs(Z) ** 2; N = (pic ** 2)[:, None]
    low = 10 ** (-QUIETER / 20)
    g1 = np.sqrt(np.clip(1 - 4.0 * N / (P + 1e-30), 0, 1)); g2 = np.sqrt(np.clip(1 - 1.7 * N / (box(P, 5, 1) + 1e-30), 0, 1))
    g = np.maximum(low, box(np.maximum(g1, g2), 3, 0))
    return istft(Z * g, SR, nperseg=NFFT, noverlap=NFFT - HOP)[1][:len(x)].astype(np.float32)


NR, NL = (noise_picture(R), noise_picture(L)) if QUIETER > 0 else (None, None)
blocks = []; a = 0; num = den = 0.0
while True:
    raw = ph.stdout.read(BLOCK * 4)
    if not raw: break
    p = np.frombuffer(raw, np.float32); n = (len(p) // WIN) * WIN
    if n == 0: break
    p = p[:n]; r, l = R.on_phone_clock(a, n), L.on_phone_clock(a, n)
    pr, pl, pp = power(r), power(l), power(p)
    # The lead goes by the level over the floor. When nothing happens, both are at their floor: then the recorder
    # with less noise leads. With equal shares there, half of the noise of the louder recorder was always in the mix.
    qr, ql = np.maximum(pr / FR - 1, 0) ** 2, np.maximum(pl / FL - 1, 0) ** 2; e = 0.05
    w = np.repeat((qr + e * FL / (FR + FL)) / (qr + ql + e), WIN).astype(np.float32); have = np.repeat((pr + pl) > 1e-12, WIN)
    if QUIETER > 0:                                                    # the lead above went by the sound as recorded
        r = quieter(R.on_phone_clock(a - PAD, n + 2 * PAD), NR)[PAD:PAD + n]; l = quieter(L.on_phone_clock(a - PAD, n + 2 * PAD), NL)[PAD:PAD + n]
    mix = w * r + (1 - w) * l
    loud = have & np.repeat(pp > np.percentile(pp, 60), WIN)
    num += float((p[loud].astype(np.float64) ** 2).sum()); den += float((mix[loud].astype(np.float64) ** 2).sum())
    blocks.append((mix, p, have, float(w[have].mean()) if have.any() else None)); a += n
gain = float(np.sqrt(num / (den + 1e-30)))
# Written as it is (32-bit numbers, hits above full scale stay whole); the phone parts get the opposite gain.
# The level and the limit are the work of the next step (ffmpeg: a compressor and loudnorm).
with sf.SoundFile(out, 'w', SR, 1, 'FLOAT') as fh:
    for mix, p, have, _ in blocks:
        fh.write(np.where(have, mix, p / gain).astype(np.float32))
lead = [x[3] for x in blocks if x[3] is not None]
print('TX_MIX seconds', round(a / SR, 1), 'phone is louder by', round(gain, 2), 'floors', round(10 * np.log10(FR), 1), round(10 * np.log10(FL), 1), 'right leads', round(float(np.mean(lead)), 2),
      'drift ppm', round(R.slope * 1e6, 1), round(L.slope * 1e6, 1), 'quieter dB', QUIETER)
