// SPDX-License-Identifier: Apache-2.0
// Wiring: features built as modules are connected by an integration ticket per requirement (routes, pages, a route-level test).
// Pure functions; scope-commands.mjs calls them from split and ingest.

export const WIRING_PROMPT = [
  'Wiring rule: for every requirement that has build tickets, add ONE integration ticket (type build, "integration": true) that mounts those modules in the real routes, pages or entry points (for example src/app/.../page.tsx, a router file, an API route file) so a user can reach the feature.',
  'Its "tests" lists a route-level or end-to-end test that requests the real route or page and checks the result (not a unit test of one module); its acceptance names the route or page; its scopeRefs are the requirement ids; its files are the route and page files only.',
  'You do not need to list its dependsOn on the module tickets of the same requirement: the runner adds them. Two integration tickets that edit the same shared file (router, navigation, layout) are chained by the runner, the later one after the earlier.',
  'A requirement is done only when its integration ticket is done and its route-level test passed.',
].join('\n');

export const WIRE_ONLY_PROMPT = 'Write ONLY integration tickets (every ticket has "integration": true). The module tickets below already exist; do not repeat them.';

// A test path must look like a test: a test folder, a .test/.spec file, or a python/go test file. A page or module file is not a route-level test.
const TEST_DIR_RE = /(^|\/)(tests?|__tests__|e2e|spec|specs|cypress|playwright)\//i;
const TEST_FILE_RE = /\.(test|spec)\.[A-Za-z0-9]+$|(^|\/)test_[^/]+\.py$|_test\.(py|go)$/i;
export const looksLikeTestFile = p => typeof p === 'string' && (TEST_FILE_RE.test(p) || TEST_DIR_RE.test(p)) && !/\/$/.test(p);

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
