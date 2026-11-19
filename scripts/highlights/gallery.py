"""Who is who in a match, from face templates of players who agreed to be stored.

    gallery.py enrol <frames_dir> <faces.json> <match.json> <gallery.json> [candidates "0,1,2"]
    gallery.py name  <frames_dir> <faces.json> <gallery.json> "<name>,<name>,<name>,<name>" [candidates]

Clothes change from match to match, so the groups of one video (ident.py) have no names in the next one. A face
does carry over. This is biometric data, so the rules are narrow (the owner, 19 November 2026):
- only players who agreed are in the gallery, and the gallery is a file of the work folder, never the repository;
- a match is compared only with the names of its own four players, never with everybody;
- a player is asked "who is who" only when the machine cannot tell: when two or more of the four are new.

enrol: the four groups of a match have names (match.json); their best portraits (faces.py) become templates.
name:  the four groups of a new match, and the four names its page knows. Each name that is in the gallery is
       given to the group that looks most like it; one new name is the group that is left; with two or more new
       names the answer says "ask".

The models: YuNet finds the face and its five points, SFace turns it into 128 numbers (both from the OpenCV
model zoo, Apache 2.0). SFace calls two faces the same person from a cosine of 0.363.
"""
import sys, os, json, numpy as np, cv2
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import hdr

S = os.environ.get('HL_HOME') or os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SAME = 0.363
det = cv2.FaceDetectorYN.create(f'{S}/models/yunet.onnx', '', (320, 320), 0.6, 0.3, 50)
rec = cv2.FaceRecognizerSF.create(f'{S}/models/sface/face_recognition_sface_2021dec.onnx', '')
TRC = os.environ.get('HDR')


def templates(frames, cands, pick=None):
    """The 128 numbers of each usable portrait of one group."""
    out = []
    for i, o in enumerate(cands):
        if pick is not None and i not in pick: continue
        im = cv2.imread(f"{frames}/{o['f']}")
        if im is None: continue
        if TRC: im = hdr.sdr(im, TRC)
        x, y, w, h = o['face']; m = 1.2 * max(w, h); cx, cy = x + w / 2, y + h / 2
        x0, y0 = int(max(0, cx - m)), int(max(0, cy - m)); cr = im[y0:int(cy + m), x0:int(cx + m)]
        if min(cr.shape[:2]) < 40: continue
        if max(cr.shape[:2]) < 240: cr = cv2.resize(cr, None, fx=2, fy=2, interpolation=cv2.INTER_CUBIC)   # a small face: the five points need room
        det.setInputSize((cr.shape[1], cr.shape[0])); r = det.detect(cr)[1]
        if r is None: continue
        f = rec.feature(rec.alignCrop(cr, r[int(np.argmax(r[:, -1]))]))[0]
        out.append(f / (np.linalg.norm(f) + 1e-9))
    return out


def likeness(a, b):
    """How alike two sets of templates are: the mean of the best cosine of each template of a against b."""
    if not a or not b: return -1.0
    m = np.array(a) @ np.array(b).T
    return float(np.mean(np.sort(m.max(1))[-max(1, len(a) // 2):]))


def main():
    mode, frames, facesf = sys.argv[1:4]
    F = json.load(open(facesf))
    if mode == 'enrol':
        MT = json.load(open(sys.argv[4])); gf = sys.argv[5]; pick = [int(x) for x in sys.argv[6].split(',')] if len(sys.argv) > 6 else None
        G = json.load(open(gf)) if os.path.exists(gf) else {'model': 'sface_2021dec', 'players': {}}
        for k, name in MT['names'].items():
            t = templates(frames, F[str(k)], pick)
            if not t: print('no usable face for', name); continue
            p = G['players'].setdefault(name, {'templates': [], 'matches': 0})
            p['templates'] = (p['templates'] + [[round(float(v), 4) for v in f] for f in t])[-18:]; p['matches'] += 1
            print('enrolled', name, len(t), 'templates')
        json.dump(G, open(gf, 'w'))
    else:
        G = json.load(open(sys.argv[4])); names = [n.strip() for n in sys.argv[5].split(',')]
        pick = [int(x) for x in sys.argv[6].split(',')] if len(sys.argv) > 6 else None
        known = [n for n in names if n in G['players']]; new = [n for n in names if n not in G['players']]
        groups = {k: templates(frames, F[k], pick) for k in sorted(F)}
        score = {(k, n): likeness(groups[k], [np.array(t) for t in G['players'][n]['templates']]) for k in groups for n in known}
        # each known name takes the group that looks most like it, best pairs first
        got, left = {}, set(groups)
        for (k, n), v in sorted(score.items(), key=lambda kv: -kv[1]):
            if k in left and n not in got.values() and v >= SAME: got[k] = n; left.discard(k)
        missing = [n for n in known if n not in got.values()]
        if len(new) == 1 and len(left) == 1 and not missing: got[left.pop()] = new[0]
        ask = bool(left)
        print(json.dumps({'names': got, 'ask': ask, 'new': new, 'not_found': missing,
                          'scores': {f'{k}:{n}': round(v, 3) for (k, n), v in score.items()}}, indent=1))


if __name__ == '__main__':
    main()
