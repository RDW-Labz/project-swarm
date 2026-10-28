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

/**
 * @param {HTMLElement|{ appendChild: Function, ownerDocument?: object }} host
 * @param {object|null|undefined} ledger
 * @param {{ projectConfig?: object, queueDeps: QueueDeps, filterQuery?: string }} options
 */
export function renderCockpitTicketList(host, ledger, options = {}) {
  const { projectConfig = {}, queueDeps, filterQuery = '' } = options;
  ensureStyle(host, 'cockpit-lists-css', COCKPIT_LISTS_CSS);
  while (host.firstChild) host.removeChild(host.firstChild);

  const doc = host.ownerDocument;
  if (!doc?.createElement) return;

  const search = doc.createElement('div');
  search.className = 'cockpit-ticket-search';
  const label = doc.createElement('label');
  label.textContent = 'Search tickets';
  const input = doc.createElement('input');
  input.type = 'search';
  input.placeholder = 'Filter by id or title';
  input.value = filterQuery;
  search.appendChild(label);
  search.appendChild(input);
  host.appendChild(search);

  const col = doc.createElement('div');
  col.className = 'cockpit-ticket-col';
  col.setAttribute('data-cockpit-ticket-list', 'true');

  const jobs = queueVisibleJobs(ledger, projectConfig, queueDeps);
  const q = String(filterQuery || '').trim().toLowerCase();

  if (!jobs.length) {
    const empty = doc.createElement('p');
    empty.className = 'cockpit-ticket-empty';
    empty.setAttribute('data-cockpit-empty', 'queue');
    empty.textContent = 'Queue is empty for this project';
    col.appendChild(empty);
  } else {
    for (const job of jobs) {
      const full = ledgerTicketById(ledger, job.id);
      const title = full?.title || job.id;
      const hay = `${job.id} ${title}`.toLowerCase();
      if (q && !hay.includes(q)) continue;
      const row = doc.createElement('div');
      row.className = `ticket-row cockpit-ticket-row ticket-row--${full?.status || job.status || 'todo'}`;
      row.setAttribute('data-ticket-id', job.id);
      const idEl = doc.createElement('span');
      idEl.className = 'cockpit-ticket-id';
      idEl.textContent = job.id;
      const titleEl = doc.createElement('span');
      titleEl.className = 'cockpit-ticket-title';
      titleEl.textContent = title;
      const statusEl = doc.createElement('span');
      statusEl.className = 'cockpit-ticket-status';
      statusEl.textContent = job.status || '';
      row.appendChild(idEl);
      row.appendChild(titleEl);
      row.appendChild(statusEl);
      col.appendChild(row);
    }
  }

  host.appendChild(col);
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
