"""One page to say who won each point: a short clip of each point, one tap for the pair that won it.
usage: label_page.py <clips_dir with 01.mp4 ...> <cands.json> <match.json> <out.html> [page title]
The page holds the clips inside itself, needs no network, and gives the answers as one line of text to copy.
With LINKED=1 the page points at clips/001.mp4, clips/002.mp4, ... beside it (the names label_clips.py gives):
a match with hundreds of points is too large for one file. The answers stay in the browser, so a person can
stop and go on later."""
import sys, os, json, base64, subprocess, glob, html
clips, candf, matchf, out = sys.argv[1:5]
import teams
C = json.load(open(candf)); MT = teams.fill(json.load(open(matchf))); ta = MT.get('team_a') or MT['pair_a']; tb = MT.get('team_b') or MT['pair_b']
items = []
LINKED = os.environ.get('LINKED')
for c in C:
    if LINKED:
        e = c['end']; items.append({'n': c['i'] + 1, 'at': f"{int(e // 60)}:{int(e % 60):02d}", 'src': f"clips/{c['i'] + 1:03d}.mp4"}); continue
    n = c['i'] + 1; src = f'{clips}/{n:02d}.mp4'; small = f'{clips}/s{n:02d}.mp4'
    if not os.path.exists(small):
        subprocess.run(['ffmpeg', '-v', 'error', '-nostdin', '-y', '-i', src, '-vf', 'scale=640:360', '-c:v', 'libx264', '-preset', 'slow', '-crf', '29', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '48k', '-ac', '1', '-movflags', '+faststart', small], check=True)
    e = c['end']; items.append({'n': n, 'at': f"{int(e // 60)}:{int(e % 60):02d}", 'src': 'data:video/mp4;base64,' + base64.b64encode(open(small, 'rb').read()).decode()})
page = '''<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>__TITLE__</title>
<style>
:root{--ink:#14161a;--card:#20262e;--lime:#c8f135;--blue:#5b86ff;--soft:#a9b2bf}
*{box-sizing:border-box}html,body{height:100%;margin:0}body{background:var(--ink);color:#fff;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif;display:flex;flex-direction:column;align-items:center}
main{width:100%;max-width:760px;padding:14px 16px 24px;display:flex;flex-direction:column;gap:12px;flex:1}
h1{font-size:20px;margin:0}.sub{color:var(--soft);font-size:14px;margin:0}
.bar{height:8px;border-radius:4px;background:#2a2f36;overflow:hidden}.bar b{display:block;height:100%;background:var(--lime);width:0}
.top{display:flex;justify-content:space-between;align-items:baseline;gap:8px}.top b{font-size:28px;color:var(--lime)}
video{width:100%;aspect-ratio:16/9;background:#000;border-radius:12px}
.pick{display:grid;grid-template-columns:1fr 1fr;gap:10px}
button{font:inherit;border:0;border-radius:12px;padding:20px 8px;font-weight:800;font-size:19px;cursor:pointer;color:var(--ink)}
button:focus-visible{outline:3px solid #fff;outline-offset:2px}
#a{background:var(--lime)}#b{background:var(--blue);color:#fff}
.row{display:grid;grid-template-columns:repeat(4,1fr);gap:10px}@media(max-width:520px){.row{grid-template-columns:1fr 1fr}}.row button{background:var(--card);color:#fff;font-weight:600;font-size:15px;padding:13px 6px}
#done{display:none;flex-direction:column;gap:12px}textarea{width:100%;height:96px;border-radius:10px;border:1px solid #4a525d;background:var(--card);color:#fff;font:15px ui-monospace,Menlo,monospace;padding:10px}
.tally{display:flex;flex-wrap:wrap;gap:10px}.tally div{flex:1 1 40%;background:var(--card);border-radius:10px;padding:10px 12px}.tally b{display:block;font-size:26px}
kbd{background:#2a2f36;border-radius:5px;padding:1px 6px;font-size:13px}
</style></head><body><main>
<div id="work">
  <div class="top"><h1>Who won this point?</h1><span><b id="num">1</b> <span class="sub">of <span id="tot"></span> · match time <span id="at"></span></span></span></div>
  <div class="bar"><b id="prog"></b></div>
  <video id="v" playsinline muted loop autoplay></video>
  <p class="sub">The clip shows the last seconds of the rally and the seconds after it. It repeats. Tap as soon as you know. A warm-up, a pause or a ball of another court is not a point.</p>
  <div class="pick"><button id="a">__TA__</button><button id="b">__TB__</button></div>
  <div class="row"><button id="back">Back</button><button id="nop">Not a point</button><button id="skip">I cannot tell</button><button id="snd">Sound on</button></div>
  <button id="sofar" style="background:var(--card);color:#fff;font-weight:600;font-size:15px;padding:13px 6px">Stop here and copy my answers</button>
  <p class="sub">Keyboard: <kbd>←</kbd> __TA__ · <kbd>→</kbd> __TB__ · <kbd>↓</kbd> cannot tell · <kbd>N</kbd> not a point · <kbd>↑</kbd> back</p>
</div>
<div id="done">
  <h1>Done. Thank you.</h1>
  <div class="tally"><div><b id="ca">0</b>__TA__</div><div><b id="cb">0</b>__TB__</div><div><b id="cn">0</b>not a point</div><div><b id="cu">0</b>cannot tell</div></div>
  <p class="sub">Copy this line and send it in the chat:</p>
  <textarea id="res" readonly></textarea>
  <div class="pick"><button id="copy" style="background:var(--lime)">Copy</button><button id="again" style="background:var(--card);color:#fff">Go on or change an answer</button></div>
  <p class="sub" id="copied"></p>
</div>
</main>
<script>
const CLIPS = __CLIPS__;
let ans = new Array(CLIPS.length).fill(null); let i = 0;
// The answers stay in this browser, so a long match can be done in parts. A browser that refuses storage still works.
const KEY = 'who-won:' + CLIPS.length + ':' + (CLIPS[0] ? CLIPS[0].at : '') + ':' + (CLIPS.length ? CLIPS[CLIPS.length - 1].at : '');
try { const old = JSON.parse(localStorage.getItem(KEY)); if (Array.isArray(old) && old.length === ans.length) { ans = old; const k = ans.indexOf(null); i = k < 0 ? ans.length : k; } } catch (e) {}
function keep() { try { localStorage.setItem(KEY, JSON.stringify(ans)); } catch (e) {} }
const next = document.createElement('video'); next.preload = 'auto'; next.muted = true;
const $ = (id) => document.getElementById(id), v = $('v');
function show() {
  if (i >= CLIPS.length) return finish();
  $('work').style.display = ''; $('done').style.display = 'none';
  $('num').textContent = CLIPS[i].n; $('tot').textContent = CLIPS.length; $('at').textContent = CLIPS[i].at;
  $('prog').style.width = (100 * i / CLIPS.length) + '%'; v.src = CLIPS[i].src; v.play().catch(() => {});
  if (i + 1 < CLIPS.length && !CLIPS[i + 1].src.startsWith('data:')) next.src = CLIPS[i + 1].src;
}
function pick(x) { ans[i] = x; i += 1; keep(); show(); }
function finish() {
  $('work').style.display = 'none'; $('done').style.display = 'flex'; v.pause();
  const n = (x) => ans.filter((y) => y === x).length; $('ca').textContent = n('A'); $('cb').textContent = n('B'); $('cn').textContent = n('N'); $('cu').textContent = n('?');
  // Only the clips with an answer are in the line, so a person can stop at any clip.
  $('res').value = 'Who won: ' + CLIPS.map((c, k) => (ans[k] ? c.n + ans[k] : '')).filter(Boolean).join(' ') + '   (A = __TA__, B = __TB__)';
}
$('a').onclick = () => pick('A'); $('b').onclick = () => pick('B'); $('skip').onclick = () => pick('?'); $('nop').onclick = () => pick('N');
$('back').onclick = () => { if (i > 0) { i -= 1; show(); } };
$('snd').onclick = () => { v.muted = !v.muted; $('snd').textContent = v.muted ? 'Sound on' : 'Sound off'; };
$('again').onclick = () => { const k = ans.indexOf(null); i = k < 0 ? CLIPS.length - 1 : k; show(); };
$('sofar').onclick = finish;
$('copy').onclick = () => { const t = $('res'); t.select(); (navigator.clipboard ? navigator.clipboard.writeText(t.value) : Promise.reject()).then(() => { $('copied').textContent = 'Copied.'; }).catch(() => { try { document.execCommand('copy'); $('copied').textContent = 'Copied.'; } catch (e) { $('copied').textContent = 'Select the line and copy it by hand.'; } }); };
document.addEventListener('keydown', (e) => { if ($('done').style.display === 'flex') return; if (e.key === 'ArrowLeft') pick('A'); else if (e.key === 'ArrowRight') pick('B'); else if (e.key === 'ArrowDown') pick('?'); else if (e.key === 'n' || e.key === 'N') pick('N'); else if (e.key === 'ArrowUp') $('back').onclick(); });
show();
</script></body></html>'''
page = page.replace('__TITLE__', html.escape(sys.argv[5] if len(sys.argv) > 5 else 'Who won the point?')).replace('__TA__', html.escape('Team ' + ta if MT.get('team_a') else ta)).replace('__TB__', html.escape('Team ' + tb if MT.get('team_b') else tb)).replace('__CLIPS__', json.dumps(items))
open(out, 'w').write(page); print('wrote', out, round(os.path.getsize(out) / 1e6, 1), 'MB', len(items), 'clips')
