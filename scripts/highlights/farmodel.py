"""Who is who at the far end, learnt without labels.

usage: farmodel.py <feat2.npz> <feat3.npz> <feat4-far.npz> <feat4-near.npz> <kf_times.txt> <ident_prefix>

The far players are small, seen from the front, in the shade behind the net and the glass: the colours the camera
end shows do not carry over (measured on this match: a black shirt with a white print reads lighter than a plain
slate one there). So, for each pair, when it plays at the far end:
1. Split its sightings into two people with no labels at all. Two people in one frame are never one person, so the
   direction along which such couples differ most is the direction that tells the partners apart. The features are
   an embedding of the upper body only (little background, so the split is not "left and right") and the spread of
   the shirt's lightness (a print).
2. One question is left for each pair: which of the two is which partner. A classifier of the two partners, learnt at
   the camera end from the same upper-body embedding, votes on every far sighting; the two groups' mean votes are
   compared with each other (the far end's haze moves both by the same amount).
Writes <ident_prefix>-far.pkl: {pair index: {a, b, pca, scaler, clf (1 = a), sure, sheet}} and a contact sheet each.
"""
import sys, os, json, pickle, numpy as np, cv2
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from court import zone
from sklearn.decomposition import PCA
from sklearn.linear_model import LogisticRegression
from sklearn.preprocessing import StandardScaler
S = os.environ.get('HL_HOME') or os.path.dirname(os.path.dirname(os.path.abspath(__file__)))   # models/, fonts/ and match/ live here
z = np.load(sys.argv[1]); x3 = np.load(sys.argv[2]); uf = np.load(sys.argv[3]); un = np.load(sys.argv[4]); pre = sys.argv[6]
times = np.array([float(v) for v in open(sys.argv[5])])
L = np.load(pre + '-labels.npz'); M = json.load(open(pre + '.json'))
names, fr, box, kp, ok = z['names'], z['frame'], z['box'], z['kp'], z['ok']; ex, okx = x3['ex'], x3['ok']
person, ident, conf = L['person'], L['ident'], L['conf']
embF, hasF, embN, hasN = uf['emb'], uf['has'], un['emb'], un['has']
t = np.array([times[int(str(names[f])[:6]) - 1] for f in fr]); zn = np.array([zone(b) or '' for b in box]); cx = (box[:, 0] + box[:, 2]) / 2
near_pair = np.array(M['near_pair']); sure = np.array(M['sure']); bn = (t // M['bin']).astype(int); pairs = M['pairs']
hh = box[:, 3] - box[:, 1]; sh = (kp[:, 5, 2] > 0.4) & (kp[:, 6, 2] > 0.4)
front = sh & (kp[:, 5, 0] > kp[:, 6, 0] + 0.06 * hh); back = sh & (kp[:, 6, 0] > kp[:, 5, 0] + 0.06 * hh)
out = {}
for p, (a, b) in enumerate(pairs):
    sel = np.where(person & (zn == 'far') & sure[bn] & (near_pair[bn] != p) & okx & hasF)[0]
    pca = PCA(32, random_state=0).fit(embF[sel])
    def feats(e, x): return np.concatenate([pca.transform(e), x * 4], 1)
    raw = feats(embF[sel], ex[sel]); sc = StandardScaler().fit(raw); X = sc.transform(raw)
    pos = {i: n for n, i in enumerate(sel)}; byf = {}
    for i in sel: byf.setdefault(fr[i], []).append(pos[i])
    two = np.array([v for v in byf.values() if len(v) == 2])
    D = X[two[:, 0]] - X[two[:, 1]]
    ev, evec = np.linalg.eig(np.linalg.solve(np.cov(X.T) + 0.05 * np.eye(X.shape[1]), D.T @ D / len(D))); w = np.real(evec[:, np.argmax(np.real(ev))])
    for it in range(8):
        mid = np.mean((X[two[:, 0]] + X[two[:, 1]]) / 2 @ w); pr = X @ w - mid
        y = (pr > 0).astype(int); y[two[:, 0]] = pr[two[:, 0]] > pr[two[:, 1]]; y[two[:, 1]] = 1 - y[two[:, 0]]
        keep = np.abs(pr) > np.percentile(np.abs(pr), 30); keep[two.ravel()] = np.repeat(np.abs(D @ w) > np.percentile(np.abs(D @ w), 30), 2)
        clf = LogisticRegression(C=0.3, max_iter=3000).fit(X[keep], y[keep]); w = clf.coef_[0]
    pr = clf.decision_function(X); grp = pr > 0
    opp = float(np.mean(grp[two[:, 0]] != grp[two[:, 1]]))
    # which group is a: the partners' classifier from the camera end votes; the groups are compared with each other
    nsel = np.where(person & (zn == 'near') & hasN & (conf > 0.9) & ((ident == a) | (ident == b)))[0]
    wts = np.where(front[nsel], 3.0, 1.0)                 # the far end shows fronts: the front views count more
    npca = PCA(32, random_state=0).fit(np.concatenate([embN[nsel], embF[sel]]))
    nsc = StandardScaler().fit(npca.transform(embN[nsel]))
    nclf = LogisticRegression(C=0.1, max_iter=3000).fit(nsc.transform(npca.transform(embN[nsel])), (ident[nsel] == a).astype(int), sample_weight=wts)
    # the far sightings are standardised by themselves: the haze shifts and flattens every feature for both partners alike
    v = nclf.decision_function(StandardScaler().fit_transform(npca.transform(embF[sel])))
    d = v[grp].mean() - v[~grp].mean(); se = np.sqrt(v[grp].var() / grp.sum() + v[~grp].var() / (~grp).sum())
    one_is_a = d > 0
    # a second, independent voice: partners keep their sides, and the far end shows them mirrored
    ns = [(i, j) for f in set(fr[nsel]) for i in [k for k in nsel if fr[k] == f and ident[k] == a][:1] for j in [k for k in nsel if fr[k] == f and ident[k] == b][:1]]
    a_left_near = float(np.mean([cx[i] < cx[j] for i, j in ns])) if ns else 0.5
    g1_left_far = float(np.mean((cx[sel][two[:, 0]] < cx[sel][two[:, 1]]) == grp[two[:, 0]]))
    side_says_one_is_a = (g1_left_far < 0.5) == (a_left_near > 0.5)
    print(f'pair {(a, b)} far: sightings {len(sel)}, couples {len(two)}, couples split {opp:.3f}; group sizes {int(grp.sum())}/{int((~grp).sum())}')
    print(f'   which is who: vote difference {d:+.2f} (standard error {se:.2f}, {abs(d) / se:.1f} of them) -> group 1 is {a if one_is_a else b}; '
          f'sides: {a} is left of {b} at the camera end in {a_left_near:.2f}, group 1 is the left one at the far end in {g1_left_far:.2f} -> sides {"agree" if side_says_one_is_a == one_is_a else "DISAGREE"}')
    ya = (grp == one_is_a).astype(int)                    # 1 = a
    final = LogisticRegression(C=0.3, max_iter=3000).fit(X[keep], ya[keep])
    out[p] = {'a': int(a), 'b': int(b), 'pca': pca, 'scaler': sc, 'clf': final, 'sure': float(abs(d) / se), 'sides_agree': bool(side_says_one_is_a == one_is_a), 'split': opp}
    # the sheet: 60 sightings of each, the surest first half and a random half
    rng = np.random.default_rng(3); rows = []
    pa = final.predict_proba(X)[:, 1]
    for who, m in ((a, pa > 0.5), (b, pa <= 0.5)):
        pick = rng.choice(np.where(m)[0], min(60, int(m.sum())), replace=False); tiles = []
        for n in pick:
            i = sel[n]; im = cv2.imread(f"{S}/match/kf/{names[fr[i]]}"); bb = box[i].astype(int)
            tiles.append(cv2.resize(im[max(0, bb[1]):bb[3], max(0, bb[0]):bb[2]], (96, 216), interpolation=cv2.INTER_CUBIC))
        while len(tiles) < 60: tiles.append(np.zeros((216, 96, 3), np.uint8))
        row = np.vstack([np.hstack(tiles[r * 20:(r + 1) * 20]) for r in range(3)]); cv2.putText(row, f'id {who}', (4, 24), cv2.FONT_HERSHEY_SIMPLEX, 0.8, (0, 255, 255), 2); rows.append(row)
    cv2.imwrite(f'{pre}-far-pair{p}.jpg', np.vstack(rows), [cv2.IMWRITE_JPEG_QUALITY, 85])
pickle.dump(out, open(pre + '-far.pkl', 'wb')); print('written')
