# Batch AH brief — field lessons still queued (release 1.48.0)

Each row below is a field lesson from a live session. For each: decide the smallest tool-level fix (validate refuses / run warns / integrate or ship checks; prompt boilerplate only when a tool check is impossible), a test that fails without it, and one scrubbed public entry for docs/lessons.md (generic wording: no person, company, repo, URL, model id or prompt text). If a row is pure policy that the tool already enforces, say which check enforces it and give the test that proves it; ship no code for it. Rows whose area is process may land as a small helper or a warning; if no tool check is possible, say so with a one-line reason.

## Lesson 357
```json
{
 "id": 357,
 "date": "2026-10-06",
 "area": "tool",
 "evidence": "s73: swarm ask --agent codex --model gpt-6-luna refused (ask only supports claude or an API agent, not codex) while the config cheap tier is codex luna; the scout was re-run on claude haiku",
 "rule": "a read-only ask follows the configured tier routing; when the tier agent is not supported, ask names the configured fallback instead of refusing",
 "fix": "ask: support codex read-only (sandbox read-only, no outputs) or auto-route to the tier fallback with a warning ask-agent-fallback",
 "public": null,
 "status": "queued",
 "test": null,
 "version": null
}
```

## Lesson 358
```json
{
 "id": 358,
 "date": "2026-10-06",
 "area": "tool",
 "evidence": "s74 validate of t93b-contract: prompt-path-not-in-workspace refused 'src/anorak/browser' (a tracked directory whose files were all in context) three times as wording changed ('the browser package (src/anorak/browser/)', '(every src/anorak/browser/*.py file in context)'); only removing the path text passed; repeated same session on t99-contract with 'docs/_swarm' named as a folder in prose",
 "rule": "a prompt that names a directory or glob whose tracked files are in context is fine; refuse only when the named path resolves to nothing the workspace will carry",
 "fix": "validate: treat a prompt path that is a tracked directory (or a glob) as present when any tracked file under it is in context or tracked; test with a directory prefix and a glob",
 "public": null,
 "status": "queued",
 "test": null,
 "version": null
}
```

## Lesson 359
```json
{
 "id": 359,
 "date": "2026-10-06",
 "area": "process",
 "evidence": "s74: agent-core#105 (T96) passed CI 14/14, mutants 4/4 and was summarized to the owner as 'ends on close/Done/15 min' while the code shipped SIGN_IN_TIMEOUT_SECONDS = 600; the decision value was only caught by the next ticket's design job reading the source",
 "rule": "every number a decision fixes (timeouts, caps, limits) gets a test that pins the decision value, and the PR's three lines quote the constant from the code, not from the ticket",
 "fix": "contract boilerplate: list decision-fixed constants with the test that pins each; ship: warn when a needs-owner PR body names a number that does not appear in the diff",
 "public": null,
 "status": "queued",
 "test": null,
 "version": null
}
```

## Lesson 360
```json
{
 "id": 360,
 "date": "2026-10-06",
 "area": "tool",
 "evidence": "s74 T93b: builders' tests read a reference copy under docs/_swarm/ (coordinator work folder, never on the PR branch); suite green on the WIP branch (4096/0), 8 red on the clean branch",
 "rule": "src and tests never reference the work folder; a reference file a test needs becomes a tests/fixtures copy",
 "fix": "integrate: refuse (or warn loudly) when an integrated src/ or tests/ file contains the work-folder path (docs/_swarm); validate: warn when a build job's context includes work-folder files that are not docs",
 "public": null,
 "status": "queued",
 "test": null,
 "version": null
}
```

## Lesson 361
```json
{
 "id": 361,
 "date": "2026-10-06",
 "area": "process",
 "evidence": "s74: orchestrator wrote TASK.md progress stamps by estimate (16:00Z..19:45Z) while the real clock read 15:27Z..17:05Z (gh mergedAt 16:37Z/16:52Z); handoff readers would misjudge waits and wall times",
 "rule": "every timestamp written to TASK/HANDOFF comes from `date -u` (or a tool's own time field), never an estimate",
 "fix": "agent-log/handoff helper: `swarm note \"text\"` appends a line prefixed with the real UTC time to TASK.md; session_metrics warns when TASK stamps run ahead of the latest run/merge time",
 "public": null,
 "status": "queued",
 "test": null,
 "version": null
}
```
