// SPDX-License-Identifier: Apache-2.0
// Command Center cockpit title block: project name, ticket counts and the stage strip from ledger progress.
import { ledgerStats } from './cc-ledger-browser.js';
import { cockpitOrchestratorFromSessions } from './cockpit-orchestrator.js';
import { STAGE_COLOURS } from './cockpit-lists.js';

/** Artifact title sizes: the project name is 54px on desktop and 34px at 900px and below; the page wrap is 1320px. */
export const COCKPIT_TITLE_PX = { desktop: 54, phone: 34 };
export const COCKPIT_SHELL_MAX_PX = 1320;
export const COCKPIT_HEADLINE_ROOT_PX = 16;

const HIDDEN_STATUSES = ['cancelled', 'proposed'];
const STAGE_DONE_COLOUR = '#4d7cff';
const STAGE_EMPTY_COLOUR = '#1c2233';

/** Parse clamp(min, preferred, max) and resolve pixel font-size at a viewport width. */
export function resolveClampPx(clampCss, viewportPx, rootPx = COCKPIT_HEADLINE_ROOT_PX) {
  const m = String(clampCss).match(/clamp\(\s*([^,]+)\s*,\s*([^,]+)\s*,\s*([^)]+)\s*\)/i);
  if (!m) throw new Error('expected clamp() CSS');
  const toPx = (token) => {
    const t = token.trim();
    if (t.endsWith('rem')) return parseFloat(t) * rootPx;
    if (t.endsWith('px')) return parseFloat(t);
    if (t.endsWith('vw')) return (parseFloat(t) / 100) * viewportPx;
    if (t.endsWith('vh')) return (parseFloat(t) / 100) * (typeof window !== 'undefined' && window.innerHeight ? window.innerHeight : 800);
    return parseFloat(t);
  };
  const minPx = toPx(m[1]);
  const midPx = toPx(m[2]);
  const maxPx = toPx(m[3]);
  return Math.max(minPx, Math.min(midPx, maxPx));
}

/** Heavy-sans glyphs: conservative width for one-line fit checks. */
export function estimateHeadlineWidthPx(text, fontSizePx) {
  const avg = fontSizePx * 0.52;
  return String(text).length * avg;
}

/** "437 TICKETS · 39% DONE · 259 LEFT" from the live ticket total and the done count. */
export function cockpitSubline(done, total) {
  if (!(total > 0)) return 'NO TICKETS IN THE LEDGER';
  const pct = Math.round((100 * done) / total);
  return `${total} TICKETS · ${pct}% DONE · ${Math.max(0, total - done)} LEFT`;
}

/** Orchestrator label to robot-head state: working, thinking, sleeping (all done, no session) or idle. */
export function orchestratorHeadState(label, allDone) {
  const l = String(label || '').toLowerCase();
  if (l.includes('think')) return 'thinking';
  if (l.includes('dispatch') || l.includes('review') || l.includes('work')) return 'working';
  if (l.includes('wait')) return 'idle';
  return allDone ? 'sleeping' : 'idle';
}

/** The small caption under ORCHESTRATOR. */
export function orchestratorCaption(label, allDone) {
  const l = String(label || '').toLowerCase();
  if (l.includes('think')) return 'THINKING';
  if (l.includes('dispatch')) return 'DISPATCHING WORKERS';
  if (l.includes('review')) return 'REVIEWING WORK';
  if (l.includes('wait')) return 'WAITING ON YOU';
  if (allDone) return 'FINISHED · RESTING';
  return l ? `${l.toUpperCase()} · NO SESSION ACTIVE` : 'NO SESSION ACTIVE';
}

export function stageRingProgress(ledger) {
  const tickets = (ledger?.tickets ?? []).filter(t => !HIDDEN_STATUSES.includes(t.status));
  const byStage = {};
  for (const t of tickets) {
    const key = t.stage ?? 'none';
    byStage[key] ??= { total: 0, done: 0 };
    byStage[key].total++;
    if (t.status === 'done') byStage[key].done++;
  }
  const stages = Array.isArray(ledger?.scope?.stages)
    ? ledger.scope.stages
    : Array.isArray(ledger?.stages)
      ? ledger.stages
      : [];
  const ids = stages.length ? stages.map(s => (typeof s === 'string' ? s : s.id)).filter(Boolean) : Object.keys(byStage).filter(k => k !== 'none').sort();
  return ids.map(id => {
    const row = byStage[id] ?? { total: 0, done: 0 };
    const total = row.total || 0;
    const done = row.done || 0;
    const pct = total ? Math.round((100 * done) / total) : 0;
    const title = stages.find(s => (typeof s === 'object' ? s.id : s) === id);
    const label = typeof title === 'object' && title?.name ? title.name : id;
    return { id, label, done, total, pct };
  });
}

function clearHost(host) {
  if (typeof host.replaceChildren === 'function') {
    host.replaceChildren();
    return;
  }
  while (host.firstChild) host.removeChild(host.firstChild);
}

function utcClock(ms) {
  return `${new Date(ms).toISOString().slice(11, 16)} UTC`;
}

/**
 * Renders the title block (project name, counts line, stage line, stage strip) into `host`.
 * @param {HTMLElement} host
 * @param {{ ledger: object, sessions?: object[], meta?: { owner?: string, lane?: string, project?: string }, name?: string|null, id?: string, done?: number, total?: number }} data
 * @param {{ now?: number }} [opts]
 */
export function renderCockpit(host, data, opts) {
  const now = (opts && opts.now) || Date.now();
  const doc = host.ownerDocument || globalThis.document;
  const mk = (tag, cls, text) => {
    const n = doc.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = text;
    return n;
  };
  const ledger = data?.ledger ?? { tickets: [] };
  const stats = ledgerStats(ledger);
  const live = (ledger.tickets ?? []).filter(t => !HIDDEN_STATUSES.includes(t.status));
  const done = data?.done ?? live.filter(t => t.status === 'done').length;
  const total = data?.total ?? live.length;
  const orch = cockpitOrchestratorFromSessions(data?.sessions, now);
  const name = String(data?.name ?? data?.meta?.project ?? data?.id ?? '').trim() || 'unnamed project';
  const rings = stageRingProgress(ledger);
  const stagesDone = rings.filter(r => r.total > 0 && r.done >= r.total).length;

  clearHost(host);

  const h1 = mk('h1', null, name.toUpperCase());
  h1.setAttribute('title', name);
  host.appendChild(h1);
  host.appendChild(mk('div', 'sub2', cockpitSubline(done, total)));

  const stripl = mk('div', 'stripl');
  const stl = mk('span', null, rings.map(r => `${r.id} ${r.done}/${r.total}`).join('  ·  ') || 'no stage ledger for this project');
  const str = mk('span', null, `${rings.length ? `${stagesDone} OF ${rings.length} STAGES DONE · ` : ''}LIVE LEDGER · ${utcClock(now)}`);
  stripl.appendChild(stl);
  stripl.appendChild(str);
  host.appendChild(stripl);

  const strip = mk('div', 'strip');
  strip.setAttribute('aria-hidden', 'true');
  const segs = rings.length ? rings : [null];
  segs.forEach((r, i) => {
    const seg = mk('i');
    if (!r) seg.style.background = STAGE_EMPTY_COLOUR;
    else seg.style.background = r.total > 0 && r.done >= r.total ? STAGE_DONE_COLOUR : STAGE_COLOURS[i % STAGE_COLOURS.length];
    strip.appendChild(seg);
  });
  host.appendChild(strip);

  return {
    name,
    done,
    total,
    subline: cockpitSubline(done, total),
    orchestrator: orch,
    rings,
    stagesDone,
    stats,
  };
}
