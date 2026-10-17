// SPDX-License-Identifier: Apache-2.0
(function () {
'use strict';
var SW = window.SwarmWatch;
if (!SW || typeof SW.register !== 'function') { return; }

function el(tag, cls, text) {
  var node = document.createElement(tag);
  if (cls) { node.className = cls; }
  if (text !== undefined && text !== null) { node.textContent = String(text); }
  return node;
}

function num(v) {
  return (typeof v === 'number' && isFinite(v)) ? String(v) : '–';
}

function fallbackCopy(text) {
  var area = el('textarea', 'gl-copy-area');
  area.setAttribute('readonly', '');
  area.value = text;
  document.body.appendChild(area);
  area.select();
  var ok = false;
  try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
  document.body.removeChild(area);
  return ok;
}

function copyText(text, button) {
  var done = function (ok) {
    button.textContent = ok ? 'Copied' : 'Select and copy';
    setTimeout(function () { button.textContent = 'Copy'; }, 1600);
  };
  if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
    navigator.clipboard.writeText(text).then(function () { done(true); }, function () { done(fallbackCopy(text)); });
  } else {
    done(fallbackCopy(text));
  }
}

function copyButton(text) {
  var b = el('button', 'btn gl-copy', 'Copy');
  b.type = 'button';
  b.addEventListener('click', function () { copyText(text, b); });
  return b;
}

function commandRow(text) {
  var row = el('div', 'gl-cmd');
  row.appendChild(el('code', 'gl-cmd-text mono', text));
  row.appendChild(copyButton(text));
  return row;
}

function shotUrl(id, kind) {
  return '/shot/' + encodeURIComponent(id) + '/' + kind + '?t=' + encodeURIComponent(SW.token || '');
}

function shotFigure(screen, kind, label, has) {
  var fig = el('figure', 'gl-shot');
  fig.appendChild(el('figcaption', 'label', label));
  if (has) {
    var btn = el('button', 'gl-shot-btn');
    btn.type = 'button';
    btn.setAttribute('aria-label', label + ' of ' + screen.id + ', open large');
    var img = el('img', 'gl-img');
    img.setAttribute('src', shotUrl(screen.id, kind));
    img.setAttribute('alt', label + ' of ' + screen.id);
    img.setAttribute('loading', 'lazy');
    btn.appendChild(img);
    btn.addEventListener('click', function () {
      var big = el('img', 'gl-large');
      big.setAttribute('src', shotUrl(screen.id, kind));
      big.setAttribute('alt', label + ' of ' + screen.id);
      SW.openDrawer(screen.id + ' · ' + label.toLowerCase(), big);
    });
    fig.appendChild(btn);
  } else {
    fig.appendChild(el('div', 'gl-placeholder', label === 'Mockup' ? 'no mockup' : 'no page shot'));
  }
  return fig;
}

function verdictPill(v) {
  return v === 'pass' ? el('span', 'pill good', 'pass') : el('span', 'pill bad', 'fail');
}

function approvalPill(approval) {
  if (approval === 'approved') { return el('span', 'pill good', 'approved'); }
  if (approval === 'stale') { return el('span', 'pill warn gl-stale', 'changed since approval'); }
  return el('span', 'pill gl-none', 'none');
}

function renderCard(screen) {
  var id = String(screen.id);
  var card = el('article', 'card gl-card');
  var head = el('div', 'card-head');
  head.appendChild(el('h2', 'gl-id mono', id));
  var pills = el('div', 'gl-pills');
  pills.appendChild(verdictPill(screen.verdict));
  pills.appendChild(el('span', 'pill info', 'score ' + num(screen.score)));
  pills.appendChild(approvalPill(screen.approval));
  head.appendChild(pills);
  card.appendChild(head);

  var shots = el('div', 'gl-shots');
  shots.appendChild(shotFigure(screen, 'mockup', 'Mockup', !!screen.hasMockup));
  shots.appendChild(shotFigure(screen, 'page', 'Page', !!screen.hasPage));
  card.appendChild(shots);

  var comments = Array.isArray(screen.comments) ? screen.comments : [];
  var list = el('ul', 'gl-comments');
  if (!comments.length) { list.appendChild(el('li', 'gl-comment-empty', 'no comments')); }
  comments.forEach(function (c) {
    list.appendChild(el('li', 'gl-comment', c && c.text !== undefined && c.text !== null ? String(c.text) : ''));
  });
  card.appendChild(list);

  var cmds = el('div', 'gl-cmds');
  cmds.appendChild(commandRow('swarm gallery approve ' + id));
  cmds.appendChild(commandRow('swarm gallery comment ' + id + ' "text"'));
  card.appendChild(cmds);
  return card;
}

function render(gallery) {
  var pane = document.getElementById('pane-gallery');
  if (!pane) { return; }
  while (pane.firstChild) { pane.removeChild(pane.firstChild); }
  var screens = (gallery && Array.isArray(gallery.screens) ? gallery.screens : []).filter(function (s) {
    return s && s.id !== undefined && s.id !== null;
  });
  var approved = 0, stale = 0, none = 0;
  screens.forEach(function (s) {
    if (s.approval === 'approved') { approved++; }
    else if (s.approval === 'stale') { stale++; }
    else { none++; }
  });

  var head = el('div', 'card gl-head');
  var top = el('div', 'card-head');
  top.appendChild(el('h2', '', 'Gallery'));
  top.appendChild(el('span', 'label', screens.length + ' screens'));
  head.appendChild(top);
  var counts = el('div', 'gl-counts');
  counts.appendChild(el('span', 'pill good', 'approved ' + approved));
  counts.appendChild(el('span', 'pill warn', 'stale ' + stale));
  counts.appendChild(el('span', 'pill gl-none', 'none ' + none));
  head.appendChild(counts);
  head.appendChild(commandRow('swarm gallery list'));
  pane.appendChild(head);

  if (!screens.length) {
    var empty = el('div', 'card gl-empty');
    empty.appendChild(el('p', '', 'No screens yet. Run swarm ui check.'));
    empty.appendChild(commandRow('swarm ui check'));
    pane.appendChild(empty);
    return;
  }

  var grid = el('div', 'gl-grid');
  screens.forEach(function (s) { grid.appendChild(renderCard(s)); });
  pane.appendChild(grid);
}

SW.register('gallery', function (data) {
  render(data ? data.gallery : null);
});
})();
