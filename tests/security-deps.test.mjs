// SPDX-License-Identifier: Apache-2.0
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { editDistance, newDependencies, checkPackage, checkPackages, classifySpec } from '../tools/security-deps.mjs';
import { licenseBlocked } from '../tools/security-scan.mjs';

const NOW = Date.parse('2025-01-01T00:00:00Z');
const DAY = 864e5;
const ago = d => new Date(NOW - d * DAY).toISOString();
const reply = (status, body) => ({ ok: status >= 200 && status < 300, status, async json() { return body; } });
function npmFake({ days, downloads, license = 'MIT' }) {
  return async url => new URL(url).hostname === 'api.npmjs.org'
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
  const after = { 'package.json': JSON.stringify({ dependencies: { a: '1' } }) };
  assert.deepEqual(newDependencies({ before, after }), []);
});

test('newDependencies counts a version bump as new', () => {
  const before = { 'package.json': JSON.stringify({ dependencies: { a: '1' } }) };
  const after = { 'package.json': JSON.stringify({ dependencies: { a: '2' } }) };
  const got = newDependencies({ before, after }).map(d => ({ name: d.name, spec: d.spec }));
  assert.deepEqual(got, [{ name: 'a', spec: '2' }]);
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

test('newDependencies reads subfolder manifests and tags entries with file', () => {
  const after = {
    'packages/x/package.json': JSON.stringify({ dependencies: { left: '1' } }),
    'api/requirements.txt': 'flask==2\n',
  };
  const got = newDependencies({ before: {}, after }).map(d => ({ file: d.file, name: d.name }));
  assert.deepEqual(got, [
    { file: 'packages/x/package.json', name: 'left' },
    { file: 'api/requirements.txt', name: 'flask' },
  ]);
});

test('newDependencies matches manifest and requirements file names case-insensitively', () => {
  const after = {
    'PACKAGE.JSON': JSON.stringify({ dependencies: { up: '1' } }),
    'Sub/Package.Json': JSON.stringify({ dependencies: { sub: '1' } }),
    'Requirements-Dev.TXT': 'pytest==8.0\n',
  };
  const got = newDependencies({ before: {}, after }).map(d => ({ file: d.file, ecosystem: d.ecosystem, name: d.name }));
  assert.deepEqual(got, [
    { file: 'PACKAGE.JSON', ecosystem: 'npm', name: 'up' },
    { file: 'Sub/Package.Json', ecosystem: 'npm', name: 'sub' },
    { file: 'Requirements-Dev.TXT', ecosystem: 'pypi', name: 'pytest' },
  ]);
});

test('same name in another file counts as new', () => {
  const before = { 'a/package.json': JSON.stringify({ dependencies: { x: '1' } }) };
  const after = {
    'a/package.json': JSON.stringify({ dependencies: { x: '1' } }),
    'b/package.json': JSON.stringify({ dependencies: { x: '1' } }),
  };
  const got = newDependencies({ before, after });
  assert.equal(got.length, 1);
  assert.equal(got[0].file, 'b/package.json');
});

test('peerDependencies and overrides are read', () => {
  const after = { 'package.json': JSON.stringify({ peerDependencies: { p: '1' }, overrides: { o: '2' } }) };
  const got = newDependencies({ before: {}, after }).map(d => d.name).sort();
  assert.deepEqual(got, ['o', 'p']);
});

test('newDependencies reads new pypi requirements', () => {
  const before = { 'requirements.txt': 'requests==2.0' };
  const after = { 'requirements.txt': 'requests==2.0\nflask>=2\n# comment\n-r other.txt\ngit+https://x/y.git\nDjango[argon2]==4\n' };
  const got = newDependencies({ before, after });
  assert.deepEqual(got.map(d => d.name), ['flask', 'git+https://x/y.git', 'django']);
  assert.ok(got.every(d => d.ecosystem === 'pypi'));
  assert.equal(got[1].nonRegistry !== undefined, true);
  assert.equal(got[0].nonRegistry, undefined);
});

test('requirements options are ignored or flagged, direct URLs are non-registry', () => {
  const after = { 'requirements.txt': 'requests==2.0\n-r other.txt\n-c c.txt\n--extra-index-url https://evil.example/simple\npkg @ https://x/y.whl\n' };
  const got = newDependencies({ before: {}, after });
  assert.deepEqual(got.map(d => d.name), ['requests', '(option) --extra-index-url', 'pkg']);
  assert.equal(got[1].nonRegistry !== undefined, true);
  assert.equal(got[2].nonRegistry !== undefined, true);
  assert.equal(got[0].nonRegistry, undefined);
});

test('classifySpec: registry specs', () => {
  for (const s of ['^1.0.0', '1.2.3', 'latest', '*']) assert.equal(classifySpec(s).kind, 'registry', s);
});

test('classifySpec: alias and workspace', () => {
  assert.deepEqual(classifySpec('npm:other@1.2.3'), { kind: 'alias', target: 'other' });
  assert.equal(classifySpec('workspace:*').kind, 'workspace');
});

test('classifySpec: non-registry sources carry a why', () => {
  for (const s of ['github:user/repo', 'git+https://x/y.git', 'file:../x', 'https://x/y.tgz', 'user/repo']) {
    const c = classifySpec(s);
    assert.equal(c.kind, 'nonRegistry', s);
    assert.ok(typeof c.why === 'string' && c.why.length > 0, s);
  }
});

test('non-registry dependency is blocked without any fetch', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls++; return reply(200, {}); };
  for (const spec of ['github:user/repo', 'git+https://x/y.git', 'file:../x', 'https://x/y.tgz', 'user/repo']) {
    const r = await checkPackage({ name: 'x', ecosystem: 'npm', spec, dev: false }, { fetchImpl, now: () => NOW });
    assert.equal(r.ok, false, spec);
    assert.ok(r.reasons[0].includes('non-registry'), spec);
  }
  assert.equal(calls, 0);
});

test('alias is checked under its target name', async () => {
  const urls = [];
  const fetchImpl = async u => { urls.push(u); return npmFake({ days: 400, downloads: 5000 })(u); };
  const r = await checkPackage({ name: 'foo', ecosystem: 'npm', spec: 'npm:other@1.2.3', dev: false }, { fetchImpl, now: () => NOW });
  assert.equal(r.name, 'other');
  assert.equal(r.alias, 'foo');
  assert.ok(urls[0].endsWith('/other'));
});

test('workspace spec is ok with no fetch call', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls++; return reply(200, {}); };
  const r = await checkPackage({ name: 'ws', ecosystem: 'npm', spec: 'workspace:*', dev: false }, { fetchImpl, now: () => NOW });
  assert.equal(r.ok, true);
  assert.equal(calls, 0);
});

test('exact version uses that version age and license', async () => {
  const fetchImpl = async u => new URL(u).hostname === 'api.npmjs.org'
    ? reply(200, { downloads: 5000 })
    : reply(200, { time: { created: ago(400), '1.2.3': ago(10) }, 'dist-tags': { latest: '2.0.0' }, versions: { '2.0.0': { license: 'MIT' }, '1.2.3': { license: 'BSD-3-Clause' } } });
  const r = await checkPackage({ name: 'acme', ecosystem: 'npm', spec: '1.2.3', dev: false }, { fetchImpl, now: () => NOW });
  assert.equal(r.ageDays, 10);
  assert.equal(r.license, 'BSD-3-Clause');
});

test('missing exact version adds a reason that mentions the version', async () => {
  const fetchImpl = async u => new URL(u).hostname === 'api.npmjs.org'
    ? reply(200, { downloads: 5000 })
    : reply(200, { time: { created: ago(400) }, 'dist-tags': { latest: '2.0.0' }, versions: { '2.0.0': { license: 'MIT' } } });
  const r = await checkPackage({ name: 'acme', ecosystem: 'npm', spec: '9.9.9', dev: false }, { fetchImpl, now: () => NOW });
  assert.equal(r.ok, false);
  assert.ok(r.reasons.some(x => x.includes('9.9.9')));
});

test('every fetch gets a signal in its second argument', async () => {
  const seen = [];
  const fetchImpl = async (u, opts) => { seen.push(opts); return npmFake({ days: 400, downloads: 5000 })(u); };
  await checkPackage(npm('acme-widget'), { fetchImpl, now: () => NOW });
  assert.ok(seen.length > 0);
  assert.ok(seen.every(o => o && o.signal instanceof AbortSignal));
});

test('cache makes a second identical check do no fetch calls', async () => {
  const cache = new Map();
  let calls = 0;
  const base = npmFake({ days: 400, downloads: 5000 });
  const fetchImpl = async u => { calls++; return base(u); };
  await checkPackage(npm('acme-widget'), { fetchImpl, now: () => NOW, cache });
  assert.ok(calls > 0);
  calls = 0;
  await checkPackage(npm('acme-widget'), { fetchImpl, now: () => NOW, cache });
  assert.equal(calls, 0);
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

test('pypi name is normalized per PEP 503 in the URL', async () => {
  const urls = [];
  const fetchImpl = async u => { urls.push(u); return reply(200, { info: { license: 'MIT', classifiers: [] }, releases: {} }); };
  await checkPackage({ name: 'Foo_Bar', ecosystem: 'pypi', spec: '', dev: false }, { fetchImpl, now: () => NOW });
  assert.ok(urls[0].includes('/pypi/foo-bar/json'));
});

test('pypi missing upload date gives unknown age', async () => {
  const r = await checkPackage({ name: 'flask', ecosystem: 'pypi', dev: false }, { fetchImpl: async () => reply(200, { info: { license: 'MIT', classifiers: [] }, releases: {} }), now: () => NOW });
  assert.ok(r.reasons.includes('unknown age'));
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

test('pypi AGPL classifier gives a license that licenseBlocked blocks', async () => {
  const body = { info: { license: '', classifiers: ['License :: OSI Approved :: GNU Affero General Public License v3'] }, releases: {} };
  const r = await checkPackage({ name: 'agpl-pkg', ecosystem: 'pypi', dev: false }, { fetchImpl: async () => reply(200, body), now: () => NOW });
  assert.equal(r.license, 'AGPL-3.0');
  assert.equal(licenseBlocked(r.license), true);
});

test('license text is cleaned: odd characters removed and cut to 80 characters', async () => {
  const body = { info: { license: 'M' + '!'.repeat(5) + 'x'.repeat(100), classifiers: [] }, releases: {} };
  const r = await checkPackage({ name: 'flask', ecosystem: 'pypi', dev: false }, { fetchImpl: async () => reply(200, body), now: () => NOW });
  assert.equal(r.license.length, 80);
  assert.ok(!r.license.includes('!'));
  assert.ok(r.license.startsWith('M'));
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
