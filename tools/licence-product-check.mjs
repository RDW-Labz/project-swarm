// SPDX-License-Identifier: Apache-2.0
// R-033 / T-0156: swarm check entry — non-commercial data-source licences fail when the product is paid.
// Core licence rules live in data-source-licence.mjs; this module is what coordination/checks.json runs.

import fs from 'node:fs/promises';
import path from 'node:path';
import { existsSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  paidProductLicenceViolations,
  runDataSourceLicenceSwarmCheck,
  shouldSkipDataSourceLicenceCheck,
} from './data-source-licence.mjs';

/** Tools this check argv depends on (existence verified before any real work). */
export const LICENCE_PRODUCT_CHECK_DEPS = Object.freeze(['tools/data-source-licence.mjs']);

/** Default coordination/checks.json entry for R-033 paid-product licence enforcement (T-0156). */
export const LICENCE_PRODUCT_SWARM_CHECK = Object.freeze({
  name: 'licence-product',
  requirement: 'R-033',
  argv: ['node', 'tools/licence-product-check.mjs', 'check'],
});

export function licenceProductCheckPremises(root) {
  const resolved = path.resolve(root ?? '.');
  const missing = [];
  const found = [];
  for (const rel of LICENCE_PRODUCT_CHECK_DEPS) {
    const target = path.join(resolved, rel);
    if (existsSync(target)) found.push(rel);
    else missing.push(rel);
  }
  return { ok: missing.length === 0, root: resolved, found, missing };
}

/**
 * Paid-product licence gate for integrate/ship: null when ok, otherwise { message }.
 * Only enforces non-commercial licences on paid products (validation errors are separate).
 */
export function licenceProductShipGate({ profile, manifest } = {}) {
  const result = runDataSourceLicenceSwarmCheck({ profile, manifest, skipScratch: false });
  if (result.skipped) return null;
  const violations = paidProductLicenceViolations({
    product: result.product,
    sources: result.sources ?? [],
  });
  if (!violations.length) return null;
  const parts = violations.slice(0, 5).map(v => `${v.id ?? 'source'}: ${v.reason} (${v.licence})`);
  return { message: `licence-product: ${parts.join('; ')}` };
}

/**
 * R-033 swarm check: refuse when a paid product declares a non-commercial data-source licence.
 * Skips scratch worktrees (orchestrator copies).
 */
export function runLicenceProductSwarmCheck({ root = process.cwd(), profile = null, manifest = null, skipScratch = true } = {}) {
  const premises = licenceProductCheckPremises(root);
  if (!premises.ok) {
    return {
      ok: false,
      skipped: false,
      premiseFailed: true,
      found: premises.found,
      missing: premises.missing,
      message: `licence-product check missing dependency: ${premises.missing.join(', ')}`,
    };
  }
  const resolvedRoot = path.resolve(root);
  if (skipScratch && shouldSkipDataSourceLicenceCheck(resolvedRoot)) {
    return { ok: true, skipped: true, reason: 'scratch-root', found: premises.found };
  }
  const result = runDataSourceLicenceSwarmCheck({ root: resolvedRoot, profile, manifest, skipScratch: false });
  if (result.skipped) return { ok: true, skipped: true, reason: result.reason, found: premises.found };
  const violations = paidProductLicenceViolations({
    product: result.product,
    sources: result.sources ?? [],
  });
  if (result.errors?.length) {
    const messages = [...result.errors, ...violations.map(v => `${v.id ?? 'source'}: ${v.reason} (${v.licence})`)];
    return {
      ok: false,
      skipped: false,
      found: premises.found,
      product: result.product,
      sources: result.sources,
      errors: result.errors,
      violations,
      message: messages.join('; '),
    };
  }
  if (violations.length) {
    const messages = violations.map(v => `${v.id ?? 'source'}: ${v.reason} (${v.licence})`);
    return {
      ok: false,
      skipped: false,
      found: premises.found,
      product: result.product,
      sources: result.sources,
      errors: [],
      violations,
      message: messages.join('; '),
    };
  }
  return { ok: true, skipped: false, found: premises.found, product: result.product, sources: result.sources, violations: [] };
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
  if (command === 'premises') {
    const premises = licenceProductCheckPremises(root);
    process.stdout.write(JSON.stringify(premises) + '\n');
    process.exitCode = premises.ok ? 0 : 2;
    return;
  }
  if (command !== 'check') {
    process.stderr.write(
      'usage: node tools/licence-product-check.mjs check [--root DIR] [--manifest PATH]\n'
        + '       node tools/licence-product-check.mjs premises [--root DIR]\n',
    );
    process.exitCode = 2;
    return;
  }
  const premises = licenceProductCheckPremises(root);
  if (!premises.ok) {
    process.stderr.write(
      JSON.stringify({
        status: 'unrunnable',
        error: `licence-product check missing dependency: ${premises.missing.join(', ')}`,
        found: premises.found,
        missing: premises.missing,
      }) + '\n',
    );
    process.exitCode = 2;
    return;
  }
  const pointer = await readJsonFile(path.join(root, '.project-swarm.json'));
  const profile = pointer?.profile ?? null;
  const manifest = manifestPath ? await readJsonFile(manifestPath) : null;
  const result = runLicenceProductSwarmCheck({ root, profile, manifest });
  if (result.skipped) {
    process.stdout.write(JSON.stringify({ status: 'skipped', reason: result.reason, found: result.found }) + '\n');
    return;
  }
  if (result.ok) {
    process.stdout.write(
      JSON.stringify({
        status: 'ok',
        product: result.product,
        sources: (result.sources ?? []).length,
        found: result.found,
      }) + '\n',
    );
    return;
  }
  process.stderr.write(
    JSON.stringify({
      status: 'failed',
      error: result.message,
      errors: result.errors,
      violations: result.violations,
      found: result.found,
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
