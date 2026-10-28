// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HOOK = fileURLToPath(new URL('../tools/orchestrator-hook.mjs', import.meta.url));
const SWARM_MJS = fileURLToPath(new URL('../tools/swarm.mjs', import.meta.url));
const TOOLS_DIR = fileURLToPath(new URL('../tools', import.meta.url));

const PLAIN_JOB = {
  id: 'j1',
  agent: 'claude',
  model: 'sonnet',
  prompt: 'work',
  context: [],
  outputs: ['src/a.ts'],
};

async function walkMjsFiles(dir) {
  const out = [];
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await walkMjsFiles(full));
    else if (entry.isFile() && entry.name.endsWith('.mjs')) out.push(full);
  }
  return out;
}

const tmp = async t => {
  const d = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-hook-import-')));
  t.after(() => fs.rm(d, { recursive: true, force: true }));
  return d;
};

async function installOrchestratorHook(root) {
  await fs.mkdir(path.join(root, '.claude'), { recursive: true });
  const command = `test -f ${JSON.stringify(HOOK)} && node ${JSON.stringify(HOOK)} pre || true`;
  await fs.writeFile(path.join(root, '.claude', 'settings.local.json'), `${JSON.stringify({
    hooks: { PreToolUse: [{ hooks: [{ type: 'command', command }] }] },
  }, null, 2)}\n`);
}

async function orchestratorProject(t, { checksArgv = null } = {}) {
  const root = await tmp(t);
  await fs.mkdir(path.join(root, '.git'));
  await fs.mkdir(path.join(root, '.swarm', 'runs'), { recursive: true });
  await fs.mkdir(path.join(root, 'coordination', 'manifests'), { recursive: true });
  const checks = checksArgv === null ? [] : [{ name: 'safe-check', argv: checksArgv }];
  await fs.writeFile(
    path.join(root, 'coordination', 'checks.json'),
    `${JSON.stringify({ checks }, null, 2)}\n`,
  );
  await installOrchestratorHook(root);
  return root;
}

function swarmValidate(root, rel, envExtra = {}) {
  return spawnSync(process.execPath, [SWARM_MJS, '--root', root, 'validate', rel], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, CLAUDECODE: '1', ...envExtra },
  });
}

test('validate plain manifest under CLAUDECODE does not exit via hook script import', async t => {
  const root = await orchestratorProject(t, { checksArgv: null });
  const rel = 'coordination/manifests/plain.json';
  await fs.writeFile(
    path.join(root, rel),
    `${JSON.stringify({
      version: 1,
      jobs: [PLAIN_JOB],
    }, null, 2)}\n`,
  );
  const r = swarmValidate(root, rel);
  assert.equal(r.status, 0, r.stderr || r.stdout);
  const parsed = JSON.parse(r.stdout.trim());
  assert.equal(parsed.status, 'valid');
});

test('validate refuses unvetted checks argv under CLAUDECODE with hook installed', async t => {
  const root = await orchestratorProject(t, { checksArgv: ['npm', 'test'] });
  const rel = 'coordination/manifests/bad.json';
  await fs.writeFile(
    path.join(root, rel),
    `${JSON.stringify({
      version: 1,
      jobs: [{ ...PLAIN_JOB, outputs: [] }],
      checks: [{ name: 'evil', argv: [process.execPath, '-e', '1'] }],
    }, null, 2)}\n`,
  );
  const r = swarmValidate(root, rel);
  assert.notEqual(r.status, 0);
  const text = `${r.stdout}\n${r.stderr}`;
  assert.match(text, /orchestrator-manifest-unvetted|not a vetted command/);
  let parsed;
  try {
    parsed = JSON.parse(r.stdout.trim());
  } catch {
    parsed = null;
  }
  if (parsed?.status) assert.equal(parsed.status, 'error');
});

test('tools/*.mjs do not import orchestrator-hook.mjs except the hook script itself', async () => {
  const hookRel = './orchestrator-hook.mjs';
  const importRe = /(?:import\s*\(|import\s+[\s\S]*?from\s+|export\s+[\s\S]*?from\s+)['"](\.\.?\/orchestrator-hook\.mjs)['"]/g;
  const files = await walkMjsFiles(TOOLS_DIR);
  for (const filePath of files) {
    const base = path.basename(filePath);
    const text = await fs.readFile(filePath, 'utf8');
    if (base === 'orchestrator-hook.mjs') continue;
    for (const match of text.matchAll(importRe)) {
      assert.fail(`${path.relative(TOOLS_DIR, filePath)} must not import ${match[1] ?? hookRel}`);
    }
    assert.doesNotMatch(
      text,
      /import\s*\(\s*['"]\.\.?\/orchestrator-hook\.mjs['"]\s*\)/,
      `${path.relative(TOOLS_DIR, filePath)} must not dynamically import orchestrator-hook.mjs`,
    );
  }
});
