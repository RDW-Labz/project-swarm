// SPDX-License-Identifier: Apache-2.0
/** Mount Command Center Hive view (stat strip, ring, streams, panels) from a snapshot. */

import { renderHiveStatStrip } from './hive-stat-strip.js';
import { layoutHiveProjectNodes, renderHiveLayout } from './hive-layout.js';
import { hiveBrainMotionDescriptor, hiveBrainReducedMotionStillFrame, hiveBrainStateFromEvents } from './hive-brain.js';
import { HIVE_STREAM_FRAME_MS, HIVE_STREAM_RENDER_STATIC, advanceAndDrawHiveStreamComets, buildHiveStreams, drawHiveStreamStaticDots, hiveStreamDensityForProject, hiveStreamsPauseWhenDocumentHidden, hiveStreamsPrefersReducedMotion, hiveStreamsRenderPath } from './hive-streams.js';

let hivePanelsApi = null;

function resolveHivePanels() {
  if (hivePanelsApi) return hivePanelsApi;
  const globalApi = globalThis.HivePanels;
  if (globalApi && typeof globalApi.renderHivePanels === 'function') {
    hivePanelsApi = globalApi;
    return hivePanelsApi;
  }
  throw new Error('HivePanels is not available; load hive-panels.js before cc-hive-mount.js');
}

const STAT_KEYS = ['projectsTotal', 'agentsLive', 'needsYouCount', 'spendUsd'];
const STAT_TONES = { needsYouCount: 'warn' };

function el(doc, tag, cls, text) {
  const n = doc.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

function formatStatValue(field) {
  if (!field || typeof field.value !== 'number') return '';
  if (field.unit === 'usd') return String(field.value);
  return String(field.value);
}

function statStripEntries(stats) {
  const out = [];
  if (!stats || typeof stats !== 'object') return out;
  for (const key of STAT_KEYS) {
    const field = stats[key];
    if (!field || typeof field.source !== 'string' || !field.source.length) continue;
    if (typeof field.label !== 'string' || !field.label.length) continue;
    out.push({
      label: field.label,
      value: formatStatValue(field),
      source: field.source,
      tone: STAT_TONES[key] || undefined,
    });
  }
  return out;
}

function panelModelFromSnapshot(snapshot) {
  const raw = snapshot?.panels;
  if (!raw || typeof raw !== 'object') {
    return {
      journalEvents: [],
      laneCounts: {},
      savingsRows: [],
    };
  }
  return raw;
}

function brainEventsFromSnapshot(snapshot) {
  if (Array.isArray(snapshot?.brainEvents)) return snapshot.brainEvents;
  if (Array.isArray(snapshot?.events)) return snapshot.events;
  return [];
}

function isPhoneLayout(innerWidth) {
  return innerWidth <= 720;
}

/**
 * @param {HTMLElement} host
 * @param {object} snapshot Command Center snapshot (buildCommandCenterSnapshot shape)
 * @param {{
 *   document: Document,
 *   now: () => number,
 *   requestAnimationFrame: (cb: (t: number) => void) => number,
 *   cancelAnimationFrame: (id: number) => void,
 *   matchMedia: (query: string) => { matches: boolean, addEventListener?: Function, removeEventListener?: Function },
 *   onOpenProject: (projectId: string) => void,
 * }} deps
 */
export function renderHive(host, snapshot, deps) {
  const doc = deps.document;
  const win = doc.defaultView || globalThis;

  while (host.firstChild) host.removeChild(host.firstChild);

  const shell = el(doc, 'div', 'hive-shell');
  const chrome = el(doc, 'header', 'hive-chrome');
  const legendEl = el(doc, 'div', 'cc-legend hive-legend');
  chrome.appendChild(legendEl);

  const statStrip = el(doc, 'div', 'hive-stat-strip');
  statStrip.setAttribute('role', 'group');
  statStrip.setAttribute('aria-label', 'Hive summary strip');

  const stage = el(doc, 'section', 'hive-stage');
  stage.setAttribute('aria-label', 'Hive diagram');

  const canvas = el(doc, 'canvas', '');
  canvas.id = 'hive-canvas';
  canvas.setAttribute('aria-hidden', 'true');

  const coreUi = el(doc, 'div', 'hive-core-ui');
  coreUi.id = 'hive-core-ui';
  const coreDisk = el(doc, 'div', 'hive-core-disk');
  const coreInner = el(doc, 'div', 'hive-core-inner');
  coreInner.appendChild(el(doc, 'div', 'hive-core-label', 'the model'));
  coreInner.appendChild(el(doc, 'div', 'hive-core-name', 'opus'));
  const coreStatus = el(doc, 'div', 'hive-core-status', 'waiting');
  coreInner.appendChild(coreStatus);
  coreDisk.appendChild(coreInner);
  coreUi.appendChild(coreDisk);

  const nodesMount = el(doc, 'div', 'hive-nodes');
  nodesMount.id = 'hive-nodes';

  stage.appendChild(canvas);
  stage.appendChild(coreUi);
  stage.appendChild(nodesMount);

  const panelsWrap = el(doc, 'div', 'hive-panels-wrap');
  const panelsRoot = el(doc, 'div', 'cc-panels cc-panels--hive hive-panels');
  const panelLog = el(doc, 'section', 'cc-panel');
  panelLog.appendChild(el(doc, 'h2', null, 'session log'));
  const eventLog = el(doc, 'ul', 'event-log hive-event-log');
  panelLog.appendChild(eventLog);

  const panelGates = el(doc, 'section', 'cc-panel');
  panelGates.appendChild(el(doc, 'h2', null, 'lanes and savings'));
  const lanesPanel = el(doc, 'div', '');
  panelGates.appendChild(lanesPanel);

  const panelSaved = el(doc, 'section', 'cc-panel');
  panelSaved.appendChild(el(doc, 'h2', null, 'throughput'));
  const savingsPanel = el(doc, 'div', '');
  panelSaved.appendChild(savingsPanel);

  panelsRoot.appendChild(panelLog);
  panelsRoot.appendChild(panelGates);
  panelsRoot.appendChild(panelSaved);
  panelsWrap.appendChild(panelsRoot);

  shell.appendChild(chrome);
  shell.appendChild(statStrip);
  shell.appendChild(stage);
  shell.appendChild(panelsWrap);
  host.appendChild(shell);

  let snapshotRef = snapshot;
  let rafId = 0;
  let lastFrame = 0;
  let geomCache = null;
  const particles = [];
  const cardCleanups = [];
  const listeners = [];

  const reducedMotionMq = deps.matchMedia('(prefers-reduced-motion: reduce)');

  function addListener(target, type, handler, options) {
    target.addEventListener(type, handler, options);
    listeners.push({ target, type, handler, options });
  }

  function prefersReducedMotion() {
    return hiveStreamsPrefersReducedMotion(reducedMotionMq);
  }

  function documentHidden() {
    return hiveStreamsPauseWhenDocumentHidden(doc);
  }

  function renderPath() {
    return hiveStreamsRenderPath({
      reducedMotion: prefersReducedMotion(),
      documentHidden: documentHidden(),
      userPaused: false,
    });
  }

  function applyBrain() {
    const state = hiveBrainStateFromEvents(brainEventsFromSnapshot(snapshotRef), deps.now());
    const reduced = prefersReducedMotion();
    const frame = reduced
      ? hiveBrainReducedMotionStillFrame(state)
      : { ...hiveBrainReducedMotionStillFrame(state) };

    coreDisk.className = frame.coreClass;
    coreStatus.className = frame.statusClass || 'hive-core-status';
    coreStatus.textContent = frame.statusText || 'waiting';

    coreDisk.style.animation = '';
    if (!reduced) {
      const motion = hiveBrainMotionDescriptor(state);
      if (motion?.animation) {
        coreDisk.style.animation = `${motion.animation} 2.4s ease-in-out ${motion.loop ? 'infinite' : '1'}`;
      }
    }
  }

  function clearCardHandlers() {
    while (cardCleanups.length) {
      const fn = cardCleanups.pop();
      if (typeof fn === 'function') fn();
    }
  }

  function wireProjectCard(cardEl, projectId) {
    if (!cardEl || !projectId) return;
    cardEl.tabIndex = 0;
    cardEl.setAttribute('role', 'button');
    const open = () => {
      if (typeof deps.onOpenProject === 'function') deps.onOpenProject(projectId);
    };
    const onKey = (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        open();
      }
    };
    cardEl.addEventListener('click', open);
    cardEl.addEventListener('keydown', onKey);
    cardCleanups.push(() => {
      cardEl.removeEventListener('click', open);
      cardEl.removeEventListener('keydown', onKey);
    });
  }

  function paintDom(snapshotData) {
    renderHiveStatStrip(statStrip, statStripEntries(snapshotData.stats));
    const projects = Array.isArray(snapshotData.projects) ? snapshotData.projects.slice(0, 10) : [];
    renderHiveLayout(shell, projects, { legendEl, nodesMount, stageEl: stage });
    layoutHiveProjectNodes(nodesMount);
    clearCardHandlers();
    for (let i = 0; i < (nodesMount.children || []).length; i += 1) {
      const card = nodesMount.children[i];
      const project = projects[i];
      if (card && project?.id) {
        card.dataset.projectId = project.id;
        wireProjectCard(card, project.id);
      }
    }
    applyBrain();
    const { renderHivePanels } = resolveHivePanels();
    renderHivePanels(
      { eventLog, lanes: panelGates, savings: panelSaved },
      panelModelFromSnapshot(snapshotData),
      { nowMs: deps.now() },
    );
  }

  function layoutNodes() {
    const stageRect = stage.getBoundingClientRect?.() || { width: 800, height: 600, left: 0, top: 0 };
    const w = stageRect.width || 800;
    const h = stageRect.height || 600;
    const phone = isPhoneLayout(win.innerWidth ?? 1024);
    if (stage.classList) stage.classList.toggle('hive-phone', phone);

    layoutHiveProjectNodes(nodesMount);

    const stageBox = stage.getBoundingClientRect?.() || stageRect;
    const coreRect = coreUi.getBoundingClientRect?.() || {
      left: stageBox.left + w * 0.5 - 80,
      top: stageBox.top + h * 0.5 - 80,
      width: 160,
      height: 160,
    };
    const cx = coreRect.left - stageBox.left + coreRect.width / 2;
    const cy = coreRect.top - stageBox.top + coreRect.height / 2;
    const ringR = coreRect.width / 2;

    const nodeEntries = [];
    const children = nodesMount.children || [];
    for (let i = 0; i < children.length; i += 1) {
      const card = children[i];
      const box = card.getBoundingClientRect?.() || {
        left: 0,
        top: i * 40,
        right: 120,
        bottom: (i + 1) * 40,
        width: 120,
        height: 40,
      };
      const cxCard = box.left - stageBox.left + (box.width || 0) / 2;
      const cyCard = box.top - stageBox.top + (box.height || 0) / 2;
      const project = (snapshotRef.projects || [])[i];
      nodeEntries.push({
        node: { lane: project?.lane, side: card.dataset?.side },
        side: card.dataset?.side,
        angle: Math.atan2(cy - cyCard, cx - cxCard),
        box: {
          left: box.left - stageBox.left,
          top: box.top - stageBox.top,
          right: (box.right ?? box.left + box.width) - stageBox.left,
          bottom: (box.bottom ?? box.top + box.height) - stageBox.top,
          width: box.width || 0,
          height: box.height || 0,
        },
        x: cxCard,
        y: cyCard,
      });
    }

    geomCache = { cx, cy, ringR, w, h, phone, nodeEntries };
    return geomCache;
  }

  function resizeCanvas() {
    const dpr = Math.min(win.devicePixelRatio || 1, 2);
    const rect = stage.getBoundingClientRect?.() || { width: 800, height: 600 };
    const width = rect.width || 800;
    const height = rect.height || 600;
    canvas.width = Math.floor(width * dpr);
    canvas.height = Math.floor(height * dpr);
    if (canvas.style) {
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
    }
    const ctx = canvas.getContext?.('2d');
    if (ctx?.setTransform) ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    layoutNodes();
  }

  function drawGuidePaths(ctx, streams) {
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (const s of streams) {
      const rgb = s.rgb;
      ctx.strokeStyle = `rgba(${rgb[0]},${rgb[1]},${rgb[2]},0.1)`;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(s.from.x, s.from.y);
      ctx.quadraticCurveTo(s.ctrl.x, s.ctrl.y, s.to.x, s.to.y);
      ctx.stroke();
    }
    ctx.restore();
  }

  function drawStreamsFrame(forceStatic) {
    const ctx = canvas.getContext?.('2d');
    if (!ctx) return;
    const geom = geomCache || layoutNodes();
    const rect = stage.getBoundingClientRect?.() || { width: geom.w, height: geom.h };
    ctx.clearRect(0, 0, rect.width || geom.w, rect.height || geom.h);

    const streams = buildHiveStreams(geom.nodeEntries, geom);
    drawGuidePaths(ctx, streams);

    const path = forceStatic ? HIVE_STREAM_RENDER_STATIC : renderPath();
    if (path === HIVE_STREAM_RENDER_STATIC) {
      drawHiveStreamStaticDots(ctx, streams);
      return;
    }

    const projects = (snapshotRef.projects || []).slice(0, 10);
    let targetPerStream = hiveStreamDensityForProject(null);
    for (const p of projects) {
      targetPerStream = Math.max(targetPerStream, hiveStreamDensityForProject(p));
    }
    const tph = snapshotRef.throughputTicketsPerHour ?? 0;
    advanceAndDrawHiveStreamComets(ctx, streams, particles, targetPerStream, tph);
  }

  function drawFrame(now, forceStill) {
    drawStreamsFrame(Boolean(forceStill));
  }

  function scheduleFrame() {
    deps.cancelAnimationFrame(rafId);
    rafId = deps.requestAnimationFrame(tick);
  }

  function shouldAnimate() {
    return renderPath() !== HIVE_STREAM_RENDER_STATIC;
  }

  function tick(now) {
    if (!shouldAnimate()) {
      drawFrame(now, true);
      return;
    }
    if (now - lastFrame >= HIVE_STREAM_FRAME_MS) {
      lastFrame = now;
      layoutNodes();
      drawFrame(now, false);
    }
    rafId = deps.requestAnimationFrame(tick);
  }

  function onVisibilityChange() {
    if (documentHidden()) {
      deps.cancelAnimationFrame(rafId);
      rafId = 0;
      drawFrame(deps.now(), true);
    } else if (shouldAnimate()) {
      scheduleFrame();
    }
  }

  function onReducedMotionChange() {
    applyBrain();
    if (shouldAnimate()) scheduleFrame();
    else {
      deps.cancelAnimationFrame(rafId);
      rafId = 0;
      drawFrame(deps.now(), true);
    }
  }

  function onResize() {
    resizeCanvas();
    drawFrame(deps.now(), !shouldAnimate());
    if (shouldAnimate()) scheduleFrame();
  }

  paintDom(snapshotRef);
  resizeCanvas();

  addListener(doc, 'visibilitychange', onVisibilityChange);
  if (reducedMotionMq?.addEventListener) {
    addListener(reducedMotionMq, 'change', onReducedMotionChange);
  }
  addListener(win, 'resize', onResize);

  if (shouldAnimate()) scheduleFrame();
  else drawFrame(deps.now(), true);

  return {
    update(nextSnapshot) {
      snapshotRef = nextSnapshot;
      paintDom(snapshotRef);
      layoutNodes();
      drawFrame(deps.now(), !shouldAnimate());
      if (shouldAnimate() && !rafId) scheduleFrame();
    },
    destroy() {
      deps.cancelAnimationFrame(rafId);
      rafId = 0;
      clearCardHandlers();
      for (const l of listeners) {
        l.target.removeEventListener(l.type, l.handler, l.options);
      }
      listeners.length = 0;
      while (host.firstChild) host.removeChild(host.firstChild);
    },
  };
}
