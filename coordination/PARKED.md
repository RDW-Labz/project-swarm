# Parked: swarm/guard-release2

**Fix before resuming:** the runner hangs forever when the kill is denied (`tests/swarm.test.mjs:348`, "cancellation cleanup denial preserves its reason, fails the run, and does not start queued jobs").

- Found 2026-10-28. Two full-test loops on this branch sat in that test for 1 day 15 hours, until the owner had them stopped.
- On this branch, a cancelled run whose worker cannot be killed (EPERM) waits for that worker to close and never returns. The test's `t.after` cleanup never runs, so the fake worker (`node -e "...setInterval(()=>{},1000)"`) keeps the file's process alive past `--test-timeout`.
- The same test passes on `main`, so the regression is in this branch's runner changes (worker token / dispatcher chain).
- When resuming: rebuild this branch as one patch on current `main` (main's version of that test kills its fake workers in teardown and fails fast), then fix the runner so a denied kill fails the job with its reason instead of waiting.
