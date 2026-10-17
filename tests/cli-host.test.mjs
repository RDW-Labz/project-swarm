// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { resolveCliHosts, shellQuote, sshInvocation, sshEnv, remoteExec } from '../tools/cli-host.mjs';
import { runManifest } from '../tools/swarm.mjs';

const HOST = { target: 'dev2@10.10.10.220', command: '/home/dev2/.local/bin/hermes' };
const envelope = { summary: 'ok', files: [{ path: 'report.md', content: 'Reviewed.' }] };
const hermesEvents = `${JSON.stringify({ type: 'result', exit_code: 0, text: JSON.stringify(envelope), tokens: { input: 10, output: 4 } })}\n`;

async function withConfig(t, config) {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-clihost-')));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'config.json');
  await fs.writeFile(file, JSON.stringify(config));
  const before = process.env.SWARM_CONFIG;
  process.env.SWARM_CONFIG = file;
  t.after(() => { if (before === undefined) delete process.env.SWARM_CONFIG; else process.env.SWARM_CONFIG = before; });
}
async function project(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-clihost-run-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'input.md'), 'selected source');
  return root;
}
const manifest = () => ({ version: 1, concurrency: 1, jobs: [{ id: 'hermes-job', agent: 'hermes', model: 'qwen3.8-flash-next-iq2_xs', context: ['input.md'], outputs: ['report.md'], prompt: 'Review.', timeoutMs: 5000 }] });

test('cliHosts accepts a known agent with a host and absolute command, and refuses anything unsafe', () => {
  assert.deepEqual(resolveCliHosts({ hermes: HOST }), { hermes: HOST });
  assert.deepEqual(resolveCliHosts(undefined), {});
  for (const bad of [
    { openai: HOST }, { hermes: { ...HOST, command: 'hermes' } }, { hermes: { ...HOST, command: '/bin/h; rm -rf /' } },
    { hermes: { ...HOST, target: 'dev2 @host' } }, { hermes: { ...HOST, target: '-Jevil' } }, { hermes: { ...HOST, target: 'dev2@-oProxyCommand=x' } }, { hermes: { ...HOST, key: 'x' } }, { hermes: 'dev2' }, [],
  ]) assert.throws(() => resolveCliHosts(bad), { code: 'cli-hosts-invalid' });
});

test('the ssh command quotes every argument for the remote shell and sends no environment', () => {
  assert.equal(shellQuote("it's; $(x)"), "'it'\\''s; $(x)'");
  assert.throws(() => shellQuote('a\nb'), { code: 'cli-hosts-invalid' });
  const { command, args } = sshInvocation(HOST, ['chat', '--model', "a'b c", '--query-file', '-']);
  assert.equal(command, 'ssh');
  for (const option of ['BatchMode=yes', 'StrictHostKeyChecking=yes', 'ForwardAgent=no', 'ForwardX11=no', 'ClearAllForwardings=yes', 'PermitLocalCommand=no']) assert.ok(args.includes(option), option);
  assert.equal(args[0], '-T');
  assert.equal(args.at(-3), '--');
  assert.equal(args.at(-2), 'dev2@10.10.10.220');
  assert.equal(args.at(-1), "'/home/dev2/.local/bin/hermes' 'chat' '--model' 'a'\\''b c' '--query-file' '-'");
  const seen = [];
  remoteExec(HOST, (...call) => seen.push(call))('hermes', ['--version'], { timeout: 1 });
  assert.equal(seen[0][0], 'ssh');
  assert.equal(seen[0][1].at(-1), "'/home/dev2/.local/bin/hermes' '--version'");
  assert.equal(seen[0][2].timeout, 90000);
  // doctor's ssh gets the same short environment as a job's, never the caller's whole environment
  remoteExec(HOST, (...call) => seen.push(call))('hermes', ['--version'], { env: { PATH: '/bin', HOME: '/h', OPENAI_API_KEY: 'sk-secret', SSH_AUTH_SOCK: '/s' } });
  assert.deepEqual(seen[1][2].env, { PATH: '/bin', HOME: '/h', SSH_AUTH_SOCK: '/s' });
  assert.equal(JSON.stringify(sshEnv({ ...process.env, OPENAI_API_KEY: 'sk-secret' })).includes('sk-secret'), false);
});

test('a hermes job runs over ssh with the message on stdin and none of the local secrets', async t => {
  await withConfig(t, { cliHosts: { hermes: HOST } });
  const root = await project(t);
  process.env.OPENAI_API_KEY = 'sk-must-not-travel';
  t.after(() => { delete process.env.OPENAI_API_KEY; });
  let received;
  const state = await runManifest(root, manifest(), {
    spawnImpl: (command, args, options) => {
      received = { command, args, options };
      return spawn(process.execPath, ['-e', "let input='';process.stdin.on('data',d=>input+=d);process.stdin.on('end',()=>{process.stderr.write('');process.stdout.write(process.argv[1]);});", String(hermesEvents)], { stdio: ['pipe', 'pipe', 'pipe'] });
    },
  });
  assert.equal(state.status, 'complete', JSON.stringify(state.jobs[0].error));
  assert.equal(received.command, 'ssh');
  assert.match(received.args.at(-1), /^'\/home\/dev2\/\.local\/bin\/hermes' 'chat' /);
  assert.ok(received.args.at(-1).includes("'--model' 'qwen3.8-flash-next-iq2_xs'"));
  assert.equal(Object.keys(received.options.env).some(key => /KEY|TOKEN|SECRET/.test(key)), false);
  assert.equal(JSON.stringify(received).includes('sk-must-not-travel'), false);
  const saved = await fs.readFile(path.join(root, '.swarm/runs', state.id, 'hermes-job', 'message.txt'), 'utf8');
  assert.ok(saved.includes('selected source'));
});

test('ssh exit 255 fails only that job with a clear message', async t => {
  await withConfig(t, { cliHosts: { hermes: HOST } });
  const root = await project(t);
  const state = await runManifest(root, manifest(), {
    spawnImpl: () => spawn(process.execPath, ['-e', "process.stderr.write('ssh: connect to host timed out');process.exit(255)"], { stdio: ['pipe', 'pipe', 'pipe'] }),
  });
  assert.equal(state.jobs[0].status, 'failed');
  assert.match(state.jobs[0].error, /cli host unreachable \(ssh exit 255\)/);
});

test('an invalid cliHosts entry fails the job, not the run', async t => {
  await withConfig(t, { cliHosts: { hermes: { ...HOST, command: 'hermes' } } });
  const root = await project(t);
  const state = await runManifest(root, manifest(), { spawnImpl: () => assert.fail('must not launch') });
  assert.equal(state.jobs[0].status, 'failed');
  assert.match(state.jobs[0].error, /cli-hosts-invalid/);
  assert.ok(!/Coordinator failed/.test(String(state.jobs[0].error)));
});
