// SPDX-License-Identifier: Apache-2.0
// `swarm scope`, `swarm tickets`, `swarm change` and the `go --scope` preparation (Phase 13).
// Pure glue over scope.mjs, tickets.mjs, scope-integrity.mjs, change-orders.mjs, day0.mjs,
// approval-policy.mjs and ticket-manifest.mjs. No model is called here; `scope split` only writes
// a manifest for `swarm run`.
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { SCOPE_TEMPLATE, parseScope, checkScope, scopeHash, requirementText, isSensitiveText } from './scope.mjs';
import { readLedger, writeLedger, appendLog, createLedger, transition, readyTickets, filterTickets, ledgerStats, renderBuildPlan, pruneCancelledDeps, logPrune, approveLedger, isApproved, validateTicket, STATUSES } from './tickets.mjs';
import { checkTicketTree, summarizeTree, formatSummary } from './scope-integrity.mjs';
import { isSecretLooking } from './ignored-artifacts.mjs';
import { diffScopes, impactAnalysis, nextChangeOrderId, applyChangeOrder } from './change-orders.mjs';
import { day0Checklist, checklistToTickets } from './day0.mjs';
import { validateApprovalPolicy, needsHuman } from './approval-policy.mjs';
import { ticketsToManifest, ticketOutcome } from './ticket-manifest.mjs';
import { safeWritableDir, assertRegularOrMissing } from './journal.mjs';
import { validateOpenApi, contractFiles } from './contracts.mjs';
import { verifyContracts } from './contracts-verify.mjs';
import { validateProfile, protectedPathHit, isSecretPath, isExampleFile } from './init-profile.mjs';
import { ensureGitignore } from './gitignore-defaults.mjs';
import { workTreeFingerprint } from './work-tree.mjs';
import { otherManagerLockfile } from './ticket-manifest.mjs';
import { doneEvidence, ticketTests } from './verify-config.mjs';
import { deriveQualityChecks, qualityEvidence } from './quality-checks.mjs';
import { nextStep, sizeTicket } from './escalation.mjs';
import { unlockReady, releaseReady } from './ticket-unlock.mjs';
import { WIRING_PROMPT, WIRE_ONLY_PROMPT, wiringGaps, addWiringDeps, chainSharedFiles, builtRequirements, unwiredRequirements, moduleTickets } from './wiring.mjs';
import { parseEnvNames, envNamesLine } from './env-names.mjs';
import { detectTestCommand } from './zero-tests.mjs';
import { execFile } from 'node:child_process';
import { existsSync, statSync, lstatSync, realpathSync, readdirSync, readFileSync } from 'node:fs';
import { promisify } from 'node:util';

export const SCOPE_USAGE = [
  'Usage: swarm scope template [--out FILE]',
  '       swarm scope check [FILE]',
  '       swarm scope split [FILE] [--stage S1] | scope split --wire [--all] | scope split --ingest RUN [--merge] [--wire]',
  '       swarm scope approve [FILE] [--yes]',
  '       swarm scope sync RUN [--integrated]',
  '       swarm scope contracts OPENAPI.json',
  '       swarm tickets [ID] [--stage S1] [--status todo] [--type build] [--risk high] [--set STATUS] [--note TEXT] [--json]',
  '       swarm tickets ID --files a,b [--context c,d] [--tests t] [--yes]     (change the file lists of a ticket that is not running; keeps an approved ledger approved)',
  '       swarm tickets --mark-deps [ID...] [--yes]     (one time, older ledgers: mark blocked tickets with no reason as dependency-blocked so they unlock)',
  '       swarm change "reason" [FILE] [--yes]',
  '       swarm go --scope [--max-jobs N] [go options]',
  ''].join('\n');

export const DEFAULT_SCOPE_FILE = 'docs/scope/scope.md';
const SNAPSHOT = ['.swarm', 'project', 'scope.snapshot.md'];
const SPLIT_DIR = 'docs/scope/split';
const MAX_SPLIT_BYTES = 2 * 1024 * 1024;
const MAX_STAGE_TICKETS = 2000;
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const LOCK_STALE_MS = 10 * 60 * 1000;
const FLAGS_WITH_VALUE = new Set(['--out', '--stage', '--ingest', '--status', '--type', '--risk', '--set', '--note', '--max-jobs', '--files', '--context', '--tests']);
const execFileAsync = promisify(execFile);
const fail = (code, message) => Object.assign(new Error(message), { code });
const out = (text, exitCode = 0) => ({ stdout: text.endsWith('\n') ? text : `${text}\n`, exitCode });
const bad = message => out(`${message}\n${SCOPE_USAGE}`, 1);

export function parseArgs(args) {
  const flags = {};
  const rest = [];
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a.startsWith('--')) {
      if (FLAGS_WITH_VALUE.has(a)) {
        if (i + 1 >= args.length || args[i + 1].startsWith('--')) throw fail('scope-args', `${a} needs a value`);
        flags[a.slice(2)] = args[i + 1];
        i += 1;
      } else flags[a.slice(2)] = true;
    } else rest.push(a);
  }
  return { flags, rest };
}

const rel = p => p.split(path.sep).join('/');
const resolveInside = (root, file) => {
  const full = path.resolve(root, file);
  if (full !== root && !full.startsWith(root + path.sep)) throw fail('scope-path', `${file} is outside the project`);
  return full;
};

async function readText(file) {
  try { return await fs.readFile(file, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

async function loadScope(root, file) {
  const target = file ?? DEFAULT_SCOPE_FILE;
  const text = await readText(resolveInside(root, target));
  if (text === null) throw fail('scope-missing', `no scope file at ${target}; create one with: swarm scope template --out ${DEFAULT_SCOPE_FILE}`);
  return { file: target, text, scope: parseScope(text), hash: scopeHash(text) };
}

export async function readApprovalPolicy(root) {
  const pointer = JSON.parse((await readText(path.join(root, '.project-swarm.json'))) ?? '{}');
  const { policy, errors } = validateApprovalPolicy(pointer?.profile?.approval);
  if (errors.length) throw fail('approval-invalid', `profile.approval: ${errors[0]}`);
  return policy;
}

// Writes through a temp file opened O_EXCL|O_NOFOLLOW, then renames, so a symlink at the target is never followed.
// `exclusive` links instead of renaming: an existing target (even a dangling symlink) is an EEXIST error.
// The validated profile of the project (null when there is none or it is invalid).
export async function readProfile(root) {
  try {
    const pointer = JSON.parse((await readText(path.join(root, '.project-swarm.json'))) ?? 'null');
    if (!pointer?.profile) return null;
    const { profile, errors } = validateProfile(pointer.profile);
    return errors.length ? null : { ...profile, stack: pointer.stack ?? profile.stack };
  } catch { return null; }
}
export const packageManagerOf = profile => (profile?.stack ?? []).find(entry => entry?.name === 'node')?.packageManager ?? null;

// Project files a context entry may name: existence and size are looked up on disk, only for safe relative paths.
export function contextEnvFor(root, profile) {
  const safe = p => typeof p === 'string' && p && !path.isAbsolute(p) && !p.split('/').some(part => part === '..' || part === '') && !p.includes('\\');
  const walk = (dir, out, depth = 0) => {
    if (out.length >= 400 || depth > 4) return;
    let entries = [];
    try { entries = readdirSync(path.join(root, dir), { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const rel = `${dir}/${entry.name}`;
      if (entry.isDirectory()) walk(rel, out, depth + 1); else out.push(rel);
    }
  };
  let realRoot = root;
  try { realRoot = realpathSync(root); } catch { /* the root exists; keep it as given */ }
  const rejected = [];
  // A context file is a regular file reached without any symlink, inside the project, that is neither protected nor a secret.
  const usable = (p, allowProtected = false) => {
    if (!safe(p)) return false;
    // A names-only template (.env.example) is read-only context: allowed here, still refused as an output.
    if (!isExampleFile(p) && (isSecretPath(p) || (!allowProtected && profile && protectedPathHit(profile, p)))) { if (!rejected.includes(p)) rejected.push(p); return false; }
    try {
      let current = root;
      for (const part of p.split('/')) { current = path.join(current, part); if (lstatSync(current).isSymbolicLink()) return false; }
      if (!lstatSync(current).isFile()) return false;
      const real = realpathSync(current);
      return real === realRoot || real.startsWith(realRoot + path.sep);
    } catch { return false; }
  };
  return {
    exists: p => usable(p),
    // A design mockup is protected from edits (a worker cannot change what it is compared with) but may be read: still never a secret or a symlink.
    existsMockup: p => usable(p, true),
    rejected,
    sizes: new Proxy({}, { get: (_, p) => { try { return safe(String(p)) ? statSync(path.join(root, String(p))).size : undefined; } catch { return undefined; } } }),
    listFiles: prefix => { const out = []; if (safe(prefix)) walk(prefix, out); return out.filter(usable); },
    profileContext: profile?.context ?? {},
    screenMockups: Object.fromEntries((profile?.ui?.screens ?? []).map(screen => [screen.id, screen.mockup])),
    envLine: envLineFor(root),
  };
}

// Variable names (never values) from the project's example env file: a regular file, no symlink, small.
function envLineFor(root) {
  try {
    const file = path.join(root, '.env.example');
    const info = lstatSync(file);
    if (!info.isFile() || info.size > 20000) return '';
    return envNamesLine(parseEnvNames(readFileSync(file, 'utf8')));
  } catch { return ''; }
}

// The quality checks (typecheck, lint, optional build) this project's profile and package.json give.
export async function qualityFor(root, profile) {
  let pkg = null;
  try { pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8')); } catch { /* no package.json */ }
  return deriveQualityChecks({ pkg, hasTsconfig: existsSync(path.join(root, 'tsconfig.json')), manager: packageManagerOf(profile) ?? 'npm', config: profile?.quality ?? {} });
}

// Check output and job errors go back into a worker prompt (and, when a ticket escalates, to another vendor): credentials are removed first.
export function redactNote(text) {
  return String(text ?? '')
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/:@]+:[^\s@]+@/gi, '$1***@')
    .replace(/eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/g, '***')
    .replace(/\b([A-Za-z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|PASS|AUTH|CREDENTIAL)[A-Za-z0-9_]*)(\s*[=:]\s*)\S+/gi, '$1$2***')
    .replace(/\b[A-Za-z0-9+/_-]{32,}={0,2}/g, '***');
}

// Ticket moves share the wave lock, so an owner command, a wave start and a sync cannot overwrite each other.
async function lockedTransition(root, id, to, options) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try { return await withLock(root, () => transition(root, id, to, options)); }
    catch (error) { if (error.code !== 'scope-busy' || attempt === 4) throw error; await new Promise(resolve => setTimeout(resolve, 300)); }
  }
  return null;
}

// The quality checks the run itself was built with (its manifest), so a tsconfig or lint script added by a ticket of the same run
// cannot demand checks the merge batches never ran.
async function runQualityNames(root, runId) {
  try {
    const manifest = JSON.parse(await fs.readFile(path.join(root, '.swarm', 'runs', runId, 'manifest.json'), 'utf8'));
    return (manifest.checks ?? []).map(c => c.name).filter(name => ['typecheck', 'lint', 'build'].includes(name));
  } catch { return []; }
}

// Does the check output name one of the ticket's files (by path or file name)?
const mentionsFiles = (ticket, text) => (ticket.files ?? []).some(f => String(text ?? '').includes(f) || String(text ?? '').includes(f.split('/').pop()));

// Evidence that a build ticket's quality checks passed: the merge batch that integrated it, else the run's own checks.
function qualityOk(state, id, names) {
  const result = qualityEvidence(state, id, names);
  if (result.ok || !/no merge batch/.test(result.reason)) return result;
  // Without a merge queue the run-level checks of the integrate count, but only for a job whose files were all integrated, and never when the queue named a batch.
  if (state.mergeQueue?.integratedIn?.[id] !== undefined) return result;
  const job = (Array.isArray(state.jobs) ? state.jobs : []).find(j => j.id === id);
  const files = Array.isArray(job?.outputs) ? job.outputs : [];
  const integratedFiles = new Set(state.integratedFiles ?? []);
  if (files.length && !files.every(f => integratedFiles.has(f))) return { ok: false, reason: 'job files are not in the integrated files' };
  const checks = Array.isArray(state.checks) ? state.checks : [];
  const bad = names.find(name => checks.find(c => c.name === name)?.status !== 'passed');
  if (!bad) return { ok: true, reason: 'quality checks passed on integrate' };
  const found = checks.find(c => c.name === bad);
  return { ok: false, failed: found?.status === 'failed', shared: true, check: bad, ...(typeof found?.tail === 'string' && found.tail ? { tail: String(found.tail).slice(-600) } : {}), reason: `no ${bad} check passed on integrate` };
}

// Reference sections of the scope become two context files every ticket can be given: the overview, and the data model.
const DATA_MODEL_TITLE = /\b(data model|schema|tables|database)\b/i;
export function contextFilesOf(scope) {
  const model = scope.sections.filter(s => DATA_MODEL_TITLE.test(s.title));
  const rest = scope.sections.filter(s => !DATA_MODEL_TITLE.test(s.title));
  const files = { 'docs/scope/context/overview.md': [`# ${scope.name}: overview`, scope.overview, ...rest.map(s => `## ${s.title}\n${s.text}`)].filter(Boolean).join('\n\n') + '\n' };
  if (model.length) files['docs/scope/context/data-model.md'] = [`# ${scope.name}: data model`, ...model.map(s => `## ${s.title}\n${s.text}`)].join('\n\n') + '\n';
  return files;
}

// Protected-path mentions in requirement text (env files, keys) would make the manifest check refuse the split job: they are hidden.
const SECRET_MENTION = /(^|[\s"'`(])((?:\.env[\w.*-]*)|(?:[\w./*-]*\.(?:pem|key|p12))|(?:id_(?:rsa|ed25519)[\w.]*))(?=$|[\s"'`)>,;:.])/gim;
export const hideSecretMentions = text => String(text ?? '').replace(SECRET_MENTION, '$1<secret file>');

// A python-style ticket list (single quotes, True/False/None, trailing commas) is repaired; anything else invalid is refused.
export function parseLooseJson(text) {
  try { return { value: JSON.parse(text), repaired: false }; } catch (first) {
    let out = '', i = 0;
    const s = String(text);
    while (i < s.length) {
      const c = s[i];
      if (c === '"' || c === "'") {
        const quote = c; let body = ''; i += 1;
        while (i < s.length && s[i] !== quote) { if (s[i] === '\\' && i + 1 < s.length) { body += s[i] + s[i + 1]; i += 2; } else { body += s[i]; i += 1; } }
        i += 1;
        out += quote === "'" ? `"${body.replace(/\\'/g, "'").replace(/(?<!\\)"/g, '\\"')}"` : `"${body}"`;
      } else if (/[A-Za-z_]/.test(c)) {
        let word = ''; while (i < s.length && /[A-Za-z_]/.test(s[i])) { word += s[i]; i += 1; }
        out += word === 'True' ? 'true' : word === 'False' ? 'false' : word === 'None' ? 'null' : word;
      } else { out += c; i += 1; }
    }
    out = out.replace(/,(\s*[}\]])/g, '$1');
    try { return { value: JSON.parse(out), repaired: true }; } catch { throw first; }
  }
}

async function writeFileSafe(root, rel_, text, { exclusive = false } = {}) {
  const segments = rel_.split('/');
  const dir = await safeWritableDir(root, segments.slice(0, -1));
  const file = path.join(dir, segments.at(-1));
  await assertRegularOrMissing(file);
  const tmp = path.join(dir, `.${segments.at(-1)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
  const handle = await fs.open(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o644);
  try {
    await handle.writeFile(text);
    await handle.close();
    if (exclusive) { await fs.link(tmp, file); await fs.rm(tmp, { force: true }); } else await fs.rename(tmp, file);
  } catch (error) {
    await handle.close().catch(() => {});
    await fs.rm(tmp, { force: true });
    throw error;
  }
}

const readRunState = async (root, runId) => {
  if (!RUN_ID.test(String(runId)) || runId === '.' || runId === '..') throw fail('scope-run', `bad run id: ${String(runId).slice(0, 40)}`);
  const state = JSON.parse((await readText(path.join(root, '.swarm', 'runs', runId, 'state.json'))) ?? 'null');
  if (!state || typeof state !== 'object') throw fail('scope-run', `no run ${runId}`);
  return state;
};

function splitPrompt(scope, stage, only, layout = '', wire = null, existing = null) {
  const reqs = scope.requirements.filter(r => r.stage === stage.id && (!only || only.has(r.id)));
  const lines = [
    `Split the requirements of stage ${stage.id} (${stage.title || 'no title'}) of "${scope.name}" into small build tickets.`,
    'Return ONE JSON file named by the job output: a JSON array of ticket objects, nothing else.',
    'Each ticket object has these fields:',
    'key (short unique name in this file), title (under 140 characters), type (build, test, docs, migration, design, contract or human),',
    'epic (a feature group name), scopeRefs (requirement ids, at least one for build, test, docs, migration), acceptance (1 to 5 observable checks; required for build, test, migration),',
    'files (the files this ticket writes: repo-relative paths WITH their folders, for example src/app/page.tsx or supabase/migrations/0001_init.sql, never a bare file name unless the file really lives at the repo root; never a folder, never an absolute path, never a dot-env file: use env.example.txt for an env template), context (files it reads), contracts (contract files it uses), tests (the test files that prove this ticket: a build ticket lists the test files owned by its test ticket and depends on that test ticket; a test ticket lists its own), screens (only on UI tickets: the ids of the design screens the ticket renders, from the profile ui screens), dependsOn (keys of other tickets in this file),',
    'size (S or M; never larger: split instead), risk (low, medium or high), sensitive (true for payments, auth or customer data), steps (only for human tickets: 1 to 30 short imperative steps), skeleton (true only on the tickets of the thinnest vertical slice of the first stage: database, API, screen and test, the smallest path through the product; omit it elsewhere).',
    'Rules: every requirement is covered by at least one ticket; every ticket traces to a requirement; two tickets that can run at the same time never write the same file;',
    'put shared types or contracts first and make the tickets that use them depend on them; add a test ticket for each requirement group.',
    'A ticket of type contract writes exactly one OpenAPI 3 JSON file under contracts/ (for example contracts/api.json) using only paths (get, post, put, patch, delete, each with an operationId), components.schemas and local $ref; TypeScript, SQL and YAML types belong in build tickets that depend on the contract ticket.',
    'Migration tickets write DDL only; their tests are separate tickets in a tests folder.',
    'Keep every ticket small enough for one worker answer: at most 4 files, each file under about 12 KB when written; split a bigger feature into several tickets (the output of one worker is capped at about 15 KB per file).',
    WIRING_PROMPT,
    ...(wire ? [WIRE_ONLY_PROMPT, ...wire.filter(w => w.stage === stage.id).map(w => `Existing module tickets of ${w.req}: ${w.modules.map(m => `${m.id} ${m.title} (${(m.files ?? []).join(', ')})`).join('; ')}`)] : []),
    ...(layout ? ['Project layout (use these folders):', layout] : []),
    ...(existing ? [
      'This is a change to a project that already has tickets. Write tickets ONLY for the requirements listed below; never repeat, rewrite or replace an existing ticket, and never write a file an existing ticket already owns.',
      'Use real paths: take them from the file list below, and put a new file next to the files it belongs with.',
      ...(existing.files.length ? ['Files in the repository:', ...existing.files] : []),
      ...(existing.tickets.length ? ['Existing tickets (read-only; depend on them by writing their id in context, not dependsOn):', ...existing.tickets] : []),
    ] : []),
    'Work only from the requirements below.',
    '',
    ...reqs.flatMap(r => [`${r.id}: ${hideSecretMentions(r.text)}`, ...r.acceptance.map(a => `  - ${hideSecretMentions(a)}`)]),
    ...(scope.sensitive.length ? ['', `Sensitive areas: ${scope.sensitive.join('; ')}`] : []),
  ];
  return lines.join('\n');
}

export function buildSplitManifest(scope, { stage, only, layout = '', wire = null, existing = null } = {}) {
  const stages = scope.stages.filter(s => (!stage || s.id === stage) && scope.requirements.some(r => r.stage === s.id && (!only || only.has(r.id))));
  if (!stages.length) throw fail('scope-stage', stage ? `stage ${stage} has no requirements` : 'the scope has no stages with requirements');
  return {
    version: 1,
    concurrency: Math.min(stages.length, 8),
    jobs: stages.map(s => ({
      id: `split-${s.id}`,
      type: 'build',
      agent: 'auto',
      sensitive: true,
      maxOutputTokens: 32000,
      prompt: splitPrompt(scope, s, only, layout, wire, existing),
      context: [],
      outputs: [`${SPLIT_DIR}/${s.id}.json`],
      timeoutMs: 900000,
    })),
  };
}

function parseTicketFile(text) {
  const body = String(text).trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const { value, repaired } = parseLooseJson(body);
  const list = Array.isArray(value) ? value : value?.tickets;
  if (!Array.isArray(list)) throw new Error('not a JSON array of tickets');
  return { list, repaired };
}

// Files that really live at the repo root; every other ticket file needs its folder.
const ROOT_FILE_OK = /^(?:package(?:-lock)?\.json|tsconfig[\w.-]*\.json|readme(?:\.md)?|license(?:\.md)?|\.gitignore|\.nvmrc|dockerfile|makefile|components\.json|env\.example\.txt|next-env\.d\.ts|[\w.-]+\.config\.(?:[cm]?[jt]s|json)|\.eslintrc[\w.]*|\.prettierrc[\w.]*)$/i;

// The first two folder levels of the tracked files, so the worker puts files where the project keeps them.
async function projectLayout(root, scope, profile) {
  if (scope.layout) return hideSecretMentions(scope.layout).slice(0, 2000);
  const lines = [];
  try {
    const { stdout } = await execFileAsync('git', ['-C', root, 'ls-files'], { maxBuffer: 16 * 1024 * 1024 });
    const folders = new Map();
    for (const file of stdout.split('\n').filter(Boolean)) {
      const parts = file.split('/');
      if (parts.length < 2 || parts[0].startsWith('.') || parts[0] === 'node_modules') continue;
      const key = parts.length > 2 ? `${parts[0]}/${parts[1]}/` : `${parts[0]}/`;
      folders.set(key, (folders.get(key) ?? 0) + 1);
    }
    for (const [folder, n] of [...folders].sort(([a], [b]) => (a < b ? -1 : 1)).slice(0, 40)) lines.push(`- ${hideSecretMentions(folder)} (${n} files)`);
  } catch { /* not a git project: the stack line below still helps */ }
  const stack = (profile?.stack ?? []).map(entry => (entry.packageManager ? `${entry.name} (${entry.packageManager})` : entry.name));
  if (stack.length) lines.push(`Stack: ${stack.join(', ')}`);
  return lines.join('\n');
}

// The requirements that still need tickets: none of their tickets is alive. A merge adds tickets for these and nothing else.
const pendingRequirements = (scope, tickets) => new Set(scope.requirements.filter(r => !tickets.some(t => t.status !== 'cancelled' && t.scopeRefs.includes(r.id))).map(r => r.id));

// What a split worker of a change order needs to see: the real tracked files (not a guess from two folder levels) and the tickets already there.
async function changeContext(root, tickets) {
  let files = [];
  try {
    const { stdout } = await execFileAsync('git', ['-C', root, 'ls-files'], { maxBuffer: 16 * 1024 * 1024 });
    files = stdout.split('\n').filter(f => f && !f.startsWith('.') && !f.startsWith('node_modules/') && !isSecretLooking(f)).slice(0, 400).map(f => `- ${hideSecretMentions(f)}`);
  } catch { /* not a git project: only the tickets are listed */ }
  const list = tickets.filter(t => t.status !== 'cancelled' && t.type !== 'human').slice(0, 300)
    .map(t => `- ${t.id} ${hideSecretMentions(t.title)} [${t.scopeRefs.join(',')}] writes ${(t.files ?? []).map(hideSecretMentions).join(', ') || 'nothing'}`);
  return { files, tickets: list };
}

const ARRAY_FIELDS = ['scopeRefs', 'acceptance', 'files', 'context', 'contracts', 'tests', 'screens', 'dependsOn', 'steps'];
const isStrings = v => Array.isArray(v) && v.every(x => typeof x === 'string');
const strings = v => (isStrings(v) ? v : []);

export function ticketsFromStageLists(lists, scope, { startAt = 1, packageManager = null } = {}) {
  const keyToId = new Map();
  const tickets = [];
  const errors = [];
  let n = startAt;
  for (const { stage, items } of lists) for (const raw of items) {
    const id = `T-${String(n).padStart(4, '0')}`;
    n += 1;
    if (typeof raw?.key !== 'string' || !raw.key) { errors.push(`${id}: key must be a non-empty string`); continue; }
    const key = `${stage}/${raw.key}`;
    if (keyToId.has(key)) errors.push(`${id}: duplicate key ${raw.key} in ${stage}`);
    else keyToId.set(key, id);
  }
  n = startAt;
  for (const { stage, items } of lists) for (const raw of items) {
    const id = `T-${String(n).padStart(4, '0')}`;
    n += 1;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) { errors.push(`${stage}: ticket ${id} is not an object`); continue; }
    const wrong = [...ARRAY_FIELDS.filter(f => raw[f] !== undefined && !isStrings(raw[f])), ...['title', 'epic'].filter(f => raw[f] !== undefined && typeof raw[f] !== 'string')];
    if (wrong.length) { errors.push(`${id}: ${wrong.join(', ')} must be ${wrong.every(f => ARRAY_FIELDS.includes(f)) ? 'arrays of strings' : 'strings (and lists of strings)'}`); continue; }
    const refs = strings(raw.scopeRefs).map(r => requirementText(scope, r)).filter(Boolean).flatMap(r => [r.text, ...r.acceptance]);
    const text = [raw.title, raw.epic, ...strings(raw.acceptance), ...strings(raw.files), ...refs].filter(x => typeof x === 'string').join('\n');
    const deps = strings(raw.dependsOn).map(k => keyToId.get(`${stage}/${k}`)).filter(Boolean);
    const unknown = strings(raw.dependsOn).filter(k => !keyToId.has(`${stage}/${k}`));
    if (unknown.length) errors.push(`${id}: dependsOn names unknown keys: ${unknown.join(', ')}`);
    const t = {
      id, title: String(raw.title ?? ''), type: raw.type, stage, epic: String(raw.epic ?? 'E-00'),
      scopeRefs: strings(raw.scopeRefs), acceptance: strings(raw.acceptance), files: strings(raw.files),
      context: strings(raw.context), contracts: strings(raw.contracts), tests: strings(raw.tests), ...(strings(raw.screens).length ? { screens: strings(raw.screens) } : {}), dependsOn: deps,
      size: raw.size, risk: raw.risk, sensitive: raw.sensitive === true || isSensitiveText(scope, text),
      status: 'todo',
    };
    if (raw.type === 'human') t.steps = strings(raw.steps);
    if (raw.hard === true) t.hard = true;
    if (raw.skeleton === true) t.skeleton = true;
    if (raw.integration === true) t.integration = true;
    const v = validateTicket(t);
    if (!v.ok) errors.push(`${id}: ${v.errors[0]}`);
    // Format rules the dogfood run needed (contract format, real paths, env template, one package manager).
    if (t.type === 'contract' && !(t.files.length === 1 && /^contracts\/[\w.-]+\.json$/.test(t.files[0]))) errors.push(`${id}: a contract ticket must write exactly one OpenAPI JSON file under contracts/ (for example contracts/api.json); put TypeScript or SQL types in build tickets that depend on it`);
    for (const f of t.files) {
      const base = f.split('/').pop();
      if (base.startsWith('.env')) errors.push(`${id}: ${f} is a reserved name; use env.example.txt for an env template`);
      else if (!f.includes('/') && !ROOT_FILE_OK.test(f)) errors.push(`${id}: ${f} has no folder; give it its real path (for example src/... or supabase/migrations/...)`);
    }
    const other = otherManagerLockfile(t.files, packageManager);
    if (other) errors.push(`${id}: ${other.file} is a ${other.manager} lockfile but the project uses ${packageManager}`);
    tickets.push(t);
  }
  return { tickets, errors };
}

async function readStageFiles(root, runId) {
  const state = await readRunState(root, runId);
  const realRoot = await fs.realpath(root);
  const lists = [];
  const errors = [];
  const notes = [];
  for (const job of state?.jobs ?? []) {
    if (!/^split-S\d+$/.test(job.id)) continue;
    const stage = job.id.slice('split-'.length);
    if (job.status !== 'complete') { errors.push(`${job.id}: ${job.status}${job.error ? ` (${String(job.error).slice(0, 120)})` : ''}`); continue; }
    const output = `${SPLIT_DIR}/${stage}.json`;
    let text = null;
    try {
      const file = await fs.realpath(path.join(root, String(job.workspace ?? ''), output));
      if (file.startsWith(realRoot + path.sep) && (await fs.stat(file)).size <= MAX_SPLIT_BYTES) text = await fs.readFile(file, 'utf8');
      else { errors.push(`${job.id}: output is outside the project or larger than ${MAX_SPLIT_BYTES} bytes`); continue; }
    } catch { /* missing file is reported below */ }
    if (text === null) { errors.push(`${job.id}: no output file`); continue; }
    try {
      const { list: items, repaired } = parseTicketFile(text);
      if (items.length > MAX_STAGE_TICKETS) throw new Error(`more than ${MAX_STAGE_TICKETS} tickets`);
      if (repaired) notes.push(`${job.id}: the ticket file was not valid JSON (python-style quotes or constants); it was repaired`);
      lists.push({ stage, items });
    } catch (error) { errors.push(`${job.id}: ${error.message}`); }
  }
  if (!lists.length && !errors.length) throw fail('scope-run', `run ${runId} has no split jobs`);
  return { lists: lists.sort((a, b) => a.stage.localeCompare(b.stage, 'en', { numeric: true })), errors, notes };
}

function treeReport(scope, tickets) {
  const tree = checkTicketTree({ scope, tickets });
  const noSkeleton = tickets.length >= 30 && !tickets.some(t => t.skeleton);
  const lines = [...(noSkeleton ? ['warning: no skeleton tickets: mark the thin vertical slice (database to API to screen to test) so connection bugs show on day 0'] : []), `coverage ${tree.coveragePct}% | ${tickets.length} tickets | errors ${tree.errors.length} | warnings ${tree.warnings.length}`];
  for (const e of tree.errors.slice(0, 12)) lines.push(`  error ${e.code}: ${e.message}`);
  if (tree.errors.length > 12) lines.push(`  ...and ${tree.errors.length - 12} more`);
  return { tree, lines };
}

async function cmdTemplate(root, { flags }) {
  if (flags.out === undefined) return out(SCOPE_TEMPLATE);
  const target = resolveInside(root, flags.out);
  try { await writeFileSafe(root, rel(path.relative(root, target)), SCOPE_TEMPLATE, { exclusive: true }); }
  catch (error) { if (error.code === 'EEXIST') return out(`${flags.out} already exists; not overwritten`, 1); throw error; }
  return out(`wrote ${flags.out}`);
}

async function cmdCheck(root, { rest }) {
  const { file, scope } = await loadScope(root, rest[0]);
  const result = checkScope(scope);
  const lines = [`${file}: ${scope.requirements.length} requirements, ${scope.stages.length} stages, ${result.findings.length} findings`];
  for (const f of result.findings) lines.push(`  ${f.level} ${f.code}${f.id ? ` ${f.id}` : ''}: ${f.message} -> ${f.fix}`);
  const items = day0Checklist(scope);
  if (items.length) lines.push(`Day 0: ${items.length} outside services need an owner: ${items.map(i => i.service).join(', ')}`);
  return out(lines.join('\n'), result.ok ? 0 : 1);
}

async function cmdSplit(root, { rest, flags }) {
  const { file, scope, hash } = await loadScope(root, rest[0]);
  const checked = checkScope(scope);
  if (!checked.ok) return out(`${file} has errors; run swarm scope check ${file} first`, 1);
  if (!flags.ingest) {
    const led = await readLedger(root);
    if (flags.wire) {
      if (!led) return out('no ticket ledger to wire', 1);
      const unwired = unwiredRequirements(led.tickets);
      // Stages that are already built and done (S1) are not rewired unless --all: their files are final and would only collide with the newer stages.
      const skipped = flags.all === true ? [] : builtRequirements(led.tickets, unwired);
      const reqs = unwired.filter(r => !skipped.includes(r));
      if (!reqs.length) return out(skipped.length ? `nothing to wire: ${skipped.length} requirement(s) are already built and done (${skipped.slice(0, 8).join(', ')}); add --all to wire them too` : 'every requirement with build tickets already has an integration ticket', 1);
      const wire = reqs.map(req => ({ req, stage: scope.requirements.find(r => r.id === req)?.stage, modules: moduleTickets(led.tickets, req) }));
      const manifest = buildSplitManifest(scope, { stage: flags.stage, only: new Set(reqs), layout: await projectLayout(root, scope, await readProfile(root)), wire });
      await writeFileSafe(root, `${SPLIT_DIR}/manifest.json`, `${JSON.stringify(manifest, null, 2)}\n`);
      return out(`wire manifest: integration tickets for ${reqs.length} requirement(s) (${reqs.slice(0, 8).join(', ')}) written to ${SPLIT_DIR}/manifest.json${skipped.length ? `\nskipped ${skipped.length} requirement(s) already built and done: ${skipped.slice(0, 8).join(', ')} (--all includes them)` : ''}\nNext: swarm run ${SPLIT_DIR}/manifest.json, then swarm scope split --ingest RUN --merge --wire`);
    }
    const only = led ? pendingRequirements(scope, led.tickets) : null;
    if (only && !only.size) return out('every requirement already has tickets; nothing to split', 1);
    const manifest = buildSplitManifest(scope, { stage: flags.stage, only, layout: await projectLayout(root, scope, await readProfile(root)), existing: led ? await changeContext(root, led.tickets) : null });
    await writeFileSafe(root, `${SPLIT_DIR}/manifest.json`, `${JSON.stringify(manifest, null, 2)}\n`);
    return out(`split manifest: ${manifest.jobs.length} job(s) written to ${SPLIT_DIR}/manifest.json\nNext: swarm run ${SPLIT_DIR}/manifest.json, then swarm scope split --ingest RUN${led ? ' --merge' : ''}`);
  }
  const existing = await readLedger(root);
  if (existing && existing.scope?.hash !== hash) return out('the scope file changed since the ledger was made; record it with swarm change "reason" first', 1);
  if (existing && !flags.merge) return out('a ticket ledger already exists; use --merge to add tickets, or delete .swarm/project/tickets.json first', 1);
  if (flags.merge && !existing) return out('no ticket ledger to merge into', 1);
  const { lists, errors, notes } = await readStageFiles(root, flags.ingest);
  const profile = await readProfile(root);
  const startAt = existing ? Math.max(0, ...existing.tickets.filter(t => t.id < 'T-9000').map(t => Number(t.id.slice(2)))) + 1 : 1;
  const built = ticketsFromStageLists(lists, scope, { startAt, packageManager: packageManagerOf(profile) });
  const all = [...errors, ...built.errors];
  if (startAt + built.tickets.length > 9000) all.push('too many tickets: ids T-9000 and up are reserved for day 0 tickets');
  if (all.length) return out(`split refused; fix and rerun the failed stages:\n${all.slice(0, 15).map(e => `  ${e}`).join('\n')}`, 1);
  // Integration tickets wait for the module tickets of their requirements; a requirement with modules and no integration ticket is refused.
  if (flags.wire && built.tickets.some(t => t.integration !== true)) return out(`split refused: --wire takes integration tickets only; these are not: ${built.tickets.filter(t => t.integration !== true).map(t => t.title).slice(0, 5).join('; ')}`, 1);
  // A merge adds tickets for the requirements that have none. A worker that rewrites a requirement that is already built is refused whole.
  if (existing && !flags.wire) {
    const pending = pendingRequirements(scope, existing.tickets);
    const stray = built.tickets.filter(t => t.scopeRefs.some(r => !pending.has(r)));
    if (stray.length) return out(`split refused; a change order may only add tickets for requirements that have none (${[...pending].slice(0, 8).join(', ') || 'none'}). These tickets touch other requirements:\n${stray.slice(0, 10).map(t => `  ${t.title} (${t.scopeRefs.join(', ')})`).join('\n')}\nNothing was written; rerun the split job.`, 1);
  }
  addWiringDeps(built.tickets, existing?.tickets ?? []);
  chainSharedFiles(built.tickets, existing?.tickets ?? []);
  const touched = [...new Set(built.tickets.filter(t => t.type === 'build').flatMap(t => t.scopeRefs))];
  const unwired = wiringGaps([...(existing?.tickets ?? []), ...built.tickets], touched);
  if (unwired.length) return out(`split refused; the features are not wired (add an integration ticket per requirement, then split these stages again):\n${unwired.slice(0, 15).map(g => `  ${g.reason}`).join('\n')}`, 1);
  let tickets = built.tickets;
  if (!existing) tickets = [...tickets, ...checklistToTickets(day0Checklist(scope))];
  const base = existing ?? createLedger({ scope: { name: scope.name, version: scope.version, hash, file }, tickets: [] });
  // New tickets are written by a worker, so any earlier approval no longer covers the ticket set.
  const ledger = { ...createLedger({ scope: base.scope, tickets: [...base.tickets, ...tickets] }), wiring: existing ? existing.wiring === true : true, changeOrders: base.changeOrders ?? [], createdAt: base.createdAt, approved: null };
  const { tree, lines } = treeReport(scope, ledger.tickets);
  const structural = tree.errors.filter(e => e.code !== 'uncovered');
  if (structural.length) return out(`split refused; the tickets are inconsistent:\n${lines.join('\n')}`, 1);
  await writeLedger(root, ledger);
  await appendLog(root, { event: flags.merge ? 'split-merge' : 'split', tickets: tickets.length, run: flags.ingest, ok: tree.ok });
  const gaps = tree.ok ? [] : ['Some requirements still have no tickets: run swarm scope split again (it splits only those), then --ingest RUN --merge.'];
  return out([`ledger written: ${tickets.length} tickets added (not approved)`, ...notes.map(n => `note: ${n}`), ...lines, ...gaps, tree.ok ? 'Next: swarm scope approve' : ''].filter(Boolean).join('\n'));
}

async function cmdApprove(root, { rest, flags }) {
  const ledger = await readLedger(root);
  if (!ledger) return out('no ticket ledger; run swarm scope split first', 1);
  const { scope, hash, text, file } = await loadScope(root, rest[0] ?? ledger.scope?.file);
  if (ledger.scope?.hash !== hash) return out('the scope file changed after the split; record it with swarm change "reason" (or re-split)', 1);
  const { tree, lines } = treeReport(scope, ledger.tickets);
  if (!tree.ok) return out(`not approvable:\n${lines.join('\n')}`, 1);
  const uiProfile = await readProfile(root);
  const knownScreens = new Set((uiProfile?.ui?.screens ?? []).map(screen => screen.id));
  const unknownScreens = ledger.tickets.flatMap(t => (t.screens ?? []).filter(id => !knownScreens.has(id)).map(id => `${t.id}: ${id}`));
  if (unknownScreens.length) return out(`not approvable: tickets name screens that are not in the profile ui block: ${unknownScreens.slice(0, 8).join(', ')}`, 1);
  const sizes = contextEnvFor(root, uiProfile).sizes;
  const bigTickets = ledger.tickets.filter(t => t.status !== 'cancelled' && t.type !== 'human' && !sizeTicket(t, { sizes }).ok).map(t => t.id);
  const uiNoScreens = uiProfile?.ui ? ledger.tickets.filter(t => !(t.screens ?? []).length && (t.files ?? []).some(f => /\.(?:tsx|jsx|css|html|vue|svelte)$/.test(f))).length : 0;
  const summary = formatSummary(summarizeTree({ scope, tickets: ledger.tickets }));
  const policy = await readApprovalPolicy(root);
  if (needsHuman(policy, { kind: 'scope' }) && flags.yes !== true) return out(`${summary}\n\nThis needs your approval. Review it, then: swarm scope approve --yes`);
  const by = flags.yes === true ? 'owner' : 'policy';
  const next = approveLedger(ledger, { by });
  next.scope = { ...next.scope, hash, file };
  await writeLedger(root, next);
  await writeFileSafe(root, '.swarm/project/scope.snapshot.md', text);
  await writeFileSafe(root, 'docs/scope/build-plan.md', renderBuildPlan(next, scope));
  // What every ticket is given as context: the overview and the data model, from the scope's own sections.
  const written = [];
  for (const [name, body] of Object.entries(contextFilesOf(scope))) { await writeFileSafe(root, name, body); written.push(name); }
  const missing = scope.context.filter(entry => !existsSync(path.join(root, entry.path))).map(entry => entry.path);
  // Build output must never be committed: the usual ignore lines for the project's stacks (nothing is removed).
  const profile = await readProfile(root);
  const stacks = new Set((profile?.stack ?? []).map(entry => entry.name));
  if (/\b(next\.?js|node|typescript|react|npm)\b/i.test(`${scope.overview}`)) stacks.add('node');
  if (/\b(python|django|fastapi|flask)\b/i.test(`${scope.overview}`)) stacks.add('python');
  const ignored = stacks.size ? await ensureGitignore(root, [...stacks].filter(s => ['node', 'python'].includes(s))).catch(() => ({ changed: false })) : { changed: false };
  await appendLog(root, { event: 'approve', by, scopeHash: hash, ticketsHash: next.approved.ticketsHash });
  return out([summary, '', 'approved. Build plan: docs/scope/build-plan.md', ...(uiNoScreens ? [`warning: ${uiNoScreens} ticket(s) write UI files but name no screens, so the rendered check does not gate them`] : []), ...(bigTickets.length ? [`warning: ${bigTickets.length} ticket(s) may be too big for one worker answer (more than 4 files or large files): ${bigTickets.slice(0, 8).join(', ')}; split them or they escalate to a stronger lane`] : []), `Context files written: ${written.join(', ')}`, ...(missing.length ? [`warning: the scope's Context section names files that do not exist: ${missing.join(', ')}`] : []), ...(ignored.changed ? ['.gitignore: added the build output lines for this stack'] : []), ...(profile?.verify ? [] : [`warning: the profile has no verify block, so tickets are not test-gated (see docs/dogfood-fixes.md)${await detectedTestHint(root)}`]), 'Next: swarm go --scope'].join('\n'));
}

// A failed run or check sends the ticket back to ready one level higher (bigger output, then Codex, then Claude); only after the last level does it block. One locked ledger write.
async function applyRetry(root, id, note, runId) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      return await withLock(root, async () => {
        const ledger = await readLedger(root);
        const ticket = ledger.tickets.find(x => x.id === id);
        if (!ticket || ticket.status !== 'review') return 'skipped';
        const attempts = (ticket.attempts ?? 0) + 1;
        const verifyBound = Boolean((await readProfile(root))?.verify) && ticketTests(ticket).length > 0;
        const step = nextStep(ticket, { error: note, ...(verifyBound ? { maxLevel: 1 } : {}) });
        ticket.attempts = attempts;
        ticket.escalation = step.level;
        const safeNote = redactNote(note);
        ticket.retryNote = safeNote.slice(0, 600);
        ticket.retryHistory = [...(ticket.retryHistory ?? []), { run: runId, note: safeNote.slice(0, 200), level: step.level }].slice(-5);
        ticket.status = step.status;
        if (step.status === 'blocked') ticket.blockReason = 'failure';
        delete ticket.runId;
        ledger.updatedAt = new Date().toISOString();
        await writeLedger(root, ledger);
        await appendLog(root, { event: 'retry', id, attempts, level: step.level, kind: step.kind, to: ticket.status, run: runId, by: 'sync' });
        return ticket.status;
      });
    } catch (error) { if (error.code !== 'scope-busy' || attempt === 4) throw error; await new Promise(resolve => setTimeout(resolve, 300)); }
  }
  return 'skipped';
}

// The test command the project's own package.json points to, as a hint for the profile's verify block.
async function detectedTestHint(root) {
  try {
    const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
    const found = detectTestCommand({ pkg, files: existsSync(path.join(root, 'pyproject.toml')) ? ['pyproject.toml'] : [] });
    return found ? `; detected ${found.runner}: verify.command ${JSON.stringify(found.command)}` : '';
  } catch { return ''; }
}

// A job that failed or was cut off goes back to ready one level higher; after the last level it blocks. Same lock and write as applyRetry.
async function applyEscalation(root, id, note, runId) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      return await withLock(root, async () => {
        const ledger = await readLedger(root);
        const ticket = ledger.tickets.find(x => x.id === id);
        if (!ticket || ticket.status !== 'running') return 'skipped';
        const verifyBound = Boolean((await readProfile(root))?.verify) && ticketTests(ticket).length > 0;
        const step = nextStep(ticket, { error: note, ...(verifyBound ? { maxLevel: 1 } : {}) });
        ticket.attempts = (ticket.attempts ?? 0) + 1;
        ticket.escalation = step.level;
        const safeNote = redactNote(note);
        ticket.retryNote = safeNote.slice(0, 600);
        ticket.retryHistory = [...(ticket.retryHistory ?? []), { run: runId, note: safeNote.slice(0, 200), level: step.level }].slice(-5);
        ticket.status = step.status;
        if (step.status === 'blocked') ticket.blockReason = 'failure';
        ledger.updatedAt = new Date().toISOString();
        await writeLedger(root, ledger);
        await appendLog(root, { event: 'escalate', id, level: step.level, kind: step.kind, to: ticket.status, run: runId, by: 'sync' });
        return ticket.status;
      });
    } catch (error) { if (error.code !== 'scope-busy' || attempt === 4) throw error; await new Promise(resolve => setTimeout(resolve, 300)); }
  }
  return 'skipped';
}

// results.json is evidence: read it once, never through a symlink, and never trust a huge or unreadable one.
async function readUiResultsGuarded(root) {
  try {
    const file = path.join(root, '.swarm', 'ui', 'results.json');
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.size > 1_000_000) return null;
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch { return null; }
}

async function cmdSync(root, { rest, flags }) {
  if (rest.length !== 1) return bad('scope sync needs a run id');
  const ledger = await readLedger(root);
  if (!ledger) return out('no ticket ledger', 1);
  const state = await readRunState(root, rest[0]);
  if (flags.integrated === true) {
    if (!state.integratedAt) return out(`run ${rest[0]} is not integrated yet; run swarm integrate ${rest[0]} first`, 1);
    const finished = new Set((state.jobs ?? []).filter(j => j.status === 'complete').map(j => j.id));
    const queue = state.mergeQueue;
    const integrated = queue ? new Set((queue.integrated ?? []).map(entry => (typeof entry === 'string' ? entry : entry?.job))) : null;
    const failedChecks = new Map((queue?.checkFailed ?? []).map(entry => [entry.job, entry]));
    const profile = await readProfile(root);
    // A profile that names a verify block but does not validate must not turn the test gate off.
    const rawPointer = JSON.parse((await readText(path.join(root, '.project-swarm.json'))) ?? 'null');
    if (rawPointer?.profile?.verify !== undefined && !profile?.verify) {
      const { errors } = validateProfile(rawPointer.profile);
      return out(`the profile has a verify block but the profile is invalid, so tests cannot be checked: ${errors[0] ?? 'unknown error'}`, 1);
    }
    const qualityNames = await runQualityNames(root, rest[0]);
    const profileQuality = (await qualityFor(root, profile)).map(check => check.name).filter(name => !qualityNames.includes(name));
    // A check that fails for many tickets of the same run is the base or the setup, not the tickets: no paid retries for it.
    const reviewCount = ledger.tickets.filter(x => x.status === 'review' && finished.has(x.id)).length;
    const failCounts = new Map();
    for (const entry of failedChecks.values()) for (const name of entry.checks ?? []) failCounts.set(name, (failCounts.get(name) ?? 0) + 1);
    const systemic = name => (failCounts.get(name) ?? 0) >= Math.max(3, Math.ceil(reviewCount / 2));
    // A typecheck or lint check that failed (not one that never ran) goes back to the worker with its errors, like a failed test.
    const qualityResults = new Map();
    let sharedFailures = 0;
    for (const t of ledger.tickets.filter(x => x.status === 'review' && finished.has(x.id) && (x.runId === undefined || x.runId === rest[0]))) {
      if (!qualityNames.length || !['build', 'migration', 'contract'].includes(t.type) || failedChecks.has(t.id) || (integrated && !integrated.has(t.id))) continue;
      const quality = qualityOk(state, t.id, qualityNames);
      qualityResults.set(t.id, quality);
      if (quality.failed) { failCounts.set(quality.check, (failCounts.get(quality.check) ?? 0) + 1); sharedFailures += quality.shared ? 1 : 0; }
    }
    // The same for a failed tests check: back to the worker with the failure, unless it hit many tickets (then it is the base or the setup).
    const testResults = new Map();
    let sharedTestFailures = 0;
    if (profile?.verify) for (const t of ledger.tickets.filter(x => x.status === 'review' && finished.has(x.id) && (x.runId === undefined || x.runId === rest[0]))) {
      if (!ticketTests(t).length || failedChecks.has(t.id) || (integrated && !integrated.has(t.id))) continue;
      const evidence = doneEvidence(state, t.id);
      testResults.set(t.id, evidence);
      if (evidence.failed) { failCounts.set('tests', (failCounts.get('tests') ?? 0) + 1); sharedTestFailures += evidence.shared ? 1 : 0; }
    }
    const done = [], unverified = [], retried = [], blocked = [], notIntegrated = [];
    let uiResults = null, uiTree = null;
    for (const t of ledger.tickets.filter(x => x.status === 'review' && finished.has(x.id) && (x.runId === undefined || x.runId === rest[0]))) {
      const failed = failedChecks.get(t.id);
      if (failed && /no-tests:/.test(String(failed.tail ?? ''))) { unverified.push(`${t.id} (the tests check ran 0 tests: fix verify.command, then run sync again; not retried)`); continue; }
      const common = failed ? (failed.checks ?? []).find(systemic) : null;
      if (failed && common) { unverified.push(`${t.id} (the ${common} check failed for ${failCounts.get(common)} tickets of this run, so the base or the setup is likely at fault; fix it and run sync again; not retried)`); continue; }
      if (failed) {
        // The merge queue rolled this ticket back because its tests failed: it goes back to ready once with the failure, then blocks.
        const note = `failed checks: ${(failed.checks ?? []).join(', ') || 'unknown'}${failed.tail ? `; ${String(failed.tail).slice(0, 500)}` : ''}`;
        const result = await applyRetry(root, t.id, note, rest[0]);
        (result === 'blocked' ? blocked : retried).push(t.id);
        continue;
      }
      if (integrated && !integrated.has(t.id)) { notIntegrated.push(t.id); continue; }
      // A ticket with tests is done only when the runner itself saw them pass (a worker's own report is not evidence).
      if (profile?.verify && ticketTests(t).length) {
        const evidence = testResults.get(t.id) ?? doneEvidence(state, t.id);
        if (evidence.failed && systemic('tests')) { unverified.push(`${t.id} (the tests check failed for ${failCounts.get('tests')} tickets of this run, so the base or the setup is likely at fault; fix it and run sync again; not retried)`); continue; }
        if (evidence.failed && evidence.shared && sharedTestFailures > 1 && !mentionsFiles(t, evidence.tail) && !ticketTests(t).some(f => String(evidence.tail).includes(f))) { unverified.push(`${t.id} (the tests check failed for the whole run and its output does not name this ticket's files; fix it, then run sync again; not retried)`); continue; }
        if (evidence.failed) {
          const result = await applyRetry(root, t.id, `failed checks: tests${evidence.tail ? `; ${String(evidence.tail).slice(-500)}` : ''}`, rest[0]);
          (result === 'blocked' ? blocked : retried).push(t.id);
          continue;
        }
        if (!evidence.ok) { unverified.push(`${t.id} (${evidence.reason})`); continue; }
      }
      // A build ticket is done only when the project's typecheck and lint (and build, when the profile asks) passed on the batch that integrated it.
      if (qualityNames.length && ['build', 'migration', 'contract'].includes(t.type)) {
        const quality = qualityResults.get(t.id) ?? qualityOk(state, t.id, qualityNames);
        if (quality.failed && systemic(quality.check)) { unverified.push(`${t.id} (the ${quality.check} check failed for ${failCounts.get(quality.check)} tickets of this run, so the base or the setup is likely at fault; fix it and run sync again; not retried)`); continue; }
        // A run-wide check (a plain integrate) fails once for every ticket: only the ticket the errors point at is sent back.
        // A batch of one job is exact.
        if (quality.failed && quality.shared && sharedFailures > 1 && !mentionsFiles(t, quality.tail)) { unverified.push(`${t.id} (the ${quality.check} check failed for the whole run and its errors do not name this ticket's files; fix it, then run sync again; not retried)`); continue; }
        if (quality.failed) {
          const result = await applyRetry(root, t.id, `failed checks: ${quality.check}${quality.tail ? `; ${String(quality.tail).slice(-500)}` : ''}`, rest[0]);
          (result === 'blocked' ? blocked : retried).push(t.id);
          continue;
        }
        if (!quality.ok) { unverified.push(`${t.id} (${quality.reason})`); continue; }
      }
      // A UI ticket is done only when the rendered check passed for each of its screens after this run was integrated.
      if ((t.screens ?? []).length) {
        uiResults ??= await readUiResultsGuarded(root);
        uiTree ??= await workTreeFingerprint(root);
        // The verdict must be about exactly the code that is there now (tree), made after the integration, by a server this check started
        // (when the profile has a start command), and not dated in the future.
        const stale = t.screens.filter(id => {
          const r = uiResults?.screens?.[id];
          const at = Date.parse(r?.at);
          return !(profile?.ui && r?.pass === true && Number.isFinite(at) && at >= Date.parse(state.integratedAt) && at <= Date.now() + 60000 && r.tree === uiTree && (r.serverStarted === true || !profile.ui.start));
        });
        if (stale.length) { unverified.push(`${t.id} (${profile?.ui ? `the rendered check has not passed for ${stale.join(', ')} on the current code since the integration: run swarm ui check` : 'it names screens but the profile has no ui block'})`); continue; }
      }
      await lockedTransition(root, t.id, 'done', { by: 'sync', note: `integrated ${rest[0]}` });
      done.push(t.id);
    }
    await refreshPlan(root);
    return out([`${done.length} ticket(s) marked done`,
      ...(retried.length ? [`${retried.length} ticket(s) back to ready, one level higher, after failed checks: ${retried.join(', ')}`] : []),
      ...(blocked.length ? [`${blocked.length} ticket(s) blocked after every escalation level failed: ${blocked.join(', ')}`] : []),
      ...(unverified.length ? [`${unverified.length} ticket(s) stay in review: their tests were not seen passing: ${unverified.join('; ')}`] : []),
      ...(notIntegrated.length ? [`${notIntegrated.length} ticket(s) stay in review: not integrated by this run: ${notIntegrated.join(', ')}`] : []),
      ...(profileQuality.length ? [`warning: the profile now asks for ${profileQuality.join(', ')}, which this run's batches did not run`] : []),
      ...(!profile?.verify && ledger.tickets.some(x => ticketTests(x).length) ? ['warning: the profile has no verify block, so tickets with tests were marked done without test evidence'] : [])].join('\n'));
  }
  // Only the run a ticket was handed to may move it: an older run synced again must not touch a ticket that a newer wave is running.
  const fromThisRun = t => !t.waveAt || !state.startedAt || Date.parse(state.startedAt) >= Date.parse(t.waveAt) - 2000;
  const moves = ticketOutcome(state.jobs ?? [], ledger).filter(m => { const t = ledger.tickets.find(x => x.id === m.id); return t?.status === 'running' && fromThisRun(t); });
  const escalated = [], stuck = [];
  for (const m of moves) {
    if (m.to === 'blocked' && m.reason === 'deps') await lockedTransition(root, m.id, 'blocked', { by: 'sync', note: m.note, reason: 'deps' });
    else if (m.to === 'blocked') {
      // A failed or truncated job goes back up the ladder instead of waiting for a person.
      const result = await applyEscalation(root, m.id, m.note, rest[0]);
      (result === 'blocked' ? stuck : escalated).push(m.id);
    } else await lockedTransition(root, m.id, m.to, { by: 'sync', note: m.note });
  }
  if (moves.some(m => m.to === 'review')) {
    // The ticket remembers which run handed it in, so an older run cannot decide it later.
    const fresh = await readLedger(root);
    for (const m of moves) if (m.to === 'review') fresh.tickets.find(x => x.id === m.id).runId = rest[0];
    await writeLedger(root, fresh);
  }
  await refreshPlan(root);
  const review = moves.filter(m => m.to === 'review').length;
  return out(`${review} ticket(s) in review${escalated.length ? `, ${escalated.length} sent back to ready one level higher (${escalated.join(', ')})` : ''}${stuck.length ? `, ${stuck.length} blocked after every level failed (${stuck.join(', ')})` : ''}. After swarm integrate ${rest[0]}: swarm scope sync ${rest[0]} --integrated`);
}

// The OpenAPI file a contract ticket wrote: contracts/api.json or contracts/openapi.json, else the only .json a contract ticket names.
async function detectContractFile(root) {
  for (const candidate of ['contracts/api.json', 'contracts/openapi.json']) if (await readText(path.join(root, candidate)) !== null) return candidate;
  const ledger = await readLedger(root);
  const named = [...new Set((ledger?.tickets ?? []).filter(t => t.type === 'contract').flatMap(t => t.files ?? []).filter(f => f.endsWith('.json')))];
  return named.length === 1 ? named[0] : null;
}

async function cmdContracts(root, { rest, flags }) {
  const given = rest[0] ?? await detectContractFile(root);
  if (!given || rest.length > 1) return bad('scope contracts needs an OpenAPI JSON file (or contracts/api.json from a contract ticket)');
  const text = await readText(resolveInside(root, given));
  if (text === null) return out(`no file ${given}`, 1);
  let doc;
  try { doc = JSON.parse(text); } catch { return out(`${given} is not valid JSON (YAML and TypeScript are not supported: a contract ticket must write OpenAPI JSON)`, 1); }
  const checked = validateOpenApi(doc);
  if (!checked.ok) return out(`contract invalid:\n${checked.errors.slice(0, 10).map(e => `  ${e}`).join('\n')}`, 1);
  const files = contractFiles(doc);
  const existing = [];
  for (const name of Object.keys(files)) if (await readText(path.join(root, name)) !== null) existing.push(name);
  const policy = await readApprovalPolicy(root);
  if ((existing.length || needsHuman(policy, { kind: 'contracts' })) && flags.yes !== true) {
    return out(`${existing.length ? `would overwrite: ${existing.join(', ')}\n` : ''}Generating contracts needs your approval: swarm scope contracts ${given} --yes`, 1);
  }
  for (const [name, body] of Object.entries(files)) await writeFileSafe(root, name, body);
  // The generated mock must pass the generated contract tests before anyone builds against it.
  const check = await verifyContracts(root).catch(error => ({ ok: false, failures: [], detail: [String(error.message).slice(0, 200)], tail: '' }));
  const names = Object.keys(files).join(', ');
  if (!check.ok) return out(`generated ${Object.keys(files).length} files: ${names}\nSELF-CHECK FAILED: the generated mock does not pass its own contract tests${check.failures.length ? `: ${check.failures.join(', ')}` : ''}\n${check.detail.slice(0, 5).map(d => `  ${d}`).join('\n')}`, 1);
  return out(`generated ${Object.keys(files).length} files: ${names}\nself-check passed: the mock answers every operation with a body that matches its schema\nRun the mock: node -e "import('./contracts/mock-server.mjs').then(m=>m.createMockServer({port:4010}))"`);
}

async function refreshPlan(root) {
  const ledger = await readLedger(root);
  const text = await readText(path.join(root, ...SNAPSHOT));
  if (ledger && text) await writeFileSafe(root, 'docs/scope/build-plan.md', renderBuildPlan(ledger, parseScope(text)));
}

const row = t => `${t.id} ${t.status.padEnd(9)} ${t.stage} ${t.risk.padEnd(6)} ${t.type.padEnd(9)} ${t.title}`;

// One-time migration for ledgers made before blockReason existed: a blocked ticket with no reason, no attempts, no retry note and
// dependencies was blocked by its dependencies (its job was skipped). Marking it `deps` lets it unlock by itself; ready ones unlock now.
async function markDepsCommand(root, ledger, ids, flags) {
  const wanted = ids.length ? new Set(ids) : null;
  const eligible = t => t.status === 'blocked' && !t.blockReason && !t.attempts && !t.retryNote && (t.dependsOn ?? []).length > 0;
  const candidates = ledger.tickets.filter(t => eligible(t) && (!wanted || wanted.has(t.id)));
  const refused = wanted ? [...wanted].filter(id => !candidates.some(t => t.id === id)) : [];
  if (refused.length) return out(`not eligible (not blocked, already has a reason, failed before, or no dependencies): ${refused.join(', ')}`, 1);
  if (!candidates.length) return out('no old blocked tickets to mark (a blocked ticket needs no reason, no failed attempts and dependencies)');
  const list = candidates.map(t => `${t.id}  waits on ${t.dependsOn.join(', ')}`);
  if (flags.yes !== true) return out([`${candidates.length} blocked ticket(s) with no recorded reason look dependency-blocked:`, ...list.slice(0, 60), ...(list.length > 60 ? [`...and ${list.length - 60} more`] : []), '', 'Mark them as dependency-blocked (they unlock when their dependencies are done): rerun with --yes. Name ticket ids to mark only those.'].join('\n'));
  const ours = new Set(candidates.map(t => t.id));
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const result = await withLock(root, async () => {
        const fresh = await readLedger(root);
        for (const t of fresh.tickets) if (ours.has(t.id) && eligible(t)) t.blockReason = 'deps';
        const { ledger: next, unlocked } = unlockReady(fresh);
        next.updatedAt = new Date().toISOString();
        await writeLedger(root, next);
        await appendLog(root, { event: 'mark-deps', by: 'owner', tickets: [...ours], unlocked });
        return unlocked;
      });
      await refreshPlan(root);
      return out(`${ours.size} ticket(s) marked as blocked by dependencies; ${result.length} unlocked now${result.length ? ` (${result.slice(0, 20).join(', ')})` : ''}. The others unlock when their dependencies are done (swarm go --scope and autopilot check).`);
    } catch (error) { if (error.code !== 'scope-busy' || attempt === 4) throw error; await new Promise(resolve => setTimeout(resolve, 300)); }
  }
  return out('another swarm go --scope is starting a wave; try again in a minute', 1);
}

// Lesson 17: the file lists of a ticket can be changed by a command. Your --yes is the approval: an approved ledger is sealed again over the new lists.
async function editTicketFiles(root, ledger, rest, flags) {
  if (rest.length !== 1) return bad('tickets --files/--context/--tests needs one ticket id');
  const list = v => [...new Set(String(v).split(',').map(x => x.trim()).filter(Boolean))];
  const changes = {};
  for (const key of ['files', 'context', 'tests']) if (flags[key] !== undefined) changes[key] = list(flags[key]);
  try { return await withLock(root, async () => {
    const fresh = await readLedger(root);
    const ticket = fresh.tickets.find(x => x.id === rest[0]);
    if (!ticket) return out(`no ticket ${rest[0]}`, 1);
    if (!['todo', 'ready', 'blocked'].includes(ticket.status)) return out(`${ticket.id} is ${ticket.status}; only a todo, ready or blocked ticket can change its files (send a review ticket back with swarm tickets ${ticket.id} --set todo first)`, 1);
    const next = { ...ticket, ...changes };
    const v = validateTicket(next);
    if (!v.ok) return out(`refused: ${v.errors[0]}`, 1);
    const problems = [];
    for (const key of ['context', 'tests']) for (const f of next[key] ?? []) if (f.split('/').pop().startsWith('.env') && !(key === 'context' && isExampleFile(f))) problems.push(`${f} is a reserved name and cannot be in ${key}`);
    for (const f of next.files ?? []) {
      const base = f.split('/').pop();
      if (base.startsWith('.env')) problems.push(`${f} is a reserved name; use env.example.txt for an env template`);
      else if (!f.includes('/') && !ROOT_FILE_OK.test(f)) problems.push(`${f} has no folder; give it its real path`);
      const owner = fresh.tickets.find(x => x.id !== ticket.id && x.status !== 'cancelled' && (x.files ?? []).includes(f));
      if (owner) problems.push(`${f} is already written by ${owner.id}`);
    }
    if (next.integration === true && !(next.tests ?? []).length) problems.push('an integration ticket needs a route-level test');
    if (problems.length) return out(`refused:\n${problems.map(x => `  ${x}`).join('\n')}`, 1);
    const summary = Object.keys(changes).map(k => `  ${k}: ${(ticket[k] ?? []).join(', ') || 'none'}  ->  ${next[k].join(', ') || 'none'}`).join('\n');
    if (flags.yes !== true) return out(`${ticket.id}:\n${summary}\nRerun with --yes to apply${isApproved(fresh) ? ' (the approval is renewed over the new lists)' : ''}.`);
    const wasApproved = isApproved(fresh);
    fresh.tickets = fresh.tickets.map(x => (x.id === ticket.id ? next : x));
    const saved = wasApproved ? approveLedger(fresh, { by: 'owner' }) : fresh;
    saved.updatedAt = new Date().toISOString();
    await writeLedger(root, saved);
    await appendLog(root, { event: 'ticket-edit', id: ticket.id, by: 'owner', fields: Object.keys(changes), before: Object.fromEntries(Object.keys(changes).map(k => [k, ticket[k] ?? []])), after: changes, reapproved: wasApproved });
    await refreshPlan(root);
    return out(`${ticket.id} updated:\n${summary}${wasApproved ? '\nThe ledger stays approved (sealed again over the new lists).' : ''}`);
  }); } catch (error) { if (error.code === 'scope-busy') return out('another swarm go --scope is starting a wave; try again in a minute', 1); throw error; }
}

export async function runTicketsCommand(root, args) {
  const { flags, rest } = parseArgs(args);
  const ledger = await readLedger(root);
  if (!ledger) return out('no ticket ledger; run swarm scope split first', 1);
  if (flags['mark-deps']) return markDepsCommand(root, ledger, rest, flags);
  if (flags.files !== undefined || flags.context !== undefined || flags.tests !== undefined) return editTicketFiles(root, ledger, rest, flags);
  if (flags.set !== undefined) {
    if (rest.length !== 1) return bad('tickets --set needs one ticket id');
    if (!STATUSES.includes(flags.set)) return out(`status must be one of: ${STATUSES.join(', ')}`, 1);
    const t = await lockedTransition(root, rest[0], flags.set, { by: 'owner', note: flags.note });
    await refreshPlan(root);
    return out(`${t.id} is now ${t.status}`);
  }
  if (rest.length === 1) {
    const t = ledger.tickets.find(x => x.id === rest[0]);
    if (!t) return out(`no ticket ${rest[0]}`, 1);
    return out(flags.json ? JSON.stringify(t, null, 2) : [row(t), `refs: ${t.scopeRefs.join(', ') || 'none'}`, `depends on: ${t.dependsOn.join(', ') || 'none'}`, `files: ${t.files.join(', ') || 'none'}`, ...t.acceptance.map(a => `  - ${a}`), ...(t.steps ?? []).map(s => `  * ${s}`)].join('\n'));
  }
  const list = filterTickets(ledger.tickets, { stage: flags.stage, status: flags.status, type: flags.type, risk: flags.risk });
  if (flags.json) return out(JSON.stringify(list));
  const stats = ledgerStats(ledger);
  return out([`${stats.total} tickets, ${stats.percentDone}% done, ${isApproved(ledger) ? 'approved' : 'not approved'}`, ...list.slice(0, 200).map(row), ...(list.length > 200 ? [`...and ${list.length - 200} more (use --stage or --status)`] : [])].join('\n'));
}

async function cmdChange(root, { rest, flags }) {
  const reason = rest[0];
  if (!reason) return bad('change needs a reason in quotes');
  const ledger = await readLedger(root);
  if (!ledger || !isApproved(ledger)) return out('change orders need an approved ledger', 1);
  const snapshot = await readText(path.join(root, ...SNAPSHOT));
  if (snapshot === null || scopeHash(snapshot) !== ledger.scope?.hash) return out('the approved scope snapshot is missing or does not match the ledger; re-approve the scope', 1);
  const cur = await loadScope(root, rest[1] ?? ledger.scope?.file);
  if (cur.hash === ledger.scope.hash) return out('the scope file has not changed since approval', 1);
  const checked = checkScope(cur.scope);
  if (!checked.ok) return out(`the new scope has errors; run swarm scope check ${cur.file}`, 1);
  const diff = diffScopes(parseScope(snapshot), cur.scope);
  const impact = impactAnalysis({ diff, tickets: ledger.tickets });
  const reset = impact.dependentsReset?.length ?? 0;
  const summary = [`change order: +${diff.added.length} added, -${diff.removed.length} removed, ~${diff.changed.length} changed requirements`,
    `cancels ${impact.cancel.length} tickets, reopens ${impact.reopen.length}${reset ? ` (and resets ${reset} that depend on them)` : ''}, needs tickets for ${impact.needTickets.length} requirements (about ${impact.estimate.newTickets} tickets, about $${impact.estimate.usd.toFixed(2)})`].join('\n');
  const policy = await readApprovalPolicy(root);
  const big = needsHuman(policy, { kind: 'change-order', usd: impact.estimate.usd });
  if (flags.yes !== true) return out(`${summary}\nReview it, then rerun with --yes to record it${big ? ' (over the change-order limit: needs you)' : ''}.`);
  const id = nextChangeOrderId(ledger);
  // Your --yes covers this change order, so the changed ledger stays approved; history is kept (old snapshot under the order id).
  const next = approveLedger(applyChangeOrder(ledger, { impact, diff, reason, by: 'owner', scope: { name: cur.scope.name, version: cur.scope.version, hash: cur.hash, file: cur.file } }), { by: 'owner' });
  await writeFileSafe(root, `.swarm/project/scope.snapshot.${id}.md`, snapshot);
  await writeLedger(root, next);
  await writeFileSafe(root, '.swarm/project/scope.snapshot.md', cur.text);
  await appendLog(root, { event: 'change-order', id, reason, cancelled: impact.cancel.length, reopened: impact.reopen.length });
  await refreshPlan(root);
  const need = impact.needTickets.length ? `\nNew tickets are needed for ${impact.needTickets.join(', ')}: swarm scope split, run it, then swarm scope split --ingest RUN --merge` : '';
  return out(`${summary}\nrecorded ${id}.${need}`);
}

export async function runScopeCommand(root, command, args) {
  try {
    const parsed = parseArgs(args);
    if (command === 'tickets') return await runTicketsCommand(root, args);
    if (command === 'change') return await cmdChange(root, parsed);
    const [verb, ...more] = args;
    const sub = parseArgs(more);
    if (verb === 'template') return await cmdTemplate(root, sub);
    if (verb === 'check') return await cmdCheck(root, sub);
    if (verb === 'split') return await cmdSplit(root, sub);
    if (verb === 'approve') return await cmdApprove(root, sub);
    if (verb === 'sync') return await cmdSync(root, sub);
    if (verb === 'contracts') return await cmdContracts(root, sub);
    return bad(verb ? `unknown scope command: ${verb}` : 'scope needs a command');
  } catch (error) {
    if (error.code && /^(scope|ticket|ledger|approval)/.test(error.code)) return out(`${error.code}: ${error.message}`, 1);
    throw error;
  }
}

// One `swarm go --scope` at a time: an exclusive lock file; a lock older than ten minutes is taken over.
async function withLock(root, fn) {
  const dir = await safeWritableDir(root, ['.swarm', 'project']);
  const lock = path.join(dir, 'scope-go.lock');
  let handle = null;
  for (let attempt = 0; attempt < 2 && !handle; attempt += 1) {
    try { handle = await fs.open(lock, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const stat = await fs.lstat(lock).catch(() => null);
      if (stat && Date.now() - stat.mtimeMs > LOCK_STALE_MS) await fs.rm(lock, { force: true });
      else throw fail('scope-busy', 'another swarm go --scope is starting a wave; try again in a minute');
    }
  }
  if (!handle) throw fail('scope-busy', 'could not take the wave lock');
  try { return await fn(); } finally { await handle.close().catch(() => {}); await fs.rm(lock, { force: true }); }
}

// `swarm go --scope`: builds a manifest from the ready tickets, marks them running (one ledger write) and
// returns the manifest path for the normal go path. Refuses an unapproved ledger, a ticket set changed since
// approval, or a scope file that is missing or changed since approval.
export async function prepareScopeRun(root, { maxJobs, now = Date.now, lessons = [], skipSkeleton = false, validate } = {}) {
  return withLock(root, async () => {
    const ledger = await readLedger(root);
    if (!ledger) throw fail('ledger-missing', 'no ticket ledger; run swarm scope split first');
    if (!isApproved(ledger)) throw fail('ledger-unapproved', 'the ticket ledger is not approved (or its tickets or scope changed since); run swarm scope approve');
    const file = ledger.scope?.file ?? DEFAULT_SCOPE_FILE;
    const current = await readText(resolveInside(root, file));
    if (current === null) throw fail('scope-changed', `the approved scope file ${file} is missing`);
    if (scopeHash(current) !== ledger.scope?.hash) throw fail('scope-changed', 'the scope file changed since approval; record it with swarm change "reason"');
    const snapshot = await readText(path.join(root, ...SNAPSHOT));
    if (snapshot === null || scopeHash(snapshot) !== ledger.scope.hash) throw fail('scope-snapshot', 'the approved scope snapshot is missing or does not match; run swarm scope approve --yes again');
    const scope = parseScope(snapshot);
    // A ticket that was blocked only by dependencies becomes ready as soon as they are done.
    const prune = pruneCancelledDeps(ledger);
    await logPrune(root, prune.pruned, { by: 'go' });
    const unlock = unlockReady(ledger);
    if (unlock.unlocked.length) { ledger.tickets = unlock.ledger.tickets; await appendLog(root, { event: 'unlock', by: 'go', tickets: unlock.unlocked }); }
    // The root tickets of an approved stage (and anything else whose dependencies are done) are released without a hand move.
    const release = releaseReady(ledger);
    if (release.released.length) { ledger.tickets = release.ledger.tickets; await appendLog(root, { event: 'release', by: 'go', tickets: release.released }); }
    let ready = readyTickets(ledger.tickets);
    // Skeleton first: while a skeleton ticket is open, only the skeleton (and what it depends on, and runner-made fix tickets) runs.
    const open = ledger.tickets.filter(t => t.skeleton && !['done', 'cancelled'].includes(t.status));
    if (open.length && !skipSkeleton) {
      const byId = new Map(ledger.tickets.map(t => [t.id, t]));
      const keep = new Set();
      const visit = id => { if (keep.has(id) || !byId.has(id)) return; keep.add(id); for (const d of byId.get(id).dependsOn ?? []) visit(d); };
      for (const t of ledger.tickets.filter(x => x.skeleton)) visit(t.id);
      ready = ready.filter(t => keep.has(t.id) || t.origin === 'ci');
      if (!ready.length) throw fail('scope-skeleton', `the skeleton is not finished (${open.map(t => t.id).slice(0, 5).join(', ')}) and nothing of it is ready${open.some(t => ['running', 'review'].includes(t.status)) ? '; some are running or in review: run swarm scope sync RUN (and --integrated after integrating)' : '; finish or unblock it'}; --skip-skeleton skips skeleton-first for one run`);
    }
    const humans = ready.filter(t => t.type === 'human').length;
    const profile = await readProfile(root);
    const { manifest, warnings, skipped } = ticketsToManifest(ready, { ledger, scope, ready: false, maxJobs, lessons, verify: profile?.verify, quality: await qualityFor(root, profile), packageManager: packageManagerOf(profile), contextEnv: contextEnvFor(root, profile) });
    manifest.jobs = manifest.jobs.filter(j => j.type !== 'human');
    const ids = manifest.jobs.map(j => j.id);
    if (!ids.length) throw fail('scope-nothing', humans ? `only ${humans} human ticket(s) are ready; finish them with swarm tickets ID --set done` : 'no ready tickets');
    // A manifest the runner would refuse must not leave tickets stuck in running: it is validated before any ticket moves.
    if (typeof validate === 'function') {
      // Existing project tests that mention a ticket's files go into that job's context (so the worker sees what they assert); then it is validated again.
      for (let pass = 0; ; pass += 1) {
        try { await validate(manifest); break; } catch (error) {
          const suggested = error?.details?.suggestedIgnoreTests;
          if (!suggested || pass >= 2) throw error;
          for (const job of manifest.jobs) for (const test of (suggested[job.id] ?? []).slice(0, 6)) if (!job.context.includes(test) && !job.outputs.includes(test)) job.context.push(test);
        }
      }
    }
    const before = new Map(ids.map(id => [id, ledger.tickets.find(t => t.id === id).status]));
    const waveAt = new Date(now()).toISOString();
    for (const id of ids) { const started = ledger.tickets.find(t => t.id === id); started.status = 'running'; started.waveAt = waveAt; }
    ledger.updatedAt = new Date(now()).toISOString();
    const waveFile = `docs/scope/waves/wave-${now().toString(36)}.json`;
    await writeLedger(root, ledger);
    try {
      await writeFileSafe(root, waveFile, `${JSON.stringify(manifest, null, 2)}\n`);
    } catch (error) {
      for (const [id, status] of before) ledger.tickets.find(t => t.id === id).status = status;
      await writeLedger(root, ledger);
      throw error;
    }
    await appendLog(root, { event: 'wave', by: 'go', tickets: ids });
    return { file: waveFile, ids, humans, warnings, skipped };
  });
}

// Blocked-by-dependency tickets whose dependencies are all done become ready. Used by go --scope and autopilot; one locked write.
export async function unlockLedger(root) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      return await withLock(root, async () => {
        const ledger = await readLedger(root);
        if (!ledger) return [];
        const pruned = pruneCancelledDeps(ledger).pruned;
        const { ledger: unlockedLedger, unlocked } = unlockReady(ledger);
        const { ledger: next, released } = isApproved(unlockedLedger) ? releaseReady(unlockedLedger) : { ledger: unlockedLedger, released: [] };
        if (!unlocked.length && !released.length && !pruned.length) return [];
        next.updatedAt = new Date().toISOString();
        await writeLedger(root, next);
        await logPrune(root, pruned, { by: 'autopilot' });
        if (released.length) await appendLog(root, { event: 'release', by: 'autopilot', tickets: released });
        if (unlocked.length) await appendLog(root, { event: 'unlock', by: 'autopilot', tickets: unlocked });
        return [...unlocked, ...released];
      });
    } catch (error) { if (error.code !== 'scope-busy' || attempt === 4) return []; await new Promise(resolve => setTimeout(resolve, 300)); }
  }
  return [];
}

// A ticket the runner makes from a failing check (smoke or preview hook). Next free id below T-9000; the approval is not touched (origin 'ci').
export async function addCiFixTicket(root, partial) {
  // Same lock as a wave start; a few short retries, then the ticket is skipped (the caller warns).
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try { return await withLock(root, () => addCiFixTicketLocked(root, partial)); }
    catch (error) { if (error.code !== 'scope-busy' || attempt === 4) throw error; await new Promise(resolve => setTimeout(resolve, 300)); }
  }
  return null;
}

async function addCiFixTicketLocked(root, partial) {
  const ledger = await readLedger(root);
  if (!ledger) return null;
  const wasApproved = isApproved(ledger);
  const used = ledger.tickets.map(t => Number(t.id.slice(2))).filter(n => n < 9000);
  const next = Math.max(0, ...used) + 1;
  if (next >= 9000) return null;
  const ticket = { ...partial, id: `T-${String(next).padStart(4, '0')}` };
  const checked = validateTicket(ticket);
  if (!checked.ok) throw fail('ticket-invalid', checked.errors[0]);
  ledger.tickets.push(ticket);
  ledger.updatedAt = new Date().toISOString();
  // The owner's approval stays valid for this runner-made ticket only if it was valid just before: it is resealed over the new ticket set,
  // and the seal records which tickets were added this way. Any other writer of tickets still loses the approval.
  if (wasApproved) {
    const prev = ledger.approved;
    ledger.approved = { ...approveLedger(ledger, { by: prev.by }).approved, at: prev.at, ciTickets: [...(prev.ciTickets ?? []), ticket.id] };
  }
  await writeLedger(root, ledger);
  await appendLog(root, { event: 'ci-fix-ticket', id: ticket.id, resealed: wasApproved });
  return ticket.id;
}

export async function ticketProgress(root) {
  const ledger = await readLedger(root);
  if (!ledger) return null;
  const s = ledgerStats(ledger);
  return { total: s.total, percentDone: s.percentDone, byStatus: s.byStatus, approved: isApproved(ledger) };
}
