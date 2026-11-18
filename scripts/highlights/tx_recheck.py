"""Hear chosen moments again with a second recogniser, on both transmitters.

    python tx_recheck.py <left_dir> <right_dir> <offset_s> <out.json> <t1> <t2> ...

Each t is a second in the right recording. The same 20 seconds are cut from both recordings,
raised 30 dB behind a limiter, and written down by Whisper without a voice detector.
"""
import sys, glob, json, subprocess, numpy as np, soundfile as sf
from faster_whisper import WhisperModel

left, right, off, out = sys.argv[1], sys.argv[2], float(sys.argv[3]), sys.argv[4]
moments = [float(x) for x in sys.argv[5:]]
m = WhisperModel('large-v3-turbo', device='cpu', compute_type='int8', cpu_threads=4)


def cut(folder, t, n=20):
    files, at = sorted(glob.glob(folder + '/*.WAV') + glob.glob(folder + '/*.wav')), 0.0
    for f in files:
        d = sf.info(f).duration
        if at <= t < at + d:
            raw = subprocess.run(['ffmpeg', '-v', 'error', '-nostdin', '-ss', f'{t - at}', '-t', f'{n}', '-i', f,
                                  '-af', 'highpass=f=120,volume=30dB,alimiter=limit=0.9', '-ar', '16000', '-ac', '1',
                                  '-f', 'f32le', '-'], capture_output=True).stdout
            return np.frombuffer(raw, np.float32)
        at += d
    return np.zeros(0, np.float32)


rows = []
for t in moments:
    row = {'t': t}
    for side, folder, start in (('R', right, t), ('L', left, t - off)):
        x = cut(folder, start)
        segs, _ = m.transcribe(x, language='en', vad_filter=False, beam_size=5, condition_on_previous_text=False)
        row[side] = ' '.join(s.text.strip() for s in segs)
    rows.append(row)
    print(f"{t:7.0f}  R: {row['R'][:110]}\n         L: {row['L'][:110]}", flush=True)
json.dump(rows, open(out, 'w'), indent=1)
print('RECHECK_DONE')
