import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as run from '../tools/swarm-run.mjs';

test('AC1: swarm-run module exports runPipeline', { todo: 'extraction not done: swarm.mjs source not supplied' }, () => {
  assert.equal(typeof run.runPipeline, 'function');
});
