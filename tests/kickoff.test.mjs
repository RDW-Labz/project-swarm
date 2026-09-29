// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as swarm from '../tools/swarm.mjs';
import { API_AGENTS } from '../tools/api-adapters.mjs';
import { EXTRA_CLI_AGENTS } from '../tools/cli-adapters.mjs';
import { preflightProject } from '../tools/preflight.mjs';
const root=fileURLToPath(new URL('../',import.meta.url));
async function temp(t){const dir=await fs.mkdtemp(path.join(os.tmpdir(),'swarm-kickoff-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));return dir;}
const manifest={version:1,jobs:[{id:'a',agent:'openai',model:'fixture',context:[],outputs:[],prompt:'Review'}]};
test('adapter counts in every guide agree with the executable adapter list',async()=>{
 const count=swarm.AGENTS.length;
 assert.equal(count,2+EXTRA_CLI_AGENTS.length+API_AGENTS.length);
 const words=['zero','one','two','three','four','five','six','seven','eight','nine','ten'];let assertions=0;
 for(const file of ['README.md','skills/project-swarm/SKILL.md',...(await fs.readdir(path.join(root,'docs'))).filter(f=>f.endsWith('.md')).map(f=>`docs/${f}`)]){
  const text=await fs.readFile(path.join(root,file),'utf8');
  for(const match of text.matchAll(/\b(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s+(?:provider\s+)?adapters\b/gi)){
   assert.equal(words.includes(match[1].toLowerCase())?words.indexOf(match[1].toLowerCase()):Number(match[1]),count,file);assertions++;
  }
 }
 assert.ok(assertions>=3);
});
test('doctor probes only opt-in loopback endpoints and distinguishes configured from reachable',async t=>{
 let calls=0;
 const server=http.createServer((req,res)=>{calls++;assert.equal(req.url,'/api/tags');assert.equal(req.headers.authorization,undefined);res.writeHead(200,{'content-type':'application/json'});res.end('{"models":[]}');});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>server.close());
 const env={SWARM_OLLAMA_URL:`http://127.0.0.1:${server.address().port}`,OLLAMA_API_KEY:'never-send'};
 const unprobed=await swarm.doctor({agent:'ollama',env});assert.equal(unprobed.reachable,null);assert.equal(calls,0);
 const live=await swarm.doctor({agent:'ollama',env,probeLocal:true});assert.equal(live.status,'reachable');assert.equal(live.reachable,true);assert.equal(live.liveVerified,false);assert.equal(calls,1);
 await new Promise(resolve=>server.close(resolve));
 const offline=await swarm.doctor({agent:'ollama',env,probeLocal:true});assert.equal(offline.configured,true);assert.equal(offline.reachable,false);assert.equal(offline.status,'unreachable');
});
test('doctor never probes cloud credentials or remote origins even with local probe opt-in',async()=>{
 for(const [agent,env] of [['openai',{OPENAI_API_KEY:'secret'}],['gemini',{GEMINI_API_KEY:'secret'}],['lambda',{LAMBDA_API_KEY:'secret'}],['ollama',{SWARM_OLLAMA_URL:'https://example.invalid'}]]){
  const result=await swarm.doctor({agent,env,probeLocal:true,fetchImpl:()=>assert.fail('cloud network request')});
  assert.equal(result.reachable,null);assert.equal(result.liveVerified,false);assert.ok(!JSON.stringify(result).includes('secret'));
 }
});
test('local probe has a short timeout and refuses redirects out of localhost',async()=>{
 let options;
 const result=await swarm.doctor({agent:'ollama',probeLocal:true,probeTimeoutMs:25,fetchImpl:async(_url,opts)=>{
  options=opts;return new Promise((resolve,reject)=>opts.signal.addEventListener('abort',()=>reject(Error('timeout')),{once:true}));
 }});
 assert.equal(result.reachable,false);assert.equal(options.redirect,'error');
});
test('doctor and preflight warn about root tool configs without swarm exclusions',async t=>{
 const project=await temp(t);
 for(const [file,text] of Object.entries({'tsconfig.json':'{"include":["**/*.ts"]}','vitest.config.ts':'export default { test: {} }','jest.config.cjs':'module.exports = {}','pytest.ini':'[pytest]\n','eslint.config.mjs':'export default []','playwright.config.ts':'export default {}'}))await fs.writeFile(path.join(project,file),text);
 const report=await preflightProject(project,manifest);
 assert.equal(report.advisories.filter(a=>a.code==='swarm-tool-exclusion').length,6);
 const cli=JSON.parse(execFileSync(process.execPath,[path.join(root,'tools/swarm.mjs'),'--root',project,'doctor','ollama'],{encoding:'utf8'}));
 assert.equal(cli.warnings.filter(a=>a.code==='swarm-tool-exclusion').length,6);
});
test('explicit tool exclusions suppress warnings; unrelated swarm strings do not',async t=>{
 const project=await temp(t);
 await fs.writeFile(path.join(project,'tsconfig.json'),'// JSONC\n{"include":["**/*.ts"],"exclude":[".swarm"],}');
 await fs.writeFile(path.join(project,'vitest.config.ts'),"export default { test: { exclude: ['**/.swarm/**'] } }");
 await fs.writeFile(path.join(project,'jest.config.cjs'),"module.exports={testPathIgnorePatterns:['<rootDir>/.swarm/']}");
 await fs.writeFile(path.join(project,'pytest.ini'),'[pytest]\nnorecursedirs = .swarm .git\n');
 assert.deepEqual((await preflightProject(project,manifest)).advisories,[]);
 await fs.writeFile(path.join(project,'tsconfig.json'),'{"include":["**/*.ts"],"description":".swarm"}');
 assert.equal((await preflightProject(project,manifest)).advisories[0].path,'tsconfig.json');
});
test('kickoff supplies generic seats, provider consent, budget, and exact handoff',async()=>{
 const kickoff=await fs.readFile(path.join(root,'docs/kickoff.md'),'utf8');
 for(const word of ['Claude Code','Codex CLI','Cursor','Gemini CLI','spend ceiling','--no-agent-files','--probe-local'])assert.ok(kickoff.includes(word),word);
 const seat=await fs.readFile(path.join(root,'templates/coordination/ORCHESTRATOR.md'),'utf8');
 assert.ok(seat.includes('You are orchestrator. Read coordination/ORCHESTRATOR.md, then coordination/HANDOFF.md,\nthen coordination/TASK.md. Confirm the done-when in one line, then continue.\nPaste that into a fresh terminal. This chat is done.'));
 for(const word of ['10th build dispatch','tierReason','one writer per file','mutation','swarm-lessons.md'])assert.ok(seat.includes(word),word);
});
test('#237: boot pre-approval paragraph is present in both the orchestrator template and kickoff.md',async()=>{
 const preApproval="Work already in TASK.md is pre-approved at boot; start it right away. The\nhuman's typed confirm is needed only for new tickets, secrets, model keys,\npublic lessons, and anything that spends credits or money.";
 const seat=await fs.readFile(path.join(root,'templates/coordination/ORCHESTRATOR.md'),'utf8');
 const kickoff=await fs.readFile(path.join(root,'docs/kickoff.md'),'utf8');
 assert.ok(seat.includes(preApproval));
 assert.ok(kickoff.includes(preApproval));
});
