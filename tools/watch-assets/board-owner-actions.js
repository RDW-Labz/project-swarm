// SPDX-License-Identifier: Apache-2.0
// Approve / deny controls for owner-decidable Needs-you items (tailnet sign-in + board token header only).
// Allowed item kinds: contracts/watch-s4-ops.json components/schemas/allowedKinds
var ALLOWED_OWNER_KINDS = ['handbuild', 'decision', 'proposed-ticket', 'scope'];
var REFUSED_OWNER_WORDS = ['merge', 'deploy', 'cap', 'budget', 'spend', 'key', 'keys', 'secret', 'migration', 'migrate', 'rollback-prod'];

function refusedOwnerKindWords(value) {
  if (typeof value !== 'string') { return null; }
  var trimmed = value.trim();
  if (!trimmed) { return []; }
  var spaced = trimmed
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2');
  return spaced.toLowerCase().split(/[-_.: \t]+/).filter(Boolean);
}

function isRefusedOwnerKind(value) {
  var words = refusedOwnerKindWords(value);
  if (words === null) { return true; }
  if (words.length === 0) { return true; }
  if (words.indexOf('limit') !== -1 && words.indexOf('raise') !== -1) { return true; }
  if (REFUSED_OWNER_WORDS.indexOf(words.join('-')) !== -1) { return true; }
  for (var i = 0; i < words.length; i += 1) {
    if (REFUSED_OWNER_WORDS.indexOf(words[i]) !== -1) { return true; }
  }
  return false;
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

function isAllowedOwnerKind(value) {
  if (typeof value !== 'string') { return false; }
  var normalized = value.trim().toLowerCase();
  if (!normalized) { return false; }
  if (ALLOWED_OWNER_KINDS.indexOf(normalized) === -1) { return false; }
  return !isRefusedOwnerKind(value);
}

export function ownerActionAvailable(item, options) {
  if (!options || !options.signedIn) { return false; }
  if (!item || item.needsOwner !== true) { return false; }
  return isAllowedOwnerKind(item.kind ? String(item.kind) : '');
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
