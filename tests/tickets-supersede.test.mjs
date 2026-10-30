import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runScopeCommand, supersedeOwnerRefusal } from '../tools/scope-commands.mjs';
import {
  createLedger,
  writeLedger,
  readLedger,
  ledgerPath,
  logPath,
  ledgerStats,
  validateSetTransition,
  readyTickets,
  pruneCancelledDeps,
  applySupersedeStale,
  transition,
  STATUSES,
} from '../tools/tickets.mjs';

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const scope = {
  name: 'Demo',
  version: 1,
  hash: 'deadbeef',
  stages: [{ id: 'S1', title: 'Core' }, { id: 'S2', title: 'Other' }],
  requirements: [{ id: 'R-001', text: 'A thing' }],
};

function ticket(id, status, overrides = {}) {
  return {
    id,
    title: `Title ${id}`,
    type: 'build',
    stage: 'S1',
    scopeRefs: ['R-001'],
    acceptance: ['ok'],
    files: ['src/a.mjs'],
    size: 'S',
    risk: 'low',
    status,
    ...overrides,
  };
}

async function projectWithLedger(tickets, { createdAt = '2020-06-01T00:00:00.000Z', logLines = [] } = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'tickets-supersede-')));
  await fs.mkdir(path.join(root, '.swarm', 'project'), { recursive: true });
  const ledger = createLedger({ scope, tickets, now: Date.parse(createdAt) });
  ledger.createdAt = createdAt;
  await writeLedger(root, ledger);
  if (logLines.length) {
    await fs.writeFile(
      logPath(root),
      logLines.map(line => JSON.stringify(line)).join('\n') + '\n',
      'utf8',
    );
  }
  return root;
}

async function readLog(root) {
  try {
    const text = await fs.readFile(logPath(root), 'utf8');
    return text.split('\n').filter(Boolean).map(line => JSON.parse(line));
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

async function runSupersede(root, args) {
  const prevOwner = process.env.SWARM_OWNER;
  process.env.SWARM_OWNER = '1';
  try {
    return await runScopeCommand(root, 'tickets', ['supersede', ...args]);
  } finally {
    if (prevOwner === undefined) delete process.env.SWARM_OWNER;
    else process.env.SWARM_OWNER = prevOwner;
  }
}

test('supersede dry-run lists candidates and writes nothing', async () => {
  const root = await projectWithLedger(
    [
      ticket('T-0001', 'todo'),
      ticket('T-0002', 'running'),
    ],
    {
      createdAt: '2020-01-01T00:00:00.000Z',
      logLines: [{ at: '2020-02-01T00:00:00.000Z', event: 'transition', id: 'T-0001', from: 'proposed', to: 'todo' }],
    },
  );
  const ledgerBefore = await fs.readFile(ledgerPath(root), 'utf8');
  const result = await runSupersede(root, ['--before', '2021-01-01', '--dry-run']);
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /T-0001/);
  assert.match(result.stdout, /log/);
  assert.match(result.stdout, /1 stale ticket/);
  assert.doesNotMatch(result.stdout, /T-0002/);
  assert.equal(await fs.readFile(ledgerPath(root), 'utf8'), ledgerBefore);
  assert.deepEqual(await readLog(root), [{ at: '2020-02-01T00:00:00.000Z', event: 'transition', id: 'T-0001', from: 'proposed', to: 'todo' }]);
});

test('supersede --yes only changes stale active tickets', async () => {
  const root = await projectWithLedger(
    [
      ticket('T-0001', 'todo'),
      ticket('T-0002', 'ready'),
      ticket('T-0003', 'blocked'),
      ticket('T-0004', 'proposed'),
      ticket('T-0005', 'running'),
      ticket('T-0006', 'review'),
      ticket('T-0007', 'done'),
      ticket('T-0008', 'cancelled'),
    ],
    { createdAt: '2019-01-01T00:00:00.000Z' },
  );
  const result = await runSupersede(root, ['--before', '2025-01-01', '--yes']);
  assert.equal(result.exitCode, 0, result.stdout);
  assert.match(result.stdout, /4 stale ticket/);
  const ledger = await readLedger(root);
  assert.equal(ledger.tickets.find(t => t.id === 'T-0001').status, 'superseded');
  assert.equal(ledger.tickets.find(t => t.id === 'T-0002').status, 'superseded');
  assert.equal(ledger.tickets.find(t => t.id === 'T-0003').status, 'superseded');
  assert.equal(ledger.tickets.find(t => t.id === 'T-0004').status, 'superseded');
  assert.equal(ledger.tickets.find(t => t.id === 'T-0005').status, 'running');
  assert.equal(ledger.tickets.find(t => t.id === 'T-0006').status, 'review');
  assert.equal(ledger.tickets.find(t => t.id === 'T-0007').status, 'done');
  assert.equal(ledger.tickets.find(t => t.id === 'T-0008').status, 'cancelled');
});

test('last touch from log vs ledger-created fallback', async () => {
  const root = await projectWithLedger(
    [
      ticket('T-0001', 'todo'),
      ticket('T-0002', 'todo'),
      ticket('T-0003', 'todo'),
    ],
    {
      createdAt: '2020-01-01T00:00:00.000Z',
      logLines: [
        { at: '2024-06-01T00:00:00.000Z', event: 'owner-note', id: 'T-0001' },
        { at: '2019-05-01T00:00:00.000Z', event: 'transition', id: 'T-0002', from: 'proposed', to: 'todo' },
      ],
    },
  );
  const dry = await runSupersede(root, ['--before', '2021-01-01', '--json']);
  assert.equal(dry.exitCode, 0);
  const listed = JSON.parse(dry.stdout);
  assert.deepEqual(listed.map(r => r.id).sort(), ['T-0002', 'T-0003']);
  assert.equal(listed.find(r => r.id === 'T-0002').basis, 'log');
  assert.equal(listed.find(r => r.id === 'T-0003').basis, 'ledger-created');
  assert.doesNotMatch(dry.stdout, /T-0001/);
});

const ownerGateMsg = /owner-only.*agent or worker session/i;

test('supersedeOwnerRefusal blocks agent env, missing TTY, and allows owner override', () => {
  assert.match(supersedeOwnerRefusal({ env: { CLAUDECODE: '1' }, isTTY: true }), ownerGateMsg);
  assert.match(supersedeOwnerRefusal({ env: { SWARM_WORKER: '1' }, isTTY: true }), ownerGateMsg);
  assert.match(supersedeOwnerRefusal({ env: { SWARM_JOB_ID: 'j1' }, isTTY: true }), ownerGateMsg);
  assert.match(supersedeOwnerRefusal({ env: {}, isTTY: false }), ownerGateMsg);
  assert.equal(supersedeOwnerRefusal({ env: { CLAUDECODE: '1', SWARM_OWNER: '1' }, isTTY: false }), null);
  assert.equal(supersedeOwnerRefusal({ env: {}, isTTY: true }), null);
});

test('agent session refused unless SWARM_OWNER=1', async () => {
  const root = await projectWithLedger([ticket('T-0001', 'todo')], { createdAt: '2020-01-01T00:00:00.000Z' });
  const prevCode = process.env.CLAUDECODE;
  const prevOwner = process.env.SWARM_OWNER;
  process.env.CLAUDECODE = '1';
  delete process.env.SWARM_OWNER;
  try {
    const denied = await runScopeCommand(root, 'tickets', ['supersede', '--before', '2025-01-01']);
    assert.equal(denied.exitCode, 1);
    assert.match(denied.stdout, ownerGateMsg);
    process.env.SWARM_OWNER = '1';
    const allowed = await runScopeCommand(root, 'tickets', ['supersede', '--before', '2025-01-01', '--dry-run']);
    assert.equal(allowed.exitCode, 0);
  } finally {
    if (prevCode === undefined) delete process.env.CLAUDECODE;
    else process.env.CLAUDECODE = prevCode;
    if (prevOwner === undefined) delete process.env.SWARM_OWNER;
    else process.env.SWARM_OWNER = prevOwner;
  }
});

test('--set superseded uses the same owner gate as bulk supersede', async () => {
  const root = await projectWithLedger([ticket('T-0001', 'todo')], { createdAt: '2020-01-01T00:00:00.000Z' });
  const prev = { SWARM_WORKER: process.env.SWARM_WORKER, SWARM_OWNER: process.env.SWARM_OWNER };
  process.env.SWARM_WORKER = '1';
  delete process.env.SWARM_OWNER;
  try {
    const denied = await runScopeCommand(root, 'tickets', ['T-0001', '--set', 'superseded', '--yes']);
    assert.equal(denied.exitCode, 1);
    assert.match(denied.stdout, ownerGateMsg);
    process.env.SWARM_OWNER = '1';
    const allowed = await runScopeCommand(root, 'tickets', ['T-0001', '--set', 'superseded', '--yes']);
    assert.equal(allowed.exitCode, 0);
    assert.equal((await readLedger(root)).tickets[0].status, 'superseded');
  } finally {
    if (prev.SWARM_WORKER === undefined) delete process.env.SWARM_WORKER;
    else process.env.SWARM_WORKER = prev.SWARM_WORKER;
    if (prev.SWARM_OWNER === undefined) delete process.env.SWARM_OWNER;
    else process.env.SWARM_OWNER = prev.SWARM_OWNER;
  }
});

test('missing or invalid --before is refused', async () => {
  const root = await projectWithLedger([ticket('T-0001', 'todo')]);
  assert.equal((await runScopeCommand(root, 'tickets', ['supersede'])).exitCode, 1);
  const bad = await runScopeCommand(root, 'tickets', ['supersede', '--before', 'not-a-date']);
  assert.equal(bad.exitCode, 1);
  assert.match(bad.stdout, /unparseable|before/i);
});

test('superseded is terminal and counted in ledgerStats', async () => {
  assert.ok(STATUSES.includes('superseded'));
  const root = await projectWithLedger([ticket('T-0001', 'todo'), ticket('T-0002', 'running')], { createdAt: '2020-01-01T00:00:00.000Z' });
  await runSupersede(root, ['--before', '2025-01-01', '--yes']);
  const ledger = await readLedger(root);
  const stats = ledgerStats(ledger);
  assert.equal(stats.byStatus.superseded, 1);
  assert.equal(validateSetTransition(ledger, 'T-0001', 'todo').ok, false);
  assert.equal(validateSetTransition(ledger, 'T-0002', 'superseded').ok, false);
});

test('apply appends one supersede-stale log event with count', async () => {
  const root = await projectWithLedger(
    [ticket('T-0001', 'todo'), ticket('T-0002', 'ready')],
    { createdAt: '2020-01-01T00:00:00.000Z' },
  );
  await runSupersede(root, ['--before', '2025-01-01', '--yes']);
  const events = await readLog(root);
  const bulk = events.filter(e => e.event === 'supersede-stale');
  assert.equal(bulk.length, 1);
  assert.equal(bulk[0].count, 2);
  assert.deepEqual(bulk[0].ids.sort(), ['T-0001', 'T-0002']);
  assert.equal(bulk[0].by, 'owner');
  assert.equal(bulk[0].source, 'tickets-supersede');
});

test('default listing prompts for --yes and leaves ledger unchanged', async () => {
  const root = await projectWithLedger([ticket('T-0001', 'todo')], { createdAt: '2020-01-01T00:00:00.000Z' });
  const before = await fs.readFile(ledgerPath(root), 'utf8');
  const result = await runSupersede(root, ['--before', '2025-01-01']);
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /Rerun with --yes to supersede/);
  assert.equal(await fs.readFile(ledgerPath(root), 'utf8'), before);
});

test('--stage narrows candidates', async () => {
  const root = await projectWithLedger(
    [ticket('T-0001', 'todo', { stage: 'S1' }), ticket('T-0002', 'todo', { stage: 'S2' })],
    { createdAt: '2020-01-01T00:00:00.000Z' },
  );
  const result = await runSupersede(root, ['--before', '2025-01-01', '--stage', 'S2', '--json']);
  const listed = JSON.parse(result.stdout);
  assert.deepEqual(listed.map(r => r.id), ['T-0002']);
});

test('bulk supersede prunes superseded dependencies and logs prune-deps', async () => {
  const root = await projectWithLedger(
    [
      ticket('T-0001', 'todo'),
      ticket('T-0002', 'todo', { dependsOn: ['T-0001'] }),
      ticket('T-0003', 'blocked', { dependsOn: ['T-0001'] }),
      ticket('T-0004', 'todo', { dependsOn: ['T-0005'] }),
      ticket('T-0005', 'cancelled'),
    ],
    {
      createdAt: '2020-01-01T00:00:00.000Z',
      logLines: [
        { at: '2026-01-01T00:00:00.000Z', event: 'transition', id: 'T-0002', from: 'proposed', to: 'todo' },
        { at: '2026-01-01T00:00:00.000Z', event: 'transition', id: 'T-0003', from: 'todo', to: 'blocked' },
        { at: '2026-01-01T00:00:00.000Z', event: 'transition', id: 'T-0004', from: 'proposed', to: 'todo' },
      ],
    },
  );
  const prevOwner = process.env.SWARM_OWNER;
  process.env.SWARM_OWNER = '1';
  try {
    await runSupersede(root, ['--before', '2025-01-01', '--yes']);
  } finally {
    if (prevOwner === undefined) delete process.env.SWARM_OWNER;
    else process.env.SWARM_OWNER = prevOwner;
  }
  const ledger = await readLedger(root);
  assert.equal(ledger.tickets.find(t => t.id === 'T-0001').status, 'superseded');
  assert.deepEqual(ledger.tickets.find(t => t.id === 'T-0002').dependsOn, []);
  assert.deepEqual(ledger.tickets.find(t => t.id === 'T-0003').dependsOn, []);
  assert.deepEqual(ledger.tickets.find(t => t.id === 'T-0004').dependsOn, []);
  assert.ok(validateSetTransition(ledger, 'T-0002', 'ready').ok);
  assert.deepEqual(readyTickets(ledger.tickets).map(t => t.id), ['T-0002', 'T-0004']);
  const prunes = (await readLog(root)).filter(e => e.event === 'prune-deps');
  assert.ok(prunes.some(e => e.tickets?.includes('T-0002') && e.tickets?.includes('T-0003')));
  assert.ok(prunes.some(e => e.tickets?.includes('T-0004')));
});

test('pruneCancelledDeps still prunes cancelled only for cancel transitions', () => {
  const ledger = createLedger({
    scope,
    tickets: [
      ticket('T-0001', 'cancelled'),
      ticket('T-0002', 'todo', { dependsOn: ['T-0001'] }),
      ticket('T-0003', 'superseded'),
      ticket('T-0004', 'todo', { dependsOn: ['T-0003'] }),
    ],
  });
  const { pruned } = pruneCancelledDeps(ledger);
  assert.deepEqual(pruned.map(p => p.id).sort(), ['T-0002', 'T-0004']);
  assert.deepEqual(ledger.tickets.find(t => t.id === 'T-0002').dependsOn, []);
  assert.deepEqual(ledger.tickets.find(t => t.id === 'T-0004').dependsOn, []);
});

function spawnScopeTickets(root, args, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ['--import', './tests/_isolate-config.mjs', '-e', `import { runScopeCommand } from './tools/scope-commands.mjs'; const r = await runScopeCommand(process.argv[1], 'tickets', process.argv.slice(2)); process.stdout.write(r.stdout ?? ''); process.exit(r.exitCode ?? 0);`, root, ...args],
      { cwd: repoRoot, env: { ...process.env, SWARM_OWNER: '1', ...env }, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let stdout = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.on('error', reject);
    child.on('close', code => resolve({ exitCode: code ?? 1, stdout }));
  });
}

test('concurrent supersede and transition both persist (no lost update)', async () => {
  const root = await projectWithLedger(
    [
      ticket('T-0001', 'todo'),
      ticket('T-0100', 'todo'),
    ],
    {
      createdAt: '2020-01-01T00:00:00.000Z',
      logLines: [{ at: '2026-01-01T00:00:00.000Z', event: 'transition', id: 'T-0100', from: 'proposed', to: 'todo' }],
    },
  );
  const [supersedeResult, transitionResult] = await Promise.all([
    spawnScopeTickets(root, ['supersede', '--before', '2025-01-01', '--yes']),
    spawnScopeTickets(root, ['T-0100', '--set', 'ready', '--yes']),
  ]);
  assert.equal(supersedeResult.exitCode, 0, supersedeResult.stdout);
  assert.equal(transitionResult.exitCode, 0, transitionResult.stdout);
  const ledger = await readLedger(root);
  assert.equal(ledger.tickets.find(t => t.id === 'T-0001').status, 'superseded');
  assert.equal(ledger.tickets.find(t => t.id === 'T-0100').status, 'ready');
});

test('applySupersedeStale on a fresh ledger object does not re-read and lose concurrent writes', async () => {
  const root = await projectWithLedger(
    [ticket('T-0001', 'todo'), ticket('T-0100', 'todo')],
    { createdAt: '2020-01-01T00:00:00.000Z' },
  );
  await transition(root, 'T-0100', 'ready', { by: 'owner' });
  const fresh = await readLedger(root);
  const result = await applySupersedeStale(root, { before: '2025-01-01', ledger: fresh });
  assert.equal(result.count, 1);
  const after = await readLedger(root);
  assert.equal(after.tickets.find(t => t.id === 'T-0001').status, 'superseded');
  assert.equal(after.tickets.find(t => t.id === 'T-0100').status, 'ready');
});
