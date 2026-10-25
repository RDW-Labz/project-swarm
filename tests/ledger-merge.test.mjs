// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createLedger, writeLedger, readLedger, ledgerPath } from '../tools/tickets.mjs';
import { readReviewRecords, writeReviewRecords } from '../tools/security-review.mjs';
import { journalPath, readJournal } from '../tools/journal.mjs';
import { mergeTicketLedgers } from '../tools/ledger-merge.mjs';

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
