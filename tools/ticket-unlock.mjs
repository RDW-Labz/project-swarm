// SPDX-License-Identifier: Apache-2.0

function hasNoAttempts(ticket) {
  const a = ticket.attempts;
  if (a === undefined || a === null || a === 0) return true;
  if (Array.isArray(a) && a.length === 0) return true;
  return false;
}

function hasNoRetryNote(ticket) {
  const n = ticket.retryNote;
  return n === undefined || n === null || n === '';
}

function blockReasonAllowsUnlock(ticket) {
  const r = ticket.blockReason;
  // Only a recorded dependency block unlocks by itself; an unknown reason (an older ledger) could be a failure or an owner's hold.
  return r === 'deps';
}

export function findUnlockable(tickets) {
  const list = Array.isArray(tickets) ? tickets : [];
  const byId = new Map();
  for (const t of list) {
    if (t && typeof t.id === 'string') byId.set(t.id, t);
  }
  const ids = [];
  for (const t of list) {
    if (!t || typeof t.id !== 'string') continue;
    if (t.status !== 'blocked') continue;
    if (!blockReasonAllowsUnlock(t)) continue;
    if (!hasNoAttempts(t)) continue;
    if (!hasNoRetryNote(t)) continue;
    const deps = t.dependsOn;
    if (!Array.isArray(deps) || deps.length === 0) continue;
    let allDone = true;
    for (const depId of deps) {
      const dep = byId.get(depId);
      if (!dep || dep.status !== 'done') {
        allDone = false;
        break;
      }
    }
    if (allDone) ids.push(t.id);
  }
  return ids.sort();
}

export function unlockReady(ledger) {
  const copy = structuredClone(ledger);
  const tickets = copy && Array.isArray(copy.tickets) ? copy.tickets : [];
  const unlocked = findUnlockable(tickets);
  const set = new Set(unlocked);
  for (const t of tickets) {
    if (t && set.has(t.id)) t.status = 'ready';
  }
  return { ledger: copy, unlocked };
}
