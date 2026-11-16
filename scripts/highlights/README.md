# Match highlights from one video

These scripts made the first highlight reel (the match of 13 November 2026, 94 minutes, one phone on the
back glass). They run on a machine with the full video: Python 3.11, ffmpeg, four processors, no graphics
card. Nothing here is part of the app. Nothing here runs on Vercel.

The video of a match is personal data. Keep it on the machine that makes the reel. Do not commit a video,
a frame or a `match.json`.

## What it does

1. **Sound** finds the rallies. `audio.js` runs the sound core of `public/lab/rally-finder.html` on the
   sound track.
2. **One frame a second** of the whole match is the evidence for who is who. `run_det.py` finds people
   (YOLOX), `cands.py` keeps the people on the court, `feat2.py` reads the pose and the colours of the
   clothes, `feat.py`, `feat3.py` and `feat4.py` add what a person looks like.
3. **`ident.py`** makes exactly four players, two pairs, and the ends over time. **`farmodel.py`** learns
   the far end by itself (see the lessons).
4. **`plan.py`** selects the points: the best by sound, the longest rally, the same number for each pair
   at the camera end.
5. **`track.py`** follows the players through each selected clip and gives a name to each from all the
   sightings together. **`shots.py`** finds whose hand moved at a shot.
6. **`build.py`** writes the segments and **`render.py`** draws them (`gfx.py`): intro card, one card for
   each player, name tags, a shot counter, the long rally at six times the speed, one slow replay for each
   player, the numbers of the match. `TALL=1` makes the vertical reel.

`peek.py`, `dbg.py` and `dbgfar.py` put frames on one sheet. Use them: see the last lesson.

## Run it

`HL_HOME` is a work folder with `models/` (the three ONNX models), `fonts/` (Barlow Condensed) and
`match/`. The models are YOLOX-s (release 0.1.1rc0 of the YOLOX project), RTMPose-m body7 (through the
`rtmlib` package) and DINOv2-small as ONNX. All three have the Apache 2.0 licence. The Python packages
are numpy, opencv-python-headless, onnxruntime, scikit-learn, pillow, scipy and rtmlib.

```bash
export HL_HOME=/path/to/work; cd $HL_HOME; H=/path/to/repo/scripts/highlights
ffmpeg -skip_frame nokey -i match/match.mov -fps_mode passthrough -q:v 3 match/kf/%06d.jpg
ffprobe -v error -select_streams v:0 -skip_frame nokey -show_entries frame=pts_time -of csv=p=0 match/match.mov > match/kf_times.txt
ffmpeg -i match/match.mov -vn -ac 1 -ar 48000 -f f32le match/audio.raw
node $H/audio.js match/audio.raw match/audio.json
python $H/run_det.py match/kf match/dets.jsonl && python $H/cands.py match/dets.jsonl match/keep.json
python $H/feat2.py match/kf match/dets.jsonl match/feat2.npz match/keep.json
python $H/feat.py match/kf match/dets.jsonl match/feat-dino.npz match/keep.json
python $H/feat3.py match/kf match/feat2.npz match/feat3.npz
python $H/feat4.py match/kf match/feat2.npz match/feat4-far.npz far
python $H/feat4.py match/kf match/feat2.npz match/feat4-near.npz near
python $H/ident.py match/feat2.npz match/feat-dino.npz match/kf_times.txt match/ident
python $H/farmodel.py match/feat2.npz match/feat3.npz match/feat4-far.npz match/feat4-near.npz match/kf_times.txt match/ident
python $H/plan.py match/audio.json match/ident.json match/plan.json 6
bash $H/track_all.sh match/match.mov match/ident match/plan.json match/reel
python $H/build.py match/match.mov match/plan.json match/ident.json match/feat2.npz match/match.json match/reel match/reel.mp4
TALL=1 TRACKS=match/reel python $H/build.py match/match.mov match/plan.json match/ident.json match/feat2.npz match/match.json match/reel-tall match/reel-tall.mp4
```

`match.json` has the venue, the date, the score, the four names and the two pairs. Look at the two contact
sheets of `ident.py` to give each of the four groups its name. In the app, the match page knows the names.

Measured on four processors: people in 5,258 frames 38 minutes, the two upper-body passes 6 minutes each,
`ident.py` 13 seconds, one 15-second clip 80 seconds to follow, one reel 90 seconds to draw.

## What is not done

- `court.py` has the lines of this one court and this one camera position as numbers. Another video needs
  them found from the picture.
- The end of a rally comes from sound. The shot counter can be one or two shots wrong.
- No music, and no "funny moments" part: the laugh measure found nothing strong in this match.

## What this already cost to learn

- **Name people from the whole match, never from one clip.** In one clip two or three players are in
  view. Five versions of the lab page failed on that.
- **Two people in one frame are never one person, and partners share an end.** These two rules do more
  than any model.
- **The clothes of the camera end do not hold at the far end.** There the players are small, seen from the
  front, in the shade behind net and glass. A black shirt with a white print read lighter than a plain
  slate one, and every colour rule swapped the two partners with full confidence. `farmodel.py` splits the
  far pair without labels (the upper body only, so the split is not "left and right"), then answers one
  question for each pair with two independent voices. Both must agree.
- **A sound is not always a shot.** One "shot" was a high five, two were a ball picked up, and a
  "55-shot rally" was serve practice between two sets. `plan.py` and `build.py` have a rule for each.
- **A tracklet lives on detections, not on the pose.** A pose model follows whoever is biggest in the box:
  one tracklet moved from a far player to the near player who walked in front.
- **No name is better than a wrong name.** A tag shows only where the whole clip is sure.
- **Look at the frames.** Every fault above was found on a sheet of frames, after the numbers looked good
  (99% on held-out seeds while the far names were close to random).
