// SPDX-License-Identifier: Apache-2.0
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseScope, checkScope, requirementText, scopeHash, SCOPE_TEMPLATE } from '../tools/scope.mjs';

const SCOPE = [
'# Scope: Parts Request App',
'Version: 1',
'',
'## Overview',
'Users are field technicians. Out of scope: invoicing.',
'',
'## Stages',
'- S1: Foundations',
'- S2: Requests',
'',
'## S1 Foundations',
'### R-001 A signed-in user can create a parts request.',
'Acceptance:',
'- The form needs a part name and a quantity of at least 1.',
'- A saved request appears in the list within one second.',
'',
'## S2 Requests',
'### R-002 A paid request is charged through Stripe.',
'Acceptance:',
'- A test payment of 10 USD succeeds in Stripe test mode.',
'### R-003 A confirmation is sent through the email provider.',
'Acceptance:',
'- The email arrives within 60 seconds.',
'### R-004 Staff can view all open requests.',
'Acceptance:',
'- The list shows at most 50 rows per page.',
'',
'## External',
'- Stripe: payments',
'- Domain: parts.example.com',
'',
'## Sensitive',
'- payments',
'- customer data',
'',
'## Protected',
'- .env',
''].join('\n');

const mini = (...lines) => ['# Scope: Mini', 'Version: 1', '## Stages', '- S1: Foundations', '## S1 Foundations', ...lines].join('\n');
const findingsOf = (scope, code) => checkScope(scope).findings.filter(f => f.code === code);

test('parseScope reads name, version and stages', () => {
  const s = parseScope(SCOPE);
  assert.equal(s.name, 'Parts Request App');
  assert.equal(s.version, 1);
  assert.deepEqual(s.stages.map(x => x.id), ['S1', 'S2']);
  assert.deepEqual(s.stages[1], { id: 'S2', title: 'Requests', order: 2 });
});

test('version defaults to 1 and reads an explicit version', () => {
  assert.equal(parseScope(['# Scope: Plain', '## Stages', '- S1: A'].join('\n')).version, 1);
  assert.equal(parseScope(['# Scope: Plain', 'Version: 3', '## Stages', '- S1: A'].join('\n')).version, 3);
});

test('requirements carry stage, text, acceptance and line number', () => {
  const s = parseScope(SCOPE);
  const r = s.requirements.find(x => x.id === 'R-003');
  assert.equal(r.stage, 'S2');
  assert.equal(r.text, 'A confirmation is sent through the email provider.');
  assert.deepEqual(r.acceptance, ['The email arrives within 60 seconds.']);
  assert.equal(r.line, SCOPE.split('\n').indexOf('### R-003 A confirmation is sent through the email provider.') + 1);
});

test('external, sensitive and protected sections are parsed', () => {
  const s = parseScope(SCOPE);
  assert.deepEqual(s.external, [{ name: 'Stripe', note: 'payments' }, { name: 'Domain', note: 'parts.example.com' }]);
  assert.deepEqual(s.sensitive, ['payments', 'customer data']);
  assert.deepEqual(s.protected, ['.env']);
});

test('a stage heading missing from the stage list is added', () => {
  const s = parseScope(['# Scope: X', '## Stages', '- S1: A', '## S1 A', '### R-001 Do it.', 'Acceptance:', '- Check it.', '## S2 Extra', '### R-002 Do more.', 'Acceptance:', '- Check more.'].join('\n'));
  assert.deepEqual(s.stages, [{ id: 'S1', title: 'A', order: 1 }, { id: 'S2', title: 'Extra', order: 2 }]);
  assert.deepEqual(s.errors, []);
});

test('checkScope is ok with no findings on a clean scope', () => {
  const r = checkScope(parseScope(SCOPE));
  assert.equal(r.ok, true);
  assert.deepEqual(r.findings, []);
});

test('a dash line under a stage heading gives a missing-id warning', () => {
  const r = checkScope(parseScope(mini('- loose note', '### R-001 Do it.', 'Acceptance:', '- Check it.')));
  const f = r.findings.filter(x => x.code === 'missing-id');
  assert.equal(f.length, 1);
  assert.equal(f[0].level, 'warn');
  assert.equal(r.ok, true);
});

test('a malformed requirement ID is a bad-id error', () => {
  const r = checkScope(parseScope(mini('### R-1 Do it.', 'Acceptance:', '- Check it.')));
  assert.equal(r.ok, false);
  assert.equal(findingsOf(parseScope(mini('### R-1 Do it.', 'Acceptance:', '- Check it.')), 'bad-id')[0].level, 'error');
});

test('a repeated requirement ID is a duplicate-id error', () => {
  const s = parseScope(mini('### R-001 Do it.', 'Acceptance:', '- Check it.', '### R-001 Do it again.', 'Acceptance:', '- Check again.'));
  const f = findingsOf(s, 'duplicate-id');
  assert.equal(f.length, 1);
  assert.equal(f[0].id, 'R-001');
  assert.equal(f[0].level, 'error');
});

test('a requirement without acceptance lines is a missing-acceptance error', () => {
  const s = parseScope(mini('### R-001 Do it.'));
  const f = findingsOf(s, 'missing-acceptance');
  assert.equal(f.length, 1);
  assert.equal(f[0].id, 'R-001');
  assert.equal(checkScope(s).ok, false);
});

test('vague wording without a digit gives an untestable-wording warning', () => {
  const s = parseScope(mini('### R-001 The app is fast.', 'Acceptance:', '- Check it.'));
  const f = findingsOf(s, 'untestable-wording');
  assert.equal(f.length, 1);
  assert.equal(f[0].level, 'warn');
  assert.match(f[0].message, /fast/);
  assert.equal(checkScope(s).ok, true);
});

test('vague wording on a line with a digit is not flagged', () => {
  const s = parseScope(mini('### R-001 The app is fast under 2 seconds.', 'Acceptance:', '- Responds in 200 ms.'));
  assert.deepEqual(findingsOf(s, 'untestable-wording'), []);
});

test('stage ids out of order give a bad-stage-order error', () => {
  const scope = { name: 'X', version: 1, stages: [{ id: 'S1', title: '', order: 1 }, { id: 'S3', title: '', order: 2 }], requirements: [{ id: 'R-001', stage: 'S1', text: 'Do 1.', acceptance: ['Check 1.'], line: 1 }], external: [], sensitive: [], protected: [], errors: [] };
  const f = findingsOf(scope, 'bad-stage-order');
  assert.equal(f.length, 1);
  assert.equal(f[0].id, 'S3');
  assert.equal(f[0].level, 'error');
});

test('a requirement under an unlisted stage gives an unknown-stage error', () => {
  const scope = { name: 'X', version: 1, stages: [{ id: 'S1', title: '', order: 1 }], requirements: [{ id: 'R-001', stage: 'S9', text: 'Do 1.', acceptance: ['Check 1.'], line: 1 }], external: [], sensitive: [], protected: [], errors: [] };
  const f = findingsOf(scope, 'unknown-stage');
  assert.equal(f.length, 1);
  assert.equal(f[0].id, 'R-001');
});

test('a scope with no requirements gives a no-requirements error', () => {
  const r = checkScope(parseScope(['# Scope: Empty', '## Stages', '- S1: A'].join('\n')));
  assert.equal(r.ok, false);
  assert.ok(r.findings.some(f => f.code === 'no-requirements' && f.level === 'error'));
});

test('parse errors surface as parse errors', () => {
  const s = parseScope(['## Stages', '- bogus'].join('\n'));
  assert.ok(s.errors.length > 0);
  const r = checkScope(s);
  assert.equal(r.ok, false);
  assert.ok(r.findings.some(f => f.code === 'parse' && f.level === 'error'));
});

test('requirementText returns text and acceptance, or null for unknown IDs', () => {
  assert.deepEqual(requirementText(parseScope(SCOPE), 'R-002'), { text: 'A paid request is charged through Stripe.', acceptance: ['A test payment of 10 USD succeeds in Stripe test mode.'] });
  assert.equal(requirementText(parseScope(SCOPE), 'R-999'), null);
});

test('scopeHash ignores CRLF and trailing spaces but not content', () => {
  const crlf = SCOPE.replace(/\n/g, '\r\n');
  const spaced = SCOPE.split('\n').map(l => l + '   ').join('\n');
  assert.equal(scopeHash(SCOPE), scopeHash(crlf));
  assert.equal(scopeHash(SCOPE), scopeHash(spaced));
  assert.match(scopeHash(SCOPE), /^[0-9a-f]{64}$/);
  assert.notEqual(scopeHash(SCOPE), scopeHash(SCOPE + 'x'));
});

test('SCOPE_TEMPLATE parses without errors', () => {
  const s = parseScope(SCOPE_TEMPLATE);
  assert.deepEqual(s.errors, []);
  assert.equal(s.requirements.length, 1);
  assert.equal(checkScope(s).findings.filter(f => f.code === 'parse').length, 0);
});
