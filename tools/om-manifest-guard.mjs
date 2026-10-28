// SPDX-License-Identifier: Apache-2.0
// Synchronous vetting of swarm run/go manifest files for orchestrator-mode shell guard.
import fs from 'node:fs';
import path from 'node:path';
import { OM_SWARM_RUN_FLAGS } from './orchestrator-allow.mjs';
import { managedChecks, verifyJobFields } from './verify-config.mjs';
import { qualityCheckArgvsForProject } from './quality-checks.mjs';
import { isApproved, ledgerPath } from './tickets.mjs';

const OM_SWARM_RUN_FLAGS_WITH_VALUE = new Set([
  '--lane', '--ticket', '--job', '--run', '--worktree', '--jobs', '--max-jobs', '--max-waves',
]);

const OM_SWARM_INTEGRATE_APPROVE_MANIFEST = '--approve-manifest';

const CHECK_ENTRY_KEYS = new Set(['name', 'argv', 'affectedArgv', 'timeoutMs', 'repeat', 'base', 'cleanDirs']);
const PRE_CHECK_ENTRY_KEYS = new Set(['argv', 'name', 'timeoutMs']);

const omSwarmJobsValueOk = val => {
  const parts = String(val ?? '').split(',');
  if (!parts.length || parts.some(p => !p || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(p))) return false;
  return true;
};

const omIntegrateApproveManifestPathOk = raw => {
  const s = String(raw ?? '');
  if (!s || path.isAbsolute(s) || s.startsWith('-') || s.startsWith('/') || s.startsWith('./')) return false;
  if (!/^[A-Za-z0-9_@+./-]+$/.test(s)) return false;
  const norm = path.posix.normalize(s.replace(/\\/g, '/'));
  if (!norm || norm.startsWith('../') || norm.includes('/../') || norm === '..') return false;
  return true;
};

const omSwarmRunIntegrateFlagStep = (sub, rest, i) => {
  const a = String(rest[i]);
  const low = a.toLowerCase();
  const eq = low.indexOf('=');
  const name = eq === -1 ? low : low.slice(0, eq);
  if (sub === 'integrate' && name === OM_SWARM_INTEGRATE_APPROVE_MANIFEST) {
    const val = eq !== -1 ? a.slice(a.indexOf('=') + 1) : String(rest[i + 1] ?? '');
    if (eq === -1 && i + 1 >= rest.length) return { ok: false };
    if (!omIntegrateApproveManifestPathOk(val)) return { ok: false };
    return { ok: true, next: eq === -1 ? i + 2 : i + 1 };
  }
  if (OM_SWARM_RUN_FLAGS.has(name) || OM_SWARM_RUN_FLAGS.has(a)) {
    if (OM_SWARM_RUN_FLAGS_WITH_VALUE.has(name)) {
      const val = eq !== -1 ? a.slice(a.indexOf('=') + 1) : String(rest[i + 1] ?? '');
      if (eq === -1 && i + 1 >= rest.length) return { ok: false };
      if (name === '--jobs' && !omSwarmJobsValueOk(val)) return { ok: false };
      return { ok: true, next: eq === -1 ? i + 2 : i + 1 };
    }
    return { ok: true, next: i + 1 };
  }
  if (a.startsWith('-')) return { ok: false };
  return { ok: true, next: i + 1, positional: a };
};

/** Positional manifest/run ids from swarm run or go argv (matches orchestrator-allow omSwarmRunLikePositionals). */
export function omSwarmRunGoPositionals(sub, rest) {
  const pos = [];
  let i = 0;
  while (i < rest.length) {
    const step = omSwarmRunIntegrateFlagStep(sub, rest, i);
    if (!step.ok) return null;
    if (step.positional !== undefined && step.positional !== '') pos.push(step.positional);
    i = step.next;
  }
  return pos;
}

const OM_SWARM_TICKET_VALUE_FLAGS = new Set([
  '--root', '--pr', '--repo', '--branch', '--commit-message', '--resume', '--check', '--require-section',
]);

const ticketFlagName = a => {
  const low = String(a).toLowerCase();
  const eq = low.indexOf('=');
  return eq === -1 ? low : low.slice(0, eq);
};

/** Non-flag argv words from `swarm ticket` (skips values for pipeline ticket flags; matches parseTicketArgs). */
export function omSwarmTicketPositionals(rest) {
  const pos = [];
  let i = 0;
  while (i < rest.length) {
    const a = String(rest[i]);
    if (!a.startsWith('-')) {
      pos.push(a);
      i += 1;
      continue;
    }
    const name = ticketFlagName(a);
    if (name === '--wait-required-only' || name === '-h' || name === '--help') {
      i += 1;
      continue;
    }
    if (OM_SWARM_TICKET_VALUE_FLAGS.has(name)) {
      const eq = a.indexOf('=');
      if (eq !== -1) {
        i += 1;
        continue;
      }
      if (i + 1 >= rest.length) return null;
      i += 2;
      continue;
    }
    if (a.startsWith('-')) return null;
    i += 1;
  }
  return pos;
}

const argvStrings = raw => {
  if (!Array.isArray(raw)) return null;
  if (!raw.every(el => typeof el === 'string' || typeof el === 'number' || typeof el === 'boolean')) return null;
  return raw.map(el => String(el));
};

const argvEqual = (a, b) => {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
};

const isVettedArgv = (argv, vetted) => vetted.some(v => argvEqual(argv, v));

const NOT_VETTED_MSG = 'is not a vetted command from coordination/checks.json or the profile verify command';

/** True when a swarm run/go/ticket positional names a manifest file path (not a bare run id). */
export function omSwarmManifestArgLooksLikeFile(raw) {
  const s = String(raw ?? '');
  if (s.includes('/') || s.includes('\\')) return true;
  if (s.includes('.')) return true;
  return false;
}

const resolveManifestRel = (root, manifestArg) => {
  const s = String(manifestArg ?? '');
  if (!s || path.isAbsolute(s) || s.startsWith('-')) {
    return { ok: false, reason: 'manifest path must be relative to the project root' };
  }
  const norm = path.posix.normalize(s.replace(/\\/g, '/')).replace(/^\.\//, '');
  if (!norm || norm === '..' || norm.startsWith('../') || norm.includes('/../')) {
    return { ok: false, reason: 'manifest path must stay inside the project root' };
  }
  if (norm.split('/').some(p => p === '..')) {
    return { ok: false, reason: 'manifest path must stay inside the project root' };
  }
  let rootReal;
  try {
    rootReal = fs.realpathSync.native(root);
  } catch {
    return { ok: false, reason: 'manifest path could not be resolved under the project root' };
  }
  const candidate = path.join(rootReal, ...norm.split('/'));
  let resolved;
  try {
    resolved = fs.realpathSync.native(candidate);
  } catch {
    return { ok: true, missing: true, rel: norm };
  }
  const rel = path.relative(rootReal, resolved);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    return { ok: false, reason: 'manifest path must stay inside the project root' };
  }
  return { ok: true, missing: false, filePath: resolved, rel: norm };
};

const pushVettedArgv = (vetted, raw) => {
  const argv = argvStrings(raw);
  if (argv) vetted.push(argv);
};

const loadProfile = root => {
  try {
    const pointer = JSON.parse(fs.readFileSync(path.join(root, '.project-swarm.json'), 'utf8'));
    return pointer?.profile ?? {};
  } catch {
    return {};
  }
};

const readLedgerSync = root => {
  try {
    return JSON.parse(fs.readFileSync(ledgerPath(root), 'utf8'));
  } catch {
    return null;
  }
};

const setupArgvEqual = (a, b) => {
  if (a === undefined && b === undefined) return true;
  if (a === undefined || b === undefined) return false;
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    const rowA = a[i];
    const rowB = b[i];
    if (!Array.isArray(rowA) || !Array.isArray(rowB)) return false;
    if (!argvEqual(rowA.map(String), rowB.map(String))) return false;
  }
  return true;
};

const testEnvEqual = (a, b) => {
  if (a === undefined && b === undefined) return true;
  if (a === undefined || b === undefined) return false;
  if (typeof a !== 'object' || typeof b !== 'object' || Array.isArray(a) || Array.isArray(b)) return false;
  const keysA = Object.keys(a).sort();
  const keysB = Object.keys(b).sort();
  if (keysA.length !== keysB.length) return false;
  for (let i = 0; i < keysA.length; i += 1) {
    if (keysA[i] !== keysB[i]) return false;
    if (String(a[keysA[i]]) !== String(b[keysB[i]])) return false;
  }
  return true;
};

const jobMatchesVerifyJobFields = (job, expected) => {
  if (String(job.agent ?? '') !== String(expected.agent ?? '')) return false;
  if (String(job.model ?? '') !== String(expected.model ?? '')) return false;
  if ((job.shell === true) !== (expected.shell === true)) return false;
  if (Number(job.timeoutMs) !== Number(expected.timeoutMs)) return false;
  if (!setupArgvEqual(job.setup, expected.setup)) return false;
  if (!testEnvEqual(job.testEnv, expected.testEnv)) return false;
  return true;
};

/** Shell / -shell jobs allowed only when they exactly match verifyJobFields for an approved ledger ticket. */
const isApprovedVerifyShellJob = (root, job) => {
  const jobId = String(job?.id ?? '');
  if (!jobId || !root) return false;
  const ledger = readLedgerSync(root);
  if (!ledger || !isApproved(ledger)) return false;
  const ticket = (ledger.tickets ?? []).find(t => t.id === jobId);
  if (!ticket) return false;
  const profile = loadProfile(root);
  const expected = verifyJobFields(ticket, profile.verify);
  if (!expected) return false;
  return jobMatchesVerifyJobFields(job, expected);
};

export const loadVettedArgvs = root => {
  const vetted = [];
  try {
    const text = fs.readFileSync(path.join(root, 'coordination/checks.json'), 'utf8');
    const data = JSON.parse(text);
    const checks = data?.checks;
    if (Array.isArray(checks)) {
      for (const entry of checks) {
        pushVettedArgv(vetted, entry?.argv);
      }
    }
  } catch { /* empty vetted list */ }

  const profile = loadProfile(root);
  const verify = profile?.verify;
  if (verify && typeof verify === 'object' && !Array.isArray(verify)) {
    pushVettedArgv(vetted, verify.command);
    const setup = verify.setup ?? [];
    if (Array.isArray(setup)) {
      for (const entry of setup) {
        if (Array.isArray(entry)) pushVettedArgv(vetted, entry);
        else if (entry && typeof entry === 'object' && !Array.isArray(entry)) pushVettedArgv(vetted, entry.argv);
      }
    }
    const managed = managedChecks(verify);
    for (const check of managed.checks) {
      pushVettedArgv(vetted, check.argv);
      if (check.affectedArgv) pushVettedArgv(vetted, check.affectedArgv);
    }
    for (const argv of managed.preChecks) pushVettedArgv(vetted, argv);
  }

  for (const argv of qualityCheckArgvsForProject(root, profile)) {
    pushVettedArgv(vetted, argv);
  }

  return vetted;
};

const validateCleanDirs = (entry, fieldLabel, checkName, errors) => {
  if (entry.cleanDirs === undefined) return true;
  if (checkName !== 'typecheck') {
    errors.push(`${fieldLabel} cleanDirs is only allowed on typecheck`);
    return false;
  }
  if (
    !Array.isArray(entry.cleanDirs)
    || entry.cleanDirs.length !== 1
    || entry.cleanDirs[0] !== '.next/types'
  ) {
    errors.push(`${fieldLabel} cleanDirs must be exactly [".next/types"]`);
    return false;
  }
  return true;
};

const collectChecksEntries = (checks, fieldLabel, out, errors) => {
  if (checks === undefined) return;
  if (!Array.isArray(checks)) {
    errors.push(`unrecognized shape for ${fieldLabel}`);
    return;
  }
  for (const entry of checks) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      errors.push(`unrecognized shape for ${fieldLabel}`);
      return;
    }
    for (const key of Object.keys(entry)) {
      if (!CHECK_ENTRY_KEYS.has(key)) {
        errors.push(`${fieldLabel} entry has unknown key ${key}`);
        return;
      }
    }
    if (!('argv' in entry)) {
      errors.push(`unrecognized shape for ${fieldLabel}`);
      return;
    }
    const argv = argvStrings(entry.argv);
    if (!argv) {
      errors.push(`unrecognized shape for ${fieldLabel}`);
      return;
    }
    const checkName = entry.name !== undefined ? String(entry.name) : '';
    if (!validateCleanDirs(entry, fieldLabel, checkName, errors)) return;
    out.push({ field: fieldLabel, argv });
    if (entry.affectedArgv !== undefined) {
      const affectedArgv = argvStrings(entry.affectedArgv);
      if (!affectedArgv) {
        errors.push(`unrecognized shape for ${fieldLabel}`);
        return;
      }
      out.push({ field: `${fieldLabel} affectedArgv`, argv: affectedArgv });
    }
  }
};

const collectPreChecksArgvs = (preChecks, fieldLabel, out, errors) => {
  if (preChecks === undefined) return;
  if (!Array.isArray(preChecks)) {
    errors.push(`unrecognized shape for ${fieldLabel}`);
    return;
  }
  for (const entry of preChecks) {
    if (Array.isArray(entry)) {
      const argv = argvStrings(entry);
      if (!argv) {
        errors.push(`unrecognized shape for ${fieldLabel}`);
        return;
      }
      out.push({ field: fieldLabel, argv });
      continue;
    }
    if (!entry || typeof entry !== 'object') {
      errors.push(`unrecognized shape for ${fieldLabel}`);
      return;
    }
    for (const key of Object.keys(entry)) {
      if (!PRE_CHECK_ENTRY_KEYS.has(key)) {
        errors.push(`${fieldLabel} entry has unknown key ${key}`);
        return;
      }
    }
    if (!('argv' in entry)) {
      errors.push(`unrecognized shape for ${fieldLabel}`);
      return;
    }
    const argv = argvStrings(entry.argv);
    if (!argv) {
      errors.push(`unrecognized shape for ${fieldLabel}`);
      return;
    }
    out.push({ field: fieldLabel, argv });
  }
};

const collectSetupArgvs = (setup, fieldLabel, out, errors) => {
  if (setup === undefined) return;
  if (!Array.isArray(setup)) {
    errors.push(`unrecognized shape for ${fieldLabel}`);
    return;
  }
  for (const entry of setup) {
    if (Array.isArray(entry)) {
      const argv = argvStrings(entry);
      if (!argv) {
        errors.push(`unrecognized shape for ${fieldLabel}`);
        return;
      }
      out.push({ field: fieldLabel, argv });
    } else if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
      if (Object.keys(entry).length !== 1 || !('argv' in entry)) {
        errors.push(`unrecognized shape for ${fieldLabel}`);
        return;
      }
      const argv = argvStrings(entry.argv);
      if (!argv) {
        errors.push(`unrecognized shape for ${fieldLabel}`);
        return;
      }
      out.push({ field: fieldLabel, argv });
    } else {
      errors.push(`unrecognized shape for ${fieldLabel}`);
      return;
    }
  }
};

const collectMutantCheck = (mutantCheck, fieldLabel, out, errors) => {
  if (mutantCheck === undefined) return;
  if (Array.isArray(mutantCheck)) {
    const argv = argvStrings(mutantCheck);
    if (!argv) {
      errors.push(`unrecognized shape for ${fieldLabel}`);
      return;
    }
    out.push({ field: fieldLabel, argv });
    return;
  }
  if (mutantCheck && typeof mutantCheck === 'object' && !Array.isArray(mutantCheck)) {
    if (Object.keys(mutantCheck).length !== 1 || !('argv' in mutantCheck)) {
      errors.push(`unrecognized shape for ${fieldLabel}`);
      return;
    }
    const argv = argvStrings(mutantCheck.argv);
    if (!argv) {
      errors.push(`unrecognized shape for ${fieldLabel}`);
      return;
    }
    out.push({ field: fieldLabel, argv });
    return;
  }
  errors.push(`unrecognized shape for ${fieldLabel}`);
};

const vetJobs = (jobs, out, errors, root) => {
  if (jobs === undefined) return;
  if (!Array.isArray(jobs)) {
    errors.push('unrecognized shape for jobs');
    return;
  }
  for (const job of jobs) {
    if (!job || typeof job !== 'object' || Array.isArray(job)) {
      errors.push('unrecognized shape for jobs');
      return;
    }
    const jobId = String(job.id ?? 'unknown');
    const shellish = job.shell === true
      || (job.model !== undefined && job.model !== null && String(job.model).endsWith('-shell'));
    const approvedVerifyShell = shellish && isApprovedVerifyShellJob(root, job);
    if (shellish && !approvedVerifyShell) {
      if (job.shell === true) {
        errors.push(`job ${jobId} has shell: true`);
        continue;
      }
      const model = String(job.model);
      errors.push(`job ${jobId} uses model ${model}`);
      continue;
    }
    collectChecksEntries(job.checks, `jobs[].${jobId}.checks`, out, errors);
    if (!approvedVerifyShell) {
      collectSetupArgvs(job.setup, `jobs[].${jobId}.setup`, out, errors);
    }
    collectPreChecksArgvs(job.preChecks, `jobs[].${jobId}.preChecks`, out, errors);
    collectMutantCheck(job.mutantCheck, `jobs[].${jobId}.mutantCheck`, out, errors);
  }
};

const vetManifestBody = (manifest, vetted, root) => {
  const errors = [];
  const collected = [];
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    return { ok: false, reason: 'manifest is not a JSON object' };
  }
  collectChecksEntries(manifest.checks, 'checks', collected, errors);
  collectSetupArgvs(manifest.setup, 'setup', collected, errors);
  collectPreChecksArgvs(manifest.preChecks, 'preChecks', collected, errors);
  collectMutantCheck(manifest.mutantCheck, 'mutantCheck', collected, errors);
  vetJobs(manifest.jobs, collected, errors, root);
  if (errors.length) {
    const reason = errors[0];
    if (reason.includes('shell: true') || reason.includes('-shell')) return { ok: false, reason };
    return { ok: false, reason };
  }
  for (const { field, argv } of collected) {
    if (!isVettedArgv(argv, vetted)) {
      return {
        ok: false,
        reason: `${field} argv ${JSON.stringify(argv)} ${NOT_VETTED_MSG}`,
      };
    }
  }
  return { ok: true, reason: '' };
};

/**
 * @param {string} root project root
 * @param {string} manifestArg positional from `swarm run` / `swarm go`
 * @returns {{ ok: boolean, reason: string }}
 */
export function omRunManifestVetted(root, manifestArg) {
  if (!root) {
    const s = String(manifestArg ?? '');
    if (s.toLowerCase().endsWith('.json')) {
      return { ok: false, reason: 'manifest path requires a project root' };
    }
    return { ok: true, reason: '' };
  }
  const resolved = resolveManifestRel(root, manifestArg);
  if (!resolved.ok) return { ok: false, reason: resolved.reason };
  if (resolved.missing) {
    if (omSwarmManifestArgLooksLikeFile(manifestArg)) {
      return { ok: false, reason: 'manifest file does not exist' };
    }
    return { ok: true, reason: '' };
  }
  let text;
  try {
    text = fs.readFileSync(resolved.filePath, 'utf8');
  } catch {
    return { ok: false, reason: 'manifest could not be read' };
  }
  let manifest;
  try {
    manifest = JSON.parse(text);
  } catch {
    return { ok: false, reason: 'manifest is not valid JSON' };
  }
  const vetted = loadVettedArgvs(root);
  return vetManifestBody(manifest, vetted, root);
}

/**
 * Runner-side orchestrator manifest vetting (parsed object). No-op outside Claude Code with orchestrator hook.
 * @param {string} root
 * @param {object} manifest parsed manifest
 * @param {NodeJS.ProcessEnv} [env]
 */
export async function orchestratorManifestGate(root, manifest, env = process.env) {
  if (env?.CLAUDECODE !== '1') return;
  const { orchestratorModeEnabled } = await import('./shell-writes.mjs');
  if (!orchestratorModeEnabled(root)) return;
  const { orchestratorHookInstalledFor } = await import('./orchestrator-hook.mjs');
  if (!orchestratorHookInstalledFor(root)) return;
  const vetted = loadVettedArgvs(root);
  const result = vetManifestBody(manifest, vetted, root);
  if (!result.ok) {
    const err = new Error(result.reason);
    err.code = 'orchestrator-manifest-unvetted';
    throw err;
  }
}
