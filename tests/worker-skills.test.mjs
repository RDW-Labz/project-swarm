// SPDX-License-Identifier: Apache-2.0
// Lesson #152: imported directly (not only via the package.json test script) so this file stays
// hermetic even run alone as `node --test tests/worker-skills.test.mjs`.
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { runManifest, integrateRun, validateManifest, validateProject } from '../tools/swarm.mjs';
import { parseYamlSubset, parseSkillFrontmatter, validateSkillFrontmatter, tokenEstimate, skillSizeWarnings, refuseOversizeSkills, attachSkillsForJob, skillIndexBlock, skillPrependBlock, skillsPromptBlock, skillRecordEntries, skillCheckFailures, gitBlobHash, assertNoSkillSymlinks, listSkills } from '../tools/skills.mjs';
import { reworkBySkill } from '../tools/session-metrics.mjs';
import { codexMessage } from '../tools/codex-adapter.mjs';
import { shellMessage } from '../tools/claude-shell.mjs';
import { executeApi } from '../tools/api-adapters.mjs';

const execFileAsync = promisify(execFile);
const CLI = fileURLToPath(new URL('../tools/swarm.mjs', import.meta.url));

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-skills-test-'));
  await fs.writeFile(path.join(root, 'input.txt'), 'original');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}
async function writeSkill(dir, name, { description = 'A test skill.', paths, checks, body = 'Full skill body text.' } = {}) {
  const lines = [`name: ${name}`, `description: ${description}`];
  if (paths) { lines.push('paths:'); for (const value of paths) lines.push(`  - ${value}`); }
  if (checks) {
    lines.push('checks:');
    if (checks.filesMustChange) { lines.push('  filesMustChange:'); for (const value of checks.filesMustChange) lines.push(`    - ${value}`); }
    if (checks.resultKeys) { lines.push('  resultKeys:'); for (const value of checks.resultKeys) lines.push(`    - ${value}`); }
  }
  const skillDir = path.join(dir, name);
  await fs.mkdir(skillDir, { recursive: true });
  await fs.writeFile(path.join(skillDir, 'SKILL.md'), `---\n${lines.join('\n')}\n---\n${body}\n`);
}

const job = (overrides = {}) => ({ id: 'writer', agent: 'claude', model: 'sonnet', prompt: 'Update the assigned file.', context: ['input.txt'], outputs: ['input.txt'], timeoutMs: 5000, ...overrides });
const manifest = (jobs, overrides = {}) => ({ version: 1, concurrency: 2, jobs: jobs ?? [job()], ...overrides });
function fake(script) {
  return (_command, _args, options) => spawn(process.execPath, ['--input-type=module', '-e', `import fs from 'node:fs';\n${script}`], options);
}
const done = result => `console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,result:${JSON.stringify(result)}}));`;
const update = fake(`fs.writeFileSync('input.txt','updated'); ${done('Worker complete')}`);

test('off by default: no skillsDir and no config leaves every prompt byte-identical', async t => {
  const root = await fixture(t);
  const bare = await runManifest(root, manifest(), { id: 'bare', spawnImpl: update });
  const bareMessage = await fs.readFile(path.join(root, '.swarm/runs/bare/writer/message.txt'), 'utf8');
  // An empty skills dir is still "off": zero skills found, so the prompt block stays ''.
  const emptyDir = path.join(root, 'empty-skills');
  await fs.mkdir(emptyDir);
  const withEmptyDir = await runManifest(root, manifest([job()], { skillsDir: emptyDir }), { id: 'empty-dir', spawnImpl: update });
  const withEmptyDirMessage = await fs.readFile(path.join(root, '.swarm/runs/empty-dir/writer/message.txt'), 'utf8');
  assert.equal(withEmptyDirMessage, bareMessage);
  assert.ok(!bareMessage.includes('Skills in .swarm/skills/'));
  // The adapters' own message builders default `skills` to '': unchanged from before this file existed.
  assert.equal(codexMessage(job()), codexMessage(job(), { skills: '' }));
  assert.equal(shellMessage(job(), { files: [] }), shellMessage(job(), { files: [], skills: '' }));
});

test('skills copy into the job workspace, git-ignored, never part of a diff or integration', async t => {
  const root = await fixture(t);
  const skillsDir = path.join(root, 'skills');
  await writeSkill(skillsDir, 'formatting', {});
  const state = await runManifest(root, manifest([job()], { skillsDir }), { spawnImpl: update });
  const copied = path.join(root, '.swarm/workspaces', state.id, 'writer/.swarm/skills/formatting/SKILL.md');
  assert.match(await fs.readFile(copied, 'utf8'), /name: formatting/);
  const result = await integrateRun(root, state.id);
  assert.deepEqual(result.files, ['input.txt']);
});

test('every job prompt gets one index line per skill, name and description only', async t => {
  const root = await fixture(t);
  const skillsDir = path.join(root, 'skills');
  await writeSkill(skillsDir, 'formatting', { description: 'Keep files tidy.' });
  const state = await runManifest(root, manifest([job()], { skillsDir }), { spawnImpl: update });
  const message = await fs.readFile(path.join(root, '.swarm/runs', state.id, 'writer/message.txt'), 'utf8');
  const indexLine = message.split('\n').find(line => line.startsWith('Skills in .swarm/skills/: formatting'));
  assert.equal(indexLine, 'Skills in .swarm/skills/: formatting — Keep files tidy. — .swarm/skills/formatting/SKILL.md — read it if your job touches this');
  assert.ok(!message.includes('Full skill body text.'), 'index-only: the body is never prepended');
});

test('a named skill prepends its full SKILL.md body', async t => {
  const root = await fixture(t);
  const skillsDir = path.join(root, 'skills');
  await writeSkill(skillsDir, 'formatting', { body: 'Verbatim body content, unique-marker-93214.' });
  const state = await runManifest(root, manifest([job({ skills: ['formatting'] })], { skillsDir }), { spawnImpl: update });
  const message = await fs.readFile(path.join(root, '.swarm/runs', state.id, 'writer/message.txt'), 'utf8');
  const indexLine = message.split('\n').find(line => line.startsWith('Skills in .swarm/skills/: formatting'));
  assert.equal(indexLine, 'Skills in .swarm/skills/: formatting — A test skill.', 'named: the index line is unchanged, no path pointer');
  assert.ok(message.includes('Verbatim body content, unique-marker-93214.'));
});

test('an unknown named skill refuses at validate, before any worker runs', async t => {
  const root = await fixture(t);
  const skillsDir = path.join(root, 'skills');
  await writeSkill(skillsDir, 'formatting', {});
  await assert.rejects(validateProject(root, manifest([job({ skills: ['nope'] })], { skillsDir })), /unknown-skill: nope/);
  let calls = 0;
  const state = await runManifest(root, manifest([job({ skills: ['nope'] })], { skillsDir }), { spawnImpl: () => { calls++; throw Error('unexpected'); } });
  assert.equal(calls, 0);
  assert.equal(state.status, 'failed');
  assert.match(state.error, /unknown-skill: nope/);
});

test('frontmatter paths: globs auto-attach a skill whose glob matches job context/outputs', async t => {
  const root = await fixture(t);
  const skillsDir = path.join(root, 'skills');
  await writeSkill(skillsDir, 'inputs', { paths: ['input.*'], body: 'Auto-attached body, marker-55210.' });
  const state = await runManifest(root, manifest([job()], { skillsDir }), { spawnImpl: update });
  const message = await fs.readFile(path.join(root, '.swarm/runs', state.id, 'writer/message.txt'), 'utf8');
  assert.ok(message.includes('Auto-attached body, marker-55210.'));
});

test('a manifest skills list, even [], overrides paths auto-attach', async t => {
  const root = await fixture(t);
  const skillsDir = path.join(root, 'skills');
  await writeSkill(skillsDir, 'inputs', { paths: ['input.*'], body: 'Would auto-attach, marker-77120.' });
  const state = await runManifest(root, manifest([job({ skills: [] })], { skillsDir }), { spawnImpl: update });
  const message = await fs.readFile(path.join(root, '.swarm/runs', state.id, 'writer/message.txt'), 'utf8');
  assert.ok(!message.includes('Would auto-attach, marker-77120.'));
  // Still indexed: an overridden-away skill is index-only, not invisible.
  assert.match(message, /Skills in \.swarm\/skills\/: inputs/);
  assert.deepEqual(state.jobs[0].skills, [{ name: 'inputs', gitHash: state.jobs[0].skills[0].gitHash, attached: 'index-only' }]);
});

test('a filesMustChange check with no matching changed file fails integrate as skill-check-failed', async t => {
  const root = await fixture(t);
  const skillsDir = path.join(root, 'skills');
  await writeSkill(skillsDir, 'coverage', { checks: { filesMustChange: ['docs/*.md'] } });
  const state = await runManifest(root, manifest([job({ skills: ['coverage'] })], { skillsDir }), { spawnImpl: update });
  await assert.rejects(integrateRun(root, state.id), /skill-check-failed: coverage: filesMustChange docs\/\*\.md matched no changed file/);
});

test('a resultKeys check missing from the result fails integrate, and --accept-failed-checks does not bypass it', async t => {
  const root = await fixture(t);
  const skillsDir = path.join(root, 'skills');
  await writeSkill(skillsDir, 'reporter', { checks: { resultKeys: ['approved'] } });
  const worker = fake(`fs.writeFileSync('input.txt','updated'); ${done(JSON.stringify({ summary: 'ok' }))}`);
  // Field lesson #283: the prompt's own declared JSON shape must name the required key so the new
  // dispatch-time check (dispatchResultKeysRefusal) lets this job run at all; the worker's actual
  // result still omits it, so integrate's own (pre-existing) resultKeys check is what this test
  // exercises, unchanged.
  const reporterJob = job({ skills: ['reporter'], prompt: 'Update the assigned file. Return JSON only, max 5 lines: {"approved": true}' });
  const state = await runManifest(root, manifest([reporterJob], { skillsDir }), { spawnImpl: worker });
  await assert.rejects(integrateRun(root, state.id), /skill-check-failed: reporter: resultKeys missing approved/);
  await assert.rejects(
    execFileAsync(process.execPath, [CLI, '--root', root, 'integrate', state.id, '--accept-failed-checks']),
    error => { assert.equal(error.code, 1); assert.match(error.stderr, /skill-check-failed: reporter: resultKeys missing approved/); return true; },
  );
});

test('job state records skills with a real git hash-object id and how each was attached', async t => {
  const root = await fixture(t);
  const skillsDir = path.join(root, 'skills');
  await writeSkill(skillsDir, 'formatting', {});
  const realHash = (await execFileAsync('git', ['hash-object', path.join(skillsDir, 'formatting/SKILL.md')])).stdout.trim();
  const state = await runManifest(root, manifest([job({ skills: ['formatting'] })], { skillsDir }), { spawnImpl: update });
  assert.deepEqual(state.jobs[0].skills, [{ name: 'formatting', gitHash: realHash, attached: 'named' }]);
});

test('a skill just over 800 tokens warns without being trimmed; just over 1200 tokens refuses', async t => {
  const root = await fixture(t);
  const skillsDir = path.join(root, 'skills');
  const header = '---\nname: big\ndescription: d\n---\n';
  const warnBody = 'x'.repeat(3201 - header.length); // total 3201 chars -> ceil(3201/4) = 801 tokens
  await fs.mkdir(path.join(skillsDir, 'big'), { recursive: true });
  await fs.writeFile(path.join(skillsDir, 'big/SKILL.md'), header + warnBody);
  const result = await validateProject(root, manifest([job({ skills: ['big'] })], { skillsDir }));
  assert.ok(result.warnings.includes(`skill-over-800: ${path.join(skillsDir, 'big/SKILL.md')}`));
  const state = await runManifest(root, manifest([job({ skills: ['big'] })], { skillsDir }), { spawnImpl: update });
  const message = await fs.readFile(path.join(root, '.swarm/runs', state.id, 'writer/message.txt'), 'utf8');
  assert.ok(message.includes(warnBody), 'the full, untrimmed body still reaches the prompt');

  const refuseSkillsDir = path.join(root, 'skills-refuse');
  const refuseBody = 'x'.repeat(4801 - header.length); // total 4801 chars -> ceil(4801/4) = 1201 tokens
  await fs.mkdir(path.join(refuseSkillsDir, 'huge'), { recursive: true });
  await fs.writeFile(path.join(refuseSkillsDir, 'huge/SKILL.md'), header.replace('big', 'huge') + refuseBody);
  await assert.rejects(validateProject(root, manifest([job()], { skillsDir: refuseSkillsDir })), /skill-over-1200/);
});

test('a symlink anywhere in the skills source dir refuses instead of copying', async t => {
  const root = await fixture(t);
  const skillsDir = path.join(root, 'skills');
  await writeSkill(skillsDir, 'formatting', {});
  await fs.symlink(path.join(root, 'input.txt'), path.join(skillsDir, 'formatting', 'linked.txt'));
  await assert.rejects(assertNoSkillSymlinks(skillsDir), /symlink refused/);
  await assert.rejects(validateProject(root, manifest([job()], { skillsDir })), /symlink refused/);
  const state = await runManifest(root, manifest([job()], { skillsDir }), { spawnImpl: update });
  assert.equal(state.status, 'failed');
  assert.match(state.error, /symlink refused/);
});

// Field lesson #224: an invalid-but-parseable skill unused by any job only warns
// (skill-invalid-unused); a job that actually attaches it by name is still refused, naming the file.
test('invalid frontmatter: unused warns skill-invalid-unused, a job that attaches it refuses naming the file', async t => {
  const root = await fixture(t);
  const skillsDir = path.join(root, 'skills');
  await fs.mkdir(path.join(skillsDir, 'broken'), { recursive: true });
  const file = path.join(skillsDir, 'broken/SKILL.md');
  await fs.writeFile(file, '---\nname: broken\ndescription: has an unknown field\nunknownField: yes\n---\nBody.\n');

  const skills = await listSkills(skillsDir);
  assert.equal(skills.length, 1);
  assert.equal(skills[0].broken, true);

  const unusedReport = await validateProject(root, manifest([job()], { skillsDir }));
  assert.ok(unusedReport.warnings.some(w => w.code === 'skill-invalid-unused' && w.file === file), JSON.stringify(unusedReport.warnings));

  await assert.rejects(
    validateProject(root, manifest([job({ skills: ['broken'] })], { skillsDir })),
    new RegExp(`invalid-skill-frontmatter: ${file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`),
  );
});

test('the small YAML subset parses scalars, lists and one nested map', () => {
  const text = 'name: pdf-fill\ndescription: Fill PDF forms\npaths:\n  - "forms/*.pdf"\n  - forms/*.json\nchecks:\n  filesMustChange:\n    - forms/*.pdf\n  resultKeys:\n    - filled\n';
  assert.deepEqual(parseYamlSubset(text), { name: 'pdf-fill', description: 'Fill PDF forms', paths: ['forms/*.pdf', 'forms/*.json'], checks: { filesMustChange: ['forms/*.pdf'], resultKeys: ['filled'] } });
  const { frontmatter, body } = parseSkillFrontmatter('---\nname: a\ndescription: b\n---\nBody here.\n');
  assert.deepEqual(frontmatter, { name: 'a', description: 'b' });
  assert.equal(body, 'Body here.\n');
  assert.throws(() => validateSkillFrontmatter({ name: 'a' }, 'f.md'), /invalid-skill-frontmatter: f\.md/);
  assert.throws(() => validateSkillFrontmatter({ name: 'a', description: 'b', extra: 1 }, 'f.md'), /unknown field extra/);
});

test('tokenEstimate, size checks, prompt-block builders and gitBlobHash are pure and self-consistent', () => {
  assert.equal(tokenEstimate(3200), 800);
  assert.equal(tokenEstimate(3201), 801);
  assert.deepEqual(skillSizeWarnings([{ file: 'a.md', chars: 3204 }]), ['skill-over-800: a.md']);
  assert.doesNotThrow(() => refuseOversizeSkills([{ file: 'a.md', chars: 4800 }]));
  assert.throws(() => refuseOversizeSkills([{ file: 'a.md', chars: 4801 }]), /skill-over-1200: a\.md/);
  const skills = [{ name: 'a', description: 'A.', paths: [], checks: null, body: 'Body A.', file: 'a/SKILL.md' }, { name: 'b', description: 'B.', paths: ['x/*.js'], checks: null, body: 'Body B.', file: 'b/SKILL.md' }];
  assert.throws(() => attachSkillsForJob(skills, { skills: ['nope'], context: [], outputs: [] }), /unknown-skill: nope/);
  const named = attachSkillsForJob(skills, { skills: ['a'], context: [], outputs: [] });
  assert.deepEqual(named.map(s => s.attached), ['named', 'index-only']);
  const viaPaths = attachSkillsForJob(skills, { context: [], outputs: ['x/main.js'] });
  assert.deepEqual(viaPaths.map(s => s.attached), ['index-only', 'paths']);
  assert.equal(skillIndexBlock([]), '');
  assert.equal(
    skillIndexBlock([{ name: 'a', description: 'A.', attached: 'named' }, { name: 'b', description: 'B.', attached: 'index-only' }]),
    'Skills in .swarm/skills/: a — A.\nSkills in .swarm/skills/: b — B. — .swarm/skills/b/SKILL.md — read it if your job touches this\n',
  );
  assert.equal(skillPrependBlock(named.map(s => ({ ...s }))), '--- skill a ---\nBody A.\n---\n\n');
  assert.equal(skillsPromptBlock([]), '');
  assert.deepEqual(skillRecordEntries(named), [{ name: 'a', gitHash: undefined, attached: 'named' }, { name: 'b', gitHash: undefined, attached: 'index-only' }]);
  assert.equal(gitBlobHash(Buffer.from('hello\n')), 'ce013625030ba8dba906f756967f9e9ca394464a');
  assert.deepEqual(skillCheckFailures({ attachedSkills: [{ name: 'x', attached: 'named', checks: { filesMustChange: ['a/*.txt'], resultKeys: ['k'] } }], changedFiles: ['b.txt'], resultData: {} }), ['x: filesMustChange a/*.txt matched no changed file', 'x: resultKeys missing k']);
  assert.deepEqual(skillCheckFailures({ attachedSkills: [{ name: 'x', attached: 'index-only', checks: { resultKeys: ['k'] } }], changedFiles: [], resultData: {} }), []);
});

test('executeApi puts the skills block ahead of the task text it builds', async () => {
  let sent;
  await executeApi(job({ agent: 'openai' }), [], { env: { OPENAI_API_KEY: 'k' }, skillsBlock: 'Skills in .swarm/skills/: a — d\n', fetchImpl: async (_url, options) => { sent = JSON.parse(options.body); return new Response(JSON.stringify({ status: 'completed', model: 'm', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify({ summary: 's', files: [] }) }] }] }), { headers: { 'content-type': 'application/json' } }); } });
  const task = JSON.parse(sent.input).task;
  assert.match(task, /^Skills in \.swarm\/skills\/: a — d\n/);
});

test('reworkBySkill on fixture runs reports the rework share for jobs with vs without a skill', () => {
  const jobs = [
    { root: '/p', runId: 'run-1', startedAt: '2026-01-01T00:00:00Z', finishedAt: '2026-01-01T01:00:00Z', outputs: ['a.txt'], skills: [{ name: 'formatting', attached: 'named' }] },
    { root: '/p', runId: 'run-2', startedAt: '2026-01-01T02:00:00Z', finishedAt: '2026-01-01T03:00:00Z', outputs: ['a.txt'] }, // follow-up, within 24h
    { root: '/p', runId: 'run-3', startedAt: '2026-02-01T00:00:00Z', finishedAt: '2026-02-01T01:00:00Z', outputs: ['b.txt'] }, // no skill, no follow-up
  ];
  const result = reworkBySkill(jobs);
  assert.deepEqual(result.formatting.withSkill, { jobs: 1, reworkJobs: 1, reworkShare: 1 });
  assert.deepEqual(result.formatting.withoutSkill, { jobs: 2, reworkJobs: 0, reworkShare: 0 });
});
