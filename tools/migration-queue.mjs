// SPDX-License-Identifier: Apache-2.0
// The merge queue's migration check: runs after the batch is written to the tree and before its tests. Opt-in with a `migrations` block in the
// project profile (a project that never set one gets a note, not a block, so work in flight is not stopped by a new rule).
import fs from 'node:fs/promises';
import path from 'node:path';
import { checkMigrations, readApprovals, runRoundTrip, validateMigrationsConfig, MIGRATION_DEFAULTS } from './migration-gate.mjs';

// changes: [{file, bytes}] (bytes null = the file was deleted). Returns {blocks, notes, needsApproval}.
export async function migrationQueueCheck({ root, changes, profile, exec }) {
  const checked = validateMigrationsConfig(profile?.migrations ?? {});
  // A broken block blocks (it never silently falls back to the defaults).
  if (!checked.ok) return { blocks: [{ check: 'migration', severity: 'high', message: `profile.migrations is invalid: ${checked.errors.join('; ')}` }], notes: [], needsApproval: [] };
  const config = checked.config;
  // Up files and down files both count: an edit of a down file re-checks its migration.
  const touched = changes.filter(change => change.bytes !== null && (change.file.startsWith(`${config.dir}/`) || (config.downDir && change.file.startsWith(`${config.downDir}/`))) && /[.]sql$/i.test(change.file)).map(change => change.file);
  if (!touched.length) return { blocks: [], notes: [], needsApproval: [] };
  if (!profile?.migrations) {
    return { blocks: [], notes: [`migrations: ${touched.length} migration file(s) changed but the profile has no migrations block, so no down-step or destructive-change check ran (add "migrations": {} to the profile)`], needsApproval: [] };
  }
  // The bytes the batch is about to merge are the ones checked and hashed; other files (a down file) are read from the tree.
  const batch = new Map(changes.filter(change => change.bytes).map(change => [change.file, change.bytes]));
  const read = async file => batch.get(file) ?? fs.readFile(path.join(root, file));
  const exists = file => (batch.has(file) ? Promise.resolve(true) : fs.stat(path.join(root, file)).then(stat => stat.isFile(), () => false));
  let result;
  try {
    result = await checkMigrations({ files: touched, config, read, exists, approvals: await readApprovals(root) });
  } catch (error) {
    return { blocks: [{ check: 'migration', severity: 'high', message: `the migration check could not run: ${String(error?.message ?? error).slice(0, 200)}` }], notes: [], needsApproval: [] };
  }
  const blocks = result.problems.map(problem => ({ check: 'migration', severity: 'high', message: `${problem.check}: ${problem.message}` }));
  if (!blocks.length) {
    const trip = await runRoundTrip({ root, config, exec });
    const failed = trip.steps.find(step => !step.ok);
    if (failed) blocks.push({ check: 'migration', severity: 'high', message: `round trip failed at ${failed.name} (up, seed, down, up): ${failed.tail}` });
  }
  return { blocks, notes: [], needsApproval: result.needsApproval };
}

export { MIGRATION_DEFAULTS };
