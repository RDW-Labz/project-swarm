// SPDX-License-Identifier: Apache-2.0
// Board approve/deny core (Item G part 1): pairing, device tokens, one-time decision ids, CSRF, and audit — server-side only.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { PHONE_ACTIONS } from './phone.mjs';

export const ALLOWED_BOARD_ACTIONS = Object.freeze([...PHONE_ACTIONS]);
export const ELEVATED_NEVER_FROM_BOARD = Object.freeze([
  'merge',
  'deploy',
  'publish',
  'cap raise',
  'force-push',
  'branch-D',
  'override',
  'accept unmet acceptance',
]);

export const PAIRING_VALID_MS = 10 * 60 * 1000;
export const PAIRING_LOCK_MS = 15 * 60 * 1000;
export const MAX_PAIRING_WRONG = 3;
export const REQUEST_WINDOW_MS = 24 * 60 * 60 * 1000;

const WORD_A = ['amber', 'birch', 'cedar', 'dune', 'ember', 'fjord', 'grove', 'heron', 'iris', 'jade', 'kelp', 'lark'];
const WORD_B = ['otter', 'pine', 'quartz', 'reed', 'slate', 'tide', 'umber', 'vale', 'wren', 'yarrow', 'zinc', 'moss'];
const WORD_C = ['cloud', 'delta', 'elm', 'fern', 'glen', 'hawk', 'ink', 'juniper', 'knoll', 'lake', 'mist', 'nova'];

const norm = v => String(v ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
const sha256 = v => createHash('sha256').update(String(v)).digest('hex');
const sameSecret = (a, b) => {
  const x = Buffer.from(String(a), 'utf8');
  const y = Buffer.from(String(b), 'utf8');
  return x.length === y.length && timingSafeEqual(x, y);
};

function defaultRandom(n) {
  return Math.floor(Math.random() * n);
}

function pairingWord(random) {
  const r = random ?? defaultRandom;
  return `${WORD_A[r(WORD_A.length)]}-${WORD_B[r(WORD_B.length)]}-${WORD_C[r(WORD_C.length)]}`;
}

function ensureState(store) {
  if (!store.data || typeof store.data !== 'object') store.data = {};
  const d = store.data;
  if (!d.devices || typeof d.devices !== 'object') d.devices = {};
  if (!d.decisions || typeof d.decisions !== 'object') d.decisions = {};
  if (!Number.isFinite(d.pairingWrong)) d.pairingWrong = 0;
  return d;
}

function elevatedTokens() {
  return ELEVATED_NEVER_FROM_BOARD.map(norm);
}

export function itemElevatedSignals(item) {
  const out = [];
  if (item?.kind) out.push(String(item.kind));
  if (Array.isArray(item?.git)) out.push(...item.git.map(String));
  if (Array.isArray(item?.elevated)) out.push(...item.elevated.map(String));
  if (typeof item?.elevated === 'string') out.push(item.elevated);
  return out;
}

export function isItemElevated(item) {
  const tokens = elevatedTokens();
  for (const raw of itemElevatedSignals(item)) {
    const n = norm(raw).replace(/-/g, ' ');
    for (const t of tokens) {
      const tn = t.replace(/-/g, ' ');
      if (n === tn || n.includes(tn) || tn.includes(n)) return true;
    }
  }
  return false;
}

function handbuildId(item) {
  const id = String(item?.id ?? item?.itemId ?? '');
  if (id.startsWith('handbuild-')) return id.slice('handbuild-'.length);
  return id;
}

function actionAllowedForItem(item, action, choice) {
  if (!ALLOWED_BOARD_ACTIONS.includes(action)) return false;
  const kind = String(item?.kind ?? '');
  if (action === 'stop-all') return kind === 'stop' || String(item?.id ?? '') === 'panic';
  if (action === 'approve-ticket') return kind === 'ticket' || kind === 'proposed-ticket';
  if (action === 'decline') return true;
  if (action === 'choose') {
    const picked = String(choice ?? '').trim();
    if (!picked) return false;
    if (kind === 'handbuild' || String(item?.id ?? '').startsWith('handbuild-')) {
      return picked === 'approve' || picked === 'deny';
    }
    if (kind === 'decision' && Array.isArray(item.choices)) {
      return item.choices.map(String).includes(picked);
    }
    return false;
  }
  return false;
}

/** False for elevated items or actions outside the fixed board allow-list. */
export function isAllowedFromBoard(item, action, choice) {
  if (!item || typeof item !== 'object') return false;
  if (isItemElevated(item)) return false;
  return actionAllowedForItem(item, action, choice);
}

function deviceCount(store) {
  return Object.keys(ensureState(store).devices).length;
}

function hashDeviceToken(token) {
  return sha256(`board-device:${token}`);
}

function newDeviceToken(random) {
  if (typeof random === 'function') return `bd_${random(1e9).toString(36)}${random(1e9).toString(36)}`;
  return `bd_${randomBytes(24).toString('hex')}`;
}

function newDecisionId(random) {
  const r = random ?? defaultRandom;
  return `dec-${Date.now().toString(36)}-${r(1e6).toString(36)}`;
}

function newCsrf(random) {
  return randomBytes(18).toString('base64url');
}

function snapshotItem(item, store) {
  return {
    id: String(item.id ?? item.itemId ?? ''),
    kind: String(item.kind ?? ''),
    projectId: String(item.projectId ?? item.project ?? store.projectId ?? ''),
    machineId: String(item.machineId ?? store.machineId ?? ''),
    title: String(item.title ?? item.id ?? '').slice(0, 120),
    choices: Array.isArray(item.choices) ? item.choices.map(c => String(c)).slice(0, 9) : undefined,
    git: Array.isArray(item.git) ? item.git.map(String) : undefined,
  };
}

function itemExpiryMs(item, now) {
  const t = item?.expiresAt ?? item?.expiresAtMs;
  if (Number.isFinite(t)) return t;
  if (typeof t === 'string') {
    const p = Date.parse(t);
    if (Number.isFinite(p)) return p;
  }
  return now + REQUEST_WINDOW_MS;
}

function confirmText(action, item, choice) {
  const project = String(item.projectId ?? item.project ?? 'project');
  const id = String(item.id ?? item.itemId ?? '');
  const kind = String(item.kind ?? '');
  if (kind === 'handbuild' || id.startsWith('handbuild-')) {
    const hb = handbuildId(item);
    if (action === 'choose' && choice === 'approve') return `Approve hand-build ${hb} on ${project}?`;
    if (action === 'choose' && choice === 'deny') return `Deny hand-build ${hb} on ${project}?`;
    if (action === 'decline') return `Deny hand-build ${hb} on ${project}?`;
  }
  if (action === 'approve-ticket') return `Approve ticket ${id} on ${project}?`;
  if (action === 'decline') return `Decline ${kind || 'item'} ${id} on ${project}?`;
  if (action === 'stop-all') return `Stop all runs on ${project}?`;
  if (action === 'choose' && choice) return `Choose "${choice}" for ${id} on ${project}?`;
  return `${action} ${id} on ${project}?`;
}

export async function appendAudit({ store, entry }) {
  const line = {
    at: entry.at ?? new Date().toISOString(),
    who: String(entry.who ?? '').slice(0, 80),
    device: String(entry.device ?? '').slice(0, 80),
    action: String(entry.action ?? ''),
    itemId: String(entry.itemId ?? ''),
    projectId: String(entry.projectId ?? ''),
    machineId: String(entry.machineId ?? store.machineId ?? ''),
    result: String(entry.result ?? ''),
  };
  const file = store.auditPath;
  if (!file) {
    if (!Array.isArray(store._audit)) store._audit = [];
    store._audit.push(line);
    return;
  }
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await fs.appendFile(file, `${JSON.stringify(line)}\n`, { mode: 0o600 });
}

export async function listAudit({ store, limit = 50 }) {
  const file = store.auditPath;
  let lines = [];
  if (file) {
    try {
      const text = await fs.readFile(file, 'utf8');
      lines = text.trim().split('\n').filter(Boolean);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  } else if (Array.isArray(store._audit)) {
    lines = store._audit.map(l => JSON.stringify(l));
  }
  const parsed = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  return parsed.sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, limit);
}

async function auditAttempt(store, { who, device, action, item, result }) {
  await appendAudit({
    store,
    entry: {
      who,
      device: device?.name ?? device ?? '',
      action,
      itemId: String(item?.id ?? item?.itemId ?? ''),
      projectId: String(item?.projectId ?? item?.project ?? store.projectId ?? ''),
      machineId: String(item?.machineId ?? store.machineId ?? ''),
      result,
    },
  });
}

export function createPairing({ store, now = Date.now, random }) {
  const d = ensureState(store);
  const ms = typeof now === 'function' ? now() : now;
  if (Number.isFinite(d.pairingLockedUntil) && ms < d.pairingLockedUntil) {
    return { ok: false, error: 'pairing-locked' };
  }
  const word = pairingWord(random);
  d.pairing = { wordHash: sha256(word), expiresAt: ms + PAIRING_VALID_MS, used: false };
  d.pairingWrong = 0;
  return { ok: true, word, expiresAt: d.pairing.expiresAt };
}

export function redeemPairing({ store, word, deviceName, now = Date.now, random }) {
  const d = ensureState(store);
  const ms = typeof now === 'function' ? now() : now;
  const name = String(deviceName ?? '').trim().slice(0, 80);
  if (!name) return { ok: false, error: 'device-name-required' };
  if (Number.isFinite(d.pairingLockedUntil) && ms < d.pairingLockedUntil) {
    return { ok: false, error: 'pairing-locked' };
  }
  const p = d.pairing;
  if (!p || p.used) return refusePairing(store, ms, 'pairing-invalid');
  if (ms > p.expiresAt) return refusePairing(store, ms, 'pairing-expired');
  if (!sameSecret(sha256(word), p.wordHash)) return refusePairing(store, ms, 'pairing-wrong');
  p.used = true;
  delete d.pairing;
  const token = newDeviceToken(random);
  const deviceId = `dev-${sha256(token).slice(0, 12)}`;
  d.devices[deviceId] = {
    tokenHash: hashDeviceToken(token),
    name,
    createdAt: ms,
    lastSeen: ms,
  };
  return { ok: true, deviceId, token };
}

function refusePairing(store, ms, reason) {
  const d = ensureState(store);
  d.pairingWrong = (d.pairingWrong ?? 0) + 1;
  if (d.pairingWrong >= MAX_PAIRING_WRONG) {
    d.pairingLockedUntil = ms + PAIRING_LOCK_MS;
    d.pairingWrong = 0;
    d.pairing = null;
    return { ok: false, error: 'pairing-locked' };
  }
  return { ok: false, error: reason };
}

export function deviceFromToken(store, token) {
  if (!token || deviceCount(store) === 0) return null;
  const hash = hashDeviceToken(token);
  const d = ensureState(store);
  for (const [id, rec] of Object.entries(d.devices)) {
    if (rec?.tokenHash === hash) return { deviceId: id, name: rec.name, createdAt: rec.createdAt, lastSeen: rec.lastSeen };
  }
  return null;
}

function requireDevice(store, token, now) {
  const ms = typeof now === 'function' ? now() : now;
  const dev = deviceFromToken(store, token);
  if (!dev) return { error: 'no-device' };
  const rec = ensureState(store).devices[dev.deviceId];
  if (rec) rec.lastSeen = ms;
  return { device: dev, record: rec };
}

export function issueDecisionIds({ store, items, deviceId, now = Date.now, random }) {
  const ms = typeof now === 'function' ? now() : now;
  const d = ensureState(store);
  if (!deviceId || !d.devices[deviceId]) return { ok: false, error: 'unknown-device', ids: [] };
  const ids = [];
  for (const item of items ?? []) {
    const snap = snapshotItem(item, store);
    const expiresAt = Math.min(ms + REQUEST_WINDOW_MS, itemExpiryMs(item, ms));
    const decisionId = newDecisionId(random);
    d.decisions[decisionId] = {
      decisionId,
      itemId: snap.id,
      projectId: snap.projectId,
      machineId: snap.machineId || String(store.machineId ?? ''),
      deviceId,
      item: snap,
      expiresAt,
      consumed: false,
      prepared: false,
    };
    ids.push({ decisionId, itemId: snap.id, expiresAt });
  }
  return { ok: true, ids };
}

export async function prepareDecision({ store, decisionId, action, choice, deviceToken, who = '', now = Date.now }) {
  const ms = typeof now === 'function' ? now() : now;
  const devOut = requireDevice(store, deviceToken, now);
  if (devOut.error) {
    await auditAttempt(store, { who, device: '', action, item: { id: decisionId }, result: devOut.error });
    return { ok: false, error: devOut.error };
  }
  const d = ensureState(store);
  const rec = d.decisions[decisionId];
  if (!rec) {
    await auditAttempt(store, { who, device: devOut.device, action, item: { id: decisionId }, result: 'unknown-decision' });
    return { ok: false, error: 'unknown-decision' };
  }
  if (rec.consumed) {
    await auditAttempt(store, { who, device: devOut.device, action, item: rec.item, result: 'replayed' });
    return { ok: false, error: 'replayed' };
  }
  if (ms > rec.expiresAt) {
    await auditAttempt(store, { who, device: devOut.device, action, item: rec.item, result: 'expired' });
    return { ok: false, error: 'expired' };
  }
  if (rec.deviceId !== devOut.device.deviceId) {
    await auditAttempt(store, { who, device: devOut.device, action, item: rec.item, result: 'wrong-device' });
    return { ok: false, error: 'wrong-device' };
  }
  if (!isAllowedFromBoard(rec.item, action, choice)) {
    await auditAttempt(store, { who, device: devOut.device, action, item: rec.item, result: 'disallowed-action' });
    return { ok: false, error: 'disallowed-action' };
  }
  const csrf = newCsrf();
  rec.prepared = true;
  rec.action = action;
  rec.choice = choice === undefined ? undefined : String(choice);
  rec.csrfHash = sha256(`${decisionId}:${devOut.device.deviceId}:${csrf}`);
  const confirm = confirmText(action, rec.item, rec.choice);
  await auditAttempt(store, { who, device: devOut.device, action, item: rec.item, result: 'prepared' });
  return { ok: true, confirmText: confirm, csrf };
}

export async function commitDecision({ store, decisionId, csrf, deviceToken, who = '', now = Date.now, apply }) {
  const ms = typeof now === 'function' ? now() : now;
  const devOut = requireDevice(store, deviceToken, now);
  if (devOut.error) {
    await auditAttempt(store, { who, device: '', action: '', item: { id: decisionId }, result: devOut.error });
    return { ok: false, error: devOut.error };
  }
  const d = ensureState(store);
  const rec = d.decisions[decisionId];
  if (!rec) {
    await auditAttempt(store, { who, device: devOut.device, action: rec?.action ?? '', item: { id: decisionId }, result: 'unknown-decision' });
    return { ok: false, error: 'unknown-decision' };
  }
  if (rec.consumed) {
    await auditAttempt(store, { who, device: devOut.device, action: rec.action ?? '', item: rec.item, result: 'replayed' });
    return { ok: false, error: 'replayed' };
  }
  if (ms > rec.expiresAt) {
    await auditAttempt(store, { who, device: devOut.device, action: rec.action ?? '', item: rec.item, result: 'expired' });
    return { ok: false, error: 'expired' };
  }
  if (rec.deviceId !== devOut.device.deviceId) {
    await auditAttempt(store, { who, device: devOut.device, action: rec.action ?? '', item: rec.item, result: 'wrong-device' });
    return { ok: false, error: 'wrong-device' };
  }
  if (!rec.prepared || !rec.csrfHash) {
    await auditAttempt(store, { who, device: devOut.device, action: rec.action ?? '', item: rec.item, result: 'not-prepared' });
    return { ok: false, error: 'not-prepared' };
  }
  const expect = sha256(`${decisionId}:${devOut.device.deviceId}:${csrf}`);
  if (!sameSecret(expect, rec.csrfHash)) {
    await auditAttempt(store, { who, device: devOut.device, action: rec.action ?? '', item: rec.item, result: 'invalid-csrf' });
    return { ok: false, error: 'invalid-csrf' };
  }
  if (!isAllowedFromBoard(rec.item, rec.action, rec.choice)) {
    await auditAttempt(store, { who, device: devOut.device, action: rec.action ?? '', item: rec.item, result: 'disallowed-action' });
    return { ok: false, error: 'disallowed-action' };
  }
  rec.consumed = true;
  const payload = {
    itemId: rec.itemId,
    action: rec.action,
    channel: 'board',
    choice: rec.choice,
    projectId: rec.projectId,
    machineId: rec.machineId,
  };
  let applyResult = 'ok';
  try {
    await apply(payload);
  } catch (error) {
    applyResult = String(error?.message ?? error).slice(0, 200);
    await auditAttempt(store, { who, device: devOut.device, action: rec.action, item: rec.item, result: applyResult });
    return { ok: false, error: applyResult };
  }
  await auditAttempt(store, { who, device: devOut.device, action: rec.action, item: rec.item, result: 'ok' });
  return { ok: true, ...payload };
}
