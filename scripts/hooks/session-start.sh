#!/usr/bin/env bash
# Claude Code SessionStart hook: before any work, say how this copy stands against GitHub.
#
# The owner's rule (23 September 2026): when you start on a machine, sync it with the repository
# first; when you stop, everything is on GitHub. The stop side already has a check. This is the start
# side. It prints a few lines into the session's context and nothing else: it never fails the session,
# never changes a branch, and never prints a secret's value, only its name.
set -u
cd "${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}" 2>/dev/null || exit 0
git rev-parse --git-dir >/dev/null 2>&1 || exit 0
say() { printf 'start check: %s\n' "$*"; }

branch=$(git rev-parse --abbrev-ref HEAD 2>/dev/null)
if timeout 20 git fetch -q origin main 2>/dev/null; then
  behind=$(git rev-list --count HEAD..origin/main 2>/dev/null || echo 0)
  ahead=$(git rev-list --count origin/main..HEAD 2>/dev/null || echo 0)
  if [ "$behind" = 0 ]; then
    if [ "$ahead" = 0 ]; then say "$branch is up to date with origin/main."; else say "$branch is up to date with origin/main, with $ahead commit(s) of its own to push."; fi
  elif [ "$ahead" = 0 ]; then
    say "$branch is $behind commit(s) behind origin/main. Start from main before building: git fetch origin main && git checkout -B $branch origin/main"
  elif git diff --quiet HEAD origin/main 2>/dev/null; then
    # The usual case after a squash merge: the commits are main's already, under other ids.
    say "$branch holds the same files as origin/main; its $ahead commit(s) are history main squashed. Start from main: git checkout -B $branch origin/main"
  else
    say "$branch has $ahead commit(s) main does not, and is $behind behind. Merge origin/main into it before building on it."
  fi
else
  say "GitHub could not be reached, so this copy may be behind origin/main."
fi

changed=$(git status --porcelain 2>/dev/null | wc -l | tr -d ' ')
[ "$changed" != 0 ] && say "$changed file(s) are changed and not committed."

# Dependencies: install only when they are missing or older than the lockfile, so a warm start costs
# nothing and a fresh container can run the gate at once.
if [ -f pnpm-lock.yaml ] && { [ ! -f node_modules/.modules.yaml ] || [ pnpm-lock.yaml -nt node_modules/.modules.yaml ]; }; then
  if command -v pnpm >/dev/null 2>&1 && pnpm install --frozen-lockfile --prefer-offline >/dev/null 2>&1; then
    say "dependencies installed from pnpm-lock.yaml."
  else
    say "dependencies are missing or stale, and pnpm install did not finish. Run: pnpm install"
  fi
fi

# The session's environment contract (docs/OPERATING.md, "What the session's environment must hold").
missing=()
for v in CRON_SECRET RESEND_API_KEY VERCEL_TOKEN; do
  [ -n "${!v:-}" ] || missing+=("$v")
done
if [ ${#missing[@]} -gt 0 ]; then
  say "not set here: ${missing[*]}. The operator endpoints, the read-only query door and the Resend log need them (docs/OPERATING.md)."
fi
exit 0
