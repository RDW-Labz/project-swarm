// SPDX-License-Identifier: Apache-2.0
// Shared Command Center snapshot fetch + parse for Hive and Project Cockpit (no DOM).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) { module.exports = factory(); }
  else if (root) { root.CommandCenterData = factory(); }
}(typeof self !== 'undefined' ? self : typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var STAT_KEYS = ['projectsTotal', 'agentsLive', 'needsYouCount', 'spendUsd'];
  var PROJECT_NUMBER_KEYS = ['liveAgents', 'needsYou', 'spendUsd'];

  function isTrustedLabelledNumber(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) { return false; }
    if (typeof raw.label !== 'string' || !raw.label.length) { return false; }
    if (typeof raw.value !== 'number' || !Number.isFinite(raw.value) || raw.value < 0) { return false; }
    if (raw.unit !== 'count' && raw.unit !== 'usd') { return false; }
    if (typeof raw.source !== 'string' || !raw.source.length) { return false; }
    if (typeof raw.explanation !== 'string' || !raw.explanation.length) { return false; }
    return true;
  }

  function copyLabelledNumber(raw) {
    return {
      label: raw.label,
      value: raw.value,
      unit: raw.unit,
      source: raw.source,
      explanation: raw.explanation,
    };
  }

  function parseStats(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error('Command Center snapshot stats must be an object');
    }
    var stats = {};
    for (var i = 0; i < STAT_KEYS.length; i += 1) {
      var key = STAT_KEYS[i];
      if (!Object.prototype.hasOwnProperty.call(raw, key)) { continue; }
      var value = raw[key];
      if (value === undefined || value === null) { continue; }
      if (!isTrustedLabelledNumber(value)) { continue; }
      stats[key] = copyLabelledNumber(value);
    }
    return stats;
  }

  function parseProjectCard(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error('Command Center project entry must be an object');
    }
    if (typeof raw.id !== 'string' || !raw.id.length) {
      throw new Error('Command Center project entry is missing id');
    }
    var name = raw.name;
    if (name !== null && name !== undefined && typeof name !== 'string') {
      throw new Error('Command Center project name must be a string or null');
    }
    var card = { id: raw.id, name: name === undefined ? null : name };
    for (var i = 0; i < PROJECT_NUMBER_KEYS.length; i += 1) {
      var key = PROJECT_NUMBER_KEYS[i];
      if (!Object.prototype.hasOwnProperty.call(raw, key)) { continue; }
      var value = raw[key];
      if (value === undefined || value === null) { continue; }
      if (!isTrustedLabelledNumber(value)) { continue; }
      card[key] = copyLabelledNumber(value);
    }
    return card;
  }

  function parseCommandCenterSnapshot(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new Error('Command Center snapshot must be a JSON object');
    }
    if (typeof body.at !== 'string' || !body.at.length || Number.isNaN(Date.parse(body.at))) {
      throw new Error('Command Center snapshot is missing a valid at timestamp');
    }
    if (!Array.isArray(body.projects)) {
      throw new Error('Command Center snapshot projects must be an array');
    }
    var projects = [];
    for (var i = 0; i < body.projects.length; i += 1) {
      projects.push(parseProjectCard(body.projects[i]));
    }
    return {
      at: body.at,
      stats: parseStats(body.stats),
      projects: projects,
    };
  }

  function deriveCommandCenterSharedStats(snapshot) {
    if (!snapshot || typeof snapshot !== 'object') {
      throw new Error('Command Center shared stats require a parsed snapshot');
    }
    var stats = snapshot.stats && typeof snapshot.stats === 'object' ? snapshot.stats : {};
    var out = {
      projects: Array.isArray(snapshot.projects) ? snapshot.projects : [],
    };
    if (stats.projectsTotal) { out.projectsTotal = stats.projectsTotal; }
    if (stats.agentsLive) { out.agentsLive = stats.agentsLive; }
    if (stats.needsYouCount) { out.needsYouCount = stats.needsYouCount; }
    return out;
  }

  function snapshotRequestUrl(baseUrl, local) {
    var path = '/api/command-center/snapshot';
    var query = local ? 'local=1' : '';
    var fullPath = query ? path + '?' + query : path;
    var base = baseUrl == null ? '' : String(baseUrl);
    if (!base) { return fullPath; }
    try {
      return new URL(fullPath, base.endsWith('/') ? base : base + '/').href;
    } catch (e) {
      return base.replace(/\/$/, '') + fullPath;
    }
  }

  function fetchCommandCenterSnapshot(options) {
    var opts = options || {};
    var fetchImpl = opts.fetchImpl;
    if (typeof fetchImpl !== 'function') {
      if (typeof fetch === 'function') { fetchImpl = fetch; }
      else { return Promise.reject(new Error('Command Center snapshot fetch requires fetchImpl')); }
    }
    var token = opts.token == null ? '' : String(opts.token);
    var url = snapshotRequestUrl(opts.baseUrl, opts.local);
    return fetchImpl(url, {
      method: 'GET',
      cache: 'no-store',
      headers: { 'x-watch-token': token },
    }).then(function (res) {
      if (!res || !res.ok) {
        var status = res && typeof res.status === 'number' ? res.status : 'unknown';
        throw new Error('Command Center snapshot request failed: HTTP ' + status);
      }
      return res.json().then(function (body) {
        return parseCommandCenterSnapshot(body);
      }, function () {
        throw new Error('Command Center snapshot response was not valid JSON');
      });
    });
  }

  return {
    fetchCommandCenterSnapshot: fetchCommandCenterSnapshot,
    parseCommandCenterSnapshot: parseCommandCenterSnapshot,
    deriveCommandCenterSharedStats: deriveCommandCenterSharedStats,
    isTrustedLabelledNumber: isTrustedLabelledNumber,
  };
}));
