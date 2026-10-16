// SPDX-License-Identifier: Apache-2.0
import {SECRET_RULES,scanSecrets,parseNpmAudit,parseOsv,parsePipAudit,blockingVulns,parseSemgrep,licenseBlocked} from './security-scan.mjs';
import {newDependencies,checkPackages} from './security-deps.mjs';
import {appendFile,mkdir} from 'node:fs/promises';
import path from 'node:path';

export const DEFAULT_POLICY=Object.freeze({enabled:true,minAgeDays:30,minWeeklyDownloads:100,blockSeverities:['high','critical'],allowCopyleft:false,approvedLicenses:[],allowedSecretFingerprints:[]});
const ARR=['blockSeverities','approvedLicenses','allowedSecretFingerprints'];
const NUM=['minAgeDays','minWeeklyDownloads'];

export function normalizePolicy(raw){
const r=raw&&typeof raw==='object'?raw:{};
const p={...DEFAULT_POLICY};
for(const k of ARR)p[k]=[...DEFAULT_POLICY[k]];
if(r.enabled===false)p.enabled=false;
for(const k of NUM)if(Number.isFinite(r[k])&&r[k]>=0)p[k]=r[k];
if(typeof r.allowCopyleft==='boolean')p.allowCopyleft=r.allowCopyleft;
for(const k of ARR)if(Array.isArray(r[k])&&r[k].every(x=>typeof x==='string'))p[k]=[...r[k]];
return p;
}

const base=f=>path.basename(f);
const isPkg=f=>base(f)==='package.json';
const isReq=f=>{const b=base(f);return b.startsWith('requirements')&&b.endsWith('.txt');};
const isText=b=>!b.subarray(0,8000).includes(0);
const txt=b=>b?b.toString('utf8'):null;

export async function runSecurityGate({changes=[],policy,exec,fetchImpl,now=Date.now,cwd}={}){
const pol=normalizePolicy(policy);
if(pol.enabled===false)return{ok:true,blocks:[],tickets:[],warnings:[],skipped:['security gate disabled by policy'],checked:[]};
const blocks=[],tickets=[],warnings=[],skipped=[],checked=[];
const live=changes.filter(c=>c.bytes!=null);

checked.push('secret-scan');
const found=(await scanSecrets(live.map(c=>({path:c.file,content:c.bytes})),{allowFingerprints:pol.allowedSecretFingerprints}))||[];
for(const f of found){const p=f.path||f.file;blocks.push({check:'secret-scan',severity:'critical',message:`possible ${f.name} in ${p}:${f.line} (fingerprint ${f.fingerprint})`,path:p,line:f.line,fingerprint:f.fingerprint});}

const run=async(argv,tool,timeoutMs=120000)=>{try{return await exec(argv,{cwd,timeoutMs});}catch{skipped.push(`${tool} not installed`);return null;}};
const parse=(fn,s)=>{try{return fn(s)||[];}catch{warnings.push('could not parse scanner output');return[];}};

const dep=changes.filter(c=>isPkg(c.file)||isReq(c.file));
if(dep.length){
checked.push('package-check','license-check');
const before={},after={};
for(const c of dep){before[c.file]=txt(c.previous);after[c.file]=txt(c.bytes);}
const news=await newDependencies({before,after});
const res=(await checkPackages(news,{fetchImpl,policy:pol,now}))||[];
for(const r of res){
if(!r.ok)blocks.push({check:'package-check',severity:'high',message:`${r.name}: ${(r.reasons||[]).join('; ')}`});
if(!r.license)warnings.push(`license unknown for ${r.name}`);
else if(licenseBlocked(r.license,{allowCopyleft:pol.allowCopyleft,approved:pol.approvedLicenses}))blocks.push({check:'license-check',severity:'high',message:`${r.name} is ${r.license}: copyleft needs the owner's approval`});
}
}

const vulnFiles=changes.some(c=>['package.json','package-lock.json','npm-shrinkwrap.json'].includes(base(c.file))||isReq(c.file));
if(vulnFiles){
checked.push('vulnerability');
const all=[];
if(changes.some(c=>base(c.file)==='package-lock.json')){const r=await run(['npm','audit','--json'],'npm',120000);if(r)all.push(...parse(parseNpmAudit,r.stdout));}
for(const c of changes.filter(c=>isReq(c.file))){const r=await run(['pip-audit','-f','json','-r',c.file],'pip-audit',120000);if(r)all.push(...parse(parsePipAudit,r.stdout));}
const o=await run(['osv-scanner','--format','json','-r','.'],'osv-scanner',120000);
if(o)all.push(...parse(parseOsv,o.stdout));
for(const v of blockingVulns(all,pol.blockSeverities)||[])blocks.push({check:'vulnerability',severity:v.severity,message:`${v.name} has a ${v.severity} vulnerability`});
}

const textPaths=live.filter(c=>isText(c.bytes)).map(c=>c.file).slice(0,200);
if(textPaths.length&&await run(['semgrep','--version'],'semgrep',30000)){
checked.push('code-scan');
const s=await run(['semgrep','--config','auto','--json','--quiet',...textPaths],'semgrep',180000);
if(s)for(const f of parse(parseSemgrep,s.stdout)){const sev=String(f.severity).toLowerCase();if(sev==='high'||sev==='medium')tickets.push({title:`${f.ruleId} in ${f.path}:${f.line}`,severity:sev,path:f.path,line:f.line,message:f.message});}
}

return{ok:blocks.length===0,blocks,tickets,warnings,skipped,checked};
}

export function formatBlocks(gate){return (gate.blocks||[]).map(b=>`${b.severity} ${b.check}: ${b.message}`).join('\n');}

export function lessonFor(gate,{runId,date}={}){
const d=date||new Date().toISOString().slice(0,10);
const bl=gate.blocks||[];
const counts={};for(const b of bl)counts[b.check]=(counts[b.check]||0)+1;
const checks=Object.keys(counts);
const summary=`${bl.length} blocks: ${checks.map(k=>`${k} x${counts[k]}`).join(', ')}`;
return{id:`security-${runId}-${d}`,date:d,stage:'merge',source:'security-gate',summary,checks,tags:[...checks,'security'],blocks:bl.map(({check,severity,path,line,fingerprint})=>({check,severity,path,line,fingerprint}))};
}

export async function recordGate({root,runId,jobs=[],gate,appendEvent,now=Date.now,fsImpl}={}){
try{
if(!gate||!(gate.blocks&&gate.blocks.length))return{recorded:false};
const date=new Date(now()).toISOString().slice(0,10);
const lesson=lessonFor(gate,{runId,date});
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
