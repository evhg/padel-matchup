"""Where a detected person stands, for a camera on the back glass of a padel court (1920x1080 picture).

Measured on this match's frames: the net tape is at y 497, the net's foot at y 568, the net posts at
x 510 and x 1404. The far half of the court is a trapezoid behind the net; the near half opens towards
the camera. A person whose feet are outside both is not a player (next court, bar, benches).

TODO for production: find these lines per video (the net and the white lines) instead of fixed numbers.
"""
NET_FOOT_Y = 570
FAR_TOP_Y = 500          # the far back glass meets the floor
FAR_L0, FAR_R0 = 735, 1180   # far corners at FAR_TOP_Y
POST_L, POST_R = 510, 1404   # net posts at NET_FOOT_Y
SIDE_SLOPE = 0.27        # the near side walls drop this much in y per pixel of x from the posts outwards

def zone(b, W=1920, H=1080):
    """b = [x0,y0,x1,y1,...] -> 'near', 'far' or None."""
    x0, y0, x1, y1 = b[:4]
    cx, h, fy = (x0 + x1) / 2, y1 - y0, y1
    if fy >= NET_FOOT_Y + 4 or h >= 175:
        # near half: inside the side walls (they leave the picture at about y 705)
        if fy < 705:
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
        exp = 75 + 75 * k
        if h < 0.6 * exp or h > 1.7 * exp: return None
        return 'far'
    return None
