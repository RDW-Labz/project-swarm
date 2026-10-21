// SPDX-License-Identifier: Apache-2.0
(function () {
  'use strict';
  var params = new URLSearchParams(location.search);
  var TOKEN = params.get('t') || '';
  var ID = params.get('id') || '';
  var T = encodeURIComponent(TOKEN);
  var $ = function (id) { return document.getElementById(id); };
  function el(tag, cls, text) { var n = document.createElement(tag); if (cls) { n.className = cls; } if (text !== undefined) { n.textContent = text; } return n; }
  function meter(pct) { var m = el('div', 'meter'); var i = el('i'); i.style.width = Math.max(0, Math.min(100, typeof pct === 'number' ? pct : 0)) + '%'; m.appendChild(i); m.setAttribute('role', 'img'); m.setAttribute('aria-label', (typeof pct === 'number' ? Math.round(pct) : 0) + ' percent'); return m; }
  function usd(v) { return typeof v === 'number' && isFinite(v) ? '$' + (v > 0 && v < 0.01 ? v.toFixed(4) : v.toFixed(2)) : '-'; }
  function when(iso) { return iso ? String(iso).slice(0, 16).replace('T', ' ') : '-'; }
  $('back').href = '/?t=' + T;
  $('crumbBack').href = '/?t=' + T;
  $('crumbAll').href = '/?t=' + T;

  function progressList(title, items) {
    var box = el('div', 'progress-list');
    box.appendChild(el('div', 'label', title));
    var list = el('ul', 'board-list');
    if (!items.length) { list.appendChild(el('li', 'board-entry sub', 'none')); }
    items.forEach(function (item) { list.appendChild(el('li', 'board-entry', item)); });
    box.appendChild(list);
    return box;
  }

  function renderProgress(progress) {
    var host = $('progressBody'); host.textContent = '';
    if (!progress) { host.appendChild(el('div', 'board-empty', 'Build progress unavailable.')); return; }
    var overall = progress.percent && progress.percent.overall;
    var tickets = progress.percent && progress.percent.tickets || { done: 0, total: 0 };
    var requirements = progress.percent && progress.percent.requirements;
    var headline = el('div', 'livebar'); headline.appendChild(meter(overall));
    headline.appendChild(el('strong', 'big num', overall === null || overall === undefined ? 'Unknown' : String(overall) + '%'));
    headline.appendChild(el('span', 'sub', 'tickets ' + tickets.done + '/' + tickets.total + ', requirements ' + (requirements ? requirements.covered + '/' + requirements.total : '—')));
    host.appendChild(headline);

    var milestones = el('ol', 'milestones');
    (progress.milestones || []).forEach(function (item) {
      var li = el('li', item.state, item.label); var title = [item.evidence, item.at].filter(Boolean).join(' · '); if (title) { li.setAttribute('title', title); } if (item.state === 'current') { li.setAttribute('aria-current', 'step'); } milestones.appendChild(li);
    });
    host.appendChild(milestones);

    var stages = el('div', 'board-list');
    (progress.stages || []).forEach(function (stage) {
      var row = el('div', 'board-entry'); row.appendChild(el('span', 'name', stage.title || stage.id)); row.appendChild(meter(stage.pct)); row.appendChild(el('span', 'mono sub', stage.done + ' done/' + stage.open + ' open/' + stage.blocked + ' blocked')); stages.appendChild(row);
    });
    if (!stages.childNodes.length) { stages.appendChild(el('div', 'board-empty', 'No stages recorded.')); }
    host.appendChild(stages);

    var left = progress.left || { openByType: {}, human: [], blockers: [], approvals: [] };
    var types = Object.keys(left.openByType || {}).sort().map(function (type) { return type + ': ' + left.openByType[type]; });
    var humans = (left.human || []).map(function (item) { return item.id + ' · ' + item.title + (item.stage ? ' · ' + item.stage : ''); });
    var blockers = (left.blockers || []).map(function (item) { return item.id + ' · ' + item.title + ' — ' + item.reason; });
    var approvals = (left.approvals || []).map(function (item) { return item.kind + ': ' + item.id + ' · ' + item.title; });
    host.appendChild(el('div', 'label', 'What is left'));
    host.appendChild(progressList('Open by type', types));
    host.appendChild(progressList('Human tickets', humans));
    host.appendChild(progressList('Blockers', blockers));
    host.appendChild(progressList('Approvals', approvals));

    host.appendChild(el('div', 'board-note', progress.eta ? 'ETA ~' + progress.eta.days + ' days (' + progress.eta.basis + ')' : 'ETA: not enough history'));
    if (progress.spend) {
      host.appendChild(el('div', 'board-note', usd(progress.spend.usd) + ' of ' + (progress.spend.capUsd === null ? 'no cap' : usd(progress.spend.capUsd)) + ' (cap counts: ' + (progress.spend.capBasis === 'billed' ? 'billed only' : 'billed + list value') + ')'));
      if (progress.spend.why) { host.appendChild(el('div', 'board-note', progress.spend.why)); }
    }
  }

  function renderSplit(split) {
    var host = $('splitBody'); host.textContent = '';
    if (!split) { host.appendChild(el('div', 'board-empty', 'Split quality unavailable.')); return; }
    var grade = split.grade || 'unknown';
    var header = el('div', 'row'); header.appendChild(el('span', 'label', 'Overall grade'));
    header.appendChild(pill(grade, grade === 'green' ? 'good' : grade === 'amber' ? 'warn' : grade === 'red' ? 'bad' : 'quiet'));
    host.appendChild(header);
    (split.metrics || []).forEach(function (metric) {
      var row = el('div', 'board-entry');
      row.setAttribute('title', metric.note || '');
      row.appendChild(el('span', 'dot grade-' + (metric.grade || 'unknown')));
      var body = el('div', 'split-text');
      var top = el('div', 'row'); top.appendChild(el('span', 'name', metric.label || metric.key || 'Metric')); top.appendChild(el('span', 'mono', metric.display || '—')); body.appendChild(top);
      body.appendChild(el('div', 'sub', metric.grade === 'unknown' ? (metric.note || 'Unknown') : (metric.basis || metric.note || '')));
      row.appendChild(body); host.appendChild(row);
    });
  }

  function benchValue(name, value) {
    if (typeof value !== 'number' || !isFinite(value)) { return '—'; }
    if (name && name.slice(-3) === '_ms') { return (value / 3600000).toFixed(1) + 'h'; }
    if (name && name.indexOf('rate') !== -1 && value >= 0 && value <= 1) { return Math.round(value * 100) + '%'; }
    if (name && name.slice(-4) === '_pct') { return value.toFixed(1) + '%'; }
    if (name && name.indexOf('usd') !== -1) { return '$' + value.toFixed(2); }
    return String(value);
  }
  function sparkline(weekly, label) {
    var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'spark'); svg.setAttribute('width', '120'); svg.setAttribute('height', '24'); svg.setAttribute('viewBox', '0 0 120 24');
    svg.setAttribute('role', 'img'); svg.setAttribute('aria-label', 'Weekly values for ' + label);
    var values = (weekly || []).filter(function (point) { return point && typeof point.value === 'number' && isFinite(point.value); }).map(function (point) { return point.value; });
    if (values.length) {
      var min = Math.min.apply(null, values), max = Math.max.apply(null, values), span = max - min || 1;
      var points = values.map(function (value, index) {
        var x = values.length === 1 ? 60 : index * 120 / (values.length - 1);
        var y = 21 - ((value - min) / span) * 18;
        return x.toFixed(1) + ',' + y.toFixed(1);
      }).join(' ');
      var line = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
      line.setAttribute('fill', 'none'); line.setAttribute('stroke', 'currentColor'); line.setAttribute('stroke-width', '2'); line.setAttribute('points', points);
      svg.appendChild(line);
    }
    return svg;
  }
  function renderBench(benchmarks) {
    var host = $('benchBody'); host.textContent = '';
    if (!benchmarks) { host.appendChild(el('div', 'board-empty', 'Benchmark scorecard unavailable.')); return; }
    if (benchmarks.files === 0) {
      host.appendChild(el('div', 'board-empty', 'No scorecard yet. Run swarm eval baseline then swarm eval scorecard (writes evals/scorecard/latest.json).'));
      return;
    }
    host.appendChild(el('div', 'board-note', 'Week ' + (benchmarks.week || '—') + ' · ' + (benchmarks.headline || '')));
    (benchmarks.projects || []).forEach(function (project) {
      host.appendChild(el('div', 'label', project.project || 'Project'));
      (project.metrics || []).forEach(function (metric) {
        var row = el('div', 'board-entry');
        row.appendChild(el('span', 'dot grade-' + (metric.grade || 'unknown')));
        var body = el('div', 'split-text');
        var top = el('div', 'row');
        top.appendChild(el('span', 'name', metric.label || metric.name));
        top.appendChild(el('span', 'mono', benchValue(metric.name, metric.value)));
        body.appendChild(top);
        if (metric.previous !== null && metric.previous !== undefined) {
          body.appendChild(el('div', 'sub', 'was ' + benchValue(metric.name, metric.previous)));
        }
        row.appendChild(body);
        row.appendChild(sparkline(metric.weekly, metric.label || metric.name));
        row.appendChild(pill(metric.verdict || 'unknown', metric.verdict === 'better' ? 'good' : metric.verdict === 'worse' ? 'bad' : 'quiet'));
        host.appendChild(row);
      });
    });
    if (benchmarks.skipped && benchmarks.skipped.length) { host.appendChild(el('div', 'board-note', benchmarks.skipped.length + ' scorecard file' + (benchmarks.skipped.length === 1 ? '' : 's') + ' skipped.')); }
  }

  function render(p) {
    $('title').textContent = p.name;
    $('crumbProject').textContent = p.name;
    $('root').textContent = p.root;
    var s = $('spend'); s.textContent = '';
    [['Billed today', usd(p.spend.todayUsd)], ['Billed, 7 days', usd(p.spend.weekUsd)], ['Billed, all time', usd(p.spend.billedUsd ?? p.spend.paidUsd)], ['List value, all time (not billed)', usd(p.spend.listUsd ?? p.spend.flatRateListUsd)]].forEach(function (pair) {
      var tile = el('div', 'tile'); tile.appendChild(el('div', 'label', pair[0])); tile.appendChild(el('div', 'big num', pair[1])); s.appendChild(tile);
    });
    var lanes = Object.keys(p.spend.byLane).sort();
    var byLane = el('div', 'tile'); byLane.appendChild(el('div', 'label', 'By lane (billed + list value)')); byLane.appendChild(el('div', 'sub', lanes.length ? lanes.map(function (k) { return k + ' ' + usd(p.spend.byLane[k]); }).join(', ') : 'none')); s.appendChild(byLane);

    renderProgress(p.progress);
    renderSplit(p.splitQuality);
    renderBench(p.benchmarks);

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
      var a = el('a', 'board-run'); a.href = '/run?id=' + encodeURIComponent(ID) + '&run=' + encodeURIComponent(run.runId) + '&t=' + T; a.title = 'Open the run inspector (graph, journal, compare)';
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
