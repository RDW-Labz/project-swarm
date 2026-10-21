import { batchEligible } from '../batch.mjs';
import { checkNotInCiWarnings, DEFAULT_CI_PATH, loadChecksFromCi } from '../checks-from-ci.mjs';
import { applyJobType } from '../job-types.mjs';
import { resolveLanes } from '../lanes.mjs';
import { loadLocalConfig } from '../local-config.mjs';
import { portBlockFor, resolvePortBlock } from '../ports.mjs';
import { MODEL_RATES } from '../rates.mjs';
import { rollupRun } from '../reports.mjs';
import { gitIgnoredFixtureWarnings, parsePrPayload, resolveGhAndGit, ship, SHIP_DEFAULTS, TEST_FILE_RE } from '../ship.mjs';
import { loadSwarmEnv } from '../swarm-env.mjs';
import { digest, execFileAsync, fail, inventedHashesIn, normalizeChangedEntry, programOnPath, summarizeRun } from './core-1.mjs';
import { displayResult, expectedWorkspaceFor, highestSemver, runCheck, undeclaredPersistedFieldWarnings } from './core-11.mjs';
import { extractChangelog, gitDirty, installNewRelease } from './core-12.mjs';
import { agentReadiness, batchPolicyFor, compareSemver, parseSemver, projectProfile, resolvePathCwdThenRoot, shipExec } from './core-2.mjs';
import { safePath, toolchainsReport } from './core-21.mjs';
import { bytesAt, runChecks, validateManifest } from './core-31.mjs';
import { failedStderrTail, workerKeyGuard } from './core-32.mjs';
import { jobFinalJson, pickJobRoute, readState } from './core-41.mjs';
import { doctorAll, packagingChangesSince } from './core-42.mjs';
import { MAX_FILE } from './patterns.mjs';
import { costNotReported, costPer1kOutputTokens, jobTokens, tokensTotal } from './run-state.mjs';
import { designOnlyBlockedOnTestWarning, runWarnings } from './warnings.mjs';
import { isWorktreeWriter, resolveWorktree, usesWorktree } from './workspace.mjs';
import { noRestartFromArgv, restartRegisteredServers, resolveRunnerForRestart } from '../server-restart.mjs';
import { resolveInstallRootForPending } from '../update-pending.mjs';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';

export async function inspectRun(root,id,{spawnImpl=spawn,programOnPathImpl=programOnPath,exec=shipExec,env=process.env}={}){
  root=await fs.realpath(root);const state=await readState(root,id);
  if(state.root!==root||state.id!==id) fail('Run belongs to another repository');
  const manifest=validateManifest(JSON.parse(await bytesAt(root,`.swarm/runs/${id}/manifest.json`,true)));
  const files=[];
  const filesChanged=[];
  const jobs=[];
  const inventedHashWarnings=[];
  const persistedFieldWarnings=[];
  // Field lesson #268/#272: a file-only job's own proposed test-file output is worth a collect-only
  // preflight (a bad import fails cheap here instead of only at redcheck), and every job's own
  // proposed test-file output is worth a git-ignored-fixture scan — both surfaced as warnings only.
  const collectOnlyWarnings=[];
  const fixtureWarnings=[];
  const designWarnings=[];
  for(const job of manifest.jobs){
    const record=state.jobs.find(j=>j.id===job.id);if(!record)fail('Missing job record');
    // tier/tierReason are validated metadata only; they never change which model ran.
    const parsedResult=await jobFinalJson(root,id,job.id);
    if (JSON.stringify(record.outputs) !== JSON.stringify(job.outputs)) fail('Worker metadata does not match manifest');
    const designWarning = designOnlyBlockedOnTestWarning(job, parsedResult);
    if (designWarning) designWarnings.push(designWarning);
    // Field lesson #201: a setup failure never spawns the worker (empty error/result/cost, exactly
    // like a job that never ran) — inspect names the phase and the setup log's own tail here.
    const setupErrorTail=record.setupFailed?(await bytesAt(root,`.swarm/runs/${id}/${job.id}/setup.log`,true))?.toString('utf8').split('\n').slice(-20).join('\n')??null:null;
    jobs.push({...await failedStderrTail(root,id,job,record),...(record.report ? {report:record.report} : {}),...(record.reportErrors ? {reportErrors:record.reportErrors} : {}),id:job.id,agent:record.agent,model:record.model??job.model??null,...(isWorktreeWriter(record)&&record.scratchDir?{scratchDir:record.scratchDir}:{}),...(job.shell===true?{shell:true,checksRun:Array.isArray(parsedResult?.checksRun)?parsedResult.checksRun:null,proxyRefused:record.proxyRefused??[],loopbackDenied:record.loopbackDenied??[]}:{}),tier:job.tier??null,tierReason:job.tierReason??null,status:record.status,...(record.status!=='complete'?{finishReason:record.finishReason??null}:{}),...(record.agentError?{agentError:record.agentError}:{}),...(record.resultMissing?{resultMissing:true}:{}),...(record.setupFailed?{phase:'setup',setupError:setupErrorTail}:{}),result:displayResult(parsedResult),transcript:job.privateData===true?'withheld':'saved',costUsd:typeof record.costUsd==='number'?record.costUsd:null,...(record.costSource==='estimated-from-transcript'?{costSource:record.costSource}:{}),costPer1kOutputTokens:costPer1kOutputTokens(record),tokens:jobTokens(record),modelsSeen:record.modelsSeen??[],modelMismatch:record.modelMismatch??false,...(usesWorktree(job)&&record.keptWorkspace?{worktree:resolveWorktree(state,record)}:{})});
    const workspaceRoot=await safePath(root,expectedWorkspaceFor(id, job.id, record),{internal:true});
    // Field lesson 128: the same invented-hash scan integrate runs, surfaced here before any file
    // is actually written, so a made-up sha is visible at inspect time too.
    const contextText=(await Promise.all(job.context.map(async file=>(await bytesAt(root,file))?.toString('utf8')??''))).join('\n');
    for(const file of job.outputs){
      const current=await bytesAt(root,file),proposed=await bytesAt(workspaceRoot,file);
      const currentHash=current===null?null:digest(current),proposedHash=proposed===null?null:digest(proposed);
      const proposedMode=proposed===null?null:(await fs.stat(await safePath(workspaceRoot,file))).mode & 0o777;
      if(proposed!==null&&(proposedHash!==record.baseHashes[file]||(record.baseModes?.[file]!==undefined&&proposedMode!==record.baseModes[file])))filesChanged.push(file);
      const currentMode=current===null?0o644:(await fs.stat(await safePath(root,file))).mode & 0o777;
      const conflict=currentHash!==record.baseHashes[file]||(current!==null&&record.baseModes?.[file]!==undefined&&currentMode!==record.baseModes[file]);
      files.push({job:job.id,jobStatus:record.status,path:file,baseHash:record.baseHashes[file],currentHash,proposedHash,bytes:proposed?.length??0,status:record.status!=='complete'?'blocked':proposed===null?'missing':state.integratedAt&&currentHash===proposedHash?'applied':conflict?'conflict':currentHash===proposedHash?'unchanged':'ready'});
      if(proposed!==null)for(const hash of inventedHashesIn(proposed.toString('utf8'),current?.toString('utf8')??'',contextText))inventedHashWarnings.push(`invented-hash: ${job.id}: ${file}: ${hash}`);
      if(proposed!==null)persistedFieldWarnings.push(...undeclaredPersistedFieldWarnings(job,parsedResult,file,current?.toString('utf8')??'',proposed.toString('utf8')));
      if(proposed!==null&&TEST_FILE_RE.test(file)){
        for(const warning of await gitIgnoredFixtureWarnings(exec,new Map([[file,proposed.toString('utf8')]]),root)) fixtureWarnings.push(`git-ignored-fixture: ${job.id}: ${warning.file} -> ${warning.path}`);
        if(!job.shell){
          if(/\.(mjs|js|ts)$/i.test(file)){
            const outcome=await runCheck('collect-only',['node','--check',file],workspaceRoot,15000,spawnImpl,true,()=>{},env);
            if(outcome.status!=='passed') collectOnlyWarnings.push(`collect-only-failed: ${job.id}: ${file}: ${(outcome.tail??'').split('\n').find(line=>line.trim())??''}`);
          } else if(file.toLowerCase().endsWith('.py')){
            const dirs=(env.PATH??'').split(path.delimiter).filter(Boolean);
            if(!(await programOnPathImpl('pytest',dirs))) collectOnlyWarnings.push(`collect-only-skipped: ${job.id}: pytest not on PATH`);
            else {
              const outcome=await runCheck('collect-only',['python','-m','pytest','--collect-only','-q',file],workspaceRoot,30000,spawnImpl,true,()=>{},env);
              if(outcome.status!=='passed') collectOnlyWarnings.push(`collect-only-failed: ${job.id}: ${file}: ${(outcome.tail??'').split('\n').find(line=>line.trim())??''}`);
            }
          }
        }
      }
    }
  }
  return {id,status:state.status,integratedAt:state.integratedAt??null,tokens:tokensTotal(jobs.map(job=>job.tokens)),costNotReported:costNotReported(jobs),warnings:[...runWarnings(state),...inventedHashWarnings,...persistedFieldWarnings,...collectOnlyWarnings,...fixtureWarnings,...designWarnings],jobs,files,filesChanged,...(state.acceptRedBase?{acceptRedBase:true,acceptRedBaseReason:state.acceptRedBaseReason,baseCheckFailures:state.baseCheckFailures??[]}:{})};
}

// Lesson #48: a coordinator asking only "did it work, what did it say" should not have to
// reconstruct that from the full inspect payload (workspace files, tiers, per-file conflicts).
export async function inspectResults(root, id) {
  root = await fs.realpath(root);
  const state = await readState(root, id);
  if (state.root !== root || state.id !== id) fail('Run belongs to another repository');
  const manifest = validateManifest(JSON.parse(await bytesAt(root, `.swarm/runs/${id}/manifest.json`, true)));
  const warnings = runWarnings(state);
  const jobs = [];
  for (const record of state.jobs) {
    const job = manifest.jobs.find(job => job.id === record.id);
    if (!job) fail('Missing manifest job');
    const message = await jobFinalJson(root, id, record.id);
    const designWarning = designOnlyBlockedOnTestWarning(job, message);
    if (designWarning) warnings.push(designWarning);
    let parsed = message, resultSource = 'message';
    const workspace = await safePath(root, expectedWorkspaceFor(id, job.id, record), { internal: true });
    if (job.resultFile) {
      try {
        const bytes = await bytesAt(workspace, job.resultFile);
        if (bytes === null) throw Error('missing file');
        const value = JSON.parse(bytes.toString('utf8'));
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('expected JSON object');
        parsed = value;
        resultSource = 'file';
        const missing = (job.resultSchema ?? []).filter(key => !Object.hasOwn(value, key));
        if (missing.length) warnings.push(`resultFile missing keys: ${job.id}: ${missing.join(',')}`);
        if (message) for (const key of Object.keys(value)) {
          if (Object.hasOwn(message, key) && !isDeepStrictEqual(value[key], message[key])) warnings.push(`resultFile disagrees with final message: ${job.id}: ${key}`);
        }
      } catch (error) { warnings.push(`resultFile unreadable: ${job.id}: ${error.message}`); }
    }
    // Field lesson #256: a worker's own contract deviations — a MUST it could not meet, reported
    // instead of silently substituted — are surfaced here the same way any other per-job result
    // field is, so a reviewer sees them at inspect time, before integrate ever decides whether to
    // accept them.
    for (const deviation of Array.isArray(parsed?.deviations) ? parsed.deviations : []) {
      // Field lesson #269: a bare-string deviation used to fail this `.contract` guard silently
      // (dropping it from the warning list entirely, not just rendering it oddly).
      const text = typeof deviation === 'string' ? deviation : (typeof deviation?.contract === 'string' ? deviation.contract : null);
      if (text) warnings.push(`contract-deviation: ${job.id}: ${text}`);
    }
    // Field lesson #260: a job's own checksRun entry can say "passed" for a check whose own result
    // text still names a nonzero fail count — self-contradicting evidence a per-job status field
    // alone never catches, found by scanning every string value the result actually carries.
    const resultFailCounts = [];
    (function scanForFailCounts(value) {
      if (typeof value === 'string') { for (const match of value.matchAll(/(\d+)\s*fail/gi)) resultFailCounts.push(Number(match[1])); }
      else if (Array.isArray(value)) value.forEach(scanForFailCounts);
      else if (value && typeof value === 'object') Object.values(value).forEach(scanForFailCounts);
    })(parsed);
    if (resultFailCounts.some(count => count > 0)) {
      for (const entry of Array.isArray(parsed?.checksRun) ? parsed.checksRun : []) {
        if (entry?.status === 'passed' && typeof entry.name === 'string' && entry.name) warnings.push(`self-report-contradiction: ${job.id}: ${entry.name}`);
      }
    }
    // Field lesson #255: a shell worker's own reported test-run interpreter naming a path outside
    // its workspace means it ran (or read) some other checkout's toolchain, not its own.
    if (typeof parsed?.interpreter === 'string' && parsed.interpreter.trim()) {
      const resolvedInterpreter = path.resolve(parsed.interpreter);
      const resolvedWorkspace = path.resolve(workspace);
      if (resolvedInterpreter !== resolvedWorkspace && !resolvedInterpreter.startsWith(resolvedWorkspace + path.sep)) {
        warnings.push(`interpreter-outside-workspace: ${job.id}: ${parsed.interpreter}`);
      }
    }
    // Field lesson 37: a worker's own report of what it changed is a separate signal from an
    // actual workspace diff (droppedWriteWarnings above) — a job may self-report a path it never
    // actually touched, or run on an agent (codex) whose workspace diff is not checked there.
    // Field lesson #249: that report is prose, not a bare path ("out.txt created", "other.txt
    // (new)") — compared against job.outputs (and shown in the warning) by its normalized path,
    // never the raw string, or an output the job actually declared reads as "dropped".
    for (const file of Array.isArray(parsed?.changed) ? parsed.changed : []) {
      if (typeof file !== 'string') continue;
      const normalized = normalizeChangedEntry(file);
      if (job.outputs.includes(normalized)) continue;
      const droppedWriteLine = `dropped write: ${normalized} (not in outputs)`;
      if (!warnings.includes(droppedWriteLine)) warnings.push(droppedWriteLine);
    }
    const mentioned = new Set();
    for (const value of [parsed?.crossJobNames, parsed?.notes]) {
      for (const text of typeof value === 'string' ? [value] : Array.isArray(value) ? value : []) {
        if (typeof text !== 'string') continue;
        for (const token of text.match(/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+|[A-Za-z0-9_-]+\.[A-Za-z][A-Za-z0-9_.-]*/g) ?? []) {
          const file = token.replace(/[.,;]+$/, '');
          if (job.outputs.includes(file) || mentioned.has(file)) continue;
          try { await fs.stat(await safePath(root, file)); mentioned.add(file); warnings.push(`outside outputs: ${job.id}: ${file}`); } catch { /* Not an existing repo-relative path. */ }
        }
      }
    }
    // Field lesson 38: before integrate ever writes anything, show where each declared output
    // actually sits (the worker's own workspace copy) and, for a .json one, whether it parses —
    // the same shape check integrate itself relies on, made visible up front.
    const outputs = [];
    for (const file of job.outputs) {
      const workspacePath = path.join(workspace, ...file.split('/'));
      const info = { path: file, workspacePath };
      if (file.toLowerCase().endsWith('.json')) {
        const bytes = await bytesAt(workspace, file);
        info.jsonValid = bytes === null ? null : (() => { try { JSON.parse(bytes.toString('utf8')); return true; } catch { return false; } })();
      }
      outputs.push(info);
    }
    jobs.push({ ...await failedStderrTail(root, id, job, record), id: record.id, status: record.status, ...(record.status !== 'complete' ? { finishReason: record.finishReason ?? null } : {}), ...(job.shell === true ? { shell: true, checksRun: Array.isArray(parsed?.checksRun) ? parsed.checksRun : null } : {}), ...(record.agentError ? { agentError: record.agentError } : {}), ...(record.resultMissing ? { resultMissing: true } : {}), model: record.model ?? null, actualModel: record.actualModel ?? null, modelMismatch: record.modelMismatch ?? false, costUsd: typeof record.costUsd === 'number' ? record.costUsd : null, ...(record.costSource === 'estimated-from-transcript' ? { costSource: record.costSource } : {}), tokens: jobTokens(record), result: resultSource === 'file' ? parsed : displayResult(parsed), resultSource, outputs, transcript: job.privateData === true ? 'withheld' : 'saved' });
  }
  return { runId: id, status: state.status, tokens: tokensTotal(jobs.map(job => job.tokens)), costNotReported: costNotReported(jobs), warnings, jobs };
}

async function attachServerRestart(result, root, { home, env = process.env, noRestart, write } = {}) {
  if (result.tagPending) return result;
  const targetVersion = result.to ?? result.from;
  if (!targetVersion) return result;
  const restartHome = home ?? env.HOME ?? os.homedir();
  const installRoot = await resolveInstallRootForPending({ env, ownRoot: root, home: restartHome });
  const { runner } = await resolveRunnerForRestart(installRoot, targetVersion);
  if (!runner) {
    const warn = write ?? (text => { try { process.stderr.write(text); } catch { /* tests */ } });
    warn(`server restart skipped: installed runner not found under ${installRoot}\n`);
    return result;
  }
  const { servers } = await restartRegisteredServers({
    installRoot,
    targetVersion,
    noRestart: noRestart ?? noRestartFromArgv(),
    env,
    home: restartHome,
    write: write ?? (text => { try { process.stderr.write(text); } catch { /* tests */ } }),
    strictPidCheck: true,
  });
  return servers.length ? { ...result, servers } : result;
}

export async function updateInstall(root,{home,doctorAllImpl=doctorAll,env=process.env,noRestart,write}={}){
  root=await fs.realpath(root);
  const beforePkg=JSON.parse(await fs.readFile(path.join(root,'package.json'),'utf8'));
  if(beforePkg.name!=='project-swarm')fail('Refusing to update: target is not a project-swarm install');
  const gitRoot=await fs.realpath((await execFileAsync('git',['-C',root,'rev-parse','--show-toplevel'],{encoding:'utf8'})).stdout.trim());
  if(gitRoot!==root)fail('Refusing to update: project-swarm install must be its own git checkout');
  // An install made with --dev is a development checkout: it is never moved to a release (that would detach its branch).
  try{if(JSON.parse(await fs.readFile(path.join(root,'.swarm-install.json'),'utf8')).dev===true)fail('Refusing to update: this install was made with --dev (a development checkout), so it is never moved to a release. Install a real one with: node tools/install.mjs --user (from a clean checkout of a release tag)');}catch(error){if(error?.message?.startsWith('Refusing'))throw error;}
  if(await gitDirty(root,['tools','skills']))fail('Refusing to update: uncommitted changes in tools/ or skills/');
  const from=beforePkg.version;
  await execFileAsync('git',['-C',root,'fetch','--tags'],{encoding:'utf8'});
  const tagList=(await execFileAsync('git',['-C',root,'tag','--list','v*'],{encoding:'utf8'})).stdout.split('\n').map(line=>line.trim()).filter(Boolean);
  const latest=highestSemver(tagList);
  let mainVersion = null;
  try { mainVersion = JSON.parse((await execFileAsync('git', ['-C', root, 'show', 'origin/main:package.json'], { encoding: 'utf8' })).stdout).version; } catch { /* A tag-only remote need not have main. */ }
  if (parseSemver(mainVersion) && (!latest || compareSemver(parseSemver(mainVersion), parseSemver(latest)) > 0)) return { from, to: mainVersion, tagPending: true, message: `tag pending for ${mainVersion}; retry in a minute` };
  if(!latest)fail('No release tags (v*) found in this checkout');
  let currentTag=null;
  try{currentTag=(await execFileAsync('git',['-C',root,'describe','--tags','--exact-match'],{encoding:'utf8'})).stdout.trim();}catch{currentTag=null;}
  if(currentTag===latest)return await attachServerRestart({from,to:latest.replace(/^v/,''),upToDate:true},root,{home,env,noRestart,write});
  const releasePkg=JSON.parse((await execFileAsync('git',['-C',root,'show',`${latest}:package.json`],{encoding:'utf8'})).stdout);
  if(releasePkg.name!=='project-swarm'||releasePkg.version!==latest.slice(1))fail('Refusing to update: release tag is not a matching project-swarm install');
  await execFileAsync('git',['-C',root,'checkout','--detach',latest],{encoding:'utf8'});
  const afterPkg=JSON.parse(await fs.readFile(path.join(root,'package.json'),'utf8'));
  const to=afterPkg.version;
  await installNewRelease(root,home);
  await doctorAllImpl();
  const changelogText=await fs.readFile(path.join(root,'CHANGELOG.md'),'utf8').catch(()=>'');
  return await attachServerRestart({from,to,changelog:extractChangelog(changelogText,from,to)},root,{home,env,noRestart,write});
}

// Plain Markdown for the agent to relay verbatim; no model calls, all facts come from doctor.
export async function onboardReport(root,{doctorAllImpl=doctorAll,toolchainsReportImpl=toolchainsReport}={}){
  const {providers}=await doctorAllImpl();
  const toolchains=await toolchainsReportImpl();
  const toolchainsLine=toolchains.exists&&toolchains.tmpPaths.length===0?`- toolchains: ok (${toolchains.dir})`:`- toolchains: move to ${toolchains.dir}${toolchains.tmpPaths.length?` (${toolchains.tmpPaths.map(p=>`${p.name}=${p.path}`).join(', ')})`:''}`;
  const lines=[
    '# Project Swarm onboarding','',
    '## What this does',
    '- One coordinator (you or an agent) plans bounded tasks for fresh workers.',
    '- Each worker gets copied context and explicit output ownership only.',
    '- Workers cannot see each other, other projects, your terminal, or credentials.',
    '- You review every proposed change before it is integrated.',
    '- Integration checks (tests, format) run right after files are written.','',
    '## Worker compatibility and configuration (a smoke run proves access)',
    ...providers.map(provider=>{const r=agentReadiness(provider.agent,provider);return r.ready?`- ${provider.agent}: ${provider.reachable===true?'reachable (model unverified)':'compatible (smoke required)'}`:provider.configured===true?`- ${provider.agent}: configured; ${provider.reachable===false?'unreachable':'reachability not checked'} — run a bounded smoke job`:`- ${provider.agent}: needs setup — ${r.fix}`;}),
    '',
    '## Ask your agent for work like this',
    '- "Use Project Swarm to review src/checkout.js for bugs; do not edit it."',
    '- "Split the API and UI changes for issue #42 into two swarm jobs."',
    '- "Run the smoke manifest and integrate it if the output looks right."','',
    '## What a run looks like',
    '1. Coordinator writes a manifest: one deliverable per job, one writer per file.',
    '2. `swarm run` starts fresh workers in copied workspaces.',
    '3. `swarm inspect`/`status` review proposed outputs and conflicts.',
    '4. `swarm integrate` imports reviewed files and runs project checks.','',
    '## Safety rules',
    '- Workers only touch files explicitly listed in their job.',
    '- No API keys or secrets are ever read from or written into a manifest.',
    '- The Codex sandbox only runs on macOS; other platforms refuse codex jobs.','',
    '## Toolchains',
    toolchainsLine,'',
    '## Staying current',
    '- `node tools/swarm.mjs version --check` reports whether a newer release exists.',
    '- Nothing updates itself: run `node tools/swarm.mjs update` to move to it.',
    '- If old per-project copies are suspected, run `node tools/swarm.mjs update --projects`.'
  ];
  return `${lines.join('\n')}\n`;
}

// Merges summarizeRun's snapshot with the fields it omits (agent/model/tier/tierReason,
// declared output count) so `monitor --view` can render a full row without changing the
// existing machine-readable monitor payload at all.
async function monitorView(root, id) {
  // Loaded lazily, like preflight.mjs above: an installed checkout that predates this
  // module must keep running every other command with no missing-file import failure.
  const { renderMonitorView, supportsColor } = await import('../monitor-view.mjs');
  const state = await readState(root, id);
  const summary = summarizeRun(state);
  const manifestBytes = await bytesAt(root, `.swarm/runs/${id}/manifest.json`, true);
  const manifestJobs = manifestBytes ? JSON.parse(manifestBytes).jobs : [];
  const tierById = new Map(manifestJobs.map(job => [job.id, { tier: job.tier ?? null, tierReason: job.tierReason ?? null }]));
  const jobs = summary.jobs.map((job, index) => {
    const record = state.jobs[index];
    const { tier, tierReason } = tierById.get(job.id) ?? { tier: null, tierReason: null };
    return { ...job, agent: record.agent, model: record.model ?? null, tier, tierReason, type: manifestJobs[index]?.type, outputCount: record.outputs?.length ?? 0 };
  });
  return { status: summary.status, text: renderMonitorView({ ...summary, jobs, pause: state.pause, lanes: state.lanes, queued: summary.counts.queued, mergeQueue: state.mergeQueue ?? null, integratedAt: state.integratedAt ?? null, spend: rollupRun(state).spend }, { width: process.stdout.columns || 100, color: supportsColor() }) };
}

// Field lesson #164: ship a finished branch built outside the swarm (no run id, no manifest):
// the root must have that branch checked out and clean, the payload's head must name it, the
// given --check argvs run like manifest checks (env file and port block included), and every
// other ship rule (needs-a-human hold, --require-section, lock check, test binary gate,
// packaging build check) applies to the branch's own diff against its base.
export async function shipBranch(root, flags, { spawnImpl = spawn, exec = shipExec, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), now, shipImpl = ship } = {}) {
  root = await fs.realpath(root);
  // Field lesson #187: every refusal (even one this function returns itself, before ship() ever
  // runs) names --branch, so a ship --branch attempt is always recoverable from its own result.
  const refused = reason => ({ ...(flags.waitRequiredOnly ? { requiredContexts: null, pendingAtMerge: [], waitedForRequiredOnly: false } : {}), warnings: [], tag: { name: null, status: 'skipped', waitedSeconds: 0 }, status: 'refused', repo: flags.repo ?? null, branch: flags.branch ?? null, pr: null, url: null, sha: null, mergeSha: null, checks: null, ci: null, reason });
  if (exec === shipExec) {
    const preflight = await resolveGhAndGit(exec);
    if (!preflight.ok) return refused(preflight.reason);
  }
  if (!flags.branch) fail('ship without a run id requires --branch BRANCH');
  let payloadPath;
  try { payloadPath = await resolvePathCwdThenRoot(flags.payloadPath, root, { label: 'PR payload' }); } catch (error) { return refused(error.message); }
  let payload;
  try { payload = parsePrPayload(await fs.readFile(payloadPath, 'utf8')); } catch (error) { return refused(error.message); }
  if (payload.head !== flags.branch) return refused(`PR payload head ${payload.head} does not match --branch ${flags.branch}`);
  const current = await exec('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: root });
  const checkedOut = current.code === 0 ? current.stdout.trim() : null;
  if (checkedOut !== flags.branch) return refused(`--branch ${flags.branch} is not checked out in ${root} (HEAD is ${checkedOut ?? 'unknown'}); pass --root <the worktree that has it>`);
  let baseRevision = null, changedFiles = [];
  try {
    baseRevision = (await execFileAsync('git', ['-C', root, 'merge-base', `origin/${payload.base}`, 'HEAD'], { encoding: 'utf8' })).stdout.trim() || null;
  } catch {
    try { baseRevision = (await execFileAsync('git', ['-C', root, 'merge-base', payload.base, 'HEAD'], { encoding: 'utf8' })).stdout.trim() || null; } catch { baseRevision = null; }
  }
  if (!baseRevision) return refused(`cannot find the merge base of ${flags.branch} and ${payload.base}`);
  // Lesson 350: an aborted clean-branch preparation must fail before any checks run.
  const ahead = (await execFileAsync('git', ['-C', root, 'rev-list', '--count', `${baseRevision}..HEAD`], { encoding: 'utf8' })).stdout.trim();
  if (ahead === '0') return { ...refused(`branch-not-ahead: ${flags.branch} has no commits over ${payload.base}`), code: 'branch-not-ahead' };
  changedFiles = (await execFileAsync('git', ['-C', root, 'diff', '--name-only', `${baseRevision}`, 'HEAD'], { encoding: 'utf8', maxBuffer: MAX_FILE })).stdout.split('\n').filter(Boolean);
  const { env: swarmEnv } = await loadSwarmEnv(root);
  const originalPortBase = portBlockFor(root);
  const { base: portBase, moved: portMoved } = await resolvePortBlock(root);
  const portWarnings = portMoved ? [portBase === originalPortBase ? `port-block-busy: ${portBase}` : `port-block-moved: ${originalPortBase} -> ${portBase}`] : [];
  const handChecks = flags.checks ?? [];
  // Field lesson #177: a hand-typed --check list drifts from what CI actually runs. With
  // --checks-from-ci, CI's own `run:` steps (read from the given/default workflow path) become
  // ship's own checks, merged with any --check entries; either way, a --check whose program and
  // subcommand are not among the CI-derived checks warns instead of silently drifting further.
  const ciWarnings = [];
  let checks = handChecks;
  if (flags.checksFromCi) {
    const ciPath = flags.checksFromCiPath ?? DEFAULT_CI_PATH;
    const ciResult = await loadChecksFromCi(root, ciPath);
    if (ciResult.missing) {
      ciWarnings.push(`checks-from-ci: ${ciPath} not found`);
    } else {
      for (const skip of ciResult.skipped) ciWarnings.push(`checks-from-ci-skipped (${skip.reason}): ${skip.raw}`);
      ciWarnings.push(...checkNotInCiWarnings(handChecks, ciResult.checks));
      const seen = new Set(handChecks.map(check => JSON.stringify(check.argv)));
      const merged = [...handChecks];
      for (const check of ciResult.checks) {
        const key = JSON.stringify(check.argv);
        if (seen.has(key)) continue;
        seen.add(key);
        merged.push(check);
      }
      checks = merged.slice(0, 10);
    }
  }
  return shipImpl({
    root, repo: flags.repo, payloadPath, manifest: null, tagTimeoutMs: flags.tagTimeoutMs, now,
    // Field lesson #187: names --branch on the result so a `ship --branch` run is recoverable.
    branch: flags.branch,
    requireSections: flags.requireSections,
    merge: flags.merge,
    mergeMethod: flags.mergeMethod ?? SHIP_DEFAULTS.mergeMethod,
    pollMs: flags.pollMs ?? SHIP_DEFAULTS.pollMs,
    timeoutMs: flags.timeoutMs ?? SHIP_DEFAULTS.timeoutMs,
    noCiGraceMs: SHIP_DEFAULTS.noCiGraceMs,
    rerunFlaky: flags.rerunFlaky,
    ...(flags.rerunFlakyCi !== undefined ? { rerunFlakyCi: flags.rerunFlakyCi } : {}),
    perTestTimeoutSeconds: flags.perTestTimeoutSeconds,
    exemptions: flags.exemptions ?? [],
    acceptPreExisting: flags.acceptPreExisting ?? false,
    preflight: flags.preflight ?? false,
    waitRequiredOnly: flags.waitRequiredOnly ?? false,
    privateNamesFile: flags.privateNamesFile ?? null,
    portBase, portWarnings,
    extraWarnings: [...ciWarnings, ...(checks.length ? [] : ['no-checks: ship --branch ran no local checks; pass --check \'<argv json>\' or --checks-from-ci'])],
    integratedFiles: changedFiles,
    packagingChanges: await packagingChangesSince(root, baseRevision, changedFiles),
    checkArgvs: checks.map(check => check.argv),
    // Field lesson #192: ship() hands this the toolchains-bin-first env it computed
    // (toolchainCheckEnv) so a check calling which("uv") itself finds it; merged over this root's
    // own env file so neither one silently drops the other's PATH/vars.
    runChecks: async ({ env: checkEnv } = {}) => (await runChecks(root, checks, changedFiles, [], spawnImpl, { noFlakeCheck: flags.noFlakeCheck, portBase, extraEnv: { ...swarmEnv, ...checkEnv } })).checks,
    exec, sleep,
  });
}

export async function shipRun(root, id, flags, { spawnImpl = spawn, exec = shipExec, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), now, env, keyExec, shipImpl = ship } = {}) {
  root = await fs.realpath(root);
  // Field lesson 118: a missing gh/git must refuse before any check runs, not surface partway
  // through ship() as a confusing push/PR failure. Same result shape as ship()'s own early refusal.
  // Only preflighted when the real exec is in play: a caller-supplied exec (tests, alternate
  // transports) already models the git/gh command surface it wants and doesn't speak `--version`.
  // Field lesson #187: every early refusal (before ship() itself ever runs) names its run id too.
  if (exec === shipExec) {
    const preflight = await resolveGhAndGit(exec);
    if (!preflight.ok) return { ...(flags.waitRequiredOnly ? { requiredContexts: null, pendingAtMerge: [], waitedForRequiredOnly: false } : {}), warnings: [], tag: { name: null, status: 'skipped', waitedSeconds: 0 }, status: 'refused', repo: flags.repo ?? null, runId: id, pr: null, url: null, sha: null, mergeSha: null, checks: null, ci: null, reason: preflight.reason };
  }
  if (flags.branch) fail('ship --branch ships a branch without a run id; drop the run id, or drop --branch');
  const state = await readState(root, id);
  if (state.root !== root || state.id !== id) fail('Run belongs to another repository');
  if (!state.integratedAt) fail('Run must be integrated before it can be shipped');
  // Speed and accessibility budgets block only the PR that finishes the last stage.
  {
    const profile = await projectProfile(root);
    if (profile?.budgets) {
      const { budgetShipGate, readBudgetState } = await import('../budgets.mjs');
      const gate = budgetShipGate({ budgets: profile.budgets, state: await readBudgetState(root), ledger: await (await import('../tickets.mjs')).readLedger(root).catch(() => null), runJobIds: (state.jobs ?? []).map(job => job.id) });
      if (gate) fail(gate.message, 'budgets-failing');
    }
  }
  const manifest = validateManifest(JSON.parse(await bytesAt(root, `.swarm/runs/${id}/manifest.json`, true)));
  const checks = [...(manifest.checks ?? []), ...(flags.additionalChecks ?? [])];
  validateManifest({ ...manifest, checks: flags.additionalChecks ?? [] });
  if ((flags.additionalChecks ?? []).some(check => (manifest.checks ?? []).some(existing => existing.name === check.name))) fail('additional check name collides with manifest');
  let payloadPath;
  try { payloadPath = await resolvePathCwdThenRoot(flags.payloadPath, root, { label: 'PR payload' }); }
  catch (error) { return { ...(flags.waitRequiredOnly ? { requiredContexts: null, pendingAtMerge: [], waitedForRequiredOnly: false } : {}), warnings: [], tag: { name: null, status: 'skipped', waitedSeconds: 0 }, status: 'refused', repo: flags.repo ?? null, runId: id, pr: null, url: null, sha: null, mergeSha: null, checks: null, ci: null, reason: error.message }; }
  await workerKeyGuard(root, id, state, { env, keyExec, extraFiles: [payloadPath, ...(state.integratedFiles ?? []).map(file => path.join(root, file))] });
  // Field lesson #141: ship re-runs checks against the project root, so it shares that root's
  // own port block; a move or a run of busy blocks is surfaced the same way integrate does.
  const originalPortBase = portBlockFor(root);
  const { base: portBase, moved: portMoved } = await resolvePortBlock(root);
  const portWarnings = portMoved ? [portBase === originalPortBase ? `port-block-busy: ${portBase}` : `port-block-moved: ${originalPortBase} -> ${portBase}`] : [];
  // Field lesson #177(b): a manifest's own hand-authored checks drift from CI the same way a
  // hand-typed --check list does; --checks-from-ci here only warns (a manifest's checks are not
  // replaced — they are what the run was actually verified against).
  const ciWarnings = [];
  if (flags.checksFromCi) {
    const ciResult = await loadChecksFromCi(root, flags.checksFromCiPath ?? DEFAULT_CI_PATH);
    if (ciResult.missing) ciWarnings.push(`checks-from-ci: ${flags.checksFromCiPath ?? DEFAULT_CI_PATH} not found`);
    else {
      for (const skip of ciResult.skipped) ciWarnings.push(`checks-from-ci-skipped (${skip.reason}): ${skip.raw}`);
      ciWarnings.push(...checkNotInCiWarnings(manifest.checks ?? [], ciResult.checks));
    }
  }
  return shipImpl({
    root, repo: flags.repo, payloadPath, manifest, tagTimeoutMs: flags.tagTimeoutMs, now,
    // Field lesson #187: names this run so a `ship RUN` result is recoverable without reading
    // source to find how it was started.
    runId: id,
    // Field lesson 123: a red base's mutants proved nothing; ship refuses a required "Mutation
    // check" section when the integrated run's own mutants came from one.
    mutantsSkippedRedBase: Boolean(state.mutantsSkippedRedBase),
    requireSections: flags.requireSections,
    merge: flags.merge,
    mergeMethod: flags.mergeMethod ?? SHIP_DEFAULTS.mergeMethod,
    pollMs: flags.pollMs ?? SHIP_DEFAULTS.pollMs,
    timeoutMs: flags.timeoutMs ?? SHIP_DEFAULTS.timeoutMs,
    noCiGraceMs: SHIP_DEFAULTS.noCiGraceMs,
    rerunFlaky: flags.rerunFlaky,
    ...(flags.rerunFlakyCi !== undefined ? { rerunFlakyCi: flags.rerunFlakyCi } : {}),
    perTestTimeoutSeconds: flags.perTestTimeoutSeconds,
    exemptions: flags.exemptions ?? [],
    acceptPreExisting: flags.acceptPreExisting ?? false,
    preflight: flags.preflight ?? false,
    waitRequiredOnly: flags.waitRequiredOnly ?? false,
    privateNamesFile: flags.privateNamesFile ?? null,
    portBase, portWarnings,
    extraWarnings: ciWarnings,
    // Field lesson #166: shipRun used to omit this, so ship()'s own pre-push lock check (field
    // lesson 147, gated on `integratedFiles.length`) never ran on a real `ship <id>`; only
    // `ship --branch` (shipBranch, above) ever passed it.
    integratedFiles: state.integratedFiles ?? [],
    packagingChanges: await packagingChangesSince(root, state.baseCommit, state.integratedFiles ?? []),
    checkArgvs: [...checks.map(check => check.argv), ...(manifest.preChecks ?? [])],
    // Field lesson #192: merges in the toolchains-bin-first env ship() itself computed, so a
    // manifest check calling which("uv") finds it here too, not only on the base re-run.
    runChecks: async ({ env: checkEnv } = {}) => (await runChecks(root, checks, state.integratedFiles ?? [], state.integratedNewFiles ?? [], spawnImpl, { baseCommit: state.baseCommit, noFlakeCheck: flags.noFlakeCheck, portBase, preChecks: manifest.preChecks ?? [], extraEnv: { ...(await loadSwarmEnv(root)).env, ...checkEnv } })).checks,
    exec, sleep,
  });
}

// Everything the plan preview needs to know about this machine's lanes: where lead and child jobs would go,
// how many run at once there, and the per-million-token price (null for subscription or local lanes).
async function planLaneInfo(manifest, { batch = false, root } = {}) {
  const config = loadLocalConfig({ env: process.env });
  const lanes = resolveLanes({ config, manifest, env: process.env });
  const describe = type => {
    try {
      const probe = applyJobType({ id: 'plan-probe', type, agent: 'auto', prompt: 'x', context: [], outputs: [type === 'lead' ? 'probe.json' : 'probe.txt'], ...(type === 'lead' ? { area: { goal: 'x', scope: ['a'], maxJobs: 1, concurrency: 1 } } : {}) }).job;
      const route = pickJobRoute(probe, lanes);
      const family = ['opus', 'sonnet', 'haiku'].find(name => String(route.model).toLowerCase().includes(name));
      const rate = route.agent === 'anthropic' && family ? MODEL_RATES[family] : null;
      // Paid lanes other than a known Anthropic model cannot be priced here; the preview says so instead of showing $0.
      const metered = ['anthropic', 'openai', 'gemini', 'openrouter', 'lambda'].includes(route.agent);
      return { agent: route.agent, model: route.model, concurrency: lanes[route.agent]?.concurrency ?? 1, price: rate ? { inPerM: rate.in, outPerM: rate.out } : null, metered };
    } catch { return { agent: 'unknown', model: null, concurrency: 1, price: null }; }
  };
  const child = describe('build');
  // Batch applies to the children when they go to the Anthropic lane and the policy (--batch, manifest, config) allows it.
  if (batchEligible({ agent: child.agent, type: 'build' }, batchPolicyFor(manifest, batch, process.env, root))) child.batch = true;
  return { lead: describe('lead'), child, runConcurrency: manifest.concurrency ?? 1 };
}

export { monitorView, planLaneInfo };
