import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import en from "../messages/en.json";
import ru from "../messages/ru.json";
import es from "../messages/es.json";
import { MISSING_CODES, MISSING_COPY, missingOf, NO_SCORE_WHY } from "@/lib/domain/matchReel";

/**
 * What a reel could not do (the owner, 27 November 2026): the reel's job sends codes (`scripts/highlights/missing.py`),
 * and the match page shows a row for each, with the thing, the reason and a tip in the player's control. These tests
 * hold the two lists together, the words in every language, and /film to the same tips.
 */
const py = (code: string) => execFileSync("python3", ["-I", "-c", `import sys, json; sys.path.insert(0, 'scripts/highlights'); import missing\n${code}`], { encoding: "utf8" });

describe("what a reel could not do", () => {
  it("has the same codes, in the same order, on the reel host and in the app", () => {
    const job = JSON.parse(py("print(json.dumps({'codes': missing.CODES, 'reserved': missing.RESERVED}))")) as { codes: string[]; reserved: string[] };
    expect(job.codes).toEqual([...MISSING_CODES]);
    expect(job.reserved).toEqual(["court_not_found", "phone_moved"]);
    for (const why of NO_SCORE_WHY) expect(job.codes, why).toContain(why);
  });

  it("passes the job's own checks (scripts/highlights/test_missing.py)", () => {
    expect(execFileSync("python3", ["-I", "scripts/highlights/test_missing.py"], { encoding: "utf8" })).toMatch(/^ok \d+ checks/);
  });

  it("gives every code a thing, a reason and a tip, short, in every language", () => {
    for (const code of MISSING_CODES) {
      for (const part of ["thing", "why", "tip"] as const) {
        const key = MISSING_COPY[code][part];
        for (const [l, m] of [["en", en], ["ru", ru], ["es", es]] as const) expect(m.reelMissing[key], `${l} ${code} ${part}`).toMatch(/^\S.{8,118}$/);
      }
    }
    expect(en.reelMissing.title).toBe("What this reel could not do");
  });

  it("says each row in plain words, with a tip the player can follow", () => {
    const row = (code: (typeof MISSING_CODES)[number]) => Object.values(MISSING_COPY[code]).map((k) => en.reelMissing[k]);
    expect(row("fast_by_design")).toEqual(["The score, who won each point, your numbers and the fastest shot", "A fast reel has none of them: your phone sends only the best points.", "For the score and your numbers, send the whole video: Full reel."]);
    expect(row("few_points")).toEqual(["The score, who won each point and your numbers", "The sound did not find every point of the match.", "Record the whole match in one video. Keep the microphone away from the fence, fans and speakers."]);
    expect(row("no_winners")[2]).toBe("Put the phone high, in the centre of the back glass, so that the far baseline is in the picture.");
    expect(row("no_score")[2]).toBe("Enter the result on the match page before you send the video.");
    expect(row("players_out_of_frame")[2]).toBe("Use 0.5× with the phone on its side, and check that all four players are in the picture.");
    expect(row("far_names_unsure")[2]).toBe("Before the first serve, each player stands in front of the phone for 3 seconds.");
    // the two codes the court finder will send share their tip
    expect(row("court_not_found")[2]).toBe(row("phone_moved")[2]);
    // the button the reel's "Full reel" tip names is the one the reel card shows
    expect(en.reelMissing.fastTip).toContain(en.reel.fullTitle);
  });

  it("keeps a code it knows, once, in the order of the list, and drops anything else", () => {
    expect(missingOf(["no_heart_rate", "fast_by_design", "no_heart_rate", "<script>", 3, null])).toEqual(["fast_by_design", "no_heart_rate"]);
    expect(missingOf("few_points")).toEqual([]);
    expect(missingOf(undefined)).toEqual([]);
    expect(missingOf([...MISSING_CODES].reverse())).toEqual([...MISSING_CODES]);
  });

  it("gives /film the same tips as the match page, from the same messages", () => {
    const film = readFileSync("src/app/film/page.tsx", "utf8");
    const tips = new Set<string>(MISSING_CODES.map((c) => MISSING_COPY[c].tip));
    const used = [...film.matchAll(/"(\w+Tip)"/g)].map((m) => m[1]);
    expect(used.length).toBeGreaterThanOrEqual(5);
    for (const k of used) expect(tips.has(k), k).toBe(true);
    expect(film).toContain('getTranslations("reelMissing")');
  });
});
