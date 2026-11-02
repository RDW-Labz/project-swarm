#!/bin/zsh
# rev.sh <batch> : in worktree ../psw-<batch>; integrates, checks, prints diff lines, runs tests
S=/private/tmp/claude-501/-Users-prime-Documents-repos-projects-project-swarm-1/5c44f70f-1cac-4bd7-86c6-4c3271f73fa7/scratchpad
B=$1; cd /Users/prime/Documents/repos-projects/psw-$B || exit 1
R=$(python3 -c "import json;print(json.loads(open('$S/run$B.log').read().strip().splitlines()[-1])['id'])")
node tools/swarm.mjs integrate $R </dev/null 2>&1 | grep -o '"status":"[a-z]*"\|"checksPassed":[a-z]*' | head -2 | tr '\n' ' '; echo
F=($(python3 -c "import json;print(' '.join(json.load(open('coordination/manifests/d-audit-fix-batch-$B.json'))['jobs'][0]['outputs']))"))
for f in $F; do node -c $f || echo "SYNTAX BAD $f"; done
grep -n "catch ([a-zA-Z_]*) { [a-zA-Z_]*; }\|catch((_[a-zA-Z]*) =>\|catch (_[a-zA-Z]*) {\|void error" $F && echo "ANTIPATTERN HIT"
echo "changed: $(git diff --name-only -- tools | tr '\n' ' ')"
git diff -U0 -- $F | grep "^[-+]" | grep -v "^+++\|^---" | cut -c1-230
cat $S/ig-$B.txt | xargs node --import ./tests/_isolate-config.mjs --test > $S/t$B.log 2>&1
grep -E "^# (pass|fail)|^not ok" $S/t$B.log
P=$(echo $F | tr ' ' '\n' | sed 's/^/\\[/;s/$/\\]/' | paste -sd'|' -)
grep -oE "($P)[^:]*:.{0,90}" $S/t$B.log | sort | uniq -c | head -8
