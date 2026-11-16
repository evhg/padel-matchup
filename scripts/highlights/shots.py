"""Who hit a shot: the player whose wrist moved fastest around the sound of the hit, measured against the player's own body."""
import numpy as np
FPS = 30000 / 1001

def wrist_speed(p):
    """-> list of (frame, speed in body heights a second) for one player's track."""
    out = []
    for i in range(1, len(p['f'])):
        df = p['f'][i] - p['f'][i - 1]
        if df <= 0 or df > 6: continue
        a, b = np.array(p['kp'][i - 1]), np.array(p['kp'][i])
        ha, hb = a[[11, 12], :2].mean(0), b[[11, 12], :2].mean(0)
        h = max(20.0, p['box'][i][3] - p['box'][i][1])
        v = 0.0
        for w in (9, 10):
            if a[w, 2] > 0.3 and b[w, 2] > 0.3:
                v = max(v, float(np.linalg.norm((b[w, :2] - hb) - (a[w, :2] - ha)) / h / (df / FPS)))
        out.append(((p['f'][i] + p['f'][i - 1]) / 2, v))
    return out

def arm_up(p, f):
    """A wrist clearly above the shoulders near frame f: an overhead (a smash, a bandeja)."""
    i = int(np.argmin([abs(x - f) for x in p['f']]))
    if abs(p['f'][i] - f) > 5: return False
    k = np.array(p['kp'][i]); h = p['box'][i][3] - p['box'][i][1]
    sh = min(k[5, 1], k[6, 1])
    return any(k[w, 2] > 0.3 and k[w, 1] < sh - 0.12 * h for w in (9, 10))

def hitter(tr, th):
    """-> {'id', 'peak', 'margin', 'overhead'} or None. th is the absolute time of the hit."""
    f = (th - tr['t0']) * FPS
    best = []
    for k, p in tr['players'].items():
        sp = [v for (g, v) in wrist_speed(p) if f - 9 <= g <= f + 4]
        if sp: best.append((max(sp), int(k)))
    if not best: return None
    best.sort(reverse=True)
    peak, k = best[0]; second = best[1][0] if len(best) > 1 else 0.0
    oh = any(arm_up(tr['players'][str(k)], f + d) for d in (-6, -3, 0))
    return {'id': k, 'peak': round(peak, 2), 'margin': round(peak / (second + 1e-6), 2), 'overhead': bool(oh)}

def together(tr, th, k, pairs):
    """The player's fast hand is at the partner's hand at that moment: a high five, not a shot."""
    f = (th - tr['t0']) * FPS; mate = next((b if a == k else a) for a, b in pairs if k in (a, b))
    if str(mate) not in tr['players'] or str(k) not in tr['players']: return False
    out = []
    for who in (k, mate):
        p = tr['players'][str(who)]; i = int(np.argmin([abs(x - f) for x in p['f']]))
        if abs(p['f'][i] - f) > 6: return False
        out.append((np.array(p['kp'][i]), p['box'][i][3] - p['box'][i][1]))
    (a, ha), (b, hb) = out
    d = min(np.linalg.norm(a[i, :2] - b[j, :2]) for i in (9, 10) for j in (9, 10))
    return bool(d < 0.35 * max(ha, hb))
