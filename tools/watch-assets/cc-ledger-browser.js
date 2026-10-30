// SPDX-License-Identifier: Apache-2.0
/** Browser-safe ledger queue helpers (no server imports). */

const STATUSES = ['proposed', 'todo', 'ready', 'running', 'review', 'done', 'blocked', 'cancelled', 'superseded'];
const PROPOSAL_ORIGINS = ['comment', 'error', 'handoff'];
const BURST_LANE_TAG = 'lane:burst';
const BURST_DEFAULT = 'off';
const VALID_BURST = new Set(['off', 'on']);

const byId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

const unapprovedProposal = t => PROPOSAL_ORIGINS.includes(t?.origin) && t.approvedBy !== 'owner';

const TEST_DIR_RE = /(^|\/)(tests?|__tests__|e2e|spec|specs|cypress|playwright)\//i;
const TEST_FILE_RE = /\.(test|spec)\.[A-Za-z0-9]+$|(^|\/)tests\.py$|(^|\/)test_[^/]+\.py$|_test\.(py|go|[cm]?[jt]sx?)$/i;
const CODE_EXT_RE = /\.(?:[cm]?[jt]sx?|py|go|rb|java|kt|rs|sql|feature)$/i;
const NOT_A_TEST_RE = /(^|\/)(support|fixtures?|__fixtures__|__mocks__|mocks?|helpers?)\/|(^|\/)(page|route|layout)\.[A-Za-z0-9]+$/i;

function looksLikeTestFile(p) {
  return typeof p === 'string' && !/\/$/.test(p) && (TEST_FILE_RE.test(p) || (TEST_DIR_RE.test(p) && CODE_EXT_RE.test(p) && !NOT_A_TEST_RE.test(p)));
}

const buildOf = t => t && t.type === 'build' && t.status !== 'cancelled';

function moduleTickets(tickets, reqId) {
  return (tickets ?? []).filter(t => buildOf(t) && t.integration !== true && (t.scopeRefs ?? []).includes(reqId));
}

function integrationTickets(tickets, reqId) {
  return (tickets ?? []).filter(t => buildOf(t) && t.integration === true && (t.scopeRefs ?? []).includes(reqId));
}

function wiringGaps(tickets, reqIds) {
  const list = tickets ?? [];
  const ids = reqIds ?? [...new Set(list.filter(buildOf).flatMap(t => t.scopeRefs ?? []))];
  const gaps = [];
  for (const req of [...ids].sort()) {
    if (!moduleTickets(list, req).length && !integrationTickets(list, req).length) continue;
    const integ = integrationTickets(list, req);
    if (!integ.length) gaps.push({ req, reason: `${req}: build tickets but no integration ticket that mounts them in a route or page` });
    else if (!integ.some(t => (t.tests ?? []).length)) gaps.push({ req, reason: `${req}: its integration ticket has no route-level test (set "tests")` });
    else if (!integ.some(t => (t.tests ?? []).some(looksLikeTestFile))) gaps.push({ req, reason: `${req}: the route-level test of its integration ticket is not a test file (${integ.flatMap(t => t.tests ?? []).slice(0, 3).join(', ')}); name a file in a tests folder or ending in .test or .spec` });
  }
  return gaps;
}

function requirementWired(ledger, reqId) {
  if (!ledger?.wiring) return true;
  return wiringGaps(ledger.tickets ?? [], [reqId]).length === 0;
}

function normalizeBurst(value) {
  if (value === undefined || value === null || value === '') return BURST_DEFAULT;
  const v = String(value).trim().toLowerCase();
  if (!VALID_BURST.has(v)) throw new Error(`invalid burst value: ${value}`);
  return v;
}

function burstEnabled(projectConfig) {
  return normalizeBurst(projectConfig?.burst) === 'on';
}

function isCloudJob(job) {
  if (Array.isArray(job?.tags)) return job.tags.includes(BURST_LANE_TAG);
  return job?.lane === 'burst';
}

export function readyTickets(tickets) {
  const done = new Set(tickets.filter(t => t.status === 'done').map(t => t.id));
  return tickets
    .filter(t => (t.status === 'todo' || t.status === 'ready') && !unapprovedProposal(t) && (t.dependsOn ?? []).every(d => done.has(d)))
    .sort(byId);
}

export function ticketToQueueJob(ticket) {
  if (!ticket || typeof ticket.id !== 'string') return null;
  const tags = Array.isArray(ticket.tags) ? [...ticket.tags] : [];
  if (ticket.lane === 'burst' && !tags.includes(BURST_LANE_TAG)) {
    tags.push(BURST_LANE_TAG);
  }
  return {
    id: ticket.id,
    status: ticket.status,
    ...(tags.length ? { tags } : {}),
    ...(ticket.lane === 'burst' ? { lane: 'burst' } : {}),
  };
}

export function listQueueJobsForProject(jobs, projectConfig) {
  const list = Array.isArray(jobs) ? jobs : [];
  if (burstEnabled(projectConfig)) return list.slice();
  return list.filter(job => !isCloudJob(job));
}

export function ledgerStats(ledger) {
  const tickets = ledger?.tickets ?? [];
  const byStatus = Object.fromEntries(STATUSES.map(s => [s, 0]));
  const byStage = {};
  for (const t of tickets) {
    byStatus[t.status] = (byStatus[t.status] ?? 0) + 1;
    const key = t.stage ?? 'none';
    byStage[key] ??= { total: 0, done: 0 };
    byStage[key].total++;
    if (t.status === 'done') byStage[key].done++;
  }
  const live = tickets.filter(t => !['cancelled', 'proposed', 'superseded'].includes(t.status));
  const percentDone = live.length ? Math.round(100 * live.filter(t => t.status === 'done').length / live.length) : 0;
  let coveragePct = null;
  if (Array.isArray(ledger?.requirements)) {
    const reqIds = ledger.requirements.map(r => (typeof r === 'string' ? r : r.id));
    const covered = reqIds.filter(id => {
      const refs = live.filter(t => (t.scopeRefs ?? []).includes(id));
      return refs.length > 0 && refs.every(t => t.status === 'done') && requirementWired(ledger, id);
    }).length;
    coveragePct = reqIds.length ? Math.round(100 * covered / reqIds.length) : 100;
  }
  return { total: tickets.filter(t => t.status !== 'proposed').length, byStatus, byStage, percentDone, coveragePct };
}
