// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { mkdirSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { boardFile } from '../tools/watch-cli.mjs';
import {
  discoverRunningServers,
  listenPortsForPid,
  listenPortsMatchingProcInodes,
  parseLsofFnOutput,
  parseLsofListenPorts,
  parseProcNetTcpListenRow,
  parseReadlinkSocketInode,
  restartRegisteredServers,
  writeRegistryRecord,
} from '../tools/server-restart.mjs';

const execFileAsync = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));

async function freePort() {
  return await new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
    s.on('error', reject);
  });
}

async function mkHome() {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'restart-any-'));
  await fs.mkdir(path.join(home, '.project-swarm'), { recursive: true, mode: 0o700 });
  return home;
}

const DUMMY_SERVER = `import http from 'node:http';
const version = process.env.SWARM_DUMMY_VERSION || 'old-ver';
const server = http.createServer((req, res) => {
  if (req.url?.startsWith('/api/health')) {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ version, pid: process.pid }));
    return;
  }
  res.statusCode = 404;
  res.end();
});
server.listen(0, '127.0.0.1', () => {
  const port = server.address().port;
  process.env.SWARM_DUMMY_PORT = String(port);
});
process.on('SIGTERM', () => { server.close(() => process.exit(0)); });
`;

async function waitForListenPort(pid) {
  for (let i = 0; i < 40; i += 1) {
    const ports = await listenPortsForPid(pid, {
      execFileImpl: execFileAsync,
      platform: process.platform,
    });
    for (const p of ports) {
      try {
        const res = await fetch(`http://127.0.0.1:${p}/api/health`, { signal: AbortSignal.timeout(500) });
        const body = await res.json();
        if (body.pid === pid) return p;
      } catch { /* not ready */ }
    }
    await new Promise(r => setTimeout(r, 50));
  }
  return null;
}

async function startDummyBoard({ installRoot, cwd, version = 'old-ver' }) {
  const runner = path.join(installRoot, 'current', 'tools', 'swarm.mjs');
  await fs.mkdir(path.dirname(runner), { recursive: true });
  const dummyPath = path.join(installRoot, 'dummy-server.mjs');
  await fs.writeFile(dummyPath, DUMMY_SERVER);
  await fs.writeFile(runner, `import '${pathToFileURL(dummyPath).href}';\n`);
  const child = spawn(process.execPath, [runner, 'watch', '--all'], {
    cwd,
    env: { ...process.env, SWARM_DUMMY_VERSION: version },
    stdio: 'ignore',
    detached: true,
  });
  child.unref();
  await new Promise((resolve, reject) => {
    child.once('spawn', resolve);
    child.once('error', reject);
  });
  const port = await waitForListenPort(child.pid);
  assert.ok(port, 'dummy board must listen');
  return { child, runner, port };
}

test('discovers a running board with no registry record and restarts it', async () => {
  const home = await mkHome();
  const install = path.join(home, 'install');
  const cwd = path.join(home, 'project');
  await fs.mkdir(cwd, { recursive: true });
  const { child, runner, port } = await startDummyBoard({ installRoot: install, cwd });
  const boardPath = boardFile({ HOME: home }, home);
  const targetVersion = 'new-ver';
  const signals = [];
  const lines = [];
  let replacementPid = child.pid + 10_000;
  let childAlive = true;

  const psLine = `${child.pid} 1 00:01 ${process.execPath} ${runner} watch --all`;
  const execFileImpl = async (cmd, args) => {
    if (cmd === 'ps' && args[0] === '-axo') {
      try {
        const { stdout } = await execFileAsync(cmd, args);
        if (stdout.includes(String(child.pid))) return { stdout };
        return { stdout: `${psLine}\n${stdout}` };
      } catch {
        return { stdout: `${psLine}\n` };
      }
    }
    return execFileAsync(cmd, args);
  };

  const { servers } = await restartRegisteredServers({
    installRoot: install,
    targetVersion,
    env: { HOME: home, PATH: process.env.PATH, SWARM_TEST_TMP: '1' },
    home,
    write: t => lines.push(t),
    execFileImpl,
    strictPidCheck: false,
    sleep: async () => {},
    pidAliveImpl: pid => (pid === child.pid && childAlive) || pid === replacementPid,
    killImpl: (pid, sig) => {
      signals.push(sig);
      if (pid === child.pid && sig === 'SIGTERM') {
        child.kill('SIGTERM');
        childAlive = false;
      }
    },
    spawnImpl: () => {
      mkdirSync(path.dirname(boardPath), { recursive: true, mode: 0o700 });
      writeFileSync(boardPath, `${JSON.stringify({
        pid: replacementPid,
        url: `http://127.0.0.1:${port}/?t=secret-token`,
        startedAt: new Date().toISOString(),
        version: targetVersion,
        argv: ['watch', '--all'],
        cwd,
        port,
        env: {},
        mode: 'background',
        explicitBackground: true,
      })}\n`, { mode: 0o600 });
      return { on: () => {}, unref: () => {}, pid: replacementPid };
    },
    fetchImpl: async url => {
      if (String(url).includes('/api/health')) {
        return { ok: true, json: async () => ({ version: targetVersion, pid: replacementPid }) };
      }
      return { ok: false, json: async () => null };
    },
  });

  assert.ok(!signals.includes('SIGKILL'));
  assert.equal(servers.some(s => s.status === 'restarted'), true);
  assert.ok(lines.some(line => line.includes('secret-token')));
  try { child.kill('SIGKILL'); } catch { /* exited */ }
});

test('restarts a registry record whose version is null', async () => {
  const home = await mkHome();
  const install = path.join(home, 'install');
  const runner = path.join(install, 'current', 'tools', 'swarm.mjs');
  await fs.mkdir(path.dirname(runner), { recursive: true });
  await fs.writeFile(runner, 'export {}\n');
  const port = await freePort();
  const file = boardFile({ HOME: home }, home);
  const fakePid = 920_001;
  let alive = true;
  await writeRegistryRecord(file, {
    pid: fakePid,
    url: `http://127.0.0.1:${port}/?t=x`,
    startedAt: new Date().toISOString(),
    version: null,
    argv: ['watch', '--all'],
    cwd: home,
    port,
    env: {},
    mode: 'background',
    explicitBackground: true,
  });
  const signals = [];
  const { servers } = await restartRegisteredServers({
    installRoot: install,
    targetVersion: '2.0.0',
    env: { HOME: home, PATH: process.env.PATH },
    home,
    execFileImpl: async (_cmd, args) => {
      if (args.some(arg => String(arg).includes('command'))) {
        return { stdout: `${process.execPath} ${runner} watch --all\n` };
      }
      return { stdout: '10:00\n' };
    },
    strictPidCheck: true,
    sleep: async () => {},
    pidAliveImpl: pid => (pid === fakePid && alive) || pid === 920_002,
    killImpl: (pid, sig) => {
      signals.push(sig);
      if (pid === fakePid) alive = false;
    },
    spawnImpl: () => {
      mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      writeFileSync(file, `${JSON.stringify({
        pid: 920_002,
        url: `http://127.0.0.1:${port}/?t=x`,
        startedAt: new Date().toISOString(),
        version: '2.0.0',
        argv: ['watch', '--all'],
        cwd: home,
        port,
        env: {},
        mode: 'background',
        explicitBackground: true,
      })}\n`, { mode: 0o600 });
      return { on: () => {}, unref: () => {}, pid: 920_002 };
    },
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({ version: '2.0.0', pid: 920_002 }),
    }),
  });
  assert.ok(!signals.includes('SIGKILL'));
  assert.equal(servers[0]?.status, 'restarted');
});

test('discovery ignores unrelated processes that only mention watch', async () => {
  const home = await mkHome();
  const install = path.join(home, 'install');
  const runner = path.join(install, 'current', 'tools', 'swarm.mjs');
  await fs.mkdir(path.dirname(runner), { recursive: true });
  await fs.writeFile(runner, 'export {}\n');
  const psText = [
    `${process.pid} 1 00:01 ${process.execPath} ${runner} watch --all`,
    `4242 1 00:01 ${process.execPath} /usr/local/bin/my-watch-daemon --all`,
  ].join('\n');
  const found = await discoverRunningServers({
    installRoot: install,
    selfPid: process.pid,
    execFileImpl: async (_cmd, args) => {
      if (args[0] === '-axo') return { stdout: psText };
      if (args.some(a => a === 'cwd')) return { stdout: `p4242\ncwd\nn${home}\n` };
      if (args.some(a => String(a).includes('LISTEN'))) return { stdout: '' };
      if (args.some(a => String(a).includes('tty'))) return { stdout: '??\n' };
      throw new Error(`unexpected exec ${args.join(' ')}`);
    },
    fetchImpl: async () => ({ ok: false, json: async () => null }),
  });
  assert.equal(found.some(row => row.pid === 4242), false);
});

test('macOS-style injected ps and lsof discovery', async () => {
  const home = await mkHome();
  const install = path.join(home, 'install');
  const runner = path.join(install, 'current', 'tools', 'swarm.mjs');
  await fs.mkdir(path.dirname(runner), { recursive: true });
  await fs.writeFile(runner, 'export {}\n');
  const pid = 55_001;
  const port = 18080;
  const psText = `${pid} 1 01:02:03 ${process.execPath} ${runner} watch --all`;
  const found = await discoverRunningServers({
    installRoot: install,
    selfPid: process.pid,
    platform: 'darwin',
    execFileImpl: async (_cmd, args) => {
      if (args[0] === '-axo') return { stdout: psText };
      if (args.some(a => a === 'cwd')) return { stdout: `p${pid}\ncwd\nn${home}\n` };
      if (args.some(a => String(a).includes('LISTEN'))) return { stdout: `p${pid}\nn127.0.0.1:${port}\n` };
      if (args.some(a => String(a).includes('tty'))) return { stdout: 'ttys001\n' };
      throw new Error(`unexpected exec ${args.join(' ')}`);
    },
    fetchImpl: async url => {
      if (String(url).includes(`:${port}/`)) {
        return { ok: true, json: async () => ({ version: '1.0.0', pid }) };
      }
      return { ok: false, json: async () => null };
    },
  });
  assert.equal(found.length, 1);
  assert.equal(found[0].pid, pid);
  assert.equal(found[0].port, port);
  assert.equal(found[0].mode, 'terminal');
});

test('Linux readlink cwd and ss listen discovery', async () => {
  const home = await mkHome();
  const install = path.join(home, 'install');
  const runner = path.join(install, 'current', 'tools', 'swarm.mjs');
  await fs.mkdir(path.dirname(runner), { recursive: true });
  await fs.writeFile(runner, 'export {}\n');
  const pid = 55_002;
  const port = 18081;
  const psText = `${pid} 1 00:10 ${process.execPath} ${runner} remote serve`;
  const found = await discoverRunningServers({
    installRoot: install,
    selfPid: process.pid,
    platform: 'linux',
    lsofAvailable: false,
    execFileImpl: async (cmd, args) => {
      if (args[0] === '-axo') return { stdout: psText };
      if (cmd === 'readlink') return { stdout: `${home}\n` };
      if (cmd === 'ss') return { stdout: `LISTEN 0 128 127.0.0.1:${port} 0.0.0.0:* users:(("node",pid=${pid},fd=21))\n` };
      if (args.some(a => String(a).includes('tty'))) return { stdout: '??\n' };
      throw new Error(`unexpected exec ${cmd} ${args.join(' ')}`);
    },
    fetchImpl: async url => {
      if (String(url).includes(`:${port}/`)) {
        return { ok: true, json: async () => ({ version: '1.0.0', pid }) };
      }
      return { ok: false, json: async () => null };
    },
  });
  assert.equal(found.length, 1);
  assert.equal(found[0].kind, 'remote');
  assert.equal(found[0].argv[0], 'remote');
});

test('parseLsofFnOutput and parseLsofListenPorts', () => {
  const cwd = parseLsofFnOutput(`p99\ncwd\nn/tmp/foo\n`);
  assert.equal(cwd.cwd, '/tmp/foo');
  assert.deepEqual(parseLsofListenPorts('n127.0.0.1:9090\nn[::1]:9091\n'), [9090, 9091]);
});

test('Linux /proc/net/tcp listen parser and inode matching', () => {
  const header = '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n';
  const ipv4Loopback = '   0: 0100007F:1F40 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 424242 1 0000000000000000 100 0 0 10 0\n';
  const ipv6Any = '   1: 0000000000000000:2328 0000000000000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 515151 1 0000000000000000 100 0 0 10 0\n';
  const notListen = '   2: 0100007F:3039 00000000:0000 01 00000000:00000000 00:00000000 00000000     0        0 616161 1 0000000000000000 100 0 0 10 0\n';
  const foreignInode = '   3: 0100007F:9999 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 717171 1 0000000000000000 100 0 0 10 0\n';
  const tcp = header + ipv4Loopback + notListen + foreignInode;
  const tcp6 = header + ipv6Any;

  assert.equal(parseReadlinkSocketInode('socket:[424242]'), 424242);
  assert.equal(parseReadlinkSocketInode('pipe:[1]'), null);

  const v4Row = parseProcNetTcpListenRow(ipv4Loopback, { ipv6: false });
  assert.equal(v4Row?.port, 8000);
  assert.equal(v4Row?.inode, 424242);
  assert.equal(parseProcNetTcpListenRow(notListen, { ipv6: false }), null);

  const v6Row = parseProcNetTcpListenRow(ipv6Any, { ipv6: true });
  assert.equal(v6Row?.port, 9000);
  assert.equal(v6Row?.inode, 515151);

  const ports = listenPortsMatchingProcInodes(
    [424242, 515151],
    tcp,
    tcp6,
  );
  assert.deepEqual(ports.sort((a, b) => a - b), [8000, 9000]);
});

test('Linux readlink cwd and /proc listen discovery when ss is missing', async () => {
  const home = await mkHome();
  const install = path.join(home, 'install');
  const runner = path.join(install, 'current', 'tools', 'swarm.mjs');
  await fs.mkdir(path.dirname(runner), { recursive: true });
  await fs.writeFile(runner, 'export {}\n');
  const pid = 55_003;
  const port = 18082;
  const psText = `${pid} 1 00:10 ${process.execPath} ${runner} remote serve`;
  const procTcp = [
    '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode',
    `   0: 0100007F:${port.toString(16).toUpperCase()} 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 888001 1 0000000000000000 100 0 0 10 0`,
  ].join('\n');
  const found = await discoverRunningServers({
    installRoot: install,
    selfPid: process.pid,
    platform: 'linux',
    lsofAvailable: false,
    execFileImpl: async (cmd, args) => {
      if (args[0] === '-axo') return { stdout: psText };
      if (cmd === 'readlink' && args[0] === `/proc/${pid}/cwd`) return { stdout: `${home}\n` };
      if (cmd === 'ss') throw new Error('ss not installed');
      if (args.some(a => String(a).includes('tty'))) return { stdout: '??\n' };
      throw new Error(`unexpected exec ${cmd} ${args.join(' ')}`);
    },
    readFileImpl: async file => {
      if (file === '/proc/net/tcp') return procTcp;
      if (file === '/proc/net/tcp6') return '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n';
      throw new Error(`unexpected read ${file}`);
    },
    readdirImpl: async dir => {
      if (dir === `/proc/${pid}/fd`) return ['3'];
      throw new Error(`unexpected readdir ${dir}`);
    },
    readlinkImpl: async target => {
      if (target === `/proc/${pid}/fd/3`) return 'socket:[888001]';
      throw new Error(`unexpected readlink ${target}`);
    },
    fetchImpl: async url => {
      if (String(url).includes(`:${port}/`)) {
        return { ok: true, json: async () => ({ version: '1.0.0', pid }) };
      }
      return { ok: false, json: async () => null };
    },
  });
  assert.equal(found.length, 1);
  assert.equal(found[0].port, port);
});

test('tty-attached discovery restart reports terminal session ended', async () => {
  const home = await mkHome();
  const install = path.join(home, 'install');
  const runner = path.join(install, 'current', 'tools', 'swarm.mjs');
  await fs.mkdir(path.dirname(runner), { recursive: true });
  await fs.writeFile(runner, 'export {}\n');
  const port = await freePort();
  const file = boardFile({ HOME: home }, home);
  const fakePid = 930_001;
  let alive = true;
  let spawned = false;
  const psText = `${fakePid} 1 00:05 ${process.execPath} ${runner} watch --all`;
  const lines = [];
  await restartRegisteredServers({
    installRoot: install,
    targetVersion: '2.0.0',
    env: { HOME: home, PATH: process.env.PATH, SWARM_TEST_TMP: '1' },
    home,
    write: t => lines.push(t),
    execFileImpl: async (_cmd, args) => {
      if (args[0] === '-axo') return { stdout: psText };
      if (args.some(a => a === 'cwd')) return { stdout: `p${fakePid}\ncwd\nn${home}\n` };
      if (args.some(a => String(a).includes('LISTEN'))) return { stdout: `p${fakePid}\nn127.0.0.1:${port}\n` };
      if (args.some(a => String(a).includes('tty'))) return { stdout: 'ttys003\n' };
      throw new Error(`unexpected exec ${args.join(' ')}`);
    },
    strictPidCheck: false,
    sleep: async () => {},
    pidAliveImpl: pid => (pid === fakePid && alive) || pid === 930_002,
    killImpl: pid => { if (pid === fakePid) alive = false; },
    spawnImpl: () => {
      spawned = true;
      mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      writeFileSync(file, `${JSON.stringify({
        pid: 930_002,
        url: `http://127.0.0.1:${port}/?t=newterm`,
        startedAt: new Date().toISOString(),
        version: '2.0.0',
        argv: ['watch', '--all'],
        cwd: home,
        port,
        env: {},
        mode: 'background',
        explicitBackground: true,
      })}\n`, { mode: 0o600 });
      return { on: () => {}, unref: () => {}, pid: 930_002 };
    },
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({
        version: spawned ? '2.0.0' : '1.0.0',
        pid: spawned ? 930_002 : fakePid,
      }),
    }),
  });
  assert.ok(lines.some(line => /terminal session ended/i.test(line)));
});
