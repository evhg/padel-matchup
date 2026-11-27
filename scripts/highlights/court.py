"""Where a detected person stands, for a camera on the back glass of a padel court (1920x1080 picture).

The numbers below were measured on the frames of the first match (a phone at 1x, low on the glass): the
net's foot at y 570, the net posts at x 510 and x 1404, the far glass on the floor at y 500. The far half
of the court is a trapezoid behind the net; the near half opens towards the camera. A person whose feet
are outside both is not a player (next court, bar, benches).

Another camera place has other numbers. Put them in match/court.json of the work folder (HL_HOME, or the
folder the pipeline runs in); a key that is not there keeps its value from this file.

court_find.py finds these numbers for each film from its frames (the net, the white lines, the side walls; README
"The court finder"). The job does not call it yet.
"""
import json, os

C = dict(
    NET_FOOT_Y=570,
    FAR_TOP_Y=500,           # the far back glass meets the floor
    FAR_L0=735, FAR_R0=1180,     # far corners at FAR_TOP_Y
    POST_L=510, POST_R=1404,     # net posts at NET_FOOT_Y
    SIDE_SLOPE=0.27,         # the near side walls drop this much in y per pixel of x from the posts outwards
    WALL_OUT_Y=705,          # the near side walls leave the picture at about this y
    FAR_H0=75, FAR_H1=150,   # a standing player's height in pixels at the far glass, and at the net
)
_f = os.path.join(os.environ.get('HL_HOME') or '.', 'match', 'court.json')
TILES = None                 # the detector's tiles for this camera place ("TILES" in court.json: [[x, y, w, h], ...])
if os.path.exists(_f):
    _j = json.load(open(_f)); C.update({k: v for k, v in _j.items() if k in C}); TILES = [tuple(t) for t in _j['TILES']] if _j.get('TILES') else None
NET_FOOT_Y, FAR_TOP_Y, FAR_L0, FAR_R0 = C['NET_FOOT_Y'], C['FAR_TOP_Y'], C['FAR_L0'], C['FAR_R0']
POST_L, POST_R, SIDE_SLOPE, WALL_OUT_Y, FAR_H0, FAR_H1 = C['POST_L'], C['POST_R'], C['SIDE_SLOPE'], C['WALL_OUT_Y'], C['FAR_H0'], C['FAR_H1']

def zone(b, W=1920, H=1080):
    """b = [x0,y0,x1,y1,...] -> 'near', 'far' or None."""
    x0, y0, x1, y1 = b[:4]
    cx, h, fy = (x0 + x1) / 2, y1 - y0, y1
    if fy >= NET_FOOT_Y + 4 or h >= 175:
        # near half: inside the side walls, until they leave the picture
        if fy < WALL_OUT_Y:
            left = POST_L - (fy - NET_FOOT_Y) / SIDE_SLOPE
            right = POST_R + (fy - NET_FOOT_Y) / SIDE_SLOPE
            if cx < left - 40 or cx > right + 40: return None
        return 'near' if h >= 120 else None
    if FAR_TOP_Y - 2 <= fy < NET_FOOT_Y + 4:
        k = (fy - FAR_TOP_Y) / (NET_FOOT_Y - FAR_TOP_Y)
        left = FAR_L0 + (POST_L - FAR_L0) * k
        right = FAR_R0 + (POST_R - FAR_R0) * k
        if cx < left - 30 or cx > right + 30: return None
        # a standing player's height follows the feet's place: about 75 px at the far glass, 150 at the net
        exp = FAR_H0 + (FAR_H1 - FAR_H0) * k
        if h < 0.6 * exp or h > 1.7 * exp: return None
        return 'far'
    return None
