"""The words of the two recorders around each dead ball, with whisper on the Mac (mlx-whisper; improvement 3 of the Mac
lab, issue 374).

usage: hear_words.py <feats.json of winner.py> <phone.json of tx_phone.py> <left.wav> <right.wav> <out.json>
                     [model=mlx-community/whisper-large-v3-turbo] [before=1.0] [after=15.0]

The WAVs are each recorder's files joined in order, mono 16 kHz, 16 bit (the clock of Scribe's words). A point's window
is from `before` s before the dead ball to the next serve + 0.3 s, and never longer than `after` s after the dead ball,
so the score call of the server before the next point is inside it. Recorder time = film time + offset_s (phone.json).
Each window is read alone (no text of the window before), and the quiet is not cut away: whisper sees the whole window.
A text that comes again in the same window is kept one time.

whisper invents text in near quiet ("Thanks for watching!"). A segment is kept only when its no_speech_prob is 0.6 or
less, its mean log chance is -1.0 or more, and its text is not one of the known inventions (INVENTED). The file keeps
how loud the segment is against the window's quiet (its RMS / the 20th percentile of the window's 50 ms frames): real
calls on match2 were often only 1.1 to 1.5 times the quiet, so it is not a filter.
Out: {model, windows: [{serve_t, dead_t, a, b, left: [[t, text, avg_logprob, no_speech_prob, rms ratio]], right: [...]}]}
with t in film time. On match2 it takes 34 min for 182 windows on an M3 Max, and it hears much less than Scribe:
words.py has the numbers.
"""
import json, os, re, sys, time, wave
import numpy as np

INVENTED = re.compile(r"thanks? (you )?for watching|subtitles? by|subscribe|amara\.org|^\W*(thank you|you|bye)\W*$|^\W*$", re.I)


def read(path):
    w = wave.open(path); assert w.getframerate() == 16000 and w.getnchannels() == 1 and w.getsampwidth() == 2
    return np.frombuffer(w.readframes(w.getnframes()), np.int16)


def frames_rms(x, n=800):
    k = len(x) // n
    return np.sqrt((x[:k * n].reshape(k, n).astype(np.float64) ** 2).mean(1)) if k else np.zeros(1)


def keep(seg, x, a):
    """True for a segment of real speech (see the docstring); and the RMS ratio of the segment to the window's quiet."""
    if seg['no_speech_prob'] > 0.6 or seg['avg_logprob'] < -1.0 or INVENTED.search(seg['text'].strip()): return False, 0.0
    f = frames_rms(x); quiet = np.percentile(f, 20) + 1.0
    s = x[int(max(0.0, seg['start']) * 16000):int(seg['end'] * 16000)]
    r = float(np.sqrt((s.astype(np.float64) ** 2).mean()) / quiet) if len(s) else 0.0
    return True, r


if __name__ == '__main__':
    import mlx_whisper
    ff, pf, lw, rw, of = sys.argv[1:6]
    model = sys.argv[6] if len(sys.argv) > 6 else 'mlx-community/whisper-large-v3-turbo'
    before = float(sys.argv[7]) if len(sys.argv) > 7 else 1.0; after = float(sys.argv[8]) if len(sys.argv) > 8 else 15.0
    rows = sorted(json.load(open(ff)), key=lambda r: r['serve_t']); P = json.load(open(pf))
    audio = {'left': read(lw), 'right': read(rw)}; off = {s: P[s]['offset_s'] for s in audio}
    out = {'model': model, 'before': before, 'after': after, 'windows': []}; t0 = time.time()
    for i, r in enumerate(rows):
        nxt = rows[i + 1]['serve_t'] if i + 1 < len(rows) else r['dead_t'] + after
        a, b = r['dead_t'] - before, min(r['dead_t'] + after, nxt + 0.3)
        win = {'serve_t': r['serve_t'], 'dead_t': r['dead_t'], 'a': round(a, 2), 'b': round(b, 2)}
        for s, x in audio.items():
            i0, i1 = int((a + off[s]) * 16000), int((b + off[s]) * 16000)
            if i0 < 0 or i1 > len(x): win[s] = None; continue
            clip = x[i0:i1]; f = clip.astype(np.float32) / 32768.0
            # word times and the silence guard stop the loops ("I have a look, I have a look, ...") that whisper
            # makes in this noise; a louder copy of the clip (the quiet voices up) made more loops, not more words
            res = mlx_whisper.transcribe(f, path_or_hf_repo=model, language='en', condition_on_previous_text=False, verbose=None,
                                         word_timestamps=True, hallucination_silence_threshold=1.0, no_speech_threshold=0.5)
            segs, seen = [], set()
            for g in res['segments']:
                ok, ratio = keep(g, clip, a)
                if ok and g['text'].strip().lower() not in seen:
                    seen.add(g['text'].strip().lower())
                    segs.append([round(a + g['start'], 2), g['text'].strip(), round(g['avg_logprob'], 2), round(g['no_speech_prob'], 2), round(ratio, 1)])
            win[s] = segs
        out['windows'].append(win)
        print(f"{i:3d} {r['serve_t']:7.1f} L: {' | '.join(s[1] for s in win['left'] or [])[:60]!r}  R: {' | '.join(s[1] for s in win['right'] or [])[:60]!r}", flush=True)
        json.dump(out, open(of, 'w'))
    print('windows', len(out['windows']), 'seconds', round(time.time() - t0))
