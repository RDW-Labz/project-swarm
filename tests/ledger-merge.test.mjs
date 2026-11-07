// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { createLedger, writeLedger, readLedger, ledgerPath } from '../tools/tickets.mjs';
import { readReviewRecords, writeReviewRecords } from '../tools/security-review.mjs';
import { journalPath, readJournal } from '../tools/journal.mjs';
import { mergeTicketLedgers, ledgerMergeRenamesMarkerPath } from '../tools/ledger-merge.mjs';

const baseTicket = (id, status, extra = {}) => ({
  id,
  title: `ticket ${id}`,
  type: 'build',
  stage: 'S1',
  scopeRefs: ['R-001'],
  acceptance: ['it works'],
  files: [`src/${id}.mjs`],
  size: 'S',
  risk: 'low',
  status,
  ...extra,
});

async function writeJournalLines(root, lines) {
  const dir = path.join(root, '.swarm', 'project');
  await fs.mkdir(dir, { recursive: true });
  const body = lines.map(l => JSON.stringify(l)).join('\n') + (lines.length ? '\n' : '');
  await fs.writeFile(path.join(dir, 'journal.ndjson'), body);
}

async function setupRoot(tickets, { journal = [], records = { tickets: {} } } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ledger-merge-'));
  const ledger = createLedger({ scope: { name: 'test', version: 1, hash: 'h1' }, tickets });
  await fs.mkdir(path.join(root, '.swarm', 'project'), { recursive: true });
  await writeLedger(root, ledger);
  if (journal.length) await writeJournalLines(root, journal);
  await writeReviewRecords(root, records);
  return root;
}

test('two non-overlapping ledgers merge cleanly (dry run)', async () => {
  const mini = await setupRoot([baseTicket('T-0001', 'todo')]);
  const book = await setupRoot([baseTicket('T-0002', 'ready')]);
  const target = await fs.mkdtemp(path.join(os.tmpdir(), 'ledger-merge-out-'));

  const result = await mergeTicketLedgers({ mini, book, target });
  assert.equal(result.ok, true);
  assert.equal(result.report.dryRun, true);
  assert.deepEqual(result.collisions, []);
  assert.equal(result.ledger.tickets.length, 2);
  assert.equal(result.ledger.tickets[0].id, 'T-0001');
  assert.equal(result.ledger.tickets[1].id, 'T-0002');
  await assert.rejects(fs.access(ledgerPath(target)));
});

test('id present in both ledgers is a hard collision and nothing is written even with apply:true', async () => {
  const mini = await setupRoot([baseTicket('T-0099', 'todo')]);
  const book = await setupRoot([baseTicket('T-0099', 'done', { pr: 5 })]);
  const target = await fs.mkdtemp(path.join(os.tmpdir(), 'ledger-merge-out-'));
  await fs.mkdir(path.join(target, '.swarm', 'project'), { recursive: true });
  await fs.writeFile(path.join(target, '.swarm', 'project', 'marker.txt'), 'keep');

  const result = await mergeTicketLedgers({ mini, book, target, apply: true });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'ticket-id-collision');
  assert.deepEqual(result.collisions, ['T-0099']);
  await assert.rejects(fs.access(ledgerPath(target)));
  assert.equal(await fs.readFile(path.join(target, '.swarm', 'project', 'marker.txt'), 'utf8'), 'keep');
});

test('done-ticket PR, delivery note and security-review metadata survives the merge', async () => {
  const mini = await setupRoot(
    [baseTicket('T-0100', 'done', { pr: 42 })],
    {
      journal: [{ kind: 'note', ts: '2026-01-01T10:00:00.000Z', text: 'mini' }],
      records: {
        tickets: {
          'T-0102': { verdict: 'pass', findings: [], run: 'run-a', at: '2026-01-01T11:00:00.000Z', filesHash: 'abc' },
        },
      },
    },
  );
  const book = await setupRoot(
    [
      baseTicket('T-0101', 'done', { deliveryNote: 'delivered by PR #7 (sha7)' }),
      baseTicket('T-0102', 'done', {
        securityReview: { state: 'accepted-unreviewed', reason: 'owner accepted' },
      }),
    ],
    { journal: [{ kind: 'note', ts: '2026-01-02T10:00:00.000Z', text: 'book' }] },
  );
  const target = await fs.mkdtemp(path.join(os.tmpdir(), 'ledger-merge-out-'));

  const result = await mergeTicketLedgers({ mini, book, target, apply: true });
  assert.equal(result.ok, true);

  const ledger = await readLedger(target);
  const t100 = ledger.tickets.find(t => t.id === 'T-0100');
  const t101 = ledger.tickets.find(t => t.id === 'T-0101');
  const t102 = ledger.tickets.find(t => t.id === 'T-0102');
  assert.equal(t100.pr, 42);
  assert.equal(t101.deliveryNote, 'delivered by PR #7 (sha7)');
  assert.equal(t102.securityReview.state, 'accepted-unreviewed');

  const records = await readReviewRecords(target);
  assert.equal(records.tickets['T-0102'].verdict, 'pass');

  const journal = await readJournal(target, { limit: Infinity });
  assert.equal(journal.length, 2);
  assert.equal(journal[0].text, 'mini');
  assert.equal(journal[1].text, 'book');
});

test('journal entries from both sides are preserved and time-ordered', async () => {
  const mini = await setupRoot([], {
    journal: [
      { kind: 'note', ts: '2026-01-03T12:00:00.000Z', text: 'later-mini' },
      { kind: 'note', ts: '2026-01-01T08:00:00.000Z', text: 'early-mini' },
    ],
  });
  const book = await setupRoot([], {
    journal: [
      { kind: 'note', ts: '2026-01-02T09:00:00.000Z', text: 'mid-book' },
    ],
  });
  const target = await fs.mkdtemp(path.join(os.tmpdir(), 'ledger-merge-out-'));

  const result = await mergeTicketLedgers({ mini, book, target, apply: true });
  assert.equal(result.ok, true);
  const journal = await readJournal(target, { limit: Infinity });
  assert.deepEqual(journal.map(e => e.text), ['early-mini', 'mid-book', 'later-mini']);
});

test('apply:true does not inherit ambient SWARM_AUTOPILOT_PID for parent-lock allowance', async t => {
  const holder = spawn(process.execPath, ['-e', 'setInterval(()=>{}, 1<<30)'], { stdio: 'ignore' });
  await new Promise((resolve, reject) => {
    holder.once('spawn', resolve);
    holder.once('error', reject);
  });
  const prev = process.env.SWARM_AUTOPILOT_PID;
  process.env.SWARM_AUTOPILOT_PID = String(holder.pid);
  t.after(() => {
    if (prev === undefined) delete process.env.SWARM_AUTOPILOT_PID;
    else process.env.SWARM_AUTOPILOT_PID = prev;
  });
  try {
    const mini = await setupRoot([baseTicket('T-0211', 'todo')]);
    const book = await setupRoot([baseTicket('T-0212', 'todo')]);
    const target = await fs.mkdtemp(path.join(os.tmpdir(), 'ledger-merge-out-'));
    const projectDir = path.join(target, '.swarm', 'project');
    await fs.mkdir(projectDir, { recursive: true });
    await fs.writeFile(
      path.join(projectDir, 'autopilot.lock'),
      `${JSON.stringify({ pid: holder.pid, startedAt: new Date().toISOString() })}\n`,
    );
    await fs.writeFile(path.join(projectDir, 'marker.txt'), 'keep');

    const mergePid = 88_888;
    await assert.rejects(
      () => mergeTicketLedgers({
        mini,
        book,
        target,
        apply: true,
        lockOptions: {
          pid: mergePid,
          parentPid: holder.pid,
          isAlive: pid => pid === holder.pid,
        },
      }),
      err => err.code === 'autopilot-running',
    );
    assert.equal(await fs.readFile(path.join(projectDir, 'marker.txt'), 'utf8'), 'keep');
    await assert.rejects(fs.access(ledgerPath(target)));
  } finally {
    holder.kill('SIGTERM');
  }
});

test('apply:true refuses when target autopilot lock is held by a live process', async () => {
  const holder = spawn(process.execPath, ['-e', 'setInterval(()=>{}, 1<<30)'], { stdio: 'ignore' });
  await new Promise((resolve, reject) => {
    holder.once('spawn', resolve);
    holder.once('error', reject);
  });
  try {
    const mini = await setupRoot([baseTicket('T-0201', 'todo')]);
    const book = await setupRoot([baseTicket('T-0202', 'todo')]);
    const target = await fs.mkdtemp(path.join(os.tmpdir(), 'ledger-merge-out-'));
    const projectDir = path.join(target, '.swarm', 'project');
    await fs.mkdir(projectDir, { recursive: true });
    await fs.writeFile(
      path.join(projectDir, 'autopilot.lock'),
      `${JSON.stringify({ pid: holder.pid, startedAt: new Date().toISOString() })}\n`,
    );
    await fs.writeFile(path.join(projectDir, 'marker.txt'), 'keep');

    await assert.rejects(
      () => mergeTicketLedgers({ mini, book, target, apply: true }),
      err => err.code === 'autopilot-running',
    );
    assert.equal(await fs.readFile(path.join(projectDir, 'marker.txt'), 'utf8'), 'keep');
    await assert.rejects(fs.access(ledgerPath(target)));
  } finally {
    holder.kill('SIGTERM');
  }
});

test('apply abort mid-write leaves target ledger files unchanged', async () => {
  const mini = await setupRoot([baseTicket('T-0301', 'todo')]);
  const book = await setupRoot([baseTicket('T-0302', 'todo')]);
  const target = await setupRoot([baseTicket('T-0300', 'todo')], {
    journal: [{ kind: 'note', ts: '2026-01-01T00:00:00.000Z', text: 'original' }],
    records: { tickets: { 'T-0300': { verdict: 'pass', findings: [], run: 'r0', at: '2026-01-01T00:00:00.000Z' } } },
  });
  const ticketsBefore = await fs.readFile(ledgerPath(target), 'utf8');
  const recordsBefore = await fs.readFile(path.join(target, '.swarm', 'security-reviews', 'records.json'), 'utf8');
  const journalBefore = await fs.readFile(path.join(target, '.swarm', 'project', 'journal.ndjson'), 'utf8');

  await assert.rejects(
    () => mergeTicketLedgers({ mini, book, target, apply: true, applyHooks: { throwAfterTempCount: 2 } }),
    err => err.code === 'merge-apply-aborted',
  );

  assert.equal(await fs.readFile(ledgerPath(target), 'utf8'), ticketsBefore);
  assert.equal(await fs.readFile(path.join(target, '.swarm', 'security-reviews', 'records.json'), 'utf8'), recordsBefore);
  assert.equal(await fs.readFile(path.join(target, '.swarm', 'project', 'journal.ndjson'), 'utf8'), journalBefore);
});

test('conflicting review records keep the done side with mergeNote on the ticket', async () => {
  const mini = await setupRoot(
    [baseTicket('T-0401', 'done', { pr: 1 })],
    {
      records: {
        tickets: {
          'T-0401': { verdict: 'pass', findings: [], run: 'mini-run', at: '2026-01-01T10:00:00.000Z', filesHash: 'hash-a' },
        },
      },
    },
  );
  const book = await setupRoot(
    [],
    {
      records: {
        tickets: {
          'T-0401': { verdict: 'fail', findings: [{ severity: 'high', title: 'x' }], run: 'book-run', at: '2026-01-02T10:00:00.000Z', filesHash: 'hash-b' },
        },
      },
    },
  );
  const target = await fs.mkdtemp(path.join(os.tmpdir(), 'ledger-merge-out-'));

  const result = await mergeTicketLedgers({ mini, book, target });
  assert.equal(result.ok, true);
  const ticket = result.ledger.tickets.find(t => t.id === 'T-0401');
  assert.equal(ticket.mergeNote, result.notes.find(n => n.startsWith('T-0401:')));
  assert.match(ticket.mergeNote, /kept mini record/);
  assert.equal(result.reviewRecords.tickets['T-0401'].verdict, 'pass');
  assert.equal(result.reviewRecords.tickets['T-0401'].filesHash, 'hash-a');
});

test('done or review ticket with failing review record is flagged in notes', async () => {
  const mini = await setupRoot(
    [
      baseTicket('T-0501', 'done', { pr: 2 }),
      baseTicket('T-0502', 'review'),
    ],
    {
      records: {
        tickets: {
          'T-0501': { verdict: 'fail', findings: [], run: 'r1', at: '2026-01-01T10:00:00.000Z' },
          'T-0502': { verdict: 'fail', findings: [], run: 'r2', at: '2026-01-01T11:00:00.000Z' },
        },
      },
    },
  );
  const book = await setupRoot([]);
  const target = await fs.mkdtemp(path.join(os.tmpdir(), 'ledger-merge-out-'));

  const result = await mergeTicketLedgers({ mini, book, target });
  assert.equal(result.ok, true);
  assert.ok(result.notes.some(n => n.includes('T-0501') && n.includes('verdict fail')));
  assert.ok(result.notes.some(n => n.includes('T-0502') && n.includes('verdict fail')));
});

test('apply abort mid-rename leaves marker and mixed old/new outputs', async () => {
  const mini = await setupRoot([baseTicket('T-0701', 'todo')]);
  const book = await setupRoot([baseTicket('T-0702', 'todo')]);
  const target = await setupRoot([baseTicket('T-0700', 'todo')], {
    journal: [{ kind: 'note', ts: '2026-01-01T00:00:00.000Z', text: 'original' }],
    records: { tickets: { 'T-0700': { verdict: 'pass', findings: [], run: 'r0', at: '2026-01-01T00:00:00.000Z' } } },
  });
  const ticketsBefore = await fs.readFile(ledgerPath(target), 'utf8');
  const recordsBefore = await fs.readFile(path.join(target, '.swarm', 'security-reviews', 'records.json'), 'utf8');
  const journalBefore = await fs.readFile(path.join(target, '.swarm', 'project', 'journal.ndjson'), 'utf8');

  await assert.rejects(
    () => mergeTicketLedgers({ mini, book, target, apply: true, applyHooks: { throwOnRenameIndex: 1 } }),
    err => err.code === 'merge-apply-incomplete',
  );

  assert.notEqual(await fs.readFile(ledgerPath(target), 'utf8'), ticketsBefore);
  assert.equal(await fs.readFile(path.join(target, '.swarm', 'security-reviews', 'records.json'), 'utf8'), recordsBefore);
  assert.equal(await fs.readFile(path.join(target, '.swarm', 'project', 'journal.ndjson'), 'utf8'), journalBefore);
  await fs.access(ledgerMergeRenamesMarkerPath(target));
});

test('done ticket that requires security review but has no record is flagged in notes', async () => {
  const mini = await setupRoot([
    baseTicket('T-0801', 'done', { pr: 3, files: ['src/api/users/route.ts'] }),
  ]);
  const book = await setupRoot([]);
  const target = await fs.mkdtemp(path.join(os.tmpdir(), 'ledger-merge-out-'));

  const result = await mergeTicketLedgers({ mini, book, target });
  assert.equal(result.ok, true);
  assert.ok(result.notes.some(n => n.includes('T-0801') && n.includes('record missing')));
});

test('internal duplicate ticket id on one side is a hard error', async () => {
  const dup = baseTicket('T-0601', 'todo');
  const miniRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ledger-merge-'));
  await fs.mkdir(path.join(miniRoot, '.swarm', 'project'), { recursive: true });
  await fs.writeFile(
    ledgerPath(miniRoot),
    `${JSON.stringify({
      version: 1,
      scope: { name: 'test', version: 1, hash: 'h1' },
      tickets: [dup, { ...dup, title: 'duplicate row' }],
      changeOrders: [],
      approved: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    }, null, 2)}\n`,
  );
  await writeReviewRecords(miniRoot, { tickets: {} });

  const book = await setupRoot([baseTicket('T-0602', 'todo')]);
  const target = await fs.mkdtemp(path.join(os.tmpdir(), 'ledger-merge-out-'));

  const result = await mergeTicketLedgers({ mini: miniRoot, book, target, apply: true });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'ticket-id-collision');
  assert.match(result.error.message, /mini: duplicate ticket id: T-0601/);
  await assert.rejects(fs.access(ledgerPath(target)));
});
