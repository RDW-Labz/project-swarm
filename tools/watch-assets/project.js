// SPDX-License-Identifier: Apache-2.0
(function () {
  'use strict';
  var BoardLib = self.BoardLib;
  var L = BoardLib;
  var TOKEN = BoardLib.watchToken();
  var params = new URLSearchParams(location.search);
  var ID = params.get('id') || '';
  var $ = function (id) { return document.getElementById(id); };
  function el(tag, cls, text) { var n = document.createElement(tag); if (cls) { n.className = cls; } if (text !== undefined) { n.textContent = text; } return n; }
  function pill(text, cls) { return el('span', 'pill ' + (cls || 'info'), text); }
  function when(iso) { return iso ? String(iso).slice(0, 16).replace('T', ' ') : '-'; }
  function runHref(runId) { return '/run?id=' + encodeURIComponent(ID) + '&run=' + encodeURIComponent(runId); }
  $('back').href = '/';
  $('crumbBack').href = '/';
  $('crumbAll').href = '/';

  var panelErrors = Object.create(null);
  function failedPanel(id, error) {
    var host = $(id);
    if (!host) {
      if (!panelErrors[id]) { panelErrors[id] = true; console.error('Swarm Watch panel failed to render:', id, error); }
      return;
    }
    host.textContent = '';
    host.appendChild(el('div', 'board-empty', 'This panel failed to render.'));
    if (!panelErrors[id]) { panelErrors[id] = true; console.error('Swarm Watch panel failed to render:', id, error); }
  }
  function panel(id, fn) { try { fn(); } catch (error) { failedPanel(id, error); } }

  function renderProgress(p) {
    var host = $('progressBody'); host.textContent = '';
    var progressSection = $('progress');
    if (progressSection) {
      var heading = progressSection.querySelector('h2');
      if (heading) { heading.textContent = 'Project status'; }
    }
    if (!p.card) { host.appendChild(el('div', 'board-empty', 'Project status unavailable.')); return; }
    var wrap = el('div', 'watch-project-page-card-wrap');
    L.renderWatchProjectCard(p, wrap, { pageMode: true });
    host.appendChild(wrap);
  }

  function renderSplit(p) {
    var host = $('splitBody'); host.textContent = '';
    var section = $('split');
    if (section) { section.hidden = true; }
    if (!p.card || !p.card.headsUp) { return; }
    if (section) { section.hidden = false; }
    host.appendChild(el('div', 'board-note', 'Wave and split warnings appear in the Heads up row on the project status card above.'));
  }

  function renderHandled(handled) {
    var host = $('handledBody'); host.textContent = '';
    if (!handled) { host.appendChild(el('div', 'board-empty', 'Handled-for-you data unavailable.')); return; }
    var todayWrap = el('div', 'label');
    todayWrap.appendChild(L.watchNum(handled.today, 'handled today', handled.today + ' auto-decision' + (handled.today === 1 ? '' : 's') + ' logged today.'));
    todayWrap.appendChild(el('span', '', ' today · '));
    todayWrap.appendChild(L.watchNum(handled.week, 'handled this week', handled.week + ' auto-decision' + (handled.week === 1 ? '' : 's') + ' logged in the last 7 days.'));
    todayWrap.appendChild(el('span', '', ' this week'));
    host.appendChild(todayWrap);
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
    if (name && name.indexOf('usd') !== -1) { return '—'; }
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

  function renderTickets(p) {
    var t = $('tickets'); t.textContent = '';
    var counts = p.ticketCounts.byStatus;
    var summary = el('div', 'board-note');
    Object.keys(counts).sort().forEach(function (k) {
      if (!counts[k]) { return; }
      summary.appendChild(L.watchNum(counts[k], k + ' tickets', counts[k] + ' ticket' + (counts[k] === 1 ? '' : 's') + ' in status ' + k + '.'));
      summary.appendChild(el('span', '', ' ' + k + ' · '));
    });
    if (!summary.textContent.trim()) { summary.textContent = 'No ticket ledger.'; }
    t.appendChild(summary);
    ['blocked', 'running', 'review', 'ready', 'todo', 'proposed', 'done'].forEach(function (status) {
      var list = p.tickets.filter(function (x) { return x.status === status; });
      if (!list.length) { return; }
      var d = el('details', 'board-lane'); d.open = status !== 'done';
      var sum = el('summary', '');
      sum.appendChild(L.watchNum(list.length, status + ' tickets', list.length + ' ticket' + (list.length === 1 ? '' : 's') + ' in ' + status + '.'));
      sum.appendChild(el('span', '', ' ' + status));
      d.appendChild(sum);
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
      var jobs = el('span', 'num mono');
      jobs.appendChild(L.watchNum(run.done, 'jobs done', run.done + ' of ' + run.jobs + ' jobs finished in this run.'));
      jobs.appendChild(el('span', '', '/' + run.jobs + ' jobs'));
      if (run.failed) {
        jobs.appendChild(el('span', '', ', '));
        jobs.appendChild(L.watchNum(run.failed, 'jobs failed', run.failed + ' job' + (run.failed === 1 ? '' : 's') + ' failed in this run.'));
        jobs.appendChild(el('span', '', ' failed'));
      }
      a.appendChild(jobs);
      a.appendChild(el('span', 'mono', when(run.startedAt)));
      r.appendChild(a);
    });
    var untracked = p.untracked || (p.progress && (p.progress.untracked || p.progress.offLedger));
    if (untracked && untracked.count) {
      var listAnchor = untracked.listAnchorId || 'untracked';
      var offTitle = el('div', 'label');
      offTitle.id = listAnchor;
      offTitle.appendChild(el('span', '', 'Untracked runs · '));
      var countLink = el('a', '');
      countLink.href = '#' + listAnchor;
      countLink.appendChild(L.watchNum(untracked.count, 'untracked runs', (untracked.warning || 'Runs on this project\'s checkouts that no ticket claims.') + ' Smoke tests and lane tests are left out.'));
      countLink.appendChild(el('span', '', ' runs'));
      offTitle.appendChild(countLink);
      r.appendChild(offTitle);
      if (untracked.warning) { r.appendChild(el('div', 'board-note', untracked.warning)); }
      (untracked.runs || untracked.newest || []).forEach(function (run) {
        var row = el('div', 'board-entry');
        var runLink = el('a', 'mono', run.runId);
        runLink.setAttribute('href', run.href || runHref(run.runId));
        runLink.setAttribute('title', 'Open the run inspector');
        row.appendChild(runLink);
        row.appendChild(el('span', 'sub', ' · ' + when(run.startedAt) + ' · ' + run.status + ' · ' + (run.jobs || 0) + ' jobs'));
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
    var live = L.chipState
      ? L.chipState({ lastOkAt: at, now: Date.now(), pollMs: 5000, everOk: projectEverOk })
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

  function loadErrorReason(err) {
    if (typeof err === 'string') { return err.slice(0, 120); }
    if (err && err.message) { return String(err.message).slice(0, 120); }
    return 'unknown error';
  }
  function showLoadError(reason) {
    var main = document.querySelector('main');
    if (!main) { return; }
    var banner = $('projectLoadError');
    if (!banner) {
      banner = el('div', 'board-empty');
      banner.id = 'projectLoadError';
      banner.setAttribute('role', 'alert');
      main.insertBefore(banner, main.firstChild);
    }
    banner.textContent = 'Could not load this project: ' + reason;
  }
  function clearLoadError() {
    var banner = $('projectLoadError');
    if (banner) { banner.remove(); }
  }

  function render(p) {
    if ($('title')) { $('title').textContent = p.name; }
    if ($('crumbProject')) { $('crumbProject').textContent = p.name; }
    if ($('root')) { $('root').textContent = p.root; }
    panel('progressBody', function () { renderProgress(p); });
    panel('splitBody', function () { renderSplit(p); });
    panel('benchBody', function () { renderBench(p.benchmarks); });
    panel('handledBody', function () { renderHandled(p.handled); });
    panel('tickets', function () { renderTickets(p); });
    panel('runs', function () { renderRuns(p); });
    panel('lessons', function () { renderLessons(p); });
  }

  function load() {
    fetch('/api/project?id=' + encodeURIComponent(ID), { headers: { 'x-watch-token': TOKEN } })
      .then(function (res) {
        if (!res.ok) {
          showLoadError('HTTP ' + res.status);
          return null;
        }
        return res.json();
      })
      .then(function (p) {
        if (!p) { return; }
        try {
          markProjectResponse();
          render(p);
          clearLoadError();
        } catch (error) {
          showLoadError(loadErrorReason(error));
        }
      })
      .catch(function (err) {
        showLoadError(err && err.name === 'SyntaxError' ? 'invalid JSON' : loadErrorReason(err));
      });
  }
  load();
  setInterval(load, 5000);
})();
