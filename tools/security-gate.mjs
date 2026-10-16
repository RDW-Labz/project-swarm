// SPDX-License-Identifier: Apache-2.0
import * as scan from './security-scan.mjs';
import * as deps from './security-deps.mjs';
import {appendFile,mkdir} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {createHash} from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

export const DEFAULT_POLICY=Object.freeze({enabled:true,minAgeDays:30,minWeeklyDownloads:100,blockSeverities:['high','critical'],allowCopyleft:false,approvedLicenses:[],allowedSecretFingerprints:[],requireVulnerabilityScan:true,codeScan:'auto',codeScanSensitive:false});
const ARR=['blockSeverities','approvedLicenses','allowedSecretFingerprints'];
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
if(r.codeScan==='auto'||r.codeScan==='off')p.codeScan=r.codeScan;
return p;
}

const base=f=>path.basename(String(f||''));
const isPkg=f=>base(f)==='package.json';
const isReq=f=>{const b=base(f);return b.startsWith('requirements')&&b.endsWith('.txt');};
const MANIFESTS=new Set(['package.json','package-lock.json','npm-shrinkwrap.json','yarn.lock','pnpm-lock.yaml','pyproject.toml','Pipfile','Pipfile.lock','go.mod','go.sum','Cargo.toml','Cargo.lock']);
const NPM_LOCKS=['package-lock.json','npm-shrinkwrap.json'];
const isDepFile=f=>MANIFESTS.has(base(f))||isReq(f);
const isText=b=>!Buffer.from(b).subarray(0,8000).includes(0);
const txt=b=>b==null?null:Buffer.from(b).toString('utf8');
const isObj=x=>!!x&&typeof x==='object';
const clean=s=>String(s??'').slice(0,120).replace(/[^A-Za-z0-9 @\/._:()+,;-]/g,'?');

const parseJson=s=>{if(typeof s!=='string')return s??null;try{return JSON.parse(s);}catch{return null;}};
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

export async function runSecurityGate({changes=[],policy,exec,fetchImpl,now=Date.now,cwd,fingerprintKey,sensitive=true,cache=new Map(),fileExists}={}){
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
const hasNpmLock=changes.some(c=>NPM_LOCKS.includes(base(c.file)))||NPM_LOCKS.some(f=>exists(path.join(cwd||'.',f)));
const all=[];let usableCount=0;
const tally=(tool,r,fn)=>{
if(!r)return;
if(!usable(r)){blocks.push({check:'vulnerability',severity:'high',message:`could not verify: ${tool} output unusable`});return;}
usableCount++;
all.push(...safeParse(fn,r.stdout,warnings));
};
if(hasNpmLock)tally('npm',await run(['npm','audit','--json','--registry=https://registry.npmjs.org/'],'npm'),scan.parseNpmAudit);
for(const c of changes.filter(c=>isReq(c.file)))tally('pip-audit',await run(['pip-audit','-f','json','--no-deps','--disable-pip','-r',c.file],'pip-audit',{env:{PATH:process.env.PATH||'',HOME:os.tmpdir()}}),scan.parsePipAudit);
tally('osv-scanner',await run(['osv-scanner','--format','json','-r','.'],'osv-scanner'),scan.parseOsv);
if(usableCount===0&&pol.requireVulnerabilityScan!==false)blocks.push({check:'vulnerability',severity:'high',message:'could not verify vulnerabilities: no scanner ran (needs a lockfile with npm, or pip-audit, or osv-scanner)'});
const scoped=newNames&&newNames.size>0?all.filter(v=>newNames.has(v.name)):all;
for(const v of scan.blockingVulns(scoped,pol.blockSeverities)||[])blocks.push({check:'vulnerability',severity:clean(v.severity),message:`${clean(v.name)} has a ${clean(v.severity)} vulnerability`});
}

const textPaths=live.filter(c=>isText(c.bytes)).map(c=>c.file).slice(0,200);
if(pol.codeScan==='auto'&&textPaths.length){
if(sensitive&&pol.codeScanSensitive!==true)skipped.push('code scan skipped: sensitive project (semgrep needs the network)');
else if(await run(['semgrep','--version'],'semgrep',{timeoutMs:30000})){
checked.push('code-scan');
const s=await run(['semgrep','--config','auto','--metrics=off','--json','--quiet','--',...textPaths],'semgrep',{timeoutMs:180000});
if(s)for(const f of safeParse(scan.parseSemgrep,s.stdout,warnings)){const sev=String(f.severity).toLowerCase();if(sev==='high'||sev==='medium')tickets.push({title:`${f.ruleId} in ${f.path}:${f.line}`,severity:sev,path:f.path,line:f.line});}
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
