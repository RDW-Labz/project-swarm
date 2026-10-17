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
    // A dependency block whose dependencies are gone (cancelled and removed) has nothing left to wait for.
    if (!Array.isArray(deps)) continue;
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

// A todo ticket of an approved ledger whose dependencies are all done (a root ticket has none) is released to ready.
// Human tickets stay todo: a person finishes them.
export function findReleasable(tickets) {
  const list = Array.isArray(tickets) ? tickets : [];
  const done = new Set(list.filter((t) => t && t.status === 'done').map((t) => t.id));
  return list
    .filter((t) => t && t.status === 'todo' && t.type !== 'human' && (Array.isArray(t.dependsOn) ? t.dependsOn : []).every((d) => done.has(d)))
    .map((t) => t.id)
    .sort();
}

export function releaseReady(ledger) {
  const copy = structuredClone(ledger);
  const tickets = copy && Array.isArray(copy.tickets) ? copy.tickets : [];
  const released = findReleasable(tickets);
  const set = new Set(released);
  for (const t of tickets) if (t && set.has(t.id)) t.status = 'ready';
  return { ledger: copy, released };
}
