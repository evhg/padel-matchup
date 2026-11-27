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
"""
import re, sys

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


def strip(points):
    """points.json without what claims a score: the card of numbers, the score box, the winner of each point. In
    place; answers what it took out. Pure but for the change in place."""
    gone = [k for k in ('card', 'score_box') if points.pop(k, None) is not None]
    for p in points.get('points', []):
        if isinstance(p, dict) and p.pop('won', None) is not None: gone.append(f"won:{p.get('id', '?')}")
    return gone


if __name__ == '__main__':
    print(verdict([sys.argv[1]], int(sys.argv[2]), int(sys.argv[3]) if len(sys.argv) > 3 else 0))
