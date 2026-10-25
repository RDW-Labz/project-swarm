// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runRemoteCommand, readRemote, isSwarmWatchBoardCommand, validStopPid } from '../tools/remote.mjs';
import {
  identityUnverifiedRestartHint,
  restartHintContextLine,
  restartRegisteredServers,
  writeRegistryRecord,
  remoteServerFile,
} from '../tools/server-restart.mjs';
import { boardFile } from '../tools/watch-cli.mjs';

const DNS = 'mini.tail.ts.net';
const LOGIN = 'me@example.com';
const TOKEN = 'a'.repeat(48);
const SWARM = path.join('/opt', 'swarm', 'tools', 'swarm.mjs');

test('isSwarmWatchBoardCommand matches real board argv only', () => {
  const watchCmd = `${process.execPath} ${SWARM} watch --all`;
  const remoteCmd = `${process.execPath} ${SWARM} remote serve`;
  const rootWatch = `${process.execPath} ${SWARM} --root /tmp/repo watch`;
  assert.equal(isSwarmWatchBoardCommand(watchCmd), true);
  assert.equal(isSwarmWatchBoardCommand(remoteCmd), true);
  assert.equal(isSwarmWatchBoardCommand(rootWatch), true);
  assert.equal(isSwarmWatchBoardCommand(`vim ${SWARM} watch`), false);
  assert.equal(isSwarmWatchBoardCommand(`${process.execPath} ${SWARM} status`), false);
});

test('validStopPid rejects unsafe pids', () => {
  assert.equal(validStopPid(process.pid), false);
  assert.equal(validStopPid(process.ppid), false);
  assert.equal(validStopPid(1), false);
  assert.equal(validStopPid(424242), true);
});

async function remoteOffHarness(t, { state, deps: depPatch = {} } = {}) {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'fix1167-13-')));
  const env = { ...process.env, SWARM_REMOTE_FILE: path.join(dir, 'remote.json') };
  await fs.mkdir(path.dirname(env.SWARM_REMOTE_FILE), { recursive: true, mode: 0o700 });
  if (state) {
    await fs.writeFile(env.SWARM_REMOTE_FILE, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  }
  const killed = [];
  const deps = {
    env,
    tailscale: async () => ({ ok: true, stdout: JSON.stringify({ Web: {}, AllowFunnel: {}, TCP: {} }) }),
    sleep: async () => {},
    kill: pid => { killed.push(pid); return true; },
    alive: depPatch.alive ?? (pid => pid === state?.listenerPid || pid === state?.pid),
    listenerPids: async port => depPatch.listenerPids?.(port) ?? (state?.listenerPid ? [state.listenerPid] : []),
    commandOf: async pid => {
      if (depPatch.commandOf) return depPatch.commandOf(pid);
      if (pid === state?.pid && state?.recordedCommand) return state.recordedCommand;
      if (pid === state?.listenerPid) return state?.listenerCommand ?? '';
      return state?.listenerCommand ?? '';
    },
    get: async () => {
      if (depPatch.boardUp === false) return { status: 0, body: '' };
      return { status: 200, body: JSON.stringify({ projects: [] }) };
    },
    ...depPatch,
  };
  t.after(async () => { await fs.rm(dir, { recursive: true, force: true }); });
  const run = () => runRemoteCommand(['off'], { deps });
  return { dir, env, deps, killed, run };
}

test('remote off: stale dead recorded pid is treated as stopped and record cleared', async t => {
  const state = {
    enabled: true,
    token: TOKEN,
    port: 18080,
    httpsPort: 8443,
    dns: DNS,
    login: LOGIN,
    hosts: [`${DNS}:8443`],
    pid: 424242,
  };
  const h = await remoteOffHarness(t, {
    state,
    deps: {
      alive: () => false,
      get: async () => ({ status: 0, body: '' }),
      tailscale: async () => ({ ok: true, stdout: JSON.stringify({ Web: { [`${DNS}:8443`]: { Handlers: { '/': { Proxy: 'http://127.0.0.1:18080' } } } }, AllowFunnel: {}, TCP: {} }) }),
    },
  });
  // First call removes serve entry; simplify — no dns serve path: use state without needing removal
  h.deps.tailscale = async () => ({ ok: true, stdout: JSON.stringify({ Web: {}, AllowFunnel: {}, TCP: {} }) });
  const res = await h.run();
  assert.equal(res.exitCode, 0, res.stdout);
  assert.match(res.stdout, /the recorded board process 424242 was already gone/);
  assert.doesNotMatch(res.stdout, /could not stop the board/);
  assert.equal(await readRemote(h.env), null);
  assert.equal(h.killed.length, 0);
});

test('remote off: wrong pid but swarm board listener is stopped', async t => {
  const state = {
    enabled: true,
    token: TOKEN,
    port: 18081,
    httpsPort: 8443,
    dns: DNS,
    login: LOGIN,
    hosts: [`${DNS}:8443`],
    pid: 111,
    listenerPid: 222,
    listenerCommand: `${process.execPath} ${SWARM} watch --all`,
  };
  const h = await remoteOffHarness(t, { state, deps: { alive: pid => pid === 222 } });
  let boardUp = true;
  h.deps.get = async () => (boardUp ? { status: 200, body: JSON.stringify({ projects: [] }) } : { status: 0, body: '' });
  h.deps.kill = pid => {
    h.killed.push(pid);
    if (pid === 222) boardUp = false;
    return true;
  };
  h.deps.tailscale = async () => ({ ok: true, stdout: JSON.stringify({ Web: {}, AllowFunnel: {}, TCP: {} }) });
  const res = await h.run();
  assert.equal(res.exitCode, 0, res.stdout);
  assert.deepEqual(h.killed, [222]);
  assert.match(res.stdout, /stopped the board/);
  assert.equal(await readRemote(h.env), null);
});

test('remote off: non-swarm listener is left alone', async t => {
  const state = {
    enabled: true,
    token: TOKEN,
    port: 18082,
    httpsPort: 8443,
    dns: DNS,
    login: LOGIN,
    hosts: [`${DNS}:8443`],
    pid: 111,
    listenerPid: 333,
    listenerCommand: '/usr/sbin/nginx',
  };
  const h = await remoteOffHarness(t, { state, deps: { alive: pid => pid === 333 } });
  h.deps.tailscale = async () => ({ ok: true, stdout: JSON.stringify({ Web: {}, AllowFunnel: {}, TCP: {} }) });
  const res = await h.run();
  assert.equal(res.exitCode, 1, res.stdout);
  assert.match(res.stdout, /port 18082 is held by another program \(process 333\); not touching it/);
  assert.equal(h.killed.length, 0);
  assert.ok(await readRemote(h.env));
});

test('remote off: recorded pid alive but listener command unknown keeps settings and does not kill recorded pid', async t => {
  const state = {
    enabled: true,
    token: TOKEN,
    port: 18084,
    httpsPort: 8443,
    dns: DNS,
    login: LOGIN,
    hosts: [`${DNS}:8443`],
    pid: 501,
    listenerPid: 502,
    recordedCommand: `${process.execPath} ${SWARM} remote serve`,
  };
  const h = await remoteOffHarness(t, {
    state,
    deps: {
      alive: pid => pid === 501 || pid === 502,
      listenerPids: async () => [502],
      commandOf: async pid => (pid === 501 ? state.recordedCommand : ''),
    },
  });
  h.deps.tailscale = async () => ({ ok: true, stdout: JSON.stringify({ Web: {}, AllowFunnel: {}, TCP: {} }) });
  const res = await h.run();
  assert.equal(res.exitCode, 1, res.stdout);
  assert.match(res.stdout, /command line could not be read/);
  assert.match(res.stdout, /not stopping the recorded process 501/);
  assert.deepEqual(h.killed, []);
  assert.ok(await readRemote(h.env));
});

test('remote off: multiple listeners on port refuses stop', async t => {
  const state = {
    enabled: true,
    token: TOKEN,
    port: 18085,
    httpsPort: 8443,
    dns: DNS,
    login: LOGIN,
    hosts: [`${DNS}:8443`],
    pid: 601,
    recordedCommand: `${process.execPath} ${SWARM} remote serve`,
  };
  const h = await remoteOffHarness(t, {
    state,
    deps: {
      alive: pid => pid === 601,
      listenerPids: async () => [601, 602],
      commandOf: async () => state.recordedCommand,
    },
  });
  h.deps.tailscale = async () => ({ ok: true, stdout: JSON.stringify({ Web: {}, AllowFunnel: {}, TCP: {} }) });
  const res = await h.run();
  assert.equal(res.exitCode, 1, res.stdout);
  assert.match(res.stdout, /multiple listeners \(pids 601, 602\)/);
  assert.equal(h.killed.length, 0);
  assert.ok(await readRemote(h.env));
});

test('remote off: command line change before kill keeps settings', async t => {
  const state = {
    enabled: true,
    token: TOKEN,
    port: 18086,
    httpsPort: 8443,
    dns: DNS,
    login: LOGIN,
    hosts: [`${DNS}:8443`],
    pid: 701,
    listenerPid: 701,
    listenerCommand: `${process.execPath} ${SWARM} remote serve`,
  };
  let calls = 0;
  const h = await remoteOffHarness(t, {
    state,
    deps: {
      alive: pid => pid === 701,
      listenerPids: async () => [701],
      commandOf: async () => {
        calls += 1;
        return calls === 1
          ? state.listenerCommand
          : `${process.execPath} ${SWARM} remote serve --tampered`;
      },
    },
  });
  h.deps.tailscale = async () => ({ ok: true, stdout: JSON.stringify({ Web: {}, AllowFunnel: {}, TCP: {} }) });
  const res = await h.run();
  assert.equal(res.exitCode, 1, res.stdout);
  assert.match(res.stdout, /process 701 changed before it could be stopped/);
  assert.equal(h.killed.length, 0);
  assert.ok(await readRemote(h.env));
});

test('remote off: invalid recorded pid is never killed', async t => {
  const state = {
    enabled: true,
    token: TOKEN,
    port: 18087,
    httpsPort: 8443,
    dns: DNS,
    login: LOGIN,
    hosts: [`${DNS}:8443`],
    pid: 1,
  };
  const h = await remoteOffHarness(t, { state, deps: { alive: () => false } });
  h.deps.tailscale = async () => ({ ok: true, stdout: JSON.stringify({ Web: {}, AllowFunnel: {}, TCP: {} }) });
  const res = await h.run();
  assert.equal(res.exitCode, 0, res.stdout);
  assert.match(res.stdout, /the board was not running/);
  assert.equal(h.killed.length, 0);
  assert.equal(await readRemote(h.env), null);
});

test('remote off: dead recorded pid but board still up keeps settings', async t => {
  const state = {
    enabled: true,
    token: TOKEN,
    port: 18088,
    httpsPort: 8443,
    dns: DNS,
    login: LOGIN,
    hosts: [`${DNS}:8443`],
    pid: 801,
  };
  let boardChecks = 0;
  const h = await remoteOffHarness(t, {
    state,
    deps: {
      alive: () => false,
      get: async () => {
        boardChecks += 1;
        if (boardChecks === 1) return { status: 0, body: '' };
        return { status: 200, body: JSON.stringify({ projects: [] }) };
      },
    },
  });
  h.deps.tailscale = async () => ({ ok: true, stdout: JSON.stringify({ Web: {}, AllowFunnel: {}, TCP: {} }) });
  const res = await h.run();
  assert.equal(res.exitCode, 1, res.stdout);
  assert.match(res.stdout, /still answering on the saved port/);
  assert.ok(await readRemote(h.env));
});

test('remote off: listener lookup failure keeps saved settings', async t => {
  const state = {
    enabled: true,
    token: TOKEN,
    port: 18083,
    httpsPort: 8443,
    dns: DNS,
    login: LOGIN,
    hosts: [`${DNS}:8443`],
    pid: 111,
  };
  const h = await remoteOffHarness(t, {
    state,
    deps: {
      alive: () => false,
      listenerPids: async () => null,
      tailscale: async () => ({ ok: true, stdout: JSON.stringify({ Web: {}, AllowFunnel: {}, TCP: {} }) }),
    },
  });
  const res = await h.run();
  assert.equal(res.exitCode, 1, res.stdout);
  assert.match(res.stdout, /could not determine which process is listening on port 18083/);
  assert.match(res.stdout, /kept the saved settings/);
  assert.ok(await readRemote(h.env));
});

test('identity-unverified restart hints for remote and board', async t => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'fix1167-hint-'));
  const install = path.join(home, 'install');
  const runner = path.join(install, 'current', 'tools', 'swarm.mjs');
  await fs.mkdir(path.dirname(runner), { recursive: true });
  await fs.writeFile(runner, 'export {}\n');
  const boardPath = boardFile({ HOME: home }, home);
  const remotePath = remoteServerFile({ HOME: home }, home);
  const boardPid = 881_101;
  const remotePid = 881_102;
  const baseRecord = {
    startedAt: new Date().toISOString(),
    version: '1.0.0',
    cwd: home,
    env: {},
    mode: 'background',
    explicitBackground: true,
  };
  await writeRegistryRecord(boardPath, {
    ...baseRecord,
    pid: boardPid,
    url: 'http://127.0.0.1:9100/?t=x',
    argv: ['watch', '--all', '--keep-up'],
    port: 9100,
  });
  await writeRegistryRecord(remotePath, {
    ...baseRecord,
    pid: remotePid,
    url: 'http://127.0.0.1:9200/?t=y',
    argv: ['remote', 'serve'],
    port: 9200,
  });
  const lines = [];
  const { servers } = await restartRegisteredServers({
    installRoot: install,
    targetVersion: '2.0.0',
    env: { HOME: home, PATH: process.env.PATH, SWARM_TEST_TMP: home },
    home,
    write: line => lines.push(line),
    execFileImpl: async (_cmd, args) => {
      if (args.some(arg => String(arg).includes('command'))) {
        return { stdout: `${process.execPath} ${runner} watch --other\n` };
      }
      return { stdout: '10:00\n' };
    },
    strictPidCheck: true,
    sleep: async () => {},
    pidAliveImpl: pid => pid === boardPid || pid === remotePid,
    launchdBoardPlistExists: () => false,
  });
  const board = servers.find(s => s.kind === 'board');
  const remote = servers.find(s => s.kind === 'remote');
  assert.equal(board?.status, 'identity-unverified');
  assert.equal(remote?.status, 'identity-unverified');
  const boardHint = identityUnverifiedRestartHint('board', { pid: boardPid, port: 9100, argv: ['watch', '--all', '--keep-up'] }, { launchdBoardPlistExists: () => false });
  const remoteHint = identityUnverifiedRestartHint('remote', { pid: remotePid, port: 9200 }, {});
  assert.equal(board.restartHint, boardHint);
  assert.equal(remote.restartHint, remoteHint);
  assert.doesNotMatch(boardHint, /\(pid/);
  assert.doesNotMatch(remoteHint, /\(pid/);
  assert.ok(lines.some(l => l.trim() === restartHintContextLine(remotePid, 9200)));
  assert.ok(lines.some(l => l.trim() === restartHintContextLine(boardPid, 9100)));
  assert.ok(lines.some(l => l.trim() === remoteHint));
  assert.ok(lines.some(l => l.trim() === boardHint));
  assert.match(lines.join(''), /restart to pick up the update:/);
  await fs.rm(home, { recursive: true, force: true });
});

test('identity-unverified launchd board hint uses numeric gui uid and paste-safe command', () => {
  const hint = identityUnverifiedRestartHint('board', { pid: 42, port: 8080, argv: [] }, {
    launchdBoardPlistExists: () => true,
    getuid: () => 501,
  });
  assert.equal(hint, "'launchctl' 'kickstart' '-k' 'gui/501/com.project-swarm.board'");
  assert.doesNotMatch(hint, /\$\(id -u\)/);
  assert.doesNotMatch(hint, /\(pid/);
});
