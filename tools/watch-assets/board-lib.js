// SPDX-License-Identifier: Apache-2.0
// Pure helpers for the board pages (no DOM). The same file runs in the browser (window.BoardLib) and in the tests (require).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) { module.exports = factory(); } else { root.BoardLib = factory(); }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  var LANE_COLORS = { Haiku: '#34d399', Sonnet: '#60a5fa', Opus: '#fbbf24', Codex: '#f472b6', Cursor: '#a3e635', GPU: '#fb923c', Claude: '#94a3b8' };
  var KNOWN_LANES = ['Haiku', 'Sonnet', 'Opus', 'Codex', 'Cursor', 'GPU'];
  var LIVE_MS = 6000;

  function laneColor(label) { return Object.prototype.hasOwnProperty.call(LANE_COLORS, label) ? LANE_COLORS[label] : '#94a3b8'; }
  // Did anything the page shows change? (A page that rebuilds itself on every poll loses the keyboard focus of whatever was focused.)
  function signature(value, minute) { return JSON.stringify(value) + '|' + minute; }
  function itemKey(item) { return String(item.projectId) + '|' + String(item.kind) + '|' + String(item.id); }

  // Which Needs-you items the person has not seen yet. `seen` is a list of keys; an item that is no longer waiting is simply not in the result.
  function unread(items, seen) {
    var known = Object.create(null);
    (seen || []).forEach(function (k) { known[k] = true; });
    return (items || []).map(itemKey).filter(function (k) { return !known[k]; });
  }
  // Remember keys as seen, newest last, never more than `cap` (old keys fall off the front).
  function remember(seen, keys, cap) {
    var out = (seen || []).slice();
    keys.forEach(function (k) { if (out.indexOf(k) === -1) { out.push(k); } });
    return out.slice(Math.max(0, out.length - (cap || 500)));
  }

  // "Live" only while the last answer from the server is recent; otherwise stale, with the time of the last good answer.
  function liveness(lastOkMs, nowMs) {
    if (!isFinite(lastOkMs) || lastOkMs <= 0) { return { state: 'stale', ageS: null }; }
    var age = Math.max(0, nowMs - lastOkMs);
    return { state: age <= LIVE_MS ? 'live' : 'stale', ageS: Math.round(age / 1000) };
  }

  // "in 12 min", "in 2 h 5 min", "now" (the time has passed).
  function countdown(untilIso, nowMs) {
    var t = Date.parse(untilIso);
    if (!isFinite(t)) { return ''; }
    var s = Math.round((t - nowMs) / 1000);
    if (s <= 0) { return 'now'; }
    if (s < 90) { return 'in ' + s + ' s'; }
    var m = Math.round(s / 60);
    if (m < 90) { return 'in ' + m + ' min'; }
    var h = Math.floor(m / 60);
    return 'in ' + h + ' h' + (m % 60 ? ' ' + (m % 60) + ' min' : '');
  }

  function duration(ms) {
    if (typeof ms !== 'number' || !isFinite(ms) || ms < 0) { return '-'; }
    var s = Math.round(ms / 1000);
    if (s < 60) { return s + ' s'; }
    var m = Math.floor(s / 60);
    if (m < 60) { return m + ' min ' + (s % 60) + ' s'; }
    return Math.floor(m / 60) + ' h ' + (m % 60) + ' min';
  }

  // One bay per lane: the agents really running (or just failed) in it, and an idle flag when there are none. No agent is ever invented:
  // an idle bay shows a sleeping head, which means exactly "no agent is running in this lane".
  function bays(list, extraLanes) {
    var by = Object.create(null);   // keyed by lane names from run files: no prototype, so a lane called __proto__ is just a name
    (list || []).forEach(function (a) { (by[a.lane] = by[a.lane] || []).push(a); });
    var names = KNOWN_LANES.slice();
    Object.keys(by).concat(extraLanes || []).forEach(function (n) { if (names.indexOf(n) === -1) { names.push(n); } });
    return names.map(function (lane) { var agents = by[lane] || []; return { lane: lane, agents: agents, running: agents.filter(function (a) { return a.state !== 'error'; }).length, idle: agents.length === 0 }; });
  }

  // Location hash: "#tab=cost" or "#run=PROJECT/RUN". Anything else is ignored.
  var TABS = ['overview', 'cost', 'agents', 'events'];
  function parseHash(hash) {
    var h = String(hash || '').replace(/^#/, '');
    var m;
    if ((m = /^tab=([a-z]+)$/.exec(h)) && TABS.indexOf(m[1]) !== -1) { return { tab: m[1] }; }
    if ((m = /^run=([A-Za-z0-9._-]{1,121})\/([A-Za-z0-9][A-Za-z0-9._-]{0,120})$/.exec(h))) { return { run: { projectId: m[1], runId: m[2] } }; }
    return {};
  }

  // Positions for the job graph: a column per layer, jobs stacked in a column, an edge from each job it waits for.
  function layoutGraph(jobs, opts) {
    var o = opts || {};
    var w = o.nodeW || 210, h = o.nodeH || 44, gx = o.gapX || 56, gy = o.gapY || 14;
    var cols = Object.create(null);
    var pos = Object.create(null);
    jobs.forEach(function (j) { var c = cols[j.layer] = cols[j.layer] || []; c.push(j); });
    Object.keys(cols).forEach(function (layer) { cols[layer].forEach(function (j, i) { pos[j.id] = { x: Number(layer) * (w + gx), y: i * (h + gy), w: w, h: h }; }); });
    var edges = [];
    jobs.forEach(function (j) { (j.after || []).forEach(function (d) { if (pos[d] && pos[j.id]) { edges.push({ from: d, to: j.id }); } }); });
    var width = 0, height = 0;
    Object.keys(pos).forEach(function (k) { width = Math.max(width, pos[k].x + w); height = Math.max(height, pos[k].y + h); });
    return { pos: pos, edges: edges, width: width, height: height };
  }

  // The journal up to position `n` (0 = nothing yet): what has happened, the job each event is about, and the spend so far (cost counted when a job ends).
  function replay(journal, n) {
    var spent = 0, running = {}, done = 0;
    for (var i = 0; i < Math.min(n, journal.length); i += 1) {
      var e = journal[i];
      if (e.event === 'started') { running[e.job] = true; }
      else if (e.event !== 'queued') { delete running[e.job]; done += 1; spent += typeof e.usd === 'number' ? e.usd : 0; }
    }
    return { spentUsd: Math.round(spent * 1e6) / 1e6, running: Object.keys(running).length, ended: done };
  }

  // One reading of "how many agents are live" for every page, and the worker slots that are held without a running job to show for them.
  function agentCounts(m) { var held = m.workers && isFinite(m.workers.total) ? m.workers.total : 0; return { live: m.agents.total, held: held, unshown: Math.max(0, held - m.agents.total) }; }
  function slotsText(m) { var c = agentCounts(m); return c.unshown ? c.unshown + ' worker slot' + (c.unshown === 1 ? ' is' : 's are') + ' held (' + c.held + ' held, ' + c.live + ' agent' + (c.live === 1 ? '' : 's') + ' running): a run is between jobs or has not reported its running job yet.' : ''; }

  return { agentCounts: agentCounts, slotsText: slotsText, signature: signature, laneColor: laneColor, itemKey: itemKey, unread: unread, remember: remember, liveness: liveness, countdown: countdown, duration: duration, bays: bays, parseHash: parseHash, layoutGraph: layoutGraph, replay: replay, KNOWN_LANES: KNOWN_LANES, TABS: TABS, LIVE_MS: LIVE_MS };
}));
