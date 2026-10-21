// SPDX-License-Identifier: Apache-2.0
(function () {
  'use strict';
  var TOKEN = self.BoardLib.watchToken();
  var params = new URLSearchParams(location.search);
  var ID = params.get('id') || '';
  var $ = function (id) { return document.getElementById(id); };
  function el(tag, cls, text) { var n = document.createElement(tag); if (cls) { n.className = cls; } if (text !== undefined) { n.textContent = text; } return n; }
  function meter(pct) { var m = el('div', 'meter'); var i = el('i'); i.style.width = Math.max(0, Math.min(100, typeof pct === 'number' ? pct : 0)) + '%'; m.appendChild(i); m.setAttribute('role', 'img'); m.setAttribute('aria-label', (typeof pct === 'number' ? Math.round(pct) : 0) + ' percent'); return m; }
  function usd(v) { return typeof v === 'number' && isFinite(v) ? '$' + (v > 0 && v < 0.01 ? v.toFixed(4) : v.toFixed(2)) : '-'; }
  function when(iso) { return iso ? String(iso).slice(0, 16).replace('T', ' ') : '-'; }
  function runHref(runId) { return '/run?id=' + encodeURIComponent(ID) + '&run=' + encodeURIComponent(runId); }
  $('back').href = '/';
  $('crumbBack').href = '/';
  $('crumbAll').href = '/';

  function progressList(title, items) {
    var box = el('div', 'progress-list');
    box.appendChild(el('div', 'label', title));
    var list = el('ul', 'board-list');
    if (!items.length) { list.appendChild(el('li', 'board-entry sub', 'none')); }
    items.forEach(function (item) { list.appendChild(el('li', 'board-entry', item)); });
    box.appendChild(list);
    return box;
  }

  var panelErrors = Object.create(null);
  function failedPanel(id, error) {
    var host = $(id); host.textContent = ''; host.appendChild(el('div', 'board-empty', 'This panel failed to render.'));
    if (!panelErrors[id]) { panelErrors[id] = true; console.error('Swarm Watch panel failed to render:', id, error); }
  }
  function panel(id, fn) { try { fn(); } catch (error) { failedPanel(id, error); } }

  function renderProgress(progress) {
    var host = $('progressBody'); host.textContent = '';
    if (!progress) { host.appendChild(el('div', 'board-empty', 'Build progress unavailable.')); return; }
    var overall = progress.percent && progress.percent.overall;
    var tickets = progress.percent && progress.percent.tickets || { done: 0, total: 0 };
    var requirements = progress.percent && progress.percent.requirements;
    var headlineText = progress.headline || ('build ' + tickets.done + '/' + tickets.total);
    var headline = el('div', 'livebar'); headline.appendChild(meter(overall));
    headline.appendChild(el('strong', 'big num', overall === null || overall === undefined ? 'Unknown' : String(overall) + '%'));
    headline.appendChild(el('span', 'sub', headlineText));
    host.appendChild(headline);

    var milestones = el('ol', 'milestones');
    (progress.milestones || []).forEach(function (item) {
      var classes = item.state + (item.state === 'current' && item.currentDone ? ' done' : '');
      var label = item.label + (item.evidence === 'not tracked' ? ' · not tracked' : '');
      var li = el('li', classes, label); var title = [item.evidence, item.at].filter(Boolean).join(' · '); if (title) { li.setAttribute('title', title); } if (item.state === 'current') { li.setAttribute('aria-current', 'step'); } milestones.appendChild(li);
    });
    host.appendChild(milestones);

    if (progress.scopes && progress.scopes.length) {
      host.appendChild(el('div', 'label', 'Scopes'));
      var scopeList = el('div', 'board-list');
      progress.scopes.forEach(function (scope) {
        var label = scope.name + ' · build ' + scope.build.done + '/' + scope.build.total + ' · human ' + scope.human.done + '/' + scope.human.total;
        if (scope.done) {
          var details = el('details', 'board-entry');
          details.appendChild(el('summary', '', label + ' · done'));
          details.appendChild(el('div', 'sub', scope.current || 'Finished'));
          scopeList.appendChild(details);
        } else {
          var row = el('div', 'board-entry');
          row.appendChild(el('span', 'name', scope.name));
          row.appendChild(meter(scope.build.total ? scope.build.done * 100 / scope.build.total : 0));
          row.appendChild(el('span', 'mono sub', 'build ' + scope.build.done + '/' + scope.build.total + ' · human ' + scope.human.done + '/' + scope.human.total + ' · ' + (scope.current || 'Unknown')));
          scopeList.appendChild(row);
        }
      });
      host.appendChild(scopeList);
    }

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

    var untracked = progress.untracked || progress.offLedger;
    if (untracked && (untracked.count || untracked.jobs)) {
      var untrackedHead = el('div', 'label');
      untrackedHead.appendChild(el('span', '', 'Untracked work · '));
      var untrackedCount = el('a', '');
      untrackedCount.setAttribute('href', untracked.countHref || ('#' + (untracked.listAnchorId || 'untracked')));
      untrackedCount.textContent = String(untracked.count || 0) + ' run' + (untracked.count === 1 ? '' : 's');
      untrackedHead.appendChild(untrackedCount);
      host.appendChild(untrackedHead);
      host.appendChild(el('div', 'board-note', untracked.warning || 'untracked work: no ledger ticket'));
      (untracked.runs || untracked.newest || []).forEach(function (run) {
        var row = el('div', 'board-entry');
        var runLink = el('a', 'mono', run.runId);
        runLink.setAttribute('href', run.href || runHref(run.runId));
        runLink.setAttribute('title', 'Open the run inspector');
        row.appendChild(runLink);
        row.appendChild(el('span', 'sub', ' · ' + (run.name || run.runId) + ' · ' + run.status + ' · ' + when(run.startedAt)));
        host.appendChild(row);
      });
    }

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

  function renderHandled(handled) {
    var host = $('handledBody'); host.textContent = '';
    if (!handled) { host.appendChild(el('div', 'board-empty', 'Handled-for-you data unavailable.')); return; }
    host.appendChild(el('div', 'label', handled.today + ' today · ' + handled.week + ' this week'));
    if (!handled.items || !handled.items.length) {
      host.appendChild(el('div', 'board-empty', 'Nothing handled yet. The policy engine logs auto-decisions here.'));
      return;
    }
    handled.items.forEach(function (item) {
      var parts = [when(item.at), item.rule, [item.requestKind, item.requestId].filter(Boolean).join(' ') || null, item.reason].filter(Boolean);
      host.appendChild(el('div', 'board-entry', parts.join(' · ')));
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

  function renderSpend(p) {
    var s = $('spend'); s.textContent = '';
    [['Billed today', usd(p.spend.todayUsd)], ['Billed, 7 days', usd(p.spend.weekUsd)], ['Billed, all time', usd(p.spend.billedUsd ?? p.spend.paidUsd)], ['List value, all time (not billed)', usd(p.spend.listUsd ?? p.spend.flatRateListUsd)]].forEach(function (pair) {
      var tile = el('div', 'tile'); tile.appendChild(el('div', 'label', pair[0])); tile.appendChild(el('div', 'big num', pair[1])); s.appendChild(tile);
    });
    var lanes = Object.keys(p.spend.byLane).sort();
    var byLane = el('div', 'tile'); byLane.appendChild(el('div', 'label', 'By lane (billed + list value)')); byLane.appendChild(el('div', 'sub', lanes.length ? lanes.map(function (k) { return k + ' ' + usd(p.spend.byLane[k]); }).join(', ') : 'none')); s.appendChild(byLane);
  }

  function renderTickets(p) {
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
  }

  function renderRuns(p) {
    var r = $('runs'); r.textContent = '';
    if (!p.runs.length) { r.appendChild(el('div', 'board-empty', 'No runs yet.')); }
    p.runs.slice(0, 100).forEach(function (run) {
      var a = el('a', 'board-run'); a.href = runHref(run.runId); a.title = 'Open the run inspector (graph, journal, compare)';
      a.appendChild(el('span', 'mono', run.runId)); a.appendChild(el('span', 'pill ' + (run.live ? 'good' : run.failed ? 'bad' : 'info'), run.live ? 'live' : run.status));
      a.appendChild(el('span', 'num mono', run.done + '/' + run.jobs + ' jobs' + (run.failed ? ', ' + run.failed + ' failed' : '')));
      a.appendChild(el('span', 'num mono', usd(run.costUsd))); a.appendChild(el('span', 'mono', when(run.startedAt)));
      r.appendChild(a);
    });
    var off = p.offLedger || (p.progress && (p.progress.offLedger || p.progress.untracked));
    if (off && off.count) {
      var listAnchor = off.listAnchorId || 'untracked';
      var offTitle = el('div', 'label', 'Off-ledger work'); offTitle.id = listAnchor; r.appendChild(offTitle);
      off.runs.forEach(function (run) {
        var row = el('div', 'board-entry');
        var runLink = el('a', 'mono', run.runId);
        runLink.setAttribute('href', run.href || runHref(run.runId));
        runLink.setAttribute('title', 'Open the run inspector');
        row.appendChild(runLink);
        row.appendChild(el('span', 'sub', ' · ' + when(run.startedAt) + ' · ' + run.status + ' · ' + run.jobs + ' jobs'));
        r.appendChild(row);
      });
    }
  }

  function renderLessons(p) {
    var l = $('lessons'); l.textContent = '';
    if (!p.lessons.length) { l.appendChild(el('div', 'board-empty', 'No lessons recorded here.')); }
    p.lessons.forEach(function (x) { l.appendChild(el('div', 'board-entry', x.id + '  ' + (x.stage || '') + '  ' + (x.what || ''))); });
  }

  var projectEverOk = false;
  function markProjectResponse() {
    window.__swarmProjectOkAt = Date.now();
    projectEverOk = true;
  }

  // Both project requests share the page chip. Mark successful responses before their
  // JSON/render continuations, so a renderer exception cannot make a good response stale.
  if (!window.__swarmProjectFetchWrapped) {
    var projectFetch = window.fetch.bind(window);
    window.fetch = function (input, init) {
      var url = typeof input === 'string' ? input : input && input.url || '';
      return projectFetch(input, init).then(function (response) {
        if (response.ok && (url.indexOf('/api/project') >= 0 || url.indexOf('/api/live') >= 0)) markProjectResponse();
        return response;
      });
    };
    window.__swarmProjectFetchWrapped = true;
  }
  setInterval(function () {
    var at = Number(window.__swarmProjectOkAt) || 0;
    var live = window.BoardLib && window.BoardLib.chipState
      ? window.BoardLib.chipState({ lastOkAt: at, now: Date.now(), pollMs: 5000, everOk: projectEverOk })
      : { state: projectEverOk ? 'live' : 'connecting', ageS: null };
    var dot = $('liveDot'), label = $('liveText');
    if (dot && label) {
      dot.className = 'dot' + (live.state === 'live' ? '' : ' off');
      label.textContent = live.state === 'live' ? 'Live' : 'connecting';
      if (live.state === 'connecting' && live.ageS !== null) {
        label.setAttribute('title', 'last update ' + live.ageS + ' s ago');
      } else {
        label.removeAttribute('title');
      }
    }
  }, 250);

  function render(p) {
    $('title').textContent = p.name;
    $('crumbProject').textContent = p.name;
    $('root').textContent = p.root;
    panel('spend', function () { renderSpend(p); });
    panel('progressBody', function () { renderProgress(p.progress); });
    panel('splitBody', function () { renderSplit(p.splitQuality); });
    panel('benchBody', function () { renderBench(p.benchmarks); });
    panel('handledBody', function () { renderHandled(p.handled); });
    panel('tickets', function () { renderTickets(p); });
    panel('runs', function () { renderRuns(p); });
    panel('lessons', function () { renderLessons(p); });
  }

  function load() {
    fetch('/api/project?id=' + encodeURIComponent(ID), { headers: { 'x-watch-token': TOKEN } })
      .then(function (res) { return res.ok ? res.json() : null; })
      .then(function (p) { if (p) { markProjectResponse(); render(p); } else { $('title').textContent = 'Unknown project'; } })
      .catch(function () {});
  }
  load();
  setInterval(load, 5000);
})();
