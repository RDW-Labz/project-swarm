// SPDX-License-Identifier: Apache-2.0
// Data-source licence metadata on project profiles and run manifests (R-033 / T-0155).
// Each declared source carries its licence; non-commercial licences are incompatible with paid products.
// The `data-source-licence` swarm check (argv below) blocks paid builds when NC sources are declared.

import fs from 'node:fs/promises';
import path from 'node:path';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { isScratchRoot } from './projects.mjs';

export const DATA_SOURCE_ID_RE = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;
export const DATA_SOURCE_PRODUCT_TIERS = Object.freeze(['free', 'paid', 'internal']);
export const DEFAULT_DATA_SOURCE_PRODUCT = 'free';
export const PROFILE_DATA_SOURCES_KEY = 'dataSources';
export const MANIFEST_DATA_SOURCES_KEY = 'dataSources';

/** Default coordination/checks.json entry for R-033 paid-product licence enforcement (T-0156 may add it). */
export const DATA_SOURCE_LICENCE_SWARM_CHECK = Object.freeze({
  name: 'data-source-licence',
  requirement: 'R-033',
  argv: ['node', 'tools/data-source-licence.mjs', 'check'],
});

const MAX_PROFILE_SOURCES = 100;
const MAX_MANIFEST_SOURCES = 50;
const MAX_LICENCE_LEN = 120;
const MAX_ATTRIBUTION_LEN = 500;
const MAX_SHOWN_IN = 20;
const PATH_SEGMENT = /^[A-Za-z0-9._~%/-]{1,200}$/;
const SCRATCH_PATH_MARKERS = ['project-swarm-scratch', '/.swarm/scratch/', '/.swarm/worktrees/'];

const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const oneLine = (v, max) => typeof v === 'string' && v.length > 0 && v.length <= max && !/[\r\n\u0000-\u001f]/.test(v);

export function normalizeLicenceKey(licence) {
  return String(licence ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

// True when the licence text is a known non-commercial / NC variant (CC-BY-NC, etc.).
export function isNonCommercialLicence(licence) {
  if (typeof licence !== 'string' || !licence.trim()) return false;
  const key = normalizeLicenceKey(licence);
  if (!key) return false;
  if (key.includes('noncommercial') || key.includes('noncommercialuse') || key.includes('nconly')) return true;
  if (key.includes('ccbync') || (key.includes('bysa') && key.includes('nc'))) return true;
  if (/nc\d/.test(key) && (key.includes('cc') || key.includes('creativecommons'))) return true;
  return /-nc-?/i.test(licence) || /(?:^|[^a-z])nc(?:[^a-z]|$)/.test(key);
}

// True when the licence obliges visible attribution where the data is shown (CC-BY, ODbL, …; not CC0).
export function licenceRequiresAttribution(licence) {
  if (typeof licence !== 'string' || !licence.trim()) return false;
  const key = normalizeLicenceKey(licence);
  if (!key) return false;
  if (key === 'cc0' || key.startsWith('cc0') || key.includes('publicdomain') || key === 'unlicense' || key === '0bsd') return false;
  if (key.includes('odbl') || key.includes('opendatacommons')) return true;
  if (key.includes('ccby') || /ccbync/.test(key) || /ccbysa/.test(key)) return true;
  return /\bby\b/i.test(licence) && !/\bnc\b/i.test(licence.replace(/non[- ]?commercial/gi, ''));
}

export function paidProductAllowsLicence(licence, product = DEFAULT_DATA_SOURCE_PRODUCT) {
  if (product !== 'paid') return true;
  return !isNonCommercialLicence(licence);
}

export function isSwarmScratchPath(file) {
  const norm = String(file ?? '').split('\\').join('/').toLowerCase();
  if (!norm) return false;
  return SCRATCH_PATH_MARKERS.some(marker => norm.includes(marker));
}

export function shouldSkipDataSourceLicenceCheck(root) {
  const norm = String(root ?? '').split(path.sep).join('/');
  if (norm.includes('project-swarm-scratch')) return true;
  return isScratchRoot(root);
}

function repoPathOk(file) {
  if (typeof file !== 'string' || !file || file.startsWith('/') || file.includes('\\')) return false;
  if (isSwarmScratchPath(file)) return false;
  const parts = file.split('/');
  if (parts.some(part => part === '' || part === '.' || part === '..' || !PATH_SEGMENT.test(part))) return false;
  return file.length <= 200;
}

function normalizeSourceEntry(raw, label, errors) {
  if (!isObj(raw)) {
    errors.push(`${label}: must be an object`);
    return null;
  }
  for (const key of Object.keys(raw)) {
    if (!['id', 'name', 'licence', 'url', 'attribution', 'shownIn'].includes(key)) errors.push(`${label}.${key}: unknown key`);
  }
  const id = raw.id;
  if (typeof id !== 'string' || !DATA_SOURCE_ID_RE.test(id)) {
    errors.push(`${label}.id must be a lowercase id (letters, digits, hyphens)`);
    return null;
  }
  const licence = typeof raw.licence === 'string' ? raw.licence.trim() : '';
  if (!licence || licence.length > MAX_LICENCE_LEN) {
    errors.push(`${label}.licence must be a non-empty string of at most ${MAX_LICENCE_LEN} characters`);
    return null;
  }
  const out = { id, licence };
  if (raw.name !== undefined) {
    if (!oneLine(raw.name, 120)) errors.push(`${label}.name must be a short single-line string`);
    else out.name = raw.name.trim();
  }
  if (raw.url !== undefined) {
    const url = typeof raw.url === 'string' ? raw.url.trim() : '';
    if (!url.startsWith('https://') || url.length > 300) errors.push(`${label}.url must be an https URL`);
    else out.url = url;
  }
  if (raw.attribution !== undefined) {
    if (!oneLine(raw.attribution, MAX_ATTRIBUTION_LEN)) errors.push(`${label}.attribution must be a single-line string of at most ${MAX_ATTRIBUTION_LEN} characters`);
    else out.attribution = raw.attribution.trim();
  }
  if (licenceRequiresAttribution(licence) && !out.attribution) {
    errors.push(`${label}.attribution is required for licence ${licence}`);
  }
  if (raw.shownIn !== undefined) {
    if (!Array.isArray(raw.shownIn) || raw.shownIn.length > MAX_SHOWN_IN || !raw.shownIn.every(repoPathOk)) {
      errors.push(`${label}.shownIn must list at most ${MAX_SHOWN_IN} repo-relative paths where the data is shown`);
    } else out.shownIn = [...new Set(raw.shownIn.map(p => p.trim()))];
  }
  return out;
}

// profile.dataSources: { product?, sources: [...] }
export function validateDataSourcesConfig(raw) {
  const errors = [];
  if (raw === undefined || raw === null) return { ok: true, config: null, errors };
  if (!isObj(raw)) return { ok: false, config: null, errors: ['dataSources must be an object'] };
  for (const key of Object.keys(raw)) if (!['product', 'sources'].includes(key)) errors.push(`dataSources.${key}: unknown key`);
  const product = raw.product === undefined ? DEFAULT_DATA_SOURCE_PRODUCT : raw.product;
  if (!DATA_SOURCE_PRODUCT_TIERS.includes(product)) errors.push(`dataSources.product must be one of ${DATA_SOURCE_PRODUCT_TIERS.join(', ')}`);
  const list = raw.sources;
  if (!Array.isArray(list) || list.length > MAX_PROFILE_SOURCES) {
    errors.push(`dataSources.sources must be an array of at most ${MAX_PROFILE_SOURCES} entries`);
    return { ok: false, config: null, errors };
  }
  const sources = [];
  const seen = new Set();
  for (let i = 0; i < list.length; i++) {
    const entry = normalizeSourceEntry(list[i], `dataSources.sources[${i}]`, errors);
    if (!entry) continue;
    if (seen.has(entry.id)) errors.push(`dataSources.sources: duplicate id ${entry.id}`);
    else {
      seen.add(entry.id);
      sources.push(entry);
    }
  }
  if (product === 'paid') {
    for (const entry of sources) {
      if (!paidProductAllowsLicence(entry.licence, product)) {
        errors.push(`dataSources.sources: ${entry.id} uses non-commercial licence ${entry.licence}, which is not allowed for a paid product`);
      }
    }
  }
  if (errors.length) return { ok: false, config: null, errors };
  const config = { product, sources };
  return { ok: true, config, errors };
}

/** Called from validateProfile once profile.dataSources is a recognised profile key. */
export function applyDataSourcesProfileValidation(profile, errors, out) {
  if (profile?.[PROFILE_DATA_SOURCES_KEY] === undefined) return;
  const checked = validateDataSourcesConfig(profile[PROFILE_DATA_SOURCES_KEY]);
  for (const message of checked.errors) errors.push(`profile.${message}`);
  if (checked.ok && checked.config) out[PROFILE_DATA_SOURCES_KEY] = checked.config;
}

// manifest.dataSources: [{ id, licence, ... }] — licences are carried on the manifest for checks and workers.
export function validateManifestDataSources(raw, profileConfig = null) {
  const errors = [];
  if (raw === undefined || raw === null) return { ok: true, value: null, errors };
  if (!Array.isArray(raw) || raw.length > MAX_MANIFEST_SOURCES) {
    return { ok: false, value: null, errors: [`dataSources must be an array of at most ${MAX_MANIFEST_SOURCES} entries`] };
  }
  const profileById = new Map((profileConfig?.sources ?? []).map(entry => [entry.id, entry]));
  const product = profileConfig?.product ?? DEFAULT_DATA_SOURCE_PRODUCT;
  const value = [];
  const seen = new Set();
  for (let i = 0; i < raw.length; i++) {
    const profileEntry = profileById.get(raw[i]?.id);
    const merged = profileEntry ? { ...profileEntry, ...raw[i], licence: raw[i]?.licence ?? profileEntry.licence } : raw[i];
    const entry = normalizeSourceEntry(merged, `dataSources[${i}]`, errors);
    if (!entry) continue;
    if (seen.has(entry.id)) errors.push(`dataSources: duplicate id ${entry.id}`);
    else seen.add(entry.id);
    if (profileEntry && profileEntry.licence !== entry.licence) {
      errors.push(`dataSources[${i}].licence must match profile dataSources.sources for id ${entry.id}`);
    }
    if (!paidProductAllowsLicence(entry.licence, product)) {
      errors.push(`dataSources[${i}]: licence ${entry.licence} is not allowed for product tier ${product}`);
    }
    value.push(entry);
  }
  if (errors.length) return { ok: false, value: null, errors };
  return { ok: true, value, errors };
}

// Violations for swarm checks: non-commercial sources declared while the product is paid.
export function paidProductLicenceViolations({ product = DEFAULT_DATA_SOURCE_PRODUCT, sources = [] } = {}) {
  if (product !== 'paid') return [];
  const list = Array.isArray(sources) ? sources : [];
  const out = [];
  for (const entry of list) {
    if (!entry || typeof entry.licence !== 'string') continue;
    if (!paidProductAllowsLicence(entry.licence, product)) {
      out.push({ id: entry.id ?? null, licence: entry.licence, reason: 'non-commercial licence on a paid product' });
    }
  }
  return out;
}

// Attribution obligations from profile/manifest sources (for T-0157).
export function attributionObligations(sources = []) {
  const list = Array.isArray(sources) ? sources : [];
  return list
    .filter(entry => entry && licenceRequiresAttribution(entry.licence))
    .map(entry => ({
      id: entry.id,
      licence: entry.licence,
      attribution: entry.attribution ?? null,
      shownIn: Array.isArray(entry.shownIn) ? [...entry.shownIn] : [],
    }));
}

/** Validate profile + manifest dataSources and return whether a paid product may ship with the declared licences. */
export function evaluateDataSourceLicence({ profile = null, manifest = null } = {}) {
  const errors = [];
  let profileConfig = null;
  const profileBlock = profile?.[PROFILE_DATA_SOURCES_KEY];
  if (profileBlock !== undefined) {
    const checked = validateDataSourcesConfig(profileBlock);
    if (!checked.ok) errors.push(...checked.errors);
    else profileConfig = checked.config;
  }
  let manifestSources = null;
  const manifestBlock = manifest?.[MANIFEST_DATA_SOURCES_KEY];
  if (manifestBlock !== undefined) {
    const checked = validateManifestDataSources(manifestBlock, profileConfig);
    if (!checked.ok) errors.push(...checked.errors);
    else manifestSources = checked.value;
  }
  const product = profileConfig?.product ?? DEFAULT_DATA_SOURCE_PRODUCT;
  const sources = manifestSources ?? profileConfig?.sources ?? [];
  const violations = paidProductLicenceViolations({ product, sources });
  return {
    ok: errors.length === 0 && violations.length === 0,
    errors,
    violations,
    product,
    sources,
  };
}

/**
 * R-033 swarm check: refuse when metadata is invalid or a paid product declares a non-commercial source.
 * Skips scratch worktrees (orchestrator copies) so checks do not fire on ephemeral paths.
 */
export function runDataSourceLicenceSwarmCheck({ root = process.cwd(), profile = null, manifest = null, skipScratch = true } = {}) {
  const resolvedRoot = path.resolve(root);
  if (skipScratch && shouldSkipDataSourceLicenceCheck(resolvedRoot)) {
    return { ok: true, skipped: true, reason: 'scratch-root' };
  }
  const result = evaluateDataSourceLicence({ profile, manifest });
  if (result.ok) return { ok: true, skipped: false, ...result };
  const messages = [
    ...result.errors,
    ...result.violations.map(v => `${v.id ?? 'source'}: ${v.reason} (${v.licence})`),
  ];
  return { ok: false, skipped: false, ...result, message: messages.join('; ') };
}

export function dataSourceLicenceShipGate({ profile, manifest }) {
  const result = evaluateDataSourceLicence({ profile, manifest });
  if (result.ok) return null;
  const parts = [
    ...result.errors.slice(0, 3),
    ...result.violations.slice(0, 3).map(v => `${v.id}: ${v.reason}`),
  ];
  return { message: `data-source-licence: ${parts.join('; ')}` };
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
    process.stderr.write('usage: node tools/data-source-licence.mjs check [--root DIR] [--manifest PATH]\n');
    process.exitCode = 2;
    return;
  }
  const pointer = await readJsonFile(path.join(root, '.project-swarm.json'));
  const profile = pointer?.profile ?? null;
  const manifest = manifestPath ? await readJsonFile(manifestPath) : null;
  const result = runDataSourceLicenceSwarmCheck({ root, profile, manifest });
  if (result.skipped) {
    process.stdout.write(JSON.stringify({ status: 'skipped', reason: result.reason }) + '\n');
    return;
  }
  if (result.ok) {
    process.stdout.write(JSON.stringify({ status: 'ok', product: result.product, sources: (result.sources ?? []).length }) + '\n');
    return;
  }
  process.stderr.write(JSON.stringify({ status: 'failed', error: result.message, errors: result.errors, violations: result.violations }) + '\n');
  process.exitCode = 1;
}

const isMain = process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  runCli(process.argv.slice(2)).catch(error => {
    process.stderr.write(`${error?.message ?? error}\n`);
    process.exitCode = 1;
  });
}
