# Handoff: mini silent-catch D-fix lane (goal g-33a7a4ae)

Not committed to main — this file is local/untracked, for a fresh chat to pick up from.

## Role

This seat (Mac mini) runs the **background D-fix lane only**:
- One Cursor/Codex job dispatched at a time via `swarm run` on a manifest, always a plain non-version-bump branch/PR.
- **Cursor/Codex builders only. No paid API lanes, ever.**
- Sensitive files (money, process-kill, routing, guard, or lock files) get an Opus review via
  `swarm ask --model opus --agent claude --context <diff>.diff --timeout 900 "<question>"` before shipping.
  `agent: claude` here is the Claude Code CLI subscription, never the paid `anthropic` API lane
  (verified by reading `resolveAskRoute` in `tools/swarm/core-41.mjs`).
  Ask for strict JSON-only output (a prose+JSON answer can get truncated and fail to parse — happened
  once on PR #429, re-ran with a JSON-only prompt to get a parseable verdict).
- **One PR per finished batch. Never self-merge, never version-bump.** Push the branch, open a plain
  PR, report it to the MacBook peer session ("Project-swarm pins and #416") via SendMessage — they fold
  it into a release train (max 2/day, one version bump + one full suite + one Opus review of the
  combined diff per train). **As of this handoff: train 2 is the MacBook's own money/guard/review fixes
  only — all of this lane's PRs (#419-#429) plus the flaky-test fixes go into train 3, after train 2
  ships.** Keep reporting new PRs the same way regardless of which train number is current.
- Keep going batch by batch without waiting for approval between batches. Only stop for: a real red CI
  check that isn't an already-tracked flake, or a genuine money/paid-lane decision.

## Methodology file

`docs/state/silent-failures.md` — the master audit (630 findings across `tools/*.mjs`, merged as PR #399
in round 1). Each file section lists exact line numbers and catch-form (`dot-catch-arrow`,
`try-catch-no-binding`, `dot-catch-noop-expr`). Per-batch workflow:

1. Pick next highest-count un-fixed file. Read it to judge sensitivity (money / process-kill / routing /
   guard / lock).
2. `git worktree add <path> origin/main -b d-audit-fix-batch-N` + `npm ci`.
3. Write a manifest at `coordination/manifests/d-audit-fix-batch-N.json` (agent: cursor, model:
   composer-2.5) with a detailed prompt quoting the exact flagged lines and explaining which are
   safe-benign (narrow to a specific error code, keep the swallow) vs which need unconditional logging
   (anything touching the actual money/kill/lock/guard operation).
4. `swarm validate`, add any `suggestedIgnoreTests` to the manifest, re-validate.
5. Dispatch via `swarm run <manifest>` (background it).
6. `swarm integrate <run-id>`, then by hand: `node -c` syntax check, grep for the shortcut anti-pattern
   (`catch (x) { x; }` / `catch((_x) => ...)` / `void error` with no real log), read the full diff,
   run the real affected test files directly.
7. For sensitive files, get the Opus review (JSON-only prompt), resolve findings by reading the real
   code yourself — don't just trust the review or re-delegate to another swarm job for a read-only
   verification.
8. `git checkout -- coordination/HANDOFF*.md docs/state/usage-ledger.md` (these auto-regenerate; never
   commit the regenerated versions).
9. Commit, rebase on origin/main, push, `gh pr create`, watch checks, report the PR to the MacBook,
   remove the worktree (keep the branch — PR is unmerged).

Shortcut-anti-pattern grep:
```
grep -n "catch ([a-zA-Z_]*) { [a-zA-Z_]*; }\|catch((_[a-zA-Z]*) =>\|catch (_[a-zA-Z]*) {\|void error"
```

## Progress

**231 of 630 findings fixed, across 19 files / 19 PRs** (some early batches merged, later ones queued
for train 2 — see below).

Files done: `tools/gc.mjs`, `tools/ledger-backup.mjs`, `tools/autopilot.mjs`, `tools/board-data.mjs`,
`tools/board.mjs`, `tools/watch-cli.mjs`, `tools/phone.mjs`, `tools/ship.mjs`, `tools/kit.mjs`,
`tools/ui-check.mjs`, `tools/install.mjs`, `tools/concurrency-guard.mjs`, `tools/evals.mjs`,
`tools/managers/visual-qa/screenshots.mjs`, `tools/update-pending.mjs`, `tools/batch.mjs`,
`tools/history-hooks.mjs`, `tools/server-discovery.mjs`, `tools/swarm/core-61.mjs`,
`tools/brain-commands.mjs`, `tools/gpu.mjs`, `tools/lessons.mjs`.

(That's 22 files — the first 8 are already merged; the rest are open PRs below.)

## Open PRs queued for train 2 (not merged, do not self-merge)

All green or in-flight, nothing red as of this handoff:
- **#419** `tools/concurrency-guard.mjs` (batch 6a)
- **#420** `tools/evals.mjs` (batch 6b) — hit the tracked `lane-health-core.test.mjs` ENOTEMPTY flake once, confirmed flaky by clean re-run.
- **#421** `tools/managers/visual-qa/screenshots.mjs` (batch 7a)
- **#422** `tools/update-pending.mjs` (batch 7b)
- **#423** `tools/batch.mjs` (batch 8a)
- **#424** `tools/history-hooks.mjs` (batch 8b)
- **#425** `tools/server-discovery.mjs` (batch 9a)
- **#426** `tools/brain-commands.mjs` (batch 10a) — hit a red check (both macOS jobs); real failure was
  `tests/local-lane-review.test.mjs: "scheduler releases a grant when its job is no longer pending after
  claim"`, unrelated to the diff, timing-sensitive (bare 50ms setTimeout). MacBook confirmed this is
  already tracked under train 2's root-cause ticket **g-24a1587a**. Triggered `gh run rerun --failed`;
  rerun was in progress (not red, not yet green) when this handoff was written — check `gh pr checks 426`.
- **#427** `tools/swarm/core-61.mjs` (batch 9b) — **confirmed fully green**.
- **#428** `tools/gpu.mjs` (batch 10b) — nearly green (macos-22 was still pending when this handoff was written).
- **#429** `tools/lessons.mjs` (batch 11a) — sensitive (LOCK). Opus review passed with a full parsed
  verdict (first attempt's JSON got truncated — don't trust a truncated/unparsed review as a pass, even
  if the prose reads clean; re-ran with a strict JSON-only prompt to get one). CI was in progress (not
  red) when this handoff was written. Note on record from the MacBook: the lessons-store lock has a
  separate known bug (a crashed holder blocks the store forever, no stale-reclaim rule) — out of scope
  for this D-fix round, confirmed this batch's diff doesn't touch that path or make it worse.

Check all three in-flight PRs' current status before doing anything else: `gh pr checks 426`,
`gh pr checks 428`, `gh pr checks 429` (none were red as of this handoff, just still running).

## Next batch

**tools/projects.mjs (6 findings)** — sensitivity already assessed, not yet dispatched:
- Sensitive (**LOCK**) — the file's own `acquireRegistryLock`/`releaseRegistryLock`/`withRegistryLock`
  manage a real cross-process mkdir-based lock with a 30s stale-reclaim check (`LOCK_STALE_MS`).
- Flagged lines (current `tools/projects.mjs` on origin/main): 28, 49, 65, 67, 82, 280.
  - **Line 28** (`const serial = fn => { ...; queue = run.catch(() => {}); return run; }`): this is an
    internal promise-queue safety catch, NOT a swallow of the operation's real error — the real
    rejection still propagates to the caller via the returned `run` promise. Logging here would
    double-log every failure. Treat like the documented exception in `tools/ship.mjs`'s batch 4a:
    leave this one alone, no added logging.
  - **Line 49** (`fs.mkdir(path.dirname(file), {recursive:true,...}).catch(() => {})`): best-effort
    pre-create before the lock loop; a real failure here surfaces again at the inner `fs.mkdir(lock,...)`
    attempt (which throws visibly). Still worth a log for anything unexpected since it's part of the
    lock-acquire path.
  - **Line 65** (`catch { /* another writer won */ }` inside the stale-lock reclaim rename/rm): an
    explicitly-documented expected race (another process already reclaimed the stale lock). Keep the
    swallow, log only if something clearly doesn't match that expected race.
  - **Line 67** (`catch { /* gone */ }` around the stale-check `fs.stat(lock)`): benign/expected — lock
    dir vanished between mkdir attempt and stat (ENOENT). Narrow to ENOENT, log anything else.
  - **Line 82** (`fs.rm(lock, {recursive:true, force:true}).catch(() => {})` in `releaseRegistryLock`):
    the actual lock release. A failure here leaves the lock dir behind — but unlike `tools/lessons.mjs`,
    this file's 30s staleness check will self-heal it, so it's not a permanent stuck-forever case. Still:
    unconditional logging, since any release failure deserves visibility even though it self-heals.
  - **Line 280** (`fs.realpath(os.tmpdir()).catch(() => null)` inside `inTmp`'s known-tmp-base Set): a
    benign fallback — the hardcoded `/tmp`, `/private/tmp`, etc. entries already cover the common case.
    Log anything unexpected, no real narrowing needed.
- A worktree for this batch was attempted but not completed (`git worktree add` needs to run from
  inside `project-swarm-1`, not its parent dir — that's the only thing that failed, trivial to redo).
- After this: `tools/swarm/core-12.mjs` (6), `tools/swarm/core-2.mjs` (6), `tools/swarm/core-52.mjs` (6),
  then the 5-count tier files in `docs/state/silent-failures.md`.

## Bugs filed to backlog during review (pre-existing, out of scope for this logging-only round)

- **g-17304422**: `tools/managers/visual-qa/screenshots.mjs`'s `atomicWrite` can double-close its file
  handle if `fs.rename` fails after a successful `handle.close()`.
- **g-14b97505**: `tools/batch.mjs`'s `runBatch` can orphan a paid Anthropic batch (billing continues
  untracked) if `res.text()` fails right after a successful batch-create POST, since `b.id` is never
  captured.

(Not filed by this lane, but on record from train 2 for awareness: **g-24a1587a** — the
`local-lane-review.test.mjs` scheduler flake; and a lessons-store lock bug — crashed holder blocks the
store forever, no stale rule — mentioned by the MacBook re: PR #429, do not fix it in a D-fix batch.)

## Known gotchas

- `swarm ask`/`run`/`validate`/`go`/`ticket` can silently exit 0 with no output if launched with stdin
  closed while orchestrator mode is on (fixed in 1.167.24) — always verify a dispatch produced a real
  run id.
- `swarm ask --context <file>` needs a path relative to the project root — `/tmp/...` absolute paths get
  rejected as "Invalid relative path". Write the diff inside the repo/worktree instead.
- An empty diff file (e.g. `git diff origin/main..HEAD` before committing) crashes `swarm ask` with
  `Cannot read properties of undefined (reading 'costUsd')` — use `git diff -- <file>` for an uncommitted
  diff, or commit first.
- `swarm ask` can hit a `claude-provider-limit` pause on the CLI subscription lane with a stale reset date
  (e.g. citing Oct 23 while still blocking on Oct 28) — this is a known swarm bug, the MacBook has queued
  a fix. Until that ships, using `--ignore-provider-limit` on a clearly-expired reset date is fine (still
  the free CLI subscription, not a paid lane — not a money decision). Once the fix ships, this shouldn't
  be needed anymore.
- `tests/lane-health-core.test.mjs:186` (ENOTEMPTY) is a known macOS temp-dir cleanup race, already
  tracked for a train-2 root-cause fix — don't retry for it specifically, just report it.

---

## Update 2026-10-28 (session 2)

**MacBook peer is now "MacBook Project Swarm orchestrator handoff"** (old "Project-swarm pins and #416" chat is gone).

New PRs this session (none merged, no bumps, all for train 3 or later): #430 projects.mjs (lock, Opus pass),
#431 core-12, #432 core-2, #433 core-52, #434 errors.mjs (lock+privacy, Opus pass), #435 gpu-commands
(kill+money, Opus pass), #436 init-profile, #437 needs-you-triage (lock, Opus pass), #438 project-commands
(cap-raise money-adjacent, Opus pass), #439 autopilot-ready-deps, #440 base-check-lock (lock, Opus pass).
#426/#428/#429 ended fully green.

**HOLDS (overlap train 2 / S10, do not touch until those land):** api-adapters, swarm/core-51, watch-server,
om-manifest-guard, verify-provenance, daily-limit, budget-set-commands, anthropic, rates, spend, shell-writes,
paid-lane-pause (also: rented, scope-commands per MacBook's train-2 list).
**SKIPPED:** orchestrator-hook.mjs: audit lines stale, and the hook contract is "prints nothing". MacBook has an
events.ndjson follow-up queued.

**Remaining 4-count tier, in order:** busy-marker, claude-shell (sensitive → Opus), githook-check,
integrated-snapshot, lanes, managers/version/index, orchestrator-events, security-review (sensitive → Opus),
then board, tickets last. After that, the 3-count tier.

**Workflow notes learned:**
- Local tests: ALWAYS `node --import ./tests/_isolate-config.mjs --test <files>`. Bare runs read the mini's real
  config (T-0400 false failures). In zsh pass file lists via `xargs` (unquoted `$T` does not word-split).
- Opus review output: redirect to a file and parse `result.verdict` with python; tail truncates the verdict.
- Pre-existing bugs reported to MacBook (not fixed): projects.mjs stale-reclaim stat→rename race;
  base-check-lock `!owner` ⇒ stale can delete a LIVE lock (O_EXCL open then separate write).
- Known local-only failures (not product): field-lessons-batch-w #278 UV_CACHE_DIR, field-lessons-batch-t1
  #255(2) shell-python-no-setup (python/uv toolchain).

### Update 2026-10-28 (session 2, end)

More PRs: #442 busy-marker (18a), #443 claude-shell (18b, sandbox, Opus pass). Next batch is **19a**.
CI: #426-#435 and #437 green. #436 red only on the tracked lane-health-core:186 ENOTEMPTY flake
(g-f36125f2/g-d59fecb3, don't rerun). #437's first red was a new timing flake
(server-restart-round4:215 withProcessLock), green on rerun and queued by the MacBook for train 3.
Check #438-#443 first.

Train 2 = draft PR #441 (1.167.25). It waits on its Opus review after the Oct 30 reset, and the file holds lift
once it merges. Pre-existing bugs (projects.mjs race, base-check-lock live-lock delete, flake) sit in the
MacBook's TASK.md.

**Remaining 4-count tier, in order:** githook-check, integrated-snapshot, lanes, managers/version/index,
orchestrator-events, security-review (sensitive → Opus), then board, tickets. Then the 3-count tier
(check holds first).

**Line drift:** the audit was generated at commit **774c1a2**. Before each batch run
`git log --oneline 774c1a2..origin/main -- <file>`. If the file changed, map the audit lines with
`git show "${C}:<file>"` (use braces: zsh treats `$C:t` as a modifier) and name the CURRENT lines in the
prompt.

### ROLE CHANGE 2026-10-28 ~16:30: this seat is now the mini's OPUS REVIEW SEAT, not the D-fix lane

The D-fix lane belongs to another mini session (bridge:session_01DqM1EMFumDkihnGrvDSCzQ). It has already
opened #445-#451 (batches 19a-22b). Do NOT dispatch D-fix batches from here.
Queue for this seat, in order:
1. Train 2 DELTA Opus review: the MacBook commits a delta manifest. Reuse ~/.project-swarm-scratch/train2-review
   (git fetch, check out the new swarm/train2 head, write the new diff). Run with
   `node ~/.project-swarm/current/tools/swarm.mjs run <manifest> < /dev/null`. Agent claude, model opus
   (CLI subscription only). The output lives in .swarm/workspaces/<run>/<job>/coordination/review/*.json. Send
   the full JSON, run id and actualModel to the MacBook. Never integrate or commit on that branch. On a provider
   limit or a non-opus model: stop and report, never switch lanes.
2. Opus review of #448 (security-review.mjs), only after the delta review.
3. Any sensitive PR from either session (locks, kills, money, routing, guard, sandbox).
First train 2 review (run 1793221468839-cfc492bd) = FAIL 5, 3 blockers. The MacBook is fixing them on codex.
Review queue additions: #455 (batch 23a: executors/remote-exec/quotes; kill, orphan spend, pricing) is 3rd, after
the delta review and #448. It was requested by the D-fix session project-swarm-1-9f. Its checks: no control-flow
change; is stderr safe in remote-exec on a remote host (does anything parse the wrapper's stderr); ESRCH/ENOENT
narrowing. Out of scope: the executors heartbeat stopping on beat() reject. Post the parsed JSON as a PR comment and
ping project-swarm-1-9f.
More from project-swarm-1-9f, after #455, all logging-only:
- #461 (25a, money): best-of, budgets, status. Check status.mjs:65: a spendToday() failure now logs unless ENOENT. budgets:179 serializer left unchanged on purpose.
- #462 (25b, kill/lock): gate-rerun, init, integration-lock. Check the ESRCH narrowing; integration-lock:65 owner.json read in the creation window (ENOENT/SyntaxError silent); acquire unchanged. ALSO ask whether it has the same live-lock-delete race as base-check-lock (O_EXCL open, then a separate write, then !owner => stale).
- #463 (25c, routing): lane-pass-routing, managers/lane-health/index.
For each: post the JSON verdict as a PR comment and ping project-swarm-1-9f.

---

## Update 2026-10-28 (session 3)

**Lane split (from MacBook):** this session = D-fix lane (Cursor only, one job at a time, no CLI). The Opus review
seat is the other mini session **project-swarm-1-ce**: send it sensitive PRs via SendMessage; it posts JSON verdicts
as PR comments. Do NOT run `swarm ask` yourself.

**New PRs (all unmerged, no bump, train 3):** #445 githook-check, #446 integrated-snapshot, #447 version/index,
#448 security-review (Opus queued), #449 tickets, #450-#454 (22a-e, 3-count tier), #455 executors/remote-exec/quotes
(Opus queued), #456-#460 (24a-e, 2-count tier), #461 best-of/budgets/status, #462 gate-rerun/init/integration-lock,
#463 lane-pass-routing/lane-health (all three Opus queued with project-swarm-1-ce).
4-count, 3-count and 2-count tiers are DONE. **Next: the 1-count tier** (check holds + open PRs first).

**Holds / skips:** lanes.mjs (MacBook LaneScheduler fix), orchestrator-events.mjs (events follow-up), train-2 files.
Hook-path skips ("prints nothing"): handbuild-guard, orchestrator-handoff-hook, orchestrator-usage (via
orchestrator-context), auto-approve-policy, swarm-produced (imported by githook-check). Left by design (queue
serializers): lanes:187, history:15, budgets:179. board.mjs was already done in #405.

**Flakes seen (reported to MacBook, all green locally):** field-lessons-batch-m2:156, concurrency-guard SIGKILL watcher
(MacBook fixing both at root, no reruns), orchestrator-mode-timeout:166, phase14:49 (#443, reran).
**Bug reported, not fixed:** executors.mjs heartbeat: if beat() rejects, its reschedule never runs (heartbeat stops).

**Faster workflow (scripts in coordination/dfix-tools/, copy to scratchpad and fix the S= paths):**
- Spec JSON per batch: {"tools/x.mjs": ["Line N `code`: RULE ...", ...]}. Rules: SILENT-<CODE>, LOG-ALWAYS, LEAVE.
  Have a Sonnet worker draft specs for a tier, then spot-check them. Watch for: readLedger must log SyntaxError (corrupt
  ledger); readReviewManifest rewraps missing as code 'review-manifest'; PATH/executable probes also silence
  EACCES/ENOTDIR; promisified execFile puts the git exit in `.code`, execFileSync puts it in `.status`; never call a helper
  that can throw inside a "never throws" catch.
- `python3 mk.py <batch> <spec.json>` (in the worktree): writes the manifest, adds suggestedIgnoreTests, validates.
- `swarm run` in the background, then `wait.sh <runlog>`, then `rev.sh <batch>` (integrate, node -c, anti-pattern grep, diff,
  tests, stderr-noise count), then `ship.sh <batch> "<title>" <body.md>`.
- zsh: never pass a file list as an unquoted `$VAR`; use arrays or xargs. No backticks in unquoted heredocs.

**Late session-3 notes:** new holds from MacBook: concurrency-guard.mjs, managers/visual-qa/screenshots.mjs, swarm.mjs
(train 3 branch swarm/train3 rewrote tools/lane-health.mjs too; hold that). Told the MacBook #463 touches
managers/lane-health/index.mjs, NOT tools/lane-health.mjs; waiting for it to confirm, else split + redo on swarm/train3.
Offered to redo #419/#421 on swarm/train3 if needed. Opus seat order: train-2 delta, #448, #455, #461, #462, #463
(it will also check integration-lock for the base-check-lock-style live-lock-delete race, pre-existing).
**MacBook confirmed:** #463 stays as is. #419 is fine (train 3 only changed the test). **TODO: redo #421's atomicWrite
hunk on swarm/train3 once the MacBook says it's pushed** (train 3 added a closed flag, the catch skips the second close,
and atomicWrite is now exported). CI: #439/#445/#447 red only on the concurrency-guard SIGKILL-watcher flake (no reruns,
MacBook fixing); #440 macos-20 cancelled.
**Opus #448: PASS** (verdict comment on the PR). Optional low finding: filesHash line 39 could also treat ENOTDIR as
silent (not done). Follow-up candidates found by Opus, out of scope: security-review.mjs readReviewRecords' bare catch
(a corrupt or EACCES records.json returns empty, so a later write could overwrite the records) and securityReviewManifest's
fs.stat reject. Gotcha: `swarm ask --context` takes ONE comma-separated list (a repeated --context keeps only the last).
#448 reviewed: pass, comment posted.
GOTCHA: `swarm ask --context` takes ONE comma-separated list (`--context a.diff,tools/x.mjs`). A repeated flag
keeps only the last value, so earlier reviews of #430/#434/#435/#437/#438/#440/#443 saw only the file, not the
diff. I asked the MacBook whether to re-run them.
MacBook approved: re-run Opus reviews WITH the diff for #430, #434, #435, #437, #438, #440, #443, one at a time,
AFTER the train 2 delta, #455 and #461-#463. Each needs its own review; don't fold them into the train 3 combined
review. Method: `git diff origin/main...origin/<branch> -- tools > coordination/review-<n>.diff`, then
`--context coordination/review-<n>.diff,<files>` (one comma list). Check result.contextFiles, then post the parsed
JSON on each PR.
Full queue: delta → #455 → #461 → #462 → #463 → #430 → #434 → #435 → #437 → #438 → #440 → #443.
**Opus #455: PASS** (stderr safe in remote-exec, since spawnCollected never reads it). ENOTDIR nit for quotes readRuns applied as a fixup commit on #455.
**Opus #461: PASS** (1 medium, 5 low). Medium applied as a fixup: status.mjs logOnce + sanitizeWorkerText (logOnce pattern as in #437/#440).
Reviews done (JSON posted on each PR): #448 pass, #455 pass, #461 pass (1 medium: status.mjs per-poll spam, sent to
9f), #462 pass (pre-existing integration-lock check-then-remove race → MacBook), #463 FAIL (ENOTDIR spam; re-review
when 9f pushes the fixup). Train 2 delta round 2 = FAIL 6 (cd -P bypass), and round 3 is coming from the MacBook.
Helper: scratchpad/review-pr.sh PR "focus" (builds the diff, one comma --context, verifies contextFiles).
Still queued: round 3 delta, #463 re-review, then the re-runs of #430 #434 #435 #437 #438 #440 #443.
**Opus #462: PASS. #463: FAIL (ENOTDIR log spam) → fixup pushed, re-review requested.** quotes.mjs already had the ENOTDIR fix (#455).
Re-runs WITH the diff are DONE and posted: #430 pass, #434 pass, #435 pass, #437 pass, #438 pass (2 medium:
readLedger raw SyntaxError msg + no ENOENT exemption on the per-command path; I asked 9f for a fixup on branch 16a,
then re-review it), #440 pass, #443 pass. #463 re-review after fixup = pass.
Remaining: train 2 round 3 delta (waiting on the MacBook), plus the #438 fixup re-review when 9f pings.
#438 is HELD out of train 3 (MacBook decision) until the fixup plus a passing re-review. Round 3 delta is expected ~20-30 min after 17:35.
#438 fixup re-review = PASS (ask-1793226382417-3e9f2316); hold lifted. 9f is masking the same readLedger leak in #450/#451/#455/#456/#458/#459; re-check #455's new diff when pinged.
**Opus #463: PASS after the ENOTDIR fixup. #438: PASS after the masking fixup. #455: re-check PASS.** All sensitive PRs clear.
**Privacy sweep done:** readLedger rethrows the raw JSON.parse SyntaxError (V8 message includes ledger text). Every
readLedger/ledgerOf log this lane added now prints 'corrupt ledger (SyntaxError)' instead: fixup commits on #438, #450,
#451, #455, #456, #458, #459. RULE for new batches: never log a SyntaxError message from parsing a ledger/state file.
Optional Opus lows not done: remote-exec stop() (~140) logs a raw SyntaxError from the job record (pid/cost only);
quotes scopeText (~141) could silence EISDIR/ENOTDIR; security-review filesHash ENOTDIR.
**#421 redone as #464 (base swarm/train3, head 1c4b3ee6)**: same logging, plus the atomicWrite close inside train 3's
`if (!closed)` and readLedger masking. Opus queued with project-swarm-1-ce. The MacBook will close #421 when folding.
Train 3 is cut from train 2. Holds now: lanes, orchestrator-events, concurrency-guard (real watcher/restore race,
fix waits for Opus), all train 2 files until #441 merges. **Next: the 1-count tier** (check holds + open PRs first;
never log ledger/state SyntaxError text).
**Opus #464: PASS.** Optional low: on darwin, killing a zombie process group can return EPERM instead of ESRCH, so the post-exit SIGKILL may log now and then (applies to every ESRCH-narrowed kill in this lane; consider silencing EPERM after exit).
#455 re-check after masking = pass. #464 (screenshots, base swarm/train3) = pass; review-pr.sh now takes a 3rd arg BASE.
Train 2 round 3 (run 1793226998891-b19d1f42, head dcccb7a) = FAIL 6. The cd -P blocker is closed. NEW blocker:
physical vs logical cd tracking (`cd <protected>/L && cd .. && echo > f`). Suggested to the MacBook: refuse any redirect in
a compound command that contains cd, plus redirects on a cd segment. Waiting for round 4.
Round 4 plan (MacBook): refuse cd through any symlinked component; refuse '..' when the start cwd was reached via a symlink; refuse redirects on a cd segment. I flagged the macOS /tmp and /var prefix-symlink caveat. Round 4 expected ~30-40 min after 18:00.
#465 (session project-swarm-1-41, a third mini session) = pass, 1 medium (gpu-bakeoff stop log should name the replica and say it may still be billing). 41 is sending 26b (kills), 26c (routing/sandbox) and 26d (guard). Use review-pr.sh with base swarm/train3.
Train 2 round 4 (run 1793227879275-a7d0bd3c, head 50daba1) = NO VERDICT. A safety classifier cut off the worker's exploit analysis and no output file was written. Reported to the MacBook; it or the owner decides the next step. Do NOT re-run or reword on my own.
#465 re-check = pass. #466 (26b kills) = pass, lows only. 41 still to send 26c (routing/sandbox) and 26d (guard).
#467 (26c routing/sandbox) = pass, lows only. Asked 41 to grep whether adminExec errors can carry a password. 26d (guard) is next.
#468 (26d guard) = pass. Pre-existing git-hooks chmod issue sent to the MacBook. All of 41's sensitive batches are cleared (#465-#468); 26e-26h are non-sensitive, so no Opus review is needed. Waiting on the MacBook's round-4 decision.
Owner decision on round 4: a NEW invariants-checklist review manifest (7 invariants, judged against code and tests, no exploit design) on Opus; Codex is the fallback if Opus stops again. Train 2 ships if either passes and the construct tests pass. Manifest due ~15-25 min after 18:50.

---

## Update 2026-10-28 (session 4, project-swarm-1-41): 1-count tier DONE

PRs #465-#472 (batches 26a-26h), all **base swarm/train3** (the MacBook confirmed it), no bump, no merge, 57 files.
Sensitive: #465 (lock/money), #466 (kill), #467 (routing/sandbox), #468 (guard). All got Opus PASS from project-swarm-1-ce
(one medium on #465 for the gpu-bakeoff billing warning, fixed and re-checked). Non-sensitive: #469-#472.
Not done: goal.mjs:164 (generated-state dirtyFiles rewraps every git error as 'git status failed' with no code, so
"not a repo" can't be told apart; told the MacBook), contracts-gen (a generated-client template), cursor-adapter
(per-line result scan), daily-limit-notify (the fallback that logs failures), service-launchd (bootout before install).
Pre-existing follow-up (Opus #468): git-hooks chmod fail on an existing hook still returns 'installed'. The Opus seat sent it to the MacBook.
Every tier in docs/state/silent-failures.md is now done except holds/skips. Remaining: held files once #441 lands
(and lanes, orchestrator-events, concurrency-guard, swarm.mjs, lane-health.mjs and screenshots per the MacBook).

Tools: my copies live in this session's scratchpad tools/ (S= fixed, base swarm/train3 in ship.sh and mk.py). To
reuse them, copy coordination/dfix-tools/ again and apply the same sed: S path, session id, origin/main -> origin/swarm/train3, --base.
GOTCHA: a fixup job run in a worktree with UNCOMMITTED integrated changes starts from the committed tree, not your
working copy. Its spec must state the complete final rule, not a delta ("rename X" lost the ENOENT check once).
GOTCHA: the Sonnet spec drafts got one catch wrong (runner-pointer named the rev-parse catch, not line 202). Always
diff each spec excerpt against the real source line before dispatching.
Train 2 guard checklist (run 1793228863120-a6a6ebf7, head 3d5ba62) = PASS, I1-I7 hold. Owner caveat: strictly read, I2 fails for cd after ||, inside if/then, piped, or followed by & (guard cwd ≠ shell cwd). Sent to the MacBook with a suggested close: track cwd only through plain && and ; chains.
Installed 1.167.25 on the mini and removed the train2-review worktree. Open items for the MacBook/owner: the remote server is still on 1.167.15 (identity-unverified; restart is their call), and the stale providerLimit persists. Seat idle.
MacBook: leave the remote server (owner's call); the stale providerLimit is known bug g-abcfdd4c, ignore it. Next for this seat: Opus reviews of the D-fix lane's 13 ex-train-2 held files as PRs arrive (base likely swarm/train3 or main; use review-pr.sh with the 3rd arg), then the train 3 combined review when the MacBook sends a manifest.
Remote server restarted (owner order): pid 88234 on 1.167.25, all checks ok, token regenerated.
Train 3 (PR #473, 1.167.26) delta review (run 1793373267678-9595ce56, head 44f4c51) = PASS 8. The round-1 restoreIfStale pre-boot blocker is closed, with 6 follow-ups. The train3-review worktree is kept for any further rounds.
