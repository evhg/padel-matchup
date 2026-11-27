"""The speed of a shot that may be shown: a strict gate on the timed flights of flight.py (issue 374, step 3).

usage: speed.py <flight.json of flight.py> [fps=59.94]     (prints the kept shots, the fastest first)

flight.py times a flight from the first picture of its ball chain to the bounce or to the next person. Against a
reader who named the contact picture and the end picture of the 40 fastest timed shots of match2 (27 November 2026,
the Mac lab), most fast "shots" were wrong:
  - 22 of 40 have no reader speed: 16 are not a shot (a ball bounced or caught between points, a ball that passes a
    player, a juggle), 6 are a shot whose contact or end the pictures do not show.
  - Of the 18 with a reader speed, 9 are within 10%. The near overheads are the worst: the far end of the flight is a
    ball a few pixels high, and the fit puts it on the ground behind the far player (code 67 km/h, reader 42 km/h)
    or ends it at the wrong person (code 114, reader 75).
The gate keeps a flight only when all of these are true:
  far       the hitter is in the far half (start y over 10 m): the ball comes to the camera and grows, so both ends
            are seen well
  rel       the fit error is 0.10 or less
  seen      the ball is seen in 92% or more of the flight's pictures (n over seconds x fps + 1)
  speed     30 to 160 km/h
It was chosen on the 20 even shots of the 40 and measured once on the 20 odd shots. Chosen half: it keeps 3, all
within 10% of the reader (+8.4%, -1.6%, -1.9%). Measured half: it keeps 3; 2 are within 10% (+4.2%, -1.0%), the
third is a real shot whose contact the pictures do not show. Whole match (the flight.py run of winner.py's votes):
78 timed flights, 6 kept, the fastest 54.2 km/h (reader 50.0). Another flight.py setting (109 timed flights) keeps a
far shot of 117 km/h that no reader checked: measure again before the gate takes the flights of another setting.
The gate drops every near smash: the fastest shot it shows is a firm far drive, not the fastest shot of the match.
"""
import json, sys

FAR_Y, REL, SEEN, LO, HI = 10.0, 0.10, 0.92, 30.0, 160.0


def seen(f, fps=59.94):
    """The part of the flight's pictures in which the ball is seen. Pure."""
    return f['n'] / max(1, round(f['seconds'] * fps) + 1)


def kept(f, fps=59.94):
    """True when the speed of one timed flight of flight.py may be shown. Pure."""
    if 'kmh' not in f or not f.get('hitter'): return False
    return f['start'][1] > FAR_Y and f['rel'] <= REL and seen(f, fps) >= SEEN and LO <= f['kmh'] <= HI


def shots(flights, fps=59.94):
    """[(point, flight)] of the kept flights of a whole match, the fastest first. flights: {point: [flight]}. Pure."""
    return sorted(((p, f) for p, fl in flights.items() for f in fl if kept(f, fps)), key=lambda pf: -pf[1]['kmh'])


if __name__ == '__main__':
    F = json.load(open(sys.argv[1])); fps = float(sys.argv[2]) if len(sys.argv) > 2 else 59.94
    k = shots(F, fps); n = sum(1 for fl in F.values() for f in fl if 'kmh' in f)
    print(f'{n} timed flights, {len(k)} kept')
    for p, f in k: print(f"  {p} at {f['t0']:.2f} s: {f['kmh']} km/h, {f['to_what']}, rel {f['rel']}, seen {seen(f, fps):.2f}")
