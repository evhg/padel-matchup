"""The best portrait of each player: the largest sharp face that looks at the camera.

usage: faces.py <frames_dir> <feat2.npz> <ident.json> <out.json>
A player close to the back glass has three times the face pixels of a player in a rally. The pose says where a head
is; a face detector (YuNet, MIT licence) says whether it is a face to the camera, and not the back of a head.
"""
import sys, os, json, numpy as np, cv2
S = os.environ.get('HL_HOME') or os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
frames, featf, identf, outf = sys.argv[1:5]
det = cv2.FaceDetectorYN.create(f'{S}/models/yunet.onnx', '', (320, 320), 0.6, 0.3, 50)
M = json.load(open(identf)); z = np.load(featf); zbox, zkp, zfr, znames = z['box'], z['kp'], z['frame'], z['names']
key = {(str(znames[zfr[i]]), tuple(np.round(zbox[i][:4], 1))): i for i in range(len(zbox))}
cand = {k: [] for k in range(4)}
for s in M['sightings']:
    if s['id'] < 0 or s['zone'] != 'near' or s['conf'] < 0.9 or s.get('margin', 9) < 2.3: continue
    i = key.get((s['f'], tuple(np.round(np.array(s['box'][:4], np.float32), 1))))
    if i is None: continue
    kp = zkp[i]
    if kp[:5, 2].min() < 0.5: continue
    ear = abs(kp[3, 0] - kp[4, 0])
    if ear >= 34: cand[s['id']].append((ear, s, kp))          # a smaller face has too few pixels for a card
best = {}; looked = 0
for k in range(4):
    out = []
    for ear, s, kp in sorted(cand[k], key=lambda x: -x[0])[:150]:
        im = cv2.imread(f"{frames}/{s['f']}"); hx, hy = kp[:5, 0].mean(), kp[:5, 1].mean(); w = int(ear * 3.2)
        x0, y0 = int(max(0, hx - w / 2)), int(max(0, hy - w / 2)); cr = im[y0:y0 + w, x0:x0 + w]
        if min(cr.shape[:2]) < 40: continue
        det.setInputSize((cr.shape[1], cr.shape[0])); r = det.detect(cr)[1]; looked += 1
        if r is None: continue
        f = max(r, key=lambda f: f[14])
        fx, fy, fw, fh = f[:4]
        if f[14] < 0.85 or fx < 2 or fy < 2 or fx + fw > cr.shape[1] - 2 or fy + fh > cr.shape[0] - 2: continue
        face = cr[int(fy):int(fy + fh), int(fx):int(fx + fw)]
        sharp = cv2.Laplacian(cv2.cvtColor(face, cv2.COLOR_BGR2GRAY), cv2.CV_64F).var()
        eyes = abs(f[4] - f[6]) / fw                           # eyes far apart: the face is to the camera, not sideways
        out.append({'f': s['f'], 't': s['t'], 'box': s['box'], 'face': [x0 + float(fx), y0 + float(fy), float(fw), float(fh)], 'score': float(f[14]), 'sharp': float(sharp), 'eyes': float(eyes)})
    out.sort(key=lambda o: -(o['face'][2] * min(o['sharp'], 400) ** 0.5 * (0.5 + o['eyes'])))
    best[k] = out[:6]; print(k, [(o['f'][:6], int(o['face'][2]), int(o['sharp']), round(o['eyes'], 2)) for o in out[:6]], flush=True)
print('faces looked at', looked); json.dump(best, open(outf, 'w'))
