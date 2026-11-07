// SPDX-License-Identifier: Apache-2.0
// The project page's Live tab: every run that is alive in this project, combined (data: /api/live, the same run files the run pages read).
// Every state shown is one a run recorded: nothing is animated for show, a sleeping head means no agent is running in that lane.
import { mountRobotHead, setAnimationPaused, animationPaused, reducedMotion } from './robot-head.js';
import { renderOrchestrator, buildMixText } from './orchestrator-view.js';

var L = self.BoardLib;
var TOKEN = L.watchToken();
var params = new URLSearchParams(location.search);
var ID = params.get('id') || '';
var $ = function (id) { return document.getElementById(id); };
function el(tag, cls, text) { var n = document.createElement(tag); if (cls) { n.className = cls; } if (text !== undefined) { n.textContent = text; } return n; }
function pct(v) { return typeof v === 'number' && isFinite(v) ? Math.round(v * 100) + '%' : '-'; }
function ago(iso) { var t = Date.parse(iso || ''); if (!isFinite(t)) { return 'never'; } var s = Math.max(0, Math.round((Date.now() - t) / 1000)); return s < 90 ? s + ' s ago' : s < 5400 ? Math.round(s / 60) + ' min ago' : s < 129600 ? Math.round(s / 3600) + ' h ago' : Math.round(s / 86400) + ' days ago'; }
var store = { get: function (k) { try { return localStorage.getItem(k); } catch (e) { return null; } }, set: function (k, v) { try { localStorage.setItem(k, v); } catch (e) { /* storage may be off */ } } };

var RUN_COLORS = ['#60a5fa', '#f472b6', '#fbbf24', '#a78bfa', '#34d399', '#fb923c'];
var STATE_COLORS = { queued: '#3f3f4a', running: '#60a5fa', complete: '#34d399', failed: '#fb7185', timeout: '#fb7185', held: '#fbbf24', blocked: '#fbbf24', cancelled: '#4a4a56' };
var runColor = function (idx) { return RUN_COLORS[idx % RUN_COLORS.length]; };

// ---- tabs (hash: #live, #overview) ----------------------------------------------------------------------------------------------------------

function go(name) {
  if (name !== 'live' && name !== 'overview') { name = 'live'; }
  ['live', 'overview'].forEach(function (n) {
    var on = n === name;
    $('pane-' + n).hidden = !on;
    var b = $('tab-' + n + '-btn'); b.setAttribute('aria-selected', on ? 'true' : 'false'); b.tabIndex = on ? 0 : -1;
  });
  // Tabs are not history entries: the address is updated in place, so Back leaves the page instead of bouncing between tabs.
  if (location.hash !== '#' + name) { try { history.replaceState(null, '', '#' + name); } catch (e) { /* the tab still switched */ } }
}
document.querySelectorAll('#tabs [data-tab]').forEach(function (b) { b.addEventListener('click', function () { go(b.getAttribute('data-tab')); }); });
$('tabs').addEventListener('keydown', function (e) {
  var order = ['live', 'overview'], cur = order.indexOf(document.activeElement && document.activeElement.getAttribute('data-tab'));
  if (cur < 0 || (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft')) { return; }
  var next = order[(cur + (e.key === 'ArrowRight' ? 1 : order.length - 1)) % order.length];
  go(next); $('tab-' + next + '-btn').focus(); e.preventDefault();
});
window.addEventListener('hashchange', function () { go(location.hash.replace(/^#/, '')); });

// ---- motion (the same rules as the board) ---------------------------------------------------------------------------------------------------

function applyPause(paused) { setAnimationPaused(paused); document.body.classList.toggle('paused-motion', paused); var b = $('pauseMotion'); b.setAttribute('aria-pressed', paused ? 'true' : 'false'); b.textContent = paused ? 'Resume motion' : 'Pause motion'; }
$('pauseMotion').addEventListener('click', function () { var next = !(animationPaused() && store.get('swarm-paused') === '1'); store.set('swarm-paused', next ? '1' : '0'); applyPause(next); });
applyPause(store.get('swarm-paused') === '1');
if (reducedMotion()) { $('pauseMotion').hidden = true; }

// ---- rendering ----------------------------------------------------------------------------------------------------------------------------

var mapMode = store.get('swarm-live-map') || 'state';
if (['state', 'lane', 'run'].indexOf(mapMode) === -1) { mapMode = 'state'; }
var last = null;

function tile(l, v, s, extra) { var t = el('div', 'card kpi'); t.appendChild(el('div', 'l', l)); t.appendChild(el('div', 'v num', v)); t.appendChild(el('div', 's', s)); if (extra) { t.appendChild(extra); } return t; }
function meter(p, hot) { var m = el('div', 'meter' + (hot ? ' hot' : '')); var i = el('i'); i.style.width = Math.max(0, Math.min(100, p)) + '%'; m.appendChild(i); return m; }
function ring(done, total, color) {
  var NS = 'http://www.w3.org/2000/svg', svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 44 44'); svg.setAttribute('class', 'ring2'); svg.setAttribute('role', 'img'); svg.setAttribute('aria-label', done + ' of ' + total + ' jobs done');
  var r = 17, c = 2 * Math.PI * r, frac = total ? done / total : 0;
  [['#23232a', c], [color, c * frac]].forEach(function (p, i) {
    var k = document.createElementNS(NS, 'circle'); k.setAttribute('cx', '22'); k.setAttribute('cy', '22'); k.setAttribute('r', String(r)); k.setAttribute('fill', 'none'); k.setAttribute('stroke', p[0]); k.setAttribute('stroke-width', '5');
    k.setAttribute('stroke-dasharray', p[1].toFixed(1) + ' ' + c.toFixed(1)); if (i) { k.setAttribute('stroke-linecap', 'round'); k.setAttribute('transform', 'rotate(-90 22 22)'); } svg.appendChild(k);
  });
  var t = document.createElementNS(NS, 'text'); t.setAttribute('x', '22'); t.setAttribute('y', '26'); t.setAttribute('text-anchor', 'middle'); t.setAttribute('font-size', '11'); t.setAttribute('fill', '#ececf1'); t.textContent = total ? Math.round(frac * 100) + '%' : '-'; svg.appendChild(t);
  return svg;
}
function elapsedText(startedAt) { var t = Date.parse(startedAt || ''); return isFinite(t) ? L.duration(Math.max(0, Date.now() - t)) + ' elapsed' : '-'; }
function linkTo(href, cls, text, title) { var a = el('a', cls, text); a.href = href; if (title) { a.title = title; } return a; }

function renderKpis(d) {
  var box = $('liveKpis'); box.textContent = '';
  var h = d.header;
  box.appendChild(tile('Jobs', h.jobs.running + ' running', h.jobs.queued + ' queued, ' + h.jobs.blocked + ' blocked'));
  box.appendChild(tile('Runs live now', String(h.runsLive), h.runsLive ? 'ETA ' + (h.etaMs === null ? 'unknown yet' : h.etaMs === 0 ? 'nothing left' : L.duration(h.etaMs)) + ' (the slowest run)' : 'nothing running'));
}

function headKey(a) { return a.run + '|' + a.job; }
function renderBays(d) {
  var host = $('liveBays');
  var flat = [], counts = Object.create(null); d.lanes.forEach(function (ln) { counts[ln.lane] = ln.count; ln.agents.forEach(function (a) { flat.push({ lane: ln.lane, state: a.state, a: a }); }); });
  var bays = L.bays(flat, []);
  var map = host.__bays || (host.__bays = new Map());
  var names = Object.create(null); bays.forEach(function (b) { names[b.lane] = true; });
  map.forEach(function (v, lane) { if (!names[lane]) { v.heads.forEach(function (h) { h.handle.destroy(); }); v.node.remove(); map.delete(lane); } });
  var total = 0;
  bays.forEach(function (b) {
    var hit = map.get(b.lane);
    if (!hit) {
      var node = el('div', 'bay'); node.style.setProperty('--c', L.laneColor(b.lane));
      var top = el('div', 'top'); var n = el('span', 'n num', '0'); top.appendChild(el('span', 'name', b.lane)); top.appendChild(n);
      var heads = el('div', 'heads'); node.appendChild(top); node.appendChild(heads);
      hit = { node: node, n: n, hostEl: heads, heads: new Map() }; map.set(b.lane, hit); host.appendChild(node);
    }
    var shown = counts[b.lane] === undefined ? b.running : counts[b.lane] - (b.agents.length - b.running);
    hit.n.textContent = String(shown); total += shown;
    hit.node.classList.toggle('idle', b.idle);
    var specs = b.idle ? [{ key: 'sleep|' + b.lane, state: 'sleeping', label: '', sub: '', title: b.lane + ': no agent running', color: L.laneColor(b.lane) }]
      : b.agents.slice(0, 10).map(function (x) { var a = x.a; return { key: headKey(a), state: a.state, label: (a.ticket || a.job), sub: a.runShort, title: (a.ticket || a.job) + (a.title ? ': ' + a.title : '') + ' · run ' + a.run + ' · ' + a.state, color: L.laneColor(b.lane) }; });
    var keep = Object.create(null);
    specs.forEach(function (s) {
      keep[s.key] = true;
      var h = hit.heads.get(s.key);
      if (h) { h.handle.setState(s.state); h.label.textContent = s.label; h.sub.textContent = s.sub; h.wrap.title = s.title; return; }
      var wrap = el('div', 'agent'); wrap.title = s.title; var holder = el('div'); wrap.appendChild(holder);
      var handle = mountRobotHead(holder, { state: s.state, size: 34, color: s.color, screenColor: s.state === 'error' ? '#ffc4c4' : '#e8f2ff', id: s.key, label: b.lane + ' agent, ' + s.state + (s.label ? ', ' + s.label + ', run ' + s.sub : '') });
      var label = el('div', 'jid mono', s.label); wrap.appendChild(label);
      var sub = el('div', 'jid mono run-s', s.sub); wrap.appendChild(sub);
      hit.hostEl.insertBefore(wrap, hit.hostEl.querySelector('.more'));
      hit.heads.set(s.key, { wrap: wrap, handle: handle, label: label, sub: sub });
    });
    hit.heads.forEach(function (v, k) { if (!keep[k]) { v.handle.destroy(); v.wrap.remove(); hit.heads.delete(k); } });
    var more = (counts[b.lane] || b.agents.length) - 10, extra = hit.hostEl.querySelector('.more');
    if (more > 0) { if (!extra) { extra = el('span', 'sub more'); hit.hostEl.appendChild(extra); } extra.textContent = '+' + more; } else if (extra) { extra.remove(); }
    host.appendChild(hit.node);
  });
  $('agentCount').textContent = String(total);
}

function renderMap(d) {
  var box = $('liveMap'); box.textContent = '';
  var legend = $('runLegend'); legend.textContent = '';
  d.runs.forEach(function (r) { var c = el('span', 'runchip'); var i = el('i'); i.style.setProperty('--run', runColor(r.idx)); c.appendChild(i); c.appendChild(document.createTextNode(r.short + ' (' + r.done + '/' + r.total + ')')); c.title = r.runId; legend.appendChild(c); });
  d.map.forEach(function (j) {
    var q = el('span', 'sq ' + (STATE_COLORS[j.status] ? j.status : 'other'));
    var fill = mapMode === 'state' ? (STATE_COLORS[j.status] || '#3f3f4a') : mapMode === 'lane' ? L.laneColor(j.lane) : runColor(j.idx);
    q.style.setProperty('--q', fill); if (mapMode !== 'run') { q.style.setProperty('--run', runColor(j.idx)); }
    q.title = j.job + ' · ' + j.status + ' · ' + j.lane + ' · run ' + j.run;
    box.appendChild(q);
  });
  $('mapCount').textContent = String(d.map.length);
  var lg = $('mapLegend'); lg.textContent = '';
  var entries = mapMode === 'state' ? [['queued', STATE_COLORS.queued], ['running', STATE_COLORS.running], ['done', STATE_COLORS.complete], ['failed', STATE_COLORS.failed], ['held', STATE_COLORS.held]]
    : mapMode === 'lane' ? Object.keys(d.map.reduce(function (o, j) { o[j.lane] = 1; return o; }, Object.create(null))).map(function (k) { return [k, L.laneColor(k)]; })
    : d.runs.map(function (r) { return [r.short, runColor(r.idx)]; });
  entries.forEach(function (e) { var s = el('span'); var i = el('i', 'dot'); i.style.background = e[1]; i.style.animation = 'none'; s.appendChild(i); s.appendChild(document.createTextNode(' ' + e[0])); lg.appendChild(s); });
  $('mapNote').textContent = (mapMode === 'run' ? 'Fill = run. ' : 'Fill = ' + mapMode + ', outline = run. ') + 'One square per job, from every live run' + (d.mapTruncated ? ' (the first ' + d.map.length + ' are drawn)' : '') + '.';
  document.querySelectorAll('#mapMode button').forEach(function (b) { b.setAttribute('aria-pressed', b.getAttribute('data-mode') === mapMode ? 'true' : 'false'); });
}

function renderStats(d) {
  var s = d.stats, box = $('liveStats'); box.textContent = '';
  function stat(l, v, sub) { var n = el('div', 'stat'); n.appendChild(el('div', 'l', l)); n.appendChild(el('div', 'v', v)); n.appendChild(el('div', 's', sub)); box.appendChild(n); }
  stat('Progress', s.done + ' / ' + s.total, s.total ? Math.round(100 * s.done / s.total) + '% of all jobs' : 'no jobs');
  stat('In flight', String(s.running + s.queued), s.running + ' running, ' + s.queued + ' queued');
  stat('First-try pass', pct(s.firstTryRate), 'of ' + s.finished + ' finished');
  stat('Retries / failed', s.retries + ' / ' + s.failed, 'across all runs');
  stat('Merged', String(s.merged), 'batches queued ' + s.queue);
  stat('Conflicts', String(s.conflicts), 'in the merge queues');
}

function renderRuns(d) {
  var box = $('liveRuns'); box.textContent = '';
  var live = d.runs.filter(function (r) { return r.status === 'live' || r.status === 'paused'; });
  if (!live.length) { box.appendChild(el('p', 'sub', 'None.')); }
  live.forEach(function (r) {
    var row = el('div', 'runrow'); row.style.setProperty('--run', runColor(r.idx));
    row.appendChild(ring(r.done, r.total, runColor(r.idx)));
    var who = el('div', 'who');
    var name = r.tickets.length ? r.tickets.join(', ') + (r.ticketCount > r.tickets.length ? ' +' + (r.ticketCount - r.tickets.length) : '') : (r.goal || 'Run ' + r.short);
    who.appendChild(el('b', '', name));
    var meta = el('div', 'meta');
    [r.tickets.length || r.goal ? r.short : null, r.status === 'paused' ? 'paused' : null, r.done + '/' + r.total + ' jobs', 'ELAPSED', r.failed ? r.failed + ' failed' : null].forEach(function (t) {
      if (t === 'ELAPSED') { var e = el('span', 'mono elapsed', elapsedText(r.startedAt)); e.setAttribute('data-started', r.startedAt || ''); meta.appendChild(e); }
      else if (t) { meta.appendChild(el('span', 'mono', t)); }
    });
    who.appendChild(meta);
    var acts = el('div', 'acts');
    acts.appendChild(linkTo('/open/run?id=' + encodeURIComponent(ID) + '&run=' + encodeURIComponent(r.runId), 'btn primary', 'Open run page', 'The run\'s own live page'));
    acts.appendChild(linkTo('/run?id=' + encodeURIComponent(ID) + '&run=' + encodeURIComponent(r.runId), 'btn', 'Inspector', 'Graph, journal, compare'));
    who.appendChild(acts); row.appendChild(who); box.appendChild(row);
  });
  var rec = $('liveRecent'); rec.textContent = '';
  if (!d.recent.length) { rec.appendChild(el('p', 'sub', 'No run finished today.')); }
  d.recent.forEach(function (r) {
    var row = el('div', 'runrow recent'); var who = el('div', 'who');
    var top = el('div', 'meta'); top.appendChild(el('span', 'pill ' + (r.status === 'complete' ? 'good' : 'bad'), r.status === 'complete' ? 'complete' : (r.result || r.status)));
    [r.short, r.done + '/' + r.total + ' jobs', r.failed ? r.failed + ' failed' : null, ago(r.finishedAt)].forEach(function (t) { if (t) { top.appendChild(el('span', 'mono', t)); } });
    who.appendChild(top);
    who.appendChild(linkTo('/run?id=' + encodeURIComponent(ID) + '&run=' + encodeURIComponent(r.runId), 'board-link sub', 'Open in the inspector'));
    row.appendChild(who); rec.appendChild(row);
  });
}

function renderEmpty(d) {
  var box = $('liveEmpty'); box.textContent = '';
  box.appendChild(el('h2', '', 'No live runs'));
  box.appendChild(el('div', 'sub', 'Last activity in this project: ' + (d.empty.lastActivityAt ? ago(d.empty.lastActivityAt) : 'none yet') + '.'));
  var links = el('div', 'links');
  var ov = el('button', 'btn primary', 'Overview'); ov.type = 'button'; ov.addEventListener('click', function () { go('overview'); }); links.appendChild(ov);
  if (d.recent[0]) { links.appendChild(linkTo('/run?id=' + encodeURIComponent(ID) + '&run=' + encodeURIComponent(d.recent[0].runId), 'btn', 'Last run: ' + d.recent[0].short)); }
  links.appendChild(linkTo('/', 'btn', 'All projects'));
  box.appendChild(links);
  if (d.finishedCount) { box.appendChild(el('div', 'sub', 'Finished today: ' + d.finishedCount + (d.finishedCount === 1 ? ' run' : ' runs') + '.')); }
}

function renderOrch(d) {
  var o = d.orchestrator || { sessions: [] };
  $('orchCount').textContent = String(o.sessions.filter(function (x) { return x.state !== 'idle'; }).length);
  renderOrchestrator($('orchBay'), o.sessions, { now: Date.now() });
  $('orchNote').textContent = buildMixText(o) || '';
}
function render(d) {
  renderOrch(d);
  var empty = Boolean(d.empty);
  $('liveEmpty').hidden = !empty; $('liveBody').hidden = empty;
  if (empty) { renderEmpty(d); }
  $('liveCount').textContent = String(d.header.runsLive);
  if (!empty) { renderKpis(d); renderBays(d); renderMap(d); renderStats(d); renderRuns(d); }
  else { renderBays({ lanes: [] }); }
}

// ---- polling: one request at a time (10 s limit), only while the Live tab is showing, drawn only when the data really changed -------------------------------

var inflight = false, lastOkAt = 0, lastSig = '', lastAnnounce = '', rendered = false;
// What changes just because time passes (elapsed time, estimates, when an agent started) does not redraw the tab: elapsed time is kept current in the page.
var VOLATILE = { now: 1, elapsedMs: 1, etaMs: 1, since: 1 };
function chip() {
  document.querySelectorAll('.elapsed[data-started]').forEach(function (n) { n.textContent = elapsedText(n.getAttribute('data-started')); });
}
function problem(text) {
  if (rendered) { return; }   // data is on the screen: the chip says Stale, the data stays
  $('liveBody').hidden = true; $('liveEmpty').hidden = false;
  var box = $('liveEmpty'); box.textContent = ''; box.appendChild(el('h2', '', text)); box.appendChild(el('div', 'sub', 'Reload the page, or open the board again from swarm watch --all.'));
}
function load() {
  if (inflight || document.hidden || $('pane-live').hidden) { return; }
  inflight = true;
  var ctl = new AbortController(), timer = setTimeout(function () { ctl.abort(); }, 10000);
  fetch('/api/live?id=' + encodeURIComponent(ID), { headers: { 'x-watch-token': TOKEN }, signal: ctl.signal })
    .then(function (res) {
      if (res.ok) { return res.json(); }
      problem(res.status === 404 ? 'Project not found' : res.status === 403 ? 'This page\'s link has expired' : 'Could not load (' + res.status + ')');
      return null;
    })
    .then(function (d) {
      if (!d) { return; }
      var sig = JSON.stringify(d, function (k, v) { return VOLATILE[k] ? undefined : v; });
      if (sig !== lastSig) {
        render(d); rendered = true; lastSig = sig;
        var say = d.header.runsLive + ' live run' + (d.header.runsLive === 1 ? '' : 's') + ', ' + d.header.jobs.running + ' jobs running';
        if (say !== lastAnnounce) { lastAnnounce = say; $('announce').textContent = say; }
      }
      lastOkAt = Date.now();
    })
    .catch(function () { problem('Could not reach the board'); })
    .then(function () { clearTimeout(timer); inflight = false; chip(); });
}
document.querySelectorAll('#mapMode button').forEach(function (b) { b.addEventListener('click', function () { mapMode = b.getAttribute('data-mode'); store.set('swarm-live-map', mapMode); lastSig = ''; load(); }); });
document.addEventListener('visibilitychange', load);
go(location.hash.replace(/^#/, ''));
load();
setInterval(load, 3000);
setInterval(chip, 1000);
