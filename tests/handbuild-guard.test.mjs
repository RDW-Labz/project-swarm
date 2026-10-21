// SPDX-License-Identifier: Apache-2.0
// The hand-build guard: blocked edit, approved edit inside scope, approved edit outside scope blocked, expired approval blocked, worktree edits allowed, shell writes, the request flow, the
// journal, Needs you and the phone path, install and removal.
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { analyzeShell, tokenize } from '../tools/shell-writes.mjs';
import { guardDecision, createRequest, decideRequest, listRequests, activeApprovals, matchesFile, LOG_FILE, OFF_FILE } from '../tools/handbuild.mjs';
import { runHandbuildCommand } from '../tools/handbuild-commands.mjs';
import { runInboxCommand } from '../tools/inbox-commands.mjs';
import { collectInbox } from '../tools/inbox.mjs';
import { inboxDeps } from '../tools/inbox-commands.mjs';
import { readJournal } from '../tools/journal.mjs';
import { ensureHandbuildGuard, removeHandbuildGuard } from '../tools/install.mjs';
import { buildEvent, handBuiltOf, readEvents, sessionsOf, EVENTS_FILE } from '../tools/orchestrator-events.mjs';

const GUARD = fileURLToPath(new URL('../tools/handbuild-guard.mjs', import.meta.url));
const HOOK = fileURLToPath(new URL('../tools/orchestrator-hook.mjs', import.meta.url));
const T0 = Date.UTC(2026, 9, 20, 12, 0, 0);
const tmp = async t => { const d = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-hb-'))); t.after(() => fs.rm(d, { recursive: true, force: true })); return d; };
const project = async t => { const root = await tmp(t); await fs.mkdir(path.join(root, '.git')); await fs.mkdir(path.join(root, 'src')); return root; };
const edit = (root, rel, now = T0) => guardDecision({ tool: 'Edit', toolInput: { file_path: path.join(root, rel) }, root, cwd: root, now: () => now });
const bash = (root, command, now = T0) => guardDecision({ tool: 'Bash', toolInput: { command }, root, cwd: root, now: () => now });
const request = (root, extra = {}) => createRequest(root, { kind: 'swarm-cannot', reason: 'the swarm cannot run the migration tool here', files: 'src/a.ts,supabase/migrations/', minutes: 30, ...extra }, { now: () => T0 });

test('shell writes are read from the command text: redirects, tee, sed -i, mv, cp, rm, git commit; reads and tests are not writes', () => {
  const root = '/p';
  const w = c => analyzeShell(c, { root, cwd: root });
  assert.deepEqual(w('npm test -- staff').writes, []);
  assert.deepEqual(w('grep -rn foo src | head -5 && ls -la').writes, []);
  assert.deepEqual(w('echo hi > src/x.ts').writes, ['src/x.ts']);
  assert.deepEqual(w('cat > src/y.ts <<EOF\nline\nEOF').writes, ['src/y.ts']);
  assert.deepEqual(w('echo hi >> docs/plans/x.md').writes, [], 'plans are the orchestrator\'s own');
  assert.deepEqual(w('echo hi > .swarm/notes.txt').writes, []);
  assert.deepEqual(w('echo hi > /tmp/x && cp a /tmp/b').writes, [], 'outside the checkout');
  assert.deepEqual(w('make 2> /dev/null > /dev/null').writes, []);
  assert.deepEqual(w('echo x | tee -a src/a.ts docs/plans/p.md').writes, ['src/a.ts']);
  assert.deepEqual(w('sed -i "" "s/a/b/" src/a.ts').writes, ['src/a.ts']);
  assert.deepEqual(w('sed -i.bak -e "s/a/b/" src/a.ts src/b.ts').writes, ['src/a.ts', 'src/b.ts']);
  assert.deepEqual(w('sed -n 1,5p src/a.ts').writes, []);
  assert.deepEqual(w('mv src/a.ts src/b.ts').writes, ['src/a.ts', 'src/b.ts']);
  assert.deepEqual(w('cp /tmp/x src/new.ts').writes, ['src/new.ts']);
  assert.deepEqual(w('rm -rf node_modules .next dist').writes, [], 'build output is a tool\'s');
  assert.deepEqual(w('rm src/a.ts').writes, ['src/a.ts']);
  assert.deepEqual(w('touch src/a.ts && mkdir -p src/lib').writes, ['src/a.ts', 'src/lib']);
  assert.deepEqual(w('FOO=1 sudo -n tee src/a.ts').writes, ['src/a.ts'], 'wrappers and assignments are skipped');
  assert.deepEqual(w('git commit -m x').git, ['commit']);
  assert.deepEqual(w('git -C . push origin main').git, ['push']);
  assert.deepEqual(w('git status && git diff && git log --oneline && git checkout -b feat/x && git add -A').git, []);
  assert.deepEqual(w('git checkout -- src/a.ts').git, ['checkout']);
  assert.equal(w('node -e "require(\'fs\').writeFileSync(\'x\', 1)"').inline, true);
  assert.equal(w('python3 -c "open(\'x\',\'w\').write(\'1\')"').inline, true);
  assert.equal(w('python3 -c "print(1)"').inline, false);
  assert.equal(w('echo a > $FILE').unknown, true, 'a target it cannot read fails closed');
  assert.deepEqual(w('swarm tickets T-0001 --set done').writes, [], 'swarm commands do their own writing');
  assert.deepEqual(tokenize('a "b c" \'d e\' f\\ g > out; x && y | z').map(w => [...w]), [['a', 'b c', 'd e', 'f g', '>', 'out'], ['x'], ['y'], ['z']]);
});

test('a blocked edit; an approved edit inside scope; an approved edit outside scope; an expired approval; a worktree', async t => {
  const root = await project(t);
  // blocked: no approval
  const blocked = edit(root, 'src/a.ts');
  assert.equal(blocked.allow, false);
  assert.match(blocked.reason, /write a ticket instead/);
  assert.match(blocked.reason, /swarm handbuild request --kind/);
  // the orchestrator's own folders, build output, outside the checkout, reading: allowed without approval
  for (const rel of ['.swarm/project/x.json', 'docs/plans/p.md', 'node_modules/x/y.js', '.next/a.js']) assert.equal(edit(root, rel).allow, true, rel);
  assert.equal(guardDecision({ tool: 'Edit', toolInput: { file_path: '/Users/x/.claude/memory/m.md' }, root, cwd: root, now: () => T0 }).allow, true);
  assert.equal(guardDecision({ tool: 'Read', toolInput: { file_path: path.join(root, 'src/a.ts') }, root, cwd: root, now: () => T0 }).allow, true);
  assert.equal(bash(root, 'npm test && npm run build && git status').allow, true);
  // a pending request approves nothing
  const r = request(root);
  assert.equal(edit(root, 'src/a.ts').allow, false, 'pending');
  decideRequest(root, r.id, 'approve', { now: () => T0 });
  // approved, in scope (a file and a folder), inside the window
  assert.equal(edit(root, 'src/a.ts', T0 + 60000).allow, true);
  assert.equal(edit(root, 'supabase/migrations/0007_x.sql', T0 + 60000).allow, true);
  assert.equal(guardDecision({ tool: 'MultiEdit', toolInput: { file_path: path.join(root, 'src/a.ts') }, root, cwd: root, now: () => T0 + 60000 }).approval, r.id);
  // approved, outside scope: still blocked
  assert.equal(edit(root, 'src/other.ts', T0 + 60000).allow, false);
  assert.equal(edit(root, 'package.json', T0 + 60000).allow, false);
  // expired
  assert.equal(edit(root, 'src/a.ts', T0 + 31 * 60000).allow, false, '31 minutes later');
  assert.equal(activeApprovals(root, T0 + 31 * 60000).length, 0);
  // a swarm worker workspace is not the checkout: the guard script lets it through (see the process test)
  assert.equal(matchesFile(['src/**'], 'src/a/b.ts'), true);
  assert.equal(matchesFile(['src/*.ts'], 'src/a/b.ts'), false);
  assert.equal(matchesFile(['src/a.ts'], 'src/a.tsx'), false);
});

test('shell writes need the same approval; git commit and push need to be named and a commit carries only the approved files; the owner\'s files cannot be requested or run by the session', async t => {
  const root = await project(t);
  const git = (...args) => spawnSync('git', ['-c', 'user.email=a@b', '-c', 'user.name=a', ...args], { cwd: root, encoding: 'utf8' });
  git('init', '-q');
  await fs.writeFile(path.join(root, 'src/a.ts'), 'a\n');
  await fs.writeFile(path.join(root, 'src/other.ts'), 'o\n');
  git('add', '-A'); git('commit', '-q', '-m', 'base');
  assert.equal(bash(root, 'sed -i "" s/a/b/ src/a.ts').allow, false);
  assert.equal(bash(root, 'echo x > src/a.ts').allow, false);
  assert.equal(bash(root, 'git commit -am x').allow, false);
  assert.equal(bash(root, 'node -e "require(\'fs\').writeFileSync(\'q\',1)"').allow, false);
  assert.match(bash(root, 'echo $X > $Y').reason, /cannot tell what it writes/);
  const r = request(root, { files: 'src/a.ts', git: 'commit' });
  decideRequest(root, r.id, 'approve', { now: () => T0 });
  assert.equal(bash(root, 'sed -i "" s/a/b/ src/a.ts', T0 + 1000).allow, true);
  assert.equal(bash(root, 'sed -i "" s/a/b/ src/other.ts', T0 + 1000).allow, false, 'outside the named files');
  await fs.writeFile(path.join(root, 'src/a.ts'), 'changed\n');
  git('add', 'src/a.ts');
  assert.equal(bash(root, 'git commit -m x', T0 + 1000).allow, true, 'commit was named and carries only src/a.ts');
  await fs.writeFile(path.join(root, 'src/other.ts'), 'changed\n');
  git('add', 'src/other.ts');
  assert.equal(bash(root, 'git commit -m x', T0 + 1000).allow, false, 'the staged src/other.ts is not covered');
  assert.equal(bash(root, 'git commit -am x', T0 + 1000).allow, false, '-a would carry it too');
  git('reset', '-q', 'src/other.ts');
  await fs.writeFile(path.join(root, 'src/other.ts'), 'o\n');
  assert.equal(bash(root, 'git push origin main', T0 + 1000).allow, false, 'push was not named');
  assert.equal(bash(root, 'sed -i "" s/a/b/ src/a.ts', T0 + 31 * 60000).allow, false, 'expired');
  // protected: it cannot even be requested, and no approval covers it
  for (const f of ['.claude/settings.local.json', '.swarm/handbuild/state.json', '.git/hooks/pre-commit', '.swarm/handbuild']) assert.throws(() => request(root, { files: f, reason: 'let me turn the guard off please' }), /belongs to the owner/, f);
  for (const rel of ['.claude/settings.local.json', '.swarm/handbuild/state.json', '.swarm/handbuild/off', '.swarm/handbuild', '.swarm', '.SWARM/Handbuild/state.json', '.git/hooks/pre-commit', '.git/config']) assert.equal(edit(root, rel, T0 + 1000).allow, false, rel);
  assert.equal(bash(root, 'echo {} > .swarm/handbuild/state.json', T0 + 1000).allow, false);
  assert.equal(bash(root, 'rm -rf .swarm/handbuild', T0 + 1000).allow, false);
  assert.equal(bash(root, 'mv .swarm/handbuild /tmp/x', T0 + 1000).allow, false);
  assert.equal(bash(root, 'rm -rf .swarm', T0 + 1000).allow, false);
  assert.equal(bash(root, 'tar -xf a.tar -C .swarm', T0 + 1000).allow, false, 'extracting into the folder that holds the state');
  assert.equal(bash(root, 'echo x > .swarm/*/state.json', T0 + 1000).allow, false, 'a pattern as a target');
  for (const c of ['swarm handbuild approve hb-1', 'swarm handbuild deny hb-1', 'swarm handbuild off', 'swarm handbuild uninstall', 'swarm decide handbuild-hb-1 approve', 'node tools/swarm.mjs handbuild approve hb-1']) assert.equal(bash(root, c, T0 + 1000).allow, false, c);
  assert.equal(bash(root, 'swarm handbuild request --kind tiny --reason "four lines blocked" --files src/a.ts', T0 + 1000).allow, true, 'asking is allowed');
  assert.equal(bash(root, 'swarm handbuild status', T0 + 1000).allow, true);
});

test('a request must give a valid reason, real files, and a short time; anything else is "write a ticket instead"', async t => {
  const root = await project(t);
  const base = { kind: 'tiny', reason: 'four lines and the swarm is blocked', files: 'src/a.ts' };
  assert.throws(() => createRequest(root, { ...base, kind: 'convenience' }), /write a ticket instead/);
  assert.throws(() => createRequest(root, { ...base, kind: undefined }), /--kind must be one of/);
  assert.throws(() => createRequest(root, { ...base, reason: 'quick' }), /at least 10 characters/);
  assert.throws(() => createRequest(root, { ...base, files: '' }), /must name the files/);
  assert.throws(() => createRequest(root, { ...base, files: '**' }), /catch-all/);
  assert.throws(() => createRequest(root, { ...base, files: '../x,/etc/passwd' }), /not specific enough/);
  assert.throws(() => createRequest(root, { ...base, minutes: 500 }), /1 to 120/);
  assert.throws(() => createRequest(root, { ...base, git: 'rebase' }), /--git must name one of/);
  assert.throws(() => createRequest(root, { ...base, files: Array.from({ length: 30 }, (_, i) => `src/${i}.ts`).join(',') }), /at most 20/);
  for (const kind of ['swarm-cannot', 'emergency', 'secret', 'tiny']) assert.ok(createRequest(root, { ...base, kind }).id.startsWith('hb-'));
  const denied = createRequest(root, base);
  decideRequest(root, denied.id, 'deny', { now: () => T0 });
  assert.equal(edit(root, 'src/a.ts').allow, false, 'a denied request approves nothing');
  assert.throws(() => decideRequest(root, denied.id, 'approve'), /already denied/);
  assert.throws(() => decideRequest(root, 'hb-nope', 'approve'), /no hand-build request/);
});

test('every request, approval, denial and blocked attempt is on the journal and in the guard\'s log', async t => {
  const root = await project(t);
  const r = request(root, { files: 'src/a.ts' });
  decideRequest(root, r.id, 'approve', { now: () => T0 });
  const run = (input) => spawnSync(process.execPath, [GUARD], { input: JSON.stringify(input), encoding: 'utf8' });
  run({ session_id: 's1', cwd: root, tool_name: 'Edit', tool_input: { file_path: path.join(root, 'src/zzz.ts') } });   // not covered: blocked
  const d = request(root, { files: 'src/b.ts', reason: 'a second one to deny it' });
  decideRequest(root, d.id, 'deny', { now: () => T0 });
  const journal = (await readJournal(root, { limit: Infinity })).filter(e => String(e.action ?? '').startsWith('handbuild-')).map(e => e.action);
  assert.deepEqual([...new Set(journal)].sort(), ['handbuild-approve', 'handbuild-blocked', 'handbuild-deny', 'handbuild-request']);
  const log = fsSync.readFileSync(path.join(root, LOG_FILE), 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.ok(log.some(e => e.event === 'blocked' && e.tool === 'Edit' && e.files.includes('src/zzz.ts')));
  assert.ok(log.some(e => e.event === 'request') && log.some(e => e.event === 'approve') && log.some(e => e.event === 'deny'));
});

test('the guard hook as a process: deny output with the reason, allow prints nothing, workers and outside paths pass, junk fails open, off switches it off', async t => {
  const root = await project(t);
  const run = (input, raw) => spawnSync(process.execPath, [GUARD], { input: raw ?? JSON.stringify(input), encoding: 'utf8' });
  const denied = run({ session_id: 's1', cwd: path.join(root, 'src'), tool_name: 'Write', tool_input: { file_path: path.join(root, 'src/new.ts'), content: 'x' } });
  assert.equal(denied.status, 0);
  const out = JSON.parse(denied.stdout);
  assert.equal(out.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /write a ticket instead/);
  const ev = readEvents(root).find(e => e.e === 'blocked');
  assert.deepEqual([ev.t, ev.f], ['Write', 'src/new.ts'], 'the attempt is on the Orchestrator lane');
  assert.equal(handBuiltOf(readEvents(root)).blocked, 1);
  assert.equal(run({ session_id: 's1', cwd: root, tool_name: 'Write', tool_input: { file_path: path.join(root, 'docs/plans/p.md') } }).stdout, '');
  assert.equal(run({ session_id: 's1', cwd: root, tool_name: 'Bash', tool_input: { command: 'npm test' } }).stdout, '');
  // a swarm worker workspace: edits there are the swarm's own
  const workspace = path.join(root, '.swarm/workspaces/run1/job-1');
  await fs.mkdir(workspace, { recursive: true });
  assert.equal(run({ session_id: 'w', cwd: workspace, tool_name: 'Edit', tool_input: { file_path: path.join(workspace, 'src/a.ts') } }).stdout, '', 'worktree edits allowed');
  assert.equal(run({ session_id: 'w', cwd: root, tool_name: 'Edit', tool_input: { file_path: '/tmp/other/a.ts' } }).stdout, '', 'outside the checkout');
  for (const junk of ['not json', '', 'null', '{"cwd":1}']) { const r = run(null, junk); assert.equal(r.status, 0, junk); assert.equal(r.stdout, '', junk); }
  const none = await tmp(t);
  assert.equal(run({ session_id: 's', cwd: none, tool_name: 'Edit', tool_input: { file_path: path.join(none, 'a.ts') } }).stdout, '', 'a folder that is not a project');
  await fs.mkdir(path.join(root, '.swarm/handbuild'), { recursive: true });
  await fs.writeFile(path.join(root, OFF_FILE), '');
  assert.equal(run({ session_id: 's1', cwd: root, tool_name: 'Edit', tool_input: { file_path: path.join(root, 'src/new.ts') } }).stdout, '', 'switched off');
});

test('the request is a decision in Needs you; the owner approves with swarm handbuild approve, swarm decide, or the phone\'s choice; no backlog goal is made', async t => {
  const root = await project(t);
  const asked = await runHandbuildCommand(root, ['request', '--kind', 'secret', '--reason', 'it writes the service key into .env', '--files', 'src/env.ts', '--minutes', '15'], { now: () => T0 });
  assert.equal(asked.exitCode, 0, asked.stdout);
  assert.match(asked.stdout, /waiting for the owner/);
  const [req] = listRequests(root);
  const items = await collectInbox([root], inboxDeps({ now: () => T0 }));
  const item = items.find(i => i.id === `handbuild-${req.id}`);
  assert.equal(item.kind, 'decision');
  assert.deepEqual(item.choices, ['approve', 'deny']);
  assert.equal(item.default, 'deny', 'the safe answer is the default');
  assert.match(item.title, /Hand-build request \(secret\)/);
  assert.match(item.title, /Recommendation: deny unless/);
  // the way the board and phone answer it
  const decided = await runInboxCommand(root, 'decide', [`handbuild-${req.id}`, 'approve'], { now: () => T0 });
  assert.equal(decided.exitCode, 0, decided.stdout);
  assert.equal(listRequests(root)[0].status, 'approved');
  assert.equal(edit(root, 'src/env.ts', T0 + 1000).allow, true);
  const backlog = await fs.readFile(path.join(root, '.swarm/project/backlog.json'), 'utf8').catch(() => '');
  assert.ok(!/Change decision/.test(backlog), 'no plan goal for a hand-build decision');
  assert.equal((await collectInbox([root], inboxDeps({ now: () => T0 }))).some(i => i.id === `handbuild-${req.id}`), false, 'answered: gone from Needs you');
  // the plain command, and deny
  await runHandbuildCommand(root, ['request', '--kind', 'tiny', '--reason', 'three lines and the swarm is blocked', '--files', 'src/t.ts'], { now: () => T0 });
  const second = listRequests(root).find(r => r.status === 'pending');
  assert.match((await runHandbuildCommand(root, ['deny', second.id], { now: () => T0 })).stdout, /denied/);
  const bad = await runHandbuildCommand(root, ['request', '--kind', 'because', '--reason', 'it would be quicker by hand', '--files', 'src/t.ts']);
  assert.equal(bad.exitCode, 1);
  assert.match(bad.stdout, /write a ticket instead/);
  assert.match((await runHandbuildCommand(root, ['status'])).stdout, /live approval/);
  assert.match((await runHandbuildCommand(root, ['log'])).stdout, /request/);
});

test('hand-build inbox approve flow uses one injectable clock (not the real clock)', async t => {
  const root = await project(t);
  const clock = T0 - 30 * 24 * 60 * 60 * 1000;
  const now = () => clock;
  const asked = await runHandbuildCommand(root, ['request', '--kind', 'secret', '--reason', 'it writes the service key into .env', '--files', 'src/env.ts', '--minutes', '15'], { now });
  assert.equal(asked.exitCode, 0, asked.stdout);
  const [req] = listRequests(root);
  const decided = await runInboxCommand(root, 'decide', [`handbuild-${req.id}`, 'approve'], { now });
  assert.equal(decided.exitCode, 0, decided.stdout);
  assert.equal(listRequests(root)[0].status, 'approved');
  assert.equal(guardDecision({ tool: 'Edit', toolInput: { file_path: path.join(root, 'src/env.ts') }, root, cwd: root, now }).allow, true);
});

test('shell writes make the hand-built share complete: the lane lists the files a command wrote, and blocked attempts are counted', async t => {
  const root = await project(t);
  const ev = (command, kind = 'post') => buildEvent(kind, { session_id: 's', cwd: root, tool_name: 'Bash', tool_input: { command } }, { root, now: () => T0, analyze: analyzeShell });
  const sed = ev('sed -i "" s/a/b/ src/a.ts src/b.ts');
  assert.deepEqual([sed.bf, sed.hb], [['src/a.ts', 'src/b.ts'], 1]);
  assert.equal(ev('npm test').hb, undefined);
  assert.deepEqual(ev('git commit -am x').bg, ['commit']);
  assert.equal(ev('echo a > $X').bu, 1);
  assert.equal(ev('echo a > docs/plans/p.md').hb, undefined);
  const events = [ev('echo 1 > src/x.ts'), ev('sed -i "" s/a/b/ src/a.ts src/x.ts'), { ...buildEvent('post', { session_id: 's', tool_name: 'Edit', tool_input: { file_path: path.join(root, 'src/e.ts') } }, { root, now: () => T0 }) }, { at: new Date(T0).toISOString(), s: 's', e: 'blocked', t: 'Edit', f: 'src/q.ts' }];
  assert.deepEqual(handBuiltOf(events), { files: 3, edits: 3, blocked: 1, list: ['src/x.ts', 'src/a.ts', 'src/e.ts'] });
  // as a real hook process
  const r = spawnSync(process.execPath, [HOOK, 'post'], { input: JSON.stringify({ session_id: 's', cwd: root, tool_name: 'Bash', tool_input: { command: 'tee src/z.ts < in' } }), encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.deepEqual(readEvents(root).at(-1).bf, ['src/z.ts']);
});

test('the guard is installed on request (and removed), keeps other hooks, update only refreshes where it is, and a broken file is left alone', async t => {
  const root = await project(t), install = await tmp(t);
  const file = path.join(root, '.claude/settings.local.json');
  await fs.mkdir(path.dirname(file));
  await fs.writeFile(file, JSON.stringify({ permissions: { allow: ['Bash(ls)'] }, hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'my-own' }] }] } }));
  assert.equal((await ensureHandbuildGuard(root, install, { refreshOnly: true })).status, 'absent', 'update does not add it');
  assert.equal((await ensureHandbuildGuard(root, install)).status, 'updated');
  const read = async () => JSON.parse(await fs.readFile(file, 'utf8'));
  let s = await read();
  const guard = s.hooks.PreToolUse.find(e => e.hooks.some(h => h.command.includes('handbuild-guard.mjs')));
  assert.equal(guard.matcher, 'Edit|Write|MultiEdit|NotebookEdit|Bash');
  const script = JSON.stringify(path.join(install, 'tools/handbuild-guard.mjs'));
  assert.equal(guard.hooks[0].command, `test -f ${script} && node ${script} || true`, 'a missing script is a no-op, never an error');
  assert.ok(s.hooks.PreToolUse.some(e => e.hooks.some(h => h.command === 'my-own')));
  assert.deepEqual(s.permissions, { allow: ['Bash(ls)'] });
  assert.equal((await ensureHandbuildGuard(root, install)).status, 'unchanged');
  assert.equal((await ensureHandbuildGuard(root, path.join(install, 'moved'), { refreshOnly: true })).status, 'updated', 'update refreshes the path where it is installed');
  assert.equal((await removeHandbuildGuard(root)).status, 'removed');
  s = await read();
  assert.ok(!JSON.stringify(s).includes('handbuild-guard.mjs'));
  assert.ok(s.hooks.PreToolUse.some(e => e.hooks.some(h => h.command === 'my-own')), 'only the guard was removed');
  assert.equal((await removeHandbuildGuard(root)).status, 'was not installed');
  await fs.writeFile(file, '{ nope');
  assert.equal((await ensureHandbuildGuard(root, install)).status, 'skipped');
  assert.equal(await fs.readFile(file, 'utf8'), '{ nope');
  // the command that runs in a missing-script world really is silent and exits 0
  const missing = spawnSync('sh', ['-c', `test -f ${JSON.stringify(path.join(install, 'nope.mjs'))} && node ${JSON.stringify(path.join(install, 'nope.mjs'))} || true`], { encoding: 'utf8' });
  assert.deepEqual([missing.status, missing.stdout, missing.stderr], [0, '', '']);
});

test('review findings: the shell analyzer reads bash -c, substitutions, subshells, cd, xargs, find, interpreters on writable scripts, downloads and extraction; here-document text is data', async t => {
  const root = await project(t);
  const home = '/Users/someone';
  const outsideCd = `cd ${os.tmpdir()} && echo x > y.txt`;
  const a = c => analyzeShell(c, { root, cwd: root, home, protectedAbs: [path.join(home, '.project-swarm')] });
  const blocks = c => { const r = a(c); return r.writes.length > 0 || r.git.length > 0 || r.inline || r.unknown || r.selfApproval || r.protectedOutside.length > 0; };
  for (const c of [
    'bash -c "echo hi > src/a.ts"', 'sh -c \'sed -i "" s/a/b/ src/a.ts\'', 'eval "rm src/a.ts"', 'echo $(rm src/a.ts)', 'echo `touch src/new.ts`', '(rm src/a.ts)', '{ rm src/a.ts; }', 'true && (cd src; echo x > a.ts)',
    'cd src && echo x > a.ts', 'cd src; tee a.ts < in', 'cd $WHERE && echo x > a.ts', 'ls src | xargs rm', 'find src -name "*.ts" -delete', 'find src -exec sed -i "" s/a/b/ {} \;',
    'curl -o src/a.ts https://x.test/a', 'wget -O src/a.ts https://x.test/a', 'curl -O https://x.test/a.ts', 'tar -xf a.tar', 'tar xzf a.tgz -C src', 'unzip a.zip -d src', 'rsync -a /tmp/x/ src/', 'patch src/a.ts < fix.diff',
    'python3 .swarm/fix.py', 'node docs/plans/x.mjs', 'bash .swarm/run.sh', 'echo "rm src/a.ts" | sh', 'git commit -am x', 'git config core.hooksPath /tmp/x',
    'swarm handbuild approve hb-1', 'swarm "handbuild" \'approve\' hb-1', 'bash -c "swarm handbuild off"', 'node tools/swarm.mjs handbuild   deny  hb-1', 'swarm decide handbuild-hb-1 approve', 'echo ok; swarm handbuild uninstall',
    `echo x > ${home}/.project-swarm/current/tools/handbuild-guard.mjs`, `sed -i "" s/a/b/ ${home}/.project-swarm/versions/1.0.0-x/tools/handbuild-guard.mjs`, `cp /tmp/x ${home}/.project-swarm/current/tools/handbuild-guard.mjs`,
  ]) assert.equal(blocks(c), true, `should be blocked: ${c}`);
  for (const c of [
    'npm test', 'npx vitest run', 'node --test tests/a.test.mjs', 'python3 -m pytest', 'cat <<EOF\nrm src/a.ts\n> src/b.ts\nEOF', 'cat > /tmp/note.txt <<\'EOF\'\nsed -i s/a/b/ src/a.ts\nEOF', 'echo "rm src/a.ts is how you delete it"',
    'cd src && ls && grep -rn foo .', outsideCd, 'bash -c "npm test"', 'echo $(date)', 'find src -name "*.ts" | head', 'ls src | xargs wc -l', 'curl https://x.test/a | head', 'git log --oneline | head',
    'swarm tickets T-0001 --set done', 'swarm handbuild request --kind tiny --reason "four lines blocked" --files src/a.ts', 'swarm handbuild status', 'node tools/swarm.mjs run manifest.json', 'node docs/plans/../../tests/x.mjs'.replace('docs/plans/../../', ''),
    'echo hi > .swarm/notes.txt', 'echo hi >> docs/plans/p.md', 'python3 -c "print(1)"',
  ]) assert.equal(blocks(c), false, `should be allowed: ${c} -> ${JSON.stringify(a(c))}`);
});

test('review findings: the install and the user\'s own Claude settings hold the guard itself, so neither the edit tools nor the shell can write them', async t => {
  const root = await project(t);
  const home = await tmp(t);
  const decide = (tool, toolInput) => guardDecision({ tool, toolInput, root, cwd: root, now: () => T0, home });
  for (const file of [path.join(home, '.project-swarm/current/tools/handbuild-guard.mjs'), path.join(home, '.project-swarm/versions/1.0.0-x/tools/handbuild.mjs'), path.join(home, '.claude/settings.json'), path.join(home, '.claude/settings.local.json')]) {
    const d = decide('Edit', { file_path: file });
    assert.equal(d.allow, false, file);
    assert.match(d.reason, /belongs to the owner/);
  }
  assert.equal(decide('Edit', { file_path: path.join(home, '.claude/memory/notes.md') }).allow, true, 'other files outside the checkout stay free');
  assert.equal(decide('Bash', { command: `echo '{}' > ${home}/.claude/settings.json` }).allow, false);
  assert.equal(decide('Bash', { command: `echo '{}' > ${home}/.claude/projects/x/notes.txt` }).allow, true);
  const quoted = decide('Bash', { command: 'swarm "handbuild" off' });
  assert.equal(quoted.allow, false);
  assert.match(quoted.reason, /switching the guard off, is the owner/);
  // even an approval that names them covers nothing
  const r = createRequest(root, { kind: 'swarm-cannot', reason: 'the swarm cannot edit its own guard here', files: 'src/a.ts' }, { now: () => T0 });
  decideRequest(root, r.id, 'approve', { now: () => T0 });
  assert.equal(decide('Edit', { file_path: path.join(home, '.project-swarm/current/tools/handbuild-guard.mjs') }).allow, false);
});

test('second review: wrappers with options, awk, interpreters on stdin or outside scripts, git that changes the tree, patterns; and what stays allowed', async t => {
  const root = await project(t);
  await fs.writeFile(path.join(root, 'src/a.ts'), 'a\n');
  const a = c => analyzeShell(c, { root, cwd: root, home: '/Users/someone', protectedAbs: [] });
  const blocks = c => { const r = a(c); return r.writes.length > 0 || r.git.length > 0 || r.inline || r.unknown || r.selfApproval; };
  for (const c of [
    'timeout 5 rm src/a.ts', 'sudo -u root tee src/a.ts', 'nice -n 10 sed -i "" s/a/b/ src/a.ts', 'env -u HOME touch src/a.ts', 'stdbuf -oL tee src/a.ts', 'xargs -n 1 rm',
    'awk \'BEGIN { system("rm src/a.ts") }\'', 'awk \'{ print > "src/a.ts" }\' in', 'awk -i inplace \'{ print }\' src/a.ts',
    'echo "console.log(1)" | node', 'python3 /tmp/x.py', 'node /tmp/other/run.js', 'node -r ./preload.js app.js && sh .swarm/x.sh', 'python3 -c "import os; os.remove(\'src/a.ts\')"', 'node -e "const h = require(\'./tools/handbuild.mjs\')"',
    'git branch -D feat', 'git checkout src/a.ts', 'git checkout -- src/a.ts', 'git tag v1', 'git update-ref -d refs/heads/x', 'git read-tree HEAD', 'git checkout-index -a', 'git stash', 'git commit -m x', 'git branch -m old new', 'git checkout -f main',
    'echo x > .swarm', 'touch .swarm/handbuild/off', 'cp /tmp/x .git/hooks/pre-commit', 'echo x > .git/config',
  ]) assert.equal(blocks(c), true, `should be blocked: ${c} -> ${JSON.stringify(a(c))}`);
  for (const c of [
    'timeout 30 npm test', 'sudo -u x ls', 'nice -n 5 npm run build', 'env FOO=1 npm test', 'xargs -n 1 echo', 'awk \'{ print $1 }\' file', 'echo "print(1)" | python3 -c "print(1 + 1)"', 'node -e "console.log(1 + 1)"', 'python3 -c "print(sum(range(10)))"',
    'node tools/swarm.mjs status', 'node node_modules/.bin/vitest run', 'node scripts/build.mjs', 'python3 -m pytest -q', 'git status', 'git diff HEAD~1', 'git log --oneline -5', 'git show HEAD:src/a.ts', 'git checkout main', 'git checkout -b feat/new', 'git switch main', 'git branch', 'git branch -a', 'git tag -l', 'git fetch origin', 'git add -A',
    'echo "$(date)" > /tmp/x', "echo '$(rm src/a.ts)'", 'tar -czf out.tgz src', 'tar tf x.tgz', 'echo x > .swarm/tickets/x.txt',
  ]) assert.equal(blocks(c), false, `should be allowed: ${c} -> ${JSON.stringify(a(c))}`);
});

test('second review: requests cannot be broad, protected or stale; the state is written by one process at a time', async t => {
  const root = await project(t);
  const base = { kind: 'tiny', reason: 'four lines and the swarm is blocked' };
  for (const files of ['src/**', '**/*.ts', 'src/', '*.ts', 'src/*/**', '{src,app}/a.ts', '.git/hooks/', '.swarm/handbuild/state.json', '.claude/settings.local.json']) assert.throws(() => createRequest(root, { ...base, files }), /not specific enough|belongs to the owner/, files);
  for (const files of ['src/a.ts', 'src/components/*.tsx', 'supabase/migrations/', 'src/lib/']) assert.ok(createRequest(root, { ...base, files }).id, files);
  // a pending request that waited over a day expires instead of being approvable
  const old = createRequest(root, { ...base, files: 'src/old.ts' }, { now: () => T0 });
  assert.throws(() => decideRequest(root, old.id, 'approve', { now: () => T0 + 25 * 3600 * 1000 }), /expired/);
  assert.equal(listRequests(root).find(r => r.id === old.id).status, 'expired');
  // many requests at once from separate processes: none is lost
  const script = `import { createRequest } from ${JSON.stringify(path.join(path.dirname(GUARD), 'handbuild.mjs'))}; createRequest(${JSON.stringify(root)}, { kind: 'tiny', reason: 'four lines and the swarm is blocked', files: 'src/p' + process.argv[2] + '.ts' });`;
  const before = listRequests(root).length;
  const children = Array.from({ length: 8 }, (_, i) => new Promise(resolve => { const c = spawnSync(process.execPath, ['--input-type=module', '-e', script, String(i)], { encoding: 'utf8' }); resolve(c.status); }));
  assert.deepEqual(await Promise.all(children), Array(8).fill(0));
  assert.equal(listRequests(root).length, before + 8, 'no request was lost');
  assert.deepEqual(fsSync.readdirSync(path.join(root, '.swarm/handbuild')).filter(n => n.includes('.tmp-') || n === 'state.lock'), [], 'no temp or lock file left');
});

test('second review: the project is the one Claude Code names, whatever the folder the session is in; a swarm workspace may be written, the checkout from inside it may not; too-large input is refused', async t => {
  const root = await project(t);
  const elsewhere = await tmp(t);
  const run = (input, env = {}, raw) => spawnSync(process.execPath, [GUARD], { input: raw ?? JSON.stringify(input), encoding: 'utf8', env: { ...process.env, ...env } });
  // the session has moved out of the project; an absolute path into the checkout is still guarded
  const out = run({ session_id: 's', cwd: elsewhere, tool_name: 'Write', tool_input: { file_path: path.join(root, 'src/new.ts') } }, { CLAUDE_PROJECT_DIR: root });
  assert.equal(JSON.parse(out.stdout).hookSpecificOutput.permissionDecision, 'deny');
  assert.equal(run({ session_id: 's', cwd: elsewhere, tool_name: 'Bash', tool_input: { command: `echo x > ${path.join(root, 'src/q.ts')}` } }, { CLAUDE_PROJECT_DIR: root }).stdout.includes('deny'), true);
  // inside a swarm workspace: the workspace is the swarm's, the checkout is not
  const workspace = path.join(root, '.swarm/workspaces/run1/job-1');
  await fs.mkdir(path.join(workspace, 'src'), { recursive: true });
  assert.equal(run({ session_id: 'w', cwd: workspace, tool_name: 'Write', tool_input: { file_path: 'src/a.ts' } }, { CLAUDE_PROJECT_DIR: root }).stdout, '', 'relative write in the workspace');
  assert.equal(run({ session_id: 'w', cwd: workspace, tool_name: 'Write', tool_input: { file_path: path.join(root, 'src/real.ts') } }, { CLAUDE_PROJECT_DIR: root }).stdout.includes('deny'), true, 'the checkout from inside a workspace');
  assert.equal(run({ session_id: 'w', cwd: workspace, tool_name: 'Write', tool_input: { file_path: path.join(root, 'src/real.ts') } }).stdout.includes('deny'), true, 'also found from the workspace path alone');
  // input too large to read is refused, not waved through
  const huge = JSON.stringify({ session_id: 's', cwd: root, tool_name: 'Write', tool_input: { file_path: path.join(root, 'src/big.ts'), content: 'x'.repeat(2100000) } });
  const big = run(null, { CLAUDE_PROJECT_DIR: root }, huge);
  assert.match(JSON.parse(big.stdout).hookSpecificOutput.permissionDecisionReason, /too large for the guard to read/);
});

test('second review: a blocked tool call does not leave the session showing as working; an uninstalled guard stays uninstalled across init; the matcher is refreshed', async t => {
  const events = [{ at: new Date(T0).toISOString(), s: 'A', e: 'prompt' }, { at: new Date(T0 + 1000).toISOString(), s: 'A', e: 'pre', t: 'Edit', f: 'src/a.ts', u: 'u1' }, { at: new Date(T0 + 1100).toISOString(), s: 'A', e: 'blocked', t: 'Edit', f: 'src/a.ts' }];
  assert.equal(sessionsOf(events, T0 + 5000)[0].state, 'thinking');
  assert.equal(sessionsOf(events, T0 + 5000)[0].blocked, 1);
  const root = await project(t), install = await tmp(t);
  const file = path.join(root, '.claude/settings.local.json');
  await fs.mkdir(path.dirname(file));
  await fs.writeFile(file, JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Read', hooks: [{ type: 'command', command: `test -f "/old/tools/handbuild-guard.mjs" && node "/old/tools/handbuild-guard.mjs" || true` }] }] } }));
  assert.equal((await ensureHandbuildGuard(root, install)).status, 'updated');
  assert.equal(JSON.parse(await fs.readFile(file, 'utf8')).hooks.PreToolUse[0].matcher, 'Edit|Write|MultiEdit|NotebookEdit|Bash', 'a narrower old matcher is replaced');
  await removeHandbuildGuard(root);
  assert.equal((await ensureHandbuildGuard(root, install, { honorRemoved: true })).status, 'removed-by-owner', 'init does not bring it back');
  assert.equal((await ensureHandbuildGuard(root, install)).status, 'updated', 'swarm handbuild install does');
});

test('third review: bundled flags, shell keywords, variable command words, scripts by path, other interpreters, git settings, cd that may not happen, here-documents, sed w/e, curl/tar variants', async t => {
  const root = await project(t);
  await fs.mkdir(path.join(root, 'scripts'));
  await fs.writeFile(path.join(root, 'scripts/ok.sh'), 'echo ok');
  const outsideCd = `cd ${os.tmpdir()} && echo x > y.txt`;
  const a = c => analyzeShell(c, { root, cwd: root, home: '/Users/someone', protectedAbs: [path.join('/Users/someone', '.project-swarm'), path.join('/Users/someone', '.claude', 'settings.json')] });
  const blocks = c => { const r = a(c); return r.writes.length > 0 || r.git.length > 0 || r.inline || r.unknown || r.selfApproval || r.protectedOutside.length > 0; };
  for (const c of [
    `echo "it's" "$(rm src/a.ts)"`, 'bash -lc "rm src/a.ts"', 'sh -ec "echo x > src/a.ts"', 'perl -ne \'system("rm x")\' f', 'if true; then rm src/a.ts; fi', 'while true; do touch src/a.ts; done', '$CMD src/a.ts', '`which rm` src/a.ts',
    '(cd src; echo x > a.ts)', 'cd nowhere-here || echo x > src/a.ts', 'source .swarm/env.sh', '. docs/plans/run.sh', './.swarm/x.sh', '/tmp/evil.sh', 'dist/tool.sh',
    'python3.12 -c "open(\'x\',\'w\').write(\'1\')"', 'fish -c "rm src/a.ts"', 'Rscript -e "unlink(\'src/a.ts\')"', 'ruby -e "File.write(\'x\', 1)"', 'php -r "file_put_contents(\'x\', 1);"', 'node -e "const x = 1; require(\'fs\')"',
    'git -c core.pager="rm x" log', 'GIT_EXTERNAL_DIFF=x git diff', 'git diff --output=src/a.ts', 'git remote set-url origin x', 'git switch -f main',
    'sed -n "w src/a.ts" f', 'sed "s/a/b/w src/a.ts" f', 'env -S "rm src/a.ts"', 'timeout 1.5 rm src/a.ts', 'cat <<EOF | tee src/a.ts\nx\nEOF', 'curl -sLo src/a.ts https://x.test', 'wget https://x.test/a.zip', 'tar -x -f a.tar', 'patch < fix.diff',
    'ln -s src/a.ts .swarm/link', 'rm -rf ~/.claude', 'rm -rf /Users/someone/.project-swarm', 'echo x > .swarm/*',
  ]) assert.equal(blocks(c), true, `should be blocked: ${c} -> ${JSON.stringify(a(c))}`);
  for (const c of [
    'node --test', 'node -v', 'command -v python3', 'python3 --version', './scripts/ok.sh', 'bash scripts/ok.sh', 'cd src && ls && echo x > /tmp/y', outsideCd, 'if true; then npm test; fi', 'for f in a b; do echo $f; done',
    'rm -rf dist/*', 'rm -rf build/cache/* node_modules/.cache/x', 'git -C /tmp/other-repo commit -m x', 'git diff --stat', 'git log -p -3', 'git remote -v', 'git tag -l', 'git checkout main', 'git switch main',
    'curl -s https://x.test | head', 'tar tf a.tar', 'tar -czf /tmp/o.tgz src', 'sed -n 1,5p f', 'sed "s/a/b/" f', 'echo "it\'s fine $(date)" > /tmp/q',
    'python3 -c "print(sum(range(10)))"', 'node -e "console.log(2 ** 8)"', 'echo \'$(rm src/a.ts) is data\'',
  ]) assert.equal(blocks(c), false, `should be allowed: ${c} -> ${JSON.stringify(a(c))}`);
});

test('third review: requests name specific files; a commit with a same-line add is checked; the protected folders include their parents', async t => {
  const root = await project(t);
  const base = { kind: 'tiny', reason: 'four lines and the swarm is blocked' };
  for (const files of ['src/*', '.git', '.', 'src/*/*', 'a/*']) assert.throws(() => createRequest(root, { ...base, files }), /not specific enough|belongs to the owner/, files);
  for (const files of ['src/a.ts', 'src/components/*.tsx', 'supabase/migrations/']) assert.ok(createRequest(root, { ...base, files }).id, files);
  assert.equal(matchesFile(['src/components/'], 'src/components/a.tsx'), true);
  assert.equal(matchesFile(['src/comp*/'], 'src/components/a.tsx'), false, 'a wildcard in a folder pattern is literal, not a regular expression');
  const git = (...args) => spawnSync('git', ['-c', 'user.email=a@b', '-c', 'user.name=a', ...args], { cwd: root, encoding: 'utf8' });
  git('init', '-q');
  await fs.writeFile(path.join(root, 'src/a.ts'), 'a\n'); await fs.writeFile(path.join(root, 'src/b.ts'), 'b\n');
  git('add', '-A'); git('commit', '-q', '-m', 'base');
  const r = createRequest(root, { ...base, files: 'src/a.ts', git: 'commit' }, { now: () => T0 });
  decideRequest(root, r.id, 'approve', { now: () => T0 });
  await fs.writeFile(path.join(root, 'src/a.ts'), 'a2\n'); await fs.writeFile(path.join(root, 'src/b.ts'), 'b2\n');
  assert.equal(bash(root, 'git add src/a.ts && git commit -m x', T0 + 1000).allow, true, 'a same-line add of the approved file');
  assert.equal(bash(root, 'git add src/b.ts && git commit -m x', T0 + 1000).allow, false, 'a same-line add of another file');
  assert.equal(bash(root, 'git add -A && git commit -m x', T0 + 1000).allow, false, 'add -A cannot be checked');
  assert.equal(bash(root, 'git add . ; git commit -m x', T0 + 1000).allow, false);
});

import { installProject } from '../tools/install.mjs';
test('init links a new project with the guard; re-running it in an existing project never turns the guard on', async t => {
  const packageRoot = fileURLToPath(new URL('..', import.meta.url));
  const settings = async root => JSON.parse(await fs.readFile(path.join(root, '.claude/settings.local.json'), 'utf8'));
  const hasGuard = s => JSON.stringify(s).includes('handbuild-guard.mjs');
  const fresh = await project(t);
  const first = await installProject(fresh, { source: packageRoot });
  assert.ok(['created', 'updated'].includes(first.handbuildGuard.status));
  assert.equal(hasGuard(await settings(fresh)), true);
  // an existing project (already linked, no guard): init again changes the pointer, not the guard
  const existing = await project(t);
  await fs.writeFile(path.join(existing, '.project-swarm.json'), JSON.stringify({ install: packageRoot, version: '1.0.0' }));
  const again = await installProject(existing, { source: packageRoot });
  assert.equal(again.handbuildGuard, null);
  const s = await settings(existing);
  assert.equal(hasGuard(s), false, 'no guard');
  assert.equal(JSON.stringify(s).includes('orchestrator-hook.mjs'), true, 'the observer hooks are there');
  // a project that removed the guard keeps it removed across init
  await removeHandbuildGuard(fresh);
  await fs.rm(path.join(fresh, '.project-swarm.json'));     // as if linked again for the first time
  assert.equal((await installProject(fresh, { source: packageRoot })).handbuildGuard.status, 'removed-by-owner');
});
