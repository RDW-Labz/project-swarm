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
    if (row.unit === 'usd') { return String(Math.round(value * 100) / 100); }
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

  function readTrustedDisplay(field) {
    if (!field || typeof field !== 'object') { return '—'; }
    if (typeof field.source !== 'string' || !field.source.length) { return '—'; }
    if (field.value === null || field.value === undefined || field.value === '') { return '—'; }
    return String(field.value);
  }

  function trustedTitle(field) {
    if (field && typeof field.source === 'string' && field.source.length) { return field.source; }
    return '';
  }

  var CARD_ROW_KEYS = ['asks', 'out', 'fails'];

  /**
   * Rebuild card body metrics from live snapshot project fields (dt/dd grid + meter).
   * @param {HTMLElement} cardEl
   * @param {object} project
   */
  function renderProjectCardMetrics(cardEl, project) {
    if (!cardEl || !project) { return; }
    var bd = cardEl.querySelector ? cardEl.querySelector('.hive-node-bd') : null;
    if (!bd) { return; }
    clearChildren(bd);

    var dl = el('dl', 'hive-kv');
    for (var ki = 0; ki < CARD_ROW_KEYS.length; ki += 1) {
      var key = CARD_ROW_KEYS[ki];
      var field = project[key];
      dl.appendChild(el('dt', null, key));
      var dd = el('dd', 'num', readTrustedDisplay(field));
      var title = trustedTitle(field);
      if (title) { dd.setAttribute('title', title); }
      dl.appendChild(dd);
    }
    bd.appendChild(dl);

    var meterField = project.meter;
    var meterPct = null;
    if (meterField && typeof meterField === 'object' && Number.isFinite(meterField.value)) {
      meterPct = Math.max(0, Math.min(100, meterField.value));
    } else if (project.percentDone && typeof project.percentDone.value === 'string') {
      var parsed = parseInt(project.percentDone.value, 10);
      if (Number.isFinite(parsed)) { meterPct = Math.max(0, Math.min(100, parsed)); }
    }
    if (meterPct != null) {
      var meter = el('div', 'hive-meter');
      var meterLabel = (meterField && typeof meterField.label === 'string' && meterField.label.length)
        ? meterField.label
        : 'done';
      meter.appendChild(el('span', null, meterLabel));
      var track = el('span', 'track');
      var fill = document.createElement('i');
      fill.className = 'fill';
      fill.style.width = meterPct.toFixed(0) + '%';
      track.appendChild(fill);
      meter.appendChild(track);
      var val = el('span', 'num', meterPct + '%');
      var meterTitle = trustedTitle(meterField) || trustedTitle(project.percentDone);
      if (meterTitle) { val.setAttribute('title', meterTitle); }
      meter.appendChild(val);
      bd.appendChild(meter);
    }
  }

  function statLineFromLabelled(field, label) {
    if (!field || typeof field.value !== 'number' || !Number.isFinite(field.value)) { return null; }
    if (typeof field.source !== 'string' || !field.source.length) { return null; }
    return {
      label: label,
      value: String(Math.round(field.value)),
      title: field.source,
    };
  }

  /**
   * Build panel model from a Command Center snapshot when panels blob is absent.
   */
  function deriveHivePanelModel(snapshot) {
    if (!snapshot || typeof snapshot !== 'object') {
      return { journalEvents: [], laneCounts: {}, savingsRows: [], statLines: [] };
    }
    if (snapshot.panels && typeof snapshot.panels === 'object') {
      return snapshot.panels;
    }
    var stats = snapshot.stats && typeof snapshot.stats === 'object' ? snapshot.stats : {};
    var projects = Array.isArray(snapshot.projects) ? snapshot.projects : [];
    var laneCounts = {};
    for (var pi = 0; pi < projects.length; pi += 1) {
      var proj = projects[pi];
      var lane = typeof proj.lane === 'string' ? proj.lane : 'control';
      var live = proj.liveAgents;
      if (live && typeof live.value === 'number' && Number.isFinite(live.value) && live.value > 0) {
        laneCounts[lane] = (laneCounts[lane] || 0) + Math.floor(live.value);
      }
    }
    var statLines = [];
    var needsLine = statLineFromLabelled(stats.needsYouCount, 'needs you');
    if (needsLine) { statLines.push(needsLine); }
    var agentsLine = statLineFromLabelled(stats.agentsLive, 'agents live');
    if (agentsLine) { statLines.push(agentsLine); }
    var lanesHero = {};
    if (stats.projectsTotal && typeof stats.projectsTotal.value === 'number') {
      lanesHero.repos = Math.floor(stats.projectsTotal.value);
    } else {
      lanesHero.repos = projects.length;
    }
    lanesHero.rings = 1;

    var journalEvents = [];
    if (Array.isArray(snapshot.journalEvents)) { journalEvents = snapshot.journalEvents; }
    else if (Array.isArray(snapshot.events)) { journalEvents = snapshot.events; }

    var savingsRows = [];
    if (stats.spendUsd && typeof stats.spendUsd.value === 'number' && stats.spendUsd.value >= 0) {
      savingsRows.push({
        label: 'board spend',
        value: stats.spendUsd.value,
        unit: 'usd',
        title: stats.spendUsd.source,
        max: Math.max(stats.spendUsd.value, 1),
      });
    }

    return {
      journalEvents: journalEvents,
      laneCounts: laneCounts,
      statLines: statLines,
      savingsRows: savingsRows,
      lanesHero: lanesHero,
      latencySamples: Array.isArray(snapshot.latencySamples) ? snapshot.latencySamples : [],
      throughputSamples: Array.isArray(snapshot.throughputSamples) ? snapshot.throughputSamples : [],
    };
  }

  function appendEmpty(host, message) {
    var p = el('p', 'cc-empty', message);
    host.appendChild(p);
  }

  function drawBarChart(canvas, samples, colors) {
    if (!canvas || !canvas.getContext) { return; }
    var ctx = canvas.getContext('2d');
    if (!ctx || typeof ctx.fillRect !== 'function') { return; }
    var w = canvas.width;
    var h = canvas.height;
    ctx.clearRect(0, 0, w, h);
    var list = Array.isArray(samples) ? samples : [];
    if (!list.length) {
      return;
    }
    var max = list[0];
    for (var j = 1; j < list.length; j += 1) {
      if (list[j] > max) { max = list[j]; }
    }
    if (max <= 0) { max = 1; }
    var barW = list.length > 0 ? (w - 8) / list.length - 2 : 8;
    for (var n = 0; n < list.length; n += 1) {
      var bh2 = Math.max(3, (list[n] / max) * (h - 8));
      var x2 = 4 + n * ((w - 8) / list.length);
      ctx.fillStyle = (colors && colors[n % colors.length]) || '#3dd6a5';
      ctx.fillRect(x2, h - bh2 - 3, barW, bh2);
    }
  }

  function renderSessionTermBlock(host, model, options) {
    if (!host) { return; }
    clearChildren(host);
    var opts = options || {};
    var modelObj = model || {};
    var prompt = el('p', 'term-prompt', '~/swarm $ watch --board');
    host.appendChild(prompt);
    var canvas = document.createElement('canvas');
    canvas.className = 'mini-chart';
    canvas.id = 'chart-fps';
    canvas.width = typeof opts.chartWidth === 'number' ? opts.chartWidth : 360;
    canvas.height = typeof opts.chartHeight === 'number' ? opts.chartHeight : 40;
    canvas.setAttribute('aria-label', modelObj.throughputChartLabel || 'Throughput chart');
    var throughputSamples = Array.isArray(modelObj.throughputSamples) ? modelObj.throughputSamples : [];
    if (throughputSamples.length) {
      host.appendChild(canvas);
      drawBarChart(canvas, throughputSamples, ['#5eb8ff', '#3dd6a5', '#ff4d8d', '#f5c451']);
    } else {
      appendEmpty(host, 'No lane activity yet');
    }
    var caption = el('p', 'term-prompt term-prompt--chart-caption');
    caption.appendChild(el('span', 'lbl', 'throughput samples'));
    if (typeof modelObj.throughputPeak === 'number' && Number.isFinite(modelObj.throughputPeak)) {
      caption.appendChild(document.createTextNode(': '));
      var peak = el('span', 'num', String(Math.round(modelObj.throughputPeak)));
      if (modelObj.throughputPeakTitle) { peak.title = modelObj.throughputPeakTitle; }
      caption.appendChild(peak);
    }
    host.appendChild(caption);
  }

  function renderStatLines(host, lines) {
    if (!host || !Array.isArray(lines) || !lines.length) { return; }
    var root = host.querySelector ? host.querySelector('.hive-stat-lines') : null;
    if (!root) {
      root = el('div', 'stat-lines hive-stat-lines');
      host.appendChild(root);
    } else {
      clearChildren(root);
    }
    for (var i = 0; i < lines.length; i += 1) {
      var row = lines[i];
      var rowEl = el('div', 'row');
      rowEl.appendChild(el('span', null, row.label || ''));
      var num = el('span', 'num', row.value != null ? String(row.value) : '');
      if (row.tone) { num.className += ' ' + row.tone; }
      if (row.title) { num.title = row.title; }
      rowEl.appendChild(num);
      root.appendChild(rowEl);
    }
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

    if (!list.length) {
      appendEmpty(host, 'No recent board events yet');
      return;
    }

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
    if (!rows.length) {
      appendEmpty(barsRoot, 'No lane activity yet');
    }
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
        if (typeof host.insertBefore === 'function' && barsRoot.parentNode === host) {
          host.insertBefore(hero, barsRoot);
        } else {
          host.appendChild(hero);
        }
      } else {
        clearChildren(hero);
      }
      if (typeof opts.hero.repos === 'number') {
        hero.appendChild(el('span', 'num', String(opts.hero.repos)));
        hero.appendChild(document.createTextNode(' repos. '));
      }
      if (typeof opts.hero.rings === 'number') {
        hero.appendChild(el('span', 'num', String(opts.hero.rings)));
        hero.appendChild(document.createTextNode(' ring.'));
      }
    }

    if (Array.isArray(opts.statLines) && opts.statLines.length) {
      renderStatLines(host, opts.statLines);
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

    var samples = Array.isArray(opts.throughputSamples) ? opts.throughputSamples : [];
    var existingCanvas = host.querySelector ? host.querySelector('canvas.mini-chart') : null;
    if (existingCanvas && existingCanvas.parentNode) {
      existingCanvas.parentNode.removeChild(existingCanvas);
    }
    var existingEmpty = host.querySelector ? host.querySelector('.cc-empty') : null;
    if (existingEmpty && existingEmpty.parentNode) {
      existingEmpty.parentNode.removeChild(existingEmpty);
    }
    if (samples.length >= 2) {
      var canvas = document.createElement('canvas');
      canvas.className = 'mini-chart';
      canvas.id = 'chart-latency';
      canvas.width = typeof opts.chartWidth === 'number' ? opts.chartWidth : 360;
      canvas.height = typeof opts.chartHeight === 'number' ? opts.chartHeight : 40;
      canvas.setAttribute('aria-label', opts.chartLabel || 'Decision latency chart');
      host.appendChild(canvas);
      drawSparkline(canvas, samples, {
        width: canvas.width,
        height: canvas.height,
        strokeStyle: opts.strokeStyle || '#3dd6a5',
      });
    } else if (!samples.length) {
      appendEmpty(host, 'No lane activity yet');
    }

    var caption = host.querySelector ? host.querySelector('.hive-term-prompt') : null;
    if (!caption) {
      caption = el('p', 'term-prompt hive-term-prompt term-prompt--chart-caption');
      caption.appendChild(el('span', 'lbl', opts.latencyCaption || 'decision latency'));
      host.appendChild(caption);
    }
  }

  function drawSparkline(canvas, samples, options) {
    if (!canvas || !canvas.getContext) { return; }
    var ctx = canvas.getContext('2d');
    if (!ctx || typeof ctx.clearRect !== 'function') { return; }
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
    if (containers && containers.sessionTerm) {
      renderSessionTermBlock(containers.sessionTerm, model, opts);
    }
    if (containers && containers.lanes) {
      renderLanesPanel(containers.lanes, model.laneCounts || {}, {
        hero: model.lanesHero,
        statLines: model.statLines,
      });
    }
    if (containers && containers.savings) {
      renderSavingsPanel(containers.savings, model.savingsRows || [], {
        savingsMax: model.savingsMax,
        throughputSamples: model.latencySamples || model.throughputSamples,
        chartLabel: model.latencyChartLabel || model.throughputChartLabel,
        chartWidth: opts.chartWidth,
        chartHeight: opts.chartHeight,
        strokeStyle: opts.latencyStroke || opts.strokeStyle || '#ff4d8d',
        latencyCaption: model.latencyCaption,
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
    renderSessionTermBlock: renderSessionTermBlock,
    renderStatLines: renderStatLines,
    drawBarChart: drawBarChart,
    renderHivePanels: renderHivePanels,
    renderProjectCardMetrics: renderProjectCardMetrics,
    deriveHivePanelModel: deriveHivePanelModel,
  };
}));
