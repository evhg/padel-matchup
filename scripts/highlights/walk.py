"""Every person on the court in a piece of a match, ten times a second, with no name and no filter.

usage: walk.py <video> <t0> <t1> <out.json> [pictures a second=10]
track.py follows the four players and names them, and it drops a sighting that it cannot name or that stands still.
That is right for a name tag and wrong for a distance: a player who waits at the far end is still on the court.
This file keeps every person whose place is on the court (court.zone) with the key points of the body. The names
come later, from track.py's file for the same piece: a sighting takes the name of the tracked player at that box,
and in a half of the court with one named player the other person is the partner.
Output: {"t0", "fps", "frames": [{"t", "people": [{"box", "zone", "score", "kp"}]}]}"""
import sys, os, json, numpy as np
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from people import Finder, read_frames

video, t0, t1, out = sys.argv[1], float(sys.argv[2]), float(sys.argv[3]), sys.argv[4]; fps = float(sys.argv[5]) if len(sys.argv) > 5 else 10.0
fd = Finder(None); frames = []
for t, img in read_frames(video, t0, t1 - t0, fps=fps):
    frames.append({'t': round(t, 3), 'people': [{'box': [round(float(x), 1) for x in p['box']], 'zone': p['zone'], 'score': round(float(p['box'][4]), 2),
                                                      'kp': np.round(p['kp'], 1).tolist()} for p in fd.frame(img, t)]})
json.dump({'t0': t0, 'fps': fps, 'frames': frames}, open(out, 'w'))
print('WALK_DONE', len(frames), 'pictures;', sum(len(f['people']) for f in frames), 'sightings')
