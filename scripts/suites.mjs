#!/usr/bin/env node
// Which browser suites can a change actually break?
//
//   node scripts/suites.mjs                        the suites for the working tree against origin/main
//   node scripts/suites.mjs origin/main..HEAD      the suites for a range (CI passes base...head)
//   node scripts/suites.mjs --files a.ts b.md      the suites for these paths, git untouched
//   node scripts/suites.mjs --why                  any of the above, with the reason for each suite
//
// Prints a comma-separated list for E2E_ONLY, or "all". The default is deliberately pessimistic: a
// path no rule below claims runs every suite, because a wrong "nothing to run" costs a red main and a
// wrong "run everything" costs two minutes. Add a rule when a path proves itself narrow, never to make
// a run shorter.
import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import path from "node:path";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const ALL = readdirSync(path.join(root, "e2e"))
  .filter((f) => f.endsWith(".mjs") && !["run.mjs", "lib.mjs"].includes(f))
  .map((f) => f.replace(/\.mjs$/, ""))
  .sort();

/** [what the path matches, the suites that cover it, why]. First match wins, and a file may match several. */
const RULES = [
  [/^e2e\/lib\.mjs$/, ALL, "every suite imports the helpers"],
  [/^e2e\/run\.mjs$/, ALL, "the runner boots the server for every suite"],
  [/^e2e\/([a-z]+)\.mjs$/, (m) => [m[1]], "the suite itself"],

  // Documents, configuration and tooling that no browser journey reads.
  [/^(README|ROADMAP|CONTRIBUTING|SECURITY|AGENTS)\.md$/, [], "a document"],
  [/^docs\//, [], "a document"],
  [/^\.github\//, [], "CI configuration, which CI itself re-reads"],
  [/^\.claude\//, [], "Claude Code configuration and skills, which the running app never reads"],
  [/^scripts\//, [], "tooling outside the app"],
  [/^tests\//, [], "the unit suite, which the gate runs anyway"],
  [/^\.env\.example$/, [], "an example file"],

  // A channel and its bot.
  [/^src\/lib\/telegram\//, ["telegram", "coach"], "the Telegram bot, which the coach's assistant lives in"],
  [/^src\/lib\/channels\/telegram\.ts$/, ["telegram"], "the Telegram adapter"],
  [/^src\/lib\/discord\//, ["discord"], "the Discord bot"],
  [/^src\/lib\/channels\/discord\.ts$/, ["discord"], "the Discord adapter"],
  [/^src\/lib\/channels\//, ["telegram", "discord"], "the shared card algorithm, so every channel"],
  [/^src\/app\/api\/telegram\//, ["telegram", "coach"], "the Telegram routes"],
  [/^src\/app\/api\/discord\//, ["discord"], "the Discord routes"],

  // Areas with a suite of their own.
  [/^src\/(lib\/coach|app\/coach|app\/c)\//, ["coach"], "the coach's book"],
  [/^src\/lib\/domain\/coaching\.ts$/, ["coach"], "the coach's rules"],
  [/^src\/components\/coach\//, ["coach"], "the coach's screens, which only the coach journey opens"],
  [/^src\/actions\/coach\.ts$/, ["coach", "telegram"], "the coach's writes, which the bot shares"],
  [/^src\/lib\/domain\/(clubs|venueBoard)\.ts$/, ["clubs", "venues"], "clubs and their boards"],
  [/^src\/lib\/booking\//, ["clubs"], "booking platforms and availability"],
  [/^src\/lib\/domain\/series\.ts$/, ["series"], "series"],
  [/^src\/lib\/domain\/(passport|profile)\.ts$/, ["passport"], "the player passport"],
  [/^src\/lib\/domain\/(levels|rating|requests)\.ts$/, ["levels", "passport"], "the level, which the passport draws"],
  [/^src\/lib\/domain\/groups\.ts$/, ["groups"], "groups"],
  [/^src\/lib\/domain\/formats\.ts$/, ["formats", "americano"], "the tournament formats"],
  [/^src\/lib\/(api|embed)\//, ["agents", "embeds"], "the public API and the embeds over it"],
  [/^src\/app\/(mcp|developers|agents)\//, ["agents"], "the agent-native surfaces"],
  [/^src\/app\/embed\//, ["embeds"], "the embeds"],
  [/^src\/lib\/(listen|research|outreach)\//, ["seo"], "the answer pages these grow"],
  [/^src\/app\/(answers|americano|levels)\//, ["seo"], "the indexable pages"],
  [/^src\/(app\/sitemap|app\/robots|lib\/indexnow)/, ["seo"], "what crawlers read"],
  [/^src\/lib\/domain\/(praise|moments|result)\.ts$/, ["viral"], "what happens after the final point"],
  [/^src\/app\/\[code\]\/(card|story)\//, ["viral"], "the result card"],
];

function suitesFor(file) {
  const hits = [];
  for (const [re, suites, why] of RULES) {
    const m = re.exec(file);
    if (!m) continue;
    const list = typeof suites === "function" ? suites(m) : suites;
    hits.push({ suites: list.filter((s) => ALL.includes(s)), why });
  }
  // No rule claims it: it could be anything the app renders, so everything runs.
  if (!hits.length) return [{ suites: ALL, why: "no rule claims this path, so every suite" }];
  return hits;
}

const args = process.argv.slice(2);
const why = args.includes("--why");
const at = args.indexOf("--files");
// Lines as git printed them: `git status --porcelain` puts the path in a fixed column, so trimming
// first would eat the leading "." of a path like ".claude/skills/ship/SKILL.md".
const git = (...a) => execFileSync("git", a, { cwd: root, encoding: "utf8" }).split("\n").filter((l) => l.trim() !== "");
/** `XY path`, or `R  old -> new` for a rename: the path is everything past the two status columns. */
const statusPath = (line) => {
  const p = line.slice(3).trim();
  const renamed = p.split(" -> ").pop();
  return renamed.replace(/^"|"$/g, "");
};
let files;
if (at >= 0) {
  files = args.slice(at + 1).filter((a) => !a.startsWith("--"));
} else {
  const range = args.find((a) => !a.startsWith("--"));
  // Committed changes against the base, plus whatever is still uncommitted or untracked here.
  files = range ? git("diff", "--name-only", range).map((l) => l.trim()) : [...git("diff", "--name-only", "origin/main...HEAD").map((l) => l.trim()), ...git("status", "--porcelain").map(statusPath)];
}
files = files.filter(Boolean);

const chosen = new Set();
const reasons = new Map();
for (const f of [...new Set(files)]) {
  for (const { suites, why: reason } of suitesFor(f)) {
    for (const s of suites) {
      chosen.add(s);
      if (!reasons.has(s)) reasons.set(s, `${f}: ${reason}`);
    }
  }
}

const out = [...chosen].sort();
if (why) {
  console.error(`${files.length} changed file(s) → ${out.length === ALL.length ? "every suite" : out.length ? out.length + " suite(s)" : "no suite"}`);
  for (const s of out) console.error(`  ${s}  (${reasons.get(s)})`);
}
console.log(out.length === ALL.length ? "all" : out.join(","));
