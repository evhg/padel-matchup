"""Write down all speech of a transmitter recording, with no voice detector in front (it missed far voices).

usage: tx_listen.py <dir with WAV files> <out.jsonl> [model=large-v3-turbo]
Each file is made even in loudness first (a hit is 30 dB louder than a far voice), then read in pieces of five minutes.
One line for each piece of text: start in the whole recording (s), end, the text, and how sure the recogniser was.
A recogniser with nothing to hear writes filler ("Thank you."): the reader of this file must filter that.
"""
import sys, glob, json, subprocess, time, numpy as np, soundfile as sf
from faster_whisper import WhisperModel
d, out = sys.argv[1:3]; size = sys.argv[3] if len(sys.argv) > 3 else 'large-v3-turbo'
m = WhisperModel(size, device='cpu', compute_type='int8', cpu_threads=4)
base = 0.0; t = time.time(); n = 0
with open(out, 'w') as fh:
    for f in sorted(x for x in glob.glob(d + '/*.WAV') if sf.info(x).duration > 20):
        dur = sf.info(f).duration
        for a in np.arange(0, dur, 300.0):
            raw = subprocess.run(['ffmpeg', '-v', 'error', '-nostdin', '-ss', f'{a}', '-t', '300', '-i', f, '-af', 'highpass=f=150,lowpass=f=6000,dynaudnorm=f=200:g=15:p=0.9:m=40',
                                  '-ar', '16000', '-ac', '1', '-f', 'f32le', '-'], capture_output=True, check=True).stdout
            x = np.frombuffer(raw, np.float32)
            segs, _ = m.transcribe(x, language='en', vad_filter=False, beam_size=5, condition_on_previous_text=False)
            for g in segs:
                fh.write(json.dumps({'t0': round(base + a + g.start, 1), 't1': round(base + a + g.end, 1), 'text': g.text.strip(), 'lp': round(g.avg_logprob, 2), 'nsp': round(g.no_speech_prob, 2)}) + '\n'); n += 1
            fh.flush(); print(f'{(base + a) / 60:6.1f} min  lines {n}  {time.time() - t:6.0f} s', flush=True)
        base += dur
print('LISTEN_DONE', n)
