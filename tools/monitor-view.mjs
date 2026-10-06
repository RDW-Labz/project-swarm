// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Project Swarm contributors
// Human-readable rendering for `monitor --view`. Pure formatting only: no file I/O, no
// process access beyond the explicit options callers pass in, so every code path here is
// deterministic and directly testable against a fixture run view.

const ANSI_RE = /\u001b\[[0-9;]*m/g;
const RESET = '\u001b[0m';

// Symbol AND word together carry status; color is decoration only and is never required
// to tell statuses apart in a plain-text or NO_COLOR terminal.
// ASCII-only symbols: unicode glyphs (checkmarks, ellipses) render at ambiguous widths in
// some terminals, which would silently break column alignment. Every symbol here is
// guaranteed single-column width everywhere a fixed-width font is used.
const STATUS_META = {
  queued: { symbol: '.', word: 'queued', code: '36' },
  running: { symbol: '>', word: 'running', code: '33' },
  complete: { symbol: '+', word: 'done', code: '32' },
  failed: { symbol: 'x', word: 'failed', code: '31' },
  timeout: { symbol: '!', word: 'timeout', code: '31' },
  cancelled: { symbol: '-', word: 'cancelled', code: '90' },
};

// Column priority for dropping whole columns first, before shrinking flexible ones below
// their floor. Never dropped: id, status, time — those carry the essential facts.
const DROPPABLE_ORDER = ['out', 'tier', 'agent', 'model'];

export function supportsColor(stream = undefined, env = process.env) {
  const target = stream ?? process.stdout;
  return Boolean(target && target.isTTY) && !('NO_COLOR' in env);
}

export function visibleLength(text) {
  return String(text ?? '').replace(ANSI_RE, '').length;
}

function colorize(text, code, enabled) {
  return enabled ? `\u001b[${code}m${text}${RESET}` : text;
}

export function formatDuration(ms) {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return '-';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h${String(minutes).padStart(2, '0')}m`;
  if (minutes > 0) return `${minutes}m${String(seconds).padStart(2, '0')}s`;
  return `${seconds}s`;
}

function statusCell(status) {
  const meta = STATUS_META[status] ?? { symbol: '?', word: status ?? 'unknown', code: '37' };
  return { plain: `${meta.symbol} ${meta.word}`, code: meta.code };
}

function pad(text, width, align) {
  const gap = Math.max(0, width - visibleLength(text));
  const spaces = gap ? ' '.repeat(gap) : '';
  return align === 'right' ? spaces + text : text + spaces;
}

function truncate(text, width) {
  if (visibleLength(text) <= width) return text;
  if (width <= 1) return text.slice(0, Math.max(width, 0));
  // Plain ASCII marker: a unicode ellipsis renders at an ambiguous width on some terminals.
  return `${text.slice(0, width - 1)}~`;
}

function buildColumns(jobs, width) {
  const columns = [
    { key: 'id', label: 'JOB', align: 'left', flex: true, min: 4, drop: false, get: job => job.id ?? '-' },
    { key: 'agent', label: 'AGENT', align: 'left', flex: false, drop: true, get: job => job.agent ?? '-' },
    { key: 'model', label: 'MODEL', align: 'left', flex: true, min: 4, drop: true, get: job => job.model ?? '-' },
    { key: 'tier', label: 'TIER', align: 'left', flex: false, drop: true, get: job => job.tier ?? '-' },
    { key: 'status', label: 'STATUS', align: 'left', flex: false, drop: false, get: job => statusCell(job.status).plain },
    { key: 'time', label: 'TIME', align: 'right', flex: false, drop: false, get: job => formatDuration(job.durationMs ?? null) },
    { key: 'out', label: 'OUT', align: 'right', flex: false, drop: true, get: job => String(job.outputCount ?? 0) },
  ];
  for (const column of columns) {
    column.cells = jobs.map(column.get);
    const natural = Math.max(column.label.length, 0, ...column.cells.map(cell => visibleLength(cell)));
    column.width = column.flex ? Math.max(natural, 0) : natural;
    column.natural = natural;
  }
  const gutter = 2;
  let active = columns.slice();
  const totalWidth = () => active.reduce((sum, c) => sum + c.width, 0) + gutter * Math.max(0, active.length - 1);
  // Shrink flexible columns down to their floor before dropping anything.
  while (totalWidth() > width && active.some(c => c.flex && c.width > c.min)) {
    const target = active.filter(c => c.flex && c.width > c.min).sort((a, b) => b.width - a.width)[0];
    target.width -= 1;
  }
  // Still too wide for the available space: drop the least essential columns entirely.
  for (const key of DROPPABLE_ORDER) {
    if (totalWidth() <= width) break;
    active = active.filter(c => c.key !== key || !c.drop);
  }
  // Last resort: shrink flexible columns below their floor, keeping at least 1 column.
  while (totalWidth() > width && active.length > 1 && active.some(c => c.flex && c.width > 1)) {
    const target = active.filter(c => c.flex && c.width > 1).sort((a, b) => b.width - a.width)[0];
    target.width -= 1;
  }
  return active;
}

function renderTable(jobs, width, color) {
  const columns = buildColumns(jobs, width);
  if (!columns.length) return [];
  const headerLine = columns.map(c => pad(truncate(c.label, c.width), c.width, c.align)).join('  ');
  const rows = jobs.map(job => columns.map(c => {
    const raw = c.get(job);
    if (c.key === 'status') {
      const cell = statusCell(job.status);
      const truncated = truncate(cell.plain, c.width);
      return pad(colorize(truncated, cell.code, color), c.width, c.align);
    }
    return pad(truncate(raw, c.width), c.width, c.align);
  }).join('  '));
  // Column math already keeps colored lines within width; plain lines get a final safety
  // truncation for degenerate layouts (e.g. an empty job list narrower than STATUS alone).
  return [headerLine, ...rows].map(line => color ? line : truncate(line, width));
}

function formatUsage(usageByProvider) {
  const providers = Object.keys(usageByProvider ?? {});
  if (!providers.length) return null;
  return providers.map(provider => {
    const fields = Object.entries(usageByProvider[provider]).map(([key, value]) => `${key} ${value}`).join(' ');
    return `${provider}: ${fields}`;
  }).join('  ·  ');
}

export function renderIdleSeatEvents(events, width = 100) {
  const lines = [];
  for (const event of events ?? []) {
    if (event?.type !== 'idle-seat') continue;
    const minutes = event.idleMinutes ?? '-';
    lines.push(truncate(`idle seat: no worker running for ${minutes}m`, width));
    const tasks = event.runnableTasks ?? [];
    lines.push(truncate(
      tasks.length ? `runnable unblocked TASK items: ${tasks.join(', ')}` : 'runnable unblocked TASK items: none',
      width,
    ));
  }
  return lines;
}

// `view` mirrors summarizeRun's shape (id, status, concurrency, peakConcurrency, counts,
// elapsedMs, usageByProvider, jobs[]) with each job entry additionally carrying agent,
// model, tier, tierReason, and outputCount merged in by the caller from run/manifest state.
export function renderMonitorView(view, options = {}) {
  const width = Number.isInteger(options.width) && options.width > 0 ? options.width : 100;
  const color = options.color === true;
  const jobs = view.jobs ?? [];
  const counts = view.counts ?? {};
  const done = counts.complete ?? 0;
  const failed = (counts.failed ?? 0) + (counts.timeout ?? 0) + (counts.cancelled ?? 0);
  const running = counts.running ?? 0;
  const queued = counts.queued ?? 0;
  const lines = [];
  lines.push(truncate(`Run ${view.id ?? '-'} — ${view.status ?? 'unknown'}`, width));
  lines.push(truncate(
    `${running} running · ${done} done · ${failed} failed · ${queued} queued  ·  ` +
    `elapsed ${formatDuration(view.elapsedMs ?? null)}  ·  peak concurrency ${view.peakConcurrency ?? 0}`,
    width,
  ));
  const usage = formatUsage(view.usageByProvider);
  if (usage) lines.push(truncate(`usage  ${usage}`, width));
  lines.push(...renderIdleSeatEvents(view.idleSeatEvents ?? view.idleSeat ?? [], width));
  lines.push('');
  lines.push(...renderTable(jobs, width, color));
  return lines.join('\n');
}
