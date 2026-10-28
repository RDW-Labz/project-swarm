import './_isolate-config.mjs';
// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { orchestratorModeCommandAllowed, orchestratorSwarmSubfolderBlocked } from '../tools/shell-writes.mjs';

async function project(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-t2-cd-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  for (const dir of ['docs/plans', '.swarm/project', 'coordination/manifests']) {
    await fs.mkdir(path.join(root, dir), { recursive: true });
  }
  return { root, cwd: root };
}

function verdict(ctx, command, expected) {
  assert.equal(orchestratorModeCommandAllowed(command, { root: ctx.root, cwd: ctx.root }), expected, command);
}

test('plain plan redirects and absolute cd reads stay allowed', async t => {
  const ctx = await project(t);
  verdict(ctx, 'echo x > docs/plans/a.md', true);
  verdict(ctx, `cd ${ctx.root}/docs && cat plans/a.md`, true);
});

for (const construct of ['pushd docs', 'popd']) {
  test(`${construct} is refused before a plan redirect`, async t => {
    const ctx = await project(t);
    verdict(ctx, `${construct} && echo x > docs/plans/a.md`, false);
    verdict(ctx, `cd docs && ${construct} && echo x > plans/a.md`, false);
  });
}

test('subshell cd restores the matching opening directory', async t => {
  const ctx = await project(t);
  verdict(ctx, '( cd docs && true ) && echo x > plans/a.md', false);
  verdict(ctx, '( cd docs && true ) && echo x > docs/plans/a.md', true);
  verdict(ctx, '( cd docs ) && echo x > docs/plans/a.md', false);
  verdict(ctx, '( cd docs && echo x > plans/a.md )', true);
  verdict(ctx, '( cd docs && echo x > docs/plans/a.md )', false);
  verdict(ctx, '( cd docs && true; ) && echo x > plans/a.md', false);
  verdict(ctx, '( cd docs && true; ) && echo x > docs/plans/a.md', true);
  // Each close must restore its own saved cwd, including adjacent parentheses.
  verdict(ctx, '( cd docs && ( cd plans && true ) && echo x > plans/a.md ) && echo x > docs/plans/b.md', true);
  verdict(ctx, '(( cd docs && true )) && echo x > plans/a.md', false);
  verdict(ctx, '(( cd docs && true )) && echo x > docs/plans/a.md', true);
  verdict(ctx, 'cd docs && ( cd plans && true ) && echo x > plans/a.md', true);
  verdict(ctx, '( cd docs && true ) > docs/plans/a.md', true);
  verdict(ctx, '( cd docs && true ) > plans/a.md', false);
});

test('brace group cd persists in the surrounding shell', async t => {
  const ctx = await project(t);
  // A bare cd before ; is conservatively refused by the existing guard.
  verdict(ctx, '{ cd docs; } && echo x > plans/a.md', false);
  verdict(ctx, '{ cd docs && true; } && echo x > plans/a.md', true);
  verdict(ctx, '{ cd docs && true; } && echo x > docs/plans/a.md', false);
});

for (const wrapper of ['sh -c', 'bash -c', 'zsh -c', 'eval']) {
  test(`${wrapper} wrapping cd and a redirect is refused`, async t => {
    const ctx = await project(t);
    verdict(ctx, `${wrapper} 'cd docs && echo x > plans/a.md'`, false);
    verdict(ctx, `${wrapper} 'cd docs' && echo x > docs/plans/a.md`, false);
  });
}

for (const wrapper of ['exec', 'builtin', 'command']) {
  test(`${wrapper} cd is refused before a plan redirect`, async t => {
    const ctx = await project(t);
    verdict(ctx, `${wrapper} cd docs && echo x > plans/a.md`, false);
    verdict(ctx, `${wrapper} cd docs && echo x > docs/plans/a.md`, false);
  });
}

test('CDPATH set refuses relative cd before a plan redirect', async t => {
  const ctx = await project(t);
  const previous = process.env.CDPATH;
  try {
    process.env.CDPATH = path.join(ctx.root, 'docs');
    verdict(ctx, 'cd plans && echo x > docs/plans/a.md', false);
    verdict(ctx, 'CDPATH=docs cd plans && echo x > docs/plans/a.md', false);
  } finally {
    if (previous === undefined) delete process.env.CDPATH;
    else process.env.CDPATH = previous;
  }
});

for (const variable of ['VAR', 'PWD', 'OLDPWD']) {
  test(`cd $${variable} is refused before a plan redirect`, async t => {
    const ctx = await project(t);
    const previous = process.env[variable];
    try {
      process.env[variable] = path.join(ctx.root, 'docs');
      verdict(ctx, `cd $${variable} && echo x > docs/plans/a.md`, false);
      verdict(ctx, `cd $${variable} && echo x > plans/a.md`, false);
    } finally {
      if (previous === undefined) delete process.env[variable];
      else process.env[variable] = previous;
    }
  });
}

test('cd command substitution is refused before a plan redirect', async t => {
  const ctx = await project(t);
  verdict(ctx, 'cd $(printf docs) && echo x > docs/plans/a.md', false);
  verdict(ctx, 'cd $(printf docs) && echo x > plans/a.md', false);
});

for (const wrapper of ['env', 'time']) {
  test(`${wrapper} cd keeps its current refused verdict`, async t => {
    const ctx = await project(t);
    verdict(ctx, `${wrapper} cd docs && echo x > docs/plans/a.md`, false);
    verdict(ctx, `${wrapper} cd docs && echo x > plans/a.md`, false);
  });
}

test('swarm subfolder tracking scopes cd to the matching subshell', async t => {
  const ctx = await project(t);
  assert.equal(orchestratorSwarmSubfolderBlocked('( cd docs && true ) && swarm status', ctx), false);
  assert.equal(orchestratorSwarmSubfolderBlocked('( cd docs && swarm status )', ctx), true);
  assert.equal(orchestratorSwarmSubfolderBlocked('( cd docs && true; ) && swarm status', ctx), false);
  assert.equal(orchestratorSwarmSubfolderBlocked('cd docs && ( cd .. && true ) && swarm status', ctx), true);
  assert.equal(orchestratorSwarmSubfolderBlocked('( cd docs && ( cd plans && true ) && swarm status )', ctx), true);
});
