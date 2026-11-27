"""The words of the two recorders after a point: votes for winner.py (improvement 3 of the Mac lab, issue 374).

usage: words.py feats scribe <left.json>,<right.json> <phone.json> <feats.json of winner.py> <out feats.json>
       words.py feats whisper <hear_words.py out.json> <phone.json> <feats.json of winner.py> <out feats.json>
       words.py count scribe|whisper <source> <phone.json> <feats.json> <engine.json> [sets=1,2]   (words by half)

Each recorder hangs on the fence of one half (NEAR_RECORDER: left on match2). For each point, the words that each
recorder heard from 0.5 s before the dead ball to 5 s after it (or to 1 s before the next serve) are put in classes:
  cheer    yes, yeah, come on, vamos, let's go, woo, nice, good, great, beautiful, shot
  regret   sorry, no, ah, oh, ow, shit, fuck, damn, seriously, whack, my bad
  call     out, net, long, fault, wide
  laugh    a laugh (Scribe's audio event; whisper does not give it)
  talk6    all words and sounds, over 6 s after the dead ball (the voice vote of winner.py takes 2 s)
Each class is one vote: the pair of the half whose recorder heard more of the class (+1: pair 0, -1: pair 1, 0: as
many). `winner.py fit` gives each its weight and its sign, on the sets it is fitted on only.
Score calls ("thirty fifteen") are not a vote: Scribe heard 7 in the whole of match2, all of them game scores.

Measured on match2 (27 November 2026, the Mac lab; chosen on sets 1 and 2, the 51 held-back points of winner.py once):
  Scribe's words: the six votes of winner.py with regret and talk6 give 73% in the cross-validation of sets 1 and 2
  (70% without) and 34 of 51 held-back points (67%; the six alone 31, 61%). talk6 25 of 38 with a vote, regret 1 of 1.
  With react.py's votes too: 34 of 51; with react.py's and ends.py's: 32 of 51 (63%).
  whisper on the Mac (hear_words.py, large-v3-turbo): it hears text in 59 and 42 of 182 windows (Scribe: words in 141
  points), and much of it is invented ("All right." 22 times). The six votes with talk6: 71% in the cross-validation,
  31 of 51 held-back points (61%). So the words of Scribe, not whisper's, are the input of these votes.
"""
import json, os, re, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

CLASSES = {
    'cheer': re.compile(r"^(yes|yeah|yay|vamos|woo+|nice|good|great|beautiful|shot|come|let's|lets)$"),
    'regret': re.compile(r"^(sorry|no+|ah+|oh+|ow+|shit|fuck|fucking|damn|seriously|whack|bad|ugh)$"),
    'call': re.compile(r"^(out|net|long|fault|wide)$"),
}
VOTESW = ('cheer', 'regret', 'call', 'laugh', 'talk6')


def clean(w): return re.sub(r"[^a-z']", '', w.lower())


def from_scribe(paths):
    """{recorder: [(recorder t, word or None, kind)]} from Scribe's two files."""
    f = dict(zip(('left', 'right'), paths.split(',')))
    return {s: [(w['t'], w['w'], w.get('kind')) for w in json.load(open(f[s]))['words']] for s in f}


def from_whisper(path, offsets):
    """The same from hear_words.py: each segment's words at the segment's start, in recorder time."""
    out = {'left': [], 'right': []}
    for win in json.load(open(path))['windows']:
        for s in out:
            for seg in win.get(s) or []:
                out[s] += [(seg[0] + offsets[s], w, 'word') for w in seg[1].split()]
    for s in out: out[s] = sorted(set(out[s]))
    return out


def counts(said, dead, until):
    """{class: n} of one recorder's words between dead - 0.5 and `until` (film time). Pure."""
    n = {k: 0 for k in VOTESW}
    for t, w, kind in said:
        if not dead - 0.5 <= t <= dead + 6.0: continue
        if kind in ('word', 'audio_event'): n['talk6'] += 1
        if t > until: continue
        if kind == 'audio_event' and 'laugh' in w.lower(): n['laugh'] += 1
        if kind != 'word': continue
        c = clean(w)
        for k, rx in CLASSES.items():
            if rx.match(c): n[k] += 1
    return n


def votes(words, offsets, dead, until, near_pair, near_rec='left'):
    """The five votes of one point. words: {recorder: [(recorder t, word, kind)]}. Pure."""
    far_rec = 'right' if near_rec == 'left' else 'left'
    n = {s: counts([(t - offsets[s], w, k) for t, w, k in words[s] if dead - 1 <= t - offsets[s] <= dead + 7], dead, until)
         for s in (near_rec, far_rec)}
    v = {}
    for k in VOTESW:
        a, b = n[near_rec][k], n[far_rec][k]
        if a == b: v[k] = 0; continue
        pair = near_pair if a > b else 1 - near_pair
        v[k] = 1 if pair == 0 else -1
    return v


def _rows_with_votes(src, source, phone, ff, near_rec):
    P = json.load(open(phone)); off = {s: P[s]['offset_s'] for s in ('left', 'right')}
    words = from_scribe(source) if src == 'scribe' else from_whisper(source, off)
    rows = sorted(json.load(open(ff)), key=lambda r: r['serve_t'])
    for i, r in enumerate(rows):
        nxt = rows[i + 1]['serve_t'] if i + 1 < len(rows) else r['dead_t'] + 30
        r['votes'].update(votes(words, off, r['dead_t'], min(r['dead_t'] + 5.0, nxt - 1.0), r['near_pair'], near_rec))
    return rows


if __name__ == '__main__':
    import winner
    cmd, src, source, phone, ff = sys.argv[1:6]; near_rec = os.environ.get('NEAR_RECORDER', 'left')
    rows = _rows_with_votes(src, source, phone, ff, near_rec)
    if cmd == 'feats':
        json.dump(rows, open(sys.argv[6], 'w'))
        print(len(rows), 'points;', ', '.join(f"{k} {sum(1 for r in rows if r['votes'][k])}" for k in VOTESW), 'with a vote')
    elif cmd == 'count':
        sets = [int(s) for s in (sys.argv[7] if len(sys.argv) > 7 else '1,2').split(',')]
        R, Y = winner._match(rows, winner._labels(sys.argv[6]), sets)
        for k in VOTESW:
            ok = [(r['votes'][k] > 0) == (y == 0) for r, y in zip(R, Y) if r['votes'][k]]
            print(f'  {k:7s} the pair of the half that said more won: {sum(ok)} of {len(ok)}')
