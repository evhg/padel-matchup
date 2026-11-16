"""Who is who across the whole match, second version.

usage: ident.py <feat2.npz> <feat-dino.npz> <kf_times.txt> <out_prefix>

1. Seeds: four clothing groups from the near sightings (k-means on shirt and shorts colour). A seed is a
   frame with exactly two near people whose groups differ and whose groups are partners (they share the
   near end all match long), both clearly in their group.
2. A classifier per end (near, far) learns the four people from the seeds: colours of shirt, shorts and
   shoes, and an appearance embedding (logo, hair, build). The far seeds are the far people of seed
   frames' neighbours in time: they are the other pair, told apart along the partners' colour direction.
3. All people of a frame are named together: no name twice, partners at the same end, near where the
   same name stood a moment ago. A person who fits nobody is not a player.
"""
import sys, os, json, itertools, numpy as np, cv2
from sklearn.cluster import KMeans
from sklearn.decomposition import PCA
from sklearn.linear_model import LogisticRegression
from sklearn.preprocessing import StandardScaler
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from court import zone
S = os.environ.get('HL_HOME') or os.path.dirname(os.path.dirname(os.path.abspath(__file__)))   # models/, fonts/ and match/ live here
z = np.load(sys.argv[1]); zd = np.load(sys.argv[2]); times = np.array([float(x) for x in open(sys.argv[3])]); pre = sys.argv[4]
names, fr, box, kp, col, ok = z['names'], z['frame'], z['box'], z['kp'], z['col'], z['ok']
N = len(box)
# the embeddings, matched to the same sightings by frame and box
# (an .npz gives a fresh copy of an array at every access: read each one once)
dnames, dframe, dbox, demb = zd['names'], zd['frame'], zd['box'], zd['emb']
dk = {(str(dnames[f]), tuple(np.round(b[:4], 1))): i for i, (f, b) in enumerate(zip(dframe, dbox))}
emb = np.zeros((N, demb.shape[1]), np.float32); has = np.zeros(N, bool)
for i in range(N):
    j = dk.get((str(names[fr[i]]), tuple(np.round(box[i][:4], 1))))
    if j is not None: emb[i] = demb[j]; has[i] = True
t = np.array([times[int(str(names[f])[:6]) - 1] for f in fr])
zn = np.array([zone(b) or '' for b in box])
h = box[:, 3] - box[:, 1]; cx = (box[:, 0] + box[:, 2]) / 2; fy = box[:, 3]

def weigh(c):
    f = c[..., :6].copy(); f[..., [1, 2, 4, 5]] = (f[..., [1, 2, 4, 5]] - 0.5) * 1.5 + 0.5
    return f
F = weigh(col)

# not people: a weak pose, or the same box in very many frames (the padded net post)
kps = kp[:, :, 2].mean(1)
cell = np.stack([cx // 10, fy // 10, h // 10], 1).astype(int)
uniq, inv, counts = np.unique(cell, axis=0, return_inverse=True, return_counts=True)
static = counts[inv] > max(60, 0.012 * len(names))
def iou_many(b, B):
    x0 = np.maximum(b[0], B[:, 0]); y0 = np.maximum(b[1], B[:, 1]); x1 = np.minimum(b[2], B[:, 2]); y1 = np.minimum(b[3], B[:, 3])
    inter = np.clip(x1 - x0, 0, None) * np.clip(y1 - y0, 0, None)
    a = (b[2] - b[0]) * (b[3] - b[1]); A = (B[:, 2] - B[:, 0]) * (B[:, 3] - B[:, 1])
    return inter / (a + A - inter + 1e-9), inter / (np.minimum(a, A) + 1e-9)
# a thing that stands in the same box in very many frames, spread over the whole match, is not a player
same = np.zeros(N, int); spread = np.zeros(N)
osort = np.argsort(cx); cxs = cx[osort]
for i in range(N):
    lo, hi = np.searchsorted(cxs, cx[i] - 0.2 * (box[i, 2] - box[i, 0])), np.searchsorted(cxs, cx[i] + 0.2 * (box[i, 2] - box[i, 0]))
    J = osort[lo:hi]; io, _ = iou_many(box[i], box[J]); J = J[io > 0.8]
    same[i] = len(J); spread[i] = np.ptp(t[J]) if len(J) else 0
static |= (same > 0.012 * len(names)) & (spread > 0.5 * times[-1])
# the places of those things, for the clip tracker
static_boxes = []
for i in np.argsort(-same):
    if not static[i] or same[i] <= 0.012 * len(names): continue
    if any(iou_many(box[i], np.array([sb]))[0][0] > 0.5 for sb in static_boxes): continue
    static_boxes.append([float(v) for v in box[i][:4]])
print('static places', len(static_boxes), flush=True)
# two boxes on one person in a frame: keep the better one
dup = np.zeros(N, bool)
_o = np.argsort(fr, kind='stable'); _b = [0] + list(np.where(np.diff(fr[_o]) != 0)[0] + 1) + [N]
for s_, e_ in zip(_b[:-1], _b[1:]):
    g = sorted(_o[s_:e_], key=lambda i: -box[i, 4])
    for a_ in range(len(g)):
        if dup[g[a_]]: continue
        for b_ in range(a_ + 1, len(g)):
            io, ins = iou_many(box[g[a_]], box[g[b_]][None]); 
            if io[0] > 0.5 or ins[0] > 0.7: dup[g[b_]] = True
person = (kps >= 0.4) & ~static & ~dup & has & (ok[:, 0] > 0)
print('static', int(static.sum()), 'duplicates', int(dup.sum()), flush=True)
print('sightings', N, 'people', int(person.sum()), flush=True)

# 1. seeds from the near sightings
good = person & (ok[:, 1] > 0)
near = np.where((zn == 'near') & good & (box[:, 4] >= 0.6))[0]
km = KMeans(4, n_init=20, random_state=0).fit(F[near]); cen = km.cluster_centers_
d = np.linalg.norm(F[near][:, None] - cen[None], axis=2); o = np.sort(d, 1)
lab0 = d.argmin(1); conf0 = 1 - o[:, 0] / (o[:, 1] + 1e-9)
co = np.zeros((4, 4), int); byf = {}
for i, l, c in zip(near, lab0, conf0): byf.setdefault(fr[i], []).append((i, int(l), float(c)))
for ls in byf.values():
    if len(ls) == 2 and ls[0][1] != ls[1][1]: a, b = sorted((ls[0][1], ls[1][1])); co[a, b] += 1
best = max(((co[a, b] + co[c, e]), (a, b), (c, e)) for (a, b), (c, e) in [((0, 1), (2, 3)), ((0, 2), (1, 3)), ((0, 3), (1, 2))])
pairs = [best[1], best[2]]; pair_of = np.zeros(4, int); partner = {}
for p, (a, b) in enumerate(pairs): pair_of[a] = pair_of[b] = p; partner[a] = b; partner[b] = a
print('near colour groups x255:'); print((cen * 255).round(0)); print('pairs', pairs, 'counts', co.tolist())
seed_near = {}        # sighting -> identity
seed_frames = {}      # frame -> near pair
for f, ls in byf.items():
    if len(ls) == 2 and ls[0][1] != ls[1][1] and pair_of[ls[0][1]] == pair_of[ls[1][1]] and min(ls[0][2], ls[1][2]) > 0.35:
        seed_near[ls[0][0]] = ls[0][1]; seed_near[ls[1][0]] = ls[1][1]; seed_frames[f] = pair_of[ls[0][1]]
print('near seed frames', len(seed_frames), 'per pair', np.bincount(list(seed_frames.values()), minlength=2).tolist())

# far seeds: in a seed frame (the near pair is known), exactly two far people are the other pair
seed_far = {}
fbyf = {}
for i in np.where((zn == 'far') & good)[0]: fbyf.setdefault(fr[i], []).append(i)
cand = {0: [], 1: []}
for f, p in seed_frames.items():
    ls = fbyf.get(f, [])
    if len(ls) == 2: cand[1 - p].append(ls)
for p in (0, 1):
    a, b = pairs[p]; w = cen[a] - cen[b]; w = w / np.linalg.norm(w)
    for (i, j) in cand[p]:
        pi, pj = F[i] @ w, F[j] @ w
        if abs(pi - pj) > 0.08: seed_far[i], seed_far[j] = (a, b) if pi > pj else (b, a)
print('far seed people', len(seed_far), 'per identity', np.bincount(list(seed_far.values()), minlength=4).tolist())

# 2. a classifier per end, 3. name the people of each frame together; then learn again from the names
pca = PCA(48, random_state=0).fit(emb[person])
def feats(idx):
    c = col[idx].copy(); c[:, 3:6] *= ok[idx, 1:2]; c[:, 6:9] *= ok[idx, 2:3]
    return np.concatenate([c * 4.0, ok[idx, 1:3], pca.transform(emb[idx]) * 0.6], 1)
MODELS = {}
def learn(seed_near, seed_far, tag):
    P = np.full((N, 4), 0.25)
    for name, seeds, sel in (('near', seed_near, np.where((zn == 'near') & person)[0]), ('far', seed_far, np.where((zn == 'far') & person)[0])):
        si = np.array(list(seeds.keys())); sy = np.array(list(seeds.values()))
        rng = np.random.default_rng(0); perm = rng.permutation(len(si)); cut = len(si) // 5
        sc = StandardScaler().fit(feats(si))
        clf = LogisticRegression(C=0.5, max_iter=2000).fit(sc.transform(feats(si[perm[cut:]])), sy[perm[cut:]])
        acc = (clf.predict(sc.transform(feats(si[perm[:cut]]))) == sy[perm[:cut]]).mean()
        clf = LogisticRegression(C=0.5, max_iter=2000).fit(sc.transform(feats(si)), sy)
        pr = clf.predict_proba(sc.transform(feats(sel)))
        P[sel[:, None], clf.classes_[None, :]] = pr
        MODELS[name] = (sc, clf)
        print(f'{tag} {name}: labels {len(si)} per identity {np.bincount(sy, minlength=4).tolist()}, held-out accuracy {acc:.3f}, people to name {len(sel)}', flush=True)
    return P

NONE = np.log(0.10)            # a person who is nobody's good guess: no name is better than a wrong name
SPLIT = np.log(0.03)           # partners at different ends
order = np.argsort(fr, kind='stable'); bounds = [0] + list(np.where(np.diff(fr[order]) != 0)[0] + 1) + [N]
def decode(P):
    ident = np.full(N, -1); conf = np.zeros(N); margin = np.zeros(N)
    last = {}                      # identity -> (t, cx, fy, h)
    for s, e in zip(bounds[:-1], bounds[1:]):
        g = [i for i in order[s:e] if person[i] and zn[i]]
        if not g: continue
        g = sorted(g, key=lambda i: -P[i].max())[:6]
        n = len(g); tt = t[g[0]]
        sc = np.log(P[g] + 1e-6)
        for gi, i in enumerate(g):
            for k, (lt, lx, ly, lh) in last.items():
                if tt - lt <= 2.5:
                    sc[gi, k] += 0.6 - 0.6 * min(np.hypot(cx[i] - lx, fy[i] - ly) / max(h[i], lh), 3.0)
        isnear = [zn[i] == 'near' for i in g]
        opts = [list(np.argsort(-sc[gi])[:3]) + [-1] for gi in range(n)]
        res = []
        for assign in itertools.product(*opts):
            used = [a for a in assign if a >= 0]
            if len(used) != len(set(used)): continue
            v = 0.0; end = {}
            for gi, a in enumerate(assign):
                if a >= 0: v += sc[gi, a]; end[a] = isnear[gi]
                else: v += NONE
            for (a, b) in pairs:
                if a in end and b in end and end[a] != end[b]: v += SPLIT
            (a, b), (c, e2) = pairs
            for x in (a, b):
                for y in (c, e2):
                    if x in end and y in end and end[x] == end[y]: v += SPLIT / 2
            res.append((v, assign))
        res.sort(key=lambda r: -r[0]); best_a = res[0][1]
        for gi, a in enumerate(best_a):
            i = g[gi]; ident[i] = a
            # how much worse is the best naming of the frame that gives this person another name
            alt = next((v for v, asg in res[1:] if asg[gi] != a), res[0][0] - 20)
            margin[i] = res[0][0] - alt
            if a >= 0: conf[i] = float(P[i, a]); last[a] = (tt, cx[i], fy[i], h[i])
    return ident, conf, margin

P = learn(seed_near, seed_far, 'round 1')
ident, conf, margin = decode(P)
for rnd in (2, 3):
    # learn again: every person whose name the frame as a whole is sure of, the hard views included
    lab = {'near': dict(seed_near), 'far': dict(seed_far)}
    for i in np.where((ident >= 0) & (margin >= 2.3))[0]: lab[zn[i]].setdefault(i, int(ident[i]))
    P = learn(lab['near'], lab['far'], f'round {rnd}')
    old = ident; ident, conf, margin = decode(P)
    print(f'round {rnd}: names changed {int(((old != ident) & person).sum())}, named {int((ident >= 0).sum())}', flush=True)

# the ends over time, from the final names
BIN = 20.0; nb = int(times[-1] // BIN) + 1; votes = np.zeros((nb, 2))
for i in np.where(ident >= 0)[0]:
    votes[int(t[i] // BIN), pair_of[ident[i]] if zn[i] == 'near' else 1 - pair_of[ident[i]]] += 1
raw = np.where(votes.sum(1) >= 4, (votes[:, 1] > votes[:, 0]).astype(float), np.nan)
near_pair = np.zeros(nb, int); sure = np.zeros(nb, bool)
for b in range(nb):
    w = raw[max(0, b - 2):b + 3]; w = w[~np.isnan(w)]
    near_pair[b] = int(round(w.mean())) if len(w) else (near_pair[b - 1] if b else 0)
    v = votes[max(0, b - 1):b + 2].sum(0)
    sure[b] = v.sum() >= 12 and v.max() >= 0.8 * v.sum() and len(w) >= 3 and abs(w.mean() - 0.5) > 0.4
changes = [float(b * BIN) for b in range(1, nb) if near_pair[b] != near_pair[b - 1]]
print('end changes at', [f"{int(c // 60)}:{int(c % 60):02d}" for c in changes], '| certain bins', int(sure.sum()), 'of', nb)
print('sightings per identity', np.bincount(ident[ident >= 0], minlength=4).tolist(), 'not a player', int((person & (ident < 0)).sum()))
seen = np.zeros((len(names), 4), bool)
for i in np.where(ident >= 0)[0]: seen[fr[i], ident[i]] = True
print('players seen per frame: ' + ' '.join(f'{k}:{int((seen.sum(1) == k).sum())}' for k in range(5)))

out = {'pairs': [list(map(int, p)) for p in pairs], 'near_centres': cen.tolist(), 'bin': BIN, 'near_pair': near_pair.tolist(), 'sure': sure.tolist(), 'changes': changes, 'static_boxes': static_boxes,
       'static_cells': [list(map(int, u)) for u, c in zip(uniq, counts) if c > max(60, 0.012 * len(names))],
       'sightings': [{'f': str(names[fr[i]]), 't': round(float(t[i]), 2), 'box': [round(float(v), 1) for v in box[i]], 'zone': str(zn[i]), 'id': int(ident[i]), 'conf': round(float(conf[i]), 3), 'margin': round(float(margin[i]), 2)} for i in range(N) if person[i]]}
json.dump(out, open(pre + '.json', 'w'))
# each player's clothes at the camera end (shirt, shorts, shoes: median Lab), for the clip tracker
cn = []
for k in range(4):
    row = []
    for part in range(3):
        m = (ident == k) & (zn == 'near') & (conf > 0.9) & (ok[:, part] > 0)
        row += np.median(col[m][:, part * 3:part * 3 + 3], 0).tolist() if m.sum() > 20 else [0, 0, 0]
    cn.append(row)
json.dump({'near': cn}, open(pre + '-colours.json', 'w'))
np.savez_compressed(pre + '-labels.npz', ident=ident, conf=conf, P=P, person=person, margin=margin)
import pickle; pickle.dump({'pca': pca, 'models': MODELS, 'pairs': pairs}, open(pre + '-model.pkl', 'wb'))

rng = np.random.default_rng(7)
for zz in ('near', 'far'):
    rows = []
    for k in range(4):
        pick = np.where((ident == k) & (zn == zz))[0]
        pick = rng.choice(pick, min(60, len(pick)), replace=False) if len(pick) else []
        tiles = []
        for i in pick:
            im = cv2.imread(f"{S}/match/kf/{names[fr[i]]}"); b = box[i].astype(int)
            tiles.append(cv2.resize(im[max(0, b[1]):b[3], max(0, b[0]):b[2]], (64, 144), interpolation=cv2.INTER_AREA if zz == 'near' else cv2.INTER_CUBIC))
        while len(tiles) < 60: tiles.append(np.zeros((144, 64, 3), np.uint8))
        row = np.vstack([np.hstack(tiles[r * 30:(r + 1) * 30]) for r in range(2)])
        cv2.putText(row, f'id {k}', (4, 20), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (0, 255, 255), 2)
        rows.append(row)
    cv2.imwrite(f'{pre}-{zz}.jpg', np.vstack(rows), [cv2.IMWRITE_JPEG_QUALITY, 85])
print('sheets written')
