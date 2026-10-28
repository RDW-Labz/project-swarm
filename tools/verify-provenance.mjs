// SPDX-License-Identifier: Apache-2.0
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readLedger, isApproved, DELIVERABLE_STATUSES } from './tickets.mjs';
import { ticketsToManifest } from './ticket-manifest.mjs';
import { readProfile, qualityFor, packageManagerOf, contextEnvFor } from './scope-commands.mjs';
import { parseScope, scopeHash } from './scope.mjs';
import { loadLocalConfig } from './local-config.mjs';

const canonical = value => {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().filter(key => value[key] !== undefined)
      .map(key => [key, canonical(value[key])]));
  }
  return value;
};

const firstDifference = (actual, expected, prefix = '') => {
  if (JSON.stringify(actual) === JSON.stringify(expected)) return null;
  if (actual && expected && typeof actual === 'object' && typeof expected === 'object'
      && Array.isArray(actual) === Array.isArray(expected)) {
    for (const key of [...new Set([...Object.keys(actual), ...Object.keys(expected)])].sort()) {
      const field = prefix ? `${prefix}.${key}` : key;
      if (!Object.hasOwn(actual, key) || !Object.hasOwn(expected, key)) return field;
      const difference = firstDifference(actual[key], expected[key], field);
      if (difference) return difference;
    }
  }
  return prefix || 'job';
};

const ownRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

/** Rebuild the whole wave, including dependency routing and lesson prompts.
 * The installRoot override is only for tests that isolate installed lessons.
 */
export async function verifyManifestProvenance(root, jobs, installRoot = ownRoot) {
  const results = new Map();
  const refuse = reason => {
    for (const job of jobs) if (!results.has(job)) results.set(job, { ok: false, reason });
    return results;
  };
  let ledger;
  try { ledger = await readLedger(root); }
  catch { return refuse('ticket ledger could not be read'); }
  if (!ledger) return refuse('ticket ledger is missing');
  try {
    if (!isApproved(ledger)) return refuse('ticket ledger is not approved');
    const ids = new Set(jobs.map(job => job?.id));
    const tickets = ledger.tickets.filter(ticket => ids.has(ticket.id)
      && DELIVERABLE_STATUSES.includes(ticket.status));
    for (const job of jobs) {
      const ticket = ledger.tickets.find(ticket => ticket.id === job?.id);
      if (!ticket) results.set(job, { ok: false, reason: 'job id is not a ticket in the ledger' });
      else if (!DELIVERABLE_STATUSES.includes(ticket.status)) {
        results.set(job, { ok: false, reason: `ticket status ${ticket.status} is not deliverable` });
      }
    }
    if (jobs.every(job => results.has(job))) return results;
    // Snapshot reading mirrors prepareScopeRun in scope-commands.mjs (its readText is private).
    let snapshot;
    try { snapshot = await fs.readFile(path.join(root, '.swarm', 'project', 'scope.snapshot.md'), 'utf8'); }
    catch { return refuse('approved scope snapshot could not be read'); }
    if (scopeHash(snapshot) !== ledger.scope?.hash) return refuse('approved scope snapshot does not match the ledger');
    const scope = parseScope(snapshot);
    const profile = await readProfile(root);
    let laneModels;
    try { laneModels = loadLocalConfig().lanes; } catch { /* same fallback as prepareScopeRun */ }
    const { loadLessonsForNotes } = await import('./lessons-commands.mjs');
    const lessons = await loadLessonsForNotes(root, installRoot);
    const { manifest } = ticketsToManifest(tickets, {
      ledger, scope, ready: false, lessons, verify: profile?.verify,
      quality: await qualityFor(root, profile), packageManager: packageManagerOf(profile),
      contextEnv: contextEnvFor(root, profile), laneModels,
    });
    const rebuiltById = new Map(manifest.jobs.map(job => [job.id, job]));
    for (const job of jobs) {
      if (results.has(job)) continue;
      const rebuilt = rebuiltById.get(job.id);
      let reason;
      if (!rebuilt) reason = 'ticket did not produce a job';
      else if (rebuilt.shell !== true && !String(rebuilt.model ?? '').endsWith('-shell')) reason = 'rebuilt ticket job is not a shell job';
      else {
        const difference = firstDifference(canonical(job), canonical(rebuilt));
        if (difference) reason = `job differs from approved ticket at ${difference}`;
      }
      results.set(job, reason ? { ok: false, reason } : { ok: true });
    }
    return results;
  } catch {
    return refuse('approved ticket job could not be rebuilt');
  }
}

/** Only the exact shell job rebuilt from the approved ticket may pass the runner gate. */
export async function verifyJobProvenance(root, job, installRoot = ownRoot) {
  return (await verifyManifestProvenance(root, [job], installRoot)).get(job);
}
