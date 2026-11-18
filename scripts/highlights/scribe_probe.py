"""Send one clip to ElevenLabs Scribe with chosen settings and print the whole answer (never the key).
usage: scribe_probe.py <audio file> [name=value ...]     e.g. model_id=scribe_v1 diarize=true"""
import sys, os, json, uuid, urllib.request, mimetypes
f = sys.argv[1]; fields = dict(a.split('=', 1) for a in sys.argv[2:]); fields.setdefault('model_id', 'scribe_v1')
host, header, key = os.environ['elevenHost'], os.environ['elevenHeader'], os.environ['elevenValue']
bd = uuid.uuid4().hex; parts = [f'--{bd}\r\nContent-Disposition: form-data; name="{k}"\r\n\r\n{v}\r\n'.encode() for k, v in fields.items()]
parts.append(f'--{bd}\r\nContent-Disposition: form-data; name="file"; filename="{os.path.basename(f)}"\r\nContent-Type: {mimetypes.guess_type(f)[0] or "application/octet-stream"}\r\n\r\n'.encode() + open(f, 'rb').read() + f'\r\n--{bd}--\r\n'.encode())
rq = urllib.request.Request(f'https://{host}/v1/speech-to-text', data=b''.join(parts), headers={header: key, 'Content-Type': f'multipart/form-data; boundary={bd}'})
try:
    with urllib.request.urlopen(rq, timeout=600) as r: j = json.load(r); print('status', r.status)
except urllib.error.HTTPError as e: print('HTTP', e.code, e.read().decode()[:600]); sys.exit(0)
w = j.get('words') or []
print({k: (v if not isinstance(v, (list, dict)) else f'<{type(v).__name__} {len(v)}>') for k, v in j.items()})
print('text:', (j.get('text') or '')[:600])
print('kinds:', {t: sum(1 for x in w if x.get('type') == t) for t in {x.get('type') for x in w}})
