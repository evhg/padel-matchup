"""Line up the phone sound with the transmitter recordings.

    python tx_phone.py <phone sound file> <left_dir> <right_dir> <out.json>

Gives, for each transmitter, the second in its recording that is second 0 of the phone. The method is
the loudness curve (50 values a second, slow level removed), compared over the whole match and again
for each ten minutes to show drift. As a check on the method it also compares the two transmitters.
A recorder keeps test recordings of a few seconds too; files under 20 seconds are not part of the clock.
"""
import sys, glob, json, subprocess, numpy as np, soundfile as sf
from scipy.signal import fftconvolve

RATE = 50


def sound(f):
    raw = subprocess.run(['ffmpeg', '-v', 'error', '-nostdin', '-i', f, '-af', 'highpass=f=1000', '-ar', '8000', '-ac', '1',
                          '-f', 'f32le', '-'], capture_output=True).stdout
    return np.frombuffer(raw, np.float32)


def env(x):
    k = 8000 // RATE; n = len(x) // k
    d = np.log(np.sqrt((x[:n * k].reshape(n, k) ** 2).mean(1)) + 1e-6)
    w = RATE * 5
    d = d - np.convolve(d, np.ones(w) / w, 'same')
    return (d - d.mean()) / d.std()


def lag(a, b):
    """b[t] is like a[t + lag]: the lag in seconds, and how far the peak is above the rest."""
    c = fftconvolve(a, b[::-1]); k = int(np.argmax(c))
    return (k - (len(b) - 1)) / RATE, float((c[k] - c.mean()) / c.std())


def folder(d):
    fs = sorted(f for f in glob.glob(d + '/*.WAV') + glob.glob(d + '/*.wav') if sf.info(f).duration > 20)
    return env(np.concatenate([sound(f) for f in fs]))


phone, left, right, out = sys.argv[1:5]
P, L, R = env(sound(phone)), folder(left), folder(right)
res = {'left_in_right': lag(R, L)}
for name, T in (('left', L), ('right', R)):
    whole, z = lag(T, P); blocks = []
    for a in range(0, len(P) - RATE * 600 + 1, RATE * 600):
        s0 = int(a + (whole - 5) * RATE)
        if s0 < 0 or s0 + RATE * 610 > len(T): continue
        c = fftconvolve(T[s0:s0 + RATE * 610], P[a:a + RATE * 600][::-1], mode='valid'); k = int(np.argmax(c))
        blocks.append({'phone_s': a // RATE, 'offset': round(whole - 5 + k / RATE, 2), 'z': round(float((c[k] - c.mean()) / c.std()), 1)})
    res[name] = {'offset_s': whole, 'z': round(z, 1), 'blocks': blocks}
    print(name, 'offset', whole, 'z', round(z, 1), [b['offset'] for b in blocks], [b['z'] for b in blocks])
print('left in right', res['left_in_right'], ' right minus left', round(res['right']['offset_s'] - res['left']['offset_s'], 2))
json.dump(res, open(out, 'w'), indent=1)
