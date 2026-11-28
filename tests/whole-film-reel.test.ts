import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { pickStretches } from "@/lib/reel/fastPlan";
import { MISSING_CODES, NO_SCORE_WHY } from "@/lib/domain/matchReel";

/**
 * A whole film becomes a reel with no person (the owner, 27 November 2026, stage A). The reel's job chooses the
 * stretches from the film's sound as the phone does for a fast reel (`scripts/highlights/film_plan.js`), and claims a
 * score only when the engine is sure (`scripts/highlights/honest.py`). Both run on the reel host, not in the app, so
 * these tests run them as the job does: Node on the one, Python on the other.
 */
const require = createRequire(import.meta.url);
const plan = require("../scripts/highlights/film_plan.js") as {
  pickStretches: typeof pickStretches;
  planOf: (chunks: Iterable<Float32Array>, rate: number, seconds: number) => { seconds: number; hits: number; rallies: number; stretches: [number, number][] };
  longestOf: (chunks: Iterable<Float32Array>, rate: number, seconds: number) => { seconds: number; rallies: number; warmup: number; plan: string; stretches: [number, number][] };
  afterWarmup: (rallies: { start: number; end: number }[], seconds: number) => number;
  pickLongest: (rallies: { start: number; end: number; first: number; last: number }[], seconds: number, warm: number) => { start: number; end: number }[];
  WHOLE_MAX_CLIPS: number;
  WHOLE_MAX_SECONDS: number;
  WHOLE_MIN_RALLY: number;
  WHOLE_LEAD: number;
};
const RF = require("../public/lab/rf-core.js") as { synthMatch: (seconds: number, sr: number, seed: number) => { mono: Float32Array; truth: { rallies: unknown[] } } };

describe("the stretches of a whole film", () => {
  it("are chosen as the phone chooses them: the same pick, line for line, on any lists", () => {
    let seed = 7;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    for (let n = 0; n < 200; n++) {
      const lists = Array.from({ length: 1 + Math.floor(rnd() * 3) }, () =>
        Array.from({ length: Math.floor(rnd() * 20) }, () => {
          const start = rnd() * 5000;
          return { start, end: start + (rnd() < 0.05 ? -1 : rnd() * 45) };
        }),
      );
      expect(plan.pickStretches(lists)).toEqual(pickStretches(lists));
    }
  });

  it("ask the core what the phone asks it (src/components/reelFast.ts)", () => {
    const phone = readFileSync("src/components/reelFast.ts", "utf8").replace(/"/g, "'");
    const job = readFileSync("scripts/highlights/film_plan.js", "utf8");
    for (const call of ["RF.pickHits(prep, RF.DEFAULTS)", "RF.groupRallies(hits, prep, env, RF.DEFAULTS)", "RF.planCut(rallies, () => false, 150, { hits, duration: seconds, most: 8 })", "RF.planReel('celebrations', o)"]) {
      expect(phone, call).toContain(call);
      expect(job, call).toContain(call);
    }
  });

  it("come out of a match's sound in the order of the film, within the fast reel's limits, with every point heard counted", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "film-plan-"));
    try {
      const m = RF.synthMatch(900, 16000, 7);
      writeFileSync(path.join(dir, "s.raw"), Buffer.from(m.mono.buffer));
      execFileSync("node", ["scripts/highlights/film_plan.js", path.join(dir, "s.raw"), "16000", path.join(dir, "plan.json")]);
      const got = JSON.parse(readFileSync(path.join(dir, "plan.json"), "utf8")) as { seconds: number; rallies: number; stretches: [number, number][] };
      expect(got.seconds).toBe(900);
      // 30 rallies of four hits or more in the made-up sound; the core hears most of them
      expect(got.rallies).toBeGreaterThan(20);
      expect(got.rallies).toBeLessThanOrEqual(m.truth.rallies.length + 3);
      expect(got.stretches.length).toBeGreaterThan(3);
      expect(got.stretches.length).toBeLessThanOrEqual(12);
      expect(got.stretches.reduce((n, [a, b]) => n + (b - a), 0)).toBeLessThanOrEqual(200);
      for (let i = 0; i < got.stretches.length; i++) {
        expect(got.stretches[i][1]).toBeGreaterThan(got.stretches[i][0]);
        if (i > 0) expect(got.stretches[i][0]).toBeGreaterThan(got.stretches[i - 1][1]);
      }
      // the file the job reads is the same plan as the module's own
      expect(got).toMatchObject({ stretches: plan.planOf([m.mono], 16000, 900).stretches });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/**
 * The full reel's own plan (the owner, 27 November 2026: "the clips should focus on the longest rallies"): the longest
 * rallies after the warm-up, each from before its serve. The phone's plan above stays as it is.
 */
describe("the full reel's plan of a whole film", () => {
  const rally = (first: number, last: number) => ({ start: first, end: last, first, last });

  it("finds the end of the warm-up by its shape: the ball in play more than half of the time, then a quarter or less", () => {
    // 7 minutes of warm-up (in play 20 s of each 25 s), then a game (in play 10 s of each 60 s)
    const warm = Array.from({ length: 17 }, (_, i) => ({ start: i * 25, end: i * 25 + 20 }));
    const game = Array.from({ length: 40 }, (_, i) => ({ start: 430 + i * 60, end: 440 + i * 60 }));
    const end = plan.afterWarmup([...warm, ...game], 3000);
    expect(end).toBeGreaterThan(420);
    expect(end).toBeLessThan(700);
    // a film that starts with the game has no warm-up to cut
    expect(plan.afterWarmup(game.map((r) => ({ start: r.start - 430, end: r.end - 430 })), 3000)).toBe(0);
  });

  it("takes the longest rallies after the warm-up, from before the serve, with no overlap and within its limits", () => {
    const rallies = [rally(100, 150), rally(600, 640), rally(700, 703), rally(900, 912), rally(1200, 1230), rally(1500, 1508), rally(1800, 1825)];
    const got = plan.pickLongest(rallies, 3000, 450);
    // the 50 s rally at 100 s is in the warm-up, the 3 s one is too short
    expect(got.map((s) => s.start)).toEqual([600 - plan.WHOLE_LEAD, 900 - plan.WHOLE_LEAD, 1200 - plan.WHOLE_LEAD, 1500 - plan.WHOLE_LEAD, 1800 - plan.WHOLE_LEAD]);
    // the longest first when the limit bites: room for the three longest only
    const many = Array.from({ length: 30 }, (_, i) => rally(1000 + i * 100, 1000 + i * 100 + 10 + i));
    const some = plan.pickLongest(many, 5000, 0);
    expect(some.length).toBeLessThanOrEqual(plan.WHOLE_MAX_CLIPS);
    expect(some.reduce((n, s) => n + (s.end - s.start), 0)).toBeLessThanOrEqual(plan.WHOLE_MAX_SECONDS);
    // a rally is left out only when the longer ones kept already fill the clips or the seconds (the plan skips a rally
    // that does not fit and takes a shorter one after it)
    const len = (r: { first: number; last: number }) => r.last - r.first + plan.WHOLE_LEAD + 4;
    const kept = (r: { first: number }) => some.some((s) => s.start === r.first - plan.WHOLE_LEAD);
    for (const r of many.filter((x) => !kept(x))) {
      const longer = many.filter((x) => kept(x) && x.last - x.first >= r.last - r.first);
      expect(longer.length >= plan.WHOLE_MAX_CLIPS || longer.reduce((n, x) => n + len(x), 0) + len(r) > plan.WHOLE_MAX_SECONDS).toBe(true);
    }
    for (let i = 1; i < some.length; i++) expect(some[i].start).toBeGreaterThan(some[i - 1].end);
  });

  it("comes out of a match's sound in the order of the film, and the job's file is the module's plan", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "film-longest-"));
    try {
      const m = RF.synthMatch(900, 16000, 7);
      writeFileSync(path.join(dir, "s.raw"), Buffer.from(m.mono.buffer));
      execFileSync("node", ["scripts/highlights/film_plan.js", path.join(dir, "s.raw"), "16000", path.join(dir, "plan.json"), "longest"]);
      const got = JSON.parse(readFileSync(path.join(dir, "plan.json"), "utf8")) as { plan: string; rallies: number; stretches: [number, number][] };
      expect(got.plan).toBe("longest");
      expect(got.rallies).toBeGreaterThan(20);
      expect(got.stretches.length).toBeGreaterThan(0);
      expect(got.stretches.reduce((n, [a, b]) => n + (b - a), 0)).toBeLessThanOrEqual(plan.WHOLE_MAX_SECONDS);
      for (let i = 1; i < got.stretches.length; i++) expect(got.stretches[i][0]).toBeGreaterThan(got.stretches[i - 1][1]);
      expect(got).toMatchObject({ stretches: plan.longestOf([m.mono], 16000, 900).stretches });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/** honest.py as the job calls it: `verdict` for each case, then `strip` on a plan that claims a score. */
function honest(cases: [string[], number | null, number?][], points: unknown): { verdicts: [boolean, string | null, number | null][]; stripped: unknown; gone: string[] } {
  const py = `import sys, json; sys.path.insert(0, 'scripts/highlights'); import honest
c = json.loads(sys.argv[1]); p = json.loads(sys.argv[2])
v = [list(honest.verdict(s, f, *(w or []))) for s, f, *w in c]
g = honest.strip(p)
print(json.dumps({'verdicts': v, 'stripped': p, 'gone': g}))`;
  return JSON.parse(execFileSync("python3", ["-I", "-c", py, JSON.stringify(cases), JSON.stringify(points)], { encoding: "utf8" }));
}

describe("what a reel from the whole film may claim", () => {
  it("claims a score only with a score to check, every point the sets need, and a sure winner for each", () => {
    const verdicts = honest(
      [
        // the film of 24 November 2026: 6-3 6-2 needs 68 points; the sound heard 113 in the whole film, the readers found 59 in the match
        [["6-3 6-2"], 113],
        [["6-3 6-2"], 59],
        [["6-3 6-2"], 67],
        [["6-3 6-2"], 68, 68],
        // a tie-break set: twelve games and seven points; a match tie-break counts its points
        [["7-6 4-6 10-8"], 112, 112],
        [["7-6 4-6 10-8"], 113, 113],
        // two matches in one film need the points of both
        [["6-3 6-2", "5-4"], 100, 200],
        [[""], 113],
        [["6-3", "nonsense"], 113],
        // stretches a person chose: no count of the sound, so only the winners decide
        [["6-3 6-2"], null],
      ],
      {},
    ).verdicts.map(([shown, why, need]) => ({ shown, why, need }));
    expect(verdicts).toEqual([
      { shown: false, why: "no_winners", need: 68 },
      { shown: false, why: "few_points", need: 68 },
      { shown: false, why: "few_points", need: 68 },
      { shown: true, why: null, need: 68 },
      { shown: false, why: "few_points", need: 113 },
      { shown: true, why: null, need: 113 },
      { shown: false, why: "few_points", need: 104 },
      { shown: false, why: "no_score", need: null },
      { shown: false, why: "no_score", need: null },
      { shown: false, why: "no_winners", need: 68 },
    ]);
    // Every reason the job can give is one the app knows.
    expect(readFileSync("scripts/highlights/honest.py", "utf8")).toContain(`WHY = (${NO_SCORE_WHY.map((w) => `'${w}'`).join(", ")})`);
  });

  it("takes out of the plan the card of numbers, the score box and the winner of each point, and nothing else", () => {
    const { stripped, gone } = honest([], { points: [{ id: "c0", title: "Long rally", won: 1 }, { id: "c1", title: "" }], card: { title: "Numbers", rows: [] }, score_box: true, outro: "x" });
    expect(stripped).toEqual({ points: [{ id: "c0", title: "Long rally" }, { id: "c1", title: "" }], outro: "x" });
    expect(gone).toEqual(["card", "score_box", "won:c0"]);
  });

  it("gives each reason as a code the match page has a row for", () => {
    for (const why of NO_SCORE_WHY) expect(MISSING_CODES as readonly string[], why).toContain(why);
  });
});
