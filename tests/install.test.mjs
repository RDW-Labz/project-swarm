// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {installUser,installProject,pruneVersions} from '../tools/install.mjs';
const packageRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');

async function tempDir(t){const dir=await fs.mkdtemp(path.join(os.tmpdir(),'swarm-install-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));return fs.realpath(dir);}

// A plain (non-git) copy of the parts installUser/installProject read. Not a git checkout,
// so the uncommitted-changes guard has nothing to detect and --dev is never required here.
async function sourceFixture(t){
 const dir=await tempDir(t);
 for(const entry of ['tools','skills','docs','examples','templates','SECURITY.md','CONTRIBUTING.md','package.json'])await fs.cp(path.join(packageRoot,entry),path.join(dir,entry),{recursive:true});
 return dir;
}

// A minimal installUser source with its own tiny tools/swarm.mjs, independent of the real
// runner's sibling modules: only the module identity/realpath behavior is under test here.
async function minimalSourceFixture(t){
 const dir=await tempDir(t);
 await fs.writeFile(path.join(dir,'package.json'),JSON.stringify({name:'x',version:'1.0.0'}));
 await fs.mkdir(path.join(dir,'tools'),{recursive:true});
 await fs.writeFile(path.join(dir,'tools/swarm.mjs'),'export const marker=1;\n');
 await fs.mkdir(path.join(dir,'skills/project-swarm'),{recursive:true});
 await fs.writeFile(path.join(dir,'skills/project-swarm/SKILL.md'),'---\nname: project-swarm\ndescription: x\n---\nRunner: {{SWARM_RUNNER}}\n');
 await fs.writeFile(path.join(dir,'SECURITY.md'),'sec\n');
 await fs.writeFile(path.join(dir,'CONTRIBUTING.md'),'contrib\n');
 await fs.mkdir(path.join(dir,'docs'),{recursive:true});
 return dir;
}

test('installUser writes both agent skill targets with the runner path substituted and skips a missing home',async t=>{
 const source=await sourceFixture(t),home=await tempDir(t);
 await fs.mkdir(path.join(home,'.claude'));
 const result=await installUser({source,home});
 assert.equal(result.skipped.includes('.codex'),true);
 assert.equal(result.skillTargets.some(p=>p.includes(path.join('.claude','skills','project-swarm','SKILL.md'))),true);
 assert.equal(result.skillTargets.every(p=>!p.includes('.codex')),true);
 const skillPath=path.join(home,'.claude/skills/project-swarm/SKILL.md');
 const content=await fs.readFile(skillPath,'utf8');
 const runner=path.join(source,'current/tools/swarm.mjs');
 assert.equal(content.includes('{{SWARM_RUNNER}}'),false);
 assert.equal(content.includes(runner),true);
 for(const file of await fs.readdir(path.join(home,'.claude/skills/project-swarm/references')))assert.ok((await fs.stat(path.join(home,'.claude/skills/project-swarm/references',file))).size>0);
 const record=JSON.parse(await fs.readFile(path.join(source,'.swarm-install.json'),'utf8'));
 assert.equal(record.version,JSON.parse(await fs.readFile(path.join(source,'package.json'),'utf8')).version);
 assert.ok(Array.isArray(record.skillTargets)&&record.skillTargets.length>0);
 // Idempotent: rerunning writes the same set of files without error.
 const second=await installUser({source,home});
 assert.deepEqual(second.skillTargets.sort(),result.skillTargets.sort());
});

test('installUser writes into both agent homes when both exist',async t=>{
 const source=await sourceFixture(t),home=await tempDir(t);
 await fs.mkdir(path.join(home,'.claude'));await fs.mkdir(path.join(home,'.codex'));
 const result=await installUser({source,home});
 assert.deepEqual(result.skipped,[]);
 assert.equal(await fs.readFile(path.join(home,'.codex/skills/project-swarm/SKILL.md'),'utf8').then(()=>true),true);
});

test('installUser snapshots tools/ and package.json into versions/<version>-<hash8>, atomically repoints current, and records versionDir/runner',async t=>{
 const source=await sourceFixture(t),home=await tempDir(t);
 await fs.mkdir(path.join(home,'.claude'));
 const result=await installUser({source,home});
 const versionsDir=path.join(source,'versions');
 const entries=await fs.readdir(versionsDir);
 assert.equal(entries.length,1);
 assert.match(entries[0],/^\d+\.\d+\.\d+-[0-9a-f]{8}$/);
 const versionDir=path.join(versionsDir,entries[0]);
 const currentPath=path.join(source,'current');
 assert.equal((await fs.lstat(currentPath)).isSymbolicLink(),true);
 assert.equal(await fs.readlink(currentPath),versionDir);
 assert.equal(result.versionDir,versionDir);
 assert.equal(result.runner,path.join(currentPath,'tools/swarm.mjs'));
 const record=JSON.parse(await fs.readFile(path.join(source,'.swarm-install.json'),'utf8'));
 assert.equal(record.versionDir,versionDir);
 assert.equal(record.runner,path.join(currentPath,'tools/swarm.mjs'));
 // The rename() swap leaves no pid-tagged temp symlink behind.
 assert.deepEqual((await fs.readdir(source)).filter(name=>name.startsWith('current.tmp-')),[]);
});

test('re-installing with unchanged tools/ and package.json content reuses the same version dir',async t=>{
 const source=await sourceFixture(t),home=await tempDir(t);
 await fs.mkdir(path.join(home,'.claude'));
 const first=await installUser({source,home});
 const second=await installUser({source,home});
 assert.equal(second.versionDir,first.versionDir);
 assert.deepEqual(await fs.readdir(path.join(source,'versions')),[path.basename(first.versionDir)]);
});

test('a module resolved through current/ keeps its own realpath after a later install repoints current',async t=>{
 const source=await minimalSourceFixture(t),home=await tempDir(t);
 await fs.mkdir(path.join(home,'.claude'));
 await installUser({source,home});
 const currentSwarm=path.join(source,'current/tools/swarm.mjs');
 const realpathBefore=await fs.realpath(currentSwarm);
 const moduleBefore=await import(pathToFileURL(currentSwarm).href);
 await fs.appendFile(path.join(source,'tools/swarm.mjs'),'\n// force a new snapshot hash\n');
 await installUser({source,home});
 const realpathAfter=await fs.realpath(currentSwarm);
 assert.notEqual(realpathAfter,realpathBefore);
 assert.equal(await fs.access(realpathBefore).then(()=>true,()=>false),true);
 const stillOld=await import(pathToFileURL(realpathBefore).href);
 assert.equal(stillOld,moduleBefore);
 // In one process the loader caches current/ by specifier, so load the new snapshot by its realpath.
 const fresh=await import(pathToFileURL(realpathAfter).href);
 assert.notEqual(fresh,moduleBefore);
});

test('re-installing identical tools/ reuses the existing snapshot and never rewrites it under a live run',async t=>{
 const source=await minimalSourceFixture(t),home=await tempDir(t);
 await fs.mkdir(path.join(home,'.claude'));
 const first=await installUser({source,home});
 const liveMarker=path.join(first.versionDir,'tools/live-run-marker');
 await fs.writeFile(liveMarker,'in use');
 const second=await installUser({source,home});
 assert.equal(second.versionDir,first.versionDir);
 assert.equal(await fs.readFile(liveMarker,'utf8'),'in use');
 assert.equal((await fs.readdir(path.join(source,'versions'))).length,1);
});

test('pruneVersions keeps the 5 newest version dirs and never removes the one current points to',async t=>{
 const source=await tempDir(t);
 const versionsDir=path.join(source,'versions');
 await fs.mkdir(versionsDir,{recursive:true});
 const dirs=[];
 for(let index=0;index<7;index++){
  const dir=path.join(versionsDir,`1.0.${index}-aaaaaaaa`);
  await fs.mkdir(dir);
  await fs.utimes(dir,new Date(index*1000),new Date(index*1000));
  dirs.push(dir);
 }
 await fs.symlink(dirs[0],path.join(source,'current'));
 await pruneVersions(source);
 const remaining=(await fs.readdir(versionsDir)).sort();
 const expected=[dirs[0],...dirs.slice(2)].map(dir=>path.basename(dir)).sort();
 assert.deepEqual(remaining,expected);
 await assert.rejects(fs.access(dirs[1]));
});

test('installProject writes a pointer and the registry, and copies no runner',async t=>{
 const source=await sourceFixture(t),project=await tempDir(t);
 const result=await installProject(project,{source});
 assert.equal(result.status,'linked');
 const pointer=JSON.parse(await fs.readFile(path.join(project,'.project-swarm.json'),'utf8'));
 assert.equal(pointer.install,await fs.realpath(source));
 assert.equal(pointer.version,JSON.parse(await fs.readFile(path.join(source,'package.json'),'utf8')).version);
 const registry=JSON.parse(await fs.readFile(path.join(source,'.swarm-projects.json'),'utf8'));
 assert.deepEqual(registry,[await fs.realpath(project)]);
 assert.equal(result.coordinationCreated,true);
 assert.ok(result.added.includes('coordination/swarm-smoke.json'));
 assert.ok(result.added.includes('coordination/CONTRACT.md'));
 await assert.rejects(fs.access(path.join(project,'tools')));
 await assert.rejects(fs.access(path.join(project,'tests')));
 await assert.rejects(fs.access(path.join(project,'skills')));
});

test('installProject seeds missing coordination examples when the project already has some, and dedupes the registry',async t=>{
 const source=await sourceFixture(t),project=await tempDir(t);
 await fs.mkdir(path.join(project,'coordination'));
 await fs.writeFile(path.join(project,'coordination/custom.json'),'{}');
 const first=await installProject(project,{source});
 assert.equal(first.coordinationCreated,true);
 assert.ok(first.added.includes('coordination/ORCHESTRATOR.md'));
 assert.equal(await fs.readFile(path.join(project,'coordination/custom.json'),'utf8'),'{}');
 await installProject(project,{source});
 const registry=JSON.parse(await fs.readFile(path.join(source,'.swarm-projects.json'),'utf8'));
 assert.deepEqual(registry,[await fs.realpath(project)]);
});

test('installProject rejects a symlinked destination component',async t=>{
 const source=await sourceFixture(t),project=await tempDir(t),outside=await tempDir(t);
 await fs.symlink(outside,path.join(project,'coordination'));
 await assert.rejects(installProject(project,{source}),/Symlink refused/);
 assert.deepEqual(await fs.readdir(outside),[]);
});

test('installUser provides a resolved shared skill with references even without supported agent homes',async t=>{
 const source=await sourceFixture(t),home=await tempDir(t);
 const installed=await installUser({source,home});
 const skill=await fs.readFile(path.join(source,'current/skills/project-swarm/SKILL.md'),'utf8');
 assert.ok(skill.includes(installed.runner));assert.ok(!skill.includes('{{SWARM_RUNNER}}'));
 assert.ok((await fs.stat(path.join(source,'current/skills/project-swarm/references/kickoff.md'))).size>0);
 assert.deepEqual(installed.skipped,['.claude','.codex']);
});

test('installed guide references include the sweep goals JSON example',async t=>{
 const source=await sourceFixture(t),home=await tempDir(t);await fs.mkdir(path.join(home,'.codex'));
 await installUser({source,home});
 for(const skill of [path.join(source,'current/skills/project-swarm'),path.join(home,'.codex/skills/project-swarm')]){
  const example=JSON.parse(await fs.readFile(path.join(skill,'references/sweep-goals-example.json'),'utf8'));
  assert.ok(example.areas.length>0);
 }
});
