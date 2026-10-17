// SPDX-License-Identifier: Apache-2.0
(function () {
  'use strict';

  var SW = window.SwarmWatch = window.SwarmWatch || {};
  var SVG_NS = 'http://www.w3.org/2000/svg';
  var MAX_NODES = 200;
  var reduceMotion = false;
  try {
    reduceMotion = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  } catch (e) {
    reduceMotion = false;
  }

  var lastPlan = {};
  var reqFilter = 'all';
  var seenTickets = null;
  var newTickets = [];

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = String(text);
    return n;
  }
  function txt(v) { return v === null || v === undefined || v === '' ? '–' : String(v); }
  function usd(v) {
    if (typeof v !== 'number' || !isFinite(v)) return '–';
    return v < 0.01 && v > 0 ? '$' + v.toFixed(4) : '$' + v.toFixed(2);
  }
  function count(v) {
    if (Array.isArray(v)) return v.length;
    return typeof v === 'number' && isFinite(v) ? v : 0;
  }
  function when(iso) {
    if (!iso) return '–';
    var d = new Date(iso);
    return isNaN(d.getTime()) ? String(iso) : d.toLocaleString();
  }
  function listOf(v) { return Array.isArray(v) ? v : []; }

  function openTicketById(id) {
    var t = lastPlan && lastPlan.tickets ? lastPlan.tickets[id] : null;
    if (!t) return;
    var body = buildDrawer(t);
    if (typeof SW.openDrawer === 'function') SW.openDrawer(t.id + ' · ' + txt(t.title), body);
  }

  function section(title, node) {
    var s = el('section', 'pl-drawer-sec');
    s.appendChild(el('div', 'label', title));
    s.appendChild(node);
    return s;
  }

  function chipList(items, onClick) {
    var wrap = el('div', 'chips');
    listOf(items).forEach(function (x) {
      var b = el('button', 'chip mono', String(x));
      b.type = 'button';
      if (onClick) b.addEventListener('click', function () { onClick(String(x)); });
      wrap.appendChild(b);
    });
    if (!wrap.childNodes.length) wrap.appendChild(el('span', 'label', 'none'));
    return wrap;
  }

  function kv(k, v) {
    var r = el('div', 'pl-kv');
    r.appendChild(el('span', 'label', k));
    r.appendChild(el('span', 'mono', txt(v)));
    return r;
  }

  function buildDrawer(t) {
    var root = el('div', 'pl-ticket');
    var head = el('div', 'pl-ticket-head');
    head.appendChild(el('span', 'pill info', txt(t.status)));
    if (t.risk) head.appendChild(el('span', 'pill warn', 'risk ' + t.risk));
    if (t.sensitive) head.appendChild(el('span', 'pill bad', 'sensitive'));
    root.appendChild(head);
    root.appendChild(section('Scope', chipList(t.scopeRefs, null)));
    var ac = el('ol', 'pl-ac');
    listOf(t.acceptance).forEach(function (a) { ac.appendChild(el('li', null, String(a))); });
    if (!ac.childNodes.length) ac.appendChild(el('li', 'label', 'no acceptance criteria'));
    root.appendChild(section('Acceptance', ac));
    root.appendChild(section('Files', chipList(t.files, null)));
    root.appendChild(section('Depends on', chipList(t.dependsOn, openTicketById)));
    var meta = el('div', 'pl-kvs');
    meta.appendChild(kv('lane', t.lane));
    meta.appendChild(kv('review', t.review));
    meta.appendChild(kv('PR', t.pr));
    meta.appendChild(kv('cost', usd(t.costUsd)));
    root.appendChild(section('Delivery', meta));
    var drift = el('ul', 'pl-drift');
    listOf(t.drift).forEach(function (d) { drift.appendChild(el('li', 'pill warn', String(d))); });
    if (!drift.childNodes.length) drift.appendChild(el('li', 'label', 'no drift flags'));
    root.appendChild(section('Drift', drift));
    return root;
  }

  function reqState(r) {
    return r.state === 'missing' ? 'missing' : r.state === 'done' ? 'done' : 'partial';
  }

  function renderRequirements(container, plan) {
    container.textContent = '';
    var bar = el('div', 'seg');
    bar.setAttribute('role', 'group');
    bar.setAttribute('aria-label', 'Filter requirements');
    [['all', 'All'], ['missing', 'Missing'], ['partial', 'Partial']].forEach(function (f) {
      var b = el('button', null, f[1]);
      b.type = 'button';
      b.setAttribute('aria-pressed', String(reqFilter === f[0]));
      b.addEventListener('click', function () {
        reqFilter = f[0];
        renderRequirements(container, lastPlan);
      });
      bar.appendChild(b);
    });
    container.appendChild(bar);
    var list = el('div', 'pl-reqs');
    var shown = 0;
    listOf(plan.requirements).forEach(function (r) {
      var st = reqState(r);
      if (reqFilter !== 'all' && st !== reqFilter) return;
      shown++;
      var row = el('div', 'pl-req');
      var top = el('div', 'pl-req-top');
      top.appendChild(el('span', 'mono lead-name', txt(r.id)));
      top.appendChild(el('span', null, txt(r.title)));
      var cls = st === 'done' ? 'good' : st === 'partial' ? 'warn' : 'bad';
      top.appendChild(el('span', 'pill ' + cls, st));
      row.appendChild(top);
      var chips = el('div', 'chips');
      listOf(r.tickets).forEach(function (tid) {
        var c = el('button', 'chip mono', String(tid));
        c.type = 'button';
        if (!reduceMotion && newTickets.indexOf(String(tid)) !== -1) c.className += ' pl-fade-in';
        c.addEventListener('click', function () { openTicketById(String(tid)); });
        chips.appendChild(c);
      });
      if (!chips.childNodes.length) chips.appendChild(el('span', 'label', 'no tickets'));
      row.appendChild(chips);
      list.appendChild(row);
    });
    if (!shown) list.appendChild(el('div', 'label', 'nothing matches this filter'));
    container.appendChild(list);
  }

  function depthsOf(nodes, edges) {
    var ids = {};
    nodes.forEach(function (n) { ids[n.id] = true; });
    var deps = {};
    edges.forEach(function (e) {
      if (ids[e.from] && ids[e.to]) {
        if (!deps[e.from]) deps[e.from] = [];
        deps[e.from].push(e.to);
      }
    });
    var memo = {}, visiting = {};
    function d(id) {
      if (memo[id] !== undefined) return memo[id];
      if (visiting[id]) return 0;
      visiting[id] = true;
      var best = 0;
      (deps[id] || []).forEach(function (t) { best = Math.max(best, d(t) + 1); });
      visiting[id] = false;
      memo[id] = best;
      return best;
    }
    nodes.forEach(function (n) { d(n.id); });
    return memo;
  }

  function svgEl(name, attrs) {
    var n = document.createElementNS(SVG_NS, name);
    Object.keys(attrs).forEach(function (k) { n.setAttribute(k, String(attrs[k])); });
    return n;
  }

  function renderDeps(container, plan) {
    container.textContent = '';
    var dep = plan.dependencies || {};
    var nodes = listOf(dep.nodes);
    var edges = listOf(dep.edges);
    if (!nodes.length) {
      container.appendChild(el('div', 'label', 'no dependencies to draw'));
      return;
    }
    var blocked = {};
    listOf(dep.blocked).forEach(function (id) { blocked[id] = true; });
    var statusOf = {};
    nodes.forEach(function (n) { statusOf[n.id] = n.status; });
    var depth = depthsOf(nodes, edges);
    var sorted = nodes.slice().sort(function (a, b) {
      var da = depth[a.id] || 0, db = depth[b.id] || 0;
      if (da !== db) return da - db;
      return String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0;
    });
    var total = sorted.length;
    var drawn = sorted.slice(0, MAX_NODES);
    var colRows = {};
    var pos = {};
    var maxDepth = 0, maxRows = 1;
    drawn.forEach(function (n) {
      var c = depth[n.id] || 0;
      if (!colRows[c]) colRows[c] = 0;
      var r = colRows[c]++;
      pos[n.id] = { x: 16 + c * 150, y: 16 + r * 44 };
      maxDepth = Math.max(maxDepth, c);
      maxRows = Math.max(maxRows, colRows[c]);
    });
    var width = 32 + (maxDepth + 1) * 150;
    var height = 32 + maxRows * 44;
    var svg = svgEl('svg', {
      viewBox: '0 0 ' + width + ' ' + height,
      width: width,
      height: height,
      role: 'img',
      'aria-label': 'Dependency graph'
    });
    edges.forEach(function (e) {
      var a = pos[e.from], b = pos[e.to];
      if (!a || !b) return;
      var isBlocked = !!(blocked[e.from] && (blocked[e.to] || statusOf[e.to] === 'blocked'));
      svg.appendChild(svgEl('line', {
        x1: b.x + 130, y1: b.y + 15, x2: a.x, y2: a.y + 15,
        stroke: isBlocked ? '#ff5f6f' : '#66739f',
        'stroke-width': isBlocked ? 2 : 1,
        opacity: isBlocked ? 1 : 0.35
      }));
    });
    drawn.forEach(function (n) {
      var p = pos[n.id];
      var isBlocked = !!blocked[n.id];
      var g = svgEl('g', { tabindex: 0, role: 'button', cursor: 'pointer' });
      var label = String(n.id);
      g.appendChild(svgEl('rect', {
        x: p.x, y: p.y, width: 130, height: 30, rx: 8, ry: 8,
        fill: '#15214a',
        stroke: isBlocked ? '#ff5f6f' : '#33468a',
        'stroke-width': isBlocked ? 2 : 1
      }));
      var t = svgEl('text', { x: p.x + 8, y: p.y + 19, 'font-size': 11, fill: '#dfe6fb' });
      t.textContent = label.length > 18 ? label.slice(0, 17) + '…' : label;
      g.appendChild(t);
      var title = document.createElementNS(SVG_NS, 'title');
      title.textContent = label + ' · ' + txt(n.status);
      g.appendChild(title);
      g.addEventListener('click', function () { openTicketById(String(n.id)); });
      g.addEventListener('keydown', function (ev) {
        if (ev.key === 'Enter' || ev.key === ' ') {
          ev.preventDefault();
          openTicketById(String(n.id));
        }
      });
      svg.appendChild(g);
    });
    var wrap = el('div', 'pl-graph-wrap');
    wrap.style.overflowX = 'auto';
    wrap.appendChild(svg);
    container.appendChild(wrap);
    if (total > MAX_NODES) {
      container.appendChild(el('div', 'label', 'showing ' + MAX_NODES + ' of ' + total + ' nodes'));
    }
  }

  function renderChanges(container, plan) {
    container.textContent = '';
    if (newTickets.length && !reduceMotion) {
      var fresh = el('div', 'chips pl-fade-in');
      newTickets.forEach(function (tid) {
        var c = el('button', 'chip mono', 'new ' + tid);
        c.type = 'button';
        c.addEventListener('click', function () { openTicketById(tid); });
        fresh.appendChild(c);
      });
      container.appendChild(fresh);
    }
    var changes = listOf(plan.changeOrders);
    if (!changes.length) {
      container.appendChild(el('div', 'label', 'no change orders'));
      return;
    }
    var ol = el('ol', 'pl-timeline');
    changes.forEach(function (c) {
      var li = el('li', 'pl-change');
      var head = el('div', 'pl-change-head');
      head.appendChild(el('span', 'mono lead-name', txt(c.id)));
      head.appendChild(el('span', 'mono', when(c.at)));
      li.appendChild(head);
      li.appendChild(el('div', null, txt(c.reason)));
      var counts = el('div', 'chips');
      counts.appendChild(el('span', 'pill good', '+' + count(c.added) + ' added'));
      counts.appendChild(el('span', 'pill bad', count(c.cancelled) + ' cancelled'));
      counts.appendChild(el('span', 'pill warn', count(c.reopened) + ' reopened'));
      li.appendChild(counts);
      ol.appendChild(li);
    });
    container.appendChild(ol);
  }

  function render(data) {
    var plan = data && data.plan && typeof data.plan === 'object' ? data.plan : {};
    lastPlan = plan;
    var tickets = plan.tickets && typeof plan.tickets === 'object' ? plan.tickets : {};
    var ids = Object.keys(tickets);
    if (seenTickets === null) {
      newTickets = [];
    } else {
      newTickets = ids.filter(function (id) { return !seenTickets[id]; });
    }
    seenTickets = {};
    ids.forEach(function (id) { seenTickets[id] = true; });

    var reqBox = document.getElementById('pl-requirements');
    if (reqBox) {
      try { renderRequirements(reqBox, plan); } catch (e) { console.error('plan requirements', e); }
    }
    var depBox = document.getElementById('pl-deps');
    if (depBox) {
      try { renderDeps(depBox, plan); } catch (e) { console.error('plan deps', e); }
    }
    var chBox = document.getElementById('pl-changes');
    if (chBox) {
      try { renderChanges(chBox, plan); } catch (e) { console.error('plan changes', e); }
    }
    newTickets = [];
  }

  SW.plan = SW.plan || {};
  SW.plan.openTicket = openTicketById;

  if (typeof SW.register === 'function') SW.register('plan', render);
})();
