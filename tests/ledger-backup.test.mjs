import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import * as lb from '../tools/ledger-backup.mjs';
import { runSafetyCommand } from '../tools/safety-commands.mjs';
import { writeLedger, createLedger } from '../tools/tickets.mjs';

async function tmpRoot() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'lb-test-'));
}

async function put(root, rel, text) {
  const p = path.join(root, ...rel.split('/'));
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, text);
}

function minimalLedger(tickets = []) {
  return createLedger({
    scope: { name: 't', version: 1, hash: 'h', stages: [] },
    tickets,
  });
}

test('snapshot on change and dedupe on identical content', async () => {
  const root = await tmpRoot();
  const home = await tmpRoot();
  const ledger = minimalLedger([{ id: 'T-0001', title: 'a', type: 'docs', scopeRefs: ['R-001'], size: 'S', risk: 'low', status: 'todo', stage: 's1' }]);
  await writeLedger(root, ledger);
  process.env.PROJECT_SWARM_HOME = home;
  process.env.PROJECT_SWARM_NO_LEDGER_BACKUP = '1';
  await put(root, '.swarm/project/tickets.json', JSON.stringify(ledger, null, 2) + '\n');
  delete process.env.PROJECT_SWARM_NO_LEDGER_BACKUP;

  let i = 0;
  const now = () => Date.UTC(2025, 0, 1, 0, 0, i++);
  const a = await lb.backupLedger(root, { reason: 't', home, now });
  assert.equal(a.ok, true);
  assert.equal(a.skipped, false);
  const b = await lb.backupLedger(root, { reason: 't2', home, now });
  assert.equal(b.ok, true);
  assert.equal(b.skipped, true);
  const list = await lb.listLedgerBackups(root, { home });
  assert.equal(list.length, 1);
  delete process.env.PROJECT_SWARM_HOME;
});

test('retention keeps 50 change snapshots and daily copy', async () => {
  const root = await tmpRoot();
  const home = await tmpRoot();
  const key = await lb.ledgerBackupKey(root);
  const keyDir = path.join(lb.ledgerBackupsRoot(home), key);
  for (let n = 0; n < 52; n++) {
    const ledger = minimalLedger([{ id: 'T-0001', title: `v${n}`, type: 'docs', scopeRefs: ['R-001'], size: 'S', risk: 'low', status: 'todo', stage: 's1' }]);
    await put(root, '.swarm/project/tickets.json', JSON.stringify(ledger, null, 2) + '\n');
    const day = Math.floor(n / 2);
    const now = () => Date.UTC(2025, 0, 1 + day, 0, 0, n % 24);
    await lb.backupLedger(root, { reason: 'r', home, now });
  }
  const ids = (await fs.readdir(keyDir)).filter((n) => n !== 'daily');
  assert.equal(ids.length, 50);
  const daily = await fs.readdir(path.join(keyDir, 'daily'));
  assert.ok(daily.length >= 1);
  const oldDay = '2024-09-01';
  await fs.mkdir(path.join(keyDir, 'daily', oldDay), { recursive: true });
  await put(path.join(keyDir, 'daily', oldDay), 'meta.json', '{}');
  const ledgerEnd = minimalLedger([{ id: 'T-0001', title: 'prune-trigger', type: 'docs', scopeRefs: ['R-001'], size: 'S', risk: 'low', status: 'todo', stage: 's1' }]);
  await put(root, '.swarm/project/tickets.json', JSON.stringify(ledgerEnd, null, 2) + '\n');
  await lb.backupLedger(root, {
    reason: 'prune-daily',
    home,
    now: () => Date.UTC(2025, 5, 1),
  });
  assert.equal(await fs.stat(path.join(keyDir, 'daily', oldDay)).then(() => true, () => false), false);
});

test('never copies secrets or security-key files', async () => {
  const root = await tmpRoot();
  const home = await tmpRoot();
  const ledger = minimalLedger();
  await put(root, '.swarm/project/tickets.json', JSON.stringify(ledger, null, 2) + '\n');
  await put(root, '.swarm/project/scope-snapshot.md', '# scope');
  await put(root, '.swarm/project/security-key.json', '{"k":1}');
  await put(root, '.swarm/project/.env.local', 'X=1');
  const r = await lb.backupLedger(root, { reason: 't', home, now: () => Date.UTC(2025, 0, 2) });
  assert.equal(r.ok, true);
  const snapDir = path.join(lb.ledgerBackupsRoot(home), r.key, r.id);
  const names = await fs.readdir(snapDir);
  assert.ok(names.includes('tickets.json'));
  assert.ok(names.includes('scope-snapshot.md'));
  assert.equal(names.includes('security-key.json'), false);
  assert.equal(names.includes('.env.local'), false);
});

test('restore round trip via runSafetyCommand with hash check', async () => {
  const root = await tmpRoot();
  const home = await tmpRoot();
  process.env.PROJECT_SWARM_HOME = home;
  const ledger = minimalLedger([{ id: 'T-0001', title: 'restore-me', type: 'docs', scopeRefs: ['R-001'], size: 'S', risk: 'low', status: 'todo', stage: 's1' }]);
  await put(root, '.swarm/project/tickets.json', JSON.stringify(ledger, null, 2) + '\n');
  const made = await lb.backupLedger(root, { reason: 't', home, now: () => Date.UTC(2025, 0, 3) });
  const ledger2 = minimalLedger([{ id: 'T-0001', title: 'other', type: 'docs', scopeRefs: ['R-001'], size: 'S', risk: 'low', status: 'todo', stage: 's1' }]);
  await put(root, '.swarm/project/tickets.json', JSON.stringify(ledger2, null, 2) + '\n');
  const plan = await runSafetyCommand(root, 'backup', ['ledger', 'restore', made.id, '--from', made.key]);
  assert.equal(plan.exitCode, 0);
  assert.match(plan.stdout, /plan:/);
  const res = await runSafetyCommand(root, 'backup', ['ledger', 'restore', made.id, '--from', made.key, '--yes']);
  assert.equal(res.exitCode, 0);
  assert.match(res.stdout, /verify: 1\/1/);
  const raw = await fs.readFile(path.join(root, '.swarm/project/tickets.json'), 'utf8');
  assert.match(raw, /restore-me/);
  delete process.env.PROJECT_SWARM_HOME;
});

test('restore refuses without --yes', async () => {
  const root = await tmpRoot();
  const home = await tmpRoot();
  process.env.PROJECT_SWARM_HOME = home;
  const ledger = minimalLedger();
  await put(root, '.swarm/project/tickets.json', JSON.stringify(ledger, null, 2) + '\n');
  const made = await lb.backupLedger(root, { reason: 't', home, now: () => Date.UTC(2025, 0, 4) });
  const res = await runSafetyCommand(root, 'backup', ['ledger', 'restore', made.id, '--from', made.key]);
  assert.equal(res.exitCode, 0);
  assert.match(res.stdout, /plan:/);
  delete process.env.PROJECT_SWARM_HOME;
});

test('list --all after source root is deleted', async () => {
  const root = await tmpRoot();
  const home = await tmpRoot();
  const ledger = minimalLedger();
  await put(root, '.swarm/project/tickets.json', JSON.stringify(ledger, null, 2) + '\n');
  const made = await lb.backupLedger(root, { reason: 't', home, now: () => Date.UTC(2025, 0, 5) });
  const realRoot = await fs.realpath(root);
  await fs.rm(root, { recursive: true, force: true });
  const other = await tmpRoot();
  const list = await lb.listLedgerBackups(other, { home, all: true });
  const row = list.find((r) => r.key === made.key);
  assert.ok(row);
  assert.equal(row.root, realRoot);
});

test('writeLedger hook is best effort when home is unwritable', async () => {
  const root = await tmpRoot();
  const home = path.join(root, 'not-a-dir');
  await fs.writeFile(home, 'x');
  process.env.PROJECT_SWARM_HOME = home;
  process.env.PROJECT_SWARM_NO_LEDGER_BACKUP = '';
  const ledger = minimalLedger();
  await writeLedger(root, ledger);
  const raw = await fs.readFile(path.join(root, '.swarm/project/tickets.json'), 'utf8');
  assert.ok(raw.includes('"version"'));
  delete process.env.PROJECT_SWARM_HOME;
});
