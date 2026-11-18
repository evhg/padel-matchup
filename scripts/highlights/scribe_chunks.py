"""Write down speech with ElevenLabs Scribe, in short pieces. One long file of far voices comes back as one
"[background noise]" tag and is still charged; pieces of twenty seconds with the level raised come back as text.

usage: scribe_chunks.py <dir with WAV files> <start s> <seconds> <out.json> [model=scribe_v3] [piece=20] [gain_db=30]
Output: {"words": [{"t", "w", "who", "kind"}], "pieces": [{"t0", "text"}], "audio_s"}; times are from <start>.
The key comes from the environment (elevenHost, elevenHeader, elevenValue) and is never printed.
"""
import sys, os, glob, json, uuid, subprocess, urllib.request, soundfile as sf
d, t0, dur, out = sys.argv[1], float(sys.argv[2]), float(sys.argv[3]), sys.argv[4]
model = sys.argv[5] if len(sys.argv) > 5 else 'scribe_v3'; piece = float(sys.argv[6]) if len(sys.argv) > 6 else 20.0; gain = sys.argv[7] if len(sys.argv) > 7 else '30'
host, header, key = os.environ['elevenHost'], os.environ['elevenHeader'], os.environ['elevenValue']
files = []; base = 0.0
for f in sorted(x for x in glob.glob(d + '/*.WAV') if sf.info(x).duration > 20): n = sf.info(f).duration; files.append((base, n, f)); base += n
def clip(a, n):
    for b, ln, f in files:
        if b <= a < b + ln:
            return subprocess.run(['ffmpeg', '-v', 'error', '-nostdin', '-ss', f'{a - b}', '-t', f'{n}', '-i', f, '-af', f'highpass=f=120,volume={gain}dB,alimiter=limit=0.9', '-ar', '16000', '-ac', '1', '-f', 'wav', '-'], capture_output=True, check=True).stdout
def ask(data):
    bd = uuid.uuid4().hex; parts = [f'--{bd}\r\nContent-Disposition: form-data; name="{k}"\r\n\r\n{v}\r\n'.encode() for k, v in (('model_id', model), ('language_code', 'en'), ('tag_audio_events', 'true'), ('diarize', 'true'))]
    parts.append(f'--{bd}\r\nContent-Disposition: form-data; name="file"; filename="a.wav"\r\nContent-Type: audio/wav\r\n\r\n'.encode() + data + f'\r\n--{bd}--\r\n'.encode())
    rq = urllib.request.Request(f'https://{host}/v1/speech-to-text', data=b''.join(parts), headers={header: key, 'Content-Type': f'multipart/form-data; boundary={bd}'})
    for k in range(3):
        try:
            with urllib.request.urlopen(rq, timeout=180) as r: return json.load(r)
        except urllib.error.HTTPError as e:
            if e.code not in (429, 500, 502, 503): return {'error': e.code, 'body': e.read().decode()[:200]}
        except Exception as e: err = repr(e)[:120]
    return {'error': 'no answer'}
res = json.load(open(out)) if os.path.exists(out) else {'words': [], 'pieces': [], 'audio_s': 0.0, 'model': model}
done = {p['t0'] for p in res['pieces']}; a = 0.0
while a < dur:
    n = min(piece, dur - a)
    if a not in done and n >= 1:
        j = ask(clip(t0 + a, n))
        if 'error' in j: print('piece', a, j); break
        for w in j.get('words') or []:
            if w.get('type') != 'spacing' and w['text'].strip(): res['words'].append({'t': round(a + (w.get('start') or 0), 2), 'w': w['text'].strip(), 'who': w.get('speaker_id'), 'kind': w.get('type')})
        res['pieces'].append({'t0': a, 'text': j.get('text', '')}); res['audio_s'] += n; json.dump(res, open(out, 'w'))
        print(f'{a:6.0f}  {j.get("text", "")[:150]}', flush=True)
    a += piece
print('SCRIBE_DONE words', sum(1 for w in res['words'] if w['kind'] == 'word'), 'seconds of sound', res['audio_s'])
