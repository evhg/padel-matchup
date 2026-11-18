"""One page where a person says if the written speech is right: a sound clip, two versions of the text, four buttons.

usage: speech_check_page.py <left_dir> <right_dir> <offset_s> <start in right, s> <cmp_dir> <clips.json> <out.html>
clips.json: [{"side": "R"|"L", "t0": s, "t1": s}] with times inside the window of tx_compare.py.
The page needs no account and no network. It gives the answers as one line of text to copy.
"""
import sys, glob, json, base64, subprocess, html, soundfile as sf
ld, rd, off, r0, cmp_dir, clipf, out = sys.argv[1], sys.argv[2], float(sys.argv[3]), float(sys.argv[4]), sys.argv[5], sys.argv[6], sys.argv[7]
NORM = 'highpass=f=150,lowpass=f=6000,dynaudnorm=f=200:g=15:p=0.9:m=40'
def mp3(d, t0, dur):
    fs = sorted(x for x in glob.glob(d + '/*.WAV') if sf.info(x).duration > 20); base = 0.0
    for f in fs:
        n = sf.info(f).duration
        if base <= t0 < base + n:
            return subprocess.run(['ffmpeg', '-v', 'error', '-nostdin', '-ss', f'{t0 - base}', '-t', f'{dur}', '-i', f, '-af', NORM, '-ar', '24000', '-ac', '1', '-b:a', '64k', '-f', 'mp3', '-'], capture_output=True, check=True).stdout
        base += n
def text(m, side, a, b):
    j = json.load(open(f'{cmp_dir}/{m}-{side}.json'))
    return ' '.join(l['text'] for l in j['lines'] if a - 0.6 <= l['t0'] <= b and l['t1'] - l['t0'] < 25) or '(nothing)'
items = []
for k, c in enumerate(json.load(open(clipf))):
    start = (r0 if c['side'] == 'R' else r0 - off) + c['t0'] - 1.0; dur = c['t1'] - c['t0'] + 2.0
    items.append({'n': k + 1, 'side': 'right' if c['side'] == 'R' else 'left', 'a': text('A', c['side'], c['t0'], c['t1']), 'b': text('B', c['side'], c['t0'], c['t1']),
                  'src': 'data:audio/mpeg;base64,' + base64.b64encode(mp3(rd if c['side'] == 'R' else ld, start, dur)).decode()})
rows = ''.join(f'''<section class="clip" data-n="{i['n']}"><h2><b>{i['n']}</b> {i['side']} transmitter</h2><audio controls preload="metadata" src="{i['src']}"></audio>
<p class="t"><span>First text</span>{html.escape(i['a'])}</p><p class="t"><span>Second text</span>{html.escape(i['b'])}</p>
<div class="pick"><button data-v="1">First is right</button><button data-v="2">Second is right</button><button data-v="X">Both are wrong</button><button data-v="N">Not our court</button></div>
<input type="text" id="said-{i['n']}" placeholder="What they said (optional)" autocomplete="off"></section>''' for i in items)
page = f'''<title>Speech Check</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
:root{{color-scheme:dark;--ink:#14161a;--card:#20262e;--line:#3a424d;--lime:#c8f135;--soft:#a9b2bf;--on:#fff}}
*{{box-sizing:border-box}}html,body{{margin:0}}body{{background:var(--ink);color:var(--on);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif;line-height:1.45;padding-block:18px 40px;padding-left:max(16px,env(safe-area-inset-left,0px));padding-right:max(16px,env(safe-area-inset-right,0px))}}
main{{max-width:680px;margin:0 auto;display:flex;flex-direction:column;gap:16px}}h1{{font-size:24px;margin:0}}.sub{{color:var(--soft);margin:0;font-size:15px}}
.clip{{background:var(--card);border-radius:14px;padding:14px;display:flex;flex-direction:column;gap:10px}}.clip h2{{font-size:15px;margin:0;color:var(--soft);font-weight:600}}.clip h2 b{{color:var(--lime);font-size:20px;margin-right:6px}}
audio{{width:100%}}.t{{margin:0;font-size:16px}}.t span{{display:block;font-size:12px;letter-spacing:.06em;text-transform:uppercase;color:var(--soft)}}
.pick{{display:grid;grid-template-columns:1fr 1fr;gap:8px}}button{{font:inherit;font-weight:700;font-size:15px;border:1px solid var(--line);background:var(--ink);color:var(--on);border-radius:10px;padding:12px 6px;cursor:pointer}}
button.on{{background:var(--lime);color:var(--ink);border-color:var(--lime)}}button:focus-visible,input:focus-visible,textarea:focus-visible{{outline:3px solid #fff;outline-offset:2px}}
input,textarea{{font:inherit;width:100%;background:var(--ink);color:var(--on);border:1px solid var(--line);border-radius:10px;padding:10px}}textarea{{height:110px;font:14px ui-monospace,Menlo,monospace}}
#copy{{background:var(--lime);color:var(--ink);border-color:var(--lime)}}
</style>
<main><h1>Is the written speech right?</h1>
<p class="sub">Play each clip. Tap the button that is true. If you know the words, type them. {len(items)} clips, about three minutes. The sound is made even in loudness, so hits are less loud than in reality.</p>
{rows}
<section class="clip"><h2>Copy this line and send it in the chat</h2><textarea id="res" readonly></textarea><div class="pick"><button id="copy">Copy</button><span class="sub" id="copied"></span></div></section></main>
<script>
const ans = {{}};
function line() {{ document.getElementById('res').value = 'Speech check: ' + [...document.querySelectorAll('.clip[data-n]')].map((c) => {{ const n = c.dataset.n, s = document.getElementById('said-' + n).value.trim(); return n + (ans[n] || '?') + (s ? ' "' + s.replace(/"/g, "'") + '"' : ''); }}).join(' | '); }}
document.querySelectorAll('.clip[data-n]').forEach((c) => {{ c.querySelectorAll('button').forEach((b) => b.onclick = () => {{ ans[c.dataset.n] = b.dataset.v; c.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b)); line(); }}); c.querySelector('input').oninput = line; }});
document.getElementById('copy').onclick = () => {{ const t = document.getElementById('res'); t.select(); (navigator.clipboard ? navigator.clipboard.writeText(t.value) : Promise.reject()).then(() => {{ document.getElementById('copied').textContent = 'Copied.'; }}).catch(() => {{ try {{ document.execCommand('copy'); document.getElementById('copied').textContent = 'Copied.'; }} catch (e) {{ document.getElementById('copied').textContent = 'Select the line and copy it by hand.'; }} }}); }};
line();
</script>
'''
open(out, 'w').write(page); print('clips', len(items), 'bytes', len(page))
