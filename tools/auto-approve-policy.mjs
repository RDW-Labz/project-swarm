// SPDX-License-Identifier: Apache-2.0
// Frozen in-code policy for hand-build auto-approve (file edits only; not writable by agents).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { orchestratorTestHarnessSigned } from './shell-writes.mjs';

export const POLICY_ID = 'swarm-admin-handbuild';
export const POLICY_VERSION = 3;
export const AUTO_OFF_FILE = '.swarm/handbuild/auto-off';
export const STATS_FILE = '.swarm/handbuild/stats.json';
export const STATS_INITIALIZED_FILE = '.swarm/handbuild/stats.initialized';
export const LOG_FILE = '.swarm/handbuild/log.ndjson';
export const DEFAULT_MAX_AUTO_APPROVE_WINDOWS_PER_DAY = 20;
export const POLICY_LIMIT_CEILING_WINDOWS_PER_DAY = 100;
export const MAX_POLICY_MINUTES = 60;
export const MAX_POLICY_FILES = 20;
export const DEFAULT_MAX_ACTIONS_PER_WINDOW = 20;
export const DEFAULT_MAX_ACTIONS_PER_DAY = 100;
export const DEFAULT_MAX_FILES_PER_DAY = 100;
export const POLICY_LIMIT_CEILING_ACTIONS_PER_WINDOW = 100;
export const POLICY_LIMIT_CEILING_ACTIONS_PER_DAY = 500;
export const POLICY_LIMIT_CEILING_FILES_PER_DAY = 500;
export const POLICY_STATS_UNREADABLE = '__policyStatsUnreadable';

/** Case-insensitive path comparison (NFKC + upper + lower). */
export function fold(s) {
  return String(s ?? '').normalize('NFKC').toUpperCase().toLowerCase();
}

const ASCII_PATH_COMPONENT = /^[A-Za-z0-9._-]+$/;

const ALLOWED_EXT = new Set(['.md', '.txt', '.csv']);

/** Basenames swarm tools read as authoritative state (see docs/auto-approve.md); never policy-window targets. */
export const DOCS_STATE_READER_DENIED_BASENAMES = new Set(
  ['usage-ledger.md', 'eval-scores.ndjson'].map(fold),
);

const INSTRUCTION_BASENAMES = new Set(
  ['claude.md', 'agents.md', 'gemini.md', 'readme.md', 'skill.md', 'claude.local.md'].map(fold),
);

/** Swarm tools read these as authoritative; they are never policy-window targets. */
const AUTHORITATIVE_STATE_EXACT = new Set(
  ['docs/state/usage-ledger.md', 'docs/state/eval-scores.ndjson'].map(p => fold(p)),
);
const AUTHORITATIVE_STATE_PREFIX = fold('docs/state/manager-scorecards/');

const BLOCKED_PREFIXES = [
  'tools/',
  'tests/',
  '.github/',
  '.swarm/',
  '.git/',
  'coordination/review/',
  'coordination/manifests/',
  'jobs/',
];

const norm = p => String(p).replace(/\\/g, '/');

function pathHasDotDot(p) {
  return norm(p).split('/').includes('..');
}

function fileExtension(lowerPath) {
  const base = lowerPath.slice(lowerPath.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return '';
  return base.slice(dot);
}

function pathHasDotFolderComponent(lower) {
  return norm(lower).split('/').some(seg => seg.startsWith('.') && seg !== '.');
}

function instructionBasenameBlocked(foldedPath) {
  const base = foldedPath.slice(foldedPath.lastIndexOf('/') + 1);
  if (!ASCII_PATH_COMPONENT.test(base)) return true;
  if (INSTRUCTION_BASENAMES.has(fold(base))) return true;
  const fb = fold(base);
  return fb.endsWith('.instructions.md') || fb.endsWith('.rules.md') || fb.endsWith('.local.md');
}

function docsStateComponentsAsciiRaw(rawPath) {
  const parts = norm(rawPath).split('/');
  if (parts[0] !== 'docs' || parts[1] !== 'state') return false;
  for (let i = 2; i < parts.length; i += 1) {
    if (!ASCII_PATH_COMPONENT.test(parts[i])) return false;
  }
  return true;
}

function docsStateComponentsAscii(foldedPath) {
  return docsStateComponentsAsciiRaw(foldedPath);
}

function authoritativeStatePath(foldedPath) {
  const p = norm(foldedPath);
  if (AUTHORITATIVE_STATE_EXACT.has(p)) return true;
  return p.startsWith(AUTHORITATIVE_STATE_PREFIX);
}

function readerDeniedBasename(rawPath) {
  const base = norm(rawPath).slice(norm(rawPath).lastIndexOf('/') + 1);
  return DOCS_STATE_READER_DENIED_BASENAMES.has(fold(base));
}

function folderAllowedRaw(rawPath) {
  const raw = norm(rawPath);
  if (!docsStateComponentsAsciiRaw(raw)) return false;
  const lower = fold(raw);
  if (lower === fold('.project-swarm.json')) return false;
  if (BLOCKED_PREFIXES.some(p => {
    const fp = fold(p);
    return lower === fp.slice(0, -1) || lower.startsWith(fp);
  })) return false;
  if (pathHasDotFolderComponent(raw) || instructionBasenameBlocked(lower)) return false;
  if (!lower.startsWith(fold('docs/state/'))) return false;
  if (readerDeniedBasename(raw)) return false;
  if (authoritativeStatePath(lower)) return false;
  return true;
}

function folderAllowed(foldedPath) {
  return folderAllowedRaw(foldedPath);
}

export function policyFolderAllowed(rel) {
  return folderAllowedRaw(norm(rel));
}

export function fsIsCaseInsensitive(root) {
  const fallback = process.platform === 'darwin' || process.platform === 'win32';
  try {
    const real = fs.realpathSync.native(root);
    const parts = real.split(path.sep);
    for (let i = parts.length - 1; i > 0; i -= 1) {
      const swapped = parts[i].replace(/[A-Za-z]/g, c => (c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase()));
      if (swapped === parts[i]) continue;
      const alt = [...parts.slice(0, i), swapped, ...parts.slice(i + 1)].join(path.sep);
      try {
        return fs.statSync(alt).ino === fs.statSync(real).ino;
      } catch {
        return false;
      }
    }
  } catch { /* fall through */ }
  return fallback;
}

export function canonicalPolicyRel(root, rel) {
  const raw = norm(rel ?? '');
  if (!raw) return null;
  const abs = path.resolve(root, raw);
  const back = path.relative(path.resolve(root), abs);
  if (!back || back.startsWith('..') || path.isAbsolute(back)) return null;
  const out = norm(back);
  return fsIsCaseInsensitive(root) ? fold(out) : out;
}

function extensionAllowed(foldedPath) {
  return ALLOWED_EXT.has(fileExtension(foldedPath));
}

export function isPolicyWindowFileEntry(rel) {
  if (typeof rel !== 'string' || !rel) return false;
  const raw = norm(rel);
  if (path.isAbsolute(raw) || pathHasDotDot(raw) || /[*?[{]/.test(raw)) return false;
  if (raw.endsWith('/') || !raw.includes('/')) return false;
  if (!docsStateComponentsAsciiRaw(raw)) return false;
  const folded = fold(raw);
  if (!extensionAllowed(folded)) return false;
  return folderAllowedRaw(raw);
}

export function policyWindowParentDirSafe(root, rel) {
  const p = norm(rel);
  if (!p.includes('/')) return false;
  const parent = p.slice(0, p.lastIndexOf('/'));
  if (!parent || parent === '.') return true;
  const parts = parent.split('/');
  let prefix = '';
  for (let n = 0; n < parts.length; n += 1) {
    prefix = n === 0 ? parts[0] : `${prefix}/${parts[n]}`;
    const abs = path.join(root, prefix);
    let lst;
    try {
      lst = fs.lstatSync(abs);
    } catch {
      if (n === parts.length - 1) return true;
      return false;
    }
    if (lst.isSymbolicLink()) return false;
    if ((lst.mode & 0o002) || (lst.mode & 0o020)) return false;
    if (n < parts.length - 1 && !lst.isDirectory()) return false;
  }
  return true;
}

export function isSwarmAdminHandbuildPath(rel, { root } = {}) {
  if (typeof rel !== 'string' || !rel) return false;
  const raw = norm(rel);
  if (path.isAbsolute(raw) || pathHasDotDot(raw) || /[*?[{]/.test(raw)) return false;
  if (raw.endsWith('/')) return false;
  if (!docsStateComponentsAsciiRaw(raw)) return false;
  const folded = fold(raw);
  if (!extensionAllowed(folded) || !folderAllowedRaw(raw)) return false;
  if (!root) return true;
  if (!policyWindowParentDirSafe(root, raw)) return false;
  return policyPathLstatSafe(root, raw) !== null;
}

function openedPlainFile(abs) {
  let fd;
  try {
    fd = fs.openSync(abs, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0));
    const st = fs.fstatSync(fd);
    return st.isFile() && st.nlink === 1;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* closed */ } }
  }
}

function policyPathLstatSafe(root, rel) {
  const p = norm(rel);
  if (!p || path.isAbsolute(p) || pathHasDotDot(p)) return null;
  try {
    const rootReal = fs.realpathSync.native(root);
    const parts = p.split('/');
    let prefix = '';
    for (let n = 0; n < parts.length; n += 1) {
      prefix = n === 0 ? parts[0] : `${prefix}/${parts[n]}`;
      const abs = path.join(root, prefix);
      let lst;
      try {
        lst = fs.lstatSync(abs);
      } catch {
        if (n === parts.length - 1) return prefix;
        return null;
      }
      if (lst.isSymbolicLink()) return null;
      if (n < parts.length - 1 && !lst.isDirectory()) return null;
    }
    const absFinal = path.join(root, p);
    let finalLst;
    try {
      finalLst = fs.lstatSync(absFinal);
    } catch {
      return p;
    }
    if (finalLst.isSymbolicLink()) return null;
    if (!finalLst.isFile() || finalLst.nlink > 1) return null;
    if (!openedPlainFile(absFinal)) return null;
    const real = fs.realpathSync.native(absFinal);
    const relToRoot = path.relative(rootReal, real);
    if (!relToRoot || relToRoot.startsWith('..') || path.isAbsolute(relToRoot)) return null;
    const canonical = norm(relToRoot);
    if (!docsStateComponentsAsciiRaw(canonical) || !docsStateComponentsAsciiRaw(p)) return null;
    const foldedCanon = fold(canonical);
    if (!extensionAllowed(foldedCanon) || !folderAllowedRaw(canonical)) return null;
    if (canonical !== p) return null;
    return canonical;
  } catch {
    return null;
  }
}

export function machinePolicyJsonPath({ home = os.homedir(), root = null } = {}) {
  if (root && orchestratorTestHarnessSigned(root)) {
    const envPath = process.env.SWARM_POLICY_FILE;
    if (envPath && path.isAbsolute(envPath)) return envPath;
    if (process.env.SWARM_CONFIG) return path.join(path.dirname(process.env.SWARM_CONFIG), 'policy.json');
  }
  return path.join(home, '.config', 'project-swarm', 'policy.json');
}

/** Machine policy path only (no project-root policy.json lookup). */
export function mergeStandingPolicyJsonPath(opts) {
  return machinePolicyJsonPath(opts);
}

export function policyFilePath(home = os.homedir(), { root = null } = {}) {
  if (root && orchestratorTestHarnessSigned(root) && process.env.SWARM_CONFIG) {
    return path.join(path.dirname(process.env.SWARM_CONFIG), 'policy.json');
  }
  return path.join(home, '.config', 'project-swarm', 'policy.json');
}

export function policyRateLimits(home = os.homedir(), { root = null } = {}) {
  const defaults = {
    maxActionsPerWindow: DEFAULT_MAX_ACTIONS_PER_WINDOW,
    maxActionsPerDay: DEFAULT_MAX_ACTIONS_PER_DAY,
    maxFilesPerDay: DEFAULT_MAX_FILES_PER_DAY,
    maxAutoApproveWindowsPerDay: DEFAULT_MAX_AUTO_APPROVE_WINDOWS_PER_DAY,
  };
  try {
    const file = policyFilePath(home, { root });
    if (!file) return defaults;
    const policy = JSON.parse(fs.readFileSync(file, 'utf8'));
    const rules = Array.isArray(policy?.rules) ? policy.rules : [];
    const row = rules.find(r => r?.id === POLICY_ID && r.enabled !== false && r.disabled !== true);
    if (!row) return defaults;
    const lim = row?.limits && typeof row.limits === 'object' ? row.limits : {};
    const n = (k, d) => {
      const v = Number(lim[k]);
      return Number.isInteger(v) && v > 0 ? v : d;
    };
    const cap = (v, max) => Math.min(v, max);
    return {
      maxActionsPerWindow: cap(n('maxActionsPerWindow', defaults.maxActionsPerWindow), POLICY_LIMIT_CEILING_ACTIONS_PER_WINDOW),
      maxActionsPerDay: cap(n('maxActionsPerDay', defaults.maxActionsPerDay), POLICY_LIMIT_CEILING_ACTIONS_PER_DAY),
      maxFilesPerDay: cap(n('maxFilesPerDay', defaults.maxFilesPerDay), POLICY_LIMIT_CEILING_FILES_PER_DAY),
      maxAutoApproveWindowsPerDay: cap(n('maxAutoApproveWindowsPerDay', defaults.maxAutoApproveWindowsPerDay), POLICY_LIMIT_CEILING_WINDOWS_PER_DAY),
    };
  } catch {
    return defaults;
  }
}

export function evaluateHandbuildAutoApprove(root, { files, minutes, git }) {
  if (root && fs.existsSync(path.join(root, AUTO_OFF_FILE))) {
    return { ok: false, reason: 'kill-switch' };
  }
  const gitOps = Array.isArray(git) ? git : String(git ?? '').split(',');
  if (gitOps.some(g => String(g).trim())) return { ok: false, reason: 'git' };
  const list = Array.isArray(files) ? files : [];
  if (!list.length || list.length > MAX_POLICY_FILES) return { ok: false, reason: 'files' };
  const mins = Number(minutes);
  if (!Number.isInteger(mins) || mins < 1 || mins > MAX_POLICY_MINUTES) return { ok: false, reason: 'minutes' };
  if (!list.every(f => isPolicyWindowFileEntry(f) && isSwarmAdminHandbuildPath(f, { root }))) {
    return { ok: false, reason: 'path' };
  }
  return {
    ok: true,
    policyId: POLICY_ID,
    policyVersion: POLICY_VERSION,
    minutes: mins,
    files: list.map(f => norm(f)),
  };
}

export function autoApproveKillSwitchOn(root) {
  try {
    return fs.existsSync(path.join(root, AUTO_OFF_FILE));
  } catch {
    return true;
  }
}
