#!/bin/bash
# usage: track_all.sh <video> <ident_prefix> <plan.json> <workdir>
set -e
H="$(cd "$(dirname "$0")" && pwd)"
mkdir -p "$4"
python - "$3" <<'PY' > "$4/clips.txt"
import json, sys
for i, c in enumerate(json.load(open(sys.argv[1]))['clips']): print(f"t{c['t0']:.2f}-{c['t1']:.2f}", c['t0'], c['t1'])
PY
while read i t0 t1; do
  [ -f "$4/$i.json" ] || python -u "$H/track.py" "$1" "$2" "$t0" "$t1" "$4/$i.json" 2>&1 | tail -1
done < "$4/clips.txt"
echo TRACKS_DONE
