#!/bin/bash
# Update the Mac mini from 1.159.x (or any version before 1.162.0) WITHOUT touching a pinned-by-hand project.
# Why: before 1.162.0 swarm update rewrites the pointer, refreshes hooks and the hand-build guard and may prune the
# version folder of EVERY project in ~/.project-swarm/projects.json. Version pinning only exists from 1.162.0, so the
# old updater cannot honor it. This script takes the project out of the registry for the duration of the update,
# waits for a gap between waves (the update is refused while a run is live), restores the registry entry, then pins.
#
# usage: bash mini-safe-update.sh PROJECT_ROOT [PIN_VERSION]      (PIN_VERSION defaults to 1.47.0)
#        MAX_WAIT_MIN=90 POLL_SEC=5 bash mini-safe-update.sh PROJECT_ROOT 1.47.0
# It never edits files inside the project, never uses --force, and never runs swarm update --projects.
set -u
ROOT_IN="${1:-}"; PIN="${2:-1.47.0}"
[ -n "$ROOT_IN" ] || { echo "usage: bash mini-safe-update.sh PROJECT_ROOT [PIN_VERSION]"; exit 2; }
ROOT=$(cd "$ROOT_IN" 2>/dev/null && pwd -P) || { echo "not a folder: $ROOT_IN"; exit 2; }
REG="${SWARM_PROJECTS_FILE:-$HOME/.project-swarm/projects.json}"
MAX_WAIT_MIN="${MAX_WAIT_MIN:-90}"; POLL_SEC="${POLL_SEC:-5}"
[ -f "$REG" ] || { echo "no registry at $REG"; exit 2; }
BAK="$REG.bak-before-update-$(date +%s)"
cp -p "$REG" "$BAK" || { echo "cannot back up the registry"; exit 2; }
echo "registry backup: $BAK"

# node helper: remove or restore one entry (matched by real path), atomic write
reg() {
  node -e '
const fs=require("fs");const [mode,reg,bak,root]=process.argv.slice(1);
const real=p=>{try{return fs.realpathSync(p)}catch{return p}};
const read=f=>JSON.parse(fs.readFileSync(f,"utf8"));
const cur=read(reg);const list=cur.projects||[];
if(mode==="remove"){
  const keep=list.filter(e=>real(e.root)!==root);
  const removed=list.length-keep.length;
  if(removed!==1){console.log("expected to find exactly one registry entry for "+root+", found "+removed);process.exit(3)}
  cur.projects=keep;
}else{
  if(list.some(e=>real(e.root)===root)){console.log("entry already present");process.exit(0)}
  const entry=(read(bak).projects||[]).find(e=>real(e.root)===root);
  if(!entry){console.log("no entry in the backup");process.exit(4)}
  cur.projects=[...list,entry];
}
const tmp=reg+".tmp-"+process.pid;fs.writeFileSync(tmp,JSON.stringify(cur,null,2)+"\n");fs.renameSync(tmp,reg);
console.log(mode==="remove"?"removed the entry for "+root+" from the registry":"restored the entry for "+root);
' "$1" "$REG" "$BAK" "$ROOT"
}

RESTORED=0
restore() { if [ "$RESTORED" = 0 ]; then reg restore && RESTORED=1; fi; }
trap restore EXIT   # a crash, Ctrl-C or a failed update never loses the registry entry

reg remove || { echo "stopping: registry untouched"; RESTORED=1; exit 3; }

# the old version folder, if it is still there, is parked so the installer's prune cannot delete it
PARK=""
VDIR=$(ls -d "$HOME/.project-swarm/versions/$PIN"-* 2>/dev/null | head -1)
if [ -n "$VDIR" ]; then PARK="$HOME/.project-swarm/.parked-$(basename "$VDIR")"; mv "$VDIR" "$PARK" && echo "parked $VDIR"; fi
unpark() { if [ -n "$PARK" ] && [ -d "$PARK" ]; then mv "$PARK" "$VDIR" && echo "returned $VDIR"; PARK=""; fi; }
trap 'unpark; restore' EXIT

echo "waiting for a gap between waves (the update is refused while a run is live); up to $MAX_WAIT_MIN minutes, checking every $POLL_SEC seconds"
DEADLINE=$(( $(date +%s) + MAX_WAIT_MIN*60 )); OUT=""; OK=0
while [ "$(date +%s)" -lt "$DEADLINE" ]; do
  OUT=$(swarm update 2>&1); CODE=$?
  if [ "$CODE" = 0 ] && ! echo "$OUT" | grep -qi -E "refus|busy|live run|not idle"; then OK=1; break; fi
  if ! echo "$OUT" | grep -qi -E "refus|busy|live run|not idle|running"; then echo "swarm update failed for another reason:"; echo "$OUT" | head -5 | cut -c1-200; break; fi
  sleep "$POLL_SEC"
done
[ "$OK" = 1 ] || { echo "update did not complete: the registry entry is restored by the exit handler; nothing was pinned"; exit 1; }
echo "$OUT" | head -3 | cut -c1-200
NEW=$(swarm --version 2>/dev/null | head -1)
echo "now: $NEW"

unpark
restore
echo "pinning $ROOT at $PIN"
swarm pin "$ROOT" "$PIN" || { echo "swarm pin failed: run it by hand: swarm pin $ROOT $PIN"; exit 1; }
swarm pin
echo "done. The board and swarm remote on this machine still serve the OLD version until you restart them (restart: stop swarm watch and swarm remote serve, then start them again). Do not run swarm update --projects."
