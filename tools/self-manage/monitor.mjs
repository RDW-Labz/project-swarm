// SPDX-License-Identifier: Apache-2.0

import os from 'node:os';
import { createLaneHealthMonitor, readLaneHealth } from '../lane-health.mjs';

function configForLanes(config, laneNames) {
  if (!Array.isArray(laneNames) || laneNames.length === 0) {
    return config ?? {};
  }
  const lanes = {};
  for (const lane of laneNames) {
    if (typeof lane === 'string' && lane.startsWith('local:')) {
      const name = lane.slice('local:'.length);
      const endpoints = config?.lanes?.local?.endpoints;
      const ep = Array.isArray(endpoints) ? endpoints.find(item => item?.name === name) : null;
      if (ep) {
        if (!lanes.local) lanes.local = { endpoints: [] };
        lanes.local.endpoints.push(ep);
      }
    } else if (config?.lanes?.[lane]) {
      lanes[lane] = config.lanes[lane];
    }
  }
  return { lanes };
}

/**
 * Run one lane-health probe cycle via createLaneHealthMonitor (GET /v1/models or CLI --version only).
 * Returns persisted health snapshot in the same shape as readLaneHealth.
 */
export async function monitorLanesOnce({
  lanes,
  config = {},
  env = process.env,
  fetch,
  exec,
  now = Date.now,
  home = os.homedir(),
} = {}) {
  const probeConfig = configForLanes(config, lanes);
  const monitor = createLaneHealthMonitor({
    home,
    env,
    config: probeConfig,
    fetch,
    exec,
    now,
  });
  await monitor.tick();
  const snapshot = await readLaneHealth({ home, env });
  if (Array.isArray(lanes) && lanes.length > 0) {
    const filtered = {};
    for (const lane of lanes) {
      if (snapshot.lanes[lane]) filtered[lane] = snapshot.lanes[lane];
    }
    return {
      version: snapshot.version,
      lanes: filtered,
      updatedAt: snapshot.updatedAt,
    };
  }
  return snapshot;
}
