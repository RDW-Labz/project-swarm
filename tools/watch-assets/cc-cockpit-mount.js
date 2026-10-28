// SPDX-License-Identifier: Apache-2.0
/** Mount Command Center project Cockpit from buildProjectCockpit snapshot data. */

import { ticketToQueueJob, listQueueJobsForProject, readyTickets } from './cc-ledger-browser.js';
import { renderCockpit, headlineTicketText } from './cockpit-view.js';
import { cockpitOrchestratorState, cockpitOrchestratorFromSessions } from './cockpit-orchestrator.js';
import {
  renderCockpitTicketList,
  renderStackSummaryTiles,
  renderReadyEmptyState,
  layoutSummaryTileElement,
  queueVisibleJobs,
  renderWorkerStream,
  workerStreamFromLedger,
} from './cockpit-lists.js';
import { renderRunStream } from './cockpit-run-stream.js';
import { completionKey } from './cc-tour.js';

const queueDeps = { ticketToQueueJob, listQueueJobsForProject };

const TOUR_USER = 'anonymous';

function el(doc, tag, cls, text) {
  const n = doc.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
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

function cockpitViewModel(project) {
  return {
    ledger: project?.ledger ?? { tickets: [] },
    sessions: project?.sessions ?? [],
    meta: project?.meta ?? {},
    done: project?.done,
    total: project?.total,
  };
}

function primarySession(sessions) {
  const list = Array.isArray(sessions) ? sessions.filter(s => s && s.shown !== false) : [];
  return list[0] ?? null;
}

function liveTickets(ledger) {
  return (ledger?.tickets ?? []).filter(t => !['cancelled', 'proposed'].includes(t.status));
}

function ticketStatusCounts(project) {
  const live = liveTickets(project?.ledger);
  const counts = { ready: 0, running: 0, done: 0, blocked: 0 };
  for (const t of live) {
    if (t.status === 'done') counts.done += 1;
    else if (t.status === 'running') counts.running += 1;
    else if (t.status === 'blocked') counts.blocked += 1;
    else counts.ready += 1;
  }
  return counts;
}

/** @param {object} project buildProjectCockpit row */
function stackSummaryTiles(project) {
  const counts = ticketStatusCounts(project);
  const done = project?.done ?? counts.done;
  const total = project?.total ?? liveTickets(project?.ledger).length;
  return [
    {
      label: 'ready',
      value: counts.ready,
      footnote: `${counts.ready} runnable now`,
      variant: 'web',
    },
    {
      label: 'running',
      value: counts.running,
      footnote: `${counts.running} in flight`,
      variant: 'engines',
    },
    {
      label: 'done',
      value: done,
      footnote: `${done} of ${total} done`,
      variant: 'taste',
    },
    {
      label: 'blocked',
      value: counts.blocked,
      footnote: `${counts.blocked} blocked`,
      variant: 'broll',
    },
  ];
}

function stackFootnote(project) {
  const name = project?.name ?? project?.meta?.project;
  if (!name) return '';
  return String(name);
}

function wrapHeaderHeroPack(headerHost, doc) {
  if (headerHost.querySelector?.('.header-hero-pack')) return;
  const nav = headerHost.querySelector?.('.cockpit-nav');
  const hero = headerHost.querySelector?.('.cockpit-hero');
  const scan = headerHost.querySelector?.('.scan-live--header');
  if (!nav || !hero || !scan) return;
  const pack = el(doc, 'div', 'header-hero-pack');
  const main = el(doc, 'div', 'header-hero-main');
  nav.parentNode?.removeChild(nav);
  hero.parentNode?.removeChild(hero);
  scan.parentNode?.removeChild(scan);
  main.appendChild(nav);
  main.appendChild(hero);
  pack.appendChild(main);
  pack.appendChild(scan);
  headerHost.insertBefore(pack, headerHost.firstChild);
}

function syncOrchestratorLabel(headerHost, project, at) {
  const session = primarySession(project?.sessions);
  const orch = session
    ? cockpitOrchestratorState(session, at)
    : cockpitOrchestratorFromSessions([], at);
  const blocks = [];
  const walk = (node) => {
    if (!node) return;
    if (node.classList?.contains('nav-block')) blocks.push(node);
    for (const c of node.children || []) walk(c);
  };
  walk(headerHost);
  const orchBlock = blocks.find(b => {
    const text = (b.textContent || '').toLowerCase();
    return text.includes('orchestrator');
  });
  if (!orchBlock) return orch;
  orchBlock.replaceChildren?.();
  if (!orchBlock.replaceChildren) {
    while (orchBlock.firstChild) orchBlock.removeChild(orchBlock.firstChild);
  }
  const doc = headerHost.ownerDocument || globalThis.document;
  const label = doc.createElement('span');
  label.className = 'num-label';
  label.textContent = 'orchestrator';
  orchBlock.appendChild(label);
  orchBlock.appendChild(doc.createTextNode(` ${orch.label}`));
  return orch;
}

function paintCockpitHeader(headerHost, project, _deps, at) {
  while (headerHost.firstChild) headerHost.removeChild(headerHost.firstChild);
  renderCockpit(headerHost, cockpitViewModel(project), { now: at });
  syncOrchestratorLabel(headerHost, project, at);
  wrapHeaderHeroPack(headerHost, headerHost.ownerDocument || globalThis.document);
}

function activeTicket(project) {
  const ledger = project?.ledger ?? { tickets: [] };
  const jobs = queueVisibleJobs(ledger, { id: project?.id }, queueDeps);
  const byId = new Map((ledger.tickets ?? []).map(t => [t.id, t]));
  for (const job of jobs) {
    const t = byId.get(job.id);
    if (t?.status === 'running') return t;
  }
  for (const job of jobs) {
    const t = byId.get(job.id);
    if (t && t.status !== 'done') return t;
  }
  return jobs.length ? byId.get(jobs[0].id) : null;
}

function paintNowPanel(nowHost, project) {
  while (nowHost.firstChild) nowHost.removeChild(nowHost.firstChild);
  const doc = nowHost.ownerDocument;
  if (!doc?.createElement) return;
  const ledger = project?.ledger ?? { tickets: [] };
  const live = liveTickets(ledger);
  const done = project?.done ?? live.filter(t => t.status === 'done').length;
  const total = project?.total ?? live.length;
  const ticket = activeTicket(project);
  const panel = el(doc, 'aside', 'now-panel');
  panel.setAttribute('aria-label', 'Now loading panel');
  const head = el(doc, 'div', 'now-head');
  head.appendChild(el(doc, 'span', null, 'Now loading'));
  const prog = el(doc, 'span', 'now-progress');
  const progVal = el(doc, 'span', 'val num');
  const idx = ticket ? jobsIndex(project, ticket.id) + 1 : done;
  progVal.textContent = String(idx);
  prog.appendChild(progVal);
  prog.appendChild(el(doc, 'span', 'scan-of', '/'));
  const progTotal = el(doc, 'span', 'val num');
  progTotal.textContent = String(total);
  prog.appendChild(progTotal);
  head.appendChild(prog);
  panel.appendChild(head);
  if (ticket) {
    panel.appendChild(el(doc, 'div', 'now-repo', ticket.id));
    panel.appendChild(el(doc, 'div', 'now-title', ticket.title || ticket.id));
  } else {
    panel.appendChild(el(doc, 'p', 'cc-empty', 'No active ticket'));
  }
  nowHost.appendChild(panel);
}

function jobsIndex(project, ticketId) {
  const jobs = queueVisibleJobs(project?.ledger ?? {}, { id: project?.id }, queueDeps);
  return jobs.findIndex(j => j.id === ticketId);
}

function appendMascotStage(parent, doc) {
  const mascot = el(doc, 'div', 'mascot-stage');
  mascot.setAttribute('aria-hidden', 'true');
  const orbit = el(doc, 'div', 'mascot-orbit');
  orbit.appendChild(el(doc, 'span', 'mascot-orbit-dot'));
  mascot.appendChild(orbit);
  mascot.appendChild(el(doc, 'div', 'mascot-pixel'));
  mascot.appendChild(el(doc, 'div', 'mascot-shadow'));
  parent.appendChild(mascot);
}

function paintTicketLists(leftHost, rightHost, readyHost, project) {
  const ledger = project?.ledger ?? { tickets: [] };
  const projectConfig = { id: project?.id };
  const jobs = queueVisibleJobs(ledger, projectConfig, queueDeps);
  const split = Math.ceil(jobs.length / 2);
  renderCockpitTicketList(leftHost, ledger, {
    projectConfig,
    queueDeps,
    sliceStart: 0,
    sliceEnd: split,
    showSearch: false,
  });
  renderCockpitTicketList(rightHost, ledger, {
    projectConfig,
    queueDeps,
    sliceStart: split,
    showSearch: false,
  });
  if (readyHost) {
    while (readyHost.firstChild) readyHost.removeChild(readyHost.firstChild);
    const ready = readyTickets(ledger.tickets ?? []);
    if (!ready.length) {
      renderReadyEmptyState(readyHost, ledger, readyTickets);
    }
  }
}

function paintStack(stackTilesHost, stackFootHost, project, viewport) {
  const tiles = stackSummaryTiles(project);
  const forRender = tiles.map(({ label, value, footnote, variant }) => ({
    label,
    value,
    footnote,
    variant,
  }));
  renderStackSummaryTiles(stackTilesHost, forRender);
  const rendered = stackTilesHost.querySelectorAll
    ? Array.from(stackTilesHost.querySelectorAll('.cockpit-metric-tile'))
    : [];
  for (const tile of rendered) {
    layoutSummaryTileElement(tile, viewport);
  }
  while (stackFootHost.firstChild) stackFootHost.removeChild(stackFootHost.firstChild);
  const foot = stackFootnote(project);
  if (foot) stackFootHost.appendChild(el(stackFootHost.ownerDocument, 'span', 'stack-foot-note', foot));
}

function runStreamItems(project, at) {
  const session = primarySession(project?.sessions);
  const orch = session ? cockpitOrchestratorState(session, at) : null;
  const ended = orch && (orch.label === 'waiting on you' || session?.state === 'waiting' || session?.state === 'ended');
  const raw = Array.isArray(project?.runStream) ? project.runStream : [];
  return raw.map(item => {
    const title = ended && String(item.title || '').toLowerCase() === 'running' ? 'ended' : (item.title || '');
    const status = ended ? 'ended' : (item.status || item.title || 'running');
    return { ...item, title, status };
  });
}

function paintRunStream(host, project, at) {
  const items = runStreamItems(project, at);
  if (!items.length) {
    while (host.firstChild) host.removeChild(host.firstChild);
    const doc = host.ownerDocument;
    const empty = el(doc, 'p', 'cc-empty');
    empty.textContent = 'No runs yet';
    host.appendChild(empty);
    return;
  }
  renderRunStream(host, items);
}

function paintWorkerStream(host, project) {
  const items = workerStreamFromLedger(project?.ledger, 4);
  renderWorkerStream(host, items);
}

function buildBottomLoops(doc) {
  const wrap = el(doc, 'div', 'bottom-loops');
  const swarm = el(doc, 'section', 'loop-block loop-block--swarm');
  swarm.setAttribute('aria-label', 'Swarm loop');
  const swarmHead = el(doc, 'div', 'loop-head');
  swarmHead.appendChild(el(doc, 'span', 'title', 'The swarm loop'));
  swarmHead.appendChild(el(doc, 'span', 'tag', 'Ledger in, merged PR out'));
  swarm.appendChild(swarmHead);
  swarm.appendChild(el(doc, 'p', 'loop-steps', 'you approve the scope > the split makes tickets > workers build in waves > checks gate every merge > the PR merges > the ledger marks it done'));
  const motion = el(doc, 'section', 'loop-block');
  motion.setAttribute('aria-label', 'Project loop');
  const motionHead = el(doc, 'div', 'loop-head');
  motionHead.appendChild(el(doc, 'span', 'title', 'The delivery loop'));
  motionHead.appendChild(el(doc, 'span', 'tag', 'Scope in, shipped out'));
  motion.appendChild(motionHead);
  motion.appendChild(el(doc, 'p', 'loop-steps', 'you set scope > orchestrator plans > workers execute > checks run > tickets close'));
  wrap.appendChild(swarm);
  wrap.appendChild(motion);
  return wrap;
}

function safeClone(node, deep) {
  if (node && typeof node.cloneNode === 'function') {
    return node.cloneNode(Boolean(deep));
  }
  return null;
}

function phoneLayoutOn(matchMedia) {
  const mq = matchMedia || globalThis.matchMedia?.bind(globalThis);
  if (!mq) return false;
  try {
    return mq('(max-width: 720px)').matches;
  } catch {
    return false;
  }
}

function paintPhoneNowRows(phoneNow, project, doc) {
  const ledger = project?.ledger ?? { tickets: [] };
  const jobs = queueVisibleJobs(ledger, { id: project?.id }, queueDeps);
  const active = activeTicket(project);
  const rows = el(doc, 'div', 'phone-now-rows');
  rows.setAttribute('aria-label', 'Highlighted tickets');
  let added = 0;
  for (let i = 0; i < jobs.length; i += 1) {
    const job = jobs[i];
    if (active && job.id === active.id) continue;
    if (added >= 6) break;
    const col = el(doc, 'div', 'ticket-col ticket-col--phone');
    renderCockpitTicketList(col, ledger, {
      projectConfig: { id: project?.id },
      queueDeps,
      sliceStart: i,
      sliceEnd: i + 1,
      showSearch: false,
    });
    const row = col.children?.find?.(c => c.classList?.contains('ticket-row') || c.classList?.contains('cockpit-ticket-row'))
      || (col.querySelector && col.querySelector('.ticket-row'));
    if (row) rows.appendChild(row);
    added += 1;
  }
  phoneNow.appendChild(rows);
}

function paintPhonePanels(deps, refs, project, at) {
  const {
    doc,
    phoneNow,
    phoneTickets,
    phoneStream,
    phoneStack,
    stageCenter,
    nowPanelHost,
    readyHost,
    bottomLoops,
    workerSection,
    streamSection,
    stackBlock,
    viewport,
  } = refs;

  for (const panel of [phoneNow, phoneTickets, phoneStream, phoneStack]) {
    if (panel) while (panel.firstChild) panel.removeChild(panel.firstChild);
  }

  if (!phoneLayoutOn(deps.matchMedia)) return;

  if (phoneNow) {
    const wrap = el(doc, 'div', 'stage-center stage-center--phone');
    const entity = stageCenter?.querySelector?.('.entity-label');
    if (entity) wrap.appendChild(safeClone(entity, true));
    if (nowPanelHost) {
      paintNowPanel(nowPanelHost, project);
      wrap.appendChild(safeClone(nowPanelHost, true));
    }
    phoneNow.appendChild(wrap);
    if (bottomLoops) {
      const loops = safeClone(bottomLoops, true);
      if (loops) {
        loops.classList.add('phone-now-loops');
        phoneNow.appendChild(loops);
      }
    }
    paintPhoneNowRows(phoneNow, project, doc);
  }

  if (phoneTickets) {
    const wrap = el(doc, 'div', 'stage-wrap stage-wrap--phone');
    wrap.setAttribute('aria-label', 'Ticket list');
    renderCockpitTicketList(wrap, project?.ledger ?? { tickets: [] }, {
      projectConfig: { id: project?.id },
      queueDeps,
      showSearch: true,
    });
    phoneTickets.appendChild(wrap);
  }

  if (phoneStream) {
    const streamWrap = el(doc, 'div', 'stream-section--phone');
    if (workerSection) {
      const w = safeClone(workerSection, true);
      if (w) streamWrap.appendChild(w);
    }
    if (streamSection) {
      const c = safeClone(streamSection, true);
      if (c) {
        c.classList.add('stream-section--phone');
        streamWrap.appendChild(c);
      }
    }
    phoneStream.appendChild(streamWrap);
  }

  if (phoneStack && stackBlock) {
    const clone = safeClone(stackBlock, true);
    if (clone) {
      clone.classList.add('stack-block--phone');
      const tilesHost = clone.querySelector?.('.cc-cockpit-stack-tiles');
      if (tilesHost) {
        paintStack(tilesHost, clone.querySelector?.('.stack-foot') || el(doc, 'div', 'stack-foot'), project, viewport);
      }
      phoneStack.appendChild(clone);
    }
  }
}

function bindPhoneTabs(panel, tabs, phonePanels, tabIds, matchMedia) {
  const mq = matchMedia || globalThis.matchMedia?.bind(globalThis);
  const query = mq ? mq('(max-width: 720px)') : null;

  function selectPhoneTab(which) {
    tabIds.forEach((id, i) => {
      const selected = id === which;
      if (tabs[i]) tabs[i].setAttribute('aria-selected', selected ? 'true' : 'false');
      if (phonePanels[i]) phonePanels[i].dataset.active = selected ? 'true' : 'false';
    });
  }

  function syncTabMode() {
    const on = query ? query.matches : false;
    if (panel) panel.dataset.tabMode = on ? 'true' : 'false';
    if (!on) {
      for (const p of phonePanels) {
        if (p) p.dataset.active = 'false';
      }
      return;
    }
    let active = tabs.findIndex(t => t && t.getAttribute('aria-selected') === 'true');
    if (active < 0) active = 0;
    selectPhoneTab(tabIds[active]);
  }

  const clickHandlers = [];
  tabIds.forEach((id, i) => {
    const tab = tabs[i];
    if (!tab) return;
    const onClick = () => selectPhoneTab(id);
    tab.addEventListener('click', onClick);
    clickHandlers.push({ tab, onClick });
  });

  syncTabMode();
  if (query && typeof query.addEventListener === 'function') {
    query.addEventListener('change', syncTabMode);
  } else if (query && typeof query.addListener === 'function') {
    query.addListener(syncTabMode);
  }

  return {
    syncTabMode,
    destroyTabs: () => {
      for (const { tab, onClick } of clickHandlers) {
        tab.removeEventListener('click', onClick);
      }
      if (query && typeof query.removeEventListener === 'function') {
        query.removeEventListener('change', syncTabMode);
      } else if (query && typeof query.removeListener === 'function') {
        query.removeListener(syncTabMode);
      }
    },
  };
}

/**
 * @param {HTMLElement} host
 * @param {object} project buildProjectCockpit shape
 * @param {{ document: Document, now?: number|(() => number), onBack?: () => void, matchMedia?: typeof matchMedia }} deps
 */
export function renderProjectCockpit(host, project, deps) {
  suppressCockpitAutoTour();
  const doc = deps.document;

  while (host.firstChild) host.removeChild(host.firstChild);

  const shell = el(doc, 'div', 'shell cc-cockpit-shell');

  const bandHeader = el(doc, 'header', 'band-header');
  const appNav = el(doc, 'div', 'app-nav');
  appNav.setAttribute('aria-label', 'Swarm Watch chrome');
  appNav.appendChild(el(doc, 'div', 'brand', 'Swarm Watch'));
  const navActions = el(doc, 'div', 'nav-actions');
  const backBtn = el(doc, 'button', 'btn-pill cc-cockpit-back-btn', 'Back');
  backBtn.type = 'button';
  const hiveTab = el(doc, 'a', 'cc-tab', 'Hive');
  hiveTab.href = '/command-center';
  const cockpitTab = el(doc, 'a', 'cc-tab', 'Cockpit');
  cockpitTab.href = globalThis.location?.pathname || '/command-center/project';
  cockpitTab.setAttribute('aria-current', 'page');
  navActions.appendChild(backBtn);
  navActions.appendChild(hiveTab);
  navActions.appendChild(cockpitTab);
  appNav.appendChild(navActions);
  bandHeader.appendChild(appNav);

  const headerHost = el(doc, 'div', 'cc-cockpit-header-host');
  bandHeader.appendChild(headerHost);

  const panel = el(doc, 'main', 'panel-cockpit');
  panel.id = 'cc-cockpit-main';

  const bandMain = el(doc, 'div', 'band-main desktop-only-stage');
  const stageWrap = el(doc, 'section', 'stage-wrap');
  stageWrap.setAttribute('aria-label', 'Ticket flow stage');
  const ticketsLeft = el(doc, 'div', 'ticket-col ticket-col--left');
  ticketsLeft.id = 'tickets-left';
  ticketsLeft.setAttribute('aria-label', 'Queue tickets');
  const stageGrid = el(doc, 'div', 'stage-grid');
  const stageCenter = el(doc, 'div', 'stage-center');
  const entity = el(doc, 'div', 'entity-label');
  const orchTitle = el(doc, 'h2', null, '');
  entity.appendChild(orchTitle);
  stageCenter.appendChild(entity);
  appendMascotStage(stageCenter, doc);
  const nowPanelHost = el(doc, 'div', 'cc-cockpit-now-host');
  stageCenter.appendChild(nowPanelHost);
  const readyHost = el(doc, 'div', 'cc-cockpit-ready-host');
  stageCenter.appendChild(readyHost);
  const ticketsRight = el(doc, 'div', 'ticket-col ticket-col--right');
  ticketsRight.id = 'tickets-right';
  ticketsRight.setAttribute('aria-label', 'Queue tickets continued');
  stageGrid.appendChild(ticketsLeft);
  stageGrid.appendChild(stageCenter);
  stageGrid.appendChild(ticketsRight);
  stageWrap.appendChild(stageGrid);
  bandMain.appendChild(stageWrap);

  const bandBottom = el(doc, 'div', 'band-bottom');
  const bottomLoops = buildBottomLoops(doc);
  bandBottom.appendChild(bottomLoops);

  const workerSection = el(doc, 'section', 'stream-section');
  workerSection.setAttribute('aria-label', 'Worker stream');
  const workerHead = el(doc, 'div', 'stream-head stream-head--worker');
  workerHead.textContent = '// Worker stream / latest finished tickets';
  const workerHost = el(doc, 'div', 'cc-cockpit-worker-stream-host');
  workerSection.appendChild(workerHead);
  workerSection.appendChild(workerHost);

  const streamSection = el(doc, 'section', 'stream-section');
  streamSection.setAttribute('aria-label', 'Run stream');
  const streamHead = el(doc, 'div', 'stream-head stream-head--render');
  streamHead.textContent = '// Run stream / orchestrator activity';
  const streamHost = el(doc, 'div', 'cc-cockpit-run-stream-host stream-grid');
  streamSection.appendChild(streamHead);
  streamSection.appendChild(streamHost);

  const stackBlock = el(doc, 'footer', 'stack-block');
  stackBlock.setAttribute('aria-label', 'Stage stack summary');
  const stackHead = el(doc, 'div', 'stack-head');
  stackHead.appendChild(el(doc, 'div', 'stack-label', 'Stage stack'));
  const stackTitle = el(doc, 'h2', 'stack-title');
  const total = project?.total;
  if (typeof total === 'number' && Number.isFinite(total) && total > 0) {
    const num = el(doc, 'span', 'num', String(total));
    num.title = 'source field: ledger.tickets live total';
    stackTitle.appendChild(num);
    stackTitle.appendChild(doc.createTextNode(' tickets'));
  } else {
    stackTitle.textContent = 'Tickets';
  }
  stackHead.appendChild(stackTitle);
  const stackTilesHost = el(doc, 'div', 'stack-metrics cc-cockpit-stack-tiles');
  const stackFootHost = el(doc, 'div', 'stack-foot');
  stackBlock.appendChild(stackHead);
  stackBlock.appendChild(stackTilesHost);
  stackBlock.appendChild(stackFootHost);

  bandBottom.appendChild(workerSection);
  bandBottom.appendChild(streamSection);
  bandBottom.appendChild(stackBlock);

  const footnote = el(doc, 'footer', 'cockpit-footnote');
  footnote.setAttribute('aria-label', 'Data notes');
  footnote.textContent = 'Live board data — ticket counts match the project ledger.';

  const tabIds = ['now', 'tickets', 'stream', 'stack'];
  const viewTabs = el(doc, 'div', 'view-tabs');
  viewTabs.setAttribute('role', 'tablist');
  viewTabs.setAttribute('aria-label', 'Cockpit panels');
  const tabs = [];
  const phonePanels = [];
  for (let i = 0; i < tabIds.length; i += 1) {
    const id = tabIds[i];
    const tab = el(doc, 'button', null, id.charAt(0).toUpperCase() + id.slice(1));
    tab.type = 'button';
    tab.setAttribute('role', 'tab');
    tab.id = `tab-${id}`;
    tab.setAttribute('aria-controls', `phone-${id}`);
    tab.setAttribute('aria-selected', i === 0 ? 'true' : 'false');
    viewTabs.appendChild(tab);
    tabs.push(tab);
    const phonePanel = el(doc, 'div', 'phone-panel');
    phonePanel.id = `phone-${id}`;
    phonePanel.setAttribute('role', 'tabpanel');
    phonePanel.setAttribute('aria-labelledby', `tab-${id}`);
    phonePanel.dataset.active = i === 0 ? 'true' : 'false';
    phonePanels.push(phonePanel);
  }

  panel.appendChild(viewTabs);
  for (const p of phonePanels) panel.appendChild(p);
  panel.appendChild(bandMain);
  panel.appendChild(bandBottom);
  panel.appendChild(footnote);

  shell.appendChild(bandHeader);
  shell.appendChild(panel);
  host.appendChild(shell);

  let projectRef = project;
  const viewport = { width: 1440, height: 900 };
  const phoneRefs = {
    doc,
    phoneNow: phonePanels[0],
    phoneTickets: phonePanels[1],
    phoneStream: phonePanels[2],
    phoneStack: phonePanels[3],
    stageCenter,
    nowPanelHost,
    readyHost,
    bottomLoops,
    workerSection,
    streamSection,
    stackBlock,
    viewport,
  };
  const tabCtl = bindPhoneTabs(panel, tabs, phonePanels, tabIds, deps.matchMedia);
  const onBackClick = () => {
    if (typeof deps.onBack === 'function') deps.onBack();
  };
  backBtn.addEventListener('click', onBackClick);

  function paint(at) {
    paintCockpitHeader(headerHost, projectRef, deps, at);
    const orch = syncOrchestratorLabel(headerHost, projectRef, at);
    orchTitle.textContent = orch.label;
    paintTicketLists(ticketsLeft, ticketsRight, readyHost, projectRef);
    paintNowPanel(nowPanelHost, projectRef);
    paintWorkerStream(workerHost, projectRef);
    paintRunStream(streamHost, projectRef, at);
    paintStack(stackTilesHost, stackFootHost, projectRef, viewport);
    paintPhonePanels(deps, phoneRefs, projectRef, at);
    tabCtl.syncTabMode();
    const nums = headerHost.querySelector?.('.headline-num');
    if (nums && projectRef) {
      nums.textContent = headlineTicketText(projectRef.done ?? 0, projectRef.total ?? 0);
      nums.title = 'source field: ledger.tickets done / live total';
    }
  }

  const initialAt = nowMs(deps);
  paint(initialAt);

  return {
    update(nextProject) {
      projectRef = nextProject;
      paint(nowMs(deps));
    },
    destroy() {
      backBtn.removeEventListener('click', onBackClick);
      tabCtl.destroyTabs();
      while (host.firstChild) host.removeChild(host.firstChild);
    },
  };
}
