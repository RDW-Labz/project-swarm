// SPDX-License-Identifier: Apache-2.0
import { sanitizeWorkerText } from './worker-text.mjs';

const ESC = String.fromCharCode(27);
const RESET = ESC + '[0m';
const HUES = [39, 70, 136, 166, 98, 44];

function clean(value) {
  return sanitizeWorkerText(value == null ? '' : value, 200);
}

function cut(text, width) {
  const s = String(text);
  if (s.length <= width) return s;
  if (width <= 3) return s.slice(0, width);
  return s.slice(0, width - 3) + '...';
}

function pad(text, width) {
  const s = String(text);
  return s.length >= width ? s.slice(0, width) : s + ' '.repeat(width - s.length);
}

function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, n));
}

function money(n) {
  return '$' + (Number(n) || 0).toFixed(2);
}

function pad2(n) {
  return n < 10 ? '0' + n : String(n);
}

function formatDuration(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return '0s';
  const s = Math.floor(n / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return h + 'h' + pad2(m) + 'm';
  if (m > 0) return m + 'm' + pad2(sec) + 's';
  return sec + 's';
}

function hue(name) {
  let sum = 0;
  for (const ch of String(name)) sum += ch.charCodeAt(0);
  return HUES[sum % HUES.length];
}

function colorPrefix(text, name) {
  return ESC + '[38;5;' + hue(name) + 'm' + text + RESET;
}

export function formatBar(done, total, width) {
  const w = Math.max(0, Math.floor(Number(width) || 0));
  if (w === 0) return '';
  const t = Number(total) || 0;
  if (t <= 0) return '.'.repeat(w);
  let filled = Math.round(((Number(done) || 0) / t) * w);
  filled = Math.min(w, Math.max(0, filled));
  return '#'.repeat(filled) + '.'.repeat(w - filled);
}

export function renderTui(snapshot, opts = {}) {
  if (!snapshot) return 'no run found';
  const W = clamp(Math.floor(Number(opts.width) || 100), 40, 100000);
  const color = Boolean(opts.color);
  const plan = opts.plan || null;
  const k = snapshot.kpi || {};
  const out = [];

  out.push(cut('SWARM WATCH  ' + clean(snapshot.runId || '?') + '  [' + clean(snapshot.status || '?') + ']  ' + formatDuration(snapshot.elapsedMs), W));
  if (snapshot.goal) out.push(cut('goal: ' + clean(snapshot.goal), W));
  if (snapshot.branch) out.push(cut('branch: ' + clean(snapshot.branch), W));
  if (plan && plan.present && plan.header) {
    out.push(cut('plan: ' + clean(plan.header.scopeName || 'scope') + ' ' + clean(plan.header.scopeVersion || '') + '  ' + (plan.header.percentDone || 0) + '% done', W));
  }

  const total = k.total || 0;
  const done = k.done || 0;
  const barW = clamp(W - 24, 10, 120);
  out.push(cut('progress [' + formatBar(done, total, barW) + '] ' + done + '/' + total, W));
  const eta = k.etaMs == null ? '-' : formatDuration(k.etaMs);
  out.push(cut('running ' + (k.running || 0) + '  queued ' + (k.queued || 0) + '  failed ' + (k.failed || 0) + '  retries ' + (k.retries || 0) + '  spend ' + money(k.spendUsd) + '  eta ' + eta + '  peak ' + (k.peakInFlight || 0), W));

  if (snapshot.project) {
    const pr = snapshot.project;
    out.push(cut('project total ' + money(pr.spendUsd) + ' over ' + (pr.runs || 0) + ' runs' + (pr.capUsd ? '  cap ' + money(pr.capUsd) + (pr.reached ? '  CAP REACHED: no new runs' : '') : (pr.capError ? '  CAP INVALID' : pr.noCap ? '  NO CAP' : '  cap unknown')), W));
  }

  out.push('');
  out.push('LANES');
  const lanes = Array.isArray(snapshot.lanes) ? snapshot.lanes : [];
  if (lanes.length === 0) out.push('  (no lanes)');
  const laneBarW = clamp(W - 62, 6, 30);
  for (const lane of lanes) {
    const name = clean(lane.name);
    const limit = lane.limit || 0;
    const inFlight = lane.inFlight || 0;
    const stateText = lane.offline ? 'offline' : clean(lane.state || 'ok');
    const rate = lane.passRate == null ? '-' : Math.round(lane.passRate * 100) + '%';
    const avg = lane.avgMs == null ? '-' : formatDuration(lane.avgMs);
    const plain = cut(
      pad(name, 12) + ' ' + formatBar(inFlight, limit, laneBarW) + ' ' + pad(inFlight + '/' + limit, 7) + ' ' + pad(stateText, 8) + ' d' + (lane.done || 0) + ' f' + (lane.failed || 0) + ' pass ' + rate + ' avg ' + avg,
      W
    );
    const head = plain.slice(0, 12);
    out.push(color ? colorPrefix(head, name) + plain.slice(12) : plain);
  }

  out.push('');
  out.push('WAVES');
  const waves = Array.isArray(snapshot.waves) ? snapshot.waves : [];
  const waveBarW = clamp(W - 34, 8, 60);
  for (const w of waves) {
    const line = pad(clean(w.name), 9) + ' ' + formatBar(w.done, w.total, waveBarW) + ' ' + pad(w.done + '/' + w.total, 9) + (w.running ? ' run ' + w.running : '');
    out.push(cut(line, W));
  }

  out.push('');
  out.push('ATTENTION');
  const att = Array.isArray(snapshot.attention) ? snapshot.attention : [];
  if (att.length === 0) out.push('  no attention items');
  for (const a of att.slice(0, 6)) {
    out.push(cut('  ' + pad(clean(a.severity || 'info'), 5) + ' ' + pad(clean(a.kind || ''), 12) + ' ' + pad(clean(a.jobId || '-'), 12) + ' ' + clean(a.text || ''), W));
  }
  if (att.length > 6) out.push('  +' + (att.length - 6) + ' more');

  out.push('');
  out.push('MERGE');
  const mq = snapshot.mergeQueue;
  if (!mq) {
    out.push('  no merge queue');
  } else {
    out.push(cut('  ' + clean(mq.state || '-') + '  batches ' + (mq.batches || 0) + '  integrated ' + (mq.integrated || 0) + '  conflicts ' + (mq.conflicts || 0) + '  bisects ' + (mq.bisects || 0), W));
  }

  return out.join('\n');
}
