// SPDX-License-Identifier: Apache-2.0
// The board (swarm watch --all): Overview, Cost, Agents, Events. Read-only; every number and every agent state comes from /api/board and /api/history.
// Text is always set with textContent (never as HTML). Nothing here invents progress: an empty list says so.
import { mountRobotHead, setAnimationPaused, animationPaused, reducedMotion } from './robot-head.js';
import { renderOrchestrator, buildMixText, doingText } from './orchestrator-view.js';

var L = self.BoardLib;
var TOKEN = new URLSearchParams(location.search).get('t') || '';
var T = encodeURIComponent(TOKEN);
var $ = function (id) { return document.getElementById(id); };
var store = {
  get: function (k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
  set: function (k, v) { try { localStorage.setItem(k, v); } catch (e) { /* kept for this visit only */ } }
};

var state = { data: null, lastOk: 0, tab: 'overview', scratch: store.get('swarm-scratch') === '1', seen: [], rendered: null, firstRender: true, readTimer: null };
try { state.seen = JSON.parse(store.get('swarm-seen') || '[]'); if (!Array.isArray(state.seen)) { state.seen = []; } } catch (e) { state.seen = []; }

function el(tag, cls, text) { var n = document.createElement(tag); if (cls) { n.className = cls; } if (text !== undefined && text !== null) { n.textContent = text; } return n; }
function usd(v) { return typeof v === 'number' && isFinite(v) ? '$' + (v > 0 && v < 0.01 ? v.toFixed(4) : v.toFixed(2)) : '-'; }
function ago(iso) {
  var t = Date.parse(iso);
  if (!isFinite(t)) { return 'never'; }
  var m = Math.max(0, Math.round((Date.now() - t) / 60000));
  return m < 1 ? 'just now' : m < 60 ? m + ' min ago' : m < 2880 ? Math.round(m / 60) + ' h ago' : Math.round(m / 1440) + ' d ago';
}
function clock(ms) { return new Date(ms).toLocaleTimeString([], { hour12: false }); }
function runHref(projectId, runId) { return '/run?id=' + encodeURIComponent(projectId) + '&run=' + encodeURIComponent(runId) + '&t=' + T; }
function watchHref(projectId, runId) { if (state.data && state.data.openRun === false) { return runHref(projectId, runId); } return '/open/run?id=' + encodeURIComponent(projectId) + '&run=' + encodeURIComponent(runId) + '&t=' + T; }
function projectHref(projectId) { return '/project?id=' + encodeURIComponent(projectId) + '&t=' + T; }
function link(href, cls, parts) { var a = el('a', cls); a.href = href; parts.forEach(function (p) { a.appendChild(p); }); return a; }
function pill(text, cls) { return el('span', 'pill ' + (cls || 'info'), text); }
function meter(pct, hot) { var m = el('div', 'meter' + (hot ? ' hot' : '')); var i = el('i'); i.style.width = Math.max(0, Math.min(100, pct)) + '%'; m.appendChild(i); m.setAttribute('role', 'img'); m.setAttribute('aria-label', Math.round(pct) + ' percent'); return m; }
function dot(cls) { return el('span', 'dot' + (cls ? ' ' + cls : '')); }
function th(cells) { var tr = el('tr'); cells.forEach(function (c) { var h = el('th', '', c); h.scope = 'col'; tr.appendChild(h); }); var head = el('thead'); head.appendChild(tr); return head; }
function td(child, cls) { var c = el('td', cls || ''); if (typeof child === 'string') { c.textContent = child; } else if (child) { c.appendChild(child); } return c; }

// ---- tabs, hash, keyboard ----------------------------------------------------------------------------------------------------------------------

// Tabs are plain hash links (#tab=cost): the Back button moves between them and nothing else is needed. A click or key changes the hash; the hashchange
// handler does the switch, so there is one path.
function go(tab) { if (location.hash === '#tab=' + tab) { setTab(tab); } else { location.hash = 'tab=' + tab; } }
function setTab(tab) {
  if (L.TABS.indexOf(tab) === -1) { tab = 'overview'; }
  state.tab = tab;
  L.TABS.forEach(function (name) {
    var on = name === tab;
    $('tab-' + name).hidden = !on;
    var b = $('tab-' + name + '-btn');
    b.setAttribute('aria-selected', on ? 'true' : 'false');
    b.tabIndex = on ? 0 : -1;
  });
  if (tab === 'events') { loadHistory(); if (state.focusSearch) { state.focusSearch = false; $('q').focus(); } }
  if (state.data) { renderTab(); }
  watchNeedsVisible();
}
function applyHash() {
  var h = L.parseHash(location.hash);
  if (h.run) {
    var href = runHref(h.run.projectId, h.run.runId);
    // The first visit goes straight to the run. When the person comes back with the Back button the same link is still in the address, so it is not followed
    // again: a banner offers it instead (otherwise Back would bounce forward forever).
    var done = null;
    try { done = sessionStorage.getItem('swarm-deeplink'); } catch (e) { done = null; }
    if (done !== location.hash) { try { sessionStorage.setItem('swarm-deeplink', location.hash); } catch (e) { /* the banner then shows next time */ } location.assign(href); return; }
    $('deeplinkText').textContent = 'This address points at run ' + h.run.runId + '.';
    $('deeplinkGo').href = href; $('deeplink').hidden = false;
    setTab('overview');
    return;
  }
  $('deeplink').hidden = true;
  setTab(h.tab || 'overview');
}
$('tabs').addEventListener('click', function (e) { var b = e.target.closest('[data-tab]'); if (b) { go(b.dataset.tab); } });
$('tabs').addEventListener('keydown', function (e) {
  var i = L.TABS.indexOf(state.tab), n = null;
  if (e.key === 'ArrowRight') { n = L.TABS[(i + 1) % L.TABS.length]; } else if (e.key === 'ArrowLeft') { n = L.TABS[(i + L.TABS.length - 1) % L.TABS.length]; }
  if (n) { go(n); $('tab-' + n + '-btn').focus(); e.preventDefault(); }
});
window.addEventListener('hashchange', applyHash);

var helpOpener = null;
function toggleHelp(open) {
  var box = $('help');
  var show = open === undefined ? box.hidden : open;
  box.hidden = !show;
  if (show) { helpOpener = document.activeElement; $('helpClose').focus(); } else if (helpOpener && helpOpener.focus) { helpOpener.focus(); }
}
$('helpBtn').addEventListener('click', function () { toggleHelp(true); });
$('helpClose').addEventListener('click', function () { toggleHelp(false); });
$('help').addEventListener('click', function (e) { if (e.target === $('help')) { toggleHelp(false); } });
$('help').addEventListener('keydown', function (e) { if (e.key === 'Tab') { e.preventDefault(); $('helpClose').focus(); } });

document.addEventListener('keydown', function (e) {
  if (e.ctrlKey || e.metaKey || e.altKey) { return; }
  var t = e.target, typing = t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
  if (e.key === 'Escape') { if (!$('help').hidden) { toggleHelp(false); } else if (typing && t.blur) { t.blur(); } return; }
  if (typing) { return; }
  if (e.key >= '1' && e.key <= '4') { go(L.TABS[Number(e.key) - 1]); e.preventDefault(); }
  else if (e.key === '/') { state.focusSearch = true; go('events'); e.preventDefault(); }
  else if (e.key === '?') { toggleHelp(); e.preventDefault(); }
  else if (e.key === 'u') { markRead(); }
  else if (e.key === 'p') { togglePause(); }
});

// ---- motion ------------------------------------------------------------------------------------------------------------------------------------

function applyPause(paused) {
  setAnimationPaused(paused);
  document.body.classList.toggle('paused-motion', paused);
  var b = $('pauseMotion');
  b.setAttribute('aria-pressed', paused ? 'true' : 'false');
  b.textContent = paused ? 'Resume motion' : 'Pause motion';
}
function togglePause() { var next = !(animationPaused() && store.get('swarm-paused') === '1'); store.set('swarm-paused', next ? '1' : '0'); applyPause(next); }
$('pauseMotion').addEventListener('click', togglePause);
applyPause(store.get('swarm-paused') === '1');
if (reducedMotion()) { $('pauseMotion').hidden = true; }

// ---- heads: one per agent, reused between polls so they keep animating -----------------------------------------------------------------------

var HEAD_STATE = { working: 'working', thinking: 'thinking', error: 'error', sleeping: 'sleeping' };
function headSpec(a) { return { key: a.runId + '|' + a.jobId, state: HEAD_STATE[a.state] || 'idle', lane: a.lane }; }
function syncHeads(host, specs, size, withLabels, labelOf) {
  var map = host.__heads || (host.__heads = new Map());
  var keep = {};
  specs.forEach(function (s) {
    keep[s.key] = true;
    var hit = map.get(s.key);
    if (hit) { hit.handle.setState(s.state); if (hit.label && labelOf) { hit.label.textContent = labelOf(s); } return; }
    var wrap = el('div', 'agent');
    var holder = el('div');
    wrap.appendChild(holder);
    var color = L.laneColor(s.lane);
    var handle = mountRobotHead(holder, { state: s.state, size: size, color: color, screenColor: s.state === 'error' ? '#ffc4c4' : '#e8f2ff', id: s.key, label: s.lane + ' agent, ' + s.state });
    var label = null;
    if (withLabels) { label = el('div', 'jid mono', labelOf ? labelOf(s) : ''); wrap.appendChild(label); }
    host.appendChild(wrap);
    map.set(s.key, { wrap: wrap, handle: handle, label: label });
  });
  map.forEach(function (v, k) { if (!keep[k]) { v.handle.destroy(); v.wrap.remove(); map.delete(k); } });
}

// ---- overview ----------------------------------------------------------------------------------------------------------------------------------

function tile(title, big, sub, extra) {
  var t = el('div', 'card kpi');
  t.appendChild(el('div', 'l', title)); t.appendChild(el('div', 'v num', big)); t.appendChild(el('div', 's', sub));
  if (extra) { t.appendChild(extra); }
  return t;
}
function renderKpis(m) {
  var box = $('kpis'); box.textContent = '';
  var c = m.cost;
  var seg = el('div', 'seg');
  Object.keys(m.agents.byLane).forEach(function (lane) { if (m.agents.byLane[lane]) { var i = el('i'); i.style.flex = String(m.agents.byLane[lane]); i.style.background = L.laneColor(lane); seg.appendChild(i); } });
  box.appendChild(tile('Live agents', String(m.agents.total), m.liveRuns + ' live run' + (m.liveRuns === 1 ? '' : 's') + (L.agentCounts(m).unshown ? ', ' + L.agentCounts(m).held + ' worker slots held' : ''), m.agents.total ? seg : null));
  box.appendChild(tile('Billed today', usd(c.todayUsd), 'last 7 days billed ' + usd(c.weekUsd)));
  box.appendChild(tile('List value today', usd(c.flatRateTodayUsd), 'flat-rate lanes, not billed; 7 days ' + usd(c.flatRateWeekUsd)));
  box.appendChild(tile('Billed, all time', usd(c.paidUsd), 'of which estimated ' + usd(c.paidEstimatedUsd)));
  box.appendChild(tile('List value, all time', usd(c.flatRateListUsd), 'not billed'));
  var w = m.workers;
  if (w) {
    var limit = w.invalid ? 'LIMIT INVALID' : w.max ? w.total + ' / ' + w.max : String(w.total);
    var bar = w.max && !w.invalid ? meter(100 * w.total / w.max, w.total >= w.max) : null;
    box.appendChild(tile('Workers held', limit, w.invalid ? 'fix machineConcurrency: runs will not start' : w.max ? 'machine limit ' + w.max + ', shared fairly between active projects, ' + (w.free === null ? 0 : w.free) + ' free' : 'no machine limit', bar));
  }
  var note = $('totalsNote'); note.textContent = m && state.data && Array.isArray(state.data.machines) && state.data.machines.length > 1 ? 'Totals above are this machine only' : '';
}
function renderOrch(m) {
  var o = m.orchestrator || { sessions: [] };
  $('orchCount').textContent = String(o.sessions.filter(function (x) { return x.state !== 'idle' && x.state !== 'ended'; }).length);
  renderOrchestrator($('orchBay'), o.sessions, { now: Date.now() });
  var mix = o.swarmPct === null || o.swarmPct === undefined ? '' : 'All projects: swarm-built ' + o.swarmPct + '%, hand-built ' + o.handPct + '% (' + o.handBuiltFiles + ' file' + (o.handBuiltFiles === 1 ? '' : 's') + ' edited by hand).';
  $('orchNote').textContent = mix;
}
function renderBays(m) {
  var host = $('bays');
  var bays = L.bays(m.agents.list, Object.keys(m.agents.byLane));
  var map = host.__bays || (host.__bays = new Map());
  var names = Object.create(null);
  bays.forEach(function (b) { names[b.lane] = true; });
  map.forEach(function (v, lane) { if (!names[lane]) { v.heads.__heads && v.heads.__heads.forEach(function (h) { h.handle.destroy(); }); v.node.remove(); map.delete(lane); } });
  bays.forEach(function (b, idx) {
    var hit = map.get(b.lane);
    if (!hit) {
      var node = el('div', 'bay'); node.style.setProperty('--c', L.laneColor(b.lane));
      var top = el('div', 'top'); var name = el('span', 'name', b.lane); var n = el('span', 'n num', '0'); top.appendChild(name); top.appendChild(n);
      var why = el('div', 'sub why-idle'); var heads = el('div', 'heads'); node.appendChild(top); node.appendChild(why); node.appendChild(heads);
      hit = { node: node, n: n, why: why, heads: heads }; map.set(b.lane, hit); host.appendChild(node);
    }
    hit.n.textContent = String(b.running);
    hit.node.classList.toggle('idle', b.idle);
    var idleReason = b.idle && m.laneIdle ? m.laneIdle[b.lane] : null;
    hit.why.hidden = !idleReason;
    hit.why.textContent = idleReason ? idleReason.text : '';
    hit.why.title = idleReason ? idleReason.text : '';
    hit.why.classList.toggle('warn', Boolean(idleReason && ['rate-limited', 'paused', 'daily-cap'].indexOf(idleReason.reason) !== -1));
    hit.node.title = idleReason ? idleReason.text : '';
    var specs = b.idle ? [{ key: 'sleep|' + b.lane, state: 'sleeping', lane: b.lane }] : b.agents.slice(0, 10).map(headSpec);
    syncHeads(hit.heads, specs, 34, false);
    var more = b.agents.length - 10;
    var extra = hit.heads.querySelector('.more');
    if (more > 0) { if (!extra) { extra = el('span', 'sub more'); hit.heads.appendChild(extra); } extra.textContent = '+' + more; } else if (extra) { extra.remove(); }
    host.appendChild(hit.node);
  });
}
function capCell(p) {
  var s = p.spend, box = el('div');
  function breakdown() {
    box.appendChild(el('div', 'sub', 'billed ' + usd(s.billedUsd) + ' · list value ' + usd(s.listUsd) + ' (not billed)'));
    box.appendChild(el('div', 'sub', 'cap counts: ' + (s.capBasis === 'billed' ? 'billed only' : 'billed + list value')));
  }
  if (s.capUsd) {
    var used = typeof s.capUsedUsd === 'number' ? s.capUsedUsd : (s.sharedTrees > 1 && typeof s.familyUsd === 'number' ? s.familyUsd : s.usd);
    box.appendChild(meter(100 * used / s.capUsd, used / s.capUsd > 0.75));
    box.appendChild(el('span', 'mono sub', usd(used) + ' of ' + usd(s.capUsd)));
    breakdown();
    if (s.sharedTrees > 1) { box.appendChild(el('div', 'sub', 'shared by ' + s.sharedTrees + ' trees (this one ' + usd(s.capBasis === 'billed' ? s.billedUsd : s.usd) + ')')); }
    if (s.capInherited) { box.appendChild(el('div', 'sub', 'cap inherited from ' + String(s.inheritedFrom || '').split(/[\\/]/).pop())); }
  } else {
    var r = el('div', 'livebar'); r.appendChild(pill(s.capInvalid ? 'CAP INVALID' : 'NO CAP', s.capInvalid ? 'bad' : 'warn')); box.appendChild(r);
    breakdown();
  }
  if (s.reached) { box.appendChild(pill('CAP REACHED', 'bad')); }
  if (s.why) { box.appendChild(el('div', 'sub why', 'Why capped: ' + s.why)); }
  return box;
}
function liveCell(p) {
  var box = el('div');
  if (p.remote) {
    box.appendChild(el('span', 'sub', p.live.length ? p.live.length + ' live run' + (p.live.length === 1 ? '' : 's') + ' on ' + (p.machine || 'peer') + ' board' : 'remote project'));
    return box;
  }
  if (!p.live.length) { box.appendChild(el('span', 'sub', 'idle, last run ' + ago(p.lastRunAt))); return box; }
  p.live.forEach(function (r) {
    var row = el('div', 'livebar');
    row.appendChild(dot());
    var a = link(runHref(p.id, r.runId), 'board-link mono', [el('span', '', r.runId.length > 18 ? r.runId.slice(0, 8) + '…' + r.runId.slice(-6) : r.runId)]);
    a.title = 'Open the run inspector: ' + r.runId;
    row.appendChild(a);
    row.appendChild(meter(r.jobs ? 100 * r.done / r.jobs : 0));
    row.appendChild(el('span', 'num mono', r.done + '/' + r.jobs));
    var w = link(watchHref(p.id, r.runId), 'sub', [el('span', '', 'Watch')]);
    row.appendChild(w);
    box.appendChild(row);
  });
  return box;
}
function laneDots(p) {
  var d = el('div', 'livebar');
  Object.keys(p.agents.byLane).forEach(function (lane) { for (var i = 0; i < Math.min(p.agents.byLane[lane], 8); i += 1) { var s = el('i'); s.style.cssText = 'width:9px;height:9px;border-radius:3px;display:block;background:' + L.laneColor(lane); s.title = lane; d.appendChild(s); } });
  if (!d.childNodes.length) { d.appendChild(el('span', 'sub', '-')); }
  return d;
}
function progressLine(p) {
  var progress = p.progress;
  if (!progress) { return null; }
  var value = typeof progress.overall === 'number' ? progress.overall : 0;
  var label = progress.finished ? 'Finished' : (progress.overall === null || progress.overall === undefined ? 'Unknown' : String(progress.overall) + '%');
  var eta = progress.eta === null || progress.eta === undefined ? '' : ' · ETA ' + progress.eta + 'd';
  var offLedger = typeof progress.offLedger === 'number' ? progress.offLedger : progress.offLedger && progress.offLedger.count || 0;
  var offLedgerText = offLedger > 0 ? ' · ' + offLedger + ' off-ledger run' + (offLedger === 1 ? '' : 's') : '';
  var line = el('div', 'sub progress-line');
  line.appendChild(meter(value));
  line.appendChild(el('span', '', label + ' · ' + (progress.current || 'Unknown') + eta + offLedgerText));
  return line;
}
function splitLine(p) {
  if (!p.split || p.split.grade === 'unknown') { return null; }
  var text = 'Split ' + p.split.grade + (p.split.reds ? ' · ' + p.split.reds + ' red' : '') + (p.split.worst ? ' · ' + p.split.worst : '');
  return el('div', 'sub split-' + p.split.grade, text);
}
function handledLine(p) { return p.handled && p.handled.today ? el('div', 'sub', p.handled.today + ' handled for you today') : null; }
function peerForProject(p) {
  if (!p || !p.remote) { return null; }
  var peers = state.data && Array.isArray(state.data.peers) ? state.data.peers : [];
  return peers.find(function (peer) {
    if (!peer) { return false; }
    if (peer.name === p.machine || peer.name === p.name) { return true; }
    try { return new URL(peer.url).hostname === p.machine; } catch (e) { return false; }
  }) || null;
}
function cleanPeerUrl(peer) {
  if (!peer || typeof peer.url !== 'string') { return null; }
  try { var u = new URL(peer.url); u.search = ''; u.hash = ''; return u.toString(); } catch (e) { return null; }
}
function projectName(p, label) {
  var text = el('span', '', label);
  var peer = peerForProject(p);
  if (!p.remote) { return link(projectHref(p.id), 'name board-link', [text]); }
  var href = cleanPeerUrl(peer);
  if (!href) { return text; }
  var a = link(href, 'name board-link', [text]);
  a.target = '_blank'; a.rel = 'noopener'; a.title = 'open on ' + p.machine;
  return a;
}
function machineLine(p) {
  var line = el('div', 'sub', (p.machine || '-') + ' · v' + (p.version || '-'));
  if (p.versionDrift) { var newest = state.data && state.data.drift ? state.data.drift.newest : null; var drift = pill('version drift', 'warn'); drift.title = 'this machine runs v' + (p.version || '-') + '; newest is v' + (newest || '-'); line.appendChild(el('span', '', ' ')); line.appendChild(drift); }
  return line;
}
function pinnedBadge(p) {
  if (!p.pinnedVersion) { return null; }
  return pill('pinned at ' + p.pinnedVersion, 'info');
}
function appendPinnedBadge(parent, p) {
  var badge = pinnedBadge(p);
  if (!badge) { return; }
  parent.appendChild(el('span', '', ' '));
  parent.appendChild(badge);
}
function renderProjects(projects) {
  var psig = L.signature({ projects: projects, machines: state.data && state.data.machines, peers: state.data && state.data.peers, drift: state.data && state.data.drift }, Math.floor(Date.now() / 60000));
  if (psig === state.projSig) { return; }
  state.projSig = psig;
  var byId = Object.create(null); projects.forEach(function (p) { byId[p.id] = p; });
  var compare = function (a, b) { return (b.live.length - a.live.length) || String(b.lastActivityAt).localeCompare(String(a.lastActivityAt)); };
  var childCompare = function (a, b) { return String(a.name).localeCompare(String(b.name)) || compare(a, b); };
  var top = projects.filter(function (p) { return !p.parentId || !byId[p.parentId]; }).sort(compare);
  var sorted = [];
  top.forEach(function (p) {
    sorted.push({ project: p, worktree: false });
    projects.filter(function (child) { return child.parentId === p.id; }).sort(childCompare).forEach(function (child) { sorted.push({ project: child, worktree: true }); });
  });
  var table = $('projTable'); table.textContent = '';
  var cards = $('projCards'); cards.textContent = '';
  if (!sorted.length) { var none = 'No projects yet. Run a swarm command inside a project, or swarm projects add PATH.'; $('projTable').appendChild(el('caption', 'empty', none)); cards.appendChild(el('div', 'empty', none)); cards.classList.add('show'); }
  else { cards.classList.remove('show'); table.appendChild(th(['Project', 'Live runs', 'Jobs', 'Tickets', 'Spend and cap', 'Lanes', 'Last activity'])); }
  var machines = state.data && Array.isArray(state.data.machines) ? state.data.machines : [];
  var machinesNote = $('machinesNote'); machinesNote.textContent = '';
  var machineText = machines.map(function (m) { return m.name + ' (v' + (m.version || '-') + (m.ok === false ? ', unreachable' : '') + ')'; }).join(' · ');
  machinesNote.appendChild(el('span', '', 'Machines: ' + (machineText || 'none')));
  if (state.data && state.data.drift && state.data.drift.drifted) { machinesNote.appendChild(el('span', '', ' ')); machinesNote.appendChild(pill('version drift: ' + state.data.drift.versions.join(', '), 'warn')); }
  var body = el('tbody');
  sorted.forEach(function (entry) {
    var p = entry.project, isWorktree = entry.worktree;
    var tr = el('tr'); if (isWorktree) { tr.className = 'wt'; }
    var name = el('div'); name.appendChild(projectName(p, (isWorktree ? '↳ ' : '') + p.name)); name.appendChild(el('span', '', ' ')); name.appendChild(el('span', 'stage', isWorktree ? 'worktree' : (p.stage ? 'stage ' + p.stage : 'no stage'))); appendPinnedBadge(name, p); name.appendChild(machineLine(p));
    var tableProgress = progressLine(p); if (tableProgress) { name.appendChild(tableProgress); }
    var tableSplit = splitLine(p); if (tableSplit) { name.appendChild(tableSplit); }
    var tableHandled = handledLine(p); if (tableHandled) { name.appendChild(tableHandled); }
    (p.warnings || []).forEach(function (w) { name.appendChild(el('div', 'sub', '')); name.lastChild.appendChild(pill(w.text, 'warn')); });
    var mixText = buildMixText(p.orchestrator); if (mixText) { name.appendChild(el('div', 'sub', '')); name.lastChild.appendChild(pill(mixText, p.orchestrator.handPct > 0 ? 'warn' : 'good')); }
    tr.appendChild(td(name)); tr.appendChild(td(liveCell(p), 'wrap'));
    tr.appendChild(td(p.agents.jobs.running + ' run, ' + p.agents.jobs.queued + ' q, ' + p.agents.jobs.blocked + ' blk', 'mono'));
    tr.appendChild(td(p.tickets.open + ' open' + (p.tickets.blocked ? ', ' + p.tickets.blocked + ' blocked' : ''), 'mono'));
    tr.appendChild(td(capCell(p))); tr.appendChild(td(laneDots(p))); tr.appendChild(td(ago(p.lastActivityAt), 'mono'));
    body.appendChild(tr);
    var c = el('div', 'pcard');
    var head = el('div', 'row'); head.appendChild(projectName(p, (isWorktree ? '↳ ' : '') + p.name)); head.appendChild(el('span', 'stage', isWorktree ? 'worktree' : (p.stage ? 'stage ' + p.stage : 'no stage'))); appendPinnedBadge(head, p); c.appendChild(head); c.appendChild(machineLine(p));
    var cardProgress = progressLine(p); if (cardProgress) { c.appendChild(cardProgress); }
    var cardSplit = splitLine(p); if (cardSplit) { c.appendChild(cardSplit); }
    var cardHandled = handledLine(p); if (cardHandled) { c.appendChild(cardHandled); }
    (p.warnings || []).forEach(function (w) { var wl = el('div', 'sub'); wl.appendChild(pill(w.text, 'warn')); c.appendChild(wl); });
    var mixCard = buildMixText(p.orchestrator); if (mixCard) { var ml = el('div', 'sub'); ml.appendChild(pill(mixCard, p.orchestrator.handPct > 0 ? 'warn' : 'good')); c.appendChild(ml); }
    if (p.idleWithReady) { var idleReady = el('div', 'sub'); idleReady.appendChild(pill('Idle with ' + p.readyTickets + ' ready tickets', 'bad')); c.appendChild(idleReady); }
    c.appendChild(liveCell(p));
    var meta = el('div', 'row'); meta.appendChild(el('span', 'mono', p.tickets.open + ' open' + (p.tickets.blocked ? ', ' + p.tickets.blocked + ' blocked' : ''))); meta.appendChild(el('span', 'mono', ago(p.lastActivityAt))); c.appendChild(meta);
    c.appendChild(capCell(p));
    cards.appendChild(c);
  });
  table.appendChild(body);
}

// ---- needs you (unread badges) -------------------------------------------------------------------------------------------------------------------

function persistSeen() { store.set('swarm-seen', JSON.stringify(state.seen)); }
function markRead() {
  var inbox = state.data && state.data.inbox;
  if (!inbox) { return; }
  var keys = L.unread(inbox.items, state.seen);
  if (!keys.length) { return; }
  state.seen = L.remember(state.seen, keys, 500);
  persistSeen();
  renderNeeds(inbox);
}
function watchNeedsVisible() {
  clearTimeout(state.readTimer);
  if (state.tab !== 'overview' || document.hidden) { return; }
  // Reading counts: the panel stays on screen for a moment while the page has focus.
  state.readTimer = setTimeout(function () {
    var r = $('needsCard').getBoundingClientRect();
    if (state.tab === 'overview' && !document.hidden && r.top < innerHeight * 0.85 && r.bottom > 40) { markRead(); }
  }, 2500);
}
document.addEventListener('visibilitychange', watchNeedsVisible);
$('markRead').addEventListener('click', markRead);
$('needsChip').addEventListener('click', function () { go('overview'); $('needsCard').scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth', block: 'start' }); });

function renderNeeds(inbox) {
  var box = $('needs'); box.textContent = '';
  var items = inbox && inbox.items ? inbox.items : [];
  var fresh = L.unread(items, state.seen);
  var keysNow = {};
  items.forEach(function (it) { keysNow[L.itemKey(it)] = true; });
  var chipEl = $('needsChip'), total = inbox ? inbox.total : 0;
  var said = total + ' need you' + (fresh.length ? ', ' + fresh.length + ' new' : '');
  if (chipEl.textContent !== said) { chipEl.textContent = said; if (state.announced !== undefined) { $('announce').textContent = said; } }
  state.announced = said;
  var sig = L.signature({ inbox: inbox, seen: state.seen }, Math.floor(Date.now() / 60000));
  if (sig === state.needsSig) { return; }   // nothing changed: leave the page as it is, so keyboard focus stays where it is
  state.needsSig = sig;
  chipEl.setAttribute('aria-label', total + ' need you' + (fresh.length ? ', ' + fresh.length + ' new' : ''));
  chipEl.style.borderColor = total ? '#6b5614' : '';
  $('needsBadge').hidden = !fresh.length; $('needsBadge').textContent = String(fresh.length);
  $('markRead').hidden = !fresh.length;
  document.title = (fresh.length ? '(' + fresh.length + ') ' : '') + 'Swarm Watch: all projects';
  if (!items.length) { box.appendChild(el('div', 'empty', 'Nothing needs you.')); }
  items.forEach(function (it) {
    var key = L.itemKey(it);
    var isNew = fresh.indexOf(key) !== -1;
    var row = el('div', 'need ' + it.kind.split('-')[0] + (isNew && !state.firstRender && state.rendered && !state.rendered[key] ? ' fresh' : ''));
    var head = el('div', 'need-head');
    if (isNew) { var fd = el('span', 'fresh-dot'); fd.title = 'New'; head.appendChild(fd); head.appendChild(el('span', 'sr', 'New: ')); }
    head.appendChild(pill(it.kind.replace('-', ' '), it.kind === 'blocker' ? 'bad' : 'warn'));
    head.appendChild(link(projectHref(it.projectId), 'board-link', [el('span', 'name', it.project)]));
    head.appendChild(el('span', 'mono sub', 'waiting ' + ago(it.since).replace(' ago', '')));
    if (it.unblocks) { head.appendChild(el('span', 'mono sub', 'unblocks ' + it.unblocks)); }
    if (it.phone) { head.appendChild(pill('on your phone (' + it.phone.status + ')' + (it.phone.expiresAt && it.phone.status !== 'expired' ? ', expires ' + L.countdown(it.phone.expiresAt, Date.now()) : ''), 'lav')); }
    row.appendChild(head);
    row.appendChild(el('div', 'need-title', it.title || ''));
    if (it.choices && it.choices.length) { row.appendChild(el('div', 'note', 'Choices: ' + it.choices.join(', '))); }
    if (it.kind === 'proposed-ticket' && !it.filesNamed) { row.appendChild(el('div', 'note', 'Needs its files named before it can be approved' + (it.origin ? ' (from ' + it.origin + ')' : '') + '.')); }
    if (it.next) { row.appendChild(el('div', 'need-next', it.next)); }
    (it.commands || []).forEach(function (c) {
      var cmd = el('div', 'need-cmd');
      cmd.appendChild(el('span', 'need-label', c.label));
      cmd.appendChild(el('code', 'mono', c.cmd));
      var btn = el('button', 'copy', 'Copy'); btn.type = 'button';
      btn.addEventListener('click', function () {
        function done() { btn.textContent = 'Copied'; setTimeout(function () { btn.textContent = 'Copy'; }, 1500); }
        if (navigator.clipboard && navigator.clipboard.writeText) { navigator.clipboard.writeText(c.cmd).then(done, function () { btn.textContent = 'Select it'; }); } else { btn.textContent = 'Select it'; }
      });
      cmd.appendChild(btn); row.appendChild(cmd);
    });
    box.appendChild(row);
  });
  state.rendered = keysNow;
  var fyi = inbox && inbox.fyi ? inbox.fyi : [];
  var fl = $('fyiList'); fl.textContent = '';
  $('fyi').hidden = !fyi.length;
  $('fyiSummary').textContent = fyi.length + ' FYI note' + (fyi.length === 1 ? '' : 's') + ' (no action needed, not counted)';
  fyi.forEach(function (n) { var r = el('div', 'fyi-row'); r.appendChild(el('div', 'mono sub', n.project + ' | ' + ago(n.since))); r.appendChild(el('div', 'need-title', n.title || '')); fl.appendChild(r); });
  if (inbox && inbox.hidden) { box.appendChild(el('div', 'note', inbox.hidden + ' more not shown (the list is cut at 50 per project): swarm inbox --all')); }
  var ph = inbox && inbox.phone;
  $('needsNote').textContent = 'Read-only: the board never answers anything. Run the command at your computer' + (ph ? ph.on ? ', or answer on your phone (' + ph.open + ' question' + (ph.open === 1 ? '' : 's') + ' open in ' + ph.repo + ').' : '. Phone questions are switched off.' : '. Phone answers are not set up (swarm phone setup).') + (inbox && inbox.problems && inbox.problems.length ? ' Could not read: ' + inbox.problems.map(function (p) { return p.project; }).join(', ') + '.' : '');
}

// ---- cost ----------------------------------------------------------------------------------------------------------------------------------------

function renderCost(data) {
  var csig = L.signature({ m: data.machine, p: data.projects }, Math.floor(Date.now() / 60000));
  if (csig === state.costSig) { return; }
  state.costSig = csig;
  var c = data.machine.cost;
  var k = $('costKpis'); k.textContent = '';
  k.appendChild(tile('Billed today', usd(c.todayUsd), 'billed lanes and rented GPUs'));
  k.appendChild(tile('Billed, 7 days', usd(c.weekUsd), 'billed lanes and rented GPUs'));
  k.appendChild(tile('Billed, all time', usd(c.paidUsd), 'estimated part ' + usd(c.paidEstimatedUsd)));
  k.appendChild(tile('Flat-rate list value', usd(c.flatRateListUsd), 'Codex, Cursor, Claude subscription: not billed'));
  var oc = data.machine.orchestrator || { todayListUsd: 0, allListUsd: 0 };
  k.appendChild(tile('Orchestrator, list value', usd(oc.todayListUsd), 'today; ' + usd(oc.allListUsd) + ' all time. Subscription: not billed, not in the totals above'));
  k.appendChild(tile('Estimated full cost', usd(c.paidUsd + c.flatRateListUsd), 'billed plus list value: what the work would cost at list prices'));
  var ot = $('orchTable'); ot.textContent = '';
  var os = (data.machine.orchestrator && data.machine.orchestrator.sessions) || [];
  if (!os.length) { ot.appendChild(el('caption', 'empty', 'No orchestrator session has been seen yet.')); }
  else {
    ot.appendChild(th(['Project', 'Session', 'State', 'Tokens today', 'List value today', 'List value all time', 'Hand-built edits']));
    var obody = el('tbody');
    os.forEach(function (x) {
      var tr = el('tr');
      tr.appendChild(td(x.project)); tr.appendChild(td(x.id, 'mono')); tr.appendChild(td(doingText(x, Date.now()), 'mono'));
      tr.appendChild(td(typeof x.tokensToday === 'number' ? String(x.tokensToday) : '-', 'mono'));
      tr.appendChild(td(usd(x.listUsdToday) + ' (list value)', 'mono')); tr.appendChild(td(usd(x.listUsdAll) + ' (list value)', 'mono')); tr.appendChild(td(String(x.handBuilt || 0), 'mono'));
      obody.appendChild(tr);
    });
    ot.appendChild(obody);
  }
  var t = $('laneTable'); t.textContent = '';
  var lanes = data.machine.lanes || [];
  if (!lanes.length) { t.appendChild(el('caption', 'empty', 'No lane is configured and none ran a job today.')); }
  else {
    t.appendChild(th(['Lane', 'Kind', 'Jobs today', 'List value / cost today', 'Daily cap', 'Status']));
    var body = el('tbody');
    lanes.forEach(function (l) {
      var tr = el('tr');
      var nameCell = el('div', 'livebar'); var sw = el('i'); sw.style.cssText = 'width:10px;height:10px;border-radius:3px;display:block;background:' + L.laneColor(l.label); nameCell.appendChild(sw); nameCell.appendChild(el('span', 'name', l.label));
      tr.appendChild(td(nameCell)); tr.appendChild(td(l.kind === 'billed' ? pill('billed', 'good') : pill('flat-rate, list value', 'info')));
      tr.appendChild(td(String(l.jobsToday || 0), 'mono'));
      tr.appendChild(td(l.todayUsd ? usd(l.todayUsd) + (l.kind === 'billed' ? ' billed' : ' list value') : (l.kind === 'flat-rate' && l.jobsToday ? 'not reported list value' : usd(0) + (l.kind === 'billed' ? ' billed' : ' list value')), 'mono'));
      var cap = el('div');
      if (l.dailyCapUsd) { cap.appendChild(meter(100 * l.todayUsd / l.dailyCapUsd, l.todayUsd / l.dailyCapUsd > 0.75)); cap.appendChild(el('span', 'mono sub', usd(l.todayUsd) + ' of ' + usd(l.dailyCapUsd))); } else { cap.appendChild(el('span', 'sub', 'no daily cap')); }
      tr.appendChild(td(cap));
      var st = el('div');
      if (l.limited) { var p = pill('paused (' + l.limited.state + ')', 'warn'); st.appendChild(p); var cd = el('span', 'mono sub', ' resets ' + L.countdown(l.limited.until, Date.now())); cd.dataset.until = l.limited.until; cd.dataset.prefix = ' resets '; st.appendChild(cd); }
      else if (l.dailyCapUsd) { var rs = el('span', 'mono sub', 'cap resets ' + L.countdown(l.capResetsAt, Date.now()) + ' (UTC midnight)'); rs.dataset.until = l.capResetsAt; rs.dataset.prefix = 'cap resets '; rs.dataset.suffix = ' (UTC midnight)'; st.appendChild(rs); }
      else { st.appendChild(el('span', 'sub', 'ok')); }
      tr.appendChild(td(st)); body.appendChild(tr);
    });
    t.appendChild(body);
  }
  $('laneNote').textContent = 'Billed lanes count what they were charged today; flat-rate lanes show what the work is worth at list price. A pause comes from a real rate-limit or quota event recorded by the lane scheduler.';
  var s = $('spendTable'); s.textContent = '';
  s.appendChild(th(['Project', 'Billed today', 'Billed, 7 days', 'Billed, all time', 'List value, all time', 'Spend and cap']));
  var sb = el('tbody');
  data.projects.forEach(function (p) {
    var bp = data.machine.cost.byProject[p.id] || {};
    var tr = el('tr');
    tr.appendChild(td(link(projectHref(p.id), 'name board-link', [el('span', '', p.name)]))); tr.appendChild(td(usd(bp.todayUsd), 'mono')); tr.appendChild(td(usd(bp.weekUsd), 'mono')); tr.appendChild(td(usd(bp.paidUsd), 'mono')); tr.appendChild(td(usd(bp.flatRateListUsd), 'mono')); tr.appendChild(td(capCell(p)));
    sb.appendChild(tr);
  });
  s.appendChild(sb);
}
function tickCountdowns() {
  document.querySelectorAll('[data-until]').forEach(function (n) { n.textContent = (n.dataset.prefix || '') + L.countdown(n.dataset.until, Date.now()) + (n.dataset.suffix || ''); });
  var lv = L.liveness(state.lastOk, Date.now());
  $('liveDot').className = 'dot' + (lv.state === 'live' ? '' : ' off');
  $('liveText').textContent = lv.state === 'live' ? 'Live, updated ' + clock(state.lastOk) : state.lastOk ? 'Stale, last update ' + clock(state.lastOk) : 'connecting';
}
setInterval(tickCountdowns, 1000);

// ---- agents --------------------------------------------------------------------------------------------------------------------------------------

function renderPools(data) {
  var table = $('poolsTable'); table.textContent = '';
  var pools = data && Array.isArray(data.pools) ? data.pools : [];
  if (!pools.length) { table.appendChild(el('caption', 'empty', 'No capacity pools reported.')); }
  else {
    table.appendChild(th(['Pool', 'Kind', 'Limit', 'In use', 'Status']));
    var body = el('tbody');
    pools.forEach(function (p) {
      var tr = el('tr');
      tr.appendChild(td(p.name || p.id || 'pool'));
      tr.appendChild(td(p.kind || 'other'));
      var limit = el('div');
      if (typeof p.limit === 'number' && p.limit > 0) { limit.appendChild(meter(100 * (typeof p.inUse === 'number' ? p.inUse : 0) / p.limit, (typeof p.inUse === 'number' ? p.inUse : 0) >= p.limit)); }
      limit.appendChild(el('span', 'mono', p.limit === null || p.limit === undefined ? '—' : String(p.limit) + ' ' + (p.unit || 'slots')));
      tr.appendChild(td(limit));
      tr.appendChild(td(String(typeof p.inUse === 'number' ? p.inUse : 0) + ' ' + (p.unit || 'slots'), 'mono'));
      var status = el('div');
      if (p.capped) { status.appendChild(pill('capped: ' + (p.why || 'limit reached'), 'warn')); }
      else { status.appendChild(el('span', 'sub', 'ok')); }
      tr.appendChild(td(status)); body.appendChild(tr);
    });
    table.appendChild(body);
  }
  $('poolsNote').textContent = data && data.source === 'pools.mjs' ? 'Source: pools.mjs' : 'Source: stub from lane store and config (pools.mjs not installed yet)';
}

function renderAgents(data) {
  var list = data.machine.agents.list;
  $('agentsCount').textContent = String(data.machine.agents.total);
  var slots = $('agentsSlots'); var st0 = L.slotsText(data.machine); slots.hidden = !st0; slots.textContent = st0;
  var host = $('agentsGrid');
  var specs = list.slice(0, 80).map(function (a) { return { key: a.runId + '|' + a.jobId, state: HEAD_STATE[a.state] || 'idle', lane: a.lane, a: a }; });
  var idleLanes = L.bays(list, []).filter(function (b) { return b.idle; }).map(function (b) { return { key: 'sleep|' + b.lane, state: 'sleeping', lane: b.lane, a: null }; });
  var all = specs.concat(idleLanes);
  var map = host.__rows || (host.__rows = new Map());
  var keep = {};
  all.forEach(function (s) {
    keep[s.key] = true;
    var hit = map.get(s.key);
    if (!hit) {
      var row = el('div', 'agent-row'); var holder = el('div'); row.appendChild(holder);
      var handle = mountRobotHead(holder, { state: s.state, size: 56, color: L.laneColor(s.lane), screenColor: s.state === 'error' ? '#ffc4c4' : '#e8f2ff', id: s.key, label: s.lane + ' agent, ' + s.state });
      var who = el('div', 'who'); var b = el('b', 'mono'); var l2 = el('span', 'sub'); var st = el('span', 'state'); var links = el('span', 'sub');
      who.appendChild(b); who.appendChild(l2); who.appendChild(st); who.appendChild(links); row.appendChild(who);
      hit = { row: row, handle: handle, b: b, l2: l2, st: st, links: links }; map.set(s.key, hit); host.appendChild(row);
    }
    hit.handle.setState(s.state);
    if (s.a) {
      hit.b.textContent = s.a.jobId; hit.l2.textContent = s.a.lane + ' | ' + s.a.project;
      hit.st.textContent = s.state === 'error' ? 'failed ' + (s.a.ended ? ago(s.a.ended) : '') : s.state + (s.a.since ? ' | running ' + L.duration(Date.now() - Date.parse(s.a.since)) : ''); hit.st.className = 'state ' + s.state;
      hit.links.textContent = '';
      hit.links.appendChild(link(runHref(s.a.projectId, s.a.runId), 'board-link', [el('span', '', 'run inspector')]));
    } else { hit.b.textContent = s.lane; hit.l2.textContent = 'No agent running in this lane'; hit.st.textContent = 'sleeping'; hit.st.className = 'state sleeping'; hit.links.textContent = ''; }
  });
  map.forEach(function (v, k) { if (!keep[k]) { v.handle.destroy(); v.row.remove(); map.delete(k); } });
  if (list.length > 80) { $('agentsCount').title = 'Showing 80 of ' + list.length; }
}

// ---- events (history) ----------------------------------------------------------------------------------------------------------------------------

function query() {
  var q = new URLSearchParams();
  [['q', 'q'], ['project', 'fproject'], ['kind', 'fkind'], ['from', 'ffrom'], ['to', 'fto']].forEach(function (pair) { var v = $(pair[1]).value; if (v) { q.set(pair[0], v); } });
  return q;
}
function entryNode(e, projects) {
  var parts = [el('span', 'when mono', e.at.slice(0, 16).replace('T', ' ')), el('span', 'kind', e.kind), el('span', 'what', e.project + ': ' + e.title)];
  if (typeof e.usd === 'number') { parts.push(el('span', 'num mono', usd(e.usd))); }
  if (e.kind === 'run' && e.jobs && e.jobs.length) {
    var box = el('span', 'runjobs');
    e.jobs.slice(0, 4).forEach(function (j) {
      var line = el('span', 'runjob');
      line.appendChild(el('b', 'mono', j.id)); line.appendChild(el('span', 'what', ' ' + (j.title || '')));
      line.appendChild(el('span', 'sub', ' ' + j.lane + (j.model ? '/' + j.model : '')));
      line.appendChild(pill(j.outcome === 'pass' ? 'pass' : j.outcome === 'fail' ? 'fail' : j.outcome, j.outcome === 'pass' ? 'good' : j.outcome === 'fail' ? 'warn' : 'info'));
      if (j.outcome === 'fail') { line.appendChild(el('span', 'sub', ' ' + (j.reason || 'no reason recorded') + (j.retries ? ', ' + j.retries + ' retr' + (j.retries === 1 ? 'y' : 'ies') : ''))); }
      box.appendChild(line);
    });
    if ((e.jobCount || e.jobs.length) > 4) { box.appendChild(el('span', 'sub', ' +' + ((e.jobCount || e.jobs.length) - 4) + ' more')); }
    parts.push(box);
  }
  var known = projects.some(function (p) { return p.id === e.projectId; });
  var node;
  if (e.run && known && (e.kind === 'run' || e.kind === 'spend')) { node = link(runHref(e.projectId, e.run), 'entry', parts); }
  else if (e.url && (e.kind === 'pr' || e.kind === 'merge')) { node = link(e.url, 'entry', parts); node.rel = 'noopener noreferrer'; node.target = '_blank'; }
  else if (known) { node = link(projectHref(e.projectId), 'entry', parts); }
  else { node = el('div', 'entry'); parts.forEach(function (p) { node.appendChild(p); }); }
  return node;
}
function loadHistory() {
  if (state.tab !== 'events' || !state.data) { return; }
  var q = query();
  var csv = new URLSearchParams(q); csv.set('t', TOKEN);
  var api = new URLSearchParams(q); api.set('t', TOKEN); api.set('limit', '100');
  if (state.scratch) { api.set('scratch', '1'); csv.set('scratch', '1'); }
  $('csv').href = '/history.csv?' + csv.toString();
  fetch('/api/history?' + api.toString(), { headers: { 'x-watch-token': TOKEN } })
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (data) {
      if (!data) { return; }
      var box = $('history'); box.textContent = '';
      if (!data.events.length) { box.appendChild(el('div', 'empty', 'Nothing matches.')); }
      data.events.forEach(function (e) { box.appendChild(entryNode(e, state.data.projects)); });
      $('historyNote').textContent = 'Showing ' + data.events.length + ' of ' + data.total + ' event(s), newest first. A pull request and its merge are one row. The log is append-only and kept on disk.';
    }).catch(function () {});
}
var debounce = null;
$('filters').addEventListener('input', function () { clearTimeout(debounce); debounce = setTimeout(loadHistory, 300); });
$('filters').addEventListener('submit', function (e) { e.preventDefault(); loadHistory(); });

// ---- data loop -----------------------------------------------------------------------------------------------------------------------------------

function renderTab() {
  var d = state.data;
  if (!d) { return; }
  if (state.tab === 'overview') { renderKpis(d.machine); renderBays(d.machine); renderOrch(d.machine); renderProjects(d.projects); }
  else if (state.tab === 'cost') { renderCost(d); }
  else if (state.tab === 'agents') { renderAgents(d); renderPools(d.pools); }
  tickCountdowns();
}
function renderBoard(data) {
  state.data = data;
  state.lastOk = Date.now();
  $('count').textContent = data.projects.length + (data.projects.length === 1 ? ' project' : ' projects');
  var sc = data.scratch || { hidden: 0 };
  $('scratchLabel').textContent = state.scratch ? 'showing test/temp projects' : 'show test/temp projects' + (sc.hidden ? ' (' + sc.hidden + ' hidden)' : '');
  $('scratch').checked = state.scratch;
  // The chip and title stay current on every tab; the panels render where they are visible.
  renderNeeds(data.inbox);
  var banner = $('staleBanner');
  if (data.server && data.server.stale) { banner.hidden = false; banner.textContent = 'restart needed: installed ' + data.server.installedVersion + ' (this board is still swarm ' + data.server.version + '). Stop it and start it again (Ctrl-C then swarm watch --all, or swarm remote off then swarm remote on).'; } else { banner.hidden = true; banner.textContent = ''; }
  renderTab();
  state.firstRender = false;
  if (state.tab === 'events' && !state.eventsLoaded) { state.eventsLoaded = true; loadHistory(); }
  var sel = $('fproject'); var keep = sel.value;
  if (sel.options.length - 1 !== data.projects.length) {
    while (sel.options.length > 1) { sel.remove(1); }
    data.projects.forEach(function (p) { var o = el('option', '', p.name); o.value = p.id; sel.appendChild(o); });
    sel.value = keep;
  }
}
function poll() {
  if (state.polling) { return; }   // one request at a time: a slow answer is not overtaken by the next poll
  state.polling = true;
  fetch('/api/board?t=' + T + (state.scratch ? '&scratch=1' : ''), { headers: { 'x-watch-token': TOKEN } })
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (data) { if (data) { renderBoard(data); } })
    .catch(function () {})
    .then(function () { state.polling = false; });
}
$('scratch').addEventListener('change', function () {
  state.scratch = $('scratch').checked;
  store.set('swarm-scratch', state.scratch ? '1' : '0');
  poll(); loadHistory();
});

applyHash();
poll();
setInterval(poll, 2000);
setInterval(loadHistory, 10000);
