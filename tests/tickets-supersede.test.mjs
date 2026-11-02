import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runScopeCommand, supersedeOwnerRefusal, setSupersedeOwnerCheck } from '../tools/scope-commands.mjs';
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
  approveLedger,
  applySupersedeStale,
  transition,
  STATUSES,
  renderBuildPlan,
  ticketSetHash,
  isApproved,
  readTicketLog,
  lastTouchForTickets,
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
  setSupersedeOwnerCheck(() => null);
  try {
    return await runScopeCommand(root, 'tickets', ['supersede', ...args]);
  } finally {
    setSupersedeOwnerCheck();
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

test('supersedeOwnerRefusal checks every agent marker first, even with SWARM_OWNER=1', () => {
  for (const marker of ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'SWARM_WORKER', 'SWARM_JOB_ID', 'SWARM_RUN_ID']) {
    for (const value of ['1', '']) {
      let inspected = false;
      assert.match(supersedeOwnerRefusal({
        env: { [marker]: value, SWARM_OWNER: '1' }, isTTY: true,
        processInfo: () => { inspected = true; return { ppid: 1, comm: 'bash' }; },
      }), ownerGateMsg, marker);
      assert.equal(inspected, false, 'markers must be checked before ancestry');
    }
  }
});

test('supersedeOwnerRefusal rejects agent ancestry despite a TTY or SWARM_OWNER=1', () => {
  for (const command of ['claude', 'codex', 'cursor-agent', 'opencode', 'chatgpt', '/opt/bin/CoDeX']) {
    assert.match(supersedeOwnerRefusal({
      env: { SWARM_OWNER: '1' }, isTTY: true, ancestry: ['bash', command],
    }), ownerGateMsg, command);
  }
});

test('supersedeOwnerRefusal allows clean ancestry only with a TTY', () => {
  assert.equal(supersedeOwnerRefusal({ env: {}, isTTY: true, ancestry: ['node', '/bin/bash'] }), null);
  assert.match(supersedeOwnerRefusal({ env: { SWARM_OWNER: '1' }, isTTY: false, ancestry: ['bash'] }), ownerGateMsg);
});

test('supersedeOwnerRefusal requires both stdin and stdout TTY by default', () => {
  const stdinTTY = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
  const stdoutTTY = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
  try {
    for (const [input, output] of [[false, true], [true, false], [false, false], [true, true]]) {
      Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: input });
      Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: output });
      const result = supersedeOwnerRefusal({ env: {}, ancestry: ['bash'] });
      if (input && output) assert.equal(result, null);
      else assert.match(result, ownerGateMsg);
    }
  } finally {
    if (stdinTTY) Object.defineProperty(process.stdin, 'isTTY', stdinTTY);
    else delete process.stdin.isTTY;
    if (stdoutTTY) Object.defineProperty(process.stdout, 'isTTY', stdoutTTY);
    else delete process.stdout.isTTY;
  }
});

test('supersedeOwnerRefusal walks parents from this process and stops at pid 1', () => {
  const visited = [];
  const parents = new Map([
    [process.pid, { ppid: 900002, comm: '/usr/bin/node' }],
    [900002, { ppid: 900003, comm: '/bin/bash' }],
    [900003, { ppid: 1, comm: '/opt/bin/Codex' }],
  ]);
  const processInfo = pid => {
    visited.push(pid);
    assert.ok(parents.has(pid), `unexpected pid ${pid}`);
    return parents.get(pid);
  };
  assert.match(supersedeOwnerRefusal({ env: {}, isTTY: true, processInfo }), ownerGateMsg);
  assert.deepEqual(visited, [process.pid, 900002, 900003]);
  visited.length = 0;
  parents.set(900003, { ppid: 1, comm: '/bin/zsh' });
  assert.equal(supersedeOwnerRefusal({ env: {}, isTTY: true, processInfo }), null);
  assert.deepEqual(visited, [process.pid, 900002, 900003]);
});

test('supersedeOwnerRefusal bounds inspection and refuses incomplete ancestry', () => {
  let calls = 0;
  assert.match(supersedeOwnerRefusal({
    env: {}, isTTY: true,
    processInfo: pid => { calls += 1; return { ppid: pid + 1, comm: 'bash' }; },
  }), ownerGateMsg);
  assert.equal(calls, 32);
  assert.match(supersedeOwnerRefusal({
    env: {}, isTTY: true, processInfo: () => { throw new Error('ps unavailable'); },
  }), ownerGateMsg);
});

test('agent session refuses bulk supersede with SWARM_OWNER=1; test hook allows and resets', async () => {
  const root = await projectWithLedger([ticket('T-0001', 'todo')], { createdAt: '2020-01-01T00:00:00.000Z' });
  const before = await fs.readFile(ledgerPath(root), 'utf8');
  const prevCode = process.env.CLAUDECODE;
  const prevOwner = process.env.SWARM_OWNER;
  process.env.CLAUDECODE = '1';
  process.env.SWARM_OWNER = '1';
  try {
    const denied = await runScopeCommand(root, 'tickets', ['supersede', '--before', '2025-01-01']);
    assert.equal(denied.exitCode, 1);
    assert.match(denied.stdout, ownerGateMsg);
    assert.equal(await fs.readFile(ledgerPath(root), 'utf8'), before);
    const allowed = await runSupersede(root, ['--before', '2025-01-01', '--yes']);
    assert.equal(allowed.exitCode, 0, allowed.stdout);
    assert.equal((await readLedger(root)).tickets[0].status, 'superseded');
    assert.match((await runScopeCommand(root, 'tickets', ['supersede', '--before', '2025-01-01'])).stdout, ownerGateMsg);
  } finally {
    setSupersedeOwnerCheck();
    if (prevCode === undefined) delete process.env.CLAUDECODE;
    else process.env.CLAUDECODE = prevCode;
    if (prevOwner === undefined) delete process.env.SWARM_OWNER;
    else process.env.SWARM_OWNER = prevOwner;
  }
});

test('--set superseded uses the same real owner gate and resettable test hook as bulk supersede', async () => {
  const root = await projectWithLedger([ticket('T-0001', 'todo')], { createdAt: '2020-01-01T00:00:00.000Z' });
  const before = await fs.readFile(ledgerPath(root), 'utf8');
  const prev = { SWARM_WORKER: process.env.SWARM_WORKER, SWARM_OWNER: process.env.SWARM_OWNER };
  process.env.SWARM_WORKER = '1';
  process.env.SWARM_OWNER = '1';
  try {
    for (const flags of [['--yes'], ['--force'], ['--dry-run']]) {
      const denied = await runScopeCommand(root, 'tickets', ['T-0001', '--set', 'superseded', ...flags]);
      assert.equal(denied.exitCode, 1);
      assert.match(denied.stdout, ownerGateMsg);
    }
    assert.equal(await fs.readFile(ledgerPath(root), 'utf8'), before);
    setSupersedeOwnerCheck(() => null);
    const allowed = await runScopeCommand(root, 'tickets', ['T-0001', '--set', 'superseded', '--yes']);
    assert.equal(allowed.exitCode, 0);
    assert.equal((await readLedger(root)).tickets[0].status, 'superseded');
    setSupersedeOwnerCheck();
    const other = await projectWithLedger([ticket('T-0001', 'todo')]);
    assert.match((await runScopeCommand(other, 'tickets', ['T-0001', '--set', 'superseded', '--yes'])).stdout, ownerGateMsg);
  } finally {
    setSupersedeOwnerCheck();
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
  await runSupersede(root, ['--before', '2025-01-01', '--yes']);
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
      ['--import', './tests/_isolate-config.mjs', '-e', `import { runScopeCommand, setSupersedeOwnerCheck } from './tools/scope-commands.mjs'; let r; setSupersedeOwnerCheck(() => null); try { r = await runScopeCommand(process.argv[1], 'tickets', process.argv.slice(2)); } finally { setSupersedeOwnerCheck(); } process.stdout.write(r.stdout ?? ''); process.exitCode = r.exitCode ?? 0;`, root, ...args],
      { cwd: repoRoot, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] },
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

test('renderBuildPlan live count and requirement refs match ledgerStats (excludes proposed and superseded)', () => {
  const planScope = {
    name: 'Demo',
    version: 1,
    stages: [{ id: 'S1', title: 'Core' }],
    requirements: [{ id: 'R-001', text: 'A thing' }],
  };
  const ledger = createLedger({
    scope,
    tickets: [
      ticket('T-0001', 'done'),
      ticket('T-0002', 'superseded'),
      ticket('T-0003', 'proposed', { origin: 'comment' }),
      ticket('T-0004', 'todo'),
    ],
  });
  ledger.requirements = [{ id: 'R-001', text: 'A thing' }];
  const stats = ledgerStats(ledger);
  const md = renderBuildPlan(ledger, planScope);
  const liveCount = 2;
  assert.equal(stats.percentDone, 50);
  assert.match(md, new RegExp(`Progress: ${stats.percentDone}% done of ${liveCount} live tickets`));
  const reqLines = md.split('\n').filter(l => l.startsWith('| R-001 |'));
  assert.equal(reqLines.length, 1);
  assert.match(reqLines[0], /\| R-001 \| A thing \| T-0001, T-0004 \| partial \|/);
  assert.doesNotMatch(reqLines[0], /T-0002/);
  assert.match(md, /\| T-0002 \| .* \| superseded \|/);
});

test('superseding a proposed ticket does not lapse approval or change ticketsHash', () => {
  const proposed = ticket('T-0001', 'proposed', { origin: 'comment' });
  const todo = ticket('T-0002', 'todo');
  const ledger = createLedger({ scope, tickets: [proposed, todo] });
  const approved = approveLedger(ledger, { by: 'owner', now: 0 });
  const hashBefore = approved.approved.ticketsHash;
  assert.equal(isApproved(approved), true);
  assert.equal(ticketSetHash(approved.tickets), hashBefore);
  const superseded = {
    ...approved,
    tickets: approved.tickets.map(t => (t.id === 'T-0001' ? { ...t, status: 'superseded' } : t)),
  };
  assert.equal(ticketSetHash(superseded.tickets), hashBefore);
  assert.equal(isApproved(superseded), true);
});

test('readTicketLog skips a corrupt line and lastTouchForTickets still uses valid events', async () => {
  const root = await projectWithLedger([ticket('T-0001', 'todo')], { createdAt: '2020-01-01T00:00:00.000Z' });
  const corrupt = '{not json}\n';
  const valid1 = JSON.stringify({ at: '2021-01-01T00:00:00.000Z', event: 'transition', id: 'T-0001', from: 'proposed', to: 'todo' });
  const valid2 = JSON.stringify({ at: '2024-01-01T00:00:00.000Z', event: 'owner-note', id: 'T-0001' });
  await fs.writeFile(logPath(root), valid1 + '\n' + corrupt + valid2 + '\n', 'utf8');
  const events = await readTicketLog(root);
  assert.equal(events.length, 2);
  const ledger = await readLedger(root);
  const touch = lastTouchForTickets(ledger, events);
  assert.equal(touch(ledger.tickets[0]).at, '2024-01-01T00:00:00.000Z');
  assert.equal(touch(ledger.tickets[0]).basis, 'log');
});

test('lastTouchForTickets reads ticket, ids, and tickets log shapes', () => {
  const ledger = createLedger({
    scope,
    tickets: [ticket('T-0001', 'todo'), ticket('T-0002', 'todo'), ticket('T-0003', 'todo')],
    now: Date.parse('2020-01-01T00:00:00.000Z'),
  });
  ledger.createdAt = '2020-01-01T00:00:00.000Z';
  const logEvents = [
    { at: '2022-01-01T00:00:00.000Z', event: 'x', ticket: 'T-0001' },
    { at: '2023-01-01T00:00:00.000Z', event: 'y', ids: ['T-0002'] },
    { at: '2024-01-01T00:00:00.000Z', event: 'prune-deps', tickets: ['T-0003'] },
    { at: '2025-01-01T00:00:00.000Z', event: 'bad', ids: 'T-0002' },
  ];
  const touch = lastTouchForTickets(ledger, logEvents);
  assert.equal(touch(ledger.tickets.find(t => t.id === 'T-0001')).at, '2022-01-01T00:00:00.000Z');
  assert.equal(touch(ledger.tickets.find(t => t.id === 'T-0002')).at, '2023-01-01T00:00:00.000Z');
  assert.equal(touch(ledger.tickets.find(t => t.id === 'T-0003')).at, '2024-01-01T00:00:00.000Z');
});

test('lastTouchForTickets falls back to ledger createdAt when a ticket has no log event', () => {
  const ledger = createLedger({
    scope,
    tickets: [ticket('T-0001', 'todo')],
    now: Date.parse('2019-06-01T00:00:00.000Z'),
  });
  ledger.createdAt = '2019-06-01T00:00:00.000Z';
  const touch = lastTouchForTickets(ledger, []);
  const lt = touch(ledger.tickets[0]);
  assert.equal(lt.at, '2019-06-01T00:00:00.000Z');
  assert.equal(lt.basis, 'ledger-created');
});
