"""Upscale a picture four times with Real-ESRGAN's small general model (BSD licence), on the processor.
It sharpens edges and textures that are in the picture. It does not know faces and does not invent one."""
import os, time, numpy as np, torch, torch.nn as nn, torch.nn.functional as F
S = os.environ.get('HL_HOME') or os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
class Compact(nn.Module):
    def __init__(self, nf=64, nconv=32, up=4):
        super().__init__(); self.up = up
        body = [nn.Conv2d(3, nf, 3, 1, 1), nn.PReLU(nf)]
        for _ in range(nconv): body += [nn.Conv2d(nf, nf, 3, 1, 1), nn.PReLU(nf)]
        body += [nn.Conv2d(nf, 3 * up * up, 3, 1, 1)]
        self.body = nn.ModuleList(body); self.ps = nn.PixelShuffle(up)
    def forward(self, x):
        o = x
        for m in self.body: o = m(o)
        return self.ps(o) + F.interpolate(x, scale_factor=self.up, mode='nearest')
_net = None
def net():
    global _net
    if _net is None:
        _net = Compact(); sd = torch.load(f'{S}/models/realesr-general-x4v3.pth', map_location='cpu'); _net.load_state_dict(sd.get('params', sd)); _net.eval()
    return _net
@torch.no_grad()
def up4(bgr):
    """BGR uint8 picture -> the same picture four times as large."""
    x = torch.from_numpy(np.ascontiguousarray(bgr[:, :, ::-1])).float().div(255).permute(2, 0, 1)[None]
    y = net()(x).clamp(0, 1)[0].permute(1, 2, 0).mul(255).round().byte().numpy()
    return np.ascontiguousarray(y[:, :, ::-1])
