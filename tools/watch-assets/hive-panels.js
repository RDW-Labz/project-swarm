// SPDX-License-Identifier: Apache-2.0
// Hive command-center panels: session log, lanes/workers, savings/throughput (DOM renderers + pure helpers).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) { module.exports = factory(); }
  else if (root) { root.HivePanels = factory(); }
}(typeof self !== 'undefined' ? self : typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var LANE_ORDER = ['cursor', 'codex', 'claude', 'hermes', 'openrouter', 'anthropic', 'rented', 'local', 'qwen', 'openai', 'gemini', 'ollama', 'lambda'];

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) { n.className = cls; }
    if (text !== undefined && text !== null) { n.textContent = text; }
    return n;
  }

  function tagClassForKind(kind) {
    if (kind === 'blocker') { return 'safety'; }
    if (kind === 'human') { return 'human'; }
    if (kind === 'decision') { return 'route'; }
    if (kind === 'run' || kind === 'action' || kind === 'command') { return 'code'; }
    return 'sys';
  }

  function pickText(event) {
    if (!event || typeof event !== 'object') { return ''; }
    var fields = ['text', 'title', 'summary', 'message', 'command', 'action', 'phase', 'status', 'id'];
    for (var i = 0; i < fields.length; i += 1) {
      var key = fields[i];
      if (typeof event[key] === 'string' && event[key].trim()) { return event[key].trim(); }
    }
    return '';
  }

  function journalEntrySentence(event) {
    if (!event || typeof event !== 'object') { return 'Unknown event'; }
    var kind = typeof event.kind === 'string' ? event.kind : 'note';
    var detail = pickText(event);
    switch (kind) {
      case 'run':
        return detail ? ('Run update: ' + detail) : 'Run activity recorded';
      case 'integration':
        return detail ? ('Integration: ' + detail) : 'Integration step recorded';
      case 'pr':
        return detail ? ('Pull request: ' + detail) : 'Pull request event recorded';
      case 'blocker':
        return detail ? ('Blocker: ' + detail) : 'Blocker raised';
      case 'human':
        return detail ? ('Needs you: ' + detail) : 'Human gate opened';
      case 'decision':
        return detail ? ('Decision: ' + detail) : 'Decision pending';
      case 'command':
        return detail ? ('Command: ' + detail) : 'Command issued';
      case 'action':
        return detail ? ('Action: ' + detail) : 'Action taken';
      case 'goal':
        return detail ? ('Goal: ' + detail) : 'Goal updated';
      case 'plan':
        return detail ? ('Plan: ' + detail) : 'Plan updated';
      case 'checkpoint':
        return detail ? ('Checkpoint: ' + detail) : 'Checkpoint saved';
      case 'note':
        return detail ? detail : 'Note added';
      default:
        return detail ? (kind + ': ' + detail) : (kind + ' event');
    }
  }

  function parseEventTime(ts) {
    if (typeof ts !== 'string' || !ts.length) { return NaN; }
    return Date.parse(ts);
  }

  function formatEventAge(ts, nowMs) {
    var at = parseEventTime(ts);
    if (!Number.isFinite(at) || !Number.isFinite(nowMs)) { return '—'; }
    var sec = Math.max(0, Math.floor((nowMs - at) / 1000));
    if (sec < 60) { return sec + 's'; }
    var min = Math.floor(sec / 60);
    if (min < 60) { return min + 'm'; }
    var hr = Math.floor(min / 60);
    if (hr < 48) { return hr + 'h'; }
    var day = Math.floor(hr / 24);
    return day + 'd';
  }

  function laneRowsFromCounts(laneCounts) {
    var rows = [];
    if (!laneCounts || typeof laneCounts !== 'object') { return rows; }
    var seen = {};
    for (var i = 0; i < LANE_ORDER.length; i += 1) {
      var agent = LANE_ORDER[i];
      if (Object.prototype.hasOwnProperty.call(laneCounts, agent)) {
        var count = laneCounts[agent];
        if (typeof count === 'number' && Number.isFinite(count) && count > 0) {
          rows.push({ name: agent, count: Math.floor(count) });
          seen[agent] = true;
        }
      }
    }
    for (var key in laneCounts) {
      if (!Object.prototype.hasOwnProperty.call(laneCounts, key) || seen[key]) { continue; }
      var n = laneCounts[key];
      if (typeof n === 'number' && Number.isFinite(n) && n > 0) {
        rows.push({ name: String(key), count: Math.floor(n) });
      }
    }
    rows.sort(function (a, b) { return b.count - a.count; });
    var total = 0;
    for (var j = 0; j < rows.length; j += 1) { total += rows[j].count; }
    if (total <= 0) { return []; }
    for (var k = 0; k < rows.length; k += 1) {
      rows[k].fillPct = (rows[k].count / total) * 100;
    }
    return rows;
  }

  function savingsRowFillPct(row, scaleMax) {
    if (!row || typeof row !== 'object') { return 0; }
    if (typeof row.fillPct === 'number' && Number.isFinite(row.fillPct)) {
      return Math.max(0, Math.min(100, row.fillPct));
    }
    var value = row.value;
    if (typeof value !== 'number' || !Number.isFinite(value)) { return 0; }
    if (row.unit === 'pct') { return Math.max(0, Math.min(100, value)); }
    var max = typeof row.max === 'number' && Number.isFinite(row.max) && row.max > 0
      ? row.max
      : (typeof scaleMax === 'number' && scaleMax > 0 ? scaleMax : null);
    if (!max) { return 0; }
    return Math.max(0, Math.min(100, (value / max) * 100));
  }

  function formatSavingsValue(row) {
    if (!row || typeof row !== 'object') { return '0'; }
    var value = row.value;
    if (typeof value !== 'number' || !Number.isFinite(value)) { return '0'; }
    if (row.unit === 'pct') { return Math.round(value) + '%'; }
    return String(Math.round(value));
  }

  /**
   * Map numeric samples to chart coordinates. Min sample maps to the bottom (height - padY),
   * max sample maps to the top (padY). Returns [] for empty input.
   */
  function sparklinePoints(samples, options) {
    var opts = options || {};
    var width = typeof opts.width === 'number' && opts.width > 0 ? opts.width : 360;
    var height = typeof opts.height === 'number' && opts.height > 0 ? opts.height : 40;
    var padX = typeof opts.padX === 'number' && opts.padX >= 0 ? opts.padX : 0;
    var padY = typeof opts.padY === 'number' && opts.padY >= 0 ? opts.padY : 2;
    var list = Array.isArray(samples) ? samples.filter(function (v) { return typeof v === 'number' && Number.isFinite(v); }) : [];
    if (!list.length) { return []; }
    var min = list[0];
    var max = list[0];
    for (var i = 1; i < list.length; i += 1) {
      if (list[i] < min) { min = list[i]; }
      if (list[i] > max) { max = list[i]; }
    }
    var innerW = Math.max(1, width - padX * 2);
    var innerH = Math.max(1, height - padY * 2);
    var span = max - min;
    var step = list.length > 1 ? innerW / (list.length - 1) : 0;
    var out = [];
    for (var n = 0; n < list.length; n += 1) {
      var x = padX + step * n;
      var norm = span === 0 ? 0.5 : (list[n] - min) / span;
      var y = padY + (1 - norm) * innerH;
      out.push({ x: x, y: y, value: list[n] });
    }
    return out;
  }

  function clearChildren(node) {
    while (node.firstChild) { node.removeChild(node.firstChild); }
  }

  function renderEventLog(host, events, options) {
    if (!host) { return; }
    var opts = options || {};
    var nowMs = typeof opts.nowMs === 'number' ? opts.nowMs : Date.now();
    var list = Array.isArray(events) ? events.slice() : [];
    list.sort(function (a, b) {
      return parseEventTime(b && b.ts) - parseEventTime(a && a.ts);
    });
    var limit = typeof opts.limit === 'number' && opts.limit > 0 ? Math.floor(opts.limit) : 40;
    if (list.length > limit) { list = list.slice(0, limit); }

    clearChildren(host);
    host.classList.add('event-log', 'hive-event-log');

    for (var i = 0; i < list.length; i += 1) {
      var event = list[i];
      var li = el('li');
      var kind = event && event.kind ? event.kind : 'note';
      var tag = el('span', 'event-tag ' + tagClassForKind(kind), kind);
      li.appendChild(tag);
      li.appendChild(el('span', null, journalEntrySentence(event)));
      var age = el('span', 'event-time num', formatEventAge(event && event.ts, nowMs));
      if (event && event.ts) { age.title = event.ts; }
      li.appendChild(age);
      host.appendChild(li);
    }
  }

  function renderLanesPanel(host, laneCounts, options) {
    if (!host) { return; }
    var opts = options || {};
    var barsRoot = host.querySelector ? host.querySelector('.lane-bars') : null;
    if (!barsRoot) {
      barsRoot = el('div', 'lane-bars');
      barsRoot.setAttribute('aria-label', 'Lane worker activity');
      host.appendChild(barsRoot);
    } else {
      clearChildren(barsRoot);
    }

    var rows = laneRowsFromCounts(laneCounts);
    for (var i = 0; i < rows.length; i += 1) {
      var row = rows[i];
      var rowEl = el('div', 'lane-row');
      rowEl.appendChild(el('span', 'name', row.name));
      var track = el('span', 'lane-track');
      var fill = document.createElement('i');
      fill.className = 'lane-fill ' + row.name;
      fill.style.width = row.fillPct.toFixed(2) + '%';
      track.appendChild(fill);
      rowEl.appendChild(track);
      var num = el('span', 'num', String(row.count));
      num.title = 'lane.' + row.name;
      rowEl.appendChild(num);
      barsRoot.appendChild(rowEl);
    }

    if (opts.hero && typeof opts.hero === 'object') {
      var hero = host.querySelector ? host.querySelector('.gates-hero') : null;
      if (!hero) {
        hero = el('p', 'gates-hero hive-gates-hero');
        host.insertBefore(hero, barsRoot);
      }
      var parts = [];
      if (typeof opts.hero.repos === 'number') {
        parts.push(el('span', 'num', String(opts.hero.repos)));
        hero.appendChild(parts[0]);
        hero.appendChild(document.createTextNode(' repos. '));
      }
      if (typeof opts.hero.rings === 'number') {
        var ringSpan = el('span', 'num', String(opts.hero.rings));
        hero.appendChild(ringSpan);
        hero.appendChild(document.createTextNode(' ring.'));
      }
    }
  }

  function renderSavingsPanel(host, savingsRows, options) {
    if (!host) { return; }
    var opts = options || {};
    var rowsRoot = host.querySelector ? host.querySelector('.savings-rows') : null;
    if (!rowsRoot) {
      rowsRoot = el('div', 'savings-rows hive-savings-rows');
      host.appendChild(rowsRoot);
    } else {
      clearChildren(rowsRoot);
    }

    var rows = Array.isArray(savingsRows) ? savingsRows : [];
    var scaleMax = typeof opts.savingsMax === 'number' ? opts.savingsMax : null;
    for (var i = 0; i < rows.length; i += 1) {
      var row = rows[i];
      var rowEl = el('div', 'saving-row');
      rowEl.appendChild(el('span', 'lbl', row.label || ''));
      var num = el('span', 'num', formatSavingsValue(row));
      if (row.title) { num.title = row.title; }
      rowEl.appendChild(num);
      var track = el('span', 'track');
      var fill = document.createElement('i');
      fill.className = 'fill';
      var pct = savingsRowFillPct(row, scaleMax);
      fill.style.width = pct.toFixed(2) + '%';
      if (row.fillGradient) { fill.style.background = row.fillGradient; }
      track.appendChild(fill);
      rowEl.appendChild(track);
      rowsRoot.appendChild(rowEl);
    }

    var canvas = host.querySelector ? host.querySelector('canvas.mini-chart') : null;
    if (!canvas) {
      canvas = document.createElement('canvas');
      canvas.className = 'mini-chart';
      canvas.width = typeof opts.chartWidth === 'number' ? opts.chartWidth : 360;
      canvas.height = typeof opts.chartHeight === 'number' ? opts.chartHeight : 40;
      canvas.setAttribute('aria-label', opts.chartLabel || 'Throughput chart');
      host.appendChild(canvas);
    }
    drawSparkline(canvas, opts.throughputSamples || [], {
      width: canvas.width,
      height: canvas.height,
      strokeStyle: opts.strokeStyle || '#3dd6a5',
    });
  }

  function drawSparkline(canvas, samples, options) {
    if (!canvas || !canvas.getContext) { return; }
    var ctx = canvas.getContext('2d');
    if (!ctx) { return; }
    var opts = options || {};
    var width = typeof opts.width === 'number' ? opts.width : canvas.width;
    var height = typeof opts.height === 'number' ? opts.height : canvas.height;
    var points = sparklinePoints(samples, { width: width, height: height, padX: opts.padX, padY: opts.padY });
    ctx.clearRect(0, 0, width, height);
    if (points.length < 2) {
      if (points.length === 1) {
        ctx.fillStyle = opts.strokeStyle || '#3dd6a5';
        ctx.beginPath();
        ctx.arc(points[0].x, points[0].y, 1.5, 0, Math.PI * 2);
        ctx.fill();
      }
      return;
    }
    ctx.strokeStyle = opts.strokeStyle || '#3dd6a5';
    ctx.lineWidth = typeof opts.lineWidth === 'number' ? opts.lineWidth : 1.5;
    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    for (var i = 1; i < points.length; i += 1) {
      ctx.lineTo(points[i].x, points[i].y);
    }
    ctx.stroke();
  }

  function renderHivePanels(containers, data, options) {
    var opts = options || {};
    var model = data || {};
    if (containers && containers.eventLog) {
      renderEventLog(containers.eventLog, model.journalEvents || [], opts);
    }
    if (containers && containers.lanes) {
      renderLanesPanel(containers.lanes, model.laneCounts || {}, opts);
    }
    if (containers && containers.savings) {
      renderSavingsPanel(containers.savings, model.savingsRows || [], {
        savingsMax: model.savingsMax,
        throughputSamples: model.throughputSamples,
        chartLabel: model.throughputChartLabel,
        chartWidth: opts.chartWidth,
        chartHeight: opts.chartHeight,
        strokeStyle: opts.strokeStyle,
      });
    }
  }

  return {
    tagClassForKind: tagClassForKind,
    journalEntrySentence: journalEntrySentence,
    formatEventAge: formatEventAge,
    laneRowsFromCounts: laneRowsFromCounts,
    savingsRowFillPct: savingsRowFillPct,
    sparklinePoints: sparklinePoints,
    drawSparkline: drawSparkline,
    renderEventLog: renderEventLog,
    renderLanesPanel: renderLanesPanel,
    renderSavingsPanel: renderSavingsPanel,
    renderHivePanels: renderHivePanels,
  };
}));
