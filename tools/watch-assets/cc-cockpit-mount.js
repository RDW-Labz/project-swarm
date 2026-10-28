// SPDX-License-Identifier: Apache-2.0
/** Mount Command Center project Cockpit from buildProjectCockpit snapshot data. */

import { ticketToQueueJob, listQueueJobsForProject, readyTickets } from './cc-ledger-browser.js';
import { renderCockpit, headlineTicketText, stageRingProgress } from './cockpit-view.js';
import { cockpitOrchestratorState, cockpitOrchestratorFromSessions } from './cockpit-orchestrator.js';
import { renderCockpitTicketList, renderStackSummaryTiles, renderReadyEmptyState, layoutSummaryTileElement } from './cockpit-lists.js';
import { renderRunStream } from './cockpit-run-stream.js';

const queueDeps = { ticketToQueueJob, listQueueJobsForProject };

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

/** @param {object} project buildProjectCockpit row */
function stackSummaryTiles(project) {
  const ledger = project?.ledger;
  const rings = stageRingProgress(ledger);
  const tiles = [];
  for (const ring of rings) {
    const source = `ledgerStats.byStage.${ring.id}`;
    if (!ring.total) continue;
    tiles.push({
      label: ring.label,
      value: ring.done,
      footnote: `${ring.done} of ${ring.total} done in stage`,
      variant: undefined,
      source,
    });
  }
  const overall = project?.progress?.overall;
  if (typeof overall === 'number' && Number.isFinite(overall)) {
    tiles.unshift({
      label: 'Done',
      value: `${Math.round(overall)}%`,
      footnote: 'Overall build progress from the project ledger',
      variant: 'taste',
      source: 'progress.overall',
    });
  }
  return tiles.filter(t => typeof t.source === 'string' && t.source.length);
}

function stackFootnote(project) {
  const name = project?.name ?? project?.meta?.project;
  if (!name) return '';
  return String(name);
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
}

function paintTicketLists(leftHost, rightHost, project) {
  const ledger = project?.ledger ?? { tickets: [] };
  const projectConfig = { id: project?.id };
  renderCockpitTicketList(leftHost, ledger, { projectConfig, queueDeps });
  while (rightHost.firstChild) rightHost.removeChild(rightHost.firstChild);
  const ready = readyTickets(ledger.tickets ?? []);
  if (!ready.length) {
    renderReadyEmptyState(rightHost, ledger, readyTickets);
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
  const rendered = stackTilesHost.querySelectorAll?.('.cockpit-metric-tile') ?? [];
  for (const tile of rendered) {
    layoutSummaryTileElement(tile, viewport);
  }
  while (stackFootHost.firstChild) stackFootHost.removeChild(stackFootHost.firstChild);
  const foot = stackFootnote(project);
  if (foot) stackFootHost.appendChild(el(stackFootHost.ownerDocument, 'span', 'stack-foot-note', foot));
}

function paintRunStream(host, project) {
  const items = Array.isArray(project?.runStream) ? project.runStream : [];
  renderRunStream(host, items);
}

/**
 * @param {HTMLElement} host
 * @param {object} project buildProjectCockpit shape
 * @param {{ document: Document, now?: number|(() => number), onBack?: () => void }} deps
 */
export function renderProjectCockpit(host, project, deps) {
  const doc = deps.document;

  while (host.firstChild) host.removeChild(host.firstChild);

  const shell = el(doc, 'div', 'shell cc-cockpit-shell');
  const panel = el(doc, 'main', 'panel-cockpit');
  panel.id = 'cc-cockpit-main';

  const bandHeader = el(doc, 'header', 'band-header');
  const backNav = el(doc, 'nav', 'cockpit-nav cc-cockpit-back');
  backNav.setAttribute('aria-label', 'Cockpit navigation');
  const backBtn = el(doc, 'button', 'btn-pill cc-cockpit-back-btn', 'Back');
  backBtn.type = 'button';
  const crumb = el(doc, 'span', 'nav-block');
  crumb.appendChild(el(doc, 'span', 'num-label', 'project'));
  const crumbName = project?.meta?.project ?? project?.name ?? project?.id ?? '';
  if (crumbName) crumb.appendChild(doc.createTextNode(` ${crumbName}`));
  backNav.appendChild(backBtn);
  backNav.appendChild(crumb);

  const headerHost = el(doc, 'div', 'cc-cockpit-header-host');
  bandHeader.appendChild(backNav);
  bandHeader.appendChild(headerHost);

  const bandMain = el(doc, 'div', 'band-main desktop-only-stage');
  const stageWrap = el(doc, 'section', 'stage-wrap');
  stageWrap.setAttribute('aria-label', 'Ticket flow stage');
  const stageGrid = el(doc, 'div', 'stage-grid');
  const ticketsLeft = el(doc, 'div', 'ticket-col ticket-col--left');
  ticketsLeft.setAttribute('aria-label', 'Queue tickets');
  const stageCenter = el(doc, 'div', 'stage-center');
  const entity = el(doc, 'div', 'entity-label');
  const orchTitle = el(doc, 'h2', null, '');
  entity.appendChild(orchTitle);
  stageCenter.appendChild(entity);
  const ticketsRight = el(doc, 'div', 'ticket-col ticket-col--right');
  ticketsRight.setAttribute('aria-label', 'Ready tickets');
  stageGrid.appendChild(ticketsLeft);
  stageGrid.appendChild(stageCenter);
  stageGrid.appendChild(ticketsRight);
  stageWrap.appendChild(stageGrid);
  bandMain.appendChild(stageWrap);

  const bandBottom = el(doc, 'div', 'band-bottom');
  const streamSection = el(doc, 'section', 'stream-section');
  streamSection.setAttribute('aria-label', 'Run stream');
  const streamHead = el(doc, 'div', 'stream-head stream-head--worker');
  streamHead.textContent = '// Run stream / latest worker activity';
  const streamHost = el(doc, 'div', 'cc-cockpit-run-stream-host');
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
  const stackTilesHost = el(doc, 'div', 'cc-cockpit-stack-tiles');
  const stackFootHost = el(doc, 'div', 'stack-foot');
  stackBlock.appendChild(stackHead);
  stackBlock.appendChild(stackTilesHost);
  stackBlock.appendChild(stackFootHost);

  bandBottom.appendChild(streamSection);
  bandBottom.appendChild(stackBlock);

  panel.appendChild(bandHeader);
  panel.appendChild(bandMain);
  panel.appendChild(bandBottom);
  shell.appendChild(panel);
  host.appendChild(shell);

  let projectRef = project;
  const viewport = { width: 1440, height: 900 };
  const onBackClick = () => {
    if (typeof deps.onBack === 'function') deps.onBack();
  };
  backBtn.addEventListener('click', onBackClick);

  function paint(at) {
    paintCockpitHeader(headerHost, projectRef, deps, at);
    const orch = syncOrchestratorLabel(headerHost, projectRef, at);
    orchTitle.textContent = orch.label;
    paintTicketLists(ticketsLeft, ticketsRight, projectRef);
    paintRunStream(streamHost, projectRef);
    paintStack(stackTilesHost, stackFootHost, projectRef, viewport);
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
      while (host.firstChild) host.removeChild(host.firstChild);
    },
  };
}
