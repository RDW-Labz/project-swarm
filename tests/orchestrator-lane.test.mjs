// SPDX-License-Identifier: Apache-2.0
// The Orchestrator lane, tested with recorded (fake) Claude Code hook events and a fake session transcript.
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildEvent, appendEvent, readEvents, sessionsOf, handBuiltOf, maskCommand, isHandBuilt, insideProject, projectRootOf, EVENTS_FILE } from '../tools/orchestrator-events.mjs';
import { sessionUsage } from '../tools/orchestrator-usage.mjs';
import { projectOrchestrator } from '../tools/board-orchestrator.mjs';
import { ensureOrchestratorHooks, stableInstallDir } from '../tools/install.mjs';
import { projectOverview, boardSnapshot } from '../tools/board-data.mjs';

const HOOK = fileURLToPath(new URL('../tools/orchestrator-hook.mjs', import.meta.url));
const tmp = async t => { const d = await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-orch-')); t.after(() => fs.rm(d, { recursive: true, force: true })); return d; };
const T0 = Date.UTC(2026, 9, 20, 12, 0, 0);
// transcripts of the fixtures live under the temp folder: allowed for this test file only
process.env.SWARM_TRANSCRIPT_ROOTS = os.tmpdir();
const at = (sec) => () => T0 + sec * 1000;

test('an event holds the session, tool and a path inside the project: never contents, prompt text or outside paths', async t => {
  const root = await tmp(t);
  const e = buildEvent('pre', { session_id: 's1', cwd: root, tool_name: 'Edit', tool_input: { file_path: path.join(root, 'src/a.ts'), old_string: 'SECRET OLD', new_string: 'SECRET NEW' } }, { root, now: at(0) });
  assert.deepEqual(e, { at: new Date(T0).toISOString(), s: 's1', e: 'pre', t: 'Edit', f: 'src/a.ts', hb: 1 });
  assert.ok(!JSON.stringify(e).includes('SECRET'));
  const w = buildEvent('pre', { session_id: 's1', tool_name: 'Write', tool_input: { file_path: path.join(root, 'docs/plans/p.md'), content: 'body' } }, { root, now: at(1) });
  assert.equal(w.hb, undefined, 'docs/plans is the orchestrator\'s own');
  assert.equal(buildEvent('pre', { session_id: 's1', tool_name: 'Edit', tool_input: { file_path: path.join(root, '.swarm/tickets.json') } }, { root }).hb, undefined);
  const out = buildEvent('pre', { session_id: 's1', tool_name: 'Edit', tool_input: { file_path: '/Users/x/.claude/memory/m.md' } }, { root });
  assert.deepEqual([out.f, out.out, out.hb], [undefined, 1, undefined], 'a path outside the project is noted, not stored');
  const read = buildEvent('pre', { session_id: 's1', tool_name: 'Read', tool_input: { file_path: path.join(root, 'src/a.ts') } }, { root });
  assert.equal(read.hb, undefined, 'reading is not building');
  const prompt = buildEvent('prompt', { session_id: 's1', prompt: 'please do the thing with my password hunter2', transcript_path: '/h/.claude/projects/p/s1.jsonl' }, { root });
  assert.deepEqual(Object.keys(prompt).sort(), ['at', 'e', 's', 'tp']);
  const err = buildEvent('post', { session_id: 's1', tool_name: 'Bash', tool_input: { command: 'npm test' }, tool_response: { is_error: true } }, { root });
  assert.equal(err.err, 1);
  assert.equal(buildEvent('pre', { session_id: 's1', cwd: path.join(root, '.swarm/workspaces/run1/job'), tool_name: 'Edit', tool_input: {} }, { root }), null, 'a swarm worker is not an orchestrator');
  assert.equal(buildEvent('pre', { cwd: root, tool_name: 'Edit' }, { root }), null);
  assert.equal(buildEvent('nope', { session_id: 's' }, { root }), null);
  assert.equal(isHandBuilt('Bash', 'src/a.ts'), false);
  assert.equal(insideProject(root, '../x'), null);
});

test('a shell command is stored shortened with secrets, assignments and long opaque strings masked', () => {
  const bearerToken = 'abc' + 'DEF' + '123456789';
  const skLive = ['sk', '-live-'].join('') + '1234567890abcdef';
  const apiKeyVal = 'hun' + 'ter2';
  const ghp = ['gh', 'p_'].join('') + 'abcdefghijklmnopqrstuvwxyz0123456789ab';
  const curlCmd = 'curl -H "Authorization: Bearer ' + bearerToken + '" https://x.test --token ' + skLive + ' API_KEY=' + apiKeyVal + ' npm test ' + ghp;
  const m = maskCommand(curlCmd);
  assert.ok(!/hunter2|abcDEF123456789|sk-live|ghp_/.test(m), m);
  assert.match(maskCommand('API_KEY=' + apiKeyVal + ' npm test'), /^API_KEY=\[value\] npm test$/);
  assert.ok(maskCommand('x'.repeat(500)).length <= 80);
  assert.equal(maskCommand('npm test'), 'npm test');
  assert.ok(!/\n/.test(maskCommand('a\nb')));
});

test('the hook process appends the event, prints nothing and always exits 0', async t => {
  const root = await tmp(t);
  fsSync.mkdirSync(path.join(root, '.git'));
  const run = (kind, input) => spawnSync(process.execPath, [HOOK, kind], { input: typeof input === 'string' ? input : JSON.stringify(input), encoding: 'utf8' });
  const a = run('pre', { session_id: 'sess-1', cwd: path.join(root, 'src'), tool_name: 'Write', tool_input: { file_path: path.join(root, 'src/new.ts'), content: 'x' } });
  assert.equal(a.status, 0); assert.equal(a.stdout, ''); assert.equal(a.stderr, '');
  const lines = fsSync.readFileSync(path.join(root, EVENTS_FILE), 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.equal(lines.length, 1);
  assert.deepEqual([lines[0].s, lines[0].e, lines[0].t, lines[0].f, lines[0].hb], ['sess-1', 'pre', 'Write', 'src/new.ts', 1]);
  for (const junk of ['not json', '', '{"session_id":1}', 'null']) { const r = run('pre', junk); assert.equal(r.status, 0, junk); }
  assert.equal(readEvents(root).length, 1, 'junk wrote nothing');
  const none = await tmp(t);
  assert.equal(run('pre', { session_id: 's', cwd: none, tool_name: 'Edit', tool_input: {} }).status, 0);
  assert.equal(fsSync.existsSync(path.join(none, EVENTS_FILE)), false, 'a folder that is not a project gets no log');
  assert.equal(projectRootOf(path.join(root, 'src/deep/er')), root);
});

test('ended sessions: end events, proc pid, revival, and process liveness', () => {
  const root = '/proj';
  const end = buildEvent('end', { session_id: 's1', cwd: root, reason: '  logout  ' }, { root, now: at(0) });
  assert.equal(end.e, 'end');
  assert.equal(end.why, 'logout');
  assert.equal(buildEvent('end', { session_id: 's1', cwd: root, reason: 'x'.repeat(50) }, { root, now: at(0) }).why.length, 40);
  const proc = { pid: 4242, host: 'h1' };
  const tp = '/h/.claude/projects/p/s.jsonl';
  for (const kind of ['prompt', 'stop', 'end']) {
    const input = { session_id: 's1', cwd: root, ...(kind === 'end' ? { reason: 'done' } : { transcript_path: tp }) };
    const e = buildEvent(kind, input, { root, now: at(0), proc });
    assert.deepEqual([e.pid, e.h], [4242, 'h1'], kind);
  }
  for (const kind of ['pre', 'post']) {
    const input = kind === 'pre'
      ? { session_id: 's1', cwd: root, tool_name: 'Read', tool_input: { file_path: path.join(root, 'a.ts') } }
      : { session_id: 's1', tool_name: 'Read', tool_input: {} };
    const e = buildEvent(kind, input, { root, now: at(0), proc });
    assert.equal(e.pid, undefined);
    assert.equal(e.h, undefined);
  }
  assert.equal(buildEvent('prompt', { session_id: 's1', cwd: root, transcript_path: tp }, { root, proc: { pid: 0, host: 'h1' } }).pid, undefined);
  assert.equal(buildEvent('prompt', { session_id: 's1', cwd: root, transcript_path: tp }, { root, proc: { pid: 1.5, host: 'h1' } }).pid, undefined);

  const ev = (sec, e, extra = {}) => ({ at: new Date(T0 + sec * 1000).toISOString(), s: 'E', e, ...extra });
  const endMs = T0 + 100 * 1000;
  const endedOnly = [ev(0, 'prompt'), ev(100, 'end', { why: 'logout' })];
  const ended = sessionsOf(endedOnly, endMs)[0];
  assert.equal(ended.state, 'ended');
  assert.equal(ended.endedAt, new Date(endMs).toISOString());
  assert.equal(sessionsOf(endedOnly, endMs + 4 * 60 * 1000)[0].shown, true);
  assert.equal(sessionsOf(endedOnly, endMs + 6 * 60 * 1000)[0].shown, false);
  const revived = [...endedOnly, ev(200, 'prompt')];
  const live = sessionsOf(revived, T0 + 250 * 1000)[0];
  assert.notEqual(live.state, 'ended');
  assert.equal(live.endedAt, null);

  const pidEvents = [ev(0, 'prompt', { pid: 99, h: 'myhost' }), ev(10, 'stop')];
  const lastIso = new Date(T0 + 10 * 1000).toISOString();
  const dead = sessionsOf(pidEvents, T0 + 11 * 1000, { isAlive: () => false, host: 'myhost' })[0];
  assert.equal(dead.state, 'ended');
  assert.equal(dead.endedAt, lastIso);
  assert.equal(sessionsOf(pidEvents, T0 + 10 * 1000, { isAlive: () => false, host: 'myhost' })[0].shown, true);
  assert.equal(sessionsOf(pidEvents, T0 + 10 * 1000 + 6 * 60 * 1000, { isAlive: () => false, host: 'myhost' })[0].shown, false);
  let isAliveCalls = 0;
  const otherHost = sessionsOf(pidEvents, T0 + 11 * 1000, { isAlive: () => { isAliveCalls += 1; return false; }, host: 'other-host' })[0];
  assert.equal(isAliveCalls, 0);
  assert.equal(otherHost.state, 'waiting');
  assert.equal(otherHost.endedAt, null);
  const withoutAlive = sessionsOf(pidEvents, T0 + 11 * 1000)[0];
  assert.notEqual(withoutAlive.state, 'ended');
  assert.equal(withoutAlive.endedAt, null);
});

test('projectOrchestrator ends a session when the hook pid is not alive on this host', async t => {
  const now = Date.now();
  const iso = sec => new Date(now - sec * 1000).toISOString();
  const host = os.hostname();
  const events = [{ at: iso(30), s: 'dead-session', e: 'prompt', pid: 424242, h: host, tp: 'lane.jsonl' }];
  const { project } = await projectWith(t, { events });
  const o = projectOrchestrator(project, { runs: [], now, isAlive: () => false });
  assert.equal(o.sessions.length, 1);
  assert.equal(o.sessions[0].state, 'ended');
  assert.equal(o.sessions[0].endedAt, iso(30));
});

test('session states from recorded events: working, thinking, waiting on you, idle, with what it is doing and since when', () => {
  const ev = (s, sec, e, extra = {}) => ({ at: new Date(T0 + sec * 1000).toISOString(), s, e, ...extra });
  const events = [
    ev('A', 0, 'prompt', { tp: '/t/A.jsonl' }), ev('A', 5, 'pre', { t: 'Read', f: 'src/a.ts' }), ev('A', 6, 'post', { t: 'Read', f: 'src/a.ts' }),
    ev('A', 10, 'pre', { t: 'Edit', f: 'src/a.ts', hb: 1 }), ev('A', 11, 'post', { t: 'Edit', f: 'src/a.ts', hb: 1 }), ev('A', 20, 'pre', { t: 'Bash', c: 'npm test' }),
    ev('B', 0, 'prompt'), ev('B', 30, 'stop'),
    ev('C', -4000, 'stop'),
  ];
  const by = id => sessionsOf(events, T0 + 25 * 1000).find(s => s.id === id);
  assert.equal(by('A').state, 'working');
  assert.deepEqual([by('A').doing.tool, by('A').doing.command, by('A').doing.startedAt], ['Bash', 'npm test', new Date(T0 + 20000).toISOString()]);
  assert.deepEqual([by('A').edits, by('A').handBuilt, by('A').transcript], [1, 1, '/t/A.jsonl']);
  const later = sessionsOf(events, T0 + 40 * 1000);
  assert.equal(later.find(s => s.id === 'B').state, 'waiting', 'the turn ended: waiting on the owner');
  assert.equal(sessionsOf(events, T0 + 40 * 60000).find(s => s.id === 'B').state, 'idle', 'a long wait is idle');
  assert.equal(sessionsOf(events, T0 + 20 * 60000).find(s => s.id === 'A').state, 'idle', 'a tool with no end for a long time is not working');
  assert.equal(later.find(s => s.id === 'C').shown, false, 'a session quiet for over an hour is not in the bay');
  assert.deepEqual(handBuiltOf(events), { files: 1, edits: 1, blocked: 0, list: ['src/a.ts'] });
  const thinking = sessionsOf([ev('D', 0, 'post', { t: 'Read' })], T0 + 30000)[0];
  assert.equal(thinking.state, 'thinking');
});

test('tokens and list cost come from the session transcript: once per message, split into today and all time, only what was appended is read again', async t => {
  const dir = await tmp(t);
  const file = path.join(dir, 's1.jsonl');
  const line = (id, model, ts, usage) => JSON.stringify({ type: 'assistant', timestamp: ts, message: { id, model, usage } }) + '\n';
  const now = Date.UTC(2026, 9, 20, 12, 0, 0);
  const today = new Date(now - 3600000).toISOString(), yesterday = new Date(now - 30 * 3600000).toISOString();
  await fs.writeFile(file, [
    line('m1', 'claude-sonnet-5-5', yesterday, { input_tokens: 1000000, output_tokens: 100000, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }),
    line('m2', 'claude-opus-5-5', today, { input_tokens: 500000, output_tokens: 50000, cache_creation_input_tokens: 100000, cache_read_input_tokens: 2000000 }),
    line('m2', 'claude-opus-5-5', today, { input_tokens: 500000, output_tokens: 50000, cache_creation_input_tokens: 100000, cache_read_input_tokens: 2000000 }),   // a repeat of the same message id
    line('m3', 'claude-fable-5-1', today, { input_tokens: 1000, output_tokens: 1000 }),
    'not json\n', JSON.stringify({ type: 'user', message: {} }) + '\n',
  ].join(''));
  const u = sessionUsage(file, { now });
  // sonnet 1M in at $2 + 0.1M out at $10 = 3.00 (yesterday); opus 0.5M x4 + 0.05M x20 + 0.1M x5 + 2M x0.2 = 2 + 1 + 0.5 + 0.4 = 3.90 (today)
  assert.equal(u.allListUsd, 6.9);
  assert.equal(u.todayListUsd, 3.9);
  assert.equal(u.todayTokens, 2652000);
  assert.equal(u.unpricedTokens, 2000, 'a model without a rate is counted in tokens, never given a made-up price');
  await fs.appendFile(file, line('m4', 'claude-sonnet-5-5', today, { input_tokens: 1000000, output_tokens: 0 }));
  assert.equal(sessionUsage(file, { now }).todayListUsd, 5.9);
  assert.equal(sessionUsage(path.join(dir, 'missing.jsonl'), { now }), null);
});

async function projectWith(t, { events = [], transcript, runs = [] } = {}) {
  const root = await tmp(t);
  for (const e of events) appendEvent(root, e);
  for (const r of runs) { await fs.mkdir(path.join(root, '.swarm/runs', r.id), { recursive: true }); await fs.writeFile(path.join(root, '.swarm/runs', r.id, 'state.json'), JSON.stringify(r.state)); }
  return { root, project: { id: 'p1', name: 'parts-request-app', root } };
}

test('per project: sessions with cost at list value, and the share built by the swarm against by hand', async t => {
  const now = Date.now();
  const iso = sec => new Date(now - sec * 1000).toISOString();
  const dir = await tmp(t);
  const tpath = path.join(dir, 'A.jsonl');
  await fs.writeFile(tpath, JSON.stringify({ type: 'assistant', timestamp: iso(60), message: { id: 'a', model: 'claude-sonnet-5-5', usage: { input_tokens: 1000000, output_tokens: 0 } } }) + '\n');
  const events = [
    { at: iso(100), s: 'A-session-id-long', e: 'prompt', tp: tpath }, { at: iso(50), s: 'A-session-id-long', e: 'pre', t: 'Edit', f: 'src/hand1.ts', hb: 1 }, { at: iso(49), s: 'A-session-id-long', e: 'post', t: 'Edit', f: 'src/hand1.ts', hb: 1 },
    { at: iso(40), s: 'A-session-id-long', e: 'post', t: 'Write', f: 'src/hand2.ts', hb: 1 }, { at: iso(30), s: 'A-session-id-long', e: 'post', t: 'Write', f: 'docs/plans/x.md' },
    { at: iso(10), s: 'A-session-id-long', e: 'pre', t: 'Bash', c: 'npm test' },
  ];
  const runs = [{ id: 'r1', state: { id: 'r1', status: 'complete', jobs: [{ id: 'T-1', status: 'complete', outputs: ['src/a.ts', 'src/b.ts', 'src/c.ts'] }, { id: 'T-2', status: 'failed', outputs: ['src/zz.ts'] }, { id: 'T-3', status: 'complete', outputs: ['src/d.ts', 'src/a.ts'] }] } }];
  const { project } = await projectWith(t, { events, runs });
  const o = projectOrchestrator(project, { runs: [{ id: 'r1', state: runs[0].state }], now });
  assert.equal(o.sessions.length, 1);
  assert.deepEqual([o.sessions[0].state, o.sessions[0].doing.tool, o.sessions[0].doing.command, o.sessions[0].handBuilt], ['working', 'Bash', 'npm test', 2]);
  assert.deepEqual([o.sessions[0].tokensToday, o.sessions[0].listUsdToday], [1000000, 2]);
  assert.deepEqual([o.handBuilt.files, o.swarmBuilt.files, o.swarmPct, o.handPct], [2, 4, 67, 33], '4 swarm-built files (a, b, c, d), 2 by hand');
  assert.match(o.cost.kind, /not billed/);
  assert.equal(projectOrchestrator({ ...project, root: path.join(project.root, 'nope') }, { runs: [] }).sessions.length, 0);
});

test('the board carries the orchestrator in the project overview and the machine totals, and keeps its list value out of billed spend', async t => {
  const now = Date.now();
  const iso = sec => new Date(now - sec * 1000).toISOString();
  const dir = await tmp(t);
  const tpath = path.join(dir, 'B.jsonl');
  await fs.writeFile(tpath, JSON.stringify({ type: 'assistant', timestamp: iso(60), message: { id: 'a', model: 'claude-opus-5-5', usage: { input_tokens: 1000000, output_tokens: 0 } } }) + '\n');
  const { project } = await projectWith(t, { events: [{ at: iso(30), s: 'S1', e: 'post', t: 'Edit', f: 'src/x.ts', hb: 1 }, { at: iso(20), s: 'S1', e: 'stop', tp: tpath }] });
  const overview = await projectOverview(project, [], { now, summary: async () => ({ spendUsd: 0, capUsd: null }) });
  assert.equal(overview.orchestrator.sessions[0].state, 'waiting');
  assert.equal(overview.cost.allUsd, 0, 'no billed dollars');
  assert.equal(overview.orchestrator.cost.allListUsd, 4);
  const snap = await boardSnapshot({ projects: [project], liveRuns: [], now, summary: async () => ({ spendUsd: 0, capUsd: null }) });
  assert.equal(snap.machine.orchestrator.sessions.length, 1);
  assert.deepEqual([snap.machine.orchestrator.allListUsd, snap.machine.cost.allUsd, snap.machine.cost.paidUsd], [4, 0, 0]);
  assert.equal(snap.machine.orchestrator.handBuiltFiles, 1);
  assert.equal(snap.machine.orchestrator.swarmPct, 0);
});

test('the hooks are installed in the personal settings file: five events, idempotent, replaced on update, other hooks and settings kept, a broken file left alone', async t => {
  const root = await tmp(t);
  const install = await tmp(t);
  const versioned = path.join(install, 'versions', '1.145.0-abc');
  await fs.mkdir(versioned, { recursive: true });
  assert.equal(stableInstallDir(versioned), path.join(install, 'current'));
  assert.equal(stableInstallDir(install), install);
  await fs.mkdir(path.join(root, '.claude'));
  const file = path.join(root, '.claude/settings.local.json');
  await fs.writeFile(file, JSON.stringify({ permissions: { allow: ['Bash(npm test)'] }, hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo mine' }] }], PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'my-own-guard' }] }] } }));
  assert.equal((await ensureOrchestratorHooks(root, versioned)).status, 'updated');
  const read = async () => JSON.parse(await fs.readFile(file, 'utf8'));
  let s = await read();
  assert.deepEqual(s.permissions, { allow: ['Bash(npm test)'] });
  for (const [name, kind] of [['PreToolUse', 'pre'], ['PostToolUse', 'post'], ['Stop', 'stop'], ['UserPromptSubmit', 'prompt'], ['SessionEnd', 'end']]) {
    const cmds = s.hooks[name].flatMap(e => e.hooks.map(h => h.command));
    const script = JSON.stringify(path.join(install, 'current/tools/orchestrator-hook.mjs'));
    assert.ok(cmds.includes(`test -f ${script} && node ${script} ${kind} || true`), `${name}: ${cmds}`);
  }
  assert.ok(s.hooks.Stop.flatMap(e => e.hooks.map(h => h.command)).includes('echo mine'));
  assert.ok(s.hooks.PreToolUse.flatMap(e => e.hooks.map(h => h.command)).includes('my-own-guard'));
  assert.equal(s.hooks.PreToolUse.find(e => e.matcher === '*').hooks.length, 1);
  assert.equal((await ensureOrchestratorHooks(root, versioned)).status, 'unchanged');
  assert.equal((await ensureOrchestratorHooks(root, path.join(await tmp(t), 'plain'))).status, 'updated', 'a different install path replaces the command');
  s = await read();
  assert.equal(s.hooks.PostToolUse.length, 1, 'replaced, not added');
  await fs.writeFile(file, '{ broken');
  assert.equal((await ensureOrchestratorHooks(root, versioned)).status, 'skipped');
  assert.equal(await fs.readFile(file, 'utf8'), '{ broken');
});

test('the page code: states, what it does now, and the swarm-built share read the same everywhere', async () => {
  const view = await import('../tools/watch-assets/orchestrator-view.js');
  const now = Date.UTC(2026, 9, 20, 12, 0, 30);
  const since = new Date(now - 12000).toISOString();
  assert.equal(view.doingText({ state: 'working', doing: { tool: 'Edit', file: 'src/a.ts' }, since }, now), 'Edit src/a.ts, 12s');
  assert.equal(view.doingText({ state: 'working', doing: { tool: 'Bash', command: 'npm test' }, since }, now), 'Bash npm test, 12s');
  assert.equal(view.doingText({ state: 'waiting', since: new Date(now - 240000).toISOString() }, now), 'waiting on you, 4m 0s');
  assert.equal(view.doingText({ state: 'thinking', since }, now), 'thinking, 12s');
  assert.equal(view.buildMixText({ swarmPct: 83, handPct: 17, handBuilt: { files: 12 } }), 'swarm-built 83%, hand-built 17% (12 files)');
  assert.equal(view.buildMixText({ swarmPct: null }), null);
  const read = f => fsSync.readFileSync(fileURLToPath(new URL(`../tools/watch-assets/${f}`, import.meta.url)), 'utf8');
  assert.match(read('board.js'), /renderOrchestrator\(\$\('orchBay'\)/);
  assert.match(read('project-live.js'), /renderOrchestrator\(\$\('orchBay'\)/);
  assert.match(read('run.js'), /renderOrchestrator\(\$\('orchBay'\)/);
  assert.match(read('board.html'), /id="orchTable"/);
  assert.doesNotMatch(read('orchestrator-view.js'), /innerHTML/, 'text is set with textContent only');
});

test('a transcript path outside Claude Code\'s own folder is never read', async t => {
  const dir = await tmp(t);
  const file = path.join(dir, 'x.jsonl');
  await fs.writeFile(file, JSON.stringify({ type: 'assistant', timestamp: new Date().toISOString(), message: { id: 'a', model: 'claude-sonnet-5-5', usage: { input_tokens: 1000, output_tokens: 1 } } }) + '\n');
  assert.ok(sessionUsage(file));
  const saved = process.env.SWARM_TRANSCRIPT_ROOTS;
  process.env.SWARM_TRANSCRIPT_ROOTS = path.join(os.tmpdir(), 'somewhere-else-entirely');
  try { assert.equal(sessionUsage(file), null); } finally { process.env.SWARM_TRANSCRIPT_ROOTS = saved; }
  const link = path.join(dir, 'link.jsonl');
  await fs.symlink('/etc/hosts', link);
  assert.equal(sessionUsage(link), null, 'a link out of the folder is followed to its real path and refused');
});

import { resolveTranscript, combinedUsage } from '../tools/orchestrator-usage.mjs';

test('secrets in shell commands: every common form is masked (review findings)', () => {
  const hunter2 = 'hun' + 'ter2';
  const hunter3 = 'hun' + 'ter3';
  const npmTok = ['npm', '_abcdefghijkl'].join('');
  const cases = [
    ['curl --api-key ' + 'abc' + '123' + ' https://x.test', 'abc123'], ['tool --access-token tok_value_1 run', 'tok_value_1'], ['x --client-secret=s3cr3t go', 's3cr3t'], ['mysql -u root -p' + hunter2 + ' db', hunter2],
    ['mysql -p ' + hunter3 + ' db', hunter3], ['curl -u alice:' + 'pw' + '12345' + ' https://x.test', 'pw12345'], ['git clone https://' + 'bob' + ':' + 'pass99' + '@github.com/o/r.git', 'pass99'], ['psql postgres://u:' + 'pgpass' + '@h/db', 'pgpass'],
    ['curl -H "X-Api-Key: keyvalue1" https://x.test', 'keyvalue1'], ['curl -H "Authorization: token ghtokenvalue" https://x.test', 'ghtokenvalue'], ['curl -H "Cookie: sid=cookievalue" https://x', 'cookievalue'],
    ['aws s3 ls --profile x AWS_SECRET_ACCESS_KEY=' + 'abcd' + '1234' + ' ', 'abcd1234'], ['npm publish --otp 123456 --auth-token=' + npmTok, npmTok],
  ];
  for (const [command, secret] of cases) assert.ok(!maskCommand(command).includes(secret), `${command} -> ${maskCommand(command)}`);
  assert.equal(maskCommand('npm test -- staff'), 'npm test -- staff');
  assert.equal(maskCommand('git status --short'), 'git status --short');
});

test('the log refuses links, rotates once under a lock, and keeps the rotated events in view', async t => {
  const root = await tmp(t), elsewhere = await tmp(t);
  fsSync.mkdirSync(path.join(root, '.swarm'), { recursive: true });
  fsSync.symlinkSync(elsewhere, path.join(root, '.swarm/orchestrator'));
  assert.equal(appendEvent(root, { at: new Date().toISOString(), s: 'x', e: 'prompt' }), false);
  assert.deepEqual(fsSync.readdirSync(elsewhere), [], 'nothing was written through the link');
  const root2 = await tmp(t);
  fsSync.mkdirSync(path.join(root2, '.swarm/orchestrator'), { recursive: true });
  fsSync.symlinkSync(path.join(elsewhere, 'target.ndjson'), path.join(root2, EVENTS_FILE));
  assert.equal(appendEvent(root2, { at: new Date().toISOString(), s: 'x', e: 'prompt' }), false);
  assert.equal(fsSync.existsSync(path.join(elsewhere, 'target.ndjson')), false);
  const root3 = await tmp(t);
  const big = 'x'.repeat(2000);
  const file = path.join(root3, EVENTS_FILE);
  fsSync.mkdirSync(path.dirname(file), { recursive: true });
  fsSync.writeFileSync(file, Array.from({ length: 800 }, (_, i) => JSON.stringify({ at: new Date(T0 + i * 1000).toISOString(), s: 'old', e: 'post', t: 'Edit', f: `src/${i}.ts`, hb: 1, pad: big })).join('\n') + '\n');
  assert.ok(fsSync.statSync(file).size > 1500000);
  assert.equal(appendEvent(root3, { at: new Date(T0 + 900000).toISOString(), s: 'new', e: 'prompt' }), true);
  assert.ok(fsSync.existsSync(path.join(path.dirname(file), 'events.1.ndjson')), 'rotated');
  assert.equal(fsSync.existsSync(path.join(path.dirname(file), 'events.lock')), false, 'the lock is released');
  const all = readEvents(root3);
  assert.equal(all.filter(e => e.s === 'old').length, 800, 'the rotated events are still read');
  assert.equal(handBuiltOf(all).files, 800);
  assert.ok(all.at(-1).s === 'new');
  // a stale lock from a dead process does not stop rotation forever
  fsSync.writeFileSync(path.join(path.dirname(file), 'events.lock'), '');
  fsSync.utimesSync(path.join(path.dirname(file), 'events.lock'), new Date(Date.now() - 60000), new Date(Date.now() - 60000));
  fsSync.writeFileSync(file, 'x'.repeat(1600000));
  assert.equal(appendEvent(root3, { at: new Date().toISOString(), s: 'new', e: 'stop' }), true);
});

test('a path that goes through a link out of the project is outside, and a linked project folder still reads as inside', async t => {
  const root = await tmp(t), outside = await tmp(t);
  fsSync.symlinkSync(outside, path.join(root, 'link'));
  assert.equal(insideProject(root, path.join(root, 'link/x.ts')), null);
  assert.equal(insideProject(root, path.join(root, 'src/new/deep.ts')), 'src/new/deep.ts', 'a file that does not exist yet');
  const alias = path.join(await tmp(t), 'alias');
  fsSync.symlinkSync(root, alias);
  assert.equal(insideProject(alias, path.join(root, 'src/a.ts')), 'src/a.ts', 'the project reached through a link');
  const e = buildEvent('pre', { session_id: 's', tool_name: 'Write', tool_input: { file_path: path.join(root, 'link/x.ts') } }, { root });
  assert.deepEqual([e.f, e.out, e.hb], [undefined, 1, undefined], 'not counted as hand-built inside the project');
});

test('parallel tools: one finishing does not hide the others; events are folded in time order', () => {
  const ev = (sec, e, o) => ({ at: new Date(T0 + sec * 1000).toISOString(), s: 'P', e, ...o });
  const events = [ev(0, 'prompt'), ev(1, 'pre', { t: 'Read', f: 'a', u: 'u1' }), ev(2, 'pre', { t: 'Bash', c: 'npm test', u: 'u2' }), ev(3, 'post', { t: 'Read', f: 'a', u: 'u1' })];
  const s = sessionsOf(events, T0 + 5000)[0];
  assert.equal(s.state, 'working');
  assert.deepEqual([s.doing.tool, s.doing.parallel], ['Bash', 1]);
  assert.equal(sessionsOf([...events, ev(4, 'post', { t: 'Bash', u: 'u2' })], T0 + 5000)[0].state, 'thinking');
  // a post that was appended before its pre (two hook processes) still ends up finished
  const swapped = [ev(0, 'prompt'), ev(3, 'post', { t: 'Bash', u: 'z' }), ev(2, 'pre', { t: 'Bash', c: 'ls', u: 'z' })];
  assert.equal(sessionsOf(swapped, T0 + 5000)[0].state, 'thinking');
  assert.equal(buildEvent('pre', { session_id: 's', tool_name: 'Read', tool_use_id: 'toolu_01AbC', tool_input: {} }, { root: '/x' }).u, 'toolu_01AbC');
});

test('the transcript is found by its file name under Claude Code\'s folders and counted once across projects and resumed sessions', async t => {
  const home = await tmp(t);
  const saved = process.env.SWARM_TRANSCRIPT_ROOTS;
  process.env.SWARM_TRANSCRIPT_ROOTS = home;
  t.after(() => { process.env.SWARM_TRANSCRIPT_ROOTS = saved; });
  await fs.mkdir(path.join(home, 'projects/-Users-x-proj'), { recursive: true });
  const line = (id, ts, input) => JSON.stringify({ type: 'assistant', timestamp: ts, message: { id, model: 'claude-sonnet-5-5', usage: { input_tokens: input, output_tokens: 0 } } }) + '\n';
  const now = Date.UTC(2026, 9, 20, 12, 0, 0), ts = new Date(now - 60000).toISOString();
  await fs.writeFile(path.join(home, 'projects/-Users-x-proj/sess-1.jsonl'), line('m1', ts, 1000000) + line('m2', ts, 1000000));
  await fs.writeFile(path.join(home, 'projects/-Users-x-proj/sess-2.jsonl'), line('m2', ts, 1000000) + line('m3', ts, 1000000));   // a resumed session repeats m2
  assert.ok(resolveTranscript('sess-1.jsonl').endsWith('sess-1.jsonl'));
  assert.equal(resolveTranscript('../../etc/passwd'), null);
  assert.equal(resolveTranscript('nope.jsonl'), null);
  assert.equal(sessionUsage('sess-1.jsonl', { now }).todayListUsd, 4);
  const both = combinedUsage(['sess-1.jsonl', 'sess-2.jsonl', 'sess-1.jsonl'], { now });
  assert.equal(both.todayListUsd, 6, 'm1, m2, m3 once each');
  assert.equal(both.transcripts, 2);
  // the same session in two projects' logs is one total at machine level
  const a = await projectWith(t, { events: [{ at: new Date(now - 5000).toISOString(), s: 'S', e: 'stop', tp: 'sess-1.jsonl' }] });
  const b = await projectWith(t, { events: [{ at: new Date(now - 4000).toISOString(), s: 'S', e: 'stop', tp: 'sess-1.jsonl' }] });
  const snap = await boardSnapshot({ projects: [{ ...a.project, id: 'p1' }, { ...b.project, id: 'p2', name: 'other' }], liveRuns: [], now, summary: async () => ({ spendUsd: 0, capUsd: null }) });
  assert.equal(snap.machine.orchestrator.allListUsd, 4, 'not 8');
});

test('hooks: opt-out file, refresh-only on update, unique temp file, mode kept', async t => {
  const root = await tmp(t), install = await tmp(t);
  await fs.mkdir(path.join(root, '.claude'));
  const file = path.join(root, '.claude/settings.local.json');
  assert.equal((await ensureOrchestratorHooks(root, install, { refreshOnly: true })).status, 'absent', 'update does not add hooks to a project that never had agent files');
  assert.equal(fsSync.existsSync(file), false);
  await fs.writeFile(file, JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'command -v swarm >/dev/null 2>&1 && swarm checkpoint --quiet || true' }] }] } }), { mode: 0o640 });
  assert.equal((await ensureOrchestratorHooks(root, install, { refreshOnly: true })).status, 'updated', 'a project set up with the checkpoint hook gets them');
  assert.equal(fsSync.statSync(file).mode & 0o777, 0o640, 'the file keeps its mode');
  assert.deepEqual(fsSync.readdirSync(path.join(root, '.claude')).filter(n => n.includes('swarm-tmp')), []);
  await fs.mkdir(path.join(root, '.swarm/orchestrator'), { recursive: true });
  await fs.writeFile(path.join(root, '.swarm/orchestrator/off'), '');
  assert.equal((await ensureOrchestratorHooks(root, path.join(install, 'other'))).status, 'off');
  assert.ok(JSON.stringify(JSON.parse(await fs.readFile(file, 'utf8'))).includes(install.replace(/\\/g, '/')), 'untouched while switched off');
});
