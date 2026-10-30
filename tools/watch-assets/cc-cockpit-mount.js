// SPDX-License-Identifier: Apache-2.0
/**
 * Mount Command Center project Cockpit from buildProjectCockpit snapshot data.
 * Layout, drawing and motion follow the owner's target (docs/design/reference/cockpit-target.png);
 * every number and name is read from the live project payload.
 */

import { readyTickets } from './cc-ledger-browser.js';
import { renderCockpit, orchestratorHeadState, orchestratorCaption, mountPixelCreature } from './cockpit-view.js';
import {
  cockpitLedgerRows,
  cockpitCategories,
  renderTicketColumn,
  renderReadyEmptyState,
  renderStackSummaryTiles,
  renderWorkerCards,
  renderRunLine,
  workerCards,
  shortTitle,
} from './cockpit-lists.js';
import { glitch as defaultGlitch } from './cc-glitch.js';
import { completionKey } from './cc-tour.js';

const TOUR_USER = 'anonymous';
const SVG_NS = 'http://www.w3.org/2000/svg';
const HIDDEN_STATUSES = ['cancelled', 'proposed'];
const TILE_COLOURS = { ready: '#2fe0a0', running: '#2fe0a0', review: '#ff4d7e', blocked: '#ffb62e', todo: '#a98bff', done: '#4d7cff' };
const LOOP_STEPS = ['you approve the scope', 'the split makes tickets', 'workers build in waves', 'checks gate every merge', 'the PR merges'];
const SOURCES_NOTE = 'Read from this project\'s ledger (tickets, stages and their lane or type), its orchestrator sessions and its run stream, as served by the Command Center. The pixel orchestrator, its orbit and the path to the running ticket are drawn here. One glitch in the app, on the SWARM wordmark: under 400 ms, off with reduced motion.';
/** Orbit ellipse relative to the creature box (fractions of its width / height). */
const ORBIT = { cy: 0.56, rx: 0.82, ry: 0.19 };
/** Small dots along the path to the active row; the two ends get brighter nodes. */
const NODE_TS = [0.3, 0.55, 0.78];
/** Where the path leaves the orbit: this angle (radians) above or below the ellipse's outer point. */
const WIRE_LEAVE = 0.62;
const ROWS_PER_COLUMN = 10;
/** Columns with at least this many rows spread down to the bottom of the middle column. */
const SPREAD_MIN_ROWS = 4;
const SPARK_MS = 2200;
const ORBIT_MS = 7000;
const TAU = Math.PI * 2;

function el(doc, tag, cls, text) {
  const n = doc.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

function svg(doc, tag, cls) {
  const n = doc.createElementNS(SVG_NS, tag);
  if (cls) n.setAttribute('class', cls);
  return n;
}

function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

function nowMs(deps) {
  const n = deps?.now;
  return typeof n === 'function' ? n() : (typeof n === 'number' ? n : Date.now());
}

function suppressCockpitAutoTour() {
  try {
    globalThis.localStorage?.setItem(completionKey(TOUR_USER), '1');
  } catch {
    // ignore storage failures (tests, private mode)
  }
}

function liveTickets(ledger) {
  return (ledger?.tickets ?? []).filter(t => t && !HIDDEN_STATUSES.includes(t.status));
}

/** Header counters, each with the ledger field it is read from. */
function headerCounters(project, counts) {
  const live = liveTickets(project?.ledger);
  const total = project?.total ?? live.length;
  const done = project?.done ?? counts.done;
  const needsYou = live.filter(t => t.status === 'review' || (t.type === 'human' && t.status !== 'done')).length;
  return [
    { label: 'tickets', value: total, tip: 'Tickets that still count in this project ledger (cancelled and proposed left out).' },
    { label: 'agents', value: counts.running, color: counts.running ? 'var(--green)' : '', tip: 'Tickets with status running in the ledger right now.' },
    { label: 'done', value: done, color: 'var(--blue)', tip: 'Tickets marked done in this project ledger.' },
    { label: 'need you', value: needsYou, color: needsYou ? 'var(--red)' : '', tip: 'Human tickets still open plus tickets waiting in review.' },
  ];
}

function utcClock(ms) {
  return `${new Date(ms).toISOString().slice(11, 16)} UTC`;
}

function utcDate(ms) {
  return new Date(ms).toISOString().slice(0, 10).replace(/-/g, '.');
}

function runStreamItems(project, orch) {
  const ended = orch && (orch.label === 'waiting on you');
  const raw = Array.isArray(project?.runStream) ? project.runStream : [];
  return raw.map(item => {
    const status = ended ? 'ended' : (item.status || item.title || 'running');
    const fullId = item.id ? String(item.id) : '';
    // "2/6 jobs" -> "jobs 2/6"
    const body = typeof item.body === 'string'
      ? item.body.replace(/^\s*(\d+\s*\/\s*\d+)\s+jobs?\s*$/i, 'jobs $1')
      : item.body;
    return { ...item, id: fullId.slice(0, 8), fullId, title: status, status, body };
  });
}

/** Point at t on a cubic Bezier. */
function cubicAt(p, t) {
  const u = 1 - t;
  const a = u * u * u;
  const b = 3 * u * u * t;
  const c = 3 * u * t * t;
  const d = t * t * t;
  return {
    x: a * p[0].x + b * p[1].x + c * p[2].x + d * p[3].x,
    y: a * p[0].y + b * p[1].y + c * p[2].y + d * p[3].y,
  };
}

/** Length of a cubic Bezier, by sampling (close enough for a dash pattern). */
function cubicLength(p, steps = 48) {
  let len = 0;
  let prev = p[0];
  for (let i = 1; i <= steps; i += 1) {
    const q = cubicAt(p, i / steps);
    len += Math.hypot(q.x - prev.x, q.y - prev.y);
    prev = q;
  }
  return len;
}

/**
 * @param {HTMLElement} host
 * @param {object} project buildProjectCockpit shape
 * @param {{
 *   document: Document, now?: number|(() => number), onBack?: () => void, window?: Window,
 *   glitch?: (el: Element) => unknown, mountRobotHead?: Function,
 *   requestAnimationFrame?: Function, cancelAnimationFrame?: Function, matchMedia?: typeof matchMedia,
 *   setTimeout?: typeof setTimeout, clearTimeout?: typeof clearTimeout,
 * }} deps
 */
export function renderProjectCockpit(host, project, deps) {
  suppressCockpitAutoTour();
  const doc = deps.document;
  const win = deps.window || globalThis;
  const glitchImpl = typeof deps.glitch === 'function' ? deps.glitch : defaultGlitch;
  const glitch = (node) => {
    try {
      return glitchImpl(node);
    } catch {
      return false; // decoration only
    }
  };
  const setTimer = deps.setTimeout || globalThis.setTimeout.bind(globalThis);
  const clearTimer = deps.clearTimeout || globalThis.clearTimeout.bind(globalThis);
  const timers = new Set();
  const later = (fn, ms) => {
    const id = setTimer(() => { timers.delete(id); fn(); }, ms);
    timers.add(id);
  };
  const raf = deps.requestAnimationFrame || (typeof win.requestAnimationFrame === 'function' ? win.requestAnimationFrame.bind(win) : null);
  const caf = deps.cancelAnimationFrame || (typeof win.cancelAnimationFrame === 'function' ? win.cancelAnimationFrame.bind(win) : null);
  let reducedMotion = false;
  try {
    const mm = typeof deps.matchMedia === 'function' ? deps.matchMedia : (typeof win.matchMedia === 'function' ? win.matchMedia.bind(win) : null);
    reducedMotion = Boolean(mm && mm('(prefers-reduced-motion: reduce)').matches);
  } catch {
    reducedMotion = false;
  }

  while (host.firstChild) host.removeChild(host.firstChild);

  // .ck-intro lets the stream bars grow from zero once, on arrival only (not on every poll)
  const shell = el(doc, 'div', 'cc-cockpit-shell ck-intro');
  if (project?.id != null) shell.setAttribute('data-project-id', String(project.id));
  const wrap = el(doc, 'div', 'ck-wrap');

  // Top line: plain mono breadcrumb on the left (SWARM / THE HIVE / PROJECT), meta line on the right ending in the view switch.
  const gbar = el(doc, 'div', 'gbar');
  const crumbs = el(doc, 'nav', 'crumbs cockpit-nav');
  crumbs.setAttribute('aria-label', 'Breadcrumb');
  const logo = el(doc, 'span', 'ck-brand', 'SWARM');
  logo.setAttribute('title', 'Swarm Watch');
  const backBtn = el(doc, 'button', 'cc-cockpit-back-btn nav-block', 'The Hive');
  backBtn.type = 'button';
  const crumbProject = el(doc, 'span', 'cur');
  crumbProject.setAttribute('aria-current', 'page');
  crumbs.appendChild(logo);
  crumbs.appendChild(el(doc, 'span', 'sep', '/'));
  crumbs.appendChild(backBtn);
  crumbs.appendChild(el(doc, 'span', 'sep', '/'));
  crumbs.appendChild(crumbProject);
  const meta = el(doc, 'div', 'ck-meta');
  const cnt = el(doc, 'div', 'cnt');
  const metaDate = el(doc, 'span', 'dt');
  const live = el(doc, 'span', 'ck-live');
  live.appendChild(el(doc, 'i'));
  live.appendChild(doc.createTextNode('LIVE'));
  meta.appendChild(cnt);
  meta.appendChild(el(doc, 'span', 'sep', '/'));
  meta.appendChild(metaDate);
  meta.appendChild(live);
  const more = el(doc, 'details', 'ck-more');
  const moreSum = el(doc, 'summary', null, '···');
  moreSum.setAttribute('aria-label', 'Switch view');
  moreSum.setAttribute('title', 'Switch view');
  const tabs = el(doc, 'div', 'tabs');
  const ccTab = el(doc, 'a', null, 'Command Center');
  ccTab.href = '/command-center';
  ccTab.setAttribute('aria-current', 'page');
  const classicTab = el(doc, 'a', null, 'Classic');
  classicTab.href = '/';
  tabs.appendChild(ccTab);
  tabs.appendChild(classicTab);
  more.appendChild(moreSum);
  more.appendChild(tabs);
  meta.appendChild(el(doc, 'span', 'sep', '/'));
  meta.appendChild(more);
  gbar.appendChild(crumbs);
  gbar.appendChild(meta);

  const panel = el(doc, 'main', 'panel-cockpit');
  panel.id = 'cc-cockpit-main';

  const titleHost = el(doc, 'div', 'ct');
  const cols = el(doc, 'div', 'cols');
  const colL = el(doc, 'div', 'col l');
  colL.id = 'tickets-left';
  colL.setAttribute('aria-label', 'Tickets, first half: running and ready first');
  const colR = el(doc, 'div', 'col r');
  colR.id = 'tickets-right';
  colR.setAttribute('aria-label', 'Tickets, second half: finished last');
  const mid = el(doc, 'div', 'mid');
  const orbwrap = el(doc, 'div', 'orbwrap');
  const lab = el(doc, 'div', 'lab');
  const labTitle = el(doc, 'span', null, 'ORCHESTRATOR');
  const labSub = el(doc, 'small');
  lab.appendChild(labTitle);
  lab.appendChild(labSub);
  const hd2 = el(doc, 'div', 'hd2');
  orbwrap.appendChild(lab);
  orbwrap.appendChild(hd2);
  const nowHost = el(doc, 'div', 'now');
  nowHost.setAttribute('aria-label', 'Now panel');
  mid.appendChild(orbwrap);
  mid.appendChild(nowHost);
  cols.appendChild(colL);
  cols.appendChild(mid);
  cols.appendChild(colR);

  // Orbit ellipse, orbit dots and the dotted path to the active row: one SVG under the columns.
  let wire = null;
  if (typeof doc.createElementNS === 'function') {
    try {
      const root = svg(doc, 'svg', 'ck-wire');
      root.setAttribute('aria-hidden', 'true');
      const ring = svg(doc, 'ellipse', 'ring');
      const ring2 = svg(doc, 'ellipse', 'ring2');
      const odot = svg(doc, 'circle', 'odot');
      odot.setAttribute('r', '3.5');
      const odot2 = svg(doc, 'circle', 'odot2');
      odot2.setAttribute('r', '2.5');
      const path = svg(doc, 'path', 'wire');
      const pulse = svg(doc, 'path', 'pulse');
      const nodes = NODE_TS.map(() => {
        const c = svg(doc, 'circle', 'node');
        c.setAttribute('r', '1.6');
        return c;
      });
      const start = svg(doc, 'circle', 'node end');
      start.setAttribute('r', '2.6');
      const end = svg(doc, 'circle', 'node end');
      end.setAttribute('r', '2.6');
      const wireG = svg(doc, 'g', 'wire-g');
      wireG.appendChild(path);
      nodes.forEach(n => wireG.appendChild(n));
      wireG.appendChild(pulse);
      wireG.appendChild(start);
      wireG.appendChild(end);
      root.appendChild(ring2);
      root.appendChild(ring);
      root.appendChild(odot2);
      root.appendChild(odot);
      root.appendChild(wireG);
      cols.appendChild(root);
      wire = { root, ring, ring2, odot, odot2, path, pulse, nodes, start, end, wireG, geo: null, curve: null, len: 0 };
    } catch {
      wire = null;
    }
  }

  const loopbar = el(doc, 'div', 'loopbar');
  const loopK = el(doc, 'div', 'k');
  loopK.appendChild(el(doc, 'span', null, 'THE SWARM LOOP'));
  loopK.appendChild(el(doc, 'span', null, 'LEDGER IN, MERGED PR OUT'));
  loopbar.appendChild(loopK);
  LOOP_STEPS.forEach((step) => {
    loopbar.appendChild(doc.createTextNode(`${step} `));
    loopbar.appendChild(el(doc, 'b', null, '>'));
    loopbar.appendChild(doc.createTextNode(' '));
  });
  loopbar.appendChild(el(doc, 'span', 'done', 'the ledger marks it done'));

  const wstream = el(doc, 'section', 'wstream');
  wstream.setAttribute('aria-label', 'Worker stream');
  const wHead = el(doc, 'h2');
  wHead.appendChild(el(doc, 'span', null, '// WORKER STREAM / LATEST FINISHED TICKETS'));
  const wCount = el(doc, 'span');
  wHead.appendChild(wCount);
  const wgrid = el(doc, 'div', 'wgrid');
  wstream.appendChild(wHead);
  wstream.appendChild(wgrid);

  // the orchestrator run is one line at the foot of the NOW card (no separate run-stream block)
  const runLine = el(doc, 'div', 'ck-runs');
  runLine.setAttribute('aria-label', 'Orchestrator run');

  const stack = el(doc, 'footer', 'stack');
  stack.setAttribute('aria-label', 'Ticket stack');
  const stackLeft = el(doc, 'div');
  stackLeft.appendChild(el(doc, 'div', 'k', 'TICKET STACK'));
  const stackN = el(doc, 'div', 'n');
  const stackSub = el(doc, 'div', 'ck-hint');
  stackLeft.appendChild(stackN);
  stackLeft.appendChild(stackSub);
  const tilesHost = el(doc, 'div', 'cc-cockpit-stack-tiles');
  const foot = el(doc, 'div', 'ck-foot');
  const footNote = el(doc, 'span');
  const sources = el(doc, 'details');
  sources.appendChild(el(doc, 'summary', null, 'sources'));
  sources.appendChild(el(doc, 'p', null, SOURCES_NOTE));
  foot.appendChild(footNote);
  foot.appendChild(sources);
  stack.appendChild(stackLeft);
  stack.appendChild(tilesHost);
  stack.appendChild(foot);

  panel.appendChild(titleHost);
  panel.appendChild(cols);
  panel.appendChild(loopbar);
  panel.appendChild(wstream);
  panel.appendChild(stack);
  wrap.appendChild(gbar);
  wrap.appendChild(panel);
  shell.appendChild(wrap);
  host.appendChild(shell);

  let destroyed = false;
  let activeId = null;

  /** The card of the NOW RUNNING ticket, in whichever column it sits. */
  function activeRow() {
    if (activeId == null) return null;
    for (const column of [colL, colR]) {
      for (const card of Array.from(column.children)) {
        if (card.getAttribute && card.getAttribute('data-ticket-id') === activeId) return { card, side: column === colR ? 1 : -1 };
      }
    }
    return null;
  }

  /** Place the orbit around the creature and the dotted path from the orbit to the active row. */
  function layoutWire() {
    if (!wire || destroyed) return;
    try {
      const base = cols.getBoundingClientRect();
      const hr = hd2.getBoundingClientRect();
      if (!base.width || !hr.width) return;
      const w = Math.round(base.width);
      const h = Math.round(base.height);
      wire.root.setAttribute('viewBox', `0 0 ${w} ${h}`);
      wire.root.setAttribute('width', String(w));
      wire.root.setAttribute('height', String(h));
      const cx = hr.left + hr.width / 2 - base.left;
      const cy = hr.top + hr.height * ORBIT.cy - base.top;
      const rx = hr.width * ORBIT.rx;
      const ry = hr.width * ORBIT.ry;
      wire.geo = { cx, cy, rx, ry };
      const setE = (e, k) => {
        e.setAttribute('cx', cx.toFixed(1));
        e.setAttribute('cy', cy.toFixed(1));
        e.setAttribute('rx', (rx * k).toFixed(1));
        e.setAttribute('ry', (ry * k).toFixed(1));
      };
      setE(wire.ring, 1);
      setE(wire.ring2, 0.78);
      const hit = activeRow();
      const rr = hit ? hit.card.getBoundingClientRect() : null;
      if (!hit || !rr || !rr.width) {
        wire.curve = null;
        wire.wireG.setAttribute('visibility', 'hidden');
        placeDots(0);
        return;
      }
      // one smooth cubic: leaves the orbit on the row's side (above or below its outer point), bends toward the
      // row and arrives level with its inner edge
      const s = hit.side;
      const p3 = { x: (s > 0 ? rr.left : rr.right) - base.left, y: rr.top + rr.height / 2 - base.top };
      const up = p3.y < cy ? -1 : 1;
      const p0 = { x: cx + s * rx * Math.cos(WIRE_LEAVE), y: cy + up * ry * Math.sin(WIRE_LEAVE) };
      const dx = Math.abs(p3.x - p0.x);
      const dy = p3.y - p0.y;
      const p1 = { x: p0.x + s * Math.max(28, dx * 0.35), y: p0.y + dy * 0.55 };
      const p2 = { x: p3.x - s * Math.max(48, dx * 0.6), y: p3.y };
      const curve = [p0, p1, p2, p3];
      wire.curve = curve;
      wire.len = cubicLength(curve);
      wire.wireG.setAttribute('visibility', 'visible');
      const d = `M${p0.x.toFixed(1)} ${p0.y.toFixed(1)} C${p1.x.toFixed(1)} ${p1.y.toFixed(1)} ${p2.x.toFixed(1)} ${p2.y.toFixed(1)} ${p3.x.toFixed(1)} ${p3.y.toFixed(1)}`;
      wire.path.setAttribute('d', d);
      wire.pulse.setAttribute('d', d);
      // one short dash per path length: moving its offset carries a single orange pulse from orbit to row
      wire.pulse.setAttribute('stroke-dasharray', `2 ${(wire.len + 12).toFixed(1)}`);
      NODE_TS.forEach((t, i) => {
        const q = cubicAt(curve, t);
        wire.nodes[i].setAttribute('cx', q.x.toFixed(1));
        wire.nodes[i].setAttribute('cy', q.y.toFixed(1));
      });
      wire.start.setAttribute('cx', p0.x.toFixed(1));
      wire.start.setAttribute('cy', p0.y.toFixed(1));
      wire.end.setAttribute('cx', p3.x.toFixed(1));
      wire.end.setAttribute('cy', p3.y.toFixed(1));
      placeDots(0);
    } catch {
      // layout is decoration only
    }
  }

  /** Orbit dots, ring drift and the pulse on the path at time `ms` (0 = the still frame used under reduced motion). */
  function placeDots(ms) {
    if (!wire || !wire.geo) return;
    const { cx, cy, rx, ry } = wire.geo;
    const a = (ms / ORBIT_MS) * TAU + 0.9;
    wire.odot.setAttribute('cx', (cx + rx * Math.cos(a)).toFixed(1));
    wire.odot.setAttribute('cy', (cy + ry * Math.sin(a)).toFixed(1));
    const b = a * -1.35 + 2.4;
    wire.odot2.setAttribute('cx', (cx + rx * 0.78 * Math.cos(b)).toFixed(1));
    wire.odot2.setAttribute('cy', (cy + ry * 0.78 * Math.sin(b)).toFixed(1));
    // slow drift of the ring dashes (outer one way, inner the other) and of the dotted path toward the row
    wire.ring.setAttribute('stroke-dashoffset', (-(ms / 1000) * 14).toFixed(1));
    wire.ring2.setAttribute('stroke-dashoffset', ((ms / 1000) * 9).toFixed(1));
    wire.path.setAttribute('stroke-dashoffset', (-((ms / 1000) * 10) % 8).toFixed(2));
    if (wire.curve && wire.len) {
      const t = (ms % SPARK_MS) / SPARK_MS;
      wire.pulse.setAttribute('stroke-dashoffset', (-(t * (wire.len + 4) - 2)).toFixed(1));
    }
  }

  // The creature bob, glow, live chips, scan and stream shine are CSS keyframes (cc-cockpit.css), so they run on the
  // compositor without restyling the page each frame; this loop only moves what depends on measured geometry.
  // Reduced motion never starts it and CSS drops the keyframes.
  let frame = null;
  function tick(ts) {
    frame = null;
    if (destroyed) return;
    if (!doc.hidden) placeDots(typeof ts === 'number' ? ts : Date.now());
    frame = raf(tick);
  }
  function startMotion() {
    if (reducedMotion || !raf || frame != null || destroyed) return;
    frame = raf(tick);
  }

  // Orchestrator creature: mounted once per project, then only its state follows the orchestrator.
  let headHandle = null;
  let headKey = null;
  let headWanted = null;
  let headMounted = null;

  function loadCreature() {
    if (typeof deps.mountRobotHead === 'function') return Promise.resolve({ mount: deps.mountRobotHead });
    return Promise.resolve({ mount: mountPixelCreature });
  }

  function syncHead(state, name, key) {
    headWanted = { state, label: `${name} orchestrator` };
    if (key !== headKey) {
      if (headHandle) headHandle.destroy();
      headHandle = null;
      headKey = key;
      headMounted = null;
      loadCreature().then((api) => {
        if (!api || destroyed || headKey !== key || headHandle) return;
        try {
          clear(hd2);
          headHandle = api.mount(hd2, {
            state: headWanted.state,
            size: 290,
            id: `orch-${key}`,
            label: headWanted.label,
          });
          headMounted = headWanted.state;
          layoutWire();
        } catch {
          headHandle = null;
        }
      });
      return;
    }
    if (headHandle && headMounted !== state) {
      headHandle.setState(state);
      headMounted = state;
    }
  }

  function paintCounters(items) {
    clear(cnt);
    for (const c of items) {
      const cell = el(doc, 'div');
      cell.appendChild(el(doc, 'div', 'l', c.label));
      const v = el(doc, 'div', 'v has-tip', String(c.value));
      v.setAttribute('tabindex', '0');
      v.setAttribute('data-k', c.label);
      v.setAttribute('data-tip', c.tip);
      if (c.color) v.style.color = c.color;
      cell.appendChild(v);
      cnt.appendChild(cell);
    }
  }

  function paintNow(columns, model, runs) {
    clear(nowHost);
    const name = model.name;
    const lead = columns.left[0] && ['running', 'ready'].includes(columns.left[0].state) ? columns.left[0] : null;
    if (lead) {
      const t = lead.ticket;
      const running = lead.state === 'running';
      const k = el(doc, 'div', 'k');
      k.appendChild(el(doc, 'span', null, running ? 'NOW RUNNING' : 'NEXT UP'));
      k.appendChild(el(doc, 'span', 'cn', `1 / ${running ? columns.counts.running : columns.counts.ready}`));
      nowHost.appendChild(k);
      const full = String(t.title || t.id).replace(/"/g, '');
      nowHost.appendChild(el(doc, 'div', 'p', `${name} / ${t.stage ? `${t.stage} / ` : ''}${shortTitle(full)}`));
      nowHost.appendChild(el(doc, 'div', 't', t.id));
      const d = el(doc, 'div', 'd', full);
      d.setAttribute('title', full);
      d.setAttribute('data-title', full);
      nowHost.appendChild(d);
    } else {
      const k = el(doc, 'div', 'k');
      k.appendChild(el(doc, 'span', null, 'STATUS'));
      k.appendChild(el(doc, 'span'));
      nowHost.appendChild(k);
      nowHost.appendChild(el(doc, 'div', 'p', name));
      nowHost.appendChild(el(doc, 'div', 't', model.total > 0 && model.done >= model.total ? 'All done' : 'Idle'));
      nowHost.appendChild(el(doc, 'div', 'd', `${model.total} tickets in the ledger`));
    }
    const running = columns.counts.running;
    const w = el(doc, 'div', 'd w');
    w.appendChild(el(doc, 'em', null, 'WORKER >'));
    w.appendChild(el(doc, 'b', null, running ? `${running} ticket${running === 1 ? '' : 's'} running now` : 'no ticket running right now'));
    nowHost.appendChild(w);
    renderRunLine(runLine, runs);
    nowHost.appendChild(runLine);
  }

  let projectRef = project;
  let firstPaint = true;

  function paint(at) {
    const p = projectRef;
    const ledger = p?.ledger ?? { tickets: [] };
    const model = renderCockpit(titleHost, {
      ledger,
      sessions: p?.sessions ?? [],
      meta: p?.meta ?? {},
      name: p?.name,
      id: p?.id,
      done: p?.done,
      total: p?.total,
    }, { now: at });
    // one ordered ledger list drives both columns, the NOW card, the header, the stream count and the stack
    const columns = cockpitLedgerRows(ledger, readyTickets, { perColumn: ROWS_PER_COLUMN });
    const { counts } = columns;
    const orch = model.orchestrator;
    const allDone = model.total > 0 && model.done >= model.total;
    const cats = cockpitCategories(ledger);
    // the NOW RUNNING card, the highlighted row and the dotted path all follow this one ticket
    const lead = columns.left[0];
    activeId = lead && ['running', 'ready'].includes(lead.state) ? lead.ticket.id : null;

    crumbProject.textContent = model.name;
    paintCounters(headerCounters(p, counts));
    metaDate.textContent = utcDate(at);

    if (columns.left.length) renderTicketColumn(colL, columns.left, { side: 'L', activeId, categoryOf: cats.of });
    else renderReadyEmptyState(colL, ledger, readyTickets);
    renderTicketColumn(colR, columns.right, { side: 'R', activeId, categoryOf: cats.of, more: columns.more, emptyText: 'No review, blocked or finished tickets yet.' });
    const rowsR = columns.right.length + (columns.more ? 1 : 0);
    colL.classList.toggle?.('spread', columns.left.length >= SPREAD_MIN_ROWS);
    colR.classList.toggle?.('spread', rowsR >= SPREAD_MIN_ROWS);

    lab.setAttribute('data-orchestrator', orch.label);
    labSub.textContent = orchestratorCaption(orch.label, allDone);
    syncHead(orchestratorHeadState(orch.label, allDone), model.name, String(p?.id ?? model.name));
    paintNow(columns, model, runStreamItems(p, orch));

    const cards = workerCards(ledger, at, 4);
    renderWorkerCards(wgrid, cards);
    wCount.textContent = cards.length ? `${cards.length} LATEST · ${counts.done} DONE` : '0 DONE';

    stackN.textContent = model.total > 0 ? `${model.total} TICKETS` : 'NO TICKETS';
    stackSub.textContent = cats.field && cats.names.length
      ? cats.names.join(' / ')
      : 'no lane or type recorded on these tickets';
    const tiles = [
      ['ready', counts.ready],
      ...(counts.running ? [['running', counts.running]] : []),
      ['review', counts.review],
      ['waiting', counts.blocked, 'blocked'],
      ['to do', counts.todo, 'todo'],
      ['done', counts.done],
    ].map(([label, value, key]) => ({ label, value, color: TILE_COLOURS[key || label], footnote: `${value} ${label}` }));
    const big = Math.max(...tiles.map(t => t.value));
    for (const t of tiles) t.hi = big > 0 && t.value === big;
    renderStackSummaryTiles(tilesHost, tiles);
    footNote.textContent = `${counts.cancelled} cancelled, left out of the percent${counts.proposed ? ` · ${counts.proposed} proposed, not counted` : ''} · data: this project's ledger, run folders and orchestrator sessions, read at ${utcClock(at)}`;

    layoutWire();
    if (firstPaint) {
      firstPaint = false;
      if (doc.fonts && doc.fonts.ready && typeof doc.fonts.ready.then === 'function') {
        doc.fonts.ready.then(() => { if (!destroyed) layoutWire(); }, () => {});
      }
      // the app's one glitch: the SWARM wordmark, once on arrival
      later(() => glitch(logo), 600);
      // stream bars grow from zero on arrival only; later polls repaint them at their width
      later(() => shell.classList.remove('ck-intro'), 1600);
    }
    startMotion();
  }

  const onBackClick = () => {
    if (typeof deps.onBack === 'function') deps.onBack();
  };
  backBtn.addEventListener('click', onBackClick);
  const onLogoHover = () => glitch(logo);
  logo.addEventListener('mouseenter', onLogoHover);
  const onResize = () => layoutWire();
  if (typeof win.addEventListener === 'function') win.addEventListener('resize', onResize);

  try {
    paint(nowMs(deps));
  } catch {
    // keep the shell and the back control usable if a panel cannot paint (partial DOM)
  }

  return {
    update(nextProject) {
      projectRef = nextProject;
      paint(nowMs(deps));
    },
    destroy() {
      destroyed = true;
      for (const id of timers) clearTimer(id);
      timers.clear();
      if (frame != null && caf) caf(frame);
      frame = null;
      backBtn.removeEventListener('click', onBackClick);
      logo.removeEventListener('mouseenter', onLogoHover);
      if (typeof win.removeEventListener === 'function') win.removeEventListener('resize', onResize);
      if (headHandle) headHandle.destroy();
      headHandle = null;
      while (host.firstChild) host.removeChild(host.firstChild);
    },
  };
}
