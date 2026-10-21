// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  defaultSessionName,
  slugFromBasename,
  cmdUp,
  cmdDown,
  cmdLaunchdInstall,
  cmdLaunchdUninstall,
  defaultDeps,
  ORCHESTRATOR_USAGE,
  runOrchestratorCommand,
} from '../tools/orchestrator-up.mjs';

const rootDir = fileURLToPath(new URL('../', import.meta.url));
const scriptPath = fileURLToPath(new URL('../tools/orchestrator-up.mjs', import.meta.url));

function makeFakeBinDir(names) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-bin-'));
  for (const name of names) {
    const p = path.join(dir, name);
    fs.writeFileSync(p, '#!/bin/sh\nexit 0\n');
    fs.chmodSync(p, 0o755);
  }
  return dir;
}

function fakeDeps({ platform = 'darwin', home, uid = 502, root, pathBin, runImpl }) {
  const calls = [];
  const run = (cmd, args, opts = {}) => {
    calls.push({ cmd, args, opts, shell: opts.shell });
    if (runImpl) return runImpl(cmd, args, opts, calls);
    return { code: 1, stdout: '', stderr: '' };
  };
  const env = { PATH: pathBin };
  return {
    deps: defaultDeps({
      env,
      home: home ?? fs.mkdtempSync(path.join(os.tmpdir(), 'orch-home-')),
      platform,
      uid,
      realpath: async p => p,
      scriptPath,
      run,
    }),
    calls,
  };
}

test('default slug for My Repo! is swarm-orch-my-repo', () => {
  assert.equal(slugFromBasename('My Repo!'), 'my-repo');
  assert.equal(defaultSessionName('My Repo!'), 'swarm-orch-my-repo');
});

test('up when has-session succeeds starts nothing and reports running', async () => {
  const bin = makeFakeBinDir(['tmux', 'claude']);
  const project = await fsp.mkdtemp(path.join(os.tmpdir(), 'orch-proj-'));
  const { deps, calls } = fakeDeps({
    root: project,
    pathBin: bin,
    runImpl: (cmd, args) => {
      if (cmd.endsWith('tmux') && args[0] === 'has-session') return { code: 0, stdout: '', stderr: '' };
      return { code: 1, stdout: '', stderr: '' };
    },
  });
  const r = await cmdUp(deps, { root: project });
  assert.equal(r.exitCode, 0);
  assert.equal(r.json.status, 'running');
  assert.equal(calls.filter(c => c.args[0] === 'new-session').length, 0);
});

test('up when has-session fails runs exactly one new-session with claude remote-control', async () => {
  const bin = makeFakeBinDir(['tmux', 'claude']);
  const project = await fsp.mkdtemp(path.join(os.tmpdir(), 'orch-proj-'));
  const { deps, calls } = fakeDeps({
    pathBin: bin,
    runImpl: (cmd, args) => {
      if (cmd.endsWith('tmux') && args[0] === 'has-session') return { code: 1, stdout: '', stderr: '' };
      if (cmd.endsWith('tmux') && args[0] === 'new-session') return { code: 0, stdout: '', stderr: '' };
      return { code: 1, stdout: '', stderr: '' };
    },
  });
  const r = await cmdUp(deps, { root: project, name: 'my-orch' });
  assert.equal(r.exitCode, 0);
  assert.equal(r.json.status, 'started');
  const news = calls.filter(c => c.args[0] === 'new-session');
  assert.equal(news.length, 1);
  const args = news[0].args;
  assert.ok(args.includes('-c'));
  assert.equal(args[args.indexOf('-c') + 1], project);
  assert.deepEqual(args.slice(-4), ['claude', 'remote-control', '--name', 'my-orch']);
});

test('--permission-mode appended only when given', async () => {
  const bin = makeFakeBinDir(['tmux', 'claude']);
  const project = await fsp.mkdtemp(path.join(os.tmpdir(), 'orch-proj-'));
  const { deps, calls } = fakeDeps({
    pathBin: bin,
    runImpl: (cmd, args) => {
      if (args[0] === 'has-session') return { code: 1, stdout: '', stderr: '' };
      if (args[0] === 'new-session') return { code: 0, stdout: '', stderr: '' };
      return { code: 1, stdout: '', stderr: '' };
    },
  });
  await cmdUp(deps, { root: project, name: 's1' });
  assert.ok(!calls.some(c => c.args.includes('--permission-mode')));
  calls.length = 0;
  await cmdUp(deps, { root: project, name: 's2', permissionMode: 'plan' });
  const news = calls.find(c => c.args[0] === 'new-session');
  assert.ok(news.args.includes('--permission-mode'));
  assert.equal(news.args[news.args.indexOf('--permission-mode') + 1], 'plan');
});

test('bad mode and bad name refuse before any spawn', async () => {
  const bin = makeFakeBinDir(['tmux', 'claude']);
  const project = await fsp.mkdtemp(path.join(os.tmpdir(), 'orch-proj-'));
  const { deps, calls } = fakeDeps({ pathBin: bin });
  const badMode = await cmdUp(deps, { root: project, permissionMode: 'nope' });
  assert.equal(badMode.exitCode, 1);
  assert.equal(badMode.json.code, 'orchestrator-bad-mode');
  assert.equal(calls.length, 0);
  const badName = await cmdUp(deps, { root: project, name: 'bad name!' });
  assert.equal(badName.json.code, 'orchestrator-bad-name');
  assert.equal(calls.length, 0);
});

test('missing tmux on PATH refuses orchestrator-missing-tool with no spawn', async () => {
  const bin = makeFakeBinDir(['claude']);
  const project = await fsp.mkdtemp(path.join(os.tmpdir(), 'orch-proj-'));
  const { deps, calls } = fakeDeps({ pathBin: bin });
  const r = await cmdUp(deps, { root: project });
  assert.equal(r.json.code, 'orchestrator-missing-tool');
  assert.match(r.json.error, /tmux/);
  assert.equal(calls.length, 0);
});

test('down uses kill-session with =NAME exactly', async () => {
  const bin = makeFakeBinDir(['tmux']);
  const project = await fsp.mkdtemp(path.join(os.tmpdir(), 'orch-proj-'));
  const { deps, calls } = fakeDeps({
    pathBin: bin,
    runImpl: (cmd, args) => {
      if (args[0] === 'has-session') return { code: 0, stdout: '', stderr: '' };
      if (args[0] === 'kill-session') return { code: 0, stdout: '', stderr: '' };
      return { code: 1, stdout: '', stderr: '' };
    },
  });
  const r = await cmdDown(deps, { root: project, name: 'seat-a' });
  assert.equal(r.json.status, 'stopped');
  const kill = calls.find(c => c.args[0] === 'kill-session');
  assert.deepEqual(kill.args, ['kill-session', '-t', '=seat-a']);
});

test('launchd dry-run on darwin returns plist with escaped root and writes no file', async () => {
  const bin = makeFakeBinDir(['tmux', 'claude']);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-home-'));
  const project = path.join(os.tmpdir(), 'proj&co');
  await fsp.mkdir(project, { recursive: true });
  const { deps, calls } = fakeDeps({ pathBin: bin, home, platform: 'darwin' });
  const r = await cmdLaunchdInstall(deps, { root: project, name: 'orch-seat', dryRun: true });
  assert.equal(r.json.status, 'dry-run');
  assert.match(r.json.plist, /com\.project-swarm\.orchestrator\.orch-seat/);
  assert.match(r.json.plist, /RunAtLoad/);
  assert.match(r.json.plist, /&amp;/);
  assert.equal(calls.length, 0);
  await assert.rejects(fsp.stat(path.join(home, 'Library', 'LaunchAgents', `${r.json.label}.plist`)));
});

test('launchd install writes plist and bootstraps launchctl', async () => {
  const bin = makeFakeBinDir(['tmux', 'claude']);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-home-'));
  const project = await fsp.mkdtemp(path.join(os.tmpdir(), 'orch-proj-'));
  const { deps, calls } = fakeDeps({
    pathBin: bin,
    home,
    platform: 'darwin',
    uid: 501,
    runImpl: (cmd, args) => {
      if (args[0] === 'bootstrap') return { code: 0, stdout: '', stderr: '' };
      return { code: 0, stdout: '', stderr: '' };
    },
  });
  const r = await cmdLaunchdInstall(deps, { root: project, name: 'orch-seat' });
  assert.equal(r.json.status, 'installed');
  const stat = await fsp.stat(r.json.plistPath);
  assert.equal(stat.mode & 0o777, 0o644);
  const boot = calls.find(c => c.args[0] === 'bootstrap');
  assert.deepEqual(boot.args, ['bootstrap', 'gui/501', r.json.plistPath]);
});

test('launchd uninstall removes plist', async () => {
  const bin = makeFakeBinDir(['tmux', 'claude']);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-home-'));
  const project = await fsp.mkdtemp(path.join(os.tmpdir(), 'orch-proj-'));
  const { deps } = fakeDeps({ pathBin: bin, home, platform: 'darwin' });
  const inst = await cmdLaunchdInstall(deps, { root: project, name: 'orch-seat' });
  const un = await cmdLaunchdUninstall(deps, { root: project, name: 'orch-seat' });
  assert.equal(un.json.removed, true);
  assert.equal(un.json.note, 'tmux session left running; use down');
  await assert.rejects(fsp.stat(inst.json.plistPath));
});

test('launchd on linux refuses orchestrator-not-macos', async () => {
  const bin = makeFakeBinDir(['tmux', 'claude']);
  const project = await fsp.mkdtemp(path.join(os.tmpdir(), 'orch-proj-'));
  const { deps } = fakeDeps({ pathBin: bin, platform: 'linux' });
  const r = await cmdLaunchdInstall(deps, { root: project, name: 'x' });
  assert.equal(r.json.code, 'orchestrator-not-macos');
});

test('no recorded run call uses shell:true', async () => {
  const bin = makeFakeBinDir(['tmux', 'claude']);
  const project = await fsp.mkdtemp(path.join(os.tmpdir(), 'orch-proj-'));
  const { deps, calls } = fakeDeps({
    pathBin: bin,
    runImpl: (cmd, args) => {
      if (args[0] === 'has-session') return { code: 1, stdout: '', stderr: '' };
      if (args[0] === 'new-session') return { code: 0, stdout: '', stderr: '' };
      return { code: 0, stdout: '', stderr: '' };
    },
  });
  await cmdUp(deps, { root: project, name: 'n1' });
  await cmdDown(deps, { root: project, name: 'n1' });
  await cmdLaunchdInstall(deps, { root: project, name: 'n1', dryRun: true });
  for (const c of calls) {
    assert.notEqual(c.shell, true);
    assert.notEqual(c.opts?.shell, true);
  }
});

test('unknown command exits with orchestrator-usage', async () => {
  const r = await runOrchestratorCommand(['nope'], defaultDeps({ env: { PATH: '' } }));
  assert.equal(r.exitCode, 1);
  assert.equal(r.json.code, 'orchestrator-usage');
});

test('--help via execFile exits 0', async () => {
  await new Promise((resolve, reject) => {
    execFile(process.execPath, [scriptPath, '--help'], (err, stdout, stderr) => {
      if (err) reject(err);
      else {
        assert.match(stdout, /orchestrator-up/);
        assert.equal(stderr, '');
        resolve();
      }
    });
  });
});

test('usage constant matches help output shape', () => {
  assert.ok(ORCHESTRATOR_USAGE.includes('up|down|status'));
});
