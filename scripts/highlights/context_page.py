"""One page to say what happened in each point: who won, how it ended, who hit the last shot, and one free line.

usage: context_page.py <cands.json> <match.json> <out.html> [page title] [answers so far: "1B 2N 3A ..."]

label_page.py asks one thing (who won). That is enough to count a score, and not enough to teach a machine the
game: "not a point" does not say if the clip showed a let, a ball of the next court, practice between games, or
a bad cut. This page asks for that context. It is for the person who builds the detector, never for a player of
the app: the score there is automatic.

The clips are beside the page as clips/001.mp4, clips/002.mp4, ... (label_clips.py). The answers stay in the
browser after each tap, and the line to copy is there at every clip: a person can stop at any time.
The line is JSON: {"A": team, "B": team, "answers": [{"n", "w": "A"|"B"|"N"|"?", "end", "last", "why", "note"}]}.
Answers from an earlier page ("1B 2N ...") are taken as that page meant them: give this page the same match.json,
so A and B are the same teams.
"""
import sys, json, html

candf, matchf, out = sys.argv[1:4]
title = sys.argv[4] if len(sys.argv) > 4 else 'What happened in the point?'
prior = sys.argv[5] if len(sys.argv) > 5 else ''
C = json.load(open(candf)); MT = json.load(open(matchf))
import teams; teams.fill(MT)
ta = ('Team ' + MT['team_a']) if MT.get('team_a') else MT['pair_a']
tb = ('Team ' + MT['team_b']) if MT.get('team_b') else MT['pair_b']
names = [MT['names'][str(i)] for i in range(4)] if isinstance(MT.get('names'), dict) else list(MT.get('names', []))
import re
before = {int(n): w for n, w in re.findall(r'\b(\d+)([ABN?])', prior.split('(')[0])}
clips = [{'n': c['i'] + 1, 'at': f"{int(c['end'] // 60)}:{int(c['end'] % 60):02d}", 'src': f"clips/{c['i'] + 1:03d}.mp4",
          'w': before.get(c['i'] + 1)} for c in C]

page = '''<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>__TITLE__</title>
<style>
:root{--ink:#14161a;--card:#20262e;--lime:#c8f135;--blue:#5b86ff;--soft:#a9b2bf;--line:#3a424d}
*{box-sizing:border-box}html,body{margin:0}body{background:var(--ink);color:#fff;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif;display:flex;justify-content:center}
main{width:100%;max-width:760px;padding:14px 16px 28px;display:flex;flex-direction:column;gap:12px}
h1{font-size:20px;margin:0}h2{font-size:14px;margin:6px 0 0;color:var(--soft);font-weight:600;letter-spacing:.02em}.sub{color:var(--soft);font-size:14px;margin:0}
.top{display:flex;justify-content:space-between;align-items:baseline;gap:8px}.top b{font-size:26px;color:var(--lime)}
.bar{height:8px;border-radius:4px;background:#2a2f36;overflow:hidden}.bar b{display:block;height:100%;background:var(--lime);width:0}
video{width:100%;aspect-ratio:16/9;background:#000;border-radius:12px}
.row{display:flex;flex-wrap:wrap;gap:8px}
button{font:inherit;border:2px solid transparent;border-radius:12px;padding:13px 12px;font-weight:700;font-size:16px;cursor:pointer;background:var(--card);color:#fff;flex:1 1 44%}
button:focus-visible{outline:3px solid #fff;outline-offset:2px}
button[aria-pressed="true"]{border-color:var(--lime);background:#2c3520}
#wA[aria-pressed="true"]{background:var(--lime);color:var(--ink)}#wB[aria-pressed="true"]{background:var(--blue);border-color:var(--blue)}
.chips button{flex:0 1 auto;font-size:15px;font-weight:600;padding:10px 12px}
input[type=text]{width:100%;font:inherit;font-size:16px;color:#fff;background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px}
.nav{display:flex;gap:8px}.nav button{flex:1}#next{background:var(--lime);color:var(--ink)}#next:disabled{opacity:.4;cursor:default}
textarea{width:100%;height:120px;border-radius:10px;border:1px solid var(--line);background:var(--card);color:#fff;font:13px ui-monospace,Menlo,monospace;padding:10px}
[hidden]{display:none!important}
</style></head><body><main>
<div class="top"><h1>What happened in this point?</h1><span><b id="num">1</b> <span class="sub">of <span id="tot"></span> · match time <span id="at"></span></span></span></div>
<div class="bar"><b id="prog"></b></div>
<video id="v" playsinline muted loop autoplay></video>
<p class="sub">The clip shows the last seconds of the rally and the seconds after it. It repeats. <button id="snd" style="flex:none;padding:4px 10px;font-size:13px;font-weight:600">Sound on</button></p>
<h2>WHO WON?</h2>
<div class="row" id="rowW"><button id="wA" data-w="A">__TA__</button><button id="wB" data-w="B">__TB__</button><button data-w="N">Not a point</button><button data-w="?">I cannot tell</button></div>
<div id="boxEnd" hidden><h2>HOW DID IT END?</h2><div class="row chips" id="rowEnd"></div></div>
<div id="boxLast" hidden><h2>WHO HIT THE LAST SHOT?</h2><div class="row chips" id="rowLast"></div></div>
<div id="boxWhy" hidden><h2>WHY IS IT NOT A POINT?</h2><div class="row chips" id="rowWhy"></div></div>
<h2>ANYTHING ELSE? (YOU CAN LEAVE THIS EMPTY)</h2>
<input type="text" id="note" placeholder="For example: the serve was a let, they played it again" autocomplete="off">
<div class="nav"><button id="back">Back</button><button id="next" disabled>Next clip</button></div>
<h2>YOUR ANSWERS SO FAR (<span id="cnt">0</span>). COPY THIS AND SEND IT IN THE CHAT, AT ANY TIME.</h2>
<textarea id="res" readonly></textarea>
<div class="nav"><button id="copy">Copy my answers</button></div>
<p class="sub" id="copied"></p>
</main>
<script>
const CLIPS = __CLIPS__, NAMES = __NAMES__, TEAMS = __TEAMS__;
const ENDS = [['net', 'Ball in the net'], ['out', 'Ball out (glass or fence first)'], ['winner', 'Not returned'], ['two', 'Two bounces'], ['other', 'Other']];
const WHYS = [['practice', 'Warm-up or practice'], ['let', 'A let: they play it again'], ['other-court', 'A ball of another court'], ['no-end', 'The clip shows no end'], ['fault', 'A serve fault only'], ['other', 'Other']];
const $ = (id) => document.getElementById(id), v = $('v');
// The answers stay in this browser after each tap. A browser that refuses storage still works.
const KEY = 'point-context:' + CLIPS.length + ':' + (CLIPS[0] ? CLIPS[0].at : '') + ':' + (CLIPS.length ? CLIPS[CLIPS.length - 1].at : '');
let ans = CLIPS.map((c) => (c.w ? { w: c.w, given: true } : {})), i = 0;
try { const old = JSON.parse(localStorage.getItem(KEY)); if (Array.isArray(old) && old.length === ans.length) { ans = old; const k = ans.findIndex((a) => !a.done); i = k < 0 ? 0 : k; } } catch (e) {}
function keep() { try { localStorage.setItem(KEY, JSON.stringify(ans)); } catch (e) {} line(); }
function line() {
  const done = ans.map((a, k) => (a.done ? Object.assign({ n: CLIPS[k].n, w: a.w }, a.end ? { end: a.end } : {}, a.last ? { last: a.last } : {}, a.why ? { why: a.why } : {}, a.note ? { note: a.note } : {}) : null)).filter(Boolean);
  // the line says what A and B mean: two pages of one match once had the teams the other way round
  $('res').value = JSON.stringify({ A: TEAMS[0], B: TEAMS[1], answers: done }); $('cnt').textContent = done.length;
}
function chips(row, list, key) {
  $(row).innerHTML = '';
  for (const [val, label] of list) {
    const b = document.createElement('button'); b.textContent = label; b.setAttribute('aria-pressed', String(ans[i][key] === val));
    b.onclick = () => { ans[i][key] = ans[i][key] === val ? undefined : val; keep(); show(false); };
    $(row).appendChild(b);
  }
}
function show(load) {
  const a = ans[i];
  $('num').textContent = CLIPS[i].n; $('tot').textContent = CLIPS.length; $('at').textContent = CLIPS[i].at;
  $('prog').style.width = (100 * ans.filter((x) => x.done).length / CLIPS.length) + '%';
  if (load) { v.src = CLIPS[i].src; v.play().catch(() => {}); $('note').value = a.note || ''; }
  for (const b of $('rowW').children) b.setAttribute('aria-pressed', String(b.dataset.w === a.w));
  const point = a.w === 'A' || a.w === 'B';
  $('boxEnd').hidden = !point; $('boxLast').hidden = !point; $('boxWhy').hidden = a.w !== 'N';
  if (point) { chips('rowEnd', ENDS, 'end'); chips('rowLast', NAMES.map((n) => [n, n]).concat([['?', 'Not sure']]), 'last'); }
  if (a.w === 'N') chips('rowWhy', WHYS, 'why');
  $('next').disabled = !a.w; $('next').textContent = i === CLIPS.length - 1 ? 'Finish' : 'Next clip';
}
for (const b of $('rowW').children) b.onclick = () => { ans[i].w = b.dataset.w; if (b.dataset.w !== 'N') ans[i].why = undefined; if (b.dataset.w !== 'A' && b.dataset.w !== 'B') { ans[i].end = undefined; ans[i].last = undefined; } keep(); show(false); };
$('note').oninput = () => { ans[i].note = $('note').value.trim() || undefined; keep(); };
$('next').onclick = () => { ans[i].done = true; keep(); if (i < CLIPS.length - 1) { i += 1; show(true); window.scrollTo(0, 0); } else { $('copied').textContent = 'That was the last clip. Thank you. Copy your answers and send them in the chat.'; $('res').focus(); } };
$('back').onclick = () => { if (i > 0) { i -= 1; show(true); window.scrollTo(0, 0); } };
$('snd').onclick = () => { v.muted = !v.muted; $('snd').textContent = v.muted ? 'Sound on' : 'Sound off'; };
$('copy').onclick = () => { const t = $('res'); t.select(); (navigator.clipboard ? navigator.clipboard.writeText(t.value) : Promise.reject()).then(() => { $('copied').textContent = 'Copied.'; }).catch(() => { try { document.execCommand('copy'); $('copied').textContent = 'Copied.'; } catch (e) { $('copied').textContent = 'Select the text and copy it by hand.'; } }); };
line(); show(true);
</script></body></html>'''
page = (page.replace('__TITLE__', html.escape(title)).replace('__TA__', html.escape(ta)).replace('__TB__', html.escape(tb))
        .replace('__CLIPS__', json.dumps(clips)).replace('__NAMES__', json.dumps(names)).replace('__TEAMS__', json.dumps([ta, tb])))
open(out, 'w').write(page)
print('wrote', out, len(clips), 'clips', sum(1 for c in clips if c['w']), 'with an answer from before')
