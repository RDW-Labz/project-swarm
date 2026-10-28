import { API_AGENTS } from '../api-adapters.mjs';
import { parseExtraCli, validateEnvelope } from '../cli-adapters.mjs';
import { cliHostFailure } from '../cli-host.mjs';
import { isTestFile } from '../context-check.mjs';
import { applyJobType } from '../job-types.mjs';
import { leadRollup } from '../leads.mjs';
import { loadLocalConfig } from '../local-config.mjs';
import { REPORT_PROMPT_LINE, rollupRun } from '../reports.mjs';
import { TEST_FILE_RE } from '../ship.mjs';
import { assertNoSkillSymlinks, attachSkillsForJob, listSkills, resolveSkillsDir } from '../skills.mjs';
import { ABSENCE_CLAIM_PATTERN, AGENTS_MD_DOC_RE, CHANGED_STATUS_WORD_RE, CORE_MODULE_PATH, DATACLASS_FIELD_RE, EVIDENCE_HEADING, FAILURE_LINE_RE, FAILURE_LOCATION_RE, HEX_HASH_RE, JSON_DEMAND_RE, MAX_NOTE_LEN, MAX_NOTES, PROGRESS_INTERVAL, RUNTIME_CHECK_RE, SECRET_PATTERN } from './patterns.mjs';
import { progressReport } from './run-state.mjs';
import { isWorktreeWriter } from './workspace.mjs';
import { orchestratorManifestGate } from '../om-manifest-guard.mjs';
import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

function validateOutputCap(cap, label) {
  if (!cap || typeof cap !== 'object' || Array.isArray(cap) ||
      Object.keys(cap).some(key => !['total', 'perFile'].includes(key)) ||
      !['total', 'perFile'].every(key => Number.isSafeInteger(cap[key]) && cap[key] > 0)) {
    throw Object.assign(new Error(`invalid-output-cap: ${label} requires positive integer total and perFile`), { code: 'invalid-output-cap' });
  }
  return cap;
}

const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

const fail = (message, code) => { throw Object.assign(new Error(message), code ? { code } : {}); };

const runId = () => `${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;

// Field lesson #193: several `ask`/`scout` runs launched in the same millisecond used to get the
// identical id `<prefix>-<ms>`; a random suffix (like plain `run`'s own id above) makes two runs
// started the same millisecond, in different processes, vanishingly unlikely to collide.
export const makeRunId = prefix => `${prefix}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;

const execFileAsync = promisify(execFile);

// Field lesson 106: toolchains that live under the OS tmp dir get silently purged; the project's
// own toolchains live at SWARM_TOOLCHAINS (or ~/.project-swarm/toolchains) instead. `doctor` and
// `onboard` surface this as advice only — it never changes a provider's status or configured field.
function toolchainsDir({ env = process.env, home = os.homedir() } = {}) {
  return env.SWARM_TOOLCHAINS || path.join(home, '.project-swarm/toolchains');
}

export function parseToolchainInventory(text) {
  const cells = line => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(value => value.trim().replace(/^`([^`]*)`$/, '$1'));
  const lines = text.split(/\r?\n/);
  const headings = lines.flatMap((line, index) => cells(line).join('|') === 'binary|version|reinstall' ? [index] : []);
  if (headings.length !== 1) return null;
  const start = headings[0];
  const separator = cells(lines[start + 1] ?? '');
  if (separator.length !== 3 || separator.some(cell => !/^:?-{3,}:?$/.test(cell))) return null;
  const rows = [], seen = new Set();
  for (const line of lines.slice(start + 2)) {
    if (!line.trim() || !line.includes('|')) break;
    const [binary, version, reinstall, extra] = cells(line);
    if (extra !== undefined || !binary || !version || !reinstall || ['.', '..'].includes(binary) || /[\\/:\x00-\x1f\x7f]/.test(binary) || seen.has(binary.toLowerCase())) return null;
    seen.add(binary.toLowerCase());
    rows.push({ binary, version, reinstall });
  }
  return rows.length ? rows : null;
}

export function coreModuleNoShellWarning(job) {
  if (!isWorktreeWriter(job) && job.shell !== true && job.outputs.includes(CORE_MODULE_PATH)) return { code: 'core-module-no-shell', jobId: job.id, path: CORE_MODULE_PATH, message: `${job.agent} cannot run pinning tests for ${CORE_MODULE_PATH} (no shell); consider a checker job` };
  return null;
}

const quotesRuntimeFailure = prompt => RUNTIME_CHECK_RE.test(prompt) || (/\btimeout\b/i.test(prompt) && /\bwaitfor\b/i.test(prompt));

const isDocOnlyJob = job => (job.outputs ?? []).length > 0 && job.outputs.every(file => /\.md$/i.test(file));

async function programOnPath(program, dirs) {
  for (const dir of dirs) { try { await fs.access(path.join(dir, program)); return true; } catch { /* try the next dir */ } }
  return false;
}

// Field lesson #261: this used to warn about every one of CHECK_PATH_PROGRAMS regardless of what
// the check's own argv actually runs, so `env PATH=... uv run pytest -q` warned about gh/node/npm
// too — programs that check never invokes at all. The program actually invoked is the first argv
// token after `env` and any `VAR=value` prefixes it carries; `npm` also implies `node` underneath.
function invokedProgramsFor(argv) {
  let index = 1;
  while (index < argv.length && typeof argv[index] === 'string' && /^[A-Za-z_][A-Za-z0-9_]*=/.test(argv[index])) index++;
  const program = argv[index];
  if (!program) return [];
  return program === 'npm' ? ['npm', 'node'] : [program];
}

export function dataclassFieldNames(text) {
  const fields = new Set();
  let inClass = false;
  for (const line of (text ?? '').split('\n')) {
    if (/^\s*@dataclass\b/.test(line)) { inClass = true; continue; }
    if (!inClass) continue;
    if (/^\s*class\s+\w+/.test(line)) continue;
    if (!line.trim()) continue;
    if (!/^\s/.test(line)) { inClass = false; continue; }
    if (/^\s*(def|@|#)/.test(line)) continue;
    const match = line.match(DATACLASS_FIELD_RE);
    if (match) fields.add(match[1]);
  }
  return fields;
}

// Field lesson #229: a shared contract's own "Event names" table (`event | producer file:line |
// reader file:line`) names every log/event a job's code writes or reads; a row with an empty
// producer cell names a reader with no producer anywhere in this batch, the exact shape that let
// 8 of 11 reader lines go unmeasured while fixture events fed the reader directly in tests.
function parseContractEventRows(text) {
  const rows = [];
  let inTable = false;
  for (const rawLine of String(text ?? '').split('\n')) {
    const line = rawLine.trim();
    if (/^\|.*\bevent\b.*\|.*\bproducer\b.*\|.*\breader\b.*\|$/i.test(line)) { inTable = true; continue; }
    if (!inTable) continue;
    if (!line.startsWith('|')) { inTable = false; continue; }
    const cells = line.slice(1, line.endsWith('|') ? -1 : undefined).split('|').map(cell => cell.trim());
    if (cells.length !== 3 || cells.every(cell => /^:?-+:?$/.test(cell)) || !cells[0]) continue;
    rows.push({ event: cells[0], producer: cells[1], reader: cells[2] });
  }
  return rows;
}

// Field lesson #240: a contract's own 'Files:' line names the files a fix touches; a path named
// there but missing from the repository root means a follow-up job (or a hand-fix) never actually
// landed where the contract says it would. One line may name several files, comma/semicolon
// separated, each optionally followed by a line-number hint (`~123`) that is never part of the path.
export function contractFilesLinePaths(text) {
  const paths = new Set();
  const re = /Files:\s*([^\n]+)/g;
  let match;
  while ((match = re.exec(text))) {
    for (const raw of match[1].split(/[,;]/)) {
      const token = raw.trim().split(/\s+/)[0]?.replace(/[.)]+$/, '');
      if (token && /\.[A-Za-z0-9]+$/.test(token)) paths.add(token);
    }
  }
  return [...paths];
}

// Field lesson #231: a job may declare `maxCredits` (a number) and `creditPreflight` (a JSON file
// `[{"call": str, "cost": number}, ...]` the worker or orchestrator wrote from a real cost
// preflight); the sum is computed here, in code, never trusted as a prompt's own mental math.
export function sumCreditPreflight(entries) {
  return (Array.isArray(entries) ? entries : []).reduce((total, entry) => total + (Number(entry?.cost) || 0), 0);
}

export function workFolderReferenceHits(writes) {
  const hits = [];
  for (const { file, bytes } of writes) {
    if (!/^(?:src|tests)\//.test(file) || bytes === null || bytes.includes(0)) continue;
    const lines = bytes.toString('utf8').replace(/\\+/g, '/').split('\n');
    for (const [index, line] of lines.entries()) {
      if (/(?:^|[^A-Za-z0-9_.-])docs\/_swarm(?=$|[^A-Za-z0-9_.-])/.test(line)) {
        hits.push({ code: 'work-folder-reference', file, line: index + 1, message: `work-folder-reference: ${file}:${index + 1} references docs/_swarm; move runtime and test inputs to tracked tests/fixtures files` });
      }
    }
  }
  return hits;
}

// Lesson 349: path matching alone must not turn a writing job into a debugging job.
// Explicit skills in the manifest are an opt-in; otherwise the prompt must request a fix.
function attachJobSkills(skills, job) {
  const fixJob = job.skills?.includes('debugging') || /\b(?:fix|fixing|debug|debugging|repair)\b/i.test(job.prompt ?? '');
  return attachSkillsForJob(skills, job).map(skill =>
    skill.name === 'debugging' && !fixJob ? { ...skill, attached: 'index-only' } : skill);
}

export function codexRequiredReadMissingWarnings(agentsMdText, trackedFiles, job) {
  if (!isWorktreeWriter(job) || !agentsMdText) return [];
  const names = new Set([...agentsMdText.matchAll(AGENTS_MD_DOC_RE)].map(m => m[1]).filter(name => trackedFiles.has(name)));
  return [...names].filter(name => !job.context.includes(name)).map(name => `codex-required-read-missing: Job ${job.id}: AGENTS.md names ${name} (tracked), not in this job's context`);
}

// Field lesson #208: `tools/local-config.mjs` (cross-job name) will own this reader; until it lands
// in this workspace, an inline reader of the same file/keys stands in for it (see crossJobNames).
async function loadLocalConfigInline({ home = os.homedir(), env = process.env } = {}) {
  const configPath = env.SWARM_CONFIG || path.join(home, '.project-swarm', 'config.json');
  let text;
  try { text = await fs.readFile(configPath, 'utf8'); } catch { return {}; }
  try { return JSON.parse(text); } catch { throw new Error(`invalid swarm config: ${configPath}`); }
}

function toolchainsDirFor205(env, home) {
  return env.SWARM_TOOLCHAINS || path.join(home, '.project-swarm', 'toolchains');
}

// Field lesson 152: a check that cannot even start (missing tool/module) is discovered only once
// the checkout has no dependencies installed; `validate` flags the obvious, cheap-to-check case.
// Field lesson #219: a package.json with no dependencies/devDependencies/optionalDependencies at
// all has nothing node_modules could ever satisfy; warning about it teaches the reader to skip
// warnings. Only a package.json that actually declares at least one dependency can break this way.
function declaresDependencies(bytes) {
  let data;
  try { data = JSON.parse(bytes.toString('utf8')); } catch { return true; }
  return ['dependencies', 'devDependencies', 'optionalDependencies'].some(key => data && typeof data[key] === 'object' && data[key] !== null && Object.keys(data[key]).length > 0);
}

export const lastFailureLines = (tail, cap = 5) => tail.split('\n').map(line => line.trim()).filter(line => line && FAILURE_LINE_RE.test(line)).slice(-cap);

export const firstFailureLine = tail => tail.split('\n').map(line => line.trim()).find(line => line && FAILURE_LINE_RE.test(line)) ?? null;

export function inventedHashesIn(afterText, beforeText, contextText) {
  const found = new Set();
  for (const match of afterText.matchAll(HEX_HASH_RE)) {
    const hash = match[0];
    if (beforeText.includes(hash) || contextText.includes(hash)) continue;
    found.add(hash);
  }
  return [...found];
}

export function evidenceBlock(failures) {
  if (!Array.isArray(failures) || !failures.length) return '';
  const lines = [EVIDENCE_HEADING];
  for (const failure of failures) {
    lines.push(`### ${failure?.name ?? 'check'}`);
    for (const line of failure?.lines ?? []) lines.push(String(line));
  }
  return lines.join('\n');
}

const quotesJsonDemand = prompt => JSON_DEMAND_RE.test(prompt);

function extractSessionId(stdout) {
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue;
    try { const event = JSON.parse(line); if (typeof event.session_id === 'string' && event.session_id) return event.session_id; } catch { /* not a JSON event line */ }
  }
  return null;
}

// Field lesson 137: a harness or coordinator sometimes has only the absolute manifest path in
// hand (from a replay, a glob, a prior command's own output); accepted transparently once it
// resolves inside --root, exactly as if the relative form had been typed, instead of a bare
// "Invalid relative path" that names no way to fix it.
function resolveManifestArgument(root, argument) {
  if (typeof argument === 'string' && path.isAbsolute(argument)) {
    const relativeForm = path.relative(root, argument).split(path.sep).join('/');
    if (relativeForm && !relativeForm.startsWith('..')) return relativeForm;
  }
  return argument;
}

const reviewSourcePath = file => !isTestFile(file) && /\.(?:[cm]?js|jsx|tsx?|py|rs|go|java|c|cc|cpp|h|swift|rb)$/i.test(file) &&
  !file.split('/').some(part => ['node_modules', 'vendor', 'dist', 'build', 'generated', 'coverage', '.git', '.swarm', '.venv', '__pycache__'].includes(part.toLowerCase()));

const pathContains = (parent, file) => {
  const rel = path.relative(parent, file);
  return rel === '' || (!path.isAbsolute(rel) && rel.split(path.sep)[0] !== '..');
};

// Plain edit distance (insert/delete/substitute), used only to suggest a known job field.
function levenshteinDistance(a, b) {
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diagonal = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const temp = prev[j];
      prev[j] = a[i - 1] === b[j - 1] ? diagonal : 1 + Math.min(diagonal, prev[j], prev[j - 1]);
      diagonal = temp;
    }
  }
  return prev[b.length];
}

// DFS cycle detection over `after`; returns the cycle path (e.g. ['a','b','a']) or null.
function detectAfterCycle(jobs) {
  const byId = new Map(jobs.map(job => [job.id, job]));
  const visited = new Map();
  const stack = [];
  function visit(id) {
    visited.set(id, 'visiting');
    stack.push(id);
    for (const next of byId.get(id).after ?? []) {
      if (visited.get(next) === 'visiting') return [...stack.slice(stack.indexOf(next)), next];
      if (visited.get(next) !== 'done') { const found = visit(next); if (found) return found; }
    }
    stack.pop();
    visited.set(id, 'done');
    return null;
  }
  for (const job of jobs) if (visited.get(job.id) !== 'done') { const found = visit(job.id); if (found) return found; }
  return null;
}

export function claudeArgs(job, { resume } = {}) {
  // Lesson #46 root cause: plan mode let a haiku-requested job run as sonnet for every event.
  // A read-only job (no outputs) gets no edit tools either way, so default mode is enough.
  const tools = (job.outputs.length ? 'Read,Glob,Grep,Write,Edit' : 'Read,Glob,Grep') + (job.web ? ',WebSearch,WebFetch' : '');
  // Without --allowedTools too, the restricted CLI asks for approval on WebSearch/WebFetch and,
  // with no prompt surface, refuses (verified 2026-09-25).
  // Field lesson 116: `--resume` is only added for the one cheap same-session re-ask after an
  // unparsable JSON-only reply; every other call keeps today's exact argv.
  return ['-p', '--restricted', '--safe-mode', '--tools', tools, '--permission-mode', job.outputs.length ? 'acceptEdits' : 'default', '--permission-prompts', 'none', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--no-session-persistence', '--no-chrome', '--output-format', 'stream-json', '--verbose', ...(job.web ? ['--allowedTools', 'WebSearch,WebFetch'] : []), ...(job.model ? ['--model', job.model] : []), ...(resume ? ['--resume', resume] : [])];
}

export function stopChild(child, { killImpl = process.kill.bind(process) } = {}) {
  if (!child?.pid) return Promise.resolve({error:null});
  const target = process.platform !== 'win32' ? -child.pid : child.pid;
  return new Promise(resolve => {
    let timer, finished=false;
    const finish=error=>{if(finished)return;finished=true;clearTimeout(timer);child.removeListener('close',check);resolve({error:error??null});};
    const signal=(kind)=>{try{killImpl(target,kind);return true;}catch(error){if(error.code==='ESRCH'){finish();return false;}const code=/^[A-Z0-9_]+$/.test(error.code??'')?error.code:'UNKNOWN';finish(`Owned worker cleanup failed (${code}) while sending ${kind}; descendants may remain`);return false;}};
    // Keep the group allocated by this spawn as the only cleanup target.
    // Normal leader exit, like cancellation, can leave descendants in that group.
    const check=()=>signal(0);
    if(!signal('SIGTERM'))return;
    timer=setTimeout(()=>{if(signal(0)&&signal('SIGKILL'))finish();},500);
    child.once('close',check);
    // Wait for libuv to reap a terminating leader before probing the group.
    // This avoids a redundant probe during the leader's asynchronous exit.
    if(child.exitCode!=null||child.signalCode!=null)check();
  });
}

// One coalesced state write per interval for the whole run, however many workers are live.
// The shared timer stops with the last observed job and a settled job records nothing further,
// so no throttled write can land after a terminal status.
export function activityRecorder(flush, intervalMs = PROGRESS_INTERVAL, onError = () => {}) {
  let dirty = false, timer = null, closed = false, failure = null;
  const trackers = new Set(), pending = new Set();
  const stop = () => {
    closed = true;
    for (const tracker of trackers) tracker.stop();
    clearInterval(timer); timer = null; dirty = false;
  };
  const tick = () => {
    if (!dirty || closed) return;
    dirty = false;
    // Attach a rejection handler immediately: timer callbacks cannot propagate async errors.
    // Retain the first error for settle(), stop telemetry, and abort this run's workers.
    const operation = Promise.resolve().then(flush).catch(error => {
      failure ??= error;
      stop();
      onError(error);
    });
    pending.add(operation);
    // Both branches remove settled work without creating an unhandled rejected promise.
    operation.then(() => pending.delete(operation), error => { failure ??= error; pending.delete(operation); });
  };
  return {
    stop,
    async settle() {
      await Promise.allSettled([...pending]);
      if (failure) throw failure;
    },
    observe(record) {
      if (closed) throw new Error('Activity recorder has stopped');
      record.progress = { observable: true, stdoutBytes: 0, stderrBytes: 0, firstOutputAt: null, lastOutputAt: null, lastActivityAt: null, sampledAt: new Date().toISOString() };
      if (!timer) { timer = setInterval(tick, intervalMs); timer.unref?.(); }
      let live = true;
      const tracker = {
        onOutput(stream, bytes) {
          if (!live || !(bytes > 0)) return;
          const at = new Date().toISOString();
          record.progress[stream === 'stderr' ? 'stderrBytes' : 'stdoutBytes'] += bytes;
          record.progress.firstOutputAt ??= at;
          record.progress.lastOutputAt = record.progress.lastActivityAt = record.progress.sampledAt = at;
          dirty = true;
        },
        // Called before the terminal record is written; the caller saves the final counters.
        stop() {
          if (!live) return;
          live = false;
          record.progress.sampledAt = new Date().toISOString();
          trackers.delete(tracker);
          if (trackers.size === 0) { clearInterval(timer); timer = null; dirty = false; }
        }
      };
      trackers.add(tracker);
      return tracker;
    }
  };
}

const redactSecrets = text => text.replace(SECRET_PATTERN, '[redacted]');

// Field lesson 19: the last 4 KB of stderr/stdout plus a short named cause, so a crash's real
// reason survives past a later generic "missing output" instead of only living in a rarely-read log.
// Field lesson #202: a job killed by its own timeout while sleep-polling a background command it
// started itself (waiting on a full test suite the boilerplate below tells it never to run) leaves
// a transcript naming exactly what it was doing; this reads that back instead of a bare `null`.
export function transcriptLastActivity(stdout) {
  const commands = [];
  for (const line of (stdout ?? '').split('\n')) {
    if (!line.trim()) continue;
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    if (event?.type !== 'assistant') continue;
    for (const block of event.message?.content ?? []) {
      if (block?.type === 'tool_use' && block.name === 'Bash' && typeof block.input?.command === 'string') {
        commands.push({ command: block.input.command.trim(), background: block.input.run_in_background === true });
      }
    }
  }
  if (!commands.length) return null;
  const last = commands.at(-1);
  if (/^sleep\b/.test(last.command)) {
    const priorBackground = commands.slice(0, -1).reverse().find(entry => entry.background);
    if (priorBackground) return `sleep waiting on ${priorBackground.command.split(/\s+/)[0].split('/').pop()}`;
  }
  return last.command.slice(0, 120);
}

// Field lesson #248: a 5xx or 429 is the provider's own transient failure, never a worker mistake.
const isRetryableApiError = status => status === 429 || (typeof status === 'number' && status >= 500 && status < 600);

// The result of one Hermes/Qwen exchange, from the CLI's stdout and exit code. Used for a local process
// and for a CLI that ran on a remote host (same parser, same envelope rules).
function extraCliResult(job,{stdout,code,reason,error,cleanupError,cliHost}){
  let parsed, failed=cleanupError||reason||(error?'CLI launch failed':null)||(cliHost&&code===255?cliHostFailure(code):null),files=[],edits=[],response='';
  if(!failed)try{parsed=parseExtraCli(job.agent,stdout,code,job.model);const value=validateEnvelope(parsed.value,job.outputs);files=value.files;edits=value.edits??[];response=job.report === 'short' && value.result ? `${value.summary}\n${JSON.stringify(value.result)}\n` : value.summary;}catch(problem){failed=problem.message;}
  return {finalObject:parsed?.value?.result ?? parsed?.value ?? null,cleanupError,terminationReason:reason??null,status:cleanupError?'failed':reason==='timeout'?'timeout':reason==='cancelled'?'cancelled':failed?'failed':'complete',error:failed??null,files,edits,response,stdout:failed?'':JSON.stringify({type:'result',provider:job.agent,status:'complete',actualModel:parsed.actualModel,usage:parsed.usage})+'\n',stderr:'',exitCode:code,actualModel:parsed?.actualModel??null,modelsSeen:parsed?.modelsSeen??[],modelMismatch:parsed?.modelMismatch??false,usage:parsed?.usage??null,modelUsage:null,costUsd:null};
}

// A `setup` failure fails the job exactly like a launched worker that never produced a result,
// without ever spawning the worker itself.
const setupFailedResult = error => ({ status: 'failed', setupFailed: true, refusedBeforeStart: true, error, stdout: '', stderr: '', response: '', exitCode: null, actualModel: null, modelsSeen: [], modelMismatch: false, usage: null, modelUsage: null, costUsd: null, cleanupError: null, terminationReason: null, permissionDenials: [] });

// Field lesson #143: an lsof failure means the parent cannot know what to keep denied, so the job
// is refused the same way a failing `setup` is — the worker is never spawned.
// `hint` is additive only (e.g. "lsof (/usr/sbin/lsof) is not installed"): `error` stays the
// exact 'loopback-scan-failed' string every existing caller matches on.
const loopbackScanFailedResult = (hint = null) => ({ status: 'failed', loopbackScanFailed: true, refusedBeforeStart: true, error: 'loopback-scan-failed', loopbackScanHint: hint, stdout: '', stderr: '', response: '', exitCode: null, actualModel: null, modelsSeen: [], modelMismatch: false, usage: null, modelUsage: null, costUsd: null, cleanupError: null, terminationReason: null, permissionDenials: [] });

// Field lesson #158: a venv python link that resolves nowhere, or a first check that cannot even
// start inside the sandbox, refuses the job the same way — the worker is never spawned.
const venvUnresolvableResult = links => ({ status: 'failed', venvUnresolvable: links, refusedBeforeStart: true, error: `venv-interpreter-unresolvable: ${links.join(', ')}`, stdout: '', stderr: '', response: '', exitCode: null, actualModel: null, modelsSeen: [], modelMismatch: false, usage: null, modelUsage: null, costUsd: null, cleanupError: null, terminationReason: null, permissionDenials: [] });

function syntheticDiff(file, baseBytes, afterBytes) {
  const before = baseBytes.toString('utf8').split('\n'), after = afterBytes.toString('utf8').split('\n');
  return `--- a/${file}\n+++ b/${file}\n@@ -1,${before.length} +1,${after.length} @@\n${before.map(line => `-${line}`).join('\n')}\n${after.map(line => `+${line}`).join('\n')}\n`;
}

function extractFailureLocations(text) {
  return [...new Set([...String(text ?? '').matchAll(FAILURE_LOCATION_RE)].map(match => match[0].replace(/:\d+(-\d+)?$/, '')))];
}

function namedTestPaths(argv) {
  return [...new Set((argv ?? []).filter(token => typeof token === 'string' && !token.startsWith('-')).map(token => token.replace(/^\{root\}\//, '').replace(/^\.\//, '')).filter(token => TEST_FILE_RE.test(token)))];
}

async function applyManifestJobTypes(root, manifest, { env, home = os.homedir() }) {
  await orchestratorManifestGate(root, manifest, env);
  const withReport = job => {
    if (manifest.report !== 'short' && job.report !== 'short') return job;
    if (API_AGENTS.includes(job.agent)) return { ...job, report: 'short' };
    return { ...job, report: 'short', prompt: job.prompt.includes(REPORT_PROMPT_LINE) ? job.prompt : `${job.prompt}\n\n${REPORT_PROMPT_LINE}` };
  };
  const typedJob = (job, options) => applyJobType((manifest.report === 'short' || job.report === 'short') && job.prompt.endsWith(`\n\n${REPORT_PROMPT_LINE}`) ? { ...job, prompt: job.prompt.slice(0, -REPORT_PROMPT_LINE.length - 2) } : job, options);
  if (manifest.jobs.every(job => job.type === undefined)) {
    return { manifest: { ...manifest, jobs: manifest.jobs.map(job => withReport(typedJob(job).job)) }, warnings: [] };
  }
  const skillsSourceDir = resolveSkillsDir(manifest, loadLocalConfig({ env, home }), root);
  if (skillsSourceDir) await assertNoSkillSymlinks(skillsSourceDir);
  const skills = skillsSourceDir ? await listSkills(skillsSourceDir) : [];
  const skillNames = skillsSourceDir ? skills.filter(skill => !skill.broken).map(skill => skill.name) : null;
  const applied = manifest.jobs.map(job => typedJob(job, { skillNames }));
  return {
    manifest: { ...manifest, jobs: applied.map(result => withReport(result.job)) },
    warnings: applied.flatMap(result => result.warnings), skillsSourceDir, skills,
  };
}

function applyLeadChildState(record, childState) {
  record.lead = leadRollup(childState, rollupRun(childState));
  delete record.heldReason;
  delete record.error;
  if (childState.status === 'complete') record.status = 'complete';
  else if (childState.status === 'paused') { record.status = 'held'; record.heldReason = 'child-paused'; }
  else { record.status = 'failed'; record.error = `lead-child-${childState.status}: ${childState.id}`; }
}

export function summarizeRun(state, now=Date.now()) {
 const counts={queued:0,running:0,complete:0,failed:0,timeout:0,cancelled:0,skipped:0};
 const usageByProvider={};
 for(const job of state.jobs){if(Object.hasOwn(counts,job.status))counts[job.status]++;if(job.usage){const usage=usageByProvider[job.agent]??={};for(const[key,value]of Object.entries(job.usage))if(typeof value==='number'&&Number.isFinite(value))usage[key]=(usage[key]??0)+value;}}
 return {id:state.id,status:state.status,concurrency:state.concurrency??null,peakConcurrency:state.peakConcurrency??null,total:state.jobs.length,counts,elapsedMs:Math.max(0,(state.finishedAt?Date.parse(state.finishedAt):now)-Date.parse(state.startedAt)),usageByProvider,jobs:state.jobs.map(job=>({id:job.id,agent:job.agent,status:job.status,queuedAt:job.queuedAt??null,startedAt:job.startedAt??null,finishedAt:job.finishedAt??null,durationMs:job.startedAt?job.durationMs??Math.max(0,now-Date.parse(job.startedAt)):null,progress:progressReport(job,now)}))};
}

const asObject = value => (value && typeof value === 'object' && !Array.isArray(value) ? value : null);

// String-aware brace matching: only counts { and } outside JSON string literals, so a string
// value containing a literal '}' never breaks depth tracking. Returns every balanced top-level
// (depth 0) object span found, in left-to-right order; a nested object inside an array or another
// object's value only ever opens at depth > 0, so it can never be mistaken for the whole reply.
function topLevelObjectSpans(text) {
  const spans = [];
  let depth = 0, start = -1, inString = false, escaped = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') { inString = true; continue; }
    if (char === '{') { if (depth === 0) start = index; depth++; }
    else if (char === '}' && depth > 0) { depth--; if (depth === 0 && start !== -1) { spans.push(text.slice(start, index + 1)); start = -1; } }
  }
  return spans;
}

const cappedNotes = value => (Array.isArray(value?.notes) ? value.notes : []).slice(0, MAX_NOTES).map(note => typeof note === 'string' ? note.slice(0, MAX_NOTE_LEN) : note);

export const hasAbsenceClaim = text => typeof text === 'string' && ABSENCE_CLAIM_PATTERN.test(text);

export function normalizeChangedEntry(raw) {
  let text = raw.trim();
  text = text.replace(/\s*\([^()]*\)\s*$/, '').trim();
  text = text.replace(CHANGED_STATUS_WORD_RE, '').trim();
  // Field lesson #270: a self-reported path may still carry a trailing `:line` or `:start-end`
  // reference (the same shape a stack trace or a test failure line names); stripped last so
  // `src/x.py:1009` matches the declared output `src/x.py` instead of reading as a whole new file.
  text = text.replace(/:\d+(-\d+)?$/, '').trim();
  return text;
}

export { applyLeadChildState, applyManifestJobTypes, asObject, attachJobSkills, cappedNotes, declaresDependencies, detectAfterCycle, digest, execFileAsync, extraCliResult, extractFailureLocations, extractSessionId, fail, invokedProgramsFor, isDocOnlyJob, isRetryableApiError, levenshteinDistance, loadLocalConfigInline, loopbackScanFailedResult, namedTestPaths, parseContractEventRows, pathContains, programOnPath, quotesJsonDemand, quotesRuntimeFailure, redactSecrets, resolveManifestArgument, reviewSourcePath, runId, setupFailedResult, syntheticDiff, toolchainsDir, toolchainsDirFor205, topLevelObjectSpans, validateOutputCap, venvUnresolvableResult };
