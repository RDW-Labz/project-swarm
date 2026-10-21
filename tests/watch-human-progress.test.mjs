// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPlanSnapshot } from '../tools/watch-plan.mjs';

const NOW = Date.parse('2026-10-21T12:00:00.000Z');
const tk = (id, over = {}) => ({
  id,
  title: `Ticket ${id}`,
  type: 'build',
  stage: 'S1',
  scopeRefs: ['R-001'],
  acceptance: ['ok'],
  files: ['src/a.mjs'],
  dependsOn: [],
  size: 'S',
  risk: 'low',
  status: 'todo',
  ...over,
});

test('ledgerSummary-shaped plan excludes human tickets from build percent and lists checklists', () => {
  const tickets = [
    tk('T-1', { status: 'done' }),
    tk('T-2', { status: 'todo' }),
    tk('H-1', { type: 'human', scopeRefs: [], acceptance: [], steps: ['Step A', 'Step B'], status: 'todo' }),
    tk('H-2', { type: 'human', scopeRefs: [], acceptance: [], steps: ['Done step'], status: 'done' }),
  ];
  const snap = buildPlanSnapshot({ tickets }, { now: NOW });
  assert.equal(snap.header.percentDone, 50);
  assert.equal(snap.header.buildTotal, 2);
  assert.equal(snap.humanChecklists.length, 2);
  assert.deepEqual(snap.humanChecklists.find((h) => h.id === 'H-1')?.steps, ['Step A', 'Step B']);
  assert.equal(snap.dependencies.blocked.length, 0);
});

test('open human dependency does not block plan dependency graph', () => {
  const tickets = [
    tk('T-1', { status: 'done' }),
    tk('T-2', { dependsOn: ['H-1'], status: 'todo' }),
    tk('H-1', { type: 'human', scopeRefs: [], acceptance: [], steps: ['Go'], status: 'todo' }),
  ];
  const snap = buildPlanSnapshot({ tickets }, { now: NOW });
  assert.deepEqual(snap.dependencies.blocked, []);
});

test('plan-views checklist renderer avoids innerHTML in the human checklist path', () => {
  const assetPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '../tools/watch-assets/plan-views.js');
  const src = fs.readFileSync(assetPath, 'utf8');
  const start = src.indexOf('function renderHumanChecklists');
  assert.ok(start > 0, 'renderHumanChecklists missing');
  const end = src.indexOf('function renderChanges', start);
  const block = src.slice(start, end);
  assert.ok(!block.includes('innerHTML'), 'human checklist path must not use innerHTML');
  assert.ok(block.includes('Your checklist'));
  assert.ok(block.includes('excludes human tickets'));
});
