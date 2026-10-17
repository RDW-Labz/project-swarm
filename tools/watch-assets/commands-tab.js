// SPDX-License-Identifier: Apache-2.0
(function () {
  'use strict';

  var COST_CLASS = { free: 'pill good', local: 'pill info', spends: 'pill warn' };
  var state = { built: false, input: null, contextBox: null, listBox: null, commands: [], query: '' };

  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function strOf(v) {
    return v === null || v === undefined ? '' : String(v);
  }

  function fallbackCopy(text) {
    var ta = el('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); } catch (e) { /* ignore */ }
    document.body.removeChild(ta);
  }

  function copyText(text, button) {
    var done = function () {
      button.textContent = 'Copied';
      setTimeout(function () { button.textContent = 'Copy'; }, 1500);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, function () { fallbackCopy(text); done(); });
    } else {
      fallbackCopy(text);
      done();
    }
  }

  function cmdBox(text) {
    var wrap = el('div', 'cm-cmd');
    var box = el('div', 'cm-cmd-box mono', text);
    var btn = el('button', 'btn cm-copy', 'Copy');
    btn.type = 'button';
    btn.setAttribute('aria-label', 'Copy command: ' + strOf(text));
    btn.addEventListener('click', function () { copyText(strOf(text), btn); });
    wrap.appendChild(box);
    wrap.appendChild(btn);
    return wrap;
  }

  function sectionHead(title) {
    var head = el('div', 'card-head');
    head.appendChild(el('h2', null, title));
    return head;
  }

  function matchesQuery(cmd, words) {
    var fields = [cmd.name, cmd.summary, cmd.what, cmd.when].map(function (v) {
      return strOf(v).toLowerCase();
    });
    return words.every(function (w) {
      return fields.some(function (f) { return f.indexOf(w) !== -1; });
    });
  }

  function filterList(list, query) {
    var words = strOf(query).trim().toLowerCase().split(' ').filter(Boolean);
    return list.filter(function (cmd) { return matchesQuery(cmd, words); });
  }

  function makeCommandCard(cmd) {
    var card = el('article', 'card cm-card');
    var top = el('div', 'cm-top');
    top.appendChild(el('h3', 'cm-name mono', cmd.name));
    var costClass = COST_CLASS[cmd.cost] || 'pill';
    top.appendChild(el('span', costClass, strOf(cmd.cost) || 'free'));
    if (cmd.approval) top.appendChild(el('span', 'pill lav', 'asks you first'));
    card.appendChild(top);
    if (cmd.summary) card.appendChild(el('p', 'cm-summary', cmd.summary));
    if (cmd.what) card.appendChild(el('p', 'cm-what', cmd.what));
    if (cmd.when) card.appendChild(el('p', 'cm-when', 'When: ' + cmd.when));
    card.appendChild(el('span', 'label', 'Example'));
    card.appendChild(cmdBox(cmd.example || ('swarm ' + strOf(cmd.name))));
    var flags = Array.isArray(cmd.flags) ? cmd.flags : [];
    if (flags.length) {
      var row = el('div', 'cm-flags');
      flags.forEach(function (f) {
        var text = typeof f === 'string' ? f : strOf((f && (f.name || f.flag)) || f);
        row.appendChild(el('span', 'cm-chip mono', text));
      });
      card.appendChild(row);
    }
    return card;
  }

  function renderContext(list) {
    var box = state.contextBox;
    box.textContent = '';
    if (!Array.isArray(list) || list.length === 0) {
      box.appendChild(el('p', 'cm-empty', 'No commands for this run yet.'));
      return;
    }
    list.forEach(function (item) {
      var card = el('article', 'card cm-card');
      card.appendChild(el('span', 'label', item.label));
      card.appendChild(cmdBox(item.command));
      box.appendChild(card);
    });
  }

  function renderList() {
    var box = state.listBox;
    box.textContent = '';
    var shown = filterList(state.commands, state.query);
    if (shown.length === 0) {
      box.appendChild(el('p', 'cm-empty', 'No match'));
      return;
    }
    shown.forEach(function (cmd) { box.appendChild(makeCommandCard(cmd)); });
  }

  function build(pane) {
    pane.textContent = '';
    pane.appendChild(el('p', 'cm-note', 'This page cannot change anything. Copy a command and run it in your terminal.'));

    var ctxCard = el('section', 'card cm-section');
    ctxCard.appendChild(sectionHead('For this run'));
    state.contextBox = el('div', 'cm-grid');
    ctxCard.appendChild(state.contextBox);
    pane.appendChild(ctxCard);

    var listCard = el('section', 'card cm-section');
    listCard.appendChild(sectionHead('All commands'));
    var input = el('input', 'cm-search');
    input.type = 'search';
    input.placeholder = 'Search commands';
    input.setAttribute('aria-label', 'Search commands');
    input.addEventListener('input', function () {
      state.query = input.value;
      renderList();
    });
    state.input = input;
    listCard.appendChild(input);
    state.listBox = el('div', 'cm-grid');
    listCard.appendChild(state.listBox);
    pane.appendChild(listCard);
  }

  function render(data) {
    var pane = document.getElementById('pane-commands');
    if (!pane) return;
    if (!state.built) {
      build(pane);
      state.built = true;
    }
    state.commands = data && Array.isArray(data.commands) ? data.commands : [];
    renderContext(data ? data.contextCommands : null);
    renderList();
  }

  if (window.SwarmWatch && typeof window.SwarmWatch.register === 'function') {
    window.SwarmWatch.register('commands', render);
  }
})();
