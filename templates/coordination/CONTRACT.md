# Contract — <batch name>
One shared, coordinator-owned file every job's `context` includes and no job's `outputs` may write. Fill each section before dispatch.

## Base
Base commit/branch; target branch for the PR.

## Outputs
One row per file and owner; no two jobs may write the same file.

| file | owner job |
|---|---|
|  |  |

## Exports / events / flags
Every cross-job function, event, manifest flag, or field introduced here. A job may not invent an unlisted name. For externally validated values, record the accepting implementation or an existing house example; if unavailable, leave the value unresolved and report it.

| value | consumer | validated-by (file:line or existing example) |
|---|---|---|
|  |  |  |

## Event names
A row per log/event name a job writes or reads. An empty producer cell names a reader with no producer in this batch; `validate` warns `event-reader-no-producer`.

| event | producer file:line | reader file:line |
|---|---|---|
|  |  |  |

## Time zones
Any date-window code gets one non-UTC test with an event after local 19:00, alongside UTC-clock tests.

## Tests
Where each job's regression test lives and which existing tests it changes. A done-when naming a diagnostic field names one test per failure class it must distinguish. Spend caps name the checked unit (each request, not each case/task) and test one case; a single case trips the cap mid-way. Async blocking changes name its execution context and test concurrent work continues. For any new platform-bound dependency (keychain, OS API) on a startup path, one test forces the platform backend to fail and proves startup still succeeds; construct it lazily via a factory. Evaluator/gate tests use real vendored data and assert a non-zero attacked/flagged count.
## Mutants
Every evaluator/gate changed here gets a standard mutant forcing every case clean; the Tests section's real-data test must kill it.
## Release
Which job owns the version bump and CHANGELOG heading, and in which PR. Before the first public push, run `ship --preflight`; use `swarm squash --branch` for a pre-PR squash so the merge-base is recomputed against the current base.
