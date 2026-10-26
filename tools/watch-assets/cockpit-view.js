// SPDX-License-Identifier: Apache-2.0
// Command Center cockpit header: ticket headline + stage rings from ledger progress.
import { ledgerStats } from '../tickets.mjs';
import { cockpitOrchestratorFromSessions } from './cockpit-orchestrator.js';

/** Desktop shell headline — matches docs/design/command-center-mockup/cockpit.html @media (min-width: 721px) */
export const COCKPIT_HEADLINE_CLAMP = 'clamp(3.5rem, 4.8vw, 4.25rem)';
export const COCKPIT_SHELL_MAX_PX = 1440;
export const COCKPIT_HEADLINE_ROOT_PX = 16;

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined && text !== null) n.textContent = text;
  return n;
}

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

/** Condensed headline glyphs — conservative width for one-line fit checks at 1440px. */
export function estimateHeadlineWidthPx(text, fontSizePx) {
  const avg = fontSizePx * 0.52;
  return String(text).length * avg;
}

export function headlineTicketText(done, total) {
  return `${done} of ${total}`;
}

export function stageRingProgress(ledger) {
  const tickets = (ledger?.tickets ?? []).filter(t => !['cancelled', 'proposed'].includes(t.status));
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
  const ids = stages.length ? stages.map(s => (typeof s === 'string' ? s : s.id)).filter(Boolean) : Object.keys(byStage).filter(k => k !== 'none');
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

/**
 * @param {HTMLElement} host
 * @param {{ ledger: object, sessions?: object[], meta?: { owner?: string, lane?: string, project?: string }, done?: number, total?: number }} data
 * @param {{ now?: number }} [opts]
 */
export function renderCockpit(host, data, opts) {
  const now = (opts && opts.now) || Date.now();
  const ledger = data?.ledger ?? { tickets: [] };
  const stats = ledgerStats(ledger);
  const live = (ledger.tickets ?? []).filter(t => !['cancelled', 'proposed'].includes(t.status));
  const done = data?.done ?? live.filter(t => t.status === 'done').length;
  const total = data?.total ?? live.length;
  const orch = cockpitOrchestratorFromSessions(data?.sessions, now);
  const meta = data?.meta ?? {};

  host.replaceChildren();

  const nav = el('nav', 'cockpit-nav');
  nav.setAttribute('aria-label', 'Cockpit breadcrumb');
  const block = el('span', 'nav-block');
  if (meta.owner) block.appendChild(el('span', 'num-label', 'owner'));
  if (meta.owner) block.appendChild(document.createTextNode(' ' + meta.owner));
  if (meta.lane) {
    block.appendChild(el('span', 'sep', '/'));
    block.appendChild(el('span', 'num-label', 'lane'));
    block.appendChild(document.createTextNode(' ' + meta.lane));
  }
  if (meta.project) {
    block.appendChild(el('span', 'sep', '/'));
    block.appendChild(el('span', 'num-label', 'project'));
    block.appendChild(document.createTextNode(' ' + meta.project));
  }
  nav.appendChild(block);

  const orchBlock = el('span', 'nav-block');
  orchBlock.appendChild(el('span', 'num-label', 'orchestrator'));
  orchBlock.appendChild(document.createTextNode(' ' + orch.label));
  nav.appendChild(orchBlock);

  const hero = el('header', 'cockpit-hero');
  const h1 = el('h1');
  const line = el('span', 'headline-line');
  const nums = el('span', 'headline-num num');
  nums.title = 'source field: ledger.tickets done / live total';
  nums.textContent = headlineTicketText(done, total);
  line.appendChild(nums);
  line.appendChild(document.createTextNode(' tickets done'));
  h1.appendChild(line);
  h1.style.fontSize = COCKPIT_HEADLINE_CLAMP;
  h1.dataset.headlineClamp = COCKPIT_HEADLINE_CLAMP;
  hero.appendChild(h1);

  const tag = el('p', 'tagline');
  tag.textContent = orch.detail;
  hero.appendChild(tag);

  const rings = el('div', 'cockpit-stage-rings');
  rings.setAttribute('aria-label', 'Stage progress');
  for (const ring of stageRingProgress(ledger)) {
    const item = el('div', 'cockpit-stage-ring');
    item.dataset.stage = ring.id;
    const label = el('span', 'cockpit-stage-label', ring.label);
    const count = el('span', 'cockpit-stage-count num');
    count.title = `source field: ledgerStats.byStage.${ring.id}`;
    count.textContent = `${ring.done}/${ring.total}`;
    const track = el('div', 'cockpit-stage-track');
    const fill = el('span', 'cockpit-stage-fill');
    fill.style.width = `${ring.pct}%`;
    fill.dataset.pct = String(ring.pct);
    track.appendChild(fill);
    item.appendChild(label);
    item.appendChild(count);
    item.appendChild(track);
    rings.appendChild(item);
  }

  host.appendChild(nav);
  host.appendChild(hero);
  host.appendChild(rings);

  return {
    done,
    total,
    orchestrator: orch,
    rings: stageRingProgress(ledger),
    headlineFontPxAt1440: resolveClampPx(COCKPIT_HEADLINE_CLAMP, COCKPIT_SHELL_MAX_PX),
    stats,
  };
}
