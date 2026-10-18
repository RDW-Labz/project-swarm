// SPDX-License-Identifier: Apache-2.0
import { validateApprovalPolicy } from './approval-policy.mjs';
import { validateCiConfig } from './ci-hooks.mjs';
import { validateVerifyConfig } from './verify-config.mjs';
import { validateUiConfig } from './ui-compare.mjs';
import { validateMigrationsConfig } from './migration-gate.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { sanitizeText } from './journal.mjs';

export const DEFAULT_PROFILE_BUDGET = Object.freeze({ maxUsd: 5, maxTokens: 2000000 });
const STATUSES = ['green', 'red', 'skipped', 'none'];
const PROFILE_KEYS = ['stack', 'sensitive', 'protectedPaths', 'budget', 'baseCheck', 'security', 'approval', 'ci', 'verify', 'context', 'ui', 'quality', 'migrations', 'acceptance'];
const REQUIRED_KEYS = ['sensitive', 'protectedPaths', 'budget', 'baseCheck'];
const BASE_KEYS = ['status', 'ranAt', 'head', 'checks'];
// The pointer (profile) and the checks file decide what later runs may do and execute, so no job may rewrite them.
const ALWAYS_PROTECTED = ['.git/', '.swarm/', '.project-swarm.json', 'coordination/checks.json'];
const SECRET_FOLDERS = ['secrets', 'credentials', '.ssh', '.aws', '.gnupg', 'private', 'keys'];
const SECRET_EXTENSIONS = ['.pem', '.key', '.p12', '.pfx', '.keystore'];
const SECRET_NAMES = ['id_rsa', 'id_ed25519', 'credentials.json', 'serviceaccount.json', '.envrc', '.npmrc', '.netrc', '.pypirc'];
const GLOB_CHARS = ['*', '?', '[', ']', '{', '}'];

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const lastChars = (text, count) => [...String(text).slice(-count * 4)].slice(-count).join('');
const oneLine = text => [...sanitizeText(String(text)).replace(/[\r\n\u0080-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, ' ')].slice(0, 159).join('');
const item = (id, level, message) => ({ id, level, message: oneLine(message) });
async function quiet(fn) { try { return await fn(); } catch { return null; } }
async function defaultReadText(file) { return fs.readFile(file, 'utf8'); }

function secretEntries(file) {
  const parts = file.split('/');
  const name = parts[parts.length - 1];
  const lower = name.toLowerCase();
  const found = [];
  if (lower === '.env' || lower.startsWith('.env.')) found.push(file);
  if (SECRET_EXTENSIONS.includes(path.extname(lower)) || SECRET_NAMES.includes(lower)) found.push(file);
  parts.slice(0, -1).forEach((part, index) => {
    if (SECRET_FOLDERS.includes(part.toLowerCase())) found.push(`${parts.slice(0, index + 1).join('/')}/`);
  });
  return found;
}

// A template that holds names, not values (.env.example, .env.sample, config.example.json, terraform.tfvars.example): safe to READ as context.
// It is still protected from writes, and a file that merely sits next to a secret is not an example.
export function isExampleFile(file) {
  const name = String(file).split('\\').join('/').split('/').pop().toLowerCase();
  return /^\.env(?:\.[a-z0-9_-]+)*\.(?:example|sample|template|dist)$/.test(name) || /^[a-z0-9_.-]+\.(?:example|sample|template)(?:\.[a-z0-9]+)?$|^[a-z0-9_.-]+\.(?:example|sample|template)$/.test(name) && !/^\.env/.test(name) && !/(?:^|[._-])(?:id_rsa|id_dsa|id_ed25519|credentials|secrets?)(?:[._-]|$)/.test(name);
}

// True when a repo path names a secret: any .env file (env.example.txt is a template and is fine), keys, certificates, secret folders.
export function isSecretPath(file) {
  const parts = String(file).split('\\').join('/').split('/');
  if (parts.some(part => /^\.env(?:$|\.)/i.test(part))) return true;
  return secretEntries(parts.join('/')).length > 0;
}

export async function detectProtectedPaths(root, { list }) {
  const found = new Set();
  for (const raw of await list(root)) {
    const file = String(raw).split('\\').join('/');
    if (file) for (const entry of secretEntries(file)) found.add(entry);
  }
  return [...found].sort().slice(0, 50);
}

export function normalizeProtectedPath(value) {
  const fail = why => { throw new Error(`protected-path-invalid: ${why}`); };
  if (typeof value !== 'string') fail('not a string');
  let text = value.trim();
  if (!text) fail('empty');
  if (text.length > 200) fail('longer than 200 characters');
  if (text.includes('\u0000')) fail('NUL');
  if (text.includes('\\') || GLOB_CHARS.some(c => text.includes(c))) fail('forbidden character');
  if (path.posix.isAbsolute(text) || /^[A-Za-z]:/.test(text)) fail('absolute path');
  while (text.startsWith('./')) text = text.slice(2);
  const folder = text.endsWith('/');
  const parts = (folder ? text.slice(0, -1) : text).split('/');
  if (parts.some(part => part === '' || part === '.' || part === '..')) fail('empty, . or .. segment');
  return parts.join('/') + (folder ? '/' : '');
}

export function protectedPathHit(profile, file) {
  // APFS treats NFC and NFD spellings as one file, so both sides are compared in NFC.
  const target = path.posix.normalize(String(file).split('\\').join('/')).normalize('NFC').toLowerCase();
  const entries = [...ALWAYS_PROTECTED, ...(profile?.protectedPaths ?? [])];
  for (const entry of entries) {
    const key = entry.normalize('NFC').toLowerCase();
    const hit = key.endsWith('/')
      ? target === key.slice(0, -1) || target.startsWith(key)
      : target === key || target.startsWith(`${key}/`);
    if (hit) return entry;
  }
  return null;
}

export function protectedViolations(profile, jobs) {
  const out = [];
  for (const job of Array.isArray(jobs) ? jobs : []) {
    const id = job?.id ?? job?.name;
    // outputDirs is the open-scope list of folders a codex job may write anywhere inside.
    // Reading a protected file is refused too, unless the owner wrote allowProtectedContext (with a reason) on that job.
    const mayRead = typeof job?.allowProtectedContext === 'string' && job.allowProtectedContext.trim() !== '';
    for (const [field, kind] of [['outputs', 'output'], ['outputDirs', 'output'], ['deletes', 'deletes'], ['context', 'context']]) {
      if (kind === 'context' && mayRead) continue;
      const files = Array.isArray(job?.[field]) ? job[field] : [];
      for (const file of files) {
        const entry = typeof file === 'string' ? protectedPathHit(profile, file) : null;
        if (entry) out.push({ job: id, path: file, entry, kind });
      }
    }
  }
  return out;
}

// quality: which checks a build ticket must pass before it is done. Each entry is an argv array, true (the package script) or false (off).
function validateQuality(raw) {
  if (!isObject(raw)) return { errors: ['must be an object'], value: null };
  const errors = [], value = {};
  for (const key of Object.keys(raw)) {
    if (!['typecheck', 'lint', 'build'].includes(key)) { errors.push(`${key}: unknown key`); continue; }
    const entry = raw[key];
    if (typeof entry === 'boolean') value[key] = entry;
    else if (Array.isArray(entry) && entry.length > 0 && entry.length <= 12 && entry.every(a => typeof a === 'string' && a.length > 0 && a.length <= 300)) value[key] = [...entry];
    else errors.push(`${key}: must be true, false or an argv array of 1 to 12 strings`);
  }
  return { errors, value };
}

export function validateProfile(profile) {
  if (!isObject(profile)) return { profile: null, errors: ['profile: not an object'] };
  const errors = Object.keys(profile).filter(key => !PROFILE_KEYS.includes(key)).map(key => `profile.${key}: unknown key`);
  const out = {};
  out.sensitive = profile.sensitive === undefined ? true : profile.sensitive;
  if (typeof out.sensitive !== 'boolean') errors.push('profile.sensitive: must be true or false');
  out.protectedPaths = validatePaths(profile.protectedPaths, errors);
  out.budget = validateBudget(profile.budget, errors);
  out.baseCheck = validateBaseCheck(profile.baseCheck, errors);
  const stack = profile.stack === undefined ? null : validateStack(profile.stack, errors);
  if (stack) out.stack = stack;
  const security = profile.security === undefined ? null : validateSecurity(profile.security, errors);
  if (security) out.security = security;
  if (profile.verify !== undefined) {
    const checked = validateVerifyConfig(profile.verify);
    for (const message of checked.errors) errors.push(`profile.${message}`);
    if (checked.ok && checked.value) {
      out.verify = checked.value;
      // The scripts a setup or test command runs, and package.json for package runners, are protected like a ci hook's files.
      for (const argv of [...(checked.value.setup ?? []), checked.value.command]) for (const entry of hookFiles(argv)) {
        try { const clean = normalizeProtectedPath(entry); if (!out.protectedPaths.includes(clean)) out.protectedPaths.push(clean); } catch { /* not a usable path */ }
      }
    }
  }
  if (profile.quality !== undefined) {
    const checked = validateQuality(profile.quality);
    for (const message of checked.errors) errors.push(`profile.quality: ${message}`);
    if (!checked.errors.length) out.quality = checked.value;
  }
  if (profile.context !== undefined) {
    const checked = validateContextBlock(profile.context);
    for (const message of checked.errors) errors.push(`profile.context: ${message}`);
    if (checked.value) out.context = checked.value;
  }
  if (profile.acceptance !== undefined) {
    const a = profile.acceptance;
    if (!a || typeof a !== 'object' || Array.isArray(a)) errors.push('profile.acceptance: must be an object');
    else {
      for (const key of Object.keys(a)) if (!['enforce', 'model'].includes(key)) errors.push(`profile.acceptance: unknown key ${key}`);
      if (a.enforce !== undefined && typeof a.enforce !== 'boolean') errors.push('profile.acceptance.enforce: must be true or false');
      if (a.model !== undefined && !(typeof a.model === 'string' && /^(sonnet|opus)$/.test(a.model))) errors.push('profile.acceptance.model: must be sonnet or opus');
      if (!errors.some(e => e.startsWith('profile.acceptance'))) out.acceptance = { ...(a.enforce !== undefined ? { enforce: a.enforce } : {}), ...(a.model !== undefined ? { model: a.model } : {}) };
    }
  }
  if (profile.migrations !== undefined) {
    const checked = validateMigrationsConfig(profile.migrations);
    for (const message of checked.errors) errors.push(`profile.migrations: ${message}`);
    if (checked.ok) {
      const { dir, down, downDir, commands, env: migrationEnvNames } = checked.config;
      out.migrations = { dir, down, ...(downDir ? { downDir } : {}), ...(migrationEnvNames?.length ? { env: migrationEnvNames } : {}), ...(Object.keys(commands).length ? { commands } : {}) };
      // The scripts the migration commands run are protected like a ci hook's files.
      for (const argv of Object.values(commands)) for (const entry of hookFiles(argv)) {
        try { const clean = normalizeProtectedPath(entry); if (!out.protectedPaths.includes(clean)) out.protectedPaths.push(clean); } catch { /* not a usable path */ }
      }
    }
  }
  if (profile.ui !== undefined) {
    const checked = validateUiConfig(profile.ui);
    for (const message of checked.errors) errors.push(`profile.ui: ${message}`);
    if (checked.config && !checked.errors.length) {
      out.ui = checked.config;
      // The script the dev server command runs is protected like a ci hook's files.
      // The mockups are what pages are compared with: workers cannot edit them (jobs that render those screens may still read them).
      for (const entry of [...hookFiles(checked.config.start), ...checked.config.screens.map(screen => screen.mockup)]) {
        try { const clean = normalizeProtectedPath(entry); if (!out.protectedPaths.includes(clean)) out.protectedPaths.push(clean); } catch { /* not a usable path */ }
      }
    }
  }
  if (profile.ci !== undefined) {
    const checked = validateCiConfig(profile.ci);
    for (const message of checked.errors) errors.push(`profile.ci: ${message}`);
    if (checked.config) out.ci = checked.config;
    // The files a hook runs (a script path in its argv, package.json for package runners) become protected paths, so a batch cannot edit what runs with the owner's rights.
    for (const hook of Object.values(checked.config ?? {})) for (const entry of hookFiles(hook.argv)) {
      try { const clean = normalizeProtectedPath(entry); if (!out.protectedPaths.includes(clean)) out.protectedPaths.push(clean); } catch { /* not a usable path */ }
    }
  }
  if (profile.approval !== undefined) {
    const checked = validateApprovalPolicy(profile.approval);
    for (const message of checked.errors) errors.push(`profile.approval: ${message}`);
    if (checked.policy) out.approval = checked.policy;
  }
  return { profile: out, errors };
}

const PACKAGE_RUNNERS = new Set(['npm', 'pnpm', 'yarn', 'npx', 'bun', 'bunx']);
export function hookFiles(argv) {
  if (!Array.isArray(argv)) return [];
  const files = argv.filter((item, index) => typeof item === 'string' && !item.startsWith('-') && (/\.(?:mjs|cjs|js|ts|py|sh|rb|pl)$/.test(item) || (index === 0 && item.includes('/'))) && !path.isAbsolute(item));
  return files;
}

// The package.json scripts a package-runner command runs (npm run X, npm test, pnpm X, yarn X): a batch must not change them (the gate checks).
export function hookScriptNames(profile) {
  const names = new Set();
  const argvs = [profile?.verify?.command, ...(profile?.verify?.setup ?? []), profile?.ci?.smoke?.argv, profile?.ci?.preview?.argv, profile?.ui?.start, ...Object.values(profile?.migrations?.commands ?? {})];
  for (const argv of argvs) {
    if (!Array.isArray(argv) || !PACKAGE_RUNNERS.has(String(argv[0]).split('/').pop())) continue;
    const rest = argv.slice(1).filter(item => typeof item === 'string' && !item.startsWith('-'));
    const script = rest[0] === 'run' ? rest[1] : (rest[0] && !['install', 'ci', 'exec', 'dlx', 'x', 'add', 'run'].includes(rest[0]) ? rest[0] : null);
    // npm also runs the pre and post scripts of the one it was asked to run
    if (script) for (const name of [script, `pre${script}`, `post${script}`]) names.add(name);
  }
  return [...names];
}

const CONTEXT_KINDS = ['shared', 'db', 'ui', 'api', 'test'];
// profile.context: { shared, db, ui, api, test }, each an array of at most 20 repo paths that every ticket of that kind gets as context.
function validateContextBlock(value) {
  if (!isObject(value)) return { value: null, errors: ['must be an object'] };
  const errors = Object.keys(value).filter(key => !CONTEXT_KINDS.includes(key)).map(key => `${key}: unknown key`);
  const out = {};
  for (const kind of CONTEXT_KINDS) {
    if (value[kind] === undefined) continue;
    const list = value[kind];
    const ok = Array.isArray(list) && list.length <= 20 && list.every(entry => typeof entry === 'string' && entry.length > 0 && entry.length <= 200 && !entry.startsWith('/') && !entry.includes('\\') && !entry.split('/').some(part => part === '..' || part === '' || part === '.'));
    if (ok) out[kind] = [...list]; else errors.push(`${kind}: array of at most 20 repo-relative paths`);
  }
  return { value: errors.length ? null : out, errors };
}

function validatePaths(value, errors) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 100) {
    errors.push('profile.protectedPaths: array of at most 100 entries');
    return [];
  }
  const paths = [];
  for (const raw of value) {
    try {
      const entry = normalizeProtectedPath(raw);
      if (!paths.includes(entry)) paths.push(entry);
    } catch (error) {
      errors.push(`profile.protectedPaths: ${error.message}`);
    }
  }
  return paths;
}

function validateStack(stack, errors) {
  const valid = Array.isArray(stack) && stack.length <= 10 && stack.every(entry => isObject(entry)
    && typeof entry.name === 'string' && (entry.packageManager === undefined || typeof entry.packageManager === 'string'));
  if (!valid) {
    errors.push('profile.stack: array of at most 10 entries with a name');
    return null;
  }
  return stack.map(({ name, packageManager }) => (packageManager === undefined ? { name } : { name, packageManager }));
}

const SECURITY_KEYS = ['enabled', 'minAgeDays', 'minWeeklyDownloads', 'blockSeverities', 'allowCopyleft', 'approvedLicenses', 'allowedSecretFingerprints', 'requireVulnerabilityScan', 'codeScan', 'acceptedAdvisories', 'codeScanSensitive', 'allowUnparsedManifests'];
const SECURITY_SEVERITIES = ['low', 'medium', 'high', 'critical'];

function validateSecurity(value, errors) {
  if (!isObject(value)) {
    errors.push('profile.security: must be an object');
    return null;
  }
  for (const key of Object.keys(value)) {
    if (!SECURITY_KEYS.includes(key)) errors.push(`profile.security.${key}: unknown key`);
  }
  const out = {};
  if (value.enabled !== undefined) {
    if (typeof value.enabled === 'boolean') out.enabled = value.enabled;
    else errors.push('profile.security.enabled: must be true or false');
  }
  for (const key of ['minAgeDays', 'minWeeklyDownloads']) {
    if (value[key] === undefined) continue;
    if (typeof value[key] === 'number' && Number.isFinite(value[key]) && value[key] >= 0) out[key] = value[key];
    else errors.push(`profile.security.${key}: must be a finite number of 0 or more`);
  }
  if (value.blockSeverities !== undefined) {
    if (Array.isArray(value.blockSeverities) && value.blockSeverities.length <= 4
      && value.blockSeverities.every(entry => SECURITY_SEVERITIES.includes(entry))) out.blockSeverities = [...value.blockSeverities];
    else errors.push('profile.security.blockSeverities: array of at most 4 of low, medium, high, critical');
  }
  if (value.allowCopyleft !== undefined) {
    if (typeof value.allowCopyleft === 'boolean') out.allowCopyleft = value.allowCopyleft;
    else errors.push('profile.security.allowCopyleft: must be true or false');
  }
  if (value.approvedLicenses !== undefined) {
    if (Array.isArray(value.approvedLicenses) && value.approvedLicenses.length <= 50
      && value.approvedLicenses.every(entry => typeof entry === 'string' && entry.length <= 80)) out.approvedLicenses = [...value.approvedLicenses];
    else errors.push('profile.security.approvedLicenses: array of at most 50 strings of at most 80 characters');
  }
  if (value.allowedSecretFingerprints !== undefined) {
    if (Array.isArray(value.allowedSecretFingerprints) && value.allowedSecretFingerprints.length <= 200
      && value.allowedSecretFingerprints.every(entry => typeof entry === 'string' && /^[0-9a-f]{12}$/.test(entry))) out.allowedSecretFingerprints = [...value.allowedSecretFingerprints];
    else errors.push('profile.security.allowedSecretFingerprints: array of at most 200 strings of exactly 12 lower-case hex characters');
  }
  if (value.requireVulnerabilityScan !== undefined) {
    if (typeof value.requireVulnerabilityScan === 'boolean') out.requireVulnerabilityScan = value.requireVulnerabilityScan;
    else errors.push('profile.security.requireVulnerabilityScan: must be true or false');
  }
  if (value.codeScan !== undefined) {
    if (value.codeScan === 'local' || value.codeScan === 'auto' || value.codeScan === 'off') out.codeScan = value.codeScan;
    else errors.push("profile.security.codeScan: must be 'local', 'auto' or 'off'");
  }
  if (value.codeScanSensitive !== undefined) {
    if (typeof value.codeScanSensitive === 'boolean') out.codeScanSensitive = value.codeScanSensitive;
    else errors.push('profile.security.codeScanSensitive: must be true or false');
  }
  if (value.allowUnparsedManifests !== undefined) {
    if (Array.isArray(value.allowUnparsedManifests) && value.allowUnparsedManifests.length <= 50
      && value.allowUnparsedManifests.every(entry => typeof entry === 'string' && entry.length <= 200)) out.allowUnparsedManifests = [...value.allowUnparsedManifests];
    else errors.push('profile.security.allowUnparsedManifests: array of at most 50 strings of at most 200 characters');
  }
  if (value.acceptedAdvisories !== undefined) {
    const valid = entry => isObject(entry) && Object.keys(entry).every(key => ['package', 'id', 'reason', 'reviewBy'].includes(key))
      && typeof entry.package === 'string' && entry.package.length > 0 && entry.package.length <= 214
      && (entry.id === undefined || (typeof entry.id === 'string' && entry.id.length > 0 && entry.id.length <= 60))
      && typeof entry.reason === 'string' && entry.reason.length >= 5 && entry.reason.length <= 300
      && typeof entry.reviewBy === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(entry.reviewBy) && Number.isFinite(Date.parse(`${entry.reviewBy}T00:00:00Z`)) && new Date(`${entry.reviewBy}T00:00:00Z`).toISOString().slice(0, 10) === entry.reviewBy;
    if (Array.isArray(value.acceptedAdvisories) && value.acceptedAdvisories.length <= 50 && value.acceptedAdvisories.every(valid)) out.acceptedAdvisories = value.acceptedAdvisories.map(entry => ({ ...entry }));
    else errors.push('profile.security.acceptedAdvisories: array of at most 50 { package, id?, reason (5 to 300 characters), reviewBy (YYYY-MM-DD) }');
  }
  return out;
}

function validateBudget(budget, errors) {
  const out = { ...DEFAULT_PROFILE_BUDGET };
  if (budget === undefined) return out;
  if (!isObject(budget)) {
    errors.push('profile.budget: must be an object');
    return out;
  }
  for (const key of Object.keys(budget)) {
    if (!Object.hasOwn(DEFAULT_PROFILE_BUDGET, key) && key !== 'projectMaxUsd') errors.push(`profile.budget.${key}: unknown key`);
  }
  if (budget.maxUsd !== undefined) {
    if (typeof budget.maxUsd === 'number' && Number.isFinite(budget.maxUsd) && budget.maxUsd > 0) out.maxUsd = budget.maxUsd;
    else errors.push('profile.budget.maxUsd: must be a number above 0');
  }
  if (budget.projectMaxUsd !== undefined) {
    if (typeof budget.projectMaxUsd === 'number' && Number.isFinite(budget.projectMaxUsd) && budget.projectMaxUsd > 0) out.projectMaxUsd = budget.projectMaxUsd;
    else errors.push('profile.budget.projectMaxUsd: must be a number above 0');
  }
  if (budget.maxTokens !== undefined) {
    if (Number.isInteger(budget.maxTokens) && budget.maxTokens > 0) out.maxTokens = budget.maxTokens;
    else errors.push('profile.budget.maxTokens: must be a positive integer');
  }
  return out;
}

function validateBaseCheck(base, errors) {
  const out = { status: 'none', ranAt: null, head: null, checks: [] };
  if (base === undefined) return out;
  if (!isObject(base)) {
    errors.push('profile.baseCheck: must be an object');
    return out;
  }
  for (const key of Object.keys(base)) {
    if (!BASE_KEYS.includes(key)) errors.push(`profile.baseCheck.${key}: unknown key`);
  }
  if (STATUSES.includes(base.status)) out.status = base.status;
  else errors.push('profile.baseCheck.status: must be green, red, skipped or none');
  for (const key of ['ranAt', 'head']) {
    if (base[key] === undefined || base[key] === null || typeof base[key] === 'string') out[key] = base[key] ?? null;
    else errors.push(`profile.baseCheck.${key}: must be text`);
  }
  if (base.checks === undefined) return out;
  if (!Array.isArray(base.checks) || base.checks.length > 20) errors.push('profile.baseCheck.checks: array of at most 20 items');
  else out.checks = base.checks.map(check => validateCheck(check, errors)).filter(Boolean);
  return out;
}

function validateCheck(check, errors) {
  const valid = isObject(check) && typeof check.name === 'string' && check.name.length <= 60
    && typeof check.ok === 'boolean' && (check.exitCode === null || Number.isInteger(check.exitCode))
    && typeof check.tail === 'string';
  if (!valid) {
    errors.push('profile.baseCheck.checks: invalid item');
    return null;
  }
  return { name: check.name, ok: check.ok, exitCode: check.exitCode, tail: [...sanitizeText(check.tail)].slice(0, 500).join('') };
}

async function runOne(root, check, run, timeoutMs) {
  const name = String(check?.name ?? '').slice(0, 60);
  try {
    const res = await run(check.argv, { cwd: root, timeoutMs });
    const exitCode = Number.isInteger(res?.exitCode) ? res.exitCode : null;
    const text = [res?.stderr, res?.stdout].filter(Boolean).map(String).join('\n');
    return { name, ok: exitCode === 0, exitCode, tail: sanitizeText(lastChars(text, 300)) };
  } catch (error) {
    return { name, ok: false, exitCode: null, tail: sanitizeText(lastChars(error?.message ?? error, 300)) };
  }
}

export async function runBaseChecks(root, checks, { run, head, now, timeoutMs = 300000 }) {
  const ranAt = new Date(now()).toISOString();
  const list = Array.isArray(checks) ? checks.slice(0, 10) : [];
  if (!list.length) return { status: 'none', ranAt, head: head ?? null, checks: [] };
  const results = [];
  for (const check of list) results.push(await runOne(root, check, run, timeoutMs));
  return { status: results.every(result => result.ok) ? 'green' : 'red', ranAt, head: head ?? null, checks: results };
}

export function formatBaseCheck(baseCheck) {
  const status = baseCheck?.status;
  if (!status || status === 'skipped') return 'Base checks: not run';
  if (status === 'none') return 'Base checks: none defined';
  const checks = Array.isArray(baseCheck.checks) ? baseCheck.checks : [];
  if (status === 'red') {
    const failing = checks.filter(check => !check.ok).map(check => check.name);
    return `Base checks: RED, already failing before any change: ${failing.join(', ') || 'unknown'}`;
  }
  const when = baseCheck.ranAt ? `, ${baseCheck.ranAt}` : '';
  return `Base checks: ${status} (${checks.length} checks${when})`;
}

function versionItem(pointer, installed) {
  if (!isObject(pointer)) return item('version', 'warn', 'version: not recorded');
  if (pointer.version === installed) return item('version', 'ok', `version ${installed}`);
  return item('version', 'warn', `version ${pointer.version} differs from installed ${installed}`);
}

function profileItems(profile) {
  if (!isObject(profile)) return [item('profile', 'warn', 'profile: not recorded (run swarm init)')];
  const out = REQUIRED_KEYS.filter(key => !Object.hasOwn(profile, key))
    .map(key => item('profile', 'warn', `profile.${key} is missing`));
  const { errors } = validateProfile(profile);
  if (errors.length) out.push(item('profile', 'fail', `profile invalid: ${errors[0]}`));
  if (!out.length) out.push(item('profile', 'ok', 'profile is complete'));
  return out;
}

async function checksItem(root, deps) {
  const json = await quiet(() => deps.readJson('coordination/checks.json'));
  const count = Array.isArray(json?.checks) ? json.checks.length : 0;
  return count ? item('checks', 'ok', `${count} check(s) defined`) : item('checks', 'warn', 'coordination/checks.json has no checks');
}

function baseItems(profile, head) {
  const base = validateProfile(profile).profile?.baseCheck ?? null;
  if (!base) return [item('base', 'warn', 'base: never checked')];
  const stale = (base.status === 'green' || base.status === 'red') && base.head !== head;
  const when = stale ? '; checked at another commit, re-run swarm init' : '';
  if (base.status === 'green') return [item(stale ? 'base' : 'base', stale ? 'warn' : 'ok', `base checks are green${when}`)];
  if (base.status === 'red') {
    const failing = base.checks.filter(check => !check.ok).map(check => check.name);
    return [item('base', 'warn', `base checks already failing: ${failing.join(', ') || 'unknown'}${when}`)];
  }
  return [item('base', 'warn', 'base checks were never run (swarm init runs them)')];
}

async function mapItem(root, deps, head) {
  const map = await quiet(() => deps.readMap(root));
  if (!map) return item('map', 'warn', 'repo map not built (run swarm map)');
  if (typeof head === 'string' && head && map.head === head) return item('map', 'ok', 'repo map is fresh');
  return item('map', 'warn', 'repo map is stale (run swarm map)');
}

async function ignoreItem(readText, root) {
  const text = await quiet(() => readText(path.join(root, '.gitignore')));
  const lines = String(text ?? '').split('\n').map(line => line.trim());
  const ok = ['.swarm', '.swarm/', '/.swarm', '/.swarm/'].some(entry => lines.includes(entry));
  return ok ? item('ignore', 'ok', '.swarm/ is git-ignored') : item('ignore', 'warn', '.swarm/ is not in .gitignore');
}

async function pointersItem(readText, root) {
  const missing = [];
  for (const name of ['AGENTS.md', 'CLAUDE.md']) {
    const text = await quiet(() => readText(path.join(root, name)));
    if (!text || !String(text).includes('swarm brief')) missing.push(name);
  }
  return missing.length
    ? item('pointers', 'warn', `${missing.join(', ')} missing or not pointing at swarm brief`)
    : item('pointers', 'ok', 'AGENTS.md and CLAUDE.md point at swarm brief');
}

function protectedItem(profile) {
  const paths = isObject(profile) ? validateProfile(profile).profile?.protectedPaths ?? [] : [];
  return item('protected', 'ok', `${paths.length} protected path(s) kept out of every job`);
}

export async function checkSetup(root, deps) {
  const readText = deps.readText ?? defaultReadText;
  // exists, readJson and stat take paths relative to the project root.
  const present = await quiet(() => deps.exists('.project-swarm.json'));
  const pointer = present ? await quiet(() => deps.readJson('.project-swarm.json')) : null;
  const head = typeof deps.head === 'function' ? await quiet(() => deps.head(root)) : (deps.head ?? null);
  const profile = pointer?.profile ?? (deps.readProfile ? await quiet(() => deps.readProfile(root)) : null);
  const items = [
    isObject(pointer)
      ? item('pointer', 'ok', '.project-swarm.json is valid')
      : item('pointer', 'fail', '.project-swarm.json is missing or not valid JSON'),
    versionItem(pointer, deps.installVersion),
    ...profileItems(profile),
    await checksItem(root, deps),
    ...baseItems(profile, head),
    await mapItem(root, deps, head),
    await ignoreItem(readText, root),
    await pointersItem(readText, root),
    protectedItem(profile),
  ];
  return { ok: !items.some(entry => entry.level === 'fail'), items };
}
