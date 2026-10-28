// SPDX-License-Identifier: Apache-2.0
// Command Center cockpit lists: ticket cards, worker stream and stack tiles from ledger-shaped data.
// Markup follows the owner-approved artifact (docs/design/reference/command-center-artifact); styles live in /assets/cc-cockpit.css.

/** @typedef {{ ticketToQueueJob: (t: object) => object|null, listQueueJobsForProject: (jobs: object[], project: object) => object[] }} QueueDeps */

/** Styles live in /assets/cc-cockpit.css; kept as an empty export for callers that still import it. */
export const COCKPIT_LISTS_CSS = '';

/** Stage colours: stage "S<n>" takes colour n mod 7 (the artifact's SC palette). */
export const STAGE_COLOURS = ['#2fe0a0', '#4d7cff', '#ffb62e', '#a98bff', '#ff4d7e', '#4ccce6', '#58627a'];
const GLYPH = { ready: '▶', running: '▶', review: '●', blocked: '■', done: '✓' };
const HIDDEN_STATUSES = ['cancelled', 'proposed'];
const STAMP_FIELDS = ['doneAt', 'completedAt', 'finishedAt', 'updatedAt', 'at'];

/** Ledger fields a ticket category is read from, in order: lane, area, type, then stage as the last resort. */
export const CATEGORY_FIELDS = ['lane', 'area', 'type', 'stage'];
/** Fixed colours for common categories; any other name takes a stable colour from CATEGORY_PALETTE by its hash. */
const CATEGORY_COLOURS = {
  build: '#e8795a', feature: '#e8795a', code: '#e8795a',
  test: '#8fc46a', tests: '#8fc46a', qa: '#8fc46a',
  ui: '#5b8ee6', web: '#9aa3b5', frontend: '#5b8ee6', design: '#c58bff',
  fix: '#e0607e', bug: '#e0607e',
  docs: '#d9a26a', doc: '#d9a26a',
  human: '#ffb62e', infra: '#4ccce6', ops: '#4ccce6',
  other: '#7d8aa3',
};
export const CATEGORY_PALETTE = ['#e8795a', '#d9a26a', '#5b8ee6', '#8fc46a', '#e0607e', '#9aa3b5', '#a98bff', '#4ccce6'];

const byId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const byIdDesc = (a, b) => byId(b, a);

/** Stable colour for a category name. */
export function categoryColour(name) {
  const key = String(name || 'other').toLowerCase();
  if (CATEGORY_COLOURS[key]) return CATEGORY_COLOURS[key];
  let h = 0;
  for (let i = 0; i < key.length; i += 1) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  return CATEGORY_PALETTE[h % CATEGORY_PALETTE.length];
}

/** The first category field that splits these tickets into more than one group, else the first one present. */
export function categoryField(tickets) {
  const list = (Array.isArray(tickets) ? tickets : []).filter(Boolean);
  let fallback = null;
  for (const f of CATEGORY_FIELDS) {
    const vals = new Set(list.map(t => t[f]).filter(v => v != null && String(v).trim() !== '').map(v => String(v).trim().toLowerCase()));
    if (vals.size > 1) return f;
    if (vals.size === 1 && !fallback) fallback = f;
  }
  return fallback;
}

/** Category of one ticket by the given field (or its own first present field). */
export function ticketCategory(ticket, field) {
  const fields = field ? [field] : CATEGORY_FIELDS;
  for (const f of fields) {
    const v = ticket?.[f];
    if (v != null && String(v).trim() !== '') return String(v).trim().toLowerCase();
  }
  return 'other';
}

/**
 * Categories of a ledger: the field they come from, names in ticket id order, and a resolver per ticket.
 * @param {object|null|undefined} ledger
 */
export function cockpitCategories(ledger) {
  const live = (ledger?.tickets ?? []).filter(t => t && !HIDDEN_STATUSES.includes(t.status));
  const field = categoryField(live);
  const of = t => ticketCategory(t, field);
  const names = [];
  for (const t of [...live].sort(byId)) {
    const n = of(t);
    if (!names.includes(n)) names.push(n);
  }
  return { field, names, of, colour: categoryColour };
}

export function setCssVar(node, name, value) {
  const style = node?.style;
  if (!style) return;
  if (typeof style.setProperty === 'function') style.setProperty(name, value);
  else style[name] = value;
}

function clearHost(host) {
  while (host.firstChild) host.removeChild(host.firstChild);
}

function mk(doc, tag, cls, text) {
  const n = doc.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined && text !== null) n.textContent = text;
  return n;
}

/**
 * Pure: a short display name from a long ledger title (leading verb dropped, cut at the first clause break,
 * at most `max` characters on a word edge). The full title stays in data-title and the tooltip.
 */
export function shortTitle(s, max = 29) {
  let t = String(s || '').trim().replace(/^(regression tests for|tests for|tests|add|wire|make|mount|capture|apply|run|keep|measure|register|feed|persist|each|the|a|an)\s+/i, '');
  t = t.split(/\s*[,:;(]\s*|\s+(?:during|so|with|for|after|before|against|into|on|can|from|when|in|to|via|that|without|between|and resumes)\s+/i)[0] || t;
  if (t.length > max) {
    const words = t.split(' ');
    t = '';
    for (const w of words) {
      if ((t ? t.length + 1 : 0) + w.length > max) break;
      t += (t ? ' ' : '') + w;
    }
    t = t || words[0].slice(0, max);
  }
  t = t.replace(/\s+(and|or|the|their|its|of|a)$/i, '');
  return /^[A-Z][a-z]/.test(t) ? t[0].toLowerCase() + t.slice(1) : t;
}

/** "just now", "12 min ago", "5 h ago", "3 d ago". */
export function agoText(ms) {
  const m = Math.round(ms / 60000);
  if (m < 1) return 'just now';
  if (m < 90) return `${m} min ago`;
  if (m < 2880) return `${Math.round(m / 60)} h ago`;
  return `${Math.round(m / 1440)} d ago`;
}

export function stageColour(stage) {
  return STAGE_COLOURS[(parseInt(String(stage ?? '').slice(1), 10) || 0) % STAGE_COLOURS.length];
}

/** ready | running | review | blocked | done: the cockpit's five card states. */
export function ticketState(status) {
  const s = String(status || '').toLowerCase();
  if (s === 'running') return 'running';
  if (s === 'done') return 'done';
  if (s === 'blocked') return 'blocked';
  if (s === 'review') return 'review';
  return 'ready';
}

/** Finish time of a ledger ticket in ms, or null when the ledger does not record one. */
export function ticketStamp(ticket) {
  for (const f of STAMP_FIELDS) {
    const v = ticket?.[f];
    if (v == null || v === '') continue;
    const ms = typeof v === 'number' ? v : Date.parse(String(v));
    if (Number.isFinite(ms)) return ms;
  }
  return null;
}

/** Done tickets, newest first: by recorded finish time when there is one, else by id descending. */
export function recentDone(ledger, limit = 4) {
  const done = (ledger?.tickets ?? []).filter(t => t && t.status === 'done');
  done.sort((a, b) => {
    const sa = ticketStamp(a);
    const sb = ticketStamp(b);
    if (sa != null && sb != null && sa !== sb) return sb - sa;
    if (sa != null && sb == null) return -1;
    if (sa == null && sb != null) return 1;
    return byIdDesc(a, b);
  });
  return done.slice(0, Math.max(0, limit));
}

/**
 * Left column: running tickets then ready ones. Right column: review, blocked, then the latest done.
 * @param {object|null|undefined} ledger
 * @param {(tickets: object[]) => object[]} readyFn
 */
export function cockpitColumns(ledger, readyFn, limits = {}) {
  const { leftMax = 8, rightMax = 8, reviewMax = 3, blockedMax = 3, doneMax = 3 } = limits;
  const tickets = ledger?.tickets ?? [];
  const live = tickets.filter(t => t && !HIDDEN_STATUSES.includes(t.status));
  const known = new Map(tickets.filter(Boolean).map(t => [t.id, t]));
  const ready = (typeof readyFn === 'function' ? readyFn(tickets) : [])
    .map(t => (typeof t === 'string' ? known.get(t) : t))
    .filter(t => t && t.status !== 'running')
    .sort(byId);
  const running = live.filter(t => t.status === 'running').sort(byId);
  const review = live.filter(t => t.status === 'review').sort(byId);
  const blocked = live.filter(t => t.status === 'blocked').sort(byId);
  const left = [
    ...running.map(ticket => ({ ticket, state: 'running' })),
    ...ready.map(ticket => ({ ticket, state: 'ready' })),
  ].slice(0, leftMax);
  const reviewShown = review.slice(0, reviewMax);
  const blockedShown = blocked.slice(0, blockedMax);
  const doneN = Math.max(0, Math.min(doneMax, rightMax - reviewShown.length - blockedShown.length));
  const right = [
    ...reviewShown.map(ticket => ({ ticket, state: 'review' })),
    ...blockedShown.map(ticket => ({ ticket, state: 'blocked' })),
    ...recentDone(ledger, doneN).map(ticket => ({ ticket, state: 'done' })),
  ];
  const doneCount = live.filter(t => t.status === 'done').length;
  const open = live.filter(t => !['done', 'running', 'review', 'blocked'].includes(t.status)).length;
  return {
    left,
    right,
    counts: {
      ready: ready.length,
      running: running.length,
      review: review.length,
      blocked: blocked.length,
      todo: Math.max(0, open - ready.length),
      done: doneCount,
      cancelled: tickets.filter(t => t && t.status === 'cancelled').length,
      proposed: tickets.filter(t => t && t.status === 'proposed').length,
    },
  };
}

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

function ledgerTicketById(ledger, id) {
  return (ledger?.tickets ?? []).find(t => t.id === id);
}

function emptyLine(doc, text, key) {
  const p = mk(doc, 'p', 'cockpit-ticket-empty ck-hint', text);
  if (key) p.setAttribute('data-cockpit-empty', key);
  return p;
}

/**
 * One ticket card (`.tk`): index chip, short name, id and stage line, state glyph and category tag.
 * The category colour (--cat-color) paints the chip, the left border and the tag; the active row gets `.active` and an ON chip.
 */
function buildTicketCard(doc, ticket, state, i, n, side, hot, category, active) {
  const full = String(ticket.title || ticket.id).replace(/"/g, '');
  const off = Math.min(30, 10 * Math.min(i, n - 1 - i));
  const card = mk(doc, 'div', `tk${hot ? ' hot' : ''}${active ? ' active' : ''}`);
  card.setAttribute('data-ticket-id', ticket.id);
  card.setAttribute('data-status', state);
  card.setAttribute('data-title', full);
  card.setAttribute('data-category', category);
  setCssVar(card, '--cat-color', categoryColour(category));
  if (side === 'R') {
    card.style.marginRight = `${off}px`;
    card.style.marginLeft = `${36 - off}px`;
  } else {
    card.style.marginLeft = `${off}px`;
    card.style.marginRight = `${36 - off}px`;
  }
  card.appendChild(mk(doc, 'span', 'no', String(i + 1).padStart(2, '0')));
  const tx = mk(doc, 'div', 'tx has-tip');
  tx.setAttribute('tabindex', '0');
  tx.setAttribute('data-tip', `${ticket.id}: ${full}`);
  const nm = mk(doc, 'div', 'nm', shortTitle(full));
  nm.setAttribute('data-id', ticket.id);
  nm.setAttribute('data-title', full);
  tx.appendChild(nm);
  tx.appendChild(mk(doc, 'div', 'sb', `${ticket.id}${ticket.stage ? ` · ${ticket.stage}` : ''}${ticket.sensitive ? ' · sensitive' : ''}`));
  card.appendChild(tx);
  const rt = mk(doc, 'div', 'rt');
  const glyph = mk(doc, 'b', active ? 'on' : `g-${state}`, active ? 'ON' : (GLYPH[state] || GLYPH.ready));
  glyph.setAttribute('title', state);
  glyph.setAttribute('aria-label', state);
  rt.appendChild(glyph);
  rt.appendChild(mk(doc, 'span', 'tag', category === 'other' ? '—' : category.toUpperCase()));
  card.appendChild(rt);
  return card;
}

/**
 * @param {HTMLElement} host a column element
 * @param {Array<{ ticket: object, state: string }>} entries
 * @param {{ side?: 'L'|'R', emptyText?: string, activeId?: string|null, categoryOf?: (t: object) => string }} [options]
 */
export function renderTicketColumn(host, entries, options = {}) {
  const { side = 'L', emptyText, activeId = null } = options;
  const categoryOf = typeof options.categoryOf === 'function' ? options.categoryOf : t => ticketCategory(t);
  clearHost(host);
  const doc = host.ownerDocument;
  if (!doc?.createElement) return;
  const list = Array.isArray(entries) ? entries : [];
  list.forEach((e, i) => {
    const active = activeId != null && e.ticket.id === activeId;
    host.appendChild(buildTicketCard(doc, e.ticket, e.state, i, list.length, side, side === 'R' && i === 0, categoryOf(e.ticket), active));
  });
  if (!list.length && emptyText) host.appendChild(emptyLine(doc, emptyText, 'column'));
}

/**
 * Every queue job of the ledger as ticket cards, in `swarm queue list` order.
 * @param {HTMLElement} host
 * @param {object|null|undefined} ledger
 * @param {{ projectConfig?: object, queueDeps: QueueDeps, side?: 'L'|'R' }} options
 */
export function renderCockpitTicketList(host, ledger, options = {}) {
  const { projectConfig = {}, queueDeps, side = 'L' } = options;
  clearHost(host);
  const doc = host.ownerDocument;
  if (!doc?.createElement) return;
  const jobs = queueVisibleJobs(ledger, projectConfig, queueDeps);
  if (!jobs.length) {
    host.appendChild(emptyLine(doc, 'No tickets in this column', 'queue'));
    return;
  }
  const cats = cockpitCategories(ledger);
  jobs.forEach((job, i) => {
    const full = ledgerTicketById(ledger, job.id) ?? { id: job.id, title: job.id };
    host.appendChild(buildTicketCard(doc, full, ticketState(full.status || job.status), i, jobs.length, side, false, cats.of(full), false));
  });
}

/**
 * Latest finished tickets as worker-stream cards.
 * @param {object|null|undefined} ledger
 * @param {number} nowMs
 */
export function workerCards(ledger, nowMs, limit = 4) {
  const cats = cockpitCategories(ledger);
  return recentDone(ledger, limit).map((t, i) => {
    const at = ticketStamp(t);
    const category = cats.of(t);
    return {
      id: t.id,
      title: String(t.title || t.id),
      stage: t.stage || '',
      ago: at == null ? '' : agoText(nowMs - at),
      pct: at == null ? 100 : Math.round(100 * Math.max(0.08, 1 - (nowMs - at) / 864e5)),
      tag: i === 0 ? 'NEWEST' : 'DONE',
      category,
      color: categoryColour(category),
    };
  });
}

/**
 * @param {HTMLElement} host `.wgrid`
 * @param {ReturnType<typeof workerCards>} cards
 */
export function renderWorkerCards(host, cards) {
  clearHost(host);
  const doc = host.ownerDocument;
  if (!doc?.createElement) return;
  host.setAttribute('data-cockpit-worker-stream', 'true');
  if (!cards.length) {
    host.appendChild(mk(doc, 'p', 'ck-hint', 'No finished tickets yet.'));
    return;
  }
  cards.forEach((c, i) => {
    const full = c.title.replace(/"/g, '');
    const wc = mk(doc, 'div', i === 0 ? 'wc new' : 'wc');
    setCssVar(wc, '--c', c.color);
    wc.setAttribute('data-title', full);
    wc.setAttribute('title', `${c.id}: ${full}`);
    const a = mk(doc, 'div', 'a');
    a.appendChild(mk(doc, 'span', 'id', c.id));
    a.appendChild(mk(doc, 'span', 'ti', shortTitle(full)));
    a.appendChild(mk(doc, 'span', 'tg', c.tag));
    wc.appendChild(a);
    const b = mk(doc, 'div', 'b');
    const when = mk(doc, 'span');
    when.appendChild(mk(doc, 'em', null, 'FINISHED >'));
    when.appendChild(mk(doc, 'span', null, c.ago || (c.stage ? `stage ${c.stage}` : 'time not recorded')));
    b.appendChild(when);
    const bar = mk(doc, 'i');
    const fill = mk(doc, 'u');
    fill.style.width = `${c.pct}%`;
    bar.appendChild(fill);
    b.appendChild(bar);
    wc.appendChild(b);
    host.appendChild(wc);
  });
}

/**
 * Run-stream cards (same card look as the worker stream), one per orchestrator run.
 * @param {HTMLElement} host `.wgrid`
 * @param {Array<{ id?: string, fullId?: string, title?: string, status?: string, body?: string }>} items
 */
export function renderRunCards(host, items) {
  clearHost(host);
  const doc = host.ownerDocument;
  if (!doc?.createElement) return;
  host.setAttribute('data-cockpit-run-stream', 'true');
  const list = Array.isArray(items) ? items : [];
  if (!list.length) {
    host.appendChild(mk(doc, 'p', 'ck-hint', 'No runs yet.'));
    return;
  }
  list.forEach((item, i) => {
    const status = String(item.status || item.title || 'run');
    const key = status.toLowerCase();
    const color = /fail|error/.test(key) ? '#ff4d7e' : /run|live|work/.test(key) ? '#2fe0a0' : '#4d7cff';
    const wc = mk(doc, 'div', i === 0 ? 'wc new cockpit-run-stream-item' : 'wc cockpit-run-stream-item');
    setCssVar(wc, '--c', color);
    if (item.fullId) wc.setAttribute('title', String(item.fullId));
    const a = mk(doc, 'div', 'a');
    a.appendChild(mk(doc, 'span', 'id', item.id ? String(item.id) : 'run'));
    a.appendChild(mk(doc, 'span', 'ti', status));
    a.appendChild(mk(doc, 'span', 'tg', 'RUN'));
    wc.appendChild(a);
    const b = mk(doc, 'div', 'b');
    const body = mk(doc, 'span');
    body.appendChild(mk(doc, 'em', null, 'JOBS >'));
    body.appendChild(mk(doc, 'span', 'cockpit-run-stream-body', item.body ? String(item.body) : 'no job count'));
    b.appendChild(body);
    const m = typeof item.body === 'string' ? item.body.match(/(\d+)\s*\/\s*(\d+)/) : null;
    if (m && Number(m[2]) > 0) {
      const bar = mk(doc, 'i');
      const fill = mk(doc, 'u');
      fill.style.width = `${Math.min(100, Math.round((100 * Number(m[1])) / Number(m[2])))}%`;
      bar.appendChild(fill);
      b.appendChild(bar);
    }
    wc.appendChild(b);
    host.appendChild(wc);
  });
}

/**
 * Stack tiles. `color` is the tile accent, `hi` marks the biggest tile; `footnote` is spoken, not drawn.
 * @param {HTMLElement} host
 * @param {Array<{ label: string, value: string|number, footnote?: string, color?: string, hi?: boolean }>} tiles
 */
export function renderStackSummaryTiles(host, tiles) {
  clearHost(host);
  const doc = host.ownerDocument;
  if (!doc?.createElement) return;
  const grid = mk(doc, 'div', 'tiles cockpit-stack-metrics');
  grid.setAttribute('data-cockpit-summary-tiles', 'true');
  for (const tile of tiles) {
    const el = mk(doc, 'div', `tile cockpit-metric-tile${tile.hi ? ' hi' : ''}`);
    setCssVar(el, '--c', tile.color || '#4d7cff');
    el.appendChild(mk(doc, 'small', 'm-label', String(tile.label).toUpperCase()));
    el.appendChild(mk(doc, 'b', 'm-val', String(tile.value)));
    if (tile.footnote) el.appendChild(mk(doc, 'span', 'm-foot', tile.footnote));
    grid.appendChild(el);
  }
  host.appendChild(grid);
}

function clampCss(minPx, preferredVh, maxPx, viewportHeight) {
  const vhPx = (preferredVh / 100) * viewportHeight;
  return Math.min(maxPx, Math.max(minPx, vhPx));
}

/**
 * Deterministic layout boxes for summary tiles (label above numeral above footnote).
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
  const valH = clampCss(24, 2.8, 32, viewport?.height ?? 800);
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
  clearHost(host);
  const doc = host.ownerDocument;
  if (!doc?.createElement) return null;
  const msg = emptyReadyExplanation(ledger, readyTicketsFn);
  host.appendChild(emptyLine(doc, msg || '', 'ready'));
  return msg;
}
