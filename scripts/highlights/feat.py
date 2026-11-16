"""Appearance features for each kept detection: a DINOv2 embedding and clothing colours.

usage: feat.py <frames_dir> <dets.jsonl> <out.npz> [keep.json]
keep.json (optional): {"frame.jpg": [indices of detections to use]}; default all.
Output arrays: frame (index into names), box (x0,y0,x1,y1,score), emb (384 CLS + 384 mean patch), col (2 x 16-bin hue/grey histograms + 2 x mean Lab).
"""
import sys, os, json, numpy as np, cv2, onnxruntime as ort

frames_dir, dets, out = sys.argv[1], sys.argv[2], sys.argv[3]
keep = json.load(open(sys.argv[4])) if len(sys.argv) > 4 else None
S = os.environ.get('HL_HOME') or os.path.dirname(os.path.dirname(os.path.abspath(__file__)))   # models/, fonts/ and match/ live here
so = ort.SessionOptions(); so.intra_op_num_threads = 4
sess = ort.InferenceSession(f'{S}/models/dinov2_small.onnx', so, providers=['CPUExecutionProvider'])
MEAN = np.array([0.485, 0.456, 0.406], np.float32); STD = np.array([0.229, 0.224, 0.225], np.float32)
PH, PW = 224, 112

def crop(img, b, pad=0.06):
    H, W = img.shape[:2]
    w, h = b[2] - b[0], b[3] - b[1]
    x0, y0 = int(max(0, b[0] - pad * w)), int(max(0, b[1] - pad * h))
    x1, y1 = int(min(W, b[2] + pad * w)), int(min(H, b[3] + pad * h))
    return img[y0:y1, x0:x1]

def colours(c):
    """Upper body (18-48% of the height) and lower body (50-75%), middle 60% of the width."""
    h, w = c.shape[:2]
    out = []
    for (a, b) in ((0.18, 0.48), (0.50, 0.75)):
        p = c[int(a * h):max(int(a * h) + 1, int(b * h)), int(0.2 * w):max(int(0.2 * w) + 1, int(0.8 * w))]
        hsv = cv2.cvtColor(p, cv2.COLOR_BGR2HSV).reshape(-1, 3).astype(np.float32)
        lab = cv2.cvtColor(p, cv2.COLOR_BGR2LAB).reshape(-1, 3).astype(np.float32)
        hist = np.zeros(16, np.float32)
        grey = hsv[:, 1] < 40
        for k, (lo, hi) in enumerate(((0, 64), (64, 128), (128, 192), (192, 256))): hist[12 + k] = np.sum(grey & (hsv[:, 2] >= lo) & (hsv[:, 2] < hi))
        hb = (hsv[~grey, 0] / 15).astype(int).clip(0, 11)
        for k in range(12): hist[k] = np.sum(hb == k)
        hist /= max(1, hist.sum())
        out.append(np.concatenate([hist, lab.mean(0) / 255.0]))
    return np.concatenate(out)

names, fidx, boxes, embs, cols = [], [], [], [], []
batch, meta = [], []
def flush():
    if not batch: return
    x = np.stack(batch).astype(np.float32)
    o = sess.run(None, {'pixel_values': x})[0]
    e = np.concatenate([o[:, 0], o[:, 1:].mean(1)], 1)
    embs.extend(e); batch.clear()

n = 0
for line in open(dets):
    r = json.loads(line)
    idxs = keep.get(r['f'], []) if keep is not None else range(len(r['d']))
    if not len(idxs): continue
    img = cv2.imread(os.path.join(frames_dir, r['f']))
    if img is None: continue
    names.append(r['f'])
    for i in idxs:
        b = r['d'][i]
        c = crop(img, b)
        if c.size == 0 or c.shape[0] < 12 or c.shape[1] < 6: continue
        cols.append(colours(c)); boxes.append(b); fidx.append(len(names) - 1)
        p = cv2.resize(c, (PW, PH), interpolation=cv2.INTER_AREA if c.shape[0] > PH else cv2.INTER_CUBIC)
        p = (cv2.cvtColor(p, cv2.COLOR_BGR2RGB).astype(np.float32) / 255.0 - MEAN) / STD
        batch.append(p.transpose(2, 0, 1))
        if len(batch) == 32: flush()
    n += 1
    if n % 500 == 0: print(n, 'frames', len(boxes), 'crops', flush=True)
flush()
np.savez_compressed(out, names=np.array(names), frame=np.array(fidx), box=np.array(boxes, np.float32), emb=np.array(embs, np.float32), col=np.array(cols, np.float32))
print('done', len(names), 'frames', len(boxes), 'crops')
