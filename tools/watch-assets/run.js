// SPDX-License-Identifier: Apache-2.0
// Run inspector: one run's job graph, a replayable journal with the cost of each job, and a side-by-side compare. Read-only; all data from /api/run.
var L = self.BoardLib;
var params = new URLSearchParams(location.search);
var TOKEN = params.get('t') || '';
var ID = params.get('id') || '';
var RUN = params.get('run') || '';
var T = encodeURIComponent(TOKEN);
var $ = function (id) { return document.getElementById(id); };
var NS = 'http://www.w3.org/2000/svg';
function el(tag, cls, text) { var n = document.createElement(tag); if (cls) { n.className = cls; } if (text !== undefined && text !== null) { n.textContent = text; } return n; }
function usd(v) { return typeof v === 'number' && isFinite(v) ? '$' + (v > 0 && v < 0.01 ? v.toFixed(4) : v.toFixed(2)) : '-'; }
function when(iso) { return iso ? String(iso).slice(11, 19) : '-'; }
function api(extra) { return fetch('/api/run?id=' + encodeURIComponent(ID) + '&run=' + encodeURIComponent(RUN) + (extra || '') + '&t=' + T, { headers: { 'x-watch-token': TOKEN } }).then(function (r) { return r.ok ? r.json() : null; }); }

$('backAll').href = '/?t=' + T;
$('crumbProject').href = '/project?id=' + encodeURIComponent(ID) + '&t=' + T;
$('watchLink').href = '/open/run?id=' + encodeURIComponent(ID) + '&run=' + encodeURIComponent(RUN) + '&t=' + T;
$('crumbRun').textContent = RUN;

var run = null, pos = 0, timer = null;

function tile(title, big, sub) { var t = el('div', 'card kpi'); t.appendChild(el('div', 'l', title)); t.appendChild(el('div', 'v num', big)); t.appendChild(el('div', 's', sub)); return t; }
function renderSummary(r) {
  $('title').textContent = 'Run ' + r.runId;
  $('subtitle').textContent = r.project + ' | started ' + (r.startedAt ? r.startedAt.slice(0, 16).replace('T', ' ') : '-');
  $('crumbProject').textContent = r.project;
  document.title = 'Run ' + r.runId + ' | Swarm Watch';
  var k = $('kpis'); k.textContent = '';
  k.appendChild(tile('Status', r.status || '-', L.duration(r.durationMs)));
  var st = Object.keys(r.totals.byStatus).sort().map(function (s) { return s + ' ' + r.totals.byStatus[s]; }).join(', ');
  k.appendChild(tile('Jobs', String(r.totals.jobs), st || 'none recorded'));
  k.appendChild(tile('Cost', usd(r.totals.usd), r.budgetUsd ? 'run cap ' + usd(r.budgetUsd) : 'no run cap recorded'));
  k.appendChild(tile('Tried more than once', String(r.totals.rerun), r.totals.rerun ? 'jobs with 2 or more attempts' : 'every job ran once'));
  var lanes = Object.keys(r.lanes).sort().map(function (l) { return l + ' ' + r.lanes[l].jobs + ' (' + usd(r.lanes[l].usd) + ')'; }).join(' | ');
  k.appendChild(tile('Lanes', String(Object.keys(r.lanes).length), lanes || 'none'));
}

function renderGraph(r) {
  var box = $('graph'); box.textContent = '';
  $('graphNote').textContent = r.hasGraph ? 'An arrow goes from a job to the job that waited for it.' : 'These jobs did not wait for each other (the run recorded no dependencies), so they sit in one column.';
  if (!r.jobs.length) { box.appendChild(el('div', 'empty', 'This run has no jobs.')); return; }
  var g = L.layoutGraph(r.jobs);
  var svg = document.createElementNS(NS, 'svg');
  var pad = 12;
  svg.setAttribute('width', g.width + 2 * pad); svg.setAttribute('height', g.height + 2 * pad); svg.setAttribute('viewBox', '0 0 ' + (g.width + 2 * pad) + ' ' + (g.height + 2 * pad));
  svg.setAttribute('role', 'group'); svg.setAttribute('aria-label', r.jobs.length + ' jobs');
  g.edges.forEach(function (e) {
    var a = g.pos[e.from], b = g.pos[e.to];
    var p = document.createElementNS(NS, 'path');
    var x1 = pad + a.x + a.w, y1 = pad + a.y + a.h / 2, x2 = pad + b.x, y2 = pad + b.y + b.h / 2, mx = (x1 + x2) / 2;
    p.setAttribute('d', 'M' + x1 + ' ' + y1 + ' C' + mx + ' ' + y1 + ' ' + mx + ' ' + y2 + ' ' + x2 + ' ' + y2);
    p.setAttribute('class', 'edge'); svg.appendChild(p);
  });
  r.jobs.forEach(function (j) {
    var p = g.pos[j.id];
    var n = document.createElementNS(NS, 'g');
    n.setAttribute('class', 'node' + (j.rerun ? ' rerun' : '') + (j.status === 'failed' || j.status === 'timeout' ? ' failed' : '') + (j.status === 'running' ? ' running' : ''));
    n.setAttribute('transform', 'translate(' + (pad + p.x) + ',' + (pad + p.y) + ')');
    n.setAttribute('tabindex', '0'); n.setAttribute('role', 'button'); n.setAttribute('aria-label', 'Job ' + j.id + ', ' + j.lane + ', ' + j.status + (j.rerun ? ', tried more than once' : ''));
    var rect = document.createElementNS(NS, 'rect'); rect.setAttribute('width', p.w); rect.setAttribute('height', p.h); n.appendChild(rect);
    var bar = document.createElementNS(NS, 'rect'); bar.setAttribute('width', 5); bar.setAttribute('height', p.h); bar.setAttribute('rx', 2); bar.style.fill = L.laneColor(j.lane); bar.style.stroke = 'none'; n.appendChild(bar);
    var t1 = document.createElementNS(NS, 'text'); t1.setAttribute('x', 14); t1.setAttribute('y', 18); t1.textContent = j.id.length > 18 ? j.id.slice(0, 17) + '…' : j.id; n.appendChild(t1);
    var t2 = document.createElementNS(NS, 'text'); t2.setAttribute('x', 14); t2.setAttribute('y', 33); t2.setAttribute('class', 't2'); t2.textContent = j.lane + ' | ' + j.status + (j.costUsd ? ' | ' + usd(j.costUsd) : '') + (j.rerun ? ' | x' + j.attempts.length : ''); n.appendChild(t2);
    var show = function () { showDetail(j); };
    n.addEventListener('click', show); n.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { show(); e.preventDefault(); } });
    svg.appendChild(n);
  });
  box.appendChild(svg);
}
function showDetail(j) {
  var lines = [j.id + ': ' + j.lane + (j.model ? ' (' + j.model + ')' : '') + ', ' + j.status + ', ' + L.duration(j.durationMs) + ', ' + usd(j.costUsd) + (j.costSource ? ' (' + j.costSource + ')' : '')];
  if (j.attempts.length > 1) { lines.push('Attempts: ' + j.attempts.map(function (a, i) { return (i + 1) + '. ' + a.lane + ' ' + a.status + (a.error ? ' (' + a.error + ')' : ''); }).join('; ')); }
  if (j.after.length) { lines.push('Waited for: ' + j.after.join(', ')); }
  if (j.error) { lines.push('Error: ' + j.error); }
  $('detail').textContent = lines.join('. ');
}

function renderJournal() {
  var r = run, box = $('journal');
  var st = L.replay(r.journal, pos);
  $('replayStat').textContent = '';
  [['Step', pos + ' of ' + r.journal.length], ['Running', String(st.running)], ['Ended', String(st.ended)], ['Spent so far', usd(st.spentUsd)]].forEach(function (p) { var s = el('span', 'mono'); s.textContent = p[0] + ': ' + p[1]; $('replayStat').appendChild(s); });
  if (!box.childNodes.length) {
    if (!r.journal.length) { box.appendChild(el('div', 'empty', 'The run recorded no times.')); }
    r.journal.forEach(function (e, i) {
      var row = el('div', 'jrow');
      row.appendChild(el('span', 'mono sub', when(e.at))); row.appendChild(el('span', 'lane sub', e.lane));
      row.appendChild(el('span', 'mono', e.job + ' ' + e.event + (e.rerun ? ' (after more than one attempt)' : '') + (e.error ? ': ' + e.error : '')));
      row.appendChild(el('span', 'mono sub', typeof e.usd === 'number' && e.usd ? usd(e.usd) : ''));
      row.dataset.i = String(i); box.appendChild(row);
    });
  }
  Array.prototype.forEach.call(box.children, function (row) {
    if (!row.dataset.i) { return; }
    var i = Number(row.dataset.i);
    row.className = 'jrow ' + (i < pos ? 'past' : 'future') + (i === pos - 1 ? ' now' : '');
  });
  var now = box.querySelector('.now');
  if (now && !timer) { now.scrollIntoView({ block: 'nearest' }); }
}
function setPos(n) { pos = Math.max(0, Math.min(run.journal.length, n)); $('scrub').value = String(pos); renderJournal(); }
function stop() { clearInterval(timer); timer = null; $('play').textContent = 'Play'; }
$('play').addEventListener('click', function () {
  if (timer) { stop(); return; }
  if (pos >= run.journal.length) { setPos(0); }
  $('play').textContent = 'Pause';
  timer = setInterval(function () { if (pos >= run.journal.length) { stop(); return; } setPos(pos + 1); }, 350);
});
$('stepFwd').addEventListener('click', function () { stop(); setPos(pos + 1); });
$('stepBack').addEventListener('click', function () { stop(); setPos(pos - 1); });
$('scrub').addEventListener('input', function () { stop(); setPos(Number($('scrub').value)); });

function diff(a, b, fmt, lowerIsBetter) {
  var s = el('span', 'mono', fmt(b));
  if (typeof a === 'number' && typeof b === 'number' && a !== b) { s.className += (b > a) === lowerIsBetter ? ' diff-up' : ' diff-down'; }
  return s;
}
function renderCompare(c) {
  var box = $('compare'); box.textContent = '';
  if (!c) { $('compareNote').textContent = ''; return; }
  function row(label, a, b) { box.appendChild(el('span', '', label)); var x = el('span'); x.appendChild(a); var y = el('span'); y.appendChild(b); box.appendChild(x); box.appendChild(y); }
  box.appendChild(el('span', 'h', '')); box.appendChild(el('span', 'h mono', 'This run')); box.appendChild(el('span', 'h mono', c.b.runId.length > 20 ? c.b.runId.slice(0, 8) + '…' + c.b.runId.slice(-6) : c.b.runId));
  var A = c.a, B = c.b;
  row('Status', el('span', 'mono', A.status || '-'), el('span', 'mono', B.status || '-'));
  row('Duration', el('span', 'mono', L.duration(A.durationMs)), diff(A.durationMs, B.durationMs, L.duration, true));
  row('Jobs', el('span', 'mono', String(A.totals.jobs)), diff(A.totals.jobs, B.totals.jobs, String, true));
  row('Cost', el('span', 'mono', usd(A.totals.usd)), diff(A.totals.usd, B.totals.usd, usd, true));
  row('Tried more than once', el('span', 'mono', String(A.totals.rerun)), diff(A.totals.rerun, B.totals.rerun, String, true));
  c.lanes.forEach(function (l) { row('Lane ' + l.lane, el('span', 'mono', l.a ? l.a.jobs + ' jobs, ' + usd(l.a.usd) : '-'), el('span', 'mono', l.b ? l.b.jobs + ' jobs, ' + usd(l.b.usd) : '-')); });
  var changed = c.shared.filter(function (s) { return s.a.status !== s.b.status || s.a.rerun !== s.b.rerun; });
  $('compareNote').textContent = c.shared.length + ' job id' + (c.shared.length === 1 ? '' : 's') + ' appear in both runs' + (changed.length ? ' (' + changed.length + ' with a different outcome: ' + changed.slice(0, 6).map(function (s) { return s.id + ' ' + s.a.status + ' to ' + s.b.status; }).join(', ') + ')' : '') + '; only in this run: ' + c.onlyA + ', only in the other: ' + c.onlyB + '. Red means more than this run, green means less.';
}
$('other').addEventListener('change', function () {
  var v = $('other').value;
  if (!v) { renderCompare(null); return; }
  api('&compare=' + encodeURIComponent(v)).then(function (d) { renderCompare(d && d.compare); });
});

api().then(function (r) {
  if (!r) { $('title').textContent = 'Run not found'; $('subtitle').textContent = 'No run ' + RUN + ' in this project.'; return; }
  run = r;
  renderSummary(r); renderGraph(r);
  $('scrub').max = String(r.journal.length);
  setPos(r.journal.length);
});
fetch('/api/project?id=' + encodeURIComponent(ID) + '&t=' + T, { headers: { 'x-watch-token': TOKEN } }).then(function (r) { return r.ok ? r.json() : null; }).then(function (p) {
  if (!p) { return; }
  p.runs.filter(function (x) { return x.runId !== RUN; }).slice(0, 60).forEach(function (x) { var o = el('option', '', x.runId + '  ' + x.status + '  ' + x.done + '/' + x.jobs + ' jobs'); o.value = x.runId; $('other').appendChild(o); });
}).catch(function () {});
