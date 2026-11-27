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
   at the camera end. With `WINNERS=<winners.json>` it gives each pair the same number of points that the
   pair WON, and `build.py` names the winner after the last shot of each clip.
5. **`track.py`** follows the players through each selected clip and gives a name to each from all the
   sightings together. **`shots.py`** finds whose hand moved at a shot.
6. **`faces.py`** finds the largest sharp front faces of each player (for the names). **`portrait.py`** (the
   fast reel) chooses the portrait of each player for the opening: a flattering face, see "The portrait".
   **`versus.py`** makes the opening from them: the two teams, "VS", the score, "GAME ON", with sound made
   from numbers and an offline voice.
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
the rules repair. `score_log.py` turns a log of every point into the score before and after each point and
checks it against the rules and the final score; `scorebox.py` draws that score on a finished reel.
`stats.py` gives the numbers of a count (games in a row, breaks, games at 40-40, points won on serve) and the winners
that the count forces; `honest.py` says, tier by tier, what a reel may claim (sets, games, a point score, a winner
line). `winner.py` guesses the winner of each point with no person. `python3 test_stats.py` and
`python3 test_winner.py` are their checks (plain asserts; the gate does not run Python).
`reel_points.py` builds a reel from points that are already described (serve, dead moment, winner, reaction,
replay, heard words, a measured number over a head); `review.py` makes a line-call review; `cheers.py` adds the
sound of an audience.
`cand_points.py` lists the best points and makes a sheet of frames of each end, for a person to say who won.
`label_page.py` makes one page from those clips: a tap for the pair that won each point, and one line to copy.
`winners.py` turns that line into `winners.json` for `plan.py`.
`hear_voice.py` finds where people speak; `hear_calls2.py` and `scribe.py` (a paid service) listen for scores.
`hear.py` and `hear_calls.py` are the ears: speech recognition (faster-whisper) on a file or on the seconds
before each point. `balldbg.py` and `ballstrip.py` draw what
the ball finder saw.

Two small recorders on the fence of the court (one in each half) give clean sound. `tx_first.py` lines the two
recordings up and measures their levels; `tx_tdoa.py` says for each sharp sound which recorder heard it first;
`tx_listen.py` writes down the speech; `tx_compare.py` and `tx_score.py` compare ways to do that;
`speech_check_page.py` makes a page where a person says if the text is right.

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

What a second match added, each as its own tool until `run_all.sh` takes it in:

- `match/court.json`: the court lines of this camera place (see `court.py`). Draw them on two frames first.
- `tx_first.py`, `tx_phone.py`, `tx_mix.py`: two recorders on the fence, lined up with the phone, mixed into one
  sound track. Put that track into the working copy and the reel has the hits and the voices.
- `GRADE=glass` for a camera behind the glass; `CUTOUT=birefnet-general-lite` for clean portraits; `SAYS=<file>`
  for what a player said; `START=<seconds>` when a person knows the start of the match.
- `gallery.py`: the names of the four players from face templates of players who agreed, so nobody is asked
  "who is who" unless two or more of the four are new. The gallery is a file of the work folder.
- `label_clips.py`, `label_page.py`, `context_page.py`: clips and a page for the people who build the
  detector. Never for a player: the score is automatic.

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

## The fast reel, with no person (`modal/fastreel.py`)

A player's fast-reel clips arrive on the store; `assemble` in `modal/serve.py` joins them and tells Kicksmash, and
Kicksmash's answer carries the start request (the matches, their players and team names, the score, the track).
`make` then runs on Modal machines only, and reports each step to Kicksmash (`/api/admin/match-reel`):

| Step | What runs | Machines | Seconds (24 November 2026, 195 s of clips) |
| --- | --- | --- | ---: |
| clips | `fast_reel.py`'s detector; ten pieces of the clean file, each decoded from the start | 1 + 10, 8 processors | 332 |
| players | `run_det.py` (4 at once), `cands.py`, `feat2.py`, `feat.py`, `who.py` | 1, 16 processors | 147 (377 on a cold machine) |
| follow | `track.py`, one machine for each clip; beside it `portrait.py` (about 35 s), then the four openings (`versus.py`) | 8 + 1 + 4 | 322 |
| replays, opening | `fast_points.py`, `reel_points.py ... plan`, then `render.py` for each of 30 parts | 30, 8 processors | 140 |
| music, finish | `reel_points.py`, `cheers.py`, the level, `music.py`, 1080p; both layouts at once | 2 | 169 |
| **All** | | | **1,117** (19 minutes; the first run, with cold machines: 1,391) |

The machines of one run held about 34,000 processor-seconds and 57,000 GiB-seconds: about $0.45 and $0.13 at Modal's
list prices ($0.0000131 a processor-second, $0.00000222 a GiB-second), so under $1 for a fast reel with the starts of
the machines. No step needs a graphics card: the slowest ones are the HDR curve and the follower, and both split.

Run it as a test (it writes under the request's `out` folder and prints each progress line instead of posting it):

```bash
FASTREEL_SECRET= modal run scripts/highlights/modal/fastreel.py --request req.json --dry
```

What it needs on the store: `assets/models/` (yolox_s, rtmpose-m, dinov2_small, yunet, sface, kokoro,
`u2net/birefnet-general-lite`), `assets/fonts/`, `assets/cheers/`, `assets/endcard/feedback.png`, the tracks
`assets/kicksmash-music-*.m4a`, `gallery/faces.json` (the face templates, gallery.py) and `courts/<place>.json` (the
court lines of the camera place, court.py). The player's choices are `uploads/<token>/choices.json`. Never in the
repository: a video, a frame, a face picture, a gallery, a court file of a real place, a `match.json`.

When `who.py` is not sure who is who, the job stops at "players" with `"waiting": "names"` in its progress, and writes
`names.json` and `face-<track>.jpg` to `reels/<upload token>/`. The players answer with `POST /u/<upload token>/names`
on the reel host (`serve.py`), and `resume` goes on from the step "players".

### The public version: `share.mp4` (26 November 2026)

Each fast reel has three films in `reels/<token>/`: `tall.mp4` and `wide.mp4` for the match page, and `share.mp4`
for TikTok and the @kicksma.sh Instagram account. `reel.json` says `"share": true` when `share.mp4` is there; a
reel made before this change has no `share.mp4`, and the daily post skips it ("no public version").

What `share.mp4` holds, and why:

- **The tall layout without the end card.** The end card names Kicksmash and its address. TikTok's Content Sharing
  Guidelines forbid "any brand name, logo, watermark, other promotional branding, link or promotional text" on
  shared content.
- **No brand in the picture of any reel, ours or a club's.** `gfx.bug` draws nothing (the club and the date stay in
  the opening, where they are the match's own facts), `gfx.tall_base` has no
  "KICKSMA.SH" under the score, and the numbers cards (`gfx.stats_card`, `cards.stats_grid` and their tall forms)
  have no "kicksma.sh" foot. So the parts are drawn once, for all three films. `tall.mp4` and `wide.mp4` keep the
  end card: in the app, the brand lives there.
- **The match sound only.** No music track and no added crowd, whatever the player chose. No licence on record allows
  a public post of a track or of `assets/cheers/`: "bounce" came from MusicGen (CC BY-NC 4.0, no use that earns
  money), and the other files have no source recorded. The player keeps the chosen music and crowd in `tall.mp4`
  and `wide.mp4`.
- **The opening keeps its sound.** `versus.py` makes every effect from numbers (no sample), and its voice is Kokoro
  (Apache 2.0, commercial use permitted). The piper test voice (non-commercial data) is not in the Modal image, so
  it never speaks in a fast reel.

How it is made (`share.py`, called by `finish_layout` in `modal/fastreel.py`), with no part drawn again and no
picture encoded twice:

1. `share.body` counts the pictures of the parts before the end card (`list.txt` of `reel_points.py`; the end card is
   the last part, `NN-outro.mp4`).
2. The 1080p encode of `tall.mp4` takes `share.key_args`: each picture once, at its own time, and the first picture
   of the end card as a key frame. Without `-fps_mode passthrough`, ffmpeg copies a picture at a small gap between
   two parts (the sound of a part is a little longer than its picture), and picture n of the encode is then not
   picture n of the join. So `tall.mp4` now has no such copied pictures.
3. `share.cut` copies the first n packets of `tall.mp4` as they are, and puts under them the sound of the join of the
   parts (the match, the slow match sound of the replays, the opening), cut at the same moment and set to -16 LUFS
   as the reel. It checks that the n packets are exactly the n first pictures; when they are not, it encodes those
   pictures once more from the join, and its line in the clock says "encoded" in place of "copied".

When `share.cut` fails, `tall.mp4` and `wide.mp4` still go out, and the clock has the reason. The extra work is one
pass of the sound and one copy: about 2 seconds on the tall machine.

Checked on 26 November 2026 here, with no Modal run: `finish_layout` itself (a stand-in for the `modal` module, made-up
parts, music and crowd on) gave a `share.mp4` whose pictures are the first 421 of `tall.mp4`, picture for picture
(frame checksums), whose last picture is the last of the clip and not the end card, with the opening's 440 Hz and
the match's 660 Hz in its sound and the 200 Hz "music" 57 dB down, and `instagram.py check` passed.

### A whole film, with no person (`modal/fastreel.py`, "whole", 27 November 2026)

The owner's stage A: a player who sends the whole film ("Full reel") gets the fast reel's job with no person, as the
note desk made it by hand the night before (below). How it flows:

1. The reel host joins the parts (`assemble` in `modal/serve.py`) and tells Kicksmash (`POST /api/reel/upload`).
2. Kicksmash answers with the job's start request marked `"whole": true` (`fastReelStart`), when the match has two
   pairs of two, as for clips. With no start request (another line-up), the note desk wakes as before.
3. `assemble` starts `make` with it. The step "clips" for a whole film (`whole_film`):
   - `film_sound` reads the sound track alone (`ffmpeg -map 0:a:0 -vn`: the demuxer skips the picture, so the 4K
     film is never decoded) and runs `film_plan.js`: the Rally Finder's core and the phone's own choice of the
     stretches (`planCut` of the best points, `planReel("celebrations")`, `pickStretches`: 12 clips and 200 s at
     most). A whole film's reel is the reel its fast reel would be. The plan stays in `match/film-plan.json`.
   - `film_stretch` decodes each stretch from the camera file on its own machine, and `film_join` writes what the
     step writes for clips (`film_clips.py`, the work that `fullclips.py` does by hand).
   The steps after it are the fast reel's, with the same progress on the match page (a first report at 6% once the
   sound is read).
4. `honest.py` decides what the reel may claim. A score box, the winner of each point and the numbers go in only
   when every match has a set score, the sound heard at least the points the set scores need (four a game, a
   tie-break's seven; every rally of the whole film counts, so it is the most the film can hold), and a sure winner
   was read for each of them. No step reads a winner yet, so today such a reel has none of the three, and
   `honest.strip` takes them out of `points.json` if a later step ever writes them. `reel.json` keeps
   `"score": {"shown": false, "why": "no_score" | "few_points" | "no_winners", "found", "need"}`, the post of the
   reel carries `"noScore"`, and the match page shows the reason as a row of the fold under the reel (below).
   `share.mp4` is made as for every fast reel (`finish_layout`).

### What a reel could not do (`missing.py`, 27 November 2026)

The owner: under every reel, fast and full, the match page says what the reel could not do, why, and what the player
can do differently the next time they film. `missing.missing_of` gives the codes, in one fixed order, each once, after
the plan (`run_make` in `modal/fastreel.py`); `reel.json` keeps them as `"missing"`, and the post of the finished reel
carries them. Kicksmash keeps them in the ready row's `note` (`{"noScore": ..., "missing": [...]}`, no new column) and
shows one row for each code in the fold "What this reel could not do": the thing, the reason, and one tip
(`MISSING_COPY` in `src/lib/domain/matchReel.ts`, the words in `reelMissing` in `messages/`; `/film` takes its tips
from the same words).

| Code | When the job sends it |
| --- | --- |
| `fast_by_design` | a fast reel: no score, no winner of each point, no numbers, no fastest shot |
| `no_score`, `few_points`, `no_winners` | a whole film: `honest.py`'s reason when the score stays out |
| `no_speed` | a whole film: no step measures the speed of a shot yet |
| `court_not_found`, `phone_moved` | `court_find.py` was not sure of the film's lines (`phone_moved`: its reason was `moved`), so the job took `courts/<place>.json` (`court_of`, `"source": "place"`) |
| `players_out_of_frame` | `fast_points.py` left a clip out (`held_share` under 0.25) or a close look out (`closeup.framed`): `points.json` `"left_out"` |
| `far_names_unsure` | a clip of the reel has `"far_named": false` in `clips.json` (`who.py`) |
| `no_heart_rate` | no `hr.json` came with the upload |

The music and the crowd are the player's choices, never a thing missing. `test_missing.py` checks the list on plans
made by hand (`python3 scripts/highlights/test_missing.py`; `tests/reel-missing.test.ts` runs it in the unit suite).

The test of 27 November 2026 (the 40 GB film of 24 November, 88 minutes of 4K HEVC, a dry run): the sound was read
in 25 s and planned in 4 s, and gave the same 8 stretches (195 s) as the phone's code on the desk's own lists. The
step "clips" took 3.9 minutes in all. `who.py` was not sure of two names, so the run stopped at "players", as a
player's would; the answer went in `names-answer.json`, and the second run went on from the saved work and took 9
minutes (follow 305 s, replays 74 s, music and finish 102 s). `fast_points.py` left out two of the 8 stretches (the
first, with one near player, and the last); the reel has 6 points, 176 s, and `share.mp4`. `reel.json` says
`"why": "no_winners"` (113 points heard, 68 needed). Both runs together cost $1.28 on Modal's bill. The sheet of the
tall reel showed the opening, names and play in every clip, and two close looks after a point that missed their
player (an empty corner of the court): the reaction step is the weak part, not the stretches.

### The same reel from the whole film, by hand (`modal/fullclips.py`, 27 November 2026)

When a person chooses the stretches (the note desk, for a film whose job did not start), the clips are cut the same
way:

1. The sound of the film through `audio.js` gives the candidate points (88 minutes: 20 s on one machine).
2. One sheet of frames for each candidate (the serve, and eight views after the last sound), and a reader of the
   sheets says which candidates are points, who won, and who reacts. Choose the points with a clear reaction.
3. `modal run modal/fullclips.py --video uploads/<token>/video.mov --work <out>/work --stretches s.json` decodes each
   stretch from the camera file on its own machine and writes what the job's step "clips" writes.
4. `modal run modal/fastreel.py --request req.json --dry` with `"out": "<out>"` makes the reel from them; look at its
   sheet, copy the files to `reels/<new token>/`, and post the reel through `/api/admin/match-reel`.

What the first one showed (the match of 24 November, 132 candidates between the warm-up and the second match):

- **The loudest "rally" of the film was two players who hit balls in a break.** The sound's best stretch (31 s, 19
  sounds) had half of the players outside the court. The phone's cut would have sent it, and the job would have
  drawn it. A candidate is a point only when a picture shows four players and a serve.
- **A copy of the stretches with `ffmpeg -c copy` is not a phone's cut.** A stretch that ends inside a group of
  pictures gives "Invalid data found" at each join; the machines of the step "clips" then count other pictures, and
  the job stops with "clean file 196.20 s, working copy 196.06 s". Decode each stretch from the camera file instead.
- **The sound finds too few points for a score.** The readers found 59 points in 99 candidates of the first match,
  whose 17 games need 68 points at the least; four games showed three points or fewer. A winner was read with a
  confidence of 0.7 or more for 16 of the 59. The servers came out in the right order for the nine games of the
  first set. So the full reel of that match has no score box, no numbers of the score engine and no fastest shot:
  a score needs every serve from the picture (`serve.py` on the whole film), not the sound's list.
- **A stretch can hold a break before its point** (27 November 2026, not fixed). The third stretch of the test reel
  starts about 20 s before play: the near pair stands behind the side glass, and the sound hears hits there. The
  clip shows about 16 s of empty court, and a replay was chosen in that break. `closeup.py` now keeps such a replay
  out (see "A close look is drawn only when its player is in it"), but the clip still starts too early.

## Every clip is a point, and it opens on the serve (`fast_points.py`, 27 November 2026)

The whole film of 27 November had three faults that the sound alone could not see:

- **A break as a "Long rally".** The far half was empty, and two players walked back and talked; the sound heard
  19 "hits". The check of the near pair let it through, because the pair walked into the picture.
- **A far serve cut off.** The far pair served while the near pair waited at the back glass, under the phone and out
  of the picture. The clip waited for a near player and began 2.7 s after the serve. A fast reel of the same match
  had the same fault (2.5 s).
- **A 40 s rally with all four players left out.** The tracker had named the near pair wrongly and held one player.

The tracker keeps a far player only when it is sure of the name, so it cannot say that a half is empty. The detector's
boxes of `match/kf` (3 a second) with `court.zone` can (`court_counts`). Measured on both films:

| | a player in each half | ball flights in 10 s | three whole players on court |
| --- | --- | --- | --- |
| the six points of the whole film | 87 to 100% | 8.2 to 21.6 | 70 to 100% |
| the break | 44% | 3.0 | |
| the fast reel's clip with the near pair cut off at the edges (25 November) | 91% | | 23% |

So a clip is a point with a player in each half for 70% of the rally and 5 flights in 10 s or more
(`not_a_point`). A near player whose box touches the left, right or bottom edge plays, but is not in the picture: the
"keep" rule for a clip that the tracker holds too little counts whole players only (80%). The clip opens 1.5 s before
the serve, and not before two players are on the court or the near pair is held (`first_on_court`). Tests:
`test_fast_points.py` (15 checks).

## The court finder (`court_find.py`, 27 November 2026)

A player puts the phone behind the back glass by hand, so its height, place and angle change every match. The court
lines therefore belong to the film, not to the club. `court_find.py` finds them from the film's frames and writes the
`court.json` that `court.py` reads, plus `H` (court metres to pixels, as in `court-H.json`), the camera and a
confidence. When it cannot be sure, it says "not sure" with a reason and writes no court.

```bash
python court_find.py 'match/kf/*.jpg' --out match/court.json --report match/court-find.json --debug match/court-find.jpg
python court_find.py --video film.mp4 --report r.json        # 27 frames read from the film by seeking
python -m unittest scripts/highlights/test_court_find.py      # 12 tests, about 35 s (numpy, scipy, opencv)
```

**In the reel job** (`fastreel.py` `court_of`, right after the step "clips", on the frames in `match/kf/`): a court in
the start request wins (a person drew it). Otherwise the finder runs, about 20 s on the job's own machine. When it is
sure, its court is the film's, and its floor map also goes to `match/court-H.json`. When it is not sure, the job takes
`courts/<place>.json` from the store and the reel says so (`court_not_found`, or `phone_moved` for the reason `moved`).
With neither, the job stops with the finder's reason. `match/court-source.json` keeps the choice, and a second run
keeps it too; `match/court-find.json` and `match/court-find.jpg` show what the finder saw.

How it works (all pixels of a 1920x1080 picture):

1. **Backgrounds.** The film in three parts; each part gives the median of up to 15 of its frames, the whole film the
   median of up to 25. The players move and the lines do not, so the players vanish.
2. **Three white lines.** A white top-hat of the brightness where the colour is pale, then Hough and a fit to the
   middle of the line in each column: the near service line (court Y 3.05 m), the centre line up from its T (X 5 m),
   and the net's white band (Y 10 m, 0.92 m at the posts): the flat white line with the most white on both sides of
   the centre line. A run along the band often goes on past a post (the rail of the side wall, the next court's net),
   so it is scored only as far as it reaches on both sides.
3. **The camera.** The three lines leave two numbers open, the focal length and the tilt: from a phone in the middle
   of the glass, the plane of the centre line holds the camera's own axis, so the centre line cannot give the tilt.
   A grid of both gives one camera each in closed form, and the side walls decide: the camera whose two wall feet lie
   on colour edges with the floor's colour inside wins. A least-squares fit of eight numbers (focal length, place,
   three angles, one lens bend) and the net's sag then takes every line, the walls too, and the far service line
   where it is seen through the net.
4. **The checks.** Line error (all lines 4 px RMS or less, each line 7 px or less); both walls found; the far
   service line where the camera puts it, when the band does not hide it; no second court that fits nearly as well;
   a phone's camera (focal length 500 to 2400 px, 0.4 to 4.5 m high, up to 4 m behind the glass, roll 8° or less);
   each part's court within 40 px of the whole film's. And the phone did not move: the three parts' pictures,
   phase-correlated, within 8 px.

Reason codes: `lines_not_found`, `walls_not_found`, `fit_poor`, `camera_implausible`, `moved` (the player tip "do
not move the phone"), `too_few_frames` (fewer than 9).

### Measured on the stored films

Three films with a court drawn by hand: film 1 (`match1`, 1x lens low on the glass; the numbers in `court.py`),
film 2 (`match2`, wide lens higher up; `court.json` and eight measured points in `camera-points.json`), film 3
(`match3`, wide lens; `courts/<place>.json`; the clips and the whole film are the same recording: their pictures
match to 0.07 px). 23, 46 and 45 frames; about 20 s for each film on one machine.

| | film 1 | film 2 | film 3 |
| --- | --- | --- | --- |
| camera found | f 853 px, 1.30 m high, at the glass, tilt 5.7° | f 823 px, 2.35 m, 0.1 m in front, 19.4° | f 884 px, 2.36 m, 0.2 m behind, 19.9° |
| line error (RMS) | 2.0 px | 1.5 px | 1.3 px |
| net's foot `NET_FOOT_Y`, against the hand | -5 px | -3 px | +8 px |
| posts | 24, 27 px | 6, 16 px | 11, 11 px |
| near side walls (mean distance) | 1.3, 1.1 px | 0.4, 4.5 px | 15, 16 px |
| far glass line, far corners | 10 px; 12, 16 px | 0 px; 19, 50 px | 4 px; 38, 61 px |
| `court.zone` changed on the stored sightings | (none stored) | 93 of 15,074 (0.6%) | 49 of 4,338 detections (1.1%) |
| serve depth (`pose_serve`) changed | | 12 of 8,116 near boxes | 1 of 1,124 near boxes |

The hand courts are not the truth, and where the two disagree the picture sides with the finder:

- Film 2's eight measured points: the finder's camera is 1.3 to 5.3 px from seven of them. The eighth, the net's
  foot at the right post, is 20 px off: the point was taken at the post's middle, and the court's corner (where the
  wall's foot meets the net's line) is about 10 px inside it. A camera fitted to the eight points (5.1 px RMS) puts
  the far corners at x 761 and 1188: the finder has 759 and 1180, the hand court 740 and 1230.
- Film 3's hand court does not come from one camera: a camera fitted to its corners misses them by up to 28 px. Its
  side lines run along the glass about 15 px outside the floor; 36 of its 49 zone changes are near → None at a wall.
- Film 1's posts: the hand court has the posts' middles, the finder the court's corners. Film 1 is the hard case:
  from a low phone the walls are almost flat in the picture, so the focal length is the least sure number, and the
  parts' courts differ by up to 24 px at the posts.

`serve.py`'s own depth numbers (705, 770, 546, 530) are pixels of the first film and do not read `court.json`.

### How often it says "not sure"

- The full frame sets (above, and film 2's 12 frames of 4K): 5 of 5 sure.
- Twelve smaller sets of 12 to 15 frames (the first and the last frames of each film, and two random picks): 11
  sure, each within 1 to 8 px of its film's full-set court; 1 not sure (film 1, `fit_poor`: its parts' courts 47 px
  apart).
- One frame: `too_few_frames`, 6 of 6. Before that rule one frame of film 1 gave a "sure" court 49 px off: a single
  picture keeps its players, and no part of the film checks another.
- Made-up cases: film 2 with the phone moved by 29 px and turned 0.6° after the middle: `moved` (38 px); the
  clips of film 3 joined to film 1: `moved`; the top of the picture only: `lines_not_found`.
- The films that did not move: 0.3 to 1.2 px between the parts' pictures. Film 3's picture sank 3.7 px over its 3
  minutes of clips (the phone sagging), under the limit of 8 px.

### How the job should call it (not wired yet)

In `modal/fastreel.py`, `make`: after step 1 ("clips", which writes `match/kf/`) and before step 2 ("players", whose
detector reads `TILES`), and only when the request has no `court` (a person's court still wins):

```python
r = subprocess.run(['python', '/root/hl/court_find.py', f'{M}/kf/*.jpg', '--out', f'{M}/court.json',
                    '--report', f'{M}/court-find.json', '--debug', f'{M}/court-find.jpg'], env=home(W))
rep = json.load(open(f'{M}/court-find.json'))
if rep['status'] == 'ok':
    json.dump({'H': rep['court']['H']}, open(f'{M}/court-H.json', 'w'))          # court_map.py's floor map
    # court_map.py's HCAM (the lens's height) is rep['court']['camera']['C'][2]; its Y0 (the horizon) follows too
elif req.get('place') and os.path.exists(f"/vol/courts/{req['place']}.json"):           # the place's court, drawn once
    json.dump(json.load(open(f"/vol/courts/{req['place']}.json")), open(f'{M}/court.json', 'w'))
else:
    raise RuntimeError(f"court not sure: {rep['reason']}: {rep['detail']}")       # the reason picks the tip
```

The base image already has numpy, scipy and opencv. The check "no court lines" before step 1 then moves after it.
The report's `reason` picks the player's tip: `moved` "do not move the phone"; `lines_not_found` and
`walls_not_found` "the near service line, the net and both side walls in the picture"; the others "a person draws
the lines". Look at `court-find.jpg` (red: the floor lines, yellow: the net's band) on the job's sheet.

## What is not done

- A whole film's stretches come from the sound alone, as the phone's do. A break where two players hit balls can be
  chosen (the lesson above); `fast_points.py` drops a clip that shows its near pair too little, and no step checks for
  four players and a serve yet. No step reads the winner of a point, so a whole film's reel never has a score today.

- `court_find.py` finds the court lines of a film (above), but the job does not call it yet: the fast reel reads
  them from `courts/<place>.json` on the store and stops with "no court lines" for a camera place that has none.
- The fast reel names the far players clip by clip, where its voices agree (`who.py`): on the clips of 25 November
  in 7 of 8 clips, all right by eye. A clip with two women or two men at the far end in like colours keeps no far
  names: the man/woman voice is silent there, and the look alone is too weak (on these clips it never passed 0.08).
- The rally of a fast-reel clip comes from the sound alone (`fast_points.py`): on 24 November two titles of eight
  were wrong ("27-second rally" for a rally of 12 s, "18-second rally" for 15 s), because the phone hears half of the
  hits and a clip can hold two points.
- The shot counter is an estimate. With `SHOTS` it leaves out the sounds that are proven not to be shots
  of this ball; a bounce can still count. No rally has a count that a person made to compare with. A video
  at 60 frames a second is the next test.
- The score is not proven for a whole match. `score_log.py` checks a log of every point against the rules
  and the final score, and `scorebox.py` draws the result. The only log so far agrees with the typed score in
  two sets of four (see the lessons). No detector writes the log yet: a model that reads frames did, at a
  cost that is too high for every match.
- The picture is not 4K and the slow motion is not true 60 frames a second. An upscale of a whole frame is
  28 seconds here, and a frame in between is a guess: a racket at full speed stays a blur.
- No music, and no "funny moments" part: the laugh measure found nothing strong in this match.

## What this already cost to learn

- **An mp4 encode adds pictures at the joins of the parts.** ffmpeg's default for an mp4 is a constant rate: where
  the sound of a part is longer than its picture, the next part starts a little later, and ffmpeg copies a picture
  to fill the gap. A join of four test parts had 369 pictures and its plain encode 370. A picture number of the
  join is a picture number of the encode only with `-fps_mode passthrough` (`share.key_args`).
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
- **A name tag stays whole inside the picture.** A player at the edge had a tag cut to its last three letters.
  The tag now moves in from the edge, and a player outside the vertical crop gets none.
- **`head -1` on a script that prints more is an error in the log.** The first line was read and the rest
  raised "Broken pipe". The result was correct, but a watcher that looked for "Traceback" stopped early.
  `rally_shots.sh` reads the first line with `sed -n 1p`.
- **Equal ends is not equal winners.** The reel gave each pair three points at the camera end, and every
  point in it was won by the same pair. A player of the other pair said so at once. The pipeline does not
  know who won a point, and six still frames of a rally's end do not show it to a careful reader. Until
  that is solved, `cand_points.py` lists the best points with a sheet of each end, and a person says who won.
  The person's answer for 18 points: 9 for one pair, 6 for the other, 3 "cannot tell". All six points of the
  reel were among the 9. `plan.py` with `WINNERS` now shares the points between the winners.
- **The rules of padel do not repair a weak detector. Measure before you promise.** I told the owner that
  the rules could teach the machine who won each point. `score_decode.py simulate2` then showed it: with
  the game limits, the rules and the typed final score, a detector that is right for 80% of the points gives
  a correct score on screen 62% of the time, 90% gives 81%, 95% gives 90%, and 98% gives 96%. So the score
  needs a detector that sees the end of almost every point, and matches with known winners to measure it.
- **A heard score is a strong hint.** `score_decode.py simulate3`: with a detector that is right for 80% of
  the points, the score on screen is right 60% of the time; with a score call heard before 40% of the points
  (right four times in five) it is 79%, and before 70% of the points it is 87%. So a microphone on the
  players' side of the glass is worth more than a better guess of each point.
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
- **A stronger recogniser does not hear what the microphone did not record.** `scribe.py` sent the twelve
  seconds before each of 98 points to a paid recogniser. It returned text for five of them, and none was a
  score. Two free recognisers and one paid one agree: the sound is the limit, not the recogniser.
- **Let a recogniser judge a voice when no person can listen.** It wrote "Jarek" and "Tikalai" for the team
  names, and "Barzoo" for "versus" with the deepest voice behind the effects. That voice was dropped.
- **Two microphones on one fence hear the court behind the fence as well as their own.** A sound from the next
  court arrives with the same time difference and the same level as a sound from the mirror place on this
  court. The time difference says which half, not which court. A third microphone that is not on the same
  line (the phone), the video, or the voices of the four players must tell the courts apart.
- **A voice detector in front of the recogniser drops far voices.** With it, a match of 94 minutes had speech
  at the start and at the end only. With a low threshold it kept 8 words in ten minutes; the recogniser
  without it wrote 400. The detector expects a voice near the microphone.
- **Two runs of one recogniser on the same sound write different sentences.** Even loudness against raw sound,
  ten minutes: 91 of 261 words agree. Where nobody speaks it writes filler ("Thank you.", "We'll be right
  back."). So a word of a far voice counts only when two runs agree, and free text is not a fact. A paid
  service returned no text at all for the same ten minutes.
- **A recorder that writes 32-bit numbers does not distort a hit.** The loudest hits were above the normal
  maximum and kept their shape. Two recorders of one kit stayed together to a hundredth of a second in 90
  minutes. A person who says the side aloud at the start ("this is the left side") names the file for good.
- **A paid recogniser wants short pieces and a raised level.** One file of ten minutes of far voices came
  back as one tag, "[background noise]", and was charged in full. The same sound in pieces of 20 seconds,
  30 dB up behind a limiter (`scribe_chunks.py`), came back as sentences. A person checked ten clips: three
  had a right text from any method, and this method was right on all three.
- **Players do not call the score for a microphone on the fence.** Two recorders, 94 minutes, 563 pieces of
  20 seconds: 177 had text, ten looked like a score call, and a second recogniser (`tx_recheck.py`)
  confirmed two, each in one of its two runs only. One "five-all" was "my ball". So speech is a check for
  the score, never its source. The score must come from who won each point.
- **A recorder keeps test recordings beside the match.** A tool that joined every file started each clip 4
  to 6 seconds early, and its result was reported before the fault was seen. FFmpeg's `concat` of files
  with two sample formats read noise and gave no error. So: take the files over 20 seconds, decode each on
  its own, and run each new joining tool on a pair with a known answer first.
- **Line up the phone and the fence by loudness, not by single hits.** A hit reaches the phone and a
  recorder on the fence up to 50 ms apart, and the difference changes with the place of the hit. Rises in
  steps of 5 ms gave a peak 6 times the spread, at a wrong place. The loudness curve with 50 values a second
  and the slow level removed (`tx_phone.py`) gave a peak 105 times the spread, the same in each ten minutes.
- **The phone records the sound field, and only Apple can open it.** An iPhone 16 or newer writes a second
  sound track of four channels (tag `apac`). FFmpeg cannot decode it, and its plain copy drops the settings
  block that the decoder needs. `apac_cut.py` copies the track by hand into a file of 3 MB a minute, with no
  picture and no location tags; the copied bytes equal the source. A Mac with macOS 15 decodes that file
  with `afconvert`: a cut of 90 seconds came back as four channels, and 21 of 39 hits arrived from one narrow
  direction. The error in degrees is not measured yet: the piece had six hits with a known hitter. Choose a
  test piece where the truth exists before a person is asked to do a step.
- **A rented machine behind a proxy needs two things that no error names well.** The Modal client says
  "Could not connect" until `modal[api-proxy-support]` is installed. A function with a graphics card says
  "add a payment method", also inside the free credit. `modal/ingest.py` brought 7.4 GB from a shared link
  to a volume in 3 minutes; `modal/gpu_check.py` decoded 120 seconds of video in 6 on an L4 card.
- **Three microphones find more points than one.** The phone alone, at four hits or more, gave 117 rallies in
  96 minutes, with gaps of two minutes. At two hits or more (the third argument of `audio.js`), and with both recorders on the
  fence on the same clock, the list has 248 candidates: 71 from all three, 71 from two, 106 from one. Frames
  of the ones from a single source show play on the court and also an empty court. So the labelling page
  has a "Not a point" answer, and no guess removes a candidate before a person sees it.
- **A page for hundreds of points links its clips.** Eighteen clips fit inside one file; 248 do not. With
  `LINKED=1` the page points at `clips/001.mp4` and so on (`label_clips.py`), and it keeps the answers in the
  browser so a person can stop and go on. Make the picture small before the colour change: the other order
  took 2.5 times the processor time.
- **The court lines belong to the camera place, not to the code.** A second match was filmed with the wide
  lens from higher up: the net's foot moved from y 570 to y 455 and the side walls became twice as steep.
  `court.py` now reads `match/court.json`; draw the lines and the zones on two frames before the long steps.
  And they belong to the film, not even to the place: the phone is put there by hand every match. `court_find.py`
  finds them per film (27 November 2026). Its first try fitted a camera to the three white lines alone: cameras
  from 0.1 m to 3.7 m high fitted them to 2 px. The three lines leave the focal length and the tilt open, and only
  the side walls close them. A good fit to some lines is no proof; the lines that were not fitted are.
- **Answers that live in a browser are lost by a new version of the page.** A person answered 33 clips; the
  page showed its copy line only after the last clip, so a new version with a copy button was published,
  and the answers were gone. Give the copy button in the first version, and do not publish over a page
  that a person is using. Answers that matter belong in a store on the server.
- **Ask a person for a check, not for the work.** 248 clips with no estimate beside them is the work of the
  machine handed to a person. Estimate first, then ask about the unsure ones and a small random sample.
  And cut each clip to the end of the point: where the sound sources disagreed about the last hit (75 of
  142 candidates, by more than 2 seconds), the middle value showed a serve and no result.
- **Sounds of the next courts join points into one "rally".** In a hall with play on both sides, the last
  point of a match came out as "the marathon, 57 shots": 60 sounds in 88 seconds, of which the camera saw
  11, and the ball stopped four times in between. The point had 10 shots. `build.py` now splits such a
  case at the last long stop of the ball; the numbers card had shown 57 as the longest rally.
- **Two recorders on the fence do not say which half a hit came from, yet.** The arrival-time difference
  against 54 shots that the camera was sure of: far shots +32 ms in the middle and 87% on the right side
  of zero, near shots -5 ms and 56%. 65% right in all. The far recorder hears a near hit badly, and the
  next court fills the gap. A try to place each sound with the phone as third microphone gave noise.
  The camera says the hitter's end; the sound does not.
- **A portrait with a fence behind it is cut out as a fence.** The chooser took the largest sharp face; the
  person-cutter then kept the fence post and a wrist. The sheet of all cut-outs showed it in a minute, and
  portraits on plain grass came out whole. The choice was made by hand for that reel; a rule is not written.
- **A long step can outlive its job.** One job may run two hours. The shot count of a rally of 95 seconds
  took 40 minutes, and the reel would have been stopped in the middle. Give each long step its own job.
- **The score is automatic, and a player is never asked who won a point** (the owner, 19 November 2026). A
  page that asks about points is a tool for the people who build the detector. It asks for context, not for
  a bare label (`context_page.py`): how the point ended, who hit the last shot, and why a clip is not a point.
- **In a busy hall a third of the "rallies" are not points.** Of 19 random rallies of four hits or more that
  a person checked, 7 were not a point: one in the warm-up and six inside the match, one of them with 14
  sounds. The candidate list from sound needs the picture before it is a list of points.
- **A warm-up has a shape.** Over 3 minutes the share of time inside rallies goes above a half, then falls
  under a quarter when the game starts; two matches gave the same drop at 9 minutes, and the second one had
  "ready?" in the speech and the first serve formation on the frames a minute later. The first reel of
  that match opened with a warm-up rally of 26 shots called "Point of the match". Where the players stand
  at the first hit, and the hits a minute, did not separate warm-up from game.
- **An arm that moves is not a shot.** A "smash replay" showed a player who lifted his hand while he talked:
  the wrist was fast, and a ball of the next court gave the sound. Two "sure" shots at one end under 0.9
  seconds apart cannot both be shots. The counter now goes by the turn of the teams between the shots the
  camera is sure of (`by_turn` in `build.py`); its numbers were not checked against a count by a person.
- **A lost ball is not a dead ball.** The rule "the ball stopped, so the rally ended" cut a rally 3 seconds
  early where the tracker lost the ball at the far end. Two sure shots after the stop, at most 2 seconds
  apart, now keep the rally alive; one alone can be an arm that picks up a ball. Both rules rest on one
  match and wait for a ball tracker that sees the far end.
- **One recorder can hang beside a machine.** Its floor was 13 dB above the other one's, so "the louder one
  leads" gave it the lead 93% of the time. By level over each recorder's own floor it leads 31%
  (`tx_mix.py`). Three full recordings of a match do not fit in memory together: the mix goes minute by minute.
- **Say which team is A in the answer itself.** Two pages for one match were built from two match files with
  the teams in the other order. A test in the browser showed the wrong team on a filled-in answer before a
  person saw it. The answer line of `context_page.py` carries `"A"` and `"B"` with the team names.
- **A better cut-out model, and a smaller one.** On the same four portraits `birefnet-general-lite` left no
  fence behind a player; the first model and a second one did. The full-size model of that family ended
  the process for lack of memory (15 GB); the lite one takes 7 seconds a portrait on the processor.
- **Words that only one recogniser heard are shown as "roughly".** A player's line after a point came from
  one recogniser only; the second one wrote other words. It went on the screen as a bubble because a person
  asked for it and can hear the sound; it is not a fact.
- **A replay waits where its player will be found.** The tracker found a player 37 frames into the 80 frames
  of his replay. Until then the window sat at the middle of the picture, so the replay opened on two seconds
  of empty grass. The window now holds the player's first known place from the start. The store of slow
  replays did not know the track either: its key now carries the late start, or the old pictures come back.
- **The noise of the hall comes out before the mix, and the quiet recorder leads when nothing happens.** The
  owner heard an air conditioner in the reel. Two causes, both measured. One recorder hung beside a machine
  (floor 13 dB over the other), and with equal shares at rest, half of its noise was always in the mix: the
  lead now goes by the level over each recorder's own floor, and at rest the recorder with less noise leads
  (its share went from 31% to 8%). And `tx_mix.py` now takes the steady noise down by 18 dB, for each
  recorder with its own noise picture. The noise floor inside the six points of the reel fell by 10 to
  16 dB; the loud parts (hits, voices) stayed within 0.3 dB. Removal alone, without the lead, gave 4 to 6 dB.
- **A team with no name gets one from its players** (`teams.py`, the owner's rule): the first letter of one
  player and the name of the other.
- **The copy of the video is for finding, the camera file is for the picture.** The owner said the reel
  looked like 720p. It was 1080p from a 1080p copy of a 4K file, and a replay zoom took a third of that.
  `modal/cut.py` now cuts the chosen points out of the camera file without a new encode, and `render.py`
  renders from those pieces (`HIRES`) at `SCALE=2`. Measured on the same frames: a near player 2.2 times
  sharper, the far players 2.75 times. The pieces have 60 pictures a second, so a replay at half speed
  shows real pictures. Time on four processors: 6 s for a second of a clip, 10 s for a second of a replay.
- **A highlight is a point the players react to, not a long rally** (the owner, on the reel of the second
  match). Two of six clips ended with an error and no reaction: "not a highlight". The moments of a shout, a
  laugh or a cheer in the transcripts of the recorders found the points the owner liked, and three more.
  `reel_points.py` builds from such points: from the serve, to before the next serve.
- **After the point: the reaction first, then the replay.** A reel of a professional editor, measured: no cut
  and no zoom inside a rally; after each point a close look at a player (1.2 to 3.2 s), then a replay (3 to
  14 s); cheers from the winning shot, 3.5 to 5 s, 17 to 24 dB over the rally.
- **A bubble shows only words a viewer can hear.** The owner could not hear the words of one bubble; they
  came from one recogniser. A second line of the same player was audible and stays.
- **No shot counter until a person has counted the same rallies.** It was wrong in three reels (12 for 8,
  19 and 26 "at random"). `COUNTER=0`, and `reel_points.py` always sets it.
- **A cheer waits for the players** (`cheers.py`): it starts when no voice is heard for 1.5 s after the last
  shot, and goes down by 12 dB if a voice comes back. One file for one point. A made cheer can hold words: a
  recogniser heard a sentence in one of eight, and that one is not used.
- **A clock on the wall is a second timeline.** Players remembered three line calls by the time on the hall
  clock. The clock is readable in the 4K picture (not in the 1080p copy), so clock time = video time + a
  constant, and the transcripts of those minutes held the calls.
- **A long job writes its result before it can fail.** A recogniser ran 15 minutes over the full sound and
  ended on the last piece, past the end of the file, with nothing saved. It stops at the end now.
- **A sampled frame is half a second later than its listed time.** `kf_times.txt` lists whole seconds; the
  picture of frame N is the one 0.47 s after that (found by matching a frame against the working video:
  41 dB at +0.47 s, 28 dB beside it). It did not matter at one frame a second. It mattered when the opening
  needed the same moment from the camera file: the nearest key frame was up to a second away, and two
  approved portraits came out as a player who looks at the floor.
- **The opening in 4K** (`versus.py`: `SCALE`, and `KF4K` for a folder of camera frames with the names of the
  chosen frames). The cut-out model held 12 GB with the memory arena of its runtime and the kernel ended two
  runs; without the arena the peak is 6.7 GB and the masks are the same.
- **A number on the screen is a measured number** (`"meter"` in `reel_points.py`, the box where the counter
  was). The first one is a heart rate from a player's watch: one mean value a minute, put on the clock of the
  video through the clock on the wall, and read off the line between two minutes. One value a minute is what
  the box shows; it is not a beat-by-beat reading, and the card at the end says "highest minute".
- **A line call is a part of the reel** (`review.py`): the shot, then the last 0.2 s at one eighth of the
  speed and closer, then the landing picture held with a verdict a person wrote. Nothing is drawn over the
  ball or the line.
- **The winner line belongs to the moment the ball is dead, not to the last hit.** The fifth reel said "wins the
  point" while a rally went on for five more seconds, and once before a player had tried his return. The cause
  was two things together: the time came from the last hit that a reader of frames had found, and the renderer
  moved the line forward so that it fitted before the end of the clip. `reel_points.py` now takes `dead_t` (the
  ball in the net, out, the second bounce), shows the line 0.35 s after it, and makes the clip run 2.6 s past it.
  One winner was wrong too: a smash that hit the far glass before a bounce is out, and it was read as a winner.
- **A close look at the far end is a blur.** The camera has about 300 pixels for a player at the far end. A
  window is never narrower than half the picture (`ZMAX`), and a reaction or a replay is taken at the near end
  where there is one. A point whose only reaction is at the far end shows it in the wide picture.
- **A replay starts when the tracker has its player.** A player who walked into the picture late gave a replay
  two seconds of empty grass: the window waited where the player would be found. Now the replay starts there, and
  with less than 1.2 s left there is no replay. A measured number over a head (`"notes"`) obeys the same rule:
  without the player in the track it is not drawn.
- **A close look is drawn only when its player is in it** (`closeup.py`, 27 November 2026). A reel from the whole
  film had two close looks with no player. In one, the player walked out of the picture at the bottom left after the
  point; the tracker lost her, and the window held her last box at the edge for 2 s of empty court. In the other, the
  "hit" of a replay came in a break, and its player stood behind the side glass, small beside the glass wall. The
  track was right both times: its boxes agree with the picture, and the times agree with the film. Nothing checked
  the window against the track before the part was drawn. Now `closeup.framed` moves the window as `render.py` does
  and measures it in the tall layout (the middle 3/4 of the window's width, the narrower layout), so both layouts
  keep the same parts. The rule:
  - the player's box is in the shown window (75% of its area or more) in **70%** of the part's frames or more; a
    frame where the tracker does not hold the player counts as outside;
  - the box's median height is **0.33** of the window's height or more.

  `fast_points.py` applies it when it chooses: a reaction that fails starts later, 0.2 s at a time, up to 3 s after
  the dead ball and never shorter than 1.2 s; then the other near player is tried; then the point has no reaction. A
  replay candidate that fails is not a candidate, so the turns of the two pairs choose from good ones only.
  `reel_points.py` applies it again before it adds a part, for a plan written by hand. On that reel the eight good
  close looks scored 78% to 100% of the frames and 0.35 to 0.68 of the height; the two bad ones scored 8% of the
  frames and 0.30 of the height.
- **A line-call review first shows the whole serve land** (`review.py`, `"after"`): the full picture runs 0.7 s
  past the landing, and only then comes the slow close part. The first version cut away before the bounce.
- **The score is added last, from a log that the rules have checked** (`score_log.py`, `scorebox.py`). A log has
  every point with its server, its side and its winner. The rules check it: a new server is a new game, the side
  of a serve says how many points the game has had, a game ends at four points and two clear (or at a golden
  point), and the sets must come out as the final score that a player typed. `scorebox.py` draws nothing when
  that check fails, when a point of the reel is not in the log, or when the reel and the log name different
  winners. The box is an overlay on the finished reel, so a score that is proven later costs no new render.
- **The first point log proved two sets of four, and the check said where the rest fails.** Six readers of
  frames (a model that looks at sheets of frames and listens to the two recorders, one reader for each sixth of
  the match) wrote the log of the second match: 183 points in 30 games. The typed score has 30 games too.
  - Sets one and two agree with the typed 6-3 and 6-2: 17 games, 102 points, every serve from the side that the
    count gives. Five scores that a recorder heard ("two-one", "30-40", "three-two" and two more) agree with
    the log at their moments. `scorebox.py` drew the box on the reel's four points of these sets
    (`MISSING=skip`).
  - Set three does not agree. It has the seven games of a 6-1, but the winners read four to three, one game has
    eleven points and one stops at 40-15. So no box there.
  - Set four first read four games to two. Told of the conflict, its reader looked again at larger frames and
    changed three points; the set now reads 6-0. A reading that changes after the reader knows the wanted
    answer is weak proof. It is used for nothing yet.
  - Two readers disagreed on who served one point, and the fixed order of servers settled it. The readers
    also corrected the reel four times: a server at the wrong end, a high ball that landed 1.9 s later than a
    person had measured on frames (the ball was above the crop), a net-cord winner whose end came 0.9 s after
    the sound that was taken for it, and a last serve by another player.
    A time that only one reading supports is not yet a fact.
  - The players used advantage in the first two sets and a deciding point at 40-40 later. `score_log.py`
    tries both rules for each game.
  - A player then checked the third set by eye, on a page with one clip for each point (41 clear answers).
    The readers had 12 of those 41 winners wrong: seven of ten is not enough for a score. Most wrong ones were
    balls that went out, into the fence or into a player's own glass. With the player's answers the set came
    out as the typed 6-1 with no fault, and one game had eleven points: advantage two times, then a deciding
    point at the third deuce. `score_log.py` knows that rule now.
  - The page showed the log's fixed score at first, and the player could not use it: a corrected point did not
    change the points after it. The count must follow each answer at once, and a game is a run of serves by
    one player. "The same player still serves, so the game is not over" was the player's own check, and it
    found the faults faster than any confidence number.
  - One answer of the player did not fit the rules either (a game that stopped at 40-40). The frames showed a
    racket that touched the ball before it went out. The rules check the person too.
  - The cost: about 400,000 tokens for each reader, and about 100 minutes for the match when all six read at
    once. That burst reached the usage limit of the account. This is far too much for every match.
- **The score is counted backwards from what is sure** (`score_engine.py`, `score_rows.py`; the owner, 21 November
  2026). A new server is a new game, and the typed set score says how many games each pair won. The engine takes,
  for a set, the way to give every point a winner that ends each game on its last point, gives each pair its games,
  and agrees with the reader as much as it can. Measured on the third set of the second match against a player's
  answers for all 43 points: the readers alone had 32 of 43 points and 4 of 7 games right; the engine had 34 of 43
  points and 7 of 7 games. So the games and the sets of the box are sure, and the point score is not. `score_rows.py`
  gives a point score only where every valid count of the game agrees (102 of 182 moments of that match), and
  `scorebox.py` draws sets and games alone for the rest. The players did not call the score aloud: of 43 points, the
  recorders heard no score before a serve.
- **The side of the serve counts the points, and it does not care who won** (`score_engine.py`, 21 November 2026).
  The first point of a game is served from the right, and the side changes with each point. Two serves in a row
  from one side mean that a point is missing between them. The reader's log of the fourth set had three such
  places. Two were points that nobody had written down: one a player had to add by hand, and one made a 40-AD
  read as 40-40, so a clip of the seventh reel had the title "Deciding point" on a point that was not one. The
  third was a row that a player later called "not a point". The engine now puts an unseen point where the sides
  ask for one, and `score_rows.py` keeps it in the count. A game with a serve from the wrong side for its place
  gets no point score. The winners did not show these faults: the sets, the games and the last point of each
  game all agreed before.
- **Who won the point, with no person: six signals give 61%, and 95% is far away** (`winner.py`, 27 November
  2026). The owner wants the score, the winner of each point and the numbers in the full reel with no person. The
  question was whether a detector can reach 90% to 95% (`score_decode.py simulate2`: 95% gives a correct score on
  screen nine times in ten). Measured on match2, local files only:
  - *The split.* Fitted on sets 1 and 2 (102 points; the labels are engine8's winners, which came from the frame
    readers and the count, so about eight in ten are right). Measured once on held-out points: all 43 points of set 3
    (a player's answers, `points-S3-owner.json`) and the 8 points of set 4 that a player confirmed (confidence 1.0
    in engine8). The direction of each reaction vote and the recorder of the near half were chosen on sets 1 and 2.
  - *Each signal on the 51 held-out points* (right of the points where it votes): the last bounce in the 1.5 s
    before the dead ball, "that half lost", 15 of 24 (62%); the last hitter lost, 26 of 47 (55%); the last hit
    stayed in its half or crossed, 22 of 38 (58%); the pair that walks further from the net in the 5 s after the
    point won (`ident.json`, one picture a second), 29 of 44 (66%); the partners who come closer won, 23 of 39
    (59%); the recorder of a half heard more words and sounds in the 2 s after the point (Scribe), 13 of 17 (76%).
    On sets 1 and 2 the bounce had 32 of 40 (80%); why it fell on the held-out sets is not known yet.
  - *Combined* (a logistic sum, fitted on sets 1 and 2; cross-validated there set against set, 70%): 31 of 51 (61%).
    Saying "the winner of the set won every point" gives 34 of 51 (67%) on these sets, so the detector alone is
    worse than a guess from the set score. No point reaches a chance of 0.95; 48 of 181 reach 0.8.
  - *The count* (the next serve's server and side) gives no winner of a point by itself. It forces the last point
    of each game and every point of a game of four: 15 of the 51 held-out points, all right when the games are right.
  - *The engine with the detector as its reader:* set 3 has 27 of 43 points right (63%; the readers gave 34) and 5 of
    7 games (the readers gave 7 of 7); set 4 (0-6) has all 7 matched sure points and all 6 games, because a 6-0 set
    forces every game. `score_rows.py` gives a point score at 18 held-out moments, and 3 of them are right.
  - *A game is sure only by its margin.* The typed set score says how many games each pair won, not which: in a 6-1
    set any of the first six games can be the one game of the loser. `score_engine.py` now writes `game_margin`: the
    extra cost of the cheapest count that gives the game to the other pair. The two wrong games of set 3 had 0.16
    and 0.5; the readers' right games 1.5 and more. `honest.py` shows the games only when every game has log(19) or
    more, a point score and a forced winner only inside a sure game. With the detector: 16 of 30 games are sure, so
    the box shows the sets only; 7 winner lines on held-out points, 7 right; 9 point scores, 7 right. With the
    readers: 27 of 30 games, 9 winner lines (9 right), 15 point scores (15 right).
  - *What would raise it, in the order of the gain we expect.* (1) The files of a point end 1.5 s after the dead ball:
    the reaction is cut off. Keep 6 to 8 s after it, with poses of both ends at 10 pictures a second. (2) The ball
    at the far end and the kind of the end (net, out, glass, second bounce): most errors of the frame readers were
    balls out or into a glass. (3) The words of the recorders, not their number ("yes", "sorry", "out"), with the
    list of words that a call is mistaken for. (4) A person for the points that the count does not force and the
    detector is not sure of: today that is most of a match (133 of 181 points are below a chance of 0.8). Without
    (4), a full reel can show the sets, the sure games and the forced winners, and nothing else.
  To repeat: `flight.py <allball> <allwalk> flight.json`; `winner.py feats engine8.json flight.json <allwalk>
  ident.json feats.json` (with `SCRIBE` and `PHONE`); `winner.py fit feats.json engine8.json 1,2 weights.json`;
  `winner.py measure feats.json weights.json <truth>`; `winner.py points ... points-det.json`; then
  `score_engine.py` and `score_rows.py` on it. Weights on match2: bounce 1.07, voice 0.61, partners 0.47, away 0.46,
  crossed 0.05, hitter -0.04. The serve and the dead moment of each point still come from the readers' files.
- **A recogniser writes the nearest common sentence, not the padel word** (21 November 2026). A player shouted
  "Golden" before the last point, and a person who watched the reel heard it. Five recognisers did not (Scribe,
  Whisper turbo, Whisper large-v3, Parakeet, and Voxtral, a model that answers questions about a sound), on three
  microphones, with the voices taken out of the hall sound first (Demucs) and without. A picture of the sound
  showed the shout on all three microphones, so the recording has it. Three recognisers wrote the same words
  for it: "Go ahead, I'll take it". With score words as a hint, Whisper wrote "forty, forty, forty" and repeated
  the hint on clips with no call. Asked to choose one call of six, Voxtral gave the same letter for 23 of 30
  clips. All five wrote a sentence spoken beside the microphone right. So the count gives the context that the
  ear does not have: at 40-40, "I'll take it" before the serve is the receiver's choice at a deciding point. A
  heard word stays a check on the count, and a check needs a list of the words that a call is mistaken for.
- **A highlight is chosen by what the players did after it, then read in the picture** (`cand7.py` is in the work
  folder of that reel, not here). Every point got a number from the recorders' transcript in the seconds after the
  ball was dead (a laugh, a shout, a cheer, words) and from the rally length. The point a player later named "should
  have been a highlight" came out sixth of 188 with no help. Two readers then described the 18 best clips frame by
  frame: 7 were "in", 9 "maybe", 2 "out", and one of the "out" clips had been in the reel before. A clip of the reel
  before that the owner called boring had no reaction in the picture.
- **A moment late in an ordinary rally starts late** (`"start_t"`). The rally before a blooper is the boring part.
  The clip starts about 4.5 s before the ball is dead, so the title has time, and `"serve_t"` stays the true serve.
- **The crowd answers in the slow look, and a funny clip gets a jeer** (`CHEER_AT=slowmo`; the owner). After the
  point the players talk and laugh, and that is the best sound of a reel of friends. A cheer file is used once in a
  reel, so twelve clips need twelve sounds.
- **The drop of the music lands on a click, and the click is before the dead ball** (`music.py`; the owner's idea,
  21 November 2026: "time the drop with a sudden hit or smash"). The quiet start of the track plays under the
  opening, and the beat starts again from its first bar on one hit of each clip: the serve of a full rally, the last
  hit of a clip that starts late. The time of the plan is a reader's time and can be 0.8 s off, so the hit is set on
  the sharpest click near it (the sound above 2 kHz). The first rule took the loudest click within a second: in one
  clip that was the ball in the fence after the point, when the winner line was on the screen. A far serve is
  quieter than a ball that rolls into a fence. A track of a free model (`modal/music.py`, MusicGen, licence for
  use that earns no money) had 93% of its energy under 60 Hz, which a phone does not play: a layer one octave up
  is made from the bass. A moving average over 11 million samples with `np.convolve` did not end in ten minutes;
  `uniform_filter1d` needs a second.
- **A track that a person likes on headphones is not the track that the numbers like** (22 November 2026). The
  first track was 32 kHz and had 93% of its energy under 60 Hz, and on a phone speaker it sounded "narrow and
  hollow". A stronger open model (`modal/music_long.py`, ACE-Step 1.5, 48 kHz stereo, four minutes in one
  piece) gave four takes with a warmer balance by every measure. The owner then heard the first track on
  headphones: "the best track of all". The measure said what a phone can play, not what a person likes. A new
  take goes to a person's ears before a reel is built on it. `music.py` got two things from this round: the
  music waits for the announcement of the opening and comes in with the first bar of the drop played backwards
  (`MIXIN`), and a full-length track moves on one section at each hit (`SECTION`).
- **A reel on the store is not a reel a player can see** (23 November 2026). The eighth reel was on the
  store for a day, and the player who opened his match in the app found a field for a YouTube link. The
  store has no public address: a file there plays for nobody until something serves it. `modal/serve.py` is
  that thing: one web function that answers `GET /r/<token>/<name>.mp4` with the part of the file a phone
  asks for (a phone will not play a film from a host that cannot give parts), and a daily job that deletes
  a reel after 30 days and a player's video after 7. It was checked with the real file: the first megabyte
  and a part near the end equal the local file, a wrong token and a path that climbs out both answer 404,
  and the whole 65 MB file comes in 1.2 s. A reel is finished when `POST /api/admin/match-reel` has put it
  on the match page, not when `render.py` ends. Storage is not the limit: the store costs nothing for the
  first 1 TiB a month and $0.09 a GiB after that (Modal's price page, 23 November 2026), deleted files
  are billed for up to four more days, and a match video is 44 GB.
- **A film of 44 GB reaches the store in parts, and the two sides share no secret** (`modal/serve.py`, `up`;
  23 November 2026). Modal gives a web function 150 seconds and 4 GiB for one request, and a browser on
  another site cannot use the redirect that lifts the 150 seconds. So the page sends parts of 32 MB, three
  at a time, asks first which parts are there, and `assemble` joins them on another machine. `up` is one
  machine at most: a machine sees its own writes at once and another machine's only after a reload, so two
  machines would each hold half of the parts. The ticket is signed by Kicksmash with its Ed25519 key and
  read here with the public half. Checked on a test deployment with a test key and a real file: 401 for no
  ticket, another upload's ticket, a ticket past its time and a changed ticket; 409 for a finish with a
  part missing; 413 past the ticket's size; the joined file equal to the source by its SHA-256. A test
  deployment has its own name (`REELS_APP`) and is stopped after the test: it carries the daily delete job
  too.
- **An iPhone converts a film before a web page gets it, unless the film comes from Files** (23 November
  2026, read in WebKit's own change note, not tested on a phone). When a page asks for a file and the player
  chooses a video from the photo library, WebKit transcodes it to H.264 "for compatibility"; its change of
  2024 that stopped this for pictures kept it for video. A film of 44 GB does not come out of that in a time
  a player waits. From the Files app the page gets the file as it is. So the card says on an iPhone: save
  the video to Files first, then choose it from Files. That copy needs the film's size a second time, which
  is why a link from the player's drive stays a way of its own. A camera app that records into Files would
  need no copy; nobody has tried one here.
- **The fast reel's cut is the lab page's cut** (`public/lab/rf-core.js`, 23 November 2026). The Rally Finder
  page could already read a film's sound in the browser, find the rallies and copy their samples into a new
  file with nothing decoded or encoded but the sound. Its sound reader lived in the page's own script; it
  moved into the core between the two markers, and the page gave the same hits and rallies before and after
  with each of its three decoders (WebCodecs, ADTS, M4A) on a film of 100 seconds. The match page loads the
  generated file only when a player chooses the fast reel. The sound alone finds fewer points than the
  engine (104 of 182 in the match of 18 November), and it cannot give the score: the card says so with
  crosses, and the full reel stays first.
- **The phone's cut of an HEVC film flashes back after a join** (24 November 2026, a 90-minute iPhone
  film). The fast reel's cut copies the stretches without decoding, and the frame numbers of HEVC
  (its picture order counts) then repeat across a join: ffmpeg says "Duplicate POC", and 0.3 to 0.8 s
  of the stretch before shows again a few seconds after five of seven joins. `fast_reel.py` finds each
  flash (two jumps in the picture less than 1.5 s apart, where the picture after the second matches
  the one before the first) and cuts it out. The cutter itself still needs the fix.
- **"No music" is the reel before `music.py`, not a quiet track.** The owner, 23 November 2026: "add the no
  music, I will add my own". A player who puts a song on the reel inside Instagram or TikTok needs the reel
  with its own sound only: the hits, the voices, the crowd. `music.py` is the last step and writes a new
  file, so the file `render.py` wrote is that reel. The reel flow keeps both when a player has a track, and
  only the first when the player chose "No music".
- **A number over a head needs a stretch where the tracker holds that player.** A heart rate stood over a
  player in one clip of the sixth reel, and went away with that clip. Back in every clip, the first try put it
  after the dead ball: the tracker had the player for 8 of 110 frames there, and no bubble came. The plan now
  takes, in each clip, the longest stretch of 1.6 s or more in which the player is followed with no gap of
  0.45 s, after the name tags; 8 of 11 clips have one. A clip with no such stretch has no number.
- **Many short jobs go to many machines** (`modal/trackall.py`). The tracker needs 3.6 s for a second of
  video. For the 182 points of a match that is two hours on one machine, and here it was 80 points in two
  hours, because renders shared the processor and the disk filled once. One machine for each point gives the
  same file (equal sightings and boxes on a test point). The session's own disk is about 40 GB and the store
  is not a drive of it: work that makes large files belongs where the store is attached.
- **A sharp sound and a moving arm are not a hit** (22 November 2026). For a card of numbers, every sharp sound
  of the phone that a recorder confirmed was given to the player with the fastest wrist, and two such hits in a
  row by the two pairs made a "shot" with a time, a distance (the players' places on the court, from their feet
  and a map of five measured court points) and a speed. An independent reader then checked the 30 best
  candidates on 1,300 frames: 4 were right, and none of the 14 fastest. The sound was a bounce or the glass,
  the time was 0.2 to 0.5 s off, or the second player never hit the ball. The best "shot" had 365 km/h. So no
  speed and no reaction time went on the card. What passed its test: the numbers of the score engine (games in
  a row, breaks, games at 40-40, points won on serve), the longest rally, and a heart rate from a watch
  (`cards.py`). The distance a player ran did not pass either: the tracker held a player for 45% to 73% of the
  play, and each player for a different share. A speed needs the ball in the picture, and a distance needs
  every sighting of a person, also one without a name.
- **A distance needs every person, and a name by elimination** (`walk.py`, `court_map.py`, 22 November 2026).
  The tracker held a player for 45% to 73% of the play: it keeps a sighting only when it can name it, and it
  drops a person who stands still (a rule against spectators). `walk.py` keeps every person on the court ten
  times a second with no name. A half of the court has two players, so two chains by nearest place are enough,
  and a chain takes its name from the tracked player at its boxes; the other chain is the partner. Result: 93%
  to 95% of the play for each player, and 99.1% of the name votes agree with their chain. Two faults on the way:
  the place of a foot comes from a map of five measured court points (the first map, from guessed numbers, put
  the service line 140 pixels off), and two boxes on one person made the chains change places (a "sprint" of
  28 km/h). What is not proven: the total is within about 10% between sensible settings, but a waiting player
  shows 0.18 m/s at both ends, and two players move 24% and 31% more at the far end than at the near end, the
  other two 8% and -1%. Without a walk of known length there is no proof of the 10%. One player who walks the
  lines of one half before the match (40 m) gives that proof.
- **A speed is a time between two known places, and a reader checks both ends** (`ball_places.py`, `flight.py`,
  `modal/strip.py`, 22 November 2026). The camera file at 4K and 60 pictures a second shows the ball in almost
  every picture: `ball_places.py` found its candidates for all 182 points on Modal in 10 minutes. What failed
  after that, in the order it failed:
  - *One camera does not see depth.* A fit of a free flight reads the depth from the bend that gravity gives.
    Spin changes that bend. The fit put a smash 0.9 m short and a drive 3 m short, with a stated error of 1 km/h.
    So a speed is the distance between two places that are known without the fit (a hitter, a bounce on the
    floor, the net), divided by the time between them.
  - *A far player is known to about 1 m.* One pixel of the working video is 0.17 m at the far service line, and
    the foot of the box and the ankle points differed by 1.5 m. A shot from the far end has an error near 10%
    for that reason alone. A shot from the near end has about 5%.
  - *A chain that starts late makes a shot too fast.* With the first picture of the chain as the hit, the list
    began with 388 km/h. The hit must be seen: a ball that came from another direction, at the same player.
  - *"Down, then up" is also a low volley.* The candidate with the smallest stated error (3%) was a volley that the
    code took for a bounce. Of eight candidates the reader confirmed two as the code had them.
  - *The first clear picture of the ball is not the hit.* The first hand measure of a drive took it for the hit and
    was 0.26 s late. With a path that was 1.6 m too long, that gave 73 km/h for a drive of 52 km/h, and the number
    went on a card. The rule: `flight.py` gives candidates; `modal/strip.py` cuts the pictures around each end; a
    reader who does not know the expected number names the picture of the contact; then the speed is computed.
  Checked this way: a smash of 84 km/h (10.2 m in 0.434 s, far hitter, 76 to 93), a drive into the net of 75 km/h
  (8.8 m in 0.425 s, near hitter, 70 to 79), a drive of 52 km/h, an overhead of 50 km/h. The time between two hits
  ("quickest hands") has no checked value yet: the shortest one that the code found ended in the net.
- **A number that passed the check goes to the app through one door** (22 November 2026). The app keeps the
  numbers of a match in `match_stats` and shows them on the match page, on "My stats", on the public
  profile and on the club's board. The door is `POST /api/admin/match-stats` with the operator's bearer:
  `{ "code": "<the match code>", "stats": [{ "player": "<first name or id>", "kind": "fastestShot",
  "value": 84, "margin": 0.1 }, { "player": "…", "partner": "…", "kind": "gamesInRow", "value": 8 }] }`.
  The kinds are in `src/lib/domain/matchStatKinds.ts`. The door refuses a number with a margin above
  0.10, and a heart rate of a player who switched off "Keep my heart rate". The match must exist in
  the app. A filmed match with no match page gets one first, through `POST /api/admin/played-match`
  (the four players by the id of their record, the two pairs, the sets): the public API refuses a join
  to a match that is over.
- **A stopped `modal run` leaves its machines running** (22 November 2026). A ball job was stopped on this
  side and started again. The 60 machines of the first run went on, the second run got 40, and Modal
  sent a mail: "reached the limit of 100 containers". Stop the app by its name (`modal app stop <id>`)
  and look at `modal container list` before a second start.
- **A second reader of the finished file finds what the builder stopped seeing** (21 November 2026). One helper
  with no knowledge of the builder's opinion read 513 frames of the eighth reel against the notes on the seven
  before it. The score box was right in all 22 readings. Four faults were real and had been in the file for three
  versions: an empty dark box beside the logo (a venue with no name still got its box), a name tag under the score
  box, a label that named one player on a close look at another, and a title of 28 seconds over a line of 27. Give
  the reader the facts of each part and one sheet of frames for each, and ask for the second that proves a fault.
- **A part of the reel is as old as the code that drew it.** `reel_points.py` built a part again only when its
  plan had changed. Two corrections in the drawing code then reached two parts of thirty, and the run said nothing.
  The frames of an old part showed it. A part is now built again when `render.py` or `gfx.py` is newer than it.
  One day later the same fault came back in another form: a card with a new tile kept its old film, because
  the plan of a card names only a picture file, and that name had not changed. A part is now also built again
  when a picture that its plan names is newer, and a card's picture is written only when it is not the same.
- **A full disk cuts a segment short and says nothing at the next build.** The renderer died on a full disk, and
  two segments stayed as files with no end. A segment that exists is not made again. Before a build is started
  again after "No space left on device", remove the segments written last (`ffprobe` says "moov atom not found").
- **One more replay moves the number of every segment after it.** The old numbered files stayed in the folder, and
  the score box and the cheers read the folder: a reel of 4 minutes was counted as 6. `reel_points.py` now removes
  the numbered files that its plan does not use.
- **A flash-back starts before its jump** (24 November 2026). `fast_reel.py` finds a flash-back as two jumps in the
  picture. A person who cut five of them by eye started each one 3 to 17 frames (at 60 a second) before the first
  jump: the picture drifts from the clip to its echo before it jumps. The detector now cuts 0.3 s more before each
  flash (`FLASH_LEAD`, never before its join), and its five ranges hold the person's five.
- **The HDR curve is the slow part of the clean file, and a seek after a join is not the same film** (24 November
  2026). On a machine with 16 processors the decoder read the 4K HEVC clips at 140 pictures a second, and the HLG
  to normal-video curve (`zscale`, `tonemap`) did 22 a second: 13 minutes for 200 s. A seek into an HEVC film that
  the phone joined without decoding does not give the pictures (or the flash-backs) of a decode from the start. So
  `clean_part` decodes from the start on each of ten machines, and keeps only its own tenth for the curve and the
  encoder: 333 s for the whole step.
- **One clip of the phone is one near pair** (`who.py`, 24 November 2026). In each clip, two people in one frame at
  the near end are two people; then the clips join into four tracks by clothes and looks, and the two people of one
  clip never join. On the clips of two matches with other pairs, every near sighting went to the right person
  (checked against the labels a person checked for the eighth reel: 1,047 of 1,047). Clustering all near sightings at once
  into four groups put the two women together (purity 0.87).
- **A name comes from every way to name the four, not from the best face** (`who.py`). The faces knew two players
  of four (a gallery of 18 November); the pairs of two matches named the other two; a model of men and women agreed
  (0.02 and 0.98). The share of the best way among all ways is how sure the names are: 1.00 for all four. A gallery
  name that differs by one letter ("Jon", "John") is the same entry; a lookup by exact name found one face of two.
  The far end is named the same way, clip by clip, with three voices (26 November 2026). The look (DINO) and the
  colour of the shirt agreed in 2 or 3 clips of 8 by the old rule, because the look stayed inside its dead zone:
  0.002 to 0.074 in all eight clips, while the colour gave 0.08 to 0.80. The third voice is man or woman (CLIP): the
  near end reads each track (0.02, 0.98, 0.05, 0.98 for the four players), and the far person's own small crops read
  -0.96 to +0.95 against that, in the direction of the colour in all six clips where it spoke. It needs no "sex" in
  the request, and it is silent for two women or two men. A clip gets far names when two voices or more speak and none
  disagrees: 7 of 8 clips, every one right on a sheet of the named far sightings; the eighth (two women, colours 0.08
  apart) got none. One pair at the far end wore the same green, and the colour still split them (0.61 to 0.80): the
  shirt is not the whole outfit. Single sightings can still be wrong (3 of 16 on the sheet of the weakest clip), so
  `track.py` names a far tracklet only from three in four of the labelled sightings it passes through.
- **The pictures at 3 a second must carry their true time** (24 November 2026). With the fps filter they were 0.17 to
  0.25 s after their listed time, and a portrait cut from the 4K file at the listed time showed the fence where the
  player had stood. They are now every 10th picture of the working copy. The working copy itself drifted 0.12 s from
  the 4K file over ten pieces; it is now every second picture of pieces with an even count.
- **A serve from the camera end is a pose, and the sound before it may be a ball fetched** (`fast_points.py`,
  `pose_serve`, 26 November 2026). One clip opened with 10 s of a player who juggled a ball, sent it over the net,
  walked to the back glass for another and came back. The phone heard hits, the ball finder saw flights in her hands,
  and there was no pause of 6 s, so the clip started 10 s before the serve. Foot speed, the place on the screen and
  free flights did not separate the fetch from play. The serve itself did: the server stood still behind the service
  line for a second (feet within 0.03 of her height), bounced the ball, swung under the shoulders (2.9 heights a
  second) and ran to the net, while her partner stood still at the net. That signature fired once in eight clips, at
  that serve (113.88; the contact is at 113.8 on the frames). Looser limits (still 0.25, swing 1.5) fired inside two
  rallies too, so the limits are not loose. It is used only 2.5 s or more after the sound's first hit. A serve from
  the far end is not seen this way.
- **A phone behind the glass hears half of the hits** (`fast_points.py`). A click 6 dB over its own half second finds
  the first and the last hit of most rallies within 0.6 s of a person's times; a fixed level over the clip's median
  found two hits in a rally of 33 s. A clip can hold two points, and the softer sounds after a point (a ball picked
  up) are hits to the ear of the code: the last shot is the last strong click (9 dB).
- **The detector uses four threads** (`det.py`). A machine with 16 processors ran it no faster; four processes on four
  quarters of the frames took 149 s instead of about 230.
- **A Modal function must see the same secrets on both sides.** A dry run without the operator's secret listed one
  secret where the machine expected two, and every machine failed at its start ("Function has 4 dependencies but
  container got 3"). A dry run now gets an empty secret in that place.
- **The portrait: the largest face is the worst face** (`portrait.py`, 25 November 2026). The rule of `faces.py`
  (face width, sharpness, eyes apart) chose the player nearest the camera, and near the camera a player is in a
  stroke: the opening of 24 November showed a racket swung across a face, in motion blur, from below, and a hand in
  the hair. `portrait.py` scores every near sighting of each player in all clips. First the pose at 3 a second:
  upright, the hands down and away from the face, nobody in front, slow, room for the cut-out. Then the face: frontal
  or three-quarter, the head level. Then the best eight moments of each player again in the 4K file, every second
  frame of 0.4 s: sharp, no motion blur (the structure tensor of the face), the eyes open, the mouth not open in a
  shout, good light, the face like the player's other faces (SFace). Each test is a factor from 0 to 1, so no match
  is left without a portrait. The portrait is cut from that 4K frame itself, so no second search for the face. On the
  clips of 24 November three of four portraits became a smile to the camera; the fourth looks down. The faces are
  smaller (50 to 80 pixels wide in 4K against 130 to 160), so a portrait is a little softer. `PORTRAIT_SHEET` writes
  the candidates with their three weakest tests: look at it after a change of a weight.
- **Look at the frames.** Every fault above was found on a sheet of frames, after the numbers looked good
  (99% on held-out seeds while the far names were close to random).
