// SPDX-License-Identifier: Apache-2.0
// The cursor worker: a worktree writer like codex, run as `sandbox-exec -f <profile> cursor-agent
// ...` with CURSOR_API_KEY in its environment only. Every test here uses a FAKE cursor-agent (a
// /bin/sh script on a temporary PATH); no real cursor-agent job ever runs.
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { CURSOR_FLAGS, CURSOR_DEFAULTS, CURSOR_NOT_AUTHENTICATED, cursorArgs, cursorLaunchArgs, cursorEnvironment, cursorProfile, cursorMessage, cursorConfig, cursorDoctor, requireCursorApiKey, resolveCursorBinary, parseCursorOutput, resolveCursorEnvelope, redactCursorKey } from '../tools/cursor-adapter.mjs';
import { runCodexWithRetry, git } from '../tools/codex-adapter.mjs';
import { validateManifest, runManifest, inspectRun, integrateRun, resolveWorktree, doctor } from '../tools/swarm.mjs';

const KEY = 'crsr_FAKE_TEST_KEY_0123456789';
const job = (overrides = {}) => ({ id: 'writer', agent: 'cursor', model: 'composer-2.5', prompt: 'Update the output and test it.', context: ['input.txt'], outputs: ['output.txt'], timeoutMs: 10000, ...overrides });
const manifest = overrides => ({ version: 1, jobs: [job(overrides)] });
const envelope = { files_changed: ['output.txt'], notes: ['Fake cursor worker completed.'] };
const cursorResult = text => JSON.stringify({ type: 'result', subtype: 'success', is_error: false, duration_ms: 12, result: text, session_id: 'fake-session' });
const sq = value => `'${String(value).replace(/'/g, `'\\''`)}'`;

async function tempDir(t, prefix) {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(process.env.SWARM_TEST_TMP || os.tmpdir(), prefix)));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}
async function fixture(t) {
  const root = await tempDir(t, 'swarm-cursor-');
  await git(root, ['init']);
  await fs.writeFile(path.join(root, 'input.txt'), 'committed context');
  await fs.writeFile(path.join(root, 'output.txt'), 'committed output');
  await fs.writeFile(path.join(root, '.gitignore'), '.swarm/\n');
  await git(root, ['add', '.']);
  await git(root, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-m', 'fixture']);
  return root;
}
// A fake cursor-agent: installed as <dir>/versions/1/cursor-agent with a <dir>/bin symlink, like
// the real ~/.local/bin -> ~/.local/share/cursor-agent/versions/<ver>/ layout.
async function fakeCursor(t, body) {
  const dir = await tempDir(t, 'swarm-fake-cursor-');
  const versionDir = path.join(dir, 'versions', '1'), binDir = path.join(dir, 'bin');
  await fs.mkdir(versionDir, { recursive: true });
  await fs.mkdir(binDir);
  const real = path.join(versionDir, 'cursor-agent');
  await fs.writeFile(real, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  await fs.symlink(real, path.join(binDir, 'cursor-agent'));
  return { dir, real, versionDir, binDir };
}
const success = `printf 'proposed by cursor' > output.txt
printf '%s\\n' ${sq(cursorResult(`Done.\n${JSON.stringify(envelope)}`))}`;
// Runs the fake binary directly in place of sandbox-exec, after checking the sandbox argv shape.
function viaFake(observe = () => {}) {
  return (command, args, options) => {
    assert.equal(command, 'sandbox-exec');
    assert.equal(args[0], '-f');
    assert.equal(options.detached, true);
    assert.equal(options.shell, false);
    assert.equal(options.stdio[0], 'ignore');
    observe(args, options);
    return spawn(args[2], args.slice(3), options);
  };
}
const runEnv = (fake, extra = {}) => ({ ...process.env, PATH: `${fake.binDir}:/usr/bin:/bin`, CURSOR_API_KEY: KEY, SWARM_KEEP_TMP: '0', ...extra });

test('cursorArgs is exactly print/json/model/trust/workspace/sandbox disabled/force/message, never a forbidden flag', () => {
  const args = cursorArgs(job(), { worktree: '/repo/wt/job', message: 'task' });
  assert.deepEqual(args, ['-p', '--output-format', 'json', '--model', 'composer-2.5', '--trust', '--workspace', '/repo/wt/job', '--sandbox', 'disabled', '--force', 'task']);
  for (const flag of CURSOR_FLAGS) assert.ok(args.includes(flag), flag);
  for (const flag of ['--api-key', '--worktree', '-w', '--approve-mcps']) assert.equal(args.includes(flag), false, flag);
  for (const model of [undefined, '', 'white space', 'bad/model', 'x'.repeat(81), 'x\n']) {
    assert.throws(() => cursorArgs(job({ model }), { worktree: '/w', message: 'm' }), /valid explicit model/);
    assert.throws(() => validateManifest(manifest({ model })), /model/);
  }
  for (const model of ['composer-2.5', 'gpt-5', 'claude-opus-4-8[context=1m,effort=high]']) assert.doesNotThrow(() => validateManifest(manifest({ model })));
});

test('cursorLaunchArgs wraps the real binary in sandbox-exec and refuses the key in argv', () => {
  const launch = { profile: '/repo/run/sandbox.sb', bin: '/opt/cursor/versions/1/cursor-agent', worktree: '/repo/wt/job', message: 'task', apiKey: KEY };
  assert.deepEqual(cursorLaunchArgs(job(), launch), ['-f', '/repo/run/sandbox.sb', '/opt/cursor/versions/1/cursor-agent', ...cursorArgs(job(), launch)]);
  assert.throws(() => cursorLaunchArgs(job(), { ...launch, message: `use ${KEY}` }), /cursor-key-in-argv/);
  assert.throws(() => cursorLaunchArgs(job({ model: `m-${KEY}` }), launch), /cursor-key-in-argv/);
});

test('cursorEnvironment is an allowlist plus CURSOR_API_KEY; no other secret or the endpoint override passes', async () => {
  const env = await cursorEnvironment({ PATH: '/bin', HOME: '/h', LANG: 'C', CURSOR_API_KEY: KEY, CURSOR_API_ENDPOINT: 'https://evil.example', OPENAI_API_KEY: 'o', ANTHROPIC_API_KEY: 'a', GITHUB_TOKEN: 'g', AWS_SECRET_ACCESS_KEY: 's', SWARM_CLAUDE_WORKER_API_KEY: 'w', BAD: 'x\ny' }, async () => true);
  assert.deepEqual(env, { PATH: '/bin', HOME: '/h', LANG: 'C', CURSOR_API_KEY: KEY, SSL_CERT_FILE: '/etc/ssl/cert.pem' });
  assert.deepEqual(await cursorEnvironment({ PATH: '/bin' }, async () => false), { PATH: '/bin' });
});

test('cursorProfile is the codex profile plus the install dir (read+exec) and ~/.cursor (read+write); Keychain stays denied', async t => {
  const base = await tempDir(t, 'swarm-cursor-profile-');
  const home = path.join(base, 'home'), worktree = path.join(base, 'wt'), installDir = path.join(base, 'install', 'versions', '1');
  const profile = cursorProfile({ home, worktree, commonDir: path.join(base, 'repo/.git'), metadataDir: path.join(base, 'repo/.git/worktrees/wt'), installDir });
  const execLine = profile.split('\n').find(line => line.startsWith('(allow process-exec'));
  assert.ok(execLine.includes(`(subpath "${installDir}")`));
  const writeLine = profile.split('\n').find(line => line.startsWith('(allow file-write*'));
  assert.ok(writeLine.includes(`(subpath "${path.join(home, '.cursor')}")`));
  assert.ok(writeLine.includes(`(subpath "${worktree}")`));
  assert.equal(writeLine.includes(`(subpath "${home}")`), false, 'home itself is never writable');
  assert.match(profile, /\(deny mach-lookup \(global-name "com\.apple\.SecurityServer"\) \(global-name "com\.apple\.securityd\.xpc"\)\)\n$/);
  const lines = profile.trimEnd().split('\n');
  assert.ok(lines.at(-2).startsWith('(deny file-read* file-write*') && lines.at(-2).includes('Library/Keychains') && lines.at(-2).includes('.ssh'));
  for (const denied of ['.ssh', 'Library/Keychains', '.config/cursor']) assert.throws(() => cursorProfile({ home, worktree, commonDir: path.join(base, 'repo/.git'), metadataDir: path.join(base, 'm'), installDir: path.join(home, denied) }), /denied home directory/);
});

test('fail fast: missing key, malformed key and missing binary carry stable codes and never echo a key', async t => {
  assert.throws(() => requireCursorApiKey({}), error => error.message === CURSOR_NOT_AUTHENTICATED && error.code === 'cursor-not-authenticated');
  assert.equal(CURSOR_NOT_AUTHENTICATED, 'cursor-not-authenticated: set CURSOR_API_KEY in the swarm environment (Keychain login is blocked by the sandbox)');
  assert.throws(() => requireCursorApiKey({ CURSOR_API_KEY: '  ' }), /cursor-not-authenticated/);
  assert.throws(() => requireCursorApiKey({ CURSOR_API_KEY: 'has space inside' }), error => /malformed/.test(error.message) && !error.message.includes('has space'));
  assert.equal(requireCursorApiKey({ CURSOR_API_KEY: KEY }), KEY);
  await assert.rejects(resolveCursorBinary({ PATH: '/nonexistent-dir' }), /^Error: cursor-not-installed: cursor-agent was not found on PATH/);
  const fake = await fakeCursor(t, 'exit 0');
  assert.deepEqual(await resolveCursorBinary({ PATH: `/nonexistent-dir:${fake.binDir}` }), { bin: fake.real, installDir: fake.versionDir });
});

test('cursorConfig defaults and validates model, timeout, attempts and allowedPaths', () => {
  assert.deepEqual(CURSOR_DEFAULTS, { model: 'composer-2.5', timeoutMs: 300000, maxAttempts: 2, allowedPaths: [] });
  assert.deepEqual(cursorConfig({}, '/h'), { model: 'composer-2.5', timeoutMs: 300000, maxAttempts: 2, allowedPaths: [] });
  assert.deepEqual(cursorConfig({ cursor: { timeoutMs: 900000, maxAttempts: 3, allowedPaths: ['/opt/tool'] } }, '/h'), { model: 'composer-2.5', timeoutMs: 900000, maxAttempts: 3, allowedPaths: ['/opt/tool'] });
  for (const cursor of [{ model: 'bad model' }, { timeoutMs: 10 }, { maxAttempts: 0 }, { maxAttempts: 9 }, { allowedPaths: ['relative'] }, { allowedPaths: ['/h/.ssh'] }, []]) assert.throws(() => cursorConfig({ cursor }, '/h'), String(JSON.stringify(cursor)));
});

test('cursorMessage is the codex prompt and refuses a prompt carrying the key', () => {
  const message = cursorMessage(job(), { apiKey: KEY });
  assert.match(message, /You are a fresh worker in a detached git worktree/);
  assert.match(message, /Finish with exactly one JSON line/);
  assert.match(cursorMessage(job({ outputs: ['docs/plan.md'] }), {}), /^Design-only job/);
  assert.throws(() => cursorMessage(job({ prompt: `use ${KEY}` }), { apiKey: KEY }), /cursor-key-in-prompt/);
});

test('cursor JSON output parsing and envelope resolution follow the codex rule with a worktree fallback', async t => {
  assert.equal(parseCursorOutput('not json'), null);
  const parsed = parseCursorOutput(`noise\n${cursorResult('hello {"files_changed":["output.txt"]}')}\n`);
  assert.equal(parsed.isError, false);
  assert.equal(parsed.response, 'hello {"files_changed":["output.txt"]}');
  assert.equal(parseCursorOutput(JSON.stringify({ type: 'result', subtype: 'error', is_error: true, result: 'boom' })).isError, true);
  const root = await fixture(t);
  assert.deepEqual((await resolveCursorEnvelope(cursorResult(JSON.stringify(envelope)), root, job())).result, envelope);
  assert.equal(await resolveCursorEnvelope(cursorResult('no envelope'), root, job()), null);
  await fs.writeFile(path.join(root, 'output.txt'), 'edited');
  assert.deepEqual(await resolveCursorEnvelope(cursorResult('no envelope'), root, job()), { result: { filesChanged: ['output.txt'], fallback: 'worktree' }, response: 'no envelope', fallback: 'worktree' });
  assert.equal(redactCursorKey(`a ${KEY} b ${KEY}`, KEY), 'a [cursor-key-redacted] b [cursor-key-redacted]');
});

test('runCodexWithRetry honours maxAttempts and the cursor blip regex', async () => {
  const blip = { status: 'failed', stderr: 'Error: socket hang up' };
  let launches = 0;
  const reasons = [];
  const result = await runCodexWithRetry(async () => { launches++; return blip; }, { hasWrittenOutputs: async () => false, onRetry: async (reason, attempt) => { reasons.push([reason, attempt]); }, maxAttempts: 3, blipRe: /socket hang up/, label: 'cursor-blip' });
  assert.equal(result, blip);
  assert.equal(launches, 3);
  assert.deepEqual(reasons, [['cursor-blip: socket hang up', 1], ['cursor-blip: socket hang up', 2]]);
  launches = 0;
  await runCodexWithRetry(async () => { launches++; return blip; }, { hasWrittenOutputs: async () => false, onRetry: async () => {}, maxAttempts: 1, blipRe: /socket hang up/ });
  assert.equal(launches, 1);
  launches = 0;
  await runCodexWithRetry(async () => { launches++; return { status: 'failed', stderr: 'model not found' }; }, { hasWrittenOutputs: async () => false, onRetry: async () => {}, maxAttempts: 3, blipRe: /socket hang up/ });
  assert.equal(launches, 1);
});

test('cursor jobs pass the worktree-writer gates (testEnv, readPaths, setup) and refuse after, like codex', () => {
  assert.doesNotThrow(() => validateManifest(manifest({ testEnv: { MARKER: '1' }, readPaths: ['/opt/tool'], setup: [['npm', 'ci']] })));
  assert.throws(() => validateManifest({ version: 1, jobs: [job({ id: 'a', outputs: ['a.txt'] }), job({ id: 'b', outputs: ['b.txt'], after: ['a'] })] }), /after is not supported for cursor jobs yet/);
  assert.throws(() => validateManifest({ version: 1, jobs: [job({ id: 'a' }), job({ id: 'b' })] }), /Output collision/);
});

test('doctor cursor reports version and flags from a fake binary and never prints the key', async t => {
  const fake = await fakeCursor(t, `case "$1" in --version) echo 2026.10.01-fake;; --help) echo "${CURSOR_FLAGS.map(flag => `  ${flag} <x>`).join('\\n')}";; esac`);
  const env = { PATH: `${fake.binDir}:/usr/bin:/bin`, CURSOR_API_KEY: KEY };
  const result = await doctor({ agent: 'cursor', platform: 'darwin', env });
  assert.equal(result.status, 'compatible');
  assert.equal(result.version, '2026.10.01-fake');
  assert.equal(result.auth, 'CURSOR_API_KEY set');
  assert.equal(JSON.stringify(result).includes(KEY), false);
  const missingKey = await cursorDoctor({ platform: 'darwin', env: { PATH: env.PATH } });
  assert.equal(missingKey.status, 'not-authenticated');
  assert.equal(missingKey.note, CURSOR_NOT_AUTHENTICATED);
  const noForce = await fakeCursor(t, `case "$1" in --version) echo v;; --help) echo "  -p --output-format --model --trust --workspace --sandbox";; esac`);
  await assert.rejects(cursorDoctor({ platform: 'darwin', env: { PATH: `${noForce.binDir}:/usr/bin:/bin`, CURSOR_API_KEY: KEY } }), /Cursor lacks required flags: --force/);
  await assert.rejects(cursorDoctor({ platform: 'darwin', env: { PATH: '/nonexistent' } }), /cursor-not-installed/);
  assert.equal((await cursorDoctor({ platform: 'linux' })).status, 'unsupported');
});

test('run refuses a cursor job before any spawn: wrong platform, no binary, no key', async t => {
  const root = await fixture(t);
  const fake = await fakeCursor(t, success);
  const never = () => assert.fail('must not spawn');
  await assert.rejects(runManifest(root, manifest(), { platform: 'linux', env: runEnv(fake), spawnImpl: never }), /macOS seatbelt is required/);
  await assert.rejects(runManifest(root, manifest(), { platform: 'darwin', env: runEnv(fake, { PATH: '/usr/bin:/bin' }), spawnImpl: never }), /cursor-not-installed/);
  const { CURSOR_API_KEY, ...noKey } = runEnv(fake);
  assert.equal(CURSOR_API_KEY, KEY);
  await assert.rejects(runManifest(root, manifest(), { platform: 'darwin', env: noKey, spawnImpl: never }), new RegExp(CURSOR_NOT_AUTHENTICATED.replace(/[()]/g, '\\$&')));
});

test('integration: a cursor job runs end to end through swarm.mjs with a fake cursor-agent and integrates', async t => {
  const root = await fixture(t);
  const fake = await fakeCursor(t, `[ -n "$CURSOR_API_KEY" ] || exit 9\n[ -z "$OPENAI_API_KEY" ] || exit 10\n${success}`);
  let seen;
  const state = await runManifest(root, manifest(), { platform: 'darwin', env: runEnv(fake, { OPENAI_API_KEY: 'must-not-pass' }), spawnImpl: viaFake((args, options) => { seen = { args, options }; }) });
  assert.equal(state.status, 'complete', state.error ?? state.jobs[0]?.error);
  assert.equal(seen.args[2], fake.real);
  assert.deepEqual(seen.args.slice(3, 14), ['-p', '--output-format', 'json', '--model', 'composer-2.5', '--trust', '--workspace', resolveWorktree(state, state.jobs[0]), '--sandbox', 'disabled', '--force']);
  assert.equal(seen.args.some(arg => arg.includes(KEY)), false, 'key never in argv');
  assert.equal(seen.options.env.CURSOR_API_KEY, KEY);
  assert.equal(seen.options.env.OPENAI_API_KEY, undefined);
  assert.equal(seen.options.cwd, resolveWorktree(state, state.jobs[0]));
  const profile = await fs.readFile(path.join(root, '.swarm/runs', state.id, 'writer/sandbox.sb'), 'utf8');
  assert.ok(profile.includes(`(subpath "${fake.versionDir}")`));
  assert.match(profile, /com\.apple\.SecurityServer/);
  const message = await fs.readFile(path.join(root, '.swarm/runs', state.id, 'writer/message.txt'), 'utf8');
  assert.equal(message, seen.args.at(-1));
  assert.equal(message.includes(KEY), false);
  assert.match(await fs.readFile(path.join(root, '.swarm/runs', state.id, 'writer/response.txt'), 'utf8'), /files_changed/);
  assert.equal((await inspectRun(root, state.id)).files[0].status, 'ready');
  assert.deepEqual((await integrateRun(root, state.id, { env: runEnv(fake) })).files, ['output.txt']);
  assert.equal(await fs.readFile(path.join(root, 'output.txt'), 'utf8'), 'proposed by cursor');
  await assert.rejects(fs.access(resolveWorktree(state, state.jobs[0])));
});

test('integration: a nonzero cursor exit fails the job with exit code and stderr, and nothing integrates', async t => {
  const root = await fixture(t);
  const fake = await fakeCursor(t, `echo 'Error: model unavailable' >&2\nexit 3`);
  const state = await runManifest(root, manifest(), { platform: 'darwin', env: runEnv(fake), spawnImpl: viaFake() });
  assert.equal(state.jobs[0].status, 'failed');
  assert.equal(state.jobs[0].exitCode, 3);
  assert.match(state.jobs[0].error, /Cursor exited 3/);
  assert.match(state.jobs[0].agentError, /model unavailable/);
  assert.equal(state.jobs[0].retries, undefined, 'a non-transient error is never retried');
  await assert.rejects(integrateRun(root, state.id, { env: runEnv(fake) }));
});

test('integration: a transient cursor error is retried up to config.cursor.maxAttempts', async t => {
  const root = await fixture(t);
  const counter = path.join(await tempDir(t, 'swarm-cursor-count-'), 'count');
  const fake = await fakeCursor(t, `n=$(cat ${sq(counter)} 2>/dev/null || echo 0); n=$((n+1)); echo $n > ${sq(counter)}\nif [ "$n" -lt 3 ]; then echo 'Error: socket hang up' >&2; exit 1; fi\n${success}`);
  const configDir = await tempDir(t, 'swarm-cursor-config-');
  await fs.writeFile(path.join(configDir, 'config.json'), JSON.stringify({ cursor: { maxAttempts: 3 } }));
  const state = await runManifest(root, manifest(), { platform: 'darwin', env: runEnv(fake, { SWARM_CONFIG: path.join(configDir, 'config.json') }), spawnImpl: viaFake() });
  assert.equal(state.status, 'complete', state.jobs[0]?.error);
  assert.equal(state.jobs[0].retries, 2);
  assert.equal(state.jobs[0].retryReason, 'cursor-blip: socket hang up');
  assert.equal((await fs.readFile(counter, 'utf8')).trim(), '3');
});

const walk = async dir => (await Promise.all((await fs.readdir(dir, { withFileTypes: true })).map(entry => entry.isDirectory() ? walk(path.join(dir, entry.name)) : [path.join(dir, entry.name)]))).flat();
test('integration: a key the worker writes into an output fails the job, keeps no worktree and leaves no copy', async t => {
  const root = await fixture(t);
  const fake = await fakeCursor(t, `printf '%s' "$CURSOR_API_KEY" > output.txt\nprintf '%s\\n' ${sq(cursorResult(JSON.stringify(envelope)))}`);
  const state = await runManifest(root, manifest(), { platform: 'darwin', env: runEnv(fake), spawnImpl: viaFake() });
  assert.equal(state.jobs[0].status, 'failed');
  assert.equal(state.jobs[0].workerKeyExposed, true);
  assert.match(state.jobs[0].error, /output contains CURSOR_API_KEY: output\.txt/);
  assert.equal(state.jobs[0].keptWorkspace, null);
  await assert.rejects(fs.access(resolveWorktree(state, state.jobs[0])));
  for (const file of [...await walk(path.join(root, '.swarm/runs', state.id)), ...await walk(path.join(root, '.swarm/workspaces', state.id))]) assert.equal((await fs.readFile(file)).includes(Buffer.from(KEY)), false, file);
});

test('integration: a key the worker prints is redacted from every log and refuses integrate', async t => {
  const root = await fixture(t);
  const fake = await fakeCursor(t, `echo "leak $CURSOR_API_KEY" >&2\n${success}`);
  const state = await runManifest(root, manifest(), { platform: 'darwin', env: runEnv(fake), spawnImpl: viaFake() });
  assert.equal(state.jobs[0].status, 'complete');
  assert.equal(state.jobs[0].workerKeyExposed, true);
  const runDir = path.join(root, '.swarm/runs', state.id);
  for (const file of await walk(runDir)) assert.equal((await fs.readFile(file)).includes(Buffer.from(KEY)), false, file);
  assert.match(await fs.readFile(path.join(runDir, 'writer/stderr.log'), 'utf8'), /leak \[cursor-key-redacted\]/);
  assert.match(await fs.readFile(path.join(runDir, 'writer/stderr.txt'), 'utf8'), /leak \[worker-key-redacted\]/);
  await assert.rejects(integrateRun(root, state.id, { env: runEnv(fake) }), /exposed the worker API key during a cursor job/);
  assert.equal(await fs.readFile(path.join(root, 'output.txt'), 'utf8'), 'committed output');
});

// The one test that runs the REAL generated profile under the real sandbox-exec, with the fake
// binary: it execs from its install dir, writes the worktree and ~/.cursor, and cannot read the
// rest of home or a denied dir. (Writes outside the worktree are not probed here: this fixture's
// home sits under the OS temp dir, which the codex baseline leaves writable for test scratch.)
const sandboxWorks = process.platform === 'darwin' && spawnSync('/usr/bin/sandbox-exec', ['-p', '(version 1)(allow default)', '/usr/bin/true']).status === 0;
test('integration (real seatbelt): the fake cursor-agent can exec from its install dir, write the worktree and ~/.cursor, and nothing else', { skip: sandboxWorks ? false : 'sandbox-exec unavailable here' }, async t => {
  const root = await fixture(t);
  const base = await tempDir(t, 'swarm-cursor-seatbelt-');
  const home = path.join(base, 'home');
  await fs.mkdir(path.join(home, '.ssh'), { recursive: true });
  await fs.mkdir(path.join(home, '.cursor'));
  await fs.writeFile(path.join(home, '.ssh/secret'), 'PLANTED');
  await fs.writeFile(path.join(home, 'notes.txt'), 'PLANTED');
  const probe = [
    'r=""',
    `if cat "$HOME/.ssh/secret" 2>/dev/null | grep -q PLANTED; then r="$r ssh=allowed"; else r="$r ssh=blocked"; fi`,
    `if cat "$HOME/notes.txt" 2>/dev/null | grep -q PLANTED; then r="$r home=allowed"; else r="$r home=blocked"; fi`,
    `if (printf x > "$HOME/.cursor/marker") 2>/dev/null; then r="$r cursor=allowed"; else r="$r cursor=blocked"; fi`,
    'printf "%s" "$r" > output.txt',
    `printf '%s\\n' ${sq(cursorResult(JSON.stringify(envelope)))}`,
  ].join('\n');
  const fake = await fakeCursor(t, probe);
  const state = await runManifest(root, manifest(), { platform: 'darwin', env: runEnv(fake, { HOME: home }), spawnImpl: spawn });
  assert.equal(state.status, 'complete', state.jobs[0]?.error);
  const integrated = await integrateRun(root, state.id, { env: runEnv(fake, { HOME: home }) });
  assert.deepEqual(integrated.files, ['output.txt']);
  assert.equal((await fs.readFile(path.join(root, 'output.txt'), 'utf8')).trim(), 'ssh=blocked home=blocked cursor=allowed');
  assert.equal(await fs.readFile(path.join(home, '.cursor/marker'), 'utf8'), 'x');
});
