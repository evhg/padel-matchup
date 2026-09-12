#!/usr/bin/env bash
# The local gate: what every push must pass before it leaves the machine.
#   bash scripts/gate.sh                 typecheck, lint, schema vs migrations, the unit suite (about two minutes)
#   GATE_E2E=auto bash scripts/gate.sh   the same, then a build and the browser suites this change can break
#   GATE_E2E=levels bash scripts/gate.sh the same, but that one suite (a list works too: telegram,coach)
#   GATE_E2E=all bash scripts/gate.sh    the same, with every suite
# The Claude Code hook in .claude/settings.json runs this before any `git push` and blocks the push when it fails.
set -uo pipefail
cd "$(dirname "$0")/.."
log=$(mktemp)
trap 'rm -f "$log"' EXIT
step() {
  local name=$1; shift
  local t=$SECONDS
  if "$@" > "$log" 2>&1; then
    echo "✓ $name ($((SECONDS - t))s)"
  else
    echo "✗ $name ($((SECONDS - t))s)"
    tail -60 "$log"
    exit 1
  fi
}
# A branch started from a stale main is how a green pull request lands on a red main. Say so, never block:
# the fetch may be offline, and merging main is the author's call.
if git fetch -q origin main 2>/dev/null; then
  behind=$(git rev-list --count HEAD..origin/main 2>/dev/null || echo 0)
  [ "$behind" -gt 0 ] && echo "· origin/main is $behind commit(s) ahead: merge it before the pull request"
fi
step typecheck pnpm typecheck
step lint pnpm lint
step "schema vs migrations" bash scripts/check-migrations.sh
step "unit tests" pnpm test
if [ -n "${GATE_E2E:-}" ]; then
  suites=$GATE_E2E
  if [ "$suites" = "auto" ]; then
    suites=$(node scripts/suites.mjs 2>/dev/null || echo all)
    [ -z "$suites" ] && echo "· no browser suite can be broken by this change" || echo "· browser suites for this change: $suites"
  fi
  if [ -n "$suites" ]; then
    step "production build" env APP_BASE_URL=http://localhost:3001 NEXT_TELEMETRY_DISABLED=1 pnpm build
    step "browser suites: $suites" env E2E_ONLY="$suites" pnpm e2e
  fi
fi
echo "gate passed"
