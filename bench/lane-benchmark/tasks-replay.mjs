// SPDX-License-Identifier: Apache-2.0
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TEST = ['node', '--import', './tests/_isolate-config.mjs', '--test'];
const dir = path.dirname(fileURLToPath(import.meta.url));
const selectedPath = path.join(dir, 'replay-selected.json');

function buildPrompt(entry) {
  const acceptance = (entry.acceptance ?? []).map(line => `- ${line}`).join('\n');
  const files = entry.files.join(', ');
  return `${entry.title}\n\nAcceptance:\n${acceptance}\n\nImplement in: ${files}`;
}

function loadSelected() {
  const raw = JSON.parse(fs.readFileSync(selectedPath, 'utf8'));
  return raw.selected ?? raw;
}

/** @param {object[]} rows from replay-selected.json plus ticket metadata merged in */
export function tasksFromSelected(rows, ticketLookup) {
  return rows.map(entry => {
    const meta = ticketLookup?.get(entry.id) ?? entry;
    const context = meta.context ?? entry.context ?? [];
    const acceptance = meta.acceptance ?? entry.acceptance ?? [];
    return {
      id: entry.id,
      type: entry.type,
      ledger: entry.ledger,
      baseCommit: entry.baseCommit,
      mergeCommit: entry.mergeCommit,
      prompt: buildPrompt({ ...entry, acceptance }),
      context,
      outputs: entry.files,
      verify: {
        argv: [...TEST, ...entry.tests],
        testsFromMerge: entry.tests,
        mergeCommit: entry.mergeCommit,
      },
    };
  });
}

export function loadReplayTasks() {
  if (!fs.existsSync(selectedPath)) return [];
  const rows = loadSelected();
  const ticketsById = new Map();
  const inputDir = path.join(dir, 'replay-input');
  for (const file of ['roadmap-tickets.json', 'swarm-tickets.json']) {
    const ledger = JSON.parse(fs.readFileSync(path.join(inputDir, file), 'utf8'));
    for (const t of ledger.tickets) ticketsById.set(t.id, t);
  }
  return tasksFromSelected(rows, ticketsById);
}

export function getReplayTasks() {
  return loadReplayTasks();
}
