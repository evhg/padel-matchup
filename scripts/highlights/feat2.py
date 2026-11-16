"""Pose-guided clothing colours for each candidate: shirt from the torso, shorts from the thighs, shoes from the ankles.

usage: feat2.py <frames_dir> <dets.jsonl> <out.npz> <keep.json>
Output arrays: names, frame, box (x0,y0,x1,y1,score), kp (17x3: x,y,score in frame pixels),
col (9: median Lab of shirt, shorts, shoes; 0..1), ok (3: enough pixels for shirt, shorts, shoes).
"""
import sys, os, json, numpy as np, cv2
from rtmlib import RTMPose

frames_dir, dets, out, keepf = sys.argv[1:5]
S = os.environ.get('HL_HOME') or os.path.dirname(os.path.dirname(os.path.abspath(__file__)))   # models/, fonts/ and match/ live here
keep = json.load(open(keepf))
pose = RTMPose(f'{S}/models/rtmpose-m/20230831/rtmpose_onnx/rtmpose-m_simcc-body7_pt-body7_420e-256x192-e48f03d0_20230504/end2end.onnx', model_input_size=(192, 256), backend='onnxruntime', device='cpu')

def med_lab(lab, poly):
    m = np.zeros(lab.shape[:2], np.uint8)
    cv2.fillConvexPoly(m, np.round(poly).astype(np.int32), 1)
    px = lab[m > 0]
    if len(px) < 12: return np.zeros(3, np.float32), 0
    return np.median(px, 0).astype(np.float32) / 255.0, len(px)

def shrink(poly, k):
    c = poly.mean(0); return c + (poly - c) * k

def colours(img, kp, b):
    """kp 17x3 in frame pixels. Works on a padded crop for speed."""
    x0, y0, x1, y1 = [int(v) for v in b[:4]]
    pad = int(0.1 * (y1 - y0)) + 4
    X0, Y0 = max(0, x0 - pad), max(0, y0 - pad)
    X1, Y1 = min(img.shape[1], x1 + pad), min(img.shape[0], y1 + pad)
    lab = cv2.cvtColor(img[Y0:Y1, X0:X1], cv2.COLOR_BGR2LAB)
    p = kp[:, :2] - np.array([X0, Y0]); s = kp[:, 2]
    col = np.zeros(9, np.float32); ok = np.zeros(3, np.float32)
    ls, rs, lh, rh, lk, rk, la, ra = p[5], p[6], p[11], p[12], p[13], p[14], p[15], p[16]
    if min(s[5], s[6], s[11], s[12]) > 0.3:
        col[0:3], n = med_lab(lab, shrink(np.array([ls, rs, rh, lh]), 0.7)); ok[0] = n >= 12
        if min(s[13], s[14]) > 0.3:
            # the upper 60% of the thighs: the shorts
            q = np.array([lh, rh, rh + 0.6 * (rk - rh), lh + 0.6 * (lk - lh)])
            # widen a thin quadrilateral (a side view) so it holds some pixels
            w = max(4.0, 0.35 * np.linalg.norm(lh - lk))
            q = q + np.array([[-w / 2, 0], [w / 2, 0], [w / 2, 0], [-w / 2, 0]]) * (1 if lh[0] < rh[0] else -1) * (np.abs(lh[0] - rh[0]) < w)
            col[3:6], n = med_lab(lab, q); ok[1] = n >= 12
    if min(s[15], s[16]) > 0.3:
        h = (y1 - y0)
        r = max(3.0, 0.035 * h)
        px = []
        for a in (la, ra):
            xa, ya = int(a[0]), int(a[1])
            px.append(lab[max(0, ya):max(0, ya) + int(2.2 * r) + 1, max(0, xa - int(1.5 * r)):xa + int(1.5 * r) + 1].reshape(-1, 3))
        px = np.concatenate(px)
        if len(px) >= 12: col[6:9] = np.median(px, 0) / 255.0; ok[2] = 1
    return col, ok

names, fidx, boxes, kps, cols, oks = [], [], [], [], [], []
n = 0
for line in open(dets):
    r = json.loads(line)
    idxs = keep.get(r['f'], [])
    if not idxs: continue
    img = cv2.imread(os.path.join(frames_dir, r['f']))
    if img is None: continue
    names.append(r['f'])
    bb = [r['d'][i] for i in idxs]
    k, s = pose(img, bboxes=[b[:4] for b in bb])
    for j, b in enumerate(bb):
        kp = np.concatenate([k[j], s[j][:, None]], 1).astype(np.float32)
        c, ok = colours(img, kp, b)
        boxes.append(b); fidx.append(len(names) - 1); kps.append(kp); cols.append(c); oks.append(ok)
    n += 1
    if n % 500 == 0: print(n, 'frames', len(boxes), 'people', flush=True)
np.savez_compressed(out, names=np.array(names), frame=np.array(fidx), box=np.array(boxes, np.float32), kp=np.array(kps, np.float32), col=np.array(cols, np.float32), ok=np.array(oks, np.float32))
print('done', len(names), 'frames', len(boxes), 'people')
