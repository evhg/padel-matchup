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
- the title never says a length the sound cannot prove (`rally_title`): the seconds only when every hit is heard,
  else "Long rally" or "Marathon rally" from the part of the rally that is surely in it, and nothing for a short point;
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


def rally_title(times):
    """The title of a rally from the times of its hits, and never a wrong one. A phone behind the glass hears half of
    the hits, and a ball bounced before the serve sounds like one: on 24 November 2026 the length from the first to the
    last hit said 27, 18 and 35 seconds for rallies of 12.6, 15.4 and 32.7 (a person's times). So:
    - the seconds, when no gap is over 2.5 s and the first gap is 1.6 s at most (no lone bounce before the serve);
    - else "Marathon rally" or "Long rally" when the longest run with no gap over 3 s, which is inside the rally for
      sure, is 20 s or 8 s long;
    - else nothing. Pure."""
    if len(times) < 2: return ''
    gaps = [b - a for a, b in zip(times, times[1:])]
    best, s = 0.0, times[0]
    for a, b in zip(times, times[1:]):
        if b - a > 3.0: s = b
        best = max(best, b - s)
    span = times[-1] - times[0]
    if max(gaps) <= 2.5 and gaps[0] <= 1.6 and span >= 8: return f'{int(round(span))}-second rally'
    return 'Marathon rally' if best >= 20 else 'Long rally' if best >= 8 else ''


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


def ball_spans(path, t0, fps=30000 / 1001, travel=100):
    """The flights of the ball (balllink.py) that travel `travel` px or more, as (start, end) on the clip's clock."""
    if not os.path.exists(path): return None
    d = np.load(path, allow_pickle=True); fl = d['flights']
    fl = fl.item() if fl.ndim == 0 else list(fl)
    if isinstance(fl, str): fl = json.loads(fl)
    fl = [f if isinstance(f, dict) else f.item() for f in fl]
    return sorted((t0 + f['f0'] / fps, t0 + f['f1'] / fps) for f in fl if f.get('travel', 0) >= travel)


def after_idle(spans, serve, last, gap=6.0):
    """The serve, moved past a pause with no ball in the air. Players who wait, talk or tie a shoe make sounds that the
    phone hears as hits; on 25 November 2026 a clip's "rally" began 14 s before the first ball flew (the frames show the
    wait; ball.py saw no flight from 13.9 s to 27.4 s). So when a pause of `gap` s with no flight ends after the
    sound's serve and before its last shot, the serve is the first flight after it. Pure."""
    if not spans: return serve
    for (_, a), (b, _) in zip(spans, spans[1:]):
        if b - a >= gap and a < last and b > serve - 1.5: serve = max(serve, b)
    return serve


def first_seen(tr, near, a, b):
    """The first moment in [a, b] at which the tracker holds a near player: a clip that opens on an empty court starts
    there (25 November 2026: three seconds of empty court before a rally)."""
    ts = []
    for who in near:
        p = tr['players'].get(str(who))
        if not p: continue
        f = np.array(p['f']) / tr['fps'] + tr['t0']
        # held: 15 frames or more in the next second (one stray frame on an empty court is not a player)
        for t in f[(f >= a) & (f <= b)]:
            if ((f >= t) & (f < t + 1.0)).sum() >= 15: ts.append(float(t)); break
    return min(ts) if ts else a


def held_share(tr, near, a, b):
    """How much of [a, b] the tracker holds the near pair: frames held over two players' frames. Pure."""
    n = max(int((b - a) * tr['fps']), 1) * 2; held = 0
    for who in near:
        p = tr['players'].get(str(who))
        if p:
            f = np.array(p['f']) / tr['fps'] + tr['t0']; held += int(((f >= a) & (f <= b)).sum())
    return held / n


def reaction(tr, near, dead, end):
    """The near player who moves most in the seconds after the ball is dead (arms up, a jump, a turn): the close look
    of the editor's reel (README, "After the point: the reaction first, then the replay"). None when nobody is held."""
    best = None
    for who in near:
        p = tr['players'].get(str(who))
        if not p: continue
        f = np.array(p['f']); t = f / tr['fps'] + tr['t0']; m = (t >= dead + 0.2) & (t <= min(end, dead + 3.0))
        if m.sum() < 15: continue
        kp = np.array(p['kp'])[m]; bx = np.array(p['box'])[m]; h = max(float(np.median(bx[:, 3] - bx[:, 1])), 1.0)
        ok = (kp[:, 9, 2] > 0.3) & (kp[:, 10, 2] > 0.3)
        if ok.sum() < 8: continue
        w = kp[ok][:, [9, 10], :2]; move = float(np.abs(np.diff(w, axis=0)).sum(axis=(1, 2)).mean() / h)
        up = float(((kp[ok][:, [9, 10], 1] < kp[ok][:, [5, 6], 1]).any(axis=1)).mean())
        score = move * (1 + up)
        if best is None or score > best[0]: best = (score, int(who), float(t[m][0]))
    if not best or best[0] <= 0: return None
    t0 = round(best[2], 2)
    return {'who': best[1], 't0': t0, 't1': round(min(t0 + 2.4, end), 2)}


def meter_of(clips, times, hr):
    """A player's heart rate on the reel's clock: the phone sends where each clip sits in the film and when the film
    began (meta.json "times"), the watch gives one value a minute (hr.json). Pure."""
    import datetime as dt
    if not hr or not times or len(times.get('clips', [])) != len(clips) or not times.get('recordedAt'): return None
    zone = dt.timezone(dt.timedelta(hours=7)) if hr.get('zone') == 'Asia/Bangkok' else dt.timezone.utc
    start = dt.datetime.fromisoformat(times['recordedAt'].replace('Z', '+00:00')).astimezone(zone)
    rows = {r['t']: r['bpm'] for r in hr.get('rows', [])}
    series = []
    for c, (fa, fb) in zip(clips, times['clips']):
        t = c['a']
        while t <= c['b']:
            w = start + dt.timedelta(seconds=fa + (t - c['a']))
            v = rows.get(w.strftime('%H:%M'))
            if v is not None: series.append([round(t, 2), v])
            t += 5.0
    return {'label': f"{hr.get('player', '').upper()} BPM", 'series': series} if series else None


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
        if not sl:      # no rally in the sound: not a point (25 November 2026, a clip of players who walk about)
            print(f'c{n} has no rally: left out'); pts.append(None); continue
        serve, last = sl
        serve = after_idle(ball_spans(f'{M}/ball/c{n}.npz', a), serve, last)
        r = [h for h in hs if serve - 0.01 <= h[0] <= last + 0.01]
        if len(r) < 2 or last - serve < 2.0:
            print(f'c{n} has no rally after the wait: left out'); pts.append(None); continue
        dead = round(min(last + 0.75, b - 0.3), 2)
        start = max(a + 0.05, serve - 1.5)
        if os.path.exists(trf):
            tr_ = json.load(open(trf))
            if held_share(tr_, c['near'], serve, dead) < 0.25:
                # the near pair is out of the picture for most of the rally (25 November 2026: legs at the bottom
                # edge and an empty court; the good clips held the pair 42 to 50% of each rally, this one 14%)
                print(f'c{n} shows its players too little: left out'); pts.append(None); continue
            start = max(start, first_seen(tr_, c['near'], a, dead) - 0.3)
        start = round(min(start, dead - 4.0), 2)
        end = round(min(b - 0.05, dead + 5.0), 2)
        p = {'id': f'c{n}', 'match': f'{M}/match-{c["match"]}.json', 'start_t': start, 'serve_t': round(serve, 2), 'last_t': round(last, 2), 'dead_t': dead,
             'end': end, 'next_serve_t': round(b + 1.05, 2), 'track': trf, 'title': rally_title([h[0] for h in r]),
             'sub': (f"Match {WORDS[c['match'] - 1] if c['match'] <= len(WORDS) else c['match']}" if multi else f'Point {n + 1}'), 'hits': [h[0] for h in r]}
        pts.append(p)
        if os.path.exists(trf):
            tr = json.load(open(trf))
            rx = reaction(tr, c['near'], dead, end)
            if rx: p['react'] = rx
            for who in c['near']:
                for t_, lvl in r:
                    first = held_from(tr, who, t_ - 1.7, t_ + 1.0)
                    if first is None or t_ + 1.0 - first < 1.2: continue
                    cands.append((wrist_speed(tr, who, t_) * (1 + lvl / 20), n, who, t_))
    # at most four replays, one in a clip, the fastest wrists first, and the two pairs in turn: the owner, 14 November
    # 2026, "we should of course not single out one team or one player"; on 25 November one pair had three replays
    # and the other one, and one player none
    team_of = {}
    for c in C:
        mt = json.load(open(f'{M}/match-{c["match"]}.json'))
        team_of[c['match']] = {int(k): v for k, v in mt.get('team', {}).items()}
    used = set(); chosen = []; by_team = {0: [], 1: []}
    cap = min(4, max(2, sum(p is not None for p in pts) // 2 + 1)); cap -= cap % 2      # even: as many for each pair
    for sp, n, who, t_ in sorted(cands, key=lambda c: -c[0]):
        if sp > 0 and pts[n] is not None: by_team[team_of[C[n]['match']].get(int(who), 0)].append((n, who, t_))
    seen_who = set()
    for k in range(64):
        if len(chosen) >= cap or not (by_team[0] or by_team[1]): break
        q = by_team[k % 2] or by_team[(k + 1) % 2]
        # a player who has no replay yet goes first in the pair's turn
        q.sort(key=lambda c: c[1] in seen_who)
        n, who, t_ = q.pop(0)
        if n in used: continue
        used.add(n); chosen.append((n, who, t_)); seen_who.add(who)
    for n, who, t_ in chosen: pts[n]['replay'] = {'who': int(who), 't': t_, 'before': 1.5, 'after': 1.0}
    cheers = sorted(f for f in os.listdir(os.environ['CHEERS']) if f.endswith('.mp3')) if os.environ.get('CHEERS') else []
    for n, p in enumerate(pts):
        if cheers and p is not None: p['cheer'] = cheers[n % len(cheers)]
    # an opening before the first clip of each match after the first (versus.py, VERSUS for the first one)
    out, seen = [], {C[0]['match']} if C else set()
    for c, p in zip(C, pts):
        if p is None: continue
        if c['match'] not in seen:
            seen.add(c['match']); out.append({'file': f'{M}/versus-m{c["match"]}-wide.mp4', 'file_tall': f'{M}/versus-m{c["match"]}-tall.mp4'})
        out.append(p)
    P = {'points': out}
    up = os.environ.get('UPLOAD_DIR')       # the player's upload: meta.json (the clip times) and hr.json (a watch)
    if up and os.path.exists(f'{up}/hr.json') and os.path.exists(f'{up}/meta.json'):
        m = meter_of(C, json.load(open(f'{up}/meta.json')).get('times'), json.load(open(f'{up}/hr.json')))
        if m: P['meter'] = m; print('meter', m['label'], len(m['series']), 'values')
    if os.environ.get('ENDCARD'):
        P['outro'] = {'line1': 'A free highlights reel', 'line2': 'with every game you play on kicksma.sh', 'shot': os.environ['ENDCARD'], 'shot_title': 'The community builds Kicksmash',
                      'shot_sub': ['Tap "Tell us what should change"', 'on any screen.'], 'dur': 5.0}
    else:
        P['outro'] = 'Your match. Your highlights.'
    json.dump(P, open(outf, 'w'), indent=1)
    for p in (p for p in pts if p is not None): print(p['id'], p['start_t'], p['serve_t'], p['last_t'], p['dead_t'], p['end'], repr(p['title']), p.get('replay'), len(p['hits']), 'hits')
    print('openings', [o['file'] for o in out if o.get('file')])


if __name__ == '__main__':
    main()
