// SPDX-License-Identifier: Apache-2.0
// Navigation on a run page: "← All projects" and the breadcrumb All projects > project > run. The links are plain addresses on this page's own server
// (with this page's token); that server finds the board, or starts one, and sends the browser there, so the Back button keeps working.
(function () {
  'use strict';
  var TOKEN = self.BoardLib.watchToken();
  var box = document.getElementById('crumbs');
  if (!box) { return; }

  function el(tag, cls, text) { var n = document.createElement(tag); if (cls) { n.className = cls; } if (text !== undefined) { n.textContent = text; } return n; }
  function link(href, cls, text) { var a = el('a', cls, text); a.href = href; return a; }

  fetch('/api/nav', { headers: { 'x-watch-token': TOKEN } })
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (nav) {
      if (!nav) { return; }
      box.textContent = '';
      box.appendChild(link('/nav/board', 'back', '← All projects'));
      box.appendChild(link('/nav/board', '', 'All projects'));
      if (nav.project) {
        box.appendChild(el('span', 'sep', '›'));
        box.appendChild(link('/nav/project', '', nav.project.name));
      }
      if (nav.run) {
        box.appendChild(el('span', 'sep', '›'));
        box.appendChild(el('span', 'here mono', nav.run));
      }
      box.hidden = false;
    })
    .catch(function () {});
})();
