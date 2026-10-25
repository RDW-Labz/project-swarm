// SPDX-License-Identifier: Apache-2.0
// One-time, evidence-preserving merge of two machine-local ticket ledgers (Mac mini + MacBook).
import fs from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { readLedger, ledgerPath } from './tickets.mjs';
import { readReviewRecords } from './security-review.mjs';
import { journalPath, readJournal, safeWritableDir, assertRegularOrMissing } from './journal.mjs';
import { acquireAutopilotLock } from './autopilot-lock.mjs';

const byId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

function eventTime(event) {
  const raw = event?.ts ?? event?.at;
  const n = Date.parse(raw ?? '');
  return Number.isFinite(n) ? n : 0;
}

function hasSecurityReviewOnTicket(ticket) {
  return ticket?.securityReview && typeof ticket.securityReview === 'object' && !Array.isArray(ticket.securityReview);
}

function ticketIndexById(tickets) {
  const map = new Map();
  for (const t of tickets ?? []) {
    if (t?.id) map.set(t.id, t);
  }
  return map;
}

function internalDuplicateIds(tickets) {
  const seen = new Set();
  const dups = [];
  for (const t of tickets) {
    const id = t?.id;
    if (!id) continue;
    if (seen.has(id)) dups.push(id);
    else seen.add(id);
  }
  return dups;
}

function pickConflictingReviewRecord(id, leftRec, rightRec, ticketMini, ticketBook) {
  const miniDone = ticketMini?.status === 'done';
  const bookDone = ticketBook?.status === 'done';
  let kept;
  let keptSide;
  if (miniDone && !bookDone) {
    kept = leftRec;
    keptSide = 'mini';
  } else if (bookDone && !miniDone) {
    kept = rightRec;
    keptSide = 'book';
  } else if (miniDone && bookDone) {
    if (leftRec.verdict === 'pass' && rightRec.verdict !== 'pass') {
      kept = leftRec;
      keptSide = 'mini';
    } else if (rightRec.verdict === 'pass' && leftRec.verdict !== 'pass') {
      kept = rightRec;
      keptSide = 'book';
    } else {
      kept = leftRec;
      keptSide = 'mini';
    }
  } else {
    kept = leftRec.verdict === 'pass' && rightRec.verdict !== 'pass' ? leftRec : rightRec.verdict === 'pass' ? rightRec : leftRec;
    keptSide = kept === leftRec ? 'mini' : 'book';
  }
  const mergeNote =
    `${id}: security review records disagree (mini: verdict=${leftRec.verdict}, filesHash=${leftRec.filesHash ?? 'n/a'}; ` +
    `book: verdict=${rightRec.verdict}, filesHash=${rightRec.filesHash ?? 'n/a'}); kept ${keptSide} record (verdict=${kept.verdict})`;
  return { record: { ...kept }, mergeNote };
}

function mergeReviewRecordEntries(a, b) {
  const verdict = a.verdict === 'fail' || b.verdict === 'fail' ? 'fail' : 'pass';
  const findings = [...(Array.isArray(a.findings) ? a.findings : []), ...(Array.isArray(b.findings) ? b.findings : [])].slice(0, 10);
  return { ...a, ...b, verdict, findings };
}

function enrichTicketReviewConsistency(ticket, records, notes) {
  if (ticket?.status !== 'done' && ticket?.status !== 'review') return ticket;
  const out = { ...ticket };
  const record = records?.tickets?.[out.id];
  const failed = record?.verdict === 'fail';
  const missing = !record;
  const needsRecord = hasSecurityReviewOnTicket(out) && out.securityReview.state === 'blocked';
  if (failed || (missing && needsRecord)) {
    notes.push(
      `${out.id}: security review verdicts disagree (ticket status ${out.status} vs records.json` +
        `${failed ? ', verdict fail' : ', record missing'})`,
    );
  }
  return out;
}

function mergeReviewRecords(left, right, ticketsMini, ticketsBook, notes) {
  const miniById = ticketIndexById(ticketsMini);
  const bookById = ticketIndexById(ticketsBook);
  const mergeNotesByTicketId = {};
  const tickets = { ...(left?.tickets ?? {}) };
  for (const [id, rec] of Object.entries(right?.tickets ?? {})) {
    if (!rec || typeof rec !== 'object') continue;
    const existing = tickets[id];
    if (!existing) {
      tickets[id] = rec;
      continue;
    }
    const verdictDiff = existing.verdict !== rec.verdict;
    const hashDiff = (existing.filesHash ?? null) !== (rec.filesHash ?? null);
    if (verdictDiff || hashDiff) {
      const { record, mergeNote } = pickConflictingReviewRecord(
        id,
        existing,
        rec,
        miniById.get(id),
        bookById.get(id),
      );
      tickets[id] = record;
      mergeNotesByTicketId[id] = mergeNote;
      notes.push(mergeNote);
      continue;
    }
    tickets[id] = mergeReviewRecordEntries(existing, rec);
  }
  return { tickets, mergeNotesByTicketId };
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

async function writeTempRegularFile(file, body) {
  await assertRegularOrMissing(file);
  const dir = path.dirname(file);
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
  const handle = await fs.open(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
  try {
    await handle.writeFile(body);
    await handle.sync();
    await handle.close();
    return { tmp, final: file };
  } catch (error) {
    await handle.close().catch(() => {});
    await fs.rm(tmp, { force: true });
    throw error;
  }
}

/**
 * Write ledger, review records, and journal via temp files, then rename all into place.
 * @param {{ throwBeforeRename?: boolean, throwAfterTempCount?: number }} hooks - test hooks
 */
export async function applyMergedOutputs(root, { ledger, reviewRecords, journalEvents }, hooks = {}) {
  const projectDir = await safeWritableDir(root, ['.swarm', 'project']);
  const recordsDir = path.join(root, '.swarm', 'security-reviews');
  await fs.mkdir(recordsDir, { recursive: true });

  const specs = [
    [path.join(projectDir, 'tickets.json'), JSON.stringify(ledger, null, 2) + '\n'],
    [path.join(recordsDir, 'records.json'), JSON.stringify(reviewRecords, null, 2) + '\n'],
    [
      path.join(projectDir, 'journal.ndjson'),
      journalEvents.map(e => JSON.stringify(e)).join('\n') + (journalEvents.length ? '\n' : ''),
    ],
  ];

  const pending = [];
  for (let i = 0; i < specs.length; i += 1) {
    const [file, body] = specs[i];
    pending.push(await writeTempRegularFile(file, body));
    const failAfter = hooks.throwAfterTempCount ?? (hooks.throwBeforeRename ? specs.length : 0);
    if (failAfter === i + 1) {
      for (const { tmp } of pending) await fs.rm(tmp, { force: true });
      throw Object.assign(new Error('apply merge aborted before rename (test)'), { code: 'merge-apply-aborted' });
    }
  }

  for (const { tmp, final } of pending) {
    await fs.rename(tmp, final);
  }
}

/**
 * Merge ticket ledgers from two project roots (mini + book) into target.
 * Dry-run by default; set apply: true to write tickets.json, security-reviews/records.json, and journal.ndjson on target.
 *
 * @param {{ mini: string, book: string, target: string, apply?: boolean, applyHooks?: { throwBeforeRename?: boolean, throwAfterTempCount?: number }, lockOptions?: object }} options
 */
export async function mergeTicketLedgers({ mini, book, target, apply = false, applyHooks, lockOptions } = {}) {
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

  const miniInternalDups = internalDuplicateIds(ticketsMini);
  if (miniInternalDups.length) {
    const error = Object.assign(new Error(`mini: duplicate ticket id: ${miniInternalDups.join(', ')}`), {
      code: 'ticket-id-collision',
      ids: miniInternalDups,
      side: 'mini',
    });
    return {
      ok: false,
      report: { dryRun: !apply, mini: { tickets: ticketsMini.length }, book: { tickets: ticketsBook.length }, wouldWrite: false },
      notes,
      collisions: miniInternalDups,
      error,
    };
  }

  const bookInternalDups = internalDuplicateIds(ticketsBook);
  if (bookInternalDups.length) {
    const error = Object.assign(new Error(`book: duplicate ticket id: ${bookInternalDups.join(', ')}`), {
      code: 'ticket-id-collision',
      ids: bookInternalDups,
      side: 'book',
    });
    return {
      ok: false,
      report: { dryRun: !apply, mini: { tickets: ticketsMini.length }, book: { tickets: ticketsBook.length }, wouldWrite: false },
      notes,
      collisions: bookInternalDups,
      error,
    };
  }

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

  const { tickets: mergedRecordTickets, mergeNotesByTicketId } = mergeReviewRecords(
    recordsMini,
    recordsBook,
    ticketsMini,
    ticketsBook,
    notes,
  );
  const mergedRecords = { tickets: mergedRecordTickets };

  const mergedTickets = [...ticketsMini, ...ticketsBook]
    .map(t => {
      let out = enrichTicketReviewConsistency(t, mergedRecords, notes);
      if (mergeNotesByTicketId[out.id]) out = { ...out, mergeNote: mergeNotesByTicketId[out.id] };
      return out;
    })
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
    let releaseLock;
    try {
      releaseLock = await acquireAutopilotLock(target, lockOptions);
      await applyMergedOutputs(
        target,
        { ledger: mergedLedger, reviewRecords: mergedRecords, journalEvents: mergedJournal },
        applyHooks ?? {},
      );
      result.wrote = {
        tickets: ledgerPath(target),
        records: path.join(target, '.swarm', 'security-reviews', 'records.json'),
        journal: journalPath(target),
      };
    } finally {
      if (releaseLock) await releaseLock();
    }
  }

  return result;
}
