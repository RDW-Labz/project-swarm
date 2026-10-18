// SPDX-License-Identifier: Apache-2.0
(function () {
  'use strict';
  var TOKEN = new URLSearchParams(location.search).get('t') || '';
  var list = document.getElementById('runs');
  var count = document.getElementById('count');
  var updated = document.getElementById('updated');

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) { n.className = cls; }
    if (text !== undefined) { n.textContent = text; }
    return n;
  }

  function copy(text, btn) {
    var done = function (msg) { btn.textContent = msg; setTimeout(function () { btn.textContent = 'Copy'; }, 1500); };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { done('Copied'); }, function () { done('Select and copy'); });
    } else { done('Select and copy'); }
  }

  function shellQuote(value) { return "'" + String(value).replace(/'/g, "'\\''") + "'"; }

  function card(run) {
    var jobs = Array.isArray(run.jobs) ? run.jobs : [];
    var done = jobs.filter(function (j) { return j.status === 'complete'; }).length;
    var failed = jobs.filter(function (j) { return j.status === 'failed' || j.status === 'timeout'; }).length;
    var box = el('div', 'board-run');
    var head = el('div', 'row');
    head.appendChild(el('span', 'mono', String(run.runId)));
    head.appendChild(el('span', 'pill ' + (failed ? 'bad' : run.status === 'running' ? 'info' : 'good'), String(run.status)));
    head.appendChild(el('span', 'num mono', done + '/' + jobs.length + ' jobs' + (failed ? ', ' + failed + ' failed' : '')));
    box.appendChild(head);
    var bar = el('div', 'board-bar');
    var fill = el('i');
    fill.style.width = (jobs.length ? Math.round(100 * done / jobs.length) : 0) + '%';
    bar.appendChild(fill);
    box.appendChild(bar);
    box.appendChild(el('div', 'mono', String(run.root)));
    var command = 'swarm --root ' + shellQuote(run.root) + ' watch ' + shellQuote(run.runId);
    var line = el('div', 'row');
    line.appendChild(el('span', 'mono', command));
    var btn = el('button', 'copy', 'Copy');
    btn.type = 'button';
    btn.addEventListener('click', function () { copy(command, btn); });
    line.appendChild(btn);
    box.appendChild(line);
    return box;
  }

  function render(data) {
    var runs = data && Array.isArray(data.runs) ? data.runs : [];
    count.textContent = runs.length + (runs.length === 1 ? ' run' : ' runs');
    updated.textContent = new Date().toLocaleTimeString();
    list.textContent = '';
    if (!runs.length) { list.appendChild(el('div', 'board-empty', 'No live runs on this machine.')); return; }
    runs.forEach(function (run) { list.appendChild(card(run)); });
  }

  function poll() {
    fetch('/board?t=' + encodeURIComponent(TOKEN), { headers: { 'x-watch-token': TOKEN } })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (data) { if (data) { render(data); } })
      .catch(function () {});
  }
  poll();
  setInterval(poll, 2000);
})();
