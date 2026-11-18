"""Compare ways to write down the speech of a match, on the same minutes of the two transmitter recordings.

usage: tx_compare.py <left_dir> <right_dir> <offset_s> <start in right, s> <seconds> <out_dir> [methods, comma separated]
offset_s: a sound at t in left is at t + offset in right (tx_first.py).
Nobody has written down what was really said, so a method is judged by agreement: a word is "confirmed" when the
other transmitter has the same word within 1.5 seconds. Filler that a recogniser invents in silence does not agree.
Methods: A turbo, even loudness; B turbo, raw; C turbo with a voice detector at a low threshold; D small model;
E turbo with a hint of names and padel words; F turbo, any language; G the paid service (ElevenLabs Scribe).
"""
import sys, os, glob, json, re, io, wave, uuid, subprocess, time, urllib.request, numpy as np, soundfile as sf
ld, rd, off, r0, dur, out = sys.argv[1], sys.argv[2], float(sys.argv[3]), float(sys.argv[4]), float(sys.argv[5]), sys.argv[6]
want = (sys.argv[7] if len(sys.argv) > 7 else 'A,B,C,D,E,F,G').split(',')
os.makedirs(out, exist_ok=True)
NORM = 'highpass=f=150,lowpass=f=6000,dynaudnorm=f=200:g=15:p=0.9:m=40'
def cut(d, t0, af):
    """dur seconds from t0 of the joined recording in folder d, as 16 kHz float."""
    fs = sorted(x for x in glob.glob(d + '/*.WAV') if sf.info(x).duration > 20); base = 0.0; parts = []
    for f in fs:
        n = sf.info(f).duration; a, b = max(t0, base), min(t0 + dur, base + n)
        if b > a:
            cmd = ['ffmpeg', '-v', 'error', '-nostdin', '-ss', f'{a - base}', '-t', f'{b - a}', '-i', f] + (['-af', af] if af else []) + ['-ar', '16000', '-ac', '1', '-f', 'f32le', '-']
            parts.append(np.frombuffer(subprocess.run(cmd, capture_output=True, check=True).stdout, np.float32))
        base += n
    return np.concatenate(parts)
AUD = {('R', 'norm'): cut(rd, r0, NORM), ('L', 'norm'): cut(ld, r0 - off, NORM), ('R', 'raw'): cut(rd, r0, None), ('L', 'raw'): cut(ld, r0 - off, None)}
for k in (('R', 'raw'), ('L', 'raw')): AUD[k] = np.clip(AUD[k] / (np.percentile(np.abs(AUD[k]), 99.9) + 1e-9) * 0.5, -1, 1).astype(np.float32)
# the hint of way E: padel words, and the first names of the players when PLAYERS has them (comma separated)
HINT = 'A padel match. ' + (('The players are ' + ', '.join(os.environ['PLAYERS'].split(',')) + '. ') if os.environ.get('PLAYERS') else '') + 'Fifteen love. Thirty all. Forty thirty. Deuce. Advantage. Game. Out. Mine. Yours.'
_m = {}
def whisper(x, size='large-v3-turbo', **kw):
    from faster_whisper import WhisperModel
    if size not in _m: _m[size] = WhisperModel(size, device='cpu', compute_type='int8', cpu_threads=4)
    kw.setdefault('language', 'en')
    segs, info = _m[size].transcribe(x, beam_size=5, condition_on_previous_text=False, word_timestamps=True, **kw); words = []; lines = []
    for g in segs:
        lines.append({'t0': round(g.start, 1), 't1': round(g.end, 1), 'text': g.text.strip(), 'lp': round(g.avg_logprob, 2)})
        for w in g.words or []: words.append({'t': round(w.start, 2), 'w': w.word.strip(), 'p': round(w.probability, 2)})
    return {'lines': lines, 'words': words, 'language': info.language}
def scribe(x):
    host, header, key = os.environ['elevenHost'], os.environ['elevenHeader'], os.environ['elevenValue']
    buf = io.BytesIO(); w = wave.open(buf, 'wb'); w.setnchannels(1); w.setsampwidth(2); w.setframerate(16000); w.writeframes((np.clip(x, -1, 1) * 32767).astype(np.int16).tobytes()); w.close()
    bd = uuid.uuid4().hex; parts = []
    for k, v in (('model_id', os.environ.get('SCRIBE_MODEL', 'scribe_v1')), ('tag_audio_events', 'true'), ('diarize', 'true'), ('timestamps_granularity', 'word')):
        parts.append(f'--{bd}\r\nContent-Disposition: form-data; name="{k}"\r\n\r\n{v}\r\n'.encode())
    parts.append(f'--{bd}\r\nContent-Disposition: form-data; name="file"; filename="a.wav"\r\nContent-Type: audio/wav\r\n\r\n'.encode() + buf.getvalue() + f'\r\n--{bd}--\r\n'.encode())
    rq = urllib.request.Request(f'https://{host}/v1/speech-to-text', data=b''.join(parts), headers={header: key, 'Content-Type': f'multipart/form-data; boundary={bd}'})
    try:
        with urllib.request.urlopen(rq, timeout=600) as r: j = json.load(r)
    except urllib.error.HTTPError as e: return {'error': e.code, 'body': e.read().decode()[:300], 'lines': [], 'words': []}
    ws = [{'t': round(w.get('start', 0), 2), 'w': w['text'].strip(), 'p': None, 'who': w.get('speaker_id'), 'kind': w.get('type')} for w in j.get('words', []) if w.get('type') != 'spacing' and w['text'].strip()]
    return {'lines': [{'t0': 0, 't1': dur, 'text': j.get('text', '')}], 'words': [w for w in ws if w['kind'] == 'word'], 'events': [w for w in ws if w['kind'] != 'word'], 'language': j.get('language_code')}
RUN = {
    'A': lambda s: whisper(AUD[(s, 'norm')]),
    'B': lambda s: whisper(AUD[(s, 'raw')]),
    'C': lambda s: whisper(AUD[(s, 'norm')], vad_filter=True, vad_parameters={'threshold': 0.1, 'min_silence_duration_ms': 300, 'speech_pad_ms': 400}),
    'D': lambda s: whisper(AUD[(s, 'norm')], size='small'),
    'E': lambda s: whisper(AUD[(s, 'norm')], initial_prompt=HINT),
    'F': lambda s: whisper(AUD[(s, 'norm')], language=None, multilingual=True),
    'G': lambda s: scribe(AUD[(s, 'norm')]),
}
for m in want:
    for s in ('R', 'L'):
        p = f'{out}/{m}-{s}.json'
        if os.path.exists(p): continue
        t = time.time()
        try: r = RUN[m](s)
        except Exception as e: r = {'error': repr(e)[:300], 'lines': [], 'words': []}
        r['seconds'] = round(time.time() - t, 1); json.dump(r, open(p, 'w'))
        print(m, s, 'words', len(r['words']), 'seconds', r['seconds'], r.get('error', ''), flush=True)
print('COMPARE_DONE')
