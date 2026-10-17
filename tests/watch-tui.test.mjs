import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { renderTui, formatBar } from '../tools/watch-tui.mjs';

const ESC_RE = /\u001b\[[0-9;]*m/g;
const SGR_256_RE = /\u001b\[38;5;[0-9]+m/;
const NL = String.fromCharCode(10);
const LONG_GOAL = ('Ship the swarm watch dashboard with lanes, waves, attention feed and merge queue status for every run. ').repeat(3);

function strip(text) {
  return text.replace(ESC_RE, '');
}

function linesOf(text) {
  return text.split(NL);
}

function maxVisible(text) {
  return Math.max(...linesOf(strip(text)).map((line) => line.length));
}

function indexOfLine(lines, needle) {
  return lines.findIndex((line) => line.indexOf(needle) !== -1);
}

function makeAttention(count) {
  const items = [];
  for (let i = 1; i <= count; i += 1) {
    const n = String(i).padStart(2, '0');
    items.push({
      at: '2024-01-01T00:00:' + n + '.000Z',
      kind: 'failure',
      severity: 'error',
      jobId: 'job-' + n,
      text: 'ATTN-' + n + ' sample failure'
    });
  }
  return items;
}

function makeSnapshot(options) {
  const opts = options || {};
  return {
    schema: 1,
    runId: 'run-test-1',
    goal: opts.goal || 'Short goal',
    branch: 'swarm/test',
    status: 'live',
    startedAt: '2024-01-01T00:00:00.000Z',
    finishedAt: null,
    elapsedMs: 60000,
    kpi: {
      total: 4, done: 2, running: 1, queued: 1, failed: 0, cancelled: 0,
      retries: 0, firstTryPassRate: 1, peakInFlight: 2, spendUsd: 1.25,
      jobsPerSec: 0.03, etaMs: 60000
    },
    jobs: [],
    lanes: [
      {
        name: 'zeta-lane', state: 'ok', offline: false, inFlight: 1, limit: 2,
        done: 2, failed: 0, passRate: 1, avgMs: 1500, rateLimits: 0,
        costUsd: 1.25, reason: null
      }
    ],
    waves: [
      { name: 'contracts', total: 1, done: 1, running: 0 },
      { name: 'build', total: 2, done: 1, running: 1 },
      { name: 'verify', total: 1, done: 0, running: 0 }
    ],
    attention: opts.attention || [],
    leads: [],
    mergeQueue: { state: 'MQSTATE-x', batches: 1, integrated: 0, conflicts: 0, bisects: 0, recent: [] },
    rollup: null
  };
}

test('renderTui returns lines joined by newlines with no trailing newline', () => {
  const text = renderTui(makeSnapshot(), { width: 100 });
  assert.equal(typeof text, 'string');
  assert.ok(text.length > 0);
  assert.notEqual(text.charAt(text.length - 1), NL);
});

test('at width 80 no visible line exceeds 80 characters', () => {
  const snap = makeSnapshot({ goal: LONG_GOAL, attention: makeAttention(6) });
  const text = renderTui(snap, { width: 80 });
  assert.ok(maxVisible(text) <= 80, 'line too long: ' + maxVisible(text));
});

test('at width 80 with color no visible line exceeds 80 characters', () => {
  const snap = makeSnapshot({ goal: LONG_GOAL, attention: makeAttention(6) });
  const text = renderTui(snap, { width: 80, color: true });
  assert.ok(maxVisible(text) <= 80, 'line too long: ' + maxVisible(text));
});

test('at width 160 no visible line exceeds 160 characters', () => {
  const snap = makeSnapshot({ goal: LONG_GOAL, attention: makeAttention(6) });
  const text = renderTui(snap, { width: 160 });
  assert.ok(maxVisible(text) <= 160, 'line too long: ' + maxVisible(text));
});

test('default width still keeps lines within 100 characters', () => {
  const snap = makeSnapshot({ goal: LONG_GOAL });
  const text = renderTui(snap);
  assert.ok(maxVisible(text) <= 100, 'line too long: ' + maxVisible(text));
});

test('color and plain output have identical visible text at width 80', () => {
  const snap = makeSnapshot({ goal: LONG_GOAL, attention: makeAttention(3) });
  const plain = renderTui(snap, { width: 80 });
  const color = renderTui(snap, { width: 80, color: true });
  assert.equal(plain.indexOf('\u001b'), -1);
  assert.equal(strip(color), plain);
});

test('color and plain output have identical visible text at width 160', () => {
  const snap = makeSnapshot({ goal: LONG_GOAL, attention: makeAttention(3) });
  const plain = renderTui(snap, { width: 160 });
  const color = renderTui(snap, { width: 160, color: true });
  assert.equal(plain.indexOf('\u001b'), -1);
  assert.equal(strip(color), plain);
});

test('color mode uses 256-color escapes and plain mode uses none', () => {
  const snap = makeSnapshot({ attention: makeAttention(2) });
  const plain = renderTui(snap, { width: 100 });
  const color = renderTui(snap, { width: 100, color: true });
  assert.equal(SGR_256_RE.test(plain), false);
  assert.equal(SGR_256_RE.test(color), true);
});

test('sections appear in order: header, lanes, waves, attention, merge', () => {
  const snap = makeSnapshot({ attention: makeAttention(2) });
  const lines = linesOf(strip(renderTui(snap, { width: 100 })));
  const goalAt = indexOfLine(lines, 'Short goal');
  const laneAt = indexOfLine(lines, 'zeta-lane');
  const waveAt = indexOfLine(lines, 'contracts');
  const attAt = indexOfLine(lines, 'ATTN-01');
  const mergeAt = indexOfLine(lines, 'MQSTATE-x');
  assert.ok(goalAt >= 0 && laneAt >= 0 && waveAt >= 0 && attAt >= 0 && mergeAt >= 0);
  assert.ok(goalAt < laneAt, 'header before lanes');
  assert.ok(laneAt < waveAt, 'lanes before waves');
  assert.ok(waveAt < attAt, 'waves before attention');
  assert.ok(attAt < mergeAt, 'attention before merge');
});

test('attention shows at most six items, in the order given', () => {
  const snap = makeSnapshot({ attention: makeAttention(10) });
  const text = strip(renderTui(snap, { width: 160 }));
  assert.notEqual(text.indexOf('ATTN-01'), -1);
  assert.notEqual(text.indexOf('ATTN-06'), -1);
  assert.equal(text.indexOf('ATTN-07'), -1);
  assert.equal(text.indexOf('ATTN-10'), -1);
});

test('null snapshot renders a single no-run-found line', () => {
  const lines = linesOf(renderTui(null, { width: 80 }));
  assert.equal(lines.length, 1);
  assert.match(lines[0], /no run found/i);
});

test('formatBar uses only hash and dot characters', () => {
  const bar = formatBar(3, 7, 20);
  assert.equal(/^[#.]+$/.test(bar), true);
});

test('formatBar has the requested width', () => {
  assert.equal(formatBar(3, 7, 20).length, 20);
  assert.equal(formatBar(0, 5, 12).length, 12);
});

test('formatBar is empty of hashes at zero progress and full of hashes when complete', () => {
  assert.equal(formatBar(0, 4, 10).indexOf('#'), -1);
  assert.equal(formatBar(4, 4, 10).indexOf('.'), -1);
});

test('formatBar fills about half the bar at half progress', () => {
  const bar = formatBar(2, 4, 10);
  const hashes = bar.split('#').length - 1;
  assert.ok(Math.abs(hashes - 5) <= 1, 'hashes: ' + hashes);
});

test('formatBar does not throw when total is zero', () => {
  const bar = formatBar(0, 0, 10);
  assert.equal(bar.indexOf('#'), -1);
});
