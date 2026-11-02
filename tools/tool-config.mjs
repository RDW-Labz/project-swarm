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
  } catch (error) { if (error?.code !== 'ENOENT' && error?.code !== 'EACCES' && error?.code !== 'ENOTDIR') console.error('[tools/tool-config.mjs] existsIn readdir:', error?.message ?? error); /* unreadable: treat as missing */ }
  return false;
};

// Lesson 39: a ticket that names an e2e spec in `tests` needs a project e2e command that will actually run that file.
// Only JavaScript or TypeScript specs are judged (playwright and cypress run those); a python or go e2e test has its own runner.
const E2E_SPEC = /(?:(^|\/)(e2e|playwright|cypress\/e2e)\/|\.e2e\.[cm]?[jt]sx?$)/i;
const JS_FILE = /\.[cm]?[jt]sx?$/i;
const PLAYWRIGHT_DEFAULT_MATCH = /\.(spec|test)\.[cm]?[jt]sx?$/i;
const CYPRESS_DEFAULT_MATCH = /\.cy\.[cm]?[jt]sx?$/i;
const dirOf = p => String(p).replace(/^\.\//, '').replace(/\/+$/, '');
const unquote = tok => String(tok).replace(/^['"`]+|['"`;]+$/g, '');

// The folders a command limits the run to: path arguments after `playwright test` or `cypress run --spec`, never other tokens of the script.
function commandScope(text) {
  const out = new Set();
  for (const part of String(text).split(/&&|\|\||;/)) {
    const m = /\b(?:playwright\s+test|cypress\s+run)\b(.*)$/.exec(part);
    if (!m) continue;
    const tokens = m[1].trim().split(/\s+/).map(unquote);
    for (let i = 0; i < tokens.length; i += 1) {
      const tok = tokens[i];
      if (tok === '--config' || tok === '-c' || tok === '--project' || tok === '--reporter' || tok === '--grep' || tok === '-g' || tok === '--browser' || tok === '--workers') { i += 1; continue; }
      if (tok === '--spec') { if (tokens[i + 1]) out.add(dirOf(tokens[i + 1]).replace(/\/[^/]*[*.][^/]*$/, '')); i += 1; continue; }
      if (!tok || tok.startsWith('-') || tok.includes('=') || /^https?:/.test(tok)) continue;
      if (tok.includes('/')) out.add(dirOf(tok).replace(/\/[^/]*\.[A-Za-z]+$/, ''));
    }
  }
  return out;
}

// scripts: package.json "scripts" (or scriptsFor(file) for the nearest package.json of a spec); configText: text of the playwright/cypress config files.
export function e2eSpecWarnings(tickets, { scripts = {}, scriptsFor = null, configText = '' } = {}) {
  const live = (tickets ?? []).filter(t => t.status !== 'cancelled' && t.status !== 'done' && t.type !== 'human');
  const specs = live.flatMap(t => (t.tests ?? []).filter(f => E2E_SPEC.test(f) && JS_FILE.test(f)).map(f => ({ id: t.id, file: f })));
  const warnings = [];
  for (const spec of specs) {
    const mine = scriptsFor ? scriptsFor(spec.file) : { scripts, configText };
    const own = mine.scripts ?? scripts, conf = String(mine.configText ?? configText ?? '');
    const commands = Object.entries(own).filter(([name, value]) => /e2e|playwright|cypress/i.test(name) || /\b(playwright|cypress)\b/i.test(String(value)));
    if (!commands.length) { warnings.push(`warning: ${spec.id} names the e2e spec ${spec.file}, but no package.json near it has an e2e command (a script that runs playwright or cypress): the spec would never run`); continue; }
    const text = commands.map(([, v]) => String(v)).join(' ; ');
    const hints = commandScope(text);
    for (const m of conf.matchAll(/testDir\s*:[^'"`\n]*['"`]([^'"`]+)['"`]/g)) hints.add(dirOf(m[1]));
    for (const m of conf.matchAll(/specPattern\s*:\s*\[?\s*['"`]([^'"`*]+)/g)) hints.add(dirOf(m[1]));
    const scoped = [...hints].filter(h => h && h !== '.' && h !== '..');
    if (scoped.length && !scoped.some(h => spec.file === h || spec.file.startsWith(`${h}/`) || spec.file.includes(`/${h}/`))) { warnings.push(`warning: ${spec.id} names the e2e spec ${spec.file}, but the e2e command only runs ${scoped.slice(0, 3).join(', ')}: it would never run`); continue; }
    if (/\bplaywright\b/i.test(text) && !/testMatch\s*:/.test(conf) && !PLAYWRIGHT_DEFAULT_MATCH.test(spec.file)) warnings.push(`warning: ${spec.id} names the e2e spec ${spec.file}, but playwright only runs files ending in .spec or .test (no testMatch in the config): rename it`);
    else if (/\bcypress\b/i.test(text) && !/specPattern\s*:/.test(conf) && !CYPRESS_DEFAULT_MATCH.test(spec.file)) warnings.push(`warning: ${spec.id} names the e2e spec ${spec.file}, but cypress only runs files ending in .cy (no specPattern in the config): rename it`);
  }
  return warnings;
}
