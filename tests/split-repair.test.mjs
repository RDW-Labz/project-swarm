// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ROOT_RULES,
  autoFix,
  buildRepairJobs,
  collectSplitIssues,
  detectMissingIntegrationIssues,
  detectSharedFileIssues,
  detectTestAfterCodeIssues,
  issueFingerprint,
  parkedBlockers,
  runRepairLoop,
} from '../tools/split-repair.mjs';
import { chainSharedFiles } from '../tools/wiring.mjs';

const SCOPE = [
  '# Scope: Repair loop',
  'Version: 1',
  '',
  '## Stages',
  '- S1: Core',
  '- S2: More',
  '',
  '## S1 Core',
  '### R-001 Module',
  'Acceptance:',
  '- Works.',
  '',
  '## S2 More',
  '### R-002 Other',
  'Acceptance:',
  '- Also works.',
  '',
].join('\n');

const repoFiles = ['src/base.mjs', 'src/module.mjs'];

function assignIds(items, start = 1) {
  let n = start;
  return items.map(item => {
    const id = `T-${String(n).padStart(4, '0')}`;
    n += 1;
    return { ...item, id, status: 'todo', dependsOn: [...(item.dependsOn ?? [])] };
  });
}

function validateTickets(tickets, { existing = [], repoFiles: repo = repoFiles, stage = 'S1' } = {}) {
  const issues = [];
  for (const t of tickets) {
    for (const c of t.context ?? []) {
      if (!repo.includes(c) && !tickets.some(other => (other.files ?? []).includes(c))) {
        issues.push({
          code: 'future-context',
          stage: t.stage ?? stage,
          ticket: t.id,
          path: c,
          reason: `context ${c} does not exist yet`,
          fixable: true,
        });
      }
    }
  }
  issues.push(...detectSharedFileIssues(tickets, existing));
  issues.push(...detectTestAfterCodeIssues(tickets, existing));
  const touched = [...new Set(tickets.filter(t => t.type === 'build' && !t.integration).flatMap(t => t.scopeRefs ?? []))];
  issues.push(...detectMissingIntegrationIssues([...existing, ...tickets], touched));
  const badIds = new Set(issues.map(i => i.ticket).filter(Boolean));
  const valid = tickets.filter(t => !badIds.has(t.id));
  return { tickets: valid, issues, stageIssues: [] };
}

test('ROOT_RULES lists five root split rules', () => {
  assert.equal(ROOT_RULES.length, 5);
  assert.match(ROOT_RULES[0], /exists in the repo now/);
  assert.match(ROOT_RULES[1], /same wave/);
  assert.match(ROOT_RULES[2], /test ticket/);
  assert.match(ROOT_RULES[3], /Protected files/);
  assert.match(ROOT_RULES[4], /integration ticket/);
});

test('shared-file same wave is fixed by autoFix with zero repair rounds', () => {
  const bad = assignIds([
    { key: 'a', type: 'build', stage: 'S1', scopeRefs: ['R-001'], files: ['src/shared.mjs'], acceptance: ['ok'], size: 'S' },
    { key: 'b', type: 'build', stage: 'S1', scopeRefs: ['R-001'], files: ['src/shared.mjs'], acceptance: ['ok'], size: 'S' },
  ]);
  const issues = detectSharedFileIssues(bad);
  const { tickets, fixed, remaining } = autoFix(bad, issues, { existing: [] });
  assert.ok(fixed.length);
  assert.equal(remaining.filter(i => i.code === 'shared-file-same-wave').length, 0);
  const later = tickets.find(t => t.id === 'T-0002');
  assert.deepEqual(later.dependsOn, ['T-0001']);

  let stageTickets = bad;
  const result = runRepairLoop({
    maxRepairs: 3,
    validate: () => {
      const issues = detectSharedFileIssues(stageTickets);
      const badIds = new Set(issues.map(i => i.ticket).filter(Boolean));
      return {
        tickets: stageTickets.filter(t => !badIds.has(t.id)),
        issues,
        stageIssues: [],
        allTickets: stageTickets,
        setTickets: next => { stageTickets = next; },
      };
    },
    rerun: () => { throw new Error('rerun should not run'); },
    log: () => {},
  });
  assert.equal(result.rounds, 0);
  assert.equal(result.parked.length, 0);
  assert.equal(result.tickets.length, 2);
});

test('future context: one repair round then valid', () => {
  const bad = assignIds([
    { key: 'build', type: 'build', stage: 'S1', scopeRefs: ['R-001'], files: ['src/module.mjs'], acceptance: ['ok'], size: 'S' },
    { key: 'test', type: 'test', stage: 'S1', scopeRefs: ['R-001'], files: ['tests/m.test.mjs'], context: ['src/orphan.mjs'], acceptance: ['ok'], size: 'S', dependsOn: ['build'] },
  ]);
  const fixed = assignIds([
    { key: 'build', type: 'build', stage: 'S1', scopeRefs: ['R-001'], files: ['src/module.mjs'], acceptance: ['ok'], size: 'S' },
    { key: 'test', type: 'test', stage: 'S1', scopeRefs: ['R-001'], files: ['tests/m.test.mjs'], context: ['src/module.mjs'], acceptance: ['ok'], size: 'S', dependsOn: ['build'] },
    { key: 'wire', type: 'build', stage: 'S1', scopeRefs: ['R-001'], integration: true, files: ['src/routes/m.mjs'], tests: ['tests/routes/m.test.mjs'], acceptance: ['ok'], size: 'S' },
  ]);
  fixed[1].dependsOn = ['T-0001'];

  let stageTickets = bad;
  let rerunCalls = 0;
  const result = runRepairLoop({
    maxRepairs: 3,
    validate: () => {
      const v = validateTickets(stageTickets, { repoFiles });
      return { ...v, allTickets: stageTickets, repoFiles, setTickets: next => { stageTickets = next; } };
    },
    rerun: () => {
      rerunCalls += 1;
      stageTickets = fixed;
    },
    log: () => {},
  });
  assert.equal(rerunCalls, 1);
  assert.equal(result.rounds, 1);
  assert.equal(result.parked.length, 0);
  assert.equal(result.tickets.length, 3);
});

test('test after code: repair loop moves stage in round 2', () => {
  const bad = assignIds([
    { key: 'build', type: 'build', stage: 'S1', scopeRefs: ['R-001'], files: ['src/module.mjs'], acceptance: ['ok'], size: 'S' },
    { key: 'test', type: 'test', stage: 'S2', scopeRefs: ['R-001'], files: ['tests/m.test.mjs'], context: ['src/module.mjs'], acceptance: ['ok'], size: 'S' },
  ]);
  const fixed = assignIds([
    { key: 'build', type: 'build', stage: 'S1', scopeRefs: ['R-001'], files: ['src/module.mjs'], acceptance: ['ok'], size: 'S' },
    { key: 'test', type: 'test', stage: 'S1', scopeRefs: ['R-001'], files: ['tests/m.test.mjs'], context: ['src/module.mjs'], acceptance: ['ok'], size: 'S', dependsOn: ['build'] },
    { key: 'wire', type: 'build', stage: 'S1', scopeRefs: ['R-001'], integration: true, files: ['src/routes/m.mjs'], tests: ['tests/routes/m.test.mjs'], acceptance: ['ok'], size: 'S' },
  ]);
  fixed[1].dependsOn = ['T-0001'];

  let stageTickets = bad;
  const result = runRepairLoop({
    maxRepairs: 3,
    validate: () => {
      const v = validateTickets(stageTickets, { repoFiles });
      return { ...v, allTickets: stageTickets, repoFiles, setTickets: next => { stageTickets = next; } };
    },
    rerun: () => { stageTickets = fixed; },
    log: () => {},
  });
  assert.equal(result.rounds, 1);
  assert.equal(result.tickets.find(t => t.type === 'test').stage, 'S1');
});

test('missing integration: second worker answer adds integration ticket', () => {
  const bad = assignIds([
    { key: 'mod', type: 'build', stage: 'S1', scopeRefs: ['R-001'], files: ['src/mod.mjs'], acceptance: ['ok'], size: 'S' },
  ]);
  const fixed = assignIds([
    { key: 'mod', type: 'build', stage: 'S1', scopeRefs: ['R-001'], files: ['src/mod.mjs'], acceptance: ['ok'], size: 'S' },
    { key: 'wire', type: 'build', stage: 'S1', scopeRefs: ['R-001'], integration: true, files: ['src/routes/mod.mjs'], tests: ['tests/routes/mod.test.mjs'], acceptance: ['route works'], size: 'S' },
  ]);

  let stageTickets = bad;
  const result = runRepairLoop({
    maxRepairs: 3,
    validate: () => {
      const v = validateTickets(stageTickets, { repoFiles });
      return { ...v, allTickets: stageTickets, repoFiles, setTickets: next => { stageTickets = next; } };
    },
    rerun: () => { stageTickets = fixed; },
    log: () => {},
  });
  assert.equal(result.rounds, 1);
  assert.equal(result.tickets.length, 2);
});

test('maxRepairs 0 parks immediately after autoFix', () => {
  const bad = assignIds([
    { key: 'mod', type: 'build', stage: 'S1', scopeRefs: ['R-001'], files: ['src/mod.mjs'], acceptance: ['ok'], size: 'S' },
  ]);
  let stageTickets = bad;
  const result = runRepairLoop({
    maxRepairs: 0,
    validate: () => {
      const v = validateTickets(stageTickets, { repoFiles });
      return { ...v, allTickets: stageTickets, repoFiles, setTickets: next => { stageTickets = next; } };
    },
    rerun: () => { throw new Error('no rerun'); },
    log: () => {},
  });
  assert.equal(result.rounds, 0);
  assert.ok(result.parked.length >= 1);
  assert.equal(result.tickets.length, 0);
});

test('exhausted maxRepairs parks bad tickets and keeps good ones', () => {
  const bad = assignIds([
    { key: 'good', type: 'build', stage: 'S1', scopeRefs: ['R-001'], files: ['src/ok.mjs'], acceptance: ['ok'], size: 'S' },
    {
      key: 'wire',
      type: 'build',
      stage: 'S1',
      scopeRefs: ['R-001'],
      integration: true,
      files: ['src/routes/ok.mjs'],
      tests: ['tests/ok.test.mjs'],
      acceptance: ['ok'],
      size: 'S',
    },
    { key: 'bad', type: 'build', stage: 'S1', scopeRefs: ['R-002'], files: ['src/wire.mjs'], acceptance: ['ok'], size: 'S' },
  ]);
  let stageTickets = bad;
  const result = runRepairLoop({
    maxRepairs: 1,
    validate: () => {
      const v = validateTickets(stageTickets, { repoFiles });
      return { ...v, allTickets: stageTickets, repoFiles, setTickets: next => { stageTickets = next; } };
    },
    rerun: () => { /* worker returns same bad answer */ },
    log: () => {},
  });
  assert.ok(result.parked.length >= 1);
  assert.ok(result.tickets.some(t => t.id === 'T-0001'));
});

test('worker that keeps returning the same bad answer stops after one no-progress round', () => {
  const bad = assignIds([
    { key: 'mod', type: 'build', stage: 'S1', scopeRefs: ['R-001'], files: ['src/mod.mjs'], acceptance: ['ok'], size: 'S' },
  ]);
  let stageTickets = bad;
  let reruns = 0;
  const result = runRepairLoop({
    maxRepairs: 5,
    validate: () => {
      const v = validateTickets(stageTickets, { repoFiles });
      return { ...v, allTickets: stageTickets, repoFiles, setTickets: next => { stageTickets = next; } };
    },
    rerun: () => { reruns += 1; },
    log: () => {},
  });
  assert.equal(reruns, 1);
  assert.ok(result.parked.length >= 1);
});

test('parkedBlockers emits journal blocker events with stable ids', () => {
  const parked = [{
    ticket: { id: 'T-0003', title: 'Broken', stage: 'S1' },
    stage: 'S1',
    issues: [{ code: 'missing-integration', reason: 'R-001: no integration ticket' }],
  }];
  const events = parkedBlockers(parked, { runId: 'run-42' });
  assert.equal(events[0].kind, 'blocker');
  assert.equal(events[0].id, 'split-park-S1-T-0003');
  assert.match(events[0].text, /T-0003/);
  assert.match(events[0].text, /stage S1/);
  assert.match(events[0].text, /no integration ticket/);
  assert.match(events[0].text, /swarm scope split --ingest run-42 --merge --max-repairs 3/);
  assert.equal(events[0].ticket, 'T-0003');
});

test('buildRepairJobs includes requirements, failures, issues, and output path', () => {
  const job = buildRepairJobs({
    scopeText: SCOPE,
    stage: 'S1',
    failedTickets: [{ key: 'x' }],
    issues: [{ code: 'path', ticket: 'T-0001', path: 'src/x.mjs', reason: 'missing' }],
    round: 0,
    outputPath: 'docs/scope/split/S1.json',
  });
  assert.equal(job.id, 'split-S1');
  assert.match(job.prompt, /R-001/);
  assert.match(job.prompt, /"key": "x"/);
  assert.match(job.prompt, /\[path\]/);
  assert.match(job.prompt, /docs\/scope\/split\/S1\.json/);
  for (const rule of ROOT_RULES) assert.ok(job.prompt.includes(rule.slice(0, 24)));
});

test('collectSplitIssues maps tree conflicts to shared-file issues', () => {
  const issues = collectSplitIssues({
    treeErrors: [{
      code: 'conflict',
      message: 'file ownership conflict',
      conflicts: [{ wave: 0, file: 'src/router.mjs', tickets: ['T-0001', 'T-0002'] }],
    }],
  });
  assert.ok(issues.some(i => i.code === 'shared-file-same-wave' && i.path === 'src/router.mjs'));
});

test('chainSharedFiles chains non-integration build tickets that share a file', () => {
  const added = assignIds([
    { type: 'build', stage: 'S1', scopeRefs: ['R-001'], files: ['src/x.mjs'], acceptance: ['a'], size: 'S' },
    { type: 'build', stage: 'S1', scopeRefs: ['R-001'], files: ['src/x.mjs'], acceptance: ['b'], size: 'S' },
  ]);
  chainSharedFiles(added, []);
  assert.deepEqual(added[1].dependsOn, ['T-0001']);
});
