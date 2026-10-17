// SPDX-License-Identifier: Apache-2.0
// `swarm scope`, `swarm tickets`, `swarm change` and the `go --scope` preparation (Phase 13).
// Pure glue over scope.mjs, tickets.mjs, scope-integrity.mjs, change-orders.mjs, day0.mjs,
// approval-policy.mjs and ticket-manifest.mjs. No model is called here; `scope split` only writes
// a manifest for `swarm run`.
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { SCOPE_TEMPLATE, parseScope, checkScope, scopeHash, requirementText, isSensitiveText } from './scope.mjs';
import { readLedger, writeLedger, appendLog, createLedger, transition, readyTickets, filterTickets, ledgerStats, renderBuildPlan, approveLedger, isApproved, validateTicket, STATUSES } from './tickets.mjs';
import { checkTicketTree, summarizeTree, formatSummary } from './scope-integrity.mjs';
import { diffScopes, impactAnalysis, nextChangeOrderId, applyChangeOrder } from './change-orders.mjs';
import { day0Checklist, checklistToTickets } from './day0.mjs';
import { validateApprovalPolicy, needsHuman } from './approval-policy.mjs';
import { ticketsToManifest, ticketOutcome } from './ticket-manifest.mjs';
import { safeWritableDir, assertRegularOrMissing } from './journal.mjs';
import { validateOpenApi, contractFiles } from './contracts.mjs';

export const SCOPE_USAGE = [
  'Usage: swarm scope template [--out FILE]',
  '       swarm scope check [FILE]',
  '       swarm scope split [FILE] [--stage S1] | scope split --ingest RUN [--merge]',
  '       swarm scope approve [FILE] [--yes]',
  '       swarm scope sync RUN [--integrated]',
  '       swarm scope contracts OPENAPI.json',
  '       swarm tickets [ID] [--stage S1] [--status todo] [--type build] [--risk high] [--set STATUS] [--note TEXT] [--json]',
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
const FLAGS_WITH_VALUE = new Set(['--out', '--stage', '--ingest', '--status', '--type', '--risk', '--set', '--note', '--max-jobs']);
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

function splitPrompt(scope, stage, only) {
  const reqs = scope.requirements.filter(r => r.stage === stage.id && (!only || only.has(r.id)));
  const lines = [
    `Split the requirements of stage ${stage.id} (${stage.title || 'no title'}) of "${scope.name}" into small build tickets.`,
    'Return ONE JSON file named by the job output: a JSON array of ticket objects, nothing else.',
    'Each ticket object has these fields:',
    'key (short unique name in this file), title (under 140 characters), type (build, test, docs, migration, design, contract or human),',
    'epic (a feature group name), scopeRefs (requirement ids, at least one for build, test, docs, migration), acceptance (1 to 5 observable checks; required for build, test, migration),',
    'files (the files this ticket writes; no folders, no absolute paths), context (files it reads), contracts (contract files it uses), dependsOn (keys of other tickets in this file),',
    'size (S or M; never larger: split instead), risk (low, medium or high), sensitive (true for payments, auth or customer data), steps (only for human tickets: 1 to 30 short imperative steps), skeleton (true only on the tickets of the thinnest vertical slice of the first stage: database, API, screen and test, the smallest path through the product; omit it elsewhere).',
    'Rules: every requirement is covered by at least one ticket; every ticket traces to a requirement; two tickets that can run at the same time never write the same file;',
    'put shared types or contracts first and make the tickets that use them depend on them; add a test ticket for each requirement group.',
    'Work only from the requirements below.',
    '',
    ...reqs.flatMap(r => [`${r.id}: ${r.text}`, ...r.acceptance.map(a => `  - ${a}`)]),
    ...(scope.sensitive.length ? ['', `Sensitive areas: ${scope.sensitive.join('; ')}`] : []),
  ];
  return lines.join('\n');
}

export function buildSplitManifest(scope, { stage, only } = {}) {
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
      prompt: splitPrompt(scope, s, only),
      context: [],
      outputs: [`${SPLIT_DIR}/${s.id}.json`],
      timeoutMs: 900000,
    })),
  };
}

function parseTicketFile(text) {
  const body = String(text).trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const value = JSON.parse(body);
  const list = Array.isArray(value) ? value : value?.tickets;
  if (!Array.isArray(list)) throw new Error('not a JSON array of tickets');
  return list;
}

const ARRAY_FIELDS = ['scopeRefs', 'acceptance', 'files', 'context', 'contracts', 'dependsOn', 'steps'];
const isStrings = v => Array.isArray(v) && v.every(x => typeof x === 'string');
const strings = v => (isStrings(v) ? v : []);

export function ticketsFromStageLists(lists, scope, { startAt = 1 } = {}) {
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
      context: strings(raw.context), contracts: strings(raw.contracts), dependsOn: deps,
      size: raw.size, risk: raw.risk, sensitive: raw.sensitive === true || isSensitiveText(scope, text),
      status: 'todo',
    };
    if (raw.type === 'human') t.steps = strings(raw.steps);
    if (raw.hard === true) t.hard = true;
    if (raw.skeleton === true) t.skeleton = true;
    const v = validateTicket(t);
    if (!v.ok) errors.push(`${id}: ${v.errors[0]}`);
    tickets.push(t);
  }
  return { tickets, errors };
}

async function readStageFiles(root, runId) {
  const state = await readRunState(root, runId);
  const realRoot = await fs.realpath(root);
  const lists = [];
  const errors = [];
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
      const items = parseTicketFile(text);
      if (items.length > MAX_STAGE_TICKETS) throw new Error(`more than ${MAX_STAGE_TICKETS} tickets`);
      lists.push({ stage, items });
    } catch (error) { errors.push(`${job.id}: ${error.message}`); }
  }
  if (!lists.length && !errors.length) throw fail('scope-run', `run ${runId} has no split jobs`);
  return { lists: lists.sort((a, b) => a.stage.localeCompare(b.stage, 'en', { numeric: true })), errors };
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
    const only = led ? new Set(scope.requirements.filter(r => !led.tickets.some(t => t.status !== 'cancelled' && t.scopeRefs.includes(r.id))).map(r => r.id)) : null;
    if (only && !only.size) return out('every requirement already has tickets; nothing to split', 1);
    const manifest = buildSplitManifest(scope, { stage: flags.stage, only });
    await writeFileSafe(root, `${SPLIT_DIR}/manifest.json`, `${JSON.stringify(manifest, null, 2)}\n`);
    return out(`split manifest: ${manifest.jobs.length} job(s) written to ${SPLIT_DIR}/manifest.json\nNext: swarm run ${SPLIT_DIR}/manifest.json, then swarm scope split --ingest RUN${led ? ' --merge' : ''}`);
  }
  const existing = await readLedger(root);
  if (existing && existing.scope?.hash !== hash) return out('the scope file changed since the ledger was made; record it with swarm change "reason" first', 1);
  if (existing && !flags.merge) return out('a ticket ledger already exists; use --merge to add tickets, or delete .swarm/project/tickets.json first', 1);
  if (flags.merge && !existing) return out('no ticket ledger to merge into', 1);
  const { lists, errors } = await readStageFiles(root, flags.ingest);
  const startAt = existing ? Math.max(0, ...existing.tickets.filter(t => t.id < 'T-9000').map(t => Number(t.id.slice(2)))) + 1 : 1;
  const built = ticketsFromStageLists(lists, scope, { startAt });
  const all = [...errors, ...built.errors];
  if (startAt + built.tickets.length > 9000) all.push('too many tickets: ids T-9000 and up are reserved for day 0 tickets');
  if (all.length) return out(`split refused; fix and rerun the failed stages:\n${all.slice(0, 15).map(e => `  ${e}`).join('\n')}`, 1);
  let tickets = built.tickets;
  if (!existing) tickets = [...tickets, ...checklistToTickets(day0Checklist(scope))];
  const base = existing ?? createLedger({ scope: { name: scope.name, version: scope.version, hash, file }, tickets: [] });
  // New tickets are written by a worker, so any earlier approval no longer covers the ticket set.
  const ledger = { ...createLedger({ scope: base.scope, tickets: [...base.tickets, ...tickets] }), changeOrders: base.changeOrders ?? [], createdAt: base.createdAt, approved: null };
  const { tree, lines } = treeReport(scope, ledger.tickets);
  const structural = tree.errors.filter(e => e.code !== 'uncovered');
  if (structural.length) return out(`split refused; the tickets are inconsistent:\n${lines.join('\n')}`, 1);
  await writeLedger(root, ledger);
  await appendLog(root, { event: flags.merge ? 'split-merge' : 'split', tickets: tickets.length, run: flags.ingest, ok: tree.ok });
  const gaps = tree.ok ? [] : ['Some requirements still have no tickets: run swarm scope split again (it splits only those), then --ingest RUN --merge.'];
  return out([`ledger written: ${tickets.length} tickets added (not approved)`, ...lines, ...gaps, tree.ok ? 'Next: swarm scope approve' : ''].filter(Boolean).join('\n'));
}

async function cmdApprove(root, { rest, flags }) {
  const ledger = await readLedger(root);
  if (!ledger) return out('no ticket ledger; run swarm scope split first', 1);
  const { scope, hash, text, file } = await loadScope(root, rest[0] ?? ledger.scope?.file);
  if (ledger.scope?.hash !== hash) return out('the scope file changed after the split; record it with swarm change "reason" (or re-split)', 1);
  const { tree, lines } = treeReport(scope, ledger.tickets);
  if (!tree.ok) return out(`not approvable:\n${lines.join('\n')}`, 1);
  const summary = formatSummary(summarizeTree({ scope, tickets: ledger.tickets }));
  const policy = await readApprovalPolicy(root);
  if (needsHuman(policy, { kind: 'scope' }) && flags.yes !== true) return out(`${summary}\n\nThis needs your approval. Review it, then: swarm scope approve --yes`);
  const by = flags.yes === true ? 'owner' : 'policy';
  const next = approveLedger(ledger, { by });
  next.scope = { ...next.scope, hash, file };
  await writeLedger(root, next);
  await writeFileSafe(root, '.swarm/project/scope.snapshot.md', text);
  await writeFileSafe(root, 'docs/scope/build-plan.md', renderBuildPlan(next, scope));
  await appendLog(root, { event: 'approve', by, scopeHash: hash, ticketsHash: next.approved.ticketsHash });
  return out(`${summary}\n\napproved. Build plan: docs/scope/build-plan.md. Next: swarm go --scope`);
}

async function cmdSync(root, { rest, flags }) {
  if (rest.length !== 1) return bad('scope sync needs a run id');
  const ledger = await readLedger(root);
  if (!ledger) return out('no ticket ledger', 1);
  const state = await readRunState(root, rest[0]);
  if (flags.integrated === true) {
    if (!state.integratedAt) return out(`run ${rest[0]} is not integrated yet; run swarm integrate ${rest[0]} first`, 1);
    const finished = new Set((state.jobs ?? []).filter(j => j.status === 'complete').map(j => j.id));
    const done = [];
    for (const t of ledger.tickets.filter(x => x.status === 'review' && finished.has(x.id))) { await transition(root, t.id, 'done', { by: 'sync', note: `integrated ${rest[0]}` }); done.push(t.id); }
    await refreshPlan(root);
    return out(`${done.length} ticket(s) marked done`);
  }
  const moves = ticketOutcome(state.jobs ?? [], ledger).filter(m => ledger.tickets.find(t => t.id === m.id)?.status === 'running');
  for (const m of moves) await transition(root, m.id, m.to, { by: 'sync', note: m.note });
  await refreshPlan(root);
  const review = moves.filter(m => m.to === 'review').length;
  return out(`${review} ticket(s) in review, ${moves.length - review} blocked. After swarm integrate ${rest[0]}: swarm scope sync ${rest[0]} --integrated`);
}

async function cmdContracts(root, { rest, flags }) {
  if (rest.length !== 1) return bad('scope contracts needs an OpenAPI JSON file');
  const text = await readText(resolveInside(root, rest[0]));
  if (text === null) return out(`no file ${rest[0]}`, 1);
  let doc;
  try { doc = JSON.parse(text); } catch { return out(`${rest[0]} is not valid JSON (YAML is not supported)`, 1); }
  const checked = validateOpenApi(doc);
  if (!checked.ok) return out(`contract invalid:\n${checked.errors.slice(0, 10).map(e => `  ${e}`).join('\n')}`, 1);
  const files = contractFiles(doc);
  const existing = [];
  for (const name of Object.keys(files)) if (await readText(path.join(root, name)) !== null) existing.push(name);
  const policy = await readApprovalPolicy(root);
  if ((existing.length || needsHuman(policy, { kind: 'contracts' })) && flags.yes !== true) {
    return out(`${existing.length ? `would overwrite: ${existing.join(', ')}\n` : ''}Generating contracts needs your approval: swarm scope contracts ${rest[0]} --yes`, 1);
  }
  for (const [name, body] of Object.entries(files)) await writeFileSafe(root, name, body);
  return out(`generated ${Object.keys(files).length} files: ${Object.keys(files).join(', ')}\nRun the mock: node -e "import('./contracts/mock-server.mjs').then(m=>m.createMockServer({port:4010}))"`);
}

async function refreshPlan(root) {
  const ledger = await readLedger(root);
  const text = await readText(path.join(root, ...SNAPSHOT));
  if (ledger && text) await writeFileSafe(root, 'docs/scope/build-plan.md', renderBuildPlan(ledger, parseScope(text)));
}

const row = t => `${t.id} ${t.status.padEnd(9)} ${t.stage} ${t.risk.padEnd(6)} ${t.type.padEnd(9)} ${t.title}`;

export async function runTicketsCommand(root, args) {
  const { flags, rest } = parseArgs(args);
  const ledger = await readLedger(root);
  if (!ledger) return out('no ticket ledger; run swarm scope split first', 1);
  if (flags.set !== undefined) {
    if (rest.length !== 1) return bad('tickets --set needs one ticket id');
    if (!STATUSES.includes(flags.set)) return out(`status must be one of: ${STATUSES.join(', ')}`, 1);
    const t = await transition(root, rest[0], flags.set, { by: 'owner', note: flags.note });
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
export async function prepareScopeRun(root, { maxJobs, now = Date.now, lessons = [], skipSkeleton = false } = {}) {
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
    const { manifest, warnings, skipped } = ticketsToManifest(ready, { ledger, scope, ready: false, maxJobs, lessons });
    manifest.jobs = manifest.jobs.filter(j => j.type !== 'human');
    const ids = manifest.jobs.map(j => j.id);
    if (!ids.length) throw fail('scope-nothing', humans ? `only ${humans} human ticket(s) are ready; finish them with swarm tickets ID --set done` : 'no ready tickets');
    const before = new Map(ids.map(id => [id, ledger.tickets.find(t => t.id === id).status]));
    for (const id of ids) ledger.tickets.find(t => t.id === id).status = 'running';
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
