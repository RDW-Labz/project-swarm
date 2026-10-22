// SPDX-License-Identifier: Apache-2.0
// Wiring: features built as modules are connected by an integration ticket per requirement (routes, pages, a route-level test).
// Pure functions; scope-commands.mjs calls them from split and ingest.

import { protectedPathHit } from './init-profile.mjs';

export const WIRING_PROMPT = [
  'Wiring rule: for every requirement that has build tickets, add ONE integration ticket (type build, "integration": true) that mounts those modules in the real routes, pages or entry points (for example src/app/.../page.tsx, a router file, an API route file) so a user can reach the feature.',
  'Its "tests" lists a route-level or end-to-end test that requests the real route or page and checks the result (not a unit test of one module); its acceptance names the route or page; its scopeRefs are the requirement ids; its files are the route and page files only.',
  'You do not need to list its dependsOn on the module tickets of the same requirement: the runner adds them. Two integration tickets that edit the same shared file (router, navigation, layout) are chained by the runner, the later one after the earlier.',
  'A requirement is done only when its integration ticket is done and its route-level test passed.',
].join('\n');

export const WIRE_ONLY_PROMPT = 'Write ONLY integration tickets (every ticket has "integration": true). The module tickets below already exist; do not repeat them.';

// A test path must look like a test: a test folder, a .test/.spec file, or a python/go test file. A page or module file is not a route-level test.
const TEST_DIR_RE = /(^|\/)(tests?|__tests__|e2e|spec|specs|cypress|playwright)\//i;
const TEST_FILE_RE = /\.(test|spec)\.[A-Za-z0-9]+$|(^|\/)tests\.py$|(^|\/)test_[^/]+\.py$|_test\.(py|go|[cm]?[jt]sx?)$/i;
// In a test folder the file must still be a source or test file, not a helper, fixture, support file, data file or a page.
const CODE_EXT_RE = /\.(?:[cm]?[jt]sx?|py|go|rb|java|kt|rs|sql|feature)$/i;
const NOT_A_TEST_RE = /(^|\/)(support|fixtures?|__fixtures__|__mocks__|mocks?|helpers?)\/|(^|\/)(page|route|layout)\.[A-Za-z0-9]+$/i;
export const looksLikeTestFile = p => typeof p === 'string' && !/\/$/.test(p) && (TEST_FILE_RE.test(p) || (TEST_DIR_RE.test(p) && CODE_EXT_RE.test(p) && !NOT_A_TEST_RE.test(p)));

const buildOf = t => t && t.type === 'build' && t.status !== 'cancelled';

// The active build tickets of a requirement that are modules (not the integration ticket itself).
export function moduleTickets(tickets, reqId) {
  return (tickets ?? []).filter(t => buildOf(t) && t.integration !== true && (t.scopeRefs ?? []).includes(reqId));
}

export function integrationTickets(tickets, reqId) {
  return (tickets ?? []).filter(t => buildOf(t) && t.integration === true && (t.scopeRefs ?? []).includes(reqId));
}

// Requirements (of reqIds, else all named by build tickets) that have module tickets but no integration ticket, or one without a test.
export function wiringGaps(tickets, reqIds) {
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

// Makes every integration ticket of `added` depend on the module tickets of its requirements (from `existing` and `added`),
// except modules that already depend on it, so no cycle appears. Mutates and returns `added`.
export function addWiringDeps(added, existing = []) {
  const all = [...existing, ...added];
  const dependsOnIt = (t, target, seen = new Set()) => {
    if (seen.has(t.id)) return false;
    seen.add(t.id);
    return (t.dependsOn ?? []).some(d => d === target || dependsOnIt(all.find(x => x.id === d) ?? { id: d }, target, seen));
  };
  for (const t of added) {
    if (!buildOf(t) || t.integration !== true) continue;
    const wanted = new Set(t.dependsOn ?? []);
    for (const req of t.scopeRefs ?? []) for (const m of moduleTickets(all, req)) {
      if (m.id !== t.id && !dependsOnIt(m, t.id)) wanted.add(m.id);
    }
    t.dependsOn = [...wanted];
  }
  return added;
}

// Two integration tickets that write the same file (router, navigation, layout), in any stages, cannot run in the same wave: the later one (by id)
// waits for the earlier, unless they are already ordered. Mutates the tickets of `added` and returns them.
export function chainSharedFiles(added, existing = []) {
  const all = [...existing, ...added];
  const reaches = (from, target, seen = new Set()) => {
    if (seen.has(from.id)) return false;
    seen.add(from.id);
    return (from.dependsOn ?? []).some(d => d === target || reaches(all.find(x => x.id === d) ?? { id: d }, target, seen));
  };
  const integ = all.filter(t => buildOf(t) && t.integration === true).sort((a, b) => (a.id < b.id ? -1 : 1));
  const newIds = new Set(added.map(t => t.id));
  for (let i = 0; i < integ.length; i += 1) for (let j = 0; j < i; j += 1) {
    const early = integ[j], late = integ[i];
    if (!newIds.has(late.id)) continue;
    if (!(late.files ?? []).some(f => (early.files ?? []).includes(f))) continue;
    if (reaches(late, early.id) || reaches(early, late.id)) continue;
    late.dependsOn = [...new Set([...(late.dependsOn ?? []), early.id])];
  }
  return added;
}

// Requirements whose build tickets are all done: already built, so `--wire` leaves them alone unless asked (--all).
export function builtRequirements(tickets, reqIds) {
  return reqIds.filter(req => {
    const mine = (tickets ?? []).filter(t => buildOf(t) && (t.scopeRefs ?? []).includes(req));
    return mine.length > 0 && mine.every(t => t.status === 'done');
  });
}

// For `scope split --wire`: the requirements that have module tickets but no integration ticket.
export function unwiredRequirements(tickets) {
  const list = tickets ?? [];
  const reqs = [...new Set(list.filter(buildOf).filter(t => t.integration !== true).flatMap(t => t.scopeRefs ?? []))];
  return reqs.filter(r => !integrationTickets(list, r).length).sort();
}

// Tests wait for the modules they test (parts-app lesson 55): a test ticket that runs before its module exists can only fail or block.
// Every test ticket of `added` depends on the module tickets of its requirements (from `existing` and `added`); a module that was told to wait
// for that test (a test-first order from the worker) has that dependency removed, so no cycle appears. Integration tickets are not touched
// (they already wait for their modules). Mutates `added`; returns notes for the owner.
export function orderTestsAfterBuild(added, existing = []) {
  const all = [...existing, ...added];
  const notes = [];
  const removedByTicket = new Map();
  const byId = id => all.find(x => x.id === id) ?? { id };
  const reaches = (from, target, seen = new Set()) => {
    if (seen.has(from.id)) return false;
    seen.add(from.id);
    return (from.dependsOn ?? []).some(d => d === target || reaches(byId(d), target, seen));
  };
  const newIds = new Set(added.map(t => t.id));
  // A test waits for modules in this split, or open existing ones — not older builds already done (the code exists).
  const testWaitsOnModule = m => newIds.has(m.id) || m.status !== 'done';
  for (const t of added) {
    if (t.type !== 'test' || t.status === 'cancelled') continue;
    // The modules a test checks: build tickets (not integration) and migrations of its requirements.
    const prerequisites = req => [...moduleTickets(all, req), ...all.filter(x => x.type === 'migration' && x.status !== 'cancelled' && (x.scopeRefs ?? []).includes(req))];
    const modules = [...new Set((t.scopeRefs ?? []).flatMap(prerequisites))].filter(m => m.id !== t.id);
    const waitOn = modules.filter(testWaitsOnModule);
    const flipped = [], waits = [];
    for (const m of modules) if ((m.dependsOn ?? []).includes(t.id)) {
      m.dependsOn = m.dependsOn.filter(d => d !== t.id);
      flipped.push(m.id);
      const ownedTestFiles = new Set(Array.isArray(m.tests) ? m.tests : []);
      const testFiles = new Set([...(t.files ?? []), ...(t.tests ?? [])]);
      if (m.type === 'build' && ownedTestFiles.size && [...ownedTestFiles].some(file => testFiles.has(file))) {
        const prior = removedByTicket.get(m.id) ?? [];
        removedByTicket.set(m.id, [...prior, t.id]);
      }
    }
    const indirect = [];
    for (const m of waitOn) {
      if (reaches(m, t.id)) { indirect.push(m.id); continue; }
      if (!(t.dependsOn ?? []).includes(m.id)) { t.dependsOn = [...(t.dependsOn ?? []), m.id]; waits.push(m.id); }
    }
    if (indirect.length) notes.push(`${t.id}: ${indirect.join(', ')} waits for this test through other tickets, so the test could not be ordered after it; check that order`);
    if (waits.length) notes.push(`${t.id}: test ticket now waits for ${waits.join(', ')} (a test runs after the module it tests)${flipped.length ? `; ${flipped.join(', ')} no longer waits for it` : ''}`);
  }
  for (const [ticketId, testIds] of removedByTicket) notes.push(`${ticketId}: owns its tests; no longer waits on ${testIds.join(', ')}`);
  return notes;
}

export function stageRank(stage) {
  const match = /^S(\d+)$/i.exec(String(stage ?? ''));
  return match ? Number(match[1]) : 0;
}

function ticketOutputs(ticket) {
  return new Set([...(ticket?.files ?? []), ...(ticket?.tests ?? [])]);
}

function moduleBuildsForTest(all, test) {
  const named = new Set([...(test.context ?? []), ...(test.tests ?? []), ...(test.files ?? [])]);
  const byPath = all.filter(t => buildOf(t) && t.integration !== true && (t.files ?? []).some(f => named.has(f)));
  const byRef = [...new Set((test.scopeRefs ?? []).flatMap(req => moduleTickets(all, req)))];
  const out = [];
  for (const ticket of [...byPath, ...byRef]) if (!out.some(entry => entry.id === ticket.id)) out.push(ticket);
  return out;
}

// A test ticket must live in the same stage as the module builds it exercises; later stages are repaired or rejected.
export function alignTestTicketsWithBuildStages(added, existing = [], { notes = [], rejected = [] } = {}) {
  const all = [...existing, ...added];
  const rejectedIds = new Set(rejected.map(entry => entry.id));
  for (const test of added) {
    if (test.type !== 'test' || test.status === 'cancelled' || rejectedIds.has(test.id)) continue;
    const modules = moduleBuildsForTest(all, test);
    const wantsCode = (test.context ?? []).some(path => !looksLikeTestFile(path))
      || (test.scopeRefs ?? []).length > 0;
    if (!modules.length) {
      if (!wantsCode) continue;
      const entry = { id: test.id, title: test.title, reason: 'test ticket has no matching build ticket for the code it tests' };
      rejected.push(entry);
      rejectedIds.add(test.id);
      continue;
    }
    const targetStage = modules.reduce((best, module) => (stageRank(module.stage) > stageRank(best) ? module.stage : best), modules[0].stage);
    if (stageRank(test.stage) > stageRank(targetStage)) {
      test.stage = targetStage;
      notes.push(`moved ${test.id} into stage ${targetStage} with the code it tests`);
    }
    const newIds = new Set(added.map(ticket => ticket.id));
    const waitable = modules.filter(m => m.id !== test.id && (newIds.has(m.id) || m.status !== 'done'));
    for (const module of waitable) {
      if (!(test.dependsOn ?? []).includes(module.id)) test.dependsOn = [...(test.dependsOn ?? []), module.id];
    }
  }
  return added.filter(ticket => !rejectedIds.has(ticket.id));
}

function outputsReachableFrom(ticketId, byId, seen = new Set()) {
  if (seen.has(ticketId)) return new Set();
  seen.add(ticketId);
  const ticket = byId.get(ticketId);
  if (!ticket) return new Set();
  const out = ticketOutputs(ticket);
  for (const dep of ticket.dependsOn ?? []) for (const file of outputsReachableFrom(dep, byId, seen)) out.add(file);
  return out;
}

// Drop context paths that name another ticket's output without a dependsOn chain; keep repo files and dependsOn outputs.
export function reconcileTicketContext(tickets, repoFiles, notes = []) {
  const repo = new Set(repoFiles);
  const byId = new Map(tickets.map(ticket => [ticket.id, ticket]));
  const batchOutputs = new Set();
  for (const ticket of tickets) for (const file of ticketOutputs(ticket)) batchOutputs.add(file);
  for (const ticket of tickets) {
    if (ticket.type === 'human') continue;
    const reachable = outputsReachableFrom(ticket.id, byId);
    const kept = [];
    for (const entry of ticket.context ?? []) {
      if (repo.has(entry)) { kept.push(entry); continue; }
      if (reachable.has(entry)) { kept.push(entry); continue; }
      const droppable = batchOutputs.has(entry)
        || (/\.[A-Za-z0-9]+$/.test(entry) && !/^docs\//.test(entry) && !entry.endsWith('.md'));
      if (droppable) {
        notes.push(`dropped context ${entry}: it does not exist yet and no earlier ticket creates it`);
        continue;
      }
      kept.push(entry);
    }
    ticket.context = kept;
  }
}

export function peelProtectedOutputs(tickets, profile, { notes = [], allocId }) {
  const extra = [];
  for (const ticket of tickets) {
    if (ticket.type === 'human') continue;
    const kept = [];
    for (const file of ticket.files ?? []) {
      if (protectedPathHit(profile, file)) {
        const humanId = allocId();
        const reason = ticket.title?.trim() || 'ticket scope';
        extra.push({
          id: humanId,
          title: `Owner commit window: edit ${file} (${reason})`,
          type: 'human',
          stage: ticket.stage,
          epic: ticket.epic ?? 'E-00',
          scopeRefs: [],
          acceptance: [],
          files: [file],
          context: [],
          contracts: [],
          tests: [],
          dependsOn: [],
          steps: [`Edit ${file} as required for: ${reason}`],
          size: 'S',
          risk: 'low',
          sensitive: false,
          status: 'todo',
        });
        ticket.dependsOn = [...new Set([...(ticket.dependsOn ?? []), humanId])];
        notes.push(`${ticket.id}: removed protected output ${file}; ${humanId} is the owner commit window`);
      } else kept.push(file);
    }
    ticket.files = kept;
  }
  return extra;
}

export function cascadeRejectedDependents(tickets, rejected) {
  const rejectedIds = new Set(rejected.map(entry => entry.id));
  let changed = true;
  while (changed) {
    changed = false;
    for (const ticket of tickets) {
      if (rejectedIds.has(ticket.id)) continue;
      const dependency = (ticket.dependsOn ?? []).find(id => rejectedIds.has(id));
      if (!dependency) continue;
      rejected.push({ id: ticket.id, title: ticket.title, reason: `depends on rejected ${dependency}` });
      rejectedIds.add(ticket.id);
      changed = true;
    }
  }
  rejected.sort((a, b) => Number(a.id.slice(2)) - Number(b.id.slice(2)));
  return tickets.filter(ticket => !rejectedIds.has(ticket.id));
}
