# Hard task: `planWaves` (ticket wave planner)

Implement `planWaves(tickets, opts)` in `planWaves.mjs` as a named ES module export. Node 22 only, with no dependencies. Hidden tests grade it.

## Input

`tickets` is an array of objects:

| Field | Type | Notes |
|---|---|---|
| `id` | string | required, non-empty |
| `dependsOn` | string[] | optional, default `[]`; may contain duplicates |
| `files` | string[] | optional, default `[]`; the paths this ticket writes |
| `size` | `"S"` \| `"M"` | optional, default `"S"`; weight S=1, M=2 |
| `priority` | number | optional, default `0`; higher runs earlier |

`opts` is optional: `{ maxPerWave = Infinity, maxWeight = Infinity }`.

## Validation

Run these checks in this order. Each throws an `Error` with a `code` property.

1. `code: "BAD_INPUT"` when `tickets` is not an array, or any ticket's `id` is missing, not a string, or empty.
2. `code: "DUPLICATE_ID"` when two tickets share an id. Set `err.ids` to the sorted, unique list of duplicated ids.
3. `code: "UNKNOWN_DEP"` when a `dependsOn` entry names an id that doesn't exist. Set `err.missing` to a sorted, unique list of `"<ticketId>-><missingId>"` strings.
4. `code: "CYCLE"` when the dependency graph has a cycle. Set `err.ids` to the sorted list of **every ticket that is itself on a cycle**. That means members of a strongly connected component of size 2 or more, or any ticket that depends on itself. Tickets that only depend on a cycle must **not** be listed.

Sort with plain JS string comparison (`a < b`).

## File paths

Normalize every path before comparing:

1. Trim whitespace.
2. Turn `\` into `/`.
3. Collapse repeated `/` into one.
4. Remove all leading `./` segments.
5. Remove `.` segments (`a/./b` becomes `a/b`).

Matching is case-sensitive.

A path that **ends with `/`** after normalizing claims the whole directory. Two tickets **conflict** when:

- they normalize to the same file path, or
- one claims a directory `d/` and the other path starts with `d/` (this includes the same directory).

`src/a.js` and `src/ab.js` do not conflict. `src/` and `srcx/a.js` do not conflict.

## Scheduling (greedy, deterministic)

Build waves one at a time until every ticket is placed:

1. **Ready** tickets are those not yet placed whose dependencies are all in **earlier** waves.
2. Sort ready tickets by `priority` descending, then `id` ascending.
3. Walk that list. Add a ticket to the current wave only if all of these hold:
   - it doesn't conflict with any ticket already in this wave;
   - the wave has fewer than `maxPerWave` tickets;
   - the wave's total weight plus this ticket's weight is at most `maxWeight`. **Exception:** a ticket that is heavier than `maxWeight` on its own may go into an **empty** wave.
4. Ready tickets that were skipped wait for the next wave.

## Output

```js
{
  waves: [["id", ...], ...],   // ids in the order they were added
  stats: {
    waveCount,      // number of waves
    maxParallel,    // largest wave length (0 when there are no tickets)
    criticalPath,   // number of tickets on the longest dependency chain (0 when there are none)
    totalWeight     // sum of all weights
  }
}
```

An empty `tickets` array returns `{ waves: [], stats: { waveCount: 0, maxParallel: 0, criticalPath: 0, totalWeight: 0 } }`.

Performance: 5,000 tickets with a few dependencies each must finish in under 2 seconds. Don't mutate the input.
