// SPDX-License-Identifier: Apache-2.0

export const LANE_AGENTS = Object.freeze([
  'hermes', 'cursor', 'codex', 'claude', 'qwen', 'openai', 'gemini', 'ollama', 'lambda', 'openrouter',
]);
export const LANE_DEFAULTS = Object.freeze(Object.fromEntries(LANE_AGENTS.map(agent => [agent, Object.freeze({
  concurrency: ({ hermes: 3, cursor: 8, codex: 6, claude: 4, openrouter: 64 })[agent] ?? 32,
  requestsPerMinute: null,
  backoff: Object.freeze({ baseMs: 2000, maxMs: 300000, maxRetries: 5 }),
  pauseMs: 900000,
  maxPauseMs: 900000,
  model: null,
})])));

function invalid(agent, field, reason) {
  return Object.assign(new Error(`lanes-invalid: ${agent}.${field} ${reason}`), { code: 'lanes-invalid' });
}
function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function integer(agent, field, value, min, max) {
  if (!Number.isInteger(value) || value < min || value > max) throw invalid(agent, field, `must be an integer ${min}–${max}`);
}
function validate(agent, lane) {
  integer(agent, 'concurrency', lane.concurrency, 1, 512);
  if (lane.requestsPerMinute !== null) integer(agent, 'requestsPerMinute', lane.requestsPerMinute, 1, 100000);
  integer(agent, 'backoff.baseMs', lane.backoff.baseMs, 1, 600000);
  integer(agent, 'backoff.maxMs', lane.backoff.maxMs, lane.backoff.baseMs, 3600000);
  integer(agent, 'backoff.maxRetries', lane.backoff.maxRetries, 0, 20);
  integer(agent, 'pauseMs', lane.pauseMs, 1, 86400000);
  integer(agent, 'maxPauseMs', lane.maxPauseMs, 1, 86400000);
  if (lane.model !== null && (typeof lane.model !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:\/-]{0,119}$/.test(lane.model))) {
    throw invalid(agent, 'model', 'must be null or a valid model name');
  }
}

export function resolveLanes({ config = {}, manifest = {} } = {}) {
  const lanes = Object.fromEntries(LANE_AGENTS.map(agent => [agent, { ...LANE_DEFAULTS[agent], backoff: { ...LANE_DEFAULTS[agent].backoff } }]));
  for (const source of [config.lanes, manifest.lanes]) {
    if (source === undefined) continue;
    if (!object(source)) throw invalid('lanes', 'value', 'must be an object');
    for (const [agent, override] of Object.entries(source)) {
      if (!LANE_AGENTS.includes(agent)) throw invalid(agent, 'agent', 'is unknown');
      if (!object(override)) throw invalid(agent, 'value', 'must be an object');
      for (const [field, value] of Object.entries(override)) {
        if (!Object.hasOwn(LANE_DEFAULTS[agent], field)) throw invalid(agent, field, 'is unknown');
        if (field === 'backoff') {
          if (!object(value)) throw invalid(agent, field, 'must be an object');
          for (const [key, entry] of Object.entries(value)) {
            if (!Object.hasOwn(LANE_DEFAULTS[agent].backoff, key)) throw invalid(agent, `backoff.${key}`, 'is unknown');
            lanes[agent].backoff[key] = entry;
          }
        } else lanes[agent][field] = value;
      }
    }
  }
  for (const agent of LANE_AGENTS) validate(agent, lanes[agent]);
  return lanes;
}

export function classifyProviderOutcome(result) {
  const { status, error, httpStatus, retryAfterMs, quotaExhausted, resetsAt } = result ?? {};
  const retry = typeof retryAfterMs === 'number' && Number.isFinite(retryAfterMs) && retryAfterMs >= 0 ? retryAfterMs : null;
  const reset = typeof resetsAt === 'string' ? resetsAt : null;
  let kind = 'other';
  if (status === 'complete') kind = 'ok';
  else if (status === 'provider-limit' || quotaExhausted === true || httpStatus === 402
    || (typeof error === 'string' && /\b(quota (exhausted|exceeded)|insufficient[_ ](quota|credits?)|out of credits?)\b/i.test(error))) kind = 'quota-exhausted';
  else if (httpStatus === 429 || (typeof error === 'string' && /\b(429|rate[- ]?limit(ed)?|too many requests)\b/i.test(error))) kind = 'rate-limited';
  return { kind, retryAfterMs: retry, resetsAt: reset };
}

function abortError() {
  return Object.assign(new Error('Lane scheduler closed or acquisition aborted'), { name: 'AbortError' });
}

export class LaneScheduler {
  constructor({ lanes, globalConcurrency, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout, random = Math.random }) {
    integer('global', 'concurrency', globalConcurrency, 1, 512);
    this.lanes = resolveLanes({ manifest: { lanes } });
    this.globalConcurrency = globalConcurrency;
    this.now = now;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.random = random;
    this.globalInFlight = 0;
    this.peakGlobal = 0;
    this.nextArrival = 0;
    this.closed = false;
    this.timer = null;
    this.states = Object.fromEntries(LANE_AGENTS.map(agent => [agent, {
      state: 'ok', until: null, inFlight: 0, peak: 0, queue: [], acquisitions: [], consecutiveRateLimits: 0, used: false,
    }]));
  }

  lane(agent) {
    if (!Object.hasOwn(this.states, agent)) throw invalid(agent, 'agent', 'is unknown');
    return this.states[agent];
  }

  refresh(lane, time) {
    if (lane.until !== null && lane.until <= time) {
      lane.state = 'ok';
      lane.until = null;
    }
    while (lane.acquisitions.length && lane.acquisitions[0] <= time - 60000) lane.acquisitions.shift();
  }

  acquire(agent, { signal } = {}) {
    const lane = this.lane(agent);
    if (this.closed || signal?.aborted) return Promise.reject(abortError());
    lane.used = true;
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject, signal, abort: null, arrival: this.nextArrival++ };
      waiter.abort = () => {
        const index = lane.queue.indexOf(waiter);
        if (index < 0) return;
        lane.queue.splice(index, 1);
        signal.removeEventListener('abort', waiter.abort);
        reject(abortError());
        this.pump();
      };
      lane.queue.push(waiter);
      signal?.addEventListener('abort', waiter.abort, { once: true });
      this.pump();
    });
  }

  pump() {
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = null;
    if (this.closed) return;
    const time = this.now();
    let wakeAt = Infinity;
    for (const agent of LANE_AGENTS) {
      const lane = this.states[agent];
      this.refresh(lane, time);
      if (lane.until !== null) wakeAt = Math.min(wakeAt, lane.until);
    }
    while (this.globalInFlight < this.globalConcurrency) {
      let selected = null;
      for (const agent of LANE_AGENTS) {
        const lane = this.states[agent];
        const limits = this.lanes[agent];
        if (!lane.queue.length || lane.state !== 'ok' || lane.inFlight >= limits.concurrency) continue;
        if (limits.requestsPerMinute !== null && lane.acquisitions.length >= limits.requestsPerMinute) continue;
        if (selected === null || lane.queue[0].arrival < this.states[selected].queue[0].arrival) selected = agent;
      }
      if (selected === null) break;
      const lane = this.states[selected];
      const limits = this.lanes[selected];
      const waiter = lane.queue.shift();
      waiter.signal?.removeEventListener('abort', waiter.abort);
      lane.inFlight += 1;
      this.globalInFlight += 1;
      lane.peak = Math.max(lane.peak, lane.inFlight);
      this.peakGlobal = Math.max(this.peakGlobal, this.globalInFlight);
      if (limits.requestsPerMinute !== null) lane.acquisitions.push(time);
      let released = false;
      waiter.resolve(() => {
        if (released) return;
        released = true;
        lane.inFlight -= 1;
        this.globalInFlight -= 1;
        this.pump();
      });
    }
    for (const agent of LANE_AGENTS) {
      const lane = this.states[agent];
      const limits = this.lanes[agent];
      if (lane.state !== 'ok') continue;
      if (lane.queue.length && limits.requestsPerMinute !== null && lane.acquisitions.length >= limits.requestsPerMinute) {
        wakeAt = Math.min(wakeAt, lane.acquisitions[0] + 60000);
      }
    }
    if (Number.isFinite(wakeAt)) this.timer = this.setTimer(() => { this.timer = null; this.pump(); }, Math.max(0, wakeAt - time));
  }

  report(agent, outcome) {
    const lane = this.lane(agent);
    if (this.closed) return;
    const limits = this.lanes[agent];
    lane.used = true;
    if (outcome.kind === 'rate-limited') {
      lane.consecutiveRateLimits += 1;
      const delay = outcome.retryAfterMs ?? Math.min(limits.backoff.maxMs, limits.backoff.baseMs * 2 ** (lane.consecutiveRateLimits - 1)) * (0.5 + this.random() / 2);
      const until = this.now() + delay;
      if (lane.state !== 'paused' || lane.until < until) {
        lane.state = 'backoff';
        lane.until = until;
      }
    } else if (outcome.kind === 'quota-exhausted') {
      const reset = typeof outcome.resetsAt === 'string' ? Date.parse(outcome.resetsAt) : NaN;
      lane.state = 'paused';
      lane.until = Number.isFinite(reset) && reset > this.now() ? reset : this.now() + limits.pauseMs;
    } else if (outcome.kind === 'ok') lane.consecutiveRateLimits = 0;
    this.pump();
  }

  health(agent) {
    const lane = this.lane(agent);
    this.refresh(lane, this.now());
    return {
      agent, state: lane.state, until: lane.until === null ? null : new Date(lane.until).toISOString(),
      inFlight: lane.inFlight, queued: lane.queue.length, concurrency: this.lanes[agent].concurrency,
      consecutiveRateLimits: lane.consecutiveRateLimits,
    };
  }

  snapshot() {
    const lanes = {};
    for (const agent of LANE_AGENTS) {
      const health = this.health(agent);
      if (this.states[agent].used || health.state !== 'ok') lanes[agent] = { ...health, peak: this.states[agent].peak };
    }
    return { globalConcurrency: this.globalConcurrency, globalInFlight: this.globalInFlight, peakGlobal: this.peakGlobal, lanes };
  }

  pausedFor(agent) {
    const lane = this.lane(agent);
    this.refresh(lane, this.now());
    return lane.state === 'paused' ? Math.max(0, lane.until - this.now()) : 0;
  }

  close() {
    this.closed = true;
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = null;
    for (const lane of Object.values(this.states)) {
      for (const waiter of lane.queue.splice(0)) {
        waiter.signal?.removeEventListener('abort', waiter.abort);
        waiter.reject(abortError());
      }
    }
  }
}
