#!/usr/bin/env python3
"""File-ownership guard for manually run Cursor workers.
Track Cursor claims alongside visible swarm runs to refuse overlapping file ownership
and check a worker's changes before merging. A swarm-run cursor job (manifest
`agent: "cursor"`) is an ordinary swarm job: it shows on `swarm board`, so its outputs
refuse a manual claim here, and it never needs (or takes) a claim of its own.

  claim   <job> <file>...       refuse if a live swarm run writes the file or another claim holds it
  check   <job> <worktree>      before merge: worktree changed only claimed files; main did not move under them
  release <job>                 after merge
  check-manifest <manifest>     before any swarm run: refuse if a job output is claimed by Cursor
  list

Env: SWARM (default: node <pinned swarm.mjs, or this install's sibling swarm.mjs>),
REPO (default: cwd).
Exit 0 = ok, 1 = refused, 2 = usage error.
"""
import json, os, subprocess, sys

REPO = os.path.abspath(os.environ.get("REPO", os.getcwd()))
CLAIMS = os.path.join(REPO, "coordination", "cursor-claims.json")
def _pinned_swarm():
    import glob
    try:
        with open(os.path.join(REPO, ".project-swarm.json")) as fh:
            pin = json.load(fh)
    except FileNotFoundError:
        return os.path.join(os.path.dirname(os.path.abspath(__file__)), "swarm.mjs")
    hits = sorted(glob.glob(os.path.join(os.path.expanduser(pin.get("install", "~/.project-swarm")), "versions", pin["version"] + "-*", "tools", "swarm.mjs")))
    if not hits:
        raise SystemExit("pinned swarm %s not installed" % pin["version"])
    return hits[-1]


SWARM = os.environ.get("SWARM") or "node " + _pinned_swarm()


def load():
    try:
        with open(CLAIMS) as fh:
            return json.load(fh)
    except FileNotFoundError:
        return {}


def save(c):
    os.makedirs(os.path.dirname(CLAIMS), exist_ok=True)
    with open(CLAIMS, "w") as fh:
        json.dump(c, fh, indent=2, sort_keys=True)
        fh.write("\n")


def git(*args, cwd=REPO):
    return subprocess.run(["git", *args], cwd=cwd, capture_output=True, text=True, check=True).stdout.strip()


def live_swarm_outputs():
    out = subprocess.run(SWARM.split() + ["--root", REPO, "board"], capture_output=True, text=True)
    if out.returncode != 0:
        sys.exit("refused: cannot read swarm board (%s)" % out.stderr.strip()[:200])
    owned = {}
    for run in json.loads(out.stdout or '{"runs":[]}').get("runs", []):
        if os.path.realpath(run.get("root", "")) != os.path.realpath(REPO) and run.get("repo") != git("rev-parse", "--git-common-dir"):
            continue
        for job in run.get("jobs", []):
            for f in job.get("outputs", []):
                kind = " (swarm-run cursor job)" if job.get("agent") == "cursor" else ""
                owned[f] = "%s/%s%s" % (run.get("runId"), job.get("id"), kind)
    return owned


def refuse(msg):
    print("refused: " + msg)
    sys.exit(1)


def main(argv):
    if not argv:
        print(__doc__); sys.exit(2)
    cmd, args = argv[0], argv[1:]
    claims = load()
    if cmd == "claim" and len(args) >= 2:
        job, files = args[0], args[1:]
        owned = live_swarm_outputs()
        for f in files:
            if f in owned:
                refuse("%s is an output of live swarm job %s" % (f, owned[f]))
            for other, c in claims.items():
                if other != job and f in c["files"]:
                    refuse("%s is already claimed by cursor job %s" % (f, other))
        claims[job] = {"files": sorted(set(files)), "base": git("rev-parse", "HEAD")}
        save(claims); print("claimed %d file(s) for %s at %s" % (len(files), job, claims[job]["base"][:8]))
    elif cmd == "check" and len(args) == 2:
        job, wt = args
        if job not in claims:
            refuse("no claim for %s" % job)
        c = claims[job]
        changed = set(filter(None, git("diff", "--name-only", c["base"], cwd=wt).split("\n")))
        changed |= set(filter(None, git("ls-files", "--others", "--exclude-standard", cwd=wt).split("\n")))
        extra = sorted(changed - set(c["files"]))
        if extra:
            refuse("worktree changed unclaimed files: %s" % ", ".join(extra))
        moved = sorted(set(filter(None, git("diff", "--name-only", c["base"], "HEAD").split("\n"))) & set(c["files"]))
        if moved:
            refuse("main changed claimed files since the claim: %s (rebase the worktree first)" % ", ".join(moved))
        print("ok: %s changed only its %d claimed file(s)" % (job, len(c["files"])))
    elif cmd == "release" and len(args) == 1:
        claims.pop(args[0], None); save(claims); print("released %s" % args[0])
    elif cmd == "check-manifest" and len(args) == 1:
        with open(args[0]) as fh:
            m = json.load(fh)
        held = {f: j for j, c in claims.items() for f in c["files"]}
        hits = ["%s (cursor job %s)" % (o, held[o]) for job in m.get("jobs", []) for o in job.get("outputs", []) if o in held]
        if hits:
            refuse("manifest writes files claimed by the Cursor lane: " + ", ".join(hits))
        print("ok: no Cursor claims in %s" % args[0])
    elif cmd == "list":
        print(json.dumps(claims, indent=2))
    else:
        print(__doc__); sys.exit(2)


if __name__ == "__main__":
    main(sys.argv[1:])
