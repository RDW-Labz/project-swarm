// SPDX-License-Identifier: Apache-2.0
// Hive command-center panels: session log, lanes/workers, savings/throughput (DOM renderers + pure helpers).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) { module.exports = factory(); }
  else if (root) { root.HivePanels = factory(); }
}(typeof self !== 'undefined' ? self : typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var LANE_ORDER = ['cursor', 'codex', 'claude', 'hermes', 'openrouter', 'anthropic', 'rented', 'local', 'qwen', 'openai', 'gemini', 'ollama', 'lambda'];
  var HIVE_PANEL_LANES = ['safety', 'route', 'context', 'control'];

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
    if (row.unit === 'usd') { return formatUsd(value); }
    return String(Math.round(value));
  }

  function formatUsd(value) {
    if (typeof value !== 'number' || !Number.isFinite(value)) { return '—'; }
    if (value >= 1000) { return '$' + Math.round(value).toLocaleString('en-US'); }
    return '$' + (Math.round(value * 100) / 100);
  }

  function fieldNumber(field) {
    if (!field || typeof field !== 'object') { return null; }
    var v = field.value;
    if (typeof v === 'string' && v.trim() !== '') { v = Number(v); }
    return typeof v === 'number' && Number.isFinite(v) ? v : null;
  }

  function projectTitle(project) {
    if (!project || typeof project !== 'object') { return ''; }
    if (typeof project.name === 'string' && project.name.length) { return project.name; }
    return String(project.id || '');
  }

  function plural(n, one, many) {
    return n + ' ' + (n === 1 ? one : (many || one + 's'));
  }

  /** Per-project counts read from whichever labelled fields the snapshot kept. */
  function projectSignals(project) {
    var needs = fieldNumber(project && project.needsYou);
    var asksField = fieldNumber(project && project.asks);
    return {
      needs: needs !== null ? needs : 0,
      ready: needs !== null && asksField !== null ? asksField : 0,
      fails: fieldNumber(project && project.fails) || 0,
      live: Math.max(fieldNumber(project && project.liveAgents) || 0, fieldNumber(project && project.out) || 0),
    };
  }

  /** Lane the snapshot computes (needs you, building, ready, else control); derived when the field was dropped. */
  function laneOfProject(project) {
    if (project && typeof project.lane === 'string' && HIVE_PANEL_LANES.indexOf(project.lane) >= 0) {
      return project.lane;
    }
    var s = projectSignals(project);
    if (s.needs > 0) { return 'safety'; }
    if (s.live > 0) { return 'context'; }
    if (s.ready > 0) { return 'route'; }
    return 'control';
  }

  /** Header status pill: failed beats needs you beats running beats idle. */
  function projectStatus(project) {
    var s = projectSignals(project);
    if (s.fails > 0) { return { key: 'failed', label: 'failed' }; }
    if (s.needs > 0) { return { key: 'needs', label: 'needs you' }; }
    if (s.live > 0) { return { key: 'running', label: 'running' }; }
    return { key: 'idle', label: 'idle' };
  }

  var BOT_SVG_METHODS = ['svg', 'toSvg', 'svgFor', 'markup', 'headSvg'];

  /** Robot-head markup from the shared robot assets when they are loaded on the page; '' otherwise. */
  function robotMarkup(seed) {
    var g = typeof globalThis !== 'undefined' ? globalThis : {};
    var apis = [g.RobotAvatar, g.RobotHead];
    for (var a = 0; a < apis.length; a += 1) {
      var api = apis[a];
      if (!api) { continue; }
      for (var m = 0; m < BOT_SVG_METHODS.length; m += 1) {
        if (typeof api[BOT_SVG_METHODS[m]] !== 'function') { continue; }
        try {
          var out = api[BOT_SVG_METHODS[m]](seed);
          if (typeof out === 'string' && out.indexOf('<svg') >= 0) { return out; }
        } catch (e) { /* try the next entry point */ }
      }
    }
    return '';
  }

  /** The project's robot head as <img class="hive-bot">; a lane-tinted monogram when the assets are not loaded. */
  function createProjectBot(project) {
    var title = projectTitle(project);
    var markup = robotMarkup(String((project && project.id) || title));
    if (markup) {
      var img = document.createElement('img');
      img.className = 'hive-bot';
      img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(markup);
      img.alt = '';
      img.setAttribute('aria-hidden', 'true');
      return img;
    }
    var mono = el('span', 'hive-bot hive-bot--mono', title ? title.charAt(0).toUpperCase() : '·');
    mono.setAttribute('aria-hidden', 'true');
    return mono;
  }

  var NEEDS_RANK = { failed: 0, asks: 1, next: 2 };

  /** Attention list rows: failed first, then asks, then next; no row for a zero count. */
  function deriveNeedsYouItems(projects) {
    var list = Array.isArray(projects) ? projects : [];
    var items = [];
    for (var i = 0; i < list.length; i += 1) {
      var p = list[i];
      if (!p || typeof p.id !== 'string') { continue; }
      var s = projectSignals(p);
      var name = projectTitle(p);
      if (s.fails > 0) {
        items.push({ kind: 'failed', projectId: p.id, name: name, count: s.fails, title: plural(s.fails, 'failed ticket'), project: p });
      }
      if (s.needs > 0) {
        items.push({ kind: 'asks', projectId: p.id, name: name, count: s.needs, title: plural(s.needs, 'item') + ' waiting on you', project: p });
      }
      if (s.ready > 0) {
        items.push({ kind: 'next', projectId: p.id, name: name, count: s.ready, title: plural(s.ready, 'ticket') + ' ready to run', project: p });
      }
    }
    items.sort(function (a, b) {
      if (NEEDS_RANK[a.kind] !== NEEDS_RANK[b.kind]) { return NEEDS_RANK[a.kind] - NEEDS_RANK[b.kind]; }
      return b.count - a.count;
    });
    return items;
  }

  var NEEDS_PILL = { failed: 'failed', asks: 'needs you', next: 'next' };
  var NEEDS_PILL_CLASS = { failed: 'st-failed', asks: 'st-needs', next: 'st-next' };

  /**
   * Fill the "needs you" list. options: limit (default 6), onOpen(projectId), hrefFor(projectId).
   * Returns the number of rows that exist (before the limit).
   */
  function renderNeedsYou(host, items, options) {
    if (!host) { return 0; }
    var opts = options || {};
    var list = Array.isArray(items) ? items : [];
    clearChildren(host);
    if (!list.length) {
      var none = el('li', 'cc-empty hive-needs-empty', 'Nothing needs you right now.');
      host.appendChild(none);
      return 0;
    }
    var limit = typeof opts.limit === 'number' && opts.limit > 0 ? Math.floor(opts.limit) : 6;
    var shown = list.slice(0, limit);
    for (var i = 0; i < shown.length; i += 1) {
      host.appendChild(needsRow(shown[i], opts));
    }
    if (list.length > shown.length) {
      host.appendChild(el('li', 'cc-empty hive-needs-more', '+' + (list.length - shown.length) + ' more on the board'));
    }
    return list.length;
  }

  function needsRow(item, opts) {
    var li = el('li', 'hive-needs-row');
    li.setAttribute('data-kind', item.kind);
    li.appendChild(createProjectBot(item.project || { id: item.projectId, name: item.name }));
    var main = el('div', 'hive-needs-main');
    var top = el('div', 'hive-needs-top');
    top.appendChild(el('span', 'hive-needs-name', item.name));
    top.appendChild(el('span', 'hive-pill ' + (NEEDS_PILL_CLASS[item.kind] || 'st-idle'), NEEDS_PILL[item.kind] || item.kind));
    main.appendChild(top);
    main.appendChild(el('div', 'hive-needs-title', item.title));
    li.appendChild(main);
    var href = typeof opts.hrefFor === 'function'
      ? opts.hrefFor(item.projectId)
      : '/command-center/project/' + encodeURIComponent(item.projectId);
    var open = el('a', 'hive-open', 'Open');
    open.href = href;
    open.setAttribute('aria-label', 'Open ' + item.name + ' cockpit');
    if (typeof opts.onOpen === 'function' && open.addEventListener) {
      open.addEventListener('click', function (e) {
        if (e && (e.metaKey || e.ctrlKey || e.shiftKey || e.button)) { return; }
        if (e && typeof e.preventDefault === 'function') { e.preventDefault(); }
        opts.onOpen(item.projectId);
      });
    }
    li.appendChild(open);
    return li;
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

  function cardMetricField(project, key) {
    if (!project || typeof project !== 'object') { return null; }
    if (key === 'asks') {
      if (project.needsYou && typeof project.needsYou === 'object') { return project.needsYou; }
      if (project.asks && typeof project.asks === 'object') { return project.asks; }
      return null;
    }
    if (key === 'out') { return project.out || null; }
    if (key === 'fails') { return project.fails || null; }
    return project[key] || null;
  }

  function shouldUseHiveLanePanel(laneCounts) {
    if (!laneCounts || typeof laneCounts !== 'object') { return true; }
    var hasAgent = false;
    var hasHive = false;
    for (var key in laneCounts) {
      if (!Object.prototype.hasOwnProperty.call(laneCounts, key)) { continue; }
      if (HIVE_PANEL_LANES.indexOf(key) >= 0) { hasHive = true; }
      else { hasAgent = true; }
    }
    if (hasAgent && !hasHive) { return false; }
    return true;
  }

  function hiveLanePanelRows(laneCounts) {
    var counts = laneCounts && typeof laneCounts === 'object' ? laneCounts : {};
    var total = 0;
    for (var i = 0; i < HIVE_PANEL_LANES.length; i += 1) {
      var lane = HIVE_PANEL_LANES[i];
      var raw = counts[lane];
      var c = typeof raw === 'number' && Number.isFinite(raw) ? Math.max(0, Math.floor(raw)) : 0;
      total += c;
    }
    var rows = [];
    for (var j = 0; j < HIVE_PANEL_LANES.length; j += 1) {
      var name = HIVE_PANEL_LANES[j];
      var count = counts[name];
      var n = typeof count === 'number' && Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0;
      rows.push({
        name: name,
        count: n,
        fillPct: total > 0 ? (n / total) * 100 : 0,
        laneClass: name,
      });
    }
    return rows;
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
      var field = cardMetricField(project, key);
      if (key === 'out' && !field) { field = project.liveAgents || null; }
      var cell = el('div', 'hive-kv-cell');
      cell.appendChild(el('dt', null, key));
      var shownValue = readTrustedDisplay(field);
      var n = fieldNumber(field);
      var tone = n !== null && n > 0 ? (key === 'fails' ? ' bad' : (key === 'asks' ? ' warn' : ' ok')) : (n === 0 ? ' zero' : '');
      var dd = el('dd', 'num' + tone, shownValue);
      var title = trustedTitle(field);
      if (title) { dd.setAttribute('title', title); }
      cell.appendChild(dd);
      dl.appendChild(cell);
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

  function boardEventsFromProjects(projects, at) {
    var events = [];
    for (var i = 0; i < projects.length; i += 1) {
      var p = projects[i];
      var s = projectSignals(p);
      var name = projectTitle(p);
      var base = { id: p.id, ts: at };
      if (s.fails > 0) {
        events.push({ kind: 'blocker', id: base.id + ':failed', ts: at, text: name + ': ' + plural(s.fails, 'failed ticket') });
      }
      if (s.needs > 0) {
        events.push({ kind: 'human', id: base.id + ':asks', ts: at, text: name + ': ' + plural(s.needs, 'item') + ' waiting' });
      }
      if (s.live > 0) {
        events.push({ kind: 'run', id: base.id + ':live', ts: at, text: name + ': ' + plural(s.live, 'agent') + ' running' });
      }
    }
    return events;
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
    var runningProjects = 0;
    for (var pi = 0; pi < projects.length; pi += 1) {
      var proj = projects[pi];
      var lane = laneOfProject(proj);
      laneCounts[lane] = (laneCounts[lane] || 0) + 1;
      if (projectSignals(proj).live > 0) { runningProjects += 1; }
    }
    // The stat cards already show needs-you and agents-live, so the lanes panel carries no duplicate lines.
    var statLines = [];
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
    // No event feed on the snapshot: the log reports the same project signals that drive the stat cards.
    if (!journalEvents.length) { journalEvents = boardEventsFromProjects(projects, snapshot.at); }

    var savingsRows = [];
    if (stats.needsYouCount && typeof stats.needsYouCount.value === 'number') {
      savingsRows.push({
        label: 'needs you',
        value: stats.needsYouCount.value,
        unit: 'count',
        title: stats.needsYouCount.source,
        max: Math.max(stats.needsYouCount.value, 1),
        fillGradient: 'linear-gradient(90deg,#fbbf24,#fb923c)',
      });
    }
    if (projects.length > 0) {
      savingsRows.push({
        label: 'projects running',
        displayValue: runningProjects + '/' + projects.length,
        value: runningProjects,
        max: projects.length,
        title: 'projects[].liveAgents',
        fillGradient: 'linear-gradient(90deg,#34d399,#3dd6a5)',
      });
    }
    var doneProjects = 0;
    var trackedProjects = 0;
    for (var pj = 0; pj < projects.length; pj += 1) {
      var pctField = projects[pj].percentDone;
      var pct = pctField && typeof pctField.value === 'string' ? parseInt(pctField.value, 10) : NaN;
      if (Number.isFinite(pct)) {
        trackedProjects += 1;
        if (pct >= 100) { doneProjects += 1; }
      }
    }
    if (trackedProjects > 0) {
      savingsRows.push({
        label: 'projects done',
        displayValue: doneProjects + '/' + trackedProjects,
        value: doneProjects,
        max: trackedProjects,
        title: 'projects[].progress.overall',
        fillGradient: 'linear-gradient(90deg,#60a5fa,#93c5fd)',
      });
    }
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
    var throughputSamples = Array.isArray(modelObj.throughputSamples) ? modelObj.throughputSamples : [];
    // No samples: no chart box and no "nothing yet" line (the board state above already says what is live).
    if (throughputSamples.length) {
      var canvas = document.createElement('canvas');
      canvas.className = 'mini-chart';
      canvas.id = 'chart-fps';
      canvas.width = typeof opts.chartWidth === 'number' ? opts.chartWidth : 360;
      canvas.height = typeof opts.chartHeight === 'number' ? opts.chartHeight : 40;
      canvas.setAttribute('aria-label', modelObj.throughputChartLabel || 'Throughput chart');
      host.appendChild(canvas);
      drawBarChart(canvas, throughputSamples, ['#5eb8ff', '#3dd6a5', '#ff4d8d', '#f5c451']);
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

    var rows = shouldUseHiveLanePanel(laneCounts)
      ? hiveLanePanelRows(laneCounts)
      : laneRowsFromCounts(laneCounts);
    var laneTotal = 0;
    for (var t = 0; t < rows.length; t += 1) {
      laneTotal += typeof rows[t].count === 'number' ? rows[t].count : 0;
    }
    if (!rows.length || laneTotal <= 0) {
      var laneEmpty = el('p', 'term-prompt', 'no lane traffic yet');
      barsRoot.appendChild(laneEmpty);
    } else {
      for (var i = 0; i < rows.length; i += 1) {
        var row = rows[i];
        var rowEl = el('div', 'lane-row');
        rowEl.appendChild(el('span', 'name', row.name));
        var track = el('span', 'lane-track');
        var fill = document.createElement('i');
        fill.className = 'lane-fill ' + (row.laneClass || row.name);
        fill.style.width = row.fillPct.toFixed(2) + '%';
        track.appendChild(fill);
        rowEl.appendChild(track);
        var num = el('span', 'num', String(row.count));
        num.title = 'lane.' + row.name;
        rowEl.appendChild(num);
        barsRoot.appendChild(rowEl);
      }
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
    if (!rows.length) {
      rowsRoot.appendChild(el('p', 'cc-empty', 'No throughput metrics yet'));
    }
    for (var i = 0; i < rows.length; i += 1) {
      var row = rows[i];
      var rowEl = el('div', 'saving-row');
      rowEl.appendChild(el('span', 'lbl', row.label || ''));
      var display = row.displayValue != null ? String(row.displayValue) : formatSavingsValue(row);
      var num = el('span', 'num', display);
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
    var existingCaption = host.querySelector ? host.querySelector('.hive-term-prompt') : null;
    if (existingCaption && existingCaption.parentNode) {
      existingCaption.parentNode.removeChild(existingCaption);
    }
    // Chart only when there is something to plot; an empty chart box is never rendered.
    if (samples.length >= 2) {
      var baselineCanvas = document.createElement('canvas');
      baselineCanvas.className = 'mini-chart';
      baselineCanvas.id = 'chart-latency';
      baselineCanvas.width = typeof opts.chartWidth === 'number' ? opts.chartWidth : 360;
      baselineCanvas.height = typeof opts.chartHeight === 'number' ? opts.chartHeight : 40;
      baselineCanvas.setAttribute('aria-label', opts.chartLabel || 'Decision latency chart');
      host.appendChild(baselineCanvas);
      drawSparkline(baselineCanvas, samples, {
        width: baselineCanvas.width,
        height: baselineCanvas.height,
        strokeStyle: opts.strokeStyle || '#3dd6a5',
      });
      var caption = el('p', 'term-prompt hive-term-prompt term-prompt--chart-caption');
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

  /* ---- Hive dashboard (owner-approved design): view model + the three panels under the ring ---- */

  var CAT_COLOR = { building: '#2fe0a0', blocked: '#ffb62e', need: '#ff4d7e', done: '#4d7cff', idle: '#a98bff', off: '#58627a' };
  var CAT_TAG = { building: 'BUILDING', blocked: 'BLOCKED', need: 'NEEDS YOU', done: 'DONE', idle: 'IDLE', off: 'OFFLINE' };
  var LANE_COLOR = { orchestrator: '#c084fc', haiku: '#34d399', sonnet: '#60a5fa', opus: '#fbbf24', codex: '#f472b6', cursor: '#a3e635', claude: '#94a3b8' };
  var EVENT_KIND = {
    review: { label: 'review', color: 'var(--red)' },
    blocked: { label: 'waits', color: 'var(--amber)' },
    done: { label: 'done', color: 'var(--blue)' },
    pr: { label: 'pr', color: 'var(--green)' },
    failed: { label: 'failed', color: 'var(--red)' },
    needs: { label: 'needs', color: 'var(--red)' },
    run: { label: 'run', color: 'var(--green)' },
  };
  var BAR_COLORS = ['#4d7cff', '#2fe0a0', '#ff4d7e', '#ffb62e'];
  var BUBBLE_GLYPH = { excl: '!', sleep: 'z', cross: '×', dots: '…', stars: '★' };

  function laneColor(name) { return LANE_COLOR[String(name).toLowerCase()] || '#94a3b8'; }

  /** "just now", "12 min ago", "3 h ago", "2 d ago" from an age in milliseconds. */
  function agoText(ms) {
    var m = Math.round(ms / 60000);
    if (m < 1) { return 'just now'; }
    if (m < 90) { return m + ' min ago'; }
    if (m < 2880) { return Math.round(m / 60) + ' h ago'; }
    return Math.round(m / 1440) + ' d ago';
  }

  function nonNeg(v) { return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null; }

  /** Ticket counts of a project card (server field ticketCounts); null when the card carries none. */
  function cardCounts(project) {
    var c = project && project.ticketCounts;
    if (!c || typeof c !== 'object' || nonNeg(c.total) === null) { return null; }
    return {
      total: c.total,
      done: nonNeg(c.done) || 0,
      ready: nonNeg(c.ready) || 0,
      blocked: nonNeg(c.blocked) || 0,
      review: nonNeg(c.review) || 0,
      cancelled: nonNeg(c.cancelled) || 0,
      remaining: nonNeg(c.remaining) !== null ? c.remaining : Math.max(0, c.total - (nonNeg(c.done) || 0) - (nonNeg(c.cancelled) || 0)),
    };
  }

  /** One project for the Hive: ledger counts, percent, and the colour category the ring and card share. */
  function projectView(project) {
    var s = projectSignals(project);
    var counts = cardCounts(project);
    var counted = counts ? counts.total - counts.cancelled : null;
    var pct = null;
    if (counts && counted > 0) { pct = Math.round((counts.done / counted) * 100); }
    else if (project.meter && typeof project.meter.value === 'number' && Number.isFinite(project.meter.value)) { pct = Math.round(project.meter.value); }
    else if (project.percentDone && typeof project.percentDone.value === 'string' && Number.isFinite(parseInt(project.percentDone.value, 10))) { pct = parseInt(project.percentDone.value, 10); }
    var cat = 'idle';
    if (pct === 100) { cat = 'done'; }
    else if (s.needs > 0) { cat = 'need'; }
    else if (counts && counts.blocked > 0 && s.live === 0) { cat = 'blocked'; }
    else if (s.live > 0) { cat = 'building'; }
    return {
      id: project.id,
      name: projectTitle(project),
      machine: project.machine && typeof project.machine.value === 'string' ? project.machine.value : '',
      counts: counts,
      counted: counted,
      pct: pct,
      needs: s.needs,
      agents: s.live,
      cat: cat,
      color: CAT_COLOR[cat],
      tag: CAT_TAG[cat],
      source: project.ticketCounts ? project.ticketCounts.source : '',
    };
  }

  function sumField(list, key) {
    var t = 0;
    var any = false;
    for (var i = 0; i < list.length; i += 1) {
      if (list[i].counts) { t += list[i].counts[key]; any = true; }
    }
    return any ? t : null;
  }

  /** Session log rows from the snapshot's ledger events; without them, the same project signals the ring uses. */
  function sessionEvents(projects, hive) {
    if (hive && Array.isArray(hive.events) && hive.events.length) { return hive.events; }
    var out = [];
    for (var i = 0; i < projects.length; i += 1) {
      var p = projects[i];
      var fails = fieldNumber(p.raw && p.raw.fails) || 0;
      if (fails > 0) { out.push({ kind: 'failed', id: '', title: p.name + ': ' + plural(fails, 'failed ticket') }); }
      if (p.needs > 0) { out.push({ kind: 'needs', id: '', title: p.name + ': ' + plural(p.needs, 'item') + ' waiting on you' }); }
      if (p.agents > 0) { out.push({ kind: 'run', id: '', title: p.name + ': ' + plural(p.agents, 'agent') + ' running' }); }
    }
    return out;
  }

  /**
   * Everything the Hive draws, from one snapshot (parsed fields plus the server's hive extras).
   * Anything the snapshot does not carry stays null so the view can say so in one muted line.
   */
  function deriveHiveView(snapshot) {
    var snap = snapshot && typeof snapshot === 'object' ? snapshot : {};
    var stats = snap.stats && typeof snap.stats === 'object' ? snap.stats : {};
    var hive = snap.hive && typeof snap.hive === 'object' ? snap.hive : {};
    var raw = Array.isArray(snap.projects) ? snap.projects.slice(0, 10) : [];
    var projects = raw.map(function (p) { var v = projectView(p); v.raw = p; return v; });
    var agents = fieldNumber(stats.agentsLive);
    if (agents === null) { agents = projects.reduce(function (a, p) { return a + p.agents; }, 0); }
    var needs = fieldNumber(stats.needsYouCount);
    if (needs === null) { needs = projects.reduce(function (a, p) { return a + p.needs; }, 0); }
    var lanes = null;
    if (hive.lanes && typeof hive.lanes === 'object') {
      lanes = [];
      for (var k in hive.lanes) {
        if (!Object.prototype.hasOwnProperty.call(hive.lanes, k)) { continue; }
        var jobs = nonNeg(hive.lanes[k] && hive.lanes[k].jobs24h);
        if (jobs !== null) { lanes.push({ name: k, jobs24h: jobs, running: nonNeg(hive.lanes[k].running) || 0 }); }
      }
      lanes.sort(function (a, b) { return b.jobs24h - a.jobs24h; });
      if (!lanes.length) { lanes = null; }
    }
    var machines = [];
    for (var m = 0; m < projects.length; m += 1) {
      if (projects[m].machine && machines.indexOf(projects[m].machine) < 0) { machines.push(projects[m].machine); }
    }
    var counted = projects.reduce(function (a, p) { return p.counted !== null ? a + p.counted : a; }, 0);
    return {
      at: snap.at,
      projects: projects,
      agents: agents,
      needs: needs,
      projectsTotal: fieldNumber(stats.projectsTotal) !== null ? fieldNumber(stats.projectsTotal) : projects.length,
      spend: fieldNumber(stats.spendUsd),
      doneLast24h: nonNeg(hive.doneLast24h),
      throughput: Array.isArray(hive.throughput24h) && hive.throughput24h.length ? hive.throughput24h : null,
      lanes: lanes,
      prs: Array.isArray(hive.prs) ? hive.prs : null,
      events: sessionEvents(projects, hive),
      machines: machines,
      totals: {
        tickets: sumField(projects, 'total'),
        done: sumField(projects, 'done'),
        ready: sumField(projects, 'ready'),
        blocked: sumField(projects, 'blocked'),
        review: sumField(projects, 'review'),
        remaining: sumField(projects, 'remaining'),
        counted: projects.some(function (p) { return p.counted !== null; }) ? counted : null,
      },
    };
  }

  function muted(text) { return el('p', 'hive-muted', text); }

  function svgEl(tag) {
    return typeof document.createElementNS === 'function' ? document.createElementNS('http://www.w3.org/2000/svg', tag) : document.createElement(tag);
  }

  /** Small speech-bubble badge over a robot head (CSS only): excl, sleep, cross, dots, stars. */
  function createBubble(kind) {
    var b = el('span', 'hive-bub hive-bub--' + kind, BUBBLE_GLYPH[kind] || '');
    b.setAttribute('aria-hidden', 'true');
    return b;
  }

  /** Step-chart path for completions per hour (x spans 0..300, y 8..64 like the artifact). */
  function stepPath(points) {
    var max = 1;
    for (var i = 0; i < points.length; i += 1) { if (points[i] > max) { max = points[i]; } }
    var d = '';
    var prev = 0;
    for (var j = 0; j < points.length; j += 1) {
      var x = (j / points.length) * 300;
      var y = 64 - (points[j] / max) * 56;
      d += (j ? 'L' + x + ',' + prev + ' L' + x + ',' + y : 'M' + x + ',' + y) + ' ';
      prev = y;
    }
    return d + 'L300,' + prev;
  }

  function sectionHeading(text, extraClass) { return el('h2', extraClass || null, text); }

  function renderSessionLog(host, events, nowMs) {
    clearChildren(host);
    var list = Array.isArray(events) ? events.slice(0, 13) : [];
    if (!list.length) { host.appendChild(muted('no ledger events yet')); return; }
    for (var i = 0; i < list.length; i += 1) {
      var ev = list[i];
      var meta = EVENT_KIND[ev.kind] || { label: String(ev.kind), color: 'var(--muted)' };
      var row = el('div', 'hive-slog-row');
      row.setAttribute('data-kind', String(ev.kind));
      var tag = el('b', null, meta.label);
      tag.style.color = meta.color;
      row.appendChild(tag);
      var body = el('span');
      if (ev.id) {
        body.appendChild(el('span', 'hive-mono hive-fg', ev.id));
        body.appendChild(document.createTextNode(' '));
      }
      body.appendChild(document.createTextNode(String(ev.title || '')));
      var at = parseEventTime(ev.at);
      if (Number.isFinite(at) && Number.isFinite(nowMs)) {
        body.appendChild(document.createTextNode(' '));
        body.appendChild(el('span', 'hive-dim', agoText(nowMs - at)));
      }
      row.appendChild(body);
      host.appendChild(row);
    }
  }

  function renderHourBars(host, samples) {
    clearChildren(host);
    if (!samples) { host.appendChild(muted('no completion times in the ledger')); return; }
    var max = 1;
    for (var i = 0; i < samples.length; i += 1) { if (samples[i] > max) { max = samples[i]; } }
    for (var j = 0; j < samples.length; j += 1) {
      var bar = el('i', 'has-tip');
      var col = BAR_COLORS[j % 4];
      bar.setAttribute('tabindex', '0');
      bar.setAttribute('data-tip', samples[j] + ' done, ' + (samples.length - j) + ' h ago');
      bar.style.height = Math.max(3, (samples[j] / max) * 70) + 'px';
      bar.style.background = col;
      bar.style.boxShadow = '0 0 6px ' + col + '55';
      host.appendChild(bar);
    }
  }

  var STATUS_BARS = [['done', '#4d7cff', 'done'], ['ready', '#2fe0a0', 'ready to start'], ['review', '#ff4d7e', 'in review'], ['blocked', '#ffb62e', 'waiting on others']];

  /**
   * Bars when the ledger has no completion times: one bar per project and ticket status, in ring order
   * (square-root scale so a handful of tickets still shows next to hundreds). Returns how many bars it drew.
   */
  function renderStatusBars(host, projects) {
    clearChildren(host);
    var list = [];
    var max = 0;
    for (var i = 0; i < projects.length; i += 1) {
      var c = projects[i].counts;
      if (!c) { continue; }
      list.push(projects[i]);
      for (var s = 0; s < STATUS_BARS.length; s += 1) { if (c[STATUS_BARS[s][0]] > max) { max = c[STATUS_BARS[s][0]]; } }
    }
    if (!list.length || max <= 0) { return 0; }
    host.setAttribute('data-mode', 'status');
    host.setAttribute('role', 'img');
    host.setAttribute('aria-label', 'Tickets per project by status');
    var top = Math.sqrt(max);
    var n = 0;
    for (var j = 0; j < list.length; j += 1) {
      for (var k = 0; k < STATUS_BARS.length; k += 1) {
        var v = list[j].counts[STATUS_BARS[k][0]];
        var col = STATUS_BARS[k][1];
        var bar = el('i', 'has-tip');
        bar.setAttribute('data-tip', list[j].name + ': ' + v + ' ' + STATUS_BARS[k][2]);
        bar.style.height = (v > 0 ? Math.max(3, (Math.sqrt(v) / top) * 64) : 2) + 'px';
        bar.style.background = col;
        bar.style.boxShadow = v > 0 ? '0 0 6px ' + col + '88' : 'none';
        if (v <= 0) { bar.style.opacity = '0.35'; }
        host.appendChild(bar);
        n += 1;
      }
    }
    return n;
  }

  /** "Who" bars without per-lane job counts: live agents per project, else projects per ring colour. */
  function whoGroups(view) {
    var projects = view.projects;
    if (!projects.length) { return null; }
    var busy = projects.filter(function (p) { return p.agents > 0; });
    if (busy.length) {
      busy.sort(function (a, b) { return b.agents - a.agents; });
      return {
        title: 'Who is building now',
        total: busy.reduce(function (a, p) { return a + p.agents; }, 0),
        rows: busy.map(function (p) { return { label: p.name, value: p.agents, color: p.color }; }),
        cap: 'live agents per project, from the run folders',
      };
    }
    var order = ['building', 'need', 'blocked', 'done', 'idle', 'off'];
    var rows = [];
    for (var i = 0; i < order.length; i += 1) {
      var n = projects.filter(function (p) { return p.cat === order[i]; }).length;
      if (n > 0) { rows.push({ label: CAT_TAG[order[i]].toLowerCase(), value: n, color: CAT_COLOR[order[i]] }); }
    }
    return { title: 'Projects by state', total: projects.length, rows: rows, cap: 'projects per colour on the ring' };
  }

  function hbar(cols, labelNode, frac, color, valueText, valueColor) {
    var row = el('div', 'hive-hbar');
    row.style.gridTemplateColumns = cols;
    var kids = Array.isArray(labelNode) ? labelNode : [labelNode];
    for (var i = 0; i < kids.length; i += 1) { row.appendChild(kids[i]); }
    var track = el('i');
    track.style.color = color;
    var fill = el('u');
    fill.style.background = color;
    fill.style.transform = 'scaleX(' + Math.max(0, Math.min(1, frac)) + ')';
    track.appendChild(fill);
    row.appendChild(track);
    var val = el('span', null, valueText);
    if (valueColor) { val.style.color = valueColor; }
    row.appendChild(val);
    return row;
  }

  function kvRow(label, value, color, title) {
    var row = el('div', 'hive-kv');
    row.appendChild(el('span', null, label));
    var b = el('b', null, value === null || value === undefined ? '—' : String(value));
    if (color && value !== null && value !== undefined) { b.style.color = color; }
    if (title) { b.setAttribute('data-source', title); }
    row.appendChild(b);
    return row;
  }

  function numOrNull(v) { return v === null || v === undefined ? null : v; }

  /** Three panels: session log + hourly bars, all projects + who built, what the ledger shows. Returns the robot-head handles it mounted. */
  function renderHiveDashboard(root, view, options) {
    var opts = options || {};
    var nowMs = typeof opts.nowMs === 'number' ? opts.nowMs : Date.now();
    var heads = [];
    var pendingHeads = [];
    clearChildren(root);

    var log = el('section', 'hive-panel');
    log.setAttribute('aria-labelledby', 'hive-h-log');
    var h1 = sectionHeading('Session log');
    h1.id = 'hive-h-log';
    log.appendChild(h1);
    var slog = el('div', 'hive-slog');
    renderSessionLog(slog, view.events, nowMs);
    log.appendChild(slog);
    // Command line, bars and caption sit at the foot of the panel so all three columns end on one line.
    var logFoot = el('div', 'hive-push');
    var bars = el('div', 'hive-bars');
    var cmd = el('div', 'hive-cap hive-cap--cmd');
    cmd.appendChild(el('span', 'p', '~/swarm $ '));
    logFoot.appendChild(cmd);
    logFoot.appendChild(bars);
    if (view.throughput) {
      cmd.appendChild(el('b', null, 'swarm tickets --status done --since 24h'));
      renderHourBars(bars, view.throughput);
      logFoot.appendChild(el('div', 'hive-cap', 'done per hour, last 24 h, oldest on the left'));
    } else if (renderStatusBars(bars, view.projects) > 0) {
      // Real ticket counts are on the board, so the chart stands on its own; the note is only for zero data.
      cmd.appendChild(el('b', null, 'watch --board'));
      logFoot.appendChild(el('div', 'hive-cap', 'tickets per project · done · ready · review · waiting'));
    } else {
      cmd.appendChild(el('b', null, 'swarm tickets --status done --since 24h'));
      renderHourBars(bars, null);
    }
    log.appendChild(logFoot);

    var all = el('section', 'hive-panel');
    all.setAttribute('aria-labelledby', 'hive-h-all');
    var h2 = sectionHeading('All projects');
    h2.id = 'hive-h-all';
    all.appendChild(h2);
    var big = el('div', 'hive-big', String(view.projectsTotal));
    big.appendChild(el('small', null, view.projectsTotal === 1 ? 'project on the board' : 'projects on the board'));
    all.appendChild(big);
    all.appendChild(el('div', 'hive-hint hive-hint--machines', view.machines.length ? 'read from ' + view.machines.join(', ') : 'machine names not reported'));
    // Done per project: a compact two-column list. It sits under the right panel's step line, which plots the
    // same percentages in ring order, so the middle column keeps the target's big number, who bars and figures.
    var byproj = el('div', 'hive-dpp');
    byproj.setAttribute('aria-label', 'Done per project');
    var withPct = view.projects.filter(function (p) { return p.pct !== null; });
    if (!withPct.length) { byproj.appendChild(muted('no ledger percentages yet')); }
    for (var i = 0; i < withPct.length; i += 1) {
      var nm = el('span', null, withPct[i].name);
      nm.setAttribute('title', withPct[i].name);
      byproj.appendChild(hbar('minmax(0,1fr) 38px 32px', nm, withPct[i].pct / 100, withPct[i].color, withPct[i].pct + '%'));
    }
    var groups = view.lanes ? null : whoGroups(view);
    var who = sectionHeading(view.lanes || !groups ? 'Who built (24 h)' : groups.title, 'hive-h-gap');
    all.appendChild(who);
    var whoBox = el('div', 'hive-who');
    if (!view.lanes) {
      if (groups) {
        var shown = groups.rows.slice(0, 3);
        for (var gi = 0; gi < shown.length; gi += 1) {
          var gl = el('span', 'hive-fg', shown[gi].label);
          gl.setAttribute('title', shown[gi].label);
          whoBox.appendChild(hbar('minmax(0,150px) 1fr 40px', gl, shown[gi].value / (groups.total || 1), shown[gi].color, String(shown[gi].value), shown[gi].color));
        }
        var more = groups.rows.length - shown.length;
        whoBox.appendChild(el('div', 'hive-cap', groups.cap + (more > 0 ? ' · +' + more + ' more' : '')));
      }
      whoBox.appendChild(muted('no per-lane job counts in the board data'));
    } else {
      var tot = view.lanes.reduce(function (a, l) { return a + l.jobs24h; }, 0) || 1;
      for (var li = 0; li < view.lanes.length; li += 1) {
        var lane = view.lanes[li];
        var col = laneColor(lane.name);
        var host = el('span', 'hive-lh');
        host.setAttribute('data-lane', lane.name);
        var state = lane.running > 0 ? 'working' : 'sleeping';
        if (typeof opts.mountHead === 'function') {
          pendingHeads.push({ host: host, spec: { state: state, size: 30, color: col, id: 'lane-' + lane.name, label: lane.name + ' lane, ' + (state === 'working' ? 'working' : 'resting') } });
        }
        host.appendChild(createBubble(state === 'working' ? 'dots' : 'sleep'));
        if (typeof opts.onHeadHover === 'function' && host.addEventListener) { host.addEventListener('mouseenter', function (e) { opts.onHeadHover(e && e.currentTarget); }); }
        whoBox.appendChild(hbar('40px 64px 1fr 44px', [host, el('span', null, lane.name.toLowerCase())], lane.jobs24h / tot, col, String(lane.jobs24h), col));
      }
    }
    all.appendChild(whoBox);
    var t = view.totals;
    var jobs = view.lanes ? view.lanes.reduce(function (a, l) { return a + l.jobs24h; }, 0) : null;
    var allFoot = el('div', 'hive-push hive-kvs');
    allFoot.appendChild(kvRow('tickets in the ledger', numOrNull(t.tickets)));
    allFoot.appendChild(kvRow('tickets left to do', numOrNull(t.remaining)));
    allFoot.appendChild(kvRow('worker jobs in 24 h', jobs));
    allFoot.appendChild(kvRow('held for you', view.needs, 'var(--amber)', 'stats.needsYouCount'));
    all.appendChild(allFoot);

    var led = el('section', 'hive-panel');
    led.setAttribute('aria-labelledby', 'hive-h-led');
    var h3 = sectionHeading('What the ledger shows');
    h3.id = 'hive-h-led';
    led.appendChild(h3);
    var ledBox = el('div', 'hive-led');
    if (t.counted === null || t.counted <= 0) { ledBox.appendChild(muted('no ledger counts yet')); }
    else {
      ledBox.appendChild(hbar('130px 1fr 52px', el('span', null, 'done'), t.done / t.counted, '#2fe0a0', String(t.done), null));
      ledBox.appendChild(hbar('130px 1fr 52px', el('span', null, 'ready to start'), t.ready / t.counted, '#4d7cff', String(t.ready), null));
      ledBox.appendChild(hbar('130px 1fr 52px', el('span', null, 'waiting on others'), t.blocked / t.counted, '#ffb62e', String(t.blocked), null));
      ledBox.appendChild(hbar('130px 1fr 52px', el('span', null, 'in review'), t.review / t.counted, '#ff4d7e', String(t.review), null));
    }
    led.appendChild(ledBox);
    // Step line: completions per hour when the ledger has times, else done per project in ring order.
    var series = view.throughput;
    var stepLabel = 'Completions per hour';
    var stepCap = 'completions per hour, last 24 h';
    if (!series && withPct.length >= 2) {
      series = withPct.map(function (p) { return p.pct; });
      stepLabel = 'Done per project';
      stepCap = 'done per project, %, in ring order';
    }
    if (series) {
      var svg = svgEl('svg');
      svg.setAttribute('class', 'hive-step');
      svg.setAttribute('viewBox', '0 0 300 70');
      svg.setAttribute('preserveAspectRatio', 'none');
      svg.setAttribute('role', 'img');
      svg.setAttribute('aria-label', stepLabel);
      var d = stepPath(series);
      var path = svgEl('path');
      path.setAttribute('d', d);
      svg.appendChild(path);
      var scan = svgEl('path');
      scan.setAttribute('class', 'hive-step-scan');
      scan.setAttribute('d', d);
      scan.setAttribute('pathLength', '1000');
      svg.appendChild(scan);
      led.appendChild(svg);
      led.appendChild(el('div', 'hive-cap', stepCap));
    }
    // The step caption names the list when the line plots done per project; otherwise it gets its own heading.
    if (!series || view.throughput) { led.appendChild(sectionHeading('Done per project', 'hive-h-sub')); }
    led.appendChild(byproj);
    var ledFoot = el('div', 'hive-push hive-kvs');
    ledFoot.appendChild(kvRow('done in 24 h', numOrNull(view.doneLast24h)));
    ledFoot.appendChild(kvRow('open pull requests', view.prs ? view.prs.length : null));
    ledFoot.appendChild(kvRow('spend recorded', view.spend === null ? null : formatUsd(view.spend), null, 'stats.spendUsd'));
    ledFoot.appendChild(kvRow('saved by the swarm', 'not measured yet'));
    led.appendChild(ledFoot);

    root.appendChild(log);
    root.appendChild(all);
    root.appendChild(led);
    // Heads mount after everything is in the page so their off-screen tracking sees real layout.
    for (var pi = 0; pi < pendingHeads.length; pi += 1) {
      var handle = opts.mountHead(pendingHeads[pi].host, pendingHeads[pi].spec);
      if (handle) { heads.push(handle); }
    }
    return { heads: heads };
  }

  return {
    CAT_COLOR: CAT_COLOR,
    CAT_TAG: CAT_TAG,
    agoText: agoText,
    deriveHiveView: deriveHiveView,
    projectView: projectView,
    renderHiveDashboard: renderHiveDashboard,
    renderSessionLog: renderSessionLog,
    renderHourBars: renderHourBars,
    stepPath: stepPath,
    createBubble: createBubble,
    laneColor: laneColor,
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
    laneOfProject: laneOfProject,
    projectStatus: projectStatus,
    projectSignals: projectSignals,
    createProjectBot: createProjectBot,
    deriveNeedsYouItems: deriveNeedsYouItems,
    renderNeedsYou: renderNeedsYou,
    formatUsd: formatUsd,
  };
}));
