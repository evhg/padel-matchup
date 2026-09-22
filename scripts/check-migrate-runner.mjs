// Does `pnpm db:migrate` run at all?
//
// Nothing else asks. The typecheck reads scripts/migrate.ts but never executes it, no test imports
// it, and the build leaves it out, so the file went to production unrun — and the first Migrate
// workflow run failed inside esbuild on a top-level `await`, which tsx cannot compile to CommonJS.
// The database was never touched, the migration never applied, and the only evidence was a red run
// after the merge.
//
// So run the real command, the one the workflow runs, with every database variable blanked. Without
// a URL the script must refuse on its own first line and exit 1. Reaching that line proves the file
// compiles, its imports resolve and its code runs. Two seconds here, instead of a red run on main.
import { spawnSync } from "node:child_process";

const REFUSAL = "Set DIRECT_DATABASE_URL";
const BLANK = ["DIRECT_DATABASE_URL", "POSTGRES_URL_NON_POOLING", "DATABASE_URL", "POSTGRES_URL", "SUPABASE_DB_URL"];

const run = spawnSync("pnpm", ["db:migrate"], {
  encoding: "utf8",
  env: { ...process.env, ...Object.fromEntries(BLANK.map((name) => [name, ""])) },
});
const output = `${run.stdout ?? ""}${run.stderr ?? ""}`.trim();

if (!output.includes(REFUSAL)) {
  console.error("`pnpm db:migrate` never reached its own first line. It cannot apply a migration.");
  console.error(output);
  process.exit(1);
}
if (run.status !== 1) {
  console.error(`\`pnpm db:migrate\` refused, but exited ${run.status}. The workflow reads that code, so it must be 1.`);
  console.error(output);
  process.exit(1);
}
console.log("db:migrate runs, and refuses without a database URL");
