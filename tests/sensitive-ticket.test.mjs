// SPDX-License-Identifier: Apache-2.0
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseScope } from '../tools/scope.mjs';
import {
  SENSITIVE_TICKET_TOPICS,
  filteredSensitiveScope,
  isSensitiveScopeEntry,
  isSensitiveTicket,
  isSensitiveTicketText,
  sensitiveTopicsInText,
} from '../tools/sensitive-ticket.mjs';

const atlasScope = parseScope([
  '# Scope: Atlas',
  'Version: 1',
  '',
  '## Overview',
  'Store wrapper.',
  '',
  '## Stages',
  '- S1: Core',
  '',
  '## S1 Core',
  '### R-001 List items.',
  'Acceptance:',
  '- Returns rows.',
  '',
  '## Sensitive',
  '- atlas store-wrapper',
  '- payments',
  '',
  '## Protected',
  '- .env',
].join('\n'));

test('AC1: tickets are tagged sensitive only for auth, database, payments, secrets and public routes', () => {
  assert.deepEqual(SENSITIVE_TICKET_TOPICS, ['auth', 'database', 'payments', 'secrets', 'public-routes']);
  assert.equal(isSensitiveTicketText(null, 'Stripe checkout flow'), true);
  assert.equal(isSensitiveTicketText(null, 'Add OAuth sign-in'), true);
  assert.equal(isSensitiveTicketText(null, 'supabase migration for users'), true);
  assert.equal(isSensitiveTicketText(null, 'Load API keys from keychain'), true);
  assert.equal(isSensitiveTicketText(null, 'Expose unauthenticated route for health'), true);
  assert.equal(isSensitiveTicketText(null, 'Rotate refresh tokens on sign-out'), true);
  assert.equal(isSensitiveTicketText(null, 'Set HttpOnly cookie flags'), true);
  assert.equal(isSensitiveTicketText(null, 'Validate CSRF on POST'), true);
  assert.equal(isSensitiveTicketText(null, 'Assign admin role to service account'), true);
  assert.equal(isSensitiveTicketText(null, 'Add RLS policy on orders table'), true);
  assert.equal(isSensitiveTicketText(null, 'Enable row-level security for tenants'), true);
  assert.equal(isSensitiveTicketText(null, 'Format CSV export columns'), false);
  assert.equal(isSensitiveTicketText(null, 'customer data retention policy'), false);
});

test('AC2: a scope like atlas store-wrapper no longer tags every ticket sensitive', () => {
  assert.equal(isSensitiveScopeEntry('atlas store-wrapper'), false);
  assert.deepEqual(filteredSensitiveScope(atlasScope), ['payments']);
  const reqs = new Map(atlasScope.requirements.map((r) => [r.id, r]));
  const plain = {
    id: 'T-0001',
    title: 'List endpoint',
    scopeRefs: ['R-001'],
    acceptance: ['Returns rows'],
    files: ['src/list.mjs'],
    sensitive: false,
  };
  assert.equal(isSensitiveTicket(plain, atlasScope, reqs), false);
  assert.equal(
    isSensitiveTicket(
      { ...plain, title: 'Atlas branding on list page', acceptance: ['Shows atlas logo'] },
      atlasScope,
      reqs,
    ),
    false,
  );
  assert.equal(
    isSensitiveTicket(
      { ...plain, acceptance: ['Stripe payments webhook returns 200'] },
      atlasScope,
      reqs,
    ),
    true,
  );
});

test('scope sensitive entries outside the five topics are ignored for phrase match', () => {
  const scope = parseScope([
    '# Scope: X',
    'Version: 1',
    '',
    '## Overview',
    'x',
    '',
    '## Stages',
    '- S1: A',
    '',
    '## S1 A',
    '### R-001 Do.',
    'Acceptance:',
    '- Check.',
    '',
    '## Sensitive',
    '- customer data',
    '',
    '## Protected',
    '- .env',
  ].join('\n'));
  assert.equal(isSensitiveScopeEntry('customer data'), false);
  assert.deepEqual(filteredSensitiveScope(scope), []);
  assert.equal(isSensitiveTicketText(scope, 'Stores customer data fields'), false);
});

test('explicit sensitive true on a ticket is kept', () => {
  const reqs = new Map(atlasScope.requirements.map((r) => [r.id, r]));
  assert.equal(
    isSensitiveTicket({ id: 'T-0002', title: 'Docs', sensitive: true, scopeRefs: [], acceptance: [], files: [] }, atlasScope, reqs),
    true,
  );
});

test('sensitiveTopicsInText is empty for non-string input', () => {
  assert.equal(sensitiveTopicsInText(null).size, 0);
  assert.equal(sensitiveTopicsInText('').size, 0);
});

test('AC1: ticket topics are detected without a scope across all ticket context', () => {
  const cases = [
    { title: 'Add authentication' },
    { acceptance: ['Validate payments'] },
    { files: ['src/database.mjs'] },
    { epic: 'Rotate secrets' },
    { title: 'Expose public routes' },
    { scopeRefs: ['R-001'] },
  ];
  const reqs = new Map([['R-001', { text: 'Authentication', acceptance: [] }]]);
  for (const ticket of cases) {
    for (const scope of [undefined, null, {}]) {
      assert.equal(isSensitiveTicket(ticket, scope, reqs), true, JSON.stringify(ticket));
    }
  }
  assert.equal(isSensitiveTicket({ title: 'Adjust list spacing' }), false);
});

test('AC1: environment files are secrets at filename boundaries', () => {
  for (const file of ['.env', '.env.local', '.env.production', 'config/.env', '.env.example']) {
    assert.deepEqual([...sensitiveTopicsInText(file)], ['secrets'], file);
    assert.equal(isSensitiveTicket({ files: [file] }), true, file);
  }
  for (const text of ['environment', 'config.env', '.envelope']) {
    assert.equal(isSensitiveTicketText(null, text), false, text);
  }
});

test('AC2: sensitive scope phrases do not spread risk through unrelated words', () => {
  const scope = { sensitive: ['atlas store-wrapper payments', 'database list items', 'auth branding'] };
  for (const title of ['Atlas store-wrapper', 'List items', 'Refresh branding']) {
    assert.equal(isSensitiveTicket({ title }, scope), false, title);
  }
  for (const title of ['Atlas payments', 'List database items', 'Auth branding']) {
    assert.equal(isSensitiveTicket({ title }, scope), true, title);
  }
});

test('AC1: public routes topic supports category labels and endpoint plurals', () => {
  for (const title of ['public-routes', 'Public endpoints', 'Anonymous routes']) {
    assert.deepEqual([...sensitiveTopicsInText(title)], ['public-routes'], title);
  }
});
