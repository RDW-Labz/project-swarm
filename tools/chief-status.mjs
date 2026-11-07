#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Status view for `swarm orchestrator status` (T-0404): active projects, slot use, and share of machine cap.
// CLI wiring in tools/swarm.mjs (`swarm orchestrator status`) is a follow-up; this module exports the status logic.
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { planCrossProjectWave } from './chief-slots.mjs';

function assertMachineCap(machineCap) {
  planCrossProjectWave([], machineCap);
  return machineCap;
}

function projectSlots(entry) {
  const raw = entry.slotsInUse ?? entry.slots ?? 0;
  const slots = Number(raw);
  if (!Number.isInteger(slots) || slots < 0) {
    const id = entry.project ?? entry.name ?? '?';
    throw new TypeError(`project ${String(id)}: slots must be a non-negative integer`);
  }
  return slots;
}

/**
 * Per-project breakdown from the chief's current state (same project entries as runChiefWave input).
 * @param {{ machineCap?: number, cap?: number, projects?: Array<{ project: string, path?: string, slots?: number, slotsInUse?: number, active?: boolean, name?: string }> }} state
 * @returns {{ machineCap: number, projects: Array<{ project: string, path?: string, slots: number, share: number }> }}
 */
export function chiefOrchestratorStatus(state) {
  const machineCap = assertMachineCap(state?.machineCap ?? state?.cap);
  const entries = Array.isArray(state?.projects) ? state.projects : [];
  const projects = entries
    .filter((entry) => entry && (typeof entry.project === 'string' || typeof entry.name === 'string'))
    .filter((entry) => entry.active !== false)
    .map((entry) => {
      const project = String(entry.project ?? entry.name);
      const slots = projectSlots(entry);
      const share = slots === 0 ? 0 : slots / machineCap;
      const row = { project, slots, share };
      if (entry.path != null) row.path = String(entry.path);
      return row;
    })
    .sort((a, b) => a.project.localeCompare(b.project));
  return { machineCap, projects };
}

/** @deprecated snapshot shape; prefer chiefOrchestratorStatus for chief state. */
export function slotShares(snapshot) {
  const cap = snapshot?.cap;
  if (!Number.isInteger(cap) || cap < 1) {
    throw new TypeError('snapshot.cap must be a positive integer');
  }
  const { machineCap, projects } = chiefOrchestratorStatus({
    machineCap: cap,
    projects: (snapshot?.projects ?? []).map((p) => ({
      project: p?.name,
      slots: p?.slots,
      active: p?.active,
    })),
  });
  return {
    cap: machineCap,
    rows: projects.map((row) => ({ name: row.project, slots: row.slots, share: row.share })),
  };
}

export function formatStatus(snapshot) {
  const { machineCap, projects } = chiefOrchestratorStatus({
    cap: snapshot?.cap,
    projects: (snapshot?.projects ?? []).map((p) => ({
      project: p?.name,
      slots: p?.slots,
      active: p?.active,
    })),
  });
  if (projects.length === 0) {
    return `chief: 0 active projects (cap ${machineCap} slots)`;
  }
  const lines = [`chief: ${projects.length} active project(s), cap ${machineCap} slots`];
  for (const row of projects) {
    lines.push(`${row.project}\t${row.slots}/${machineCap}\t${(row.share * 100).toFixed(1)}%`);
  }
  return lines.join('\n');
}

export function formatOrchestratorStatus(state) {
  const { machineCap, projects } = chiefOrchestratorStatus(state);
  if (projects.length === 0) {
    return `chief: 0 active projects (cap ${machineCap} slots)`;
  }
  const lines = [`chief: ${projects.length} active project(s), cap ${machineCap} slots`];
  for (const row of projects) {
    const label = row.path ? `${row.project} (${row.path})` : row.project;
    lines.push(`${label}\t${row.slots}/${machineCap}\t${(row.share * 100).toFixed(1)}%`);
  }
  return lines.join('\n');
}

function main(argv) {
  const args = argv.slice(2);
  if (args[0] === 'status') {
    const path = args[1];
    if (!path) {
      process.stderr.write('usage: chief-status.mjs status <state.json>\n');
      return 2;
    }
    const state = JSON.parse(readFileSync(path, 'utf8'));
    process.stdout.write(formatOrchestratorStatus(state) + '\n');
    return 0;
  }
  const path = args[0];
  if (!path) {
    process.stderr.write('usage: chief-status.mjs <snapshot.json>\n       chief-status.mjs status <state.json>\n');
    return 2;
  }
  const snapshot = JSON.parse(readFileSync(path, 'utf8'));
  process.stdout.write(formatStatus(snapshot) + '\n');
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv);
}
