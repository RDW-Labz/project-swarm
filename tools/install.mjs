#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Project Swarm contributors
import fs from 'node:fs/promises';
import { existsSync, realpathSync } from 'node:fs';
import os from 'node:os';
import nodeCrypto from 'node:crypto';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { installSwarmCommand } from './swarm-bin.mjs';
import { zshCompletion } from './completion.mjs';
const packageRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const execFileAsync=promisify(execFile);
const AGENT_HOMES=['.claude','.codex'];

async function safeTarget(root,relative,{createParents=false,created=[]}={}){
 let target=root;
 const parts=relative.split('/');
 for(let index=0;index<parts.length;index++){
  target=path.join(target,parts[index]);
  let stat;
  try{stat=await fs.lstat(target);}catch(error){if(error.code!=='ENOENT')throw error;}
  if(!stat&&createParents&&index<parts.length-1){
   // Recheck ancestors before each nonrecursive mutation. This is a guard against
   // observed path swaps, not an OS sandbox or a claim to eliminate every TOCTOU race.
   const partial=parts.slice(0,index+1).join('/');
   await safeTarget(root,partial);
   try{await fs.mkdir(target);created.push(partial);}catch(error){if(error.code!=='EEXIST')throw error;}
   stat=await fs.lstat(target);
  }
  if(stat?.isSymbolicLink())throw Error(`Symlink refused: ${relative}`);
  if(stat&&index<parts.length-1&&!stat.isDirectory())throw Error(`Non-directory parent: ${relative}`);
 }
 return target;
}

async function gitDirty(dir,paths){
 try{
  const {stdout}=await execFileAsync('git',['-C',dir,'status','--porcelain','--',...paths],{encoding:'utf8'});
  return stdout.trim().length>0;
 }catch{return false;} // not a git checkout (e.g. a release archive): nothing to protect against
}

async function skillFilePairs(source){
 const pairs=[['skills/project-swarm/SKILL.md','SKILL.md'],['SECURITY.md','references/SECURITY.md'],['CONTRIBUTING.md','references/CONTRIBUTING.md']];
 for(const file of (await fs.readdir(path.join(source,'docs'))).filter(f=>/\.(md|json)$/.test(f)).sort())pairs.push([`docs/${file}`,`references/${file}`]);
 return pairs;
}

async function listFiles(dir,base=dir,out=[]){
 for(const entry of await fs.readdir(dir,{withFileTypes:true})){
  const full=path.join(dir,entry.name);
  if(entry.isDirectory())await listFiles(full,base,out);
  else if(entry.isFile())out.push(path.relative(base,full));
 }
 return out;
}

// Snapshots runtime and rendered skill references into versions/<version>-<hash8>, so a live run that
// keeps importing through current/ never sees files change under it. hash8 is the first 8 hex
// chars of a sha256 over every copied file's relative path and contents, so re-installing
// identical files resolves to the same dir instead of growing versions/ on every run.
export async function snapshotVersion(source,version,{versionsParent=source}={}){
 const files=[...(await listFiles(path.join(source,'tools'))).map(file=>[path.join('tools',file),path.join('tools',file)]),['package.json','package.json'],...(await skillFilePairs(source)).map(([from,to])=>[from,`skills/project-swarm/${to}`])].sort(([a],[b])=>a.localeCompare(b));
 const hash=createHash('sha256');
 for(const [relative] of files){hash.update(relative);hash.update(await fs.readFile(path.join(source,relative)));}
 const versionDir=path.join(versionsParent,'versions',`${version}-${hash.digest('hex').slice(0,8)}`);
 let exists=false;
 try{exists=(await fs.stat(versionDir)).isDirectory();}catch(error){if(error.code!=='ENOENT')throw error;}
 if(!exists){
  const tmpDir=`${versionDir}.tmp-${process.pid}`;
  const runner=path.join(versionsParent,'current/tools/swarm.mjs');
  for(const [relative,target] of files){
   const destination=path.join(tmpDir,target);
   await fs.mkdir(path.dirname(destination),{recursive:true});
   if(target.startsWith('skills/')){
    let content=await fs.readFile(path.join(source,relative),'utf8');
    content=content.split('{{SWARM_RUNNER}}').join(runner);
    if(target.includes('/references/'))content=content.replace(/\]\(\.\.\/(SECURITY|CONTRIBUTING)\.md\)/g,']($1.md)').replace(/\]\(docs\//g,'](');
    await fs.writeFile(destination,content);
   }else await fs.copyFile(path.join(source,relative),destination);
  }
  await fs.rename(tmpDir,versionDir);
 }
 return versionDir;
}

export async function versionDirFor(versionsParent,version){
 const versionsDir=path.join(versionsParent,'versions');
 let entries;
 try{entries=await fs.readdir(versionsDir);}catch(error){if(error.code==='ENOENT')return null;throw error;}
 const prefix=`${version}-`;
 const name=entries.find(entry=>entry.startsWith(prefix));
 return name?path.join(versionsDir,name):null;
}

// Atomically repoints <source>/current at versionDir: a symlink created under a pid-unique
// name, then renamed over current. rename() replaces the old symlink in one filesystem
// operation, so a run resolving its own realpath through current/ keeps importing its own
// version dir even while (or after) a later install swaps current to a new one.
async function repointCurrent(source,versionDir){
 const currentPath=path.join(source,'current');
 const tmpLink=path.join(source,`current.tmp-${process.pid}`);
 await fs.rm(tmpLink,{force:true});
 await fs.symlink(versionDir,tmpLink);
 await fs.rename(tmpLink,currentPath);
 return currentPath;
}

// Keeps the `keep` newest version dirs (by mtime) plus whichever one `current` points to,
// deleting the rest so versions/ doesn't grow forever.
const versionPartOf=name=>{const match=String(name).match(/^(\d+\.\d+\.\d+)-/);return match?match[1]:null;};

export async function pruneVersions(source,{keep=5,protect=new Set()}={}){
 const versionsDir=path.join(source,'versions');
 let entries;
 try{entries=await fs.readdir(versionsDir,{withFileTypes:true});}catch(error){if(error.code==='ENOENT')return [];throw error;}
 const dirs=entries.filter(entry=>entry.isDirectory()).map(entry=>path.join(versionsDir,entry.name));
 let currentTarget=null;
 try{currentTarget=await fs.realpath(path.join(source,'current'));}catch{currentTarget=null;}
 const stats=await Promise.all(dirs.map(async dir=>({dir,mtimeMs:(await fs.stat(dir)).mtimeMs,name:path.basename(dir)})));
 stats.sort((a,b)=>b.mtimeMs-a.mtimeMs);
 const keepSet=new Set();
 for(const entry of stats){
  const part=versionPartOf(entry.name);
  if(part&&protect.has(part))keepSet.add(entry.dir);
 }
 for(const entry of stats.slice(0,keep))keepSet.add(entry.dir);
 if(currentTarget)keepSet.add(currentTarget);
 const removed=[];
 for(const entry of stats){
  if(!keepSet.has(entry.dir)){await fs.rm(entry.dir,{recursive:true,force:true});removed.push(entry.dir);}
 }
 return removed;
}

// Installs the skill once per agent home for every project on this machine. Idempotent: it
// only ever writes files inside <agentHome>/skills/project-swarm and always overwrites them.
export async function installUser({source=packageRoot,home=os.homedir(),dev=false}={}){
 source=await fs.realpath(source);
 if(!dev&&await gitDirty(source,['tools','skills']))throw Error('Refusing to install from a checkout with uncommitted changes to tools/ or skills/; commit or stash them, or pass --dev for a development checkout');
 const pkg=JSON.parse(await fs.readFile(path.join(source,'package.json'),'utf8'));
 const versionDir=await snapshotVersion(source,pkg.version);
 const {migrateVersionPackageJson}=await import('./runner-version.mjs');
 await migrateVersionPackageJson(source);
 const currentPath=await repointCurrent(source,versionDir);
 const {pinnedVersions,readPins}=await import('./pins.mjs');
 const protect=new Set([...(await pinnedVersions(source)).keys()]);
 const pinRead=await readPins(source);
 await pruneVersions(source,{protect});
 const runner=path.join(currentPath,'tools/swarm.mjs');
 const pairs=await skillFilePairs(source);
 const skipped=[],written=[];
 for(const dir of AGENT_HOMES){
  const agentHome=path.join(home,dir);
  let exists=false;
  try{exists=(await fs.stat(agentHome)).isDirectory();}catch{exists=false;}
  if(!exists){skipped.push(dir);continue;}
  for(const [from,to] of pairs){
   let text=(await fs.readFile(path.join(source,from))).toString('utf8');
   if(to.startsWith('references/'))text=text.replace(/\]\(\.\.\/(SECURITY|CONTRIBUTING)\.md\)/g,']($1.md)').replace(/\]\(docs\//g,'](');
   text=text.split('{{SWARM_RUNNER}}').join(runner);
   const relTarget=`skills/project-swarm/${to}`;
   await safeTarget(agentHome,relTarget,{createParents:true});
   const destination=await safeTarget(agentHome,relTarget);
   await fs.writeFile(destination,text,'utf8');
   written.push(destination);
  }
 }
 // A real `swarm` executable for agents and scripts (non-interactive shells never load aliases),
 // and the zsh completion file. Neither edits a shell profile; doctor says what is left to do.
 const swarmCommand=await installSwarmCommand({home,runner});
 const completionFile=path.join(home,'.project-swarm','completions','_swarm');
 await fs.mkdir(path.dirname(completionFile),{recursive:true});
 await fs.writeFile(completionFile,zshCompletion());
 const record={version:pkg.version,dev,installedAt:new Date().toISOString(),skillTargets:written,versionDir,runner,swarmCommand:swarmCommand.path,completion:completionFile};
 const recordPath=path.join(source,'.swarm-install.json');
 await fs.writeFile(recordPath,`${JSON.stringify(record,null,2)}\n`);
 return {status:'installed',version:pkg.version,source,skillTargets:written,skipped,installRecord:recordPath,versionDir,runner,swarmCommand,completionFile,pinUnreadable:pinRead.unreadable};
}

const AGENT_START='<!-- project-swarm:start -->';
const AGENT_END='<!-- project-swarm:end -->';

async function readOptional(file){
 try{return await fs.readFile(file,'utf8');}catch(error){if(error.code==='ENOENT')return '';throw error;}
}

// Only our delimited block is replaced. Refuse broken markers instead of guessing
// where user instructions end. Cursor gets frontmatter only on a newly created file.
async function writeAgentPointer(root,relative,template,installRoot){
 const destination=await safeTarget(root,relative,{createParents:true});
 const before=await readOptional(destination);
 const rendered=template.split('{{SWARM_INSTALL}}').join(installRoot);
 const start=before.indexOf(AGENT_START),end=before.indexOf(AGENT_END);
 let after;
 if(start!==-1||end!==-1){
  if(start===-1||end<start||before.indexOf(AGENT_START,start+1)!==-1||before.indexOf(AGENT_END,end+1)!==-1)throw Error(`Malformed project-swarm markers: ${relative}`);
  const block=rendered.slice(rendered.indexOf(AGENT_START),rendered.indexOf(AGENT_END)+AGENT_END.length);
  after=before.slice(0,start)+block+before.slice(end+AGENT_END.length);
 }else after=before?before+(before.endsWith('\n')?'':'\n')+'\n'+rendered.slice(rendered.indexOf(AGENT_START)):rendered;
 if(after!==before)await fs.writeFile(await safeTarget(root,relative),after);
}

export async function ensureSwarmIgnore(root){
 const destination=await safeTarget(root,'.gitignore');
 const before=await readOptional(destination);
 const lines=before.split(/\r?\n/).map(line=>line.trim());
 // Put our rule after any negation, including broad !*/ patterns.
 const lastNegation=lines.findLastIndex(line=>line.startsWith('!'));
 const ignored=lines.some((line,index)=>index>lastNegation&&['.swarm/','/.swarm/','.swarm','/.swarm'].includes(line));
 if(ignored)return false;
 await fs.writeFile(destination,before+(before&&!before.endsWith('\n')?'\n':'')+'.swarm/\n');
 return true;
}

// After each Claude Code turn, snapshot the project journal. It needs no model, and it keeps the state
// current even if the next turn is rate limited. The guard makes it a no-op where `swarm` is not on PATH.
// Existing hooks and settings are kept; an unreadable settings file is left alone.
export const CHECKPOINT_HOOK='command -v swarm >/dev/null 2>&1 && swarm checkpoint --quiet || true';
async function ensureCheckpointHook(root){
 // Personal and local to this checkout: Claude Code reads settings.local.json and it is not committed, so
 // the hook is never pushed onto collaborators who do not run swarm.
 const relative='.claude/settings.local.json';
 const destination=await safeTarget(root,relative,{createParents:true});
 const before=await readOptional(destination);
 let settings={};
 if(before.trim()){
  try{settings=JSON.parse(before);}catch{return {status:'skipped',reason:'settings.json is not valid JSON'};}
  if(!settings||typeof settings!=='object'||Array.isArray(settings))return {status:'skipped',reason:'settings.json is not an object'};
 }
 if(settings.hooks!==undefined&&(typeof settings.hooks!=='object'||settings.hooks===null||Array.isArray(settings.hooks)))return {status:'skipped',reason:'hooks is not an object'};
 settings.hooks??={};
 if(settings.hooks.Stop!==undefined&&!Array.isArray(settings.hooks.Stop))return {status:'skipped',reason:'hooks.Stop is not a list'};
 settings.hooks.Stop??=[];
 const present=settings.hooks.Stop.some(entry=>Array.isArray(entry?.hooks)&&entry.hooks.some(hook=>hook?.command===CHECKPOINT_HOOK));
 if(present)return {status:'unchanged'};
 settings.hooks.Stop.push({hooks:[{type:'command',command:CHECKPOINT_HOOK}]});
 const temp=`${destination}.swarm-tmp`;
 await fs.writeFile(temp,`${JSON.stringify(settings,null,2)}\n`);
 await fs.rename(temp,destination);
 await ensureLocalSettingsIgnored(root);
 return {status:before.trim()?'updated':'created'};
}

// Hooks installed into the personal settings file `.claude/settings.local.json` (git-ignored, like the checkpoint hook): the Orchestrator lane's observer hooks (PreToolUse, PostToolUse,
// Stop, UserPromptSubmit, SessionEnd: tools/orchestrator-hook.mjs appends one small event, prints nothing) and the hand-build guard (a PreToolUse hook: tools/handbuild-guard.mjs). Each command points at
// the install's `current` folder, so it keeps working after `swarm update`, and is wrapped so that a missing script (before the update that brings it) is a no-op, never an error.
// An entry from an older install is replaced, anything else in the file is kept, and an unreadable settings file is left alone.
export const ORCHESTRATOR_HOOK_EVENTS=Object.freeze({PreToolUse:'pre',PostToolUse:'post',Stop:'stop',UserPromptSubmit:'prompt',SessionEnd:'end'});
export const GUARD_MATCHER='Edit|Write|MultiEdit|NotebookEdit|Bash';
const hookCommand=(script,arg)=>`test -f ${JSON.stringify(script)} && node ${JSON.stringify(script)}${arg?` ${arg}`:''} || true`;
const commandOf=hook=>typeof hook?.command==='string'?hook.command:'';
export function stableInstallDir(installRoot){
 for(const root of [installRoot,...(installRoot?(()=>{try{return [realpathSync(installRoot)];}catch{return [];}})():[])]){
  const parent=path.dirname(root);
  if(path.basename(parent)==='versions')return path.join(path.dirname(parent),'current');
 }
 let resolved=installRoot;
 try{resolved=realpathSync(installRoot);}catch{/* keep installRoot */}
 const currentCandidate=path.join(resolved,'current');
 try{
  if(existsSync(path.join(currentCandidate,'tools','swarm.mjs')))return realpathSync(currentCandidate);
 }catch{/* no current */}
 return installRoot;
}
export const HOOK_SCRIPT_MARKERS=Object.freeze(['handbuild-guard.mjs','orchestrator-hook.mjs']);
export function hookScriptCommand(installRoot,script,arg){
 return hookCommand(path.join(stableInstallDir(installRoot),'tools',script),arg);
}
function commandReferencesOurHook(command){
 const c=commandOf(command);
 return HOOK_SCRIPT_MARKERS.some(marker=>c.includes(marker));
}
const ALL_HOOK_SPECS=()=>[{event:'PreToolUse',script:'handbuild-guard.mjs'},...ORCHESTRATOR_SPECS];
function patchHookCommandsInSettingsText(before,settings,installRoot){
 let text=before,changed=false;
 for(const sp of ALL_HOOK_SPECS()){
  const command=hookScriptCommand(installRoot,sp.script,sp.arg);
  const list=settings.hooks[sp.event];
  if(!Array.isArray(list))continue;
  for(const entry of list)for(const hook of Array.isArray(entry?.hooks)?entry.hooks:[]){
   if(!commandOf(hook).includes(sp.script))continue;
   const old=hook.command;
   if(old===command)continue;
   const oldJson=JSON.stringify(old);
   const newJson=JSON.stringify(command);
   if(text.includes(oldJson))text=text.replace(oldJson,newJson);
   hook.command=command;
   changed=true;
  }
 }
 if(!changed)return {text:before,changed:false};
 return {text:`${text.endsWith('\n')?text.slice(0,-1):text}\n`,changed:true};
}
export async function refreshTrackedSettingsHooks(root,installRoot){
 const destination=path.join(root,'.claude','settings.json');
 try{await fs.access(destination);}catch{return {status:'absent'};}
 const before=await readOptional(destination);
 if(!before.trim())return {status:'absent'};
 let settings;
 try{settings=JSON.parse(before);}catch{return {status:'skipped',reason:'settings.json is not valid JSON'};}
 if(!settings||typeof settings!=='object'||Array.isArray(settings))return {status:'skipped',reason:'settings.json is not an object'};
 if(settings.hooks!==undefined&&(typeof settings.hooks!=='object'||settings.hooks===null||Array.isArray(settings.hooks)))return {status:'skipped',reason:'hooks is not an object'};
 settings.hooks??={};
 const hasOur=Object.values(settings.hooks).flatMap(list=>Array.isArray(list)?list:[]).flatMap(entry=>Array.isArray(entry?.hooks)?entry.hooks:[]).some(hook=>commandReferencesOurHook(hook));
 if(!hasOur)return {status:'absent'};
 const patched=patchHookCommandsInSettingsText(before,settings,installRoot);
 if(!patched.changed)return {status:'unchanged'};
 let mode=0o644;
 try{mode=(await fs.stat(destination)).mode&0o777;}catch{/* new */}
 const temp=`${destination}.swarm-tmp-${process.pid}-${nodeCrypto.randomBytes(4).toString('hex')}`;
 await fs.writeFile(temp,patched.text,{flag:'wx',mode});
 await fs.rename(temp,destination);
 return {status:'updated',tracked:true};
}
export async function refreshProjectInstallHooks(root,installRoot,{refreshOnly=false}={}){
 const orchestrator=await ensureOrchestratorHooks(root,installRoot,{refreshOnly});
 const handbuild=await ensureHandbuildGuard(root,installRoot,{refreshOnly,honorRemoved:true});
 const tracked=await refreshTrackedSettingsHooks(root,installRoot);
 return {orchestrator,handbuild,tracked};
}
export function readGuardHookCommandFromSettings(settings){
 if(!settings?.hooks||typeof settings.hooks!=='object')return null;
 for(const list of Object.values(settings.hooks)){
  if(!Array.isArray(list))continue;
  for(const entry of list)for(const hook of Array.isArray(entry?.hooks)?entry.hooks:[]){
   const c=commandOf(hook);
   if(c.includes('handbuild-guard.mjs'))return c;
  }
 }
 return null;
}
export function guardHookScriptPathFromCommand(command){
 const m=String(command??'').match(/node\s+((?:\\.|[^"\\])+|"[^"]*")/);
 if(!m)return null;
 try{return JSON.parse(m[1]);}catch{return m[1].replace(/^"|"$/g,'');}
}
export function guardHookPathStatus({hookCommand,installRoot}={}){
 const stableScript=path.join(stableInstallDir(installRoot),'tools','handbuild-guard.mjs');
 const hookScript=hookCommand?guardHookScriptPathFromCommand(hookCommand):null;
 const stablePath=path.resolve(stableScript);
 const hookPath=hookScript?path.resolve(hookScript):null;
 const matches=hookPath!==null&&hookPath===stablePath;
 const underCurrent=hookPath!==null&&/(?:^|[/\\])current(?:[/\\]|$)/.test(hookPath);
 return {hookPath,stablePath,matches,underCurrent,warn:hookPath!==null&&(!matches||!underCurrent)};
}
async function readSettings(root){
 const destination=await safeTarget(root,'.claude/settings.local.json',{createParents:true});
 const before=await readOptional(destination);
 let settings={};
 if(before.trim()){
  try{settings=JSON.parse(before);}catch{return {destination,before,problem:'settings.local.json is not valid JSON'};}
  if(!settings||typeof settings!=='object'||Array.isArray(settings))return {destination,before,problem:'settings.local.json is not an object'};
 }
 if(settings.hooks!==undefined&&(typeof settings.hooks!=='object'||settings.hooks===null||Array.isArray(settings.hooks)))return {destination,before,problem:'hooks is not an object'};
 settings.hooks??={};
 return {destination,before,settings};
}
async function writeSettings(root,destination,settings,before){
 // A temp file with its own name, created exclusively (a planted link at a fixed name cannot redirect the write), with the old file's mode, then renamed over.
 let mode=0o600;
 try{mode=(await fs.stat(destination)).mode&0o777;}catch{/* a new file */}
 const temp=`${destination}.swarm-tmp-${process.pid}-${nodeCrypto.randomBytes(4).toString('hex')}`;
 await fs.writeFile(temp,`${JSON.stringify(settings,null,2)}\n`,{flag:'wx',mode});
 await fs.rename(temp,destination);
 await ensureLocalSettingsIgnored(root);
 return {status:before.trim()?'updated':'created'};
}
// specs: [{event, matcher?, script, arg?}]. marker: the script name that identifies this feature's entries.
async function ensureHookSpecs(root,installRoot,specs,{refreshOnly=false}={}){
 const read=await readSettings(root);
 if(read.problem)return {status:'skipped',reason:read.problem};
 const {destination,before,settings}=read;
 if(refreshOnly){
  const commands=Object.values(settings.hooks).flatMap(list=>Array.isArray(list)?list:[]).flatMap(entry=>Array.isArray(entry?.hooks)?entry.hooks:[]).map(commandOf);
  if(!commands.some(c=>c.includes(CHECKPOINT_HOOK)||specs.some(sp=>c.includes(sp.script))))return {status:'absent'};
 }
 let changed=false;
 for(const sp of specs){
  if(settings.hooks[sp.event]!==undefined&&!Array.isArray(settings.hooks[sp.event]))return {status:'skipped',reason:`hooks.${sp.event} is not a list`};
  const command=hookScriptCommand(installRoot,sp.script,sp.arg);
  const list=settings.hooks[sp.event]??=[];
  let found=false;
  for(const entry of list)for(const hook of Array.isArray(entry?.hooks)?entry.hooks:[])if(commandOf(hook).includes(sp.script)&&(!sp.arg||commandOf(hook).includes(` ${sp.arg} `)||commandOf(hook).includes(` ${sp.arg}`))){found=true;if(hook.command!==command){hook.command=command;changed=true;}if(sp.matcher&&entry.matcher!==sp.matcher){entry.matcher=sp.matcher;changed=true;}}
  if(!found){list.push({...(sp.matcher?{matcher:sp.matcher}:{}),hooks:[{type:'command',command}]});changed=true;}
 }
 if(!changed)return {status:'unchanged'};
 return writeSettings(root,destination,settings,before);
}
const ORCHESTRATOR_SPECS=Object.entries(ORCHESTRATOR_HOOK_EVENTS).map(([event,arg])=>({event,matcher:event==='PreToolUse'||event==='PostToolUse'?'*':undefined,script:'orchestrator-hook.mjs',arg}));
// An owner who does not want the lane creates `.swarm/orchestrator/off`: nothing is installed or refreshed there. `refreshOnly` (used by `swarm update` on linked projects) only touches a
// project that already has the checkpoint hook or the Orchestrator hooks, i.e. one that was set up with agent files.
export async function ensureOrchestratorHooks(root,installRoot,{refreshOnly=false}={}){
 try{await fs.access(path.join(root,'.swarm','orchestrator','off'));return {status:'off'};}catch{/* not switched off */}
 return ensureHookSpecs(root,installRoot,ORCHESTRATOR_SPECS,{refreshOnly});
}
// The hand-build guard: installed on request (`swarm handbuild install`) and by `swarm init` for a new project; `swarm update` only refreshes where it is already installed.
export async function ensureHandbuildGuard(root,installRoot,{refreshOnly=false,honorRemoved=false}={}){
 // `swarm handbuild uninstall` leaves a marker: a later `swarm init` does not bring the guard back (only `swarm handbuild install` does).
 if(honorRemoved){try{await fs.access(path.join(root,'.swarm','handbuild','removed'));return {status:'removed-by-owner'};}catch{/* no marker */}}
 await fs.rm(path.join(root,'.swarm','handbuild','removed'),{force:true}).catch(()=>{});
 if(refreshOnly){
  const read=await readSettings(root);
  if(read.problem)return {status:'skipped',reason:read.problem};
  const has=Object.values(read.settings.hooks).flatMap(list=>Array.isArray(list)?list:[]).flatMap(entry=>Array.isArray(entry?.hooks)?entry.hooks:[]).some(hook=>commandOf(hook).includes('handbuild-guard.mjs'));
  if(!has)return {status:'absent'};
 }
 return ensureHookSpecs(root,installRoot,[{event:'PreToolUse',matcher:GUARD_MATCHER,script:'handbuild-guard.mjs'}],{refreshOnly:false});
}
export async function removeHandbuildGuard(root){
 const read=await readSettings(root);
 if(read.problem)return {status:`not removed: ${read.problem}`};
 const {destination,before,settings}=read;
 let changed=false;
 for(const [event,list] of Object.entries(settings.hooks)){
  if(!Array.isArray(list))continue;
  const kept=list.map(entry=>Array.isArray(entry?.hooks)?{...entry,hooks:entry.hooks.filter(hook=>!commandOf(hook).includes('handbuild-guard.mjs'))}:entry).filter(entry=>!Array.isArray(entry?.hooks)||entry.hooks.length>0);
  if(kept.length!==list.length||JSON.stringify(kept)!==JSON.stringify(list)){settings.hooks[event]=kept;changed=true;}
 }
 // the owner's choice is remembered: init does not bring the guard back
 try{await fs.mkdir(path.join(root,'.swarm','handbuild'),{recursive:true});await fs.writeFile(path.join(root,'.swarm','handbuild','removed'),'');}catch{/* best effort */}
 if(!changed)return {status:'was not installed'};
 await writeSettings(root,destination,settings,before);
 return {status:'removed'};
}

async function ensureLocalSettingsIgnored(root){
 const destination=await safeTarget(root,'.gitignore');
 const before=await readOptional(destination);
 if(before.split(/\r?\n/).some(line=>['.claude/settings.local.json','/.claude/settings.local.json'].includes(line.trim())))return;
 await fs.writeFile(destination,before+(before&&!before.endsWith('\n')?'\n':'')+'.claude/settings.local.json\n');
}

// The pointer file `.project-swarm.json` also holds the project's own profile (budget, UI, verify, migrations rule): it is never rewritten from scratch. The old file is copied to
// `.project-swarm.json.bak-<time>` first, only `install` and `version` change, the new file is written beside it and renamed over it, and a file that is not a JSON object is refused
// (nothing is written) instead of being replaced by a bare pointer.
export async function patchPointer(root,patch){
 const destination=await safeTarget(root,'.project-swarm.json');
 let before=null,existing={};
 try{before=await fs.readFile(destination,'utf8');}catch(error){if(error.code!=='ENOENT')throw error;}
 if(before!==null){
  try{existing=JSON.parse(before);}catch{throw Error(`.project-swarm.json in ${root} is not valid JSON; fix it by hand (a backup was not needed, nothing was changed)`);}
  if(!existing||typeof existing!=='object'||Array.isArray(existing))throw Error(`.project-swarm.json in ${root} is not a JSON object; fix it by hand (nothing was changed)`);
  const next={...existing,...patch};
  if(JSON.stringify(existing)===JSON.stringify(next))return {changed:false,backup:null};
  const backup=`${destination}.bak-${Date.now()}-${nodeCrypto.randomBytes(3).toString('hex')}`;
  await fs.writeFile(backup,before,{flag:'wx',mode:0o600});
  const temp=`${destination}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(temp,`${JSON.stringify(next,null,2)}\n`);
  await fs.rename(temp,destination);
  return {changed:true,backup};
 }
 throw Error(`no .project-swarm.json in ${root}`);
}

// Release fields (version, install path used by the runner) live in git-ignored .swarm/runner-pointer.json so `swarm update` never dirties the tracked profile file.
export async function writePointer(root,{install,version}){
 const {readRunnerPointer,bootstrapProjectPointer,writeReleasePointer}=await import('./runner-pointer.mjs');
 const destination=await safeTarget(root,'.project-swarm.json');
 let before=null;
 try{before=await fs.readFile(destination,'utf8');}catch(error){if(error.code!=='ENOENT')throw error;}
 if(before===null)return bootstrapProjectPointer(root,{install,version});
 let existing;
 try{existing=JSON.parse(before);}catch{throw Error(`.project-swarm.json in ${root} is not valid JSON; fix it by hand (a backup was not needed, nothing was changed)`);}
 if(!existing||typeof existing!=='object'||Array.isArray(existing))throw Error(`.project-swarm.json in ${root} is not a JSON object; fix it by hand (nothing was changed)`);
 const merged=await readRunnerPointer(root);
 if(merged.install===install&&merged.version===version)return {changed:false,backup:null};
 return writeReleasePointer(root,{install,version});
}

// Links one project to a shared install instead of copying the runner into it. The project
// gets a small pointer file; the install root keeps a deduped registry of linked projects.
export async function installProject(targetDirectory,{source=packageRoot,agentFiles=true}={}){
 const root=await fs.realpath(targetDirectory);
 if(!(await fs.stat(root)).isDirectory())throw Error('Target must be an existing project directory');
 const installRoot=await fs.realpath(source);
 const pkg=JSON.parse(await fs.readFile(path.join(installRoot,'package.json'),'utf8'));
 // The hand-build guard is for a project that is linked for the first time: re-running init (or install) in an existing project never turns it on by itself.
 const isNew=!(await fs.access(path.join(root,'.project-swarm.json')).then(()=>true,()=>false));
 await writePointer(root,{install:installRoot,version:pkg.version});
 const registryPath=path.join(installRoot,'.swarm-projects.json');
 let registry=[];
 try{registry=JSON.parse(await fs.readFile(registryPath,'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}
 if(!Array.isArray(registry))registry=[];
 if(!registry.includes(root)){registry.push(root);await fs.writeFile(registryPath,`${JSON.stringify(registry,null,2)}\n`);}
 const added=[],kept=[];
 const pairs=(await fs.readdir(path.join(installRoot,'examples'))).filter(f=>f.endsWith('.json')).sort().map(file=>[`examples/${file}`,`coordination/swarm-${file}`]);
 for(const file of ['ORCHESTRATOR.md','HANDOFF.md','TASK.md','swarm-lessons.md','CONTRACT.md'])pairs.push([`templates/coordination/${file}`,`coordination/${file}`]);
 for(const [from,to] of pairs){
  const destination=await safeTarget(root,to,{createParents:true});
  try{
   await fs.writeFile(destination,await fs.readFile(path.join(installRoot,from)),{flag:'wx'});
   added.push(to);
   }catch(error){if(error.code!=='EEXIST')throw error;kept.push(to);}
 }
 const vendorRoot=path.join(installRoot,'templates/coordination/skills');
 let vendorSkills=[];
 try{vendorSkills=(await fs.readdir(vendorRoot,{withFileTypes:true})).filter(entry=>entry.isDirectory()).sort((a,b)=>a.name.localeCompare(b.name));}
 catch(error){if(error.code!=='ENOENT')throw error;}
 for(const entry of vendorSkills){
  const name=entry.name,relativeDir=`coordination/skills/${name}`,sourceDir=path.join(vendorRoot,name),destinationDir=await safeTarget(root,relativeDir);
  const files=await listFiles(sourceDir);
  let exists=false;
  try{
   const stat=await fs.lstat(destinationDir);
   if(stat.isSymbolicLink())throw Error(`Symlink refused: ${relativeDir}`);
   if(!stat.isDirectory())throw Error(`Non-directory parent: ${relativeDir}`);
   exists=true;
  }catch(error){if(error.code!=='ENOENT')throw error;}
  if(exists){
   for(const file of files)kept.push(`${relativeDir}/${file}`);
   continue;
  }
  await fs.mkdir(await safeTarget(root,'coordination/skills',{createParents:true}),{recursive:true});
  try{await fs.mkdir(destinationDir);}catch(error){
   if(error.code!=='EEXIST')throw error;
   const stat=await fs.lstat(destinationDir);
   if(stat.isSymbolicLink())throw Error(`Symlink refused: ${relativeDir}`);
   if(!stat.isDirectory())throw Error(`Non-directory parent: ${relativeDir}`);
   for(const file of files)kept.push(`${relativeDir}/${file}`);
   continue;
  }
  for(const file of files){
   const to=`${relativeDir}/${file}`,destination=await safeTarget(root,to,{createParents:true});
   await fs.copyFile(path.join(sourceDir,file),destination);
   added.push(to);
  }
 }
 const agentPaths=[];
 if(agentFiles)for(const [template,to] of [['AGENTS.md','AGENTS.md'],['CLAUDE.md','CLAUDE.md'],['GEMINI.md','GEMINI.md'],['cursor-rule.mdc','.cursor/rules/project-swarm.mdc']]){
  await writeAgentPointer(root,to,await fs.readFile(path.join(installRoot,'templates/agent-pointers',template),'utf8'),installRoot);
  agentPaths.push(to);
 }
 const claudeHook=agentFiles?await ensureCheckpointHook(root):null;
 const orchestratorHooks=agentFiles?await ensureOrchestratorHooks(root,installRoot):null;
 const handbuildGuard=agentFiles&&isNew?await ensureHandbuildGuard(root,installRoot,{honorRemoved:true}):null;
 const trackedHooks=agentFiles?await refreshTrackedSettingsHooks(root,installRoot):null;
 const gitignoreAdded=await ensureSwarmIgnore(root);
 return {status:'linked',root,install:installRoot,version:pkg.version,pointer:'.project-swarm.json',coordinationCreated:added.length>0,added,kept,agentFiles:agentPaths,claudeHook,orchestratorHooks,handbuildGuard,trackedHooks,gitignoreAdded};
}

if(process.argv[1]&&realpathSync(process.argv[1])===fileURLToPath(import.meta.url)){
 const argv=process.argv.slice(2);
 try{
  let result;
  if(argv[0]==='--user'){
   const flags=argv.slice(1);
   if(flags.some(flag=>flag!=='--dev'))throw Error('Usage: node tools/install.mjs --user [--dev]');
   result=await installUser({dev:flags.includes('--dev')});
  }else{
   const [target,...rest]=argv;
   if(!target||rest.some(flag=>flag!=='--no-agent-files'))throw Error('Usage: node tools/install.mjs --user [--dev] | /path/to/existing-project [--no-agent-files]');
   result=await installProject(target,{agentFiles:!rest.includes('--no-agent-files')});
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
 }catch(error){process.stderr.write(`${JSON.stringify({status:'error',error:error.message})}\n`);process.exitCode=1;}
}
