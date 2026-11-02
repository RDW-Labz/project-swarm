# usage: python3 mk.py <batch> <spec.json>  (run inside the batch worktree)
import json, sys, subprocess
batch, spec = sys.argv[1], json.load(open(sys.argv[2]))
files = list(spec.keys())
secs = "\n\n".join(f"### {f}\nLogger prefix: console.error('[{f}] <short context>:', error?.message ?? error)\n" + "\n".join(f"- {l}" for l in lines) for f, lines in spec.items())
prompt = f"""Goal g-33a7a4ae, D-fix batch {batch} (logging-only visibility round). Read docs/state/silent-failures.md methodology (top) and the sections for the files below. Edit ONLY: {', '.join(files)}. Visibility only: do NOT change control flow, return values, fallbacks, throws, or exports. No refactors or reformatting.

Line numbers below are CURRENT (verified against origin/main). For each listed catch, bind the error and do exactly what the line says:
- SILENT-<CODE>: stay silent when error?.code === '<CODE>' (or the named class, e.g. SyntaxError); console.error anything else. Keep the same fallback value.
- LEAVE: make NO change to that catch at all.
- LOG-ALWAYS: console.error unconditionally, include the path/id named, keep the same fallback value.
- For `.catch(() => null)` / `.catch(() => '')` forms, keep returning the same value from inside the new handler.
- A close/cleanup inside an error path that rethrows: log the cleanup error with a DIFFERENT binding name; the original error must still be rethrown unchanged.

{secs}

Do NOT touch any other catch. FORBIDDEN shortcut patterns (rejected in review): `catch (e) {{ e; }}`, `.catch((_e) => ...)` never logged, `void error`, any binding not used in a real check or console.error.

Then grep tests/ for each file's basename and run those tests with: node --import ./tests/_isolate-config.mjs --test <files>; confirm green. Final summary: one line per flagged line."""
jid = f"d-fix-batch-{batch}"
m = {"version":1,"jobs":[{"id":jid,"agent":"cursor","model":"composer-2.5","prompt":prompt,"context":["docs/state/silent-failures.md"],"outputs":files,"timeoutMs":2400000,"ignoreTests":[],"ignoreTestsReason":"covering tests are run by hand after integrate and the full suite runs in CI"}]}
path = f"coordination/manifests/d-audit-fix-batch-{batch}.json"
json.dump(m, open(path,"w"), indent=2)
r = subprocess.run(["node","tools/swarm.mjs","validate",path], stdin=subprocess.DEVNULL, capture_output=True, text=True)
d = json.loads((r.stdout or r.stderr).strip().splitlines()[-1])
ig = d.get("suggestedIgnoreTests",{}).get(jid,[])
m["jobs"][0]["ignoreTests"] = ig
json.dump(m, open(path,"w"), indent=2)
open(f"/private/tmp/claude-501/-Users-prime-Documents-repos-projects-project-swarm-1/5c44f70f-1cac-4bd7-86c6-4c3271f73fa7/scratchpad/ig-{batch}.txt","w").write(" ".join(t for t in ig if t.endswith(".test.mjs")))
r = subprocess.run(["node","tools/swarm.mjs","validate",path], stdin=subprocess.DEVNULL, capture_output=True, text=True)
print(json.loads((r.stdout or r.stderr).strip().splitlines()[-1])["status"], len(ig))
