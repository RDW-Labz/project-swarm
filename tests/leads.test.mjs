// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { LEAD_LIMITS, validateLeadArea, inScope, scopesOverlap, validateParentLeads, validateChildManifest, leadPromptBlock, leadRollup } from '../tools/leads.mjs';

const lead = (area = {}, fields = {}) => ({ id: 'lead', type: 'lead', agent: 'codex', outputs: ['child.json'], area: { goal: 'Build the area', scope: ['app/', 'index.js'], ...area }, ...fields });
const worker = fields => ({ id: 'worker', agent: 'codex', prompt: 'Build it', outputs: ['app/result.js'], ...fields });
const child = fields => ({ version: 1, jobs: [worker()], ...fields });
const options = (area = {}, fields = {}) => ({ lead: lead(), area: validateLeadArea(lead(area)), parentManifest: {}, ...fields });
const rejects = (fn, code, text = '') => assert.throws(fn, err => err.code === code && err.message.startsWith(`${code}:`) && err.message.includes(text));

test('area normalization, limits, and independent copies', () => {
  assert.ok(Object.isFrozen(LEAD_LIMITS));
  const job = lead();
  const area = validateLeadArea(job);
  assert.deepEqual(area, { goal: 'Build the area', scope: ['app/', 'index.js'], maxJobs: 50, concurrency: 8, agents: ['auto', 'codex'], budget: {} });
  area.scope.push('else/');
  assert.equal(job.area.scope.length, 2);
  assert.deepEqual(validateLeadArea(lead({}, { agent: 'auto' })).agents, ['auto']);
  assert.deepEqual(validateLeadArea(lead({ maxJobs: 500, concurrency: 64, agents: ['claude'], budget: { maxUsd: 0.1, maxTokens: 1 } })).budget, { maxUsd: 0.1, maxTokens: 1 });
});

for (const scope of ['', '/app/', 'C:/app/', '../app/', 'app/../x', 'app..x', 'app/*', 'app/?', 'app/[a]', 'app\\x', './app/', '.git/', '.git/config', '.swarm/state', '.env', '.env.local', '.env/secret', 'app/./x', 'app//x', 'app/\nfile']) {
  test(`area refuses scope ${JSON.stringify(scope)}`, () => rejects(() => validateLeadArea(lead({ scope: [scope] })), 'lead-area-invalid', 'Job lead:'));
}
for (const area of [null, [], { extra: true }, { goal: '' }, { goal: ' ' }, { goal: 'x'.repeat(2001) }, { scope: [] }, { scope: Array(51).fill('app/') }, { scope: [null] }, { maxJobs: 0 }, { maxJobs: 501 }, { maxJobs: 1.5 }, { concurrency: 0 }, { concurrency: 65 }, { concurrency: null }, { agents: [] }, { agents: ['unknown'] }, { agents: 'codex' }, { budget: null }, { budget: { other: 1 } }, { budget: { maxUsd: 0 } }, { budget: { maxUsd: Infinity } }, { budget: { maxTokens: 1.5 } }, { budget: { maxTokens: -1 } }]) {
  test(`area refuses invalid fields ${JSON.stringify(area)}`, () => {
    const job = area === null || Array.isArray(area) ? lead({}, { area }) : lead(area);
    rejects(() => validateLeadArea(job), 'lead-area-invalid');
  });
}
for (const outputs of [[], ['a.json', 'b.json'], ['a.txt'], ['app/child.json'], [null]]) {
  test(`area refuses outputs ${JSON.stringify(outputs)}`, () => rejects(() => validateLeadArea(lead({}, { outputs })), 'lead-area-invalid'));
}

test('scope matching respects file and directory boundaries', () => {
  for (const file of ['app/a.js', 'app/nested/b.js', 'index.js']) assert.ok(inScope(file, ['app/', 'index.js']));
  for (const file of ['apple/a.js', 'app', 'index.js/a', 'app/../secret']) assert.equal(inScope(file, ['app/', 'index.js']), false);
  for (const [a, b] of [[['app/'], ['app/nested/']], [['app/a'], ['app/']], [['a'], ['a']]]) {
    assert.ok(scopesOverlap(a, b));
    assert.ok(scopesOverlap(b, a));
  }
  assert.equal(scopesOverlap(['app/a'], ['app/ab']), false);
  assert.equal(scopesOverlap(['app/'], ['apple/']), false);
});

test('parent rejects lead and worker scope overlap with exact errors', () => {
  rejects(() => validateParentLeads({ jobs: [lead(), lead({ scope: ['app/nested/'] }, { id: 'other' })] }), 'lead-scope-overlap', 'lead and other');
  rejects(() => validateParentLeads({ jobs: [lead(), worker()] }), 'lead-scope-overlap', 'job worker output app/result.js is inside lead lead');
  assert.doesNotThrow(() => validateParentLeads({ jobs: [lead(), lead({ scope: ['other/'] }, { id: 'other' }), worker({ outputs: ['safe.txt'] })] }));
});

for (const key of ['checks', 'preChecks', 'mutants', 'mutantCheck', 'idle', 'ledger', 'lanes', 'skillsDir', 'resources', 'allowEmptyContext', 'unknown']) {
  test(`child refuses top-level ${key}`, () => rejects(() => validateChildManifest(child({ [key]: [] }), options()), 'lead-child-invalid', key));
}
for (const key of ['shell', 'setup', 'testEnv', 'networkAllow', 'loopbackAllow', 'web', 'readPaths', 'resources', 'skills', 'privateData', 'creditPreflight', 'maxCredits', 'scope', 'outputDirs', 'area', 'unknown']) {
  test(`child refuses job ${key}`, () => rejects(() => validateChildManifest(child({ jobs: [worker({ [key]: true })] }), options()), 'lead-child-invalid', key));
}
for (const [fields, reason] of [[{ type: 'lead' }, 'depth limit 2: child jobs cannot be leads'], [{ sensitive: false }, 'sensitive: false'], [{ outputs: ['outside.txt'] }, 'outside scope'], [{ deletes: ['outside.txt'] }, 'outside scope'], [{ agent: 'ollama' }, 'agent ollama'], [{ tier: 'expensive' }, 'expensive tier'], [{ outputs: ['app/../secret'] }, 'outside scope']]) {
  test(`child rule ${reason} ${JSON.stringify(fields)}`, () => rejects(() => validateChildManifest(child({ jobs: [worker(fields)] }), options()), 'lead-child-invalid', reason));
}
test('child rejects shape, count, concurrency and budget violations', () => {
  for (const value of [null, [], child({ version: 2 }), child({ jobs: [] }), child({ jobs: [null] }), child({ concurrency: 0 }), child({ concurrency: 1.5 }), child({ budget: { maxUsd: -1 } })]) rejects(() => validateChildManifest(value, options()), 'lead-child-invalid');
  rejects(() => validateChildManifest(child({ jobs: [worker(), worker()] }), options({ maxJobs: 1 })), 'lead-child-invalid', '1 to 1');
  for (const key of ['maxUsd', 'maxTokens']) rejects(() => validateChildManifest(child({ budget: { [key]: 11 } }), options({ budget: { [key]: 10 } })), 'lead-child-invalid', key);
});

test('child clamps concurrency and inherits budget, checks, preChecks and contract without mutation', () => {
  const original = child({ concurrency: 100, budget: { maxUsd: 1 } });
  const parentManifest = { checks: ['test'], preChecks: ['prepare'], contract: 'parent' };
  const opts = options({ concurrency: 3, budget: { maxUsd: 2, maxTokens: 100 } }, { parentManifest });
  const result = validateChildManifest(original, opts);
  assert.equal(result.concurrency, 3);
  assert.deepEqual(result.budget, { maxUsd: 1, maxTokens: 100 });
  assert.deepEqual(original.budget, { maxUsd: 1 });
  for (const key of ['checks', 'preChecks', 'contract']) assert.deepEqual(result[key], parentManifest[key]);
  assert.equal(validateChildManifest(child(), opts).concurrency, 3);
  assert.throws(() => validateChildManifest(child({ concurrency: 1, contract: 'child' }), opts), /contract must be the parent contract/);
  assert.equal(validateChildManifest(child({ concurrency: 1 }), opts).concurrency, 1);
  assert.doesNotThrow(() => validateChildManifest(child({ jobs: [worker({ sensitive: false, deletes: ['app/old.js'], context: ['elsewhere.js'] })] }), options({}, { leadSensitive: false })));
  assert.doesNotThrow(() => validateChildManifest(child({ jobs: [worker({ tier: 'expensive' })] }), options({ agents: ['codex', 'claude'] })));
});

test('prompt states limits, permissions, keys and a minimal JSON example under the cap', () => {
  const job = lead();
  const text = leadPromptBlock({ job, area: validateLeadArea(job), outputPath: 'child.json' });
  assert.ok(text.length < 2500);
  for (const word of ['Build the area', 'app/', 'index.js', '50', 'auto, codex', '8', 'child.json', 'top-level keys', 'job keys', 'cannot be leads or run commands', 'inside the scope']) assert.ok(text.includes(word), word);
  const example = JSON.parse(text.split('Example: ')[1]);
  assert.equal(example.version, 1);
  assert.equal(example.jobs.length, 1);
  assert.ok(inScope(example.jobs[0].outputs[0], job.area.scope));
  assert.ok(leadPromptBlock({ job, area: validateLeadArea(lead({ goal: 'g'.repeat(2000), scope: Array(50).fill('x'.repeat(100) + '/') })), outputPath: 'child.json' }).length < 2500);
});

test('rollup limits attention and sanitizes single-line errors to 160 characters', () => {
  const state = { id: 'parent-lead', leadJob: 'lead', status: 'failed', jobs: { ok: { status: 'complete' }, a: { status: 'failed', error: '\u001b[31mbad\u001b[0m\n\t' + 'x'.repeat(200) }, b: { status: 'blocked', error: 'unsafe\u202etext' }, c: { status: 'held', heldReason: 'paused\rnow' }, d: { status: 'failed', error: 'omit' } } };
  const result = leadRollup(state, { total: 5, counts: { complete: 1, failed: 2, blocked: 1, held: 1 }, spend: { costUsd: 2, tokens: 100, estimatedCount: 1 } });
  assert.equal(result.job, 'lead');
  assert.equal(result.run, 'parent-lead');
  assert.equal(result.status, 'failed');
  assert.equal(result.total, 5);
  assert.equal(result.counts.complete, 1);
  assert.deepEqual(result.spend, { costUsd: 2, tokens: 100, estimatedCount: 1 });
  assert.deepEqual(result.attention.map(entry => entry.job), ['a', 'b', 'c']);
  assert.equal(result.attention[0].error.length, 160);
  assert.equal(result.attention[1].error, 'unsafetext');
  assert.equal(result.attention[2].error, 'paused now');
  for (const entry of result.attention) assert.doesNotMatch(entry.error, /[\n\r\t\u001b]/);
  assert.deepEqual(leadRollup({ jobs: [] }, {}).attention, []);
});

test('a child contract other than the parent contract is refused', () => {
  const lead = { id: 'lead', agent: 'ollama', outputs: ['leads/lead.json'], area: { goal: 'g', scope: ['app/'] } };
  const area = validateLeadArea(lead);
  const child = { version: 1, contract: 'README.md', jobs: [{ id: 'w', agent: 'ollama', prompt: 'p', outputs: ['app/w.txt'] }] };
  assert.throws(() => validateChildManifest(child, { lead, area, parentManifest: { contract: 'docs/c.md' } }), /contract must be the parent contract/);
  assert.equal(validateChildManifest({ ...child, contract: 'docs/c.md' }, { lead, area, parentManifest: { contract: 'docs/c.md' } }).contract, 'docs/c.md');
});
