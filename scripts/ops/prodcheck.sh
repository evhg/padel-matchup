#!/usr/bin/env bash
# The production check in one call: health, errors, services, open notes, research desk, main CI, deploy. Secrets come from the environment (CRON_SECRET or OPERATOR_TOKEN, VERCEL_TOKEN), never from files.
set -u
B=${KICKSMASH_BASE:-https://kicksma.sh}; T=${OPERATOR_TOKEN:-${CRON_SECRET:?set CRON_SECRET or OPERATOR_TOKEN in the environment}}
# One retry: the first admin call after a quiet spell can outlast a cold function.
j() { local out; out=$(curl -s -m 40 -H "Authorization: Bearer $T" "$B$1"); [ -n "$out" ] || out=$(curl -s -m 40 -H "Authorization: Bearer $T" "$B$1"); printf '%s' "$out"; }
echo "== health"; curl -s -m 20 $B/api/health | head -c 300; echo
echo "== errors"; j /api/admin/errors | python3 -c 'import json,sys; d=json.load(sys.stdin); print("open:",d.get("open"),"week:",d.get("week")); [print(" -",str(x.get("lastAt") or x.get("at",""))[:16],x.get("scope"),str(x.get("message",""))[:140],"x",x.get("count")) for x in d.get("errors",[])[:8]]'
echo "== services"; j /api/admin/services | python3 -c '
import json,sys; d=json.load(sys.stdin)
for r in d.get("rows",[]):
    st=r.get("state"); flag="" if st in ("ok","info",None) else " <<<"
    print(" -",r.get("name"),st,(str(r.get("pct"))+"%" if r.get("pct") is not None else ""),str(r.get("usage") or "")[:80]+flag)'
echo "== feedback new/ack/planned"; j "/api/admin/feedback?status=new,acknowledged,planned" | python3 -c 'import json,sys; d=json.load(sys.stdin); n=d.get("notes",d if isinstance(d,list) else []); print("open notes:",len(n)); [print(" -",x.get("id","")[:8],x.get("status"),x.get("channel"),x.get("role"),str(x.get("text",""))[:120]) for x in n[:10]]'
echo "== research"; j /api/admin/research | python3 -c 'import json,sys; d=json.load(sys.stdin); m=d.get("meter",{}); p=d.get("pace",{}); runs=d.get("runs",[]); print("used",m.get("used"),"/",m.get("limit"),"allowanceNow",p.get("allowanceNow"),"runs",len(runs),"runs>=2:",sum(1 for r in runs if (r.get("runs") or 0)>=2),"errors:",sum(1 for r in runs if r.get("lastError")),"last:",max((r.get("lastRunAt","") for r in runs),default="")[:16])'
echo "== main CI (last 3 push runs)"; curl -s -m 20 "https://api.github.com/repos/evhg/padel-matchup/actions/runs?branch=main&event=push&per_page=3" | python3 -c 'import json,sys; [print(" -",r["head_sha"][:7],r["conclusion"],r["run_started_at"][5:16]) for r in json.load(sys.stdin)["workflow_runs"]]'
echo "== deploy"; curl -s -m 20 -H "Authorization: Bearer $VERCEL_TOKEN" "https://api.vercel.com/v6/deployments?projectId=prj_k6h2RvaKtYcsMWasiriv33lCmgLg&teamId=team_CYcDIbyEAhB8Uob1LpJXxxS4&limit=1&target=production" | python3 -c 'import json,sys; d=json.load(sys.stdin)["deployments"][0]; print(" -",d["state"],d.get("meta",{}).get("githubCommitSha","")[:7],d.get("meta",{}).get("githubCommitMessage","")[:70])'
