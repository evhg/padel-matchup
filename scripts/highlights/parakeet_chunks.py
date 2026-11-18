"""Write down speech with Parakeet (a recogniser of another kind than Whisper: it writes nothing in silence), in pieces.

usage: parakeet_chunks.py <dir with WAV files> <start s> <seconds> <out.json> [piece=20] [gain_db=30]
The model folder is $HL_HOME/models/parakeet/sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8 (from the sherpa-onnx releases).
"""
import sys, os, glob, json, subprocess, time, numpy as np, soundfile as sf, sherpa_onnx
d, t0, dur, out = sys.argv[1], float(sys.argv[2]), float(sys.argv[3]), sys.argv[4]
piece = float(sys.argv[5]) if len(sys.argv) > 5 else 20.0; gain = sys.argv[6] if len(sys.argv) > 6 else '30'
S = os.environ.get('HL_HOME') or os.path.dirname(os.path.dirname(os.path.abspath(__file__))); M = f'{S}/models/parakeet/sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8'
rec = sherpa_onnx.OfflineRecognizer.from_transducer(encoder=f'{M}/encoder.int8.onnx', decoder=f'{M}/decoder.int8.onnx', joiner=f'{M}/joiner.int8.onnx', tokens=f'{M}/tokens.txt', num_threads=4, model_type='nemo_transducer')
files = []; base = 0.0
for f in sorted(x for x in glob.glob(d + '/*.WAV') if sf.info(x).duration > 20): n = sf.info(f).duration; files.append((base, n, f)); base += n
def clip(a, n):
    for b, ln, f in files:
        if b <= a < b + ln:
            raw = subprocess.run(['ffmpeg', '-v', 'error', '-nostdin', '-ss', f'{a - b}', '-t', f'{n}', '-i', f, '-af', f'highpass=f=120,volume={gain}dB,alimiter=limit=0.9', '-ar', '16000', '-ac', '1', '-f', 'f32le', '-'], capture_output=True, check=True).stdout
            return np.frombuffer(raw, np.float32)
res = {'words': [], 'pieces': []}; a = 0.0; t = time.time()
while a < dur:
    n = min(piece, dur - a); x = clip(t0 + a, n); st = rec.create_stream(); st.accept_waveform(16000, x); rec.decode_stream(st); r = st.result
    # tokens are pieces of words: a token that starts with a space starts a word
    w = ''; wt = 0.0
    for tok, ts in zip(r.tokens, r.timestamps):
        if tok.startswith(' ') or not w:
            if w.strip(): res['words'].append({'t': round(a + wt, 2), 'w': w.strip()})
            w = tok; wt = ts
        else: w += tok
    if w.strip(): res['words'].append({'t': round(a + wt, 2), 'w': w.strip()})
    res['pieces'].append({'t0': a, 'text': r.text.strip()})
    if r.text.strip(): print(f'{a:6.0f}  {r.text.strip()[:150]}', flush=True)
    a += piece
res['seconds'] = round(time.time() - t, 1); json.dump(res, open(out, 'w')); print('PARAKEET_DONE words', len(res['words']), 'seconds', res['seconds'])
