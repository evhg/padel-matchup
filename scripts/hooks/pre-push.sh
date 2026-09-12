#!/usr/bin/env bash
# Claude Code PreToolUse hook on the Bash tool: before any `git push`, run scripts/gate.sh and block the push when it fails.
# Reads the tool call as JSON on stdin; anything that is not a push passes through untouched. Exit 2 tells Claude Code to
# refuse the command and hands the reason on stderr back to the model.
set -u
input=$(cat)
# A push is `git push` where a command starts: a line, or after ; && || | ( do then else. The words inside a commit
# message or a heredoc do not count.
is_push=$(printf '%s' "$input" | node -e 'let d="";process.stdin.on("data",(c)=>(d+=c)).on("end",()=>{let cmd="";try{cmd=String(JSON.parse(d).tool_input?.command??"")}catch{}process.stdout.write(/(^|[;&|(]|\b(?:do|then|else)\b)\s*git\s+push\b/m.test(cmd)?"1":"0")})')
[ "$is_push" = "1" ] || exit 0
root=$(git rev-parse --show-toplevel 2>/dev/null) || exit 0
cd "$root"
echo "gate before push: typecheck, lint, unit tests" >&2
if bash scripts/gate.sh >&2; then
  exit 0
fi
echo "The gate failed, so the push was not run. Fix the failure above, then push again." >&2
exit 2
