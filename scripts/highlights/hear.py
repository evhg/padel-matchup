"""Hear a sound file: the words (speech recognition) with their times.
usage: hear.py <audio or video> <out.json> [model=small] [language] [t0 t1]"""
import sys, os, json, subprocess, numpy as np
from faster_whisper import WhisperModel
src, out = sys.argv[1], sys.argv[2]; size = sys.argv[3] if len(sys.argv) > 3 else 'small'; lang = sys.argv[4] if len(sys.argv) > 4 and sys.argv[4] != '-' else None
t0 = float(sys.argv[5]) if len(sys.argv) > 5 else 0.0; t1 = float(sys.argv[6]) if len(sys.argv) > 6 else None
cmd = ['ffmpeg', '-v', 'error', '-nostdin', '-ss', f'{t0}'] + (['-t', f'{t1 - t0}'] if t1 else []) + ['-i', src, '-map', '0:a:0'] + (['-af', os.environ['AF']] if os.environ.get('AF') else []) + ['-ac', '1', '-ar', '16000', '-f', 'f32le', '-']
a = np.frombuffer(subprocess.run(cmd, capture_output=True, check=True).stdout, np.float32)
m = WhisperModel(size, device='cpu', compute_type='int8', cpu_threads=4)
segs, info = m.transcribe(a, language=lang, vad_filter=os.environ.get('VAD', '1') == '1', vad_parameters=dict(min_silence_duration_ms=400), word_timestamps=True, condition_on_previous_text=False, beam_size=5)
res = []
for s in segs:
    res.append({'t0': round(t0 + s.start, 2), 't1': round(t0 + s.end, 2), 'text': s.text.strip(), 'p': round(float(np.exp(s.avg_logprob)), 2), 'nospeech': round(s.no_speech_prob, 2),
                'words': [[round(t0 + w.start, 2), w.word.strip(), round(w.probability, 2)] for w in (s.words or [])]})
    print(f"{int((t0 + s.start) // 60)}:{(t0 + s.start) % 60:05.2f}  {res[-1]['p']:.2f}  {s.text.strip()}", flush=True)
json.dump({'language': info.language, 'language_p': round(info.language_probability, 2), 'segments': res}, open(out, 'w'))
print('language', info.language, round(info.language_probability, 2))
