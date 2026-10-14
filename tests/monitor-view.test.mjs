// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { renderMonitorView, formatDuration, supportsColor, visibleLength } from '../tools/monitor-view.mjs';
import { runManifest, summarizeRun } from '../tools/swarm.mjs';

const runner = fileURLToPath(new URL('../tools/swarm.mjs', import.meta.url));
const ANSI_RE = /\u001b\[[0-9;]*m/;

test('monitor sanitizes every cell and idle-seat text before measuring widths', () => {
  const dirty = '\u001b[31mclean\u001b[0m\u001b]title\u0007\u001b[2J\u001b[4;1H\u0000\u0007\u007f\u0085\u202e\u2066\nname';
  const text = renderMonitorView(fixtureView({ jobs: [{ id: dirty, agent: dirty, model: dirty, tier: dirty, status: dirty, outputCount: dirty }], idleSeatEvents: [{ type: 'idle-seat', idleMinutes: dirty, runnableTasks: [dirty] }] }), { width: 200 });
  assert.ok(text.includes('clean name'));
  assert.doesNotMatch(text, /[\u0000-\u0009\u001b\u007f-\u009f\u202e\u2066]/);
  assert.ok(text.split('\n').every(line => line.length <= 200));
});

test('monitor renders lane health, waiting queue, merge state and spend after usage', () => {
  const view = fixtureView({ lanes: { lanes: {
    codex: { state: 'ok', inFlight: 3, concurrency: 6, queued: 2 },
    cursor: { state: 'paused', until: new Date(81000).toISOString() },
    hermes: { state: 'backoff' },
  } }, queued: 7, mergeQueue: { state: 'waiting' }, spend: { costUsd: 1.234, tokens: 42 } });
  const text = renderMonitorView(view, { width: 200, now: 1000 });
  assert.match(text, /lanes  codex 3\/6 run, 2 queued - cursor paused 1m20s - hermes backoff/);
  assert.match(text, /queue  7 waiting\nmerge  waiting\nspend  \$1.23 - tokens 42/);
  assert.match(renderMonitorView(fixtureView({ lanes: { lanes: { cursor: { state: 'paused', until: 81000 } } } }), { width: 200, now: 1000 }), /cursor paused 1m20s/);
  assert.ok(text.indexOf('usage') < text.indexOf('lanes'));
  assert.ok(text.indexOf('spend') < text.indexOf('JOB'));
  assert.match(renderMonitorView(fixtureView({ integratedAt: '2026-01-01T00:00:00Z' })), /merge  integrated 2026-01-01T00:00:00Z/);
  assert.match(renderMonitorView(fixtureView({ mergeQueue: null, integratedAt: null })), /merge  not integrated/);
  assert.doesNotMatch(renderMonitorView(fixtureView({ lanes: { lanes: {} }, spend: { costUsd: 0, tokens: 0 } })), /lanes  |spend  |queue  |merge  /);
});

test('large monitor views hide completed jobs and cap unfinished rows at forty', () => {
  const jobs = Array.from({ length: 100 }, (_, i) => ({ id: `job-${i}`, status: i < 50 ? 'complete' : 'queued' }));
  const text = renderMonitorView(fixtureView({ jobs }), { width: 200 });
  assert.doesNotMatch(text, /job-0\s/);
  assert.match(text, /job-50\s/);
  assert.doesNotMatch(text, /job-90\s/);
  assert.match(text, /\.\.\. 50 complete jobs hidden; swarm rollup demo-run --text for the summary/);
  const small = renderMonitorView(fixtureView({ jobs: jobs.slice(0, 40) }), { width: 200 });
  assert.equal(small.split('\n').filter(line => /job-\d/.test(line)).length, 40);
  assert.doesNotMatch(small, /jobs hidden/);
});

test('monitor merge summary includes integrated, requeued and flagged counts', () => {
  const mergeQueue = { state: 'done', summary: { integrated: Array(200), requeued: Array(10), flagged: Array(2) } };
  const text = renderMonitorView(fixtureView({ mergeQueue }), { width: 200 });
  assert.match(text, /merge  done - 200 integrated - 10 requeued - 2 flagged/);
  assert.ok(renderMonitorView(fixtureView({ mergeQueue }), { width: 40 }).split('\n').every(line => visibleLength(line) <= 40));
});

function fixtureView(overrides = {}) {
  return {
    id: 'demo-run',
    status: 'running',
    peakConcurrency: 3,
    elapsedMs: 252000,
    counts: { queued: 1, running: 2, complete: 3, failed: 1, timeout: 0, cancelled: 0 },
    usageByProvider: { claude: { input_tokens: 1200, output_tokens: 340 } },
    jobs: [
      { id: 'render-review', agent: 'claude', model: 'sonnet', tier: 'mid', tierReason: null, status: 'complete', durationMs: 45230, outputCount: 1 },
      { id: 'scroll-anim', agent: 'claude', model: null, tier: null, status: 'running', durationMs: 12040, outputCount: 2 },
      { id: 'copy-writer', agent: 'openai', model: 'gpt-5', tier: 'cheap', status: 'failed', durationMs: 3000, outputCount: 0 },
      { id: 'queued-job', agent: 'claude', model: null, tier: null, status: 'queued', durationMs: null, outputCount: 1 },
    ],
    ...overrides,
  };
}

test('renders one row per job with status symbol and word, plus a summary line', () => {
  const text = renderMonitorView(fixtureView(), { width: 100, color: false });
  const lines = text.split('\n');
  assert.match(lines[0], /demo-run/);
  assert.match(lines[0], /running/);
  assert.match(lines[1], /2 running/);
  assert.match(lines[1], /3 done/);
  assert.match(lines[1], /1 failed/);
  assert.match(lines[1], /1 queued/);
  assert.match(lines[1], /peak concurrency 3/);
  assert.match(lines[2], /claude: input_tokens 1200 output_tokens 340/);
  const table = lines.slice(4);
  const header = table[0];
  for (const label of ['JOB', 'AGENT', 'MODEL', 'TIER', 'STATUS', 'TIME', 'OUT']) assert.match(header, new RegExp(label));
  assert.match(table.find(l => l.includes('render-review')), /\+ done/);
  assert.match(table.find(l => l.includes('scroll-anim')), /> running/);
  assert.match(table.find(l => l.includes('copy-writer')), /x failed/);
  assert.match(table.find(l => l.includes('queued-job')), /\. queued/);
  // Never color alone: every status cell pairs a symbol with a plain word.
  for (const status of ['+ done', '> running', 'x failed', '. queued']) assert.ok(table.some(l => l.includes(status)));
});

test('table rows stay aligned: every row and the header share one column width per column', () => {
  const text = renderMonitorView(fixtureView(), { width: 100, color: false });
  const table = text.split('\n').slice(4);
  const lengths = new Set(table.map(line => line.length));
  assert.equal(lengths.size, 1, `expected one shared line length, saw ${[...lengths]}`);
});

test('NO_COLOR / non-TTY input renders plain text with no ANSI escapes', () => {
  assert.equal(supportsColor({ isTTY: true }, {}), true);
  assert.equal(supportsColor({ isTTY: true }, { NO_COLOR: '1' }), false);
  assert.equal(supportsColor({ isTTY: false }, {}), false);
  assert.equal(supportsColor(undefined, {}), false);
  const text = renderMonitorView(fixtureView(), { width: 100, color: false });
  assert.equal(ANSI_RE.test(text), false);
});

test('color:true adds ANSI codes around the status cell only, never elsewhere', () => {
  const text = renderMonitorView(fixtureView(), { width: 100, color: true });
  assert.equal(ANSI_RE.test(text), true);
  const plain = text.replace(/\u001b\[[0-9;]*m/g, '');
  // Stripping color must reproduce exactly the plain-text rendering byte for byte.
  assert.equal(plain, renderMonitorView(fixtureView(), { width: 100, color: false }));
});

test('truncates to terminal width without breaking column alignment', () => {
  for (const width of [80, 60, 40, 28]) {
    const text = renderMonitorView(fixtureView(), { width, color: false });
    const lines = text.split('\n');
    for (const line of lines) assert.ok(line.length <= width, `line exceeded width ${width}: "${line}" (${line.length})`);
    const table = lines.slice(4);
    const lengths = new Set(table.map(line => line.length));
    assert.equal(lengths.size, 1, `misaligned table at width ${width}`);
  }
});

test('missing optional fields (null model/tier, no duration) render as a dash, not "null"', () => {
  const view = fixtureView({ jobs: [{ id: 'bare', agent: 'claude', model: null, tier: null, status: 'queued', durationMs: null, outputCount: 0 }] });
  const text = renderMonitorView(view, { width: 100, color: false });
  assert.equal(text.includes('null'), false);
  assert.equal(text.includes('undefined'), false);
  const row = text.split('\n').find(l => l.includes('bare'));
  assert.match(row, /-/);
});

test('formatDuration renders human units and a dash for missing values', () => {
  assert.equal(formatDuration(null), '-');
  assert.equal(formatDuration(undefined), '-');
  assert.equal(formatDuration(-5), '-');
  assert.equal(formatDuration(500), '500ms');
  assert.equal(formatDuration(45230), '45s');
  assert.equal(formatDuration(252000), '4m12s');
  assert.equal(formatDuration(2 * 3600000 + 5 * 60000), '2h05m');
});

test('omits the usage line entirely when nothing was recorded', () => {
  const text = renderMonitorView(fixtureView({ usageByProvider: {} }), { width: 100, color: false });
  assert.equal(text.includes('usage'), false);
});

test('visibleLength ignores embedded ANSI codes', () => {
  assert.equal(visibleLength('\u001b[32mdone\u001b[0m'), 4);
  assert.equal(visibleLength('plain'), 5);
});

test('an empty job list still renders a valid, width-bounded summary', () => {
  const text = renderMonitorView(fixtureView({ jobs: [], counts: { queued: 0, running: 0, complete: 0, failed: 0, timeout: 0, cancelled: 0 } }), { width: 100, color: false });
  assert.match(text, /0 running · 0 done · 0 failed · 0 queued/);
});

// --- CLI integration: the existing JSON `monitor` contract must not change. ---

function fixtureManifest() {
  return { version: 1, concurrency: 2, jobs: [{ id: 'writer', agent: 'claude', model: 'haiku', prompt: 'Do the task.', context: ['input.txt'], outputs: [], timeoutMs: 5000, tier: 'mid' }] };
}

function fakeSpawn(_command, _args, options) {
  const script = `console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,result:'ok'}));`;
  return spawn(process.execPath, ['--input-type=module', '-e', script], options);
}

async function fixtureRoot(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'monitor-view-test-'));
  await fs.writeFile(path.join(root, 'input.txt'), 'original');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

test('monitor keeps its JSON snapshot unchanged when --view is not passed', async t => {
  const root = await fixtureRoot(t);
  const state = await runManifest(root, fixtureManifest(), { spawnImpl: fakeSpawn });
  assert.equal(state.status, 'complete');
  const expected = summarizeRun(state);
  const { stdout, status } = spawnSync(process.execPath, [runner, '--root', root, 'monitor', state.id], { encoding: 'utf8' });
  assert.equal(status, 0);
  const parsed = JSON.parse(stdout);
  assert.deepEqual(parsed, expected);
});

test('monitor --view prints a human table instead of JSON, and exits 0 for a finished run', async t => {
  const root = await fixtureRoot(t);
  const state = await runManifest(root, fixtureManifest(), { spawnImpl: fakeSpawn });
  const result = spawnSync(process.execPath, [runner, '--root', root, 'monitor', state.id, '--view'], { encoding: 'utf8' });
  assert.equal(result.status, 0);
  assert.throws(() => JSON.parse(result.stdout));
  assert.match(result.stdout, /writer/);
  assert.match(result.stdout, /\+ done/);
  assert.match(result.stdout, /mid/); // tier, merged in from the saved manifest
  assert.equal(ANSI_RE.test(result.stdout), false); // spawnSync stdout is piped, never a TTY
});

test('monitor --watch on an already-finished run renders once and returns without hanging', async t => {
  const root = await fixtureRoot(t);
  const state = await runManifest(root, fixtureManifest(), { spawnImpl: fakeSpawn });
  const start = Date.now();
  const result = spawnSync(process.execPath, [runner, '--root', root, 'monitor', state.id, '--watch', '5'], { encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 0);
  assert.ok(Date.now() - start < 4000, 'must not wait out the watch interval once the run is already terminal');
  assert.match(result.stdout, /writer/);
});

test('monitor --watch rejects a non-positive interval', async t => {
  const root = await fixtureRoot(t);
  const state = await runManifest(root, fixtureManifest(), { spawnImpl: fakeSpawn });
  const result = spawnSync(process.execPath, [runner, '--root', root, 'monitor', state.id, '--watch', '0'], { encoding: 'utf8' });
  assert.notEqual(result.status, 0);
});
