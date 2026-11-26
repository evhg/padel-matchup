---
name: social-post
description: The daily post of new A+ reels to @kicksma.sh on Instagram, and the owner's daily summary. Use when the routine "Kicksmash social post" fires, or when asked to post a reel.
---

# Posting reels to @kicksma.sh

The owner, 25 November 2026 (CLAUDE.md orders 10 and 11): only A+ content goes out; a reel that meets the v8
standard may go public with the players' own match sound; Claude approves each post, through the official API, and
the owner gets one summary a day: what was posted, where, and what waits. No password, no browser bot.

Instagram works today (`scripts/social/instagram.py`). TikTok is not built yet: say "TikTok: not yet" in the summary.

## What you need

- The Instagram token is a network secret of the Claude environment for `graph.facebook.com`. You never see it and
  never pass it: the proxy adds it. `curl -sS https://graph.facebook.com/v27.0/me` must answer "Kicksmash System
  User". If it answers an error, stop and say so in the summary.
- Modal (`pip install modal`; `MODAL_TOKEN_ID` and `MODAL_TOKEN_SECRET` are in the environment, never print them).
- `ffmpeg`, `ffprobe`, Python with Pillow (`pip install pillow`).

## 1. Find the new reels

`modal volume ls --json kicksmash-matches reels` lists `reels/<token>/`. A reel is new when its folder is younger than
26 hours and its token is not in `social/reviewed.json` on the store (`modal volume get`; missing means none).
A reel token is a secret of the players: never print it, never put it in a message, a commit or the summary.
`reels/<token>/reel.json` says its matches: codes, the two team titles, the score. A folder without `reel.json` is
older than 26 November 2026: skip it.

## 2. Check each reel against the v8 table

Download `tall.mp4` and take one frame a second (`ffmpeg -vf fps=1,scale=320:-2`). Put them on sheets of 36 with
the time in the BOTTOM RIGHT corner (a label at the top left hides the team names: 25 November 2026). Look at every
sheet. The reel passes only when every row holds:

| Row | Holds when |
|---|---|
| Every clip is a point | each clip shows a rally, not players who wait, walk, talk or tie a shoe |
| Clips start at play | no empty court or ball fetch longer than about 3 s before the serve |
| Players in the picture | no clip where the players are cut off or out of the frame for most of it |
| Reaction, then replay | a close look at a near player after the points; replays at the near end, not a blur |
| Fair | the replays are shared between the two pairs; no player singled out |
| Names right | the name tags and the opening's names match the players (compare the opening's faces) |
| Opening and end card | team names, faces, score and "GAME ON" readable; the end card short |
| Sound | the match sound is there; music under it; no long silence; no level jump that hurts |

A reel that fails a row is not posted. Write which row and at which second in the summary.

The fast reel (made from a player's clips) and the full reel (made from the whole match video) share this table.
The owner, 26 November 2026: the fast reel's standard does not include a winner line or a score box, because the
clips alone cannot prove who won each point or the score of each point; the full reel's standard includes both. The
app says the same in the reel choice ("Who won each point" and "The score in the corner" are ticks for the full reel
and crosses for the fast reel). So never fail a fast reel for a missing winner line or score box.

## 3. Post a reel that passes

1. `python3 scripts/social/instagram.py check tall.mp4` must say `"ok": true`.
2. The caption, in English, short, no promise, no score claim the reel does not show:
   `<title A> vs <title B> · <score>` on the first line, then `Highlights made by Kicksmash, free with every game on kicksma.sh`,
   then `#padel #padellife #kicksmash`. First names only, as in the reel. No venue name, no match link.
3. `python3 scripts/social/instagram.py post --url "<reel host>/r/<token>/tall.mp4" --caption "<caption>"`. The reel
   host is `https://evhg--kicksmash-reels-web.us-east.modal.run`. Put the URL in a shell variable from the token file,
   never in the output. One post at a time; Meta allows 100 a day.
4. Add the token to `social/reviewed.json` with `{"posted": "<permalink>", "at": "<UTC time>"}`, or with
   `{"skipped": "<row and second>"}` for a reel that failed, and `modal volume put -f` it back.

## 4. The owner's summary

One Telegram message through `POST https://kicksma.sh/api/admin/notify` with `Authorization: Bearer $CRON_SECRET` and
`{"text": "..."}`. Simplified Technical English, times in Thailand time (Asia/Bangkok), short:
- what was posted, where (the permalink), and when;
- what was skipped, and the row that failed;
- what waits (a reel too new, TikTok not built, a token that failed).
When nothing new came, send one line: "Social: no new reel today."
