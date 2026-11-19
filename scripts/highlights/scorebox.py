"""Draw the score box on a finished reel: the score before each point, and the new score when the ball is dead.

usage: scorebox.py <reel.mp4> <workdir of reel_points.py> <points.json> <score.json of score_log.py> <out.mp4> [crf=22]

The reel is made first and the score is added last, like the cheers: a score is a fact that needs its own proof
(score_log.py), and that proof can come later than the pictures. This file refuses to draw when
- score.json does not agree with the final score of the match,
- a point of the reel is not in the log, or its game could not be counted,
- the reel and the log name different winners for a point.
The owner asked for the score in a corner instead of a shot counter (19 November 2026), and a wrong line in the
fifth reel showed what a guess costs: a box that is sometimes wrong is worse than no box.

The box is at the top right ("score_box": true in points.json keeps that corner free). In the clip of a point it
shows the score before the point; 0.35 s after the dead moment it changes, and the row that won is white for a
moment. It stays through the close look and the replay of that point. Other parts (opening, review, cards) have none.
Environment: SCALE as for the reel; AF (an ffmpeg sound filter for the same pass; default: the sound is copied).
MISSING=skip: a point of the reel that the log does not hold gets no box, and the run says which. This is for a log
that is proven for some sets only (score_log.py was then run on those sets with their final score): the first real
log agreed with the typed score in two sets of four, and the box stands only on the points of those two.
"""
import sys, os, glob, json, subprocess, cv2
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import gfx

reel, work, pointsf, scoref, out = sys.argv[1:6]; crf = sys.argv[6] if len(sys.argv) > 6 else '22'
P = json.load(open(pointsf)); SC = json.load(open(scoref)); K = gfx.reel_scale()
if SC['verdict'] != 'agrees with the final score': sys.exit('no score box: the log ' + SC['verdict'])
names = P.get('score_names') or SC['pairs']


def length(f): return float(subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f], capture_output=True, text=True).stdout.strip())


r = subprocess.run(['ffprobe', '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', reel], capture_output=True, text=True).stdout.strip().split(',')
RW, RH = int(r[0]), int(r[1]); TALL = RH > RW; edge, top = (40, 70) if TALL else (48, 40)
segs = sorted(glob.glob(f'{work}/[0-9][0-9]-*.json')); at = 0.0; spans = []; imgs = {}


def img(st, hot=None):
    key = json.dumps([st, hot])
    if key not in imgs:
        f = f'{work}/score-{len(imgs):02d}.png'; cv2.imwrite(f, gfx.score_box(names, st.get('serving'), st['sets'], st['games'], st['points'], hot)); imgs[key] = f
    return imgs[key]


cur = None
for s in segs:
    d = json.load(open(s)); n = os.path.basename(s)[3:-5]; ln = length(s[:-5] + '.mp4')
    if d['kind'] == 'clip' and n.startswith('point'):
        c = P['points'][int(n[5:])]; row = min(SC['points'], key=lambda q: abs(q['serve_t'] - c['serve_t']))
        if abs(row['serve_t'] - c['serve_t']) > 4.0:
            if os.environ.get('MISSING') != 'skip': sys.exit(f"no score box: the point served at {c['serve_t']} is not in the log")
            print(f"no box on the point served at {c['serve_t']}: the log does not hold it"); cur = None; at += ln; continue
        if not row.get('sure'): sys.exit(f"no score box: the game of the point served at {c['serve_t']} could not be counted")
        if c.get('won') in (0, 1) and c['won'] != row['won']: sys.exit(f"no score box: the reel says pair {c['won']} won the point served at {c['serve_t']}, the log says pair {row['won']}")
        dead = at + d['dead'] - d['t0'] + 0.35
        spans += [(at, dead, img(row['before'])), (dead, dead + 1.25, img(row['after'], row['won'])), (dead + 1.25, at + ln, img(row['after']))]; cur = row
    elif d['kind'] == 'replay' and cur: spans.append((at, at + ln, img(cur['after'])))
    else: cur = None
    at += ln
if not spans: sys.exit('no point of the reel has a score')
files = sorted(set(f for _, _, f in spans)); ins = []; g = []; last = '0:v'
for f in files: ins += ['-i', f]
for k, (a, b, f) in enumerate(spans):
    w = cv2.imread(f, cv2.IMREAD_UNCHANGED).shape[1]
    g.append(f"[{last}][{files.index(f) + 1}:v]overlay={RW - w - int(edge * K)}:{int(top * K)}:enable='between(t,{a:.3f},{b - 0.001:.3f})'[v{k}]"); last = f'v{k}'
af = os.environ.get('AF'); sound = ['-af', af, '-ar', '48000', '-c:a', 'aac', '-b:a', '192k'] if af else ['-c:a', 'copy']
subprocess.run(['ffmpeg', '-v', 'error', '-nostdin', '-y', '-i', reel, *ins, '-filter_complex', ';'.join(g), '-map', f'[{last}]', '-map', '0:a:0', '-c:v', 'libx264', '-preset', 'medium',
                '-crf', crf, '-pix_fmt', 'yuv420p', *sound, '-movflags', '+faststart', out], check=True)
for a, b, f in spans: print('%7.2f - %7.2f  %s' % (a, b, os.path.basename(f)))
print('SCOREBOX_DONE', len(spans), 'spans', len(files), 'pictures')
