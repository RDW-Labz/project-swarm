// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SHORTLIST, readSessionFile } from '../tools/gpu.mjs';
import { runGpuCommand, parseGpuFlags, upOptions } from '../tools/gpu-commands.mjs';

function envFor(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gpu-cli-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'config.json');
  fs.writeFileSync(file, '{}');
  return { ...process.env, SWARM_CONFIG: file };
}

test('upOptions expands a leading ~/ in --key and converts numbers', () => {
  const opts = upOptions({ key: '~/.ssh/node', 'hourly-usd': '3', 'max-usd': '6', gpus: '2' });
  assert.equal(opts.key, path.join(os.homedir(), '.ssh/node'));
  assert.equal(opts.hourlyUsd, 3);
  assert.equal(opts.maxUsd, 6);
  assert.equal(opts.gpus, 2);
});

test('parseGpuFlags rejects an unknown flag and a flag missing its value, accepts --yes --json --extra-quant', () => {
  assert.throws(() => parseGpuFlags(['--nope']), /gpu-usage/);
  assert.throws(() => parseGpuFlags(['--target']), /needs a value/);
  assert.deepEqual(parseGpuFlags(['--yes', '--json', '--extra-quant']), { yes: true, json: true, 'extra-quant': true });
});

test('models prints every shortlist label', async () => {
  const lines = [];
  await runGpuCommand(['models'], { out: text => lines.push(text) });
  const text = lines.join('\n');
  for (const item of SHORTLIST) assert.ok(text.includes(item.label), item.label);
});

test('status with no session says there is no GPU session', async t => {
  const env = envFor(t);
  const lines = [];
  await runGpuCommand(['status'], { out: text => lines.push(text), env });
  assert.match(lines.join('\n'), /No GPU session/);
});

test('bakeoff with injected deps writes the report, reminds to terminate, and leaves no session', async t => {
  const env = envFor(t);
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'gpu-cli-repo-'));
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  const lines = [];
  const gpu = {
    ssh: async argv => ({ stdout: String(argv.at(-1)).startsWith('nvidia-smi -L') ? 'GPU 0: x\nSUDO:ok' : '' }),
    openTunnel: async () => ({ pid: 1 }),
    stopTunnel: async () => {},
    fetchImpl: async url => ({ ok: true, json: async () => (String(url).endsWith('/v1/models') ? { data: [{ id: 'Qwen/Qwen3-Coder-30B-A3B-Instruct-FP8' }] } : { usage: { completion_tokens: 50 } }) }),
    log: () => {},
  };
  const bench = { buildBaseRepo: () => ({ head: 'h' }), runLane: () => ({ results: [{ pass: true }, { pass: false }] }) };
  await runGpuCommand(['bakeoff', '--models', 'Qwen/Qwen3-Coder-30B-A3B-Instruct-FP8', '--levels', '1,2', '--target', 'ubuntu@203.0.113.9', '--key', '/k', '--hourly-usd', '3', '--max-usd', '6', '--yes', '--repo', repo], { out: text => lines.push(text), env, gpu, bench, runner: 'x', baseInfo: { head: 'h' } });
  const report = path.join(repo, 'docs', 'state', 'gpu-bakeoff.md');
  const text = fs.readFileSync(report, 'utf8');
  assert.ok(text.includes('(50%)'));
  assert.match(lines.join('\n'), /terminate the instance/i);
  assert.equal(readSessionFile(env), null);
});

test('bakeoff --levels 0 is rejected with gpu-usage', async t => {
  const env = envFor(t);
  await assert.rejects(runGpuCommand(['bakeoff', '--levels', '0', '--target', 'ubuntu@203.0.113.9', '--key', '/k', '--hourly-usd', '3', '--max-usd', '6', '--yes', '--repo', os.tmpdir()], { out: () => {}, env }), /gpu-usage/);
});
