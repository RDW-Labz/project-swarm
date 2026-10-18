// SPDX-License-Identifier: Apache-2.0
// `swarm scope`, `swarm tickets`, `swarm change` and the `go --scope` preparation (Phase 13).
// Pure glue over scope.mjs, tickets.mjs, scope-integrity.mjs, change-orders.mjs, day0.mjs,
// approval-policy.mjs and ticket-manifest.mjs. No model is called here; `scope split` only writes
// a manifest for `swarm run`.
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { SCOPE_TEMPLATE, parseScope, checkScope, scopeHash, requirementText, isSensitiveText } from './scope.mjs';
import { readLedger, writeLedger, appendLog, createLedger, transition, readyTickets, filterTickets, ledgerStats, renderBuildPlan, pruneCancelledDeps, logPrune, approveLedger, isApproved, validateTicket, STATUSES, parseLane, laneText, laneOkForSensitive, TICKET_LANE_AGENTS } from './tickets.mjs';
import { checkTicketTree, summarizeTree, formatSummary } from './scope-integrity.mjs';
import { missingToolConfigs, toolConfigLines, projectFileList, existsIn, e2eSpecWarnings } from './tool-config.mjs';
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
import { doneEvidence, ticketTests, failedRunChecks } from './verify-config.mjs';
import { deriveQualityChecks, qualityEvidence } from './quality-checks.mjs';
import { nextStep, sizeTicket } from './escalation.mjs';
import { unlockReady, releaseReady } from './ticket-unlock.mjs';
import { WIRING_PROMPT, WIRE_ONLY_PROMPT, wiringGaps, addWiringDeps, orderTestsAfterBuild, chainSharedFiles, builtRequirements, looksLikeTestFile, unwiredRequirements, moduleTickets } from './wiring.mjs';
import { parseEnvNames, envNamesLine } from './env-names.mjs';
import { detectTestCommand } from './zero-tests.mjs';
import { execFile } from 'node:child_process';
import { existsSync, statSync, lstatSync, realpathSync, readdirSync, readFileSync } from 'node:fs';
import { promisify } from 'node:util';
import { acceptanceLines, coverage, evaluate, reviewManifest as acceptanceManifest, parseAcceptanceVerdicts, readAcceptanceRecords, writeAcceptanceRecords } from './acceptance.mjs';
import { securityReviewReason, securityReviewManifest, parseReviewVerdicts, filesHash, readReviewRecords, writeReviewRecords } from './security-review.mjs';

export const SCOPE_USAGE = [
  'Usage: swarm scope template [--out FILE]',
  '       swarm scope check [FILE]',
  '       swarm scope split [FILE] [--stage S1] | scope split --wire [--all] | scope split --ingest RUN [--merge] [--wire]',
  '       swarm scope approve [FILE] [--yes]',
  '       swarm scope sync RUN [--integrated] [--accept-unreviewed T-0001 --reason TEXT --yes] [--accept-unmet T-0001 --reason TEXT --yes]',
  '       swarm scope security-review RUN     (records the verdicts of an Opus security review run)',
  '       swarm scope acceptance-review RUN   (records the per-line verdicts of an acceptance review run)',
  '       swarm scope contracts OPENAPI.json',
  '       swarm tickets ID --approve [--yes]     (a ticket made from a gallery comment is proposed: you read it, name its files, approve it; no worker runs it before)',
  '       swarm tickets ID --lane auto|claude|codex|cursor|anthropic[:MODEL] | --risk low|medium|high [--yes]   (logged; an approved ledger is sealed again)',
  '       swarm tickets [ID] [--stage S1] [--status todo] [--type build] [--risk high (filter; with an ID use the --risk line above)] [--set STATUS] [--note TEXT] [--json]',
  '       swarm tickets ID --files a,b [--take-from TICKET] [--deletes x,y] [--dependencies pkg,pkg@^1] [--context c,d] [--tests t] [--acceptance "one || two"] [--add-acceptance TEXT] [--yes]     (change the file lists of a ticket that is not running; keeps an approved ledger approved)',
  '       swarm tickets ID... --release [--note TEXT]     (clean release of held tickets: blocked, todo or review go back to ready with attempts, escalation and retry notes cleared)',
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
const FLAGS_WITH_VALUE = new Set(['--out', '--stage', '--ingest', '--status', '--type', '--risk', '--lane', '--set', '--note', '--max-jobs', '--files', '--context', '--tests', '--accept-failed-check', '--accept-unreviewed', '--accept-unmet', '--reason', '--deletes', '--dependencies', '--acceptance', '--add-acceptance', '--take-from']);
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

// A ledger update under the wave lock, retried while another command holds it.
async function lockedUpdate(root, fn) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try { return await withLock(root, fn); }
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

// The job's proposed outputs are byte for byte what the tree already has (an earlier run or a hand edit put them there): there was nothing to write,
// so the integration has no batch for it. That is not a failure and not a reason to leave the ticket in review.
async function outputsMatchTree(root, state, id) {
  const job = (Array.isArray(state.jobs) ? state.jobs : []).find(j => j.id === id);
  const outputs = Array.isArray(job?.outputs) ? job.outputs : [];
  if (!outputs.length || typeof job.workspace !== 'string' || !job.workspace) return false;
  const base = path.resolve(root);
  const workspace = path.resolve(base, job.workspace);
  const workspaces = path.join(base, '.swarm', 'workspaces') + path.sep;
  // The workspace must be a run workspace (never the project itself), and both files plain regular files inside their own roots.
  if (!workspace.startsWith(workspaces) || workspace === base) return false;
  for (const file of outputs) {
    if (typeof file !== 'string' || !file || path.isAbsolute(file) || file.split('/').includes('..')) return false;
    const mine = path.join(workspace, file), theirs = path.join(base, file);
    if (!mine.startsWith(workspace + path.sep) || !theirs.startsWith(base + path.sep) || mine === theirs) return false;
    try {
      const a = await fs.lstat(mine), b = await fs.lstat(theirs);
      if (!a.isFile() || !b.isFile() || a.isSymbolicLink() || b.isSymbolicLink()) return false;
      if (!(await fs.readFile(mine)).equals(await fs.readFile(theirs))) return false;
    } catch { return false; }
  }
  return true;
}

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
    'files (the files this ticket writes: repo-relative paths WITH their folders, for example src/app/page.tsx or supabase/migrations/0001_init.sql, never a bare file name unless the file really lives at the repo root; never a folder, never an absolute path, never a dot-env file: use env.example.txt for an env template), deletes (existing files this ticket must delete, each named exactly; omit when none), dependencies (new npm packages the ticket needs, like zod or zod@^3.23.0; the runner installs them and the change goes through the security gate; omit when none), context (files it reads), contracts (contract files it uses), tests (the test files that prove this ticket: a build ticket lists the test files owned by its test ticket and depends on that test ticket; a test ticket lists its own), screens (only on UI tickets: the ids of the design screens the ticket renders, from the profile ui screens), dependsOn (keys of other tickets in this file),',
    'size (S or M; never larger: split instead), risk (low, medium or high), sensitive (true for payments, auth or customer data), steps (only for human tickets: 1 to 30 short imperative steps), skeleton (true only on the tickets of the thinnest vertical slice of the first stage: database, API, screen and test, the smallest path through the product; omit it elsewhere).',
    'Rules: every requirement is covered by at least one ticket; every ticket traces to a requirement; two tickets that can run at the same time never write the same file;',
    'put shared types or contracts first and make the tickets that use them depend on them; add a test ticket for each requirement group.',
    'Every build, test and migration ticket has at least one acceptance line (copy the requirement\'s own acceptance line when you have nothing more exact). A test never runs before the module it imports exists: prefer listing a module\'s test files in that build ticket\'s "tests" field over a separate test ticket, and when a separate test ticket is needed it is written to run after the build tickets it tests (the runner orders it after them).',
    'A ticket of type contract writes exactly one OpenAPI 3 JSON file under contracts/ (for example contracts/api.json) using only paths (get, post, put, patch, delete, each with an operationId), components.schemas and local $ref; TypeScript, SQL and YAML types belong in build tickets that depend on the contract ticket.',
    'Migration tickets write DDL only; their tests are separate tickets in a tests folder.',
    'Keep every ticket small enough for one worker answer: at most 4 files, each file under about 12 KB when written; split a bigger feature into several tickets (the output of one worker is capped at about 15 KB per file).',
    'Tools: when an acceptance check or test runs a tool command (supabase, cypress, prisma, drizzle-kit), a ticket must write that tool\'s config file (for example supabase/config.toml, cypress.config.ts) unless the project already has it.',
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

const ARRAY_FIELDS = ['scopeRefs', 'acceptance', 'files', 'context', 'contracts', 'tests', 'screens', 'dependsOn', 'steps', 'deletes', 'dependencies'];
const isStrings = v => Array.isArray(v) && v.every(x => typeof x === 'string');
const strings = v => (isStrings(v) ? v : []);

export function ticketsFromStageLists(lists, scope, { startAt = 1, packageManager = null } = {}) {
  const keyToId = new Map();
  const tickets = [];
  const errors = [];
  const notes = [];
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
  for (const { stage, items } of lists) for (let raw of items) {
    const id = `T-${String(n).padStart(4, '0')}`;
    n += 1;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) { errors.push(`${stage}: ticket ${id} is not an object`); continue; }
    const wrong = [...ARRAY_FIELDS.filter(f => raw[f] !== undefined && !isStrings(raw[f])), ...['title', 'epic'].filter(f => raw[f] !== undefined && typeof raw[f] !== 'string')];
    if (wrong.length) { errors.push(`${id}: ${wrong.join(', ')} must be ${wrong.every(f => ARRAY_FIELDS.includes(f)) ? 'arrays of strings' : 'strings (and lists of strings)'}`); continue; }
    const refs = strings(raw.scopeRefs).map(r => requirementText(scope, r)).filter(Boolean).flatMap(r => [r.text, ...r.acceptance]);
    const text = [raw.title, raw.epic, ...strings(raw.acceptance), ...strings(raw.files), ...refs].filter(x => typeof x === 'string').join('\n');
    const deps = strings(raw.dependsOn).map(k => keyToId.get(`${stage}/${k}`)).filter(Boolean);
    const unknown = strings(raw.dependsOn).filter(k => !keyToId.has(`${stage}/${k}`));
    // A worker sometimes invents dependency keys (a ticket that is not in its file): they are dropped and reported, the split is not refused.
    if (unknown.length) notes.push(`${id}: dropped dependsOn keys that name no ticket in the file: ${unknown.join(', ')}`);
    // A worker (a small model especially) sometimes leaves a TEST ticket without acceptance lines (parts-app lesson 55): they are copied from its
    // requirements' own acceptance, which is what a test checks. A build or migration ticket is not given them (the lines of a requirement are usually route-level
    // and a module cannot meet them before it is wired): it is refused as before. With none to copy, the test ticket is refused too.
    if (raw.type === 'test' && !strings(raw.acceptance).some(a => a.trim())) {
      const copied = strings(raw.scopeRefs).flatMap(r => requirementText(scope, r)?.acceptance ?? []).slice(0, 5);
      if (copied.length) { raw = { ...raw, acceptance: copied }; notes.push(`${id}: no acceptance lines from the worker; copied ${copied.length} from ${strings(raw.scopeRefs).join(', ')}`); }
    }
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
    if (strings(raw.deletes).length) t.deletes = strings(raw.deletes);
    if (strings(raw.dependencies).length) t.dependencies = strings(raw.dependencies);
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
  return { tickets, errors, notes };
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

// Warnings for acceptance checks that run a tool nobody configured (lesson 16).
async function toolConfigWarnings(root, tickets) {
  const lines = toolConfigLines(missingToolConfigs(tickets, await projectFileList(root, execFileAsync), existsIn(root)));
  // Lesson 39: the e2e specs that tickets name must be run by the project's e2e command (the nearest package.json and the config it names).
  const cache = new Map();
  const near = file => {
    let dir = path.posix.dirname(file);
    const key = dir;
    if (cache.has(key)) return cache.get(key);
    let found = null;
    for (;;) {
      try { if (existsSync(path.join(root, dir, 'package.json'))) { found = dir; break; } } catch { /* keep walking */ }
      if (dir === '.' || dir === '') break;
      dir = path.posix.dirname(dir);
    }
    cache.set(key, found);
    return found;
  };
  const infoFor = new Map();
  const scriptsFor = file => {
    const dir = near(file) ?? '.';
    if (infoFor.has(dir)) return infoFor.get(dir);
    let scripts = {}, configText = '';
    try { scripts = JSON.parse(readFileSync(path.join(root, dir, 'package.json'), 'utf8')).scripts ?? {}; } catch { /* no package.json */ }
    const names = ['playwright.config.ts', 'playwright.config.js', 'playwright.config.mjs', 'cypress.config.ts', 'cypress.config.js'];
    for (const value of Object.values(scripts)) for (const m of String(value).matchAll(/--config[ =]+(\S+)/g)) names.push(m[1].replace(/^['"]|['"]$/g, ''));
    for (const name of names) { try { configText += `${readFileSync(path.join(root, dir, name), 'utf8')}\n`; } catch { /* absent */ } }
    const value = { scripts, configText };
    infoFor.set(dir, value);
    return value;
  };
  return [...lines, ...e2eSpecWarnings(tickets, { scriptsFor })];
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
  const led = await readLedger(root).catch(() => null);
  if (led) lines.push(...await toolConfigWarnings(root, led.tickets));
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
  const orderNotes = orderTestsAfterBuild(built.tickets, existing?.tickets ?? []);
  chainSharedFiles(built.tickets, existing?.tickets ?? []);
  const touched = [...new Set(built.tickets.filter(t => t.type === 'build').flatMap(t => t.scopeRefs))];
  const allForWiring = [...(existing?.tickets ?? []), ...built.tickets];
  const unwired = wiringGaps(allForWiring, touched);
  // A requirement with modules and no integration ticket is the common miss of a small model: the split is kept (not thrown away) and the wire manifest is written,
  // so one more run adds the integration tickets. The ledger cannot be approved until they exist. Other wiring gaps (a test missing on an integration ticket) still refuse.
  const needsIntegration = new Set(unwiredRequirements(allForWiring).filter(r => touched.includes(r)));
  // A merge into an APPROVED ledger keeps the old refusal: it would drop the approval of a build that may be running, for tickets that cannot be built yet.
  const hardGaps = unwired.filter(g => !needsIntegration.has(g.req) || (existing && isApproved(existing)));
  if (hardGaps.length) return out(`split refused; the features are not wired (add an integration ticket per requirement, then split these stages again):\n${hardGaps.slice(0, 15).map(g => `  ${g.reason}`).join('\n')}`, 1);
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
  // Requirements the worker left without an integration ticket: the wire manifest is written now, so the next step is one run and one ingest.
  let wireLines = [];
  const missing = [...needsIntegration].filter(r => unwiredRequirements(ledger.tickets).includes(r)).sort();
  if (missing.length) {
    const wire = missing.map(req => ({ req, stage: scope.requirements.find(r => r.id === req)?.stage, modules: moduleTickets(ledger.tickets, req) }));
    const wireManifest = buildSplitManifest(scope, { only: new Set(missing), layout: await projectLayout(root, scope, profile), wire });
    // Its own file: the split manifest the owner may still need is never overwritten.
    await writeFileSafe(root, `${SPLIT_DIR}/wire-manifest.json`, `${JSON.stringify(wireManifest, null, 2)}\n`);
    ledger.pendingWiring = missing;
    await writeLedger(root, ledger);
    wireLines = [`wiring: ${missing.length} requirement(s) have modules but no integration ticket (${missing.slice(0, 8).join(', ')}); the ledger cannot be approved until they do.`, `Next: swarm run ${SPLIT_DIR}/wire-manifest.json, then swarm scope split --ingest RUN --merge --wire`];
  }
  return out([`ledger written: ${tickets.length} tickets added (not approved)`, ...notes.map(n => `note: ${n}`), ...[...built.notes, ...orderNotes].slice(0, 12).map(n => `note: ${n}`), ...(built.notes.length + orderNotes.length > 12 ? [`note: ...and ${built.notes.length + orderNotes.length - 12} more (copied acceptance lines and test ordering are in the ticket log)`] : []), ...lines, ...await toolConfigWarnings(root, ledger.tickets), ...gaps, ...wireLines, tree.ok && !wireLines.length ? 'Next: swarm scope approve' : ''].filter(Boolean).join('\n'));
}

async function cmdApprove(root, { rest, flags }) {
  const ledger = await readLedger(root);
  if (!ledger) return out('no ticket ledger; run swarm scope split first', 1);
  const { scope, hash, text, file } = await loadScope(root, rest[0] ?? ledger.scope?.file);
  if (ledger.scope?.hash !== hash) return out('the scope file changed after the split; record it with swarm change "reason" (or re-split)', 1);
  const { tree, lines } = treeReport(scope, ledger.tickets);
  if (!tree.ok) return out(`not approvable:\n${lines.join('\n')}`, 1);
  // A split that kept requirements without an integration ticket is held here, where it can still be fixed (swarm scope split --wire).
  {
    const unwiredNow = new Set(unwiredRequirements(ledger.tickets));
    const open = [...new Set([...(ledger.wiring === true ? unwiredNow : []), ...(ledger.pendingWiring ?? []).filter(r => unwiredNow.has(r))])].filter(r => !builtRequirements(ledger.tickets, [r]).length).sort();
    if (open.length) return out(`not approvable: ${open.length} requirement(s) have modules but no integration ticket (${open.slice(0, 8).join(', ')}). Run swarm scope split --wire, swarm run docs/scope/split/manifest.json, then swarm scope split --ingest RUN --merge --wire`, 1);
  }
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
  // A snapshot of swarm's own state at every approval (best effort; never blocks the approval).
  try { await (await import('./state-backup.mjs')).createBackup(root, { reason: 'scope approve' }); } catch { /* a failed backup must not undo an approval */ }
  return out([summary, '', 'approved. Build plan: docs/scope/build-plan.md', ...await toolConfigWarnings(root, next.tickets), ...(uiNoScreens ? [`warning: ${uiNoScreens} ticket(s) write UI files but name no screens, so the rendered check does not gate them`] : []), ...(bigTickets.length ? [`warning: ${bigTickets.length} ticket(s) may be too big for one worker answer (more than 4 files or large files): ${bigTickets.slice(0, 8).join(', ')}; split them or they escalate to a stronger lane`] : []), `Context files written: ${written.join(', ')}`, ...(missing.length ? [`warning: the scope's Context section names files that do not exist: ${missing.join(', ')}`] : []), ...(ignored.changed ? ['.gitignore: added the build output lines for this stack'] : []), ...(profile?.verify ? [] : [`warning: the profile has no verify block, so tickets are not test-gated (see docs/dogfood-fixes.md)${await detectedTestHint(root)}`]), 'Next: swarm go --scope'].join('\n'));
}

// A failed run or check sends the ticket back to ready one level higher (bigger output, then Codex, then Claude); only after the last level does it block. One locked ledger write.
// One locked step: count the infrastructure return and put the ticket back to ready, or say 'escalate' after the third in a row.
async function applyInfraReturn(root, id, note) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      return await withLock(root, async () => {
        const ledger = await readLedger(root);
        const ticket = ledger.tickets.find(x => x.id === id);
        if (!ticket || ticket.status !== 'running') return 'skipped';
        const times = (ticket.infraRetries ?? 0) + 1;
        if (times > 3) return 'escalate';
        ticket.infraRetries = times;
        ticket.status = 'ready';
        delete ticket.blockReason;
        ledger.updatedAt = new Date().toISOString();
        await writeLedger(root, ledger);
        await appendLog(root, { event: 'transition', id, from: 'running', to: 'ready', by: 'sync', note: `not the ticket's own failure (${redactNote(String(note)).slice(0, 120)}); same level again, ${times} of 3` });
        return 'ready';
      });
    } catch (error) { if (error.code !== 'scope-busy' || attempt === 4) throw error; await new Promise(resolve => setTimeout(resolve, 300)); }
  }
  return 'skipped';
}

// Block a ticket whose check failed on another ticket's files, with the reason; no attempt, no escalation. A person (or --release) decides.
async function applyForeignBlock(root, id, note) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      return await withLock(root, async () => {
        const ledger = await readLedger(root);
        const ticket = ledger.tickets.find(x => x.id === id);
        if (!ticket || ticket.status !== 'review') return 'skipped';
        ticket.status = 'blocked';
        ticket.blockReason = 'manual';
        ticket.blockNote = redactNote(note).slice(0, 600);
        delete ticket.runId;
        ledger.updatedAt = new Date().toISOString();
        await writeLedger(root, ledger);
        await appendLog(root, { event: 'foreign-failure', id, to: 'blocked', note: ticket.blockNote, by: 'sync' });
        return 'blocked';
      });
    } catch (error) { if (error.code !== 'scope-busy' || attempt === 4) throw error; await new Promise(resolve => setTimeout(resolve, 300)); }
  }
  return 'skipped';
}

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
        delete ticket.infraRetries;
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

// The reminder a second ask carries: the same review again, with the output format spelled out.
export const REVIEW_FORMAT_REMINDER = 'FORMAT REMINDER: your last answer had no result line. Finish with exactly one JSON line and nothing after it: {"reviews":[{"ticket":"T-0001","verdict":"pass","findings":[]}]} with one entry for every ticket listed above; verdict is pass or fail; each finding is {"severity":"high|medium|low","file":"...","line":0,"issue":"...","fix":"..."}.';
export const ACCEPTANCE_FORMAT_REMINDER = 'FORMAT REMINDER: your last answer had no result line. Finish with exactly one JSON line and nothing after it: {"acceptance":[{"ticket":"T-0001","lines":[{"n":1,"verdict":"pass","evidence":"short reason with file and line"}]}]} with an entry for every listed line; verdict is pass or fail.';

// The two review kinds share the machinery: where the manifest lives, the job id prefix, which models count, and the reminder for a second ask.
const SEC_KIND = { dir: 'security-reviews', prefix: 'sec-review-', label: 'security review', models: /^opus$/, reminder: REVIEW_FORMAT_REMINDER, parse: parseReviewVerdicts };
const ACC_KIND = { dir: 'acceptance-reviews', prefix: 'acc-review-', label: 'acceptance review', models: /^(sonnet|opus)$/, reminder: ACCEPTANCE_FORMAT_REMINDER, parse: parseAcceptanceVerdicts };

// The response of a finished review run, checked the same way every time: right job, right model, complete.
async function loadReviewResponse(root, runId, kind = SEC_KIND) {
  const state = await readRunState(root, runId);
  const job = (state.jobs ?? []).find(j => typeof j.id === 'string' && j.id.startsWith(kind.prefix));
  if (!job) return { error: `run ${runId} has no ${kind.label} job` };
  if (!kind.models.test(String(job.model))) return { error: `the ${kind.label} job ran on ${job.model ?? 'an unknown model'}, not ${kind === SEC_KIND ? 'opus' : 'sonnet or opus'}; run the manifest that sync wrote` };
  if (job.status !== 'complete') return { error: `the ${kind.label} job is ${job.status}, not complete; run it again` };
  let text = '';
  try { text = await fs.readFile(path.join(root, '.swarm', 'runs', runId, job.id, 'response.txt'), 'utf8'); } catch { return { error: 'the review has no response to read' }; }
  return { job, text };
}

// Ask the same review once more with the format reminder. Paid, so it is guarded: the manifest is checked first, a marker is written before the
// run, a source review is asked again at most once, and the marker keeps the second run's id so a rerun reads that answer instead of paying again.
async function reAskReview(root, sourceRun, deps, kind = SEC_KIND) {
  if (!RUN_ID.test(sourceRun)) return { asked: false, error: `bad review run id ${sourceRun}` };
  const dir = path.join(root, '.swarm', kind.dir);
  const marker = path.join(dir, `${sourceRun}.retried`);
  let manifest;
  try { manifest = JSON.parse(await fs.readFile(path.join(dir, `${sourceRun}.json`), 'utf8')); } catch { return { asked: false, error: `the review manifest .swarm/${kind.dir}/${sourceRun}.json cannot be read` }; }
  // Exactly the one read-only review job sync wrote; anything else would be paid for before it could be checked.
  const jobs = Array.isArray(manifest?.jobs) ? manifest.jobs : [];
  const only = jobs[0];
  if (jobs.length !== 1 || only?.id !== `${kind.prefix}${sourceRun}`.slice(0, 60) || only.agent !== 'claude' || !kind.models.test(String(only.model)) || only.type !== 'review' || (only.outputs ?? []).length !== 0 || typeof only.prompt !== 'string') return { asked: false, error: `the review manifest is not the single read-only ${kind === SEC_KIND ? 'Opus' : 'Sonnet or Opus'} review job sync wrote` };
  try { await fs.writeFile(marker, `${JSON.stringify({ at: new Date().toISOString() })}\n`, { flag: 'wx' }); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    // Already asked once: the run it started is read, never started again.
    let earlier = null;
    try { earlier = JSON.parse(await fs.readFile(marker, 'utf8')).run ?? null; } catch { earlier = null; }
    return { asked: false, runId: typeof earlier === 'string' && RUN_ID.test(earlier) ? earlier : null };
  }
  only.prompt = `${only.prompt}\n\n${kind.reminder}`;
  let run;
  try { run = await (deps.runReview ?? defaultRunReview)(root, manifest); }
  catch (error) {
    // The project cap refused the re-ask: nothing was asked, so the one allowed re-ask is not used up. The owner raises the cap and syncs again.
    if (['project-cap', 'project-cap-invalid', 'spend-store-locked'].includes(error?.code)) { await fs.rm(marker, { force: true }); return { asked: false, error: error.message }; }
    throw error;
  }
  const runId = typeof run?.id === 'string' && RUN_ID.test(run.id) ? run.id : null;
  if (runId) await fs.writeFile(marker, `${JSON.stringify({ at: new Date().toISOString(), run: runId })}\n`);
  return { asked: true, runId };
}

async function defaultRunReview(root, manifest) {
  const { runManifestChecked } = await import('./swarm.mjs');
  // A hard cap on the second ask (an Opus review of a few files costs well under this).
  return runManifestChecked(root, manifest, () => {}, { maxUsd: 1.5 });
}

const sha256Text = text => createHash('sha256').update(text).digest('hex');

async function setTicketField(root, id, key, value) {
  await lockedUpdate(root, async () => {
    const ledger = await readLedger(root);
    const t = ledger?.tickets.find(x => x.id === id);
    if (!t) return;
    if (value === undefined) delete t[key]; else t[key] = value;
    await writeLedger(root, ledger);
  });
}
const setSecurityReview = (root, id, value) => setTicketField(root, id, 'securityReview', value);

// Marks the tickets of a review that gave no result "review-blocked": they stay in review (never done), and say why, in the ledger, the log and Swarm Watch.
// Tickets that already hold a verdict for the code they have now are left alone, and an older verdict can no longer carry a blocked ticket to done.
async function markReviewBlocked(root, requested, reason, run) {
  const marked = [];
  const records = await readReviewRecords(root);
  await lockedUpdate(root, async () => {
    const ledger = await readLedger(root);
    if (!ledger) return;
    for (const id of Object.keys(requested)) {
      const t = ledger.tickets.find(x => x.id === id);
      if (!t || t.status !== 'review') continue;
      const record = records.tickets[id];
      if (record && record.filesHash === requested[id]) continue;
      t.securityReview = { state: 'blocked', reason, at: new Date().toISOString(), run };
      marked.push(id);
    }
    ledger.updatedAt = new Date().toISOString();
    await writeLedger(root, ledger);
  });
  for (const id of marked) await appendLog(root, { event: 'review-blocked', id, reason, run, by: 'system' });
  return marked;
}

// Records the verdicts of a finished security review run, against the code that is in the tree now.
// A response with no {"reviews":[...]} result is asked for once more with a format reminder; if that is also unusable the tickets are review-blocked.
async function cmdSecurityReview(root, { rest }, deps = {}) {
  if (rest.length !== 1) return bad('scope security-review needs the id of the finished review run');
  if (!/^[A-Za-z0-9._-]{1,80}$/.test(rest[0])) return bad('scope security-review: bad run id');
  const first = await loadReviewResponse(root, rest[0]);
  if (first.error) return out(first.error, 1);
  const job = first.job;
  // The review must be of a manifest sync wrote: its ticket list and the code hashes taken then.
  const sourceRun = job.id.slice('sec-review-'.length);
  let requested;
  try { requested = JSON.parse(await fs.readFile(path.join(root, '.swarm', 'security-reviews', `${sourceRun}.hashes.json`), 'utf8')); } catch { return out(`no review was requested for run ${sourceRun} (sync writes .swarm/security-reviews/${sourceRun}.json); run that manifest first`, 1); }
  // An empty list names no ticket: it is as unusable as no list.
  const usable = text => { const v = parseReviewVerdicts(text); return v && v.length ? v : null; };
  let verdicts = usable(first.text);
  const notes = [];
  let reviewRun = rest[0];
  if (!verdicts) {
    const again = await reAskReview(root, sourceRun, deps);
    if (again.error) notes.push(again.error);
    else if (again.asked || again.runId) {
      notes.push(again.asked ? 'the first answer had no {"reviews":[...]} result: asked once more with the format reminder' : 'the first answer had no {"reviews":[...]} result; the second ask made earlier is read (never asked a third time)');
      const second = again.runId ? await loadReviewResponse(root, again.runId) : { error: 'the second review did not start' };
      if (second.error) notes.push(`second ask: ${second.error}`);
      else if (second.job.id.slice('sec-review-'.length) !== sourceRun) notes.push('second ask: it is not the review of the same source run');
      else { verdicts = usable(second.text); reviewRun = again.runId; }
    }
  }
  if (!verdicts) {
    const reason = 'the security review gave no {"reviews":[...]} result, also when asked again; run the review again (swarm scope sync RUN --integrated writes a new one) or accept the risk with --accept-unreviewed T-0001 --reason TEXT --yes';
    const marked = await markReviewBlocked(root, requested, reason, rest[0]);
    return out([...notes, marked.length ? `review-blocked (not done): ${marked.join(', ')}` : 'no ticket of this review is waiting in review', reason].join('\n'), 1);
  }
  const ledger = await readLedger(root);
  const records = await readReviewRecords(root);
  const lines = [...notes];
  // One entry per ticket, and a fail anywhere wins over a pass.
  const merged = new Map();
  for (const v of verdicts) { const old = merged.get(v.ticket); merged.set(v.ticket, old ? { ticket: v.ticket, verdict: old.verdict === 'fail' || v.verdict === 'fail' ? 'fail' : 'pass', findings: [...old.findings, ...v.findings].slice(0, 10) } : v); }
  const cleared = [];
  for (const v of merged.values()) {
    const t = ledger?.tickets.find(x => x.id === v.ticket);
    if (!t || !Object.hasOwn(requested, t.id)) continue;
    records.tickets[t.id] = { verdict: v.verdict, findings: v.findings, run: reviewRun, at: new Date().toISOString(), filesHash: requested[t.id] };
    lines.push(`${t.id}: ${v.verdict}${v.findings.length ? ` (${v.findings.length} finding${v.findings.length > 1 ? 's' : ''})` : ''}`);
    await appendLog(root, { event: 'security-review', id: t.id, verdict: v.verdict, findings: v.findings.length, run: reviewRun, by: 'owner' });
    if (t.securityReview?.state === 'blocked') cleared.push(t.id);
  }
  await writeReviewRecords(root, records);
  const unnamed = Object.keys(requested).filter(id => !merged.has(id) && ledger?.tickets.find(x => x.id === id)?.status === 'review');
  if (unnamed.length) lines.push(`no verdict for: ${unnamed.join(', ')} (they stay in review; sync writes a new review for them)`);
  // A ticket that now has a verdict is no longer blocked on a missing one.
  if (cleared.length) await lockedUpdate(root, async () => { const l = await readLedger(root); if (!l) return; for (const id of cleared) { const x = l.tickets.find(y => y.id === id); if (x?.securityReview?.state === 'blocked') delete x.securityReview; } await writeLedger(root, l); });
  return out(lines.length ? `security review recorded:\n${lines.map(x => `  ${x}`).join('\n')}\nRun swarm scope sync RUN --integrated to move the passed tickets to done and send the failed ones back.` : 'the review named none of the tickets in this ledger', 0);
}

// Records the per-line verdicts of a finished acceptance review run, against the code that is in the tree now.
// Same shape as the security review: an answer with no {"acceptance":[...]} result is asked for once more, then the tickets stay in review, marked acceptance-blocked.
async function cmdAcceptanceReview(root, { rest }, deps = {}) {
  if (rest.length !== 1) return bad('scope acceptance-review needs the id of the finished review run');
  if (!/^[A-Za-z0-9._-]{1,80}$/.test(rest[0])) return bad('scope acceptance-review: bad run id');
  const first = await loadReviewResponse(root, rest[0], ACC_KIND);
  if (first.error) return out(first.error, 1);
  const sourceRun = first.job.id.slice(ACC_KIND.prefix.length);
  let request;
  try { request = JSON.parse(await fs.readFile(path.join(root, '.swarm', 'acceptance-reviews', `${sourceRun}.hashes.json`), 'utf8')); } catch { return out(`no acceptance review was requested for run ${sourceRun} (sync writes .swarm/acceptance-reviews/${sourceRun}.json); run that manifest first`, 1); }
  const requested = request?.tickets && typeof request.tickets === 'object' ? request.tickets : {};
  // The review must come from the manifest of the latest sync (its token is in the review prompt): a later sync may have changed the code and the hashes.
  let ranManifest = '';
  try { ranManifest = await fs.readFile(path.join(root, '.swarm', 'runs', rest[0], 'manifest.json'), 'utf8'); } catch { ranManifest = ''; }
  if (typeof request?.nonce !== 'string' || !request.nonce || !ranManifest.includes(request.nonce)) return out(`run ${rest[0]} was not made from the latest manifest that sync wrote for run ${sourceRun} (the review token does not match), so its verdicts could be about older code; run .swarm/acceptance-reviews/${sourceRun}.json again`, 1);
  const usable = text => { const v = parseAcceptanceVerdicts(text); return v && v.length ? v : null; };
  let verdicts = usable(first.text);
  const notes = [];
  let reviewRun = rest[0];
  if (!verdicts) {
    const again = await reAskReview(root, sourceRun, deps, ACC_KIND);
    if (again.error) notes.push(again.error);
    else if (again.asked || again.runId) {
      notes.push(again.asked ? 'the first answer had no {"acceptance":[...]} result: asked once more with the format reminder' : 'the first answer had no {"acceptance":[...]} result; the second ask made earlier is read (never asked a third time)');
      const second = again.runId ? await loadReviewResponse(root, again.runId, ACC_KIND) : { error: 'the second review did not start' };
      if (second.error) notes.push(`second ask: ${second.error}`);
      else if (second.job.id.slice(ACC_KIND.prefix.length) !== sourceRun) notes.push('second ask: it is not the review of the same source run');
      else { verdicts = usable(second.text); reviewRun = again.runId; }
    }
  }
  const ledger = await readLedger(root);
  const records = await readAcceptanceRecords(root);
  if (!verdicts) {
    const reason = 'the acceptance review gave no {"acceptance":[...]} result, also when asked again; run the review again (swarm scope sync RUN --integrated writes a new one) or accept the unmet lines with --accept-unmet T-0001 --reason TEXT --yes';
    const marked = [];
    await lockedUpdate(root, async () => {
      const l = await readLedger(root);
      if (!l) return;
      for (const id of Object.keys(requested)) {
        const x = l.tickets.find(y => y.id === id);
        if (!x || x.status !== 'review') continue;
        x.acceptanceBlocked = { reason, at: new Date().toISOString(), run: rest[0] };
        marked.push(id);
      }
      await writeLedger(root, l);
    });
    for (const id of marked) await appendLog(root, { event: 'acceptance-blocked', id, reason, run: rest[0], by: 'system' });
    return out([...notes, marked.length ? `acceptance-blocked (not done): ${marked.join(', ')}` : 'no ticket of this review is waiting in review', reason].join('\n'), 1);
  }
  const lines = [...notes];
  const cleared = [];
  for (const entry of verdicts) {
    const t = ledger?.tickets.find(x => x.id === entry.ticket);
    const asked = requested[entry.ticket];
    if (!t || !asked) continue;
    // Only the lines the review was asked about are taken, each once (a fail beats a pass for the same line).
    const byLine = new Map();
    for (const l of entry.lines) {
      if (!asked.lines.includes(l.n)) continue;
      const old = byLine.get(l.n);
      byLine.set(l.n, old && (old.verdict === 'fail' || l.verdict === 'pass') ? old : l);
    }
    const kept = records.tickets[t.id]?.filesHash === asked.filesHash ? (records.tickets[t.id].lines ?? []).filter(l => !byLine.has(l.n)) : [];
    // Each verdict carries the hash of the line text it judged (the text can be edited later).
    records.tickets[t.id] = { filesHash: asked.filesHash, lines: [...kept, ...[...byLine.values()].map(l => ({ n: l.n, h: asked.lineHashes?.[l.n] ?? '', verdict: l.verdict, evidence: l.evidence }))].sort((a, b) => a.n - b.n), run: reviewRun, at: new Date().toISOString() };
    const pass = [...byLine.values()].filter(l => l.verdict === 'pass').length;
    const fail = byLine.size - pass;
    lines.push(`${t.id}: ${pass} line(s) pass${fail ? `, ${fail} fail` : ''}${asked.lines.length > byLine.size ? `, ${asked.lines.length - byLine.size} not answered` : ''}`);
    await appendLog(root, { event: 'acceptance-review', id: t.id, pass, fail, run: reviewRun, by: 'owner' });
    if (t.acceptanceBlocked) cleared.push(t.id);
  }
  await writeAcceptanceRecords(root, records);
  if (cleared.length) await lockedUpdate(root, async () => { const l = await readLedger(root); if (!l) return; for (const id of cleared) { const x = l.tickets.find(y => y.id === id); if (x) delete x.acceptanceBlocked; } await writeLedger(root, l); });
  return out(lines.length ? `acceptance review recorded:\n${lines.map(x => `  ${x}`).join('\n')}\nRun swarm scope sync RUN --integrated to move the tickets whose lines all pass to done and send the failed ones back.` : 'the review named none of the tickets in this ledger', 0);
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
    // Acceptance is enforced for any project with a profile unless it says enforce:false exactly. A profile that exists but does not validate
    // refuses the sync (it must never switch the gate off); a project with no profile at all (never initialised) is not enforced.
    if (rawPointer?.profile && !profile) {
      const { errors } = validateProfile(rawPointer.profile);
      return out(`the project profile does not validate, so acceptance lines cannot be checked: ${errors[0] ?? 'unknown error'}`, 1);
    }
    const acceptanceOn = Boolean(rawPointer?.profile) && rawPointer.profile.acceptance?.enforce !== false;
    // The owner's ways out are all checked before anything is logged or changed: named, confirmed with --yes, logged.
    // A check that fails for a reason that is not the tickets' (it was already failing on the base):
    const accepted = new Set(String(flags['accept-failed-check'] ?? '').split(',').map(x => x.trim()).filter(Boolean));
    // A security review (Opus unavailable, or the review is judged unneeded). The reason is required and recorded: in the log, on each ticket, and in Swarm Watch.
    const unreviewedOk = new Set(String(flags['accept-unreviewed'] ?? '').split(',').map(x => x.trim()).filter(Boolean));
    const unreviewedReason = typeof flags.reason === 'string' ? Array.from(flags.reason.replace(/[\p{Cc}\p{Cf}]/gu, ' ').replace(/\s+/g, ' ').trim()).slice(0, 400).join('') : '';
    if (accepted.size && flags.yes !== true) return out(`--accept-failed-check ${[...accepted].join(',')} lets tickets reach done while that check fails on run ${rest[0]}. Rerun with --yes to confirm; it is logged.`, 1);
    if (unreviewedOk.size) {
      if (Array.from(unreviewedReason).length < 8) return out(`--accept-unreviewed ${[...unreviewedOk].join(',')} needs --reason TEXT (at least 8 characters: why these tickets may reach done without a security review). Nothing was changed.`, 1);
      if (flags.yes !== true) return out(`--accept-unreviewed ${[...unreviewedOk].join(',')} lets those tickets reach done without a security review (reason: ${unreviewedReason}). Rerun with --yes to confirm; it is logged and shown in swarm watch. A failing review on the current code is never overridden.`, 1);
    }
    // The same for acceptance lines no test covers and no review passed.
    const unmetOk = new Set(String(flags['accept-unmet'] ?? '').split(',').map(x => x.trim()).filter(Boolean));
    if (unmetOk.size) {
      if (Array.from(unreviewedReason).length < 8) return out(`--accept-unmet ${[...unmetOk].join(',')} needs --reason TEXT (at least 8 characters: why these tickets may reach done with acceptance lines unchecked). Nothing was changed.`, 1);
      if (flags.yes !== true) return out(`--accept-unmet ${[...unmetOk].join(',')} lets those tickets reach done with acceptance lines that no passing test covers and no review passed (reason: ${unreviewedReason}). Rerun with --yes to confirm; it is logged. A failing line is never overridden.`, 1);
    }
    if (accepted.size) await appendLog(root, { event: 'accept-failed-check', by: 'owner', run: rest[0], checks: [...accepted], note: flags.note ?? null });
    // The tickets that really skipped a review they needed (filled below); only those are logged and marked.
    const skippedReview = [];
    // Acceptance: every line is covered by a passing test (its tag in a test title) or passed the acceptance review.
    const accRecords = await readAcceptanceRecords(root);
    const accNeed = [];
    const accResults = new Map();
    // Tickets whose tests the runner itself saw pass (not an owner-accepted failure, not output already in the tree).
    const testsSeen = new Set();
    const accSkipped = [];
    const reviewRecords = await readReviewRecords(root);
    const needReview = [];
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
    const inTree = new Set();
    // A failure whose errors name only files that other tickets own is theirs, not this ticket's (T-0091's lint failed on the file T-0090 wrote):
    // no escalation and no attempt for this ticket. It goes to the owner when the owner is in this run; otherwise this ticket is blocked with a clear note.
    const routed = new Set();
    const ownersNamed = (excludeId, tail) => {
      const text = String(tail ?? '');
      if (!text.trim()) return [];
      const live = ledger.tickets.filter(x => x.id !== excludeId && x.status !== 'cancelled' && x.type !== 'human');
      const byPath = live.filter(x => (x.files ?? []).some(f => text.includes(f)));
      if (byPath.length) return byPath;
      const byName = live.filter(x => (x.files ?? []).some(f => text.includes(f.split('/').pop())));
      return byName.length === 1 ? byName : [];
    };
    const routeForeign = async (t, check, tail) => {
      if (!String(tail ?? '').trim() || mentionsFiles(t, tail)) return false;
      const owners = ownersNamed(t.id, tail);
      if (!owners.length) return false;
      const note = `failed checks: ${check}; ${String(tail).slice(-500)}`;
      const sent = [];
      for (const owner of owners.filter(o => o.status === 'review' && finished.has(o.id) && (o.runId === undefined || o.runId === rest[0]))) {
        const result = await applyRetry(root, owner.id, note, rest[0]);
        if (result === 'skipped') continue;
        routed.add(owner.id);
        (result === 'blocked' ? blocked : retried).push(owner.id);
        sent.push(owner.id);
      }
      if (sent.length) { unverified.push(`${t.id} (the ${check} check failed on files of ${sent.join(', ')}, not on its own; the failure went to ${sent.length > 1 ? 'them' : 'that ticket'}, no attempt counted for ${t.id}; run sync again after the fix)`); return true; }
      const blame = owners.map(o => `${o.id} (${o.status})`).join(', ');
      const result = await applyForeignBlock(root, t.id, `the ${check} check failed on files of ${blame}, not on this ticket's own files, and none of them is in run ${rest[0]}: fix those files (reopen the ticket or edit them), then swarm tickets ${t.id} --release; no attempt was counted`);
      if (result === 'blocked') { blocked.push(t.id); return true; }
      return false;
    };
    let uiResults = null, uiTree = null;
    // Tickets with a failed check go first, so a failure that names another ticket's file reaches that ticket before it is marked done.
    const failing = t => Boolean(failedChecks.has(t.id) || qualityResults.get(t.id)?.failed || testResults.get(t.id)?.failed || failedRunChecks(state, t.id, { accepted: [...accepted] }));
    for (const t of ledger.tickets.filter(x => x.status === 'review' && finished.has(x.id) && (x.runId === undefined || x.runId === rest[0])).sort((a, b) => Number(failing(b)) - Number(failing(a)))) {
      if (routed.has(t.id)) continue;
      const failed = failedChecks.get(t.id);
      if (failed && /no-tests:/.test(String(failed.tail ?? ''))) { unverified.push(`${t.id} (the tests check ran 0 tests: fix verify.command, then run sync again; not retried)`); continue; }
      const common = failed ? (failed.checks ?? []).find(systemic) : null;
      if (failed && common) { unverified.push(`${t.id} (the ${common} check failed for ${failCounts.get(common)} tickets of this run, so the base or the setup is likely at fault; fix it and run sync again; not retried)`); continue; }
      if (failed) {
        // The merge queue rolled this ticket back because its tests failed: it goes back to ready once with the failure, then blocks.
        const note = `failed checks: ${(failed.checks ?? []).join(', ') || 'unknown'}${failed.tail ? `; ${String(failed.tail).slice(0, 500)}` : ''}`;
        if (await routeForeign(t, (failed.checks ?? []).join(', ') || 'checks', failed.tail)) continue;
        const result = await applyRetry(root, t.id, note, rest[0]);
        (result === 'blocked' ? blocked : retried).push(t.id);
        continue;
      }
      if (integrated && !integrated.has(t.id)) { notIntegrated.push(t.id); continue; }
      // The test files a ticket names must exist in the tree: a ticket whose tests were never written is not done, whatever the suite says.
      const namedTests = ['build', 'test', 'migration'].includes(t.type) ? [...new Set([...(t.tests ?? []), ...ticketTests(t)])].filter(f => looksLikeTestFile(f) && !/[*?]|\/$/.test(f) && !(t.deletes ?? []).includes(f)) : [];
      const missingAll = namedTests.filter(f => !existsSync(path.join(root, f)));
      // A test file another ticket owns is that ticket's to write: while it is not done, this ticket waits (no retry, no attempt).
      const ownerOf = f => ledger.tickets.find(o => o.id !== t.id && o.status !== 'cancelled' && ((o.files ?? []).includes(f) || (o.type === 'test' && (o.tests ?? []).includes(f))));
      const waiting = missingAll.filter(f => { const o = ownerOf(f); return o && o.status !== 'done'; });
      if (waiting.length) { unverified.push(`${t.id} (waiting for ${[...new Set(waiting.map(f => ownerOf(f).id))].join(', ')} to write ${waiting.join(', ')}; not retried)`); continue; }
      const missingTests = missingAll;
      if (missingTests.length) {
        const result = await applyRetry(root, t.id, `failed checks: named test files missing: ${missingTests.join(', ')}; write them (they are in your outputs) and make them pass`, rest[0]);
        (result === 'blocked' ? blocked : retried).push(t.id);
        continue;
      }
      // A ticket with tests is done only when the runner itself saw them pass (a worker's own report is not evidence).
      if (profile?.verify && ticketTests(t).length) {
        let evidence = testResults.get(t.id) ?? doneEvidence(state, t.id);
        let acceptedFailure = false;
        if (evidence.failed && accepted.has('tests')) { evidence = { ok: true, reason: 'failed tests check accepted by the owner' }; acceptedFailure = true; }
        if (evidence.failed && systemic('tests')) { unverified.push(`${t.id} (the tests check failed for ${failCounts.get('tests')} tickets of this run, so the base or the setup is likely at fault; fix it and run sync again; not retried)`); continue; }
        if (evidence.failed && evidence.shared && sharedTestFailures > 1 && !mentionsFiles(t, evidence.tail) && !ticketTests(t).some(f => String(evidence.tail).includes(f))) { unverified.push(`${t.id} (the tests check failed for the whole run and its output does not name this ticket's files; fix it, then run sync again; not retried)`); continue; }
        if (evidence.failed) {
          if (await routeForeign(t, 'tests', evidence.tail)) continue;
          const result = await applyRetry(root, t.id, `failed checks: tests${evidence.tail ? `; ${String(evidence.tail).slice(-500)}` : ''}`, rest[0]);
          (result === 'blocked' ? blocked : retried).push(t.id);
          continue;
        }
        if (!evidence.ok && !(/not in the integrated files|no merge batch|job not found/.test(String(evidence.reason)) && await outputsMatchTree(root, state, t.id) && inTree.add(t.id))) { unverified.push(`${t.id} (${evidence.reason})`); continue; }
        if (evidence.ok === true && !acceptedFailure) testsSeen.add(t.id);
      }
      // A build ticket is done only when the project's typecheck and lint (and build, when the profile asks) passed on the batch that integrated it.
      if (qualityNames.length && ['build', 'migration', 'contract'].includes(t.type)) {
        let quality = qualityResults.get(t.id) ?? qualityOk(state, t.id, qualityNames);
        if (quality.failed && accepted.has(quality.check)) quality = { ok: true, reason: `failed ${quality.check} check accepted by the owner` };
        if (quality.failed && systemic(quality.check)) { unverified.push(`${t.id} (the ${quality.check} check failed for ${failCounts.get(quality.check)} tickets of this run, so the base or the setup is likely at fault; fix it and run sync again; not retried)`); continue; }
        // A run-wide check (a plain integrate) fails once for every ticket: only the ticket the errors point at is sent back.
        // A batch of one job is exact.
        if (quality.failed && quality.shared && sharedFailures > 1 && !mentionsFiles(t, quality.tail)) { unverified.push(`${t.id} (the ${quality.check} check failed for the whole run and its errors do not name this ticket's files; fix it, then run sync again; not retried)`); continue; }
        if (quality.failed) {
          if (await routeForeign(t, quality.check, quality.tail)) continue;
          const result = await applyRetry(root, t.id, `failed checks: ${quality.check}${quality.tail ? `; ${String(quality.tail).slice(-500)}` : ''}`, rest[0]);
          (result === 'blocked' ? blocked : retried).push(t.id);
          continue;
        }
        if (!quality.ok && !(/not in the integrated files|no merge batch/.test(String(quality.reason)) && await outputsMatchTree(root, state, t.id) && inTree.add(t.id))) { unverified.push(`${t.id} (${quality.reason})`); continue; }
      }
      // Any check that failed on the batch or the run keeps every ticket in it out of done, whatever the check is called and whether or not the ticket has tests.
      const runFailed = failedRunChecks(state, t.id, { accepted: [...accepted] });
      if (runFailed) {
        if (runFailed.single) {
          if (await routeForeign(t, runFailed.names.join(', '), runFailed.tail)) continue;
          const result = await applyRetry(root, t.id, `failed checks: ${runFailed.names.join(', ')}${runFailed.tail ? `; ${runFailed.tail.slice(-500)}` : ''}`, rest[0]);
          (result === 'blocked' ? blocked : retried).push(t.id);
        } else unverified.push(`${t.id} (the ${runFailed.names.join(', ')} check failed ${runFailed.shared ? 'on this run' : 'on its batch'}, so no ticket in it is done; fix it and run sync again; not retried)`);
        continue;
      }
      // A ticket that touches auth, an API route, a migration, a policy or a sensitive path is done only after an Opus review passed on the code that is in the tree now.
      let reviewReason = securityReviewReason(t);
      if (reviewReason && unreviewedOk.has(t.id)) {
        // The owner's word skips a missing review, never a failing one on this code, and never one that already passed.
        const record = reviewRecords.tickets[t.id];
        const now = await filesHash(root, [...(t.files ?? []), ...(t.deletes ?? [])]);
        const failing = record?.verdict === 'fail' && record.filesHash === now;
        const passed = record?.verdict === 'pass' && record.filesHash === now;
        if (!failing && !passed) { skippedReview.push(t.id); reviewReason = null; }
      }
      if (reviewReason) {
        const record = reviewRecords.tickets[t.id];
        const now = await filesHash(root, [...(t.files ?? []), ...(t.deletes ?? [])]);
        // A ticket whose review gave no result stays blocked until a verdict newer than the block arrives (an older pass cannot carry it to done).
        if (t.securityReview?.state === 'blocked' && !(record && Date.parse(record.at) > Date.parse(t.securityReview.at))) { needReview.push({ ticket: t, reason: reviewReason }); continue; }
        if (record?.verdict === 'fail' && record.filesHash === now) {
          const found = (record.findings ?? []).map(f => `${f.severity} ${f.file}${f.line ? `:${f.line}` : ''} ${f.issue}${f.fix ? ` (fix: ${f.fix})` : ''}`).join('; ').slice(0, 500);
          delete reviewRecords.tickets[t.id];
          await writeReviewRecords(root, reviewRecords);
          const result = await applyRetry(root, t.id, `failed checks: security review; ${found || 'the review failed this ticket'}`, rest[0]);
          (result === 'blocked' ? blocked : retried).push(t.id);
          continue;
        }
        if (!(record?.verdict === 'pass' && record.filesHash === now)) { needReview.push({ ticket: t, reason: reviewReason }); continue; }
      }
      // Acceptance: each line of a build, test, migration or contract ticket is covered by a passing test (ACn in a test title) or checked by the acceptance review.
      if (acceptanceOn && ['build', 'test', 'migration', 'contract'].includes(t.type) && t.origin !== 'ci' && acceptanceLines(t).length) {
        // Only real test files (a regular file, no symlink, at most 1 MB) that the tests check runs for this ticket can cover a line.
        const tests = ticketTests(t).filter(f => looksLikeTestFile(f) && !/[*?]|\/$/.test(f));
        const hashTests = [...new Set([...(t.tests ?? []), ...tests])];
        const sources = new Map();
        for (const f of tests) { try { const full = path.join(root, f); const info = lstatSync(full); if (info.isFile() && info.size <= 1_000_000) sources.set(f, readFileSync(full, 'utf8')); } catch { /* missing: nothing covered by it */ } }
        const cov = coverage({ ...t, tests }, sources);
        const hash = await filesHash(root, [...(t.files ?? []), ...(t.deletes ?? []), ...hashTests]);
        // A verdict belongs to the text of the line it judged: after the acceptance text was edited an old verdict for the same number is dropped.
        const lineHash = n => sha256Text(String(t.acceptance?.[n - 1] ?? ''));
        const rec = accRecords.tickets[t.id];
        const record = rec ? { ...rec, lines: (rec.lines ?? []).filter(l => l.h === lineHash(l.n)) } : undefined;
        const ev = evaluate({ ticket: t, cov, record, filesHash: hash, testsPassed: testsSeen.has(t.id), accepted: unmetOk.has(t.id) });
        if (ev.state === 'failed') {
          const found = ev.lines.filter(l => l.verdict === 'fail').map(l => `line ${l.n} "${String(l.line).slice(0, 80)}": ${String(l.evidence).slice(0, 160)}`).join('; ').slice(0, 500);
          delete accRecords.tickets[t.id];
          await writeAcceptanceRecords(root, accRecords);
          const result = await applyRetry(root, t.id, `failed checks: acceptance not met; ${found}`, rest[0]);
          (result === 'blocked' ? blocked : retried).push(t.id);
          continue;
        }
        if (ev.state === 'review') { accNeed.push({ ticket: t, lines: ev.missing, hash, blocked: Boolean(t.acceptanceBlocked) }); continue; }
        accResults.set(t.id, ev.lines);
        if (unmetOk.has(t.id) && ev.lines.some(l => l.verdict === 'missing' || l.verdict === 'pending')) accSkipped.push(t.id);
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
      await lockedTransition(root, t.id, 'done', { by: 'sync', note: inTree.has(t.id) ? `output already in the tree; not re-verified by ${rest[0]}` : `integrated ${rest[0]}` });
      done.push(t.id);
      // A ticket that skipped its security review by the owner's word keeps that fact (and the reason) on the ticket.
      if (accResults.has(t.id)) {
        const results = accResults.get(t.id).map(l => (accSkipped.includes(t.id) && (l.verdict === 'missing' || l.verdict === 'pending') ? { ...l, by: 'owner', verdict: 'accepted', evidence: unreviewedReason } : l));
        await setTicketField(root, t.id, 'acceptanceResults', results.map(l => ({ n: l.n, line: String(l.line).slice(0, 200), by: l.by, verdict: l.verdict, evidence: String(l.evidence ?? '').slice(0, 300) })));
        if (t.acceptanceBlocked) await setTicketField(root, t.id, 'acceptanceBlocked', undefined);
      }
      if (skippedReview.includes(t.id)) await setSecurityReview(root, t.id, { state: 'accepted-unreviewed', reason: unreviewedReason, at: new Date().toISOString(), run: rest[0] });
      else if (t.securityReview?.state === 'blocked') await setSecurityReview(root, t.id, undefined);
    }
    const unmetNow = accSkipped.filter(id => done.includes(id));
    if (unmetNow.length) await appendLog(root, { event: 'accept-unmet', by: 'owner', run: rest[0], tickets: unmetNow, reason: unreviewedReason, note: flags.note ?? null });
    const accReport = [...accResults.entries()].filter(([id]) => done.includes(id)).map(([id, ls]) => `${id} ${ls.map(l => `AC${l.n} ${l.verdict === 'pass' ? `pass (${l.by})` : l.verdict}`).join(', ')}`).join('; ');
    let accLine = null;
    if (accNeed.length) {
      if (`acc-review-${rest[0]}`.length > 60) return out(`run id ${rest[0]} is too long for an acceptance review job id (at most ${60 - 'acc-review-'.length} characters)`, 1);
      const manifest = acceptanceManifest(rest[0], accNeed.map(x => ({ ticket: x.ticket, uncovered: x.lines })), { model: profile?.acceptance?.model ?? 'sonnet' });
      // A fresh token goes into the review prompt and the hashes file: a review run counts only for the sync that wrote this exact manifest.
      const nonce = randomBytes(12).toString('hex');
      for (const job of manifest.jobs) job.prompt = `${job.prompt}\n\nReview token (copy nothing, it only identifies this request): ${nonce}`;
      const file = `.swarm/acceptance-reviews/${rest[0]}.json`;
      await fs.mkdir(path.join(root, '.swarm', 'acceptance-reviews'), { recursive: true });
      await fs.writeFile(path.join(root, file), `${JSON.stringify(manifest, null, 2)}\n`);
      await fs.writeFile(path.join(root, `.swarm/acceptance-reviews/${rest[0]}.hashes.json`), `${JSON.stringify({ nonce, tickets: Object.fromEntries(accNeed.map(x => [x.ticket.id, { filesHash: x.hash, lines: x.lines, lineHashes: Object.fromEntries(x.lines.map(n => [n, sha256Text(String(x.ticket.acceptance?.[n - 1] ?? ''))])) }])) })}\n`);
      accLine = `${accNeed.length} ticket(s) stay in review: acceptance lines no passing test covers (tag the test title with ACn) and no review has passed: ${accNeed.map(x => `${x.ticket.id} (line${x.lines.length > 1 ? 's' : ''} ${x.lines.join(', ')}${x.blocked ? '; acceptance-blocked: the last review gave no result' : ''})`).join('; ')}. Run: swarm run ${file}; then swarm scope acceptance-review <that run id>; then swarm scope sync ${rest[0]} --integrated`;
    }
    // Logged once, after the fact, and only for the tickets that really skipped a review they needed and reached done.
    const acceptedNow = skippedReview.filter(id => done.includes(id));
    if (acceptedNow.length) await appendLog(root, { event: 'accept-unreviewed', by: 'owner', run: rest[0], tickets: acceptedNow, reason: unreviewedReason, note: flags.note ?? null });
    const notAccepted = [...unreviewedOk].filter(id => !acceptedNow.includes(id));
    const notUnmet = [...unmetOk].filter(id => !unmetNow.includes(id));
    let reviewLine = null;
    if (needReview.length) {
      const manifest = await securityReviewManifest(root, rest[0], needReview);
      const file = `.swarm/security-reviews/${rest[0]}.json`;
      await fs.mkdir(path.join(root, '.swarm', 'security-reviews'), { recursive: true });
      await fs.writeFile(path.join(root, file), `${JSON.stringify(manifest, null, 2)}\n`);
      // The code each ticket has right now: a verdict counts only for exactly this code.
      const hashes = {};
      for (const { ticket } of needReview) hashes[ticket.id] = await filesHash(root, [...(ticket.files ?? []), ...(ticket.deletes ?? [])]);
      await fs.writeFile(path.join(root, `.swarm/security-reviews/${rest[0]}.hashes.json`), `${JSON.stringify(hashes)}\n`);
      reviewLine = `${needReview.length} ticket(s) stay in review until an Opus security review passes: ${needReview.map(x => `${x.ticket.id} (${x.reason}${x.ticket.securityReview?.state === 'blocked' ? '; review-blocked: the last review gave no result' : ''})`).join('; ')}. Run: swarm run ${file}; then swarm scope security-review <that run id>; then swarm scope sync ${rest[0]} --integrated`;
    }
    await refreshPlan(root);
    if (done.length) import('./history-hooks.mjs').then(async hooks => hooks.recordStageHistory(root, await readLedger(root))).catch(() => {});
    return out([`${done.length} ticket(s) marked done`,
      ...(notUnmet.length ? [`--accept-unmet: ${notUnmet.join(', ')} had no unmet line to accept (not in this run, not done, no lines unmet, or a failing line, which is never overridden)`] : []),
      ...(notAccepted.length ? [`--accept-unreviewed: ${notAccepted.join(', ')} did not skip a review (not in this run, not done, no review needed, a review already passed, or a failing review on this code: that one is never overridden)`] : []),
      ...(reviewLine ? [reviewLine] : []),
      ...(accLine ? [accLine] : []),
      ...(accReport ? [`acceptance: ${accReport}`] : []),
      ...(inTree.size ? [`${[...inTree].filter(id => done.includes(id)).length} of them on output that was already in the tree (not re-verified by this run): ${[...inTree].filter(id => done.includes(id)).join(', ')}`] : []),
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
  const escalated = [], stuck = [], infra = [];
  for (const m of moves) {
    if (m.to === 'blocked' && m.reason === 'deps') await lockedTransition(root, m.id, 'blocked', { by: 'sync', note: m.note, reason: 'deps' });
    else if (m.to === 'blocked') {
      // A failed or truncated job goes back up the ladder instead of waiting for a person.
      const result = await applyEscalation(root, m.id, m.note, rest[0]);
      (result === 'blocked' ? stuck : escalated).push(m.id);
    } else if (m.infra) {
      // Not the ticket's own failure: back to ready at the same level, at most three times in a row, then it is treated as its own.
      const result = await applyInfraReturn(root, m.id, m.note);
      if (result === 'ready') infra.push(m.id);
      else { const escalation = await applyEscalation(root, m.id, m.note, rest[0]); (escalation === 'blocked' ? stuck : escalated).push(m.id); }
    } else await lockedTransition(root, m.id, m.to, { by: 'sync', note: m.note });
  }
  if (moves.some(m => m.to === 'review')) {
    // The ticket remembers which run handed it in, so an older run cannot decide it later.
    const fresh = await readLedger(root);
    for (const m of moves) if (m.to === 'review') { const t = fresh.tickets.find(x => x.id === m.id); t.runId = rest[0]; delete t.infraRetries; }
    await writeLedger(root, fresh);
  }
  await refreshPlan(root);
  const review = moves.filter(m => m.to === 'review').length;
  return out(`${review} ticket(s) in review${escalated.length ? `, ${escalated.length} sent back to ready one level higher (${escalated.join(', ')})` : ''}${stuck.length ? `, ${stuck.length} blocked after every level failed (${stuck.join(', ')})` : ''}${infra.length ? `, ${infra.length} back to ready at the same level (the failure was not theirs: ${infra.join(', ')})` : ''}. After swarm integrate ${rest[0]}: swarm scope sync ${rest[0]} --integrated`);
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
  if (rest.length !== 1) return bad('tickets --files/--context/--tests/--deletes/--acceptance needs one ticket id');
  const list = v => [...new Set(String(v).split(',').map(x => x.trim()).filter(Boolean))];
  const lines = v => String(v).split(/\n| ;; /).map(x => x.trim()).filter(Boolean);
  const changes = {};
  for (const key of ['files', 'context', 'tests', 'deletes', 'dependencies']) if (flags[key] !== undefined) changes[key] = list(flags[key]);
  const acceptanceEdit = flags.acceptance !== undefined || flags['add-acceptance'] !== undefined;
  // --take-from names one or more tickets (comma separated): a file may have two owners, and the moved paths can be written or deleted by this ticket.
  const takeFromList = flags['take-from'] === undefined ? [] : list(flags['take-from']);
  const takeFrom = takeFromList.join(', ') || null;
  if (takeFrom && changes.files === undefined && changes.deletes === undefined) return bad('tickets --take-from needs --files or --deletes (the files to move to this ticket)');
  try {
    return await withLock(root, async () => {
      const fresh = await readLedger(root);
      const ticket = fresh.tickets.find(x => x.id === rest[0]);
      if (!ticket) return out(`no ticket ${rest[0]}`, 1);
      const listsEdit = Object.keys(changes).length > 0;
      // The file lists only change before the work runs; a review or done ticket may only add acceptance lines (see below).
      const allowed = listsEdit ? ['proposed', 'todo', 'ready', 'blocked'] : ['proposed', 'todo', 'ready', 'blocked', 'review', 'done'];
      if (!allowed.includes(ticket.status)) return out(`${ticket.id} is ${ticket.status}; ${listsEdit ? `only a todo, ready or blocked ticket can change its files (send a review ticket back with swarm tickets ${ticket.id} --set todo first)` : 'only a todo, ready, blocked, review or done ticket can change its acceptance'}`, 1);
      // Acceptance is run as checks: a review or done ticket may only add lines (a replace could weaken what the work is judged against).
      if (flags.acceptance !== undefined && !['proposed', 'todo', 'ready', 'blocked'].includes(ticket.status)) return out(`${ticket.id} is ${ticket.status}: its acceptance can only be added to (--add-acceptance), not replaced`, 1);
      const next = { ...ticket, ...changes };
      if (flags.acceptance !== undefined) next.acceptance = lines(flags.acceptance);
      if (flags['add-acceptance'] !== undefined) next.acceptance = [...(next.acceptance ?? []), ...lines(flags['add-acceptance'])];
      const v = validateTicket(next);
      if (!v.ok) return out(`refused: ${v.errors[0]}`, 1);
      const problems = [];
      const moved = [];
      const sources = [];
      for (const id of takeFromList) {
        const found = fresh.tickets.find(x => x.id === id);
        if (!found || found.id === ticket.id) problems.push(`--take-from ${id}: no such other ticket`);
        else if (['running', 'review', 'cancelled'].includes(found.status)) problems.push(`${found.id} is ${found.status}; its files cannot move`);
        else sources.push(found);
      }
      const sourceIds = new Set(sources.map(x => x.id));
      const movedFrom = new Map();
      for (const key of ['context', 'tests']) for (const f of next[key] ?? []) if (f.split('/').pop().startsWith('.env') && !(key === 'context' && isExampleFile(f))) problems.push(`${f} is a reserved name and cannot be in ${key}`);
      for (const key of ['files', 'deletes']) for (const f of next[key] ?? []) {
        const base = f.split('/').pop();
        if (key === 'files' && base.startsWith('.env')) problems.push(`${f} is a reserved name; use env.example.txt for an env template`);
        else if (key === 'files' && !f.includes('/') && !ROOT_FILE_OK.test(f)) problems.push(`${f} has no folder; give it its real path`);
        if ((ticket[key] ?? []).includes(f)) continue;
        const owners = fresh.tickets.filter(x => x.id !== ticket.id && x.status !== 'cancelled' && ((x.files ?? []).includes(f) || (x.deletes ?? []).includes(f)));
        if (!owners.length) continue;
        // A file can move when every one of its owners is named in --take-from and the role is kept: a written file moves into --files, a deleted file into --deletes (a deletion is never turned into a write).
        if (sources.length && owners.every(o => sourceIds.has(o.id) && (o.files ?? []).includes(f) === (key === 'files'))) { if (!moved.includes(f)) moved.push(f); movedFrom.set(f, owners.map(o => o.id)); continue; }
        const first = owners[0];
        const writes = (first.files ?? []).includes(f);
        problems.push(`${f} is already ${writes ? 'written' : 'deleted'} by ${owners.map(o => o.id).join(', ')}${takeFrom ? ` (not ${takeFrom} alone)` : `; to move it use --take-from ${owners.map(o => o.id).join(',')}`}`);
      }
      if (takeFrom && sources.length === takeFromList.length && !moved.length && !problems.length) problems.push(`${takeFrom} does not own any of the files named in --files/--deletes`);
      const strip = x => ({ ...x, files: (x.files ?? []).filter(f => !(movedFrom.get(f) ?? []).includes(x.id)), ...(x.deletes ? { deletes: x.deletes.filter(f => !(movedFrom.get(f) ?? []).includes(x.id)) } : {}) });
      for (const src of sources) { const mine = moved.filter(f => (movedFrom.get(f) ?? []).includes(src.id)); if (!mine.length) continue; const left = validateTicket(strip(src)); if (!left.ok) problems.push(`${src.id} would no longer be valid without ${mine.join(', ')}: ${left.errors[0]}`); }
      if (next.integration === true && !(next.tests ?? []).some(looksLikeTestFile)) problems.push('an integration ticket needs a route-level test file (in a tests folder, or ending in .test or .spec)');
      if (problems.length) return out(`refused:\n${problems.map(x => `  ${x}`).join('\n')}`, 1);
      const summary = [...Object.keys(changes), ...(acceptanceEdit ? ['acceptance'] : [])].map(k => `  ${k}: ${(ticket[k] ?? []).join(k === 'acceptance' ? ' | ' : ', ') || 'none'}  ->  ${(next[k] ?? []).join(k === 'acceptance' ? ' | ' : ', ') || 'none'}`).join('\n') + (moved.length ? `\n  moves from ${takeFrom}: ${moved.join(', ')} (${takeFrom} no longer ${moved.every(f => sources.some(x => (x.files ?? []).includes(f))) ? 'writes' : 'owns'} ${moved.length > 1 ? 'them' : 'it'}${sources.some(x => x.status === 'done') ? `; ${sources.filter(x => x.status === 'done').map(x => x.id).join(', ')} is done and its tests are not re-run for ${moved.length > 1 ? 'them' : 'it'}` : ''})` : '');
      if (flags.yes !== true) return out(`${ticket.id}:\n${summary}\nRerun with --yes to apply${isApproved(fresh) ? ' (the approval is renewed over the new lists)' : ''}.`);
      const wasApproved = isApproved(fresh);
      fresh.tickets = fresh.tickets.map(x => {
        if (x.id === ticket.id) return next;
        if (sourceIds.has(x.id) && moved.length) return strip(x);
        return x;
      });
      const saved = wasApproved ? approveLedger(fresh, { by: 'owner' }) : fresh;
      saved.updatedAt = new Date().toISOString();
      await writeLedger(root, saved);
      const touched = [...Object.keys(changes), ...(acceptanceEdit ? ['acceptance'] : [])];
      await appendLog(root, { event: 'ticket-edit', id: ticket.id, by: 'owner', fields: touched, before: Object.fromEntries(touched.map(k => [k, ticket[k] ?? []])), after: Object.fromEntries(touched.map(k => [k, next[k] ?? []])), reapproved: wasApproved });
      if (moved.length) await appendLog(root, { event: 'file-move', by: 'owner', from: takeFromList.length === 1 ? takeFromList[0] : takeFromList, to: ticket.id, files: moved, fromStatus: sources.length === 1 ? sources[0].status : Object.fromEntries(sources.map(x => [x.id, x.status])), reapproved: wasApproved });
      await refreshPlan(root);
      return out(`${ticket.id} updated:\n${summary}${wasApproved ? '\nThe ledger stays approved (sealed again over the new lists).' : ''}`);
    });
  } catch (error) { if (error.code === 'scope-busy') return out('another swarm go --scope is starting a wave; try again in a minute', 1); throw error; }
}

// The owner changes a ticket's risk or pins its lane. Both are in the ticket hash, so an approved ledger is sealed again over the change (your --yes is the approval) and the edit is logged.
async function setTicketRoute(root, rest, flags) {
  if (rest.length !== 1) return bad('tickets --lane/--risk needs one ticket id');
  const risk = flags.risk;
  const parsedLane = flags.lane === undefined || flags.lane === 'auto' ? null : parseLane(flags.lane);
  const lane = flags.lane === undefined ? undefined : flags.lane === 'auto' ? 'auto' : laneText(parsedLane) ?? flags.lane;
  const others = ['set', 'files', 'context', 'tests', 'deletes', 'dependencies', 'acceptance', 'add-acceptance', 'take-from', 'json', 'release'].filter(k => flags[k] !== undefined);
  if (others.length) return bad(`tickets --lane/--risk cannot be combined with --${others[0]}; run them one at a time`);
  if (risk !== undefined && !['low', 'medium', 'high'].includes(risk)) return out('risk must be low, medium or high', 1);
  if (lane !== undefined && lane !== 'auto' && !parsedLane) return out(`lane must be auto or one of ${TICKET_LANE_AGENTS.join(', ')} (optionally agent:model, like claude:opus)`, 1);
  try {
    return await withLock(root, async () => {
      const fresh = await readLedger(root);
      const ticket = fresh.tickets.find(x => x.id === rest[0]);
      if (!ticket) return out(`no ticket ${rest[0]}`, 1);
      if (!['proposed', 'todo', 'ready', 'blocked'].includes(ticket.status)) return out(`${ticket.id} is ${ticket.status}; only a proposed, todo, ready or blocked ticket can change its risk or lane (send it back with swarm tickets ${ticket.id} --set todo first)`, 1);
      if (lane !== undefined && lane !== 'auto' && ticket.sensitive === true && !laneOkForSensitive(parsedLane)) return out(`${ticket.id} is sensitive: lane ${lane} is not allowed (cursor only without a model)`, 1);
      const next = { ...ticket };
      if (risk !== undefined) next.risk = risk;
      if (lane !== undefined) { if (lane === 'auto') delete next.lane; else next.lane = lane; }
      const v = validateTicket(next);
      if (!v.ok) return out(`refused: ${v.errors[0]}`, 1);
      const fields = [...(risk !== undefined ? ['risk'] : []), ...(lane !== undefined ? ['lane'] : [])];
      const show = x => String(x ?? 'auto');
      const summary = fields.map(k => `  ${k}: ${show(ticket[k] ?? (k === 'risk' ? undefined : 'auto'))}  ->  ${show(next[k] ?? (k === 'risk' ? undefined : 'auto'))}`).join('\n');
      if (fields.every(k => (ticket[k] ?? null) === (next[k] ?? null))) return out(`${ticket.id}: nothing to change`);
      const wasApproved = isApproved(fresh);
      if (flags.yes !== true) return out(`${ticket.id}:\n${summary}\nRerun with --yes to apply${wasApproved ? ' (the approval is renewed over the change)' : ''}.`);
      fresh.tickets = fresh.tickets.map(x => x.id === ticket.id ? next : x);
      const saved = wasApproved ? approveLedger(fresh, { by: 'owner' }) : fresh;
      saved.updatedAt = new Date().toISOString();
      await writeLedger(root, saved);
      await appendLog(root, { event: 'ticket-edit', id: ticket.id, by: 'owner', fields, before: Object.fromEntries(fields.map(k => [k, ticket[k] ?? null])), after: Object.fromEntries(fields.map(k => [k, next[k] ?? null])), note: flags.note ?? null, reapproved: wasApproved });
      await refreshPlan(root);
      return out(`${ticket.id} updated:\n${summary}${wasApproved ? '\nThe ledger stays approved (sealed again over the change).' : ''}`);
    });
  } catch (error) { if (error.code === 'scope-busy') return out('another swarm go --scope is starting a wave; try again in a minute', 1); throw error; }
}

// A clean release of held tickets: back to ready with the failure history cleared, so the next wave starts them from the first level.
// Only tickets whose dependencies are done can be released; a running, done or cancelled ticket is left alone.
async function releaseTickets(root, ids, flags) {
  if (!ids.length) return bad('tickets --release needs one or more ticket ids');
  try {
    return await withLock(root, async () => {
      const ledger = await readLedger(root);
      const done = new Set(ledger.tickets.filter(t => t.status === 'done').map(t => t.id));
      const released = [], refused = [], logs = [], reviewed = [];
      for (const id of ids) {
        const t = ledger.tickets.find(x => x.id === id);
        if (!t) { refused.push(`${id}: no such ticket`); continue; }
        if (!['blocked', 'todo', 'review'].includes(t.status) || t.type === 'human') { refused.push(`${id}: is ${t.status}${t.type === 'human' ? ' (human)' : ''}, nothing to release`); continue; }
        const waiting = (t.dependsOn ?? []).filter(d => !done.has(d));
        if (waiting.length) { refused.push(`${id}: still waits on ${waiting.join(', ')}`); continue; }
        if (t.status === 'todo' && !isApproved(ledger)) { refused.push(`${id}: the ledger is not approved, so a todo ticket cannot be released`); continue; }
        const from = t.status;
        t.status = 'ready';
        for (const key of ['blockReason', 'attempts', 'escalation', 'retryNote', 'retryHistory', 'runId', 'infraRetries']) delete t[key];
        released.push(id);
        logs.push({ event: 'release', by: 'owner', tickets: [id], from, note: flags.note ?? null });
        if (from === 'review') reviewed.push(id);
      }
      if (released.length) { ledger.updatedAt = new Date().toISOString(); await writeLedger(root, ledger); for (const entry of logs) await appendLog(root, entry); await refreshPlan(root); }
      return out([released.length ? `released ${released.length} ticket(s) to ready: ${released.join(', ')}` : 'nothing released', ...(reviewed.length ? [`warning: ${reviewed.join(', ')} were in review: their output will be built again`] : []), ...refused.map(r => `not released: ${r}`)].join('\n'), refused.length ? 1 : 0);
    });
  } catch (error) { if (error.code === 'scope-busy') return out('another swarm go --scope is starting a wave; try again in a minute', 1); throw error; }
}

export async function runTicketsCommand(root, args) {
  const { flags, rest } = parseArgs(args);
  const ledger = await readLedger(root);
  if (!ledger) return out('no ticket ledger; run swarm scope split first', 1);
  if (flags['mark-deps']) return markDepsCommand(root, ledger, rest, flags);
  if (flags.release === true) return releaseTickets(root, rest, flags);
  if (flags.approve === true) return approveProposed(root, rest, flags);
  if (flags.lane !== undefined || (flags.risk !== undefined && rest.length === 1 && flags.set === undefined)) return setTicketRoute(root, rest, flags);
  if (['files', 'context', 'tests', 'deletes', 'dependencies', 'acceptance', 'add-acceptance', 'take-from'].some(k => flags[k] !== undefined)) return editTicketFiles(root, ledger, rest, flags);
  if (flags.set !== undefined) {
    if (rest.length !== 1) return bad('tickets --set needs one ticket id');
    if (!STATUSES.includes(flags.set)) return out(`status must be one of: ${STATUSES.join(', ')}`, 1);
    if (ledger.tickets.find(t => t.id === rest[0])?.status === 'proposed' && flags.set !== 'cancelled') return out(`${rest[0]} is proposed: approve it with swarm tickets ${rest[0]} --approve (or cancel it with --set cancelled)`, 1);
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

export async function runScopeCommand(root, command, args, deps = {}) {
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
    if (verb === 'security-review') return await cmdSecurityReview(root, sub, deps);
    if (verb === 'acceptance-review') return await cmdAcceptanceReview(root, sub, deps);
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

// The wave builder marked these tickets running; the run never started (a cap, a stop, a refusal), so they go back to ready. Only a still-running ticket moves.
export async function revertWave(root, ids) {
  const back = [];
  for (const id of ids) {
    const ledger = await readLedger(root);
    if (ledger?.tickets.find(t => t.id === id)?.status !== 'running') continue;
    try { await lockedTransition(root, id, 'ready', { by: 'go', note: 'the wave did not start' }); back.push(id); } catch { /* a ticket that cannot move stays for the owner */ }
  }
  if (back.length) await refreshPlan(root);
  return back;
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

// A ticket made from a gallery comment. It lands as `proposed`: outside the plan and the approval hash, never ready, never a job,
// until the owner runs swarm tickets ID --approve. The comment text is untrusted and stays in `notes`; the title and acceptance are fixed text.
export async function addProposedTicket(root, partial) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      return await withLock(root, async () => {
        const ledger = await readLedger(root);
        if (!ledger) return null;
        const used = ledger.tickets.map(t => Number(t.id.slice(2))).filter(n => n < 9000);
        const next = Math.max(0, ...used) + 1;
        if (next >= 9000) throw fail('ticket-ids', 'no ticket ids are left below T-9000');
        const ticket = { ...partial, id: `T-${String(next).padStart(4, '0')}`, status: 'proposed' };
        const checked = validateTicket(ticket);
        if (!checked.ok) throw fail('ticket-invalid', checked.errors[0]);
        ledger.tickets.push(ticket);
        ledger.updatedAt = new Date().toISOString();
        await writeLedger(root, ledger);
        await appendLog(root, { event: 'proposed-ticket', id: ticket.id, origin: ticket.origin, source: ticket.source ?? null });
        return ticket.id;
      });
    } catch (error) { if (error.code !== 'scope-busy' || attempt === 4) throw error; await new Promise(resolve => setTimeout(resolve, 300)); }
  }
  return null;
}

// The owner approves a proposed ticket: it needs its files named, and then it is an ordinary todo ticket. Your --yes is the approval:
// an approved ledger is sealed again over the new ticket (the ticket carries approvedBy: owner, which is part of the hash).
async function approveProposed(root, rest, flags) {
  if (rest.length !== 1) return bad('tickets --approve needs one ticket id');
  try {
    return await withLock(root, async () => {
      const fresh = await readLedger(root);
      const ticket = fresh.tickets.find(x => x.id === rest[0]);
      if (!ticket) return out(`no ticket ${rest[0]}`, 1);
      if (ticket.status !== 'proposed') return out(`${ticket.id} is ${ticket.status}, not proposed; only a proposed ticket is approved this way`, 1);
      if (!(ticket.files ?? []).length) return out(`${ticket.id} names no files yet: swarm tickets ${ticket.id} --files a,b (and --context, --tests) first, so a worker knows where to write`, 1);
      // A file another open ticket writes would put two writers in one wave; the owner chooses other files or takes them (swarm tickets ID --files ... --take-from T-x) first.
      const clash = [];
      for (const f of ticket.files) {
        const owners = fresh.tickets.filter(x => x.id !== ticket.id && ['todo', 'ready', 'running', 'review', 'blocked'].includes(x.status) && ((x.files ?? []).includes(f) || (x.deletes ?? []).includes(f)));
        if (owners.length) clash.push(`${f} (${owners.map(o => o.id).join(', ')})`);
      }
      if (clash.length) return out(`${ticket.id} writes files that open tickets also write: ${clash.join('; ')}; name other files, or wait until they are done`, 1);
      const next = { ...ticket, status: 'todo', approvedBy: 'owner' };
      const v = validateTicket(next);
      if (!v.ok) return out(`refused: ${v.errors[0]}`, 1);
      const shown = [`${ticket.id}: ${ticket.title}`, `  files: ${ticket.files.join(', ')}`, `  acceptance: ${(ticket.acceptance ?? []).join(' | ')}`, ...(ticket.notes ? [`  comment (untrusted text, shown for you to read; a worker gets it as data only): ${ticket.notes}`] : [])].join('\n');
      const wasApproved = isApproved(fresh);
      if (flags.yes !== true) return out(`${shown}\nRerun with --yes to approve it: it becomes a todo ticket and a worker may run it${wasApproved ? '; the ledger approval is renewed over it' : ''}.`);
      fresh.tickets = fresh.tickets.map(x => (x.id === ticket.id ? next : x));
      const prev = fresh.approved;
      const saved = wasApproved ? { ...fresh, approved: { ...prev, ...approveLedger(fresh, { by: 'owner' }).approved, at: prev.at, ...(prev.ciTickets ? { ciTickets: prev.ciTickets } : {}) } } : fresh;
      saved.updatedAt = new Date().toISOString();
      await writeLedger(root, saved);
      await appendLog(root, { event: 'proposed-approved', id: ticket.id, by: 'owner', note: flags.note ?? null, reapproved: wasApproved });
      await refreshPlan(root);
      return out(`${ticket.id} approved: now a todo ticket${wasApproved ? '; the ledger stays approved (sealed again)' : ' (approve the ledger with swarm scope approve --yes before go --scope)'}`);
    });
  } catch (error) { if (error.code === 'scope-busy') return out('another swarm go --scope is starting a wave; try again in a minute', 1); throw error; }
}

export async function ticketProgress(root) {
  const ledger = await readLedger(root);
  if (!ledger) return null;
  const s = ledgerStats(ledger);
  return { total: s.total, percentDone: s.percentDone, byStatus: s.byStatus, approved: isApproved(ledger) };
}
