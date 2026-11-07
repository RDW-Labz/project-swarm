import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { installService, serviceStatus, plistPath, LABEL } from '../tools/service-launchd.mjs';

async function withHome(fn) {
  const home = await mkdtemp(path.join(tmpdir(), 'swarm-launchd-'));
  try {
    return await fn(home);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

function fakeLaunchctl(printOutput) {
  const calls = [];
  const fn = async (args) => {
    calls.push(args);
    if (args[0] === 'print') {
      if (printOutput === null) throw new Error('Could not find service');
      return printOutput;
    }
    return '';
  };
  return { fn, calls };
}

test('AC1: swarm service install writes and loads a user launchd agent', async () => {
  await withHome(async (home) => {
    const lc = fakeLaunchctl(null);
    const res = await installService({
      home,
      uid: 501,
      nodePath: '/usr/local/bin/node',
      scriptPath: '/repo/tools/swarm.mjs',
      platform: 'darwin',
      launchctl: lc.fn,
    });
    assert.equal(res.plist, plistPath({ home, label: LABEL }));
    const xml = await readFile(res.plist, 'utf8');
    assert.match(xml, /<key>Label<\/key>\s*<string>dev\.projectswarm\.service<\/string>/);
    assert.match(xml, /<string>\/repo\/tools\/swarm\.mjs<\/string>/);
    assert.match(xml, /<key>KeepAlive<\/key>\s*<true\/>/);
    const boot = lc.calls.find((c) => c[0] === 'bootstrap');
    assert.deepEqual(boot, ['bootstrap', 'gui/501', res.plist]);
  });
});

test('AC1: install refuses to run on a non-darwin platform', async () => {
  await withHome(async (home) => {
    const lc = fakeLaunchctl(null);
    await assert.rejects(
      installService({ home, uid: 501, scriptPath: '/x.mjs', platform: 'linux', launchctl: lc.fn }),
      /macOS launchd/,
    );
    assert.equal(lc.calls.length, 0);
  });
});

test('AC2: swarm service status reports running when the agent is loaded', async () => {
  const out = 'gui/501/dev.projectswarm.service = {\n\tstate = running\n\tpid = 4242\n}\n';
  const lc = fakeLaunchctl(out);
  const status = await serviceStatus({ uid: 501, launchctl: lc.fn });
  assert.equal(status.loaded, true);
  assert.equal(status.running, true);
  assert.equal(status.pid, 4242);
});

test('AC2: swarm service status reports not running when launchctl has no such service', async () => {
  const lc = fakeLaunchctl(null);
  const status = await serviceStatus({ uid: 501, launchctl: lc.fn });
  assert.equal(status.loaded, false);
  assert.equal(status.running, false);
});
