// The stretches of a whole film that its reel is made of, from the film's sound alone: the phone's own choice.
// usage: node film_plan.js <mono f32le raw file> <sample rate> <out.json>
//
// A player who sends the whole film ("Full reel") gets the reel a fast reel of the same film would get. So this runs
// what the phone runs in `src/components/reelFast.ts` (`fastCut`): the Rally Finder's core (public/lab/rf-core.js,
// generated from the lab page) finds the hits and the rallies, `planCut` takes the best points and `planReel`
// ("celebrations") the loudest reactions, and `pickStretches` (src/lib/reel/fastPlan.ts) joins what overlaps, 12
// clips and 200 seconds at most. tests/film-plan.test.ts holds this copy of `pickStretches` to the page's.
//
// Out: {"seconds", "rate", "hits": n, "rallies": n, "stretches": [[start, end], ...]}. "rallies" is every point the
// sound found in the whole film, warm-up and breaks included: the most the film can hold (`honest.py`).
const fs = require('fs');
const path = require('path');

/** The page's core: beside this file on the reel job's machines, in public/lab/ in the repository. */
function core() {
  const here = path.join(__dirname, 'rf-core.js');
  return require(fs.existsSync(here) ? here : path.join(__dirname, '../../public/lab/rf-core.js'));
}

/** `pickStretches` of src/lib/reel/fastPlan.ts, line for line. */
const FAST_MAX_CLIPS = 12;
const FAST_MAX_SECONDS = 200;
function pickStretches(lists, maxClips = FAST_MAX_CLIPS, maxSeconds = FAST_MAX_SECONDS) {
  const taken = [];
  const total = () => taken.reduce((n, s) => n + (s.end - s.start), 0);
  for (const list of lists) {
    for (const c of list) {
      if (!Number.isFinite(c.start) || !Number.isFinite(c.end) || c.end <= c.start) continue;
      const touching = taken.filter((s) => s.start <= c.end && c.start <= s.end);
      const joined = { start: Math.min(c.start, ...touching.map((s) => s.start)), end: Math.max(c.end, ...touching.map((s) => s.end)) };
      const added = joined.end - joined.start - touching.reduce((n, s) => n + (s.end - s.start), 0);
      if (touching.length === 0 && taken.length >= maxClips) continue;
      if (taken.length > 0 && total() + added > maxSeconds) continue;
      for (const s of touching) taken.splice(taken.indexOf(s), 1);
      taken.push(joined);
    }
  }
  return taken.sort((a, b) => a.start - b.start);
}

/** The plan of a film's sound, given as chunks of mono samples (Float32Array) at `rate`. */
function planOf(chunks, rate, seconds) {
  const RF = core();
  const env = new RF.Envelope(rate, seconds);
  for (const x of chunks) env.push(x);
  const prep = RF.prepare(env);
  const { hits } = RF.pickHits(prep, RF.DEFAULTS);
  const rallies = RF.groupRallies(hits, prep, env, RF.DEFAULTS);
  const o = { rallies, hits, env, prep, duration: seconds, isMarked: () => false };
  const lists = [RF.planCut(rallies, () => false, 150, { hits, duration: seconds, most: 8 }), RF.planReel('celebrations', o)];
  const stretches = pickStretches(lists.map((list) => list.map((s) => ({ start: s.start, end: s.end }))));
  const r3 = (x) => Math.round(x * 1000) / 1000;
  return { seconds: r3(seconds), rate, hits: hits.length, rallies: rallies.length, stretches: stretches.map((s) => [r3(s.start), r3(s.end)]) };
}

function main() {
  const [, , raw, rate, out] = process.argv;
  const sr = Number(rate);
  if (!raw || !out || !(sr > 0)) throw new Error('usage: node film_plan.js <mono f32le raw> <rate> <out.json>');
  const size = fs.statSync(raw).size;
  const fd = fs.openSync(raw, 'r');
  const CH = sr * 30 * 4;
  const chunks = (function* () {
    const buf = Buffer.alloc(CH);
    for (let pos = 0; pos < size; ) {
      const n = fs.readSync(fd, buf, 0, CH, pos);
      if (n <= 0) break;
      yield new Float32Array(buf.buffer, buf.byteOffset, Math.floor(n / 4)).slice();
      pos += n;
    }
  })();
  const plan = planOf(chunks, sr, size / 4 / sr);
  fs.writeFileSync(out, JSON.stringify(plan));
  console.log('seconds', plan.seconds, 'hits', plan.hits, 'rallies', plan.rallies, 'stretches', plan.stretches.length);
}

module.exports = { pickStretches, planOf, FAST_MAX_CLIPS, FAST_MAX_SECONDS };
if (require.main === module) main();
