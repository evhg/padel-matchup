#!/usr/bin/env node
// The Rally Finder's core as a file of its own, for the match page's fast reel.
//
//   node scripts/gen-rf-core.mjs           write public/lab/rf-core.js
//   node scripts/gen-rf-core.mjs --check   fail when the file is not what the page's core gives
//
// The core has one home: public/lab/rally-finder.html, between its two markers. The lab page runs it in
// place, scripts/highlights/audio.js cuts it out in Node, and the match page loads this file when a
// player chooses "Make a fast reel". A copy that is written by hand drifts; this one is generated, and
// tests/rf-core.test.ts runs the check.
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const page = readFileSync(path.join(root, "public/lab/rally-finder.html"), "utf8");
const parts = page.split("/*CORE-START*/");
if (parts.length !== 2 || parts[1].split("/*CORE-END*/").length !== 2) {
  console.error("✗ public/lab/rally-finder.html must have one /*CORE-START*/ and one /*CORE-END*/");
  process.exit(1);
}
// The page's notes stay in the page: a line that is only a `//` comment is left out here. They are the
// story of how the core was tuned, with the first names of the players who tested it; a browser needs none of it.
const core = parts[1]
  .split("/*CORE-END*/")[0]
  .split("\n")
  .filter((line) => !line.trim().startsWith("//"))
  .join("\n");
export const rfCoreFile = `// Generated from public/lab/rally-finder.html by scripts/gen-rf-core.mjs. Do not edit: change the page, then run the script.\n(() => {\n${core}\n  globalThis.KicksmashRF = RF;\n})();\n`;

const out = path.join(root, "public/lab/rf-core.js");
if (process.argv.includes("--check")) {
  let have = "";
  try {
    have = readFileSync(out, "utf8");
  } catch {
    /* missing is out of date */
  }
  if (have !== rfCoreFile) {
    console.error("✗ public/lab/rf-core.js is out of date. Run: node scripts/gen-rf-core.mjs");
    process.exit(1);
  }
  console.log("✓ public/lab/rf-core.js is the page's core");
} else {
  writeFileSync(out, rfCoreFile);
  console.log(`wrote public/lab/rf-core.js (${(rfCoreFile.length / 1000).toFixed(0)} KB)`);
}
