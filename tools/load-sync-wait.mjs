// SPDX-License-Identifier: Apache-2.0
// T-0075 / R-018: event-driven synchronization for load-timing checks — coordinate on
// signals and barriers, not fixed wall-clock sleeps. Field lesson L-0005: trace into memory
// and print only when a waiter fails or times out.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

/** Runs under artificial load that must all pass (T-0076 harness). */
export const LOAD_TIMING_RUNS = 5;

export function abortError(signal) {
  const error = new Error('The operation was aborted');
  error.name = 'AbortError';
  error.code = 'ABORT_ERR';
  if (signal?.reason !== undefined) error.cause = signal.reason;
  return error;
}

/**
 * In-memory event log; stderr dump happens only from {@link flushEventTraceOnFailure}.
 * @param {{ label?: string, now?: () => number }} [options]
 */
export function createEventTrace({ label = 'load-sync', now = () => Date.now() } = {}) {
  const events = [];
  return {
    label,
    record(name, detail) {
      events.push({ at: now(), name, ...(detail === undefined ? {} : { detail }) });
    },
    snapshot() {
      return events.slice();
    },
    flushOnFailure(error) {
      if (!events.length) return;
      const message = error?.message ?? String(error);
      const lines = events.map(entry => {
        const extra = entry.detail === undefined ? '' : ` ${JSON.stringify(entry.detail)}`;
        return `  ${entry.at} ${entry.name}${extra}`;
      });
      process.stderr.write(`${label}: ${message}\n${lines.join('\n')}\n`);
    },
  };
}

export function flushEventTraceOnFailure(trace, error) {
  trace?.flushOnFailure?.(error);
}

export async function runWithEventTrace(trace, fn) {
  try {
    return await fn(trace);
  } catch (error) {
    flushEventTraceOnFailure(trace, error);
    throw error;
  }
}

function settleWaiter(waiter, value) {
  waiter.signal?.removeEventListener('abort', waiter.onAbort);
  waiter.resolve(value);
}

function rejectWaiter(waiter, error) {
  waiter.signal?.removeEventListener('abort', waiter.onAbort);
  waiter.reject(error);
}

/**
 * Named notify/wait pairs (promise resolves when {@link notify} runs, not after a delay).
 * @param {{ trace?: ReturnType<typeof createEventTrace> }} [options]
 */
export function createLoadSync({ trace } = {}) {
  /** @type {Map<string, unknown>} */
  const pending = new Map();
  /** @type {Map<string, Array<{ resolve: (v: unknown) => void, reject: (e: Error) => void, signal?: AbortSignal, onAbort: () => void }>>} */
  const queues = new Map();

  function notify(name, payload) {
    trace?.record(`notify:${name}`, payload);
    pending.set(name, payload);
    const queue = queues.get(name);
    if (!queue?.length) return;
    queues.delete(name);
    for (const waiter of queue) settleWaiter(waiter, payload);
  }

  function waitFor(name, { signal } = {}) {
    trace?.record(`wait:${name}`);
    if (pending.has(name)) {
      const payload = pending.get(name);
      pending.delete(name);
      trace?.record(`wait:${name}:immediate`, payload);
      return Promise.resolve(payload);
    }
    if (signal?.aborted) return Promise.reject(abortError(signal));
    return new Promise((resolve, reject) => {
      const waiter = {
        resolve,
        reject,
        signal,
        onAbort: () => {
          const queue = queues.get(name);
          if (!queue) return;
          const index = queue.indexOf(waiter);
          if (index >= 0) queue.splice(index, 1);
          if (!queue.length) queues.delete(name);
          rejectWaiter(waiter, abortError(signal));
        },
      };
      let queue = queues.get(name);
      if (!queue) {
        queue = [];
        queues.set(name, queue);
      }
      queue.push(waiter);
      signal?.addEventListener('abort', waiter.onAbort, { once: true });
    });
  }

  return { notify, waitFor, signal: notify };
}

/**
 * @param {{ signal?: AbortSignal, trace?: ReturnType<typeof createEventTrace>, tag?: string }} [options]
 */
export function createDeferred({ signal, trace, tag = 'deferred' } = {}) {
  let settled = false;
  let resolveRef;
  let rejectRef;
  const promise = new Promise((resolve, reject) => {
    resolveRef = resolve;
    rejectRef = reject;
  });
  const onAbort = () => {
    if (settled) return;
    settled = true;
    trace?.record(`${tag}:abort`);
    rejectRef(abortError(signal));
  };
  signal?.addEventListener('abort', onAbort, { once: true });
  return {
    promise,
    resolve(value) {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      trace?.record(`${tag}:resolve`, value);
      resolveRef(value);
    },
    reject(error) {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      trace?.record(`${tag}:reject`, error?.message ?? error);
      rejectRef(error);
    },
  };
}

/**
 * In-process barrier: {@link arrive} calls until {@code expected} releases {@link wait}.
 * @param {number} expected
 * @param {{ trace?: ReturnType<typeof createEventTrace>, signal?: AbortSignal }} [options]
 */
export function createCountBarrier(expected, { trace, signal } = {}) {
  if (!Number.isSafeInteger(expected) || expected < 1) {
    throw new TypeError('expected must be a positive integer');
  }
  let count = 0;
  const gate = createDeferred({ signal, trace, tag: 'barrier' });
  return {
    get count() {
      return count;
    },
    get expected() {
      return expected;
    },
    arrive(detail) {
      count += 1;
      trace?.record('barrier.arrive', { count, expected, detail });
      if (count >= expected) gate.resolve({ count });
    },
    wait(options = {}) {
      const { signal: waitSignal } = options;
      if (waitSignal?.aborted) return Promise.reject(abortError(waitSignal));
      if (count >= expected) {
        trace?.record('barrier.wait:immediate', { count });
        return Promise.resolve({ count });
      }
      if (!waitSignal) return gate.promise;
      return Promise.race([
        gate.promise,
        new Promise((_resolve, reject) => {
          waitSignal.addEventListener('abort', () => reject(abortError(waitSignal)), { once: true });
        }),
      ]);
    },
  };
}

/**
 * Filesystem marker barrier (field lesson #182): {@code fs.watch} drives progress, not sleep.
 * @param {string} markerDir
 * @param {number} expected
 * @param {{ trace?: ReturnType<typeof createEventTrace>, signal?: AbortSignal }} [options]
 */
export async function createMarkerBarrier(markerDir, expected, { trace, signal } = {}) {
  if (!Number.isSafeInteger(expected) || expected < 1) {
    throw new TypeError('expected must be a positive integer');
  }
  await fsp.mkdir(markerDir, { recursive: true });
  const sync = createLoadSync({ trace });
  let closed = false;

  async function markerCount() {
    try {
      const names = await fsp.readdir(markerDir);
      return names.filter(name => name && !name.startsWith('.')).length;
    } catch {
      return 0;
    }
  }

  async function publishProgress() {
    const count = await markerCount();
    trace?.record('markerBarrier.count', { count, expected });
    if (count >= expected) sync.notify('ready', { count });
  }

  const watcher = fs.watch(markerDir, () => {
    publishProgress().catch(() => {});
  });

  const onAbort = () => close();
  signal?.addEventListener('abort', onAbort, { once: true });

  function close() {
    if (closed) return;
    closed = true;
    watcher.close();
    signal?.removeEventListener('abort', onAbort);
  }

  await publishProgress();

  return {
    markerDir,
    expected,
    markerPath(name) {
      return path.join(markerDir, name);
    },
    async writeMarker(name, data = '') {
      const file = path.join(markerDir, name);
      await fsp.writeFile(file, data);
      trace?.record('markerBarrier.write', { name });
      await publishProgress();
    },
    waitReady(options = {}) {
      return sync.waitFor('ready', options).finally(() => close());
    },
    close,
  };
}

/**
 * @param {import('node:events').EventEmitter} emitter
 * @param {string} eventName
 * @param {{ signal?: AbortSignal, trace?: ReturnType<typeof createEventTrace> }} [options]
 */
export function waitForEmitter(emitter, eventName, { signal, trace } = {}) {
  trace?.record(`emitter.wait:${eventName}`);
  if (signal?.aborted) return Promise.reject(abortError(signal));
  return new Promise((resolve, reject) => {
    const onEvent = (...args) => {
      cleanup();
      trace?.record(`emitter:${eventName}`, args.length === 1 ? args[0] : args);
      resolve(args.length <= 1 ? args[0] : args);
    };
    const onAbort = () => {
      cleanup();
      reject(abortError(signal));
    };
    const cleanup = () => {
      emitter.off(eventName, onEvent);
      signal?.removeEventListener('abort', onAbort);
    };
    emitter.once(eventName, onEvent);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Manual gate opened explicitly ({@link open}); {@link wait} blocks on the gate promise.
 * @param {{ trace?: ReturnType<typeof createEventTrace>, signal?: AbortSignal }} [options]
 */
export function createManualGate({ trace, signal } = {}) {
  const gate = createDeferred({ signal, trace, tag: 'gate' });
  let open = false;
  return {
    get isOpen() {
      return open;
    },
    open(payload) {
      if (open) return;
      open = true;
      trace?.record('gate.open', payload);
      gate.resolve(payload);
    },
    wait(options = {}) {
      if (open) {
        trace?.record('gate.wait:immediate');
        return Promise.resolve();
      }
      return gate.promise.then(() => {});
    },
  };
}
