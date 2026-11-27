"""What a reel could not do, and why: a short list of codes for reel.json, the report to Kicksmash and the match page.

The owner, 27 November 2026: under every reel, fast and full, the match page says what the reel could not do, why,
and what the player can do differently the next time they film. The job knows the why; the app holds the words
(`MISSING_COPY` in src/lib/domain/matchReel.ts, the fold "What this reel could not do"). So the job sends codes only,
in this order, each once:

  fast_by_design        a fast reel: no score, no winner of each point, no numbers and no fastest shot, by design
  no_score              a whole film: the match has no result on its page (honest.py)
  few_points            a whole film: the sound found fewer points than the set scores need (honest.py)
  no_winners            a whole film: no sure winner for each point (honest.py)
  no_speed              a whole film: no step measures the speed of a shot yet, so no fastest shot
  court_not_found       court_find.py was not sure of this film's court lines, so the job took the store's court of
                        the camera place, which may not fit this film (fastreel.py court_of, "source": "place")
  phone_moved           the same, and the finder's reason was "moved": the picture moved during the film
  players_out_of_frame  fast_points.py left a clip out because the tracker held its near pair too little
                        (`held_share`), or left a close look out because its player was not in the window
  far_names_unsure      who.py was not sure of the far names in a clip of the reel, so that clip has none
  no_heart_rate         no watch file came with the upload (uploads/<token>/hr.json)

The music and the crowd are the player's choices, never a thing missing. Pure, the standard library only.
"""

CODES = ('fast_by_design', 'no_score', 'few_points', 'no_winners', 'no_speed', 'court_not_found', 'phone_moved',
         'players_out_of_frame', 'far_names_unsure', 'no_heart_rate')
# What fast_points.py writes in points.json "left_out" when the players were not in the picture.
OUT_OF_FRAME = ('out_of_frame', 'closeup')


def missing_of(whole, score=None, points=None, clips=None, heart=False, court=None):
    """The codes of what the reel could not do, in the order of CODES. `whole`: the reel is from the whole film;
    `score`: honest.py's verdict as the job keeps it ({"shown", "why"}), or None; `points`: points.json; `clips`: the
    job's clips.json "clips" (each with "far_named"); `heart`: a watch file came with the upload; `court`: where the
    court lines came from (fastreel.py court_of: {"source": "request" | "found" | "place", "reason"}), or None. Pure."""
    out = set()
    if not whole: out.add('fast_by_design')
    else:
        out.add('no_speed')
        if score and not score.get('shown') and score.get('why') in CODES: out.add(score['why'])
    points = points or {}
    if any(isinstance(x, dict) and x.get('why') in OUT_OF_FRAME for x in points.get('left_out', [])): out.add('players_out_of_frame')
    kept = {p['id'] for p in points.get('points', []) if isinstance(p, dict) and isinstance(p.get('id'), str)}
    if any(f'c{n}' in kept and c.get('far_named') is False for n, c in enumerate(clips or [])): out.add('far_names_unsure')
    if not heart: out.add('no_heart_rate')
    if (court or {}).get('source') == 'place': out.add('phone_moved' if court.get('reason') == 'moved' else 'court_not_found')
    return [c for c in CODES if c in out]
