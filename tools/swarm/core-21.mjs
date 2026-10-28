import { assertScratchOutsideRepo, scratchRootDir } from '../claude-shell.mjs';
import { git } from '../codex-adapter.mjs';
import { appendEvent, readJournal } from '../journal.mjs';
import { handledForYou, loadPolicy, policyPath } from '../policy.mjs';
import { expandCheckArgv } from './checks.mjs';
import { execFileAsync, fail, toolchainsDir, topLevelObjectSpans } from './core-1.mjs';
import { highestSemver, readMutantsSource, relative, runCheck, shellGrantedPathPrefixes, toolchainInventory, tryObject } from './core-11.mjs';
import { collectOpenPolicyRequests, raisedTodayUsdFromAutoDecisions } from './core-12.mjs';
import { applyPolicyDecision, compareSemver, parseSemver } from './core-2.mjs';
import { CONTEXT_GLOB, TMP_PREFIX_RE, TOOLCHAIN_TMP_ENV_VARS } from './patterns.mjs';
import { shellSandboxDeniedMatches } from './shell-sandbox.mjs';
import fss, { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export async function toolchainsReport({ root, env = process.env, home = os.homedir(), platform = process.platform, fsImpl = fs, access } = {}) {
  const dir = platform === 'win32' ? env.SWARM_TOOLCHAINS || path.win32.join(home, '.project-swarm', 'toolchains') : toolchainsDir({ env, home });
  let exists = false;
  try { exists = (await fsImpl.stat(dir)).isDirectory(); } catch { exists = false; }
  const tmpPaths = [];
  for (const entry of String(env.PATH ?? '').split(platform === 'win32' ? ';' : path.delimiter)) if (entry && TMP_PREFIX_RE.test(entry)) tmpPaths.push({ name: 'PATH', path: entry });
  for (const name of TOOLCHAIN_TMP_ENV_VARS) if (typeof env[name] === 'string' && TMP_PREFIX_RE.test(env[name])) tmpPaths.push({ name, path: env[name] });
  const inventory = root === undefined ? null : await toolchainInventory(root, { env, home, platform, fsImpl, access });
  return { dir, exists, tmpPaths, ...(inventory ? { inventory } : {}) };
}

export function shellSandboxDeniedCheckWarnings(manifest, { env = process.env, home = os.homedir() } = {}) {
  if (!manifest.jobs.some(job => job.shell === true)) return [];
  const warnings = [];
  const sharedGranted = shellGrantedPathPrefixes(manifest, { env, home });
  for (const check of manifest.checks ?? []) {
    const denied = shellSandboxDeniedMatches(check.argv.join(' '), { grantedPrefixes: sharedGranted, home });
    if (denied.length) warnings.push({
      code: 'shell-sandbox-denied-check', check: check.name,
      message: `check "${check.name}" names a path outside this worktree (${denied[0]}); a shell worker's sandbox denies it and can never run it itself — say so in the job prompt ("integrate runs this") or move the check under the project root.`,
    });
  }
  for (const job of manifest.jobs) {
    if (job.shell !== true) continue;
    const granted = shellGrantedPathPrefixes({ jobs: [job] }, { env, home });
    if (shellSandboxDeniedMatches(job.prompt, { grantedPrefixes: granted, home }).length && !/integrate runs this/i.test(job.prompt)) warnings.push({
      code: 'shell-sandbox-denied-prompt-path', jobId: job.id,
      message: `job ${job.id}'s prompt names a path outside this worktree that its own sandbox denies, without saying "integrate runs this".`,
    });
  }
  return warnings;
}

export function parseContextGlob(pattern) {
  if (typeof pattern !== 'string' || pattern.includes('**')) fail(`Invalid contextGlob (no ** supported): ${pattern}`);
  const match = CONTEXT_GLOB.exec(pattern);
  if (!match) fail(`Invalid contextGlob (expected dir/*.ext or dir/prefix*.ext): ${pattern}`);
  relative(match[1]);
  return { dir: match[1], prefix: match[2], ext: match[3] };
}

async function safePath(root, value, { internal = false, parents = false, readOnly = false } = {}) {
  const parts = relative(value, internal, { readOnly });
  let current = root;
  for (let index = 0; index < parts.length; index++) {
    current = path.join(current, parts[index]);
    let info;
    try { info = await fs.lstat(current); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (info?.isSymbolicLink()) fail(`Symlink refused: ${value}`);
    if (info && index < parts.length - 1 && !info.isDirectory()) fail(`Non-directory parent: ${value}`);
    if (!info && parents && index < parts.length - 1) { try { await fs.mkdir(current); } catch (error) { if (error.code !== 'EEXIST') throw error; const created=await fs.lstat(current); if (!created.isDirectory() || created.isSymbolicLink()) fail(`Unsafe parent: ${value}`); } }
  }
  return current;
}

// Shared by manifest.mutants and a post-build mutants source (job `mutantsFile` output or
// `--mutants-file`): the same shape and cap apply regardless of where the mutants came from.
// Field lesson #171: a worker-written mutants file often uses `id` where this shape wants `name`
// (the coordinator used to convert it by hand); `id` is accepted as an alias for `name` here —
// renamed before any other check runs — with a warning appended to `warnings` when the caller
// wants one surfaced (`swarm mutants` does; a plain manifest.mutants validation does not need to).
function validateMutantsArray(mutants, warnings = []) {
  if (!Array.isArray(mutants) || mutants.length > 32) fail('mutants must be an array of at most 32 mutants');
  const mutantNames = new Set();
  const normalized = [];
  for (const rawMutant of mutants) {
    if (!rawMutant || typeof rawMutant !== 'object') fail('Invalid mutant');
    let mutant = rawMutant;
    if (mutant.name === undefined && typeof mutant.id === 'string') {
      const { id, ...rest } = mutant;
      mutant = { ...rest, name: id };
      warnings.push(`mutant ${JSON.stringify(id)}: "id" is not the mutants shape; aliased to "name" (rename it to drop this warning)`);
    }
    // Field lesson #199: a worker's own mutants file may carry its evidence (which tests it saw
    // kill each mutant); killedBy/note are documentation-only fields, accepted with a warning,
    // never a reason to refuse the file the way a genuinely unknown field still is.
    for (const key of Object.keys(mutant)) if (!['name', 'file', 'find', 'replace', 'check', 'killedBy', 'note'].includes(key)) fail(`Unknown mutant field: ${key}`);
    if (typeof mutant.name !== 'string' || !mutant.name.trim() || mutantNames.has(mutant.name)) fail(`Invalid or duplicate mutant name: ${mutant?.name}`);
    mutantNames.add(mutant.name);
    relative(mutant.file);
    if (typeof mutant.find !== 'string' || !mutant.find) fail(`Mutant find must be a non-empty string: ${mutant.name}`);
    if (typeof mutant.replace !== 'string') fail(`Mutant replace must be a string: ${mutant.name}`);
    // Field lesson #162: a mutant may name its own check argv (a harness view for a layout rule
    // unit tests never read), overriding manifest.mutantCheck / --mutant-check for that mutant.
    if (mutant.check !== undefined && (!Array.isArray(mutant.check) || !mutant.check.length || mutant.check.some(item => typeof item !== 'string' || !item))) fail(`Mutant check must be a non-empty argv array of strings: ${mutant.name}`);
    if (mutant.killedBy !== undefined) {
      if (typeof mutant.killedBy !== 'string' && !(Array.isArray(mutant.killedBy) && mutant.killedBy.length && mutant.killedBy.every(item => typeof item === 'string' && item))) fail(`Mutant killedBy must be a string or non-empty array of strings: ${mutant.name}`);
      warnings.push(`mutant ${JSON.stringify(mutant.name)}: "killedBy" is documentation only, not itself validated here`);
    }
    if (mutant.note !== undefined) {
      if (typeof mutant.note !== 'string') fail(`Mutant note must be a string: ${mutant.name}`);
      warnings.push(`mutant ${JSON.stringify(mutant.name)}: "note" is documentation only, ignored`);
    }
    normalized.push(mutant);
  }
  return normalized;
}

// The rightmost balanced top-level object that actually parses; an earlier, malformed-looking
// span never masks a later valid one.
function lastTopLevelObject(text) {
  const spans = topLevelObjectSpans(text);
  for (let index = spans.length - 1; index >= 0; index--) {
    const value = tryObject(spans[index]);
    if (value) return value;
  }
  return null;
}

// Field lesson #253: re-runs one failing check's own argv against the committed base's tree (a
// throwaway detached worktree, same shape as the flake-on-base check just below) to tell a
// failure this integration introduced from one that was already there.
async function originForCheck(root, baseCommit, check, integratedFiles, newFiles, resolvedProgram, spawnImpl, env, gitImpl = git) {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-origin-'));
  const checkout = path.join(temporary, 'base');
  let added = false;
  try {
    await gitImpl(root, ['worktree', 'add', '--detach', checkout, baseCommit]);
    added = true;
    const baseArgvRaw = expandCheckArgv(check.argv, integratedFiles, newFiles, checkout).argv;
    const baseArgv = resolvedProgram ? [resolvedProgram, ...baseArgvRaw.slice(1)] : baseArgvRaw;
    const probe = await runCheck(check.name, baseArgv, checkout, check.timeoutMs ?? 300000, spawnImpl, false, () => {}, env);
    return probe.status === 'failed' ? 'pre-existing' : 'new';
  } catch {
    // Base could not be verified either way; never claim pre-existing without proof.
    return 'new';
  } finally {
    try { if (added) await gitImpl(root, ['worktree', 'remove', '--force', checkout]); } catch (error) { console.error('[tools/swarm/core-21.mjs] worktree remove checkout:', error?.message ?? error, checkout); }
    await fs.rm(temporary, { recursive: true, force: true }).catch((error) => { console.error('[tools/swarm/core-21.mjs] rm temporary:', error?.message ?? error, temporary); });
  }
}

// `--mutants-file` names a coordinator-supplied file, resolved like `ship`'s `--pr` payload: not
// subject to the in-repo path-safety rules, since it is read locally, never written or copied.
async function loadMutantsFile(path_) {
  let raw;
  try { raw = await fs.readFile(path_, 'utf8'); } catch { fail(`Could not read mutants file: ${path_}`); }
  let data;
  try { data = JSON.parse(raw); } catch { fail(`Invalid JSON in mutants file: ${path_}`); }
  return readMutantsSource(path_, data);
}

// Field lesson #236: `--mutants-file` naming one of THIS SAME run's own job outputs is not on disk
// at the project root yet (integrate validates every mutants source before writing a single file);
// its bytes are already sitting in `writes`, computed a few lines above this call, so those are
// tried before ever failing "Could not read".
async function loadMutantsFileForIntegrate(root, mutantsFile, writes) {
  const resolved = path.resolve(root, mutantsFile);
  let raw = null;
  try { raw = await fs.readFile(resolved, 'utf8'); } catch (error) { if (error?.code !== 'ENOENT') console.error('[tools/swarm/core-21.mjs] readFile resolved:', error?.message ?? error, resolved); }
  if (raw === null) {
    const fromRun = writes.find(change => change.file === mutantsFile && change.bytes !== null);
    if (fromRun) raw = fromRun.bytes.toString('utf8');
  }
  if (raw === null) fail(`Could not read mutants file: ${resolved}`);
  let data;
  try { data = JSON.parse(raw); } catch { fail(`Invalid JSON in mutants file: ${resolved}`); }
  return readMutantsSource(resolved, data);
}

export async function swarmVersion(root,{check=false}={}){
  root=await fs.realpath(root);
  const pkg=JSON.parse(await fs.readFile(path.join(root,'package.json'),'utf8'));
  let tag=null;
  try{tag=(await execFileAsync('git',['-C',root,'describe','--tags','--exact-match'],{encoding:'utf8'})).stdout.trim()||null;}catch{tag=null;}
  const result={version:pkg.version,installRoot:root,tag};
  if(check){
    try{
      const {stdout}=await execFileAsync('git',['-C',root,'ls-remote','--tags','--refs','origin','v*'],{encoding:'utf8'});
      const tags=[...stdout.matchAll(/refs\/tags\/(v\d+\.\d+\.\d+)/g)].map(m=>m[1]);
      const latest=highestSemver(tags);
      result.latest=latest?latest.replace(/^v/,''):null;
      result.updateAvailable=latest?compareSemver(parseSemver(latest),parseSemver(pkg.version))>0:false;
    }catch(error){
      result.latest=null;
      result.checkError=String(error.message??error).split('\n')[0].slice(0,200);
    }
    // Field lesson #280: proven at install-check time, not first dispatch — the same regression
    // the reopened #263r shell-job failure showed only shows up on a shell job's own first refusal.
    const root2 = scratchRootDir({ env: process.env });
    try { await assertScratchOutsideRepo(root2, file => fs.access(file)); result.scratchOutsideRepo = true; }
    catch { result.scratchOutsideRepo = false; result.scratchRoot = root2; }
  }
  return result;
}

function autopilotPolicyPass(root) {
  const policyFile = policyPath(process.env, os.homedir());
  if (!existsSync(policyFile)) return undefined;
  return {
    loadRules: async () => {
      const { rules, error } = loadPolicy(policyFile, { fs: fss });
      if (error) return null;
      return rules;
    },
    openRequests: collectOpenPolicyRequests,
    factsOf: item => item?.facts ?? {},
    apply: async ({ item }) => applyPolicyDecision(root, item),
    billedTodayUsd: async r => {
      const { billedTodayUsd } = await import('../spend.mjs');
      return billedTodayUsd(r);
    },
    dailyLimitSettings: async r => {
      const { loadDailyLimitSettings } = await import('../spend.mjs');
      const loaded = await loadDailyLimitSettings(r, { env: process.env, homedir: () => os.homedir() });
      return loaded.ok ? loaded.settings : {};
    },
    readHandled: async () => handledForYou(await readJournal(root, { limit: Infinity })),
    appendAutoDecisionDeps: {
      appendJournal: async (r, line, opts) => appendEvent(r, line, opts),
      appendEvents: async (r, line) => {
        const { appendEvent: appendOrchestratorEvent } = await import('../orchestrator-events.mjs');
        return appendOrchestratorEvent(r, line);
      },
    },
    events: async line => {
      const { appendEvent: appendOrchestratorEvent } = await import('../orchestrator-events.mjs');
      return appendOrchestratorEvent(root, line);
    },
    machine: os.hostname(),
  };
}

async function dispatchPolicyCli(root, args) {
  const fss = await import('node:fs');
  const { policyCommand, POLICY_USAGE } = await import('../policy-commands.mjs');
  const write = text => process.stdout.write(text.endsWith('\n') ? text : `${text}\n`);
  const sub = args[0];
  if (sub === 'check') {
    const kind = args[1];
    const factsAt = args.indexOf('--facts');
    if (!kind || factsAt !== 2 || factsAt + 1 >= args.length) {
      write(POLICY_USAGE);
      return 2;
    }
    let callerFacts;
    try {
      callerFacts = JSON.parse(args[factsAt + 1]);
    } catch {
      process.stderr.write('invalid facts json\n');
      return 1;
    }
    const ignoredFacts = [];
    if (callerFacts && typeof callerFacts === 'object' && !Array.isArray(callerFacts)) {
      if (Object.hasOwn(callerFacts, 'pastDailyAutoLimit')) ignoredFacts.push('pastDailyAutoLimit');
      if (Object.hasOwn(callerFacts, 'raisedTodayUsd')) ignoredFacts.push('raisedTodayUsd');
    }
    const { decide, loadPolicy, policyPath, autoDecisionEvent } = await import('../policy.mjs');
    const { appendAutoDecision } = await import('../policy-run.mjs');
    const { billedTodayUsd, loadDailyLimitSettings } = await import('../spend.mjs');
    const { resolveDailyLimit } = await import('../daily-limit.mjs');
    const file = policyPath(process.env, os.homedir());
    const { rules, error } = loadPolicy(file, { fs: fss.default });
    const project = path.basename(root);
    const facts = { ...(callerFacts && typeof callerFacts === 'object' && !Array.isArray(callerFacts) ? callerFacts : {}) };
    const nowMs = Date.now();
    const billed = await billedTodayUsd(root, () => nowMs);
    const limitLoad = await loadDailyLimitSettings(root, { env: process.env, homedir: () => os.homedir() });
    const { dailyLimitUsd } = resolveDailyLimit(limitLoad.ok ? limitLoad.settings : {});
    facts.pastDailyAutoLimit = Number(billed) >= dailyLimitUsd;
    const journalEvents = await readJournal(root, { limit: Infinity, kinds: ['auto-decision'] });
    facts.raisedTodayUsd = raisedTodayUsdFromAutoDecisions(journalEvents, project, nowMs);
    const request = { kind, id: `policy-check-${Date.now()}`, project, facts };
    const result = error
      ? { decision: 'needs-owner', rule: null, reason: 'policy load error' }
      : decide(request, { rules });
    const payload = ignoredFacts.length ? { ...result, ignoredFacts } : result;
    write(JSON.stringify(payload));
    if (result.decision === 'auto-approve') {
      const event = autoDecisionEvent(request, result, { machine: os.hostname() });
      const { journalPath } = await import('../journal.mjs');
      await appendAutoDecision({
        root,
        entry: event,
        deps: {
          appendJournal: async (r, line) => {
            const file = journalPath(r);
            await fs.mkdir(path.dirname(file), { recursive: true });
            await fs.appendFile(file, `${JSON.stringify(line)}\n`);
          },
        },
      });
      return 0;
    }
    if (result.decision === 'needs-owner') return 3;
    return 1;
  }
  if (sub === 'run') {
    const { runPolicyPass } = await import('../policy-run.mjs');
    const { loadPolicy, policyPath, handledForYou } = await import('../policy.mjs');
    const { readJournal, appendEvent: appendJournalEvent } = await import('../journal.mjs');
    const { appendEvent: appendOrchestratorEvent } = await import('../orchestrator-events.mjs');
    const file = policyPath(process.env, os.homedir());
    const { rules, error } = loadPolicy(file, { fs: fss.default });
    if (error) {
      write(JSON.stringify({ decided: [], left: [], error }));
      return 1;
    }
    const events = await readJournal(root, { limit: Infinity });
    const handled = handledForYou(events);
    const pass = await runPolicyPass({
      root,
      items: [],
      rules,
      factsOf: () => ({}),
      apply: async () => {},
      journal: entry => appendJournalEvent(root, entry),
      events: entry => appendOrchestratorEvent(root, entry),
      readHandled: () => handled,
      machine: os.hostname(),
    });
    write(JSON.stringify({ decided: pass.decided.length, left: pass.left.length, errors: pass.errors.length }));
    return 0;
  }
  return policyCommand(args, { out: write, env: process.env, home: os.homedir(), fs: fss.default });
}

export { autopilotPolicyPass, dispatchPolicyCli, lastTopLevelObject, loadMutantsFile, loadMutantsFileForIntegrate, originForCheck, safePath, validateMutantsArray };
