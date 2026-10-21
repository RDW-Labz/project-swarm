import { isHumanJob } from '../human-jobs.mjs';
import { INTEGRATE_ONLY_PLACEHOLDER_RE, REPEAT_CONSTRUCT_RE } from './patterns.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';

const manifestChecksHaveRepeatConstruct = manifest => (manifest?.checks ?? []).some(check => REPEAT_CONSTRUCT_RE.test((check.argv ?? []).join(' ')));

function baseCheckSkipReason(check) {
  if (check.base === false) return 'base: false';
  const placeholder = check.argv.find(arg => INTEGRATE_ONLY_PLACEHOLDER_RE.test(arg));
  return placeholder ? `integrate-only placeholder ${placeholder}` : null;
}

// {integrated}/{integrated:.ext} and {new}/{new:.ext} must each be a whole argv item; a
// placeholder that expands to zero files means the check has nothing to act on, so it is
// skipped rather than run empty. {new} is the subset of integrated files that did not exist
// when the run started (the job's base hash recorded the file as absent).
// {root} may appear anywhere inside an item (e.g. "CARGO_TARGET_DIR={root}/target") and is
// replaced with the run's absolute project root, so parallel runs never share a build folder.
function expandCheckArgv(argv, integratedFiles, newFiles, root) {
  let empty = false;
  const expanded = [];
  for (const item of argv) {
    const integratedMatch = item === '{integrated}' ? '' : /^\{integrated:(\.[^}]+)\}$/.exec(item)?.[1];
    if (integratedMatch !== undefined) {
      const files = integratedMatch ? integratedFiles.filter(file => file.endsWith(integratedMatch)) : integratedFiles;
      if (!files.length) empty = true;
      expanded.push(...files);
      continue;
    }
    const newMatch = item === '{new}' ? '' : /^\{new:(\.[^}]+)\}$/.exec(item)?.[1];
    if (newMatch !== undefined) {
      const files = newMatch ? newFiles.filter(file => file.endsWith(newMatch)) : newFiles;
      if (!files.length) empty = true;
      expanded.push(...files);
      continue;
    }
    expanded.push(item.split('{root}').join(root));
  }
  return { argv: expanded, empty };
}

function expandRootArgv(argv, root) {
  return argv.map(item => item.split('{root}').join(root));
}

// The agents a manifest names that have a provider to check. `auto` is not one: it is resolved to a
// real lane (with its configured model) by validateProject, and doctor has no such provider. Before
// this, any manifest with an `auto` job, including every manifest `swarm go` plans, died here with
// "Unsupported API adapter".
export function agentsToCheck(manifest) {
  return [...new Set(manifest.jobs.filter(job => !isHumanJob(job)).map(job => job.agent))].filter(agent => agent !== 'auto');
}

function verbFromArgv(argv) {
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--root') { i += 1; continue; }
    if (argv[i].startsWith('-')) continue;
    return argv[i];
  }
  return null;
}

async function goChecks(root) {
  try { const value = JSON.parse(await fs.readFile(path.join(root, 'coordination/checks.json'), 'utf8')).checks ?? []; return Array.isArray(value) ? value : []; } catch { return []; }
}

export { baseCheckSkipReason, expandCheckArgv, expandRootArgv, goChecks, manifestChecksHaveRepeatConstruct, verbFromArgv };
