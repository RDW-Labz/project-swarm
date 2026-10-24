// Cluster queue: one logical queue shared by several machines.
// Records merge by (version, machine) so every machine converges on the same view.
// The transport is injected; this module performs no network or filesystem access itself.

export const SYNC_DEADLINE_MS = 3000;
export const SYNC_INTERVAL_MS = 1000;
export const LEASE_MS = 10 * 60 * 1000;

export function createClusterQueue({ machine, transport, now = () => Date.now(), onSyncError } = {}) {
  if (typeof machine !== 'string' || !machine) throw new TypeError('machine id required');
  const items = new Map();
  let loopActive = false;
  let inFlight = null;

  function newer(a, b) {
    if (a.version !== b.version) return a.version > b.version;
    return a.machine > b.machine;
  }

  function upsert(rec) {
    const cur = items.get(rec.ticket);
    if (!cur || newer(rec, cur)) items.set(rec.ticket, rec);
  }

  // Trigger an immediate sync after local changes so peers see them quickly.
  function kick() {
    if (!loopActive) return;
    sync().catch((err) => {
      if (typeof onSyncError === 'function') onSyncError(err);
    });
  }

  function enqueue(ticket) {
    if (typeof ticket !== 'string' || !ticket) throw new TypeError('ticket id required');
    const cur = items.get(ticket);
    upsert({
      ticket,
      machine,
      version: (cur ? cur.version : 0) + 1,
      enqueuedAt: now(),
      state: 'queued',
      lease: null,
    });
    kick();
    return items.get(ticket);
  }

  function list() {
    return [...items.values()].sort(
      (a, b) => a.enqueuedAt - b.enqueuedAt || a.ticket.localeCompare(b.ticket),
    );
  }

  function depth() {
    return list().filter((r) => r.state === 'queued').length;
  }

  // worker is a local identifier; the lease holder is machine plus worker.
  function lease(ticket, worker) {
    const cur = items.get(ticket);
    if (!cur) throw new Error('unknown ticket ' + ticket);
    const holder = machine + '/' + worker;
    const live = cur.lease && cur.lease.expiresAt > now();
    if (live && cur.lease.holder !== holder) {
      const err = new Error('leased elsewhere');
      err.exitCode = 1;
      throw err;
    }
    upsert({
      ...cur,
      machine,
      version: cur.version + 1,
      state: 'active',
      lease: { holder, expiresAt: now() + LEASE_MS },
    });
    kick();
    return items.get(ticket);
  }

  // One exchange with the peer, bounded by the deadline. Overlapping calls share one exchange.
  async function doSync(deadlineMs) {
    if (!transport || typeof transport.exchange !== 'function') {
      throw new Error('transport.exchange is required');
    }
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('sync deadline exceeded')), deadlineMs);
    });
    try {
      const remote = await Promise.race([transport.exchange(list()), timeout]);
      if (!Array.isArray(remote)) throw new TypeError('peer snapshot must be an array');
      for (const rec of remote) upsert(rec);
      return { merged: remote.length, depth: depth() };
    } finally {
      clearTimeout(timer);
    }
  }

  function sync({ deadlineMs = SYNC_DEADLINE_MS } = {}) {
    if (inFlight) return inFlight;
    inFlight = doSync(deadlineMs).finally(() => {
      inFlight = null;
    });
    return inFlight;
  }

  // Starts periodic sync. Returns a handle whose stop() ends the loop.
  function startSync({ intervalMs = SYNC_INTERVAL_MS } = {}) {
    if (loopActive) throw new Error('sync loop already running');
    loopActive = true;
    let stopped = false;
    let timer = null;

    const tick = () => {
      if (stopped) return;
      sync()
        .catch((err) => {
          if (typeof onSyncError === 'function') onSyncError(err);
        })
        .finally(() => {
          if (stopped) return;
          timer = setTimeout(tick, intervalMs);
          if (timer && typeof timer.unref === 'function') timer.unref();
        });
    };

    tick();

    return {
      stop() {
        stopped = true;
        loopActive = false;
        if (timer) clearTimeout(timer);
        timer = null;
      },
    };
  }

  return { enqueue, list, depth, lease, sync, startSync, snapshot: list };
}
