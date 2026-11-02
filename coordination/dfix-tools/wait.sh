#!/bin/zsh
# wait.sh <runlog> : waits until the run log has a final summary
until [ -s $1 ] && python3 -c "import json,sys;d=json.loads(open('$1').read().strip().splitlines()[-1]);sys.exit(0 if d.get('status') not in ('running','queued') else 1)" 2>/dev/null; do sleep 5; done
python3 -c "import json;d=json.loads(open('$1').read().strip().splitlines()[-1]);print(d.get('id'),d.get('status'))"
