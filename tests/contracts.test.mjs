import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { validateOpenApi, contractFiles } from '../tools/contracts.mjs';

const DOC = {
  openapi: '3.0.0', info: { title: 'Parts', version: '1' },
  paths: {
    '/requests': {
      get: { operationId: 'listRequests', responses: { 200: { description: 'ok', content: { 'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/Request' } } } } } } },
      post: { operationId: 'createRequest', requestBody: { content: { 'application/json': { schema: { $ref: '#/components/schemas/NewRequest' } } } }, responses: { 201: { description: 'created', content: { 'application/json': { schema: { $ref: '#/components/schemas/Request' } } } } } },
    },
    '/requests/{id}': { get: { operationId: 'getRequest', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { 200: { description: 'ok', content: { 'application/json': { schema: { $ref: '#/components/schemas/Request' } } } } } } },
  },
  components: { schemas: {
    Request: { type: 'object', required: ['id', 'part', 'quantity'], properties: { id: { type: 'string', format: 'uuid' }, part: { type: 'string', minLength: 1 }, quantity: { type: 'integer', minimum: 1 } } },
    NewRequest: { type: 'object', required: ['part', 'quantity'], properties: { part: { type: 'string', minLength: 1 }, quantity: { type: 'integer', minimum: 1 } } },
  } },
};

async function generated() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'contracts-'));
  for (const [name, body] of Object.entries(contractFiles(DOC))) {
    await fs.mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await fs.writeFile(path.join(root, name), body);
  }
  return root;
}
const runNode = (args, env, cwd) => new Promise(resolve => {
  const childEnv = { ...process.env, ...env };
  delete childEnv.NODE_TEST_CONTEXT;
  const child = spawn(process.execPath, args, { cwd, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  child.stdout.on('data', d => { stdout += d; });
  child.on('close', code => resolve({ code, stdout }));
});

test('validateOpenApi accepts the sample and rejects a missing operationId', () => {
  assert.equal(validateOpenApi(DOC).ok, true);
  const bad = structuredClone(DOC);
  delete bad.paths['/requests'].get.operationId;
  assert.equal(validateOpenApi(bad).ok, false);
});

test('generated mock server answers list, create, bad body, get and missing', async () => {
  const root = await generated();
  const { createMockServer } = await import(pathToFileURL(path.join(root, 'contracts/mock-server.mjs')).href);
  const { validateRequest } = await import(pathToFileURL(path.join(root, 'contracts/validators.mjs')).href);
  const mock = await createMockServer({ port: 0 });
  try {
    const list = await fetch(`${mock.url}/requests`);
    const rows = await list.json();
    assert.equal(list.status, 200);
    assert.ok(rows.length > 0);
    assert.equal(validateRequest(rows[0]).ok, true);
    const created = await fetch(`${mock.url}/requests`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ part: 'bolt', quantity: 3 }) });
    assert.equal(created.status, 201);
    const bad = await fetch(`${mock.url}/requests`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ part: '', quantity: 0 }) });
    assert.equal(bad.status, 400);
    assert.equal((await fetch(`${mock.url}/requests/${rows[0].id}`)).status, 200);
    assert.equal((await fetch(`${mock.url}/requests/missing`)).status, 404);
  } finally {
    await mock.close();
  }
});

test('generated contract tests pass against the mock and skip without a base url', async () => {
  const root = await generated();
  const { createMockServer } = await import(pathToFileURL(path.join(root, 'contracts/mock-server.mjs')).href);
  const skipped = await runNode(['--test', 'contracts/contract.test.mjs'], { CONTRACT_BASE_URL: '' }, root);
  assert.equal(skipped.code, 0);
  assert.match(skipped.stdout, /# skipped [1-9]/);
  const mock = await createMockServer({ port: 0 });
  try {
    const run = await runNode(['--test', 'contracts/contract.test.mjs'], { CONTRACT_BASE_URL: mock.url }, root);
    assert.equal(run.code, 0, run.stdout);
    assert.match(run.stdout, /# fail 0/);
  } finally {
    await mock.close();
  }
});

test('hostile OpenAPI names, refs and paths are rejected before any code is generated', () => {
  const withSchema = name => ({ ...DOC, components: { schemas: { ...DOC.components.schemas, [name]: { type: 'string' } } } });
  assert.equal(validateOpenApi(withSchema("X=1;import('node:child_process');export const Y")).ok, false);
  assert.equal(validateOpenApi(withSchema('bad-name')).ok, false);
  const badOp = structuredClone(DOC);
  badOp.paths['/requests'].get.operationId = 'list-requests; evil()';
  assert.equal(validateOpenApi(badOp).ok, false);
  const adjacent = structuredClone(DOC);
  adjacent.paths['/a/{x}{y}'] = adjacent.paths['/requests/{id}'];
  assert.equal(validateOpenApi(adjacent).ok, false);
  const proto = structuredClone(DOC);
  proto.paths['/requests'].get.responses[200].content['application/json'].schema = { $ref: '#/components/schemas/constructor' };
  assert.equal(validateOpenApi(proto).ok, false);
  const badEnum = structuredClone(DOC);
  badEnum.components.schemas.Request.properties.part = { type: 'string', enum: 'abc' };
  assert.equal(validateOpenApi(badEnum).ok, false);
});
