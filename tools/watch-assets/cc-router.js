// SPDX-License-Identifier: Apache-2.0
/** Command Center navigation: Hive overview ↔ project Cockpit. */
import { renderHiveLayout } from './hive-layout.js';
import { renderCockpit } from './cockpit-view.js';

import { CC_INITIAL_STATE, ccNavigate } from './cc-hive-stage.js';
export { CC_INITIAL_STATE, ccNavigate, ccPathFromState, ccStateFromPath } from './cc-hive-stage.js';

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

/** Cockpit top-bar breadcrumb: `The Hive › PROJECT-NAME`; the Hive block is the back control. */
function buildBreadcrumb(projectId, data, projects) {
  const project = projects.find((p) => p && p.id === projectId);
  const name = (data && data.name) || (project && project.name) || projectId;

  const bar = document.createElement('header');
  bar.className = 'cc-router-bar';
  const nav = document.createElement('nav');
  nav.className = 'crumbs cockpit-nav';
  nav.setAttribute('aria-label', 'Breadcrumb');
  const back = document.createElement('button');
  back.className = 'cc-cockpit-back-btn nav-block';
  back.type = 'button';
  back.textContent = 'The Hive';
  const sep = document.createElement('span');
  sep.textContent = '›';
  const current = document.createElement('span');
  current.setAttribute('aria-current', 'page');
  current.textContent = String(name);
  nav.appendChild(back);
  nav.appendChild(sep);
  nav.appendChild(current);
  bar.appendChild(nav);
  return bar;
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
    cockpitHost.appendChild(buildBreadcrumb(state.projectId, data, projects));
    const cockpitBody = document.createElement('div');
    cockpitBody.className = 'cc-cockpit-body';
    cockpitHost.appendChild(cockpitBody);
    renderCockpit(cockpitBody, data, options.cockpitOpts);
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
