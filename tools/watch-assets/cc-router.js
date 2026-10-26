// SPDX-License-Identifier: Apache-2.0
/** Command Center navigation: Hive overview ↔ project Cockpit. */
import { renderHiveLayout } from './hive-layout.js';
import { renderCockpit } from './cockpit-view.js';

/**
 * Navigation state:
 * - `{ view: 'hive' }` — project ring overview
 * - `{ view: 'cockpit', projectId: string }` — single-project cockpit for that id
 *
 * Actions:
 * - `{ type: 'select-project', projectId: string }` — from hive, open cockpit for projectId
 * - `{ type: 'back' }` — from cockpit, return to hive in one transition
 *
 * @typedef {{ view: 'hive' }} CcHiveState
 * @typedef {{ view: 'cockpit', projectId: string }} CcCockpitState
 * @typedef {CcHiveState | CcCockpitState} CcNavState
 * @typedef {{ type: 'select-project', projectId: string } | { type: 'back' }} CcNavAction
 */

export const CC_INITIAL_STATE = Object.freeze({ view: 'hive' });

/**
 * Pure reducer for command-center view transitions.
 * @param {CcNavState | null | undefined} state
 * @param {CcNavAction} action
 * @returns {CcNavState}
 */
export function ccNavigate(state, action) {
  const current = state && typeof state === 'object' ? state : CC_INITIAL_STATE;
  if (!action || typeof action !== 'object') return current;

  if (action.type === 'select-project') {
    const projectId = action.projectId;
    if (typeof projectId !== 'string' || projectId.length === 0) return current;
    return { view: 'cockpit', projectId };
  }

  if (action.type === 'back') {
    if (current.view === 'cockpit') return { view: 'hive' };
    return current;
  }

  return current;
}

function clearElement(el) {
  if (!el) return;
  if (typeof el.replaceChildren === 'function') {
    el.replaceChildren();
    return;
  }
  while (el.firstChild) el.removeChild(el.firstChild);
}

function resolveCockpitData(projectId, options) {
  const opts = options || {};
  if (typeof opts.getCockpitData === 'function') {
    return opts.getCockpitData(projectId) ?? { ledger: { tickets: [] } };
  }
  const map = opts.cockpitDataByProjectId;
  if (map && typeof map === 'object' && map[projectId]) return map[projectId];
  return { ledger: { tickets: [] } };
}

function wireHiveNodeClicks(nodes, onSelectProject) {
  for (const { project, el } of nodes) {
    const projectId = project && typeof project.id === 'string' ? project.id : '';
    if (!projectId || !el) continue;
    el.addEventListener('click', () => {
      onSelectProject(projectId);
    });
  }
}

function wireCockpitBreadcrumb(host, onBack) {
  if (!host || typeof host.querySelector !== 'function') return;
  const nav = host.querySelector('.cockpit-nav');
  if (!nav) return;
  const breadcrumb = nav.querySelector('.nav-block') || nav;
  breadcrumb.addEventListener('click', () => {
    onBack();
  });
}

/**
 * Mount Hive ↔ Cockpit navigation into `container`.
 * @param {HTMLElement} container
 * @param {{
 *   projects?: object[],
 *   cockpitDataByProjectId?: Record<string, object>,
 *   getCockpitData?: (projectId: string) => object,
 *   initialState?: CcNavState,
 *   cockpitOpts?: { now?: number },
 *   legendEl?: HTMLElement,
 *   nodesMount?: HTMLElement,
 * }} [options]
 * @returns {{ getState: () => CcNavState, navigate: (action: CcNavAction) => CcNavState }}
 */
export function mountCcRouter(container, options = {}) {
  if (!container) {
    return {
      getState: () => CC_INITIAL_STATE,
      navigate: () => CC_INITIAL_STATE,
    };
  }

  const projects = Array.isArray(options.projects) ? options.projects : [];
  let state = CC_INITIAL_STATE;
  if (options.initialState && typeof options.initialState === 'object') {
    if (options.initialState.view === 'cockpit' && typeof options.initialState.projectId === 'string') {
      state = { view: 'cockpit', projectId: options.initialState.projectId };
    } else if (options.initialState.view === 'hive') {
      state = { view: 'hive' };
    }
  }

  function render() {
    clearElement(container);

    if (state.view === 'hive') {
      const legendEl = options.legendEl || document.createElement('div');
      if (!options.legendEl) {
        legendEl.className = 'hive-legend';
        container.appendChild(legendEl);
      }
      const nodesMount = options.nodesMount || document.createElement('div');
      if (!options.nodesMount) {
        nodesMount.className = 'hive-nodes';
        nodesMount.id = 'hive-nodes';
        container.appendChild(nodesMount);
      }
      const { nodes } = renderHiveLayout(container, projects, {
        legendEl,
        nodesMount,
        stageEl: container,
      });
      wireHiveNodeClicks(nodes, (projectId) => {
        state = ccNavigate(state, { type: 'select-project', projectId });
        render();
      });
      return;
    }

    const cockpitHost = document.createElement('div');
    cockpitHost.className = 'cc-cockpit-root';
    container.appendChild(cockpitHost);
    const data = resolveCockpitData(state.projectId, options);
    renderCockpit(cockpitHost, data, options.cockpitOpts);
    wireCockpitBreadcrumb(cockpitHost, () => {
      state = ccNavigate(state, { type: 'back' });
      render();
    });
  }

  function navigate(action) {
    state = ccNavigate(state, action);
    render();
    return state;
  }

  render();

  return {
    getState: () => state,
    navigate,
  };
}
