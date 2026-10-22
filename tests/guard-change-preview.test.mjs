// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { guardDecision } from '../tools/handbuild.mjs';
import {
  HANDBUILD_CHANGE_RECORD_RULE_ID,
  CHANGE_RECORD_DENY_REASON,
  isSelfApprovalCommand,
  swarmChangeShellPolicy,
} from '../tools/self-approval.mjs';
import { isolatedHome } from './_isolate-config.mjs';

const GUARD = fileURLToPath(new URL('../tools/handbuild-guard.mjs', import.meta.url));
const SWARM_MJS = fileURLToPath(new URL('../tools/swarm.mjs', import.meta.url));

const ORCH_ENV = Object.freeze({
  HOME: isolatedHome,
  PATH: process.env.PATH ?? '/usr/bin:/bin',
});

const tmpProject = async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-change-guard-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, '.git'));
  await fs.mkdir(path.join(root, 'docs', 'scope'), { recursive: true });
  return root;
};

const decide = (root, command, { cwd = root } = {}) => guardDecision({
  tool: 'Bash',
  toolInput: { command },
  root,
  cwd,
  home: ORCH_ENV.HOME,
});

function runGuardHook(root, command, { cwd = root } = {}) {
  const input = JSON.stringify({
    tool_name: 'Bash',
    tool_input: { command },
    cwd,
  });
  return spawnSync(process.execPath, [GUARD], {
    input,
    encoding: 'utf8',
    env: { ...ORCH_ENV, CLAUDE_PROJECT_DIR: root },
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

function previewForms({ root, swarmScript = SWARM_MJS }) {
  const reason = '"owner approved path rename"';
  const file = 'docs/scope/build-plan.md';
  const r = root;
  const relSwarm = path.relative(root, swarmScript) || swarmScript;
  return [
    { name: 'plain', cmd: `swarm change ${reason} ${file}` },
    { name: 'root-flag', cmd: `swarm --root ${JSON.stringify(r)} change ${reason} ${file}` },
    { name: 'cd-prefix', cmd: `cd ${JSON.stringify(root)} && swarm change ${reason} ${file}` },
    { name: 'node-runner', cmd: `node ${JSON.stringify(swarmScript)} --root ${JSON.stringify(r)} change ${reason} ${file}` },
    { name: 'node-relative', cmd: `cd ${JSON.stringify(root)} && node ${JSON.stringify(relSwarm)} change ${reason} ${file}` },
    { name: 'quoted-reason', cmd: `swarm change 'approved scope tweak' ${file}` },
    { name: 'pipe-filter', cmd: `swarm change ${reason} ${file} | head -20` },
  ];
}

function recordForms({ root, swarmScript = SWARM_MJS }) {
  const r = root;
  return [
    { name: 'plain', cmd: 'swarm change "record it" docs/scope/build-plan.md --yes' },
    { name: 'root-flag', cmd: `swarm --root ${JSON.stringify(r)} change "record it" --yes` },
    { name: 'node-runner', cmd: `node ${JSON.stringify(swarmScript)} --root ${JSON.stringify(r)} change "record" --yes` },
  ];
}

test('swarm change preview is allowed across invocation forms', async t => {
  const root = await tmpProject(t);
  for (const form of previewForms({ root })) {
    const pol = swarmChangeShellPolicy(form.cmd);
    assert.equal(pol.allow, true, form.name);
    assert.equal(isSelfApprovalCommand(form.cmd), false, form.name);
    const d = decide(root, form.cmd);
    assert.equal(d.allow, true, `${form.name}: ${form.cmd}`);
    const hook = runGuardHook(root, form.cmd);
    assert.equal(hookDenied(hook), null, form.name);
  }
});

test('swarm change --yes is refused with handbuild-change-record rule id', async t => {
  const root = await tmpProject(t);
  for (const form of recordForms({ root })) {
    const pol = swarmChangeShellPolicy(form.cmd);
    assert.equal(pol.allow, false, form.name);
    assert.equal(pol.ruleId, HANDBUILD_CHANGE_RECORD_RULE_ID, form.name);
    const d = decide(root, form.cmd);
    assert.equal(d.allow, false, form.name);
    assert.equal(d.ruleId, HANDBUILD_CHANGE_RECORD_RULE_ID, form.name);
    assert.equal(d.reason, CHANGE_RECORD_DENY_REASON, form.name);
    assert.match(d.reason, /without --yes to preview/i);
    const hook = runGuardHook(root, form.cmd);
    const out = hookDenied(hook);
    assert.equal(out?.permissionDecision, 'deny');
    assert.equal(out?.ruleId, HANDBUILD_CHANGE_RECORD_RULE_ID);
  }
});
