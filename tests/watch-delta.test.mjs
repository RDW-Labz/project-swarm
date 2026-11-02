import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { diffSnapshots, applyDelta, createThrottle } from '../tools/watch-delta.mjs';

function snap(over, jobs) {
  return Object.assign({ schema: 1, runId: 'r1', status: 'live', kpi: { total: 2 } }, over || {}, { jobs: jobs || [] });
}

function clone(v) {
  return JSON.parse(JSON.stringify(v));
}

test('diffSnapshots with null prev reports every top-level key except jobs, with new values', () => {
  const next = snap({ goal: 'g' }, [{ id: 'a', status: 'queued' }]);
  const d = diffSnapshots(null, next);
  assert.deepEqual(Object.keys(d.keys).sort(), ['goal', 'kpi', 'runId', 'schema', 'status']);
  assert.equal(Object.prototype.hasOwnProperty.call(d.keys, 'jobs'), false);
  assert.deepEqual(d.keys.kpi, { total: 2 });
  assert.equal(d.keys.goal, 'g');
  assert.deepEqual(d.jobs.upserts, [{ id: 'a', status: 'queued' }]);
  assert.deepEqual(d.jobs.removed, []);
});

test('diffSnapshots of identical snapshots is empty', () => {
  const a = snap({}, [{ id: 'a', status: 'queued' }]);
  const b = snap({}, [{ id: 'a', status: 'queued' }]);
  const d = diffSnapshots(a, b);
  assert.deepEqual(d.keys, {});
  assert.deepEqual(d.jobs.upserts, []);
  assert.deepEqual(d.jobs.removed, []);
});

test('diffSnapshots reports no top-level key when only jobs changed', () => {
  const prev = snap({ status: 'live' }, [{ id: 'a', status: 'queued' }]);
  const next = snap({ status: 'live' }, [{ id: 'a', status: 'complete' }]);
  const d = diffSnapshots(prev, next);
  assert.deepEqual(d.keys, {});
  assert.equal(Object.prototype.hasOwnProperty.call(d.keys, 'jobs'), false);
  assert.deepEqual(d.jobs.upserts, [{ id: 'a', status: 'complete' }]);
});

test('diffSnapshots maps a changed top-level key to its new value', () => {
  const prev = snap({ status: 'live' }, []);
  const next = snap({ status: 'complete' }, []);
  const d = diffSnapshots(prev, next);
  assert.deepEqual(d.keys, { status: 'complete' });
});

test('diffSnapshots maps a changed nested object key to its full new value', () => {
  const prev = snap({ kpi: { total: 2, done: 0 } }, []);
  const next = snap({ kpi: { total: 2, done: 1 } }, []);
  const d = diffSnapshots(prev, next);
  assert.deepEqual(d.keys, { kpi: { total: 2, done: 1 } });
});

test('diffSnapshots gives new and changed jobs as upserts and disappeared ids as removed', () => {
  const prev = snap({}, [{ id: 'a', status: 'queued' }, { id: 'b', status: 'running' }]);
  const next = snap({}, [{ id: 'a', status: 'complete' }, { id: 'c', status: 'queued' }]);
  const d = diffSnapshots(prev, next);
  assert.deepEqual(d.jobs.upserts, [{ id: 'a', status: 'complete' }, { id: 'c', status: 'queued' }]);
  assert.deepEqual(d.jobs.removed, ['b']);
});

test('diffSnapshots leaves unchanged jobs out of upserts', () => {
  const prev = snap({}, [{ id: 'a', status: 'queued' }, { id: 'b', status: 'running' }]);
  const next = snap({}, [{ id: 'a', status: 'queued' }, { id: 'b', status: 'complete' }]);
  const d = diffSnapshots(prev, next);
  assert.deepEqual(d.jobs.upserts, [{ id: 'b', status: 'complete' }]);
  assert.deepEqual(d.jobs.removed, []);
});

test('applyDelta from null prev rebuilds the next snapshot', () => {
  const next = snap({ goal: 'g' }, [{ id: 'a', status: 'queued' }, { id: 'b', status: 'running' }]);
  const rebuilt = applyDelta(null, diffSnapshots(null, next));
  assert.deepEqual(rebuilt, next);
});

test('applyDelta merges changed keys, upserts by id, appends new ids and removes gone ids', () => {
  const prev = snap({ status: 'live' }, [{ id: 'a', status: 'queued' }, { id: 'b', status: 'running' }]);
  const next = snap({ status: 'complete' }, [{ id: 'a', status: 'complete' }, { id: 'c', status: 'queued' }]);
  const out = applyDelta(prev, diffSnapshots(prev, next));
  assert.equal(out.status, 'complete');
  assert.deepEqual(out.jobs, [{ id: 'a', status: 'complete' }, { id: 'c', status: 'queued' }]);
});

test('applyDelta appends new ids in delta order', () => {
  const prev = snap({}, [{ id: 'a', status: 'queued' }]);
  const next = snap({}, [{ id: 'a', status: 'queued' }, { id: 'x', status: 'queued' }, { id: 'y', status: 'queued' }]);
  const out = applyDelta(prev, diffSnapshots(prev, next));
  assert.deepEqual(out.jobs.map((j) => j.id), ['a', 'x', 'y']);
});

test('applyDelta does not mutate prev and returns a new object', () => {
  const prev = snap({ status: 'live' }, [{ id: 'a', status: 'queued' }, { id: 'b', status: 'running' }]);
  const before = JSON.stringify(prev);
  const next = snap({ status: 'complete' }, [{ id: 'a', status: 'complete' }]);
  const out = applyDelta(prev, diffSnapshots(prev, next));
  assert.notEqual(out, prev);
  assert.equal(JSON.stringify(prev), before);
});

test('round trip: applyDelta(a, diffSnapshots(a, b)) deep-equals b when order is kept and new jobs are appended', () => {
  const a = snap({ status: 'live', goal: 'x' }, [
    { id: 'a', status: 'queued', attempts: 0 },
    { id: 'b', status: 'running', attempts: 1 },
    { id: 'c', status: 'complete', attempts: 1 }
  ]);
  const b = snap({ status: 'live', goal: 'x', kpi: { total: 3, done: 1 } }, [
    { id: 'a', status: 'running', attempts: 1 },
    { id: 'b', status: 'running', attempts: 1 },
    { id: 'c', status: 'complete', attempts: 1 },
    { id: 'd', status: 'queued', attempts: 0 }
  ]);
  assert.deepEqual(applyDelta(a, diffSnapshots(a, b)), b);
});

test('round trip holds when a job is removed and the rest keep their order', () => {
  const a = snap({}, [{ id: 'a', status: 'queued' }, { id: 'b', status: 'running' }]);
  const b = snap({}, [{ id: 'a', status: 'queued' }]);
  assert.deepEqual(applyDelta(a, diffSnapshots(a, b)), b);
});

test('applyDelta output is a plain copy that survives a JSON round trip', () => {
  const prev = snap({}, [{ id: 'a', status: 'queued' }]);
  const next = snap({}, [{ id: 'a', status: 'complete' }]);
  const d = diffSnapshots(prev, next);
  const out = applyDelta(prev, d);
  assert.deepEqual(out, clone(out));
  assert.deepEqual(out.jobs, [{ id: 'a', status: 'complete' }]);
});

test('createThrottle sends the first call and then holds back until the interval has passed', () => {
  let t = 1000;
  const th = createThrottle(250, () => t);
  assert.equal(th.shouldSend(), true);
  t = 1100;
  assert.equal(th.shouldSend(), false);
  t = 1120;
  assert.equal(th.shouldSend(), false);
});

test('createThrottle allows a send again after the interval has passed', () => {
  let t = 1000;
  const th = createThrottle(250, () => t);
  assert.equal(th.shouldSend(), true);
  t = 1260;
  assert.equal(th.shouldSend(), true);
  t = 1300;
  assert.equal(th.shouldSend(), false);
});

test('createThrottle returns true at most once for many calls within one interval', () => {
  let t = 0;
  const th = createThrottle(1000, () => t);
  let trues = 0;
  for (let i = 0; i < 50; i++) {
    t = i * 10;
    if (th.shouldSend()) trues++;
  }
  assert.equal(trues, 1);
});
