"""Build the recap reel: write each segment's description, render it, and join the segments.

usage: build.py <video> <plan.json> <ident.json> <feat2.npz> <match.json> <workdir> <out.mp4> [only=cards|all]
match.json: {"venue", "date", "score", "names": {id: name}, "team": {id: 0|1}, "pair_a": "A & B", "pair_b": "C & D"}
Optional in match.json: "team_a", "team_b" (the names of the two teams).
Environment: TRACKS (the folder of track_all.sh, default <workdir>), VERSUS (the prefix of the opening of versus.py:
<prefix>-wide.mp4 and <prefix>-tall.mp4), TALL=1 (the vertical reel), CACHE (the folder of the slow replays, so the
second layout does not make them again), SRMIX (how much of the upscaled picture a replay takes, default 0.5),
SHOTS (the folder of rally_shots.sh: a clip ends after the last shot, the counter leaves out what is not a shot),
FAST=1 (the long rally at six times the speed; it is off, because it was not fun to watch).
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
TEAMS = [('Team ' + MT['team_a']) if MT.get('team_a') else MT['pair_a'], ('Team ' + MT['team_b']) if MT.get('team_b') else MT['pair_b']]
def add(seg, name):
    seg['venue'] = MT.get('venue') or ''; seg['foot'] = [('Team ' + MT['team_a']) if MT.get('team_a') else MT['pair_a'], ('Team ' + MT['team_b']) if MT.get('team_b') else MT['pair_b'], MT['score']]; p = f'{work}/{len(segs):02d}-{name}.json'; json.dump(seg, open(p, 'w')); segs.append(p)
def mmss(t): return f'{int(t // 60)}:{int(t % 60):02d}'

# a calm wide frame for the cards: a moment in play
kf_times = [float(x) for x in open(f'{S}/match/kf_times.txt')]
import hdr
HDRK = hdr.kind(video)
def frame_at(t):
    im = cv2.imread(f'{KF}/{int(np.argmin(np.abs(np.array(kf_times) - t))) + 1:06d}.jpg')
    return hdr.sdr(im, HDRK) if HDRK else im
bg = frame_at(P['clips'][0]['t0'] + 3)
# the opening: the two teams face each other (versus.py made both layouts before this script runs)
vs = os.environ.get('VERSUS')
if vs and os.path.exists(vs + '-wide.mp4') and os.path.exists(vs + '-tall.mp4'):
    add({'kind': 'file', 'path': vs + '-wide.mp4', 'path_tall': vs + '-tall.mp4'}, 'versus')
else:
    cv2.imwrite(f'{work}/intro.jpg', (gfx.intro_card_tall if TALL else gfx.intro_card)(bg, MT.get('venue') or '', MT['date'], MT['pair_a'], MT['pair_b'], MT['score']))
    add({'kind': 'card', 'image': f'{work}/intro.jpg', 'dur': 3.6}, 'intro')

# One replay for each player: the player's hardest swing at a shot that was heard, late in a rally. Nobody is singled
# out (the owner, 14 November 2026), and a replay is shown only where the swing is clearly that player's.
SURE = 15.0      # a name is shown only where the clip as a whole is sure of it
def track_of(c):
    trf = c.get('track_file') or f"{TRACKS}/t{c['track_key'][0]:.2f}-{c['track_key'][1]:.2f}.json"
    return (trf, json.load(open(trf))) if os.path.exists(trf) else (None, None)
# The checked shots of each rally (rally_shots.sh): which sounds are shots, who hit them, where the rally ends.
SHOTS = os.environ.get('SHOTS'); AFTER = 3.4      # a clip ends this long after the last shot of the rally
FAST = os.environ.get('FAST') == '1'              # the long rally at six times the speed. Off: the owner, 17 November 2026: "not fun to watch, remove it"
def shots_of(c):
    if not SHOTS: return None, None
    import glob
    for f in glob.glob(f'{SHOTS}/r*-shots.json'):
        r0, r1 = [float(x) for x in os.path.basename(f)[1:-11].split('-')]
        if r0 <= c['lastHit'] <= r1: return json.load(open(f)), f[:-11] + '.json'
    return None, None
for c in P['clips']:
    c['track_key'] = (c['t0'], c['t1']); c['track_file'] = None; sh, trk = shots_of(c); c['shots'] = None
    if not sh: continue
    info = {x['t']: x for x in sh['sounds']}; end = c['lastHit']; hits = list(c['hitTimes'])
    # When the point is over the ball stops flying. A quiet period of the ball that starts in the last 12 seconds of
    # the sounds ends the rally at the last sound before it (in the first match: a smash won the point, and the
    # four sounds after it were the ball on the glass, a racket tap, the ball sent back and the next server).
    for a, b in sh['quiet']:
        if end - 12.0 <= a < end:
            before = [h for h in hits if h <= a + 0.8]
            if len(before) >= 3 and len(hits) - len(before) <= 4: end = before[-1]; c['cut_by_ball'] = True; break
    real = []; last = -9.0
    for h in hits:
        x = info.get(h)
        if h > end or (x and x['label'] == 'other') or h - last < 0.3: continue        # not of this ball, or an echo
        real.append(x or {'t': h, 'label': 'shot', 'who': None, 'sure': False, 'per': {}}); last = h
    # A "rally" of most of a minute where the camera saw few of the shots is several points that the sounds of the next
    # courts joined (second match: 60 sounds in 88 seconds, 11 seen, and the ball stopped four times). Then only the
    # part after the last long stop of the ball is this point, and it is no marathon.
    if real and real[-1]['t'] - real[0]['t'] > 45 and sum(1 for x in real if x.get('sure')) < len(real) / 3:
        stops = [q1 for q0, q1 in sh['quiet'] if q1 - q0 >= 3.5 and q1 < end - 2]
        if stops:
            real = [x for x in real if x['t'] >= max(stops) - 0.3]; c['joined'] = True; c.pop('marathon', None)
            if c.get('title') == 'The marathon': c['title'] = 'Great rally'
    if len(real) < 3: continue
    c['shots'] = real; c['hitTimes'] = [x['t'] for x in real]; c['hits'] = len(real); c['lastHit'] = end
    c['track_file'] = trk                     # the players were followed through the whole rally
    r0, r1 = [float(x) for x in os.path.basename(trk)[1:-5].split('-')]
    pre = 16.0 if c.get('best') else 12.0
    c['t1'] = round(min(c['t1'], r1 - 0.2, end + (4.5 if c.get('cut_by_ball') else 6.5)), 2)
    if c.get('marathon') and FAST: c['t0'] = round(end - 9.0, 2); c['fast_from'] = round(max(r0 + 0.1, real[0]['t'] - 1.5), 2)
    else: c['t0'] = round(max(r0 + 0.1, end - pre, real[0]['t'] - 2.5), 2)
    print(f"point at {mmss(end)}: {len(hits)} sounds, {len(real)} counted, end {'moved to ' + mmss(end) if c.get('cut_by_ball') else 'as before'}, clip {c['t0']}-{c['t1']}")
cand = {k: [] for k in range(4)}
for ci, c in enumerate(P['clips']):
    trf, tr = track_of(c)
    if not tr: continue
    hs = [h for h in c['hitTimes'] if h >= max(c['t0'] + 1.8, c['lastHit'] - 9.0)]
    by_t = {x['t']: x for x in (c['shots'] or [])}
    for h in hs:
        hi = hitter(tr, h)
        if c['shots']:
            # the labeller says who hit; the ball at the racket counts more than a fast arm
            x = by_t[h]; who = x['who']; e = x['per'].get(str(who)) if who is not None else None
            if e is None or tr['sure'].get(str(who), 0) < SURE or together(tr, h, who, M['pairs']): continue
            # the whole player is in the picture at the shot (one replay showed an arm at the edge and no player)
            pl = tr['players'][str(who)]; fi = int(np.argmin([abs(x - (h - tr['t0']) * FPS) for x in pl['f']])); bx = pl['box'][fi]
            if abs(pl['f'][fi] - (h - tr['t0']) * FPS) > 6 or bx[0] < 40 or bx[2] > 1880 or bx[3] > 1076: continue
            seen = e['dball'] is not None and e['dball'] <= 0.8
            if not seen and not (e['arm'] is not None and e['arm'] >= 2.4): continue
            cand[who].append(((2.0 if seen else 0.0) + (e['arm'] or 0.0) + (1.0 if e['up'] else 0.0) + (0.8 if h == c['lastHit'] else 0.0), ci, h, {'id': who, 'peak': e['arm'], 'ball': e['dball'], 'overhead': e['up']}))
            continue
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
    if c.get('marathon') and FAST:
        add({'kind': 'fast', 't0': c['fast_from'], 't1': c['t0'], 'speed': 6, 'title': c['title'], 'sub': sub, 'hits': hits}, f'fast{ci}')
        add({'kind': 'clip', 't0': c['t0'], 't1': c['t1'], 'track': trf, 'names': shown, 'team': team, 'title': None, 'sub': None, 'tags_until': 4.0, 'hits': hits}, f'point{ci}')
    else:
        seg = {'kind': 'clip', 't0': c['t0'], 't1': c['t1'], 'track': trf, 'names': shown, 'team': team, 'title': c['title'], 'sub': sub, 'tags_until': 4.5, 'hits': hits}
        # a person said who won this point (plan.py with WINNERS): the clip names the pair after the last shot
        if c.get('won') in (0, 1): seg['won'] = {'team': c['won'], 'name': TEAMS[c['won']], 'at': c['lastHit']}
        add(seg, f'point{ci}')
    if ci in replay_at:
        k, h, hi = replay_at[ci]; p = tr['players'][str(k)]
        hgt = float(np.median([b[3] - b[1] for b in p['box']])); nth = sum(1 for x in hits if x <= h)
        report.append({'clip': ci, 'player': names[k], 'hit': h, 'hitter': hi})
        add({'kind': 'replay', 't0': round(h - 1.7, 2), 't1': round(min(c['t1'], h + 1.0), 2), 'track': trf, 'speed': 0.5, 'focus': k, 'focus_name': names[k], 'focus_team': team[k],
             'zoom': float(np.clip(520 / max(hgt, 60), 1.5, 3.2)), 'title': names[k], 'sub': ' · '.join(x for x in ('Smash' if hi['overhead'] else None, 'Last shot of the rally' if c['shots'] and h == c['lastHit'] else None) if x) or None}, f'replay{ci}')

st = P['stats']
if SHOTS and any(c['shots'] for c in P['clips']):
    # only the six rallies of the reel have checked shots: the total of the match is not shown as a fact
    nums = [(st['rallies'], 'rallies'), (max(c['hits'] for c in P['clips']), 'longest rally'), (st['minutes'], 'minutes')]
else: nums = [(st['rallies'], 'rallies'), (st['longest'], 'longest rally'), (f"{st['shots']:,}", 'shots'), (st['minutes'], 'minutes')]
cv2.imwrite(f'{work}/stats.jpg', (gfx.stats_card_tall if TALL else gfx.stats_card)(bg, 'The match in numbers', nums))
add({'kind': 'card', 'image': f'{work}/stats.jpg', 'dur': 4.5}, 'stats')
cv2.imwrite(f'{work}/outro.jpg', (gfx.outro_card_tall if TALL else gfx.outro_card)(bg, 'Your match. Your highlights.', ' · '.join(x for x in (MT.get('venue'), MT['date']) if x)))
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
