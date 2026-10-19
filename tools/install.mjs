#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Project Swarm contributors
import fs from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import os from 'node:os';
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
async function snapshotVersion(source,version){
 const files=[...(await listFiles(path.join(source,'tools'))).map(file=>[path.join('tools',file),path.join('tools',file)]),['package.json','package.json'],...(await skillFilePairs(source)).map(([from,to])=>[from,`skills/project-swarm/${to}`])].sort(([a],[b])=>a.localeCompare(b));
 const hash=createHash('sha256');
 for(const [relative] of files){hash.update(relative);hash.update(await fs.readFile(path.join(source,relative)));}
 const versionDir=path.join(source,'versions',`${version}-${hash.digest('hex').slice(0,8)}`);
 let exists=false;
 try{exists=(await fs.stat(versionDir)).isDirectory();}catch(error){if(error.code!=='ENOENT')throw error;}
 if(!exists){
  const tmpDir=`${versionDir}.tmp-${process.pid}`;
  for(const [relative,target] of files){
   const destination=path.join(tmpDir,target);
   await fs.mkdir(path.dirname(destination),{recursive:true});
   if(target.startsWith('skills/')){
    let content=await fs.readFile(path.join(source,relative),'utf8');
    content=content.split('{{SWARM_RUNNER}}').join(path.join(source,'current/tools/swarm.mjs'));
    if(target.includes('/references/'))content=content.replace(/\]\(\.\.\/(SECURITY|CONTRIBUTING)\.md\)/g,']($1.md)').replace(/\]\(docs\//g,'](');
    await fs.writeFile(destination,content);
   }else await fs.copyFile(path.join(source,relative),destination);
  }
  await fs.rename(tmpDir,versionDir);
 }
 return versionDir;
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
export async function pruneVersions(source,{keep=5}={}){
 const versionsDir=path.join(source,'versions');
 let entries;
 try{entries=await fs.readdir(versionsDir,{withFileTypes:true});}catch(error){if(error.code==='ENOENT')return [];throw error;}
 const dirs=entries.filter(entry=>entry.isDirectory()).map(entry=>path.join(versionsDir,entry.name));
 let currentTarget=null;
 try{currentTarget=await fs.realpath(path.join(source,'current'));}catch{currentTarget=null;}
 const stats=await Promise.all(dirs.map(async dir=>({dir,mtimeMs:(await fs.stat(dir)).mtimeMs})));
 stats.sort((a,b)=>b.mtimeMs-a.mtimeMs);
 const keepSet=new Set(stats.slice(0,keep).map(entry=>entry.dir));
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
 const currentPath=await repointCurrent(source,versionDir);
 await pruneVersions(source);
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
 return {status:'installed',version:pkg.version,source,skillTargets:written,skipped,installRecord:recordPath,versionDir,runner,swarmCommand,completionFile};
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

async function ensureSwarmIgnore(root){
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

async function ensureLocalSettingsIgnored(root){
 const destination=await safeTarget(root,'.gitignore');
 const before=await readOptional(destination);
 if(before.split(/\r?\n/).some(line=>['.claude/settings.local.json','/.claude/settings.local.json'].includes(line.trim())))return;
 await fs.writeFile(destination,before+(before&&!before.endsWith('\n')?'\n':'')+'.claude/settings.local.json\n');
}

// Links one project to a shared install instead of copying the runner into it. The project
// gets a small pointer file; the install root keeps a deduped registry of linked projects.
export async function installProject(targetDirectory,{source=packageRoot,agentFiles=true}={}){
 const root=await fs.realpath(targetDirectory);
 if(!(await fs.stat(root)).isDirectory())throw Error('Target must be an existing project directory');
 const installRoot=await fs.realpath(source);
 const pkg=JSON.parse(await fs.readFile(path.join(installRoot,'package.json'),'utf8'));
 const pointer={install:installRoot,version:pkg.version};
 const pointerDestination=await safeTarget(root,'.project-swarm.json');
 await fs.writeFile(pointerDestination,`${JSON.stringify(pointer,null,2)}\n`);
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
 const gitignoreAdded=await ensureSwarmIgnore(root);
 return {status:'linked',root,install:installRoot,version:pkg.version,pointer:'.project-swarm.json',coordinationCreated:added.length>0,added,kept,agentFiles:agentPaths,claudeHook,gitignoreAdded};
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
