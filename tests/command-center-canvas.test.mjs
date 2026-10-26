// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  hiveStreamDensityForProject,
  hiveStreamSpeedForTicketsPerHour,
  hiveStreamsPauseWhenDocumentHidden,
  hiveStreamsPrefersReducedMotion,
  hiveStreamsRenderPath,
  HIVE_STREAM_RENDER_STATIC,
  HIVE_STREAM_RENDER_ANIMATED,
  HIVE_STREAM_MIN_PARTICLES_PER_LINK,
  HIVE_STREAM_DENSITY_BASE,
  HIVE_STREAM_DENSITY_PER_ACTIVE_AGENT,
  HIVE_STREAM_SPEED_BASE,
  HIVE_STREAM_SPEED_PER_TICKET_PER_HOUR,
  HIVE_STREAM_FRAME_MS,
  bezierPoint,
  buildHiveStreams,
  advanceAndDrawHiveStreamComets,
} from '../tools/watch-assets/hive-streams.js';
import {
  hiveBrainStateFromEvents,
  hiveBrainReducedMotionStillFrame,
  hiveBrainMotionDescriptor,
  HIVE_BRAIN_MERGE_PULSE_MS,
  HIVE_BRAIN_FAILURE_ACTIVE_MS,
  HIVE_BRAIN_IDLE_AFTER_MS,
} from '../tools/watch-assets/hive-brain.js';

const NOW = Date.UTC(2026, 9, 26, 21, 0, 0);

test('hiveStreamDensityForProject scales with active agents (min 120 per link)', () => {
  const cases = [
    { activeAgents: 0, want: HIVE_STREAM_MIN_PARTICLES_PER_LINK },
    { activeAgents: 1, want: HIVE_STREAM_DENSITY_BASE + HIVE_STREAM_DENSITY_PER_ACTIVE_AGENT },
    { activeAgents: 3, want: HIVE_STREAM_DENSITY_BASE + 3 * HIVE_STREAM_DENSITY_PER_ACTIVE_AGENT },
    { activeAgents: 12, want: HIVE_STREAM_DENSITY_BASE + 12 * HIVE_STREAM_DENSITY_PER_ACTIVE_AGENT },
  ];
  for (const { activeAgents, want } of cases) {
    const count = hiveStreamDensityForProject({ activeAgents });
    assert.ok(count >= HIVE_STREAM_MIN_PARTICLES_PER_LINK, `agents=${activeAgents}`);
    assert.equal(count, want, `agents=${activeAgents}`);
  }
});

test('hiveStreamSpeedForTicketsPerHour scales with throughput', () => {
  const cases = [
    { tph: 0, want: HIVE_STREAM_SPEED_BASE },
    { tph: 100, want: HIVE_STREAM_SPEED_BASE + 100 * HIVE_STREAM_SPEED_PER_TICKET_PER_HOUR },
    { tph: 400, want: HIVE_STREAM_SPEED_BASE + 400 * HIVE_STREAM_SPEED_PER_TICKET_PER_HOUR },
  ];
  for (const { tph, want } of cases) {
    const speed = hiveStreamSpeedForTicketsPerHour(tph);
    assert.equal(speed, want, `tph=${tph}`);
  }
});

test('hiveStreamsPauseWhenDocumentHidden follows Page Visibility', () => {
  assert.equal(hiveStreamsPauseWhenDocumentHidden({ hidden: true }), true);
  assert.equal(hiveStreamsPauseWhenDocumentHidden({ hidden: false }), false);
});

test('reduced motion selects static dots vs animated comets', () => {
  assert.equal(hiveStreamsPrefersReducedMotion({ matches: true }), true);
  assert.equal(hiveStreamsPrefersReducedMotion({ matches: false }), false);
  assert.equal(
    hiveStreamsRenderPath({ reducedMotion: true, documentHidden: false }),
    HIVE_STREAM_RENDER_STATIC,
  );
  assert.equal(
    hiveStreamsRenderPath({ reducedMotion: false, documentHidden: false }),
    HIVE_STREAM_RENDER_ANIMATED,
  );
  assert.equal(
    hiveStreamsRenderPath({ reducedMotion: false, documentHidden: true }),
    HIVE_STREAM_RENDER_STATIC,
  );
});

test('bezierPoint and buildHiveStreams produce curved card→ring links', () => {
  const pt = bezierPoint({ x: 0, y: 0 }, { x: 50, y: 10 }, { x: 100, y: 0 }, 0.5);
  assert.ok(pt.x > 40 && pt.x < 60);
  const geom = { cx: 200, cy: 200, ringR: 80, phone: false };
  const streams = buildHiveStreams(
    [{ node: { lane: 'route', side: 'left' }, angle: Math.PI, box: { left: 10, top: 100, right: 110, bottom: 160, width: 100, height: 60 } }],
    geom,
  );
  assert.equal(streams.length, 1);
  assert.deepEqual(streams[0].rgb, [94, 184, 255]);
  assert.ok(streams[0].ctrl.x !== (streams[0].from.x + streams[0].to.x) / 2);
});

test('hiveBrainStateFromEvents resolves merge, failure, idle, working', () => {
  const mergeOnly = hiveBrainStateFromEvents(
    [{ kind: 'merge', ts: NOW - 500 }],
    NOW,
  );
  assert.equal(mergeOnly, 'merge');

  const failureWins = hiveBrainStateFromEvents(
    [
      { kind: 'merge', ts: NOW - 1000 },
      { kind: 'error', ts: NOW - 2000 },
    ],
    NOW,
  );
  assert.equal(failureWins, 'failure');

  const working = hiveBrainStateFromEvents(
    [{ kind: 'ticket', ts: NOW - 5000 }],
    NOW,
  );
  assert.equal(working, 'working');

  const idle = hiveBrainStateFromEvents(
    [{ kind: 'ticket', ts: NOW - HIVE_BRAIN_IDLE_AFTER_MS - 1000 }],
    NOW,
  );
  assert.equal(idle, 'idle');

  const staleMerge = hiveBrainStateFromEvents(
    [{ kind: 'merge', ts: NOW - HIVE_BRAIN_MERGE_PULSE_MS - 1 }],
    NOW,
  );
  assert.equal(staleMerge, 'idle');

  const staleFailure = hiveBrainStateFromEvents(
    [{ kind: 'failure', ts: NOW - HIVE_BRAIN_FAILURE_ACTIVE_MS - 1 }],
    NOW,
  );
  assert.equal(staleFailure, 'idle');
});

test('hiveBrain reduced motion returns still frame not animation descriptor', () => {
  for (const state of ['idle', 'working', 'merge', 'failure']) {
    const frame = hiveBrainReducedMotionStillFrame(state);
    assert.ok(frame.coreClass.includes('hive-core'));
    assert.equal(typeof frame.statusText, 'string');
    assert.equal(frame.animation, undefined);
    assert.equal(frame.loop, undefined);
  }
  const motion = hiveBrainMotionDescriptor('merge');
  assert.equal(typeof motion.animation, 'string');
  assert.equal(motion.loop, false);
});

function createFakeCanvas2DContext() {
  return {
    save() {},
    restore() {},
    globalCompositeOperation: 'source-over',
    strokeStyle: '',
    fillStyle: '',
    lineWidth: 1,
    strokeCalls: 0,
    fillCalls: 0,
    beginPath() {},
    moveTo() {},
    lineTo() {},
    stroke() {
      this.strokeCalls += 1;
    },
    arc() {},
    fill() {
      this.fillCalls += 1;
    },
  };
}

function particleAdvancementSignature(particles) {
  let sig = particles.length;
  for (const p of particles) {
    sig += p.t * 1e6 + p.speed * 1e3;
  }
  return sig;
}

test('hive stream comets sustain 30fps frame budget over 5s with four projects (fake clock + rAF)', () => {
  const SIM_WINDOW_MS = 5000;
  const MIN_FRAMES = 150;

  const projects = [
    { activeAgents: 8 },
    { activeAgents: 6 },
    { activeAgents: 10 },
    { activeAgents: 12 },
  ];
  const targetPerStream = Math.max(
    ...projects.map((project) => hiveStreamDensityForProject(project)),
  );
  const ticketsPerHour = 400;

  const geom = { cx: 400, cy: 300, ringR: 100, phone: false };
  const lanes = ['route', 'safety', 'context', 'control'];
  const sides = ['left', 'right', 'left', 'right'];
  const nodeEntries = projects.map((_, i) => ({
    node: { lane: lanes[i], side: sides[i] },
    angle: (Math.PI * 2 * i) / projects.length,
    box: {
      left: 10 + i * 130,
      top: 80,
      right: 110 + i * 130,
      bottom: 140,
      width: 100,
      height: 60,
    },
  }));
  const streams = buildHiveStreams(nodeEntries, geom);
  assert.equal(streams.length, 4);

  const particles = [];
  const ctx = createFakeCanvas2DContext();

  let now = 0;
  const rafQueue = [];
  const requestAnimationFrame = (callback) => {
    rafQueue.push(callback);
    return rafQueue.length;
  };
  const flushAnimationFrameQueue = () => {
    while (rafQueue.length > 0) {
      const callback = rafQueue.shift();
      callback(now);
    }
  };

  let framesProcessed = 0;
  let totalStrokeCalls = 0;

  const onAnimationFrame = () => {
    const before = particleAdvancementSignature(particles);
    advanceAndDrawHiveStreamComets(ctx, streams, particles, targetPerStream, ticketsPerHour);
    const after = particleAdvancementSignature(particles);
    assert.ok(
      particles.length > 0 && after !== before,
      'advanceAndDrawHiveStreamComets must mutate particle state each frame',
    );
    totalStrokeCalls += ctx.strokeCalls;
    assert.ok(ctx.fillCalls > 0, 'expected comet head fills each frame');
    framesProcessed += 1;
    now += HIVE_STREAM_FRAME_MS;
    if (framesProcessed < MIN_FRAMES) {
      requestAnimationFrame(onAnimationFrame);
    }
  };

  requestAnimationFrame(onAnimationFrame);
  while (rafQueue.length > 0) {
    flushAnimationFrameQueue();
  }

  assert.ok(
    Math.abs(now - SIM_WINDOW_MS) < 1e-6,
    `simulated clock should advance ${SIM_WINDOW_MS}ms, got ${now}`,
  );
  assert.ok(
    framesProcessed >= MIN_FRAMES,
    `expected at least ${MIN_FRAMES} frames in ${SIM_WINDOW_MS}ms simulated time, got ${framesProcessed}`,
  );
  assert.ok(totalStrokeCalls > 0, 'expected trail stroke work across the simulated window');
});
