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
    move, **`balllink.py`** joins them into flights, **`shotseq.py`** says of each sound what is sure: a
    shot of a pair (the ball at a racket with a moving arm), not of this ball (the ball flies on through
    that moment), or unknown. It also lists the periods with no ball in flight. `build.py` with
    `SHOTS=<folder>` ends a rally where the ball stops flying near the end of its sounds, leaves the sounds
    that are not of this ball out of the counter, and takes replays only from sure shots.

`serve.py` finds the serving pair, the server and the side of each point. `score_decode.py` is the rules
engine: the most probable score history for weak guesses of who won each point, and a simulation of how much
the rules repair.
`cand_points.py` lists the best points and makes a sheet of frames of each end, for a person to say who won.
`label_page.py` makes one page from those clips: a tap for the pair that won each point, and one line to copy.
`hear_voice.py` finds where people speak; `hear_calls2.py` and `scribe.py` (a paid service) listen for scores.
`hear.py` and `hear_calls.py` are the ears: speech recognition (faster-whisper) on a file or on the seconds
before each point. `balldbg.py` and `ballstrip.py` draw what
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
`VOICE_DIR` and `VOICE_PREFIX` give `versus.py` four lines made before by another voice service.

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
- The shot counter is an estimate. With `SHOTS` it leaves out the sounds that are proven not to be shots
  of this ball; a bounce can still count. No rally has a count that a person made to compare with. A video
  at 60 frames a second is the next test.
- The score is not found. Nothing here says who won a point. `serve.py` gives the serving pair for the
  points served from the camera end; `score_decode.py` is ready for a detector that does not exist yet.
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
  not "two flights meet": it is a flight that ends or starts at a player with an arm that moves. A racket
  that swings is also yellow enough to count as "the ball at the racket": that helps, but it is not proof.
- **Weak clues do not decide a whole rally.** Two labellers let one pass over all the sounds decide every
  label (the turn of the pairs, the time between shots). They cut rallies of 31 and 33 sounds to five and
  three shots, and joined the sounds after one point to its rally. The summary of all six rallies showed it;
  the one rally that was looked at in detail had looked right. The labeller now says only what is sure, and
  the end of a rally comes from one strong clue: the ball stops flying.
- **A replay needs the whole player in the picture.** One showed an arm at the edge and a name tag.
- **Equal ends is not equal winners.** The reel gave each pair three points at the camera end, and every
  point in it was won by the same pair. A player of the other pair said so at once. The pipeline does not
  know who won a point, and six still frames of a rally's end do not show it to a careful reader. Until
  that is solved, `cand_points.py` lists the best points with a sheet of each end, and a person says who won.
- **The rules of padel do not repair a weak detector. Measure before you promise.** I told the owner that
  the rules could teach the machine who won each point. `score_decode.py simulate2` then showed it: with
  the game limits, the rules and the typed final score, a detector that is right for 80% of the points gives
  a correct score on screen 62% of the time, 90% gives 81%, 95% gives 90%, and 98% gives 96%. So the score
  needs a detector that sees the end of almost every point, and matches with known winners to measure it.
- **A serve is where a point starts, and the camera end shows it.** `serve.py` reads the formation before
  the first sound of a point from one picture a second: 140 points, 124 of them served from the camera end.
  The far end needs poses at the full frame rate. Loudness does not tell the two ends apart: the phone evens
  out the level.
- **A recogniser with a hint invents what the hint says.** With a hint of score words, the strong recogniser
  wrote "Four three. Four four" over the noise of the warm-up. `hear_calls2.py` counts a call only when the
  pass without a hint agrees. `hear_voice.py` looks for speech in the whole match first: it found the set-up
  at the phone and "Game is over" at the end, and nothing from the court. A phone behind the back glass does
  not record the score calls in a usable way.
- **Check that an instruction fits the place before you give it.** The owner was told "1x lens, it is
  sharper". From the back wall the 1x lens sees the full width of the court only from 7 metres; the 0.5x
  lens from 3.6 metres. The far half of the court is 70 pixels high from 1.3 metres; from 3 metres about 2.2
  times that, from 4 metres about 2.8 times (calculated, not yet filmed).
- **A person labels fast when the page asks one thing.** `label_page.py` makes one file with a clip for each
  point and two buttons, and gives the answers as one line of text. It needs no account and no network.
- **Fast forward is not a highlight.** The long rally at six times the speed was "not fun to watch". It is
  off (`FAST=1` turns it on); the rally shows its last seconds at the true speed.
- **A phone on the back glass does not hear a score call.** In the ten seconds before each of 98 points the
  recogniser returned nothing or its own filler ("Thank you for watching"). Speech needs a microphone near
  the players.
- **Let a recogniser judge a voice when no person can listen.** It wrote "Jarek" and "Tikalai" for the team
  names, and "Barzoo" for "versus" with the deepest voice behind the effects. That voice was dropped.
- **Look at the frames.** Every fault above was found on a sheet of frames, after the numbers looked good
  (99% on held-out seeds while the far names were close to random).
