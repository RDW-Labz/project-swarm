// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  DEFAULT_PROFILE_BUDGET, detectProtectedPaths, normalizeProtectedPath, validateProfile,
  protectedPathHit, protectedViolations, runBaseChecks, formatBaseCheck, checkSetup,
} from '../tools/init-profile.mjs';

const NOW = Date.parse('2026-10-15T00:00:00Z');
const ISO = '2026-10-15T00:00:00.000Z';
const pick = (o, key, dflt) => (key in o ? o[key] : dflt);

function profile(over = {}) {
  return {
    stack: [{ name: 'node', packageManager: 'npm' }],
    sensitive: true,
    protectedPaths: ['.env'],
    budget: { maxUsd: 5, maxTokens: 2000000 },
    baseCheck: { status: 'green', ranAt: ISO, head: 'abc', checks: [{ name: 'test', ok: true, exitCode: 0, tail: '' }] },
    ...over,
  };
}
const withBase = over => profile({ baseCheck: { ...profile().baseCheck, ...over } });
const without = (obj, key) => { const copy = { ...obj }; delete copy[key]; return copy; };

async function withRoot(fn) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'init-profile-'));
  try { return await fn(root); } finally { await fs.rm(root, { recursive: true, force: true }); }
}

test('detectProtectedPaths returns sorted entries that exist', async () => {
  const files = ['.env', '.env.local', 'config/id_rsa', 'deploy/server.pem', 'keys/a.txt', 'private/x.txt', 'secrets/a.txt', 'src/app.js', 'web/credentials.json'];
  assert.deepEqual(await detectProtectedPaths('/r', { list: async () => files }), ['.env', '.env.local', 'config/id_rsa', 'deploy/server.pem', 'keys/', 'private/', 'secrets/', 'web/credentials.json']);
});

test('detectProtectedPaths caps the result at 50 entries', async () => {
  const files = Array.from({ length: 120 }, (_, i) => `k${i}.pem`);
  assert.equal((await detectProtectedPaths('/r', { list: async () => files })).length, 50);
});

test('normalizeProtectedPath cleans valid input', () => {
  assert.equal(normalizeProtectedPath(' ./.env '), '.env');
  assert.equal(normalizeProtectedPath('secrets/'), 'secrets/');
  assert.equal(normalizeProtectedPath('./config/app.json'), 'config/app.json');
  assert.equal(normalizeProtectedPath('x'.repeat(200)).length, 200);
});

test('normalizeProtectedPath refuses unsafe input', () => {
  const bad = ['', '   ', '/etc/passwd', '../x', 'a/../b', 'a\u0000b', 'a*', 'a?', 'a[1]', 'a{b}', 'a\\b', 'x'.repeat(201)];
  for (const value of bad) assert.throws(() => normalizeProtectedPath(value), /protected-path-invalid/, JSON.stringify(value));
});

test('validateProfile accepts a good profile and returns a copy', () => {
  const input = profile();
  const { profile: out, errors } = validateProfile(input);
  assert.deepEqual(errors, []);
  assert.notEqual(out, input);
  assert.deepEqual(out.protectedPaths, ['.env']);
});

test('validateProfile fills the default budget and removes duplicate paths', () => {
  assert.ok(Object.isFrozen(DEFAULT_PROFILE_BUDGET));
  const { profile: out, errors } = validateProfile({ ...without(profile(), 'budget'), protectedPaths: ['.env', '.env', './secrets/'] });
  assert.deepEqual(errors, []);
  assert.deepEqual(out.budget, DEFAULT_PROFILE_BUDGET);
  assert.deepEqual(out.protectedPaths, ['.env', 'secrets/']);
});

test('validateProfile rejects every invalid field', () => {
  const cases = {
    unknownKey: { ...profile(), extra: 1 },
    sensitiveType: profile({ sensitive: 'yes' }),
    unsafePath: profile({ protectedPaths: ['../x'] }),
    tooManyPaths: profile({ protectedPaths: Array.from({ length: 101 }, (_, i) => `p${i}/`) }),
    maxUsdZero: profile({ budget: { maxUsd: 0, maxTokens: 1 } }),
    maxUsdNaN: profile({ budget: { maxUsd: NaN, maxTokens: 1 } }),
    maxTokensFloat: profile({ budget: { maxUsd: 5, maxTokens: 1.5 } }),
    statusBogus: withBase({ status: 'bogus' }),
    tooManyChecks: withBase({ checks: Array.from({ length: 21 }, () => ({ name: 't', ok: true, exitCode: 0, tail: '' })) }),
    stackTooLong: profile({ stack: Array.from({ length: 11 }, () => ({ name: 'node' })) }),
  };
  for (const [name, bad] of Object.entries(cases)) assert.ok(validateProfile(bad).errors.length > 0, name);
});

test('validateProfile cuts and sanitizes baseCheck tails', () => {
  const tail = 'a'.repeat(900) + ' TOKEN=abcdef123456';
  const { profile: out, errors } = validateProfile(withBase({ checks: [{ name: 'test', ok: false, exitCode: 1, tail }] }));
  assert.deepEqual(errors, []);
  const got = out.baseCheck.checks[0].tail;
  assert.ok(got.length <= 500);
  assert.ok(!got.includes('abcdef123456'));
});

test('protectedPathHit matches folders, files and case differences', () => {
  const p = profile({ protectedPaths: ['secrets/', '.env', 'config/id_rsa', 'deploy/server.pem'] });
  assert.equal(protectedPathHit(p, 'secrets/a/b.txt'), 'secrets/');
  assert.equal(protectedPathHit(p, 'secrets'), 'secrets/');
  assert.equal(protectedPathHit(p, 'SECRETS/A.txt'), 'secrets/');
  assert.equal(protectedPathHit(p, 'secretsx/a'), null);
  assert.equal(protectedPathHit(p, '.env'), '.env');
  assert.equal(protectedPathHit(p, '.env.local'), null);
  assert.equal(protectedPathHit(p, 'config/id_rsa'), 'config/id_rsa');
  assert.equal(protectedPathHit(p, 'deploy/server.pem.bak'), null);
});

test('protectedPathHit always protects .git and .swarm', () => {
  const none = profile({ protectedPaths: [] });
  assert.equal(protectedPathHit(none, '.git/config'), '.git/');
  assert.equal(protectedPathHit(none, '.swarm/project/journal.ndjson'), '.swarm/');
  assert.equal(protectedPathHit(none, 'src/a.js'), null);
});

test('protectedViolations reports protected outputs and deletes', () => {
  const p = profile({ protectedPaths: ['.env', 'secrets/'] });
  const jobs = [
    { id: 'j1', outputs: ['src/a.js', '.env'], deletes: ['secrets/x'] },
    { id: 'j2', outputs: ['ok.js'] },
  ];
  assert.deepEqual(protectedViolations(p, jobs), [
    { job: 'j1', path: '.env', entry: '.env', kind: 'output' },
    { job: 'j1', path: 'secrets/x', entry: 'secrets/', kind: 'deletes' },
  ]);
});

const okRun = async () => ({ exitCode: 0, stdout: 'ok', stderr: '' });
const CHECKS = [{ name: 'test', argv: ['npm', 'test'] }, { name: 'lint', argv: ['npm', 'run', 'lint'] }];

test('runBaseChecks with no checks is none', async () => {
  const r = await runBaseChecks('/r', [], { run: okRun, head: 'abc', now: () => NOW });
  assert.deepEqual(r, { status: 'none', ranAt: ISO, head: 'abc', checks: [] });
});

test('runBaseChecks is green when every check passes', async () => {
  const r = await runBaseChecks('/r', CHECKS, { run: okRun, head: 'abc', now: () => NOW });
  assert.equal(r.status, 'green');
  assert.equal(r.checks.length, 2);
  assert.ok(r.checks.every(c => c.ok === true && c.exitCode === 0));
});

test('runBaseChecks is red when a check fails, with stderr in the tail', async () => {
  const run = async argv => (argv[1] === 'run' ? { exitCode: 1, stdout: '', stderr: 'boom' } : okRun());
  const r = await runBaseChecks('/r', CHECKS, { run, head: 'abc', now: () => NOW });
  assert.equal(r.status, 'red');
  assert.equal(r.checks[1].ok, false);
  assert.equal(r.checks[1].exitCode, 1);
  assert.ok(r.checks[1].tail.includes('boom'));
});

test('runBaseChecks counts a rejection or timeout as a failed check', async () => {
  const run = async () => { throw new Error('timed out'); };
  const r = await runBaseChecks('/r', CHECKS.slice(0, 1), { run, head: 'abc', now: () => NOW });
  assert.equal(r.status, 'red');
  assert.equal(r.checks[0].exitCode, null);
  assert.ok(r.checks[0].tail.includes('timed out'));
});

test('runBaseChecks runs one at a time with cwd and timeout', async () => {
  let active = 0;
  let peak = 0;
  const seen = [];
  const run = async (argv, opts) => {
    active++;
    peak = Math.max(peak, active);
    seen.push(opts);
    await new Promise(resolve => setTimeout(resolve, 2));
    active--;
    return { exitCode: 0, stdout: '', stderr: '' };
  };
  await runBaseChecks('/r', CHECKS, { run, head: 'abc', now: () => NOW });
  assert.equal(peak, 1);
  assert.equal(seen[0].cwd, '/r');
  assert.equal(seen[0].timeoutMs, 300000);
  await runBaseChecks('/r', CHECKS, { run, head: 'abc', now: () => NOW, timeoutMs: 1234 });
  assert.equal(seen.at(-1).timeoutMs, 1234);
});

test('runBaseChecks runs at most 10 checks', async () => {
  const many = Array.from({ length: 12 }, (_, i) => ({ name: `c${i}`, argv: ['true'] }));
  let calls = 0;
  const run = async () => { calls++; return { exitCode: 0, stdout: '', stderr: '' }; };
  const r = await runBaseChecks('/r', many, { run, head: 'abc', now: () => NOW });
  assert.ok(calls <= 10);
  assert.equal(r.checks.length, calls);
});

test('runBaseChecks keeps the tail to 500 characters', async () => {
  const run = async () => ({ exitCode: 1, stdout: 'x'.repeat(1000), stderr: '' });
  const r = await runBaseChecks('/r', CHECKS.slice(0, 1), { run, head: 'abc', now: () => NOW });
  assert.ok(r.checks[0].tail.length <= 500);
});

test('formatBaseCheck writes one short line per state', () => {
  const green = formatBaseCheck({ status: 'green', ranAt: ISO, checks: [{ ok: true }, { ok: true }] });
  assert.match(green, /^Base checks: green \(2 checks, 2026-10-15T/);
  const red = formatBaseCheck({ status: 'red', ranAt: ISO, checks: [{ name: 'test', ok: false }, { name: 'lint', ok: false }, { name: 'build', ok: true }] });
  assert.equal(red, 'Base checks: RED, already failing before any change: test, lint');
  assert.equal(formatBaseCheck({ status: 'skipped', ranAt: null, checks: [] }), 'Base checks: not run');
  assert.equal(formatBaseCheck({ status: 'none', ranAt: null, checks: [] }), 'Base checks: none defined');
});

async function writeSetup(root, o = {}) {
  const files = {
    '.project-swarm.json': pick(o, 'pointer', JSON.stringify({ version: '1.0.0', profile: profile() })),
    'coordination/checks.json': pick(o, 'checks', JSON.stringify({ checks: [{ name: 'test', argv: ['npm', 'test'] }] })),
    '.gitignore': pick(o, 'gitignore', '.swarm/\nnode_modules/\n'),
    'AGENTS.md': pick(o, 'agents', 'Run swarm brief first.\n'),
    'CLAUDE.md': pick(o, 'claude', 'Run swarm brief first.\n'),
  };
  for (const [name, text] of Object.entries(files)) {
    if (text === null) continue;
    await fs.mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await fs.writeFile(path.join(root, name), text);
  }
}

function deps(root, o = {}) {
  const at = name => path.join(root, name);
  return {
    readJson: async name => JSON.parse(await fs.readFile(at(name), 'utf8')),
    exists: async name => fs.access(at(name)).then(() => true, () => false),
    stat: async name => fs.stat(at(name)),
    head: async () => pick(o, 'head', 'abc'),
    installVersion: '1.0.0',
    readMap: async () => pick(o, 'map', { head: 'abc' }),
    readProfile: async () => pick(o, 'profile', profile()),
    now: () => NOW,
  };
}
const run = (root, o) => checkSetup(root, deps(root, o));
const byId = (res, id) => res.items.filter(i => i.id === id);

test('checkSetup reports a healthy setup with no failures', async () => withRoot(async root => {
  await writeSetup(root);
  const res = await run(root);
  assert.equal(res.ok, true);
  assert.deepEqual(res.items.map(i => i.id), ['pointer', 'version', 'profile', 'checks', 'base', 'map', 'ignore', 'pointers', 'protected']);
  assert.ok(res.items.filter(i => i.id !== 'protected').every(i => i.level === 'ok'), JSON.stringify(res.items));
}));

test('a missing or unparsable pointer fails', async () => {
  for (const pointer of [null, '{']) {
    await withRoot(async root => {
      await writeSetup(root, { pointer });
      const res = await run(root);
      assert.equal(res.ok, false);
      assert.equal(byId(res, 'pointer')[0].level, 'fail');
    });
  }
});

test('a different installed version warns without failing', async () => withRoot(async root => {
  await writeSetup(root, { pointer: JSON.stringify({ version: '0.9.0', profile: profile() }) });
  const res = await run(root);
  assert.equal(byId(res, 'version')[0].level, 'warn');
  assert.equal(res.ok, true);
}));

test('a missing profile key warns and an invalid one fails', async () => {
  await withRoot(async root => {
    const p = without(profile(), 'protectedPaths');
    await writeSetup(root, { pointer: JSON.stringify({ version: '1.0.0', profile: p }) });
    const res = await run(root, { profile: p });
    assert.ok(byId(res, 'profile').some(i => i.level === 'warn' && i.message.includes('protectedPaths')));
    assert.equal(res.ok, true);
  });
  await withRoot(async root => {
    const p = profile({ sensitive: 'yes' });
    await writeSetup(root, { pointer: JSON.stringify({ version: '1.0.0', profile: p }) });
    const res = await run(root, { profile: p });
    assert.ok(byId(res, 'profile').some(i => i.level === 'fail'));
    assert.equal(res.ok, false);
  });
});

test('missing or empty coordination checks warn', async () => {
  for (const checks of [null, JSON.stringify({ checks: [] })]) {
    await withRoot(async root => {
      await writeSetup(root, { checks });
      assert.equal(byId(await run(root), 'checks')[0].level, 'warn');
    });
  }
});

test('base warns for red, unchecked, or stale-head baselines', async () => {
  const red = withBase({ status: 'red', checks: [{ name: 'test', ok: false, exitCode: 1, tail: '' }] });
  await withRoot(async root => {
    await writeSetup(root, { pointer: JSON.stringify({ version: '1.0.0', profile: red }) });
    const item = byId(await run(root, { profile: red }), 'base')[0];
    assert.equal(item.level, 'warn');
    assert.ok(item.message.includes('test'));
  });
  for (const status of ['none', 'skipped']) {
    await withRoot(async root => {
      const p = withBase({ status, checks: [] });
      await writeSetup(root, { pointer: JSON.stringify({ version: '1.0.0', profile: p }) });
      assert.equal(byId(await run(root, { profile: p }), 'base')[0].level, 'warn');
    });
  }
  await withRoot(async root => {
    await writeSetup(root);
    assert.equal(byId(await run(root, { head: 'zzz' }), 'base')[0].level, 'warn');
  });
});

test('a stale or missing repo map warns', async () => {
  for (const map of [{ head: 'old' }, null]) {
    await withRoot(async root => {
      await writeSetup(root);
      assert.equal(byId(await run(root, { map }), 'map')[0].level, 'warn');
    });
  }
});

test('missing .swarm ignore or swarm brief pointers warn', async () => {
  await withRoot(async root => {
    await writeSetup(root, { gitignore: 'node_modules/\n' });
    assert.equal(byId(await run(root), 'ignore')[0].level, 'warn');
  });
  await withRoot(async root => {
    await writeSetup(root, { agents: null, claude: 'Read the docs.\n' });
    assert.equal(byId(await run(root), 'pointers')[0].level, 'warn');
  });
});

test('protected entries never fail', async () => withRoot(async root => {
  const p = profile({ protectedPaths: ['.env', 'secrets/', 'missing/key.pem'] });
  await writeSetup(root, { pointer: JSON.stringify({ version: '1.0.0', profile: p }) });
  const res = await run(root, { profile: p });
  assert.notEqual(byId(res, 'protected')[0].level, 'fail');
  assert.equal(res.ok, true);
}));

test('every message is one line under 160 characters', async () => withRoot(async root => {
  await writeSetup(root, { pointer: '{', checks: null, gitignore: '', agents: null, claude: null });
  const res = await run(root, {
    head: 'zzz',
    map: null,
    profile: withBase({ status: 'red', checks: [{ name: 'test', ok: false, exitCode: 1, tail: '' }] }),
  });
  for (const item of res.items) {
    assert.ok(!item.message.includes('\n'), item.id);
    assert.ok(item.message.length < 160, item.id);
  }
  assert.equal(res.ok, false);
}));

test('checkSetup writes nothing', async () => withRoot(async root => {
  await writeSetup(root, { checks: null });
  const before = await fs.readdir(root, { recursive: true });
  await checkSetup(root, deps(root));
  assert.deepEqual(await fs.readdir(root, { recursive: true }), before);
}));
