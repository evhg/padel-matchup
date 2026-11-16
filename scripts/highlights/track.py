"""Follow the four players through one clip and name them from all their sightings together.

usage: track.py <video> <ident_prefix> <t0> <t1> <out.json>
<ident_prefix>.json has the ends over time; <ident_prefix>-model.pkl has the two classifiers (near, far).

Detection on every 4th frame, the pose on every 2nd. Sightings chain into tracklets by overlap; a tracklet
ends where two people overlap (so a crossing never swaps two names). Each tracklet takes the name that all
its sightings together fit best; the end of the court limits the choice to the pair that plays there; two
tracklets alive together never share a name.
Output: {"fps", "t0", "frames", "players": {id: {"f", "box", "kp", "head"}}, "sure": {id: margin}}
"""
import sys, os, json, pickle, numpy as np, cv2, onnxruntime as ort
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from people import Finder, read_frames
from court import zone

video, pre, t0, t1, out = sys.argv[1], sys.argv[2], float(sys.argv[3]), float(sys.argv[4]), sys.argv[5]
S = os.environ.get('HL_HOME') or os.path.dirname(os.path.dirname(os.path.abspath(__file__)))   # models/, fonts/ and match/ live here
FPS = 30000 / 1001
DET_EVERY, POSE_EVERY = 4, 2
fd = Finder(None)
M = json.load(open(pre + '.json')); K = pickle.load(open(pre + '-model.pkl', 'rb'))
pairs = [tuple(p) for p in M['pairs']]
so = ort.SessionOptions(); so.intra_op_num_threads = 4
dino = ort.InferenceSession(f'{S}/models/dinov2_small.onnx', so, providers=['CPUExecutionProvider'])
MEAN = np.array([0.485, 0.456, 0.406], np.float32); STD = np.array([0.229, 0.224, 0.225], np.float32)

def embed(img, boxes):
    xs = []
    for b in boxes:
        H, W = img.shape[:2]; w, h = b[2] - b[0], b[3] - b[1]
        c = img[int(max(0, b[1] - 0.06 * h)):int(min(H, b[3] + 0.06 * h)), int(max(0, b[0] - 0.06 * w)):int(min(W, b[2] + 0.06 * w))]
        if c.size == 0 or c.shape[0] < 12 or c.shape[1] < 6: xs.append(np.zeros((3, 224, 112), np.float32)); continue
        p = cv2.resize(c, (112, 224), interpolation=cv2.INTER_AREA if c.shape[0] > 224 else cv2.INTER_CUBIC)
        xs.append(((cv2.cvtColor(p, cv2.COLOR_BGR2RGB).astype(np.float32) / 255.0 - MEAN) / STD).transpose(2, 0, 1))
    o = dino.run(None, {'pixel_values': np.stack(xs)})[0]
    return np.concatenate([o[:, 0], o[:, 1:].mean(1)], 1)

def proba(col, ok, emb, zn):
    c = col.copy(); c[3:6] *= ok[1]; c[6:9] *= ok[2]
    x = np.concatenate([c * 4.0, ok[1:3], K['pca'].transform(emb[None])[0] * 0.6])[None]
    sc, clf = K['models'][zn]
    p = np.zeros(4); p[clf.classes_] = clf.predict_proba(sc.transform(x))[0]
    return p

KF = pickle.load(open(pre + '-far.pkl', 'rb')) if os.path.exists(pre + '-far.pkl') else {}
def upper(img, k, b):
    """The crop from above the head to the hips (as feat4.py)."""
    if min(k[5, 2], k[6, 2], k[11, 2], k[12, 2]) <= 0.3: return None
    sw = abs(k[5, 0] - k[6, 0]); th = (k[11, 1] + k[12, 1]) / 2 - (k[5, 1] + k[6, 1]) / 2
    if th < 8: return None
    w = max(sw, 0.55 * th) * 1.25; cxm = (k[5, 0] + k[6, 0] + k[11, 0] + k[12, 0]) / 4
    y0 = min(b[1], (k[5, 1] + k[6, 1]) / 2 - 0.55 * th); y1 = (k[11, 1] + k[12, 1]) / 2 + 0.05 * th
    x0, x1 = int(max(0, cxm - w / 2)), int(min(img.shape[1], cxm + w / 2)); y0, y1 = int(max(0, y0)), int(min(img.shape[0], y1))
    if x1 - x0 < 6 or y1 - y0 < 10: return None
    return img[y0:y1, x0:x1]
def spread(img, k):
    """The shirt's lightness: darkest tenth, middle, lightest tenth, and the spreads (as feat3.py)."""
    q = np.array([k[5, :2], k[6, :2], k[12, :2], k[11, :2]]); c = q.mean(0); q = c + (q - c) * 0.8
    x0, y0 = np.floor(q.min(0)).astype(int); x1, y1 = np.ceil(q.max(0)).astype(int) + 1
    x0, y0 = max(0, x0), max(0, y0)
    if x1 - x0 < 4 or y1 - y0 < 4: return None
    lab = cv2.cvtColor(img[y0:y1, x0:x1], cv2.COLOR_BGR2LAB)
    m = np.zeros(lab.shape[:2], np.uint8); cv2.fillConvexPoly(m, np.round(q - [x0, y0]).astype(np.int32), 1)
    px = lab[m > 0].astype(np.float32) / 255
    if len(px) < 20: return None
    L = px[:, 0]
    return np.array([np.percentile(L, 10), np.percentile(L, 50), np.percentile(L, 90), px[:, 1].std(), px[:, 2].std(), L.std()], np.float32)
def far_proba(img, people, fp):
    """The far pair's own model: P(a) for each far person, from the upper body and the shirt's print."""
    m = KF[fp]; xs, exs, who = [], [], []
    for n, p in enumerate(people):
        c = upper(img, p['kp'], p['box']); e = spread(img, p['kp'])
        if c is None or e is None: continue
        q = cv2.resize(c, (224, 224), interpolation=cv2.INTER_CUBIC)
        xs.append(((cv2.cvtColor(q, cv2.COLOR_BGR2RGB).astype(np.float32) / 255.0 - MEAN) / STD).transpose(2, 0, 1)); exs.append(e); who.append(n)
    out = {}
    if xs:
        o = dino.run(None, {'pixel_values': np.stack(xs)})[0]; e = np.concatenate([o[:, 0], o[:, 1:].mean(1)], 1)
        pa = m['clf'].predict_proba(m['scaler'].transform(np.concatenate([m['pca'].transform(e), np.array(exs) * 4], 1)))[:, 1]
        for n, v in zip(who, pa):
            P = np.zeros(4); P[m['a']] = v; P[m['b']] = 1 - v; out[n] = P
    return out
_mid = (t0 + t1) / 2; _b = min(len(M['near_pair']) - 1, int(_mid // M['bin']))
npair, sure = M['near_pair'][_b], M['sure'][_b]

def iou(a, b):
    iw = min(a[2], b[2]) - max(a[0], b[0]); ih = min(a[3], b[3]) - max(a[1], b[1])
    if iw <= 0 or ih <= 0: return 0.0
    i = iw * ih
    return i / ((a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - i)

def kp_box(kp, old):
    v = kp[kp[:, 2] > 0.3]
    if len(v) < 6: return old
    x0, y0, x1, y1 = v[:, 0].min(), v[:, 1].min(), v[:, 0].max(), v[:, 1].max()
    h = y1 - y0
    return [x0 - 0.08 * h, y0 - 0.12 * h, x1 + 0.08 * h, y1 + 0.06 * h, old[4]]

tracklets = []   # {'s': [(frame, box, kp)], 'lp': [log-probabilities], 'zn': [zones], 'last': frame}
n = 0
for t, img in read_frames(video, t0, t1 - t0):
    f = n; n += 1
    if f % DET_EVERY == 0:
        ppl = [p for p in fd.frame(img, t, far_score=0.3) if p['ok'][0] and not any(iou(p['box'], sb) > 0.5 for sb in M.get('static_boxes', []))]
        if ppl:
            E = embed(img, [p['box'] for p in ppl])
            for p, e in zip(ppl, E): p['P'] = proba(p['col'], p['ok'], e, p['zone'])
            if sure and (1 - npair) in KF:
                far = [p for p in ppl if p['zone'] == 'far']
                got = far_proba(img, far, 1 - npair)
                for qi, p in enumerate(far): p['P'] = got.get(qi)      # no clear upper body: no vote
        # two people on top of each other: both tracklets end here
        crowd = {i for i in range(len(ppl)) for j in range(len(ppl)) if i != j and ppl[i]['zone'] == ppl[j]['zone'] and iou(ppl[i]['box'], ppl[j]['box']) > 0.15}   # partners only: a near and a far player never trade names
        used = set()
        for pi, p in sorted(enumerate(ppl), key=lambda x: -x[1]['box'][4]):
            best, bi = 0.25, None
            if pi not in crowd:
                for ti, tr in enumerate(tracklets):
                    if ti in used or tr.get('dead') or f - tr['det'] > 3 * DET_EVERY: continue
                    o = max(iou(p['box'], tr['s'][-1][1]), iou(p['box'], tr['dbox']))
                    if o > best: best, bi = o, ti
            else:
                for tr in tracklets:
                    if not tr.get('dead') and f - tr['det'] <= 3 * DET_EVERY and iou(p['box'], tr['s'][-1][1]) > 0.25: tr['dead'] = True
            if bi is None:
                tracklets.append({'s': [], 'lp': [], 'lf': [], 'zn': [], 'col': [], 'ok': [], 'last': f, 'det': f, 'dbox': p['box']}); bi = len(tracklets) - 1
            used.add(bi); tr = tracklets[bi]
            tr['s'].append((f, p['box'], p['kp'])); tr['lp'].append(np.log(p['P'] + 0.02) if p['P'] is not None else np.zeros(4)); tr['zn'].append(p['zone']); tr['lf'].append(f); tr['col'].append(p['col']); tr['ok'].append(p['ok']); tr['last'] = f; tr['det'] = f; tr['dbox'] = p['box']
    elif f % POSE_EVERY == 0:
        live = [tr for tr in tracklets if not tr.get('dead') and f - tr['det'] < DET_EVERY]
        if live:
            boxes = []
            for tr in live:
                b = tr['s'][-1][1]; w, h = b[2] - b[0], b[3] - b[1]
                boxes.append([b[0] - 0.12 * w, b[1] - 0.06 * h, b[2] + 0.12 * w, b[3] + 0.06 * h, b[4]])
            kps = fd.poses(img, boxes)
            for tr, kp, bb in zip(live, kps, boxes):
                if kp[:, 2].mean() < 0.35: continue
                nb = kp_box(kp, tr['s'][-1][1]); d = tr['dbox']; dh = d[3] - d[1]
                # the pose must stay on the detected person: a bigger person who walks in front must not take the tracklet over
                if not (0.6 * dh <= nb[3] - nb[1] <= 1.4 * dh) or abs((nb[0] + nb[2]) / 2 - (d[0] + d[2]) / 2) > 0.5 * dh: continue
                tr['s'].append((f, nb, kp)); tr['last'] = f

def moved(tr):
    c = np.array([[(b[0] + b[2]) / 2, b[3]] for (_, b, _) in tr['s']]); hgt = np.median([b[3] - b[1] for (_, b, _) in tr['s']])
    return float(np.ptp(c, 0).max() / hgt)
# a tracklet of some length that never moves is a thing, not a player
tracklets = [tr for tr in tracklets if len(tr['lp']) >= 3 and not (tr['s'][-1][0] - tr['s'][0][0] >= 60 and moved(tr) < 0.10)]
# A tracklet that looks like one partner first and like the other afterwards followed two people (one walked in
# front of the other): cut it there. (Seen in the first match: one name went on standing over the partner after they crossed.)
def cut(tr):
    zz = max(set(tr['zn']), key=tr['zn'].count); a, b = pairs[npair] if zz == 'near' else pairs[1 - npair]
    d = np.array([lp[a] - lp[b] for lp in tr['lp']]); n = len(d)
    if n < 8: return [tr]
    best, bk = 0.0, None
    for k in range(4, n - 3):
        s1, s2 = d[:k].sum(), d[k:].sum()
        if s1 * s2 < 0 and min(abs(s1), abs(s2)) > max(best, 12.0) and min(np.mean(np.sign(d[:k]) == np.sign(s1)), np.mean(np.sign(d[k:]) == np.sign(s2))) >= 0.75: best, bk = min(abs(s1), abs(s2)), k
    if bk is None: return [tr]
    fcut = tr['lf'][bk]; one, two = {}, {}
    for key in ('lp', 'lf', 'zn', 'col', 'ok'): one[key], two[key] = tr[key][:bk], tr[key][bk:]
    one['s'] = [x for x in tr['s'] if x[0] < fcut]; two['s'] = [x for x in tr['s'] if x[0] >= fcut]
    return [one, two]
if sure: tracklets = [part for tr in tracklets for part in cut(tr)]
# two tracklets on one person: keep the longer one
def same_person(a, b):
    fa = {f: bx for (f, bx, _) in a['s']}; com = [(fa[f], bx) for (f, bx, _) in b['s'] if f in fa]
    return len(com) >= 0.5 * min(len(a['s']), len(b['s'])) and np.mean([iou(x, y) for x, y in com]) > 0.5
tracklets.sort(key=lambda tr: -len(tr['s'])); kept = []
for tr in tracklets:
    if not any(same_person(tr, k) for k in kept): kept.append(tr)
tracklets = kept
score = np.zeros((len(tracklets), 4))
for ti, tr in enumerate(tracklets):
    score[ti] = np.sum(tr['lp'], 0)
    zn = max(set(tr['zn']), key=tr['zn'].count)
    if sure:
        allowed = pairs[npair] if zn == 'near' else pairs[1 - npair]
        for k in range(4):
            if k not in allowed: score[ti, k] = -1e9
span = [(tr['s'][0][0], tr['s'][-1][0]) for tr in tracklets]
# Partners against each other. The two players of one end stand in the same light, so the difference between their
# clothes is the same difference the camera end shows, whatever the haze of the glass and the net does to both.
# (The far classifier alone swapped two partners: black and slate blue look alike behind the net, one at a time.)
CN = np.array(json.load(open(pre + '-colours.json'))['near'])
def clothes(tr):
    c, o = np.array(tr['col']), np.array(tr['ok']); m = np.zeros(9); has = np.zeros(9, bool)
    for part in range(3):
        k = o[:, part] > 0
        if k.sum() >= 3: m[part * 3:part * 3 + 3] = np.median(c[k][:, part * 3:part * 3 + 3], 0); has[part * 3:part * 3 + 3] = True
    return m, has
zone_of = [max(set(tr['zn']), key=tr['zn'].count) for tr in tracklets]
rel = np.zeros(len(tracklets))
if sure:
    for zz, w in (('near', 1.0),):      # at the far end the colours of the camera end do not hold: see farmodel.py
        a, b = pairs[npair] if zz == 'near' else pairs[1 - npair]
        idx = [i for i in range(len(tracklets)) if zone_of[i] == zz]
        if not idx: continue
        cl = {i: clothes(tracklets[i]) for i in idx}
        delta = CN[a] - CN[b]
        mids, wts = [], []
        for x in idx:
            for y in idx:
                ov = min(span[x][1], span[y][1]) - max(span[x][0], span[y][0])
                if x < y and ov >= 15 and (cl[x][1] & cl[y][1]).any(): mids.append((cl[x][0] + cl[y][0]) / 2); wts.append(ov)
        mid = np.average(mids, 0, wts) if mids else np.average([cl[i][0] for i in idx], 0, [len(tracklets[i]['lp']) for i in idx])
        for i in idx:
            has = cl[i][1]
            if not has.any(): continue
            d = delta * has; nrm = np.linalg.norm(d)
            if nrm < 0.05: continue           # partners in the same clothes: the colours say nothing
            rel[i] = len(tracklets[i]['lp']) * float(((cl[i][0] - mid) * has) @ d / nrm) / 0.04
            score[i, a] = w * score[i, a] + rel[i]; score[i, b] = w * score[i, b] - rel[i]
ident = [-1] * len(tracklets)
srt = np.sort(score, 1); margin = srt[:, -1] - srt[:, -2]
for ti in np.argsort(-margin):
    for k in np.argsort(-score[ti]):
        if score[ti, k] < -1e8: break
        # a second-choice name must still fit: no name is better than a wrong name
        if score[ti, k] < score[ti].max() and score[ti, k] / len(tracklets[ti]['lp']) < np.log(0.2): break
        clash = any(ident[tj] == k and not (span[tj][1] < span[ti][0] or span[ti][1] < span[tj][0]) for tj in range(len(tracklets)) if tj != ti)
        if not clash: ident[ti] = int(k); break

players = {}; sureness = {}
for ti, tr in enumerate(tracklets):
    if ident[ti] < 0: continue
    k = ident[ti]
    p = players.setdefault(k, {'f': [], 'box': [], 'kp': [], 'head': []})
    other = max(score[ti, j] for j in range(4) if j != k and score[ti, j] > -1e8) if any(j != k and score[ti, j] > -1e8 for j in range(4)) else score[ti, k] - 50
    sureness[k] = sureness.get(k, 0.0) + float(score[ti, k] - other)
    for (f, b, kp) in tr['s']:
        p['f'].append(int(f)); p['box'].append([round(float(v), 1) for v in b[:4]]); p['kp'].append(np.round(kp, 1).tolist())
        hd = kp[:5][kp[:5, 2] > 0.3]
        p['head'].append([round(float(hd[:, 0].mean()), 1), round(float(hd[:, 1].min() - 0.11 * (b[3] - b[1])), 1)] if len(hd) else [round(float((b[0] + b[2]) / 2), 1), round(float(b[1]), 1)])
for k, p in players.items():
    o = np.argsort(p['f'], kind='stable')
    for key in ('f', 'box', 'kp', 'head'): p[key] = [p[key][i] for i in o]
    # two tracklets of one name never share a frame, but keep the frames strictly rising for the renderer
    keep = [i for i in range(len(p['f'])) if i == 0 or p['f'][i] > p['f'][i - 1]]
    for key in ('f', 'box', 'kp', 'head'): p[key] = [p[key][i] for i in keep]
json.dump({'fps': FPS, 't0': t0, 'frames': n, 'near_pair': int(npair), 'ends_sure': bool(sure), 'players': players, 'sure': {str(k): round(v, 1) for k, v in sureness.items()},
           'tracklets': [{'id': ident[ti], 'from': span[ti][0], 'to': span[ti][1], 'n': len(tr['lp']), 'score': [round(float(x), 1) for x in np.maximum(score[ti], -999)], 'zone': zone_of[ti], 'rel': round(float(rel[ti]), 1)} for ti, tr in enumerate(tracklets)]}, open(out, 'w'))
print(f'clip {t0:.1f}-{t1:.1f}: {n} frames, near pair {npair} sure {sure}, tracklets {len(tracklets)}, players ' + ' '.join(f"{k}:{len(p['f'])} (margin {sureness[k]:.0f})" for k, p in sorted(players.items())), flush=True)
