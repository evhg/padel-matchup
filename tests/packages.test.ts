// The npm packages are generated from src/lib/domain: this builds them for real and checks the published surface.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { bandOf, formatLevel, rangeFor } from "@/lib/domain/levels";
import { buildSchedule } from "@/lib/domain/schedule";

const root = path.resolve(import.meta.dirname, "..");
const dist = (p: string) => pathToFileURL(path.join(root, "packages", p, "dist/index.js")).href;

describe("npm packages", () => {
  it("build from the pure modules and expose the same engines", async () => {
    const r = spawnSync(process.execPath, [path.join(root, "scripts/build-packages.mjs")], { encoding: "utf8", cwd: root });
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
    for (const name of ["americano", "levels"]) {
      const pkg = JSON.parse(readFileSync(path.join(root, "packages", name, "package.json"), "utf8")) as { name: string; version: string; exports: Record<string, unknown> };
      expect(pkg.name).toBe(`@kicksmash/${name}`);
      expect(pkg.version).toMatch(/^\d+\.\d+\.\d+$/);
      expect(pkg.exports["."]).toBeTruthy();
    }
    const americano = (await import(dist("americano"))) as typeof import("@/lib/domain/schedule") & typeof import("@/lib/domain/americano") & typeof import("@/lib/domain/formats");
    const s = americano.buildSchedule({ players: 8, seed: 3 });
    expect(s.exact).toBe(true);
    expect(s.rounds).toHaveLength(7);
    expect(s.rounds[0].matches).toHaveLength(2);
    expect(s).toEqual(buildSchedule({ players: 8, seed: 3 }));
    expect(americano.rotationLength(12)).toBe(11);
    expect(americano.buildSchedule({ names: ["a", "b", "c", "d", "e"] }).rounds[0].resting).toHaveLength(1);
    expect(typeof americano.planMexicanoRound).toBe("function");
    expect(typeof americano.planKingRound).toBe("function");
    expect(americano.formatOf("king")).toBe("king");
    const levels = (await import(dist("levels"))) as typeof import("@/lib/domain/levels");
    expect(levels.bandOf(3.5)).toBe(bandOf(3.5));
    expect(levels.formatLevel(3.25)).toBe(formatLevel(3.25));
    expect(levels.rangeFor("gold")).toEqual(rangeFor("gold"));
    expect(levels.levelFit(levels.rangeFor("gold"), 2.5)).toBe("below");
  }, 180_000);

  it("the API schedule is the pure builder with validation in front", async () => {
    const { generateSchedule } = await import("@/lib/api/operations");
    expect(generateSchedule({ players: 12, seed: 2 })).toEqual(buildSchedule({ players: 12, seed: 2 }));
    expect(() => generateSchedule({ players: 3 })).toThrow();
    expect(buildSchedule({ players: 3 }).players).toBe(4);
    expect(buildSchedule({ players: 999, rounds: 999 }).rounds).toHaveLength(40);
  });
});
