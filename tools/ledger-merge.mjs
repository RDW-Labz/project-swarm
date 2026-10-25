// SPDX-License-Identifier: Apache-2.0
// One-time, evidence-preserving merge of two machine-local ticket ledgers (Mac mini + MacBook).
import fs from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { readLedger, writeLedger, ledgerPath } from './tickets.mjs';
import { readReviewRecords, writeReviewRecords } from './security-review.mjs';
import { journalPath, readJournal, safeWritableDir, assertRegularOrMissing } from './journal.mjs';

const byId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

function eventTime(event) {
  const raw = event?.ts ?? event?.at;
  const n = Date.parse(raw ?? '');
  return Number.isFinite(n) ? n : 0;
}

function hasSecurityReviewOnTicket(ticket) {
  return ticket?.securityReview && typeof ticket.securityReview === 'object' && !Array.isArray(ticket.securityReview);
}

function mergeReviewRecordEntries(a, b) {
  const verdict = a.verdict === 'fail' || b.verdict === 'fail' ? 'fail' : 'pass';
  const findings = [...(Array.isArray(a.findings) ? a.findings : []), ...(Array.isArray(b.findings) ? b.findings : [])].slice(0, 10);
  return { ...a, ...b, verdict, findings };
}

function enrichDoneTicket(ticket, records, notes) {
  if (ticket?.status !== 'done') return ticket;
  const out = { ...ticket };
  const record = records?.tickets?.[out.id];
  if (record && hasSecurityReviewOnTicket(out)) {
    const blocked = out.securityReview.state === 'blocked';
    const failed = record.verdict === 'fail';
    const accepted = out.securityReview.state === 'accepted-unreviewed';
    const passed = record.verdict === 'pass';
    if ((blocked && passed) || (accepted && failed)) {
      notes.push(`${out.id}: security review verdicts disagree (ticket securityReview vs records.json)`);
    }
  }
  return out;
}

function mergeReviewRecords(left, right, notes) {
  const tickets = { ...(left?.tickets ?? {}) };
  for (const [id, rec] of Object.entries(right?.tickets ?? {})) {
    if (!rec || typeof rec !== 'object') continue;
    const existing = tickets[id];
    if (!existing) {
      tickets[id] = rec;
      continue;
    }
    if (existing.verdict !== rec.verdict) {
      notes.push(`${id}: security review records disagree (${existing.verdict} vs ${rec.verdict})`);
    }
    tickets[id] = mergeReviewRecordEntries(existing, rec);
  }
  return { tickets };
}

function mergeLedgerShell(left, right, tickets) {
  const pick = (() => {
    if (!left && !right) return { version: 1, tickets: [], changeOrders: [], approved: null };
    if (!left) return { ...right };
    if (!right) return { ...left };
    const leftAt = Date.parse(left.updatedAt ?? left.createdAt ?? '');
    const rightAt = Date.parse(right.updatedAt ?? right.createdAt ?? '');
    return rightAt > leftAt ? { ...right } : { ...left };
  })();
  return {
    ...pick,
    tickets: [...tickets].sort(byId),
    updatedAt: new Date().toISOString(),
  };
}

function mergeJournals(leftEvents, rightEvents) {
  return [...leftEvents, ...rightEvents].sort((a, b) => {
    const da = eventTime(a);
    const db = eventTime(b);
    if (da !== db) return da - db;
    return JSON.stringify(a).localeCompare(JSON.stringify(b));
  });
}

async function writeJournal(root, events) {
  const dir = await safeWritableDir(root, ['.swarm', 'project']);
  const file = path.join(dir, 'journal.ndjson');
  await assertRegularOrMissing(file);
  const body = events.map(e => JSON.stringify(e)).join('\n') + (events.length ? '\n' : '');
  const tmp = path.join(dir, `.journal.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
  const handle = await fs.open(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
  try {
    await handle.writeFile(body);
    await handle.sync();
    await handle.close();
    await fs.rename(tmp, file);
  } catch (error) {
    await handle.close().catch(() => {});
    await fs.rm(tmp, { force: true });
    throw error;
  }
}

/**
 * Merge ticket ledgers from two project roots (mini + book) into target.
 * Dry-run by default; set apply: true to write tickets.json, security-reviews/records.json, and journal.ndjson on target.
 *
 * @param {{ mini: string, book: string, target: string, apply?: boolean }} options
 */
export async function mergeTicketLedgers({ mini, book, target, apply = false } = {}) {
  const notes = [];
  const [ledgerMini, ledgerBook, recordsMini, recordsBook, journalMini, journalBook] = await Promise.all([
    readLedger(mini),
    readLedger(book),
    readReviewRecords(mini),
    readReviewRecords(book),
    readJournal(mini, { limit: Infinity }),
    readJournal(book, { limit: Infinity }),
  ]);

  const ticketsMini = ledgerMini?.tickets ?? [];
  const ticketsBook = ledgerBook?.tickets ?? [];
  const idsMini = new Set(ticketsMini.map(t => t.id));
  const collisions = ticketsBook.map(t => t.id).filter(id => idsMini.has(id));

  const report = {
    dryRun: !apply,
    mini: { tickets: ticketsMini.length, journal: journalMini.length },
    book: { tickets: ticketsBook.length, journal: journalBook.length },
    collisions,
    wouldWrite: !collisions.length,
  };

  if (collisions.length) {
    const error = Object.assign(new Error(`ticket id collision: ${collisions.join(', ')}`), {
      code: 'ticket-id-collision',
      ids: collisions,
    });
    return { ok: false, report, notes, collisions, error };
  }

  const mergedRecords = mergeReviewRecords(recordsMini, recordsBook, notes);
  const mergedTickets = [...ticketsMini, ...ticketsBook]
    .map(t => enrichDoneTicket(t, mergedRecords, notes))
    .sort(byId);

  const mergedJournal = mergeJournals(journalMini, journalBook);
  const mergedLedger = mergeLedgerShell(ledgerMini, ledgerBook, mergedTickets);

  report.merged = {
    tickets: mergedTickets.length,
    journal: mergedJournal.length,
    reviewRecords: Object.keys(mergedRecords.tickets).length,
  };

  const result = {
    ok: true,
    report,
    notes,
    collisions: [],
    ledger: mergedLedger,
    reviewRecords: mergedRecords,
    journal: mergedJournal,
  };

  if (apply) {
    await writeLedger(target, mergedLedger);
    await writeReviewRecords(target, mergedRecords);
    await writeJournal(target, mergedJournal);
    result.wrote = {
      tickets: ledgerPath(target),
      records: path.join(target, '.swarm', 'security-reviews', 'records.json'),
      journal: journalPath(target),
    };
  }

  return result;
}
