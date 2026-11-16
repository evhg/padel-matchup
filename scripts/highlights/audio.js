// The page's own sound core on the match's sound track: hits, rallies, points, reactions.
// usage: node audio.js <mono f32le 48 kHz raw file> <out.json>
const fs = require('fs');
// the page's own core, cut out of the lab page between its two markers
const html = fs.readFileSync(__dirname + '/../../public/lab/rally-finder.html', 'utf8');
const m = { exports: {} };
new Function('module', html.split('/*CORE-START*/')[1].split('/*CORE-END*/')[0])(m);
const RF = m.exports;
const [, , raw, out] = process.argv;
const SR = 48000;
const size = fs.statSync(raw).size, seconds = size / 4 / SR;
const env = new RF.Envelope(SR, seconds);
const fd = fs.openSync(raw, 'r');
const CH = SR * 30 * 4, buf = Buffer.alloc(CH);
for (let pos = 0; pos < size; ) {
  const n = fs.readSync(fd, buf, 0, CH, pos); if (n <= 0) break;
  env.push(new Float32Array(buf.buffer, buf.byteOffset, Math.floor(n / 4)).slice());
  pos += n;
}
const prep = RF.prepare(env);
const p = Object.assign({}, RF.DEFAULTS);
const h = RF.pickHits(prep, p);
const rallies = RF.groupRallies(h.hits, prep, env, p);
const r2 = (x) => Math.round(x * 100) / 100;
const points = rallies.map((r) => {
  const pb = RF.pointBounds(r, h.hits);
  const times = h.hits.filter((x) => x.t >= r.start - 0.01 && x.t <= r.end + 0.01);
  const strong = times.reduce((m, x) => (x.s > m.s ? x : m), { s: 0, t: r.start });
  const re = RF.reactionOf(env, prep, pb.lastHit), nb = RF.netBurst(times.map((x) => x.t));
  return { start: r2(r.start), end: r2(r.end), hits: r.hits, score: r.score, smashDb: r2(r.smashDb), cheerDb: r2(r.cheerDb),
    clipStart: r2(pb.start), clipEnd: r2(pb.end), firstHit: r2(pb.firstHit), lastHit: r2(pb.lastHit),
    reactionDb: re.db, laugh: re.laugh, burst: nb, strongest: { t: r2(strong.t), s: r2(strong.s / prep.ref) }, hitTimes: times.map((x) => r2(x.t)) };
});
// A level curve at 10 a second for later use (reactions, quiet stretches).
const lvl = []; for (let i = 0; i + 10 <= env.n; i += 10) { let s = 0; for (let k = 0; k < 10; k++) s += env.full[i + k]; lvl.push(Math.round((s / 10) * 1e5) / 1e5); }
fs.writeFileSync(out, JSON.stringify({ seconds: r2(seconds), hits: h.hits.map((x) => [r2(x.t), r2(x.s / prep.ref)]), points, level10: lvl }));
console.log('seconds', r2(seconds), 'hits', h.hits.length, 'rallies', rallies.length);
