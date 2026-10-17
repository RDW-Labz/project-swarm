// SPDX-License-Identifier: Apache-2.0
(function () {
  'use strict';

  var SW = window.SwarmWatch;
  if (!SW) { return; }

  function txt(v) {
    return v === null || v === undefined || v === '' ? '-' : String(v);
  }

  function money(v) {
    if (typeof v !== 'number' || !isFinite(v)) { return '-'; }
    return '$' + (v > 0 && v < 0.01 ? v.toFixed(4) : v.toFixed(2));
  }

  function secs(ms) {
    if (typeof ms !== 'number' || !isFinite(ms)) { return '-'; }
    return (ms / 1000).toFixed(1) + 's';
  }

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) { n.className = cls; }
    if (text !== undefined) { n.textContent = text; }
    return n;
  }

  function statusPill(status) {
    var cls = 'pill info';
    if (status === 'complete' || status === 'done') { cls = 'pill good'; }
    else if (status === 'failed' || status === 'timeout') { cls = 'pill bad'; }
    else if (status === 'queued') { cls = 'pill lav'; }
    else if (status === 'cancelled') { cls = 'pill warn'; }
    return el('span', cls, txt(status));
  }

  function row(label, value, isMono) {
    var r = el('div', 'job-row');
    r.style.display = 'grid';
    r.style.gridTemplateColumns = '110px minmax(0,1fr)';
    r.style.gap = '8px';
    r.style.alignItems = 'center';
    r.style.padding = '5px 0';
    r.appendChild(el('span', 'label', label));
    var v;
    if (value && value.nodeType === 1) {
      v = value;
    } else {
      v = el('span', isMono ? 'num mono' : '', txt(value));
    }
    v.style.minWidth = '0';
    v.style.overflowWrap = 'anywhere';
    r.appendChild(v);
    return r;
  }

  function flash(btn, msg) {
    var old = btn.getAttribute('data-label') || 'Copy';
    btn.textContent = msg;
    setTimeout(function () { btn.textContent = old; }, 1500);
  }

  function fallbackCopy(text, btn) {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, text.length);
    var ok = false;
    try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
    document.body.removeChild(ta);
    flash(btn, ok ? 'Copied' : 'Select and copy');
  }

  function copyText(text, btn) {
    var clip = navigator.clipboard;
    if (clip && typeof clip.writeText === 'function') {
      clip.writeText(text).then(
        function () { flash(btn, 'Copied'); },
        function () { fallbackCopy(text, btn); }
      );
      return;
    }
    fallbackCopy(text, btn);
  }

  function commandBox(command) {
    var box = el('div', 'mono-box');
    box.style.display = 'flex';
    box.style.alignItems = 'center';
    box.style.justifyContent = 'space-between';
    box.style.gap = '10px';
    box.style.padding = '8px 10px';
    box.style.margin = '6px 0';
    box.style.borderRadius = '10px';
    var code = el('span', 'mono', command);
    code.style.overflowWrap = 'anywhere';
    box.appendChild(code);
    var btn = el('button', 'copy', 'Copy');
    btn.setAttribute('type', 'button');
    btn.setAttribute('data-label', 'Copy');
    btn.addEventListener('click', function () { copyText(command, btn); });
    box.appendChild(btn);
    return box;
  }

  function buildNode(job) {
    var data = SW.data || {};
    var run = data.run || null;
    var runId = run && run.runId ? String(run.runId) : '<run>';

    var node = el('div', 'job-drawer');

    var head = el('div', 'job-head');
    head.style.display = 'flex';
    head.style.alignItems = 'center';
    head.style.gap = '8px';
    head.style.marginBottom = '10px';
    head.appendChild(el('span', 'mono', txt(job.id)));
    head.appendChild(statusPill(job.status));
    node.appendChild(head);

    node.appendChild(row('ID', job.id, true));
    node.appendChild(row('Status', statusPill(job.status)));
    node.appendChild(row('Lane', job.lane || job.agent, true));
    node.appendChild(row('Model', job.model, true));
    node.appendChild(row('Attempts', job.attempts, true));
    node.appendChild(row('Lead', job.lead, true));
    node.appendChild(row('Wave', job.wave, true));
    node.appendChild(row('Type', job.type, true));
    node.appendChild(row('File', job.file, true));
    node.appendChild(row('Cost', money(job.costUsd), true));
    node.appendChild(row('Time', secs(job.durationMs), true));

    var section = el('div', 'job-commands');
    section.style.marginTop = '14px';
    section.appendChild(el('div', 'label', 'Commands (copy and run in your terminal)'));
    section.appendChild(commandBox('swarm inspect ' + runId));
    section.appendChild(commandBox('swarm inspect ' + runId + ' --results'));
    node.appendChild(section);

    return node;
  }

  function openJob(job) {
    if (!job) { return; }
    var node = buildNode(job);
    SW.openDrawer('Job ' + job.id, node);
  }

  SW.openJob = openJob;
})();
