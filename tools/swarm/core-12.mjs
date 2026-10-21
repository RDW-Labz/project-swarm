import { isExampleFile, isSecretPath as isProfileSecretPath, protectedPathHit, protectedViolations, templateReadable, validateProfile } from '../init-profile.mjs';
import { refreshRepoMap } from '../init.mjs';
import { readJournal } from '../journal.mjs';
import { findUnsafeText } from '../lesson-schema.mjs';
import { mapIsFresh, readRepoMap } from '../repo-map.mjs';
import { parseExemptFlag } from '../ship.mjs';
import { execFileAsync, fail } from './core-1.mjs';
import { attachRuleFiles, compareSemver, parseSemver, policyDayKey, readProjectsRegistry } from './core-2.mjs';
import { GO_FLAGS_WITH_VALUE, MAX_CONTEXT, OLD_COPY_ENTRIES, SHIP_FLAGS_WITH_VALUE } from './patterns.mjs';
import crypto from 'node:crypto';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { dirtyFiles, formatDirtyListing } from '../generated-state.mjs';

async function gitDirty(dir,paths){
  try{const {stdout}=await execFileAsync('git',['-C',dir,'status','--porcelain','--',...paths],{encoding:'utf8'});return stdout.trim().length>0;}
  catch{return false;}
}

function extractChangelog(text,from,to){
  const fromV=parseSemver(from),toV=parseSemver(to);
  const picked=[];
  if(fromV&&toV)for(const chunk of text.split(/\n(?=## )/)){
    const heading=/^## (.+)/.exec(chunk);
    if(!heading)continue;
    const label=heading[1].trim();
    if(label.toLowerCase()==='unreleased')continue;
    const version=parseSemver(label);
    if(version&&compareSemver(version,fromV)>0&&compareSemver(version,toV)<=0)picked.push(chunk.trim());
  }
  const result=[];let total=0;
  for(const section of picked){if(total>=8000)break;const slice=section.slice(0,8000-total);result.push(slice);total+=slice.length;}
  return result;
}

// Lesson 350: prepare the current clean branch from a source branch without committing.
// Git's binary patch format handles both sides of renames, deletions, modes and odd filenames.
export async function cleanBranch(root, { from, exclude = [] } = {}) {
  root = await fs.realpath(root);
  if (typeof from !== 'string' || !from || from.startsWith('-') || from.includes('\0')) fail('clean-branch requires --from REF');
  if (!Array.isArray(exclude) || exclude.some(glob => typeof glob !== 'string' || !glob || glob.includes('\0'))) fail('--exclude requires a glob');
  const git = args => execFileAsync('git', ['-C', root, ...args], { encoding: 'utf8', maxBuffer: MAX_CONTEXT });
  const branch = (await git(['symbolic-ref', '--quiet', '--short', 'HEAD'])).stdout.trim();
  const dirty = await dirtyFiles(root, {
    exec: async (cmd, args) => {
      const { stdout } = await execFileAsync(cmd, args, { encoding: 'utf8', maxBuffer: MAX_CONTEXT });
      return { stdout };
    },
  });
  if (dirty.length) fail(`clean-branch-dirty: commit or set aside destination edits first${formatDirtyListing(dirty)}`);
  const source = (await git(['rev-parse', '--verify', '--end-of-options', `${from}^{commit}`])).stdout.trim();
  const paths = ['--', '.', ...exclude.map(glob => `:(exclude)${glob}`)];
  const records = (await git(['diff', '--name-status', '-z', '-M', 'HEAD', source, ...paths])).stdout.split('\0');
  const changes = [];
  for (let index = 0; index < records.length && records[index];) {
    const status = records[index++], file = records[index++];
    if (/^[RC]/.test(status)) changes.push({ status, from: file, path: records[index++] });
    else changes.push({ status, path: file });
  }
  if (changes.length) {
    const patch = (await git(['diff', '--binary', '--full-index', '--no-ext-diff', '--no-textconv', '-M', 'HEAD', source, ...paths])).stdout;
    // apply --index checks the complete patch before changing any file; it refuses collisions.
    const applied = git(['apply', '--index', '--binary', '-']);
    applied.child.stdin.on('error', () => {}); // exec's rejection reports an early git exit.
    applied.child.stdin.end(patch);
    await applied;
  }
  return { status: changes.length ? 'staged' : 'unchanged', branch, from, source, changes };
}

// Field lesson #276: `git reset --soft` onto a moved main (instead of the merge-base) can bring
// someone else's already-merged changes into the index; this resets to the merge-base only, and
// refuses (undoing itself) when the newly staged diff names any file the branch's own merge-base
// diff did not. It only stages — the file list is printed before anything is ever committed.
export async function squashBranch(root, { branch, base = 'origin/main', exec = execFileAsync } = {}) {
  root = await fs.realpath(root);
  if (typeof branch !== 'string' || !branch.trim()) fail('swarm squash requires --branch');
  const currentBranch = (await exec('git', ['-C', root, 'rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' })).stdout.trim();
  if (currentBranch !== branch) fail(`swarm squash: HEAD is on ${currentBranch}, not --branch ${branch}; check it out first`);
  const mergeBaseRes = await exec('git', ['-C', root, 'merge-base', 'HEAD', base], { encoding: 'utf8' }).catch(() => null);
  if (!mergeBaseRes) fail(`swarm squash: could not find a merge-base between HEAD and ${base}`);
  const mergeBase = mergeBaseRes.stdout.trim();
  const expectedFiles = new Set((await exec('git', ['-C', root, 'diff', '--name-only', mergeBase, 'HEAD'], { encoding: 'utf8' })).stdout.split('\n').map(l => l.trim()).filter(Boolean));
  await exec('git', ['-C', root, 'reset', '--soft', mergeBase], { encoding: 'utf8' });
  const stagedFiles = (await exec('git', ['-C', root, 'diff', '--name-only', '--cached'], { encoding: 'utf8' })).stdout.split('\n').map(l => l.trim()).filter(Boolean);
  const unexpected = stagedFiles.filter(file => !expectedFiles.has(file));
  if (unexpected.length) {
    await exec('git', ['-C', root, 'reset', '--soft', 'HEAD@{1}'], { encoding: 'utf8' }).catch(() => {});
    fail(`squash-unexpected-files: ${unexpected.join(', ')}; undone, nothing committed`);
  }
  return { branch, mergeBase, files: stagedFiles };
}

// Moves this shared install itself to the newest release tag. Refuses on local edits to the
// files it is about to replace so a dev checkout is never silently discarded.
// Runs the installer of the release that was just checked out, in a fresh process. The code already
// loaded here is the OLD release's, so installing with it skipped every install step the new release
// added (the `swarm` command and completion file, on the update to 1.65.0). A checkout with no
// installer of its own (a minimal fixture) falls back to the loaded one.
async function installNewRelease(root,home){
 const installer=path.join(root,'tools','install.mjs');
 if(!existsSync(installer)){
  const {installUser}=await import('../install.mjs');
  return installUser({source:root,...(home?{home}:{})});
 }
 let stdout;
 try{({stdout}=await execFileAsync(process.execPath,[installer,'--user'],{encoding:'utf8',env:{...process.env,...(home?{HOME:home}:{})},cwd:root}));}
 catch(error){fail(`update-install-failed: ${String(error.stderr||error.message).trim().split('\n').at(-1)}`);}
 try{return JSON.parse(stdout.trim().split('\n').at(-1));}catch{return {status:'installed'};}
}

export async function updateProjects(root,{projects,yes=false}={}){
  root=await fs.realpath(root);
  const version=JSON.parse(await fs.readFile(path.join(root,'package.json'),'utf8')).version;
  const list=projects&&projects.length?projects:await readProjectsRegistry(root);
  const {isPinned,pinOf}=await import('../pins.mjs');
  const reports=[],pinned=[];
  for(const projectDir of list){
    let project;
    try{project=await fs.realpath(projectDir);}catch{reports.push({project:projectDir,found:[],action:'missing'});continue;}
    try{const {refreshProjectInstallHooks}=await import('../install.mjs');await refreshProjectInstallHooks(project,root,{refreshOnly:true});}catch{/* best effort */}
    let pointer=null;
    try{const {readRunnerPointer}=await import('../runner-pointer.mjs');pointer=await readRunnerPointer(project);}catch{pointer=null;}
    if(pointer&&isPinned(pointer)){
      const at=pinOf(pointer);
      try{const {refreshProjectInstallHooks}=await import('../install.mjs');await refreshProjectInstallHooks(project,root,{refreshOnly:true});}catch{/* best effort */}
      pinned.push({project,found:[],action:'pinned',pinnedAt:at});
      continue;
    }
    const found=[];
    let isOldCopy=false;
    if(project!==root){
      try{await fs.access(path.join(project,'tools/swarm.mjs'));await fs.access(path.join(project,'skills/project-swarm/SKILL.md'));isOldCopy=true;}catch{isOldCopy=false;}
    }
    if(isOldCopy)found.push('old-copy');
    const pointerVersion=pointer?.version??null;
    if(pointerVersion&&pointerVersion!==version)found.push('stale-pointer');
    if(!found.length){
      const report={project,found,action:'up-to-date'};
      await attachRuleFiles(report,project,yes);
      reports.push(report);
      continue;
    }
    if(!yes){reports.push({project,found,action:'would replace with pointer'});continue;}
    let backup=null;
    if(isOldCopy){
      backup=path.join(project,`.swarm-old-copy-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`);
      await fs.mkdir(backup,{recursive:true});
      // Only what the old installer copied in: a project's own tools/ and tests/ stay put.
      for(const entry of OLD_COPY_ENTRIES){
        const from=path.join(project,entry),to=path.join(backup,entry);
        try{await fs.lstat(from);}catch(error){if(error.code==='ENOENT')continue;throw error;}
        await fs.mkdir(path.dirname(to),{recursive:true});
        await fs.rename(from,to);
      }
    }
    const {writePointer}=await import('../install.mjs');
    const written=await writePointer(project,{install:root,version});
    const report={project,found,action:'replaced',backup,pointerBackup:written.backup};
    await attachRuleFiles(report,project,yes);
    reports.push(report);
  }
  return {projects:reports,pinned};
}

// After `swarm update`: every linked project whose pointer is behind gets its version field moved (nothing else in the file changes; the old file is kept beside it as a backup).
// A project that cannot be read or written is reported, never skipped silently.
export async function bumpPointers(root){
  root=await fs.realpath(root);
  const version=JSON.parse(await fs.readFile(path.join(root,'package.json'),'utf8')).version;
  const bumped=[],failed=[],hooksSet=[],skipped=[];
  const {isPinned,pinOf}=await import('../pins.mjs');
  for(const projectDir of await readProjectsRegistry(root)){
    let project;
    try{project=await fs.realpath(projectDir);}catch{continue;}
    if(project===root)continue;
    let pointer;
    try{const {readRunnerPointer}=await import('../runner-pointer.mjs');pointer=await readRunnerPointer(project);}catch(error){if(error.code==='ENOENT'||String(error.message).includes('no .project-swarm.json'))continue;failed.push({project,error:'the pointer file is not valid JSON; not changed'});continue;}
    if(!pointer||typeof pointer!=='object')continue;
    const pinned=isPinned(pointer);
    // The Orchestrator lane's hooks are put (back) in place for every linked project on each update, whatever the pointer says (including pinned projects).
    try{
      const {refreshProjectInstallHooks}=await import('../install.mjs');
      const refreshed=await refreshProjectInstallHooks(project,root,{refreshOnly:true});
      const hooks=refreshed.orchestrator;
      if(hooks.status==='created'||hooks.status==='updated')hooksSet.push(project);
      else if(hooks.status==='skipped')failed.push({project,error:`orchestrator hooks not installed: ${hooks.reason}`});
      if(refreshed.handbuild?.status==='skipped')failed.push({project,error:`hand-build guard not refreshed: ${refreshed.handbuild.reason}`});
    }catch(error){failed.push({project,error:`install hooks: ${String(error.message).slice(0,160)}`});}
    if(pinned){skipped.push({project,pinnedAt:pinOf(pointer)});continue;}
    if(pointer.version===version)continue;
    try{const {writePointer}=await import('../install.mjs');const written=await writePointer(project,{install:root,version});if(written.changed)bumped.push({project,from:pointer.version??null,to:version});}
    catch(error){failed.push({project,error:String(error.message).slice(0,200)});}
  }
  return {bumped,failed,hooks:hooksSet,skipped};
}

// Pure CLI-flag parsing, kept separate from ship() execution so it is directly testable.
export function parseShipFlags(flags) {
  let repo, payloadPath, mergeMethod, timeoutMs, pollMs, tagTimeoutMs, noFlakeCheck, branch, merge = true, privateNamesFile;
  let ciLocal = true, checksFromCi, checksFromCiPath, rerunFlaky, rerunFlakyCi, acceptPreExisting = false, perTestTimeoutSeconds, preflight = false, waitRequiredOnly = false;
  const requireSections = [], checks = [], exemptions = [];
  for (let index = 0; index < flags.length; index++) {
    const flag = flags[index];
    if (flag === '--wait-required-only') { if (waitRequiredOnly) fail('Duplicate flag: --wait-required-only'); waitRequiredOnly = true; continue; }
    if (flag === '--no-flake-check') { noFlakeCheck = true; continue; }
    if (flag === '--no-merge') { merge = false; continue; }
    // The owner's way out of the local CI run (the workflow cannot run on this machine); the result still names that it was off.
    if (flag === '--no-ci-local') { ciLocal = false; continue; }
    // Field lesson #254: without this, a check whose failure also reproduces on the base holds
    // ship (status `held-red-check`) instead of quietly waving a red local check through.
    if (flag === '--accept-pre-existing') { acceptPreExisting = true; continue; }
    // E2 (1.39.0): `ship --preflight` runs every pre-push content guard in one pass and reports
    // every failure without pushing; ship() already knew the option, the parser did not.
    if (flag === '--preflight') { preflight = true; continue; }
    // Field lesson #177: an optional trailing path (the CI workflow to read `run:` steps from);
    // omitted, it defaults to .github/workflows/ci.yml relative to the ship root.
    if (flag === '--checks-from-ci') {
      checksFromCi = true;
      const next = flags[index + 1];
      if (next !== undefined && !next.startsWith('--')) { checksFromCiPath = next; index++; }
      continue;
    }
    if (!SHIP_FLAGS_WITH_VALUE.has(flag)) fail(`Unknown flag: ${flag}`);
    const value = flags[++index];
    if (value === undefined) fail(flag === '--rerun-flaky-ci' ? '--rerun-flaky-ci requires 0 or 1' : `${flag} requires a value`);
    if (flag === '--repo') repo = value;
    else if (flag === '--pr') payloadPath = value;
    else if (flag === '--require-section') requireSections.push(value);
    // Field lesson #164: a branch built outside the swarm has no manifest; its checks come here.
    else if (flag === '--branch') { if (!/^[A-Za-z0-9._\/-]{1,200}$/.test(value) || value.startsWith('-')) fail('--branch requires a branch name'); branch = value; }
    else if (flag === '--check') {
      let argv;
      try { argv = JSON.parse(value); } catch { fail('--check requires a JSON array of argv strings'); }
      if (!Array.isArray(argv) || !argv.length || argv.some(item => typeof item !== 'string' || !item)) fail('--check requires a JSON array of argv strings');
      if (checks.length >= 10) fail('at most 10 --check flags');
      checks.push({ name: `check-${checks.length + 1}`, argv });
    }
    else if (flag === '--merge-method') mergeMethod = value;
    else if (flag === '--timeout') { if (!/^\d+(\.\d+)?$/.test(value) || Number(value) <= 0) fail('--timeout requires a positive number of seconds'); timeoutMs = Number(value) * 1000; }
    else if (flag === '--tag-timeout') { if (!/^\d+(\.\d+)?$/.test(value)) fail('--tag-timeout requires a non-negative number of seconds'); tagTimeoutMs = Number(value) * 1000; }
    else if (flag === '--poll') { if (!/^\d+(\.\d+)?$/.test(value) || Number(value) <= 0) fail('--poll requires a positive number of seconds'); pollMs = Number(value) * 1000; }
    // Field lesson #178/#243: how many times ship reruns CI's failed jobs before giving up, only
    // when none of the tests they failed on are in this ship's own diff. Left undefined here when
    // the flag is absent so ship() can apply its own platform-only default instead of always 0;
    // an explicit value (including 0) always wins over that default.
    else if (flag === '--rerun-flaky-ci') { if (!/^[01]$/.test(value)) fail('--rerun-flaky-ci requires 0 or 1'); rerunFlakyCi = Number(value); }
    else if (flag === '--rerun-flaky') { if (!/^\d+$/.test(value)) fail('--rerun-flaky requires a non-negative integer'); rerunFlaky = Number(value); }
    // Field lesson #273 (orchestrator answer #3): overrides local config's ci.perTestTimeoutSeconds.
    else if (flag === '--per-test-timeout') { if (!/^\d+(\.\d+)?$/.test(value) || Number(value) <= 0) fail('--per-test-timeout requires a positive number of seconds'); perTestTimeoutSeconds = Number(value); }
    // Field lesson #179: an owner decision to excuse one file from one diff guard, with a reason.
    else if (flag === '--exempt') {
      const parsed = parseExemptFlag(value);
      if (parsed.error) fail(parsed.error);
      exemptions.push(parsed);
    }
    // Field lesson #197: an explicit private-names list wins over the project root's own
    // coordination/private-names.txt.
    else if (flag === '--private-names') privateNamesFile = value;
  }
  if (rerunFlaky !== undefined && rerunFlakyCi !== undefined) fail('rerun-flaky-ci-conflict: use only one CI retry flag', 'rerun-flaky-ci-conflict');
  if (!payloadPath) fail('ship requires --pr PAYLOAD.json');
  if (checks.length && !branch) fail('--check is only for ship --branch; a run ships with its manifest checks');
  return {
    repo, payloadPath, requireSections, merge, mergeMethod, timeoutMs, pollMs,
    ...(tagTimeoutMs !== undefined ? { tagTimeoutMs } : {}),
    ...(noFlakeCheck ? { noFlakeCheck } : {}),
    ...(ciLocal ? {} : { ciLocal: false }),
    ...(branch ? { branch, checks } : {}),
    ...(checksFromCi ? { checksFromCi, ...(checksFromCiPath !== undefined ? { checksFromCiPath } : {}) } : {}),
    ...(rerunFlaky !== undefined ? { rerunFlaky } : {}),
    ...(rerunFlakyCi !== undefined ? { rerunFlakyCi } : {}),
    ...(perTestTimeoutSeconds !== undefined ? { perTestTimeoutSeconds } : {}),
    ...(exemptions.length ? { exemptions } : {}),
    ...(privateNamesFile !== undefined ? { privateNamesFile } : {}),
    ...(acceptPreExisting ? { acceptPreExisting } : {}),
    ...(preflight ? { preflight } : {}),
    ...(waitRequiredOnly ? { waitRequiredOnly } : {}),
  };
}

// Pure CLI-flag parsing for `go`, kept separate from go() execution so it is directly testable.
export function parseGoFlags(flags) {
  let commitMessage, repo, payloadPath, mergeMethod, timeoutMs, tagTimeoutMs, noFlakeCheck, noWatch = false, mutants = false, batch = false, leads, maxJobs, concurrency, maxUsd, maxTokens;
  const requireSections = [], exemptions = [];
  for (let index = 0; index < flags.length; index++) {
    const flag = flags[index];
    if (flag === '--mutants') { mutants = true; continue; }
    if (flag === '--batch') { batch = true; continue; }
    if (flag === '--no-watch') { noWatch = true; continue; }
    if (flag === '--no-flake-check') { noFlakeCheck = true; continue; }
    if (!GO_FLAGS_WITH_VALUE.has(flag)) fail(`Unknown flag: ${flag}`);
    const value = flags[++index];
    if (value === undefined) fail(`${flag} requires a value`);
    if (flag === '--leads') {
      if (value === 'auto') leads = 'auto';
      else if (/^\d+$/.test(value) && Number(value) >= 1 && Number(value) <= 10) leads = Number(value);
      else fail('--leads must be auto or an integer 1–10');
    } else if (flag === '--max-jobs') {
      if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 500) fail('--max-jobs must be an integer 1–500');
      maxJobs = Number(value);
    } else if (flag === '--concurrency') {
      if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 64) fail('--concurrency must be an integer 1–64');
      concurrency = Number(value);
    } else if (flag === '--max-usd') {
      maxUsd = Number(value);
      if (!Number.isFinite(maxUsd) || maxUsd <= 0) fail('--max-usd requires a positive number');
    } else if (flag === '--max-tokens') {
      maxTokens = Number(value);
      if (!Number.isInteger(maxTokens) || maxTokens < 1) fail('--max-tokens requires a positive integer');
    } else if (flag === '--commit-message') commitMessage = value;
    else if (flag === '--repo') repo = value;
    else if (flag === '--pr') payloadPath = value;
    else if (flag === '--require-section') requireSections.push(value);
    else if (flag === '--merge-method') mergeMethod = value;
    else if (flag === '--tag-timeout') { if (!/^\d+(\.\d+)?$/.test(value)) fail('--tag-timeout requires a non-negative number of seconds'); tagTimeoutMs = Number(value) * 1000; }
    else if (flag === '--timeout') { if (!/^\d+(\.\d+)?$/.test(value) || Number(value) <= 0) fail('--timeout requires a positive number of seconds'); timeoutMs = Number(value) * 1000; }
    // Field lesson #179: an owner decision to excuse one file from one diff guard, with a reason.
    else if (flag === '--exempt') {
      const parsed = parseExemptFlag(value);
      if (parsed.error) fail(parsed.error);
      exemptions.push(parsed);
    }
  }
  if (repo && !payloadPath) fail('go requires --pr with --repo');
  return { commitMessage, repo, payloadPath, requireSections, mergeMethod, timeoutMs, mutants, ...(batch ? { batch } : {}), ...(tagTimeoutMs !== undefined ? { tagTimeoutMs } : {}), ...(noFlakeCheck ? { noFlakeCheck } : {}), ...(noWatch ? { noWatch } : {}), ...(exemptions.length ? { exemptions } : {}), ...(leads !== undefined ? { leads } : {}), ...(maxJobs !== undefined ? { maxJobs } : {}), ...(concurrency !== undefined ? { concurrency } : {}), ...(maxUsd !== undefined ? { maxUsd } : {}), ...(maxTokens !== undefined ? { maxTokens } : {}) };
}

function raisedTodayUsdFromAutoDecisions(records, project, nowMs = Date.now()) {
  const today = policyDayKey(null, nowMs);
  let sum = 0;
  for (const entry of records ?? []) {
    if (entry?.kind !== 'auto-decision') continue;
    if (entry.requestKind !== 'cap-raise') continue;
    if (entry.project !== project) continue;
    const at = entry.at ?? entry.ts;
    if (policyDayKey(at, nowMs) !== today) continue;
    const amt = entry.amountUsd;
    if (typeof amt === 'number' && Number.isFinite(amt) && amt > 0) sum += amt;
  }
  return sum;
}

async function collectOpenPolicyRequests(root) {
  const { openDecisions } = await import('../inbox.mjs');
  const { listRequests } = await import('../handbuild.mjs');
  const project = path.basename(root);
  let branch = '';
  try {
    branch = (await execFileAsync('git', ['-C', root, 'branch', '--show-current'], { encoding: 'utf8' })).stdout.trim();
  } catch { /* no branch name */ }
  const events = await readJournal(root, { limit: Infinity });
  const pendingHandbuild = new Map(
    listRequests(root)
      .filter(r => r && r.status === 'pending')
      .map(r => [String(r.id), r]),
  );
  const items = [];
  for (const decision of openDecisions(events)) {
    const id = String(decision.id ?? '');
    if (!id.startsWith('handbuild-')) continue;
    const hbId = id.slice('handbuild-'.length);
    const req = pendingHandbuild.get(hbId);
    if (!req) continue;
    items.push({
      id,
      kind: 'hand-build-request',
      project,
      raw: req,
      facts: {
        files: Array.isArray(req.files) ? req.files.map(String) : [],
        git: Array.isArray(req.git) ? req.git.map(String) : [],
        branch,
      },
    });
  }
  return items;
}

// The profile for the protected-path gate: null when the project has none, an error when it exists but is not valid
// (a broken profile must never quietly switch the protection off).
async function enforceProtectedPaths(root, jobs, { resources = [] } = {}) {
  let profile = null;
  try {
    const pointer = JSON.parse(await fs.readFile(path.join(root, '.project-swarm.json'), 'utf8'));
    if (pointer && pointer.profile !== undefined) {
      const checked = validateProfile(pointer.profile);
      if (checked.errors.length) fail(`profile-invalid: ${checked.errors[0]}; run swarm init to repair it`, 'profile-invalid');
      profile = checked.profile;
    }
  } catch (error) { if (error.code !== 'ENOENT') { if (error.code === 'profile-invalid') throw error; fail('profile-invalid: .project-swarm.json is not valid JSON; run swarm init', 'profile-invalid'); } }
  const all = [...jobs, ...(resources.length ? [{ id: '(resources)', context: resources }] : [])];
  const verb = kind => (kind === 'deletes' ? 'deletes' : kind === 'context' ? 'reads' : 'writes');
  const hits = profile ? protectedViolations(profile, all) : [];
  if (hits.length) fail(`protected-path: job ${hits[0].job} ${verb(hits[0].kind)} ${hits[0].path} (protected: ${hits[0].entry})`, 'protected-path');
  // Symlinks: what a path really points at is what counts. Anything that resolves outside the project is refused, and
  // anything that resolves into a protected path is treated as that path.
  const realRoot = await fs.realpath(root);
  const known = new Map();
  const resolveReal = async file => {
    const absolute = path.resolve(realRoot, file);
    const rest = [];
    let probe = absolute;
    for (;;) {
      if (known.has(probe)) return path.join(known.get(probe), ...rest.reverse());
      try { const real = await fs.realpath(probe); known.set(probe, real); return path.join(real, ...rest.reverse()); }
      catch (error) {
        if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error;
        rest.push(path.basename(probe));
        const parent = path.dirname(probe);
        if (parent === probe) return absolute;
        probe = parent;
      }
    }
  };
  for (const job of all) {
    for (const [field, kind] of [['outputs', 'output'], ['outputDirs', 'output'], ['deletes', 'deletes'], ['context', 'context']]) {
      for (const file of Array.isArray(job[field]) ? job[field] : []) {
        if (typeof file !== 'string') continue;
        const real = await resolveReal(file);
        if (real !== realRoot && !real.startsWith(realRoot + path.sep)) fail(`path-outside-project: job ${job.id} ${verb(kind)} ${file}, which resolves outside the project`, 'path-outside-project');
        const relative = path.relative(realRoot, real).split(path.sep).join('/');
        // The real target decides: a template read stays allowed, a symlink that leads to a real secret or protected file does not.
        const asTemplate = kind === 'context' && profile && templateReadable(profile, relative);
        if (kind === 'context' && isExampleFile(file) && relative !== path.posix.normalize(file) && isProfileSecretPath(relative) && !isExampleFile(relative)) fail(`protected-path: job ${job.id} reads ${file}, which is a link to the secret ${relative}`, 'protected-path');
        if (asTemplate && isExampleFile(relative)) {
          // A template is names, not values: one that holds what looks like a real key is not handed to a worker.
          const text = await fs.readFile(path.join(realRoot, relative), 'utf8').then(value => value.slice(0, 40000), () => null);
          if (text !== null && findUnsafeText(text).length) fail(`protected-path: job ${job.id} reads ${file}, which holds what looks like a real secret value; empty the values (a template holds names only)`, 'protected-path');
        }
        const entry = profile && !(kind === 'context' && ((typeof job.allowProtectedContext === 'string' && job.allowProtectedContext.trim()) || asTemplate)) ? protectedPathHit(profile, relative, { read: kind === 'context' }) : null;
        if (entry) fail(`protected-path: job ${job.id} ${verb(kind)} ${file} (resolves to ${relative}; protected: ${entry})`, 'protected-path');
      }
    }
  }
}

async function refreshMapQuietly(root) {
  try {
    const head = (await execFileAsync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).then(out => out.stdout.trim(), () => null));
    if (head && !mapIsFresh(await readRepoMap(root), head)) await refreshRepoMap(root);
  } catch { /* the map is a convenience, never a reason to fail a plan */ }
}

export { collectOpenPolicyRequests, enforceProtectedPaths, extractChangelog, gitDirty, installNewRelease, raisedTodayUsdFromAutoDecisions, refreshMapQuietly };
