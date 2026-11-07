// SPDX-License-Identifier: Apache-2.0
// Classify a scope text diff for change-order policy (rename-only vs substantive).
// Wire in tools/scope-commands.mjs when building change-order policy facts:
//   import { classifyChangeOrder } from './change-order-class.mjs';
//   const c = classifyChangeOrder(oldScopeText, newScopeText);
//   facts: { renameOnly: c.renameOnly, renames: c.renames, addedRequirements: c.addedRequirements.length, removedRequirements: c.removedRequirements.length, cancelsTickets: impact.cancel.length, reopensTickets: impact.reopen.length, ... };

const REQ_HEADER = /^### (R-[\w-]+)\b/gm;

function parseRequirementBodies(text) {
  const s = String(text ?? '');
  const headers = [];
  for (const m of s.matchAll(REQ_HEADER)) {
    headers.push({ id: m[1], index: m.index ?? 0 });
  }
  const map = new Map();
  for (let i = 0; i < headers.length; i += 1) {
    const { id, index } = headers[i];
    const end = i + 1 < headers.length ? headers[i + 1].index : s.length;
    map.set(id, s.slice(index, end).trim());
  }
  return map;
}

const PATH_EXT = /\.[A-Za-z0-9][A-Za-z0-9._-]*$/;
const PATH_LIKE = /^(?:\.\/)?(?:[\w@.-]+\/)+[\w@.-]+$|^[\w@.-]+\.[A-Za-z0-9][A-Za-z0-9._-]*$/;

function isPathToken(tok) {
  const t = String(tok ?? '').replace(/^[`'"]|[`'"]$/g, '');
  if (!t || /\s/.test(t)) return false;
  if (PATH_EXT.test(t)) return true;
  if (t.includes('/')) return true;
  return PATH_LIKE.test(t);
}

function tokenizeLine(line) {
  return String(line ?? '').trim().split(/\s+/).filter(Boolean);
}

function linePairRename(oldLine, newLine) {
  const a = tokenizeLine(oldLine);
  const b = tokenizeLine(newLine);
  if (a.length !== b.length || a.length === 0) return null;
  const pairs = [];
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] === b[i]) continue;
    if (!isPathToken(a[i]) || !isPathToken(b[i])) return null;
    pairs.push({ from: a[i], to: b[i] });
  }
  if (!pairs.length) return null;
  return pairs;
}

function bodyLines(body) {
  return String(body ?? '').split('\n').map(l => l.trim()).filter(Boolean);
}

/** @returns {{ renameOnly: boolean, renames: {from:string,to:string}[], addedRequirements: string[], removedRequirements: string[], changedRequirements: string[], reasons: string[] }} */
export function classifyChangeOrder(oldScopeText, newScopeText) {
  const oldMap = parseRequirementBodies(oldScopeText);
  const newMap = parseRequirementBodies(newScopeText);
  const addedRequirements = [...newMap.keys()].filter(id => !oldMap.has(id));
  const removedRequirements = [...oldMap.keys()].filter(id => !newMap.has(id));
  const changedRequirements = [...newMap.keys()].filter(id => oldMap.has(id) && oldMap.get(id) !== newMap.get(id));
  const reasons = [];
  const renames = [];

  if (addedRequirements.length) reasons.push('requirements added');
  if (removedRequirements.length) reasons.push('requirements removed');

  for (const id of changedRequirements) {
    const oldLines = bodyLines(oldMap.get(id));
    const newLines = bodyLines(newMap.get(id));
    if (oldLines.length !== newLines.length) {
      reasons.push(`requirement ${id}: line count changed`);
      continue;
    }
    for (let li = 0; li < oldLines.length; li += 1) {
      if (oldLines[li] === newLines[li]) continue;
      const pair = linePairRename(oldLines[li], newLines[li]);
      if (!pair) {
        reasons.push(`requirement ${id}: non-path wording change`);
        break;
      }
      renames.push(...pair);
    }
  }

  const unique = [];
  const seen = new Set();
  for (const r of renames) {
    const key = `${r.from}\0${r.to}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(r);
  }

  let renameOnly = false;
  if (!addedRequirements.length && !removedRequirements.length && changedRequirements.length && !reasons.length) {
    if (unique.length >= 1 && unique.length <= 5) renameOnly = true;
    else if (unique.length > 5) reasons.push('more than five path renames');
    else reasons.push('no path renames');
  } else if (!changedRequirements.length && !addedRequirements.length && !removedRequirements.length) {
    reasons.push('scope text unchanged');
  }

  return {
    renameOnly,
    renames: unique,
    addedRequirements,
    removedRequirements,
    changedRequirements,
    reasons,
  };
}
