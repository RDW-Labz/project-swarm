// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const contractUrl = new URL('../contracts/watch-s4-ops.json', import.meta.url);
const contract = JSON.parse(await readFile(contractUrl, 'utf8'));

const ownerPaths = [
  '/api/owner/actions/{itemId}/prepare',
  '/api/owner/actions/{itemId}/decision',
  '/api/owner/audit',
];

test('watch S4 contract is OpenAPI 3.1', () => {
  assert.equal(contract.openapi, '3.1.0');
  assert.equal(typeof contract.info?.title, 'string');
  assert.ok(contract.paths && typeof contract.paths === 'object');
});

test('every owner route requires board token header and tailnet sign-in only', () => {
  for (const path of ownerPaths) {
    const operations = Object.values(contract.paths[path] ?? {});
    assert.ok(operations.length > 0, `${path} must be declared`);
    for (const operation of operations) {
      const security = operation.security;
      assert.ok(Array.isArray(security) && security.length === 1, `${path} must declare exactly one security requirement`);
      const requirement = security[0];
      assert.deepEqual(
        Object.keys(requirement).sort(),
        ['boardTokenHeader', 'tailnetSignIn'],
        `${path} must require boardTokenHeader and tailnetSignIn together`,
      );
      assert.ok(!Object.hasOwn(requirement, 'boardTokenQuery'), `${path} must not accept boardTokenQuery`);
    }
  }
});

test('deprecated query token is legacy and header is primary on every read route', () => {
  const queryScheme = contract.components?.securitySchemes?.boardTokenQuery;
  assert.equal(queryScheme?.deprecated, true);
  assert.match(queryScheme?.description ?? '', /initial HTML page load/i);
  assert.match(queryScheme?.description ?? '', /HttpOnly cookie/i);
  assert.match(queryScheme?.description ?? '', /x-watch-token header/i);
  assert.match(JSON.stringify(contract['x-security-notes'] ?? []), /T-8006/);

  for (const [path, item] of Object.entries(contract.paths ?? {})) {
    if (!item.get) continue;
    const security = item.get.security;
    assert.ok(Array.isArray(security) && security.length > 0, `${path} must declare read security`);
    assert.equal(Object.keys(security[0])[0], 'boardTokenHeader', `${path} must list boardTokenHeader first`);
  }
});

test('refusedKinds contains every server-side refused action kind', () => {
  assert.deepEqual(contract.components?.schemas?.refusedKinds?.enum, [
    'merge',
    'deploy',
    'cap-raise',
    'spend',
    'key',
    'migration',
  ]);
});

test('every x-tickets route is present in the contract', () => {
  for (const route of Object.keys(contract['x-tickets'] ?? {})) {
    const match = route.match(/^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS) (.+)$/);
    assert.ok(match, `x-tickets key must start with an HTTP method: ${route}`);
    assert.ok(contract.paths[match[2]], `x-tickets route is missing from paths: ${route}`);
    assert.ok(Array.isArray(contract['x-tickets'][route]) && contract['x-tickets'][route].length > 0, `${route} must name a ticket`);
  }
});

test('S4 read and owner response shapes are represented', () => {
  const schemas = contract.components.schemas;
  for (const name of ['Money', 'IdleLaneReason', 'SplitQuality', 'Federation', 'AuditEntry']) {
    assert.ok(schemas[name], `missing S4 schema ${name}`);
  }
  for (const field of ['billedUsd', 'listUsd', 'capBasis', 'capUsedUsd']) {
    assert.ok(Object.hasOwn(schemas.Money.properties, field), `missing money field ${field}`);
  }
  assert.ok(Object.hasOwn(schemas.Machine.properties, 'laneIdle'));
  assert.ok(Object.hasOwn(schemas.ProjectDetail.properties, 'splitQuality'));
  assert.deepEqual(Object.keys(schemas.Federation.properties).sort(), ['drift', 'machines', 'peers']);
  assert.equal(contract.paths['/api/board'].get.parameters[0].$ref, '#/components/parameters/LocalOnly');
});
