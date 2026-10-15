// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { installProject } from '../tools/install.mjs';
const sourceRoot=fileURLToPath(new URL('../',import.meta.url));
async function fixture(t){
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'swarm-link-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const source=path.join(dir,'install'),root=path.join(dir,'project');await fs.mkdir(source);await fs.mkdir(root);
 for(const entry of ['package.json','examples','templates'])await fs.cp(path.join(sourceRoot,entry),path.join(source,entry),{recursive:true}).catch(e=>{if(e.code!=='ENOENT')throw e;});
 return {source,root};
}
test('link preserves user text and updates exactly one agent block in place for every agent',async t=>{
 const {source,root}=await fixture(t);
 for(const file of ['AGENTS.md','CLAUDE.md'])await fs.writeFile(path.join(root,file),'User instructions\n');
 await installProject(root,{source});
 for(const file of ['AGENTS.md','CLAUDE.md','.cursor/rules/project-swarm.mdc']){
  const text=await fs.readFile(path.join(root,file),'utf8');
  assert.ok(text.includes(path.join(source,'current/skills/project-swarm/SKILL.md')));
  assert.ok(text.includes(path.join(source,'docs/kickoff.md')));assert.match(text,/coordination\/ORCHESTRATOR.md/);
  assert.equal(text.match(/<!-- project-swarm:start -->/g)?.length,1);
  await fs.appendFile(path.join(root,file),'\nUser suffix\n');
 }
 const moved=path.join(path.dirname(source),'other-install');await fs.cp(source,moved,{recursive:true});
 await installProject(root,{source:moved});await installProject(root,{source:moved});
 for(const file of ['AGENTS.md','CLAUDE.md','.cursor/rules/project-swarm.mdc']){
  const text=await fs.readFile(path.join(root,file),'utf8');
  assert.match(text,/User suffix/);assert.ok(text.includes(path.join(moved,'current/skills/project-swarm/SKILL.md')));
  assert.ok(!text.includes(path.join(source,'current/skills/project-swarm/SKILL.md')));
  assert.equal(text.match(/<!-- project-swarm:start -->/g)?.length,1);
  if(file.endsWith('.md'))assert.match(text,/^User instructions\n/);else assert.match(text,/alwaysApply: true/);
 }
});
test('link seeds each missing coordination file, reports kept files, and never overwrites',async t=>{
 const {source,root}=await fixture(t);await fs.mkdir(path.join(root,'coordination'));
 await fs.writeFile(path.join(root,'coordination/TASK.md'),'my task');
 await fs.writeFile(path.join(root,'coordination/custom.md'),'custom');
 const first=await installProject(root,{source});
 assert.ok(first.kept.includes('coordination/TASK.md'));
 for(const file of ['ORCHESTRATOR.md','HANDOFF.md','swarm-lessons.md','swarm-smoke.json'])assert.ok(first.added.includes(`coordination/${file}`));
 assert.equal(await fs.readFile(path.join(root,'coordination/TASK.md'),'utf8'),'my task');
 const second=await installProject(root,{source});assert.deepEqual(second.added,[]);assert.equal(second.kept.length,first.added.length+first.kept.length);
 assert.equal(await fs.readFile(path.join(root,'coordination/custom.md'),'utf8'),'custom');
});
test('link adds an effective .swarm ignore without duplicating it or clobbering text',async t=>{
 const {source,root}=await fixture(t);await fs.writeFile(path.join(root,'.gitignore'),'custom\n');
 await installProject(root,{source});await installProject(root,{source});
 assert.equal(await fs.readFile(path.join(root,'.gitignore'),'utf8'),'custom\n.claude/settings.local.json\n.swarm/\n');
 // An earlier ignore cancelled by a later negation must not fool the installer.
 await fs.writeFile(path.join(root,'.gitignore'),'.swarm/\n!.swarm/\n');
 await installProject(root,{source});execFileSync('git',['init'],{cwd:root,stdio:'ignore'});
 assert.match(execFileSync('git',['check-ignore','.swarm/example.test.ts'],{cwd:root,encoding:'utf8'}),/\.swarm/);
});
test('link --no-agent-files leaves agent files alone but still seeds and ignores runtime data',async t=>{
 const {source,root}=await fixture(t);await fs.writeFile(path.join(root,'AGENTS.md'),'keep');
 await installProject(root,{source,agentFiles:false});
 assert.equal(await fs.readFile(path.join(root,'AGENTS.md'),'utf8'),'keep');
 await assert.rejects(fs.access(path.join(root,'CLAUDE.md')));await assert.rejects(fs.access(path.join(root,'.cursor')));
 assert.match(await fs.readFile(path.join(root,'.gitignore'),'utf8'),/\.swarm\//);
});
const AGENT_START='<!-- project-swarm:start -->',AGENT_END='<!-- project-swarm:end -->';
test('link refuses a lone start marker with no matching end marker and leaves AGENTS.md untouched',async t=>{
 const {source,root}=await fixture(t);
 const before=`User instructions\n${AGENT_START}\nmore text\n`;
 await fs.writeFile(path.join(root,'AGENTS.md'),before);
 await assert.rejects(installProject(root,{source}),/Malformed project-swarm markers/);
 assert.equal(await fs.readFile(path.join(root,'AGENTS.md'),'utf8'),before);
});
test('link refuses two start markers with only one end marker and leaves AGENTS.md untouched',async t=>{
 const {source,root}=await fixture(t);
 const before=`${AGENT_START}\nfoo\n${AGENT_START}\nbar\n${AGENT_END}\n`;
 await fs.writeFile(path.join(root,'AGENTS.md'),before);
 await assert.rejects(installProject(root,{source}),/Malformed project-swarm markers/);
 assert.equal(await fs.readFile(path.join(root,'AGENTS.md'),'utf8'),before);
});
test('link refuses symlinked agent and ignore paths without writing outside the project',async t=>{
 for(const file of ['AGENTS.md','CLAUDE.md','.cursor','.gitignore']){
  const {source,root}=await fixture(t),outside=path.join(path.dirname(root),`outside-${file.replaceAll('.','')}`);
  if(file==='.cursor')await fs.mkdir(outside);else await fs.writeFile(outside,'private');
  await fs.symlink(outside,path.join(root,file));
  await assert.rejects(installProject(root,{source}),/Symlink refused/);
  if(file!=='.cursor')assert.equal(await fs.readFile(outside,'utf8'),'private');
 }
});
