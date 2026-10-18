// SPDX-License-Identifier: Apache-2.0
(function () {
  'use strict';
  var params = new URLSearchParams(location.search);
  var TOKEN = params.get('t') || '';
  var ID = params.get('id') || '';
  var T = encodeURIComponent(TOKEN);
  var $ = function (id) { return document.getElementById(id); };
  function el(tag, cls, text) { var n = document.createElement(tag); if (cls) { n.className = cls; } if (text !== undefined) { n.textContent = text; } return n; }
  function usd(v) { return typeof v === 'number' && isFinite(v) ? '$' + (v > 0 && v < 0.01 ? v.toFixed(4) : v.toFixed(2)) : '-'; }
  function when(iso) { return iso ? String(iso).slice(0, 16).replace('T', ' ') : '-'; }
  $('back').href = '/?t=' + T;

  function render(p) {
    $('title').textContent = p.name;
    $('root').textContent = p.root;
    var s = $('spend'); s.textContent = '';
    [['Today', usd(p.spend.todayUsd)], ['Last 7 days', usd(p.spend.weekUsd)], ['All time', usd(p.spend.allUsd)], ['Flat-rate lanes (list value, not billed)', usd(p.spend.flatRateListUsd)]].forEach(function (pair) {
      var tile = el('div', 'tile'); tile.appendChild(el('div', 'label', pair[0])); tile.appendChild(el('div', 'big num', pair[1])); s.appendChild(tile);
    });
    var lanes = Object.keys(p.spend.byLane).sort();
    var byLane = el('div', 'tile'); byLane.appendChild(el('div', 'label', 'By lane')); byLane.appendChild(el('div', 'sub', lanes.length ? lanes.map(function (k) { return k + ' ' + usd(p.spend.byLane[k]); }).join(', ') : 'none')); s.appendChild(byLane);

    var t = $('tickets'); t.textContent = '';
    var counts = p.ticketCounts.byStatus; 
    t.appendChild(el('div', 'board-note', Object.keys(counts).sort().map(function (k) { return k + ' ' + counts[k]; }).join(', ') || 'No ticket ledger.'));
    ['blocked', 'running', 'review', 'ready', 'todo', 'proposed', 'done'].forEach(function (status) {
      var list = p.tickets.filter(function (x) { return x.status === status; });
      if (!list.length) { return; }
      var d = el('details', 'board-lane'); d.open = status !== 'done';
      d.appendChild(el('summary', '', status + ' (' + list.length + ')'));
      var body = el('div', 'lane-body');
      list.slice(0, 200).forEach(function (x) { body.appendChild(el('div', 'board-entry', x.id + '  ' + (x.stage || '') + '  ' + (x.risk || '') + '  ' + x.title)); });
      d.appendChild(body); t.appendChild(d);
    });

    var r = $('runs'); r.textContent = '';
    if (!p.runs.length) { r.appendChild(el('div', 'board-empty', 'No runs yet.')); }
    p.runs.slice(0, 100).forEach(function (run) {
      var a = el('a', 'board-run'); a.href = '/open/run?id=' + encodeURIComponent(ID) + '&run=' + encodeURIComponent(run.runId) + '&t=' + T;
      a.appendChild(el('span', 'mono', run.runId)); a.appendChild(el('span', 'pill ' + (run.live ? 'good' : run.failed ? 'bad' : 'info'), run.live ? 'live' : run.status));
      a.appendChild(el('span', 'num mono', run.done + '/' + run.jobs + ' jobs' + (run.failed ? ', ' + run.failed + ' failed' : '')));
      a.appendChild(el('span', 'num mono', usd(run.costUsd))); a.appendChild(el('span', 'mono', when(run.startedAt)));
      r.appendChild(a);
    });

    var l = $('lessons'); l.textContent = '';
    if (!p.lessons.length) { l.appendChild(el('div', 'board-empty', 'No lessons recorded here.')); }
    p.lessons.forEach(function (x) { l.appendChild(el('div', 'board-entry', x.id + '  ' + (x.stage || '') + '  ' + (x.what || ''))); });
  }

  function load() {
    fetch('/api/project?id=' + encodeURIComponent(ID) + '&t=' + T, { headers: { 'x-watch-token': TOKEN } })
      .then(function (res) { return res.ok ? res.json() : null; })
      .then(function (p) { if (p) { render(p); } else { $('title').textContent = 'Unknown project'; } })
      .catch(function () {});
  }
  load();
  setInterval(load, 5000);
})();
