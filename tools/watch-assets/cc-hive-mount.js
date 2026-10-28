// SPDX-License-Identifier: Apache-2.0
/**
 * Command Center Hive: header counters, project cards on an ellipse around the neon ring, three panels under it.
 * Markup and motion follow the owner-approved artifact (docs/design/reference/command-center-artifact); every number
 * comes from the live snapshot (/api/command-center) and nothing is simulated.
 */

import { mountRobotHead, setAnimationPaused } from './robot-head.js';
import { cardPositions, createHiveStage } from './cc-hive-stage.js';
import { glitch, glitchFailure } from './cc-glitch.js';
import { hasCompleted, isTourDisabledByQuery, startTour } from './cc-tour.js';

let hivePanelsApi = null;

function resolveHivePanels() {
  if (hivePanelsApi) return hivePanelsApi;
  const globalApi = globalThis.HivePanels;
  if (globalApi && typeof globalApi.renderHiveDashboard === 'function') {
    hivePanelsApi = globalApi;
    return hivePanelsApi;
  }
  throw new Error('HivePanels is not available; load hive-panels.js before cc-hive-mount.js');
}

const ICON_BASE = '/assets/vendor/fluent-emoji/';
const TOAST_ICON = { volt: 'high_voltage_56.webp', done: 'party_popper_56.webp', think: 'thinking_face_56.webp' };
const PHONE_MAX = 900;
const RAW_URL = '/api/command-center';

function h(doc, tag, cls, text) {
  const n = doc.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

function plural(n, one, many) {
  return `${n} ${n === 1 ? one : many}`;
}

function padPct(pct) {
  return pct >= 100 ? '1.00' : `.${String(Math.round(pct)).padStart(2, '0')}`;
}

function formatGenerated(at) {
  const ms = Date.parse(at);
  if (!Number.isFinite(ms)) return '';
  return `${new Date(ms).toISOString().replace('T', ' ').slice(0, 16)} UTC`;
}

function readWatchToken(win) {
  try {
    const params = new URLSearchParams(win.location?.search || '');
    const q = params.get('t');
    if (q) return q;
  } catch {
    // fall through to storage
  }
  try {
    return win.localStorage?.getItem('swarm-watch-token') || '';
  } catch {
    return '';
  }
}

/**
 * The shared parser keeps only a few card fields. Until it passes the rest through, the Hive reads the full
 * /api/command-center body itself and merges it under the parsed snapshot (parsed fields win).
 */
function mergeSnapshot(parsed, raw) {
  if (!raw || typeof raw !== 'object') return parsed;
  const rawById = new Map();
  for (const p of Array.isArray(raw.projects) ? raw.projects : []) {
    if (p && typeof p.id === 'string') rawById.set(p.id, p);
  }
  return {
    ...parsed,
    hive: parsed.hive || raw.hive,
    projects: (parsed.projects || []).map((p) => ({ ...(rawById.get(p.id) || {}), ...p })),
  };
}

/**
 * @param {HTMLElement} host
 * @param {object} snapshot Command Center snapshot (parseCommandCenterSnapshot shape, plus hive extras when present)
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
  const panels = resolveHivePanels();

  while (host.firstChild) host.removeChild(host.firstChild);

  const listeners = [];
  const timers = [];
  let rafId = 0;
  let lastFrame = 0;
  let userPaused = false;
  let destroyed = false;
  let hiveVisible = true;
  let parsedRef = snapshot;
  let rawRef = null;
  let rawBusy = false;
  let view = null;
  let prevView = null;
  let cardSig = '';
  let panelSig = '';
  let cardEls = [];
  let cardHeads = [];
  let panelHeads = [];
  let cardCleanups = [];
  let counterEls = null;
  let stageGeom = [];
  let headJobs = [];

  const reducedMq = deps.matchMedia('(prefers-reduced-motion: reduce)');
  const reduced = () => Boolean(reducedMq && reducedMq.matches);
  const hidden = () => Boolean(doc.hidden);
  const isPhone = () => (win.innerWidth ?? 1200) <= PHONE_MAX;
  const shouldAnimate = () => !(reduced() || hidden() || userPaused);

  function addListener(target, type, handler, options) {
    target.addEventListener(type, handler, options);
    listeners.push({ target, type, handler, options });
  }

  function later(fn, ms) {
    if (typeof win.setTimeout !== 'function') return;
    const id = win.setTimeout(() => { if (!destroyed) fn(); }, ms);
    timers.push(id);
  }

  function burst(el, hard) {
    if (!el || reduced() || userPaused || hidden()) return;
    if (hard) glitchFailure(el);
    else glitch(el);
  }

  /* ---- robot heads (real heads in a browser, a monogram where there is no animation loop, e.g. tests) ---- */
  function mountHead(hostEl, o) {
    if (typeof win.requestAnimationFrame === 'function') {
      try {
        return mountRobotHead(hostEl, {
          state: o.state,
          size: o.size || 28,
          color: o.color,
          screenColor: o.state === 'error' ? '#ffc4c4' : '#e8f2ff',
          id: o.id,
          label: o.label,
        });
      } catch {
        while (hostEl.firstChild) hostEl.removeChild(hostEl.firstChild);
      }
    }
    const mono = h(doc, 'span', 'hive-bot hive-bot--mono', String(o.label || '·').charAt(0).toUpperCase());
    mono.setAttribute('aria-hidden', 'true');
    hostEl.appendChild(mono);
    return { destroy() {} };
  }

  function destroyHeads(list) {
    while (list.length) {
      const handle = list.pop();
      try {
        if (handle && typeof handle.destroy === 'function') handle.destroy();
      } catch {
        // a head that is already gone needs no cleanup
      }
    }
  }

  /* ---- static shell ---- */
  const shell = h(doc, 'div', 'hive-shell');
  shell.id = 'hive-shell';

  const top = h(doc, 'header', 'hive-top');
  const logo = h(doc, 'span', 'hive-logo hive-brand', 'SWARM WATCH');
  logo.setAttribute('aria-label', 'Swarm Watch Command Center');
  top.appendChild(logo);
  const tag = h(doc, 'span', 'hive-tag');
  tag.appendChild(doc.createTextNode('command center · one ledger, many workers'));
  tag.appendChild(h(doc, 'br'));
  tag.appendChild(doc.createTextNode('every number read from ledgers and run folders'));
  top.appendChild(tag);
  const cnt = h(doc, 'div', 'hive-cnt');
  cnt.setAttribute('role', 'group');
  cnt.setAttribute('aria-label', 'Hive summary');
  top.appendChild(cnt);
  const live = h(doc, 'span', 'hive-live');
  live.setAttribute('role', 'status');
  live.appendChild(h(doc, 'i'));
  live.appendChild(doc.createTextNode('LIVE'));
  top.appendChild(live);

  const nav = h(doc, 'div', 'hive-nav');
  const crumbs = h(doc, 'nav', 'hive-crumbs');
  crumbs.setAttribute('aria-label', 'Breadcrumb');
  const crumbHive = h(doc, 'button', null, 'The Hive');
  crumbHive.type = 'button';
  crumbs.appendChild(crumbHive);
  nav.appendChild(crumbs);
  const tabs = h(doc, 'div', 'hive-tabs');
  tabs.setAttribute('role', 'tablist');
  tabs.setAttribute('aria-label', 'Command Center views');
  const tabHive = h(doc, 'a', 'hive-tab', 'Command Center');
  tabHive.setAttribute('role', 'tab');
  tabHive.setAttribute('aria-selected', 'true');
  tabHive.setAttribute('aria-current', 'page');
  tabHive.href = '/command-center';
  tabs.appendChild(tabHive);
  const tabCockpit = h(doc, 'a', 'hive-tab', 'Cockpit');
  tabCockpit.setAttribute('role', 'tab');
  tabCockpit.setAttribute('aria-selected', 'false');
  tabCockpit.setAttribute('data-tour', 'cockpit');
  tabs.appendChild(tabCockpit);
  const tabClassic = h(doc, 'a', 'hive-tab', 'Classic');
  tabClassic.setAttribute('role', 'tab');
  tabClassic.setAttribute('aria-selected', 'false');
  tabClassic.href = `/${win.location?.search || ''}`;
  tabs.appendChild(tabClassic);
  const searchBtn = h(doc, 'button', 'hive-tabbtn');
  searchBtn.type = 'button';
  searchBtn.appendChild(doc.createTextNode('Search '));
  searchBtn.appendChild(h(doc, 'span', 'hive-mono hive-hint', 'Ctrl K'));
  tabs.appendChild(searchBtn);
  const tourBtn = h(doc, 'button', 'hive-tabbtn cc-tour-help', 'Tour');
  tourBtn.type = 'button';
  tourBtn.setAttribute('aria-label', 'Command Center tour');
  tabs.appendChild(tourBtn);
  nav.appendChild(tabs);

  const stage = h(doc, 'section', 'hive-stage');
  stage.id = 'hive-stage';
  stage.setAttribute('data-tour', 'hive');
  stage.setAttribute('aria-label', 'Hive diagram');
  const canvas = h(doc, 'canvas');
  canvas.id = 'hive-canvas';
  canvas.setAttribute('aria-hidden', 'true');
  stage.appendChild(canvas);
  const ringfx = h(doc, 'div', 'hive-ringfx');
  ringfx.setAttribute('aria-hidden', 'true');
  stage.appendChild(ringfx);
  const core = h(doc, 'div', 'hive-core');
  core.appendChild(h(doc, 'div', 'a', 'THE SWARM'));
  core.appendChild(h(doc, 'div', 'n', 'Swarm'));
  const coreState = h(doc, 'div', 's', 'waiting');
  core.appendChild(coreState);
  const coreExtra = h(doc, 'div', 'x');
  core.appendChild(coreExtra);
  stage.appendChild(core);

  const legend = h(doc, 'div', 'hive-legend');
  legend.setAttribute('aria-label', 'Project colours');
  legend.setAttribute('data-tour', 'legend');
  for (const [label, cssVar] of [['building', '--green'], ['blocked', '--amber'], ['needs you', '--red'], ['done', '--blue'], ['idle', '--violet']]) {
    const item = h(doc, 'span');
    item.style.color = `var(${cssVar})`;
    const dot = h(doc, 'i');
    dot.style.background = `var(${cssVar})`;
    item.appendChild(dot);
    item.appendChild(doc.createTextNode(label));
    legend.appendChild(item);
  }
  const tl = h(doc, 'span', 'tl');
  tl.appendChild(h(doc, 'u', null, 'the ledger counts.'));
  tl.appendChild(doc.createTextNode(' '));
  tl.appendChild(h(doc, 'b', null, 'the swarm builds.'));
  tl.appendChild(doc.createTextNode(' '));
  tl.appendChild(h(doc, 'u', null, 'you decide.'));
  legend.appendChild(tl);

  const panelsRoot = h(doc, 'div', 'hive-panels');

  const foot = h(doc, 'div', 'hive-foot');
  const footData = h(doc, 'span');
  const footGen = h(doc, 'span');
  footData.appendChild(doc.createTextNode('data: live ledgers and run folders from the board, read at '));
  footData.appendChild(footGen);
  foot.appendChild(footData);
  const pauseBtn = h(doc, 'button', 'hive-footbtn');
  pauseBtn.id = 'pause-motion';
  pauseBtn.type = 'button';
  pauseBtn.setAttribute('aria-pressed', 'false');
  foot.appendChild(pauseBtn);
  const sources = h(doc, 'details');
  sources.appendChild(h(doc, 'summary', null, 'sources'));
  sources.appendChild(h(doc, 'p', null, 'Read from the board payload behind /api/command-center: each project’s ledger counts, the run folders and the agents the board reports as running. A number the board does not report is left out and the panel says so. Robot heads come from tools/watch-assets with the project colours. Glitch limits in code: each burst under 400 ms, at most 3 at once, never on text being read, off with reduced motion.'));
  foot.appendChild(sources);

  const toast = h(doc, 'div', 'hive-toast');
  toast.setAttribute('role', 'status');
  toast.setAttribute('aria-live', 'polite');
  const toastText = h(doc, 'span');
  toast.appendChild(toastText);

  shell.appendChild(top);
  shell.appendChild(nav);
  shell.appendChild(stage);
  shell.appendChild(legend);
  shell.appendChild(panelsRoot);
  shell.appendChild(foot);
  shell.appendChild(toast);
  host.appendChild(shell);

  const stageApi = createHiveStage({ canvas, createCanvas: () => doc.createElement('canvas') });

  /* ---- toast (real events only: more agents, a finished ticket, something new for you) ---- */
  function showToast(message, icon) {
    toastText.textContent = message;
    const old = toast.querySelector ? toast.querySelector('img') : null;
    if (old && old.parentNode) old.parentNode.removeChild(old);
    if (icon && TOAST_ICON[icon]) {
      const img = h(doc, 'img');
      img.alt = '';
      img.src = ICON_BASE + TOAST_ICON[icon];
      if (typeof toast.insertBefore === 'function' && toast.firstChild) toast.insertBefore(img, toast.firstChild);
      else toast.appendChild(img);
    }
    toast.classList.remove('is-on');
    // Restart the CSS animation (a reflow between remove and add).
    void toast.offsetWidth;
    toast.classList.add('is-on');
    later(() => toast.classList.remove('is-on'), 3200);
  }

  /* ---- header counters ---- */
  function buildCounters() {
    const defs = [
      ['projects', 'Registered top-level projects on this board.', 'stats.projectsTotal'],
      ['agents', 'Workers running right now, from the run folders.', 'stats.agentsLive'],
      ['done 24h', 'Tickets the ledger marks done in the last 24 hours (some are bulk marks of work merged earlier).', 'hive.doneLast24h'],
      ['need you', 'Open items waiting for you on the board.', 'stats.needsYouCount'],
    ];
    const els = {};
    for (const [label, tip, source] of defs) {
      const cell = h(doc, 'div');
      cell.appendChild(h(doc, 'div', 'l', label));
      const v = h(doc, 'div', 'v has-tip');
      v.setAttribute('tabindex', '0');
      v.setAttribute('data-k', label);
      v.setAttribute('data-tip', tip);
      v.setAttribute('data-source', source);
      cell.appendChild(v);
      cnt.appendChild(cell);
      els[label] = v;
    }
    return els;
  }
  counterEls = buildCounters();

  function paintCounters(v) {
    const next = {
      projects: [String(v.projectsTotal), ''],
      agents: [String(v.agents), v.agents > 0 ? 'var(--green)' : ''],
      'done 24h': [v.doneLast24h === null ? '—' : String(v.doneLast24h), 'var(--blue)'],
      'need you': [String(v.needs), 'var(--red)'],
    };
    for (const k of Object.keys(next)) {
      const el = counterEls[k];
      const changed = el.textContent !== '' && el.textContent !== next[k][0];
      el.textContent = next[k][0];
      el.style.color = next[k][1];
      if (changed && (k === 'agents' || k === 'need you')) later(() => burst(el, false), 400);
    }
  }

  function paintCore(v) {
    coreState.textContent = v.agents > 0 ? 'building' : 'waiting';
    const parts = [`${plural(v.agents, 'agent', 'agents')} live`];
    if (v.doneLast24h !== null) parts.push(`${v.doneLast24h} done in 24 h`);
    coreExtra.textContent = parts.join(' · ');
  }

  function paintFoot(v) {
    footGen.textContent = formatGenerated(v.at);
  }

  function setPauseUi() {
    const motionOff = userPaused || reduced() || hidden();
    if (doc.body?.classList) doc.body.classList.toggle('motion-off', motionOff);
    try {
      setAnimationPaused(motionOff);
    } catch {
      // heads are optional
    }
    pauseBtn.setAttribute('aria-pressed', String(userPaused));
    pauseBtn.textContent = userPaused ? 'resume motion · p' : 'pause motion · p';
  }

  /* ---- project cards ---- */
  function openProject(projectId) {
    if (typeof deps.onOpenProject === 'function') deps.onOpenProject(projectId);
  }

  function clearCards() {
    while (cardCleanups.length) cardCleanups.pop()();
    destroyHeads(cardHeads);
    for (const el of cardEls) if (el.parentNode) el.parentNode.removeChild(el);
    cardEls = [];
  }

  function failsOf(p) {
    return Number(p.raw && p.raw.fails && p.raw.fails.value) || 0;
  }

  function headStateFor(p) {
    if (failsOf(p) > 0) return 'error';
    if (p.cat === 'building') return 'working';
    if (p.cat === 'done') return 'sleeping';
    return 'idle';
  }

  function buildCard(p, index) {
    const card = h(doc, 'div', 'hive-card hive-node');
    card.style.setProperty('--c', p.color);
    card.tabIndex = 0;
    card.setAttribute('role', 'button');
    card.setAttribute('aria-label', `Open ${p.name}`);
    card.setAttribute('data-project-id', p.id);
    card.setAttribute('data-status', p.cat);
    card.setAttribute('data-attn', p.cat === 'need' ? '1' : '0');
    if (card.dataset) card.dataset.projectId = p.id;

    const hd = h(doc, 'div', 'hive-card-hd');
    const name = h(doc, 'span', 'name');
    name.appendChild(h(doc, 'span', 'k', String(index + 1).padStart(2, '0')));
    name.appendChild(doc.createTextNode(p.name));
    name.setAttribute('title', p.name);
    hd.appendChild(name);
    const hb = h(doc, 'span', 'hb');
    const state = headStateFor(p);
    const lane = p.cat === 'need' || p.cat === 'building' || p.cat === 'blocked';
    // Heads mount once the card is in the page (see paintCards), so their off-screen tracking sees real layout.
    headJobs.push(() => cardHeads.push(mountHead(hb, { state, size: 22, color: lane ? '#c084fc' : '#94a3b8', id: `c-${p.id}`, label: `${p.name}, ${state}` })));
    const bubble = p.cat === 'done' ? 'stars' : p.cat === 'need' ? 'excl' : p.cat === 'building' ? 'dots' : '';
    if (bubble) hb.appendChild(panels.createBubble(bubble));
    hd.appendChild(hb);
    hd.appendChild(h(doc, 'span', 't', p.tag));
    card.appendChild(hd);

    const bd = h(doc, 'div', 'hive-card-bd');
    const c = p.counts;
    if (c) {
      const rows = [
        ['tickets', c.total],
        ['done', `${c.done} of ${p.counted}`],
        p.pct === 100 ? ['cancelled', c.cancelled] : ['blocked', c.blocked],
        p.needs > 0 ? ['need you', p.needs] : ['in review', c.review],
      ];
      for (const [label, value] of rows) {
        const row = h(doc, 'div', 'r');
        row.appendChild(h(doc, 'span', null, label));
        row.appendChild(h(doc, 'span', 'val', String(value)));
        bd.appendChild(row);
      }
    } else {
      bd.appendChild(h(doc, 'p', 'hive-muted', 'no ledger numbers yet'));
    }
    if (p.pct !== null) {
      const pb = h(doc, 'div', 'pb');
      pb.appendChild(h(doc, 'b', null, `${p.pct}%`));
      const track = h(doc, 'i');
      const fill = h(doc, 'u');
      fill.style.transform = `scaleX(${Math.max(0, Math.min(1, p.pct / 100))})`;
      track.appendChild(fill);
      pb.appendChild(track);
      const em = h(doc, 'em', 'has-tip', padPct(p.pct));
      em.setAttribute('tabindex', '0');
      em.setAttribute('data-tip', 'Done divided by tickets that still count (cancelled left out).');
      pb.appendChild(em);
      bd.appendChild(pb);
    }
    card.appendChild(bd);

    const open = () => openProject(p.id);
    const onKey = (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        open();
      }
    };
    const onEnter = () => burst(hb, false);
    card.addEventListener('click', open);
    card.addEventListener('keydown', onKey);
    card.addEventListener('mouseenter', onEnter);
    cardCleanups.push(() => {
      card.removeEventListener('click', open);
      card.removeEventListener('keydown', onKey);
      card.removeEventListener('mouseenter', onEnter);
    });
    return card;
  }

  function paintCards(v) {
    const sig = JSON.stringify(v.projects.map((p) => [p.id, p.name, p.cat, p.counts, p.pct, p.needs, p.agents, p.raw && p.raw.fails && p.raw.fails.value]));
    const first = v.projects[0];
    tabCockpit.href = first ? `/command-center/project/${encodeURIComponent(first.id)}` : '#';
    if (sig === cardSig) return false;
    cardSig = sig;
    clearCards();
    headJobs = [];
    v.projects.forEach((p, i) => {
      const card = buildCard(p, i);
      stage.appendChild(card);
      cardEls.push(card);
    });
    for (const job of headJobs) job();
    headJobs = [];
    return true;
  }

  /* ---- layout and canvas ---- */
  function layout() {
    const phone = isPhone();
    const rect = (phone ? canvas : stage).getBoundingClientRect?.() || { width: 800, height: 600 };
    stageApi.resize(rect.width || 800, rect.height || 600, phone);
    const size = stageApi.size;
    const pos = cardPositions(size.w, size.h, cardEls.length);
    stageGeom = [];
    cardEls.forEach((el, i) => {
      const p = view.projects[i];
      if (!phone) {
        el.style.left = `${pos[i].x}px`;
        el.style.top = `${pos[i].y}px`;
      }
      stageGeom.push({ x: pos[i].x, y: pos[i].y, a: pos[i].a, col: p.color, cat: p.cat });
    });
    stageApi.setCards(stageGeom);
    stageApi.setActivity({ agents: view.agents, done24: view.doneLast24h || 0 });
  }

  function drawStillFrame() {
    stageApi.drawStill();
  }

  function scheduleFrame() {
    deps.cancelAnimationFrame(rafId);
    rafId = deps.requestAnimationFrame(tick);
  }

  function tick(now) {
    if (destroyed) return;
    if (!shouldAnimate()) {
      rafId = 0;
      drawStillFrame();
      return;
    }
    if (hiveVisible && now - lastFrame >= stageApi.frameMs()) {
      const dt = Math.min(0.1, (now - lastFrame) / 1000);
      lastFrame = now;
      stageApi.frame(dt);
    }
    rafId = deps.requestAnimationFrame(tick);
  }

  function restart() {
    if (shouldAnimate()) scheduleFrame();
    else {
      deps.cancelAnimationFrame(rafId);
      rafId = 0;
      drawStillFrame();
    }
  }

  /* ---- paint from a snapshot ---- */
  function currentSnapshot() {
    return mergeSnapshot(parsedRef, rawRef);
  }

  function failTotal(v) {
    return v.projects.reduce((a, p) => a + failsOf(p), 0);
  }

  function reactToChange(prev, next) {
    if (!prev) return;
    if (next.agents > prev.agents) {
      for (const k of stageGeom) if (k.cat !== 'off') stageApi.spawn(k, 30);
      burst(ringfx, false);
      showToast(`${plural(next.agents - prev.agents, 'agent', 'agents')} started`, 'volt');
    }
    if (next.doneLast24h !== null && prev.doneLast24h !== null && next.doneLast24h > prev.doneLast24h) {
      stageApi.pulse();
      showToast(next.doneLast24h - prev.doneLast24h === 1 ? 'A ticket finished' : `${next.doneLast24h - prev.doneLast24h} tickets finished`, 'done');
    }
    if (next.needs > prev.needs) {
      burst(counterEls['need you'], false);
      showToast('New item needs you', 'think');
    }
    if (failTotal(next) > failTotal(prev)) {
      stageApi.flick();
      if (stageGeom[0]) stageApi.sparkAt(stageGeom[0], '#ffb62e');
      burst(ringfx, true);
      showToast('A run failed', 'think');
    }
  }

  function paint() {
    const next = panels.deriveHiveView(currentSnapshot());
    prevView = view;
    view = next;
    paintCounters(view);
    paintCore(view);
    paintFoot(view);
    const rebuilt = paintCards(view);
    const minute = Math.floor(deps.now() / 60000);
    const psig = JSON.stringify([view.projects.map((p) => [p.id, p.counts, p.pct]), view.events, view.throughput, view.lanes, view.prs, view.totals, view.needs, view.spend, view.doneLast24h, view.machines, view.projectsTotal, minute]);
    if (psig !== panelSig) {
      panelSig = psig;
      destroyHeads(panelHeads);
      const out = panels.renderHiveDashboard(panelsRoot, view, {
        nowMs: deps.now(),
        mountHead,
        onHeadHover: (el) => burst(el, false),
      });
      panelHeads = out.heads || [];
    }
    layout();
    if (rebuilt) setPauseUi();
    reactToChange(prevView, view);
  }

  /* ---- full-body fetch while the shared parser drops card fields ---- */
  function loadRaw() {
    if (typeof win.fetch !== 'function' || rawBusy || parsedRef.hive) return;
    rawBusy = true;
    win.fetch(RAW_URL, { method: 'GET', cache: 'no-store', headers: { 'x-watch-token': readWatchToken(win) } })
      .then((res) => (res && res.ok ? res.json() : null))
      .then((body) => {
        rawBusy = false;
        if (destroyed || !body) return;
        rawRef = body;
        paint();
        restart();
      })
      .catch(() => { rawBusy = false; });
  }

  /* ---- wiring ---- */
  addListener(crumbHive, 'click', () => { if (typeof win.scrollTo === 'function') win.scrollTo({ top: 0, behavior: 'smooth' }); });
  addListener(tabCockpit, 'click', (e) => {
    if (e && (e.metaKey || e.ctrlKey || e.shiftKey || e.button)) return;
    const first = view && view.projects[0];
    if (!first) return;
    if (e && typeof e.preventDefault === 'function') e.preventDefault();
    openProject(first.id);
  });
  addListener(searchBtn, 'click', () => {
    if (typeof win.KeyboardEvent !== 'function' || typeof doc.dispatchEvent !== 'function') return;
    const mac = /mac|iphone|ipad/i.test(String(win.navigator?.platform || ''));
    doc.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'k', ctrlKey: !mac, metaKey: mac, bubbles: true }));
  });
  addListener(tourBtn, 'click', () => {
    if (isTourDisabledByQuery(win.location)) return;
    const storage = { getItem: (k) => { try { return win.localStorage?.getItem(k) ?? null; } catch { return null; } }, setItem: (k, v) => { try { win.localStorage?.setItem(k, v); } catch { /* ignore */ } } };
    startTour({ doc, storage, userId: 'anonymous', replay: hasCompleted(storage, 'anonymous') });
  });
  const togglePause = () => {
    userPaused = !userPaused;
    setPauseUi();
    restart();
  };
  addListener(pauseBtn, 'click', togglePause);
  addListener(doc, 'keydown', (e) => {
    if (e.key === 'p' && !e.metaKey && !e.ctrlKey && !e.altKey) {
      const t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
      e.preventDefault();
      togglePause();
    }
  });
  addListener(doc, 'visibilitychange', () => {
    setPauseUi();
    if (hidden()) {
      deps.cancelAnimationFrame(rafId);
      rafId = 0;
      drawStillFrame();
    } else restart();
  });
  if (reducedMq?.addEventListener) addListener(reducedMq, 'change', () => { setPauseUi(); restart(); });
  addListener(win, 'resize', () => {
    if (!view) return;
    layout();
    restart();
    if (!shouldAnimate()) drawStillFrame();
  });
  if (typeof win.IntersectionObserver === 'function') {
    const io = new win.IntersectionObserver((entries) => { hiveVisible = entries[0].isIntersecting; });
    io.observe(stage);
    listeners.push({ target: { removeEventListener() { io.disconnect(); } }, type: '', handler: null });
  }

  paint();
  setPauseUi();
  loadRaw();
  restart();

  return {
    update(nextSnapshot) {
      parsedRef = nextSnapshot;
      paint();
      restart();
      loadRaw();
    },
    destroy() {
      destroyed = true;
      deps.cancelAnimationFrame(rafId);
      rafId = 0;
      if (typeof win.clearTimeout === 'function') for (const id of timers) win.clearTimeout(id);
      timers.length = 0;
      clearCards();
      destroyHeads(panelHeads);
      for (const l of listeners) l.target.removeEventListener(l.type, l.handler, l.options);
      listeners.length = 0;
      while (host.firstChild) host.removeChild(host.firstChild);
    },
  };
}
