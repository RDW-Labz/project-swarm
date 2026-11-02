// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { projectStatus, formatStatus } from '../tools/status.mjs';

const SWARM = fileURLToPath(new URL('../tools/swarm.mjs', import.meta.url));
const tmp = async t => { const d = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'bare-status-'))); t.after(() => fs.rm(d, { recursive: true, force: true })); return d; };
const run = (args, { cwd, env }) => new Promise(resolve => {
  const started = Date.now();
  execFile(process.execPath, [SWARM, ...args], { cwd, env, timeout: 25000, killSignal: 'SIGKILL' }, (error, stdout, stderr) => resolve({ code: error ? (error.killed ? 'killed' : error.code) : 0, stdout, stderr, ms: Date.now() - started }));
});

// The lane that caused the hang: hermes runs over ssh on another machine. 192.0.2.1 is a documentation address that never answers.
async function world(t) {
  const home = await tmp(t);
  const config = path.join(home, 'config.json');
  await fs.writeFile(config, JSON.stringify({ cliHosts: { hermes: { target: 'dev2@192.0.2.1', command: '/home/dev2/.local/bin/hermes' } } }));
  // An empty PATH: the local lane checks (claude, codex, cursor) fail at once instead of spawning real tools, so the test measures only the remote lane and cannot be slowed by a loaded machine.
  const bin = path.join(home, 'bin');
  await fs.mkdir(bin);
  const env = { ...process.env, PATH: bin, HOME: home, SWARM_CONFIG: config, SWARM_PROJECTS_FILE: path.join(home, 'projects.json'), SWARM_HISTORY_FILE: path.join(home, 'history.ndjson'), SWARM_SPEND_DIR: path.join(home, 'spend') };
  return { home, env, cwd: home };
}

test('bare swarm answers fast even when a lane lives on an unreachable host (it used to wait for ssh, minutes): the remote lane is listed as not checked', async t => {
  const w = await world(t);
  const res = await run([], w);
  assert.equal(res.code, 0, res.stderr);
  assert.ok(res.ms < 15000, `took ${res.ms} ms`);
  assert.match(res.stdout, /Project Swarm status for /);
  assert.match(res.stdout, /Lanes not checked \(remote host\): hermes/);
  assert.doesNotMatch(res.stdout, /Lanes (up|down):.*hermes/);
  assert.match(res.stdout, /Next:/);
});

test('swarm status is the same short status, --json too; status --all is the board text view', async t => {
  const w = await world(t);
  const [bare, status, json, all] = await Promise.all([run([], w), run(['status'], w), run(['status', '--json'], w), run(['status', '--all'], w)]);
  assert.equal(status.code, 0, status.stderr);
  assert.equal(status.stdout, bare.stdout);
  assert.deepEqual(Object.keys(JSON.parse(json.stdout)).sort(), ['initialized', 'lanes', 'lastRun', 'next', 'root', 'spendToday']);
  assert.deepEqual(JSON.parse(json.stdout).lanes.unchecked, ['hermes']);
  assert.equal(all.code, 0, all.stderr);
  assert.match(all.stdout, /No live runs on this machine\./);
  assert.ok([bare, status, json, all].every(r => r.ms < 15000));
});

test('status formatting: a remote lane is neither up nor down, and the line is absent when nothing is unchecked', async () => {
  const unchecked = await projectStatus('/nowhere', { doctorAll: async () => ({ providers: [{ agent: 'claude', status: 'compatible' }, { agent: 'hermes', status: 'remote-unchecked' }, { agent: 'qwen', status: 'unavailable' }] }) });
  assert.deepEqual([unchecked.lanes.up, unchecked.lanes.down, unchecked.lanes.unchecked], [['claude'], ['qwen'], ['hermes']]);
  assert.equal('unchecked' in (await projectStatus('/nowhere', { doctorAll: async () => ({ providers: [{ agent: 'claude', status: 'compatible' }] }) })).lanes, false, 'the key appears only when something was not checked');
  assert.match(formatStatus(unchecked), /Lanes not checked \(remote host\): hermes/);
  const none = await projectStatus('/nowhere', { doctorAll: async () => ({ providers: [{ agent: 'claude', status: 'compatible' }] }) });
  assert.doesNotMatch(formatStatus(none), /not checked/);
  const failed = await projectStatus('/nowhere', { doctorAll: async () => { throw new Error('the lane check timed out after 5 seconds'); } });
  assert.match(failed.lanes.error, /timed out/);
});

test('swarm doctor on a remote lane still does the real check (only status skips it): the skip is opt-in', async () => {
  const src = await fs.readFile(SWARM, 'utf8');
  assert.match(src, /options\.skipRemote\?resolveCliHosts/);
  assert.equal([...src.matchAll(/skipRemote:true/g)].length, 1, 'only the status path asks to skip');
});
