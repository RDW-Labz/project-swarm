import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLedger, approveLedger, writeLedger } from '../tools/tickets.mjs';
import { parseScope, scopeHash, SCOPE_TEMPLATE } from '../tools/scope.mjs';
import { readProfile, qualityFor, packageManagerOf, contextEnvFor } from '../tools/scope-commands.mjs';
import { loadLocalConfig } from '../tools/local-config.mjs';
import { ticketsToManifest } from '../tools/ticket-manifest.mjs';
import { verifyJobProvenance } from '../tools/verify-provenance.mjs';
import { orchestratorManifestGate, omRunManifestVetted } from '../tools/om-manifest-guard.mjs';

const env = { CLAUDECODE: '1' };
const hook = fileURLToPath(new URL('../tools/orchestrator-hook.mjs', import.meta.url));

async function fixture(t, { ledger: includeLedger = true } = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-verify-provenance-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, '.git'));
  await fs.mkdir(path.join(root, '.swarm', 'project'), { recursive: true });
  await fs.mkdir(path.join(root, '.swarm', 'runs'));
  await fs.mkdir(path.join(root, '.claude'));
  await fs.writeFile(path.join(root, '.claude', 'settings.local.json'), JSON.stringify({
    hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: `node ${JSON.stringify(hook)} pre` }] }] },
  }));
  await fs.writeFile(path.join(root, '.project-swarm.json'), JSON.stringify({ profile: {
    verify: { agent: 'claude', command: ['node', '--test', '{tests}'], setup: [['npm', 'ci']] },
  } }));
  const text = SCOPE_TEMPLATE;
  const scope = parseScope(text);
  await fs.mkdir(path.join(root, 'docs', 'scope'), { recursive: true });
  await fs.writeFile(path.join(root, 'docs', 'scope', 'scope.md'), text);
  await fs.writeFile(path.join(root, '.swarm', 'project', 'scope.snapshot.md'), text);
  const ledger = approveLedger(createLedger({ scope: {
    name: scope.name, version: scope.version, hash: scopeHash(text), file: 'docs/scope/scope.md',
  }, tickets: [{
    id: 'T-0001', title: 'Verify the parser', type: 'test', status: 'ready',
    scopeRefs: ['R-001'], acceptance: ['The parser tests pass'], size: 'S', risk: 'low',
    files: ['tests/parser.test.mjs'], context: [], dependsOn: [],
  }] }));
  if (includeLedger) await writeLedger(root, ledger);
  const profile = await readProfile(root);
  assert.ok(profile?.verify);
  let laneModels;
  try { laneModels = loadLocalConfig().lanes; } catch { /* runner fallback */ }
  const { manifest } = ticketsToManifest(ledger.tickets, {
    ledger, scope, ready: true, lessons: [], verify: profile.verify,
    quality: await qualityFor(root, profile), packageManager: packageManagerOf(profile),
    contextEnv: contextEnvFor(root, profile), laneModels,
  });
  assert.equal(manifest.jobs[0].shell, true);
  return { root, ledger, manifest };
}

const refused = (root, manifest, reason) => assert.rejects(
  orchestratorManifestGate(root, manifest, env),
  error => error.code === 'orchestrator-manifest-unvetted'
    && error.message.includes('T-0001') && error.message.includes(reason),
);

test('exact generated shell verify job passes, including JSON round trip and canonical keys', async t => {
  const { root, manifest, ledger } = await fixture(t);
  assert.deepEqual(await verifyJobProvenance(root, manifest.jobs[0]), { ok: true });
  await orchestratorManifestGate(root, manifest, env);
  await orchestratorManifestGate(root, JSON.parse(JSON.stringify(manifest)), env);
  manifest.jobs[0] = Object.fromEntries(Object.entries(manifest.jobs[0]).reverse());
  manifest.jobs[0].omitted = undefined;
  await orchestratorManifestGate(root, manifest, env);
  // The runner marks tickets running before it starts the saved wave.
  ledger.tickets[0].status = 'running';
  await writeLedger(root, ledger);
  await orchestratorManifestGate(root, manifest, env);
});

for (const [name, mutate, reason] of [
  ['changed prompt', job => { job.prompt += '\nextra instruction'; }, 'at prompt'],
  ['extra key', job => { job.extra = true; }, 'at extra'],
  ['changed setup argv', job => { job.setup[0] = ['npm', 'run', 'evil']; }, 'at setup.0'],
  ['changed shell flag', job => { job.shell = false; }, 'at shell'],
]) {
  test(`refuses ${name}`, async t => {
    const { root, manifest } = await fixture(t);
    mutate(manifest.jobs[0]);
    await refused(root, manifest, reason);
  });
}

for (const status of ['done', 'cancelled', 'proposed', 'review']) {
  test(`refuses ticket status ${status}`, async t => {
    const { root, ledger, manifest } = await fixture(t);
    ledger.tickets[0].status = status;
    await writeLedger(root, approveLedger(ledger));
    await refused(root, manifest, `ticket status ${status} is not deliverable`);
  });
}

test('refuses duplicate ids before checking provenance, including a non-shell duplicate', async t => {
  const { root, manifest } = await fixture(t);
  manifest.jobs.push({ id: 'T-0001', prompt: 'other job' });
  await refused(root, manifest, 'duplicate job id');
});

test('refuses tickets edited after approval', async t => {
  const { root, ledger, manifest } = await fixture(t);
  ledger.tickets[0].title = 'Edited after approval';
  await writeLedger(root, ledger);
  await refused(root, manifest, 'ticket ledger is not approved');
});

test('refuses hand-written shell job with no ticket id', async t => {
  const { root } = await fixture(t);
  await assert.rejects(orchestratorManifestGate(root, { jobs: [{ id: 'handmade', shell: true }] }, env),
    { code: 'orchestrator-manifest-unvetted', message: 'job handmade: job id is not a ticket in the ledger' });
});

test('missing and unreadable ledgers are normal refusals', async t => {
  const { root, manifest } = await fixture(t, { ledger: false });
  await refused(root, manifest, 'ticket ledger is missing');
  await fs.writeFile(path.join(root, '.swarm', 'project', 'tickets.json'), '{bad JSON');
  await refused(root, manifest, 'ticket ledger could not be read');
});

test('refuses changed approved snapshot', async t => {
  const { root, manifest } = await fixture(t);
  await fs.writeFile(path.join(root, '.swarm', 'project', 'scope.snapshot.md'), 'changed');
  await refused(root, manifest, 'approved scope snapshot does not match the ledger');
});

test('non-shell manifests retain argv vetting and outside-Claude behavior', async t => {
  const { root } = await fixture(t);
  const manifest = { jobs: [{ id: 'plain', prompt: 'work' }], checks: [{ argv: ['node', '--test'] }] };
  await orchestratorManifestGate(root, manifest, env);
  manifest.checks[0].argv = ['npm', 'run', 'evil'];
  await assert.rejects(orchestratorManifestGate(root, manifest, env), { code: 'orchestrator-manifest-unvetted' });
  await orchestratorManifestGate(root, { jobs: [{ shell: true }] }, {});
});

test('proven shell jobs still require vetted manifest commands', async t => {
  const { root, manifest } = await fixture(t);
  manifest.preChecks = [['npm', 'run', 'evil']];
  await assert.rejects(orchestratorManifestGate(root, manifest, env),
    error => error.code === 'orchestrator-manifest-unvetted' && error.message.includes('preChecks'));
});

test('sync hook defers ticket shell jobs while retaining argv vetting', async t => {
  const { root, manifest } = await fixture(t);
  const file = path.join(root, 'wave.json');
  await fs.writeFile(file, JSON.stringify(manifest));
  assert.equal(omRunManifestVetted(root, 'wave.json').ok, true);
  manifest.jobs[0].setup = [['npm', 'run', 'evil']];
  await fs.writeFile(file, JSON.stringify(manifest));
  assert.match(omRunManifestVetted(root, 'wave.json').reason, /setup.*not a vetted command/);
});

test('sync hook still refuses shell jobs without a ledger', async t => {
  const { root, manifest } = await fixture(t, { ledger: false });
  await fs.writeFile(path.join(root, 'wave.json'), JSON.stringify(manifest));
  assert.deepEqual(omRunManifestVetted(root, 'wave.json'), { ok: false, reason: 'job T-0001 has shell: true' });
});
