"""Find where people speak in the match (a voice detector with a low threshold), then transcribe only those parts, with no hint.
usage: hear_voice.py <audio.raw (mono f32le 48 kHz)> <out.json> [threshold=0.25] [model=large-v3-turbo] [most segments=120]"""
import sys, json, re, time, numpy as np
from faster_whisper import WhisperModel
from faster_whisper.vad import get_speech_timestamps, VadOptions
raw, out = sys.argv[1:3]; thr = float(sys.argv[3]) if len(sys.argv) > 3 else 0.25; size = sys.argv[4] if len(sys.argv) > 4 else 'large-v3-turbo'; most = int(sys.argv[5]) if len(sys.argv) > 5 else 120
mm = np.memmap(raw, np.float32, 'r'); SR = 48000; CH = 300; t0 = time.time(); segs = []
for c in range(0, len(mm) // SR, CH):
    x = np.array(mm[c * SR:(c + CH) * SR])[::3].astype(np.float32)
    # the voices are faint: bring the quiet parts up, block by block (a ball on the glass is 30 dB louder than a voice)
    n = 1600; k = len(x) // n; blk = x[:k * n].reshape(k, n); g = 0.05 / (np.sqrt((blk ** 2).mean(1)) + 1e-4); g = np.clip(g, 0.5, 30); x[:k * n] = (blk * g[:, None]).reshape(-1); x = np.clip(x, -1, 1)
    for s in get_speech_timestamps(x, VadOptions(threshold=thr, min_speech_duration_ms=350, min_silence_duration_ms=300, speech_pad_ms=250)):
        segs.append((c + s['start'] / 16000, c + s['end'] / 16000))
print('voice parts', len(segs), 'seconds of voice', round(sum(b - a for a, b in segs)), 'found in', round(time.time() - t0), 's', flush=True)
segs.sort(key=lambda s: -(s[1] - s[0])); pick = sorted(segs[:most]); m = WhisperModel(size, device='cpu', compute_type='int8', cpu_threads=4); res = []
NUM = r'(love|zero|fifteen|thirty|forty|deuce|advantage|\ball\b|score|one|two|three|four|five|six|seven|\d+)'; PAIR = re.compile(NUM + r'[\s,\-–:]+' + NUM, re.I)
for a, b in pick:
    a2, b2 = max(0, a - 0.4), b + 0.4; x = np.array(mm[int(a2 * SR):int(b2 * SR)])[::3].astype(np.float32); x = np.clip(x / (np.percentile(np.abs(x), 99.5) + 1e-9) * 0.6, -1, 1)
    sg, _ = m.transcribe(x, language='en', beam_size=5, condition_on_previous_text=False, vad_filter=False)
    txt = ' '.join(s.text.strip() for s in sg); res.append({'t0': round(a, 1), 't1': round(b, 1), 'text': txt, 'score': bool(PAIR.search(txt) or re.search(r'\bscore\b', txt, re.I))})
    print(f"{int(a // 60)}:{a % 60:04.1f} ({b - a:4.1f} s) {'SCORE ' if res[-1]['score'] else '      '}{txt[:110]}", flush=True)
    json.dump(res, open(out, 'w'))
print('parts heard', len(res), 'with score words', sum(1 for r in res if r['score']))
