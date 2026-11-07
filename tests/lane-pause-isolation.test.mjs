// SPDX-License-Identifier: Apache-2.0
// A paused lane must not hold back the other lanes. Fake time only: no sleeps, no timers.
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { claimLaneSlots, releaseLaneSlots, writeLanePause } from '../tools/lanes.mjs';

test('a paused gemini lane still lets other lanes claim slots, and gemini only after the pause expires', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-lane-pause-iso-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  let time = 1_000_000;
  const now = () => time;
  const claim = (agent, concurrency, count) => claimLaneSlots({ dir, agent, concurrency, count, runId: 'iso', now });

  const before = await claim('gemini', 4, 2);
  assert.equal(before.granted.length, 2, 'gemini is served before the pause');

  const until = time + 60_000;
  await writeLanePause({ dir, agent: 'gemini', state: 'paused', until, consecutiveRateLimits: 1, now });

  for (const offset of [0, 1, 30_000, 59_999]) {
    time = 1_000_000 + offset;
    const gemini = await claim('gemini', 4, 1);
    assert.deepEqual(gemini.granted, [], `gemini is refused at +${offset}ms`);
    assert.equal(gemini.state, 'paused');
    assert.equal(gemini.until, until);
    const ollama = await claim('ollama', 1, 1);
    const openai = await claim('openai', 1, 1);
    assert.equal(ollama.granted.length, 1, `ollama is served at +${offset}ms`);
    assert.equal(openai.granted.length, 1, `openai is served at +${offset}ms`);
    // Free the one-slot lanes again so the next window check claims fresh.
    assert.equal((await claim('ollama', 1, 1)).reason, 'full');
    await releaseLaneSlots({ dir, slots: [
      { agent: 'ollama', slotId: ollama.granted[0] }, { agent: 'openai', slotId: openai.granted[0] },
    ], now });
  }

  time = until;
  const after = await claim('gemini', 4, 2);
  assert.equal(after.granted.length, 2, 'gemini is granted slots once the pause has expired');
  assert.equal(after.inFlight, 4, 'slots held from before the pause still count against the cap');
});
