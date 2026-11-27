"""Who is who in a fast reel, with no person: four people from their clothes, names from faces and pairs.

usage: who.py <request.json> [<answer.json>]          (HL_HOME is the work folder; the files below are in match/)

In:  feat2.npz, feat-dino.npz (the sightings of the frames at 3 a second: run_det.py, cands.py, feat2.py, feat.py),
     kf_times.txt, stretches.json ({"stretches": [[a, b], ...]}: the clips of the phone in the clean file),
     court.json, kf/ (the frames). The request names the players of each match (fastreel.py's start request).
     GALLERY: the face templates of players (gallery.py); CLEAN: the clean 4K file, for the face pictures.
     <answer.json>: {"names": {"<track>": "<player id>"}}, the players' answer to names.json.
Out: who.json (always): each track, its player, how sure. When every name is sure: match-<m>.json, ident-m<m>.json,
     ident-m<m>-colours.json, ident-m<m>-model.pkl (what track.py reads), faces-chosen.json (versus.py), plan of the
     stretches (match, near pair). When a name is not sure: names/names.json and names/face-<track>.jpg, for the app.

How, and why (ident.py and ident3.py needed a person; this does not):
1. A clip of the phone is one point, so its near pair does not change inside it. In each clip the near sightings
   split into two people: two people in one frame are never one person. Then the people of all clips join into at
   most four tracks by their clothes and looks, and the two people of one clip never join.
2. The far pair of a clip is the two tracks that are not near. Which far person is which is decided clip by clip, by
   three independent voices, each against the same tracks at the near end: the look (DINO), the colour of the shirt,
   and man or woman (CLIP; it speaks only for a pair of a man and a woman, by the near end's own reading, so the
   request's "sex" is not needed). A clip gets far names when two voices or more speak and all that speak agree;
   otherwise its far players get no name: no name is better than a wrong name (`far_verdict`). On the clips of
   25 November 2026 the old rule (two voices, in 75% of the clips) named no far player; this one named 7 of 8 clips,
   all right by eye, and left the eighth (two women at the far end, colours 0.08 apart) without names.
3. The names: every way to give the four names to the tracks gets a score from the faces (gallery.py's templates of
   the players, where a player has them), from the man/woman split (when the request says who is a man and who is a
   woman), and from the pairs (the near pair of a clip are partners in its match). How sure a name is, is its share
   of the scores of all ways. A name under SURE is asked of a player, with one face picture for each such track.
"""
import sys, os, json, pickle, itertools, subprocess, numpy as np, cv2
from sklearn.decomposition import PCA
from sklearn.linear_model import LogisticRegression
from sklearn.preprocessing import StandardScaler

SURE = 0.9               # a name below this share of all the ways is asked of a player
FACE_W, FACE_0 = 15.0, 0.30   # a face: 15 per unit of cosine over 0.30 (SFace calls two faces one person from 0.363)
PAIR_W = 6.0             # a clip whose near pair are not partners in any match: this much less
SEX_W = 3.0              # the man/woman split: this many times the log of the model's probability
LOOK_0, COLOUR_0 = 0.05, 0.05   # a far voice inside this dead zone says nothing (the look, the colour of the shirt)
SEX_GAP = 0.5            # the man/woman voice speaks for a far pair only when its two tracks differ this much at the near end
SEX_0 = 0.3              # ... and inside this dead zone it says nothing


def main():
    Z = os.environ['HL_HOME']; M = f'{Z}/match'
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    from court import zone
    REQ = json.load(open(sys.argv[1])); ANS = json.load(open(sys.argv[2])) if len(sys.argv) > 2 and os.path.exists(sys.argv[2]) else {}
    # the players: one list for all the matches of the upload, in the order the request names them
    players, team_of = [], []
    for m in REQ['matches']:
        tm = {}
        for p in m['players']:
            pid = str(p.get('id') or p['name'])
            if pid not in [q['id'] for q in players]: players.append({'id': pid, 'name': p['name'], 'sex': p.get('sex')})
            tm[[q['id'] for q in players].index(pid)] = int(p['team'])
        team_of.append(tm)
    NP = len(players)
    z = np.load(f'{M}/feat2.npz'); zd = np.load(f'{M}/feat-dino.npz')
    names, fr, box, kp, col, ok = z['names'], z['frame'], z['box'], z['kp'], z['col'], z['ok']; N = len(box)
    assert (zd['frame'] == fr).all() and np.allclose(zd['box'], box), 'feat2 and feat-dino must list the same sightings'
    emb = zd['emb']
    T = np.array([float(x) for x in open(f'{M}/kf_times.txt')])
    STR = json.load(open(f'{M}/stretches.json'))['stretches']
    cuts = [a for a, b in STR] + [STR[-1][1]]
    t = np.array([T[int(str(n)[:6]) - 1] for n in names])[fr]
    st = np.searchsorted(cuts, t, side='right') - 1; st[(t >= cuts[-1])] = -1
    zn = np.array([zone(b) or '' for b in box]); h = box[:, 3] - box[:, 1]; cx = (box[:, 0] + box[:, 2]) / 2; fy = box[:, 3]
    # not people: a weak pose, a box in the same place in many frames, two boxes on one person (as ident3.py)
    cell = np.stack([cx // 10, fy // 10, h // 10], 1).astype(int); _, inv, cnt = np.unique(cell, axis=0, return_inverse=True, return_counts=True)
    static = cnt[inv] > 25
    dup = np.zeros(N, bool)
    for f in np.unique(fr):
        g = sorted(np.where(fr == f)[0], key=lambda i: -box[i, 4])
        for a in range(len(g)):
            for b in range(a + 1, len(g)):
                A, B = box[g[a]], box[g[b]]; iw = min(A[2], B[2]) - max(A[0], B[0]); ih = min(A[3], B[3]) - max(A[1], B[1])
                if iw > 0 and ih > 0 and iw * ih > 0.7 * min((A[2] - A[0]) * (A[3] - A[1]), (B[2] - B[0]) * (B[3] - B[1])): dup[g[b]] = True
    person = (kp[:, :, 2].mean(1) >= 0.4) & ~static & ~dup & (ok[:, 0] > 0) & (zn != '') & (st >= 0)
    print('sightings', N, 'people', int(person.sum()), 'near', int((person & (zn == 'near')).sum()), 'far', int((person & (zn == 'far')).sum()), 'clips', len(STR))
    pca = PCA(min(48, int(person.sum()) - 1), random_state=0).fit(emb[person])
    pemb = pca.transform(emb)
    c9 = col.copy(); c9[:, 3:6] *= ok[:, 1:2]; c9[:, 6:9] *= ok[:, 2:3]
    X = np.concatenate([c9 * 4.0, ok[:, 1:3], pemb[:, :32] * 0.3], 1)        # the look for clustering (checked: 0.3)

    def split2(idx):
        """The sightings of one end of one clip as two people: two in one frame are two people."""
        frames = {}
        for i in sorted(idx, key=lambda i: -box[i, 4]): frames.setdefault(int(fr[i]), []).append(i)
        two = [g[:2] for g in frames.values() if len(g) >= 2]
        if not two:
            return {i: 0 for i in idx}
        p0 = max(two, key=lambda p: np.linalg.norm(X[p[0]] - X[p[1]]))
        cen = [X[p0[0]].copy(), X[p0[1]].copy()]; lab = {}
        for _ in range(10):
            lab = {}
            for g in frames.values():
                if len(g) >= 2:
                    a, b = g[0], g[1]
                    keep = np.linalg.norm(X[a] - cen[0]) + np.linalg.norm(X[b] - cen[1]); swap = np.linalg.norm(X[a] - cen[1]) + np.linalg.norm(X[b] - cen[0])
                    lab[a], lab[b] = (0, 1) if keep <= swap else (1, 0)
                    for i in g[2:]: lab[i] = -1
                else:
                    lab[g[0]] = int(np.linalg.norm(X[g[0]] - cen[1]) < np.linalg.norm(X[g[0]] - cen[0]))
            cen = [X[[i for i, v in lab.items() if v == k]].mean(0) if any(v == k for v in lab.values()) else cen[k] for k in (0, 1)]
        return lab

    # 1. near: two people in each clip, then at most four tracks over all clips
    persons = []          # [clip, indices]
    for s in range(len(STR)):
        idx = np.where(person & (zn == 'near') & (st == s))[0]
        if len(idx) < 3: continue
        lab = split2(idx)
        for k in (0, 1):
            ii = np.array([i for i, v in lab.items() if v == k], int)
            if len(ii) >= 3: persons.append((s, ii))
    pm = [X[ii].mean(0) for _, ii in persons]
    cl = [[k] for k in range(len(persons))]

    def cdist(a, b):
        if {persons[k][0] for k in a} & {persons[k][0] for k in b}: return np.inf
        return float(np.mean([np.linalg.norm(pm[i] - pm[j]) for i in a for j in b]))
    merges = []
    while len(cl) > 1:
        d, i, j = min(((cdist(cl[i], cl[j]), i, j) for i in range(len(cl)) for j in range(i + 1, len(cl))), key=lambda x: x[0])
        if not np.isfinite(d) or len(cl) <= 4: break
        merges.append(round(d, 2)); cl[i] = cl[i] + cl[j]; del cl[j]
    cl.sort(key=lambda c: -sum(len(persons[k][1]) for k in c))
    K = len(cl)
    ident = np.full(N, -1)
    near_of = {s: [] for s in range(len(STR))}
    for k, c in enumerate(cl):
        for q in c: ident[persons[q][1]] = k; near_of[persons[q][0]].append(k)
    apart = min((cdist(cl[i], cl[j]) for i in range(K) for j in range(i + 1, K) if np.isfinite(cdist(cl[i], cl[j]))), default=np.inf)
    print('tracks', K, 'sightings', [int((ident == k).sum()) for k in range(K)], 'merges up to', max(merges, default=0), 'closest two tracks', round(apart, 2))
    print('near pair of each clip', [sorted(near_of[s]) for s in range(len(STR))])

    # 2. far: the two tracks that are not near; which is which, clip by clip, only where the voices agree
    far_lab = {}; far_clips = []; sexn = {}
    if K == 4:
        groups = []
        for s in range(len(STR)):
            if len(near_of[s]) != 2: continue
            pair = tuple(k for k in range(4) if k not in near_of[s])
            idx = np.where(person & (zn == 'far') & (st == s))[0]
            if len(idx) < 4: continue
            lab = split2(idx)
            sl = [np.array([i for i, v in lab.items() if v == k], int) for k in (0, 1)]
            if min(len(x) for x in sl) >= 2: groups.append((s, pair, sl))
        nmean = {k: (X[ident == k].mean(0), pemb[ident == k][:, :32].mean(0), c9[ident == k][:, :3].mean(0)) for k in range(4)}
        # voice 3: man or woman (CLIP), the near end's reading of each track against the far person's own reading. The
        # request's "sex" is not needed: the near end, where a player is large, says which track of the pair is the woman.
        woman = Woman() if groups else None
        if woman and woman.ok:
            sexn = {k: v for k, v in ((k, woman.share(f'{M}/kf', names, fr, box, near_crops(ident, k, h))) for k in range(4)) if v is not None}
            print('woman share at the near end', {k: round(v, 2) for k, v in sexn.items()})
        for s, (a, b), (s0, s1) in groups:
            # voice 1: the look (DINO); voice 2: the colour of the shirt. Each against the same tracks at the near end.
            v = []
            for key in (1, 2):
                f0 = (pemb[s0][:, :32] if key == 1 else c9[s0][:, :3]).mean(0); f1 = (pemb[s1][:, :32] if key == 1 else c9[s1][:, :3]).mean(0)
                keep = np.linalg.norm(f0 - nmean[a][key]) + np.linalg.norm(f1 - nmean[b][key]); swap = np.linalg.norm(f0 - nmean[b][key]) + np.linalg.norm(f1 - nmean[a][key])
                v.append((swap - keep) / (swap + keep + 1e-9))
            w = None
            if woman and woman.ok and a in sexn and b in sexn and abs(sexn[a] - sexn[b]) >= SEX_GAP:
                w0, w1 = (woman.share(f'{M}/kf', names, fr, box, far_crops(x, h)) for x in (s0, s1))
                if w0 is not None and w1 is not None: w = (w0 - w1) * np.sign(sexn[a] - sexn[b]); v.append(w)
            named, side = far_verdict(v)
            print(f'far c{s}: tracks {a},{b} look {v[0]:+.3f} colour {v[1]:+.3f} man/woman ' + (f'{w:+.2f}' if w is not None else 'silent') + f' -> {"names" if named else "no names"}')
            if named:
                o = (a, b) if side > 0 else (b, a)
                for i in s0: far_lab[i] = o[0]
                for i in s1: far_lab[i] = o[1]
                far_clips.append(s)
        print('far: clips with far names', len(far_clips), 'of', len(groups), far_clips)
    far_named = bool(far_clips)

    # 3. the names
    G = {'players': {}}
    if os.environ.get('GALLERY') and os.path.exists(os.environ['GALLERY']): G = json.load(open(os.environ['GALLERY']))
    def gal_key(p):
        """The gallery's entry of a player: by id, then by first name (one letter may differ: "Jon", "John")."""
        if p['id'] in G['players']: return p['id']
        for n in G['players']:
            if edits(n.lower(), p['name'].lower()) <= (1 if len(p['name']) >= 4 else 0): return n
        return None
    # faces of each track (faces.py reads the near sightings of an ident file)
    json.dump({'sightings': [{'f': str(names[fr[i]]), 't': round(float(t[i]), 2), 'box': [round(float(v), 1) for v in box[i]], 'zone': 'near', 'id': int(ident[i]), 'conf': 1.0, 'margin': 9.0}
                             for i in range(N) if ident[i] >= 0]}, open(f'{M}/ident-tracks.json', 'w'))
    here = os.path.dirname(os.path.abspath(__file__))
    subprocess.run([sys.executable, f'{here}/faces.py', f'{M}/kf', f'{M}/feat2.npz', f'{M}/ident-tracks.json', f'{M}/faces-tracks.json'], check=True, capture_output=True)
    FT = json.load(open(f'{M}/faces-tracks.json'))
    score = np.zeros((K, NP)); like = {}
    if any(gal_key(p) for p in players):
        import gallery
        for k in range(K):
            tk = gallery.templates(f'{M}/kf', FT.get(str(k), []))
            for j, p in enumerate(players):
                g = gal_key(p)
                if g and tk:
                    L = gallery.likeness(tk, [np.array(x) for x in G['players'][g]['templates']]); like[(k, j)] = round(L, 3)
                    score[k, j] += FACE_W * (L - FACE_0)
    print('faces of each track', {k: len(FT.get(str(k), [])) for k in range(K)}, 'likeness', like)
    sexp = {}
    if any(p.get('sex') in ('m', 'f') for p in players):
        sexp = sexn or woman_share(f'{M}/kf', names, fr, box, ident, K, h)
        for k, pw in sexp.items():
            for j, p in enumerate(players):
                if p.get('sex') in ('m', 'f'): score[k, j] += SEX_W * np.log(max(1e-3, pw if p['sex'] == 'f' else 1 - pw))
        print('woman share of each track', {k: round(v, 2) for k, v in sexp.items()})
    for k, pid in (ANS.get('names') or {}).items():
        j = [p['id'] for p in players].index(str(pid)) if str(pid) in [p['id'] for p in players] else None
        if j is not None and int(k) < K: score[int(k)] += -50; score[int(k), j] += 100     # a player's answer decides
    pairs_seen = [tuple(near_of[s]) for s in range(len(STR)) if len(near_of[s]) == 2]
    ways = []
    for perm in itertools.permutations(range(NP), K):
        v = sum(score[k, perm[k]] for k in range(K))
        for a, b in pairs_seen:
            if not any(perm[a] in tm and perm[b] in tm and tm[perm[a]] == tm[perm[b]] for tm in team_of): v -= PAIR_W
        ways.append((v, perm))
    vs = np.array([v for v, _ in ways]); w = np.exp(vs - vs.max()); w /= w.sum()
    best = ways[int(np.argmax(vs))][1]
    conf = [float(sum(wi for wi, (_, p) in zip(w, ways) if p[k] == best[k])) for k in range(K)]
    ask = [k for k in range(K) if conf[k] < SURE]
    who = {'tracks': [{'track': k, 'player': players[best[k]]['id'], 'name': players[best[k]]['name'], 'confidence': round(conf[k], 3), 'sightings': int((ident == k).sum()),
                       'faces': len(FT.get(str(k), [])), 'likeness': {players[j]['id']: v for (kk, j), v in like.items() if kk == k}, 'woman': round(sexp[k], 2) if k in sexp else None} for k in range(K)],
           'far_named': bool(far_named), 'state': 'names' if ask else 'sure', 'ask': ask, 'near_pairs': [sorted(near_of[s]) for s in range(len(STR))]}
    json.dump(who, open(f'{M}/who.json', 'w'), indent=1)
    print(json.dumps({'state': who['state'], 'tracks': [(x['track'], x['name'], x['confidence']) for x in who['tracks']]}))
    if ask:
        face_pictures(M, FT, ident, names, fr, box, t, K, players, best, conf, ask, REQ)
        return
    # 4. the files of track.py, versus.py and reel_points.py, with the player of each track as its id
    pid = np.full(N, -1)
    for i in range(N):
        if ident[i] >= 0: pid[i] = best[ident[i]]
        elif i in far_lab: pid[i] = best[far_lab[i]]
    clip_match = []
    for s in range(len(STR)):
        nr = [best[k] for k in near_of[s]]; m = None
        if len(nr) == 2:
            fits = [mi for mi, tm in enumerate(team_of) if all(x in tm for x in nr) and tm[nr[0]] == tm[nr[1]]]
            m = fits[0] if len(fits) == 1 else (clip_match[-1] if clip_match and clip_match[-1] in fits else (fits[0] if fits else None))
        clip_match.append(m)
    for s in range(len(STR)):       # a clip with no clear near pair keeps the match of the clip before it (or after it)
        if clip_match[s] is None: clip_match[s] = next((clip_match[x] for x in list(range(s - 1, -1, -1)) + list(range(s + 1, len(STR))) if clip_match[x] is not None), 0)
    for mi, m in enumerate(REQ['matches']):
        tm = team_of[mi]; mt = {'venue': REQ.get('venue') or '', 'date': '', 'score': m.get('score') or '',
                               'names': {str(j): players[j]['name'] for j in range(NP)}, 'team': {str(j): tm.get(j, 0) for j in range(NP)}}
        ta = ' & '.join(players[j]['name'] for j in range(NP) if tm.get(j) == 0); tb = ' & '.join(players[j]['name'] for j in range(NP) if tm.get(j) == 1)
        mt.update({'pair_a': ta, 'pair_b': tb, 'title_a': m.get('title_a') or ta, 'title_b': m.get('title_b') or tb})
        json.dump(mt, open(f'{M}/match-{mi + 1}.json', 'w'))
    # A clip's names are sure only when its near pair are partners (27 November 2026: in five of eight clips of a whole
    # film the near "pair" was two opponents, because a track held two people, and the clip named the wrong pair).
    # A clip that is not sure has no names at all: no tag, no name over a close look, no far names (reel_points.py).
    names_sure = [len(near_of[s]) == 2 and any(all(best[k] in tm for k in near_of[s]) and tm[best[near_of[s][0]]] == tm[best[near_of[s][1]]] for tm in team_of)
                  for s in range(len(STR))]
    far_clips = [s for s in far_clips if names_sure[s]]
    json.dump({'clips': [{'a': a, 'b': b, 'match': clip_match[s] + 1, 'near': [best[k] for k in near_of[s]], 'far_named': s in far_clips, 'names_sure': names_sure[s]}
                         for s, (a, b) in enumerate(STR)],
               'far_named': bool(far_clips)}, open(f'{M}/clips.json', 'w'), indent=1)
    ident_files(M, N, names, fr, box, col, ok, emb, pca, t, st, zn, person, pid, static, cnt, inv, h, STR, clip_match, near_of, best, far_clips, team_of, NP)
    chosen = {}
    for k in range(K):
        if FT.get(str(k)): chosen[str(best[k])] = FT[str(k)][:1]
    json.dump(chosen, open(f'{M}/faces-chosen.json', 'w'))
    print('WHO_SURE')


def edits(a, b):
    """The number of letters to add, remove or change to make a into b (Levenshtein). Pure."""
    row = list(range(len(b) + 1))
    for i, x in enumerate(a, 1):
        prev, row[0] = row[0], i
        for j, y in enumerate(b, 1):
            prev, row[j] = row[j], min(row[j] + 1, row[j - 1] + 1, prev + (x != y))
    return row[-1]


def ident_files(M, N, names, fr, box, col, ok, emb, pca, t, st, zn, person, pid, static, cnt, inv, h, STR, clip_match, near_of, best, far_clips, team_of, NP):
    """ident-m<m>.json, -colours.json and -model.pkl for track.py, as ident3.py wrote them. "far_clips": the spans of the
    clips whose far players have names (track.py names a far player only there, from the labelled far sightings)."""
    far_named = bool(far_clips)
    def feats(idx):
        c = col[idx].copy(); c[:, 3:6] *= ok[idx, 1:2]; c[:, 6:9] *= ok[idx, 2:3]
        return np.concatenate([c * 4.0, ok[idx, 1:3], pca.transform(emb[idx]) * 0.6], 1)
    MODELS = {}; P = np.zeros((N, NP)); margin = np.zeros(N)
    for zz in ('near', 'far'):
        if zz == 'far' and not far_named: continue
        si = np.where(person & (zn == zz) & (pid >= 0))[0]
        if len(np.unique(pid[si])) < 2: continue
        sc = StandardScaler().fit(feats(si)); clf = LogisticRegression(C=0.5, max_iter=3000).fit(sc.transform(feats(si)), pid[si])
        MODELS[zz] = (sc, clf)
        sel = np.where(person & (zn == zz))[0]; Q = np.full((len(sel), NP), 1e-3); Q[:, clf.classes_] = clf.predict_proba(sc.transform(feats(sel))); P[sel] = Q
        srt = np.sort(Q, 1); margin[sel] = np.log(srt[:, -1] + 1e-6) - np.log(srt[:, -2] + 1e-6)
    static_boxes = []
    for i in np.argsort(-cnt[inv]):
        if not static[i]: break
        if not any(min(box[i][2], sb[2]) - max(box[i][0], sb[0]) > 0.5 * (box[i][2] - box[i][0]) and min(box[i][3], sb[3]) - max(box[i][1], sb[1]) > 0.5 * h[i] for sb in static_boxes):
            static_boxes.append([float(v) for v in box[i][:4]])
    cn = []
    for k in range(NP):
        row = []
        for part in range(3):
            m = (pid == k) & (zn == 'near') & (ok[:, part] > 0)
            row += np.median(col[m][:, part * 3:part * 3 + 3], 0).tolist() if m.sum() > 10 else [0, 0, 0]
        cn.append(row)
    nb = int(STR[-1][1]) + 2
    for mi, tm in enumerate(team_of):
        S0 = [s for s in range(len(STR)) if clip_match[s] == mi]
        if not S0: continue
        pa = sorted(j for j in tm if tm[j] == 0); pb = sorted(j for j in tm if tm[j] == 1)
        first = next((s for s in S0 if len(near_of[s]) == 2), S0[0])
        near0 = sorted(best[k] for k in near_of[first]) if len(near_of[first]) == 2 else pa
        pairs = [near0, pb if near0 == pa else pa]
        npair = np.zeros(nb, int); sure = np.zeros(nb, bool)
        for b in range(nb):
            s = next((s for s in S0 if STR[s][0] <= b + 0.5 < STR[s][1]), None)
            if s is None or len(near_of[s]) != 2: continue
            nb_ = sorted(best[k] for k in near_of[s])
            if nb_ not in pairs: continue      # two opponents at one end: a track holds two people, so no end is sure
            npair[b] = pairs.index(nb_); sure[b] = True
        pre = f'{M}/ident-m{mi + 1}'
        sights = [{'f': str(names[fr[i]]), 't': round(float(t[i]), 2), 'box': [round(float(v), 1) for v in box[i]], 'zone': str(zn[i]), 'id': int(pid[i]),
                   'conf': round(float(P[i, pid[i]]) if pid[i] >= 0 else 0, 3), 'margin': round(float(margin[i]), 2)} for i in range(N) if person[i] and st[i] in S0]
        fc = [STR[s] for s in far_clips if s in S0]
        json.dump({'pairs': pairs, 'bin': 1.0, 'near_pair': npair.tolist(), 'sure': sure.tolist(), 'static_boxes': static_boxes, 'far_named': bool(fc), 'far_clips': fc,
                   'sightings': sights}, open(pre + '.json', 'w'))
        json.dump({'near': cn}, open(pre + '-colours.json', 'w'))
        pickle.dump({'pca': pca, 'models': MODELS, 'pairs': pairs}, open(pre + '-model.pkl', 'wb'))
        print('wrote', pre, 'pairs', pairs, 'clips', S0)


def far_verdict(v):
    """One clip's far names from its voices, as (named, side): side > 0 keeps the split's order, < 0 swaps it. v holds the
    look and the colour, and the man/woman voice when it speaks. A voice inside its dead zone says nothing; the clip gets
    names only when two voices or more speak and every one that speaks says the same. Pure."""
    zones = [LOOK_0, COLOUR_0, SEX_0][:len(v)]
    said = [np.sign(x) for x, z in zip(v, zones) if abs(x) > z]
    if len(said) < 2 or len(set(said)) != 1: return False, 0
    return True, int(said[0])


def near_crops(ident, k, h):
    """The largest near sightings of track k (at most 12): the man/woman reading where a player is large."""
    return sorted(np.where(ident == k)[0], key=lambda i: -h[i])[:12]


def far_crops(idx, h):
    """The largest sightings of one far person in one clip (at most 12)."""
    return sorted(idx, key=lambda i: -h[i])[:12]


class Woman:
    """The man/woman split: an open image-text model (CLIP, MIT licence), loaded once. Optional: without it, ok is False."""

    def __init__(self):
        self.ok = False
        try:
            import torch
            from transformers import CLIPModel, CLIPProcessor
            name = os.environ.get('CLIP', 'openai/clip-vit-base-patch32')
            self.torch, self.model, self.proc = torch, CLIPModel.from_pretrained(name).eval(), CLIPProcessor.from_pretrained(name)
            self.ok = True
        except Exception as e:
            print('no man/woman model:', str(e)[:200])

    def share(self, frames, names, fr, box, idx):
        """The median probability of "a woman" over the crops of the sightings idx, or None."""
        crops = []
        for i in idx:
            im = cv2.imread(f'{frames}/{names[fr[i]]}'); b = box[i].astype(int)
            c = im[max(0, b[1]):b[3], max(0, b[0]):b[2]]
            if c.size: crops.append(cv2.cvtColor(c, cv2.COLOR_BGR2RGB))
        if not crops: return None
        with self.torch.no_grad():
            x = self.proc(text=['a photo of a man playing padel', 'a photo of a woman playing padel'], images=crops, return_tensors='pt', padding=True)
            p = self.model(**x).logits_per_image.softmax(-1)[:, 1].numpy()
        return float(np.clip(np.median(p), 0.02, 0.98))


def woman_share(frames, names, fr, box, ident, K, h, woman=None):
    """The man/woman split of each track: CLIP on the largest near sightings. Optional."""
    woman = woman or Woman()
    if not woman.ok: return {}
    out = {}
    for k in range(K):
        v = woman.share(frames, names, fr, box, near_crops(ident, k, h))
        if v is not None: out[k] = v
    return out


def face_pictures(M, FT, ident, names, fr, box, t, K, players, best, conf, ask, REQ):
    """names/face-<track>.jpg (a square around the face, from the 4K file where it is there) and names/names.json."""
    d = f'{M}/names'; os.makedirs(d, exist_ok=True)
    clean = os.environ.get('CLEAN')
    tracks = []
    for k in range(K):
        fc = (FT.get(str(k)) or [None])[0]
        if fc:
            x, y, w, hh = fc['face']; tt = fc['t']; s = 3.0 * max(w, hh); cxy = (x + w / 2, y + hh / 2 + 0.25 * hh)
        else:       # no face to the camera: the largest sighting of the track
            i = max(np.where(ident == k)[0], key=lambda i: box[i, 3] - box[i, 1]); b = box[i]; tt = float(t[i])
            s = max(b[2] - b[0], b[3] - b[1]) * 0.6; cxy = ((b[0] + b[2]) / 2, b[1] + s / 2)
        img, K4 = None, 1
        if clean and os.path.exists(clean):
            r = subprocess.run(['ffmpeg', '-v', 'error', '-nostdin', '-ss', f'{tt:.3f}', '-i', clean, '-frames:v', '1', '-f', 'image2pipe', '-vcodec', 'png', '-'], capture_output=True)
            img = cv2.imdecode(np.frombuffer(r.stdout, np.uint8), cv2.IMREAD_COLOR) if r.stdout else None
            if img is not None: K4 = img.shape[1] / 1920
        if img is None:
            img = cv2.imread(f"{M}/kf/{fc['f'] if fc else names[fr[max(np.where(ident == k)[0], key=lambda i: box[i, 3] - box[i, 1])]]}"); K4 = 1
        x0, y0 = int(max(0, (cxy[0] - s / 2) * K4)), int(max(0, (cxy[1] - s / 2) * K4)); S = int(s * K4)
        crop = img[y0:y0 + S, x0:x0 + S]
        if crop.size: cv2.imwrite(f'{d}/face-{k}.jpg', cv2.resize(crop, (360, 360), interpolation=cv2.INTER_AREA if crop.shape[0] > 360 else cv2.INTER_CUBIC), [cv2.IMWRITE_JPEG_QUALITY, 88])
        tracks.append({'track': k, 'face': f'face-{k}.jpg', 'guess': players[best[k]]['id'], 'confidence': round(conf[k], 3), 'ask': k in ask})
    upload = REQ.get('upload') or ''
    json.dump({'v': 1, 'state': 'names', 'upload': upload, 'players': [{'id': p['id'], 'name': p['name']} for p in players], 'tracks': tracks,
               'answer': {'method': 'POST', 'path': f'/u/{upload}/names', 'body': {'names': {str(k): '<player id>' for k in ask}}}}, open(f'{d}/names.json', 'w'), indent=1)
    print('WHO_ASK', ask)


if __name__ == '__main__':
    main()
