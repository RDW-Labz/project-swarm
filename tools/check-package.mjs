#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { validateManifest } from './swarm.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const required=['README.md','LICENSE','NOTICE','SECURITY.md','CONTRIBUTING.md','CHANGELOG.md','skills/project-swarm/SKILL.md','docs/kickoff.md','docs/field-report.md','templates/coordination/ORCHESTRATOR.md','templates/coordination/HANDOFF.md','templates/coordination/TASK.md','templates/coordination/swarm-lessons.md','templates/coordination/CONTRACT.md','templates/agent-pointers/AGENTS.md','templates/agent-pointers/CLAUDE.md','templates/agent-pointers/cursor-rule.mdc','.github/workflows/ci.yml'];
for(const file of required)assert.ok((await fs.stat(path.join(root,file))).size>0,file);
const license=await fs.readFile(path.join(root,'LICENSE'),'utf8');
assert.match(license,/Apache License/);assert.match(license,/Version 2.0, January 2004/);assert.match(license,/END OF TERMS AND CONDITIONS/);
const files=[];
async function walk(dir){for(const entry of await fs.readdir(dir,{withFileTypes:true})){if(['.git','.swarm','node_modules','.tmp-e2e','.swarm-inputs','versions','current'].includes(entry.name))continue;const p=path.join(dir,entry.name);if(entry.isDirectory())await walk(p);else files.push(p);}}
await walk(root);
for(const file of files){
 const rel=path.relative(root,file);
 assert.ok(!/(^|\/)\.env(?:\.|$)|provider\.jsonl|stderr\.log/.test(rel),`Private artifact: ${rel}`);
 if(file.endsWith('.mjs'))execFileSync(process.execPath,['--check',file]);
 if(file.endsWith('.md')){
  const content=await fs.readFile(file,'utf8');
  for(const match of content.matchAll(/\]\(([^)]+)\)/g)){
   const target=match[1].split('#')[0];if(!target||/^[a-z]+:/.test(target))continue;
   // Skill reference paths are materialized by the installer from docs/.
   const destination=rel==='skills/project-swarm/SKILL.md'&&target.startsWith('references/')?path.join(root,'docs',target.slice(11)):path.resolve(path.dirname(file),target);
   await fs.access(destination);
  }
 }
}
for(const file of await fs.readdir(path.join(root,'examples')))validateManifest(JSON.parse(await fs.readFile(path.join(root,'examples',file),'utf8')));
const pkg=JSON.parse(await fs.readFile(path.join(root,'package.json'),'utf8'));
assert.equal(pkg.license,'Apache-2.0');assert.match(pkg.version,/^\d+\.\d+\.\d+$/);assert.equal(pkg.private,true);
assert.match(await fs.readFile(path.join(root,'skills/project-swarm/SKILL.md'),'utf8'),/^---\r?\nname: project-swarm\r?\ndescription: /);
console.log(`Package checks passed: ${files.length} files, syntax, links, license, skill, examples.`);
