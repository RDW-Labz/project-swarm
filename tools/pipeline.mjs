// SPDX-License-Identifier: Apache-2.0
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { parsePrPayload } from './ship.mjs';
import { isDeepStrictEqual } from 'node:util';

export const PIPELINE_STAGES = Object.freeze(['run', 'inspect', 'integrate', 'checks', 'commit', 'ship']);
export const TICKET_USAGE = [
  'Usage: swarm [--root PROJECT] ticket MANIFEST --pr PAYLOAD',
  '       [--check ARGVJSON]... [--repo OWNER/NAME] [--branch BRANCH]',
  '       [--commit-message MESSAGE] [--require-section SECTION]... [--resume RUN]',
  '       [--wait-required-only] [--help|-h]',
].join('\n') + '\n';
const LOCKFILES = ['package-lock.json', 'npm-shrinkwrap.json', 'uv.lock', 'pnpm-lock.yaml', 'yarn.lock', 'Cargo.lock'];
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const errorResult = (stage, code, detail) => ({ status: 'error', stage, detail: { code, ...detail } });
const stageFailure = (stage, result) => errorResult(stage, 'pipeline-stage-failed', { result });
function argsError(message) {
  const error = new Error(message);
  error.pipelineError = errorResult('parse', 'ticket-args', { message });
  throw error;
}

// Pure parser: the CLI owns printing this result/error and choosing its exit code.
export function parseTicketArgs(argv) {
  if (argv.includes('--help') || argv.includes('-h')) return { help: true };
  const options = { checks: [], requireSections: [], waitRequiredOnly: false };
  const keys = { '--root': 'root', '--pr': 'payloadPath', '--repo': 'repo', '--branch': 'branch', '--commit-message': 'commitMessage', '--resume': 'resume' };
  const seen = new Set();
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    if (!flag.startsWith('-')) {
      if (options.manifestPath) argsError('ticket requires exactly one manifest');
      options.manifestPath = flag;
      continue;
    }
    if (!(flag in keys) && !['--check', '--require-section', '--wait-required-only'].includes(flag)) argsError('unknown ticket flag: ' + flag);
    if (!['--check', '--require-section'].includes(flag)) {
      if (seen.has(flag)) argsError('duplicate ticket flag: ' + flag);
      seen.add(flag);
    }
    if (flag === '--wait-required-only') { options.waitRequiredOnly = true; continue; }
    const value = argv[++index];
    if (typeof value !== 'string' || !value.trim() || value.includes('\0') || value.startsWith('--')) argsError(flag + ' requires a value');
    if (flag === '--check') {
      let check;
      try { check = JSON.parse(value); } catch { argsError('--check requires a JSON array of argv strings'); }
      if (!Array.isArray(check) || !check.length || check.some(item => typeof item !== 'string' || !item || item.includes('\0'))) argsError('--check requires a JSON array of argv strings');
      if (options.checks.length >= 10) argsError('at most 10 --check flags');
      options.checks.push({ name: 'ticket-check-' + (options.checks.length + 1), argv: check });
    } else if (flag === '--require-section') options.requireSections.push(value);
    else options[keys[flag]] = value;
  }
  if (!options.manifestPath || !options.payloadPath) argsError('ticket requires MANIFEST and --pr PAYLOAD');
  if (options.repo !== undefined && !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(options.repo)) argsError('invalid repo');
  if (options.branch !== undefined && !validBranch(options.branch)) argsError('invalid branch');
  if (options.resume !== undefined && !validRunId(options.resume)) argsError('invalid resume run');
  return options;
}
const validRunId = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/.test(value);
const validBranch = value => typeof value === 'string' && /^[A-Za-z0-9._/-]{1,200}$/.test(value) && !value.startsWith('-');
const plainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const digestValue = value => value === null || (typeof value === 'string' && /^[a-f0-9]{64}$/.test(value));
const isoUtc = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
function relativeFile(file) {
  return typeof file === 'string' && file.length > 0 && !file.includes('\0') && !file.includes('\\') && !path.isAbsolute(file) && file.split('/').every(part => part && part !== '.' && part !== '..');
}
// Refuse symlink components, including an existing journal. Never follow a run directory
// outside root on resume, even if its saved identity would otherwise validate.
async function safeFile(root, relative) {
  if (!relativeFile(relative)) throw new Error('unsafe path');
  let current = root;
  for (const part of relative.split('/')) {
    current = path.join(current, part);
    try { if ((await fs.lstat(current)).isSymbolicLink()) throw new Error('symlink path'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return current;
}
async function lockfileHashes(root) {
  const result = {};
  for (const file of LOCKFILES) {
    const absolute = await safeFile(root, file);
    try { result[file] = hash(await fs.readFile(absolute)); }
    catch (error) { if (error.code !== 'ENOENT') throw error; result[file] = null; }
  }
  return result;
}
async function dirtyPaths(root, exec) {
  const result = await exec('git', ['status', '--porcelain=v1', '-z', '--untracked-files=all'], { cwd: root });
  if (result.code !== 0) throw new Error('git status failed');
  const records = String(result.stdout).split('\0'), paths = [];
  for (let index = 0; index < records.length; index++) {
    const record = records[index];
    if (!record) continue;
    if (record.length < 4 || record[2] !== ' ') throw new Error('invalid git status');
    paths.push(record.slice(3));
    if (/[RC]/.test(record.slice(0, 2))) {
      if (!records[index + 1]) throw new Error('invalid git rename status');
      paths.push(records[++index]);
    }
  }
  return [...new Set(paths)].sort();
}
function validateJournal(journal, identity) {
  if (!plainObject(journal) || journal.version !== 1) throw new Error('invalid pipeline schema');
  const keys = [...Object.keys(identity), 'lockfileBaseline', 'stages'];
  if (Object.keys(journal).length !== keys.length || keys.some(key => !Object.hasOwn(journal, key))) throw new Error('invalid pipeline keys');
  for (const [key, value] of Object.entries(identity)) {
    if (!isDeepStrictEqual(journal[key], value)) throw new Error('pipeline identity mismatch: ' + key);
  }
  if (!plainObject(journal.lockfileBaseline) || Object.keys(journal.lockfileBaseline).length !== LOCKFILES.length || LOCKFILES.some(file => !Object.hasOwn(journal.lockfileBaseline, file) || !digestValue(journal.lockfileBaseline[file]))) throw new Error('invalid lockfile baseline');
  if (!Array.isArray(journal.stages)) throw new Error('invalid stages');
  const latest = new Map();
  for (const entry of journal.stages) {
    if (!plainObject(entry) || !PIPELINE_STAGES.includes(entry.stage) || !['running', 'ok', 'error'].includes(entry.status) || !plainObject(entry.detail) || !isoUtc(entry.startedAt)) throw new Error('invalid stage entry');
    if (Object.keys(entry).length !== 5 || !Object.hasOwn(entry, 'finishedAt')) throw new Error('invalid stage keys');
    const prior = latest.get(entry.stage);
    const index = PIPELINE_STAGES.indexOf(entry.stage);
    if (PIPELINE_STAGES.slice(0, index).some(stage => latest.get(stage)?.status !== 'ok') || PIPELINE_STAGES.slice(index + 1).some(stage => latest.has(stage))) throw new Error('invalid stage dependency order');
    if (entry.stage === 'checks' && Object.hasOwn(entry.detail, 'lockfileHashes') && (!plainObject(entry.detail.lockfileHashes) || LOCKFILES.some(file => !Object.hasOwn(entry.detail.lockfileHashes, file) || !digestValue(entry.detail.lockfileHashes[file])))) throw new Error('invalid checked lockfiles');
    if (entry.status === 'running') {
      if (entry.finishedAt !== null || (prior && prior.status !== 'error')) throw new Error('invalid running entry');
    } else if (!prior || prior.status !== 'running' || prior.startedAt !== entry.startedAt || !isoUtc(entry.finishedAt) || Date.parse(entry.finishedAt) < Date.parse(entry.startedAt)) throw new Error('invalid final entry');
    latest.set(entry.stage, entry);
  }
  return latest;
}
function stagePassed(stage, result) {
  if (!plainObject(result)) return false;
  if (stage === 'run') return result.status === 'complete' && Array.isArray(result.jobs) && result.jobs.every(job => job.status === 'complete');
  if (stage === 'inspect') return Array.isArray(result.jobs) && result.jobs.every(job => job.status === 'complete') && Array.isArray(result.files) && result.files.every(file => ['ready', 'unchanged'].includes(file.status));
  if (stage === 'integrate') return result.status === 'integrated' && (!result.integrationStatus || result.integrationStatus === 'complete') &&
    !['rejected', 'blocked', 'blockedEvidence', 'deviations', 'acceptedDeviations', 'salvagedJobs'].some(key => Array.isArray(result[key]) ? result[key].length > 0 : Boolean(result[key])) &&
    (result.preChecks ?? []).every(check => check.status === 'passed');
  if (stage === 'checks') return result.checksPassed === true && !result.checksErrored;
  if (stage === 'commit') return ['committed', 'unchanged'].includes(result.status) && typeof result.sha === 'string' && result.sha.length > 0 && !result.error && (result.code === undefined || result.code === 0);
  return ['merged', 'held', 'ready'].includes(result.status);
}

export async function ticketPipeline(root, options, deps) {
  try { return await runPipeline(root, options, deps); }
  catch (error) { return errorResult('resume', 'pipeline-invalid', { message: error.message }); }
}

async function runPipeline(root, options, deps) {
  if (options.help) return { help: true };
  let journal, journalPath, identity, manifest, payload, outputs, runId, latest;
  const now = deps.now ?? Date.now;
  try {
    root = await fs.realpath(root);
    if (!options.manifestPath || !options.payloadPath) throw new Error('ticket requires MANIFEST and --pr PAYLOAD');
    const manifestPath = path.relative(root, path.resolve(root, options.manifestPath));
    const manifestBytes = await fs.readFile(await safeFile(root, manifestPath));
    manifest = JSON.parse(manifestBytes.toString('utf8'));
    if (!Array.isArray(manifest.jobs) || !manifest.jobs.length) throw new Error('invalid manifest jobs');
    outputs = [...new Set(manifest.jobs.flatMap(job => {
      if (!Array.isArray(job.outputs)) throw new Error('invalid outputs');
      return job.outputs;
    }))].sort();
    for (const file of outputs) {
      if (!relativeFile(file) || ['.git', '.swarm'].includes(file.split('/')[0])) throw new Error('unsafe output path');
      await safeFile(root, file);
    }
    const payloadPath = await fs.realpath(path.resolve(root, options.payloadPath));
    const payloadBytes = await fs.readFile(payloadPath);
    payload = parsePrPayload(payloadBytes.toString('utf8'));
    const branch = options.branch ?? payload.head;
    if (!validBranch(branch)) throw new Error('invalid branch');
    const checks = options.checks ?? [];
    if (!Array.isArray(checks) || checks.length > 10 || checks.some((check, index) => check.name !== 'ticket-check-' + (index + 1) || !Array.isArray(check.argv) || !check.argv.length || check.argv.some(arg => typeof arg !== 'string' || !arg || arg.includes('\0')))) throw new Error('invalid additional checks');
    if (checks.some(check => (manifest.checks ?? []).some(existing => existing.name === check.name))) throw new Error('additional check name collides with manifest');
    const normalized = { repo: options.repo ?? null, branch, commitMessage: options.commitMessage ?? payload.title, requireSections: options.requireSections ?? [], checks, waitRequiredOnly: options.waitRequiredOnly ?? false };
    if ((normalized.repo !== null && !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(normalized.repo)) || typeof normalized.commitMessage !== 'string' || !normalized.commitMessage.trim() || !Array.isArray(normalized.requireSections) || normalized.requireSections.some(section => typeof section !== 'string' || !section.trim()) || typeof normalized.waitRequiredOnly !== 'boolean') throw new Error('invalid ticket options');
    runId = options.resume ?? deps.makeRunId('ticket');
    if (!validRunId(runId)) throw new Error('invalid run id');
    journalPath = await safeFile(root, '.swarm/runs/' + runId + '/pipeline.json');
    identity = { version: 1, runId, root, manifestPath, manifestHash: hash(manifestBytes), payloadPath, payloadHash: hash(payloadBytes), options: normalized };
    if (options.resume) {
      journal = JSON.parse(await fs.readFile(journalPath, 'utf8'));
      latest = validateJournal(journal, identity);
      const interrupted = [...latest.values()].find(entry => entry.status === 'running');
      if (interrupted) return errorResult('resume', 'pipeline-resume-unsafe', { stage: interrupted.stage });
      if (latest.get('run')?.status === 'error') return stageFailure('run', latest.get('run').detail);
    } else {
      journal = { ...identity, lockfileBaseline: await lockfileHashes(root), stages: [] };
      latest = new Map();
      try { await fs.lstat(path.dirname(journalPath)); throw new Error('run directory already exists'); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  } catch (error) {
    return errorResult(options.resume ? 'resume' : 'parse', options.resume ? 'pipeline-invalid' : 'ticket-args', { message: error.message });
  }

  const flush = async () => {
    await safeFile(root, '.swarm/runs/' + runId + '/pipeline.json');
    const temporary = journalPath + '.' + randomUUID() + '.tmp';
    await fs.writeFile(temporary, JSON.stringify(journal, null, 2) + '\n', { flag: 'wx' });
    await fs.rename(temporary, journalPath);
  };
  if (latest.get('ship')?.status !== 'ok') {
    const branchResult = await deps.exec('git', ['symbolic-ref', '--quiet', '--short', 'HEAD'], { cwd: root });
    const actual = branchResult.code === 0 ? branchResult.stdout.trim() : '';
    if (!actual || actual !== identity.options.branch || identity.options.branch !== payload.head) return errorResult('run', 'pipeline-branch-mismatch', { expected: identity.options.branch, actual });
    if (!options.resume || !latest.has('run')) {
      const dirty = await dirtyPaths(root, deps.exec);
      if (dirty.length) return errorResult('commit', 'pipeline-dirty', { paths: dirty });
    }
  }
  if (!options.resume) {
    await fs.mkdir(path.dirname(journalPath), { recursive: true });
    await flush();
  }
  for (const stage of PIPELINE_STAGES) {
    const latest = journal.stages.findLast(entry => entry.stage === stage);
    if (latest && latest.status === 'ok') continue;
    const startedAt = new Date(now()).toISOString();
    journal.stages.push({ stage, status: 'running', startedAt, finishedAt: null, detail: {} });
    await flush();
    let result, failure, ok = false;
    try {
      if (stage === 'run') result = await deps.run(root, manifest, runId);
      else if (stage === 'inspect') result = await deps.inspect(root, runId);
      else if (stage === 'integrate') {
        const current = await lockfileHashes(root);
        const dirtyLocks = LOCKFILES.filter(file => current[file] !== journal.lockfileBaseline[file]);
        if (!latest && dirtyLocks.length) {
          failure = errorResult('commit', 'pipeline-dirty', { paths: dirtyLocks.sort() });
          result = failure.detail;
        } else result = await deps.integrate(root, runId, { noChecks: true });
      }
      else if (stage === 'checks') {
        result = await deps.checks(root, runId, identity.options.checks);
        if (plainObject(result)) result = { ...result, lockfileHashes: await lockfileHashes(root) };
      }
      else if (stage === 'commit') {
        const after = await lockfileHashes(root);
        const checkedLocks = journal.stages.findLast(entry => entry.stage === 'checks' && entry.status === 'ok').detail.lockfileHashes ?? after;
        const changedAfterChecks = LOCKFILES.filter(file => after[file] !== checkedLocks[file]);
        if (changedAfterChecks.length) {
          failure = errorResult('commit', 'pipeline-dirty', { paths: changedAfterChecks.sort() });
          result = failure.detail;
        }
        const integrated = journal.stages.findLast(entry => entry.stage === 'integrate' && entry.status === 'ok')?.detail;
        const openJobs = manifest.jobs.filter(job => job.agent === 'codex' && job.scope === 'open');
        const validatedOpenScopeFiles = openJobs.length && stagePassed('integrate', integrated) ? (integrated.files ?? []).filter(file => {
          if (!relativeFile(file) || file.includes(':') || file.split('/').some(part => ['.git', '.swarm'].includes(part.toLowerCase()))) throw new Error('unsafe integrated path');
          return openJobs.some(job => job.outputs.includes(file) || (job.outputDirs ?? []).some(dir => {
            const rel = path.relative(dir, file);
            return rel && !path.isAbsolute(rel) && rel.split(path.sep)[0] !== '..';
          }));
        }) : [];
        const files = [...new Set([...outputs, ...validatedOpenScopeFiles, ...LOCKFILES.filter(file => after[file] !== journal.lockfileBaseline[file])])].sort();
        for (const file of files) await safeFile(root, file);
        const dirty = await dirtyPaths(root, deps.exec);
        const unrelated = dirty.filter(file => !files.includes(file));
        if (failure) { /* A lockfile changed after the checks; never stage it. */ }
        else if (unrelated.length) {
          failure = errorResult('commit', 'pipeline-dirty', { paths: unrelated });
          result = failure.detail;
        } else if (!dirty.length) {
          const sha = await deps.exec('git', ['rev-parse', 'HEAD'], { cwd: root });
          if (sha.code !== 0 || !sha.stdout.trim()) throw new Error('cannot read commit SHA');
          result = { status: 'unchanged', files: [], sha: sha.stdout.trim() };
        } else {
          result = await deps.commit(root, files, identity.options.commitMessage);
          const committed = plainObject(result) && !result.error && result.committed !== false && (result.code === undefined || result.code === 0) &&
            (result.status === 'committed' || (!result.status && (result.committed === true || (typeof result.sha === 'string' && result.sha.length > 0))));
          if (committed) {
            const sha = await deps.exec('git', ['rev-parse', 'HEAD'], { cwd: root });
            if (sha.code !== 0 || !sha.stdout.trim()) throw new Error('cannot read commit SHA');
            result = { ...result, status: 'committed', sha: sha.stdout.trim() };
            const remaining = await dirtyPaths(root, deps.exec);
            if (remaining.length) { failure = errorResult('commit', 'pipeline-dirty', { paths: remaining }); result = { ...result, ...failure.detail }; }
          }
        }
      } else result = await deps.ship(root, runId, { payloadPath: identity.payloadPath, ...(identity.options.repo ? { repo: identity.options.repo } : {}), requireSections: identity.options.requireSections, additionalChecks: identity.options.checks, ...(identity.options.waitRequiredOnly ? { waitRequiredOnly: true } : {}) });
      ok = !failure && stagePassed(stage, result) && (stage !== 'run' || result.id === runId);
    } catch (error) { result = { message: error.message }; }
    // Never persist worker credentials or transcripts from a successful run state.
    const detail = stage === 'run' && result?.jobs ? { id: result.id, status: result.status, ...(!ok ? { jobs: result.jobs.map(job => ({ id: job.id, status: job.status, ...(job.setupFailed ? { setupFailed: true } : {}), ...(job.resultMissing ? { resultMissing: true } : {}) })) } : {}) } : result ?? {};
    journal.stages.push({ stage, status: ok ? 'ok' : 'error', startedAt, finishedAt: new Date(now()).toISOString(), detail });
    await flush();
    failure ??= stageFailure(stage, detail);
    if (!ok) return failure;
  }
  return { status: 'complete', runId, ship: journal.stages.findLast(entry => entry.stage === 'ship').detail };
}
