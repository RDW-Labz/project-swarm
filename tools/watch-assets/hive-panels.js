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
    laneOfProject: laneOfProject,
    projectStatus: projectStatus,
    projectSignals: projectSignals,
    createProjectBot: createProjectBot,
    deriveNeedsYouItems: deriveNeedsYouItems,
    renderNeedsYou: renderNeedsYou,
    formatUsd: formatUsd,
  };
}));
