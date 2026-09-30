import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { runManifest, integrateRun, cancelRun, readState, validateManifest, validateProject, claudeArgs, shipRun, shipExitCode, parseShipFlags, waitRun, inspectRun, inspectResults, askRun, defaultRoot, parseGoFlags } from '../tools/swarm.mjs';

const execFileAsync = promisify(execFile);
const CLI = fileURLToPath(new URL('../tools/swarm.mjs', import.meta.url));

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'project-swarm-test-'));
  await fs.writeFile(path.join(root, 'input.txt'), 'original');
  await fs.writeFile(path.join(root, 'private.txt'), 'never copied');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

const job = (overrides = {}) => ({ id: 'writer', agent: 'claude', model: 'sonnet', prompt: 'Update the assigned file.', context: ['input.txt'], outputs: ['input.txt'], timeoutMs: 5000, ...overrides });
const manifest = jobs => ({ version: 1, concurrency: 2, jobs: jobs ?? [job()] });

// Only tests inject a provider. The production Claude adapter spawns the literal claude command.
function fake(script) {
  return (_command, _args, options) => spawn(process.execPath, ['--input-type=module', '-e', `import fs from 'node:fs';\n${script}`], options);
}
const done = `console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,result:'Worker complete'}));`;
const update = fake(`fs.writeFileSync('input.txt','updated'); ${done}`);

test('copies explicit context only, persists messages, and integrates assigned output', async t => {
  const root = await fixture(t);
  const state = await runManifest(root, manifest(), { spawnImpl: fake(`if(fs.existsSync('private.txt')) process.exit(4); fs.writeFileSync('input.txt','updated'); ${done}`) });
  assert.equal(state.status, 'complete');
  assert.equal(await fs.readFile(path.join(root, 'input.txt'), 'utf8'), 'original');
  assert.match(await fs.readFile(path.join(root, '.swarm/runs', state.id, 'writer/message.txt'), 'utf8'), /Never inspect parent/);
  assert.deepEqual((await integrateRun(root, state.id)).files, ['input.txt']);
  assert.equal(await fs.readFile(path.join(root, 'input.txt'), 'utf8'), 'updated');
  await assert.rejects(integrateRun(root, state.id), /already integrated/);
});

test('rejects traversal, absolute paths, secrets, collisions, and executable adapter fields', () => {
  for (const bad of ['../escape', '/tmp/escape', 'x/../escape', 'x//y', 'x\\y', '.env.local', '.git/config']) {
    assert.throws(() => validateManifest(manifest([job({ outputs: [bad] })])), /path/i);
  }
  assert.throws(() => validateManifest(manifest([job(), job({ id: 'second' })])), /collision/);
  assert.throws(() => validateManifest(manifest([job({ command: '/tmp/evil' })])), /Unknown/);
  assert.throws(() => validateManifest(manifest([job({ agent: 'unknown-agent' })])), /Unsupported/);
  assert.throws(() => validateManifest({ ...manifest(), concurrency: 33 }), /Concurrency/);
});

test('refuses symlink context and launches no workers', async t => {
  const root = await fixture(t);
  await fs.symlink(path.join(root, 'private.txt'), path.join(root, 'linked.txt'));
  let calls = 0;
  const state = await runManifest(root, manifest([job({ context: ['linked.txt'] })]), { spawnImpl: () => { calls++; throw Error('unexpected'); } });
  assert.equal(calls, 0);
  assert.equal(state.status, 'failed');
  assert.match(state.error, /Symlink refused/);
});

test('rejects symlink parents both when copying and when integrating', async t => {
  const root = await fixture(t);
  await fs.mkdir(path.join(root, 'actual'));
  await fs.symlink(path.join(root, 'actual'), path.join(root, 'linked'));
  const bad = await runManifest(root, manifest([job({ outputs: ['linked/out.txt'] })]), { spawnImpl: update });
  assert.equal(bad.status, 'failed');
  const state = await runManifest(root, manifest(), { spawnImpl: fake(`fs.unlinkSync('input.txt'); fs.symlinkSync('${path.join(root, 'private.txt')}', 'input.txt'); ${done}`) });
  await assert.rejects(integrateRun(root, state.id), /Symlink refused/);
  assert.equal(await fs.readFile(path.join(root, 'input.txt'), 'utf8'), 'original');
});

test('checks all conflicts before writing any output', async t => {
  const root = await fixture(t);
  await fs.writeFile(path.join(root, 'second.txt'), 'base');
  const state = await runManifest(root, manifest([job({ outputs: ['input.txt', 'second.txt'] })]), { spawnImpl: fake(`fs.writeFileSync('input.txt','updated');fs.writeFileSync('second.txt','updated'); ${done}`) });
  await fs.writeFile(path.join(root, 'second.txt'), 'coordinator edit');
  await assert.rejects(integrateRun(root, state.id), /Integration conflict/);
  assert.equal(await fs.readFile(path.join(root, 'input.txt'), 'utf8'), 'original');
  assert.equal(await fs.readFile(path.join(root, 'second.txt'), 'utf8'), 'coordinator edit');
});

test('supports new output files and excludes undeclared worker files', async t => {
  const root = await fixture(t);
  const state = await runManifest(root, manifest([job({ outputs: ['new/answer.txt'] })]), { spawnImpl: fake(`fs.mkdirSync('new');fs.writeFileSync('new/answer.txt','answer');fs.writeFileSync('unassigned.txt','discard'); ${done}`) });
  await assert.rejects(integrateRun(root, state.id), /dropped-writes: writer: unassigned\.txt/);
  assert.deepEqual((await integrateRun(root, state.id, { acceptDropped: true })).files, ['new/answer.txt']);
  await assert.rejects(fs.access(path.join(root, 'unassigned.txt')));
});

test('never propagates deletions', async t => {
  const root = await fixture(t);
  const state = await runManifest(root, manifest(), { spawnImpl: fake(`fs.unlinkSync('input.txt'); ${done}`) });
  await assert.rejects(integrateRun(root, state.id), /Missing output/);
  assert.equal(await fs.readFile(path.join(root, 'input.txt'), 'utf8'), 'original');
});

test('failed exit, error result, missing result, and malformed JSONL cannot integrate', async t => {
  const root = await fixture(t);
  for (const script of ['process.exit(7)', `console.log(JSON.stringify({type:'result',is_error:true,subtype:'error'}))`, `console.log(JSON.stringify({type:'assistant'}))`, `console.log('invalid'); ${done}`]) {
    const state = await runManifest(root, manifest(), { spawnImpl: fake(script) });
    assert.equal(state.status, 'failed');
    await assert.rejects(integrateRun(root, state.id), /Only a complete run/);
  }
});

test('timeout terminates a hanging worker and records the failure', async t => {
  const root = await fixture(t);
  const start = Date.now();
  const state = await runManifest(root, manifest([job({ timeoutMs: 100 })]), { spawnImpl: fake('setInterval(()=>{},1000)') });
  assert.equal(state.jobs[0].status, 'timeout');
  assert.ok(Date.now() - start < 3000);
});

test('cancellation marker stops only this run and its queued jobs', async t => {
  const root = await fixture(t);
  const pending = runManifest(root, { ...manifest([job(), job({ id: 'review', outputs: [] })]), concurrency: 1 }, { id: 'cancel-case', spawnImpl: fake('setInterval(()=>{},1000)') });
  let state;
  for (let i = 0; i < 100; i++) {
    try { state = await readState(root, 'cancel-case'); } catch {}
    if (state?.jobs[0]?.status === 'running') break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  await cancelRun(root, 'cancel-case');
  const result = await pending;
  assert.equal(result.status, 'cancelled');
  assert.ok(result.jobs.every(entry => entry.status === 'cancelled'));
});

test('fixed Claude adapter has no shell/agent tools and passes model only when explicit', () => {
  const args = claudeArgs(job({ model: undefined }));
  assert.equal(args.includes('--model'), false);
  assert.equal(args[args.indexOf('--tools') + 1], 'Read,Glob,Grep,Write,Edit');
  assert.ok(args.includes('--restricted'));
  assert.ok(args.includes('--strict-mcp-config'));
  assert.deepEqual(claudeArgs(job({ model: 'claude-sonnet-4-6' })).slice(-2), ['--model', 'claude-sonnet-4-6']);
  assert.equal(claudeArgs(job({ outputs: [], model: undefined }))[args.indexOf('--tools') + 1], 'Read,Glob,Grep');
});

test('every job, CLI or API, must name an explicit model; there is no CLI default', () => {
  assert.throws(() => validateManifest(manifest([job({ model: undefined })])), /writer requires an explicit model; the runner never uses a CLI default/);
  assert.throws(() => validateManifest(manifest([job({ model: '' })])), /writer requires an explicit model; the runner never uses a CLI default/);
  assert.doesNotThrow(() => validateManifest(manifest([job({ model: 'sonnet' })])));
  assert.throws(() => validateManifest(manifest([job({ id: 'openai-job', agent: 'openai', model: undefined })])), /openai-job requires an explicit model; the runner never uses a CLI default/);
});

test('bounds simultaneous fresh processes to manifest concurrency', async t => {
  const root = await fixture(t);
  let active = 0, maximum = 0;
  const provider = fake(`setTimeout(()=>{${done}}, 70)`);
  const state = await runManifest(root, manifest(Array.from({ length: 5 }, (_, i) => job({ id: `reader-${i}`, outputs: [] }))), {
    spawnImpl: (...args) => {
      active++; maximum = Math.max(maximum, active);
      const child = provider(...args);
      child.on('close', () => active--);
      return child;
    }
  });
  assert.equal(state.status, 'complete');
  assert.equal(maximum, 2);
  assert.equal(active, 0);
});

test('external abort closes owned workers before returning', async t => {
  const root = await fixture(t);
  const controller = new AbortController();
  let closed = false;
  const provider = fake('setInterval(()=>{},1000)');
  const pending = runManifest(root, manifest(), { signal: controller.signal, spawnImpl: (...args) => {
    const child = provider(...args);
    child.on('close', () => { closed = true; });
    setTimeout(() => controller.abort(), 40);
    return child;
  } });
  const state = await pending;
  assert.equal(state.status, 'cancelled');
  assert.equal(closed, true);
});

test('case-insensitive IDs, outputs and sensitive paths are rejected', () => {
 assert.throws(()=>validateManifest(manifest([job({id:'Writer',outputs:[]}),job({id:'writer',outputs:[]})])),/duplicate/);
 assert.throws(()=>validateManifest(manifest([job({outputs:['A.txt']}),job({id:'b',outputs:['a.txt']})])),/collision/);
 for(const file of ['.ENV','x/.SSH/config','C:foo','control\nfile'])assert.throws(()=>validateManifest(manifest([job({outputs:[file]})])),/path/i);
});

test('validation is read-only and refuses missing context', async t => {
 const {validateProject}=await import('../tools/swarm.mjs');const root=await fixture(t);
 assert.equal((await validateProject(root,manifest())).status,'valid');
 await assert.rejects(fs.access(path.join(root,'.swarm')));
 await assert.rejects(validateProject(root,manifest([job({context:['missing']})])),/Missing context/);
});

test('inspection and integration preserve executable permissions and detect permission conflicts', async t => {
 const {inspectRun}=await import('../tools/swarm.mjs');const root=await fixture(t);
 await fs.chmod(path.join(root,'input.txt'),0o755);
 const state=await runManifest(root,manifest(),{spawnImpl:update});
 assert.equal((await inspectRun(root,state.id)).files[0].status,'ready');
 await fs.chmod(path.join(root,'input.txt'),0o644);
 assert.equal((await inspectRun(root,state.id)).files[0].status,'conflict');
 await assert.rejects(integrateRun(root,state.id),/permissions changed/);
 await fs.chmod(path.join(root,'input.txt'),0o755);
 await integrateRun(root,state.id);
 assert.equal((await fs.stat(path.join(root,'input.txt'))).mode&0o777,0o755);
 assert.equal((await inspectRun(root,state.id)).files[0].status,'applied');
});

test('records actual model and usage metadata from provider events', async t => {
 const root=await fixture(t);
 const state=await runManifest(root,manifest([job({outputs:[]})]),{spawnImpl:fake(`console.log(JSON.stringify({type:'system',subtype:'init',model:'actual-model'}));console.log(JSON.stringify({type:'result',subtype:'success',result:'ok',usage:{input_tokens:42},total_cost_usd:0.01,modelUsage:{'actual-model':{inputTokens:42}}}));`)});
 assert.equal(state.jobs[0].actualModel,'actual-model');assert.equal(state.jobs[0].usage.input_tokens,42);
});

test('doctor rejects incompatible CLIs without a model call', async()=>{
 const {doctor}=await import('../tools/swarm.mjs');
 await assert.rejects(doctor({exec:async(_cmd,args)=>({stdout:args[0]==='--version'?'old CLI':'--tools'})}),/lacks required flags/);
});

const CLAUDE_FLAGS=['--restricted','--safe-mode','--tools','--permission-prompts','--strict-mcp-config','--mcp-config','--no-session-persistence','--no-chrome','--output-format'];
const FULL_HELP=`Usage: claude [options]\n${CLAUDE_FLAGS.join(' ')}\n`;

test('doctor retries a truncated help probe once and accepts a complete second read', async()=>{
 const {doctor}=await import('../tools/swarm.mjs');
 let helpCalls=0;
 const result=await doctor({exec:async(_cmd,args)=>{
  if(args[0]==='--version')return {stdout:'2.1.280 (Claude Code)'};
  helpCalls++;
  return {stdout:helpCalls===1?FULL_HELP.slice(0,Math.floor(FULL_HELP.length/2)):FULL_HELP};
 }});
 assert.equal(helpCalls,2);
 assert.equal(result.status,'compatible');
});

test('doctor reports a probe failure, not a flags failure, when help output stays empty after retry',async()=>{
 const {doctor}=await import('../tools/swarm.mjs');
 let helpCalls=0;
 await assert.rejects(doctor({exec:async(_cmd,args)=>{
  if(args[0]==='--version')return {stdout:'2.1.280 (Claude Code)'};
  helpCalls++;
  return {stdout:''};
 }}),/Claude CLI help probe failed \(no or empty output\)/);
 assert.equal(helpCalls,2);
});

test('doctor still reports missing flags when help output is complete both times',async()=>{
 const {doctor}=await import('../tools/swarm.mjs');
 const missingFlagHelp=FULL_HELP.replace('--no-chrome ','');
 let helpCalls=0;
 await assert.rejects(doctor({exec:async(_cmd,args)=>{
  if(args[0]==='--version')return {stdout:'2.1.280 (Claude Code)'};
  helpCalls++;
  return {stdout:missingFlagHelp};
 }}),/Installed Claude CLI lacks required flags: --no-chrome\./);
 assert.equal(helpCalls,2);
});

test('execViaFile reads full stdout through a temp file even when the exit races the pipe',async()=>{
 const {execViaFile}=await import('../tools/cli-adapters.mjs');
 const payload='x'.repeat(21644);
 const result=await execViaFile(process.execPath,['-e',`process.stdout.write(${JSON.stringify(payload)},()=>{process.exit(0)});`],{timeout:10000});
 assert.equal(result.stdout,payload);
});

test('explicit concurrency four creates four simultaneous fresh processes and drains the queue', async t => {
 const root=await fixture(t);let active=0,maximum=0,launched=0;const live=[];
 // Field lesson #182: a worker that exits after a fixed wall-clock delay assumes launching every
 // worker up to the concurrency limit is faster than that delay; under load on the same machine
 // it sometimes is not, and the observed peak concurrency reads low (flaky). Each worker instead
 // reports (over stderr, so it never pollutes the stdout JSONL) once its own SIGTERM handler is
 // registered, and is only ever sent that signal after this test has actually observed both that
 // report and (via a bounded poll, no fixed sleep) that the next queued worker launched.
 const provider=fake(`process.on('SIGTERM',()=>{${done}process.exit(0);});process.stderr.write('ready');setInterval(()=>{},1000);`);
 const pending=runManifest(root,{...manifest(Array.from({length:9},(_,i)=>job({id:`parallel-${i}`,outputs:[]}))),concurrency:4},{spawnImpl:(...args)=>{
   launched++;active++;maximum=Math.max(maximum,active);
   const child=provider(...args);
   const ready=new Promise(resolve=>child.stderr.once('data',resolve));
   live.push({child,ready});
   child.on('close',()=>active--);
   return child;
 }});
 const waitUntil=async(predicate,label)=>{const deadline=Date.now()+5000;while(!predicate()&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,5));assert.ok(predicate(),label);};
 const killOldest=async()=>{const entry=live.shift();await entry.ready;entry.child.kill();};
 await waitUntil(()=>launched===4,'first four workers did not launch');
 assert.equal(maximum,4);
 while(launched<9){const before=launched;await killOldest();await waitUntil(()=>launched>before,'next queued worker did not launch after a slot freed');}
 while(live.length)await killOldest();
 const state=await pending;
 assert.equal(state.status,'complete');assert.equal(launched,9);assert.equal(maximum,4);assert.equal(active,0);
});

test('cancelling four live CLI processes closes them and never launches queued workers', async t => {
 const root=await fixture(t);let active=0,launched=0;
 const provider=fake('setInterval(()=>{},1000)');
 const pending=runManifest(root,{...manifest(Array.from({length:8},(_,i)=>job({id:`stop-${i}`,outputs:[]}))),concurrency:4},{id:'stop-four',spawnImpl:(...args)=>{launched++;active++;const child=provider(...args);child.on('close',()=>active--);return child;}});
 for(let i=0;i<100&&launched<4;i++)await new Promise(resolve=>setTimeout(resolve,10));
 assert.equal(launched,4);await cancelRun(root,'stop-four');const state=await pending;
 assert.equal(state.status,'cancelled');assert.equal(active,0);assert.equal(launched,4);assert.ok(state.jobs.every(entry=>entry.status==='cancelled'));
});

test('timeout kills an owned descendant even after its direct parent exits and closes stdio', async t => {
 if(process.platform==='win32')return;
 const root=await fixture(t);let descendant;
 t.after(()=>{if(descendant)try{process.kill(descendant,'SIGKILL');}catch{}});
 const provider=fake(`import {spawn} from 'node:child_process';const child=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});process.stdout.write('ready');setInterval(()=>{},1000);"],{stdio:['ignore','pipe','ignore']});child.stdout.once('data',()=>{fs.writeFileSync('descendant.pid',String(child.pid));child.stdout.destroy();});setInterval(()=>{},1000);`);
 const state=await runManifest(root,manifest([job({timeoutMs:2000})]),{spawnImpl:provider});
 descendant=Number(await fs.readFile(path.join(root,'.swarm/workspaces',state.id,'writer/descendant.pid'),'utf8'));
 assert.equal(state.jobs[0].status,'timeout');
 // On Linux an orphan may briefly be a zombie; it must no longer execute.
 const {execFileSync}=await import('node:child_process');let status='';for(let i=0;i<30;i++){try{status=execFileSync('ps',['-o','stat=','-p',String(descendant)],{encoding:'utf8'}).trim();}catch{status='';}if(!status||status.startsWith('Z'))break;await new Promise(resolve=>setTimeout(resolve,10));}
 assert.ok(!status||status.startsWith('Z'),`descendant still active: ${status}`);
});

test('inspect blocks partial outputs from timed-out and cancelled jobs while integration remains forbidden', async t => {
 const {inspectRun}=await import('../tools/swarm.mjs');const root=await fixture(t);
 const partial=fake(`fs.writeFileSync('input.txt','partial edit');setInterval(()=>{},1000);`);
 const timed=await runManifest(root,manifest([job({timeoutMs:2000})]),{spawnImpl:partial});
 const timedReport=await inspectRun(root,timed.id);assert.equal(timedReport.files[0].jobStatus,'timeout');assert.equal(timedReport.files[0].status,'blocked');assert.equal(timedReport.files[0].bytes,12);await assert.rejects(integrateRun(root,timed.id),/Only a complete/);
 const pending=runManifest(root,manifest(),{id:'partial-cancel',spawnImpl:partial});
 for(let i=0;i<100;i++){let text;try{text=await fs.readFile(path.join(root,'.swarm/workspaces/partial-cancel/writer/input.txt'),'utf8');}catch{}if(text==='partial edit')break;await new Promise(resolve=>setTimeout(resolve,10));}
 await cancelRun(root,'partial-cancel');const cancelled=await pending;const report=await inspectRun(root,cancelled.id);assert.equal(report.files[0].jobStatus,'cancelled');assert.equal(report.files[0].status,'blocked');assert.equal(report.files[0].bytes,12);await assert.rejects(integrateRun(root,cancelled.id),/Only a complete/);assert.equal(await fs.readFile(path.join(root,'input.txt'),'utf8'),'original');
});

test('normal success and error exits clean surviving descendants in the owned group', async t => {
 if(process.platform==='win32')return;
 const root=await fixture(t),descendants=[];
 t.after(()=>{for(const pid of descendants)try{process.kill(pid,'SIGKILL');}catch{}});
 for(const success of [true,false]){
  const provider=fake(`import {spawn} from 'node:child_process';const child=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});process.stdout.write('ready');setInterval(()=>{},1000);"],{stdio:['ignore','pipe','ignore']});child.stdout.once('data',()=>{fs.writeFileSync('descendant.pid',String(child.pid));child.stdout.destroy();${success?done:''}process.exit(${success?0:7});});`);
  const state=await runManifest(root,manifest(),{spawnImpl:provider});const pid=Number(await fs.readFile(path.join(root,'.swarm/workspaces',state.id,'writer/descendant.pid'),'utf8'));descendants.push(pid);assert.equal(state.status,success?'complete':'failed');assert.equal(state.jobs[0].cleanupError,null);
  const {execFileSync}=await import('node:child_process');let status='';for(let i=0;i<30;i++){try{status=execFileSync('ps',['-o','stat=','-p',String(pid)],{encoding:'utf8'}).trim();}catch{status='';}if(!status||status.startsWith('Z'))break;await new Promise(resolve=>setTimeout(resolve,10));}assert.ok(!status||status.startsWith('Z'),`descendant still active: ${status}`);
 }
});

test('cleanup signal permission failures are explicit and prevent successful integration', async t => {
 const root=await fixture(t);const attempts=[];
 const state=await runManifest(root,manifest(),{spawnImpl:update,killImpl:(target,signal)=>{attempts.push({target,signal});throw Object.assign(Error('private detail must not leak'),{code:'EPERM'});}});
 assert.equal(state.status,'failed');assert.equal(state.jobs[0].status,'failed');assert.match(state.jobs[0].cleanupError,/EPERM/);assert.match(state.jobs[0].error,/cleanup failed/);assert.ok(!JSON.stringify(state).includes('private detail'));assert.equal(attempts.length,1);assert.equal(attempts[0].signal,'SIGTERM');assert.ok(attempts[0].target<0);await assert.rejects(integrateRun(root,state.id),/Only a complete/);
});

test('SIGKILL escalation failures are reported instead of swallowed', async()=>{
 const {EventEmitter}=await import('node:events');const {stopChild}=await import('../tools/swarm.mjs');const child=new EventEmitter();child.pid=424242;const attempts=[];
 const result=await stopChild(child,{killImpl:(target,signal)=>{attempts.push({target,signal});if(signal==='SIGKILL')throw Object.assign(Error('denied'),{code:'EPERM'});}});
 assert.match(result.error,/EPERM.*SIGKILL/);assert.ok(attempts.every(call=>call.target===-424242));
});

test('cancellation cleanup denial preserves its reason, fails the run, and does not start queued jobs', async t => {
 const root=await fixture(t),controller=new AbortController();let child,launched=0;
 t.after(()=>{if(child?.pid)try{process.kill(process.platform==='win32'?child.pid:-child.pid,'SIGKILL');}catch{}});
 const provider=fake('setInterval(()=>{},1000)');
 const state=await runManifest(root,{...manifest([job(),job({id:'queued',outputs:[]})]),concurrency:1},{signal:controller.signal,spawnImpl:(...args)=>{launched++;child=provider(...args);setTimeout(()=>controller.abort(),40);return child;},killImpl:()=>{throw Object.assign(Error('denied'),{code:'EPERM'});}});
 assert.equal(state.status,'failed');assert.equal(state.jobs[0].status,'failed');assert.equal(state.jobs[0].terminationReason,'cancelled');assert.match(state.jobs[0].cleanupError,/EPERM/);assert.equal(state.jobs[1].status,'cancelled');assert.equal(launched,1);await assert.rejects(integrateRun(root,state.id));
});

test('normal leader exit cleans a descendant that keeps inherited stdout open without timing out',async t=>{
 if(process.platform==='win32')return;
 const root=await fixture(t);let descendant;t.after(()=>{if(descendant)try{process.kill(descendant,'SIGKILL');}catch{}});
 const script=`import {spawn} from 'node:child_process';const child=spawn(process.execPath,['-e',"const fs=require('node:fs');process.on('SIGTERM',()=>{});fs.writeFileSync('ready.pid',String(process.pid));setInterval(()=>{},1000);"],{stdio:['ignore','inherit','ignore']});const poll=setInterval(()=>{if(fs.existsSync('ready.pid')){clearInterval(poll);${done}process.exit(0);}},10);`;
 const state=await runManifest(root,manifest([job({timeoutMs:2000})]),{spawnImpl:fake(script)});descendant=Number(await fs.readFile(path.join(root,'.swarm/workspaces',state.id,'writer/ready.pid'),'utf8'));
 assert.equal(state.status,'complete');assert.equal(state.jobs[0].terminationReason,null);assert.equal(state.jobs[0].cleanupError,null);assert.ok(state.jobs[0].durationMs<1800);
});

const checkManifest = (jobs, checks) => ({ version: 1, concurrency: 2, jobs, checks });
const twoFiles = fake(`fs.writeFileSync('a.py','x');fs.writeFileSync('b.txt','y'); ${done}`);

test('validate rejects malformed checks', () => {
 assert.throws(()=>validateManifest(checkManifest([job()],[{name:'x',argv:['node'],extra:true}])),/Unknown check field/);
 assert.throws(()=>validateManifest(checkManifest([job()],[{name:'x',argv:[]}])),/non-empty array/);
 assert.throws(()=>validateManifest(checkManifest([job()],[{name:'x',argv:['node',7]}])),/must be strings/);
 assert.throws(()=>validateManifest(checkManifest([job()],[{name:'',argv:['node']}])),/Invalid check name/);
 assert.throws(()=>validateManifest(checkManifest([job()],[{name:'bad$name',argv:['node']}])),/Invalid check name/);
 assert.throws(()=>validateManifest(checkManifest([job()],[{name:'x',argv:['node'],timeoutMs:500}])),/timeoutMs must be 1000/);
 assert.throws(()=>validateManifest(checkManifest([job()],Array.from({length:11},(_,i)=>({name:`c${i}`,argv:['node']})))),/at most 10 checks/);
 assert.doesNotThrow(()=>validateManifest(checkManifest([job()],[{name:'format ok_1.2-3',argv:['node','-e','1']}])));
});

test('{integrated} and {integrated:.ext} placeholders expand to written files, and a zero-match placeholder skips', async t => {
 const root=await fixture(t);
 const allScript=`require('fs').writeFileSync('all-received.json',JSON.stringify(process.argv.slice(1)))`;
 const pyScript=`require('fs').writeFileSync('py-received.json',JSON.stringify(process.argv.slice(1)))`;
 const checks=[
  {name:'all',argv:[process.execPath,'-e',allScript,'{integrated}']},
  {name:'py-only',argv:[process.execPath,'-e',pyScript,'{integrated:.py}']},
  {name:'zero-match',argv:[process.execPath,'-e','process.exit(1)','{integrated:.rb}']},
 ];
 const state=await runManifest(root,checkManifest([job({outputs:['a.py','b.txt']})],checks),{spawnImpl:twoFiles});
 const result=await integrateRun(root,state.id);
 assert.deepEqual(result.files,['a.py','b.txt']);
 assert.deepEqual(JSON.parse(await fs.readFile(path.join(root,'all-received.json'),'utf8')),['a.py','b.txt']);
 assert.deepEqual(JSON.parse(await fs.readFile(path.join(root,'py-received.json'),'utf8')),['a.py']);
 assert.equal(result.checks[0].status,'passed');
 assert.equal(result.checks[1].status,'passed');
 assert.equal(result.checks[2].status,'skipped');
 assert.equal(result.checks[2].exitCode,null);
 assert.equal(result.checksPassed,true);
});

test('{root} expands anywhere inside a check argv item to the run\'s absolute project root, and {integrated} keeps expanding a whole item as before', async t => {
 const root=await fixture(t);
 const realRoot=await fs.realpath(root);
 const rootScript=`require('fs').writeFileSync('root-received.txt',process.argv[1])`;
 const allScript=`require('fs').writeFileSync('all-received.json',JSON.stringify(process.argv.slice(1)))`;
 const checks=[
  {name:'root',argv:[process.execPath,'-e',rootScript,'PREFIX={root}/marker']},
  {name:'all',argv:[process.execPath,'-e',allScript,'{integrated}']},
 ];
 const state=await runManifest(root,checkManifest([job({outputs:['a.py']})],checks),{spawnImpl:fake(`fs.writeFileSync('a.py','x'); ${done}`)});
 const result=await integrateRun(root,state.id);
 assert.equal(await fs.readFile(path.join(root,'root-received.txt'),'utf8'),`PREFIX=${realRoot}/marker`);
 assert.deepEqual(JSON.parse(await fs.readFile(path.join(root,'all-received.json'),'utf8')),['a.py']);
 assert.equal(result.checks[0].status,'passed');
 assert.equal(result.checks[1].status,'passed');
});

test('a passing, a failing, and a timing-out check are all reported, in order, and all run', async t => {
 const root=await fixture(t);
 const checks=[
  {name:'first',argv:[process.execPath,'-e','process.exit(0)']},
  {name:'second',argv:[process.execPath,'-e','process.exit(3)']},
  {name:'third',argv:[process.execPath,'-e','setInterval(()=>{},1000)'],timeoutMs:1000},
 ];
 const state=await runManifest(root,checkManifest([job()],checks),{spawnImpl:update});
 const result=await integrateRun(root,state.id);
 assert.deepEqual(result.checks.map(c=>c.name),['first','second','third']);
 assert.equal(result.checks[0].status,'passed');assert.equal(result.checks[0].exitCode,0);
 assert.equal(result.checks[1].status,'failed');assert.equal(result.checks[1].exitCode,3);
 assert.equal(result.checks[2].status,'timeout');assert.equal(result.checks[2].exitCode,null);
 assert.equal(result.checksPassed,false);
});

test('check output tail is capped at 2000 bytes', async t => {
 const root=await fixture(t);
 const checks=[{name:'loud',argv:[process.execPath,'-e',"process.stdout.write('x'.repeat(5000))"]}];
 const state=await runManifest(root,checkManifest([job()],checks),{spawnImpl:update});
 const result=await integrateRun(root,state.id);
 assert.equal(result.checks[0].tail.length,2000);
 assert.equal(result.checks[0].tail,'x'.repeat(2000));
});

test('--no-checks skips checks entirely', async t => {
 const root=await fixture(t);
 const checks=[{name:'marker',argv:[process.execPath,'-e',"require('fs').writeFileSync('should-not-run.txt','x')"]}];
 const state=await runManifest(root,checkManifest([job()],checks),{spawnImpl:update});
 const result=await integrateRun(root,state.id,{noChecks:true});
 assert.deepEqual(result.checks,[]);
 assert.equal(result.checksSkipped,true);
 assert.equal(result.checksPassed,true);
 await assert.rejects(fs.access(path.join(root,'should-not-run.txt')));
});

test('no shell: an argv item with shell metacharacters is passed literally, never interpreted', async t => {
 const root=await fixture(t);
 const script=`require('fs').writeFileSync('argv-received.txt',process.argv[1])`;
 const checks=[{name:'literal',argv:[process.execPath,'-e',script,'a;touch pwned.txt']}];
 const state=await runManifest(root,checkManifest([job()],checks),{spawnImpl:update});
 const result=await integrateRun(root,state.id);
 assert.equal(result.checks[0].status,'passed');
 assert.equal(await fs.readFile(path.join(root,'argv-received.txt'),'utf8'),'a;touch pwned.txt');
 await assert.rejects(fs.access(path.join(root,'pwned.txt')));
});

test('integrate refuses a failed check by default (batch L #203); --require-checks stays an accepted no-op alias; --accept-failed-checks is the opt-in', async t => {
 const root=await fixture(t);
 const checks=[{name:'fails',argv:[process.execPath,'-e','process.exit(1)']}];
 const withoutFlag=await runManifest(root,checkManifest([job()],checks),{spawnImpl:update,id:'require-checks-default'});
 await assert.rejects(execFileAsync(process.execPath,[CLI,'--root',root,'integrate',withoutFlag.id]), error => {
  assert.equal(error.code,1);
  assert.equal(JSON.parse(error.stdout).checksPassed,false);
  return true;
 });
 const withFlag=await runManifest(root,checkManifest([job()],checks),{spawnImpl:update,id:'require-checks-flag'});
 await assert.rejects(execFileAsync(process.execPath,[CLI,'--root',root,'integrate',withFlag.id,'--require-checks']), error => {
  assert.equal(error.code,1);
  assert.equal(JSON.parse(error.stdout).checksPassed,false);
  return true;
 });
 const withAccept=await runManifest(root,checkManifest([job()],checks),{spawnImpl:update,id:'accept-failed-checks'});
 const acceptedRun=await execFileAsync(process.execPath,[CLI,'--root',root,'integrate',withAccept.id,'--accept-failed-checks']);
 const acceptedResult=JSON.parse(acceptedRun.stdout);
 assert.equal(acceptedResult.checksPassed,false);
 assert.equal(acceptedResult.status,'integrated-with-failures');
});


test('file-backed probes reject nonzero exit and signals, including failed login status', async () => {
 const {execViaFile}=await import('../tools/cli-adapters.mjs');
 await assert.rejects(execViaFile(process.execPath,['-e','process.exit(7)']),/probe failed/);
 await assert.rejects(execViaFile(process.execPath,['-e',"process.kill(process.pid,'SIGTERM')"]),/probe failed/);
});

// --- ignoreTests, contract, and the context check ------------------------------------------

async function withTestFixture(t) {
  const root = await fixture(t);
  await fs.writeFile(path.join(root, 'widget.mjs'), 'export const widget = 1;');
  await fs.mkdir(path.join(root, 'tests'));
  await fs.writeFile(path.join(root, 'tests', 'widget.test.mjs'), "import { widget } from '../widget.mjs';");
  return root;
}

test('validate refuses a job whose output is referenced by a test outside its context/outputs/ignoreTests', async t => {
  const root = await withTestFixture(t);
  await assert.rejects(
    validateProject(root, manifest([job({ id: 'writer', context: [], outputs: ['widget.mjs'] })])),
    /writer: widget\.mjs <- tests\/widget\.test\.mjs/,
  );
});

test('the same job passes once the test is added to context, and again once it is listed in ignoreTests instead', async t => {
  const root = await withTestFixture(t);
  const withContext = job({ id: 'writer', context: ['tests/widget.test.mjs'], outputs: ['widget.mjs'] });
  assert.equal((await validateProject(root, manifest([withContext]))).status, 'valid');
  const withIgnore = job({ id: 'writer', context: [], outputs: ['widget.mjs'], ignoreTests: ['tests/widget.test.mjs'] });
  assert.equal((await validateProject(root, manifest([withIgnore]))).status, 'valid');
});

test('ignoreTests follows the same path rules as context: traversal, duplicates, and the 100-entry cap', () => {
  assert.throws(() => validateManifest(manifest([job({ ignoreTests: ['../escape'] })])), /path/i);
  assert.throws(() => validateManifest(manifest([job({ ignoreTests: ['a.txt', 'a.txt'] })])), /Duplicate file path/);
  assert.throws(() => validateManifest(manifest([job({ ignoreTests: Array.from({ length: 101 }, (_, i) => `t${i}.txt`) })])), /at most 100 files/);
});

test('validateProject refuses a job whose ignoreTests entry does not exist', async t => {
  const root = await fixture(t);
  await assert.rejects(
    validateProject(root, manifest([job({ ignoreTests: ['tests/missing.test.mjs'] })])),
    /writer: missing ignoreTests entry: tests\/missing\.test\.mjs/,
  );
});

test('a top-level contract must appear in every job\'s context; the first job missing it is named', () => {
  const withContract = {
    version: 1,
    jobs: [
      job({ id: 'a', context: ['input.txt', 'CONTRACT.md'] }),
      job({ id: 'b', context: ['input.txt'], outputs: ['other.txt'] }),
    ],
    contract: 'CONTRACT.md',
  };
  assert.throws(() => validateManifest(withContract), /Job b: context must include the shared contract file: CONTRACT\.md/);
});

test('a top-level contract may not be listed as any job\'s output', () => {
  const withContract = {
    version: 1,
    jobs: [job({ id: 'a', context: ['input.txt', 'CONTRACT.md'], outputs: ['CONTRACT.md'] })],
    contract: 'CONTRACT.md',
  };
  assert.throws(() => validateManifest(withContract), /Job a: outputs must not include the shared contract file \(only the coordinator writes it\): CONTRACT\.md/);
});

test('a manifest with no contract field validates exactly as before', () => {
  assert.doesNotThrow(() => validateManifest(manifest()));
});

// --- ship: CLI wiring -----------------------------------------------------------------------

async function makeFakeGhDir(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-fake-gh-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.writeFile(path.join(dir, 'gh'), `#!/bin/sh
if [ "$#" -eq 1 ] && [ "$1" = "--version" ]; then
  echo "gh version 2.60.0 (2024-10-01)"
  exit 0
fi
echo "Unexpected fake gh invocation: $*" >&2
exit 1
`, { mode: 0o755 });
  return dir;
}

test('parseShipFlags maps every flag to ship() options and rejects an unknown flag', () => {
  assert.deepEqual(
    parseShipFlags(['--repo', 'acme/widgets', '--pr', 'pr.json', '--require-section', 'Summary', '--require-section', 'Tests', '--no-merge', '--merge-method', 'rebase', '--timeout', '30', '--poll', '5']),
    { repo: 'acme/widgets', payloadPath: 'pr.json', requireSections: ['Summary', 'Tests'], merge: false, mergeMethod: 'rebase', timeoutMs: 30000, pollMs: 5000 },
  );
  assert.throws(() => parseShipFlags(['--bogus']), /Unknown flag: --bogus/);
  assert.equal(parseShipFlags(['--pr', 'pr.json']).repo, undefined);
  assert.throws(() => parseShipFlags(['--repo', 'acme/widgets']), /requires --pr/);
  assert.throws(() => parseShipFlags(['--repo', 'acme/widgets', '--pr', 'pr.json', '--timeout', '0']), /--timeout requires a positive number/);
  assert.throws(() => parseShipFlags(['--repo', 'acme/widgets', '--pr', 'pr.json', '--poll', 'soon']), /--poll requires a positive number/);
});

test('shipExitCode is 0 only for merged/held/ready, and 1 for every refusal or failure status', () => {
  for (const status of ['merged', 'held', 'ready']) assert.equal(shipExitCode(status), 0);
  for (const status of ['refused', 'checks-failed', 'ci-failed', 'no-ci', 'timeout', 'merge-failed']) assert.equal(shipExitCode(status), 1);
});

test('shipRun refuses a completed run that has not yet been integrated', async t => {
  const root = await fixture(t);
  const dir = await makeFakeGhDir(t);
  const originalPath = process.env.PATH;
  t.after(() => {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
  });
  process.env.PATH = `${dir}${path.delimiter}${originalPath ?? ''}`;
  const state = await runManifest(root, manifest(), { spawnImpl: update });
  await fs.writeFile(path.join(root, 'pr.json'), JSON.stringify({ title: 't', head: 'h', base: 'main', body: 'b' }));
  await assert.rejects(
    shipRun(root, state.id, { repo: 'acme/widgets', payloadPath: 'pr.json', requireSections: [], merge: true }),
    /must be integrated/,
  );
});

test('CLI ship refuses an un-integrated run and exits 1 without touching git/gh', async t => {
  const root = await fixture(t);
  const dir = await makeFakeGhDir(t);
  const state = await runManifest(root, manifest(), { spawnImpl: update, id: 'ship-not-integrated' });
  await fs.writeFile(path.join(root, 'pr.json'), JSON.stringify({ title: 't', head: 'h', base: 'main', body: 'b' }));
  await assert.rejects(execFileAsync(process.execPath, [CLI, '--root', root, 'ship', state.id, '--repo', 'acme/widgets', '--pr', 'pr.json'], { env: { ...process.env, PATH: `${dir}${path.delimiter}${process.env.PATH ?? ''}` } }), error => {
    assert.equal(error.code, 1);
    assert.match(JSON.parse(error.stderr).error, /must be integrated/);
    return true;
  });
});

test('CLI ship rejects an unknown flag before reading any run state, exit 1', async t => {
  const root = await fixture(t);
  await assert.rejects(execFileAsync(process.execPath, [CLI, '--root', root, 'ship', 'no-such-run', '--repo', 'acme/widgets', '--pr', 'pr.json', '--bogus']), error => {
    assert.equal(error.code, 1);
    assert.match(JSON.parse(error.stderr).error, /Unknown flag: --bogus/);
    return true;
  });
});

test('CLI ship requires --pr', async t => {
  const root = await fixture(t);
  await assert.rejects(execFileAsync(process.execPath, [CLI, '--root', root, 'ship', 'no-such-run']), error => {
    assert.equal(error.code, 1);
    assert.match(JSON.parse(error.stderr).error, /requires --pr/);
    return true;
  });
});

// --- lesson #46: root cause, actualModel/modelsSeen/modelMismatch, and warnings ------------

test('read-only jobs use permission-mode default and never plan (lesson #46 root cause)', () => {
  const args = claudeArgs(job({ outputs: [] }));
  assert.equal(args[args.indexOf('--permission-mode') + 1], 'default');
  assert.equal(args.includes('plan'), false);
  assert.equal(claudeArgs(job({ outputs: ['input.txt'] }))[args.indexOf('--permission-mode') + 1], 'acceptEdits');
});

const initEvent = model => JSON.stringify({ type: 'system', subtype: 'init', model });
const assistantEvent = model => JSON.stringify({ type: 'assistant', message: { model, content: [] } });
const resultEvent = costUsd => JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'ok', total_cost_usd: costUsd });

test('actualModel comes from assistant events, not just init, and modelMismatch drives a wait/inspect warning', async t => {
  const root = await fixture(t);
  const script = `fs.writeFileSync('input.txt','updated');console.log(${JSON.stringify(initEvent('claude-haiku-4-5-20251001'))});console.log(${JSON.stringify(assistantEvent('claude-sonnet-5-20260101'))});console.log(${JSON.stringify(resultEvent(0.02))});`;
  const state = await runManifest(root, manifest([job({ model: 'haiku' })]), { spawnImpl: fake(script) });
  assert.equal(state.jobs[0].actualModel, 'claude-sonnet-5-20260101');
  assert.deepEqual(state.jobs[0].modelsSeen, ['claude-haiku-4-5-20251001', 'claude-sonnet-5-20260101']);
  assert.equal(state.jobs[0].modelMismatch, true);
  const warning = 'model mismatch: writer asked haiku, ran claude-sonnet-5-20260101';
  assert.deepEqual((await waitRun(root, state.id)).warnings, [warning]);
  assert.deepEqual((await inspectRun(root, state.id)).warnings, [warning]);
});

test('a matching model stream reports no mismatch and no warning', async t => {
  const root = await fixture(t);
  const script = `fs.writeFileSync('input.txt','updated');console.log(${JSON.stringify(initEvent('claude-sonnet-5-20260101'))});console.log(${JSON.stringify(assistantEvent('claude-sonnet-5-20260101'))});${done}`;
  const state = await runManifest(root, manifest([job({ model: 'sonnet' })]), { spawnImpl: fake(script) });
  assert.equal(state.jobs[0].modelMismatch, false);
  assert.deepEqual((await waitRun(root, state.id)).warnings, []);
  assert.deepEqual((await inspectRun(root, state.id)).warnings, []);
});

test('a short model alias matches any assistant id containing it, so haiku vs claude-haiku-4-5 is not a mismatch', async t => {
  const root = await fixture(t);
  const script = `fs.writeFileSync('input.txt','updated');console.log(${JSON.stringify(initEvent('claude-haiku-4-5-20251001'))});console.log(${JSON.stringify(assistantEvent('claude-haiku-4-5-20251001'))});${done}`;
  const state = await runManifest(root, manifest([job({ model: 'haiku' })]), { spawnImpl: fake(script) });
  assert.equal(state.jobs[0].modelMismatch, false);
});

// --- lesson #48: ask, and inspect --results -------------------------------------------------

test('ask refuses without --model, --context, or a non-empty question', async t => {
  const root = await fixture(t);
  await assert.rejects(askRun(root, { context: ['input.txt'], question: 'What next?' }), /requires --model/);
  await assert.rejects(askRun(root, { model: 'sonnet', question: 'What next?' }), /requires --context/);
  await assert.rejects(askRun(root, { model: 'sonnet', context: ['input.txt'], question: '   ' }), /non-empty question/);
});

test('ask refuses codex as its agent', async t => {
  const root = await fixture(t);
  await assert.rejects(askRun(root, { model: 'test-model', context: ['input.txt'], agent: 'codex', question: 'What next?' }), /not codex/);
});

test('ask builds a read-only job, runs it like run, and returns the contract-shaped result with a fake claude CLI', async t => {
  const root = await fixture(t);
  const answer = JSON.stringify({ answer: 'yes' });
  const script = `console.log(${JSON.stringify(initEvent('claude-sonnet-5-20260101'))});console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,result:${JSON.stringify(answer)},total_cost_usd:0.03}));`;
  const result = await askRun(root, { model: 'sonnet', context: ['input.txt'], question: 'Should we ship?' }, { spawnImpl: fake(script) });
  assert.deepEqual(Object.keys(result).sort(), ['actualModel', 'contextFiles', 'costUsd', 'id', 'model', 'modelMismatch', 'result', 'status', 'warnings'].sort());
  assert.equal(result.status, 'complete');
  assert.equal(result.model, 'sonnet');
  assert.equal(result.actualModel, 'claude-sonnet-5-20260101');
  assert.equal(result.modelMismatch, false);
  assert.equal(result.costUsd, 0.03);
  assert.deepEqual(result.result, { answer: 'yes' });
  assert.deepEqual(result.contextFiles, ['input.txt']);
  assert.deepEqual(result.warnings, []);
});

test('CLI ask prints exactly one JSON line with the contract keys and exits 0, using a fake claude CLI on PATH', async t => {
  const root = await fixture(t);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-fake-claude-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const answer = JSON.stringify(JSON.stringify({ answer: 'ok' }));
  await fs.writeFile(path.join(dir, 'claude'), `#!/usr/bin/env node\nconsole.log(${JSON.stringify(initEvent('claude-sonnet-5-20260101'))});\nconsole.log(JSON.stringify({type:'result',subtype:'success',is_error:false,result:${answer}}));\n`, { mode: 0o755 });
  const { stdout } = await execFileAsync(process.execPath, [CLI, '--root', root, 'ask', '--model', 'sonnet', '--context', 'input.txt', 'Should we ship?'], { env: { ...process.env, PATH: `${dir}${path.delimiter}${process.env.PATH}` } });
  const lines = stdout.trim().split('\n');
  assert.equal(lines.length, 1);
  const parsed = JSON.parse(lines[0]);
  assert.deepEqual(Object.keys(parsed).sort(), ['actualModel', 'contextFiles', 'costUsd', 'id', 'model', 'modelMismatch', 'result', 'status', 'warnings'].sort());
  assert.equal(parsed.status, 'complete');
});

test('inspect --results prints only the contract shape', async t => {
  const root = await fixture(t);
  const resultLine = JSON.stringify({ files_changed: ['input.txt'], notes: ['done'] });
  const script = `fs.writeFileSync('input.txt','updated');console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,result:${JSON.stringify(resultLine)},total_cost_usd:0.1}));`;
  const state = await runManifest(root, manifest(), { spawnImpl: fake(script) });
  const report = await inspectResults(root, state.id);
  assert.deepEqual(Object.keys(report).sort(), ['costNotReported', 'jobs', 'runId', 'status', 'tokens', 'warnings'].sort());
  assert.equal(report.runId, state.id);
  assert.equal(report.status, 'complete');
  assert.deepEqual(report.warnings, []);
  assert.equal(report.jobs.length, 1);
  assert.deepEqual(Object.keys(report.jobs[0]).sort(), ['actualModel', 'costUsd', 'id', 'model', 'modelMismatch', 'outputs', 'result', 'resultSource', 'status', 'tokens'].sort());
  assert.equal(report.jobs[0].id, 'writer');
  assert.equal(report.jobs[0].costUsd, 0.1);
  assert.deepEqual(report.jobs[0].result, { files_changed: ['input.txt'], notes: ['done'] });
});

test('CLI inspect --results prints only the reduced contract shape', async t => {
  const root = await fixture(t);
  const state = await runManifest(root, manifest(), { spawnImpl: update });
  const { stdout } = await execFileAsync(process.execPath, [CLI, '--root', root, 'inspect', state.id, '--results']);
  const parsed = JSON.parse(stdout);
  assert.deepEqual(Object.keys(parsed).sort(), ['costNotReported', 'jobs', 'runId', 'status', 'tokens', 'warnings'].sort());
});

test('defaultRoot maps a versions/ snapshot back to its install and leaves a checkout alone', () => {
  assert.equal(defaultRoot('/home/u/.project-swarm/versions/1.9.0-abcd1234'), '/home/u/.project-swarm');
  assert.equal(defaultRoot('/home/u/.project-swarm'), '/home/u/.project-swarm');
  assert.equal(defaultRoot('/work/versions'), '/work/versions');
});

test('parseGoFlags maps every flag to go() options and needs --repo and --pr together', () => {
  assert.deepEqual(
    parseGoFlags(['--commit-message', 'msg', '--repo', 'acme/widgets', '--pr', 'pr.json', '--require-section', 'Mutation check', '--mutants', '--merge-method', 'rebase', '--timeout', '30']),
    { commitMessage: 'msg', repo: 'acme/widgets', payloadPath: 'pr.json', requireSections: ['Mutation check'], mergeMethod: 'rebase', timeoutMs: 30000, mutants: true },
  );
  assert.deepEqual(parseGoFlags([]), { commitMessage: undefined, repo: undefined, payloadPath: undefined, requireSections: [], mergeMethod: undefined, timeoutMs: undefined, mutants: false });
  assert.throws(() => parseGoFlags(['--repo', 'acme/widgets']), /requires --pr with --repo/);
  assert.equal(parseGoFlags(['--pr', 'pr.json']).payloadPath, 'pr.json');
  assert.throws(() => parseGoFlags(['--bogus']), /Unknown flag: --bogus/);
  assert.throws(() => parseGoFlags(['--timeout', '0']), /--timeout requires a positive number/);
});
