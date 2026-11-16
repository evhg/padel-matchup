"""An embedding of the upper body only (head to hips, little background), enlarged: what a person looks like,
not where the person stands. usage: feat4.py <frames_dir> <feat2.npz> <out.npz> [zone=far]"""
import sys, os, numpy as np, cv2, onnxruntime as ort
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from court import zone
S = os.environ.get('HL_HOME') or os.path.dirname(os.path.dirname(os.path.abspath(__file__)))   # models/, fonts/ and match/ live here
z = np.load(sys.argv[2]); names, fr, box, kp = z['names'], z['frame'], z['box'], z['kp']; want = sys.argv[4] if len(sys.argv) > 4 else 'far'
so = ort.SessionOptions(); so.intra_op_num_threads = 4
sess = ort.InferenceSession(f'{S}/models/dinov2_small.onnx', so, providers=['CPUExecutionProvider'])
MEAN = np.array([0.485, 0.456, 0.406], np.float32); STD = np.array([0.229, 0.224, 0.225], np.float32)
def upper(img, k, b):
    """The crop from above the head to the hips, as wide as the shoulders and a little more."""
    if min(k[5, 2], k[6, 2], k[11, 2], k[12, 2]) <= 0.3: return None
    sw = abs(k[5, 0] - k[6, 0]); th = (k[11, 1] + k[12, 1]) / 2 - (k[5, 1] + k[6, 1]) / 2
    if th < 8: return None
    w = max(sw, 0.55 * th) * 1.25; cxm = (k[5, 0] + k[6, 0] + k[11, 0] + k[12, 0]) / 4
    y0 = min(b[1], (k[5, 1] + k[6, 1]) / 2 - 0.55 * th); y1 = (k[11, 1] + k[12, 1]) / 2 + 0.05 * th
    x0, x1 = int(max(0, cxm - w / 2)), int(min(img.shape[1], cxm + w / 2)); y0, y1 = int(max(0, y0)), int(min(img.shape[0], y1))
    if x1 - x0 < 6 or y1 - y0 < 10: return None
    return img[y0:y1, x0:x1]
N = len(box); emb = np.zeros((N, 768), np.float32); has = np.zeros(N, bool)
order = np.argsort(fr, kind='stable'); cur = -1; img = None; batch, idx = [], []
def flush():
    if not batch: return
    o = sess.run(None, {'pixel_values': np.stack(batch)})[0]
    emb[idx] = np.concatenate([o[:, 0], o[:, 1:].mean(1)], 1); has[idx] = True; batch.clear(); idx.clear()
for n, i in enumerate(order):
    if (zone(box[i]) or '') != want and want != 'all': continue
    if fr[i] != cur: cur = fr[i]; img = cv2.imread(f'{sys.argv[1]}/{names[cur]}')
    c = upper(img, kp[i], box[i])
    if c is None: continue
    p = cv2.resize(c, (224, 224), interpolation=cv2.INTER_CUBIC)
    batch.append(((cv2.cvtColor(p, cv2.COLOR_BGR2RGB).astype(np.float32) / 255.0 - MEAN) / STD).transpose(2, 0, 1)); idx.append(i)
    if len(batch) == 32: flush()
    if n % 3000 == 0: print(n, flush=True)
flush()
np.savez_compressed(sys.argv[3], emb=emb, has=has); print('embedded', int(has.sum()))
