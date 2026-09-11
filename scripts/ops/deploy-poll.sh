#!/bin/bash
# Polls the production deployment for a commit until it is READY, ERROR or CANCELED. Usage: deploy-poll.sh <sha prefix> <log file>; needs VERCEL_TOKEN in the environment.
SHA="$1"; OUT="$2"
for i in $(seq 1 60); do
  R=$(curl -sS -H "Authorization: Bearer $VERCEL_TOKEN" "https://api.vercel.com/v6/deployments?projectId=prj_k6h2RvaKtYcsMWasiriv33lCmgLg&teamId=team_CYcDIbyEAhB8Uob1LpJXxxS4&target=production&limit=6")
  LINE=$(echo "$R" | python3 -c "import sys,json; d=json.load(sys.stdin); print(next(((x['state'], x['url'], x.get('readyState')) for x in d.get('deployments',[]) if (x.get('meta') or {}).get('githubCommitSha','').startswith('$SHA')), 'none'))")
  echo "$(date -u +%H:%M:%S) $LINE" >> "$OUT"
  case "$LINE" in *READY*|*ERROR*|*CANCELED*) break;; esac
  sleep 20
done
