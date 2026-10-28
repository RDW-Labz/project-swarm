// SPDX-License-Identifier: Apache-2.0
// Command Center cockpit: ticket list + stack summary tiles from ledger-shaped data.

/** @typedef {{ ticketToQueueJob: (t: object) => object|null, listQueueJobsForProject: (jobs: object[], project: object) => object[] }} QueueDeps */

/** Styles live in /assets/cc-cockpit.css — kept for tests that reference layout constants. */
export const COCKPIT_LISTS_CSS = '';

const byId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * Same job rows `swarm queue list` would show for this ledger snapshot.
 * @param {object|null|undefined} ledger
 * @param {object} projectConfig
 * @param {QueueDeps} queueDeps
 */
export function queueVisibleJobs(ledger, projectConfig, queueDeps) {
  if (!queueDeps?.ticketToQueueJob || !queueDeps?.listQueueJobsForProject) {
    throw new Error('queueVisibleJobs requires ticketToQueueJob and listQueueJobsForProject');
  }
  const tickets = ledger?.tickets ?? [];
  const jobs = tickets.map(queueDeps.ticketToQueueJob).filter(Boolean);
  const visible = queueDeps.listQueueJobsForProject(jobs, projectConfig ?? {});
  return [...visible].sort(byId);
}

/**
 * @param {object|null|undefined} ledger
 * @param {(tickets: object[]) => object[]} readyTicketsFn
 */
export function emptyReadyExplanation(ledger, readyTicketsFn) {
  const tickets = ledger?.tickets ?? [];
  const ready = typeof readyTicketsFn === 'function' ? readyTicketsFn(tickets) : [];
  if (ready.length > 0) return null;
  const done = new Set(tickets.filter(t => t.status === 'done').map(t => t.id));
  let blockedOnDeps = 0;
  for (const t of tickets) {
    if (t.status === 'cancelled' || t.status === 'proposed' || t.status === 'done') continue;
    const waiting = (t.dependsOn ?? []).filter(d => !done.has(d));
    if (waiting.length) blockedOnDeps += 1;
  }
  if (blockedOnDeps > 0) {
    return `No ready tickets — ${blockedOnDeps} blocked on dependencies`;
  }
  const running = tickets.filter(t => t.status === 'running').length;
  if (running > 0) {
    return `No ready tickets — ${running} still running`;
  }
  return 'No ready tickets — none are runnable yet';
}

function ensureStyle(host, id, css) {
  if (!css) return;
  const doc = host.ownerDocument || (typeof document !== 'undefined' ? document : null);
  if (!doc) return;
  const head = doc.head || doc.documentElement;
  if (!head) return;
  let el = doc.getElementById?.(id);
  if (!el && doc.createElement) {
    el = doc.createElement('style');
    el.id = id;
    el.textContent = css;
    head.appendChild(el);
  }
}

function ledgerTicketById(ledger, id) {
  return (ledger?.tickets ?? []).find(t => t.id === id);
}

function ticketIdxModifier(ticket) {
  const stage = ticket?.stage;
  const name = typeof stage === 'string' ? stage.toLowerCase() : '';
  if (name.includes('opus') || name.includes('s1')) return 'ticket-idx--opus';
  if (name.includes('skill')) return 'ticket-idx--skills';
  if (name.includes('engine')) return 'ticket-idx--engines';
  if (name.includes('taste')) return 'ticket-idx--taste';
  if (name.includes('broll') || name.includes('b-roll')) return 'ticket-idx--broll';
  if (name.includes('web')) return 'ticket-idx--web';
  if (ticket?.status === 'done') return 'ticket-idx--taste';
  if (ticket?.status === 'blocked') return 'ticket-idx--broll';
  if (ticket?.status === 'running') return 'ticket-idx--engines';
  return 'ticket-idx--pending';
}

function formatQueueIndex(index) {
  const n = index + 1;
  return (n < 10 ? '0' : '') + String(n);
}

function ticketRowMark(doc, status) {
  const mark = doc.createElement('span');
  mark.className = 'ticket-mark';
  if (status === 'done') {
    mark.innerHTML = '<svg class="ticket-check" viewBox="0 0 12 12" focusable="false" aria-hidden="true"><path d="M2.5 6.2 5 8.7 9.5 3.3" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="square"/></svg>';
  } else if (status === 'running') {
    const live = doc.createElement('span');
    live.className = 'ticket-mark--live';
    mark.appendChild(live);
  } else {
    mark.setAttribute('aria-hidden', 'true');
  }
  return mark;
}

function ticketRowStateClass(status) {
  if (status === 'running') return 'active';
  if (status === 'done') return 'done';
  if (status === 'blocked') return 'pending';
  return 'pending';
}

function buildTicketRow(doc, job, full, queueIndex) {
  const status = full?.status || job.status || 'todo';
  const stateClass = ticketRowStateClass(status);
  const row = doc.createElement('button');
  row.type = 'button';
  row.className = `ticket-row cockpit-ticket-row ticket-row--${stateClass}`;
  row.setAttribute('data-ticket-id', job.id);
  const repoKey = String(full?.title || job.id).toLowerCase();
  row.setAttribute('data-repo', repoKey);
  row.setAttribute('aria-label', `${full?.title || job.id}, ${status}`);
  const idx = doc.createElement('span');
  idx.className = `ticket-idx num ${ticketIdxModifier(full)}`;
  idx.textContent = formatQueueIndex(queueIndex);
  const main = doc.createElement('span');
  main.className = 'ticket-main';
  const title = doc.createElement('span');
  title.className = 'ticket-name cockpit-ticket-title';
  title.textContent = full?.title || job.id;
  main.appendChild(title);
  if (full?.stage) {
    const sub = doc.createElement('span');
    sub.className = 'ticket-sub';
    sub.textContent = String(full.stage);
    main.appendChild(sub);
  }
  const badge = doc.createElement('span');
  badge.className = 'ticket-badge cockpit-ticket-status';
  badge.textContent = status;
  row.appendChild(idx);
  row.appendChild(main);
  row.appendChild(badge);
  row.appendChild(ticketRowMark(doc, status));
  return row;
}

/**
 * @param {HTMLElement|{ appendChild: Function, ownerDocument?: object }} host
 * @param {object|null|undefined} ledger
 * @param {{ projectConfig?: object, queueDeps: QueueDeps, filterQuery?: string, sliceStart?: number, sliceEnd?: number, showSearch?: boolean }} options
 */
export function renderCockpitTicketList(host, ledger, options = {}) {
  const {
    projectConfig = {},
    queueDeps,
    filterQuery = '',
    sliceStart = 0,
    sliceEnd,
    showSearch = true,
  } = options;
  ensureStyle(host, 'cockpit-lists-css', COCKPIT_LISTS_CSS);
  while (host.firstChild) host.removeChild(host.firstChild);

  const doc = host.ownerDocument;
  if (!doc?.createElement) return;

  if (showSearch) {
    const search = doc.createElement('div');
    search.className = 'ticket-search cockpit-ticket-search';
    const label = doc.createElement('label');
    label.textContent = 'Search tickets';
    const input = doc.createElement('input');
    input.type = 'search';
    input.placeholder = 'Filter by id or title';
    input.value = filterQuery;
    search.appendChild(label);
    search.appendChild(input);
    host.appendChild(search);
  }

  const col = doc.createElement('div');
  col.className = 'ticket-col cockpit-ticket-col';
  col.setAttribute('data-cockpit-ticket-list', 'true');

  const allJobs = queueVisibleJobs(ledger, projectConfig, queueDeps);
  const end = sliceEnd == null ? allJobs.length : Math.min(allJobs.length, sliceEnd);
  const jobs = allJobs.slice(sliceStart, end);
  const q = String(filterQuery || '').trim().toLowerCase();

  if (!jobs.length) {
    const empty = doc.createElement('p');
    empty.className = 'cockpit-ticket-empty cc-empty';
    empty.setAttribute('data-cockpit-empty', 'queue');
    empty.textContent = 'No tickets in this column';
    col.appendChild(empty);
  } else {
    for (let i = 0; i < jobs.length; i += 1) {
      const job = jobs[i];
      const full = ledgerTicketById(ledger, job.id);
      const title = full?.title || job.id;
      const hay = `${job.id} ${title}`.toLowerCase();
      if (q && !hay.includes(q)) continue;
      const row = buildTicketRow(doc, job, full, sliceStart + i);
      if (q) row.setAttribute('data-hidden', 'false');
      col.appendChild(row);
    }
  }

  host.appendChild(col);

  if (showSearch) {
    const input = host.querySelector?.('input[type="search"]')
      || (host.children?.[0]?.querySelector && host.children[0].querySelector('input[type="search"]'));
    const searchRoot = host;
    if (input && typeof input.addEventListener === 'function') {
      const applyFilter = () => {
        const query = String(input.value || '').trim().toLowerCase();
        const rows = searchRoot.querySelectorAll
          ? Array.from(searchRoot.querySelectorAll('.ticket-row'))
          : [];
        for (const row of rows) {
          const repo = row.getAttribute?.('data-repo') || '';
          const id = row.getAttribute?.('data-ticket-id') || '';
          const show = !query || repo.includes(query) || id.toLowerCase().includes(query);
          row.setAttribute('data-hidden', show ? 'false' : 'true');
        }
      };
      input.addEventListener('input', applyFilter);
      applyFilter();
    }
  }
}

/**
 * @param {HTMLElement|{ appendChild: Function }} host
 * @param {Array<{ id?: string, title: string, status?: string, body?: string, pct?: number, accent?: string }>} items
 */
export function renderWorkerStream(host, items) {
  ensureStyle(host, 'cockpit-lists-css', COCKPIT_LISTS_CSS);
  while (host.firstChild) host.removeChild(host.firstChild);
  const doc = host.ownerDocument;
  if (!doc?.createElement) return;
  const grid = doc.createElement('div');
  grid.className = 'stream-grid';
  grid.setAttribute('data-cockpit-worker-stream', 'true');
  const list = Array.isArray(items) ? items : [];
  if (!list.length) {
    const empty = doc.createElement('p');
    empty.className = 'cc-empty';
    empty.textContent = 'No finished tickets yet';
    grid.appendChild(empty);
  } else {
    for (const item of list) {
      const accent = item.accent || 'stream-card--accent-teal';
      const card = doc.createElement('article');
      card.className = `stream-card ${accent}`;
      const top = doc.createElement('div');
      top.className = 'stream-top';
      if (item.id) {
        const idEl = doc.createElement('span');
        idEl.className = 'stream-id num';
        idEl.textContent = item.id;
        top.appendChild(idEl);
      }
      const titleEl = doc.createElement('span');
      titleEl.className = 'stream-title';
      titleEl.textContent = item.title || '';
      top.appendChild(titleEl);
      if (item.status) {
        const st = doc.createElement('span');
        st.className = 'stream-status';
        st.textContent = item.status;
        top.appendChild(st);
      }
      card.appendChild(top);
      if (item.body) {
        const meta = doc.createElement('span');
        meta.className = 'stream-meta';
        meta.textContent = item.body;
        card.appendChild(meta);
      }
      const bar = doc.createElement('div');
      bar.className = 'stream-bar';
      const fill = doc.createElement('span');
      const pct = typeof item.pct === 'number' ? item.pct : 100;
      if (fill.style && typeof fill.style.setProperty === 'function') {
        fill.style.setProperty('--pct', `${pct}%`);
      }
      bar.appendChild(fill);
      card.appendChild(bar);
      grid.appendChild(card);
    }
  }
  host.appendChild(grid);
}

/**
 * Orchestrator run stream cards (mockup .stream-top layout).
 * @param {HTMLElement|{ appendChild: Function }} host
 * @param {Array<{ id?: string, title?: string, status?: string, body?: string, pct?: number, accent?: string }>} items
 */
export function renderOrchestratorRunStream(host, items) {
  ensureStyle(host, 'cockpit-lists-css', COCKPIT_LISTS_CSS);
  while (host.firstChild) host.removeChild(host.firstChild);
  const doc = host.ownerDocument;
  if (!doc?.createElement) return;
  const grid = doc.createElement('div');
  grid.className = 'stream-grid';
  grid.setAttribute('data-cockpit-run-stream', 'true');
  const list = Array.isArray(items) ? items : [];
  if (!list.length) {
    const empty = doc.createElement('p');
    empty.className = 'cc-empty';
    empty.textContent = 'No runs yet';
    grid.appendChild(empty);
  } else {
    for (const item of list) {
      const accent = item.accent || 'stream-card--accent-teal';
      const card = doc.createElement('article');
      card.className = `stream-card cockpit-run-stream-item ${accent}`;
      const top = doc.createElement('div');
      top.className = 'stream-top';
      if (item.id) {
        const idEl = doc.createElement('span');
        idEl.className = 'stream-id num';
        idEl.textContent = item.id;
        top.appendChild(idEl);
      }
      const titleEl = doc.createElement('span');
      titleEl.className = 'stream-title';
      const statusText = item.status || item.title || '';
      let displayTitle = item.title || '';
      if (statusText && displayTitle.toLowerCase() === String(statusText).toLowerCase()) {
        displayTitle = item.id || displayTitle;
      }
      titleEl.textContent = displayTitle;
      top.appendChild(titleEl);
      if (statusText) {
        const st = doc.createElement('span');
        st.className = 'stream-status';
        st.textContent = statusText;
        top.appendChild(st);
      }
      card.appendChild(top);
      if (item.body) {
        const meta = doc.createElement('span');
        meta.className = 'stream-meta cockpit-run-stream-body';
        meta.textContent = item.body;
        card.appendChild(meta);
      }
      const bar = doc.createElement('div');
      bar.className = 'stream-bar';
      const fill = doc.createElement('span');
      const pct = typeof item.pct === 'number' ? item.pct : 70;
      if (fill.style && typeof fill.style.setProperty === 'function') {
        fill.style.setProperty('--pct', `${pct}%`);
      }
      bar.appendChild(fill);
      card.appendChild(bar);
      grid.appendChild(card);
    }
  }
  host.appendChild(grid);
}

export function workerStreamFromLedger(ledger, limit = 4) {
  const tickets = (ledger?.tickets ?? []).filter(t => t.status === 'done');
  tickets.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const slice = tickets.slice(-limit).reverse();
  return slice.map(t => ({
    id: t.id,
    title: t.title || t.id,
    status: 'Done',
    body: t.stage ? `Stage ${t.stage}` : 'Finished',
    pct: 100,
    accent: 'stream-card--accent-teal',
  }));
}

/**
 * @param {HTMLElement|{ appendChild: Function }} host
 * @param {Array<{ label: string, value: string|number, footnote: string, variant?: string }>} tiles
 */
export function renderStackSummaryTiles(host, tiles) {
  ensureStyle(host, 'cockpit-lists-css', COCKPIT_LISTS_CSS);
  while (host.firstChild) host.removeChild(host.firstChild);
  const doc = host.ownerDocument;
  if (!doc?.createElement) return;
  const grid = doc.createElement('div');
  grid.className = 'stack-metrics cockpit-stack-metrics';
  grid.setAttribute('data-cockpit-summary-tiles', 'true');
  for (const tile of tiles) {
    const variant = tile.variant ? ` metric-tile--${tile.variant} cockpit-metric-tile--${tile.variant}` : '';
    const el = doc.createElement('div');
    el.className = `metric-tile cockpit-metric-tile${variant}`;
    const label = doc.createElement('span');
    label.className = 'm-label';
    label.textContent = tile.label;
    const val = doc.createElement('span');
    val.className = 'm-val num';
    val.textContent = String(tile.value);
    const foot = doc.createElement('span');
    foot.className = 'm-foot';
    foot.textContent = tile.footnote;
    el.appendChild(label);
    el.appendChild(val);
    el.appendChild(foot);
    grid.appendChild(el);
  }
  host.appendChild(grid);
}

function clampCss(minPx, preferredVh, maxPx, viewportHeight) {
  const vhPx = (preferredVh / 100) * viewportHeight;
  return Math.min(maxPx, Math.max(minPx, vhPx));
}

/**
 * Deterministic layout boxes for summary tiles (matches COCKPIT_LISTS_CSS spacing).
 * @param {{ width: number, height: number }} viewport
 * @param {{ label: string, value: string|number, footnote: string }} tile
 */
export function summaryTileLayoutBoxes(viewport, tile) {
  const width = Math.max(64, (viewport?.width ?? 360) / 3 - 8);
  const padTop = 8;
  const padBottom = 10;
  const padX = 6;
  const labelH = 12;
  const labelGap = 2;
  const valH = clampCss(28, 2.8, 32, viewport?.height ?? 800);
  const valMargin = 4;
  const footPad = 2;
  const footH = 11;
  let y = padTop;
  const label = { top: y, bottom: y + labelH, left: padX, right: width - padX };
  y += labelH + labelGap;
  const numeral = { top: y, bottom: y + valH, left: padX, right: width - padX };
  y += valH + valMargin;
  const footnote = { top: y + footPad, bottom: y + footPad + footH, left: padX, right: width - padX };
  const totalH = footnote.bottom + padBottom;
  return { label, numeral, footnote, width, height: totalH, tile };
}

export function boxesOverlap(a, b) {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

/**
 * Apply layout rects to a rendered metric tile for getBoundingClientRect checks.
 * @param {object} tileRoot
 * @param {{ width: number, height: number }} viewport
 */
export function layoutSummaryTileElement(tileRoot, viewport) {
  if (!tileRoot?.children?.length) return;
  const label = Array.from(tileRoot.children).find(c => c.classList?.contains('m-label'));
  const val = Array.from(tileRoot.children).find(c => c.classList?.contains('m-val'));
  const foot = Array.from(tileRoot.children).find(c => c.classList?.contains('m-foot'));
  const boxes = summaryTileLayoutBoxes(viewport, {
    label: label?.textContent || '',
    value: val?.textContent || '',
    footnote: foot?.textContent || '',
  });
  const assign = (node, box) => {
    if (!node) return;
    node._layout = { ...box, width: box.right - box.left, height: box.bottom - box.top };
  };
  assign(label, boxes.label);
  assign(val, boxes.numeral);
  assign(foot, boxes.footnote);
  tileRoot._layout = { top: 0, bottom: boxes.height, left: 0, right: boxes.width, width: boxes.width, height: boxes.height };
}

export function renderReadyEmptyState(host, ledger, readyTicketsFn) {
  ensureStyle(host, 'cockpit-lists-css', COCKPIT_LISTS_CSS);
  while (host.firstChild) host.removeChild(host.firstChild);
  const doc = host.ownerDocument;
  if (!doc?.createElement) return null;
  const msg = emptyReadyExplanation(ledger, readyTicketsFn);
  const p = doc.createElement('p');
  p.className = 'cockpit-ticket-empty';
  p.setAttribute('data-cockpit-empty', 'ready');
  p.textContent = msg || '';
  host.appendChild(p);
  return msg;
}
