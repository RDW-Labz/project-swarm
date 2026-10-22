// SPDX-License-Identifier: Apache-2.0
// Pure helpers for the board pages (no DOM). The same file runs in the browser (window.BoardLib) and in the tests (require).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) { module.exports = factory(); } else { root.BoardLib = factory(); }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  var host = typeof self !== 'undefined' ? self : (typeof window !== 'undefined' ? window : {});
  var LANE_COLORS = { Orchestrator: '#c084fc', Haiku: '#34d399', Sonnet: '#60a5fa', Opus: '#fbbf24', Codex: '#f472b6', Cursor: '#a3e635', GPU: '#fb923c', Claude: '#94a3b8' };
  var KNOWN_LANES = ['Haiku', 'Sonnet', 'Opus', 'Codex', 'Cursor', 'GPU'];
  var LIVE_MS = 6000;
  var TOKEN_KEY = 'swarm-watch-token';
  var tokenRead = false;
  var tokenValue = '';

  function watchToken() {
    if (tokenRead) { return tokenValue; }
    tokenRead = true;
    var params = null;
    var hasQueryToken = false;
    var queryToken = '';
    var cleanSearch = '';
    try {
      params = new URLSearchParams((host.location && host.location.search) || '');
      hasQueryToken = params.has('t');
      queryToken = params.get('t') || '';
      params.delete('t');
      cleanSearch = params.toString();
    } catch (e) {
      var raw = String((host.location && host.location.search) || '').replace(/^\?/, '');
      var kept = [];
      raw.split('&').forEach(function (part) {
        if (!part) { return; }
        var pieces = part.split('='), key = pieces.shift().replace(/\+/g, ' '), value = pieces.join('=').replace(/\+/g, ' ');
        try { key = decodeURIComponent(key); value = decodeURIComponent(value); } catch (ignore) { return; }
        if (key === 't') { if (!hasQueryToken) { queryToken = value; } hasQueryToken = true; }
        else { kept.push(part); }
      });
      cleanSearch = kept.join('&');
    }
    var stored = '';
    try {
      if (hasQueryToken) { host.sessionStorage.setItem(TOKEN_KEY, queryToken); }
      stored = host.sessionStorage.getItem(TOKEN_KEY) || '';
    } catch (e) { /* private browsing can disable session storage */ }
    tokenValue = stored || queryToken;
    if (hasQueryToken && params && host.history && typeof host.history.replaceState === 'function') {
      try {
        host.history.replaceState(host.history.state, '', (host.location.pathname || '/') + (cleanSearch ? '?' + cleanSearch : '') + (host.location.hash || ''));
      } catch (e) { /* the token remains in the current address only if history is unavailable */ }
    } else if (hasQueryToken && host.history && typeof host.history.replaceState === 'function') {
      try {
        host.history.replaceState(host.history.state, '', (host.location.pathname || '/') + (cleanSearch ? '?' + cleanSearch : '') + (host.location.hash || ''));
      } catch (e) { /* the token remains in the current address only if history is unavailable */ }
    }
    return tokenValue;
  }

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

  // The project chip belongs to the page that owns both project reads. It only says
  // connecting before the first good answer, then allows two polling intervals before
  // saying connecting again. An optional slack keeps callers with a request timeout
  // from declaring a read unavailable while that timeout is still in flight.
  function chipState(options) {
    var o = options || {};
    var nowMs = Number(o.now);
    var lastOkMs = Number(o.lastOkAt);
    var pollMs = Number(o.pollMs);
    var slackMs = Number(o.slackMs);
    if (!isFinite(nowMs)) { nowMs = Date.now(); }
    if (!isFinite(pollMs) || pollMs < 0) { pollMs = 0; }
    if (!isFinite(slackMs) || slackMs < 0) { slackMs = 0; }
    if (o.everOk !== true) { return { state: 'connecting', ageS: null }; }
    var age = Math.max(0, nowMs - (isFinite(lastOkMs) ? lastOkMs : nowMs));
    return { state: age > (pollMs * 2 + slackMs) ? 'connecting' : 'live', ageS: Math.round(age / 1000) };
  }

  // EventSource exposes named events but not SSE comment lines. Treat any message or
  // named ping as proof of a healthy stream until two heartbeat intervals pass.
  function streamState(options) {
    var o = options || {};
    var nowMs = Number(o.now);
    var lastMessageMs = Number(o.lastMessageAt);
    var heartbeatMs = Number(o.heartbeatMs);
    var slackMs = Number(o.slackMs);
    if (!isFinite(nowMs)) { nowMs = Date.now(); }
    if (!isFinite(heartbeatMs) || heartbeatMs < 0) { heartbeatMs = 0; }
    if (!isFinite(slackMs) || slackMs < 0) { slackMs = 0; }
    if (!isFinite(lastMessageMs) || lastMessageMs <= 0) { return { state: 'connecting', ageMs: null, ageS: null }; }
    var age = Math.max(0, nowMs - lastMessageMs);
    return { state: age > (heartbeatMs * 2 + slackMs) ? 'connecting' : 'live', ageMs: age, ageS: Math.round(age / 1000) };
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

  // ---- watch project card (board cards and project overview) -----------------------------------------------
  function wcDoc() {
    if (host && host.document) { return host.document; }
    if (typeof document !== 'undefined') { return document; }
    return null;
  }
  function wcEl(tag, cls, text) {
    var doc = wcDoc();
    if (!doc) { return null; }
    var n = doc.createElement(tag);
    if (cls) { n.className = cls; }
    if (text !== undefined && text !== null) { n.textContent = text; }
    return n;
  }
  function wcMeter(pct, hot) {
    var m = wcEl('div', 'meter' + (hot ? ' hot' : ''));
    var i = wcEl('i');
    if (i) { i.style.width = Math.max(0, Math.min(100, pct)) + '%'; m.appendChild(i); }
    m.setAttribute('role', 'img');
    m.setAttribute('aria-label', Math.round(pct) + ' percent');
    return m;
  }
  function wcAgo(iso) {
    var t = Date.parse(iso);
    if (!isFinite(t)) { return 'never'; }
    var m = Math.max(0, Math.round((Date.now() - t) / 60000));
    return m < 1 ? 'just now' : m < 60 ? m + ' min ago' : m < 2880 ? Math.round(m / 60) + ' h ago' : Math.round(m / 1440) + ' d ago';
  }
  function wcProjectHref(projectId) { return '/project?id=' + encodeURIComponent(projectId); }
  function wcLink(href, cls, parts) {
    var a = wcEl('a', cls);
    if (!a) { return null; }
    a.href = href;
    (parts || []).forEach(function (p) { if (p) { a.appendChild(p); } });
    return a;
  }
  function wcPill(text, cls) { return wcEl('span', 'pill ' + (cls || 'info'), text); }
  function percentBoard(p) {
    var progress = p.progress || {};
    var board = progress.percent && progress.percent.board ? progress.percent.board : {};
    var done = typeof board.done === 'number' ? board.done : null;
    var total = typeof board.total === 'number' ? board.total : null;
    var pct = typeof progress.overall === 'number' ? progress.overall : (typeof board.pct === 'number' ? board.pct : 0);
    return { pct: pct, done: done, total: total };
  }
  function slotsSentence(card) {
    var slots = card && card.slots ? card.slots : {};
    var max = slots.machineMax;
    var inUse = slots.inUse || 0;
    if (max === null || max === undefined) { return { text: 'Machine slots unknown.', title: 'No machine concurrency limit is configured.' }; }
    var free = Math.max(0, max - inUse);
    var other = slots.byOtherProjects || 0;
    if (free === 0) {
      return {
        text: 'Waiting for a free slot: all ' + max + ' machine slots are in use (' + other + ' by other projects).',
        title: 'Every machine slot is claimed. ' + other + ' slot' + (other === 1 ? '' : 's') + ' belong to other projects.',
        full: true,
      };
    }
    return {
      text: free + ' of ' + max + ' machine slots free.',
      title: free + ' free machine slot' + (free === 1 ? '' : 's') + ' out of ' + max + ' (' + inUse + ' in use).',
      full: false,
    };
  }
  function watchNum(value, label, title) {
    var wrap = wcEl('span', 'watch-num-wrap');
    wrap.appendChild(wcEl('span', 'watch-num-label', label));
    var n = wcEl('span', 'watch-num', String(value));
    n.title = title;
    wrap.appendChild(n);
    return wrap;
  }
  function copyCommandButton(cmd) {
    var btn = wcEl('button', 'copy', 'Copy');
    btn.type = 'button';
    btn.addEventListener('click', function () {
      var later = (typeof globalThis !== 'undefined' && globalThis.setTimeout)
        ? globalThis.setTimeout.bind(globalThis)
        : (typeof setTimeout !== 'undefined' ? setTimeout : function (fn) { fn(); });
      function done() { btn.textContent = 'Copied'; later(function () { btn.textContent = 'Copy'; }, 1500); }
      try {
        if (host.navigator && host.navigator.clipboard && host.navigator.clipboard.writeText) {
          host.navigator.clipboard.writeText(cmd).then(done, function () { btn.textContent = 'Select it'; });
        } else { btn.textContent = 'Select it'; }
      } catch (e) { btn.textContent = 'Select it'; }
    });
    return btn;
  }
  function toggleCardList(btn, list) {
    var open = false;
    btn.addEventListener('click', function () {
      open = !open;
      list.hidden = !open;
      btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
  }
  function cardItemList(items) {
    var list = wcEl('div', 'watch-card-list');
    list.hidden = true;
    (items || []).forEach(function (item) {
      var row = wcEl('div', 'watch-card-list-item');
      row.appendChild(wcEl('span', 'mono watch-card-list-id', item.id || ''));
      row.appendChild(wcEl('span', 'watch-card-list-title', item.title || ''));
      if (item.command) {
        var cmdRow = wcEl('div', 'watch-card-list-cmd');
        cmdRow.appendChild(wcEl('code', 'mono', item.command));
        cmdRow.appendChild(copyCommandButton(item.command));
        row.appendChild(cmdRow);
      } else {
        row.appendChild(wcEl('span', 'sub', 'none'));
      }
      list.appendChild(row);
    });
    if (!list.childNodes.length) { list.appendChild(wcEl('div', 'sub', 'none')); }
    return list;
  }
  function wcProjectName(p, label, options) {
    var opts = options || {};
    var text = wcEl('span', '', label);
    if (opts.pageMode) { return text; }
    return wcLink(wcProjectHref(p.id), 'name board-link', [text]);
  }
  function renderWatchProjectCard(p, host, options) {
    var opts = options || {};
    var card = p.card || {};
    var finished = Boolean(p.progress && p.progress.finished);
    host.className = 'pcard watch-project-card' + (finished ? ' watch-project-card-finished' : '') + (opts.worktree ? ' watch-project-card-wt' : '') + (opts.pageMode ? ' watch-project-page-card' : '');
    host.textContent = '';
    var head = wcEl('div', 'watch-card-head');
    var titleRow = wcEl('div', 'watch-card-title-row');
    var nameLabel = (opts.worktree ? '↳ ' : '') + p.name;
    titleRow.appendChild(typeof opts.nameRenderer === 'function' ? opts.nameRenderer(p, nameLabel) : wcProjectName(p, nameLabel, opts));
    if (p.testOrTemp) { titleRow.appendChild(wcEl('span', '', ' ')); titleRow.appendChild(wcPill('test', 'warn')); }
    if (p.pinnedVersion) { titleRow.appendChild(wcEl('span', '', ' ')); titleRow.appendChild(wcPill('pinned at ' + p.pinnedVersion, 'info')); }
    head.appendChild(titleRow);
    var machine = wcEl('span', 'watch-card-machine', p.machine || '-');
    machine.title = 'The machine that hosts this project checkout.';
    head.appendChild(machine);
    var ver = wcEl('span', 'watch-card-version', 'swarm ' + (p.version || '-'));
    ver.title = 'The swarm version installed on this machine right now.';
    head.appendChild(ver);
    if (p.activity) {
      var act = wcEl('span', 'watch-card-activity watch-card-activity-' + p.activity, p.activity);
      act.title = 'Project activity: ' + p.activity.replace('-', ' ');
      head.appendChild(act);
    }
    host.appendChild(head);
    if (finished) {
      host.appendChild(wcEl('div', 'watch-card-finished-label', 'Finished'));
      if (p.progress && p.progress.headline) {
        var fin = wcEl('div', 'watch-card-finished-detail', p.progress.headline);
        fin.title = 'Last release or merge milestone for this project.';
        host.appendChild(fin);
      }
      return host;
    }
    var boardPct = percentBoard(p);
    var big = wcEl('div', 'watch-card-big');
    var pctTitle = boardPct.done !== null && boardPct.total !== null
      ? 'Tickets done divided by all tickets in the approved scope: ' + boardPct.done + ' of ' + boardPct.total + '. The project page shows the same number.'
      : 'Tickets done divided by all tickets in the approved scope. The project page shows the same number.';
    big.appendChild(wcEl('span', 'watch-num-label', 'percent done'));
    var pctNum = wcEl('span', 'watch-card-pct watch-num num', String(boardPct.pct));
    pctNum.title = pctTitle;
    big.appendChild(pctNum);
    big.appendChild(wcEl('span', 'watch-card-pct-suffix', '%'));
    var bar = wcMeter(boardPct.pct);
    bar.title = pctTitle;
    big.appendChild(bar);
    var doneLab = wcEl('span', 'watch-card-done-label', 'done');
    doneLab.title = pctTitle;
    big.appendChild(doneLab);
    host.appendChild(big);
    var rows = wcEl('div', 'watch-card-rows');
    function row(label, valueNode) {
      var r = wcEl('div', 'watch-card-row');
      r.appendChild(wcEl('span', 'watch-card-row-label', label));
      var val = wcEl('div', 'watch-card-row-value');
      val.appendChild(valueNode);
      r.appendChild(val);
      rows.appendChild(r);
    }
    var now = card.now || {};
    var building = now.buildingTickets || 0;
    var checkoutsB = now.checkoutsBuilding || 0;
    var lastFin = now.lastTicketFinishedAt;
    var agoSpan = wcEl('span', 'watch-card-ago', wcAgo(lastFin));
    agoSpan.title = 'The most recent ticket marked done, from the ticket ledger.';
    var nowText = wcEl('span', 'watch-card-now-text');
    if (building > 0) {
      nowText.appendChild(watchNum(building, 'building tickets ', String(building) + ' tickets are running across the project family.'));
      nowText.appendChild(wcEl('span', '', ' tickets building on '));
      nowText.appendChild(watchNum(checkoutsB, 'checkouts building ', String(checkoutsB) + ' checkouts have a live run.'));
      nowText.appendChild(wcEl('span', '', ' checkouts. Last ticket finished '));
    } else {
      nowText.appendChild(wcEl('span', '', 'Nothing building. Last ticket finished '));
    }
    nowText.appendChild(agoSpan);
    nowText.appendChild(wcEl('span', '', '.'));
    row('Now', nowText);
    var next = card.next || {};
    var ready = next.ready || 0;
    var nextVal = wcEl('div', 'watch-card-next');
    var readyBtn = wcEl('button', 'watch-card-toggle', String(ready));
    readyBtn.type = 'button';
    readyBtn.title = ready + ' ticket' + (ready === 1 ? '' : 's') + ' ready to start.';
    readyBtn.setAttribute('aria-label', 'Show ready tickets');
    var readyList = cardItemList(next.items);
    toggleCardList(readyBtn, readyList);
    var readyBtnWrap = wcEl('span', 'watch-num-wrap');
    readyBtnWrap.appendChild(wcEl('span', 'watch-num-label', 'ready tickets'));
    readyBtnWrap.appendChild(readyBtn);
    nextVal.appendChild(readyBtnWrap);
    nextVal.appendChild(wcEl('span', '', ' tickets ready to start. '));
    var slotLine = slotsSentence(card);
    var slotSpan = wcEl('span', 'watch-card-slots', slotLine.text);
    slotSpan.title = slotLine.title;
    nextVal.appendChild(slotSpan);
    var eta = card.eta || {};
    var etaLine = wcEl('div', 'watch-card-eta');
    if (eta.days === null || eta.days === undefined) {
      etaLine.appendChild(wcEl('span', '', 'no estimate yet: nothing finished in the last 7 days'));
      etaLine.title = 'No done transitions in the last ' + (eta.windowDays || 7) + ' days, so pace is unknown.';
    } else {
      etaLine.appendChild(wcEl('span', '', 'about '));
      etaLine.appendChild(watchNum(eta.days, 'ETA days ', eta.remaining + ' tickets left / ' + eta.perDay + ' done per day over the last 7 days (' + eta.doneLast7Days + ' done)'));
      etaLine.appendChild(wcEl('span', '', ' days at today\'s pace'));
      etaLine.title = eta.remaining + ' tickets left / ' + eta.perDay + ' done per day over the last 7 days (' + eta.doneLast7Days + ' done)';
    }
    nextVal.appendChild(etaLine);
    nextVal.appendChild(readyList);
    row('Next', nextVal);
    var blocked = card.blocked || {};
    var waiting = blocked.waitingOnTickets || 0;
    var needYou = blocked.needYou || 0;
    var blockedVal = wcEl('div', 'watch-card-blocked');
    var waitBtn = wcEl('button', 'watch-card-toggle', String(waiting));
    waitBtn.type = 'button';
    waitBtn.title = waiting + ' ticket' + (waiting === 1 ? '' : 's') + ' waiting on other tickets.';
    waitBtn.setAttribute('aria-label', 'Show tickets waiting on dependencies');
    var waitList = cardItemList(blocked.items);
    toggleCardList(waitBtn, waitList);
    var waitWrap = wcEl('span', 'watch-num-wrap');
    waitWrap.appendChild(wcEl('span', 'watch-num-label', 'waiting on tickets'));
    waitWrap.appendChild(waitBtn);
    blockedVal.appendChild(waitWrap);
    blockedVal.appendChild(wcEl('span', '', ' wait on other tickets. '));
    var needBtn = wcEl('button', 'watch-card-toggle', String(needYou));
    needBtn.type = 'button';
    needBtn.title = needYou + ' item' + (needYou === 1 ? '' : 's') + ' need you.';
    needBtn.setAttribute('aria-label', 'Show need-you items');
    var needList = cardItemList(blocked.needYouItems);
    toggleCardList(needBtn, needList);
    var needWrap = wcEl('span', 'watch-num-wrap');
    needWrap.appendChild(wcEl('span', 'watch-num-label', 'need you'));
    needWrap.appendChild(needBtn);
    blockedVal.appendChild(needWrap);
    blockedVal.appendChild(wcEl('span', '', ' need you.'));
    blockedVal.appendChild(waitList);
    blockedVal.appendChild(needList);
    row('Blocked', blockedVal);
    host.appendChild(rows);
    var facts = card.facts || {};
    var factsRow = wcEl('div', 'watch-card-facts');
    var guardN = facts.handEditsBlocked24h || 0;
    var guard = wcEl('span', 'watch-card-fact');
    guard.appendChild(watchNum(guardN, 'hand-edits blocked by the guard ', 'Hand-edits the guard refused in the last 24 hours. Each one means someone tried to change code by hand instead of through the swarm.'));
    guard.appendChild(wcEl('span', '', ' hand-edits blocked by the guard'));
    factsRow.appendChild(guard);
    var untrackedN = facts.untrackedRuns || 0;
    var untracked = wcEl('span', 'watch-card-fact');
    var untrackedHref = opts.pageMode ? (facts.listHref || '#untracked') : (wcProjectHref(p.id) + (facts.listHref || '#untracked'));
    var untrackedLink = wcLink(untrackedHref, 'watch-card-fact-link', []);
    untrackedLink.appendChild(watchNum(untrackedN, 'untracked runs ', 'Runs found on this project\'s checkouts that no ticket claims. Smoke tests and lane tests are left out. Click to see the list.'));
    untrackedLink.appendChild(wcEl('span', '', ' untracked runs'));
    untrackedLink.title = 'Runs found on this project\'s checkouts that no ticket claims. Smoke tests and lane tests are left out. Click to see the list.';
    untracked.appendChild(untrackedLink);
    factsRow.appendChild(untracked);
    var coN = facts.checkouts || 0;
    var co = wcEl('span', 'watch-card-fact');
    co.appendChild(watchNum(coN, 'checkouts ', 'Folders where this project is checked out: the main folder, linked worktrees and scratch folders. Runs from all of them are counted.'));
    co.appendChild(wcEl('span', '', ' checkouts'));
    factsRow.appendChild(co);
    host.appendChild(factsRow);
    if (p.idleWithReady) {
      var idleReady = wcEl('div', 'watch-card-idle-ready');
      idleReady.appendChild(wcPill('Idle with ' + p.readyTickets + ' ready tickets', 'bad'));
      host.appendChild(idleReady);
    }
    if (card.headsUp) {
      var hu = wcEl('div', 'watch-card-headsup-row');
      hu.appendChild(wcEl('span', 'watch-card-row-label', 'Heads up'));
      var huText = wcEl('span', 'watch-card-headsup-text', card.headsUp);
      huText.title = card.headsUp;
      hu.appendChild(huText);
      host.appendChild(hu);
    }
    return host;
  }

  function kpiTile(title, labelNode, sub, extra) {
    var t = wcEl('div', 'card kpi');
    t.appendChild(wcEl('div', 'l', title));
    t.appendChild(labelNode);
    t.appendChild(wcEl('div', 's', sub));
    if (extra) { t.appendChild(extra); }
    return t;
  }

  return {
    agentCounts: agentCounts, slotsText: slotsText, signature: signature, laneColor: laneColor, itemKey: itemKey, unread: unread, remember: remember, liveness: liveness, chipState: chipState, streamState: streamState, countdown: countdown, duration: duration, bays: bays, parseHash: parseHash, layoutGraph: layoutGraph, replay: replay, watchToken: watchToken, KNOWN_LANES: KNOWN_LANES, TABS: TABS, LIVE_MS: LIVE_MS,
    percentBoard: percentBoard, slotsSentence: slotsSentence, renderWatchProjectCard: renderWatchProjectCard, watchNum: watchNum, kpiTile: kpiTile, wcMeter: wcMeter,
  };
}));
