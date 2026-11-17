"""Find the ball in a clip: small yellow things that are in one frame and not in the frames around it.

usage: ball.py <video> <t0> <t1> <out.npz>
Writes for each frame the candidates [x, y, score, area, length, width, angle, in a moving body] (at most K), strongest first.
A padel ball is yellow-green: min(R, G) - B is high for it and low for the court, the glass, the clothes and the skin.
A ball that moves is at its place in this frame only, so the value there is higher than in the frames before and after.
"""
import sys, subprocess, numpy as np, cv2
W, H, FPS, K = 1920, 1080, 30000 / 1001, 14
KER = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (15, 15))
def frames(video, t0, t1):
    p = subprocess.Popen(['ffmpeg', '-v', 'error', '-nostdin', '-ss', f'{t0:.3f}', '-t', f'{t1 - t0:.3f}', '-i', video, '-f', 'rawvideo', '-pix_fmt', 'bgr24', '-'], stdout=subprocess.PIPE)
    while True:
        b = p.stdout.read(W * H * 3)
        if len(b) < W * H * 3: break
        yield np.frombuffer(b, np.uint8).reshape(H, W, 3)
def yellow(im):
    b, g, r = im[:, :, 0].astype(np.int16), im[:, :, 1].astype(np.int16), im[:, :, 2].astype(np.int16)
    return np.minimum(r, g) - b
class Window(dict):
    """The frames near the one in work, by number. A number outside what was read gives the nearest one that is held."""
    def at(self, i): return self[min(max(i, min(self)), max(self))]
def bodies(G, i):
    """Where something big moves (a person): the grey picture changes over an area much larger than a ball."""
    a = cv2.absdiff(G.at(i), G.at(i - 2)); b = cv2.absdiff(G.at(i), G.at(i + 2))
    m = (cv2.max(a, b) > 14).astype(np.uint8); m = cv2.morphologyEx(m, cv2.MORPH_CLOSE, KER)
    num, lab, st, _ = cv2.connectedComponentsWithStats(m, 8)
    big = np.zeros(num, np.uint8); big[1:] = st[1:, cv2.CC_STAT_AREA] >= 700
    return cv2.dilate(big[lab], KER)
def candidates(Y, i, lag=(1, 4), body=None):
    """Blobs that are yellow in frame i and not in the frames `lag` before and after."""
    d = None
    for k in lag:
        dk = Y.at(i) - np.maximum(Y.at(i - k), Y.at(i + k))
        d = dk if d is None else np.maximum(d, dk)
    d = np.clip(d, 0, 255).astype(np.uint8)
    d = cv2.GaussianBlur(d, (0, 0), 1.0)
    m = (d >= 14).astype(np.uint8)
    num, lab, st, cen = cv2.connectedComponentsWithStats(m, 8)
    out = []
    for j in range(1, num):
        x, y, w, h, area = st[j]
        if area < 4 or area > 1500 or max(w, h) > 160: continue
        sub = d[y:y + h, x:x + w] * (lab[y:y + h, x:x + w] == j)
        peak = float(sub.max()); mass = float(sub.sum())
        ys, xs = np.nonzero(sub)
        if len(xs) >= 5:
            pts = np.stack([xs, ys], 1).astype(np.float32); mu = pts.mean(0); c = np.cov((pts - mu).T) + np.eye(2) * 0.3
            ev, evec = np.linalg.eigh(c); length = 4 * np.sqrt(ev[1]); width = 4 * np.sqrt(ev[0]); ang = float(np.arctan2(evec[1, 1], evec[0, 1]))
        else: length = width = 2.0; ang = 0.0
        wsum = sub.sum() + 1e-6; cx = x + float((sub.sum(0) * np.arange(w)).sum() / wsum); cy = y + float((sub.sum(1) * np.arange(h)).sum() / wsum)
        inb = float(body[min(H - 1, int(cy)), min(W - 1, int(cx))]) if body is not None else 0.0
        out.append([cx, cy, peak, float(area), float(length), float(width), ang, inb])
    out.sort(key=lambda c: -c[2] * min(1.0, c[3] / 8))
    return out[:K]
if __name__ == '__main__':
    video, t0, t1, outp = sys.argv[1], float(sys.argv[2]), float(sys.argv[3]), sys.argv[4]
    # a rally of a minute is 1,800 frames: only the nine frames around the one in work are held (all of them was 11 GB)
    Y, G = Window(), Window(); rows = []; n = 0; done = 0; LAG = 4
    def work(i):
        c = candidates(Y, i, body=bodies(G, i)); row = np.full((K, 8), np.nan, np.float32)
        if c: row[:len(c)] = np.array(c, np.float32)
        rows.append(row)
        for d in (Y, G):
            for k in [k for k in d if k < i - LAG]: del d[k]
    for f in frames(video, t0, t1):
        Y[n] = yellow(f); G[n] = cv2.cvtColor(f, cv2.COLOR_BGR2GRAY); n += 1
        while done + LAG < n: work(done); done += 1
    while done < n: work(done); done += 1
    C = np.stack(rows) if rows else np.zeros((0, K, 8), np.float32)
    np.savez_compressed(outp, cand=C, t0=t0, fps=FPS)
    print('frames', n, 'candidates a frame', round(float(np.isfinite(C[:, :, 0]).sum(1).mean()), 1))
