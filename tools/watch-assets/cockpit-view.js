// SPDX-License-Identifier: Apache-2.0
// Command Center cockpit title block: project name, ticket counts and the stage strip from ledger progress.
import { ledgerStats } from './cc-ledger-browser.js';
import { cockpitOrchestratorFromSessions } from './cockpit-orchestrator.js';
import { STAGE_COLOURS, cockpitCategories, setCssVar } from './cockpit-lists.js';

/** Artifact title sizes: the project name is 54px on desktop and 34px at 900px and below; the page wrap is 1320px. */
export const COCKPIT_TITLE_PX = { desktop: 54, phone: 34 };
export const COCKPIT_SHELL_MAX_PX = 1320;
export const COCKPIT_HEADLINE_ROOT_PX = 16;

const HIDDEN_STATUSES = ['cancelled', 'proposed'];
const STAGE_DONE_COLOUR = '#4d7cff';
const STAGE_EMPTY_COLOUR = '#1c2233';
/** Up to this many live tickets the rule under the headline draws one segment per ticket. */
const STRIP_TICKET_MAX = 48;

/**
 * The orchestrator creature: 12 x 8 flat pixels in one warm colour (arms on rows 2-3, four legs on rows 6-7),
 * two square eyes on row 1 and a flat shadow ellipse. `#` body, `.` empty.
 */
export const CREATURE_ROWS = [
  '..########..',
  '..########..',
  '############',
  '############',
  '..########..',
  '..########..',
  '..#.#..#.#..',
  '..#.#..#.#..',
];
export const CREATURE_EYES = [[1, 3], [1, 8]];
export const CREATURE_COLOUR = '#e8795a';
const CREATURE_STATES = ['idle', 'thinking', 'working', 'sleeping'];

/**
 * Mount the flat pixel creature into `host`. Same handle shape as mountRobotHead: { setState, destroy }.
 * Cell size comes from CSS (--cell); `size` is the intended width in px and is kept as a data attribute.
 * @param {HTMLElement} host
 * @param {{ state?: string, size?: number, color?: string, label?: string }} [opts]
 */
export function mountPixelCreature(host, opts = {}) {
  const doc = host.ownerDocument || globalThis.document;
  const mkc = (tag, cls) => {
    const n = doc.createElement(tag);
    if (cls) n.className = cls;
    return n;
  };
  const root = mkc('div', 'pxc');
  root.setAttribute('role', 'img');
  root.setAttribute('aria-label', opts.label || 'orchestrator');
  if (opts.size) root.setAttribute('data-size', String(opts.size));
  setCssVar(root, '--px-color', opts.color || CREATURE_COLOUR);
  const body = mkc('div', 'px-body');
  CREATURE_ROWS.forEach((row) => {
    for (const ch of row) body.appendChild(mkc('i', ch === '#' ? 'on' : null));
  });
  CREATURE_EYES.forEach(([r, c], k) => {
    const eye = mkc('b', `px-eye px-eye-${k}`);
    setCssVar(eye, '--r', String(r));
    setCssVar(eye, '--col', String(c));
    body.appendChild(eye);
  });
  root.appendChild(body);
  root.appendChild(mkc('div', 'px-shadow'));
  const setState = (s) => {
    root.setAttribute('data-state', CREATURE_STATES.includes(s) ? s : 'idle');
  };
  setState(opts.state);
  host.appendChild(root);
  return {
    setState,
    destroy() {
      if (root.parentNode) root.parentNode.removeChild(root);
    },
  };
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

  const cats = cockpitCategories(ledger);

  // children[0] stage counts, children[1] live ledger clock, children[2] category legend (shown between them)
  const stripl = mk('div', 'stripl');
  const stl = mk('span', 'st', rings.map(r => `${r.id} ${r.done}/${r.total}`).join('  ·  ') || 'no stage ledger for this project');
  const str = mk('span', 'lv', `${rings.length ? `${stagesDone} OF ${rings.length} STAGES DONE · ` : ''}LIVE LEDGER · ${utcClock(now)}`);
  stripl.appendChild(stl);
  stripl.appendChild(str);
  const legend = mk('span', 'lg');
  if (cats.field && cats.names.length) {
    cats.names.slice(0, 8).forEach((n) => {
      legend.appendChild(mk('i', null, '/'));
      const c = mk('b', null, n === 'other' ? 'OTHER' : n.toUpperCase());
      setCssVar(c, '--cat-color', cats.colour(n));
      legend.appendChild(c);
    });
  }
  stripl.appendChild(legend);
  host.appendChild(stripl);

  // segmented rule: one group per stage, one segment per ticket (or per category share on big ledgers)
  const strip = mk('div', 'strip');
  strip.setAttribute('aria-hidden', 'true');
  const segs = rings.length ? rings : [null];
  const perTicket = live.length <= STRIP_TICKET_MAX;
  segs.forEach((r, i) => {
    const seg = mk('i');
    if (!r) seg.style.background = STAGE_EMPTY_COLOUR;
    else seg.style.background = r.total > 0 && r.done >= r.total ? STAGE_DONE_COLOUR : STAGE_COLOURS[i % STAGE_COLOURS.length];
    const own = live
      .filter(t => (r ? t.stage === r.id : true))
      .sort((a, b) => cats.names.indexOf(cats.of(a)) - cats.names.indexOf(cats.of(b)) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    seg.style.flexGrow = String(Math.max(1, own.length));
    const piece = (cat, done, grow) => {
      const b = mk('b', done ? 'done' : null);
      setCssVar(b, '--cat-color', cats.colour(cat));
      if (grow) b.style.flexGrow = String(grow);
      seg.appendChild(b);
    };
    if (perTicket) {
      own.forEach(t => piece(cats.of(t), t.status === 'done', 0));
    } else {
      cats.names.forEach((n) => {
        const mine = own.filter(t => cats.of(t) === n);
        const d = mine.filter(t => t.status === 'done').length;
        if (d) piece(n, true, d);
        if (mine.length - d) piece(n, false, mine.length - d);
      });
    }
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
