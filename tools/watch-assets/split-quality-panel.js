// SPDX-License-Identifier: Apache-2.0
// Split quality panel renderer for Swarm Watch project pages (R-027).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) { module.exports = factory(); }
  else { root.SplitQualityPanel = factory(); }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var METRIC_ORDER = Object.freeze([
    'overhead',
    'firstTry',
    'criticalPath',
    'waveFill',
    'collisions',
    'reviewCost',
    'sizes',
  ]);

  var CONTRACT_FIELDS = Object.freeze([
    { key: 'overhead', label: 'Overhead ratio', field: 'overheadRatio', kind: 'ratio' },
    { key: 'firstTry', label: 'First-try pass rate', field: 'firstTryPassRate', kind: 'ratio' },
    { key: 'criticalPath', label: 'Critical path', field: 'criticalPath', kind: 'number' },
    { key: 'waveFill', label: 'Wave fill', field: 'waveFill', kind: 'ratio' },
    { key: 'collisions', label: 'Collisions', field: 'collisions', kind: 'count' },
    { key: 'reviewCost', label: 'Review $ per ticket', field: 'reviewUsdPerTicket', kind: 'usd' },
    { key: 'sizes', label: 'Ticket sizes', field: 'ticketSizes', kind: 'sizes' },
  ]);

  function el(doc, tag, cls, text) {
    var node = doc.createElement(tag);
    if (cls) { node.className = cls; }
    if (text !== undefined && text !== null) { node.textContent = String(text); }
    return node;
  }

  function normalizeGrade(grade) {
    var g = String(grade || 'unknown').toLowerCase();
    return g === 'green' || g === 'amber' || g === 'red' ? g : 'unknown';
  }

  function pillClassForGrade(grade) {
    if (grade === 'green') { return 'good'; }
    if (grade === 'amber') { return 'warn'; }
    if (grade === 'red') { return 'bad'; }
    return 'info';
  }

  function percent(value) {
    if (typeof value !== 'number' || !isFinite(value)) { return '—'; }
    return Math.round(value * 1000) / 10 + '%';
  }

  function formatContractValue(spec, raw) {
    if (raw === null || raw === undefined) { return '—'; }
    if (spec.kind === 'ratio') { return percent(raw); }
    if (spec.kind === 'usd') { return '$' + (typeof raw === 'number' && isFinite(raw) ? raw.toFixed(2) : String(raw)); }
    if (spec.kind === 'sizes') {
      if (!Array.isArray(raw) || !raw.length) { return '—'; }
      return raw.map(function (n) { return String(n); }).join(', ');
    }
    if (spec.kind === 'count') { return String(raw); }
    return String(raw);
  }

  function metricIndex(key) {
    var idx = METRIC_ORDER.indexOf(key);
    return idx === -1 ? METRIC_ORDER.length : idx;
  }

  function orderMetrics(metrics) {
    return metrics.slice().sort(function (a, b) {
      return metricIndex(a && a.key) - metricIndex(b && b.key);
    });
  }

  function gradeFromMetrics(metrics, label, key) {
    for (var i = 0; i < metrics.length; i += 1) {
      var item = metrics[i];
      if (!item) { continue; }
      if (key && item.key === key) { return normalizeGrade(item.grade); }
      if (label && item.label === label) { return normalizeGrade(item.grade); }
    }
    return 'unknown';
  }

  function metricsFromContract(splitQuality) {
    var listed = Array.isArray(splitQuality.metrics) ? splitQuality.metrics : [];
    return CONTRACT_FIELDS.map(function (spec) {
      var fromList = listed.find(function (item) { return item && (item.key === spec.key || item.label === spec.label); });
      if (fromList) {
        return {
          key: spec.key,
          label: fromList.label || spec.label,
          display: fromList.text || fromList.display || formatContractValue(spec, fromList.value),
          grade: normalizeGrade(fromList.grade),
          basis: fromList.basis || null,
          note: fromList.note || null,
        };
      }
      var raw = splitQuality[spec.field];
      if (raw === undefined && spec.kind !== 'sizes') { return null; }
      return {
        key: spec.key,
        label: spec.label,
        display: formatContractValue(spec, raw),
        grade: gradeFromMetrics(listed, spec.label, spec.key),
        basis: null,
        note: null,
      };
    }).filter(Boolean);
  }

  function collectMetrics(splitQuality) {
    if (!splitQuality || typeof splitQuality !== 'object') { return []; }
    if (Array.isArray(splitQuality.metrics) && splitQuality.metrics.length) {
      return orderMetrics(splitQuality.metrics.map(function (metric) {
        if (!metric || typeof metric !== 'object') { return null; }
        return {
          key: metric.key || null,
          label: metric.label || metric.key || 'Metric',
          display: metric.display || metric.text || (metric.value === null || metric.value === undefined ? '—' : String(metric.value)),
          grade: normalizeGrade(metric.grade),
          basis: metric.basis || null,
          note: metric.note || null,
        };
      }).filter(Boolean));
    }
    return metricsFromContract(splitQuality);
  }

  function render(host, splitQuality, options) {
    if (!host) { return; }
    var doc = (options && options.document) || host.ownerDocument || (typeof document !== 'undefined' ? document : null);
    if (!doc) { return; }
    host.textContent = '';
    if (!splitQuality) {
      host.appendChild(el(doc, 'div', 'board-empty', 'Split quality unavailable.'));
      return;
    }
    var metrics = collectMetrics(splitQuality);
    if (!metrics.length) {
      host.appendChild(el(doc, 'div', 'board-empty', 'Split quality unavailable.'));
      return;
    }
    var header = el(doc, 'div', 'row');
    header.appendChild(el(doc, 'span', 'name', 'Overall'));
    var overall = normalizeGrade(splitQuality.grade);
    header.appendChild(el(doc, 'span', 'pill ' + pillClassForGrade(overall), overall));
    if (splitQuality.at) {
      header.appendChild(el(doc, 'span', 'mono', String(splitQuality.at).slice(0, 16).replace('T', ' ')));
    }
    host.appendChild(header);
    metrics.forEach(function (metric) {
      var row = el(doc, 'div', 'board-entry');
      var grade = normalizeGrade(metric.grade);
      var dot = el(doc, 'span', 'dot grade-' + grade);
      dot.setAttribute('aria-hidden', 'true');
      row.appendChild(dot);
      var body = el(doc, 'div', 'split-text');
      var top = el(doc, 'div', 'row');
      top.appendChild(el(doc, 'span', 'name', metric.label));
      top.appendChild(el(doc, 'span', 'mono', metric.display));
      body.appendChild(top);
      var subText = grade === 'unknown' ? (metric.note || metric.basis) : metric.basis;
      if (subText) { body.appendChild(el(doc, 'div', 'sub', subText)); }
      row.appendChild(body);
      if (metric.note) { row.title = metric.note; }
      host.appendChild(row);
    });
  }

  return {
    METRIC_ORDER: METRIC_ORDER,
    collectMetrics: collectMetrics,
    render: render,
    renderSplitQuality: render,
  };
}));
