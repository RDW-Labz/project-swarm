// SPDX-License-Identifier: Apache-2.0
/** Command Center page boot: Hive ↔ Project Cockpit, polling, palette, first-visit tour. */

import { renderHive } from './cc-hive-mount.js';
import { ccNavigate, ccPathFromState, ccStateFromPath } from './cc-hive-stage.js';

const REFRESH_MS = 5000;
const ROOT_TOUR_ATTR = 'data-tour';

function resolveCommandCenterData() {
  if (globalThis.CommandCenterData && typeof globalThis.CommandCenterData.parseCommandCenterSnapshot === 'function') {
    return globalThis.CommandCenterData;
  }
  return null;
}

function readWatchToken(location) {
  const loc = location || globalThis.location;
  let queryValue = '';
  try {
    const params = new URLSearchParams(loc?.search || '');
    queryValue = params.get('t') || '';
  } catch {
    queryValue = '';
  }
  if (queryValue) return queryValue;
  try {
    return globalThis.localStorage?.getItem('swarm-watch-token') || '';
  } catch {
    return '';
  }
}

function defaultFetchJson(url, deps) {
  const fetchImpl = globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    return Promise.reject(new Error('fetch is not available'));
  }
  const loc = deps.location || globalThis.location;
  const authValue = readWatchToken(loc);
  return fetchImpl(url, {
    method: 'GET',
    cache: 'no-cache',
    headers: { 'x-watch-token': authValue },
  }).then((res) => {
    if (!res || !res.ok) {
      const status = res && typeof res.status === 'number' ? res.status : 'unknown';
      throw new Error(`Command Center request failed (${status})`);
    }
    return res.json();
  });
}

function defaultStorage() {
  const mem = new Map();
  return {
    getItem(k) {
      try {
        return globalThis.localStorage?.getItem(k) ?? mem.get(k) ?? null;
      } catch {
        return mem.get(k) ?? null;
      }
    },
    setItem(k, v) {
      try {
        globalThis.localStorage?.setItem(k, v);
      } catch {
        mem.set(k, v);
      }
    },
  };
}

function clearHost(host) {
  if (!host) return;
  if (typeof host.replaceChildren === 'function') {
    host.replaceChildren();
    return;
  }
  while (host.firstChild) host.removeChild(host.firstChild);
}

function showShellMessage(host, document, text) {
  clearHost(host);
  const p = document.createElement('p');
  p.className = 'cc-shell-message';
  p.setAttribute('role', 'status');
  p.textContent = text;
  host.appendChild(p);
}

function projectLabel(project) {
  if (!project || typeof project !== 'object') return '';
  if (typeof project.name === 'string' && project.name.length) return project.name;
  return String(project.id || '');
}

function paletteItemsFromProjects(projects) {
  const list = Array.isArray(projects) ? projects : [];
  return list.map((p) => ({
    id: p.id,
    label: projectLabel(p) || p.id,
  })).filter((item) => typeof item.id === 'string' && item.id.length);
}

function applyTourMarkers(host, view) {
  if (!host || !host.setAttribute) return;
  if (view === 'hive') {
    host.setAttribute(ROOT_TOUR_ATTR, 'hive');
    const legend = host.querySelector?.('.hive-legend');
    if (legend) legend.setAttribute(ROOT_TOUR_ATTR, 'legend');
  } else if (view === 'cockpit') {
    host.setAttribute(ROOT_TOUR_ATTR, 'cockpit');
  }
}

function loadClassicScript(document, src) {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = src;
    script.async = false;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error(`Failed to load ${src}`));
    (document.head || document.documentElement).appendChild(script);
  });
}

async function ensureBrowserGlobals(document) {
  if (!resolveCommandCenterData()) {
    await loadClassicScript(document, '/assets/command-center-data.js');
  }
  if (!globalThis.HivePanels?.renderHivePanels) {
    await loadClassicScript(document, '/assets/hive-panels.js');
  }
}

/**
 * @param {HTMLElement} root
 * @param {{
 *   document?: Document,
 *   fetchJson?: (url: string) => Promise<unknown>,
 *   location?: Location,
 *   history?: History,
 *   now?: () => number,
 *   setInterval?: typeof setInterval,
 *   clearInterval?: typeof clearInterval,
 *   requestAnimationFrame?: typeof requestAnimationFrame,
 *   cancelAnimationFrame?: typeof cancelAnimationFrame,
 *   matchMedia?: typeof matchMedia,
 *   storage?: Storage,
 * }} [deps]
 */
export function mountCommandCenter(root, deps = {}) {
  const document = deps.document || globalThis.document;
  const location = deps.location || globalThis.location;
  const history = deps.history || globalThis.history;
  const fetchJson = deps.fetchJson || ((url) => defaultFetchJson(url, { location }));
  const now = typeof deps.now === 'function' ? deps.now : () => Date.now();
  const setIntervalFn = deps.setInterval || globalThis.setInterval.bind(globalThis);
  const clearIntervalFn = deps.clearInterval || globalThis.clearInterval.bind(globalThis);
  const requestAnimationFrame = deps.requestAnimationFrame || globalThis.requestAnimationFrame.bind(globalThis);
  const cancelAnimationFrame = deps.cancelAnimationFrame || globalThis.cancelAnimationFrame.bind(globalThis);
  const matchMedia = deps.matchMedia || globalThis.matchMedia.bind(globalThis);
  const storage = deps.storage || defaultStorage();
  const renderHiveView = deps.renderHive || renderHive;

  let navState = ccStateFromPath(location?.pathname || '/command-center');
  let viewHandle = null;
  let viewKind = null;
  let viewProjectId = null;
  let palette = null;
  let refreshTimer = null;
  let tourStarted = false;
  let popHandler = null;
  let destroyed = false;
  let refreshSequence = 0;
  let cockpitModule = null;
  let paletteModule = null;
  let projectsForPalette = [];
  let idleTour = null;
  let parkedHive = null;
  let cockpitPreload = null;
  const projectCache = new Map();
  const projectRequests = new Map();
  const loadCockpit = deps.loadCockpit || (() => import('./cc-cockpit-mount.js'));
  const loadPalette = deps.loadPalette || (() => import('./command-palette.js'));
  const loadTour = deps.loadTour || (() => import('./cc-tour.js'));
  function preloadCockpit(projectId) {
    if (destroyed) return;
    if (deps.loadCockpit) {
      cockpitModule ||= loadCockpit().catch(error => { cockpitModule = null; throw error; });
      void cockpitModule.catch(() => {});
    } else if (!cockpitPreload && document.createElement) {
      // Warm the ES module graph without evaluating Cockpit code on the Hive.
      cockpitPreload = document.createElement('link');
      cockpitPreload.rel = 'modulepreload';
      cockpitPreload.href = new URL('./cc-cockpit-mount.js', import.meta.url).href;
      (document.head || document.documentElement)?.appendChild(cockpitPreload);
    }
    if (projectId && !projectRequests.has(projectId)) {
      const pending = fetchJson(`/api/command-center/project?id=${encodeURIComponent(projectId)}`)
        .then(body => { if (body?.id === projectId) projectCache.set(projectId, body); return body; })
        .finally(() => projectRequests.delete(projectId));
      projectRequests.set(projectId, pending);
      void pending.catch(() => {});
    }
  }

  function destroyView(parkHive = false) {
    if (parkHive && viewKind === 'hive' && viewHandle?.suspend && root.removeChild) {
      const nodes = Array.from(root.childNodes || root.children || []);
      viewHandle.suspend();
      for (const node of nodes) root.removeChild(node);
      parkedHive = { nodes, handle: viewHandle };
    } else if (viewHandle && typeof viewHandle.destroy === 'function') {
      viewHandle.destroy();
    }
    viewHandle = null;
    viewKind = null;
    viewProjectId = null;
  }

  function syncPalette(projects) {
    projectsForPalette = projects;
    if (!paletteModule) return;
    const items = paletteItemsFromProjects(projects);
    if (palette) palette.unbind();
    palette = paletteModule.createCommandPalette({
      doc: document,
      items,
      platform: globalThis.navigator?.platform,
      onNavigate: (item) => {
        if (!item?.id) return;
        openProject(item.id);
      },
    });
    palette.bind();
  }

  function openProject(projectId) {
    navState = ccNavigate(navState, { type: 'select-project', projectId });
    const path = ccPathFromState(navState);
    if (history?.pushState) history.pushState(null, '', path);
    void refresh(false);
  }

  function goBack() {
    navState = ccNavigate(navState, { type: 'back' });
    const path = ccPathFromState(navState);
    if (history?.pushState) history.pushState(null, '', path);
    void refresh(false);
  }

  async function startTourIfNeeded() {
    if (tourStarted) return;
    tourStarted = true;
    const start = async () => {
      if (destroyed) return;
      try {
        const { maybeStartFirstVisit } = await loadTour();
        if (!destroyed) maybeStartFirstVisit({ doc: document, storage, userId: 'anonymous' });
      } catch { /* optional decoration in a partial DOM */ }
    };
    if (typeof globalThis.requestIdleCallback === 'function') {
      idleTour = globalThis.requestIdleCallback(() => { idleTour = null; preloadCockpit(); void start(); });
    } else {
      await start();
    }
  }

  async function refresh(isPoll) {
    if (destroyed || (isPoll && document.hidden)) return;
    const sequence = ++refreshSequence;
    const CommandCenterData = resolveCommandCenterData();
    if (!CommandCenterData) {
      showShellMessage(root, document, 'Command Center data layer is not loaded yet.');
      return;
    }

    navState = ccStateFromPath(location?.pathname || '/command-center');

    try {
      if (navState.view === 'cockpit') {
        const projectId = navState.projectId;
        const url = `/api/command-center/project?id=${encodeURIComponent(projectId)}`;
        // Fetch data and code together, then paint the shell before optional decorations load.
        const request = projectRequests.get(projectId) || fetchJson(url);
        void request.catch(() => {});
        const cockpit = await (cockpitModule ||= loadCockpit());
        // Hover-prefetched project data can paint immediately; the current response follows independently.
        const cached = projectCache.get(projectId);
        if (cached && !destroyed && sequence === refreshSequence && (viewKind !== 'cockpit' || viewProjectId !== projectId)) {
          destroyView(true); clearHost(root);
          viewHandle = cockpit.renderProjectCockpit(root, cached, {
            document, now, onBack: goBack, requestAnimationFrame, cancelAnimationFrame, matchMedia,
          });
          viewKind = 'cockpit'; viewProjectId = projectId;
        }
        const body = await request;
        if (destroyed || sequence !== refreshSequence) return;
        if (!body || typeof body !== 'object' || body.id !== projectId) {
          throw new Error('Project cockpit response was missing or invalid');
        }
        projectCache.set(projectId, body);
        if (viewKind === 'cockpit' && viewProjectId === projectId && viewHandle?.update) {
          viewHandle.update(body);
        } else {
          destroyView(true);
          clearHost(root);
          viewHandle = cockpit.renderProjectCockpit(root, body, {
            document,
            now,
            onBack: goBack,
            requestAnimationFrame,
            cancelAnimationFrame,
            matchMedia,
          });
          viewKind = 'cockpit';
          viewProjectId = projectId;
        }
        applyTourMarkers(root, 'cockpit');
        await startTourIfNeeded();
        return;
      }

      const body = await fetchJson('/api/command-center');
      if (destroyed || sequence !== refreshSequence) return;
      const snapshot = CommandCenterData.parseCommandCenterSnapshot(body);
      if (!Array.isArray(snapshot.projects) || snapshot.projects.length === 0) {
        destroyView();
        showShellMessage(
          root,
          document,
          'No projects are on this board yet. Add a project in Swarm, then refresh this page.',
        );
        return;
      }

      syncPalette(snapshot.projects);

      const hiveDeps = {
        document,
        now,
        rawSnapshot: body,
        requestAnimationFrame,
        cancelAnimationFrame,
        matchMedia,
        onOpenProject: openProject,
        preloadCockpit,
      };

      if (viewKind === 'hive' && viewHandle?.update) {
        viewHandle.update(snapshot, body);
      } else {
        destroyView();
        clearHost(root);
        if (parkedHive) {
          viewHandle = parkedHive.handle;
          for (const node of parkedHive.nodes) root.appendChild(node);
          parkedHive = null;
          viewHandle.update(snapshot, body);
          viewHandle.resume();
        } else viewHandle = renderHiveView(root, snapshot, hiveDeps);
        viewKind = 'hive';
        viewProjectId = null;
      }
      applyTourMarkers(root, 'hive');
      await startTourIfNeeded();
    } catch (err) {
      if (destroyed || sequence !== refreshSequence) return;
      destroyView();
      parkedHive?.handle.destroy();
      parkedHive = null;
      const detail = err && err.message ? String(err.message) : 'Unknown error';
      showShellMessage(
        root,
        document,
        `Could not load the Command Center. ${detail} Try refreshing the page.`,
      );
    }
  }

  popHandler = () => {
    navState = ccStateFromPath(location?.pathname || '/command-center');
    void refresh(false);
  };
  globalThis.addEventListener?.('popstate', popHandler);

  const onPaletteKey = async (event) => {
    if (palette || event.key?.toLowerCase() !== 'k' || !(event.metaKey || event.ctrlKey)) return;
    event.preventDefault?.();
    try {
      paletteModule = await loadPalette();
      if (destroyed) return;
      syncPalette(projectsForPalette);
      const KeyboardEvent = document.defaultView?.KeyboardEvent || globalThis.KeyboardEvent;
      if (KeyboardEvent) document.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'k', ctrlKey: event.ctrlKey, metaKey: event.metaKey, bubbles: true,
      }));
    } catch { /* search can be retried */ }
  };
  document.addEventListener?.('keydown', onPaletteKey);

  function syncPolling() {
    if (refreshTimer != null) clearIntervalFn(refreshTimer);
    refreshTimer = document.hidden ? null : setIntervalFn(() => refresh(true), REFRESH_MS);
  }
  const onVisibility = () => {
    syncPolling();
    if (!document.hidden) void refresh(false);
  };
  document.addEventListener?.('visibilitychange', onVisibility);
  syncPolling();

  const whenReady = refresh(false);

  return {
    whenReady,
    destroy() {
      destroyed = true;
      refreshSequence++;
      if (refreshTimer != null) clearIntervalFn(refreshTimer);
      refreshTimer = null;
      if (idleTour != null) globalThis.cancelIdleCallback?.(idleTour);
      document.removeEventListener?.('visibilitychange', onVisibility);
      document.removeEventListener?.('keydown', onPaletteKey);
      if (palette) palette.unbind();
      palette = null;
      if (popHandler) globalThis.removeEventListener?.('popstate', popHandler);
      popHandler = null;
      destroyView();
      parkedHive?.handle.destroy();
      parkedHive = null;
      cockpitPreload?.remove();
      clearHost(root);
    },
    refresh: () => refresh(false),
  };
}

const __ccAutoBoot = typeof process === 'undefined' || !process.env.SWARM_COMMAND_CENTER_BOOT_TEST;

if (__ccAutoBoot && typeof document !== 'undefined') {
  const root = document.getElementById('command-center-root');
  if (root) {
    ensureBrowserGlobals(document)
      .then(() => mountCommandCenter(root, {}))
      .catch(() => {
        showShellMessage(
          root,
          document,
          'Could not start the Command Center. Required scripts failed to load.',
        );
      });
  }
}
