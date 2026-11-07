// SPDX-License-Identifier: Apache-2.0

/** True when Command Center routes and APIs are enabled (env or board config). */
export function commandCenterEnabled(env = process.env, config = null) {
  if (env?.SWARM_COMMAND_CENTER === '0') return false;
  if (env?.SWARM_COMMAND_CENTER === '1') return true;
  if (config?.commandCenter === false) return false;
  if (config?.commandCenter === true) return true;
  return true;
}
