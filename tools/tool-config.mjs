// SPDX-License-Identifier: Apache-2.0
// Lesson 16: an acceptance check that runs a tool's command needs the tool's config file. A ticket must write it, or the project must have it already.
// Only tools that cannot run without their config are listed (vitest, jest, playwright and eslint have defaults or other config places: no warning).
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';

export const TOOL_CONFIGS = [
  { tool: 'supabase', mention: /\bsupabase\s+(?:test|db|start|stop|migration|functions|gen|link|status)\b/i, config: 'supabase/config.toml', has: /(^|\/)supabase\/config\.toml$/ },
  { tool: 'cypress', mention: /\bcypress\s+(?:run|open)\b/i, config: 'cypress.config.ts', has: /(^|\/)cypress\.config\.[cm]?[jt]s$/ },
  { tool: 'prisma', mention: /\bprisma\s+(?:migrate|generate|db|studio|validate)\b/i, config: 'prisma/schema.prisma', has: /\.prisma$/ },
  { tool: 'drizzle-kit', mention: /\bdrizzle-kit\b/i, config: 'drizzle.config.ts', has: /(^|\/)drizzle\.config\.[cm]?[jt]s$/ },
];

// The tickets whose acceptance runs a tool that no ticket and no project file configures. Done and cancelled tickets are not looked at.
// `exists(spec)` answers for files the project has on disk (also when it is not a git repo).
export function missingToolConfigs(tickets, projectFiles = [], exists = () => false) {
  const live = (tickets ?? []).filter(t => t.status !== 'cancelled' && t.status !== 'done' && t.type !== 'human');
  const written = live.flatMap(t => t.files ?? []);
  const gaps = [];
  for (const spec of TOOL_CONFIGS) {
    if (written.some(f => spec.has.test(f)) || projectFiles.some(f => spec.has.test(f)) || exists(spec)) continue;
    const who = live.filter(t => (t.acceptance ?? []).some(a => spec.mention.test(a)));
    if (who.length) gaps.push({ tool: spec.tool, config: spec.config, tickets: who.map(t => t.id) });
  }
  return gaps;
}

export const toolConfigLines = gaps => gaps.map(g => `warning: ${g.tickets.slice(0, 5).join(', ')} run ${g.tool} in their acceptance, but no ticket writes ${g.config} and the project has none: add a ticket for it`);

export async function projectFileList(root, execFile) {
  try { const { stdout } = await execFile('git', ['-C', root, 'ls-files'], { maxBuffer: 16 * 1024 * 1024 }); return stdout.split('\n').filter(Boolean); } catch { return []; }
}

// A shallow look at the disk (the root and its folders one level down), for a project that is not a git repo or has an uncommitted config.
export const existsIn = root => spec => {
  if (existsSync(path.join(root, spec.config))) return true;
  try {
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (entry.isFile() && spec.has.test(entry.name)) return true;
      if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules') {
        for (const inner of readdirSync(path.join(root, entry.name), { withFileTypes: true })) if (spec.has.test(`${entry.name}/${inner.name}`) || (inner.isFile() && spec.has.test(inner.name))) return true;
      }
    }
  } catch { /* unreadable: treat as missing */ }
  return false;
};
