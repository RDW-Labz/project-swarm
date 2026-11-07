// SPDX-License-Identifier: Apache-2.0
import { needsHuman } from './approval-policy.mjs';
import { isProtectedTopic } from './board-action-guard.mjs';
import { readState } from './handbuild.mjs';

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

function rawChoiceLabels(item) {
  const values = [];
  const id = String(item?.id ?? '');
  if (item?.kind === 'decision' && id.startsWith('handbuild-') && !item?.choiceOptions?.length && !item?.choices?.length) {
    values.push('approve', 'deny');
  }
  if (Array.isArray(item?.choiceOptions)) values.push(...item.choiceOptions);
  if (Array.isArray(item?.options)) {
    for (const option of item.options) {
      if (option && typeof option === 'object' && option.label !== undefined) values.push(option.label);
      else values.push(option);
    }
  }
  if (Array.isArray(item?.choices)) values.push(...item.choices);
  return values.map(value => String(value));
}

export function decisionOptionsForItem(item) {
  const defaultLabel = item?.defaultChoice ?? item?.default ?? null;
  const defaultStr = defaultLabel === null || defaultLabel === undefined ? null : String(defaultLabel);
  const seen = new Set();
  const labels = [];
  const add = value => {
    const label = String(value ?? '');
    if (!label || seen.has(label)) return;
    seen.add(label);
    labels.push(label);
  };
  if (defaultStr !== null) add(defaultStr);
  for (const value of rawChoiceLabels(item)) add(value);
  return labels.map(label => ({
    label,
    recommended: defaultStr !== null && label === defaultStr,
  }));
}

export function isYesNoDecisionOptions(options) {
  if (!Array.isArray(options) || options.length !== 2) return false;
  const labels = options.map(option => String(option.label).toLowerCase()).sort();
  const joined = labels.join(',');
  return joined === 'approve,deny' || joined === 'no,yes';
}

function guardKindForChoice(choice) {
  const lower = String(choice ?? '').toLowerCase();
  if (lower === 'deny' || lower === 'no') return 'deny';
  return 'approve';
}

function decisionChoiceValues(item) {
  return decisionOptionsForItem(item).map(option => option.label);
}

export function ownerItemsFromBoardInbox(inbox) {
  return (inbox?.items ?? []).map(item => {
    const base = {
      id: item.id,
      kind: item.kind,
      title: item.title,
      text: item.text ?? item.title,
      summary: item.title,
      projectId: item.projectId,
      ...(item.projectRoot ? { projectRoot: item.projectRoot } : {}),
      ...(item.boardSafe === true ? { boardSafe: true } : {}),
      ...(item.defaultChoice !== undefined ? { defaultChoice: String(item.defaultChoice) } : {}),
      ...(Array.isArray(item.choiceOptions) ? { choiceOptions: item.choiceOptions.map(String) } : {}),
      ...(item.kind === 'decision' && typeof item.protectedTopic === 'boolean' ? { protectedTopic: item.protectedTopic } : {}),
    };
    if (item.kind === 'decision') {
      base.options = decisionOptionsForItem(base);
    }
    return base;
  });
}

function handbuildRequestId(item) {
  const id = String(item?.id ?? '');
  if (id.startsWith('handbuild-')) return id.slice('handbuild-'.length);
  if (item?.kind === 'handbuild' && id) return id;
  return null;
}

function handbuildRequestFieldsProtected(request) {
  if (!request || typeof request !== 'object') return true;
  if (isProtectedTopic(request.kind)) return true;
  if (isProtectedTopic(request.reason)) return true;
  for (const file of request.files ?? []) {
    if (isProtectedTopic(file)) return true;
  }
  for (const git of request.git ?? []) {
    if (isProtectedTopic(git)) return true;
  }
  return false;
}

/** Board may answer hand-build decisions only when the live store row is pending and not topic-protected. */
export function handbuildBoardSafeForOwner(item, root) {
  const hbId = handbuildRequestId(item);
  if (!hbId || !root) return { ok: true };
  const request = readState(root).requests?.[hbId];
  if (!request) return { ok: false };
  if (request.status !== 'pending') return { ok: false };
  if (handbuildRequestFieldsProtected(request)) return { ok: false };
  return { ok: true };
}

export function decisionBoardSafeForOwner(item) {
  if (!item || item.kind !== 'decision') return true;
  if (item.boardSafe !== true) return false;
  // protectedTopic is computed in boardInbox on the full event before display clipping.
  if (item.protectedTopic !== false) return false;
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
    choice: entry?.choice ?? null,
    kind: entry?.kind ?? null,
    identity: safeIdentity(entry?.identity),
    outcome: entry?.outcome ?? null,
  }));
}

function resolveDecisionChoice(item, body) {
  const options = decisionOptionsForItem(item);
  const labels = new Set(options.map(option => option.label));
  if (body?.choice !== undefined && body?.choice !== null) {
    const choice = String(body.choice);
    if (!labels.has(choice)) return { error: response(422, 'unknown-choice', 'the choice is not one of this decision\'s options') };
    return { choice };
  }
  if (!DECISIONS.has(body?.decision)) return { error: response(422, 'not-owner-decidable', 'decision and confirm are required') };
  if (!isYesNoDecisionOptions(options)) {
    return { error: response(422, 'not-owner-decidable', 'decision and confirm are required') };
  }
  const wantApprove = body.decision === 'approve';
  const match = options.find(option => {
    const lower = option.label.toLowerCase();
    return wantApprove ? (lower === 'approve' || lower === 'yes') : (lower === 'deny' || lower === 'no');
  });
  if (!match) return { error: response(422, 'not-owner-decidable', 'decision and confirm are required') };
  return { choice: match.label };
}

function parsePrepareBody(body, item) {
  const value = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  const keys = Object.keys(value);
  if (keys.some(key => key !== 'choice')) {
    return { error: response(422, 'not-owner-decidable', 'decision and confirm are required') };
  }
  if (item.kind !== 'decision') return { choice: null };
  if (value.choice === undefined || value.choice === null || String(value.choice).length === 0) {
    return { error: response(422, 'not-owner-decidable', 'decision and confirm are required') };
  }
  const choice = String(value.choice);
  const labels = new Set(decisionChoiceValues(item));
  if (!labels.has(choice)) return { error: response(422, 'unknown-choice', 'the choice is not one of this decision\'s options') };
  return { choice };
}

function parseDecideBody(body, item) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { error: response(422, 'not-owner-decidable', 'decision and confirm are required') };
  }
  if (typeof body.confirm !== 'string' || body.confirm.length === 0) {
    return { error: response(422, 'not-owner-decidable', 'decision and confirm are required') };
  }
  if (body.reason !== undefined && (typeof body.reason !== 'string' || body.reason.length === 0 || body.reason.length > 2000)) {
    return { error: response(422, 'not-owner-decidable', 'decision and confirm are required') };
  }
  const keys = Object.keys(body);
  if (item.kind === 'decision') {
    const allowed = new Set(['choice', 'decision', 'confirm', 'reason']);
    if (keys.some(key => !allowed.has(key))) {
      return { error: response(422, 'not-owner-decidable', 'decision and confirm are required') };
    }
    const resolved = resolveDecisionChoice(item, body);
    if (resolved.error) return resolved;
    return { choice: resolved.choice, confirm: body.confirm, reason: body.reason };
  }
  if (keys.some(key => !['decision', 'confirm', 'reason'].includes(key)) || !DECISIONS.has(body.decision)) {
    return { error: response(422, 'not-owner-decidable', 'decision and confirm are required') };
  }
  return { decision: body.decision, confirm: body.confirm, reason: body.reason };
}

function outcomeFor(item, choice, decision) {
  if (item.kind === 'decision') return 'answered';
  return decision === 'approve' ? 'approved' : 'denied';
}

export function createOwnerActions({
  listItems,
  appendAudit,
  readAudit,
  guard,
  apply,
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
  const applyFn = typeof apply === 'function'
    ? apply
    : async () => ({ ok: true });

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
    const handbuildRoot = item.projectRoot;
    if (handbuildRoot && handbuildRequestId(item)) {
      const handbuildSafe = handbuildBoardSafeForOwner(item, handbuildRoot);
      if (!handbuildSafe.ok) {
        return {
          error: response(403, 'handbuild-not-board-safe', 'this hand-build request is not board-safe from the store'),
          outcome: 'refused-handbuild-not-board-safe',
        };
      }
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

  const auditEntry = (time, itemId, identity, outcome, fields = {}) => ({
    at: new Date(time).toISOString(),
    itemId: typeof itemId === 'string' ? itemId : String(itemId ?? ''),
    identity: safeIdentity(identity),
    outcome,
    ...fields,
  });

  const refusal = async (time, itemId, body, identity, result) => {
    const decision = body?.decision && DECISIONS.has(body.decision) ? body.decision : null;
    const choice = body?.choice !== undefined ? String(body.choice) : null;
    await appendAudit(auditEntry(time, itemId, identity, result.outcome, {
      ...(decision ? { decision } : {}),
      ...(choice ? { choice } : {}),
    }));
    return result.response;
  };

  const prepare = async (itemId, req = {}, body = {}) => {
    const time = clock(now);
    sweepExpired(time);
    const authorized = auth(req);
    if (authorized.status) return authorized;
    const checked = await itemCheck(itemId);
    if (checked.error) return checked.error;
    const parsed = parsePrepareBody(body, checked.item);
    if (parsed.error) return parsed.error;

    const guardError = await guardItem('approve', checked.item.kind);
    if (guardError) return guardError.error;

    capPendingForIdentity(authorized.identity, time);
    let confirmToken = String(randomId());
    while (confirms.has(confirmToken)) confirmToken = `${String(randomId())}-${++confirmSuffix}`;
    const expiresAt = time + Math.max(0, Number(confirmTtlMs) || 0);
    confirms.set(confirmToken, {
      itemId,
      identity: authorized.identity,
      expiresAt,
      createdAt: time,
      ...(parsed.choice !== null && parsed.choice !== undefined ? { choice: parsed.choice } : {}),
    });
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

    const parsed = parseDecideBody(body, checked.item);
    if (parsed.error) {
      return refusal(time, itemId, body, authorized.identity, { response: parsed.error, outcome: 'refused-invalid-request' });
    }

    const pending = confirms.get(parsed.confirm);
    if (!pending || pending.itemId !== itemId || pending.identity !== authorized.identity) {
      return refusal(time, itemId, body, authorized.identity, { response: response(409, 'confirm-conflict', 'the confirmation is invalid, expired, or bound to another owner'), outcome: 'refused-confirmation' });
    }
    if (pending.expiresAt <= time) {
      confirms.delete(parsed.confirm);
      return refusal(time, itemId, body, authorized.identity, { response: response(409, 'confirm-conflict', 'the confirmation is expired'), outcome: 'refused-confirmation-expired' });
    }

    const item = checked.item;
    const choice = parsed.choice ?? null;
    const decision = parsed.decision ?? (choice !== null ? guardKindForChoice(choice) : null);
    if (item.kind === 'decision' && pending.choice !== undefined && pending.choice !== choice) {
      return refusal(time, itemId, body, authorized.identity, { response: response(409, 'confirm-conflict', 'the confirmation is bound to a different choice'), outcome: 'refused-confirmation' });
    }

    const guardError = await guardItem(decision, item.kind);
    if (guardError) {
      return refusal(time, itemId, body, authorized.identity, {
        response: guardError.error,
        outcome: `refused-${guardError.error.body.error}`,
      });
    }

    confirms.delete(parsed.confirm);

    let applyResult;
    try {
      applyResult = await applyFn(item, { choice, decision }, { identity: authorized.identity, now: () => time });
    } catch {
      applyResult = { ok: false, message: 'the action could not be applied' };
    }
    if (!applyResult || applyResult.ok !== true) {
      const message = typeof applyResult?.message === 'string' && applyResult.message.trim()
        ? applyResult.message.trim().slice(0, 400)
        : 'the action could not be applied';
      await appendAudit(auditEntry(time, itemId, authorized.identity, 'apply-failed', {
        kind: item.kind,
        ...(decision ? { decision } : {}),
        ...(choice !== null ? { choice } : {}),
      }));
      return { status: 409, body: { error: 'apply-failed', message } };
    }

    const result = outcomeFor(item, choice, decision);
    const audit = auditEntry(time, itemId, authorized.identity, result, {
      kind: item.kind,
      ...(decision ? { decision } : {}),
      ...(choice !== null ? { choice } : {}),
    });
    await appendAudit(audit);
    return {
      status: 200,
      body: {
        itemId,
        ...(decision ? { decision } : {}),
        ...(choice !== null ? { choice } : {}),
        result,
        audit,
      },
    };
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
