"""Where a player stands on the court, in metres, from the key points of the body in the picture.
The floor map H is fitted on five measured points of one camera position (match/court-H.json in the work folder:
the net at the centre line and at both walls, and the two service lines at the centre line). X: 0..10 across, Y: 0 at the
near back wall, 10 at the net, 20 at the far back wall. A foot that is in the picture is put through H. A foot that is
not (a player close to the camera) is found from the hips: the camera is HCAM above the floor, a hip is ZHIP above it."""
import json, os, numpy as np
S = os.environ.get('HL_HOME') or os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
H = np.array(json.load(open(f'{S}/match/court-H.json'))['H']); HI = np.linalg.inv(H)      # court (m) -> picture (px), from cv2.findHomography
Y0, HCAM = 258.0, 2.32       # the row of the horizon in the picture, the height of the camera (m): from the same five points
def floor(u, v):
    w = HI @ np.array([u, v, 1.0]); return float(w[0] / w[2]), float(w[1] / w[2])
def from_height(u, v, z):
    """A point of the body that is z metres above the floor -> its place on the floor."""
    return floor(u, Y0 + (v - Y0) * HCAM / (HCAM - z))
def place(kp, zhip=0.68, zsh=1.22):
    """kp: 17 COCO points [x, y, confidence]. -> (X, Y, how) or None."""
    kp = np.array(kp); an = kp[[15, 16]]; hp = kp[[11, 12]]; sh = kp[[5, 6]]
    if an[:, 2].min() > 0.5 and an[:, 1].max() < 1060: return (*floor(an[:, 0].mean(), an[:, 1].mean()), 'feet')
    if hp[:, 2].min() > 0.5 and hp[:, 1].max() < 1070: return (*from_height(hp[:, 0].mean(), hp[:, 1].mean(), zhip), 'hips')
    if sh[:, 2].min() > 0.5: return (*from_height(sh[:, 0].mean(), sh[:, 1].mean(), zsh), 'shoulders')
    return None
