// SPDX-License-Identifier: Apache-2.0
// Field lesson #224/#225: swarm check-pins catches stale internal pins (a library exact-pinning
// the shared core package, an exact pin drifted from the vendored copy, or a vendored wheel's own
// requirement going unsatisfied) that otherwise only surface at a fresh, offline install.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import {
  runCheckPins,
  compareVersions,
  parseRequirement,
  satisfiesRequirement,
  parseWheelFilename,
  parseTarballFilename,
  parseUvLockVersions,
  parseRequiresDist,
  exactNpmVersion,
} from '../tools/check-pins.mjs';

const CORE = 'acme-core';
const APP_PREFIX = 'acme-app-';

async function tmpRoot(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'check-pins-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

// --- a tiny zip writer, store-only, so the fixture wheels are built at runtime, not committed ---
function makeZip(files) {
  const localChunks = [], central = [];
  let offset = 0;
  for (const { name, data } of files) {
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = zlib.crc32(data);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0, 6);
    header.writeUInt16LE(0, 8);
    header.writeUInt16LE(0, 10);
    header.writeUInt16LE(0, 12);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(data.length, 18);
    header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(nameBuf.length, 26);
    header.writeUInt16LE(0, 28);
    localChunks.push(header, nameBuf, data);
    central.push({ nameBuf, crc, size: data.length, offset });
    offset += header.length + nameBuf.length + data.length;
  }
  const centralStart = offset;
  const centralChunks = [];
  for (const c of central) {
    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(20, 6);
    header.writeUInt16LE(0, 8);
    header.writeUInt16LE(0, 10);
    header.writeUInt16LE(0, 12);
    header.writeUInt16LE(0, 14);
    header.writeUInt32LE(c.crc, 16);
    header.writeUInt32LE(c.size, 20);
    header.writeUInt32LE(c.size, 24);
    header.writeUInt16LE(c.nameBuf.length, 28);
    header.writeUInt16LE(0, 30);
    header.writeUInt16LE(0, 32);
    header.writeUInt16LE(0, 34);
    header.writeUInt16LE(0, 36);
    header.writeUInt32LE(0, 38);
    header.writeUInt32LE(c.offset, 42);
    centralChunks.push(header, c.nameBuf);
    offset += header.length + c.nameBuf.length;
  }
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(central.length, 8);
  eocd.writeUInt16LE(central.length, 10);
  eocd.writeUInt32LE(offset - centralStart, 12);
  eocd.writeUInt32LE(centralStart, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...localChunks, ...centralChunks, eocd]);
}

// A minimal wheel: one dist-info/METADATA entry with the given Requires-Dist lines.
async function writeWheel(vendorDir, name, version, requiresDist = []) {
  const distInfo = `${name}-${version}.dist-info`;
  const metadata = [`Metadata-Version: 2.1`, `Name: ${name}`, `Version: ${version}`, ...requiresDist.map(r => `Requires-Dist: ${r}`)].join('\n') + '\n';
  const zip = makeZip([{ name: `${distInfo}/METADATA`, data: Buffer.from(metadata, 'utf8') }]);
  await fs.mkdir(vendorDir, { recursive: true });
  // Wheel filenames normalize the distribution name's hyphens to underscores (PEP 427).
  await fs.writeFile(path.join(vendorDir, `${name.replace(/-/g, '_')}-${version}-py3-none-any.whl`), zip);
}

async function writeTarball(vendorDir, name, version) {
  await fs.mkdir(vendorDir, { recursive: true });
  await fs.writeFile(path.join(vendorDir, `${name}-${version}.tgz`), Buffer.from('fixture tarball, not a real archive'));
}

// --- unit-level parsing -------------------------------------------------------------------------

test('compareVersions orders dotted versions numerically, not lexically', () => {
  assert.equal(compareVersions('0.4.0', '0.5.1'), -1);
  assert.equal(compareVersions('0.10.0', '0.9.0'), 1);
  assert.equal(compareVersions('1.0.0', '1.0.0'), 0);
});

test('parseRequirement: exact pin vs range vs extras', () => {
  assert.deepEqual(parseRequirement('acme-core==0.4.0'), { name: 'acme-core', exact: '0.4.0', clauses: ['==0.4.0'], raw: '==0.4.0' });
  assert.equal(parseRequirement('acme-lib-a>=0.5,<0.6').exact, null);
  assert.equal(parseRequirement('acme-lib-c[extra]==1.2').exact, '1.2');
  assert.equal(parseRequirement('acme_core==0.4.0').name, 'acme-core');
});

test('satisfiesRequirement checks every clause', () => {
  const range = parseRequirement('acme-core>=0.5,<0.6');
  assert.equal(satisfiesRequirement('0.5.1', range), true);
  assert.equal(satisfiesRequirement('0.6.0', range), false);
  assert.equal(satisfiesRequirement('0.4.9', range), false);
});

test('parseWheelFilename and parseTarballFilename normalize underscores to hyphens', () => {
  assert.deepEqual(parseWheelFilename('acme_core-0.5.1-py3-none-any.whl'), { name: 'acme-core', version: '0.5.1' });
  assert.equal(parseWheelFilename('not-a-wheel.txt'), null);
  assert.deepEqual(parseTarballFilename('acme-lib-a-0.4.0.tgz'), { name: 'acme-lib-a', version: '0.4.0' });
  assert.equal(parseTarballFilename('random.tgz'), null);
});

test('parseUvLockVersions reads repeated [[package]] blocks', () => {
  const lock = `version = 1\n\n[[package]]\nname = "acme-core"\nversion = "0.5.1"\nsource = { virtual = "." }\n\n[[package]]\nname = "acme-lib-a"\nversion = "0.5.0"\n`;
  const versions = parseUvLockVersions(lock);
  assert.equal(versions.get('acme-core'), '0.5.1');
  assert.equal(versions.get('acme-lib-a'), '0.5.0');
});

test('parseRequiresDist skips conditional (extras/markers) requirements', () => {
  const metadata = `Name: acme-lib-c\nRequires-Dist: acme-core==0.4.0\nRequires-Dist: pytest>=7 ; extra == "test"\n`;
  const reqs = parseRequiresDist(metadata);
  assert.equal(reqs.length, 1);
  assert.equal(reqs[0].name, 'acme-core');
  assert.equal(reqs[0].exact, '0.4.0');
});

test('exactNpmVersion accepts a plain version, rejects ranges', () => {
  assert.equal(exactNpmVersion('0.4.0'), '0.4.0');
  assert.equal(exactNpmVersion('^0.4.0'), null);
  assert.equal(exactNpmVersion('~0.4.0'), null);
  assert.equal(exactNpmVersion('*'), null);
});

// --- runCheckPins: the three stale-pin fixtures from the contract -------------------------------

test('runCheckPins: a library (acme-lib-a) exact-pinning the core package older than the vendored wheel fails three rules', async t => {
  const root = await tmpRoot(t);
  await fs.writeFile(path.join(root, 'pyproject.toml'), `[project]\nname = "acme-lib-a"\ndependencies = [\n  "acme-core==0.4.0",\n]\n`);
  await writeWheel(path.join(root, 'vendor'), 'acme-core', '0.5.1');

  const result = await runCheckPins({ root, core: CORE, appPrefix: APP_PREFIX });
  assert.equal(result.ok, false);
  assert.equal(result.exitCode, 1);
  const rules = result.findings.map(f => f.rule).sort();
  assert.deepEqual(rules, ['library-exact-core-pin', 'pin-not-vendored-version', 'pin-older-than-vendored']);
  for (const finding of result.findings) assert.equal(finding.package, 'acme-core');
});

test('runCheckPins: acme-lib-b reproduces the same stale core pin as acme-lib-a', async t => {
  const root = await tmpRoot(t);
  await fs.writeFile(path.join(root, 'pyproject.toml'), `[project]\nname = "acme-lib-b"\ndependencies = [\n  "acme-core==0.4.0",\n]\n`);
  await writeWheel(path.join(root, 'vendor'), 'acme-core', '0.5.1');

  const result = await runCheckPins({ root, core: CORE, appPrefix: APP_PREFIX });
  assert.equal(result.ok, false);
  assert.deepEqual(result.findings.map(f => f.rule).sort(), ['library-exact-core-pin', 'pin-not-vendored-version', 'pin-older-than-vendored']);
});

test('runCheckPins: acme-lib-c stale pin one layer down, inside a wheel vendored by the core repo, unsatisfied by uv.lock', async t => {
  const root = await tmpRoot(t);
  await fs.writeFile(path.join(root, 'pyproject.toml'), `[project]\nname = "acme-core"\ndependencies = []\n`);
  await fs.writeFile(path.join(root, 'uv.lock'), `[[package]]\nname = "acme-core"\nversion = "0.5.1"\n`);
  await writeWheel(path.join(root, 'vendor'), 'acme-lib-c', '0.3.0', ['acme-core==0.4.0']);

  const result = await runCheckPins({ root, core: CORE, appPrefix: APP_PREFIX });
  assert.equal(result.ok, false);
  assert.deepEqual(result.findings, [{
    rule: 'wheel-requirement-unsatisfied',
    file: 'vendor/acme_lib_c-0.3.0-py3-none-any.whl',
    package: 'acme-core',
    message: 'vendored wheel acme_lib_c-0.3.0-py3-none-any.whl requires acme-core==0.4.0 but uv.lock has acme-core==0.5.1',
  }]);
});

test('runCheckPins: a fixed tree (pin matches the vendored version, satisfied wheel requirement) passes clean', async t => {
  const root = await tmpRoot(t);
  await fs.writeFile(path.join(root, 'pyproject.toml'), `[project]\nname = "acme-lib-a"\ndependencies = [\n  "acme-core>=0.5,<0.6",\n]\n`);
  await writeWheel(path.join(root, 'vendor'), 'acme-core', '0.5.1');

  const result = await runCheckPins({ root, core: CORE, appPrefix: APP_PREFIX });
  assert.deepEqual(result, { ok: true, exitCode: 0, findings: [] });
});

test('runCheckPins: the core repo itself with a satisfied wheel requirement passes clean', async t => {
  const root = await tmpRoot(t);
  await fs.writeFile(path.join(root, 'pyproject.toml'), `[project]\nname = "acme-core"\ndependencies = []\n`);
  await fs.writeFile(path.join(root, 'uv.lock'), `[[package]]\nname = "acme-core"\nversion = "0.5.1"\n`);
  await writeWheel(path.join(root, 'vendor'), 'acme-lib-c', '0.3.0', ['acme-core==0.5.1']);

  const result = await runCheckPins({ root, core: CORE, appPrefix: APP_PREFIX });
  assert.deepEqual(result, { ok: true, exitCode: 0, findings: [] });
});

// --- pin-older-than-vendored: matches an old vendored copy exactly, but a newer one also exists --

test('runCheckPins: pin matches an older vendored copy exactly, but a newer vendored copy also exists', async t => {
  const root = await tmpRoot(t);
  await fs.writeFile(path.join(root, 'pyproject.toml'), `[project]\nname = "acme-app-x"\ndependencies = [\n  "acme-core==0.4.0",\n]\n`);
  await writeWheel(path.join(root, 'vendor'), 'acme-core', '0.4.0');
  await writeWheel(path.join(root, 'vendor'), 'acme-core', '0.5.1');

  const result = await runCheckPins({ root, core: CORE, appPrefix: APP_PREFIX });
  assert.deepEqual(result.findings, [{ rule: 'pin-older-than-vendored', file: 'pyproject.toml', package: 'acme-core', message: 'acme-core is pinned to 0.4.0 but a newer vendored copy 0.5.1 exists' }]);
});

test('runCheckPins: an app repo (acme-app-x) may exact-pin the core package without tripping library-exact-core-pin', async t => {
  const root = await tmpRoot(t);
  await fs.writeFile(path.join(root, 'pyproject.toml'), `[project]\nname = "acme-app-x"\ndependencies = [\n  "acme-core==0.5.1",\n]\n`);
  await writeWheel(path.join(root, 'vendor'), 'acme-core', '0.5.1');

  const result = await runCheckPins({ root, core: CORE, appPrefix: APP_PREFIX });
  assert.deepEqual(result, { ok: true, exitCode: 0, findings: [] });
});

// --- acme-desk: package.json dependencies vs vendored tarballs, same rule names -----------------

test('runCheckPins: acme-desk package.json exact-pins acme-lib-a older than the vendored tarball', async t => {
  const root = await tmpRoot(t);
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'acme-desk', dependencies: { 'acme-lib-a': '0.4.0', react: '^18.0.0' } }));
  await writeTarball(path.join(root, 'vendor'), 'acme-lib-a', '0.5.0');

  const result = await runCheckPins({ root, core: CORE, appPrefix: APP_PREFIX });
  assert.equal(result.ok, false);
  assert.deepEqual(result.findings.map(f => f.rule).sort(), ['pin-not-vendored-version', 'pin-older-than-vendored']);
  for (const finding of result.findings) assert.equal(finding.file, 'package.json');
});

test('runCheckPins: acme-desk package.json matching the vendored tarball passes clean', async t => {
  const root = await tmpRoot(t);
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'acme-desk', dependencies: { 'acme-lib-a': '0.5.0' } }));
  await writeTarball(path.join(root, 'vendor'), 'acme-lib-a', '0.5.0');

  const result = await runCheckPins({ root, core: CORE, appPrefix: APP_PREFIX });
  assert.deepEqual(result, { ok: true, exitCode: 0, findings: [] });
});

// --- no --core: the two core-specific rules are skipped, generic rules still fire ---------------

test('runCheckPins: without core, library-exact-core-pin and wheel-requirement-unsatisfied are skipped and named in skippedRules', async t => {
  const root = await tmpRoot(t);
  await fs.writeFile(path.join(root, 'pyproject.toml'), `[project]\nname = "acme-lib-a"\ndependencies = [\n  "acme-core==0.4.0",\n]\n`);
  await writeWheel(path.join(root, 'vendor'), 'acme-core', '0.5.1');

  const result = await runCheckPins({ root });
  assert.deepEqual(result.skippedRules, ['library-exact-core-pin', 'wheel-requirement-unsatisfied']);
  assert.deepEqual(result.findings.map(f => f.rule).sort(), ['pin-not-vendored-version', 'pin-older-than-vendored']);
});

// --- json / human output, and a repo with neither manifest -------------------------------------

test('runCheckPins: json:true prints exactly one JSON line matching the returned result', async t => {
  const root = await tmpRoot(t);
  await fs.writeFile(path.join(root, 'pyproject.toml'), `[project]\nname = "acme-lib-a"\ndependencies = [\n  "acme-core==0.4.0",\n]\n`);
  await writeWheel(path.join(root, 'vendor'), 'acme-core', '0.5.1');

  const lines = [];
  const originalLog = console.log;
  console.log = (...args) => lines.push(args.join(' '));
  let result;
  try { result = await runCheckPins({ root, json: true, core: CORE, appPrefix: APP_PREFIX }); } finally { console.log = originalLog; }

  assert.equal(lines.length, 1);
  assert.deepEqual(JSON.parse(lines[0]), result);
});

test('runCheckPins: a repo with no pyproject.toml and no package.json is clean, not an error', async t => {
  const root = await tmpRoot(t);
  const result = await runCheckPins({ root, core: CORE, appPrefix: APP_PREFIX });
  assert.deepEqual(result, { ok: true, exitCode: 0, findings: [] });
});
