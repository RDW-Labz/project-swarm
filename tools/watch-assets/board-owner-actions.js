// SPDX-License-Identifier: Apache-2.0
// Approve / deny controls for owner-decidable Needs-you items (tailnet sign-in + board token header only).
var REFUSED_OWNER_KINDS = ['merge', 'deploy', 'cap-raise', 'spend', 'key', 'migration'];
var REFUSED_OWNER_KIND_RE = /^(?:merge|deploy|cap-raise|spend|key|migration)(?:$|[^a-z0-9])/;

function isRefusedOwnerKind(value) {
  var normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return REFUSED_OWNER_KIND_RE.test(normalized);
}

function el(doc, tag, cls, text) {
  var n = doc.createElement(tag);
  if (cls) { n.className = cls; }
  if (text !== undefined && text !== null) { n.textContent = text; }
  return n;
}

function actionPath(itemId, step) {
  return '/api/owner/actions/' + encodeURIComponent(itemId) + '/' + step;
}

function readError(body) {
  if (!body || typeof body !== 'object') { return 'Request failed'; }
  if (body.message) { return String(body.message); }
  if (body.error) { return String(body.error); }
  return 'Request failed';
}

function authHeaders(token) {
  return { 'x-watch-token': token, 'Content-Type': 'application/json' };
}

export function ownerActionAvailable(item, options) {
  if (!options || !options.signedIn) { return false; }
  if (!item || item.needsOwner !== true) { return false; }
  var kind = item.kind ? String(item.kind) : '';
  return !isRefusedOwnerKind(kind);
}

export function renderOwnerActions(container, item, options) {
  var fetchImpl = options.fetchImpl;
  var token = options.token;
  var signedIn = options.signedIn;
  var doc = options.doc || (typeof document !== 'undefined' ? document : null);
  if (!container || !doc) { return; }
  container.textContent = '';
  if (!ownerActionAvailable(item, { signedIn })) { return; }

  var itemId = String(item.id);
  var wrap = el(doc, 'div', 'owner-actions');
  var status = el(doc, 'div', 'owner-actions-status');
  var row = el(doc, 'div', 'owner-actions-row');
  wrap.appendChild(status);
  wrap.appendChild(row);
  container.appendChild(wrap);

  var busy = false;
  var pending = null;

  function setBusy(on) {
    busy = on;
    row.querySelectorAll('button').forEach(function (b) { b.disabled = on; });
  }

  function showStatus(text) {
    status.textContent = text || '';
    status.hidden = !text;
  }

  function renderIdle() {
    pending = null;
    row.textContent = '';
    var approve = el(doc, 'button', 'owner-approve', 'Approve');
    approve.type = 'button';
    var deny = el(doc, 'button', 'owner-deny', 'Deny');
    deny.type = 'button';
    approve.addEventListener('click', function () { enterConfirm('approve'); });
    deny.addEventListener('click', function () { enterConfirm('deny'); });
    row.appendChild(approve);
    row.appendChild(deny);
  }

  function enterConfirm(decision) {
    pending = decision;
    row.textContent = '';
    var label = decision === 'approve' ? 'Confirm approve?' : 'Confirm deny?';
    var confirmBtn = el(doc, 'button', 'owner-confirm', label);
    confirmBtn.type = 'button';
    var cancel = el(doc, 'button', 'owner-cancel', 'Cancel');
    cancel.type = 'button';
    cancel.addEventListener('click', function () { if (!busy) { renderIdle(); } });
    confirmBtn.addEventListener('click', function () { submitDecision(decision); });
    row.appendChild(confirmBtn);
    row.appendChild(cancel);
  }

  function submitDecision(decision) {
    if (busy) { return; }
    setBusy(true);
    showStatus('');
    var prepareUrl = actionPath(itemId, 'prepare');
    fetchImpl(prepareUrl, { method: 'POST', headers: authHeaders(token) })
      .then(function (res) {
        return res.json().catch(function () { return null; }).then(function (body) {
          if (!res.ok) { throw new Error(readError(body)); }
          return body;
        });
      })
      .then(function (prepared) {
        var confirmToken = prepared && prepared.confirmToken;
        if (!confirmToken) { throw new Error('Missing confirmation'); }
        var decisionUrl = actionPath(itemId, 'decision');
        return fetchImpl(decisionUrl, {
          method: 'POST',
          headers: authHeaders(token),
          body: JSON.stringify({ decision: decision, confirm: confirmToken }),
        }).then(function (res) {
          return res.json().catch(function () { return null; }).then(function (body) {
            if (!res.ok) { throw new Error(readError(body)); }
            return body;
          });
        });
      })
      .then(function (result) {
        row.textContent = '';
        var msg = result && result.result ? String(result.result) : (decision === 'approve' ? 'Approved' : 'Denied');
        showStatus(msg);
      })
      .catch(function (err) {
        showStatus(err && err.message ? err.message : 'Request failed');
        if (pending) { enterConfirm(pending); } else { renderIdle(); }
      })
      .then(function () { setBusy(false); });
  }

  renderIdle();
}
