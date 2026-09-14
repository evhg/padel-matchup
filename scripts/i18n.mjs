#!/usr/bin/env node
// Add one message to all three locale files, without reformatting them.
//
//   node scripts/i18n.mjs add push.refillTitle "A spot opened" "Освободилось место" "Se ha liberado"
//
// Rule 2 says every string exists in every locale. Getting there by hand has gone wrong three ways,
// each of which cost a cycle: a JSON load-and-dump reformatted the compact single-line blocks and
// turned a three-key change into fifty-seven changed lines; a hand-rolled comma fix corrupted en.json;
// and keys landed in `coach.home` when they were meant for `coach.page`, because the insertion point
// was found by counting lines instead of by name.
//
// So: never parse-and-serialise. Find an existing sibling key by name, copy its indentation, and put
// one line after it. The files stay byte-identical everywhere else, and the diff is one line per file.
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const LOCALES = ["en", "ru", "es"];
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const [cmd, key, ...values] = process.argv.slice(2);

if (cmd !== "add" || !key || values.length !== LOCALES.length) {
  console.error(`usage: node scripts/i18n.mjs add <dotted.key> ${LOCALES.map((l) => `"<${l}>"`).join(" ")}`);
  process.exit(1);
}

const parts = key.split(".");
const leaf = parts.at(-1);
const parentPath = parts.slice(0, -1);
if (parentPath.length === 0) {
  console.error("✗ give a key inside a section, like push.refillTitle — a top-level key is never what you want.");
  process.exit(1);
}

const file = (l) => path.join(root, "messages", `${l}.json`);

// Read every file and work out the edit before writing any of them: three files half-changed is worse
// than none changed.
let edits;
try {
  edits = LOCALES.map((locale, i) => {
    const p = file(locale);
    const text = readFileSync(p, "utf8");
    const data = JSON.parse(text);

    let node = data;
    for (const seg of parentPath) {
      node = node?.[seg];
      if (node === undefined) throw new Error(`${locale}.json has no section "${parentPath.join(".")}"`);
    }
    if (typeof node !== "object" || node === null) throw new Error(`${locale}.json: "${parentPath.join(".")}" is not a section`);
    if (leaf in node) throw new Error(`${locale}.json already has ${key} — this adds, it does not overwrite`);

    const siblings = Object.keys(node);
    if (siblings.length === 0) throw new Error(`${locale}.json: "${parentPath.join(".")}" is empty; add the first key by hand`);

    // The last sibling is the anchor: one line, one key, and the new line goes after it.
    const anchor = siblings.at(-1);
    const lines = text.split("\n");
    const hits = lines.map((l, n) => [l, n]).filter(([l]) => new RegExp(`^\\s*${JSON.stringify(anchor)}\\s*:`).test(l));
    if (hits.length !== 1) {
      throw new Error(`${locale}.json: "${anchor}" appears ${hits.length} times as a key — anchor is ambiguous, add ${key} by hand`);
    }
    const [line, n] = hits[0];
    if (!line.trimEnd().endsWith(",") && !line.trimEnd().endsWith("}") && !line.includes("}")) {
      throw new Error(`${locale}.json: the line for "${anchor}" is not a whole entry; add ${key} by hand`);
    }
    if (/\{.*:.*\}/.test(line) && !line.trimStart().startsWith(JSON.stringify(anchor))) {
      throw new Error(`${locale}.json: "${parentPath.join(".")}" is written inline; add ${key} by hand`);
    }

    const indent = line.slice(0, line.length - line.trimStart().length);
    const needsComma = !line.trimEnd().endsWith(",");
    const before = needsComma ? lines[n].replace(/\s*$/, "") + "," : lines[n];
    const added = `${indent}${JSON.stringify(leaf)}: ${JSON.stringify(values[i])}`;
    const next = [...lines.slice(0, n), before, added, ...lines.slice(n + 1)].join("\n");

      JSON.parse(next); // Never write a file that stopped being JSON.
      return { p, locale, next, anchor };
  });
} catch (e) {
  // A stack trace here teaches nothing: the message already says which file and why.
  console.error(`✗ ${e.message}`);
  process.exit(1);
}

for (const e of edits) writeFileSync(e.p, e.next);

// Rule 2, proven rather than assumed.
const keysOf = (o, p = "") => Object.entries(o).flatMap(([k, v]) => (v && typeof v === "object" ? keysOf(v, `${p}${k}.`) : [`${p}${k}`]));
const sets = LOCALES.map((l) => new Set(keysOf(JSON.parse(readFileSync(file(l), "utf8")))));
const missing = LOCALES.flatMap((l, i) => [...sets[0]].filter((k) => !sets[i].has(k)).map((k) => `${l}: ${k}`));
if (missing.length) {
  console.error("✗ the locales no longer carry the same keys:", missing.slice(0, 5));
  process.exit(1);
}
console.log(`✓ ${key} added to ${LOCALES.join(", ")} (after "${edits[0].anchor}"), one line each`);
