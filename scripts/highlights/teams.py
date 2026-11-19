"""A team with no name gets one from the names of its two players.

The owner's rule (19 November 2026): the first letter of one player, then the name of the other. The other is the
player whose name starts with a vowel; with no such name (or two), it is the longer name, without the consonants
it starts with. Nora and Emil are "Nemil"; Tom and Nadia are "Tadia"; Mia and Albert are "Malbert".

    python teams.py          checks the rule on those examples
"""
VOWELS = 'aeiou'


def blend(a, b):
    a, b = a.strip(), b.strip()
    if len(a) < 2 or len(b) < 2: return ''
    av, bv = a[0].lower() in VOWELS, b[0].lower() in VOWELS
    if bv and not av: lead, body = a, b
    elif av and not bv: lead, body = b, a
    else: lead, body = (a, b) if len(b) >= len(a) else (b, a)
    i = 0
    while i < len(body) and body[i].lower() not in VOWELS: i += 1
    tail = body[i:] if i < len(body) - 1 else body
    return lead[0].upper() + tail.lower()


def fill(match):
    """match.json as a dict: "team_a" and "team_b" are set from "names" and "team" where they are missing."""
    names, team = match.get('names'), match.get('team')
    if not isinstance(names, dict) or not isinstance(team, dict): return match
    for side, key in ((0, 'team_a'), (1, 'team_b')):
        if match.get(key): continue
        two = [names[k] for k in sorted(names) if team.get(k) == side and isinstance(names[k], str)]
        if len(two) == 2 and blend(*two): match[key] = blend(*two)
    return match


if __name__ == '__main__':
    for a, b, want in (('Nora', 'Emil', 'Nemil'), ('Emil', 'Nora', 'Nemil'), ('Tom', 'Nadia', 'Tadia'), ('Mia', 'Albert', 'Malbert'),
                       ('Stefan', 'Bo', 'Befan'), ('Ana', 'Olivia', 'Aolivia'), ('A', 'Bea', '')):
        assert blend(a, b) == want, (a, b, blend(a, b), want)
    m = fill({'names': {'0': 'Nora', '1': 'Tom', '2': 'Nadia', '3': 'Emil'}, 'team': {'0': 0, '1': 1, '2': 1, '3': 0}, 'team_b': 'Given'})
    assert m['team_a'] == 'Nemil' and m['team_b'] == 'Given', m
    print('TEAMS_OK')
