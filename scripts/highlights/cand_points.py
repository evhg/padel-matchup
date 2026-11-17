"""The best points of the match as candidates, with a sheet of frames of each end, so a person can say who won.
usage: cand_points.py <video> <audio.json> <ident.json> <out_dir> [count=18]"""
import sys, os, json, subprocess, numpy as np, cv2
video, audio, ident, outd = sys.argv[1:5]; N = int(sys.argv[5]) if len(sys.argv) > 5 else 18
A = json.load(open(audio)); M = json.load(open(ident)); BIN = M['bin']; near_pair = M['near_pair']; sure = M['sure']; os.makedirs(outd, exist_ok=True)
def bin_of(t): return min(len(near_pair) - 1, int(t // BIN))
byf = {}
for s in M['sightings']: byf[s['t']] = byf.get(s['t'], 0) + 1
ft = np.array(sorted(byf)); fn = np.array([byf[t] for t in ft])
def crowd(p):
    m = (ft >= p['start'] - 1) & (ft <= p['end'] + 1)
    return float((fn[m] >= 3).mean()) if m.any() else 0.0
start_bin = next((b for b in range(len(sure) - 3) if all(sure[b:b + 3])), 0)
def rally_end(p):
    h = p['hitTimes']
    for k in range(len(h) - 1, max(len(h) - 4, 0), -1):
        if h[k] - h[k - 1] >= 2.9: return h[k - 1]
    return h[-1]
def worth(p): return p['score'] + (8 if p['reactionDb'] >= 3.5 else 0) + (4 if p['burst']['n'] >= 4 else 0)
pts = [p for p in A['points'] if p['start'] >= start_bin * BIN and p['end'] <= A['seconds'] - 15 and crowd(p) >= 0.3 and sure[bin_of(p['lastHit'])] and p['hits'] >= 6]
pts.sort(key=lambda p: -worth(p)); pts = sorted(pts[:N], key=lambda p: p['lastHit']); out = []
for i, p in enumerate(pts):
    e = rally_end(p); tiles = []
    for dt in (-1.0, 0.3, 1.5, 2.7, 4.0, 5.5):
        raw = subprocess.run(['ffmpeg', '-v', 'error', '-nostdin', '-ss', f'{e + dt:.2f}', '-i', video, '-frames:v', '1', '-vf', 'scale=960:540', '-f', 'rawvideo', '-pix_fmt', 'bgr24', '-'], capture_output=True).stdout
        im = np.frombuffer(raw, np.uint8).reshape(540, 960, 3).copy(); cv2.putText(im, f'{dt:+.1f}s', (12, 34), cv2.FONT_HERSHEY_SIMPLEX, 1.0, (255, 255, 255), 2); tiles.append(im)
    cv2.imwrite(f'{outd}/p{i:02d}.jpg', np.vstack([np.hstack(tiles[:3]), np.hstack(tiles[3:])]), [cv2.IMWRITE_JPEG_QUALITY, 85])
    out.append({'i': i, 'firstHit': p['firstHit'], 'end': e, 'lastHit': p['lastHit'], 'hits': p['hits'], 'worth': worth(p), 'near': near_pair[bin_of(p['lastHit'])]})
    print(f"p{i:02d}  {int(e // 60)}:{e % 60:04.1f}  hits {p['hits']:2d}  worth {worth(p):5.1f}  near pair {out[-1]['near']}")
json.dump(out, open(f'{outd}/cands.json', 'w'), indent=1)
