"""The reel host: plays a finished reel from the store under a name nobody can guess, takes a player's match video
in parts, and deletes what is old.

deploy: modal deploy serve.py        (two web functions, one worker, one daily job; `web`'s address goes in the match's row)
put:    modal volume put kicksmash-matches <reel.mp4> reels/<token>/tall.mp4

A reel is reels/<token>/<name>.mp4 on the store. The token is the only key: 22 characters or more, made for one match,
kept in that match's row in Kicksmash and shown only to the players of the match.

`web`, for everybody who has the address of a reel:
GET /r/<token>/<name>.mp4         plays. A phone asks for parts of the file (Range), so each answer is one part.
GET /r/<token>/<name>.mp4?dl=1    saves: the same file with "Content-Disposition: attachment".
GET /r/<token>/versus.jpg         a frame of the reel's opening: the match card's background when there is no court photo.
GET /                             says "ok", for a check that the host is up.

`up`, for a player with a ticket (the owner, 23 November 2026: "allow players to upload to our Modal rented server ...
and we delete it after 7 days"). Kicksmash signs the ticket with its Ed25519 key, and this host checks it with the
public half, so the two share no secret. Every request carries "Authorization: Bearer <ticket>".
PUT  /u/<token>/<n>               one part of the file, n from 0. A request may be 4 GiB and 150 seconds at most
                                  (Modal's limits), so the page sends parts of 32 MB and sends a failed part again.
GET  /u/<token>                   the parts that are here, so an upload that stopped goes on where it was.
GET  /usage                       {"bytes", "at"}: what the whole store holds, measured by the daily job. No ticket.
POST /u/<token>/finish            {"parts": n, "bytes": total, "name": "IMG_1234.MOV"}: every part is here; `assemble`
                                  joins them to uploads/<token>/video.<ext> and tells Kicksmash. When Kicksmash answers
                                  with "fastReel" (the start request of fastreel.py), the fast reel starts at once.
POST /u/<token>/names             {"names": {"<track>": "<player id>"}}: the players' answer to reels/<token>/names.json
                                  (fastreel.py stops there when it is not sure who is who); the fast reel goes on.
GET  /r/<token>/names.json        (on `web`) what fastreel.py asks, beside face-<n>.jpg; never cached.

The daily job deletes a reel 30 days after its newest file, and a player's match video 7 days after its newest file.
It looks in reels/ and uploads/ only, never in a match folder.
A machine starts when somebody asks and stops minutes after the last request, so a quiet day costs nothing.
`up` is one machine at most: a machine sees its own writes at once and another machine's only after a reload, so
two machines would each hold half of the parts of one upload.

REELS_APP, KICKSMASH_URL and TICKET_PUBLIC_KEY (64 hex) are read when you deploy: a test deployment gets its own
name and a test key. With no key given, the host reads Kicksmash's public key from /.well-known/kicksmash-passport.json.
"""
import modal

import os

SETTINGS = {'REELS_APP': os.environ.get('REELS_APP', 'kicksmash-reels'), 'KICKSMASH_URL': os.environ.get('KICKSMASH_URL', 'https://kicksma.sh'), 'TICKET_PUBLIC_KEY': os.environ.get('TICKET_PUBLIC_KEY', ''),
            'FASTREEL_APP': os.environ.get('FASTREEL_APP', 'kicksmash-fastreel')}
app = modal.App(SETTINGS['REELS_APP'])
vol = modal.Volume.from_name('kicksmash-matches')
settings = modal.Secret.from_dict(SETTINGS)
image = modal.Image.debian_slim(python_version='3.11').pip_install('fastapi[standard]==0.115.6', 'cryptography==44.0.0')
KEEP_DAYS = {'reels': 30, 'uploads': 7}
PART = 1 << 20
PART_MAX = 64 << 20          # one part of an upload, at most
UPLOAD_MAX = 80 << 30        # one match video, at most (a 4K film of 97 minutes is 44 GB)
TICKET_PREFIX = 'kicksmash-reel-upload.'


def b64url(s):
    import base64
    return base64.urlsafe_b64decode(s + '=' * (-len(s) % 4))


def read_ticket(ticket, token, public_hex, now):
    """What a ticket allows, or None. A ticket is `<payload>.<signature>`, both base64url: the payload is JSON with
    `t` (the upload's token), `exp` (seconds) and `max` (bytes), and Kicksmash's Ed25519 key signs
    `kicksmash-reel-upload.<payload>`. Pure but for the check of the signature."""
    import json
    from cryptography.exceptions import InvalidSignature
    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
    try:
        body, sig = (ticket or '').split('.')
        Ed25519PublicKey.from_public_bytes(bytes.fromhex(public_hex)).verify(b64url(sig), (TICKET_PREFIX + body).encode())
        t = json.loads(b64url(body))
    except (ValueError, InvalidSignature, TypeError):
        return None
    if not isinstance(t, dict) or t.get('t') != token or not isinstance(t.get('exp'), (int, float)) or t['exp'] <= now: return None
    return {'max': min(int(t.get('max') or UPLOAD_MAX), UPLOAD_MAX)}


def names_error(asked, got):
    """Why an answer to names.json is refused, or None. Each asked track needs a player of the upload; no track that
    was not shown; no player on two tracks, counting the tracks the machine was sure of. Pure."""
    ids = {p['id'] for p in asked.get('players', [])}; tracks = {str(t['track']): t for t in asked.get('tracks', [])}
    ask = {k for k, t in tracks.items() if t.get('ask')}
    if not got or set(got) - set(tracks): return 'tracks'
    if ask - set(got): return 'missing'
    if set(got.values()) - ids: return 'player'
    final = {k: got.get(k, t.get('guess')) for k, t in tracks.items()}
    return 'twice' if len(set(final.values())) != len(final) else None


def file_ext(name):
    """The ending of the player's file when it is a film's, else `mov`. Never a path. Pure."""
    import re
    m = re.search(r'\.([A-Za-z0-9]{2,4})$', name or '')
    return m.group(1).lower() if m and m.group(1).lower() in ('mov', 'mp4', 'm4v', 'mkv') else 'mov'


def byte_range(header, size):
    """`bytes=a-b`, `bytes=a-` or `bytes=-n` as (first, last), None for a header that is not one range, and
    'bad' for a range outside the file. Pure."""
    import re
    m = re.fullmatch(r'bytes=(\d*)-(\d*)', (header or '').strip())
    if not m or (m.group(1) == '' and m.group(2) == ''): return None
    if m.group(1) == '':
        n = int(m.group(2)); return (max(0, size - n), size - 1) if n > 0 and size > 0 else 'bad'
    a = int(m.group(1)); b = int(m.group(2)) if m.group(2) else size - 1
    return (a, min(b, size - 1)) if a <= b and a < size else 'bad'


@app.function(image=image, volumes={'/vol': vol}, cpu=0.5, memory=512, max_containers=2, scaledown_window=120, timeout=600)
@modal.concurrent(max_inputs=30)
@modal.asgi_app()
def web():
    import re
    from fastapi import FastAPI, Request
    from fastapi.responses import PlainTextResponse, Response, StreamingResponse
    api = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)
    TOKEN, NAME = re.compile(r'[A-Za-z0-9_-]{22,64}'), re.compile(r'[a-z0-9-]{1,24}\.(mp4|jpg)|names\.json')

    def parts(path, first, last):
        with open(path, 'rb') as f:
            f.seek(first); left = last - first + 1
            while left > 0:
                b = f.read(min(PART, left))
                if not b: break
                left -= len(b); yield b

    @api.get('/')
    def up(): return PlainTextResponse('ok')

    @api.api_route('/r/{token}/{name}', methods=['GET', 'HEAD'])
    def reel(token: str, name: str, request: Request, dl: int = 0):
        if not TOKEN.fullmatch(token) or not NAME.fullmatch(name): return Response(status_code=404)
        path = f'/vol/reels/{token}/{name}'
        if not os.path.isfile(path):
            # A reel that was put after this machine started is not in its view of the store yet.
            try: vol.reload()
            except Exception: pass
            if not os.path.isfile(path): return Response(status_code=404)
        size = os.path.getsize(path)
        # The reel's two films, and versus.jpg: a frame of the opening, the match card's background without a court photo.
        kind = 'image/jpeg' if name.endswith('.jpg') else 'application/json' if name.endswith('.json') else 'video/mp4'
        # names.json changes when the players answer and the reel goes on: it is never kept by a browser
        head = {'Accept-Ranges': 'bytes', 'Content-Type': kind, 'Cache-Control': 'no-store' if kind == 'application/json' else 'private, max-age=3600', 'X-Robots-Tag': 'noindex'}
        if dl: head['Content-Disposition'] = f'attachment; filename="kicksmash-{name}"'
        # The match page reads the file itself to hand it to the phone's share sheet ("Save Video"), so the
        # answer may be read by a page of another origin. The token in the path is the only key either way.
        head['Access-Control-Allow-Origin'] = '*'
        head['Access-Control-Expose-Headers'] = 'Content-Length, Content-Range'
        r = byte_range(request.headers.get('range'), size)
        if r == 'bad': return Response(status_code=416, headers={'Content-Range': f'bytes */{size}'})
        first, last = r or (0, size - 1); status = 206 if r else 200
        if r: head['Content-Range'] = f'bytes {first}-{last}/{size}'
        head['Content-Length'] = str(last - first + 1)
        if request.method == 'HEAD': return Response(status_code=status, headers=head)
        return StreamingResponse(parts(path, first, last), status_code=status, headers=head)

    return api


@app.function(image=image, volumes={'/vol': vol}, secrets=[settings], cpu=1, memory=1024, max_containers=1, scaledown_window=300, timeout=900)
@modal.concurrent(max_inputs=24)
@modal.asgi_app()
def up():
    import json, re, time, urllib.request
    import anyio
    from fastapi import FastAPI, Request
    from fastapi.middleware.cors import CORSMiddleware
    from fastapi.responses import JSONResponse
    api = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)
    home = os.environ['KICKSMASH_URL'].rstrip('/')
    api.add_middleware(CORSMiddleware, allow_origins=[home], allow_methods=['GET', 'PUT', 'POST'], allow_headers=['authorization', 'content-type'], max_age=3600)
    TOKEN = re.compile(r'[A-Za-z0-9_-]{22,64}')
    key = {'hex': os.environ.get('TICKET_PUBLIC_KEY', '')}

    def public_key():
        if not key['hex']:
            with urllib.request.urlopen(f'{home}/.well-known/kicksmash-passport.json', timeout=15) as r: key['hex'] = json.load(r)['keys'][0]['hex']
        return key['hex']

    def allowed(request, token):
        if not TOKEN.fullmatch(token): return None
        ticket = (request.headers.get('authorization') or '').removeprefix('Bearer ').strip()
        t = read_ticket(ticket, token, public_key(), time.time())
        return {**t, 'ticket': ticket} if t else None

    def have(token):
        d = f'/vol/uploads/{token}/parts'
        return {int(n): os.path.getsize(os.path.join(d, n)) for n in os.listdir(d) if n.isdigit()} if os.path.isdir(d) else {}

    def done(token):
        d = f'/vol/uploads/{token}'
        return os.path.isfile(f'{d}/meta.json') or any(n.startswith('video.') for n in (os.listdir(d) if os.path.isdir(d) else []))

    no = JSONResponse({'error': 'unauthorized'}, status_code=401)

    @api.get('/usage')
    def usage():
        # One number and its time, written by the daily job. No name of a file, a match or a player.
        try:
            with open('/vol/usage.json') as f: return json.load(f)
        except (OSError, ValueError): return JSONResponse({'error': 'not measured yet'}, status_code=404)

    @api.get('/u/{token}')
    def state(token: str, request: Request):
        if not allowed(request, token): return no
        return {'parts': have(token), 'done': done(token)}

    @api.put('/u/{token}/{index}')
    async def part(token: str, index: int, request: Request):
        t = allowed(request, token)
        if not t: return no
        if index < 0 or index >= 20000: return JSONResponse({'error': 'index'}, status_code=400)
        if done(token): return JSONResponse({'error': 'finished'}, status_code=409)
        d = f'/vol/uploads/{token}/parts'; os.makedirs(d, exist_ok=True)
        room = t['max'] - sum(v for k, v in have(token).items() if k != index)
        tmp = f'{d}/{index}.tmp-{time.time_ns()}'; n = 0; f = await anyio.to_thread.run_sync(open, tmp, 'wb')
        try:
            async for chunk in request.stream():
                n += len(chunk)
                if n > PART_MAX or n > room: break
                await anyio.to_thread.run_sync(f.write, chunk)
        finally:
            await anyio.to_thread.run_sync(f.close)
        if n > PART_MAX or n > room or n == 0:
            os.remove(tmp); return JSONResponse({'error': 'empty' if n == 0 else 'too_large'}, status_code=413 if n else 400)
        os.replace(tmp, f'{d}/{index}')
        return {'ok': True, 'bytes': n}

    @api.post('/u/{token}/names')
    async def names(token: str, request: Request):
        # The players' answer to reels/<token>/names.json (fastreel.py): {"names": {"<track>": "<player id>"}}. The ticket
        # is one Kicksmash signs for this upload, as for its parts. Every asked track gets a player of the upload, no
        # player twice; the fast reel then goes on (`resume` in fastreel.py).
        if not allowed(request, token): return no
        try:       # read from the store itself: names.json was written by another machine after this one started
            data = b''
            async for chunk in vol.read_file.aio(f'reels/{token}/names.json'): data += chunk
            asked = json.loads(data)
        except Exception:
            return JSONResponse({'error': 'not_asked'}, status_code=404)
        body = await request.json()
        got = {str(k): str(v) for k, v in ((body or {}).get('names') or {}).items()} if isinstance(body, dict) else {}
        err = names_error(asked, got)
        if err: return JSONResponse({'error': err}, status_code=400)
        await modal.Function.from_name(os.environ['FASTREEL_APP'], 'resume').spawn.aio(token, got)
        return {'ok': True}

    @api.post('/u/{token}/finish')
    async def finish(token: str, request: Request):
        t = allowed(request, token)
        if not t: return no
        if done(token): return {'ok': True, 'again': True}
        body = await request.json()
        n, total = int(body.get('parts', 0)), int(body.get('bytes', 0)); here = have(token)
        missing = [i for i in range(n) if i not in here]
        if n <= 0 or missing or sum(here[i] for i in range(n)) != total:
            return JSONResponse({'error': 'incomplete', 'missing': missing[:50], 'bytes': sum(here.get(i, 0) for i in range(n))}, status_code=409)
        meta = {'parts': n, 'bytes': total, 'ext': file_ext(str(body.get('name', ''))), 'ticket': t['ticket'], 'finished': time.time()}
        with open(f'/vol/uploads/{token}/meta.json', 'w') as f: json.dump(meta, f)
        await vol.commit.aio()      # the worker is another machine: it sees what is committed
        await assemble.spawn.aio(token)
        return {'ok': True}

    return api


@app.function(image=image, volumes={'/vol': vol}, secrets=[settings], cpu=2, memory=2048, timeout=3600, max_containers=3)
def assemble(token: str):
    """Join the parts of one upload into the film, delete the parts, and tell Kicksmash that the video is here."""
    import json, shutil, urllib.request
    vol.reload()
    d = f'/vol/uploads/{token}'; meta = json.load(open(f'{d}/meta.json')); out = f"{d}/video.{meta['ext']}"
    if not os.path.isfile(out) or os.path.getsize(out) != meta['bytes']:
        with open(out + '.tmp', 'wb') as w:
            for i in range(meta['parts']):
                with open(f'{d}/parts/{i}', 'rb') as r: shutil.copyfileobj(r, w, 16 << 20)
        if os.path.getsize(out + '.tmp') != meta['bytes']: raise RuntimeError(f"the film has {os.path.getsize(out + '.tmp')} bytes, the page said {meta['bytes']}")
        os.replace(out + '.tmp', out)
    shutil.rmtree(f'{d}/parts', ignore_errors=True)
    ticket = meta.pop('ticket', None)
    with open(f'{d}/meta.json', 'w') as f: json.dump({**meta, 'joined': True}, f)   # the ticket's work is done: it is not kept
    vol.commit()
    told, start = None, None
    if ticket:
        req = urllib.request.Request(os.environ['KICKSMASH_URL'].rstrip('/') + '/api/reel/upload', data=json.dumps({'ticket': ticket, 'bytes': meta['bytes']}).encode(), headers={'content-type': 'application/json'}, method='POST')
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                told = r.status
                try: start = (json.load(r) or {}).get('fastReel')
                except ValueError: start = None
        except Exception as e: told = f'failed: {e}'
    # Kicksmash answers the clips of a fast reel with its start request (fastreel.py: the matches, the players, the
    # music). The reel is made at once, with no person.
    if isinstance(start, dict) and start.get('matches'):
        modal.Function.from_name(os.environ['FASTREEL_APP'], 'make').spawn({**start, 'upload': token, 'dry': False})
    print('joined', meta['bytes'], 'bytes; Kicksmash answered', told, '; fast reel started' if start else '')
    return {'bytes': meta['bytes'], 'told': told, 'fast_reel': bool(start)}


@app.function(image=image, volumes={'/vol': vol}, cpu=0.25, memory=256, timeout=900, schedule=modal.Cron('17 20 * * *'))
def sweep(dry: bool = False):
    """Delete what is past its days. `modal run serve.py::sweep --dry` lists it and deletes nothing."""
    import json, shutil, time
    now = time.time(); gone = []
    for top, days in KEEP_DAYS.items():
        root = f'/vol/{top}'
        for name in sorted(os.listdir(root)) if os.path.isdir(root) else []:
            folder = os.path.join(root, name)
            if not os.path.isdir(folder): continue
            times = [os.path.getmtime(os.path.join(d, f)) for d, _, fs in os.walk(folder) for f in fs] or [os.path.getmtime(folder)]
            age = (now - max(times)) / 86400
            if age > days:
                gone.append((f'{top}/{name}', round(age, 1)))
                if not dry: shutil.rmtree(folder)
    # The weight of the whole store, once a day, for Kicksmash's service board (GET /usage on `up`): the first
    # 1 TiB of a month costs nothing, and the owner hears before the store is near it.
    total = sum(os.path.getsize(os.path.join(d, f)) for d, _, fs in os.walk('/vol') for f in fs if not os.path.islink(os.path.join(d, f)))
    if not dry:
        with open('/vol/usage.json', 'w') as f: json.dump({'bytes': total, 'at': int(now)}, f)
        vol.commit()
    print('dry run' if dry else 'deleted', gone, '| the store holds', round(total / 2 ** 30, 1), 'GiB')
    return {'gone': gone, 'bytes': total}
