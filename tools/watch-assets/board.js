// SPDX-License-Identifier: Apache-2.0
(function () {
  'use strict';
  var TOKEN = new URLSearchParams(location.search).get('t') || '';
  var T = encodeURIComponent(TOKEN);
  var $ = function (id) { return document.getElementById(id); };
  var open = Object.create(null);          // lane open state the person chose, by project id
  var projects = [];

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) { n.className = cls; }
    if (text !== undefined) { n.textContent = text; }
    return n;
  }
  function usd(v) { return typeof v === 'number' && isFinite(v) ? '$' + (v > 0 && v < 0.01 ? v.toFixed(4) : v.toFixed(2)) : '-'; }
  function ago(iso) {
    var t = Date.parse(iso);
    if (!isFinite(t)) { return 'never'; }
    var m = Math.max(0, Math.round((Date.now() - t) / 60000));
    return m < 1 ? 'just now' : m < 60 ? m + ' min ago' : m < 2880 ? Math.round(m / 60) + ' h ago' : Math.round(m / 1440) + ' d ago';
  }
  function runHref(projectId, runId) { return '/open/run?id=' + encodeURIComponent(projectId) + '&run=' + encodeURIComponent(runId) + '&t=' + T; }
  function projectHref(projectId) { return '/project?id=' + encodeURIComponent(projectId) + '&t=' + T; }
  function link(href, cls, parts) { var a = el('a', cls); a.href = href; parts.forEach(function (p) { a.appendChild(p); }); return a; }

  function tile(title, big, sub) {
    var t = el('div', 'tile');
    t.appendChild(el('div', 'label', title));
    t.appendChild(el('div', 'big num', big));
    t.appendChild(el('div', 'sub', sub));
    return t;
  }
  function pairs(map, fmt) {
    var keys = Object.keys(map || {}).filter(function (k) { return map[k]; }).sort();
    return keys.length ? keys.map(function (k) { return k + ' ' + fmt(map[k]); }).join(', ') : 'none';
  }

  function renderMachine(m, list) {
    var names = {};
    list.forEach(function (p) { names[p.id] = p.name; });
    var box = $('machine');
    box.textContent = '';
    var grid = el('div', 'board-totals');
    var byProject = {};
    Object.keys(m.agents.byProject).forEach(function (id) { byProject[names[id] || id] = m.agents.byProject[id]; });
    grid.appendChild(tile('Live agents', String(m.agents.total), 'by lane: ' + pairs(m.agents.byLane, String) + ' | by project: ' + pairs(byProject, String)));
    var c = m.cost;
    grid.appendChild(tile('Spend today', usd(c.todayUsd), 'last 7 days ' + usd(c.weekUsd)));
    grid.appendChild(tile('Spend, all time', usd(c.allUsd), 'billed per use ' + usd(c.paidUsd) + ' (of which estimated ' + usd(c.paidEstimatedUsd) + ') | flat-rate lanes (Codex, Cursor, Claude subscription), list value only, not billed ' + usd(c.flatRateListUsd)));
    var per = {};
    Object.keys(c.byProject).forEach(function (id) { per[c.byProject[id].name || id] = usd(c.byProject[id].allUsd); });
    grid.appendChild(tile('By project', String(Object.keys(per).length), Object.keys(per).sort().map(function (k) { return k + ' ' + per[k]; }).join(', ') || 'none'));
    box.appendChild(grid);
  }

  function chip(text, cls) { return el('span', 'pill ' + (cls || 'info'), text); }

  function renderLane(p) {
    var d = el('details', 'board-lane');
    d.dataset.id = p.id;
    d.open = Object.prototype.hasOwnProperty.call(open, p.id) ? open[p.id] : !p.idle;
    d.addEventListener('toggle', function () { open[p.id] = d.open; });
    var s = el('summary');
    s.appendChild(el('span', 'name', p.name));
    s.appendChild(chip(p.stage ? 'stage ' + p.stage : 'no stage', 'lav'));
    s.appendChild(chip(p.live.length + ' live run' + (p.live.length === 1 ? '' : 's'), p.live.length ? 'good' : 'info'));
    s.appendChild(el('span', 'num mono', 'jobs ' + p.agents.jobs.running + ' running, ' + p.agents.jobs.queued + ' queued, ' + p.agents.jobs.blocked + ' blocked'));
    s.appendChild(el('span', 'num mono', p.tickets.open + ' open ticket' + (p.tickets.open === 1 ? '' : 's') + (p.tickets.blocked ? ', ' + p.tickets.blocked + ' blocked' : '')));
    var cap = p.spend.capUsd;
    s.appendChild(el('span', 'num mono', 'spend ' + usd(p.spend.usd) + (cap ? ' of ' + usd(cap) : '')));
    if (p.spend.noCap) { s.appendChild(chip('NO CAP', 'warn')); }
    if (p.spend.capInvalid) { s.appendChild(chip('CAP INVALID', 'bad')); }
    if (p.spend.reached) { s.appendChild(chip('CAP REACHED', 'bad')); }
    s.appendChild(el('span', 'mono', 'last activity ' + ago(p.lastActivityAt)));
    d.appendChild(s);
    var body = el('div', 'lane-body');
    body.appendChild(link(projectHref(p.id), 'board-link', [el('span', '', 'Open project page: tickets by status, run history, spend, lessons')]));
    if (!p.live.length) { body.appendChild(el('div', 'board-note', 'No live runs. Last run ' + ago(p.lastRunAt) + '.')); }
    p.live.forEach(function (r) {
      var bar = el('div', 'board-bar'); var fill = el('i'); fill.style.width = (r.jobs ? Math.round(100 * r.done / r.jobs) : 0) + '%'; bar.appendChild(fill);
      body.appendChild(link(runHref(p.id, r.runId), 'board-run', [el('span', 'mono', r.runId), chip(r.status, 'info'), el('span', 'num mono', r.done + '/' + r.jobs + ' jobs'), bar]));
    });
    d.appendChild(body);
    return d;
  }

  function renderBoard(data) {
    projects = data.projects;
    $('count').textContent = projects.length + (projects.length === 1 ? ' project' : ' projects');
    $('updated').textContent = new Date().toLocaleTimeString();
    renderMachine(data.machine, projects);
    var lanes = $('lanes');
    lanes.textContent = '';
    if (!projects.length) { lanes.appendChild(el('div', 'board-empty', 'No projects yet. Run a swarm command inside a project, or swarm projects add PATH.')); }
    projects.slice().sort(function (a, b) { return (b.live.length - a.live.length) || String(b.lastActivityAt).localeCompare(String(a.lastActivityAt)); }).forEach(function (p) { lanes.appendChild(renderLane(p)); });
    var sel = $('fproject'); var keep = sel.value;
    if (sel.options.length - 1 !== projects.length) {
      while (sel.options.length > 1) { sel.remove(1); }
      projects.forEach(function (p) { var o = el('option', '', p.name); o.value = p.id; sel.appendChild(o); });
      sel.value = keep;
    }
  }

  function query() {
    var q = new URLSearchParams();
    [['q', 'q'], ['project', 'fproject'], ['kind', 'fkind'], ['from', 'ffrom'], ['to', 'fto']].forEach(function (pair) { var v = $(pair[1]).value; if (v) { q.set(pair[0], v); } });
    return q;
  }

  function entryNode(e) {
    var parts = [el('span', 'when mono', e.at.slice(0, 16).replace('T', ' ')), el('span', 'kind', e.kind), el('span', '', e.project + ': ' + e.title)];
    if (typeof e.usd === 'number') { parts.push(el('span', 'num mono', usd(e.usd))); }
    var known = projects.some(function (p) { return p.id === e.projectId; });
    var node;
    if (e.run && known && (e.kind === 'run' || e.kind === 'spend')) { node = link(runHref(e.projectId, e.run), 'board-entry', parts); }
    else if (e.url && (e.kind === 'pr' || e.kind === 'merge')) { node = link(e.url, 'board-entry', parts); node.rel = 'noopener noreferrer'; node.target = '_blank'; }
    else if (known) { node = link(projectHref(e.projectId), 'board-entry', parts); }
    else { node = el('div', 'board-entry'); parts.forEach(function (p) { node.appendChild(p); }); }
    return node;
  }

  function loadHistory() {
    var q = query();
    var csv = new URLSearchParams(q); csv.set('t', TOKEN);
    $('csv').href = '/history.csv?' + csv.toString();
    var api = new URLSearchParams(q); api.set('t', TOKEN); api.set('limit', '100');
    fetch('/api/history?' + api.toString(), { headers: { 'x-watch-token': TOKEN } })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (data) {
        if (!data) { return; }
        var box = $('history'); box.textContent = '';
        if (!data.events.length) { box.appendChild(el('div', 'board-empty', 'Nothing matches.')); }
        data.events.forEach(function (e) { box.appendChild(entryNode(e)); });
        $('historyNote').textContent = 'Showing ' + data.events.length + ' of ' + data.total + ' event(s), newest first. The log is append-only and kept on disk.';
      }).catch(function () {});
  }

  function poll() {
    fetch('/api/board?t=' + T, { headers: { 'x-watch-token': TOKEN } })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (data) { if (data) { renderBoard(data); } })
      .catch(function () {});
  }

  var debounce = null;
  $('filters').addEventListener('input', function () { clearTimeout(debounce); debounce = setTimeout(loadHistory, 300); });
  $('filters').addEventListener('submit', function (e) { e.preventDefault(); loadHistory(); });
  poll(); loadHistory();
  setInterval(poll, 2000);
  setInterval(loadHistory, 10000);
})();
