// SPDX-License-Identifier: Apache-2.0
/**
 * Mount Command Center project Cockpit from buildProjectCockpit snapshot data.
 * Layout, drawing and motion follow the owner-approved artifact (docs/design/reference/command-center-artifact);
 * every number and name is read from the live project payload.
 */

import { readyTickets } from './cc-ledger-browser.js';
import { renderCockpit, orchestratorHeadState, orchestratorCaption } from './cockpit-view.js';
import {
  cockpitColumns,
  renderTicketColumn,
  renderReadyEmptyState,
  renderStackSummaryTiles,
  renderWorkerCards,
  renderRunCards,
  workerCards,
  shortTitle,
} from './cockpit-lists.js';
import { mountOrbit } from './cc-cockpit-orbit.js';
import { glitch as defaultGlitch } from './cc-glitch.js';
import { completionKey } from './cc-tour.js';

const TOUR_USER = 'anonymous';
const ORCHESTRATOR_COLOUR = '#c084fc';
const HIDDEN_STATUSES = ['cancelled', 'proposed'];
const TILE_COLOURS = { ready: '#2fe0a0', running: '#2fe0a0', review: '#ff4d7e', blocked: '#ffb62e', todo: '#a98bff', done: '#4d7cff' };
const LOOP_STEPS = ['you approve the scope', 'the split makes tickets', 'workers build in waves', 'checks gate every merge', 'the PR merges'];
const SOURCES_NOTE = 'Read from this project\'s ledger (tickets and stages), its orchestrator sessions and its run stream, as served by the Command Center. Real robot head from tools/watch-assets. The orbit ring is our own design. Glitch limits in code: each burst under 400 ms, at most 3 at once, never on text being read, off with reduced motion.';

function el(doc, tag, cls, text) {
  const n = doc.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
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
    { label: 'need you', value: needsYou, color: 'var(--red)', tip: 'Human tickets still open plus tickets waiting in review.' },
  ];
}

function utcClock(ms) {
  return `${new Date(ms).toISOString().slice(11, 16)} UTC`;
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

/**
 * @param {HTMLElement} host
 * @param {object} project buildProjectCockpit shape
 * @param {{
 *   document: Document, now?: number|(() => number), onBack?: () => void, window?: Window,
 *   glitch?: (el: Element) => unknown, mountRobotHead?: Function, setAnimationPaused?: (v: boolean) => void,
 *   requestAnimationFrame?: Function, cancelAnimationFrame?: Function, matchMedia?: typeof matchMedia,
 *   setTimeout?: typeof setTimeout, clearTimeout?: typeof clearTimeout,
 * }} deps
 */
export function renderProjectCockpit(host, project, deps) {
  suppressCockpitAutoTour();
  const doc = deps.document;
  const win = deps.window || globalThis;
  const glitch = typeof deps.glitch === 'function' ? deps.glitch : defaultGlitch;
  const setTimer = deps.setTimeout || globalThis.setTimeout.bind(globalThis);
  const clearTimer = deps.clearTimeout || globalThis.clearTimeout.bind(globalThis);
  const timers = new Set();
  const later = (fn, ms) => {
    const id = setTimer(() => { timers.delete(id); fn(); }, ms);
    timers.add(id);
  };

  while (host.firstChild) host.removeChild(host.firstChild);

  const shell = el(doc, 'div', 'cc-cockpit-shell');
  if (project?.id != null) shell.setAttribute('data-project-id', String(project.id));
  const wrap = el(doc, 'div', 'ck-wrap');

  // Top bar: logo, counters, live dot, breadcrumb, page links.
  const gbar = el(doc, 'div', 'gbar');
  const top = el(doc, 'header', 'ck-top');
  top.appendChild(el(doc, 'span', 'logo', 'SWARM WATCH'));
  const cnt = el(doc, 'div', 'cnt');
  top.appendChild(cnt);
  const live = el(doc, 'span', 'ck-live');
  live.appendChild(el(doc, 'i'));
  live.appendChild(doc.createTextNode('LIVE'));
  top.appendChild(live);
  const nav = el(doc, 'div', 'ck-nav');
  const crumbs = el(doc, 'nav', 'crumbs');
  crumbs.setAttribute('aria-label', 'Breadcrumb');
  const backBtn = el(doc, 'button', 'cc-cockpit-back-btn', 'The Hive');
  backBtn.type = 'button';
  const crumbProject = el(doc, 'span');
  crumbProject.setAttribute('aria-current', 'page');
  crumbs.appendChild(backBtn);
  crumbs.appendChild(el(doc, 'span', null, '›'));
  crumbs.appendChild(crumbProject);
  nav.appendChild(crumbs);
  const tabs = el(doc, 'div', 'tabs');
  const ccTab = el(doc, 'a', null, 'Command Center');
  ccTab.href = '/command-center';
  ccTab.setAttribute('aria-current', 'page');
  const classicTab = el(doc, 'a', null, 'Classic');
  classicTab.href = '/';
  tabs.appendChild(ccTab);
  tabs.appendChild(classicTab);
  nav.appendChild(tabs);
  gbar.appendChild(top);
  gbar.appendChild(nav);

  const panel = el(doc, 'main', 'panel-cockpit');
  panel.id = 'cc-cockpit-main';

  const titleHost = el(doc, 'div', 'ct');
  const cols = el(doc, 'div', 'cols');
  const colL = el(doc, 'div', 'col l');
  colL.id = 'tickets-left';
  colL.setAttribute('aria-label', 'Ready and running tickets');
  const colR = el(doc, 'div', 'col r');
  colR.id = 'tickets-right';
  colR.setAttribute('aria-label', 'Review, blocked and finished tickets');
  const mid = el(doc, 'div', 'mid');
  const orbwrap = el(doc, 'div', 'orbwrap');
  const orbBack = el(doc, 'canvas');
  orbBack.setAttribute('aria-hidden', 'true');
  const lab = el(doc, 'div', 'lab');
  const labTitle = el(doc, 'span', null, 'ORCHESTRATOR');
  const labSub = el(doc, 'small');
  lab.appendChild(labTitle);
  lab.appendChild(labSub);
  const hd2 = el(doc, 'div', 'hd2');
  const orbFront = el(doc, 'canvas');
  orbFront.setAttribute('aria-hidden', 'true');
  orbwrap.appendChild(orbBack);
  orbwrap.appendChild(lab);
  orbwrap.appendChild(hd2);
  orbwrap.appendChild(orbFront);
  const nowHost = el(doc, 'div', 'now');
  nowHost.setAttribute('aria-label', 'Now panel');
  mid.appendChild(orbwrap);
  mid.appendChild(nowHost);
  cols.appendChild(colL);
  cols.appendChild(mid);
  cols.appendChild(colR);

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

  const rstream = el(doc, 'section', 'wstream');
  rstream.setAttribute('aria-label', 'Run stream');
  const rHead = el(doc, 'h2');
  rHead.appendChild(el(doc, 'span', null, '// RUN STREAM / ORCHESTRATOR RUNS'));
  const rCount = el(doc, 'span');
  rHead.appendChild(rCount);
  const rgrid = el(doc, 'div', 'wgrid');
  rstream.appendChild(rHead);
  rstream.appendChild(rgrid);

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
  panel.appendChild(rstream);
  panel.appendChild(stack);
  wrap.appendChild(gbar);
  wrap.appendChild(panel);
  shell.appendChild(wrap);
  host.appendChild(shell);

  const probe = doc.createElement('canvas');
  const canvasCapable = typeof probe.getContext === 'function';
  const orbit = mountOrbit({
    back: orbBack,
    front: orbFront,
    target: () => {
      const first = colR.firstChild;
      return first && first.classList && first.classList.contains('hot') ? first : null;
    },
    win,
    doc,
    requestAnimationFrame: deps.requestAnimationFrame,
    cancelAnimationFrame: deps.cancelAnimationFrame,
    reducedMotion: typeof deps.matchMedia === 'function'
      ? Boolean(deps.matchMedia('(prefers-reduced-motion: reduce)').matches)
      : undefined,
  });

  // Robot head: mounted once per project, then only its state follows the orchestrator.
  let destroyed = false;
  let robotApi = null;
  let headHandle = null;
  let headKey = null;
  let headWanted = null;
  let headMounted = null;

  function loadRobot() {
    if (typeof deps.mountRobotHead === 'function') {
      return Promise.resolve({ mountRobotHead: deps.mountRobotHead, setAnimationPaused: deps.setAnimationPaused });
    }
    if (!canvasCapable) return Promise.resolve(null);
    return import('./robot-head.js').catch(() => null);
  }

  function syncHead(state, name, key) {
    headWanted = { state, label: `${name} orchestrator` };
    if (key !== headKey) {
      if (headHandle) headHandle.destroy();
      headHandle = null;
      headKey = key;
      headMounted = null;
      loadRobot().then((api) => {
        if (!api || destroyed || headKey !== key || headHandle) return;
        robotApi = api;
        try {
          clear(hd2);
          headHandle = api.mountRobotHead(hd2, {
            state: headWanted.state,
            size: 290,
            color: ORCHESTRATOR_COLOUR,
            screenColor: '#e8f2ff',
            id: `orch-${key}`,
            label: headWanted.label,
          });
          headMounted = headWanted.state;
          if (typeof api.setAnimationPaused === 'function') api.setAnimationPaused(Boolean(doc.hidden));
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

  // Counters: a change in agents or need-you gets one short glitch, 400 ms after the repaint.
  let lastCounters = '';
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
    const sig = JSON.stringify(items.filter(c => c.label === 'agents' || c.label === 'need you').map(c => c.value));
    if (lastCounters && lastCounters !== sig) {
      for (const cell of Array.from(cnt.children)) {
        const v = cell.children[1];
        if (v && (v.getAttribute('data-k') === 'agents' || v.getAttribute('data-k') === 'need you')) later(() => glitch(v), 400);
      }
    }
    lastCounters = sig;
  }

  function paintNow(columns, model) {
    clear(nowHost);
    const name = model.name;
    const lead = columns.left[0];
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
    const w = el(doc, 'div', 'd');
    w.appendChild(el(doc, 'em', null, 'WORKER >'));
    w.appendChild(el(doc, 'b', null, running ? `${running} ticket${running === 1 ? '' : 's'} running now` : 'no ticket running right now'));
    nowHost.appendChild(w);
  }

  function attachChipGlitch(column) {
    for (const card of Array.from(column.children)) {
      const chip = card.children && card.children[0];
      if (chip && typeof chip.addEventListener === 'function') chip.addEventListener('mouseenter', () => glitch(chip));
    }
  }

  let projectRef = project;
  let firstPaint = true;
  let headTitleGlitched = false;

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
    const columns = cockpitColumns(ledger, readyTickets);
    const { counts } = columns;
    const orch = model.orchestrator;
    const allDone = model.total > 0 && model.done >= model.total;

    crumbProject.textContent = model.name;
    paintCounters(headerCounters(p, counts));

    if (columns.left.length) renderTicketColumn(colL, columns.left, { side: 'L' });
    else renderReadyEmptyState(colL, ledger, readyTickets);
    renderTicketColumn(colR, columns.right, { side: 'R', emptyText: 'No review, blocked or finished tickets yet.' });
    attachChipGlitch(colL);
    attachChipGlitch(colR);

    lab.setAttribute('data-orchestrator', orch.label);
    labSub.textContent = orchestratorCaption(orch.label, allDone);
    syncHead(orchestratorHeadState(orch.label, allDone), model.name, String(p?.id ?? model.name));
    paintNow(columns, model);

    const cards = workerCards(ledger, at, 4);
    renderWorkerCards(wgrid, cards);
    wCount.textContent = `${cards.length} LATEST`;
    const runs = runStreamItems(p, orch);
    rstream.hidden = runs.length === 0;
    if (runs.length) {
      renderRunCards(rgrid, runs);
      rCount.textContent = `${runs.length} ${runs.length === 1 ? 'RUN' : 'RUNS'}`;
    }

    stackN.textContent = model.total > 0 ? `${model.total} TICKETS` : 'NO TICKETS';
    stackSub.textContent = `${counts.cancelled} cancelled and left out of the percent${counts.proposed ? `, ${counts.proposed} proposed not counted` : ''}`;
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
    footNote.textContent = `data: this project's ledger, run folders and orchestrator sessions, read at ${utcClock(at)}`;

    orbit.resize();
    if (firstPaint) {
      firstPaint = false;
      if (doc.fonts && doc.fonts.ready && typeof doc.fonts.ready.then === 'function') {
        doc.fonts.ready.then(() => { if (!destroyed) orbit.resize(); }, () => {});
      }
    }
    if (!headTitleGlitched) {
      headTitleGlitched = true;
      const h1 = titleHost.firstChild;
      if (h1) glitch(h1);
    }
  }

  const onBackClick = () => {
    if (typeof deps.onBack === 'function') deps.onBack();
  };
  backBtn.addEventListener('click', onBackClick);
  const onHeadHover = () => glitch(hd2);
  hd2.addEventListener('mouseenter', onHeadHover);
  const onResize = () => orbit.resize();
  if (typeof win.addEventListener === 'function') win.addEventListener('resize', onResize);
  const onVisibility = () => {
    if (robotApi && typeof robotApi.setAnimationPaused === 'function') robotApi.setAnimationPaused(Boolean(doc.hidden));
  };
  if (typeof doc.addEventListener === 'function') doc.addEventListener('visibilitychange', onVisibility);

  paint(nowMs(deps));

  return {
    update(nextProject) {
      projectRef = nextProject;
      paint(nowMs(deps));
    },
    destroy() {
      destroyed = true;
      for (const id of timers) clearTimer(id);
      timers.clear();
      backBtn.removeEventListener('click', onBackClick);
      hd2.removeEventListener('mouseenter', onHeadHover);
      if (typeof win.removeEventListener === 'function') win.removeEventListener('resize', onResize);
      if (typeof doc.removeEventListener === 'function') doc.removeEventListener('visibilitychange', onVisibility);
      orbit.destroy();
      if (headHandle) headHandle.destroy();
      headHandle = null;
      while (host.firstChild) host.removeChild(host.firstChild);
    },
  };
}
