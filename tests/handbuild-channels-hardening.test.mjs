// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readState, createRequest } from '../tools/handbuild.mjs';
import { decide } from '../tools/inbox.mjs';
import { decideChannelFromEnvironment } from '../tools/inbox-commands.mjs';
import { isSelfApprovalCommand, SELF_APPROVAL_REASON } from '../tools/self-approval.mjs';
import { syncPhone } from '../tools/phone.mjs';
import { appendEvent, readJournal } from '../tools/journal.mjs';
import { inboxDeps } from '../tools/inbox-commands.mjs';

const HOOK = fileURLToPath(new URL('../tools/orchestrator-hook.mjs', import.meta.url));
const T0 = Date.UTC(2026, 9, 20, 12, 0, 0);
const tmp = async t => { const d = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-hb-hard-'))); t.after(() => fs.rm(d, { recursive: true, force: true })); return d; };

function ownerTerminalEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  delete env.CLAUDECODE;
  delete env.CLAUDE_CODE_ENTRYPOINT;
  delete env.SWARM_AGENT_SESSION;
  return env;
}

async function project(t) {
  const root = await tmp(t);
  const git = (...args) => spawnSync('git', ['-c', 'user.email=a@b', '-c', 'user.name=a', ...args], { cwd: root, encoding: 'utf8' });
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
  await fs.mkdir(path.join(home, '.claude', 'projects', 'hb-ch-test'), { recursive: true });
  return home;
}

async function writeTranscript(home, lastUserText, rel = `hb-ch-${Date.now()}.jsonl`) {
  const transcriptPath = path.join(home, '.claude', 'projects', 'hb-ch-test', rel);
  await fs.writeFile(transcriptPath, `${JSON.stringify({ type: 'user', message: { content: lastUserText } })}\n`);
  return transcriptPath;
}

async function runHook(prompt, extra = {}) {
  const cwd = extra.cwd ?? process.cwd();
  const home = extra.home;
  const transcript_path = extra.transcript_path ?? (home ? await writeTranscript(home, prompt, extra.transcriptRel) : undefined);
  return spawnSync(process.execPath, [HOOK, 'prompt'], {
    input: JSON.stringify({
      session_id: 's',
      cwd,
      transcript_path,
      hook_event_name: extra.hook_event_name ?? 'UserPromptSubmit',
      prompt,
    }),
    encoding: 'utf8',
    env: ownerTerminalEnv(home ? { HOME: home } : {}),
  });
}

async function journalDeps(root, { now = () => T0, channel } = {}) {
  return {
    ...inboxDeps({ now, channel }),
    readJournal: (r, o) => readJournal(r, o),
    appendEvent: (r, e, o) => appendEvent(r, e, o),
  };
}

test('chat merge hook: exact one-line prompts only on UserPromptSubmit', async t => {
  const home = await fakeClaudeHome(t);
  const cases = [
    { prompt: 'merge 42', expect: '42' },
    { prompt: 'merge #7', expect: '7' },
    { prompt: 'MERGE PR #99', expect: '99' },
    { prompt: 'merge pull request #12', expect: '12' },
  ];
  for (const { prompt, expect } of cases) {
    const { root } = await project(t);
    await installOrchestratorHook(root);
    await runHook(prompt, { cwd: root, home });
    assert.ok(readState(root).merges[expect] > T0, prompt);
  }
  const { root: root2 } = await project(t);
  await installOrchestratorHook(root2);
  await runHook('merge 42', { cwd: root2, home, hook_event_name: 'PreToolUse' });
  assert.equal(readState(root2).merges['42'], undefined);
});

test('chat merge hook: forged or ambiguous prompts record nothing', async t => {
  const home = await fakeClaudeHome(t);
  const forged = [
    JSON.stringify({ prompt: 'merge 5' }),
    '```\nmerge 5\n```',
    'Please do NOT\nmerge 42\nuntil CI is green',
    '1. merge #203',
    'merge 1\nmerge 2',
    'merge 42 and merge 43',
    'please merge 42',
  ];
  for (const prompt of forged) {
    const { root } = await project(t);
    await installOrchestratorHook(root);
    await runHook(prompt, { cwd: root, home });
    const merges = readState(root).merges ?? {};
    assert.equal(Object.keys(merges).length, 0, `should not record: ${JSON.stringify(prompt).slice(0, 60)}`);
  }
});

test('isSelfApprovalCommand detects forgery forms; ordinary commands are false', () => {
  assert.ok(isSelfApprovalCommand('node tools/orchestrator-hook.mjs prompt'));
  assert.ok(isSelfApprovalCommand('bash -c "echo merge | node orchestrator-hook.mjs"'));
  assert.ok(isSelfApprovalCommand('node -e "require(\\"./handbuild\\").recordChatMerge()"'));
  assert.ok(isSelfApprovalCommand('swarm decide handbuild-hb-abc approve'));
  assert.ok(isSelfApprovalCommand('node tools/swarm.mjs decide handbuild-hb-x approve'));
  assert.ok(isSelfApprovalCommand('swarm handbuild approve hb-1'));
  assert.ok(isSelfApprovalCommand('node tools/inbox-commands.mjs'));
  assert.ok(isSelfApprovalCommand('tee .swarm/handbuild/state.json'));
  assert.equal(isSelfApprovalCommand('git status'), false);
  assert.equal(isSelfApprovalCommand('swarm go'), false);
  assert.match(SELF_APPROVAL_REASON, /orchestrator session cannot approve/i);
});

test('decide channel agent refuses elevated hand-build approve', async t => {
  const { root } = await project(t);
  const req = createRequest(root, { kind: 'tiny', reason: 'the swarm cannot merge from agent decide', files: 'src/a.ts', git: 'merge', minutes: 30 }, { now: () => T0 });
  await appendEvent(root, {
    kind: 'decision',
    id: `handbuild-${req.id}`,
    text: 't',
    choice: 'deny',
    options: ['approve', 'deny'],
    confirm: true,
  }, { now: () => T0 });
  const ref = `handbuild-${req.id}`;
  const agentDeps = await journalDeps(root, { channel: 'agent' });
  await assert.rejects(() => decide(root, ref, 'approve', agentDeps), /handbuild-computer-only:/);
  await decide(root, ref, 'approve', await journalDeps(root, { channel: 'computer' }));
});

test('decideChannelFromEnvironment: non-TTY and Claude Code env yield agent', () => {
  const savedIn = process.stdin.isTTY;
  const savedOut = process.stdout.isTTY;
  try {
    process.stdin.isTTY = false;
    process.stdout.isTTY = true;
    assert.equal(decideChannelFromEnvironment({}), 'agent');
    process.stdin.isTTY = true;
    process.stdout.isTTY = true;
    assert.equal(decideChannelFromEnvironment({ CLAUDECODE: '1' }), 'agent');
    assert.equal(decideChannelFromEnvironment({ CLAUDE_CODE_ENTRYPOINT: 'cli' }), 'agent');
    assert.equal(decideChannelFromEnvironment({}), 'computer');
  } finally {
    process.stdin.isTTY = savedIn;
    process.stdout.isTTY = savedOut;
  }
});

test('phone path: padded uppercase Approve refused for elevated; no runSwarm decide fallback', async t => {
  const { root } = await project(t);
  const req = createRequest(root, { kind: 'tiny', reason: 'the swarm cannot merge from phone sync path', files: 'src/a.ts', git: 'merge', minutes: 30 }, { now: () => T0 });
  await appendEvent(root, {
    kind: 'decision',
    id: `handbuild-${req.id}`,
    text: 't',
    choice: 'deny',
    options: ['approve', 'deny'],
    confirm: true,
  }, { now: () => T0 });
  const dir = await tmp(t);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'config.json'), JSON.stringify({ repo: 'o/r', owners: ['me'], enabled: true }));
  const key = `${root}|decision|handbuild-${req.id}`;
  const phoneState = {
    repo: 'o/r',
    issues: {
      '1': {
        key,
        kind: 'decision',
        root,
        projectName: 'p',
        itemId: `handbuild-${req.id}`,
        options: ['approve', 'deny'],
        default: 'approve',
        status: 'open',
        createdAt: T0,
        expiresAt: T0 + 86400000,
        seen: [],
      },
    },
  };
  await fs.writeFile(path.join(dir, 'state.json'), JSON.stringify(phoneState));
  let swarmRan = false;
  let decidedChoice = null;
  const r = await syncPhone({
    dir,
    deps: {
      now: () => T0 + 1000,
      gh: async () => JSON.stringify([{ id: 'c1', body: '1', user: { login: 'me', type: 'User' }, created_at: new Date(T0 + 1000).toISOString(), updated_at: new Date(T0 + 1000).toISOString() }]),
      items: async () => [{ key, root, projectName: 'p', kind: 'decision', itemId: `handbuild-${req.id}`, title: 't', options: ['  Approve  ', 'deny'], default: '  Approve  ', secondStep: false }],
      decideInbox: async (_root, _id, choice) => { decidedChoice = choice; return { ok: true, text: 'ok' }; },
      runSwarm: async () => { swarmRan = true; return { ok: true, text: 'ok' }; },
    },
  });
  assert.equal(r.ok, true);
  assert.equal(swarmRan, false);
  assert.equal(decidedChoice, null);
  assert.equal(readState(root).requests[req.id].status, 'pending');
});

test('phone path: padded uppercase Approve succeeds for non-elevated hand-build', async t => {
  const { root } = await project(t);
  const req = createRequest(root, { kind: 'tiny', reason: 'the swarm cannot commit from phone only', files: 'src/a.ts', git: 'commit', minutes: 30 }, { now: () => T0 });
  await appendEvent(root, {
    kind: 'decision',
    id: `handbuild-${req.id}`,
    text: 't',
    choice: 'deny',
    options: ['approve', 'deny'],
    confirm: true,
  }, { now: () => T0 });
  const dir = await tmp(t);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'config.json'), JSON.stringify({ repo: 'o/r', owners: ['me'], enabled: true }));
  const key = `${root}|decision|handbuild-${req.id}`;
  await fs.writeFile(path.join(dir, 'state.json'), JSON.stringify({
    repo: 'o/r',
    issues: {
      '2': {
        key,
        kind: 'decision',
        root,
        projectName: 'p',
        itemId: `handbuild-${req.id}`,
        options: ['  Approve  ', 'deny'],
        default: '  Approve  ',
        status: 'open',
        createdAt: T0,
        expiresAt: T0 + 86400000,
        seen: [],
      },
    },
  }));
  let decidedChoice = null;
  const r = await syncPhone({
    dir,
    deps: {
      now: () => T0 + 1000,
      gh: async () => JSON.stringify([{ id: 'c2', body: '1', user: { login: 'me', type: 'User' }, created_at: new Date(T0 + 1000).toISOString(), updated_at: new Date(T0 + 1000).toISOString() }]),
      items: async () => [{ key, root, projectName: 'p', kind: 'decision', itemId: `handbuild-${req.id}`, title: 't', options: ['  Approve  ', 'deny'], default: '  Approve  ', secondStep: false }],
      decideInbox: async (_root, _id, choice) => { decidedChoice = choice; return { ok: true, text: 'ok' }; },
      runSwarm: async () => ({ ok: false, text: 'must not run' }),
    },
  });
  assert.equal(r.ok, true);
  assert.equal(decidedChoice, 'approve');
});
