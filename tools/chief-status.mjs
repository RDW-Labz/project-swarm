#!/usr/bin/env node
// tools/chief-status.mjs: status view for `swarm orchestrator status` (T-0256, AC1).
// Lists every active project with its slot count and share of the machine cap.
// Input: a snapshot object { cap: number, projects: [{ name, active, slots }] }.
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export function slotShares(snapshot) {
  const cap = Number(snapshot?.cap);
  if (!Number.isInteger(cap) || cap < 1) {
    throw new TypeError('snapshot.cap must be a positive integer');
  }
  const projects = Array.isArray(snapshot.projects) ? snapshot.projects : [];
  const rows = projects
    .filter((p) => p && p.active === true)
    .map((p) => {
      const slots = Number(p.slots);
      if (!Number.isInteger(slots) || slots < 0) {
        throw new TypeError(`project ${String(p.name)}: slots must be a non-negative integer`);
      }
      return { name: String(p.name), slots, share: slots / cap };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
  return { cap, rows };
}

export function formatStatus(snapshot) {
  const { cap, rows } = slotShares(snapshot);
  if (rows.length === 0) {
    return `chief: 0 active projects (cap ${cap} slots)`;
  }
  const lines = [`chief: ${rows.length} active project(s), cap ${cap} slots`];
  for (const r of rows) {
    lines.push(`${r.name}\t${r.slots}/${cap}\t${(r.share * 100).toFixed(1)}%`);
  }
  return lines.join('\n');
}

function main(argv) {
  const path = argv[2];
  if (!path) {
    process.stderr.write('usage: chief-status.mjs <snapshot.json>\n');
    return 2;
  }
  const snapshot = JSON.parse(readFileSync(path, 'utf8'));
  process.stdout.write(formatStatus(snapshot) + '\n');
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv);
}
