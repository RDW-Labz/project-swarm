// SPDX-License-Identifier: Apache-2.0
// R-033 / T-0157: required attribution must appear in every file where licensed data is shown.
// The `data-source-attribution` swarm check (argv below) reads profile/manifest dataSources and
// scans each declared shownIn path for the source's attribution text.

import fs from 'node:fs/promises';
import path from 'node:path';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  attributionObligations,
  evaluateDataSourceLicence,
  isSwarmScratchPath,
  shouldSkipDataSourceLicenceCheck,
} from './data-source-licence.mjs';

/** Default coordination/checks.json entry for R-033 attribution enforcement (T-0159 may register it). */
export const DATA_SOURCE_ATTRIBUTION_SWARM_CHECK = Object.freeze({
  name: 'data-source-attribution',
  requirement: 'R-033',
  argv: ['node', 'tools/attribution-check.mjs', 'check'],
});

/**
 * For each attribution-required source, verify declared shownIn files contain the attribution text.
 * Returns violation records (empty when every obligation is satisfied).
 */
export async function attributionPresenceViolations({ root, sources = [] } = {}) {
  const resolvedRoot = path.resolve(root ?? process.cwd());
  const obligations = attributionObligations(sources);
  const violations = [];

  for (const entry of obligations) {
    const attribution = typeof entry.attribution === 'string' ? entry.attribution.trim() : '';
    if (!attribution) {
      violations.push({ id: entry.id, path: null, reason: 'missing attribution text in metadata' });
      continue;
    }
    const shownIn = Array.isArray(entry.shownIn) ? entry.shownIn : [];
    if (!shownIn.length) {
      violations.push({
        id: entry.id,
        path: null,
        reason: 'shownIn must list repo paths where this data is shown',
      });
      continue;
    }
    for (const rel of shownIn) {
      if (isSwarmScratchPath(rel)) continue;
      const abs = path.join(resolvedRoot, rel);
      let content;
      try {
        content = await fs.readFile(abs, 'utf8');
      } catch {
        violations.push({ id: entry.id, path: rel, reason: 'file not found or unreadable' });
        continue;
      }
      if (!content.includes(attribution)) {
        violations.push({ id: entry.id, path: rel, reason: 'required attribution text not present' });
      }
    }
  }
  return violations;
}

function formatViolation(v) {
  return v.path ? `${v.id}@${v.path}: ${v.reason}` : `${v.id}: ${v.reason}`;
}

/**
 * R-033 swarm check: refuse when metadata is invalid or attribution text is missing from a shownIn file.
 * Skips scratch worktrees (orchestrator copies) so checks do not fire on ephemeral paths.
 */
export async function runDataSourceAttributionSwarmCheck({
  root = process.cwd(),
  profile = null,
  manifest = null,
  skipScratch = true,
} = {}) {
  const resolvedRoot = path.resolve(root);
  if (skipScratch && shouldSkipDataSourceLicenceCheck(resolvedRoot)) {
    return { ok: true, skipped: true, reason: 'scratch-root' };
  }
  const result = evaluateDataSourceLicence({ profile, manifest });
  if (!result.ok) {
    const message = [
      ...result.errors,
      ...result.violations.map(v => `${v.id ?? 'source'}: ${v.reason} (${v.licence})`),
    ].join('; ');
    return { ok: false, skipped: false, ...result, message };
  }
  const fileViolations = await attributionPresenceViolations({ root: resolvedRoot, sources: result.sources });
  if (!fileViolations.length) {
    return { ok: true, skipped: false, ...result, fileViolations: [] };
  }
  return {
    ok: false,
    skipped: false,
    ...result,
    fileViolations,
    message: fileViolations.map(formatViolation).join('; '),
  };
}

export async function dataSourceAttributionShipGate({ profile, manifest, root = process.cwd() }) {
  const result = evaluateDataSourceLicence({ profile, manifest });
  if (!result.ok) {
    const parts = [
      ...result.errors.slice(0, 3),
      ...result.violations.slice(0, 3).map(v => `${v.id}: ${v.reason}`),
    ];
    return { message: `data-source-attribution: ${parts.join('; ')}` };
  }
  const violations = await attributionPresenceViolations({ root, sources: result.sources });
  if (!violations.length) return null;
  return { message: `data-source-attribution: ${violations.slice(0, 3).map(formatViolation).join('; ')}` };
}

async function readJsonFile(file) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

function parseArgs(argv) {
  const out = { root: process.cwd(), manifestPath: null, command: null };
  const rest = [...argv];
  out.command = rest.shift() ?? null;
  while (rest.length) {
    const token = rest.shift();
    if (token === '--root' && rest[0]) out.root = path.resolve(rest.shift());
    else if (token === '--manifest' && rest[0]) out.manifestPath = path.resolve(rest.shift());
  }
  return out;
}

async function runCli(argv) {
  const { command, root, manifestPath } = parseArgs(argv);
  if (command !== 'check') {
    process.stderr.write('usage: node tools/attribution-check.mjs check [--root DIR] [--manifest PATH]\n');
    process.exitCode = 2;
    return;
  }
  const pointer = await readJsonFile(path.join(root, '.project-swarm.json'));
  const profile = pointer?.profile ?? null;
  const manifest = manifestPath ? await readJsonFile(manifestPath) : null;
  const result = await runDataSourceAttributionSwarmCheck({ root, profile, manifest });
  if (result.skipped) {
    process.stdout.write(JSON.stringify({ status: 'skipped', reason: result.reason }) + '\n');
    return;
  }
  if (result.ok) {
    const obligations = attributionObligations(result.sources ?? []);
    process.stdout.write(
      JSON.stringify({ status: 'ok', obligations: obligations.length, sources: (result.sources ?? []).length }) + '\n',
    );
    return;
  }
  process.stderr.write(
    JSON.stringify({
      status: 'failed',
      error: result.message,
      errors: result.errors,
      violations: result.fileViolations ?? result.violations,
    }) + '\n',
  );
  process.exitCode = 1;
}

const isMain = process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  runCli(process.argv.slice(2)).catch(error => {
    process.stderr.write(`${error?.message ?? error}\n`);
    process.exitCode = 1;
  });
}
