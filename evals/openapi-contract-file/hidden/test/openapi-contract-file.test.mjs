import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const raw = readFileSync('contracts/api.json', 'utf8');
const doc = JSON.parse(raw);

function collectRefs(node, out) {
  if (Array.isArray(node)) {
    for (const x of node) collectRefs(x, out);
  } else if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      if (k === '$ref') out.push(v);
      else collectRefs(v, out);
    }
  }
  return out;
}

const schemas = (doc.components && doc.components.schemas) || {};
const vin = doc.paths && doc.paths['/api/vin'] ? doc.paths['/api/vin'].get : undefined;
const post = doc.paths && doc.paths['/api/requests'] ? doc.paths['/api/requests'].post : undefined;

test('file is one JSON document with no YAML or TypeScript text', () => {
  assert.ok(raw.trimStart().startsWith('{'));
  assert.ok(!raw.includes('\nopenapi:'));
  assert.ok(!raw.includes('interface '));
  assert.ok(!raw.includes('export '));
});

test('declares OpenAPI 3', () => {
  assert.ok(String(doc.openapi).startsWith('3.'));
});

test('exactly two operations with the right operationIds', () => {
  const methods = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'trace'];
  let count = 0;
  for (const item of Object.values(doc.paths || {})) {
    for (const m of methods) if (item[m]) count++;
  }
  assert.equal(count, 2);
  assert.ok(vin);
  assert.ok(post);
  assert.equal(vin.operationId, 'decodeVin');
  assert.equal(post.operationId, 'submitRequest');
});

test('decodeVin takes a required string query parameter vin', () => {
  const p = (vin.parameters || []).find((x) => x.name === 'vin' && x.in === 'query');
  assert.ok(p);
  assert.equal(p.required, true);
  assert.equal(p.schema.type, 'string');
});

test('operations reference the right schemas', () => {
  assert.equal(vin.responses['200'].content['application/json'].schema['$ref'], '#/components/schemas/VinResult');
  const reqRef = post.requestBody.content['application/json'].schema['$ref'];
  const resRef = post.responses['200'].content['application/json'].schema['$ref'];
  assert.equal(reqRef, '#/components/schemas/SubmitInput');
  assert.equal(resRef, '#/components/schemas/SubmitResult');
  assert.notEqual(resRef, reqRef);
});

test('every $ref is local and resolves inside components.schemas', () => {
  const refs = collectRefs(doc, []);
  assert.ok(refs.length >= 3);
  for (const r of refs) {
    assert.ok(r.startsWith('#/components/schemas/'), r);
    assert.ok(Object.prototype.hasOwnProperty.call(schemas, r.slice('#/components/schemas/'.length)), r);
  }
});

test('schema shapes and required lists', () => {
  const v = schemas.VinResult;
  assert.ok(v);
  assert.equal(v.properties.found.type, 'boolean');
  assert.ok(v.required.includes('found'));

  const s = schemas.SubmitInput;
  assert.ok(s);
  for (const f of ['vin', 'contactName', 'contactPhone']) {
    assert.equal(s.properties[f].type, 'string');
    assert.ok(s.required.includes(f));
  }

  const r = schemas.SubmitResult;
  assert.ok(r);
  assert.equal(r.properties.ok.type, 'boolean');
  assert.ok(r.required.includes('ok'));
  assert.equal(r.properties.requestNumber.type, 'integer');
  assert.equal(r.properties.requestNumber.minimum, 1);
  assert.ok(r.required.includes('requestNumber'));
});
