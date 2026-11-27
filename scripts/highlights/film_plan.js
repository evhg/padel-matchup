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

// The full reel's own plan (the owner, 27 November 2026: "the clips should focus on the longest rallies"). The phone's
// plan above takes the best points and the loudest reactions; a reaction clip starts 3 s before the last hit, in the
// middle of a rally, with no serve. A whole film has time for whole points, so this plan takes the longest rallies of
// the match, each from before its serve to after its end:
// - no warm-up: in a warm-up the ball is in play more than half of the time, in a game most of the time is walking and
//   waiting (`afterWarmup`, the rule of plan.py; README, "A warm-up has a shape"; on the film of 24 November it ends
//   at 7:30, and the sound's 30 s "rallies" before it were the warm-up);
// - rallies of WHOLE_MIN_RALLY s or more from the first hit to the last, the longest first, up to WHOLE_MAX_CLIPS
//   and WHOLE_MAX_SECONDS: more than the reel needs, because a third of a busy hall's "rallies" are not points
//   (README): the job's picture check (fast_points.py, `not_a_point`) leaves those out and keeps the longest points;
// - each from WHOLE_LEAD s before its first heard hit (a far serve is quiet, and the first hit heard is often the
//   return) to POINT_AFTER after its last, at most WHOLE_MAX_RALLY s long.
const WHOLE_MAX_CLIPS = 12;
const WHOLE_MAX_SECONDS = 320;
const WHOLE_MIN_RALLY = 8;
const WHOLE_MAX_RALLY = 75;
const WHOLE_LEAD = 4;
const POINT_AFTER = 4;
const END_IGNORE = 10;

/** When the warm-up ends, in seconds of the film, or 0 when its shape is not there (plan.py `after_warmup`). Pure. */
function afterWarmup(rallies, seconds, window = 180, step = 30, first = 1200) {
  const play = new Uint8Array(Math.floor(seconds) + 1);
  for (const r of rallies) for (let t = Math.max(0, Math.floor(r.start)); t <= Math.min(play.length - 1, Math.floor(r.end)); t++) play[t] = 1;
  const share = [];
  for (let t = 0; t < Math.min(first, Math.floor(seconds) - window); t += step) {
    let n = 0;
    for (let k = t; k < t + window; k++) n += play[k];
    share.push([t, n / window]);
  }
  const busy = share.findIndex(([, v]) => v >= 0.5);
  if (busy < 0) return 0;
  const calm = share.slice(busy).find(([, v]) => v <= 0.25);
  return calm ? calm[0] + 60 : 0;
}

/** The longest rallies as stretches: `rallies` [{start, end, first, last}] (first and last: the first and last hit). Pure. */
function pickLongest(rallies, seconds, warm) {
  const ignoreFrom = seconds > 300 ? seconds - END_IGNORE : Infinity;
  const cands = rallies
    .filter((r) => r.start >= warm && r.end <= ignoreFrom && r.last - r.first >= WHOLE_MIN_RALLY)
    .map((r) => ({ start: Math.max(0, r.first - WHOLE_LEAD), end: Math.min(seconds, r.last + POINT_AFTER), length: r.last - r.first }))
    .map((c) => (c.end - c.start > WHOLE_MAX_RALLY ? { ...c, end: c.start + WHOLE_MAX_RALLY } : c))
    .sort((a, b) => b.length - a.length);
  const taken = [];
  let total = 0;
  for (const c of cands) {
    if (taken.length >= WHOLE_MAX_CLIPS) break;
    if (taken.some((s) => s.start < c.end && c.start < s.end)) continue;
    if (total + (c.end - c.start) > WHOLE_MAX_SECONDS) continue;
    taken.push(c);
    total += c.end - c.start;
  }
  return pickStretches([taken.map(({ start, end }) => ({ start, end }))], WHOLE_MAX_CLIPS, WHOLE_MAX_SECONDS);
}

/** The full reel's plan of a film's sound: the longest rallies after the warm-up. */
function longestOf(chunks, rate, seconds) {
  const RF = core();
  const env = new RF.Envelope(rate, seconds);
  for (const x of chunks) env.push(x);
  const prep = RF.prepare(env);
  const { hits } = RF.pickHits(prep, RF.DEFAULTS);
  const rallies = RF.groupRallies(hits, prep, env, RF.DEFAULTS);
  const warm = afterWarmup(rallies, seconds);
  const bounds = rallies.map((r) => { const b = RF.pointBounds(r, hits); return { start: r.start, end: r.end, first: b.firstHit, last: b.lastHit }; });
  const stretches = pickLongest(bounds, seconds, warm);
  const r3 = (x) => Math.round(x * 1000) / 1000;
  return { seconds: r3(seconds), rate, hits: hits.length, rallies: rallies.length, warmup: warm, plan: 'longest', stretches: stretches.map((s) => [r3(s.start), r3(s.end)]) };
}

function main() {
  const [, , raw, rate, out, how] = process.argv;
  const sr = Number(rate);
  if (!raw || !out || !(sr > 0)) throw new Error('usage: node film_plan.js <mono f32le raw> <rate> <out.json> [longest]');
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
  const plan = (how === 'longest' ? longestOf : planOf)(chunks, sr, size / 4 / sr);
  fs.writeFileSync(out, JSON.stringify(plan));
  console.log('seconds', plan.seconds, 'hits', plan.hits, 'rallies', plan.rallies, 'stretches', plan.stretches.length, plan.plan ? `plan ${plan.plan}, warm-up until ${plan.warmup} s` : '');
}

module.exports = { pickStretches, planOf, longestOf, afterWarmup, pickLongest, FAST_MAX_CLIPS, FAST_MAX_SECONDS, WHOLE_MAX_CLIPS, WHOLE_MAX_SECONDS, WHOLE_MIN_RALLY, WHOLE_LEAD };
if (require.main === module) main();
