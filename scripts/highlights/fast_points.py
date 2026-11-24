"""The points of a fast reel, with no person: where each clip's rally starts and ends, its title, its replay.

usage: fast_points.py <clean video> <request.json> <out points.json>        (HL_HOME is the work folder)

In:  match/clips.json (who.py: each clip of the phone, its match and its near pair), match/tracks/c<n>.json (track.py),
     match/match-<m>.json. Out: points.json for reel_points.py, with one opening per match after the first.

The phone's cut keeps one point in each clip, and its reaction (src/lib/reel/fastPlan.ts). So in each clip:
- the hits are the sharp clicks of the sound (above 2 kHz), 6 dB over the half second around them, 0.25 s apart;
- the rally is the run of hits with the most strong ones (`rally`); the serve is its first hit, the last shot its
  last strong one;
- the ball is dead 0.75 s after the last shot (the person who made the eighth reel set 0.7 to 0.8 s by eye);
- the clip starts 1.5 s before the serve (or at the start of the phone's clip) and runs to its end, 5 s after the
  dead ball at most: the reaction is in it;
- the title is the rally's length when it is 8 s or more ("12-second rally"), and nothing for a short point;
- a replay is the hit with the fastest wrist of a near player whom the tracker holds for 1.2 s before it, at most
  four in a reel and one in a clip; a far player is a blur in a close look (README).
- each clip gets its own cheer (cheers.py: a file is used once).
"""
import sys, os, json, subprocess, numpy as np
from scipy.signal import butter, sosfilt

SR = 16000; HOP = 160            # 10 ms
WORDS = ['one', 'two', 'three', 'four', 'five', 'six']


def hits_of(x, a, b):
    """The times of the sharp clicks in [a, b): the band over 2 kHz, 6 dB over its own median of the half second
    around, 0.25 s apart at least. A phone behind the glass hears half of the hits at best (checked on the eight
    clips of 24 November 2026: the first and the last hit of seven rallies within 0.6 s of a person's times)."""
    from scipy.ndimage import median_filter
    seg = x[int(a * SR):int(b * SR)]
    if len(seg) < SR: return []
    y = sosfilt(butter(4, 2000, 'highpass', fs=SR, output='sos'), seg)
    e = 10 * np.log10(np.add.reduceat(y ** 2, np.arange(0, len(y), HOP)) / HOP + 1e-12)
    c = e - median_filter(e, 51)
    cand = [i for i in range(1, len(e) - 1) if c[i] >= 6 and e[i] >= e[i - 1] and e[i] >= e[i + 1]]
    out = []
    for i in sorted(cand, key=lambda i: -c[i]):
        if all(abs(i - j) >= 25 for j in out): out.append(i)
    return [(round(a + i * HOP / SR, 2), round(float(c[i]), 1)) for i in sorted(out)]


def rally(hits, gap=6.0, strong=9.0):
    """The rally of a clip, as (serve, last shot), from the hits. A phone behind the glass misses hits, so a rally
    may have 6 s with none; after the point come softer sounds (a ball picked up, a ball into the fence). So: the run
    with no gap over 6 s that has the most strong hits (9 dB or more); its first hit is the serve; its last strong
    hit is the last shot (with fewer than two strong hits: the last hit before a quiet 2 s)."""
    runs, cur = [], []
    for h in hits:
        if cur and h[0] - cur[-1][0] > gap: runs.append(cur); cur = []
        cur.append(h)
    if cur: runs.append(cur)
    if not runs: return None
    r = max(runs, key=lambda r: (sum(x[1] >= strong for x in r), r[-1][0] - r[0][0], r[0][0]))
    st = [x for x in r if x[1] >= strong]
    if len(st) >= 2: last = st[-1][0]
    else: last = next((r[i][0] for i in range(len(r) - 1) if r[i + 1][0] - r[i][0] >= 2.0), r[-1][0])
    return (r[0][0], last) if last > r[0][0] else None


def wrist_speed(tr, who, t):
    """How fast the faster wrist of a player moves around t (pixels a frame, over his height), or 0."""
    p = tr['players'].get(str(who))
    if not p: return 0.0
    f = np.array(p['f']); fr = (t - tr['t0']) * tr['fps']; m = np.abs(f - fr) <= 6
    if m.sum() < 3: return 0.0
    kp = np.array(p['kp'])[m]; bx = np.array(p['box'])[m]; ff = f[m]
    hgt = np.median(bx[:, 3] - bx[:, 1]); sp = 0.0
    for w in (9, 10):
        ok = kp[:, w, 2] > 0.3
        if ok.sum() >= 3:
            d = np.linalg.norm(np.diff(kp[ok][:, w, :2], axis=0), axis=1) / np.maximum(np.diff(ff[ok]), 1)
            sp = max(sp, float(d.max() / max(hgt, 1)))
    return sp


def held_from(tr, who, a, b):
    p = tr['players'].get(str(who))
    if not p: return None
    f = np.array(p['f']) / tr['fps'] + tr['t0']; m = (f >= a) & (f <= b)
    return float(f[m][0]) if m.any() else None


def main():
    video, reqf, outf = sys.argv[1:4]
    Z = os.environ['HL_HOME']; M = f'{Z}/match'
    REQ = json.load(open(reqf)); C = json.load(open(f'{M}/clips.json'))['clips']
    raw = f'{M}/sound16k.raw'
    if not os.path.exists(raw):
        subprocess.run(['ffmpeg', '-v', 'error', '-nostdin', '-y', '-i', video, '-vn', '-ac', '1', '-ar', str(SR), '-f', 's16le', raw], check=True)
    x = np.fromfile(raw, np.int16).astype(np.float32) / 32768
    multi = len(REQ['matches']) > 1
    pts, cands = [], []
    for n, c in enumerate(C):
        a, b = c['a'], c['b']; trf = f'{M}/tracks/c{n}.json'
        hs = hits_of(x, a + 0.05, b - 0.05); sl = rally(hs)
        serve, last = sl if sl else (a + 1.5, max(a + 2.0, b - 3.5))      # no rally in the sound: the clip as it is
        r = [h for h in hs if serve - 0.01 <= h[0] <= last + 0.01]
        dead = round(min(last + 0.75, b - 0.3), 2)
        start = round(max(a + 0.05, serve - 1.5), 2)
        end = round(min(b - 0.05, dead + 5.0), 2)
        secs = int(round(last - serve))
        p = {'id': f'c{n}', 'match': f'{M}/match-{c["match"]}.json', 'start_t': start, 'serve_t': round(serve, 2), 'last_t': round(last, 2), 'dead_t': dead,
             'end': end, 'next_serve_t': round(b + 1.05, 2), 'track': trf, 'title': f'{secs}-second rally' if secs >= 8 else '',
             'sub': (f"Match {WORDS[c['match'] - 1] if c['match'] <= len(WORDS) else c['match']}" if multi else f'Point {n + 1}'), 'hits': [h[0] for h in r]}
        pts.append(p)
        if os.path.exists(trf):
            tr = json.load(open(trf))
            for who in c['near']:
                for t_, lvl in r:
                    first = held_from(tr, who, t_ - 1.7, t_ + 1.0)
                    if first is None or t_ + 1.0 - first < 1.2: continue
                    cands.append((wrist_speed(tr, who, t_) * (1 + lvl / 20), n, who, t_))
    # at most four replays, one in a clip, the fastest wrists first, then in the order of the reel
    used = set(); chosen = []
    for sp, n, who, t_ in sorted(cands, key=lambda c: -c[0]):
        if n in used or sp <= 0 or len(chosen) >= min(4, max(1, len(C) // 2)): continue
        used.add(n); chosen.append((n, who, t_))
    for n, who, t_ in chosen: pts[n]['replay'] = {'who': int(who), 't': t_, 'before': 1.5, 'after': 1.0}
    cheers = sorted(f for f in os.listdir(os.environ['CHEERS']) if f.endswith('.mp3')) if os.environ.get('CHEERS') else []
    for n, p in enumerate(pts):
        if cheers: p['cheer'] = cheers[n % len(cheers)]
    # an opening before the first clip of each match after the first (versus.py, VERSUS for the first one)
    out, seen = [], {C[0]['match']} if C else set()
    for c, p in zip(C, pts):
        if c['match'] not in seen:
            seen.add(c['match']); out.append({'file': f'{M}/versus-m{c["match"]}-wide.mp4', 'file_tall': f'{M}/versus-m{c["match"]}-tall.mp4'})
        out.append(p)
    P = {'points': out}
    if os.environ.get('ENDCARD'):
        P['outro'] = {'line1': 'A free highlights reel', 'line2': 'with every game you play on kicksma.sh', 'shot': os.environ['ENDCARD'], 'shot_title': 'The community builds Kicksmash',
                      'shot_sub': ['Tap Feedback anywhere. Tell the app', 'what annoys you or what is missing.', 'And the app builds itself.'], 'dur': 5.0}
    else:
        P['outro'] = 'Your match. Your highlights.'
    json.dump(P, open(outf, 'w'), indent=1)
    for p in pts: print(p['id'], p['start_t'], p['serve_t'], p['last_t'], p['dead_t'], p['end'], repr(p['title']), p.get('replay'), len(p['hits']), 'hits')
    print('openings', [o['file'] for o in out if o.get('file')])


if __name__ == '__main__':
    main()
