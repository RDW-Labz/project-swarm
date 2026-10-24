// Event store schema for the per-machine SQLite events table (T-0227).
// Owns only the DDL, the event row shape, and store creation with the event_store flag.

export const EVENTS_TABLE_DDL = `
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  kind TEXT NOT NULL,
  ticket_id TEXT,
  job_id TEXT,
  provider TEXT,
  spend_usd REAL NOT NULL DEFAULT 0,
  payload TEXT NOT NULL DEFAULT '{}'
)`;

export const EVENTS_INDEX_DDL = [
  'CREATE INDEX IF NOT EXISTS events_ts_idx ON events (ts)',
  'CREATE INDEX IF NOT EXISTS events_ticket_idx ON events (ticket_id)',
];

/**
 * @typedef {Object} EventRow
 * @property {number} [id]
 * @property {string} ts
 * @property {string} kind
 * @property {string|null} [ticket_id]
 * @property {string|null} [job_id]
 * @property {string|null} [provider]
 * @property {number} [spend_usd]
 * @property {string} [payload]
 */

const MIN_NODE_SQLITE = [22, 13, 0];

export function parseNodeVersion(version) {
  const parts = String(version).replace(/^v/, '').split('.').map((n) => Number.parseInt(n, 10));
  return [parts[0] || 0, parts[1] || 0, parts[2] || 0];
}

export function nodeSqliteAvailable(version = process.versions.node) {
  const have = parseNodeVersion(version);
  for (let i = 0; i < 3; i += 1) {
    if (have[i] > MIN_NODE_SQLITE[i]) return true;
    if (have[i] < MIN_NODE_SQLITE[i]) return false;
  }
  return true;
}

/**
 * Opens the per-machine event store. Returns { enabled: false, reason } when
 * node:sqlite is unavailable, so callers can log the reason and keep event_store off.
 * @param {string} dbPath
 * @param {{ log?: (msg: string) => void, version?: string }} [opts]
 */
export async function openEventStore(dbPath, opts = {}) {
  const log = opts.log ?? ((msg) => console.log(msg));
  const version = opts.version ?? process.versions.node;
  if (!nodeSqliteAvailable(version)) {
    const reason = `event_store off: missing node:sqlite (requires Node 22.13+, running ${version})`;
    log(reason);
    return { enabled: false, reason, db: null };
  }
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(dbPath);
  db.exec(EVENTS_TABLE_DDL);
  for (const stmt of EVENTS_INDEX_DDL) db.exec(stmt);
  return { enabled: true, reason: null, db };
}

/**
 * Inserts one event row using the EventRow shape.
 * @param {any} db
 * @param {EventRow} row
 */
export function insertEvent(db, row) {
  const stmt = db.prepare(
    'INSERT INTO events (ts, kind, ticket_id, job_id, provider, spend_usd, payload) VALUES (?, ?, ?, ?, ?, ?, ?)',
  );
  stmt.run(
    row.ts,
    row.kind,
    row.ticket_id ?? null,
    row.job_id ?? null,
    row.provider ?? null,
    row.spend_usd ?? 0,
    row.payload ?? '{}',
  );
}
