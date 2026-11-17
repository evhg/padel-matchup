#!/bin/bash
# The whole pipeline, with the wall time of every step in match/timings.tsv and its output in match/logs/.
# usage: HL_HOME=/path/to/work bash run_all.sh A|B
#   A: download (when DRIVE_ID is set), frames, sound, people, features, who is who, portraits, plan
#   B: follow the clips, the opening, both reels, the final files in $HL_HOME/out
# Between A and B a person (or the match page) gives the four groups their names in match/match.json:
# look at match/ident-near.jpg and match/ident-far.jpg.
H="$(cd "$(dirname "$0")" && pwd)"
cd "${HL_HOME:?set HL_HOME to the work folder}" || exit 1
T=match/timings.tsv; L=match/logs; mkdir -p match/kf "$L"
step() {
  local name="$1"; shift
  local s e r; s=$(date +%s.%N); echo ">>> $name $(date -u +%H:%M:%S)"
  if "$@" > "$L/$name.log" 2>&1; then r=ok; else r=FAILED; fi
  e=$(date +%s.%N); awk -v n="$name" -v s="$s" -v e="$e" -v r="$r" 'BEGIN{printf "%s\t%.1f\t%s\n", n, e-s, r}' >> "$T"
  if [ "$r" != ok ]; then echo "FAILED $name"; tail -8 "$L/$name.log"; echo RUN_FAILED; exit 1; fi
}
V=match/match.mov
if [ "$1" = A ]; then
  if [ -n "$DRIVE_ID" ]; then
    step download curl -sSL -C - -o $V "https://drive.usercontent.google.com/download?id=${DRIVE_ID}&export=download&confirm=t"
  fi
  step frames ffmpeg -v error -nostdin -skip_frame nokey -i $V -fps_mode passthrough -q:v 3 match/kf/%06d.jpg
  # the times come from the packets: "-skip_frame nokey -show_entries frame=pts_time" printed 73,612 lines for 5,258 pictures
  step frame_times bash -c "ffprobe -v error -select_streams v:0 -show_entries packet=pts_time,flags -of csv=p=0 $V | awk -F, '\$2 ~ /K/ {print \$1}' | sort -n > match/kf_times.txt && [ \$(ls match/kf | wc -l) = \$(wc -l < match/kf_times.txt) ]"
  step sound_extract ffmpeg -v error -nostdin -y -i $V -map 0:a:0 -ac 1 -ar 48000 -f f32le match/audio.raw
  step sound_rallies node "$H/audio.js" match/audio.raw match/audio.json
  step people python -u "$H/run_det.py" match/kf match/dets.jsonl
  step on_court python "$H/cands.py" match/dets.jsonl match/keep.json
  step pose_colours python -u "$H/feat2.py" match/kf match/dets.jsonl match/feat2.npz match/keep.json
  step look_whole python -u "$H/feat.py" match/kf match/dets.jsonl match/feat-dino.npz match/keep.json
  step shirt_print python -u "$H/feat3.py" match/kf match/feat2.npz match/feat3.npz
  step look_upper_far python -u "$H/feat4.py" match/kf match/feat2.npz match/feat4-far.npz far
  step look_upper_near python -u "$H/feat4.py" match/kf match/feat2.npz match/feat4-near.npz near
  step who_is_who python -u "$H/ident.py" match/feat2.npz match/feat-dino.npz match/kf_times.txt match/ident
  step far_end python -u "$H/farmodel.py" match/feat2.npz match/feat3.npz match/feat4-far.npz match/feat4-near.npz match/kf_times.txt match/ident
  step portraits python -u "$H/faces.py" match/kf match/feat2.npz match/ident.json match/faces.json
  step plan python "$H/plan.py" match/audio.json match/ident.json match/plan.json 6
  echo PHASE_A_DONE
elif [ "$1" = B ]; then
  # an HDR recording (most phones) is turned into normal video for everything that is drawn
  HDRK=$(ffprobe -v error -select_streams v:0 -show_entries stream=color_transfer -of csv=p=0 $V)
  case "$HDRK" in arib-std-b67|smpte2084) ;; *) HDRK= ;; esac
  step follow_clips bash "$H/track_all.sh" $V match/ident match/plan.json match/reel
  step shots bash "$H/rally_shots.sh" $V match/ident match/plan.json match/audio.json match/rally
  step opening_wide env HDR=$HDRK python "$H/versus.py" match/match.json match/faces.json match/kf match/versus-wide.mp4
  step opening_tall env HDR=$HDRK TALL=1 python "$H/versus.py" match/match.json match/faces.json match/kf match/versus-tall.mp4
  step reel_wide env VERSUS=match/versus TRACKS=match/reel SHOTS=match/rally python "$H/build.py" $V match/plan.json match/ident.json match/feat2.npz match/match.json match/reel match/reel.mp4
  step reel_tall env TALL=1 VERSUS=match/versus TRACKS=match/reel SHOTS=match/rally CACHE=match/reel/cache python "$H/build.py" $V match/plan.json match/ident.json match/feat2.npz match/match.json match/reel-tall match/reel-tall.mp4
  mkdir -p out; C="-colorspace bt709 -color_primaries bt709 -color_trc bt709"
  step final_wide ffmpeg -v error -nostdin -y -i match/reel.mp4 -c:v libx264 -preset slow -crf 22 -pix_fmt yuv420p $C -c:a aac -b:a 160k -movflags +faststart out/highlights-wide.mp4
  step final_tall ffmpeg -v error -nostdin -y -i match/reel-tall.mp4 -c:v libx264 -preset slow -crf 22 -pix_fmt yuv420p $C -c:a aac -b:a 160k -movflags +faststart out/highlights-vertical.mp4
  echo PHASE_B_DONE
else
  echo "usage: HL_HOME=/path/to/work bash run_all.sh A|B"; exit 2
fi
