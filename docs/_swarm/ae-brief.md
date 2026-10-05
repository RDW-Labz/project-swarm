# Batch AE brief — project-swarm 1.45.1 (field lessons 347, 349, 350)

Each lesson below is a real failure from today's field use. Fix each with the smallest change, a test per lesson (node:test, tests/field-lesson-<id>.test.mjs), and a CHANGELOG bullet; bump to 1.45.1 the way 1.44.1/1.45.0 did (package.json, package-lock.json, README/SKILL.md kickoff pins, the three release-pin tests).

## Lesson 347 (tool)
- Evidence: s72 ad-fix1 (1.44.0): a Claude file-tools job ended 'provider-limit: resets Oct 2 at 6pm' while two other Claude jobs kept running; the error text continues with test-file source ('{ resetsAt: ...}); line 243'), so the classifier matched a provider-limit string the worker had just read from tests/field-lesson-t80-core.test.mjs, not a real limit. The job was re-run on the Agent tool.
- Rule: a provider-limit verdict comes only from the provider's own stream/exit signal, never from text the worker echoes; a quoted limit string inside file content is data.
- Fix: runner: classify provider-limit from the Claude stream event / exit code only, or require the match to sit in the final stderr line with no surrounding source text; test: a job whose context file contains the literal limit message completes normally.

## Lesson 349 (tool)
- Evidence: s72 t90-contract: the Sonnet file-tools job wrote both output files correctly, but integrate refused with skill-check-failed: debugging: resultKeys missing status/reproTest — the auto-attached debugging skill demanded a fix-job result shape from a contract-writing job whose prompt already ended with a Return JSON only line carrying status and reproTest; --accept-deviation did not help; the files were copied from .swarm/workspaces by hand (lesson #321 route). Second hit 20 min later on a code job (t87-denied-actions, same message, result null in inspect) — both after the 1.45.0 install; 1.44.1 integrated five jobs cleanly the same day, so suspect 1.45.0's result parsing (T86 tests-new's dropped write touched swarm.mjs) or the 'Return JSON only' line being read before the worker's final message.
- Rule: a result-shape refusal must say which text it parsed and never block files that were written in place; skills attach by job kind, not by default.
- Fix: integrate: on skill-check-failed show the parsed result keys and offer --accept-result-shape; attach the debugging skill only to jobs whose prompt or manifest says fix; test: a contract job with outputs on disk integrates with a shape warning.

## Lesson 350 (process)
- Evidence: s72: building a clean PR branch by `git checkout <wip> -- $(git diff --name-only ...)` broke when a vendored wheel was renamed (0.5.4 -> 0.5.5): --name-status reported R, the script took the old path, the chain aborted before the commit, and `ship --branch` ran its checks on an empty tree (check-env-missing) instead of refusing a branch with no commit ahead of main.
- Rule: a clean-branch build must handle renames and deletes explicitly (name-only for adds/mods, -M --diff-filter=D/R for removals) and ship must refuse a branch that is not ahead of its base.
- Fix: swarm squash/ship: `ship --branch` refuses when the branch has zero commits over base (code branch-not-ahead); a `swarm clean-branch --from <wip> --exclude docs/_swarm` helper does the file copy with rename/delete handling so the orchestrator stops hand-rolling it.

## Guidance
- 347: the provider-limit classifier lives in the Claude adapter (tools/cli-adapters.mjs or claude-shell.mjs; grep 'provider-limit'). Match only the provider's own stream event / final stderr line, never text echoed from a context file; the test feeds a worker transcript that quotes the limit string inside file content and asserts the job completes.
- 349: integrate's skill-check (grep 'skill-check-failed' / 'resultKeys') must show which text it parsed and must not block when every declared output exists on disk; attach the debugging skill only to jobs whose prompt or manifest marks them as a fix; offer `--accept-result-shape`.
- 350: `ship --branch` refuses a branch with zero commits over base (code `branch-not-ahead`) before running checks; add `swarm clean-branch --from <wip-branch> --exclude <glob>` (or document the helper) that copies adds/mods and handles renames/deletes with `git diff --name-status -M`.
- Public repo: no private terms (the suite's private-term test enforces it); keep bullets generic.
