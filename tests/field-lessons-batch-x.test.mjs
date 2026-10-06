// SPDX-License-Identifier: Apache-2.0
// Swarm batch X: field lessons 281-288 (see .swarm-manifests/contract-x.md).
// #281: an untracked, uncontexted repo-relative path a prompt names is silently absent from the
//   copied workspace unless declared in a new manifest `resources` list.
// #282: `privateData: true` withholds a worker's own transcript from disk.
// #283: a job's declared result shape is checked against its attached skills' resultKeys before
//   dispatch, not only at integrate.
// #284: docs-only — the shared contract template now references ship --preflight/swarm squash
//   directly; no code changed, no test here (see templates/coordination/CONTRACT.md).
// #285: a tool-free API job with outputs: [] that asks for real content is refused before it ever
//   sends a request; a truncated response now names the prompt's size.
// #286: a worker CLI's own quota/limit message is a provider outage, not a job failure.
// #287: a linked-worktree root's real git dir is readable but not writable by a shell job's
//   sandbox.
// #288: a codex job's own repo AGENTS.md names required reads the prompt never surfaces as
//   allowed.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execFileSync } from 'node:child_process';
import {
  runManifest, validateProject, validateManifest,
  promptPathsNotInWorkspaceWarnings, privateDataRequiredWarning,
  parsePromptDeclaredResultKeys, dispatchResultKeysRefusal,
  detectClaudeQuotaLimit, claudeProviderLimitGuard,
  linkedWorktreeCommitWarning, codexRequiredReadMissingWarnings,
  PRIVATE_DATA_WITHHELD_TEXT,
} from '../tools/swarm.mjs';
import { shellProfile } from '../tools/claude-shell.mjs';
import { codexMessage, CODEX_OUT_OF_REPO_DOCS_WAIVER_LINE } from '../tools/codex-adapter.mjs';
import { emptyOutputsContentRefusal } from '../tools/openrouter.mjs';
import { executeApi } from '../tools/api-adapters.mjs';
import { listProjectFiles } from '../tools/context-check.mjs';

const TMP_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.tmp-test-x');
async function mkTemp(prefix) {
  await fs.mkdir(TMP_ROOT, { recursive: true });
  return fs.mkdtemp(path.join(TMP_ROOT, prefix));
}

function gitAt(dir) {
  return (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
}
// A real git repo (not just a plain directory) so `listProjectFiles`'s own `git ls-files` can
// tell a tracked file apart from one merely sitting on disk — the same distinction #281's own
// prompt-path-not-in-workspace check depends on.
async function gitFixture(t) {
  const root = await mkTemp('field-lessons-x-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const git = gitAt(root);
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'worker@example.invalid');
  git('config', 'user.name', 'Worker');
  await fs.writeFile(path.join(root, 'input.txt'), 'original');
  git('add', 'input.txt');
  git('commit', '-q', '-m', 'base');
  return root;
}

const job = (overrides = {}) => ({ id: 'writer', agent: 'claude', model: 'sonnet', prompt: 'Update the assigned file.', context: ['input.txt'], outputs: ['input.txt'], timeoutMs: 5000, ...overrides });
const manifest = (jobs, overrides = {}) => ({ version: 1, concurrency: 2, jobs: jobs ?? [job()], ...overrides });
function fake(script) {
  return (_command, _args, options) => spawn(process.execPath, ['--input-type=module', '-e', `import fs from 'node:fs';\n${script}`], options);
}
const done = result => `console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,result:${JSON.stringify(result)}}));`;
const update = fake(`fs.writeFileSync('input.txt','updated'); ${done('Worker complete')}`);

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

// ---------------------------------------------------------------------------------------------
describe('#281: an untracked, uncontexted repo-relative path a prompt names is silently absent from the workspace', () => {
  test('(281a) validateProject refuses resource-missing for a declared resource absent from the repo root', async t => {
    const root = await gitFixture(t);
    await assert.rejects(
      validateProject(root, manifest([job()], { resources: ['scripts/vendor/tool'] })),
      /resource-missing: scripts\/vendor\/tool/,
    );
  });

  test('(281a, directory) validateProject refuses resource-is-directory for a declared resource naming a directory', async t => {
    const root = await gitFixture(t);
    await fs.mkdir(path.join(root, 'a-directory'));
    await assert.rejects(
      validateProject(root, manifest([job()], { resources: ['a-directory'] })),
      /resource-is-directory: a-directory/,
    );
  });

  test('(281b) a prompt naming an untracked on-disk path not covered by context/resources refuses prompt-path-not-in-workspace', async t => {
    const root = await gitFixture(t);
    await fs.mkdir(path.join(root, '.swarm-manifests'), { recursive: true });
    await fs.writeFile(path.join(root, '.swarm-manifests', 'staged.pdf'), 'pdf-bytes');
    const theJob = job({ prompt: 'see .swarm-manifests/staged.pdf for the source' });
    const trackedFiles = new Set(listProjectFiles(root));
    const hits = await promptPathsNotInWorkspaceWarnings(root, theJob, theJob.context, { trackedFiles, resources: [] });
    assert.deepEqual(hits, [
      "prompt-path-not-in-workspace: Job writer's prompt names .swarm-manifests/staged.pdf, which exists on disk but is neither tracked, in context, nor in manifest resources; it will be absent from the copied workspace",
    ]);
    await assert.rejects(
      validateProject(root, manifest([theJob])),
      /prompt-path-not-in-workspace: Job writer's prompt names \.swarm-manifests\/staged\.pdf/,
    );
  });

  test('(281c) the same path declared in manifest.resources gets no hit and is copied into the job workspace', async t => {
    const root = await gitFixture(t);
    await fs.mkdir(path.join(root, '.swarm-manifests'), { recursive: true });
    const resourceBytes = 'pdf-bytes-for-281c';
    await fs.writeFile(path.join(root, '.swarm-manifests', 'staged.pdf'), resourceBytes);
    const theJob = job({ prompt: 'see .swarm-manifests/staged.pdf for the source' });
    const trackedFiles = new Set(listProjectFiles(root));
    const hits = await promptPathsNotInWorkspaceWarnings(root, theJob, theJob.context, { trackedFiles, resources: ['.swarm-manifests/staged.pdf'] });
    assert.deepEqual(hits, []);
    const state = await runManifest(root, manifest([theJob], { resources: ['.swarm-manifests/staged.pdf'] }), { spawnImpl: update });
    const copied = await fs.readFile(path.join(root, '.swarm/workspaces', state.id, theJob.id, '.swarm-manifests/staged.pdf'), 'utf8');
    assert.equal(copied, resourceBytes);
  });
});

// ---------------------------------------------------------------------------------------------
describe('#282: privateData: true withholds a worker\'s own transcript from disk', () => {
  test('(282a) privateDataRequiredWarning fires for an unmarked job touching a configured private path; privateData: true clears it', () => {
    const warning = privateDataRequiredWarning({ id: 'j1', outputs: ['invoices/report.pdf'], privateData: undefined }, [], { privateData: { paths: ['invoices/**'] } });
    assert.deepEqual(warning, { code: 'privateData-required', jobId: 'j1', message: 'privateData-required: Job j1 touches a configured private path without privateData: true' });
    const cleared = privateDataRequiredWarning({ id: 'j1', outputs: ['invoices/report.pdf'], privateData: true }, [], { privateData: { paths: ['invoices/**'] } });
    assert.equal(cleared, null);
  });

  test('(282b) privateData: true writes the fixed placeholder to response.txt, never the real reply text; the declared output is untouched', async t => {
    const root = await gitFixture(t);
    const invoiceText = 'invoice #4471: $9,200';
    const script = `fs.mkdirSync('invoices',{recursive:true}); fs.writeFileSync('invoices/report.pdf','filled'); ${done(invoiceText)}`;
    const theJob = job({ context: [], outputs: ['invoices/report.pdf'], prompt: 'Fill in the invoice report.', privateData: true });
    const state = await runManifest(root, manifest([theJob]), { spawnImpl: fake(script) });
    assert.equal(state.jobs[0].status, 'complete');
    const responseText = await fs.readFile(path.join(root, '.swarm/runs', state.id, 'writer/response.txt'), 'utf8');
    assert.equal(responseText, PRIVATE_DATA_WITHHELD_TEXT);
    assert.ok(!responseText.includes('4471'));
    const outputBytes = await fs.readFile(path.join(root, '.swarm/workspaces', state.id, 'writer/invoices/report.pdf'), 'utf8');
    assert.equal(outputBytes, 'filled');
  });

  test('(282c) privateData left unset writes the real reply text unchanged (no regression for the common case)', async t => {
    const root = await gitFixture(t);
    const invoiceText = 'invoice #4471: $9,200';
    const script = `fs.mkdirSync('invoices',{recursive:true}); fs.writeFileSync('invoices/report.pdf','filled'); ${done(invoiceText)}`;
    const theJob = job({ context: [], outputs: ['invoices/report.pdf'], prompt: 'Fill in the invoice report.' });
    const state = await runManifest(root, manifest([theJob]), { spawnImpl: fake(script) });
    assert.equal(state.jobs[0].status, 'complete');
    const responseText = await fs.readFile(path.join(root, '.swarm/runs', state.id, 'writer/response.txt'), 'utf8');
    assert.equal(responseText, invoiceText);
  });
});

// ---------------------------------------------------------------------------------------------
describe('#283: a job\'s declared result shape is checked against its attached skills\' resultKeys before dispatch', () => {
  test('(283a) parsePromptDeclaredResultKeys extracts declared keys; pipe-delimited string values never break the scan', () => {
    const keys = parsePromptDeclaredResultKeys('Do the work. Return JSON only, max 5 lines: {"status":"done|blocked","file":".foo","filesChanged":[...]}');
    assert.deepEqual(keys, ['status', 'file', 'filesChanged']);
    assert.equal(parsePromptDeclaredResultKeys('No JSON demand here.'), null);
  });

  test('(283b) validateProject refuses <skill>: resultKeys missing <key> before dispatch, for a skill attached via a context path match', async t => {
    const root = await gitFixture(t);
    const skillsDir = path.join(root, 'skills-283');
    await writeSkill(skillsDir, 'reporter', { paths: ['input.txt'], checks: { resultKeys: ['filesChanged'] } });
    const theJob = job({ context: ['input.txt'], outputs: ['result.txt'], prompt: 'Update the file. Return JSON only, max 2 lines: {"status":"done","notes":["x"]}' });
    await assert.rejects(
      validateProject(root, manifest([theJob], { skillsDir })),
      /reporter: resultKeys missing filesChanged/,
    );
  });

  test('(283c) the same skill/job with the required key present in the declared shape does not refuse', async t => {
    const root = await gitFixture(t);
    const skillsDir = path.join(root, 'skills-283');
    await writeSkill(skillsDir, 'reporter', { paths: ['input.txt'], checks: { resultKeys: ['filesChanged'] } });
    const theJob = job({ context: ['input.txt'], outputs: ['result.txt'], prompt: 'Update the file. Return JSON only, max 2 lines: {"status":"done","filesChanged":["result.txt"]}' });
    const result = await validateProject(root, manifest([theJob], { skillsDir }));
    assert.equal(result.status, 'valid');
  });
});

// ---------------------------------------------------------------------------------------------
// #284 is docs-only (templates/coordination/CONTRACT.md); no code changed, no test here, per the
// row's own instruction ("reference it, do not redo it") and lesson 264's precedent.

// ---------------------------------------------------------------------------------------------
describe('#285: a tool-free API job with outputs: [] that asks for real content is refused before it ever sends a request', () => {
  test('(285a) a content-asking prompt with outputs: [] refuses; the same job with a declared output does not', () => {
    assert.throws(
      () => emptyOutputsContentRefusal({ id: 'j1', outputs: [], prompt: 'Write a full summary of every invoice this week.' }),
      /openrouter-empty-outputs-content: Job j1/,
    );
    assert.doesNotThrow(() => emptyOutputsContentRefusal({ id: 'j1', outputs: ['report.md'], prompt: 'Write a full summary of every invoice this week.' }));
  });

  test('(285b) a genuinely short-answer job with outputs: [] stays legal', () => {
    assert.doesNotThrow(() => emptyOutputsContentRefusal({ id: 'j2', outputs: [], prompt: 'Does invoice #4471 look paid? Answer yes or no.' }));
  });

  test('(285c) a truncated OpenRouter response names the prompt size in characters', async t => {
    const KEY = 'sk-or-FAKE-x1-0000';
    const logsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-openrouter-x-'));
    t.after(() => fs.rm(logsDir, { recursive: true, force: true }));
    const env = { OPENROUTER_API_KEY: KEY, SWARM_LOGS_DIR: logsDir };
    const reply = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
    const models = { data: [{ id: 'anthropic/claude-sonnet-5', pricing: { prompt: '0.000002', completion: '0.00001' } }] };
    const truncated = { id: 'gen-1', model: 'resolved-model', usage: { prompt_tokens: 10, completion_tokens: 5 }, choices: [{ finish_reason: 'length', message: { role: 'assistant', content: '{"partial":' } }] };
    const OPENROUTER_MODELS_URL = 'https://openrouter.ai/api/v1/models';
    const OPENROUTER_ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';
    const fetchImpl = async url => {
      if (url === OPENROUTER_MODELS_URL) return reply(models);
      if (url === OPENROUTER_ENDPOINT) return reply(truncated);
      throw new Error(`unexpected url ${url}`);
    };
    const longPrompt = 'x'.repeat(3400);
    const theJob = { id: 'j3', agent: 'openrouter', model: 'anthropic/claude-sonnet-5', context: [], outputs: ['notes.md'], prompt: longPrompt, timeoutMs: 2000 };
    const result = await executeApi(theJob, [], { env, fetchImpl });
    assert.equal(result.status, 'failed');
    assert.match(result.error, /truncated: finish_reason length \(prompt 3400 chars\)$/);
  });
});

// ---------------------------------------------------------------------------------------------
describe('#286: a worker CLI\'s own quota/limit message is a provider outage, not a job failure', () => {
  test('(286a) detectClaudeQuotaLimit extracts the reset time from a weekly-limit message; unrelated stdout is null', () => {
    assert.deepEqual(detectClaudeQuotaLimit("You've hit your weekly limit · resets Oct 2 at 6pm"), { resetsAt: 'Oct 2 at 6pm' });
    assert.equal(detectClaudeQuotaLimit('some other stdout'), null);
  });

  test('(286b) a plain claude job whose CLI prints a quota message (no stream-json) resolves status provider-limit and persists the reset marker', async t => {
    const root = await gitFixture(t);
    // process.exitCode (not process.exit(1)) so the event loop drains and the console.log write
    // to stdout is guaranteed to flush before the process actually exits.
    const script = `console.log("You have hit your weekly limit; it resets Oct 12 at 5pm"); process.exitCode = 1;`;
    const state = await runManifest(root, manifest([job()]), { spawnImpl: fake(script) });
    assert.equal(state.jobs[0].status, 'provider-limit');
    assert.match(state.jobs[0].error, /provider-limit: resets Oct 12 at 5pm/);
    const marker = await claudeProviderLimitGuard(root);
    assert.ok(marker, 'the provider-limit marker was persisted');
    assert.equal(marker.resetsAt, 'Oct 12 at 5pm');
  });

  test('(286c) CLI: run refuses claude-provider-limit before ever dispatching; --ignore-provider-limit proceeds past the same marker', async t => {
    const root = await gitFixture(t);
    const manifestPath = path.join(root, 'manifest.json');
    await fs.writeFile(manifestPath, JSON.stringify(manifest([job()])));
    const future = new Date(Date.now() + 3600000).toISOString();
    await fs.mkdir(path.join(root, '.swarm'), { recursive: true });
    await fs.writeFile(path.join(root, '.swarm/claude-provider-limit.json'), JSON.stringify({ resetsAt: future, detectedAt: new Date().toISOString() }));
    const swarmCliPath = fileURLToPath(new URL('../tools/swarm.mjs', import.meta.url));

    let failure;
    try {
      execFileSync(process.execPath, [swarmCliPath, 'run', manifestPath, '--root', root], { encoding: 'utf8' });
    } catch (error) { failure = error; }
    assert.ok(failure, 'expected the run command to exit nonzero');
    assert.match(String(failure.stderr ?? failure.stdout ?? ''), /claude-provider-limit: resets/);
    const runsAfter = await fs.readdir(path.join(root, '.swarm/runs')).catch(() => []);
    assert.deepEqual(runsAfter, []);

    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-fake-claude-x-'));
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    const claudeFlags = ['--restricted', '--safe-mode', '--tools', '--permission-prompts', '--strict-mcp-config', '--mcp-config', '--no-session-persistence', '--no-chrome', '--output-format'];
    // `runManifestChecked` runs `doctor({agent:'claude'})` (--version, then --help) before ever
    // dispatching; this fake answers both so the real check passes, then answers the actual `-p
    // ...` invocation with a normal complete stream-json result.
    const fakeClaudeScript = `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('2.1.280 (Claude Code)'); process.exit(0); }
if (args[0] === '--help') { console.log('Usage: claude [options] ${claudeFlags.join(' ')}'); process.exit(0); }
console.log(JSON.stringify({type:'system',subtype:'init',model:'claude-sonnet-5-20260101'}));
console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,result:'Worker complete'}));
`;
    await fs.writeFile(path.join(dir, 'claude'), fakeClaudeScript, { mode: 0o755 });
    const stdout = execFileSync(process.execPath, [swarmCliPath, 'run', manifestPath, '--root', root, '--ignore-provider-limit'], {
      encoding: 'utf8', env: { ...process.env, PATH: `${dir}${path.delimiter}${process.env.PATH ?? ''}` },
    });
    assert.ok(!stdout.includes('claude-provider-limit'));
  });
});

// ---------------------------------------------------------------------------------------------
describe('#287: a linked-worktree root\'s real git dir is readable but not writable by a shell job\'s sandbox', () => {
  test('(287a) a linked-worktree root grants write access to its own gitDir and commonDir', () => {
    const profile = shellProfile({
      worktree: '/r/worktree', commonDir: '/r/.common', shellDir: '/r/shell', proxyPort: 4000,
      rootGit: { kind: 'file', path: '/r/.git', gitDir: '/outer/.git/worktrees/r', commonDir: '/outer/.git' },
    });
    const writeLine = profile.split('\n').find(line => line.startsWith('(allow file-write*'));
    assert.ok(writeLine, 'expected a file-write* allow clause');
    assert.ok(writeLine.includes('(subpath "/outer/.git/worktrees/r")'));
    assert.ok(writeLine.includes('(subpath "/outer/.git")'));
  });

  test('(287b) an ordinary (non-worktree) root\'s writable set is byte-identical to before this fix', () => {
    const base = { worktree: '/r/worktree', commonDir: '/r/.git', shellDir: '/r/shell', proxyPort: 4000 };
    const withDirKind = shellProfile({ ...base, rootGit: { kind: 'dir', path: '/r/.git' } });
    const withoutRootGit = shellProfile(base);
    const writeLine = text => text.split('\n').find(line => line.startsWith('(allow file-write*'));
    assert.equal(writeLine(withDirKind), writeLine(withoutRootGit));
  });

  test('(287c) linkedWorktreeCommitWarning names the grant only when the prompt asks to commit against a linked worktree', () => {
    const rootGit = { kind: 'file', gitDir: '/outer/.git/worktrees/r' };
    const withCommit = linkedWorktreeCommitWarning(rootGit, { id: 'j1', agent: 'claude', shell: true, prompt: 'Fix the bug and commit your change.' });
    assert.deepEqual(withCommit, {
      code: 'linked-worktree-commit', jobId: 'j1',
      message: "linked-worktree-commit: Job j1's prompt asks it to commit; this root is a linked worktree, so its sandbox now grants write access to /outer/.git/worktrees/r for that to succeed",
    });
    const withoutCommit = linkedWorktreeCommitWarning(rootGit, { id: 'j1', agent: 'claude', shell: true, prompt: 'Fix the bug.' });
    assert.equal(withoutCommit, null);
  });
});

// ---------------------------------------------------------------------------------------------
describe('#288: a codex job\'s own repo AGENTS.md names required reads the prompt never surfaces as allowed', () => {
  test('(288a) codexMessage includes the out-of-repo waiver and inlines a provided AGENTS.workspace.md, both before TASK:', () => {
    const message = codexMessage({ prompt: 'x', outputs: [], context: [] }, { agentsWorkspace: { path: 'AGENTS.workspace.md', text: 'Read docs/PLAN.md first.' } });
    assert.ok(message.includes(CODEX_OUT_OF_REPO_DOCS_WAIVER_LINE.trim()));
    assert.ok(message.includes('Read docs/PLAN.md first.'));
    const taskIndex = message.indexOf('TASK:');
    assert.ok(taskIndex > -1);
    assert.ok(message.indexOf(CODEX_OUT_OF_REPO_DOCS_WAIVER_LINE.trim()) < taskIndex);
    assert.ok(message.indexOf('Read docs/PLAN.md first.') < taskIndex);
    // Without an agentsWorkspace, the waiver still rides along but no section is inlined.
    const bare = codexMessage({ prompt: 'x', outputs: [], context: [] });
    assert.ok(bare.includes(CODEX_OUT_OF_REPO_DOCS_WAIVER_LINE.trim()));
    assert.ok(!bare.includes('AGENTS.workspace.md'));
  });

  test('(288b) codexRequiredReadMissingWarnings names a tracked AGENTS.md doc missing from context; an untracked one is skipped', () => {
    const warnings = codexRequiredReadMissingWarnings('Read `docs/PLAN.md` and `docs/TICKETS.md` first.', new Set(['docs/PLAN.md']), { id: 'j1', agent: 'codex', context: [] });
    assert.deepEqual(warnings, ["codex-required-read-missing: Job j1: AGENTS.md names docs/PLAN.md (tracked), not in this job's context"]);
  });

  test('(288c) the same doc named in the job\'s own context produces no warning', () => {
    const warnings = codexRequiredReadMissingWarnings('Read `docs/PLAN.md` and `docs/TICKETS.md` first.', new Set(['docs/PLAN.md']), { id: 'j1', agent: 'codex', context: ['docs/PLAN.md'] });
    assert.deepEqual(warnings, []);
  });
});

// ---------------------------------------------------------------------------------------------
describe('release: 1.49.0', () => {
  test('package.json and package-lock.json are both at 1.49.0', async () => {
    const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
    const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
    const lock = JSON.parse(await fs.readFile(path.join(root, 'package-lock.json'), 'utf8'));
    assert.equal(pkg.version, '1.49.0');
    assert.equal(lock.version, '1.49.0');
    assert.equal(lock.packages[''].version, '1.49.0');
  });

  test('CHANGELOG.md has a 1.39.0 heading that absorbs the Unreleased ship --preflight line', async () => {
    const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
    const text = await fs.readFile(path.join(root, 'CHANGELOG.md'), 'utf8');
    assert.ok(!/^## Unreleased$/m.test(text));
    const heading = text.indexOf('## 1.39.0');
    assert.ok(heading > -1);
    const nextHeading = text.indexOf('## 1.38.0');
    const section = text.slice(heading, nextHeading);
    assert.match(section, /ship --preflight/);
    for (const lesson of [281, 282, 283, 284, 285, 286, 287, 288]) assert.match(section, new RegExp(`\\(lesson ${lesson}\\)`));
  });

  test('docs/lessons.md carries one public entry per lesson, numbered after the existing tail', async () => {
    const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
    const text = await fs.readFile(path.join(root, 'docs/lessons.md'), 'utf8');
    for (const n of [184, 185, 186, 187, 188, 189, 190, 191]) assert.match(text, new RegExp(`^${n}\\. \\*\\*`, 'm'));
  });
});
