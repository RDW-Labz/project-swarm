# Capacity pools

Swarm Watch calls `poolsSnapshot({ now })` from `tools/pools.mjs` when that file exists. It expects:

```js
{
  pools: [{
    id, name,
    kind: 'machine' | 'project' | 'lane' | 'host' | 'other',
    limit: number | null,
    inUse: number,
    unit: 'slots' | 'usd' | 'jobs',
    capped: boolean,
    why: string | null,
    until: ISO | null,
  }],
  at,
}
```

Until `tools/pools.mjs` exists, `tools/pools-board.mjs` shows a read-only stub. It uses the `workersHeld()` snapshot for the machine and active project pools, `laneUsage()` rows for lane spend caps and pauses, and configured enabled hosts for host pools. It shows the limit, current use, whether the pool is capped, and the reason.

The project limit is a guaranteed share: `floor(machine limit / active projects)`. A project may borrow idle slots above its share. Related roadmap items are R-022 (machine worker limit) and R-032 (split slots across active projects by priority).
