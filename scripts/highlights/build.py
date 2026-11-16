"""Build the recap reel: write each segment's description, render it, and join the segments.

usage: build.py <video> <plan.json> <ident.json> <feat2.npz> <match.json> <workdir> <out.mp4> [only=cards|all]
match.json: {"venue", "date", "score", "names": {id: name}, "team": {id: 0|1}, "pair_a": "A & B", "pair_b": "C & D"}
Optional in match.json: "team_a", "team_b" (the names of the two teams).
Environment: TRACKS (the folder of track_all.sh, default <workdir>), VERSUS (the prefix of the opening of versus.py:
<prefix>-wide.mp4 and <prefix>-tall.mp4), TALL=1 (the vertical reel), CACHE (the folder of the slow replays, so the
second layout does not make them again), SRMIX (how much of the upscaled picture a replay takes, default 0.5).
"""
import sys, os, json, subprocess, numpy as np, cv2
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import gfx
from shots import hitter, together, FPS

video, planf, identf, featf, matchf, work, out = sys.argv[1:8]
P = json.load(open(planf)); M = json.load(open(identf)); MT = json.load(open(matchf))
names = [MT['names'][str(i)] for i in range(4)]; team = [MT['team'][str(i)] for i in range(4)]
S = os.environ.get('HL_HOME') or os.path.dirname(os.path.dirname(os.path.abspath(__file__)))   # models/, fonts/ and match/ live here
KF = f'{S}/match/kf'
os.makedirs(work, exist_ok=True)
TALL = os.environ.get('TALL') == '1'; TRACKS = os.environ.get('TRACKS', work)
segs = []
def add(seg, name):
    seg['venue'] = MT['venue']; seg['foot'] = [('Team ' + MT['team_a']) if MT.get('team_a') else MT['pair_a'], ('Team ' + MT['team_b']) if MT.get('team_b') else MT['pair_b'], MT['score']]; p = f'{work}/{len(segs):02d}-{name}.json'; json.dump(seg, open(p, 'w')); segs.append(p)
def mmss(t): return f'{int(t // 60)}:{int(t % 60):02d}'

# a calm wide frame for the cards: a moment in play
kf_times = [float(x) for x in open(f'{S}/match/kf_times.txt')]
def frame_at(t): return cv2.imread(f'{KF}/{int(np.argmin(np.abs(np.array(kf_times) - t))) + 1:06d}.jpg')
bg = frame_at(P['clips'][0]['t0'] + 3)
# the opening: the two teams face each other (versus.py made both layouts before this script runs)
vs = os.environ.get('VERSUS')
if vs and os.path.exists(vs + '-wide.mp4') and os.path.exists(vs + '-tall.mp4'):
    add({'kind': 'file', 'path': vs + '-wide.mp4', 'path_tall': vs + '-tall.mp4'}, 'versus')
else:
    cv2.imwrite(f'{work}/intro.jpg', (gfx.intro_card_tall if TALL else gfx.intro_card)(bg, MT['venue'], MT['date'], MT['pair_a'], MT['pair_b'], MT['score']))
    add({'kind': 'card', 'image': f'{work}/intro.jpg', 'dur': 3.6}, 'intro')

# One replay for each player: the player's hardest swing at a shot that was heard, late in a rally. Nobody is singled
# out (the owner, 14 November 2026), and a replay is shown only where the swing is clearly that player's.
SURE = 15.0      # a name is shown only where the clip as a whole is sure of it
def track_of(c):
    trf = f"{TRACKS}/t{c['t0']:.2f}-{c['t1']:.2f}.json"
    return (trf, json.load(open(trf))) if os.path.exists(trf) else (None, None)
cand = {k: [] for k in range(4)}
for ci, c in enumerate(P['clips']):
    trf, tr = track_of(c)
    if not tr: continue
    hs = [h for h in c['hitTimes'] if h >= max(c['t0'] + 1.8, c['lastHit'] - 9.0)]
    for h in hs:
        hi = hitter(tr, h)
        if hi and hi['peak'] >= 2.2 and hi['margin'] >= 2.0 and tr['sure'].get(str(hi['id']), 0) >= SURE and not together(tr, h, hi['id'], M['pairs']):
            cand[hi['id']].append((hi['peak'] + (1.0 if hi['overhead'] else 0.0), ci, h, hi))
replay_at = {}; report = []
for k in sorted(cand, key=lambda k: len({x[1] for x in cand[k]})):          # the player with the fewest clips chooses first
    for sc, ci, h, hi in sorted(cand[k], key=lambda x: -x[0]):
        if ci not in replay_at: replay_at[ci] = (k, h, hi); break
print('replays:', {names[k]: (ci, round(h, 1), hi) for ci, (k, h, hi) in replay_at.items()})

for ci, c in enumerate(P['clips']):
    trf, tr = track_of(c)
    shown = [nm if tr and tr['sure'].get(str(i), 0) >= SURE else None for i, nm in enumerate(names)]
    sub = f"{c['hits']} shots · {mmss(c['lastHit'])}"
    hits = c['hitTimes']
    if c.get('marathon'):
        add({'kind': 'fast', 't0': c['fast_from'], 't1': c['t0'], 'speed': 6, 'title': c['title'], 'sub': sub, 'hits': hits}, f'fast{ci}')
        add({'kind': 'clip', 't0': c['t0'], 't1': c['t1'], 'track': trf, 'names': shown, 'team': team, 'title': None, 'sub': None, 'tags_until': 4.0, 'hits': hits}, f'point{ci}')
    else:
        add({'kind': 'clip', 't0': c['t0'], 't1': c['t1'], 'track': trf, 'names': shown, 'team': team, 'title': c['title'], 'sub': sub, 'tags_until': 4.5, 'hits': hits}, f'point{ci}')
    if ci in replay_at:
        k, h, hi = replay_at[ci]; p = tr['players'][str(k)]
        hgt = float(np.median([b[3] - b[1] for b in p['box']])); nth = sum(1 for x in hits if x <= h)
        report.append({'clip': ci, 'player': names[k], 'hit': h, 'hitter': hi})
        add({'kind': 'replay', 't0': round(h - 1.7, 2), 't1': round(min(c['t1'], h + 1.0), 2), 'track': trf, 'speed': 0.5, 'focus': k, 'focus_name': names[k], 'focus_team': team[k],
             'zoom': float(np.clip(520 / max(hgt, 60), 1.5, 3.2)), 'title': names[k], 'sub': ('Smash · ' if hi['overhead'] else '') + f"shot {nth} of {c['hits']}"}, f'replay{ci}')

st = P['stats']
cv2.imwrite(f'{work}/stats.jpg', (gfx.stats_card_tall if TALL else gfx.stats_card)(bg, 'The match in numbers', [(st['rallies'], 'rallies'), (st['longest'], 'longest rally'), (f"{st['shots']:,}", 'shots'), (st['minutes'], 'minutes')]))
add({'kind': 'card', 'image': f'{work}/stats.jpg', 'dur': 4.5}, 'stats')
cv2.imwrite(f'{work}/outro.jpg', (gfx.outro_card_tall if TALL else gfx.outro_card)(bg, 'Your match. Your highlights.', f"{MT['venue']} · {MT['date']}"))
add({'kind': 'card', 'image': f'{work}/outro.jpg', 'dur': 2.6}, 'outro')
json.dump(report, open(f'{work}/hitters.json', 'w'), indent=1, default=str)
print('segments', len(segs)); [print(' ', os.path.basename(s)) for s in segs]
if len(sys.argv) > 8 and sys.argv[8] == 'plan': sys.exit(0)

parts = []
for s in segs:
    mp4 = s[:-5] + '.mp4'
    if not os.path.exists(mp4) or os.path.getmtime(mp4) < os.path.getmtime(s):
        subprocess.run([sys.executable, os.path.join(os.path.dirname(os.path.abspath(__file__)), 'render.py'), video, s, mp4], check=True)
    parts.append(mp4)
with open(f'{work}/list.txt', 'w') as fh:
    for p in parts: fh.write(f"file '{os.path.abspath(p)}'\n")
subprocess.run(['ffmpeg', '-v', 'error', '-nostdin', '-y', '-f', 'concat', '-safe', '0', '-i', f'{work}/list.txt', '-c', 'copy', '-movflags', '+faststart', out], check=True)
print('wrote', out)
