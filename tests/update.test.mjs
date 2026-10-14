// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {swarmVersion,updateInstall,updateProjects,onboardReport} from '../tools/swarm.mjs';
const packageRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const execFileAsync=promisify(execFile);

async function tempDir(t){const dir=await fs.mkdtemp(path.join(os.tmpdir(),'swarm-update-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));return fs.realpath(dir);}
async function git(cwd,args){return (await execFileAsync('git',args,{cwd,encoding:'utf8'})).stdout;}
async function initRepo(dir){await git(dir,['init']);await git(dir,['checkout','-b','main']);await git(dir,['config','user.email','test@example.com']);await git(dir,['config','user.name','Test']);}
async function commitAll(dir,message){await git(dir,['add','-A']);await git(dir,['commit','-m',message]);}

// A minimal versioned checkout with a real origin remote: enough for gitDirty, fetch --tags,
// checkout --detach, and installUser's file reads to all behave like a real release checkout.
async function updateFixture(t){
 const root=await tempDir(t);
 await initRepo(root);
 await fs.mkdir(path.join(root,'tools'));await fs.writeFile(path.join(root,'tools/.keep'),'');
 await fs.mkdir(path.join(root,'skills/project-swarm'),{recursive:true});
 await fs.writeFile(path.join(root,'skills/project-swarm/SKILL.md'),'---\nname: project-swarm\ndescription: x\n---\nRunner: {{SWARM_RUNNER}}\n');
 await fs.writeFile(path.join(root,'SECURITY.md'),'sec\n');
 await fs.writeFile(path.join(root,'CONTRIBUTING.md'),'contrib\n');
 await fs.mkdir(path.join(root,'docs'));await fs.writeFile(path.join(root,'docs/guide.md'),'guide\n');
 await fs.writeFile(path.join(root,'package.json'),JSON.stringify({name:'project-swarm',version:'1.0.0'},null,2));
 await fs.writeFile(path.join(root,'CHANGELOG.md'),'# Changelog\n\n## Unreleased\n\n- wip\n\n## 1.0.0\n\n- feature A\n');
 await commitAll(root,'v1.0.0');await git(root,['tag','v1.0.0']);
 await fs.writeFile(path.join(root,'package.json'),JSON.stringify({name:'project-swarm',version:'1.1.0'},null,2));
 await fs.writeFile(path.join(root,'CHANGELOG.md'),'# Changelog\n\n## Unreleased\n\n- wip\n\n## 1.1.0\n\n- feature B\n\n## 1.0.0\n\n- feature A\n');
 await commitAll(root,'v1.1.0');await git(root,['tag','v1.1.0']);
 const origin=await tempDir(t);
 await execFileAsync('git',['init','--bare',origin]);
 await git(root,['remote','add','origin',origin]);
 await git(root,['push','origin','--tags']);
 return root;
}

test('version --check picks the highest semver tag from origin (v1.10.0 beats v1.9.0)',async t=>{
 const root=await tempDir(t);
 await initRepo(root);
 await fs.writeFile(path.join(root,'package.json'),JSON.stringify({name:'x',version:'1.0.0'}));
 await commitAll(root,'init');
 const origin=await tempDir(t);
 await execFileAsync('git',['init','--bare',origin]);
 await git(root,['remote','add','origin',origin]);
 await git(root,['tag','v1.9.0']);await git(root,['tag','v1.10.0']);
 await git(root,['push','origin','--tags']);
 const result=await swarmVersion(root,{check:true});
 assert.equal(result.version,'1.0.0');
 assert.equal(result.latest,'1.10.0');
 assert.equal(result.updateAvailable,true);
});

test('version --check reports checkError when the remote cannot be reached',async t=>{
 const root=await tempDir(t);
 await initRepo(root);
 await fs.writeFile(path.join(root,'package.json'),JSON.stringify({name:'x',version:'1.0.0'}));
 await commitAll(root,'init');
 const result=await swarmVersion(root,{check:true});
 assert.equal(result.latest,null);
 assert.equal(typeof result.checkError,'string');
 assert.ok(result.checkError.length>0&&result.checkError.length<=200);
});

test('update refuses on uncommitted changes to tools/',async t=>{
 const root=await updateFixture(t);
 await git(root,['checkout','v1.0.0']);
 await fs.writeFile(path.join(root,'tools/.keep'),'dirty');
 await assert.rejects(updateInstall(root),/uncommitted changes/);
});

test('update is a no-op when already on the newest tag',async t=>{
 const root=await updateFixture(t);
 const result=await updateInstall(root);
 assert.deepEqual(result,{from:'1.1.0',to:'1.1.0',upToDate:true});
});

test('update moves to the newest tag and reports the changelog between versions',async t=>{
 const root=await updateFixture(t);
 await git(root,['checkout','v1.0.0']);
 const home=await tempDir(t);await fs.mkdir(path.join(home,'.claude'));
 const result=await updateInstall(root,{home,doctorAllImpl:async()=>({status:"report",providers:[]})});
 assert.equal(result.from,'1.0.0');
 assert.equal(result.to,'1.1.0');
 assert.equal(result.changelog.length,1);
 assert.match(result.changelog[0],/## 1\.1\.0/);
 assert.match(result.changelog[0],/feature B/);
 assert.doesNotMatch(result.changelog.join('\n'),/feature A/);
 const skill=await fs.readFile(path.join(home,'.claude/skills/project-swarm/SKILL.md'),'utf8');
 assert.equal(skill.includes(path.join(root,'current/tools/swarm.mjs')),true);
});

test('update --projects reports old copies without --yes and replaces them with --yes, moving only swarm-owned files and leaving the project\'s own tools/, tests/, coordination/ and .swarm/ untouched',async t=>{
 const root=await tempDir(t);
 await fs.writeFile(path.join(root,'package.json'),JSON.stringify({name:'x',version:'1.1.0'}));
 const project=await tempDir(t);
 await fs.mkdir(path.join(project,'tools'),{recursive:true});await fs.writeFile(path.join(project,'tools/swarm.mjs'),'// old copy');
 await fs.mkdir(path.join(project,'skills/project-swarm'),{recursive:true});await fs.writeFile(path.join(project,'skills/project-swarm/SKILL.md'),'old skill');
 await fs.mkdir(path.join(project,'tests'),{recursive:true});await fs.writeFile(path.join(project,'tests/swarm.test.mjs'),'// old swarm test');
 await fs.writeFile(path.join(project,'tests/own.test.mjs'),'// the project\'s own test');
 await fs.writeFile(path.join(project,'tools/own-tool.mjs'),'// the project\'s own tool');
 await fs.mkdir(path.join(project,'coordination'),{recursive:true});await fs.writeFile(path.join(project,'coordination/keep.json'),'{}');
 await fs.mkdir(path.join(project,'.swarm/runs'),{recursive:true});await fs.writeFile(path.join(project,'.swarm/runs/marker.txt'),'run data');

 const dryRun=await updateProjects(root,{projects:[project]});
 assert.equal(dryRun.projects[0].action,'would replace with pointer');
 assert.deepEqual(dryRun.projects[0].found,['old-copy']);
 assert.equal(await fs.access(path.join(project,'.project-swarm.json')).then(()=>true,()=>false),false);

 const applied=await updateProjects(root,{projects:[project],yes:true});
 assert.equal(applied.projects[0].action,'replaced');
 const pointer=JSON.parse(await fs.readFile(path.join(project,'.project-swarm.json'),'utf8'));
 assert.equal(pointer.install,root);
 assert.equal(pointer.version,'1.1.0');
 await assert.rejects(fs.access(path.join(project,'tools/swarm.mjs')));
 await assert.rejects(fs.access(path.join(project,'tests/swarm.test.mjs')));
 await assert.rejects(fs.access(path.join(project,'skills/project-swarm')));
 assert.equal(await fs.readFile(path.join(project,'tests/own.test.mjs'),'utf8'),'// the project\'s own test');
 assert.equal(await fs.readFile(path.join(project,'tools/own-tool.mjs'),'utf8'),'// the project\'s own tool');
 assert.equal(await fs.readFile(path.join(project,'coordination/keep.json'),'utf8'),'{}');
 assert.equal(await fs.readFile(path.join(project,'.swarm/runs/marker.txt'),'utf8'),'run data');
 const backup=applied.projects[0].backup;
 assert.ok(backup.startsWith(path.join(project,'.swarm-old-copy-')));
 assert.equal(await fs.readFile(path.join(backup,'tools/swarm.mjs'),'utf8'),'// old copy');
 assert.equal(await fs.readFile(path.join(backup,'tests/swarm.test.mjs'),'utf8'),'// old swarm test');
 assert.equal(await fs.readFile(path.join(backup,'skills/project-swarm/SKILL.md'),'utf8'),'old skill');
});

test('update --projects defaults to the install\'s project registry and reports up-to-date projects',async t=>{
 const root=await tempDir(t);
 await fs.writeFile(path.join(root,'package.json'),JSON.stringify({name:'x',version:'1.0.0'}));
 const project=await tempDir(t);
 await fs.writeFile(path.join(root,'.swarm-projects.json'),JSON.stringify([project]));
 const result=await updateProjects(root);
 assert.equal(result.projects[0].project,project);
 assert.equal(result.projects[0].action,'up-to-date');
});

test('onboard lists ready and needs-setup agents from an injected doctor and stays under 80 lines',async t=>{
 const fakeDoctorAll=async()=>({status:'report',providers:[
  {agent:'claude',status:'compatible'},
  {agent:'codex',status:'unsupported',note:'macOS seatbelt is required'},
  {agent:'openai',configured:true},
  {agent:'ollama',configured:false}
 ]});
 const output=await onboardReport('/unused',{doctorAllImpl:fakeDoctorAll});
 assert.match(output,/- claude: compatible \(smoke required\)/);
 assert.match(output,/- codex: needs setup — macOS seatbelt is required/);
 assert.match(output,/- openai: configured; reachability not checked/);
 assert.match(output,/- ollama: needs setup — run: node tools\/swarm\.mjs doctor ollama/);
 assert.ok(output.split('\n').length<=80);
});

test('validate in a project linked to a different swarm version prints one warning to stderr and still succeeds',async t=>{
 const project=await tempDir(t);
 const manifest={version:1,jobs:[{id:'job',agent:'openai',sensitive:false,model:'gpt-4o-mini',prompt:'do work',context:[],outputs:[]}]};
 await fs.mkdir(path.join(project,'coordination'));
 await fs.writeFile(path.join(project,'coordination/manifest.json'),JSON.stringify(manifest));
 const installedVersion=JSON.parse(await fs.readFile(path.join(packageRoot,'package.json'),'utf8')).version;
 await fs.writeFile(path.join(project,'.project-swarm.json'),JSON.stringify({install:'/elsewhere',version:`${installedVersion}-old`}));
 const {stdout,stderr}=await execFileAsync(process.execPath,[path.join(packageRoot,'tools/swarm.mjs'),'--root',project,'validate','coordination/manifest.json'],{encoding:'utf8'});
 assert.match(stderr,/Warning:.*swarm update/);
 assert.equal(JSON.parse(stdout).status,'valid');
});

test('update and version with --root refuse before git and leave the project HEAD and branch untouched',async t=>{
 const project=await tempDir(t);await initRepo(project);
 await fs.writeFile(path.join(project,'package.json'),JSON.stringify({name:'customer-project',version:'0.1.0'}));
 await commitAll(project,'tagged');await git(project,['tag','v99.0.0']);
 await fs.writeFile(path.join(project,'later.txt'),'unreleased');await commitAll(project,'later');
 const before=await git(project,['rev-parse','HEAD']);
 for(const command of ['update','version'])for(const args of [['--root',project,command],[command,'--root',project]]){
  await assert.rejects(execFileAsync(process.execPath,[path.join(packageRoot,'tools/swarm.mjs'),...args]),error=>{
   assert.match(error.stderr,/--root.*not allowed.*shared install/);return true;
  });
  assert.equal(await git(project,['rev-parse','HEAD']),before);assert.equal((await git(project,['branch','--show-current'])).trim(),'main');
 }
});
test('updateInstall rejects a non-swarm checkout before fetching or checking out tags',async t=>{
 const project=await tempDir(t);await initRepo(project);await fs.writeFile(path.join(project,'package.json'),JSON.stringify({name:'other',version:'0.1.0'}));
 await commitAll(project,'base');await git(project,['tag','v99.0.0']);
 await assert.rejects(updateInstall(project),/project-swarm install/);
 assert.equal((await git(project,['branch','--show-current'])).trim(),'main');
});

test('update refuses nested installs and foreign release tags without moving HEAD',async t=>{
 const root=await updateFixture(t),nested=path.join(root,'nested');await fs.mkdir(nested);
 await fs.writeFile(path.join(nested,'package.json'),JSON.stringify({name:'project-swarm',version:'1.0.0'}));
 await assert.rejects(updateInstall(nested),/install must be its own git checkout/);
 await fs.writeFile(path.join(root,'package.json'),JSON.stringify({name:'other-project',version:'99.0.0'}));
 await commitAll(root,'foreign release');await git(root,['tag','v99.0.0']);await git(root,['checkout','v1.0.0']);
 const before=await git(root,['rev-parse','HEAD']);
 await assert.rejects(updateInstall(root),/release tag is not a matching project-swarm install/);
 assert.equal(await git(root,['rev-parse','HEAD']),before);
});
