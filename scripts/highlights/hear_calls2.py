"""Listen for spoken scores before each point with a strong recogniser, two times: with a hint of score words and without.
usage: hear_calls2.py <audio.raw (mono f32le 48 kHz)> <audio.json> <out.json> [model=large-v3-turbo] [seconds before=12]
A hint makes the recogniser better at the words, and also more ready to invent them in noise. So a call counts only when
both passes give score words for the same window."""
import sys, json, re, numpy as np
from faster_whisper import WhisperModel
raw, af, out = sys.argv[1:4]; size = sys.argv[4] if len(sys.argv) > 4 else 'large-v3-turbo'; before = float(sys.argv[5]) if len(sys.argv) > 5 else 12.0
A = json.load(open(af)); SR = 48000; mm = np.memmap(raw, np.float32, 'r')
m = WhisperModel(size, device='cpu', compute_type='int8', cpu_threads=4)
HINT = 'Score? Fifteen love. Thirty fifteen. Fifteen forty. Forty thirty. Thirty all. Deuce. Advantage. Five five. Four three. Love four.'
NUM = r'(love|zero|fifteen|thirty|forty|deuce|advantage|\ball\b|score|one|two|three|four|five|six|seven|\d+)'
PAIR = re.compile(NUM + r'[\s,\-–:]+' + NUM, re.I)
res = []
for i, p in enumerate(A['points']):
    a, b = max(0.0, p['firstHit'] - before), p['firstHit'] + 0.4
    x = np.array(mm[int(a * SR):int(b * SR)])[::3].astype(np.float32); x = np.clip(x / (np.percentile(np.abs(x), 99.7) + 1e-9) * 0.6, -1, 1)
    row = {'point': i, 't': p['firstHit']}
    for name, hint in (('plain', None), ('hint', HINT)):
        segs, _ = m.transcribe(x, language='en', beam_size=5, condition_on_previous_text=False, vad_filter=False, initial_prompt=hint, no_speech_threshold=0.6)
        row[name] = [(round(a + s.start, 1), s.text.strip(), round(float(np.exp(s.avg_logprob)), 2), round(s.no_speech_prob, 2)) for s in segs]
    tp = ' '.join(t[1] for t in row['plain']); th = ' '.join(t[1] for t in row['hint'])
    row['call'] = bool(PAIR.search(tp)) and bool(PAIR.search(th)); res.append(row)
    print(f"{i:3d} {int(p['firstHit'] // 60)}:{p['firstHit'] % 60:04.1f} {'CALL ' if row['call'] else '     '}plain: {tp[:70]!r}  hint: {th[:70]!r}", flush=True)
    json.dump(res, open(out, 'w'))
print('points', len(res), 'calls in both passes', sum(1 for r in res if r['call']))
