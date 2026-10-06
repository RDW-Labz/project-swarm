// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import * as swarm from '../tools/swarm.mjs';
import { preflightProject } from '../tools/preflight.mjs';

const exec = promisify(execFile);
const cli = fileURLToPath(new URL('../tools/swarm.mjs', import.meta.url));
const scratch = ['docs', '_swarm'].join('/'); // Synthetic dependency text only, in temporary fixtures.
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const job = extra => ({ id: 'writer', agent: 'claude', model: 'sonnet', prompt: 'Review the supplied input.', context: ['input.txt'], outputs: [], ...extra });
const manifest = jobs => ({ version: 1, jobs });
async function put(root, file, bytes) {
  await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
  await fs.writeFile(path.join(root, file), bytes);
}
async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(process.env.SWARM_TEST_TMP || os.tmpdir(), 'ah-runtime-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await put(root, 'input.txt', 'source');
  return root;
}
const tierConfig = (fallback = { agent: 'claude', model: 'sonnet' }) => ({ tiers: { cheap: { agent: 'codex', model: 'test-model', fallback } } });
async function config(t, value) {
  const root = await fixture(t);
  const file = path.join(root, 'config.json');
  await fs.writeFile(file, JSON.stringify(value));
  return { ...process.env, SWARM_CONFIG: file };
}
const question = { context: ['input.txt'], question: 'What does this input say?' };
function responseScript(answer = '{"answer":"yes"}', model = 'claude-sonnet-5', failed = false) {
  return `console.log(${JSON.stringify(JSON.stringify({ type: 'system', subtype: 'init', model }))});console.log(${JSON.stringify(JSON.stringify({ type: 'assistant', message: { model, content: [] } }))});console.log(${JSON.stringify(JSON.stringify({ type: 'result', subtype: failed ? 'error' : 'success', is_error: failed, result: answer, total_cost_usd: 0.01 }))});`;
}
function fake(answer, observe = () => {}, model, failed) {
  return (command, args, options) => {
    observe(command, args, options);
    assert.equal(command, 'claude');
    return spawn(process.execPath, ['-e', responseScript(answer, model, failed)], options);
  };
}
const apiReply = summary => ({ done: true, model: 'test-api', message: { content: JSON.stringify({ summary, files: [] }) } });
function apiTransport(summary, observe = () => {}) {
  return async (_url, options) => {
    const body = JSON.parse(options.body);
    observe(body);
    assert.equal(body.tools, undefined);
    assert.match(body.messages[0].content, /No tools, commands, network access/);
    return new Response(JSON.stringify(apiReply(summary)), { headers: { 'content-type': 'application/json' } });
  };
}
function assertRoute(result, agent = 'claude', model = 'sonnet') {
  assert.deepEqual(result.route, { tier: 'cheap', requestedAgent: 'codex', requestedModel: 'test-model', agent, model });
  assert.ok(result.warnings.includes(`ask-agent-fallback: codex/test-model -> ${agent}/${model} (tier cheap); using configured read-only fallback`));
  assert.equal(result.model, model);
}

test('L357 routes a configured unsupported tier through its read-only fallback', async t => {
  assert.equal(typeof swarm.resolveAskRoute, 'function');
  const root = await fixture(t), env = await config(t, tierConfig());
  let calls = 0;
  const spawnImpl = fake(undefined, (command, args, options) => {
    calls++;
    assert.equal(command, 'claude');
    assert.equal(args[args.indexOf('--tools') + 1], 'Read,Glob,Grep');
    assert.equal(args[args.indexOf('--model') + 1], 'sonnet');
    assert.equal(options.shell, false);
  });
  for (const route of [{ tier: 'cheap' }, { agent: 'codex', model: 'test-model' }]) {
    const result = await swarm.askRun(root, { ...question, ...route }, { env, spawnImpl });
    assert.equal(result.status, 'complete');
    assertRoute(result);
    const saved = JSON.parse(await fs.readFile(path.join(root, '.swarm', 'runs', result.id, 'manifest.json'), 'utf8')).jobs[0];
    assert.equal(saved.agent, 'claude');
    assert.equal(saved.model, 'sonnet');
    assert.deepEqual(saved.outputs, []);
    assert.ok(!saved.shell && !saved.web);
  }
  assert.equal(calls, 2);
  const direct = await swarm.askRun(root, { ...question, model: 'sonnet' }, { env, spawnImpl });
  assert.equal(direct.route, undefined);
  assert.deepEqual(direct.warnings, []);
  assert.deepEqual(swarm.resolveAskRoute({ tier: 'cheap' }, tierConfig({ agent: 'ollama', model: 'test-api' })).agent, 'ollama');
});

test('L357 preserves fallback evidence across every answer shape', async t => {
  const root = await fixture(t), env = await config(t, tierConfig());
  const cases = [
    ['{"answer":"missing callback"}', 'complete', false],
    ['{"notes":["basis":"context-only"]}', 'complete', true],
    ['plain prose', 'unparsed', false],
  ];
  for (const [text, status, repaired] of cases) {
    const result = await swarm.askRun(root, { ...question, tier: 'cheap' }, { env, spawnImpl: fake(text, undefined, 'claude-opus-5') });
    assertRoute(result);
    assert.equal(result.status, status);
    assert.equal(result.repaired === true, repaired);
    assert.equal(result.modelMismatch, true);
    assert.ok(result.warnings.some(warning => warning.startsWith('model mismatch:')));
    if (text.includes('missing')) assert.ok(result.warnings.includes('absence-claim-limited-context'));
  }
  const failure = await swarm.askRun(root, { ...question, tier: 'cheap' }, { env, spawnImpl: fake('', undefined, undefined, true) });
  assertRoute(failure);
  assert.notEqual(failure.status, 'complete');
  const apiEnv = await config(t, tierConfig({ agent: 'ollama', model: 'test-api' }));
  const prose = await swarm.askRun(root, { ...question, tier: 'cheap' }, { env: apiEnv, fetchImpl: apiTransport('Plain answer.') });
  assertRoute(prose, 'ollama', 'test-api');
  assert.equal(prose.status, 'ok');
  assert.equal(prose.answer, 'Plain answer.');
  const direct = await swarm.askRun(root, { ...question, agent: 'ollama', model: 'test-api' }, { env: apiEnv, fetchImpl: apiTransport('Plain answer.') });
  assert.deepEqual(Object.keys(direct).sort(), ['actualModel', 'answer', 'contextFiles', 'costUsd', 'id', 'model', 'modelMismatch', 'parsed', 'status'].sort());
});

test('L357 refuses ambiguous or missing fallbacks before dispatch', async t => {
  assert.equal(typeof swarm.resolveAskRoute, 'function');
  assert.equal(swarm.resolveAskRoute({ tier: 'cheap' }, tierConfig()).agent, 'claude');
  const root = await fixture(t);
  const base = tierConfig();
  const refusals = [
    [{ tier: 'cheap' }, {}, 'ask-route-invalid'],
    [{ tier: 'other' }, base, 'ask-route-invalid'],
    [{ tier: 'cheap', model: 'sonnet' }, base, 'ask-route-invalid'],
    [{ tier: 'cheap', agent: 'claude' }, base, 'ask-route-invalid'],
    [{ agent: 'unknown', model: 'model' }, base, 'ask-route-invalid'],
    [{ tier: 'cheap' }, { tiers: { cheap: { agent: 'unknown', model: 'model' } } }, 'ask-route-invalid'],
    [{ tier: 'cheap' }, { tiers: { cheap: { agent: 'codex' } } }, 'ask-route-invalid'],
    [{ agent: 'codex', model: 'test-model' }, {}, 'ask-agent-fallback-unconfigured'],
    [{ agent: 'codex', model: 'test-model' }, { tiers: { cheap: base.tiers.cheap, mid: base.tiers.cheap } }, 'ask-agent-fallback-unconfigured'],
    ...[null, [], {}, { agent: 'codex', model: 'test-model' }, { agent: 'unknown', model: 'test-model' }, { agent: 'claude', model: ' ' }, { agent: 'claude', model: 'bad model' }].map(fallback => [{ tier: 'cheap' }, tierConfig(fallback), 'ask-agent-fallback-unconfigured']),
  ];
  let calls = 0;
  const unexpected = () => { calls++; throw Error('must refuse before dispatch'); };
  for (const [route, settings, code] of refusals) {
    const env = await config(t, settings);
    await assert.rejects(swarm.askRun(root, { ...question, ...route }, { env, spawnImpl: unexpected, fetchImpl: unexpected }), { code });
  }
  assert.equal(calls, 0);
  for (const agent of ['hermes', 'qwen']) assert.equal(swarm.resolveAskRoute({ tier: 'cheap' }, { tiers: { cheap: { agent, model: 'model', fallback: { agent: 'claude', model: 'sonnet' } } } }).agent, 'claude');
});

async function cliRun(root, args, { env = process.env, preload } = {}) {
  try {
    const result = await exec(process.execPath, [...(preload ? ['--import', 'data:text/javascript,' + encodeURIComponent(preload)] : []), cli, '--root', root, ...args], { env });
    return { ...result, code: 0 };
  } catch (error) { return { stdout: error.stdout, stderr: error.stderr, code: error.code }; }
}
test('L357 CLI guards the resolved provider and treats API prose as success', async t => {
  const root = await fixture(t), env = await config(t, tierConfig());
  await put(root, '.swarm/claude-provider-limit.json', JSON.stringify({ resetsAt: 'pending operator reset' }));
  const marker = path.join(root, 'launched');
  const preload = `import cp from 'node:child_process';import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';const original=cp.spawn;cp.spawn=(command,args,options)=>{if(command!=='claude')throw Error('unexpected process');fs.writeFileSync(${JSON.stringify(marker)},'yes');return original(process.execPath,['-e',${JSON.stringify(responseScript())}],options);};syncBuiltinESMExports();globalThis.fetch=async()=>{throw Error('unexpected fetch');};`;
  const args = ['ask', '--tier', 'cheap', '--context', 'input.txt', 'What is the input?'];
  const refused = await cliRun(root, args, { env, preload });
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /claude-provider-limit/);
  await assert.rejects(fs.access(marker));
  const allowed = await cliRun(root, [...args, '--ignore-provider-limit'], { env, preload });
  assert.equal(allowed.code, 0, allowed.stderr);
  assert.equal(allowed.stdout.trim().split('\n').length, 1);
  assertRoute(JSON.parse(allowed.stdout));
  assert.equal(await fs.readFile(marker, 'utf8'), 'yes');
  const cappedEnv = await config(t, { ...tierConfig(), spend: { dailyCapUsd: 0 } });
  const capped = await cliRun(root, [...args, '--ignore-provider-limit'], { env: cappedEnv, preload });
  assert.equal(capped.code, 1);
  assert.match(capped.stderr, /spend-cap/);
  const override = await cliRun(root, [...args, '--ignore-provider-limit', '--over-cap', '--reason', 'fixture approval'], { env: cappedEnv, preload });
  assert.equal(override.code, 0, override.stderr);
  assertRoute(JSON.parse(override.stdout));
  assert.match(override.stderr, /spend-cap/);
  const apiEnv = await config(t, tierConfig({ agent: 'ollama', model: 'test-api' }));
  const apiPreload = `import cp from 'node:child_process';import {syncBuiltinESMExports} from 'node:module';cp.spawn=()=>{throw Error('unexpected CLI provider');};syncBuiltinESMExports();globalThis.fetch=async()=>new Response(${JSON.stringify(JSON.stringify(apiReply('Plain answer.')))});`;
  const prose = await cliRun(root, args, { env: apiEnv, preload: apiPreload });
  assert.equal(prose.code, 0, prose.stderr);
  assert.equal(prose.stdout.trim().split('\n').length, 1);
  assert.equal(JSON.parse(prose.stdout).status, 'ok');
  assertRoute(JSON.parse(prose.stdout), 'ollama', 'test-api');
});

test('L358 accepts carried directory and full glob paths without prefix leakage', async t => {
  const root = await fixture(t);
  await exec('git', ['init', '-q'], { cwd: root });
  for (const file of ['src/pkg/a.py', 'src/pkg/nested/b.py', 'src/pkg-other/a.js', 'context/only.py', 'resources/only.py', 'uncovered/a.py']) await put(root, file, 'source');
  await exec('git', ['add', '--', 'input.txt', 'src'], { cwd: root });
  const spec = prompt => ({ ...manifest([job({ prompt, context: ['input.txt', 'context/only.py'] })]), resources: ['resources/only.py'] });
  for (const candidate of ['src/pkg', 'src/pkg/', './src/pkg', './src/pkg/', 'context', 'resources', 'src/pkg/*.py', 'src/pkg/**/*.py', './src/pkg/*.py', '**/*.py', '*.txt']) {
    await assert.doesNotReject(swarm.validateProject(root, spec(`Read ${candidate}/`.replace(/\/\/$/, '/') + ' carefully.')), candidate);
  }
  // Globs are complete matches: carrying Python files cannot cover an unmatched extension.
  for (const candidate of ['uncovered/a.py', 'uncovered', 'src/pkg/*.js', 'src/pkg/**/*.js', '*.py']) {
    const spelling = candidate.includes('/') ? candidate : candidate + '/';
    await assert.rejects(swarm.validateProject(root, spec(`Read ${spelling} carefully.`)), /prompt-path-not-in-workspace/);
  }
  await put(root, 'src/pkg-empty/a.py', 'not carried');
  await assert.rejects(swarm.validateProject(root, spec('Read src/pkg-empty carefully.')), /prompt-path-not-in-workspace/);
  const prefixRoot = await fixture(t);
  await put(prefixRoot, 'src/pkg/a.py', 'source');
  const hits = await swarm.promptPathsNotInWorkspaceWarnings(prefixRoot, job({ prompt: 'Read src/pkg carefully.' }), [], { trackedFiles: ['src/pkg-other/a.py'] });
  assert.equal(hits.length, 1);
  assert.match(hits[0], /exists on disk but is neither tracked/);
  const globHits = await swarm.promptPathsNotInWorkspaceWarnings(root, job({ prompt: 'Read src/pkg/*.js carefully.' }), [], { trackedFiles: ['src/pkg/a.py'] });
  assert.match(globHits[0], /matches no tracked, context, or resource file/);
  for (const prompt of ['See https://example.invalid/uncovered/a.py', 'See /uncovered/a.py', 'See ../uncovered/a.py', 'See made/up/prose', 'See uncovered/../uncovered/a.py', 'See src/pkg/[ab].py']) {
    assert.deepEqual(await swarm.promptPathsNotInWorkspaceWarnings(root, job({ prompt }), []), [], prompt);
  }
});

async function savedRun(root, jobs, { partial = false } = {}) {
  const id = 'saved-' + crypto.randomBytes(4).toString('hex');
  const spec = manifest(jobs.map(({ outputs, deletes = [], id: jobId }) => job({ id: jobId, outputs: Object.keys(outputs), ...(deletes.length ? { deletes } : {}) })));
  const records = [];
  for (const source of jobs) {
    const workspace = `.swarm/workspaces/${id}/${source.id}`;
    await fs.mkdir(path.join(root, workspace), { recursive: true });
    const baseHashes = {};
    for (const [file, bytes] of Object.entries(source.outputs)) {
      let current = null;
      try { current = await fs.readFile(path.join(root, file)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      baseHashes[file] = current === null ? null : hash(current);
      if (bytes !== null) await put(root, `${workspace}/${file}`, bytes);
    }
    for (const [file, bytes] of Object.entries(source.dropped ?? {})) await put(root, `.swarm/runs/${id}/dropped/${file}`, bytes);
    records.push({ id: source.id, status: 'complete', agent: 'claude', model: 'sonnet', workspace, outputs: Object.keys(source.outputs), baseHashes, droppedWrites: Object.keys(source.dropped ?? {}) });
    await put(root, `.swarm/runs/${id}/${source.id}/response.txt`, '{"notes":[]}');
  }
  await put(root, `.swarm/runs/${id}/manifest.json`, JSON.stringify(spec));
  await put(root, `.swarm/runs/${id}/state.json`, JSON.stringify({ id, root, status: 'complete', startedAt: new Date().toISOString(), jobs: records, ...(partial ? { integratedAt: new Date().toISOString(), integrationStatus: 'partial' } : {}) }));
  return id;
}

test('L360 integration refuses scratch references before any write', async t => {
  for (const file of ['src/code.mjs', 'tests/code.test.mjs']) for (const separator of ['/', '\\', '\\\\']) {
    const root = await fixture(t);
    await put(root, 'src/safe.mjs', 'old safe');
    await put(root, 'src/remove.mjs', 'keep until accepted');
    const dependency = scratch.split('/').join(separator);
    const id = await savedRun(root, [{ id: 'writer', outputs: { 'src/safe.mjs': 'new safe', 'src/remove.mjs': null, [file]: `// comment\nconst input = "nested/${dependency}/data.json";` }, deletes: ['src/remove.mjs'] }]);
    await assert.rejects(swarm.integrateRun(root, id, { noChecks: true }), error => {
      assert.equal(error.code, 'work-folder-reference');
      assert.ok(error.message.includes(`${file}:2 references ${scratch}`));
      assert.ok(!error.message.includes('const input'));
      return true;
    });
    assert.equal(await fs.readFile(path.join(root, 'src/safe.mjs'), 'utf8'), 'old safe');
    assert.equal(await fs.readFile(path.join(root, 'src/remove.mjs'), 'utf8'), 'keep until accepted');
    await assert.rejects(fs.access(path.join(root, file)));
  }
  const root = await fixture(t);
  const allowed = { 'tests/good.test.mjs': 'const input = "tests/fixtures/input.json";', 'docs/design.md': scratch, 'src/sibling.mjs': `// ${scratch}ish`, 'src/binary.dat': Buffer.from(`\0${scratch}`) };
  const id = await savedRun(root, [{ id: 'writer', outputs: allowed }]);
  assert.equal((await swarm.integrateRun(root, id, { noChecks: true })).status, 'integrated');
  for (const [file, bytes] of Object.entries(allowed)) assert.deepEqual(await fs.readFile(path.join(root, file)), Buffer.from(bytes));
});

test('L360 integration selection and salvage cannot bypass the reference guard', async t => {
  const root = await fixture(t);
  const id = await savedRun(root, [{ id: 'clean', outputs: { 'src/clean.mjs': 'clean' } }, { id: 'bad', outputs: { 'tests/bad.test.mjs': `// ${scratch}` } }]);
  await assert.rejects(swarm.integrateRun(root, id, { noChecks: true, jobs: ['bad'] }), { code: 'work-folder-reference' });
  await assert.rejects(fs.access(path.join(root, 'src/clean.mjs')));
  assert.equal((await swarm.integrateRun(root, id, { noChecks: true, jobs: ['clean'] })).status, 'integrated');
  await assert.rejects(fs.access(path.join(root, 'tests/bad.test.mjs')));
  for (const file of ['src/dropped.mjs', 'tests/dropped.test.mjs']) {
    const salvageRoot = await fixture(t);
    const salvageId = await savedRun(salvageRoot, [{ id: 'writer', outputs: { 'src/safe.mjs': 'safe' }, dropped: { [file]: `// ${scratch}` } }], { partial: true });
    await assert.rejects(swarm.integrateRun(salvageRoot, salvageId, { noChecks: true, salvageDropped: true }), { code: 'work-folder-reference' });
    await assert.rejects(fs.access(path.join(salvageRoot, 'src/safe.mjs')));
    await assert.rejects(fs.access(path.join(salvageRoot, file)));
  }
  const deletionRoot = await fixture(t);
  await put(deletionRoot, 'src/delete.mjs', `// ${scratch}`);
  const deletionId = await savedRun(deletionRoot, [{ id: 'writer', outputs: { 'src/delete.mjs': null }, deletes: ['src/delete.mjs'] }]);
  assert.equal((await swarm.integrateRun(deletionRoot, deletionId, { noChecks: true })).status, 'integrated');
  await assert.rejects(fs.access(path.join(deletionRoot, 'src/delete.mjs')));
});

test('L360 validation warns only for build scratch data contexts', async t => {
  const root = await fixture(t);
  const data = `${scratch}/data.json`, script = `${scratch}/input.py`, doc = `${scratch}/contract.md`;
  for (const file of [data, script, doc]) await put(root, file, 'fixture source');
  const build = manifest([job({ context: [doc], contextGlob: [`${scratch}/*.json`, `${scratch}/*.py`], outputs: ['src/output.mjs'] })]);
  const warnings = (await swarm.validateProject(root, build)).warnings.filter(warning => warning.code === 'work-folder-context');
  assert.deepEqual(warnings.map(warning => warning.path).sort(), [data, script].sort());
  assert.equal(warnings[0].message, `work-folder-context: Job writer includes ${warnings[0].path} as non-documentation scratch input; copy required runtime or test data into tracked tests/fixtures files`);
  assert.deepEqual((await preflightProject(root, build)).advisories.filter(warning => warning.code === 'work-folder-context'), warnings);
  for (const outputs of [[], ['docs/design.md'], ['docs/design.json'], ['notes.rst', 'notes.txt', 'notes.adoc']]) {
    const result = await swarm.validateProject(root, manifest([job({ context: [data, script, doc], outputs })]));
    assert.deepEqual(result.warnings.filter(warning => warning.code === 'work-folder-context'), []);
  }
  assert.deepEqual(swarm.workFolderContextWarnings(job({ outputs: ['src/output.mjs'] }), [doc]), []);
});

test('L361 note appends the injected UTC clock and preserves existing content', async t => {
  assert.equal(typeof swarm.noteRun, 'function');
  const root = await fixture(t);
  const stamp = '2026-01-02T03:04:05.000Z';
  let clocks = 0;
  const now = () => { clocks++; return Date.parse('2026-01-01T21:04:05-06:00'); };
  for (const prior of [Buffer.from('prior'), Buffer.from('prior\n'), Buffer.alloc(0), Buffer.from([0xff, 0xfe])]) {
    await put(root, 'TASK.md', prior);
    assert.deepEqual(await swarm.noteRun(root, { text: 'first' }, { now }), { status: 'complete', file: 'TASK.md', timestamp: stamp });
    await swarm.noteRun(root, { text: 'second' }, { now });
    assert.deepEqual(await fs.readFile(path.join(root, 'TASK.md')), Buffer.concat([prior, Buffer.from(`${prior.length && prior.at(-1) !== 10 ? '\n' : ''}- ${stamp} first\n- ${stamp} second\n`)]));
  }
  await fs.mkdir(path.join(root, 'coordination'));
  await swarm.noteRun(root, { text: 'handoff', file: 'coordination/HANDOFF.md' }, { now });
  assert.equal(await fs.readFile(path.join(root, 'coordination/HANDOFF.md'), 'utf8'), `- ${stamp} handoff\n`);
  assert.equal(clocks, 9);
  const emptyRoot = await fixture(t);
  await swarm.noteRun(emptyRoot, { text: 'new' }, { now });
  assert.equal(await fs.readFile(path.join(emptyRoot, 'TASK.md'), 'utf8'), `- ${stamp} new\n`);
});

test('L361 note rejects forged lines and unsafe targets without writes', async t => {
  assert.equal(typeof swarm.noteRun, 'function');
  const root = await fixture(t);
  await swarm.noteRun(root, { text: 'valid' }, { now: () => 1767323045000 });
  const prior = await fs.readFile(path.join(root, 'TASK.md'));
  for (const text of ['', '  ', 'line\nforged', 'line\rforged', 'nul\0', 'tab\t', 'control\x1b', 'delete\x7f', 'next\u0085', 'line\u2028']) {
    await assert.rejects(swarm.noteRun(root, { text }), { code: 'note-invalid-args' });
  }
  await fs.mkdir(path.join(root, 'directory', 'TASK.md'), { recursive: true });
  for (const file of ['../TASK.md', 'x/../TASK.md', path.join(root, 'TASK.md'), 'C:/TASK.md', 'C:\\TASK.md', '\\\\server\\TASK.md', '.git/TASK.md', '.env/TASK.md', 'directory/TASK.md', 'missing/TASK.md', 'other.md']) {
    await assert.rejects(swarm.noteRun(root, { text: 'rejected', file }), { code: 'note-invalid-path' });
  }
  await assert.rejects(swarm.noteRun(root, { text: 'invalid clock' }, { now: () => NaN }), { code: 'note-write-failed' });
  await assert.rejects(swarm.noteRun(root, { text: 'new invalid', file: 'HANDOFF.md' }, { now: () => Infinity }), { code: 'note-write-failed' });
  await assert.rejects(fs.access(path.join(root, 'HANDOFF.md')));
  try {
    await fs.symlink(path.join(root, 'TASK.md'), path.join(root, 'HANDOFF.md'));
    await fs.symlink(path.join(root, 'directory'), path.join(root, 'linked'), 'dir');
  } catch (error) {
    if (process.platform !== 'win32' || !['EPERM', 'EACCES'].includes(error.code)) throw error;
    t.diagnostic('Symlink fixtures unavailable: Windows privilege restriction');
    assert.deepEqual(await fs.readFile(path.join(root, 'TASK.md')), prior);
    return;
  }
  for (const file of ['HANDOFF.md', 'linked/TASK.md']) await assert.rejects(swarm.noteRun(root, { text: 'symlink', file }), { code: 'note-invalid-path' });
  assert.deepEqual(await fs.readFile(path.join(root, 'TASK.md')), prior);
});

test('L361 CLI prints a real timestamp and leaves note text inert', async t => {
  const root = await fixture(t);
  await fs.mkdir(path.join(root, 'coordination'));
  const text = 'literal "quotes" $HOME $(echo forged) `echo forged`; exit 9';
  const before = Date.now();
  const result = await cliRun(root, ['note', '--file', 'coordination/HANDOFF.md', text]);
  const after = Date.now();
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout.trim().split('\n').length, 1);
  const value = JSON.parse(result.stdout);
  assert.equal(value.status, 'complete');
  assert.equal(value.file, 'coordination/HANDOFF.md');
  assert.ok(Date.parse(value.timestamp) >= before && Date.parse(value.timestamp) <= after);
  assert.equal(await fs.readFile(path.join(root, value.file), 'utf8'), `- ${value.timestamp} ${text}\n`);
  for (const flag of ['--timestamp', '--unknown']) {
    const refusal = await cliRun(root, ['note', flag, 'forged']);
    assert.equal(refusal.code, 1);
    assert.match(refusal.stderr, /note-invalid-args/);
  }
  await assert.rejects(fs.access(path.join(root, 'TASK.md')));
  const help = await cliRun(root, ['--help']);
  assert.match(help.stdout, /note \[--file TASK\.md\|HANDOFF\.md\]/);
  assert.match(help.stdout, /ask \(--tier cheap\|mid\|expensive/);
});
