"""Listen to the seconds before each point with a paid speech-to-text service (ElevenLabs Scribe), to find spoken scores.
usage: scribe.py <audio.raw (mono f32le 48 kHz)> <audio.json> <out.json> <first point> <last point> [seconds before=12]
The key comes from the environment (elevenHost, elevenHeader, elevenValue) and is never printed."""
import sys, os, json, io, wave, subprocess, numpy as np, urllib.request, uuid
raw, af, out, i0, i1 = sys.argv[1], sys.argv[2], sys.argv[3], int(sys.argv[4]), int(sys.argv[5]); before = float(sys.argv[6]) if len(sys.argv) > 6 else 12.0
A = json.load(open(af)); SR = 48000; mm = np.memmap(raw, np.float32, 'r')
host, header, key = os.environ['elevenHost'], os.environ['elevenHeader'], os.environ['elevenValue']
MODEL = os.environ.get('SCRIBE_MODEL', 'scribe_v1')
def wav_of(a, b):
    x = np.array(mm[int(a * SR):int(b * SR)])[::3].astype(np.float64)        # 16 kHz
    x = x / (np.percentile(np.abs(x), 99.7) + 1e-9) * 0.6; x = np.clip(x, -1, 1)
    buf = io.BytesIO(); w = wave.open(buf, 'wb'); w.setnchannels(1); w.setsampwidth(2); w.setframerate(16000); w.writeframes((x * 32767).astype(np.int16).tobytes()); w.close()
    return buf.getvalue()
def ask(data):
    bd = uuid.uuid4().hex; parts = []
    for k, v in (('model_id', MODEL), ('language_code', 'en'), ('tag_audio_events', 'false'), ('timestamps_granularity', 'none')):
        parts.append(f'--{bd}\r\nContent-Disposition: form-data; name="{k}"\r\n\r\n{v}\r\n'.encode())
    parts.append(f'--{bd}\r\nContent-Disposition: form-data; name="file"; filename="a.wav"\r\nContent-Type: audio/wav\r\n\r\n'.encode() + data + f'\r\n--{bd}--\r\n'.encode())
    rq = urllib.request.Request(f'https://{host}/v1/speech-to-text', data=b''.join(parts), headers={header: key, 'Content-Type': f'multipart/form-data; boundary={bd}'})
    try:
        with urllib.request.urlopen(rq, timeout=120) as r: return json.load(r)
    except urllib.error.HTTPError as e: return {'error': e.code, 'body': e.read().decode()[:300]}
res = json.load(open(out)) if os.path.exists(out) else {}
for i in range(i0, min(i1 + 1, len(A['points']))):
    if str(i) in res: continue
    p = A['points'][i]; a, b = max(0.0, p['firstHit'] - before), p['firstHit'] + 0.4
    r = ask(wav_of(a, b))
    if 'error' in r: print('point', i, 'error', r['error'], r['body']); break
    res[str(i)] = {'t': p['firstHit'], 'text': r.get('text', ''), 'p': r.get('language_probability')}
    print(f"{i:3d}  {int(p['firstHit'] // 60)}:{p['firstHit'] % 60:04.1f}  {r.get('text', '')[:160]}", flush=True)
    json.dump(res, open(out, 'w'))
