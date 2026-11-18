"""Judge the ways of tx_compare.py by agreement: between the two transmitters, and between two different recognisers.

usage: tx_score.py <cmp_dir>          (PLAYERS=first names, comma separated, to count the names that are heard)
"""
import sys, json, re, glob, os, collections
d = sys.argv[1]
FILLER = ['thank you', "we'll be right back", 'thanks for watching', 'bye', 'see you soon', 'subscribe', 'see you next time', "i'll see you", 'thank you for watching', 'please subscribe', 'you']
NAMES = {x.strip().lower() for x in os.environ.get('PLAYERS', '').split(',') if x.strip()}       # first names, to count how often a name is heard
SCORE = {'love', 'fifteen', 'thirty', 'forty', 'deuce', 'advantage', 'game', 'set', 'all', 'zero', 'one', 'two', 'three', 'four', 'five', 'six', '15', '30', '40', 'point'}
PLAY = {'out', 'net', 'let', 'mine', 'yours', 'sorry', 'nice', 'good', 'shot', 'yes', 'no', 'come', 'on', 'go', 'great', 'unlucky', 'beautiful', 'switch', 'leave', 'wall', 'glass', 'serve', 'ball'}
def norm(w): return re.sub(r"[^a-z0-9']", '', w.lower())
def load(m, s):
    p = f'{d}/{m}-{s}.json'
    if not os.path.exists(p): return None
    j = json.load(open(p)); ws = [(w['t'], norm(w['w']), w.get('p')) for w in j['words'] if norm(w['w'])]
    return j, ws
def confirmed(a, b, tol=1.5):
    """how many words of a are in b within tol seconds"""
    by = collections.defaultdict(list)
    for t, w, _ in b: by[w].append(t)
    return sum(1 for t, w, _ in a if any(abs(t - u) <= tol for u in by.get(w, ())))
def filler(j):
    n = 0; seen = collections.Counter(l['text'].lower().strip(' .!?') for l in j['lines'])
    for l in j['lines']:
        x = l['text'].lower().strip(' .!?')
        if x in FILLER or seen[x] >= 3: n += len(x.split())
    return n
ms = sorted({os.path.basename(p)[0] for p in glob.glob(d + '/?-R.json')})
ALL = {m: (load(m, 'R'), load(m, 'L')) for m in ms}
print(f"{'way':4s}{'words R':>8s}{'words L':>8s}{'filler':>8s}{'both tx':>9s}{'other way':>10s}{'names':>7s}{'score':>7s}{'play':>6s}{'time s':>8s}  language / fault")
for m in ms:
    (jr, wr), (jl, wl) = ALL[m]
    cx = confirmed(wr, wl) + confirmed(wl, wr)
    others = [x for k in ms if k != m and (m, k) not in (('A', 'E'), ('E', 'A')) for x in ALL[k][0][1]]       # agreement with a different way on the same transmitter
    co = confirmed(wr, [x for k in ms if k != m for x in ALL[k][0][1]]) if len(ms) > 1 else 0
    nm = sum(1 for _, w, _ in wr + wl if w in NAMES); sc = sum(1 for _, w, _ in wr + wl if w in SCORE); pl = sum(1 for _, w, _ in wr + wl if w in PLAY)
    print(f"{m:4s}{len(wr):8d}{len(wl):8d}{filler(jr) + filler(jl):8d}{cx:9d}{co:10d}{nm:7d}{sc:7d}{pl:6d}{jr['seconds'] + jl['seconds']:8.0f}  {jr.get('language')} {jr.get('error', '')}{jl.get('error', '')}")
