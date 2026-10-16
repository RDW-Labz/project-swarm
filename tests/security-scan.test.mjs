// SPDX-License-Identifier: Apache-2.0
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { scanSecrets, scanSecretsDetailed, shannonEntropy, parseNpmAudit, parseOsv, parsePipAudit, blockingVulns, parseSemgrep, licenseBlocked } from '../tools/security-scan.mjs';

const AWS = 'AK' + 'IA' + 'ABCDEFGHIJKLMNOP';
const GH = 'gh' + 'p_' + 'b'.repeat(36);
const STRIPE = 'sk_' + 'live_' + 'a'.repeat(24);
const SLACK = 'xox' + 'b-' + '1234567890-abcdefghij';
const GOOGLE = 'AI' + 'za' + 'x'.repeat(35);
const ANTH = 'sk-' + 'ant-' + 'a'.repeat(30);
const OAI = 'sk-' + 'proj-' + 'a'.repeat(30);
const FINE = 'github_' + 'pat_' + 'a'.repeat(30);
const GLPAT = 'glpat-' + 'a'.repeat(20);
const NPM = 'npm_' + 'A1'.repeat(18);
const PKEY = '-----BEGIN ' + 'RSA PRIVATE KEY-----';
const URL = 'postgres://user:' + 'S3cretPass99' + '@db.example.com/app';
const GEN = 'Xk3mQ9pL2sR7vN4tB8wY1zD6cF0hJ5gK';
const JWT = 'eyJ' + 'hbGciOiJIUzI1NiJ9' + '.' + 'eyJ' + 'zdWIiOiIxMjM0NTY3ODkwIn0' + '.' + 'dozjgNryP4J3jVmNHl0w5N';
const NL = String.fromCharCode(10);
const NUL = String.fromCharCode(0);
const one = (line) => scanSecrets([{ path: 'src/a.js', content: line }]);
const assign = (v) => `const s = '${v}';`;

const cases = [
  ['aws-access-key-id', AWS, assign(AWS)],
  ['github-token', GH, assign(GH)],
  ['stripe-live-key', STRIPE, assign(STRIPE)],
  ['slack-token', SLACK, assign(SLACK)],
  ['google-api-key', GOOGLE, assign(GOOGLE)],
  ['anthropic-key', ANTH, assign(ANTH)],
  ['openai-project-key', OAI, assign(OAI)],
  ['github-fine-grained-token', FINE, assign(FINE)],
  ['gitlab-token', GLPAT, assign(GLPAT)],
  ['npm-token', NPM, assign(NPM)],
  ['private-key-block', PKEY, assign(PKEY)],
  ['url-password', URL, assign(URL)],
  ['generic-secret', GEN, `const apiKey = '${GEN}';`],
  ['jwt', JWT, assign(JWT)]
];

test('scanSecrets reports each planted secret without echoing it', () => {
  for (const [rule, value, line] of cases) {
    const f = one(line);
    const hit = f.find((x) => x.rule === rule);
    assert.ok(hit, rule);
    assert.equal(hit.path, 'src/a.js');
    assert.equal(hit.line, 1);
    assert.ok(hit.name);
    assert.match(hit.fingerprint, /^[0-9a-f]{12}$/);
    const json = JSON.stringify(f);
    assert.ok(!json.includes(value), rule);
    assert.ok(!json.includes(value.slice(0, 8)), rule);
  }
});

test('placeholder url, example generic and low entropy values are not reported', () => {
  const lines = [
    `const u = 'postgres://user:changeme@db.example.com/app';`,
    `const apiKey = 'example-Xk3mQ9pL2sR7vN4tB8wY1zD6c';`,
    `const apiKey = 'aaaaaaaaaaaaaaaaaaaaaaaa';`
  ];
  assert.deepEqual(scanSecrets(lines.map((content) => ({ path: 'src/a.js', content }))), []);
});

test('swarm-secret-allow suppresses only a line already present in previous', () => {
  const line = assign(GH) + ' // swarm-secret-allow';
  assert.deepEqual(scanSecrets([{ path: 'src/a.js', content: line }], { previous: { 'src/a.js': line } }), []);
  assert.equal(one(line).length, 1);
  assert.equal(scanSecrets([{ path: 'src/a.js', content: line }], { previous: { 'src/a.js': 'const x = 1;' } }).length, 1);
});

test('allowed fingerprint suppresses a finding', () => {
  const [hit] = one(assign(GH));
  assert.deepEqual(scanSecrets([{ path: 'src/a.js', content: assign(GH) }], { allowFingerprints: [hit.fingerprint] }), []);
});

test('NUL bytes become line breaks so a secret followed by NUL is still found', () => {
  assert.ok(one(assign(GH) + NUL + 'tail').some((x) => x.rule === 'github-token'));
  assert.equal(one(NUL + assign(GH))[0].line, 2);
});

test('binary files are scanned, not dropped', () => {
  const buf = Buffer.from(NUL + String.fromCharCode(1, 2) + assign(GH), 'latin1');
  assert.ok(scanSecrets([{ path: 'bin/x.dat', content: buf }]).some((x) => x.rule === 'github-token'));
});

test('UTF-16 content with a byte order mark is scanned decoded', () => {
  const buf = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(assign(GH), 'utf16le')]);
  assert.ok(scanSecrets([{ path: 'src/w.js', content: buf }]).some((x) => x.rule === 'github-token'));
});

test('a secret after maxBytes is found by scanning in windows', () => {
  const content = 'x'.repeat(8600) + NL + assign(GH);
  const { findings, skipped } = scanSecretsDetailed([{ path: 'src/big.js', content }], { maxBytes: 8192 });
  assert.equal(skipped.length, 0);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].line, 2);
});

test('only a file beyond 20 windows is listed as too large to scan', () => {
  const r = scanSecretsDetailed([{ path: 'big.txt', content: 'x'.repeat(90000) }], { maxBytes: 8192 });
  assert.deepEqual(r.skipped, [{ path: 'big.txt', reason: 'too large to scan' }]);
  assert.deepEqual(r.findings, []);
  assert.equal(scanSecretsDetailed([{ path: 'ok.txt', content: 'x'.repeat(86000) }], { maxBytes: 8192 }).skipped.length, 0);
});

test('keyed fingerprint is an HMAC that differs from unkeyed and from another key', () => {
  const plain = one(assign(GH))[0].fingerprint;
  const k1 = scanSecrets([{ path: 'src/a.js', content: assign(GH) }], { key: 'key-one' })[0].fingerprint;
  const k2 = scanSecrets([{ path: 'src/a.js', content: assign(GH) }], { key: 'key-two' })[0].fingerprint;
  assert.match(k1, /^[0-9a-f]{12}$/);
  assert.notEqual(k1, plain);
  assert.notEqual(k1, k2);
});

test('pathological long lines scan in linear time (4x the input is under 8x the time)', () => {
  const time = (unit, bytes) => { const content = unit.repeat(bytes / unit.length); let best = Infinity; for (let n = 0; n < 3; n += 1) { const t0 = performance.now(); scanSecrets([{ path: 'big.txt', content }]); best = Math.min(best, performance.now() - t0); } return best; };
  for (const unit of ['a.', 'eyJ-']) {
    const small = Math.max(time(unit, 256 * 1024), 5);
    const large = time(unit, 1024 * 1024);
    assert.ok(large < small * 8, unit + ': ' + small.toFixed(0) + ' ms vs ' + large.toFixed(0) + ' ms');
    assert.ok(large < 30000, unit);
  }
});

test('new rules find openai project, github fine-grained, gitlab and npm tokens', () => {
  for (const [rule, value] of [['openai-project-key', OAI], ['github-fine-grained-token', FINE], ['gitlab-token', GLPAT], ['npm-token', NPM]]) {
    assert.ok(one(assign(value)).some((x) => x.rule === rule), rule);
  }
});

test('unquoted env secret line is found', () => {
  assert.ok(one('API_KEY=' + GEN).some((x) => x.rule === 'env-secret'));
});

test('two different secrets on one line give two findings', () => {
  const f = one(assign(GH) + ' ' + assign(STRIPE));
  assert.deepEqual(f.map((x) => x.rule).sort(), ['github-token', 'stripe-live-key']);
});

test('an allowlisted first match does not hide a second secret', () => {
  const line = assign(GH) + ' ' + assign(STRIPE);
  const gh = one(assign(GH))[0].fingerprint;
  const f = scanSecrets([{ path: 'src/a.js', content: line }], { allowFingerprints: [gh] });
  assert.deepEqual(f.map((x) => x.rule), ['stripe-live-key']);
});

test('at most 3 findings per rule per file, with 1-based lines', () => {
  const content = ['const a = 1;', assign(GH), assign(GH), assign(GH), assign(GH)].join(NL);
  const f = one(content);
  assert.equal(f.length, 3);
  assert.deepEqual(f.map((x) => x.line), [2, 3, 4]);
});

test('shannonEntropy returns 0 for repeated text and 2 for four distinct characters', () => {
  assert.equal(shannonEntropy('aaaa'), 0);
  assert.equal(shannonEntropy('abcd'), 2);
});

test('parseNpmAudit reads npm 7 and npm 6 shapes and JSON strings', () => {
  const v7 = { vulnerabilities: { lodash: { severity: 'high' }, minimist: { severity: 'low' } } };
  assert.deepEqual(parseNpmAudit(v7).map((v) => [v.name, v.severity]), [['lodash', 'high'], ['minimist', 'low']]);
  const r6 = parseNpmAudit({ advisories: { 1: { module_name: 'lodash', severity: 'critical' } } });
  assert.deepEqual(r6.map((v) => [v.name, v.severity]), [['lodash', 'critical']]);
  assert.equal(parseNpmAudit(JSON.stringify(v7)).length, 2);
  assert.deepEqual(parseNpmAudit('not json'), []);
});

test('moderate severity maps to medium in npm and osv parsers', () => {
  assert.equal(parseNpmAudit({ vulnerabilities: { x: { severity: 'moderate' } } })[0].severity, 'medium');
  const osv = { results: [{ packages: [{ package: { name: 'p' }, vulnerabilities: [{ id: 'C', database_specific: { severity: 'MODERATE' } }] }] }] };
  assert.equal(parseOsv(osv)[0].severity, 'medium');
});

test('blockingVulns keeps high and critical by default and honours a custom list', () => {
  const v = [{ severity: 'high' }, { severity: 'critical' }, { severity: 'low' }, { severity: 'medium' }];
  assert.equal(blockingVulns(v).length, 2);
  assert.deepEqual(blockingVulns(v, ['low']), [{ severity: 'low' }]);
});

test('parseOsv uses database_specific severity or defaults to high', () => {
  const osv = { results: [{ packages: [{ package: { name: 'left-pad' }, vulnerabilities: [{ id: 'A', database_specific: { severity: 'CRITICAL' } }, { id: 'B' }] }] }] };
  assert.deepEqual(parseOsv(osv).map((v) => [v.id, v.severity]), [['A', 'critical'], ['B', 'high']]);
});

test('parsePipAudit handles object and bare array shapes', () => {
  const dep = { name: 'requests', vulns: [{ id: 'PYSEC-1' }] };
  assert.deepEqual(parsePipAudit({ dependencies: [dep] }), [{ name: 'requests', severity: 'high', id: 'PYSEC-1', source: 'pip-audit' }]);
  assert.equal(parsePipAudit([dep]).length, 1);
});

test('parseSemgrep maps severities and returns no message property', () => {
  const res = (s, m) => ({ check_id: 'r', path: 'p.js', start: { line: 3 }, extra: { severity: s, message: m } });
  const out = parseSemgrep({ results: [res('ERROR', 'e'), res('WARNING', 'w'), res('INFO', 'x'.repeat(300))] });
  assert.deepEqual(out.map((x) => x.severity), ['high', 'medium', 'low']);
  for (const x of out) assert.equal('message' in x, false);
});

test('licenseBlocked applies the copyleft policy', () => {
  for (const e of ['GPL-3.0', 'AGPL-3.0-only', 'GPL-2.0-or-later', '(GPL-3.0 AND MIT)']) assert.equal(licenseBlocked(e), true, e);
  for (const e of ['LGPL-2.1', 'MIT', '(MIT OR GPL-3.0)']) assert.equal(licenseBlocked(e), false, e);
  assert.equal(licenseBlocked('GPL-3.0', { approved: ['GPL-3.0'] }), false);
  assert.equal(licenseBlocked('GPL-3.0', { allowCopyleft: true }), false);
  assert.equal(licenseBlocked(''), false);
  assert.equal(licenseBlocked(undefined), false);
});

test('licenseBlocked judges compound and named expressions by meaning and never throws', () => {
  for (const e of ['(MIT OR GPL-3.0) AND GPL-3.0', 'GPL-3.0 WITH Classpath-exception-2.0', 'GNU Affero General Public License v3']) assert.equal(licenseBlocked(e), true, e);
  for (const e of ['(MIT OR GPL-3.0)', 'LGPL-3.0-or-later', 'GNU Lesser General Public License']) assert.equal(licenseBlocked(e), false, e);
  assert.doesNotThrow(() => licenseBlocked('(('));
  assert.equal(licenseBlocked('(('), false);
});
