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
