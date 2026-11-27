"""What a reel from the whole film may claim: the score box, the winner of each point and the numbers, or none of them.

usage: honest.py <score, e.g. "6-3 6-2"> <points the sound found> [<points with a sure winner>]      (prints the verdict)

The owner's rule (27 November 2026): the score box, the winner of each point and the numbers of the score engine appear
only when the engine is sure. A score needs every point of the match with its winner. The sound gives an upper bound of
the points: every rally it heard in the whole film, warm-up and breaks included (`film_plan.js`, "rallies"). On the film
of 24 November 2026 the readers of the frames found 59 points in 99 candidates of a match whose 17 games need 68 at the
least (README, "The same reel from the whole film"). So, in this order:

  no_score     the match has no set score on its page: nothing to check the points against
  few_points   the sound found fewer points than the set scores need
  no_winners   the points can be there, but the job reads no sure winner for each of them (no step does yet)

When one of them holds, `strip` takes out of points.json what would claim a score: the card of numbers ("card"), the
score box ("score_box") and the winner of each point ("won"). reel.json keeps the code, and the match page says it in
one line (`NO_SCORE_LINE` in src/lib/domain/matchReel.ts). Pure, the standard library only.

The verdict has tiers (`tiers`), because the engine is sure of more than the point score (README, "The score is
counted backwards from what is sure"): a new server is a new game, and the typed set scores fix who won each game.
  sets_games   the sets and the games of the box, and the numbers that rest on games (stats.py: games in a row,
               breaks), when score_engine.py agrees with the typed score ("ok")
  points       a point score (15-30) only at the moments where score_rows.py gives one: every valid count of the
               game agrees there
  winners      a winner line only where the count forces the winner (the last point of a game, every point of a
               game of four: `stats.forced`) or where the detector is sure of it (winner.py, `SURE`)
`strip(points, tier)` takes out each claim whose tier is off, and nothing else. `verdict` stays as it was for the
callers that pass no count.
"""
import os, re, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import stats

SURE = 0.95      # the detector's chance of its winner at which a winner line may stand alone (winner.py measures it)

WHY = ('no_score', 'few_points', 'no_winners')


def sets_of(score):
    """The sets of a score as (a, b) games, or [] when it is not one: "6-3 6-2", "7-6 4-6 10-8". Pure."""
    out = []
    for part in str(score or '').split():
        m = re.fullmatch(r'(\d{1,2})-(\d{1,2})(\(\d{1,2}\))?', part)
        if not m: return []
        out.append((int(m.group(1)), int(m.group(2))))
    return out


def least_points(score):
    """The fewest points the set scores can be played in, or None for no score. A game is four points at least; a set
    of 7-6 adds a tie-break of seven points; a set past seven games is a match tie-break (10-8): its own points. Pure."""
    sets = sets_of(score)
    if not sets: return None
    n = 0
    for a, b in sets:
        if max(a, b) > 7: n += a + b                       # a match tie-break: the numbers are points
        elif {a, b} == {7, 6}: n += 4 * 12 + 7               # twelve games, then the tie-break
        else: n += 4 * (a + b)
    return n


def verdict(scores, found, sure_winners=0):
    """(shown, why, need) for the matches of a reel. `scores`: each match's set score; `found`: the points the sound
    found in the whole film (None: not counted, as for stretches a person chose); `sure_winners`: the points with a
    winner read for sure. Shown only when every match has a score, the sound found the points all of them need, and each
    needed point has a sure winner. Pure."""
    needs = [least_points(s) for s in scores]
    if not needs or any(n is None for n in needs): return False, 'no_score', None
    need = sum(needs)
    if found is not None and found < need: return False, 'few_points', need
    if sure_winners < need: return False, 'no_winners', need
    return True, None, need


def tiers(scores, found, engine=None, rows=None, detector=None, sure=SURE):
    """What a reel may claim, tier by tier. `engine`: the file of score_engine.py for the match (None: no count);
    `rows`: the file of score_rows.py for it; `detector`: {serve_t: (winner, chance)} of winner.py. ->
    {"sets_games": bool, "why": code or None, "need": points, "points": [serve_t with a point score],
    "winners": {serve_t: [winner, "forced" | "detector"]}}. A winner of the detector that the count contradicts is not
    shown. The codes of `why` are the three of `verdict`, so the line of the app stays the same. Pure."""
    def off(why, need): return {'sets_games': False, 'why': why, 'need': need, 'points': [], 'winners': {}}
    needs = [least_points(s) for s in scores]
    if not needs or any(n is None for n in needs): return off('no_score', None)
    need = sum(needs)
    if found is not None and found < need: return off('few_points', need)
    if not engine or not engine.get('ok'): return off('no_winners', need)
    won = {r['serve_t']: r['won'] for r in engine.get('points', []) if r.get('serve_t') is not None and not r.get('unseen')}
    sure_det = {t: w for t, (w, c) in (detector or {}).items() if c >= sure and won.get(t) == w}
    # what the count forces alone is "forced"; what it forces only with the sure winners of the detector rests on them
    person = {r['serve_t']: r['won'] for r in engine.get('points', []) if r.get('confidence') == 1.0 and not r.get('unseen')}
    winners = {t: [w, 'detector'] for t, w in stats.forced(engine, sure={**person, **sure_det}).items()}
    for t, w in stats.forced(engine, sure=person).items(): winners[t] = [w, 'forced']
    shown = sorted(r['serve_t'] for r in (rows or {}).get('points', []) if 'points' in (r.get('before') or {}))
    return {'sets_games': True, 'why': None, 'need': need, 'points': shown, 'winners': winners}


def strip(points, tier=None):
    """points.json without what claims a score: the card of numbers, the score box, the winner of each point. In
    place; answers what it took out. With `tier` (from `tiers`), only the claims whose tier is off: the box and the
    card stay when the sets and the games are sure, and a point keeps "won" only where its winner line may stand.
    Pure but for the change in place."""
    keep_box = bool(tier and tier.get('sets_games')); lines = (tier or {}).get('winners') or {}
    gone = [] if keep_box else [k for k in ('card', 'score_box') if points.pop(k, None) is not None]
    for p in points.get('points', []):
        if not isinstance(p, dict) or 'won' not in p: continue
        line = lines.get(p.get('serve_t'))
        if line is not None and line[0] == p['won']: continue
        p.pop('won'); gone.append(f"won:{p.get('id', '?')}")
    return gone


if __name__ == '__main__':
    print(verdict([sys.argv[1]], int(sys.argv[2]), int(sys.argv[3]) if len(sys.argv) > 3 else 0))
