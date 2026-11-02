// Lane recovery: a down lane returns after N consecutive healthy checks;
// flapping lanes wait exponentially longer before checks count again.

const DEFAULT_REQUIRED_HEALTHY = 2;
const DEFAULT_BASE_BACKOFF_MS = 30000;
const DEFAULT_MAX_BACKOFF_MS = 3600000;
const DEFAULT_FLAP_WINDOW_MS = 600000;

function clampRequiredHealthy(value) {
  if (!Number.isFinite(value)) return DEFAULT_REQUIRED_HEALTHY;
  const n = Math.trunc(value);
  return n < 1 ? 1 : n;
}

function clampBackoffMs(value, fallback) {
  if (!Number.isFinite(value) || value < 0) return fallback;
  return value;
}

const UNKNOWN_STATUS = Object.freeze({
  up: false,
  healthyStreak: 0,
  flaps: 0,
  retryAt: 0,
});

export function createLaneRecovery(options = {}) {
  const requiredHealthy = clampRequiredHealthy(options.requiredHealthy);
  const baseBackoffMs = clampBackoffMs(options.baseBackoffMs, DEFAULT_BASE_BACKOFF_MS);
  const maxBackoffMs = clampBackoffMs(options.maxBackoffMs, DEFAULT_MAX_BACKOFF_MS);
  const flapWindowMs = clampBackoffMs(options.flapWindowMs, DEFAULT_FLAP_WINDOW_MS);
  const lanes = new Map();

  function get(lane) {
    if (!lanes.has(lane)) {
      lanes.set(lane, { up: false, streak: 0, flaps: 0, retryAt: 0, returnedAt: null });
    }
    return lanes.get(lane);
  }

  function backoff(flaps) {
    return Math.min(maxBackoffMs, baseBackoffMs * 2 ** flaps);
  }

  function recordCheck(lane, healthy, at = Date.now()) {
    if (!Number.isFinite(at)) {
      const s = lanes.get(lane);
      return s ? s.up : false;
    }
    const s = get(lane);
    if (!healthy) {
      s.streak = 0;
      if (s.up) {
        s.up = false;
        if (s.returnedAt !== null && at - s.returnedAt < flapWindowMs) s.flaps += 1;
        else s.flaps = 0;
        s.retryAt = at + backoff(s.flaps);
      }
      return s.up;
    }
    if (s.up) return true;
    if (at < s.retryAt) {
      s.streak = 0;
      return false;
    }
    s.streak += 1;
    if (s.streak >= requiredHealthy) {
      s.up = true;
      s.streak = 0;
      s.returnedAt = at;
    }
    return s.up;
  }

  function isUp(lane) {
    const s = lanes.get(lane);
    if (!s) return false;
    return s.up;
  }

  function status(lane) {
    const s = lanes.get(lane);
    if (!s) return UNKNOWN_STATUS;
    return { up: s.up, healthyStreak: s.streak, flaps: s.flaps, retryAt: s.retryAt };
  }

  function forget(lane) {
    lanes.delete(lane);
  }

  function prune(lanesKept) {
    const kept = new Set(Array.isArray(lanesKept) ? lanesKept : []);
    for (const lane of [...lanes.keys()]) {
      if (!kept.has(lane)) lanes.delete(lane);
    }
  }

  return { recordCheck, isUp, status, forget, prune };
}
