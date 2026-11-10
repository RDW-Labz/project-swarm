// SPDX-License-Identifier: Apache-2.0

import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { brainAddressList, refreshBrainAddress } from '../tools/machine-commands.mjs';
import { localAddresses, mdnsHostName } from '../tools/machine-probe.mjs';

test('mdnsHostName turns LocalHostName into a .local name and rejects junk', () => {
  assert.equal(mdnsHostName('bradens-Mac-mini\n'), 'bradens-Mac-mini.local');
  assert.equal(mdnsHostName(''), undefined);
  assert.equal(mdnsHostName('bad name; rm -rf'), undefined);
});

test('localAddresses reports the Bonjour name on macOS only', async () => {
  const run = async (cmd, args) => {
    if (cmd === 'scutil') return { stdout: 'bradens-Mac-mini\n' };
    if (cmd === 'tailscale') return { stdout: '100.104.42.88\n' };
    if (cmd === 'sh' && args[1].includes('ipconfig')) return { stdout: '10.10.10.175\n' };
    return { stdout: '' };
  };
  assert.deepEqual(await localAddresses({ run, platform: 'darwin' }), { ip: '10.10.10.175', tailscaleHost: '100.104.42.88', mdnsHost: 'bradens-Mac-mini.local' });
  assert.equal((await localAddresses({ run, platform: 'linux' })).mdnsHost, undefined);
});

test('brain addresses put the hostname first and drop the old LAN IP', () => {
  const pointer = { host: '10.10.10.169', hosts: ['10.10.10.169', '100.104.42.88'] };
  const got = brainAddressList(pointer, { ip: '10.10.10.175', tailscaleHost: '100.104.42.88', mdnsHost: 'bradens-Mac-mini.local' });
  assert.deepEqual(got, { host: 'bradens-Mac-mini.local', hosts: ['bradens-Mac-mini.local', '10.10.10.175', '100.104.42.88'] });
  // no Bonjour name (Linux brain): today's IP leads, as before
  assert.deepEqual(brainAddressList(pointer, { ip: '10.10.10.175' }), { host: '10.10.10.175', hosts: ['10.10.10.175', '100.104.42.88'] });
  // no address info at all: keep what we had
  assert.deepEqual(brainAddressList(pointer, {}), { host: '10.10.10.169', hosts: ['10.10.10.169', '100.104.42.88'] });
});

test('refreshBrainAddress rewrites the pointer and the registry entry once', async () => {
  const home = await fs.mkdtemp(path.join(process.env.SWARM_TEST_TMP || os.tmpdir(), 'brain-addr-'));
  const dir = path.join(home, '.project-swarm');
  await fs.mkdir(dir, { recursive: true });
  const env = { ...process.env, PROJECT_SWARM_HOME: dir, SWARM_BRAIN_FILE: path.join(dir, 'brain.json'), SWARM_MACHINES_FILE: path.join(dir, 'machines.json') };
  await fs.writeFile(path.join(dir, 'brain.json'), JSON.stringify({ host: '10.10.10.169', user: 'prime', machine: 'mini', hosts: ['10.10.10.169', '100.104.42.88'], epoch: 0 }));
  await fs.writeFile(path.join(dir, 'machines.json'), JSON.stringify({ version: 1, brain: 'mini', order: ['mini'], machines: { mini: { name: 'mini', role: 'brain', host: '10.10.10.169', user: 'prime', hosts: ['10.10.10.169'] } } }));
  const addresses = async () => ({ ip: '10.10.10.175', tailscaleHost: '100.104.42.88', mdnsHost: 'bradens-Mac-mini.local' });
  const next = await refreshBrainAddress({ env, home, addresses, now: () => 0 });
  assert.equal(next.host, 'bradens-Mac-mini.local');
  const pointer = JSON.parse(await fs.readFile(path.join(dir, 'brain.json'), 'utf8'));
  assert.deepEqual(pointer.hosts, ['bradens-Mac-mini.local', '10.10.10.175', '100.104.42.88']);
  const registry = JSON.parse(await fs.readFile(path.join(dir, 'machines.json'), 'utf8'));
  assert.equal(registry.machines.mini.host, 'bradens-Mac-mini.local');
  assert.equal(registry.machines.mini.ip, '10.10.10.175');
  assert.deepEqual(registry.machines.mini.hosts, pointer.hosts);
  const before = await fs.stat(path.join(dir, 'brain.json'));
  await new Promise(r => setTimeout(r, 20));
  await refreshBrainAddress({ env, home, addresses, now: () => 0 });
  assert.equal((await fs.stat(path.join(dir, 'brain.json'))).mtimeMs, before.mtimeMs);
  await fs.rm(home, { recursive: true, force: true });
});
