"""Listen to the seconds before each point for a spoken score ("thirty fifteen"), with the recogniser.
usage: hear_calls.py <audio.raw (mono f32le 48 kHz)> <audio.json> <out.json> [model=small]"""
import sys, json, re, numpy as np
from faster_whisper import WhisperModel
raw, af, out = sys.argv[1:4]; size = sys.argv[4] if len(sys.argv) > 4 else 'small'
A = json.load(open(af)); SR = 48000
mm = np.memmap(raw, np.float32, 'r')
m = WhisperModel(size, device='cpu', compute_type='int8', cpu_threads=2)
WORDS = r'\b(love|fifteen|thirty|forty|deuce|advantage|all|game|set|zero|quince|treinta|cuarenta|iguales|ventaja|punto de oro|golden point|[0-9]+[ -][0-9]+)\b'
res = []
for i, p in enumerate(A['points']):
    a, b = max(0.0, p['firstHit'] - 10.0), p['firstHit'] + 0.3
    x = np.array(mm[int(a * SR):int(b * SR)]); x = x[::3].copy()                 # 16 kHz (the speech band is far below the fold)
    pk = np.percentile(np.abs(x), 99.5) + 1e-6; x = np.clip(x / pk * 0.5, -1, 1)   # quiet voices up; a ball bounce may clip
    segs, _ = m.transcribe(x, language='en', beam_size=5, condition_on_previous_text=False, vad_filter=False)
    txt = [(round(a + s.start, 1), s.text.strip(), round(float(np.exp(s.avg_logprob)), 2), round(s.no_speech_prob, 2)) for s in segs]
    hit = [t for t in txt if re.search(WORDS, t[1].lower())]
    res.append({'point': i, 't': p['firstHit'], 'heard': txt, 'score_words': hit})
    print(f"{int(p['firstHit'] // 60)}:{p['firstHit'] % 60:04.1f}", ' | '.join(f"{t[1]} ({t[2]})" for t in txt)[:150], '   <<< SCORE WORDS' if hit else '', flush=True)
json.dump(res, open(out, 'w'))
print('points', len(res), 'with any speech', sum(1 for r in res if r['heard']), 'with score words', sum(1 for r in res if r['score_words']))
