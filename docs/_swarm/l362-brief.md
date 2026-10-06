# Swarm lessons batch 362–381 — planning contract (coordinator s79)

Input: docs/_swarm/lessons-362-381.json (21 queued rows; id 374 appears twice — treat as 374a (validate conflict scan) and 374b (ship CI timeout classification)).
Out of this repo: 367 (coordination/tools/build_app.sh) and 368 (coordination/tools/session_metrics.py) live in the OASIS repo, not here — list them under "outOfRepo" with a one-line spec each; do not plan code for them here.

For every other lesson: find the real code location in tools/*.mjs, the existing tests that cover it (tests/*.test.mjs), and decide: build (with a test that fails without the fix) or drop/merge (already fixed on main — cite file:line proving it).
Group into at most 6 build jobs so that NO two jobs share an output file (tools/swarm.mjs is usually shared — put every lesson that must touch swarm.mjs in one job, or route its change through the module that owns it). Each job: one mid-tier worker, ≤4 lessons, clear contract.
Also one final docs job owns CHANGELOG.md, package.json version (1.49.0 → 1.50.0, every file asserting the version: grep it), and docs/lessons.md public entries (generic wording: no names, repos, URLs, prompt text, company data).

Output docs/_swarm/l362-plan.json:
{"dropped":[{id, reason, evidence}], "outOfRepo":[{id, spec}], "jobs":[{id, lessons:[ids], outputs:[files], context:[files incl. covering tests], prompt:"≤1200 chars: exact behaviour + the failing-first test to add"}], "versionFiles":[files asserting 1.49.0]}
Run `npm test` once on main and report pass/fail counts in notes.
