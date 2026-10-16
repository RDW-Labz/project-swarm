// SPDX-License-Identifier: Apache-2.0
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { editDistance, newDependencies, checkPackage, checkPackages } from '../tools/security-deps.mjs';

const NOW = Date.parse('2025-01-01T00:00:00Z');
const DAY = 864e5;
const ago = d => new Date(NOW - d * DAY).toISOString();
const reply = (status, body) => ({ ok: status >= 200 && status < 300, status, async json() { return body; } });
function npmFake({ days, downloads, license = 'MIT' }) {
  return async url => url.includes('api.npmjs.org')
    ? reply(200, { downloads })
    : reply(200, { time: { created: ago(days) }, 'dist-tags': { latest: '1.0.0' }, versions: { '1.0.0': { license } } });
}
const npm = name => ({ name, ecosystem: 'npm', dev: false });

test('editDistance basics', () => {
  assert.equal(editDistance('kitten', 'sitting'), 3);
  assert.equal(editDistance('abc', 'abc'), 0);
  assert.equal(editDistance('', 'ab'), 2);
});

test('newDependencies npm adds with dev and optional flags', () => {
  const before = { 'package.json': JSON.stringify({ dependencies: { a: '1' } }) };
  const after = { 'package.json': JSON.stringify({ dependencies: { a: '1', b: '2' }, devDependencies: { c: '3' }, optionalDependencies: { d: '4' } }) };
  const got = newDependencies({ before, after }).map(d => ({ name: d.name, ecosystem: d.ecosystem, dev: d.dev })).sort((x, y) => x.name.localeCompare(y.name));
  assert.deepEqual(got, [
    { name: 'b', ecosystem: 'npm', dev: false },
    { name: 'c', ecosystem: 'npm', dev: true },
    { name: 'd', ecosystem: 'npm', dev: false },
  ]);
});

test('newDependencies skips unchanged and removed packages', () => {
  const before = { 'package.json': JSON.stringify({ dependencies: { a: '1', x: '1' } }) };
  const after = { 'package.json': JSON.stringify({ dependencies: { a: '2' } }) };
  assert.deepEqual(newDependencies({ before, after }), []);
});

test('newDependencies treats invalid JSON as no dependencies', () => {
  const after = { 'package.json': JSON.stringify({ dependencies: { a: '1' } }) };
  const got = newDependencies({ before: { 'package.json': '{bad' }, after });
  assert.deepEqual(got.map(d => d.name), ['a']);
});

test('newDependencies flags invalid npm names', () => {
  const after = { 'package.json': JSON.stringify({ dependencies: { 'Bad Name!': '1' } }) };
  const [d] = newDependencies({ before: {}, after });
  assert.equal(d.invalid, true);
});

test('newDependencies reads new pypi requirements', () => {
  const before = { 'requirements.txt': 'requests==2.0' };
  const after = { 'requirements.txt': 'requests==2.0\nflask>=2\n# comment\n-r other.txt\ngit+https://x/y.git\nDjango[argon2]==4\n' };
  const got = newDependencies({ before, after });
  assert.deepEqual(got.map(d => d.name), ['flask', 'django']);
  assert.ok(got.every(d => d.ecosystem === 'pypi'));
});

test('npm 404 is reported as not found', async () => {
  const r = await checkPackage(npm('nope-x'), { fetchImpl: async () => reply(404, {}), now: () => NOW });
  assert.equal(r.ok, false);
  assert.match(r.reasons[0], /not found/);
});

test('npm old package with downloads passes and reports age and license', async () => {
  const r = await checkPackage(npm('acme-widget'), { fetchImpl: npmFake({ days: 400, downloads: 5000 }), now: () => NOW });
  assert.equal(r.ok, true);
  assert.equal(r.ageDays, 400);
  assert.equal(r.license, 'MIT');
});

test('young npm package is rejected', async () => {
  const r = await checkPackage(npm('acme-widget'), { fetchImpl: npmFake({ days: 3, downloads: 5000 }), now: () => NOW });
  assert.equal(r.ok, false);
  assert.ok(r.reasons.includes('younger than 30 days'));
});

test('npm package with few downloads is rejected', async () => {
  const r = await checkPackage(npm('acme-widget'), { fetchImpl: npmFake({ days: 400, downloads: 7 }), now: () => NOW });
  assert.equal(r.ok, false);
  assert.ok(r.reasons.some(x => x.includes('downloads')));
});

test('npm license given as object is read', async () => {
  const r = await checkPackage(npm('acme-widget'), { fetchImpl: npmFake({ days: 400, downloads: 5000, license: { type: 'ISC' } }), now: () => NOW });
  assert.equal(r.license, 'ISC');
});

test('npm name one edit from a popular package is flagged, the popular name is not', async () => {
  const typo = await checkPackage(npm('lodashs'), { fetchImpl: npmFake({ days: 20, downloads: 5000 }), now: () => NOW });
  assert.ok(typo.reasons.includes('looks like the popular package lodash'));
  const real = await checkPackage(npm('lodash'), { fetchImpl: npmFake({ days: 2000, downloads: 5000 }), now: () => NOW });
  assert.equal(real.ok, true);
});

test('thrown fetch and 500 answer both give could not verify', async () => {
  const thrown = await checkPackage(npm('acme-widget'), { fetchImpl: async () => { throw new Error('down'); }, now: () => NOW });
  assert.equal(thrown.ok, false);
  assert.ok(thrown.reasons[0].includes('could not verify'));
  const e500 = await checkPackage(npm('acme-widget'), { fetchImpl: async () => reply(500, {}), now: () => NOW });
  assert.equal(e500.ok, false);
  assert.ok(e500.reasons[0].includes('could not verify'));
});

test('invalid dependency gets the invalid name reason', async () => {
  const r = await checkPackage({ name: 'Bad Name!', ecosystem: 'npm', dev: false, invalid: true }, { fetchImpl: npmFake({ days: 400, downloads: 5000 }), now: () => NOW });
  assert.ok(r.reasons.includes('not a valid package name'));
});

test('scoped npm names are requested with %2f', async () => {
  const urls = [];
  const fetchImpl = async u => { urls.push(u); return npmFake({ days: 400, downloads: 5000 })(u); };
  await checkPackage(npm('@scope/pkg'), { fetchImpl, now: () => NOW });
  assert.ok(urls[0].endsWith('/@scope%2fpkg'));
});

test('pypi 404 is reported as not found', async () => {
  const r = await checkPackage({ name: 'nope', ecosystem: 'pypi', dev: false }, { fetchImpl: async () => reply(404, {}), now: () => NOW });
  assert.equal(r.ok, false);
  assert.match(r.reasons[0], /not found/);
});

test('pypi age comes from earliest upload and license from info', async () => {
  const body = { info: { license: 'MIT', classifiers: [] }, releases: { '1.0': [{ upload_time: '2024-12-01T00:00:00' }], '0.9': [{ upload_time: '2024-06-01T00:00:00' }] } };
  const r = await checkPackage({ name: 'flask', ecosystem: 'pypi', dev: false }, { fetchImpl: async () => reply(200, body), now: () => NOW });
  assert.equal(r.ageDays, Math.floor((NOW - Date.parse('2024-06-01T00:00:00Z')) / DAY));
  assert.equal(r.license, 'MIT');
});

test('pypi license falls back to classifiers', async () => {
  const body = { info: { license: '', classifiers: ['License :: OSI Approved :: MIT License'] }, releases: {} };
  const r = await checkPackage({ name: 'flask', ecosystem: 'pypi', dev: false }, { fetchImpl: async () => reply(200, body), now: () => NOW });
  assert.equal(r.license, 'MIT License');
});

test('checkPackages keeps input order and caps concurrency at 4', async () => {
  let inFlight = 0, max = 0;
  const fetchImpl = async () => {
    inFlight++;
    max = Math.max(max, inFlight);
    await new Promise(res => setTimeout(res, 5));
    inFlight--;
    return reply(404, {});
  };
  const names = Array.from({ length: 12 }, (_, i) => 'pkg' + i);
  const deps = names.map(name => ({ name, ecosystem: 'pypi', dev: false }));
  const out = await checkPackages(deps, { fetchImpl, now: () => NOW });
  assert.deepEqual(out.map(r => r.name), names);
  assert.ok(max <= 4);
  assert.ok(max > 1);
});
