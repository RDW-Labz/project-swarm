// SPDX-License-Identifier: Apache-2.0
// Command Center shell renderer for /command-center (uses CommandCenterData snapshot shape).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) { module.exports = factory(); }
  else if (root) { root.CommandCenter = factory(); }
}(typeof self !== 'undefined' ? self : typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var STAT_KEYS = ['projectsTotal', 'agentsLive', 'needsYouCount', 'spendUsd'];

  function clearHost(host) {
    if (!host) { return; }
    if (typeof host.replaceChildren === 'function') {
      host.replaceChildren();
      return;
    }
    if (host.children && typeof host.removeChild === 'function') {
      while (host.children.length) {
        host.removeChild(host.children[0]);
      }
      return;
    }
    host.textContent = '';
  }

  function appendStatRow(statsHost, key, stat) {
    var row = document.createElement('div');
    row.className = 'command-center-stat';
    row.setAttribute('data-stat-key', key);

    var labelEl = document.createElement('span');
    labelEl.className = 'command-center-stat-label';
    labelEl.textContent = stat.label;

    var valueEl = document.createElement('span');
    valueEl.className = 'command-center-stat-value';
    valueEl.textContent = String(stat.value);

    var unitEl = document.createElement('span');
    unitEl.className = 'command-center-stat-unit';
    unitEl.textContent = stat.unit;

    row.appendChild(labelEl);
    row.appendChild(valueEl);
    row.appendChild(unitEl);
    statsHost.appendChild(row);
  }

  function renderCommandCenter(host, data) {
    if (!host) {
      throw new Error('Command Center render requires a host element');
    }
    clearHost(host);

    var snapshot = data && typeof data === 'object' ? data : {};
    var stats = snapshot.stats && typeof snapshot.stats === 'object' ? snapshot.stats : {};

    var shell = document.createElement('div');
    shell.className = 'command-center';
    shell.setAttribute('data-command-center-shell', 'true');

    if (typeof snapshot.at === 'string' && snapshot.at.length) {
      var atEl = document.createElement('time');
      atEl.className = 'command-center-at';
      atEl.setAttribute('datetime', snapshot.at);
      atEl.textContent = snapshot.at;
      shell.appendChild(atEl);
    }

    var statsHost = document.createElement('div');
    statsHost.className = 'command-center-stats';
    statsHost.setAttribute('role', 'group');
    statsHost.setAttribute('aria-label', 'Command Center stats');

    for (var i = 0; i < STAT_KEYS.length; i += 1) {
      var key = STAT_KEYS[i];
      if (!Object.prototype.hasOwnProperty.call(stats, key)) { continue; }
      var stat = stats[key];
      if (!stat || typeof stat.value !== 'number') { continue; }
      appendStatRow(statsHost, key, stat);
    }

    shell.appendChild(statsHost);
    host.appendChild(shell);
  }

  return {
    renderCommandCenter: renderCommandCenter,
  };
}));
