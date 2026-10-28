// SPDX-License-Identifier: Apache-2.0
/** Mount Command Center Hive view (stat strip, ring, streams, panels) from a snapshot. */

import { renderHiveStatStrip } from './hive-stat-strip.js';
import { renderHiveLayout, HIVE_LANES } from './hive-layout.js';
import { hiveBrainMotionDescriptor, hiveBrainReducedMotionStillFrame, hiveBrainStateFromEvents } from './hive-brain.js';
import { HIVE_STREAM_FRAME_MS, HIVE_STREAM_RENDER_STATIC, advanceAndDrawHiveStreamComets, buildHiveStreams, drawHiveStreamStaticDots, hiveStreamDensityForProject, hiveStreamsPauseWhenDocumentHidden, hiveStreamsPrefersReducedMotion, hiveStreamsRenderPath } from './hive-streams.js';
import { hasCompleted, isTourDisabledByQuery, startTour } from './cc-tour.js';

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

function appendCoreRingSvg(doc, coreUi) {
  const svg = el(doc, 'svg', 'hive-ring-text');
  svg.setAttribute('viewBox', '0 0 200 200');
  svg.setAttribute('aria-hidden', 'true');
  const defs = el(doc, 'defs');
  const path = el(doc, 'path');
  path.id = 'hive-orbit-arc';
  path.setAttribute('fill', 'none');
  path.setAttribute('d', 'M 34 118 A 66 66 0 1 1 166 118');
  defs.appendChild(path);
  svg.appendChild(defs);
  const ticks = el(doc, 'g', 'hive-ring-ticks');
  const circle = el(doc, 'circle');
  circle.setAttribute('cx', '100');
  circle.setAttribute('cy', '100');
  circle.setAttribute('r', '78');
  circle.setAttribute('fill', 'none');
  circle.setAttribute('stroke', 'rgba(255,255,255,0.14)');
  circle.setAttribute('stroke-width', '1');
  circle.setAttribute('stroke-dasharray', '4 7');
  ticks.appendChild(circle);
  svg.appendChild(ticks);
  const label = el(doc, 'text', 'hive-orbit-label');
  const textPath = el(doc, 'textPath');
  textPath.setAttribute('href', '#hive-orbit-arc');
  if (typeof textPath.setAttributeNS === 'function') {
    textPath.setAttributeNS('http://www.w3.org/1999/xlink', 'href', '#hive-orbit-arc');
  }
  textPath.setAttribute('startOffset', '4%');
  textPath.textContent = 'answer before you spend';
  label.appendChild(textPath);
  svg.appendChild(label);
  coreUi.appendChild(svg);
}

function buildHiveChrome(doc, legendEl, firstProjectId, onTourHelp) {
  const chromeTop = el(doc, 'div', 'hive-chrome-top');
  const brand = el(doc, 'h1', 'cc-brand brand-glitch hive-brand');
  brand.setAttribute('aria-label', 'Command Center Hive');
  brand.appendChild(el(doc, 'span', 'jev', 'jev'));
  brand.appendChild(el(doc, 'span', 'plus', ' + '));
  brand.appendChild(el(doc, 'span', 'opus', 'opus'));
  chromeTop.appendChild(brand);

  const nav = el(doc, 'nav', 'cc-nav hive-nav');
  nav.setAttribute('role', 'tablist');
  nav.setAttribute('aria-label', 'Command Center views');
  const hiveTab = el(doc, 'a', 'cc-tab', 'Hive');
  hiveTab.setAttribute('role', 'tab');
  hiveTab.setAttribute('aria-current', 'page');
  hiveTab.href = '/command-center';
  nav.appendChild(hiveTab);
  if (firstProjectId) {
    const cockpitTab = el(doc, 'a', 'cc-tab', 'Cockpit');
    cockpitTab.setAttribute('role', 'tab');
    cockpitTab.setAttribute('data-tour', 'cockpit');
    cockpitTab.href = `/command-center/project/${encodeURIComponent(firstProjectId)}`;
    nav.appendChild(cockpitTab);
  }
  const liveChip = el(doc, 'div', 'cc-live');
  liveChip.setAttribute('role', 'status');
  liveChip.appendChild(el(doc, 'span', 'dot'));
  liveChip.appendChild(el(doc, 'span', 'cc-live-label', 'live'));
  const liveCount = el(doc, 'span', 'cc-live-n');
  liveChip.appendChild(liveCount);
  nav.appendChild(liveChip);
  const helpBtn = el(doc, 'button', 'cc-btn cc-tour-help');
  helpBtn.type = 'button';
  helpBtn.setAttribute('aria-label', 'Command Center tour');
  helpBtn.textContent = '?';
  if (typeof onTourHelp === 'function') {
    helpBtn.addEventListener('click', onTourHelp);
  }
  nav.appendChild(helpBtn);
  const pauseBtn = el(doc, 'button', 'cc-btn');
  pauseBtn.type = 'button';
  pauseBtn.id = 'pause-motion';
  pauseBtn.setAttribute('aria-pressed', 'false');
  pauseBtn.innerHTML = 'Pause motion <kbd>p</kbd>';
  nav.appendChild(pauseBtn);
  chromeTop.appendChild(nav);

  return { chromeTop, pauseBtn, brand, helpBtn, liveChip, liveCount };
}

function formatStatValue(field) {
  if (!field || typeof field.value !== 'number') return '';
  if (field.unit === 'usd') return resolveHivePanels().formatUsd(field.value);
  return String(field.value);
}

/** Entries for the stat strip, each carrying its key and raw field so trend pills can be added after render. */
function statStripEntries(stats) {
  const out = [];
  if (!stats || typeof stats !== 'object') return out;
  for (const key of STAT_KEYS) {
    const field = stats[key];
    if (!field || typeof field.source !== 'string' || !field.source.length) continue;
    if (typeof field.label !== 'string' || !field.label.length) continue;
    out.push({
      key,
      field,
      entry: {
        label: field.label,
        value: formatStatValue(field),
        source: field.source,
        tone: STAT_TONES[key] || undefined,
      },
    });
  }
  return out;
}

function trendCount(n, one, many) {
  return `${n} ${n === 1 ? one : many}`;
}

function formatDelta(n) {
  const rounded = Math.round(n * 100) / 100;
  return `${rounded > 0 ? '+' : ''}${rounded}`;
}

/** Trend pill text from real board data: change since the page opened, else a context line. */
function statTrend(key, field, projects, baseline) {
  const panels = resolveHivePanels();
  const value = field.value;
  if (baseline != null && baseline !== value) {
    const diff = value - baseline;
    const worse = key === 'needsYouCount' ? diff > 0 : false;
    return { text: `${formatDelta(diff)} since open`, tone: worse ? 'warn' : 'ok' };
  }
  const list = Array.isArray(projects) ? projects : [];
  if (key === 'projectsTotal') {
    const active = list.filter((p) => panels.projectSignals(p).live > 0).length;
    return active > 0
      ? { text: `${active} active`, tone: 'ok' }
      : { text: 'none active', tone: 'muted' };
  }
  if (key === 'agentsLive') {
    const hosts = list.filter((p) => panels.projectSignals(p).live > 0).length;
    return value > 0
      ? { text: `in ${trendCount(hosts, 'project', 'projects')}`, tone: 'ok' }
      : { text: 'idle', tone: 'muted' };
  }
  if (key === 'needsYouCount') {
    const waiting = list.filter((p) => panels.projectSignals(p).needs > 0).length;
    return value > 0
      ? { text: `${trendCount(waiting, 'project', 'projects')} waiting`, tone: 'warn' }
      : { text: 'all clear', tone: 'ok' };
  }
  if (key === 'spendUsd' && list.length > 0) {
    return { text: `${panels.formatUsd(value / list.length)}/project`, tone: 'info' };
  }
  return null;
}

function panelModelFromSnapshot(snapshot) {
  const { deriveHivePanelModel } = resolveHivePanels();
  return deriveHivePanelModel(snapshot);
}

function agentsLiveCount(snapshotData) {
  const field = snapshotData?.stats?.agentsLive;
  if (field && typeof field.value === 'number' && Number.isFinite(field.value)) return field.value;
  const panels = resolveHivePanels();
  let sum = 0;
  for (const p of Array.isArray(snapshotData?.projects) ? snapshotData.projects : []) {
    sum += panels.projectSignals(p).live;
  }
  return sum;
}

const CARD_POSITION_PROPS = ['left', 'top', 'right', 'bottom', 'width', 'height', 'transform'];

function syncProjectCardHeader(doc, card, project, index) {
  if (!card || !project) return;
  const panels = resolveHivePanels();
  const lane = panels.laneOfProject(project);
  const status = panels.projectStatus(project);
  for (const l of HIVE_LANES) {
    if (card.classList?.contains(l)) card.classList.remove(l);
  }
  if (card.classList) card.classList.add(lane);
  card.setAttribute('data-lane', lane);
  card.setAttribute('data-status', status.key);
  card.setAttribute('data-attn', status.key === 'failed' || status.key === 'needs' ? '1' : '0');

  let hd = null;
  if (typeof card.querySelector === 'function') {
    hd = card.querySelector('.hive-node-hd');
  }
  if (!hd) {
    const kids = Array.from(card.children || []);
    for (let ci = 0; ci < kids.length; ci += 1) {
      if (kids[ci].classList?.contains('hive-node-hd')) {
        hd = kids[ci];
        break;
      }
    }
  }
  if (!hd) {
    hd = el(doc, 'div', 'hive-node-hd');
    if (typeof card.insertBefore === 'function' && card.firstChild) {
      card.insertBefore(hd, card.firstChild);
    } else {
      card.appendChild(hd);
    }
  } else {
    while (hd.firstChild) hd.removeChild(hd.firstChild);
  }

  hd.appendChild(panels.createProjectBot(project));
  const idx = el(doc, 'span', 'idx', String(index + 1).padStart(2, '0'));
  hd.appendChild(idx);
  const nameText = typeof project.name === 'string' && project.name.length
    ? project.name
    : String(project.id || '');
  hd.appendChild(el(doc, 'span', 'name', nameText));
  hd.appendChild(el(doc, 'span', `tag hive-pill st-${status.key}`, status.label));
}

/**
 * Cards flow in two flex columns (alternating left/right) instead of absolute offsets, so they can
 * never overlap or clip. Link endpoints come from getBoundingClientRect in layoutNodes.
 */
function placeProjectCards(doc, nodesMount, cards) {
  const sides = { left: el(doc, 'div', 'hive-side hive-side--left'), right: el(doc, 'div', 'hive-side hive-side--right') };
  sides.left.setAttribute('data-side', 'left');
  sides.right.setAttribute('data-side', 'right');
  const slots = { left: 0, right: 0 };
  for (let i = 0; i < cards.length; i += 1) {
    const card = cards[i];
    const side = i % 2 ? 'right' : 'left';
    if (card.dataset) {
      card.dataset.side = side;
      card.dataset.slot = String(slots[side]);
    }
    slots[side] += 1;
    if (card.style) {
      for (const prop of CARD_POSITION_PROPS) card.style[prop] = '';
    }
    if (card.parentNode && typeof card.parentNode.removeChild === 'function') {
      card.parentNode.removeChild(card);
    }
    sides[side].appendChild(card);
  }
  nodesMount.appendChild(sides.left);
  nodesMount.appendChild(sides.right);
}

function adjustPhoneStreams(streams, geom) {
  if (!geom.phone || !streams?.length) return streams;
  const ringBottomY = geom.cy + geom.ringR * 0.92;
  return streams.map((s) => {
    const to = s.to;
    return {
      ...s,
      from: { x: geom.cx, y: ringBottomY },
      ctrl: {
        x: (geom.cx + to.x) * 0.5 + (to.x - geom.cx) * 0.12,
        y: (ringBottomY + to.y) * 0.45,
      },
      to,
      phone: true,
    };
  });
}

function brainEventsFromSnapshot(snapshot) {
  if (Array.isArray(snapshot?.brainEvents)) return snapshot.brainEvents;
  if (Array.isArray(snapshot?.events)) return snapshot.events;
  return [];
}

function isPhoneLayout(innerWidth) {
  return innerWidth <= 900;
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
  shell.id = 'hive-shell';
  const chrome = el(doc, 'header', 'hive-chrome');
  const legendEl = el(doc, 'div', 'cc-legend hive-legend');
  legendEl.setAttribute('aria-label', 'Node lane colours');
  legendEl.setAttribute('data-tour', 'legend');
  chrome.appendChild(legendEl);

  const statStrip = el(doc, 'div', 'hive-stat-strip');
  statStrip.setAttribute('role', 'group');
  statStrip.setAttribute('aria-label', 'Hive summary strip');

  const stage = el(doc, 'section', 'hive-stage');
  stage.id = 'hive-stage';
  stage.setAttribute('data-tour', 'hive');
  stage.setAttribute('aria-label', 'Hive diagram');

  const canvas = el(doc, 'canvas', '');
  canvas.id = 'hive-canvas';
  canvas.setAttribute('aria-hidden', 'true');

  const coreUi = el(doc, 'div', 'hive-core-ui');
  coreUi.id = 'hive-core-ui';
  appendCoreRingSvg(doc, coreUi);
  const coreDisk = el(doc, 'div', 'hive-core-disk');
  const coreInner = el(doc, 'div', 'hive-core-inner');
  coreInner.appendChild(el(doc, 'div', 'hive-core-label', 'the model'));
  coreInner.appendChild(el(doc, 'div', 'hive-core-name', 'opus'));
  const coreVer = el(doc, 'div', 'hive-core-ver num');
  coreVer.style.display = 'none';
  coreInner.appendChild(coreVer);
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
  const panelNeeds = el(doc, 'section', 'cc-panel hive-needs-panel');
  panelNeeds.setAttribute('aria-labelledby', 'panel-needs');
  const needsHeading = el(doc, 'h2', null, 'needs you');
  needsHeading.id = 'panel-needs';
  const needsCount = el(doc, 'span', 'hive-count');
  needsHeading.appendChild(needsCount);
  panelNeeds.appendChild(needsHeading);
  const needsList = el(doc, 'ul', 'hive-needs-list');
  panelNeeds.appendChild(needsList);

  const panelLog = el(doc, 'section', 'cc-panel');
  panelLog.setAttribute('aria-labelledby', 'panel-log');
  const logHeading = el(doc, 'h2', null, 'session log');
  logHeading.id = 'panel-log';
  panelLog.appendChild(logHeading);
  const eventLog = el(doc, 'ul', 'event-log hive-event-log');
  panelLog.appendChild(eventLog);
  const sessionTerm = el(doc, 'div', 'term-block hive-term-block');
  panelLog.appendChild(sessionTerm);

  const panelGates = el(doc, 'section', 'cc-panel');
  panelGates.setAttribute('aria-labelledby', 'panel-gates');
  const gatesHeading = el(doc, 'h2', null, 'lanes and savings');
  gatesHeading.id = 'panel-gates';
  panelGates.appendChild(gatesHeading);

  const panelSaved = el(doc, 'section', 'cc-panel');
  panelSaved.setAttribute('aria-labelledby', 'panel-saved');
  const savedHeading = el(doc, 'h2', null, 'throughput');
  savedHeading.id = 'panel-saved';
  panelSaved.appendChild(savedHeading);

  panelsRoot.appendChild(panelNeeds);
  panelsRoot.appendChild(panelLog);
  panelsRoot.appendChild(panelGates);
  panelsRoot.appendChild(panelSaved);
  panelsWrap.appendChild(panelsRoot);
  const footer = el(doc, 'footer', 'cc-footer hive-footer');
  footer.appendChild(el(doc, 'span', null, 'command center — live swarm board'));
  const motto = el(doc, 'span', 'motto', 'opus thinks. jev decides. code enforces.');
  footer.appendChild(motto);
  panelsWrap.appendChild(footer);

  shell.appendChild(chrome);
  shell.appendChild(statStrip);
  shell.appendChild(stage);
  shell.appendChild(panelsWrap);
  // Entrance animation plays on first mount only, not on every 5s poll.
  shell.classList.add('is-entering');
  host.appendChild(shell);

  let snapshotRef = snapshot;
  let rafId = 0;
  let lastFrame = 0;
  let geomCache = null;
  let cardEls = [];
  let enterTimer = null;
  const statBaseline = {};
  const particles = [];
  const cardCleanups = [];
  const listeners = [];
  let userPaused = false;
  let pauseBtn = null;
  let chromeTopEl = null;
  let liveChipEl = null;
  let liveCountEl = null;
  let brandEl = null;
  let brandVerEl = null;
  let coreVerEl = coreVer;
  let tourStorage = null;
  let tourUserId = 'anonymous';

  function tourStorageImpl() {
    if (tourStorage) return tourStorage;
    try {
      tourStorage = {
        getItem(k) {
          try {
            return globalThis.localStorage?.getItem(k) ?? null;
          } catch {
            return null;
          }
        },
        setItem(k, v) {
          try {
            globalThis.localStorage?.setItem(k, v);
          } catch {
            // ignore
          }
        },
      };
    } catch {
      tourStorage = { getItem: () => null, setItem: () => {} };
    }
    return tourStorage;
  }

  function openTourFromHelp() {
    if (isTourDisabledByQuery(win.location)) return;
    const storage = tourStorageImpl();
    const completed = hasCompleted(storage, tourUserId);
    startTour({
      doc,
      storage,
      userId: tourUserId,
      replay: completed,
    });
  }

  const reducedMotionMq = deps.matchMedia('(prefers-reduced-motion: reduce)');
  const bodyEl = doc.body;

  function firstProjectId(projects) {
    const list = Array.isArray(projects) ? projects : [];
    for (const p of list) {
      if (p && typeof p.id === 'string' && p.id.length) return p.id;
    }
    return '';
  }

  function modelVersionFromSnapshot(snapshotData) {
    if (!snapshotData || typeof snapshotData !== 'object') return '';
    const hive = snapshotData.hive;
    if (hive && typeof hive.modelVersion === 'string' && hive.modelVersion.length) {
      return hive.modelVersion;
    }
    if (hive && hive.modelVersion != null && typeof hive.modelVersion !== 'object') {
      return String(hive.modelVersion);
    }
    if (typeof snapshotData.modelVersion === 'string' && snapshotData.modelVersion.length) {
      return snapshotData.modelVersion;
    }
    if (snapshotData.modelVersion != null && typeof snapshotData.modelVersion !== 'object') {
      return String(snapshotData.modelVersion);
    }
    return '';
  }

  function syncModelVersion(snapshotData) {
    const ver = modelVersionFromSnapshot(snapshotData);
    if (brandEl) {
      if (!brandVerEl) {
        brandVerEl = brandEl.querySelector?.('.ver-script');
      }
      if (ver) {
        if (!brandVerEl) {
          brandVerEl = el(doc, 'span', 'ver-script num', ver);
          brandEl.appendChild(brandVerEl);
        } else {
          brandVerEl.textContent = ver;
          brandVerEl.style.display = '';
        }
        brandVerEl.setAttribute('title', 'hive.modelVersion');
      } else if (brandVerEl) {
        brandVerEl.textContent = '';
        if (brandVerEl.style) brandVerEl.style.display = 'none';
      }
    }
    if (coreVerEl) {
      if (ver) {
        coreVerEl.textContent = ver;
        coreVerEl.setAttribute('title', 'hive.modelVersion');
        if (coreVerEl.style) coreVerEl.style.display = '';
      } else {
        coreVerEl.textContent = '';
        if (coreVerEl.style) coreVerEl.style.display = 'none';
      }
    }
  }

  function ensureChromeExtras(projects) {
    const pid = firstProjectId(projects);
    if (!chromeTopEl) {
      const built = buildHiveChrome(doc, legendEl, pid, openTourFromHelp);
      chromeTopEl = built.chromeTop;
      liveChipEl = built.liveChip;
      liveCountEl = built.liveCount;
      pauseBtn = built.pauseBtn;
      brandEl = built.brand;
      brandVerEl = brandEl.querySelector?.('.ver-script');
      chrome.appendChild(chromeTopEl);
      const onPauseClick = () => {
        userPaused = !userPaused;
        setPauseUi();
        if (shouldAnimate()) scheduleFrame();
        else drawFrame(deps.now(), true);
      };
      const onPauseKey = (e) => {
        if (e.key === 'p' && !e.metaKey && !e.ctrlKey && !e.altKey) {
          e.preventDefault();
          onPauseClick();
        }
      };
      addListener(pauseBtn, 'click', onPauseClick);
      addListener(doc, 'keydown', onPauseKey);
    } else if (chromeTopEl) {
      const cockpitTab = chromeTopEl.querySelector?.('.cc-tab[href*="/command-center/project/"]');
      if (cockpitTab && pid) {
        cockpitTab.href = `/command-center/project/${encodeURIComponent(pid)}`;
      }
    }
  }

  function setPauseUi() {
    const motionOff = userPaused || prefersReducedMotion() || documentHidden();
    if (bodyEl?.classList) bodyEl.classList.toggle('motion-off', motionOff);
    if (pauseBtn) {
      pauseBtn.setAttribute('aria-pressed', String(userPaused));
      pauseBtn.innerHTML = (userPaused ? 'Resume motion ' : 'Pause motion ') + '<kbd>p</kbd>';
    }
  }

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
      userPaused,
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

    // Live agents always win over a quiet event feed: the ring never says "resting" while agents run.
    const liveAgents = agentsLiveCount(snapshotRef);
    if (liveAgents > 0) {
      coreStatus.className = 'hive-core-status hive-core-status--live';
      coreStatus.textContent = `running · ${trendCount(liveAgents, 'agent', 'agents')}`;
      coreDisk.classList.add('is-live');
    }

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

  function decorateStatTrends(statEntries, projects) {
    const cells = Array.from(statStrip.children || []).filter((c) => c?.classList?.contains('cc-stat'));
    for (let i = 0; i < cells.length && i < statEntries.length; i += 1) {
      const cell = cells[i];
      const { key, field } = statEntries[i];
      for (const old of Array.from(cell.children || [])) {
        if (old?.classList?.contains('trend')) cell.removeChild(old);
      }
      if (statBaseline[key] === undefined) statBaseline[key] = field.value;
      const trend = statTrend(key, field, projects, statBaseline[key]);
      if (trend) cell.appendChild(el(doc, 'span', `trend ${trend.tone}`, trend.text));
    }
  }

  function syncLiveChip(snapshotData) {
    if (!liveChipEl) return;
    const live = agentsLiveCount(snapshotData);
    liveChipEl.classList.toggle('is-idle', live <= 0);
    if (liveCountEl) {
      liveCountEl.textContent = live > 0 ? ` · ${trendCount(live, 'agent', 'agents')}` : '';
    }
  }

  function paintDom(snapshotData) {
    const projects = Array.isArray(snapshotData.projects) ? snapshotData.projects.slice(0, 10) : [];
    ensureChromeExtras(projects);
    const statEntries = statStripEntries(snapshotData.stats);
    renderHiveStatStrip(statStrip, statEntries.map((s) => s.entry));
    decorateStatTrends(statEntries, projects);
    syncLiveChip(snapshotData);

    // Rebuild the card columns from scratch: renderHiveLayout appends flat cards, placeProjectCards re-parents them.
    while (nodesMount.firstChild) nodesMount.removeChild(nodesMount.firstChild);
    renderHiveLayout(shell, projects, { legendEl, nodesMount, stageEl: stage });
    const rendered = Array.from(nodesMount.children || []);
    const flagged = rendered.filter((c) => c?.classList?.contains('hive-node'));
    const cardNodes = flagged.length ? flagged : rendered;
    placeProjectCards(doc, nodesMount, cardNodes);
    cardEls = cardNodes;
    clearCardHandlers();
    const { renderProjectCardMetrics, renderNeedsYou, deriveNeedsYouItems } = resolveHivePanels();
    for (let i = 0; i < cardNodes.length; i += 1) {
      const card = cardNodes[i];
      const project = projects[i];
      if (card && project) {
        syncProjectCardHeader(doc, card, project, i);
        renderProjectCardMetrics(card, project);
      }
      if (card && project?.id) {
        card.dataset.projectId = project.id;
        wireProjectCard(card, project.id);
      }
    }
    const needsItems = deriveNeedsYouItems(projects);
    const needsTotal = renderNeedsYou(needsList, needsItems, {
      limit: 6,
      onOpen: (projectId) => {
        if (typeof deps.onOpenProject === 'function') deps.onOpenProject(projectId);
      },
    });
    needsCount.textContent = String(needsTotal);
    needsCount.className = needsTotal > 0 ? 'hive-count hive-count--warn' : 'hive-count';
    applyBrain();
    setPauseUi();
    syncModelVersion(snapshotData);
    const { renderHivePanels } = resolveHivePanels();
    const panelModel = panelModelFromSnapshot(snapshotData);
    renderHivePanels(
      { eventLog, lanes: panelGates, savings: panelSaved, sessionTerm },
      panelModel,
      { nowMs: deps.now() },
    );
  }

  function layoutNodes() {
    const stageRect = stage.getBoundingClientRect?.() || { width: 800, height: 600, left: 0, top: 0 };
    const w = stageRect.width || 800;
    const h = stageRect.height || 600;
    const phone = isPhoneLayout(win.innerWidth ?? 1024);
    if (stage.classList) stage.classList.toggle('hive-phone', phone);

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
    // Endpoints are measured from the laid-out cards, never from preset coordinates.
    const children = cardEls;
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
    // Stacked phone layout: the canvas is hidden and cards read top to bottom, so no links are drawn.
    if (geom.phone) return;

    const streams = adjustPhoneStreams(
      buildHiveStreams(
        (geom.nodeEntries || []).filter(
          (entry) => entry?.box && entry.box.width > 0 && entry.box.height > 0,
        ),
        geom,
      ),
      geom,
    );
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
  if (typeof win.setTimeout === 'function') {
    enterTimer = win.setTimeout(() => {
      enterTimer = null;
      shell.classList.remove('is-entering');
    }, 1500);
  }

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
      // Card heights follow their content, so the stage (and canvas) can change size on update.
      resizeCanvas();
      drawFrame(deps.now(), !shouldAnimate());
      if (shouldAnimate() && !rafId) scheduleFrame();
    },
    destroy() {
      deps.cancelAnimationFrame(rafId);
      rafId = 0;
      if (enterTimer != null && typeof win.clearTimeout === 'function') win.clearTimeout(enterTimer);
      enterTimer = null;
      clearCardHandlers();
      for (const l of listeners) {
        l.target.removeEventListener(l.type, l.handler, l.options);
      }
      listeners.length = 0;
      while (host.firstChild) host.removeChild(host.firstChild);
    },
  };
}
