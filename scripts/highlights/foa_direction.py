"""Where does each sharp sound come from? Reads decoded spatial sound of a phone (4 channels: W, Y, Z, X).

    python foa_direction.py <foa.wav> <out.json> [t1 t2 ...]

Without times it finds the sharp sounds itself. For each one it gives the direction of arrival:
azimuth (0 = the phone's front axis, positive to the left) and elevation, in degrees, and how
much of the sound came from one direction (0 = from all sides, 1 = from one point).
The method is the sound intensity vector: the mean of W times X, Y and Z over 12 ms after the onset.
"""
import sys, json, numpy as np, soundfile as sf
from scipy.signal import butter, sosfiltfilt


def directions(x, sr, times=None, win=0.012, band=(700, 5000)):
    sos = butter(4, band, btype='band', fs=sr, output='sos')
    w, y, z, xx = (sosfiltfilt(sos, x[:, i]) for i in range(4))
    if times is None:
        hop = int(sr * 0.004)
        e = np.array([np.sum(w[i:i + hop] ** 2) for i in range(0, len(w) - hop, hop)]) + 1e-12
        floor = np.array([np.median(e[max(0, i - 50):i + 1]) for i in range(len(e))])
        rise, times, last = e / floor, [], -1.0
        for i in np.nonzero(rise > 30)[0]:
            t = i * hop / sr
            if t - last > 0.08:
                times.append(t)
            last = t
    out = []
    for t in times:
        a, b = int(t * sr), int((t + win) * sr)
        if b > len(w):
            break
        ix, iy, iz = np.mean(w[a:b] * xx[a:b]), np.mean(w[a:b] * y[a:b]), np.mean(w[a:b] * z[a:b])
        energy = 0.5 * (np.mean(w[a:b] ** 2) + np.mean(xx[a:b] ** 2 + y[a:b] ** 2 + z[a:b] ** 2))
        out.append({'t': round(float(t), 3),
                    'az': round(float(np.degrees(np.arctan2(iy, ix))), 1),
                    'el': round(float(np.degrees(np.arctan2(iz, np.hypot(ix, iy)))), 1),
                    'one_point': round(float(np.sqrt(ix * ix + iy * iy + iz * iz) / (energy + 1e-20)), 2),
                    'db': round(float(10 * np.log10(np.mean(w[a:b] ** 2) + 1e-20)), 1)})
    return out


if __name__ == '__main__':
    x, sr = sf.read(sys.argv[1], dtype='float64', always_2d=True)
    if x.shape[1] != 4:
        sys.exit('this file has %d channels, not 4: the decoder gave a mix, not the sound field' % x.shape[1])
    times = [float(v) for v in sys.argv[3:]] or None
    rows = directions(x, sr, times)
    json.dump(rows, open(sys.argv[2], 'w'), indent=1)
    print('FOA_DONE sounds', len(rows))
