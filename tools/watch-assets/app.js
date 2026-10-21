// SPDX-License-Identifier: Apache-2.0
(function () {
  'use strict';

  var params = new URLSearchParams(location.search);
  var TOKEN = params.get('t') || '';
  try {
    if (TOKEN && window.history && history.replaceState) {
      history.replaceState(history.state, '', location.pathname + location.hash);
    }
  } catch (e) {
    if (window.console) console.error('could not clean address bar', e);
  }
  var TAB_NAMES = ['run', 'plan', 'commands', 'gallery'];
  var MAX_PENDING = 50;
  var registry = {};
  var ready = false;
  var data = {
    run: null,
    plan: { present: false },
    gallery: null,
    commands: [],
    contextCommands: []
  };
  var lastSlice = {};
  var applyDeltaFn = null;
  var importFailed = false;
  var needRunFetch = false;
  var streamSnapshotSeen = false;
  var streamLastMessageAt = 0;
  var STREAM_HEARTBEAT_MS = 10000;
  var pendingDeltas = [];
  var drawer = document.getElementById('drawer');
  var lastFocus = null;

  function withToken(path) {
    return path + (path.indexOf('?') < 0 ? '?' : '&') + 't=' + encodeURIComponent(TOKEN);
  }

  function fetchJson(path) {
    return fetch(withToken(path), { cache: 'no-store' }).then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.json();
    });
  }

  function parseEvent(ev) {
    try {
      return JSON.parse(ev.data);
    } catch (e) {
      return undefined;
    }
  }

  function callFn(name, fn) {
    try {
      fn(data);
    } catch (e) {
      if (window.console) console.error('watch tab ' + name + ' failed', e);
    }
  }

  function sliceChanged(name, value) {
    var json = JSON.stringify(value === undefined ? null : value);
    if (lastSlice[name] === json) return false;
    lastSlice[name] = json;
    return true;
  }

  function computeChanged() {
    var runC = sliceChanged('run', data.run);
    var planC = sliceChanged('plan', data.plan);
    var galC = sliceChanged('gallery', data.gallery);
    var cmdA = sliceChanged('commands', data.commands);
    var cmdB = sliceChanged('contextCommands', data.contextCommands);
    return { run: runC, plan: planC, gallery: galC, commands: cmdA || cmdB };
  }

  function renderAll(force) {
    var changed = computeChanged();
    Object.keys(registry).forEach(function (name) {
      if (!force && changed[name] === false) return;
      registry[name].forEach(function (fn) {
        callFn(name, fn);
      });
    });
  }

  function register(name, fn) {
    if (typeof fn !== 'function') return;
    if (!registry[name]) registry[name] = [];
    registry[name].push(fn);
    if (ready) callFn(name, fn);
  }

  function applyResponse(s) {
    if (!s) return;
    var takeRun = !streamSnapshotSeen || importFailed || needRunFetch;
    if (takeRun) {
      data.run = s.run || null;
      needRunFetch = false;
    }
    data.plan = s.plan || { present: false };
    data.gallery = s.gallery || null;
    data.commands = s.commands || [];
    data.contextCommands = s.contextCommands || [];
    renderAll();
  }

  function refreshAll() {
    return fetchJson('/api/snapshot')
      .then(function (s) {
        applyResponse(s);
      })
      .catch(function (err) {
        if (window.console) console.error('watch refresh failed', err);
      });
  }

  function setConnection(state) {
    var status = document.getElementById('status');
    if (!status) return;
    var ok = state === true || state === 'live';
    if (ok) {
      if (status.getAttribute('data-conn')) {
        status.removeAttribute('data-conn');
        renderAll(true);
      }
    } else {
      status.setAttribute('data-conn', 'lost');
      status.textContent = state === 'connecting' ? 'connecting' : 'connection lost';
    }
  }

  function streamStatus() {
    if (window.BoardLib && window.BoardLib.streamState) {
      return window.BoardLib.streamState({ lastMessageAt: streamLastMessageAt, now: Date.now(), heartbeatMs: STREAM_HEARTBEAT_MS });
    }
    if (!streamLastMessageAt || Date.now() - streamLastMessageAt > STREAM_HEARTBEAT_MS * 2) return { state: 'connecting' };
    return { state: 'live' };
  }

  function updateStreamConnection() {
    setConnection(streamStatus().state);
  }

  function noteStreamMessage() {
    streamLastMessageAt = Date.now();
    updateStreamConnection();
  }

  function flushDeltas() {
    while (pendingDeltas.length) {
      var d = pendingDeltas.shift();
      data.run = applyDeltaFn(data.run, d);
    }
    renderAll();
  }

  function queueDelta(d) {
    if (pendingDeltas.length >= MAX_PENDING) {
      pendingDeltas = [];
      needRunFetch = true;
    }
    pendingDeltas.push(d);
  }

  function applyDeltaEvent(d) {
    if (d === undefined) return;
    if (importFailed) {
      needRunFetch = true;
      return;
    }
    if (!applyDeltaFn) {
      queueDelta(d);
      return;
    }
    data.run = applyDeltaFn(data.run, d);
    renderAll();
  }

  function openStream() {
    if (!window.EventSource) {
      setConnection('connecting');
      return;
    }
    var es = new EventSource(withToken('/events'));
    es.addEventListener('snapshot', function (ev) {
      noteStreamMessage();
      var run = parseEvent(ev);
      if (run === undefined) return;
      streamSnapshotSeen = true;
      data.run = run;
      renderAll();
    });
    es.addEventListener('delta', function (ev) {
      noteStreamMessage();
      applyDeltaEvent(parseEvent(ev));
    });
    es.addEventListener('ping', function () {
      noteStreamMessage();
    });
    es.onopen = function () {
      streamLastMessageAt = Date.now();
      updateStreamConnection();
    };
    es.onerror = function () {
      updateStreamConnection();
    };
  }

  function showTab(name) {
    var buttons = document.querySelectorAll('#tabs button[data-tab]');
    Array.prototype.forEach.call(buttons, function (btn) {
      var on = btn.getAttribute('data-tab') === name;
      btn.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    TAB_NAMES.forEach(function (tab) {
      var pane = document.getElementById('pane-' + tab);
      if (pane) pane.hidden = tab !== name;
    });
  }

  function currentTabFromHash() {
    var name = location.hash.slice(1);
    return TAB_NAMES.indexOf(name) >= 0 ? name : 'run';
  }

  function selectTab(name) {
    if (TAB_NAMES.indexOf(name) < 0) return;
    showTab(name);
    if (location.hash !== '#' + name) location.hash = name;
  }

  function wireTabs() {
    var buttons = document.querySelectorAll('#tabs button[data-tab]');
    Array.prototype.forEach.call(buttons, function (btn) {
      btn.addEventListener('click', function () {
        selectTab(btn.getAttribute('data-tab'));
      });
    });
    window.addEventListener('hashchange', function () {
      showTab(currentTabFromHash());
    });
    showTab(currentTabFromHash());
  }

  function drawerParts() {
    if (!drawer) return null;
    var title = drawer.querySelector('[data-drawer-title]');
    var body = drawer.querySelector('[data-drawer-body]');
    if (!body) {
      body = document.createElement('div');
      body.setAttribute('data-drawer-body', '');
      drawer.appendChild(body);
    }
    return { title: title, body: body };
  }

  function openDrawer(titleText, node) {
    var parts = drawerParts();
    if (!parts) return;
    lastFocus = document.activeElement;
    if (parts.title) parts.title.textContent = titleText == null ? '' : String(titleText);
    while (parts.body.firstChild) parts.body.removeChild(parts.body.firstChild);
    if (node) parts.body.appendChild(node);
    drawer.hidden = false;
    drawer.setAttribute('aria-hidden', 'false');
    var closeBtn = drawer.querySelector('[data-drawer-close]') || drawer.querySelector('button');
    if (closeBtn && closeBtn.focus) closeBtn.focus();
  }

  function closeDrawer() {
    if (!drawer) return;
    drawer.hidden = true;
    drawer.setAttribute('aria-hidden', 'true');
    if (lastFocus && lastFocus.focus) lastFocus.focus();
    lastFocus = null;
  }

  function wireDrawer() {
    if (!drawer) return;
    var closeBtn = drawer.querySelector('[data-drawer-close]') || drawer.querySelector('button');
    if (closeBtn) closeBtn.addEventListener('click', closeDrawer);
    document.addEventListener('keydown', function (ev) {
      if (ev.key === 'Escape' && !drawer.hidden) closeDrawer();
    });
  }

  function copyText(text) {
    var value = text == null ? '' : String(text);
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(value);
    }
    var area = document.createElement('textarea');
    area.value = value;
    area.setAttribute('readonly', '');
    document.body.appendChild(area);
    area.select();
    try {
      document.execCommand('copy');
    } catch (e) {
      if (window.console) console.error('copy failed', e);
    }
    document.body.removeChild(area);
    return Promise.resolve();
  }

  window.SwarmWatch = {
    register: register,
    data: data,
    token: TOKEN,
    openDrawer: openDrawer,
    closeDrawer: closeDrawer,
    copyText: copyText,
    refresh: refreshAll
  };

  wireTabs();
  wireDrawer();

  import('/assets/watch-delta.mjs')
    .then(function (mod) {
      applyDeltaFn = mod.applyDelta;
      flushDeltas();
    })
    .catch(function (err) {
      importFailed = true;
      pendingDeltas = [];
      needRunFetch = true;
      if (window.console) console.error('watch-delta load failed', err);
    });

  fetchJson('/api/snapshot')
    .then(function (s) {
      applyResponse(s);
      ready = true;
    })
    .catch(function (err) {
      ready = true;
      if (window.console) console.error('watch snapshot failed', err);
    });

  openStream();
  setInterval(refreshAll, 5000);
  setInterval(updateStreamConnection, 1000);
})();
