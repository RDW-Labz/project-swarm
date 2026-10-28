// SPDX-License-Identifier: Apache-2.0
import { parseLane, ticketSetHash } from './tickets.mjs';

const MIGRATION_DIR_PREFIXES = [
  'supabase/migrations/',
  'prisma/migrations/',
  'db/migrations/',
  'migrations/',
];

const DEPLOY_BASENAMES = new Set(['vercel.json', 'netlify.toml', 'fly.toml', 'dockerfile']);

const PAID_LANE_RE = /anthropic|openrouter/i;

const normPath = p => String(p ?? '').replace(/\\/g, '/');

const canon = value => {
  if (value === null || value === undefined) return 'null';
  if (Array.isArray(value)) return `[${value.map(canon).join(',')}]`;
  if (typeof value === 'object') {
    return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canon(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
};

const ticketComparable = ticket => {
  if (!ticket || typeof ticket !== 'object') return {};
  const out = { ...ticket };
  delete out.status;
  delete out.updatedAt;
  delete out.notes;
  return out;
};

function collectProfileMigrationDirs(migrations) {
  const dirs = [];
  const visit = value => {
    if (value == null) return;
    if (typeof value === 'string') {
      if (value.trim()) dirs.push(value.trim());
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (typeof value === 'object') {
      for (const key of ['directory', 'dir', 'path', 'root', 'folder']) {
        if (typeof value[key] === 'string' && value[key].trim()) dirs.push(value[key].trim());
      }
      for (const item of Object.values(value)) {
        if (item !== value) visit(item);
      }
    }
  };
  visit(migrations);
  return dirs;
}

function pathUnderMigrationDirs(filePath, profile) {
  const n = normPath(filePath).toLowerCase();
  for (const pref of MIGRATION_DIR_PREFIXES) {
    if (n.startsWith(pref) || n.includes(`/${pref}`)) return true;
  }
  const dirs = collectProfileMigrationDirs(profile?.migrations);
  for (const raw of dirs) {
    const d = normPath(raw).replace(/\/$/, '').toLowerCase();
    if (!d) continue;
    if (n === d || n.startsWith(`${d}/`) || n.includes(`/${d}/`)) return true;
  }
  if (profile?.migrations && Object.keys(profile.migrations).length > 0 && (n.endsWith('.sql') || /\/migrations\//i.test(n))) {
    return true;
  }
  return false;
}

function ticketTouchesMigration(ticket, profile) {
  if (ticket?.type === 'migration') return true;
  for (const p of ticket?.files ?? []) {
    if (normPath(p).toLowerCase().endsWith('.sql')) return true;
    if (pathUnderMigrationDirs(p, profile)) return true;
  }
  for (const p of ticket?.tests ?? []) {
    if (normPath(p).toLowerCase().endsWith('.sql')) return true;
    if (pathUnderMigrationDirs(p, profile)) return true;
  }
  return false;
}

function isDeployOrReleasePath(filePath) {
  const n = normPath(filePath);
  const base = n.split('/').pop()?.toLowerCase() ?? '';
  if (DEPLOY_BASENAMES.has(base)) return true;
  const lower = n.toLowerCase();
  if (lower.includes('.github/workflows/')) {
    if (base.includes('deploy') || base.includes('release')) return true;
  }
  return false;
}

function ticketTouchesDeploy(ticket) {
  const paths = [...(ticket?.files ?? []), ...(ticket?.tests ?? []), ...(ticket?.context ?? []), ...(ticket?.deletes ?? [])];
  if (paths.some(isDeployOrReleasePath)) return true;
  const acceptance = ticket?.acceptance ?? [];
  if (!Array.isArray(acceptance)) return false;
  return acceptance.some(line => /\b(deploy|production|prod)\b/i.test(String(line))
    || /\bmerge\b.*\bmain\b/i.test(String(line)));
}

function laneNamesPaid(ticket) {
  const hits = [];
  const lane = ticket?.lane;
  if (typeof lane === 'string' && PAID_LANE_RE.test(lane)) hits.push(lane);
  const parsed = typeof lane === 'string' ? parseLane(lane) : null;
  if (parsed?.agent && PAID_LANE_RE.test(parsed.agent)) hits.push(parsed.agent);
  return hits;
}

function snapshotTicketMap(snapshot) {
  const list = snapshot?.tickets;
  if (!Array.isArray(list)) return null;
  return new Map(list.map(t => [t.id, t]));
}

function addedAndChangedTickets(ledger, snapshot) {
  const snapMap = snapshotTicketMap(snapshot);
  if (!snapMap) return { added: [], changed: [] };
  const added = [];
  const changed = [];
  for (const ticket of ledger?.tickets ?? []) {
    const prev = snapMap.get(ticket.id);
    if (!prev) {
      added.push(ticket);
      continue;
    }
    if (canon(ticketComparable(ticket)) !== canon(ticketComparable(prev))) changed.push(ticket);
  }
  return { added, changed };
}

function newChangeOrderIds(ledger, snapshot) {
  const seen = new Set(snapshot?.changeOrderIds ?? []);
  return (ledger?.changeOrders ?? []).map(c => c.id).filter(id => !seen.has(id));
}

/**
 * @param {{ ledger: object, snapshot: object|null, profile: object|null }} input
 * @returns {{ ok: boolean, conditions: Array<{ name: string, ok: boolean, detail: string }> }}
 */
export function evaluateAutoApprove({ ledger, snapshot, profile, approveLogTicketsHash } = {}) {
  const conditions = [];

  const hasSnapshotTickets = Boolean(snapshot && Array.isArray(snapshot.tickets));
  const snapshotContentHash = hasSnapshotTickets ? ticketSetHash(snapshot.tickets) : null;
  const snapshotBound = hasSnapshotTickets
    && typeof approveLogTicketsHash === 'string'
    && typeof snapshot.ticketsHash === 'string'
    && snapshot.ticketsHash === approveLogTicketsHash
    && snapshot.ticketsHash === snapshotContentHash;
  let snapshotDetail = 'no approved-ticket snapshot: the owner approves once with swarm scope approve --yes';
  if (hasSnapshotTickets) {
    if (typeof approveLogTicketsHash !== 'string') {
      snapshotDetail = 'no approve entry in tickets log to bind the snapshot';
    } else if (!snapshotBound) {
      snapshotDetail = `snapshot ticketsHash does not match the last approve log (${approveLogTicketsHash}) or the ticket set`;
    } else {
      snapshotDetail = `snapshot from ${snapshot.at ?? 'unknown'} (${snapshot.tickets.length} ticket(s))`;
    }
  }
  conditions.push({
    name: 'snapshot',
    ok: snapshotBound,
    detail: snapshotDetail,
  });

  const newCoIds = newChangeOrderIds(ledger, snapshot ?? {});
  conditions.push({
    name: 'change-order',
    ok: newCoIds.length > 0,
    detail: newCoIds.length ? `new change order id(s): ${newCoIds.join(', ')}` : 'no new change order since the last approval snapshot',
  });

  const doneProblems = [];
  if (hasSnapshotTickets) {
    for (const st of snapshot.tickets) {
      const cur = (ledger?.tickets ?? []).find(t => t.id === st.id);
      if (st.status !== 'cancelled') {
        if (!cur) doneProblems.push(`${st.id}: missing from ledger`);
        else if (cur.status === 'cancelled') doneProblems.push(`${st.id}: cancelled`);
      }
      if (st.status === 'done') {
        if (!cur) {
          if (!doneProblems.some(p => p.startsWith(`${st.id}:`))) doneProblems.push(`${st.id}: missing from ledger`);
        } else if (cur.status !== 'done') doneProblems.push(`${st.id}: status is ${cur.status}`);
      }
    }
  } else {
    doneProblems.push('no snapshot to compare');
  }
  conditions.push({
    name: 'no-done-cancelled',
    ok: snapshotBound && doneProblems.length === 0,
    detail: doneProblems.length ? doneProblems.join('; ') : 'snapshot tickets unchanged (not cancelled, missing, or regressed from done)',
  });

  const { added, changed } = addedAndChangedTickets(ledger, snapshot);
  const touched = [...added, ...changed];
  const paidHits = [];
  for (const ticket of touched) {
    const names = laneNamesPaid(ticket);
    if (names.length) paidHits.push(`${ticket.id}: ${names.join(', ')}`);
  }
  conditions.push({
    name: 'no-paid-lanes',
    ok: paidHits.length === 0,
    detail: paidHits.length ? paidHits.join('; ') : 'no added or changed ticket uses anthropic or openrouter lanes',
  });

  const migrationHits = touched.filter(t => ticketTouchesMigration(t, profile)).map(t => t.id);
  conditions.push({
    name: 'no-migrations',
    ok: migrationHits.length === 0,
    detail: migrationHits.length ? `ticket(s): ${migrationHits.join(', ')}` : 'no migration tickets or migration paths in added/changed tickets',
  });

  const deployHits = touched.filter(ticketTouchesDeploy).map(t => t.id);
  conditions.push({
    name: 'no-deploy-or-main-merge',
    ok: deployHits.length === 0,
    detail: deployHits.length ? `ticket(s): ${deployHits.join(', ')}` : 'no deploy, production, or merge-to-main signals in added/changed tickets',
  });

  const ok = conditions.every(c => c.ok);
  return { ok, conditions };
}
