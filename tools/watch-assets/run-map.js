// SPDX-License-Identifier: Apache-2.0
'use strict';
(function () {
var LANE_COL = { hermes: '#22d3ee', cursor: '#60a5fa', codex: '#fbbf24', anthropic: '#fb923c', openrouter: '#a78bfa', claude: '#fcd34d', other: '#a3a3ae' };
var STATE_COL = { queued: '#3f3f4a', running: '#60a5fa', retry: '#fbbf24', failed: '#fb7185', done: '#34d399' };
var STATE_ORDER = ['queued', 'running', 'retry', 'failed', 'done'];
var canvas = document.getElementById('map');
if (!canvas || !canvas.getContext) return;
var ctx = canvas.getContext('2d');
var wrap = canvas.parentElement;
var tip = document.getElementById('tip');
var legend = document.getElementById('legend');
var btnState = document.getElementById('cState');
var btnLane = document.getElementById('cLane');
var reduce = false;
try { reduce = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches); } catch (e) { reduce = false; }
var jobs = [], cells = [], groups = [], layoutKey = '';
var colorMode = 'state', dirty = true, raf = 0, dpr = 1, cs = 10, gap = 3;

function laneOf(j) { var l = j && j.lane ? String(j.lane).toLowerCase() : ''; return LANE_COL[l] ? l : 'other'; }
function stateOf(j) {
  var st = String((j && j.status) || '');
  if (st === 'failed' || st === 'timeout') return 'failed';
  if (st === 'complete') return 'done';
  if ((j && j.attempts || 0) > 1) return 'retry';
  if (st === 'running') return 'running';
  return 'queued';
}
function colorOf(s, lane) {
  if (colorMode === 'lane' && s !== 'queued') return LANE_COL[lane];
  if (s === 'running') return LANE_COL[lane];
  return STATE_COL[s];
}
function fmt(v) { return v === null || v === undefined || v === '' ? '–' : String(v); }

function layout(w) {
  dpr = window.devicePixelRatio || 1;
  cs = w < 520 ? 7 : 10; gap = w < 520 ? 2 : 3;
  var step = cs + gap, cols = Math.max(10, Math.floor((w + gap) / step));
  var byLead = {}, order = [];
  jobs.forEach(function (j, i) {
    var lead = j && j.lead ? String(j.lead) : 'main';
    if (!byLead[lead]) { byLead[lead] = []; order.push(lead); }
    byLead[lead].push(i);
  });
  cells = []; groups = [];
  var y = 0;
  order.forEach(function (lead) {
    var list = byLead[lead], from = cells.length;
    groups.push({ name: lead, y: y, from: from, to: from + list.length });
    y += 20;
    list.forEach(function (idx, k) {
      cells.push({ i: idx, x: (k % cols) * step, y: y + Math.floor(k / cols) * step });
    });
    y += Math.ceil(list.length / cols) * step + 12;
  });
  canvas.style.height = y + 'px';
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(y * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  layoutKey = jobs.length + ':' + w;
}

function ensureLayout() {
  var w = wrap.clientWidth;
  if (!w) return false;
  if (layoutKey !== jobs.length + ':' + w) layout(w);
  return true;
}

function draw(now) {
  var w = canvas.width / dpr, h = canvas.height / dpr;
  ctx.clearRect(0, 0, w, h);
  ctx.font = '500 11px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
  ctx.textBaseline = 'top';
  groups.forEach(function (g) {
    var d = 0;
    for (var k = g.from; k < g.to; k++) if (stateOf(jobs[cells[k].i]) === 'done') d++;
    ctx.fillStyle = '#a3a3ae';
    ctx.fillText(g.name.toUpperCase() + '  ·  ' + d + '/' + (g.to - g.from), 0, g.y + 2);
  });
  var pulse = reduce ? 1 : 0.55 + 0.45 * Math.sin(now / 220);
  for (var n = 0; n < cells.length; n++) {
    var c = cells[n], j = jobs[c.i], s = stateOf(j);
    ctx.globalAlpha = s === 'done' && colorMode === 'state' ? 0.85 : s === 'running' ? pulse : 1;
    ctx.fillStyle = colorOf(s, laneOf(j));
    ctx.fillRect(c.x, c.y, cs, cs);
  }
  ctx.globalAlpha = 1;
}

function frame(now) {
  raf = 0;
  if (!dirty) return;
  dirty = false;
  draw(now || performance.now());
}
function schedule() { if (!raf) raf = requestAnimationFrame(frame); }

function hit(e) {
  var r = canvas.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
  for (var n = 0; n < cells.length; n++) {
    var c = cells[n];
    if (x >= c.x && x <= c.x + cs && y >= c.y && y <= c.y + cs) return { c: c, x: x, y: y, r: r };
  }
  return null;
}

function showTip(j, x, y, r) {
  while (tip.firstChild) tip.removeChild(tip.firstChild);
  var dur = typeof j.durationMs === 'number' && isFinite(j.durationMs) ? (j.durationMs / 1000).toFixed(1) + 's' : '–';
  var rows = [
    'id: ' + fmt(j.id), 'file: ' + fmt(j.file), 'lead: ' + fmt(j.lead || 'main'),
    'wave: ' + fmt(j.wave), 'type: ' + fmt(j.type), 'lane: ' + fmt(j.lane),
    'model: ' + fmt(j.model), 'attempts: ' + fmt(j.attempts), 'duration: ' + dur
  ];
  rows.forEach(function (text) {
    var d = document.createElement('div');
    d.textContent = text;
    tip.appendChild(d);
  });
  tip.hidden = false;
  tip.style.left = Math.max(0, Math.min(x + 14, r.width - 240)) + 'px';
  tip.style.top = (y + 16) + 'px';
}

function renderLegend() {
  while (legend.firstChild) legend.removeChild(legend.firstChild);
  var items = colorMode === 'state'
    ? STATE_ORDER.map(function (k) { return [STATE_COL[k], k]; })
    : Object.keys(LANE_COL).map(function (k) { return [LANE_COL[k], k]; });
  items.forEach(function (it) {
    var sp = document.createElement('span');
    var sw = document.createElement('i');
    sw.className = 'sw';
    sw.style.background = it[0];
    sp.appendChild(sw);
    sp.appendChild(document.createTextNode(' ' + it[1]));
    legend.appendChild(sp);
  });
}

function setMode(m) {
  colorMode = m;
  if (btnState) btnState.setAttribute('aria-pressed', String(m === 'state'));
  if (btnLane) btnLane.setAttribute('aria-pressed', String(m === 'lane'));
  renderLegend();
  dirty = true;
  schedule();
}

canvas.addEventListener('mousemove', function (e) {
  var h = hit(e);
  if (!h) { tip.hidden = true; canvas.style.cursor = ''; return; }
  canvas.style.cursor = 'pointer';
  showTip(jobs[h.c.i], h.x, h.y, h.r);
});
canvas.addEventListener('mouseleave', function () { tip.hidden = true; });
canvas.addEventListener('click', function (e) {
  var h = hit(e);
  if (!h) return;
  var sw = window.SwarmWatch;
  if (sw && typeof sw.openJob === 'function') sw.openJob(jobs[h.c.i]);
});
if (btnState) btnState.addEventListener('click', function () { setMode('state'); });
if (btnLane) btnLane.addEventListener('click', function () { setMode('lane'); });
window.addEventListener('resize', function () {
  if (jobs.length && ensureLayout()) { dirty = true; schedule(); }
});

renderLegend();
var sw = window.SwarmWatch;
if (sw && typeof sw.register === 'function') {
  sw.register('run', function (data) {
    var run = data && data.run;
    jobs = run && Array.isArray(run.jobs) ? run.jobs : [];
    ensureLayout();
    dirty = true;
    schedule();
  });
}
})();
