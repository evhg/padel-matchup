#!/usr/bin/env node
import { execFileSync } from "node:child_process";

/**
 * What is still running when the gate finishes.
 *
 * A wait loop written as `until <condition>; do :; done` spins a whole core and, when the thing it
 * waits for dies, never ends. One of those ran for hours beside a session's real work and was found
 * only because the owner asked why a task was still running. It is never a legitimate shape, so it
 * fails here rather than being a line in a document.
 *
 * Leftover servers are a warning instead: a developer may have their own `next dev` running for
 * perfectly good reasons, and a gate that goes red for somebody else's terminal is a gate people
 * learn to ignore.
 */

const ps = () => {
  try {
    return execFileSync("ps", ["-eo", "pid=,args="], { encoding: "utf8" }).split("\n").filter(Boolean);
  } catch {
    return [];
  }
};

const self = String(process.pid);
const rows = ps()
  .map((l) => {
    const m = /^\s*(\d+)\s+(.*)$/.exec(l);
    return m ? { pid: m[1], args: m[2] } : null;
  })
  .filter((r) => r && r.pid !== self);

// A loop with no body and no sleep, however it is spelled. `sleep` anywhere in the line clears it:
// a bounded poll that sleeps is the shape this rule asks for, not the one it forbids.
const spinning = rows.filter((r) => /do\s*:\s*;\s*done|while\s+true\s*;\s*do\s*:\s*;/.test(r.args) && !/\bsleep\b/.test(r.args));
// Only what this repo's own gate starts. `next dev` is deliberately absent.
const left = rows.filter((r) => /\bnext start\b|\bnext build\b|vitest\.mjs run|e2e\/run\.mjs/.test(r.args));

for (const r of left) console.log(`· still running after the gate: ${r.pid} ${r.args.slice(0, 110)}`);

if (spinning.length > 0) {
  console.error("✗ a wait loop is spinning with no sleep and no bound:");
  for (const r of spinning) console.error(`  ${r.pid} ${r.args.slice(0, 160)}`);
  console.error("\nKill it by PID, then give the wait a sleep and a bound — or drop it and let the");
  console.error("background job's own completion notice wake you. See the ship skill, Wall clock.");
  process.exit(1);
}
