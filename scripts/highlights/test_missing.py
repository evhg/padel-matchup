"""Tests of missing.py: the codes of what a reel could not do, on plans made by hand. Plain asserts, the standard library only.

usage: python3 scripts/highlights/test_missing.py        (prints "ok" and the number of checks, or fails at the first)
"""
import os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import missing, honest

CHECKS = 0


def check(cond, what):
    global CHECKS
    assert cond, what
    CHECKS += 1


def plan(*ids, left=()):
    """points.json in the shape of fast_points.py: an opening, the kept clips, and what it left out."""
    return {'points': [{'file': 'versus-m1-wide.mp4'}] + [{'id': i, 'title': 'Long rally'} for i in ids], 'left_out': list(left)}


FAR = [{'a': 0, 'b': 20, 'far_named': True}, {'a': 20, 'b': 40, 'far_named': True}, {'a': 40, 'b': 60, 'far_named': True}]

# a fast reel, all well, with a watch: it says only what it lacks by design
got = missing.missing_of(False, None, plan('c0', 'c1', 'c2'), FAR, heart=True)
check(got == ['fast_by_design'], f'a good fast reel {got}')
# the same without a watch
got = missing.missing_of(False, None, plan('c0', 'c1', 'c2'), FAR)
check(got == ['fast_by_design', 'no_heart_rate'], f'no watch {got}')

# a fast reel never says why it has no score: the score is not its promise
got = missing.missing_of(False, {'shown': False, 'why': 'few_points'}, plan('c0'), FAR, heart=True)
check(got == ['fast_by_design'], f'a fast reel and a verdict {got}')

# a whole film: the verdict's code, and no fastest shot, which no step measures yet
for why in honest.WHY:
    got = missing.missing_of(True, {'shown': False, 'why': why, 'found': 59, 'need': 68}, plan('c0'), FAR, heart=True)
    check(got == [why, 'no_speed'], f'the whole film without a score: {why} {got}')
got = missing.missing_of(True, {'shown': True, 'why': None}, plan('c0'), FAR, heart=True)
check(got == ['no_speed'], f'a whole film with its score {got}')
# every reason honest.py can give is a code of missing.py
check(all(w in missing.CODES for w in honest.WHY), 'honest.WHY inside missing.CODES')

# players out of the picture: a clip left out by held_share, or a close look left out
got = missing.missing_of(False, None, plan('c0', 'c2', left=[{'id': 'c1', 'why': 'out_of_frame'}]), FAR, heart=True)
check(got == ['fast_by_design', 'players_out_of_frame'], f'a clip left out {got}')
got = missing.missing_of(False, None, plan('c0', 'c1', 'c2', left=[{'id': 'c1', 'why': 'closeup'}]), FAR, heart=True)
check(got == ['fast_by_design', 'players_out_of_frame'], f'a close look left out {got}')
# a clip with no rally in its sound is not a promise missed
got = missing.missing_of(False, None, plan('c0', 'c2', left=[{'id': 'c1', 'why': 'no_rally'}]), FAR, heart=True)
check(got == ['fast_by_design'], f'no rally {got}')

# far names: only a clip that is in the reel counts
far = [dict(FAR[0]), dict(FAR[1], far_named=False), dict(FAR[2])]
got = missing.missing_of(False, None, plan('c0', 'c1', 'c2'), far, heart=True)
check(got == ['fast_by_design', 'far_names_unsure'], f'a kept clip with no far names {got}')
got = missing.missing_of(False, None, plan('c0', 'c2', left=[{'id': 'c1', 'why': 'out_of_frame'}]), far, heart=True)
check(got == ['fast_by_design', 'players_out_of_frame'], f'the clip with no far names is not in the reel {got}')
# an older clips.json, with no "far_named", is not a name left out
got = missing.missing_of(False, None, plan('c0'), [{'a': 0, 'b': 20}], heart=True)
check(got == ['fast_by_design'], f'no far_named key {got}')

# the court lines (fastreel.py court_of): found in the film, or drawn by a person, is not a thing missing
for src in ({'source': 'found', 'confidence': 0.9}, {'source': 'request'}, None):
    got = missing.missing_of(False, None, plan('c0'), FAR, heart=True, court=src)
    check(got == ['fast_by_design'], f'court {src} {got}')
# the finder was not sure, so the store's court of the place: the reel says so, and "moved" has its own reason
for reason in ('lines_not_found', 'walls_not_found', 'fit_poor', 'camera_implausible', 'too_few_frames', 'failed', None):
    got = missing.missing_of(False, None, plan('c0'), FAR, heart=True, court={'source': 'place', 'reason': reason})
    check(got == ['fast_by_design', 'court_not_found'], f'place court, {reason} {got}')
got = missing.missing_of(False, None, plan('c0'), FAR, heart=True, court={'source': 'place', 'reason': 'moved'})
check(got == ['fast_by_design', 'phone_moved'], f'place court, moved {got}')

# everything at once: each code once, in the order of CODES
got = missing.missing_of(True, {'shown': False, 'why': 'no_winners'}, plan('c1', left=[{'id': 'c0', 'why': 'out_of_frame'}, {'id': 'c1', 'why': 'closeup'}]), far,
                         court={'source': 'place', 'reason': 'moved'})
check(got == ['no_winners', 'no_speed', 'phone_moved', 'players_out_of_frame', 'far_names_unsure', 'no_heart_rate'], f'all of them {got}')
check(got == [c for c in missing.CODES if c in got], 'the order of CODES')
# a made-up verdict code is not passed on
got = missing.missing_of(True, {'shown': False, 'why': '<b>made up</b>'}, plan('c0'), FAR, heart=True)
check(got == ['no_speed'], f'a made-up code {got}')
# nothing known: a fast reel with no plan says what it can
check(missing.missing_of(False) == ['fast_by_design', 'no_heart_rate'], 'no plan, no clips')

print('ok', CHECKS, 'checks')
