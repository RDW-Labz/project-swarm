// SPDX-License-Identifier: Apache-2.0
// Investigation cause (primary): (d) self-approval.mjs and shell-writes.mjs classifiers — SWARM_INLINE /
// .swarm/handbuild static markers and a naive token scan after "handbuild" treated node … swarm.mjs
// handbuild request|status as self-approval; fixed with verb-aware parsing and orchestrator allowlist.
// Secondary: (f) explicit owner-verb policy in guardDecision via handbuildShellPolicy (rule handbuild-owner-verb).
// Hook path (a): end-to-end PreToolUse payloads; install copy (b): refresh stale hook via dynamic ensureHandbuildGuard.
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { guardDecision } from '../tools/handbuild.mjs';
import { HANDBUILD_OWNER_RULE_ID, HANDBUILD_SELF_APPROVAL_RULE_ID, SELF_APPROVAL_REASON } from '../tools/self-approval.mjs';
import { isolatedHome } from './_isolate-config.mjs';

const GUARD = fileURLToPath(new URL('../tools/handbuild-guard.mjs', import.meta.url));
const SWARM_MJS = fileURLToPath(new URL('../tools/swarm.mjs', import.meta.url));
const PACKAGE_ROOT = path.dirname(path.dirname(SWARM_MJS));

const ORCH_ENV = Object.freeze({
  HOME: isolatedHome,
  PATH: process.env.PATH ?? '/usr/bin:/bin',
  CLAUDECODE: '1',
  CURSOR_AGENT: '1',
});

const ALLOWED_VERBS = ['request', 'status', 'list', 'show', 'log', 'check', 'help'];
const OWNER_VERBS = ['approve', 'deny', 'on', 'off', 'install', 'uninstall'];

const tmpProject = async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-hb-verbs-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, '.git'));
  await fs.mkdir(path.join(root, 'src'));
  return root;
};

const decide = (root, command, { cwd = root, env = ORCH_ENV } = {}) => guardDecision({
  tool: 'Bash',
  toolInput: { command },
  root,
  cwd,
  home: env.HOME,
});

function runGuardHook(root, command, { cwd = root, env = ORCH_ENV } = {}) {
  const input = JSON.stringify({
    tool_name: 'Bash',
    tool_input: { command },
    cwd,
  });
  return spawnSync(process.execPath, [GUARD], {
    input,
    encoding: 'utf8',
    env: { ...env, CLAUDE_PROJECT_DIR: root },
  });
}

function hookDenied(result) {
  if (!result.stdout?.trim()) return null;
  try {
    const parsed = JSON.parse(result.stdout.trim().split('\n').pop());
    return parsed?.hookSpecificOutput ?? null;
  } catch {
    return null;
  }
}

function invocationForms({ root, swarmScript = SWARM_MJS, spaceRoot = null }) {
  const r = spaceRoot ?? root;
  const relSwarm = path.relative(root, swarmScript) || swarmScript;
  const forms = [
    { name: 'plain', cmd: v => `swarm handbuild ${v}` },
    { name: 'root-flag', cmd: v => `swarm --root ${JSON.stringify(r)} handbuild ${v}` },
    { name: 'cd-prefix', cmd: v => `cd ${JSON.stringify(root)} && swarm handbuild ${v}` },
    { name: 'node-runner', cmd: v => `node ${JSON.stringify(swarmScript)} --root ${JSON.stringify(r)} handbuild ${v}` },
    { name: 'node-relative', cmd: v => `cd ${JSON.stringify(root)} && node ${JSON.stringify(relSwarm)} handbuild ${v}` },
    { name: 'env-prefix', cmd: v => `FOO=1 swarm handbuild ${v}` },
    { name: 'time-prefix', cmd: v => `time swarm handbuild ${v}` },
    { name: 'pipe-filter', cmd: v => `swarm handbuild ${v} | head -5` },
    { name: 'substitution', cmd: v => `$(echo swarm) handbuild ${v}` },
  ];
  if (spaceRoot) {
    forms.push({
      name: 'space-path-node',
      cmd: v => `node ${JSON.stringify(swarmScript)} --root ${JSON.stringify(spaceRoot)} handbuild ${v}`,
    });
  }
  return forms;
}

test('orchestrator handbuild verbs: allowed and owner-only across invocation forms', async t => {
  const root = await tmpProject(t);
  const spaceRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'swarm hb space ')));
  t.after(() => fs.rm(spaceRoot, { recursive: true, force: true }));
  await fs.mkdir(path.join(spaceRoot, '.git'));
  await fs.mkdir(path.join(spaceRoot, 'src'));

  const forms = invocationForms({ root, spaceRoot });

  for (const verb of ALLOWED_VERBS) {
    const tail = verb === 'request'
      ? 'request --kind tiny --reason "orchestrator needs a hand-build window" --files src/a.ts'
      : verb === 'show'
        ? 'show hb-test'
        : verb;
    for (const form of forms) {
      const command = form.cmd(tail);
      const d = decide(root, command);
      assert.equal(d.allow, true, `${form.name} allowed verb ${verb}: ${command}`);
      for (const claudeFlag of [undefined, '1']) {
        const env = { ...ORCH_ENV, ...(claudeFlag ? { CLAUDECODE: claudeFlag } : {}) };
        if (!claudeFlag) delete env.CLAUDECODE;
        const hook = runGuardHook(root, command, { env });
        assert.equal(hook.status, 0, hook.stderr);
        assert.equal(hookDenied(hook), null, `${form.name} hook allow ${verb}`);
      }
    }
  }

  for (const verb of OWNER_VERBS) {
    const tail = verb === 'approve' || verb === 'deny' ? `${verb} hb-test` : verb;
    for (const form of forms) {
      const command = form.cmd(tail);
      const d = decide(root, command);
      assert.equal(d.allow, false, `${form.name} owner verb ${verb}`);
      assert.equal(d.ruleId, HANDBUILD_OWNER_RULE_ID);
      assert.match(d.reason, new RegExp(`\\[${HANDBUILD_OWNER_RULE_ID}\\].*handbuild ${verb}`));
      const hook = runGuardHook(root, command);
      const out = hookDenied(hook);
      assert.equal(out?.permissionDecision, 'deny');
      assert.equal(out?.ruleId, HANDBUILD_OWNER_RULE_ID);
      assert.match(out?.permissionDecisionReason ?? '', new RegExp(`\\[${HANDBUILD_OWNER_RULE_ID}\\]`));
    }
  }

  const decideBlock = 'swarm decide handbuild-hb-abc approve';
  assert.equal(decide(root, decideBlock).allow, false);
  assert.match(decide(root, decideBlock).reason, new RegExp(`\\[${HANDBUILD_OWNER_RULE_ID}\\]`));
});

test('request --reason containing approve, deny, on, or off stays allowed', async t => {
  const root = await tmpProject(t);
  for (const word of ['approve', 'deny', 'on', 'off']) {
    const command = `swarm handbuild request --kind tiny --reason "${word} the commit window must not block" --files src/a.ts`;
    const d = decide(root, command);
    assert.equal(d.allow, true, word);
    assert.equal(runGuardHook(root, command).stdout.trim(), '', word);
  }
});

test('bare handbuild and --help are allowed; unknown verb is not guard-blocked', async t => {
  const root = await tmpProject(t);
  for (const command of [
    'swarm handbuild',
    'swarm handbuild --help',
    `node ${JSON.stringify(SWARM_MJS)} handbuild not-a-real-subcommand`,
  ]) {
    const d = decide(root, command);
    assert.equal(d.allow, true, command);
  }
});

test('installed hook copy matches source after refresh', async t => {
  const root = await tmpProject(t);
  const { ensureHandbuildGuard } = await import('../tools/install.mjs');
  const settingsPath = path.join(root, '.claude', 'settings.local.json');
  await fs.mkdir(path.dirname(settingsPath), { recursive: true });
  await fs.writeFile(settingsPath, JSON.stringify({
    hooks: {
      PreToolUse: [{
        matcher: 'Bash|Write|Edit|MultiEdit|NotebookEdit',
        hooks: [{ type: 'command', command: 'node "/stale/handbuild-guard.mjs"' }],
      }],
    },
  }, null, 2));
  const r = await ensureHandbuildGuard(root, PACKAGE_ROOT, { refreshOnly: false });
  assert.ok(['created', 'updated'].includes(r.status));
  const settings = JSON.parse(await fs.readFile(settingsPath, 'utf8'));
  const cmd = settings.hooks.PreToolUse[0].hooks[0].command;
  assert.match(cmd, /handbuild-guard\.mjs/);
  const blocked = 'swarm handbuild approve hb-stale';
  const srcHook = runGuardHook(root, blocked);
  const linkedScript = cmd.match(/"([^"]+handbuild-guard\.mjs)"/)?.[1];
  assert.ok(linkedScript && fsSync.existsSync(linkedScript));
  const copyHook = spawnSync(process.execPath, [linkedScript], {
    input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: blocked }, cwd: root }),
    encoding: 'utf8',
    env: { ...ORCH_ENV, CLAUDE_PROJECT_DIR: root },
  });
  const srcOut = hookDenied(srcHook);
  const copyOut = hookDenied(copyHook);
  assert.equal(srcOut?.ruleId, copyOut?.ruleId);
  assert.equal(srcOut?.permissionDecision, 'deny');
});

test('legacy self-approval path still names handbuild-self-approval rule id', async t => {
  const root = await tmpProject(t);
  const command = 'bash -c "swarm handbuild deny hb-1"';
  const d = decide(root, command);
  assert.equal(d.allow, false);
  assert.ok(d.ruleId === HANDBUILD_OWNER_RULE_ID || d.reason === SELF_APPROVAL_REASON || d.ruleId === HANDBUILD_SELF_APPROVAL_RULE_ID);
});
