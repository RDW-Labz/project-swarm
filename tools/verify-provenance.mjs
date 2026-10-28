// SPDX-License-Identifier: Apache-2.0
import fs from 'node:fs/promises';
import path from 'node:path';
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

/** Only the exact shell job rebuilt from the approved ticket may pass the runner gate. */
export async function verifyJobProvenance(root, job) {
  const refuse = reason => ({ ok: false, reason });
  let ledger;
  try { ledger = await readLedger(root); }
  catch { return refuse('ticket ledger could not be read'); }
  if (!ledger) return refuse('ticket ledger is missing');
  try {
    if (!isApproved(ledger)) return refuse('ticket ledger is not approved');
    const ticket = ledger.tickets.find(ticket => ticket.id === job?.id);
    if (!ticket) return refuse('job id is not a ticket in the ledger');
    if (!DELIVERABLE_STATUSES.includes(ticket.status)) return refuse(`ticket status ${ticket.status} is not deliverable`);
    // Snapshot reading mirrors prepareScopeRun in scope-commands.mjs (its readText is private).
    let snapshot;
    try { snapshot = await fs.readFile(path.join(root, '.swarm', 'project', 'scope.snapshot.md'), 'utf8'); }
    catch { return refuse('approved scope snapshot could not be read'); }
    if (scopeHash(snapshot) !== ledger.scope?.hash) return refuse('approved scope snapshot does not match the ledger');
    const scope = parseScope(snapshot);
    const profile = await readProfile(root);
    let laneModels;
    try { laneModels = loadLocalConfig().lanes; } catch { /* same fallback as prepareScopeRun */ }
    const { manifest } = ticketsToManifest([ticket], {
      ledger, scope, ready: false, lessons: [], verify: profile?.verify,
      quality: await qualityFor(root, profile), packageManager: packageManagerOf(profile),
      contextEnv: contextEnvFor(root, profile), laneModels,
    });
    const rebuilt = manifest.jobs.find(candidate => candidate.id === job.id);
    if (!rebuilt) return refuse('ticket did not produce a job');
    if (rebuilt.shell !== true && !String(rebuilt.model ?? '').endsWith('-shell')) return refuse('rebuilt ticket job is not a shell job');
    const difference = firstDifference(canonical(job), canonical(rebuilt));
    if (difference) return refuse(`job differs from approved ticket at ${difference}`);
    return { ok: true };
  } catch {
    return refuse('approved ticket job could not be rebuilt');
  }
}
