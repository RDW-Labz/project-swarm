// SPDX-License-Identifier: Apache-2.0
// Lesson 16: an acceptance check that runs a tool needs the tool's config file. A ticket must write it, or the project must have it already.
import { existsSync } from 'node:fs';
import path from 'node:path';

export const TOOL_CONFIGS = [
  { tool: 'supabase', mention: /\bsupabase\b/i, config: 'supabase/config.toml', has: /^supabase\/config\.toml$/ },
  { tool: 'playwright', mention: /\bplaywright\b/i, config: 'playwright.config.ts', has: /(^|\/)playwright\.config\.[cm]?[jt]s$/ },
  { tool: 'vitest', mention: /\bvitest\b/i, config: 'vitest.config.ts', has: /(^|\/)(vitest|vite)\.config\.[cm]?[jt]s$/ },
  { tool: 'jest', mention: /\bjest\b/i, config: 'jest.config.js', has: /(^|\/)jest\.config\.[cm]?[jt]s$|(^|\/)package\.json$/ },
  { tool: 'cypress', mention: /\bcypress\b/i, config: 'cypress.config.ts', has: /(^|\/)cypress\.config\.[cm]?[jt]s$/ },
  { tool: 'prisma', mention: /\bprisma\b/i, config: 'prisma/schema.prisma', has: /(^|\/)schema\.prisma$/ },
  { tool: 'drizzle', mention: /\bdrizzle(?:-kit)?\b/i, config: 'drizzle.config.ts', has: /(^|\/)drizzle\.config\.[cm]?[jt]s$/ },
  { tool: 'eslint', mention: /\beslint\b/i, config: 'eslint.config.mjs', has: /(^|\/)(eslint\.config\.[cm]?[jt]s|\.eslintrc[\w.]*)$|(^|\/)package\.json$/ },
];

// The tickets whose acceptance runs a tool that no ticket and no project file configures. Done and cancelled tickets are not looked at.
export function missingToolConfigs(tickets, projectFiles = [], exists = () => false) {
  const live = (tickets ?? []).filter(t => t.status !== 'cancelled' && t.status !== 'done' && t.type !== 'human');
  const written = live.flatMap(t => t.files ?? []);
  const gaps = [];
  for (const spec of TOOL_CONFIGS) {
    if (written.some(f => spec.has.test(f)) || projectFiles.some(f => spec.has.test(f)) || exists(spec.config)) continue;
    const who = live.filter(t => (t.acceptance ?? []).some(a => spec.mention.test(a)));
    if (who.length) gaps.push({ tool: spec.tool, config: spec.config, tickets: who.map(t => t.id) });
  }
  return gaps;
}

export const toolConfigLines = gaps => gaps.map(g => `warning: ${g.tickets.slice(0, 5).join(', ')} run ${g.tool} in their acceptance, but no ticket writes ${g.config} and the project has none: add a ticket for it`);

export async function projectFileList(root, execFile) {
  try { const { stdout } = await execFile('git', ['-C', root, 'ls-files'], { maxBuffer: 16 * 1024 * 1024 }); return stdout.split('\n').filter(Boolean); } catch { return []; }
}

export const existsIn = root => file => existsSync(path.join(root, file));
