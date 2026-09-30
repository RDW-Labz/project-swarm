# Contract — <batch name>

One shared, coordinator-owned file every job's `context` includes and no
job's `outputs` may write. Fill each section before dispatch; keep it short.

## Base
Base commit/branch this batch starts from. Target branch for the PR.

## Outputs
One row per file, one owner job each. No two jobs may write the same file.

| file | owner job |
|---|---|
|  |  |

## Exports / events / flags
Every cross-job function name, event name, manifest flag or field this batch
introduces. A job may not invent a name not listed here.
## Event names
A row per log/event name a job's code writes or reads. A row with an empty
producer cell names a reader with no producer anywhere in this batch —
`validate` warns `event-reader-no-producer` for it.

| event | producer file:line | reader file:line |
|---|---|---|
|  |  |  |

## Time zones
Any date-window code (a `date()`/`astimezone(UTC)` comparison, a day/window
boundary) gets one test in a non-UTC zone with an event after local 19:00,
alongside its UTC-clock tests — a UTC-only suite can pass while the window
itself is wrong for half the world.

## Tests
Where each job's regression test lives; which existing tests it changes; a done-when naming a diagnostic field names one test per failure class it must distinguish, not just that the field exists. For a spend-cap or limit contract, name the unit that is checked (each request, not each case/task) and require one test where a single case trips the cap mid-way, not accumulated across cases. Code that moves blocking I/O into or out of `async` context names where it now runs (a worker thread vs. the event loop) and requires one test that a concurrent task keeps running while that I/O is in flight. For any new platform-bound dependency (keychain, OS API) on a startup path, one test forces the platform backend to fail and proves startup still succeeds; construct it lazily via a factory. For any evaluator/gate, one test feeds the real vendored data it will see in production and asserts the attack (or exploit, or violation) path actually ran — a non-zero attacked/flagged count — not only that the verdict is pass; a fixture-only test proves nothing about the real inputs.
## Mutants
Every evaluator/gate this batch adds or changes gets a standard mutant: force it to treat every case as clean (or every input as passing); the Tests section's own real-data test above must kill it.
## Release
Which job owns the version bump and CHANGELOG heading, and in which PR. Before the first real push on a public repo, run `ship --preflight` once (every guard, one pass) instead of shipping and fixing guards one at a time; use `swarm squash --branch` for a pre-PR squash, never a hand `git reset --soft`, so the merge-base is always recomputed fresh against the current base.
