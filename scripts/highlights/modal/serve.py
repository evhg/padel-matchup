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
POST /u/<token>/finish            {"parts": n, "bytes": total, "name": "IMG_1234.MOV", "choices": {...}, "times": {...}}:
                                  every part is here; `assemble` joins them to uploads/<token>/video.<ext> and tells
                                  Kicksmash. When Kicksmash answers with "fastReel" (the start request of fastreel.py),
                                  the reel's job starts at once: for the clips of a fast reel, and since 27 November
                                  2026 for a whole film too ("whole": true). `times` (fast reel only): where each clip sits in the
                                  film and when the film began, {"clips": [[start, end], ...], "recordedAt": ISO,
                                  "recordedFrom": "film" | "file"}, kept in meta.json, so a watch's heart rate lines up
                                  with the clips.
POST /u/<token>/choices           {"teams": [a, b], "crowd": bool, "numbers": bool, "music": "bounce"}: what the player
                                  chose for the reel (`src/lib/domain/reelChoices.ts`), at any time the ticket holds,
                                  also after the finish. Kept in uploads/<token>/choices.json; the reel's job reads it.
POST /u/<token>/names             {"names": {"<track>": "<player id>"}}: the players' answer to reels/<token>/names.json
                                  (fastreel.py stops there when it is not sure who is who); the fast reel goes on.
POST /u/<token>/link              {"file": "<Google Drive file id>"}: a player pasted a Drive link (`setReelLink`). `fetch_link`
                                  fetches the film to uploads/<token>/video.mov, reports its share done to Kicksmash
                                  (/api/reel/fetch) for the page's bar, and then goes on as `assemble` does.
GET  /music/<track>               ten seconds of a reel's track, for the page's "tap to hear". No ticket.
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

import os, re

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

DRIVE_FILE = re.compile(r'[A-Za-z0-9_-]{20,100}')


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


MUSIC = ('bounce', 'dnb', 'bigscreen', 'sunrise', 'none')
TEAM_MAX = 32


def clean_choices(raw):
    """The player's choices for the reel, each one cleaned, or its default: every option on, Bounce. The same rules
    as `cleanChoices` in src/lib/domain/reelChoices.ts; a team name that is not one is None, and the job then
    writes the pair's names. Pure."""
    import re
    o = raw if isinstance(raw, dict) else {}
    t = o.get('teams') if isinstance(o.get('teams'), list) else []

    def team(x):
        v = re.sub(r'\s+', ' ', re.sub(r'[\x00-\x1f\x7f]+', ' ', x)).strip()[:TEAM_MAX] if isinstance(x, str) else ''
        return v or None
    return {'teams': [team(t[0] if len(t) > 0 else None), team(t[1] if len(t) > 1 else None)],
            'crowd': o.get('crowd') is not False, 'numbers': o.get('numbers') is not False,
            'music': o.get('music') if o.get('music') in MUSIC else 'bounce'}


def clean_times(raw):
    """The fast reel's clip times in the film and the film's start, each one checked, or None. Pure."""
    import re
    if not isinstance(raw, dict): return None
    clips = []
    for c in (raw.get('clips') if isinstance(raw.get('clips'), list) else [])[:400]:
        if isinstance(c, list) and len(c) == 2 and all(isinstance(x, (int, float)) for x in c) and 0 <= c[0] < c[1] <= 86400:
            clips.append([round(float(c[0]), 3), round(float(c[1]), 3)])
    at = raw.get('recordedAt')
    at = at if isinstance(at, str) and re.fullmatch(r'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z', at) else None
    return {'clips': clips, 'recordedAt': at, 'recordedFrom': 'film' if raw.get('recordedFrom') == 'film' else 'file'}


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

    def keep_choices(token, raw):
        d = f'/vol/uploads/{token}'; os.makedirs(d, exist_ok=True)
        with open(f'{d}/choices.json.tmp', 'w') as f: json.dump({**clean_choices(raw), 'at': time.time()}, f)
        os.replace(f'{d}/choices.json.tmp', f'{d}/choices.json')

    @api.get('/music/{track}')
    def music(track: str):
        from fastapi.responses import FileResponse, Response as Plain
        path = f'/vol/assets/preview-{track}.m4a'
        if track not in MUSIC or track == 'none' or not os.path.isfile(path): return Plain(status_code=404)
        return FileResponse(path, media_type='audio/mp4', headers={'Cache-Control': 'public, max-age=86400'})

    @api.post('/u/{token}/choices')
    async def choices(token: str, request: Request):
        if not allowed(request, token): return no
        keep_choices(token, await request.json())
        await vol.commit.aio()
        return {'ok': True}

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

    @api.post('/u/{token}/link')
    async def link(token: str, request: Request):
        t = allowed(request, token)
        if not t: return no
        if done(token): return {'ok': True, 'again': True}
        body = await request.json()
        file = str((body or {}).get('file', '')) if isinstance(body, dict) else ''
        if not DRIVE_FILE.fullmatch(file): return JSONResponse({'error': 'file'}, status_code=400)
        d = f'/vol/uploads/{token}'; os.makedirs(d, exist_ok=True)
        with open(f'{d}/link.json', 'w') as f: json.dump({'file': file, 'ticket': t['ticket'], 'max': t['max'], 'at': time.time()}, f)
        await vol.commit.aio()
        await fetch_link.spawn.aio(token)
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
        if 'choices' in body: keep_choices(token, body['choices'])
        if clean_times(body.get('times')): meta['times'] = clean_times(body.get('times'))
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
    return tell_and_start(token, ticket, meta['bytes'])


def tell(path, body, timeout=30):
    """POST JSON to Kicksmash; the answer's status and JSON (or None)."""
    import json, urllib.request
    req = urllib.request.Request(os.environ['KICKSMASH_URL'].rstrip('/') + path, data=json.dumps(body).encode(), headers={'content-type': 'application/json'}, method='POST')
    with urllib.request.urlopen(req, timeout=timeout) as r:
        try: return r.status, json.load(r)
        except ValueError: return r.status, None


def tell_and_start(token, ticket, size):
    """The film is uploads/<token>/video.<ext>: tell Kicksmash, and start the reel's job from its answer."""
    told, start = None, None
    if ticket:
        try:
            told, answer = tell('/api/reel/upload', {'ticket': ticket, 'bytes': size})
            start = (answer or {}).get('fastReel')
        except Exception as e: told = f'failed: {e}'
    # Kicksmash answers with the job's start request (fastreel.py: the matches, the players, the music), for the clips of
    # a fast reel and for a whole film ("whole": true, `fastReelStart`). The reel is made at once, with no person. With
    # no start request (no two pairs of two, or a link), Kicksmash wakes the note desk instead.
    started = isinstance(start, dict) and bool(start.get('matches'))
    if started:
        modal.Function.from_name(os.environ['FASTREEL_APP'], 'make').spawn({**start, 'upload': token, 'dry': False, 'whole': start.get('whole') is True})
    what = ('; reel started' + (' from the whole film' if start.get('whole') is True else ' from the clips')) if started else ''
    print('joined', size, 'bytes; Kicksmash answered', told, what)
    return {'bytes': size, 'told': told, 'fast_reel': started, 'whole': started and start.get('whole') is True}


@app.function(image=image, volumes={'/vol': vol}, secrets=[settings], cpu=1, memory=1024, timeout=4 * 3600, max_containers=3)
def fetch_link(token: str):
    """Fetch a player's Drive file (uploads/<token>/link.json) to uploads/<token>/video.mov, report the share done for the
    page's bar every half minute, and then go on as `assemble` does. A link that gives no film (not shared with "anyone
    with the link": Drive answers with a page) is reported as failed, and the page asks for it again."""
    import json, time, urllib.request
    vol.reload()
    d = f'/vol/uploads/{token}'; ln = json.load(open(f'{d}/link.json')); ticket = ln['ticket']
    out = f'{d}/video.mov'; tmp = out + '.tmp'       # "video." already: a second POST of the link is "done"
    url = f"https://drive.usercontent.google.com/download?id={ln['file']}&export=download&confirm=t"

    def report(**body):
        try: tell('/api/reel/fetch', {'ticket': ticket, **body}, timeout=15)
        except Exception as e: print('report failed:', e, flush=True)

    total, got, t0, last, why = None, 0, time.time(), 0.0, None
    with open(tmp, 'wb') as w:
        for k in range(6):                            # go on where it stopped, when the line breaks
            try:
                req = urllib.request.Request(url, headers={'Range': f'bytes={got}-', 'User-Agent': 'kicksmash-reels'} if got else {'User-Agent': 'kicksmash-reels'})
                with urllib.request.urlopen(req, timeout=60) as r:
                    if got and r.status != 206: w.seek(0); w.truncate(); got = 0
                    if 'text/html' in (r.headers.get('content-type') or ''): why = 'a page, not a film'; break
                    n = r.headers.get('content-length')
                    if n and total is None: total = int(n) + got
                    while True:
                        chunk = r.read(8 << 20)
                        if not chunk: break
                        w.write(chunk); got += len(chunk)
                        if got > ln['max']: why = 'larger than the ticket allows'; break
                        if time.time() - last > 30:
                            last = time.time(); rate = got / max(last - t0, 1)
                            pct = min(99, got * 100 / total) if total else 0
                            report(pct=round(pct), minutesLeft=round((total - got) / rate / 60, 1) if total else 10)
                if why or not total or got >= total: break
            except Exception as e:
                print('fetch stopped:', str(e)[-200:], 'try', k + 1, flush=True); time.sleep(15)
    head = open(tmp, 'rb').read(600) if got else b''
    if not why and (got < 5_000_000 or b'<html' in head.lower() or (total and got < total)): why = f'{got} bytes of {total}'
    if why:
        print('no film:', why, flush=True)
        for f in (tmp, f'{d}/link.json'):
            try: os.remove(f)
            except OSError: pass
        vol.commit(); report(failed=True)
        return {'ok': False, 'why': why}
    os.replace(tmp, out); os.remove(f'{d}/link.json')     # the ticket's work is done: it is not kept
    with open(f'{d}/meta.json', 'w') as f: json.dump({'bytes': got, 'ext': 'mov', 'link': True, 'joined': True, 'fetch_s': round(time.time() - t0)}, f)
    vol.commit()
    print('fetched', got, 'bytes in', round(time.time() - t0), 's', flush=True)
    return tell_and_start(token, ticket, got)


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
