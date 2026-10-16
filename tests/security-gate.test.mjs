// SPDX-License-Identifier: Apache-2.0
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runSecurityGate, normalizePolicy, DEFAULT_POLICY, formatBlocks, lessonFor, recordGate } from '../tools/security-gate.mjs';
import { scanSecretsDetailed } from '../tools/security-scan.mjs';

const NOW = Date.parse('2025-01-01T00:00:00Z');
const AWS = 'AK' + 'IA' + 'ABCDEFGHIJKLMNOP';
const noExec = async () => { throw new Error('missing'); };
const noFetch = async () => { throw new Error('no fetch expected'); };
const jsonRes = (body, status = 200) => ({ status, ok: status < 300, json: async () => body });
const meta = (license) => ({ time: { created: new Date(NOW - 500 * 864e5).toISOString() }, 'dist-tags': { latest: '1.0.0' }, versions: { '1.0.0': license === undefined ? {} : { license } } });
const registry = (m, downloads = 100000) => async (url) => (new URL(url).hostname === 'api.npmjs.org' ? jsonRes({ downloads }) : jsonRes(m));
const pkg = (deps) => Buffer.from(JSON.stringify({ dependencies: deps }));
const auditOnly = (handler) => async (argv, opts) => { if (argv[0] === 'npm' && argv[1] === 'audit') return handler(argv, opts); throw new Error('missing'); };
const LOCK = [{ file: 'package-lock.json', bytes: Buffer.from('{}'), previous: Buffer.from('{}') }];

test('planted secret blocks without leaking the value', async () => {
  const bytes = Buffer.from('// config\nconst key = ' + AWS + ';\n');
  const gate = await runSecurityGate({ changes: [{ file: 'src/config.js', bytes, previous: null }], exec: noExec, fetchImpl: noFetch, now: () => NOW });
  assert.equal(gate.ok, false);
  const b = gate.blocks.find((x) => x.check === 'secret-scan');
  assert.equal(b.severity, 'critical');
  assert.ok(b.message.includes('src/config.js:2'));
  assert.ok(!JSON.stringify(gate).includes(AWS));
});

test('secret allow marker works only on lines that already existed', async () => {
  const line = 'const key = ' + AWS + '; // swarm-secret-allow';
  const same = Buffer.from('// x\n' + line + '\n');
  const kept = await runSecurityGate({ changes: [{ file: 'src/a.js', bytes: same, previous: same }], exec: noExec, fetchImpl: noFetch, now: () => NOW });
  assert.equal(kept.blocks.some((b) => b.check === 'secret-scan'), false);
  const added = await runSecurityGate({ changes: [{ file: 'src/a.js', bytes: same, previous: null }], exec: noExec, fetchImpl: noFetch, now: () => NOW });
  assert.equal(added.blocks.some((b) => b.check === 'secret-scan'), true);
});

test('file beyond the scan limit is a block (gate level)', async () => {
  const big = Buffer.alloc(21 * 1024 * 1024, 97);
  const gate = await runSecurityGate({ changes: [{ file: 'src/big.txt', bytes: big, previous: null }], exec: noExec, fetchImpl: noFetch, now: () => NOW });
  assert.equal(gate.ok, false);
  assert.ok(gate.blocks.some((b) => b.check === 'secret-scan' && b.message.includes('src/big.txt is too large to scan')));
});

test('scan-level: text over maxBytes that cannot be windowed is skipped as too large', () => {
  const res = scanSecretsDetailed([{ path: 'big.txt', content: 'x'.repeat(200) }], { maxBytes: 100 });
  assert.ok(res.skipped.some((s) => s.path === 'big.txt' && s.reason === 'too large to scan'));
});

test('fingerprintKey changes fingerprints and is stable for the same key', async () => {
  const bytes = Buffer.from('const key = ' + AWS + ';\n');
  const change = [{ file: 'src/c.js', bytes, previous: null }];
  const plain = await runSecurityGate({ changes: change, exec: noExec, fetchImpl: noFetch, now: () => NOW });
  const k1 = await runSecurityGate({ changes: change, exec: noExec, fetchImpl: noFetch, now: () => NOW, fingerprintKey: 'k1' });
  const k1b = await runSecurityGate({ changes: change, exec: noExec, fetchImpl: noFetch, now: () => NOW, fingerprintKey: 'k1' });
  const fp = (g) => g.blocks.find((b) => b.check === 'secret-scan').fingerprint;
  assert.equal(fp(k1), fp(k1b));
  assert.notEqual(fp(plain), fp(k1));
  assert.equal(fp(k1).length, 12);
  assert.ok(!JSON.stringify(k1).includes(AWS));
});

test('made-up package blocks; real old popular package passes', async () => {
  const prev = pkg({});
  const bad = await runSecurityGate({ changes: [{ file: 'package.json', bytes: pkg({ 'definitely-not-real-pkg': '^1.0.0' }), previous: prev }], policy: { requireVulnerabilityScan: false }, exec: noExec, fetchImpl: async () => jsonRes({}, 404), now: () => NOW });
  assert.equal(bad.ok, false);
  assert.ok(bad.blocks.some((b) => b.check === 'package-check'));
  const good = await runSecurityGate({ changes: [{ file: 'package.json', bytes: pkg({ lodash: '^4.0.0' }), previous: prev }], policy: { requireVulnerabilityScan: false }, exec: noExec, fetchImpl: registry(meta('MIT')), now: () => NOW });
  assert.equal(good.ok, true);
  assert.equal(good.blocks.length, 0);
});

test('cache avoids a second registry call for the same gate input', async () => {
  const cache = new Map();
  let fetches = 0;
  const reg = registry(meta('MIT'));
  const fetchImpl = async (url, o) => { fetches++; return reg(url, o); };
  const change = [{ file: 'package.json', bytes: pkg({ lodash: '^4.0.0' }), previous: pkg({}) }];
  await runSecurityGate({ changes: change, exec: noExec, fetchImpl, now: () => NOW, cache });
  const first = fetches;
  assert.equal(first, 2);
  await runSecurityGate({ changes: change, exec: noExec, fetchImpl, now: () => NOW, cache });
  assert.equal(fetches, first);
});

test('known-vulnerable dependency blocks; low-only does not', async () => {
  const pj = pkg({ lodash: '^4.0.0' });
  const changes = [{ file: 'package.json', bytes: pj, previous: pj }, { file: 'package-lock.json', bytes: Buffer.from('{}'), previous: Buffer.from('{}') }];
  const audit = (sev) => auditOnly(() => ({ stdout: JSON.stringify({ vulnerabilities: { lodash: { severity: sev } } }) }));
  const high = await runSecurityGate({ changes, exec: audit('high'), fetchImpl: noFetch, now: () => NOW });
  assert.equal(high.ok, false);
  assert.ok(high.blocks.some((b) => b.check === 'vulnerability'));
  const low = await runSecurityGate({ changes, exec: audit('low'), fetchImpl: noFetch, now: () => NOW });
  assert.equal(low.ok, true);
});

test('vulnerability check fails closed when no scanner ran after a lockfile change', async () => {
  const gate = await runSecurityGate({ changes: LOCK, exec: noExec, fetchImpl: noFetch, now: () => NOW });
  assert.equal(gate.ok, false);
  const b = gate.blocks.find((x) => x.check === 'vulnerability');
  assert.ok(b.message.includes('could not verify'));
});

test('requireVulnerabilityScan false turns off the no-scanner block', async () => {
  const gate = await runSecurityGate({ changes: LOCK, policy: { requireVulnerabilityScan: false }, exec: noExec, fetchImpl: noFetch, now: () => NOW });
  assert.equal(gate.blocks.some((b) => b.check === 'vulnerability'), false);
  assert.equal(gate.ok, true);
});

test('unparsable npm audit JSON is unusable and blocks', async () => {
  const gate = await runSecurityGate({ changes: LOCK, exec: auditOnly(() => ({ stdout: 'not json' })), fetchImpl: noFetch, now: () => NOW });
  assert.ok(gate.blocks.some((b) => b.message === 'could not verify: npm output unusable'));
});

test('npm audit JSON with an error property is unusable', async () => {
  const gate = await runSecurityGate({ changes: LOCK, exec: auditOnly(() => ({ stdout: JSON.stringify({ error: { code: 'E403' } }) })), fetchImpl: noFetch, now: () => NOW });
  assert.ok(gate.blocks.some((b) => b.message === 'could not verify: npm output unusable'));
});

test('npm audit exit code 1 with a valid high vulnerability is usable and blocks', async () => {
  const out = { stdout: JSON.stringify({ vulnerabilities: { lodash: { severity: 'high' } } }), exitCode: 1 };
  const gate = await runSecurityGate({ changes: LOCK, exec: auditOnly(() => out), fetchImpl: noFetch, now: () => NOW });
  assert.equal(gate.ok, false);
  assert.ok(gate.blocks.some((b) => b.check === 'vulnerability' && b.severity === 'high'));
});

test('npm audit argv includes the pinned registry', async () => {
  let argv0 = null;
  await runSecurityGate({ changes: LOCK, exec: auditOnly((argv) => { argv0 = argv; return { stdout: '{"vulnerabilities":{}}' }; }), fetchImpl: noFetch, now: () => NOW });
  assert.ok(argv0.includes('--registry=https://registry.npmjs.org/'));
});

test('only vulnerabilities in batch-changed dependencies block when package.json changed', async () => {
  const change = [{ file: 'package.json', bytes: pkg({ lodash: '^4.0.0' }), previous: pkg({}) }];
  const audit = auditOnly(() => ({ stdout: JSON.stringify({ vulnerabilities: { lodash: { severity: 'high' }, unrelated: { severity: 'high' } } }) }));
  const gate = await runSecurityGate({ changes: change, exec: audit, fileExists: () => true, fetchImpl: registry(meta('MIT')), now: () => NOW });
  const names = gate.blocks.filter((b) => b.check === 'vulnerability').map((b) => b.message);
  assert.ok(names.some((m) => m.startsWith('lodash has')));
  assert.equal(names.some((m) => m.startsWith('unrelated')), false);
});

test('when only package-lock.json changed every high vulnerability blocks', async () => {
  const audit = auditOnly(() => ({ stdout: JSON.stringify({ vulnerabilities: { unrelated: { severity: 'critical' } } }) }));
  const gate = await runSecurityGate({ changes: LOCK, exec: audit, fetchImpl: noFetch, now: () => NOW });
  assert.ok(gate.blocks.some((b) => b.check === 'vulnerability' && b.message.startsWith('unrelated has')));
});

test('pip-audit argv has --no-deps and --disable-pip and an env without secrets', async () => {
  process.env.SG_TEST_FAKE_SECRET = 'fake-value-for-test';
  let opts0 = null;
  let argv0 = null;
  const exec = async (argv, opts) => {
    if (argv[0] === 'pip-audit') { argv0 = argv; opts0 = opts; return { stdout: '[]' }; }
    throw new Error('missing');
  };
  try {
    await runSecurityGate({ changes: [{ file: 'requirements.txt', bytes: Buffer.from('flask==2.0.0\n'), previous: null }], exec, fetchImpl: async () => jsonRes({}, 404), now: () => NOW });
    assert.ok(argv0.includes('--no-deps'));
    assert.ok(argv0.includes('--disable-pip'));
    const env = opts0.env || {};
    assert.equal('SG_TEST_FAKE_SECRET' in env, false);
    assert.equal(Object.values(env).includes('fake-value-for-test'), false);
  } finally {
    delete process.env.SG_TEST_FAKE_SECRET;
  }
});

test('copyleft license blocks unless allowed; unknown license only warns', async () => {
  const change = [{ file: 'package.json', bytes: pkg({ 'new-lib': '^1.0.0' }), previous: pkg({}) }];
  const gpl = registry(meta('GPL-3.0'));
  const blocked = await runSecurityGate({ changes: change, policy: { requireVulnerabilityScan: false }, exec: noExec, fetchImpl: gpl, now: () => NOW });
  assert.equal(blocked.ok, false);
  assert.ok(blocked.blocks.some((b) => b.check === 'license-check'));
  for (const policy of [{ allowCopyleft: true }, { approvedLicenses: ['GPL-3.0'] }]) {
    const ok = await runSecurityGate({ changes: change, policy: { ...policy, requireVulnerabilityScan: false }, exec: noExec, fetchImpl: gpl, now: () => NOW });
    assert.equal(ok.blocks.some((b) => b.check === 'license-check'), false);
  }
  const unknown = await runSecurityGate({ changes: change, policy: { requireVulnerabilityScan: false }, exec: noExec, fetchImpl: registry(meta(undefined)), now: () => NOW });
  assert.equal(unknown.ok, true);
  assert.ok(unknown.warnings.some((w) => w.includes('license unknown')));
});

test('registry license text is cleaned and cut in messages', async () => {
  const change = [{ file: 'package.json', bytes: pkg({ 'new-lib': '^1.0.0' }), previous: pkg({}) }];
  const long = 'GPL-3.0 <b>' + 'A'.repeat(300) + '</b>';
  const gate = await runSecurityGate({ changes: change, exec: noExec, fetchImpl: registry(meta(long)), now: () => NOW });
  const b = gate.blocks.find((x) => x.check === 'license-check');
  assert.ok(b);
  assert.equal(b.message.includes('<'), false);
  assert.equal(b.message.includes('>'), false);
  assert.ok(b.message.length < 250);
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

test('sensitive default true: semgrep is not run and skipped mentions sensitive', async () => {
  const calls = [];
  const exec = async (argv) => { calls.push(argv); throw new Error('missing'); };
  const gate = await runSecurityGate({ changes: [{ file: 'src/index.js', bytes: Buffer.from('export const n = 1;\n'), previous: null }], policy: { codeScan: 'auto' }, exec, fetchImpl: noFetch, now: () => NOW });
  assert.equal(calls.some((a) => a[0] === 'semgrep'), false);
  assert.ok(gate.skipped.some((s) => s.includes('sensitive')));
});

test('sensitive false: semgrep runs with --metrics=off and -- before a file named --autofix', async () => {
  let argv0 = null;
  const report = { results: [] };
  const exec = async (argv) => {
    if (argv[0] === 'semgrep' && argv[1] === '--version') return { stdout: '1.0.0' };
    if (argv[0] === 'semgrep') { argv0 = argv; return { stdout: JSON.stringify(report) }; }
    throw new Error('missing');
  };
  await runSecurityGate({ changes: [{ file: '--autofix', bytes: Buffer.from('export const n = 1;\n'), previous: null }], sensitive: false, exec, fetchImpl: noFetch, now: () => NOW });
  assert.ok(argv0.includes('--metrics=off'));
  const dd = argv0.indexOf('--');
  assert.ok(dd >= 0);
  assert.ok(argv0.indexOf('--autofix') > dd);
});

test('sensitive true with codeScan auto and codeScanSensitive true runs semgrep', async () => {
  let ran = false;
  const exec = async (argv) => {
    if (argv[0] === 'semgrep' && argv[1] === '--version') return { stdout: '1.0.0' };
    if (argv[0] === 'semgrep') { ran = true; return { stdout: JSON.stringify({ results: [] }) }; }
    throw new Error('missing');
  };
  await runSecurityGate({ changes: [{ file: 'src/index.js', bytes: Buffer.from('export const n = 1;\n'), previous: null }], policy: { codeScan: 'auto', codeScanSensitive: true }, sensitive: true, exec, fetchImpl: noFetch, now: () => NOW });
  assert.equal(ran, true);
});

test('semgrep finding makes a ticket without blocking; tickets have no message; missing tools are skipped', async () => {
  const report = { results: [{ check_id: 'demo.rule', path: 'src/index.js', start: { line: 1 }, extra: { severity: 'ERROR', message: 'bad' } }] };
  const exec = async (argv) => {
    if (argv[0] === 'semgrep' && argv[1] === '--version') return { stdout: '1.0.0' };
    if (argv[0] === 'semgrep') return { stdout: JSON.stringify(report) };
    throw new Error('missing');
  };
  const change = [{ file: 'src/index.js', bytes: Buffer.from('export const n = 1;\n'), previous: null }];
  const gate = await runSecurityGate({ changes: change, sensitive: false, exec, fetchImpl: noFetch, now: () => NOW });
  assert.equal(gate.ok, true);
  assert.equal(gate.tickets.length, 1);
  assert.equal('message' in gate.tickets[0], false);
  const none = await runSecurityGate({ changes: change, sensitive: false, exec: noExec, fetchImpl: noFetch, now: () => NOW });
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

test('normalizePolicy keeps requireVulnerabilityScan, codeScan and codeScanSensitive types', () => {
  const bad = normalizePolicy({ codeScan: 'always', requireVulnerabilityScan: 'no', codeScanSensitive: 'yes' });
  assert.equal(bad.codeScan, 'auto');
  assert.equal(bad.requireVulnerabilityScan, DEFAULT_POLICY.requireVulnerabilityScan);
  assert.equal(bad.codeScanSensitive, false);
  const good = normalizePolicy({ codeScan: 'off', requireVulnerabilityScan: false, codeScanSensitive: true });
  assert.equal(good.codeScan, 'off');
  assert.equal(good.requireVulnerabilityScan, false);
  assert.equal(good.codeScanSensitive, true);
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

test('lessonFor ids differ for two different jobs in one run and contain only safe characters', () => {
  const gate = { ok: false, blocks: [{ check: 'vulnerability', severity: 'high', message: 'x' }] };
  const a = lessonFor(gate, { runId: 'r1', date: '2025-01-01', jobs: ['job/one'] });
  const b = lessonFor(gate, { runId: 'r1', date: '2025-01-01', jobs: ['job/two'] });
  assert.notEqual(a.id, b.id);
  assert.match(a.id, /^[A-Za-z0-9._-]+$/);
  assert.match(b.id, /^[A-Za-z0-9._-]+$/);
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
