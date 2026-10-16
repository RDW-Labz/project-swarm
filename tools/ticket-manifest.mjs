// SPDX-License-Identifier: Apache-2.0
import * as scopeModule from './scope.mjs';
import { queryFromTicket, selectNotes, renderNotes } from './lesson-notes.mjs';
const TYPE_MAP={build:'build',migration:'build',contract:'build',test:'test',docs:'docs'};
const RULE='Work only on the files you own; report the ticket id.';

function byIdMap(list){return new Map(list.map(t=>[t.id,t]));}

function depsDone(t,byId){return (t.dependsOn||[]).every(d=>byId.get(d)?.status==='done');}

function reqLookup(scope){const m=new Map();for(const r of scope?.requirements||[])m.set(r.id,r);return m;}

function isSensitiveText(scope,text){
  if(typeof scopeModule.isSensitiveText==='function')return scopeModule.isSensitiveText(scope,text);
  const low=String(text).toLowerCase();
  return (scope?.sensitive||[]).some(s=>{const k=String(s).trim().toLowerCase();return k!==''&&low.includes(k);});
}

function sensitiveText(t,reqs){
  const parts=[t.title,t.epic,...(t.acceptance||[]),...(t.files||[])];
  for(const id of t.scopeRefs||[]){
    const r=reqs.get(id);
    if(r)parts.push(r.text,...(r.acceptance||[]));
  }
  return parts.filter(x=>x!=null).join('\n');
}

function isSensitiveJob(t,scope,reqs){
  if(!scope)return !!t.sensitive;
  return !!t.sensitive||isSensitiveText(scope,sensitiveText(t,reqs));
}

function promptFor(t,reqs,lessons){
  const lines=['Ticket '+t.id+': '+t.title];
  for(const id of t.scopeRefs||[]){
    const r=reqs.get(id);
    if(r){lines.push(id+' '+r.text);for(const a of r.acceptance||[])lines.push('  - '+a);}
    else lines.push(id+' (not found in scope)');
  }
  if((t.acceptance||[]).length){lines.push('Acceptance:');for(const a of t.acceptance)lines.push('- '+a);}
  // Notes sit after the ticket text and before the job rule, so the job rule stays last.
  if(lessons?.length){
    const reqTexts=(t.scopeRefs||[]).map(id=>reqs.get(id)).filter(Boolean).flatMap(r=>[r.text,...(r.acceptance||[])]);
    const notes=renderNotes(selectNotes(queryFromTicket(t,reqTexts),lessons));
    if(notes)lines.push(notes);
  }
  lines.push(RULE);
  return lines.join('\n');
}

export function ticketsToManifest(tickets,opts={}){
  const {ledger,scope,ready=true,contract,maxJobs,lessons}=opts;
  if(maxJobs!==undefined&&!(Number.isSafeInteger(maxJobs)&&maxJobs>0)){
    const e=new Error('maxJobs must be a positive safe integer');
    e.code='ticket-max-jobs';
    throw e;
  }
  const warnings=[],skipped=[];
  const byId=byIdMap([...(ledger?.tickets||[]),...tickets]);
  let list=ready?tickets.filter(t=>(t.status==='todo'||t.status==='ready')&&depsDone(t,byId)):tickets.slice();
  list=list.slice().sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0);
  const selected=[];
  for(const t of list){
    if(t.type==='design'){skipped.push(t.id);continue;}
    if(maxJobs&&selected.length>=maxJobs){skipped.push(t.id);warnings.push(t.id+': over maxJobs, skipped');continue;}
    selected.push(t);
  }
  const inSet=new Set(selected.map(t=>t.id));
  const reqs=reqLookup(scope);
  const jobs=selected.map(t=>{
    if(t.type==='human')return {id:t.id,type:'human',title:t.title,steps:t.steps||[]};
    const outputs=[];
    for(const f of t.files||[]){
      if(f.endsWith('/'))warnings.push(t.id+': folder output '+f+' skipped');
      else outputs.push(f);
    }
    const context=[...new Set([...(t.context||[]),...(t.contracts||[])])];
    if(contract&&!context.includes(contract))context.push(contract);
    const job={id:t.id,type:TYPE_MAP[t.type],agent:'auto',sensitive:isSensitiveJob(t,scope,reqs),prompt:promptFor(t,reqs,lessons),context,outputs,acceptance:t.acceptance||[],timeoutMs:600000};
    const deps=(t.dependsOn||[]).filter(d=>inSet.has(d));
    if(deps.length)job.after=deps;
    if(t.risk==='high')job.hard=true;
    return job;
  });
  const manifest={version:1,concurrency:maxJobs||64};
  if(contract)manifest.contract=contract;
  manifest.jobs=jobs;
  return {manifest,warnings,skipped};
}

export function ticketOutcome(state,ledger){
  const entries=Array.isArray(state)?state.map(s=>[s.id,s]):Object.entries(state||{});
  const known=new Set((ledger?.tickets||[]).map(t=>t.id));
  const moves=[];
  for(const [id,s] of entries){
    if(!known.has(id))continue;
    const st=typeof s==='string'?s:(s?.status??s?.state);
    const error=s?.error;
    if(st==='complete')moves.push({id,to:'review',note:'run complete'});
    else if(st==='failed'||st==='timeout')moves.push({id,to:'blocked',note:String(error||st)});
  }
  return moves;
}
