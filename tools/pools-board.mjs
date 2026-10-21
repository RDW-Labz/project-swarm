// SPDX-License-Identifier: Apache-2.0
// The board-facing capacity-pool contract. This stays read-only: the MacBook
// implementation can arrive later without changing the board's shape.

const KINDS = new Set(['machine', 'project', 'lane', 'host', 'other']);
const UNITS = new Set(['slots', 'usd', 'jobs']);
const MAX_TEXT = 120;

const finite = value => typeof value === 'number' && Number.isFinite(value) ? value : null;
const objectOf = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const text = (value, fallback = '') => {
  if (value === null || value === undefined) return fallback;
  return String(value).slice(0, MAX_TEXT);
};
const iso = value => {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) return null;
  return new Date(value).toISOString();
};
const timestamp = now => {
  if (typeof now === 'number' && Number.isFinite(now)) {
    const date = new Date(now);
    if (Number.isFinite(date.getTime())) return date.toISOString();
  }
  return new Date().toISOString();
};

function cleanPool(value, index) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const limit = value.limit === null ? null : finite(value.limit);
  const inUse = finite(value.inUse) ?? 0;
  const id = text(value.id, `pool-${index}`) || `pool-${index}`;
  const name = text(value.name, id) || id;
  const kind = KINDS.has(value.kind) ? value.kind : 'other';
  const unit = UNITS.has(value.unit) ? value.unit : 'slots';
  return {
    id,
    name,
    kind,
    limit,
    inUse,
    unit,
    capped: Boolean(value.capped),
    why: value.why === null || value.why === undefined ? null : text(value.why),
    until: value.until === null || value.until === undefined ? null : iso(value.until),
  };
}

function cleanSnapshot(snapshot, now) {
  const value = objectOf(snapshot);
  const pools = (Array.isArray(value.pools) ? value.pools : [])
    .map(cleanPool)
    .filter(Boolean);
  return { pools, at: value.at ?? timestamp(now) };
}

function pool({ id, name, kind, limit, inUse, unit, capped = false, why = null, until = null }) {
  return { id, name, kind, limit, inUse, unit, capped, why, until };
}

function projectEntries(workers) {
  const byProject = objectOf(workers.byProject);
  return Object.entries(byProject)
    .map(([id, value]) => ({ id, value: objectOf(value), inUse: finite(value?.total) ?? 0 }))
    .filter(entry => entry.inUse > 0);
}

/**
 * Make the interim board view from snapshots already collected by the board.
 * This function deliberately does not read files or call workersHeld/laneUsage.
 */
export function stubPools({ workers = {}, laneRows = [], hosts = [], now = Date.now() } = {}) {
  const workerState = objectOf(workers);
  const total = finite(workerState.total) ?? 0;
  const max = finite(workerState.max);
  const invalid = Boolean(workerState.invalid);
  const machineCapped = !invalid && max !== null && max > 0 && total >= max;
  const machineWhy = invalid
    ? 'limit invalid: fix machineConcurrency'
    : machineCapped ? `machine limit reached (${total} of ${max} slots)` : null;
  const pools = [pool({
    id: 'machine', name: 'Machine', kind: 'machine', limit: max, inUse: total,
    unit: 'slots', capped: machineCapped, why: machineWhy,
  })];

  const projects = projectEntries(workerState);
  const share = max !== null && projects.length ? Math.floor(max / projects.length) : null;
  const free = finite(workerState.free) ?? (max !== null ? Math.max(0, max - total) : null);
  for (const project of projects) {
    const borrowing = share !== null && project.inUse > share && free !== null && free > 0;
    const atShare = share !== null && project.inUse >= share;
    pools.push(pool({
      id: `project:${project.id}`,
      name: project.id,
      kind: 'project',
      limit: share,
      inUse: project.inUse,
      unit: 'slots',
      capped: atShare,
      why: borrowing ? 'over its share, borrowing idle slots' : atShare ? 'guaranteed share reached' : null,
    }));
  }

  for (const row of Array.isArray(laneRows) ? laneRows : []) {
    const lane = text(row?.lane ?? row?.label, 'lane') || 'lane';
    const name = text(row?.label ?? row?.lane, lane) || lane;
    const todayUsd = finite(row?.todayUsd) ?? 0;
    const cap = finite(row?.dailyCapUsd);
    const reset = iso(row?.capResetsAt);
    const limited = objectOf(row?.limited);
    const limitedUntil = iso(limited.until);
    const paused = Boolean(limitedUntil);
    const rateLimited = /rate|backoff/i.test(String(limited.state ?? ''));
    const capped = paused || (cap !== null && todayUsd >= cap);
    const why = paused
      ? `${rateLimited ? 'rate limited' : 'quota paused'} until ${limitedUntil}`
      : capped ? `daily cap reached, resets ${reset ?? 'next reset'}` : null;
    pools.push(pool({
      id: `lane:${lane}`, name, kind: 'lane', limit: cap, inUse: todayUsd,
      unit: 'usd', capped, why, until: paused ? limitedUntil : capped ? reset : null,
    }));
  }

  for (const host of Array.isArray(hosts) ? hosts : []) {
    if (!host || typeof host !== 'object' || host.enabled === false) continue;
    const id = text(host.id, 'host') || 'host';
    const capacity = finite(host.capacity);
    const inUse = finite(host.inUse) ?? 0;
    pools.push(pool({
      id: `host:${id}`, name: id, kind: 'host', limit: capacity, inUse,
      unit: 'jobs', capped: false,
    }));
  }

  return { pools, at: timestamp(now) };
}

/** Load the future MacBook implementation without making it a hard dependency. */
export async function defaultLoader({ now }) {
  const module = await import('./pools.mjs');
  if (typeof module.poolsSnapshot !== 'function') throw new Error('poolsSnapshot is not exported');
  return module.poolsSnapshot({ now });
}

/** Return a safe board snapshot even when the future adapter or stub misbehaves. */
export async function boardPools({ now = Date.now(), loadPools = defaultLoader, stub = stubPools, stubInput } = {}) {
  const safeNow = typeof now === 'number' && Number.isFinite(now) ? now : Date.now();
  try {
    const snapshot = await loadPools({ now: safeNow });
    const cleaned = cleanSnapshot(snapshot, safeNow);
    return { source: 'pools.mjs', ...cleaned };
  } catch {
    try {
      const input = objectOf(stubInput);
      const snapshot = await stub({ ...input, now: safeNow });
      const cleaned = cleanSnapshot(snapshot, safeNow);
      return { source: 'stub', ...cleaned };
    } catch {
      return { source: 'stub', pools: [], at: timestamp(safeNow) };
    }
  }
}
