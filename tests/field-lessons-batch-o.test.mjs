// SPDX-License-Identifier: Apache-2.0
// Swarm batch O: field lessons 219-228, 262 (see .swarm-manifests/contract-o.md).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import {
  validateProject, runManifest, integrateRun, missingDepsWarnings, shellSandboxDeniedCheckWarnings,
  shellGrantedPathPrefixes, nextQueuedTicketHint, noJobRunningWarning, validateManifest,
} from '../tools/swarm.mjs';
import { checkNeedsEnvWarnings, npmScriptsResolveToPlainNode } from '../tools/swarm-env.mjs';
import { executeApi } from '../tools/api-adapters.mjs';
import { defaultMaxOutputTokens, isEmptyLengthTruncation } from '../tools/openrouter.mjs';
import { parseSkillFrontmatter, validateSkillFrontmatter, loadSkillFile, listSkills, attachSkillsForJob } from '../tools/skills.mjs';
import { shellProfile, validateLoopbackAllow } from '../tools/claude-shell.mjs';
import { ship } from '../tools/ship.mjs';

const execFileAsync = promisify(execFile);

async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-batch-o-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}
const manifest = jobs => ({ version: 1, concurrency: 1, jobs });
const job = (overrides = {}) => ({ id: 'w', agent: 'claude', model: 'sonnet', prompt: 'Do the task.', context: [], outputs: ['out.txt'], timeoutMs: 5000, ...overrides });

// --- #219: missing-deps only when deps are declared; check-needs-env skips plain node ----------

test('#219: missing-deps never warns on a package.json with no dependencies at all', async t => {
  const root = await fixture(t);
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'x', version: '1.0.0' }));
  const warnings = await missingDepsWarnings(root);
  assert.deepEqual(warnings, []);
});

test('#219: missing-deps still warns when package.json declares a dependency and node_modules is missing', async t => {
  const root = await fixture(t);
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'x', version: '1.0.0', dependencies: { left: '^1.0.0' } }));
  const warnings = await missingDepsWarnings(root);
  assert.ok(warnings.some(w => w.code === 'missing-deps' && w.path === 'node_modules'));
});

test('#219: check-needs-env skips an npm check whose script resolves to a plain node command', () => {
  const manifestObj = { checks: [{ name: 'unit', argv: ['npm', 'test'] }] };
  const resolvesToPlainNode = npmScriptsResolveToPlainNode({ test: 'node --test tests/' });
  assert.deepEqual(checkNeedsEnvWarnings(manifestObj, false, { resolvesToPlainNode }), []);
  // Without the fix (no resolvesToPlainNode option), the same manifest still warns.
  assert.ok(checkNeedsEnvWarnings(manifestObj, false).some(w => w.code === 'check-needs-env'));
});

test('#219: check-needs-env still warns for an npm script that is not plain node', () => {
  const manifestObj = { checks: [{ name: 'unit', argv: ['npm', 'test'] }] };
  const resolvesToPlainNode = npmScriptsResolveToPlainNode({ test: 'jest' });
  assert.ok(checkNeedsEnvWarnings(manifestObj, false, { resolvesToPlainNode }).some(w => w.code === 'check-needs-env'));
});

// --- #220: scratch-file-in-diff reads the pushed diff, never the run's declared output list ----

// `mergeBase`/`diffNameOnly` are special-cased (outside the sequential script) since ship() calls
// `git merge-base` from more than one place (author-email uses its own separate exec, but
// pushedFileNames/releaseVersion both share this one); the sequential `script` only ever covers
// the remaining, strictly-ordered calls (status, rev-parse, push, pr list/create, pr view, merge).
function shipExecFixture(script, { mergeBase = { code: 1, stdout: '', stderr: 'no package' }, diffNameOnly = { code: 0, stdout: '', stderr: '' } } = {}) {
  let index = 0;
  const exec = async (file, args, opts) => {
    if (file === 'git' && args[0] === 'remote') return { code: 0, stdout: 'https://github.com/acme/widgets.git', stderr: '' };
    if (file === 'git' && args[0] === 'merge-base') return mergeBase;
    if (file === 'git' && args[0] === 'diff' && args.includes('--name-only')) return diffNameOnly;
    const entry = script[index++];
    return typeof entry === 'function' ? entry(file, args, opts) : entry;
  };
  return exec;
}
const shipOk = (stdout = '') => ({ code: 0, stdout, stderr: '' });
const shipRev = sha => shipOk(`${sha}\n`);
const authorEmailExecOk = async args => (args[0] === 'config' ? shipOk('me@example.com\n') : shipOk(''));

test('#220: ship never refuses scratch-file-in-diff for a gitignored output absent from the pushed diff', async t => {
  const root = await fixture(t);
  const payloadPath = path.join(root, 'pr.json');
  await fs.writeFile(payloadPath, JSON.stringify({ title: 'Add feature', head: 'feature-branch', base: 'main', body: 'body text' }));
  const exec = shipExecFixture(
    [
      shipOk(''), // git status
      shipRev('sha123'), // rev-parse HEAD
      shipOk(''), // push
      shipOk('[]'), // pr list
      shipOk(JSON.stringify({ number: 7, html_url: 'https://example.com/pr/7' })), // pr create
      shipOk(JSON.stringify({ state: 'OPEN', headRefOid: 'sha123', mergeStateStatus: 'CLEAN', statusCheckRollup: [{ name: 'ci', status: 'COMPLETED', conclusion: 'SUCCESS' }] })), // pr view (ci settled)
    ],
    { mergeBase: shipRev('deadbeef'), diffNameOnly: shipOk('CHANGELOG.md\n') },
  );
  const result = await ship({
    root, repo: 'acme/widgets', payloadPath, exec, merge: false, authorEmailExec: authorEmailExecOk,
    integratedFiles: ['.swarm-manifests/o-pr-create.json', 'CHANGELOG.md'],
    runChecks: async () => [{ name: 'unit', status: 'passed', exitCode: 0, tail: '' }],
    sleep: async () => {}, now: () => 0,
  });
  assert.equal(result.status, 'ready', JSON.stringify(result));
});

test('#220: ship refuses scratch-file-in-diff when a scratch payload actually lands in the pushed diff', async t => {
  const root = await fixture(t);
  const payloadPath = path.join(root, 'pr.json');
  await fs.writeFile(payloadPath, JSON.stringify({ title: 'Add feature', head: 'feature-branch', base: 'main', body: 'body text' }));
  const exec = shipExecFixture(
    [shipOk(''), shipRev('sha123')],
    { mergeBase: shipRev('deadbeef'), diffNameOnly: shipOk('.swarm-manifests/o-pr-create.json\nCHANGELOG.md\n') },
  );
  const result = await ship({
    root, repo: 'acme/widgets', payloadPath, exec, merge: false, authorEmailExec: authorEmailExecOk,
    integratedFiles: ['.swarm-manifests/o-pr-create.json', 'CHANGELOG.md'],
    runChecks: async () => { throw new Error('checks must not run'); },
    sleep: async () => {}, now: () => 0,
  });
  assert.equal(result.status, 'refused');
  assert.equal(result.code, 'scratch-file-in-diff');
});

// --- #221: ask/validate/run refuse empty-context-file --------------------------------------------

test('#221: validate refuses empty-context-file naming the path', async t => {
  const root = await fixture(t);
  await fs.writeFile(path.join(root, 'empty.txt'), '');
  await assert.rejects(validateProject(root, manifest([job({ context: ['empty.txt'] })])), /empty-context-file: empty\.txt/);
});

test('#221: a whitespace-only context file is refused the same way; manifest allowEmptyContext excuses it', async t => {
  const root = await fixture(t);
  await fs.writeFile(path.join(root, 'blank.txt'), '   \n\t\n');
  await assert.rejects(validateProject(root, manifest([job({ context: ['blank.txt'] })])), /empty-context-file: blank\.txt/);
  const report = await validateProject(root, { ...manifest([job({ context: ['blank.txt'] })]), allowEmptyContext: ['blank.txt'] });
  assert.equal(report.status, 'valid');
});

test('#221: run (runManifest, the same path ask uses) fails the same way on an empty context file', async t => {
  const root = await fixture(t);
  await fs.writeFile(path.join(root, 'empty.txt'), '');
  const state = await runManifest(root, manifest([job({ context: ['empty.txt'] })]));
  assert.equal(state.status, 'failed');
  assert.match(state.error, /empty-context-file: empty\.txt/);
});

// --- #222: API adapters refuse api-key-missing before sending; empty-body is named -------------

test('#222: executeApi refuses api-key-missing naming the config path, before any request is sent', async t => {
  let fetchCalled = false;
  const result = await executeApi(job({ agent: 'openai', outputs: ['report.md'] }), [], {
    env: {}, fetchImpl: async () => { fetchCalled = true; throw new Error('must not be called'); },
  });
  assert.equal(result.status, 'failed');
  assert.match(result.error, /^api-key-missing: OPENAI_API_KEY/);
  assert.equal(fetchCalled, false);
});

test('#222: executeApi names the openrouter keychain item and config path in api-key-missing', async t => {
  const result = await executeApi(job({ agent: 'openrouter', model: 'anthropic/claude', outputs: ['report.md'] }), [], {
    env: { SWARM_CONFIG: '/tmp/does-not-exist-swarm-config.json' }, readKey: () => null,
    fetchImpl: async () => { throw new Error('must not be called'); },
  });
  assert.equal(result.status, 'failed');
  assert.match(result.error, /^api-key-missing: OPENROUTER_API_KEY not set; keychain item .+\/openrouter\.api_key not found; config read from \/tmp\/does-not-exist-swarm-config\.json/);
});

test('#222 follow-up: api-key-missing config path resolves from the passed env, never the real machine home', async t => {
  const fakeHome = await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-fake-home-'));
  t.after(() => fs.rm(fakeHome, { recursive: true, force: true }));
  const decoyDir = path.join(fakeHome, '.config', 'project-swarm');
  await fs.mkdir(decoyDir, { recursive: true });
  const decoyConfigFile = path.join(decoyDir, 'config.json');
  // A decoy the real machine's home never has: if the code fell back to the live os.homedir()
  // instead of the isolated env it was handed, this service name would never show up.
  await fs.writeFile(decoyConfigFile, JSON.stringify({ keychain: { service: 'decoy-service' } }));
  const result = await executeApi(job({ agent: 'openrouter', model: 'anthropic/claude', outputs: ['report.md'] }), [], {
    env: { HOME: fakeHome }, readKey: () => null,
    fetchImpl: async () => { throw new Error('must not be called'); },
  });
  assert.equal(result.status, 'failed');
  assert.match(result.error, /keychain item decoy-service\/openrouter\.api_key/);
  assert.ok(result.error.endsWith(`config read from ${decoyConfigFile}`), result.error);
});

test('#222: an empty 200 body names empty-body instead of a generic malformed-JSON error', async t => {
  const reply = () => new Response('', { status: 200, headers: { 'content-type': 'application/json' } });
  const result = await executeApi(job({ agent: 'openai', outputs: ['report.md'] }), [], {
    env: { OPENAI_API_KEY: 'k' }, fetchImpl: async () => reply(),
  });
  assert.equal(result.status, 'failed');
  assert.match(result.error, /empty-body/);
});

// --- #223: CLI jobs: null result + no output -> failed/no-output; prose blocked is parsed ------

const fakeClaude = script => (_command, _args, options) => spawn(process.execPath, ['-e', script], options);
function claudeResultEvent(text) {
  return JSON.stringify(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: text }));
}

test('#223: a CLI job whose prompt demands a JSON-only reply, gets none, and writes no output fails with reason no-output', async t => {
  const root = await fixture(t);
  const script = `console.log(${claudeResultEvent('Looks done, no issues found.')})`;
  // Field lesson #223 is gated on the same signal `resultMissing`'s own re-ask already uses (the
  // prompt's own JSON demand): a plain builder prompt with no such demand keeps the older,
  // deliberately lenient contract of deferring a missing declared output to `integrate` (see the
  // "still complete" case below and the pre-existing suite's own "never propagates deletions").
  const prompt = 'Do the task. Reply with only this JSON: {"summary": "..."}';
  const state = await runManifest(root, manifest([job({ id: 'no-out', prompt, outputs: ['missing.txt'] })]), { spawnImpl: fakeClaude(script) });
  assert.equal(state.status, 'failed');
  assert.equal(state.jobs[0].reason, 'no-output');
  assert.match(state.jobs[0].error, /no-output/);
});

test('#223: without the prompt\'s own JSON demand, the same no-JSON/no-output reply keeps today\'s complete status (deferred to integrate)', async t => {
  const root = await fixture(t);
  const script = `console.log(${claudeResultEvent('Looks done, no issues found.')})`;
  const state = await runManifest(root, manifest([job({ id: 'no-out-lenient', outputs: ['missing.txt'] })]), { spawnImpl: fakeClaude(script) });
  assert.equal(state.jobs[0].status, 'complete');
  await assert.rejects(integrateRun(root, state.id), /Missing output/);
});

test('#223: a CLI job\'s prose "Status: BLOCKED" reply (no JSON) is parsed into blocked/needFile', async t => {
  const root = await fixture(t);
  const script = `console.log(${claudeResultEvent('Status: BLOCKED\\nRequired file: tools/swarm.mjs')})`;
  const state = await runManifest(root, manifest([job({ id: 'prose-blocked' })]), { spawnImpl: fakeClaude(script) });
  assert.equal(state.jobs[0].status, 'blocked');
  assert.equal(state.jobs[0].needFile, 'tools/swarm.mjs');
});

test('#223: a CLI job that writes its declared output is still complete even with no parsable JSON reply', async t => {
  const root = await fixture(t);
  const script = `require('fs').writeFileSync('out.txt','done');\nconsole.log(${claudeResultEvent('wrote the file')})`;
  const state = await runManifest(root, manifest([job({ id: 'wrote' })]), { spawnImpl: fakeClaude(script) });
  assert.equal(state.jobs[0].status, 'complete');
});

// --- #224: empty checks lists are valid; unused-bad-skill warns, not refuses; inline YAML lists -

test('#224: filesMustChange:[] and resultKeys:[] are valid (an explicit "none"), never a refusal', () => {
  const frontmatter = parseSkillFrontmatter('---\nname: demo\ndescription: a demo skill\nchecks:\n  filesMustChange: []\n  resultKeys: []\n---\nBody.\n').frontmatter;
  assert.deepEqual(validateSkillFrontmatter(frontmatter, 'demo/SKILL.md').checks, { filesMustChange: [], resultKeys: [] });
});

test('#224: the frontmatter reader parses an inline YAML list `[a, b]`', () => {
  const { frontmatter } = parseSkillFrontmatter('---\nname: demo\ndescription: a demo skill\nchecks:\n  resultKeys: [a, b]\n---\nBody.\n');
  assert.deepEqual(frontmatter.checks.resultKeys, ['a', 'b']);
});

test('#224: a bad skill unused by any job is a warning, never a refusal; a job that attaches it is refused', async t => {
  const root = await fixture(t);
  const skillDir = path.join(root, 'skills', 'broken');
  await fs.mkdir(skillDir, { recursive: true });
  await fs.writeFile(path.join(skillDir, 'SKILL.md'), '---\nname: broken\ndescription: a broken skill\nchecks:\n  filesMustChange:\n    - "*.md"\n  unknownField: yes\n---\nBody.\n');
  const unusedManifest = { ...manifest([job()]), skillsDir: 'skills' };
  const report = await validateProject(root, unusedManifest);
  assert.ok(report.warnings.some(w => w.code === 'skill-invalid-unused'), JSON.stringify(report.warnings));

  const attachingManifest = { ...manifest([job({ skills: ['broken'] })]), skillsDir: 'skills' };
  await assert.rejects(validateProject(root, attachingManifest), /invalid-skill-frontmatter/);
});

test('#224: swarm skills check validates the configured skills.dir and prints each problem', async t => {
  const root = await fixture(t);
  const skillDir = path.join(root, 'skills', 'broken');
  await fs.mkdir(skillDir, { recursive: true });
  await fs.writeFile(path.join(skillDir, 'SKILL.md'), '---\nname: broken\ndescription: a broken skill\nchecks:\n  unknownField: yes\n---\nBody.\n');
  const goodDir = path.join(root, 'skills', 'good');
  await fs.mkdir(goodDir, { recursive: true });
  await fs.writeFile(path.join(goodDir, 'SKILL.md'), '---\nname: good\ndescription: a fine skill\n---\nBody.\n');
  const configFile = path.join(root, 'swarm-config.json');
  await fs.writeFile(configFile, JSON.stringify({ skills: { dir: path.join(root, 'skills') } }));
  const CLI = new URL('../tools/swarm.mjs', import.meta.url).pathname;
  // A skills.dir with a real problem exits 1 (a problem was found); the JSON on stdout still
  // rides along on the rejection.
  let stdout;
  try { ({ stdout } = await execFileAsync(process.execPath, [CLI, '--root', root, 'skills', 'check'], { env: { ...process.env, SWARM_CONFIG: configFile } })); }
  catch (error) { stdout = error.stdout; }
  const result = JSON.parse(stdout);
  assert.equal(result.status, 'problems');
  assert.equal(result.skills.length, 1);
  assert.equal(result.skills[0].name, 'good');
  assert.equal(result.problems.length, 1);
});

// --- #225: shell-sandbox-denied-check treats granted read paths as allowed; doctor shell --------

test('#225: shell-sandbox-denied-check never warns for the toolchains dir, a granted read path', () => {
  const home = '/Users/dev';
  const deniedManifest = {
    version: 1,
    jobs: [{ id: 'w', agent: 'claude', shell: true, model: 'sonnet', prompt: 'Fix it.', context: [], outputs: ['out.txt'] }],
    checks: [{ name: 'toolchain-path', argv: ['env', `PATH=${home}/.project-swarm/toolchains/bin:$PATH`, 'true'] }],
  };
  assert.deepEqual(shellSandboxDeniedCheckWarnings(deniedManifest, { env: {}, home }), []);
});

test('#225: shell-sandbox-denied-check still warns for a different path under the same $HOME trigger', () => {
  const deniedManifest = {
    version: 1,
    jobs: [{ id: 'w', agent: 'claude', shell: true, model: 'sonnet', prompt: 'Fix it.', context: [], outputs: ['out.txt'] }],
    checks: [{ name: 'check-pins', argv: ['node', '$HOME/.project-swarm/current/tools/swarm.mjs', 'check-pins'] }],
  };
  const warnings = shellSandboxDeniedCheckWarnings(deniedManifest);
  assert.ok(warnings.some(w => w.code === 'shell-sandbox-denied-check'));
});

test('#225: shellGrantedPathPrefixes includes a job\'s own readPaths alongside the toolchains dir', () => {
  const prefixes = shellGrantedPathPrefixes({ jobs: [{ readPaths: ['/opt/granted'] }] }, { env: {}, home: '/home/x' });
  assert.ok(prefixes.includes('/opt/granted'));
  assert.ok(prefixes.some(p => p.endsWith('.project-swarm/toolchains')));
});

test('#225: swarm doctor shell prints the effective sandbox profile as JSON', async t => {
  const root = await fixture(t);
  const CLI = new URL('../tools/swarm.mjs', import.meta.url).pathname;
  const { stdout } = await execFileAsync(process.execPath, [CLI, '--root', root, 'doctor', 'shell']);
  const result = JSON.parse(stdout);
  assert.ok(Array.isArray(result.deniedHomeDirs));
  assert.ok(Array.isArray(result.grantedReadPaths));
  assert.equal(typeof result.keychainService, 'string');
  assert.ok('loopbackAllow' in result);
  assert.ok('skillsDir' in result);
});

// --- #226: per-model default maxOutputTokens; one retry on an empty length truncation -----------

test('#226: DeepSeek reasoning models default to 16000 maxOutputTokens; other models keep 8192', () => {
  assert.equal(defaultMaxOutputTokens('deepseek/deepseek-r1'), 16000);
  assert.equal(defaultMaxOutputTokens('anthropic/claude'), 8192);
});

test('#226: isEmptyLengthTruncation is true only for finish_reason length with no reply text', () => {
  assert.equal(isEmptyLengthTruncation({ choices: [{ finish_reason: 'length', message: { content: '' } }] }), true);
  assert.equal(isEmptyLengthTruncation({ choices: [{ finish_reason: 'length', message: { content: 'partial' } }] }), false);
  assert.equal(isEmptyLengthTruncation({ choices: [{ finish_reason: 'stop', message: { content: '' } }] }), false);
});

test('#226: executeApi retries once at double the limit on an empty length-truncated openrouter reply, then completes', async t => {
  const pricingBody = { data: [{ id: 'deepseek/deepseek-r1', pricing: { prompt: '0', completion: '0' } }] };
  let call = 0;
  const bodies = [];
  const fetchImpl = async (url, options) => {
    if (String(url).includes('/models')) return new Response(JSON.stringify(pricingBody), { headers: { 'content-type': 'application/json' } });
    call++;
    if (options?.body) bodies.push(JSON.parse(options.body));
    if (call === 1) return new Response(JSON.stringify({ choices: [{ finish_reason: 'length', message: { content: '' } }], model: 'deepseek/deepseek-r1' }), { headers: { 'content-type': 'application/json' } });
    return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ summary: 'ok', files: [], edits: [] }) } }], model: 'deepseek/deepseek-r1', usage: { cost: 0.01 } }), { headers: { 'content-type': 'application/json' } });
  };
  const result = await executeApi(job({ agent: 'openrouter', model: 'deepseek/deepseek-r1', outputs: [] }), [], {
    env: { OPENROUTER_API_KEY: 'sk-fake-secret-token-abcdef' }, fetchImpl,
  });
  assert.equal(result.status, 'complete', result.error);
  assert.equal(result.retriedForLength, true);
  assert.equal(bodies[1].max_tokens, defaultMaxOutputTokens('deepseek/deepseek-r1') * 2);
});

// --- #227: swarm next --from names the next queued ticket's first step -------------------------

test('#227: nextQueuedTicketHint names the first step of the next queued ticket, skipping non-queued ones', () => {
  const text = [
    '## T61: done work',
    'Status: complete',
    '1. scout it',
    '',
    '## T61b: next seat topic',
    'Status: queued',
    '1. scout the contract',
    '2. build it',
  ].join('\n');
  assert.deepEqual(nextQueuedTicketHint(text), { id: 'T61b', title: 'next seat topic', step: 'scout the contract' });
});

test('#227: noJobRunningWarning includes the next-seat hint when idle and a ticket is queued', async t => {
  const root = await fixture(t);
  await fs.mkdir(path.join(root, 'coordination'), { recursive: true });
  await fs.writeFile(path.join(root, 'coordination/TASK.md'), '## T61b: next seat topic\nStatus: queued\n1. scout the contract\n');
  const warning = await noJobRunningWarning({ root, env: {}, dir: path.join(root, '.live-empty'), now: () => Date.now() });
  assert.equal(warning.code, 'no-job-running');
  assert.match(warning.hint, /swarm next --from coordination\/TASK\.md: T61b/);
});

test('#227: swarm next --from prints the same ticket hint from the CLI', async t => {
  const root = await fixture(t);
  await fs.mkdir(path.join(root, 'coordination'), { recursive: true });
  await fs.writeFile(path.join(root, 'coordination/TASK.md'), '## T61b: next seat topic\nStatus: queued\n1. scout the contract\n');
  const CLI = new URL('../tools/swarm.mjs', import.meta.url).pathname;
  const { stdout } = await execFileAsync(process.execPath, [CLI, '--root', root, 'next', '--from', 'coordination/TASK.md']);
  const result = JSON.parse(stdout);
  assert.equal(result.ticket.id, 'T61b');
  assert.equal(result.ticket.step, 'scout the contract');
});

// --- #262: loopbackAllow, a single-port loopback allowlist for the shell sandbox ----------------

test('#262: validateLoopbackAllow refuses invalid-loopback-allow for a non-port value', () => {
  assert.throws(() => validateLoopbackAllow([70000], 'w'), /invalid-loopback-allow/);
  assert.deepEqual(validateLoopbackAllow([21590], 'w'), [21590]);
});

test('#262: validateManifest refuses invalid-loopback-allow and requires shell:true', () => {
  assert.throws(() => validateManifest(manifest([job({ shell: true, loopbackAllow: [0] })])), /invalid-loopback-allow/);
  assert.throws(() => validateManifest(manifest([job({ loopbackAllow: [21590] })])), /loopbackAllow is only supported for claude shell jobs/);
  assert.doesNotThrow(() => validateManifest(manifest([job({ shell: true, loopbackAllow: [21590] })])));
});

test('#262: shellProfile with loopbackAllow set allows only those ports, never the old blanket loopback allow', () => {
  const profile = shellProfile({
    home: '/home/x', worktree: '/home/x/work', commonDir: '/home/x/work/.git', shellDir: '/home/x/work/.shell',
    proxyPort: 9000, loopbackAllow: [21590],
  });
  assert.match(profile, /localhost:21590/);
  assert.ok(!profile.includes('localhost:*'), 'a loopbackAllow profile must never carry the old blanket allow-all-loopback rule');
});

test('#262: shellProfile with loopbackAllow unset keeps today\'s behavior (loopbackDenied, blanket loopback minus denies)', () => {
  const profile = shellProfile({
    home: '/home/x', worktree: '/home/x/work', commonDir: '/home/x/work/.git', shellDir: '/home/x/work/.shell',
    proxyPort: 9000, loopbackDenied: [4405],
  });
  assert.match(profile, /localhost:\*/);
  assert.match(profile, /deny network-outbound \(remote ip "localhost:4405"\)/);
});

// --- #228: ship prints the merge sha and a ready-to-paste mac-check line ------------------------

test('#228: ship returns macCheckLine naming the repo, merge sha and an ISO timestamp after a merge', async t => {
  const root = await fixture(t);
  const payloadPath = path.join(root, 'pr.json');
  await fs.writeFile(payloadPath, JSON.stringify({ title: 'Add feature', head: 'feature-branch', base: 'main', body: 'body text' }));
  const exec = shipExecFixture([
    shipOk(''), // git status
    shipRev('sha123'), // rev-parse HEAD
    shipOk(''), // push
    shipOk('[]'), // pr list (none existing)
    shipOk(JSON.stringify({ number: 7, html_url: 'https://example.com/pr/7' })), // pr create
    shipOk(JSON.stringify({ state: 'OPEN', headRefOid: 'sha123', mergeStateStatus: 'CLEAN', statusCheckRollup: [{ name: 'ci', status: 'COMPLETED', conclusion: 'SUCCESS' }] })), // pr view (ci settled)
    shipOk(''), // pr merge
    shipOk(JSON.stringify({ state: 'MERGED', mergeCommit: { oid: 'mergedsha123' } })), // post-merge view
  ]);
  const result = await ship({
    root, repo: 'acme/widgets', payloadPath, exec, authorEmailExec: authorEmailExecOk,
    runChecks: async () => [{ name: 'unit', status: 'passed', exitCode: 0, tail: '' }],
    sleep: async () => {}, now: () => Date.parse('2026-09-29T12:00:00.000Z'),
  });
  assert.equal(result.status, 'merged', JSON.stringify(result));
  assert.equal(result.mergeSha, 'mergedsha123');
  assert.equal(result.macCheckLine, 'mac-check: acme/widgets@mergedsha123 merged 2026-09-29T12:00:00.000Z');
});
