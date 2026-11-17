#!/bin/bash
# The shots of each selected point, over the whole rally: follow the players, find the ball, label the sounds.
# usage: rally_shots.sh <video> <ident_prefix> <plan.json> <audio.json> <workdir>
H="$(cd "$(dirname "$0")" && pwd)"; mkdir -p "$5"
python - "$3" "$4" > "$5/ranges.txt" <<'P'
import sys, json
P = json.load(open(sys.argv[1])); A = json.load(open(sys.argv[2]))
for c in P['clips']:
    p = min(A['points'], key=lambda q: abs(q['lastHit'] - c['hitTimes'][-1]) if q['firstHit'] <= c['lastHit'] <= q['lastHit'] + 1 else 1e9)
    print(f"{max(0, p['firstHit'] - 1.5):.2f} {min(p['lastHit'] + 5.5, c['t1'] + 3):.2f}")
P
while read r0 r1; do
  n="$5/r$r0-$r1"
  [ -f "$n.json" ] || python -u "$H/track.py" "$1" "$2" "$r0" "$r1" "$n.json" 2>&1 | tail -1
  [ -f "$n-cand.npz" ] || python "$H/ball.py" "$1" "$r0" "$r1" "$n-cand.npz"
  python "$H/balllink.py" "$n-cand.npz" "$n-ball.npz" | head -1
  python "$H/shotseq.py" "$n.json" "$n-ball.npz" "$4" "$n-shots.json" | tail -1
done < "$5/ranges.txt"
echo RALLY_SHOTS_DONE
