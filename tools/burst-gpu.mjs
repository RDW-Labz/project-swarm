// SPDX-License-Identifier: Apache-2.0

import { computeBurstGpuGates } from './burst-gates.mjs';

/**
 * Gate-checked entry for `swarm burst gpu start`. Provisions only when all gates pass
 * and the ticket is explicitly non-sensitive (`ticket.sensitive === false`).
 *
 * @param {object} inputs — same shape as {@link computeBurstGpuGates}
 * @param {object|null|undefined} ticket — burst ticket; rented lane refuses sensitive/unknown
 * @param {() => Promise<unknown>|unknown} [provision] — injected rental (e.g. gpuUp); not called on refusal
 */
export async function startBurstGpu(inputs, ticket, provision = async () => {}) {
  const gates = computeBurstGpuGates(inputs);

  if (!gates.pass) {
    return {
      ok: false,
      exitCode: 1,
      message: 'gates not met',
      lines: gates.lines,
      text: gates.text,
      gates,
    };
  }

  if (ticket == null || ticket.sensitive !== false) {
    return {
      ok: false,
      exitCode: 1,
      message: 'not allowed on rented lane',
      lines: gates.lines,
      text: gates.text,
      gates,
    };
  }

  const provisionResult = await provision();
  return {
    ok: true,
    exitCode: 0,
    message: 'burst gpu started',
    lines: gates.lines,
    text: gates.text,
    gates,
    provisionResult,
  };
}
