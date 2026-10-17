#!/usr/bin/env node
// What does one deployment weigh?
//
//   node scripts/check-bundle.mjs          fail if a route got fat or carries something dev-only
//   node scripts/check-bundle.mjs --why    the same, plus the heaviest routes and what is in them
//
// Vercel's function storage is metered and cumulative: every deployment keeps its own copy of every
// function it built, and the meter only goes down when deployments are deleted. On 14 September 2026
// it reached 75% of the 10 GB on the free plan, and the cause was not traffic. It was 18 MB of
// @electric-sql/pglite — the test database — traced into 216 of 224 routes. `createPgliteDb()` throws
// before importing it when onVercel(), so that code cannot run in production; the file tracer follows
// the import statement, not the guard above it. Nothing failed. Nothing could have: no check read what
// the build actually produced.
//
// This is that check. It reads the tracing manifests Next writes next to each route — the real list of
// files that route ships — so it cannot be fooled by a config that looks right.
import { globSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

/** Never belongs in a function. Each of these is a build-time or test-time tool. */
const DEV_ONLY = [
  ["@electric-sql/pglite", "the test and local database; production is postgres-js against Supabase"],
  ["node_modules/vitest", "the unit test runner"],
  ["node_modules/playwright", "the browser test runner"],
  ["node_modules/drizzle-kit", "generates migrations; the runtime only reads the journal and the .sql"],
  ["node_modules/typescript", "compiles; nothing at runtime asks it anything"],
  ["node_modules/eslint", "lints"],
];

/**
 * One route may weigh this much. The heaviest today is 5.0 MB and the median 3.0 MB; the headroom is
 * for an honest new dependency, not for a 10 MB surprise. Raising this is a decision with a cost —
 * multiply any increase by every route and every deployment ever kept — so say why in the commit.
 */
const MAX_ROUTE_BYTES = 8 * 1000 * 1000;

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const why = process.argv.includes("--why");
const manifests = globSync("**/*.nft.json", { cwd: path.join(root, ".next/server") }).map((f) => path.join(root, ".next/server", f));

if (manifests.length === 0) {
  console.error("✗ no tracing manifests under .next/server — run `pnpm build` first.");
  process.exit(1);
}

const size = (p) => {
  try {
    return statSync(p).size;
  } catch {
    return 0; // A traced file that is gone is the packager's business, not this check's.
  }
};

const routes = manifests.map((m) => {
  const base = path.dirname(m);
  const files = JSON.parse(readFileSync(m, "utf8")).files.map((rel) => path.normalize(path.join(base, rel)));
  return {
    name: path.relative(path.join(root, ".next/server"), m).replace(/\.nft\.json$/, ""),
    files,
    bytes: files.reduce((n, f) => n + size(f), 0),
  };
});
routes.sort((a, b) => b.bytes - a.bytes);

const mb = (n) => `${(n / 1e6).toFixed(1)} MB`;
const problems = [];

for (const [needle, reason] of DEV_ONLY) {
  const hit = routes.filter((r) => r.files.some((f) => f.includes(needle)));
  if (hit.length === 0) continue;
  const weight = hit[0].files.filter((f) => f.includes(needle)).reduce((n, f) => n + size(f), 0);
  problems.push(`${needle} is traced into ${hit.length} route(s), ${mb(weight)} each — ${reason}.\n     first: ${hit[0].name}`);
}

// One cause makes every route fat at once, so list a few and count the rest: a hundred identical
// lines bury the line above them that says why.
const fat = routes.filter((r) => r.bytes > MAX_ROUTE_BYTES);
for (const r of fat.slice(0, 3)) problems.push(`${r.name} weighs ${mb(r.bytes)}, over the ${mb(MAX_ROUTE_BYTES)} a route may weigh.`);
if (fat.length > 3) problems.push(`…and ${fat.length - 3} more route(s) over ${mb(MAX_ROUTE_BYTES)}.`);

/**
 * Loaded when it is used, never when a route starts. A route's server entry loads every chunk in the
 * list at the end of its `page.js` or `route.js` before it answers, whatever the request needs. The
 * server actions a page carries count too, so web-push and its crypto started with 90 of the 140 route
 * entries, the match page and My matches among them, where nothing but `pushEnabled()` ran (16 October
 * 2026). Each row: the package, a string only its own code holds, and where it is loaded instead.
 */
const ON_USE = [["web-push", "The GCM API Key should be a non-empty string or null.", "src/lib/push.ts imports it on the first send"]];
const serverDir = path.join(root, ".next/server");
const chunkHas = new Map();
const holds = (id, marker) => {
  const key = `${id}\0${marker}`;
  if (!chunkHas.has(key)) chunkHas.set(key, readFileSync(path.join(serverDir, "chunks", `${id}.js`), "utf8").includes(marker));
  return chunkHas.get(key);
};
// readdirSync, not globSync: "**" passes over a dot directory, and `.well-known` holds two routes.
const entries = readdirSync(path.join(serverDir, "app"), { recursive: true })
  .map((f) => path.join("app", String(f)))
  .filter((f) => /(^|\/)(page|route)\.js$/.test(f))
  .map((f) => ({ name: f, chunks: (readFileSync(path.join(serverDir, f), "utf8").match(/\.X\(0,\[([0-9,]*)\]/)?.[1] ?? "").split(",").filter(Boolean) }));
const atStart = [];
for (const [pkg, marker, instead] of ON_USE) {
  // A marker that is in no chunk at all proves nothing: the package changed its words, or left the build.
  const anywhere = globSync("chunks/*.js", { cwd: serverDir }).some((f) => readFileSync(path.join(serverDir, f), "utf8").includes(marker));
  if (!anywhere) atStart.push(`${pkg}: its marker is in no chunk of this build, so this check reads nothing. Find a string its code still holds.`);
  const hit = entries.filter((e) => e.chunks.some((id) => holds(id, marker)));
  if (hit.length) atStart.push(`${pkg} loads at the start of ${hit.length} of ${entries.length} route entries; ${instead}.\n     first: ${hit[0].name}`);
}

if (why || problems.length) {
  console.log(`${routes.length} routes · heaviest ${mb(routes[0].bytes)} · median ${mb(routes[Math.floor(routes.length / 2)].bytes)}`);
  for (const r of routes.slice(0, why ? 8 : 3)) console.log(`  ${mb(r.bytes).padStart(8)}  ${r.name}`);
}

if (problems.length) {
  console.error("\n✗ something that cannot run in production is shipping in the functions:\n");
  for (const p of problems) console.error(`  ·  ${p}`);
  console.error(`
  Fix it in next.config.ts with outputFileTracingExcludes, then rebuild and run this again.
  Two traps, both paid for already:
    · "/**/*" does not match "/". The landing page needs its own key or it keeps everything.
    · Excluding a package from tracing does not remove it from node_modules, so the browser
      suites and local dev still have it. Check the numbers, not the config.
`);
  process.exit(1);
}

if (atStart.length) {
  console.error("\n✗ a package that only one rare step uses loads at the start of routes:\n");
  for (const p of atStart) console.error(`  ·  ${p}`);
  console.error(`
  A static import anywhere on the way from a page or its server actions puts the package in the
  route's start. Import it where it is used (\`await import("…")\`), then rebuild and run this again.
`);
  process.exit(1);
}

console.log(`✓ functions are lean (${routes.length} routes, heaviest ${mb(routes[0].bytes)}; ${ON_USE.map(([p]) => p).join(", ")} in no route's start)`);
