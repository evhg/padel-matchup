"""YOLOX person detector (Apache-2.0 weights from the official release), ONNX Runtime on CPU."""
import numpy as np, cv2, onnxruntime as ort

class Yolox:
    def __init__(self, path, size=(640, 640), threads=4):
        so = ort.SessionOptions(); so.intra_op_num_threads = threads
        self.s = ort.InferenceSession(path, so, providers=["CPUExecutionProvider"])
        self.inp = self.s.get_inputs()[0].name
        shape = self.s.get_inputs()[0].shape
        # The official exports have a fixed 640x640 input.
        self.h, self.w = (shape[2], shape[3]) if isinstance(shape[2], int) else size
        self.grids = None

    def _grid(self):
        if self.grids is None:
            gs, ss = [], []
            for st in (8, 16, 32):
                hs, ws = self.h // st, self.w // st
                xv, yv = np.meshgrid(np.arange(ws), np.arange(hs))
                gs.append(np.stack((xv, yv), 2).reshape(-1, 2)); ss.append(np.full((hs * ws, 1), st))
            self.grids = (np.concatenate(gs, 0), np.concatenate(ss, 0))
        return self.grids

    def raw(self, img):
        """img BGR -> array of [x0,y0,x1,y1,score] for persons, in img pixels."""
        r = min(self.h / img.shape[0], self.w / img.shape[1])
        nh, nw = int(img.shape[0] * r), int(img.shape[1] * r)
        pad = np.full((self.h, self.w, 3), 114, np.uint8)
        pad[:nh, :nw] = cv2.resize(img, (nw, nh), interpolation=cv2.INTER_LINEAR)
        x = pad.transpose(2, 0, 1)[None].astype(np.float32)
        o = self.s.run(None, {self.inp: x})[0][0]
        g, st = self._grid()
        xy = (o[:, :2] + g) * st; wh = np.exp(o[:, 2:4]) * st
        sc = o[:, 4] * o[:, 5]  # objectness * class 0 (person)
        keep = sc > 0.05
        xy, wh, sc = xy[keep], wh[keep], sc[keep]
        b = np.concatenate([xy - wh / 2, xy + wh / 2], 1) / r
        return np.concatenate([b, sc[:, None]], 1)

def nms(d, thr=0.5):
    if not len(d): return d
    d = d[np.argsort(-d[:, 4])]
    out = []
    while len(d):
        a = d[0]; out.append(a)
        if len(d) == 1: break
        r = d[1:]
        iw = np.clip(np.minimum(a[2], r[:, 2]) - np.maximum(a[0], r[:, 0]), 0, None)
        ih = np.clip(np.minimum(a[3], r[:, 3]) - np.maximum(a[1], r[:, 1]), 0, None)
        inter = iw * ih
        iou = inter / ((a[2] - a[0]) * (a[3] - a[1]) + (r[:, 2] - r[:, 0]) * (r[:, 3] - r[:, 1]) - inter + 1e-9)
        # also drop a box mostly inside a better one (tile duplicates of one person)
        inside = inter / ((r[:, 2] - r[:, 0]) * (r[:, 3] - r[:, 1]) + 1e-9)
        d = r[(iou < thr) & (inside < 0.8)]
    return np.array(out)

def detect(model, img, tiles=(), min_score=0.3):
    """Whole picture plus tiles (x, y, w, h in pixels). A tile's box that its inner edge cuts is dropped."""
    H, W = img.shape[:2]
    all_ = [model.raw(img)]
    for (x, y, w, h) in tiles:
        d = model.raw(img[y:y + h, x:x + w])
        if not len(d): continue
        d[:, [0, 2]] += x; d[:, [1, 3]] += y
        m = 4
        ok = ~(((x > 0) & (d[:, 0] < x + m)) | ((y > 0) & (d[:, 1] < y + m)) | ((x + w < W) & (d[:, 2] > x + w - m)) | ((y + h < H) & (d[:, 3] > y + h - m)))
        all_.append(d[ok])
    d = np.concatenate(all_, 0)
    d = d[d[:, 4] >= min_score]
    return nms(d)
