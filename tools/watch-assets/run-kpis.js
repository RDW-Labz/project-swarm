// SPDX-License-Identifier: Apache-2.0
(function () {
  'use strict';

  var HIST_CAP = 120;
  var SPARK_N = 40;
  var SVG_NS = 'http://www.w3.org/2000/svg';
  var flightHist = [];
  var rateHist = [];
  var histRunId = null;
  var lastElapsed = null;
  var lastFinished = 0;

  function $(id) { return document.getElementById(id); }

  function num(v) { return v == null ? '–' : Number(v).toLocaleString('en-US'); }

  function fmtT(ms) {
    var s = Math.max(0, Math.round((ms || 0) / 1000));
    var m = Math.floor(s / 60), r = s % 60;
    return (m < 10 ? '0' : '') + m + ':' + (r < 10 ? '0' : '') + r;
  }

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = String(text);
    return n;
  }

  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }

  function setText(id, text) { var n = $(id); if (n) n.textContent = text; }

  function setKpi(id, main, suffix) {
    var n = $(id);
    if (!n) return;
    clear(n);
    n.appendChild(document.createTextNode(main));
    if (suffix != null) n.appendChild(el('small', null, suffix));
  }

  function setStatus(run) {
    var st = $('status');
    if (!st) return;
    var known = { live: 'LIVE', paused: 'PAUSED', complete: 'COMPLETE', failed: 'FAILED' };
    var s = known[run.status] ? run.status : 'failed';
    st.className = 'chip ' + s;
    clear(st);
    st.appendChild(el('span', s === 'live' ? 'dot pulse' : 'dot'));
    st.appendChild(document.createTextNode(known[s]));
  }

  function labelSvg(x, y, anchor, fill, text) {
    var t = document.createElementNS(SVG_NS, 'text');
    t.setAttribute('x', String(x));
    t.setAttribute('y', String(y));
    t.setAttribute('font-size', '10');
    t.setAttribute('fill', fill);
    t.setAttribute('text-anchor', anchor);
    t.textContent = text;
    return t;
  }

  function linePath(vals, max, w, x0, yTop, yBottom) {
    var n = vals.length, d = '';
    for (var i = 0; i < n; i++) {
      var x = x0 + (n < 2 ? 0 : i / (n - 1) * w);
      var y = yBottom - vals[i] / max * (yBottom - yTop);
      d += (i ? ' L' : 'M') + x.toFixed(1) + ' ' + y.toFixed(1);
    }
    return d;
  }

  function drawSeries(svg, vals, color, dec) {
    if (!svg) return;
    clear(svg);
    var max = Math.max(1, Math.max.apply(null, vals.concat([0])));
    var last = vals.length ? vals[vals.length - 1] : 0;
    var path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', linePath(vals, max, 300, 0, 10, 102));
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke', color);
    path.setAttribute('stroke-width', '2');
    path.setAttribute('vector-effect', 'non-scaling-stroke');
    if (vals.length > 1) svg.appendChild(path);
    svg.appendChild(labelSvg(4, 12, 'start', '#a3a3ae', 'max ' + max.toFixed(dec)));
    svg.appendChild(labelSvg(296, 116, 'end', color, 'now ' + last.toFixed(dec)));
  }

  function passSub(k) {
    var n = $('kPassSub');
    if (!n) return;
    clear(n);
    n.appendChild(el('span', 'pill ' + (k.retries ? 'warn' : 'good'), 'retries ' + num(k.retries || 0)));
    n.appendChild(el('span', 'pill ' + (k.failed ? 'bad' : 'good'), 'failed ' + num(k.failed || 0)));
  }

  function renderKpis(run, k) {
    var total = k.total || 0, done = k.done || 0;
    var pct = total ? done / total : 0;
    setKpi('kDone', num(done), '/ ' + num(total));
    setText('kPct', Math.round(pct * 100) + '% done');
    var arc = $('ringArc');
    if (arc) arc.setAttribute('stroke-dasharray', (pct * 138.2).toFixed(1) + ' 200');
    setText('kFlight', num(k.running || 0));
    setText('kPeak', 'peak ' + num(k.peakInFlight || 0));
    var sp = flightHist.slice(-SPARK_N);
    var mx = Math.max(1, Math.max.apply(null, sp.concat([0])));
    var sparkPath = $('sparkPath');
    if (sparkPath) sparkPath.setAttribute('d', linePath(sp, mx, 78, 1, 2, 20));
    setText('kPass', k.firstTryPassRate == null ? '–' : (k.firstTryPassRate * 100).toFixed(1) + '%');
    passSub(k);
    var spendKpi = $('kSpend');
    if (spendKpi) {
      var spendCard = spendKpi.closest('.kpi');
      if (spendCard) spendCard.hidden = true;
    }
    setText('kForecast', (k.jobsPerSec || 0).toFixed(1) + ' jobs/s');
    setText('kEta', run.status === 'complete' ? 'done' : (k.etaMs == null ? '–' : fmtT(k.etaMs)));
    setText('kRate', (k.jobsPerSec || 0).toFixed(1) + ' jobs/s');
    var mq = run.mergeQueue;
    setText('kMerged', num(mq ? (mq.integrated || 0) : 0));
    setText('kMergeSub', 'queue ' + num(mq ? (mq.batches || 0) : 0) + ' · conflicts ' + num(mq ? (mq.conflicts || 0) : 0));
  }

  function recordSample(run, k) {
    if (histRunId !== run.runId) {
      histRunId = run.runId;
      flightHist = [];
      rateHist = [];
      lastElapsed = null;
      lastFinished = 0;
    }
    var elapsed = run.elapsedMs || 0;
    var finished = (k.done || 0) + (k.failed || 0) + (k.cancelled || 0);
    if (lastElapsed === null || elapsed > lastElapsed) {
      var rate = 0;
      if (lastElapsed !== null) {
        var dt = (elapsed - lastElapsed) / 1000;
        rate = dt > 0 ? (finished - lastFinished) / dt : 0;
      }
      flightHist.push(k.running || 0);
      rateHist.push(rate);
      if (flightHist.length > HIST_CAP) flightHist.shift();
      if (rateHist.length > HIST_CAP) rateHist.shift();
      lastElapsed = elapsed;
      lastFinished = finished;
    }
  }

  function copyCommand(text, input) {
    var nav = window.navigator;
    if (nav && nav.clipboard && typeof nav.clipboard.writeText === 'function') {
      nav.clipboard.writeText(text).catch(function () { input.focus(); input.select(); });
      return;
    }
    input.focus();
    input.select();
  }

  function renderBanner(run) {
    var banner = $('doneBanner');
    if (!banner) return;
    var r = run.rollup;
    if (!r) {
      banner.hidden = true;
      return;
    }
    banner.hidden = false;
    clear(banner);
    var c = r.counts || {};
    banner.appendChild(el('h2', null, run.status === 'complete' ? 'Run complete' : 'Run finished with failures'));
    banner.appendChild(el('div', 'label', 'done ' + num(c.done || 0) + ' · failed ' + num(c.failed || 0) + ' · cancelled ' + num(c.cancelled || 0) + ' · total ' + num(c.total || 0)));
    banner.appendChild(el('div', 'label', 'time ' + fmtT(r.elapsedMs) + ' · branch ' + (r.branch || run.branch || '–')));
    var cmd = 'swarm inspect ' + run.runId;
    var row = el('div', 'legend');
    var input = el('input', 'mono');
    input.type = 'text';
    input.readOnly = true;
    input.value = cmd;
    input.setAttribute('aria-label', 'Review command');
    var btn = el('button', 'btn', 'Copy');
    btn.type = 'button';
    btn.onclick = function () { copyCommand(cmd, input); };
    row.appendChild(input);
    row.appendChild(btn);
    banner.appendChild(row);
  }

  function render(data) {
    var run = data && data.run;
    if (!run) return;
    var k = run.kpi || {};
    setStatus(run);
    setText('goal', run.goal || run.runId || '');
    setText('clock', fmtT(run.elapsedMs) + ' elapsed');
    setText('branch', run.branch || '–');
    recordSample(run, k);
    renderKpis(run, k);
    drawSeries($('chFlight'), flightHist, '#60a5fa', 0);
    drawSeries($('chRate'), rateHist, '#34d399', 1);
    renderBanner(run);
  }

  var sw = window.SwarmWatch;
  if (sw && typeof sw.register === 'function') sw.register('run', render);
})();
