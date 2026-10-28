// SPDX-License-Identifier: Apache-2.0
// Command Center cockpit header: ticket headline + stage rings from ledger progress.
import { ledgerStats } from './cc-ledger-browser.js';
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

const METER_CLASSES = ['meter-opus', 'meter-skills', 'meter-engines', 'meter-taste', 'meter-broll', 'meter-web'];

const MASCOT_PIXEL_SVG = [
  '<svg class="mascot-pixel" viewBox="0 0 22 18" focusable="false" aria-label="Opus orchestrator mascot" shape-rendering="crispEdges">',
  '<rect x="6" y="0" width="10" height="2" fill="#c9784a"/>',
  '<rect x="4" y="2" width="14" height="2" fill="#c9784a"/>',
  '<rect x="3" y="4" width="3" height="2" fill="#f5e6dc"/>',
  '<rect x="16" y="4" width="3" height="2" fill="#f5e6dc"/>',
  '<rect x="5" y="4" width="12" height="4" fill="#c9784a"/>',
  '<rect x="7" y="6" width="2" height="2" fill="#1a120e"/>',
  '<rect x="13" y="6" width="2" height="2" fill="#1a120e"/>',
  '<rect x="4" y="8" width="14" height="3" fill="#c9784a"/>',
  '<rect x="2" y="9" width="2" height="4" fill="#c9784a"/>',
  '<rect x="18" y="9" width="2" height="4" fill="#c9784a"/>',
  '<rect x="6" y="11" width="3" height="2" fill="#8a5238"/>',
  '<rect x="13" y="11" width="3" height="2" fill="#8a5238"/>',
  '<rect x="5" y="13" width="12" height="2" fill="#c9784a"/>',
  '<rect x="7" y="15" width="3" height="2" fill="#8a5238"/>',
  '<rect x="12" y="15" width="3" height="2" fill="#8a5238"/>',
  '</svg>',
].join('');

/**
 * @param {ParentNode} parent
 * @param {Document} doc
 * @param {{ phone?: boolean }} [opts]
 */
export function appendMascotStage(parent, doc, opts) {
  if (!parent || !doc?.createElement) return null;
  const mascot = doc.createElement('div');
  mascot.className = 'mascot-stage';
  if (opts?.phone) mascot.classList.add('mascot-stage--phone');
  mascot.setAttribute('aria-hidden', 'true');
  const orbit = doc.createElement('div');
  orbit.className = 'mascot-orbit';
  const dot = doc.createElement('span');
  dot.className = 'mascot-orbit-dot';
  orbit.appendChild(dot);
  mascot.appendChild(orbit);
  const pixelWrap = doc.createElement('div');
  pixelWrap.innerHTML = MASCOT_PIXEL_SVG;
  const svg = pixelWrap.firstElementChild || pixelWrap.firstChild;
  if (svg) mascot.appendChild(svg);
  const shadow = doc.createElement('div');
  shadow.className = 'mascot-shadow';
  mascot.appendChild(shadow);
  parent.appendChild(mascot);
  return mascot;
}

function appendCategoryBar(parent, rings, extraClass) {
  if (!rings.length) return null;
  const bar = el('div', `category-bar ${extraClass || ''}`.trim());
  const links = el('div', 'category-links');
  links.setAttribute('aria-label', 'Stage mix');
  rings.forEach((ring, i) => {
    if (i > 0) links.appendChild(el('span', 'sep', '/'));
    links.appendChild(el('span', null, ring.label));
  });
  const meter = el('div', 'category-meter');
  meter.setAttribute('aria-hidden', 'true');
  rings.forEach((ring, i) => {
    const seg = el('span', METER_CLASSES[i % METER_CLASSES.length]);
    const w = String(Math.max(ring.total, 1));
    if (seg.style && typeof seg.style.setProperty === 'function') {
      seg.style.setProperty('--w', w);
    } else if (seg.style) {
      seg.style.flex = w;
    }
    meter.appendChild(seg);
  });
  bar.appendChild(links);
  bar.appendChild(meter);
  parent.appendChild(bar);
  return bar;
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

  const ringRows = stageRingProgress(ledger);

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

  appendCategoryBar(hero, ringRows, 'category-bar--hero-mobile');

  host.appendChild(nav);
  host.appendChild(hero);

  const scanLive = el('div', 'scan-live scan-live--header');
  scanLive.setAttribute('aria-label', 'Live ticket progress');
  scanLive.appendChild(el('span', 'scan-live-label', 'Live scan'));
  const scanCount = el('span', 'scan-live-count');
  const doneNum = el('span', 'num');
  doneNum.title = 'source field: ledger.tickets done';
  doneNum.textContent = String(done);
  scanCount.appendChild(doneNum);
  scanCount.appendChild(el('span', 'scan-of', 'of'));
  const totalNum = el('span', 'num');
  totalNum.title = 'source field: ledger.tickets live total';
  totalNum.textContent = String(total);
  scanCount.appendChild(totalNum);
  scanLive.appendChild(scanCount);
  host.appendChild(scanLive);

  appendCategoryBar(host, ringRows, 'category-bar--header');

  const rings = el('div', 'cockpit-stage-rings');
  rings.setAttribute('aria-label', 'Stage progress');
  for (const ring of ringRows) {
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
