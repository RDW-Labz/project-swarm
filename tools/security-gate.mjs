// SPDX-License-Identifier: Apache-2.0
import * as scan from './security-scan.mjs';
import * as deps from './security-deps.mjs';
import {appendFile,mkdir} from 'node:fs/promises';
import {existsSync,readFileSync,mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {createHash} from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

export const SEMGREP_RULES_SHA256='3ad961b22a3ac752a1ba8815a4ea234feb8b605ede0a4026397ad31cc5e07da2';
export const SEMGREP_RULES_PATH=fileURLToPath(new URL('./security-rules/semgrep-local.yml',import.meta.url));
export const UNPARSED_MANIFESTS=Object.freeze({'pnpm-lock.yaml':'pnpm','pnpm-workspace.yaml':'pnpm','yarn.lock':'yarn','.yarnrc.yml':'yarn','go.mod':'go','go.sum':'go','go.work':'go','cargo.toml':'cargo','cargo.lock':'cargo','pyproject.toml':'python','pipfile':'python','pipfile.lock':'python','poetry.lock':'python','setup.py':'python','uv.lock':'python','setup.cfg':'python','composer.json':'php','composer.lock':'php','gemfile':'ruby','gemfile.lock':'ruby','pom.xml':'jvm','build.gradle':'jvm','build.gradle.kts':'jvm','gradle-wrapper.properties':'jvm','gradle.lockfile':'jvm','settings.gradle':'jvm','settings.gradle.kts':'jvm','.npmrc':'node','.yarnrc':'node','.pnpmfile.cjs':'node','bun.lock':'bun','bun.lockb':'bun','environment.yml':'conda','package.swift':'swift','podfile':'cocoapods','podfile.lock':'cocoapods','pubspec.yaml':'dart','pubspec.lock':'dart','mix.exs':'elixir','mix.lock':'elixir','packages.config':'dotnet','.gitmodules':'git submodules'});

export const DEFAULT_POLICY=Object.freeze({enabled:true,minAgeDays:30,minWeeklyDownloads:100,blockSeverities:['high','critical'],allowCopyleft:false,approvedLicenses:[],allowedSecretFingerprints:[],allowUnparsedManifests:[],acceptedAdvisories:[],requireVulnerabilityScan:true,codeScan:'local',codeScanSensitive:false});
const ARR=['blockSeverities','approvedLicenses','allowedSecretFingerprints','allowUnparsedManifests'];
const NUM=['minAgeDays','minWeeklyDownloads'];
const BOOL=['allowCopyleft','requireVulnerabilityScan','codeScanSensitive'];

export function normalizePolicy(raw){
const r=raw&&typeof raw==='object'?raw:{};
const p={...DEFAULT_POLICY};
for(const k of ARR)p[k]=[...DEFAULT_POLICY[k]];
if(r.enabled===false)p.enabled=false;
for(const k of NUM)if(Number.isFinite(r[k])&&r[k]>=0)p[k]=r[k];
for(const k of BOOL)if(typeof r[k]==='boolean')p[k]=r[k];
for(const k of ARR)if(Array.isArray(r[k])&&r[k].every(x=>typeof x==='string'))p[k]=[...r[k]];
if(r.codeScan==='auto'||r.codeScan==='off'||r.codeScan==='local')p.codeScan=r.codeScan;
// Accepted advisories: { package, id?, reason, reviewBy: YYYY-MM-DD }. Malformed entries are dropped (the block stays).
const realDate=d=>typeof d==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(d)&&Number.isFinite(Date.parse(d+'T00:00:00Z'))&&new Date(d+'T00:00:00Z').toISOString().slice(0,10)===d;
p.acceptedAdvisories=Array.isArray(r.acceptedAdvisories)?r.acceptedAdvisories.filter(a=>a&&typeof a.package==='string'&&a.package&&(a.id===undefined||(typeof a.id==='string'&&a.id.length>0&&a.id.length<=60))&&typeof a.reason==='string'&&a.reason.length>=5&&a.reason.length<=300&&realDate(a.reviewBy)).slice(0,50).map(a=>({package:a.package,...(a.id!==undefined?{id:a.id}:{}),reason:a.reason,reviewBy:a.reviewBy})):[];
return p;
}

const base=f=>path.basename(String(f||''));
const lbase=f=>base(f).toLowerCase();
const normPath=f=>String(f||'').replace(/^\.\//,'').toLowerCase();
const POLICY_FILE='.project-swarm.json';
const isPkg=f=>lbase(f)==='package.json';
const isReq=f=>{const b=lbase(f);return b.startsWith('requirements')&&b.endsWith('.txt');};
const MANIFESTS=new Set(['package.json','package-lock.json','npm-shrinkwrap.json','yarn.lock','pnpm-lock.yaml','pyproject.toml','pipfile','pipfile.lock','go.mod','go.sum','cargo.toml','cargo.lock']);
const NPM_LOCKS=['package-lock.json','npm-shrinkwrap.json'];
const isDepFile=f=>MANIFESTS.has(lbase(f))||isReq(f);
const isText=b=>!Buffer.from(b).subarray(0,8000).includes(0);
const txt=b=>b==null?null:Buffer.from(b).toString('utf8');
const isObj=x=>!!x&&typeof x==='object';
const clean=s=>String(s??'').slice(0,120).replace(/[^A-Za-z0-9 @\\/._:()+,;-]/g,'?');

// The part of a package.json that decides what gets installed, or null when any spec is not a registry range (or the file is not JSON).
const NON_REGISTRY=/^(?:git(?:\+[a-z]+)?:|github:|gitlab:|bitbucket:|https?:|file:|link:|workspace:|portal:|patch:|ssh:|[\w.-]+\/[\w.-]+$)/i;
function lockableManifest(text){
let j;try{j=JSON.parse(text);}catch{return null;}
if(!isObj(j))return null;
const keep={};
for(const k of ['name','version'])if(typeof j[k]==='string')keep[k]=j[k];
const clean=v=>typeof v==='string'?!NON_REGISTRY.test(v.trim()):isObj(v)?Object.values(v).every(clean):false;
for(const k of ['dependencies','devDependencies','optionalDependencies','overrides']){
if(j[k]===undefined)continue;
if(!isObj(j[k])||!clean(j[k]))return null;
keep[k]=j[k];
}
return keep;
}

const LIFECYCLE=['preinstall','install','postinstall','prepare','prepublish','prepublishOnly','prepack','postpack','preuninstall','uninstall','postuninstall'];

export function unparsedEcosystem(file){
const lp=normPath(file);
const b=path.posix.basename(lp);
if(Object.hasOwn(UNPARSED_MANIFESTS,b))return UNPARSED_MANIFESTS[b];
if(lp.startsWith('.github/workflows/'))return 'ci workflow';
if(lp.startsWith('vendor/')||lp.startsWith('third_party/')||lp.includes('/vendor/')||lp.includes('/third_party/'))return 'vendored code';
if(/\.(csproj|fsproj|vbproj)$/.test(lp))return 'dotnet';
if(lp.endsWith('.gemspec'))return 'ruby';
const parent=lp.split('/').slice(0,-1).pop();
if(parent==='requirements'&&(b.endsWith('.txt')||b.endsWith('.in')))return 'python';
if(b.startsWith('requirements')&&b.endsWith('.in'))return 'python';
if(b.startsWith('constraints')&&b.endsWith('.txt'))return 'python';
return null;
}

const allowedUnparsed=(file,list)=>{const p=normPath(file);return (list||[]).some(e=>typeof e==='string'&&normPath(e)===p);};

const parseJson=s=>{if(typeof s!=='string')return s??null;try{return JSON.parse(s);}catch{return null;}};
const readJson=b=>{if(b==null)return {ok:true,value:{}};try{return {ok:true,value:JSON.parse(txt(b))};}catch{return {ok:false,value:undefined};}};
const GUARDED=['security','sensitive','verify','context','ci','approval','protectedPaths'];
const profileOf=v=>Object.fromEntries(GUARDED.map(k=>[k,v?.profile?.[k]]));
const scriptsOf=b=>{const j=readJson(b);const s=j.ok?j.value?.scripts:undefined;return isObj(s)?s:{};};
const hasList=j=>Array.isArray(j)||isObj(j?.vulnerabilities)||Array.isArray(j?.results)||Array.isArray(j?.dependencies)||isObj(j?.advisories);
function usable(r){
if(!r)return false;
const j=parseJson(r.stdout);
if(!isObj(j))return false;
if(!Array.isArray(j)&&'error' in j)return false;
if(r.exitCode==null||r.exitCode>1)return hasList(j);
return true;
}
const safeParse=(fn,s,warnings)=>{try{return (typeof fn==='function'?fn(s):[])||[];}catch{warnings.push('could not parse scanner output');return [];}};

export async function runSecurityGate({changes=[],policy,hookScripts=[],exec,fetchImpl,now=Date.now,cwd,fingerprintKey,sensitive=true,cache=new Map(),fileExists,readRules=()=>readFileSync(SEMGREP_RULES_PATH)}={}){
const pol=normalizePolicy(policy);
if(pol.enabled===false)return{ok:true,blocks:[],tickets:[],warnings:[],skipped:['security gate disabled by policy'],checked:[]};
const blocks=[],tickets=[],warnings=[],skipped=[],checked=[];
const live=changes.filter(c=>c&&c.bytes!=null);
const run=async(argv,tool,opts={})=>{try{return await exec(argv,{cwd,timeoutMs:120000,...opts});}catch{skipped.push(`${tool} not installed`);return null;}};

checked.push('secret-scan');
const previous=Object.fromEntries(changes.map(c=>[c.file,c.previous??null]));
const secretFn=typeof scan.scanSecretsDetailed==='function'?scan.scanSecretsDetailed:async(files,o)=>({findings:scan.scanSecrets(files,o)||[],skipped:[]});
const sr=(await secretFn(live.map(c=>({path:c.file,content:c.bytes})),{allowFingerprints:pol.allowedSecretFingerprints,previous,key:fingerprintKey}))||{};
for(const f of sr.findings||[]){const p=f.path||f.file;blocks.push({check:'secret-scan',severity:'critical',message:`possible ${f.name} in ${p}:${f.line} (fingerprint ${f.fingerprint})`,path:p,line:f.line,fingerprint:f.fingerprint});}
for(const s of sr.skipped||[]){
if(s&&typeof s==='object'&&s.reason==='too large to scan'){const p=s.path||s.file;blocks.push({check:'secret-scan',severity:'high',message:`${p} is too large to scan`});}
else if(typeof s==='string')skipped.push(s);
else if(s)skipped.push(`${s.path||s.file}: ${s.reason}`);
}

const depChanges=changes.filter(c=>isPkg(c.file)||isReq(c.file));
let newNames=null;
if(depChanges.length){
checked.push('package-check','license-check');
const before={},after={};
for(const c of depChanges){before[c.file]=txt(c.previous);after[c.file]=txt(c.bytes);}
const raw=await deps.newDependencies({before,after});
const news=Array.isArray(raw)?raw:Object.values(raw||{}).flat();
newNames=new Set(news.map(d=>d.name));
const res=(await deps.checkPackages(news,{fetchImpl,policy:pol,now,cache}))||[];
for(const r of res){
const name=clean(r.name);
if(!r.ok)blocks.push({check:'package-check',severity:'high',message:`${name}: ${clean((r.reasons||[]).join('; '))}`});
if(!r.license)warnings.push(`license unknown for ${name}`);
else if(scan.licenseBlocked(r.license,{allowCopyleft:pol.allowCopyleft,approved:pol.approvedLicenses}))blocks.push({check:'license-check',severity:'high',message:`${name} is ${clean(r.license)}: copyleft needs the owner's approval`});
}
}

if(changes.some(c=>isDepFile(c.file))){
checked.push('vulnerability');
const exists=typeof fileExists==='function'?fileExists:(p=>existsSync(p));
const hasNpmLock=changes.some(c=>NPM_LOCKS.includes(lbase(c.file)))||NPM_LOCKS.some(f=>exists(path.join(cwd||'.',f)));
const all=[];let usableCount=0;
const tally=(tool,r,fn)=>{
if(!r)return;
if(!usable(r)){blocks.push({check:'vulnerability',severity:'high',message:`could not verify: ${tool} output unusable`});return;}
usableCount++;
all.push(...safeParse(fn,r.stdout,warnings));
};
if(hasNpmLock)tally('npm',await run(['npm','audit','--json','--registry=https://registry.npmjs.org/'],'npm'),scan.parseNpmAudit);
else if(pol.requireVulnerabilityScan!==false){
// package.json changed with no lockfile (a scaffold ticket): build a lockfile from that package.json alone in a temporary folder
// (nothing is installed, no script runs) and audit it, so the batch is not refused with "no scanner ran".
const pj=changes.find(c=>c.file==='package.json'&&c.bytes!=null);
if(pj){
let tmp=null;
try{
// Only registry dependency specs go into the temporary package.json (a git, http, file, link or workspace spec could make npm contact other hosts or read other folders).
const lock=lockableManifest(txt(pj.bytes));
if(!lock){warnings.push('package.json has non-registry dependency specs or is not valid JSON: no lockfile was built to audit it');}
else{
tmp=mkdtempSync(path.join(os.tmpdir(),'swarm-audit-'));
writeFileSync(path.join(tmp,'package.json'),JSON.stringify(lock));
writeFileSync(path.join(tmp,'empty-user.npmrc'),'');
writeFileSync(path.join(tmp,'empty-global.npmrc'),'');
// No owner credentials: empty npm config files, no git config or prompts, no ssh, no scripts, HOME inside the temp folder.
const cleanEnv={PATH:process.env.PATH||'',HOME:tmp,npm_config_userconfig:path.join(tmp,'empty-user.npmrc'),npm_config_globalconfig:path.join(tmp,'empty-global.npmrc'),npm_config_ignore_scripts:'true',npm_config_update_notifier:'false',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_TERMINAL_PROMPT:'0',GIT_SSH_COMMAND:'false'};
const made=await run(['npm','install','--package-lock-only','--ignore-scripts','--no-audit','--no-fund','--registry=https://registry.npmjs.org/'],'npm-lock',{cwd:tmp,env:cleanEnv});
if(made&&made.exitCode===0){
const audited=await run(['npm','audit','--json','--registry=https://registry.npmjs.org/'],'npm',{cwd:tmp,env:cleanEnv});
// An unusable answer here is a warning, not a block: another scanner (osv-scanner) may still cover the batch, and "no scanner ran" blocks when none did.
if(audited&&usable(audited)){usableCount++;all.push(...safeParse(scan.parseNpmAudit,audited.stdout,warnings));}
else warnings.push('npm audit of the lockfile built from package.json gave no usable result');
}
else if(made)warnings.push('could not build a lockfile from package.json to audit it');
}
}finally{if(tmp)try{rmSync(tmp,{recursive:true,force:true});}catch{/* best effort */}}
}
}
for(const c of changes.filter(c=>isReq(c.file)))tally('pip-audit',await run(['pip-audit','-f','json','--no-deps','--disable-pip','-r',c.file],'pip-audit',{env:{PATH:process.env.PATH||'',HOME:os.tmpdir()}}),scan.parsePipAudit);
tally('osv-scanner',await run(['osv-scanner','--format','json','-r','.'],'osv-scanner'),scan.parseOsv);
if(usableCount===0&&pol.requireVulnerabilityScan!==false)blocks.push({check:'vulnerability',severity:'high',message:'could not verify vulnerabilities: no scanner ran (needs a lockfile with npm, or pip-audit, or osv-scanner)'});
const scoped=newNames&&newNames.size>0?all.filter(v=>newNames.has(v.name)):all;
const today=new Date(now()).toISOString().slice(0,10);
for(const v of scan.blockingVulns(scoped,pol.blockSeverities)||[]){
// npm audit lists one entry per package, combining its advisories: an id-specific exception counts only when it covers every id of the
// entry; an entry with no ids needs a package-wide exception (no id), which is the owner's explicit, broader choice.
const mine=pol.acceptedAdvisories.filter(a=>a.package===v.name);
const live=mine.filter(a=>today<=a.reviewBy),stale=mine.filter(a=>today>a.reviewBy);
const ids=Array.isArray(v.ids)&&v.ids.length?v.ids:(v.id?[v.id]:[]);
const uncovered=ids.filter(id=>!live.some(a=>a.id===id));
const covered=live.some(a=>!a.id)||(ids.length>0&&uncovered.length===0);
if(covered){const ex=live.find(a=>!a.id)||live.find(a=>a.id===ids[0]);warnings.push(`accepted advisory: ${clean(v.name)} (${clean(ex.reason)}; review by ${ex.reviewBy})`);continue;}
blocks.push({check:'vulnerability',severity:clean(v.severity),message:`${clean(v.name)} has a ${clean(v.severity)} vulnerability${stale.length?`; exception expired on ${stale[0].reviewBy}`:''}${live.length&&uncovered.length?`; not covered by an exception: ${uncovered.map(clean).join(', ')}`:''}`});
}
}

const unparsed=changes.map(c=>({c,eco:unparsedEcosystem(c.file)})).filter(x=>x.eco);
if(unparsed.length)checked.push('unsupported-manifest');
for(const {c,eco} of unparsed){if(allowedUnparsed(c.file,pol.allowUnparsedManifests))continue;blocks.push({check:'unsupported-manifest',severity:'high',message:`${c.file} changed: ${eco} dependencies are not parsed yet; the owner must review it, ${/^[A-Za-z0-9_@+.\/-]+$/.test(c.file)?`then rerun integrate with --approve-manifest ${c.file}`:'then approve it by hand'}`});}

const policyFiles=changes.filter(c=>normPath(c.file)===POLICY_FILE);
if(policyFiles.length)checked.push('policy-change');
for(const c of policyFiles){
const prev=readJson(c.previous),next=readJson(c.bytes);
const p=profileOf(prev.ok?prev.value:undefined),n=profileOf(next.value);
const differs=GUARDED.some(k=>JSON.stringify(p[k])!==JSON.stringify(n[k]));
if(!next.ok||differs)blocks.push({check:'policy-change',severity:'critical',message:'.project-swarm.json changes the security policy, sensitivity, verify, context, ci, approval or protected paths: the owner must make this change by hand'});
}

const pkgChanges=changes.filter(c=>isPkg(c.file));
if(pkgChanges.length)checked.push('install-script');
// A package.json script that a profile hook (verify or ci) runs is the owner's: a batch cannot change what runs with the owner's rights.
for(const c of pkgChanges){
if(!hookScripts.length)break;
const before=scriptsOf(c.previous),after=scriptsOf(c.bytes);
for(const k of hookScripts)if(JSON.stringify(before[k])!==JSON.stringify(after[k]))blocks.push({check:'hook-script-change',severity:'critical',message:`${c.file}: the script ${clean(k)} is run by a profile hook (verify or ci); the owner must change it by hand`});
}
for(const c of pkgChanges){
const before=scriptsOf(c.previous),after=scriptsOf(c.bytes);
for(const k of LIFECYCLE){const nv=after[k];if(nv==null)continue;if(JSON.stringify(nv)!==JSON.stringify(before[k]))blocks.push({check:'install-script',severity:'high',message:`${c.file}: lifecycle script ${k} changed; the owner must review it`});}
}

const textTotal=live.filter(c=>isText(c.bytes)).length;
const textLive=live.filter(c=>isText(c.bytes)).slice(0,200);
const textPaths=textLive.map(c=>c.file);
if(textTotal>200)warnings.push(`code scan covered the first 200 of ${textTotal} files`);
const takeSemgrep=s=>{for(const f of safeParse(scan.parseSemgrep,s.stdout,warnings)){const sev=String(f.severity).toLowerCase();if(sev==='high'||sev==='medium')tickets.push({title:`${f.ruleId} in ${f.path}:${f.line}`,severity:sev,path:f.path,line:f.line});}};
if(pol.codeScan==='off')skipped.push('code scan disabled by policy');
else if(textPaths.length){
let mode=pol.codeScan;
if(mode==='auto'&&sensitive&&pol.codeScanSensitive!==true){mode='local';warnings.push('code scan: auto needs the network, using the pinned local rules');}
if(mode==='local'){
let rulesBytes=null,rulesOk=false;
try{rulesBytes=await readRules();rulesOk=createHash('sha256').update(rulesBytes).digest('hex')===SEMGREP_RULES_SHA256;}catch{rulesOk=false;}
if(!rulesOk){checked.push('code-scan');blocks.push({check:'code-scan',severity:'high',message:'pinned semgrep rules changed or unreadable (hash mismatch)'});}
else{
let tmp=null;
try{tmp=mkdtempSync(path.join(os.tmpdir(),'swarm-scan-'));}catch{tmp=null;}
if(!tmp){checked.push('code-scan');blocks.push({check:'code-scan',severity:'high',message:'could not prepare the isolated code scan'});}
else{
try{
const scanDir=path.join(tmp,'scan'),home=path.join(tmp,'home'),rulesFile=path.join(tmp,'rules.yml');
mkdirSync(scanDir,{recursive:true});
mkdirSync(home,{recursive:true});
writeFileSync(rulesFile,rulesBytes,{mode:0o600});
const env={PATH:process.env.PATH,HOME:home,SEMGREP_SEND_METRICS:'off',SEMGREP_ENABLE_VERSION_CHECK:'0'};
const copied=[];
for(const c of textLive){
const rel=String(c.file||'');
if(!rel||path.isAbsolute(rel)||rel.split(/[\\/]+/).includes('..'))continue;
const dest=path.join(scanDir,rel);
mkdirSync(path.dirname(dest),{recursive:true});
writeFileSync(dest,Buffer.from(c.bytes));
copied.push(rel);
}
const probe=await run(['semgrep','--version'],'semgrep',{timeoutMs:30000,cwd:scanDir,env});
if(probe){
checked.push('code-scan');
if(copied.length){
const s=await run(['semgrep','--config',rulesFile,'--metrics=off','--disable-version-check','--json','--quiet','--',...copied],'semgrep',{timeoutMs:180000,cwd:scanDir,env});
if(s)takeSemgrep(s);
}
}
}catch{
checked.push('code-scan');
blocks.push({check:'code-scan',severity:'high',message:'could not prepare the isolated code scan'});
}finally{
try{rmSync(tmp,{recursive:true,force:true});}catch{}
}
}
}
}
else if(await run(['semgrep','--version'],'semgrep',{timeoutMs:30000})){
checked.push('code-scan');
const s=await run(['semgrep','--config','auto','--metrics=off','--json','--quiet','--',...textPaths],'semgrep',{timeoutMs:180000});
if(s)takeSemgrep(s);
}
}

return{ok:blocks.length===0,blocks,tickets,warnings,skipped,checked};
}

export function formatBlocks(gate){return (gate.blocks||[]).map(b=>`${b.severity} ${b.check}: ${b.message}`).join('\n');}

export function lessonFor(gate,{runId,date,jobs}={}){
const d=date||new Date().toISOString().slice(0,10);
const bl=gate.blocks||[];
const counts={};for(const b of bl)counts[b.check]=(counts[b.check]||0)+1;
const checks=Object.keys(counts);
const summary=`${bl.length} blocks: ${checks.map(k=>`${k} x${counts[k]}`).join(', ')}`;
const key=[...(jobs||[]).map(String).sort(),...checks.slice().sort()].join('|');
const h=createHash('sha256').update(key).digest('hex').slice(0,8);
return{id:`security-${runId}-${h}-${d.replace(/\D/g,'')}`,date:d,stage:'merge',source:'security-gate',summary,checks,tags:[...checks,'security'],blocks:bl.map(({check,severity,path,line,fingerprint})=>({check,severity,path,line,fingerprint}))};
}

export async function recordGate({root,runId,jobs=[],gate,appendEvent,now=Date.now,fsImpl}={}){
try{
if(!gate||!(gate.blocks&&gate.blocks.length))return{recorded:false};
const date=new Date(now()).toISOString().slice(0,10);
const lesson=lessonFor(gate,{runId,date,jobs});
const dir=path.join(root,'.swarm','project');
const mk=fsImpl?.mkdir??mkdir;
const ap=fsImpl?.appendFile??appendFile;
await mk(dir,{recursive:true});
await ap(path.join(dir,'security-lessons.ndjson'),JSON.stringify(lesson)+'\n',{mode:0o600});
const jl=jobs.join('+').slice(0,60).replace(/[^A-Za-z0-9._-]/g,'_');
const id='security-'+runId+'-'+jl;
await appendEvent(root,{kind:'blocker',id,text:('Security gate blocked '+jobs.join(', ')+': '+formatBlocks(gate)).slice(0,600)});
return{recorded:true,lessonId:lesson.id};
}catch(error){return{recorded:false,error:String(error&&error.message||error)};}
}
