# Match highlights from one video

These scripts made the first two highlight reels (the match of 13 November 2026, 94 minutes, one phone on
the back glass). They run on a machine with the full video: Python 3.11, ffmpeg, four processors, no graphics
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
6. **`faces.py`** finds the largest sharp front faces of each player. **`versus.py`** makes the opening
   from them: the two teams, "VS", the score, "GAME ON", with sound made from numbers and an offline voice.
7. **`build.py`** writes the segments and **`render.py`** draws them (`gfx.py`): the opening, name tags, a
   shot counter, the long rally at six times the speed, one slow replay for each player, the numbers of the
   match. `TALL=1` makes the vertical reel.
8. A slow replay gets more detail and more frames: **`sr.py`** (an upscale model) at half strength, never
   on a head, and the `minterpolate` filter of ffmpeg for the frames in between.
9. **`hdr.py`** turns an HDR recording (most phones) into normal video before anything is drawn.
10. **`rally_shots.sh`** checks the shots of each selected rally: **`ball.py`** finds small yellow things that
    move, **`balllink.py`** joins them into flights, **`shotseq.py`** labels each sound (a shot of the near
    pair, of the far pair, or something else) from the ball, the arms and the turn of the two pairs.
    `build.py` with `SHOTS=<folder>` ends each clip after the last shot and counts only shots.

`hear.py` and `hear_calls.py` are the ears: speech recognition (faster-whisper) on a file or on the seconds
before each point. `serve_probe.py` is a first test of who serves. `balldbg.py` and `ballstrip.py` draw what
the ball finder saw.

`peek.py`, `dbg.py` and `dbgfar.py` put frames on one sheet. Use them: see the last lesson.

## Run it

`HL_HOME` is a work folder with `models/`, `fonts/` (Barlow Condensed) and `match/` (the video is
`match/match.mov`). The models are YOLOX-s (release 0.1.1rc0 of the YOLOX project), RTMPose-m body7
(through the `rtmlib` package) and DINOv2-small as ONNX. All three have the Apache 2.0 licence. The second
reel added `realesr-general-x4v3.pth` (Real-ESRGAN, BSD), `yunet.onnx` (the OpenCV face detector, MIT) and
`u2net_human_seg` (through the `rembg` package). The Python packages are numpy, opencv-python-headless,
onnxruntime, scikit-learn, pillow, scipy, rtmlib, torch (processor build), rembg, piper-tts, kokoro-onnx,
soundfile and faster-whisper.

The voice is Kokoro (`models/kokoro/kokoro-v1.0.onnx` and `voices-v1.0.bin`, Apache 2.0: commercial use
is permitted), 54 voices, `VOICE_NAME` selects one. Without those files `versus.py` uses the piper test
voice (`models/voice/en_US-ryan-high.onnx`; its data has a non-commercial licence, so not for the public).
Without both, the opening has no speech.

```bash
export HL_HOME=/path/to/work; H=/path/to/repo/scripts/highlights
bash $H/run_all.sh A      # frames, sound, people, who is who, portraits, plan
# look at match/ident-near.jpg and match/ident-far.jpg, then write match/match.json
bash $H/run_all.sh B      # follow the clips, the opening, both reels, the files in out/
```

`run_all.sh` has each command, and writes the wall time of each step to `match/timings.tsv`.

`match.json` has the venue, the date, the score, the four names, the two pairs and, when the players have
them, `team_a` and `team_b`. Look at the two contact sheets of `ident.py` to give each of the four groups
its name. In the app, the match page knows the names.

## How long it takes

One run with a clock on every step (16 November 2026, four processors, no graphics card, a 94-minute video
of 7.4 GB at 1080p and 30 frames a second, a reel of 2 minutes 21 seconds):

| Step | Seconds |
| --- | ---: |
| Download from Google Drive | 319 |
| One frame a second (5,258 pictures) and their times | 514 |
| Sound: extract, find the rallies | 36 |
| Find people in each picture | 2,159 |
| Pose and colours | 337 |
| What a person looks like (four passes) | 1,187 |
| Who is who, the far end, portraits, plan | 36 |
| Follow the players through six clips | 629 |
| The opening, both layouts | 62 |
| The wide reel (four slow replays: about 48 minutes of it) | 3,133 |
| The vertical reel (replays from the cache) | 116 |
| The two final files | 226 |
| **All** | **8,755** (2 hours 26 minutes) |

Two steps are 60% of the time: people in each picture, and the upscale of the four slow replays.

## What is not done

- `court.py` has the lines of this one court and this one camera position as numbers. Another video needs
  them found from the picture.
- The shot counter is an estimate. With `SHOTS` it counts the sounds that the labeller calls shots; no
  rally has a count that a person made to compare with. A video at 60 frames a second is the next test.
- The score is not found. `serve_probe.py` gives a serving team for most points, not yet the games.
- The picture is not 4K and the slow motion is not true 60 frames a second. An upscale of a whole frame is
  28 seconds here, and a frame in between is a guess: a racket at full speed stays a blur.
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
- **The upscale model damages faces.** It made eyes into dark smears. A portrait is real pixels from the
  largest sharp face of the match, and a replay keeps every head out of the upscaled picture.
- **Stereo and wrist speed do not tell which court a shot comes from.** The players of this court already
  fill the full range of level and time difference between the two channels. The wrists of the near players
  move as fast between two sounds (median 1.36) as at a sound (median 1.31).
- **A far player behind a near player gets no tag.** The tag sat on the back of the near player and read as
  a second name for that player.
- **Read the times of the frames from the packets.** `-skip_frame nokey` with `-show_entries frame` printed
  73,612 lines for 5,258 pictures. `run_all.sh` counts the two and stops when they differ.
- **Ask what the video is before reading a pixel.** The phone recorded HDR (10 bits, HLG, wide colours).
  Read as normal video it is grey and flat, and two reels went out like that. The owner asked "is some
  colour adjustment needed?" before anybody ran `ffprobe`. `hdr.py` converts; `build.py` asks each time.
- **A rally of a minute does not fit in memory as frames.** The first ball finder held every frame and the
  kernel killed it at 11 GB. It holds nine frames now, with the same result.
- **The ball is clear when it is slow and invisible after a hard hit**, at 30 frames a second. So a shot is
  not "two flights meet": it is a flight that ends or starts at a player, an arm that moves, and the turn of
  the pairs, in one pass over the whole row of sounds. A racket that swings is also yellow enough to count as
  "the ball at the racket". That helps, but it is not proof of a hit.
- **A phone on the back glass does not hear a score call.** In the ten seconds before each of 98 points the
  recogniser returned nothing or its own filler ("Thank you for watching"). Speech needs a microphone near
  the players.
- **Let a recogniser judge a voice when no person can listen.** It wrote "Jarek" and "Tikalai" for the team
  names, and "Barzoo" for "versus" with the deepest voice behind the effects. That voice was dropped.
- **Look at the frames.** Every fault above was found on a sheet of frames, after the numbers looked good
  (99% on held-out seeds while the far names were close to random).
