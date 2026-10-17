// SPDX-License-Identifier: Apache-2.0
(function () {
  'use strict';

  var openStages = {};
  var openEpics = {};

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = String(text);
    return n;
  }

  function num(v) {
    if (v === null || v === undefined || isNaN(Number(v))) return '–';
    return Number(v).toLocaleString();
  }

  function usd(v) {
    if (v === null || v === undefined || isNaN(Number(v))) return '–';
    return '$' + Number(v).toFixed(2);
  }

  function pct(v) {
    if (v === null || v === undefined || isNaN(Number(v))) return '–';
    return Math.round(Number(v)) + '%';
  }

  function pill(text, kind) {
    return el('span', 'pill ' + (kind || 'info'), text);
  }

  function bar(percent, color) {
    var b = el('div', 'bar');
    var s = el('span');
    var p = Math.max(0, Math.min(100, Number(percent) || 0));
    s.style.width = p + '%';
    s.style.background = color || 'linear-gradient(90deg,var(--teal),var(--lime))';
    b.appendChild(s);
    return b;
  }

  function statusKind(status) {
    if (status === 'done') return 'good';
    if (status === 'blocked' || status === 'failed') return 'bad';
    if (status === 'in-progress' || status === 'running') return 'info';
    if (status === 'review') return 'lav';
    return 'warn';
  }

  function statusColor(status) {
    if (status === 'done') return 'var(--lime)';
    if (status === 'blocked' || status === 'failed') return 'var(--red)';
    if (status === 'in-progress' || status === 'running') return 'var(--sky)';
    if (status === 'review') return 'var(--lav)';
    if (status === 'cancelled') return 'var(--faint)';
    return 'var(--queued)';
  }

  function typeLetter(type) {
    var t = type ? String(type) : '?';
    return t.charAt(0).toUpperCase() || '?';
  }

  function header(plan) {
    var box = document.getElementById('pl-header');
    if (!box) return;
    box.textContent = '';
    var h = plan.header || {};
    var grid = el('div', 'pl-cards');

    var scope = el('div', 'card pl-card');
    scope.appendChild(el('span', 'label', 'Scope'));
    var name = h.scopeName || 'unnamed scope';
    scope.appendChild(el('div', 'pl-big', name));
    scope.appendChild(el('div', 'pl-sub', h.scopeVersion ? 'version ' + h.scopeVersion : 'no version'));
    grid.appendChild(scope);

    var prog = el('div', 'card pl-card');
    prog.appendChild(el('span', 'label', 'Done'));
    prog.appendChild(el('div', 'pl-big num', pct(h.percentDone)));
    prog.appendChild(bar(h.percentDone));
    grid.appendChild(prog);

    var cov = el('div', 'card pl-card');
    cov.appendChild(el('span', 'label', 'Coverage'));
    cov.appendChild(el('div', 'pl-big num', pct(h.coveragePct)));
    cov.appendChild(el('div', 'pl-sub', num(h.total) + ' tickets'));
    grid.appendChild(cov);

    var st = el('div', 'card pl-card');
    st.appendChild(el('span', 'label', 'By status'));
    var pills = el('div', 'pl-pills');
    var byStatus = h.byStatus || {};
    Object.keys(byStatus).sort().forEach(function (k) {
      pills.appendChild(pill(k + ' ' + num(byStatus[k]), statusKind(k)));
    });
    st.appendChild(pills);
    grid.appendChild(st);

    var sp = el('div', 'card pl-card');
    sp.appendChild(el('span', 'label', 'Spend'));
    sp.appendChild(el('div', 'pl-big num', usd(h.spendUsd) + ' / ' + usd(h.estimateUsd)));
    var est = Number(h.estimateUsd);
    var spent = Number(h.spendUsd) || 0;
    sp.appendChild(bar(est > 0 ? (spent / est) * 100 : 0, spent > est && est > 0 ? 'var(--red)' : undefined));
    grid.appendChild(sp);

    var co = el('div', 'card pl-card');
    co.appendChild(el('span', 'label', 'Change orders'));
    co.appendChild(el('div', 'pl-big num', num(h.changeOrderCount)));
    grid.appendChild(co);

    box.appendChild(grid);
  }

  function ticketCard(t) {
    var card = el('div', 'pl-ticket');
    card.style.borderLeftColor = statusColor(t.status);
    card.setAttribute('role', 'button');
    card.setAttribute('tabindex', '0');
    card.addEventListener('click', function () {
      var sw = window.SwarmWatch;
      if (sw && sw.plan && typeof sw.plan.openTicket === 'function') sw.plan.openTicket(t.id);
    });
    card.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        card.click();
      }
    });

    var top = el('div', 'pl-ticket-top');
    var icon = el('span', 'pl-icon', typeLetter(t.type));
    icon.setAttribute('title', t.type || 'ticket');
    top.appendChild(icon);
    top.appendChild(el('span', 'pl-ticket-id mono', t.id));
    top.appendChild(el('span', 'pl-ticket-title', t.title || ''));
    card.appendChild(top);

    var meta = el('div', 'pl-ticket-meta');
    meta.appendChild(pill(t.status || 'unknown', statusKind(t.status)));
    if (t.risk) meta.appendChild(pill('risk ' + t.risk, t.risk === 'high' ? 'bad' : t.risk === 'med' || t.risk === 'medium' ? 'warn' : 'good'));
    if (t.sensitive) meta.appendChild(pill('sensitive', 'lav'));
    meta.appendChild(el('span', 'pl-lane', t.lane || 'no lane'));
    card.appendChild(meta);
    return card;
  }

  function stages(plan) {
    var box = document.getElementById('pl-stages');
    if (!box) return;
    box.textContent = '';
    (plan.stages || []).forEach(function (stage) {
      var row = el('div', 'pl-stage');
      var head = el('button', 'pl-stage-head');
      head.setAttribute('type', 'button');
      var open = !!openStages[stage.id];
      head.setAttribute('aria-expanded', String(open));
      head.appendChild(el('span', 'pl-caret', open ? '▾' : '▸'));
      head.appendChild(el('span', 'pl-stage-name', stage.id));
      head.appendChild(el('span', 'pl-stage-count num', num(stage.done) + '/' + num(stage.total)));
      head.appendChild(bar(stage.percent));
      head.addEventListener('click', function () {
        openStages[stage.id] = !openStages[stage.id];
        render(lastPlan);
      });
      row.appendChild(head);

      if (open) {
        var body = el('div', 'pl-epics');
        (stage.epics || []).forEach(function (epic) {
          var eBox = el('div', 'pl-epic');
          var key = stage.id + '/' + epic.id;
          var eOpen = !!openEpics[key];
          var eHead = el('button', 'pl-epic-head');
          eHead.setAttribute('type', 'button');
          eHead.setAttribute('aria-expanded', String(eOpen));
          eHead.appendChild(el('span', 'pl-caret', eOpen ? '▾' : '▸'));
          eHead.appendChild(el('span', 'pl-epic-name', epic.id));
          eHead.appendChild(el('span', 'pl-stage-count num', num(epic.done) + '/' + num(epic.total)));
          eHead.addEventListener('click', function () {
            openEpics[key] = !openEpics[key];
            render(lastPlan);
          });
          eBox.appendChild(eHead);
          if (eOpen) {
            var cards = el('div', 'pl-cards-list');
            (epic.cards || []).forEach(function (c) { cards.appendChild(ticketCard(c)); });
            eBox.appendChild(cards);
          }
          body.appendChild(eBox);
        });
        row.appendChild(body);
      }
      box.appendChild(row);
    });
  }

  var lastPlan = null;

  function render(plan) {
    lastPlan = plan;
    var root = document.getElementById('pane-plan');
    if (!root) return;
    if (!plan || plan.present === false) {
      root.textContent = '';
      var card = el('div', 'card pl-empty');
      card.appendChild(el('h2', null, 'No ticket ledger yet.'));
      card.appendChild(el('div', 'pl-sub', 'Run the command below to create one.'));
      var cmdRow = el('div', 'pl-cmd');
      var code = el('code', 'mono', 'swarm scope split');
      cmdRow.appendChild(code);
      var btn = el('button', 'btn', 'Copy');
      btn.setAttribute('type', 'button');
      btn.addEventListener('click', function () {
        var text = 'swarm scope split';
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(text);
        } else {
          var ta = el('textarea');
          ta.value = text;
          document.body.appendChild(ta);
          ta.select();
          try { document.execCommand('copy'); } catch (e) { /* ignore */ }
          document.body.removeChild(ta);
        }
      });
      cmdRow.appendChild(btn);
      card.appendChild(cmdRow);
      root.appendChild(card);
      return;
    }

    if (!document.getElementById('pl-header')) {
      root.textContent = '';
      ['pl-header', 'pl-stages', 'pl-requirements', 'pl-deps', 'pl-changes'].forEach(function (id) {
        var sec = el('section', 'pl-section');
        sec.id = id;
        root.appendChild(sec);
      });
    }
    header(plan);
    stages(plan);
  }

  window.SwarmWatch = window.SwarmWatch || {};
  window.SwarmWatch.plan = window.SwarmWatch.plan || {};

  if (typeof window.SwarmWatch.register === 'function') {
    window.SwarmWatch.register('plan', function (data) {
      try {
        render(data && data.plan);
      } catch (err) {
        if (window.console) console.error('plan tab failed', err);
      }
    });
  }
})();
