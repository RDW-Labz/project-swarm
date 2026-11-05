// SPDX-License-Identifier: Apache-2.0
// Lane doctor gate: before a run routes an `auto` job, each lane it could use is checked once with the
// same `swarm doctor` check an operator runs, in the run's own environment (a CI runner or launchd
// service often lacks the shell's keys and logins). A lane that fails is skipped for the whole run and
// the router falls back to the next healthy lane. A launch preflight that fails later (for example a
// Cursor credential that disappeared) marks the lane failed the same way.
import { doctor } from './swarm/core-32.mjs';

// Doctor statuses that mean "this lane can take a job now". Anything else, or a doctor that throws, fails.
export const LANE_DOCTOR_PASS = Object.freeze(['compatible', 'configured', 'ok', 'ok-unverified', 'ok-auth-required', 'remote-unchecked']);
export const LANE_DOCTOR_TIMEOUT_MS = 20000;

const shortReason = value => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, 200);

export function createLaneDoctorGate({ doctorImpl = doctor, env = process.env, root, timeoutMs = LANE_DOCTOR_TIMEOUT_MS } = {}) {
  const pending = new Map(), settled = new Map();
  const check = agent => {
    if (!pending.has(agent)) {
      let timer;
      const timeout = new Promise(resolve => { timer = setTimeout(() => resolve({ status: 'timeout', note: `doctor did not answer in ${timeoutMs} ms` }), timeoutMs); });
      pending.set(agent, Promise.race([Promise.resolve().then(() => doctorImpl({ agent, env, root })), timeout])
        .catch(error => ({ status: 'error', note: error?.message }))
        .then(result => {
          clearTimeout(timer);
          const status = typeof result?.status === 'string' ? result.status : 'unknown';
          const ok = LANE_DOCTOR_PASS.includes(status);
          const entry = { ok, status, ...(ok ? {} : { reason: shortReason(result?.note ?? result?.reason ?? result?.error ?? status) }) };
          // A lane already marked failed by a preflight stays failed.
          if (settled.get(agent)?.ok !== false) settled.set(agent, entry);
          return settled.get(agent);
        }));
    }
    return pending.get(agent);
  };
  return {
    check,
    async prepare(agents) { await Promise.all([...new Set(agents)].map(check)); },
    // Sync, for the router: a lane not checked yet counts as ready, so only a real failure removes it.
    ready: agent => settled.get(agent)?.ok !== false,
    markFailed(agent, reason) { settled.set(agent, { ok: false, status: 'preflight-failed', reason: shortReason(reason) }); pending.set(agent, Promise.resolve(settled.get(agent))); },
    report: () => Object.fromEntries([...settled].sort(([a], [b]) => a.localeCompare(b))),
  };
}
