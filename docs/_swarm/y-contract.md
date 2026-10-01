# Batch Y: Field lessons 289–298 and backlog (release 1.40.0)

## 0. Findings

Queued lessons analyzed by priority (296, 297, 298, 295, 294, 293, 291, 290, 289, 292) plus backlog (289–227 descending):

| # | Enforcement | Status |
|---|---|---|
| 296 | Adapter saves raw reply to `response-invalid.txt` on invalid envelope, validates JSON shape against Return-JSON prompt | IN Y |
| 297 | **Repeat of 294** — same output-cap enforcement | DEFERRED: 294 covers |
| 298 | `integrate RUN --jobs <id,...>`: integrate only the named complete jobs of a run whose other jobs failed, when their outputs do not overlap (seat decision s66, provisional #159: a flag, not a design choice) | IN Y (y1b) |
| 295 | API/OpenRouter envelope gains required `result` object; `validate` injects skill `resultKeys` into schema | IN Y |
| 294 | `validate` warns `output-cap-too-small`, refuses when declared outputs exceed max_completion_tokens | IN Y |
| 293 | `validate`/`integrate` refuse `private-name` on any `shared/**`, `fixtures/**`, `tests/**` output | IN Y |
| 291 | New test scans CHANGELOG.md/README for CLI flags; `validate` refuses swarm PR with unparsed flags | IN Y |
| 290 | `swarm run` refuses `seat-not-released` when root listed in-flight under another session in SEAT.md | IN Y |
| 289 | `validate` warns `windows-ci-posix-mode` when ci.yml has windows-latest and output touches chmod without sys.platform guard | IN Y |
| 292 | `swarm agent-log start/end` write shell-stamped rows (never hand-typed); session_metrics warns `agent-log-future-time` | IN Y |
| 227 | `validate`/`run` add `no-job-running` warning and `swarm next` hint for next queued ticket | IN Y |
| 226 | Per-model maxOutputTokens in tier config (DeepSeek 16000); auto-retry on finish_reason=length within $ cap | IN Y |
| 225 | `shell-sandbox-denied-check` allows granted read paths; new `swarm doctor shell` prints profile summary JSON | IN Y |
| 224 | Skill frontmatter accepts empty lists `[]`, inline YAML lists `[a,b]`, bad unused skills warn not refuse | IN Y |
| 223 | CLI jobs: null result + zero declared outputs → `failed` with `reason: no-output`; prose BLOCKED → `blocked` status | IN Y |
| 222 | API adapters refuse `api-key-missing` before sending (names service/account/config path); error quotes status/finish_reason | IN Y |
| 221 | `ask`/`validate`/`run` refuse `empty-context-file` (0 bytes or whitespace only) unless in `allowEmptyContext` | IN Y |
| 219 | `missing-deps` warns only when dependencies/devDependencies declared; `check-needs-env` skips plain `node` scripts | IN Y |
| 208 | `validate` warns `cheap-tier-mismatch` when cheap job lacks tierReason (config tier differs from job tier) | IN Y |
| 207 | Scratch guard checks `git diff --name-only <base>...HEAD`, not job outputs; gitignored uncommitted output OK | IN Y |
| 206 | Shell job result schema gains `newPersistedFields: [{name, legacyDefault, why}]`; inspect warns if missing | IN Y |
| 204 | `check-pins` R2b: exact internal pin requires vendored wheel or `[tool.uv.sources]` entry, refuses `pin-not-vendored` | IN Y |
| 202 | **Complex**: integrate --salvage + lastActivity (DEFERRED to batch Z) | DEFERRED: multi-part feature |
| 209 | **the product repo follow-up** — scoreboard loop fake clock (out of scope) | DEFERRED: the product repo |
| 216 | **the product repo follow-up** — tempfile.TemporaryDirectory grep (out of scope) | DEFERRED: the product repo |

## 1. Jobs (2 parallel + 1 release)

**y1: Tool enforcement** (`y1-enforce`)  
Writer: none yet (architect assigns)  
Files owned:
- `tools/swarm.mjs` (validate, run, all schema checks)
- `tools/api-adapters.mjs` (envelope validation, error messages)
- `tools/openrouter.mjs` (output cap sizing, truncation handling)
- `tools/ship.mjs` (scratch guard)
- `tools/claude-shell.mjs` (sandbox path validation, doctor shell)
- `tools/session-metrics.mjs` (agent-log shell-stamped rows)
- `tests/field-lessons-batch-y.test.mjs` (NEW: all failing-without-the-fix tests)

**y2: Public docs** (`y2-docs`)  
Writer: none yet  
Files owned:
- `docs/lessons.md` (add public lessons 192–200)
- `docs/manifest-reference.md` (new envelope schema, seat-not-released behavior)
- `docs/orchestration.md` (new flags: --jobs, agent-log; doctor shell)
- `README.md` (if any new CLI command appears)

**y3: Release** (`y3-release`)  
Writer: none yet  
Files owned:
- `package.json` (version 1.40.0)
- `package-lock.json` (regenerated via `npm install`)
- `CHANGELOG.md` (add ## 1.40.0 section)

## 2. Rules

- **Enforcement over advice**: every fix has a test that fails without it; no warnings that don't fire in realistic conditions.
- **No private data in docs/tests**: fixture values use fakes (fake-uuid, sk-FAKE-0000, `run-0000`); no person names, domains, repos, or prompt text.
- **Backward compatibility**: all existing flags, options, env vars, and function signatures remain working.
- **Node ≥ 24**: tests run with `node --import ./tests/_isolate-config.mjs --test tests/*.test.mjs`.
- **Test command**: exactly `npm test` (see package.json `scripts.test`).

## 3. Cross-job names

Shared between y1 and y2:

| Name | Context |
|---|---|
| `output-cap-too-small` | validate warning (y1); manifest-reference docs (y2) |
| `windows-ci-posix-mode` | validate warning (y1); manifest-reference docs (y2) |
| `seat-not-released` | run refusal (y1); orchestration.md behavior (y2) |
| `private-name` | validate/integrate refusal (y1); manifest-reference docs (y2) |
| `empty-context-file` | ask/validate/run refusal (y1); manifest-reference docs (y2) |
| `api-key-missing` | adapter error (y1); docs note (y2) |
| `doctor shell` | new command (y1); orchestration.md (y2) |
| `--jobs` | integrate flag (y1); orchestration.md (y2) |
| `agent-log start/end` | new commands (y1); orchestration.md (y2) |
| `newPersistedFields` | result schema (y1); manifest-reference docs (y2) |
| `allowEmptyContext` | manifest field (y1); manifest-reference docs (y2) |
| `result` (envelope object) | API envelope (y1); manifest-reference docs (y2) |
| `tierReason` | manifest field (y1); manifest-reference docs (y2) |

## 4. Mutants (3 critical enforcements)

**Mutant A**: Lesson #295 (envelope schema + skill resultKeys)  
- **Find**: In `tools/api-adapters.mjs`, locate where the schema is built for openrouter jobs with attached skills.  
- **Mutate**: Remove the logic that injects `result.resultKeys.*` fields into the required schema based on attached skills.  
- **Test must fail**: `tests/field-lessons-batch-y.test.mjs` test for lesson 295 must fail when the mutant is applied (i.e., a job whose skill demands a key not in the envelope now passes validate, but should refuse).

**Mutant B**: Lesson #294 (output-cap-too-small validation)  
- **Find**: In `tools/openrouter.mjs`, locate the estimate for declared outputs' total size.  
- **Mutate**: Remove the refusal when declared outputs exceed model's max_completion_tokens.  
- **Test must fail**: Test must show that a 100 KB existing output with 8192 cap now passes validate (incorrectly).

**Mutant C**: Lesson #290 (SEAT.md seat-not-released guard)  
- **Find**: In `tools/swarm.mjs`, locate where `run` checks `coordination/SEAT.md` for in-flight roots.  
- **Mutate**: Comment out the SEAT.md read and refusal logic.  
- **Test must fail**: A manifest whose root is listed in-flight under another session now dispatches (should refuse with `seat-not-released`).

## 5. Checks & speed metric

**Test command**: `npm test`  
**Exact output**:  
```
node --import ./tests/_isolate-config.mjs --test tests/*.test.mjs
```

**Post-install checks** (run after `npm install`):
```bash
npm test
node tools/swarm.mjs version --check
```

**Speed metric** (decision #143): This batch moves **wall per merged PR**:
- Lesson 296/295/294: prevents 1–2 truncation retries per large-output API job (~15 min/PR when it hits).
- Lesson 290: prevents re-dispatch from duplicate seats (~25 min real cost once per seat lifecycle).
- Lesson 293: prevents private-name scrub jobs (~5 min/PR on shared skills).
- **Estimate**: ~30 min saved per merged PR that touches any of these, or 2–3 min average across all merges (low hit rate for most, but critical when hit).

## Open

Public lesson numbers for handoff review (per public-field-report rule):
- Lessons 289–296 and 298 are production incidents; 297 is a repeat of 294.
- **Public numbers to confirm before push**: 192, 193, 194, 195, 196, 197, 198, 199, 200 (generic wording, no names/repos/URLs/costs as counts, tiers not model IDs).
- Owner approval needed before docs/ commit for public lessons.
