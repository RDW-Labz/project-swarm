// SPDX-License-Identifier: Apache-2.0
import { lexSql } from './migration-gate.mjs';

const MIGRATIONS_PREFIX = 'supabase/migrations/';

const DML_PATTERNS = [
  { re: /\binsert\s+into\b/i, label: 'INSERT' },
  { re: /\bupdate\s+(?:only\s+)?[\w."`]+\s+set\b/i, label: 'UPDATE' },
  { re: /(?:^|[^a-z_])delete\s+from\b/i, label: 'DELETE' },
  { re: /\bplan\s*\(/i, label: 'pgTAP plan()' },
  { re: /\bselect\s+\*\s+from\s+finish\b/i, label: 'pgTAP finish' },
  { re: /\braise\s+notice\b/i, label: 'RAISE NOTICE' },
];

export function sqlMigrationDdlOnlyProblems(sql, file = 'migration') {
  const clean = lexSql(String(sql ?? ''));
  const problems = [];
  for (const { re, label } of DML_PATTERNS) {
    if (re.test(clean)) {
      problems.push(`${file}: migrations under ${MIGRATIONS_PREFIX} must be DDL only (found ${label})`);
      return problems;
    }
  }
  if (/(?:^|[^a-z_])do\s+(\$|language)/i.test(clean)) {
    problems.push(`${file}: migrations under ${MIGRATIONS_PREFIX} must be DDL only (DO blocks belong in tests, not migrations)`);
  }
  return problems;
}

export function deleteOnlyTicketPasses(ticket, { exists }) {
  const files = ticket?.files ?? [];
  const deletes = ticket?.deletes ?? [];
  if (files.length !== 0 || deletes.length === 0) return false;
  return deletes.every(p => !exists(p));
}

export function renameTicketCheck(ticket, { exists }) {
  const problems = [];
  const files = ticket?.files ?? [];
  const dels = ticket?.deletes ?? [];
  if (ticket?.type !== 'rename') {
    return { ok: false, problems: ['not a rename ticket'] };
  }
  if (files.length !== 1) problems.push('rename tickets need exactly one new file in files');
  if (dels.length !== 1) problems.push('rename tickets need exactly one path in deletes');
  if (files.length === 1 && dels.length === 1) {
    const [newPath, oldPath] = [files[0], dels[0]];
    if (!exists(newPath)) problems.push(`${newPath} does not exist yet`);
    if (exists(oldPath)) problems.push(`${oldPath} still exists`);
  }
  return { ok: problems.length === 0, problems };
}

export async function migrationTicketCheck(ticket, { readFile }) {
  const problems = [];
  if (ticket?.type !== 'migration') {
    return { ok: false, problems: ['not a migration ticket'] };
  }
  const migFiles = (ticket.files ?? []).filter(f => typeof f === 'string' && f.toLowerCase().startsWith(MIGRATIONS_PREFIX));
  for (const file of migFiles) {
    let bytes;
    try {
      bytes = await readFile(file);
    } catch {
      problems.push(`${file}: could not read migration file`);
      continue;
    }
    const sql = Buffer.isBuffer(bytes) ? bytes.toString('utf8') : String(bytes);
    problems.push(...sqlMigrationDdlOnlyProblems(sql, file));
  }
  return { ok: problems.length === 0, problems };
}

export async function syncCheckForTicket(ticket, deps = {}) {
  const exists = deps.exists ?? (() => false);
  const readFile = deps.readFile ?? (async () => Buffer.alloc(0));

  if (ticket?.type === 'rename') {
    const result = renameTicketCheck(ticket, { exists });
    return { ok: result.ok, problems: result.problems, kind: 'rename' };
  }
  if (ticket?.type === 'migration') {
    const result = await migrationTicketCheck(ticket, { readFile });
    return { ok: result.ok, problems: result.problems, kind: 'migration' };
  }

  const files = ticket?.files ?? [];
  const dels = ticket?.deletes ?? [];
  if (files.length === 0 && dels.length > 0) {
    const pass = deleteOnlyTicketPasses(ticket, { exists });
    const problems = pass
      ? []
      : dels.filter(p => exists(p)).map(p => `${p} still exists`);
    return { ok: pass, problems, kind: 'delete-only' };
  }

  return { ok: true, problems: [], kind: 'normal' };
}
