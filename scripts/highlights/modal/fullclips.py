"""The clips of a fast reel from the whole film on the store, by hand: what the reel job's step "clips" makes, with no join.

usage: modal run fullclips.py --video uploads/<token>/video.mov --work <the job's work folder, e.g. test/full/work>
                              --stretches stretches.json        ([[start, end], ...] in seconds of the film)

Since 27 November 2026 the reel job does this itself for a whole film (fastreel.py, "A whole film": the stretches from
the film's sound, then the same work). Use this file when a person chooses the stretches. The work is in
`film_clips.py` (beside the engine's scripts), shared with the job: each stretch decoded from the camera file by its own
machine, then one join. Start the job after it with the same work folder ("video" in the request must still name a
file); it then skips its step "clips".

It also writes film.json: where each clip sits in the film ([start, end] in seconds), for meta.json "times".
"""
import modal, os, json

HL = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
app = modal.App(os.environ.get('FULLCLIPS_APP', 'kicksmash-fullclips'))
vol = modal.Volume.from_name('kicksmash-matches')
image = (modal.Image.from_registry('ubuntu:24.04', add_python='3.11').apt_install('ffmpeg')
         .add_local_file(f'{HL}/film_clips.py', '/root/hl/film_clips.py'))


def engine():
    import sys; sys.path.insert(0, '/root/hl'); import film_clips
    return film_clips


@app.function(image=image, volumes={'/vol': vol}, cpu=8, memory=12288, timeout=1800, max_containers=16)
def clean_stretch(job):
    """One stretch of the film as a 4K piece and a 1080p piece at half the frame rate, and its sound."""
    vol.reload(); r = engine().clean_stretch(*job); vol.commit()
    return r


@app.function(image=image, volumes={'/vol': vol}, cpu=4, memory=4096, timeout=1800)
def join(W, stretches, info, parts):
    """The pieces into clean4k.mp4 and proxy.mp4 with the sound, 3 frames a second, and stretches.json (as join_clean)."""
    vol.reload(); r = engine().join(W, stretches, info, parts); vol.commit()
    return r


@app.function(image=image, volumes={'/vol': vol}, cpu=1, memory=1024, timeout=300)
def info_of(video):
    vol.reload(); return engine().probe(video)


@app.local_entrypoint()
def main(video: str, work: str, stretches: str):
    import sys; sys.path.insert(0, HL); import film_clips
    try: S = film_clips.checked(json.load(open(stretches)))
    except ValueError as e: raise SystemExit(str(e))
    V = '/vol/' + video.lstrip('/'); W = '/vol/' + work.strip('/')
    info = info_of.remote(V)
    parts = sorted(clean_stretch.map([(V, i, a, b, info, W) for i, (a, b) in enumerate(S)]), key=lambda p: p['i'])
    print(json.dumps({'info': info, 'parts': parts, 'join': join.remote(W, S, info, parts)}, indent=1))
