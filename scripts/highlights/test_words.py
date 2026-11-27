"""Tests of the pure parts of words.py on words made by hand. Plain asserts.

usage: python3 scripts/highlights/test_words.py        (prints "ok" and the number of checks, or fails at the first)
"""
import os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import words

n = 0


def check(cond, what):
    global n
    assert cond, what
    n += 1


DEAD = 100.0
said = [(99.0, 'early', 'word'), (100.2, 'Sorry!', 'word'), (101.0, 'Yes,', 'word'), (102.0, '[laughs]', 'audio_event'),
        (103.0, 'out', 'word'), (105.5, 'late', 'word'), (108.0, 'gone', 'word')]
c = words.counts(said, DEAD, DEAD + 5.0)
check(c['regret'] == 1 and c['cheer'] == 1 and c['call'] == 1 and c['laugh'] == 1, f'one of each class {c}')
check(c['talk6'] == 5, f'talk6 counts words and sounds from 0.5 s before to 6 s after: {c}')
check(words.counts(said, DEAD, DEAD + 0.5)['cheer'] == 0, 'a word after `until` is not in a class')

# the near recorder (left, offset -10 s) hears "sorry" two times, the far one (right, offset +5 s) one time
W = {'left': [(90.3, 'sorry', 'word'), (91.0, 'no', 'word')], 'right': [(105.4, 'sorry', 'word')]}
off = {'left': -10.0, 'right': 5.0}
v = words.votes(W, off, DEAD, DEAD + 5.0, 1)
check(v['regret'] == -1, f'the near half (pair 1) said more regret words: a vote for pair 1 {v}')
check(words.votes(W, off, DEAD, DEAD + 5.0, 0)['regret'] == 1, 'the same with pair 0 in the near half')
check(v['cheer'] == 0 and v['call'] == 0, f'no word of a class on either side: no vote {v}')
check(words.votes({'left': [], 'right': []}, off, DEAD, DEAD + 5.0, 0) == {k: 0 for k in words.VOTESW}, 'nothing heard: no vote')
check(words.clean('"Let\'s!') == "let's" and words.CLASSES['cheer'].match("let's"), 'clean keeps the apostrophe')
print('ok', n, 'checks')
