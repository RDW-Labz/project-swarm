# Requests for tools/swarm.mjs (from the Mac mini seat)

The MacBook owns `tools/swarm.mjs`. These are hooks the Mac mini's S2 work needs there. Each one has the file, function, signature and an example.

## 1. Large `ignoreTests` lists for tickets whose file many tests import (blocks T-0040, work package G)

- **Where:** `tools/swarm.mjs`, `validateManifest` job checks, line ~1476 on main 1.162.0:
  `if (!Array.isArray(job.ignoreTests) || job.ignoreTests.length > 100) fail('ignoreTests must be an array of at most 100 files');`
- **Problem:** `tools/ticket-manifest.mjs` turns a ticket into a job. When its output is imported by more than about 112 tests, the job can hold at most 12 relevant tests in `context` and must ignore the rest. That exceeds 100, so the manifest is refused before any worker starts. T-0040's own ticket hits this: about 150 tests import `tools/ticket-manifest.mjs`.
- **Ask (either one):**
  - (a) Raise the cap to 1000. It is a list of repo-relative paths, already de-duplicated and path-checked one line later. Or
  - (b) Accept a new job field, `ignoreTestsReason: string` (1–200 chars). When it is present, allow up to 1000 entries, and print the reason in the `Uncovered test references` check output.
- **Example after the change:**
  ```json
  { "id": "T-0040", "outputs": ["tools/ticket-manifest.mjs", "tests/ticket-manifest-owns.test.mjs"],
    "context": ["tests/ticket-manifest.test.mjs", "...11 more"],
    "ignoreTests": ["...138 test files..."],
    "ignoreTestsReason": "138 other tests import tools/ticket-manifest.mjs for unrelated behavior; the coordinator runs the full suite" }
  ```
- **Mac mini side, ready once this lands:** `tools/ticket-manifest.mjs` ranks the referencing tests by relevance (same stem, named in the ticket, direct import), puts the top 12 in `context`, and generates the ignore list and reason (run `1792608368519-046756e5`, job `G-ticket-manifest`, not integrated).
