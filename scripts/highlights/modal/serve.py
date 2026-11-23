"""The reel host: plays a finished reel from the store under a name nobody can guess, and deletes what is old.

deploy: modal deploy serve.py        (one web function and one daily job; the address it prints goes in the match's row)
put:    modal volume put kicksmash-matches <reel.mp4> reels/<token>/tall.mp4

A reel is reels/<token>/<name>.mp4 on the store. The token is the only key: 22 characters or more, made for one match,
kept in that match's row in Kicksmash and shown only to the players of the match.

GET /r/<token>/<name>.mp4         plays. A phone asks for parts of the file (Range), so each answer is one part.
GET /r/<token>/<name>.mp4?dl=1    saves: the same file with "Content-Disposition: attachment".
GET /                             says "ok", for a check that the host is up.

The daily job deletes a reel 30 days after its newest file, and a player's match video 7 days after its newest file
(uploads/<token>/, the owner's rule of 23 November 2026). It looks in those two folders only, never in a match folder.
A machine starts when somebody asks and stops two minutes after the last request, so a quiet day costs nothing.
"""
import modal

app = modal.App('kicksmash-reels')
vol = modal.Volume.from_name('kicksmash-matches')
image = modal.Image.debian_slim(python_version='3.11').pip_install('fastapi[standard]==0.115.6')
KEEP_DAYS = {'reels': 30, 'uploads': 7}
PART = 1 << 20


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
    import os, re
    from fastapi import FastAPI, Request
    from fastapi.responses import PlainTextResponse, Response, StreamingResponse
    api = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)
    TOKEN, NAME = re.compile(r'[A-Za-z0-9_-]{22,64}'), re.compile(r'[a-z0-9-]{1,24}\.mp4')

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
        head = {'Accept-Ranges': 'bytes', 'Content-Type': 'video/mp4', 'Cache-Control': 'private, max-age=3600', 'X-Robots-Tag': 'noindex'}
        if dl: head['Content-Disposition'] = f'attachment; filename="kicksmash-{name}"'
        r = byte_range(request.headers.get('range'), size)
        if r == 'bad': return Response(status_code=416, headers={'Content-Range': f'bytes */{size}'})
        first, last = r or (0, size - 1); status = 206 if r else 200
        if r: head['Content-Range'] = f'bytes {first}-{last}/{size}'
        head['Content-Length'] = str(last - first + 1)
        if request.method == 'HEAD': return Response(status_code=status, headers=head)
        return StreamingResponse(parts(path, first, last), status_code=status, headers=head)

    return api


@app.function(image=image, volumes={'/vol': vol}, cpu=0.25, memory=256, timeout=900, schedule=modal.Cron('17 20 * * *'))
def sweep(dry: bool = False):
    """Delete what is past its days. `modal run serve.py::sweep --dry` lists it and deletes nothing."""
    import os, shutil, time
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
    if gone and not dry: vol.commit()
    print('dry run' if dry else 'deleted', gone)
    return gone
