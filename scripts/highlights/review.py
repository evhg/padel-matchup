"""A line-call review for a reel: the shot at full picture, then the landing slow and close, then a still with a verdict.

usage: review.py <piece.mov> <piece start s> <video with the reel's sound> <match.json> <review.json> <out-wide.mp4> <out-tall.mp4>

review.json: {"from": s, "land": s,          the first moment to show, and the picture where the ball lands
              "x": px, "y": px,               the landing place in the picture of the piece
              "title": "Line call", "sub": "64:42",
              "verdict": "Too close to call", "verdict_sub": "Ball and line: about 1 cm apart",
              "close": 3,                      optional: how many times closer the slow part is
              "after": 0.7}                    optional: how long the full picture runs on after the landing
All times are on the clock of the whole match video; <piece start s> is where the piece begins on that clock
(index.json of modal/cut.py).

Players remembered three calls where the two teams did not agree (19 November 2026). The camera file answers one
of them better than any player could: at 60 pictures a second the landing is one picture, and at 4K the ball is
24 pixels wide beside a line of 25. The review shows exactly those pictures: no drawn line, no drawn ball.
The verdict is a sentence a person wrote after measuring; this script measures nothing.

Three parts: the full picture at normal speed until 0.7 s after the landing ("after"); then the last 0.2 s before
the landing again, at one eighth of the speed, three times closer ("close"); the landing picture held for 2.2 s with
the verdict. The sound of the first part is the reel's sound; the rest is silent.
The first version cut to the close part just before the landing. The owner (19 November 2026): the full view stops
before the ball has bounced. A viewer must first see the whole serve land at normal speed, and only then the detail.
Environment: SCALE (2 for a 4K reel), GRADE (hdr.py).
"""
import sys, os, json, subprocess, cv2
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import gfx, hdr, teams

piece, start, video, matchf, revf, out_w, out_t = sys.argv[1:8]
start = float(start); R = json.load(open(revf)); MT = teams.fill(json.load(open(matchf)))
gfx.reel_scale(); K = gfx.K
FPS = '30000/1001'; SLOW, HOLD, BEFORE = 8, 2.2, 0.20
CLOSE = int(R.get('close', 3))                    # how many times closer the slow part is
X264 = ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '19', '-pix_fmt', 'yuv420p']          # as render.py: the parts of a reel are joined with a stream copy
TEAMS = [('Team ' + MT['team_a']) if MT.get('team_a') else MT['pair_a'], ('Team ' + MT['team_b']) if MT.get('team_b') else MT['pair_b']]
work = out_w + '.parts'; os.makedirs(work, exist_ok=True)
tone = hdr.vf(hdr.kind(piece)) if hdr.kind(piece) else 'format=yuv420p'


def size(f):
    r = subprocess.run(['ffprobe', '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', f], capture_output=True, text=True)
    return [int(x) for x in r.stdout.strip().strip(',').split(',')[:2]]


def png(name, img):
    p = f'{work}/{name}.png'; cv2.imwrite(p, img); return p


PW, PH = size(piece)
a, land = R['from'], R['land']; d1 = round(land + float(R.get('after', 0.7)) - a, 3); d2 = BEFORE + 0.02; slow_len = round(d2 * SLOW, 3); total = round(d1 + slow_len + HOLD, 3)
bug = png('bug', gfx.bug(MT.get('venue') or '')); badge = png('badge', gfx.badge('Review'))
lt1 = png('lt1', gfx.lower_third(R.get('title', 'Line call'), R.get('sub'))); lt2 = png('lt2', gfx.lower_third(R['verdict'], R.get('verdict_sub')))
bw = cv2.imread(badge, cv2.IMREAD_UNCHANGED).shape[1]


def make(tall, out):
    OW, OH = (1080 * K, 1920 * K) if tall else (1920 * K, 1080 * K)
    if tall:   # the standing frame of the vertical reel, and the picture in its window: the middle three quarters of the width
        base = png('base', gfx.tall_base(MT.get('venue') or '', TEAMS[0], TEAMS[1], MT['score']))
        vw, vh, vy = 1080 * K, 810 * K, 480 * K
        full = f'crop={PH * 4 // 3}:{PH}:{(PW - PH * 4 // 3) // 2}:0'; cw, ch = PW // CLOSE * 3 // 4 // 2 * 2, PH // CLOSE // 2 * 2
        BUG, LT, RIGHT = (40 * K, 70 * K), (40 * K, 250 * K), (OW - bw - 40 * K, 70 * K)
    else:
        vw, vh = OW, OH; full = 'null'; cw, ch = PW // CLOSE // 2 * 2, PH // CLOSE // 2 * 2
        BUG, LT, RIGHT = (48 * K, 40 * K), (48 * K, 900 * K), (OW - bw - 48 * K, 40 * K)
    cx = int(min(max(R['x'] - cw / 2, 0), PW - cw)); cy = int(min(max(R['y'] - ch / 2, 0), PH - ch))
    ins = ['-ss', f'{a - start:.3f}', '-t', f'{d1:.3f}', '-i', piece, '-ss', f'{land - BEFORE - start:.3f}', '-t', f'{d2:.3f}', '-i', piece,
           '-ss', f'{a:.3f}', '-t', f'{d1:.3f}', '-i', video, '-loop', '1', '-i', bug, '-loop', '1', '-i', badge, '-loop', '1', '-i', lt1, '-loop', '1', '-i', lt2]
    g = [f'[0:v]{full},{tone},fps={FPS},scale={vw}:{vh}:flags=lanczos,setsar=1[a0]',
         f'[1:v]crop={cw}:{ch}:{cx}:{cy},{tone},setpts={SLOW}*PTS,fps={FPS},scale={vw}:{vh}:flags=lanczos,setsar=1,tpad=stop_mode=clone:stop_duration={HOLD}[b0]']
    if tall:
        ins += ['-loop', '1', '-i', base]
        g += [f'[7:v]split[q1][q2]', f'[q1][a0]overlay=0:{vy}:shortest=1[a1]', f'[q2][b0]overlay=0:{vy}:shortest=1[b1]']
    else: g += ['[a0]null[a1]', '[b0]null[b1]']
    g += [f'[a1][3:v]overlay={BUG[0]}:{BUG[1]}:shortest=1[a2]', f'[a2][5:v]overlay={LT[0]}:{LT[1]}:shortest=1[p1]',
          f'[b1][3:v]overlay={BUG[0]}:{BUG[1]}:shortest=1[b2]', f'[b2][4:v]overlay={RIGHT[0]}:{RIGHT[1]}:shortest=1[b3]',
          f"[b3][6:v]overlay={LT[0]}:{LT[1]}:shortest=1:enable='gte(t,{slow_len})'[p2]",
          f'[p1][p2]concat=n=2:v=1:a=0,fps={FPS},format=yuv420p[v]', f'[2:a]aresample=48000,apad=whole_dur={total}[s]']
    subprocess.run(['ffmpeg', '-v', 'error', '-nostdin', '-y', *ins, '-filter_complex', ';'.join(g), '-map', '[v]', '-map', '[s]', '-t', f'{total}', *X264,
                    '-c:a', 'aac', '-b:a', '160k', '-ar', '48000', '-ac', '2', '-movflags', '+faststart', out], check=True)
    print('wrote', out, f'{OW}x{OH}', total, 's; close picture', f'{cw}x{ch} at {cx},{cy}')


make(False, out_w); make(True, out_t)
