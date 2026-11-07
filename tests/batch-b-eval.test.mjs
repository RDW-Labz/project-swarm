// SPDX-License-Identifier: Apache-2.0
// Scenario evals for lessons 16 (tool config files), 21 (DB test job rules) and 26 (no loose process kills).
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { runScopeCommand } from '../tools/scope-commands.mjs';
import { parseScope } from '../tools/scope.mjs';
import { ticketsToManifest } from '../tools/ticket-manifest.mjs';
import { missingToolConfigs } from '../tools/tool-config.mjs';
import { validateManifest } from '../tools/swarm.mjs';
import { looseKill } from '../tools/process-guard.mjs';
import { shellMessage } from '../tools/claude-shell.mjs';
import { readLessons } from '../tools/lessons.mjs';

const tmp = async (t, prefix) => { const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix))); t.after(() => fs.rm(root, { recursive: true, force: true })); return root; };
const SCOPE = ['# Scope: Demo', 'Version: 1', '', '## Overview', 'Demo app.', '', '## Stages', '- S1: Core', '',
  '## S1 Core', '### R-001 A user can create a request.', 'Acceptance:', '- Returns 201.', '', '## Protected', '- .env', ''].join('\n');
const item = (key, extra) => ({ key, title: key, type: 'build', scopeRefs: ['R-001'], acceptance: ['ok'], files: [`src/${key}.mjs`], size: 'S', risk: 'low', ...extra });
const DB = item('dbtest', { type: 'test', acceptance: ['supabase test db passes'], files: ['supabase/tests/r001.sql'] });
const MOUNT = item('mount', { integration: true, files: ['src/routes/r.mjs'], tests: ['tests/routes.test.mjs'] });
async function fakeRun(root, id, items) {
  const ws = `.swarm/workspaces/${id}/split-S1`;
  await fs.mkdir(path.join(root, ws, 'docs/scope/split'), { recursive: true });
  await fs.writeFile(path.join(root, ws, 'docs/scope/split/S1.json'), JSON.stringify(items));
  await fs.mkdir(path.join(root, '.swarm/runs', id), { recursive: true });
  await fs.writeFile(path.join(root, '.swarm/runs', id, 'state.json'), JSON.stringify({ id, jobs: [{ id: 'split-S1', status: 'complete', workspace: ws }] }));
}

test('eval 37.1 (lesson 16): an acceptance check that runs a tool with no config ticket is flagged', async t => {
  const root = await tmp(t, 'b37-');
  await fs.mkdir(path.join(root, 'docs/scope'), { recursive: true });
  await fs.writeFile(path.join(root, 'docs/scope/scope.md'), SCOPE);
  execFileSync('git', ['init', '-q'], { cwd: root });
  await fakeRun(root, 'r1', [item('mod'), DB, MOUNT]);
  // Old behavior: nothing noticed that supabase test db needs supabase/config.toml, and no ticket made it.
  const split = await runScopeCommand(root, 'scope', ['split', '--ingest', 'r1']);
  assert.equal(split.exitCode, 0, split.stdout);
  assert.match(split.stdout, /warning: T-0002 run supabase in their acceptance, but no ticket writes supabase\/config\.toml and the project has none/);
  const check = await runScopeCommand(root, 'scope', ['check']);
  assert.match(check.stdout, /no ticket writes supabase\/config\.toml/);
  // A ticket that writes the file, or a project that already has it, silences the warning.
  const cfg = item('cfg', { files: ['supabase/config.toml'] });
  assert.deepEqual(missingToolConfigs([{ id: 'T-1', type: 'test', status: 'todo', acceptance: ['supabase test db passes'], files: [] }, { id: 'T-2', type: 'build', status: 'todo', files: ['supabase/config.toml'] }]), []);
  assert.deepEqual(missingToolConfigs([{ id: 'T-1', type: 'test', status: 'todo', acceptance: ['supabase test db passes'], files: [] }], ['supabase/config.toml']), []);
  assert.equal(missingToolConfigs([{ id: 'T-1', type: 'test', status: 'todo', acceptance: ['cypress run passes'], files: [] }])[0].config, 'cypress.config.ts');
  // No false warnings: prose that only names a product, tools that run without a config, a runtime library, a config in a subfolder.
  const warn = (acceptance, files = []) => missingToolConfigs([{ id: 'T-1', type: 'build', status: 'todo', acceptance: [acceptance], files: [] }], files);
  assert.deepEqual(warn('the profile row is saved in Supabase and supabase.auth.signUp works'), []);
  assert.deepEqual(warn('vitest run passes and eslint is clean and jest and playwright test pass'), []);
  assert.deepEqual(warn('queries use drizzle-orm and prisma.user.findMany returns rows'), []);
  assert.deepEqual(warn('supabase test db passes', ['apps/db/supabase/config.toml']), []);
  assert.equal(warn('drizzle-kit generate works')[0].config, 'drizzle.config.ts');
  assert.equal(cfg.files[0], 'supabase/config.toml');
  // The split prompt asks for it.
  const { buildSplitManifest } = await import('../tools/scope-commands.mjs');
  assert.match(buildSplitManifest(parseScope(SCOPE), {}).jobs[0].prompt, /a ticket must write that tool's config file/);
});

test('eval 37.2 (lesson 21): a ticket that writes or runs DB tests gets the runner rules in its prompt', () => {
  const scope = parseScope(SCOPE);
  const base = { id: 'T-0001', title: 'DB tests', type: 'test', epic: 'E', scopeRefs: ['R-001'], acceptance: ['supabase test db passes'], files: ['supabase/tests/r001.sql'], context: [], contracts: [], dependsOn: [], size: 'S', risk: 'low', sensitive: false, status: 'ready', stage: 'S1' };
  const contextEnv = { exists: () => true, sizes: {}, listFiles: () => [], profileContext: {} };
  const prompt = ticket => ticketsToManifest([ticket], { ledger: { tickets: [] }, scope, ready: true, contextEnv }).manifest.jobs[0].prompt;
  // Old behavior: no such rule, so the worker put helpers in subfolders, used \ir outside the mounted folder, and used dblink.
  assert.match(prompt(base), /runs every \.sql file in supabase\/tests and in all its subfolders/);
  assert.match(prompt(base), /can only \\ir files inside the folder the runner mounts/);
  assert.match(prompt(base), /Do not use dblink as a non-superuser/);
  assert.doesNotMatch(prompt({ ...base, type: 'build', files: ['src/a.ts'], acceptance: ['returns 201'] }), /pgTAP/);
  // Not for a migration ticket that only mentions the test run, nor a plain-postgres db/tests folder.
  assert.doesNotMatch(prompt({ ...base, type: 'migration', files: ['supabase/migrations/0001.sql'] }), /pgTAP/);
  assert.doesNotMatch(prompt({ ...base, files: ['db/tests/a.sql'], acceptance: ['pg_prove passes'] }), /pgTAP/);
});

test('eval 37.3 (lesson 26): a manifest command that kills processes by a loose pattern is refused, and workers and agents are told', () => {
  for (const bad of ['pkill -f cat', 'killall node', 'kill $(pgrep -f vite)', 'pgrep -f vite | xargs kill', 'sh -c "pkill -f x"', '/usr/bin/pkill -f node', 'kill $(lsof -ti :5432)', 'fuser -k 5432/tcp', 'npx kill-port 5432']) assert.equal(looseKill(bad), true, bad);
  for (const ok of ['kill 4242', 'npm test', 'node scripts/pkill-free.mjs', 'echo skill', 'pkill -P 123', 'pkill -F app.pid', 'kill $(pgrep -P $$)', 'cat app.pid | xargs kill', "! grep -rn 'pkill' scripts/"]) assert.equal(looseKill(ok), false, ok);
  const manifest = argv => ({ version: 1, jobs: [{ id: 'j', agent: 'ollama', model: 'm', prompt: 'x', context: [], outputs: ['out.txt'], timeoutMs: 5000 }], checks: [{ name: 'stop', argv }] });
  assert.throws(() => validateManifest(manifest(['sh', '-c', 'pkill -f cat'])), /loose-kill/);
  assert.doesNotThrow(() => validateManifest(manifest(['npm', 'test'])));
  assert.match(shellMessage({ context: [], outputs: ['a'], prompt: '' }, { files: [] }), /Never stop a process by a loose pattern \(pkill -f, killall/);
});

test('eval 37.4: an ingest conflict names the exact tickets and file', async t => {
  const root = await tmp(t, 'b37-conflict-');
  await fs.mkdir(path.join(root, 'docs/scope'), { recursive: true });
  await fs.writeFile(path.join(root, 'docs/scope/scope.md'), SCOPE);
  const mount = (key, extra = {}) => ({
    key,
    title: key,
    type: 'build',
    integration: true,
    scopeRefs: ['R-001'],
    acceptance: ['ok'],
    files: ['src/routes/r.mjs'],
    tests: ['tests/routes.test.mjs'],
    size: 'S',
    risk: 'low',
    ...extra,
  });
  const a = { key: 'a', title: 'Create list page', type: 'build', scopeRefs: ['R-001'], acceptance: ['ok'], files: ['src/pages/list.tsx'], size: 'S', risk: 'low' };
  const b = { key: 'b', title: 'Add list filters', type: 'build', scopeRefs: ['R-001'], acceptance: ['ok'], files: ['src/pages/list.tsx'], size: 'S', risk: 'low' };
  await fakeRun(root, 'r1', [a, b, mount('m1')]);
  const ingested = await runScopeCommand(root, 'scope', ['split', '--ingest', 'r1']);
  assert.equal(ingested.exitCode, 0, ingested.stdout);
  const { readLedger } = await import('../tools/tickets.mjs');
  const ledger = await readLedger(root);
  const ta = ledger.tickets.find(ticket => ticket.title === 'Create list page');
  const tb = ledger.tickets.find(ticket => ticket.title === 'Add list filters');
  assert.ok(ta && tb);
  if (tb.dependsOn?.includes(ta.id)) {
    assert.deepEqual(tb.dependsOn, [ta.id]);
  } else {
    const blockers = await (await import('../tools/journal.mjs')).readJournal(root, { kinds: ['blocker'] });
    const text = blockers.map(event => event.text ?? '').join('\n');
    assert.match(text, /T-0001.*Create list page.*T-0002.*Add list filters|Create list page.*Add list filters/);
    assert.match(text, /src\/pages\/list\.tsx/);
  }
});

test('eval 37.4 (lesson 26): the agent pointer files carry the rule', async () => {
  for (const f of ['AGENTS.md', 'CLAUDE.md', 'GEMINI.md', 'cursor-rule.mdc']) assert.match(await fs.readFile(path.join(path.dirname(new URL(import.meta.url).pathname), '../templates/agent-pointers', f), 'utf8'), /Never stop a process by a loose pattern/, f);
});

test('eval 37.5 (lesson 2): the repo lesson store is valid and lesson 2 is closed', async () => {
  // A malformed row makes every swarm run fail with lesson-store-invalid.
  const root = path.join(path.dirname(new URL(import.meta.url).pathname), '..');
  const rows = await readLessons(root, { storeFile: 'coordination/swarm-lessons.jsonl' });
  const two = (rows.rows ?? rows).find(r => r.id === 2);
  assert.equal(two.status, 'shipped');
  assert.equal(two.version, '1.66.0');
});
