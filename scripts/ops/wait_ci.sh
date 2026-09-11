#!/bin/bash
# Waits for the pull-request CI run of a commit. Usage: wait_ci.sh <branch> <full sha> [max polls of 30 s].
# usage: wait_ci.sh <branch> <full sha> [max polls]  -> prints "CI <branch> <sha>: <conclusion> run=<id>"
b="$1"; s="$2"; max="${3:-30}"
for i in $(seq 1 "$max"); do
  r=$(curl -s -m 20 "https://api.github.com/repos/evhg/padel-matchup/actions/runs?branch=$b&event=pull_request&head_sha=$s")
  n=$(echo "$r" | python3 -c "import sys,json;d=json.load(sys.stdin);rs=d.get('workflow_runs',[]);print(rs[0]['status']+' '+str(rs[0]['conclusion'])+' '+str(rs[0]['id']) if rs else 'none')" 2>/dev/null)
  case "$n" in completed*) echo "CI $b ${s:0:7}: ${n#completed }"; exit 0;; esac
  sleep 30
done
echo "CI $b ${s:0:7}: timeout ($n)"
