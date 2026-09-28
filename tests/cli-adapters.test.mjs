// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {extraCliArgs,parseExtraCli,extraCliEnvironment,extraCliDoctor} from '../tools/cli-adapters.mjs';
import {runManifest,integrateRun,summarizeRun,validateManifest} from '../tools/swarm.mjs';
const value={summary:'Generated from supplied text only.',files:[{path:'report.md',content:'Reviewed.'}]};
const job=agent=>({id:agent,agent,model:'test-model',context:['input.md'],outputs:['report.md'],prompt:'Review.',timeoutMs:1000});
const manifest=jobs=>({version:1,concurrency:2,jobs});
const events=agent=>[{type:'system',subtype:'init',model:'observed-model'},agent==='hermes'?{type:'result',exit_code:0,text:JSON.stringify(value),tokens:{input:10,output:4}}:{type:'result',subtype:'success',is_error:false,result:JSON.stringify(value),usage:{input_tokens:10,output_tokens:4}}];
const lines=items=>items.map(event=>JSON.stringify(event)).join('\n')+'\n';
for(const agent of ['hermes','qwen'])test(`${agent} fresh process consumes serialized context and returns validated files`,async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'swarm-cli-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));await fs.writeFile(path.join(root,'input.md'),'selected source');let received;
 const state=await runManifest(root,manifest([job(agent)]),{spawnImpl:(command,args,options)=>{received={command,args,options};return spawn(process.execPath,['-e',`let input='';process.stdin.on('data',data=>input+=data);process.stdin.on('end',()=>{if(!input.includes('selected source'))process.exit(7);process.stdout.write(${JSON.stringify(lines(events(agent)))});});`],options);}});
 assert.equal(state.status,'complete');const saved=await fs.readFile(path.join(root,'.swarm/runs',state.id,agent,'message.txt'),'utf8');assert.ok(saved.includes('selected source'));assert.ok(saved.includes('schema'));assert.ok(!saved.includes('Never inspect parent'));assert.equal(received.command,agent);assert.equal(received.options.shell,false);assert.ok(received.args.includes('--safe-mode'));assert.equal(state.jobs[0].actualModel,'observed-model');await assert.rejects(fs.access(path.join(root,'report.md')));await integrateRun(root,state.id);assert.equal(await fs.readFile(path.join(root,'report.md'),'utf8'),'Reviewed.');assert.equal(state.summary.counts.complete,1);assert.ok(state.jobs[0].durationMs>=0);assert.ok(state.jobs[0].startedAt);
});
test('CLI arguments keep no-tools restrictions and avoid resume, yolo, shell and schema exemptions',()=>{
 const qwen=extraCliArgs(job('qwen'));assert.equal(qwen[qwen.indexOf('--max-tool-calls')+1],'0');assert.equal(qwen.includes('--json-schema'),false);assert.equal(qwen.includes('--resume'),false);assert.equal(qwen.includes('--yolo'),false);
 const hermes=extraCliArgs(job('hermes'));assert.equal(hermes[hermes.indexOf('--toolsets')+1],'none');assert.equal(hermes[hermes.indexOf('--query-file')+1],'-');assert.ok(hermes.includes('--ignore-rules'));
});
test('parseExtraCli derives actualModel from assistant events (not just init) and flags a mismatch against the requested model',()=>{
 const withAssistant=agent=>[
  {type:'system',subtype:'init',model:'claude-haiku-4-5-20251001'},
  {type:'assistant',message:{model:'claude-sonnet-5-20260101',content:[]}},
  agent==='hermes'?{type:'result',exit_code:0,text:JSON.stringify(value)}:{type:'result',subtype:'success',is_error:false,result:JSON.stringify(value)},
 ];
 for(const agent of ['hermes','qwen']){
  const parsed=parseExtraCli(agent,lines(withAssistant(agent)),0,'haiku');
  assert.equal(parsed.actualModel,'claude-sonnet-5-20260101');
  assert.deepEqual(parsed.modelsSeen,['claude-haiku-4-5-20251001','claude-sonnet-5-20260101']);
  assert.equal(parsed.modelMismatch,true);
 }
});
test('parseExtraCli reports no mismatch for a matching model, and a short alias matches any id containing it',()=>{
 const matching=agent=>[
  {type:'system',subtype:'init',model:'claude-haiku-4-5-20251001'},
  {type:'assistant',message:{model:'claude-haiku-4-5-20251001',content:[]}},
  agent==='hermes'?{type:'result',exit_code:0,text:JSON.stringify(value)}:{type:'result',subtype:'success',is_error:false,result:JSON.stringify(value)},
 ];
 for(const agent of ['hermes','qwen']){
  const parsed=parseExtraCli(agent,lines(matching(agent)),0,'haiku');
  assert.equal(parsed.actualModel,'claude-haiku-4-5-20251001');
  assert.equal(parsed.modelMismatch,false);
 }
});
test('CLI result parser fails closed on tools, duplicate/missing results, nonzero exit and malformed output',()=>{
 for(const agent of ['hermes','qwen']){const good=events(agent);assert.equal(parseExtraCli(agent,lines(good),0).actualModel,'observed-model');for(const bad of [[...good,good.at(-1)],[good[0]],[good[0],{type:'tool_use',name:'shell'},good[1]],[good[0],{type:'assistant',message:{content:[{type:'tool_use',name:'agent'}]}},good[1]]])assert.throws(()=>parseExtraCli(agent,lines(bad),0));assert.throws(()=>parseExtraCli(agent,'not json',0));assert.throws(()=>parseExtraCli(agent,lines(good),3));}
 assert.throws(()=>parseExtraCli('hermes',lines([{type:'result',exit_code:1,text:'x'}]),0));assert.throws(()=>parseExtraCli('qwen',lines([{type:'result',subtype:'success',is_error:true,result:'x'}]),0));
});
test('compatibility rejects missing restrictions and never treats help as live authentication',async()=>{
 for(const agent of ['hermes','qwen']){await assert.rejects(extraCliDoctor(agent,async()=>({stdout:'old CLI'})),/restriction/);const result=await extraCliDoctor(agent,async(_command,args)=>({stdout:args.includes('--version')?'test-version':extraCliArgs(job(agent)).join(' ')}));assert.equal(result.status,'compatible');assert.equal(result.liveVerified,false);}
 assert.equal(extraCliEnvironment('hermes',{HERMES_KANBAN_TASK:'other-task',PATH:'safe'}).HERMES_KANBAN_TASK,undefined);assert.equal(extraCliEnvironment('qwen',{QWEN_SYSTEM_MD:'evil',QWEN_CODE_UNATTENDED_RETRY:'true',PATH:'safe'}).QWEN_SYSTEM_MD,undefined);
});
test('extraCliDoctor retries a truncated help read once and accepts a complete second read',async()=>{
 for(const agent of ['hermes','qwen']){
  const full=extraCliArgs(job(agent)).join(' ');let helpCalls=0;
  const result=await extraCliDoctor(agent,async(_command,args)=>{if(args.includes('--version'))return {stdout:'test-version'};helpCalls++;return {stdout:helpCalls===1?full.slice(0,Math.floor(full.length/2)):full};});
  assert.equal(helpCalls,2);assert.equal(result.status,'compatible');
 }
});
test('extraCliDoctor reports a probe failure, not a flags failure, when help output stays empty after retry',async()=>{
 for(const agent of ['hermes','qwen']){
  let helpCalls=0;
  await assert.rejects(extraCliDoctor(agent,async(_command,args)=>{if(args.includes('--version'))return {stdout:'test-version'};helpCalls++;return {stdout:''};}),new RegExp(`${agent} help probe failed \\(no or empty output\\)`));
  assert.equal(helpCalls,2);
 }
});
test('extraCliDoctor still reports missing flags when help output is complete both times',async()=>{
 for(const agent of ['hermes','qwen']){
  const missingOneFlag=extraCliArgs(job(agent)).filter(token=>token!=='--safe-mode').join(' ');let helpCalls=0;
  await assert.rejects(extraCliDoctor(agent,async(_command,args)=>{if(args.includes('--version'))return {stdout:'test-version'};helpCalls++;return {stdout:missingOneFlag};}),/restriction/);
  assert.equal(helpCalls,2);
 }
});
test('monitor reports real queue states, elapsed durations and numeric provider usage',()=>{
 const state={id:'x',status:'running',startedAt:new Date(1000).toISOString(),concurrency:4,peakConcurrency:2,jobs:[{id:'a',agent:'qwen',status:'complete',startedAt:new Date(1000).toISOString(),finishedAt:new Date(1200).toISOString(),durationMs:200,usage:{input_tokens:10,ignore:'private'}},{id:'b',agent:'hermes',status:'running',startedAt:new Date(1500).toISOString()},{id:'c',agent:'claude',status:'queued'}]};
 const report=summarizeRun(state,2000);assert.deepEqual(report.counts,{queued:1,running:1,complete:1,failed:0,timeout:0,cancelled:0,skipped:0});assert.equal(report.peakConcurrency,2);assert.equal(report.jobs[1].durationMs,500);assert.equal(report.jobs[2].durationMs,null);assert.deepEqual(report.usageByProvider.qwen,{input_tokens:10});
});
test('larger scheduler limits remain explicit and reject excessive workers/jobs',()=>{const jobs=Array.from({length:256},(_,i)=>({...job('qwen'),id:`job-${i}`,outputs:[]}));assert.equal(validateManifest({version:1,concurrency:32,jobs}).jobs.length,256);assert.throws(()=>validateManifest({version:1,concurrency:33,jobs}));assert.throws(()=>validateManifest({version:1,concurrency:2,jobs:[...jobs,{...job('qwen'),id:'last'}]}));});

test('both new CLI adapters time out owned children and never expose partial files',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'swarm-cli-timeout-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));await fs.writeFile(path.join(root,'input.md'),'source');
 for(const agent of ['hermes','qwen']){let closed=false;const state=await runManifest(root,manifest([{...job(agent),timeoutMs:50}]),{spawnImpl:(_command,_args,options)=>{const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],options);child.on('close',()=>closed=true);return child;}});assert.equal(state.jobs[0].status,'timeout');assert.equal(closed,true);await assert.rejects(integrateRun(root,state.id));}
});
test('#67: eight active jobs drain a larger queue with consistent observed counts',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'swarm-eight-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));await fs.writeFile(path.join(root,'input.md'),'source');let active=0,peak=0;const snapshots=[];
 // Field lesson #182: a fixed 80ms delay before each fake worker "finishes" was flaky under a
 // loaded host (4x parallel npm test): if 8 real child processes take longer than 80ms to spawn,
 // the earliest ones can exit and free a slot before the 8th ever starts, so peak concurrency is
 // never actually observed at 8. Each child instead waits (bounded, polling every 5ms) until at
 // least 8 siblings have started — an event-driven barrier proving true 8-way concurrency really
 // happened, instead of hoping a fixed sleep outlasted the host's own scheduling latency.
 const markers=await fs.mkdtemp(path.join(os.tmpdir(),'swarm-eight-markers-'));t.after(()=>fs.rm(markers,{recursive:true,force:true}));
 const jobs=Array.from({length:24},(_,i)=>({...job('qwen'),id:`qwen-${i}`,outputs:[],timeoutMs:5000}));const emptyEvents=events('qwen');emptyEvents[1].result=JSON.stringify({summary:'done',files:[]});
 const script=`const fs=require('node:fs');const path=require('node:path');const dir=${JSON.stringify(markers)};fs.writeFileSync(path.join(dir,process.pid+'-'+Math.random().toString(36).slice(2)),'');const deadline=Date.now()+4000;(function poll(){let count=0;try{count=fs.readdirSync(dir).length;}catch{}if(count>=8||Date.now()>=deadline)process.stdout.write(${JSON.stringify(lines(emptyEvents))});else setTimeout(poll,5);})();`;
 const state=await runManifest(root,{version:1,concurrency:8,jobs},{onState:state=>snapshots.push(structuredClone(state.summary)),spawnImpl:(_command,_args,options)=>{active++;peak=Math.max(peak,active);const child=spawn(process.execPath,['-e',script],options);child.on('close',()=>active--);return child;}});
 assert.equal(state.status,'complete');assert.equal(peak,8);assert.equal(state.peakConcurrency,8);assert.equal(active,0);assert.equal(state.summary.counts.complete,24);assert.ok(snapshots.some(s=>s.counts.running===8&&s.counts.queued>0));for(const snapshot of snapshots)assert.equal(Object.values(snapshot.counts).reduce((a,b)=>a+b,0),24);
});
