#!/usr/bin/env bash
# Does the schema still say what the migrations say?
#
# drizzle-kit generate is asked for a migration into a throwaway copy of drizzle/. If it writes one,
# a table or a column changed in src/db/schema without the migration that carries the change to
# production, and CI fails here rather than at the next deploy. The repository is left untouched.
#
#   bash scripts/check-migrations.sh
#
# Two things this script does not trust: drizzle-kit exits 0 even when it throws (so the log is read
# for its own "no changes" line), and it resolves `out` against the working directory with a "./"
# in front (so the throwaway copy lives here, not in /tmp).
set -euo pipefail
cd "$(dirname "$0")/.."
work=".drift-check"
rm -rf "$work"
trap 'rm -rf "$work"' EXIT
mkdir -p "$work"
cp -r drizzle "$work/drizzle"
cat > "$work/drizzle.config.ts" <<'CONF'
import { defineConfig } from "drizzle-kit";
export default defineConfig({
  schema: "./src/db/schema/index.ts",
  out: "./.drift-check/drizzle",
  dialect: "postgresql",
  dbCredentials: { url: "postgres://localhost:5432/unused-by-generate" },
});
CONF
log="$work/generate.log"
pnpm exec drizzle-kit generate --config "$work/drizzle.config.ts" --name drift_check > "$log" 2>&1 || true
new=$(find "$work/drizzle" -maxdepth 1 -name "*drift_check.sql" | head -1)
if [ -n "$new" ]; then
  echo "✗ src/db/schema and drizzle/ have drifted. The migration drizzle-kit wanted to write:"
  echo
  cat "$new"
  echo
  echo "Run pnpm db:generate, then apply the SQL to production by hand as AGENTS.md rule 7 asks."
  exit 1
fi
# No migration written can also mean the run died. Only its own "no changes" line proves it looked.
if ! grep -qi "No schema changes" "$log"; then
  echo "✗ drizzle-kit did not report on the schema. Its output:"
  echo
  tail -30 "$log"
  exit 1
fi
echo "✓ schema and migrations agree ($(find drizzle -maxdepth 1 -name '*.sql' | wc -l | tr -d ' ') migrations)"
