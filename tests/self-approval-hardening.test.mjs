// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isSelfApprovalCommand, normalizeSelfApprovalCommandText } from '../tools/self-approval.mjs';
import { readState } from '../tools/handbuild.mjs';

const HOOK = fileURLToPath(new URL('../tools/orchestrator-hook.mjs', import.meta.url));
const tmp = async t => {
  const d = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-self-ap-')));
  t.after(() => fs.rm(d, { recursive: true, force: true }));
  return d;
};

function ownerTerminalEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  delete env.CLAUDECODE;
  delete env.CLAUDE_CODE_ENTRYPOINT;
  delete env.SWARM_AGENT_SESSION;
  return env;
}

async function project(t) {
  const root = await tmp(t);
  const git = (...args) => spawnSync('git', ['-c', 'user.email=a@b', '-c', 'user.name=a', ...args], { cwd: root, encoding: 'utf8', env: ownerTerminalEnv() });
  git('init', '-q');
  await fs.mkdir(path.join(root, 'src'), { recursive: true });
  await fs.writeFile(path.join(root, 'src', 'a.ts'), 'a\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'base');
  return { root };
}

async function installOrchestratorHook(root) {
  await fs.mkdir(path.join(root, '.claude'), { recursive: true });
  const command = `test -f ${JSON.stringify(HOOK)} && node ${JSON.stringify(HOOK)} prompt || true`;
  await fs.writeFile(path.join(root, '.claude', 'settings.local.json'), `${JSON.stringify({
    hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command }] }] },
  }, null, 2)}\n`);
}

async function fakeClaudeHome(t) {
  const home = await tmp(t);
  await fs.mkdir(path.join(home, '.claude', 'projects', 'self-approval-test'), { recursive: true });
  return home;
}

async function writeTranscript(home, lastUserText, rel = `t-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`) {
  const transcriptPath = path.join(home, '.claude', 'projects', 'self-approval-test', rel);
  await fs.writeFile(transcriptPath, `${JSON.stringify({ type: 'user', message: { content: lastUserText } })}\n`);
  return transcriptPath;
}

function runHook(root, { prompt, transcript_path, home }) {
  return spawnSync(process.execPath, [HOOK, 'prompt'], {
    input: JSON.stringify({
      session_id: 'sess',
      cwd: root,
      transcript_path,
      hook_event_name: 'UserPromptSubmit',
      prompt,
    }),
    encoding: 'utf8',
    env: ownerTerminalEnv({ HOME: home }),
  });
}

test('isSelfApprovalCommand: script path, quoting, and nested shells', () => {
  const trueCases = [
    'node tools/swarm.mjs handbuild off',
    "swarm handbuild o''ff",
    'node tools/swarm.mjs decide handbuild-42 approve',
    'swarm decide handbuild-abc approve',
    'node .\\/tools\\/swarm.mjs handbuild approve x',
    'bash -c "swarm handbuild deny hb-1"',
    'python3 -c "import subprocess; subprocess.run([\'swarm\',\'decide\',\'x\',\'approve\'])"',
  ];
  for (const cmd of trueCases) {
    assert.ok(isSelfApprovalCommand(cmd), cmd);
  }
  const falseCases = [
    'git status',
    'swarm go',
    'swarm run',
    'swarm tickets',
    'swarm handbuild status',
    'swarm handbuild request',
    'swarm handbuild request --kind tiny',
  ];
  for (const cmd of falseCases) {
    assert.equal(isSelfApprovalCommand(cmd), false, cmd);
  }
  assert.equal(normalizeSelfApprovalCommandText("swarm handbuild o''ff"), 'swarm handbuild off');
});

test('chat merge hook: transcript path and last user line must match prompt', async t => {
  const home = await fakeClaudeHome(t);
  const { root } = await project(t);
  await installOrchestratorHook(root);
  runHook(root, { prompt: 'merge 42', transcript_path: path.join(os.tmpdir(), 'forged-transcript.jsonl'), home });
  assert.equal(readState(root).merges?.['42'], undefined);

  const { root: root2 } = await project(t);
  await installOrchestratorHook(root2);
  const good = await writeTranscript(home, 'merge 7');
  runHook(root2, { prompt: 'merge 7', transcript_path: good, home });
  assert.ok(readState(root2).merges?.['7'] > 0);

  const { root: root3 } = await project(t);
  await installOrchestratorHook(root3);
  const bad = await writeTranscript(home, 'merge 99');
  runHook(root3, { prompt: 'merge 7', transcript_path: bad, home });
  assert.equal(readState(root3).merges?.['7'], undefined);
});
