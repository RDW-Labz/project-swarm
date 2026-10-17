import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBatchController } from '../tools/adaptive-batch.mjs';

const invalid = { code: 'batch-controller-invalid' };

function run(c, outcomes) {
  for (const passed of outcomes) c.record(passed);
}

test('defaults: start 10, empty history, zero streak', () => {
  const c = createBatchController();
  assert.equal(c.size, 10);
  assert.deepEqual(c.history, []);
  assert.deepEqual(c.state(), { size: 10, streak: 0, steps: { up: 0, down: 0 } });
});

test('ladder up: 10 to 25 to 50 after streaks of 3 passes', () => {
  const c = createBatchController();
  run(c, [true, true, true]);
  assert.equal(c.size, 25);
  assert.deepEqual(c.state(), { size: 25, streak: 0, steps: { up: 1, down: 0 } });
  run(c, [true, true, true]);
  assert.equal(c.size, 50);
  assert.equal(c.state().steps.up, 2);
});

test('history holds the size each batch used, one per record', () => {
  const c = createBatchController();
  run(c, [true, true, true, true]);
  assert.deepEqual(c.history, [10, 10, 10, 25]);
});

test('ladder down: 50 to 25 to 10 to 5 on single failures', () => {
  const c = createBatchController({ start: 50 });
  c.record(false);
  assert.equal(c.size, 25);
  c.record(false);
  assert.equal(c.size, 10);
  c.record(false);
  assert.equal(c.size, 5);
  assert.deepEqual(c.state().steps, { up: 0, down: 3 });
});

test('small sizes halve with ceiling and never go below min', () => {
  const c = createBatchController({ start: 5 });
  c.record(false);
  assert.equal(c.size, 3);
  c.record(false);
  assert.equal(c.size, 2);
  c.record(false);
  assert.equal(c.size, 1);
  c.record(false);
  assert.equal(c.size, 1);
});

test('a failure resets the streak', () => {
  const c = createBatchController();
  run(c, [true, true, false]);
  assert.equal(c.size, 5);
  assert.equal(c.state().streak, 0);
  run(c, [true, true]);
  assert.equal(c.size, 5);
  run(c, [true]);
  assert.equal(c.size, 25);
});

test('streak resets after a step up', () => {
  const c = createBatchController();
  run(c, [true, true, true]);
  assert.equal(c.size, 25);
  run(c, [true, true]);
  assert.equal(c.size, 25);
  assert.equal(c.state().streak, 2);
});

test('custom start 4 climbs to 25 after three passes', () => {
  const c = createBatchController({ start: 4 });
  assert.equal(c.size, 4);
  run(c, [true, true, true]);
  assert.equal(c.size, 25);
  assert.deepEqual(c.history, [4, 4, 4]);
});

test('custom start 4 halves to 2 on a failure', () => {
  const c = createBatchController({ start: 4 });
  c.record(false);
  assert.equal(c.size, 2);
});

test('min is respected when stepping down', () => {
  const c = createBatchController({ start: 2, min: 2 });
  c.record(false);
  assert.equal(c.size, 2);
  const d = createBatchController({ start: 1, min: 1 });
  d.record(false);
  assert.equal(d.size, 1);
});

test('max is respected when stepping up', () => {
  const c = createBatchController({ start: 10, max: 20 });
  run(c, [true, true, true]);
  assert.equal(c.size, 20);
  run(c, [true, true, true]);
  assert.equal(c.size, 20);
});

test('start equal to min and max is accepted', () => {
  const c = createBatchController({ start: 1, min: 1, max: 1 });
  assert.equal(c.size, 1);
});

test('invalid options throw batch-controller-invalid', () => {
  const bad = [
    { start: 0 },
    { start: -3 },
    { start: 2.5 },
    { start: '10' },
    { min: 0 },
    { max: 0 },
    { streak: 0 },
    { streak: 1.5 },
    { min: 11 },
    { start: 101 },
    { max: 5 },
  ];
  for (const opts of bad) {
    assert.throws(() => createBatchController(opts), invalid);
  }
});

test('state reports size, streak and step counts together', () => {
  const c = createBatchController({ start: 50 });
  run(c, [true, true]);
  assert.deepEqual(c.state(), { size: 50, streak: 2, steps: { up: 0, down: 0 } });
  c.record(false);
  assert.deepEqual(c.state(), { size: 25, streak: 0, steps: { up: 0, down: 1 } });
});
