// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyChangeOrder } from '../tools/change-order-class.mjs';

const base = `## Scope

### R-001 User can sign in.
Files: src/auth/login.ts
Acceptance:
- POST /login returns 200

### R-002 User can view dashboard.
Files: src/ui/dashboard.tsx
`;

test('rename-only: single path rename in one requirement', () => {
  const next = base.replace('src/auth/login.ts', 'src/auth/sign-in.ts');
  const c = classifyChangeOrder(base, next);
  assert.equal(c.renameOnly, true);
  assert.equal(c.addedRequirements.length, 0);
  assert.equal(c.removedRequirements.length, 0);
  assert.deepEqual(c.changedRequirements, ['R-001']);
  assert.deepEqual(c.renames, [{ from: 'src/auth/login.ts', to: 'src/auth/sign-in.ts' }]);
});

test('not rename-only: added requirement', () => {
  const next = `${base}\n### R-003 New capability.\nFiles: src/new.ts\n`;
  const c = classifyChangeOrder(base, next);
  assert.equal(c.renameOnly, false);
  assert.ok(c.addedRequirements.includes('R-003'));
});

test('not rename-only: reworded sentence', () => {
  const next = base.replace('User can sign in.', 'User can authenticate.');
  const c = classifyChangeOrder(base, next);
  assert.equal(c.renameOnly, false);
  assert.match(c.reasons.join(' '), /non-path wording/i);
});

test('not rename-only: path depth change with extra words', () => {
  const next = base.replace('Files: src/auth/login.ts', 'Files: src/login.ts for auth');
  const c = classifyChangeOrder(base, next);
  assert.equal(c.renameOnly, false);
});

test('not rename-only: six renames', () => {
  const extra = ['src/r1.ts', 'src/r2.ts', 'src/r3.ts', 'src/r4.ts', 'src/r5.ts', 'src/r6.ts'];
  const oldScope = `${base}${extra.map((f, i) => `\n### R-10${i}\nFiles: ${f}\n`).join('')}`;
  const newScope = oldScope.replace(/src\/r(\d)\.ts/g, (_, d) => `src/renamed/r${d}.ts`);
  const c = classifyChangeOrder(oldScope, newScope);
  assert.equal(c.renameOnly, false);
  assert.ok(c.renames.length > 5);
});
