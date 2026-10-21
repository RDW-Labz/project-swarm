// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';
import {
  createLaneCaps,
  createTuner,
  defaultLimit,
  describe as describeBoard,
  readMachine,
  stateFilePath,
} from '../tools/autotune.mjs';

describe('defaultLimit', () => {
  it('matches documented examples', () => {
    assert.equal(defaultLimit({ cores: 10, freeRamGb: 20, totalRamGb: 64 }), 20);
    assert.equal(defaultLimit({ cores: 8, freeRamGb: 6, totalRamGb: 32 }), 4);
  });

  it('clamps to at least 4 and at most 64', () => {
    assert.equal(defaultLimit({ cores: 1, freeRamGb: 100, totalRamGb: 128 }), 4);
    assert.equal(defaultLimit({ cores: 100, freeRamGb: 200, totalRamGb: 256 }), 64);
  });
});

describe('readMachine', () => {
  it('reads memory and uses injectable cpu sampler', async () => {
    const fakeOs = {
      cpus: () => [{ times: { user: 1, idle: 9 } }, { times: { user: 1, idle: 9 } }],
      freemem: () => 8 * 1024 ** 3,
      totalmem: () => 16 * 1024 ** 3,
    };
    const m = await readMachine({
      os: fakeOs,
      measureCpu: async () => 42,
    });
    assert.equal(m.cores, 2);
    assert.equal(m.freeRamGb, 8);
    assert.equal(m.totalRamGb, 16);
    assert.equal(m.cpuPercent, 42);
  });
});

describe('createTuner', () => {
  const healthy = { cpuPercent: 50, freeRamGb: 16, inUse: 4, waiting: 3, rateLimitedLanes: [] };

  it('raises by one step when work is waiting and headroom exists', () => {
    const tuner = createTuner({ limit: 10 });
    const r = tuner.tune(healthy);
    assert.equal(r.limit, 11);
    assert.equal(r.reason, 'none');
    assert.equal(r.capped, 'none');
  });

  it('does not raise when nothing waits', () => {
    const tuner = createTuner({ limit: 10 });
    const r = tuner.tune({ ...healthy, waiting: 0 });
    assert.equal(r.limit, 10);
    assert.equal(r.reason, 'no-ready-tickets');
    assert.equal(r.capped, 'no-ready-tickets');
  });

  it('backs off on high cpu', () => {
    const tuner = createTuner({ limit: 16 });
    const r = tuner.tune({ ...healthy, cpuPercent: 82, waiting: 0 });
    assert.equal(r.limit, 12);
    assert.equal(r.reason, 'cpu');
    assert.equal(r.capped, 'cpu');
  });

  it('backs off on low ram', () => {
    const tuner = createTuner({ limit: 16 });
    const r = tuner.tune({ ...healthy, freeRamGb: 3.5, waiting: 0 });
    assert.equal(r.limit, 12);
    assert.equal(r.reason, 'ram');
    assert.equal(r.capped, 'ram');
  });

  it('backs off when a lane is rate limited', () => {
    const tuner = createTuner({ limit: 16 });
    const r = tuner.tune({ ...healthy, rateLimitedLanes: ['ci'], waiting: 0 });
    assert.equal(r.limit, 12);
    assert.equal(r.reason, 'lane-rate-limit');
    assert.equal(r.capped, 'lane-rate-limit');
  });

  it('never drops below min', () => {
    const tuner = createTuner({ limit: 5, min: 4 });
    tuner.tune({ ...healthy, cpuPercent: 95, waiting: 0 });
    const r = tuner.tune({ ...healthy, cpuPercent: 95, waiting: 0 });
    assert.equal(r.limit, 4);
  });

  it('changes by at most one step per call', () => {
    const tuner = createTuner({ limit: 20 });
    const up = tuner.tune(healthy);
    assert.equal(up.limit, 21);
    const down = createTuner({ limit: 20 }).tune({ ...healthy, cpuPercent: 90, waiting: 0 });
    assert.equal(down.limit, 15);
  });
});

describe('createLaneCaps', () => {
  it('cuts cap on rate limit and restores after clean windows', () => {
    let t = 0;
    const now = () => t;
    const caps = createLaneCaps({ initial: 20, min: 1, now });
    assert.equal(caps.cap('main'), 20);

    caps.onRateLimit('main');
    assert.equal(caps.cap('main'), 15);

    t += 5 * 60 * 1000;
    caps.onClean('main');
    assert.equal(caps.cap('main'), 15);

    t += 5 * 60 * 1000;
    caps.onClean('main');
    assert.equal(caps.cap('main'), 15);

    t += 10 * 60 * 1000;
    caps.onClean('main');
    assert.equal(caps.cap('main'), 16);

    t += 10 * 60 * 1000;
    caps.onClean('main');
    assert.equal(caps.cap('main'), 17);
    assert.ok(caps.cap('main') <= 20);
  });

  it('never raises above initial', () => {
    let t = 0;
    const now = () => t;
    const caps = createLaneCaps({ initial: 8, now });
    caps.onRateLimit('x');
    t += 10 * 60 * 1000;
    for (let i = 0; i < 20; i += 1) {
      t += 10 * 60 * 1000;
      caps.onClean('x');
    }
    assert.equal(caps.cap('x'), 8);
  });

  it('round-trips through JSON', () => {
    let t = 1000;
    const caps = createLaneCaps({ initial: 12, min: 2, now: () => t });
    caps.onRateLimit('a');
    const json = caps.toJSON();
    const restored = createLaneCaps.fromJSON(json, { now: () => t });
    assert.equal(restored.cap('a'), 9);
    assert.deepEqual(restored.toJSON(), json);
  });
});

describe('stateFilePath', () => {
  it('sits beside the machine config', () => {
    const config = '/tmp/custom/config.json';
    const p = stateFilePath({ SWARM_CONFIG: config }, '/home/me');
    assert.equal(p, path.join('/tmp/custom', 'autotune-state.json'));
  });
});

describe('describe board text', () => {
  it('formats each capped reason', () => {
    assert.equal(
      describeBoard({ limit: 16, inUse: 9, capped: 'cpu', cpuPercent: 82 }),
      'limit 16, in use 9, capped by CPU 82 percent',
    );
    assert.equal(
      describeBoard({ limit: 8, inUse: 8, capped: 'ram', freeRamGb: 3.2 }),
      'limit 8, in use 8, capped by RAM 3.2 GB free',
    );
    assert.equal(
      describeBoard({ limit: 12, inUse: 6, capped: 'lane-rate-limit' }),
      'limit 12, in use 6, capped by lane rate limit',
    );
    assert.equal(
      describeBoard({ limit: 10, inUse: 2, capped: 'no-ready-tickets' }),
      'limit 10, in use 2, capped by no ready tickets',
    );
    assert.equal(
      describeBoard({ limit: 20, inUse: 10, capped: 'none' }),
      'limit 20, in use 10, not capped',
    );
  });
});
