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
Where each job's regression test lives; which existing tests it changes.

## Release
Which job owns the version bump and CHANGELOG heading, and in which PR.
