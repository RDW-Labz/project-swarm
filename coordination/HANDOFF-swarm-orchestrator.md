# Handoff: MacBook swarm orchestrator (2026-10-28 evening)

Local file only. Do not commit it to main.

## LATEST (2026-11-01 ~19:15 Chicago). This overrides the older sections below.

- **Train 9 tin 3 SHIPPED (owner exception, third release today)**: PR #488 squash-merged as **82caca04**, tag **v1.167.36**. Display-only bugs 3-5 plus the owner's additions:
  - Numeric stage order (S1, S2, ..., S10) in the Cockpit stage rule and stage lists.
  - Real Done 24h: the Hive counts unique tickets transitioned to done in each project's ticket log in the last 24h, shows 0 when none (was "—"), and keeps the old ledger chart as fallback.
  - Direct-build mode: `directBuild: true` on a project entry hides its swarm counts in the Hive and Cockpit (header/tiles/totals/session events) and skips its needs-you items; needs-you also auto-hides superseded/cancelled ticket rows and blockers older than 48h. The project stays visible and marked direct build.
  - Cancelled/percent note: the Cockpit footer says cancelled tickets are not counted in the live total or percent; 57% is 230/407 and 407 already excludes the 13 cancelled (no math change).
  - Hive ring height: below 1000px viewport height the ring shrinks (narrow canvas 300px; desktop stage clamp 440-680px) so the first card row is visible without scrolling; above 1000px unchanged.
- **Installed 1.167.36 on the MacBook.** Update restarted the board through launchd (1.167.35 -> 1.167.36, port 51058); one listener, health ok. Set `directBuild: true` on parts-request-app in `~/.project-swarm/projects.json` and kickstarted launchd. Live: needs-you **52 -> 5** (44 parts blockers + 3 blockers older than 48h hidden; 5 held tickets remain); Hive done 24h **0**; parts Hive card **direct build** with no counts; Hive totals/events exclude parts; project-swarm remains **407 / 230 / 57% / 15 ready / 5 need-you**. Playwright at 1440x900 and 1280x900: first Hive card visible, scrollTop 0 (screenshots `/tmp/t9-hive-*.png`). Cockpit live: footer "13 cancelled, not counted in the 407 live tickets or the percent"; counters 407/230/5; stage strip S1..S11 in numeric order (screenshot `/tmp/t9-cockpit-1440.png`).
- **Review:** Opus PASS 8/10, 0 blockers, 9 non-blocking followups. Key followup: the per-project direct-build Cockpit still shows some counts outside header/tiles (NOW card `1 / N`, stage strip, idle line, agents counter); also declared scope stage order for non-S ids, done-24h scratch scan/double scan, hidden-item reporting/phone counts, two weak test assertions. The registry loader was verified to preserve `directBuild`; no blocker.
- Full suite 7689 tests, 7658 pass, 0 fail; focused 80/80, 7/7, 27/27, 19/19, 40/40; CI 9/9. Earlier full-suite runs under heavy host load flaked only memory/guard-timing/stress tests.
- Spend today **$0.00**; no paid lanes. Stale temp board pid 31736 is stopped by the owner. No active swarm runs.
- Mini is still owner-relayed: run `swarm update --yes` there. Its own registry needs the same `directBuild` flag for parts-request-app if desired.
- Release cap: three trains shipped today under the owner exception; do not ship another train today without a new owner exception.

## LATEST (2026-11-01 ~17:25 Chicago). This overrides the older sections below.

- **Train 9 tin 2 SHIPPED**: PR #487 squash-merged as **7b1b0170**, tag **v1.167.35** (pushed by the release workflow). One source for all counts: new `tools/ticket-counts.mjs`; Hive and Cockpit render the server counts; needs-you comes from the owner inbox; the Cockpit ready set comes from the board's dependency-aware `readyIds`. Live parity on project-swarm: **407 tickets, 230 done, 15 ready, 5 review, 8 need-you, 57%** on both pages (old split 408/407, 8/5, "READY 70"). Full suite 7679 tests, 7648 pass, 0 fail; focused 45/45. Opus first review fail 6/10 (Cockpit ready rows still used the stripped ledger), fixed at 527a34a5, delta review pass 8/10 with 6 non-blocking followups.
- **Installed 1.167.35 on the MacBook.** The update restarted the board through launchd (1.167.34 -> 1.167.35, port 51058) - the tin 1 fix works. One listener (pid 11954, launchd); `/api/health` ok; `swarm watch --all` now detects the launchd board and prints its link instead of starting a second one. Mini is still owner-relayed: run `swarm update --yes` there.
- **Tin 1 Fable grade is committed** at `coordination/review/cc-grade/rtin1/grade.json`: Hive 4.0 (fidelity 3.9, polish 4.1, motion 4.2, data 4.0, phone 4.2), Cockpit 4.0 (fidelity 4.1, polish 4.0, motion 3.5, data 4.0, phone 4.0); 8 fixes per page. It was integrated in the tin 2 branch.
- **Release cap:** tin 1 (1.167.34) and tin 2 (1.167.35) both shipped 2026-11-01 Chicago = 2 release trains today. Do not ship tin 3 until the next Chicago day or an owner exception. Next tin in the plan: bug 3, numeric stage order (S1..S10).
- Spend today **$0.00**; no paid lanes. No active swarm runs at handoff. One stale 5-day-old board from a temp install still listens on 127.0.0.1:53586 (pid 31736); launchd owns 51058. Owner may want to stop that leftover (do not pkill).
- Open PRs are the pre-existing D-fix batches; no train PR is open.

## 0. LATEST (2026-10-31 ~16:40 Chicago). This section overrides the older ones below.

- **Train 8 SHIPPED**: PR #484 squash-merged as **22411782**, tag **v1.167.32**. Live Command Center change feed, bounded live detection, change-driven snapshot rebuilds, the train 6 follow-ups, and a 1-hour soak/latency gate.
  - Live feed: 1 s input detector + token/cookie SSE `/api/command-center/events` + per-project in-place patch + 5 s poll fallback. The detector scans the project's own root plus family worktrees active in the last 10 min (441 -> 6 roots on this Mac); full snapshots still read the family. The 60 s snapshot cache is change-driven with a 5 min deep rebuild backstop.
  - Gate evidence: 1-hour dashboard soak **verdict flat**: interval CPU 4.43% average (limit 5%), steady RSS growth -2.99 MB, browser heap +0.2 MB, SSE connections 1->1, file-watcher handles 0->0, 121 samples, 726 API requests. Change-to-screen: median 1002 ms desktop and 1001 ms phone-4G, no full snapshot fetch during updates. Evidence in `coordination/review/t8-soak-60m-final.json` and `t8-latency-*.json` on the branch.
  - Full suite: 7643 tests, 7612 pass, 0 fail, 22 skipped, 9 todo. CI 9/9 green.
  - Reviews: Opus on e7fe2af6 PASS 8/10 (7 followups). CI then failed only because npm test does not install Playwright Chromium; the fix adds a skip guard and puts the two harness tests in `test:browser` (ff7812ec). Delta review on fcf467c4 PASS 8/10 (8 followups). The metadata result commit 440cb236 has parent fcf467c4 and passed the new gate.
  - **Install:** MacBook on **1.167.34**. The board is owned by launchd (`com.project-swarm.board`) on port 51058; no retry churn. Mini not installed from this seat (owner-relayed; run `swarm update --yes` there); its remote fix is approved (below).
- **Hotfix 1.167.33 SHIPPED**: PR #485 squash-merged as **2cb33f58**, tag **v1.167.33**. Command Center scroll fixed: removed the `body.cc-body.hive-body` viewport lock (`max-height:100vh; overflow:hidden`), `.hive-shell` now fills the window below 1320 px, Hive switches to the ring-above-wrapping-grid layout at **1340 px** (CSS and `PHONE_MAX`), Cockpit scrolls, no horizontal overflow. Delta Opus PASS 8/10, 0 blockers, 4 test-quality followups. Full suite 7643/7612 pass; browser 2/2 (new scroll test at 1600/1280/800/390 for Hive and Cockpit with wheel/touch/keyboard); CI 9/9.
- **Train 9 FIRST (owner order 2026-10-31; extended 2026-11-01) — one board owner:** (a) `swarm update` must never start a second board: when `com.project-swarm.board` is loaded and holds the board port, restart through launchd (`launchctl kickstart -k gui/$UID/com.project-swarm.board`) instead of spawning a manual `swarm watch --all --keep-up`, or skip the restart when launchd holds the port; (b) plain `swarm watch --all` must detect the existing launchd board (identity/registry record plus a loopback `/api/health` probe on 51058), print its link (and open it with `--open`) instead of starting a second board on a new port. Tests for the launchd-owned, manual-owned, stale-record and no-board paths, plus a regression that leaves exactly one listener on the board port. **The 1.167.33 update reproduced (a) again** (started pid 34674 manually while launchd held 51058); it was stopped and launchd kickstarted.
- **Launchd board (resolved 2026-10-31):** launchd is the only board owner (pid 39605, 51058). The manual board from `swarm update` was stopped; the retry churn is gone. The remaining fix is the train 9 FIRST item above (update must kickstart launchd instead of starting a manual board).
- **Train 9 plan (owner order 2026-10-31, after a live 1440x900 + phone review; Hive 2.4/5, Cockpit 2.6/5):** bugs first, a test for each, then upgrades A-H, **one tin per ship**. Fable grades each step against the owner's taste; the owner tests live after each ship. Full backlog in TASK.md (2026-11-01T04:10Z entry). Bugs: (1) scroll lock — shipped in 1.167.33; (2) one source for all counts (Hive vs Cockpit 408/407 tickets, 8/5 need you, .58/57%, "51 ready"/"READY 70"); (3) numeric stage order (S1,S2,...,S10); (4) real "Done 24h"; (5) per-project direct-build mode + auto-hide superseded/stale needs-you; (6) show orchestrator sessions, review runs and release work instead of "0 agents". Upgrades: A one board both Macs with machine tags; B Running now strip; C Lanes panel + owner pause/resume; D Trains & PRs view; E grouped needs-you inbox; F health alerts; G Cockpit stage order/grouping/filters; H polish (sidebar nav, contrast, failure glitch).
- **Train 8 review followups (non-blocking, for train 9):**
  1. `tools/watch-server.mjs` ~721: one dirty project whose `board.project(id)` returns null/throws wedges the shared 1 s tick (the id stays in `dirtyProjects`; `pushUpdates` and idle close never run). Use `allSettled`, drop failed ids, wrap the CC update in its own try/catch, add a test.
  2. `tools/watch-server.mjs` ~683: live roots/catch-up scan only recompute at a full rebuild; a scan error (half-written lanes.json) fails a cold load, and a worktree that becomes active after a rebuild waits up to 5 min. Catch detector errors and re-select roots on a 30-60 s cadence.
  3. `tools/watch-live-latency.mjs` ~213: `waitForLiveUpdate` returns false when statValue is null, so `--builtin tickets` and `--change-cmd` can only time out. Add per-mode predicates/expect selectors.
  4. `tools/watch-live-latency.mjs` ~172: the builtin inbox/tickets changes are destructive (overwrite inbox state.json with only needsYou; drop doneAt). Prepare/revert full bytes, not reconstructed fields.
  5. `tools/watch-soak.mjs` ~257: the file-watcher metric greps lsof for `.swarm/`; the detector uses stat, so it is always 0. Count real watcher fds or label it honestly.
  6. `tools/watch-server.mjs` ~731: a patch recomputes `machine.agents.total` from `projects[].agents.total` (including child rows), replacing the full build's machine-wide value.
  7. `tools/merge-guard.mjs` ~127: the new binding makes the `type === 'review'` check redundant; tests use hand-written manifests only. Add a real runner-manifest fixture.
  8. `tools/command-center-snapshot.mjs` ~1750: `patchCommandCenterSnapshot` recomputes only `stats.agentsLive`, `stats.needsYouCount` and `hive`; other aggregates stay stale until the deep rebuild.
- Still open from train 7's review: local=1 coalescing, Cockpit payload mutation test, failed-rebuild log/backoff, `readRunStates` hot-caller cache or bounded caller, `combinedUsage([])` guard, synthetic `~status-i` row ids.
- **Owner decisions (2026-10-31):** the mini remote fix is **approved**: run `swarm remote off && swarm remote on` on the mini after it installs 1.167.32, then verify `swarm remote status` shows identity verified and the phone URL answers (mini seat/owner relay; this Mac has no SSH access to the mini). The stale providerLimit g-abcfdd4c is still pending.
- No paid lanes; $0 billed today.

## 0a. Previous latest (2026-10-31 ~02:50 Chicago). This section overrides the older ones below.

- **Train 5 SHIPPED**: #479 as 2a8dda74, tag v1.167.29. S10 Command Center is the default dashboard at `/` with the old board at `/classic`; Fable grade Hive 4.2 / Cockpit 4.4.
- **Train 6 SHIPPED**: #481 as 6cc5737b, tag **v1.167.30**, Opus pass 7/10. Owner gate: no SWARM_OWNER bypass, agent env markers first, process-ancestry check, dual TTY; test-only hook. Command Center perf: gzip/ETag/304/cache headers, lazy Cockpit/tour/palette + warm module graph and first-project data, 30 fps ambient (robot 15), static after 5 s idle, pause hidden/off-screen/reduced motion, 5 s poll, incremental DOM. Measured on the fixture: usable 3518->195 ms desktop, 5251->943 ms phone 4G; switch 3114->131 ms / 4099->111 ms; idle page CPU 91.8->3.4% / 95.8->3.2%; payload 497->157 KB / 434->81 KB; API 23->12/min. Version 1.167.30.
- **Train 7 SHIPPED**: #482 as e18fcfb4, tag **v1.167.31**, Opus pass 8/10. Board snapshot: one 60 s cache + stale-while-revalidate + single-flight rebuild + nonblocking startup warm; the OOM-prone per-project caches were removed (they hit a 4 GB heap on the real board). perf script parser fixed. D-fix 27c (swarm/core-51) included. **Real-board after install: usable 223 ms; Hive->Cockpit 61 ms; back 45 ms; server CPU 0.09% with a dashboard open; page CPU 2.45%; API ~13/min.**
- **Install state:** MacBook on **1.167.31** (managed board pid 23066, port 51058). An older terminal board (pid 1338, 1.167.29) still runs; the owner should Ctrl-C it and run `swarm watch --all`. Mini last owner-confirmed at 1.167.29; the 1.167.30 and 1.167.31 installs are on its seat (owner relaying) - verify. Marketing agency unpinned, follows the current version.
- **Perf harness committed:** `tools/watch-perf.mjs` + `npm run perf:cc`; run `node tools/watch-perf.mjs URL [--out F] [--profile desktop|phone] [--server-pid PID] [--idle S]`; it redacts the watch token. The mini can run it after updating.
- **Train 8 IN FLIGHT** (worktree `~/.project-swarm-scratch/train8`, branch `swarm/train8`, cut from e18fcfb4):
  - **#483 D-fix 27d folded** at **ed99c6bb** (tools/api-adapters.mjs, money; Opus pass 9, no blockers; 73 pass/1 skipped). Pushed.
  - **Live-feed job `t8-live-feed` (run 1793456184309-a9e33686) is STILL RUNNING** against e18fcfb4; LEAVE IT ALONE. Manifest `coordination/manifests/t8-live-feed.json`. Goal: ~1 s file-input detection, token/cookie SSE change feed, per-project API patch of the changed Hive card/cockpit + header counters, cached snapshot updated in place, no full rebuild per change; change-to-screen <=3 s; 5 s poll fallback. When it finishes: integrate it on ed99c6bb, run its focused check + full suite.
  - **Soak/latency manifest prepared, NOT run:** `coordination/manifests/t8-soak-latency.json` (job `t8-soak-latency`) adds `tools/watch-soak.mjs`, `tools/watch-live-latency.mjs`, and their tests. Must run after the live feed integrates. The owner gate for train 8 is a **1-hour soak with the dashboard open**: server RSS + browser heap + CPU flat, no SSE/EventSource or file-watcher leaks, and live change-to-screen latency measured on the **local board and the phone remote** (phone profile 4G; the real remote needs the mini's board URL/token or its seat runs the two harnesses after the train 8 build).
  - **Train 8 remaining queue:** after the live feed + soak/latency: the gate review-job check (identity of the local review job/manifest), the stale 1.167.29 CHANGELOG text, stress SIGINT/JSON.parse, Hive tab token hrefs/test fidelity, ticketSetHash superseded-approval migration note, detached/stdio process-group note. Then bump 1.167.32, full suite, one Opus review on this MacBook with the runner-written record, `swarm merge` via the branch runner, tag, install both Macs. Do not merge before the 1-hour soak passes.
- **Review/gate discipline:** reviews run on this MacBook (Claude limit reset); the runner writes `.swarm/runs/<id>/review-record.json`; gate v2 checks the local record/state + metadata-only result commit; the branch runner must be used for the merge (`node <worktree>/tools/swarm.mjs merge PR`). One orchestrator only: the Claude CLI session project-swarm-d6 (pid 57028) was stopped; do not resume it.
- **S10:** round 8 paused (run 1793215512888-d231b5c1) until the MacBook reset; not resumed.
- **Owner decisions pending:** the mini remote server fix (`swarm remote off && on`); the stale providerLimit g-abcfdd4c.

## 0b. Previous latest (2026-10-28 ~23:30 Chicago). This section overrides the older ones below.

- **Train 2 SHIPPED**: #441 squash-merged as 60de9058, tag v1.167.25. **Both Macs run 1.167.25.**
  - Reviews (Opus 5.5 on the mini's Claude CLI seat, owner-approved):
    - Round 1: fail, 3 blockers. All 3 were fixed and closed by round 2.
    - Round 2: one new `cd -P` blocker, closed by round 3.
    - Round 3: a logical-vs-physical `cd` blocker, closed by a class-closing fix.
    - Round 4: stopped by a safety classifier. Owner order: replace it with an invariants checklist. That checklist passed, all 7 invariants hold.
  - The owner also ordered resume to re-check everything for held jobs, including a test for a lane paused overnight. Done.
- **Train 3**: branch `swarm/train3` (worktree `~/.project-swarm-scratch/train3`), rebuilt on the new main at b6272423. The pre-rebase tip is kept as `swarm/train3-pre-rebase` (1c4b3ee6).
  - In it so far:
    - Flake fixes: local-lane, concurrency-guard :198, lane-health persistence with flush/stop, field-lessons m2, handbuild.
    - g-cb1c91a7: ask with an empty context file.
    - g-17304422: atomicWrite double close.
    - Phase 2 lock tests: 24 pass, 8 recorded `todo` bugs.
  - Mini PRs for train 3 (each Opus-cleared where sensitive): #419-#440, #442-#472, with #464 replacing #421.
    - **Close #421 as superseded.**
    - #465-#472 are based on swarm/train3. The D-fix session was told to rebase them onto the new train3 with `git rebase --onto origin/swarm/train3 1c4b3ee6 <branch>`.
  - Still to do: a `test:stress` npm script (g-24a1587a acceptance); bump to 1.167.26; full suite; one combined Opus review (the mini's seat works well; give it a manifest plus a diff file); `swarm merge`.
- **Held for Opus product fixes** (all in TASK.md):
  - concurrency-guard watcher/restore startup race (root of the :162 flake)
  - LaneScheduler abort keeps a slot
  - orchestrator hook can drop a chat merge under load
  - git-hooks chmod reports 'installed' while the guard is off
  - executors heartbeat stops silently
  - security-review records overwrite on a corrupt file
  - lock races in base-check-lock, projects.mjs and integration-lock
  - guard cd-in-`||`/if/pipe/`&`
  - unreserved paid sends outside the runner; a summed resume pre-check
- **Mini sessions**:
  - **Opus review seat**: bridge:session_01DqM1EKhnTY9y5Yh5PQ2irv, project-swarm-1-ce.
  - **D-fix lane**: bridge:session_01DqM1EKt5KtBJ9nqNS7bm8Q, project-swarm-1-41. It is doing the 13 ex-train-2 files next, on train3.
  - Still held: lanes.mjs, orchestrator-events.mjs, concurrency-guard.mjs, swarm.mjs.
- **S10 round 8**: run 1793215512888-d231b5c1 is still paused on the MacBook Claude CLI limit (resets Oct 30, 6pm Chicago). Scripts are in `~/.project-swarm-scratch/s10-scripts/`.
- **Owner decisions pending**:
  - The mini's remote server (pid 79259) is still on 1.167.15, 'identity-unverified'. Its fix is `swarm remote off && swarm remote on`. It's the phone endpoint, so ask the owner first.
  - The stale providerLimit on the mini's board is the known date bug g-abcfdd4c, which isn't fixed yet.
- **Lessons filed**:
  - The codex preamble reads "context only" as banning its own outputs; add a line saying outputs are readable.
  - `swarm ask --context` keeps only the last value when the flag is repeated.
  - A run whose check names its own new test file goes red on base when that file is load-flaky; use `--accept-red-base --reason`.

## 1. Role and rules

- You are the orchestrator only. All building goes through swarm jobs (`node /Users/bean/.project-swarm/current/tools/swarm.mjs ...`). Don't hand-edit code in project-swarm.
- Opus reviews run on the Claude CLI (claude lane, model opus). Fable (`claude-fable-5-1`) grades S10.
- No paid lanes. anthropic and openrouter stay paused, and the shell block (`keychain.service = project-swarm-shell-disabled`) stays on. Never raise a spend cap.
- The cap is $5/day across both Macs, enforced as **$2.50 per Mac per day**, on the **Chicago** day.
- Nothing merges to main without a green train. Ship with `swarm merge PR` only, never `gh pr merge`.
- Release trains: at most 2 a day. Each train gets one version bump, one full suite, one Opus review of the combined diff, and one install on both Macs.
- Routing: cursor (composer-2.5), then codex (gpt-6.1-sol), then Haiku. Use claude only after 2 failures or for expensive work.
- Never stop processes with `pkill -f` or `killall`. Never commit `.swarm/`.
- CLAUDE.md: no app code in this repo, and the plan in docs/plans is frozen.

## 2. Versions and branches

- Both Macs run **1.167.24** (tag v1.167.24). The mini verified a backgrounded run on it.
- The main checkout is on branch `swarm/ledger-root` at ca839235 ("Scope wave 5: T-0458").
  - Uncommitted changes: modified coordination/HANDOFF*.md, docs/scope/build-plan.md, docs/scope/split/manifest.json and docs/state/usage-ledger.md.
  - Untracked: TASK.md, coordination/REFACTOR-PLAN.md, wave files under docs/scope/waves/, review diffs under coordination/review/, tools/self-manage/*.mjs, tools/watch-assets/robot-avatar.js, _to_delete/ (old .tmp-test-v/w/x; `.tmp-test-*/` is gitignored).
  - None of these belong in a train.
- Train 2 worktree: `~/.project-swarm-scratch/train2`, branch `swarm/train2`. It was actually cut at 1.167.23 (278a62f9); main's 1.167.24 hotfix was merged in on 2026-10-28 (f130175e). It is now at 1.167.25 and pushed.
- S10 worktree: `~/.project-swarm-scratch/ccmount2`, branch `swarm/cc-mount2`.
- Parked branch: `swarm/guard-release2` (`~/.project-swarm-scratch/guardrel2`, local only). See section 7.

## 3. Trains

### Train 2 (now, in `~/.project-swarm-scratch/train2`)

| Item | Status |
|---|---|
| B3: paid-key leak and paid-lane pause | Integrated |
| B13: shell-writes real-path redirect | Integrated |
| B16 + B17: security-review gaps in scope-commands (delete-only sync; `--delivered` on unflagged sensitive tickets) | **Integrated**, checks green (run 1793216784781-b8621a50) |
| B1 + B2 + cap | **Integrated** (4e828aa5, money check 236/236). The single failure was `tests/api-workers.test.mjs:18`, which still pinned the old $25 day cap; the r2 run updated it to $20. |
| Hang guard | **Integrated** (53a116a7, 67/67). |
| g-e19bbb50: verify jobs by provenance | **Integrated** (c08a3fca + follow-up ed6f6f72, 174/174). **Design changed** from the compact `{id, verifyTicket}` plan, which needed every saved-manifest reader changed (codex blocked 3 times on scope). Now the gate rebuilds the manifest's deliverable tickets from the approved ledger (same profile, scope snapshot, lessons and lane models as prepareScopeRun) and allows a shell job only if it is canonically identical. Wave and run manifests are unchanged. Module: `tools/verify-provenance.mjs`. |
| Bump 1.167.25 | **Integrated** (5e77692b, via `integrate --queue`, required because the lockfile changed). |
| Full suite | 7119 tests: 7100 pass, 0 fail, 1 cancelled (`concurrency-guard.test.mjs:198` load flake, same as train 1, passes 5/5 alone), 17 skipped. |
| PR | **Draft #441** is open, CI running, body marked `**needs Opus security review`. |

**Left for train 2 (after the Claude reset, Oct 30 6pm Chicago):**
1. In train2, run `coordination/manifests/review-train2.json` (claude opus; context `coordination/review/train2.diff` is untracked and already generated, so regenerate it if the branch changes). Preflight is clean.
2. Blockers mean fix through the swarm, then a delta review. Pass means fill the Reviews section of #441, remove the `**needs` line, mark the PR ready, and `swarm merge 441` on green.
3. Install 1.167.25 on both Macs, message the mini, and tell it the train 2 file holds are lifted.
Do not move the review to another lane (owner order).

**Shell lane:** g-e19bbb50 is in train 2. Keep the shell block (`keychain.service = project-swarm-shell-disabled`) on until the owner says yes after train 2 ships.

Codex gotcha (lesson filed): the codex preamble says "Read only the files in your context", and gpt-6.1-sol reads that as banning its own outputs. Add a line to the prompt saying its outputs are readable.

### Train 3 (after train 2 ships)

- The mini's PRs #419–#438 (silent-catch D-fixes; #430–#438 were added after the owner's order), plus the flaky-test fixes g-24a1587a (3 load-flaky tests, fixed at the root) and g-ce7a13df (lane-health flake).
- #429 needs a complete Opus review before it goes in. That review is done and passed.
- New: **#430** (tools/projects.mjs batch 11b, lock-sensitive). Its Opus CLI review passed and the spam finding is fixed. No version bump; CI was running.
- CI status at handoff: #428 green; #426 rerun green (the g-24a1587a flake); #429 CI running.
- The mini flagged an existing bug that #430 doesn't fix: projects.mjs stale-lock reclaim has a stat→rename race, so a slow reclaimer can rename away a fresh live lock. Details are in the #430 PR body. **Not queued yet: the backlog is full (50 items max).** Clear done items, then add it. It's locking, so it fits refactor Phase 2.
- New: **#431** (tools/swarm/core-12.mjs batch 12a, not sensitive). No bump, not merged. One local failure on the mini, field-lessons-batch-w "#278 UV_CACHE_DIR", also fails on clean main there, so it's the mini's environment, not the diff. Confirm with CI before trusting that.
- New: **#432** (tools/swarm/core-2.mjs batch 12b, not sensitive). No bump, not merged.
- CI (latest from the mini): #426, #428 and #429 fully green (8/8). #430, #431 and #432 still running, none red.
- New: **#433** (tools/swarm/core-52.mjs batch 13a, not sensitive). Lines 214/224 (stderr guards on the server-restart path) left alone on purpose. No bump, not merged.
- Mini env issue: #255(2) shell-python-no-setup also fails on clean main there, same python/uv problem as UV_CACHE_DIR. Worth a ticket for the mini's python/uv setup.
- CI: #430–#433 still running, none red.
- New: **#434** (tools/errors.mjs batch 14a, lock- and privacy-sensitive). Opus CLI review passed after a privacy fixup (addTicket errors go through scrubText; lock stat logs only the error code). No bump, not merged.
- New: **#435** (tools/gpu-commands.mjs batch 14b, kill- and money-sensitive). Opus CLI review passed. A failed gpuDown now logs loudly that the rented node may still be up. No bump, not merged.
- CI: #430–#435 still running, none red.
- New: **#436** (tools/init-profile.mjs batch 15a, not sensitive). Hook scripts dropped from protectedPaths are now reported once per entry. No bump, not merged.
- **The mini's local test runs are drifting:** 3 scope-commands.test.mjs tests also fail on clean main there, on top of the 2 python/uv ones. That's 5 failures the mini calls environment issues. **The scope-commands cause is found:** tests/scope-commands.test.mjs does not import `_isolate-config.mjs` (223 of 648 test files don't). Run bare (`node --test file`), it reads the mini's real config, whose `ticketIdBlock` starts at 400, so new tickets come out as T-0400 instead of T-0001. `npm test` and CI always pass `--import ./tests/_isolate-config.mjs`, and with it the file passes on the MacBook. Fix: always run tests with that `--import`. Follow-up ticket (when the backlog has room): add the import to the 223 files, or have the runner's checks always inject it. The 2 python/uv failures still look like a real toolchain difference.
- New: **#437** (tools/needs-you-triage.mjs batch 15b, lock-sensitive). Opus CLI review passed; its 2 medium findings are fixed (a partial-write SyntaxError is now silent, and refresh logs dedupe by code). No bump, not merged.
- CI: #430 and #431 fully green (8/8); #432–#436 running, none red.
- The mini confirmed the isolation fix (scope-commands 17/17 with `--import`) and now uses it for all local runs.
- **tools/orchestrator-hook.mjs was skipped (no PR), correctly.** The silent-catch audit is out of date for it since the 1.167.23/24 rewrite; there are now 9 bare catches (lines 18, 24, 57, 62, 73, 118, 148, 151, 161). The hook's contract is "writes one event, prints nothing, always exits 0", so stderr logging would change guard behaviour. Follow-up ticket for after train 2: record swallowed hook errors as an event in `.swarm/orchestrator/events.ndjson`, with an Opus review.
- New: **#438** (tools/project-commands.mjs batch 16a). A corrupt pending cap-raise file now logs instead of hiding a spend decision. The mini marked it not sensitive, but it touches the cap-raise path, so it gets an Opus money review before merge. 171/171 isolated tests pass. No bump, not merged.
- CI: #430 and #431 green; #432–#437 running, none red.
- **tools/swarm/core-51.mjs is on hold** until train 2 merges: train 2 (B3) already changed it (paid-lane pause validation wiring). The mini goes to the 4-count tier instead.
- #438 got its Opus review: passed, low findings only. One fix pushed: a corrupt cap-raise file no longer echoes its contents. Title tagged [money-adjacent, reviewed].
- **Also on hold for the mini:** api-adapters.mjs (train 2) and watch-server.mjs (S10 branch). The rest of the 4-count tier is clear. Security-review and claude-shell get Opus reviews; board and tickets go last.
- **Train 3 keeps growing** (#419–#438 now). The owner split train 2 because it was too big for one good review. Ask the owner whether #430+ waits for train 4.
- Same flow: one bump, full suite, one Opus review, merge, install on both Macs.

## 4. S10 Command Center

- Bar: Hive and Cockpit must look identical to `docs/design/reference/hive-target.png` and `cockpit-target.png`, with real animation and real data.
- Built by porting the owner's Oct 22 artifact (https://claude.ai/artifact/RWtdCJxYKXzp8P3KC14p9X; slim copy in `docs/design/reference/command-center-artifact/`).
- The Cockpit centre must be the target's flat pixel creature, not the 3D head.
- Builder: Opus 5.5 (claude CLI). Grader: Fable. Each capture includes desktop, a second frame 0.8 s later, a full page and a phone view.
- Rubric: fidelity 40, polish 25, motion 15, data 10, phone 10.
- Scripts are in the old session scratchpad: `/private/tmp/claude-501/-Users-bean-project-swarm/a07842fc-2e42-4ce9-a035-a262f65beadb/scratchpad/`
  - make-fixture.mjs: 10-project busy board.
  - cc-shots-fixture.mjs, make-grade.mjs (GRADER_MODEL), make-fix.mjs (BUILDER_MODEL).
  - Grades are in grade-r*.json; per-round shots are in `coordination/review/cc-grade/rN/` in the S10 worktree.
  - Copied on 2026-10-28 to `~/.project-swarm-scratch/s10-scripts/` (make-fixture, cc-shots-fixture, make-grade, make-fix, grade-r1..r8). Use those.
- Scores (Hive / Cockpit):

| Round | Hive | Cockpit | Notes |
|---|---|---|---|
| r1 / r2 / r3 | 2.5 / 2.6 / 2.7 | 1.6 / 2.8 / 3.4 | Old rubric |
| r6 | 2.4 | 2.6 | Against the targets, Sonnet builder |
| r7 | 3.6 | 3.1 | Artifact port, Opus grader. This triggered the builder switch. |
| r8 | 3.8 | 3.7 | Fable grader, Opus builder |

- Switch rule: Sonnet builder → Opus 5.5 builder and Fable grader. This was triggered at round 7 (either page under 3.5, or a gain under 0.5).
- Stop at 4.5 on both pages, or after two rounds in a row with no improvement.
- Send the owner screenshots and scores every round.
- **Round 8 status:** Opus fix run 1793215512888-d231b5c1 (manifest cc-fix-r8.json in ccmount2) is **paused on provider-limit: the Claude CLI resets Oct 30 at 6pm Chicago.** Resume it after that, then integrate, render, run the round 9 Fable grade, and send the scores.
- The Opus security review for train 2 also needs the Claude CLI. If the limit blocks it, ask the owner how to proceed rather than switching lanes.
- GPT 6 Sol (codex gpt-6.1-sol) becomes the second reviewer once g-4710670e lands (it passes `--image` through the codex adapter).

## 5. Refactor plan

- The plan is `coordination/REFACTOR-PLAN.md` (main checkout, untracked).
- Owner's four answers:
  1. Chicago day boundary everywhere.
  2. Delete review-tier.mjs, review-batch.mjs and manifest-review-gate.mjs.
  3. `--reopen` and `--release` become legal owner moves.
  4. A done ticket is never a file's owner.
- It starts **after train 2 ships**. Do Phase 2 (locking) first if it doesn't depend on the paths module.

## 6. The mini

- The mini is the background lane: silent-catch D-fix tail plus lessons, one job at a time, free lanes only, PRs without a version bump. It never takes a front-lane slot.
- Progress: 231 of 630 findings fixed across 22 files. PRs #419–#429 are open and queued for train 3. The next batch is tools/projects.mjs.
- The mini session just handed off to a fresh chat. Its notes are in `coordination/HANDOFF-mini-silent-catch.md` on the mini (local only).
- It uses `--ignore-provider-limit` only on a clearly expired date until the date bug is fixed.
- To message it, use SendMessage to the mini's bridge session. The last one was `bridge:session_01NLCWLdjJYkUUfFNbZxEv7G`; the fresh chat will have a new id, so check ListAgents.

## 7. Queued bugs

- **g-cb1c91a7**: `swarm ask --context <file>` crashes with a raw TypeError (reading costUsd). Small; filed by the mini.
- **g-17304422**: filed in the mini's own backlog, not this Mac's. Details are in the mini's handoff.
- **g-24a1587a**: 3 load-flaky tests; fix at the root, with no retries or quarantine. Goes in train 3.
- **Provider-limit date bug** (g-abcfdd4c): a stale provider-limit date blocks a lane after the reset has passed. The workaround is `--ignore-provider-limit`, only on a clearly expired date.
- **guardrel2 hang**: `coordination/PARKED.md` on `swarm/guard-release2` says the runner hangs forever when the kill is denied (swarm.test.mjs:348). Fix before resuming, by rebuilding the branch as one patch on main.
- Others:
  - g-14b97505: an orphaned Anthropic batch keeps billing untracked. Money, so it needs an Opus review.
  - g-4710670e: codex images.
  - g-912ae7b8: validate's check-interpreter probe runs before the guard.
  - g-182d798a: document "pins freeze features, never safety".

## 8. Gotchas

- **ignoreTestsReason**: at most 200 characters, and it only counts with an `ignoreTests` array. To build that list:
  1. Drop the reason.
  2. Run validate.
  3. Copy `suggestedIgnoreTests` into `ignoreTests`.
  4. Add the reason back only if there are more than 100 entries.
- **Scope sync and review flow**:
  - `swarm scope sync --integrated` marks tickets done.
  - Sensitive tickets (and, after B16/B17, any ticket touching auth/api/db paths, deletes included) need a passing security review first.
  - `swarm tickets ID --delivered PR` has the same rule.
  - A done ticket is never an owner.
  - Superseded parked splits: once parts #68 merges, run `swarm resolve --superseded-splits` (dry run first).
- **`.swarm/` is reserved**: never a context path or output, never committed. Check lines that point there are stripped.
- **`--accept-failed-checks`**: use it only on branches that are not shipping. A train branch must integrate green.
- Launch runs with `< /dev/null` in the background. Watch them with `swarm board` or `swarm wait`; pgrep inside Monitor fails.
- Under CLAUDECODE=1 the gate refuses unvetted check argvs and every shell job. Check argvs must come from coordination/checks.json or the profile's verify command.

## Still running at handoff

- Train 2 hang guard retry: `swarm run` pid 89270, run 1793216925641-665e4ea5. Let it finish.
- Stray test from an older session (pid 97783, release tests in `~/.project-swarm-scratch/notefix`, 1 day 19 hours): stopped on the owner's order, along with its child 97785. Its shell (bkcu1x3an) exited.
- S10 r8 run 1793215512888-d231b5c1: paused, not running.
