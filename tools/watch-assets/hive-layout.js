// SPDX-License-Identifier: Apache-2.0
/** Hive command-center project ring layout (node cards + legend). */

export const CARD_GAP_PCT = 1.5;
export const CARD_HEIGHT_PCT = (100 - 4 * CARD_GAP_PCT) / 5;
export const SLOT_TOPS = [0, 1, 2, 3, 4].map((i) => i * (CARD_HEIGHT_PCT + CARD_GAP_PCT));
export const COLUMN_INSET = { 0: 2, 1: 4.5, 2: 7, 3: 4.5, 4: 2 };
export const HIVE_CARD_WIDTH_PCT = 21;

export const HIVE_LANES = ['safety', 'route', 'context', 'control'];

export const HIVE_LANE_CSS_VAR = {
  safety: '--hive-safety',
  route: '--hive-route',
  context: '--hive-context',
  control: '--hive-control',
};

const LANE_GLOW = {
  safety: 'rgba(255, 77, 141, 0.55)',
  route: 'rgba(94, 184, 255, 0.55)',
  context: 'rgba(61, 214, 165, 0.55)',
  control: 'rgba(245, 196, 81, 0.55)',
};

const ROW_KEYS = ['asks', 'out', 'fails'];

function isTrustedSource(source) {
  return typeof source === 'string' && source.length > 0;
}

function formatFieldValue(value) {
  if (value === null || value === undefined) return '';
  return String(value);
}

function normalizeLane(lane) {
  if (typeof lane === 'string' && HIVE_LANES.includes(lane)) return lane;
  return 'control';
}

/**
 * Assign side/slot for up to 10 projects: indices 0–4 left slots 0–4, 5–9 right slots 0–4.
 * @param {Array<object>} projects
 * @returns {Array<object>}
 */
export function assignHiveSideSlots(projects) {
  const list = Array.isArray(projects) ? projects.slice(0, 10) : [];
  return list.map((raw, index) => {
    const project = raw && typeof raw === 'object' ? { ...raw } : {};
    if (project.side !== 'left' && project.side !== 'right') {
      project.side = index < 5 ? 'left' : 'right';
    }
    const slotIndex = index < 5 ? index : index - 5;
    if (project.slot == null || project.slot < 0 || project.slot > 4) {
      project.slot = slotIndex;
    }
    return project;
  });
}

/**
 * Resolved card box in stage percentage coordinates (0–100).
 * @param {'left'|'right'} side
 * @param {number} slot
 */
export function hiveCardBoxPct(side, slot) {
  const inset = COLUMN_INSET[slot] != null ? COLUMN_INSET[slot] : 2;
  const top = SLOT_TOPS[slot] != null ? SLOT_TOPS[slot] : 0;
  const bottom = top + CARD_HEIGHT_PCT;
  if (side === 'left') {
    const left = inset;
    return { left, right: left + HIVE_CARD_WIDTH_PCT, top, bottom };
  }
  const right = inset;
  const left = 100 - inset - HIVE_CARD_WIDTH_PCT;
  return { left, right: 100 - inset, top, bottom };
}

function rectsOverlapPct(a, b) {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

/**
 * Central ring bounds (axis-aligned outer square of .hive-core-ui) in stage % coords.
 * Mirrors shared.css: 40vh box centered at 50%/50% with max-width/height clamps.
 */
export function hiveRingBoxPct(stageWidthPx, stageHeightPx, viewportHeightPx) {
  const vhUnit = viewportHeightPx / 100;
  const coreW = Math.min(40 * vhUnit, 0.52 * stageWidthPx);
  const coreH = Math.min(40 * vhUnit, 0.68 * stageHeightPx);
  const w = Math.min(coreW, coreH);
  const h = w;
  const leftPx = (stageWidthPx - w) / 2;
  const topPx = (stageHeightPx - h) / 2;
  return {
    left: (leftPx / stageWidthPx) * 100,
    right: ((leftPx + w) / stageWidthPx) * 100,
    top: (topPx / stageHeightPx) * 100,
    bottom: ((topPx + h) / stageHeightPx) * 100,
    cx: ((leftPx + w / 2) / stageWidthPx) * 100,
    cy: ((topPx + h / 2) / stageHeightPx) * 100,
    r: (w / 2 / stageWidthPx) * 100,
    rY: (h / 2 / stageHeightPx) * 100,
  };
}

function rectOverlapsCirclePct(box, ring) {
  const r = Math.min(ring.r, ring.rY);
  const cx = ring.cx;
  const cy = ring.cy;
  const closestX = Math.max(box.left, Math.min(cx, box.right));
  const closestY = Math.max(box.top, Math.min(cy, box.bottom));
  const dx = cx - closestX;
  const dy = cy - closestY;
  if (dx * dx + dy * dy < r * r) return true;
  const corners = [
    [box.left, box.top],
    [box.right, box.top],
    [box.left, box.bottom],
    [box.right, box.bottom],
  ];
  for (const [x, y] of corners) {
    const ddx = x - cx;
    const ddy = y - cy;
    if (ddx * ddx + ddy * ddy < r * r) return true;
  }
  return false;
}

function readTrustedField(field) {
  if (!field || typeof field !== 'object') return null;
  if (!isTrustedSource(field.source)) return null;
  return { value: formatFieldValue(field.value), source: field.source };
}

function applyCardLayout(cardEl, side, slot) {
  const inset = COLUMN_INSET[slot] != null ? COLUMN_INSET[slot] : 2;
  cardEl.style.top = `${SLOT_TOPS[slot]}%`;
  cardEl.style.height = `${CARD_HEIGHT_PCT}%`;
  cardEl.style.minHeight = '';
  cardEl.style.maxHeight = '';
  if (side === 'left') {
    cardEl.style.left = `${inset}%`;
    cardEl.style.right = 'auto';
    cardEl.style.width = `${HIVE_CARD_WIDTH_PCT}%`;
  } else {
    cardEl.style.right = `${inset}%`;
    cardEl.style.left = 'auto';
    cardEl.style.width = `${HIVE_CARD_WIDTH_PCT}%`;
  }
}

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

function appendTrustedStat(parent, className, field) {
  const trusted = readTrustedField(field);
  if (!trusted) return;
  const span = el('span', className ? `num ${className}` : 'num', trusted.value);
  span.setAttribute('title', trusted.source);
  parent.appendChild(span);
}

function buildProjectCard(project) {
  const lane = normalizeLane(project.lane);
  const card = el('article', `hive-node ${lane}`);
  card.dataset.side = project.side;
  card.dataset.slot = String(project.slot);
  const labelName = typeof project.name === 'string' && project.name.length
    ? project.name
    : (typeof project.id === 'string' ? project.id : 'project');
  card.setAttribute('aria-label', `Project ${labelName}`);

  const hd = el('div', 'hive-node-hd');
  hd.appendChild(el('span', 'name', labelName));
  const hdStats = el('span', 'hive-hd-stats');
  appendTrustedStat(hdStats, 'pct', project.percentDone);
  appendTrustedStat(hdStats, 'building', project.ticketsBuilding);
  appendTrustedStat(hdStats, 'needs-you', project.needsYou);
  appendTrustedStat(hdStats, 'machine', project.machine);
  if (hdStats.children.length) hd.appendChild(hdStats);
  card.appendChild(hd);

  const bd = el('div', 'hive-node-bd');
  const dl = el('dl', 'hive-kv');
  for (const key of ROW_KEYS) {
    const trusted = readTrustedField(project[key]);
    const dt = el('dt', null, key);
    dl.appendChild(dt);
    const dd = el('dd', 'num', trusted ? trusted.value : '');
    if (trusted) dd.setAttribute('title', trusted.source);
    dl.appendChild(dd);
  }
  bd.appendChild(dl);

  const meterField = project.meter;
  if (meterField && typeof meterField === 'object' && Number.isFinite(meterField.value)) {
    const meter = el('div', 'hive-meter');
    const meterLabel = typeof meterField.label === 'string' && meterField.label.length
      ? meterField.label
      : 'done';
    meter.appendChild(el('span', null, meterLabel));
    const track = el('span', 'track');
    const fill = el('i', 'fill');
    const pct = Math.max(0, Math.min(100, meterField.value));
    fill.style.width = `${pct}%`;
    track.appendChild(fill);
    meter.appendChild(track);
    const val = el('span', 'num', `${pct}%`);
    if (isTrustedSource(meterField.source)) val.setAttribute('title', meterField.source);
    meter.appendChild(val);
    bd.appendChild(meter);
  }

  card.appendChild(bd);
  card.style.setProperty('--card-glow', LANE_GLOW[lane]);
  return card;
}

/**
 * @param {HTMLElement} legendContainer Host for `.cc-legend.hive-legend`
 */
export function renderHiveLegend(legendContainer) {
  if (!legendContainer) return;
  legendContainer.className = 'cc-legend hive-legend';
  legendContainer.setAttribute('aria-label', 'Node lane colours');
  while (legendContainer.firstChild) legendContainer.removeChild(legendContainer.firstChild);

  for (const lane of HIVE_LANES) {
    const row = el('span');
    const swatch = el('i');
    swatch.style.background = `var(${HIVE_LANE_CSS_VAR[lane]})`;
    row.appendChild(swatch);
    row.appendChild(document.createTextNode(lane));
    legendContainer.appendChild(row);
  }
}

/**
 * @param {HTMLElement} nodesMount `#hive-nodes` or `.hive-nodes`
 * @param {Array<object>} projects Up to 10 project records
 * @returns {Array<{ project: object, el: HTMLElement }>}
 */
export function renderHiveProjectNodes(nodesMount, projects) {
  if (!nodesMount) return [];
  while (nodesMount.firstChild) nodesMount.removeChild(nodesMount.firstChild);

  const placed = assignHiveSideSlots(projects);
  const nodeEls = [];
  for (const project of placed) {
    const card = buildProjectCard(project);
    applyCardLayout(card, project.side, project.slot);
    nodesMount.appendChild(card);
    nodeEls.push({ project, el: card });
  }
  return nodeEls;
}

/**
 * Re-apply bowed-column layout (desktop ring view).
 * @param {HTMLElement} nodesMount
 */
export function layoutHiveProjectNodes(nodesMount) {
  if (!nodesMount) return;
  for (const card of nodesMount.children || []) {
    if (!card || !card.dataset) continue;
    const side = card.dataset.side === 'right' ? 'right' : 'left';
    const slot = Number(card.dataset.slot);
    if (!Number.isFinite(slot)) continue;
    applyCardLayout(card, side, slot);
  }
}

/**
 * @param {HTMLElement} container Stage shell: renders legend (optional child) + nodes mount
 * @param {Array<object>} projects
 * @param {{ legendEl?: HTMLElement, nodesMount?: HTMLElement, stageEl?: HTMLElement }} [options]
 */
export function renderHiveLayout(container, projects, options = {}) {
  const opts = options || {};
  const legendEl = opts.legendEl || (container && container.querySelector
    ? container.querySelector('.hive-legend')
    : null);
  const nodesMount = opts.nodesMount || (container && container.querySelector
    ? container.querySelector('.hive-nodes, #hive-nodes')
    : null);
  const stageEl = opts.stageEl || container;

  if (legendEl) renderHiveLegend(legendEl);
  const nodes = renderHiveProjectNodes(nodesMount, projects);
  if (nodesMount) layoutHiveProjectNodes(nodesMount);
  return { nodes, stageEl, nodesMount, legendEl };
}

/** Minimum card inner content height (px) for meter visibility — from mockup shared.css sizes. */
export const HIVE_CARD_MIN_CONTENT_PX = 102;

/**
 * Assert layout geometry for tests: no card overlap, no ring overlap.
 */
export function assertHiveLayoutGeometry(stageWidthPx, stageHeightPx, viewportHeightPx, projects) {
  const placed = assignHiveSideSlots(projects);
  const boxes = placed.map((p) => hiveCardBoxPct(p.side, p.slot));
  for (let i = 0; i < boxes.length; i += 1) {
    for (let j = i + 1; j < boxes.length; j += 1) {
      if (rectsOverlapPct(boxes[i], boxes[j])) {
        throw new Error(`hive cards ${i} and ${j} overlap`);
      }
    }
  }
  const ring = hiveRingBoxPct(stageWidthPx, stageHeightPx, viewportHeightPx);
  for (let i = 0; i < boxes.length; i += 1) {
    if (rectOverlapsCirclePct(boxes[i], ring)) {
      throw new Error(`hive card ${i} overlaps central ring`);
    }
  }
  const cardHeightPx = (CARD_HEIGHT_PCT / 100) * stageHeightPx;
  if (cardHeightPx < HIVE_CARD_MIN_CONTENT_PX) {
    throw new Error('hive card height too small for meter at this stage height');
  }
  return { boxes, ring, cardHeightPx };
}
