// SPDX-License-Identifier: Apache-2.0
import { needsHuman } from './approval-policy.mjs';
import { isProtectedTopic } from './board-action-guard.mjs';

// T-0114 must set req.tailnetVerified to true only after Tailscale Serve has
// accepted the request on the loopback watch server; direct and Funnel requests
// must leave it false, regardless of any client-supplied identity header.

const ITEM_ID = /^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,198}[A-Za-z0-9])?$/;
const DECISIONS = new Set(['approve', 'deny']);
const IDENTITY = /^[A-Za-z0-9@._+-]+$/;
const KIND_FIELDS = ['actionKind', 'action', 'itemKind'];

const response = (status, error, message) => ({
  status,
  body: message === undefined ? { error } : { error, message },
});

function header(headers, name) {
  if (!headers || typeof headers !== 'object') return '';
  const wanted = name.toLowerCase();
  const found = Object.entries(headers).find(([key]) => String(key).toLowerCase() === wanted)?.[1];
  return typeof found === 'string' ? found.trim() : '';
}

function clock(now) {
  const value = typeof now === 'function' ? now() : now;
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const parsed = Date.parse(String(value ?? ''));
  return Number.isFinite(parsed) ? parsed : Date.now();
}

function identitiesOf(ownerIdentities) {
  if (ownerIdentities instanceof Set) return ownerIdentities;
  if (Array.isArray(ownerIdentities)) return new Set(ownerIdentities.map(String));
  if (ownerIdentities && typeof ownerIdentities === 'object') return new Set(Object.keys(ownerIdentities));
  return new Set();
}

function validItemId(itemId) {
  return typeof itemId === 'string' && itemId.length <= 200 && ITEM_ID.test(itemId);
}

function itemFor(items, itemId) {
  return (Array.isArray(items) ? items : []).find(item => item && String(item.id) === itemId);
}

function approvalEvent(item, kind) {
  const event = item?.event && typeof item.event === 'object' ? item.event : item;
  return { ...event, kind };
}

function approvalPolicy(item) {
  return item?.approvalPolicy ?? item?.policy ?? item?.approval ?? item?.project?.approvalPolicy;
}

function sameKind(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return left === right;
  return left.trim().toLowerCase() === right.trim().toLowerCase();
}

function hasKindMismatch(item) {
  return KIND_FIELDS.some(field => item?.[field] !== undefined && !sameKind(item[field], item?.kind));
}

function summaryOf(item) {
  return String(item?.summary ?? item?.title ?? item?.text ?? item?.id ?? '');
}

function decisionChoiceValues(item) {
  const values = [];
  if (Array.isArray(item?.options)) values.push(...item.options);
  if (Array.isArray(item?.choices)) values.push(...item.choices);
  return values;
}

export function ownerItemsFromBoardInbox(inbox) {
  return (inbox?.items ?? []).map(item => ({
    id: item.id,
    kind: item.kind,
    title: item.title,
    text: item.text ?? item.title,
    summary: item.title,
    projectId: item.projectId,
    ...(item.boardSafe === true ? { boardSafe: true } : {}),
    ...(Array.isArray(item.choices) ? { choices: item.choices } : {}),
  }));
}

export function decisionBoardSafeForOwner(item) {
  if (!item || item.kind !== 'decision') return true;
  if (item.boardSafe !== true) return false;
  const fields = [
    item.text,
    item.title,
    item.summary,
    item.id,
    ...decisionChoiceValues(item),
  ];
  for (const field of fields) {
    if (field !== undefined && field !== null && isProtectedTopic(field)) return false;
  }
  return true;
}

function safeIdentity(identity) {
  if (identity === undefined || identity === null || identity === '') return null;
  if (typeof identity !== 'string') return 'invalid';
  const clipped = identity.slice(0, 254);
  return IDENTITY.test(clipped) ? clipped : 'invalid';
}

function auditView(entries) {
  return entries.map(entry => ({
    at: entry?.at ?? null,
    itemId: entry?.itemId ?? null,
    decision: entry?.decision ?? null,
    identity: safeIdentity(entry?.identity),
    outcome: entry?.outcome ?? null,
  }));
}

export function createOwnerActions({
  listItems,
  appendAudit,
  readAudit,
  guard,
  now = Date.now,
  randomId,
  ownerIdentities,
  confirmTtlMs = 120000,
  verifyIdentity = () => false,
} = {}) {
  if (typeof listItems !== 'function') throw new TypeError('listItems is required');
  if (typeof appendAudit !== 'function') throw new TypeError('appendAudit is required');
  if (typeof readAudit !== 'function') throw new TypeError('readAudit is required');
  if (typeof guard !== 'function') throw new TypeError('guard is required');
  if (typeof randomId !== 'function') throw new TypeError('randomId is required');

  const owners = identitiesOf(ownerIdentities);
  const confirms = new Map();
  let confirmSuffix = 0;

  const sweepExpired = time => {
    for (const [token, pending] of confirms) {
      if (pending.expiresAt <= time) confirms.delete(token);
    }
  };

  const capPendingForIdentity = (identity, time) => {
    const pending = [...confirms.entries()]
      .filter(([, value]) => value.identity === identity && value.expiresAt > time)
      .sort((a, b) => (a[1].createdAt - b[1].createdAt) || (a[1].expiresAt - b[1].expiresAt));
    while (pending.length >= 5) {
      const [token] = pending.shift();
      confirms.delete(token);
    }
  };

  const auth = req => {
    if (req?.tokenInQuery !== false) return response(401, 'not-signed-in', 'owner routes require x-watch-token');
    if (req?.tokenOk !== true) return response(403, 'owner-forbidden', 'the board token was not accepted');
    const identity = header(req?.headers, 'Tailscale-User-Login');
    if (!identity) return response(401, 'not-signed-in', 'a Tailscale owner identity is required');
    if (req?.tailnetVerified !== true) return response(401, 'not-signed-in', 'the Tailscale owner identity was not verified');
    let verified = false;
    try {
      verified = verifyIdentity(req, identity) === true;
    } catch {
      verified = false;
    }
    if (!verified) return response(401, 'not-signed-in', 'the Tailscale owner identity was not verified');
    const sanitizedIdentity = safeIdentity(identity);
    if (sanitizedIdentity === 'invalid') return response(401, 'not-signed-in', 'the Tailscale owner identity is invalid');
    if (!owners.has(identity)) return response(403, 'owner-forbidden', 'the identity is not an allowed owner');
    if (req?.agentSession !== false) return response(403, 'owner-forbidden', 'agent sessions cannot use owner routes');
    if (req?.local !== false) return response(403, 'owner-forbidden', 'remote board local requests cannot use owner routes');
    return { identity: sanitizedIdentity };
  };

  const itemCheck = async itemId => {
    if (!validItemId(itemId)) return { error: response(404, 'not-found', 'the owner item was not found') };
    const item = itemFor(await listItems(), itemId);
    if (!item) return { error: response(404, 'not-found', 'the owner item was not found') };
    const kind = item.kind;
    if (hasKindMismatch(item)) {
      return {
        error: response(409, 'kind-mismatch', 'the action kind fields do not match'),
        outcome: 'refused-kind-mismatch',
      };
    }
    if (!needsHuman(approvalPolicy(item), approvalEvent(item, kind))) {
      return { error: response(422, 'not-owner-decidable', 'the item is not currently decidable by the owner') };
    }
    if (!decisionBoardSafeForOwner(item)) {
      return {
        error: response(403, 'decision-not-board-safe', 'this decision was not raised as board-safe or names a protected topic'),
        outcome: 'refused-decision-not-board-safe',
      };
    }
    return { item };
  };

  const guardItem = async (kind, itemKind) => {
    const guarded = await guard({ kind, source: 'board', itemKind });
    if (!guarded || guarded.allowed !== true) {
      return { error: response(403, 'owner-forbidden', guarded?.reason || 'the board action is refused') };
    }
    return null;
  };

  const auditEntry = (time, itemId, decision, identity, outcome) => ({
    at: new Date(time).toISOString(),
    itemId: typeof itemId === 'string' ? itemId : String(itemId ?? ''),
    decision: DECISIONS.has(decision) ? decision : null,
    identity: safeIdentity(identity),
    outcome,
  });

  const refusal = async (time, itemId, body, identity, result) => {
    await appendAudit(auditEntry(time, itemId, body?.decision, identity, result.outcome));
    return result.response;
  };

  const prepare = async (itemId, req = {}) => {
    const time = clock(now);
    sweepExpired(time);
    const authorized = auth(req);
    if (authorized.status) return authorized;
    const checked = await itemCheck(itemId);
    if (checked.error) return checked.error;
    // Prepare uses approve only to reject protected item kinds before issuing a token.
    const guardError = await guardItem('approve', checked.item.kind);
    if (guardError) return guardError.error;

    capPendingForIdentity(authorized.identity, time);
    let confirmToken = String(randomId());
    while (confirms.has(confirmToken)) confirmToken = `${String(randomId())}-${++confirmSuffix}`;
    const expiresAt = time + Math.max(0, Number(confirmTtlMs) || 0);
    confirms.set(confirmToken, { itemId, identity: authorized.identity, expiresAt, createdAt: time });
    return {
      status: 200,
      body: {
        confirmToken,
        expiresAt: new Date(expiresAt).toISOString(),
        summary: summaryOf(checked.item),
      },
    };
  };

  const decide = async (itemId, body, req = {}) => {
    const time = clock(now);
    const identity = header(req?.headers, 'Tailscale-User-Login');
    const confirmId = body && typeof body.confirm === 'string' ? body.confirm : '';
    if (confirmId && confirms.has(confirmId)) {
      const pending = confirms.get(confirmId);
      if (pending.expiresAt <= time) {
        confirms.delete(confirmId);
        sweepExpired(time);
        const authorized = auth(req);
        if (authorized.status) {
          return refusal(time, itemId, body, identity, { response: authorized, outcome: 'refused-authentication' });
        }
        return refusal(time, itemId, body, authorized.identity, { response: response(409, 'confirm-conflict', 'the confirmation is expired'), outcome: 'refused-confirmation-expired' });
      }
    }
    sweepExpired(time);
    const authorized = auth(req);
    if (authorized.status) {
      return refusal(time, itemId, body, identity, { response: authorized, outcome: 'refused-authentication' });
    }
    const checked = await itemCheck(itemId);
    if (checked.error) {
      return refusal(time, itemId, body, authorized.identity, {
        response: checked.error,
        outcome: checked.outcome || `refused-${checked.error.body.error}`,
      });
    }
    if (!body || typeof body !== 'object' || Array.isArray(body) || !DECISIONS.has(body.decision) || typeof body.confirm !== 'string' || body.confirm.length === 0 || Object.keys(body).some(key => !['decision', 'confirm', 'reason'].includes(key)) || (body.reason !== undefined && (typeof body.reason !== 'string' || body.reason.length === 0 || body.reason.length > 2000))) {
      return refusal(time, itemId, body, authorized.identity, { response: response(422, 'not-owner-decidable', 'decision and confirm are required'), outcome: 'refused-invalid-request' });
    }

    const guardError = await guardItem(body.decision, checked.item.kind);
    if (guardError) {
      return refusal(time, itemId, body, authorized.identity, {
        response: guardError.error,
        outcome: `refused-${guardError.error.body.error}`,
      });
    }

    const pending = confirms.get(body.confirm);
    if (!pending || pending.itemId !== itemId || pending.identity !== authorized.identity) {
      return refusal(time, itemId, body, authorized.identity, { response: response(409, 'confirm-conflict', 'the confirmation is invalid, expired, or bound to another owner'), outcome: 'refused-confirmation' });
    }
    if (pending.expiresAt <= time) {
      confirms.delete(body.confirm);
      return refusal(time, itemId, body, authorized.identity, { response: response(409, 'confirm-conflict', 'the confirmation is expired'), outcome: 'refused-confirmation-expired' });
    }

    confirms.delete(body.confirm);
    const result = body.decision === 'approve' ? 'approved' : 'denied';
    const audit = auditEntry(time, itemId, body.decision, authorized.identity, result);
    await appendAudit(audit);
    return { status: 200, body: { itemId, decision: body.decision, result, audit } };
  };

  const audit = async (req = {}) => {
    const authorized = auth(req);
    if (authorized.status) return authorized;
    const entries = await readAudit();
    const safe = auditView(Array.isArray(entries) ? entries : []);
    safe.sort((a, b) => String(b.at).localeCompare(String(a.at)));
    return { status: 200, body: safe };
  };

  return { prepare, decide, audit };
}

