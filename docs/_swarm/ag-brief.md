# Batch AG brief — field lessons still queued (release 1.47.0)

Each row below is a field lesson from a live session. For each: decide the smallest tool-level fix (validate refuses / run warns / integrate or ship checks; prompt boilerplate only when a tool check is impossible), a test that fails without it, and one scrubbed public entry for docs/lessons.md (generic wording: no person, company, repo, URL, model id or prompt text). If a row is pure policy that the tool already enforces, say which check enforces it and give the test that proves it; ship no code for it.

Also in this release: flip config `worktreesOutsideRoot` default to true (T86 shipped it default-off in 1.45.0; this batch is its dogfood run). Keep `worktreesOutsideRoot: false` working as the opt-out, and update every test that assumed in-root worktrees.

## Lesson 343
```json
{
 "id": 343,
 "date": "2026-10-05",
 "area": "tool",
 "evidence": "s72 T92: the core package's 0.7.60 wheel sat under [tool.uv.sources] but uv lock failed with 'no version of <runtime dep>==x'; uv applies sources only to direct dependencies, so the core wheel's four runtime wheels had to be listed as direct deps and vendored too.",
 "rule": "vendoring a core wheel means listing and vendoring every runtime wheel its METADATA requires; a pin the lockfile cannot resolve is not a pin.",
 "fix": "check-pins: warn vendored-core-missing-runtime-wheels when a vendored core wheel's METADATA requires a package that is neither vendored nor a direct dependency.",
 "public": null,
 "status": "queued",
 "test": null,
 "version": null
}
```

## Lesson 345
```json
{
 "id": 345,
 "date": "2026-10-05",
 "area": "contract",
 "evidence": "s72 T93: the contract wrote resources exclusive [tool:browser]; the core scheduler accepts only screen, person-attention and file: names, so the runner rejected the skill; caught only by the full suite after the build, two fix rounds later.",
 "rule": "a contract value that another repo's code validates must cite the accepting rule (file and line) or copy a house example; never invent a name.",
 "fix": "skills validator rule 10 checks resources names against the scheduler rule so the validator refuses them before the runner; the contract template gains a validated-by column for such values.",
 "public": null,
 "status": "queued",
 "test": null,
 "version": null
}
```

## Lesson 348
```json
{
 "id": 348,
 "date": "2026-10-05",
 "area": "process",
 "evidence": "s72: skills#22 (T93, first browser skill, needs-Braden) was merged by the orchestrator 16 minutes after the PR opened, under decision #125 (orchestrator merges needs-Braden PRs too). Braden asked afterwards whether it merged before his OK and said to hold such merges until his line.",
 "rule": "a needs-Braden PR is held until Braden types his OK; the orchestrator ships it (CI green, mutants logged, the 3 lines sent) and stops there. Decision #125 is withdrawn (#350).",
 "fix": "ship: a payload whose first line is **needs Braden** always runs with --no-merge and prints the 3 lines; merge only via an explicit `swarm merge <pr>` after the OK is pasted into the PR body or TASK.md.",
 "public": null,
 "status": "queued",
 "test": null,
 "version": null
}
```

## Lesson 351
```json
{
 "id": 351,
 "date": "2026-10-05",
 "area": "process",
 "evidence": "s72, first day on Codex-first routing (#352): five Codex jobs returned blocked instead of code because a file they needed was not in outputs (connectors source for T90 step 3; local_service.py then browser/chat.py for the 0.7.62 hotfix; package.json then src-tauri for T94). Each cost a 1–8 minute round trip; the honest stop is right, the briefs were too narrow.",
 "rule": "a Codex brief lists every file the change can plausibly touch (the HTTP layer and native shell included) and says 'deliver what you can, list what is left' — never 'touch only the listed files' on an exploratory ticket.",
 "fix": "swarm: a `scope: open` job flag that lets codex write any tracked file under declared directories and reports the extra files in filesChanged; validate warns when a prompt says 'touch only' on a job with fewer than three outputs.",
 "public": null,
 "status": "queued",
 "test": null,
 "version": null
}
```

## Lesson 352
```json
{
 "id": 352,
 "date": "2026-10-05",
 "area": "tool",
 "evidence": "s72: the Rust toolchain for OASIS.app builds lived under /private/tmp/oasis-t01-tools/rust; the Mac rebooted on 10-02 and macOS cleared it, so the first app build after the reboot found no cargo (T94). The uv toolchain had already moved to ~/.project-swarm/toolchains and survived.",
 "rule": "build toolchains live under ~/.project-swarm/toolchains, never under /private/tmp; a session's first build step checks for them and reinstalls before dispatching a job that needs them.",
 "fix": "swarm doctor: report missing toolchain binaries named in coordination/toolchain-versions.md and offer the reinstall line; the OASIS build scripts read CARGO_HOME/RUSTUP_HOME from ~/.project-swarm/toolchains.",
 "public": null,
 "status": "queued",
 "test": null,
 "version": null
}
```

## Lesson 353
```json
{
 "id": 353,
 "date": "2026-10-05",
 "area": "tool",
 "evidence": "s72: two desktop-app Codex jobs (t94-chat-avatar, t94-avatar-fix1) could not run vitest: EPERM writing node_modules/.vite-temp/vite.config.ts.timestamp-*.mjs inside the Codex sandbox; --cache.dir was rejected and VITEST_CACHE_DIR does not move Vite's config-bundle temp file. The first job shipped code with 2 unseen Chat.test reds; the second stopped without changes.",
 "rule": "a Codex job on a Vite/Vitest repo either gets a writable node_modules/.vite-temp (pre-created and allowed by the sandbox profile) or runs vitest via a config that sets a temp dir outside node_modules; otherwise route it to a shell worker that can run the suite.",
 "fix": "swarm codex adapter: pre-create and allow-list node_modules/.vite-temp (and .vite) in the job worktree's sandbox profile when package.json depends on vite; preflight warns `vite-temp-not-writable` for codex jobs on vite repos.",
 "public": null,
 "status": "queued",
 "test": null,
 "version": null
}
```

## Lesson 354
```json
{
 "id": 354,
 "date": "2026-10-05",
 "area": "tool",
 "evidence": "s72 T94 (desktop-app#74): `ship` watched a CI run whose macOS full job failed one AppRail test ('New chat creates a thread…', role button not found) that passes 3/3 locally on the same commit; the runner took 71 s for the file under load. The earlier failing run on the same branch failed only on rustfmt. `ship` reports ci-failed without telling a timing flake from a real red.",
 "rule": "on a CI red that the same commit passes locally (≥3 runs) and that main has passed, rerun the failed job once before treating it as real; record the flake.",
 "fix": "ship: `--rerun-flaky-ci 1` reruns failed jobs once when the failing test passes in the local check run, and records a flake row (the T51a flake metric) instead of failing the ship.",
 "public": null,
 "status": "queued",
 "test": null,
 "version": null
}
```

## Lesson 355
```json
{
 "id": 355,
 "date": "2026-10-05",
 "area": "contract",
 "evidence": "s72 T91e: the 'Yes is stored forever' mutant (remove the gate's approve call) survived because chat_service also writes the same approval on the Yes path; each of the two writers alone is enough, so removing either one changes nothing. The mutant only killed once it targeted the store itself (approve drops the host) and the gate's read (is_approved ignored).",
 "rule": "when a behaviour has two writers, aim the mutant at the shared store or the single reader, not at one writer; or remove the redundant writer.",
 "fix": "mutants file review step: for each mutant, grep the repo for other calls of the mutated function and flag `redundant-writer` when another call site performs the same effect.",
 "public": null,
 "status": "queued",
 "test": null,
 "version": null
}
```
