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

function decisionBoardSafeOnClient(item) {
  if (!item || String(item.kind) !== 'decision') { return true; }
  return item.boardSafe === true;
}

function itemOptions(item) {
  if (Array.isArray(item.options) && item.options.length) {
    return item.options.map(function (option) {
      if (option && typeof option === 'object') {
        return { label: String(option.label), recommended: option.recommended === true };
      }
      return { label: String(option), recommended: false };
    });
  }
  return [];
}

function isYesNoOptions(options) {
  if (!options || options.length !== 2) { return false; }
  var labels = options.map(function (o) { return String(o.label).toLowerCase(); }).sort();
  var joined = labels.join(',');
  return joined === 'approve,deny' || joined === 'no,yes';
}

function optionButtonLabel(option) {
  if (option.recommended) { return option.label + ' (recommended)'; }
  return option.label;
}

export function ownerActionAvailable(item, options) {
  if (!options || !options.signedIn) { return false; }
  if (!item || item.needsOwner !== true) { return false; }
  if (!decisionBoardSafeOnClient(item)) { return false; }
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
  var itemKind = String(item.kind);
  var decisionOptions = itemKind === 'decision' ? itemOptions(item) : [];
  var yesNo = itemKind === 'decision' && isYesNoOptions(decisionOptions);
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
    if (itemKind === 'decision' && decisionOptions.length) {
      if (yesNo) {
        var approve = el(doc, 'button', 'owner-approve', 'Approve');
        approve.type = 'button';
        var deny = el(doc, 'button', 'owner-deny', 'Deny');
        deny.type = 'button';
        approve.addEventListener('click', function () { enterConfirm({ decision: 'approve' }); });
        deny.addEventListener('click', function () { enterConfirm({ decision: 'deny' }); });
        row.appendChild(approve);
        row.appendChild(deny);
        return;
      }
      decisionOptions.forEach(function (option) {
        var btn = el(doc, 'button', 'owner-option', optionButtonLabel(option));
        btn.type = 'button';
        btn.addEventListener('click', function () { enterConfirm({ choice: option.label }); });
        row.appendChild(btn);
      });
      return;
    }
    var approve = el(doc, 'button', 'owner-approve', 'Approve');
    approve.type = 'button';
    var deny = el(doc, 'button', 'owner-deny', 'Deny');
    deny.type = 'button';
    approve.addEventListener('click', function () { enterConfirm({ decision: 'approve' }); });
    deny.addEventListener('click', function () { enterConfirm({ decision: 'deny' }); });
    row.appendChild(approve);
    row.appendChild(deny);
  }

  function confirmLabel(pendingAnswer) {
    if (pendingAnswer.choice) {
      return 'Answer "' + pendingAnswer.choice + '"?';
    }
    if (pendingAnswer.decision === 'approve') { return 'Confirm approve?'; }
    return 'Confirm deny?';
  }

  function enterConfirm(pendingAnswer) {
    pending = pendingAnswer;
    row.textContent = '';
    var confirmBtn = el(doc, 'button', 'owner-confirm', confirmLabel(pendingAnswer));
    confirmBtn.type = 'button';
    var cancel = el(doc, 'button', 'owner-cancel', 'Cancel');
    cancel.type = 'button';
    cancel.addEventListener('click', function () { if (!busy) { renderIdle(); } });
    confirmBtn.addEventListener('click', function () { submitDecision(pendingAnswer); });
    row.appendChild(confirmBtn);
    row.appendChild(cancel);
  }

  function yesNoLabel(decision) {
    var wantApprove = decision === 'approve';
    var match = decisionOptions.find(function (option) {
      var lower = String(option.label).toLowerCase();
      return wantApprove ? (lower === 'approve' || lower === 'yes') : (lower === 'deny' || lower === 'no');
    });
    return match ? match.label : null;
  }

  function prepareBody(pendingAnswer) {
    if (pendingAnswer.choice) {
      return JSON.stringify({ choice: pendingAnswer.choice });
    }
    if (itemKind === 'decision' && yesNo && pendingAnswer.decision) {
      var mapped = yesNoLabel(pendingAnswer.decision);
      if (mapped) { return JSON.stringify({ choice: mapped }); }
    }
    return '{}';
  }

  function decisionBody(pendingAnswer, confirmToken) {
    if (pendingAnswer.choice) {
      return JSON.stringify({ choice: pendingAnswer.choice, confirm: confirmToken });
    }
    return JSON.stringify({ decision: pendingAnswer.decision, confirm: confirmToken });
  }

  function submitDecision(pendingAnswer) {
    if (busy) { return; }
    setBusy(true);
    showStatus('');
    var prepareUrl = actionPath(itemId, 'prepare');
    fetchImpl(prepareUrl, { method: 'POST', headers: authHeaders(token), body: prepareBody(pendingAnswer) })
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
          body: decisionBody(pendingAnswer, confirmToken),
        }).then(function (res) {
          return res.json().catch(function () { return null; }).then(function (body) {
            if (!res.ok) { throw new Error(readError(body)); }
            return body;
          });
        });
      })
      .then(function (result) {
        row.textContent = '';
        var msg = result && result.result ? String(result.result) : (pendingAnswer.decision === 'approve' ? 'Approved' : (pendingAnswer.choice ? 'Recorded' : 'Denied'));
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
