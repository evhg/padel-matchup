#!/usr/bin/env bash
# The local gate: what every push must pass before it leaves the machine.
#   bash scripts/gate.sh                 typecheck, lint, the unit suite (about two minutes)
#   GATE_E2E=levels bash scripts/gate.sh the same, then a production build and that one browser suite
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
step typecheck pnpm typecheck
step lint pnpm lint
step "unit tests" pnpm test
if [ -n "${GATE_E2E:-}" ]; then
  step "production build" env APP_BASE_URL=http://localhost:3001 NEXT_TELEMETRY_DISABLED=1 pnpm build
  step "browser suite: $GATE_E2E" env E2E_ONLY="$GATE_E2E" pnpm e2e
fi
echo "gate passed"
