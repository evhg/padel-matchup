#!/usr/bin/env bash
# A read against this project's own database needs no permission; anything that can change it still
# asks. Reads are the frequent ones — checking a count, a row, an index — and each prompt costs wall
# clock while somebody is asleep. Writes are rare, irreversible and worth a person's tap.
#
# Runs as a PreToolUse hook on mcp__Supabase__execute_sql. It prints an "allow" decision for a read
# and prints nothing otherwise, which leaves the call to the permission system exactly as before.
set -uo pipefail

q="$(jq -r '.tool_input.query // ""' 2>/dev/null || true)"
[ -n "$q" ] || exit 0

# One line, no -- comments, lower case: enough to see how the statement starts and what it contains.
norm="$(printf '%s' "$q" | sed -E 's/--[^\n]*//g' | tr '\n\t' '  ' | tr -s ' ' | sed -E 's/^ +//' | tr '[:upper:]' '[:lower:]')"

# It must start as a read, and must not contain a word that writes anywhere in it — a CTE can carry
# an insert, and a semicolon can carry a second statement. Word boundaries keep `updated_at` and
# `offset` from matching. Anything this does not recognise simply asks, which is the safe direction.
starts_read='^(select|with|explain|show|table)[[:space:](]'
writes='\b(insert|update|delete|drop|alter|truncate|create|grant|revoke|comment|refresh|vacuum|analyze|copy|call|do|merge|set|reset|begin|commit|rollback|lock|notify|listen|prepare|execute|declare|fetch|move|reindex|cluster|import|security)\b'

if printf '%s' "$norm" | grep -Eq "$starts_read" && ! printf '%s' "$norm" | grep -Eq "$writes"; then
  printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow","permissionDecisionReason":"read-only SQL against this project'"'"'s own database"}}'
fi
exit 0
