import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { mcpToolNames } from "@/lib/api/mcp";

/**
 * The documents that list code, checked against the code. A table nobody can forget to update is
 * worth more than a table somebody promised to update: these two tests are why README.md may claim
 * its environment table is the whole configuration.
 */
const root = (...p: string[]) => path.resolve(process.cwd(), ...p);

describe("the documents that list code", () => {
  it("README.md and .env.example carry every environment variable the code reads", () => {
    // scripts/gen-docs.mjs --check fails when a variable is read but undescribed, described but read
    // nowhere, or when either file no longer matches what it would write.
    const run = () => execFileSync("node", [root("scripts/gen-docs.mjs"), "--check"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    expect(run).not.toThrow();
  });

  it("every surface that lists MCP tools lists all of them", () => {
    const surfaces = ["skills/kicksmash/SKILL.md", "src/app/developers/page.tsx", "docs/launch/directories.md", "README.md"];
    const missing = surfaces.flatMap((file) => {
      const text = readFileSync(root(file), "utf8");
      return mcpToolNames().filter((name) => !text.includes(name)).map((name) => `${file}: ${name}`);
    });
    expect(missing).toEqual([]);
  });
});
