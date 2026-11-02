# Contract — <batch name>
One shared coordinator-owned file included in every job's `context`; no job may write it. Fill every section before dispatch.

## Base
Base commit/branch and PR target branch.
## Outputs
One row per file and owner; no shared writes.
| file | owner job |
|---|---|
|  |  |
## Exports / events / flags
List every cross-job function, event, manifest flag, or field; jobs may not invent names. For externally validated values, name the accepting implementation or existing example; otherwise leave unresolved and report it.
| value | consumer | validated-by (file:line or existing example) |
|---|---|---|
|  |  |  |
## Decision-fixed constants
List every decision-relevant constant; write `none` if there are no applicable values.
| constant | source file:line | exact value and unit | decision reference | pinning test file and test name |
|---|---|---|---|---|
| none |  |  |  |  |
Each applicable row needs a literal expected value independent of the production constant, plus a boundary assertion when relevant.
Quote decision-fixed values from the source constant in the review summary; name the test that pins each value. Do not copy numbers from the ticket.
## Event names
One row per log/event name read or written. An empty producer identifies a reader with no batch producer; `validate` warns `event-reader-no-producer`.
| event | producer file:line | reader file:line |
|---|---|---|
|  |  |  |
## Time zones
Date-window code needs a non-UTC test with an event after local 19:00, alongside UTC-clock tests.
## Tests
Name each job's regression test and existing tests changed. A done-when naming a diagnostic field needs one test per failure class. Spend caps name the checked unit (each request, not each case/task); a single case trips the cap mid-way. Async blocking changes name their execution context and test concurrent work continues. For any new platform-bound dependency (keychain, OS API) on a startup path, one test forces the platform backend to fail and proves startup still succeeds; construct it lazily via a factory. Evaluator/gate tests use real vendored data and assert a non-zero attacked/flagged count.
## Mutants
Every changed evaluator/gate gets a standard mutant forcing every case clean; the Tests section's real-data test must kill it.
## Release
Name the version-bump/CHANGELOG owner and PR. Before the first public push, run `ship --preflight`; use `swarm squash --branch` for a pre-PR squash so merge-base is recomputed against the current base.
