// SPDX-License-Identifier: Apache-2.0
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const MAX_TAIL = 2000;

function pathText(value) {
  if (typeof value === 'string') return value.replace(/^\.\//, '').replaceAll('\\', '/');
  if (value && typeof value.path === 'string') return pathText(value.path);
  return null;
}

function uniquePaths(values) {
  return [...new Set((values ?? []).map(pathText).filter(Boolean))].sort();
}

function splitCommand(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  return [...value.matchAll(/"([^"\\]*(?:\\.[^"\\]*)*)"|'([^']*)'|(\S+)/g)].map(match => match[1] ?? match[2] ?? match[3]);
}

function checkArgv(reportedCheck) {
  const record = Array.isArray(reportedCheck) ? reportedCheck[0] : reportedCheck?.checksRun?.[0] ?? reportedCheck;
  const value = record?.argv ?? record?.commandArgv ?? record?.checkCommand ?? record?.command;
  if (Array.isArray(value) && value.length && value.every(item => typeof item === 'string' && item)) return [...value];
  return splitCommand(value);
}

function checkStatus(value) {
  if (value === true) return 'passed';
  if (value === false || value == null) return null;
  if (value.passed === true) return 'passed';
  if (value.passed === false) return 'failed';
  const status = typeof value === 'string' ? value : value.status;
  if (['passed', 'pass', 'success', 'green', 'ok'].includes(String(status).toLowerCase())) return 'passed';
  if (['failed', 'fail', 'red', 'error', 'timeout', 'spawn-error'].includes(String(status).toLowerCase())) return 'failed';
  if (typeof value?.exitCode === 'number') return value.exitCode === 0 ? 'passed' : 'failed';
  return null;
}

function resultTail(result) {
  return String(result?.tail ?? result?.stderr ?? result?.stdout ?? '').slice(-MAX_TAIL);
}

export function normalizeReportedCheck(reportedCheck) {
  const record = Array.isArray(reportedCheck) ? reportedCheck[0] : reportedCheck?.checksRun?.[0] ?? reportedCheck;
  const argv = checkArgv(record);
  const status = checkStatus(record?.status ?? record);
  return argv && status ? { argv, status } : null;
}

export async function rerunReportedCheck(root, reportedCheck, { exec = execFileAsync } = {}) {
  const normalized = normalizeReportedCheck(reportedCheck);
  if (!normalized) return { status: 'blocked', code: 'reported-check-missing', reason: 'reported-check-missing: a completed job must report argv and pass/fail status' };
  try {
    const result = await exec(normalized.argv[0], normalized.argv.slice(1), { cwd: root, encoding: 'utf8' });
    return { status: result?.code === undefined || result.code === 0 ? 'passed' : 'failed', exitCode: result?.code ?? 0, tail: resultTail(result), argv: normalized.argv };
  } catch (error) {
    return { status: 'failed', exitCode: typeof error.code === 'number' ? error.code : 1, tail: resultTail(error) || error.message, argv: normalized.argv };
  }
}

function mismatchReason(argv, reported, rerun) {
  const command = argv.join(' ');
  const evidence = resultTail(rerun);
  return `integrated-check-mismatch: ${command}: worker reported ${reported}, integrated tree rerun ${rerun.status}${evidence ? ` (${evidence})` : ''}`;
}

/**
 * Audit a worker workspace before accepting its files into the integrated tree.
 * This function never writes or removes files: dropped-write evidence stays visible until an
 * explicit acceptance or salvage decision is made by the caller.
 */
export async function auditIntegratedTree({
  root,
  declaredOutputs = [],
  workspaceEdits,
  listWorkspaceEdits,
  reportedCheck,
  runCheck,
  acceptUndeclared = false,
  accept = false,
  salvageUndeclared = false,
  salvage = false,
} = {}) {
  const declared = new Set(uniquePaths(declaredOutputs));
  const edits = uniquePaths(workspaceEdits ?? await listWorkspaceEdits?.() ?? []);
  const undeclaredEdits = edits.filter(file => !declared.has(file));
  const explicitlyAccepted = acceptUndeclared || accept;
  const explicitlySalvaged = salvageUndeclared || salvage;
  if (undeclaredEdits.length && !explicitlyAccepted && !explicitlySalvaged) {
    return {
      status: 'blocked',
      code: 'undeclared-edit',
      undeclaredEdits,
      droppedWrites: undeclaredEdits,
      reason: `undeclared-edit: workspace changed outside declared outputs: ${undeclaredEdits.join(', ')}; pass --accept-undeclared to leave them out explicitly or --salvage-undeclared to apply saved evidence`,
    };
  }

  const normalized = normalizeReportedCheck(reportedCheck);
  if (!normalized) return { status: 'blocked', code: 'reported-check-missing', undeclaredEdits, droppedWrites: undeclaredEdits, reason: 'reported-check-missing: a completed job must report argv and pass/fail status' };
  let rerun;
  try {
    if (runCheck) rerun = await runCheck(normalized.argv, { cwd: root });
    else rerun = await rerunReportedCheck(root, normalized);
  } catch (error) {
    rerun = { status: 'failed', exitCode: typeof error.code === 'number' ? error.code : 1, tail: error.message, argv: normalized.argv };
  }
  const rerunStatus = checkStatus(rerun);
  if (!rerunStatus || rerunStatus !== normalized.status) {
    return {
      status: 'refused',
      code: 'integrated-check-mismatch',
      undeclaredEdits,
      droppedWrites: undeclaredEdits,
      reportedCheck: { argv: normalized.argv, status: normalized.status },
      rerun: { ...rerun, status: rerunStatus ?? 'unknown' },
      reason: mismatchReason(normalized.argv, normalized.status, { ...rerun, status: rerunStatus ?? 'unknown' }),
    };
  }

  return {
    status: explicitlySalvaged ? 'salvage-required' : explicitlyAccepted && undeclaredEdits.length ? 'accepted' : 'ok',
    code: explicitlySalvaged && undeclaredEdits.length ? 'undeclared-edit-salvage' : undefined,
    undeclaredEdits,
    droppedWrites: undeclaredEdits,
    ...(explicitlyAccepted && undeclaredEdits.length ? { acceptedUndeclaredEdits: undeclaredEdits } : {}),
    ...(explicitlySalvaged && undeclaredEdits.length ? { salvageUndeclaredEdits: undeclaredEdits } : {}),
    check: { argv: normalized.argv, reported: normalized.status, rerun: rerunStatus },
  };
}

export const integratedTreeAudit = auditIntegratedTree;
