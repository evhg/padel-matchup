"""More about each sighting's shirt than its median colour: how dark its darkest tenth is, how light its
lightest tenth, and how far they are apart (a print on a plain shirt). usage: feat3.py <frames_dir> <feat2.npz> <out.npz>"""
import sys, numpy as np, cv2
z = np.load(sys.argv[2]); names, fr, box, kp = z['names'], z['frame'], z['box'], z['kp']
N = len(box); ex = np.zeros((N, 6), np.float32); okx = np.zeros(N, bool)
order = np.argsort(fr, kind='stable'); cur = -1; lab = None
for n, i in enumerate(order):
    if fr[i] != cur:
        cur = fr[i]; lab = cv2.cvtColor(cv2.imread(f'{sys.argv[1]}/{names[cur]}'), cv2.COLOR_BGR2LAB)
    k = kp[i]
    if min(k[5, 2], k[6, 2], k[11, 2], k[12, 2]) <= 0.3: continue
    q = np.array([k[5, :2], k[6, :2], k[12, :2], k[11, :2]]); c = q.mean(0); q = c + (q - c) * 0.8
    x0, y0 = np.floor(q.min(0)).astype(int); x1, y1 = np.ceil(q.max(0)).astype(int) + 1
    x0, y0 = max(0, x0), max(0, y0)
    if x1 - x0 < 4 or y1 - y0 < 4: continue
    m = np.zeros((y1 - y0, x1 - x0), np.uint8); cv2.fillConvexPoly(m, np.round(q - [x0, y0]).astype(np.int32), 1)
    px = lab[y0:y1, x0:x1][m[:lab[y0:y1, x0:x1].shape[0], :lab[y0:y1, x0:x1].shape[1]] > 0].astype(np.float32) / 255
    if len(px) < 20: continue
    L = px[:, 0]
    ex[i] = [np.percentile(L, 10), np.percentile(L, 50), np.percentile(L, 90), px[:, 1].std(), px[:, 2].std(), L.std()]; okx[i] = True
    if n % 4000 == 0: print(n, flush=True)
np.savez_compressed(sys.argv[3], ex=ex, ok=okx)
