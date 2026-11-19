"""Build a reel from points that are already described: where each one starts, ends, who reacts, what to replay.

usage: reel_points.py <video> <points.json> <match.json> <workdir> <out.mp4> [plan]

build.py chooses the points by the length of a rally and cuts a fixed stretch before its end. The owner watched
that (19 November 2026) and named what is wrong with it: a clip must start with the serve and stop before the next
one; a highlight is a point that players react to, not a long rally; after the point comes the face of the player
who reacts, and then the replay. A reel of a professional editor has the same order: the rally in one wide shot
with no cut, then a close look at a reaction (1.2 to 3.2 s), then the replay.

points.json: {"points": [{
    "serve_t": s, "last_t": s,            the serve hit and the last shot of the point
    "dead_t": s,                          the moment the point is decided: the ball in the net, out, the second bounce
                                          (default: 1.0 s after the last shot). The winner is named after it.
    "end": s,                             optional: where the clip stops (default and least: 2.6 s after the dead moment)
    "next_serve_t": s,                    optional: the clip never reaches the next serve
    "track": "file.json",                 the players through this point (track.py)
    "title": "...", "won": 0 | 1,         optional: the words under the clip, and the team that won the point
    "react":  {"who": id, "t0": s, "t1": s},                 optional: a slow close look at one player after the point
    "replay": {"who": id, "t": s, "before": 1.7, "after": 1.0},   optional: the moment to show again, slowly
    "says":   [{"t0": s, "t1": s, "who": id, "text": "..."}]      optional: words a viewer can HEAR in the clip
    "notes":  [{"t0": s, "t1": s, "who": id, "value": 157, "unit": "bpm", "label": "..."}]   optional: a measured number over a head
}], "outro": "Your match. Your highlights.",          or {"line1", "line2", "shot": "screenshot.png", "shot_title", "shot_sub", "dur"}: the end card
 "meter": {"label": "<NAME> BPM", "series": [[s, value], ...]},      optional: a measured number shown on every clip
 "card": {"title": "...", "rows": [[value, "label"], ...]}}          optional: a card of numbers before the outro
 "score_box": true                                                    optional: scorebox.py draws the score later; the "Replay" badge moves to the left

An item of "points" can also be {"file": "wide.mp4", "file_tall": "tall.mp4"}: a part made elsewhere (review.py),
shown at that place.

A line in "says" is only for words that are audible in the reel. A recogniser's guess is not enough: the owner
could not hear the words of one bubble, and a bubble a viewer cannot check against the sound reads as a mistake.

Environment, as for build.py: VERSUS (the opening of versus.py), TALL=1, SCALE and HIRES (render.py), CACHE.
The shot counter is off here (COUNTER=0 for render.py): its numbers were wrong in three reels.

What the owner saw in the fifth reel (19 November 2026), and the rules that came of it:
- "Team X wins the point" stood on screen while the rally went on, twice. The line belongs to the moment the ball is
  dead ("dead_t"), not to the last hit somebody found, and the clip runs 2.6 s past it.
- A close look at a player at the far end is a blur: the camera has about 300 pixels for that player. A window is
  never narrower than half the picture (ZMAX), and a reaction or replay is chosen at the near end where there is one.
- A replay opened on empty grass for two seconds, because its player walked into the picture late. A replay starts
  when the tracker has its player; if less than 1.2 s is left, there is no replay.
"""
import sys, os, json, subprocess, numpy as np, cv2
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import gfx, hdr, teams

video, pointsf, matchf, work, out = sys.argv[1:6]
P = json.load(open(pointsf)); MT = teams.fill(json.load(open(matchf)))
names = [MT['names'][str(i)] for i in range(4)]; team = [MT['team'][str(i)] for i in range(4)]
S = os.environ.get('HL_HOME') or os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
os.makedirs(work, exist_ok=True); os.environ['COUNTER'] = '0'
TALL = os.environ.get('TALL') == '1'
gfx.reel_scale()
TEAMS = [('Team ' + MT['team_a']) if MT.get('team_a') else MT['pair_a'], ('Team ' + MT['team_b']) if MT.get('team_b') else MT['pair_b']]
LEAD, HOLD = 1.5, 2.6                              # before the serve hit; after the moment the ball is dead
ZMAX = 2.0                                         # a window is never narrower than half the picture
segs = []


def add(seg, name):
    seg['venue'] = MT.get('venue') or ''; seg['foot'] = [TEAMS[0], TEAMS[1], MT['score']]
    p = f'{work}/{len(segs):02d}-{name}.json'
    # a segment file is written again only when it changed: the renderer makes a segment again when its file is newer
    new = json.dumps(seg, indent=1)
    if not os.path.exists(p) or open(p).read() != new: open(p, 'w').write(new)
    segs.append(p)


def mmss(t): return f'{int(t // 60)}:{int(t % 60):02d}'


def height(trf, who, a, b):
    """How tall the player is in the picture between a and b (in the 1080 lines of a track), or None."""
    tr = json.load(open(trf)); p = tr['players'].get(str(who))
    if not p: return None
    f = np.array(p['f']) / tr['fps'] + tr['t0']; m = (f >= a) & (f <= b)
    if not m.any(): return None
    box = np.array(p['box'])[m]; return float(np.median(box[:, 3] - box[:, 1]))


def zoom_for(trf, who, a, b):
    h = height(trf, who, a, b)
    return float(np.clip(520 / max(h, 60), 1.5, ZMAX)) if h else ZMAX


def seen_from(trf, who, a, b):
    """The first moment in [a, b] at which the tracker has the player, or None."""
    tr = json.load(open(trf)); p = tr['players'].get(str(who))
    if not p: return None
    f = np.array(p['f']) / tr['fps'] + tr['t0']; m = (f >= a) & (f <= b)
    return float(f[m][0]) if m.any() else None


BADGE_LEFT = bool(P.get('score_box'))             # "score_box": true in the file: scorebox.py will take the top right corner

vs = os.environ.get('VERSUS')
if vs and os.path.exists(vs + '-wide.mp4') and os.path.exists(vs + '-tall.mp4'):
    add({'kind': 'file', 'path': vs + '-wide.mp4', 'path_tall': vs + '-tall.mp4'}, 'versus')

for i, c in enumerate(P['points']):
    if c.get('file'):
        add({'kind': 'file', 'path': c['file'], 'path_tall': c.get('file_tall') or c['file']}, f'part{i}'); continue
    trf = c['track']; t0 = round(c['serve_t'] - LEAD, 2); dead = c.get('dead_t') or c['last_t'] + 1.0
    t1 = max(c.get('end') or 0, dead + HOLD)
    if c.get('next_serve_t'): t1 = min(t1, c['next_serve_t'] - 1.0)
    t1 = round(t1, 2)
    # the length of the rally is a fact (serve to last shot); the number of shots was wrong too often to show
    seg = {'kind': 'clip', 't0': t0, 't1': t1, 'track': trf, 'names': names, 'team': team, 'title': c.get('title'),
           'sub': f"{int(round(c['last_t'] - c['serve_t']))} s rally · {mmss(c['last_t'])}", 'tags_until': 4.5, 'hits': []}
    if P.get('meter'):
        seg['meter'] = {'label': P['meter']['label'], 'points': [q for q in P['meter']['series'] if t0 - 90 <= q[0] <= t1 + 90]}
    if c.get('won') in (0, 1): seg['won'] = {'team': c['won'], 'name': TEAMS[c['won']], 'at': dead, 'what': c.get('won_what')}
    if c.get('says'): seg['says'] = c['says']
    if c.get('notes'): seg['notes'] = c['notes']
    seg['dead'] = dead
    add(seg, f'point{i}')
    r = c.get('react')
    if r:   # the player who reacts, close and slow, with the name and no "Replay" badge: it is the same moment, seen closer
        add({'kind': 'replay', 't0': round(r['t0'], 2), 't1': round(r['t1'], 2), 'track': trf, 'speed': 0.5, 'focus': r['who'], 'focus_name': names[r['who']],
             'focus_team': team[r['who']], 'zoom': r.get('zoom') or zoom_for(trf, r['who'], r['t0'], r['t1']), 'title': r.get('title') or names[r['who']], 'sub': None, 'badge': None}, f'react{i}')
    r = c.get('replay')
    if r:
        a, b = round(r['t'] - r.get('before', 1.7), 2), round(r['t'] + r.get('after', 1.0), 2)
        first = seen_from(trf, r['who'], a, b)
        if first is None or b - max(a, first) < 1.2: print(f'point {i}: no replay, the tracker has player {r["who"]} for less than 1.2 s of {a}-{b}')
        else:
            a = round(max(a, first), 2)
            add({'kind': 'replay', 't0': a, 't1': b, 'track': trf, 'speed': 0.5, 'focus': r['who'], 'focus_name': names[r['who']], 'focus_team': team[r['who']],
                 'zoom': r.get('zoom') or zoom_for(trf, r['who'], a, b), 'title': r.get('title') or names[r['who']], 'sub': r.get('sub'), 'badge_left': BADGE_LEFT}, f'replay{i}')

def backdrop():
    kf_times = [float(x) for x in open(f'{S}/match/kf_times.txt')]; HDRK = hdr.kind(video)
    first = next(c for c in P['points'] if not c.get('file'))
    im = cv2.imread(f"{S}/match/kf/{int(np.argmin(np.abs(np.array(kf_times) - (first['serve_t'] + 4)))) + 1:06d}.jpg")
    return hdr.sdr(im, HDRK) if HDRK else im


if P.get('card'):
    cv2.imwrite(f'{work}/card.jpg', (gfx.stats_card_tall if TALL else gfx.stats_card)(backdrop(), P['card']['title'], [tuple(r) for r in P['card']['rows']]))
    add({'kind': 'card', 'image': f'{work}/card.jpg', 'dur': 4.0}, 'card')
if isinstance(P.get('outro'), dict):
    o = P['outro']; shot = cv2.imread(o['shot']) if o.get('shot') else None
    cv2.imwrite(f'{work}/outro.png', (gfx.end_card_tall if TALL else gfx.end_card)(backdrop(), o['line1'], o['line2'], shot, o.get('shot_title'), o.get('shot_sub')))
    add({'kind': 'card', 'image': f'{work}/outro.png', 'dur': o.get('dur', 5.0)}, 'outro')
elif P.get('outro'):
    bg = backdrop()
    cv2.imwrite(f'{work}/outro.jpg', (gfx.outro_card_tall if TALL else gfx.outro_card)(bg, P['outro'], ' · '.join(x for x in (MT.get('venue'), MT['date']) if x)))
    add({'kind': 'card', 'image': f'{work}/outro.jpg', 'dur': 2.6}, 'outro')

print('segments', len(segs)); [print(' ', os.path.basename(s)) for s in segs]
if len(sys.argv) > 6 and sys.argv[6] == 'plan': sys.exit(0)

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
