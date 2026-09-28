// SPDX-License-Identifier: Apache-2.0
// Live checks for the claude shell adapter (decision #154). Skipped unless SWARM_LIVE_SHELL=1.
// Both tests run the REAL claude CLI under the REAL generated seatbelt profile via runManifest.
// 1. fake-API: the CLI talks to a local fake Messages API (ANTHROPIC_BASE_URL, tests only) that
//    scripts one Bash call, so no key, spend or model is involved; also captures request bodies
//    to prove metadata.user_id = swarm-worker:<job-id>.
// 2. real model: needs SWARM_CLAUDE_WORKER_API_KEY in the environment; otherwise it skips.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { runManifest, inspectRun } from '../tools/swarm.mjs';

const LIVE = process.env.SWARM_LIVE_SHELL === '1' && process.platform === 'darwin';
const FAKE_KEY = 'sk-FAKE-0000';
const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });

async function fixture(t) {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-live-shell-')));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const repo = path.join(base, 'repo'), fakeHome = path.join(base, 'fakehome');
  const planted = { denied: path.join(fakeHome, '.ssh/secret.txt'), keychain: path.join(fakeHome, 'Library/Keychains/login.keychain-db'), creds: path.join(fakeHome, '.claude/.credentials.json') };
  for (const file of Object.values(planted)) { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, 'PLANTED-SECRET\n'); }
  const outside = path.join(base, 'outside.txt');
  await fs.mkdir(repo);
  git(repo, 'init', '-q');
  await fs.writeFile(path.join(repo, '.gitignore'), '.swarm/\n');
  await fs.writeFile(path.join(repo, 'package.json'), JSON.stringify({ name: 'fixture', private: true, scripts: { test: "node -e \"require('fs').writeFileSync('test-ran.txt','ok')\"" } }));
  await fs.writeFile(path.join(repo, 'probe-result.txt'), 'not run\n');
  const q = value => `'${value.replace(/'/g, `'\\''`)}'`;
  await fs.writeFile(path.join(repo, 'probe.sh'), [
    '#!/bin/sh', 'out=probe-result.txt', ': > "$out"',
    'if npm test >/dev/null 2>&1 && [ -f test-ran.txt ]; then echo test=ok >> "$out"; else echo test=fail >> "$out"; fi',
    `if (echo x > ${q(outside)}) 2>/dev/null; then echo write=allowed >> "$out"; else echo write=blocked >> "$out"; fi`,
    `if cat ${q(planted.denied)} 2>/dev/null | grep -q PLANTED; then echo read=allowed >> "$out"; else echo read=blocked >> "$out"; fi`,
    `if cat ${q(planted.keychain)} 2>/dev/null | grep -q PLANTED; then echo keychain=allowed >> "$out"; else echo keychain=blocked >> "$out"; fi`,
    `if cat ${q(planted.creds)} 2>/dev/null | grep -q PLANTED; then echo creds=allowed >> "$out"; else echo creds=blocked >> "$out"; fi`,
    'if curl -sS -m 10 -o /dev/null https://example.com 2>/dev/null; then echo net=allowed >> "$out"; else echo net=blocked >> "$out"; fi',
    "if curl --noproxy '*' -sS -m 5 -o /dev/null https://example.com 2>/dev/null; then echo direct=allowed >> \"$out\"; else echo direct=blocked >> \"$out\"; fi",
    'if [ -n "${FAKE_TOKEN:-}" ]; then echo env=leaked >> "$out"; else echo env=clean >> "$out"; fi',
    'if [ -n "${ANTHROPIC_API_KEY:-}" ]; then echo key=visible >> "$out"; else echo key=hidden >> "$out"; fi',
    'if ps eww -p "$PPID" >/dev/null 2>&1; then echo ps=allowed >> "$out"; else echo ps=blocked >> "$out"; fi',
    '',
  ].join('\n'));
  git(repo, 'add', '.');
  git(repo, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'fixture');
  return { base, repo, fakeHome, outside };
}

const manifest = (model, prompt) => ({ version: 1, checks: [{ name: 'unit', argv: ['npm', 'test'] }], jobs: [{ id: 'probe', agent: 'claude', model, shell: true, prompt, context: ['probe.sh', 'package.json'], outputs: ['probe-result.txt'], timeoutMs: 240000 }] });
const results = text => Object.fromEntries(text.trim().split('\n').map(line => line.split('=')));

function assertSandboxed(probe, record, outside) {
  assert.equal(probe.test, 'ok', 'in-worktree test command works');
  assert.equal(probe.write, 'blocked', 'write outside the worktree');
  assert.equal(probe.read, 'blocked', 'read under a denied fixture root');
  assert.equal(probe.keychain, 'blocked', 'fake keychain fixture');
  assert.equal(probe.creds, 'blocked', 'fake claude credentials fixture');
  assert.equal(probe.net, 'blocked', 'curl through the proxy');
  assert.equal(probe.direct, 'blocked', 'curl bypassing the proxy');
  assert.equal(probe.env, 'clean', 'parent FAKE_TOKEN is not visible');
  // Exact-hostname equality, never a substring/URL check: proxyRefused is a plain hostname list.
  assert.ok(record.proxyRefused.some(host => host === 'example.com'), `proxy refused example.com: ${record.proxyRefused}`);
  return fs.access(outside).then(() => assert.fail('outside file exists'), () => {});
}

// Minimal streaming Messages API: scripts one call of each shell-job tool (Bash runs the probe),
// records each tool result, then ends with the final JSON.
function fakeApi(captured, toolResults) {
  const sse = (response, events) => {
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    for (const event of events) response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    response.end();
  };
  let cwd = null;
  const steps = () => [
    ['Bash', { command: 'sh probe.sh', description: 'Run the probe' }],
    ['Grep', { pattern: 'PLANTED', path: '.' }],
    ['Glob', { pattern: '*.sh' }],
    ['Read', { file_path: `${cwd}/package.json` }],
    ['Write', { file_path: `${cwd}/tools-ok.txt`, content: 'ok\n' }],
    ['Edit', { file_path: `${cwd}/tools-ok.txt`, old_string: 'ok', new_string: 'edited' }],
  ];
  return (request, response) => {
    let body = '';
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      const url = new URL(request.url, 'http://fake');
      if (request.method !== 'POST' || url.pathname !== '/v1/messages') { response.writeHead(404, { 'content-type': 'application/json' }).end('{"type":"error","error":{"type":"not_found_error","message":"fake"}}'); return; }
      const parsed = JSON.parse(body);
      captured.push({ userId: parsed.metadata?.user_id, apiKey: request.headers['x-api-key'] ?? null, tools: (parsed.tools ?? []).map(tool => tool.name) });
      const system = JSON.stringify(parsed.system ?? '') + JSON.stringify(parsed.messages ?? []);
      cwd ??= /working directory: ([^\s"\\]+)/i.exec(system)?.[1] ?? null;
      const results = (parsed.messages ?? []).flatMap(message => Array.isArray(message.content) ? message.content.filter(block => block.type === 'tool_result') : []);
      toolResults.length = 0;
      for (const result of results) toolResults.push({ id: result.tool_use_id, isError: Boolean(result.is_error), text: JSON.stringify(result.content).slice(0, 300) });
      const usage = { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
      const text = JSON.stringify({ status: 'done', checksRun: [{ name: 'unit', status: 'passed' }] });
      const plan = steps();
      const next = parsed.tools?.some(tool => tool.name === 'Bash') ? plan[results.length] : undefined;
      const block = next ? { type: 'tool_use', id: `toolu_fake_${results.length}`, name: next[0], input: {} } : { type: 'text', text: '' };
      if (!parsed.stream) { response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ id: 'msg_fake', type: 'message', role: 'assistant', model: parsed.model, content: [{ type: 'text', text }], stop_reason: 'end_turn', stop_sequence: null, usage })); return; }
      const delta = next ? { type: 'input_json_delta', partial_json: JSON.stringify(next[1]) } : { type: 'text_delta', text };
      sse(response, [
        { type: 'message_start', message: { id: `msg_fake_${captured.length}`, type: 'message', role: 'assistant', model: parsed.model, content: [], stop_reason: null, stop_sequence: null, usage } },
        { type: 'content_block_start', index: 0, content_block: block },
        { type: 'content_block_delta', index: 0, delta },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: next ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } },
        { type: 'message_stop' },
      ]);
    });
  };
}

test('live fake-API: the real CLI runs Bash only inside the sandbox and labels every request', { skip: !LIVE && 'set SWARM_LIVE_SHELL=1 on macOS' }, async t => {
  const { repo, fakeHome, outside } = await fixture(t);
  const captured = [], toolResults = [];
  const state = await runManifest(repo, manifest('haiku', 'Run sh probe.sh once, then report.'), {
    env: { ...process.env, FAKE_TOKEN: FAKE_KEY, [`SWARM_CLAUDE_WORKER_API_KEY`]: FAKE_KEY },
    keyExec: () => assert.fail('the keychain must not be read when the env key is set'),
    shellHooks: { handleHttp: fakeApi(captured, toolResults), baseUrlFromProxy: true, extraHomes: [fakeHome] },
  });
  const record = state.jobs[0];
  const probe = results(await fs.readFile(path.join(repo, '.swarm/workspaces', state.id, 'probe/probe-result.txt'), 'utf8'));
  console.log('fake-API probe:', JSON.stringify(probe), 'proxyRefused:', JSON.stringify(record.proxyRefused), 'requests:', captured.length);
  assert.equal(record.status, 'complete', record.error ?? '');
  await assertSandboxed(probe, record, outside);
  console.log('tool results:', JSON.stringify(toolResults), 'offered tools:', JSON.stringify(captured[0]?.tools));
  // Every one of the six tools works inside the whole-process sandbox.
  assert.equal(toolResults.length, 6);
  for (const result of toolResults) assert.equal(result.isError, false, result.text);
  assert.ok(captured.length >= 7);
  for (const request of captured) { assert.equal(request.userId, 'swarm-worker:probe'); assert.equal(request.apiKey, FAKE_KEY); }
  // The key reached the API header only: never argv, logs, state, prompts or results.
  const leaks = [];
  const walk = async dir => { for (const entry of await fs.readdir(dir, { withFileTypes: true })) { const file = path.join(dir, entry.name); if (entry.isDirectory()) { await walk(file); } else if (entry.isFile() && (await fs.readFile(file)).includes(FAKE_KEY)) leaks.push(file); } };
  await walk(path.join(repo, '.swarm'));
  assert.deepEqual(leaks, []);
  const inspected = await inspectRun(repo, state.id);
  assert.equal(inspected.jobs[0].shell, true);
  assert.deepEqual(inspected.jobs[0].checksRun, [{ name: 'unit', status: 'passed' }]);
});

test('live model: one real haiku shell job stays inside the sandbox', { skip: (!LIVE && 'set SWARM_LIVE_SHELL=1 on macOS') || (!process.env.SWARM_CLAUDE_WORKER_API_KEY && 'set SWARM_CLAUDE_WORKER_API_KEY to run the real-model check') }, async t => {
  const { repo, fakeHome, outside } = await fixture(t);
  const state = await runManifest(repo, manifest('haiku', 'Use the Bash tool to run exactly `sh probe.sh` once from the worktree root. Do not edit any file yourself. Then reply with only this JSON: {"status":"done","checksRun":[{"name":"unit","status":"passed"}]}'), {
    env: { ...process.env, FAKE_TOKEN: FAKE_KEY },
    shellHooks: { extraHomes: [fakeHome] },
  });
  const record = state.jobs[0];
  const probe = results(await fs.readFile(path.join(repo, '.swarm/workspaces', state.id, 'probe/probe-result.txt'), 'utf8'));
  console.log('model probe:', JSON.stringify(probe), 'proxyRefused:', JSON.stringify(record.proxyRefused), 'costUsd:', record.costUsd);
  assert.equal(record.status, 'complete', record.error ?? '');
  await assertSandboxed(probe, record, outside);
});
