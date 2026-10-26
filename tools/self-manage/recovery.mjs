// Lane recovery: a down lane returns after N consecutive healthy checks;
// flapping lanes wait exponentially longer before checks count again.

export function createLaneRecovery(options = {}) {
  const requiredHealthy = options.requiredHealthy ?? 2;
  const baseBackoffMs = options.baseBackoffMs ?? 30000;
  const maxBackoffMs = options.maxBackoffMs ?? 3600000;
  const flapWindowMs = options.flapWindowMs ?? 600000;
  const lanes = new Map();

  function get(lane) {
    if (!lanes.has(lane)) {
      lanes.set(lane, { up: true, streak: 0, flaps: 0, retryAt: 0, returnedAt: null });
    }
    return lanes.get(lane);
  }

  function backoff(flaps) {
    return Math.min(maxBackoffMs, baseBackoffMs * 2 ** flaps);
  }

  function recordCheck(lane, healthy, at = Date.now()) {
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
    return get(lane).up;
  }

  function status(lane) {
    const s = get(lane);
    return { up: s.up, healthyStreak: s.streak, flaps: s.flaps, retryAt: s.retryAt };
  }

  return { recordCheck, isUp, status };
}
