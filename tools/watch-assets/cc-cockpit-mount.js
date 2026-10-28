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

function paintRunStream(host, project) {
  const items = Array.isArray(project?.runStream) ? project.runStream : [];
  renderRunStream(host, items);
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

function paintPhonePanels(deps, refs, project) {
  const {
    doc,
    phoneNow,
    phoneTickets,
    phoneStream,
    phoneStack,
    stageCenter,
    streamSection,
    stackBlock,
    viewport,
  } = refs;

  for (const panel of [phoneNow, phoneTickets, phoneStream, phoneStack]) {
    if (panel) while (panel.firstChild) panel.removeChild(panel.firstChild);
  }

  if (!phoneLayoutOn(deps.matchMedia)) return;
  if (phoneNow && stageCenter) {
    const nowStage = safeClone(stageCenter, true);
    if (nowStage) {
      nowStage.classList.add('stage-center--phone');
      phoneNow.appendChild(nowStage);
    }
  }
  if (phoneTickets) {
    const wrap = el(doc, 'div', 'stage-wrap stage-wrap--phone');
    wrap.setAttribute('aria-label', 'Ticket list');
    const grid = el(doc, 'div', 'stage-grid');
    grid.style.gridTemplateColumns = '1fr';
    const col = el(doc, 'div', 'ticket-col ticket-col--phone');
    renderCockpitTicketList(col, project?.ledger ?? { tickets: [] }, {
      projectConfig: { id: project?.id },
      queueDeps,
    });
    grid.appendChild(col);
    wrap.appendChild(grid);
    phoneTickets.appendChild(wrap);
  }
  if (phoneStream && streamSection) {
    const clone = safeClone(streamSection, true);
    if (clone) {
      clone.classList.add('stream-section--phone');
      phoneStream.appendChild(clone);
    }
  }
  if (phoneStack && stackBlock) {
    const clone = safeClone(stackBlock, true);
    if (clone) {
      clone.classList.add('stack-block--phone');
      const tilesHost = clone.querySelector?.('.cc-cockpit-stack-tiles');
      if (tilesHost) {
        const tiles = stackSummaryTiles(project);
        const forRender = tiles.map(({ label, value, footnote, variant }) => ({
          label,
          value,
          footnote,
          variant,
        }));
        renderStackSummaryTiles(tilesHost, forRender);
        const rendered = tilesHost.querySelectorAll
          ? Array.from(tilesHost.querySelectorAll('.cockpit-metric-tile'))
          : [];
        for (const tile of rendered) {
          layoutSummaryTileElement(tile, viewport);
        }
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
  const stackTilesHost = el(doc, 'div', 'stack-metrics cc-cockpit-stack-tiles');
  const stackFootHost = el(doc, 'div', 'stack-foot');
  stackBlock.appendChild(stackHead);
  stackBlock.appendChild(stackTilesHost);
  stackBlock.appendChild(stackFootHost);

  bandBottom.appendChild(streamSection);
  bandBottom.appendChild(stackBlock);

  const tabIds = ['now', 'tickets', 'stream', 'stack'];
  const viewTabs = el(doc, 'div', 'view-tabs');
  viewTabs.setAttribute('role', 'tablist');
  viewTabs.setAttribute('aria-label', 'Cockpit panels');
  const tabs = [];
  const phonePanels = [];
  for (let i = 0; i < tabIds.length; i++) {
    const id = tabIds[i];
    const tab = el(doc, 'button', null, id.charAt(0).toUpperCase() + id.slice(1));
    tab.type = 'button';
    tab.setAttribute('role', 'tab');
    tab.id = `tab-${id}`;
    tab.setAttribute('aria-controls', `phone-${id}`);
    tab.setAttribute('aria-selected', i === 0 ? 'true' : 'false');
    viewTabs.appendChild(tab);
    tabs.push(tab);
    const panel = el(doc, 'div', 'phone-panel');
    panel.id = `phone-${id}`;
    panel.setAttribute('role', 'tabpanel');
    panel.setAttribute('aria-labelledby', `tab-${id}`);
    panel.dataset.active = i === 0 ? 'true' : 'false';
    phonePanels.push(panel);
  }

  panel.appendChild(viewTabs);
  for (const p of phonePanels) panel.appendChild(p);
  panel.appendChild(bandHeader);
  panel.appendChild(bandMain);
  panel.appendChild(bandBottom);
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
    paintTicketLists(ticketsLeft, ticketsRight, projectRef);
    paintRunStream(streamHost, projectRef);
    paintStack(stackTilesHost, stackFootHost, projectRef, viewport);
    paintPhonePanels(deps, phoneRefs, projectRef);
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
