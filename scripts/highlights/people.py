"""People in one frame: detect, keep those on the court, read the pose and the clothing colours, name them."""
import os, json, subprocess, numpy as np, cv2
from det import Yolox, detect
from court import zone, TILES as _CT
from rtmlib import RTMPose

S = os.environ.get('HL_HOME') or os.path.dirname(os.path.dirname(os.path.abspath(__file__)))   # models/, fonts/ and match/ live here
TILES = _CT or [(480, 240, 640, 400), (800, 240, 640, 400), (0, 220, 640, 640), (1280, 220, 640, 640)]
POSE = f'{S}/models/rtmpose-m/20230831/rtmpose_onnx/rtmpose-m_simcc-body7_pt-body7_420e-256x192-e48f03d0_20230504/end2end.onnx'

def med_lab(lab, poly):
    m = np.zeros(lab.shape[:2], np.uint8)
    cv2.fillConvexPoly(m, np.round(poly).astype(np.int32), 1)
    px = lab[m > 0]
    if len(px) < 12: return np.zeros(3, np.float32), 0
    return np.median(px, 0).astype(np.float32) / 255.0, len(px)

def shrink(poly, k):
    c = poly.mean(0); return c + (poly - c) * k

def colours(img, kp, b):
    """Median Lab of the shirt (torso), the shorts (upper thighs) and the shoes; and which of them had pixels."""
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
            q = np.array([lh, rh, rh + 0.6 * (rk - rh), lh + 0.6 * (lk - lh)])
            w = max(4.0, 0.35 * np.linalg.norm(lh - lk))
            q = q + np.array([[-w / 2, 0], [w / 2, 0], [w / 2, 0], [-w / 2, 0]]) * (1 if lh[0] < rh[0] else -1) * (np.abs(lh[0] - rh[0]) < w)
            col[3:6], n = med_lab(lab, q); ok[1] = n >= 12
    if min(s[15], s[16]) > 0.3:
        r = max(3.0, 0.035 * (y1 - y0)); px = []
        for a in (la, ra):
            xa, ya = int(a[0]), int(a[1])
            px.append(lab[max(0, ya):max(0, ya) + int(2.2 * r) + 1, max(0, xa - int(1.5 * r)):xa + int(1.5 * r) + 1].reshape(-1, 3))
        px = np.concatenate(px)
        if len(px) >= 12: col[6:9] = np.median(px, 0) / 255.0; ok[2] = 1
    return col, ok

def weigh(c):
    f = np.array(c[..., :6], np.float32); f[..., [1, 2, 4, 5]] = (f[..., [1, 2, 4, 5]] - 0.5) * 1.5 + 0.5
    return f

class Finder:
    def __init__(self, model_json=None, det='yolox_s'):
        self.det = Yolox(f'{S}/models/{det}.onnx')
        self.pose = RTMPose(POSE, model_input_size=(192, 256), backend='onnxruntime', device='cpu')
        self.m = json.load(open(model_json)) if model_json else None
        if self.m:
            self.near_c = np.array(self.m['near_centres']); self.far_c = np.array(self.m['far_centres'])
            self.static = {tuple(c) for c in self.m.get('static_cells', [])}

    def poses(self, img, boxes):
        if not len(boxes): return np.zeros((0, 17, 3), np.float32)
        k, s = self.pose(img, bboxes=[list(b[:4]) for b in boxes])
        return np.concatenate([k, s[:, :, None]], 2).astype(np.float32)

    def near_pair_at(self, t):
        b = min(len(self.m['near_pair']) - 1, int(t // self.m['bin']))
        return self.m['near_pair'][b], self.m['sure'][b]

    def name(self, col, ok, zn, t):
        """-> (id, conf) from the colours, the end and the time."""
        if not ok[0]: return -1, 0.0
        cents = self.near_c if zn == 'near' else self.far_c
        npair, sure = self.near_pair_at(t)
        allowed = self.m['pairs'][npair if zn == 'near' else 1 - npair] if sure else (0, 1, 2, 3)
        f = weigh(col); dims = slice(0, 6) if ok[1] else slice(0, 3)
        d = np.array([np.linalg.norm(f[dims] - cents[k, dims]) if k in allowed else 9.0 for k in range(4)])
        o = np.argsort(d)
        return int(o[0]), float(1 - d[o[0]] / (d[o[1]] + 1e-9))

    def frame(self, img, t, min_score=0.45, far_score=0.45):
        """-> list of people on the court: {box, zone, kp, col, ok, id, conf}."""
        d = detect(self.det, img, TILES, 0.3)
        cand = []
        for b in d:
            zn = zone(b)
            if not zn: continue
            # a far player is small and behind the net: a weaker detection is still a player there
            if b[4] < (min_score if zn == 'near' else far_score): continue
            cell = (int((b[0] + b[2]) / 2 // 10), int(b[3] // 10), int((b[3] - b[1]) // 10))
            if self.m and cell in self.static: continue
            cand.append((b, zn))
        kps = self.poses(img, [c[0] for c in cand])
        out = []
        for (b, zn), kp in zip(cand, kps):
            if kp[:, 2].mean() < 0.4: continue
            col, ok = colours(img, kp, b)
            i, c = self.name(col, ok, zn, t) if self.m else (-1, 0.0)
            out.append({'box': b[:5].tolist(), 'zone': zn, 'kp': kp, 'col': col, 'ok': ok, 'id': i, 'conf': c})
        return out

def read_frames(path, t0, dur, fps=None, size=(1920, 1080), vf=None):
    """Frames of [t0, t0+dur) as BGR arrays, with their times. Rotation is applied by ffmpeg. vf: one more ffmpeg filter."""
    chain = ([f'fps={fps}'] if fps else []) + ([vf] if vf else [])
    vf = ['-vf', ','.join(chain)] if chain else []
    cmd = ['ffmpeg', '-v', 'error', '-nostdin', '-ss', f'{t0:.3f}', '-i', path, '-t', f'{dur:.3f}', '-map', '0:v:0', *vf, '-f', 'rawvideo', '-pix_fmt', 'bgr24', '-']
    p = subprocess.Popen(cmd, stdout=subprocess.PIPE)
    n = size[0] * size[1] * 3; i = 0; step = 1.0 / (fps or 30000 / 1001)
    while True:
        buf = p.stdout.read(n)
        if len(buf) < n: break
        yield t0 + i * step, np.frombuffer(buf, np.uint8).reshape(size[1], size[0], 3)
        i += 1
    p.stdout.close(); p.wait()
