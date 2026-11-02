#!/bin/zsh
# usage: ship.sh <batch> <title-files> <body-file> ; run inside worktree; files = outputs in manifest
set -e
B=$1; T=$2; BODY=$3
git checkout -- 'coordination/HANDOFF*.md' docs/state/usage-ledger.md 2>/dev/null || true
FILES=($(python3 -c "import json;print(' '.join(json.load(open('coordination/manifests/d-audit-fix-batch-$B.json'))['jobs'][0]['outputs']))"))
git add $FILES coordination/manifests/d-audit-fix-batch-$B.json
git commit -q -m "D-fix batch $B: log swallowed errors in $T" -m "Goal g-33a7a4ae. Logging only, no control-flow change. See PR body for per-line handling." -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01DqM1EMFumDkihnGrvDSCzQ"
git fetch -q origin && git rebase -q origin/main
git push -q -u origin d-audit-fix-batch-$B 2>&1 | grep -v "^remote:" || true
printf '%s\n\nDo not merge by hand: for release train 3. No version bump.\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)\n\nhttps://claude.ai/code/session_01DqM1EMFumDkihnGrvDSCzQ\n' "$(cat $BODY)" > $BODY.full
gh pr create --base main --head d-audit-fix-batch-$B --title "D-fix batch $B: $T silent catches (logging only)" --body-file $BODY.full
WT=$PWD; cd /Users/prime/Documents/repos-projects/project-swarm-1 && git worktree remove $WT && echo wt-removed
