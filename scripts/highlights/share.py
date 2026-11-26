"""The public version of the tall reel, share.mp4: what goes to TikTok and to @kicksma.sh on Instagram.

It is the tall layout without the end card, with the match sound only: no music track and no added crowd, whatever
the player chose, because no licence on record allows a public post of either. Its picture carries no brand:
TikTok's Content Sharing Guidelines forbid "any brand name, logo, watermark, other promotional branding, link or
promotional text" on shared content, and gfx.py draws the brand only on the end card. The opening keeps its own
sound: versus.py makes every effect from numbers, and its voice is Kokoro (Apache 2.0, commercial use permitted).

No part is drawn again and no picture is encoded twice (modal/fastreel.py, finish_layout):
1. `body` reads the join of reel_points.py (its list.txt): how many pictures the parts before the end card hold.
2. The 1080p encode of tall.mp4 takes `key_args(n)`: every picture keeps its own time, and picture n (the first of
   the end card) is a key frame. x264 then codes pictures 0 to n-1 before it, so they are the first n packets.
3. `cut` copies those n packets as they are, and puts the sound of the join under them (the parts' own sound: the
   match, the slow match sound of the replays, the opening), cut at the same moment and set to the reel's level.
   It checks the copy first; when the packets are not exactly pictures 0 to n-1, it encodes those pictures once
   more from the join, and says so.

usage (a test on any machine with ffmpeg): share.py <workdir of reel_points.py> <join.mp4> <tall.mp4> <out.mp4>
"""
import os, sys, json, subprocess

LEVEL = ['-af', 'loudnorm=I=-16:TP=-1.5:LRA=11', '-ar', '48000', '-c:a', 'aac', '-b:a', '192k']     # as the reel's level step


def run(cmd):
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0: raise RuntimeError(f'{os.path.basename(cmd[0])} failed: {(r.stdout + r.stderr)[-800:]}')
    return r.stdout


def frames(path):
    """How many pictures a video file has (its packets, counted without a decode)."""
    return int(run(['ffprobe', '-v', 'error', '-select_streams', 'v:0', '-count_packets', '-show_entries', 'stream=nb_read_packets', '-of', 'csv=p=0', path]).strip().strip(','))


def body(work):
    """-> (pictures before the end card, True when the reel has an end card). The end card is the last part of the
    join, `NN-outro.mp4` (reel_points.py); everything before it is the public reel."""
    parts = [l.strip()[6:-1] for l in open(f'{work}/list.txt') if l.strip().startswith("file '")]
    end = len(parts)
    while end and os.path.splitext(os.path.basename(parts[end - 1]))[0][3:] == 'outro': end -= 1
    return sum(frames(p) for p in parts[:end]), end < len(parts)


def key_args(n):
    """The arguments of the tall 1080p encode: each picture once, with its own time (the default for an mp4 would add a
    copy of a picture at a small gap between two parts, and then picture n of the encode is not picture n of the
    join), and picture n a key frame."""
    return ['-fps_mode', 'passthrough', '-force_key_frames', f'expr:eq(n,{n})']


def packets(path):
    """The video packets in the order of the file: [(time, key frame)]."""
    rows = run(['ffprobe', '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'packet=pts_time,flags', '-of', 'csv=p=0', path]).split()
    return [(float(r.split(',')[0]), 'K' in r.split(',')[1]) for r in rows if r.split(',')[0] not in ('', 'N/A')]


def cut(work, join, tall, out, encode):
    """share.mp4 from tall.mp4 (made with key_args) and the join of the parts. encode: the video arguments of the
    1080p encode, for the case that the copy does not hold. -> 'copied' or 'encoded', and the seconds."""
    n, _ = body(work); pk = packets(tall)
    if not n: raise RuntimeError('no part before the end card')
    ts = sorted(t for t, _ in pk)
    # The copy holds when packet n is a key frame and the first n packets are the n earliest pictures. A reel with no
    # end card (n is every picture) is copied whole, with all of its sound.
    whole = len(pk) == n
    ok = whole or (len(pk) > n and pk[n][1] and max(t for t, _ in pk[:n]) < ts[n])
    until = [] if whole else ['-t', f'{ts[n] - ts[0]:.6f}']
    a = out + '.a.m4a'
    run(['ffmpeg', '-v', 'error', '-nostdin', '-y', '-i', join, '-vn', *until, *LEVEL, a])
    if ok:
        run(['ffmpeg', '-v', 'error', '-nostdin', '-y', '-i', tall, '-i', a, '-map', '0:v:0', '-map', '1:a:0', '-c', 'copy', '-frames:v', str(n), '-movflags', '+faststart', out])
    else:
        run(['ffmpeg', '-v', 'error', '-nostdin', '-y', '-i', join, '-i', a, '-map', '0:v:0', '-map', '1:a:0', '-frames:v', str(n), '-fps_mode', 'passthrough', *encode, '-c:a', 'copy',
             '-movflags', '+faststart', out])
    os.remove(a)
    got = frames(out)
    if got != n: raise RuntimeError(f'share.mp4 has {got} pictures, the parts before the end card {n}')
    return 'copied' if ok else 'encoded', round(float(until[1]) if until else ts[-1] - ts[0], 2)


if __name__ == '__main__':
    work, join, tall, out = sys.argv[1:5]
    print(json.dumps(cut(work, join, tall, out, ['-vf', 'scale=1080:1920:flags=lanczos', '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-pix_fmt', 'yuv420p'])))
