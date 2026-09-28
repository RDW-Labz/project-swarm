// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { CODEX_FLAGS, codexArgs, codexMessage, codexProfile, codexEnvironment, codexUsage, parseCodexReply, validateReadPaths, resolveReadPaths, git } from '../tools/codex-adapter.mjs';
import { NO_STASH_LINE, MUTANTS_BY_HAND_LINE } from '../tools/swarm-env.mjs';
import { validateManifest, validateProject, runManifest, inspectRun, waitRun, integrateRun, doctor, cancelRun } from '../tools/swarm.mjs';
import { preflightProject } from '../tools/preflight.mjs';

const job = (overrides = {}) => ({ id: 'writer', agent: 'codex', model: 'test-model', prompt: 'Update the output and test it.', context: ['input.txt'], outputs: ['output.txt'], timeoutMs: 5000, ...overrides });
const manifest = overrides => ({ version: 1, jobs: [job(overrides)] });
const launch = { profile: '/repo/run/profile.sb', worktree: '/repo/run/worktrees/job', lastMessage: '/repo/run/worktrees/job/result.json', message: 'task' };
const envelope = JSON.stringify({ files_changed: ['output.txt'], notes: ['Fake worker completed.'] });

async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-codex-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await git(root, ['init']);
  await fs.writeFile(path.join(root, 'input.txt'), 'committed context');
  await fs.writeFile(path.join(root, 'output.txt'), 'committed output');
  await fs.writeFile(path.join(root, 'other.txt'), 'unassigned source');
  await fs.writeFile(path.join(root, '.gitignore'), '.swarm/\nignored.txt\n');
  await git(root, ['add', '.']);
  await git(root, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-m', 'fixture']);
  return root;
}
function fake(script, observe = () => {}) {
  return (command, args, options) => {
    observe(command, args, options);
    assert.equal(command, 'sandbox-exec');
    assert.equal(options.detached, true);
    assert.equal(options.shell, false);
    // Node maps ignore to /dev/null on Unix; it must never create a stdin pipe.
    assert.equal(options.stdio[0], 'ignore');
    return spawn(process.execPath, ['--input-type=module', '-e', `import fs from 'node:fs'; const result = ${JSON.stringify(args[args.indexOf('-o') + 1])}; ${script}`], options);
  };
}
const success = `if(fs.readFileSync('input.txt','utf8')!=='committed context')process.exit(8);fs.writeFileSync('output.txt','proposed');fs.writeFileSync('other.txt','undeclared edit');fs.writeFileSync('extra.txt','undeclared new file');fs.writeFileSync(result,${JSON.stringify(envelope)});process.stderr.write('tokens used\\n1,234\\n');`;
async function removed(root, state) {
  const location = path.join(root, '.swarm/runs', state.id, 'worktrees/writer');
  await assert.rejects(fs.access(location));
  assert.equal((await git(root, ['worktree', 'list', '--porcelain'])).includes(location), false);
}

test('Codex argv always includes explicit model, all required flags, prompt and result path', () => {
  const args = codexArgs(job(), launch);
  assert.deepEqual(args, ['-f', launch.profile, 'codex', 'exec', '-m', 'test-model', '--dangerously-bypass-approvals-and-sandbox', '--skip-git-repo-check', '--ephemeral', '-C', launch.worktree, '-o', launch.lastMessage, 'task']);
  for (const flag of CODEX_FLAGS) assert.ok(args.includes(flag));
  for (const model of [undefined, '', 'bad/model', 'white space', 'x'.repeat(81), 'x\n']) {
    assert.throws(() => validateManifest(manifest({ model })), /model/);
    assert.throws(() => codexArgs(job({ model }), launch), /model/);
  }
  for (const model of ['a', '.x:-_9', 'x'.repeat(80)]) assert.doesNotThrow(() => validateManifest(manifest({ model })));
});

test('codexMessage with no contract includes the blocked rule', () => {
  const j = job();
  const message = codexMessage(j, { contract: null });
  assert.equal(message, `You are a fresh worker in a detached git worktree. Read these context files first: ${JSON.stringify(j.context)}. You may edit only these declared outputs: ${JSON.stringify(j.outputs)}. Do not delete files. Run relevant project tests. Root uncommitted changes are not included.\nRead only the files in your context; other reads may be denied.\nIf a MUST or "do not" rule cannot be met inside your outputs, stop and return status "blocked" with the file you need; never work around a rule. Finish with exactly one JSON line {"files_changed":[...],"notes":[...]} listing changed declared paths and concise notes.\n\n${NO_STASH_LINE}\n${MUTANTS_BY_HAND_LINE}\nTASK:\n${j.prompt}\n`);
  const messageImplicit = codexMessage(j);
  assert.equal(messageImplicit, message);
});

test('codexMessage with contract includes section before prompt with text verbatim', () => {
  const j = job();
  const contractPath = '.swarm-manifests/contract.md';
  const contractText = 'This is the contract.\nMultiple lines.\n';
  const message = codexMessage(j, { contract: { path: contractPath, text: contractText } });
  assert.match(message, /Shared contract \(\.swarm-manifests\/contract\.md\)\. Read it first; it wins over any other file:/);
  assert.ok(message.includes(contractText));
  const contractIndex = message.indexOf('Shared contract');
  const taskIndex = message.indexOf('TASK:');
  assert.ok(contractIndex > 0 && taskIndex > contractIndex, 'contract section appears before TASK');
  assert.equal((message.match(/Shared contract/g) || []).length, 1, 'contract section appears exactly once');
});

test('profile grants exact scopes and ends with sensitive path and keychain service denies', () => {
  const profile = codexProfile({ home: '/Users/example', worktree: '/Users/example/repo/run/job', commonDir: '/Users/example/repo/.git', metadataDir: '/Users/example/repo/.git/worktrees/job', readPaths: ['/opt/toolchain'] });
  assert.ok(profile.startsWith('(version 1)\n(allow default)\n(deny file-read* file-write* (subpath "/Users/example"))'));
  for (const file of ['.codex', '.nvm', '.cache', '.npm', '.local/share/uv', '.gitconfig', 'Library/Caches']) assert.ok(profile.includes(`"/Users/example/${file}"`));
  for (const file of ['/Users/example', '/Users/example/repo', '/Users/example/repo/run']) assert.ok(profile.includes(`(literal "${file}")`));
  assert.ok(profile.includes('(subpath "/opt/toolchain")'));
  const writeRule = profile.split('\n').find(line => line.startsWith('(allow file-write*'));
  assert.ok(!writeRule.includes('"/Users/example/repo/.git"'));
  assert.ok(writeRule.includes('"/Users/example/repo/.git/worktrees/job"'));
  for (const file of ['/private/tmp', '/private/var/folders', '/dev/null']) assert.ok(writeRule.includes(`"${file}"`));
  assert.ok(!writeRule.includes('/opt/toolchain'));
  assert.ok(profile.includes('(deny file-write* (require-not (require-any'));
  const last = profile.trim().split('\n').slice(-2);
  for (const file of ['Library/Keychains', '.ssh', '.aws', '.config']) assert.ok(last[0].includes(`"/Users/example/${file}"`));
  assert.equal(last[0].includes('/Users/example/.acme-app'), false, 'no directory outside the generic deny list by default');
  assert.equal(last[1], '(deny mach-lookup (global-name "com.apple.SecurityServer") (global-name "com.apple.securityd.xpc"))');
  for (const field of ['home', 'worktree', 'commonDir', 'metadataDir']) for (const unsafe of ['/bad"path', '/bad\\path', '/bad\npath', 'relative']) assert.throws(() => codexProfile({ home: '/Users/example', worktree: '/repo/job', commonDir: '/repo/.git', metadataDir: '/repo/.git/worktrees/job', [field]: unsafe }), /sandbox path/);
  // Config deniedHomeDirs is still denied (never a weaker guard than before).
  const configured = codexProfile({ home: '/Users/example', worktree: '/Users/example/repo/run/job', commonDir: '/Users/example/repo/.git', metadataDir: '/Users/example/repo/.git/worktrees/job', readPaths: ['/opt/toolchain'], config: { deniedHomeDirs: ['.acme-app'] } });
  assert.ok(configured.trim().split('\n').slice(-2)[0].includes('"/Users/example/.acme-app"'));
});

test('readPaths is Codex-only, absolute, safe and cannot name denied directories', () => {
  const home = os.homedir();
  for (const paths of [null, 'path', ['relative'], ['/bad"path'], ['/bad\\path'], ['/bad\npath'], Array(101).fill('/opt')]) assert.throws(() => validateManifest(manifest({ readPaths: paths })));
  for (const denied of ['Library/Keychains', '.ssh', '.aws', '.config']) for (const suffix of ['', '/child', '/a/../child']) assert.throws(() => validateReadPaths([path.join(home, denied) + suffix]), /denied/);
  // A project's own config deniedHomeDirs addition (e.g. '.acme-app') is still denied, never dropped.
  for (const suffix of ['', '/child', '/a/../child']) assert.throws(() => validateReadPaths([path.join(home, '.acme-app') + suffix], home, { deniedHomeDirs: ['.acme-app'] }), /denied/);
  assert.throws(() => validateManifest(manifest({ agent: 'claude', readPaths: ['/opt'] })), /codex-only/);
  assert.deepEqual(validateReadPaths(['/opt/toolchain']), ['/opt/toolchain']);
});

test('doctor checks platform, executable, version, login, and exact help flags with no model call', async () => {
  const calls = [];
  const exec = async (command, args) => { calls.push([command, args]); return { stdout: args.includes('--help') ? CODEX_FLAGS.join(' ') : 'fixture' }; };
  assert.equal((await doctor({ agent: 'codex', platform: 'darwin', exec })).status, 'compatible');
  assert.deepEqual(calls.slice(0, 4).map(call => call[1]), [['sandbox-exec'], ['--version'], ['login', 'status'], ['exec', '--help']]);
  for (const unavailable of ['sandbox-exec', '--version', 'login']) await assert.rejects(doctor({ agent: 'codex', platform: 'darwin', exec: async (cmd, args) => { if (args.includes(unavailable)) throw Error('unavailable'); return exec(cmd, args); } }), /unavailable/);
  for (const flag of CODEX_FLAGS) await assert.rejects(doctor({ agent: 'codex', platform: 'darwin', exec: async (_cmd, args) => ({ stdout: args.includes('--help') ? CODEX_FLAGS.filter(item => item !== flag).join(' ') : 'fixture' }) }), /required flags/);
  for (const platform of ['linux', 'win32']) {
    const result = await doctor({ agent: 'codex', platform, exec: () => assert.fail('must not probe') });
    assert.equal(result.status, 'unsupported');
    await assert.rejects(runManifest(process.cwd(), manifest(), { platform, spawnImpl: () => assert.fail('must not spawn') }), /macOS seatbelt/);
  }
});

test('TLS environment uses certificate file when present and preserves environment otherwise', async () => {
  assert.deepEqual(await codexEnvironment({ PATH: '/bin', SSL_CERT_FILE: 'old' }, async file => { assert.equal(file, '/etc/ssl/cert.pem'); return true; }), { PATH: '/bin', SSL_CERT_FILE: '/etc/ssl/cert.pem' });
  assert.deepEqual(await codexEnvironment({ PATH: '/bin' }, async () => false), { PATH: '/bin' });
});

test('the reply envelope accepts any object (lesson #64) and the token parser invents no usage', () => {
  assert.deepEqual(parseCodexReply(envelope), { files_changed: ['output.txt'], notes: ['Fake worker completed.'] });
  assert.deepEqual(parseCodexReply(JSON.stringify({ filesChanged: ['output.txt'], testsAdded: 3, crossJobNames: [], notes: 'done' })), { filesChanged: ['output.txt'], testsAdded: 3, crossJobNames: [], notes: 'done' });
  for (const text of ['not json', '[1,2]', '', undefined]) assert.equal(parseCodexReply(text), null);
  assert.deepEqual(codexUsage('tokens used\n1,234\n'), { total_tokens: 1234 });
  assert.equal(codexUsage('no usage'), null);
});

test('HEAD worktree runs with null stdin, collects only declared outputs, integrates and removes checkout', async t => {
  const root = await fixture(t);
  await fs.writeFile(path.join(root, 'input.txt'), 'uncommitted context');
  let received;
  const state = await runManifest(root, manifest(), { platform: 'darwin', spawnImpl: fake(success, (command, args, options) => { received = { command, args, options }; }) });
  assert.equal(state.status, 'complete', state.error ?? state.jobs[0]?.error);
  assert.equal(received.options.cwd, path.join(root, '.swarm/runs', state.id, 'worktrees/writer'));
  assert.equal(received.args[received.args.indexOf('-m') + 1], 'test-model');
  if (await fs.access('/etc/ssl/cert.pem').then(() => true, () => false)) assert.equal(received.options.env.SSL_CERT_FILE, '/etc/ssl/cert.pem');
  assert.equal(state.summary.usageByProvider.codex.total_tokens, 1234);
  assert.equal(await fs.readFile(path.join(root, '.swarm/runs', state.id, 'writer/response.txt'), 'utf8'), envelope);
  assert.match(await fs.readFile(path.join(root, '.swarm/runs', state.id, 'writer/message.txt'), 'utf8'), /Read these context files first: \["input.txt"\]/);
  assert.deepEqual(await fs.readdir(path.join(root, state.jobs[0].workspace)), ['output.txt']);
  await removed(root, state);
  assert.equal((await inspectRun(root, state.id)).files[0].status, 'ready');
  assert.deepEqual((await integrateRun(root, state.id)).files, ['output.txt']);
  assert.equal(await fs.readFile(path.join(root, 'other.txt'), 'utf8'), 'unassigned source');
  await assert.rejects(fs.access(path.join(root, 'extra.txt')));
});

for (const scenario of ['failed', 'timeout', 'cancelled', 'malformed', 'missing-output', 'symlink-output', 'launch-error']) test(`Codex removes worktree and blocks proposals after ${scenario}, except a malformed envelope with no worktree evidence, which is kept (lessons #41, #64)`, async t => {
  const root = await fixture(t);
  let launched = false;
  const controller = new AbortController();
  const script = scenario === 'failed' ? 'process.exit(7)' : scenario === 'malformed' ? `fs.writeFileSync(result,'bad json')` : scenario === 'missing-output' ? `fs.unlinkSync('output.txt');fs.writeFileSync(result,${JSON.stringify(envelope)})` : scenario === 'symlink-output' ? `fs.unlinkSync('output.txt');fs.symlinkSync('other.txt','output.txt');fs.writeFileSync(result,${JSON.stringify(envelope)})` : 'setInterval(()=>{},1000)';
  const signals = [];
  const state = await runManifest(root, manifest({ timeoutMs: scenario === 'timeout' ? 100 : 5000 }), {
    platform: 'darwin', signal: controller.signal,
    killImpl: (pid, signal) => { signals.push({ pid, signal }); return process.kill(pid, signal); },
    spawnImpl: (...args) => {
      launched = true;
      if (scenario === 'launch-error') throw Error('fake launch error');
      const child = fake(script)(...args);
      if (scenario === 'cancelled') setTimeout(() => controller.abort(), 40);
      return child;
    },
  });
  assert.equal(launched, true);
  assert.equal(state.jobs[0].status, ['timeout', 'cancelled'].includes(scenario) ? scenario : 'failed');
  if (['timeout', 'cancelled'].includes(scenario)) assert.ok(signals.some(call => call.pid < 0 && call.signal === 'SIGTERM'));
  const worktree = path.join(root, '.swarm/runs', state.id, 'worktrees/writer');
  if (scenario === 'malformed') {
    // A clean exit with an invalid final envelope is the only evidence of what codex did; keep it.
    await fs.access(worktree);
    assert.equal((await git(root, ['worktree', 'list', '--porcelain'])).includes(worktree), true);
    assert.equal(state.jobs[0].keptWorkspace, worktree);
    assert.equal(state.jobs[0].error, `envelope invalid; worktree kept at ${worktree}`);
  } else {
    await removed(root, state);
    assert.equal(state.jobs[0].keptWorkspace, null);
  }
  await assert.rejects(integrateRun(root, state.id));
  assert.deepEqual(await fs.readdir(path.join(root, state.jobs[0].workspace)), []);
});

test('a real run threads config deniedHomeDirs into the generated sandbox profile', async t => {
  const root = await fixture(t);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-codex-config-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const configFile = path.join(dir, 'config.json');
  await fs.writeFile(configFile, JSON.stringify({ deniedHomeDirs: ['.acme-app'] }));
  const state = await runManifest(root, manifest(), { platform: 'darwin', env: { ...process.env, SWARM_CONFIG: configFile }, spawnImpl: fake(success) });
  assert.equal(state.status, 'complete', state.error ?? state.jobs[0]?.error);
  const profile = await fs.readFile(path.join(root, '.swarm/runs', state.id, 'writer/sandbox.sb'), 'utf8');
  assert.match(profile, /\.acme-app/);
});

test('Codex proposals retain ordinary conflict detection', async t => {
  const root = await fixture(t);
  const state = await runManifest(root, manifest(), { platform: 'darwin', spawnImpl: fake(success) });
  await fs.writeFile(path.join(root, 'output.txt'), 'coordinator edit');
  assert.equal((await inspectRun(root, state.id)).files[0].status, 'conflict');
  await assert.rejects(integrateRun(root, state.id), /Integration conflict/);
});

test('a reply with extra final-JSON keys beyond files_changed/notes completes cleanly, not just with a warning (lesson #64)', async t => {
  const root = await fixture(t);
  const extraEnvelope = JSON.stringify({ filesChanged: ['output.txt'], testsAdded: 2, crossJobNames: [], notes: 'Fake worker completed.' });
  const script = `fs.writeFileSync('output.txt','proposed');fs.writeFileSync(result,${JSON.stringify(extraEnvelope)});`;
  const plan = manifest({ prompt: 'Finish with one JSON line {"filesChanged":[...],"testsAdded":n,"crossJobNames":[...],"notes":"..."}.' });
  const state = await runManifest(root, plan, { platform: 'darwin', spawnImpl: fake(script) });
  assert.equal(state.status, 'complete', state.error ?? state.jobs[0]?.error);
  assert.equal(state.jobs[0].envelopeFallback, null);
  assert.deepEqual((await validateProject(root, plan)).warnings, []);
});

test('a reply with no parseable JSON but worktree changes to declared outputs falls back to a worktree result and keeps the worktree (lesson #64)', async t => {
  const root = await fixture(t);
  const script = `fs.writeFileSync('output.txt','proposed');fs.writeFileSync('other.txt','undeclared edit');fs.writeFileSync(result,'no JSON in this reply, just prose');`;
  const state = await runManifest(root, manifest(), { platform: 'darwin', spawnImpl: fake(script) });
  assert.equal(state.status, 'complete', state.error ?? state.jobs[0]?.error);
  assert.equal(state.jobs[0].envelopeFallback, 'worktree');
  const worktree = path.join(root, '.swarm/runs', state.id, 'worktrees/writer');
  await fs.access(worktree);
  assert.equal((await git(root, ['worktree', 'list', '--porcelain'])).includes(worktree), true);
  assert.equal(state.jobs[0].keptWorkspace, worktree);
  assert.deepEqual((await inspectRun(root, state.id)).warnings, [`codex envelope fallback: worktree (writer)`]);
  assert.deepEqual((await waitRun(root, state.id)).warnings, [`codex envelope fallback: worktree (writer)`]);
  assert.deepEqual((await integrateRun(root, state.id)).files, ['output.txt']);
  assert.equal(await fs.readFile(path.join(root, 'other.txt'), 'utf8'), 'unassigned source');
});

test('validate and preflight warn about staged, unstaged, untracked and ignored declared paths only', async t => {
  const root = await fixture(t);
  assert.deepEqual((await validateProject(root, manifest())).warnings, []);
  await fs.writeFile(path.join(root, 'input.txt'), 'staged change');
  await git(root, ['add', 'input.txt']);
  // The working file matches HEAD again, but the index still contains a staged change.
  await fs.writeFile(path.join(root, 'input.txt'), 'committed context');
  await fs.writeFile(path.join(root, 'output.txt'), 'unstaged change');
  await fs.writeFile(path.join(root, 'new.txt'), 'untracked');
  await fs.writeFile(path.join(root, 'ignored.txt'), 'ignored');
  await fs.writeFile(path.join(root, 'other.txt'), 'irrelevant edit');
  const plan = manifest({ outputs: ['output.txt', 'new.txt', 'ignored.txt'] });
  const report = await validateProject(root, plan);
  assert.deepEqual(report.warnings[0].files, ['input.txt', 'output.txt', 'new.txt', 'ignored.txt']);
  const preflight = await preflightProject(root, plan);
  assert.equal(preflight.reviewRequired, true);
  assert.deepEqual(preflight.advisories[0], report.warnings[0]);
});

test('cancellation marker removes running Codex worktree and never creates queued worktree', async t => {
  const root = await fixture(t);
  let launched = 0;
  const state = await runManifest(root, { version: 1, concurrency: 1, jobs: [job(), job({ id: 'queued', outputs: [] })] }, {
    platform: 'darwin', id: 'cancel-marker', spawnImpl: (...args) => {
      launched++;
      const child = fake('setInterval(()=>{},1000)')(...args);
      setTimeout(() => cancelRun(root, 'cancel-marker'), 40);
      return child;
    },
  });
  assert.equal(state.status, 'cancelled');
  assert.equal(launched, 1);
  await removed(root, state);
  await assert.rejects(fs.access(path.join(root, '.swarm/runs/cancel-marker/worktrees/queued')));
});


test('resolved readPaths aliases cannot grant a forbidden directory', async t => {
  const root = await fixture(t);
  const home = path.join(root, 'home');
  await fs.mkdir(path.join(home, '.acme-app'), { recursive: true });
  await fs.symlink(path.join(home, '.acme-app'), path.join(root, 'toolchain-alias'));
  // '.acme-app' is only denied once a project's config names it (deniedHomeDirs); the alias must
  // still be caught through that config, the same as any built-in denied directory.
  await assert.rejects(resolveReadPaths([path.join(root, 'toolchain-alias')], home, { deniedHomeDirs: ['.acme-app'] }), /denied/);
  await fs.mkdir(path.join(root, 'toolchain'));
  const plan = manifest({ readPaths: [path.join(root, 'toolchain')] });
  assert.equal((await validateProject(root, plan)).status, 'valid');
});
