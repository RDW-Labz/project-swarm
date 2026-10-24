import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planWave, slotShares } from '../tools/chief-plan.mjs';

test('AC2: two projects each with ready tickets and cap 4 start jobs on both in the same wave', () => {
  const plan = planWave({
    cap: 4,
    projects: [
      { project: 'alpha', ready: ['a1', 'a2', 'a3'] },
      { project: 'beta', ready: ['b1', 'b2', 'b3'] },
    ],
  });
  assert.equal(plan.wave.length, 4);
  const alpha = plan.wave.filter((w) => w.project === 'alpha').length;
  const beta = plan.wave.filter((w) => w.project === 'beta').length;
  assert.ok(alpha >= 1, 'alpha has a job in the wave');
  assert.ok(beta >= 1, 'beta has a job in the wave');
  assert.equal(alpha, 2);
  assert.equal(beta, 2);
  assert.equal(plan.free, 0);
});

test('AC2: a project with no ready tickets gets no slots while others do', () => {
  const plan = planWave({
    cap: 4,
    projects: [
      { project: 'alpha', ready: [] },
      { project: 'beta', ready: ['b1', 'b2'] },
    ],
  });
  assert.equal(plan.wave.length, 2);
  assert.ok(plan.wave.every((w) => w.project === 'beta'));
  assert.equal(plan.free, 2);
});

test('running jobs count against the machine cap', () => {
  const plan = planWave({
    cap: 4,
    projects: [
      { project: 'alpha', ready: ['a1', 'a2'], running: 3 },
      { project: 'beta', ready: ['b1', 'b2'] },
    ],
  });
  assert.equal(plan.wave.length, 1);
  assert.equal(plan.wave[0].project, 'beta');
});

test('wave never exceeds the cap', () => {
  const plan = planWave({
    cap: 3,
    projects: [
      { project: 'alpha', ready: ['a1', 'a2'] },
      { project: 'beta', ready: ['b1', 'b2'] },
      { project: 'gamma', ready: ['c1', 'c2'] },
    ],
  });
  assert.equal(plan.wave.length, 3);
});

test('planWave rejects an invalid cap', () => {
  assert.throws(() => planWave({ cap: 0, projects: [] }), { code: 'chief-plan-invalid' });
  assert.throws(() => planWave({ cap: 1.5, projects: [] }), { code: 'chief-plan-invalid' });
});

test('planWave rejects duplicate project names', () => {
  assert.throws(
    () => planWave({ cap: 2, projects: [{ project: 'a', ready: [] }, { project: 'a', ready: [] }] }),
    { code: 'chief-plan-invalid' },
  );
});

test('slotShares lists only projects with slots in use', () => {
  const plan = planWave({
    cap: 2,
    projects: [
      { project: 'alpha', ready: ['a1'] },
      { project: 'idle', ready: [] },
    ],
  });
  const rows = slotShares(plan);
  assert.deepEqual(rows.map((r) => r.project), ['alpha']);
  assert.equal(rows[0].total, 1);
});
