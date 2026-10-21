import { API_AGENTS } from '../api-adapters.mjs';
import { fixTicketFromFailure } from '../ci-hooks.mjs';
import { COMMANDS } from '../completion.mjs';
import { centralDayKey } from '../daily-limit.mjs';
import { GOAL_BUDGET } from '../goal.mjs';
import { formatBaseCheck, validateProfile } from '../init-profile.mjs';
import { appendEvent, safeWritableDir } from '../journal.mjs';
import { writeRuleFiles } from '../lanes-rule.mjs';
import { redactText } from '../lesson-schema.mjs';
import { loadLocalConfig } from '../local-config.mjs';
import { addCiFixTicket } from '../scope-commands.mjs';
import { API_ONLY_JOB_FIELDS } from './patterns.mjs';
import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

// The A1 security gate runs in the merge queue on every batch, after its files are written and before it can stay merged: a block rolls the batch back
// like a failed check. The project profile's `security` block sets the policy (it can be disabled there, never by a flag).
// The key that turns secret fingerprints into HMACs (so a low-entropy secret cannot be recovered from a fingerprint): random, 0600, in the project's .swarm folder.
async function securityFingerprintKey(root) {
  try {
    const dir = await safeWritableDir(root, ['.swarm', 'project']);
    const file = path.join(dir, 'security-key');
    try { return (await fs.readFile(file, 'utf8')).trim(); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const key = crypto.randomBytes(32).toString('hex');
    await fs.writeFile(file, `${key}\n`, { flag: 'wx', mode: 0o600 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
    return (await fs.readFile(file, 'utf8')).trim();
  } catch { return undefined; }
}

// The end of the first failing check's output, redacted and capped, so a retry can tell the worker what failed.
function failureTail(checks) {
  const bad = (checks ?? []).find(check => !['passed', 'skipped'].includes(check.status) && typeof check.tail === 'string' && check.tail.trim());
  return bad ? redactText(bad.tail).slice(-600) : '';
}

// Field lesson #269: a worker's own `deviations` array may hold plain strings, not just
// `{contract, did, why}` objects — rendered unchanged here rather than read as `.contract`
// (`undefined` for a string) or spread character-by-character into a char-indexed object.
function deviationText(deviation) {
  return typeof deviation === 'string' ? deviation : deviation?.contract ?? JSON.stringify(deviation);
}

// Field lesson #210: a hand step (integrate, mutants, ship) run while no job is actually running
// anywhere under the roots this coordinator cares about is idle time nobody would choose to
// spend that way — named up front, with how long it has already been idle, instead of only
// showing up later as an unexplained gap in session-metrics.
async function latestRunEnd(roots) {
  let latest = null;
  for (const oneRoot of roots) {
    let entries;
    try { entries = await fs.readdir(path.join(oneRoot, '.swarm/runs')); } catch { continue; }
    for (const id of entries) {
      try {
        const state = JSON.parse(await fs.readFile(path.join(oneRoot, '.swarm/runs', id, 'state.json'), 'utf8'));
        if (typeof state.finishedAt === 'string' && (!latest || state.finishedAt > latest)) latest = state.finishedAt;
      } catch { /* skip unreadable/corrupt state */ }
    }
  }
  return latest;
}

// Keep regression tests in place while reversing only the implementation outputs.
const isTestOutput = file => /(^|\/)tests?\//.test(file) || /(?:\.test\.|\.spec\.|_test\.)/.test(path.basename(file));

// How many non-sensitive auto-routed jobs this run has ready now (no unmet `after`): the rented GPU lane is only for a big queue (see tools/router.mjs RENTED_MIN_READY).
const readyAutoJobs = manifest => (manifest?.jobs ?? []).filter(job => job.agent === 'auto' && job.sensitive === false && !(Array.isArray(job.after) && job.after.length)).length;

export function withoutApiOnlyFields(job) {
  if (API_AGENTS.includes(job?.agent) || job?.agent === 'auto') return job;
  const copy = { ...job };
  for (const field of API_ONLY_JOB_FIELDS) delete copy[field];
  return copy;
}

// A read-only web job (GitHub first) that returns raw JSON; the runner, not the model, applies
// the license gate and writes the report — builders read only the report.
// Row #212: `--licenses` may name a file (one license per line, or comma-separated) or a bare
// comma-separated list; a name that is not an existing readable file is treated as the list itself.
async function resolveLicensesFlag(root, licenses) {
  if (licenses === undefined) return null;
  let text = null;
  try { text = (await fs.readFile(path.resolve(root, licenses), 'utf8')); } catch { /* not a file: treat the value itself as the list */ }
  const source = text ?? licenses;
  return source.split(/[\n,]/).map(entry => entry.trim()).filter(Boolean);
}

// --- Shared install: version, update, and onboarding -----------------------------------

function parseSemver(tag){
  const match=/^v?(\d+)\.(\d+)\.(\d+)$/.exec(typeof tag==='string'?tag.trim():'');
  return match?[Number(match[1]),Number(match[2]),Number(match[3])]:null;
}

function compareSemver(a,b){for(let i=0;i<3;i++)if(a[i]!==b[i])return a[i]-b[i];return 0;}

// The owner's --approve-manifest approvals (file and content hash) are added to the security policy that is already in force; a disabled gate stays disabled.
function withApprovedManifests(policy,files){
  if(!files?.length||policy?.enabled===false)return policy;
  const base=policy&&typeof policy==='object'&&!Array.isArray(policy)?policy:{};
  return {...base,approvedManifests:[...(Array.isArray(base.approvedManifests)?base.approvedManifests:[]),...files]};
}

async function readProjectsRegistry(root){
  try{const value=JSON.parse(await fs.readFile(path.join(root,'.swarm-projects.json'),'utf8'));return Array.isArray(value)?value:[];}
  catch{return [];}
}

// Finds old per-project copies (a full runner+skill checkout, not this install root) and
// stale pointers, replacing each with a pointer only once the caller passes --yes. Old files
// are moved aside, never deleted, and coordination/ and .swarm/ are never touched.
async function attachRuleFiles(report,projectRoot,yes){
  if(!yes||report.action==='missing'||report.action==='would replace with pointer')return;
  try{report.ruleFiles=await writeRuleFiles(projectRoot);}
  catch(error){report.ruleFilesError=String(error.message);}
}

function agentReadiness(agent,result){
  const ready=result.status==='compatible'||result.reachable===true;
  if(ready)return {agent,ready};
  const fix=result.note||(result.status==='unsupported'?'unsupported on this platform':`run: node tools/swarm.mjs doctor ${agent}`);
  return {agent,ready,fix};
}

// --- ship: push, PR, wait for CI, merge -------------------------------------------------

// Never rejects on a non-zero exit or a launch failure; ship() decides what a failed step means.
// Field lesson #181: when the child process never actually starts (a bad path, a directory picked
// as the binary, EACCES, ...), Node gives `error.code` as the errno STRING (e.g. "EISDIR",
// "EACCES"), never a number — that is exactly what already tells a real exit ("code" is a number)
// apart from a launch failure here. A launch failure has no real stdout/stderr to report, so
// callers used to see an empty reason; `spawnError` now names the errno so a caller (ship()'s own
// lock check, in particular) can say exactly what could not even start, instead of nothing.
// Field lesson #192: a check re-run ship spawns through this exec (the base re-run of a failing
// check, the pre-push lock check) is only ever handed the toolchains-bin-first PATH ship computed
// (toolchainCheckEnv) when this itself honours the `env` its caller passed, instead of always
// falling back to this process's own environment.
export function shipExec(file, args, { cwd, input, env, timeoutMs } = {}) {
  return new Promise(resolve => {
    const child = execFile(file, args, { cwd, maxBuffer: 16 * 1024 * 1024, encoding: 'utf8', ...(env ? { env } : {}), ...(timeoutMs ? { timeout: timeoutMs } : {}) }, (error, stdout, stderr) => {
      const spawnFailed = Boolean(error) && typeof error.code !== 'number';
      resolve({
        code: error ? (typeof error.code === 'number' ? error.code : 1) : 0,
        stdout: stdout ?? '',
        stderr: stderr ?? '',
        ...(spawnFailed ? { spawnError: String(error.code || error.message || 'spawn failed') } : {}),
      });
    });
    child.stdin.on('error', () => {});
    if (input !== undefined) child.stdin.write(input);
    child.stdin.end();
  });
}

export function shipExitCode(status) {
  return ['merged', 'held', 'ready'].includes(status) ? 0 : 1;
}

// Field lesson #169 (found again against --pr): a path-valued flag is typed the way the user is
// sitting, not the way --root sits — `swarm --root worktrees/x ship --branch b --pr
// coordination/p.json` fails "not found" when --pr is only resolved against --root. A relative
// value is tried against the cwd first, then against --root (an absolute value passes through
// unchanged, one candidate); a truly missing file names every path actually tried.
export async function resolvePathCwdThenRoot(rawPath, root, { cwd = process.cwd(), label = 'file' } = {}) {
  const fromRoot = path.resolve(root, rawPath);
  const candidates = path.isAbsolute(rawPath) ? [fromRoot] : (fromCwd => (fromCwd === fromRoot ? [fromRoot] : [fromCwd, fromRoot]))(path.resolve(cwd, rawPath));
  for (const candidate of candidates) {
    try { await fs.access(candidate); return candidate; } catch { /* try the next candidate */ }
  }
  throw Error(`${label} not found: ${rawPath} (tried: ${candidates.join(', ')})`);
}

// A budget failure becomes a fix ticket once per screen: not while the screen's earlier fix ticket is still open. `files` are the batch's changed files (empty for a manual check: then no ticket, the failure is only recorded).
async function ticketForBudgetFailure(root, result, files) {
  if (!files.length) return null;
  const { readBudgetState, linkBudgetTicket } = await import('../budgets.mjs');
  const state = await readBudgetState(root);
  const existing = state.screens[result.id]?.ticket;
  const ledger = await (await import('../tickets.mjs')).readLedger(root).catch(() => null);
  if (existing && ledger?.tickets.some(t => t.id === existing && !['done', 'cancelled'].includes(t.status))) return existing;
  const summary = `screen ${result.id}: ${result.failures.slice(0, 5).map(f => f.message).join('; ')}`;
  const ticket = await addCiFixTicket(root, { ...fixTicketFromFailure({ kind: 'budget', batchNumber: 0, files, summary }), title: `Fix speed/accessibility budget on screen ${result.id}`.slice(0, 140), acceptance: [`Screen ${result.id} is back within its Lighthouse and axe budgets.`] }).catch(() => null);
  if (ticket) await linkBudgetTicket(root, result.id, ticket);
  return ticket;
}

// Run through current/, this file's realpath is a snapshot under <install>/versions/<v>/, which
// holds only tools/ and package.json; commands with no --root (version, update, self-hosted
// runs) must still target the install checkout itself, never the snapshot.
// What a person sees for a word swarm does not know: say so, say which swarm this is, and point at the likely cause (an install that has not been updated).
export async function invalidArgumentsMessage(command,installRoot){
  const known=new Set(COMMANDS.map(c=>c.name));
  if(command&&!command.startsWith('-')&&!known.has(command)){
    let version='unknown';try{version=JSON.parse(await fs.readFile(path.join(installRoot,'package.json'),'utf8')).version;}catch{/* version stays unknown */}
    return `Unknown command "${command}". This is swarm ${version} (${installRoot}). If it is a newer command, run: swarm update. swarm --help lists the commands.`;
  }
  if(command&&command.startsWith('-'))return `Unknown option "${command}". swarm --help lists the commands and their options.`;
  return 'Invalid arguments; use --help';
}

export function defaultRoot(dir){
  return path.basename(path.dirname(dir))==='versions'?path.dirname(path.dirname(dir)):dir;
}

// The only things autopilot may do. None of them merges, deploys, raises a cap or calls a model:
// resume takes no raises, and waves and retries run the manifests the project already has.
// The spend caps for something autopilot starts: the first number set among the given budgets, else the
// same default `swarm go` uses. Autopilot never starts paid work without a cap.
function autopilotCaps(...budgets) {
  const pick = key => budgets.map(budget => budget?.[key]).find(value => typeof value === 'number' && Number.isFinite(value) && value > 0);
  return { maxUsd: pick('maxUsd') ?? GOAL_BUDGET.maxUsd, maxTokens: pick('maxTokens') ?? GOAL_BUDGET.maxTokens };
}

function centralResetLabel(ms) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  }).format(new Date(ms));
}

function policyDayKey(isoOrMs, nowMs = Date.now()) {
  const t = typeof isoOrMs === 'string' ? Date.parse(isoOrMs) : isoOrMs;
  const ms = Number.isFinite(t) ? t : nowMs;
  return centralDayKey(() => ms);
}

async function applyPolicyDecision(root, item, { now = Date.now } = {}) {
  if (item?.kind === 'hand-build-request') {
    const ref = String(item.id ?? '');
    const hbId = ref.startsWith('handbuild-') ? ref.slice('handbuild-'.length) : ref;
    const { decideRequest } = await import('../handbuild.mjs');
    decideRequest(root, hbId, 'approve', { now, by: 'policy', channel: 'policy' });
    await appendEvent(root, {
      kind: 'decision',
      id: ref,
      confirmed: true,
      choice: 'approve',
      text: 'policy auto-approve',
    }, { now });
    return;
  }
  throw new Error(`policy-apply-unsupported: ${item?.kind ?? 'unknown'}`);
}

// The project's profile from .project-swarm.json, or null when there is none or it is not valid.
async function projectProfile(root) {
  try {
    const pointer = JSON.parse(await fs.readFile(path.join(root, '.project-swarm.json'), 'utf8'));
    if (!pointer?.profile) return null;
    const { profile, errors } = validateProfile(pointer.profile);
    return errors.length ? null : profile;
  } catch { return null; }
}

// `go X`: X is a manifest when it is an existing .json file, whatever else it looks like.
async function existingManifestFile(root, argument) {
  if (typeof argument !== 'string' || !argument.endsWith('.json')) return false;
  try { return (await fs.stat(path.resolve(root, argument))).isFile(); } catch { return false; }
}

// Which jobs may go to the Message Batches API: --batch (all eligible), the manifest's `batch` (true or { types }), or the
// machine config's `batch` ({ enabled, types }); a job's own batch true/false is applied by batchEligible.
export function batchPolicyFor(manifest, flag, env, root) {
  let config = {};
  try { config = loadLocalConfig({ env }).batch ?? {}; } catch { config = {}; }
  // The machine-wide default is opt-in per project: it applies only to roots listed in `batch.projects`. --batch and a manifest's own `batch` still work anywhere.
  const listed = typeof root === 'string' && Array.isArray(config.projects) && config.projects.some(item => typeof item === 'string' && path.resolve(item) === path.resolve(root));
  if (!listed) config = {};
  const own = manifest?.batch;
  const types = Array.isArray(own?.types) ? own.types : own === undefined && config.enabled === true && Array.isArray(config.types) ? config.types : [];
  const all = flag === true || own === true || (own === undefined && config.enabled === true && !(Array.isArray(config.types) && config.types.length));
  return { all, types };
}

// Owner flags beat the profile; the profile beats the built-in defaults.
function withProfileDefaults(flags, profile) {
  return { ...flags, maxUsd: flags.maxUsd ?? profile?.budget?.maxUsd, maxTokens: flags.maxTokens ?? profile?.budget?.maxTokens, ...(profile?.sensitive === false ? { sensitive: false } : {}) };
}

function withProfileRisks(preview, profile) {
  if (profile?.baseCheck?.status !== 'red') return preview;
  return { ...preview, risks: [...preview.risks, { code: 'base-red', message: formatBaseCheck(profile.baseCheck) }] };
}

export { agentReadiness, applyPolicyDecision, attachRuleFiles, autopilotCaps, centralResetLabel, compareSemver, deviationText, existingManifestFile, failureTail, isTestOutput, latestRunEnd, parseSemver, policyDayKey, projectProfile, readProjectsRegistry, readyAutoJobs, resolveLicensesFlag, securityFingerprintKey, ticketForBudgetFailure, withApprovedManifests, withProfileDefaults, withProfileRisks };
