// SPDX-License-Identifier: Apache-2.0
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runSecurityGate, normalizePolicy, DEFAULT_POLICY, formatBlocks, lessonFor, recordGate } from '../tools/security-gate.mjs';

const NOW = Date.parse('2025-01-01T00:00:00Z');
const AWS = 'AK' + 'IA' + 'ABCDEFGHIJKLMNOP';
const noExec = async () => { throw new Error('missing'); };
const noFetch = async () => { throw new Error('no fetch expected'); };
const jsonRes = (body, status = 200) => ({ status, ok: status < 300, json: async () => body });
const meta = (license) => ({ time: { created: new Date(NOW - 500 * 864e5).toISOString() }, 'dist-tags': { latest: '1.0.0' }, versions: { '1.0.0': license === undefined ? {} : { license } } });
const registry = (m, downloads = 100000) => async (url) => (url.includes('api.npmjs.org') ? jsonRes({ downloads }) : jsonRes(m));
const pkg = (deps) => Buffer.from(JSON.stringify({ dependencies: deps }));

test('planted secret blocks without leaking the value', async () => {
  const bytes = Buffer.from('// config\nconst key = ' + AWS + ';\n');
  const gate = await runSecurityGate({ changes: [{ file: 'src/config.js', bytes, previous: null }], exec: noExec, fetchImpl: noFetch, now: () => NOW });
  assert.equal(gate.ok, false);
  const b = gate.blocks.find((x) => x.check === 'secret-scan');
  assert.equal(b.severity, 'critical');
  assert.ok(b.message.includes('src/config.js:2'));
  assert.ok(!JSON.stringify(gate).includes(AWS));
});

test('made-up package blocks; real old popular package passes', async () => {
  const prev = pkg({});
  const bad = await runSecurityGate({ changes: [{ file: 'package.json', bytes: pkg({ 'definitely-not-real-pkg': '^1.0.0' }), previous: prev }], exec: noExec, fetchImpl: async () => jsonRes({}, 404), now: () => NOW });
  assert.equal(bad.ok, false);
  assert.ok(bad.blocks.some((b) => b.check === 'package-check'));
  const good = await runSecurityGate({ changes: [{ file: 'package.json', bytes: pkg({ lodash: '^4.0.0' }), previous: prev }], exec: noExec, fetchImpl: registry(meta('MIT')), now: () => NOW });
  assert.equal(good.ok, true);
  assert.equal(good.blocks.length, 0);
});

test('known-vulnerable dependency blocks; low-only does not', async () => {
  const pj = pkg({ lodash: '^4.0.0' });
  const changes = [{ file: 'package.json', bytes: pj, previous: pj }, { file: 'package-lock.json', bytes: Buffer.from('{}'), previous: Buffer.from('{}') }];
  const audit = (sev) => async (argv) => {
    if (argv.join(' ') === 'npm audit --json') return { stdout: JSON.stringify({ vulnerabilities: { lodash: { severity: sev } } }) };
    throw new Error('missing');
  };
  const high = await runSecurityGate({ changes, exec: audit('high'), fetchImpl: noFetch, now: () => NOW });
  assert.equal(high.ok, false);
  assert.ok(high.blocks.some((b) => b.check === 'vulnerability'));
  const low = await runSecurityGate({ changes, exec: audit('low'), fetchImpl: noFetch, now: () => NOW });
  assert.equal(low.ok, true);
});

test('copyleft license blocks unless allowed; unknown license only warns', async () => {
  const change = [{ file: 'package.json', bytes: pkg({ 'new-lib': '^1.0.0' }), previous: pkg({}) }];
  const gpl = registry(meta('GPL-3.0'));
  const blocked = await runSecurityGate({ changes: change, exec: noExec, fetchImpl: gpl, now: () => NOW });
  assert.equal(blocked.ok, false);
  assert.ok(blocked.blocks.some((b) => b.check === 'license-check'));
  for (const policy of [{ allowCopyleft: true }, { approvedLicenses: ['GPL-3.0'] }]) {
    const ok = await runSecurityGate({ changes: change, policy, exec: noExec, fetchImpl: gpl, now: () => NOW });
    assert.equal(ok.blocks.some((b) => b.check === 'license-check'), false);
  }
  const unknown = await runSecurityGate({ changes: change, exec: noExec, fetchImpl: registry(meta(undefined)), now: () => NOW });
  assert.equal(unknown.ok, true);
  assert.ok(unknown.warnings.some((w) => w.includes('license unknown')));
});

test('clean source change runs only secret-scan with no audit or fetch', async () => {
  const calls = [];
  let fetches = 0;
  const exec = async (argv) => { calls.push(argv.join(' ')); throw new Error('missing'); };
  const fetchImpl = async () => { fetches++; throw new Error('no fetch expected'); };
  const gate = await runSecurityGate({ changes: [{ file: 'src/index.js', bytes: Buffer.from('export const n = 1;\n'), previous: null }], exec, fetchImpl, now: () => NOW });
  assert.equal(gate.ok, true);
  assert.deepEqual(gate.checked, ['secret-scan']);
  assert.equal(fetches, 0);
  assert.equal(calls.some((c) => c.includes('audit')), false);
});

test('semgrep finding makes a ticket without blocking; missing tools are skipped', async () => {
  const report = { results: [{ check_id: 'demo.rule', path: 'src/index.js', start: { line: 1 }, extra: { severity: 'ERROR', message: 'bad' } }] };
  const exec = async (argv) => {
    if (argv[0] === 'semgrep' && argv[1] === '--version') return { stdout: '1.0.0' };
    if (argv[0] === 'semgrep') return { stdout: JSON.stringify(report) };
    throw new Error('missing');
  };
  const change = [{ file: 'src/index.js', bytes: Buffer.from('export const n = 1;\n'), previous: null }];
  const gate = await runSecurityGate({ changes: change, exec, fetchImpl: noFetch, now: () => NOW });
  assert.equal(gate.ok, true);
  assert.equal(gate.tickets.length, 1);
  const none = await runSecurityGate({ changes: change, exec: noExec, fetchImpl: noFetch, now: () => NOW });
  assert.ok(none.skipped.includes('semgrep not installed'));
  const lock = [{ file: 'package.json', bytes: pkg({}), previous: pkg({}) }, { file: 'package-lock.json', bytes: Buffer.from('{}'), previous: Buffer.from('{}') }];
  const noNpm = await runSecurityGate({ changes: lock, exec: noExec, fetchImpl: noFetch, now: () => NOW });
  assert.ok(noNpm.skipped.includes('npm not installed'));
});

test('disabled policy returns immediately and does nothing else', async () => {
  let calls = 0;
  const spy = async () => { calls++; throw new Error('should not run'); };
  const gate = await runSecurityGate({ changes: [{ file: 'a.js', bytes: Buffer.from(AWS), previous: null }], policy: { enabled: false }, exec: spy, fetchImpl: spy, now: () => NOW });
  assert.deepEqual(gate, { ok: true, blocks: [], tickets: [], warnings: [], skipped: ['security gate disabled by policy'], checked: [] });
  assert.equal(calls, 0);
});

test('normalizePolicy keeps valid values and ignores the rest', () => {
  const p = normalizePolicy({ enabled: 'no', foo: 1, minAgeDays: 7, minWeeklyDownloads: -1, blockSeverities: 'high', approvedLicenses: ['MIT'], allowCopyleft: true });
  assert.equal(p.enabled, true);
  assert.equal(p.minAgeDays, 7);
  assert.equal(p.minWeeklyDownloads, DEFAULT_POLICY.minWeeklyDownloads);
  assert.deepEqual(p.blockSeverities, DEFAULT_POLICY.blockSeverities);
  assert.deepEqual(p.approvedLicenses, ['MIT']);
  assert.equal(p.allowCopyleft, true);
  assert.equal('foo' in p, false);
  assert.equal(normalizePolicy({ enabled: false }).enabled, false);
});

test('DEFAULT_POLICY is frozen with minAgeDays 30', () => {
  assert.equal(Object.isFrozen(DEFAULT_POLICY), true);
  assert.equal(DEFAULT_POLICY.minAgeDays, 30);
});

test('formatBlocks and lessonFor give one line per block and leak nothing', () => {
  const gate = { ok: false, blocks: [
    { check: 'secret-scan', severity: 'critical', message: 'possible AWS access key ID in src/config.js:2 (fingerprint abc)', path: 'src/config.js', line: 2, fingerprint: 'abc' },
    { check: 'secret-scan', severity: 'critical', message: 'second', path: 'src/x.js', line: 1, fingerprint: 'def' },
    { check: 'package-check', severity: 'high', message: 'x: not found' },
  ] };
  assert.equal(formatBlocks(gate).split('\n').length, 3);
  const lesson = lessonFor(gate, { runId: 'r1', date: '2025-01-01' });
  assert.deepEqual(lesson.checks, ['secret-scan', 'package-check']);
  assert.ok(lesson.tags.includes('security'));
  assert.ok(!JSON.stringify(lesson).includes(AWS));
});

test('recordGate writes one lesson line and one blocker event', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sg-'));
  try {
    const gate = { ok: false, blocks: [{ check: 'secret-scan', severity: 'critical', message: 'possible AWS access key ID in src/config.js:2 (fingerprint abc)', path: 'src/config.js', line: 2, fingerprint: 'abc' }] };
    const events = [];
    const appendEvent = async (r, ev) => { events.push(ev); };
    const res = await recordGate({ root, runId: 'r1', jobs: ['job/one'], gate, appendEvent, now: () => NOW });
    assert.equal(res.recorded, true);
    const file = path.join(root, '.swarm', 'project', 'security-lessons.ndjson');
    const lines = (await readFile(file, 'utf8')).trim().split('\n');
    assert.equal(lines.length, 1);
    assert.equal(JSON.parse(lines[0]).source, 'security-gate');
    if (process.platform !== 'win32') assert.equal((await stat(file)).mode & 0o777, 0o600);
    assert.equal(events.length, 1);
    assert.equal(events[0].kind, 'blocker');
    assert.ok(events[0].id.startsWith('security-r1-'));
    assert.match(events[0].id, /^[A-Za-z0-9._-]+$/);
    assert.ok(events[0].text.length < 600);
    assert.ok(!events[0].text.includes(AWS));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('recordGate records nothing without blocks and never throws', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sg-'));
  try {
    let calls = 0;
    const none = await recordGate({ root, runId: 'r1', jobs: ['a'], gate: { ok: true, blocks: [] }, appendEvent: async () => { calls++; } });
    assert.equal(none.recorded, false);
    assert.equal(calls, 0);
    const gate = { ok: false, blocks: [{ check: 'vulnerability', severity: 'high', message: 'lodash has a high vulnerability' }] };
    const boom = await recordGate({ root, runId: 'r1', jobs: ['a'], gate, appendEvent: async () => { throw new Error('boom'); }, now: () => NOW });
    assert.equal(boom.recorded, false);
    assert.equal(boom.error, 'boom');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
