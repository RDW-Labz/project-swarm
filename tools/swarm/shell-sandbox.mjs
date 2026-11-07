import { SHELL_SANDBOX_DENIED_PATH_RE } from './patterns.mjs';
import os from 'node:os';

function normalizeShellSandboxMatch(raw, home) {
  if (raw.startsWith('$HOME')) return home + raw.slice('$HOME'.length);
  if (raw.startsWith('~/')) return home + raw.slice(1);
  return raw;
}

function isGrantedShellPath(absPath, grantedPrefixes) {
  return grantedPrefixes.some(prefix => absPath === prefix || absPath.startsWith(`${prefix}/`));
}

// Every denied (non-granted) occurrence in `text`, in order — empty when every match is granted or
// there was no match at all.
export function shellSandboxDeniedMatches(text, { grantedPrefixes = [], home = os.homedir() } = {}) {
  const denied = [];
  for (const match of String(text ?? '').matchAll(new RegExp(SHELL_SANDBOX_DENIED_PATH_RE.source, 'g'))) {
    if (!isGrantedShellPath(normalizeShellSandboxMatch(match[0], home), grantedPrefixes)) denied.push(match[0]);
  }
  return denied;
}

export function shellSandboxDeniesArgv(argv, options) {
  return shellSandboxDeniedMatches((argv ?? []).join(' '), options).length > 0;
}

const sandboxCannotRunCheckResult = smoke => ({ status: 'failed', sandboxCannotRunCheck: smoke, refusedBeforeStart: true, error: `sandbox-cannot-run-check: ${smoke.argv0}`, stdout: '', stderr: '', response: '', exitCode: null, actualModel: null, modelsSeen: [], modelMismatch: false, usage: null, modelUsage: null, costUsd: null, cleanupError: null, terminationReason: null, permissionDenials: [] });

export { isGrantedShellPath, normalizeShellSandboxMatch, sandboxCannotRunCheckResult };
