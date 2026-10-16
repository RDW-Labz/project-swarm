// SPDX-License-Identifier: Apache-2.0
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scanSecrets, shannonEntropy, parseNpmAudit, parseOsv, parsePipAudit, blockingVulns, parseSemgrep, licenseBlocked } from '../tools/security-scan.mjs';

const AWS = 'AK' + 'IA' + 'ABCDEFGHIJKLMNOP';
const GH = 'gh' + 'p_' + 'b'.repeat(36);
const STRIPE = 'sk_' + 'live_' + 'a'.repeat(24);
const SLACK = 'xox' + 'b-' + '1234567890-abcdefghij';
const GOOGLE = 'AI' + 'za' + 'x'.repeat(35);
const ANTH = 'sk-' + 'ant-' + 'a'.repeat(30);
const PKEY = '-----BEGIN ' + 'RSA PRIVATE KEY-----';
const URL = 'postgres://user:' + 'S3cretPass99' + '@db.example.com/app';
const GEN = 'Xk3mQ9pL2sR7vN4tB8wY1zD6cF0hJ5gK';
const JWT = 'eyJ' + 'hbGciOiJIUzI1NiJ9' + '.' + 'eyJ' + 'zdWIiOiIxMjM0NTY3ODkwIn0' + '.' + 'dozjgNryP4J3jVmNHl0w5N';
const one = (line) => scanSecrets([{ path: 'src/a.js', content: line }]);
const assign = (v) => 'const s = \'' + v + '\';';

const cases = [
  ['aws-access-key-id', AWS, assign(AWS)],
  ['github-token', GH, assign(GH)],
  ['stripe-live-key', STRIPE, assign(STRIPE)],
  ['slack-token', SLACK, assign(SLACK)],
  ['google-api-key', GOOGLE, assign(GOOGLE)],
  ['anthropic-key', ANTH, assign(ANTH)],
  ['private-key-block', PKEY, assign(PKEY)],
  ['url-password', URL, assign(URL)],
  ['generic-secret', GEN, 'const apiKey = \'' + GEN + '\';'],
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
    'const u = \'postgres://user:changeme@db.example.com/app\';',
    'const apiKey = \'example-Xk3mQ9pL2sR7vN4tB8wY1zD6c\';',
    'const apiKey = \'aaaaaaaaaaaaaaaaaaaaaaaa\';'
  ];
  assert.deepEqual(scanSecrets(lines.map((content) => ({ path: 'src/a.js', content }))), []);
});

test('swarm-secret-allow marker suppresses a finding', () => {
  assert.deepEqual(one(assign(GH) + ' // swarm-secret-allow'), []);
});

test('allowed fingerprint suppresses a finding', () => {
  const [hit] = one(assign(GH));
  assert.deepEqual(scanSecrets([{ path: 'src/a.js', content: assign(GH) }], { allowFingerprints: [hit.fingerprint] }), []);
});

test('files with NUL bytes or above maxBytes are skipped', () => {
  assert.deepEqual(one('\u0000' + assign(GH)), []);
  assert.deepEqual(scanSecrets([{ path: 'src/a.js', content: assign(GH) }], { maxBytes: 10 }), []);
});

test('at most 3 findings per rule per file, with 1-based lines', () => {
  const content = ['const a = 1;', assign(GH), assign(GH), assign(GH), assign(GH)].join('\n');
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

test('parseSemgrep maps severities and cuts long messages to 200 characters', () => {
  const res = (s, m) => ({ check_id: 'r', path: 'p.js', start: { line: 3 }, extra: { severity: s, message: m } });
  const out = parseSemgrep({ results: [res('ERROR', 'e'), res('WARNING', 'w'), res('INFO', 'i')] });
  assert.deepEqual(out.map((x) => x.severity), ['high', 'medium', 'low']);
  assert.equal(parseSemgrep({ results: [res('INFO', 'x'.repeat(300))] })[0].message.length, 200);
});

test('licenseBlocked applies the copyleft policy', () => {
  for (const e of ['GPL-3.0', 'AGPL-3.0-only', 'GPL-2.0-or-later', '(GPL-3.0 AND MIT)']) assert.equal(licenseBlocked(e), true, e);
  for (const e of ['LGPL-2.1', 'MIT', '(MIT OR GPL-3.0)']) assert.equal(licenseBlocked(e), false, e);
  assert.equal(licenseBlocked('GPL-3.0', { approved: ['GPL-3.0'] }), false);
  assert.equal(licenseBlocked('GPL-3.0', { allowCopyleft: true }), false);
  assert.equal(licenseBlocked(''), false);
  assert.equal(licenseBlocked(undefined), false);
});
